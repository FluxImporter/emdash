/**
 * Crash repair adopts a revision it did not see written only while the entry's whole live data is
 * what the job journalled for the write (final review A-I1, A-I2): the scheduler's publish of the
 * importer's schedule, and the importer's own publish whose link save a stop lost.
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createRollback } from "../../src/engine/rollback.js";
import type { LinkRow } from "../../src/engine/types.js";
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

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const KEY = "products:en:A1";
const T0 = Date.parse("2026-10-07T10:00:00Z");
const HOUR = 3_600_000;
const due = new Date(T0 + HOUR).toISOString();
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;

async function editorStep(deps: Deps, step: "unschedule" | "discard") {
	const e = entryOf(deps, "A1");
	const r = await deps.content.revertStep({
		collection: "products",
		locale: "en",
		id: e.id,
		rev: deps.content.revOf(e.id),
		step,
	});
	expect(r.ok).toBe(true);
}

/** Drops a stopped batch's lease, so the next batch resumes the job at once. */
async function unlease(deps: Deps, id: string) {
	const j = await deps.jobs.get(id);
	if (j) await deps.jobs.put(id, { ...j, lease: null });
}

/** Runs the job's first batch, stopping it right after its schedule call landed. */
async function stopAfterSchedule(deps: Deps, jobId: string) {
	deps.content.afterSchedule = () => {
		throw new Error("stop");
	};
	await expect(runBatch(deps, jobId, "w1")).rejects.toThrow("stop");
	deps.content.afterSchedule = () => {};
}

/** Runs the job's first batch, stopping it at the link save after its publish landed. */
async function stopAfterPublish(deps: Deps, jobId: string) {
	const put = deps.links.put.bind(deps.links);
	let armed = false;
	deps.content.beforePublish = () => {
		armed = true;
	};
	deps.links.put = async (k: string, v: LinkRow) => {
		if (armed) {
			armed = false;
			throw new Error("stop");
		}
		return put(k, v);
	};
	await expect(runBatch(deps, jobId, "w1")).rejects.toThrow("stop");
	deps.links.put = put;
	deps.content.beforePublish = () => {};
}

/** Runs the job's first batch, stopping it as its publish call starts. */
async function stopBeforePublish(deps: Deps, jobId: string) {
	deps.content.beforePublish = () => {
		throw new Error("stop");
	};
	await expect(runBatch(deps, jobId, "w1")).rejects.toThrow("stop");
	deps.content.beforePublish = () => {};
}

async function rollBack(deps: Deps, jobId: string) {
	const { rollback } = await createRollback(deps, { id: jobId });
	await runToEnd(deps, rollback.id);
	return (await records(deps, rollback.id))[0];
}

const scheduled = (rules: Record<string, unknown>, opts: StartOptions = {}): StartOptions => ({
	...opts,
	extra: { rules, publishAt: { expr: `'${due}'` } },
});

describe("crash repair: the scheduler's publish only with the journalled data (A-I1)", () => {
	for (const rules of [
		{ updateFields: ["price"] },
		{ updateFields: ["price"], protectEdited: true },
	]) {
		it(`does not adopt an editor's unschedule and discard of the importer's draft (${JSON.stringify(rules)})`, async () => {
			const { deps, clock } = setup();
			await importRows(deps, [desk]);
			// The importer's own draft holds a title the narrowed job does not compare.
			await importRows(deps, [{ ...desk, name: "Desk 2" }], { publish: false });
			const job = await start(deps, csv([{ ...desk, name: "Desk 2" }]), scheduled(rules));
			await stopAfterSchedule(deps, job.id);
			clock.t = T0 + HOUR + 1000;
			await editorStep(deps, "unschedule");
			await editorStep(deps, "discard");
			const e = entryOf(deps, "A1");
			const editors = deps.content.revOf(e.id);
			await unlease(deps, job.id);
			await runToEnd(deps, job.id);
			expect((await linkOf(deps)).writtenRev).not.toBe(editors);
			const row = await rollBack(deps, job.id);
			expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
			// The draft the editor discarded stays discarded.
			expect(entryOf(deps, "A1")).toMatchObject({ live: null, status: "published" });
			expect(entryOf(deps, "A1").data.title).toBe("Desk");
		});
	}

	it("still adopts the scheduler's real publish of the importer's draft under updateFields", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, name: "Desk 2" }], { publish: false });
		const job = await start(
			deps,
			csv([{ ...desk, name: "Desk 2" }]),
			scheduled({ updateFields: ["price"] }),
		);
		await stopAfterSchedule(deps, job.id);
		clock.t = T0 + HOUR + 1000;
		const e = entryOf(deps, "A1");
		expect(deps.content.runScheduled()).toEqual([e.id]);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: due,
		});
		expect(await rollBack(deps, job.id)).toMatchObject({ status: "reverted" });
		// The live title is the one before the job; the job's draft is a draft again.
		expect(entryOf(deps, "A1").live?.data.title).toBe("Desk");
	});

	it("does not adopt the scheduler's publish for a job without a journal", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 12 }]), scheduled({}, { journal: false }));
		await stopAfterSchedule(deps, job.id);
		const before = await linkOf(deps);
		clock.t = T0 + HOUR + 1000;
		const e = entryOf(deps, "A1");
		expect(deps.content.runScheduled()).toEqual([e.id]);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		// The link stays as the write left it; the next run judges the entry.
		expect(await linkOf(deps)).toEqual(before);
		expect(entryOf(deps, "A1").data.price).toBe(12);
	});
});

