import { describe, expect, it } from "vitest";
import type { LinkRequests } from "../../src/engine/links.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import {
	LookupCache,
	MAX_BYLINE_LOOKUP,
	type ResolveContext,
	resolveLinks,
} from "../../src/engine/resolve.js";
import { templateSchema } from "../../src/engine/template.js";
import { linkKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Options = {
	category?: Record<string, unknown>;
	tag?: Record<string, unknown>;
	bylines?: Record<string, unknown>;
	dryRun?: boolean;
};

function setup(o: Options = {}) {
	const { deps } = makeDeps();
	const template = templateSchema.parse({
		version: 1,
		collection: "posts",
		locale: "en",
		key: { from: "id" },
		fields: {
			title: { from: "Title", type: "text" },
			maker: { from: "Maker", type: "reference" },
			related: { from: "Related", type: "reference", match: "slug" },
			author: { from: "Author", type: "reference", match: "key" },
		},
		taxonomies: {
			category: { from: "Categories", ...o.category },
			tag: { from: "Tags", ...o.tag },
		},
		bylines: { from: "Authors", ...o.bylines },
	});
	const ref = (targetCollection: string) => ({
		type: "reference",
		required: false,
		relationSide: "parent" as const,
		multiple: true,
		targetCollection,
	});
	const ctx: ResolveContext = {
		template,
		targets: { maker: ref("makers"), related: ref("posts"), author: ref("people") },
		taxonomies: { category: { hierarchical: true }, tag: { hierarchical: false } },
		dryRun: o.dryRun ?? false,
	};
	const cache = new LookupCache();
	const resolve = (links: LinkRequests) => resolveLinks(deps, cache, ctx, links);
	return { deps, cache, ctx, resolve };
}

const paths = (...items: string[]) => items.map((i) => ({ path: i.split("/") }));

/** A category tree: electronics/phones, electronics/laptops, news, and phones' child "cases". */
function tree(deps: ReturnType<typeof makeDeps>["deps"]) {
	const l = deps.lookups;
	return {
		electronics: l.addTerm("category", "electronics", "Electronics"),
		phones: l.addTerm("category", "phones", "Phones", "electronics"),
		laptops: l.addTerm("category", "laptops", "Laptops", "electronics"),
		cases: l.addTerm("category", "cases", "Cases", "phones"),
		news: l.addTerm("category", "news", "News"),
		rock: l.addTerm("tag", "rock", "Rock"),
		acdc: l.addTerm("tag", "ac-dc", "AC/DC"),
	};
}

describe("resolveLinks: terms by slug", () => {
	it("finds flat slugs, paths from a root, and one segment at any depth", async () => {
		const { deps, resolve } = setup();
		const t = tree(deps);
		const result = await resolve({
			taxonomies: {
				category: paths("electronics/phones", "cases", "news"),
				tag: [{ path: ["ac-dc"] }],
			},
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				taxonomies: {
					category: [
						{ group: t.phones.group, value: "phones", text: "electronics/phones" },
						{ group: t.cases.group, value: "cases", text: "electronics/phones/cases" },
						{ group: t.news.group, value: "news", text: "news" },
					],
					tag: [{ group: t.acdc.group, value: "ac-dc", text: "ac-dc" }],
				},
			},
		});
	});

	it("fails a missing slug and a slug under another parent", async () => {
		const { deps, resolve } = setup();
		tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("news/phones", "electronics/tablets", "phones/cases/x") },
		});
		expect(!result.ok && result.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "term_path_mismatch",
				message: 'Term "phones" in "category" is at "electronics/phones", not under "news/phones"',
			},
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term with the slug "electronics/tablets" in "category"',
			},
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term with the slug "phones/cases/x" in "category"',
			},
		]);
		const root = await resolve({ taxonomies: { category: paths("phones/cases") } });
		expect(!root.ok && root.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
	});

	it("loads each taxonomy's terms once per batch", async () => {
		const { deps, resolve } = setup();
		tree(deps);
		await resolve({ taxonomies: { category: paths("news"), tag: paths("rock") } });
		await resolve({ taxonomies: { category: paths("electronics") } });
		expect(deps.lookups.calls).toEqual(["terms:category:en", "terms:tag:en"]);
	});
});

