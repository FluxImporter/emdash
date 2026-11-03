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
