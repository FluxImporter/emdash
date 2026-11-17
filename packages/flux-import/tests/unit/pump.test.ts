import { describe, expect, it } from "vitest";
import type { Fence } from "../../src/emdash/fence.js";
import type { Job } from "../../src/engine/types.js";
import type { JobRequest } from "../../src/plugin/job-templates.js";
import { type PumpDeps, pumpTick } from "../../src/plugin/pump.js";
import {
	PUMP_SCHEDULE,
	PUMP_TASK,
	type RunEntry,
	type ScheduleRow,
	sourcePinOf,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { setup as engineSetup, importRows } from "./rollback-fixture.js";
import { jobRow, NOW, scheduleDeps, scheduleRow, sourceRow } from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();
/** When schedule A was last changed by a route: before its jobs finished (preflight F10). */
const ARMED = "2026-11-17T10:00:00.000Z";
const zero = {
	created: 0,
	updated: 0,
	unchanged: 0,
	failed: 0,
	conflict: 0,
	locked: 0,
	removed: 0,
};
const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;

/**
 * The pump's dependencies over `scheduleDeps`, with schedule A (on T1 and S1, pinned, armed by
 * the Admin at `ARMED`), a fence the test sets, and a batch that records its calls and completes
 * the job.
 */
async function setup(extra: Partial<ScheduleRow> = {}) {
	const { deps: base, clock } = await scheduleDeps();
	const state = { fence: "clear" as Fence };
	const batches: [string, string][] = [];
	const requests: JobRequest[] = [];
	const cleared: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const cancelled: string[] = [];
	let ids = 0;
	const deps: PumpDeps = {
		schedules: base.schedules,
		jobs: base.jobs,
		templates: base.templates,
		sources: base.sources,
		cron: base.cron,
		userRole: async (id) => (id === "admin" ? 50 : null),
		create: async (request) => {
			requests.push(request);
			const job = jobRow(request.id ?? "", { ...open, scheduleId: request.scheduleId ?? "" });
			await base.jobs.put(job.id, job);
			return job;
		},
		cancel: async (jobId) => {
			cancelled.push(jobId);
		},
		warn: (message) => {
			warnings.push(message);
		},
		now: () => clock.t,
		newId: () => `N${++ids}`,
		fence: async () => state.fence,
		batch: async (id, holder) => {
			batches.push([id, holder]);
			const job = (await base.jobs.get(id)) as Job;
			const done = { ...job, status: "completed" as const, cursor: { offset: 9, seq: 1 } };
			await base.jobs.put(id, done);
			return done;
		},
		clearLastImport: async (sourceId, jobId) => {
			cleared.push(`${sourceId}/${jobId}`);
		},
		error: (message) => {
			errors.push(message);
		},
	};
	const sourcePin = await sourcePinOf(sourceRow("S1"));
	const armed = { createdAt: ARMED, updatedAt: ARMED };
	await base.schedules.put("A", scheduleRow("A", { sourcePin, ...armed, ...extra }));
	await base.cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
	const row = async (id = "A") => (await base.schedules.get(id)) as ScheduleRow;
	return { deps, base, clock, state, batches, requests, cleared, errors, warnings, cancelled, row };
}

/** A finished scheduled job of schedule A that read one record. */
const finished = (id: string, extra: Partial<Job> = {}) =>
	jobRow(id, { ...open, status: "completed", cursor: { offset: 9, seq: 1 }, ...extra });

describe('pumpTick (spec "The pump")', () => {
	it.each(["import", "export", "media", "error"] as const)(
		"stands down while the site fence reads %s: no finalization, batch, launch or write",
		async (fence) => {
			const t = await setup({ due: { at: AT } });
			t.state.fence = fence;
			await t.base.jobs.put("J1", finished("J1"));
			await t.base.jobs.put("J2", jobRow("J2", open));
			expect(await pumpTick(t.deps)).toEqual({ fence, finalized: [] });
			expect(t.batches).toEqual([]);
			expect(t.requests).toEqual([]);
			expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "open" });
			expect((await t.row()).due).toEqual({ at: AT });
		},
	);

	it("finalizes at most two finished jobs per tick", async () => {
		const t = await setup();
		for (const id of ["J1", "J2", "J3"]) await t.base.jobs.put(id, finished(id));
		expect((await pumpTick(t.deps)).finalized).toHaveLength(2);
		// A tick that finalized is not idle, even with nothing left open.
		const second = await pumpTick(t.deps);
		expect(second.finalized).toHaveLength(1);
		expect(second).not.toHaveProperty("idle");
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(true);
		expect((await t.row()).runs.map((r) => r.jobId).sort()).toEqual(["J1", "J2", "J3"]);
		expect((await pumpTick(t.deps)).idle).toBe("cancelled");
	});

	it.each([
		["completed", {}, undefined],
		["empty_feed", { cursor: { offset: 0, seq: 0 } }, "empty_feed"],
		[
			"missing_refused",
			{
				missing: {
					stage: "done",
					fromSeq: 1,
					owned: 9,
					found: 9,
					rows: 0,
					removed: 0,
					verdict: "refused",
				},
			},
			"missing_refused",
		],
		["failed", { status: "failed" }, "job_failed"],
		["cancelled", { status: "cancelled" }, "cancelled"],
	] as const)("finalizes a job as %s", async (outcome, extra, reason) => {
		const t = await setup();
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const counters = { ...jobRow("x").counters, created: 2, removed: 1 };
		await t.base.jobs.put(
			"J1",
			finished("J1", { counters, sourceId: "S1", ...(extra as Partial<Job>) }),
		);
		await pumpTick(t.deps);
		const row = await t.row();
		const entry: RunEntry = {
			jobId: "J1",
			at: "2026-11-17T11:00:00.000Z",
			outcome,
			counters: { ...zero, created: 2, removed: 1 },
		};
		expect(row.runs).toEqual([entry]);
		if (reason === undefined) {
			expect(row).toMatchObject({ enabled: true });
			expect(t.base.cron.tasks.has("schedule-A")).toBe(true);
		} else {
			expect(row).toMatchObject({ enabled: false, pause: { reason, at: AT, jobId: "J1" } });
			expect(t.base.cron.tasks.has("schedule-A")).toBe(false);
		}
		expect(t.cleared).toEqual(outcome === "failed" ? ["S1/J1"] : []);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
	});

	it("repeats a rollback's pause and marks the run rolled back (plan Ruling 12)", async () => {
		const t = await setup();
		await t.base.jobs.put("R1", jobRow("R1", { kind: "rollback", createdAt: AT }));
		await t.base.jobs.put("J1", finished("J1", { rolledBackBy: "R1" }));
		await pumpTick(t.deps);
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", jobId: "J1" },
			runs: [{ jobId: "J1", outcome: "completed", rolledBack: { by: "R1", at: AT } }],
		});
	});

	it("writes a run log entry once, replaces it when the outcome changed, and keeps 20 (plan Ruling 11)", async () => {
		const older: RunEntry[] = Array.from({ length: 20 }, (_, i) => ({
			jobId: `OLD${i}`,
			at: AT,
			outcome: "completed",
			counters: zero,
		}));
		const t = await setup({ runs: older });
		await t.base.jobs.put("J1", finished("J1"));
		await pumpTick(t.deps);
		const first = await t.base.schedules.getVersioned("A");
		expect(first?.value.runs).toHaveLength(20);
		expect(first?.value.runs[0]).toMatchObject({ jobId: "J1", outcome: "completed" });
		expect(first?.value.runs.at(-1)?.jobId).toBe("OLD18");
		// A crash between the schedule write and the close: the same entry is not written again.
		await t.base.jobs.put("J1", finished("J1"));
		await pumpTick(t.deps);
		expect((await t.base.schedules.getVersioned("A"))?.revision).toBe(first?.revision);
		// Retried and failed: the entry is replaced at the head.
		await t.base.jobs.put("J1", finished("J1", { status: "failed" }));
		await pumpTick(t.deps);
		const runs = (await t.row()).runs;
		expect(runs.filter((r) => r.jobId === "J1")).toEqual([
			expect.objectContaining({ outcome: "failed" }),
		]);
		expect(runs[0]?.jobId).toBe("J1");
	});

	it("leaves the job open when the schedule write lost every attempt, and finalizes it next tick", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", finished("J1"));
		const cas = t.base.schedules.compareAndSet.bind(t.base.schedules);
		t.base.schedules.compareAndSet = async () => ({ applied: false as const });
		await pumpTick(t.deps);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "open" });
		expect((await t.row()).runs).toEqual([]);
		t.base.schedules.compareAndSet = cas;
		expect((await pumpTick(t.deps)).finalized).toEqual(["J1"]);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
		expect((await t.row()).runs.map((r) => r.jobId)).toEqual(["J1"]);
	});

	it("closes a job whose schedule no longer exists, and leaves a job that runs again open", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", finished("J1", { scheduleId: "GONE" }));
		await pumpTick(t.deps);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
		// Finalization reads the job as finished; a retry makes it run again before the close.
		await t.base.jobs.put("J2", finished("J2"));
		const getVersioned = t.base.jobs.getVersioned.bind(t.base.jobs);
		t.base.jobs.getVersioned = async (id) => {
			const read = await getVersioned(id);
			return read && id === "J2" ? { ...read, value: { ...read.value, status: "running" } } : read;
		};
		await pumpTick(t.deps);
		expect(await t.base.jobs.get("J2")).toMatchObject({ scheduled: "open" });
	});

	it("runs one batch of the oldest open job under a schedule holder, and launches nothing that tick", async () => {
		const t = await setup({ due: { at: AT } });
		await t.base.jobs.put("J1", jobRow("J1", { ...open, createdAt: "2026-11-17T11:00:02.000Z" }));
		await t.base.jobs.put(
			"J2",
			jobRow("J2", { ...open, status: "running", createdAt: "2026-11-17T11:00:01.000Z" }),
		);
		const tick = await pumpTick(t.deps);
		expect(tick).toEqual({ fence: "clear", finalized: [], batch: "J2" });
		expect(t.batches).toEqual([["J2", "schedule:A:N1"]]);
		expect(t.requests).toEqual([]);
	});

	it("treats a live lease as no batch and launches the schedule due the longest (plan Ruling 4)", async () => {
		const t = await setup({ due: { at: "2026-11-17T03:00:00.000Z" } });
		const sourcePin = (await t.row()).sourcePin;
		await t.base.schedules.put(
			"B",
			scheduleRow("B", { sourcePin, due: { at: "2026-11-17T02:00:00.000Z" } }),
		);
		const lease = { holder: "admin:x", expiresAt: NOW + 30_000 };
		await t.base.jobs.put(
			"J1",
			jobRow("J1", { ...open, status: "running", lease, feedSourceId: "S9" }),
		);
		const tick = await pumpTick(t.deps);
		expect(t.batches).toEqual([]);
		expect(tick.launch).toEqual({ scheduleId: "B", outcome: "started" });
		expect(t.requests.map((r) => r.scheduleId)).toEqual(["B"]);
	});

	it("neither finalizes nor batches a paused open job, and keeps the pump while it is open", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", jobRow("J1", { ...open, status: "paused" }));
		expect(await pumpTick(t.deps)).toEqual({ fence: "clear", finalized: [] });
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("logs a batch error, which still counts as the tick's unit", async () => {
		const t = await setup({ due: { at: AT } });
		await t.base.jobs.put("J1", jobRow("J1", open));
		t.deps.batch = async () => {
			throw new Error("D1_ERROR: too many SQL variables");
		};
		expect((await pumpTick(t.deps)).batch).toBe("J1");
		expect(t.errors).toEqual([
			"flux-import: scheduled job J1: batch failed: D1_ERROR: too many SQL variables",
		]);
		expect(t.requests).toEqual([]);
	});

	it("cancels itself when idle, and re-arms when a schedule became due meanwhile (spec Ruling 36)", async () => {
		const t = await setup();
		expect((await pumpTick(t.deps)).idle).toBe("cancelled");
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(false);
		await t.base.cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
		const cancel = t.base.cron.cancel.bind(t.base.cron);
		t.base.cron.cancel = async (name) => {
			await cancel(name);
			await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, due: { at: AT } }));
		};
		expect((await pumpTick(t.deps)).idle).toBe("rearmed");
		expect(t.base.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
	});

	it("ignores a disabled schedule's due mark (plan Ruling 6)", async () => {
		const t = await setup({ enabled: false, due: { at: AT } });
		const tick = await pumpTick(t.deps);
		expect(tick).toEqual({ fence: "clear", finalized: [], idle: "cancelled" });
		expect(t.requests).toEqual([]);
	});

	it("removes nothing on an empty feed at a 100 % threshold, and pauses empty_feed (Fact E2, spec Ruling 45)", async () => {
		const engine = engineSetup().deps;
		const rules = { rules: { owner: "shop", missing: { action: "trash", maxPercent: 100 } } };
		await importRows(engine, [{ sku: "A1", name: "Desk" }], { extra: rules, sourceId: "S1" });
		const empty = await importRows(engine, [], { extra: rules, sourceId: "S1" });
		expect(empty.missing).toMatchObject({ verdict: "skipped" });
		expect(empty.counters.removed ?? 0).toBe(0);
		expect([...engine.content.entries.values()].every((e) => !e.trashed)).toBe(true);
		const t = await setup();
		await t.base.jobs.put(empty.id, { ...empty, ...open });
		await pumpTick(t.deps);
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason: "empty_feed", jobId: empty.id },
			runs: [{ jobId: empty.id, outcome: "empty_feed" }],
		});
	});

	it("leaves a job that is not a schedule's alone: no run, no batch, closed (preflight F8)", async () => {
		const t = await setup({ due: { at: AT } });
		const done = { status: "completed", cursor: { offset: 9, seq: 1 } } as const;
		const agent = { origin: "agent", scheduleId: "A", scheduled: "open" } as const;
		await t.base.jobs.put("G1", jobRow("G1", { ...agent, ...done }));
		await t.base.jobs.put(
			"G2",
			jobRow("G2", { scheduleId: "A", scheduled: "open", status: "running" }),
		);
		expect(await pumpTick(t.deps)).toEqual({ fence: "clear", finalized: [], closed: ["G1", "G2"] });
		expect(t.batches).toEqual([]);
		expect(t.requests).toEqual([]);
		expect(await t.row()).toMatchObject({ enabled: true, runs: [], due: { at: AT } });
		expect(await t.base.jobs.get("G1")).toMatchObject({ status: "completed", scheduled: "closed" });
		expect(await t.base.jobs.get("G2")).toMatchObject({ status: "running", scheduled: "closed" });
		expect(t.warnings).toEqual([
			"flux-import: job G1 is open to the pump but no schedule launched it; closed without a run",
			"flux-import: job G2 is open to the pump but no schedule launched it; closed without a run",
		]);
		// Nothing of theirs is open any more: the next tick launches.
		expect((await pumpTick(t.deps)).launch).toEqual({ scheduleId: "A", outcome: "started" });
	});

	it.each([
		["cancelled", { status: "cancelled" }, {}],
		["rolled back", {}, { rolledBackBy: "R1" }],
	] as const)(
		"does not repeat a %s job's pause on a schedule re-enabled after it, and logs the run (preflight F10)",
		async (_what, status, rollback) => {
			const t = await setup({ updatedAt: "2026-11-17T11:00:00.001Z" });
			await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
			await t.base.jobs.put("R1", jobRow("R1", { kind: "rollback", createdAt: AT }));
			await t.base.jobs.put("J1", finished("J1", { ...status, ...rollback }));
			await pumpTick(t.deps);
			const row = await t.row();
			expect(row.enabled).toBe(true);
			expect(row).not.toHaveProperty("pause");
			expect(row.runs.map((r) => r.jobId)).toEqual(["J1"]);
			expect(t.base.cron.tasks.has("schedule-A")).toBe(true);
			expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
		},
	);

	it.each([
		["job_failed", { status: "failed" }],
		["empty_feed", { cursor: { offset: 0, seq: 0 } }],
	] as const)(
		"pauses %s even on a schedule changed after the job (only a route's pause is repeated)",
		async (reason, extra) => {
			const t = await setup({ updatedAt: AT });
			await t.base.jobs.put("J1", finished("J1", extra));
			await pumpTick(t.deps);
			expect(await t.row()).toMatchObject({ enabled: false, pause: { reason, jobId: "J1" } });
		},
	);

	it("repeats a cancel's pause on a schedule last changed when the job was", async () => {
		const t = await setup({ updatedAt: "2026-11-17T11:00:00.000Z" });
		await t.base.jobs.put("J1", finished("J1", { status: "cancelled" }));
		await pumpTick(t.deps);
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", jobId: "J1" },
		});
	});

	it.each([
		["a failed job", "failed", ["S1/J1"]],
		["the repeat of a cancel's pause", "cancelled", []],
	] as const)(
		"keeps a rolled_back pause already on the schedule on %s (an automatic pause)",
		async (_what, status, cleared) => {
			const first = { reason: "rolled_back", at: ARMED, jobId: "J0" } as const;
			const t = await setup({ enabled: false, pause: first });
			await t.base.jobs.put("J1", finished("J1", { status, sourceId: "S1" }));
			await pumpTick(t.deps);
			expect(await t.row()).toMatchObject({
				enabled: false,
				pause: first,
				runs: [{ jobId: "J1", outcome: status }],
			});
			expect(t.cleared).toEqual(cleared);
			expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
		},
	);
});
