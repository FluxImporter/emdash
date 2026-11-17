import { describe, expect, it } from "vitest";
import { resolveSiteLocale } from "../../src/emdash/locale.js";
import { EmDashUploads } from "../../src/emdash/uploads.js";
import { JobError } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	LOG_MAX_BYTES,
	listJobs,
	listRecords,
	mediaMaxBytes,
	nextBatch,
	PASTE_MAX_BYTES,
	releaseUploadIfUnused,
	ServiceError,
	sampleSource,
	stagePaste,
	startJob,
	tickBatchCap,
	tickLimits,
	uploadNeeded,
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	WORKERS_MEDIA_MAX_BYTES,
	WORKERS_MISSING_BATCH_CAP,
	WORKERS_MISSING_SCAN_CAP,
	WORKERS_ROLLBACK_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { FakeStorage, makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
};
const fields = async (collection: string) =>
	collection === "products"
		? [
				{ slug: "title", type: "string" },
				{ slug: "price", type: "number" },
			]
		: null;

function csv(n: number, bad: (i: number) => boolean = () => false): string {
	let out = "sku,Name,Price\n";
	for (let i = 0; i < n; i++) out += `S${i},Item ${i},${bad(i) ? "x" : i}\n`;
	return out;
}

class Uploads {
	readonly deleted: string[] = [];
	async delete(id: string) {
		this.deleted.push(id);
	}
}

async function drive(deps: ReturnType<typeof makeDeps>["deps"], uploads: Uploads, id: string) {
	for (let i = 0; i < 100; i++) {
		const job = await nextBatch(deps, uploads, id, `h${i}`);
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

describe("sampleSource", () => {
	it("returns headers and at most 20 rows", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(30));
		const sample = await sampleSource(deps, "u1", 50);
		expect(sample).toMatchObject({ headers: ["sku", "Name", "Price"] });
		expect("rows" in sample && sample.rows).toHaveLength(20);
	});

	it("returns records and paths for JSON and XML", async () => {
		const { deps } = makeDeps();
		deps.source.add(
			"j",
			'{"data": [{"sku": "A1", "price": {"amount": 1}}, {"sku": "B2", "tags": []}]}',
		);
		expect(await sampleSource(deps, "j", 5, { format: "json", records: "data" })).toEqual({
			records: [
				{ sku: "A1", price: { amount: 1 } },
				{ sku: "B2", tags: [] },
			],
			paths: ["sku", "price.amount", "tags"],
		});
		deps.source.add("x", '<feed><item sku="A1"><t>x</t></item></feed>');
		expect(await sampleSource(deps, "x", 5, { format: "xml", records: "feed/item" })).toEqual({
			records: [{ "@sku": "A1", t: "x" }],
			paths: ["@sku", "t"],
		});
	});

	it("reports a bad source block or an unreadable document as INVALID_SOURCE", async () => {
		const { deps } = makeDeps();
		deps.source.add("x", '<!DOCTYPE feed [<!ENTITY a "b">]><feed/>');
		await expect(sampleSource(deps, "x", 5, { format: "xml" })).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: expect.stringMatching(/required for xml/),
		});
		await expect(
			sampleSource(deps, "x", 5, { format: "xml", records: "feed/item" }),
		).rejects.toMatchObject({ code: "INVALID_SOURCE", status: 400 });
	});

	it("names the source error code in the details", async () => {
		const { deps } = makeDeps();
		deps.source.add("x", '<!DOCTYPE feed [<!ENTITY a "b">]><feed/>');
		deps.source.add("e", '<?xml version="1.0" encoding="ISO-8859-1"?><feed/>');
		deps.source.add("c", 'sku\n"open');
		await expect(
			sampleSource(deps, "x", 5, { format: "xml", records: "feed/item" }),
		).rejects.toMatchObject({ code: "INVALID_SOURCE", details: { code: "xml_dtd_not_allowed" } });
		await expect(
			sampleSource(deps, "e", 5, { format: "xml", records: "feed/item" }),
		).rejects.toMatchObject({ code: "INVALID_SOURCE", details: { code: "unsupported_encoding" } });
		await expect(sampleSource(deps, "c", 5)).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			details: { code: "csv_syntax" },
		});
	});

	it("reports a missing upload as 404 and an unreadable one as 400", async () => {
		const { deps } = makeDeps();
		deps.source.add("bad", 'sku\n"open');
		await expect(sampleSource(deps, "nope", 5)).rejects.toMatchObject({
			code: "UPLOAD_NOT_FOUND",
			status: 404,
		});
		await expect(sampleSource(deps, "bad", 5)).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			status: 400,
		});
	});
});

