import type { PluginContext } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import { isPurging } from "../engine/rollback.js";
import type { EngineDeps, Job, JobStatus } from "../engine/types.js";
import type { ScheduleRow } from "./schedules.js";

export const RETENTION_TASK = "retention";
/**
 * Hourly at minute 17 (M6b spec Ruling 39), off EmDash's own hourly cleanup at minute 0; EmDash
 * evaluates cron expressions in UTC on every host.
 */
export const RETENTION_SCHEDULE = "17 * * * *";
export const RETENTION_DAYS_DEFAULT = 30;
/** Job rows per scan page (spec "Bounded work"): rows are read whole, so pages stay small. */
export const RETENTION_SCAN_PAGE = 20;
/** Over this many job rows a run deletes nothing and warns (spec Ruling 39, Open issues). */
export const RETENTION_SCAN_MAX = 1_000;
/** Storage calls one run may make, scan pages included (plan Ruling 16). */
export const RETENTION_QUERY_TARGET = 150;
/** A job's purge starts only with this many calls left. */
export const RETENTION_PRUNE_MIN = 10;
/** Where a run that stopped at its budget leaves the next job to purge (plugin KV, M6a F9). */
export const RETENTION_CURSOR_KEY = "retention:cursor";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

export interface PurgeResult {
	jobs: number;
	records: number;
	/** Journal and journalMedia rows (M5a). */
	journal: number;
	uploads: number;
	/** M6b: job rows seen when the scan passed `RETENTION_SCAN_MAX`; the run deleted nothing. */
	skipped?: number;
	/** M6b: the run stopped at its budget; the next run starts at the saved cursor. */
	more?: true;
	/** M6b: storage calls the run made, when it ran with bounds. */
	queries?: number;
}

/** Deletes staged files older than a cutoff, except upload IDs in `keep`; `EmDashUploads` implements it. */
export interface UploadPurger {
	purgeBefore(cutoff: Date, keep?: ReadonlySet<string>): Promise<number>;
}

/** M6b: what bounds a cron run of the purge (spec Ruling 39, plan Ruling 16). */
export interface RetentionBounds {
	/** Every schedule (at most 20, one page): a job a launch claim names is never purged. */
	schedules: Pick<KvCollection<ScheduleRow>, "query">;
	/** Plugin KV, for `RETENTION_CURSOR_KEY`. */
	kv: Pick<PluginContext["kv"], "get" | "set" | "delete">;
	/** Storage calls the run may make. */
	target: number;
}

/** The fields the purge reads from a job; the scan drops the rest of each row (spec Ruling 39). */
type Scanned = Pick<
	Job,
	| "id"
	| "kind"
	| "status"
	| "createdAt"
	| "lease"
	| "purging"
	| "scheduled"
	| "rollbackOf"
	| "uploadId"
	| "sourceUploadId"
>;
const SCANNED = [
	"id",
	"kind",
	"status",
	"createdAt",
	"lease",
	"purging",
	"scheduled",
	"rollbackOf",
	"uploadId",
	"sourceUploadId",
] as const satisfies readonly (keyof Scanned)[];

function slim(job: Job): Scanned {
	const out: Record<string, unknown> = {};
	for (const key of SCANNED) if (job[key] !== undefined) out[key] = job[key];
	return out as Scanned;
}

/** Counts each method call on `target` against the run's budget (plan Ruling 16). */
function metered<T extends object>(target: T, meter: { used: number }): T {
	return new Proxy(target, {
		get(t, key, receiver) {
			const value = Reflect.get(t, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				meter.used++;
				return Reflect.apply(value, t, args);
			};
		},
	});
}

type JobRows = Pick<KvCollection<unknown>, "query" | "deleteMany">;

/** Deletes a job's rows of one collection; false when it stopped with rows left. */
async function deleteRows(
	rows: JobRows,
	jobId: string,
	count: { n: number },
	left: () => number,
): Promise<boolean> {
	for (;;) {
		// Out of budget: the job stays marked purging and the next run finishes it.
		if (left() <= 0) return false;
		const page = await rows.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return true;
		const n = await rows.deleteMany(page.items.map((i) => i.id));
		count.n += n;
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return false;
	}
}

