import { describe, expect, it } from "vitest";
import {
	bylinesConverter,
	isSingleReference,
	linkItems,
	referenceConverter,
	taxonomyConverter,
} from "../../src/engine/links.js";
import {
	applyTemplate,
	type CompileContext,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
} from "../../src/engine/template.js";
import type { TargetField } from "../../src/engine/values.js";

const ok = (value: unknown) => ({ ok: true, value });
const err = (code: string) => expect.objectContaining({ ok: false, code });

const single: TargetField = { type: "reference", required: false, relationSide: "parent" };
const multiple: TargetField = { ...single, multiple: true };
const childSide: TargetField = { type: "reference", required: false, relationSide: "child" };

describe("linkItems", () => {
	it("splits text on the separator, trims, and drops empty items and exact duplicates", () => {
		expect(linkItems(" a , b,,a, ", ",")).toEqual({ ok: true, items: ["a", "b"] });
		expect(linkItems("a|b", "|")).toEqual({ ok: true, items: ["a", "b"] });
		expect(linkItems("a, b", ";")).toEqual({ ok: true, items: ["a, b"] });
		expect(linkItems(["x", " y ", null, "", 7, true, "x"], ",")).toEqual({
			ok: true,
			items: ["x", "y", "7", "true"],
		});
		expect(linkItems(42, ",")).toEqual({ ok: true, items: ["42"] });
		expect(linkItems(null, ",")).toEqual({ ok: true, items: [] });
		expect(linkItems(undefined, ",")).toEqual({ ok: true, items: [] });
	});

	it("refuses objects and nested arrays", () => {
		expect(linkItems({ a: 1 }, ",")).toEqual(err("not_scalar"));
		expect(linkItems([["a"]], ",")).toEqual(err("not_scalar"));
		expect(linkItems([{ a: 1 }], ",")).toEqual(err("not_scalar"));
	});
});

describe("referenceConverter", () => {
	it("gives the items, or null when there are none", () => {
		const convert = referenceConverter({}, multiple);
		expect(convert("01A, 01B")).toEqual(ok(["01A", "01B"]));
		expect(convert(["01A", "01B", "01A"])).toEqual(ok(["01A", "01B"]));
		expect(convert(" ")).toEqual(ok(null));
		expect(convert(null)).toEqual(ok(null));
		expect(referenceConverter({ separator: "|" }, multiple)("a,b|c")).toEqual(ok(["a,b", "c"]));
	});

	it("takes at most 50 entries, and 1 for a single field", () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `e${i}`);
		expect(referenceConverter({}, multiple)(fifty)).toEqual(ok(fifty));
		expect(referenceConverter({}, multiple)([...fifty, "e50"])).toEqual({
			ok: false,
			code: "too_many_items",
			message: "51 items; at most 50 are allowed",
		});
		expect(referenceConverter({}, single)("a")).toEqual(ok(["a"]));
		expect(referenceConverter({}, single)("a, a")).toEqual(ok(["a"]));
		expect(referenceConverter({}, single)("a, b")).toEqual({
			ok: false,
			code: "too_many_items",
			message: "2 items; at most 1 is allowed",
		});
		expect(referenceConverter({}, childSide)("a, b")).toEqual(ok(["a", "b"]));
		expect(referenceConverter({}, null)("a, b")).toEqual(ok(["a", "b"]));
	});

	it("refuses items longer than a slug or ID can be, and longer than a key for match key", () => {
		expect(referenceConverter({}, multiple)("x".repeat(200))).toEqual(ok(["x".repeat(200)]));
		expect(referenceConverter({}, multiple)("x".repeat(201))).toEqual(err("too_long"));
		expect(referenceConverter({ match: "key" }, multiple)("k".repeat(256))).toEqual(
			ok(["k".repeat(256)]),
		);
		expect(referenceConverter({ match: "key" }, multiple)("k".repeat(257))).toEqual(
			err("too_long"),
		);
	});

	it("knows single fields: the parent side without multiple", () => {
		expect(isSingleReference(single)).toBe(true);
		expect(isSingleReference(multiple)).toBe(false);
		expect(isSingleReference(childSide)).toBe(false);
		expect(isSingleReference(null)).toBe(false);
	});
});

