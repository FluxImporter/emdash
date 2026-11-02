import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const url = (name: string) => `https://cdn.test/${name}`;

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "photo", type: "image" },
	{ slug: "body", type: "portableText" },
	{ slug: "flux_source_id", type: "string" },
];
const template = (body: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({
	version: 1,
	source: { format: "json", records: "posts" },
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: {
		title: { from: "title", type: "text" },
		body: { from: "html", type: "portableText", format: "html", ...body },
		...fields,
	},
});
type Post = { id: string; title: string; html?: string; photo?: string };
const json = (posts: Post[]) => JSON.stringify({ posts });

function serve(deps: Deps, ...names: string[]) {
	for (const [i, name] of names.entries()) {
		deps.mediaFetcher.files.set(url(name), { body: png(i), contentType: "image/png" });
	}
}

async function start(
	deps: Deps,
	posts: Post[],
	opts: { dryRun?: boolean; tpl?: Record<string, unknown> } = {},
): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, json(posts));
	return createJob(deps, {
		uploadId: upload,
		template: opts.tpl ?? template(),
		schemaFields,
		mediaMaxBytes: 1000,
		...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
	});
}

async function runToEnd(deps: Deps, id: string, budget?: number): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver", Number.POSITIVE_INFINITY, budget);
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

const body = (deps: Deps, n = 0) => [...deps.content.entries.values()][n]?.data.body;

const POST: Post = {
	id: "p1",
	title: "Hello",
	html: `<p>Hi <a href="javascript:x">there</a></p><img src="${url("a.png")}" alt="A"><table><tr><td>t</td></tr></table>`,
};

