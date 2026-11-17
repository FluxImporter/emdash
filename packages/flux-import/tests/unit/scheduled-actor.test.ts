import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmDashUploads } from "../../src/emdash/uploads.js";
import { type CreateJobInput, createJob } from "../../src/engine/jobs.js";
import type { EngineDeps, Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import { stagePaste } from "../../src/plugin/service.js";
import { withScheduledServices } from "../../src/plugin/services.js";
import { FakeContent, FakeStorage, MemoryKv, makeDeps } from "./fakes.js";

// As agent-routes.test.ts: the runtime and plugin storage are the engine's fakes. The port
// constructors record whom they were built for (spec Rulings 4, 5), and each actor's content port
// is its own fake, so a test sees which one the batch wrote through.
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	storage: undefined as unknown,
	actors: [] as unknown[],
	authors: [] as unknown[],
	/** The content port built for the Admin; the null-actor port is the engine's own. */
	adminContent: undefined as unknown,
}));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({ storage: state.storage, config: { maxUploadSize: 1000 }, db: {}, schemaRegistry: {} }),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/content.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/content.js")>()),
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashContent: function (_runtime: unknown, actor: unknown) {
		state.actors.push(actor);
		return actor === null ? (state.deps as Record<string, unknown>).content : state.adminContent;
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

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];
const ADMIN = { id: "admin", role: 50, source: "api" };
const plugin = createPlugin();
let engine: EngineDeps;

beforeEach(() => {
	const storage = new FakeStorage();
	state.storage = storage;
	// The services read staged files through EmDashUploads; the job is created over the same copy.
	engine = { ...makeDeps().deps, source: new EmDashUploads(storage) };
	state.deps = engine;
	state.actors = [];
	state.authors = [];
	state.adminContent = new FakeContent();
});

/** The calls each actor's content port received, reads and writes. */
function writes(): { admin: string[]; unattended: string[] } {
	return {
		admin: (state.adminContent as FakeContent).calls,
		unattended: (engine.content as FakeContent).calls,
	};
}

const pluginContext = () =>
	({
		storage: { sources: new MemoryKv() },
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
	}) as never;

async function job(extra: Partial<CreateJobInput> = {}): Promise<Job> {
	const { uploadId } = await stagePaste(state.storage as FakeStorage, "sku,Name\nA,One\nB,Two\n");
	return createJob(engine, { uploadId, template, schemaFields, ...extra });
}

function next(id: string): Promise<Job> {
	const route = plugin.routes["jobs/next"]!;
	const ctx = { ...(pluginContext() as object), input: { id }, user: { id: "admin", role: 50 } };
	return route.handler(ctx as never) as Promise<Job>;
}

describe("unattributed scheduled writes (spec Rulings 4, 5)", () => {
	it("runs a scheduled job's batch through jobs/next with no actor and no media author", async () => {
		const scheduled = await job({ origin: "schedule", scheduleId: "S1", scheduled: "open" });
		const done = await next(scheduled.id);
		expect(done.counters.created).toBe(2);
		// The route's own services first (the Admin), then the batch's, with no user.
		expect(state.actors).toEqual([ADMIN, null]);
		expect(state.authors).toEqual(["admin", null]);
		// The batch ran on the null-actor port only: the Admin's port saw no call at all.
		const { admin, unattended } = writes();
		expect(unattended.filter((c) => c.startsWith("create:"))).toHaveLength(2);
		expect(admin).toEqual([]);
	});

	it("runs any other job's batch as the Admin who calls jobs/next", async () => {
		const plain = await job();
		expect((await next(plain.id)).counters.created).toBe(2);
		expect(state.actors).toEqual([ADMIN]);
		expect(state.authors).toEqual(["admin"]);
		const { admin, unattended } = writes();
		expect(admin.filter((c) => c.startsWith("create:"))).toHaveLength(2);
		expect(unattended).toEqual([]);
	});

	it("builds a cron task's services with no actor", async () => {
		const actor = await withScheduledServices(pluginContext(), async (s) => s.actor);
		expect(actor).toBeNull();
		expect(state.actors).toEqual([null]);
		expect(state.authors).toEqual([null]);
	});
});
