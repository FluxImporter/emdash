/** The pump (M6b spec "The pump", Ruling 35): finalize, then one batch, else one launch. */
import type { PluginContext } from "emdash";
import { type Fence, readFence } from "../emdash/fence.js";
import { onWorkers } from "../emdash/workers.js";
import type { KvCollection } from "../engine/ports.js";
import type { Job, JobStatus } from "../engine/types.js";
import { type LaunchDeps, type LaunchOutcome, launch, launchDeps } from "./launch.js";
import {
	armPump,
	iso,
	MAX_SCHEDULES,
	type PauseReason,
	PUMP_TASK,
	pausedKeeping,
	RUN_LOG_SIZE,
	type RunEntry,
	type ScheduleRow,
	scheduleTask,
	UNFINISHED,
	WRITE_ATTEMPTS,
	writeSchedule,
} from "./schedules.js";
import { nextBatch, tickLimits } from "./service.js";
import type { Services } from "./services.js";
import { clearLastImport } from "./sources.js";
import { redact } from "./summaries.js";

/** Finished scheduled jobs finalized per tick (spec Ruling 37). */
export const FINALIZE_PER_TICK = 2;
const FINISHED: readonly JobStatus[] = ["completed", "failed", "cancelled"];
/** The unfinished statuses a batch moves on; a paused job waits for an Admin (spec "The pump"). */
const ACTIVE: readonly JobStatus[] = UNFINISHED.filter((status) => status !== "paused");

export interface PumpDeps extends LaunchDeps {
	/** The site fence (spec Ruling 19). */
	fence: () => Promise<Fence>;
	/** `nextBatch` at the tick's limits: one batch, the staged file released when the job ends. */
	batch: (id: string, holder: string) => Promise<Job>;
	/** `clearLastImport`, so a failed job's content runs again once fixed (spec Ruling 15). */
	clearLastImport: (sourceId: string, jobId: string) => Promise<void>;
	/** `ctx.log.error`. */
	error: (message: string) => void;
}

/** What one tick did, for the hook's log and the tests. */
export interface PumpTick {
	fence: Fence;
	finalized: string[];
	/** Open jobs no schedule launched, closed without a run or a batch (preflight F8). */
	closed?: string[];
	batch?: string;
	launch?: { scheduleId: string; outcome: LaunchOutcome };
	idle?: "cancelled" | "rearmed";
}

/** The run log outcome of a finished job and its pause (spec "Finalization", plan Ruling 8). */
function verdictOf(job: Job): { outcome: RunEntry["outcome"]; pause?: PauseReason } {
	if (job.status === "failed") return { outcome: "failed", pause: "job_failed" };
	if (job.status === "cancelled") return { outcome: "cancelled", pause: "cancelled" };
	// The first pass read no record: the engine skipped the missing phase (Fact E2).
	if ((job.missing?.fromSeq ?? job.cursor.seq) === 0) {
		return { outcome: "empty_feed", pause: "empty_feed" };
	}
	if (job.missing?.verdict === "refused") {
		return { outcome: "missing_refused", pause: "missing_refused" };
	}
	return { outcome: "completed" };
}

function countersOf(job: Job): RunEntry["counters"] {
	const c = job.counters;
	return {
		created: c.created,
		updated: c.updated,
		unchanged: c.unchanged,
		failed: c.failed,
		conflict: c.conflict,
		locked: c.locked,
		removed: c.removed ?? 0,
	};
}

/**
 * Writes the run log entry (at the head, `RUN_LOG_SIZE` kept) and the pause `pauseOf` gives for
 * the newest row, conditional on `current?.jobId` (spec Ruling 34). A pause already on the row
 * stays (`pausedKeeping`). `orphan` rows get nothing written. True when the entry is recorded,
 * was already there, the job is an orphan or the schedule is gone; false when the write lost, so
 * the next tick finalizes the job again.
 */
