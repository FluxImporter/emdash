import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { StatusReply } from "../../src/plugin/agent.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { PASTE_MAX_BYTES, ServiceError, stagePaste } from "../../src/plugin/service.js";
import { createJobFrom, withScheduledServices } from "../../src/plugin/services.js";
import type { JobSummary, StepReply } from "../../src/plugin/summaries.js";
import type { SavedResult } from "../../src/plugin/templates.js";
import { FakeStorage, MemoryKv, makeDeps } from "./fakes.js";

// As template-routes.test.ts: the runtime and plugin storage are the engine's fakes. The batch
// also writes through the fakes' content, lookups and media (Fact E5).
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	storage: undefined as unknown,
	feedUpload: "",
	fromSource: [] as { sourceId: string; dryRun: boolean }[],
	/** When set, jobs/status's rule throws it synchronously, before returning a promise. */
	statusThrows: undefined as unknown,
}));

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
vi.mock("../../src/plugin/agent.js", async (importOriginal) => {
	const agent = await importOriginal<typeof import("../../src/plugin/agent.js")>();
	return {
		...agent,
		readJobStatus: (...args: Parameters<typeof agent.readJobStatus>) => {
			if (state.statusThrows !== undefined) throw state.statusThrows;
			return agent.readJobStatus(...args);
		},
	};
});
// A URL source is never fetched here: its dry run is made from a staged copy.
vi.mock("../../src/plugin/sources.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/plugin/sources.js")>()),
	jobFromSource: async (
		_deps: unknown,
		sourceId: string,
		options: { dryRun: boolean },
		create: (uploadId: string, sourceId: string) => Promise<Job>,
	) => {
		state.fromSource.push({ sourceId, dryRun: options.dryRun });
		return create(state.feedUpload, sourceId);
	},
}));

const plugin = createPlugin();
let templates: MemoryKv<unknown>;
let storage: FakeStorage;
const UPLOAD_ID = /[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}/;
const CSV = "sku,Name\nA,One\nB,Two\nC,Three\n";

function context(input: unknown) {
	return {
		input,
		user: { id: "admin", role: 50 },
		storage: { templates, sources: new MemoryKv() },
		settings: { get: async () => undefined },
		taxonomies: { getAll: async () => [] },
		bylines: {},
	} as never;
}

/** Every response passes through here, so each test also checks it holds no upload ID. */
async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
	const route = plugin.routes[name]!;
	const result = await route.handler(context(route.input!.parse(input)));
	expect(JSON.stringify(result)).not.toMatch(UPLOAD_ID);
	return result as T;
}

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};

async function saveTemplate(t: object = template): Promise<string> {
	const saved = await call<SavedResult>("templates/create", { name: "Feed", template: t });
	return saved.template.id;
}

async function drive(id: string): Promise<StepReply> {
	for (let i = 0; i < 20; i++) {
		const reply = await call<StepReply>("jobs/step", { id });
		if (reply.next !== "next_batch") return reply;
	}
	throw new Error(`job ${id} did not finish`);
}

async function planned(text = CSV): Promise<JobSummary> {
	const templateId = await saveTemplate();
	const { job } = await call<{ job: JobSummary }>("jobs/plan", { templateId, text });
	expect(await drive(job.id)).toMatchObject({ next: "done", status: "completed" });
	return job;
}

function storedJob(id: string): Promise<Job | null> {
	return (state.deps as { jobs: MemoryKv<Job> }).jobs.get(id);
}

