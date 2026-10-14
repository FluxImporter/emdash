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
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
		expect(plugin.admin.settingsSchema?.retentionDays).toMatchObject({
			type: "number",
			default: 30,
			min: 0,
		});
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
		const paste = plugin.routes["sources/paste"]!.input!;
		expect(paste.safeParse({ format: "json", text: "[]" }).success).toBe(true);
		expect(paste.safeParse({ format: "xlsx", text: "x" }).success).toBe(false);
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
