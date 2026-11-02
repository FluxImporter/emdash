import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { TYPES_CSV, TYPES_CSV_STORED, typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import {
	createLinkSchema,
	linkNames,
	PEOPLE_CSV,
	POSTS_CSV,
	peopleTemplate,
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import {
	createMediaSchema,
	GREEN_JPEG,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	type StoredMedia,
} from "../fixtures/media.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
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
		// fires there; only the step counter can end these expressions. The second builds a range
		// natively inside each call, so only the weight of its results stops it.
		const one = await client.upload(productsJson(1), "one.json");
		for (const expr of [
			"($f := function($n) { $f($n + 1) }; $f(0))",
			"$sum($map([1..20], function($i) { $sum([1..100000]) }))",
		]) {
			const runaway = jsonTemplate("cf_select");
			const template = {
				...runaway,
				fields: { ...runaway.fields, title: { expr, type: "text" } },
			};
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
		}
	});

	it("imports a chunked URL feed through the Workers buffering path into R2", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			// No Content-Length: R2 needs a known length, so the fetcher buffers the body first.
			feeds.feeds.set("/chunked.csv", { body: productsCsv(10), chunked: true });
			await client.createProducts("cf_url");
			const source = await client.plugin<SourceRow>("sources/create", {
				name: "Chunked feed",
				url: feeds.url("/chunked.csv"),
			});
			const create = () =>
				client.plugin<Job | { skipped: string }>("jobs/create", {
					sourceId: source.id,
					template: template("cf_url"),
					dryRun: false,
				});
			const job = await create();
			if ("skipped" in job) throw new Error("expected a job");
			expect(await client.runToEnd(job.id)).toMatchObject({
				status: "completed",
				counters: { created: 10, failed: 0 },
			});
			const stored = await client.plugin<SourceRow>("sources/get", { id: source.id });
			expect(stored.lastFetch).toMatchObject({
				status: 200,
				bytes: Buffer.byteLength(productsCsv(10)),
				uploadId: job.uploadId,
			});
			// Same body again: unchanged by its hash, and the kept R2 object is reused.
			expect(await create()).toEqual({
				skipped: "unchanged",
				sourceId: source.id,
				uploadId: job.uploadId,
			});
			expect(feeds.log("/chunked.csv").map((r) => r.status)).toEqual([200, 200]);
		} finally {
			await feeds.stop();
		}
	});

	it("converts an XLSX workbook with DecompressionStream and imports the copy staged in R2", async () => {
		await client.createProducts("cf_xlsx");
		const { uploadId } = await client.upload(await productsXlsx(10), "products.xlsx");
		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId,
			n: 2,
			source: { format: "xlsx" },
		});
		expect(sample.paths).toEqual(["sku", "Name", "Price", "Released", "Active", "Handle"]);
		expect(sample.records[1]).toEqual({
			sku: "SKU-1",
			Name: 'Product 1, "quoted" & <tagged> ț',
			Price: 1.5,
			Released: "2026-03-02",
			Active: true,
			Handle: "product-1",
			_row: 3,
		});
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: xlsxTemplate("cf_xlsx"),
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ sourceUploadId: uploadId, warnings: [] });
		expect(job.uploadId).not.toBe(uploadId);
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = await client.listAll("cf_xlsx");
		expect(entries.every((e) => e.status === "published")).toBe(true);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted" & <tagged> ț', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));
	});

	it("creates fields with schema/apply and imports every M4a type on D1, in the site timezone", async () => {
		const settings = await client.api<{ timezone?: string }>("GET", "/_emdash/api/settings");
		await client.api("POST", "/_emdash/api/settings", { timezone: "Europe/Chisinau" });
		try {
			await client.api("POST", "/_emdash/api/schema/collections", {
				slug: "cf_types",
				label: "cf_types",
				supports: ["drafts", "revisions"],
			});
			await client.api("POST", "/_emdash/api/schema/collections/cf_types/fields", {
				slug: "stock",
				label: "Stock",
				type: "integer",
				validation: null,
			});
			const template = typesTemplate("cf_types");
			const applied = await client.plugin<ApplyResult>("schema/apply", { template });
			expect(applied).toMatchObject({ applied: expect.any(Array), error: null });
			expect(applied.changes.filter((c) => c.action !== "create")).toEqual([
				{
					field: "stock",
					action: "unchanged",
					type: "number",
				},
			]);
			const { uploadId } = await client.upload(TYPES_CSV, "types.csv");
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			expect(job.siteTimezone).toBe("Europe/Chisinau");
			const done = await client.runToEnd(job.id);
			expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
			const stored = await byKey("cf_types");
			for (const [key, expected] of Object.entries(TYPES_CSV_STORED)) {
				expect(stored.get(key)?.data, key).toMatchObject(expected);
			}
			const { uploadId: again } = await client.upload(TYPES_CSV, "types.csv");
			const rerun = await client.plugin("jobs/create", {
				uploadId: again,
				template,
				dryRun: false,
			});
			expect((await client.runToEnd(rerun.id)).counters).toMatchObject({ unchanged: 3 });
		} finally {
			await client.api("POST", "/_emdash/api/settings", { timezone: settings.timezone ?? "UTC" });
		}
	});

	it("imports M4b links on D1: a created term path, a key reference and bylines", async () => {
		const n = linkNames("cf");
		await createLinkSchema(client, n);
		const importLinked = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			return client.runToEnd(job.id);
		};
		expect((await importLinked(PEOPLE_CSV, peopleTemplate(n))).counters).toMatchObject({
			created: 2,
		});
		const done = await importLinked(POSTS_CSV, postsTemplate(n));
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		const people = new Map(
			(await client.listAll(n.people)).map((e) => [e.id, e.data.flux_source_id as string]),
		);
		const posts = await byKey(n.posts);
		const expected = postsStored(n);
		for (const key of ["P1", "P2"] as const) {
			const post = posts.get(key)!;
			const { item } = await client.api<{ item: Product }>(
				"GET",
				`/_emdash/api/content/${n.posts}/${post.id}?locale=en`,
			);
			const author = item.references?.author?.children[0]?.id;
			expect(people.get(author ?? ""), key).toBe(expected[key].author);
			expect(
				item.bylines?.map((b) => b.byline.slug),
				key,
			).toEqual(expected[key].bylines);
			expect(await client.entryTerms(n.posts, post.id, n.category), key).toEqual(
				expected[key].category,
			);
			expect(await client.entryTerms(n.posts, post.id, n.tag), key).toEqual(expected[key].tag);
		}
		expect((await importLinked(POSTS_CSV, postsTemplate(n))).counters).toMatchObject({
			unchanged: 3,
		});
	});

	it("imports M4c media into R2, re-runs unchanged, and refuses a file over the Workers cap", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			await createMediaSchema(client, "cf_media");
			feeds.feeds.set("/photo.jpg", { body: GREEN_JPEG, contentType: "image/jpeg" });
			feeds.feeds.set("/manual.pdf", { body: MANUAL_PDF, contentType: "application/pdf" });
			// One byte over WORKERS_MEDIA_MAX_BYTES (5 MiB), refused by its Content-Length.
			feeds.feeds.set("/huge.png", {
				body: largePng(5 * 1024 * 1024 + 1),
				contentType: "image/png",
			});
			const csv = mediaCsv([
				["C1", "Chair", feeds.url("/photo.jpg"), "A chair", feeds.url("/manual.pdf"), ""],
				["C2", "Huge", feeds.url("/huge.png"), "", "", ""],
			]);
			const importMedia = async () => {
				const { uploadId } = await client.upload(csv);
				const job = await client.plugin("jobs/create", {
					uploadId,
					template: mediaTemplate("cf_media"),
					dryRun: false,
				});
				const done = await client.runToEnd(job.id);
				return { done, rows: await client.records(done.id) };
			};
			const first = await importMedia();
			expect(first.done.counters).toMatchObject({ created: 1, failed: 1 });
			expect(first.rows[1]?.errors).toEqual([
				{
					field: "photo",
					code: "media_too_large",
					message: `The file is larger than the limit of ${Math.floor((5 * 1024 * 1024) / 3) * 3} bytes`,
				},
			]);
			const entry = (await byKey("cf_media")).get("C1")!;
			const photo = entry.data.photo as StoredMedia;
			expect(photo).toMatchObject({
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				width: 4,
				height: 3,
				alt: "A chair",
			});
			expect(photo.blurhash).toEqual(expect.any(String));
			const manual = entry.data.manual as StoredMedia;
			const file = await client.raw("GET", `/_emdash/api/media/file/${manual.meta.storageKey}`);
			expect(file.headers.get("content-type")).toBe("application/pdf");
			expect(new Uint8Array(await file.arrayBuffer())).toEqual(MANUAL_PDF);
			const requests = feeds.requests.length;
			const again = await importMedia();
			expect(again.done.counters).toMatchObject({ unchanged: 1, failed: 1 });
			// Only the refused file is requested again.
			expect(feeds.requests.slice(requests).map((r) => r.path)).toEqual(["/huge.png"]);
		} finally {
			await feeds.stop();
		}
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
