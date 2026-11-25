import type { KvCollection } from "../engine/ports.js";
import type { EngineDeps, Job, JobStatus } from "../engine/types.js";
import { metered, purgeJob } from "./retention.js";
import { releaseFiles, type UploadKeeper, type UploadStore } from "./service.js";
import { latestSourceUploads, type SourceRow } from "./sources.js";
import type { ClearDryRunsReply } from "./summaries.js";

/** Dry runs one `jobs/clear-dry-runs` call scans, oldest first (plan Ruling 6). */
export const CLEAR_PAGE = 20;
/** Storage calls one call may make, the scan included (plan Ruling 6, as retention's budget). */
export const CLEAR_QUERY_TARGET = 150;
/** A dry run's purge, or the release of its files, starts only with this many calls left. */
export const CLEAR_CALL_MIN = 10;
/**
 * A wizard dry run (or a dry rollback) untouched this long is clearable whatever its status; a
 * dry run's staged file is released only once it has been idle this long, so a Preview still
 * open in another tab keeps a working Run (plan Ruling 6).
 */
export const DRY_RUN_IDLE_MS = 3_600_000;
/** An agent's dry run, never started, is clearable once untouched this long (plan Ruling 6). */
export const AGENT_DRY_RUN_IDLE_MS = 86_400_000;

const FINISHED: ReadonlySet<JobStatus> = new Set(["completed", "cancelled", "failed"]);

/**
 * Plan Ruling 6: a dry run with no live lease (checked first, F15) that is either an agent's
 * (`jobs/plan`), never started (`startedAs`) and idle `AGENT_DRY_RUN_IDLE_MS`, or any other dry
 * run (dry rollbacks included) that finished or has been idle `DRY_RUN_IDLE_MS`. A dry run
 * already marked purging is committed to deletion, so a purge cut short is finished.
 */
export function clearable(job: Job, now: number): boolean {
	if (!job.dryRun) return false;
	if (job.lease && job.lease.expiresAt > now) return false;
	if (job.purging === true) return true;
	const idle = now - Date.parse(job.updatedAt);
	if (job.origin === "agent") {
		return job.startedAs === undefined && idle >= AGENT_DRY_RUN_IDLE_MS;
	}
	return FINISHED.has(job.status) || idle >= DRY_RUN_IDLE_MS;
}

/**
 * `jobs/clear-dry-runs` (M7b, plan Ruling 6): scans `CLEAR_PAGE` dry runs oldest first by the
 * `["dryRun", "createdAt"]` index and deletes the clearable ones with retention's per-job purge,
 * every storage call counted against `CLEAR_QUERY_TARGET`. A real job is never read; the purge
 * re-checks each dry run on its current row, so a `jobs/start` claim or a lease taken since the
 * scan keeps it. A cleared dry run's files go once it has been idle `DRY_RUN_IDLE_MS`, unless
 * another job may still read them or a URL source's latest fetch holds them; best effort, and only
 * while the budget allows, since retention removes a file left here.
 *
 * The cursor is the last scanned row's `createdAt`, not a storage cursor: EmDash's cursor names a
 * row, and that row is usually one this call deleted (preflight F1). Rows created in the same
 * millisecond as that row are passed over until a call starts again without a cursor. A call cut
 * short by the budget answers `more` without a cursor, so the next one starts over and finishes
 * the dry run left marked purging.
 */
export async function clearDryRuns(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadStore,
	/** The URL sources, whose latest fetches stay (read once per call, when a file is released). */
	sources: KvCollection<SourceRow>,
	cursor?: string,
): Promise<ClearDryRunsReply> {
	const meter = { used: 0 };
	const left = () => CLEAR_QUERY_TARGET - meter.used;
	const m = {
		jobs: metered(deps.jobs, meter),
		records: metered(deps.records, meter),
		journal: metered(deps.journal, meter),
		journalMedia: metered(deps.journalMedia, meter),
	};
	let latest: Set<string> | undefined;
	const keep: UploadKeeper = async (uploadId) => {
		latest ??= await latestSourceUploads(metered(sources, meter));
		return latest.has(uploadId);
	};
	const now = deps.now();
	const page = await m.jobs.query({
		where: { dryRun: true, ...(cursor ? { createdAt: { gt: cursor } } : {}) },
		orderBy: { createdAt: "asc" },
		limit: CLEAR_PAGE,
	});
	let cleared = 0;
	for (const { data } of page.items) {
		if (!clearable(data, now)) continue;
		if (left() < CLEAR_CALL_MIN) return { cleared, more: true };
		const ended = await purgeJob(m, data.id, (job) => clearable(job, now), { left });
		if (ended === "out") return { cleared, more: true };
		if (ended !== "purged") continue;
		cleared++;
		// Plan Ruling 6: a fresher dry run's file stays for an open Preview's Run.
		if (now - Date.parse(data.updatedAt) < DRY_RUN_IDLE_MS) continue;
		if (left() < CLEAR_CALL_MIN) continue;
		await releaseFiles({ jobs: m.jobs }, uploads, data, keep).catch(() => false);
	}
	const last = page.items.at(-1);
	return page.hasMore && last
		? { cleared, more: true, cursor: last.data.createdAt }
		: { cleared, more: false };
}