describe("importing Portable Text", () => {
	it("imports HTML with library images and warnings, and re-runs unchanged without a download", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const job = await runToEnd(deps, (await start(deps, [POST])).id);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(job.mediaMaxBytes).toBe(1000);
		expect(body(deps)).toEqual([
			{
				_type: "block",
				_key: "b0",
				style: "normal",
				children: [{ _type: "span", _key: "b0s0", text: "Hi there", marks: [] }],
			},
			{
				_type: "image",
				_key: "b1",
				asset: { _ref: "m1", url: "/_emdash/api/media/file/K1.png" },
				alt: "A",
				width: 4,
				height: 3,
			},
			{
				_type: "block",
				_key: "b2",
				style: "normal",
				children: [{ _type: "span", _key: "b2s0", text: "t", marks: [] }],
			},
		]);
		const warnings = [
			{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
			{
				field: "body",
				code: "link_dropped",
				message:
					"Kept the text of 1 link without the address: the scheme javascript: is not allowed",
			},
		];
		const [first] = await rows(deps, job.id);
		expect(first).toMatchObject({
			status: "created",
			newMedia: [`body: ${url("a.png")}`],
			warnings,
			changes: [
				{ field: "title", before: null, after: "Hello" },
				{ field: "body", before: null, after: "3 blocks, 1 image" },
			],
		});
		const again = await runToEnd(deps, (await start(deps, [POST])).id);
		expect(again.counters).toMatchObject({ unchanged: 1 });
		const [second] = await rows(deps, again.id);
		// Warnings are saved on unchanged rows too.
		expect(second).toMatchObject({ status: "unchanged", warnings });
		expect(second).not.toHaveProperty("newMedia");
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		expect(deps.content.calls.filter((c) => c.startsWith("update"))).toEqual([]);
	});

	it("plans a dry run without downloading, listing new images and the warnings", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const job = await runToEnd(deps, (await start(deps, [POST], { dryRun: true })).id);
		expect(job.counters).toMatchObject({ created: 1 });
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "planned",
			action: "create",
			newMedia: [`body: ${url("a.png")}`],
			changes: [
				{ field: "title", before: null, after: "Hello" },
				{ field: "body", before: null, after: "3 blocks, 1 image (1 new)" },
			],
		});
		expect(row?.warnings).toHaveLength(2);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.media.calls).toEqual([]);
	});

	it("downloads a URL shared by an image field and Portable Text once", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const tpl = template({}, { photo: { from: "photo", type: "image" } });
		const post = { id: "p1", title: "T", photo: url("a.png"), html: `<img src="${url("a.png")}">` };
		const job = await runToEnd(deps, (await start(deps, [post], { tpl })).id);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		const [row] = await rows(deps, job.id);
		expect(row?.newMedia).toEqual([`photo: ${url("a.png")}`]);
		expect((body(deps) as { asset: { _ref: string } }[])[0]?.asset._ref).toBe("m1");
	});

	it("drops an image that fails, keeps the record, and plans unchanged while it still fails", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const post = {
			id: "p1",
			title: "T",
			html: `<p>t</p><img src="${url("gone.png")}"><img src="${url("a.png")}">`,
		};
		const job = await runToEnd(deps, (await start(deps, [post])).id);
		expect(job.counters).toMatchObject({ created: 1 });
		const [row] = await rows(deps, job.id);
		expect(row?.warnings).toEqual([
			{
				field: "body",
				code: "image_dropped",
				message: `media_http_error: ${url("gone.png")}: The server answered HTTP 404`,
			},
		]);
		expect(row?.newMedia).toEqual([`body: ${url("a.png")}`]);
		expect((body(deps) as unknown[]).length).toBe(2);
		const again = await runToEnd(deps, (await start(deps, [post])).id);
		expect(again.counters).toMatchObject({ unchanged: 1 });
		// The dropped URL is tried again; the stored one is a map hit.
		expect(deps.mediaFetcher.urls()).toEqual([url("gone.png"), url("a.png"), url("gone.png")]);
	});

	it("fails the record for a failing image with imageErrors: fail, and replaces its warnings on retry", async () => {
		const { deps } = makeDeps();
		const tpl = template({ imageErrors: "fail" });
		const post = { id: "p1", title: "T", html: `<dl><dt>d</dt></dl><img src="${url("a.png")}">` };
		const created = await start(deps, [post], { tpl });
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ failed: 1 });
		const [failed] = await rows(deps, job.id);
		expect(failed).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "body",
					code: "media_http_error",
					message: `${url("a.png")}: The server answered HTTP 404`,
				},
			],
			warnings: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
			],
		});
		expect(deps.content.entries.size).toBe(0);
		serve(deps, "a.png");
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const [row] = await rows(deps, job.id);
		expect(row?.warnings).toEqual(failed?.warnings);
		expect(row).not.toHaveProperty("errors");
	});

	it("defers a record with more new images than one Workers batch allows, downloading each URL once", async () => {
		const { deps } = makeDeps();
		const names = Array.from({ length: 12 }, (_, i) => `${i}.png`);
		serve(deps, ...names);
		const html = names.map((n) => `<img src="${url(n)}">`).join("");
		const created = await start(deps, [{ id: "p1", title: "T", html }]);
		let job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		// 25 for the record and 12 lookups, then 9 downloads of 60 before the next would pass 600.
		expect(job.cursor.seq).toBe(0);
		expect(deps.mediaFetcher.urls()).toHaveLength(9);
		expect(job.deferred).toEqual({
			seq: 0,
			newTerms: [],
			newMedia: names.slice(0, 9).map((n) => `body: ${url(n)}`),
		});
		job = await runToEnd(deps, created.id, 600);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(deps.mediaFetcher.urls()).toEqual(names.map(url));
		const [row] = await rows(deps, job.id);
		expect(row?.newMedia).toEqual(names.map((n) => `body: ${url(n)}`));
		expect((body(deps) as unknown[]).length).toBe(12);
	});

	it("carries dropped failures across deferred batches, fetching each failing URL once", async () => {
		const { deps } = makeDeps();
		const names = Array.from({ length: 10 }, (_, i) => `gone${i}.png`);
		const html = `<p>t</p>${names.map((n) => `<img src="${url(n)}">`).join("")}`;
		const created = await start(deps, [{ id: "p1", title: "T", html }]);
		let job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		// 25 for the record and 10 lookups, then 9 failed downloads of 60 before the next would pass 600.
		expect(job.cursor.seq).toBe(0);
		expect(job.deferred?.failed).toHaveLength(9);
		let batches = 1;
		while (job.status === "running" && batches < 10) {
			job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
			batches++;
		}
		expect(job.status).toBe("completed");
		expect(batches).toBe(2);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(job).not.toHaveProperty("deferred");
		expect(deps.mediaFetcher.urls()).toEqual(names.map(url));
		const [row] = await rows(deps, job.id);
		expect(row?.warnings).toEqual(
			names.map((n) => ({
				field: "body",
				code: "image_dropped",
				message: `media_http_error: ${url(n)}: The server answered HTTP 404`,
			})),
		);
		expect(row).not.toHaveProperty("newMedia");
		expect((body(deps) as unknown[]).length).toBe(1);
	});

	it("updates only a changed Portable Text field, sending data, and clears an emptied one", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		await runToEnd(deps, (await start(deps, [POST])).id);
		const edited = { ...POST, html: `${POST.html}<p>More</p>` };
		const job = await runToEnd(deps, (await start(deps, [edited])).id);
		expect(job.counters).toMatchObject({ updated: 1 });
		const [row] = await rows(deps, job.id);
		expect(row?.changes).toEqual([
			{ field: "body", before: "3 blocks, 1 image", after: "4 blocks, 1 image" },
		]);
		expect((body(deps) as unknown[]).length).toBe(4);
		const emptied = await runToEnd(
			deps,
			(await start(deps, [{ ...POST, html: "<script>x</script>" }])).id,
		);
		expect(emptied.counters).toMatchObject({ updated: 1 });
		expect(body(deps)).toBeNull();
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("skips images with images: skip, without media or the linked Workers cap", async () => {
		const { deps } = makeDeps();
		const tpl = template({ images: "skip" });
		const job = await runToEnd(deps, (await start(deps, [POST], { tpl })).id);
		expect(job).not.toHaveProperty("mediaMaxBytes");
		expect(workersBatchCap(job)).toBe(WORKERS_BATCH_CAP);
		expect(workersBatchCap({ ...job, template: template() as Job["template"] })).toBe(
			WORKERS_LINKED_BATCH_CAP,
		);
		expect((body(deps) as unknown[]).length).toBe(2);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.mediaMap.rows.size).toBe(0);
	});
});
