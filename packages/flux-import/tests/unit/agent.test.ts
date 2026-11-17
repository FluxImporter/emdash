import { describe, expect, it } from "vitest";
import { createJob, JobError, JobExistsError } from "../../src/engine/jobs.js";
import { SourceMissingError } from "../../src/engine/ports.js";
import { createRollback } from "../../src/engine/rollback.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	type AgentDeps,
	agentError,
	CLAIM_ATTEMPTS,
	hasMissingRule,
	isSourceMissing,
	PLAN_SOURCE_MISSING_MESSAGE,
	planJob,
	readJobStatus,
	SOURCE_FILE_MISSING_MESSAGE,
	startFromDryRun,
	stepAgentJob,
	XLSX_TEXT_MESSAGE,
} from "../../src/plugin/agent.js";
import { STORAGE } from "../../src/plugin/definition.js";
import type { JobRequest } from "../../src/plugin/job-templates.js";
import { ServiceError } from "../../src/plugin/service.js";
import { STAGED_FILE, summarize, summarizeRecord } from "../../src/plugin/summaries.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { MemoryKv, makeDeps } from "./fakes.js";
import { runToEnd } from "./rollback-fixture.js";
import { failure } from "./templates-fixture.js";

const UPLOAD = `01JZ5V6Q8X0000000000000000${"ab".repeat(16)}`;
const plain = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const owned = { ...plain, rules: { owner: "shop", missing: { action: "unpublish" } } };

function saved(id: string, template: object, revision = 1): SavedTemplate {
	return {
		id,
		name: id,
		template: template as SavedTemplate["template"],
		revision,
		collection: "products",
		locale: "en",
		format: "csv",
		createdAt: "",
		updatedAt: "",
		createdBy: "admin",
		updatedBy: "admin",
	};
}

function jobRow(id: string, extra: Partial<Job> = {}): Job {
	return {
		id,
		status: "created",
		uploadId: UPLOAD,
		template: plain as unknown as Job["template"],
		dryRun: false,
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		cursor: { offset: 0, seq: 0 },
		counters: {
			created: 0,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
		},
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		failures: 0,
		createdAt: "2026-11-16T10:00:00.000Z",
		updatedAt: "2026-11-16T10:00:00.000Z",
		...extra,
	};
}

/** A completed dry run that jobs/plan made from template T1 at revision 1. */
const agentDryRun = (extra: Partial<Job> = {}) =>
	jobRow("D1", {
		status: "completed",
		dryRun: true,
		origin: "agent",
		templateId: "T1",
		templateRevision: 1,
		publish: false,
		batchSize: 20,
		budgetMs: 3000,
		...extra,
	});

async function setup(template: object = plain) {
	const jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
	const templates = new MemoryKv<SavedTemplate>(STORAGE.templates.indexes);
	await templates.put("T1", saved("T1", template));
	const requests: JobRequest[] = [];
	const staged: string[] = [];
	const unstaged: string[] = [];
	let made = 0;
	let ids = 0;
	const deps: AgentDeps = {
		jobs,
		templates,
		// createJobFrom's contract: a job under request.id, or JobExistsError.
		create: async (request, resolved) => {
			requests.push(request);
			const id = request.id ?? `J${++made}`;
			const job = jobRow(id, {
				dryRun: request.dryRun,
				uploadId: request.uploadId ?? UPLOAD,
				publish: request.publish ?? true,
				...(request.origin === undefined ? {} : { origin: request.origin }),
				...(request.dryRunOf === undefined ? {} : { dryRunOf: request.dryRunOf }),
				...(resolved.saved === undefined
					? {}
					: { templateId: resolved.saved.id, templateRevision: resolved.saved.revision }),
			});
			if (!(await jobs.compareAndSet(id, null, job)).applied) throw new JobExistsError(id);
			return job;
		},
		stage: async (text) => {
			staged.push(text);
			return `up${staged.length}`;
		},
		unstage: async (uploadId) => {
			unstaged.push(uploadId);
		},
		newId: () => `R${++ids}`,
	};
	return { deps, jobs, templates, requests, staged, unstaged };
}

