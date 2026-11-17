/** Schedules (M6b): rows, checks, the route services, scheduler writes and reconciliation. */
import type { PluginContext, StorageCollection } from "emdash";
import { kvCollection } from "../emdash/storage.js";
import { fingerprint } from "../engine/fingerprints.js";
import type { KvCollection } from "../engine/ports.js";
import type { Template } from "../engine/template.js";
import { type Job, MISSING_MAX_PERCENT_DEFAULT } from "../engine/types.js";
import { CRON_RULE, cronProblem } from "./cron-syntax.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type Page, page, ServiceError } from "./service.js";
import type { SourceRow } from "./sources.js";
import { assertRevision, staleRevision, templateNotFound } from "./template-errors.js";
import {
	assertNameFreeIn,
	readSavedTemplate,
	type SavedTemplate,
	templateForSave,
} from "./templates.js";

/** One page holds every schedule for the pump and the list (spec Ruling 17). */
export const MAX_SCHEDULES = 20;
/** Run log entries kept per schedule, newest first (spec Ruling 42). */
export const RUN_LOG_SIZE = 20;
/** Attempts of a compare-and-set loop on a schedule row (spec "Writes"). */
export const WRITE_ATTEMPTS = 5;
/** A claim older than this with no job is a crashed launch (EmDash's stale-lock time, spec F6). */
export const LAUNCH_CLAIM_STALE_MS = 600_000;
export const PUMP_TASK = "pump";
export const PUMP_SCHEDULE = "*/10 * * * * *";
export const SCHEDULE_DEFAULTS = { publish: true, batchSize: 50, budgetMs: 4_000 } as const;

export type ScheduleMissing = false | "template" | { maxPercent: number };

export type PauseReason =
	| "template_gone"
	| "template_changed"
	| "source_gone"
	| "source_changed"
	| "creator_gone"
	| "invalid_template"
	| "credential_missing"
	| "url_blocked"
	| "too_large"
	| "fetch_failed"
	| "job_failed"
	| "cancelled"
	| "rolled_back"
	| "missing_refused"
	| "empty_feed";

export interface RunEntry {
	jobId: string;
	/** When the job finished (its `updatedAt`). */
	at: string;
	outcome: "completed" | "failed" | "cancelled" | "missing_refused" | "empty_feed";
	counters: {
		created: number;
		updated: number;
		unchanged: number;
		failed: number;
		conflict: number;
		locked: number;
		removed: number;
	};
	/** The rollback job and when it was made (spec Ruling 42). */
	rolledBack?: { by: string; at: string };
}

export interface ScheduleRow {
	id: string;
	name: string;
	templateId: string;
	templateRevision: number;
	sourceId: string;
	/** `sourcePinOf` the source when the schedule was armed (spec Ruling 40). */
	sourcePin: string;
	cron: string;
	publish: boolean;
	batchSize: number;
	/** Wall time per batch (spec Ruling 16). */
	budgetMs: number;
	/** Set exactly when the template has `rules.missing` (spec Ruling 12). */
	missing?: ScheduleMissing;
	enabled: boolean;
	pause?: { reason: PauseReason; at: string; jobId?: string };
	/** Set by `schedule-<id>` and `schedules/run`; consumed by a launch (spec Ruling 35). */
	due?: { at: string; force?: true };
	/** The launch claim only: set before the fetch, cleared once the launch ends (spec Ruling 38). */
	current?: { jobId: string; claimedAt: string };
	lastLaunch?: {
		at: string;
		outcome: "started" | "unchanged" | "busy" | "failed";
		jobId?: string;
		/** Codes only, never messages (spec Ruling 47). */
		errorCode?: string;
	};
	runs: RunEntry[];
	launchFailures: number;
	/** The user of the last create or update that enabled the schedule (spec Ruling 43). */
	armedBy: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	updatedBy: string;
}

/** What the routes return: the row and its task's next run (`null` while disabled). */
export type ScheduleView = ScheduleRow & { nextRunAt: string | null };

