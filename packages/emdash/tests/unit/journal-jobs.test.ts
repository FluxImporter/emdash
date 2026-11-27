import { describe, expect, it } from "vitest";
import { batchOptions, createJob, JobError, transitionJob } from "../../src/engine/jobs.js";
import {
	bump,
	emptyCounters,
	type Job,
	journalKey,
	journalMediaKey,
} from "../../src/engine/types.js";
import { uploadNeeded } from "../../src/plugin/service.js";
import { clearLastImport, type SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv, makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];

async function setup(opts: { dryRun?: boolean; journal?: boolean; sourceId?: string } = {}) {
	const { deps } = makeDeps();
	deps.source.add("u1", "sku,Name\nS1,Desk\n");
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, ...opts });
	return { deps, job };
}

async function patch(deps: ReturnType<typeof makeDeps>["deps"], id: string, change: Partial<Job>) {
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, ...change });
}

describe("job options for the journal (M5a)", () => {
	it("keeps a journal for real runs by default, and none for dry runs", async () => {
		expect((await setup()).job.journal).toBe(true);
		expect((await setup({ journal: false })).job.journal).toBe(false);
		const dry = await setup({ dryRun: true, journal: true });
		expect(dry.job).not.toHaveProperty("journal");
	});

	it("stores the URL source the job came from", async () => {
		expect((await setup({ sourceId: "src1" })).job.sourceId).toBe("src1");
		expect((await setup()).job).not.toHaveProperty("sourceId");
	});

	it("checks and defaults the batch options", () => {
		expect(batchOptions({})).toEqual({ batchSize: 50, budgetMs: 4000 });
		expect(() => batchOptions({ batchSize: 0 })).toThrow(JobError);
		expect(() => batchOptions({ budgetMs: 100 })).toThrow("budgetMs must be an integer");
	});

	it("keys journal rows by job and link, and media by job and media ID", () => {
		expect(journalKey("j1", "products:en:S1")).toBe("j1:products:en:S1");
		expect(journalMediaKey("j1", "m1")).toBe("j1:m1");
	});

	it("counts reverted rows, which import jobs do not have", () => {
		const counters = emptyCounters();
		expect(counters).not.toHaveProperty("reverted");
		bump(counters, "reverted");
		bump(counters, "created", 2);
		bump(counters, "created", -1);
		expect(counters).toMatchObject({ reverted: 1, created: 1 });
	});
});

describe("transitions of rolled-back and rollback jobs (M5a)", () => {
	it("refuses to resume or retry a job that was rolled back", async () => {
		const { deps, job } = await setup();
		await patch(deps, job.id, { status: "failed", rolledBackBy: "rb1" });
		await expect(transitionJob(deps, job.id, "resume")).rejects.toThrow(
			"Cannot resume a job that was rolled back (rollback job rb1)",
		);
		await patch(deps, job.id, { status: "completed" });
		await expect(transitionJob(deps, job.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
			message: "Cannot retry a job that was rolled back (rollback job rb1)",
		});
	});

	it("refuses to cancel a rollback job, and retries one newest first", async () => {
		const { deps, job } = await setup();
		await patch(deps, job.id, { kind: "rollback", rollbackOf: "j0" });
		await expect(transitionJob(deps, job.id, "cancel")).rejects.toThrow(
			"Cannot cancel a rollback job: pause it, or resume it to finish",
		);
		expect((await transitionJob(deps, job.id, "pause")).status).toBe("paused");
		await patch(deps, job.id, { status: "completed" });
		const retried = await transitionJob(deps, job.id, "retry");
		expect(retried).toMatchObject({
			status: "running",
			phase: "retry",
			retryFromSeq: Number.MAX_SAFE_INTEGER,
		});
	});

	it("never keeps the staged file for a rollback job or a rolled-back job", async () => {
		const { job } = await setup();
		const failed = { ...job, status: "failed" as const };
		expect(uploadNeeded(failed)).toBe(true);
		expect(uploadNeeded({ ...failed, rolledBackBy: "rb1" })).toBe(false);
		expect(uploadNeeded({ ...failed, kind: "rollback", rollbackOf: "j0" })).toBe(false);
	});
});

describe("clearLastImport (M5a)", () => {
	const row = (jobId: string): SourceRow => ({
		id: "src1",
		name: "Feed",
		url: "https://example.com/feed.csv",
		lastImport: { sha256: "abc", uploadId: "u1", jobId, at: "2026-11-03T10:00:00.000Z" },
		createdAt: "2026-11-03T10:00:00.000Z",
		updatedAt: "2026-11-03T10:00:00.000Z",
	});

	it("clears lastImport only when it names the job", async () => {
		const sources = new MemoryKv<SourceRow>();
		await sources.put("src1", row("j1"));
		await clearLastImport({ sources }, "src1", "j2");
		expect((await sources.get("src1"))?.lastImport?.jobId).toBe("j1");
		await clearLastImport({ sources }, "src1", "j1");
		expect(await sources.get("src1")).not.toHaveProperty("lastImport");
		await clearLastImport({ sources }, "missing", "j1");
		expect([...sources.rows.keys()]).toEqual(["src1"]);
	});

	it("writes nothing for a source that does not exist", async () => {
		const sources = new MemoryKv<SourceRow>();
		await clearLastImport({ sources }, "missing", "j1");
		expect(sources.rows.size).toBe(0);
	});

	it("retries after a concurrent change and does not overwrite it", async () => {
		const sources = new MemoryKv<SourceRow>();
		await sources.put("src1", row("j1"));
		const cas = sources.compareAndSet.bind(sources);
		let raced = false;
		sources.compareAndSet = async (id, expected, data) => {
			if (!raced) {
				raced = true;
				const current = (await sources.get(id)) as SourceRow;
				await sources.put(id, { ...current, name: "Renamed" });
			}
			return cas(id, expected, data);
		};
		await clearLastImport({ sources }, "src1", "j1");
		const after = await sources.get("src1");
		expect(after?.name).toBe("Renamed");
		expect(after).not.toHaveProperty("lastImport");
	});

	it("leaves a concurrently replaced lastImport alone", async () => {
		const sources = new MemoryKv<SourceRow>();
		await sources.put("src1", row("j1"));
		const cas = sources.compareAndSet.bind(sources);
		let raced = false;
		sources.compareAndSet = async (id, expected, data) => {
			if (!raced) {
				raced = true;
				await sources.put(id, row("j2"));
			}
			return cas(id, expected, data);
		};
		await clearLastImport({ sources }, "src1", "j1");
		expect((await sources.get("src1"))?.lastImport?.jobId).toBe("j2");
	});
});
