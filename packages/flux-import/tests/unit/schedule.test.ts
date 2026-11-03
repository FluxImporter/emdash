import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { decodeRev } from "../../src/engine/revs.js";
import { NOT_SCHEDULED_MESSAGE, SCHEDULE_LEAD_MS } from "../../src/engine/rules.js";
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
