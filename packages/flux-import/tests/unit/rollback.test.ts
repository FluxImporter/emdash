import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import type { LinkWrites } from "../../src/engine/ports.js";
import { createRollback } from "../../src/engine/rollback.js";
import { sameStored } from "../../src/engine/rollback-values.js";
import { type Job, journalKey, linkKey, recordKey } from "../../src/engine/types.js";
import { type Deps, entryOf, importRows, records, runToEnd, setup } from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, featured: true, tags: "new", authors: "alex" };
const changed = {
	...desk,
	name: "Table",
	price: 12,
	featured: false,
	tags: "sale",
	authors: "sam",
};
const linkOf = (deps: Deps, key: string) => deps.links.get(linkKey("products", "en", key));

/** What a rollback restores: status, schedule, slug, data, draft and links (empty links absent). */
function stateOf(deps: Deps, key: string) {
	const e = entryOf(deps, key);
	const links = (m: Record<string, string[]>) =>
		Object.fromEntries(Object.entries(m).filter(([, v]) => v.length > 0));
	return structuredClone({
		status: e.status,
		scheduledAt: e.scheduledAt,
		slug: e.slug,
		data: e.data,
		live: e.live,
		taxonomies: links(e.taxonomies),
		references: links(e.references),
		bylines: e.bylines,
	});
}

type State = ReturnType<typeof stateOf>;

/** Equal under the rollback's comparison (spec M5a V1). */
function expectRestored(after: State, before: State) {
	const { data: a, live: al, ...restA } = after;
	const { data: b, live: bl, ...restB } = before;
	expect(restA).toEqual(restB);
	expect(sameStored(a, b)).toBe(true);
	expect(sameStored(al, bl)).toBe(true);
}

async function rollBack(
	deps: Deps,
	id: string,
	opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { rollback } = await createRollback(deps, { id, ...opts });
	return runToEnd(deps, rollback.id);
}

/** Runs batches until one fails with `message`, then clears the lease as a takeover would. */
async function crash(deps: Deps, id: string, message: string) {
	await expect(runBatch(deps, id, "driver")).rejects.toThrow(message);
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, lease: null });
}

const CHANGED =
	"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand";

const count = (deps: Deps, call: string) => deps.content.calls.filter((c) => c === call).length;

describe("rolling back an import (M5a)", () => {
	it("deletes the entries the job created and restores the ones it changed, newest first", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
		expect(job.counters).toMatchObject({ created: 1, updated: 1 });
		const lamp = entryOf(deps, "A2").id;
		const done = await rollBack(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { reverted: 2, conflict: 0 } });
		expect(deps.content.entries.has(lamp)).toBe(false);
		expectRestored(stateOf(deps, "A1"), before);
		const rows = await records(deps, done.id);
		// Newest first: the record of A2 (seq 1) before A1 (seq 0).
		expect(rows.map((r) => [r.seq, r.status, r.action])).toEqual([
			[0, "reverted", "revert"],
			[1, "reverted", "delete"],
		]);
		expect(deps.content.calls.filter((c) => /^(trash|delete):/.test(c))).toEqual([
			`trash:${lamp}`,
			`delete:${lamp}`,
		]);
		expect(await linkOf(deps, "A2")).toBeNull();
		// The link is handed back to the job before, at the rollback's revision.
		expect(await linkOf(deps, "A1")).toMatchObject({
			jobId: (await deps.jobs.query({ where: {} })).items[0]?.id,
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
		// The same feed imports again.
		const again = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
		expect(again.counters).toMatchObject({ created: 1, updated: 1, failed: 0, conflict: 0 });
	});

	it("restores an entry that was a draft before the run published it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const before = stateOf(deps, "A1");
		expect(before).toMatchObject({ status: "draft", live: null });
		const job = await importRows(deps, [changed]);
		expect(entryOf(deps, "A1").status).toBe("published");
		const id = entryOf(deps, "A1").id;
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		// Publish the restored values, unpublish, discard the draft the unpublish created (F18).
		expect(deps.content.calls.slice(-4)).toEqual([
			`update:${id}`,
			`publish:${id}`,
			`unpublish:${id}`,
			`discard:${id}`,
		]);
	});

	it("restores the importer's pending draft under the live values it published", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		const before = stateOf(deps, "A1");
		expect(before.live).toMatchObject({ data: { price: 10 } });
		const job = await importRows(deps, [changed]);
		expect(entryOf(deps, "A1").live).toBeNull();
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A1"), before);
		// The restored draft is the importer's again: the next publishing run publishes it.
		const next = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(next.counters).toMatchObject({ updated: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({ live: null, data: { price: 20 } });
	});

	it("schedules a scheduled draft again, or leaves it a draft when the time has passed", async () => {
		for (const passed of [false, true]) {
			const { deps, clock } = setup();
			await importRows(deps, [desk], { publish: false });
			const e = entryOf(deps, "A1");
			const at = new Date(clock.t + 60_000).toISOString();
			await deps.content.revertStep({
				collection: "products",
				locale: "en",
				id: e.id,
				rev: deps.content.revOf(e.id),
				step: "schedule",
				scheduledAt: at,
			});
			// As a scheduling import (M5b) would leave it: the importer's revision on the link.
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: deps.content.revOf(e.id),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
			expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
			if (passed) clock.t += 120_000;
			const done = await rollBack(deps, job.id);
			const [row] = await records(deps, done.id);
			if (passed) {
				expect(stateOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
				expect(row?.warnings).toEqual([
					{
						code: "rollback_schedule_passed",
						message: `The entry was scheduled for ${at}, which has passed; it is left as a draft`,
					},
				]);
			} else {
				expectRestored(stateOf(deps, "A1"), before);
				expect(row).not.toHaveProperty("warnings");
			}
		}
	});

	it("restores entries of a collection without revisions, discarding the stale draft", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk], { publish: false });
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1").live).toBeNull();
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		expect(deps.content.calls.slice(-3)).toEqual([
			`update:${id}`,
			`unpublish:${id}`,
			`discard:${id}`,
		]);
	});

	it("restores an entry whose only change was its references, which staged a draft (F17)", async () => {
		const { deps } = setup();
		await importRows(deps, [
			{ sku: "A1", name: "Desk" },
			{ sku: "A2", name: "Lamp", related: "A1" },
			{ sku: "A3", name: "Shelf" },
		]);
		const before = stateOf(deps, "A2");
		const job = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		expect(job.counters).toMatchObject({ updated: 1 });
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).toMatchObject({
			live: {},
			links: { references: { related: [entryOf(deps, "A1").id] } },
		});
		expect(journal?.data.before).not.toHaveProperty("slug");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A2"), before);
		// An editor's change after a references-only import is still caught.
		const second = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		const e = entryOf(deps, "A2");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			references: { related: [] },
		});
		const refused = await rollBack(deps, second.id);
		expect(refused.counters).toMatchObject({ conflict: 1, reverted: 0 });
	});
});

