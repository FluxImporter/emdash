import { I18N_REQUIRED_MESSAGE, type LocaleResolution } from "../emdash/locale.js";
import { type StagedUpload, stageUpload, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { runBatch } from "../engine/batch.js";
import { FACETS } from "../engine/counters.js";
import {
	type CreateJobInput,
	createJob,
	JobError,
	transitionJob,
	upgradeJob,
} from "../engine/jobs.js";
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import { DEFAULT_MAX_UPLOAD_SIZE } from "../engine/media.js";
import type { KvCollection, LookupPort } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks, usesMedia } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
	CSV_SOURCE,
	SourceError,
	type TemplateSource,
	type ValueSample,
} from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
import { type JobListItem, listItem } from "./summaries.js";

export const PAGE_SIZE = 50;
/**
 * Jobs per `jobs/list` page, filtered or not (M6a final review). A storage query returns whole
 * documents, and every job holds its template: up to 256 KiB from a saved template
 * (`TEMPLATE_MAX_BYTES`), so a page of `PAGE_SIZE` could read about 13 MB. Eight keep a page of
 * saved-template jobs at about 2 MiB, as `TEMPLATE_PAGE` does for `templates/list`; clients page
 * with the cursor.
 */
export const JOB_PAGE = 8;
export const SAMPLE_MAX = 20;
/** Pasted text is staged like an upload, up to this many UTF-8 bytes. */
export const PASTE_MAX_BYTES = 1024 * 1024;
/** Raw plugin responses are capped at 8 MiB (`PLUGIN_ROUTE_MAX_BODY_BYTES`, @emdash-cms/plugin-types). */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Records one jobs/next call processes on Workers, whatever the job's batch size. Cloudflare
 * allows 1,000 D1 queries per Worker invocation on the paid plan (50 on the free plan;
 * https://developers.cloudflare.com/workers/platform/limits/), local workerd does not enforce it,
 * and each record costs about nine plugin storage calls plus EmDash's own content queries. Measured
 * on local D1 (M5a review, V8): a batch of published updates costs about 240 queries plus 57 per
 * record, so 20 records ran 1,377 queries and 13 ran 978; 11 stay under about 900.
 */
export const WORKERS_BATCH_CAP = 11;
/**
 * `WORKERS_BATCH_CAP` for jobs whose template maps reference fields, taxonomies, bylines or
 * media: each record also looks its links and media up, and may download files. Measured on local
 * D1 (M5a review, V8): updates with three references, two taxonomies and bylines cost about 120
 * queries per record plus about 130 per batch, so 10 records ran 1,331 queries and 6 ran 855.
 */
export const WORKERS_LINKED_BATCH_CAP = 6;

/**
 * Rollback rows one jobs/next call reverts on Workers (M5a). A reverted update runs up to seven
 * content calls, about 175-265 D1 queries with EmDash's own (Fact V7), so three rows
 * stay under the 1,000-query limit (measured in the M5a review: 744 queries for three scheduled
 * updates with every link kind, 214 for three deletes). M5b adds step 7 (unschedule), which
 * excludes step 6, so the longest sequence stays five steps and the engine's per-row reserve
 * (`ROW_RESERVE` in `src/engine/revert.ts`) is 165. Measured in the M5b review (V7): 555 queries
 * for three rows of that longest sequence, 502 for three linked scheduled updates and 465 for three
 * linked scheduled drafts (step 7).
 */
export const WORKERS_ROLLBACK_BATCH_CAP = 3;

/**
 * Entries one jobs/next call reads in the missing phase's count stage on Workers (M5c). Every
 * read counts, misses included (spec Ruling 29 M8). The engine charges each read at
 * `COST_MISSING_READ` (12, a D1 get's queries) and takes at most `MISSING_PAGES_PER_BATCH` (20)
 * link pages a batch, so the worst count batch is 20 all-seen pages and 40 reads: about
 * 20 × 2 + 40 × 14 + 60 = 660 D1 queries (spec Ruling 32, arithmetic in `src/engine/missing.ts`).
 * Measured in the M5c review (V8): 131 queries for 40 reads, 165 for 19 all-seen pages then 40
 * reads, and 44 for a batch of 20 all-seen pages (8,800 links).
 */
export const WORKERS_MISSING_SCAN_CAP = 40;

/**
 * Entries one jobs/next call decides in the missing phase's act stage on Workers (M5c): a read,
 * a lock check, the journal row, two row saves, the trash or unpublish (19 or 33 D1 queries) and
 * the link. With at most `MISSING_PAGES_PER_BATCH` (20) link pages a batch, the worst act batch
 * is about 20 × 2 + 10 × 70 + 60 = 800 D1 queries (spec Ruling 32). On D1 the lookup budget
 * (`WORKERS_LOOKUP_BUDGET`, each read charged `COST_MISSING_READ`) binds before this cap for
 * unpublish. Measured in the M5c review (V8): 298-308 queries for 10 trashes, 398-408 for 10
 * unpublishes, 436 for 19 all-seen pages then 10 unpublishes, 296 and 386 on a collection with
 * references, terms and bylines.
 */
export const WORKERS_MISSING_BATCH_CAP = 10;

/**
 * The lookup cost one jobs/next call may spend on Workers (see `COST_READ`): D1 allows 1,000
 * queries per invocation, and EmDash's lookups run several queries per call.
 */
export const WORKERS_LOOKUP_BUDGET = 600;

/**
 * The largest media file a job downloads on Workers. `handleMediaUpload` takes base64, so one
 * file is held about five times over, and EmDash's placeholder decode of a JPEG or PNG adds
 * memory by pixel count, inside a 128 MB isolate (Fact V5).
 */
export const WORKERS_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A job's `mediaMaxBytes`: the site's `maxUploadSize`, and at most `WORKERS_MEDIA_MAX_BYTES` on
 * Workers. EmDash's default stands in for a setting that is unset or not a positive number;
 * EmDash refuses such a setting itself, so the job's first upload fails it with `media_config`.
 */
export function mediaMaxBytes(maxUploadSize: number | undefined, workers: boolean): number {
	const valid = maxUploadSize !== undefined && Number.isFinite(maxUploadSize) && maxUploadSize > 0;
	const site = valid ? maxUploadSize : DEFAULT_MAX_UPLOAD_SIZE;
	const limit = workers ? Math.min(site, WORKERS_MEDIA_MAX_BYTES) : site;
	// EmDash prechecks the padded base64 size, 4 bytes per 3: a multiple of 3 never trips it.
	return Math.max(3, Math.floor(limit / 3) * 3);
}

/** The records one batch may process, by the kind of work (M6b preflight F17: one helper). */
export interface BatchCaps {
	plain: number;
	linked: number;
	missingScan: number;
	missingAct: number;
	rollback: number;
}

/** The cap in `caps` for this job's next batch. */
export function batchCap(job: Job, caps: BatchCaps): number {
	if (job.kind === "rollback") return caps.rollback;
	if (job.phase === "missing") {
		return job.missing?.stage === "count" ? caps.missingScan : caps.missingAct;
	}
	return usesLinks(job.template) || usesMedia(job.template) ? caps.linked : caps.plain;
}

const WORKERS_CAPS: BatchCaps = {
	plain: WORKERS_BATCH_CAP,
	linked: WORKERS_LINKED_BATCH_CAP,
	missingScan: WORKERS_MISSING_SCAN_CAP,
	missingAct: WORKERS_MISSING_BATCH_CAP,
	rollback: WORKERS_ROLLBACK_BATCH_CAP,
};

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	return batchCap(job, WORKERS_CAPS);
}

