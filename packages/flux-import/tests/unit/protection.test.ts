import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import { editedMappings, FIELD_EDITED_MESSAGE } from "../../src/engine/rules.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { LinkRow, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";
import {
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	runToEnd,
	setup,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const protect = { extra: { rules: { protectEdited: true } } };
const KEY = "products:en:A1";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;
const edited = (field: string) => ({ field, code: "field_edited", message: FIELD_EDITED_MESSAGE });

type Change = Parameters<Deps["content"]["update"]>[0] extends infer T ? Partial<T> : never;

/** An editor's published change of an entry, through the same update and publish as REST. */
async function edit(deps: Deps, key: string, change: Change) {
	const e = entryOf(deps, key);
	await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), ...change });
	await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
}
const editDesk = (deps: Deps, change: Change) => edit(deps, "A1", change);

/** Runs an import of `csv` with its own template and schema to the end. */
async function runWith(deps: Deps, template: unknown, schemaFields: SchemaField[], csv: string) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const job = await createJob(deps, {
		uploadId: upload,
		template,
		schemaFields,
		mediaMaxBytes: 1000,
	});
	return runToEnd(deps, job.id);
}

describe("which mappings count as edited (M5b)", () => {
	const link = (extra: Partial<LinkRow>): LinkRow => ({
		collection: "products",
		locale: "en",
		sourceKey: "A1",
		entryId: "e1",
		writtenRev: "r1",
		...extra,
	});
	const names = ["title", "price", "taxonomies.tag"];
	const now = { title: "T", price: "P", "taxonomies.tag": "G" };

	it("compares fingerprints, and trusts an unmoved revision for all but taxonomies", () => {
		const fields = { title: "T", price: "old", "taxonomies.tag": "old" };
		expect([...editedMappings(names, link({ fields }), "r1", now)]).toEqual(["taxonomies.tag"]);
		expect([...editedMappings(names, link({ fields }), "r2", now)]).toEqual([
			"price",
			"taxonomies.tag",
		]);
		const missing = { title: "T", "taxonomies.tag": "G" };
		expect([...editedMappings(names, link({ fields: missing }), "r1", now)]).toEqual(["price"]);
	});

	it("falls back on the revision for a link from before M5b, taxonomies always edited", () => {
		expect([...editedMappings(names, link({}), "r1", now)]).toEqual(["taxonomies.tag"]);
		expect([...editedMappings(names, link({}), "r2", now)]).toEqual(names);
		const { writtenRev: _w, ...repaired } = link({});
		expect([...editedMappings(names, repaired, "r1", now)]).toEqual(names);
	});
});

