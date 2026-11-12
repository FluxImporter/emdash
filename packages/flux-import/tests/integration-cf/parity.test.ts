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
	BLUE_PNG,
	createMediaSchema,
	GREEN_JPEG,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	RED_PNG,
	type StoredMedia,
} from "../fixtures/media.js";
import {
	articleHtml,
	createPortableTextSchema,
	type Post,
	portableTextTemplate,
	postsJson,
} from "../fixtures/portable-text.js";
import {
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	translationCsv,
	translationNames,
	translationsOf,
	translationTemplate,
} from "../fixtures/translations.js";
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

/** The products template with M5b `rules` or `publishAt`. */
async function importRules(collection: string, csv: string, extra: object) {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: { ...template(collection), ...extra },
		dryRun: false,
		budgetMs: 20_000,
	});
	return client.runToEnd(job.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

	it("imports M4d Portable Text from HTML and Markdown into R2, defers a record by budget, and re-runs unchanged", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			await createPortableTextSchema(client, "cf_pt");
			const names = Array.from({ length: 12 }, (_, i) => `/pt/${i}.png`);
			for (const [i, name] of names.entries()) {
				const body = new Uint8Array([...RED_PNG, ...new TextEncoder().encode(`cf-pt-${i}`)]);
				feeds.feeds.set(name, { body, contentType: "image/png" });
			}
			feeds.feeds.set("/pt/blue.png", { body: BLUE_PNG, contentType: "image/png" });
			const run = async (posts: Post[], template: Record<string, unknown>) => {
				const { uploadId } = await client.upload(postsJson(posts), "posts.json");
				const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
				// Each batch's job, to see the deferrals between them.
				const batches: Job[] = [];
				let done = job;
				while (done.status === "running" || done.status === "created") {
					if (batches.length >= 100) throw new Error("did not finish in 100 batches");
					done = await client.plugin<Job>("jobs/next", { id: job.id });
					batches.push(done);
				}
				return { done, batches, rows: await client.records(done.id) };
			};
			const html: Post[] = [
				{ id: "H1", title: "Article", html: articleHtml(feeds.url(names[0] as string)) },
				// More new images than one Workers batch downloads (WORKERS_LOOKUP_BUDGET).
				{
					id: "H2",
					title: "Gallery",
					html: names.map((n) => `<img src="${feeds.url(n)}">`).join(""),
				},
			];
			const first = await run(html, portableTextTemplate("cf_pt"));
			expect(first.done.counters).toMatchObject({ created: 2, failed: 0 });
			// H2 (seq 1) was deferred by the budget: a batch ended inside it, with its downloads kept.
			expect(first.batches.length).toBeGreaterThan(1);
			const deferred = first.batches.find((b) => b.deferred !== undefined)?.deferred;
			expect(deferred?.seq).toBe(1);
			expect(deferred?.newMedia.length).toBeGreaterThan(0);
			expect(first.rows[0]?.warnings).toHaveLength(3);
			expect(first.rows[1]?.newMedia).toEqual(names.slice(1).map((n) => `body: ${feeds.url(n)}`));
			// Each URL was downloaded once, across the batches that deferred H2.
			for (const name of names) {
				expect(feeds.requests.filter((r) => r.path === name)).toHaveLength(1);
			}
			const entries = await byKey("cf_pt");
			const gallery = entries.get("H2")?.data.body as { asset: { url: string } }[];
			expect(gallery).toHaveLength(12);
			const file = await client.raw("GET", gallery[0]?.asset.url ?? "?");
			expect(file.status).toBe(200);
			expect(file.headers.get("content-type")).toBe("image/png");

			const md = `# Title\n\n![Blue](${feeds.url("/pt/blue.png")})\n\n- *one*\n`;
			const markdown = await run(
				[{ id: "M1", title: "Markdown", md }],
				portableTextTemplate("cf_pt", { format: "markdown" }),
			);
			expect(markdown.done.counters).toMatchObject({ created: 1 });
			const body = (await byKey("cf_pt")).get("M1")?.data.body as { _type: string }[];
			expect(body.map((b) => b._type)).toEqual(["block", "image", "block"]);

			const requests = feeds.requests.length;
			const again = await run(html, portableTextTemplate("cf_pt"));
			expect(again.done.counters).toMatchObject({ unchanged: 2 });
			expect(feeds.requests.length).toBe(requests);
		} finally {
			await feeds.stop();
		}
	});

	it("fails worst-case M4d Markdown records cleanly and completes the job", async () => {
		await createPortableTextSchema(client, "cf_pt_worst");
		const fill = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
		const limit = 128 * 1024;
		const table = `|${"a|".repeat(100)}\n|${"-|".repeat(100)}\n${"a\n".repeat(660)}\n`;
		const prose =
			"Lorem ipsum dolor sit amet, *consectetur* adipiscing elit, sed do **eiusmod** tempor incididunt ut labore et [dolore](https://x.test/d) magna aliqua. Ut enim ad `minim` veniam.\n\n";
		const posts: Post[] = [
			// 24,576 paragraphs: 98,304 markdown-it tokens, under that limit, and 2.6 MB of JSON.
			{ id: "W1", title: "Paragraphs", md: fill("a\n\n", 72 * 1024) },
			// Tables of 66,000 cells each, 200,000 tokens per 1.7 KB, repeated to the limit.
			{ id: "W2", title: "Tables", md: fill(table, limit) },
			{ id: "W3", title: "Prose", md: fill(prose, limit) },
			{ id: "W4", title: "Small", md: "# After\n\nText" },
		];
		const { uploadId } = await client.upload(postsJson(posts), "worst.json");
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: portableTextTemplate("cf_pt_worst", { format: "markdown" }),
			dryRun: false,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 2, failed: 2 } });
		const rows = await client.records(done.id);
		const tooLarge = (message: string) => ({
			status: "failed",
			errors: [{ field: "body", code: "portable_text_too_large", message }],
		});
		expect(rows[0]).toMatchObject(tooLarge("The record's Portable Text is larger than 1 MiB"));
		expect(rows[1]).toMatchObject(tooLarge("The Markdown expands to too many elements"));
		const entries = await byKey("cf_pt_worst");
		expect(entries.has("W1")).toBe(false);
		expect(entries.has("W2")).toBe(false);
		expect((entries.get("W3")?.data.body as unknown[] | undefined)?.length).toBeGreaterThan(600);
		expect(entries.get("W4")?.data.body).toHaveLength(2);
	});

	it("writes a record with almost 1 MiB of M4d Portable Text to D1", async () => {
		await client.createCollection("cf_pt_big");
		for (const slug of ["a", "b", "c"]) {
			await client.api("POST", "/_emdash/api/schema/collections/cf_pt_big/fields", {
				slug,
				label: slug,
				type: "portableText",
			});
		}
		// Three fields of 169,002 characters, under the 512 KiB of source a record may have: each
		// quote is 2 bytes in JSON, so about 1,014,000 bytes of JSON, under the 1 MiB cap.
		const text = (tag: string) => `${tag} ${'"'.repeat(169_000)}`;
		const record = { id: "B1", a: text("a"), b: text("b"), c: text("c") };
		const field = (from: string) => ({ from, type: "portableText", format: "text" });
		const { uploadId } = await client.upload(JSON.stringify({ posts: [record] }), "big.json");
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: {
				version: 1,
				source: { format: "json", records: "posts" },
				collection: "cf_pt_big",
				locale: "en",
				key: { from: "id" },
				slug: { from: "id" },
				fields: { a: field("a"), b: field("b"), c: field("c") },
			},
			dryRun: false,
		});
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		const stored = (await byKey("cf_pt_big")).get("B1")?.data;
		const bytes = new TextEncoder().encode(
			JSON.stringify([stored?.a, stored?.b, stored?.c]),
		).byteLength;
		expect(bytes).toBeGreaterThan(1_000_000);
		expect(
			(stored?.c as { children: { text: string }[] }[] | undefined)?.[0]?.children[0]?.text,
		).toBe(record.c);
	});

	it("imports M4e translations on D1: linked groups, shared values, re-run unchanged, retry", async () => {
		const n = translationNames("cf_m4e");
		await createTranslationSchema(client, n);
		const run = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", {
				uploadId,
				template,
				dryRun: false,
				budgetMs: 20_000,
			});
			return client.runToEnd(job.id);
		};
		const en = await run(
			englishCsv([
				["E1", "Desk", "S1", 100],
				["E2", "Lamp", "S2", 20],
			]),
			englishTemplate(n),
		);
		expect(en.counters).toMatchObject({ created: 2, failed: 0 });
		const english = new Map(
			(await listLocale(client, n.products, "en")).map((e) => [e.data.flux_source_id, e]),
		);
		const csv = translationCsv([
			{ id: "F1", enId: "E1", name: "Bureau" },
			{ id: "F2", enId: "E2", name: "Lampe" },
			{ id: "F3", enId: "E3", name: "Chaise" },
		]);
		const fr = await run(csv, translationTemplate(n, "fr"));
		expect(fr.counters).toMatchObject({ created: 2, failed: 1 });
		const failed = await client.records(fr.id, "failed");
		expect(failed.map((r) => r.errors?.[0]?.code)).toEqual(["translation_source_not_found"]);
		const french = new Map((await listLocale(client, n.products, "fr")).map((e) => [e.slug, e]));
		const desk = english.get("E1") as Product;
		const bureau = french.get("bureau") as Product;
		expect(bureau.data).toMatchObject({
			title: "Bureau",
			sku: "S1",
			price: 100,
			flux_source_id: "E1",
		});
		expect(await translationsOf(client, n.products, desk.id)).toEqual({
			group: desk.id,
			locales: { en: desk.id, fr: bureau.id },
		});
		expect(await client.entryTerms(n.products, bureau.id, n.tag)).toEqual(["new"]);

		const again = await run(csv, translationTemplate(n, "fr"));
		expect(again.counters).toMatchObject({ unchanged: 2, failed: 1 });
		await run(englishCsv([["E3", "Chair", "S3", 30]]), englishTemplate(n));
		await client.plugin("jobs/retry", { id: fr.id });
		const retried = await client.runToEnd(fr.id);
		expect(retried.counters).toMatchObject({ created: 3, failed: 0 });
		const chaise = (await listLocale(client, n.products, "fr")).find((e) => e.slug === "chaise");
		expect(chaise?.data).toMatchObject({ sku: "S3", price: 30, flux_source_id: "E3" });
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

	it("rolls back an M5a create-and-update job on D1, resumed after a stop mid-batch", async () => {
		await client.createProducts("cf_m5a");
		await importCsv("cf_m5a", productsCsv(5));
		const stateOf = async () =>
			new Map(
				[...(await byKey("cf_m5a"))].map(([key, e]) => [
					key,
					{ slug: e.slug, status: e.status, data: e.data },
				]),
			);
		const before = await stateOf();
		const feed = productsCsv(10, (i) => `${i + 40}`);
		const job = await importCsv("cf_m5a", feed);
		expect(job.counters).toMatchObject({ created: 5, updated: 5, failed: 0 });
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const first = await client.plugin("jobs/next", { id: rollback.id });
		// The Workers cap: three rows per rollback batch.
		expect(first.counters.reverted).toBe(3);
		// A stop after the batch wrote its rows, before it saved its cursor: put both back.
		d1(
			`UPDATE _plugin_storage SET data = json_set(data, '$.cursor.seq', 9007199254740991, '$.counters.reverted', 0) WHERE plugin_id = 'flux-import' AND collection = 'jobs' AND id = '${rollback.id}'`,
		);
		const done = await client.runToEnd(rollback.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { reverted: 10, conflict: 0, failed: 0 },
		});
		expect(await stateOf()).toEqual(before);
		const again = await importCsv("cf_m5a", feed);
		expect(again.counters).toMatchObject({ created: 5, updated: 5, failed: 0, conflict: 0 });
	});

	it("restores M5a links on D1: terms, bylines and references", async () => {
		// Byline slugs take no underscore.
		const n = { ...linkNames("cf_m5a"), alex: "cf-m5a-alex", sam: "cf-m5a-sam" };
		await createLinkSchema(client, n);
		const importLinked = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			return client.runToEnd(job.id);
		};
		// The M4b test's bylines have the same display names, so these match by slug.
		const template = {
			...postsTemplate(n),
			bylines: { from: "Authors", match: "slug", separator: ";" },
		};
		const bySlug = (csv: string) => csv.replaceAll("Alex Doe", n.alex).replaceAll("Sam Lee", n.sam);
		await importLinked(PEOPLE_CSV, peopleTemplate(n));
		expect((await importLinked(bySlug(POSTS_CSV), template)).counters).toMatchObject({
			created: 3,
			failed: 0,
		});
		const linksOf = async () => {
			const out: Record<string, unknown> = {};
			for (const [key, post] of await byKey(n.posts)) {
				const { item } = await client.api<{ item: Product }>(
					"GET",
					`/_emdash/api/content/${n.posts}/${post.id}?locale=en`,
				);
				out[key] = {
					author: item.references?.author?.children.map((c) => c.id),
					related: item.references?.related?.children.map((c) => c.id),
					bylines: item.bylines?.filter((b) => b.source === "explicit").map((b) => b.byline.slug),
					category: await client.entryTerms(n.posts, post.id, n.category),
					tag: await client.entryTerms(n.posts, post.id, n.tag),
				};
			}
			return out;
		};
		const before = await linksOf();
		const changed = [
			"id,Title,Author,Related,Categories,Tags,Authors",
			"P1,Desk review,A2,lamp-review,Garden,sale,Sam Lee",
			"P2,Lamp review,A1,,Electronics > Tablets,,Alex Doe",
			"",
		].join("\n");
		const job = await importLinked(bySlug(changed), template);
		expect(job.counters).toMatchObject({ updated: 2, failed: 0 });
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, failed: 0, conflict: 0 });
		expect(done.warnings).toEqual([
			expect.stringMatching(/^The import created 1 terms, which are kept/),
		]);
		expect(await linksOf()).toEqual(before);
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

	it("applies M5b write modes on D1: create only, then update only", async () => {
		await client.createProducts("cf_m5b_modes");
		await importCsv("cf_m5b_modes", productsCsv(2));
		const create = await importRules(
			"cf_m5b_modes",
			productsCsv(4, () => "7"),
			{
				rules: { mode: "create" },
			},
		);
		expect(create.counters).toMatchObject({ created: 2, unchanged: 2, failed: 0 });
		const update = await importRules(
			"cf_m5b_modes",
			productsCsv(6, () => "8"),
			{
				rules: { mode: "update" },
			},
		);
		expect(update.counters).toMatchObject({ updated: 4, unchanged: 2, failed: 0 });
		const entries = await byKey("cf_m5b_modes");
		expect(entries.size).toBe(4);
		expect([...entries.values()].every((e) => e.data.price === 8)).toBe(true);
	});

	it("keeps an M5b edited field on D1 and updates the others", async () => {
		await client.createProducts("cf_m5b_protect");
		await importCsv("cf_m5b_protect", productsCsv(1));
		const id = (await byKey("cf_m5b_protect")).get("SKU-0")?.id ?? "";
		const { _rev } = await client.getEntry("cf_m5b_protect", id);
		const saved = await client.api<{ _rev: string }>(
			"PUT",
			`/_emdash/api/content/cf_m5b_protect/${id}?locale=en`,
			{ data: { title: "Editor's title" }, _rev },
		);
		await client.api("POST", `/_emdash/api/content/cf_m5b_protect/${id}/publish?locale=en`, {
			_rev: saved._rev,
		});
		const job = await importRules(
			"cf_m5b_protect",
			productsCsv(1, () => "9"),
			{ rules: { protectEdited: true } },
		);
		expect(job.counters).toMatchObject({ updated: 1, failed: 0 });
		const [row] = await client.records(job.id);
		expect(row?.changes?.map((c) => c.field)).toEqual(["price"]);
		expect(row?.warnings?.map((w) => [w.code, w.field])).toEqual([["field_edited", "title"]]);
		expect((await client.getEntry("cf_m5b_protect", id)).item.data).toMatchObject({
			title: "Editor's title",
			price: 9,
		});
	});

	it("schedules an M5b create and update on D1, publishes them by the scheduler, and rolls back", async () => {
		await client.createProducts("cf_m5b_sched");
		await importCsv("cf_m5b_sched", productsCsv(1));
		const before = (await byKey("cf_m5b_sched")).get("SKU-0");
		// Past the 60-second lead; nothing sweeps under astro dev until the test route runs.
		const at = new Date(Date.now() + 75_000).toISOString();
		const job = await importRules(
			"cf_m5b_sched",
			productsCsv(2, () => "11"),
			{
				publishAt: { expr: `'${at}'` },
			},
		);
		expect(job.counters).toMatchObject({ created: 1, updated: 1, failed: 0 });
		const stateOf = async (key: string) => {
			const entry = (await byKey("cf_m5b_sched")).get(key);
			const { item } = await client.getEntry("cf_m5b_sched", entry?.id ?? "");
			const { scheduledAt } = item as Product & { scheduledAt?: string | null };
			return { status: item.status, scheduledAt, draft: item.draftRevisionId !== null };
		};
		expect(await stateOf("SKU-0")).toEqual({ status: "published", scheduledAt: at, draft: true });
		expect(await stateOf("SKU-1")).toEqual({ status: "scheduled", scheduledAt: at, draft: false });
		await sleep(Math.max(0, Date.parse(at) - Date.now()));
		for (let i = 0; ; i++) {
			const res = await fetch(`${client.baseUrl}/test/run-scheduled`, {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
			});
			expect(res.status).toBe(200);
			const states = [await stateOf("SKU-0"), await stateOf("SKU-1")];
			if (states.every((s) => s.status === "published" && s.scheduledAt === null)) break;
			// Under WSL a long timer can fire before the wall clock reaches the time.
			if (i > 60) throw new Error(`Not published: ${JSON.stringify(states)}`);
			await sleep(1_000);
		}
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
		const after = await byKey("cf_m5b_sched");
		expect([...after.keys()]).toEqual(["SKU-0"]);
		expect(after.get("SKU-0")).toMatchObject({ status: "published", data: before?.data });
	});

	it("unpublishes M5c missing entries on D1 within the Workers caps, and republishes them", async () => {
		await client.createProducts("cf_m5c_unpub");
		const rules = { rules: { owner: "shop", missing: { action: "unpublish", maxPercent: 50 } } };
		await importRules("cf_m5c_unpub", productsCsv(60), rules);
		const { uploadId } = await client.upload(productsCsv(45));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: { ...template("cf_m5c_unpub"), ...rules },
			dryRun: false,
			budgetMs: 20_000,
		});
		const batches: Job[] = [];
		let job = await client.plugin("jobs/next", { id: created.id });
		while (job.status === "running") {
			batches.push(job);
			job = await client.plugin("jobs/next", { id: created.id });
		}
		expect(job).toMatchObject({ status: "completed", counters: { unchanged: 45, removed: 15 } });
		// The act stage decides at most WORKERS_MISSING_BATCH_CAP (10) entries a batch.
		const acts = batches.map((b) => b.missing?.rows ?? 0);
		for (let i = 1; i < acts.length; i++) {
			expect((acts[i] ?? 0) - (acts[i - 1] ?? 0)).toBeLessThanOrEqual(10);
		}
		const entries = await byKey("cf_m5c_unpub");
		expect([...entries.values()].filter((e) => e.status === "draft")).toHaveLength(15);
		const back = await importRules("cf_m5c_unpub", productsCsv(60), rules);
		expect(back.counters).toMatchObject({ failed: 0, conflict: 0 });
		expect([...(await byKey("cf_m5c_unpub")).values()].every((e) => e.status === "published")).toBe(
			true,
		);
	});

	it("trashes an M5c missing entry on D1 and restores it by rollback", async () => {
		await client.createProducts("cf_m5c_trash");
		const rules = { rules: { owner: "shop", missing: { action: "trash" } } };
		await importRules("cf_m5c_trash", productsCsv(8), rules);
		const before = (await byKey("cf_m5c_trash")).get("SKU-7");
		const job = await importRules("cf_m5c_trash", productsCsv(7), rules);
		expect(job.counters.removed).toBe(1);
		expect((await byKey("cf_m5c_trash")).has("SKU-7")).toBe(false);
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0, failed: 0 });
		expect((await byKey("cf_m5c_trash")).get("SKU-7")).toMatchObject({
			status: "published",
			slug: before?.slug,
			data: before?.data,
		});
		const again = await importRules("cf_m5c_trash", productsCsv(8), rules);
		expect(again.counters).toMatchObject({ unchanged: 8, failed: 0, conflict: 0 });
	});

	it("refuses an M5c feed that lost too many entries on D1", async () => {
		await client.createProducts("cf_m5c_limit");
		const rules = { rules: { owner: "shop", missing: { action: "trash" } } };
		await importRules("cf_m5c_limit", productsCsv(8), rules);
		const job = await importRules("cf_m5c_limit", productsCsv(5), rules);
		expect(job.missing).toMatchObject({ found: 3, removed: 0, verdict: "refused" });
		expect((await byKey("cf_m5c_limit")).size).toBe(8);
	});
});
