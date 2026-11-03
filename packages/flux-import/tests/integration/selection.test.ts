import { describe, expect, inject, it } from "vitest";
import {
	jsonTemplate,
	productsJson,
	productsJsonl,
	productsXml,
	withSelection,
	xmlTemplate,
} from "../fixtures/formats.js";
import { ApiError, Client } from "./client.js";
import { template as csvTemplate, productsCsv } from "./fixtures.js";

const client = new Client(inject("baseUrl"), inject("token"));

const NAME_4 = 'Product 4, "quoted" & <tagged> ț';
const CASES = [
	{
		name: "CSV",
		collection: "it_sel_csv",
		filename: "feed.csv",
		body: productsCsv(10),
		template: (c: string) => withSelection(csvTemplate(c), "csv"),
		title4: 'SKU-4 / Product 4, "quoted"',
	},
	{
		name: "JSON",
		collection: "it_sel_json",
		filename: "feed.json",
		body: productsJson(10, { wrapped: true }),
		template: (c: string) =>
			withSelection(jsonTemplate(c, { format: "json", records: "data.products" }), "json"),
		title4: `SKU-4 / ${NAME_4}`,
	},
	{
		name: "JSON Lines",
		collection: "it_sel_jsonl",
		filename: "feed.jsonl",
		body: productsJsonl(10),
		template: (c: string) => withSelection(jsonTemplate(c, { format: "jsonl" }), "jsonl"),
		title4: `SKU-4 / ${NAME_4}`,
	},
	{
		name: "XML",
		collection: "it_sel_xml",
		filename: "feed.xml",
		body: productsXml(10),
		template: (c: string) => withSelection(xmlTemplate(c), "xml"),
		title4: `SKU-4 / ${NAME_4}`,
	},
];

describe.each(CASES)("filter and expr on $name (10 records)", (c) => {
	it("imports the six records the filter keeps with computed titles and logs the rest", async () => {
		await client.createProducts(c.collection);
		const { uploadId } = await client.upload(c.body, c.filename);
		const template = c.template(c.collection);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ status: "created", source: template.source, warnings: [] });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 6, filtered: 4, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(c.collection);
		expect(entries.map((e) => e.data.flux_source_id).sort()).toEqual([
			"SKU-4",
			"SKU-5",
			"SKU-6",
			"SKU-7",
			"SKU-8",
			"SKU-9",
		]);
		const four = entries.find((e) => e.data.flux_source_id === "SKU-4")!;
		expect(four).toMatchObject({ slug: "product-4", status: "published" });
		expect(four.data).toMatchObject({ title: c.title4, price: 4.5 });

		const filtered = await client.records(job.id, "filtered");
		expect(filtered.map((r) => [r.seq, r.sourceKey, r.entryId])).toEqual([
			[0, null, null],
			[1, null, null],
			[2, null, null],
			[3, null, null],
		]);
		const res = await client.raw(
			"GET",
			`/_emdash/api/plugins/flux-import/jobs/log.csv?id=${job.id}&status=filtered`,
		);
		expect(res.status).toBe(200);
		expect((await res.text()).trimEnd().split("\r\n").slice(1)).toEqual([
			"1,filtered,,,,,,,",
			"2,filtered,,,,,,,",
			"3,filtered,,,,,,,",
			"4,filtered,,,,,,,",
		]);

		// The same file again: expressions are deterministic, so nothing changes.
		const again = await client.plugin("jobs/create", {
			uploadId: (await client.upload(c.body, c.filename)).uploadId,
			template,
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({
			unchanged: 6,
			updated: 0,
			filtered: 4,
		});
	});
});

describe("expressions at job creation", () => {
	it("answers 400 INVALID_TEMPLATE for a syntax error or a banned function", async () => {
		await client.createProducts("it_sel_bad");
		const { uploadId } = await client.upload(productsJson(2), "bad.json");
		for (const patch of [
			{ source: { format: "json", filter: "price.amount >" } },
			{ key: { expr: "sku & $random()" } },
			{ key: { from: "sku", expr: "sku" } },
		]) {
			const error = await client
				.plugin("jobs/create", {
					uploadId,
					template: { ...jsonTemplate("it_sel_bad"), ...patch },
					dryRun: true,
				})
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status: 400, code: "INVALID_TEMPLATE" });
		}
	});
});
