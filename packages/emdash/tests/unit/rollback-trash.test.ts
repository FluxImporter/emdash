/**
 * Rolling back a trash of the missing phase (spec M5c "Rollback", steps 8 and 9). The journal
 * rows are written here as the act stage writes them, so these tests need neither Task 4 nor 5.
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { linkBefore } from "../../src/engine/journal.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type Job, journalKey, type LinkRow, type RecordRow } from "../../src/engine/types.js";
import { type Deps, entryOf, importRows, records, runToEnd, setup } from "./rollback-fixture.js";

const KEY = "products:en:K9";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;

type TrashOptions = {
	publish?: boolean;
	/**
	 * What of the act landed after the journal row: all of it (default), nothing (a stop before
	 * the row's deletion), or only the trash or only the marked link.
	 */
	act?: boolean | "trash" | "link";
	/** The marked link as it is when the rollback runs, for links changed since. */
	relink?: (link: LinkRow) => LinkRow;
	/** The journal's `before.rev`, when not the entry's. */
	journalRev?: string;
	/** A mark the link carried before the job (a draft an earlier unpublish left). */
	mark?: LinkRow["missing"];
	/** A collection without revisions, K9 imported twice so its live revision is the first. */
	plain?: boolean;
};

/** K9 from an earlier job, then a later job that trashed it as missing, journalled. */
async function trashed(opts: TrashOptions = {}) {
	const made = setup();
	const { deps } = made;
	if (opts.plain) deps.content.plainCollections.add("products");
	const owner = { extra: { rules: { owner: "shop" } }, sourceId: "feed-1" };
	const publish = opts.publish === false ? { publish: false } : {};
	const creator = await importRows(deps, [{ sku: "K9", name: "Item 9", price: 9 }], {
		...owner,
		...publish,
	});
	const earlier = opts.plain
		? await importRows(deps, [{ sku: "K9", name: "Item 9", price: 19 }], { ...owner, ...publish })
		: creator;
	if (opts.mark) await deps.links.put(KEY, { ...(await linkOf(deps)), missing: opts.mark });
	const job = await importRows(deps, [{ sku: "K1", name: "Item 1", price: 1 }], owner);
	const link = await linkOf(deps);
	const before = structuredClone(entryOf(deps, "K9"));
	await deps.journal.put(journalKey(job.id, KEY), {
		jobId: job.id,
		seq: 50,
		collection: "products",
		locale: "en",
		sourceKey: "K9",
		kind: "trash",
		entryId: before.id,
		before: {
			link: linkBefore(link),
			rev: opts.journalRev ?? deps.content.revOf(before.id),
			status: before.status,
			scheduledAt: null,
			live: {},
		},
		at: new Date(deps.now()).toISOString(),
	});
	const act = opts.act ?? true;
	if (act === true || act === "trash") {
		expect((await deps.content.trash("products", before.id)).ok).toBe(true);
	}
	if (act === true || act === "link") {
		const marked: LinkRow = {
			...link,
			jobId: job.id,
			missing: { jobId: job.id, action: "trash", at: new Date(deps.now()).toISOString() },
		};
		await deps.links.put(KEY, opts.relink ? opts.relink(marked) : marked);
	}
	return { ...made, creator, earlier, job, before };
}

async function rollBack(deps: Deps, job: Job, dryRun = false) {
	const { rollback } = await createRollback(deps, { id: job.id, ...(dryRun ? { dryRun } : {}) });
	const done = await runToEnd(deps, rollback.id);
	const row = (await records(deps, rollback.id)).find((r) => r.sourceKey === "K9") as RecordRow;
	return { done, row };
}

const restoreByHand = (deps: Deps, id: string) =>
	deps.content.revertStep({
		collection: "products",
		locale: "en",
		id,
		rev: deps.content.revOf(id),
		step: "restore",
	});

const CHANGED = {
	code: "rollback_changed",
	message: "Not rolled back: the entry was restored or changed after the import moved it to Trash",
};

