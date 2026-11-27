import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/engine/fingerprints.js";
import { CRON_RULE } from "../../src/plugin/cron-syntax.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "../../src/plugin/retention.js";
import {
	busyJob,
	createSchedule,
	deleteSchedule,
	inUse,
	LAUNCH_CLAIM_STALE_MS,
	listSchedules,
	MAX_SCHEDULES,
	PUMP_SCHEDULE,
	PUMP_TASK,
	paused,
	pausedKeeping,
	pauseSchedule,
	type RunEntry,
	reconcile,
	reopenScheduled,
	runSchedule,
	type ScheduleRow,
	schedulesUsing,
	sourcePinOf,
	sourceWarnings,
	templateWarnings,
	updateSchedule,
	WRITE_ATTEMPTS,
	withRollback,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { ServiceError } from "../../src/plugin/service.js";
import { redact } from "../../src/plugin/summaries.js";
import type { MemoryKv } from "./fakes.js";
import {
	jobRow,
	NOW,
	PLAIN,
	savedTemplate,
	scheduleDeps,
	scheduleRow,
	sourceRow,
} from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();
const base = {
	name: "Nightly",
	templateId: "T1",
	templateRevision: 1,
	sourceId: "S1",
	cron: "0 3 * * *",
};
type Deps = Awaited<ReturnType<typeof scheduleDeps>>["deps"];
const pinOf = (url: string) => fingerprint({ url, credential: null });
const zero = {
	created: 0,
	updated: 0,
	unchanged: 0,
	failed: 0,
	conflict: 0,
	locked: 0,
	removed: 0,
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof ServiceError) return e.code;
		throw e;
	}
	throw new Error("Expected a ServiceError");
}

/** Runs `meanwhile` just before each of the next `times` compare-and-set or -delete calls. */
function beforeWrites(
	schedules: MemoryKv<ScheduleRow>,
	meanwhile: () => Promise<unknown>,
	times = 1,
): void {
	const cas = schedules.compareAndSet.bind(schedules);
	const cad = schedules.compareAndDelete.bind(schedules);
	let left = times;
	schedules.compareAndSet = async (id, revision, data) => {
		if (left-- > 0) await meanwhile();
		return cas(id, revision, data);
	};
	schedules.compareAndDelete = async (id, revision) => {
		if (left-- > 0) await meanwhile();
		return cad(id, revision);
	};
}

/** A launch's claim, written as the scheduler writes it (no new revision). */
const claim = (schedules: MemoryKv<ScheduleRow>, jobId: string) => () =>
	writeSchedule(schedules, "A", undefined, (r) => ({ ...r, current: { jobId, claimedAt: AT } }));

