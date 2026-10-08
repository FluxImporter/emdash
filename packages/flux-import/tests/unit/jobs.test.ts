import { describe, expect, it } from "vitest";
import { createJob, JobError, transitionJob } from "../../src/engine/jobs.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];

function setup(csv = "sku,Name\nA1,Desk\n") {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", csv);
	return { deps, clock };
}

describe("createJob", () => {
	it("creates a job positioned after the header with defaults", async () => {
		const { deps } = setup("﻿sku,Name\r\nA1,Desk\r\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(job).toMatchObject({
			status: "created",
			dryRun: false,
			publish: true,
			batchSize: 50,
			budgetMs: 4000,
			headers: ["sku", "Name"],
			cursor: { offset: 3 + "sku,Name\r\n".length, seq: 0 },
			phase: "import",
			lease: null,
			schemaReady: false,
			error: null,
			failures: 0,
		});
		expect(await deps.jobs.get(job.id)).toEqual(job);
	});

	it("keeps publish: false when asked", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields, publish: false });
		expect(job.publish).toBe(false);
	});

	it.each([
		["batch size above 500", { batchSize: 501 }],
		["batch size of zero", { batchSize: 0 }],
		["fractional batch size", { batchSize: 1.5 }],
		["budget below 500 ms", { budgetMs: 100 }],
		["budget above 25 s", { budgetMs: 30_000 }],
	])("rejects %s", async (_name, opts) => {
		const { deps } = setup();
		await expect(
			createJob(deps, { uploadId: "u1", template, schemaFields, ...opts }),
		).rejects.toMatchObject({
			code: "invalid_options",
		});
	});

	it("rejects an invalid template with the Zod messages as details", async () => {
		const { deps } = setup();
		const err = await createJob(deps, {
			uploadId: "u1",
			template: { ...template, version: 9 },
			schemaFields,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(JobError);
		expect(err.code).toBe("invalid_template");
		expect(err.details.length).toBeGreaterThan(0);
	});

	it("rejects a template that does not fit the source or schema", async () => {
		const { deps } = setup("code,Name\nA1,Desk\n");
		await expect(createJob(deps, { uploadId: "u1", template, schemaFields })).rejects.toMatchObject(
			{
				code: "invalid_template",
				details: ['Column "sku" not found in the source'],
			},
		);
	});

	it("rejects a missing upload or unreadable header", async () => {
		const { deps } = setup('sku,"Name\n');
		await expect(
			createJob(deps, { uploadId: "nope", template, schemaFields }),
		).rejects.toMatchObject({ code: "invalid_source" });
		await expect(createJob(deps, { uploadId: "u1", template, schemaFields })).rejects.toMatchObject(
			{ code: "invalid_source" },
		);
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect((await transitionJob(deps, job.id, "pause")).status).toBe("paused");
		expect((await transitionJob(deps, job.id, "resume")).status).toBe("running");
		expect((await transitionJob(deps, job.id, "cancel")).status).toBe("cancelled");
	});

	it("rejects transitions that are not allowed", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await expect(transitionJob(deps, job.id, "resume")).rejects.toMatchObject({
			code: "invalid_transition",
		});
		await expect(transitionJob(deps, job.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
		});
		await transitionJob(deps, job.id, "cancel");
		await expect(transitionJob(deps, job.id, "pause")).rejects.toMatchObject({
			code: "invalid_transition",
		});
	});

	it("clears the error when a failed job resumes", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, {
			...job,
			status: "failed",
			error: { code: "source_missing", message: "gone" },
			failures: 3,
		});
		const resumed = await transitionJob(deps, job.id, "resume");
		expect(resumed).toMatchObject({ status: "running", error: null, failures: 0 });
	});

	it("starts a retry pass only on a completed, non-dry-run job", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, { ...job, status: "completed" });
		expect(await transitionJob(deps, job.id, "retry")).toMatchObject({
			status: "running",
			phase: "retry",
			retryFromSeq: 0,
		});
		const dry = await createJob(deps, { uploadId: "u1", template, schemaFields, dryRun: true });
		await deps.jobs.put(dry.id, { ...dry, status: "completed" });
		await expect(transitionJob(deps, dry.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
		});
	});

	it("reports an unknown job", async () => {
		const { deps } = setup();
		await expect(transitionJob(deps, "missing", "pause")).rejects.toMatchObject({
			code: "not_found",
		});
	});
});
