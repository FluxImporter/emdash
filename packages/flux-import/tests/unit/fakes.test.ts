import { describe, expect, it } from "vitest";
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
		await content.publish({ id, rev: "1" });
		await content.update({ id, rev: "2", data: { title: "B" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
			live: { title: "A" },
			data: { title: "B" },
			updatedAt: at(1000),
		});
		await content.update({ id, rev: "3", taxonomies: { tag: ["new"] } });
		expect((await content.get("products", "en", id))?.live).toEqual({ title: "A" });

		content.plainCollections.add("plain");
		const plain = await content.create({ ...base, collection: "plain", data: { title: "A" } });
		await content.publish({ id: plain.id, rev: "1" });
		await content.update({ id: plain.id, rev: "2", data: { title: "B" } });
		expect(await content.get("plain", "en", plain.id)).toMatchObject({
			hasDraft: false,
			pendingPublish: false,
			data: { title: "B" },
		});
	});

	it("moves entries to Trash, hides them from reads and deletes them for good", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: { flux_source_id: "K" } });
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
			rev: "1",
			trashed: true,
		});
		expect((await content.trash("products", id)).ok).toBe(false);
		expect(await content.permanentDelete("products", id)).toBe(true);
		expect(content.entries.has(id)).toBe(false);
	});

	it("runs revert steps with revision checks, hook refusals and EmDash's draft rules", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const step = (rev: string, s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({ ...base, id, rev, step: s, ...extra });
		expect(await step("9", "publish")).toMatchObject({ ok: false, reason: "conflict" });
		const published = await step("1", "publish");
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		const unpublished = await step("2", "unpublish");
		// As EmDash: the unpublish creates a draft from the live revision (spec M5a F18).
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		expect(await step("3", "discard")).toMatchObject({ ok: true, state: { hasDraft: false } });
		await expect(step("4", "schedule", { scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		const scheduled = await step("4", "schedule", { scheduledAt: at(60_000) });
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at(60_000) },
		});
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		expect(await step("5", "publish")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not on Fridays",
		});
		const updated = await step("5", "update", { data: { title: "B" }, slug: "b" });
		expect(updated).toMatchObject({ ok: true, state: { hasDraft: true } });
		expect(content.entries.get(id)).toMatchObject({ slug: "b", data: { title: "B" } });
	});
});
