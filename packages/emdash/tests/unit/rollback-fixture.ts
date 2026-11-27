/**
 * A products collection for the M5a journal and rollback tests: text, number, boolean, image and
 * reference fields, a slug, a tag taxonomy and bylines, over the fakes.
 */
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, JournalEntry, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

export type Deps = ReturnType<typeof makeDeps>["deps"];

export const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "featured", type: "boolean" },
	{ slug: "photo", type: "image" },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
	{ slug: "flux_source_id", type: "string" },
];

export const template = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "Name" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number" },
		featured: { from: "Featured", type: "boolean" },
		photo: { from: "Img", type: "image" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: { tag: { from: "Tags", separator: "|" } },
	bylines: { from: "Authors", separator: "|" },
	...extra,
});

export type Row = {
	sku: string;
	name: string;
	price?: number;
	featured?: boolean;
	img?: string;
	related?: string;
	tags?: string;
	authors?: string;
};

export function csv(rows: Row[]): string {
	const lines = rows.map((r) =>
		[
			r.sku,
			r.name,
			r.price ?? "",
			r.featured === undefined ? "" : String(r.featured),
			r.img ?? "",
			r.related ?? "",
			r.tags ?? "",
			r.authors ?? "",
		].join(","),
	);
	return ["sku,Name,Price,Featured,Img,Related,Tags,Authors", ...lines, ""].join("\n");
}

export const url = (name: string) => `https://cdn.test/${name}`;
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

/** The tag taxonomy with `new` and `sale`, the bylines `alex` and `sam`, and three images. */
export function seed(deps: Deps): void {
	deps.lookups.defs.push({
		name: "tag",
		hierarchical: false,
		collections: ["products"],
		locale: "en",
	});
	deps.lookups.addTerm("tag", "new", "New");
	deps.lookups.addTerm("tag", "sale", "Sale");
	deps.lookups.addByline("alex", "Alex");
	deps.lookups.addByline("sam", "Sam");
	deps.mediaFetcher.files.set(url("a.png"), { body: PNG(1), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("b.png"), { body: PNG(2), contentType: "image/png" });
	// The same bytes as a.png under another URL: the upload finds the stored item.
	deps.mediaFetcher.files.set(url("copy.png"), { body: PNG(1), contentType: "image/png" });
}

export function setup() {
	const made = makeDeps();
	seed(made.deps);
	return made;
}

export type StartOptions = {
	dryRun?: boolean;
	publish?: boolean;
	journal?: boolean;
	batchSize?: number;
	/** M5b: whether the collection keeps revisions, for templates that map publishAt. */
	revisions?: boolean;
	/** `false`: the collection refuses schedules (EmDash 1.5 `no-scheduling`). */
	scheduling?: false;
	/** M5c: the URL source the job's file came from (`Job.sourceId`). */
	sourceId?: string;
	/** M5c: the job option `missing`. */
	missing?: false | { maxPercent: number };
	extra?: Record<string, unknown>;
};

/**
 * Makes the test clock move 3 ms on every read, so writes get distinct timestamps as they do in
 * EmDash; the fixed clock suits tests that compare times.
 */
export function ticking(clock: { t: number }): void {
	let t = clock.t;
	Object.defineProperty(clock, "t", {
		get: () => {
			t += 3;
			return t;
		},
		set: (v: number) => {
			t = v;
		},
	});
}

export async function start(deps: Deps, body: string, opts: StartOptions = {}): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, body);
	const { extra, ...rest } = opts;
	return createJob(deps, {
		uploadId: upload,
		template: template(extra),
		schemaFields,
		linkSchema: {
			targets: { products: [{ slug: "flux_source_id", type: "string" }] },
			taxonomies: deps.lookups.defs,
		},
		mediaMaxBytes: 1000,
		...rest,
	});
}

export async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running" && job.status !== "created") return job;
	}
	throw new Error("did not finish");
}

/** Starts an import and runs it to the end. */
export async function importRows(deps: Deps, rows: Row[], opts: StartOptions = {}): Promise<Job> {
	const job = await start(deps, csv(rows), opts);
	return runToEnd(deps, job.id);
}

export async function records(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

export async function journalOf(deps: Deps, jobId: string): Promise<JournalEntry[]> {
	const page = await deps.journal.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

/** The fake entry imported with this key. */
export function entryOf(deps: Deps, key: string) {
	const entry = [...deps.content.entries.values()].find((e) => e.data.flux_source_id === key);
	if (!entry) throw new Error(`No entry for ${key}`);
	return entry;
}

/** A term's translation group (the fake's term ID) by slug. */
export function termGroup(deps: Deps, slug: string): string {
	const term = deps.lookups.storedTerms.find((t) => t.slug === slug);
	if (!term) throw new Error(`No term ${slug}`);
	return term.group;
}

export function bylineId(deps: Deps, slug: string): string {
	const byline = deps.lookups.storedBylines.find((b) => b.slug === slug);
	if (!byline) throw new Error(`No byline ${slug}`);
	return byline.id;
}
