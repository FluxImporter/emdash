import { z } from "astro/zod";
import type { RouteContext } from "emdash";
import { definePlugin, InvalidCursorError, PluginRouteError } from "emdash";
import { describe, expect, it } from "vitest";
import { JobError } from "../../src/engine/jobs.js";
import { sourceSchema } from "../../src/engine/template.js";
import { FLUX_IMPORT_VERSION } from "../../src/meta.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import {
	PLAN_BODY_MAX_BYTES,
	TEMPLATE_BODY_MAX_BYTES,
	toRouteError,
} from "../../src/plugin/routes.js";
import { ServiceError } from "../../src/plugin/service.js";

const ROUTES = [
	"sources/sample",
	"sources/paste",
	"sources/create",
	"sources/update",
	"sources/delete",
	"sources/get",
	"sources/list",
	"sources/fetch",
	"credentials/set",
	"credentials/delete",
	"credentials/list",
	"jobs/create",
	"jobs/next",
	"jobs/get",
	"jobs/list",
	"jobs/pause",
	"jobs/resume",
	"jobs/cancel",
	"jobs/retry",
	"jobs/rollback",
	"jobs/records",
	"jobs/log.csv",
	"jobs/plan",
	"jobs/start",
	"jobs/step",
	"jobs/status",
	"schema/apply",
	"templates/list",
	"templates/get",
	"templates/create",
	"templates/update",
	"templates/delete",
	"templates/export",
	"templates/import",
];
const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;

