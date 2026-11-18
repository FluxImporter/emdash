/** Due marks and the launch of a scheduled job (M6b spec "Due marks", "Launch"). */
import { Permissions } from "@emdash-cms/auth";
import type { PluginContext } from "emdash";
import { ulid } from "emdash";
import { JobError, JobExistsError, updateJob } from "../engine/jobs.js";
import type { KvCollection } from "../engine/ports.js";
import type { EngineDeps, Job } from "../engine/types.js";
import { type JobRequest, type ResolvedTemplate, resolveJobTemplate } from "./job-templates.js";
import {
	armPump,
	busyJob,
	type CronPort,
	cronOf,
	iso,
	LAUNCH_CLAIM_STALE_MS,
	openJobOf,
	type PauseReason,
	pausedKeeping,
	type ScheduleRow,
	schedulesCollection,
	scheduleTask,
	sourcePinOf,
	UNFINISHED,
	WRITE_ATTEMPTS,
	writeSchedule,
} from "./schedules.js";
import { changeJob, ServiceError, type UploadKeeper, type UploadStore } from "./service.js";
import { createJobFrom, type Services } from "./services.js";
import { clearLastImport, type SkippedJob, type SourceDeps, type SourceRow } from "./sources.js";
import { redact } from "./summaries.js";
import { type SavedTemplate, templatesCollection } from "./templates.js";

/** Transient launch failures in a row before the schedule pauses `fetch_failed` (spec Ruling 14). */
export const LAUNCH_FAILURES_TO_PAUSE = 3;

export interface LaunchDeps {
	schedules: KvCollection<ScheduleRow>;
	jobs: KvCollection<Job>;
	templates: Pick<KvCollection<SavedTemplate>, "get">;
	sources: Pick<KvCollection<SourceRow>, "get">;
	cron: CronPort;
	/** The user's role, or null when there is no such user (`ctx.users.get`, spec Ruling 43). */
	userRole: (id: string) => Promise<number | null>;
	/** `createJobFrom` with the cron task's services (no actor) and the resolved template. */
	create: (request: JobRequest, resolved: ResolvedTemplate) => Promise<Job | SkippedJob>;
	/** `cancelLaunched`: stops a job whose launch lost its claim (preflight F6). */
	cancel: (jobId: string) => Promise<void>;
	/** `ctx.log.warn`: a launch error's message, which never goes on the schedule (spec Ruling 47). */
	warn: (message: string) => void;
	now: () => number;
	newId: () => string;
}

export type LaunchOutcome = "busy" | "in_flight" | "started" | "unchanged" | "failed" | "paused";

/** The pause each launch error code causes; any other code is transient (spec "Launch" step 5). */
const PAUSES: Readonly<Record<string, PauseReason>> = {
	SOURCE_NOT_FOUND: "source_gone",
	NOT_FOUND: "source_gone",
	CREDENTIAL_MISSING: "credential_missing",
	URL_BLOCKED: "url_blocked",
	TOO_LARGE: "too_large",
	INVALID_TEMPLATE: "invalid_template",
	INVALID_OPTIONS: "invalid_template",
	INVALID_SOURCE: "invalid_template",
};

/** What a stored error code may look like: never free text, a URL or a message (spec Ruling 47). */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A launch error's code: a service or route error's, a job error's in capitals, else the error's
 * own `code`; `INTERNAL_ERROR` when there is none or it is not shaped like a code.
 */
export function errorCode(e: unknown): string {
	let code: unknown;
	if (e instanceof ServiceError) code = e.code;
	else if (e instanceof JobError) code = e.code.toUpperCase();
	else if (e instanceof Error) code = (e as { code?: unknown }).code;
	return typeof code === "string" && CODE.test(code) ? code : "INTERNAL_ERROR";
}

/**
 * `schedule-<id>` (spec "Due marks"): marks an enabled schedule due at the event's time and arms
 * the pump; a schedule already due keeps its older mark. A missing or disabled schedule cancels
 * its own task.
 */