describe("createSchedule", () => {
	it("creates an enabled schedule: the row, its pin and creator, and its task", async () => {
		const { deps } = await scheduleDeps();
		const view = await createSchedule(deps, "admin", base);
		expect(view).toMatchObject({
			id: "SCH1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			sourcePin: await pinOf("https://feeds.example/S1.csv"),
			cron: "0 3 * * *",
			publish: true,
			batchSize: 50,
			budgetMs: 4000,
			enabled: true,
			runs: [],
			launchFailures: 0,
			armedBy: "admin",
			revision: 1,
			createdAt: AT,
			createdBy: "admin",
			updatedBy: "admin",
			nextRunAt: "2026-11-18T03:00:00.000Z",
		});
		expect(view).not.toHaveProperty("missing");
		expect(await deps.schedules.get("SCH1")).toMatchObject({ name: "Nightly", revision: 1 });
		expect(deps.cron.tasks.get("schedule-SCH1")).toEqual({
			schedule: "0 3 * * *",
			data: { scheduleId: "SCH1" },
		});
	});

	it("refuses with the first failing check, in the spec's order", async () => {
		const { deps, problems } = await scheduleDeps();
		await deps.schedules.put("X", scheduleRow("X", { name: "Taken" }));
		await deps.templates.put("T3", savedTemplate("T3", PLAIN, 2));
		const broken = {
			name: "Taken",
			templateId: "nope",
			templateRevision: 1,
			sourceId: "nope",
			cron: "61 * * * *",
		};
		const create = (fix: object) => codeOf(createSchedule(deps, "admin", { ...broken, ...fix }));
		expect(await create({})).toBe("NAME_TAKEN");
		expect(await create({ name: "Free" })).toBe("TEMPLATE_NOT_FOUND");
		expect(await create({ name: "Free", templateId: "T3" })).toBe("TEMPLATE_CHANGED");
		problems.push("locale: xx is not a site locale");
		expect(await create({ name: "Free", templateId: "T1" })).toBe("TEMPLATE_PROBLEMS");
		problems.length = 0;
		expect(await create({ name: "Free", templateId: "T1" })).toBe("SOURCE_NOT_FOUND");
		expect(await create({ name: "Free", templateId: "T1", sourceId: "S1" })).toBe("INVALID_CRON");
		const owned = { name: "Free", templateId: "T2", sourceId: "S1", cron: "@daily" };
		expect(await create(owned)).toBe("MISSING_REQUIRED");
		expect((await deps.schedules.query({ limit: 100 })).items.map((i) => i.id)).toEqual(["X"]);
		expect(deps.cron.calls).toEqual([]);
	});

	it("names the name, the revision and the expression in its refusals", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("X", scheduleRow("X", { name: "Café" }));
		// The name is compared in NFC, as template names are (M6a "Names").
		const decomposed = "Café";
		await expect(
			createSchedule(deps, "admin", { ...base, name: decomposed }),
		).rejects.toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			message: 'A schedule named "Café" already exists',
		});
		await deps.templates.put("T3", savedTemplate("T3", PLAIN, 2));
		await expect(
			createSchedule(deps, "admin", { ...base, templateId: "T3" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: "Template T3 is at revision 2, not 1; read it again",
			details: { revision: 2 },
		});
		await expect(
			createSchedule(deps, "admin", { ...base, cron: "0 3 * * * *" }),
		).rejects.toMatchObject({
			code: "INVALID_CRON",
			status: 400,
			message:
				"Expected 5 fields, found 6. Use five cron fields (minute, hour, day of month, month, day of week) or @hourly, @daily, @weekly, @monthly or @yearly; times are UTC",
		});
		const view = await createSchedule(deps, "admin", { ...base, name: "Café 2" });
		expect(view.name).toBe("Café 2");
	});

	it("refuses the 21st schedule, and names a template's site problems", async () => {
		const { deps, problems } = await scheduleDeps();
		for (let i = 0; i < MAX_SCHEDULES; i++) await deps.schedules.put(`X${i}`, scheduleRow(`X${i}`));
		await expect(createSchedule(deps, "admin", base)).rejects.toMatchObject({
			code: "SCHEDULE_LIMIT",
			status: 409,
			message: "A site has at most 20 schedules; delete one first",
		});
		await deps.schedules.delete("X0");
		problems.push("collection: products does not exist");
		await expect(createSchedule(deps, "admin", base)).rejects.toMatchObject({
			code: "TEMPLATE_PROBLEMS",
			status: 409,
			message: "Template T1 does not fit the site; fix it before scheduling it",
			details: { problems: ["collection: products does not exist"] },
		});
	});

	it("requires missing for a template with rules.missing, never above its threshold (spec Rulings 12, 13)", async () => {
		const { deps } = await scheduleDeps();
		const owned = { ...base, templateId: "T2" };
		expect(await codeOf(createSchedule(deps, "admin", owned))).toBe("MISSING_REQUIRED");
		const over = { ...owned, missing: { maxPercent: 11 } };
		await expect(createSchedule(deps, "admin", over)).rejects.toMatchObject({
			code: "INVALID_OPTIONS",
			message:
				"missing.maxPercent 11 is over the template's 10; a schedule can lower the threshold, never raise it",
		});
		const plain = { ...base, missing: "template" as const };
		expect(await codeOf(createSchedule(deps, "admin", plain))).toBe("INVALID_OPTIONS");
		const choices = [false, "template", { maxPercent: 10 }] as const;
		for (const [i, missing] of choices.entries()) {
			const view = await createSchedule(deps, "admin", { ...owned, name: `S${i}`, missing });
			expect(view.missing).toEqual(missing);
		}
	});

	it("deletes the row when EmDash refuses the expression, with EmDash's message (Fact E1)", async () => {
		const { deps } = await scheduleDeps();
		deps.cron.refuse = "0 4 * * *";
		await expect(
			createSchedule(deps, "admin", { ...base, cron: "0 4 * * *" }),
		).rejects.toMatchObject({
			code: "INVALID_CRON",
			message: 'Invalid cron expression or no future run: "0 4 * * *"',
		});
		expect((await deps.schedules.query({ limit: 100 })).items).toEqual([]);
	});

	it("refuses a day the listed months never have before EmDash sees it", async () => {
		const { deps } = await scheduleDeps();
		// EmDash 1.2.0's nextCronTime overflows the stack on this one (croner recursion).
		const never = { ...base, cron: "0 0 31 4,6,9,11 *" };
		await expect(createSchedule(deps, "admin", never)).rejects.toMatchObject({
			code: "INVALID_CRON",
			status: 400,
			message: `Day 31 never occurs in the listed months. ${CRON_RULE}`,
		});
		expect(deps.cron.calls).toEqual([]);
		expect((await deps.schedules.query({ limit: 100 })).items).toEqual([]);
	});

	it("refuses an expression whose next run overflows EmDash's search, and rethrows any other error", async () => {
		const { deps } = await scheduleDeps();
		// The backstop for anything else that reaches croner's recursion as a RangeError.
		deps.cron.schedule = async () => {
			throw new RangeError("Maximum call stack size exceeded");
		};
		await expect(createSchedule(deps, "admin", base)).rejects.toMatchObject({
			code: "INVALID_CRON",
			status: 400,
			message: "Maximum call stack size exceeded",
		});
		deps.cron.schedule = async () => {
			throw new Error("D1_ERROR: database is locked");
		};
		await expect(createSchedule(deps, "admin", base)).rejects.not.toBeInstanceOf(ServiceError);
		expect((await deps.schedules.query({ limit: 100 })).items).toEqual([]);
	});

	it("creates a disabled schedule without a task", async () => {
		const { deps } = await scheduleDeps();
		const view = await createSchedule(deps, "admin", { ...base, enabled: false });
		expect(view).toMatchObject({ enabled: false, nextRunAt: null });
		expect(deps.cron.calls).toEqual([]);
	});
});