/** `ctx.cron` (spec F1); always present in EmDash 1.2.0. */
export type CronPort = NonNullable<PluginContext["cron"]>;
type CronTask = Awaited<ReturnType<CronPort["list"]>>[number];

export interface ScheduleDeps {
	schedules: KvCollection<ScheduleRow>;
	jobs: KvCollection<Job>;
	templates: Pick<KvCollection<SavedTemplate>, "get">;
	sources: Pick<KvCollection<SourceRow>, "get">;
	cron: CronPort;
	/** The site problems of a template (M6a `siteCheck`), for the route's site. */
	templateProblems: (template: Template) => Promise<string[]>;
	now: () => number;
	newId: () => string;
}

export interface CreateScheduleInput {
	name: string;
	templateId: string;
	templateRevision: number;
	sourceId: string;
	cron: string;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
	missing?: ScheduleMissing | undefined;
	enabled?: boolean | undefined;
}

export interface UpdateScheduleInput {
	id: string;
	revision: number;
	name?: string | undefined;
	templateId?: string | undefined;
	templateRevision?: number | undefined;
	sourceId?: string | undefined;
	cron?: string | undefined;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
	/** `null` removes it (only for a template without `rules.missing`). */
	missing?: ScheduleMissing | null | undefined;
	enabled?: boolean | undefined;
}

const TASK_PREFIX = "schedule-";
const PAGE = 20;
const UNFINISHED = ["created", "running", "paused"];
const iso = (ms: number) => new Date(ms).toISOString();

export const scheduleTask = (id: string): string => `${TASK_PREFIX}${id}`;

export function scheduleIdOf(task: string): string | null {
	return task.startsWith(TASK_PREFIX) ? task.slice(TASK_PREFIX.length) : null;
}

/** The `schedules` storage collection declared in the plugin definition. */
export function schedulesCollection(
	storage: Record<string, StorageCollection | undefined>,
): KvCollection<ScheduleRow> {
	if (!storage.schedules)
		throw new Error("flux-import: the schedules storage collection is missing");
	return kvCollection<ScheduleRow>(storage.schedules);
}

export function cronOf(ctx: Pick<PluginContext, "cron">): CronPort {
	if (!ctx.cron) throw new Error("flux-import: EmDash's cron API is not available");
	return ctx.cron;
}

/** Schedules (or re-arms) the pump; an upsert (spec F3). */
export function armPump(cron: CronPort): Promise<void> {
	return cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
}

/** The pin of a source: its URL and credential name (spec Ruling 40). */
export function sourcePinOf(source: Pick<SourceRow, "url" | "credential">): Promise<string> {
	return fingerprint({ url: source.url, credential: source.credential ?? null });
}

const notFound = (id: string) => new ServiceError("NOT_FOUND", `Schedule ${id} not found`, 404);

const busy = (id: string, jobId: string) =>
	new ServiceError(
		"SCHEDULE_BUSY",
		`Schedule ${id} is busy with job ${jobId}; wait for it to finish or cancel it`,
		409,
		{ jobId },
	);

const keptChanging = () =>
	new ServiceError("CONFLICT", "The schedule kept changing; try again", 409);

/** `SCHEDULE_CHANGED`, as templates answer `TEMPLATE_CHANGED` (M6a Ruling 6). */
function assertScheduleRevision(row: ScheduleRow, revision: number): void {
	if (row.revision !== revision) throw staleRevision("Schedule", row.id, row.revision, revision);
}

/**
 * The unfinished real import or rollback that reads `sourceId`'s data, if any (spec Ruling 33).
 * Dry runs never make a schedule busy; they are skipped here, not in the query (plan Ruling 2).
 */
export async function busyJob(jobs: KvCollection<Job>, sourceId: string): Promise<Job | null> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { feedSourceId: sourceId, status: { in: UNFINISHED } },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		const real = result.items.find((i) => !i.data.dryRun);
		if (real) return real.data;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return null;
}

