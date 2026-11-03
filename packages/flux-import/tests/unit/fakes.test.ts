import { describe, expect, it } from "vitest";
import { decodeRev, encodeRev } from "../../src/engine/revs.js";
import { FakeContent, MemoryKv } from "./fakes.js";

describe("MemoryKv", () => {
	it("returns the revision actually stored when writers interleave", async () => {
		const kv = new MemoryKv<{ n: number }>();
		await kv.put("a", { n: 0 });
		const before = await kv.getVersioned("a");
		const [cas] = await Promise.all([
			kv.compareAndSet("a", before!.revision, { n: 1 }),
			kv.put("b", { n: 9 }),
		]);
		expect(cas.applied).toBe(true);
		const after = await kv.getVersioned("a");
		expect(cas.applied && cas.revision).toBe(after!.revision);
	});

	it("lets only one of two concurrent compareAndSet calls win", async () => {
		const kv = new MemoryKv<{ n: number }>();
		await kv.put("a", { n: 0 });
		const rev = (await kv.getVersioned("a"))!.revision;
		const results = await Promise.all([
			kv.compareAndSet("a", rev, { n: 1 }),
			kv.compareAndSet("a", rev, { n: 2 }),
		]);
		expect(results.filter((r) => r.applied)).toHaveLength(1);
	});

	it("deletes rows and orders and filters ISO timestamps", async () => {
		const kv = new MemoryKv<{ at: string }>();
		await kv.put("b", { at: "2026-10-02T00:00:00.000Z" });
		await kv.put("a", { at: "2026-10-01T00:00:00.000Z" });
		await kv.put("c", { at: "2026-10-03T00:00:00.000Z" });
		const page = await kv.query({
			where: { at: { lt: "2026-10-03T00:00:00.000Z" } },
			orderBy: { at: "desc" },
		});
		expect(page.items.map((i) => i.id)).toEqual(["b", "a"]);
		expect(await kv.delete("a")).toBe(true);
		expect(await kv.delete("a")).toBe(false);
		expect(await kv.deleteMany(["b", "c", "x"])).toBe(2);
		expect(kv.rows.size).toBe(0);
	});
});

describe("FakeContent translations", () => {
	it("joins the source's group with its shared values and credits, as EmDash", async () => {
		const content = new FakeContent();
		content.sharedFields.add("price");
		const source = await content.create({
			collection: "products",
			locale: "en",
			data: { title: "Desk", price: 10, flux_source_id: "E1" },
			taxonomies: { tag: ["new"] },
			bylines: [{ bylineId: "b1", roleLabel: null }],
		});
		const fr = await content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau", price: 99, flux_source_id: "F1" },
			translationOf: source.id,
		});
		const de = await content.create({
			collection: "products",
			locale: "de",
			data: { title: "Tisch" },
			translationOf: fr.id,
			bylines: [],
		});
		expect(await content.get("products", "fr", fr.id)).toMatchObject({
			group: source.id,
			data: { title: "Bureau", price: 10, flux_source_id: "E1" },
			bylines: [{ id: "b1" }],
		});
		expect(await content.get("products", "de", de.id)).toMatchObject({
			group: source.id,
			data: { title: "Tisch", price: 10, flux_source_id: "E1" },
			bylines: [],
		});
		expect(content.entries.get(fr.id)?.taxonomies).toEqual({ tag: ["new"] });
		expect(await content.translations("products", de.id)).toEqual([
			{ id: source.id, locale: "en" },
			{ id: fr.id, locale: "fr" },
			{ id: de.id, locale: "de" },
		]);
		expect(await content.translations("products", "nope")).toEqual([]);
	});

	it("refuses a missing source and a locale the group already has", async () => {
		const content = new FakeContent();
		const source = await content.create({ collection: "products", locale: "en", data: {} });
		const create = (translationOf: string) =>
			content.create({ collection: "products", locale: "en", data: {}, translationOf });
		await expect(create("nope")).rejects.toMatchObject({ code: "emdash_not_found" });
		await expect(create(source.id)).rejects.toMatchObject({ code: "emdash_conflict" });
	});
});

