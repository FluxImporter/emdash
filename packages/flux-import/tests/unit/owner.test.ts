import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import {
	type JournalEntry,
	journalKey,
	type LinkRow,
	type RecordRow,
	recordKey,
} from "../../src/engine/types.js";
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
	setup,
	start,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const lamp: Row = { sku: "B2", name: "Lamp", price: 5, tags: "sale", authors: "sam" };
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const owned = (owner: string, rules: Record<string, unknown> = {}) => ({
	extra: { rules: { owner, ...rules } },
});
/** Lists the link rows each save names. */
const countPuts = (deps: Deps) => {
	const puts: string[] = [];
	const put = deps.links.put.bind(deps.links);
	deps.links.put = async (id: string, row: LinkRow) => {
		puts.push(id);
		return put(id, row);
	};
	return puts;
};

describe("stamping the owner (M5c)", () => {
	it("stamps a create, with the URL source, and keeps the stamp on the same owner's writes", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { ...owned("shop"), sourceId: "src1" });
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop", ownerSource: "src1" });
		await importRows(deps, [{ ...desk, price: 11 }], owned("shop"));
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop", ownerSource: "src1" });
		// An unchanged record of the same owner puts nothing.
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 11 }], owned("shop"));
		expect(puts).toEqual([]);
	});

	it("stamps no entry without rules.owner, and never adopts one", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
		await importRows(deps, [{ ...desk, price: 12 }], owned("shop"));
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
		// An owned record on an unowned link has no stamp to drop, so it puts nothing.
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 12 }], owned("shop"));
		expect(puts).toEqual([]);
	});

	/** A stop right after the create returned: the job's link put fails once. */
	async function stopAfterCreate(deps: Deps, clock: { t: number }, jobId: string) {
		const put = deps.links.put.bind(deps.links);
		deps.links.put = async () => {
			throw new Error("stop");
		};
		await expect(runBatch(deps, jobId, "h1")).rejects.toThrow("stop");
		deps.links.put = put;
		// The lease of the stopped batch expires.
		clock.t += LEASE_GRACE_MS + 60_000;
	}

	it("stamps crash repair of a create its writing row names", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		await stopAfterCreate(deps, clock, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing", action: "create" });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop" });
	});

	it("stamps crash repair of a create the journal confirms", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		await stopAfterCreate(deps, clock, job.id);
		// The row lost the entry ID (a stop before its save); the journal still names the create.
		const key = recordKey(job.id, 0);
		const row = (await deps.records.get(key)) as RecordRow;
		await deps.records.put(key, { ...row, entryId: null });
		expect((await journalOf(deps, job.id))[0]).toMatchObject({ kind: "create", confirmed: true });
		await runToEnd(deps, job.id);
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop" });
	});

	it("does not stamp an entry crash repair adopted by its source ID alone", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		// A stop inside the create: the journal row never learns the entry.
		deps.content.afterWrite = () => {
			throw new Error("stop");
		};
		await expect(runBatch(deps, job.id, "h1")).rejects.toThrow("stop");
		deps.content.afterWrite = () => {};
		clock.t += LEASE_GRACE_MS + 60_000;
		await runToEnd(deps, job.id);
		const link = await linkOf(deps, "A1");
		expect(link.entryId).toBe(entryOf(deps, "A1").id);
		expect(link).not.toHaveProperty("owner");
	});

	it("does not stamp an entry a journal create names without confirming it", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		deps.content.afterWrite = () => {
			throw new Error("stop");
		};
		await expect(runBatch(deps, job.id, "h1")).rejects.toThrow("stop");
		deps.content.afterWrite = () => {};
		clock.t += LEASE_GRACE_MS + 60_000;
		// As an earlier repair leaves it: the entry named, found by its source ID only.
		const key = journalKey(job.id, "products:en:A1");
		const row = (await deps.journal.get(key)) as JournalEntry;
		await deps.journal.put(key, {
			...row,
			kind: "create",
			entryId: entryOf(deps, "A1").id,
			confirmed: false,
		});
		await runToEnd(deps, job.id);
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
	});

	it("stamps a linked create", async () => {
		const { deps } = makeDeps();
		deps.content.sharedFields.add("sku");
		const fields: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "flux_source_id", type: "string", translatable: false },
		];
		const english = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "id" },
			fields: { title: { from: "Name", type: "text" } },
		};
		const french = {
			...english,
			locale: "fr",
			translationOf: { from: "en_id", locale: "en" },
			rules: { owner: "fr-feed" },
		};
		deps.source.add("en", "id,Name\nE1,Desk\n");
		deps.source.add("fr", "id,en_id,Name\nF1,E1,Bureau\n");
		const en = await createJob(deps, { uploadId: "en", template: english, schemaFields: fields });
		await runToEnd(deps, en.id);
		const fr = await createJob(deps, { uploadId: "fr", template: french, schemaFields: fields });
		expect((await runToEnd(deps, fr.id)).counters).toMatchObject({ created: 1 });
		expect(await deps.links.get("products:fr:F1")).toMatchObject({ owner: "fr-feed" });
	});
});