export async function markDue(
	deps: Pick<LaunchDeps, "schedules" | "cron">,
	scheduleId: string,
	scheduledAt: string,
): Promise<"marked" | "kept" | "cancelled"> {
	let marked = false;
	let first: { holder: string | undefined } | undefined;
	// One read and one compare-and-set, then the pump: four D1 queries (spec "Due marks").
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await deps.schedules.getVersioned(scheduleId);
		if (!read?.value.enabled) {
			await deps.cron.cancel(scheduleTask(scheduleId));
			return "cancelled";
		}
		// Conditional on the claim the first read saw: a launch that claimed since owns the mark.
		const holder = read.value.current?.jobId;
		first ??= { holder };
		if (holder !== first.holder || read.value.due) break;
		const next = { ...read.value, due: { at: scheduledAt } };
		if ((await deps.schedules.compareAndSet(scheduleId, read.revision, next)).applied) {
			marked = true;
			break;
		}
	}
	await armPump(deps.cron);
	return marked ? "marked" : "kept";
}

/**
 * Step 2 of the launch: claims the schedule for `jobId`. Null when the schedule is gone, disabled
 * or no longer due, or another launch is in flight. A stale claim with no job, or a claim whose
 * job has finished (a launch that crashed after creating it, whose job the pump then drove and
 * finalized), is replaced (plan Ruling 20). A lost compare-and-set re-reads and tries again.
 */
async function claim(deps: LaunchDeps, id: string, jobId: string): Promise<ScheduleRow | null> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await deps.schedules.getVersioned(id);
		if (!read?.value.enabled || !read.value.due) return null;
		const held = read.value.current;
		if (held) {
			const job = await deps.jobs.get(held.jobId);
			const young = deps.now() - Date.parse(held.claimedAt) < LAUNCH_CLAIM_STALE_MS;
			// In flight: a young claim with no job yet, or a claim whose job has not finished.
			if (job === null ? young : UNFINISHED.includes(job.status)) return null;
		}
		const next = { ...read.value, current: { jobId, claimedAt: iso(deps.now()) } };
		if ((await deps.schedules.compareAndSet(id, read.revision, next)).applied) return next;
	}
	return null;
}

/** The row with the launch over: no claim and no due mark (spec "Launch" step 5). */
function released(row: ScheduleRow): ScheduleRow {
	const { current: _current, due: _due, ...rest } = row;
	return rest;
}

/**
 * Step 5: one write, conditional on the claim, that ends the launch: `change` returns the row and
 * the pause, if any, which also cancels the schedule's task. `written` is null when the claim is
 * gone; `pausedNow` is true only when this write disabled an enabled schedule.
 */
async function record(
	deps: LaunchDeps,
	id: string,
	jobId: string,
	change: (row: ScheduleRow) => { row: ScheduleRow; pause?: PauseReason | undefined },
): Promise<{ written: ScheduleRow | null; pausedNow: boolean }> {
	const at = iso(deps.now());
	let wasEnabled = false;
	const written = await writeSchedule(deps.schedules, id, jobId, (current) => {
		wasEnabled = current.enabled;
		const { row, pause } = change(current);
		return pause === undefined ? released(row) : pausedKeeping(row, pause, at);
	});
	if (written !== null && !written.enabled) await deps.cron.cancel(scheduleTask(id));
	return { written, pausedNow: written !== null && wasEnabled && !written.enabled };
}

/**
 * A launch that failed with `code`: a pause when `reason` is set, else one more transient failure,
 * which pauses `fetch_failed` at `LAUNCH_FAILURES_TO_PAUSE` (spec Ruling 14).
 */
async function failed(
	deps: LaunchDeps,
	id: string,
	jobId: string,
	code: string,
	reason: PauseReason | undefined,
): Promise<LaunchOutcome> {
	const lastLaunch = { at: iso(deps.now()), outcome: "failed" as const, errorCode: code };
	const { pausedNow } = await record(deps, id, jobId, (row) => {
		if (reason !== undefined) return { row: { ...row, lastLaunch }, pause: reason };
		const launchFailures = row.launchFailures + 1;
		return {
			row: { ...row, lastLaunch, launchFailures },
			pause: launchFailures >= LAUNCH_FAILURES_TO_PAUSE ? "fetch_failed" : undefined,
		};
	});
	// "paused" only when this write paused it: not when the claim was gone or it was already off.
	return pausedNow ? "paused" : "failed";
}

/** The job option for the schedule's `missing` (spec "Launch" step 4, P6). */
function missingOption(row: ScheduleRow): Pick<JobRequest, "missing"> {
	if (row.missing === undefined || row.missing === "template") return {};
	return { missing: row.missing };
}

type Refusal = { code: string; reason: PauseReason };