describe("never overwriting edits made outside the import (M5b)", () => {
	it("keeps an editor's published change of one field and updates the others", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor's desk" } });
		const job = await importRows(deps, [{ ...desk, name: "Desk 2", price: 12 }], protect);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", after: "desk-2" },
				{ field: "price", before: 10, after: 12 },
			],
			warnings: [edited("title")],
		});
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor's desk", price: 12 });
		// Not journalled: a rollback never touches it.
		const [journal] = await journalOf(deps, job.id);
		expect(Object.keys(journal?.before?.live ?? {})).toEqual(["price"]);
	});

	it("protects a term changed through the terms route, which leaves the revision (F8)", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		deps.content.setTerms(entryOf(deps, "A1").id, "tag", ["sale"]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			changes: [{ field: "price" }],
			warnings: [edited("taxonomies.tag")],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
	});

	it("protects bylines an editor changed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const sam = deps.lookups.storedBylines.find((b) => b.slug === "sam")?.id ?? "";
		await editDesk(deps, { bylines: [{ bylineId: sam, roleLabel: null }] });
		const job = await importRows(deps, [desk], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("bylines")],
		});
		expect(entryOf(deps, "A1").bylines).toEqual([{ bylineId: sam, roleLabel: null }]);
	});

	it("resolves a protected mapping without side effects: no term created, no download", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const e = entryOf(deps, "A1");
		await editDesk(deps, { data: { photo: { ...(e.data.photo as object), alt: "Editor's alt" } } });
		deps.content.setTerms(e.id, "tag", ["sale"]);
		deps.mediaFetcher.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, img: url("b.png"), tags: "fresh" }], {
			extra: {
				rules: { protectEdited: true },
				taxonomies: { tag: { from: "Tags", separator: "|", create: true } },
			},
		});
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("photo"), edited("taxonomies.tag")],
		});
		expect(deps.lookups.storedTerms.some((t) => t.slug === "fresh")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
	});

	it("keeps an editor's alt the template does not map while another field is written", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const e = entryOf(deps, "A1");
		const photo = { ...(e.data.photo as Record<string, unknown>), alt: "Editor's alt" };
		await editDesk(deps, { data: { photo, title: "Editor's desk" } });
		const before = (await linkOf(deps)).fields?.photo;
		// The same image: the plan finds no change of it, but its fingerprint differs.
		const job = await importRows(deps, [{ ...desk, img: url("a.png"), price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "price" }],
			warnings: [edited("title"), edited("photo")],
		});
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor's desk", price: 12, photo });
		expect((await linkOf(deps)).fields?.photo).toBe(before);
		const [journal] = await journalOf(deps, job.id);
		expect(Object.keys(journal?.before?.live ?? {})).toEqual(["price"]);
	});

	it("never downloads a protected image, also when the record is written", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const e = entryOf(deps, "A1");
		const photo = { ...(e.data.photo as Record<string, unknown>), alt: "Editor's alt" };
		await editDesk(deps, { data: { photo } });
		deps.mediaFetcher.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, img: url("b.png"), price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "price" }],
			warnings: [edited("photo")],
		});
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(entryOf(deps, "A1").data).toMatchObject({ price: 12, photo });
	});

	it("keeps a protected image out of the write while another image is downloaded", async () => {
		const { deps } = setup();
		const schema: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "photo", type: "image" },
			{ slug: "thumb", type: "image" },
			{ slug: "flux_source_id", type: "string" },
		];
		const template = (rules?: Record<string, unknown>) => ({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "Name", type: "text" },
				photo: { from: "Img", type: "image" },
				thumb: { from: "Thumb", type: "image" },
			},
			...(rules ? { rules } : {}),
		});
		const row = (thumb: string) => `sku,Name,Img,Thumb\nA1,Desk,${url("a.png")},${thumb}\n`;
		await runWith(deps, template(), schema, row(""));
		const e = entryOf(deps, "A1");
		const photo = { ...(e.data.photo as Record<string, unknown>), alt: "Editor's alt" };
		await editDesk(deps, { data: { photo } });
		const job = await runWith(deps, template({ protectEdited: true }), schema, row(url("b.png")));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "thumb" }],
			warnings: [edited("photo")],
		});
		expect(deps.mediaFetcher.urls()).toContain(url("b.png"));
		expect(entryOf(deps, "A1").data.photo).toEqual(photo);
		expect(entryOf(deps, "A1").data.thumb).toMatchObject({ mimeType: "image/png" });
	});

	it("keeps an edited Portable Text field out of the write", async () => {
		const { deps } = makeDeps();
		const schema: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "body", type: "portableText" },
			{ slug: "flux_source_id", type: "string" },
		];
		const template = (rules?: Record<string, unknown>) => ({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: {
				title: { from: "title", type: "text" },
				body: { from: "html", type: "portableText", format: "html" },
			},
			...(rules ? { rules } : {}),
		});
		await runWith(deps, template(), schema, "id,title,html\np1,Hello,<p>Hi</p>\n");
		const body = [
			{
				_type: "block",
				_key: "k1",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "s1", text: "Editor", marks: [] }],
			},
		];
		await edit(deps, "p1", { data: { body } });
		const csv = "id,title,html\np1,Hello 2,<p>Bye</p>\n";
		const job = await runWith(deps, template({ protectEdited: true }), schema, csv);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "title" }],
			warnings: [edited("body")],
		});
		expect(entryOf(deps, "p1").data).toMatchObject({ title: "Hello 2", body });
	});

	it("keeps an edited field while a new image of the record is downloaded and written", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor's desk" } });
		const job = await importRows(deps, [{ ...desk, img: url("b.png"), price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "price" }, { field: "photo" }],
			warnings: [edited("title")],
		});
		expect(deps.mediaFetcher.urls()).toEqual([url("b.png")]);
		const e = entryOf(deps, "A1");
		expect(e.data).toMatchObject({ title: "Editor's desk", price: 12 });
		expect(e.data.photo).toMatchObject({ mimeType: "image/png" });
	});

	it("lifts protection when the entry's value equals the feed again, refreshing its fingerprint", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = (await linkOf(deps)).fields ?? {};
		await editDesk(deps, { data: { title: "Desk 2" } });
		const job = await importRows(deps, [{ ...desk, name: "Desk 2" }], protect);
		const [row] = await records(deps, job.id);
		expect(row).not.toHaveProperty("warnings");
		expect(row?.changes?.map((c) => c.field)).toEqual(["slug"]);
		const after = (await linkOf(deps)).fields ?? {};
		expect(after.title).not.toBe(before.title);
		// The next run finds nothing edited.
		await editDesk(deps, { data: { price: 10 } });
		const again = await importRows(deps, [{ ...desk, name: "Desk 2" }], protect);
		expect((await records(deps, again.id))[0]).toMatchObject({ status: "unchanged" });
		expect((await records(deps, again.id))[0]).not.toHaveProperty("warnings");
	});

	it("lifts protection when a job without protectEdited writes the mapping", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		await importRows(deps, [desk]);
		expect(entryOf(deps, "A1").data.title).toBe("Desk");
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
	});

	it("overwrites an edit under rules without protectEdited", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		const job = await importRows(deps, [desk], { extra: { rules: { mode: "upsert" } } });
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "updated", changes: [{ field: "title" }] });
		expect(row).not.toHaveProperty("warnings");
		expect(entryOf(deps, "A1").data.title).toBe("Desk");
	});

	it("leaves a record whose only differences are protected unchanged, and keeps their fingerprints", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		const before = (await linkOf(deps)).fields ?? {};
		const job = await importRows(deps, [desk], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("title")],
		});
		expect((await linkOf(deps)).fields?.title).toBe(before.title);
		expect(await journalOf(deps, job.id)).toEqual([]);
	});

	it("reports the same warning in a dry run and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		const link = await linkOf(deps);
		const job = await importRows(deps, [{ ...desk, price: 12 }], { ...protect, dryRun: true });
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "planned",
			action: "update",
			changes: [{ field: "price" }],
			warnings: [edited("title")],
		});
		expect(await linkOf(deps)).toEqual(link);
		expect(entryOf(deps, "A1").data.price).toBe(10);
	});

	it("keeps the M2 rule: someone else's pending draft is still refused", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Draft" },
		});
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "pending_draft" }],
		});
	});

	it("records no fingerprint from someone else's pending draft, which may yet be discarded", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { price: 12 } });
		const before = await linkOf(deps);
		// The draft equals the feed: unchanged, with or without protection.
		for (const opts of [{}, protect]) {
			const job = await importRows(deps, [{ ...desk, price: 12 }], opts);
			expect((await records(deps, job.id))[0]).toMatchObject({ status: "unchanged" });
			expect(await linkOf(deps)).toEqual(before);
		}
		await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			step: "discard",
		});
		// The editor discarded the draft: the live price is still the import's own.
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "updated", changes: [{ field: "price" }] });
		expect(row).not.toHaveProperty("warnings");
		expect(entryOf(deps, "A1").data.price).toBe(12);
	});

	it("falls back on the revision for a link saved before M5b, and counts taxonomies as edited", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const { fields: _fields, ...old } = await linkOf(deps);
		await deps.links.put(KEY, old);
		const job = await importRows(deps, [{ ...desk, price: 12, tags: "sale" }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			changes: [{ field: "price" }],
			warnings: [edited("taxonomies.tag")],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["new"]);
		// Equal taxonomies lift at once; an edit since the link counts every mapping as edited.
		const { fields: _f, ...bare } = await linkOf(deps);
		await deps.links.put(KEY, bare);
		await editDesk(deps, { data: { featured: true } });
		const next = await importRows(deps, [{ ...desk, name: "Desk 3", price: 12 }], protect);
		expect((await records(deps, next.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("slug"), edited("title"), edited("featured")],
		});
	});

	it("does not take the slug staged in the importer's own draft for an edit", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, name: "Desk 2" }], { ...protect, publish: false });
		expect(entryOf(deps, "A1").slug).toBe("desk-2");
		const job = await importRows(deps, [{ ...desk, name: "Desk 2", price: 11 }], {
			...protect,
			publish: false,
		});
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
	});
});

