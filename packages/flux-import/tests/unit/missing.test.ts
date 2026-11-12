import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { laterJob, MISSING_MESSAGES } from "../../src/engine/missing.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import { type Job, journalKey, type LinkRow, type RecordRow } from "../../src/engine/types.js";
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
} from "./rollback-fixture.js";

const items = (keys: number[]): Row[] =>
	keys.map((i) => ({ sku: `K${i}`, name: `Item ${i}`, price: i }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const rules = (
	action: "trash" | "unpublish",
	extra: Record<string, unknown> = {},
	owner = "shop",
) => ({
	rules: { owner, missing: { action, ...extra } },
});
const opts = (
	action: "trash" | "unpublish",
	more: StartOptions = {},
	extra: Record<string, unknown> = {},
) => ({
	...more,
	extra: { ...rules(action, extra), ...more.extra },
});
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
/** The rows the missing phase wrote, by key. */
const missingRows = async (deps: Deps, job: Job) => {
	const from = job.missing?.fromSeq ?? Number.POSITIVE_INFINITY;
	return new Map(
		(await records(deps, job.id))
			.filter((r) => r.seq >= from)
			.map((r) => [r.sourceKey, r] as const),
	);
};
const codes = (row: RecordRow | undefined) =>
	[...(row?.warnings ?? []), ...(row?.errors ?? [])].map((w) => w.code);
/** An editor's change through the content API, published as the admin publishes it. */
async function edit(deps: Deps, key: string, data: Record<string, unknown>, publish = true) {
	const id = entryOf(deps, key).id;
	await deps.content.update({ id, rev: deps.content.revOf(id), data });
	if (publish) await deps.content.publish({ id, rev: deps.content.revOf(id) });
}
/** Runs batches until the job reaches the act stage. */
async function untilAct(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 100; i++) {
		const job = await runBatch(deps, id, "h");
		if (job.missing?.stage === "act") return job;
		if (job.status !== "running" && job.status !== "created") break;
	}
	throw new Error("never reached the act stage");
}
/** Eight owned, published entries K0-K7. */
async function eight(action: "trash" | "unpublish", extra: Record<string, unknown> = {}) {
	const made = setup();
	await importRows(made.deps, items(range(0, 8)), opts(action, {}, extra));
	return made;
}

describe("entering the missing phase (M5c)", () => {
	it("runs after a completed first pass and finds nothing on the first run", async () => {
		const { deps } = setup();
		const job = await importRows(deps, items(range(0, 4)), opts("trash"));
		expect(job).toMatchObject({
			status: "completed",
			phase: "missing",
			missing: {
				stage: "done",
				fromSeq: 4,
				owned: 4,
				found: 0,
				rows: 0,
				removed: 0,
				verdict: "act",
			},
		});
	});

	it("is skipped when a record had no readable key", async () => {
		const { deps } = await eight("trash");
		const body = items(range(0, 6)).concat([{ sku: "", name: "No key", price: 1 }]);
		const job = await importRows(deps, body, opts("trash"));
		expect(job.missing).toMatchObject({ stage: "done", verdict: "skipped" });
		expect(job.warnings).toContain(
			"Missing entries were not checked: 1 records had no readable key (or were skipped by the reader), so their entries may be in the feed",
		);
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("is skipped when no record had a key, and not entered with missing: false", async () => {
		const { deps } = await eight("trash");
		const filtered = await importRows(deps, items(range(0, 8)), {
			extra: { ...rules("trash"), source: { format: "csv", filter: "false" } },
		});
		expect(filtered.missing).toMatchObject({ verdict: "skipped" });
		expect(filtered.warnings).toContain(
			"Missing entries were not checked: the import read no record with a key",
		);
		const off = await importRows(deps, items(range(0, 2)), { ...opts("trash"), missing: false });
		expect(off).not.toHaveProperty("missing");
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("is never entered by a pass cancelled part way", async () => {
		const { deps } = await eight("trash");
		const job = await start(deps, csv(items([0, 1])), {
			...opts("trash"),
			batchSize: 1,
		});
		const first = await runBatch(deps, job.id, "h");
		expect(first).toMatchObject({ status: "running", cursor: { seq: 1 } });
		await transitionJob(deps, job.id, "cancel");
		const stored = await runBatch(deps, job.id, "h");
		expect(stored.status).toBe("cancelled");
		expect(stored).not.toHaveProperty("missing");
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});
});

describe("unpublish and trash (M5c)", () => {
	it("unpublishes the owned entries the feed no longer holds, journals and marks them", async () => {
		const { deps } = await eight("unpublish");
		const job = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		expect(job.counters).toMatchObject({ unchanged: 6, removed: 2 });
		expect(job.missing).toMatchObject({
			stage: "done",
			owned: 8,
			found: 2,
			rows: 2,
			removed: 2,
			verdict: "act",
		});
		const rows = await missingRows(deps, job);
		for (const key of ["K6", "K7"]) {
			expect(rows.get(key)).toMatchObject({
				status: "removed",
				action: "unpublish",
				start: 0,
				end: 0,
			});
			const entry = entryOf(deps, key);
			expect(entry.status).toBe("draft");
			expect(await linkOf(deps, key)).toMatchObject({
				owner: "shop",
				jobId: job.id,
				writtenRev: deps.content.revOf(entry.id),
				missing: { jobId: job.id, action: "unpublish" },
			});
		}
		const journal = (await journalOf(deps, job.id)).filter(
			(j) => j.seq >= (job.missing?.fromSeq ?? 0),
		);
		expect(journal.map((j) => [j.kind, j.sourceKey, j.before?.status, j.before?.live])).toEqual([
			["update", "K6", "published", {}],
			["update", "K7", "published", {}],
		]);
		// A later run leaves marked links out.
		const again = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		expect(again.missing).toMatchObject({ owned: 6, found: 0 });
	});

	it("moves them to Trash, keeping the link's revision", async () => {
		const { deps } = await eight("trash");
		const before = await linkOf(deps, "K7");
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.counters.removed).toBe(1);
		expect(entryOf(deps, "K7").trashed).toBe(true);
		expect(await linkOf(deps, "K7")).toMatchObject({
			writtenRev: before.writtenRev,
			missing: { jobId: job.id, action: "trash" },
		});
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toMatchObject({
			kind: "trash",
			entryId: entryOf(deps, "K7").id,
			before: {
				rev: before.writtenRev,
				status: "published",
				scheduledAt: null,
				live: {},
				link: { owner: "shop" },
			},
		});
	});

	it("reports each call that does not land and deletes its journal row", async () => {
		const { deps } = await eight("unpublish");
		deps.content.locked.add(entryOf(deps, "K4").id);
		deps.content.blockStep = (_step, id) => (id === entryOf(deps, "K5").id ? "No." : null);
		deps.content.beforeStep = (step, id) => {
			// Another write lands between the read and the unpublish.
			if (step === "unpublish" && id === entryOf(deps, "K6").id) {
				const e = deps.content.entries.get(id);
				if (e) e.rev++;
			}
		};
		const job = await importRows(
			deps,
			items([0, 1, 2, 3, 7]),
			opts("unpublish", { missing: { maxPercent: 50 } }),
		);
		const rows = await missingRows(deps, job);
		expect(rows.get("K4")).toMatchObject({
			status: "locked",
			errors: [{ code: "locked", message: "Not changed: the entry is being edited (locked)" }],
		});
		expect(rows.get("K5")).toMatchObject({
			status: "failed",
			errors: [{ code: "missing_blocked", message: "Not changed: a plugin refused: No." }],
		});
		expect(rows.get("K6")).toMatchObject({
			status: "conflict",
			errors: [
				{ code: "missing_changed", message: "Not changed: the entry changed since it was read" },
			],
		});
		for (const key of ["K4", "K5", "K6"]) {
			expect(await deps.journal.get(journalKey(job.id, `products:en:${key}`)), key).toBeNull();
			expect(await linkOf(deps, key)).not.toHaveProperty("missing");
		}
	});

	it("fails the job on a job-level content error, as the import does", async () => {
		const { deps } = await eight("trash");
		deps.content.trash = async () => {
			throw new ContentWriteError("collection_missing", "Collection products is gone");
		};
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job).toMatchObject({
			status: "failed",
			error: { code: "collection_missing", message: "Collection products is gone" },
		});
		// Not saved as a failed row: the `writing` row stays for a resume to finish.
		expect((await missingRows(deps, job)).get("K7")).toMatchObject({ status: "writing" });
	});

	it("checks the lock before a trash, which does not check it", async () => {
		const { deps } = await eight("trash");
		deps.content.locked.add(entryOf(deps, "K7").id);
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect((await missingRows(deps, job)).get("K7")).toMatchObject({
			status: "locked",
			errors: [{ code: "locked", message: "Not changed: the entry is being edited (locked)" }],
		});
		expect(entryOf(deps, "K7").trashed).toBe(false);
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toBeNull();
	});

	it("leaves an entry trashed meanwhile, and a hook's refusal of the trash", async () => {
		const { deps } = await eight("trash");
		deps.content.blockDelete = (id) => (id === entryOf(deps, "K7").id ? "Keep it." : null);
		deps.content.beforeStep = (step, id) => {
			const e = deps.content.entries.get(id);
			if (step === "trash" && e?.data.flux_source_id === "K6") e.trashed = true;
		};
		const job = await importRows(deps, items(range(0, 6)), opts("trash"));
		const rows = await missingRows(deps, job);
		expect(codes(rows.get("K6"))).toEqual(["missing_gone"]);
		expect(rows.get("K7")).toMatchObject({
			status: "failed",
			errors: [{ code: "missing_blocked", message: "Not changed: a plugin refused: Keep it." }],
		});
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).toBeNull();
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toBeNull();
	});
});

describe("the threshold (M5c, Rulings 6, 22, 23)", () => {
	it("passes at the limit and refuses one past it, suggesting a percent that passes", async () => {
		const at = await eight("unpublish");
		const ok = await importRows(at.deps, items(range(0, 6)), opts("unpublish"));
		expect(ok.missing).toMatchObject({ found: 2, verdict: "act", removed: 2 });

		const { deps } = await eight("unpublish");
		const refused = await importRows(deps, items(range(0, 5)), opts("unpublish"));
		expect(refused.status).toBe("completed");
		expect(refused.missing).toMatchObject({
			stage: "done",
			found: 3,
			removed: 0,
			verdict: "refused",
		});
		expect(refused.warnings).toContain(
			"Missing entries were left alone: 3 of the 8 entries owner shop created before this import are not in the feed (38%), more than the limit of 25%. Check the feed, then import it again with the job option missing: { maxPercent: 38 } to apply it (with force: true for an unchanged URL source).",
		);
		expect([...deps.content.entries.values()].every((e) => e.status === "published")).toBe(true);
		const applied = await importRows(deps, items(range(0, 5)), {
			...opts("unpublish"),
			missing: { maxPercent: 38 },
		});
		expect(applied.missing).toMatchObject({ verdict: "act", removed: 3 });
	});

	it("leaves this job's creates out of the base, and counts the dry run's candidates", async () => {
		const { deps } = await eight("unpublish");
		// 5 of the 8 old ones and 4 new ones: 3 of 8 missing is 38%, though 3 of the 12 owned is 25%.
		const real = await importRows(
			deps,
			items([...range(0, 5), ...range(8, 12)]),
			opts("unpublish"),
		);
		expect(real.missing).toMatchObject({ owned: 12, found: 3, verdict: "refused" });
		const other = await eight("unpublish");
		const dry = await importRows(other.deps, items(range(0, 6)), {
			...opts("unpublish"),
			dryRun: true,
		});
		expect(dry.missing).toMatchObject({ owned: 8, found: 2, verdict: "act", removed: 2 });
		// A dry run's planned creates made no links, so they leave the base alone: 2 of 8 passes.
		const creating = await importRows(other.deps, items([...range(0, 6), ...range(8, 12)]), {
			...opts("unpublish"),
			dryRun: true,
		});
		expect(creating.counters.created).toBe(4);
		expect(creating.missing).toMatchObject({ owned: 8, found: 2, verdict: "act" });
	});

	it("refuses 1 of 3 and accepts 1 of 4 by default", async () => {
		for (const [owned, verdict] of [
			[3, "refused"],
			[4, "act"],
		] as const) {
			const { deps } = setup();
			await importRows(deps, items(range(0, owned)), opts("trash"));
			const job = await importRows(deps, items(range(0, owned - 1)), opts("trash"));
			expect(job.missing?.verdict, String(owned)).toBe(verdict);
		}
		// 1 of 3 is 33.3%: the suggestion rounds up to 34, which passes.
		const { deps } = setup();
		await importRows(deps, items(range(0, 3)), opts("trash"));
		const refused = await importRows(deps, items(range(0, 2)), opts("trash"));
		expect(refused.warnings?.at(-1)).toContain("(34%)");
		expect(refused.warnings?.at(-1)).toContain("missing: { maxPercent: 34 }");
		const applied = await importRows(deps, items(range(0, 2)), {
			...opts("trash"),
			missing: { maxPercent: 34 },
		});
		expect(applied.missing).toMatchObject({ verdict: "act", removed: 1 });
	});

	it("ends at the count when nothing is found, writing no row for a gone entry", async () => {
		const { deps } = await eight("trash");
		deps.content.entries.delete(entryOf(deps, "K7").id);
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.missing).toMatchObject({
			stage: "done",
			owned: 8,
			found: 0,
			rows: 0,
			verdict: "act",
		});
		expect(await missingRows(deps, job)).toEqual(new Map());
	});

	it("counts edited and pending entries toward found, but not gone ones", async () => {
		const { deps } = await eight("trash");
		await edit(deps, "K5", { price: 55 });
		// An editor's draft moves _rev, so the order of the checks makes it edited (spec "Verdicts").
		await edit(deps, "K6", { price: 66 }, false);
		deps.content.entries.delete(entryOf(deps, "K7").id);
		// K5 and K6 are left alone, yet 2 of 8 count: the feed lost them (Ruling 22).
		const job = await importRows(deps, items(range(0, 4).concat([4])), opts("trash"));
		expect(job.missing).toMatchObject({ found: 2, verdict: "act", removed: 0 });
		// The 5 records in the feed and the 3 left-alone missing rows (2 edited, 1 gone).
		expect(job.counters.unchanged).toBe(8);
		expect(job.counters.removed ?? 0).toBe(0);
		const rows = await missingRows(deps, job);
		expect(codes(rows.get("K5"))).toEqual(["missing_edited"]);
		expect(codes(rows.get("K6"))).toEqual(["missing_edited"]);
		expect(codes(rows.get("K7"))).toEqual(["missing_gone"]);
		expect(rows.get("K5")?.warnings?.[0]?.message).toBe(MISSING_MESSAGES.missing_edited);
		expect(rows.get("K7")?.warnings?.[0]?.message).toBe(MISSING_MESSAGES.missing_gone);
	});

	it("leaves the importer's own pending draft, and counts it", async () => {
		const { deps } = await eight("trash");
		// The importer's own draft: an update saved with publish: false, at the link's revision.
		await importRows(
			deps,
			items(range(0, 8)).map((r) => (r.sku === "K7" ? { ...r, price: 70 } : r)),
			{
				...opts("trash"),
				publish: false,
			},
		);
		const k7 = entryOf(deps, "K7");
		expect((await linkOf(deps, "K7")).writtenRev).toBe(deps.content.revOf(k7.id));
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.missing).toMatchObject({ found: 1, verdict: "act", removed: 0 });
		const row = (await missingRows(deps, job)).get("K7");
		expect(row).toMatchObject({
			status: "unchanged",
			warnings: [{ code: "missing_pending", message: MISSING_MESSAGES.missing_pending }],
		});
		expect(k7.trashed).toBe(false);
	});

	it("refuses a feed that lost most entries even when all of them are edited", async () => {
		const { deps } = await eight("trash");
		for (const key of ["K5", "K6", "K7"]) await edit(deps, key, { price: 99 });
		const job = await importRows(deps, items(range(0, 5)), opts("trash"));
		expect(job.missing).toMatchObject({ found: 3, verdict: "refused" });
	});
});