describe("the M6c agent routes", () => {
	beforeEach(() => {
		const { deps } = makeDeps();
		// The routes query only indexed fields, as EmDash enforces.
		deps.jobs = new MemoryKv(STORAGE.jobs.indexes);
		deps.records = new MemoryKv(STORAGE.records.indexes);
		deps.links = new MemoryKv(STORAGE.links.indexes);
		deps.journal = new MemoryKv(STORAGE.journal.indexes);
		deps.journalMedia = new MemoryKv(STORAGE.journalMedia.indexes);
		state.deps = deps;
		storage = new FakeStorage();
		state.storage = storage;
		state.fromSource = [];
		state.statusThrows = undefined;
		templates = new MemoryKv(STORAGE.templates.indexes);
	});

	it("plans pasted text as an agent dry run, drives it and reads its records", async () => {
		const templateId = await saveTemplate();
		const { job } = await call<{ job: JobSummary }>("jobs/plan", { templateId, text: CSV });
		expect(job).toMatchObject({
			dryRun: true,
			origin: "agent",
			templateId,
			templateRevision: 1,
			missing: null,
			next: "next_batch",
		});
		expect(await drive(job.id)).toEqual({
			id: job.id,
			status: "completed",
			next: "done",
			processed: 3,
			total: 3,
		});
		const status = await call<StatusReply>("jobs/status", { id: job.id, records: "planned" });
		expect(status.job.counters).toMatchObject({ created: 3, failed: 0 });
		expect(status.records?.items.map((r) => r.sourceKey)).toEqual(["A", "B", "C"]);
		expect(status.records?.items[0]?.changes).toContainEqual({ field: "title", value: '"One"' });
	});

	it("plans pasted text with a BOM and CRLF like an uploaded file (Review Focus 5)", async () => {
		const job = await planned("\uFEFFsku,Name\r\nA,One\r\nB,Two\r\n");
		const status = await call<StatusReply>("jobs/status", { id: job.id });
		expect(status.job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(status.job.processed).toBe(2);
	});

	it("passes missing: false for a template with rules.missing, and runs no missing phase", async () => {
		const templateId = await saveTemplate({
			...template,
			rules: { owner: "shop", missing: { action: "unpublish" } },
		});
		const { job } = await call<{ job: JobSummary }>("jobs/plan", { templateId, text: CSV });
		expect(job.missing).toBe(false);
		await drive(job.id);
		const status = await call<StatusReply>("jobs/status", { id: job.id });
		expect(status.job).not.toHaveProperty("missingPhase");
	});

	it("starts the completed dry run once and imports it with a journal", async () => {
		const dry = await planned();
		const { job } = await call<{ job: JobSummary }>("jobs/start", { dryRunId: dry.id });
		expect(job).toMatchObject({ dryRun: false, origin: "agent", dryRunOf: dry.id });
		expect(await drive(job.id)).toMatchObject({ status: "completed", processed: 3 });
		const stored = (await storedJob(job.id)) as Job;
		expect(stored).toMatchObject({ journal: true, uploadId: expect.any(String) });
		expect(stored).not.toHaveProperty("sourceId");
		const again = await call<{ job: JobSummary }>("jobs/start", { dryRunId: dry.id });
		expect(again.job.id).toBe(job.id);
		const status = await call<StatusReply>("jobs/status", { id: job.id });
		expect(status.job.counters).toMatchObject({ created: 3 });
		const dryStatus = await call<StatusReply>("jobs/status", { id: dry.id });
		expect(dryStatus.job.startedAs).toBe(job.id);
	});

	it("passes id, origin and dryRunOf through createJobFrom to the stored rows", async () => {
		const dry = await planned();
		expect(await storedJob(dry.id)).toMatchObject({ dryRun: true, origin: "agent" });
		expect(await storedJob(dry.id)).not.toHaveProperty("dryRunOf");
		const { job } = await call<{ job: JobSummary }>("jobs/start", { dryRunId: dry.id });
		const claimed = (await storedJob(dry.id)) as Job;
		// The job is stored under the ID the claim wrote, not one createJob made up.
		expect(job.id).toBe(claimed.startedAs);
		expect(await storedJob(job.id)).toMatchObject({
			id: claimed.startedAs,
			dryRun: false,
			origin: "agent",
			dryRunOf: dry.id,
		});
	});

	it("records a URL source as feedSourceId on its dry run and on the job jobs/start makes (M6b, spec Ruling 33)", async () => {
		state.feedUpload = (await stagePaste(storage, CSV)).uploadId;
		const templateId = await saveTemplate();
		const { job: dry } = await call<{ job: JobSummary }>("jobs/plan", {
			templateId,
			sourceId: "S1",
		});
		expect(await storedJob(dry.id)).toMatchObject({ sourceId: "S1", feedSourceId: "S1" });
		expect(await drive(dry.id)).toMatchObject({ status: "completed" });
		const { job } = await call<{ job: JobSummary }>("jobs/start", { dryRunId: dry.id });
		const stored = (await storedJob(job.id)) as Job;
		expect(stored.feedSourceId).toBe("S1");
		expect(stored).not.toHaveProperty("sourceId");
	});

	it("passes a launch's schedule markers and source through createJobFrom (M6b)", async () => {
		state.feedUpload = (await stagePaste(storage, CSV)).uploadId;
		const ctx = context({});
		const job = (await withScheduledServices(ctx, (services) =>
			createJobFrom(ctx, services, {
				sourceId: "S1",
				template,
				dryRun: false,
				origin: "schedule",
				scheduleId: "SCH1",
				scheduled: "open",
			}),
		)) as Job;
		expect(await storedJob(job.id)).toMatchObject({
			origin: "schedule",
			scheduleId: "SCH1",
			scheduled: "open",
			sourceId: "S1",
			feedSourceId: "S1",
		});
	});

	it("reads the saved template once per plan and once per start (plan Ruling 8)", async () => {
		const templateId = await saveTemplate();
		let reads = 0;
		const get = templates.get.bind(templates);
		templates.get = (id) => {
			reads++;
			return get(id);
		};
		const { job } = await call<{ job: JobSummary }>("jobs/plan", { templateId, text: CSV });
		expect(reads).toBe(1);
		await drive(job.id);
		reads = 0;
		await call("jobs/start", { dryRunId: job.id });
		expect(reads).toBe(1);
	});

	it("refuses unknown keys, and builds agent jobs from the known ones only", async () => {
		const extra = {
			origin: "admin",
			id: "CHOSEN",
			dryRunOf: "X1",
			journal: false,
			missing: false,
			dryRun: false,
		};
		// EmDash hands the handler the schema's parsed value (emdash src/plugins/routes.ts:248-262),
		// and the strict inputs refuse every key they do not name.
		for (const [key, value] of Object.entries(extra)) {
			const plan = { templateId: "T1", text: CSV, [key]: value };
			expect(plugin.routes["jobs/plan"]!.input!.safeParse(plan).success, key).toBe(false);
			const start = { dryRunId: "D1", [key]: value };
			expect(plugin.routes["jobs/start"]!.input!.safeParse(start).success, key).toBe(false);
		}
		// Even a handler given those keys builds its request field by field.
		const templateId = await saveTemplate();
		const planRoute = plugin.routes["jobs/plan"]!;
		const planned = (await planRoute.handler(context({ templateId, text: CSV, ...extra }))) as {
			job: JobSummary;
		};
		expect(planned.job).toMatchObject({ dryRun: true, origin: "agent" });
		expect(planned.job.id).not.toBe("CHOSEN");
		expect(planned.job).not.toHaveProperty("dryRunOf");
		await drive(planned.job.id);
		const startRoute = plugin.routes["jobs/start"]!;
		const started = (await startRoute.handler(context({ dryRunId: planned.job.id, ...extra }))) as {
			job: JobSummary;
		};
		const claimed = (await storedJob(planned.job.id)) as Job;
		expect(await storedJob(started.job.id)).toMatchObject({
			id: claimed.startedAs,
			dryRun: false,
			origin: "agent",
			dryRunOf: planned.job.id,
			journal: true,
		});
	});

	it("answers SOURCE_FILE_MISSING, without the ID, once the dry run's file is gone", async () => {
		const dry = await planned();
		storage.files.clear();
		const start = call("jobs/start", { dryRunId: dry.id });
		await expect(start).rejects.toMatchObject({
			code: "SOURCE_FILE_MISSING",
			status: 404,
			message: "The dry run's data is no longer stored; run dry_run again",
		});
	});

	it("answers jobs/plan's own SOURCE_FILE_MISSING when the source's staged copy is gone", async () => {
		state.feedUpload = (await stagePaste(storage, CSV)).uploadId;
		storage.files.clear();
		const templateId = await saveTemplate();
		const plan = call("jobs/plan", { templateId, sourceId: "S1" });
		await expect(plan).rejects.toMatchObject({
			code: "SOURCE_FILE_MISSING",
			status: 404,
			message: "The data to plan from is no longer stored; call dry_run again",
		});
	});

	it("redacts every refusal on all four routes before it becomes an HTTP error", async () => {
		// A valid job and template ID that is also shaped like an upload ID.
		const id = `01JZ0000000000000000000000${"0".repeat(32)}`;
		const calls: [string, Record<string, unknown>][] = [
			["jobs/plan", { templateId: id, text: CSV }],
			["jobs/start", { dryRunId: id }],
			["jobs/step", { id }],
			["jobs/status", { id }],
		];
		for (const [name, input] of calls) {
			const error = await call(name, input).catch((e: unknown) => e);
			expect(error, name).toMatchObject({ name: "PluginRouteError", status: 404 });
			expect((error as Error).message, name).toContain("[staged file]");
			expect((error as Error).message, name).not.toMatch(UPLOAD_ID);
		}
	});

	it("redacts an error thrown synchronously by a rule that returns no promise", async () => {
		// jobs/status's run is not async, so a synchronous throw never becomes a rejection there.
		const upload = `01JZ0000000000000000000000${"0".repeat(32)}`;
		state.statusThrows = new ServiceError("BROKEN", `Upload ${upload} is unreadable`, 500, {
			upload,
		});
		const error = await call("jobs/status", { id: "J1" }).catch((e: unknown) => e);
		expect(error).toMatchObject({
			name: "PluginRouteError",
			code: "BROKEN",
			status: 500,
			message: "Upload [staged file] is unreadable",
			details: { upload: "[staged file]" },
		});
	});

	it("refuses XLSX text, empty or oversized text and a stale revision, keeping no file", async () => {
		const xlsx = await saveTemplate({ ...template, source: { format: "xlsx" } });
		await expect(call("jobs/plan", { templateId: xlsx, text: CSV })).rejects.toMatchObject({
			code: "INVALID_FORMAT",
			status: 400,
		});
		templates = new MemoryKv(STORAGE.templates.indexes);
		const templateId = await saveTemplate();
		await expect(call("jobs/plan", { templateId, text: "  \n" })).rejects.toMatchObject({
			code: "EMPTY_BODY",
		});
		const big = `sku,Name\n${"a".repeat(PASTE_MAX_BYTES)}`;
		await expect(call("jobs/plan", { templateId, text: big })).rejects.toMatchObject({
			code: "TOO_LARGE",
			status: 413,
		});
		const stale = call("jobs/plan", { templateId, templateRevision: 2, text: CSV });
		await expect(stale).rejects.toMatchObject({ code: "TEMPLATE_CHANGED", status: 409 });
		expect(storage.files.size).toBe(0);
	});

	it("deletes the staged text when the template does not fit it (spec Ruling 28)", async () => {
		const templateId = await saveTemplate();
		const plan = call("jobs/plan", { templateId, text: "sku,Title\nA,One\n" });
		await expect(plan).rejects.toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
		expect(storage.files.size).toBe(0);
	});

	it("plans a URL source's dry run and passes dryRun to jobFromSource", async () => {
		state.feedUpload = (await stagePaste(storage, CSV)).uploadId;
		const templateId = await saveTemplate();
		const { job } = await call<{ job: JobSummary }>("jobs/plan", { templateId, sourceId: "S1" });
		expect(state.fromSource).toEqual([{ sourceId: "S1", dryRun: true }]);
		expect(job).toMatchObject({ dryRun: true, origin: "agent" });
		expect(job).not.toHaveProperty("sourceId");
	});

	it("advances only agent jobs, and leaves an Admin's job as it was (spec Ruling 30)", async () => {
		const { uploadId } = await stagePaste(storage, CSV);
		const rest = await plugin.routes["jobs/create"]!.handler(
			context({ uploadId, template, dryRun: true }),
		);
		const id = (rest as Job).id;
		await expect(call("jobs/step", { id })).rejects.toMatchObject({
			code: "JOB_NOT_AGENT",
			status: 403,
		});
		expect(await storedJob(id)).toMatchObject({ status: "created", cursor: { seq: 0 } });
		const startRest = call("jobs/start", { dryRunId: id });
		await expect(startRest).rejects.toMatchObject({ code: "NOT_A_DRY_RUN" });
	});

	it("pages records 10 at a time by seq, and reads none without records", async () => {
		const rows = Array.from({ length: 12 }, (_, i) => `S${String(i).padStart(2, "0")},N${i}`);
		const job = await planned(`sku,Name\n${rows.join("\n")}\n`);
		const records = (state.deps as { records: MemoryKv<unknown> }).records;
		let queries = 0;
		const query = records.query.bind(records);
		records.query = (opts) => {
			queries++;
			return query(opts);
		};
		await call("jobs/status", { id: job.id });
		expect(queries).toBe(0);
		const first = await call<StatusReply>("jobs/status", { id: job.id, records: "planned" });
		expect(first.records?.items).toHaveLength(10);
		const cursor = first.records?.cursor as string;
		const next = await call<StatusReply>("jobs/status", { id: job.id, records: "planned", cursor });
		// Records are numbered from 0 (src/engine/batch.ts:1979).
		expect(next.records?.items.map((r) => r.seq)).toEqual([10, 11]);
		expect(next.records?.hasMore).toBe(false);
	});
});
