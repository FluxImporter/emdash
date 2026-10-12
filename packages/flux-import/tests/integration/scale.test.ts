import { describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";
import { productsCsv, template } from "./fixtures.js";

const client = new Client(inject("baseUrl"), inject("token"));

describe("10,000 rows", () => {
	it("imports and publishes every row in resumable batches", async () => {
		await client.createProducts("it_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_scale"),
			dryRun: false,
			batchSize: 500,
			budgetMs: 20_000,
		});
		const started = Date.now();
		const done = await client.runToEnd(job.id);
		console.info(`10,000 rows imported in ${Math.round((Date.now() - started) / 1000)} s`);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10_000, failed: 0 } });
		// A finished cursor must not re-read the file (ranged read past the end).
		expect((await client.plugin("jobs/next", { id: job.id })).counters.created).toBe(10_000);
		const entries = await client.listAll("it_scale");
		expect(entries).toHaveLength(10_000);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});
});