describe("candidates (M5c)", () => {
	it("leaves out marked links, later jobs' links and other owners' entries", async () => {
		const { deps } = await eight("trash");
		// K7's link names a later job; K6's is marked by an earlier run.
		await deps.links.put("products:en:K7", { ...(await linkOf(deps, "K7")), jobId: "id99999999" });
		await deps.links.put("products:en:K6", {
			...(await linkOf(deps, "K6")),
			missing: { jobId: "id00000001", action: "trash", at: "2026-10-07T10:00:00.000Z" },
		});
		const job = await importRows(deps, items(range(0, 6)), opts("trash"));
		expect(job.missing).toMatchObject({ owned: 6, found: 0 });
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(entryOf(deps, "K7").trashed).toBe(false);
		expect(laterJob("01J0000000AAAAAAAAAAAAAAAA", "01J0000000BBBBBBBBBBBBBBBB")).toBe(true);
		expect(laterJob("01J0000000BBBBBBBBBBBBBBBB", "01J0000000AAAAAAAAAAAAAAAA")).toBe(true);
		expect(laterJob("01H0000000BBBBBBBBBBBBBBBB", "01J0000000AAAAAAAAAAAAAAAA")).toBe(false);
		expect(laterJob(undefined, "id00000002")).toBe(false);
		expect(laterJob("id00000002", "id00000002")).toBe(false);
		// This job's own links, whose ID is a ULID, are never a later job's.
		expect(laterJob("01J0000000AAAAAAAAAAAAAAAA", "01J0000000AAAAAAAAAAAAAAAA")).toBe(false);
	});

	it("counts a record that failed after its key as seen, and a filtered one as unseen", async () => {
		const { deps } = await eight("trash", { maxPercent: 50 });
		const body = items(range(0, 6)).concat([{ sku: "K6", name: "Item 6", price: "n/a" as never }]);
		const job = await importRows(deps, body, opts("trash", {}, { maxPercent: 50 }));
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(entryOf(deps, "K7").trashed).toBe(true);
		const filtered = await importRows(deps, items(range(0, 6)), {
			extra: {
				...rules("trash", { maxPercent: 50 }),
				source: { format: "csv", filter: "sku != 'K5'" },
			},
		});
		expect(filtered.counters.filtered).toBe(1);
		expect(entryOf(deps, "K5").trashed).toBe(true);
		expect(job.missing?.removed).toBe(1);
	});

	it("bounds the link pages of a batch by the lookup budget when every candidate is seen", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 60)), { ...opts("trash"), batchSize: 500 });
		// 59 of 60 in the feed: the count reads one entry, the act stage decides one.
		const job = await start(deps, csv(items(range(0, 59))), opts("trash"));
		const limits: number[] = [];
		const query = deps.links.query.bind(deps.links);
		deps.links.query = async (q) => {
			if (q.where?.owner !== undefined) limits.push(q.limit ?? 0);
			return query(q);
		};
		// A Workers-like batch: 4 entries and a lookup budget of 30 (6 reads).
		const perBatch: number[] = [];
		let stored = job;
		for (let i = 0; i < 500 && (stored.status === "running" || stored.status === "created"); i++) {
			const before = limits.length;
			stored = await runBatch(deps, job.id, "h", 4, 30);
			perBatch.push(limits.length - before);
		}
		expect(stored.status).toBe("completed");
		expect(stored.missing).toMatchObject({ stage: "done", owned: 60, found: 1, removed: 1 });
		expect(entryOf(deps, "K59").trashed).toBe(true);
		// The budget never cuts a page: it holds the batch's 4, or 3 after the one read or act.
		expect(limits.every((l) => l >= 3)).toBe(true);
		// A batch stops paging on the budget: a count page costs 2 calls and up to 4 reads of 5,
		// so after the first one a page starts only at 8 spent or less (5 pages); an act page
		// (4 × 41 and 2) never fits after the first.
		expect(Math.max(...perBatch)).toBeLessThanOrEqual(5);
		expect(perBatch.filter((n) => n > 1).length).toBeGreaterThan(0);
	});

	it("takes one whole page a batch when the budget is below what a page may cost", async () => {
		const { deps } = await eight("trash");
		const job = await start(deps, csv(items(range(0, 7))), opts("trash"));
		const limits: number[] = [];
		const query = deps.links.query.bind(deps.links);
		deps.links.query = async (q) => {
			if (q.where?.owner !== undefined) limits.push(q.limit ?? 0);
			return query(q);
		};
		let stored = job;
		for (let i = 0; i < 200 && (stored.status === "running" || stored.status === "created"); i++) {
			stored = await runBatch(deps, job.id, "h", 4, 10);
		}
		expect(stored.missing).toMatchObject({ stage: "done", owned: 8, found: 1, removed: 1 });
		expect(limits.every((l) => l >= 3)).toBe(true);
	});

	it("pages 101 owned links and their keys in seen queries of 50", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 101)), { ...opts("unpublish"), batchSize: 500 });
		const queries: unknown[] = [];
		const query = deps.records.query.bind(deps.records);
		deps.records.query = async (q) => {
			const keys = (q.where?.sourceKey as { in?: string[] } | undefined)?.in;
			if (keys) queries.push(keys.length);
			return query(q);
		};
		const job = await importRows(deps, items(range(1, 100)), {
			...opts("unpublish"),
			batchSize: 500,
		});
		expect(job.missing).toMatchObject({ owned: 101, found: 2, removed: 2 });
		expect(entryOf(deps, "K0").status).toBe("draft");
		expect(entryOf(deps, "K100").status).toBe("draft");
		expect(Math.max(...(queries as number[]))).toBeLessThanOrEqual(50);
	});

	it("refuses as a whole when another URL source created entries under the owner", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), { ...opts("trash"), sourceId: "src1" });
		for (const [sourceId, label] of [
			["src2", "src2"],
			[undefined, "an upload"],
		] as const) {
			const job = await importRows(deps, items(range(0, 7)), {
				...opts("trash"),
				...(sourceId ? { sourceId } : {}),
			});
			expect(job.missing, label).toMatchObject({ stage: "done", verdict: "refused", removed: 0 });
			expect(job.warnings).toContain(
				"Missing entries were left alone: owner shop also has entries created from another URL source (src1); give each feed its own owner",
			);
		}
		expect(entryOf(deps, "K7").trashed).toBe(false);
		const same = await importRows(deps, items(range(0, 7)), { ...opts("trash"), sourceId: "src1" });
		expect(same.missing?.removed).toBe(1);
	});

	it("never counts an entry another owner's record reached (Ruling 21)", async () => {
		const { deps } = await eight("trash");
		await importRows(deps, items([7]), { extra: { rules: { owner: "other" } } });
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.missing).toMatchObject({ owned: 7, found: 0 });
		expect(entryOf(deps, "K7").trashed).toBe(false);
	});
});

