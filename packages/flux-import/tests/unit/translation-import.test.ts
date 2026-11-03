import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import { type Job, linkKey, type RecordRow, recordKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "sku", type: "string", translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "badge", type: "image", translatable: false },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
	{ slug: "flux_source_id", type: "string", translatable: false },
];

const english = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "id" },
	fields: {
		title: { from: "Name", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Price", type: "number" },
	},
};

const french = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Nom", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Prix", type: "number" },
		badge: { from: "Badge", type: "image" },
		related: { from: "Related", type: "reference", match: "key" },
	},
	taxonomies: { tag: { from: "Tags" } },
	bylines: { from: "Authors" },
	...extra,
});

const EN_CSV = "id,Name,SKU,Price\nE1,Desk,S1,10\nE2,Lamp,S2,20\n";
const FR_HEADER = "id,en_id,handle,Nom,SKU,Prix,Badge,Related,Tags,Authors\n";
const frRow = (id: string, enId: string, name: string, extra = ",,,https://x.test/b.png,E2,new,") =>
	`${id},${enId},${name.toLowerCase()},${name}${extra}\n`;

function setup() {
	const { deps, clock } = makeDeps();
	deps.content.sharedFields.add("sku").add("price").add("badge");
	deps.lookups.defs.push({
		name: "tag",
		hierarchical: false,
		collections: ["products"],
		locale: "en",
	});
	deps.lookups.addTerm("tag", "new", "New", undefined, "fr");
	deps.lookups.addByline("alex", "Alex", "fr");
	return { deps, clock };
}

async function start(
	deps: Deps,
	template: unknown,
	csv: string,
	opts: { dryRun?: boolean; fields?: SchemaField[] } = {},
): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const fields = opts.fields ?? schemaFields;
	return createJob(deps, {
		uploadId: upload,
		template,
		schemaFields: fields,
		linkSchema: { targets: { products: fields }, taxonomies: deps.lookups.defs },
		...(opts.dryRun ? { dryRun: true } : {}),
	});
}

async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 100; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

async function run(deps: Deps, template: unknown, csv: string, opts = {}) {
	const job = await start(deps, template, csv, opts);
	const done = await runToEnd(deps, job.id);
	return { job: done, rows: await rows(deps, job.id) };
}

/** The English entries by key, after an English job. */
async function importEnglish(deps: Deps, csv = EN_CSV) {
	await run(deps, english, csv);
	const byKey = new Map(
		[...deps.content.entries.values()]
			.filter((e) => e.locale === "en")
			.map((e) => [e.data.flux_source_id as string, e]),
	);
	return byKey;
}

/** Records each create's input. */
function recordCreates(deps: Deps) {
	const creates: Record<string, unknown>[] = [];
	const create = deps.content.create.bind(deps.content);
	deps.content.create = async (input) => {
		creates.push(structuredClone(input));
		return create(input);
	};
	return creates;
}

const frEntry = (deps: Deps, slug: string) =>
	[...deps.content.entries.values()].find((e) => e.locale === "fr" && e.slug === slug);