describe("ownership (M5a)", () => {
	it("leaves an entry an editor changed after the job, and reports it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const after = stateOf(deps, "A1");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			action: "revert",
			errors: [
				{
					code: "rollback_changed",
					message:
						"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand",
				},
			],
		});
		expect(stateOf(deps, "A1")).toEqual(after);
	});

	it("rolls back later jobs first: newest first restores, oldest first conflicts", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const initial = stateOf(deps, "A1");
		const b = await importRows(deps, [changed]);
		const afterB = stateOf(deps, "A1");
		const c = await importRows(deps, [{ ...changed, price: 99 }]);
		// Oldest first: B's write is no longer the last.
		const early = await rollBack(deps, b.id, { dryRun: true });
		expect(early.counters).toMatchObject({ conflict: 1 });
		await rollBack(deps, c.id);
		expectRestored(stateOf(deps, "A1"), afterB);
		await rollBack(deps, b.id);
		expectRestored(stateOf(deps, "A1"), initial);
	});

	it("leaves an update row the job never wrote, and a create it never made", async () => {
		const { deps, clock } = setup();
		const first = await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		await rollBack(deps, job.id);
		// A journal row whose write never happened (a crash right after the write-ahead put).
		const e = entryOf(deps, "A1");
		const link = await linkOf(deps, "A1");
		clock.t += 1000;
		const ghost = await importRows(deps, [desk]);
		expect(ghost.counters).toMatchObject({ unchanged: 1 });
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "A1")), {
			jobId: ghost.id,
			seq: 0,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: e.id,
			before: { link: { ...link }, status: "published", scheduledAt: null, live: { price: 1 } },
			at: new Date(clock.t).toISOString(),
		});
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "Z9")), {
			jobId: ghost.id,
			seq: 1,
			collection: "products",
			locale: "en",
			sourceKey: "Z9",
			kind: "create",
			entryId: null,
			sourceIdValue: "Z9",
			at: new Date(clock.t).toISOString(),
		});
		const done = await rollBack(deps, ghost.id);
		expect(done.counters).toMatchObject({ unchanged: 2, reverted: 0 });
		const rows = await records(deps, done.id);
		expect(rows.map((r) => r.warnings?.[0]?.message)).toEqual([
			"Nothing to roll back: the import never wrote this entry",
			"Nothing to roll back: the entry was never created, or was deleted since",
		]);
		expect(entryOf(deps, "A1").data.price).toBe(10);
		expect(first.id).toBeDefined();
	});

	it("leaves an update row the job never wrote when only the timestamps tell", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		const link = await linkOf(deps, "A1");
		// An editor changes the entry, then a job's write-ahead put happens and its write does not.
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		clock.t += 1000;
		// The job of the ghost row; it writes another entry, so A1's link stays as it was.
		const ghost = await importRows(deps, [{ sku: "Z1", name: "Other" }]);
		expect(await linkOf(deps, "A1")).toEqual(link);
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "A1")), {
			jobId: ghost.id,
			seq: 1,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: e.id,
			before: {
				link: { jobId: link!.jobId!, writtenRev: link!.writtenRev! },
				status: "published",
				scheduledAt: null,
				live: {},
			},
			at: new Date(clock.t).toISOString(),
		});
		const done = await rollBack(deps, ghost.id);
		const row = (await records(deps, done.id)).find((r) => r.sourceKey === "A1");
		expect(row).toMatchObject({
			status: "unchanged",
			warnings: [{ code: "nothing_to_roll_back" }],
		});
		expect(entryOf(deps, "A1").data.title).toBe("Editor");
	});

	it("finds a create whose write-ahead row has no entry, and only moves it to Trash", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		const { confirmed: _, ...unconfirmed } = row!;
		await deps.journal.put(key, { ...unconfirmed, entryId: null });
		await deps.links.delete(linkKey("products", "en", "A1"));
		const entry = deps.content.entries.get(entryOf(deps, "A1").id)!;
		// Changed after its creation: not taken.
		const created = entry.createdAt;
		entry.updatedAt = new Date(Date.parse(created!) + 1000).toISOString();
		const refused = await rollBack(deps, job.id, { dryRun: true });
		expect(refused.counters).toMatchObject({ unchanged: 1 });
		entry.updatedAt = created;
		const done = await rollBack(deps, job.id);
		const [rolled] = await records(deps, done.id);
		expect(rolled).toMatchObject({
			status: "reverted",
			action: "trash",
			entryId: entry.id,
			warnings: [{ code: "rollback_trashed" }],
		});
		expect(entry.trashed).toBe(true);
	});

	it("only moves an entry crash repair found to Trash", async () => {
		const { deps } = setup();
		const { start, csv } = await import("./rollback-fixture.js");
		const job = await start(deps, csv([desk]));
		let once = true;
		deps.content.afterWrite = () => {
			if (once) {
				once = false;
				throw new Error("crash after the create");
			}
		};
		await crash(deps, job.id, "crash after the create");
		await runToEnd(deps, job.id);
		const id = entryOf(deps, "A1").id;
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			action: "trash",
			warnings: [
				{
					code: "rollback_trashed",
					message:
						"Moved to Trash, not deleted: the import found this entry by crash repair, so it may not have created it",
				},
			],
		});
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
	});

	it("keeps a created entry whose translations are still active", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const source = entryOf(deps, "A1");
		const fr = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau" },
			translationOf: source.id,
		});
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_has_translations",
					message:
						"Not rolled back: the entry has translations that are still active; roll back the jobs of its translations first",
				},
			],
		});
		expect(deps.content.entries.has(source.id)).toBe(true);
		// Once the translation is gone, a retry deletes it.
		await deps.content.trash("products", fr.id);
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(deps.content.entries.has(source.id)).toBe(false);
	});

	it("leaves a locked entry for a retry", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		deps.content.locked.add(entryOf(deps, "A1").id);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ locked: 1 });
		deps.content.locked.clear();
		await transitionJob(deps, done.id, "retry");
		expect((await runToEnd(deps, done.id)).counters).toMatchObject({ reverted: 1, locked: 0 });
	});
});

