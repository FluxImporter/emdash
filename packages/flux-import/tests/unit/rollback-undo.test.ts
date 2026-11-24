/**
 * M7b (plan Ruling 7): a rollback job counts what its reverted rows did, beside its `reverted`
 * total: entries deleted (the import created them), restored (it updated them), and recovered
 * (its missing phase trashed or unpublished them).
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { linkBefore } from "../../src/engine/journal.js";
import { undoKind } from "../../src/engine/revert.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type Job, journalKey, type LinkRow, linkKey } from "../../src/engine/types.js";
import { summarize } from "../../src/plugin/summaries.js";
import { type Deps, entryOf, importRows, runToEnd, setup } from "./rollback-fixture.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const ZERO = { deleted: 0, restored: 0, recovered: 0 };

const desk = { sku: "A1", name: "Desk", price: 10 };
const changed = { ...desk, name: "Table", price: 12 };
const lamp = { sku: "A2", name: "Lamp", price: 3 };
const chair = { sku: "A3", name: "Chair", price: 5 };

/** Runs a rollback of `id` to its end. */
async function runRollback(
	deps: Deps,
	id: string,
	opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { rollback } = await createRollback(deps, { id, ...opts });
	return runToEnd(deps, rollback.id);
}

/** A1 imported earlier, then the original: A1 updated, A2 and A3 created. */
async function twoCreatesOneUpdate() {
	const made = setup();
	await importRows(made.deps, [desk]);
	const original = await importRows(made.deps, [changed, lamp, chair]);
	expect(original.counters).toMatchObject({ created: 2, updated: 1 });
	return { ...made, original };
}

/** Runs batches until one fails with `message`, then clears the lease as a takeover would. */
async function crash(deps: Deps, id: string, message: string) {
	await expect(runBatch(deps, id, "driver")).rejects.toThrow(message);
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, lease: null });
}

const K9 = linkKey("products", "en", "K9");

/**
 * An original whose missing phase ran: it created K1 and unpublished K2 (journalled as an
 * update past `missing.fromSeq`), and moved K9 to Trash, journalled as the act stage writes it
 * (as `rollback-trash.test.ts` builds it: K9 is a draft, which the unpublish phase leaves).
 */
async function missingPhase() {
	const made = setup();
	const { deps } = made;
	const owner = { rules: { owner: "shop" } };
	const missing = { rules: { owner: "shop", missing: { action: "unpublish", maxPercent: 100 } } };
	await importRows(deps, [{ sku: "K9", name: "Item 9", price: 9 }], {
		extra: owner,
		publish: false,
	});
	await importRows(deps, [{ sku: "K2", name: "Item 2", price: 2 }], { extra: owner });
	const original = await importRows(deps, [{ sku: "K1", name: "Item 1", price: 1 }], {
		extra: missing,
	});
	expect(original.missing).toMatchObject({ stage: "done", fromSeq: 1, removed: 1 });
	expect(entryOf(deps, "K2").status).toBe("draft");
	const link = (await deps.links.get(K9)) as LinkRow;
	const before = structuredClone(entryOf(deps, "K9"));
	await deps.journal.put(journalKey(original.id, K9), {
		jobId: original.id,
		seq: 50,
		collection: "products",
		locale: "en",
		sourceKey: "K9",
		kind: "trash",
		entryId: before.id,
		before: {
			link: linkBefore(link),
			rev: deps.content.revOf(before.id),
			status: before.status,
			scheduledAt: null,
			live: {},
		},
		at: new Date(deps.now()).toISOString(),
	});
	expect((await deps.content.trash("products", before.id)).ok).toBe(true);
	await deps.links.put(K9, {
		...link,
		jobId: original.id,
		missing: { jobId: original.id, action: "trash", at: new Date(deps.now()).toISOString() },
	});
	return { ...made, original };
}