describe("importing translations", () => {
	it("creates translations in their sources' groups, leaves shared values to EmDash, and re-runs unchanged", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const creates = recordCreates(deps);
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau", ",,abc,not a url,E9,missing,");
		const first = await run(deps, french(), csv);
		expect(first.job.warnings).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price", "badge"; reference field "related"; taxonomy "tag"',
		]);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 0 });
		const desk = en.get("E1")!;
		const [row] = first.rows;
		expect(row).toMatchObject({
			status: "created",
			sourceKey: "F1",
			changes: [
				{ field: "slug", before: null, after: "bureau" },
				{ field: "title", before: null, after: "Bureau" },
				{ field: "translationOf", before: null, after: "en: E1" },
			],
		});
		expect(creates).toEqual([
			{
				collection: "products",
				locale: "fr",
				slug: "bureau",
				data: { title: "Bureau", flux_source_id: "E1" },
				translationOf: desk.id,
				bylines: [],
			},
		]);
		const bureau = frEntry(deps, "bureau")!;
		expect(bureau).toMatchObject({
			group: desk.id,
			data: { title: "Bureau", sku: "S1", price: 10, flux_source_id: "E1" },
		});
		expect(deps.mediaFetcher.calls).toEqual([]);
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: bureau.id,
		});

		const again = await run(deps, french(), csv);
		expect(again.job.counters).toMatchObject({ unchanged: 1 });
		expect(again.rows[0]).toMatchObject({ status: "unchanged", entryId: bureau.id });
	});

	it("credits the bylines a mapped value names, and none for an empty one", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const creates = recordCreates(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau", ",,,,,,alex"));
		const alex = deps.lookups.storedBylines.find((b) => b.slug === "alex")!;
		expect(creates[0]).toMatchObject({
			translationOf: en.get("E1")!.id,
			bylines: [{ bylineId: alex.id, roleLabel: null }],
		});
		const withoutBylines = french();
		delete (withoutBylines as Record<string, unknown>).bylines;
		const second = recordCreates(deps);
		await run(deps, withoutBylines, FR_HEADER + frRow("F2", "E2", "Lampe"));
		expect(second[0]).toMatchObject({ translationOf: en.get("E2")!.id });
		expect(second[0]).not.toHaveProperty("bylines");
	});

	it("fails a record whose source does not exist, and creates it on retry after the source job", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F3", "E3", "Chaise");
		const first = await run(deps, french(), csv);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(first.rows[1]).toMatchObject({
			status: "failed",
			sourceKey: "F3",
			errors: [
				{
					field: "translationOf",
					code: "translation_source_not_found",
					message: 'No entry in "products" (en) was imported with the key "E3"',
				},
			],
		});
		await importEnglish(deps, `${EN_CSV}E3,Chair,S3,30\n`);
		await transitionJob(deps, first.job.id, "retry");
		const retried = await runToEnd(deps, first.job.id);
		expect(retried.counters).toMatchObject({ created: 2, failed: 0 });
		expect(frEntry(deps, "chaise")?.data).toMatchObject({ sku: "S3", price: 30 });
	});

	it("fails translation_exists for a translation that is not the record's entry, also on retry", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const editor = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau (éditeur)" },
			translationOf: en.get("E1")!.id,
		});
		const first = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const failure = {
			status: "failed",
			errors: [
				{
					field: "translationOf",
					code: "translation_exists",
					message: `The source entry already has a translation in fr (entry ${editor.id}), which is not this record's entry`,
				},
			],
		};
		expect(first.rows[0]).toMatchObject(failure);
		await transitionJob(deps, first.job.id, "retry");
		await runToEnd(deps, first.job.id);
		expect((await rows(deps, first.job.id))[0]).toMatchObject(failure);
		expect(deps.content.entries.get(editor.id)?.data.title).toBe("Bureau (éditeur)");
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toBeNull();
	});

	it("imports a record without a value as an entry of its own, with every mapping", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const creates = recordCreates(deps);
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F4", "", "Tabouret", ",S4,40,,,new,"));
		expect(row).toMatchObject({ status: "created" });
		const own = frEntry(deps, "tabouret")!;
		expect(own.group).toBe(own.id);
		expect(own.data).toMatchObject({ sku: "S4", price: 40, flux_source_id: "F4" });
		expect(creates[0]).not.toHaveProperty("translationOf");
		expect(creates[0]).toMatchObject({ taxonomies: { tag: ["new"] } });
	});

	it("fails required for a shared required field only for a record without a value", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const fields = schemaFields.map((f) => (f.slug === "sku" ? { ...f, required: true } : f));
		const template = french({
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F4", "", "Tabouret");
		const job = await start(deps, template, csv, { fields });
		expect(job.sharedRequired).toEqual(["sku"]);
		await runToEnd(deps, job.id);
		const [linked, own] = await rows(deps, job.id);
		expect(linked).toMatchObject({ status: "created" });
		expect(own).toMatchObject({
			status: "failed",
			errors: [{ field: "sku", code: "required", message: "The field is required" }],
		});
	});

	it("fails translation_of_missing when a linked record loses its value", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const price = frEntry(deps, "bureau")?.data.price;
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "", "Bureau", ",S9,99,,,,"));
		expect(row).toMatchObject({
			status: "failed",
			entryId: frEntry(deps, "bureau")?.id,
			errors: [{ field: "translationOf", code: "translation_of_missing" }],
		});
		expect(frEntry(deps, "bureau")?.data.price).toBe(price);
	});

	it("updates an entry of its own that now names a source, warning it is not linked", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F4", "", "Tabouret", ",S4,40,,,,"));
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F4", "E2", "Tabouret bas", ",S9,99,,,,"));
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", before: "tabouret", after: "tabouret-bas" },
				{ field: "title", before: "Tabouret", after: "Tabouret bas" },
			],
			warnings: [
				{
					field: "translationOf",
					code: "translation_not_linked",
					message:
						"The entry is not a translation of en: E2, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation",
				},
			],
		});
		// The shared mappings were not read, so the entry keeps its own values.
		expect(frEntry(deps, "tabouret-bas")?.data).toMatchObject({ sku: "S4", price: 40 });
	});

	it("updates a translation whose source is gone, with a warning", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		deps.content.entries.delete(en.get("E1")!.id);
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau neuf"));
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", before: "bureau", after: "bureau-neuf" },
				{ field: "title", before: "Bureau", after: "Bureau neuf" },
			],
			warnings: [
				{
					code: "translation_source_not_found",
					message:
						'No entry in "products" (en) was imported with the key "E1"; the entry is updated without its source',
				},
			],
		});
	});

	it("plans a dry run with the source and group reads and writes nothing", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const before = deps.content.entries.size;
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F3", "E3", "Chaise");
		const { job, rows: planned } = await run(deps, french(), csv, { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(planned[0]).toMatchObject({
			status: "planned",
			action: "create",
			changes: expect.arrayContaining([{ field: "translationOf", before: null, after: "en: E1" }]),
		});
		expect(planned[1]).toMatchObject({ errors: [{ code: "translation_source_not_found" }] });
		expect(deps.content.entries.size).toBe(before);
		expect(deps.content.calls.filter((c) => c.startsWith("translations:"))).toHaveLength(1);
	});

	it("finds sources by link row only in a dry run before the source ID field exists", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const fields = schemaFields.filter((f) => f.slug !== "flux_source_id");
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau");
		const linked = await run(deps, french(), csv, { dryRun: true, fields });
		expect(linked.rows[0]).toMatchObject({ status: "planned", action: "create" });
		await deps.links.delete(linkKey("products", "en", "E1"));
		const unlinked = await run(deps, french(), csv, { dryRun: true, fields });
		expect(unlinked.rows[0]).toMatchObject({
			errors: [{ code: "translation_source_not_found" }],
		});
		expect(deps.content.calls).not.toContain("find:E1");
	});

	it("reports an ambiguous source ID as the record's error", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await deps.links.delete(linkKey("products", "en", "E1"));
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		expect(row).toMatchObject({
			status: "failed",
			errors: [{ field: "translationOf", code: "ambiguous_source_id" }],
		});
	});

	it("maps a CONFLICT and a NOT_FOUND from the create to their codes", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const desk = en.get("E1")!;
		let raced = false;
		deps.content.failWrite = (data) => {
			if (data.title === "Bureau" && !raced) {
				// Another writer adds the French translation between the group read and the create.
				raced = true;
				void deps.content.create({
					collection: "products",
					locale: "fr",
					data: { title: "Racer" },
					translationOf: desk.id,
				});
				return new ContentWriteError("emdash_conflict", "Translation already exists");
			}
			if (data.title === "Lampe") {
				return new ContentWriteError("emdash_not_found", "Translation source content not found");
			}
			return null;
		};
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F2", "E2", "Lampe");
		const {
			rows: [conflict, gone],
		} = await run(deps, french(), csv);
		const racer = [...deps.content.entries.values()].find((e) => e.data.title === "Racer")!.id;
		expect(conflict).toMatchObject({
			status: "failed",
			action: "create",
			errors: [{ code: "translation_exists", message: expect.stringContaining(racer) }],
		});
		expect(gone).toMatchObject({
			status: "failed",
			errors: [
				{
					code: "translation_source_not_found",
					message: `The source entry ${en.get("E2")!.id} (en: E2) no longer exists`,
				},
			],
		});
	});

	it("charges each record's lookups to the batch budget, with source hits cached", async () => {
		// Per linked create: COST_RECORD 25, the source's link row 1 and read 5, the group read 5.
		const plain = french({
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const csv =
			FR_HEADER +
			frRow("F1", "E1", "Bureau") +
			frRow("F2", "E1", "Bureau 2") +
			frRow("F3", "E2", "Lampe");
		for (const [budget, seq] of [
			[36, 1],
			[37, 2],
			// The second record finds E1 in the cache (25 + 5), so 66 is spent after two.
			[66, 2],
			[67, 3],
		] as const) {
			const { deps } = setup();
			await importEnglish(deps);
			const job = await start(deps, plain, csv);
			const after = await runBatch(deps, job.id, "driver", Number.POSITIVE_INFINITY, budget);
			expect([budget, after.cursor.seq]).toEqual([budget, seq]);
		}
	});

	it("repairs a crash after a linked create by the source key, creating no second entry", async () => {
		const { deps, clock } = setup();
		const en = await importEnglish(deps);
		const job = await start(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		let crash = true;
		deps.content.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toBeNull();
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		// As for any create the crash interrupted: the draft is not provably this job's, so it is
		// left unpublished (M2).
		expect(done.counters).toMatchObject({ created: 0, conflict: 1, failed: 0 });
		const fr = [...deps.content.entries.values()].filter((e) => e.locale === "fr");
		expect(fr).toHaveLength(1);
		expect(fr[0]?.group).toBe(en.get("E1")!.id);
		expect((await rows(deps, job.id))[0]).toMatchObject({
			entryId: fr[0]?.id,
			errors: [{ code: "publish_unverified" }],
		});
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: fr[0]?.id,
		});
	});
	it("repairs a crash only into the source's group, never adopting another record's entry", async () => {
		const { deps, clock } = setup();
		const en = await importEnglish(deps);
		// A French record keyed E1 imported as an entry of its own: its source ID is "E1" too.
		await run(deps, french(), FR_HEADER + frRow("E1", "", "Autre", ",S7,70,,,,"));
		const other = frEntry(deps, "autre")!;
		const job = await start(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const create = deps.content.create.bind(deps.content);
		let crash = true;
		deps.content.create = async (input) => {
			if (crash) {
				crash = false;
				throw new Error("process killed");
			}
			return create(input);
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		expect((await rows(deps, job.id))[0]).toMatchObject({ status: "writing", entryId: null });
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		const bureau = frEntry(deps, "bureau")!;
		expect(bureau.group).toBe(en.get("E1")!.id);
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: bureau.id,
		});
		expect(deps.content.entries.get(other.id)).toMatchObject({
			slug: "autre",
			data: { title: "Autre", sku: "S7", price: 70 },
		});
	});

	it("repairs from an earlier row that names the entry, whatever its status", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		// F3 has no source, so the job keeps its file for a retry.
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F3", "E3", "Chaise");
		const first = await run(deps, french(), csv);
		const bureau = frEntry(deps, "bureau")!;
		// The link is lost and the row failed after the write: only its entry ID names the entry.
		await deps.links.delete(linkKey("products", "fr", "F1"));
		const row = first.rows[0]!;
		await deps.records.put(recordKey(first.job.id, row.seq), {
			...row,
			status: "failed",
			errors: [{ field: "title", code: "emdash_error", message: "Lost" }],
		});
		await transitionJob(deps, first.job.id, "retry");
		await runToEnd(deps, first.job.id);
		expect([...deps.content.entries.values()].filter((e) => e.locale === "fr")).toHaveLength(1);
		expect(bureau.group).toBe(en.get("E1")!.id);
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: bureau.id,
		});
		const [retried] = await rows(deps, first.job.id);
		expect(retried).toMatchObject({ entryId: bureau.id });
		expect(retried?.status).not.toBe("failed");
	});

	const plain = () =>
		french({
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
	const twoLinked = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F2", "E2", "Lampe");

	it("charges the entry read through the link row without link mappings", async () => {
		// Per re-run record: COST_RECORD 25, the source's link row 1 and read 5, the entry's read 5.
		for (const [budget, seq] of [
			[36, 1],
			[37, 2],
		] as const) {
			const { deps } = setup();
			await importEnglish(deps);
			await run(deps, plain(), twoLinked);
			const job = await start(deps, plain(), twoLinked);
			const after = await runBatch(deps, job.id, "driver", Number.POSITIVE_INFINITY, budget);
			expect([budget, after.cursor.seq]).toEqual([budget, seq]);
		}
	});

	it("charges crash repair's read without link mappings", async () => {
		// The repaired record: COST_RECORD 25, the source's link row 1 and read 5, the repair read 5.
		for (const [budget, seq] of [
			[36, 1],
			[37, 2],
		] as const) {
			const { deps, clock } = setup();
			await importEnglish(deps);
			const job = await start(deps, plain(), twoLinked);
			let crash = true;
			deps.content.afterWrite = () => {
				if (crash) {
					crash = false;
					throw new Error("process killed");
				}
			};
			await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
			clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
			const after = await runBatch(deps, job.id, "driver", Number.POSITIVE_INFINITY, budget);
			expect([budget, after.cursor.seq]).toEqual([budget, seq]);
		}
	});

	it("keeps emdash_conflict for a CONFLICT whose re-read finds no translation", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		deps.content.failWrite = (data) =>
			data.title === "Bureau" ? new ContentWriteError("emdash_conflict", "Slug taken") : null;
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		expect(row).toMatchObject({
			action: "create",
			errors: [{ code: "emdash_conflict", message: "Slug taken" }],
		});
		expect(frEntry(deps, "bureau")).toBeUndefined();
	});

	it("retries a CONFLICT row as translation_exists and a NOT_FOUND row as a linked create", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const desk = en.get("E1")!;
		const lamp = en.get("E2")!;
		let raced = false;
		let trashed = false;
		deps.content.failWrite = (data) => {
			if (data.title === "Bureau" && !raced) {
				raced = true;
				void deps.content.create({
					collection: "products",
					locale: "fr",
					data: { title: "Racer" },
					translationOf: desk.id,
				});
				return new ContentWriteError("emdash_conflict", "Translation already exists");
			}
			if (data.title === "Lampe" && !trashed) {
				// The source goes between its lookup and the create, so EmDash answers NOT_FOUND.
				trashed = true;
				deps.content.entries.delete(lamp.id);
			}
			return null;
		};
		const first = await run(deps, french(), twoLinked);
		expect(first.rows.map((r) => r.errors?.[0]?.code)).toEqual([
			"translation_exists",
			"translation_source_not_found",
		]);
		const newLamp = (await importEnglish(deps)).get("E2")!;
		expect(newLamp.id).not.toBe(lamp.id);
		await transitionJob(deps, first.job.id, "retry");
		const retried = await runToEnd(deps, first.job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 1 });
		const racer = [...deps.content.entries.values()].find((e) => e.data.title === "Racer")!;
		const [conflict, created] = await rows(deps, first.job.id);
		// Found by the group read before the create this time, so the row has no action.
		expect(conflict).toMatchObject({
			status: "failed",
			errors: [{ code: "translation_exists", message: expect.stringContaining(racer.id) }],
		});
		expect(racer.data.title).toBe("Racer");
		expect(created).toMatchObject({ status: "created", entryId: frEntry(deps, "lampe")?.id });
		expect(frEntry(deps, "lampe")?.group).toBe(newLamp.id);
	});

	it("reports sharedRequired errors after the record's other errors", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const fields = schemaFields.map((f) => (f.slug === "sku" ? { ...f, required: true } : f));
		const template = french({
			fields: {
				title: { from: "Nom", type: "text" },
				price: { from: "Prix", type: "number" },
			},
			taxonomies: undefined,
			bylines: undefined,
		});
		const job = await start(deps, template, FR_HEADER + frRow("F4", "", "Tabouret", ",,abc,,,,"), {
			fields,
		});
		await runToEnd(deps, job.id);
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			errors: [
				{ field: "price", code: expect.any(String) },
				{ field: "sku", code: "required" },
			],
		});
		expect(row?.errors?.[0]?.code).not.toBe("required");
	});
	const plainFrench = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		version: 1,
		collection: "products",
		locale: "fr",
		key: { from: "id" },
		slug: { from: "handle" },
		fields: { title: { from: "Nom", type: "text" }, ...fields },
		...extra,
	});

	/** Makes the next create throw before it writes, as a crash would. */
	function crashOnNextCreate(deps: Deps) {
		const create = deps.content.create.bind(deps.content);
		let crash = true;
		deps.content.create = async (input) => {
			if (crash) {
				crash = false;
				throw new Error("process killed");
			}
			return create(input);
		};
	}

	const SHARED_MESSAGE =
		"The entry is a translation of another entry: to update it, the template must map translationOf or drop its shared mappings, which would otherwise overwrite its translation group's values";

	it("fails translation_of_missing when a template without translationOf maps shared values onto a translation", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const bureau = frEntry(deps, "bureau")!;
		const before = structuredClone(bureau.data);
		const csv = FR_HEADER + frRow("F1", "", "Bureau neuf", ",S9,99,,,new,");
		for (const template of [
			plainFrench({ price: { from: "Prix", type: "number" } }),
			plainFrench({}, { taxonomies: { tag: { from: "Tags" } } }),
		]) {
			const {
				rows: [row],
			} = await run(deps, template, csv);
			expect(row).toMatchObject({
				status: "failed",
				entryId: bureau.id,
				errors: [
					{ field: "translationOf", code: "translation_of_missing", message: SHARED_MESSAGE },
				],
			});
		}
		expect(deps.content.entries.get(bureau.id)?.data).toEqual(before);
	});

	it("updates a translation from a template without translationOf that maps only translatable fields", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const {
			rows: [row],
		} = await run(deps, plainFrench({}), FR_HEADER + frRow("F1", "", "Bureau neuf"));
		expect(row).toMatchObject({ status: "updated" });
		expect(frEntry(deps, "bureau-neuf")?.data).toMatchObject({ title: "Bureau neuf", price: 10 });
	});

	it("saves no link when crash repair finds a translation for a template without translationOf", async () => {
		const { deps, clock } = setup();
		const en = await importEnglish(deps);
		// An editor's translation of E1 carries the source ID "E1", the French record's key.
		const editor = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau (éditeur)" },
			translationOf: en.get("E1")!.id,
		});
		const template = plainFrench({ price: { from: "Prix", type: "number" } });
		const job = await start(deps, template, FR_HEADER + frRow("E1", "", "Bureau", ",,99,,,,"));
		crashOnNextCreate(deps);
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		await runToEnd(deps, job.id);
		expect((await rows(deps, job.id))[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "translation_of_missing", message: SHARED_MESSAGE }],
		});
		expect(await deps.links.get(linkKey("products", "fr", "E1"))).toBeNull();
		expect(deps.content.entries.get(editor.id)?.data).toMatchObject({
			title: "Bureau (éditeur)",
			price: 10,
		});
	});

	it("creates an entry of its own when crash repair finds a translation for a record without a value", async () => {
		const { deps, clock } = setup();
		const en = await importEnglish(deps);
		const editor = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau (éditeur)" },
			translationOf: en.get("E1")!.id,
		});
		// Keyed E1 with no value: its source ID is "E1", as the editor's translation's is.
		const job = await start(deps, french(), FR_HEADER + frRow("E1", "", "Tabouret", ",S4,40,,,,"));
		crashOnNextCreate(deps);
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		await runToEnd(deps, job.id);
		const own = frEntry(deps, "tabouret")!;
		expect(own.group).toBe(own.id);
		expect((await rows(deps, job.id))[0]).toMatchObject({ status: "created", entryId: own.id });
		expect(await deps.links.get(linkKey("products", "fr", "E1"))).toMatchObject({
			entryId: own.id,
		});
		expect(deps.content.entries.get(editor.id)?.data.title).toBe("Bureau (éditeur)");
	});

	it("fails the second of two records that name the same source", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F2", "E1", "Bureau 2");
		const { rows: done } = await run(deps, french(), csv);
		const bureau = frEntry(deps, "bureau")!;
		expect(done[0]).toMatchObject({ status: "created", entryId: bureau.id });
		expect(done[1]).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "translationOf",
					code: "translation_exists",
					message: `The source entry already has a translation in fr (entry ${bureau.id}), which is not this record's entry`,
				},
			],
		});
	});
});