describe("FakeContent for rollbacks (M5a)", () => {
	const at = (ms: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + ms).toISOString();
	function setup() {
		const clock = { t: Date.parse("2026-10-07T10:00:00Z") };
		const content = new FakeContent();
		content.now = () => clock.t;
		return { content, clock };
	}
	const base = { collection: "products", locale: "en" };

	it("stamps creates and writes, and stages drafts only on collections with revisions", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "draft",
			scheduledAt: null,
			hasDraft: false,
			createdAt: at(0),
			updatedAt: at(0),
		});
		clock.t += 1000;
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), data: { title: "B" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
			live: { title: "A" },
			data: { title: "B" },
			updatedAt: at(1000),
		});
		await content.update({ id, rev: content.revOf(id), taxonomies: { tag: ["new"] } });
		expect((await content.get("products", "en", id))?.live).toEqual({ title: "A" });

		content.plainCollections.add("plain");
		const plain = await content.create({ ...base, collection: "plain", data: { title: "A" } });
		await content.publish({ id: plain.id, rev: content.revOf(plain.id) });
		await content.update({ id: plain.id, rev: content.revOf(plain.id), data: { title: "B" } });
		expect(await content.get("plain", "en", plain.id)).toMatchObject({
			hasDraft: false,
			pendingPublish: false,
			data: { title: "B" },
		});
	});

	it("moves entries to Trash, hides them from reads and deletes them for good", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, data: { flux_source_id: "K" } });
		content.blockDelete = () => "Not today";
		expect(await content.trash("products", id)).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not today",
		});
		content.blockDelete = () => null;
		expect(await content.permanentDelete("products", id)).toBe(false);
		expect(await content.trash("products", id)).toEqual({ ok: true });
		expect(await content.get("products", "en", id)).toBeNull();
		expect(await content.findBySourceId("products", "en", "K")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", id)).toMatchObject({
			rev,
			trashed: true,
		});
		expect((await content.trash("products", id)).ok).toBe(false);
		expect(await content.permanentDelete("products", id)).toBe(true);
		expect(content.entries.has(id)).toBe(false);
	});

	it("runs revert steps with revision checks, hook refusals and EmDash's draft rules", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const step = (s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({ ...base, id, rev: content.revOf(id), step: s, ...extra });
		expect(await content.revertStep({ ...base, id, rev: "stale", step: "publish" })).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		const published = await step("publish");
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		const unpublished = await step("unpublish");
		// As EmDash: the unpublish creates a draft from the live revision (spec M5a F18).
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		expect(await step("discard")).toMatchObject({ ok: true, state: { hasDraft: false } });
		await expect(step("schedule", { scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		const scheduled = await step("schedule", { scheduledAt: at(60_000) });
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at(60_000) },
		});
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		expect(await step("publish")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not on Fridays",
		});
		const updated = await step("update", { data: { title: "B" }, slug: "b" });
		expect(updated).toMatchObject({ ok: true, state: { hasDraft: true } });
		expect(content.entries.get(id)).toMatchObject({ slug: "b", data: { title: "B" } });
	});

	/** A revert step at the entry's current `_rev`. */
	const stepOf =
		(content: FakeContent, id: string, collection = "products") =>
		(s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({
				collection,
				locale: "en",
				id,
				rev: content.revOf(id),
				step: s,
				...extra,
			});

	it("answers locked before any step, not conflict", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		content.locked.add(id);
		const step = stepOf(content, id);
		for (const s of ["update", "publish", "unpublish", "discard", "unschedule"] as const) {
			expect(await step(s)).toMatchObject({ ok: false, reason: "locked" });
			const stale = { collection: "products", locale: "en", id, rev: "stale", step: s };
			expect(await content.revertStep(stale)).toMatchObject({ ok: false, reason: "locked" });
		}
	});

	it("unpublishes a published entry without revisions into a draft of stale values", async () => {
		const { content } = setup();
		content.plainCollections.add("plain");
		const { id } = await content.create({
			...base,
			collection: "plain",
			slug: "a",
			data: { t: "A" },
		});
		const step = stepOf(content, id, "plain");
		await step("publish");
		await content.update({ id, rev: content.revOf(id), data: { t: "B" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "B" });
		await step("unpublish");
		const drafted = await content.get("plain", "en", id);
		// The draft is the live revision saved at the publish; it hides the columns (F18).
		expect(drafted).toMatchObject({ status: "draft", hasDraft: true, data: { t: "A" } });
		expect(drafted?.live).toEqual({ t: "B" });
		await content.update({ id, rev: content.revOf(id), data: { t: "C" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "A" });
		expect(content.entries.get(id)?.data).toEqual({ t: "C" });
		await step("discard");
		expect(await content.get("plain", "en", id)).toMatchObject({
			hasDraft: false,
			data: { t: "C" },
		});
	});

	it("keeps the first live revision on a plain collection until an unpublish clears it", async () => {
		const { content } = setup();
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A", u: "x" } });
		const step = stepOf(content, id, "plain");
		await step("publish");
		await content.update({ id, rev: content.revOf(id), data: { t: "B" } });
		await step("publish");
		await step("unpublish");
		// The live revision was made at the first publish and kept by the second.
		const drafted = await content.get("plain", "en", id);
		expect(drafted).toMatchObject({ hasDraft: true, data: { t: "A", u: "x" } });
		expect(content.entries.get(id)?.data).toEqual({ t: "B", u: "x" });
		// The stale draft overlays the columns: a column it lacks still shows.
		content.entries.get(id)!.data.extra = 1;
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "A", u: "x", extra: 1 });
	});

	it("creates no draft after an unpublish cleared the live revision and the entry was scheduled", async () => {
		const { content, clock } = setup();
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A" } });
		const step = stepOf(content, id, "plain");
		await step("publish");
		await step("unpublish");
		await step("discard");
		clock.t += 1;
		await step("schedule", { scheduledAt: at(60_000) });
		expect(await step("unpublish")).toMatchObject({ ok: true, state: { hasDraft: false } });
	});

	it("creates no draft on unpublish when no live revision exists", async () => {
		const { content, clock } = setup();
		content.plainCollections.add("plain");
		for (const collection of ["products", "plain"]) {
			const { id } = await content.create({ ...base, collection, data: {} });
			const step = stepOf(content, id, collection);
			clock.t += 1;
			await step("schedule", { scheduledAt: at(60_000) });
			expect(await step("unpublish")).toMatchObject({
				ok: true,
				state: { status: "draft", scheduledAt: null, hasDraft: false },
			});
		}
	});

	it("reads the live slug while a draft is pending", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), slug: "b" });
		expect(await content.get("products", "en", id)).toMatchObject({ slug: "a", hasDraft: true });
		expect(content.entries.get(id)?.slug).toBe("b");
	});

	it("writes a null slug", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await stepOf(content, id)("update", { slug: null });
		// The slug is staged in a draft, so the live slug is still read.
		expect(content.entries.get(id)?.slug).toBeNull();
	});

	it("frees a translation locale in Trash", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		const fr = await content.create({ ...base, locale: "fr", data: {}, translationOf: id });
		await expect(
			content.create({ ...base, locale: "fr", data: {}, translationOf: id }),
		).rejects.toMatchObject({ code: "emdash_conflict" });
		await content.trash("products", fr.id);
		await expect(
			content.create({ ...base, locale: "fr", data: {}, translationOf: id }),
		).resolves.toHaveProperty("rev");
	});

	it("keeps slugs unique per collection and locale, Trash included", async () => {
		const { content } = setup();
		const a = await content.create({ ...base, slug: "a", data: {} });
		await expect(content.create({ ...base, slug: "a", data: {} })).rejects.toMatchObject({
			code: "emdash_slug_conflict",
		});
		await content.create({ ...base, locale: "fr", slug: "a", data: {} });
		const b = await content.create({ ...base, slug: "b", data: {} });
		await expect(content.update({ id: b.id, rev: b.rev, slug: "a" })).rejects.toMatchObject({
			code: "emdash_slug_conflict",
		});
		await content.trash("products", a.id);
		await expect(content.create({ ...base, slug: "a", data: {} })).rejects.toMatchObject({
			code: "emdash_slug_conflict",
		});
		await content.permanentDelete("products", a.id);
		await expect(content.create({ ...base, slug: "a", data: {} })).resolves.toBeDefined();
	});

	it("runs the delete hook before the lookup, and checks collection and locale", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		content.blockDelete = () => "Never";
		expect(await content.trash("products", "nope")).toMatchObject({ reason: "blocked" });
		content.blockDelete = () => null;
		expect(await content.trash("other", id)).toMatchObject({ reason: "not_found" });
		await content.trash("products", id);
		expect(await content.permanentDelete("other", id)).toBe(false);
		expect(await content.getIncludingTrashed("products", "fr", id)).toBeNull();
		expect(await content.getIncludingTrashed("other", "en", id)).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", id)).not.toHaveProperty(
			"references",
		);
		await expect(
			content.revertStep({ collection: "products", locale: "en", id, rev: "any", step: "discard" }),
		).rejects.toMatchObject({ code: "emdash_not_found" });
	});

	it("never lets a hook refuse a discard or an update", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		content.blockStep = () => "No";
		const step = stepOf(content, id);
		expect(await step("update", { data: { a: 1 } })).toMatchObject({ ok: true });
		expect(await step("discard")).toMatchObject({ ok: true });
	});
});

