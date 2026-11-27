import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { decodeRev } from "../../src/engine/revs.js";
import {
	NOT_SCHEDULED_MESSAGE,
	SCHEDULE_LEAD_MS,
	SCHEDULING_DISABLED_MESSAGE,
} from "../../src/engine/rules.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { LinkRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";
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
	ticking,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const KEY = "products:en:A1";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;
/** A time `ms` after the test clock's start. */
const T0 = Date.parse("2026-10-07T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const HOUR = 3_600_000;
const scheduleAt = (time: string, opts: StartOptions = {}): StartOptions => ({
	...opts,
	extra: { ...opts.extra, publishAt: { expr: `'${time}'` } },
});
const later = (deps: Deps) => deps.content.calls.filter((c) => c.startsWith("schedule:"));

describe("publishAt: publish now or schedule (M5b)", () => {
	it("creates and schedules a record whose time is ahead, and saves the schedule's revision", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "created", action: "create" });
		expect(row?.changes?.at(-1)).toEqual({ field: "publishAt", before: null, after: at(HOUR) });
		const e = entryOf(deps, "A1");
		expect(e).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: at(HOUR),
		});
		expect(deps.content.calls).not.toContain(`publish:${e.id}`);
	});

	it("publishes now for an empty, past or near time", async () => {
		for (const time of ["", at(-HOUR), at(SCHEDULE_LEAD_MS - 1)]) {
			const { deps } = setup();
			const job = await importRows(deps, [desk], scheduleAt(time));
			const [row] = await records(deps, job.id);
			expect(row?.changes?.map((c) => c.field)).not.toContain("publishAt");
			expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
		}
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(SCHEDULE_LEAD_MS)));
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled" });
	});

	it("updates a published entry, staging a draft, and schedules it", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [
				{ field: "price", before: 10, after: 12 },
				{ field: "publishAt", before: null, after: at(HOUR) },
			],
		});
		expect(await deps.content.get("products", "en", entryOf(deps, "A1").id)).toMatchObject({
			status: "published",
			hasDraft: true,
			scheduledAt: at(HOUR),
			live: { price: 10 },
		});
	});

	it("warns not_scheduled for a published entry whose update goes live at once", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], {
			...scheduleAt(at(HOUR)),
			revisions: false,
		});
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [{ field: "price" }],
			warnings: [{ code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
		expect(later(deps)).toEqual([]);
		// Terms and bylines are live on a collection with revisions too.
		const { deps: other } = setup();
		await importRows(other, [desk]);
		const links = await importRows(other, [{ ...desk, tags: "sale" }], scheduleAt(at(HOUR)));
		expect((await records(other, links.id))[0]?.warnings?.[0]?.code).toBe("not_scheduled");
		expect(later(other)).toEqual([]);
	});

	it("leaves a published entry without a draft unchanged when nothing changed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "unchanged" });
		expect(later(deps)).toEqual([]);
	});

	it("schedules the importer's own draft when nothing else changed, journalling it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toEqual(
			expect.objectContaining({
				status: "updated",
				action: "update",
				changes: [{ field: "publishAt", before: null, after: at(HOUR) }],
			}),
		);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		const [journal] = await journalOf(deps, job.id);
		expect(journal).toMatchObject({
			kind: "update",
			before: { status: "draft", scheduledAt: null },
		});
	});

	it("reschedules the importer's own schedule, and keeps it when the time is the same", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const same = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, same.id))[0]).toMatchObject({ status: "unchanged" });
		const moved = await importRows(deps, [desk], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, moved.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "publishAt", before: at(HOUR), after: at(2 * HOUR) }],
		});
		// An update keeps the schedule, so the same time needs no second call.
		deps.content.calls.length = 0;
		const updated = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, updated.id))[0]?.changes?.map((c) => c.field)).toEqual(["price"]);
		expect(later(deps)).toEqual([]);
		expect(await linkOf(deps)).toMatchObject({ scheduledAt: at(2 * HOUR) });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(2 * HOUR) });
	});

	it("publishes the importer's own schedule now when the time has passed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const job = await importRows(deps, [desk], scheduleAt(at(-HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "updated" });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("refuses an entry someone else scheduled, as a pending state", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "pending_draft" }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ scheduledAt: at(HOUR) });
	});

	it("keeps the importer's earlier schedule with publish: false (F7)", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		expect(await linkOf(deps)).toMatchObject({ scheduledAt: at(HOUR) });
	});

	it("saves as a draft with schedule_conflict or schedule_locked", async () => {
		for (const [reason, change] of [
			["conflict", (deps: Deps, id: string) => deps.content.entries.get(id)!.rev++],
			["locked", (deps: Deps, id: string) => deps.content.locked.add(id)],
		] as const) {
			const { deps } = setup();
			deps.content.beforeSchedule = (id) => {
				change(deps, id);
			};
			const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
			expect((await records(deps, job.id))[0]).toMatchObject({
				status: reason,
				action: "create",
				errors: [{ code: `schedule_${reason}` }],
			});
			expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		}
	});

	it("fails the record on a hook's refusal after the write, and a retry schedules its draft", async () => {
		const { deps } = setup();
		deps.content.blockStep = (step) => (step === "schedule" ? "Not on Fridays" : null);
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "emdash_schedule_rejected" }],
		});
		deps.content.blockStep = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ updated: 1, failed: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("adopts a schedule that landed before a stop, by the revision's version and time", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.afterSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterSchedule = () => {};
		const row = (await records(deps, job.id))[0];
		const e = entryOf(deps, "A1");
		expect(row).toMatchObject({ status: "writing" });
		const wrote = decodeRev(row?.writtenRev ?? "");
		const now = decodeRev(deps.content.revOf(e.id));
		expect(now?.version).toBe(wrote?.version);
		expect(now?.updatedAt).not.toBe(wrote?.updatedAt);
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		expect(later(deps)).toHaveLength(1);
	});

	it("reports schedule_unverified when the entry moved by a version after the stop", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.afterSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterSchedule = () => {};
		const e = entryOf(deps, "A1");
		// A field the template does not map: the record's data is unchanged, the version is not.
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { notes: "Ed" } });
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "schedule_unverified" }],
		});
	});

	it("schedules again after a stop before the schedule call", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.beforeSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.beforeSchedule = () => {};
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("reports schedule_unverified and schedules nothing after a stop before the create's revision was saved", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		// The create landed, but its revision never reached the record row (as publish_unverified).
		deps.content.afterWrite = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterWrite = () => {};
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing", entryId: null });
		expect((await records(deps, job.id))[0]).not.toHaveProperty("writtenRev");
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 0, conflict: 1 });
		const e = entryOf(deps, "A1");
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			action: "create",
			entryId: e.id,
			errors: [{ code: "schedule_unverified" }],
		});
		expect(deps.content.entries.size).toBe(1);
		expect(e).toMatchObject({ status: "draft", scheduledAt: null });
		expect(later(deps)).toEqual([]);
		expect(await linkOf(deps)).not.toHaveProperty("writtenRev");
	});

	it("plans the same in a dry run and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk, { ...desk, sku: "B2" }], {
			...scheduleAt(at(HOUR)),
			dryRun: true,
		});
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.action, r.changes?.at(-1)?.field])).toEqual([
			["planned", "update", "publishAt"],
			["planned", "create", "publishAt"],
		]);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("finds the entry the scheduler published as any published entry", async () => {
		const { deps, clock } = setup();
		await importRows(
			deps,
			[desk],
			scheduleAt(at(HOUR), { extra: { rules: { protectEdited: true } } }),
		);
		const fields = (await linkOf(deps)).fields;
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([entryOf(deps, "A1").id]);
		const job = await importRows(
			deps,
			[desk],
			scheduleAt(at(2 * HOUR), { extra: { rules: { protectEdited: true } } }),
		);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "unchanged" });
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
		expect((await linkOf(deps)).fields).toEqual(fields);
	});

	it("schedules only a time at least 60 s ahead", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(59_999)));
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
		const { deps: other } = setup();
		await importRows(other, [desk], scheduleAt(at(60_000)));
		expect(entryOf(other, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(60_000) });
	});

	it("keeps a schedule given in another form of the same instant", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		deps.content.calls.length = 0;
		const same = await importRows(deps, [desk], scheduleAt("2026-10-07T13:00:00+02:00"));
		expect((await records(deps, same.id))[0]).toMatchObject({ status: "unchanged" });
		expect(later(deps)).toEqual([]);
	});

	it("warns not_scheduled for a bylines-only update of a published entry", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, authors: "sam" }], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "bylines" }],
			warnings: [{ code: "not_scheduled" }],
		});
		expect(later(deps)).toEqual([]);
	});

	it("schedules a links-only update of a published entry with the importer's own draft", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		const job = await importRows(
			deps,
			[{ ...desk, price: 12, tags: "sale" }],
			scheduleAt(at(HOUR)),
		);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [{ field: "taxonomies.tag" }, { field: "publishAt", after: at(HOUR) }],
		});
		expect(row).not.toHaveProperty("warnings");
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: at(HOUR) });
	});

	it("plans no schedule for an unchanged published entry in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [desk], { ...scheduleAt(at(HOUR)), dryRun: true });
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "planned", action: "unchanged" });
		expect(row?.changes ?? []).toEqual([]);
	});

	it("warns not_scheduled when the downloads leave only links to update", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		// The same bytes under another URL: a change until the download finds the stored item.
		const job = await importRows(
			deps,
			[{ ...desk, img: url("copy.png"), tags: "sale" }],
			scheduleAt(at(HOUR)),
		);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "taxonomies.tag" }],
			warnings: [{ code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE }],
		});
		expect(later(deps)).toEqual([]);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("journals the importer's own draft before the schedule call", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.beforeSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		expect(await journalOf(deps, job.id)).toHaveLength(1);
	});

	it("reports schedule_unverified when the entry was unscheduled after the stop", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.afterSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterSchedule = () => {};
		const e = entryOf(deps, "A1");
		// An unschedule keeps the version and moves only updated_at, as the schedule did.
		await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			step: "unschedule",
		});
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "schedule_unverified" }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("finishes a create on retry after schedule_locked", async () => {
		const { deps } = setup();
		deps.content.beforeSchedule = (id) => {
			deps.content.locked.add(id);
		};
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]?.errors?.[0]?.code).toBe("schedule_locked");
		deps.content.beforeSchedule = () => {};
		deps.content.locked.clear();
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 1, updated: 0, locked: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("keeps the entry's schedule on the link when repairing a publish: false write", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const realPut = deps.links.put.bind(deps.links);
		let crash = true;
		deps.links.put = async (id, data) => {
			if (crash && data.writtenRev !== undefined) {
				crash = false;
				throw new Error("crash");
			}
			return realPut(id, data);
		};
		const job = await start(deps, csv([{ ...desk, price: 12 }]), { publish: false });
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		await runToEnd(deps, job.id);
		const e = entryOf(deps, "A1");
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: at(HOUR),
		});
	});
});