describe("hasMissingRule (M6c)", () => {
	it("is true only for a template whose rules carry missing", () => {
		expect(hasMissingRule(owned)).toBe(true);
		for (const t of [plain, { ...plain, rules: { owner: "shop" } }, { rules: null }, null, 3]) {
			expect(hasMissingRule(t), JSON.stringify(t)).toBe(false);
		}
	});
});

describe("planJob (M6c)", () => {
	it("plans a dry run of the text from the saved template, as an agent job", async () => {
		const { deps, requests, staged } = await setup();
		const job = await planJob(deps, { templateId: "T1", text: "sku,Name\nA,One\n" });
		expect(staged).toEqual(["sku,Name\nA,One\n"]);
		// No missing option on a plain template (spec Ruling 29), and never a journal option.
		expect(requests).toEqual([
			{ templateId: "T1", dryRun: true, origin: "agent", uploadId: "up1" },
		]);
		expect(job).toMatchObject({ dryRun: true, origin: "agent", templateId: "T1" });
	});

	it("passes missing: false exactly when the template has rules.missing", async () => {
		const { deps, requests } = await setup(owned);
		await planJob(deps, { templateId: "T1", text: "sku,Name\nA,One\n" });
		expect(requests[0]).toMatchObject({ missing: false });
		expect(requests[0]).not.toHaveProperty("journal");
	});

	it("forwards publish, batchSize and budgetMs", async () => {
		const { deps, requests } = await setup();
		await planJob(deps, {
			templateId: "T1",
			text: "x",
			publish: false,
			batchSize: 7,
			budgetMs: 900,
		});
		expect(requests[0]).toMatchObject({ publish: false, batchSize: 7, budgetMs: 900 });
	});

	it("plans from a URL source by its ID, staging nothing", async () => {
		const { deps, requests, staged } = await setup();
		await planJob(deps, { templateId: "T1", sourceId: "S1" });
		expect(requests).toEqual([{ templateId: "T1", dryRun: true, origin: "agent", sourceId: "S1" }]);
		expect(staged).toEqual([]);
	});

	it("plans a URL source of a template with rules.missing with missing: false", async () => {
		const { deps, requests } = await setup(owned);
		await planJob(deps, { templateId: "T1", sourceId: "S1" });
		expect(requests[0]).toMatchObject({ missing: false, origin: "agent", dryRun: true });
	});

	it("refuses before staging: XLSX text, a stale revision, an unknown template, bad input", async () => {
		const xlsx = await setup({ ...plain, source: { format: "xlsx" } });
		const refused = await failure(planJob(xlsx.deps, { templateId: "T1", text: "x" }));
		expect(refused).toMatchObject({ code: "INVALID_FORMAT", status: 400 });
		expect(refused.message).toBe(XLSX_TEXT_MESSAGE);
		const { deps, staged } = await setup();
		const stale = planJob(deps, { templateId: "T1", templateRevision: 2, text: "x" });
		expect(await failure(stale)).toMatchObject({ code: "TEMPLATE_CHANGED", status: 409 });
		const unknown = planJob(deps, { templateId: "nope", text: "x" });
		expect(await failure(unknown)).toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
		for (const input of [{}, { text: "x", sourceId: "S1" }]) {
			const bad = planJob(deps, { templateId: "T1", ...input });
			expect(await failure(bad)).toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
		}
		expect([...staged, ...xlsx.staged]).toEqual([]);
	});

	it("plans an XLSX template from a URL source", async () => {
		const { deps, requests } = await setup({ ...plain, source: { format: "xlsx" } });
		await planJob(deps, { templateId: "T1", sourceId: "S1" });
		expect(requests).toHaveLength(1);
	});

	it("deletes the staged text when the job cannot be created (spec Ruling 28)", async () => {
		const { deps, unstaged } = await setup();
		deps.create = async () => {
			throw new JobError("invalid_template", "The template does not fit the source or schema");
		};
		await expect(planJob(deps, { templateId: "T1", text: "x" })).rejects.toMatchObject({
			code: "invalid_template",
		});
		expect(unstaged).toEqual(["up1"]);
	});

	it("keeps the creation error when the delete fails too", async () => {
		const { deps } = await setup();
		deps.create = async () => {
			throw new JobError("invalid_template", "refused");
		};
		deps.unstage = async () => {
			throw new Error("storage down");
		};
		await expect(planJob(deps, { templateId: "T1", text: "x" })).rejects.toMatchObject({
			code: "invalid_template",
		});
	});
});