describe("createPlugin", () => {
	const plugin = createPlugin();

	it("declares the M6c routes as strict JSON POST routes, with a 2 MiB body for jobs/plan", () => {
		expect(PLAN_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
		expect(plugin.routes["jobs/plan"]?.request).toEqual({
			body: "json",
			maxBytes: PLAN_BODY_MAX_BYTES,
		});
		for (const name of ["jobs/start", "jobs/step", "jobs/status"]) {
			expect(plugin.routes[name], name).not.toHaveProperty("request");
		}
		// isJsonPostRouteContract (@emdash-cms/plugin-types dist/index.js:94-96, not a dependency
		// of this package): no raw response, POST allowed, a JSON body if one is declared.
		for (const name of ["jobs/plan", "jobs/start", "jobs/step", "jobs/status"]) {
			const route = plugin.routes[name]!;
			expect(route.methods, name).toEqual(["POST"]);
			expect(route, name).not.toHaveProperty("response");
			expect(route.request?.body ?? "json", name).toBe("json");
		}
		const input = (name: string) => plugin.routes[name]!.input!;
		const plan = { templateId: "T1", text: "sku\nA\n" };
		expect(input("jobs/plan").safeParse(plan).success).toBe(true);
		expect(input("jobs/plan").safeParse({ templateId: "T1", sourceId: "S1" }).success).toBe(true);
		for (const bad of [
			{ templateId: "T1" },
			{ ...plan, sourceId: "S1" },
			{ ...plan, missing: false },
			{ ...plan, journal: false },
			{ ...plan, text: "" },
			{ ...plan, batchSize: 0 },
			{ ...plan, batchSize: 501 },
			{ ...plan, batchSize: 1.5 },
			{ ...plan, budgetMs: 499 },
			{ ...plan, budgetMs: 25_001 },
		]) {
			expect(input("jobs/plan").safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
		expect(input("jobs/start").safeParse({ dryRunId: "D1", batchSize: 5 }).success).toBe(true);
		expect(input("jobs/start").safeParse({ dryRunId: "D1", publish: true }).success).toBe(false);
		expect(input("jobs/step").safeParse({ id: "J1", extra: 1 }).success).toBe(false);
		const status = { id: "J1", records: "planned", cursor: "c1" };
		expect(input("jobs/status").safeParse(status).success).toBe(true);
		expect(input("jobs/status").safeParse({ id: "J1", records: "nope" }).success).toBe(false);
		expect(input("jobs/status").safeParse({ ...status, extra: 1 }).success).toBe(false);
		const edges = { batchSize: 1, budgetMs: 500 };
		expect(input("jobs/plan").safeParse({ ...plan, ...edges }).success).toBe(true);
		expect(
			input("jobs/plan").safeParse({ ...plan, batchSize: 500, budgetMs: 25_000 }).success,
		).toBe(true);
		expect(input("jobs/start").safeParse({ dryRunId: "D1", batchSize: 0 }).success).toBe(false);
		expect(input("jobs/start").safeParse({ dryRunId: "D1", budgetMs: 25_001 }).success).toBe(false);
	});

	it("declares every API route with import:execute", () => {
		expect(Object.keys(plugin.routes).sort()).toEqual([...ROUTES].sort());
		for (const name of ROUTES) expect(plugin.routes[name]?.permission).toBe("import:execute");
		expect(plugin.routes["jobs/log.csv"]).toMatchObject({ methods: ["GET"], response: "raw" });
		expect(plugin.routes["jobs/next"]?.methods).toEqual(["POST"]);
		expect(plugin.routes["sources/paste"]).toMatchObject({
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 * 1024 },
		});
	});

	it("sets FLUX_IMPORT_VERSION to 0.4.0", () => {
		expect(FLUX_IMPORT_VERSION).toBe("0.4.0");
	});

	it("declares the storage indexes the queries use", () => {
		expect(plugin.storage).toEqual(STORAGE);
		expect(STORAGE.records.indexes).toEqual([
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
			["jobId", "sourceKey"],
		]);
		expect(STORAGE.jobs.indexes).toEqual([
			"status",
			"createdAt",
			"uploadId",
			"sourceUploadId",
			["templateId", "createdAt"],
			["scheduled", "status", "createdAt"],
			["feedSourceId", "status"],
		]);
		expect(STORAGE.schedules.indexes).toEqual(["name", "templateId", "sourceId"]);
		expect(STORAGE.templates.indexes).toEqual(["name", "collection", "owner"]);
		expect(STORAGE.links.indexes).toEqual(["entryId", ["owner", "collection", "locale"]]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
		expect(STORAGE.media.indexes).toEqual(["jobId", "mediaId"]);
		expect(STORAGE.journal.indexes).toEqual(["jobId", ["jobId", "seq"]]);
		expect(STORAGE.journalMedia.indexes).toEqual(["jobId", ["jobId", "seq"]]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
		expect(plugin.admin.settingsSchema?.retentionDays).toMatchObject({
			type: "number",
			default: 30,
			min: 0,
		});
		expect(plugin.admin.settingsSchema?.credentials).toMatchObject({ type: "secret" });
		expect(plugin.hooks["plugin:activate"]).toBeDefined();
		expect(plugin.hooks.cron?.timeout).toBe(60_000);
		expect(plugin.capabilities).toEqual([
			"content:read",
			"content:write",
			"content:publish",
			"content:restore",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			"media:write",
			"users:read",
			// definePlugin adds the read capabilities that taxonomies:write and media:write imply.
			"taxonomies:read",
			"media:read",
		]);
	});

	it("validates route input with Zod", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		expect(create.safeParse({ uploadId: UPLOAD_ID, template: {}, dryRun: true }).success).toBe(
			true,
		);
		expect(create.safeParse({ uploadId: "../x", template: {}, dryRun: true }).success).toBe(false);
		expect(create.safeParse({ uploadId: UPLOAD_ID, template: {} }).success).toBe(false);
		const sample = plugin.routes["sources/sample"]!.input!;
		expect(sample.safeParse({ uploadId: UPLOAD_ID, n: 21 }).success).toBe(false);
		expect(sample.parse({ uploadId: UPLOAD_ID })).toEqual({ uploadId: UPLOAD_ID, n: 5 });
		expect(
			sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "xml", records: "feed/item" } })
				.success,
		).toBe(true);
		expect(sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "yaml" } }).success).toBe(
			false,
		);
		expect(
			sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "xlsx", sheet: 2, headerRow: 3 } })
				.success,
		).toBe(true);
		const paste = plugin.routes["sources/paste"]!.input!;
		expect(paste.safeParse({ format: "json", text: "[]" }).success).toBe(true);
		expect(paste.safeParse({ format: "yaml", text: "x" }).success).toBe(false);
		expect(paste.safeParse({ format: "csv" }).success).toBe(false);
		expect(plugin.routes["jobs/get"]!.input!.safeParse({ id: "a/b" }).success).toBe(false);
		expect(
			plugin.routes["jobs/records"]!.input!.safeParse({ id: "J1", status: "bogus" }).success,
		).toBe(false);
		for (const route of ["jobs/records", "jobs/log.csv"]) {
			for (const status of ["filtered", "reverted"]) {
				expect(plugin.routes[route]!.input!.safeParse({ id: "J1", status }).success).toBe(true);
			}
		}
	});

	it("takes exactly one of uploadId and sourceId in jobs/create", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const base = { template: {}, dryRun: false };
		expect(create.safeParse({ ...base, uploadId: UPLOAD_ID }).success).toBe(true);
		expect(create.safeParse({ ...base, sourceId: "01JZSRC", force: true }).success).toBe(true);
		expect(create.safeParse({ ...base }).success).toBe(false);
		expect(create.safeParse({ ...base, uploadId: UPLOAD_ID, sourceId: "01JZSRC" }).success).toBe(
			false,
		);
		expect(create.safeParse({ ...base, sourceId: "a/b" }).success).toBe(false);
	});

	it("accepts the journal option in jobs/create, and only a boolean", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const base = { template: {}, dryRun: false, uploadId: UPLOAD_ID };
		expect(create.parse({ ...base, journal: false })).toMatchObject({ journal: false });
		expect(create.safeParse({ ...base, journal: "no" }).success).toBe(false);
	});

	it("validates schema/apply input, refusing required, unique, defaults and validation", () => {
		const apply = plugin.routes["schema/apply"]!.input!;
		const field = { slug: "stage", type: "select", options: ["draft"], label: "Stage" };
		expect(apply.safeParse({ collection: "products", fields: [field] }).success).toBe(true);
		expect(apply.safeParse({ template: {}, addOptions: true, dryRun: true }).success).toBe(true);
		expect(apply.safeParse({ collection: "products" }).success).toBe(false);
		expect(apply.safeParse({ fields: [field], template: {} }).success).toBe(false);
		expect(apply.safeParse({ collection: "products", fields: [] }).success).toBe(false);
		expect(
			apply.safeParse({ collection: "products", fields: Array.from({ length: 101 }, () => field) })
				.success,
		).toBe(false);
		for (const extra of [
			{ required: true },
			{ unique: true },
			{ defaultValue: "draft" },
			{ validation: { options: ["x"] } },
		]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ ...field, ...extra }] }).success,
			).toBe(false);
		}
		for (const type of ["reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
		}
		for (const type of ["image", "file", "portableText"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(true);
		}
		expect(apply.safeParse({ collection: "products", fields: [field], extra: 1 }).success).toBe(
			false,
		);
	});

	it("validates source input", () => {
		const createSource = plugin.routes["sources/create"]!.input!;
		expect(createSource.safeParse({ name: "Feed", url: "https://x.example/f.csv" }).success).toBe(
			true,
		);
		expect(createSource.safeParse({ name: "", url: "https://x.example/" }).success).toBe(false);
		expect(createSource.safeParse({ name: "x".repeat(101), url: "https://x/" }).success).toBe(
			false,
		);
		expect(
			createSource.safeParse({ name: "Feed", url: `https://x.example/${"a".repeat(2048)}` })
				.success,
		).toBe(false);
		expect(
			createSource.safeParse({ name: "Feed", url: "https://x/", credential: "Bad Name" }).success,
		).toBe(false);
		const update = plugin.routes["sources/update"]!.input!;
		expect(update.safeParse({ id: "S1", credential: null }).success).toBe(true);
		expect(update.safeParse({ id: "S1", credential: "supplier" }).success).toBe(true);
	});

	it("validates credential input", () => {
		const set = plugin.routes["credentials/set"]!.input!;
		const ok = { name: "supplier-1", header: "Authorization", value: "Bearer abc" };
		expect(set.safeParse(ok).success).toBe(true);
		expect(set.safeParse({ ...ok, header: "X-Api-Key" }).success).toBe(true);
		for (const name of ["", "Supplier", "a_b", "a".repeat(65)]) {
			expect(set.safeParse({ ...ok, name }).success, name).toBe(false);
		}
		for (const header of [
			"Host",
			"cookie",
			"Content-Length",
			"Transfer-Encoding",
			"Connection",
			"Keep-Alive",
			"Upgrade",
			"TE",
			"Proxy-Authorization",
			"If-None-Match",
			"Bad Header",
			"X:Y",
			"",
		]) {
			expect(set.safeParse({ ...ok, header }).success, header).toBe(false);
		}
		for (const value of ["", "a\r\nX-Injected: 1", "line\nbreak", "a".repeat(4097), "tab\u0000"]) {
			expect(set.safeParse({ ...ok, value }).success, JSON.stringify(value)).toBe(false);
		}
		expect(set.safeParse({ ...ok, value: "a".repeat(4096) }).success).toBe(true);
	});

	it("never echoes a credential value in a validation error", () => {
		const set = plugin.routes["credentials/set"]!.input!;
		const result = set.safeParse({
			name: "supplier",
			header: "Authorization",
			value: "Bearer top-secret\n",
		});
		expect(result.success).toBe(false);
		// EmDash answers an invalid body with z.formatError(error) (emdash src/plugins/routes.ts:247-257).
		const body = JSON.stringify(z.formatError(result.error!));
		expect(body).toContain("printable ASCII");
		expect(body).not.toContain("top-secret");
	});

	it("accepts and rejects the same source blocks as the template schema", () => {
		const sample = plugin.routes["sources/sample"]!.input!;
		const inputs: unknown[] = [
			{},
			{ format: "csv" },
			{ format: "json" },
			{ format: "jsonl" },
			{ format: "xml", records: "feed/item" },
			{ format: "json", records: "data.items" },
			{ format: "csv", filter: "Price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != ''" },
			{ format: "xlsx" },
			{ format: "xlsx", sheet: "Products", headerRow: 2, filter: "Price > 0" },
			{ format: "xlsx", sheet: 3 },
			{ format: "xlsx", sheet: "" },
			{ format: "xlsx", sheet: "x".repeat(101) },
			{ format: "xlsx", sheet: 0 },
			{ format: "xlsx", sheet: 2.5 },
			{ format: "xlsx", headerRow: 0 },
			{ format: "xlsx", headerRow: 1_048_577 },
			{ format: "xlsx", headerRow: "2" },
			{ format: "json", filter: "" },
			{ format: "json", filter: 5 },
			{ format: "yaml" },
			{ format: "json", records: "" },
			{ format: "json", records: 5 },
			{ format: "json", extra: true },
			{ format: null },
			"json",
		];
		for (const source of inputs) {
			expect(
				sample.safeParse({ uploadId: UPLOAD_ID, source }).success,
				JSON.stringify(source),
			).toBe(sourceSchema.safeParse(source).success);
		}
	});

	it("maps a source error code into the route error details", () => {
		const fromJob = toRouteError(
			new JobError("invalid_source", "bad", ["x at byte 0"], "xml_dtd_not_allowed"),
		);
		expect(fromJob).toMatchObject({
			code: "INVALID_SOURCE",
			details: { problems: ["x at byte 0"], code: "xml_dtd_not_allowed" },
		});
		const fromService = toRouteError(
			new ServiceError("INVALID_SOURCE", "bad", 400, { code: "csv_syntax" }),
		);
		expect(fromService).toMatchObject({ code: "INVALID_SOURCE", details: { code: "csv_syntax" } });
	});

	it("declares the M6a routes as JSON POST routes that pass definePlugin's MCP route checks (spec F10)", () => {
		const names = ROUTES.filter((r) => r.startsWith("templates/"));
		expect(names).toHaveLength(7);
		for (const name of names) {
			expect(plugin.routes[name], name).toMatchObject({
				methods: ["POST"],
				permission: "import:execute",
			});
			expect(plugin.routes[name]).not.toHaveProperty("response");
		}
		const tools = (routes: string[]) =>
			Object.fromEntries(
				routes.map((route) => [
					route.replace(/\W/g, "_"),
					{ description: route, route, input: z.object({}) },
				]),
			);
		const define = (routes: string[]) =>
			definePlugin({
				id: "probe-m6a",
				version: "0.0.1",
				routes: plugin.routes,
				mcp: { tools: tools(routes) },
			});
		// jobs/create and schema/apply declare request: { body: "json" } (their body cap), as do
		// templates/create, update and import: still JSON POST routes.
		expect(() =>
			define([...names, "jobs/create", "jobs/list", "schema/apply", "sources/paste"]),
		).not.toThrow();
		// The check bites: the raw log route can never be a tool, nor a route whose body is not JSON.
		expect(() => define(["jobs/log.csv"])).toThrow("cannot reference a raw response route");
		const textBody = {
			...plugin.routes["templates/create"]!,
			request: { body: "text" as const },
		};
		expect(() =>
			definePlugin({
				id: "probe-m6a",
				version: "0.0.1",
				routes: { ...plugin.routes, "templates/create": textBody },
				mcp: { tools: tools(["templates/create"]) },
			}),
		).toThrow("must reference a POST-compatible JSON route");
	});

	it("caps the JSON body of every route that takes a template at 2 MiB, and no other template route", () => {
		expect(TEMPLATE_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
		const capped = [
			"jobs/create",
			"schema/apply",
			"templates/create",
			"templates/update",
			"templates/import",
		];
		for (const name of capped) {
			expect(plugin.routes[name]?.request, name).toEqual({
				body: "json",
				maxBytes: TEMPLATE_BODY_MAX_BYTES,
			});
		}
		for (const name of [
			"templates/list",
			"templates/get",
			"templates/delete",
			"templates/export",
		]) {
			expect(plugin.routes[name], name).not.toHaveProperty("request");
		}
	});

	it("validates the template route inputs", () => {
		const input = (name: string) => plugin.routes[name]!.input!;
		const t = { version: 1 };
		const create = input("templates/create");
		expect(create.safeParse({ name: "Feed", template: t }).success).toBe(true);
		expect(
			create.safeParse({ name: "Feed", description: "x".repeat(2000), template: t }).success,
		).toBe(true);
		expect(
			create.safeParse({ name: "Feed", description: "x".repeat(2001), template: t }).success,
		).toBe(false);
		for (const name of ["", "x".repeat(101), " Feed", "Feed\u200d"]) {
			expect(create.safeParse({ name, template: t }).success, JSON.stringify(name)).toBe(false);
		}
		// The caller cannot set the author: unknown keys are stripped.
		expect(create.parse({ name: "Feed", template: t, createdBy: "mallory" })).not.toHaveProperty(
			"createdBy",
		);
		const update = input("templates/update");
		expect(update.safeParse({ id: "T1", revision: 1, description: null }).success).toBe(true);
		expect(update.safeParse({ id: "T1", revision: 1 }).success).toBe(false);
		expect(update.safeParse({ id: "T1", name: "x" }).success).toBe(false);
		expect(update.safeParse({ id: "T1", revision: 0, name: "x" }).success).toBe(false);
		expect(input("templates/delete").safeParse({ id: "T1" }).success).toBe(false);
		expect(input("templates/delete").safeParse({ id: "T1", revision: 2 }).success).toBe(true);
		expect(input("templates/get").safeParse({ id: "a/b" }).success).toBe(false);
		const imp = input("templates/import");
		expect(imp.safeParse({ file: {}, owner: "shop-2" }).success).toBe(true);
		expect(imp.safeParse({ file: {}, owner: "shop feed" }).success).toBe(false);
		expect(imp.safeParse({ file: {}, name: "Feed " }).success).toBe(false);
		expect(input("templates/list").safeParse({ collection: "products" }).success).toBe(true);
	});

	it("takes exactly one of template and templateId in jobs/create, and of fields, template and templateId in schema/apply", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const base = { uploadId: UPLOAD_ID, dryRun: false };
		expect(create.safeParse({ ...base, templateId: "01JZTPL" }).success).toBe(true);
		expect(create.safeParse({ ...base, templateId: "01JZTPL", templateRevision: 3 }).success).toBe(
			true,
		);
		expect(create.safeParse({ ...base }).success).toBe(false);
		expect(create.safeParse({ ...base, template: {}, templateId: "01JZTPL" }).success).toBe(false);
		expect(create.safeParse({ ...base, template: {}, templateRevision: 3 }).success).toBe(false);
		const apply = plugin.routes["schema/apply"]!.input!;
		expect(apply.safeParse({ templateId: "01JZTPL", collection: "products" }).success).toBe(true);
		expect(apply.safeParse({ templateId: "01JZTPL", template: {} }).success).toBe(false);
		expect(apply.safeParse({}).success).toBe(false);
		const list = plugin.routes["jobs/list"]!.input!;
		expect(list.parse({ templateId: "01JZTPL", status: "completed" })).toEqual({
			templateId: "01JZTPL",
			status: "completed",
		});
		expect(list.safeParse({ templateId: "a/b" }).success).toBe(false);
	});

	it("refuses to stage pasted XLSX before touching the runtime", async () => {
		const ctx = {
			input: { format: "xlsx", text: "PK" },
			user: { id: "u1", role: 50 },
		} as unknown as RouteContext;
		await expect(plugin.routes["sources/paste"]!.handler(ctx)).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "INVALID_FORMAT",
			status: 400,
			message: "An XLSX workbook is a binary file and cannot be pasted; upload it instead",
		});
	});

	it("refuses a call without a user before touching the runtime", async () => {
		const ctx = { input: { id: "J1" }, user: undefined } as unknown as RouteContext;
		await expect(plugin.routes["jobs/get"]!.handler(ctx)).rejects.toMatchObject({
			name: "PluginRouteError",
			status: 401,
		});
	});
	it("maps EmDash's cursor error to INVALID_CURSOR, by name (M6c, plan Ruling 1)", () => {
		const copy = Object.assign(new Error("Invalid pagination cursor: x"), {
			name: "InvalidCursorError",
		});
		for (const e of [new InvalidCursorError("x"), copy]) {
			const mapped = toRouteError(e);
			expect(mapped).toBeInstanceOf(PluginRouteError);
			expect(mapped).toMatchObject({
				code: "INVALID_CURSOR",
				message: "The cursor is not valid; start again without it",
				status: 400,
			});
		}
		const other = new Error("boom");
		expect(toRouteError(other)).toBe(other);
	});

	it("strips origin, id, dryRunOf and the schedule markers from jobs/create's input (M6c, spec Ruling 31; M6b)", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const parsed = create.parse({
			uploadId: UPLOAD_ID,
			template: {},
			dryRun: false,
			origin: "agent",
			id: "R1",
			dryRunOf: "D1",
			scheduleId: "SCH1",
			scheduled: "open",
			feedSourceId: "S1",
		}) as Record<string, unknown>;
		expect(parsed).toEqual({ uploadId: UPLOAD_ID, template: {}, dryRun: false });
		for (const key of ["origin", "id", "dryRunOf", "scheduleId", "scheduled", "feedSourceId"]) {
			expect(key in parsed).toBe(false);
		}
	});
});