/** Drops a crashed batch's lease, so the next batch resumes the job at once. */
async function unlease(deps: Deps, id: string) {
	const leased = (await deps.jobs.get(id)) as NonNullable<Awaited<ReturnType<Deps["jobs"]["get"]>>>;
	await deps.jobs.put(id, { ...leased, lease: null });
}

/** Stops the first batch of a job right after its schedule call landed. */
async function crashAfterSchedule(deps: Deps, jobId: string) {
	deps.content.afterSchedule = () => {
		throw new Error("crash");
	};
	await expect(runBatch(deps, jobId, "w1")).rejects.toThrow("crash");
	deps.content.afterSchedule = () => {};
}

describe("publishAt: crash repair and someone else's schedule (M5b)", () => {
	it("repairs a stop after scheduling the importer's own draft, before the link put", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk], { publish: false });
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		await crashAfterSchedule(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing", action: "update" });
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		const e = entryOf(deps, "A1");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "updated", action: "update" });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: at(HOUR),
		});
		// The schedule is the importer's own, so the next run updates the entry.
		const next = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		expect((await records(deps, next.id))[0]).toMatchObject({ status: "updated" });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("adopts a landed schedule and publishes it when its time is now within the lead", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(90_000)));
		await crashAfterSchedule(deps, job.id);
		clock.t = T0 + 45_000;
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		const e = entryOf(deps, "A1");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "created" });
		expect(e).toMatchObject({ status: "published", scheduledAt: null });
		const link = await linkOf(deps);
		expect(link).toMatchObject({ writtenRev: deps.content.revOf(e.id), jobId: job.id });
		expect(link).not.toHaveProperty("scheduledAt");
	});

	it("adopts the scheduler's publish of a landed schedule, at the swept revision", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		await crashAfterSchedule(deps, job.id);
		clock.t = T0 + 2 * HOUR;
		const e = entryOf(deps, "A1");
		expect(deps.content.runScheduled()).toEqual([e.id]);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "created" });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: at(HOUR),
		});
		expect(deps.content.calls).not.toContain(`publish:${e.id}`);
	});

	it("refuses an editor's schedule of a published entry for a template without publishAt", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		const job = await importRows(deps, [{ ...desk, price: 12 }]);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "pending_draft",
					message: "Not imported: the entry is scheduled, and this import did not schedule it",
				},
			],
		});
		expect(entryOf(deps, "A1")).toMatchObject({
			status: "published",
			scheduledAt: at(HOUR),
			data: { price: 10 },
		});
	});

	it("puts no not_scheduled warning on a locked or pending row", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		deps.content.locked.add(e.id);
		const locked = await importRows(deps, [{ ...desk, tags: "sale" }], scheduleAt(at(HOUR)));
		const [lockedRow] = await records(deps, locked.id);
		expect(lockedRow).toMatchObject({ status: "locked" });
		expect(lockedRow).not.toHaveProperty("warnings");
		deps.content.locked.clear();
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		const pending = await importRows(deps, [{ ...desk, tags: "sale" }], scheduleAt(at(2 * HOUR)));
		const [pendingRow] = await records(deps, pending.id);
		expect(pendingRow).toMatchObject({ status: "conflict", errors: [{ code: "pending_draft" }] });
		expect(pendingRow).not.toHaveProperty("warnings");
	});

	it("puts no not_scheduled warning on an update the write itself refused", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		// Locked after the lock check: the update call answers locked.
		deps.content.isLocked = async () => false;
		deps.content.locked.add(entryOf(deps, "A1").id);
		const job = await importRows(deps, [{ ...desk, tags: "sale" }], scheduleAt(at(HOUR)));
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "locked", errors: [{ code: "locked" }] });
		expect(row).not.toHaveProperty("warnings");
	});

	it("plans not_scheduled in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, tags: "sale" }], {
			...scheduleAt(at(HOUR)),
			dryRun: true,
		});
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "planned",
			action: "update",
			changes: [{ field: "taxonomies.tag" }],
			warnings: [{ code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE }],
		});
	});

	it("does not adopt the schedule of an editor's entry that crash repair finds by source ID", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const realPut = deps.links.put.bind(deps.links);
		let crash = true;
		deps.links.put = async (id, data) => {
			if (crash && data.writtenRev !== undefined) {
				crash = false;
				throw new Error("crash");
			}
			return realPut(id, data);
		};
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		// The editor replaces the import's entry with an identical one of the same version, and
		// schedules it for the record's time.
		const mine = entryOf(deps, "A1");
		await deps.content.trash("products", mine.id);
		await deps.content.permanentDelete("products", mine.id);
		const copy = await deps.content.create({
			collection: "products",
			locale: "en",
			...(mine.slug === null ? {} : { slug: mine.slug }),
			data: structuredClone(mine.data),
			taxonomies: structuredClone(mine.taxonomies),
			references: structuredClone(mine.references),
			bylines: structuredClone(mine.bylines),
		});
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id: copy.id,
			rev: copy.rev,
			scheduledAt: at(HOUR),
		});
		const wrote = decodeRev((await records(deps, job.id))[0]?.writtenRev ?? "");
		expect(decodeRev(deps.content.revOf(copy.id))?.version).toBe(wrote?.version);
		await unlease(deps, job.id);
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			entryId: copy.id,
			errors: [{ code: "schedule_unverified" }],
		});
		expect(await linkOf(deps)).not.toHaveProperty("scheduledAt");
	});

	it("warns not_scheduled when protection leaves only links to update", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const rules = { rules: { protectEdited: true } };
		await importRows(deps, [desk], { extra: rules });
		const e = entryOf(deps, "A1");
		const edited = await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { price: 15 },
		});
		if (!edited.ok) throw new Error("edit failed");
		await deps.content.publish({ id: e.id, rev: edited.rev });
		const job = await importRows(
			deps,
			[{ ...desk, price: 12, tags: "sale" }],
			scheduleAt(at(HOUR), { extra: rules }),
		);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "updated", changes: [{ field: "taxonomies.tag" }] });
		expect(row?.warnings?.map((w) => w.code)).toEqual(["field_edited", "not_scheduled"]);
		expect(later(deps)).toEqual([]);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("fails a record whose time passed before the schedule call, and a retry publishes it", async () => {
		const { deps, clock } = setup();
		// Downloads that outlast the lead: the time is past when the schedule call is made.
		deps.content.beforeSchedule = () => {
			clock.t = T0 + 2 * HOUR;
		};
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "emdash_validation_error" }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		deps.content.beforeSchedule = () => {};
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ updated: 1, failed: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});
});

