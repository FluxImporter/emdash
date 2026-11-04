import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import type { EntrySnapshot } from "../../src/engine/ports.js";
import { encodeRev } from "../../src/engine/revs.js";
import { createRollback } from "../../src/engine/rollback.js";
import { sweptSince } from "../../src/engine/rules.js";
import { type Job, journalKey, type LinkRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	runToEnd,
	type StartOptions,
	setup,
	ticking,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const KEY = "products:en:A1";
const T0 = Date.parse("2026-10-07T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const HOUR = 3_600_000;
const scheduleAt = (time: string, opts: StartOptions = {}): StartOptions => ({
	...opts,
	extra: { ...opts.extra, publishAt: { expr: `'${time}'` } },
});
const protect: StartOptions = { extra: { rules: { protectEdited: true } } };
const count = (deps: Deps, call: string) => deps.content.calls.filter((c) => c === call).length;

async function rollBack(deps: Deps, id: string, opts: { dryRun?: boolean } = {}): Promise<Job> {
	const { rollback } = await createRollback(deps, { id, ...opts });
	return runToEnd(deps, rollback.id);
}

function setupTicking() {
	const made = setup();
	ticking(made.clock);
	return made;
}

/** An editor's step through the admin, at the entry's current revision. */
async function editorStep(deps: Deps, id: string, step: "unschedule" | "discard") {
	const result = await deps.content.revertStep({
		collection: "products",
		locale: "en",
		id,
		rev: deps.content.revOf(id),
		step,
	});
	expect(result.ok).toBe(true);
}

describe("ownership after the scheduler (M5b)", () => {
	const link = (extra: Partial<LinkRow> = {}): LinkRow => ({
		collection: "products",
		locale: "en",
		sourceKey: "A1",
		entryId: "e1",
		writtenRev: encodeRev(3, at(0)),
		scheduledAt: at(HOUR),
		...extra,
	});
	const entry = (
		version: number,
		updatedAt: string,
		extra: Partial<EntrySnapshot> = {},
	): EntrySnapshot => ({
		id: "e1",
		rev: encodeRev(version, updatedAt),
		slug: null,
		data: {},
		pendingPublish: false,
		status: "published",
		scheduledAt: null,
		hasDraft: false,
		...extra,
	});

	it("takes exactly the scheduler's publish: one version, published, at or after the time", () => {
		expect(sweptSince(link(), entry(4, at(HOUR)))).toBe(true);
		expect(sweptSince(link(), entry(4, at(HOUR + 5)))).toBe(true);
		// An editor's publish before the time, one more version, a draft or a schedule left.
		expect(sweptSince(link(), entry(4, at(HOUR - 1)))).toBe(false);
		expect(sweptSince(link(), entry(5, at(HOUR)))).toBe(false);
		expect(sweptSince(link(), entry(4, at(HOUR), { hasDraft: true }))).toBe(false);
		expect(sweptSince(link(), entry(4, at(HOUR), { status: "draft" }))).toBe(false);
		expect(sweptSince(link(), entry(4, at(HOUR), { scheduledAt: at(2 * HOUR) }))).toBe(false);
		// Without a recorded schedule, or with a revision that is not EmDash's, never.
		const { scheduledAt: _s, ...unscheduled } = link();
		expect(sweptSince(unscheduled, entry(4, at(HOUR)))).toBe(false);
		expect(sweptSince(link({ writtenRev: "3" }), entry(4, at(HOUR)))).toBe(false);
		expect(sweptSince(link(), { ...entry(4, at(HOUR)), rev: "garbage" })).toBe(false);
	});

	it("deletes a created entry the scheduler published", async () => {
		const { deps, clock } = setupTicking();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([id]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(deps.content.entries.has(id)).toBe(false);
	});

	it("restores an updated entry the scheduler published, from the published state", async () => {
		const { deps, clock } = setupTicking();
		// Every kind of value mapping: text, number, boolean, image and the slug.
		const full = { ...desk, featured: true, img: url("a.png") };
		await importRows(deps, [full]);
		const job = await importRows(deps, [{ ...full, price: 12 }], scheduleAt(at(HOUR)));
		clock.t = T0 + HOUR;
		deps.content.runScheduled();
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", data: { price: 12 } });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expect(await deps.content.get("products", "en", entryOf(deps, "A1").id)).toMatchObject({
			status: "published",
			hasDraft: false,
			scheduledAt: null,
			data: { price: 10 },
		});
	});

	it("journals the values a scheduled record leaves, as fingerprints", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		const link = (await deps.links.get(KEY)) as LinkRow;
		const [row] = await journalOf(deps, job.id);
		// Data, media and slug mappings; not the links, which no discard can take back.
		expect(row?.wrote?.fields).toEqual({
			title: link.fields?.title,
			price: link.fields?.price,
			featured: link.fields?.featured,
			photo: link.fields?.photo,
			slug: link.fields?.slug,
		});
		// A record published now leaves nothing for the scheduler: no values are journalled.
		const now = await importRows(deps, [{ ...desk, price: 14 }]);
		expect((await journalOf(deps, now.id))[0]?.wrote?.fields).toBeUndefined();
	});

	it("refuses an entry an editor published before the time, or changed after the scheduler", async () => {
		for (const edit of ["publish early", "edit after"] as const) {
			const { deps, clock } = setupTicking();
			const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
			const e = entryOf(deps, "A1");
			if (edit === "publish early") {
				await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
			} else {
				clock.t = T0 + HOUR;
				deps.content.runScheduled();
				await deps.content.update({
					id: e.id,
					rev: deps.content.revOf(e.id),
					data: { notes: "x" },
				});
			}
			const done = await rollBack(deps, job.id);
			expect(done.counters, edit).toMatchObject({ conflict: 1, reverted: 0 });
			expect((await records(deps, done.id))[0]?.errors?.[0]?.code).toBe("rollback_changed");
			expect(deps.content.entries.has(e.id)).toBe(true);
		}
	});

	it("refuses an entry an editor unscheduled after the time and then discarded (P6)", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		clock.t = T0 + HOUR + 1000;
		await editorStep(deps, id, "unschedule");
		await editorStep(deps, id, "discard");
		// The shape the scheduler's publish leaves, but with the values from before the job.
		const left = await deps.content.get("products", "en", id);
		expect(sweptSince((await deps.links.get(KEY)) as LinkRow, left as EntrySnapshot)).toBe(true);
		expect(left).toMatchObject({ status: "published", data: { price: 10 } });
		const rev = deps.content.revOf(id);
		const calls = deps.content.calls.length;
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect((await records(deps, done.id))[0]?.errors?.[0]?.code).toBe("rollback_changed");
		// Nothing written: the entry, its revision and the link are as the editor left them.
		const written = deps.content.calls
			.slice(calls)
			.filter((c) =>
				/^(update|publish|unpublish|discard|schedule|unschedule|trash|delete):/.test(c),
			);
		expect(written).toEqual([]);
		expect(deps.content.revOf(id)).toBe(rev);
		expect((await deps.links.get(KEY))?.jobId).toBe(job.id);
	});

	it("never takes a swept entry an editor moved to Trash", async () => {
		const { deps, clock } = setupTicking();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		clock.t = T0 + HOUR;
		deps.content.runScheduled();
		await deps.content.trash("products", id);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect((await records(deps, done.id))[0]?.errors).toEqual([
			expect.objectContaining({
				code: "rollback_changed",
				message: expect.stringMatching(/^Not rolled back: the entry changed after the import/),
			}),
		]);
		expect(deps.content.entries.has(id)).toBe(true);
	});

	it("fails closed on a journal row that holds no scheduled values", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		const [row] = await journalOf(deps, job.id);
		if (!row) throw new Error("no journal row");
		const { wrote: _w, ...m5a } = row;
		await deps.journal.put(journalKey(job.id, KEY), m5a);
		expect((await journalOf(deps, job.id))[0]?.wrote).toBeUndefined();
		clock.t = T0 + HOUR;
		deps.content.runScheduled();
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data).toMatchObject({ price: 12 });
	});

	it("restores an update that kept the job's own earlier schedule, after the sweep", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		// The same time again: the update keeps the schedule and makes no schedule call.
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		expect(count(deps, `schedule:${id}`)).toBe(1);
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([id]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ data: { price: 10 }, scheduledAt: null });
	});

	it("restores the importer's own draft it only scheduled, after the sweep", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([id]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("compares the values of the job's last write of the entry", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(
			deps,
			[
				{ ...desk, price: 12 },
				{ ...desk, name: "Table", price: 12 },
			],
			scheduleAt(at(HOUR)),
		);
		expect(job.counters).toMatchObject({ updated: 2 });
		clock.t = T0 + HOUR;
		deps.content.runScheduled();
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Table" });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Desk", price: 10 });
	});
});

