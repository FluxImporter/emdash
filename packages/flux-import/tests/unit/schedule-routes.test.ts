import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../../src/engine/fingerprints.js";
import type { Job } from "../../src/engine/types.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { RETENTION_TASK } from "../../src/plugin/retention.js";
import { SCHEDULE_BODY_MAX_BYTES } from "../../src/plugin/routes.js";
import { PUMP_TASK, type ScheduleRow, type ScheduleView } from "../../src/plugin/schedules.js";
import type { Page } from "../../src/plugin/service.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedResult, SavedTemplate } from "../../src/plugin/templates.js";
import { FakeStorage, MemoryKv } from "./fakes.js";
import { type Deps, importRows, setup } from "./rollback-fixture.js";
import {
	FakeCron,
	jobRow,
	OWNED,
	savedTemplate,
	scheduleRow,
	sourceRow,
} from "./schedule-fakes.js";

// As agent-routes.test.ts: the runtime and plugin storage are the engine's fakes.
const state = vi.hoisted(() => ({ deps: undefined as unknown, storage: undefined as unknown }));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({
			storage: state.storage,
			config: { maxUploadSize: 1000 },
			db: {},
			schemaRegistry: {
				getCollectionWithFields: async (slug: string) =>
					slug === "products"
						? { fields: [{ slug: "title", type: "string" }], supports: [] }
						: null,
			},
		}),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/content.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashContent: function () {
		return (state.deps as Record<string, unknown>).content;
	},
}));
vi.mock("../../src/emdash/lookups.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashLookups: function () {
		return (state.deps as Record<string, unknown>).lookups;
	},
}));
vi.mock("../../src/emdash/media.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashMedia: function () {
		return (state.deps as Record<string, unknown>).media;
	},
}));

const plugin = createPlugin();
let deps: Deps;
let cron: FakeCron;
let kv: {
	templates: MemoryKv<SavedTemplate>;
	sources: MemoryKv<SourceRow>;
	schedules: MemoryKv<ScheduleRow>;
};
/** The calling user's ID. */
let caller: string;
/** Replaces parts of the route context, to break a side effect (preflight F11). */
let overrides: Record<string, unknown>;
/** What the routes wrote to `ctx.log.warn`. */
let warned: unknown[][];

beforeEach(async () => {
	deps = setup().deps;
	state.deps = deps;
	state.storage = new FakeStorage();
	cron = new FakeCron();
	kv = {
		templates: new MemoryKv(STORAGE.templates.indexes),
		sources: new MemoryKv(STORAGE.sources.indexes),
		schedules: new MemoryKv(STORAGE.schedules.indexes),
	};
	caller = "admin";
	overrides = {};
	warned = [];
	await kv.templates.put("T1", savedTemplate("T1"));
	await kv.sources.put("S1", sourceRow("S1"));
});

function context(input: unknown) {
	return {
		input,
		user: { id: caller, role: 50 },
		storage: kv,
		cron,
		settings: { get: async () => undefined },
		taxonomies: { getAll: async () => [] },
		bylines: {},
		log: {
			debug: () => {},
			info: () => {},
			warn: (...args: unknown[]) => warned.push(args),
			error: () => {},
		},
		...overrides,
	} as never;
}

async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
	const route = plugin.routes[name]!;
	return (await route.handler(context(route.input!.parse(input)))) as T;
}

const zero = {
	created: 0,
	updated: 0,
	unchanged: 0,
	failed: 0,
	conflict: 0,
	locked: 0,
	removed: 0,
};

