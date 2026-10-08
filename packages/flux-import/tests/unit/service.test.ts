import { describe, expect, it } from "vitest";
import { JobError } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	LOG_MAX_BYTES,
	listJobs,
	listRecords,
	nextBatch,
	releaseUploadIfUnused,
	ServiceError,
	sampleSource,
	startJob,
	uploadNeeded,
} from "../../src/plugin/service.js";
import { makeDeps } from "./fakes.js";

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
		expect(sample.headers).toEqual(["sku", "Name", "Price"]);
		expect(sample.rows).toHaveLength(20);
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
		expect(log.split("\r\n")[1]).toMatch(/^2,failed,,,,invalid_number,price,/);
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
});
