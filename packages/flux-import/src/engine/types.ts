import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, SourcePort } from "./ports.js";
import type { Template } from "./template.js";
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

export interface EngineDeps {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	content: ContentPort;
	lookups: LookupPort;
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

export function emptyCounters(): Counters {
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
}
