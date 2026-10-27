import { z } from "astro/zod";
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";
import { JobError } from "../../src/engine/jobs.js";
import { sourceSchema } from "../../src/engine/template.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "../../src/plugin/retention.js";
import { ensureRetentionScheduled, toRouteError } from "../../src/plugin/routes.js";
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
	"jobs/records",
	"jobs/log.csv",
	"schema/apply",
];
const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;

describe("createPlugin", () => {
	const plugin = createPlugin();

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

	it("declares the storage indexes the queries use", () => {
		expect(plugin.storage).toEqual(STORAGE);
		expect(STORAGE.records.indexes).toEqual([
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
		]);
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId", "sourceUploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
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
			"schema:read",
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
			expect(plugin.routes[route]!.input!.safeParse({ id: "J1", status: "filtered" }).success).toBe(
				true,
			);
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
		for (const type of ["portableText", "image", "file", "reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
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
});

describe("ensureRetentionScheduled", () => {
	it("schedules the daily task once", async () => {
		const scheduled: string[] = [];
		const tasks: { name: string }[] = [];
		const cron = {
			list: async () =>
				tasks.map((t) => ({ ...t, schedule: RETENTION_SCHEDULE, nextRunAt: "", lastRunAt: null })),
			schedule: async (name: string, opts: { schedule: string }) => {
				scheduled.push(`${name}@${opts.schedule}`);
				tasks.push({ name });
			},
			cancel: async () => {},
		};
		await ensureRetentionScheduled({ cron });
		await ensureRetentionScheduled({ cron });
		expect(scheduled).toEqual([`${RETENTION_TASK}@0 3 * * *`]);
		await expect(ensureRetentionScheduled({})).resolves.toBeUndefined();
	});
});
