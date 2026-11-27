import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { BLUE_PNG, GREEN_JPEG, RED_PNG } from "../fixtures/media.js";
import {
	articleHtml,
	createPortableTextSchema,
	type Post,
	portableTextTemplate,
	postsJson,
} from "../fixtures/portable-text.js";
import { Client, devBypass } from "./client.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4393;

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: images are fetched from 127.0.0.1 (allowPrivateNetwork).
	server = await startServer(PORT, undefined, undefined, true);
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

async function importPosts(
	posts: Post[],
	template: Record<string, unknown>,
	opts: { dryRun?: boolean } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(postsJson(posts), "posts.json");
	const created = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function stored(collection: string): Promise<Map<string, Record<string, unknown>>> {
	return new Map(
		(await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e.data]),
	);
}

/** The warnings `articleHtml` reports on `field`. */
const ARTICLE_WARNINGS = (field: string) => [
	{ field, code: "unknown_markup", message: "Kept the text of 1 <table> element" },
	{ field, code: "removed_markup", message: "Removed 1 <script> element" },
	{
		field,
		code: "link_dropped",
		message: "Kept the text of 1 link without the address: the scheme javascript: is not allowed",
	},
];

type Block = { _type: string; style?: string; asset?: { _ref: string; url: string } };
const imagesOf = (value: unknown) => (value as Block[]).filter((b) => b._type === "image");