/** A job the schedule launched that the pump has not finalized yet. */
export async function openJobOf(jobs: KvCollection<Job>, scheduleId: string): Promise<Job | null> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { scheduled: "open" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		const mine = result.items.find((i) => i.data.scheduleId === scheduleId);
		if (mine) return mine.data;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return null;
}

export async function anyOpenJob(jobs: KvCollection<Job>): Promise<boolean> {
	return (await jobs.query({ where: { scheduled: "open" }, limit: 1 })).items.length > 0;
}

/** The job that keeps a route from changing the schedule: a launch in flight or an open job (plan Ruling 7). */
async function routeBusy(deps: ScheduleDeps, row: ScheduleRow): Promise<string | null> {
	const claim = row.current;
	if (claim && deps.now() - Date.parse(claim.claimedAt) < LAUNCH_CLAIM_STALE_MS) return claim.jobId;
	return (await openJobOf(deps.jobs, row.id))?.id ?? null;
}

/**
 * A scheduler write (spec Rulings 34, 46): applies `change` to the newest row while
 * `current?.jobId` is still `expected`, retrying a lost compare-and-set. `revision` is left alone.
 * Null when the row is gone, `current` changed, `change` returned null or every attempt lost.
 */
export async function writeSchedule(
	schedules: KvCollection<ScheduleRow>,
	id: string,
	expected: string | undefined,
	change: (row: ScheduleRow) => ScheduleRow | null,
): Promise<ScheduleRow | null> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await schedules.getVersioned(id);
		if (!read || read.value.current?.jobId !== expected) return null;
		const next = change(read.value);
		if (next === null) return null;
		if ((await schedules.compareAndSet(id, read.revision, next)).applied) return next;
	}
	return null;
}

/** The row paused: disabled with the reason; the claim and the due mark go (plan Ruling 6). */
export function paused(
	row: ScheduleRow,
	reason: PauseReason,
	at: string,
	jobId?: string,
): ScheduleRow {
	const { current: _current, due: _due, ...rest } = row;
	return {
		...rest,
		enabled: false,
		pause: { reason, at, ...(jobId === undefined ? {} : { jobId }) },
	};
}

/** Marks a run log entry rolled back (spec Ruling 42). */
export function withRollback(row: ScheduleRow, jobId: string, by: string, at: string): ScheduleRow {
	return {
		...row,
		runs: row.runs.map((r) => (r.jobId === jobId ? { ...r, rolledBack: { by, at } } : r)),
	};
}

/**
 * Pauses a schedule from a route (spec Ruling 32: a cancel or rollback of its job), then cancels
 * its task; `mark` changes the row further. False when the row is gone or every attempt lost.
 */
export async function pauseSchedule(
	deps: Pick<ScheduleDeps, "schedules" | "cron" | "now">,
	id: string,
	reason: PauseReason,
	jobId: string,
	mark: (row: ScheduleRow) => ScheduleRow = (row) => row,
): Promise<boolean> {
	const at = iso(deps.now());
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await deps.schedules.getVersioned(id);
		if (!read) return false;
		const next = mark(paused(read.value, reason, at, jobId));
		if ((await deps.schedules.compareAndSet(id, read.revision, next)).applied) {
			await deps.cron.cancel(scheduleTask(id));
			return true;
		}
	}
	return false;
}

/**
 * Reopens a finalized scheduled job that an Admin resumed or retried, and arms the pump, so the
 * pump drives it again (spec Ruling 38, plan Ruling 11). No-op for any other job.
 */
export async function reopenScheduled(
	jobs: KvCollection<Job>,
	cron: CronPort,
	id: string,
): Promise<void> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await jobs.getVersioned(id);
		if (read?.value.origin !== "schedule" || read.value.scheduled !== "closed") return;
		if (
			(await jobs.compareAndSet(id, read.revision, { ...read.value, scheduled: "open" })).applied
		) {
			await armPump(cron);
			return;
		}
	}
}

