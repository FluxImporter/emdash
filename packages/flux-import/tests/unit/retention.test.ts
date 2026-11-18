import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import {
	ensureRetentionScheduled,
	purgeExpired,
	RETENTION_CURSOR_KEY,
	RETENTION_SCAN_PAGE,
	RETENTION_SCHEDULE,
	RETENTION_TASK,
} from "../../src/plugin/retention.js";
import type { ScheduleRow } from "../../src/plugin/schedules.js";
import { MemoryKv, makeDeps } from "./fakes.js";
import { scheduleRow } from "./schedule-fakes.js";

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

/** Plugin KV in memory. */
class KvStore {
	readonly values = new Map<string, unknown>();
	async get<T>(key: string): Promise<T | null> {
		return (this.values.get(key) as T | undefined) ?? null;
	}
	async set(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}
}

/** `n` completed jobs a day old (retention 0 days), and the bounds of a run. */
async function expired(n: number) {
	const made = makeDeps();
	made.deps.source.add("u1", "sku,Name\nA,1\n");
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const job = await createJob(made.deps, { uploadId: "u1", template, schemaFields });
		await made.deps.jobs.put(job.id, { ...job, status: "completed" });
		ids.push(job.id);
	}
	made.clock.t += DAY;
	const schedules = new MemoryKv<ScheduleRow>();
	const kv = new KvStore();
	const bounds = (target: number) => ({ schedules, kv, target });
	return { ...made, ids, schedules, kv, bounds };
}

