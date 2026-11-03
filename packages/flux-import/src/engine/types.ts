import type { MediaFetcher } from "../sources/media-fetch.js";
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, MediaPort, SourcePort } from "./ports.js";
import type { TaxonomySnapshot, Template } from "./template.js";
import type { TargetField } from "./values.js";

export const BATCH_SIZE_DEFAULT = 50;
export const BATCH_SIZE_MAX = 500;
export const BUDGET_MS_DEFAULT = 4000;

export type JobStatus = "created" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface Counters {
	created: number;
	updated: number;
	unchanged: number;
	locked: number;
	conflict: number;
	failed: number;
	/** Records the template's filter skipped. Absent on jobs created before M3b (read as 0). */
	filtered: number;
}

/** A term a dry run plans to create, kept on the job so later batches see it. */
export type PlannedTerm = {
	taxonomy: string;
	/** The path from the root: slugs in `slug` mode, labels in `label` mode. */
	path: string[];
	match: "slug" | "label";
};

export interface Job {
	id: string;
	status: JobStatus;
	uploadId: string;
	template: Template;
	dryRun: boolean;
	publish: boolean;
	batchSize: number;
	budgetMs: number;
	/** The template's source block. Absent on jobs created before M3a, which are CSV. */
	source?: TemplateSource;
	/** CSV and XLSX header columns; absent for other formats. */
	columns?: string[];
	/** Pre-M3a name of `columns`, still read for jobs created before M3a. */
	headers?: string[];
	/**
	 * Warnings for the job: template paths missing from the sampled records (JSON, JSON Lines,
	 * XML), and header renames and skipped cells from an XLSX conversion.
	 */
	warnings?: string[];
	/** XLSX: the uploaded workbook; `uploadId` is the JSON Lines it was converted to. */
	sourceUploadId?: string;
	/**
	 * The mapped fields as they were at job creation (type, `required`, validation), checked
	 * before every write. Absent on jobs created before M4a, which keep M2 behaviour.
	 */
	targetFields?: Record<string, TargetField>;
	/** The site timezone read at job creation, for `tz: "site"`; absent before M4a (UTC). */
	siteTimezone?: string;
	/**
	 * The collection already had the `flux_source_id` field at job creation, so a dry run may
	 * filter by it. Absent before M4b: such a dry run never does.
	 */
	sourceIdField?: boolean;
	/**
	 * Required fields shared across a translation group that the template leaves unmapped
	 * (`sharedRequiredOf`): a record without a `translationOf` value fails `required` for each.
	 * Absent when there are none (M4e).
	 */
	sharedRequired?: string[];
	/** The mapped taxonomies as they were at job creation; absent when none are mapped. */
	taxonomies?: Record<string, TaxonomySnapshot>;
	/**
	 * A dry run's terms that earlier batches planned to create, so later batches see them as a
	 * real run would; capped at `MAX_PLANNED_TERMS`. Absent outside dry runs.
	 */
	plannedTerms?: PlannedTerm[];
	/**
	 * The largest file an image or file field downloads, read at job creation: the site's
	 * `maxUploadSize`, at most 5 MiB on Workers. Absent when the template maps no media.
	 */
	mediaMaxBytes?: number;
	/**
	 * Terms and media a record created before a batch left it for the next one (a download that
	 * would start too late), merged into its row when it completes. Absent otherwise.
	 */
	deferred?: {
		seq: number;
		newTerms: string[];
		newMedia: string[];
		/** Image downloads that failed for good (media map key and error), so the retry skips them. */
		failed?: { key: string; error: { field: string; code: string; message: string } }[];
	};
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
	phase: "import" | "retry";
	retryFromSeq: number;
	schemaReady: boolean;
	error: { code: string; message: string } | null;
	/** Consecutive batches that ended in an unexpected error; the job fails at three. */
	failures: number;
	createdAt: string;
	updatedAt: string;
}

export type RecordStatus =
	| "writing"
	| "created"
	| "updated"
	| "unchanged"
	| "locked"
	| "conflict"
	| "failed"
	| "planned"
	| "filtered";

export interface RecordError {
	field?: string;
	code: string;
	message: string;
}

