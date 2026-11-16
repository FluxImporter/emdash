import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxSourceBytes, maxXlsxBytes } from "../../src/astro/config.js";
import { fingerprint } from "../../src/engine/fingerprints.js";
import { templateSchema } from "../../src/engine/template.js";
import type { Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import type { SavedResult, SavedTemplate } from "../../src/plugin/templates.js";
import { MemoryKv, makeDeps } from "./fakes.js";

// The routes build their services from the EmDash runtime and plugin storage; both are replaced
// by the in-memory fakes of the engine tests. One storage serves every call, so a staged paste
// is there for the job.
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	storage: undefined as unknown,
	fromSource: [] as { template: unknown; maxBytes: number }[],
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
vi.mock("../../src/emdash/timezone.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/timezone.js")>()),
	readSiteTimezone: async () => "Europe/Berlin",
}));
// A URL source is never fetched here: the route's options to jobFromSource are recorded.
vi.mock("../../src/plugin/sources.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/plugin/sources.js")>()),
	jobFromSource: async (
		deps: { limits: { maxBytes: number } },
		sourceId: string,
		options: { template: unknown },
	) => {
		state.fromSource.push({ template: options.template, maxBytes: deps.limits.maxBytes });
		return { skipped: "unchanged", sourceId, uploadId: "u1" };
	},
}));

const plugin = createPlugin();
let templates: MemoryKv<SavedTemplate>;

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

function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
	const route = plugin.routes[name]!;
	return route.handler(context(route.input!.parse(input))) as Promise<T>;
}

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};

