import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	BLUE_PNG,
	createMediaSchema,
	GREEN_JPEG,
	HTML,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	RED_PNG,
	type StoredMedia,
	SVG,
} from "../fixtures/media.js";
import { Client, devBypass } from "./client.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4394;
/** EmDash's upload limit on this server, so a too-large file stays small. */
const MAX_UPLOAD = 100_000;

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: media is fetched from 127.0.0.1 (allowPrivateNetwork), with a lower limit.
	server = await startServer(PORT, undefined, undefined, true, MAX_UPLOAD);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

/** The bytes with a tag after them, so each test's files are distinct to EmDash's dedupe. */
const tagged = (bytes: Uint8Array, tag: string) =>
	new Uint8Array([...bytes, ...new TextEncoder().encode(tag)]);

async function importCsv(
	collection: string,
	csv: string,
	opts: { dryRun?: boolean; refresh?: boolean; budgetMs?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: mediaTemplate(collection, { refresh: opts.refresh ?? false }),
		dryRun: opts.dryRun ?? false,
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function stored(collection: string): Promise<Map<string, Record<string, unknown>>> {
	return new Map(
		(await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e.data]),
	);
}

const media = (data: Record<string, unknown> | undefined, field: string) =>
	data?.[field] as StoredMedia | null | undefined;

describe("media from URL on Node", () => {
	it("imports an image with alt and a file, serves them with their types, and re-runs unchanged", async () => {
		await createMediaSchema(client, "it_media");
		feeds.feeds.set("/t1/chair.png", { body: tagged(RED_PNG, "t1"), contentType: "image/png" });
		feeds.feeds.set("/t1/lamp", { body: tagged(GREEN_JPEG, "t1"), contentType: null });
		feeds.feeds.set("/t1/manual.pdf", { body: MANUAL_PDF, contentType: "application/pdf" });
		const csv = mediaCsv([
			["P1", "Chair", feeds.url("/t1/chair.png"), "A red chair", feeds.url("/t1/manual.pdf"), ""],
			["P2", "Lamp", feeds.url("/t1/lamp"), "", "", ""],
		]);
		const { job, rows } = await importCsv("it_media", csv);
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(rows.map((r) => r.newMedia)).toEqual([
			[`photo: ${feeds.url("/t1/chair.png")}`, `manual: ${feeds.url("/t1/manual.pdf")}`],
			[`photo: ${feeds.url("/t1/lamp")}`],
		]);
		const entries = await stored("it_media");
		const chair = media(entries.get("P1"), "photo");
		expect(chair).toMatchObject({
			provider: "local",
			filename: "chair.png",
			mimeType: "image/png",
			width: 4,
			height: 3,
			alt: "A red chair",
		});
		expect(chair?.blurhash).toEqual(expect.any(String));
		expect(media(entries.get("P1"), "manual")).toMatchObject({
			filename: "manual.pdf",
			mimeType: "application/pdf",
		});
		expect(media(entries.get("P2"), "photo")).toMatchObject({
			filename: "lamp.jpg",
			mimeType: "image/jpeg",
		});
		expect(media(entries.get("P2"), "photo")).not.toHaveProperty("alt");
		const item = await client.api<{ item: { alt: string | null } }>(
			"GET",
			`/_emdash/api/media/${chair?.id}`,
		);
		expect(item.item.alt).toBe("A red chair");
		for (const [field, key, type] of [
			["photo", "P1", "image/png"],
			["manual", "P1", "application/pdf"],
		] as const) {
			const value = media(entries.get(key), field);
			const res = await client.raw("GET", `/_emdash/api/media/file/${value?.meta.storageKey}`);
			expect(res.status, field).toBe(200);
			expect(res.headers.get("content-type"), field).toBe(type);
			expect(res.headers.get("x-content-type-options"), field).toBe("nosniff");
			await res.arrayBuffer();
		}

		const before = feeds.requests.length;
		const again = await importCsv("it_media", csv);
		expect(again.job.counters).toMatchObject({ unchanged: 2 });
		expect(feeds.requests).toHaveLength(before);
	});

	it("shares one media item for identical bytes at two URLs", async () => {
		await createMediaSchema(client, "it_media_dedupe");
		const bytes = tagged(BLUE_PNG, "t2");
		feeds.feeds.set("/t2/a.png", { body: bytes, contentType: "image/png" });
		feeds.feeds.set("/t2/b.png", { body: bytes, contentType: "image/png" });
		const csv = mediaCsv([
			["D1", "A", feeds.url("/t2/a.png"), "", "", ""],
			["D2", "B", feeds.url("/t2/b.png"), "", "", ""],
		]);
		const { job, rows } = await importCsv("it_media_dedupe", csv);
		expect(job.counters).toMatchObject({ created: 2 });
		expect(rows.map((r) => r.newMedia)).toEqual([
			[`photo: ${feeds.url("/t2/a.png")}`],
			[`photo: ${feeds.url("/t2/b.png")}`],
		]);
		const entries = await stored("it_media_dedupe");
		expect(media(entries.get("D1"), "photo")?.id).toBe(media(entries.get("D2"), "photo")?.id);
	});

	it("plans a dry run without a request, listing what a real run would download", async () => {
		await createMediaSchema(client, "it_media_dry");
		feeds.feeds.set("/t3/a.png", { body: tagged(RED_PNG, "t3"), contentType: "image/png" });
		const csv = mediaCsv([["Y1", "A", feeds.url("/t3/a.png"), "Alt", "", ""]]);
		const { job, rows } = await importCsv("it_media_dry", csv, { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).toMatchObject({
			status: "planned",
			newMedia: [`photo: ${feeds.url("/t3/a.png")}`],
		});
		expect(rows[0]?.changes).toContainEqual({
			field: "photo",
			before: null,
			after: `new media from ${feeds.url("/t3/a.png")}`,
		});
		expect(feeds.log("/t3/a.png")).toEqual([]);
		expect(await client.listAll("it_media_dry")).toEqual([]);
	});

	it("fails a record for a 404, a too-large file, HTML as an image, SVG and a refused type", async () => {
		await createMediaSchema(client, "it_media_bad");
		feeds.feeds.set("/t4/big.png", { body: largePng(MAX_UPLOAD + 1), contentType: "image/png" });
		feeds.feeds.set("/t4/page.png", { body: HTML, contentType: "image/png" });
		feeds.feeds.set("/t4/logo.svg", { body: SVG, contentType: "image/svg+xml" });
		feeds.feeds.set("/t4/scan.pdf", {
			body: tagged(MANUAL_PDF, "t4"),
			contentType: "application/pdf",
		});
		const csv = mediaCsv([
			["B1", "Missing", feeds.url("/t4/missing.png"), "", "", ""],
			["B2", "Big", feeds.url("/t4/big.png"), "", "", ""],
			["B3", "Page", feeds.url("/t4/page.png"), "", "", ""],
			["B4", "Logo", feeds.url("/t4/logo.svg"), "", "", ""],
			["B5", "Scan", "", "", "", feeds.url("/t4/scan.pdf")],
		]);
		const { job, rows } = await importCsv("it_media_bad", csv);
		expect(job.counters).toMatchObject({ failed: 5 });
		expect(rows.map((r) => r.errors?.map((e) => `${e.field}:${e.code}`))).toEqual([
			["photo:media_http_error"],
			["photo:media_too_large"],
			["photo:media_type_not_allowed"],
			["photo:media_type_not_allowed"],
			["scan:media_type_not_allowed"],
		]);
		expect(rows[1]?.errors?.[0]?.message).toBe(
			`The file is larger than the limit of ${MAX_UPLOAD} bytes`,
		);
		expect(rows[4]?.errors?.[0]?.message).toBe(
			`${feeds.url("/t4/scan.pdf")}: The field accepts only image/png, image/jpeg, not application/pdf`,
		);
		const library = await client.api<{ items: { filename: string }[] }>(
			"GET",
			"/_emdash/api/media?limit=100",
		);
		expect(library.items.map((i) => i.filename)).not.toContain("scan.pdf");
		expect(await client.listAll("it_media_bad")).toEqual([]);
	});

	it("refreshes a changed file, keeps a 304 unchanged, and downloads a deleted item again", async () => {
		await createMediaSchema(client, "it_media_refresh");
		feeds.feeds.set("/t5/p.png", {
			body: tagged(RED_PNG, "t5a"),
			contentType: "image/png",
			etag: true,
		});
		const csv = mediaCsv([["R1", "P", feeds.url("/t5/p.png"), "", "", ""]]);
		await importCsv("it_media_refresh", csv, { refresh: true });
		const first = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;

		const unchanged = await importCsv("it_media_refresh", csv, { refresh: true });
		expect(unchanged.job.counters).toMatchObject({ unchanged: 1 });
		expect(feeds.log("/t5/p.png").map((r) => r.status)).toEqual([200, 304]);

		feeds.feeds.set("/t5/p.png", {
			body: tagged(BLUE_PNG, "t5b"),
			contentType: "image/png",
			etag: true,
		});
		const changed = await importCsv("it_media_refresh", csv, { refresh: true });
		expect(changed.job.counters).toMatchObject({ updated: 1 });
		const second = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;
		expect(second).not.toBe(first);
		expect(changed.rows[0]?.changes).toEqual([{ field: "photo", before: first, after: second }]);

		await client.api("DELETE", `/_emdash/api/media/${second}`);
		const redownloaded = await importCsv("it_media_refresh", csv);
		expect(redownloaded.job.counters).toMatchObject({ updated: 1 });
		expect(feeds.log("/t5/p.png").map((r) => r.status)).toEqual([200, 304, 200, 200]);
		const third = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;
		expect(third).not.toBe(second);
	});

	it("leaves a record whose next download is too late for the next batch, without downloading twice", async () => {
		await createMediaSchema(client, "it_media_slow");
		// The batch's media deadline is budgetMs + 20 s = 20.5 s after it starts. The slow
		// download ends about 18 s in, so the next one would start with under 5 s left and is
		// deferred; 2.5 s of slack on both sides absorbs the wall clock stepping back on WSL
		// (Fact F1) and a slow first batch.
		feeds.feeds.set("/t6/slow.png", {
			body: tagged(RED_PNG, "t6"),
			contentType: "image/png",
			delayMs: 18_000,
		});
		feeds.feeds.set("/t6/manual.pdf", {
			body: tagged(MANUAL_PDF, "t6"),
			contentType: "application/pdf",
		});
		const csv = mediaCsv([
			["S1", "Slow", feeds.url("/t6/slow.png"), "", feeds.url("/t6/manual.pdf"), ""],
		]);
		const { uploadId } = await client.upload(csv);
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: mediaTemplate("it_media_slow"),
			dryRun: false,
			budgetMs: 500,
		});
		const first = await client.plugin("jobs/next", { id: created.id });
		expect(first).toMatchObject({ status: "running", cursor: { seq: 0 } });
		expect(await client.records(created.id)).toEqual([]);
		const job = await client.runToEnd(created.id);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(feeds.log("/t6/slow.png")).toHaveLength(1);
		expect(feeds.log("/t6/manual.pdf")).toHaveLength(1);
	});
});
