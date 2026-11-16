import type { StorageCollection } from "emdash";
import { describe, expect, it } from "vitest";
import { kvCollection, pluginCollections } from "../../src/emdash/storage.js";
import { MemoryKv } from "./fakes.js";

/** MemoryKv already has the StorageCollection methods the wrapper calls. */
function asStorage(kv: MemoryKv<unknown>): StorageCollection {
	return kv as unknown as StorageCollection;
}

describe("kvCollection", () => {
	it("passes compareAndDelete through with the expected revision", async () => {
		const kv = kvCollection<{ n: number }>(asStorage(new MemoryKv<unknown>()));
		await kv.put("c", { n: 9 });
		const c = await kv.getVersioned("c");
		expect(await kv.compareAndDelete("c", "0")).toEqual({ applied: false });
		expect(await kv.get("c")).toEqual({ n: 9 });
		expect(await kv.compareAndDelete("c", c!.revision)).toEqual({ applied: true });
		expect(await kv.get("c")).toBeNull();
	});

	it("passes reads, writes, deletes and queries through", async () => {
		const raw = new MemoryKv<unknown>();
		const kv = kvCollection<{ n: number; tag: string }>(asStorage(raw));
		await kv.put("a", { n: 1, tag: "x" });
		await kv.put("b", { n: 2, tag: "y" });
		expect(await kv.get("a")).toEqual({ n: 1, tag: "x" });
		const v = await kv.getVersioned("a");
		expect(await kv.compareAndSet("a", v!.revision, { n: 3, tag: "x" })).toMatchObject({
			applied: true,
		});
		const page = await kv.query({ where: { tag: "x" }, orderBy: { n: "asc" } });
		expect(page.items).toEqual([{ id: "a", data: { n: 3, tag: "x" } }]);
		expect((await kv.query({ limit: 10 })).items).toHaveLength(2);
		expect(await kv.deleteMany(["a"])).toBe(1);
		expect(await kv.delete("b")).toBe(true);
	});
});

describe("pluginCollections", () => {
	it("requires the jobs, records, links, media, journal and journalMedia collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s, links: s, media: s })).toThrow(
			"storage collections",
		);
		const all = { jobs: s, records: s, links: s, media: s, journal: s, journalMedia: s };
		const { journal: _j, ...withoutJournal } = all;
		const { journalMedia: _m, ...withoutJournalMedia } = all;
		expect(() => pluginCollections(withoutJournal)).toThrow("storage collections");
		expect(() => pluginCollections(withoutJournalMedia)).toThrow("storage collections");
		expect(
			Object.keys(
				pluginCollections({
					jobs: s,
					records: s,
					links: s,
					media: s,
					journal: s,
					journalMedia: s,
				}),
			),
		).toEqual(["jobs", "records", "links", "mediaMap", "journal", "journalMedia"]);
	});
});
