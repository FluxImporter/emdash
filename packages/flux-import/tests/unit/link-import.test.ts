import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError, type LinkWrites } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{
		slug: "maker",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "makers",
	},
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
];

const template = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		maker: { from: "Maker", type: "reference", match: "slug" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: {
		category: { from: "Category", match: "label", hierarchy: ">", create: true },
		tag: { from: "Tags", separator: "|" },
	},
	bylines: { from: "Authors", separator: "|" },
	...extra,
});

const HEADER = "sku,Name,Maker,Related,Category,Tags,Authors\n";

async function seed(deps: Deps) {
	await deps.content.create({ collection: "makers", locale: "en", slug: "acme", data: {} });
	deps.lookups.defs.push(
		{ name: "category", hierarchical: true, collections: ["products"], locale: "en" },
		{ name: "tag", hierarchical: false, collections: ["products"], locale: "en" },
	);
	deps.lookups.addTerm("category", "electronics", "Electronics");
	deps.lookups.addTerm("tag", "new", "New");
	deps.lookups.addTerm("tag", "sale", "Sale");
	deps.lookups.addByline("alex", "Alex");
	deps.lookups.addByline("sam", "Sam");
}

async function start(
	deps: Deps,
	csv: string,
	opts: { dryRun?: boolean; publish?: boolean; extra?: Record<string, unknown> } = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const { extra, ...rest } = opts;
	return createJob(deps, {
		uploadId: upload,
		template: template(extra),
		schemaFields,
		linkSchema: {
			targets: { makers: [], products: [{ slug: "flux_source_id", type: "string" }] },
			taxonomies: deps.lookups.defs,
		},
		...rest,
	});
}

async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

const CSV = `${HEADER}A1,Desk,acme,,Electronics > Phones,new|sale,alex|sam\nA2,Lamp,,A1,Electronics,new,sam\n`;