describe("startFromDryRun (M6c)", () => {
	it("runs a completed agent dry run with its upload, template revision and publish", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const job = await startFromDryRun(deps, { dryRunId: "D1" });
		// No sourceId (spec Ruling 9), no journal option (default true, Ruling 10), no missing.
		expect(requests).toEqual([
			{
				id: "R1",
				uploadId: UPLOAD,
				templateId: "T1",
				dryRun: false,
				origin: "agent",
				dryRunOf: "D1",
				publish: false,
				batchSize: 20,
				budgetMs: 3000,
			},
		]);
		expect(job).toMatchObject({ id: "R1", dryRun: false, origin: "agent", dryRunOf: "D1" });
		expect(await jobs.get("D1")).toMatchObject({ startedAs: "R1" });
	});

	it("passes missing: false for a template with rules.missing", async () => {
		const { deps, jobs, requests } = await setup(owned);
		await jobs.put("D1", agentDryRun());
		await startFromDryRun(deps, { dryRunId: "D1" });
		expect(requests[0]).toMatchObject({ missing: false });
		expect(requests[0]).not.toHaveProperty("journal");
	});

	it("never passes the journal option, whatever the dry run holds (spec Ruling 10)", async () => {
		const { deps, jobs, requests } = await setup(owned);
		await jobs.put("D1", agentDryRun({ journal: false }));
		await startFromDryRun(deps, { dryRunId: "D1" });
		expect(requests[0]).not.toHaveProperty("journal");
	});

	it("starts an XLSX dry run from its workbook, at the pace given", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun({ uploadId: "converted", sourceUploadId: UPLOAD }));
		await startFromDryRun(deps, { dryRunId: "D1", batchSize: 5, budgetMs: 1000 });
		expect(requests[0]).toMatchObject({ uploadId: UPLOAD, batchSize: 5, budgetMs: 1000 });
	});

	it("refuses jobs that dry_run did not create (spec Ruling 32)", async () => {
		const { deps, jobs, requests } = await setup();
		// A real agent import, a rollback, a dry run through jobs/create.
		// Every case but the one under test has a template at a revision, so each conjunct is proven.
		const pinned = { templateId: "T1", templateRevision: 1 };
		const done = { status: "completed" } as const;
		await jobs.put("A", jobRow("A", { ...done, ...pinned, origin: "agent" }));
		await jobs.put("B", jobRow("B", { ...done, dryRun: true, kind: "rollback" }));
		await jobs.put("C", jobRow("C", { ...done, ...pinned, dryRun: true }));
		// An agent-marked rollback, an agent dry run without a template, one without a revision.
		const marked = { ...done, dryRun: true, origin: "agent" } as const;
		await jobs.put("E", jobRow("E", { ...marked, ...pinned, kind: "rollback" }));
		await jobs.put("F", jobRow("F", { ...marked, templateRevision: 1 }));
		// resolveJobTemplate would not pin a revision it is not given.
		await jobs.put("G", jobRow("G", { ...marked, templateId: "T1" }));
		for (const id of ["A", "B", "C", "E", "F", "G"]) {
			const refused = await failure(startFromDryRun(deps, { dryRunId: id }));
			expect(refused, id).toMatchObject({ code: "NOT_A_DRY_RUN", status: 400 });
			expect(refused.message).toBe(`Job ${id} is not a dry run made with dry_run`);
			expect(await jobs.get(id), id).not.toHaveProperty("startedAs");
		}
		await expect(startFromDryRun(deps, { dryRunId: "Z" })).rejects.toMatchObject({
			code: "not_found",
			message: "Job Z not found",
		});
		expect(requests).toEqual([]);
	});

	it("refuses a dry run that is not completed (Review Focus 2)", async () => {
		const { deps, jobs, requests } = await setup();
		for (const status of ["created", "running", "paused", "failed", "cancelled"] as const) {
			await jobs.put("D1", agentDryRun({ status }));
			const refused = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
			expect(refused, status).toMatchObject({
				code: "DRY_RUN_INCOMPLETE",
				status: 409,
				details: { status },
			});
			expect(refused.message).toBe(
				`Dry run D1 is ${status}; only a completed dry run can be started`,
			);
			expect(await jobs.get("D1")).not.toHaveProperty("startedAs");
		}
		expect(requests).toEqual([]);
	});

	it("refuses to claim or repair a dry run that retention is deleting (P5)", async () => {
		const { deps, jobs, templates, requests } = await setup();
		await jobs.put("D1", agentDryRun({ purging: true }));
		const refused = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(refused).toMatchObject({
			code: "DRY_RUN_INCOMPLETE",
			status: 409,
			details: { status: "completed", purging: true },
		});
		expect(refused.message).toBe("Dry run D1 is being deleted and can't be started");
		expect(await jobs.get("D1")).not.toHaveProperty("startedAs");
		// The residual P5 closes: the real job was purged, so startedAs names no job.
		await jobs.put("D1", agentDryRun({ purging: true, startedAs: "R9" }));
		const repair = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(repair).toMatchObject({ code: "DRY_RUN_INCOMPLETE", details: { purging: true } });
		expect(await jobs.get("R9")).toBeNull();
		// The deletion is the reason given, ahead of the template's.
		await templates.delete("T1");
		const gone = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(gone).toMatchObject({ code: "DRY_RUN_INCOMPLETE", details: { purging: true } });
		expect(requests).toEqual([]);
	});

	it("still returns the started job of a dry run that retention is deleting", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const first = await startFromDryRun(deps, { dryRunId: "D1" });
		const claimed = await jobs.get("D1");
		await jobs.put("D1", { ...(claimed as Job), purging: true });
		const again = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(again).toMatchObject({ id: first.id, origin: "agent", dryRunOf: "D1" });
		expect(requests).toHaveLength(1);
		// A rolled-back one is still DRY_RUN_USED, not the deletion.
		await jobs.put(first.id, { ...first, rolledBackBy: "RB" });
		const used = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(used).toMatchObject({ code: "DRY_RUN_USED" });
	});

	it("refuses a template edited or deleted since the dry run, before any write", async () => {
		const { deps, jobs, templates, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		await templates.put("T1", saved("T1", plain, 2));
		const edited = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(edited).toMatchObject({ code: "TEMPLATE_CHANGED", details: { revision: 2 } });
		await templates.delete("T1");
		const gone = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(gone).toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
		expect(await jobs.get("D1")).not.toHaveProperty("startedAs");
		expect(requests).toEqual([]);
	});

	it("returns the same job when called again, and DRY_RUN_USED once it was rolled back", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const first = await startFromDryRun(deps, { dryRunId: "D1" });
		const again = await startFromDryRun(deps, { dryRunId: "D1", batchSize: 9 });
		expect(again.id).toBe(first.id);
		expect(requests).toHaveLength(1);
		await jobs.put(first.id, { ...first, rolledBackBy: "RB" });
		const used = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(used).toMatchObject({ code: "DRY_RUN_USED", status: 409, details: { jobId: "R1" } });
		expect(used.message).toBe(
			"The import started from dry run D1 was rolled back; run dry_run again",
		);
		expect(requests).toHaveLength(1);
		expect(await jobs.get("D1")).toMatchObject({ startedAs: "R1" });
	});

	it("answers DRY_RUN_USED for a rolled-back job even when its template has changed", async () => {
		const { deps, jobs, templates, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const first = await startFromDryRun(deps, { dryRunId: "D1" });
		await jobs.put(first.id, { ...first, status: "completed", rolledBackBy: "RB" });
		await templates.delete("T1");
		const used = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(used).toMatchObject({ code: "DRY_RUN_USED" });
		expect(requests).toHaveLength(1);
	});

	it("returns the started job before re-reading the template: edited, then deleted", async () => {
		// spec Ruling 38: a repeated start_import returns its job. TEMPLATE_CHANGED and
		// TEMPLATE_NOT_FOUND guard only a fresh claim and the repair path.
		const { deps, jobs, templates, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const first = await startFromDryRun(deps, { dryRunId: "D1" });
		await templates.put("T1", saved("T1", plain, 2));
		const afterEdit = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(afterEdit).toMatchObject({ id: first.id, origin: "agent", dryRunOf: "D1" });
		await templates.delete("T1");
		const afterDelete = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(afterDelete).toMatchObject({ id: first.id, origin: "agent", dryRunOf: "D1" });
		expect(requests).toHaveLength(1);
		expect(await jobs.get("D1")).toMatchObject({ startedAs: first.id });
	});

	it("returns the cancelled job, never a second one (Review Focus 3)", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const first = await startFromDryRun(deps, { dryRunId: "D1" });
		await jobs.put(first.id, { ...first, status: "cancelled" });
		const again = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(again).toMatchObject({ id: first.id, status: "cancelled" });
		expect(summarize(again, 0).next).toBe("stopped");
		expect(requests).toHaveLength(1);
	});

	it("repairs a crash between the claim and the job under the same ID (spec Ruling 38)", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const create = deps.create;
		deps.create = async () => {
			deps.create = create;
			throw new Error("crash");
		};
		await expect(startFromDryRun(deps, { dryRunId: "D1" })).rejects.toThrow("crash");
		expect(await jobs.get("D1")).toMatchObject({ startedAs: "R1" });
		expect(await jobs.get("R1")).toBeNull();
		const job = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(job).toMatchObject({ id: "R1", origin: "agent", dryRunOf: "D1" });
		expect(requests.map((r) => r.id)).toEqual(["R1"]);
		// The repair claims nothing new: the dry run still names R1, and no other ID was drawn.
		expect(await jobs.get("D1")).toMatchObject({ startedAs: "R1" });
		expect(deps.newId()).toBe("R2");
	});

	it("repairs after a refused creation, once the cause is fixed", async () => {
		const { deps, jobs, templates } = await setup();
		await jobs.put("D1", agentDryRun());
		const create = deps.create;
		deps.create = async () => {
			throw new JobError("invalid_template", "The template does not fit the source or schema");
		};
		await expect(startFromDryRun(deps, { dryRunId: "D1" })).rejects.toMatchObject({
			code: "invalid_template",
		});
		// The template is re-checked at its revision on the repair path too.
		await templates.put("T1", saved("T1", plain, 2));
		deps.create = create;
		expect(await failure(startFromDryRun(deps, { dryRunId: "D1" }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
		});
		await templates.put("T1", saved("T1", plain, 1));
		expect((await startFromDryRun(deps, { dryRunId: "D1" })).id).toBe("R1");
	});

	it("settles two concurrent calls on one job", async () => {
		const { deps, jobs } = await setup();
		await jobs.put("D1", agentDryRun());
		const [a, b] = await Promise.all([
			startFromDryRun(deps, { dryRunId: "D1" }),
			startFromDryRun(deps, { dryRunId: "D1" }),
		]);
		expect(a.id).toBe(b.id);
		const real = [...jobs.rows.values()].filter((r) => r.value.dryRunOf === "D1");
		expect(real).toHaveLength(1);
		expect(await jobs.get("D1")).toMatchObject({ startedAs: a.id });
	});

	it("settles five concurrent calls on one job", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		const all = await Promise.all(
			Array.from({ length: 5 }, () => startFromDryRun(deps, { dryRunId: "D1" })),
		);
		expect(new Set(all.map((j) => j.id)).size).toBe(1);
		const real = [...jobs.rows.values()].filter((r) => r.value.dryRunOf === "D1");
		expect(real).toHaveLength(1);
		// Every creation attempt used the one claimed ID.
		expect(new Set(requests.map((r) => r.id))).toEqual(new Set([all[0]?.id]));
	});

	it("returns the job another call created under the claimed ID", async () => {
		const { deps, jobs } = await setup();
		await jobs.put("D1", agentDryRun());
		deps.create = async (request) => {
			const id = request.id as string;
			await jobs.put(id, jobRow(id, { origin: "agent", dryRunOf: "D1", status: "running" }));
			throw new JobExistsError(id);
		};
		expect(await startFromDryRun(deps, { dryRunId: "D1" })).toMatchObject({
			id: "R1",
			status: "running",
		});
	});

	it("rethrows JobExistsError when the job under the claimed ID is gone again", async () => {
		const { deps, jobs } = await setup();
		await jobs.put("D1", agentDryRun());
		deps.create = async (request) => {
			throw new JobExistsError(request.id as string);
		};
		await expect(startFromDryRun(deps, { dryRunId: "D1" })).rejects.toBeInstanceOf(JobExistsError);
	});

	it("gives up with CONFLICT when the dry run keeps changing", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun());
		let claims = 0;
		jobs.compareAndSet = async () => {
			claims++;
			return { applied: false };
		};
		const refused = await failure(startFromDryRun(deps, { dryRunId: "D1" }));
		expect(refused).toMatchObject({ code: "CONFLICT", status: 409 });
		expect(refused.message).toBe("Dry run D1 kept changing; try again");
		expect(claims).toBe(CLAIM_ATTEMPTS);
		expect(requests).toEqual([]);
	});

	it("claims at the revision it read: a write in between loses the claim", async () => {
		const { deps, jobs } = await setup();
		await jobs.put("D1", agentDryRun());
		const getVersioned = jobs.getVersioned.bind(jobs);
		let reads = 0;
		jobs.getVersioned = async (id) => {
			const read = await getVersioned(id);
			// Someone else claims the dry run right after the first read.
			if (++reads === 1) await jobs.put("D1", agentDryRun({ startedAs: "OTHER" }));
			return read;
		};
		await jobs.put("OTHER", jobRow("OTHER", { origin: "agent", dryRunOf: "D1" }));
		const job = await startFromDryRun(deps, { dryRunId: "D1" });
		expect(job.id).toBe("OTHER");
		expect(await jobs.get("D1")).toMatchObject({ startedAs: "OTHER" });
		expect(await jobs.get("R1")).toBeNull();
	});
});

