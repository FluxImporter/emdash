/**
 * The missing phase across stops (spec M5c "Crash repair"): a call that landed is finished once,
 * one that did not starts over, rows a lost batch saved are counted once, and a retry leaves the
 * phase's rows alone. A cancel or a failure never leaves a landed trash without its marked link,
 * and a rollback undoes the phase.
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type Job, journalKey, type LinkRow, type RecordRow } from "../../src/engine/types.js";
import {
	csv,
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	runToEnd,
	type StartOptions,
	setup,
	start,
} from "./rollback-fixture.js";

const items = (keys: number[]): Row[] =>
	keys.map((i) => ({ sku: `K${i}`, name: `Item ${i}`, price: i }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const opts = (action: "trash" | "unpublish", more: StartOptions = {}): StartOptions => ({
	...more,
	extra: { rules: { owner: "shop", missing: { action, maxPercent: 50 } } },
});
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const journalRow = (deps: Deps, job: Job, key: string) =>
	deps.journal.get(journalKey(job.id, `products:en:${key}`));
const rowsFrom = async (deps: Deps, job: Job) =>
	(await records(deps, job.id)).filter((r) => r.seq >= (job.missing?.fromSeq ?? 0));
const rowOf = async (deps: Deps, job: Job, key: string): Promise<RecordRow | undefined> =>
	(await rowsFrom(deps, job)).find((r) => r.sourceKey === key);
const stored = async (deps: Deps, id: string) => (await deps.jobs.get(id)) as Job;

/** An editor's change through the content API, published as the admin publishes it. */
async function edit(deps: Deps, key: string, publish = true) {
	const id = entryOf(deps, key).id;
	await deps.content.update({ id, rev: deps.content.revOf(id), data: { price: 60 } });
	if (publish) await deps.content.publish({ id, rev: deps.content.revOf(id) });
}

/** Drops a stopped batch's lease, so the next batch resumes the job at once. */
async function unlease(deps: Deps, id: string) {
	const j = await deps.jobs.get(id);
	if (j) await deps.jobs.put(id, { ...j, lease: null });
}

/** Runs batches until one throws "stop"; a stub armed by a helper below throws it. */
async function runUntilStop(deps: Deps, jobId: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const job = await runBatch(deps, jobId, "w1");
			if (job.status !== "running" && job.status !== "created") throw new Error("finished");
		} catch (e) {
			if ((e as Error).message === "stop") return unlease(deps, jobId);
			throw e;
		}
	}
	throw new Error("never stopped");
}

/** The first trash lands, then the process stops before anything else. */
function stopAfterTrash(deps: Deps, error: () => Error = () => new Error("stop")) {
	const trash = deps.content.trash.bind(deps.content);
	const calls = { n: 0 };
	deps.content.trash = async (collection, id) => {
		calls.n++;
		const result = await trash(collection, id);
		if (calls.n === 1) throw error();
		return result;
	};
	return calls;
}

/** The process stops once at the fake's hook for `step`, before or after the call. */
function stopAt(deps: Deps, hook: "beforeStep" | "afterStep", step: "trash" | "unpublish") {
	let armed = true;
	deps.content[hook] = (s: string) => {
		if (s === step && armed) {
			armed = false;
			throw new Error("stop");
		}
	};
}

/** The process stops once at the first save of a row with `status`. */
function stopAtRowPut(deps: Deps, status: RecordRow["status"]) {
	const put = deps.records.put.bind(deps.records);
	let armed = true;
	deps.records.put = async (k, v) => {
		if (armed && v.status === status) {
			armed = false;
			throw new Error("stop");
		}
		return put(k, v);
	};
}

/** The release of the act batch that decided the first row is lost; its rows stay. */
function loseFirstActRelease(deps: Deps) {
	const compareAndSet = deps.jobs.compareAndSet.bind(deps.jobs);
	let armed = true;
	deps.jobs.compareAndSet = async (k, expected, next) => {
		if (armed && next.missing?.stage === "act" && next.missing.rows === 1) {
			armed = false;
			throw new Error("stop");
		}
		return compareAndSet(k, expected, next);
	};
}