describe("FakeContent as EmDash schedules and revises (M5b)", () => {
	const at = (ms: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + ms).toISOString();
	function setup() {
		const clock = { t: Date.parse("2026-10-07T10:00:00Z") };
		const content = new FakeContent();
		content.now = () => clock.t;
		return { content, clock };
	}
	const base = { collection: "products", locale: "en" };

	it("encodes the revision as EmDash does: base64 of version and updatedAt", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		expect(rev).toBe(btoa(`1:${at(0)}`));
		expect(decodeRev(rev)).toEqual({ version: 1, updatedAt: at(0) });
		expect(encodeRev(1, at(0))).toBe(rev);
		expect(content.revOf(id)).toBe(rev);
		expect(decodeRev("not base64!")).toBeNull();
		expect(decodeRev(btoa("x:2026-10-07T10:00:00.000Z"))).toBeNull();
		expect(decodeRev(btoa("3:"))).toBeNull();
	});

	it("schedules without a new version: only updatedAt moves, so a standing clock keeps the revision", async () => {
		const { content, clock } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const same = await content.schedule({ ...base, id, rev, scheduledAt: at(120_000) });
		expect(same).toEqual({ ok: true, rev });
		clock.t += 5;
		const moved = await content.schedule({ ...base, id, rev, scheduledAt: at(180_000) });
		expect(moved.ok && decodeRev(moved.rev)).toEqual({ version: 1, updatedAt: at(5) });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "scheduled",
			scheduledAt: at(180_000),
		});
		expect(content.calls).toEqual([`create:${id}`, `schedule:${id}`, `schedule:${id}`]);
	});

	it("keeps a published entry published with its draft due, and an update keeps the schedule", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), data: { title: "B" } });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		await content.update({ id, rev: content.revOf(id), data: { title: "C" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
			scheduledAt: at(60_000),
			data: { title: "C" },
			live: { title: "A" },
		});
	});

	it("refuses a schedule that is stale, locked, refused by a hook or not in the future", async () => {
		const { content, clock } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: {} });
		const input = { ...base, id, rev, scheduledAt: at(60_000) };
		expect(await content.schedule({ ...input, rev: "stale" })).toEqual({
			ok: false,
			reason: "conflict",
		});
		content.locked.add(id);
		expect(await content.schedule(input)).toEqual({ ok: false, reason: "locked" });
		content.locked.clear();
		content.blockStep = (s) => (s === "schedule" ? "Not on Fridays" : null);
		await expect(content.schedule(input)).rejects.toMatchObject({
			code: "emdash_schedule_rejected",
		});
		content.blockStep = () => null;
		await expect(content.schedule({ ...input, scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		expect(content.calls).toEqual([`create:${id}`]);
	});

	it("unschedules without a new version, and does nothing to an entry without a schedule", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		const step = () =>
			content.revertStep({ ...base, id, rev: content.revOf(id), step: "unschedule" });
		const before = content.revOf(id);
		expect(await step()).toMatchObject({ ok: true, state: { rev: before, status: "draft" } });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		content.blockStep = () => "never asked";
		clock.t += 1;
		const unscheduled = await step();
		expect(unscheduled).toMatchObject({
			ok: true,
			state: { status: "draft", scheduledAt: null },
		});
		expect(unscheduled.ok && decodeRev(unscheduled.state.rev)).toEqual({
			version: 1,
			updatedAt: at(2),
		});
	});

	it("changes terms through the terms route without moving the revision (F8)", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, data: {}, taxonomies: { tag: ["old"] } });
		content.setTerms(id, "tag", ["new"]);
		expect(content.revOf(id)).toBe(rev);
		expect(content.entries.get(id)?.taxonomies.tag).toEqual(["new"]);
	});

	it("publishes due entries as the scheduler does: one version, live, no draft or schedule", async () => {
		const { content, clock } = setup();
		const draft = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const live = await content.create({ ...base, slug: "b", data: { title: "B" } });
		await content.publish({ id: live.id, rev: content.revOf(live.id) });
		await content.update({ id: live.id, rev: content.revOf(live.id), data: { title: "B2" } });
		const trashed = await content.create({ ...base, slug: "c", data: {} });
		const later = await content.create({ ...base, slug: "d", data: {} });
		clock.t += 1;
		for (const id of [draft.id, live.id, trashed.id]) {
			await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		}
		await content.schedule({
			...base,
			id: later.id,
			rev: content.revOf(later.id),
			scheduledAt: at(120_000),
		});
		await content.trash("products", trashed.id);
		const versions = new Map([...content.entries.values()].map((e) => [e.id, e.rev]));
		expect(content.runScheduled()).toEqual([]);
		clock.t = Date.parse(at(60_000));
		expect(content.runScheduled()).toEqual([draft.id, live.id]);
		for (const id of [draft.id, live.id]) {
			expect(content.entries.get(id)?.rev).toBe((versions.get(id) ?? 0) + 1);
			expect(await content.get("products", "en", id)).toMatchObject({
				status: "published",
				hasDraft: false,
				scheduledAt: null,
				updatedAt: at(60_000),
			});
		}
		expect((await content.get("products", "en", live.id))?.data).toEqual({ title: "B2" });
		expect(content.entries.get(trashed.id)).toMatchObject({ status: "scheduled", trashed: true });
		expect(content.entries.get(later.id)).toMatchObject({ status: "scheduled" });
	});

	it("unschedules a due entry whose publish a hook refuses, as the scheduler does", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		clock.t = Date.parse(at(60_000));
		expect(content.runScheduled()).toEqual([]);
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "draft",
			scheduledAt: null,
		});
		expect(content.entries.get(id)?.rev).toBe(1);
	});
});