describe("template routes (M6a)", () => {
	beforeEach(async () => {
		state.deps = makeDeps().deps;
		state.storage = new (await import("./fakes.js")).FakeStorage();
		state.fromSource = [];
		templates = new MemoryKv<SavedTemplate>();
	});

	it("creates as the caller, never as a body field, and returns the check", async () => {
		const created = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
			createdBy: "mallory",
		});
		expect(created.template).toMatchObject({ createdBy: "admin", updatedBy: "admin", revision: 1 });
		expect(created.check).toEqual({ problems: [], warnings: [] });
		const missing = await call<SavedResult>("templates/create", {
			name: "Elsewhere",
			template: { ...template, collection: "nope" },
		});
		expect(missing.check.problems).toEqual(['Collection "nope" does not exist']);
	});

	it("reads, updates and deletes at a revision, and maps a stale revision to a 409 route error with the current revision", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
		});
		expect(await call("templates/get", { id: row.id })).toEqual(row);
		const updated = await call<SavedResult>("templates/update", {
			id: row.id,
			revision: 1,
			description: "x",
		});
		expect(updated.template).toMatchObject({ revision: 2, description: "x", updatedBy: "admin" });
		await expect(call("templates/delete", { id: row.id, revision: 1 })).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "TEMPLATE_CHANGED",
			status: 409,
			details: { revision: 2 },
		});
		expect(await call("templates/delete", { id: row.id, revision: 2 })).toEqual({ deleted: true });
		await expect(call("templates/get", { id: row.id })).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "NOT_FOUND",
			status: 404,
			message: `Template ${row.id} not found`,
		});
	});

	it("refuses a delete without a revision at the route's input, before the handler (spec Ruling 37)", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
		});
		// EmDash answers a failed input parse with 400 VALIDATION_ERROR and never calls the handler
		// (emdash src/plugins/routes.ts:246-258).
		const parsed = plugin.routes["templates/delete"]!.input!.safeParse({ id: row.id });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((i) => i.path)).toEqual([["revision"]]);
		expect(await templates.get(row.id)).not.toBeNull();
	});

	it("exports, imports and lists", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Shop feed",
			description: "Nightly",
			template,
		});
		const out = await call<{ filename: string; file: unknown }>("templates/export", { id: row.id });
		expect(out.filename).toBe("flux-import-template-shop-feed.json");
		const copy = await call<SavedResult>("templates/import", {
			file: out.file,
			name: "Copy",
			owner: "shop-2",
		});
		expect(copy.template).toMatchObject({
			name: "Copy",
			description: "Nightly",
			owner: "shop-2",
			createdBy: "admin",
		});
		const page = await call<{ items: { name: string }[] }>("templates/list", {});
		expect(page.items.map((i) => i.name)).toEqual(["Shop feed", "Copy"]);
		const none = await call<{ items: unknown[] }>("templates/list", { collection: "other" });
		expect(none.items).toEqual([]);
	});

	it("applies the schema from a saved template, and refuses a collection that is not the template's", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
		});
		const dry = await call<{ collection: string; dryRun: boolean }>("schema/apply", {
			templateId: row.id,
			dryRun: true,
		});
		expect(dry).toMatchObject({ collection: "products", dryRun: true });
		await expect(
			call("schema/apply", { templateId: row.id, collection: "other", dryRun: true }),
		).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
			message: 'collection "other" does not match the template\'s "products"',
		});
		await expect(call("schema/apply", { templateId: "NOPE", dryRun: true })).rejects.toMatchObject({
			code: "TEMPLATE_NOT_FOUND",
			status: 404,
		});
	});

	it("lists jobs by template", async () => {
		const deps = state.deps as ReturnType<typeof makeDeps>["deps"];
		await deps.jobs.put("J1", {
			id: "J1",
			status: "completed",
			createdAt: "2026-11-16T10:00:00.000Z",
			templateId: "TPL1",
		} as Job);
		await deps.jobs.put("J2", {
			id: "J2",
			status: "completed",
			createdAt: "2026-11-16T10:01:00.000Z",
		} as Job);
		const listed = await call<{ items: Job[] }>("jobs/list", { templateId: "TPL1" });
		expect(listed.items.map((j) => j.id)).toEqual(["J1"]);
	});

	it("creates a job from a saved template, recording its ID and revision", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
		});
		const { uploadId } = await call<{ uploadId: string }>("sources/paste", {
			format: "csv",
			text: "sku,Name\nA1,Desk\n",
		});
		const job = await call<Job>("jobs/create", {
			uploadId,
			templateId: row.id,
			templateRevision: 1,
			dryRun: true,
		});
		expect(job).toMatchObject({
			template: { collection: "products", key: { from: "sku" } },
			templateId: row.id,
			templateRevision: 1,
			dryRun: true,
		});
		await expect(
			call("jobs/create", { uploadId, templateId: row.id, templateRevision: 2, dryRun: true }),
		).rejects.toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: `Template ${row.id} is at revision 1, not 2; read it again`,
			details: { revision: 1 },
		});
		await expect(
			call("jobs/create", { uploadId, templateId: "NOPE", dryRun: true }),
		).rejects.toMatchObject({
			code: "TEMPLATE_NOT_FOUND",
			status: 404,
			message: "Template NOPE not found",
		});
		const inline = await call<Job>("jobs/create", { uploadId, template, dryRun: true });
		expect(inline).not.toHaveProperty("templateId");
	});

	it("reads the site timezone and the collection's revisions for a saved template, as for an inline one", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Scheduled",
			template: {
				...template,
				publishAt: { from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" },
			},
		});
		const { uploadId } = await call<{ uploadId: string }>("sources/paste", {
			format: "csv",
			text: "sku,Name,go_live\nA1,Desk,01/12/2026 09:00\n",
		});
		const job = await call<Job>("jobs/create", { uploadId, templateId: row.id, dryRun: true });
		// The mock's products collection does not keep revisions.
		expect(job).toMatchObject({ siteTimezone: "Europe/Berlin", revisions: false });
	});

	it("passes a URL source job the template's reference for the unchanged-content skip (spec Ruling 29)", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Feed",
			template,
		});
		await call("jobs/create", { sourceId: "SRC1", templateId: row.id, dryRun: false });
		await call("jobs/create", { sourceId: "SRC1", template, dryRun: false });
		await call("jobs/create", { sourceId: "SRC1", template: { version: 1 }, dryRun: false });
		expect(state.fromSource.map((o) => o.template)).toEqual([
			{ id: row.id, revision: 1 },
			{ fingerprint: await fingerprint(templateSchema.parse(template)) },
			null,
		]);
	});

	it("fetches a saved workbook template's source only up to the XLSX file limit", async () => {
		const { template: row } = await call<SavedResult>("templates/create", {
			name: "Workbook",
			template: { ...template, source: { format: "xlsx" } },
		});
		await call("jobs/create", { sourceId: "SRC1", templateId: row.id, dryRun: false });
		await call("jobs/create", { sourceId: "SRC1", template, dryRun: false });
		expect(state.fromSource.map((o) => o.maxBytes)).toEqual([maxXlsxBytes(), maxSourceBytes()]);
		expect(maxXlsxBytes()).toBeLessThan(maxSourceBytes());
	});
});