describe("publishAt on translations (M5b, M4e)", () => {
	const fields: SchemaField[] = [
		{ slug: "title", type: "string" },
		{ slug: "flux_source_id", type: "string", translatable: false },
	];
	async function run(deps: ReturnType<typeof makeDeps>["deps"], template: unknown, body: string) {
		const upload = `u${deps.source.uploads.size + 1}`;
		deps.source.add(upload, body);
		const job = await createJob(deps, {
			uploadId: upload,
			template,
			schemaFields: fields,
			linkSchema: { targets: { products: fields } },
		});
		return runToEnd(deps, job.id);
	}

	it("creates a translation and schedules it, leaving its source published", async () => {
		const { deps } = makeDeps();
		await run(
			deps,
			{
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "id" },
				fields: { title: { from: "Name", type: "text" } },
			},
			"id,Name\nE1,Desk\n",
		);
		const job = await run(
			deps,
			{
				version: 1,
				collection: "products",
				locale: "fr",
				key: { from: "id" },
				translationOf: { from: "en_id", locale: "en" },
				fields: { title: { from: "Nom", type: "text" } },
				publishAt: { expr: `'${at(HOUR)}'` },
			},
			"id,en_id,Nom\nF1,E1,Bureau\n",
		);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "created", action: "create" });
		expect(row?.changes?.map((c) => c.field)).toEqual(["title", "translationOf", "publishAt"]);
		const entries = [...deps.content.entries.values()];
		const en = entries.find((x) => x.locale === "en");
		const fr = entries.find((x) => x.locale === "fr");
		expect(en).toMatchObject({ status: "published", scheduledAt: null });
		expect(fr).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR), group: en?.group });
	});
});