describe("stepAgentJob (M6c)", () => {
	const ran = () => {
		const calls: string[] = [];
		const run = async () => {
			calls.push("batch");
			return jobRow("X");
		};
		return { calls, run };
	};

	it("refuses a job the agent routes did not create, without running a batch", async () => {
		const { jobs } = await setup();
		await jobs.put("A", jobRow("A", { status: "running" }));
		await jobs.put("B", jobRow("B", { kind: "rollback", status: "created" }));
		const { calls, run } = ran();
		for (const id of ["A", "B"]) {
			const refused = await failure(stepAgentJob(jobs, id, run));
			expect(refused).toMatchObject({ code: "JOB_NOT_AGENT", status: 403 });
			expect(refused.message).toBe(`Job ${id} was not created by dry_run or start_import`);
		}
		await expect(stepAgentJob(jobs, "Z", run)).rejects.toMatchObject({ code: "not_found" });
		expect(calls).toEqual([]);
	});

	it("refuses the rollback of an agent job: a rollback never inherits origin (spec Ruling 31)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name\nA1,Desk\n");
		const created = await createJob(deps, {
			uploadId: "u1",
			template: plain,
			schemaFields: [{ slug: "title", type: "string" }],
			origin: "agent",
			dryRunOf: "D1",
		});
		const done = await runToEnd(deps, created.id);
		expect(done).toMatchObject({ status: "completed", origin: "agent", journal: true });
		const { rollback } = await createRollback(deps, { id: done.id });
		expect(rollback).not.toHaveProperty("origin");
		const { calls, run } = ran();
		const refused = await failure(stepAgentJob(deps.jobs, rollback.id, run));
		expect(refused).toMatchObject({ code: "JOB_NOT_AGENT", status: 403 });
		expect(calls).toEqual([]);
	});

	it("answers a finished job without running a batch (Review Focus 4)", async () => {
		const { jobs } = await setup();
		const { calls, run } = ran();
		for (const status of ["completed", "paused", "failed", "cancelled"] as const) {
			await jobs.put("D1", agentDryRun({ status }));
			const before = await jobs.getVersioned("D1");
			expect((await stepAgentJob(jobs, "D1", run)).status).toBe(status);
			expect((await jobs.getVersioned("D1"))?.revision).toBe(before?.revision);
		}
		expect(calls).toEqual([]);
	});

	it("runs one batch of a created or running agent job", async () => {
		const { jobs } = await setup();
		for (const status of ["created", "running"] as const) {
			await jobs.put("D1", agentDryRun({ status }));
			const { calls, run } = ran();
			expect((await stepAgentJob(jobs, "D1", run)).id).toBe("X");
			expect(calls, status).toEqual(["batch"]);
		}
	});
});

