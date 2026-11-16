import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, JobError, transitionJob } from "../../src/engine/jobs.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type SchemaField, templateSchema } from "../../src/engine/template.js";
import type { Job } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { jobTemplateRef, resolveJobTemplate } from "../../src/plugin/job-templates.js";
import { listJobs, ServiceError } from "../../src/plugin/service.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { MemoryKv, makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "Name" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
};
const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];
const csv = (n: number) => {
	let out = "sku,Name,Price\n";
	for (let i = 0; i < n; i++) out += `S${i},Item ${i},${i}\n`;
	return out;
};

function savedRow(t: unknown, revision = 1, id = "TPL1"): SavedTemplate {
	const parsed = templateSchema.parse(t);
	return {
		id,
		name: "Saved",
		template: parsed,
		revision,
		collection: parsed.collection,
		locale: parsed.locale,
		format: parsed.source.format,
		createdAt: "2026-11-16T10:00:00.000Z",
		updatedAt: "2026-11-16T10:00:00.000Z",
		createdBy: "u1",
		updatedBy: "u1",
	};
}

async function failure(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (e) {
		return e;
	}
	throw new Error("did not fail");
}

async function runToEnd(deps: Parameters<typeof runBatch>[0], id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

describe("resolveJobTemplate and jobTemplateRef", () => {
	it("returns the stored template with its ID and revision, or refuses a missing or stale one", async () => {
		const templates = new MemoryKv<SavedTemplate>(STORAGE.templates.indexes);
		const row = savedRow(template, 2);
		await templates.put(row.id, row);
		expect(await resolveJobTemplate(templates, "TPL1")).toEqual({
			template: row.template,
			saved: { id: "TPL1", revision: 2 },
		});
		expect(await resolveJobTemplate(templates, "TPL1", 2)).toMatchObject({
			saved: { revision: 2 },
		});
		expect(await failure(resolveJobTemplate(templates, "TPL1", 1))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: "Template TPL1 is at revision 2, not 1; read it again",
			details: { revision: 2 },
		});
		const missing = await failure(resolveJobTemplate(templates, "NOPE"));
		expect(missing).toBeInstanceOf(ServiceError);
		expect(missing).toMatchObject({
			code: "TEMPLATE_NOT_FOUND",
			status: 404,
			message: "Template NOPE not found",
		});
	});

	it("references a saved template by ID and revision, an inline one by a key-order-free fingerprint (Review Focus 3)", async () => {
		expect(await jobTemplateRef({ template, saved: { id: "TPL1", revision: 3 } })).toEqual({
			id: "TPL1",
			revision: 3,
		});
		const a = await jobTemplateRef({ template });
		const reordered = {
			fields: template.fields,
			key: template.key,
			slug: template.slug,
			locale: "en",
			collection: "products",
			version: 1,
		};
		expect(await jobTemplateRef({ template: reordered })).toEqual(a);
		expect(a).toEqual({ fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
		const changed = {
			...template,
			fields: { ...template.fields, price: { from: "Cost", type: "number" } },
		};
		expect(await jobTemplateRef({ template: changed })).not.toEqual(a);
		// The default source block makes an explicit CSV source the same template.
		expect(await jobTemplateRef({ template: { ...template, source: { format: "csv" } } })).toEqual(
			a,
		);
		expect(await jobTemplateRef({ template: { version: 2 } })).toBeNull();
	});
});

describe("jobs from saved templates (spec Rulings 2, 41)", () => {
	it("creates the same job as from the template inline, plus templateId and templateRevision", async () => {
		const inline = makeDeps().deps;
		inline.source.add("u1", csv(3));
		const fromInline = await createJob(inline, { uploadId: "u1", template, schemaFields });
		const saved = makeDeps().deps;
		saved.source.add("u1", csv(3));
		const templates = new MemoryKv<SavedTemplate>();
		await templates.put("TPL1", savedRow(template, 4));
		const resolved = await resolveJobTemplate(templates, "TPL1");
		const fromSaved = await createJob(saved, {
			uploadId: "u1",
			template: resolved.template,
			schemaFields,
			...(resolved.saved ? { savedTemplate: resolved.saved } : {}),
		});
		expect(fromSaved).toEqual({ ...fromInline, templateId: "TPL1", templateRevision: 4 });
		expect(fromInline).not.toHaveProperty("templateId");
	});

	it("keeps M5c's inline refusals: version 2 is invalid_template, and 300 KiB is accepted (spec Ruling 28)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name,Stage\nA1,Desk,live\n");
		const two = await failure(
			createJob(deps, { uploadId: "u1", template: { ...template, version: 2 }, schemaFields }),
		);
		expect(two).toBeInstanceOf(JobError);
		expect(two).toMatchObject({ code: "invalid_template", message: "The template is invalid" });
		expect((two as JobError).details.some((p) => p.startsWith("version: "))).toBe(true);
		const stage: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "stage_a", type: "select", validation: { options: ["live"] } },
			{ slug: "stage_b", type: "select", validation: { options: ["live"] } },
		];
		const big = await createJob(deps, {
			uploadId: "u1",
			template: paddedTemplate("products", 300 * 1024),
			schemaFields: stage,
		});
		expect(big.status).toBe("created");
	});

	it("refuses a stored row that no longer parses, with the key's path (Review Focus 4)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const templates = new MemoryKv<SavedTemplate>();
		const row = savedRow(template);
		await templates.put(row.id, {
			...row,
			template: { ...row.template, futureRule: true } as SavedTemplate["template"],
		});
		const resolved = await resolveJobTemplate(templates, row.id);
		const refused = await failure(
			createJob(deps, { uploadId: "u1", template: resolved.template, schemaFields }),
		);
		expect(refused).toMatchObject({ code: "invalid_template" });
		expect((refused as JobError).details).toContain('template: Unrecognized key: "futureRule"');
	});

	it("carries templateId and templateRevision through resume, retry and rollback", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(6));
		const templates = new MemoryKv<SavedTemplate>();
		await templates.put("TPL1", savedRow(template, 1));
		const resolved = await resolveJobTemplate(templates, "TPL1");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: resolved.template,
			schemaFields,
			batchSize: 2,
			...(resolved.saved ? { savedTemplate: resolved.saved } : {}),
		});
		expect((await runBatch(deps, job.id, "driver")).counters.created).toBe(2);
		await transitionJob(deps, job.id, "pause");
		// The template now maps the title from Price, and then it is deleted.
		const edited = {
			...template,
			fields: { title: { from: "Price", type: "text" }, price: { from: "Price", type: "number" } },
		};
		await templates.put("TPL1", savedRow(edited, 2));
		await templates.delete("TPL1");
		await transitionJob(deps, job.id, "resume");
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", templateId: "TPL1", templateRevision: 1 });
		const titles = () => [...deps.content.entries.values()].map((e) => e.data.title).sort();
		expect(titles()).toEqual(["Item 0", "Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]);
		await transitionJob(deps, job.id, "retry");
		expect((await runToEnd(deps, job.id)).status).toBe("completed");
		expect(titles()).toEqual(["Item 0", "Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]);
		const { rollback } = await createRollback(deps, { id: job.id });
		expect(rollback).toMatchObject({ kind: "rollback", templateId: "TPL1", templateRevision: 1 });
		expect((await runToEnd(deps, rollback.id)).counters.reverted).toBe(6);
	});
});

