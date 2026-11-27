import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import { PUMP_SCHEDULE, PUMP_TASK } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv } from "./fakes.js";
import { type Deps, importRows, setup } from "./rollback-fixture.js";
import { FakeCron } from "./schedule-fakes.js";

// The route builds its services from the EmDash runtime and plugin storage; both are replaced by
// the in-memory fakes of the engine tests.
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	sources: undefined as unknown,
}));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({
			storage: new (await import("./fakes.js")).FakeStorage(),
			config: { maxUploadSize: 1000 },
			db: {},
		}),
}));
vi.mock("../../src/emdash/storage.js", () => ({ pluginCollections: () => state.deps }));
vi.mock("../../src/plugin/sources.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/plugin/sources.js")>()),
	sourcesCollection: () => state.sources,
}));

const plugin = createPlugin();
const route = plugin.routes["jobs/rollback"]!;
const NOW = "2026-11-03T10:00:00.000Z";

/** The route's call, with no cron API unless `extra` gives one (a site whose cron never runs). */
function call(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const parsed = route.input!.parse(input);
	return route.handler({
		input: parsed,
		user: { id: "admin", role: 50 },
		storage: {},
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
		...extra,
	} as never) as Promise<Job>;
}

/** The cron API and a log that records warnings. */
function withCron(fail = false) {
	const cron = new FakeCron();
	if (fail) {
		cron.schedule = async () => {
			throw new Error("cron is down");
		};
	}
	const warnings: string[] = [];
	const log = { warn: (m: string) => warnings.push(m), info: () => {}, error: () => {} };
	return { cron, warnings, ctx: { cron, log } };
}

describe("jobs/rollback route (M5a)", () => {
	let deps: Deps;
	let sources: MemoryKv<SourceRow>;
	let original: Job;

	beforeEach(async () => {
		deps = setup().deps;
		sources = new MemoryKv<SourceRow>();
		state.deps = deps;
		state.sources = sources;
		original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		await deps.jobs.put(original.id, { ...original, sourceId: "src1" });
		await sources.put("src1", {
			id: "src1",
			name: "Feed",
			url: "https://example.com/feed.csv",
			lastImport: { sha256: "abc", uploadId: "u1", jobId: original.id, at: NOW },
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("returns the rollback job and clears the source's lastImport", async () => {
		const body = await call({ id: original.id, batchSize: 7 });
		expect(body).toMatchObject({
			kind: "rollback",
			rollbackOf: original.id,
			status: "created",
			batchSize: 7,
			dryRun: false,
		});
		expect(await sources.get("src1")).not.toHaveProperty("lastImport");
		expect((await deps.jobs.get(original.id))?.rolledBackBy).toBe(body.id);
	});

	it("leaves lastImport alone for a dry run", async () => {
		const body = await call({ id: original.id, dryRun: true });
		expect(body).toMatchObject({ kind: "rollback", dryRun: true });
		expect((await sources.get("src1"))?.lastImport?.jobId).toBe(original.id);
	});

	it("maps a refusal to an error and leaves lastImport alone", async () => {
		await call({ id: original.id });
		await expect(call({ id: original.id })).rejects.toMatchObject({ status: 409 });
	});

	it("hands a real rollback to the pump: opened once its original is marked, and the pump armed", async () => {
		const { cron, ctx } = withCron();
		const body = await call({ id: original.id }, ctx);
		expect(body).toMatchObject({ kind: "rollback", status: "created", scheduled: "open" });
		expect(await deps.jobs.get(body.id)).toMatchObject({ scheduled: "open" });
		expect((await deps.jobs.get(original.id))?.rolledBackBy).toBe(body.id);
		expect(cron.calls).toEqual([`schedule ${PUMP_TASK} ${PUMP_SCHEDULE}`]);
	});

	it("leaves a dry rollback to the dialog: not opened, no pump armed", async () => {
		const { cron, ctx } = withCron();
		const body = await call({ id: original.id, dryRun: true }, ctx);
		expect(body).not.toHaveProperty("scheduled");
		expect(await deps.jobs.get(body.id)).not.toHaveProperty("scheduled");
		expect(cron.calls).toEqual([]);
	});

	it("leaves a rollback unopened on a site without the cron API, driven from the browser alone", async () => {
		const body = await call({ id: original.id });
		expect(body).not.toHaveProperty("scheduled");
		expect(await deps.jobs.get(body.id)).not.toHaveProperty("scheduled");
	});

	it("still answers the opened rollback when arming the pump fails, and logs it", async () => {
		const { warnings, ctx } = withCron(true);
		const body = await call({ id: original.id }, ctx);
		expect(body).toMatchObject({ scheduled: "open" });
		expect(warnings).toEqual(["fluximporter: arming the pump failed: cron is down"]);
	});

	it("validates its input", () => {
		expect(route.input!.safeParse({ id: "a/b" }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", batchSize: 1.5 }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", budgetMs: 2.5 }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", dryRun: "yes" }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", dryRun: true, batchSize: 5 }).success).toBe(true);
	});
});