export function viewOf(row: ScheduleRow, tasks: readonly CronTask[]): ScheduleView {
	const task = row.enabled ? tasks.find((t) => t.name === scheduleTask(row.id)) : undefined;
	return { ...row, nextRunAt: task?.nextRunAt ?? null };
}

/** The template at `revision`, its shape and its site checks (spec "Behaviour" step 3, plan Ruling 13). */
async function checkedTemplate(
	deps: ScheduleDeps,
	id: string,
	revision: number,
): Promise<Template> {
	const row = await deps.templates.get(id);
	if (!row) throw templateNotFound("TEMPLATE_NOT_FOUND", id);
	assertRevision(id, row.revision, revision);
	const template = templateForSave(readSavedTemplate(row));
	const problems = await deps.templateProblems(template);
	if (problems.length > 0) {
		throw new ServiceError(
			"TEMPLATE_PROBLEMS",
			`Template ${id} does not fit the site; fix it before scheduling it`,
			409,
			{ problems },
		);
	}
	return template;
}

async function checkedSource(deps: ScheduleDeps, id: string): Promise<SourceRow> {
	const row = await deps.sources.get(id);
	if (!row) throw new ServiceError("SOURCE_NOT_FOUND", `Source ${id} not found`, 404);
	return row;
}

function checkCron(cron: string): void {
	const problem = cronProblem(cron);
	if (problem !== null) throw new ServiceError("INVALID_CRON", `${problem}. ${CRON_RULE}`, 400);
}

/** Spec Rulings 12, 13: required with `rules.missing`, refused without, never above it. */
function checkMissing(template: Template, missing: ScheduleMissing | undefined): void {
	const rule = template.rules?.missing;
	if (rule === undefined) {
		if (missing !== undefined) {
			throw new ServiceError(
				"INVALID_OPTIONS",
				"The template has no rules.missing; leave missing out",
				400,
			);
		}
		return;
	}
	if (missing === undefined) {
		throw new ServiceError(
			"MISSING_REQUIRED",
			'The template removes missing entries (rules.missing); set missing to false, "template" or { maxPercent }',
			400,
		);
	}
	const max = rule.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT;
	if (typeof missing === "object" && missing.maxPercent > max) {
		throw new ServiceError(
			"INVALID_OPTIONS",
			`missing.maxPercent ${missing.maxPercent} is over the template's ${max}; a schedule can lower the threshold, never raise it`,
			400,
		);
	}
}

/**
 * EmDash's refusal of an expression flux-import accepted (Fact E1) is `INVALID_CRON`, with its
 * message as it is. A date that never comes is refused with "Invalid cron expression or no future
 * run"; for some, such as `0 0 31 4,6,9,11 *`, croner's search for the next run overflows the
 * stack instead (`RangeError`, measured on EmDash 1.2.0's `nextCronTime`).
 */
async function scheduleTaskOf(
	cron: CronPort,
	row: Pick<ScheduleRow, "id" | "cron">,
): Promise<void> {
	try {
		await cron.schedule(scheduleTask(row.id), { schedule: row.cron, data: { scheduleId: row.id } });
	} catch (e) {
		if (
			e instanceof RangeError ||
			(e instanceof Error && /^Invalid (schedule|cron expression)/.test(e.message))
		) {
			throw new ServiceError("INVALID_CRON", e.message, 400);
		}
		throw e;
	}
}

