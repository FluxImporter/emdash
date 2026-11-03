import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
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
			writtenRev: String(entryOf(deps, "A1").rev),
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
				rev: String(e.rev),
				step: "schedule",
				scheduledAt: at,
			});
			// As a scheduling import (M5b) would leave it: the importer's revision on the link.
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: String(e.rev),
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
		await deps.content.update({ id: e.id, rev: String(e.rev), references: { related: [] } });
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
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
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
				rev: String(e.rev),
				step: "schedule",
				scheduledAt: new Date(clock.t + 60_000).toISOString(),
			});
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: String(e.rev),
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