describe("updateFields on a translation entry (M5b, M4e)", () => {
	const schemaFields: SchemaField[] = [
		{ slug: "title", type: "string" },
		{ slug: "sku", type: "string", translatable: false },
		{ slug: "flux_source_id", type: "string", translatable: false },
	];
	const fields = { title: { from: "Name", type: "text" }, sku: { from: "SKU", type: "text" } };
	const template = (locale: string, extra: Record<string, unknown> = {}) => ({
		version: 1,
		collection: "products",
		locale,
		key: { from: "id" },
		fields,
		...extra,
	});

	async function run(deps: ReturnType<typeof makeDeps>["deps"], t: unknown, csv: string) {
		const upload = `u${deps.source.uploads.size + 1}`;
		deps.source.add(upload, csv);
		const created = await createJob(deps, {
			uploadId: upload,
			template: t,
			schemaFields,
			linkSchema: { targets: { products: schemaFields } },
		});
		let job = created;
		for (let i = 0; i < 100 && (job.status === "created" || job.status === "running"); i++) {
			job = await runBatch(deps, created.id, "driver");
		}
		const page = await deps.records.query({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
		return page.items.map((i) => i.data as RecordRow);
	}

	it("judges shared mappings over the listed ones only", async () => {
		const { deps } = makeDeps();
		deps.content.sharedFields.add("sku");
		await run(deps, template("en"), "id,Name,SKU\nE1,Desk,S1\n");
		const linked = template("fr", { translationOf: { from: "en_id", locale: "en" } });
		await run(deps, linked, "id,en_id,Name,SKU\nF1,E1,Bureau,S1\n");
		const csv = "id,Name,SKU\nF1,Table,S9\n";
		// Without translationOf, the shared sku would overwrite the group's.
		const [whole] = await run(deps, template("fr"), csv);
		expect(whole).toMatchObject({ status: "failed", errors: [{ code: "translation_of_missing" }] });
		const listed = template("fr", { rules: { updateFields: ["title"] } });
		const [row] = await run(deps, listed, csv);
		expect(row).toMatchObject({ status: "updated", changes: [{ field: "title", after: "Table" }] });
		const fr = [...deps.content.entries.values()].find((e) => e.locale === "fr");
		expect(fr?.data).toMatchObject({ title: "Table", sku: "S1" });
	});
});
