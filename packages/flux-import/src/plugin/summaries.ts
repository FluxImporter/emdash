/**
 * What the M6c routes return instead of job rows (spec "JobSummary", "StepReply",
 * "RecordSummary", "Redaction"). Pure: no storage reads, the clock is an argument.
 */
import { UPLOAD_ID_PATTERN, UPLOAD_PREFIX } from "../emdash/uploads.js";
import { upgradeJob } from "../engine/jobs.js";
import type { Job, JobStatus, RecordError, RecordRow, RecordStatus } from "../engine/types.js";

export const RECORD_PAGE = 10;
export const WARNINGS_SHOWN = 10;
export const CHANGES_SHOWN = 20;
export const ERRORS_SHOWN = 5;
export const NAMES_SHOWN = 5;
export const VALUE_PREVIEW = 200;
export const TEXT_PREVIEW = 300;
/** The pause after an unexpected batch error; the engine fails the job at the third. */
export const RETRY_AFTER_ERROR_MS = 5_000;
const LEASE_WAIT_MIN_MS = 1_000;
const LEASE_WAIT_MAX_MS = 30_000;

export const STAGED_FILE = "[staged file]";
export const INTERNAL_JOB_MESSAGE =
	"An unexpected error stopped the batch; the next call retries it";
export const INTERNAL_RECORD_MESSAGE = "An unexpected error";

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UPLOAD_ID_RE = new RegExp(UPLOAD_ID_PATTERN, "g");
/** An upload key once its ID is redacted: the prefix, the placeholder and an extension. */
const UPLOAD_KEY_RE = new RegExp(
	`${literal(UPLOAD_PREFIX)}${literal(STAGED_FILE)}(?:\\.[0-9A-Za-z]+)?`,
	"gi",
);

export type Next = "next_batch" | "wait" | "done" | "stopped";

export interface JobSummary {
	id: string;
	kind: "import" | "rollback";
	status: JobStatus;
	dryRun: boolean;
	phase: Job["phase"];
	origin?: "agent";
	collection: string;
	locale: string;
	templateId?: string;
	templateRevision?: number;
	dryRunOf?: string;
	startedAs?: string;
	rollbackOf?: string;
	rolledBackBy?: string;
	publish: boolean;
	/** `job.missingLimit`; null without `rules.missing`. False or null on agent jobs. */
	missing: { maxPercent: number } | false | null;
	processed: number;
	counters: Required<Job["counters"]>;
	missingPhase?: {
		stage: "count" | "act" | "done";
		verdict?: "act" | "refused" | "skipped";
		owned: number;
		found: number;
		removed: number;
	};
	error: { code: string; message: string } | null;
	warnings: string[];
	warningCount: number;
	busyUntil?: string;
	retryAfterMs?: number;
	next: Next;
	createdAt: string;
	updatedAt: string;
}

export interface StepReply {
	id: string;
	status: JobStatus;
	next: Next;
	processed: number;
	total?: number;
	busyUntil?: string;
	retryAfterMs?: number;
	error?: { code: string; message: string };
}

export interface RecordSummary {
	seq: number;
	status: RecordStatus;
	action?: string;
	sourceKey: string | null;
	entryId: string | null;
	changes: { field: string; value: string }[];
	changeCount: number;
	errors: { field?: string; code: string; message: string }[];
	errorCount: number;
	warningCount: number;
	newTerms: string[];
	newMedia: string[];
}

/**
 * Replaces every upload key and bare upload ID with `[staged file]` (spec Ruling 33).
 *
 * Every position where the pattern matches is found, overlapping ones included, and the union of
 * the matches is replaced. A leftmost, non-overlapping search would start a match early when the
 * ID follows characters of its own alphabet and leave the ID's last characters behind; the union
 * always covers each ID whole. Linear: each position is tried once, at most 58 characters each.
 */
export function redact(text: string): string {
	const spans: [number, number][] = [];
	UPLOAD_ID_RE.lastIndex = 0;
	for (let m = UPLOAD_ID_RE.exec(text); m !== null; m = UPLOAD_ID_RE.exec(text)) {
		const end = m.index + m[0].length;
		const last = spans[spans.length - 1];
		if (last !== undefined && m.index <= last[1]) last[1] = end;
		else spans.push([m.index, end]);
		UPLOAD_ID_RE.lastIndex = m.index + 1;
	}
	if (spans.length === 0) return text;
	let out = "";
	let from = 0;
	for (const [start, end] of spans) {
		out += text.slice(from, start) + STAGED_FILE;
		from = end;
	}
	return (out + text.slice(from)).replace(UPLOAD_KEY_RE, STAGED_FILE);
}

/** At most `max` code points, and `…` when cut. Callers redact first (Review Focus 1). */
export function cut(text: string, max: number): string {
	const points = Array.from(text);
	return points.length <= max ? text : `${points.slice(0, max).join("")}…`;
}

const shown = (text: string) => cut(redact(text), TEXT_PREVIEW);

function jobError(error: { code: string; message: string }) {
	return {
		code: error.code,
		message: error.code === "internal" ? INTERNAL_JOB_MESSAGE : shown(error.message),
	};
}

