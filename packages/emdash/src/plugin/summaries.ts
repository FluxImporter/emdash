/**
 * What the M6c routes return instead of job rows (spec "JobSummary", "StepReply",
 * "RecordSummary", "Redaction"), and M7b's `jobs/summaries` list items. Pure: no storage reads,
 * the clock is an argument.
 */
import { UPLOAD_ID_PATTERN, UPLOAD_PREFIX } from "../emdash/uploads.js";
import { upgradeJob } from "../engine/jobs.js";
import { rollbackRefusal } from "../engine/rollback.js";
import type {
	Counters,
	Job,
	JobStatus,
	RecordError,
	RecordRow,
	RecordStatus,
} from "../engine/types.js";

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
/** A `StepReply`'s JSON, in UTF-8 bytes (spec Ruling 37). */
export const STEP_REPLY_MAX_BYTES = 400;

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

/** `not_agent`: the job was not made by the agent tools, which therefore cannot advance it. */
export type Next = "next_batch" | "wait" | "done" | "stopped" | "not_agent";

export interface JobSummary {
	id: string;
	kind: "import" | "rollback";
	status: JobStatus;
	dryRun: boolean;
	phase: Job["phase"];
	origin?: Job["origin"];
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
	/** No `value` on a rollback: its `after` is the entry's former value, drafts included. */
	changes: { field: string; value?: string }[];
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
		code: shown(error.code),
		message: error.code === "internal" ? INTERNAL_JOB_MESSAGE : shown(error.message),
	};
}

