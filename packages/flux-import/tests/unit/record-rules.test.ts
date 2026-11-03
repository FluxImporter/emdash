import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { canonicalMedia, fingerprint } from "../../src/engine/fingerprints.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { LinkRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";
import {
	csv,
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	runToEnd,
	setup,
	start,
	termGroup,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const lamp: Row = { sku: "B2", name: "Lamp", price: 5, tags: "sale", authors: "sam" };
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const rules = (r: Record<string, unknown>) => ({ extra: { rules: r } });
/** A tag mapping that creates missing terms, so tests can see whether one was created. */
const creatingTags = { tag: { from: "Tags", separator: "|", create: true } };
/** Wraps the link store's `put` to list the link rows each save names. */
const countPuts = (deps: Deps) => {
	const puts: string[] = [];
	const put = deps.links.put.bind(deps.links);
	deps.links.put = async (id: string, row: LinkRow) => {
		puts.push(id);
		return put(id, row);
	};
	return puts;
};

describe("write modes (M5b)", () => {
	it("skips an existing entry in create mode and creates a new one", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = deps.content.revOf(entryOf(deps, "A1").id);
		deps.lookups.calls.length = 0;
		deps.content.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, price: 99 }, lamp], rules({ mode: "create" }));
		expect(job.counters).toMatchObject({ created: 1, unchanged: 1, updated: 0 });
		const [skipped, created] = await records(deps, job.id);
		expect(skipped).toMatchObject({
			status: "unchanged",
			entryId: entryOf(deps, "A1").id,
			warnings: [
				{
					code: "exists",
					message: "Skipped: the entry exists and the import only creates entries (mode create)",
				},
			],
		});
		expect(skipped).not.toHaveProperty("changes");
		expect(created).toMatchObject({ status: "created", action: "create" });
		expect(deps.content.revOf(entryOf(deps, "A1").id)).toBe(before);
		expect(entryOf(deps, "A1").data.price).toBe(10);
		// The skipped record looked nothing up: the lamp's terms and bylines only.
		expect(deps.content.calls.filter((c) => c.includes(entryOf(deps, "A1").id))).toEqual([]);
		// Alone, a skipped record resolves no reference and reads no byline.
		deps.lookups.calls.length = 0;
		const alone = await importRows(deps, [{ ...desk, related: "B2" }], {
			extra: { rules: { mode: "create" }, fields: { ...relatedBySlug } },
		});
		expect(alone.counters).toMatchObject({ unchanged: 1 });
		expect(deps.lookups.calls.filter((c) => c.startsWith("find:"))).toEqual([]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines:"))).toEqual([]);
	});

	it("skips a record without an entry in update mode, before any lookup", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		deps.lookups.calls.length = 0;
		const job = await importRows(
			deps,
			[
				{ ...desk, price: 12 },
				{ ...lamp, tags: "brand-new", img: url("a.png") },
			],
			{ extra: { rules: { mode: "update" }, taxonomies: creatingTags } },
		);
		expect(job.counters).toMatchObject({ updated: 1, unchanged: 1, created: 0 });
		const [, skipped] = await records(deps, job.id);
		expect(skipped).toMatchObject({
			status: "unchanged",
			entryId: null,
			warnings: [
				{
					code: "not_found",
					message:
						"Skipped: no entry has this key and the import only updates entries (mode update)",
				},
			],
		});
		expect(deps.lookups.storedTerms.some((t) => t.slug === "brand-new")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.content.entries.size).toBe(1);
		expect(entryOf(deps, "A1").data.price).toBe(12);
	});

	it("creates the first of two records with one key and skips the second in create mode", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk, { ...desk, price: 20 }], rules({ mode: "create" }));
		expect(job.counters).toMatchObject({ created: 1, unchanged: 1 });
		expect((await records(deps, job.id))[1]?.warnings?.[0]?.code).toBe("exists");
		expect(entryOf(deps, "A1").data.price).toBe(10);
	});

	it("reports the same rows in a dry run, which plans a create for each duplicate key", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 99 }, lamp, lamp], {
			...rules({ mode: "create" }),
			dryRun: true,
		});
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.action, r.warnings?.[0]?.code])).toEqual([
			["planned", "unchanged", "exists"],
			["planned", "create", undefined],
			["planned", "create", undefined],
		]);
		expect(rows[0]).not.toHaveProperty("changes");
		expect(job.counters).toMatchObject({ unchanged: 1, created: 2 });
		const update = await importRows(deps, [lamp], { ...rules({ mode: "update" }), dryRun: true });
		expect((await records(deps, update.id))[0]).toMatchObject({
			status: "planned",
			action: "unchanged",
			warnings: [{ code: "not_found" }],
		});
	});

	it("finishes a resumed write in create mode rather than skipping it", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]), rules({ mode: "create" }));
		deps.content.beforePublish = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing" });
		deps.content.beforePublish = () => {};
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, unchanged: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published" });
	});

	it("retries a failed publish in create mode, which publishes the record's own draft", async () => {
		const { deps } = setup();
		deps.content.failPublish = () => "conflict";
		const job = await importRows(deps, [desk], rules({ mode: "create" }));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "publish_conflict" }],
		});
		deps.content.failPublish = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 1, conflict: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published" });
	});

	it("reports a failed record's entry as a template without rules does", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const plain = await importRows(deps, [{ ...desk, authors: "nobody" }]);
		const ruledJob = await importRows(
			deps,
			[{ ...desk, authors: "nobody" }],
			rules({ mode: "update" }),
		);
		const [without] = await records(deps, plain.id);
		const [withRules] = await records(deps, ruledJob.id);
		expect(without).toMatchObject({ status: "failed", entryId: null });
		expect(withRules).toMatchObject({ status: "failed", entryId: null });
	});

	it("does not retry skipped rows", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [desk], rules({ mode: "create" }));
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ unchanged: 1 });
	});
});

