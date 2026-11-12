/**
 * The link hand-back keeps the owner stamp only while the link it replaces still carries it
 * (spec M5c Ruling 31): a rollback of the owner's job never re-stamps a link another owner's
 * record dropped the stamp from (final review A, probes P1 and P2).
 */
import { describe, expect, it } from "vitest";
import { createRollback } from "../../src/engine/rollback.js";
import type { Job, LinkRow, RecordRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	runToEnd,
	setup,
} from "./rollback-fixture.js";

const items = (keys: number[], price = (i: number) => i): Row[] =>
	keys.map((i) => ({ sku: `K${i}`, name: `Item ${i}`, price: price(i) }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const A = (action: "trash" | "unpublish") => ({
	extra: { rules: { owner: "a", missing: { action } } },
	sourceId: "feed-a",
});
const B = { extra: { rules: { owner: "b" } } };
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
async function rollBack(deps: Deps, job: Job) {
	const { rollback } = await createRollback(deps, { id: job.id });
	await runToEnd(deps, rollback.id);
	return records(deps, rollback.id);
}
const rowFor = (rows: RecordRow[], key: string) => rows.find((r) => r.sourceKey === key);

describe("the rollback's link hand-back and the owner stamp (M5c Ruling 31)", () => {
	it("P1: rolling back the owner's update leaves a stamp another owner dropped dropped", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), A("trash"));
		const a2 = await importRows(
			deps,
			items(range(0, 8), (i) => (i === 7 ? 70 : i)),
			A("trash"),
		);
		expect(a2.counters.updated).toBe(1);
		// B's feed holds K7: its record drops A's stamp (Ruling 21).
		await importRows(
			deps,
			items([7], () => 70),
			B,
		);
		expect(await linkOf(deps, "K7")).not.toHaveProperty("owner");
		const rows = await rollBack(deps, a2);
		expect(rowFor(rows, "K7")?.status).toBe("reverted");
		const after = await linkOf(deps, "K7");
		expect(after).not.toHaveProperty("owner");
		expect(after).not.toHaveProperty("ownerSource");
		// A's next run without K7 does not count it, so B's entry stays.
		const a3 = await importRows(deps, items(range(0, 7)), A("trash"));
		expect(a3.missing).toMatchObject({ owned: 7, found: 0, removed: 0 });
		expect(entryOf(deps, "K7").trashed).toBe(false);
	});

	it("P2: rolling back the owner's trash leaves a stamp dropped on missing_trashed dropped", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), A("trash"));
		const a2 = await importRows(deps, items(range(0, 7)), A("trash"));
		expect(a2.counters.removed).toBe(1);
		const b = await importRows(deps, items([7]), B);
		expect((await records(deps, b.id))[0]?.errors?.[0]?.code).toBe("missing_trashed");
		expect(await linkOf(deps, "K7")).not.toHaveProperty("owner");
		const rows = await rollBack(deps, a2);
		expect(rowFor(rows, "K7")).toMatchObject({ status: "reverted", action: "restore" });
		expect(entryOf(deps, "K7")).toMatchObject({ trashed: false, status: "published" });
		const after = await linkOf(deps, "K7");
		expect(after).not.toHaveProperty("owner");
		expect(after).not.toHaveProperty("ownerSource");
		expect(after).not.toHaveProperty("missing");
		const a3 = await importRows(deps, items(range(0, 7)), A("trash"));
		expect(a3.missing).toMatchObject({ owned: 7, found: 0, removed: 0 });
		expect(entryOf(deps, "K7").trashed).toBe(false);
	});

	for (const action of ["trash", "unpublish"] as const) {
		it(`keeps the stamp and its source when the link still carries the owner (${action})`, async () => {
			const { deps } = setup();
			await importRows(deps, items(range(0, 8)), A(action));
			const a2 = await importRows(deps, items(range(0, 7)), A(action));
			expect(a2.counters.removed).toBe(1);
			const rows = await rollBack(deps, a2);
			expect(rowFor(rows, "K7")?.status).toBe("reverted");
			expect(await linkOf(deps, "K7")).toMatchObject({ owner: "a", ownerSource: "feed-a" });
			expect(await linkOf(deps, "K7")).not.toHaveProperty("missing");
			// Still A's: its next run without K7 removes it again.
			const a3 = await importRows(deps, items(range(0, 7)), A(action));
			expect(a3.counters.removed).toBe(1);
		});
	}
});