describe("resuming a rollback (M5a)", () => {
	it("finishes a delete that stopped between Trash and the permanent delete", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const id = entryOf(deps, "A1").id;
		const { rollback } = await createRollback(deps, { id: job.id });
		let once = true;
		deps.content.beforeStep = (step) => {
			if (step === "delete" && once) {
				once = false;
				throw new Error("crash before the delete");
			}
		};
		await crash(deps, rollback.id, "crash before the delete");
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
		expect(await deps.records.get(recordKey(rollback.id, 0))).toMatchObject({
			status: "writing",
			action: "delete",
			step: 1,
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expect(deps.content.entries.has(id)).toBe(false);
		expect(count(deps, `trash:${id}`)).toBe(1);
	});

	it("continues a revert sequence after a crash at every step, without repeating a step", async () => {
		for (const at of ["update", "publish", "unpublish", "discard", "schedule"] as const) {
			const { deps, clock } = setup();
			await importRows(deps, [desk], { publish: false });
			const e = entryOf(deps, "A1");
			await deps.content.revertStep({
				collection: "products",
				locale: "en",
				id: e.id,
				rev: deps.content.revOf(e.id),
				step: "schedule",
				scheduledAt: new Date(clock.t + 60_000).toISOString(),
			});
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: deps.content.revOf(e.id),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
			const { rollback } = await createRollback(deps, { id: job.id });
			let armed = true;
			let seen = 0;
			deps.content.beforeStep = (step) => {
				if (step !== at) return;
				seen++;
				// The second update (the draft) is step 5; this sequence has none.
				if (armed) {
					armed = false;
					throw new Error(`crash at ${at}`);
				}
			};
			await crash(deps, rollback.id, `crash at ${at}`);
			const done = await runToEnd(deps, rollback.id);
			expect(done.counters).toMatchObject({ reverted: 1 });
			expectRestored(stateOf(deps, "A1"), before);
			// Each step ran once after the crash (the crashed attempt never reached EmDash).
			expect(seen).toBe(2);
		}
	});

	it("skips a row a crashed batch finished but did not count", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk, { sku: "A2", name: "Lamp" }]);
		const { rollback } = await createRollback(deps, { id: job.id, batchSize: 1 });
		await runBatch(deps, rollback.id, "driver");
		const stored = (await deps.jobs.get(rollback.id)) as Job;
		// The batch's cursor and counters were lost.
		await deps.jobs.put(rollback.id, {
			...stored,
			cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
			counters: { ...stored.counters, reverted: 0 },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2 });
	});
});

describe("refusals and warnings during a rollback (M5a)", () => {
	it("fails a row a plugin hook refused, and continues from the saved step on retry", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		deps.content.blockStep = (step) => (step === "publish" ? "Publishing is frozen" : null);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "failed",
			action: "revert",
			step: 1,
			errors: [
				{
					code: "rollback_blocked",
					message: "Not rolled back: a plugin refused the publish: Publishing is frozen",
				},
			],
		});
		const updates = count(deps, `update:${id}`);
		deps.content.blockStep = () => null;
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 1, failed: 0 });
		expect(count(deps, `update:${id}`)).toBe(updates);
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("fails a delete a content:beforeDelete hook refused", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		deps.content.blockDelete = () => "Delete blocked by plugin hook";
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "failed",
			action: "delete",
			errors: [
				{
					code: "rollback_blocked",
					message: "Not rolled back: a plugin refused the delete: Delete blocked by plugin hook",
				},
			],
		});
	});

	it("leaves out a term that no longer exists, with a warning", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const index = deps.lookups.storedTerms.findIndex((t) => t.slug === "new");
		const [gone] = deps.lookups.storedTerms.splice(index, 1);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			warnings: [
				{
					field: "taxonomies.tag",
					code: "rollback_link_missing",
					message: `Left out: the term ${gone?.group} no longer exists, so the entry does not get it back`,
				},
			],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual([]);
	});

	it("reports a journal row of a kind this version does not know", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		await deps.journal.put(key, { ...row!, kind: "trash" as never });
		const done = await rollBack(deps, job.id);
		const [rolled] = await records(deps, done.id);
		expect(rolled).toMatchObject({ status: "failed", errors: [{ code: "journal_kind_unknown" }] });
	});

	it("leaves an entry an editor locked between two steps, and continues from the saved step", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		// The lock is taken after step 1 (the update), before step 2 (the publish).
		deps.content.beforeStep = (step) => {
			if (step === "publish") deps.content.locked.add(id);
		};
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ locked: 1, failed: 0, reverted: 0 });
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "locked",
			action: "revert",
			step: 1,
			errors: [{ code: "locked", message: "Not rolled back: the entry is being edited (locked)" }],
		});
		const updates = count(deps, `update:${id}`);
		deps.content.beforeStep = () => {};
		deps.content.locked.clear();
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 1, locked: 0 });
		expect(count(deps, `update:${id}`)).toBe(updates);
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("warns that references staged in a draft before the job are not restored", async () => {
		const { deps } = setup();
		const lamp = { sku: "A2", name: "Lamp", price: 5, related: "A1" };
		await importRows(deps, [desk, lamp]);
		await importRows(deps, [{ ...lamp, price: 6 }], { publish: false });
		const before = stateOf(deps, "A2");
		// Publishes the importer's own draft, whose live selection the read cannot see.
		const job = await importRows(deps, [{ ...lamp, price: 6 }]);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).toMatchObject({ referencesUnknown: true });
		const planned = await rollBack(deps, job.id, { dryRun: true });
		expect((await records(deps, planned.id))[0]?.warnings).toEqual([
			{
				code: "references_not_restored",
				message: "References staged in a draft before this job could not be restored",
			},
		]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			warnings: [
				{
					code: "references_not_restored",
					message: "References staged in a draft before this job could not be restored",
				},
			],
		});
		expectRestored(stateOf(deps, "A2"), before);
	});

	it("fails a row that would empty a required field, naming the field, and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [{ sku: "A1", name: "Desk" }]);
		const job = await importRows(deps, [{ sku: "A1", name: "Desk", price: 12 }]);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before?.live).toEqual({ price: null });
		// The field is required in the job's snapshot, which the rollback job copies.
		const stored = (await deps.jobs.get(job.id)) as Job;
		await deps.jobs.put(job.id, {
			...stored,
			targetFields: { ...stored.targetFields, price: { type: "number", required: true } },
		});
		const after = stateOf(deps, "A1");
		const calls = deps.content.calls.length;
		const error = {
			field: "price",
			code: "required",
			message:
				"Not rolled back: the field was empty before the import, and the collection requires it, so EmDash would refuse the restored value",
		};
		const planned = await rollBack(deps, job.id, { dryRun: true });
		expect(planned.counters).toMatchObject({ failed: 1, reverted: 0 });
		expect((await records(deps, planned.id))[0]?.errors).toEqual([error]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ failed: 1, reverted: 0 });
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "failed", action: "revert", errors: [error] });
		expect(row).not.toHaveProperty("step");
		expect(stateOf(deps, "A1")).toEqual(after);
		expect(
			deps.content.calls
				.slice(calls)
				.filter((c) => /^(update|publish|unpublish|discard|schedule):/.test(c)),
		).toEqual([]);
	});
});