describe("publishAt on a routable collection without a slug (M5b, spec F2)", () => {
	it("saves as a draft and fails the record when EmDash refuses the publish or the schedule", async () => {
		const { deps } = setup();
		// Routable checking is opt-in in the fakes (EmDash makes collections routable by default).
		deps.content.routableCollections.add("products");
		const unslugged = { extra: { slug: undefined } };
		const now = await importRows(deps, [desk], unslugged);
		const later = await importRows(deps, [{ ...desk, sku: "B2", name: "Lamp" }], {
			extra: { slug: undefined, publishAt: { expr: `'${at(HOUR)}'` } },
		});
		const refused = (op: string) => ({
			status: "failed",
			action: "create",
			// The write landed before the refusal, which the catch reports as for any thrown call.
			entryId: null,
			errors: [
				{
					code: "emdash_validation_error",
					message: `${op} the entry failed: Cannot publish routable content without a slug`,
				},
			],
		});
		expect((await records(deps, now.id))[0]).toMatchObject(refused("Publishing"));
		expect((await records(deps, later.id))[0]).toMatchObject(refused("Scheduling"));
		// Both entries stay the importer's drafts, linked, and nothing went live or was scheduled.
		for (const key of ["A1", "B2"]) {
			const e = entryOf(deps, key);
			expect(e).toMatchObject({ slug: null, status: "draft", scheduledAt: null });
			expect(await deps.links.get(`products:en:${key}`)).toMatchObject({
				entryId: e.id,
				writtenRev: deps.content.revOf(e.id),
			});
		}
	});
});

