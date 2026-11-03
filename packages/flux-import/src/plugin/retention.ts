import type { KvCollection } from "../engine/ports.js";
import { isPurging } from "../engine/rollback.js";
import type { EngineDeps, Job } from "../engine/types.js";

export const RETENTION_TASK = "retention";
/** Daily at 03:00 UTC; EmDash evaluates cron expressions in UTC on every host. */
export const RETENTION_SCHEDULE = "0 3 * * *";
export const RETENTION_DAYS_DEFAULT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

export interface PurgeResult {
	jobs: number;
	records: number;
	/** Journal and journalMedia rows (M5a). */
	journal: number;
	uploads: number;
}

/** Deletes staged files older than a cutoff, except upload IDs in `keep`; `EmDashUploads` implements it. */
export interface UploadPurger {
	purgeBefore(cutoff: Date, keep?: ReadonlySet<string>): Promise<number>;
}

type JobRows = Pick<KvCollection<unknown>, "query" | "deleteMany">;

/** Deletes a job's rows of one collection; false when it stopped with rows left. */
async function deleteRows(rows: JobRows, jobId: string, count: { n: number }): Promise<boolean> {
	for (;;) {
		const page = await rows.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return true;
		const n = await rows.deleteMany(page.items.map((i) => i.id));
		count.n += n;
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return false;
	}
}

/**
 * Deletes jobs created before the cutoff with their record and journal rows, and staged files
 * last modified before it, except files in `keepUploads`. A job with a live lease is left for the
 * next run. An original job stays while a rollback job (real or dry run, in any status) names it
 * in `rollbackOf`, and goes in the same run as that rollback job once both have expired. A job
 * whose rows could not all be deleted stays too, so the next run retries it. Links are kept: they
 * map source keys to entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
	keepUploads: ReadonlySet<string> = new Set(),
): Promise<PurgeResult> {
	const now = deps.now();
	const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
	const all: { id: string; data: Job }[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		all.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	const due = (data: Job) => data.createdAt < cutoff && !(data.lease && data.lease.expiresAt > now);
	// Rollback jobs go first (when due), so an original they held can go in the same run.
	const rollbacks = all.filter(({ data }) => data.kind === "rollback");
	const originals = all.filter(({ data }) => data.kind !== "rollback");
	const pruned = new Set<string>();
	const counts = { records: { n: 0 }, journal: { n: 0 } };
	// Marks the job before any of its rows go, so a rollback cannot start on a half-deleted
	// journal; false when the job changed since the scan (a rollback was created for it).
	const markPurging = async (id: string): Promise<boolean> => {
		const current = await deps.jobs.getVersioned(id);
		if (!current) return false;
		if (isPurging(current.value)) return true;
		const job = current.value;
		if (job.kind !== "rollback" && job.rolledBackBy !== undefined) {
			if (await deps.jobs.get(job.rolledBackBy)) return false;
		}
		const next: Job = { ...job, purging: true };
		return (await deps.jobs.compareAndSet(id, current.revision, next)).applied;
	};
	const prune = async (id: string): Promise<void> => {
		if (!(await markPurging(id))) return;
		const complete =
			(await deleteRows(deps.records, id, counts.records)) &&
			(await deleteRows(deps.journal, id, counts.journal)) &&
			(await deleteRows(deps.journalMedia, id, counts.journal));
		if (!complete) return;
		await deps.jobs.delete(id);
		pruned.add(id);
	};
	for (const { id, data } of rollbacks) if (due(data)) await prune(id);
	const held = new Set(
		rollbacks.flatMap(({ id, data }) =>
			!pruned.has(id) && data.rollbackOf !== undefined ? [data.rollbackOf] : [],
		),
	);
	for (const { id, data } of originals) if (due(data) && !held.has(id)) await prune(id);

	// Surviving jobs still read their source file (and an XLSX job's workbook), however old it is.
	const keep = new Set<string>(keepUploads);
	for (const { id, data } of all) {
		if (pruned.has(id)) continue;
		// A rollback job names its original's file but never reads it.
		if (data.kind === "rollback") continue;
		keep.add(data.uploadId);
		if (data.sourceUploadId !== undefined) keep.add(data.sourceUploadId);
	}
	return {
		jobs: pruned.size,
		records: counts.records.n,
		journal: counts.journal.n,
		uploads: await uploads.purgeBefore(new Date(cutoff), keep),
	};
}
