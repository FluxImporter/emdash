import { describe, expect, it } from "vitest";
import { MemoryKv } from "./fakes.js";

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
