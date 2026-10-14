import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { Client } from "../integration/client.js";
import { productsCsv, template } from "../integration/fixtures.js";
import { CF_SITE_DIR } from "./global-setup.js";

const client = new Client(inject("cfBaseUrl"), inject("cfToken"));

/** Runs SQL on the local D1 database the dev server uses (Task 14 Step 3 checks they share it). */
function d1(sql: string): void {
	execFileSync(
		process.execPath,
		[
			join(CF_SITE_DIR, "node_modules/wrangler/bin/wrangler.js"),
			"d1",
			"execute",
			"DB",
			"--local",
			"--command",
			sql,
		],
		{ cwd: CF_SITE_DIR, stdio: "pipe" },
	);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function importCsv(collection: string, csv: string, batchSize = 50) {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: template(collection),
		dryRun: false,
		batchSize,
		budgetMs: 20_000,
	});
	return client.runToEnd(job.id);
}

describe("workerd parity (D1, R2)", () => {
	it("uploads to R2 and imports 10 rows through plugin routes that reach the runtime", async () => {
		await client.createProducts("cf_e2e");
		const { uploadId } = await client.upload(productsCsv(10));
		const sample = await client.plugin<{ headers: string[]; rows: string[][] }>("sources/sample", {
			uploadId,
			n: 2,
		});
		expect(sample.rows).toHaveLength(2);
		const done = await importCsv("cf_e2e", productsCsv(10), 4);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = await client.listAll("cf_e2e");
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});

	it("imports 10 JSON records at a records path, and a pasted snippet staged to R2", async () => {
		await client.createProducts("cf_json");
		const { uploadId } = await client.upload(productsJson(10, { wrapped: true }), "feed.json");
		const template = jsonTemplate("cf_json", { format: "json", records: "data.products" });
		const sample = await client.plugin<{ records: unknown[] }>("sources/sample", {
			uploadId,
			n: 2,
			source: template.source,
		});
		expect(sample.records).toHaveLength(2);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });

		// Paste stages through FixedLengthStream into R2 (workerd only); same keys update nothing.
		const pasted = await client.paste("json", productsJson(3));
		const again = await client.plugin("jobs/create", {
			uploadId: pasted.uploadId,
			template: jsonTemplate("cf_json"),
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({ unchanged: 3, failed: 0 });
		const entries = await client.listAll("cf_json");
		expect(entries).toHaveLength(10);
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});

	it("filters and computes JSON records, and stops a runaway expression by its step count", async () => {
		await client.createProducts("cf_select");
		const { uploadId } = await client.upload(productsJson(10), "feed.json");
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: withSelection(jsonTemplate("cf_select"), "json"),
			dryRun: false,
			batchSize: 4,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 6, filtered: 4, failed: 0 },
		});
		const entries = await client.listAll("cf_select");
		expect(entries.find((e) => e.data.flux_source_id === "SKU-4")?.data.title).toBe(
			'SKU-4 / Product 4, "quoted" & <tagged> ț',
		);

		// workerd does not advance Date.now() during pure CPU work, so JSONata's timeout never
		// fires there; only the step counter can end this expression.
		const runaway = jsonTemplate("cf_select");
		const template = {
			...runaway,
			fields: {
				...runaway.fields,
				title: { expr: "($f := function($n) { $f($n + 1) }; $f(0))", type: "text" },
			},
		};
		const one = await client.upload(productsJson(1), "one.json");
		const stuck = await client.plugin("jobs/create", {
			uploadId: one.uploadId,
			template,
			dryRun: false,
		});
		expect(await client.runToEnd(stuck.id)).toMatchObject({
			status: "completed",
			counters: { failed: 1 },
		});
		const [row] = await client.records(stuck.id, "failed");
		expect(row?.errors).toEqual([
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		]);
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("cf_scale"),
			dryRun: false,
			batchSize: 500,
			budgetMs: 20_000,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10_000 } });
		expect((await client.plugin("jobs/next", { id: job.id })).counters.created).toBe(10_000);
		const entries = await client.listAll("cf_scale");
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
	});

	it("reads edit locks from D1: the importer's own lock passes, another user's lock skips", async () => {
		await client.createProducts("cf_locks");
		await importCsv("cf_locks", productsCsv(2));
		const entry = (await byKey("cf_locks")).get("SKU-0")!;
		if (!/^[0-9A-Z]+$/.test(entry.id)) throw new Error(`Unexpected entry ID ${entry.id}`);
		await client.api("POST", `/_emdash/api/content/cf_locks/${entry.id}/lock`, {});
		const own = await importCsv(
			"cf_locks",
			productsCsv(2, () => "3"),
		);
		expect(own.counters).toMatchObject({ updated: 2, locked: 0 });

		d1(
			"INSERT INTO users (id, email, name, role, email_verified, created_at, updated_at) VALUES ('01CFSECONDUSER', 'second@example.test', 'Second editor', 40, 1, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')",
		);
		d1(
			`UPDATE _emdash_entry_locks SET user_id = '01CFSECONDUSER' WHERE collection = 'cf_locks' AND entry_id = '${entry.id}'`,
		);
		const blocked = await importCsv(
			"cf_locks",
			productsCsv(2, () => "4"),
		);
		expect(blocked.counters).toMatchObject({ updated: 1, locked: 1 });
	});
});