describe("resolveLinks: terms by label", () => {
	it("walks from the roots, matching exactly and then ignoring case", async () => {
		const { deps, resolve } = setup({ category: { match: "label" }, tag: { match: "label" } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: {
				category: paths("Electronics/phones", "NEWS"),
				tag: [{ path: ["ac/dc"] }],
			},
		});
		expect(result.ok && result.links.taxonomies).toEqual({
			category: [
				{ group: t.phones.group, value: "phones", text: "electronics/phones" },
				{ group: t.news.group, value: "news", text: "news" },
			],
			tag: [{ group: t.acdc.group, value: "ac-dc", text: "ac-dc" }],
		});
		// A label is looked up among the parent's children only: Phones is not a root.
		const nested = await resolve({ taxonomies: { category: paths("Phones") } });
		expect(!nested.ok && nested.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term labelled "Phones" in "category"',
			},
		]);
	});

	it("refuses two siblings with the same label, but not cousins", async () => {
		const { deps, resolve } = setup({ category: { match: "label" } });
		const l = deps.lookups;
		l.addTerm("category", "a", "A");
		l.addTerm("category", "b", "B");
		l.addTerm("category", "x-1", "X", "a");
		l.addTerm("category", "x-2", "X", "b");
		l.addTerm("category", "y-1", "Y", "a");
		l.addTerm("category", "y-2", "y", "a");
		l.addTerm("category", "z-1", "Zed", "b");
		l.addTerm("category", "z-2", "ZED", "b");
		l.addTerm("category", "x-3", "X", "b");
		const cousins = await resolve({
			taxonomies: { category: paths("A/X", "a/Y", "A/y", "B/Zed") },
		});
		// An exact label wins over one equal ignoring case.
		expect(cousins.ok && cousins.links.taxonomies?.category?.map((i) => i.value)).toEqual([
			"x-1",
			"y-1",
			"y-2",
			"z-1",
		]);
		const ambiguous = await resolve({ taxonomies: { category: paths("B/X", "B/zed") } });
		expect(!ambiguous.ok && ambiguous.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "ambiguous_term",
				message: 'More than one term in "category" is labelled "X" under "B"',
			},
			{
				field: "taxonomies.category",
				code: "ambiguous_term",
				message: 'More than one term in "category" is labelled "zed" under "B"',
			},
		]);
	});
});

