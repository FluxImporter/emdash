import { describe, expect, it } from "vitest";
import { noteCreated } from "../../src/engine/batch.js";
import { createRollback, rollbackRefusal } from "../../src/engine/rollback.js";
import type { Job } from "../../src/engine/types.js";
import { purgeExpired } from "../../src/plugin/retention.js";
import {
	nextBatch,
	WORKERS_LINKED_BATCH_CAP,
	WORKERS_ROLLBACK_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { type Deps, importRows, setup, url } from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, tags: "new" };
const DAY = 24 * 60 * 60 * 1000;

async function patch(deps: Deps, id: string, change: Partial<Job>) {
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, ...change });
}

describe("jobs/rollback (M5a)", () => {
	it("creates a rollback job that reads the journal newest first, and marks the original", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const { rollback, original: marked } = await createRollback(deps, {
			id: original.id,
			batchSize: 5,
		});
		expect(rollback).toMatchObject({
			status: "created",
			kind: "rollback",
			rollbackOf: original.id,
			uploadId: original.uploadId,
			template: original.template,
			targetFields: original.targetFields,
			dryRun: false,
			publish: false,
			batchSize: 5,
			budgetMs: 4000,
			cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
			counters: { reverted: 0, created: 0 },
			phase: "import",
			retryFromSeq: Number.MAX_SAFE_INTEGER,
			schemaReady: true,
			warnings: [],
		});
		expect(marked.rolledBackBy).toBe(rollback.id);
		expect((await deps.jobs.get(original.id))?.rolledBackBy).toBe(rollback.id);
		expect(await deps.jobs.get(rollback.id)).toEqual(rollback);
	});

	it("sets nothing for a dry run, and allows any number of them", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const first = await createRollback(deps, { id: original.id, dryRun: true });
		const second = await createRollback(deps, { id: original.id, dryRun: true });
		expect(first.rollback.dryRun).toBe(true);
		expect(second.rollback.id).not.toBe(first.rollback.id);
		expect(await deps.jobs.get(original.id)).not.toHaveProperty("rolledBackBy");
	});

	it("refuses dry runs, rollbacks, jobs without a journal, running jobs and a second rollback", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const refused = (id: string) =>
			createRollback(deps, { id }).catch((e: { code: string; message: string }) => e);
		const dry = await importRows(deps, [desk], { dryRun: true });
		expect(await refused(dry.id)).toMatchObject({
			code: "invalid_transition",
			message: "Cannot roll back a dry-run job: it wrote nothing",
		});
		const plain = await importRows(deps, [desk], { journal: false });
		expect(await refused(plain.id)).toMatchObject({
			message:
				"The job has no journal: it was created before rollback support or with journal: false",
		});
		const { rollback } = await createRollback(deps, { id: original.id });
		expect(await refused(rollback.id)).toMatchObject({
			message: "Cannot roll back a rollback job",
		});
		expect(await refused(original.id)).toMatchObject({
			message: `The job was already rolled back (rollback job ${rollback.id})`,
		});
		expect(await refused("nope")).toMatchObject({ code: "not_found" });
		await expect(createRollback(deps, { id: plain.id, batchSize: 0 })).rejects.toMatchObject({
			code: "invalid_options",
		});
	});

	it("refuses a job that may still write, until it is cancelled", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const now = deps.now();
		for (const status of ["created", "running", "paused"] as const) {
			expect(rollbackRefusal({ ...job, status }, now)).toBe(
				`Cannot roll back a ${status} job: cancel it first`,
			);
		}
		for (const status of ["completed", "cancelled", "failed"] as const) {
			expect(rollbackRefusal({ ...job, status }, now)).toBeNull();
		}
		const leased = {
			...job,
			status: "failed" as const,
			lease: { holder: "x", expiresAt: now + 1 },
		};
		expect(rollbackRefusal(leased, now)).toBe(
			"Cannot roll back the job while one of its batches is running",
		);
		expect(rollbackRefusal({ ...job, journal: undefined as never }, now)).toContain("no journal");
	});

	it("deletes the new job when the original changed meanwhile", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const cas = deps.jobs.compareAndSet.bind(deps.jobs);
		deps.jobs.compareAndSet = async (id, expected, data) =>
			id === original.id ? { applied: false } : cas(id, expected, data);
		await expect(createRollback(deps, { id: original.id })).rejects.toMatchObject({
			code: "invalid_transition",
			message: "The job changed while its rollback was being created; try again",
		});
		expect((await deps.jobs.query({ where: { kind: "rollback" } })).items).toEqual([]);
	});

	it("warns about the media and terms the import created, which are kept", async () => {
		const { deps } = setup();
		const original = await importRows(
			deps,
			[
				{ ...desk, img: url("a.png"), tags: "fresh" },
				{ sku: "A2", name: "Lamp", img: url("b.png"), tags: "fresh|bright" },
			],
			{ extra: { taxonomies: { tag: { from: "Tags", separator: "|", create: true } } } },
		);
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		expect(rollback.warnings).toEqual([
			"The import created 2 media items, which are kept (EmDash cannot tell whether other content uses them): m1, m2",
			"The import created 2 terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms",
		]);
	});

	it("lists at most 100 media IDs in seq order, then says there are more", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		for (let i = 101; i >= 0; i--) {
			await deps.journalMedia.put(`${original.id}:m${i}`, {
				jobId: original.id,
				mediaId: `m${i}`,
				url: url(`${i}.png`),
				seq: i,
			});
		}
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		const [warning] = rollback.warnings ?? [];
		expect(warning).toMatch(
			/^The import created more than 100 media items, .*: m0, m1, .*, m99, and more$/,
		);
		expect(warning).not.toContain("m100");
	});

	it("lists media a crashed batch never saved to the job's summary", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const { created: _lost, ...withoutSummary } = (await deps.jobs.get(original.id)) as Job;
		await deps.jobs.put(original.id, withoutSummary);
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		expect(rollback.warnings?.[0]).toMatch(/^The import created 1 media items, .*: m1$/);
	});

	it("keeps the summary on the job while it imports, one entry per term and media item", async () => {
		const { deps } = setup();
		const original = await importRows(
			deps,
			[
				{ ...desk, img: url("a.png"), tags: "fresh" },
				{ sku: "A2", name: "Lamp", img: url("b.png"), tags: "fresh|bright" },
				{ sku: "A3", name: "Sofa", img: url("copy.png"), tags: "bright" },
			],
			{ extra: { taxonomies: { tag: { from: "Tags", separator: "|", create: true } } } },
		);
		const stored = await deps.jobs.get(original.id);
		// "fresh" is created once although two records use it; copy.png dedupes onto a.png.
		expect(stored?.created).toEqual({
			terms: ["tag: fresh", "tag: bright"],
			termCount: 2,
			media: ["m1", "m2"],
			mediaCount: 2,
		});
	});

	it("counts a term once however often it is noted, and lists at most 100", () => {
		const job = {} as Job;
		noteCreated(job, "terms", ["a", "b"]);
		noteCreated(job, "terms", ["b", "c"]);
		expect(job.created).toMatchObject({ terms: ["a", "b", "c"], termCount: 3, mediaCount: 0 });
		const many = {} as Job;
		noteCreated(
			many,
			"media",
			Array.from({ length: 105 }, (_, i) => `m${i}`),
		);
		expect(many.created?.media).toHaveLength(100);
		expect(many.created?.mediaCount).toBe(105);
	});

	it("scans no rows to build the warnings", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [{ ...desk, img: url("a.png") }]);
		for (const rows of [deps.records, deps.journal]) {
			rows.query = () => {
				throw new Error("scanned");
			};
		}
		let mediaQueries = 0;
		const query = deps.journalMedia.query.bind(deps.journalMedia);
		deps.journalMedia.query = (opts) => {
			mediaQueries++;
			expect(opts.limit).toBeLessThanOrEqual(100);
			return query(opts);
		};
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		expect(rollback.warnings).toHaveLength(1);
		expect(mediaQueries).toBe(1);
	});

	it("still reports the conflict when deleting the orphan rollback job fails", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const cas = deps.jobs.compareAndSet.bind(deps.jobs);
		deps.jobs.compareAndSet = async (id, expected, data) =>
			id === original.id ? { applied: false } : cas(id, expected, data);
		deps.jobs.delete = async () => {
			throw new Error("storage down");
		};
		await expect(createRollback(deps, { id: original.id })).rejects.toMatchObject({
			code: "invalid_transition",
			message: "The job changed while its rollback was being created; try again",
		});
	});

	it("caps a rollback batch on Workers at three rows", () => {
		expect(WORKERS_ROLLBACK_BATCH_CAP).toBe(3);
		const job = { template: { fields: {}, collection: "p", locale: "en" } } as unknown as Job;
		expect(workersBatchCap({ ...job, kind: "rollback" })).toBe(3);
		expect(workersBatchCap({ ...job, template: { ...job.template, taxonomies: {} } } as Job)).toBe(
			WORKERS_LINKED_BATCH_CAP,
		);
	});
});