describe("dry-run rollback (M5a)", () => {
	it("plans every row as a real rollback would and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp" }]);
		const calls = deps.content.calls.length;
		const links = structuredClone([...deps.links.rows.values()].map((r) => r.value));
		const done = await rollBack(deps, job.id, { dryRun: true });
		expect(done).toMatchObject({ status: "completed", counters: { reverted: 2 } });
		const rows = await records(deps, done.id);
		expect(rows.map((r) => [r.status, r.action])).toEqual([
			["planned", "revert"],
			["planned", "delete"],
		]);
		expect(rows[0]?.changes).toEqual([
			{ field: "slug", before: "table", after: "desk" },
			{ field: "title", before: "Table", after: "Desk" },
			{ field: "price", before: 12, after: 10 },
			{ field: "featured", before: false, after: true },
			{ field: "taxonomies.tag", before: ["sale"], after: ["new"] },
			{
				field: "bylines",
				before: [deps.lookups.storedBylines[1]?.id],
				after: [deps.lookups.storedBylines[0]?.id],
			},
		]);
		expect(deps.content.calls.slice(calls).filter((c) => !c.startsWith("translations:"))).toEqual(
			[],
		);
		expect([...deps.links.rows.values()].map((r) => r.value)).toEqual(links);
		expect(await deps.jobs.get(job.id)).not.toHaveProperty("rolledBackBy");
		// A real rollback afterwards does what the dry run planned.
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 2 });
	});
});

/** Makes the imported draft A1 scheduled, as a scheduling import (M5b) would leave it. */
async function scheduleDraft(deps: Deps, at: string) {
	const e = entryOf(deps, "A1");
	await deps.content.revertStep({
		collection: "products",
		locale: "en",
		id: e.id,
		rev: deps.content.revOf(e.id),
		step: "schedule",
		scheduledAt: at,
	});
	const link = await linkOf(deps, "A1");
	await deps.links.put(linkKey("products", "en", "A1"), {
		...link!,
		writtenRev: deps.content.revOf(e.id),
	});
}

type Shape = { name: string; plain: boolean; prepare: (deps: Deps, t: number) => Promise<void> };

/** Pre-run states whose revert sequences between them send every step. */
const shapes: Shape[] = [
	{
		name: "a scheduled draft (update, publish, unpublish, discard, schedule)",
		plain: false,
		prepare: async (deps, t) => {
			await importRows(deps, [desk], { publish: false });
			await scheduleDraft(deps, new Date(t + 60_000).toISOString());
		},
	},
	{
		name: "a scheduled draft without revisions (update, unpublish, discard, schedule)",
		plain: true,
		prepare: async (deps, t) => {
			await importRows(deps, [desk], { publish: false });
			await scheduleDraft(deps, new Date(t + 60_000).toISOString());
		},
	},
	{
		name: "the importer's pending draft (update, publish, update)",
		plain: false,
		prepare: async (deps) => {
			await importRows(deps, [desk]);
			await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		},
	},
];

describe("ownership by revision, not timestamps (M5a)", () => {
	it("leaves a created entry an editor edited in a draft, which keeps updatedAt (EmDash)", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor's work" },
		});
		// As EmDash 1.2.0: staging a draft leaves updated_at alone.
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			action: "delete",
			errors: [{ code: "rollback_changed", message: CHANGED }],
		});
		expect(deps.content.entries.get(e.id)?.trashed).toBe(false);
	});

	it("keeps a created entry made before its journal row when its link is gone", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		const e = entryOf(deps, "A1");
		await deps.links.delete(linkKey("products", "en", "A1"));
		await deps.journal.put(key, {
			...row!,
			at: new Date(Date.parse(e.createdAt) + 1000).toISOString(),
		});
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(deps.content.entries.get(e.id)?.trashed).toBe(false);
	});

	it("does not take an edit of the job's own draft for a write it never made", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		clock.t += 1000;
		// The job stages a draft, which leaves updatedAt before its journal row's time.
		const job = await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor", price: 12 });
	});

	it("hands the link back unchanged when an editor changed the entry between two jobs", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const a = await importRows(deps, [{ ...desk, price: 11 }]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor title" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const writtenByA = (await linkOf(deps, "A1"))?.writtenRev;
		expect((await rollBack(deps, a.id, { dryRun: true })).counters).toMatchObject({ conflict: 1 });
		const b = await importRows(deps, [{ ...desk, price: 12 }]);
		expect((await rollBack(deps, b.id)).counters).toMatchObject({ reverted: 1 });
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor title", price: 11 });
		expect(await linkOf(deps, "A1")).toMatchObject({ jobId: a.id, writtenRev: writtenByA });
		// A's rollback would undo the editor's title: it is refused.
		const ra = await rollBack(deps, a.id);
		const [row] = await records(deps, ra.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor title", price: 11 });
	});

	it("leaves a created entry an editor edited on a collection without revisions", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
	});

	it("only moves its own create to Trash when its link was never saved", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], { publish: false });
		// A crash before the link save, never resumed; then an editor stages a draft.
		await deps.links.delete(linkKey("products", "en", "A1"));
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			action: "trash",
			warnings: [
				{
					code: "rollback_trashed",
					message:
						"Moved to Trash, not deleted: the import never saved its link to this entry, so a later edit cannot be ruled out",
				},
			],
		});
		expect(deps.content.entries.get(e.id)).toMatchObject({ trashed: true });
	});

	it("checks the lock of a created entry before moving it to Trash", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		deps.content.locked.add(e.id);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "locked", action: "delete", errors: [{ code: "locked" }] });
		expect(e.trashed).toBe(false);
	});
});

