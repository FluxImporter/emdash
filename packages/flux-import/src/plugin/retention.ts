import type { KvCollection } from "../engine/ports.js";
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

/** Deletes a job's rows of one collection (records, journal or journalMedia). */
async function deleteRows(rows: JobRows, jobId: string): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await rows.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return deleted;
		const n = await rows.deleteMany(page.items.map((i) => i.id));
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return deleted;
		deleted += n;
	}
}

/** A rollback job that may still run, which needs its original's journal. */
async function rollbackPending(deps: Pick<EngineDeps, "jobs">, job: Job): Promise<boolean> {
	if (job.rolledBackBy === undefined) return false;
	const rollback = await deps.jobs.get(job.rolledBackBy);
	return rollback !== null && ["created", "running", "paused"].includes(rollback.status);
}

/**
 * Deletes jobs created before the cutoff with their record and journal rows, and staged files
 * last modified before it, except files in `keepUploads`. A job with a live lease, or whose
 * rollback job may still run, is left for the next run. Links are kept: they map source keys to
 * entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
	keepUploads: ReadonlySet<string> = new Set(),
): Promise<PurgeResult> {
	const now = deps.now();
	const cutoff = new Date(now - retentionDays * DAY_MS);
	const expired: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.jobs.query({
			where: { createdAt: { lt: cutoff.toISOString() } },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { id, data } of page.items) {
			if (data.lease && data.lease.expiresAt > now) continue;
			if (await rollbackPending(deps, data)) continue;
			expired.push(id);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	let records = 0;
	let journal = 0;
	for (const id of expired) {
		records += await deleteRows(deps.records, id);
		journal += await deleteRows(deps.journal, id);
		journal += await deleteRows(deps.journalMedia, id);
		await deps.jobs.delete(id);
	}

	// Surviving jobs still read their source file (and an XLSX job's workbook), however old it is.
	const keep = new Set<string>(keepUploads);
	cursor = undefined;
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of page.items) {
			// A rollback job names its original's file but never reads it.
			if (data.kind === "rollback") continue;
			keep.add(data.uploadId);
			if (data.sourceUploadId !== undefined) keep.add(data.sourceUploadId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return {
		jobs: expired.length,
		records,
		journal,
		uploads: await uploads.purgeBefore(cutoff, keep),
	};
}