/**
 * The required sequence (spec Ruling 21): template A (owner a) creates K; a record of template B
 * (owner b, and again with no owner) reaches K's link and, whatever its outcome, drops the stamp
 * with exactly one link put.
 */
describe("dropping a foreign stamp (M5c, Ruling 21)", () => {
	const outcomes: [string, (deps: Deps) => Promise<void>, Row, Record<string, unknown>, string][] =
		[
			["unchanged", async () => {}, desk, {}, "unchanged"],
			[
				"skipped by mode create",
				async () => {},
				{ ...desk, price: 99 },
				{ mode: "create" },
				"unchanged",
			],
			[
				"skipped by mode update (the entry is gone)",
				async (deps) => {
					deps.content.entries.delete(entryOf(deps, "A1").id);
				},
				desk,
				{ mode: "update" },
				"unchanged",
			],
			[
				"protected on every difference",
				async (deps) => {
					const e = entryOf(deps, "A1");
					await deps.content.update({
						id: e.id,
						rev: deps.content.revOf(e.id),
						data: { price: 42 },
					});
					await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
				},
				{ ...desk, price: 43 },
				{ protectEdited: true },
				"unchanged",
			],
			[
				"pending_draft",
				async (deps) => {
					const e = entryOf(deps, "A1");
					await deps.content.update({
						id: e.id,
						rev: deps.content.revOf(e.id),
						data: { price: 42 },
					});
				},
				{ ...desk, price: 43 },
				{},
				"conflict",
			],
			[
				"locked",
				async (deps) => {
					deps.content.locked.add(entryOf(deps, "A1").id);
				},
				{ ...desk, price: 43 },
				{},
				"locked",
			],
		];

	for (const owner of ["b", undefined]) {
		for (const [name, prepare, row, rules, status] of outcomes) {
			it(`drops it when B (${owner ?? "no owner"}) is ${name}`, async () => {
				const { deps } = setup();
				await importRows(deps, [desk], { ...owned("a"), sourceId: "src1" });
				await prepare(deps);
				const before = await linkOf(deps, "A1");
				expect(before).toMatchObject({ owner: "a", ownerSource: "src1" });
				const puts = countPuts(deps);
				const job = await importRows(deps, [row], {
					extra: { rules: { ...(owner ? { owner } : {}), ...rules } },
				});
				expect((await records(deps, job.id))[0]?.status).toBe(status);
				const after = await linkOf(deps, "A1");
				expect(after).not.toHaveProperty("owner");
				expect(after).not.toHaveProperty("ownerSource");
				expect(puts.filter((id) => id === "products:en:A1")).toHaveLength(1);
				// The link still names the entry, job and revision it did.
				expect(after).toMatchObject({
					entryId: before.entryId,
					jobId: before.jobId,
					writtenRev: before.writtenRev,
				});
			});
		}
	}

	it("drops it when B writes the entry, with no put beyond the write's own", async () => {
		/** B's update of K after A (owned or not) created it: the link puts B's write makes. */
		const update = async (rules: { extra?: Record<string, unknown> }) => {
			const { deps } = setup();
			await importRows(deps, [desk], rules);
			const puts = countPuts(deps);
			await importRows(deps, [{ ...desk, price: 20 }], owned("b"));
			return { deps, puts: puts.filter((id) => id === "products:en:A1").length };
		};
		const baseline = await update({});
		const { deps, puts } = await update(owned("a"));
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
		// The write's own link saves (written, published), no extra put for the stamp.
		expect(baseline.puts).toBe(2);
		expect(puts).toBe(baseline.puts);
		const job = await importRows(deps, [{ ...desk, price: 20 }], owned("b"));
		expect(job.counters).toMatchObject({ unchanged: 1 });
	});

	it("drops nothing in a dry run of B", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], owned("a"));
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 20 }, lamp], { ...owned("b"), dryRun: true });
		expect(puts).toEqual([]);
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "a" });
	});
});

describe("the journal's link snapshot (M5c)", () => {
	it("keeps the owner, its source and the missing mark", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { ...owned("a"), sourceId: "src1" });
		const linkId = "products:en:A1";
		const link = await linkOf(deps, "A1");
		await deps.links.put(linkId, {
			...link,
			missing: { jobId: "id00000099", action: "unpublish", at: "2026-10-07T10:00:00.000Z" },
		});
		const job = await importRows(deps, [{ ...desk, price: 30 }], owned("a"));
		const [row] = await journalOf(deps, job.id);
		expect(row?.before?.link).toMatchObject({
			owner: "a",
			ownerSource: "src1",
			missing: { jobId: "id00000099", action: "unpublish" },
		});
		// The write cleared the mark (spec Ruling 14) and kept the owner.
		const after = await linkOf(deps, "A1");
		expect(after).not.toHaveProperty("missing");
		expect(after).toMatchObject({ owner: "a" });
		expect(await deps.journal.get(journalKey(job.id, linkId))).not.toBeNull();
	});
});