describe("verdicts (M5c)", () => {
	it("leaves drafts for unpublish and group roots with active translations for trash", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 4)), { ...opts("unpublish"), publish: false });
		await importRows(deps, items(range(4, 8)), opts("unpublish"));
		const job = await importRows(deps, items(range(1, 8)), opts("unpublish"));
		expect(codes((await missingRows(deps, job)).get("K0"))).toEqual(["missing_not_live"]);

		const t = await eight("trash");
		const root = entryOf(t.deps, "K7");
		await t.deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Sept" },
			translationOf: root.id,
		});
		const trash = await importRows(t.deps, items(range(0, 7)), opts("trash"));
		expect(codes((await missingRows(t.deps, trash)).get("K7"))).toEqual([
			"missing_has_translations",
		]);
		expect(root.trashed).toBe(false);
	});

	it("leaves an entry with someone's schedule", async () => {
		const { deps, clock } = await eight("trash");
		const id = entryOf(deps, "K7").id;
		await edit(deps, "K7", { price: 70 }, false);
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id,
			rev: deps.content.revOf(id),
			scheduledAt: new Date(clock.t + 3_600_000).toISOString(),
		});
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(codes((await missingRows(deps, job)).get("K7"))).toEqual(["missing_edited"]);
	});

	it("takes the scheduler's publish of the importer's schedule as the importer's, while its journal holds", async () => {
		for (const purged of [false, true]) {
			const { deps, clock } = setup();
			ticking(clock);
			const at = new Date(clock.t + 3_600_000).toISOString();
			await importRows(deps, items(range(0, 8)), opts("unpublish"));
			const scheduled = await importRows(
				deps,
				items(range(0, 8)).map((r) => ({ ...r, price: (r.price ?? 0) + 100 })),
				{
					extra: { ...rules("unpublish"), publishAt: { expr: `'${at}'` } },
				},
			);
			clock.t = Date.parse(at) + 60_000;
			deps.content.runScheduled();
			if (purged) await deps.journal.delete(journalKey(scheduled.id, "products:en:K7"));
			const job = await importRows(
				deps,
				items(range(0, 7)).map((r) => ({ ...r, price: (r.price ?? 0) + 100 })),
				opts("unpublish"),
			);
			const row = (await missingRows(deps, job)).get("K7");
			if (purged) expect(codes(row), "purged").toEqual(["missing_edited"]);
			else expect(row).toMatchObject({ status: "removed", action: "unpublish" });
		}
	});

	it("never removes more than the count found (Ruling 20)", async () => {
		const { deps } = await eight("trash");
		const k6 = entryOf(deps, "K6");
		const saved = structuredClone(k6);
		deps.content.entries.delete(k6.id);
		const job = await start(deps, csv(items(range(0, 6))), opts("trash"));
		const stored = await untilAct(deps, job.id);
		expect(stored.missing).toMatchObject({ found: 1 });
		// The entry comes back between the stages, as the importer left it.
		deps.content.entries.set(saved.id, saved);
		const done = await runToEnd(deps, job.id);
		const rows = await missingRows(deps, done);
		expect([...rows.values()].map((r) => r.status).sort()).toEqual(["removed", "unchanged"]);
		const left = [...rows.values()].find((r) => r.status === "unchanged");
		expect(codes(left)).toEqual(["missing_over_count"]);
		expect(left?.warnings?.[0]?.message).toBe(
			"Left alone: more entries were missing than when the import counted them; run the import again",
		);
		expect(done.counters.removed).toBe(1);
	});
});