function recordError(error: RecordError) {
	return {
		...(error.field === undefined ? {} : { field: shown(error.field) }),
		code: shown(error.code),
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
	if (job.origin !== "agent") return { next: "not_agent" };
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

/**
 * A row of the admin's Jobs table (M7b `jobs/summaries`, plan Ruling 3): the fields the table
 * shows and nothing else. No template, upload IDs, lease holder, cursor or error message; the
 * error's code only (Review Focus 3).
 */
export interface JobListItem {
	id: string;
	kind: "import" | "rollback";
	status: JobStatus;
	dryRun: boolean;
	origin?: Job["origin"];
	scheduleId?: string;
	collection: string;
	locale: string;
	templateId?: string;
	rollbackOf?: string;
	rolledBackBy?: string;
	/** The rollback job's status; absent when it is gone. */
	rollbackStatus?: JobStatus;
	startedAs?: string;
	/** `rollbackRefusal(job, now) === null`. */
	rollbackable: boolean;
	/**
	 * Records read of the source's `recordTotal`, while an import's first pass is unfinished;
	 * absent when the total is unknown, and once the job completed or left the first pass.
	 */
	progress?: { processed: number; total: number };
	counters: Required<
		Pick<
			Counters,
			| "created"
			| "updated"
			| "unchanged"
			| "failed"
			| "conflict"
			| "locked"
			| "filtered"
			| "reverted"
			| "removed"
		>
	>;
	/** `job.error.code` only. */
	errorCode?: string;
	createdAt: string;
	updatedAt: string;
}

/** What `jobs/clear-dry-runs` answers (M7b Task 5). */
export interface ClearDryRunsReply {
	cleared: number;
	more: boolean;
	cursor?: string;
}

/** An import's first pass, against its known record total (`JobListItem.progress`). */
function progressOf(job: Job): JobListItem["progress"] {
	if (job.kind === "rollback" || job.recordTotal === undefined) return undefined;
	if (job.status === "completed" || job.phase !== "import") return undefined;
	return { processed: job.cursor.seq, total: job.recordTotal };
}

/** A job as the Jobs table lists it; counters absent on old jobs read as 0. */
export function listItem(
	stored: Job,
	rollbackStatus: JobStatus | undefined,
	now: number,
): JobListItem {
	const job = upgradeJob(stored);
	const { counters } = job;
	const progress = progressOf(job);
	return {
		id: job.id,
		kind: job.kind ?? "import",
		status: job.status,
		dryRun: job.dryRun,
		...(job.origin === undefined ? {} : { origin: job.origin }),
		...(job.scheduleId === undefined ? {} : { scheduleId: job.scheduleId }),
		collection: job.template.collection,
		locale: job.template.locale,
		...(job.templateId === undefined ? {} : { templateId: job.templateId }),
		...(job.rollbackOf === undefined ? {} : { rollbackOf: job.rollbackOf }),
		...(job.rolledBackBy === undefined ? {} : { rolledBackBy: job.rolledBackBy }),
		...(rollbackStatus === undefined ? {} : { rollbackStatus }),
		...(job.startedAs === undefined ? {} : { startedAs: job.startedAs }),
		rollbackable: rollbackRefusal(job, now) === null,
		...(progress === undefined ? {} : { progress }),
		counters: {
			created: counters.created,
			updated: counters.updated,
			unchanged: counters.unchanged,
			failed: counters.failed,
			conflict: counters.conflict,
			locked: counters.locked,
			filtered: counters.filtered,
			reverted: counters.reverted ?? 0,
			removed: counters.removed ?? 0,
		},
		...(job.error === null ? {} : { errorCode: job.error.code }),
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
}

const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text).length;

/**
 * The longest prefix of `message`, by code point, whose JSON string fits `budget` bytes with `…`
 * after it; the whole message when it fits. Each code point is escaped on its own, as
 * `JSON.stringify` escapes a string character by character, so one pass suffices.
 */
function fitMessage(message: string, budget: number): string {
	if (bytes(JSON.stringify(message)) - 2 <= budget) return message;
	const room = budget - bytes("…");
	let used = 0;
	let end = 0;
	for (const point of message) {
		used += bytes(JSON.stringify(point)) - 2;
		if (used > room) break;
		end += point.length;
	}
	return `${message.slice(0, end)}…`;
}

/**
 * The reply's JSON is at most `STEP_REPLY_MAX_BYTES`: the error message is cut further, by code
 * point, to what the rest leaves. Holds while the job ID and the error code are server-made (a
 * ULID, a code constant), as every stored job's are.
 */
export function step(stored: Job, now: number): StepReply {
	const job = upgradeJob(stored);
	const processed = processedOf(job);
	const total = totalOf(job, processed);
	const { next, busyUntil, retryAfterMs } = advice(job, now);
	const reply: StepReply = {
		id: job.id,
		status: job.status,
		next,
		processed,
		...(total === undefined ? {} : { total }),
		...(busyUntil === undefined ? {} : { busyUntil }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
	if (job.error === null) return reply;
	const error = jobError(job.error);
	const rest = bytes(JSON.stringify({ ...reply, error: { ...error, message: "" } }));
	const message = fitMessage(error.message, STEP_REPLY_MAX_BYTES - rest);
	return { ...reply, error: { ...error, message } };
}

/** The mapped value only (`after`), never the entry's current value (spec Ruling 34). */
function preview(value: unknown): string {
	if (value === undefined) return "(none)";
	return cut(redact(JSON.stringify(value)), VALUE_PREVIEW);
}

/**
 * A record row as an agent sees it. `kind` is the job's: a rollback's `after` is the value the
 * entry held before the import, drafts included, so its changes show field names only.
 */
export function summarizeRecord(row: RecordRow, kind: Job["kind"]): RecordSummary {
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
			.map((change) =>
				kind === "rollback"
					? { field: shown(change.field) }
					: { field: shown(change.field), value: preview(change.after) },
			),
		changeCount: changes.length,
		errors: errors.slice(0, ERRORS_SHOWN).map(recordError),
		errorCount: errors.length,
		warningCount: row.warnings?.length ?? 0,
		newTerms: (row.newTerms ?? []).slice(0, NAMES_SHOWN).map(shown),
		newMedia: (row.newMedia ?? []).slice(0, NAMES_SHOWN).map(shown),
	};
}