describe("resolveLinks: creating terms", () => {
	it("creates a missing chain in label mode, passing parent row IDs and no slug", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Phones/Cases", "Garden/Tools/Hand Tools") },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([
			"create:category:Garden",
			"create:category:Tools",
			"create:category:Hand Tools",
		]);
		const garden = deps.lookups.storedTerms.find((x) => x.label === "Garden")!;
		const tools = deps.lookups.storedTerms.find((x) => x.label === "Tools")!;
		const hand = deps.lookups.storedTerms.find((x) => x.label === "Hand Tools")!;
		expect(tools.parentId).toBe(garden.group);
		expect(hand.parentId).toBe(tools.group);
		expect(result).toEqual({
			ok: true,
			newTerms: [
				"category: Garden",
				"category: Garden > Tools",
				"category: Garden > Tools > Hand Tools",
			],
			links: {
				taxonomies: {
					category: [
						{ group: t.cases.group, value: "cases", text: "electronics/phones/cases" },
						{ group: hand.group, value: "hand-tools", text: "garden/tools/hand-tools" },
					],
				},
			},
		});
		const again = await resolve({ taxonomies: { category: paths("Garden/Tools/Hand Tools") } });
		expect(again).toMatchObject({ ok: true, newTerms: [] });
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
	});

	it("creates under an existing parent, and shares a new parent between two items", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Tablets", "Toys/Cars", "Toys/Dolls") },
		});
		const tablets = deps.lookups.storedTerms.find((x) => x.label === "Tablets")!;
		expect(tablets.parentId).toBe(t.electronics.group);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([
			"create:category:Tablets",
			"create:category:Toys",
			"create:category:Cars",
			"create:category:Dolls",
		]);
		expect(result.newTerms).toEqual([
			"category: Electronics > Tablets",
			"category: Toys",
			"category: Toys > Cars",
			"category: Toys > Dolls",
		]);
	});

	it("creates with the segment as slug and label in slug mode, refusing non-slugs", async () => {
		const { deps, resolve } = setup({ category: { create: true } });
		tree(deps);
		const result = await resolve({ taxonomies: { category: paths("electronics/tablets") } });
		expect(result.ok && result.links.taxonomies?.category?.[0]?.text).toBe("electronics/tablets");
		expect(deps.lookups.storedTerms.find((x) => x.slug === "tablets")).toMatchObject({
			label: "tablets",
		});
		const bad = await resolve({
			taxonomies: { category: paths("electronics/Big Phones", "toys") },
		});
		expect(!bad.ok && bad.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "invalid_term_slug",
				message:
					'"Big Phones" is not a slug, so no term can be created with it (use lowercase letters, digits and hyphens, or match: "label")',
			},
		]);
		// The record failed a lookup, so nothing was created for it, not even "toys".
		expect(deps.lookups.storedTerms.some((x) => x.slug === "toys")).toBe(false);
		const elsewhere = await resolve({ taxonomies: { category: paths("toys/phones") } });
		expect(!elsewhere.ok && elsewhere.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
		expect(deps.lookups.storedTerms.some((x) => x.slug === "toys")).toBe(false);
	});

	it("creates nothing when another link of the record fails", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const result = await resolve({
			taxonomies: { category: paths("Garden") },
			bylines: ["nobody"],
		});
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["byline_not_found"]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	it("re-reads the terms after a failed create and uses the term a concurrent run made", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		deps.lookups.failCreate = (taxonomy, input) => {
			deps.lookups.addTerm(taxonomy, "garden", input.label);
			return Object.assign(new Error("Term 'garden' already exists"), { code: "CONFLICT" });
		};
		const result = await resolve({ taxonomies: { category: paths("Garden") } });
		expect(result).toMatchObject({
			ok: true,
			newTerms: [],
			links: { taxonomies: { category: [{ value: "garden", text: "garden" }] } },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("terms"))).toHaveLength(2);
	});

	it("fails term_create_failed when the term still cannot be found", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		deps.lookups.failCreate = () =>
			Object.assign(new Error("Parent term not found"), { code: "VALIDATION_ERROR" });
		const result = await resolve({ taxonomies: { category: paths("Garden/Tools") } });
		expect(result).toEqual({
			ok: false,
			newTerms: [],
			errors: [
				{
					field: "taxonomies.category",
					code: "term_create_failed",
					message: 'Could not create "Garden" in "category": Parent term not found',
				},
			],
		});
	});

	it("creates nothing in a dry run, listing what a real run would create", async () => {
		const { deps, resolve } = setup({
			category: { match: "label", create: true },
			dryRun: true,
		});
		tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Phones/Chargers", "Electronics/Tablets", "News") },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
		expect(result).toMatchObject({
			ok: true,
			newTerms: ["category: Electronics > Phones > Chargers", "category: Electronics > Tablets"],
		});
		expect(result.ok && result.links.taxonomies?.category).toEqual([
			{ group: null, value: "", text: "electronics/phones/chargers" },
			{ group: null, value: "", text: "electronics/tablets" },
			{ group: expect.any(String), value: "news", text: "news" },
		]);
		// A later record of the batch finds the term, as it would after a real run created it.
		const later = await resolve({ taxonomies: { category: paths("Electronics/Tablets") } });
		expect(later).toEqual({
			ok: true,
			newTerms: [],
			links: {
				taxonomies: { category: [{ group: null, value: "", text: "electronics/tablets" }] },
			},
		});
		expect(deps.lookups.storedTerms.some((x) => x.label === "Tablets")).toBe(false);
	});

	it("sees in a dry run the slug clash a real run would hit with a term it created", async () => {
		const { resolve } = setup({ category: { create: true }, dryRun: true });
		expect((await resolve({ taxonomies: { category: paths("toys") } })).ok).toBe(true);
		const clash = await resolve({ taxonomies: { category: paths("news/toys") } });
		expect(!clash.ok && clash.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
	});

	it("fails missing terms without create, in a dry run too", async () => {
		const { resolve } = setup({ dryRun: true });
		const result = await resolve({ taxonomies: { category: paths("garden") } });
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["term_not_found"]);
	});
});