/**
 * Step 3: the pinned template and source, and the creator's role. A refusal pauses the schedule
 * before any fetch; an unexpected error is thrown.
 */
async function checkPins(deps: LaunchDeps, row: ScheduleRow): Promise<ResolvedTemplate | Refusal> {
	let resolved: ResolvedTemplate;
	try {
		resolved = await resolveJobTemplate(deps.templates, row.templateId, row.templateRevision);
	} catch (e) {
		const code = errorCode(e);
		if (code === "TEMPLATE_NOT_FOUND") return { code, reason: "template_gone" };
		if (code === "TEMPLATE_CHANGED") return { code, reason: "template_changed" };
		throw e;
	}
	const source = await deps.sources.get(row.sourceId);
	if (source === null) return { code: "SOURCE_NOT_FOUND", reason: "source_gone" };
	if ((await sourcePinOf(source)) !== row.sourcePin) {
		return { code: "SOURCE_CHANGED", reason: "source_changed" };
	}
	const role = await deps.userRole(row.armedBy);
	// Negated, so a role that is not a number fails closed (preflight F18).
	if (!(role !== null && role >= Permissions["import:execute"])) {
		return { code: "CREATOR_GONE", reason: "creator_gone" };
	}
	return resolved;
}

/** Logs a launch error's message, redacted; the schedule keeps its code only (spec Ruling 47). */
function logFailure(deps: LaunchDeps, id: string, code: string, e: unknown): void {
	deps.warn(`flux-import: schedule ${id}: launch failed (${code}): ${messageOf(e)}`);
}

/** One launch of a due schedule (spec "Launch"), the pump's step 4. Never throws for an expected failure. */
export async function launch(deps: LaunchDeps, due: ScheduleRow): Promise<LaunchOutcome> {
	// 1. Busy: any unfinished real import or rollback reading the source (spec Ruling 33), or the
	// schedule's own job until the pump finalizes it, whatever its status (spec Ruling 87).
	const busy = (await busyJob(deps.jobs, due.sourceId)) ?? (await openJobOf(deps.jobs, due.id));
	if (busy !== null) {
		const lastLaunch = { at: iso(deps.now()), outcome: "busy" as const, jobId: busy.id };
		// Only over the mark this launch was for: a launch that consumed it keeps its record.
		await writeSchedule(deps.schedules, due.id, due.current?.jobId, (r) => {
			const { due: mark, ...rest } = r;
			return mark ? { ...rest, lastLaunch } : null;
		});
		return "busy";
	}
	// 2. Claim.
	const jobId = deps.newId();
	const row = await claim(deps, due.id, jobId);
	if (row === null) return "in_flight";
	// 3. Pins and creator, each a pause before any fetch.
	let resolved: ResolvedTemplate;
	try {
		const checked = await checkPins(deps, row);
		if ("reason" in checked) return failed(deps, row.id, jobId, checked.code, checked.reason);
		resolved = checked;
	} catch (e) {
		// A storage error, or a template error other than the two: transient, and the claim goes.
		const code = errorCode(e);
		logFailure(deps, row.id, code, e);
		return failed(deps, row.id, jobId, code, undefined);
	}
	// 4. Create, as jobs/create { sourceId, templateId } does, under the claimed ID.
	const request: JobRequest = {
		id: jobId,
		sourceId: row.sourceId,
		templateId: row.templateId,
		templateRevision: row.templateRevision,
		dryRun: false,
		force: row.due?.force === true,
		origin: "schedule",
		scheduleId: row.id,
		scheduled: "open",
		feedSourceId: row.sourceId,
		publish: row.publish,
		batchSize: row.batchSize,
		budgetMs: row.budgetMs,
		journal: true,
		...missingOption(row),
	};
	let result: Job | SkippedJob;
	try {
		result = await deps.create(request, resolved);
	} catch (e) {
		// An overlapping launch under the same claim created the job first (spec F19).
		const existing = e instanceof JobExistsError ? await deps.jobs.get(e.id) : null;
		if (existing === null) {
			const code = errorCode(e);
			logFailure(deps, row.id, code, e);
			return failed(deps, row.id, jobId, code, PAUSES[code]);
		}
		result = existing;
	}
	// 5. Record.
	const at = iso(deps.now());
	if ("skipped" in result) {
		const lastLaunch = { at, outcome: "unchanged" as const };
		await record(deps, row.id, jobId, (r) => ({ row: { ...r, lastLaunch, launchFailures: 0 } }));
		return "unchanged";
	}
	const lastLaunch = { at, outcome: "started" as const, jobId: result.id };
	const { written } = await record(deps, row.id, jobId, (r) => ({
		row: { ...r, lastLaunch, launchFailures: 0 },
	}));
	if (written === null) await dropOrphan(deps, row.id, jobId, result.id);
	return "started";
}

