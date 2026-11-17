import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmDashUploads } from "../../src/emdash/uploads.js";
import type { EngineDeps, Job } from "../../src/engine/types.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import {
	RETENTION_QUERY_TARGET,
	RETENTION_SCHEDULE,
	RETENTION_TASK,
} from "../../src/plugin/retention.js";
import { activate, cronHook } from "../../src/plugin/scheduler.js";
import {
	PUMP_SCHEDULE,
	PUMP_TASK,
	type ScheduleRow,
	sourcePinOf,
} from "../../src/plugin/schedules.js";
import { stagePaste } from "../../src/plugin/service.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { FakeContent, FakeStorage, MemoryKv, makeDeps } from "./fakes.js";
import { FakeCron, jobRow, NOW, savedTemplate, scheduleRow, sourceRow } from "./schedule-fakes.js";

// As scheduled-actor.test.ts: the runtime and plugin storage are the engine's fakes; the fence
// reads clear (its query is fence.test.ts's). The port constructors record whom they were built
// for (spec Rulings 4, 5), and a URL source is never fetched: jobFromSource stages a paste and
// creates the job from it, as the real one does with the fetched file.
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	storage: undefined as unknown,
	actors: [] as unknown[],
	authors: [] as unknown[],
	/** withRuntime calls: activate must make none (preflight F5). */
	runtimes: 0,
}));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) => {
		state.runtimes++;
		return run({
			storage: state.storage,
			config: { maxUploadSize: 1000 },
			db: {},
			schemaRegistry: {
				getCollectionWithFields: async (slug: string) =>
					slug === "products"
						? { fields: [{ slug: "title", type: "string" }], supports: [] }
						: null,
			},
		});
	},
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/fence.js", () => ({ readFence: async () => "clear" }));
vi.mock("../../src/emdash/content.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/content.js")>()),
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashContent: function (_runtime: unknown, actor: unknown) {
		state.actors.push(actor);
		// Any actor but null writes through a port the test never reads: the batch would fail.
		return actor === null ? (state.deps as Record<string, unknown>).content : new FakeContent();
	},
}));
vi.mock("../../src/emdash/lookups.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashLookups: function () {
		return (state.deps as Record<string, unknown>).lookups;
	},
}));
vi.mock("../../src/emdash/media.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashMedia: function (_runtime: unknown, authorId: unknown) {
		state.authors.push(authorId);
		return (state.deps as Record<string, unknown>).media;
	},
}));
vi.mock("../../src/plugin/sources.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/plugin/sources.js")>();
	return {
		...actual,
		jobFromSource: async (
			_deps: unknown,
			sourceId: string,
			_options: unknown,
			create: (uploadId: string, sourceId: string) => Promise<Job>,
		) => {
			const { stagePaste: stage } = await import("../../src/plugin/service.js");
			const { uploadId } = await stage(state.storage as never, "sku,Name\nA,One\nB,Two\n");
			return create(uploadId, sourceId);
		},
	};
});

const UPLOAD = `01JZ5V6Q8X0000000000000000${"ab".repeat(16)}`;

let cron: FakeCron;
let schedules: MemoryKv<ScheduleRow>;
let sources: MemoryKv<SourceRow>;
let templates: MemoryKv<SavedTemplate>;
let engine: EngineDeps & { jobs: MemoryKv<Job> };
const logs: string[] = [];
const logData: { message: string; data: unknown }[] = [];

beforeEach(() => {
	const storage = new FakeStorage();
	state.storage = storage;
	// The batch reads the staged file through EmDashUploads, as the services' uploads do.
	engine = {
		...makeDeps({ clock: { t: NOW } }).deps,
		jobs: new MemoryKv<Job>(STORAGE.jobs.indexes),
		source: new EmDashUploads(storage),
	};
	state.deps = engine;
	state.actors = [];
	state.authors = [];
	state.runtimes = 0;
	cron = new FakeCron();
	schedules = new MemoryKv(STORAGE.schedules.indexes);
	sources = new MemoryKv(STORAGE.sources.indexes);
	templates = new MemoryKv(STORAGE.templates.indexes);
	logs.length = 0;
	logData.length = 0;
});

