import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { Job } from "../../src/engine/types.js";
import {
	jsonTemplate,
	MALFORMED,
	MALFORMED_OUTCOMES,
	productsJson,
	productsJsonl,
	productsXml,
	xmlTemplate,
} from "../fixtures/formats.js";
import { makeDeps } from "./fakes.js";

const schemaFields = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "released", type: "datetime" },
];

const FORMATS = [
	["JSON", (n: number) => productsJson(n), jsonTemplate("products")],
	[
		"JSON at a records path",
		(n: number) => productsJson(n, { wrapped: true }),
		jsonTemplate("products", { format: "json", records: "data.products" }),
	],
	["JSON Lines", productsJsonl, jsonTemplate("products", { format: "jsonl" })],
	["XML", productsXml, xmlTemplate("products")],
] as const;

async function setup(body: string, template: unknown, batchSize = 50) {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", body);
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, batchSize });
	return { deps, clock, job };
}

async function runToEnd(deps: Parameters<typeof runBatch>[0], id: string): Promise<Job> {
	for (let i = 0; i < 100_000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function outcomes(deps: Parameters<typeof runBatch>[0], jobId: string) {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((r) => [r.data.status, r.data.errors?.[0]?.code]);
}

describe.each(FORMATS)("%s import", (_name, body, template) => {
	it("imports every record in resumable batches with typed values", async () => {
		const { deps, job } = await setup(body(10), template, 3);
		expect(job.warnings).toEqual([]);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = [...deps.content.entries.values()];
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10);
		expect(entries.find((e) => e.data.flux_source_id === "SKU-1")).toMatchObject({
			slug: "product-1",
			data: {
				title: 'Product 1, "quoted" & <tagged> ț',
				price: 1.5,
				released: "2026-03-01T22:00:00.000Z",
			},
		});
	});

	it("reports every record unchanged when the same file is imported again", async () => {
		const { deps, job } = await setup(body(5), template);
		await runToEnd(deps, job.id);
		const again = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect((await runToEnd(deps, again.id)).counters).toMatchObject({ unchanged: 5, created: 0 });
	});

	it("imports 10,000 records", async () => {
		const { deps, job } = await setup(body(10_000), template, 500);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 10_000, failed: 0 });
		expect(deps.content.entries.size).toBe(10_000);
	}, 60_000);
});

describe.each([
	["JSON", MALFORMED.json, jsonTemplate("products"), "source_syntax"],
	["JSON Lines", MALFORMED.jsonl, jsonTemplate("products", { format: "jsonl" }), null],
	["XML", MALFORMED.xml, xmlTemplate("products"), "source_syntax"],
] as const)("malformed %s", (_name, body, template, jobError) => {
	it("logs bad records, imports the good ones and fails the job only at a structural break", async () => {
		const { deps, job } = await setup(body, template, 2);
		const done = await runToEnd(deps, job.id);
		expect(await outcomes(deps, job.id)).toEqual(MALFORMED_OUTCOMES);
		expect(done.counters).toMatchObject({ created: 3, failed: 3 });
		if (jobError === null) expect(done).toMatchObject({ status: "completed", error: null });
		else expect(done).toMatchObject({ status: "failed", error: { code: jobError } });
	});
});

describe("retry on structured sources", () => {
	it("re-reads a failed JSON record by its start offset", async () => {
		const { deps, job } = await setup(productsJson(4, { wrapped: true }), FORMATS[1][2]);
		deps.content.failWrite = (data) =>
			data.flux_source_id === "SKU-2" ? new ContentWriteError("validation", "Too long") : null;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({ created: 3, failed: 1 });
		deps.content.failWrite = () => null;
		await transitionJob(deps, job.id, "retry");
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 4, failed: 0 });
	});

	it.each([
		["CSV", "sku,Name\nA1,Desk\nB2,Chair\n", { format: "csv" }, "Name", "csv_syntax"],
		[
			"JSON Lines",
			'{"sku": "A1", "name": "Desk"}\n{"sku": "B2", "name": "Chair"}\n',
			{ format: "jsonl" },
			"name",
			"source_syntax",
		],
	] as const)(
		"fails a %s retry that finds no record at the saved offset",
		async (_name, body, source, from, code) => {
			const template = {
				version: 1,
				collection: "products",
				locale: "en",
				source,
				key: { from: "sku" },
				fields: { title: { from, type: "text" } },
			};
			const { deps, job } = await setup(body, template);
			deps.content.failWrite = (data) =>
				data.flux_source_id === "B2" ? new ContentWriteError("validation", "Too long") : null;
			expect((await runToEnd(deps, job.id)).counters).toMatchObject({ created: 1, failed: 1 });
			const page = await deps.records.query({
				where: { jobId: job.id, status: "failed" },
				limit: 10,
			});
			const failed = page.items[0];
			if (!failed) throw new Error("no failed row");
			await deps.records.put(failed.id, {
				...failed.data,
				start: new TextEncoder().encode(body).length,
			});
			deps.content.failWrite = () => null;
			await transitionJob(deps, job.id, "retry");
			const done = await runToEnd(deps, job.id);
			expect(done).toMatchObject({ status: "failed", error: { code } });
		},
	);
});

describe("jobs created before M3a", () => {
	it("still run as CSV from their stored headers", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name\nA1,Desk\nB2,Chair\n");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { title: { from: "Name", type: "text" } },
			},
			schemaFields,
		});
		const { source: _s, columns, warnings: _w, template, ...rest } = job;
		const { source: _ts, ...oldTemplate } = template;
		const legacy = { ...rest, template: oldTemplate, headers: columns } as unknown as Job;
		await deps.jobs.put(job.id, legacy);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 2 } });
	});

	it("run as CSV when stored in the pre-M3a shape", async () => {
		const { deps } = makeDeps();
		const body = "sku,Name\nA1,Desk\nB2,Chair,extra\nC3,Lamp\n";
		deps.source.add("u1", body);
		const now = "2026-10-07T10:00:00.000Z";
		const legacy = {
			id: "old1",
			status: "created",
			uploadId: "u1",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { title: { from: "Name", type: "text" } },
			},
			dryRun: false,
			publish: true,
			batchSize: 2,
			budgetMs: 4000,
			headers: ["sku", "Name"],
			cursor: { offset: "sku,Name\n".length, seq: 0 },
			counters: { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0 },
			lease: null,
			phase: "import",
			retryFromSeq: 0,
			schemaReady: false,
			error: null,
			failures: 0,
			createdAt: now,
			updatedAt: now,
		} as unknown as Job;
		await deps.jobs.put("old1", legacy);
		const done = await runToEnd(deps, "old1");
		expect(done).toMatchObject({ status: "completed", counters: { created: 2, failed: 1 } });
		expect(await outcomes(deps, "old1")).toEqual([
			["created", undefined],
			["failed", "column_count"],
			["created", undefined],
		]);
		expect([...deps.content.entries.values()].map((e) => e.data.title)).toEqual(["Desk", "Lamp"]);
	});
});