/** Eight owned, published entries, then a job whose feed lacks K6 and K7, started. */
async function second(action: "trash" | "unpublish", more: StartOptions = {}) {
	const made = setup();
	const first = await importRows(made.deps, items(range(0, 8)), opts(action));
	const job = await start(made.deps, csv(items(range(0, 6))), opts(action, more));
	return { ...made, first, job };
}

/** Rolls `job` back to the end; K6's entry must be restored as the first import left it. */
async function expectRestored(deps: Deps, job: Job, first: Job) {
	const { rollback } = await createRollback(deps, { id: job.id });
	const rolled = await runToEnd(deps, rollback.id);
	const k6 = entryOf(deps, "K6");
	expect(k6).toMatchObject({ trashed: false, status: "published" });
	const row = (await records(deps, rolled.id)).find((r) => r.sourceKey === "K6");
	expect(row).toMatchObject({ status: "reverted", action: "restore" });
	expect(await linkOf(deps, "K6")).toMatchObject({ jobId: first.id, owner: "shop" });
	expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
}

describe("a stop during an act (M5c crash repair)", () => {
	it("finishes a trash that landed once, without a second call, and rolls it back", async () => {
		const { deps, first, job } = await second("trash");
		const calls = stopAfterTrash(deps);
		await runUntilStop(deps, job.id);
		expect((await rowsFrom(deps, await stored(deps, job.id))).map((r) => r.status)).toEqual([
			"writing",
		]);
		const done = await runToEnd(deps, job.id);
		expect(calls.n).toBe(2);
		expect(done.counters.removed).toBe(2);
		expect(done.missing).toMatchObject({ rows: 2, removed: 2 });
		expect((await rowsFrom(deps, done)).map((r) => [r.sourceKey, r.status])).toEqual([
			["K6", "removed"],
			["K7", "removed"],
		]);
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id, action: "trash" } });
		expect((await journalOf(deps, job.id)).filter((j) => j.kind === "trash")).toHaveLength(2);
		// Task 6: the rollback owns the entry through the mark the repair put.
		await expectRestored(deps, done, first);
	});

	it("starts a call that never went out over, journalling the entry as it now is", async () => {
		const { deps, clock, job } = await second("trash");
		stopAt(deps, "beforeStep", "trash");
		await runUntilStop(deps, job.id);
		clock.t += 60_000;
		const resumedAt = new Date(clock.t).toISOString();
		const done = await runToEnd(deps, job.id);
		expect(done.counters.removed).toBe(2);
		expect(entryOf(deps, "K6").trashed).toBe(true);
		expect(await journalRow(deps, job, "K6")).toMatchObject({
			kind: "trash",
			at: resumedAt,
			before: { rev: (await linkOf(deps, "K6")).writtenRev },
		});
		expect(await rowOf(deps, done, "K6")).toMatchObject({ seq: 6, status: "removed" });
	});

	it("reports an edit after the stop as edited, and drops the stopped attempt's journal row", async () => {
		const { deps, job } = await second("trash");
		stopAt(deps, "beforeStep", "trash");
		await runUntilStop(deps, job.id);
		await edit(deps, "K6");
		const done = await runToEnd(deps, job.id);
		expect((await rowOf(deps, done, "K6"))?.warnings?.map((w) => w.code)).toEqual([
			"missing_edited",
		]);
		expect(await journalRow(deps, job, "K6")).toBeNull();
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(done.counters.removed).toBe(1);
	});

	it("drops a journal row a stop left before its writing row (plan Ruling 14)", async () => {
		const { deps, job } = await second("trash");
		stopAtRowPut(deps, "writing");
		await runUntilStop(deps, job.id);
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
		await edit(deps, "K6");
		const done = await runToEnd(deps, job.id);
		expect(await journalRow(deps, job, "K6")).toBeNull();
		expect((await rowOf(deps, done, "K6"))?.warnings?.map((w) => w.code)).toEqual([
			"missing_edited",
		]);
	});

	it("drops that journal row too when the entry is locked on the resume", async () => {
		const { deps, job } = await second("trash");
		stopAtRowPut(deps, "writing");
		await runUntilStop(deps, job.id);
		deps.content.locked.add(entryOf(deps, "K6").id);
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K6")).toMatchObject({ status: "locked" });
		expect(await journalRow(deps, job, "K6")).toBeNull();
	});

	it("finishes a row whose link put landed before the stop", async () => {
		const { deps, first, job } = await second("trash");
		const put = deps.links.put.bind(deps.links);
		let marked = 0;
		deps.links.put = async (k, v) => {
			if (v.missing !== undefined) marked++;
			return put(k, v);
		};
		stopAtRowPut(deps, "removed");
		await runUntilStop(deps, job.id);
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id } });
		const done = await runToEnd(deps, job.id);
		expect((await records(deps, job.id)).filter((r) => r.status === "writing")).toEqual([]);
		expect(done.counters.removed).toBe(2);
		expect(done.missing?.removed).toBe(2);
		expect(deps.content.calls.filter((c) => c.startsWith("trash:"))).toHaveLength(2);
		// The marked link is put once per entry: the repair only saves the row.
		expect(marked).toBe(2);
		await expectRestored(deps, done, first);
	});

	it("starts an unpublish that never went out over, sending it once", async () => {
		const { deps, job } = await second("unpublish");
		stopAt(deps, "beforeStep", "unpublish");
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		expect(done.counters.removed).toBe(2);
		expect(entryOf(deps, "K6").status).toBe("draft");
		expect(await rowOf(deps, done, "K6")).toMatchObject({ seq: 6, status: "removed" });
		expect(deps.content.calls.filter((c) => c.startsWith("unpublish:"))).toHaveLength(2);
	});

	for (const [what, change] of [
		["still published", (e: { rev: number }) => void e.rev++],
		[
			"scheduled",
			(e: { rev: number; status: string; scheduledAt: string | null }) => {
				e.rev++;
				e.status = "scheduled";
				e.scheduledAt = "2027-01-01T00:00:00.000Z";
			},
		],
	] as const) {
		it(`reports an entry one version on but ${what} as unverified, not unpublished`, async () => {
			const { deps, job } = await second("unpublish");
			stopAt(deps, "beforeStep", "unpublish");
			await runUntilStop(deps, job.id);
			change(entryOf(deps, "K6") as never);
			const done = await runToEnd(deps, job.id);
			expect(await rowOf(deps, done, "K6")).toMatchObject({
				status: "conflict",
				errors: [{ code: "missing_unverified" }],
			});
			expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
		});
	}

	it("leaves a stopped row whose link a later job wrote since", async () => {
		const { deps, job } = await second("trash");
		stopAt(deps, "beforeStep", "trash");
		await runUntilStop(deps, job.id);
		// A later job of the owner writes K6 meanwhile: its link is no candidate of this job.
		const later = await importRows(
			deps,
			[{ sku: "K6", name: "Item 6", price: 66 }],
			opts("trash", { missing: false }),
		);
		expect(await linkOf(deps, "K6")).toMatchObject({ jobId: later.id });
		const done = await runToEnd(deps, job.id);
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(await rowOf(deps, done, "K6")).toMatchObject({ status: "writing" });
	});

	it("journals and deletes nothing in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), opts("trash"));
		// K7 is left alone (edited): a real run would delete a journal row under its key.
		await edit(deps, "K7");
		const calls: string[] = [];
		const { put, delete: del, compareAndSet } = deps.journal;
		deps.journal.put = async (k, v) => {
			calls.push(`put:${k}`);
			return put.call(deps.journal, k, v);
		};
		deps.journal.delete = async (k) => {
			calls.push(`delete:${k}`);
			return del.call(deps.journal, k);
		};
		deps.journal.compareAndSet = async (k, r, v) => {
			calls.push(`cas:${k}`);
			return compareAndSet.call(deps.journal, k, r, v);
		};
		const done = await importRows(deps, items(range(0, 6)), opts("trash", { dryRun: true }));
		expect(done.counters).toMatchObject({ removed: 1 });
		expect(calls).toEqual([]);
	});

	it("finishes an unpublish that landed, at the revision it left", async () => {
		const { deps, job } = await second("unpublish");
		stopAt(deps, "afterStep", "unpublish");
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		const k6 = entryOf(deps, "K6");
		expect(k6.status).toBe("draft");
		expect(await linkOf(deps, "K6")).toMatchObject({
			writtenRev: deps.content.revOf(k6.id),
			jobId: job.id,
		});
		expect(done.counters.removed).toBe(2);
		expect(deps.content.calls.filter((c) => c.startsWith("unpublish:"))).toHaveLength(2);
	});

	it("cannot tell an unpublish that landed from an editor's later change", async () => {
		const { deps, job } = await second("unpublish");
		stopAt(deps, "afterStep", "unpublish");
		await runUntilStop(deps, job.id);
		await edit(deps, "K6", false);
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K6")).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "missing_unverified",
					message:
						"Maybe changed: the import stopped while changing this entry and cannot tell whether someone changed it since",
				},
			],
		});
		// The call may have landed: its journal row stays for a rollback (spec "Crash repair").
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
		expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
	});

	it("reports a trashed entry that is back at another revision as unverified", async () => {
		const { deps, job } = await second("trash");
		stopAfterTrash(deps);
		await runUntilStop(deps, job.id);
		// Someone changed the entry in Trash: the trash landed, but the revision moved since.
		const k6 = entryOf(deps, "K6");
		k6.rev++;
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K6")).toMatchObject({
			status: "conflict",
			errors: [{ code: "missing_unverified" }],
		});
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
		expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
	});

	it("reports an unpublished entry that is gone since as unverified", async () => {
		const { deps, job } = await second("unpublish");
		stopAt(deps, "afterStep", "unpublish");
		await runUntilStop(deps, job.id);
		entryOf(deps, "K6").trashed = true;
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K6")).toMatchObject({
			status: "conflict",
			errors: [{ code: "missing_unverified" }],
		});
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
	});
});