describe("jobs/list by template (spec Ruling 41)", () => {
	it("lists a template's imports and rollbacks newest first, with and without status, on indexed fields", async () => {
		const jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
		const put = (id: string, at: string, extra: Partial<Job>) =>
			jobs.put(id, { id, status: "completed", createdAt: at, ...extra } as Job);
		await put("J1", "2026-11-16T10:00:00.000Z", { templateId: "TPL1", templateRevision: 1 });
		await put("J2", "2026-11-16T10:01:00.000Z", {});
		await put("J3", "2026-11-16T10:02:00.000Z", {
			templateId: "TPL1",
			templateRevision: 1,
			kind: "rollback",
			status: "running",
		});
		await put("J4", "2026-11-16T10:03:00.000Z", { templateId: "TPL2", templateRevision: 1 });
		expect((await listJobs({ jobs }, { templateId: "TPL1" })).items.map((j) => j.id)).toEqual([
			"J3",
			"J1",
		]);
		expect(
			(await listJobs({ jobs }, { templateId: "TPL1", status: "completed" })).items.map(
				(j) => j.id,
			),
		).toEqual(["J1"]);
		expect((await listJobs({ jobs }, {})).items.map((j) => j.id)).toEqual(["J4", "J3", "J2", "J1"]);
	});

	it("pages a template's jobs to the end, each once", async () => {
		const jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
		const ids: string[] = [];
		for (let i = 0; i < 130; i++) {
			const id = `J${String(i).padStart(3, "0")}`;
			const at = new Date(Date.UTC(2026, 10, 16, 10, 0, i)).toISOString();
			const templateId = i % 3 === 0 ? "TPL2" : "TPL1";
			if (templateId === "TPL1") ids.push(id);
			await jobs.put(id, {
				id,
				status: "completed",
				createdAt: at,
				templateId,
				templateRevision: 1,
			} as Job);
		}
		const seen: Job[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await listJobs({ jobs }, { templateId: "TPL1", ...(cursor ? { cursor } : {}) });
			seen.push(...page.items);
			cursor = page.cursor;
			pages++;
		} while (cursor);
		expect(pages).toBeGreaterThan(1);
		expect(seen.map((j) => j.id)).toEqual([...ids].reverse());
		expect(new Set(seen.map((j) => j.id)).size).toBe(ids.length);
		expect(seen.every((j) => j.templateId === "TPL1")).toBe(true);
	});
});