describe("rolling back a trash (M5c steps 8 and 9)", () => {
	it("restores and republishes the entry, and hands the link back with its owner", async () => {
		const { deps, earlier, job, before } = await trashed();
		const { done, row } = await rollBack(deps, job);
		expect(row).toMatchObject({ status: "reverted", action: "restore", entryId: before.id });
		// K1's create is rolled back too.
		expect(done.counters).toMatchObject({ reverted: 2 });
		const after = entryOf(deps, "K9");
		expect(after).toMatchObject({
			trashed: false,
			status: "published",
			data: before.data,
			slug: before.slug,
		});
		expect(deps.content.calls.filter((c) => c === `restore:${before.id}`)).toHaveLength(1);
		expect(deps.content.calls.filter((c) => c === `publish:${before.id}`)).toHaveLength(2);
		const link = await linkOf(deps);
		expect(link).toMatchObject({
			jobId: earlier.id,
			owner: "shop",
			writtenRev: deps.content.revOf(after.id),
		});
		expect(link).not.toHaveProperty("missing");
	});

	it("restores a draft without publishing it", async () => {
		const { deps, job, before } = await trashed({ publish: false });
		deps.content.calls.length = 0;
		const { row } = await rollBack(deps, job);
		expect(row.status).toBe("reverted");
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "draft" });
		expect(deps.content.calls).toContain(`restore:${before.id}`);
		expect(deps.content.calls.filter((c) => c.startsWith("publish:"))).toHaveLength(0);
	});

	it("plans the restore in a dry run and changes nothing", async () => {
		const { deps, job } = await trashed();
		const { done, row } = await rollBack(deps, job, true);
		expect(row).toMatchObject({
			status: "planned",
			action: "restore",
			changes: [{ field: "status", before: "trashed", after: "published" }],
		});
		expect(done.counters).toMatchObject({ reverted: 2 });
		expect(entryOf(deps, "K9").trashed).toBe(true);
	});

	it("finds nothing to roll back when the trash never ran", async () => {
		const { deps, job } = await trashed({ act: false });
		deps.content.calls.length = 0;
		const { row } = await rollBack(deps, job);
		expect(row).toMatchObject({ status: "unchanged", action: "restore" });
		expect(row.warnings?.map((w) => w.code)).toEqual(["nothing_to_roll_back"]);
		expect(deps.content.calls.filter((c) => c.startsWith("restore:"))).toHaveLength(0);
	});

	it("refuses an active entry that moved since the journal row, though it was never trashed", async () => {
		// The rev moved: an editor's write after the pre-image.
		const edited = await trashed({ act: false });
		const id = edited.before.id;
		await edited.deps.content.update({
			id,
			rev: edited.deps.content.revOf(id),
			data: { price: 90 },
		});
		expect((await rollBack(edited.deps, edited.job)).row).toMatchObject({
			status: "conflict",
			errors: [CHANGED],
		});
		// The link moved: a later job's write at the same rev.
		const relinked = await trashed({ act: false });
		const link = await linkOf(relinked.deps);
		await relinked.deps.links.put(KEY, { ...link, jobId: "later" });
		expect((await rollBack(relinked.deps, relinked.job)).row).toMatchObject({
			status: "conflict",
			errors: [CHANGED],
		});
	});

	it("finds nothing to roll back when the entry is gone for good", async () => {
		const { deps, job, before } = await trashed();
		await deps.content.permanentDelete("products", before.id);
		const { row } = await rollBack(deps, job);
		expect(row).toMatchObject({ status: "unchanged", action: "restore" });
		expect(row.warnings?.map((w) => w.code)).toEqual(["nothing_to_roll_back"]);
	});

	it("refuses an entry restored, or changed and trashed again, since", async () => {
		for (const trashAgain of [false, true]) {
			const { deps, job, before } = await trashed();
			const id = before.id;
			expect((await restoreByHand(deps, id)).ok).toBe(true);
			if (trashAgain) {
				await deps.content.update({
					id,
					rev: deps.content.revOf(id),
					data: { price: 90 },
				});
				await deps.content.trash("products", id);
			}
			const { row } = await rollBack(deps, job);
			expect(row, String(trashAgain)).toMatchObject({ status: "conflict", errors: [CHANGED] });
		}
	});

	it("reports a taken translation slot and a lock", async () => {
		const slot = await trashed();
		const twin = { ...structuredClone(slot.before), id: "twin", trashed: false };
		slot.deps.content.entries.set("twin", twin);
		expect((await rollBack(slot.deps, slot.job)).row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_changed",
					message: "Not rolled back: the entry's translation slot is taken",
				},
			],
		});

		const locked = await trashed();
		locked.deps.content.locked.add(locked.before.id);
		expect((await rollBack(locked.deps, locked.job)).row).toMatchObject({
			status: "locked",
			errors: [{ code: "locked" }],
		});
		expect(entryOf(locked.deps, "K9").trashed).toBe(true);
	});

	it("fails a publish a plugin refused, and a retry publishes without a second restore", async () => {
		const { deps, job, before } = await trashed();
		deps.content.blockStep = (step) => (step === "publish" ? "No." : null);
		const { done, row } = await rollBack(deps, job);
		expect(row).toMatchObject({
			status: "failed",
			action: "restore",
			step: 8,
			errors: [
				{ code: "rollback_blocked", message: "Not rolled back: a plugin refused the publish: No." },
			],
		});
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "draft" });
		deps.content.blockStep = () => null;
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 2, failed: 0 });
		const again = (await records(deps, done.id)).find((r) => r.sourceKey === "K9");
		expect(again).toMatchObject({ status: "reverted", action: "restore" });
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "published" });
		expect(deps.content.calls.filter((c) => c === `restore:${before.id}`)).toHaveLength(1);
	});

	it("resumes after a stop once the restore landed, publishing without a second restore", async () => {
		const { deps, job, before } = await trashed();
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.afterStep = (step) => {
			if (step === "restore") throw new Error("stop");
		};
		await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
		deps.content.afterStep = () => {};
		const stopped = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, conflict: 0 });
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "published" });
		expect(deps.content.calls.filter((c) => c === `restore:${before.id}`)).toHaveLength(1);
		expect(deps.content.calls.filter((c) => c === `publish:${before.id}`)).toHaveLength(2);
	});

	it("resumes after a stop once the publish landed, without repeating either step", async () => {
		const { deps, job, before, earlier } = await trashed();
		const { rollback } = await createRollback(deps, { id: job.id });
		let publishes = 0;
		const real = deps.content.publish.bind(deps.content);
		deps.content.publish = async (input) => {
			const result = await real(input);
			if (result.ok && ++publishes === 1) throw new Error("stop");
			return result;
		};
		await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
		deps.content.publish = real;
		const stopped = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, conflict: 0 });
		expect(deps.content.calls.filter((c) => c === `restore:${before.id}`)).toHaveLength(1);
		expect(deps.content.calls.filter((c) => c === `publish:${before.id}`)).toHaveLength(2);
		expect(await linkOf(deps)).toMatchObject({
			jobId: earlier.id,
			writtenRev: deps.content.revOf(before.id),
		});
	});

	it("refuses to roll back the creating job before the job that trashed the entry (LIFO)", async () => {
		const { deps, creator, job } = await trashed();
		const first = await rollBack(deps, creator);
		expect(first.row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "K9").trashed).toBe(true);
		// In order: the trash job first, then a retry of the creating job's rollback deletes K9.
		expect((await rollBack(deps, job)).row.status).toBe("reverted");
		await transitionJob(deps, first.done.id, "retry");
		await runToEnd(deps, first.done.id);
		const [row] = await records(deps, first.done.id);
		expect(row).toMatchObject({ status: "reverted", action: "delete" });
		expect([...deps.content.entries.values()].some((e) => e.data.flux_source_id === "K9")).toBe(
			false,
		);
	});

	it("restores on a collection without revisions with a new live revision", async () => {
		const { deps, job, before } = await trashed({ plain: true });
		const id = before.id;
		expect((await rollBack(deps, job)).row.status).toBe("reverted");
		const restored = entryOf(deps, "K9");
		expect(restored).toMatchObject({ trashed: false, status: "published" });
		expect(restored.data.price).toBe(19);
		// EmDash keeps a plain collection's live revision from the first publish after an unpublish
		// (F18), so an unpublish shows the revision step 9 made, not the one from before the trash.
		await deps.content.update({
			id,
			rev: deps.content.revOf(id),
			data: { price: 30 },
		});
		expect((await deps.content.publish({ id, rev: deps.content.revOf(id) })).ok).toBe(true);
		const unpublished = await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id,
			rev: deps.content.revOf(id),
			step: "unpublish",
		});
		expect(unpublished.ok).toBe(true);
		const draft = await deps.content.get("products", "en", id);
		expect(draft?.data.price).toBe(19);
	});

	it("refuses an entry in Trash unless its link is the one the phase left", async () => {
		const cases: [string, TrashOptions][] = [
			["another entry", { relink: (l) => ({ ...l, entryId: "other" }) }],
			["a later job", { relink: (l) => ({ ...l, jobId: "later" }) }],
			["no mark", { relink: ({ missing: _m, ...l }) => l }],
			["another revision", { relink: (l) => ({ ...l, writtenRev: "other" }) }],
			["the link never marked", { act: "trash" }],
			["another pre-image", { journalRev: "other" }],
		];
		for (const [name, opts] of cases) {
			const { deps, job } = await trashed(opts);
			deps.content.calls.length = 0;
			const { row } = await rollBack(deps, job);
			expect(row, name).toMatchObject({ status: "conflict", errors: [CHANGED] });
			expect(entryOf(deps, "K9").trashed, name).toBe(true);
			expect(
				deps.content.calls.filter((c) => c.startsWith("restore:")),
				name,
			).toHaveLength(0);
		}
	});

	it("refuses an active entry whose link the phase marked, without sending a restore", async () => {
		const { deps, job } = await trashed({ act: "link" });
		let sent = 0;
		deps.content.beforeStep = (step) => {
			if (step === "restore") sent++;
		};
		const { row } = await rollBack(deps, job);
		expect(row).toMatchObject({ status: "conflict", errors: [CHANGED] });
		expect(row).not.toHaveProperty("step");
		expect(sent).toBe(0);
	});

	it("refuses an active entry whose link moved to another revision", async () => {
		const { deps, job } = await trashed({ act: false });
		await deps.links.put(KEY, { ...(await linkOf(deps)), writtenRev: "other" });
		expect((await rollBack(deps, job)).row).toMatchObject({
			status: "conflict",
			errors: [CHANGED],
		});
	});

	it("leaves a locked entry in a dry run too", async () => {
		const { deps, job, before } = await trashed();
		deps.content.locked.add(before.id);
		expect((await rollBack(deps, job, true)).row.status).toBe("locked");
	});

	it("hands back the owner's source and a mark the link had before the job", async () => {
		const mark = { jobId: "older", action: "unpublish" as const, at: "2026-10-01T00:00:00.000Z" };
		const { deps, job } = await trashed({ mark });
		expect((await rollBack(deps, job)).row.status).toBe("reverted");
		expect(await linkOf(deps)).toMatchObject({
			owner: "shop",
			ownerSource: "feed-1",
			missing: mark,
		});
	});

	describe("does not adopt a step sent before a stop once someone changed the entry", () => {
		/** Stops the rollback right after the restore landed, before its row was saved. */
		async function stopAfterRestore(opts: TrashOptions = {}) {
			const made = await trashed(opts);
			const { deps, job } = made;
			const { rollback } = await createRollback(deps, { id: job.id });
			deps.content.afterStep = (step) => {
				if (step === "restore") throw new Error("stop");
			};
			await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
			deps.content.afterStep = () => {};
			return { ...made, rollback };
		}
		async function resume(deps: Deps, id: string) {
			const stopped = (await deps.jobs.get(id)) as Job;
			await deps.jobs.put(id, { ...stopped, lease: null });
			await runToEnd(deps, id);
			return (await records(deps, id)).find((r) => r.sourceKey === "K9") as RecordRow;
		}

		it("an editor's update after the restore", async () => {
			const { deps, rollback, before } = await stopAfterRestore();
			const id = before.id;
			await deps.content.update({ id, rev: deps.content.revOf(id), data: { price: 90 } });
			expect(await resume(deps, rollback.id)).toMatchObject({
				status: "conflict",
				errors: [CHANGED],
			});
			expect(entryOf(deps, "K9").status).toBe("draft");
		});

		it("an editor's trash after the restore", async () => {
			const { deps, rollback, before } = await stopAfterRestore();
			await deps.content.trash("products", before.id);
			expect(await resume(deps, rollback.id)).toMatchObject({
				status: "conflict",
				errors: [CHANGED],
			});
		});

		it("an editor's trash and restore after the restore", async () => {
			const { deps, rollback, before } = await stopAfterRestore();
			await deps.content.trash("products", before.id);
			expect((await restoreByHand(deps, before.id)).ok).toBe(true);
			expect(await resume(deps, rollback.id)).toMatchObject({
				status: "conflict",
				errors: [CHANGED],
			});
			expect(entryOf(deps, "K9").status).toBe("draft");
		});

		it("an editor's update after a publish that never landed, without revisions", async () => {
			const { deps, job, before } = await trashed({ plain: true });
			const id = before.id;
			const { rollback } = await createRollback(deps, { id: job.id });
			deps.content.beforeStep = (step) => {
				if (step === "publish") throw new Error("stop");
			};
			await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
			deps.content.beforeStep = () => {};
			await deps.content.update({ id, rev: deps.content.revOf(id), data: { price: 90 } });
			expect(await resume(deps, rollback.id)).toMatchObject({
				status: "conflict",
				errors: [CHANGED],
			});
			expect(entryOf(deps, "K9").status).toBe("draft");
		});
	});
});