export interface RecordRow {
	jobId: string;
	seq: number;
	start: number;
	end: number;
	status: RecordStatus;
	sourceKey: string | null;
	entryId: string | null;
	action?: PlanAction;
	changes?: Change[];
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
	writtenRev?: string;
	/**
	 * Terms created for the record (`taxonomy: Parent > Child`), or that a dry run would create.
	 * Absent when there are none.
	 */
	newTerms?: string[];
	/**
	 * Media downloaded for the record (`field: url`), also when the upload found identical bytes
	 * already stored, or that a dry run would download. Absent when there are none.
	 */
	newMedia?: string[];
	/**
	 * What the record's latest conversion reported without failing it (M4d), at most
	 * `MAX_RECORD_WARNINGS`. Absent when there are none.
	 */
	warnings?: RecordError[];
	updatedAt: string;
}

export interface LinkRow {
	collection: string;
	locale: string;
	sourceKey: string;
	entryId: string;
	/**
	 * The latest revision this importer produced for the entry (the publish's revision when it
	 * published, else the write's). A pending draft at any other revision is not the importer's.
	 */
	writtenRev?: string;
}

/**
 * What a media URL became, in the site-wide media map (plugin storage `media`, keyed by
 * `mediaMapKey`). Written as soon as an upload succeeds; never purged by retention.
 */
export interface MediaMapRow {
	/** The normalized URL. */
	url: string;
	mediaId: string;
	storageKey: string;
	mimeType: string;
	bytes: number;
	/** Validators of the download, for `refresh`. */
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
	/** The job that last downloaded it. */
	jobId: string;
	/** The upload made a new item rather than finding identical bytes already stored. */
	created: boolean;
}

export interface EngineDeps {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	content: ContentPort;
	lookups: LookupPort;
	media: MediaPort;
	mediaFetcher: MediaFetcher;
	source: SourcePort;
	now: () => number;
	newId: () => string;
}

export function recordKey(jobId: string, seq: number): string {
	return `${jobId}:${String(seq).padStart(10, "0")}`;
}

export function linkKey(collection: string, locale: string, sourceKey: string): string {
	return `${collection}:${locale}:${sourceKey}`;
}

/** Warnings kept on one record row. */
export const MAX_RECORD_WARNINGS = 20;
/** Errors kept on one record row, so that no producer can make a row too large to store. */
export const MAX_RECORD_ERRORS = 50;
/** The longest message kept in a row's error or warning, in characters. */
export const MAX_RECORD_MESSAGE_LENGTH = 1000;

/** `issue` with its message cut to `MAX_RECORD_MESSAGE_LENGTH` characters. */
function bounded(issue: RecordError): RecordError {
	if (issue.message.length <= MAX_RECORD_MESSAGE_LENGTH) return issue;
	return { ...issue, message: `${issue.message.slice(0, MAX_RECORD_MESSAGE_LENGTH - 1)}…` };
}

/** At most `max` issues, each message bounded: past it, the last one kept says how many more. */
function capIssues(
	issues: readonly RecordError[],
	max: number,
	summary: (more: number) => RecordError,
): RecordError[] {
	if (issues.length <= max) return issues.map(bounded);
	const kept = issues.slice(0, max - 1).map(bounded);
	return [...kept, summary(issues.length - kept.length)];
}

/**
 * At most `MAX_RECORD_WARNINGS` warnings: when there are more, the last one kept says how many
 * were left out (`warnings_truncated`). Each message is at most `MAX_RECORD_MESSAGE_LENGTH`.
 */
export function capWarnings(warnings: readonly RecordError[]): RecordError[] {
	return capIssues(warnings, MAX_RECORD_WARNINGS, (more) => ({
		code: "warnings_truncated",
		message: `${more} more warnings`,
	}));
}

/**
 * At most `MAX_RECORD_ERRORS` errors: when there are more, the last one kept says how many were
 * left out (`errors_truncated`). Each message is at most `MAX_RECORD_MESSAGE_LENGTH`.
 */
export function capErrors(errors: readonly RecordError[]): RecordError[] {
	return capIssues(errors, MAX_RECORD_ERRORS, (more) => ({
		code: "errors_truncated",
		message: `${more} more errors`,
	}));
}

export function emptyCounters(): Counters {
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
}