describe("updateSchedule", () => {
	it("refuses a missing schedule and a stale revision", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { revision: 2 }));
		await expect(
			updateSchedule(deps, "admin", { id: "nope", revision: 1, name: "B" }),
		).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, message: "Schedule nope not found" });
		await expect(
			updateSchedule(deps, "admin", { id: "A", revision: 1, name: "B" }),
		).rejects.toMatchObject({
			code: "SCHEDULE_CHANGED",
			status: 409,
			message: "Schedule A is at revision 2, not 1; read it again",
			details: { revision: 2 },
		});
		// Refused before the task is touched, so the task never runs an expression the row lacks.
		const stale = { id: "A", revision: 1, cron: "@hourly", enabled: true };
		expect(await codeOf(updateSchedule(deps, "admin", stale))).toBe("SCHEDULE_CHANGED");
		expect(deps.cron.calls).toEqual([]);
	});

	it("renames to a free name only, compared in NFC", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		await deps.schedules.put("B", scheduleRow("B", { name: "Caf\u00e9" }));
		const taken = updateSchedule(deps, "admin", { id: "A", revision: 1, name: "Cafe\u0301" });
		await expect(taken).rejects.toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			message: 'A schedule named "Caf\u00e9" already exists',
			details: { id: "B" },
		});
		const same = await updateSchedule(deps, "admin", { id: "A", revision: 1, name: "Nightly" });
		expect(same).toMatchObject({ name: "Nightly", revision: 2 });
	});

	it("retries a write lost to the scheduler while the revision is current (spec Ruling 46)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		const cas = deps.schedules.compareAndSet.bind(deps.schedules);
		let tick = true;
		deps.schedules.compareAndSet = async (id, revision, data) => {
			if (tick) {
				tick = false;
				// A due mark lands between the route's read and its write.
				await writeSchedule(deps.schedules, "A", undefined, (r) => ({ ...r, due: { at: AT } }));
			}
			return cas(id, revision, data);
		};
		const view = await updateSchedule(deps, "editor", { id: "A", revision: 1, name: "Renamed" });
		expect(view).toMatchObject({
			name: "Renamed",
			revision: 2,
			updatedBy: "editor",
			due: { at: AT },
		});
	});

	it("refuses a template or source change while a job is open or a launch in flight", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.sources.put("S2", sourceRow("S2"));
		await deps.schedules.put("A", scheduleRow("A"));
		const open = { status: "completed", origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...open, scheduled: "open" }));
		const move = () => updateSchedule(deps, "admin", { id: "A", revision: 1, sourceId: "S2" });
		await expect(move()).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			status: 409,
			message: "Schedule A is busy with job J1; wait for it to finish or cancel it",
			details: { jobId: "J1" },
		});
		await deps.jobs.put("J1", jobRow("J1", { ...open, scheduled: "closed" }));
		const claimedAt = new Date(clock.t - 60_000).toISOString();
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J2", claimedAt } }));
		await expect(move()).rejects.toMatchObject({ code: "SCHEDULE_BUSY", details: { jobId: "J2" } });
		clock.t += LAUNCH_CLAIM_STALE_MS;
		expect(await move()).toMatchObject({
			sourceId: "S2",
			sourcePin: await pinOf("https://feeds.example/S2.csv"),
		});
	});

	it("enabling clears the pause and failures, re-pins the source, takes the caller and schedules the task", async () => {
		const { deps } = await scheduleDeps();
		await deps.sources.put("S1", sourceRow("S1", { url: "https://feeds.example/moved.csv" }));
		const pause = { reason: "source_changed" as const, at: AT };
		await deps.schedules.put("A", scheduleRow("A", { enabled: false, pause, launchFailures: 2 }));
		const view = await updateSchedule(deps, "second", { id: "A", revision: 1, enabled: true });
		expect(view).toMatchObject({
			enabled: true,
			launchFailures: 0,
			armedBy: "second",
			sourcePin: await pinOf("https://feeds.example/moved.csv"),
			nextRunAt: "2026-11-18T03:00:00.000Z",
		});
		expect(view).not.toHaveProperty("pause");
		expect(deps.cron.tasks.has("schedule-A")).toBe(true);
	});

	it("disabling cancels the task and drops the due mark, and leaves the open job alone (spec Ruling 48)", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await deps.schedules.put("A", scheduleRow("A", { due: { at: AT } }));
		const running = {
			status: "running",
			origin: "schedule",
			scheduleId: "A",
			scheduled: "open",
		} as const;
		await deps.jobs.put("J1", jobRow("J1", running));
		const view = await updateSchedule(deps, "admin", { id: "A", revision: 1, enabled: false });
		expect(view).toMatchObject({ enabled: false, nextRunAt: null });
		expect(view).not.toHaveProperty("due");
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
		expect(await deps.jobs.get("J1")).toMatchObject({ status: "running", scheduled: "open" });
	});

	it("re-schedules on a new expression; EmDash's refusal leaves the row unchanged (plan Ruling 5)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		await updateSchedule(deps, "admin", { id: "A", revision: 1, cron: "@hourly" });
		expect(deps.cron.tasks.get("schedule-A")).toEqual({
			schedule: "@hourly",
			data: { scheduleId: "A" },
		});
		deps.cron.refuse = "0 4 * * *";
		const refused = updateSchedule(deps, "admin", { id: "A", revision: 2, cron: "0 4 * * *" });
		await expect(refused).rejects.toMatchObject({
			code: "INVALID_CRON",
			message: 'Invalid cron expression or no future run: "0 4 * * *"',
		});
		expect(await deps.schedules.get("A")).toMatchObject({ cron: "@hourly", revision: 2 });
		const sixFields = updateSchedule(deps, "admin", { id: "A", revision: 2, cron: "0 3 * * * *" });
		expect(await codeOf(sixFields)).toBe("INVALID_CRON");
	});

	it.each([
		[
			"another route's write takes the revision",
			(deps: Deps) => deps.schedules.put("A", scheduleRow("A", { name: "Other", revision: 2 })),
			"SCHEDULE_CHANGED",
			{ schedule: "0 3 * * *", data: { scheduleId: "A" } },
		],
		[
			"another route disables the schedule",
			(deps: Deps) => deps.schedules.put("A", scheduleRow("A", { enabled: false, revision: 2 })),
			"SCHEDULE_CHANGED",
			undefined,
		],
		["the schedule is deleted", (deps: Deps) => deps.schedules.delete("A"), "NOT_FOUND", undefined],
	] as const)(
		"re-syncs the task from the newest row when %s after scheduling (plan Ruling 5)",
		async (_what, meanwhile, code, task) => {
			const { deps } = await scheduleDeps();
			await deps.schedules.put("A", scheduleRow("A"));
			await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *", data: { scheduleId: "A" } });
			beforeWrites(deps.schedules, () => meanwhile(deps));
			const update = updateSchedule(deps, "admin", { id: "A", revision: 1, cron: "@hourly" });
			expect(await codeOf(update)).toBe(code);
			expect(deps.cron.tasks.get("schedule-A")).toEqual(task);
		},
	);

	it("rethrows the update's own error when the re-sync fails too", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		beforeWrites(deps.schedules, () => deps.schedules.delete("A"));
		deps.cron.cancel = async () => {
			throw new Error("D1_ERROR: database is locked");
		};
		const update = updateSchedule(deps, "admin", { id: "A", revision: 1, cron: "@hourly" });
		expect(await codeOf(update)).toBe("NOT_FOUND");
	});

	it("re-checks the busy rule on the newest row: a claim between the read and the write refuses a source change", async () => {
		const { deps } = await scheduleDeps();
		await deps.sources.put("S2", sourceRow("S2"));
		await deps.schedules.put("A", scheduleRow("A"));
		beforeWrites(deps.schedules, claim(deps.schedules, "J7"));
		const move = updateSchedule(deps, "admin", { id: "A", revision: 1, sourceId: "S2" });
		await expect(move).rejects.toMatchObject({ code: "SCHEDULE_BUSY", details: { jobId: "J7" } });
		expect(await deps.schedules.get("A")).toMatchObject({ sourceId: "S1", revision: 1 });
		// Nothing was scheduled, so nothing is re-synced.
		expect(deps.cron.calls).toEqual([]);
	});

	it("refuses a busy change before it touches the task", async () => {
		const { deps } = await scheduleDeps();
		await deps.sources.put("S2", sourceRow("S2"));
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J7", claimedAt: AT } }));
		const move = { id: "A", revision: 1, sourceId: "S2", cron: "@hourly" };
		expect(await codeOf(updateSchedule(deps, "admin", move))).toBe("SCHEDULE_BUSY");
		expect(deps.cron.calls).toEqual([]);
	});

	it("removes missing with null only when the template has no rules.missing", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { templateId: "T2", missing: "template" }));
		const keep = updateSchedule(deps, "admin", { id: "A", revision: 1, missing: null });
		expect(await codeOf(keep)).toBe("MISSING_REQUIRED");
		const change = { id: "A", revision: 1, templateId: "T1", templateRevision: 1, missing: null };
		expect(await updateSchedule(deps, "admin", change)).not.toHaveProperty("missing");
	});
});

