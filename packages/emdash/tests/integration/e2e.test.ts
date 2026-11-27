import { beforeAll, describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";
import { productsCsv, template } from "./fixtures.js";

const COLLECTION = "it_e2e";
const client = new Client(inject("baseUrl"), inject("token"));

describe("import end to end (10 rows)", () => {
	beforeAll(async () => {
		await client.createProducts(COLLECTION);
	});

	it("uploads, samples, imports and publishes every row", async () => {
		const csv = productsCsv(10);
		const upload = await client.upload(csv);
		expect(upload.bytes).toBe(new TextEncoder().encode(csv).byteLength);
		expect(upload.sha256).toMatch(/^[0-9a-f]{64}$/);

		const sample = await client.plugin<{ headers: string[]; rows: string[][] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 3,
		});
		expect(sample.headers).toEqual(["sku", "Name", "Price", "Released", "Handle"]);
		expect(sample.rows).toHaveLength(3);

		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template: template(COLLECTION),
			dryRun: false,
			batchSize: 4,
		});
		expect(job.status).toBe("created");
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 10, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(COLLECTION);
		expect(entries).toHaveLength(10);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first).toMatchObject({ slug: "product-0", status: "published", draftRevisionId: null });
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted"', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));
		expect(await client.fieldSlugs(COLLECTION)).toContain("flux_source_id");
	});
});