async function recordRun(
	deps: PumpDeps,
	scheduleId: string,
	entry: RunEntry,
	pauseOf: (row: ScheduleRow) => PauseReason | undefined,
	orphan: (row: ScheduleRow) => boolean,
): Promise<boolean> {
	const row = await deps.schedules.get(scheduleId);
	if (row === null) return true;
	const at = iso(deps.now());
	let already = false;
	let pausing = false;
	const written = await writeSchedule(deps.schedules, scheduleId, row.current?.jobId, (r) => {
		const old = r.runs.find((run) => run.jobId === entry.jobId);
		if (old !== undefined && JSON.stringify(old) === JSON.stringify(entry)) {
			already = true;
			return null;
		}
		if (old === undefined && orphan(r)) {
			already = true;
			return null;
		}
		const runs = [entry, ...r.runs.filter((run) => run.jobId !== entry.jobId)].slice(
			0,
			RUN_LOG_SIZE,
		);
		const reason = pauseOf(r);
		pausing = reason !== undefined;
		return reason === undefined
			? { ...r, runs }
			: pausedKeeping({ ...r, runs }, reason, at, entry.jobId);
	});
	if (written !== null && pausing) {
		// A side effect of a write that succeeded (preflight F11): reconciliation repairs the task.
		try {
			await deps.cron.cancel(scheduleTask(scheduleId));
		} catch (e) {
			deps.warn(`flux-import: schedule ${scheduleId}: cancelling its task failed: ${messageOf(e)}`);
		}
	}
	return already || written !== null;
}

/** An error's message for the log, redacted. */
function messageOf(e: unknown): string {
	return redact(e instanceof Error ? e.message : String(e));
}

/**
 * Closes the job while it is still open: only while it is finished too when `finishedOnly` (a
 * retry may have restarted it), whatever its status otherwise.
 */
async function close(jobs: KvCollection<Job>, id: string, finishedOnly: boolean): Promise<void> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await jobs.getVersioned(id);
		if (read?.value.scheduled !== "open") return;
		if (finishedOnly && !FINISHED.includes(read.value.status)) return;
		const next: Job = { ...read.value, scheduled: "closed" };
		if ((await jobs.compareAndSet(id, read.revision, next)).applied) return;
	}
}

/**
 * An open job no schedule launched (preflight F8, spec Ruling 22): the pump never drives it nor
 * logs it as a run; it is closed so it no longer keeps the pump busy.
 */
async function closeForeign(deps: PumpDeps, tick: PumpTick, job: Job): Promise<void> {
	await close(deps.jobs, job.id, false);
	deps.warn(
		`flux-import: job ${job.id} is open to the pump but no schedule launched it; closed without a run`,
	);
	tick.closed = [...(tick.closed ?? []), job.id];
}

/**
 * Finalizes one finished scheduled job (spec "Finalization", plan Rulings 11, 12). The pause of a
 * cancel or a rollback repeats the route's (a lost best-effort write is repaired) only while the
 * schedule has not been changed by a route since the job was (preflight F10): an Admin who
 * re-enabled it after the route's pause is not overridden. The rollback repair works only when
 * the rollback comes before finalization (preflight F20); after it, `jobs/rollback` alone pauses.
 */
async function finalize(deps: PumpDeps, job: Job): Promise<void> {
	const { outcome, pause } = verdictOf(job);
	let rolledBack: RunEntry["rolledBack"];
	if (job.rolledBackBy !== undefined) {
		const rollback = await deps.jobs.get(job.rolledBackBy);
		rolledBack = { by: job.rolledBackBy, at: rollback?.createdAt ?? job.updatedAt };
	}
	const entry: RunEntry = {
		jobId: job.id,
		at: job.updatedAt,
		outcome,
		counters: countersOf(job),
		...(rolledBack === undefined ? {} : { rolledBack }),
	};
	const reason = rolledBack === undefined ? pause : "rolled_back";
	const repeated = reason === "cancelled" || reason === "rolled_back";
	const pauseOf = (row: ScheduleRow) =>
		repeated && Date.parse(row.updatedAt) > Date.parse(job.updatedAt) ? undefined : reason;
	// Review 5: a cancelled job while another launch's claim stands, never logged as a run, is
	// the orphan of a launch that lost its claim (`cancelLaunched` cancelled it but did not
	// close it yet): it is closed with no run and no pause, which would drop the newer claim.
	const orphan = (row: ScheduleRow) =>
		job.status === "cancelled" && row.current !== undefined && row.current.jobId !== job.id;
	const scheduleId = job.scheduleId;
	if (scheduleId !== undefined && !(await recordRun(deps, scheduleId, entry, pauseOf, orphan))) {
		return;
	}
	const sourceId = job.sourceId;
	if (job.status === "failed" && sourceId !== undefined) {
		try {
			await deps.clearLastImport(sourceId, job.id);
		} catch (e) {
			deps.warn(
				`flux-import: scheduled job ${job.id}: clearing source ${sourceId}'s last import failed: ${messageOf(e)}`,
			);
		}
	}
	await close(deps.jobs, job.id, true);
}