describe("a crash after a step reached EmDash (M5a)", () => {
	for (const shape of shapes) {
		it(`continues without repeating the step: ${shape.name}`, async () => {
			// A clean run first, for the number of steps.
			const clean = setup();
			if (shape.plain) clean.deps.content.plainCollections.add("products");
			await shape.prepare(clean.deps, clean.clock.t);
			const cleanJob = await importRows(clean.deps, [changed]);
			let steps = 0;
			clean.deps.content.afterStep = () => {
				steps++;
			};
			await rollBack(clean.deps, cleanJob.id);
			expect(steps).toBeGreaterThanOrEqual(3);
			for (let k = 1; k <= steps; k++) {
				const { deps, clock } = setup();
				if (shape.plain) deps.content.plainCollections.add("products");
				await shape.prepare(deps, clock.t);
				const before = stateOf(deps, "A1");
				const job = await importRows(deps, [changed]);
				const { rollback } = await createRollback(deps, { id: job.id });
				let sent = 0;
				deps.content.beforeStep = (step) => {
					if (step !== "trash" && step !== "delete") sent++;
				};
				let reachedSteps = 0;
				deps.content.afterStep = (step) => {
					if (++reachedSteps === k) throw new Error(`killed after ${step}`);
				};
				await crash(deps, rollback.id, "killed after");
				const stopped = await deps.records.get(recordKey(rollback.id, 0));
				expect(stopped).toMatchObject({ status: "writing", pendingStep: expect.any(Number) });
				const done = await runToEnd(deps, rollback.id);
				const [row] = await records(deps, done.id);
				expect(row, `crash after step call ${k}`).toMatchObject({ status: "reverted" });
				expect(row).not.toHaveProperty("pendingStep");
				expectRestored(stateOf(deps, "A1"), before);
				expect(sent, `crash after step call ${k}`).toBe(steps);
			}
		});
	}

	it("refuses an entry an editor changed after the crash", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.afterStep = (step) => {
			if (step === "update") throw new Error("killed after update");
		};
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "A1").data.title).toBe("Editor");
	});

	it("refuses an entry an editor changed after a crash before the step reached EmDash", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "update") throw new Error("crash before update");
		};
		await crash(deps, rollback.id, "crash before update");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.title).toBe("Editor");
	});

	it("refuses an editor's draft staged on a published entry after a stop before the publish", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("crash before publish");
		};
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		// Published with a draft, as step 1 left it, but at the editor's revision.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { price: 77 } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.price).toBe(77);
	});

	it("resumes a row stopped after its link was handed back, before the row was saved", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		const key = linkKey("products", "en", "A1");
		const put = deps.links.put.bind(deps.links);
		let once = true;
		deps.links.put = async (id, value) => {
			await put(id, value);
			if (id === key && once) {
				once = false;
				throw new Error("killed after the link put");
			}
		};
		await crash(deps, rollback.id, "killed after the link put");
		const stopped = await deps.records.get(recordKey(rollback.id, 0));
		expect(stopped).toMatchObject({
			status: "writing",
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
		expect(stopped).not.toHaveProperty("pendingStep");
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "reverted" });
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("refuses an editor's published change after a stop before the publish applied", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("killed before the publish applied");
		};
		await crash(deps, rollback.id, "killed before the publish applied");
		deps.content.beforeStep = () => {};
		// Published without a draft, as step 2 would leave it, but with the editor's title.
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", data: { title: "Editor" } });
	});

	it("refuses a stop whose restored terms an editor changed since", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.afterStep = (step) => {
			if (step === "update") throw new Error("killed after update");
		};
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			taxonomies: { tag: ["sale"] },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
	});

	it("refuses a stop after the draft step whose draft an editor changed since", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		let updates = 0;
		deps.content.beforeStep = (step) => {
			if (step === "update" && ++updates === 2) throw new Error("crash before the draft");
		};
		await crash(deps, rollback.id, "crash before the draft");
		deps.content.beforeStep = () => {};
		// Published with the restored live values, but the editor's draft instead of the importer's.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { price: 55 } });
		expect(await deps.records.get(recordKey(rollback.id, 0))).toMatchObject({ pendingStep: 5 });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.price).toBe(55);
	});

	it("refuses a stop whose entry an editor published and then gave a new draft", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("crash before publish");
		};
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		// The editor publishes step 1's values, then stages a draft of a field the import never wrote.
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { notes: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
	});

	it("refuses a stop whose entry an editor published under another slug", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("crash before publish");
		};
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), slug: "editors-desk" });
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").slug).toBe("editors-desk");
	});

	for (const [what, edit] of [
		["references", { references: { related: [] } }],
		["bylines", { bylines: [] }],
	] as [string, LinkWrites][]) {
		it(`refuses a stop after the update whose ${what} an editor changed since`, async () => {
			const { deps } = setup();
			const others = [
				{ sku: "A2", name: "Lamp" },
				{ sku: "A3", name: "Shelf" },
			];
			await importRows(deps, [...others, { ...desk, related: "A2" }]);
			const job = await importRows(deps, [...others, { ...changed, related: "A3" }]);
			expect(job.counters).toMatchObject({ updated: 1, unchanged: 2 });
			const { rollback } = await createRollback(deps, { id: job.id });
			deps.content.afterStep = (step) => {
				if (step === "update") throw new Error("killed after update");
			};
			await crash(deps, rollback.id, "killed after update");
			deps.content.afterStep = () => {};
			const e = entryOf(deps, "A1");
			await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), ...edit });
			const done = await runToEnd(deps, rollback.id);
			const row = (await records(deps, done.id)).find((r) => r.entryId === e.id);
			expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		});
	}

	it("finishes a permanent delete that went through before the row was saved", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const id = entryOf(deps, "A1").id;
		const original = deps.content.permanentDelete.bind(deps.content);
		let once = true;
		deps.content.permanentDelete = async (collection, entryId) => {
			const deleted = await original(collection, entryId);
			if (once) {
				once = false;
				throw new Error("killed after the delete");
			}
			return deleted;
		};
		const { rollback } = await createRollback(deps, { id: job.id });
		await crash(deps, rollback.id, "killed after the delete");
		expect(deps.content.entries.has(id)).toBe(false);
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "reverted", action: "delete", entryId: id });
		expect(await linkOf(deps, "A1")).toBeNull();
	});

	it("finds an adopted create again after a crash during its trash", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const { confirmed: _, ...unconfirmed } = (await deps.journal.get(key))!;
		await deps.journal.put(key, { ...unconfirmed, entryId: null });
		await deps.links.delete(linkKey("products", "en", "A1"));
		const id = entryOf(deps, "A1").id;
		const original = deps.content.trash.bind(deps.content);
		let once = true;
		deps.content.trash = async (collection, entryId) => {
			const trashed = await original(collection, entryId);
			if (once) {
				once = false;
				throw new Error("killed during the trash");
			}
			return trashed;
		};
		const { rollback } = await createRollback(deps, { id: job.id });
		await crash(deps, rollback.id, "killed during the trash");
		// In Trash, so a lookup by source ID no longer finds it: the saved row names it.
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "reverted", action: "trash", entryId: id });
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
	});

	it("keeps the link warnings of a step 1 done before a stop", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const index = deps.lookups.storedTerms.findIndex((t) => t.slug === "new");
		const [gone] = deps.lookups.storedTerms.splice(index, 1);
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("crash before publish");
		};
		const { rollback } = await createRollback(deps, { id: job.id });
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		// The term is back: the restored update left it out, and the row still says so.
		deps.lookups.storedTerms.push(gone!);
		const calls = deps.lookups.calls.length;
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			warnings: [{ code: "rollback_link_missing", field: "taxonomies.tag" }],
		});
		expect(deps.lookups.calls.slice(calls).filter((c) => c.startsWith("terms:"))).toEqual([]);
	});
});

