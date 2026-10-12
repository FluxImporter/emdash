import { describe, expect, inject, it } from "vitest";
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
import { ApiError, Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));

const JSON_PATHS = ["sku", "name", "price.amount", "price.currency", "released", "handle"];
const CASES = [
	{
		name: "JSON at a records path",
		collection: "it_json",
		filename: "feed.json",
		body: productsJson(10, { wrapped: true }),
		template: (c: string) => jsonTemplate(c, { format: "json", records: "data.products" }),
		paths: JSON_PATHS,
	},
	{
		name: "JSON Lines",
		collection: "it_jsonl",
		filename: "feed.ndjson",
		body: productsJsonl(10),
		template: (c: string) => jsonTemplate(c, { format: "jsonl" }),
		paths: JSON_PATHS,
	},
	{
		name: "XML",
		collection: "it_xml",
		filename: "feed.xml",
		body: productsXml(10),
		template: xmlTemplate,
		paths: ["@sku", "title", "title/@lang", "price", "price/@currency", "released", "handle"],
	},
];

describe.each(CASES)("$name end to end (10 records)", (c) => {
	it("uploads, samples, imports and publishes every record", async () => {
		await client.createProducts(c.collection);
		const upload = await client.upload(c.body, c.filename);
		expect(upload.bytes).toBe(Buffer.byteLength(c.body));
		const template = c.template(c.collection);

		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 3,
			source: template.source,
		});
		expect(sample.records).toHaveLength(3);
		expect(sample.paths).toEqual(c.paths);

		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ status: "created", source: template.source, warnings: [] });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 10, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(c.collection);
		expect(entries).toHaveLength(10);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first).toMatchObject({ slug: "product-0", status: "published", draftRevisionId: null });
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted" & <tagged> ț', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));

		// Typed values survive EmDash's round trip: the same file again changes nothing. The
		// finished job released its staged file, so the file is uploaded again.
		const again = await client.plugin("jobs/create", {
			uploadId: (await client.upload(c.body, c.filename)).uploadId,
			template,
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({ unchanged: 10, updated: 0 });
	});
});

describe.each([
	["JSON", "bad.json", MALFORMED.json, jsonTemplate, "source_syntax"],
	[
		"JSON Lines",
		"bad.jsonl",
		MALFORMED.jsonl,
		(c: string) => jsonTemplate(c, { format: "jsonl" }),
		null,
	],
	["XML", "bad.xml", MALFORMED.xml, xmlTemplate, "source_syntax"],
] as const)("malformed %s", (name, filename, body, template, jobError) => {
	it("logs bad records, keeps the good ones and fails the job only at a structural break", async () => {
		const collection = `it_bad_${name.replace(/\W/g, "").toLowerCase()}`;
		await client.createProducts(collection);
		const { uploadId } = await client.upload(body, filename);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template(collection),
			dryRun: false,
			batchSize: 2,
		});
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 3, failed: 3 });
		expect(done.status).toBe(jobError === null ? "completed" : "failed");
		if (jobError !== null) expect(done.error?.code).toBe(jobError);
		const rows = await client.records(job.id);
		expect(rows.map((r) => [r.status, r.errors?.[0]?.code])).toEqual(MALFORMED_OUTCOMES);
		const keys = (await client.listAll(collection)).map((e) => e.data.flux_source_id).sort();
		expect(keys).toEqual(["M-1", "M-2", "M-6"]);
	});
});

describe("job warnings", () => {
	it("returns and stores a warning for a path no sampled record has", async () => {
		await client.createProducts("it_warn");
		const { uploadId } = await client.upload(productsJson(3), "warn.json");
		const template = jsonTemplate("it_warn");
		template.fields.price.from = "price.value";
		const job = await client.plugin("jobs/create", { uploadId, template, dryRun: true });
		const warning = 'Path "price.value" was not found in the first 3 records';
		expect(job.warnings).toEqual([warning]);
		expect((await client.plugin<Job>("jobs/get", { id: job.id })).warnings).toEqual([warning]);
	});

	it("rejects a records path that is not in the document with INVALID_SOURCE", async () => {
		await client.createProducts("it_warn_records");
		const { uploadId } = await client.upload(productsJson(1, { wrapped: true }), "x.json");
		const error = await client
			.plugin("jobs/create", {
				uploadId,
				template: jsonTemplate("it_warn_records", { format: "json", records: "data.items" }),
				dryRun: true,
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 400, code: "INVALID_SOURCE" });
	});
});

describe("pasted snippets", () => {
	it("stages pasted JSON like an upload and imports it", async () => {
		await client.createProducts("it_paste");
		const text = productsJson(3);
		const staged = await client.paste("json", text);
		expect(staged.bytes).toBe(Buffer.byteLength(text));
		expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
		const job = await client.plugin("jobs/create", {
			uploadId: staged.uploadId,
			template: jsonTemplate("it_paste"),
			dryRun: false,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		expect(await client.listAll("it_paste")).toHaveLength(3);
	});

	it("rejects empty text and a request over 1 MiB", async () => {
		await expect(client.paste("csv", "")).rejects.toMatchObject({
			status: 400,
			code: "EMPTY_BODY",
		});
		await expect(client.paste("csv", "a".repeat(1024 * 1024))).rejects.toMatchObject({
			status: 413,
		});
	});
});
