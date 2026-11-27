import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { journaling, mergeBefore } from "../../src/engine/journal.js";
import {
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	linkKey,
} from "../../src/engine/types.js";
import {
	bylineId,
	csv,
	type Deps,
	entryOf,
	importRows,
	journalOf,
	records,
	runToEnd,
	schemaFields,
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
				// What the publish makes live, for crash repair of a lost link save (final review).
				wrote: { fields: expect.any(Object), slug: "desk", publishedAt: null },
			},
		]);
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({ kind: "create", entryId: entryOf(deps, "A1").id, confirmed: true });
		expect(await deps.links.get(linkKey("products", "en", "A1"))).toMatchObject({
			jobId: job.id,
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
	});

	it("journals an update's live values, slug, links, status, schedule and link row", async () => {
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = deps.content.revOf(entry.id);
		// The first job's fingerprints (M5b), which the snapshot keeps with the link.
		const fields = (await deps.links.get("products:en:A1"))?.fields;
		expect(Object.keys(fields ?? {}).sort()).toEqual([
			"bylines",
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"taxonomies.tag",
			"title",
		]);
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
				link: { jobId: first.id, writtenRev: rev, fields },
				// The entry is as the first job left it.
				rev,
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
			// What the job gave the taxonomy, for the rollback's term check, and what the publish
			// makes live, for crash repair of a lost link save (final review A-I2).
			wrote: {
				taxonomies: { tag: [termGroup(deps, "sale")] },
				fields: expect.any(Object),
				slug: "table",
				publishedAt: "2026-10-07T10:00:00.000Z",
			},
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

	it("journals an update before the update is written", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		let during: JournalEntry[] = [];
		deps.content.afterWrite = () => {
			during = [...deps.journal.rows.values()].map((r) => structuredClone(r.value));
		};
		const job = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(during.filter((r) => r.jobId === job.id)).toMatchObject([
			{ kind: "update", before: { live: { price: 10 } } },
		]);
	});

	it("journals the importer's own draft before publishing it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		let during: JournalEntry[] = [];
		deps.content.beforePublish = () => {
			during = [...deps.journal.rows.values()].map((r) => structuredClone(r.value));
		};
		const job = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(during.filter((r) => r.jobId === job.id)).toMatchObject([
			{ kind: "update", before: { live: { price: 10 }, draft: { price: 20 } } },
		]);
	});

	it("journals an uploaded media item before its media map row", async () => {
		const { deps } = setup();
		const sizes: number[] = [];
		const put = deps.mediaMap.put.bind(deps.mediaMap);
		deps.mediaMap.put = async (id, value) => {
			sizes.push(deps.journalMedia.rows.size);
			return put(id, value);
		};
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		expect(sizes).toEqual([1]);
	});

	it("journals the media field of a change to its alt text only", async () => {
		const { deps } = setup();
		const fields = {
			title: { from: "Name", type: "text" },
			photo: { from: "Img", type: "image", alt: { from: "Related" } },
		};
		const row = { sku: "A1", name: "Desk", img: url("a.png") };
		await importRows(deps, [{ ...row, related: "Old" }], { extra: { fields } });
		const job = await importRows(deps, [{ ...row, related: "New" }], { extra: { fields } });
		expect(job.counters).toMatchObject({ updated: 1 });
		const [journalled] = await journalOf(deps, job.id);
		expect(Object.keys(journalled?.before?.live ?? {})).toEqual(["photo"]);
		expect(journalled?.before?.live.photo).toMatchObject({ alt: "Old" });
	});

	it("journals a linked create with the source ID it sends, its translationOf value", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		deps.source.add("fr", "id,en,Name\nF1,A1,Bureau\n");
		const job = await createJob(deps, {
			uploadId: "fr",
			template: {
				version: 1,
				collection: "products",
				locale: "fr",
				key: { from: "id" },
				translationOf: { from: "en", locale: "en" },
				fields: { title: { from: "Name", type: "text" } },
			},
			schemaFields,
			linkSchema: { targets: { products: schemaFields }, taxonomies: deps.lookups.defs },
		});
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({ kind: "create", sourceKey: "F1", sourceIdValue: "A1" });
	});

	it("keeps no journal for a rollback job", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]));
		expect(journaling(job)).toBe(true);
		expect(journaling({ ...job, kind: "rollback" })).toBe(false);
	});

	it("flags the references of a pending draft a publishing write makes live", async () => {
		const { deps } = setup();
		const lamp = { sku: "A2", name: "Lamp", price: 5, related: "A1" };
		await importRows(deps, [desk, lamp]);
		await importRows(deps, [{ ...lamp, price: 6 }], { publish: false });
		// The importer's own draft, published as it is.
		const published = await importRows(deps, [{ ...lamp, price: 6 }]);
		const [own] = await journalOf(deps, published.id);
		expect(own?.before).toMatchObject({ draft: { price: 6 }, referencesUnknown: true });
		// A write over the draft that publishes it.
		await importRows(deps, [{ ...lamp, price: 7 }], { publish: false });
		const written = await importRows(deps, [{ ...lamp, price: 8 }]);
		const [over] = await journalOf(deps, written.id);
		expect(over?.before).toMatchObject({ draft: { price: 7 }, referencesUnknown: true });
		// Without a draft the selection read is the live one.
		const plain = await importRows(deps, [{ ...lamp, price: 9 }]);
		const [live] = await journalOf(deps, plain.id);
		expect(live?.before).not.toHaveProperty("referencesUnknown");
		// A job that does not publish leaves the draft's selection unpublished.
		await importRows(deps, [{ ...lamp, price: 10 }], { publish: false });
		const draftOnly = await importRows(deps, [{ ...lamp, price: 11 }], { publish: false });
		const [staged] = await journalOf(deps, draftOnly.id);
		expect(staged?.before).not.toHaveProperty("referencesUnknown");
	});

	it("flags no references for an entry that was never published", async () => {
		const { deps } = setup();
		const desk = { sku: "A1", name: "Desk", price: 10 };
		const lamp = { sku: "A2", name: "Lamp", price: 5, related: "A1" };
		await importRows(deps, [desk]);
		// A draft-status entry: its draft is all there is, so the read is not hiding a live selection.
		await importRows(deps, [lamp], { publish: false });
		const write = await importRows(deps, [{ ...lamp, price: 6 }]);
		const [row] = await journalOf(deps, write.id);
		expect(row?.before).not.toHaveProperty("referencesUnknown");
		// The same for a publish of the importer's own draft over a never-published entry.
		await importRows(deps, [{ sku: "A3", name: "Sofa", related: "A1" }], { publish: false });
		const publish = await importRows(deps, [{ sku: "A3", name: "Sofa", related: "A1" }]);
		for (const entry of (await journalOf(deps, publish.id)) ?? []) {
			expect(entry.before).not.toHaveProperty("referencesUnknown");
		}
	});
});