describe("a call that throws (M5c, Task 4 review ruling)", () => {
	it("saves a thrown trash as unverified and keeps its write-ahead row", async () => {
		const { deps, job } = await second("trash");
		const trash = deps.content.trash.bind(deps.content);
		deps.content.trash = async (collection, id) => {
			if (id === entryOf(deps, "K6").id) throw new ContentWriteError("emdash_error", "boom");
			return trash(collection, id);
		};
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(await rowOf(deps, done, "K6")).toMatchObject({
			status: "conflict",
			errors: [{ code: "missing_unverified" }],
		});
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
		expect(done.counters).toMatchObject({ removed: 1, conflict: 1 });
	});

	it("saves a thrown unpublish as unverified and keeps its write-ahead row", async () => {
		const { deps, job } = await second("unpublish");
		deps.content.beforeStep = (step, id) => {
			if (step === "unpublish" && id === entryOf(deps, "K7").id) {
				throw new ContentWriteError("emdash_error", "boom");
			}
		};
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K7")).toMatchObject({
			status: "conflict",
			errors: [{ code: "missing_unverified" }],
		});
		expect(await journalRow(deps, job, "K7")).not.toBeNull();
	});

	it("saves a resume whose read throws as unverified and keeps the journal row", async () => {
		const { deps, job } = await second("trash");
		stopAfterTrash(deps);
		await runUntilStop(deps, job.id);
		const get = deps.content.getIncludingTrashed.bind(deps.content);
		deps.content.getIncludingTrashed = async (collection, locale, id) => {
			if (id === entryOf(deps, "K6").id) throw new ContentWriteError("emdash_error", "boom");
			return get(collection, locale, id);
		};
		const done = await runToEnd(deps, job.id);
		expect(await rowOf(deps, done, "K6")).toMatchObject({
			status: "conflict",
			errors: [{ code: "missing_unverified" }],
		});
		expect(await journalRow(deps, job, "K6")).not.toBeNull();
	});
});