describe("resolveLinks: references", () => {
	async function entries(deps: ReturnType<typeof makeDeps>["deps"]) {
		const maker = await deps.content.create({
			collection: "makers",
			locale: "en",
			slug: "acme",
			data: {},
		});
		const post = await deps.content.create({
			collection: "posts",
			locale: "en",
			slug: "hello",
			data: {},
		});
		const french = await deps.content.create({
			collection: "posts",
			locale: "fr",
			slug: "bonjour",
			data: {},
		});
		const person = await deps.content.create({
			collection: "people",
			locale: "en",
			data: { flux_source_id: "P1" },
		});
		return { maker, post, french, person };
	}

	it("finds entries by ID in any locale, by slug in the locale, and by key", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		const linked = await deps.content.create({ collection: "people", locale: "en", data: {} });
		await deps.links.put(linkKey("people", "en", "P2"), {
			collection: "people",
			locale: "en",
			sourceKey: "P2",
			entryId: linked.id,
		});
		const result = await resolve({
			references: {
				maker: [e.maker.id],
				related: ["hello"],
				author: ["P1", "P2"],
			},
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				references: {
					maker: [{ group: e.maker.id, value: e.maker.id, text: e.maker.id }],
					related: [{ group: e.post.id, value: e.post.id, text: e.post.id }],
					author: [
						{ group: e.person.id, value: e.person.id, text: e.person.id },
						{ group: linked.id, value: linked.id, text: linked.id },
					],
				},
			},
		});
		const other = await resolve({ references: { maker: [e.french.id], related: ["bonjour"] } });
		expect(!other.ok && other.errors).toEqual([
			{
				field: "maker",
				code: "reference_not_found",
				message: `No entry in "makers" has the ID "${e.french.id}"`,
			},
			{
				field: "related",
				code: "reference_not_found",
				message: 'No entry in "posts" (en) has the slug "bonjour"',
			},
		]);
	});

	it("does not take a slug in id mode, or a stale link", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		await deps.links.put(linkKey("people", "en", "P9"), {
			collection: "people",
			locale: "en",
			sourceKey: "P9",
			entryId: "gone",
		});
		const result = await resolve({ references: { maker: ["acme"], author: ["P9"] } });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "maker",
				code: "reference_not_found",
				message: 'No entry in "makers" has the ID "acme"',
			},
			{
				field: "author",
				code: "reference_not_found",
				message: 'No entry in "people" (en) was imported with the key "P9"',
			},
		]);
		expect(e.maker.id).not.toBe("acme");
	});

	it("caches hits but not misses, so a later record can find an entry created meanwhile", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		await resolve({ references: { maker: [e.maker.id], related: ["later"] } });
		await resolve({ references: { maker: [e.maker.id] } });
		expect(deps.lookups.calls.filter((c) => c.startsWith("find:makers"))).toHaveLength(1);
		await deps.content.create({ collection: "posts", locale: "en", slug: "later", data: {} });
		const found = await resolve({ references: { related: ["later"] } });
		expect(found.ok).toBe(true);
	});

	it("fails the record, not the job, on an ambiguous source ID or a read error", async () => {
		const { deps, resolve } = setup();
		await entries(deps);
		await deps.content.create({
			collection: "people",
			locale: "en",
			data: { flux_source_id: "P1" },
		});
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		const result = await resolve({ references: { author: ["P1"] } });
		expect(!result.ok && result.errors).toEqual([
			{ field: "author", code: "ambiguous_source_id", message: "More than one entry" },
		]);
		deps.lookups.findEntry = async () => {
			throw new Error("database is gone");
		};
		await expect(resolve({ references: { maker: ["x"] } })).rejects.toThrow("database is gone");
	});

	it("drops a second item that names the same entry or term, and resolves empty values to nothing", async () => {
		const { deps, resolve } = setup({ tag: { match: "label" } });
		const e = await entries(deps);
		const t = tree(deps);
		const result = await resolve({
			references: { maker: [e.maker.id], related: ["hello"] },
			taxonomies: { category: null, tag: paths("Rock", "ROCK") },
			bylines: null,
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				references: {
					maker: [{ group: e.maker.id, value: e.maker.id, text: e.maker.id }],
					related: [{ group: e.post.id, value: e.post.id, text: e.post.id }],
				},
				taxonomies: { category: [], tag: [{ group: t.rock.group, value: "rock", text: "rock" }] },
				bylines: [],
			},
		});
		const related = templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: { related: { from: "R", type: "reference" } },
		});
		const ids = await resolveLinks(
			deps,
			new LookupCache(),
			{
				template: related,
				targets: {
					related: { type: "reference", required: false, targetCollection: "posts" },
				},
				taxonomies: {},
				dryRun: false,
			},
			{ references: { related: [e.post.id, e.post.id] } },
		);
		expect(ids.ok && ids.links.references?.related).toHaveLength(1);
	});
});