describe("Portable Text on Node", () => {
	it("imports HTML with an image into a page that renders it, and re-runs unchanged without a request", async () => {
		feeds.feeds.set("/t1/red.png", { body: tagged(RED_PNG, "t1"), contentType: "image/png" });
		const post = {
			id: "it-m4d-1",
			slug: "it-m4d-1",
			title: "Imported page",
			html: articleHtml(feeds.url("/t1/red.png")),
		};
		const template = portableTextTemplate("pages", { field: "content", slug: true });
		const first = await importPosts([post], template);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(first.rows[0]).toMatchObject({
			status: "created",
			newMedia: [`content: ${feeds.url("/t1/red.png")}`],
			warnings: ARTICLE_WARNINGS("content"),
		});
		const log = await client.raw(
			"GET",
			`/_emdash/api/plugins/fluximporter/jobs/log.csv?id=${first.job.id}`,
		);
		expect(log.status).toBe(200);
		const lines = (await log.text()).trimEnd().split("\r\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain(
			ARTICLE_WARNINGS("content")
				.map((w) => `${w.field}: ${w.code}: ${w.message}`)
				.join("; "),
		);
		const content = (await stored("pages")).get("it-m4d-1")?.content;
		const storedJson = JSON.stringify(content);
		expect(storedJson).toContain("not that.");
		for (const unsafe of ["alert", "javascript:", "onclick", "steal", "color:red"]) {
			expect(storedJson).not.toContain(unsafe);
		}
		const [image] = imagesOf(content);
		const item = await client.api<{
			item: { id: string; mimeType: string; storageKey: string; alt: string };
		}>("GET", `/_emdash/api/media/${image?.asset?._ref}`);
		expect(item.item).toMatchObject({ mimeType: "image/png", alt: "A red square" });
		expect(image?.asset?.url).toBe(`/_emdash/api/media/file/${item.item.storageKey}`);

		const page = await client.raw("GET", "/pages/it-m4d-1");
		const html = await page.text();
		expect(page.status).toBe(200);
		// The image component serves the file through Astro's image endpoint.
		expect(html).toContain(encodeURIComponent(image?.asset?.url ?? "?"));
		expect(html).toContain("<figcaption");
		expect(html).toContain("A caption");
		expect(html).toContain('href="https://example.com/big"');
		expect(html).toContain('href="https://example.com/more" target="_blank"');
		expect(html).toContain("<strong>this</strong>");
		expect(html).toContain("<em>here</em>");
		// Astro escapes quotes, so look for the bare words.
		for (const unsafe of ["alert", "javascript:", "onclick", "steal"]) {
			expect(html).not.toContain(unsafe);
		}
		const file = await client.raw("GET", image?.asset?.url ?? "?");
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/png");

		const requests = feeds.requests.length;
		const again = await importPosts([post], template);
		expect(again.job.counters).toMatchObject({ unchanged: 1, failed: 0 });
		expect(again.rows[0]?.warnings).toEqual(ARTICLE_WARNINGS("content"));
		expect(feeds.requests.length).toBe(requests);
	});

	it("imports Markdown with an image", async () => {
		await createPortableTextSchema(client, "it_pt_md");
		feeds.feeds.set("/t2/blue.png", { body: tagged(BLUE_PNG, "t2"), contentType: "image/png" });
		const md = `## Notes\n\n- one\n  - two\n\n![Blue](${feeds.url("/t2/blue.png")})\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
		const { job, rows } = await importPosts(
			[{ id: "M1", title: "Markdown", md }],
			portableTextTemplate("it_pt_md", { format: "markdown" }),
		);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(rows[0]).not.toHaveProperty("warnings");
		const body = (await stored("it_pt_md")).get("M1")?.body as Record<string, unknown>[];
		expect(
			body.map((b) =>
				b._type === "block" ? `${b.style}${b.listItem ? ` ${b.level}` : ""}` : b._type,
			),
		).toEqual(["h2", "normal 1", "normal 2", "image", "code"]);
		expect(body[3]).toMatchObject({ alt: "Blue", width: 4, height: 3 });
		expect(body[4]).toMatchObject({ code: "const a = 1;\n", language: "ts" });
	});

	it("plans a dry run without a request, listing the images a real run would download", async () => {
		await createPortableTextSchema(client, "it_pt_dry");
		feeds.feeds.set("/t3/red.png", { body: tagged(RED_PNG, "t3"), contentType: "image/png" });
		const requests = feeds.requests.length;
		const { job, rows } = await importPosts(
			[{ id: "D1", title: "Dry", html: articleHtml(feeds.url("/t3/red.png")) }],
			portableTextTemplate("it_pt_dry"),
			{ dryRun: true },
		);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(rows[0]).toMatchObject({
			status: "planned",
			newMedia: [`body: ${feeds.url("/t3/red.png")}`],
			changes: [
				{ field: "title", before: null, after: "Dry" },
				{ field: "body", before: null, after: "4 blocks, 1 image (1 new)" },
			],
		});
		expect(rows[0]?.warnings).toEqual(ARTICLE_WARNINGS("body"));
		expect(feeds.requests.length).toBe(requests);
		expect(await client.listAll("it_pt_dry")).toEqual([]);
	});

	it("drops a 404 image with a warning, and fails the record with imageErrors: fail", async () => {
		await createPortableTextSchema(client, "it_pt_404");
		const missing = feeds.url("/t4/missing.png");
		const html = `<p>Text</p><img src="${missing}">`;
		const dropped = await importPosts(
			[{ id: "N1", title: "Dropped", html }],
			portableTextTemplate("it_pt_404"),
		);
		const droppedWarning = {
			field: "body",
			code: "image_dropped",
			message: `media_http_error: ${missing}: The server answered HTTP 404`,
		};
		expect(dropped.job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(dropped.rows[0]?.warnings).toEqual([droppedWarning]);
		expect(imagesOf((await stored("it_pt_404")).get("N1")?.body)).toEqual([]);
		// A re-run tries the URL again and, with the image dropped once more, plans unchanged.
		const requests = feeds.requests.length;
		const rerun = await importPosts(
			[{ id: "N1", title: "Dropped", html }],
			portableTextTemplate("it_pt_404"),
		);
		expect(rerun.job.counters).toMatchObject({ unchanged: 1, updated: 0, failed: 0 });
		expect(rerun.rows[0]?.status).toBe("unchanged");
		expect(rerun.rows[0]?.warnings).toEqual([droppedWarning]);
		expect(feeds.requests.length).toBe(requests + 1);
		const failed = await importPosts(
			[{ id: "N2", title: "Failed", html }],
			portableTextTemplate("it_pt_404", { body: { imageErrors: "fail" } }),
		);
		expect(failed.job.counters).toMatchObject({ failed: 1 });
		expect(failed.rows[0]?.errors).toEqual([
			{
				field: "body",
				code: "media_http_error",
				message: `${missing}: The server answered HTTP 404`,
			},
		]);
		expect((await stored("it_pt_404")).has("N2")).toBe(false);
	});

	it("downloads an image shared with an image field once", async () => {
		await createPortableTextSchema(client, "it_pt_shared");
		feeds.feeds.set("/t5/green.jpg", { body: tagged(GREEN_JPEG, "t5"), contentType: "image/jpeg" });
		const image = feeds.url("/t5/green.jpg");
		const { job, rows } = await importPosts(
			[{ id: "S1", title: "Shared", photo: image, html: `<p>t</p><img src="${image}">` }],
			portableTextTemplate("it_pt_shared", { photo: true }),
		);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(rows[0]?.newMedia).toEqual([`photo: ${image}`]);
		expect(feeds.requests.filter((r) => r.path === "/t5/green.jpg")).toHaveLength(1);
		const data = (await stored("it_pt_shared")).get("S1");
		expect(imagesOf(data?.body)[0]?.asset?._ref).toBe(
			(data?.photo as { id: string } | undefined)?.id,
		);
	});
});
