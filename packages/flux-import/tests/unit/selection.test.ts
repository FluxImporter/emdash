import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { buildLogCsv } from "../../src/engine/log.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { EngineDeps, Job } from "../../src/engine/types.js";
import { getJob, listJobs } from "../../src/plugin/service.js";
import {
	jsonTemplate,
	productsJson,
	productsJsonl,
	productsXml,
	withSelection,
	xmlTemplate,
} from "../fixtures/formats.js";
import { template as csvTemplate, productsCsv } from "../integration/fixtures.js";
import { makeDeps } from "./fakes.js";

const schemaFields = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "released", type: "datetime" },
];

async function setup(
	body: string,
	template: unknown,
	opts: { dryRun?: boolean; batchSize?: number } = {},
) {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", body);
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, ...opts });
	return { deps, clock, job };
}

async function runToEnd(deps: EngineDeps, id: string): Promise<Job> {
	for (let i = 0; i < 10_000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: EngineDeps, jobId: string) {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((r) => r.data);
}

const titles = (deps: ReturnType<typeof makeDeps>["deps"]) =>
	Object.fromEntries(
		[...deps.content.entries.values()].map((e) => [e.data.flux_source_id, e.data.title]),
	);

const FORMATS = [
	["CSV", productsCsv, withSelection(csvTemplate("products"), "csv"), 'Product 4, "quoted"'],
	[
		"JSON",
		(n: number) => productsJson(n),
		withSelection(jsonTemplate("products"), "json"),
		'Product 4, "quoted" & <tagged> ț',
	],
	[
		"JSON Lines",
		productsJsonl,
		withSelection(jsonTemplate("products", { format: "jsonl" }), "jsonl"),
		'Product 4, "quoted" & <tagged> ț',
	],
	[
		"XML",
		productsXml,
		withSelection(xmlTemplate("products"), "xml"),
		'Product 4, "quoted" & <tagged> ț',
	],
] as const;

describe.each(FORMATS)("filter and expr on %s", (_name, body, template, name4) => {
	it("imports the records the filter keeps, with computed titles, and counts the rest", async () => {
		const { deps, job } = await setup(body(10), template, { batchSize: 3 });
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed" });
		expect(done.counters).toEqual({
			created: 6,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 4,
		});
		expect(titles(deps)).toMatchObject({ "SKU-4": `SKU-4 / ${name4}` });
		expect(Object.keys(titles(deps)).sort()).toEqual(
			["SKU-4", "SKU-5", "SKU-6", "SKU-7", "SKU-8", "SKU-9"].sort(),
		);
		const statuses = (await rows(deps, job.id)).map((r) => [r.status, r.sourceKey]);
		expect(statuses.slice(0, 5)).toEqual([
			["filtered", null],
			["filtered", null],
			["filtered", null],
			["filtered", null],
			["created", "SKU-4"],
		]);
	});
});

describe("filtered records", () => {
	const csvSelection = withSelection(csvTemplate("products"), "csv");

	it("never reach the content port, and need no key", async () => {
		const body =
			"sku,Name,Price,Released,Handle\r\n,No key,1,01/03/2026,x\r\nS1,Cheap,2,01/03/2026,y\r\n";
		const { deps, job } = await setup(body, csvSelection);
		const touched: string[] = [];
		for (const method of [
			"get",
			"findBySourceId",
			"isLocked",
			"create",
			"update",
			"publish",
		] as const) {
			const original = deps.content[method].bind(deps.content) as (...a: unknown[]) => unknown;
			(deps.content as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
				touched.push(method);
				return original(...args);
			};
		}
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { filtered: 2, failed: 0 } });
		expect(touched).toEqual([]);
	});

	it("fails every record of a CSV filter that compares text with a number", async () => {
		const template = { ...csvTemplate("products"), source: { format: "csv", filter: "Price > 4" } };
		const { deps, job } = await setup(productsCsv(3), template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 0, failed: 3, filtered: 0 },
		});
		const errors = (await rows(deps, job.id)).map((r) => r.errors);
		expect(errors).toEqual(
			Array.from({ length: 3 }, () => [
				{
					field: "filter",
					code: "filter_error",
					message: expect.stringMatching(/^JSONata T2009 /),
				},
			]),
		);
		expect(deps.content.entries.size).toBe(0);
	});

	it("never include a record the reader could not parse: it fails as before", async () => {
		// A broken line has no value; run through the filter, it would read as filtered.
		const body = `${productsJsonl(5)}{"sku": "B", broken\n`;
		const template = withSelection(jsonTemplate("products", { format: "jsonl" }), "jsonl");
		const { deps, job } = await setup(body, template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 1, failed: 1, filtered: 4 },
		});
		expect((await rows(deps, job.id)).map((r) => [r.status, r.errors?.[0]?.code]).slice(4)).toEqual(
			[
				["created", undefined],
				["failed", "invalid_record"],
			],
		);
	});

	it("show as filtered in a dry run", async () => {
		const { deps, job } = await setup(productsCsv(6), csvSelection, { dryRun: true });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 2, filtered: 4 });
		expect((await rows(deps, job.id)).map((r) => r.status)).toEqual([
			"filtered",
			"filtered",
			"filtered",
			"filtered",
			"planned",
			"planned",
		]);
		expect(deps.content.entries.size).toBe(0);
	});

	it("are recounted, not double-counted, after a crash mid-batch", async () => {
		const { deps, clock, job } = await setup(productsCsv(10), csvSelection, { batchSize: 10 });
		let crashOn: string | null = "e2";
		deps.content.afterWrite = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ filtered: 4, failed: 0 });
		expect(done.counters.created + done.counters.conflict).toBe(6);
		const keys = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(keys).toHaveLength(6);
		expect(new Set(keys).size).toBe(6);
	});

	it("are not retried", async () => {
		const { deps, job } = await setup(productsCsv(10), csvSelection);
		let flaky = true;
		deps.content.failWrite = (data) =>
			flaky && data.flux_source_id === "SKU-5"
				? new ContentWriteError("timeout", "Upstream timeout")
				: null;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({
			created: 5,
			failed: 1,
			filtered: 4,
		});
		flaky = false;
		const callsBefore = deps.content.calls.length;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried).toMatchObject({
			status: "completed",
			counters: { created: 6, failed: 0, filtered: 4 },
		});
		expect(deps.content.calls.slice(callsBefore)).toEqual([
			"find:SKU-5",
			"create:e6",
			"publish:e6",
		]);
	});

	it("appear in the log CSV, which can be filtered to them", async () => {
		const { deps, job } = await setup(productsCsv(6), csvSelection);
		await runToEnd(deps, job.id);
		const lines = (await buildLogCsv(deps, job.id)).trimEnd().split("\r\n");
		expect(lines.slice(1, 6)).toEqual([
			"1,filtered,,,,,,",
			"2,filtered,,,,,,",
			"3,filtered,,,,,,",
			"4,filtered,,,,,,",
			"5,created,SKU-4,e1,create,,,",
		]);
		const only = (await buildLogCsv(deps, job.id, { status: "filtered" })).trimEnd().split("\r\n");
		expect(only).toHaveLength(5);
	});
});