describe("readJobStatus (M6c)", () => {
	const row = (jobId: string, seq: number): RecordRow => ({
		jobId,
		seq,
		start: 0,
		end: 0,
		status: "planned",
		sourceKey: `K${seq}`,
		entryId: null,
		updatedAt: "",
	});

	it("reads the job once, and a page of 10 records only on request", async () => {
		const { jobs } = await setup();
		await jobs.put("D1", agentDryRun());
		const records = new MemoryKv<RecordRow>(STORAGE.records.indexes);
		for (let seq = 1; seq <= 15; seq++) await records.put(`D1:${seq}`, row("D1", seq));
		let gets = 0;
		let queries = 0;
		const get = jobs.get.bind(jobs);
		jobs.get = (id) => {
			gets++;
			return get(id);
		};
		const query = records.query.bind(records);
		records.query = (opts) => {
			queries++;
			return query(opts);
		};
		const deps = { jobs, records };
		const bare = await readJobStatus(deps, { id: "D1" }, 0);
		expect(bare).toEqual({ job: summarize(agentDryRun(), 0) });
		expect([gets, queries]).toEqual([1, 0]);
		const first = await readJobStatus(deps, { id: "D1", records: "planned" }, 0);
		expect(first.records?.items.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(first.records?.hasMore).toBe(true);
		const cursor = first.records?.cursor as string;
		const second = await readJobStatus(deps, { id: "D1", records: "planned", cursor }, 0);
		expect(second.records).toMatchObject({ hasMore: false });
		expect(second.records).not.toHaveProperty("cursor");
		expect(second.records?.items.map((r) => r.seq)).toEqual([11, 12, 13, 14, 15]);
		expect([gets, queries]).toEqual([3, 2]);
		await expect(readJobStatus(deps, { id: "Z" }, 0)).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("summarizes a rollback job's records without values", async () => {
		const { jobs } = await setup();
		await jobs.put("RB", jobRow("RB", { kind: "rollback", rollbackOf: "R1" }));
		const records = new MemoryKv<RecordRow>(STORAGE.records.indexes);
		const changed: RecordRow = {
			...row("RB", 1),
			status: "updated",
			changes: [{ field: "title", before: "a", after: "secret draft" }],
		};
		await records.put("RB:1", changed);
		const reply = await readJobStatus({ jobs, records }, { id: "RB", records: "updated" }, 0);
		expect(reply.records?.items).toEqual([summarizeRecord(changed, "rollback")]);
		expect(reply.records?.items[0]?.changes).toEqual([{ field: "title" }]);
	});
});

describe("agentError (spec Ruling 33)", () => {
	it("maps a missing upload to SOURCE_FILE_MISSING without its ID, and redacts the rest", () => {
		const missing = [
			new SourceMissingError(UPLOAD),
			new ServiceError("UPLOAD_NOT_FOUND", `Upload ${UPLOAD} not found`, 404),
			new JobError("invalid_source", `Upload ${UPLOAD} not found`, [], undefined, {
				cause: new SourceMissingError(UPLOAD),
			}),
		];
		for (const e of missing) {
			expect(isSourceMissing(e)).toBe(true);
			const mapped = agentError(e);
			expect(mapped).toBeInstanceOf(ServiceError);
			expect(mapped).toMatchObject({ code: "SOURCE_FILE_MISSING", status: 404 });
			expect((mapped as ServiceError).message).toBe(SOURCE_FILE_MISSING_MESSAGE);
			expect(JSON.stringify(mapped)).not.toContain(UPLOAD.slice(0, 26));
		}
		const job = agentError(new JobError("invalid_template", `at ${UPLOAD}`, [`in ${UPLOAD}`]));
		expect(job).toBeInstanceOf(JobError);
		expect(job).toMatchObject({
			code: "invalid_template",
			message: `at ${STAGED_FILE}`,
			details: [`in ${STAGED_FILE}`],
		});
		const service = agentError(new ServiceError("FETCH_FAILED", `got ${UPLOAD}`, 502));
		expect(service).toBeInstanceOf(ServiceError);
		expect(service).toMatchObject({
			code: "FETCH_FAILED",
			message: `got ${STAGED_FILE}`,
			status: 502,
		});
		// A JobError invalid_source without the cause is a parse error, not a missing file.
		const parse = agentError(new JobError("invalid_source", "The source block is invalid"));
		expect(parse).toMatchObject({ code: "invalid_source" });
		// Another ServiceError is not a missing file either.
		expect(isSourceMissing(new ServiceError("NOT_FOUND", "x", 404))).toBe(false);
		expect(isSourceMissing(new JobError("invalid_source", "x"))).toBe(false);
		const other = new Error("boom");
		expect(agentError(other)).toBe(other);
	});

	it("tells jobs/plan to call dry_run again, with no dry run to name", () => {
		for (const e of [
			new SourceMissingError(UPLOAD),
			new JobError("invalid_source", "x", [], undefined, { cause: new SourceMissingError(UPLOAD) }),
		]) {
			const mapped = agentError(e, PLAN_SOURCE_MISSING_MESSAGE);
			expect(mapped).toMatchObject({ code: "SOURCE_FILE_MISSING", status: 404 });
			expect((mapped as ServiceError).message).toBe(
				"The data to plan from is no longer stored; call dry_run again",
			);
			expect((agentError(e) as ServiceError).message).toBe(
				"The dry run's data is no longer stored; run dry_run again",
			);
		}
		// Only the missing-file message changes; every other error maps as before.
		const other = agentError(new ServiceError("FETCH_FAILED", `got ${UPLOAD}`, 502), "x");
		expect(other).toMatchObject({ code: "FETCH_FAILED", message: `got ${STAGED_FILE}` });
	});

	it("keeps a JobError's sourceCode", () => {
		const mapped = agentError(new JobError("invalid_source", "bad", [], "csv_syntax"));
		expect(mapped).toMatchObject({ code: "invalid_source", sourceCode: "csv_syntax" });
	});

	it("redacts the strings in a ServiceError's details, nested ones included (P3a)", () => {
		const mapped = agentError(
			new ServiceError("INVALID_TEMPLATE", "refused", 400, {
				code: `c ${UPLOAD}`,
				revision: 3,
				problems: [`p ${UPLOAD}`, 7],
				nested: { key: `flux-import-upload-${UPLOAD}.csv`, ok: true },
			}),
		);
		expect(mapped).toMatchObject({
			code: "INVALID_TEMPLATE",
			details: {
				code: `c ${STAGED_FILE}`,
				revision: 3,
				problems: [`p ${STAGED_FILE}`, 7],
				nested: { key: STAGED_FILE, ok: true },
			},
		});
		expect(JSON.stringify((mapped as ServiceError).details)).not.toContain(UPLOAD.slice(0, 26));
		expect((agentError(new ServiceError("X", "m", 400)) as ServiceError).details).toBeUndefined();
	});
});