describe("rollback step 7, unschedule (M5b)", () => {
	it("deletes a created and scheduled entry, which the scheduler then never publishes", async () => {
		const { deps } = setupTicking();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		await rollBack(deps, job.id);
		expect(deps.content.entries.has(id)).toBe(false);
	});

	it("unschedules the importer's own draft it scheduled, leaving it a draft", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled" });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		expect(count(deps, `unschedule:${id}`)).toBe(1);
	});

	it("needs no unschedule when the publish of step 2 cleared the schedule", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		await rollBack(deps, job.id);
		const id = entryOf(deps, "A1").id;
		expect(count(deps, `unschedule:${id}`)).toBe(0);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("puts an earlier schedule back with step 6, and unschedules one that has passed", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const job = await importRows(deps, [desk], scheduleAt(at(3 * HOUR)));
		expect(entryOf(deps, "A1")).toMatchObject({ scheduledAt: at(3 * HOUR) });
		const dry = await rollBack(deps, job.id, { dryRun: true });
		expect((await records(deps, dry.id))[0]?.changes).toEqual([
			{ field: "scheduledAt", before: at(3 * HOUR), after: at(HOUR) },
		]);
		await rollBack(deps, job.id);
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		expect(count(deps, `unschedule:${id}`)).toBe(0);
		// Again, once the first time has passed: the entry is left a draft without a schedule.
		const { deps: other, clock: otherClock } = setupTicking();
		await importRows(other, [desk], scheduleAt(at(HOUR)));
		const second = await importRows(other, [desk], scheduleAt(at(3 * HOUR)));
		otherClock.t = T0 + 2 * HOUR;
		const done = await rollBack(other, second.id);
		expect((await records(other, done.id))[0]?.warnings?.map((w) => w.code)).toEqual([
			"rollback_schedule_passed",
		]);
		expect(entryOf(other, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("adopts an unschedule that reached EmDash before the stop, without repeating it", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const { rollback } = await createRollback(deps, { id: job.id });
		const id = entryOf(deps, "A1").id;
		deps.content.afterStep = (step) => {
			if (step === "unschedule") throw new Error("stop");
		};
		await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
		deps.content.afterStep = () => {};
		const stopped = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(count(deps, `unschedule:${id}`)).toBe(1);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("does not adopt a stopped unschedule once someone scheduled the entry again", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const { rollback } = await createRollback(deps, { id: job.id });
		const id = entryOf(deps, "A1").id;
		deps.content.afterStep = (step) => {
			if (step === "unschedule") throw new Error("stop");
		};
		await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
		deps.content.afterStep = () => {};
		// An editor schedules it again before the rollback resumes.
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id,
			rev: deps.content.revOf(id),
			scheduledAt: at(5 * HOUR),
		});
		const stopped = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 0, conflict: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(5 * HOUR) });
	});

	it("hands the link back with its fingerprints and schedule, every fingerprint unconfirmed", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const first = (await deps.links.get(KEY)) as LinkRow;
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await deps.links.get(KEY))?.fields?.price).not.toBe(first.fields?.price);
		await rollBack(deps, job.id);
		const back = (await deps.links.get(KEY)) as LinkRow;
		expect(back).toMatchObject({
			jobId: first.jobId,
			fields: first.fields,
			scheduledAt: at(HOUR),
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
		// They were confirmed at the first job's revision, not at the rollback's.
		expect([...(back.unconfirmed ?? [])].sort()).toEqual(Object.keys(first.fields ?? {}).sort());
	});

	it("keeps an editor's edit protected after a rollback of a protected run (P5)", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk]);
		const id = entryOf(deps, "A1").id;
		await deps.content.update({ id, rev: deps.content.revOf(id), data: { title: "Editor" } });
		await deps.content.publish({ id, rev: deps.content.revOf(id) });
		await importRows(deps, [{ ...desk, price: 12 }], protect);
		const second = await importRows(deps, [{ ...desk, price: 14 }], protect);
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor", price: 14 });
		const done = await rollBack(deps, second.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor", price: 12 });
		const last = await importRows(deps, [{ ...desk, price: 16 }], protect);
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor", price: 16 });
		expect((await records(deps, last.id))[0]?.warnings?.map((w) => w.field)).toEqual(["title"]);
	});
});