/** An editor's published change of the desk's price. */
async function editPrice(deps: Deps, price: number): Promise<void> {
	const entry = entryOf(deps, "A1");
	const result = await deps.content.update({
		id: entry.id,
		rev: deps.content.revOf(entry.id),
		data: { price },
	});
	if (!result.ok) throw new Error(result.reason);
	const published = await deps.content.publish({ id: entry.id, rev: result.rev });
	if (!published.ok) throw new Error(published.reason);
}

async function unlease(deps: Deps, job: Job): Promise<void> {
	const stored = (await deps.jobs.get(job.id)) as Job;
	await deps.jobs.put(job.id, { ...stored, lease: null });
}

/** The next update of the fake answers with a revision conflict. */
function conflictOnce(deps: Deps): void {
	const update = deps.content.update.bind(deps.content);
	let conflict = true;
	deps.content.update = async (input) => {
		if (!conflict) return update(input);
		conflict = false;
		return { ok: false, reason: "conflict" };
	};
}

describe("a journal row an attempt stored that never wrote (M5a)", () => {
	it("is replaced on a retry after a revision conflict and an editor's change", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		conflictOnce(deps);
		const job = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(job.counters).toMatchObject({ conflict: 1 });
		expect((await journalOf(deps, job.id))[0]?.before?.live).toEqual({ price: 10 });
		await editPrice(deps, 15);
		await transitionJob(deps, job.id, "retry");
		await runToEnd(deps, job.id);
		expect(entryOf(deps, "A1").data.price).toBe(20);
		expect((await journalOf(deps, job.id))[0]?.before?.live).toEqual({ price: 15 });
	});

	it("is replaced after a crash between the journal put and the update and an editor's change", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 20 }]));
		const put = deps.records.put.bind(deps.records);
		let crash = true;
		deps.records.put = async (id, value) => {
			if (crash && value.status === "writing") {
				crash = false;
				throw new Error("crash before the update");
			}
			return put(id, value);
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash before the update");
		expect((await journalOf(deps, job.id))[0]?.before?.live).toEqual({ price: 10 });
		await editPrice(deps, 15);
		await unlease(deps, job);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ updated: 1 });
		expect((await journalOf(deps, job.id))[0]?.before?.live).toEqual({ price: 15 });
	});

	it("is kept after a crash after the update: the first write wins", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk]);
		const job = await start(deps, csv([{ ...desk, price: 20 }]));
		let crash = true;
		deps.content.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("crash after the update");
			}
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash after the update");
		expect(entryOf(deps, "A1").data.price).toBe(20);
		// The revisit writes again: what it reads now is the crashed attempt's write.
		deps.source.add(job.uploadId, csv([{ ...desk, price: 30 }]));
		await unlease(deps, job);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ updated: 1 });
		expect(entryOf(deps, "A1").data.price).toBe(30);
		expect((await journalOf(deps, job.id))[0]?.before?.live).toEqual({ price: 10 });
	});

	it("records no link row for a link crash repair made up", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		conflictOnce(deps);
		const job = await importRows(deps, [{ ...desk, price: 20 }]);
		expect((await journalOf(deps, job.id))[0]?.before?.link).toMatchObject({
			jobId: expect.any(String),
		});
		// The link row is gone: the retry finds the entry by its source ID.
		await deps.links.delete(linkKey("products", "en", "A1"));
		await transitionJob(deps, job.id, "retry");
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ updated: 1 });
		expect((await journalOf(deps, job.id))[0]?.before?.link).toBeNull();
	});
});
