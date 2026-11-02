import { describe, expect, it } from "vitest";
import { MEDIA_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import { mediaMapKey } from "../../src/engine/media.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const url = (name: string) => `https://cdn.test/${name}`;

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "photo", type: "image" },
	{ slug: "manual", type: "file" },
];
const template = (fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		photo: { from: "Img", type: "image", alt: { from: "Alt" } },
		manual: { from: "Pdf", type: "file" },
		...fields,
	},
	...extra,
});
const HEADER = "sku,Name,Img,Alt,Pdf\n";

function serve(deps: Deps) {
	deps.mediaFetcher.files.set(url("a.png"), { body: PNG(1), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("b.png"), { body: PNG(2), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("a.pdf"), { body: PDF, contentType: "application/pdf" });
}

async function start(
	deps: Deps,
	csv: string,
	opts: { dryRun?: boolean; tpl?: Record<string, unknown>; budgetMs?: number } = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	return createJob(deps, {
		uploadId: upload,
		template: opts.tpl ?? template(),
		schemaFields: [...schemaFields, { slug: "flux_source_id", type: "string" }],
		mediaMaxBytes: 1000,
		...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
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

const entryData = (deps: Deps) =>
	[...deps.content.entries.values()].map((e) => ({ id: e.id, ...e.data }));

const CSV = `${HEADER}A1,Chair,${url("a.png")},A red chair,${url("a.pdf")}\nA2,Lamp,${url("b.png")},,\n`;

describe("importing media", () => {
	it("downloads, uploads and writes image and file values, and re-runs unchanged", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(entryData(deps)).toEqual([
			{
				id: "e1",
				title: "Chair",
				photo: {
					id: "m1",
					provider: "local",
					filename: "a.png",
					mimeType: "image/png",
					width: 4,
					height: 3,
					blurhash: "bh1",
					dominantColor: "rgb(1,2,3)",
					alt: "A red chair",
					meta: { storageKey: "K1.png" },
				},
				manual: {
					id: "m2",
					provider: "local",
					filename: "a.pdf",
					mimeType: "application/pdf",
					meta: { storageKey: "K2.pdf" },
				},
				flux_source_id: "A1",
			},
			expect.objectContaining({
				id: "e2",
				photo: expect.objectContaining({ id: "m3" }),
				manual: null,
			}),
		]);
		const first = await rows(deps, job.id);
		expect(first.map((r) => [r.status, r.newMedia])).toEqual([
			["created", [`photo: ${url("a.png")}`, `manual: ${url("a.pdf")}`]],
			["created", [`photo: ${url("b.png")}`]],
		]);
		expect(first[0]?.changes).toEqual([
			{ field: "title", before: null, after: "Chair" },
			{ field: "photo", before: null, after: "m1" },
			{ field: "manual", before: null, after: "m2" },
		]);
		expect(deps.media.items.get("m1")?.alt).toBe("A red chair");

		const again = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(again.counters).toMatchObject({ unchanged: 2 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
		expect((await rows(deps, again.id)).every((r) => r.newMedia === undefined)).toBe(true);
	});

	it("plans a dry run without downloading, listing what a real run would download", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const dry = await runToEnd(deps, (await start(deps, CSV, { dryRun: true })).id);
		expect(deps.mediaFetcher.calls).toEqual([]);
		const planned = await rows(deps, dry.id);
		expect(planned.map((r) => [r.status, r.action, r.newMedia])).toEqual([
			["planned", "create", [`photo: ${url("a.png")}`, `manual: ${url("a.pdf")}`]],
			["planned", "create", [`photo: ${url("b.png")}`]],
		]);
		expect(planned[0]?.changes).toContainEqual({
			field: "photo",
			before: null,
			after: `new media from ${url("a.png")}`,
		});
		await runToEnd(deps, (await start(deps, CSV)).id);
		const after = await runToEnd(deps, (await start(deps, CSV, { dryRun: true })).id);
		expect(after.counters).toMatchObject({ unchanged: 2 });
		expect(deps.mediaFetcher.calls).toHaveLength(3);
	});

	it("updates only what changed: a new file, an alt, a cleared field", async () => {
		const { deps } = makeDeps();
		serve(deps);
		await runToEnd(deps, (await start(deps, CSV)).id);
		const changed = `${HEADER}A1,Chair,${url("b.png")},A red chair,\nA2,Lamp,${url("b.png")},A lamp,\n`;
		const job = await runToEnd(deps, (await start(deps, changed)).id);
		expect(job.counters).toMatchObject({ updated: 2 });
		const [a1, a2] = await rows(deps, job.id);
		expect(a1?.changes).toEqual([
			{ field: "photo", before: "m1", after: "m3" },
			{ field: "manual", before: "m2", after: null },
		]);
		expect(a2?.changes).toEqual([{ field: "photo.alt", before: null, after: "A lamp" }]);
		expect(entryData(deps)[1]).toMatchObject({ photo: { id: "m3", alt: "A lamp" } });
		expect(entryData(deps)[0]).toMatchObject({
			photo: { id: "m3", alt: "A red chair" },
			manual: null,
		});
	});

	it("downloads nothing for a record with a lookup error, and reports every error", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.mediaFetcher.blocked.add("evil.test");
		deps.lookups.defs.push({
			name: "tag",
			hierarchical: false,
			collections: ["products"],
			locale: "en",
		});
		const tpl = template({}, { taxonomies: { tag: { from: "Name" } } });
		const csv = `${HEADER}A1,missing,${url("a.png")},,https://evil.test/a.pdf\n`;
		const upload = `u${deps.source.uploads.size + 1}`;
		deps.source.add(upload, csv);
		const created = await createJob(deps, {
			uploadId: upload,
			template: tpl,
			schemaFields,
			linkSchema: { taxonomies: deps.lookups.defs },
		});
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ failed: 1 });
		expect((await rows(deps, job.id))[0]?.errors?.map((e) => `${e.field}:${e.code}`)).toEqual([
			"taxonomies.tag:term_not_found",
			"manual:media_blocked",
		]);
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("downloads nothing for an entry that is locked or has someone else's draft", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const plain = `${HEADER}A1,Chair,,,\nA2,Lamp,,,\n`;
		await runToEnd(deps, (await start(deps, plain)).id);
		deps.content.locked.add("e1");
		const e2 = deps.content.entries.get("e2")!;
		e2.pendingPublish = true;
		e2.rev++;
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job.counters).toMatchObject({ locked: 1, conflict: 1 });
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("fails a record whose download fails, listing what it stored, and keeps it for the next run", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.mediaFetcher.files.delete(url("a.pdf"));
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		const [a1] = await rows(deps, job.id);
		expect(a1).toMatchObject({
			status: "failed",
			action: "create",
			errors: [
				{ field: "manual", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			newMedia: [`photo: ${url("a.png")}`],
		});
		expect(deps.content.entries.size).toBe(1);
		serve(deps);
		const retried = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(retried.counters).toMatchObject({ created: 1, unchanged: 1 });
		expect(deps.mediaFetcher.urls().filter((u) => u === url("a.png"))).toHaveLength(1);
	});

	it("fails the job when EmDash cannot store media", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.media.failUpload = () => new MediaUploadError("NO_STORAGE", "Storage not configured");
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job).toMatchObject({
			status: "failed",
			error: { code: "media_config", message: "EmDash cannot store media: Storage not configured" },
		});
	});

	it("leaves a record whose next download is too late for the next batch, without downloading twice", async () => {
		const { deps, clock } = makeDeps();
		serve(deps);
		deps.mediaFetcher.files.set(url("a.png"), {
			body: PNG(1),
			contentType: "image/png",
			ms: 1000 + MEDIA_GRACE_MS,
		});
		const created = await start(deps, CSV, { budgetMs: 1000 });
		const first = await runBatch(deps, created.id, "driver");
		expect(first.cursor.seq).toBe(0);
		expect(await rows(deps, created.id)).toEqual([]);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		expect(await deps.mediaMap.get(mediaMapKey(url("a.png")))).not.toBeNull();
		clock.t += 60_000;
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ created: 2 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
	});

	it("ends a batch after the record that spends the lookup budget", async () => {
		const { deps } = makeDeps();
		let csv = HEADER;
		for (let i = 0; i < 12; i++) {
			deps.mediaFetcher.files.set(url(`${i}.png`), { body: PNG(i), contentType: "image/png" });
			csv += `S${i},Item,${url(`${i}.png`)},,\n`;
		}
		const created = await start(deps, csv);
		// Each record: 25, a map lookup 1, a download 60.
		const job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		expect(job.cursor.seq).toBe(7);
	});

	it("leaves templates without media as before", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const tpl = { ...template(), fields: { title: { from: "Name", type: "text" } } };
		const job = await runToEnd(deps, (await start(deps, CSV, { tpl })).id);
		expect(job).not.toHaveProperty("mediaMaxBytes");
		expect(job.counters).toMatchObject({ created: 2 });
		expect(deps.mediaMap.rows.size).toBe(0);
		expect(deps.media.calls).toEqual([]);
		expect((await rows(deps, job.id)).every((r) => r.newMedia === undefined)).toBe(true);
	});

	it("refreshes a URL once per job, so a slow refresh cannot defer a record forever", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.mediaFetcher.files.get(url("a.png"))!.ms = 21_000;
		const tpl = template({
			photo: { from: "Img", type: "image", refresh: true },
		});
		const csv = `${HEADER}A1,Chair,${url("a.png")},,${url("a.pdf")}\n`;
		const created = await start(deps, csv, { tpl });
		const job = await runToEnd(deps, created.id);
		expect(job).toMatchObject({ status: "completed", counters: { created: 1 } });
		expect(deps.mediaFetcher.urls().filter((u) => u === url("a.png"))).toHaveLength(1);
		const [row] = await rows(deps, created.id);
		// The first download ran in the batch that deferred the record; it is still listed.
		expect(row?.newMedia).toEqual([`photo: ${url("a.png")}`, `manual: ${url("a.pdf")}`]);
		expect(job.deferred).toBeUndefined();
	});
});