describe("a lost batch (M5c)", () => {
	it("counts rows a batch saved before its release was lost once, and continues the seq", async () => {
		const { deps, job } = await second("trash", { batchSize: 1 });
		loseFirstActRelease(deps);
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		const rows = await rowsFrom(deps, done);
		expect(rows.map((r) => [r.seq, r.sourceKey, r.status])).toEqual([
			[6, "K6", "removed"],
			[7, "K7", "removed"],
		]);
		expect(done.missing).toMatchObject({ rows: 2, removed: 2 });
		expect(done.counters).toMatchObject({ unchanged: 6, removed: 2 });
	});

	it("never removes more than found after a lost batch (the recount)", async () => {
		const { deps, job } = await second("trash", { batchSize: 1 });
		loseFirstActRelease(deps);
		await runUntilStop(deps, job.id);
		// The saved job still says no row was decided; the recount reads the row the lost batch saved.
		expect((await stored(deps, job.id)).missing).toMatchObject({ rows: 0, removed: 0, found: 2 });
		const done = await runToEnd(deps, job.id);
		expect(done.missing?.removed).toBe(2);
		expect(deps.content.calls.filter((c) => c.startsWith("trash:"))).toHaveLength(2);
	});

	it("counts a lost count-stage page once (tallies saved only with their cursor)", async () => {
		const clean = setup();
		await importRows(clean.deps, items(range(0, 8)), opts("trash"));
		const baseline = await importRows(
			clean.deps,
			items(range(0, 2)),
			opts("trash", { dryRun: true }),
		);

		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), opts("trash"));
		// One page of eight links: the third read fails, after two were tallied.
		const job = await start(deps, csv(items(range(0, 2))), opts("trash", { dryRun: true }));
		const get = deps.content.get.bind(deps.content);
		let reads = 0;
		deps.content.get = async (collection, locale, id) => {
			if ((await stored(deps, job.id)).missing?.stage === "count" && ++reads === 3) {
				throw new ContentWriteError("collection_missing", "Collection products is gone");
			}
			return get(collection, locale, id);
		};
		const failed = await runToEnd(deps, job.id);
		expect(failed).toMatchObject({ status: "failed", error: { code: "collection_missing" } });
		deps.content.get = get;
		await transitionJob(deps, job.id, "resume");
		const done = await runToEnd(deps, job.id);
		expect(done.missing).toMatchObject({
			owned: baseline.missing?.owned,
			found: baseline.missing?.found,
			verdict: baseline.missing?.verdict,
		});
		expect(done.missing).toMatchObject({ owned: 8, found: 6 });
	});
});

