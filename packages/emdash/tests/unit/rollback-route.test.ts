import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv } from "./fakes.js";
import { type Deps, importRows, setup } from "./rollback-fixture.js";

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

function call(input: Record<string, unknown>) {
	const parsed = route.input!.parse(input);
	return route.handler({
		input: parsed,
		user: { id: "admin", role: 50 },
		storage: {},
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
	} as never) as Promise<Job>;
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

	it("validates its input", () => {
		expect(route.input!.safeParse({ id: "a/b" }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", batchSize: 1.5 }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", budgetMs: 2.5 }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", dryRun: "yes" }).success).toBe(false);
		expect(route.input!.safeParse({ id: "J1", dryRun: true, batchSize: 5 }).success).toBe(true);
	});
});