/**
 * The claim was gone when the launch came to record its job (preflight F6): a pause, a rollback or
 * a newer launch took the schedule while the feed was fetched. The job is cancelled so it never
 * runs beside them. Only when the claim is really gone: a write that lost every attempt leaves
 * the claim, and the job, for the next launch to find.
 */
async function dropOrphan(
	deps: LaunchDeps,
	id: string,
	claimed: string,
	jobId: string,
): Promise<void> {
	const newest = await deps.schedules.get(id);
	if (newest?.current?.jobId === claimed) return;
	const lost = `flux-import: schedule ${id}: the launch lost its claim;`;
	try {
		await deps.cancel(jobId);
		deps.warn(`${lost} cancelled job ${jobId}`);
	} catch (e) {
		if (e instanceof JobCloseError) {
			deps.warn(`${lost} cancelled job ${jobId}, which could not be closed: ${messageOf(e.cause)}`);
		} else {
			deps.warn(`${lost} job ${jobId} was not cancelled: ${messageOf(e)}`);
		}
	}
}

/** An error's message for the log, redacted. */
function messageOf(e: unknown): string {
	return redact(e instanceof Error ? e.message : String(e));
}

/** `cancelLaunched` cancelled the job but could not close it; finalization will see it. */
export class JobCloseError extends Error {
	constructor(
		readonly jobId: string,
		cause: unknown,
	) {
		super(`Job ${jobId} was cancelled but not closed`, { cause });
		this.name = "JobCloseError";
	}
}

/**
 * Cancels a job whose launch lost its claim, as `jobs/cancel` does (its file released and the
 * source's `lastImport` cleared, so the same content imports next time), then closes it, so
 * finalization neither logs it as a run nor pauses the schedule over it. A job that has finished
 * meanwhile is refused by the cancel and left open for finalization. A close that fails after
 * the cancel throws `JobCloseError`.
 */
export async function cancelLaunched(
	services: {
		deps: EngineDeps;
		uploads: UploadStore;
		keep: UploadKeeper;
		sources: Pick<SourceDeps, "sources">;
	},
	jobId: string,
): Promise<void> {
	const job = await changeJob(services.deps, services.uploads, jobId, "cancel", services.keep);
	if (job.sourceId !== undefined) {
		await clearLastImport(services.sources, job.sourceId, job.id).catch(() => {});
	}
	try {
		await updateJob(services.deps, jobId, (j) => ({ ...j, scheduled: "closed" }));
	} catch (e) {
		throw new JobCloseError(jobId, e);
	}
}

/**
 * The creator check's lookup over `ctx.users` (spec Ruling 43). Without the API it answers null,
 * so the schedule pauses `creator_gone` and the claim goes (preflight F18). EmDash returns a
 * disabled user with the role unchanged, so a disabled creator passes (spec F13, an open issue).
 */
export function userRoleOf(
	users: PluginContext["users"],
	warn: (message: string) => void,
): (id: string) => Promise<number | null> {
	return async (id) => {
		if (!users) {
			warn("flux-import: ctx.users is not available (users:read); the creator check fails");
			return null;
		}
		return (await users.get(id))?.role ?? null;
	};
}

/** The launch's dependencies in a cron task (spec "Cron tasks and the hook"). */
export function launchDeps(ctx: PluginContext, services: Services): LaunchDeps {
	const warn = (message: string) => ctx.log.warn(message);
	return {
		schedules: schedulesCollection(ctx.storage),
		jobs: services.deps.jobs,
		templates: templatesCollection(ctx.storage),
		sources: services.sources.sources,
		cron: cronOf(ctx),
		userRole: userRoleOf(ctx.users, warn),
		create: (request, resolved) => createJobFrom(ctx, services, request, resolved),
		cancel: (jobId) => cancelLaunched(services, jobId),
		warn,
		now: Date.now,
		newId: () => ulid(),
	};
}