describe("taxonomyConverter", () => {
	const tree = taxonomyConverter({}, { hierarchical: true });
	const flat = taxonomyConverter({}, { hierarchical: false });

	it("splits hierarchical items into trimmed paths", () => {
		expect(tree("Electronics / Phones, News")).toEqual(
			ok([{ path: ["Electronics", "Phones"] }, { path: ["News"] }]),
		);
		const custom = taxonomyConverter({ separator: "|", hierarchy: ">" }, { hierarchical: true });
		expect(custom("a > b | c")).toEqual(ok([{ path: ["a", "b"] }, { path: ["c"] }]));
		expect(tree(["a/b", "c"])).toEqual(ok([{ path: ["a", "b"] }, { path: ["c"] }]));
		expect(tree("")).toEqual(ok(null));
	});

	it("never splits a flat taxonomy's items", () => {
		expect(flat("AC/DC, Rock")).toEqual(ok([{ path: ["AC/DC"] }, { path: ["Rock"] }]));
		expect(taxonomyConverter({}, null)("a/b")).toEqual(ok([{ path: ["a/b"] }]));
	});

	it("refuses empty levels, more than 10 levels and levels over 200 characters", () => {
		expect(tree("a//b")).toEqual({
			ok: false,
			code: "invalid_term_path",
			message: '"a//b" has an empty level',
		});
		expect(tree("a/")).toEqual(err("invalid_term_path"));
		expect(tree("a/ /b")).toEqual(err("invalid_term_path"));
		const ten = Array.from({ length: 10 }, (_, i) => `l${i}`).join("/");
		expect(tree(ten)).toMatchObject({ ok: true });
		expect(tree(`${ten}/l10`)).toEqual({
			ok: false,
			code: "invalid_term_path",
			message: `"${ten}/l10" has 11 levels; at most 10 are allowed`,
		});
		expect(tree(`a/${"x".repeat(201)}`)).toEqual(err("invalid_term_path"));
		expect(flat("x".repeat(201))).toEqual(err("invalid_term_path"));
	});

	it("takes at most 100 terms", () => {
		const terms = Array.from({ length: 101 }, (_, i) => `t${i}`);
		expect(flat(terms.slice(0, 100))).toMatchObject({ ok: true });
		expect(flat(terms)).toEqual({
			ok: false,
			code: "too_many_items",
			message: "101 items; at most 100 are allowed",
		});
	});
});

describe("bylinesConverter", () => {
	it("gives at most 50 slugs or names", () => {
		const convert = bylinesConverter({ separator: ";" });
		expect(convert("alex; Sam Lee")).toEqual(ok(["alex", "Sam Lee"]));
		expect(convert("")).toEqual(ok(null));
		const many = Array.from({ length: 51 }, (_, i) => `b${i}`);
		expect(bylinesConverter({})(many.slice(0, 50))).toMatchObject({ ok: true });
		expect(bylinesConverter({})(many)).toEqual(err("too_many_items"));
		expect(convert({ a: 1 })).toEqual(err("not_scalar"));
	});
});

const base = {
	version: 1,
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "Title", type: "text" } },
};

describe("templateSchema for links", () => {
	it("accepts the spec template, keeping the options as written", () => {
		const t = templateSchema.parse({
			...base,
			fields: {
				title: { from: "Title", type: "text" },
				author: { from: "AuthorKey", type: "reference", match: "key" },
				related: { from: "Related", type: "reference", match: "slug", separator: "|" },
			},
			taxonomies: {
				category: {
					from: "Categories",
					match: "label",
					separator: ",",
					hierarchy: ">",
					create: true,
				},
				tag: { from: "Tags", separator: "|" },
			},
			bylines: { from: "Authors", match: "name", separator: ";" },
		});
		expect(t.fields.author).toEqual({ from: "AuthorKey", type: "reference", match: "key" });
		expect(t.taxonomies).toEqual({
			category: {
				from: "Categories",
				match: "label",
				separator: ",",
				hierarchy: ">",
				create: true,
			},
			tag: { from: "Tags", separator: "|" },
		});
		expect(t.bylines).toEqual({ from: "Authors", match: "name", separator: ";" });
		expect(templateSchema.parse(base)).not.toHaveProperty("taxonomies");
	});

	it("refuses bad link options, names and unknown keys", () => {
		const issues = (extra: Record<string, unknown>) => {
			const parsed = templateSchema.safeParse({ ...base, ...extra });
			return parsed.success
				? []
				: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		};
		expect(
			issues({ fields: { a: { from: "A", type: "reference", match: "title" } } }),
		).toHaveLength(1);
		expect(issues({ fields: { a: { from: "A", type: "reference", separator: "" } } })).toHaveLength(
			1,
		);
		expect(issues({ taxonomies: { tag: { from: "T", separator: "/" } } })).toEqual([
			"taxonomies.tag: hierarchy must differ from separator",
		]);
		expect(issues({ taxonomies: { tag: { from: "T", hierarchy: "," } } })).toEqual([
			"taxonomies.tag: hierarchy must differ from separator",
		]);
		expect(issues({ taxonomies: { tag: { from: "T", separator: "/", hierarchy: ">" } } })).toEqual(
			[],
		);
		expect(issues({ taxonomies: { Tag: { from: "T" } } })).toEqual([
			'taxonomies.Tag: Invalid taxonomy name "Tag"',
		]);
		expect(issues({ taxonomies: { tag: { from: "T", expr: "T" } } })).toEqual([
			'taxonomies.tag: Set exactly one of "from" and "expr"',
		]);
		expect(issues({ taxonomies: { tag: { from: "T", parent: "x" } } })).toHaveLength(1);
		expect(issues({ bylines: { from: "B", match: "email" } })).toHaveLength(1);
		expect(issues({ bylines: { from: "B", roleLabel: "Editor" } })).toHaveLength(1);
		const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, { from: "T" }]));
		expect(issues({ taxonomies: many })).toEqual(["taxonomies: Map at most 20 taxonomies"]);
	});
});