function context(role: number | null = null) {
	const log = (level: string) => (message: string, data?: unknown) => {
		logs.push(`${level}: ${message}`);
		logData.push({ message, data });
	};
	return {
		storage: { schedules, sources, templates },
		cron,
		kv: { get: async () => null, set: async () => {}, delete: async () => false },
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
		users: { get: async () => (role === null ? null : { id: "admin", role }) },
		log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
	} as never;
}

const event = (name: string) => ({ name, scheduledAt: new Date(NOW).toISOString() });

/** The data last logged with `message`. */
const dataOf = (message: string) => logData.findLast((l) => l.message === message)?.data;

describe('cronHook (spec "Cron tasks and the hook")', () => {
	it("marks a schedule due from its task, and ignores a task it does not know", async () => {
		await schedules.put("A", scheduleRow("A"));
		await cronHook(event("schedule-A"), context());
		expect((await schedules.get("A"))?.due).toEqual({ at: new Date(NOW).toISOString() });
		expect(cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		await cronHook(event("something-else"), context());
		expect(cron.calls).toEqual([`schedule ${PUMP_TASK} ${PUMP_SCHEDULE}`]);
		// A due mark needs no runtime.
		expect(state.runtimes).toBe(0);
	});

	it("runs retention with its bounds, then reconciles the tasks", async () => {
		await schedules.put("A", scheduleRow("A"));
		await cron.schedule(RETENTION_TASK, { schedule: "0 3 * * *" });
		await cronHook(event(RETENTION_TASK), context());
		expect(logs).toContain("info: Removed expired import data");
		expect(cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
		expect(cron.tasks.get("schedule-A")).toEqual({
			schedule: "0 3 * * *",
			data: { scheduleId: "A" },
		});
		expect(dataOf("Repaired the schedule tasks")).toEqual({
			scheduled: ["schedule-A"],
			cancelled: [],
			failed: [],
			pump: false,
			retention: true,
		});
	});

	it("passes the bounds: a job a launch claim names survives, and the run counts its queries", async () => {
		const old = "2020-01-01T00:00:00.000Z";
		await engine.jobs.put(
			"J1",
			jobRow("J1", { status: "completed", createdAt: old, uploadId: UPLOAD }),
		);
		await engine.jobs.put(
			"J2",
			jobRow("J2", { status: "completed", createdAt: old, uploadId: UPLOAD }),
		);
		await schedules.put("A", scheduleRow("A", { current: { jobId: "J1", claimedAt: old } }));
		await cronHook(event(RETENTION_TASK), context());
		expect(await engine.jobs.get("J1")).not.toBeNull();
		expect(await engine.jobs.get("J2")).toBeNull();
		expect(dataOf("Removed expired import data")).toMatchObject({
			jobs: 1,
			queries: expect.any(Number),
		});
	});

	it("stops at the query target, and keeps each source's latest fetch", async () => {
		const storage = state.storage as FakeStorage;
		storage.now = () => new Date("2020-01-01T00:00:00.000Z");
		const kept = await stagePaste(storage, "sku\nA\n");
		const dropped = await stagePaste(storage, "sku\nB\n");
		await sources.put("S1", sourceRow("S1", { lastFetch: { uploadId: kept.uploadId } as never }));
		for (let i = 0; i < 40; i++) {
			const id = `J${String(i).padStart(2, "0")}`;
			const old = "2020-01-01T00:00:00.000Z";
			await engine.jobs.put(
				id,
				jobRow(id, { status: "completed", createdAt: old, uploadId: UPLOAD }),
			);
		}
		await cronHook(event(RETENTION_TASK), context());
		const result = dataOf("Removed expired import data") as { more?: true; queries: number };
		expect(result.more).toBe(true);
		expect(result.queries).toBeLessThanOrEqual(RETENTION_QUERY_TARGET + 1);
		expect(engine.jobs.rows.size).toBeGreaterThan(0);
		const files = [...storage.files.keys()].join(" ");
		expect(files).toContain(kept.uploadId);
		expect(files).not.toContain(dropped.uploadId);
	});

	it("reads retentionDays: a job inside the setting's window is kept", async () => {
		const old = "2020-01-01T00:00:00.000Z";
		await engine.jobs.put(
			"J1",
			jobRow("J1", { status: "completed", createdAt: old, uploadId: UPLOAD }),
		);
		const ctx = context() as unknown as Record<string, unknown>;
		const settings = { get: async (key: string) => (key === "retentionDays" ? 3650 : undefined) };
		await cronHook(event(RETENTION_TASK), { ...ctx, settings } as never);
		expect(await engine.jobs.get("J1")).not.toBeNull();
		expect(dataOf("Removed expired import data")).toMatchObject({ jobs: 0 });
	});

	it("logs a repair whose only change is a task EmDash refused, by schedule ID", async () => {
		await cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
		await schedules.put("A", scheduleRow("A", { cron: "0 4 * * *" }));
		cron.refuse = "0 4 * * *";
		await cronHook(event(RETENTION_TASK), context());
		expect(dataOf("Repaired the schedule tasks")).toEqual({
			scheduled: [],
			cancelled: [],
			failed: ["A"],
			pump: false,
			retention: false,
		});
	});

	it("logs nothing to repair when every task is in place", async () => {
		await cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
		await cronHook(event(RETENTION_TASK), context());
		expect(logs).toEqual(["info: Removed expired import data"]);
	});

	it("warns when retention skips its deletes, and still reconciles", async () => {
		for (let i = 0; i < 1_001; i++) {
			const id = `J${String(i).padStart(4, "0")}`;
			await engine.jobs.put(
				id,
				jobRow(id, { status: "completed", createdAt: "2020-01-01", uploadId: UPLOAD }),
			);
		}
		await cronHook(event(RETENTION_TASK), context());
		expect(logs.filter((l) => l.startsWith("warn:"))).toEqual([
			"warn: flux-import: retention deleted nothing: more than 1000 jobs are kept; lower retentionDays",
		]);
		expect(await engine.jobs.get("J0000")).not.toBeNull();
		expect(cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
	});

	it("runs a pump tick with the scheduled services, which cancels an idle pump", async () => {
		await cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
		await cronHook(event(PUMP_TASK), context());
		expect(cron.tasks.has(PUMP_TASK)).toBe(false);
		// withScheduledServices: no actor on the content port, no author on the media port.
		expect(state.actors).toEqual([null]);
		expect(state.authors).toEqual([null]);
		// An idle tick is not logged.
		expect(logs).toEqual([]);
	});

	it("launches a due schedule as the schedule's job, then runs its batch with no actor", async () => {
		await templates.put("T1", savedTemplate("T1"));
		await sources.put("S1", sourceRow("S1"));
		const pin = await sourcePinOf(sourceRow("S1"));
		const at = new Date(NOW).toISOString();
		await schedules.put("A", scheduleRow("A", { sourcePin: pin, due: { at } }));
		await cronHook(event(PUMP_TASK), context(50));
		const launched = (await schedules.get("A"))?.lastLaunch;
		expect(launched).toMatchObject({ outcome: "started" });
		const jobId = launched?.jobId ?? "";
		expect(await engine.jobs.get(jobId)).toMatchObject({
			origin: "schedule",
			scheduled: "open",
			scheduleId: "A",
			feedSourceId: "S1",
			sourceId: "S1",
			dryRun: false,
			journal: true,
		});
		expect(dataOf("Pump tick")).toMatchObject({ launch: { scheduleId: "A", outcome: "started" } });

		await cronHook(event(PUMP_TASK), context(50));
		const job = await engine.jobs.get(jobId);
		expect(job?.counters.created).toBe(2);
		// Both ticks built their services with no actor, and the writes went through that port.
		expect(state.actors).toEqual([null, null]);
		expect(state.authors).toEqual([null, null]);
		const calls = (engine.content as FakeContent).calls;
		expect(calls.filter((c) => c.startsWith("create:"))).toHaveLength(2);
		expect(dataOf("Pump tick")).toMatchObject({ batch: jobId });
	});

	it("logs a pump tick that only closed a job no schedule launched", async () => {
		await cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
		await engine.jobs.put("J1", jobRow("J1", { status: "completed", scheduled: "open" }));
		await cronHook(event(PUMP_TASK), context());
		expect(dataOf("Pump tick")).toMatchObject({ closed: ["J1"], finalized: [] });
		expect((await engine.jobs.get("J1"))?.scheduled).toBe("closed");
	});

	it("logs and rethrows an unexpected error", async () => {
		const ctx = { ...(context() as object), storage: {} } as never;
		await expect(cronHook(event("schedule-A"), ctx)).rejects.toThrow(
			"the schedules storage collection is missing",
		);
		expect(logs).toEqual(["error: flux-import: cron task schedule-A failed"]);
		expect(logData[0]?.data).toEqual({
			error: "flux-import: the schedules storage collection is missing",
		});
	});

	it("logs an unexpected error's message redacted (preflight F12)", async () => {
		const failing = {
			getVersioned: async () => {
				throw new Error(`read flux-import-upload-${UPLOAD}.csv failed`);
			},
		};
		const ctx = { ...(context() as object), storage: { schedules: failing } } as never;
		await expect(cronHook(event("schedule-A"), ctx)).rejects.toThrow(UPLOAD);
		expect(logData[0]?.data).toEqual({ error: "read [staged file] failed" });
		expect(JSON.stringify(logData)).not.toContain(UPLOAD);
	});
});

describe("activate", () => {
	it("reconciles the tasks: retention hourly, each enabled schedule's task", async () => {
		await schedules.put("A", scheduleRow("A"));
		await activate(context());
		expect([...cron.tasks.keys()].sort()).toEqual([RETENTION_TASK, "schedule-A"].sort());
		expect(cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
	});

	it("never reaches the runtime (preflight F5), and arms the pump for an open job", async () => {
		await engine.jobs.put("J1", jobRow("J1", { origin: "schedule", scheduled: "open" }));
		await activate(context());
		expect(state.runtimes).toBe(0);
		expect(state.actors).toEqual([]);
		expect(cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
	});

	it("logs the schedules whose task failed, by ID only", async () => {
		await schedules.put("A", scheduleRow("A", { cron: "0 4 * * *" }));
		await schedules.put("B", scheduleRow("B"));
		cron.refuse = "0 4 * * *";
		await activate(context());
		expect(logs).toEqual(["warn: flux-import: 1 schedule task(s) could not be scheduled"]);
		expect(logData[0]?.data).toEqual({ failed: ["A"] });
		expect(cron.tasks.has("schedule-B")).toBe(true);
	});

	it("logs nothing when every task is in place", async () => {
		await activate(context());
		await activate(context());
		expect(logs).toEqual([]);
	});
});

describe("the plugin's hooks", () => {
	const plugin = createPlugin();

	it("activates through activate and dispatches cron events through cronHook", async () => {
		await schedules.put("A", scheduleRow("A"));
		await plugin.hooks["plugin:activate"]?.handler({} as never, context());
		expect(cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
		expect(cron.tasks.has("schedule-A")).toBe(true);
		await plugin.hooks.cron?.handler(event("schedule-A"), context());
		expect((await schedules.get("A"))?.due).toEqual({ at: new Date(NOW).toISOString() });
	});
});