describe("stagePaste", () => {
	it("stages the text's UTF-8 bytes like an upload", async () => {
		const storage = new FakeStorage();
		const text = '[{"sku": "Ș1"}]';
		const staged = await stagePaste(storage, text);
		expect(staged.bytes).toBe(new TextEncoder().encode(text).byteLength);
		expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
		const stream = await new EmDashUploads(storage).open(staged.uploadId, 0);
		expect(await new Response(stream).text()).toBe(text);
	});

	it("rejects empty or blank text with EMPTY_BODY and stores nothing", async () => {
		const storage = new FakeStorage();
		for (const text of ["", " \n\t"]) {
			await expect(stagePaste(storage, text)).rejects.toMatchObject({
				code: "EMPTY_BODY",
				status: 400,
			});
		}
		expect(storage.files.size).toBe(0);
	});

	it("rejects text over 1 MiB with TOO_LARGE", async () => {
		const storage = new FakeStorage();
		await expect(stagePaste(storage, "é".repeat(PASTE_MAX_BYTES / 2 + 1))).rejects.toMatchObject({
			code: "TOO_LARGE",
			status: 413,
		});
		expect(storage.files.size).toBe(0);
	});

	it("passes the length on Workers, where R2 needs it", async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		const lengths: number[] = [];
		global.FixedLengthStream = class extends TransformStream {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		};
		try {
			const staged = await stagePaste(new FakeStorage(), "a,b\n1,2\n");
			expect(staged.bytes).toBe(8);
			expect(lengths).toEqual([8]);
		} finally {
			delete global.FixedLengthStream;
		}
	});
});

describe("startJob", () => {
	it("checks the template against the collection's fields", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		expect(job).toMatchObject({ status: "created", dryRun: true, publish: true });
	});

	it("rejects an unknown collection and an invalid template", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const unknown = await startJob(
			deps,
			{ uploadId: "u1", template: { ...template, collection: "nope" }, dryRun: false },
			fields,
		).catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(JobError);
		expect(unknown).toMatchObject({ code: "invalid_template" });
		await expect(
			startJob(deps, { uploadId: "u1", template: { version: 2 }, dryRun: false }, fields),
		).rejects.toMatchObject({
			code: "invalid_template",
		});
	});

	it("names the source error code of an unreadable source", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '<!DOCTYPE feed SYSTEM "x.dtd"><feed/>');
		const xmlTemplate = {
			...template,
			source: { format: "xml", records: "feed/item" },
			fields: { title: { from: "title", type: "text" } },
		};
		await expect(
			startJob(deps, { uploadId: "u1", template: xmlTemplate, dryRun: false }, fields),
		).rejects.toMatchObject({ code: "invalid_source", sourceCode: "xml_dtd_not_allowed" });
	});

	it("stores the site's casing of the template locale", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const resolve = (locale: string) =>
			resolveSiteLocale(locale, { defaultLocale: "en", locales: ["en", "pt-BR"] });
		const job = await startJob(
			deps,
			{ uploadId: "u1", template: { ...template, locale: "PT-br" }, dryRun: false },
			fields,
			resolve,
		);
		expect(job.template.locale).toBe("pt-BR");
		expect((await deps.jobs.get(job.id))?.template.locale).toBe("pt-BR");
	});

	it("rejects a locale the site does not configure", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const resolve = (locale: string) =>
			resolveSiteLocale(locale, { defaultLocale: "en", locales: ["en", "pt-BR"] });
		const error = await startJob(
			deps,
			{ uploadId: "u1", template: { ...template, locale: "fr" }, dryRun: false },
			fields,
			resolve,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JobError);
		expect(error).toMatchObject({
			code: "invalid_template",
			details: ['locale: Locale "fr" is not configured for this site'],
		});
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("reads each reference target's fields once, and taxonomy definitions only when mapped", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name,Maker,Brand,Cat\nS1,A,m,b,c\n");
		deps.lookups.defs.push({
			name: "category",
			hierarchical: true,
			collections: ["products"],
			locale: "en",
		});
		const looked: string[] = [];
		const lookup = async (collection: string) => {
			looked.push(collection);
			const ref = { type: "reference", storageless: true, relationSide: "parent" as const };
			if (collection === "products") {
				return [
					{ slug: "title", type: "string" },
					{ ...ref, slug: "maker", targetCollection: "makers" },
					{ ...ref, slug: "brand", targetCollection: "makers" },
					{ ...ref, slug: "unmapped", targetCollection: "others" },
				];
			}
			return collection === "makers" ? [{ slug: "flux_source_id", type: "string" }] : null;
		};
		const linked = {
			...template,
			fields: {
				title: { from: "Name", type: "text" },
				maker: { from: "Maker", type: "reference", match: "key" },
				brand: { from: "Brand", type: "reference" },
			},
			taxonomies: { category: { from: "Cat" } },
		};
		const job = await startJob(deps, { uploadId: "u1", template: linked, dryRun: true }, lookup);
		expect(looked).toEqual(["products", "makers"]);
		expect(deps.lookups.calls).toEqual(["defs"]);
		expect(job.taxonomies).toEqual({ category: { hierarchical: true } });
		deps.lookups.calls.length = 0;
		deps.source.add("u2", csv(1));
		await startJob(deps, { uploadId: "u2", template, dryRun: true }, fields);
		expect(deps.lookups.calls).toEqual([]);
	});
});