describe("deleteSchedule", () => {
	it("deletes at the revision and cancels the task, unless a job is open or a launch in flight", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const current = { jobId: "J9", claimedAt: AT };
		await deps.schedules.put("A", scheduleRow("A", { current }));
		expect(await codeOf(deleteSchedule(deps, { id: "A", revision: 2 }))).toBe("SCHEDULE_CHANGED");
		await expect(deleteSchedule(deps, { id: "A", revision: 1 })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J9" },
		});
		clock.t += LAUNCH_CLAIM_STALE_MS;
		const failed = { status: "failed", origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...failed, scheduled: "open" }));
		await expect(deleteSchedule(deps, { id: "A", revision: 1 })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J1" },
		});
		await deps.jobs.put("J1", jobRow("J1", { ...failed, scheduled: "closed" }));
		// Another schedule's open job does not hold this one.
		await deps.jobs.put("J2", jobRow("J2", { ...failed, scheduleId: "Z", scheduled: "open" }));
		expect(await deleteSchedule(deps, { id: "A", revision: 1 })).toEqual({ deleted: true });
		expect(await deps.schedules.get("A")).toBeNull();
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
	});
});

describe("deleteSchedule races", () => {
	it("re-checks the busy rule on the newest row: a claim between the read and the delete refuses it", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		beforeWrites(deps.schedules, claim(deps.schedules, "J7"));
		await expect(deleteSchedule(deps, { id: "A", revision: 1 })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J7" },
		});
		expect(await deps.schedules.get("A")).not.toBeNull();
	});
});