describe("cancel, failure and rollback (M5c)", () => {
	it("stops on a cancel mid-stage, and resumes from the cursor after a pause", async () => {
		const made = setup();
		await importRows(made.deps, items(range(0, 8)), opts("unpublish"));
		const job = await start(
			made.deps,
			csv(items(range(0, 5))),
			opts("unpublish", { batchSize: 1 }),
		);
		let at = await runBatch(made.deps, job.id, "w1");
		while ((at.missing?.rows ?? 0) < 1) at = await runBatch(made.deps, job.id, "w1");
		await transitionJob(made.deps, job.id, "pause");
		await transitionJob(made.deps, job.id, "resume");
		const done = await runToEnd(made.deps, job.id);
		expect(done.missing).toMatchObject({ stage: "done", rows: 3, removed: 3 });

		const other = await second("unpublish", { batchSize: 1 });
		at = await runBatch(other.deps, other.job.id, "w1");
		while ((at.missing?.rows ?? 0) < 1) at = await runBatch(other.deps, other.job.id, "w1");
		await transitionJob(other.deps, other.job.id, "cancel");
		const cancelled = await runBatch(other.deps, other.job.id, "w1");
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.missing).toMatchObject({ stage: "act", rows: 1 });
		expect(entryOf(other.deps, "K7").status).toBe("published");
	});

	it("finishes a landed trash's link on a cancel, so the rollback restores it", async () => {
		const { deps, first, job } = await second("trash");
		stopAfterTrash(deps);
		await runUntilStop(deps, job.id);
		const cancelled = await transitionJob(deps, job.id, "cancel");
		expect(cancelled).toMatchObject({ status: "cancelled", missing: { rows: 1, removed: 1 } });
		expect(cancelled.counters.removed).toBe(1);
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id, action: "trash" } });
		expect(await rowOf(deps, cancelled, "K6")).toMatchObject({ status: "removed" });
		// Nothing decided anew: K7 is left as it was.
		expect(entryOf(deps, "K7").trashed).toBe(false);
		await expectRestored(deps, cancelled, first);
	});

	it("finishes a landed trash's link when a job-level error fails the job", async () => {
		const { deps, first, job } = await second("trash");
		stopAfterTrash(deps, () => new ContentWriteError("collection_missing", "Collection is gone"));
		const failed = await runToEnd(deps, job.id);
		expect(failed).toMatchObject({ status: "failed", error: { code: "collection_missing" } });
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id } });
		expect(await rowOf(deps, failed, "K6")).toMatchObject({ status: "removed" });
		expect(failed.counters.removed).toBe(1);
		await expectRestored(deps, failed, first);
	});

	it("resumes a job failed before its trash landed, and trashes the entry once", async () => {
		const { deps, job } = await second("trash");
		const trash = deps.content.trash.bind(deps.content);
		let armed = true;
		deps.content.trash = async (collection, id) => {
			if (armed) {
				armed = false;
				throw new ContentWriteError("collection_missing", "Collection is gone");
			}
			return trash(collection, id);
		};
		const failed = await runToEnd(deps, job.id);
		expect(failed.status).toBe("failed");
		expect(await rowOf(deps, failed, "K6")).toMatchObject({ status: "writing" });
		await transitionJob(deps, job.id, "resume");
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { removed: 2 } });
		expect(await rowOf(deps, done, "K6")).toMatchObject({ seq: 6, status: "removed" });
		expect(entryOf(deps, "K6").trashed).toBe(true);
	});

	it("keeps the counts of a batch that ran while a cancel settled the job", async () => {
		const { deps, job } = await second("trash");
		stopAfterTrash(deps);
		await runUntilStop(deps, job.id);
		const put = deps.links.put.bind(deps.links);
		let raced = false;
		deps.links.put = async (k, v) => {
			await put(k, v);
			if (!raced && v.missing !== undefined) {
				// A driver claims the job while the cancel's settling is under way, and finishes it.
				raced = true;
				await runToEnd(deps, job.id);
			}
		};
		await expect(transitionJob(deps, job.id, "cancel")).rejects.toThrow("Cannot cancel");
		const done = await stored(deps, job.id);
		expect(done).toMatchObject({ status: "completed", missing: { rows: 2, removed: 2 } });
		expect(done.counters.removed).toBe(2);
	});

	it("leaves a live batch's calls to it on a cancel, and the rollback finishes them", async () => {
		const { deps, clock, first, job } = await second("trash");
		stopAfterTrash(deps);
		for (let i = 0; i < 100; i++) {
			const ran = await runBatch(deps, job.id, "w1").catch((e: Error) => e);
			if (ran instanceof Error) break;
		}
		// The stopped batch's lease is still live: the cancel leaves its row to it.
		const cancelled = await transitionJob(deps, job.id, "cancel");
		expect(await rowOf(deps, cancelled, "K6")).toMatchObject({ status: "writing" });
		expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
		clock.t += cancelled.budgetMs + 60_000;
		await expectRestored(deps, cancelled, first);
	});

	it("finishes a landed trash's link when three unexpected errors fail the job", async () => {
		const { deps, first, job } = await second("trash");
		const put = deps.links.put.bind(deps.links);
		let failures = 0;
		deps.links.put = async (k, v) => {
			if (v.missing !== undefined && failures < 3) {
				failures++;
				throw new Error("D1 went away");
			}
			return put(k, v);
		};
		for (let i = 0; i < 100 && failures < 3; i++) {
			await runBatch(deps, job.id, "w1").catch(() => unlease(deps, job.id));
		}
		const failed = await stored(deps, job.id);
		expect(failed.status).toBe("failed");
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id } });
		expect(await rowOf(deps, failed, "K6")).toMatchObject({ status: "removed" });
		expect(deps.content.calls.filter((c) => c.startsWith("trash:"))).toHaveLength(1);
		await expectRestored(deps, failed, first);
	});

	it("leaves a writing row whose call did not land on a cancel, and a rollback has nothing to undo", async () => {
		const { deps, job } = await second("trash");
		stopAt(deps, "beforeStep", "trash");
		await runUntilStop(deps, job.id);
		const cancelled = await transitionJob(deps, job.id, "cancel");
		expect(await rowOf(deps, cancelled, "K6")).toMatchObject({ status: "writing" });
		const { rollback } = await createRollback(deps, { id: job.id });
		const rolled = await runToEnd(deps, rollback.id);
		expect(entryOf(deps, "K6")).toMatchObject({ trashed: false, status: "published" });
		expect((await records(deps, rolled.id)).find((r) => r.sourceKey === "K6")).toMatchObject({
			status: "unchanged",
			warnings: [{ code: "nothing_to_roll_back" }],
		});
	});

	it("retries the first pass's failed rows and leaves the phase's rows alone", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), opts("trash"));
		deps.content.blockDelete = (id) => (id === entryOf(deps, "K7").id ? "Keep it." : null);
		const body = items(range(0, 5)).concat([{ sku: "K5", name: "Item 5", price: "n/a" as never }]);
		const job = await importRows(deps, body, opts("trash"));
		const failed = await rowOf(deps, job, "K7");
		expect(failed?.status).toBe("failed");
		deps.content.blockDelete = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(await rowOf(deps, retried, "K7")).toEqual(failed);
		expect(entryOf(deps, "K7").trashed).toBe(false);
		expect(retried.counters.removed).toBe(1);
	});

	it("restores and republishes trashed entries, and a later import finds them as before", async () => {
		const { deps } = setup();
		const first = await importRows(deps, items(range(0, 8)), opts("trash"));
		const before = structuredClone(entryOf(deps, "K7"));
		const trashing = await importRows(deps, items(range(0, 6)), opts("trash"));
		expect(entryOf(deps, "K7").trashed).toBe(true);
		const { rollback } = await createRollback(deps, { id: trashing.id });
		const rolled = await runToEnd(deps, rollback.id);
		expect(rolled.counters.reverted).toBe(2);
		const k7 = entryOf(deps, "K7");
		expect(k7).toMatchObject({
			trashed: false,
			status: "published",
			data: before.data,
			slug: before.slug,
		});
		expect(await linkOf(deps, "K7")).toMatchObject({
			jobId: first.id,
			owner: "shop",
			writtenRev: deps.content.revOf(k7.id),
		});
		expect(await linkOf(deps, "K7")).not.toHaveProperty("missing");
		const again = await importRows(deps, items(range(0, 8)), opts("trash"));
		expect(again.counters).toMatchObject({ unchanged: 8, failed: 0 });
	});

	it("republishes unpublished entries through the M5a sequence", async () => {
		const { deps } = setup();
		const first = await importRows(deps, items(range(0, 8)), opts("unpublish"));
		const unpublishing = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		const { rollback } = await createRollback(deps, { id: unpublishing.id });
		await runToEnd(deps, rollback.id);
		for (const key of ["K6", "K7"]) {
			const e = entryOf(deps, key);
			expect(e.status, key).toBe("published");
			expect(await linkOf(deps, key)).toMatchObject({
				jobId: first.id,
				owner: "shop",
				writtenRev: deps.content.revOf(e.id),
			});
			expect(await linkOf(deps, key)).not.toHaveProperty("missing");
		}
	});
});