/** `schedules/create` (spec "Behaviour"): every check before any write, in the spec's order. */
export async function createSchedule(
	deps: ScheduleDeps,
	user: string,
	input: CreateScheduleInput,
): Promise<ScheduleView> {
	const name = input.name.normalize("NFC");
	await assertNameFreeIn(deps.schedules, "schedule", name);
	if ((await deps.schedules.query({ limit: MAX_SCHEDULES })).items.length >= MAX_SCHEDULES) {
		throw new ServiceError(
			"SCHEDULE_LIMIT",
			`A site has at most ${MAX_SCHEDULES} schedules; delete one first`,
			409,
		);
	}
	const template = await checkedTemplate(deps, input.templateId, input.templateRevision);
	const source = await checkedSource(deps, input.sourceId);
	checkCron(input.cron);
	checkMissing(template, input.missing);
	const now = iso(deps.now());
	const row: ScheduleRow = {
		id: deps.newId(),
		name,
		templateId: input.templateId,
		templateRevision: input.templateRevision,
		sourceId: input.sourceId,
		sourcePin: await sourcePinOf(source),
		cron: input.cron,
		publish: input.publish ?? SCHEDULE_DEFAULTS.publish,
		batchSize: input.batchSize ?? SCHEDULE_DEFAULTS.batchSize,
		budgetMs: input.budgetMs ?? SCHEDULE_DEFAULTS.budgetMs,
		...(input.missing === undefined ? {} : { missing: input.missing }),
		enabled: input.enabled ?? true,
		runs: [],
		launchFailures: 0,
		armedBy: user,
		revision: 1,
		createdAt: now,
		updatedAt: now,
		createdBy: user,
		updatedBy: user,
	};
	if (!(await deps.schedules.compareAndSet(row.id, null, row)).applied) throw keptChanging();
	if (row.enabled) {
		try {
			await scheduleTaskOf(deps.cron, row);
		} catch (e) {
			await deps.schedules.delete(row.id);
			throw e;
		}
	}
	return viewOf(row, await deps.cron.list());
}

/**
 * `schedules/update` (spec "Behaviour", Rulings 46, 48): the checks run against the row at
 * `revision`; the write merges onto the newest row, so a scheduler write in between is kept and
 * retried over, and only another route write (a new `revision`) is `SCHEDULE_CHANGED`.
 */
export async function updateSchedule(
	deps: ScheduleDeps,
	user: string,
	input: UpdateScheduleInput,
): Promise<ScheduleView> {
	const first = await deps.schedules.get(input.id);
	if (!first) throw notFound(input.id);
	assertScheduleRevision(first, input.revision);
	const name = input.name?.normalize("NFC");
	if (name !== undefined && name !== first.name) {
		await assertNameFreeIn(deps.schedules, "schedule", name, first.id);
	}
	const templateId = input.templateId ?? first.templateId;
	const templateRevision = input.templateRevision ?? first.templateRevision;
	const sourceId = input.sourceId ?? first.sourceId;
	const templateChanged =
		templateId !== first.templateId || templateRevision !== first.templateRevision;
	if (templateChanged || sourceId !== first.sourceId) {
		const jobId = await routeBusy(deps, first);
		if (jobId !== null) throw busy(first.id, jobId);
	}
	const missing = input.missing === undefined ? first.missing : (input.missing ?? undefined);
	if (templateChanged || input.missing !== undefined) {
		checkMissing(await checkedTemplate(deps, templateId, templateRevision), missing);
	}
	const enabling = input.enabled === true;
	const source =
		sourceId !== first.sourceId || enabling ? await checkedSource(deps, sourceId) : null;
	const sourcePin = source === null ? first.sourcePin : await sourcePinOf(source);
	if (input.cron !== undefined) checkCron(input.cron);
	const cron = input.cron ?? first.cron;
	// Plan Ruling 5: EmDash's refusal leaves the row unchanged.
	if ((input.enabled ?? first.enabled) && (enabling || input.cron !== undefined)) {
		await scheduleTaskOf(deps.cron, { id: first.id, cron });
	}
	const now = iso(deps.now());
	let read = await deps.schedules.getVersioned(input.id);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		if (!read) throw notFound(input.id);
		const row = read.value;
		assertScheduleRevision(row, input.revision);
		const enabled = input.enabled ?? row.enabled;
		const { missing: _missing, pause, due, ...rest } = row;
		const next: ScheduleRow = {
			...rest,
			name: name ?? row.name,
			templateId,
			templateRevision,
			sourceId,
			sourcePin,
			cron,
			publish: input.publish ?? row.publish,
			batchSize: input.batchSize ?? row.batchSize,
			budgetMs: input.budgetMs ?? row.budgetMs,
			...(missing === undefined ? {} : { missing }),
			enabled,
			// Enabling clears the pause and the failures and takes the caller as creator.
			...(enabling ? { launchFailures: 0, armedBy: user } : pause ? { pause } : {}),
			// A disabled schedule is never due (plan Ruling 6).
			...(enabled && due ? { due } : {}),
			revision: row.revision + 1,
			updatedAt: now,
			updatedBy: user,
		};
		if ((await deps.schedules.compareAndSet(row.id, read.revision, next)).applied) {
			if (!next.enabled) await deps.cron.cancel(scheduleTask(row.id));
			return viewOf(next, await deps.cron.list());
		}
		read = await deps.schedules.getVersioned(input.id);
	}
	// The task may now hold the new expression: put it back as the newest row says (plan Ruling 5).
	const newest = await deps.schedules.get(input.id);
	if (newest?.enabled) await scheduleTaskOf(deps.cron, newest).catch(() => {});
	throw keptChanging();
}