describe("expression errors in a batch", () => {
	const template = {
		version: 1,
		collection: "products",
		locale: "en",
		source: { format: "json", filter: "$exists(keep) ? keep : price > 4" },
		key: { from: "sku" },
		fields: { title: { expr: "$uppercase(name)", type: "text" } },
	};

	it("fail only their record and the job completes", async () => {
		const body = JSON.stringify([
			{ sku: "A", price: 5, name: "a" },
			{ sku: "B", price: "5", name: "b" },
			{ sku: "C", price: 1, name: "c" },
			{ sku: "D", price: 7, name: { first: "d" } },
			{ sku: "E", price: 5, name: "e", keep: "yes" },
			{ sku: "F", price: 6, name: "f" },
		]);
		const { deps, job } = await setup(body, template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 2, failed: 3, filtered: 1 },
		});
		expect((await rows(deps, job.id)).map((r) => [r.status, r.errors?.[0]?.code])).toEqual([
			["created", undefined],
			["failed", "filter_error"],
			["filtered", undefined],
			["failed", "expr_error"],
			["failed", "filter_not_boolean"],
			["created", undefined],
		]);
		expect(titles(deps)).toEqual({ A: "A", F: "F" });
	});

	it("reports a runaway expression as expr_limit", async () => {
		const runaway = {
			...template,
			source: { format: "json" },
			fields: { title: { expr: "($f := function($n) { $f($n + 1) }; $f(0))", type: "text" } },
		};
		const { deps, job } = await setup('[{"sku": "A"}]', runaway);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { failed: 1 } });
		expect((await rows(deps, job.id))[0]!.errors).toEqual([
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		]);
	});

	it("fails a stored job whose expression no longer compiles with invalid_template", async () => {
		const { deps, job } = await setup('[{"sku": "A", "price": 5, "name": "a"}]', template);
		const stored = (await deps.jobs.get(job.id))!;
		await deps.jobs.put(job.id, {
			...stored,
			template: { ...stored.template, source: { format: "json", filter: "price >" } },
		});
		const after = await runBatch(deps, job.id, "driver");
		expect(after).toMatchObject({
			status: "failed",
			error: {
				code: "invalid_template",
				message: "source.filter: JSONata S0207 at character 7: Unexpected end of expression",
			},
		});
		expect(deps.content.entries.size).toBe(0);
	});
});

describe("jobs created before M3b", () => {
	it("read a missing filtered counter as 0", async () => {
		const { deps, job } = await setup(productsCsv(2), csvTemplate("products"));
		const { filtered: _omit, ...oldCounters } = job.counters;
		await deps.jobs.put(job.id, { ...job, counters: oldCounters } as Job);
		expect((await getJob(deps, job.id)).counters.filtered).toBe(0);
		expect((await listJobs(deps, {})).items[0]!.counters.filtered).toBe(0);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toEqual({
			created: 2,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
		});
		expect((await deps.jobs.get(job.id))!.counters.filtered).toBe(0);
	});

	it("take a pause before their first batch and still read 0", async () => {
		const { deps, job } = await setup(productsCsv(2), csvTemplate("products"));
		const { filtered: _omit, ...oldCounters } = job.counters;
		await deps.jobs.put(job.id, { ...job, counters: oldCounters } as Job);
		const paused = await transitionJob(deps, job.id, "pause");
		expect(paused.counters.filtered).toBe(0);
	});
});