describe("updateFields (M5b)", () => {
	it("compares and writes only the listed mappings of an update", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png"), related: "" }]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		deps.mediaFetcher.calls.length = 0;
		deps.lookups.calls.length = 0;
		const job = await importRows(
			deps,
			[{ ...desk, name: "Desk 2", price: 12, img: url("b.png"), tags: "fresh", authors: "sam" }],
			{ extra: { rules: { updateFields: ["price"] }, taxonomies: creatingTags } },
		);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [{ field: "price", before: 10, after: 12 }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({
			slug: "desk",
			data: { title: "Editor", price: 12 },
			bylines: [{ bylineId: expect.any(String) }],
		});
		// Unlisted: no term created, no image downloaded, no byline lookup.
		expect(deps.lookups.storedTerms.some((t) => t.slug === "fresh")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines"))).toEqual([]);
	});

	it("writes every mapping on a create", async () => {
		const { deps } = setup();
		const job = await importRows(
			deps,
			[{ ...desk, img: url("a.png") }],
			rules({ updateFields: ["price"] }),
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({
			slug: "desk",
			data: { title: "Desk", price: 10, photo: { id: expect.any(String) } },
			taxonomies: { tag: ["new"] },
		});
	});

	it("compares every mapping of an entry crash repair found, which the job created", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]), {
			...rules({ updateFields: ["price"] }),
			publish: false,
		});
		deps.content.afterWrite = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterWrite = () => {};
		// The create landed and its link was never saved: crash repair finds the entry.
		expect(await deps.links.get("products:en:A1")).toBeNull();
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		// Every mapping was compared, not only the listed one.
		expect(Object.keys((await linkOf(deps, "A1")).fields ?? {}).sort()).toEqual([
			"bylines",
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"taxonomies.tag",
			"title",
		]);
	});

	it("writes a listed taxonomy and leaves the unlisted data and slug alone", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(
			deps,
			[{ ...desk, name: "Desk 2", tags: "sale" }],
			rules({ updateFields: ["taxonomies.tag"] }),
		);
		expect((await records(deps, job.id))[0]?.changes?.map((c) => c.field)).toEqual([
			"taxonomies.tag",
		]);
		expect(entryOf(deps, "A1")).toMatchObject({ slug: "desk", data: { title: "Desk" } });
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
	});

	it("leaves an unlisted reference unresolved and unwritten", async () => {
		const { deps } = setup();
		await importRows(deps, [lamp, { ...desk, related: "B2" }]);
		const first = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(deps, [{ sku: "C3", name: "Chair", price: 7 }]);
		deps.lookups.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, price: 12, related: "C3" }], {
			extra: { rules: { updateFields: ["price"] }, fields: { ...relatedBySlug } },
		});
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "price", before: 10, after: 12 }],
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("find:"))).toEqual([]);
		expect(entryOf(deps, "A1").references.related).toEqual([entryOf(deps, "B2").id]);
		expect((await linkOf(deps, "A1")).fields?.related).toBe(first.related);
	});

	it("leaves an unlisted Portable Text field unconverted, undownloaded and unwritten", async () => {
		const { deps } = makeDeps();
		deps.mediaFetcher.files.set(url("a.png"), { body: PNG(1), contentType: "image/png" });
		deps.mediaFetcher.files.set(url("b.png"), { body: PNG(2), contentType: "image/png" });
		const post = (title: string, image: string) =>
			`id,title,html\np1,${title},"<p>Hi</p><img src=""${url(image)}"" alt=""A"">"\n`;
		await runPosts(deps, post("Hello", "a.png"));
		const before = [...deps.content.entries.values()][0]?.data.body;
		deps.mediaFetcher.calls.length = 0;
		const job = await runPosts(deps, post("Hello 2", "b.png"), { updateFields: ["title"] });
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "updated", changes: [{ field: "title" }] });
		expect(row?.changes).toHaveLength(1);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect([...deps.content.entries.values()][0]?.data.body).toEqual(before);
	});

	it("records the written alt of a listed media field, so the next run needs no refresh", async () => {
		const { deps } = setup();
		const extra = {
			fields: {
				title: { from: "Name", type: "text" },
				photo: { from: "Img", type: "image", alt: { from: "Related" } },
			},
		};
		await importRows(deps, [{ ...desk, img: url("a.png"), related: "Old" }], { extra });
		const job = await importRows(deps, [{ ...desk, img: url("a.png"), related: "New" }], {
			extra: { ...extra, rules: { updateFields: ["photo"] } },
		});
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "photo.alt", after: "New" }],
		});
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, img: url("a.png"), related: "New" }], { extra });
		expect(puts).toEqual([]);
	});
});