/** Drops a stopped batch's lease, so the next batch resumes the job at once. */
async function unlease(deps: Deps, id: string) {
	const j = await deps.jobs.get(id);
	if (j) await deps.jobs.put(id, { ...j, lease: null });
}

describe("stops part way (M5c, Ruling 29 M3)", () => {
	it("fails after three unexpected errors in the act stage, and resumes where it stopped", async () => {
		const { deps } = await eight("unpublish", { maxPercent: 50 });
		const job = await start(deps, csv(items(range(0, 5))), {
			...opts("unpublish", {}, { maxPercent: 50 }),
			batchSize: 1,
		});
		let stored = await untilAct(deps, job.id);
		// One entry decided, then the next entry's read throws in each of three batches.
		stored = await runBatch(deps, job.id, "h");
		expect(stored.missing).toMatchObject({ stage: "act", rows: 1, removed: 1 });
		const get = deps.content.get.bind(deps.content);
		deps.content.get = async () => {
			throw new Error("D1 went away");
		};
		for (let i = 0; i < 3; i++) {
			await expect(runBatch(deps, job.id, "h")).rejects.toThrow("D1 went away");
			await unlease(deps, job.id);
		}
		const failed = await deps.jobs.get(job.id);
		expect(failed).toMatchObject({
			status: "failed",
			phase: "missing",
			missing: { stage: "act", rows: 1 },
		});
		deps.content.get = get;
		await transitionJob(deps, job.id, "resume");
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { removed: 3 } });
		expect(done.missing).toMatchObject({ stage: "done", found: 3, rows: 3, removed: 3 });
		const rows = await missingRows(deps, done);
		expect([...rows.keys()].sort()).toEqual(["K5", "K6", "K7"]);
		expect([...rows.values()].every((r) => r.status === "removed")).toBe(true);
		for (const key of ["K5", "K6", "K7"]) expect(entryOf(deps, key).status, key).toBe("draft");
	});

	it("finishes an unpublish that stopped after its write-ahead, changing the entry once", async () => {
		const { deps } = await eight("unpublish");
		const k7 = entryOf(deps, "K7");
		const before = deps.content.revOf(k7.id);
		const cas = deps.journal.compareAndSet.bind(deps.journal);
		let stop = true;
		deps.journal.compareAndSet = async (key, revision, value) => {
			const result = await cas(key, revision, value);
			if (
				stop &&
				value.kind === "update" &&
				value.sourceKey === "K7" &&
				value.jobId !== undefined
			) {
				stop = false;
				throw new Error("stop");
			}
			return result;
		};
		const job = await start(deps, csv(items(range(0, 7))), opts("unpublish"));
		for (let i = 0; i < 100 && stop; i++) {
			try {
				await runBatch(deps, job.id, "h");
			} catch (e) {
				if ((e as Error).message !== "stop") throw e;
				await unlease(deps, job.id);
			}
		}
		expect(stop).toBe(false);
		// Stopped with the journal row written and nothing else.
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toMatchObject({ seq: 7 });
		expect(k7.status).toBe("published");
		const done = await runToEnd(deps, job.id);
		expect(done.missing).toMatchObject({ stage: "done", rows: 1, removed: 1 });
		expect((await missingRows(deps, done)).get("K7")).toMatchObject({
			seq: 7,
			status: "removed",
			action: "unpublish",
		});
		expect(k7.status).toBe("draft");
		const journal = await journalOf(deps, done.id);
		expect(journal.filter((j) => j.sourceKey === "K7")).toEqual([
			expect.objectContaining({
				kind: "update",
				seq: 7,
				before: expect.objectContaining({ rev: before, status: "published" }),
			}),
		]);
		expect(deps.content.calls.filter((c) => c === `unpublish:${k7.id}`)).toHaveLength(1);
	});
});