describe("bounded retention (M6b, spec Ruling 39, plan Ruling 16)", () => {
	it("never purges an open scheduled job or one a launch claim names, whatever its status", async () => {
		const { deps, ids, schedules, bounds } = await expired(3);
		const [open, claimed, plain] = ids as [string, string, string];
		await deps.jobs.put(open, { ...((await deps.jobs.get(open)) as Job), scheduled: "open" });
		const current = { jobId: claimed, claimedAt: "2026-01-01T00:00:00.000Z" };
		await schedules.put("A", scheduleRow("A", { current }));
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		// 3 to start and 6 for the one job: the kept jobs cost no call past the scan.
		expect(result).toEqual({ jobs: 1, records: 0, journal: 0, uploads: 2, queries: 9 });
		expect(await deps.jobs.get(plain)).toBeNull();
		expect(await deps.jobs.get(open)).not.toBeNull();
		expect(await deps.jobs.get(claimed)).not.toBeNull();
	});

	it("stops before a job it cannot finish within the budget, saves it as the cursor, and the next run finishes", async () => {
		const { deps, ids, kv, bounds } = await expired(3);
		// Scan page, schedules read, cursor read: 3. Each job: getVersioned, compareAndSet, three
		// row queries and the delete: 6. A third job would start with 5 < RETENTION_PRUNE_MIN left.
		const first = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(20));
		expect(first).toEqual({ jobs: 2, records: 0, journal: 0, uploads: 2, more: true, queries: 16 });
		expect(kv.values.get(RETENTION_CURSOR_KEY)).toBe(ids[2]);
		const second = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(20));
		expect(second).toEqual({ jobs: 1, records: 0, journal: 0, uploads: 2, queries: 10 });
		expect(kv.values.has(RETENTION_CURSOR_KEY)).toBe(false);
		for (const id of ids) expect(await deps.jobs.get(id)).toBeNull();
	});

	it("leaves a job cut short marked purging, and the next run finishes it", async () => {
		const { deps, ids, bounds } = await expired(1);
		const id = ids[0] as string;
		for (let seq = 0; seq < 450; seq++) {
			await deps.records.put(`${id}:${seq}`, { jobId: id, seq, status: "created" } as never);
		}
		// 3 to start, 2 to mark, four pages of 50 rows (a query and a deleteMany each, one D1
		// statement apiece), then the cursor write, the one call a run makes past its target.
		const first = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(13));
		expect(first).toMatchObject({ jobs: 0, records: 200, more: true, queries: 14 });
		expect(await deps.jobs.get(id)).toMatchObject({ purging: true });
		// 3 to start, the re-check, five pages and the empty query, the journal's two empty
		// queries, the job's delete and the cursor delete.
		const second = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		expect(second).toMatchObject({ jobs: 1, records: 250, queries: 19 });
		expect(deps.records.rows.size).toBe(0);
	});

	it("makes at most one call past its target, whatever the target, and finishes in later runs", async () => {
		for (let target = 13; target <= 40; target++) {
			const { deps, ids, bounds } = await expired(2);
			for (const id of ids) {
				for (let seq = 0; seq < 450; seq++) {
					await deps.records.put(`${id}:${seq}`, { jobId: id, seq, status: "created" } as never);
				}
			}
			for (let run = 0; ; run++) {
				expect(run).toBeLessThan(50);
				const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(target));
				expect((result.queries as number) - target).toBeLessThanOrEqual(1);
				if (!result.more) break;
			}
			expect(deps.records.rows.size).toBe(0);
			expect(deps.jobs.rows.size).toBe(0);
		}
	});

	it("starts at the head when the saved cursor names a job no longer due", async () => {
		const { deps, ids, kv, bounds } = await expired(3);
		kv.values.set(RETENTION_CURSOR_KEY, "gone");
		// 3 to start and 6 for one job leave 9 < RETENTION_PRUNE_MIN.
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(18));
		expect(result).toMatchObject({ jobs: 1, more: true });
		expect(await deps.jobs.get(ids[0] as string)).toBeNull();
		expect(await deps.jobs.get(ids[2] as string)).not.toBeNull();
		expect(kv.values.get(RETENTION_CURSOR_KEY)).toBe(ids[1]);
	});

	it("past RETENTION_SCAN_MAX rows purges the expired jobs it scanned, within its budget, and skips the staged files (Ruling 86)", async () => {
		const { deps, ids, kv, bounds } = await expired(1);
		const job = (await deps.jobs.get(ids[0] as string)) as Job;
		const made = [ids[0] as string];
		for (let i = 0; i < 1000; i++) {
			await deps.jobs.put(`X${i}`, { ...job, id: `X${i}`, uploadId: `u-X${i}` });
			made.push(`X${i}`);
		}
		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 0, new Set(), bounds(150));
		// 50 scan pages, the schedules and the cursor: 52. Each job: its holders query, the mark
		// (2), three row queries and the delete: 7. Thirteen leave 7 < RETENTION_PRUNE_MIN, then
		// the cursor write.
		expect(result).toEqual({
			jobs: 13,
			records: 0,
			journal: 0,
			uploads: 0,
			skipped: "uploads",
			more: true,
			queries: 144,
		});
		// The scan is oldest first, so the oldest go.
		for (const id of made.slice(0, 13)) expect(await deps.jobs.get(id)).toBeNull();
		expect(kv.values.get(RETENTION_CURSOR_KEY)).toBe(made[13]);
		// The keep set is incomplete past the cap: no staged file is purged.
		expect(purger.cutoffs).toEqual([]);
		// The next run goes on from the cursor; under the cap again, it scans everything, needs no
		// holders queries (6 a job) and purges staged files again.
		const next = await purgeExpired(deps, purger, 0, new Set(), bounds(150));
		expect(next).toMatchObject({ jobs: 15, uploads: 2, more: true });
		expect(next.skipped).toBeUndefined();
		for (const id of made.slice(13, 28)) expect(await deps.jobs.get(id)).toBeNull();
		expect(await deps.jobs.get(made[28] as string)).not.toBeNull();
	});

	it("past RETENTION_SCAN_MAX rows never purges an original that a rollback it did not scan may hold (Ruling 86)", async () => {
		const { deps, ids, bounds } = await expired(4);
		const [held, shared, plain, sibling] = ids as [string, string, string, string];
		const base = (await deps.jobs.get(plain)) as Job;
		await deps.jobs.put(held, { ...((await deps.jobs.get(held)) as Job), uploadId: "u-held" });
		await deps.jobs.put(plain, { ...base, uploadId: "u-plain" });
		// Another job on held's upload: the rollback names held, not it.
		await deps.jobs.put(sibling, {
			...((await deps.jobs.get(sibling)) as Job),
			uploadId: "u-held",
		});
		await deps.jobs.put(shared, {
			...((await deps.jobs.get(shared)) as Job),
			uploadId: "u-shared",
		});
		// An expired dry-run rollback of `plain` that the scan sees: it goes first, which frees
		// `plain` in the same run.
		await deps.jobs.put("RS", {
			...base,
			id: "RS",
			kind: "rollback",
			rollbackOf: plain,
			dryRun: true,
			uploadId: "u-plain",
		});
		// Unfinished fillers fill the scan; 21 of them share an upload with `shared`, more than one
		// holders page.
		for (let i = 0; i < 1000; i++) {
			const uploadId = i < RETENTION_SCAN_PAGE + 1 ? "u-shared" : `u-F${i}`;
			await deps.jobs.put(`F${i}`, { ...base, id: `F${i}`, status: "running", uploadId });
		}
		// A dry-run rollback of `held`, newer than every scanned row and expired itself: a dry run
		// does not mark its original rolledBackBy.
		await deps.jobs.put("R", {
			...base,
			id: "R",
			kind: "rollback",
			rollbackOf: held,
			dryRun: true,
			uploadId: "u-held",
		});
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		// 52 to start; the rollback 6 (it needs no holders query); held and shared one holders query
		// each; plain and sibling 7 each.
		expect(result).toMatchObject({ jobs: 3, skipped: "uploads", queries: 74 });
		expect(await deps.jobs.get("RS")).toBeNull();
		expect(await deps.jobs.get(plain)).toBeNull();
		expect(await deps.jobs.get(sibling)).toBeNull();
		expect(await deps.jobs.get(held)).toMatchObject({ status: "completed" });
		expect((await deps.jobs.get(held))?.purging).toBeUndefined();
		expect(await deps.jobs.get(shared)).not.toBeNull();
		expect(await deps.jobs.get("R")).not.toBeNull();
	});

	it("still deletes at exactly RETENTION_SCAN_MAX rows", async () => {
		const { deps, ids, bounds } = await expired(1);
		const job = (await deps.jobs.get(ids[0] as string)) as Job;
		for (let i = 0; i < 999; i++) {
			await deps.jobs.put(`X${i}`, { ...job, id: `X${i}`, status: "running" });
		}
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		// 50 scan pages, the schedules and the cursor, then 6 for the one finished job.
		expect(result).toEqual({ jobs: 1, records: 0, journal: 0, uploads: 2, queries: 58 });
	});

	it("starts at the saved cursor, so a job stays due behind it does not starve the rest", async () => {
		const { deps, ids, kv, bounds } = await expired(3);
		kv.values.set(RETENTION_CURSOR_KEY, ids[1]);
		// 3 to start and 6 for one job leave 9 < RETENTION_PRUNE_MIN.
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(18));
		expect(result).toMatchObject({ jobs: 1, more: true });
		expect(await deps.jobs.get(ids[1] as string)).toBeNull();
		expect(await deps.jobs.get(ids[0] as string)).not.toBeNull();
		expect(kv.values.get(RETENTION_CURSOR_KEY)).toBe(ids[2]);
	});

	it("goes on past a job whose rows will not delete, and saves no cursor", async () => {
		const { deps, ids, kv, bounds } = await expired(2);
		const [stuck, next] = ids as [string, string];
		await deps.records.put(`${stuck}:0`, { jobId: stuck, seq: 0, status: "created" } as never);
		deps.records.deleteMany = async () => 0;
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		expect(result).toMatchObject({ jobs: 1 });
		expect(result.more).toBeUndefined();
		expect(await deps.jobs.get(stuck)).toMatchObject({ purging: true });
		expect(await deps.jobs.get(next)).toBeNull();
		expect(kv.values.has(RETENTION_CURSOR_KEY)).toBe(false);
	});
});

describe("ensureRetentionScheduled", () => {
	it("schedules the hourly task once", async () => {
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
		expect(scheduled).toEqual([`${RETENTION_TASK}@17 * * * *`]);
		await expect(ensureRetentionScheduled({})).resolves.toBeUndefined();
	});

	it("moves a pre-0.4.0 daily task to the hourly expression (spec Ruling 39)", async () => {
		const scheduled: string[] = [];
		const cron = {
			list: async () => [
				{ name: RETENTION_TASK, schedule: "0 3 * * *", nextRunAt: "", lastRunAt: null },
			],
			schedule: async (name: string, opts: { schedule: string }) => {
				scheduled.push(`${name}@${opts.schedule}`);
			},
			cancel: async () => {},
		};
		await ensureRetentionScheduled({ cron });
		expect(RETENTION_SCHEDULE).toBe("17 * * * *");
		expect(scheduled).toEqual([`${RETENTION_TASK}@17 * * * *`]);
	});
});