describe("revert steps that are not needed (M5a)", () => {
	it("restores the draft of a never-published entry without discarding the unpublish's draft", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		const before = stateOf(deps, "A1");
		expect(before).toMatchObject({
			status: "draft",
			live: { data: { price: 10 } },
			data: { price: 20 },
		});
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		const calls = deps.content.calls.length;
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		expect(deps.content.calls.slice(calls).filter((c) => !/^(find|translations):/.test(c))).toEqual(
			[`update:${id}`, `publish:${id}`, `unpublish:${id}`, `update:${id}`],
		);
	});

	it("does not schedule an entry again that still has its schedule", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk], { publish: false });
		await scheduleDraft(deps, new Date(clock.t + 60_000).toISOString());
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed], { publish: false });
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled" });
		const calls = deps.content.calls.length;
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		expect(deps.content.calls.slice(calls).filter((c) => !/^(find|translations):/.test(c))).toEqual(
			[`update:${id}`, `discard:${id}`],
		);
	});

	it("keeps the counters right while a retry is still running", async () => {
		const { deps } = setup();
		await importRows(deps, [desk, { sku: "A2", name: "Lamp" }]);
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp", price: 3 }]);
		deps.content.blockStep = (step) => (step === "publish" ? "Publishing is frozen" : null);
		const { rollback } = await createRollback(deps, { id: job.id, batchSize: 1 });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ failed: 2, reverted: 0 });
		deps.content.blockStep = () => null;
		await transitionJob(deps, done.id, "retry");
		const first = await runBatch(deps, done.id, "driver");
		expect(first).toMatchObject({ status: "running", counters: { failed: 1, reverted: 1 } });
		expect((await runToEnd(deps, done.id)).counters).toMatchObject({ failed: 0, reverted: 2 });
	});
});

/** `setup()` with a clock that moves 3 ms on every read, as a real one does between calls. */
function tickingSetup() {
	const made = setup();
	let t = made.clock.t;
	Object.defineProperty(made.clock, "t", {
		get: () => {
			t += 3;
			return t;
		},
		set: (v: number) => {
			t = v;
		},
	});
	return made;
}

const liveOf = (deps: Deps, key: string) => {
	const e = entryOf(deps, key);
	return e.live?.data ?? e.data;
};