describe("importing links", () => {
	it("creates entries with their terms, references and bylines, and re-runs unchanged", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const job = await start(deps, CSV);
		expect(job.taxonomies).toEqual({
			category: { hierarchical: true },
			tag: { hierarchical: false },
		});
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 2, failed: 0 });
		const [a1, a2] = await rows(deps, job.id);
		const phones = deps.lookups.storedTerms.find((t) => t.label === "Phones")!;
		const makerId = [...deps.content.entries.values()].find((e) => e.slug === "acme")!.id;
		expect(a1).toMatchObject({
			status: "created",
			newTerms: ["category: Electronics > Phones"],
			changes: [
				{ field: "title", before: null, after: "Desk" },
				{ field: "maker", before: null, after: [makerId] },
				{ field: "taxonomies.category", before: null, after: ["electronics/phones"] },
				{ field: "taxonomies.tag", before: null, after: ["new", "sale"] },
				{ field: "bylines", before: null, after: ["alex", "sam"] },
			],
		});
		expect(a2).not.toHaveProperty("newTerms");
		const entry1 = deps.content.entries.get(a1!.entryId!)!;
		expect(entry1).toMatchObject({
			taxonomies: { category: ["phones"], tag: ["new", "sale"] },
			references: { maker: [makerId] },
			bylines: [
				{ bylineId: deps.lookups.storedBylines[0]!.id, roleLabel: null },
				{ bylineId: deps.lookups.storedBylines[1]!.id, roleLabel: null },
			],
		});
		expect(phones.parentId).not.toBeNull();
		// A2 links to A1 by import key, which the same job wrote first.
		expect(deps.content.entries.get(a2!.entryId!)?.references).toEqual({ related: [a1!.entryId] });

		const again = await start(deps, CSV);
		const rerun = await runToEnd(deps, again.id);
		expect(rerun.counters).toMatchObject({ unchanged: 2, created: 0, updated: 0 });
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
	});

	it("loads terms and bylines once per batch", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const job = await start(deps, CSV);
		await runToEnd(deps, job.id);
		expect(deps.lookups.calls.filter((c) => c.startsWith("terms:"))).toEqual([
			"terms:category:en",
			"terms:tag:en",
		]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines:"))).toHaveLength(1);
	});

	it("reports in a dry run what a real run would hit, without writing or creating", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}A1,Desk,acme,,Electronics > Phones,new,alex\nA2,Lamp,nobody,A9,Garden,old,lee\n`;
		const job = await start(deps, csv, { dryRun: true });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 1 });
		const [a1, a2] = await rows(deps, job.id);
		expect(a1).toMatchObject({
			status: "planned",
			action: "create",
			newTerms: ["category: Electronics > Phones"],
		});
		expect(a2).toMatchObject({
			status: "failed",
			sourceKey: "A2",
			errors: [
				{ field: "maker", code: "reference_not_found" },
				{ field: "related", code: "reference_not_found" },
				{ field: "taxonomies.tag", code: "term_not_found" },
				{ field: "bylines", code: "byline_not_found" },
			],
		});
		// Only the seeded maker exists; the dry run looked A9 up but wrote nothing.
		expect(deps.content.calls).toEqual(["create:e1", "find:A9"]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	it("finds in a dry run a key an earlier record would create, across batches", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}C1,One,,,,,\nC2,Two,,C1,,,\nC3,Three,,C1|C2,,,\nC4,Four,,C5,,,\nC5,Five,,,,,\n`;
		const job = await start(deps, csv, { dryRun: true });
		await deps.jobs.put(job.id, { ...job, batchSize: 2 });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 4, failed: 1 });
		const planned = await rows(deps, job.id);
		expect(planned[2]).toMatchObject({
			status: "planned",
			changes: [
				{ field: "title", before: null, after: "Three" },
				{ field: "related", before: null, after: ["C1", "C2"] },
			],
		});
		// A forward reference fails as it would in a real run.
		expect(planned[3]).toMatchObject({
			status: "failed",
			errors: [{ field: "related", code: "reference_not_found" }],
		});
		const real = await start(deps, csv);
		expect((await runToEnd(deps, real.id)).counters).toMatchObject({ created: 4, failed: 1 });
	});

	it("updates only the changed links, without data, keeping role labels", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
		await runToEnd(deps, first.id);
		const [a1] = await rows(deps, first.id);
		const entry = deps.content.entries.get(a1!.entryId!)!;
		entry.bylines[1]!.roleLabel = "Photos";
		const updates: unknown[] = [];
		const update = deps.content.update.bind(deps.content);
		deps.content.update = async (input) => {
			updates.push(input);
			return update(input);
		};
		const changed = `${HEADER}A1,Desk,acme,,Electronics > Phones,sale,sam|alex\n`;
		const second = await start(deps, changed);
		await runToEnd(deps, second.id);
		const [row] = await rows(deps, second.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "taxonomies.tag", before: ["new", "sale"], after: ["sale"] },
				{ field: "bylines", before: ["alex", "sam"], after: ["sam", "alex"] },
			],
		});
		const [alex, sam] = deps.lookups.storedBylines;
		expect(updates).toEqual([
			{
				collection: "products",
				locale: "en",
				id: entry.id,
				rev: expect.any(String),
				taxonomies: { tag: ["sale"] },
				bylines: [
					{ bylineId: sam!.id, roleLabel: "Photos" },
					{ bylineId: alex!.id, roleLabel: null },
				],
			},
		]);
	});

	it("sends the data again when a field changed, and clears a taxonomy given no value", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
		await runToEnd(deps, first.id);
		const writes: LinkWrites[] = deps.content.linkWrites;
		writes.length = 0;
		const changed = `${HEADER}A1,Desk 2,acme,,Electronics > Phones,,alex|sam\n`;
		const second = await start(deps, changed);
		await runToEnd(deps, second.id);
		const [row] = await rows(deps, second.id);
		expect(row?.changes).toEqual([
			{ field: "title", before: "Desk", after: "Desk 2" },
			{ field: "taxonomies.tag", before: ["new", "sale"], after: null },
		]);
		expect(writes).toEqual([{ taxonomies: { tag: [] } }]);
		const entry = deps.content.entries.get(row!.entryId!)!;
		expect(entry.data).toMatchObject({ title: "Desk 2" });
		expect(entry.taxonomies).toEqual({ category: ["phones"], tag: [] });
	});

	it("rewrites a reference field whose selection was read only in part", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
		await runToEnd(deps, first.id);
		const [a1, a2] = await rows(deps, first.id);
		const get = deps.content.get.bind(deps.content);
		deps.content.get = async (collection, locale, id, options) => {
			const entry = await get(collection, locale, id, options);
			return entry && id === a2!.entryId && options?.references
				? { ...entry, referencesTruncated: ["related"] }
				: entry;
		};
		deps.content.linkWrites.length = 0;
		const second = await start(deps, CSV);
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ updated: 1, unchanged: 1 });
		const [, row] = await rows(deps, second.id);
		expect(row?.changes).toEqual([
			{ field: "related", before: [a1!.entryId], after: [a1!.entryId] },
		]);
		expect(deps.content.linkWrites).toEqual([{ references: { related: [a1!.entryId] } }]);
	});

	it("fails a forward key reference, and imports it on retry once the target exists", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}B1,Shelf,,B2,,,\nB2,Stool,,,,,\n`;
		const job = await start(deps, csv);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 1 });
		const [b1] = await rows(deps, job.id);
		expect(b1).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "related",
					code: "reference_not_found",
					message: 'No entry in "products" (en) was imported with the key "B2"',
				},
			],
		});
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 2, failed: 0 });
		const [fixed, b2] = await rows(deps, job.id);
		expect(deps.content.entries.get(fixed!.entryId!)?.references).toEqual({
			related: [b2!.entryId],
		});
	});

	it("creates nothing for a record whose lookups fail", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}A1,Desk,acme,,Garden > Tools,new,nobody\n`;
		const job = await start(deps, csv);
		await runToEnd(deps, job.id);
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			sourceKey: "A1",
			errors: [{ field: "bylines", code: "byline_not_found" }],
		});
		expect(row).not.toHaveProperty("newTerms");
		expect(deps.lookups.storedTerms.some((t) => t.label === "Garden")).toBe(false);
		expect(deps.content.entries.size).toBe(1);
	});

	it("keeps the created terms on the row of a record that then fails to write", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		deps.content.failWrite = () => new ContentWriteError("emdash_validation_error", "Invalid");
		const csv = `${HEADER}A1,Desk,acme,,Garden > Tools,new,alex\n`;
		const job = await start(deps, csv);
		await runToEnd(deps, job.id);
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			newTerms: ["category: Garden", "category: Garden > Tools"],
			errors: [{ code: "emdash_validation_error" }],
		});
		// The next run finds the terms instead of creating them again.
		deps.content.failWrite = () => null;
		const again = await start(deps, csv);
		await runToEnd(deps, again.id);
		const [ok] = await rows(deps, again.id);
		expect(ok).toMatchObject({ status: "created" });
		expect(ok).not.toHaveProperty("newTerms");
	});

	it("leaves jobs of templates without links as before", async () => {
		const { deps } = makeDeps();
		deps.source.add("p1", "sku,Name\nA1,Desk\n");
		const job = await createJob(deps, {
			uploadId: "p1",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { title: { from: "Name", type: "text" } },
			},
			schemaFields: [{ slug: "title", type: "string" }],
		});
		expect(job).not.toHaveProperty("taxonomies");
		await runToEnd(deps, job.id);
		expect(deps.lookups.calls).toEqual([]);
		expect(deps.content.linkWrites).toEqual([{}]);
	});
});