describe("staged upload lifecycle", () => {
	it("deletes the file when an import completes with nothing to retry", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(3));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await drive(deps, uploads, job.id)).status).toBe("completed");
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("keeps the file while failed records can be retried, and after a dry run", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(3, (i) => i === 1),
		);
		const real = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await drive(deps, uploads, real.id)).counters.failed).toBe(1);
		deps.source.add("u2", csv(2));
		const dry = await startJob(deps, { uploadId: "u2", template, dryRun: true }, fields);
		await drive(deps, uploads, dry.id);
		expect(uploads.deleted).toEqual([]);
	});

	it("keeps a file another job still needs, and deletes it on cancel otherwise", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(2));
		const first = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const second = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await changeJob(deps, uploads, first.id, "cancel");
		expect(uploads.deleted).toEqual([]);
		await changeJob(deps, uploads, second.id, "cancel");
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("keeps a file that a URL source still names as its latest fetch", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(2));
		const keep = async (uploadId: string) => uploadId === "u1";
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await nextBatch(deps, uploads, job.id, "h", keep)).status).toBe("completed");
		const other = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const cancelled = await changeJob(deps, uploads, other.id, "cancel", keep);
		expect(uploads.deleted).toEqual([]);
		// Without the keeper (the source was deleted), the same release deletes the file.
		expect(await releaseUploadIfUnused(deps, uploads, cancelled)).toBe(true);
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("releases an XLSX job's workbook with its converted file, unless another job needs it", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		const xlsx = { ...template, source: { format: "xlsx" } };
		const lines = '{"sku":"S1","Name":"Item 1","Price":1,"_row":2}\n';
		const start = (converted: string, dryRun: boolean) => {
			deps.source.add(converted, lines);
			return startJob(
				deps,
				{
					uploadId: converted,
					sourceUploadId: "book",
					columns: ["sku", "Name", "Price"],
					template: xlsx,
					dryRun,
				},
				fields,
			);
		};
		// A finished dry run keeps its files: the real run converts the workbook again.
		const dry = await start("c1", true);
		await drive(deps, uploads, dry.id);
		expect(uploads.deleted).toEqual([]);
		const real = await start("c2", false);
		await drive(deps, uploads, real.id);
		expect(uploads.deleted).toEqual(["c2"]);
		// Once nothing needs it, cancelling the dry run releases its copy and the workbook.
		await deps.jobs.put(dry.id, { ...(await getJob(deps, dry.id)), status: "running" });
		await changeJob(deps, uploads, dry.id, "cancel");
		expect(uploads.deleted).toEqual(["c2", "c1", "book"]);
	});

	it("keeps an XLSX workbook that a URL source still names as its latest fetch", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("c1", '{"sku":"S1","Name":"Item 1","Price":1,"_row":2}\n');
		const job = await startJob(
			deps,
			{
				uploadId: "c1",
				sourceUploadId: "fetched",
				columns: ["sku", "Name", "Price"],
				template: { ...template, source: { format: "xlsx" } },
				dryRun: false,
			},
			fields,
		);
		const keep = async (uploadId: string) => uploadId === "fetched";
		expect((await nextBatch(deps, uploads, job.id, "h", keep)).status).toBe("completed");
		expect(uploads.deleted).toEqual(["c1"]);
	});

	it("knows which states still need the file", () => {
		const base = {
			dryRun: false,
			counters: { created: 1, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0 },
		} as Job;
		expect(uploadNeeded({ ...base, status: "paused" })).toBe(true);
		expect(uploadNeeded({ ...base, status: "failed" })).toBe(true);
		expect(uploadNeeded({ ...base, status: "cancelled" })).toBe(false);
		expect(uploadNeeded({ ...base, status: "completed" })).toBe(false);
		expect(
			uploadNeeded({ ...base, status: "completed", counters: { ...base.counters, locked: 1 } }),
		).toBe(true);
		expect(uploadNeeded({ ...base, status: "completed", dryRun: true })).toBe(true);
	});

	it("propagates a delete failure from releaseUploadIfUnused", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const failing = { delete: async () => Promise.reject(new Error("storage down")) };
		await expect(
			releaseUploadIfUnused(deps, failing, { ...job, status: "cancelled" }),
		).rejects.toThrow("storage down");
		await expect(changeJob(deps, failing, job.id, "cancel")).resolves.toMatchObject({
			status: "cancelled",
		});
	});
});