describe("runSchedule", () => {
	it("refuses a disabled or paused schedule (SCHEDULE_DISABLED)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { enabled: false }));
		const pause = { reason: "job_failed" as const, at: AT };
		await deps.schedules.put("B", scheduleRow("B", { enabled: false, pause }));
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_DISABLED",
			status: 409,
			message: "Schedule A is disabled; enable it first",
		});
		await expect(runSchedule(deps, { id: "B" })).rejects.toMatchObject({
			message: "Schedule B is disabled (paused: job_failed); enable it first",
		});
		expect(await codeOf(runSchedule(deps, { id: "nope" }))).toBe("NOT_FOUND");
	});

	it.each([
		["an Admin's import", { status: "running" }],
		["an agent's real import", { status: "created", origin: "agent" }],
		["another schedule's paused job", { status: "paused", origin: "schedule", scheduleId: "Z" }],
		["a rollback", { status: "running", kind: "rollback" }],
	] as const)("is busy while %s reads the source (spec Ruling 33)", async (_what, extra) => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		await deps.jobs.put("J1", jobRow("J1", { feedSourceId: "S1", ...extra }));
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J1" },
		});
	});

	it("is not busy for a dry run or a finished job, and pages past dry runs (plan Ruling 2)", async () => {
		const { deps } = await scheduleDeps();
		for (let i = 0; i < 25; i++) {
			await deps.jobs.put(`D${i}`, jobRow(`D${i}`, { feedSourceId: "S1", dryRun: true }));
		}
		await deps.jobs.put("J1", jobRow("J1", { feedSourceId: "S1", status: "completed" }));
		expect(await busyJob(deps.jobs, "S1")).toBeNull();
		await deps.jobs.put("Z9", jobRow("Z9", { feedSourceId: "S1", status: "paused" }));
		expect((await busyJob(deps.jobs, "S1"))?.id).toBe("Z9");
	});

	it("answers why a due mark was lost: disabled, busy, or else CONFLICT", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		// A pause lands between the read and the write.
		beforeWrites(deps.schedules, async () => {
			const row = (await deps.schedules.get("A")) as ScheduleRow;
			await deps.schedules.put("A", paused(row, "job_failed", AT));
		});
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_DISABLED",
			status: 409,
			message: "Schedule A is disabled (paused: job_failed); enable it first",
		});
		// A launch claims it between the read and the write.
		await deps.schedules.put("A", scheduleRow("A"));
		beforeWrites(deps.schedules, claim(deps.schedules, "J7"));
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J7" },
		});
		// Every attempt loses to writes that leave it enabled and unclaimed.
		await deps.schedules.put("A", scheduleRow("A"));
		beforeWrites(
			deps.schedules,
			async () => deps.schedules.put("A", scheduleRow("A")),
			Number.POSITIVE_INFINITY,
		);
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "CONFLICT",
			status: 409,
			message: "The schedule kept changing; try again",
		});
		expect(deps.cron.tasks.has(PUMP_TASK)).toBe(false);
	});

	it("queues a due mark, with force when asked, and arms the pump; an older mark is kept (spec Ruling 51)", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		expect((await runSchedule(deps, { id: "A" })).due).toEqual({ at: AT });
		expect(deps.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		clock.t += 60_000;
		const forced = await runSchedule(deps, { id: "A", force: true });
		expect(forced).toMatchObject({ due: { at: AT, force: true }, revision: 1 });
		// A later run without force keeps the queued force.
		expect((await runSchedule(deps, { id: "A" })).due).toEqual({ at: AT, force: true });
	});
});

describe("route side effects after a write that applied (spec Ruling 89)", () => {
	// A message naming a staged file, which the log must not show (preflight F12).
	const upload = `01JZ5V6Q8X0000000000000000${"ab".repeat(16)}`;
	const failing = (what: string) => async () => {
		throw new Error(`${what} failed on ${upload}`);
	};
	const redacted = (what: string, step: string) => {
		const message = `fluximporter: ${what} failed: ${redact(`${step} failed on ${upload}`)}`;
		expect(message).not.toContain(upload);
		return message;
	};

	it("createSchedule answers the created row with nextRunAt null when the task list fails", async () => {
		const { deps, warnings } = await scheduleDeps();
		deps.cron.list = failing("list");
		const view = await createSchedule(deps, "admin", base);
		expect(view).toMatchObject({ id: "SCH1", enabled: true, nextRunAt: null });
		expect(await deps.schedules.get("SCH1")).not.toBeNull();
		expect(deps.cron.tasks.has("schedule-SCH1")).toBe(true);
		expect(warnings).toEqual([redacted("listing the cron tasks", "list")]);
		// A retry is NAME_TAKEN, which is right now that the first call answered the row.
		expect(await codeOf(createSchedule(deps, "admin", base))).toBe("NAME_TAKEN");
	});

	it("updateSchedule answers the written row when the cancel or the list fails", async () => {
		const { deps, warnings } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		deps.cron.cancel = failing("cancel");
		const off = await updateSchedule(deps, "admin", { id: "A", revision: 1, enabled: false });
		expect(off).toMatchObject({ enabled: false, revision: 2, nextRunAt: null });
		expect(await deps.schedules.get("A")).toMatchObject({ enabled: false, revision: 2 });
		expect(warnings).toEqual([redacted("cancelling the schedule's task", "cancel")]);
		warnings.length = 0;
		deps.cron.list = failing("list");
		const renamed = await updateSchedule(deps, "admin", { id: "A", revision: 2, name: "Other" });
		expect(renamed).toMatchObject({ name: "Other", revision: 3, nextRunAt: null });
		expect(warnings).toEqual([
			redacted("cancelling the schedule's task", "cancel"),
			redacted("listing the cron tasks", "list"),
		]);
	});

	it("deleteSchedule answers deleted when the cancel fails", async () => {
		const { deps, warnings } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		deps.cron.cancel = failing("cancel");
		expect(await deleteSchedule(deps, { id: "A", revision: 1 })).toEqual({ deleted: true });
		expect(await deps.schedules.get("A")).toBeNull();
		expect(warnings).toEqual([redacted("cancelling the schedule's task", "cancel")]);
	});

	it("runSchedule answers the due row when arming the pump or the list fails", async () => {
		const { deps, warnings } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		deps.cron.schedule = failing("schedule");
		deps.cron.list = failing("list");
		const view = await runSchedule(deps, { id: "A" });
		expect(view).toMatchObject({ due: { at: AT }, nextRunAt: null });
		expect((await deps.schedules.get("A"))?.due).toEqual({ at: AT });
		expect(warnings).toEqual([
			redacted("arming the pump", "schedule"),
			redacted("listing the cron tasks", "list"),
		]);
	});
});

