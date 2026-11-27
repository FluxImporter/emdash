import { describe, expect, it } from "vitest";
import type { RecordRow } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { listRecords, recordPage } from "../../src/plugin/service.js";
import { MemoryKv, makeDeps } from "./fakes.js";

async function setup(n: number) {
	const { deps } = makeDeps();
	const records = new MemoryKv<RecordRow>(STORAGE.records.indexes);
	for (let seq = n; seq >= 1; seq--) {
		const status = seq % 2 === 0 ? "planned" : "failed";
		await records.put(`J1:${seq}`, {
			jobId: "J1",
			seq,
			start: 0,
			end: 0,
			status,
			sourceKey: `K${seq}`,
			entryId: null,
			updatedAt: "",
		});
	}
	return { deps: { ...deps, records }, records };
}

describe("recordPage (M6c)", () => {
	it("pages one status by seq, limit rows at a time, without reading the job", async () => {
		const { deps } = await setup(30);
		const first = await recordPage(deps, { id: "J1", status: "planned", limit: 10 });
		expect(first.items.map((r) => r.seq)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
		expect(first.hasMore).toBe(true);
		const second = await recordPage(deps, {
			id: "J1",
			status: "planned",
			limit: 10,
			cursor: first.cursor as string,
		});
		expect(second.items.map((r) => r.seq)).toEqual([22, 24, 26, 28, 30]);
		expect(second.hasMore).toBe(false);
	});

	it("refuses a limit outside 1-100, and listRecords keeps its 50 and its job check", async () => {
		const { deps } = await setup(60);
		for (const limit of [0, 101, 1.5]) {
			await expect(recordPage(deps, { id: "J1", limit })).rejects.toThrow(RangeError);
		}
		await expect(listRecords(deps, { id: "J1" })).rejects.toMatchObject({ code: "not_found" });
		await deps.jobs.put("J1", {} as never);
		expect((await listRecords(deps, { id: "J1" })).items).toHaveLength(50);
		expect((await listRecords(deps, { id: "J1", limit: 5 })).items).toHaveLength(5);
	});
});