/** `schedules/delete`: at `revision`, never while busy (spec "Behaviour", plan Ruling 7). */
export async function deleteSchedule(
	deps: ScheduleDeps,
	input: { id: string; revision: number },
): Promise<{ deleted: true }> {
	let read = await deps.schedules.getVersioned(input.id);
	if (!read) throw notFound(input.id);
	assertScheduleRevision(read.value, input.revision);
	const jobId = await routeBusy(deps, read.value);
	if (jobId !== null) throw busy(input.id, jobId);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		if (!read) throw notFound(input.id);
		assertScheduleRevision(read.value, input.revision);
		if ((await deps.schedules.compareAndDelete(input.id, read.revision)).applied) {
			// The pump cancels itself once nothing is due or open (spec Ruling 36).
			await deps.cron.cancel(scheduleTask(input.id));
			return { deleted: true };
		}
		read = await deps.schedules.getVersioned(input.id);
	}
	throw keptChanging();
}

/** `schedules/run` (spec Ruling 51): queues a due mark and arms the pump; never fetches. */
export async function runSchedule(
	deps: ScheduleDeps,
	input: { id: string; force?: boolean | undefined },
): Promise<ScheduleView> {
	const row = await deps.schedules.get(input.id);
	if (!row) throw notFound(input.id);
	if (!row.enabled) {
		const why = row.pause ? ` (paused: ${row.pause.reason})` : "";
		throw new ServiceError(
			"SCHEDULE_DISABLED",
			`Schedule ${input.id} is disabled${why}; enable it first`,
			409,
		);
	}
	const claimed = await routeBusy(deps, row);
	const job = claimed === null ? await busyJob(deps.jobs, row.sourceId) : null;
	const jobId = claimed ?? job?.id ?? null;
	if (jobId !== null) throw busy(input.id, jobId);
	const at = iso(deps.now());
	const written = await writeSchedule(deps.schedules, input.id, row.current?.jobId, (r) =>
		r.enabled
			? {
					...r,
					due: {
						at: r.due?.at ?? at,
						...(input.force === true || r.due?.force ? { force: true as const } : {}),
					},
				}
			: null,
	);
	if (!written) throw keptChanging();
	await armPump(deps.cron);
	return viewOf(written, await deps.cron.list());
}

/** `schedules/list`: rows and next runs; rows hold codes only (spec Ruling 47). */
export async function listSchedules(
	deps: Pick<ScheduleDeps, "schedules" | "cron">,
	cursor?: string,
): Promise<Page<ScheduleView>> {
	const rows = page(
		await deps.schedules.query({ limit: MAX_SCHEDULES, ...(cursor ? { cursor } : {}) }),
	);
	const tasks = await deps.cron.list();
	return { ...rows, items: rows.items.map((row) => viewOf(row, tasks)) };
}