describe("reads", () => {
	it("lists jobs newest first with a status filter", async () => {
		const { deps, clock } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(1));
		const a = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		clock.t += 1000;
		const b = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		await changeJob(deps, uploads, a.id, "cancel");
		expect((await listJobs(deps, {})).items.map((j) => j.id)).toEqual([b.id, a.id]);
		expect((await listJobs(deps, { status: "cancelled" })).items.map((j) => j.id)).toEqual([a.id]);
	});

	it("pages records of one job in order and filters by status", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(60, (i) => i % 10 === 0),
		);
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await drive(deps, uploads, job.id);
		const first = await listRecords(deps, { id: job.id });
		expect(first.items).toHaveLength(50);
		expect(first.hasMore).toBe(true);
		const second = await listRecords(deps, {
			id: job.id,
			...(first.cursor ? { cursor: first.cursor } : {}),
		});
		expect(second.items.map((r) => r.seq)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
		const failed = await listRecords(deps, { id: job.id, status: "failed" });
		expect(failed.items.map((r) => r.seq)).toEqual([0, 10, 20, 30, 40, 50]);
		await expect(listRecords(deps, { id: "nope" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("builds the log CSV and refuses one over the raw response limit", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(2, (i) => i === 1),
		);
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await drive(deps, uploads, job.id);
		const log = await jobLogCsv(deps, job.id, "failed");
		expect(log.split("\r\n")[1]).toMatch(/^2,failed,S1,,,invalid_number,price,/);
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 0 } })).items[0]!;
		await deps.records.put(row.id, {
			...row.data,
			errors: [{ code: "x", message: "y".repeat(LOG_MAX_BYTES) }],
		});
		const error = await jobLogCsv(deps, job.id).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServiceError);
		expect(error).toMatchObject({ code: "LOG_TOO_LARGE", status: 413 });
		await expect(getJob(deps, "nope")).rejects.toMatchObject({ code: "not_found" });
	});

	it("refuses an oversized log without reading every page", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(250));
		const job = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false, batchSize: 500 },
			fields,
		);
		await drive(deps, uploads, job.id);
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 0 } })).items[0]!;
		await deps.records.put(row.id, {
			...row.data,
			errors: [{ code: "x", message: "y".repeat(LOG_MAX_BYTES) }],
		});
		let queries = 0;
		const query = deps.records.query.bind(deps.records);
		deps.records.query = (opts) => {
			queries++;
			return query(opts);
		};
		await expect(jobLogCsv(deps, job.id)).rejects.toMatchObject({
			code: "LOG_TOO_LARGE",
			status: 413,
		});
		expect(queries).toBe(1);
	});
});

describe("workersBatchCap", () => {
	it(`caps jobs that map links at ${WORKERS_LINKED_BATCH_CAP} records`, async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		expect(workersBatchCap(job)).toBe(WORKERS_BATCH_CAP);
		const tagged = { ...job.template, bylines: { from: "Name" } };
		expect(workersBatchCap({ ...job, template: tagged })).toBe(WORKERS_LINKED_BATCH_CAP);
		const referenced = {
			...job.template,
			fields: { ...job.template.fields, maker: { from: "Name", type: "reference" as const } },
		};
		expect(workersBatchCap({ ...job, template: referenced })).toBe(WORKERS_LINKED_BATCH_CAP);
		const pictured = {
			...job.template,
			fields: { ...job.template.fields, photo: { from: "Name", type: "image" as const } },
		};
		expect(workersBatchCap({ ...job, template: pictured })).toBe(WORKERS_LINKED_BATCH_CAP);
	});
});