describe("dry runs (M5c, Ruling 16)", () => {
	it("plan the same rows and write nothing, over the threshold too", async () => {
		const { deps } = await eight("trash");
		await edit(deps, "K7", { price: 77 });
		const links = JSON.stringify([...deps.links.rows.entries()]);
		const dry = await importRows(deps, items(range(0, 5)), { ...opts("trash"), dryRun: true });
		expect(dry.missing).toMatchObject({ found: 3, verdict: "refused", removed: 2 });
		expect(dry.warnings).toContain(
			"Missing entries: 3 of the 8 entries owner shop created before this import are not in the feed (38%), more than the limit of 25%, so a real run would leave them alone. Check the feed, then import it again with the job option missing: { maxPercent: 38 } to apply it (with force: true for an unchanged URL source).",
		);
		const rows = await missingRows(deps, dry);
		expect(rows.get("K5")).toMatchObject({
			status: "planned",
			action: "trash",
			changes: [{ field: "status", before: "published", after: "trashed" }],
		});
		expect(codes(rows.get("K7"))).toEqual(["missing_edited"]);
		expect(dry.counters.removed).toBe(2);
		expect(JSON.stringify([...deps.links.rows.entries()])).toBe(links);
		expect(await journalOf(deps, dry.id)).toEqual([]);
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("plan an unpublish as a change to draft", async () => {
		const { deps } = await eight("unpublish");
		const dry = await importRows(deps, items(range(0, 7)), { ...opts("unpublish"), dryRun: true });
		expect((await missingRows(deps, dry)).get("K7")).toMatchObject({
			status: "planned",
			action: "unpublish",
			changes: [{ field: "status", before: "published", after: "draft" }],
		});
	});
});
