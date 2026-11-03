import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { mergeBefore } from "../../src/engine/journal.js";
import { type JournalBefore, journalKey, linkKey } from "../../src/engine/types.js";
import {
	bylineId,
	csv,
	entryOf,
	importRows,
	journalOf,
	records,
	runToEnd,
	setup,
	start,
	termGroup,
	url,
} from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, featured: true, tags: "new", authors: "alex" };

describe("the journal of a real import (M5a)", () => {
	it("journals a create before the write and its entry once the create returns", async () => {
		const { deps } = setup();
		let during: unknown;
		deps.content.afterWrite = () => {
			during = structuredClone([...deps.journal.rows.values()].map((r) => r.value));
		};
		const job = await importRows(deps, [desk]);
		expect(during).toEqual([
			{
				jobId: job.id,
				seq: 0,
				collection: "products",
				locale: "en",
				sourceKey: "A1",
				kind: "create",
				entryId: null,
				sourceIdValue: "A1",
				at: "2026-10-07T10:00:00.000Z",
			},
		]);
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({ kind: "create", entryId: entryOf(deps, "A1").id, confirmed: true });
		expect(await deps.links.get(linkKey("products", "en", "A1"))).toMatchObject({
			jobId: job.id,
			writtenRev: String(entryOf(deps, "A1").rev),
		});
	});

	it("journals an update's live values, slug, links, status, schedule and link row", async () => {
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = String(entry.rev);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
		expect(second.counters).toMatchObject({ updated: 1 });
		const [row] = await journalOf(deps, second.id);
		expect(row).toEqual({
			jobId: second.id,
			seq: 0,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: entry.id,
			before: {
				link: { jobId: first.id, writtenRev: rev },
				status: "published",
				scheduledAt: null,
				slug: "desk",
				live: { title: "Desk", price: 10 },
				links: {
					taxonomies: { tag: [termGroup(deps, "new")] },
					bylines: [{ bylineId: bylineId(deps, "alex"), roleLabel: null }],
				},
			},
			at: "2026-10-07T10:00:00.000Z",
		});
	});

	it("journals the live and draft values of the importer's own pending draft it publishes", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", data: { price: 20 } });
		// The same data with publish: true only publishes the draft (finishUnchanged).
		const third = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(third.counters).toMatchObject({ updated: 1 });
		const [row] = await journalOf(deps, third.id);
		expect(row?.before).toMatchObject({
			status: "published",
			live: { price: 10 },
			draft: { price: 20 },
		});
		expect(row?.before).not.toHaveProperty("slug");
		// A write over the draft that also publishes keeps every field the publish makes live.
		await importRows(deps, [{ ...desk, price: 30 }], { publish: false });
		const fifth = await importRows(deps, [{ ...desk, name: "Table", price: 30 }]);
		const [written] = await journalOf(deps, fifth.id);
		expect(written?.before).toMatchObject({
			live: { title: "Desk", price: 20 },
			draft: { title: "Desk", price: 30 },
			slug: "desk",
		});
	});

	it("keeps the first touch's pre-image and adds only what later writes touch first", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [
			{ ...desk, price: 20 },
			{ ...desk, name: "Table", price: 20 },
		]);
		expect(job.counters).toMatchObject({ updated: 2 });
		const rows = await journalOf(deps, job.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			seq: 0,
			before: { live: { price: 10, title: "Desk" }, slug: "desk" },
		});
	});

	it("merges a later write's fields, draft values and links without replacing the first's", () => {
		const first: JournalBefore = {
			link: null,
			status: "published",
			scheduledAt: null,
			live: { price: 10 },
			draft: { price: 11 },
			links: { taxonomies: { tag: ["t1"] } },
		};
		const next: JournalBefore = {
			link: { jobId: "x" },
			status: "draft",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			slug: "desk",
			live: { price: 99, title: "Desk" },
			links: {
				taxonomies: { tag: ["t2"], colour: ["c1"] },
				references: { related: ["e9"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		};
		expect(mergeBefore(first, next)).toEqual({
			link: null,
			status: "published",
			scheduledAt: null,
			slug: "desk",
			live: { price: 10, title: "Desk" },
			draft: { price: 11, title: "Desk" },
			links: {
				taxonomies: { tag: ["t1"], colour: ["c1"] },
				references: { related: ["e9"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		});
		expect(mergeBefore(first, { ...first, status: "draft" })).toBeNull();
	});

	it("marks a create that crash repair found as not confirmed", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]));
		let crash = true;
		deps.content.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("crash after the create");
			}
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash after the create");
		const stored = await deps.jobs.get(job.id);
		await deps.jobs.put(job.id, { ...(stored as typeof job), lease: null });
		const done = await runToEnd(deps, job.id);
		// As for any repaired create (M2): left as a draft, publish_unverified.
		expect(done.counters).toMatchObject({ conflict: 1 });
		expect(deps.content.entries.size).toBe(1);
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({
			kind: "create",
			entryId: entryOf(deps, "A1").id,
			confirmed: false,
		});
	});

	it("fails a record whose pre-image is too large, before any write", async () => {
		const { deps } = setup();
		const big = "x".repeat(1024 * 1024);
		await importRows(deps, [{ ...desk, name: big }]);
		const entry = entryOf(deps, "A1");
		const rev = entry.rev;
		const job = await importRows(deps, [{ ...desk, name: "Desk" }]);
		expect(job.counters).toMatchObject({ failed: 1 });
		const [row] = await records(deps, job.id);
		expect(row?.errors?.[0]).toMatchObject({ code: "journal_too_large" });
		expect(entry.rev).toBe(rev);
		expect(await journalOf(deps, job.id)).toEqual([]);
		// Without a journal the record imports.
		const plain = await importRows(deps, [{ ...desk, name: "Desk" }], { journal: false });
		expect(plain.counters).toMatchObject({ updated: 1 });
	});

	it("fails a record that changes a reference field read only in part", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk }, { sku: "A2", name: "Lamp", related: "A1" }]);
		const lamp = entryOf(deps, "A2");
		const get = deps.content.get.bind(deps.content);
		deps.content.get = async (collection, locale, id, options) => {
			const entry = await get(collection, locale, id, options);
			return entry && id === lamp.id && options?.references
				? { ...entry, referencesTruncated: ["related"] }
				: entry;
		};
		const rev = lamp.rev;
		const job = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A1" }]);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			errors: [{ field: "related", code: "journal_incomplete" }],
		});
		expect(lamp.rev).toBe(rev);
	});

	it("keeps no journal for journal: false or a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { journal: false });
		await importRows(deps, [{ ...desk, price: 1 }], { dryRun: true });
		await importRows(deps, [{ ...desk, price: 2 }], { journal: false });
		expect(deps.journal.rows.size).toBe(0);
	});

	it("journals media its uploads create, and not media found by its bytes", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [
			{ ...desk, img: url("a.png") },
			{ sku: "A2", name: "Lamp", img: url("copy.png") },
			{ sku: "A3", name: "Shelf", img: url("a.png") },
		]);
		expect(job.counters).toMatchObject({ created: 3 });
		const page = await deps.journalMedia.query({ where: { jobId: job.id } });
		expect(page.items.map((i) => i.data)).toEqual([
			{ jobId: job.id, mediaId: "m1", url: url("a.png"), seq: 0 },
		]);
		expect(page.items[0]?.id).toBe(`${job.id}:m1`);
		const none = await importRows(deps, [{ sku: "B1", name: "Bench", img: url("b.png") }], {
			journal: false,
		});
		expect((await deps.journalMedia.query({ where: { jobId: none.id } })).items).toEqual([]);
	});

	it("keys rows by job and link", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		expect(
			await deps.journal.get(journalKey(job.id, linkKey("products", "en", "A1"))),
		).toMatchObject({ kind: "create" });
	});
});