describe("fingerprints on the link row (M5b)", () => {
	it("records one per mapping after a create, on a template without rules", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const { fields } = await linkOf(deps, "A1");
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
		for (const value of Object.values(fields ?? {})) expect(value).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});

	it("gives a written mapping a new fingerprint and keeps the others", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const first = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(deps, [{ ...desk, price: 12 }]);
		const second = (await linkOf(deps, "A1")).fields ?? {};
		expect(second.price).not.toBe(first.price);
		expect({ ...second, price: first.price }).toEqual(first);
	});

	it("keeps an unlisted mapping's fingerprint, and merges two templates sharing the key", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const first = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(
			deps,
			[{ ...desk, name: "Desk 2", price: 12 }],
			rules({ updateFields: ["price"] }),
		);
		const second = (await linkOf(deps, "A1")).fields ?? {};
		expect(second.title).toBe(first.title);
		expect(second.slug).toBe(first.slug);
		expect(second.price).not.toBe(first.price);
		// A second template with the same collection, locale and key maps only the title.
		await importRows(deps, [{ ...desk, name: "Desk 3", price: 12 }], {
			extra: {
				slug: undefined,
				fields: { title: { from: "Name", type: "text" } },
				taxonomies: undefined,
				bylines: undefined,
			},
		});
		const third = (await linkOf(deps, "A1")).fields ?? {};
		expect(third.title).not.toBe(second.title);
		expect({ ...third, title: second.title }).toEqual(second);
	});

	it("gives a mapping equal to the feed the fingerprint of the entry's value", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, featured: true }]);
		const e = entryOf(deps, "A1");
		// EmDash reads a boolean back as 1; the fingerprint is the same.
		e.data.featured = 1;
		const before = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(deps, [{ ...desk, featured: true, price: 11 }]);
		expect((await linkOf(deps, "A1")).fields?.featured).toBe(before.featured);
	});

	it("gives an unchanged image the fingerprint of the entry's value, an editor's alt included", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const before = (await linkOf(deps, "A1")).fields?.photo;
		const e = entryOf(deps, "A1");
		// An editor's alt, which the template does not map: the image itself equals the feed's.
		const held = { ...(e.data.photo as Record<string, unknown>), alt: "Editor" };
		e.data.photo = held;
		await importRows(deps, [{ ...desk, img: url("a.png"), price: 11 }]);
		const after = (await linkOf(deps, "A1")).fields?.photo;
		expect(after).not.toBe(before);
		expect(after).toBe(await fingerprint(canonicalMedia(held)));
	});

	it("starts from no fingerprints when it creates an entry for a link whose entry is gone", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const old = entryOf(deps, "A1");
		await deps.content.trash("products", old.id);
		await importRows(deps, [{ ...desk, name: "Desk B" }], {
			extra: { taxonomies: undefined, bylines: undefined },
		});
		const link = await linkOf(deps, "A1");
		expect(link.entryId).not.toBe(old.id);
		expect(Object.keys(link.fields ?? {}).sort()).toEqual([
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"title",
		]);
	});

	it("refreshes a link saved before M5b once, keeping its revision and job", async () => {
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const saved = await linkOf(deps, "A1");
		const { fields: _fields, ...old } = saved;
		await deps.links.put("products:en:A1", old);
		const puts: string[] = [];
		const put = deps.links.put.bind(deps.links);
		deps.links.put = async (id: string, row: LinkRow) => {
			puts.push(id);
			return put(id, row);
		};
		const job = await importRows(deps, [desk]);
		expect(job.counters).toMatchObject({ unchanged: 1 });
		expect(puts).toEqual(["products:en:A1"]);
		expect(await linkOf(deps, "A1")).toEqual({ ...old, jobId: first.id, fields: saved.fields });
		await importRows(deps, [desk]);
		expect(puts).toEqual(["products:en:A1"]);
	});

	it("writes nothing in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const saved = await linkOf(deps, "A1");
		const { fields: _fields, ...old } = saved;
		await deps.links.put("products:en:A1", old);
		await importRows(deps, [{ ...desk, price: 30 }], { dryRun: true });
		expect(await linkOf(deps, "A1")).toEqual(old);
	});

	it("fingerprints the terms the entry holds, so a term changed through the terms route differs", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = (await linkOf(deps, "A1")).fields ?? {};
		deps.content.setTerms(entryOf(deps, "A1").id, "tag", ["sale"]);
		await importRows(deps, [{ ...desk, tags: "sale" }]);
		const after = (await linkOf(deps, "A1")).fields ?? {};
		expect(after["taxonomies.tag"]).not.toBe(before["taxonomies.tag"]);
		expect(termGroup(deps, "sale")).toBeDefined();
	});
});

/** The related field matched by slug, so that resolving it shows as a `find:` lookup. */
const relatedBySlug = {
	title: { from: "Name", type: "text" },
	price: { from: "Price", type: "number" },
	featured: { from: "Featured", type: "boolean" },
	photo: { from: "Img", type: "image" },
	related: { from: "Related", type: "reference", match: "slug", separator: "|" },
};

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const postFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "body", type: "portableText" },
	{ slug: "flux_source_id", type: "string" },
];

/** Imports posts with a title and an HTML body into a Portable Text field. */
async function runPosts(deps: Deps, body: string, rules?: Record<string, unknown>) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, body);
	const job = await createJob(deps, {
		uploadId: upload,
		template: {
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: {
				title: { from: "title", type: "text" },
				body: { from: "html", type: "portableText", format: "html" },
			},
			...(rules ? { rules } : {}),
		},
		schemaFields: postFields,
		mediaMaxBytes: 1000,
	});
	return runToEnd(deps, job.id);
}