describe("the schedule routes (M6b)", () => {
	it("creates, lists, updates, runs and deletes a schedule, reconciling the tasks after each call", async () => {
		const input = {
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "0 3 * * *",
		};
		const { schedule } = await call<{ schedule: ScheduleView }>("schedules/create", input);
		const task = `schedule-${schedule.id}`;
		expect(schedule).toMatchObject({ name: "Nightly", armedBy: "admin", revision: 1 });
		expect(schedule.nextRunAt).toBe("2026-11-18T03:00:00.000Z");
		// The reconciliation after the call scheduled retention too (spec "Reconciliation").
		expect([...cron.tasks.keys()].sort()).toEqual([RETENTION_TASK, task].sort());
		const list = await call<Page<ScheduleView>>("schedules/list", {});
		expect(list.items.map((s) => s.id)).toEqual([schedule.id]);
		const update = { id: schedule.id, revision: 1, cron: "@hourly" };
		const updated = await call<{ schedule: ScheduleView }>("schedules/update", update);
		expect(updated.schedule).toMatchObject({ cron: "@hourly", revision: 2 });
		expect(cron.tasks.get(task)?.schedule).toBe("@hourly");
		expect(await call("schedules/run", { id: schedule.id })).toMatchObject({
			queued: true,
			schedule: { due: { at: expect.any(String) } },
		});
		expect(cron.tasks.has(PUMP_TASK)).toBe(true);
		const deleted = await call("schedules/delete", { id: schedule.id, revision: 2 });
		expect(deleted).toEqual({ deleted: true });
		expect(cron.tasks.has(task)).toBe(false);
	});

	it("reconciles the tasks after a call that fails", async () => {
		await kv.schedules.put("A", scheduleRow("A"));
		await expect(call("schedules/delete", { id: "A", revision: 2 })).rejects.toMatchObject({
			code: "SCHEDULE_CHANGED",
			status: 409,
		});
		expect(cron.tasks.get("schedule-A")?.schedule).toBe("0 3 * * *");
	});

	it("answers the call when the reconciliation after it fails, and logs the failure", async () => {
		await kv.schedules.put("A", scheduleRow("A"));
		cron.list = async () => {
			throw new Error("cron down");
		};
		expect(await call("schedules/delete", { id: "A", revision: 1 })).toEqual({ deleted: true });
		expect(warned).toEqual([[expect.stringContaining("cron down")]]);
	});

	it("caps every schedule route's JSON body at 16 KiB", () => {
		expect(SCHEDULE_BODY_MAX_BYTES).toBe(16 * 1024);
		const names = Object.keys(plugin.routes).filter((r) => r.startsWith("schedules/"));
		// Five M6b routes, M6d's schedules/overview and M7b's schedules/fence.
		expect(names).toHaveLength(7);
		for (const name of names) {
			expect(plugin.routes[name]?.request, name).toEqual({
				body: "json",
				maxBytes: SCHEDULE_BODY_MAX_BYTES,
			});
		}
	});

	it("refuses unknown keys, bounds, an update with no change, and templateId without templateRevision", () => {
		const input = (name: string) => plugin.routes[name]!.input!;
		const create = {
			name: "N",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "@daily",
		};
		const parses = (name: string, value: object) => input(name).safeParse(value).success;
		expect(parses("schedules/create", create)).toBe(true);
		expect(parses("schedules/create", { ...create, enable: true })).toBe(false);
		expect(parses("schedules/create", { ...create, budgetMs: 499 })).toBe(false);
		expect(parses("schedules/create", { ...create, budgetMs: 20_001 })).toBe(false);
		expect(parses("schedules/create", { ...create, batchSize: 501 })).toBe(false);
		expect(parses("schedules/create", { ...create, missing: { maxPercent: 10, x: 1 } })).toBe(
			false,
		);
		expect(parses("schedules/create", { ...create, name: " N" })).toBe(false);
		// The coordinator's Task 2 note: a schedule's name is refused in schedule wording.
		const rule =
			"A schedule name is 1-100 characters, with no leading or trailing whitespace and no control or format characters";
		const issues = (name: string, value: object) =>
			input(name)
				.safeParse(value)
				.error?.issues.map((i) => i.message);
		expect(issues("schedules/create", { ...create, name: " N" })).toEqual([rule]);
		expect(issues("schedules/create", { ...create, name: "x".repeat(101) })).toEqual([rule]);
		expect(issues("schedules/update", { id: "A", revision: 1, name: "" })).toEqual([rule]);
		expect(parses("schedules/update", { id: "A", revision: 1 })).toBe(false);
		expect(parses("schedules/update", { id: "A", revision: 1, templateId: "T2" })).toBe(false);
		expect(parses("schedules/update", { id: "A", revision: 1, missing: null })).toBe(true);
		expect(parses("schedules/run", { id: "A", forced: true })).toBe(false);
		expect(parses("schedules/delete", { id: "A" })).toBe(false);
	});

	it("refuses to delete a template or a source a schedule names (spec Ruling 10)", async () => {
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		await expect(call("templates/delete", { id: "T1", revision: 1 })).rejects.toMatchObject({
			code: "TEMPLATE_IN_USE",
			status: 409,
			details: { scheduleIds: ["A"] },
		});
		await expect(call("sources/delete", { id: "S1" })).rejects.toMatchObject({
			code: "SOURCE_IN_USE",
			status: 409,
			details: { scheduleIds: ["A"] },
		});
		expect(await kv.templates.get("T1")).not.toBeNull();
		expect(await kv.sources.get("S1")).not.toBeNull();
	});

	it("templates/update warns about the schedules pinned to another revision (spec Ruling 11)", async () => {
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		const saved = await call<SavedResult>("templates/update", {
			id: "T1",
			revision: 1,
			description: "v2",
		});
		expect(saved.template.revision).toBe(2);
		expect(saved.check.warnings).toContain(
			"Schedule Nightly (A) runs revision 1; update it to run this revision",
		);
	});

	it("sources/update warns only when a schedule pins another URL or credential (plan Ruling 14)", async () => {
		const pin = await fingerprint({ url: "https://feeds.example/S1.csv", credential: null });
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly", sourcePin: pin }));
		const renamed = await call<SourceRow>("sources/update", { id: "S1", name: "Feed" });
		expect(renamed).not.toHaveProperty("warnings");
		const moved = await call<SourceRow & { warnings?: string[] }>("sources/update", {
			id: "S1",
			url: "https://feeds.example/other.csv",
		});
		expect(moved.warnings).toEqual([
			"Schedule Nightly (A) pins this source's URL and credential; it pauses at its next run until it is enabled again",
		]);
	});

	it("jobs/cancel pauses the job's schedule; jobs/resume hands a finalized scheduled job back to the pump", async () => {
		await cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await kv.schedules.put("A", scheduleRow("A"));
		const scheduled = { origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...scheduled, status: "running", scheduled: "open" }));
		await call("jobs/cancel", { id: "J1" });
		expect(await kv.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", jobId: "J1" },
		});
		expect(cron.tasks.has("schedule-A")).toBe(false);
		await deps.jobs.put(
			"J2",
			jobRow("J2", { ...scheduled, status: "failed", scheduled: "closed" }),
		);
		// Preflight F19: the answer is the reopened row.
		expect(await call("jobs/resume", { id: "J2" })).toMatchObject({
			status: "running",
			scheduled: "open",
		});
		expect(await deps.jobs.get("J2")).toMatchObject({ scheduled: "open" });
		expect(cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("jobs/retry reopens a finalized scheduled job and answers with the reopened row (preflight F19)", async () => {
		const scheduled = { origin: "schedule", scheduleId: "A" } as const;
		const finished = { ...scheduled, status: "completed", scheduled: "closed" } as const;
		await deps.jobs.put("J1", jobRow("J1", finished));
		expect(await call("jobs/retry", { id: "J1" })).toMatchObject({
			status: "running",
			scheduled: "open",
		});
		expect(cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("pausing or resuming a scheduled job leaves its schedule enabled", async () => {
		await cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await kv.schedules.put("A", scheduleRow("A"));
		const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...open, status: "running" }));
		await call("jobs/pause", { id: "J1" });
		await call("jobs/resume", { id: "J1" });
		expect(await kv.schedules.get("A")).toEqual(scheduleRow("A"));
		expect(cron.tasks.has("schedule-A")).toBe(true);
	});

	it("leaves the schedules alone when a job no schedule launched is cancelled or resumed", async () => {
		await cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await kv.schedules.put("A", scheduleRow("A"));
		await deps.jobs.put("J1", jobRow("J1", { status: "running" }));
		await call("jobs/cancel", { id: "J1" });
		await deps.jobs.put("J2", jobRow("J2", { status: "failed" }));
		const resumed = await call<Job>("jobs/resume", { id: "J2" });
		expect(resumed).not.toHaveProperty("scheduled");
		expect(await kv.schedules.get("A")).toMatchObject({ enabled: true });
		expect(await kv.schedules.get("A")).not.toHaveProperty("pause");
		expect([...cron.tasks.keys()]).toEqual(["schedule-A"]);
	});

	it("jobs/rollback of a scheduled job pauses its schedule and marks its run rolled back (spec Ruling 32)", async () => {
		const original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		const marked = { origin: "schedule", scheduleId: "A", scheduled: "closed" } as const;
		await deps.jobs.put(original.id, { ...original, ...marked });
		const run = { jobId: original.id, at: original.updatedAt, outcome: "completed" as const };
		await kv.schedules.put("A", scheduleRow("A", { runs: [{ ...run, counters: zero }] }));
		const rollback = await call<Job>("jobs/rollback", { id: original.id });
		expect(await kv.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", jobId: original.id },
			runs: [{ jobId: original.id, rolledBack: { by: rollback.id, at: rollback.createdAt } }],
		});
	});

	it("jobs/rollback replaces a job_failed pause with rolled_back (preflight F7: a route pause wins)", async () => {
		const original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		const marked = { origin: "schedule", scheduleId: "A", scheduled: "closed" } as const;
		await deps.jobs.put(original.id, { ...original, ...marked });
		const run = { jobId: original.id, at: original.updatedAt, outcome: "failed" as const };
		const failed = { reason: "job_failed", at: "2026-11-17T10:00:00.000Z", jobId: "J0" } as const;
		await kv.schedules.put(
			"A",
			scheduleRow("A", { enabled: false, pause: failed, runs: [{ ...run, counters: zero }] }),
		);
		const rollback = await call<Job>("jobs/rollback", { id: original.id });
		expect(await kv.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", jobId: original.id },
			runs: [{ jobId: original.id, rolledBack: { by: rollback.id, at: rollback.createdAt } }],
		});
	});

	it("a dry-run rollback of a scheduled job leaves its schedule alone", async () => {
		const original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		const marked = { origin: "schedule", scheduleId: "A", scheduled: "closed" } as const;
		await deps.jobs.put(original.id, { ...original, ...marked });
		await kv.schedules.put("A", scheduleRow("A"));
		await call<Job>("jobs/rollback", { id: original.id, dryRun: true });
		expect(await kv.schedules.get("A")).toEqual(scheduleRow("A"));
	});

	it("never fails a route whose write succeeded when a schedule side effect throws (preflight F11)", async () => {
		const pin = await fingerprint({ url: "https://feeds.example/S1.csv", credential: null });
		await kv.schedules.put("A", scheduleRow("A", { sourcePin: pin }));
		const scheduled = { origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...scheduled, status: "running", scheduled: "open" }));
		await deps.jobs.put(
			"J2",
			jobRow("J2", { ...scheduled, status: "failed", scheduled: "closed" }),
		);
		// No cron API: cronOf throws in the cancel, resume and rollback side effects.
		overrides = { cron: undefined };
		expect(await call("jobs/cancel", { id: "J1" })).toMatchObject({ status: "cancelled" });
		expect(await call("jobs/resume", { id: "J2" })).toMatchObject({ status: "running" });
		const original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		await deps.jobs.put(original.id, { ...original, ...scheduled, scheduled: "closed" });
		expect(await call("jobs/rollback", { id: original.id })).toMatchObject({ dryRun: false });
		// A schedules collection whose reads throw: the warnings are left out.
		const broken = new MemoryKv<ScheduleRow>(STORAGE.schedules.indexes);
		const upload = `01JZ0000000000000000000000${"0".repeat(32)}`;
		broken.query = async () => {
			throw new Error(`storage down reading ${upload}`);
		};
		overrides = { storage: { ...kv, schedules: broken } };
		const saved = await call<SavedResult>("templates/update", {
			id: "T1",
			revision: 1,
			description: "v2",
		});
		expect(saved.template.revision).toBe(2);
		const moved = await call<SourceRow>("sources/update", {
			id: "S1",
			url: "https://feeds.example/other.csv",
		});
		expect(moved).toMatchObject({ url: "https://feeds.example/other.csv" });
		expect(moved).not.toHaveProperty("warnings");
		// Every dropped side effect is logged, redacted (preflight F12 style).
		const logged = warned.map((args) => String(args[0]));
		expect(logged).toHaveLength(5);
		expect(logged.filter((m) => m.includes("cron API is not available"))).toHaveLength(3);
		expect(logged.filter((m) => m.includes("storage down reading [staged file]"))).toHaveLength(2);
		expect(logged.join("\n")).not.toContain(upload);
		expect(warned.every((args) => args.length === 1)).toBe(true);
	});

	it("touches no cron task and logs nothing when a job no schedule launched is resumed", async () => {
		await deps.jobs.put("J1", jobRow("J1", { status: "failed" }));
		overrides = { cron: undefined };
		expect(await call("jobs/resume", { id: "J1" })).toMatchObject({ status: "running" });
		expect(warned).toEqual([]);
	});

	describe("an update that changes what an enabled schedule runs (preflight F9)", () => {
		beforeEach(async () => {
			await kv.templates.put("T2", savedTemplate("T2", OWNED));
			await kv.sources.put("S2", sourceRow("S2"));
		});

		it("arms the schedule as the caller when the template, the source or missing changes", async () => {
			caller = "second";
			await kv.schedules.put("A", scheduleRow("A", { armedBy: "first" }));
			const cronOnly = { id: "A", revision: 1, cron: "@hourly" };
			const kept = await call<{ schedule: ScheduleView }>("schedules/update", cronOnly);
			expect(kept.schedule.armedBy).toBe("first");
			const source = { id: "A", revision: 2, sourceId: "S2" };
			const moved = await call<{ schedule: ScheduleView }>("schedules/update", source);
			expect(moved.schedule).toMatchObject({ sourceId: "S2", armedBy: "second" });

			caller = "third";
			const template = { id: "A", revision: 3, templateId: "T2", templateRevision: 1 };
			const retemplated = await call<{ schedule: ScheduleView }>("schedules/update", {
				...template,
				missing: "template",
			});
			expect(retemplated.schedule).toMatchObject({ templateId: "T2", armedBy: "third" });

			caller = "fourth";
			const missing = { id: "A", revision: 4, missing: { maxPercent: 5 } };
			const lowered = await call<{ schedule: ScheduleView }>("schedules/update", missing);
			expect(lowered.schedule).toMatchObject({
				missing: { maxPercent: 5 },
				armedBy: "fourth",
			});
		});

		it("arms the schedule as the caller on a change of template revision alone, or of source alone", async () => {
			await kv.templates.put("T1", savedTemplate("T1", undefined, 2));
			await kv.schedules.put("A", scheduleRow("A", { armedBy: "first" }));
			caller = "second";
			const revision = { id: "A", revision: 1, templateRevision: 2 };
			const moved = await call<{ schedule: ScheduleView }>("schedules/update", revision);
			expect(moved.schedule).toMatchObject({ templateRevision: 2, armedBy: "second" });
			expect(moved.schedule).not.toHaveProperty("missing");
			caller = "third";
			const source = { id: "A", revision: 2, sourceId: "S2" };
			const resourced = await call<{ schedule: ScheduleView }>("schedules/update", source);
			expect(resourced.schedule).toMatchObject({
				templateRevision: 2,
				sourceId: "S2",
				armedBy: "third",
			});
		});

		it("keeps armedBy on a disabled schedule, and when missing is set to its own value", async () => {
			caller = "second";
			const row = scheduleRow("A", {
				templateId: "T2",
				missing: "template",
				armedBy: "first",
			});
			await kv.schedules.put("A", row);
			const same = { id: "A", revision: 1, missing: "template" };
			const unchanged = await call<{ schedule: ScheduleView }>("schedules/update", same);
			expect(unchanged.schedule.armedBy).toBe("first");
			await kv.schedules.put("B", scheduleRow("B", { enabled: false, armedBy: "first" }));
			const source = { id: "B", revision: 1, sourceId: "S2" };
			const moved = await call<{ schedule: ScheduleView }>("schedules/update", source);
			expect(moved.schedule).toMatchObject({ sourceId: "S2", armedBy: "first" });
		});

		it("refuses a change to missing while the schedule has an open job", async () => {
			await kv.schedules.put("A", scheduleRow("A", { templateId: "T2", missing: "template" }));
			const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;
			await deps.jobs.put("J1", jobRow("J1", { ...open, status: "running" }));
			const update = { id: "A", revision: 1, missing: { maxPercent: 5 } };
			await expect(call("schedules/update", update)).rejects.toMatchObject({
				code: "SCHEDULE_BUSY",
				status: 409,
				details: { jobId: "J1" },
			});
			expect(await kv.schedules.get("A")).toMatchObject({ missing: "template", revision: 1 });
		});
	});
});