function recordError(error: RecordError) {
	return {
		...(error.field === undefined ? {} : { field: error.field }),
		code: error.code,
		message: error.code === "internal" ? INTERNAL_RECORD_MESSAGE : shown(error.message),
	};
}

/** Records read: the import's cursor, or a rollback's rows (its cursor walks the journal). */
function processedOf(job: Job): number {
	if (job.kind !== "rollback") return job.cursor.seq;
	return Object.values(job.counters).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** Known once the import pass is over: the source is streamed, never counted ahead. */
function totalOf(job: Job, processed: number): number | undefined {
	if (job.kind !== "rollback" && job.missing !== undefined) return job.missing.fromSeq;
	return job.status === "completed" ? processed : undefined;
}

/** `next`, `busyUntil` and `retryAfterMs` (spec Ruling 37). */
function advice(job: Job, now: number): Pick<StepReply, "next" | "busyUntil" | "retryAfterMs"> {
	if (job.status === "completed") return { next: "done" };
	if (job.status !== "created" && job.status !== "running") return { next: "stopped" };
	const { lease } = job;
	if (lease !== null && lease.expiresAt > now) {
		const left = lease.expiresAt - now;
		return {
			next: "wait",
			busyUntil: new Date(lease.expiresAt).toISOString(),
			retryAfterMs: Math.min(LEASE_WAIT_MAX_MS, Math.max(LEASE_WAIT_MIN_MS, left)),
		};
	}
	if (job.error?.code === "internal") {
		return { next: "next_batch", retryAfterMs: RETRY_AFTER_ERROR_MS };
	}
	return { next: "next_batch" };
}

export function summarize(stored: Job, now: number): JobSummary {
	const job = upgradeJob(stored);
	const { counters } = job;
	const warnings = job.warnings ?? [];
	const { next, busyUntil, retryAfterMs } = advice(job, now);
	const missing = job.kind === "rollback" ? undefined : job.missing;
	return {
		id: job.id,
		kind: job.kind ?? "import",
		status: job.status,
		dryRun: job.dryRun,
		phase: job.phase,
		...(job.origin === undefined ? {} : { origin: job.origin }),
		collection: job.template.collection,
		locale: job.template.locale,
		...(job.templateId === undefined ? {} : { templateId: job.templateId }),
		...(job.templateRevision === undefined ? {} : { templateRevision: job.templateRevision }),
		...(job.dryRunOf === undefined ? {} : { dryRunOf: job.dryRunOf }),
		...(job.startedAs === undefined ? {} : { startedAs: job.startedAs }),
		...(job.rollbackOf === undefined ? {} : { rollbackOf: job.rollbackOf }),
		...(job.rolledBackBy === undefined ? {} : { rolledBackBy: job.rolledBackBy }),
		publish: job.publish,
		missing: job.missingLimit ?? null,
		processed: processedOf(job),
		counters: { ...counters, reverted: counters.reverted ?? 0, removed: counters.removed ?? 0 },
		...(missing === undefined
			? {}
			: {
					missingPhase: {
						stage: missing.stage,
						...(missing.verdict === undefined ? {} : { verdict: missing.verdict }),
						owned: missing.owned,
						found: missing.found,
						removed: missing.removed,
					},
				}),
		error: job.error === null ? null : jobError(job.error),
		warnings: warnings.slice(0, WARNINGS_SHOWN).map(shown),
		warningCount: warnings.length,
		...(busyUntil === undefined ? {} : { busyUntil }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		next,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
}

export function step(stored: Job, now: number): StepReply {
	const job = upgradeJob(stored);
	const processed = processedOf(job);
	const total = totalOf(job, processed);
	const { next, busyUntil, retryAfterMs } = advice(job, now);
	return {
		id: job.id,
		status: job.status,
		next,
		processed,
		...(total === undefined ? {} : { total }),
		...(busyUntil === undefined ? {} : { busyUntil }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		...(job.error === null ? {} : { error: jobError(job.error) }),
	};
}

/** The mapped value only (`after`), never the entry's current value (spec Ruling 34). */
function preview(value: unknown): string {
	if (value === undefined) return "(none)";
	return cut(redact(JSON.stringify(value)), VALUE_PREVIEW);
}

export function summarizeRecord(row: RecordRow): RecordSummary {
	const changes = row.changes ?? [];
	const errors = row.errors ?? [];
	return {
		seq: row.seq,
		status: row.status,
		...(row.action === undefined ? {} : { action: row.action }),
		sourceKey: row.sourceKey === null ? null : shown(row.sourceKey),
		entryId: row.entryId,
		changes: changes
			.slice(0, CHANGES_SHOWN)
			.map((change) => ({ field: change.field, value: preview(change.after) })),
		changeCount: changes.length,
		errors: errors.slice(0, ERRORS_SHOWN).map(recordError),
		errorCount: errors.length,
		warningCount: row.warnings?.length ?? 0,
		newTerms: (row.newTerms ?? []).slice(0, NAMES_SHOWN).map(shown),
		newMedia: (row.newMedia ?? []).slice(0, NAMES_SHOWN).map(shown),
	};
}