describe("listSchedules", () => {
	it("lists every schedule with its next run, null when disabled, and codes only (spec Ruling 47)", async () => {
		const { deps } = await scheduleDeps();
		// A failed launch: the fetch keeps its message on the source, the schedule only the code.
		const launchMessage = "The server answered 503 for https://feeds.example/S1.csv?token=s3cret";
		const lastError = { at: AT, code: "HTTP_ERROR", message: launchMessage };
		await deps.sources.put("S1", sourceRow("S1", { lastError }));
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const lastLaunch = { at: AT, outcome: "failed" as const, errorCode: "HTTP_ERROR" };
		const known = scheduleRow("A", {
			lastLaunch,
			launchFailures: 1,
			missing: false,
			due: { at: AT, force: true },
			current: { jobId: "J5", claimedAt: AT },
			pause: { reason: "cancelled", at: AT, jobId: "J4" },
		});
		// Fields no code writes, as a stray older or foreign write could leave them.
		const strays = { message: launchMessage, token: "s3cret" };
		await deps.schedules.put("A", { ...known, ...strays } as ScheduleRow);
		// A failed job: the job keeps its message, the run log and the pause only codes.
		const jobMessage = "Row 7: price s3cret-value is not a number";
		const failed = { status: "failed", origin: "schedule", scheduleId: "B" } as const;
		const error = { code: "invalid_value", message: jobMessage };
		await deps.jobs.put("J1", jobRow("J1", { ...failed, scheduled: "closed", error }));
		const run: RunEntry = {
			jobId: "J1",
			at: AT,
			outcome: "failed",
			counters: { ...zero, failed: 3 },
		};
		const pause = { reason: "job_failed" as const, at: AT, jobId: "J1" };
		await deps.schedules.put("B", scheduleRow("B", { enabled: false, pause, runs: [run] }));
		// A task a lost cancel left behind still shows no next run for a disabled schedule.
		await deps.cron.schedule("schedule-B", { schedule: "0 3 * * *" });
		const page = await listSchedules(deps);
		expect(page.items.map((s) => [s.id, s.nextRunAt])).toEqual([
			["A", "2026-11-18T03:00:00.000Z"],
			["B", null],
		]);
		expect(page.hasMore).toBe(false);
		// Only the view's own fields, each one kept.
		expect(page.items[0]).toEqual({ ...known, nextRunAt: "2026-11-18T03:00:00.000Z" });
		expect(page.items[1]).toMatchObject({ pause: { reason: "job_failed" }, runs: [run] });
		// Every key and every string anywhere in the page.
		const texts = (value: unknown): string[] =>
			typeof value === "string"
				? [value]
				: value !== null && typeof value === "object"
					? Object.entries(value).flatMap(([k, v]) => [k, ...texts(v)])
					: [];
		const all = texts(page);
		expect(all).not.toContain("message");
		expect(all).not.toContain("token");
		for (const text of all) {
			expect(text).not.toContain("s3cret");
			expect(text).not.toContain("503");
		}
	});

	it("reads one page of MAX_SCHEDULES rows and hands on the cursor (spec Rulings 17, 49)", async () => {
		const { deps } = await scheduleDeps();
		// The name and limit race can leave one schedule over the limit (spec Ruling 49).
		for (let i = 0; i <= MAX_SCHEDULES; i++)
			await deps.schedules.put(`X${i}`, scheduleRow(`X${i}`));
		const first = await listSchedules(deps);
		expect(first.items).toHaveLength(MAX_SCHEDULES);
		expect(first.hasMore).toBe(true);
		const second = await listSchedules(deps, first.cursor);
		expect(second.items.map((s) => s.id)).toEqual([`X${MAX_SCHEDULES}`]);
		expect(second.hasMore).toBe(false);
	});
});

describe("reconcile (spec Ruling 29)", () => {
	it("schedules missing or changed tasks, cancels orphans, arms the pump and fixes retention", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-B", { schedule: "@hourly" });
		await deps.cron.schedule("schedule-GONE", { schedule: "@daily" });
		await deps.cron.schedule(RETENTION_TASK, { schedule: "5 4 * * *" });
		await deps.schedules.put("A", scheduleRow("A"));
		await deps.schedules.put("B", scheduleRow("B", { cron: "@daily" }));
		await deps.schedules.put("C", scheduleRow("C", { enabled: false }));
		const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;
		await deps.jobs.put("J1", jobRow("J1", open));
		expect(await reconcile(deps)).toEqual({
			scheduled: ["schedule-A", "schedule-B"],
			cancelled: ["schedule-GONE"],
			failed: [],
			pump: true,
			retention: true,
		});
		expect(deps.cron.tasks.get("schedule-B")).toEqual({
			schedule: "@daily",
			data: { scheduleId: "B" },
		});
		expect(deps.cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
		deps.cron.calls.length = 0;
		const quiet = { scheduled: [], cancelled: [], failed: [], pump: false, retention: false };
		expect(await reconcile(deps)).toEqual(quiet);
		expect(deps.cron.calls).toEqual([]);
	});

	it("reports the schedules it could not schedule, and repairs the rest", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { cron: "0 4 * * *" }));
		await deps.schedules.put("B", scheduleRow("B", { cron: "0 5 * * *" }));
		await deps.schedules.put("C", scheduleRow("C"));
		// EmDash refuses A's expression; B's write fails in EmDash's storage.
		deps.cron.refuse = "0 4 * * *";
		const schedule = deps.cron.schedule.bind(deps.cron);
		deps.cron.schedule = async (name, opts) => {
			if (name === "schedule-B") throw new Error("D1_ERROR: database is locked");
			return schedule(name, opts);
		};
		expect(await reconcile(deps)).toEqual({
			scheduled: ["schedule-C"],
			cancelled: [],
			failed: ["A", "B"],
			pump: false,
			retention: true,
		});
		expect(deps.cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
	});
});