describe("the overview routes (M6d)", () => {
	it("answers schedules/overview without reconciling the cron tasks (spec Ruling 39)", async () => {
		await kv.schedules.put("A", scheduleRow("A"));
		// A stale task and no task for A: a reconciliation would cancel the one and add the other.
		await cron.schedule("schedule-GONE", { schedule: "0 1 * * *" });
		cron.calls.length = 0;
		const reply = await call<{ items: { id: string }[]; hasMore: boolean }>(
			"schedules/overview",
			{},
		);
		expect(reply).toMatchObject({ items: [{ id: "A" }], hasMore: false });
		expect(reply.items[0]).not.toHaveProperty("armedBy");
		expect(cron.calls).toEqual([]);
		expect([...cron.tasks.keys()]).toEqual(["schedule-GONE"]);
	});

	it("answers sources/overview with hosts and codes only (spec Ruling 38)", async () => {
		await kv.sources.put(
			"S2",
			sourceRow("S2", {
				url: "https://feeds.example/s3cr3t-path/feed.csv?token=t0ken",
				credential: "cred-mark",
				lastError: { at: "", code: "HTTP_ERROR", message: "msg-mark" },
			}),
		);
		const reply = await call<{ items: { id: string }[] }>("sources/overview", {});
		expect(reply.items.find((s) => s.id === "S2")).toMatchObject({
			host: "feeds.example",
			credential: true,
			lastError: { code: "HTTP_ERROR" },
		});
		const text = JSON.stringify(reply);
		for (const marker of ["s3cr3t", "t0ken", "cred-mark", "msg-mark", "https:"]) {
			expect(text, marker).not.toContain(marker);
		}
	});
});
