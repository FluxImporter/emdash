import { EmDashUploads, stageUpload, type UploadStorage } from "../emdash/uploads.js";
import { JobError } from "../engine/jobs.js";
import { SourceMissingError, type SourcePort } from "../engine/ports.js";
import { sourceSchema } from "../engine/template.js";
import type { EngineDeps, Job } from "../engine/types.js";
import type { FetchLimits } from "../sources/fetcher.js";
import { parseJsonRecord } from "../sources/json.js";
import { chunksOf, SourceError, type TemplateSource, type ValueSample } from "../sources/reader.js";
import { checkSource } from "../sources/readers.js";
import { openXlsx, type XlsxSheet } from "../sources/xlsx.js";
import { XlsxError } from "../sources/zip.js";
import {
	type FieldLookup,
	type LocaleResolver,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	sampleSource,
	startJob,
	type TranslationLocaleResolver,
} from "./service.js";

/** On Workers the converted JSON Lines are held in memory to give R2 their length. */
export const XLSX_WORKERS_BUFFER = 32 * 1024 * 1024;
/** Converted lines are encoded and counted in pieces of about this many characters. */
const PIECE = 64 * 1024;

export interface XlsxLimits {
	/** The workbook file limit (`maxXlsxBytes`). */
	maxXlsxBytes: number;
	/** The converted JSON Lines limit (`maxSourceBytes`). */
	maxSourceBytes: number;
	/** Whether the code runs on Workers, where the converted lines are buffered. */
	workers: boolean;
	/** The Workers buffer for converted lines (`XLSX_WORKERS_BUFFER`). */
	bufferBytes: number;
}

/** Staging for converted sheets: where they go and how large they may be. */
export interface XlsxStaging extends XlsxLimits {
	storage: UploadStorage;
}

/**
 * The template's source block when it is a valid XLSX block, else null (a template that is
 * invalid, or reads another format, goes to `startJob` as it is, which reports any problem).
 */
export function xlsxSource(template: unknown): TemplateSource | null {
	if (typeof template !== "object" || template === null || !("source" in template)) return null;
	const parsed = sourceSchema.safeParse(template.source);
	if (!parsed.success || parsed.data.format !== "xlsx") return null;
	return checkSource(parsed.data).length === 0 ? parsed.data : null;
}

/** The fetch limits for a URL source job: an XLSX template may fetch at most `maxXlsxBytes`. */
export function fetchLimitsFor(template: unknown, limits: FetchLimits, maxXlsxBytes: number) {
	if (xlsxSource(template) === null) return limits;
	return { ...limits, maxBytes: Math.min(limits.maxBytes, maxXlsxBytes) };
}