describe("final review: drafts, stops and edits the revision does not show (M5a)", () => {
	it("keeps the importer's earlier draft unpublished when a publish: false job over it is rolled back", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, name: "Desk v2" }], { publish: false });
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [{ ...desk, name: "Desk v2", price: 12 }], {
			publish: false,
		});
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		// The draft's other field is journalled although the job does not publish.
		expect(journal?.data.before).toMatchObject({
			live: { title: "Desk", price: 10 },
			draft: { title: "Desk v2", price: 10 },
		});
		await rollBack(deps, job.id);
		expect(liveOf(deps, "A1").title).toBe("Desk");
		const after = stateOf(deps, "A1");
		expect(after.live?.slug).toBe("desk");
		expect(sameStored(after.live?.data, before.live?.data)).toBe(true);
		expect(sameStored(after.data, before.data)).toBe(true);
		// The draft's staged slug is not in the pre-image (spec F5, open issues).
		expect(after.slug).toBe("desk");
	});

	it("reports an out-of-order rollback of draft-only jobs, and rolls it back after the later one", async () => {
		for (const make of [setup, tickingSetup]) {
			const { deps, clock } = make();
			await importRows(deps, [desk]);
			const initial = stateOf(deps, "A1");
			clock.t += 1000;
			const a = await importRows(deps, [{ ...desk, price: 11 }], { publish: false });
			const afterA = stateOf(deps, "A1");
			clock.t += 1000;
			const b = await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
			const early = await rollBack(deps, a.id);
			const [row] = await records(deps, early.id);
			expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
			await rollBack(deps, b.id);
			expectRestored(stateOf(deps, "A1"), afterA);
			await transitionJob(deps, early.id, "retry");
			expect((await runToEnd(deps, early.id)).counters).toMatchObject({ reverted: 1, conflict: 0 });
			expectRestored(stateOf(deps, "A1"), initial);
		}
	});

	it("refuses a stop after the unpublish whose entry an editor gave a draft of another field", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk], { publish: false });
		clock.t += 1000;
		const job = await importRows(deps, [{ ...desk, price: 12 }]);
		const { rollback } = await createRollback(deps, { id: job.id });
		const put = deps.records.put.bind(deps.records);
		let once = true;
		deps.records.put = async (key, row) => {
			if (once && row.pendingStep === 4) {
				once = false;
				throw new Error("killed after the unpublish");
			}
			return put(key, row);
		};
		await crash(deps, rollback.id, "killed after the unpublish");
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor's title" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(entryOf(deps, "A1").data.title).toBe("Editor's title");
	});

	it("leaves an entry the import wrote while recovering from a stop, after an edit in between", async () => {
		const { deps, clock } = setup();
		const { start, csv } = await import("./rollback-fixture.js");
		await importRows(deps, [desk]);
		clock.t += 1000;
		const job = await start(deps, csv([changed]));
		const update = deps.content.update.bind(deps.content);
		let once = true;
		deps.content.update = async (input) => {
			if (once) {
				once = false;
				throw new Error("killed before the update");
			}
			return update(input);
		};
		await crash(deps, job.id, "killed before the update");
		const e = entryOf(deps, "A1");
		const w = await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		if (!w.ok) throw new Error("the editor's write failed");
		await deps.content.publish({ id: e.id, rev: w.rev });
		await runToEnd(deps, job.id);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).toMatchObject({ uncertain: true });
		const imported = structuredClone(entryOf(deps, "A1").data);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_changed",
					message:
						"Not rolled back: the import was recovering from a stop when it wrote this entry, and the entry had changed since its first read, so a later edit cannot be ruled out; revert it by hand",
				},
			],
		});
		expect(entryOf(deps, "A1").data).toEqual(imported);
	});

	it("rolls back an entry the import wrote after a stop that changed nothing", async () => {
		const { deps } = setup();
		const { start, csv } = await import("./rollback-fixture.js");
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await start(deps, csv([changed]));
		const update = deps.content.update.bind(deps.content);
		let once = true;
		deps.content.update = async (input) => {
			if (once) {
				once = false;
				throw new Error("killed before the update");
			}
			return update(input);
		};
		await crash(deps, job.id, "killed before the update");
		await runToEnd(deps, job.id);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).not.toHaveProperty("uncertain");
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("leaves an entry whose terms an editor changed after the job, which the revision does not show", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.wrote).toEqual({
			taxonomies: { tag: [deps.lookups.storedTerms.find((t) => t.slug === "sale")?.group] },
		});
		// As an admin term assignment: the terms change, the revision does not.
		const e = entryOf(deps, "A1");
		const rev = e.rev;
		e.taxonomies.tag = ["sale", "new"];
		expect(e.rev).toBe(rev);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_changed",
					message:
						"Not rolled back: the entry's terms changed after the import wrote them (term edits do not change the revision); revert it by hand",
				},
			],
		});
		expect(e.taxonomies.tag).toEqual(["sale", "new"]);
	});

	it("does not delete a created entry someone else moved to Trash", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.trash("products", e.id);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_changed",
					message:
						"Not rolled back: the entry was moved to Trash after the import created it; restore it from Trash or delete it by hand",
				},
			],
		});
		expect(deps.content.entries.get(e.id)).toMatchObject({ trashed: true });
	});

	it("warns on the job that deleting entries removes references to them", async () => {
		const warning = "Deleting an entry also removes references other entries hold to it.";
		const { deps } = setup();
		await importRows(deps, [desk]);
		const updates = await importRows(deps, [changed]);
		expect((await rollBack(deps, updates.id)).warnings ?? []).not.toContain(warning);
		const creates = await importRows(deps, [
			{ sku: "A2", name: "Lamp" },
			{ sku: "A3", name: "Shelf" },
		]);
		const planned = await rollBack(deps, creates.id, { dryRun: true });
		expect(planned.warnings).toContain(warning);
		const done = await rollBack(deps, creates.id);
		expect(done.warnings?.filter((w) => w === warning)).toHaveLength(1);
	});

	it("looks up only the restored references the entry no longer holds", async () => {
		const { deps } = setup();
		await importRows(deps, [
			{ sku: "A1", name: "Desk" },
			{ sku: "A3", name: "Shelf" },
			{ sku: "A2", name: "Lamp", related: "A1" },
		]);
		const before = stateOf(deps, "A2");
		const job = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A1|A3" }]);
		const calls = deps.lookups.calls.length;
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A2"), before);
		expect(deps.lookups.calls.slice(calls).filter((c) => c.startsWith("find:"))).toEqual([]);
	});

	it("ends a batch before a row once the lookup budget is spent", async () => {
		const { deps } = setup();
		await importRows(deps, [desk, { sku: "A2", name: "Lamp" }]);
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp", price: 3 }]);
		const { rollback } = await createRollback(deps, { id: job.id });
		const first = await runBatch(deps, rollback.id, "driver", Number.POSITIVE_INFINITY, 1);
		expect(first.counters).toMatchObject({ reverted: 1 });
		expect((await runToEnd(deps, rollback.id)).counters).toMatchObject({ reverted: 2 });
	});
});