/** The enabled schedules with a due mark, the oldest mark first (plan Ruling 6). */
async function dueSchedules(schedules: KvCollection<ScheduleRow>): Promise<ScheduleRow[]> {
	const rows = (await schedules.query({ limit: MAX_SCHEDULES })).items.map((i) => i.data);
	const at = (row: ScheduleRow) => row.due?.at ?? "";
	return rows
		.filter((row) => row.enabled && row.due !== undefined)
		.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

/** One pump tick (spec "The pump"). An expected failure is recorded, never thrown. */
export async function pumpTick(deps: PumpDeps): Promise<PumpTick> {
	// 1. Stand down while the site is fenced.
	const fence = await deps.fence();
	const tick: PumpTick = { fence, finalized: [] };
	if (fence !== "clear") return tick;
	// 2. Finalize, bounded.
	const done = await deps.jobs.query({
		where: { scheduled: "open", status: { in: [...FINISHED] } },
		limit: FINALIZE_PER_TICK,
	});
	for (const { data } of done.items) {
		if (data.origin !== "schedule") {
			await closeForeign(deps, tick, data);
			continue;
		}
		await finalize(deps, data);
		tick.finalized.push(data.id);
	}
	// 3. One batch of the oldest open job, unless an Admin's call holds its lease (plan Ruling 4).
	const active = await deps.jobs.query({
		where: { scheduled: "open", status: { in: [...ACTIVE] } },
		orderBy: { createdAt: "asc" },
		limit: 1,
	});
	const oldest = active.items[0]?.data;
	if (oldest !== undefined && oldest.origin !== "schedule") {
		// Closing it is the tick's unit; the next tick looks again.
		await closeForeign(deps, tick, oldest);
		return tick;
	}
	if (oldest !== undefined && !(oldest.lease !== null && oldest.lease.expiresAt > deps.now())) {
		const holder = `schedule:${oldest.scheduleId ?? "none"}:${deps.newId()}`;
		try {
			await deps.batch(oldest.id, holder);
		} catch (e) {
			// The engine has already noted it on the job (P3); the batch was the tick's unit.
			deps.error(`flux-import: scheduled job ${oldest.id}: batch failed: ${messageOf(e)}`);
		}
		tick.batch = oldest.id;
		return tick;
	}
	// 4. At most one launch.
	const [due] = await dueSchedules(deps.schedules);
	if (due !== undefined) {
		tick.launch = { scheduleId: due.id, outcome: await launch(deps, due) };
		return tick;
	}
	// 5. Idle: cancel, then re-arm if a schedule became due meanwhile (spec Ruling 36).
	if (tick.finalized.length > 0) return tick;
	const open = (await deps.jobs.query({ where: { scheduled: "open" }, limit: 1 })).items[0]?.data;
	if (open !== undefined && open.origin !== "schedule") {
		// Review 6: a paused job no schedule launched is closed here, so the pump can idle.
		await closeForeign(deps, tick, open);
		return tick;
	}
	if (open === undefined) {
		await deps.cron.cancel(PUMP_TASK);
		tick.idle = "cancelled";
		if ((await dueSchedules(deps.schedules)).length > 0) {
			await armPump(deps.cron);
			tick.idle = "rearmed";
		}
	}
	return tick;
}

/** The pump's dependencies in the cron hook, with the scheduled (actorless) services. */
export function pumpDeps(ctx: PluginContext, services: Services): PumpDeps {
	return {
		...launchDeps(ctx, services),
		fence: () => readFence(services.runtime.db),
		batch: (id, holder) =>
			nextBatch(
				services.deps,
				services.uploads,
				id,
				holder,
				services.keep,
				tickLimits(onWorkers()),
			),
		clearLastImport: (sourceId, jobId) => clearLastImport(services.sources, sourceId, jobId),
		error: (message) => ctx.log.error(message),
	};
}