describe("split rollback counts (M7b)", () => {
	it("starts a rollback job with undo zeros and the original's missingFrom", async () => {
		const { deps, original } = await twoCreatesOneUpdate();
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		expect(rollback.undo).toEqual(ZERO);
		// Absent without a missing phase.
		expect(rollback.missingFrom).toBe(original.missing?.fromSeq);
		expect(rollback).not.toHaveProperty("missingFrom");
		expect(await deps.jobs.get(rollback.id)).toMatchObject({ undo: ZERO });

		const withPhase = await missingPhase();
		const made = await createRollback(withPhase.deps, { id: withPhase.original.id });
		expect(made.rollback.missingFrom).toBe(1);
		expect(made.rollback.undo).toEqual(ZERO);
	});

	it("counts a dry rollback of 2 creates and 1 update: deleted 2, restored 1, beside reverted 3", async () => {
		const { deps, original } = await twoCreatesOneUpdate();
		const done = await runRollback(deps, original.id, { dryRun: true });
		expect(done.undo).toEqual({ deleted: 2, restored: 1, recovered: 0 });
		expect(done.counters.reverted).toBe(3);
	});

	it("counts the real rollback the same way as its dry run", async () => {
		const { deps, original } = await twoCreatesOneUpdate();
		const dry = await runRollback(deps, original.id, { dryRun: true });
		const done = await runRollback(deps, original.id, { batchSize: 1 });
		expect(done.status).toBe("completed");
		expect(done.undo).toEqual(dry.undo);
		expect(done.undo).toEqual({ deleted: 2, restored: 1, recovered: 0 });
		expect(done.counters.reverted).toBe(3);
		expect(await deps.jobs.get(done.id)).toMatchObject({ undo: done.undo });
	});

	it("counts the missing phase's trash and unpublish as recovered", async () => {
		const { deps, original } = await missingPhase();
		const dry = await runRollback(deps, original.id, { dryRun: true });
		expect(dry.undo).toEqual({ deleted: 1, restored: 0, recovered: 2 });
		const done = await runRollback(deps, original.id);
		expect(done.counters).toMatchObject({ reverted: 3, conflict: 0, failed: 0 });
		expect(done.undo).toEqual({ deleted: 1, restored: 0, recovered: 2 });
		expect(entryOf(deps, "K2").status).toBe("published");
		expect(entryOf(deps, "K9").trashed).toBe(false);
	});

	it("counts a created entry moved to Trash (no link) as deleted", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		// A crash before the link save, never resumed.
		await deps.links.delete(linkKey("products", "en", "A1"));
		const done = await runRollback(deps, original.id);
		expect(entryOf(deps, "A1").trashed).toBe(true);
		expect(done.counters.reverted).toBe(1);
		expect(done.undo).toEqual({ deleted: 1, restored: 0, recovered: 0 });
	});

	it("counts no conflict, failure or nothing-to-roll-back row", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const original = await importRows(deps, [changed, lamp, chair]);
		// A1: an editor's change after the import (conflict).
		const a1 = entryOf(deps, "A1").id;
		await deps.content.update({ id: a1, rev: deps.content.revOf(a1), data: { title: "Editor" } });
		await deps.content.publish({ id: a1, rev: deps.content.revOf(a1) });
		// A2: deleted for good since (nothing to roll back).
		deps.content.entries.delete(entryOf(deps, "A2").id);
		// A3: a plugin hook refuses its delete (failed).
		deps.content.blockDelete = () => "Delete blocked by plugin hook";
		const done = await runRollback(deps, original.id);
		expect(done.counters).toMatchObject({ conflict: 1, unchanged: 1, failed: 1, reverted: 0 });
		expect(done.undo).toEqual(ZERO);
	});

	it("moves a row's kind on retry: a conflict retried to reverted adds one, once (Review Focus 2)", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk, lamp]);
		// Active translations keep both creates (conflict) until they are gone.
		const translations = [];
		for (const key of ["A1", "A2"]) {
			translations.push(
				await deps.content.create({
					collection: "products",
					locale: "fr",
					data: { title: `${key} fr` },
					translationOf: entryOf(deps, key).id,
				}),
			);
		}
		const done = await runRollback(deps, original.id, { batchSize: 1 });
		expect(done.counters).toMatchObject({ conflict: 2, reverted: 0 });
		expect(done.undo).toEqual(ZERO);
		for (const fr of translations) await deps.content.trash("products", fr.id);
		await transitionJob(deps, done.id, "retry");
		// Before the pass's tally: the batch moved one row from conflict to reverted.
		const first = await runBatch(deps, done.id, "driver");
		expect(first).toMatchObject({ status: "running", counters: { conflict: 1, reverted: 1 } });
		expect(first.undo).toEqual({ deleted: 1, restored: 0, recovered: 0 });
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ conflict: 0, reverted: 2 });
		expect(retried.undo).toEqual({ deleted: 2, restored: 0, recovered: 0 });
		// A second retry finds nothing left and counts nothing again.
		await transitionJob(deps, done.id, "retry");
		const again = await runToEnd(deps, done.id);
		expect(again.counters).toMatchObject({ conflict: 0, reverted: 2 });
		expect(again.undo).toEqual({ deleted: 2, restored: 0, recovered: 0 });
	});

	it("rebuilds undo with the counters when the retry pass tallies", async () => {
		const { deps, original } = await missingPhase();
		deps.content.locked.add(entryOf(deps, "K1").id);
		const done = await runRollback(deps, original.id);
		expect(done.counters).toMatchObject({ locked: 1, reverted: 2 });
		expect(done.undo).toEqual({ deleted: 0, restored: 0, recovered: 2 });
		// Skewed counts, as a crashed retry batch could leave them.
		const stored = (await deps.jobs.get(done.id)) as Job;
		await deps.jobs.put(done.id, {
			...stored,
			undo: { deleted: 9, restored: 9, recovered: 9 },
			counters: { ...stored.counters, reverted: 9 },
		});
		deps.content.locked.clear();
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ locked: 0, reverted: 3 });
		expect(retried.undo).toEqual({ deleted: 1, restored: 0, recovered: 2 });
	});

	it("counts a row once when a crash re-runs it (Review Focus 2)", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk, lamp]);
		const { rollback } = await createRollback(deps, { id: original.id });
		// The first row's stored row is saved; the batch dies on the second, so the cursor is not.
		let deletes = 0;
		deps.content.beforeStep = (step) => {
			if (step === "delete" && ++deletes === 2) throw new Error("crash before the delete");
		};
		await crash(deps, rollback.id, "crash before the delete");
		expect(((await deps.jobs.get(rollback.id)) as Job).undo).toEqual(ZERO);
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters.reverted).toBe(2);
		expect(done.undo).toEqual({ deleted: 2, restored: 0, recovered: 0 });
	});

	it("leaves a rollback job made before 0.7.0 without undo (Review Focus 2)", async () => {
		const { deps, original } = await twoCreatesOneUpdate();
		const { rollback } = await createRollback(deps, { id: original.id });
		const { undo: _, ...old } = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, old);
		const done = await runToEnd(deps, rollback.id);
		expect(done.undo).toBeUndefined();
		expect(done.counters.reverted).toBe(3);
	});

	it("leaves the agents' summary counters unchanged", async () => {
		const { deps, original } = await twoCreatesOneUpdate();
		const done = await runRollback(deps, original.id);
		expect(Object.keys(summarize(done, NOW).counters).sort()).toEqual([
			"conflict",
			"created",
			"failed",
			"filtered",
			"locked",
			"removed",
			"reverted",
			"unchanged",
			"updated",
		]);
	});

	it.each([
		["delete", 5, undefined, "deleted"],
		["trash", 5, 3, "deleted"],
		["restore", 5, 3, "recovered"],
		["revert", 2, 3, "restored"],
		["revert", 3, 3, "recovered"],
		["revert", 9, undefined, "restored"],
		[undefined, 1, undefined, null],
	] as const)("undoKind(%s, %i, %s) is %s", (action, seq, from, kind) =>
		expect(undoKind(action, seq, from)).toBe(kind),
	);
});