describe("timestamp rules under a clock that moves on every read (M5a)", () => {
	it("takes a create found by source ID only when it was made after its journal row", async () => {
		const { deps } = tickingSetup();
		// Not published: a publish moves updatedAt, so a published create is never adopted.
		const job = await importRows(deps, [desk], { publish: false });
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		const { confirmed: _, ...unconfirmed } = row!;
		await deps.links.delete(linkKey("products", "en", "A1"));
		const e = entryOf(deps, "A1");
		expect(e.createdAt > row!.at).toBe(true);
		await deps.journal.put(key, { ...unconfirmed, entryId: null });
		const done = await rollBack(deps, job.id);
		expect((await records(deps, done.id))[0]).toMatchObject({
			status: "reverted",
			action: "trash",
		});
		// One made before its journal row is not taken.
		const second = await importRows(deps, [{ sku: "A2", name: "Lamp" }], { publish: false });
		const key2 = journalKey(second.id, linkKey("products", "en", "A2"));
		const row2 = await deps.journal.get(key2);
		const { confirmed: __, ...unconfirmed2 } = row2!;
		await deps.links.delete(linkKey("products", "en", "A2"));
		const e2 = entryOf(deps, "A2");
		await deps.journal.put(key2, {
			...unconfirmed2,
			entryId: null,
			at: new Date(Date.parse(e2.createdAt) + 1).toISOString(),
		});
		const refused = await rollBack(deps, second.id);
		expect(refused.counters).toMatchObject({ unchanged: 1, reverted: 0 });
		expect(e2.trashed).toBe(false);
	});

	it("leaves a created entry an editor edited in a draft", async () => {
		const { deps } = tickingSetup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
	});

	it("reports an update row the job never wrote, and rolls back one it wrote", async () => {
		const { deps } = tickingSetup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const link = await linkOf(deps, "A1");
		const ghost = await importRows(deps, [{ sku: "Z1", name: "Other" }]);
		const e = entryOf(deps, "A1");
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "A1")), {
			jobId: ghost.id,
			seq: 1,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: e.id,
			before: { link: { ...link }, status: "published", scheduledAt: null, live: { price: 1 } },
			at: new Date(deps.now()).toISOString(),
		});
		const done = await rollBack(deps, ghost.id);
		const row = (await records(deps, done.id)).find((r) => r.sourceKey === "A1");
		expect(row).toMatchObject({ status: "unchanged" });
		expect(entryOf(deps, "A1").data.price).toBe(10);
		const job = await importRows(deps, [changed]);
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("only moves an entry crash repair found to Trash", async () => {
		const { deps } = tickingSetup();
		const { start, csv } = await import("./rollback-fixture.js");
		const job = await start(deps, csv([desk]));
		let once = true;
		deps.content.afterWrite = () => {
			if (once) {
				once = false;
				throw new Error("crash after the create");
			}
		};
		await crash(deps, job.id, "crash after the create");
		await runToEnd(deps, job.id);
		const id = entryOf(deps, "A1").id;
		const done = await rollBack(deps, job.id);
		expect((await records(deps, done.id))[0]).toMatchObject({
			status: "reverted",
			action: "trash",
		});
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
	});
});

describe("final review: more guards (M5a)", () => {
	it("refuses a stop before the publish whose entry an editor published and gave a new draft, over the importer's draft", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		const job = await importRows(deps, [changed]);
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.beforeStep = (step) => {
			if (step === "publish") throw new Error("crash before publish");
		};
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { notes: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
	});

	it("charges each revert step to the lookup budget", async () => {
		const { deps } = setup();
		await importRows(deps, [
			{ sku: "A1", name: "Desk" },
			{ sku: "A2", name: "Lamp" },
		]);
		const job = await importRows(deps, [
			{ sku: "A1", name: "Desk", price: 1 },
			{ sku: "A2", name: "Lamp", price: 2 },
		]);
		const { rollback } = await createRollback(deps, { id: job.id });
		// A row is COST_RECORD (25) plus its update and publish (35 each): one row spends 60.
		const first = await runBatch(deps, rollback.id, "driver", Number.POSITIVE_INFINITY, 60);
		expect(first.counters).toMatchObject({ reverted: 1 });
	});

	it("checks the terms the job wrote last when it wrote an entry twice", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed, { ...changed, tags: "new|sale" }]);
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["new", "sale"]);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.wrote?.taxonomies?.tag).toHaveLength(2);
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 1, conflict: 0 });
		expectRestored(stateOf(deps, "A1"), before);
	});
});

describe("final review, second pass (M5a)", () => {
	it("refuses a stop just after step 1 whose entry an editor gave a draft of another field", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		clock.t += 1000;
		const job = await importRows(deps, [{ ...desk, price: 12 }]);
		const { rollback } = await createRollback(deps, { id: job.id });
		// Killed at the save before step 2: the row still says step 1 was sent.
		const put = deps.records.put.bind(deps.records);
		let once = true;
		deps.records.put = async (key, row) => {
			if (once && row.pendingStep === 2) {
				once = false;
				throw new Error("killed after step 1");
			}
			return put(key, row);
		};
		await crash(deps, rollback.id, "killed after step 1");
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor draft" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
		expect(liveOf(deps, "A1").title).toBe("Desk");
		expect(entryOf(deps, "A1").data.title).toBe("Editor draft");
	});

	it("rolls back a duplicate key whose second write stopped and resumed", async () => {
		const { deps, clock } = setup();
		const { start, csv } = await import("./rollback-fixture.js");
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		clock.t += 1000;
		const job = await start(
			deps,
			csv([
				{ ...desk, price: 12 },
				{ ...desk, price: 13 },
			]),
		);
		const update = deps.content.update.bind(deps.content);
		let n = 0;
		deps.content.update = async (input) => {
			if (++n === 2) throw new Error("killed in the second write");
			return update(input);
		};
		await crash(deps, job.id, "killed in the second write");
		deps.content.update = update;
		await runToEnd(deps, job.id);
		expect(entryOf(deps, "A1").data.price).toBe(13);
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).not.toHaveProperty("uncertain");
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 1, conflict: 0 });
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("does not start a row the batch budget cannot cover", async () => {
		// The first row spends 95 (25 + update 35 + publish 35); the second needs 165 more.
		for (const [budget, reverted] of [
			[259, 1],
			[260, 2],
		] as const) {
			const { deps } = setup();
			await importRows(deps, [
				{ sku: "A1", name: "Desk" },
				{ sku: "A2", name: "Lamp" },
			]);
			const job = await importRows(deps, [
				{ sku: "A1", name: "Desk", price: 1 },
				{ sku: "A2", name: "Lamp", price: 2 },
			]);
			const { rollback } = await createRollback(deps, { id: job.id });
			const first = await runBatch(deps, rollback.id, "driver", Number.POSITIVE_INFINITY, budget);
			expect(first.counters, `budget ${budget}`).toMatchObject({ reverted });
		}
	});
});