const linked: Template = templateSchema.parse({
	...base,
	fields: {
		title: { from: "Title", type: "text" },
		author: { from: "Author", type: "reference", match: "key" },
		related: { from: "Related", type: "reference", separator: "|" },
	},
	taxonomies: {
		category: { from: "Categories", hierarchy: ">" },
		tag: { expr: "Tags" },
	},
	bylines: { from: "Authors", separator: ";" },
});

const context: CompileContext = {
	targets: {
		title: { type: "string", required: false },
		author: { type: "reference", required: true, relationSide: "parent" },
		related: { type: "reference", required: false, relationSide: "parent", multiple: true },
	},
	taxonomies: { category: { hierarchical: true }, tag: { hierarchical: false } },
};

function compiled(t: Template = linked, c: CompileContext = context) {
	const result = compileTemplate(t, c);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

describe("applyTemplate with links", () => {
	const row = {
		id: "P1",
		Title: "Hello",
		Author: "A1",
		Related: "one|two",
		Categories: "Electronics > Phones, News",
		Tags: ["AC/DC", "Rock"],
		Authors: "alex; Sam Lee",
	};

	it("keeps reference fields out of data and puts every link into links", async () => {
		expect(await applyTemplate(compiled(), row)).toEqual({
			ok: true,
			value: {
				key: "P1",
				data: { title: "Hello" },
				links: {
					references: { author: ["A1"], related: ["one", "two"] },
					taxonomies: {
						category: [{ path: ["Electronics", "Phones"] }, { path: ["News"] }],
						tag: [{ path: ["AC/DC"] }, { path: ["Rock"] }],
					},
					bylines: ["alex", "Sam Lee"],
				},
			},
		});
	});

	it("gives null for empty links, and leaves links out of templates without them", async () => {
		const result = await applyTemplate(compiled(), {
			...row,
			Related: "",
			Categories: null,
			Tags: [],
			Authors: " ; ",
		});
		expect(result.ok && result.value.links).toEqual({
			references: { author: ["A1"], related: null },
			taxonomies: { category: null, tag: null },
			bylines: null,
		});
		const plain = templateSchema.parse(base);
		expect(await applyTemplate(compiled(plain, {}), row)).toEqual({
			ok: true,
			value: { key: "P1", data: { title: "Hello" } },
		});
	});

	it("collects link errors with their field names, alongside field errors", async () => {
		const result = await applyTemplate(compiled(), {
			...row,
			Title: { a: 1 },
			Author: "",
			Related: Array.from({ length: 51 }, (_, i) => `r${i}`),
			Categories: "a>>b",
			Tags: [["x"]],
			Authors: Array.from({ length: 51 }, (_, i) => `b${i}`),
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["title", "not_scalar"],
			["author", "required"],
			["related", "too_many_items"],
			["taxonomies.category", "invalid_term_path"],
			["taxonomies.tag", "not_scalar"],
			["bylines", "too_many_items"],
		]);
	});

	it("reads link expressions and reports their failures under the link's name", async () => {
		const t = templateSchema.parse({
			...base,
			taxonomies: { tag: { expr: "Title + 1" } },
			bylines: { expr: "Authors" },
		});
		const result = await applyTemplate(compiled(t, {}), row);
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["taxonomies.tag", "expr_error"],
		]);
		const bad = templateSchema.parse({
			...base,
			taxonomies: { tag: { expr: "(" } },
			bylines: { expr: "[" },
		});
		const problems = compileTemplate(bad);
		expect(!problems.ok && problems.problems.map((p) => p.split(":")[0])).toEqual([
			"taxonomies.tag.expr",
			"bylines.expr",
		]);
	});

	it("does not split hierarchical paths without the job's taxonomy snapshot", async () => {
		const result = await applyTemplate(compiled(linked, { targets: context.targets }), row);
		expect(result.ok && result.value.links?.taxonomies?.category).toEqual([
			{ path: ["Electronics > Phones"] },
			{ path: ["News"] },
		]);
	});

	it("lists taxonomy and bylines paths as template paths", () => {
		expect(templatePaths(linked)).toEqual([
			"id",
			"Title",
			"Author",
			"Related",
			"Categories",
			"Authors",
		]);
	});
});