/**
 * A pump tick's batch on Workers (M6b spec "Bounded work"): the tick also finalizes, reads the
 * fence and may be one of ten tasks in one scheduled event, so its batch stays under
 * `PUMP_QUERY_TARGET` (550 D1 queries; Fact V5 measured at most 506 at these caps). A rollback
 * the pump drives reverts two rows: three of the longest revert sequence measured 555 queries
 * (`WORKERS_ROLLBACK_BATCH_CAP`), about 185 a row, so two stay near 370 with the batch's own reads.
 */
export const TICK_BATCH_CAP = 6;
export const TICK_LINKED_BATCH_CAP = 3;
export const TICK_MISSING_SCAN_CAP = 20;
export const TICK_MISSING_BATCH_CAP = 5;
export const TICK_ROLLBACK_BATCH_CAP = 2;
export const TICK_LOOKUP_BUDGET = 350;

const TICK_CAPS: BatchCaps = {
	plain: TICK_BATCH_CAP,
	linked: TICK_LINKED_BATCH_CAP,
	missingScan: TICK_MISSING_SCAN_CAP,
	missingAct: TICK_MISSING_BATCH_CAP,
	rollback: TICK_ROLLBACK_BATCH_CAP,
};

/** The records one pump tick processes on Workers for this job. */
export function tickBatchCap(job: Job): number {
	return batchCap(job, TICK_CAPS);
}