describe("resolveLinks: bylines", () => {
	it("finds bylines by slug, or by trimmed display name, case-sensitive", async () => {
		const { deps, resolve } = setup({ bylines: { match: "name" } });
		const alex = deps.lookups.addByline("alex", " Alex Doe ");
		const sam = deps.lookups.addByline("sam", "Sam");
		deps.lookups.addByline("sam-fr", "Sam", "fr");
		deps.lookups.addByline("lee", "Lee");
		const result = await resolve({ bylines: ["Sam", "Alex Doe", "Sam"] });
		expect(result.ok && result.links.bylines).toEqual([
			{ group: sam.group, value: sam.id, text: "sam" },
			{ group: alex.group, value: alex.id, text: "alex" },
		]);
		const lower = await resolve({ bylines: ["sam"] });
		expect(!lower.ok && lower.errors).toEqual([
			{ field: "bylines", code: "byline_not_found", message: 'No byline (en) has the name "sam"' },
		]);
		// Loaded once per batch, two per page in the fake.
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines"))).toEqual([
			"bylines:en:",
			"bylines:en:2",
		]);
	});

	it("refuses two bylines with the same name", async () => {
		const { deps, resolve } = setup({ bylines: { match: "name" } });
		deps.lookups.addByline("sam-a", "Sam");
		deps.lookups.addByline("sam-b", "Sam");
		const result = await resolve({ bylines: ["Sam"] });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "bylines",
				code: "ambiguous_byline",
				message: 'More than one byline (en) is named "Sam"',
			},
		]);
		const bySlug = setup();
		bySlug.deps.lookups.addByline("sam-a", "Sam");
		expect((await bySlug.resolve({ bylines: ["sam-a"] })).ok).toBe(true);
	});

	it(`stops loading at ${MAX_BYLINE_LOOKUP} bylines and says so for a byline it did not find`, async () => {
		const { deps, resolve } = setup();
		for (let i = 0; i < MAX_BYLINE_LOOKUP + 2; i++) deps.lookups.addByline(`b${i}`, `B ${i}`);
		const result = await resolve({ bylines: ["b0", "b4999", "b5000"] });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "bylines",
				code: "byline_lookup_limit",
				message: `No byline (en) with the slug "b5000" among the first ${MAX_BYLINE_LOOKUP}; the site has more`,
			},
		]);
		expect(deps.lookups.calls).toHaveLength(MAX_BYLINE_LOOKUP / 2);
	});
});