describe("mediaMaxBytes", () => {
	it("is the site's upload limit, at most 5 MiB on Workers, a multiple of 3", () => {
		const MiB = 1024 * 1024;
		// EmDash prechecks the padded base64 size, so a multiple of 3 is never refused there.
		const floor3 = (n: number) => Math.floor(n / 3) * 3;
		expect(WORKERS_MEDIA_MAX_BYTES).toBe(5 * MiB);
		expect(mediaMaxBytes(undefined, false)).toBe(floor3(50 * MiB));
		expect(mediaMaxBytes(undefined, true)).toBe(floor3(5 * MiB));
		expect(mediaMaxBytes(2 * MiB, true)).toBe(floor3(2 * MiB));
		expect(mediaMaxBytes(80 * MiB, false)).toBe(floor3(80 * MiB));
		expect(mediaMaxBytes(Number.NaN, false)).toBe(floor3(50 * MiB));
		expect(mediaMaxBytes(-1, true)).toBe(floor3(5 * MiB));
		expect(mediaMaxBytes(1000, false)).toBe(999);
		expect(mediaMaxBytes(2, false)).toBe(3);
	});
});

describe("nextBatch on Workers", () => {
	it(`processes at most ${WORKERS_BATCH_CAP} records per call, keeping the job's batch size`, async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		global.FixedLengthStream = class extends TransformStream {};
		try {
			const { deps } = makeDeps();
			deps.source.add("u1", csv(60));
			const job = await startJob(
				deps,
				{ uploadId: "u1", template, dryRun: false, batchSize: 50 },
				fields,
			);
			const after = await nextBatch(deps, new Uploads(), job.id, "h");
			expect(after.cursor.seq).toBe(WORKERS_BATCH_CAP);
			expect(after.batchSize).toBe(50);
		} finally {
			delete global.FixedLengthStream;
		}
		const { deps } = makeDeps();
		deps.source.add("u1", csv(60));
		const job = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false, batchSize: 50 },
			fields,
		);
		expect((await nextBatch(deps, new Uploads(), job.id, "h")).cursor.seq).toBe(50);
	});
});

describe("Workers caps of the missing phase (M5c)", () => {
	it("reads at most 40 entries per count batch and decides at most 10 per act batch", () => {
		const job = { kind: "import", phase: "missing", template: { version: 1 } } as unknown as Job;
		expect(WORKERS_MISSING_SCAN_CAP).toBe(40);
		expect(WORKERS_MISSING_BATCH_CAP).toBe(10);
		expect(
			workersBatchCap({
				...job,
				missing: { stage: "count", fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 },
			}),
		).toBe(40);
		expect(
			workersBatchCap({
				...job,
				missing: { stage: "act", fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 },
			}),
		).toBe(10);
	});
});

describe("pump tick caps (M6b, Fact V5)", () => {
	it("caps a tick's batch below a jobs/next batch on Workers, and leaves Node to batchSize", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		const tagged = { ...job, template: { ...job.template, bylines: { from: "Name" } } };
		const missing = { fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 };
		const counting = {
			...job,
			phase: "missing",
			missing: { ...missing, stage: "count" },
		} as unknown as Job;
		const acting = {
			...job,
			phase: "missing",
			missing: { ...missing, stage: "act" },
		} as unknown as Job;
		const rollback = { ...job, kind: "rollback" } as Job;
		const jobs = [job, tagged, counting, acting, rollback];
		expect(jobs.map(tickBatchCap)).toEqual([6, 3, 20, 5, WORKERS_ROLLBACK_BATCH_CAP]);
		// The shared helper: jobs/next keeps its own caps for the same jobs.
		expect(jobs.map(workersBatchCap)).toEqual([
			WORKERS_BATCH_CAP,
			WORKERS_LINKED_BATCH_CAP,
			WORKERS_MISSING_SCAN_CAP,
			WORKERS_MISSING_BATCH_CAP,
			WORKERS_ROLLBACK_BATCH_CAP,
		]);
		expect(tickLimits(true)).toEqual({ maxRecords: tickBatchCap, lookupBudget: 350 });
		expect(tickLimits(false)).toEqual({
			maxRecords: Number.POSITIVE_INFINITY,
			lookupBudget: Number.POSITIVE_INFINITY,
		});
	});

	it("runs a batch at the limits it is given (the pump's tick limits)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(60));
		const job = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false, batchSize: 50 },
			fields,
		);
		const after = await nextBatch(deps, new Uploads(), job.id, "h", undefined, tickLimits(true));
		expect(after.cursor.seq).toBe(6);
		expect(after.batchSize).toBe(50);
	});
});