/** The records and lookups one batch may spend: `maxRecords` and `lookupBudget` of `runBatch`. */
export interface BatchLimits {
	maxRecords: number | ((job: Job) => number);
	lookupBudget: number;
}

/** `jobs/next`'s limits: the Workers caps on Workers; on Node the job's own `batchSize`. */
export function routeLimits(workers: boolean): BatchLimits {
	return workers
		? { maxRecords: workersBatchCap, lookupBudget: WORKERS_LOOKUP_BUDGET }
		: { maxRecords: Number.POSITIVE_INFINITY, lookupBudget: Number.POSITIVE_INFINITY };
}

/** A pump tick's limits: the tick caps on Workers; on Node the job's own `batchSize` (spec Ruling 35). */
export function tickLimits(workers: boolean): BatchLimits {
	return workers
		? { maxRecords: tickBatchCap, lookupBudget: TICK_LOOKUP_BUDGET }
		: routeLimits(false);
}

/** A failure the route layer turns into an HTTP error with this code and status. */
export class ServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		/** Machine-readable details, such as the source error `code` or a template's `problems`. */
		readonly details?: Readonly<Record<string, unknown>>,
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

export function page<T>(result: {
	items: { data: T }[];
	cursor?: string;
	hasMore: boolean;
}): Page<T> {
	const items = result.items.map((i) => i.data);
	return result.cursor
		? { items, cursor: result.cursor, hasMore: result.hasMore }
		: { items, hasMore: result.hasMore };
}

/**
 * Samples a staged source: CSV keeps its `{ headers, rows }` shape; JSON, JSON Lines and XML
 * return `{ records, paths }` (records that fail to parse are left out).
 */
export async function sampleSource(
	deps: Pick<EngineDeps, "source">,
	uploadId: string,
	n: number,
	source: TemplateSource = CSV_SOURCE,
): Promise<CsvSample | ValueSample> {
	const problems = checkSource(source);
	if (problems.length > 0) throw new ServiceError("INVALID_SOURCE", problems.join("; "), 400);
	const count = Math.min(n, SAMPLE_MAX);
	try {
		const stream = await deps.source.open(uploadId, 0);
		if (source.format === "csv") return await readCsvSample(stream, count);
		return await readerFor(source).sample(stream, count);
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof CsvSyntaxError || e instanceof SourceError) {
			const code = e instanceof SourceError ? e.code : "csv_syntax";
			throw new ServiceError("INVALID_SOURCE", `${e.message} at byte ${e.offset}`, 400, { code });
		}
		throw e;
	}
}

/** `sources/paste`'s refusal of an XLSX format: a workbook can only be uploaded. */
export const XLSX_PASTE_MESSAGE =
	"An XLSX workbook is a binary file and cannot be pasted; upload it instead";

/**
 * Pasted text as UTF-8 bytes: empty or whitespace-only text is `EMPTY_BODY`, more than
 * `PASTE_MAX_BYTES` is `TOO_LARGE` (shared by `stagePaste` and the M6d suggestion route).
 */
export function pasteBytes(text: string): Uint8Array<ArrayBuffer> {
	if (text.trim() === "") throw new ServiceError("EMPTY_BODY", "The pasted text is empty", 400);
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength > PASTE_MAX_BYTES) {
		throw new ServiceError("TOO_LARGE", `Pasted text is limited to ${PASTE_MAX_BYTES} bytes`, 413);
	}
	return bytes;
}

/** Stages pasted text like an upload. Empty or whitespace-only text is `EMPTY_BODY`. */
export async function stagePaste(storage: UploadStorage, text: string): Promise<StagedUpload> {
	const bytes = pasteBytes(text);
	return stageUpload(storage, new Blob([bytes]).stream(), PASTE_MAX_BYTES, bytes.byteLength);
}