describe("scheduler writes and pauses", () => {
	it("writes only while current?.jobId is what the writer decided on (spec Ruling 34)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J1", claimedAt: AT } }));
		const mark = (r: ScheduleRow): ScheduleRow => ({
			...r,
			lastLaunch: { at: AT, outcome: "unchanged" },
		});
		expect(await writeSchedule(deps.schedules, "A", "J0", mark)).toBeNull();
		expect(await writeSchedule(deps.schedules, "A", undefined, mark)).toBeNull();
		expect(await writeSchedule(deps.schedules, "A", "J1", mark)).toMatchObject({
			lastLaunch: { outcome: "unchanged" },
		});
		expect(await writeSchedule(deps.schedules, "gone", undefined, mark)).toBeNull();
	});

	it("retries a compare-and-set lost to another write, on the newest row, and gives up after WRITE_ATTEMPTS", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J1", claimedAt: AT } }));
		const cas = deps.schedules.compareAndSet.bind(deps.schedules);
		let losses = 1;
		let attempts = 0;
		deps.schedules.compareAndSet = async (id, revision, data) => {
			attempts++;
			if (losses-- > 0) {
				// A route's write lands between the read and the compare-and-set; the claim stays.
				const row = (await deps.schedules.get(id)) as ScheduleRow;
				await deps.schedules.put(id, { ...row, name: "Renamed", revision: 2 });
			}
			return cas(id, revision, data);
		};
		const mark = (r: ScheduleRow): ScheduleRow => ({ ...r, launchFailures: r.launchFailures + 1 });
		expect(await writeSchedule(deps.schedules, "A", "J1", mark)).toMatchObject({
			name: "Renamed",
			revision: 2,
			launchFailures: 1,
		});
		expect(attempts).toBe(2);
		losses = Number.POSITIVE_INFINITY;
		attempts = 0;
		expect(await writeSchedule(deps.schedules, "A", "J1", mark)).toBeNull();
		expect(attempts).toBe(WRITE_ATTEMPTS);
		expect(await deps.schedules.get("A")).toMatchObject({ launchFailures: 1 });
	});

	it("pauses from a route: disabled with the reason, no claim or mark, the task cancelled, the run marked", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const run: RunEntry = { jobId: "J1", at: AT, outcome: "completed", counters: zero };
		const older: RunEntry = { ...run, jobId: "J0" };
		const current = { jobId: "J2", claimedAt: AT };
		const runs = [run, older];
		await deps.schedules.put("A", scheduleRow("A", { due: { at: AT }, current, runs }));
		const mark = (r: ScheduleRow) => withRollback(r, "J1", "R1", AT);
		expect(await pauseSchedule(deps, "A", "rolled_back", "J1", mark)).toBe(true);
		const row = await deps.schedules.get("A");
		expect(row).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", at: AT, jobId: "J1" },
			runs: [{ ...run, rolledBack: { by: "R1", at: AT } }, older],
			revision: 1,
		});
		expect(row?.runs[1]).toEqual(older);
		expect(row).not.toHaveProperty("due");
		expect(row).not.toHaveProperty("current");
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
		expect(await pauseSchedule(deps, "gone", "cancelled", "J1")).toBe(false);
	});

	it("keeps an existing pause on an automatic pause: its reason, time and job stay, the claim and mark go", () => {
		const earlier = "2026-11-17T10:00:00.000Z";
		const first = { reason: "rolled_back", at: earlier, jobId: "J1" } as const;
		const current = { jobId: "J2", claimedAt: AT };
		// Disabled with a pause, and (a pending pause) enabled with one: both keep it.
		for (const enabled of [false, true]) {
			const row = scheduleRow("A", { enabled, pause: first, due: { at: AT }, current });
			const next = pausedKeeping(row, "job_failed", AT, "J9");
			expect(next).toMatchObject({ enabled: false, pause: first });
			expect(next).not.toHaveProperty("due");
			expect(next).not.toHaveProperty("current");
		}
		// A pause with no job keeps having none.
		const bare = pausedKeeping(
			scheduleRow("A", { pause: { reason: "creator_gone", at: earlier } }),
			"cancelled",
			AT,
			"J9",
		);
		expect(bare.pause).toEqual({ reason: "creator_gone", at: earlier });
		// A schedule an Admin disabled without a pause takes the new one.
		const off = scheduleRow("A", { enabled: false });
		expect(pausedKeeping(off, "job_failed", AT, "J9").pause).toEqual({
			reason: "job_failed",
			at: AT,
			jobId: "J9",
		});
		// A route's pause replaces it (preflight F7).
		const row = scheduleRow("A", { enabled: false, pause: first, due: { at: AT }, current });
		const routed = paused(row, "cancelled", AT, "J9");
		expect(routed).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", at: AT, jobId: "J9" },
		});
		expect(routed).not.toHaveProperty("due");
		expect(routed).not.toHaveProperty("current");
	});

	it("replaces the pause when a route pauses a paused schedule, and marks the run (preflight F7)", async () => {
		const { deps } = await scheduleDeps();
		const run: RunEntry = { jobId: "J1", at: AT, outcome: "failed", counters: zero };
		const first = { reason: "job_failed", at: "2026-11-17T10:00:00.000Z", jobId: "J1" } as const;
		await deps.schedules.put("A", scheduleRow("A", { enabled: false, pause: first, runs: [run] }));
		const mark = (r: ScheduleRow) => withRollback(r, "J1", "R1", AT);
		expect(await pauseSchedule(deps, "A", "rolled_back", "J1", mark)).toBe(true);
		expect(await deps.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", at: AT, jobId: "J1" },
			runs: [{ ...run, rolledBack: { by: "R1", at: AT } }],
		});
	});

	it("retries a pause that lost its compare-and-set, and gives up after WRITE_ATTEMPTS", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await deps.schedules.put("A", scheduleRow("A"));
		const cas = deps.schedules.compareAndSet.bind(deps.schedules);
		let losses = 1;
		deps.schedules.compareAndSet = async (id, revision, data) => {
			if (losses-- > 0) {
				// A due mark lands between the pause's read and its write.
				const row = (await deps.schedules.get(id)) as ScheduleRow;
				await deps.schedules.put(id, { ...row, due: { at: AT } });
			}
			return cas(id, revision, data);
		};
		expect(await pauseSchedule(deps, "A", "cancelled", "J1")).toBe(true);
		const row = await deps.schedules.get("A");
		expect(row).toMatchObject({ enabled: false, pause: { reason: "cancelled", jobId: "J1" } });
		expect(row).not.toHaveProperty("due");
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		losses = Number.POSITIVE_INFINITY;
		expect(await pauseSchedule(deps, "A", "rolled_back", "J1")).toBe(false);
		expect(await deps.schedules.get("A")).toMatchObject({ pause: { reason: "cancelled" } });
		expect(deps.cron.tasks.has("schedule-A")).toBe(true);
	});

	it("pins a source's URL and credential name, not its name (spec Ruling 40)", async () => {
		const plain = sourceRow("S1");
		const pin = await sourcePinOf(plain);
		expect(pin).toBe(await pinOf(plain.url));
		expect(await sourcePinOf({ ...plain, name: "Renamed" } as typeof plain)).toBe(pin);
		const keyed = await sourcePinOf({ ...plain, credential: "key-a" });
		expect(keyed).not.toBe(pin);
		// A renamed credential is another pin, so the launch pauses source_changed (Task 4).
		expect(await sourcePinOf({ ...plain, credential: "key-b" })).not.toBe(keyed);
		expect(await sourcePinOf({ ...plain, url: "https://feeds.example/other.csv" })).not.toBe(pin);
		const pinned = [scheduleRow("A", { name: "Nightly", sourcePin: keyed })];
		const renamed = await sourcePinOf({ ...plain, credential: "key-b" });
		expect(sourceWarnings(pinned, renamed)).toEqual([
			"Schedule Nightly (A) pins this source's URL and credential; it pauses at its next run until it is enabled again",
		]);
	});

	it("names the schedules that use a template or source, and warns about the ones an edit pauses", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		const hourly = { name: "Hourly", templateId: "T2", sourceId: "S2", sourcePin: "p2" };
		await deps.schedules.put("B", scheduleRow("B", hourly));
		const byTemplate = await schedulesUsing(deps.schedules, { templateId: "T1" });
		expect(byTemplate.map((s) => s.id)).toEqual(["A"]);
		expect(inUse("Template", "T1", byTemplate)).toMatchObject({
			code: "TEMPLATE_IN_USE",
			status: 409,
			message: "Template T1 is used by schedule(s) Nightly; delete or change them first",
			details: { scheduleIds: ["A"] },
		});
		expect(templateWarnings(byTemplate, 2)).toEqual([
			"Schedule Nightly (A) runs revision 1; update it to run this revision",
		]);
		expect(templateWarnings(byTemplate, 1)).toEqual([]);
		const bySource = await schedulesUsing(deps.schedules, { sourceId: "S2" });
		expect(inUse("Source", "S2", bySource).code).toBe("SOURCE_IN_USE");
		expect(sourceWarnings(bySource, "p3")).toEqual([
			"Schedule Hourly (B) pins this source's URL and credential; it pauses at its next run until it is enabled again",
		]);
		expect(sourceWarnings(bySource, "p2")).toEqual([]);
	});

	it("reopens a finalized scheduled job that is resumed or retried, and arms the pump (plan Ruling 11)", async () => {
		const { deps } = await scheduleDeps();
		const closed = {
			status: "running",
			origin: "schedule",
			scheduleId: "A",
			scheduled: "closed",
		} as const;
		await deps.jobs.put("J1", jobRow("J1", closed));
		await deps.jobs.put("J2", jobRow("J2", { status: "running" }));
		await deps.jobs.put("J3", jobRow("J3", { status: "running", scheduled: "closed" }));
		await reopenScheduled(deps.jobs, deps.cron, "J1");
		await reopenScheduled(deps.jobs, deps.cron, "J2");
		await reopenScheduled(deps.jobs, deps.cron, "J3");
		expect(await deps.jobs.get("J1")).toMatchObject({ scheduled: "open" });
		expect(await deps.jobs.get("J2")).not.toHaveProperty("scheduled");
		expect(await deps.jobs.get("J3")).toMatchObject({ scheduled: "closed" });
		expect(deps.cron.calls).toEqual([`schedule ${PUMP_TASK} ${PUMP_SCHEDULE}`]);
	});
});