describe("crash repair: a publish whose link save a stop lost (A-I2)", () => {
	it("adopts the importer's own-draft publish, saved as writing first, so the job rolls back", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		// A draft of the price only: a staged slug would read as a change and make it a write.
		await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		const job = await start(deps, csv([{ ...desk, price: 12 }]));
		const e = entryOf(deps, "A1");
		const drafted = deps.content.revOf(e.id);
		const calls = deps.content.calls.length;
		await stopAfterPublish(deps, job.id);
		expect(deps.content.calls.slice(calls)).toEqual([`publish:${e.id}`]);
		expect(entryOf(deps, "A1").status).toBe("published");
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "writing",
			action: "update",
			writtenRev: drafted,
		});
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "updated" });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
		});
		expect(deps.content.calls.slice(calls)).toEqual([`publish:${e.id}`]);
		expect(await rollBack(deps, job.id)).toMatchObject({ status: "reverted" });
		// The live price is the one before the job; the draft it published is a draft again.
		expect(entryOf(deps, "A1").live?.data.price).toBe(10);
	});

	it("adopts a written update's publish whose link save a stop lost", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 12 }]));
		await stopAfterPublish(deps, job.id);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", live: null });
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		const e = entryOf(deps, "A1");
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
		});
		expect(await rollBack(deps, job.id)).toMatchObject({ status: "reverted" });
		expect(entryOf(deps, "A1").data.price).toBe(10);
	});

	it("adopts a written create's publish whose link save a stop lost", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]));
		await stopAfterPublish(deps, job.id);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		const e = entryOf(deps, "A1");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "created" });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
		});
		expect(await rollBack(deps, job.id)).toMatchObject({ status: "reverted", action: "delete" });
	});

	it("journals what the publish makes live: every stored target field, null ones included", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		// Only the price is sent; the entry reads without its null featured and photo. They are
		// journalled as null all the same, so an editor who sets one is seen (final review P3).
		const job = await importRows(deps, [{ ...desk, price: 12 }], {
			extra: { rules: { updateFields: ["price"] } },
		});
		const [row] = await journalOf(deps, job.id);
		expect(Object.keys(row?.wrote?.fields ?? {}).sort()).toEqual([
			"featured",
			"photo",
			"price",
			"title",
		]);
	});

	it("does not adopt an editor's publish of other values, one version past the write", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		const listed = { extra: { rules: { updateFields: ["price"] } }, revisions: false };
		await importRows(deps, [desk], listed);
		const job = await start(deps, csv([{ ...desk, price: 12 }]), listed);
		await stopBeforePublish(deps, job.id);
		const row = (await records(deps, job.id))[0];
		const written = row?.writtenRev;
		expect(row).toMatchObject({ status: "writing" });
		// Without revisions an editor's save is live at once: one version, published, no draft.
		const e = entryOf(deps, "A1");
		const saved = await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Edited" },
		});
		expect(saved.ok).toBe(true);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await linkOf(deps)).writtenRev).toBe(written);
		expect(await rollBack(deps, job.id)).toMatchObject({
			status: "conflict",
			errors: [{ code: "rollback_changed" }],
		});
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Edited", price: 12 });
	});

	it("journals the entry's own fields the template does not map, as well as the target's", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk], { revisions: false });
		const e = entryOf(deps, "A1");
		// A field of the collection no mapping covers, set by an editor and live at once.
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { notes: "kept" } });
		const job = await importRows(deps, [{ ...desk, price: 12 }], { revisions: false });
		const [row] = await journalOf(deps, job.id);
		expect(Object.keys(row?.wrote?.fields ?? {}).sort()).toEqual([
			"featured",
			"notes",
			"photo",
			"price",
			"title",
		]);
	});

	it("does not adopt an editor's one save of a field that was null, without revisions (P3)", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		const listed = { extra: { rules: { updateFields: ["price"] } }, revisions: false };
		await importRows(deps, [desk], listed);
		const e = entryOf(deps, "A1");
		expect((await deps.content.get("products", "en", e.id))?.data).not.toHaveProperty("featured");
		const job = await start(deps, csv([{ ...desk, price: 12 }]), listed);
		await stopBeforePublish(deps, job.id);
		const written = (await records(deps, job.id))[0]?.writtenRev;
		// The editor sets the unlisted, empty field in one save: one version, published, no draft.
		const saved = await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { featured: true },
		});
		expect(saved.ok).toBe(true);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await linkOf(deps)).writtenRev).toBe(written);
		expect(await rollBack(deps, job.id)).toMatchObject({
			status: "conflict",
			errors: [{ code: "rollback_changed" }],
		});
		expect(entryOf(deps, "A1").data).toMatchObject({ featured: true, price: 12 });
	});

	it("does not adopt an editor's discard of the importer's draft as its publish", async () => {
		const { deps } = setup();
		const listed = { extra: { rules: { updateFields: ["price"] } } };
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, name: "Desk 2" }], { publish: false });
		const job = await start(deps, csv([{ ...desk, name: "Desk 2" }]), listed);
		await stopBeforePublish(deps, job.id);
		const written = (await records(deps, job.id))[0]?.writtenRev;
		await editorStep(deps, "discard");
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await linkOf(deps)).writtenRev).not.toBe(deps.content.revOf(entryOf(deps, "A1").id));
		expect(written).toBeDefined();
		expect(entryOf(deps, "A1")).toMatchObject({ live: null, status: "published" });
		expect(entryOf(deps, "A1").data.title).toBe("Desk");
	});

	it("does not adopt a lost publish for a job without a journal", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 12 }]), { journal: false });
		await stopAfterPublish(deps, job.id);
		const before = await linkOf(deps);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect(await linkOf(deps)).toEqual(before);
	});

	it("does not adopt an editor's publish now of the importer's schedule, before its time", async () => {
		const { deps, clock } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 12 }]), scheduled({}));
		await stopAfterSchedule(deps, job.id);
		const e = entryOf(deps, "A1");
		const r = await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			step: "publish",
		});
		expect(r.ok).toBe(true);
		clock.t = T0 + 1000;
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		// The record still schedules, so a publish is not what it sent: the link is not moved.
		expect((await linkOf(deps)).writtenRev).not.toBe(deps.content.revOf(e.id));
	});

	it("does not adopt a lost publish while a mapping is protected", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 12 }]), {
			extra: { rules: { protectEdited: true } },
		});
		await stopAfterPublish(deps, job.id);
		const e = entryOf(deps, "A1");
		// A term edit leaves the revision (F8): only the protection shows it.
		deps.content.setTerms(e.id, "tag", ["sale"]);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({
			warnings: [{ code: "field_edited", field: "taxonomies.tag" }],
		});
		expect((await linkOf(deps)).writtenRev).not.toBe(deps.content.revOf(e.id));
	});

	it("does not adopt another entry crash repair finds by source ID after a lost publish", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]));
		await stopAfterPublish(deps, job.id);
		const first = entryOf(deps, "A1");
		const data = structuredClone(first.data);
		// An editor deletes the import's entry and makes one like it, published once.
		await deps.content.trash("products", first.id);
		await deps.content.permanentDelete("products", first.id);
		const made = await deps.content.create({
			collection: "products",
			locale: "en",
			slug: "desk",
			data,
			taxonomies: structuredClone(first.taxonomies),
			bylines: structuredClone(first.bylines),
		});
		const published = await deps.content.publish({ id: made.id, rev: made.rev });
		expect(published.ok).toBe(true);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		const link = await linkOf(deps);
		expect(link.entryId === made.id && link.writtenRev === deps.content.revOf(made.id)).toBe(false);
	});
});