export type StartJobInput = Omit<CreateJobInput, "schemaFields" | "linkSchema">;
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;
export type LocaleResolver = (locale: string) => LocaleResolution;
/** Resolves `translationOf.locale` (absent: the default locale) for a job in `locale`. */
export type TranslationLocaleResolver = (
	sourceLocale: string | undefined,
	locale: string,
) => LocaleResolution;

const keepLocale: LocaleResolver = (locale) => ({ ok: true, locale });
/** Without a site configuration there is no i18n, so `translationOf` is refused. */
const noTranslations: TranslationLocaleResolver = () => ({
	ok: false,
	message: I18N_REQUIRED_MESSAGE,
});

function collectionOf(template: unknown): string | null {
	return typeof template === "object" &&
		template !== null &&
		"collection" in template &&
		typeof template.collection === "string"
		? template.collection
		: null;
}

/**
 * Replaces the template's locale with the site's casing of it, so entries are stored and found
 * under the locale EmDash writes, and sets `translationOf.locale` the same way (the default
 * locale when left out). A template without a string locale, or with a `translationOf` that is
 * not an object or whose locale is not a string, is left for createJob to report.
 */
function withSiteLocale(
	template: unknown,
	resolveLocale: LocaleResolver,
	resolveTranslation: TranslationLocaleResolver,
): unknown {
	if (
		typeof template !== "object" ||
		template === null ||
		!("locale" in template) ||
		typeof template.locale !== "string"
	) {
		return template;
	}
	const resolved = resolveLocale(template.locale);
	if (!resolved.ok) {
		throw new JobError("invalid_template", "The template is invalid", [
			`locale: ${resolved.message}`,
		]);
	}
	const source = prop(template, "translationOf");
	const sourceLocale = prop(source, "locale");
	if (
		typeof source !== "object" ||
		source === null ||
		Array.isArray(source) ||
		(sourceLocale !== undefined && typeof sourceLocale !== "string")
	) {
		return { ...template, locale: resolved.locale };
	}
	const translation = resolveTranslation(sourceLocale, resolved.locale);
	if (!translation.ok) {
		throw new JobError("invalid_template", "The template is invalid", [translation.message]);
	}
	return {
		...template,
		locale: resolved.locale,
		translationOf: { ...source, locale: translation.locale },
	};
}

/** The value of `key` on an object, or undefined. */
function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/**
 * What the link checks read, once per job creation or saved-template site check: the fields of
 * every collection a mapped reference field links to, and the taxonomy definitions when the
 * template maps taxonomies. The template may not be parsed yet, so shapes are checked loosely;
 * createJob reports bad ones.
 */
export async function linkSchemaFor(
	deps: { lookups: Pick<LookupPort, "taxonomyDefs"> },
	template: unknown,
	fields: SchemaField[],
	lookupFields: FieldLookup,
	collection: string | null,
): Promise<LinkSchema> {
	const mapped = prop(template, "fields");
	// The job's own collection is already loaded, so a self-reference does not read it again.
	const targets: Record<string, SchemaField[] | null> =
		collection === null ? {} : { [collection]: fields };
	for (const f of fields) {
		const target = f.targetCollection;
		if (target === undefined || Object.hasOwn(targets, target)) continue;
		if (prop(prop(mapped, f.slug), "type") !== "reference") continue;
		targets[target] = await lookupFields(target);
	}
	const taxonomies = prop(template, "taxonomies");
	const mapsTaxonomies = typeof taxonomies === "object" && taxonomies !== null;
	return { targets, taxonomies: mapsTaxonomies ? await deps.lookups.taxonomyDefs() : [] };
}

/**
 * Creates a job after resolving the template locale (and `translationOf.locale`) and reading the
 * target collection's fields, its reference targets' fields and, for templates that map
 * taxonomies, the taxonomy definitions.
 */
export async function startJob(
	deps: EngineDeps,
	input: StartJobInput,
	lookupFields: FieldLookup,
	resolveLocale: LocaleResolver = keepLocale,
	resolveTranslation: TranslationLocaleResolver = noTranslations,
): Promise<Job> {
	const template = withSiteLocale(input.template, resolveLocale, resolveTranslation);
	const collection = collectionOf(template);
	// Without a collection name the template is invalid; createJob reports that with details.
	const schemaFields = collection === null ? [] : await lookupFields(collection);
	if (schemaFields === null) {
		throw new JobError("invalid_template", `Collection "${collection}" does not exist`);
	}
	const linkSchema = await linkSchemaFor(deps, template, schemaFields, lookupFields, collection);
	return createJob(deps, { ...input, template, schemaFields, linkSchema });
}