/**
 * Spec Ruling 41: only these jobs are ever purged. A created, running or paused job is kept
 * however old it is: an agent drives it across many calls, and its journal must stay whole.
 */
const FINISHED: ReadonlySet<JobStatus> = new Set(["completed", "cancelled", "failed"]);

/**
 * Deletes finished jobs created before the cutoff with their record and journal rows, and staged
 * files last modified before it, except files in `keepUploads`. A job with a live lease is left
 * for the next run. An original job stays while a rollback job (real or dry run, in any status)
 * names it in `rollbackOf`, and goes in the same run as that rollback job once both have expired.
 * A job whose rows could not all be deleted stays too, so the next run retries it; a job already
 * marked purging is finished whatever its status. Links are kept: they map source keys to entries
 * across runs.
 *
 * M6b: the scan reads `RETENTION_SCAN_PAGE` rows a page and keeps only the fields it needs; over
 * `RETENTION_SCAN_MAX` rows the run deletes nothing (`skipped`). An open scheduled job and a job a
 * schedule's launch claim names are never purged. With `bounds`, every storage call counts against
 * `bounds.target`: a job's purge starts only with `RETENTION_PRUNE_MIN` calls left, and a run that
 * stops saves the job it stopped at under `RETENTION_CURSOR_KEY`, where the next run starts.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
	keepUploads: ReadonlySet<string> = new Set(),
	bounds?: RetentionBounds,
): Promise<PurgeResult> {
	const now = deps.now();
	const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
	const meter = { used: 0 };
	const target = bounds?.target ?? Number.POSITIVE_INFINITY;
	const left = () => target - meter.used;
	const jobs = metered(deps.jobs, meter);
	const records = metered(deps.records, meter);
	const journal = metered(deps.journal, meter);
	const journalMedia = metered(deps.journalMedia, meter);
	const kv = bounds === undefined ? undefined : metered(bounds.kv, meter);
	const result = (r: PurgeResult): PurgeResult =>
		bounds === undefined ? r : { ...r, queries: meter.used };

	// The full scan behind the keep and held sets (spec Ruling 39).
	const all: Scanned[] = [];
	let cursor: string | undefined;
	do {
		const page = await jobs.query({
			limit: RETENTION_SCAN_PAGE,
			...(cursor ? { cursor } : {}),
		});
		all.push(...page.items.map((i) => slim(i.data)));
		cursor = page.hasMore ? page.cursor : undefined;
		if (cursor && all.length >= RETENTION_SCAN_MAX) {
			return result({ jobs: 0, records: 0, journal: 0, uploads: 0, skipped: all.length });
		}
	} while (cursor);

	// A launch claim's job waits for its launch, an open job for the pump's finalization.
	const claimed = new Set<string>();
	if (bounds !== undefined) {
		const schedules = await metered(bounds.schedules, meter).query({ limit: 100 });
		for (const { data } of schedules.items) if (data.current) claimed.add(data.current.jobId);
	}
	// A job marked purging is committed to deletion: a run that stopped half way (even one from
	// before spec Ruling 41, when any status was purged) is finished.
	const due = (job: Scanned) =>
		(FINISHED.has(job.status) || job.purging === true) &&
		job.createdAt < cutoff &&
		!(job.lease && job.lease.expiresAt > now) &&
		job.scheduled !== "open" &&
		!claimed.has(job.id);
	// Rollback jobs go first (when due), so an original they held can go in the same run.
	const rollbacks = all.filter((job) => job.kind === "rollback");
	const holders = new Map<string, string[]>();
	for (const { id, rollbackOf } of rollbacks) {
		if (rollbackOf !== undefined) holders.set(rollbackOf, [...(holders.get(rollbackOf) ?? []), id]);
	}
	const order = [...rollbacks, ...all.filter((job) => job.kind !== "rollback")].filter(due);
	const saved = kv === undefined ? null : await kv.get<string>(RETENTION_CURSOR_KEY);
	const at = saved === null ? -1 : order.findIndex((job) => job.id === saved);
	const queue = at <= 0 ? order : [...order.slice(at), ...order.slice(0, at)];

	const pruned = new Set<string>();
	const counts = { records: { n: 0 }, journal: { n: 0 } };
	// Marks the job before any of its rows go, so a rollback cannot start on a half-deleted
	// journal; false when the job changed since the scan (it was resumed or retried, took a
	// lease, or a rollback was created for it). The re-check comes first, so even a job already
	// marked purging keeps its rows while a batch holds its lease.
	const markPurging = async (id: string): Promise<boolean> => {
		const current = await jobs.getVersioned(id);
		if (!current || !due(current.value)) return false;
		if (isPurging(current.value)) return true;
		const job = current.value;
		if (job.kind !== "rollback" && job.rolledBackBy !== undefined) {
			if (await jobs.get(job.rolledBackBy)) return false;
		}
		const next: Job = { ...job, purging: true };
		return (await jobs.compareAndSet(id, current.revision, next)).applied;
	};
	/** False only when the budget ran out part way. */
	const prune = async (id: string): Promise<boolean> => {
		if (!(await markPurging(id))) return true;
		const complete =
			(await deleteRows(records, id, counts.records, left)) &&
			(await deleteRows(journal, id, counts.journal, left)) &&
			(await deleteRows(journalMedia, id, counts.journal, left));
		if (!complete) return left() > 0;
		await jobs.delete(id);
		pruned.add(id);
		return true;
	};
	let stopped: string | undefined;
	for (const job of queue) {
		if (left() < RETENTION_PRUNE_MIN) {
			stopped = job.id;
			break;
		}
		// An original stays while a rollback that names it stays.
		if ((holders.get(job.id) ?? []).some((rollback) => !pruned.has(rollback))) continue;
		if (!(await prune(job.id))) {
			stopped = job.id;
			break;
		}
	}
	if (kv !== undefined) {
		if (stopped !== undefined) await kv.set(RETENTION_CURSOR_KEY, stopped);
		else if (saved !== null) await kv.delete(RETENTION_CURSOR_KEY);
	}

	// Surviving jobs still read their source file (and an XLSX job's workbook), however old it is.
	const keep = new Set<string>(keepUploads);
	for (const job of all) {
		if (pruned.has(job.id)) continue;
		// A rollback job names its original's file but never reads it.
		if (job.kind === "rollback") continue;
		keep.add(job.uploadId);
		if (job.sourceUploadId !== undefined) keep.add(job.sourceUploadId);
	}
	return result({
		jobs: pruned.size,
		records: counts.records.n,
		journal: counts.journal.n,
		uploads: await uploads.purgeBefore(new Date(cutoff), keep),
		...(stopped === undefined ? {} : { more: true as const }),
	});
}

/**
 * Schedules `retention` at `RETENTION_SCHEDULE` unless `tasks` (EmDash's `cron.list()`) has it
 * there already; true when it scheduled. A pre-0.4.0 daily task moves to hourly (spec Ruling 39).
 * Shared by `ensureRetentionScheduled` and `reconcile`.
 */
export async function syncRetentionTask(
	cron: Pick<NonNullable<PluginContext["cron"]>, "schedule">,
	tasks: readonly { name: string; schedule: string }[],
): Promise<boolean> {
	if (tasks.find((t) => t.name === RETENTION_TASK)?.schedule === RETENTION_SCHEDULE) return false;
	await cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
	return true;
}

/** Schedules `retention` at `RETENTION_SCHEDULE`; a pre-0.4.0 daily task moves to hourly. */
export async function ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">): Promise<void> {
	if (!ctx.cron) return;
	await syncRetentionTask(ctx.cron, await ctx.cron.list());
}