describe("retention of journals and rollbacks (M5a)", () => {
	const purger = { purgeBefore: async () => 0 };

	async function pair(deps: Deps, clock: { t: number }, opts: { dryRun?: boolean } = {}) {
		const original = await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const { rollback } = await createRollback(deps, { id: original.id, ...opts });
		clock.t += 31 * DAY;
		return { original, rollback };
	}

	it("deletes an expired job's journal rows, records and media rows", async () => {
		const { deps, clock } = setup();
		const gone = await importRows(deps, [{ sku: "B1", name: "Bench", img: url("a.png") }]);
		clock.t += 31 * DAY;
		const kept = await importRows(deps, [desk]);
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toMatchObject({ jobs: 1, journal: 2 });
		expect(await deps.jobs.get(gone.id)).toBeNull();
		expect(await deps.jobs.get(kept.id)).not.toBeNull();
		expect((await deps.journal.query({ where: { jobId: gone.id } })).items).toEqual([]);
		expect((await deps.journalMedia.query({ where: { jobId: gone.id } })).items).toEqual([]);
		expect((await deps.journal.query({ where: { jobId: kept.id } })).items).toHaveLength(1);
	});

	it("keeps an original while its rollback job exists, whatever the status", async () => {
		for (const status of ["created", "failed", "completed", "cancelled"] as const) {
			const { deps, clock } = setup();
			const { original, rollback } = await pair(deps, clock);
			await patch(deps, rollback.id, { status });
			// The rollback job is recent: the original stays, with its journal.
			const fresh = await deps.jobs.get(rollback.id);
			await deps.jobs.put(rollback.id, {
				...(fresh as Job),
				createdAt: new Date(clock.t).toISOString(),
			});
			const result = await purgeExpired(deps, purger, 30);
			expect(result.jobs, status).toBe(0);
			expect(await deps.jobs.get(original.id), status).not.toBeNull();
			expect((await deps.journal.query({ where: { jobId: original.id } })).items).toHaveLength(1);
		}
	});

	it("keeps an original while a dry-run rollback job names it", async () => {
		const { deps, clock } = setup();
		const { original, rollback } = await pair(deps, clock, { dryRun: true });
		await patch(deps, rollback.id, { createdAt: new Date(clock.t).toISOString() });
		expect((await purgeExpired(deps, purger, 30)).jobs).toBe(0);
		expect(await deps.jobs.get(original.id)).not.toBeNull();
		expect((await deps.journal.query({ where: { jobId: original.id } })).items).toHaveLength(1);
	});

	it("prunes an expired rollback job with its expired original and their rows", async () => {
		const { deps, clock } = setup();
		const { original, rollback } = await pair(deps, clock);
		await patch(deps, rollback.id, { status: "completed" });
		await deps.records.put(`${rollback.id}:1`, {
			jobId: rollback.id,
			seq: 1,
			start: 0,
			end: 0,
			status: "reverted",
			updatedAt: new Date(clock.t).toISOString(),
		} as never);
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toMatchObject({ jobs: 2, journal: 2 });
		expect(await deps.jobs.get(rollback.id)).toBeNull();
		expect(await deps.jobs.get(original.id)).toBeNull();
		expect((await deps.records.query({ where: { jobId: rollback.id } })).items).toEqual([]);
		expect((await deps.records.query({ where: { jobId: original.id } })).items).toEqual([]);
		expect((await deps.journal.query({ where: { jobId: original.id } })).items).toEqual([]);
	});

	it("keeps a job whose rows could not all be deleted, for the next run", async () => {
		const { deps, clock } = setup();
		const job = await importRows(deps, [desk]);
		clock.t += 31 * DAY;
		const deleteMany = deps.journal.deleteMany.bind(deps.journal);
		deps.journal.deleteMany = async () => 0;
		expect((await purgeExpired(deps, purger, 30)).jobs).toBe(0);
		expect(await deps.jobs.get(job.id)).not.toBeNull();
		deps.journal.deleteMany = deleteMany;
		expect((await purgeExpired(deps, purger, 30)).jobs).toBe(1);
	});

	it("marks a job purging before it deletes any of its rows, and refuses a rollback of it", async () => {
		const { deps, clock } = setup();
		const job = await importRows(deps, [desk]);
		clock.t += 31 * DAY;
		let seen: boolean | undefined;
		const deleteMany = deps.journal.deleteMany.bind(deps.journal);
		deps.journal.deleteMany = async (ids) => {
			seen = ((await deps.jobs.get(job.id)) as { purging?: boolean }).purging;
			return deleteMany(ids);
		};
		await purgeExpired(deps, purger, 30);
		expect(seen).toBe(true);
		// A purge that stopped halfway leaves the mark.
		const stopped = await importRows(deps, [{ sku: "B1", name: "Bench" }]);
		clock.t += 31 * DAY;
		deps.journal.deleteMany = async () => 0;
		await purgeExpired(deps, purger, 30);
		expect(await deps.jobs.get(stopped.id)).toMatchObject({ purging: true });
		await expect(createRollback(deps, { id: stopped.id })).rejects.toMatchObject({
			code: "invalid_transition",
			message: "Cannot roll back the job: retention is deleting it",
		});
	});

	it("does not purge an original a rollback was created for after the scan", async () => {
		const { deps, clock } = setup();
		const original = await importRows(deps, [desk]);
		clock.t += 31 * DAY;
		const query = deps.jobs.query.bind(deps.jobs);
		let rolled = false;
		deps.jobs.query = async (opts) => {
			const result = await query(opts);
			if (!rolled) {
				rolled = true;
				// The scan has read the original; a rollback is created before retention marks it.
				await createRollback(deps, { id: original.id });
			}
			return result;
		};
		expect((await purgeExpired(deps, purger, 30)).jobs).toBe(0);
		expect(await deps.jobs.get(original.id)).not.toHaveProperty("purging");
		expect((await deps.journal.query({ where: { jobId: original.id } })).items).toHaveLength(1);
	});

	it("fails a rollback job whose original is gone or being purged, instead of completing empty", async () => {
		for (const how of ["gone", "purging"] as const) {
			const { deps } = setup();
			const original = await importRows(deps, [desk]);
			const { rollback } = await createRollback(deps, { id: original.id });
			if (how === "gone") await deps.jobs.delete(original.id);
			else await patch(deps, original.id, { purging: true } as Partial<Job>);
			const job = await nextBatch(deps, {} as never, rollback.id, "driver");
			expect(job.status, how).toBe("failed");
			expect(job.error, how).toMatchObject({ code: "rollback_original_gone" });
			expect(job.counters.reverted ?? 0).toBe(0);
		}
	});

	it("does not keep the original's file for a rollback job", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const { rollback } = await createRollback(deps, { id: original.id });
		await deps.jobs.delete(original.id);
		const keeps: ReadonlySet<string>[] = [];
		await purgeExpired(
			deps,
			{
				purgeBefore: async (_cutoff: Date, keep: ReadonlySet<string> = new Set()) => {
					keeps.push(keep);
					return 0;
				},
			},
			30,
		);
		expect(await deps.jobs.get(rollback.id)).not.toBeNull();
		expect(keeps[0]?.has(original.uploadId)).toBe(false);
	});
});