async function allSchedules(schedules: KvCollection<ScheduleRow>): Promise<ScheduleRow[]> {
	const rows: ScheduleRow[] = [];
	let cursor: string | undefined;
	do {
		const result = await schedules.query({ limit: MAX_SCHEDULES, ...(cursor ? { cursor } : {}) });
		rows.push(...result.items.map((i) => i.data));
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return rows;
}

export interface ReconcileResult {
	scheduled: string[];
	cancelled: string[];
	pump: boolean;
	retention: boolean;
}

/**
 * Repairs the cron tasks from storage (spec "Reconciliation", Ruling 29): each enabled schedule's
 * task with its expression, no task without an enabled schedule, the pump while something is due
 * or open, and `retention` at `RETENTION_SCHEDULE`. An expression EmDash refuses stays
 * unscheduled (the list shows no next run).
 */
export async function reconcile(
	deps: Pick<ScheduleDeps, "schedules" | "jobs" | "cron">,
): Promise<ReconcileResult> {
	const tasks = await deps.cron.list();
	const rows = await allSchedules(deps.schedules);
	const byName = new Map(tasks.map((t) => [t.name, t]));
	const result: ReconcileResult = { scheduled: [], cancelled: [], pump: false, retention: false };
	const wanted = new Set<string>();
	for (const row of rows) {
		if (!row.enabled) continue;
		const name = scheduleTask(row.id);
		wanted.add(name);
		if (byName.get(name)?.schedule === row.cron) continue;
		try {
			await scheduleTaskOf(deps.cron, row);
			result.scheduled.push(name);
		} catch {
			// Left unscheduled; schedules/update with a valid expression repairs it.
		}
	}
	for (const task of tasks) {
		if (scheduleIdOf(task.name) !== null && !wanted.has(task.name)) {
			await deps.cron.cancel(task.name);
			result.cancelled.push(task.name);
		}
	}
	if (!byName.has(PUMP_TASK)) {
		if (rows.some((r) => r.enabled && r.due) || (await anyOpenJob(deps.jobs))) {
			await armPump(deps.cron);
			result.pump = true;
		}
	}
	if (byName.get(RETENTION_TASK)?.schedule !== RETENTION_SCHEDULE) {
		await deps.cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
		result.retention = true;
	}
	return result;
}

/** Up to five schedules that name the template or the source (spec Ruling 10). */
export async function schedulesUsing(
	schedules: KvCollection<ScheduleRow>,
	where: { templateId: string } | { sourceId: string },
	limit = 5,
): Promise<ScheduleRow[]> {
	return (await schedules.query({ where, limit })).items.map((i) => i.data);
}

/** `TEMPLATE_IN_USE` or `SOURCE_IN_USE` (spec Ruling 10). */
export function inUse(kind: "Template" | "Source", id: string, rows: ScheduleRow[]): ServiceError {
	return new ServiceError(
		`${kind.toUpperCase()}_IN_USE`,
		`${kind} ${id} is used by schedule(s) ${rows.map((r) => r.name).join(", ")}; delete or change them first`,
		409,
		{ scheduleIds: rows.map((r) => r.id) },
	);
}

/** `templates/update`'s warnings: schedules pinned to another revision (spec Ruling 11). */
export function templateWarnings(rows: ScheduleRow[], revision: number): string[] {
	return rows
		.filter((r) => r.templateRevision !== revision)
		.map(
			(r) =>
				`Schedule ${r.name} (${r.id}) runs revision ${r.templateRevision}; update it to run this revision`,
		);
}

/** `sources/update`'s warnings: schedules pinned to another URL or credential (spec Ruling 40). */
export function sourceWarnings(rows: ScheduleRow[], pin: string): string[] {
	return rows
		.filter((r) => r.sourcePin !== pin)
		.map(
			(r) =>
				`Schedule ${r.name} (${r.id}) pins this source's URL and credential; it pauses at its next run until it is enabled again`,
		);
}