export async function getJob(deps: EngineDeps, id: string): Promise<Job> {
	const job = await deps.jobs.get(id);
	if (!job) throw new JobError("not_found", `Job ${id} not found`);
	return upgradeJob(job);
}

/**
 * Whether a job may still read its staged file (resume, retry, or a real run after a dry run).
 * A rollback job never reads it, and a rolled-back job can no longer be resumed or retried.
 */
export function uploadNeeded(job: Job): boolean {
	if (job.kind === "rollback" || job.rolledBackBy !== undefined) return false;
	switch (job.status) {
		case "cancelled":
			return false;
		case "completed":
			return job.dryRun || job.counters.failed + job.counters.conflict + job.counters.locked > 0;
		default:
			return true;
	}
}

/**
 * Whether a job other than `exceptJobId` may still read the staged file: as its own file, or as
 * the workbook its file was converted from (a real run after an XLSX dry run converts it again).
 */
export async function uploadInUse(
	jobs: KvCollection<Job>,
	uploadId: string,
	exceptJobId?: string,
): Promise<boolean> {
	for (const field of ["uploadId", "sourceUploadId"] as const) {
		let cursor: string | undefined;
		do {
			const result = await jobs.query({
				where: { [field]: uploadId },
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			if (result.items.some(({ id, data }) => id !== exceptJobId && uploadNeeded(data))) {
				return true;
			}
			cursor = result.hasMore ? result.cursor : undefined;
		} while (cursor);
	}
	return false;
}

/** Answers whether a staged file must stay although no job needs it (a source's latest fetch). */
export type UploadKeeper = (uploadId: string) => Promise<boolean>;

const keepNone: UploadKeeper = async () => false;

/**
 * Deletes the job's staged file, and the workbook an XLSX job's file was converted from, once
 * neither it nor any other job can still read them. Returns whether the job's file was deleted.
 */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
	keep: UploadKeeper = keepNone,
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	return releaseFiles(deps, uploads, job, keep);
}

/**
 * Deletes the job's staged file and its XLSX workbook unless another job may still read them or
 * `keep` holds them, without asking whether the job itself still needs them (the caller decided
 * that, or deleted the job: M7b `jobs/clear-dry-runs`). Returns whether the job's file was deleted.
 */
export async function releaseFiles(
	deps: Pick<EngineDeps, "jobs">,
	uploads: UploadStore,
	job: Pick<Job, "id" | "uploadId" | "sourceUploadId">,
	keep: UploadKeeper = keepNone,
): Promise<boolean> {
	let released = false;
	for (const uploadId of [job.uploadId, job.sourceUploadId]) {
		if (uploadId === undefined) continue;
		if (await uploadInUse(deps.jobs, uploadId, job.id)) continue;
		if (await keep(uploadId)) continue;
		await uploads.delete(uploadId);
		if (uploadId === job.uploadId) released = true;
	}
	return released;
}

async function releaseQuietly(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
	keep: UploadKeeper,
): Promise<void> {
	// Best effort: a file left behind here is removed by the retention task.
	await releaseUploadIfUnused(deps, uploads, job, keep).catch(() => false);
}

export async function nextBatch(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	holder: string,
	keep: UploadKeeper = keepNone,
	limits: BatchLimits = routeLimits(onWorkers()),
): Promise<Job> {
	const job = await runBatch(deps, id, holder, limits.maxRecords, limits.lookupBudget);
	await releaseQuietly(deps, uploads, job, keep);
	return job;
}

export async function changeJob(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
	keep: UploadKeeper = keepNone,
): Promise<Job> {
	const job = await transitionJob(deps, id, action);
	if (action === "cancel") await releaseQuietly(deps, uploads, job, keep);
	return job;
}

export async function listJobs(
	deps: Pick<EngineDeps, "jobs">,
	opts: { status?: JobStatus; templateId?: string; cursor?: string },
): Promise<Page<Job>> {
	const where = {
		...(opts.status ? { status: opts.status } : {}),
		...(opts.templateId ? { templateId: opts.templateId } : {}),
	};
	const jobs = page(
		await deps.jobs.query({
			...(Object.keys(where).length > 0 ? { where } : {}),
			orderBy: { createdAt: "desc" },
			limit: JOB_PAGE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
	return { ...jobs, items: jobs.items.map(upgradeJob) };
}

/** A page of `jobs/summaries`: the first page also says how many jobs the whole list holds. */
export interface JobSummariesPage extends Page<JobListItem> {
	/** Every job the list holds, on the first page (no cursor) only. */
	total?: number;
}

/**
 * A page of the admin's Jobs table (M7b `jobs/summaries`): real imports or dry runs, of one
 * status or all, newest first, from one query, plus one read per rolled-back import for its
 * rollback's status (at most `JOB_PAGE`). `["dryRun", "createdAt"]` serves the query; with a
 * status, the `status` index serves it too. The first page answers the list's exact `total`: a
 * first page that is not full is the whole list, so only a full one counts, with one `count`
 * over the same indexed fields. On D1 that count reads one index row per job it counts (a list
 * retention keeps short); later pages never count.
 */
export async function listJobSummaries(
	deps: Pick<EngineDeps, "jobs" | "now">,
	opts: { dryRun: boolean; status?: JobStatus; cursor?: string },
): Promise<JobSummariesPage> {
	const where = {
		dryRun: opts.dryRun,
		...(opts.status === undefined ? {} : { status: opts.status }),
	};
	const jobs = page(
		await deps.jobs.query({
			where,
			orderBy: { createdAt: "desc" },
			limit: JOB_PAGE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
	const now = deps.now();
	const items = await Promise.all(
		jobs.items.map(async (job) => {
			const rollback =
				job.kind !== "rollback" && job.rolledBackBy !== undefined
					? await deps.jobs.get(job.rolledBackBy)
					: null;
			return listItem(job, rollback?.status, now);
		}),
	);
	if (opts.cursor) return { ...jobs, items };
	const total = jobs.hasMore ? await deps.jobs.count(where) : items.length;
	return { ...jobs, items, total };
}

/** Which records a page lists: one status or all, and only the rows of one facet (`FACETS`). */
export type RecordFilter = {
	id: string;
	status?: RecordStatus;
	facet?: keyof typeof FACETS;
	cursor?: string;
	limit?: number;
};

export async function listRecords(deps: EngineDeps, opts: RecordFilter): Promise<Page<RecordRow>> {
	await getJob(deps, opts.id);
	return recordPage(deps, opts);
}

/**
 * A page of a job's records by `seq`, one status or all, without reading the job (M6c,
 * `jobs/status` has read it). With `facet`, only the rows that change an entry or that have
 * warnings; rows saved before facets were kept have none. `limit` is 1-100 (EmDash's page clamp),
 * default `PAGE_SIZE`.
 */
export async function recordPage(
	deps: Pick<EngineDeps, "records">,
	opts: RecordFilter,
): Promise<Page<RecordRow>> {
	const limit = opts.limit ?? PAGE_SIZE;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new RangeError(`limit must be an integer from 1 to 100, not ${limit}`);
	}
	return page(
		await deps.records.query({
			where: {
				jobId: opts.id,
				...(opts.status ? { status: opts.status } : {}),
				...(opts.facet ? { facet: { in: FACETS[opts.facet] } } : {}),
			},
			orderBy: { seq: "asc" },
			limit,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
}

export async function jobLogCsv(
	deps: EngineDeps,
	id: string,
	status?: RecordStatus,
): Promise<string> {
	const job = await getJob(deps, id);
	// M5c: the missing phase's rows read no record, so their record cell is left empty.
	const missingFrom = job.kind === "rollback" ? undefined : job.missing?.fromSeq;
	try {
		return await buildLogCsv(deps, id, {
			...(status ? { status } : {}),
			...(missingFrom === undefined ? {} : { missingFrom }),
			maxBytes: LOG_MAX_BYTES,
		});
	} catch (e) {
		if (!(e instanceof LogTooLargeError)) throw e;
		throw new ServiceError(
			"LOG_TOO_LARGE",
			"The log is larger than 8 MiB; download it per status (status=failed, conflict, …)",
			413,
		);
	}
}