/** Reads a staged workbook into memory; one over `maxBytes` is `TOO_LARGE`. */
export async function readWorkbookFile(
	source: SourcePort,
	uploadId: string,
	maxBytes: number,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of chunksOf(await source.open(uploadId, 0))) {
		size += chunk.length;
		if (size > maxBytes) {
			throw new ServiceError("TOO_LARGE", `XLSX files are limited to ${maxBytes} bytes`, 413);
		}
		parts.push(chunk);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** A conversion problem, from the workbook or its XML, as `invalid_source`. */
function asJobError(e: unknown): unknown {
	if (e instanceof XlsxError || e instanceof SourceError) {
		return new JobError("invalid_source", e.message);
	}
	if (e instanceof SourceMissingError) {
		return new JobError("invalid_source", e.message, [], undefined, { cause: e });
	}
	return e;
}

async function openSheet(
	deps: Pick<EngineDeps, "source">,
	limits: XlsxLimits,
	uploadId: string,
	source: TemplateSource,
): Promise<XlsxSheet> {
	const bytes = await readWorkbookFile(deps.source, uploadId, limits.maxXlsxBytes);
	return openXlsx(bytes, { sheet: source.sheet, headerRow: source.headerRow });
}

export interface ConvertedSheet {
	uploadId: string;
	columns: string[];
	warnings: string[];
	/** M5c: rows skipped with only unreadable cells, which the job counts as unkeyed. */
	skippedRows: number;
}

/**
 * Converts the template's sheet of a staged workbook to JSON Lines and stages them as a new
 * upload. The lines are held in memory (at most `maxSourceBytes`; on Workers at most 32 MiB,
 * because R2 needs the length up front) and staged with their length.
 */
export async function convertXlsx(
	deps: Pick<EngineDeps, "source">,
	staging: XlsxStaging,
	uploadId: string,
	source: TemplateSource,
): Promise<ConvertedSheet> {
	const limit = staging.workers
		? Math.min(staging.maxSourceBytes, staging.bufferBytes)
		: staging.maxSourceBytes;
	const encoder = new TextEncoder();
	const pieces: Uint8Array[] = [];
	let size = 0;
	let pending = "";
	const flush = () => {
		const bytes = encoder.encode(pending);
		pending = "";
		size += bytes.length;
		if (size > limit) {
			const workers = staging.workers && limit < staging.maxSourceBytes;
			throw new ServiceError(
				"TOO_LARGE",
				workers
					? `The sheet converts to more than ${limit} bytes of JSON Lines, too large to convert on Workers`
					: `The converted sheet exceeds the limit of ${limit} bytes`,
				413,
			);
		}
		pieces.push(bytes);
	};
	let sheet: XlsxSheet;
	try {
		sheet = await openSheet(deps, staging, uploadId, source);
		for await (const line of sheet.lines) {
			pending += `${line}\n`;
			if (pending.length >= PIECE) flush();
		}
	} catch (e) {
		throw asJobError(e);
	}
	if (pending !== "") flush();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const piece = pieces[i++];
			if (piece) controller.enqueue(piece);
			else controller.close();
		},
	});
	const staged = await stageUpload(staging.storage, body, limit, size);
	return {
		uploadId: staged.uploadId,
		columns: sheet.columns,
		warnings: sheet.warnings(),
		skippedRows: sheet.skipped(),
	};
}

/**
 * `startJob`, converting an XLSX template's sheet first: the job reads the converted copy
 * (`uploadId`) and records the workbook as `sourceUploadId`. The copy is deleted again if the
 * job cannot be created.
 */
export async function startImport(
	deps: EngineDeps,
	staging: XlsxStaging,
	input: StartJobInput,
	lookupFields: FieldLookup,
	resolveLocale?: LocaleResolver,
	resolveTranslation?: TranslationLocaleResolver,
): Promise<Job> {
	const source = xlsxSource(input.template);
	if (source === null) {
		return startJob(deps, input, lookupFields, resolveLocale, resolveTranslation);
	}
	const converted = await convertXlsx(deps, staging, input.uploadId, source);
	try {
		return await startJob(
			deps,
			{
				...input,
				uploadId: converted.uploadId,
				sourceUploadId: input.uploadId,
				columns: converted.columns,
				warnings: converted.warnings,
				...(converted.skippedRows > 0 ? { skippedRows: converted.skippedRows } : {}),
			},
			lookupFields,
			resolveLocale,
			resolveTranslation,
		);
	} catch (e) {
		await new EmDashUploads(staging.storage).delete(converted.uploadId).catch(() => {});
		throw e;
	}
}

/**
 * `sampleSource`, converting an XLSX sheet only until the sample is full: `{ records, paths }`
 * with the header names as paths.
 */
export async function sampleImport(
	deps: EngineDeps,
	limits: XlsxLimits,
	uploadId: string,
	n: number,
	source?: TemplateSource,
): Promise<Awaited<ReturnType<typeof sampleSource>>> {
	if (source?.format !== "xlsx") return sampleSource(deps, uploadId, n, source);
	const problems = checkSource(source);
	if (problems.length > 0) throw new ServiceError("INVALID_SOURCE", problems.join("; "), 400);
	const count = Math.min(n, SAMPLE_MAX);
	const encoder = new TextEncoder();
	try {
		const sheet = await openSheet(deps, limits, uploadId, source);
		const records: unknown[] = [];
		for await (const line of sheet.lines) {
			records.push(parseJsonRecord(encoder.encode(line)).value);
			if (records.length >= count) break;
		}
		return { records, paths: sheet.columns } satisfies ValueSample;
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof XlsxError || e instanceof SourceError) {
			throw new ServiceError("INVALID_SOURCE", e.message, 400);
		}
		throw e;
	}
}
