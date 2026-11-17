import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import {
	ensureRetentionScheduled,
	purgeExpired,
	RETENTION_SCHEDULE,
	RETENTION_TASK,
} from "../../src/plugin/retention.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];
const DAY = 24 * 60 * 60 * 1000;

class Purger {
	cutoffs: Date[] = [];
	keeps: ReadonlySet<string>[] = [];
	async purgeBefore(cutoff: Date, keep: ReadonlySet<string> = new Set()) {
		this.cutoffs.push(cutoff);
		this.keeps.push(keep);
		return 2;
	}
}

describe("purgeExpired", () => {
	it("deletes jobs older than the retention period with their records, and keeps links", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\nB,2\n");
		const old = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, old.id, "driver");
		clock.t += 31 * DAY;
		const recent = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, recent.id, "driver");

		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toEqual({ jobs: 1, records: 2, journal: 2, uploads: 2 });
		expect(await deps.jobs.get(old.id)).toBeNull();
		expect(await deps.jobs.get(recent.id)).not.toBeNull();
		expect((await deps.records.query({ where: { jobId: old.id } })).items).toEqual([]);
		expect((await deps.records.query({ where: { jobId: recent.id } })).items).toHaveLength(2);
		expect(deps.links.rows.size).toBe(2);
		expect(purger.cutoffs[0]!.getTime()).toBe(clock.t - 30 * DAY);
		expect(purger.keeps[0]!.has("u1")).toBe(true);
	});

	it("keeps the workbook a surviving XLSX job was converted from", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", '{"sku":"A","Name":"1","_row":2}\n');
		await createJob(deps, {
			uploadId: "converted",
			sourceUploadId: "book",
			columns: ["sku", "Name"],
			template: { ...template, source: { format: "xlsx" } },
			schemaFields,
		});
		const purger = new Purger();
		await purgeExpired(deps, purger, 30);
		expect(purger.keeps[0]).toEqual(new Set(["converted", "book"]));
	});

	it("keeps the staged files it is told to keep, such as each source's latest fetch", async () => {
		const { deps } = makeDeps();
		const purger = new Purger();
		await purgeExpired(deps, purger, 30, new Set(["latest-1", "latest-2"]));
		expect(purger.keeps[0]).toEqual(new Set(["latest-1", "latest-2"]));
	});

	it("leaves a job with a live lease for the next run", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, {
			...job,
			status: "completed",
			lease: { holder: "h", expiresAt: clock.t + 60_000 },
		});
		clock.t += 1;
		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 0);
		expect(purger.keeps[0]).toEqual(new Set(["u1"]));
		expect(result.jobs).toBe(0);
		expect(await deps.jobs.get(job.id)).not.toBeNull();
	});

	it("stops deleting a job's records when a round deletes nothing, and keeps the job", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, job.id, "driver");
		clock.t += 1;
		deps.records.deleteMany = async () => 0;
		let queries = 0;
		const query = deps.records.query.bind(deps.records);
		deps.records.query = (opts) => {
			if (++queries > 5) throw new Error("deleteRecords did not stop");
			return query(opts);
		};
		// The job stays, so the next run retries its rows.
		expect(await purgeExpired(deps, new Purger(), 0)).toMatchObject({ jobs: 0, records: 0 });
		expect(queries).toBe(1);
		expect(await deps.jobs.get(job.id)).not.toBeNull();
	});

	it("pages through more records than one query returns", async () => {
		const { deps, clock } = makeDeps();
		let body = "sku,Name\n";
		for (let i = 0; i < 250; i++) body += `S${i},N\n`;
		deps.source.add("u1", body);
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields, batchSize: 500 });
		await runBatch(deps, job.id, "driver");
		clock.t += 1;
		expect(await purgeExpired(deps, new Purger(), 0)).toMatchObject({ jobs: 1, records: 250 });
		expect(deps.records.rows.size).toBe(0);
	});

	it("never purges an unfinished job, and purges finished ones (spec Ruling 41)", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const statuses = [
			"created",
			"running",
			"paused",
			"completed",
			"cancelled",
			"failed",
		] as const satisfies readonly Job["status"][];
		const jobs: { status: Job["status"]; id: string }[] = [];
		for (const status of statuses) {
			const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
			await deps.jobs.put(job.id, { ...job, status });
			jobs.push({ status, id: job.id });
		}
		clock.t += DAY;
		const result = await purgeExpired(deps, new Purger(), 0);
		expect(result.jobs).toBe(3);
		const kept: Record<string, boolean> = {};
		for (const { status, id } of jobs) kept[status] = (await deps.jobs.get(id)) !== null;
		expect(kept).toEqual({
			created: true,
			running: true,
			paused: true,
			completed: false,
			cancelled: false,
			failed: false,
		});
	});

	it("keeps a job resumed or retried between the scan and the mark (M6c)", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const completed = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, completed.id, "driver");
		const failed = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(failed.id, { ...failed, status: "failed" });
		clock.t += DAY;
		// The scan sees both jobs finished; an Admin retries one and resumes the other before the
		// purge re-reads it to mark it.
		const pending = new Map([
			[completed.id, "retry" as const],
			[failed.id, "resume" as const],
		]);
		const getVersioned = deps.jobs.getVersioned.bind(deps.jobs);
		deps.jobs.getVersioned = async (id) => {
			const action = pending.get(id);
			if (action !== undefined) {
				pending.delete(id);
				await transitionJob(deps, id, action);
			}
			return getVersioned(id);
		};
		const result = await purgeExpired(deps, new Purger(), 0);
		expect(pending.size).toBe(0);
		expect(result).toMatchObject({ jobs: 0, records: 0, journal: 0 });
		for (const id of [completed.id, failed.id]) {
			const job = await deps.jobs.get(id);
			expect(job).toMatchObject({ status: "running" });
			expect(job?.purging).toBeUndefined();
		}
		expect((await deps.records.query({ where: { jobId: completed.id } })).items).toHaveLength(1);
	});

	it("finishes a purge that stopped half way, whatever the job's status (M6c)", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\nB,2\n");
		// Runs from before spec Ruling 41 marked these running jobs and stopped with rows left.
		const marked: Job[] = [];
		for (let i = 0; i < 2; i++) {
			const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
			await runBatch(deps, job.id, "driver");
			const done = await deps.jobs.get(job.id);
			marked.push({ ...done!, status: "running", purging: true });
		}
		const [stalled, leased] = marked as [Job, Job];
		for (const job of marked) await deps.jobs.put(job.id, job);
		clock.t += DAY;
		// A batch takes the second job's lease after the scan: its rows stay for the next run.
		const getVersioned = deps.jobs.getVersioned.bind(deps.jobs);
		deps.jobs.getVersioned = async (id) => {
			if (id === leased.id && !(await deps.jobs.get(id))?.lease) {
				await deps.jobs.put(id, { ...leased, lease: { holder: "h", expiresAt: clock.t + 60_000 } });
			}
			return getVersioned(id);
		};
		const result = await purgeExpired(deps, new Purger(), 0);
		expect(result).toMatchObject({ jobs: 1, records: 2 });
		expect(await deps.jobs.get(stalled.id)).toBeNull();
		expect(await deps.jobs.get(leased.id)).toMatchObject({ purging: true });
		expect((await deps.records.query({ where: { jobId: leased.id } })).items).toHaveLength(2);
	});
});

describe("ensureRetentionScheduled", () => {
	it("schedules the daily task once", async () => {
		const scheduled: string[] = [];
		const tasks: { name: string }[] = [];
		const cron = {
			list: async () =>
				tasks.map((t) => ({ ...t, schedule: RETENTION_SCHEDULE, nextRunAt: "", lastRunAt: null })),
			schedule: async (name: string, opts: { schedule: string }) => {
				scheduled.push(`${name}@${opts.schedule}`);
				tasks.push({ name });
			},
			cancel: async () => {},
		};
		await ensureRetentionScheduled({ cron });
		await ensureRetentionScheduled({ cron });
		expect(scheduled).toEqual([`${RETENTION_TASK}@0 3 * * *`]);
		await expect(ensureRetentionScheduled({})).resolves.toBeUndefined();
	});
});
