import { runBatch } from "../engine/batch.js";
import { type CreateJobInput, createJob, JobError, transitionJob } from "../engine/jobs.js";
import { buildLogCsv } from "../engine/log.js";
import { SourceMissingError } from "../engine/ports.js";
import type { SchemaField } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";

export const PAGE_SIZE = 50;
export const SAMPLE_MAX = 20;
/** Raw plugin responses are capped at 8 MiB (`PLUGIN_ROUTE_MAX_BODY_BYTES`, @emdash-cms/plugin-types). */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;

/** A failure the route layer turns into an HTTP error with this code and status. */
export class ServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ServiceError";
	}
}

/** Deletes staged source files; `EmDashUploads` implements it. */
export interface UploadStore {
	delete(uploadId: string): Promise<void>;
}

export interface Page<T> {
	items: T[];
	cursor?: string;
	hasMore: boolean;
}

function page<T>(result: { items: { data: T }[]; cursor?: string; hasMore: boolean }): Page<T> {
	const items = result.items.map((i) => i.data);
	return result.cursor
		? { items, cursor: result.cursor, hasMore: result.hasMore }
		: { items, hasMore: result.hasMore };
}

export async function sampleSource(
	deps: EngineDeps,
	uploadId: string,
	n: number,
): Promise<CsvSample> {
	try {
		return await readCsvSample(await deps.source.open(uploadId, 0), Math.min(n, SAMPLE_MAX));
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof CsvSyntaxError) {
			throw new ServiceError("INVALID_SOURCE", `${e.message} at byte ${e.offset}`, 400);
		}
		throw e;
	}
}

export type StartJobInput = Omit<CreateJobInput, "schemaFields">;
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;

function collectionOf(template: unknown): string | null {
	return typeof template === "object" &&
		template !== null &&
		"collection" in template &&
		typeof template.collection === "string"
		? template.collection
		: null;
}

/** Creates a job after reading the target collection's fields. */
export async function startJob(
	deps: EngineDeps,
	input: StartJobInput,
	lookupFields: FieldLookup,
): Promise<Job> {
	const collection = collectionOf(input.template);
	// Without a collection name the template is invalid; createJob reports that with details.
	const schemaFields = collection === null ? [] : await lookupFields(collection);
	if (schemaFields === null) {
		throw new JobError("invalid_template", `Collection "${collection}" does not exist`);
	}
	return createJob(deps, { ...input, schemaFields });
}

export async function getJob(deps: EngineDeps, id: string): Promise<Job> {
	const job = await deps.jobs.get(id);
	if (!job) throw new JobError("not_found", `Job ${id} not found`);
	return job;
}

/** Whether a job may still read its staged file (resume, retry, or a real run after a dry run). */
export function uploadNeeded(job: Job): boolean {
	switch (job.status) {
		case "cancelled":
			return false;
		case "completed":
			return job.dryRun || job.counters.failed + job.counters.conflict + job.counters.locked > 0;
		default:
			return true;
	}
}

/** Deletes the job's staged file once neither it nor any other job can still read it. */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	let cursor: string | undefined;
	do {
		const result = await deps.jobs.query({
			where: { uploadId: job.uploadId },
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		if (result.items.some(({ id, data }) => id !== job.id && uploadNeeded(data))) return false;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	await uploads.delete(job.uploadId);
	return true;
}

async function releaseQuietly(deps: EngineDeps, uploads: UploadStore, job: Job): Promise<void> {
	// Best effort: a file left behind here is removed by the retention task.
	await releaseUploadIfUnused(deps, uploads, job).catch(() => false);
}

export async function nextBatch(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	holder: string,
): Promise<Job> {
	const job = await runBatch(deps, id, holder);
	await releaseQuietly(deps, uploads, job);
	return job;
}

export async function changeJob(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	const job = await transitionJob(deps, id, action);
	if (action === "cancel") await releaseQuietly(deps, uploads, job);
	return job;
}

export async function listJobs(
	deps: EngineDeps,
	opts: { status?: JobStatus; cursor?: string },
): Promise<Page<Job>> {
	return page(
		await deps.jobs.query({
			...(opts.status ? { where: { status: opts.status } } : {}),
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
}

export async function listRecords(
	deps: EngineDeps,
	opts: { id: string; status?: RecordStatus; cursor?: string },
): Promise<Page<RecordRow>> {
	await getJob(deps, opts.id);
	return page(
		await deps.records.query({
			where: opts.status ? { jobId: opts.id, status: opts.status } : { jobId: opts.id },
			orderBy: { seq: "asc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
}

export async function jobLogCsv(
	deps: EngineDeps,
	id: string,
	status?: RecordStatus,
): Promise<string> {
	await getJob(deps, id);
	const csv = await buildLogCsv(deps, id, status ? { status } : {});
	if (new TextEncoder().encode(csv).byteLength > LOG_MAX_BYTES) {
		throw new ServiceError(
			"LOG_TOO_LARGE",
			"The log is larger than 8 MiB; download it per status (status=failed, conflict, …)",
			413,
		);
	}
	return csv;
}