describe("publishAt in a collection that refuses schedules (EmDash 1.5 no-scheduling)", () => {
	const noScheduling = (deps: Deps, opts: StartOptions = {}): StartOptions => {
		deps.content.unschedulable.add("products");
		return { ...scheduleAt(at(HOUR), opts), scheduling: false };
	};
	const disabled = { code: "scheduling_disabled", message: SCHEDULING_DISABLED_MESSAGE };

	it("creates a record whose time is ahead as a draft, with a warning, and never schedules", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], noScheduling(deps));
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "created", action: "create", warnings: [disabled] });
		expect(row?.changes?.map((c) => c.field)).not.toContain("publishAt");
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		expect(later(deps)).toEqual([]);
		expect(deps.content.calls).not.toContain(`publish:${entryOf(deps, "A1").id}`);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
	});

	it("stages an update of a published entry as a draft, with a warning", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], noScheduling(deps));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "price", before: 10, after: 12 }],
			warnings: [disabled],
		});
		expect(await deps.content.get("products", "en", entryOf(deps, "A1").id)).toMatchObject({
			status: "published",
			hasDraft: true,
			scheduledAt: null,
			live: { price: 10 },
		});
		expect(later(deps)).toEqual([]);
	});

	it("keeps the importer's own draft on the next run, warned again, and schedules nothing", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk], noScheduling(deps));
		const again = await importRows(deps, [desk], noScheduling(deps));
		expect((await records(deps, again.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [disabled],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		expect(later(deps)).toEqual([]);
	});

	it("warns in a dry run and plans no publishAt change", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], noScheduling(deps, { dryRun: true }));
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "planned", action: "create", warnings: [disabled] });
		expect(row?.changes?.map((c) => c.field)).not.toContain("publishAt");
	});

	it("publishes a past or near time at once, as in any collection", async () => {
		const { deps } = setup();
		deps.content.unschedulable.add("products");
		const job = await importRows(deps, [desk], { ...scheduleAt(at(-HOUR)), scheduling: false });
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "created" });
		expect(row).not.toHaveProperty("warnings");
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published" });
	});

	it("leaves a resumed record's own draft unscheduled", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const realPut = deps.links.put.bind(deps.links);
		let crash = true;
		deps.links.put = async (id, data) => {
			if (crash && data.writtenRev !== undefined) {
				crash = false;
				throw new Error("crash");
			}
			return realPut(id, data);
		};
		const job = await start(deps, csv([desk]), noScheduling(deps));
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing" });
		await unlease(deps, job.id);
		const done = await runToEnd(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "created", warnings: [disabled] });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		expect(later(deps)).toEqual([]);
	});
});
