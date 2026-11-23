import { describe, expect, it } from "vitest";
import {
	createMapper,
	eligibleFields,
	type Sample,
	type SuggestField,
	suggestByName,
} from "../../src/engine/suggest.js";
import type { Template } from "../../src/engine/template.js";
import {
	buildDraft,
	type MergeInput,
	mergeAndDraft,
	mergeSuggestions,
	shapeChecked,
} from "../../src/plugin/ai/merge.js";
import { type ValidatedReply, validateReply } from "../../src/plugin/ai/reply.js";

const field = (slug: string, extra: Partial<SuggestField> = {}): SuggestField => ({
	slug,
	label: slug,
	type: "string",
	required: false,
	...extra,
});
function sample(
	rows: Record<string, unknown>[],
	keys: string[],
	format: Sample["format"] = "csv",
): Sample {
	return { format, keys, rows: rows.map((r) => new Map(Object.entries(r))) };
}
const DRAFT = { collection: "products", locale: "en", source: { format: "csv" } };
const item = (f: string, from: string | null, extra: Record<string, unknown> = {}) => ({
	field: f,
	from,
	confidence: "high",
	rationale: "model says",
	dateFormat: null,
	decimalComma: null,
	portableTextFormat: null,
	...extra,
});

/** The deterministic pass and, when given, a reply validated against everything sent. */
function setup(
	fields: SuggestField[],
	s: Sample,
	reply?: unknown,
	base: Template | null = null,
): MergeInput {
	const mapper = createMapper(s);
	const kept = new Set(Object.keys(base?.fields ?? {}));
	const open = fields.filter((f) => !kept.has(f.slug));
	// The base template's keys (Task 9 collects every "from"), never offered again (Ruling 59).
	const excluded = new Set(
		[...Object.values(base?.fields ?? {}).map((m) => m.from), base?.slug?.from].filter(
			(k): k is string => k !== undefined,
		),
	);
	const names = suggestByName(open, s, {
		mapper,
		...(base ? { excludedKeys: excluded, base: { hasSlug: base.slug !== undefined } } : {}),
	});
	const validated: ValidatedReply | null =
		reply === undefined
			? null
			: validateReply(reply, {
					fields: open,
					keys: s.keys,
					sample: s,
					mapper,
					keyColumn: base?.key.from ?? names.key?.from ?? null,
					keepKey: base !== null,
					keepSlug: base?.slug !== undefined,
				});
	return { fields, base, names, reply: validated };
}

const FIELDS = [
	field("title", { label: "Title", required: true }),
	field("headline"),
	field("summary"),
];
const ROWS = [
	{ sku: "1", Name: "A", Heading: "H", Teaser: "T", Blurb: "B" },
	{ sku: "2", Name: "B", Heading: "I", Teaser: "U", Blurb: "C" },
];
const KEYS = ["sku", "Name", "Heading", "Teaser", "Blurb"];

describe("mergeSuggestions (spec step 6.5, Rulings 25, 59, 64)", () => {
	it("keeps the deterministic answer without a reply, origin fallback", () => {
		const merged = mergeSuggestions(setup(FIELDS, sample(ROWS, KEYS)));
		expect(merged.method).toBe("fallback");
		expect(merged.key).toEqual({
			from: "sku",
			confidence: 0.9,
			rationale: "A usual name for a record identifier",
			origin: "fallback",
		});
		// All score 0.8; the required title goes first and takes Name, the first-seen key.
		expect(merged.fields.map((f) => [f.field, f.from, f.origin])).toEqual([
			["title", "Name", "fallback"],
			["headline", "Heading", "fallback"],
			["summary", "Teaser", "fallback"],
		]);
	});

	it("lets a provider item replace its field, null included, and confidence come from the reply", () => {
		const merged = mergeSuggestions(
			setup(FIELDS, sample(ROWS, KEYS), {
				key: null,
				slug: null,
				fields: [item("title", "Name"), item("summary", null, { confidence: "low" })],
			}),
		);
		expect(merged.method).toBe("ai");
		expect(merged.fields).toEqual([
			{
				field: "title",
				fieldType: "string",
				required: true,
				from: "Name",
				confidence: 0.9,
				rationale: "model says",
				origin: "ai",
				mapping: "text",
			},
			expect.objectContaining({ field: "headline", from: "Heading", origin: "fallback" }),
			{
				field: "summary",
				fieldType: "string",
				required: false,
				from: null,
				confidence: 0.3,
				rationale: "model says",
				origin: "ai",
			},
		]);
		expect([...merged.mappings.keys()]).toEqual(["title", "headline"]);
	});

	it("moves a field whose key a provider item took to its next free candidate, or to none", () => {
		// headline had Heading; the provider gives Heading to title, so headline takes its next
		// free candidate, Name, which title no longer holds.
		const merged = mergeSuggestions(
			setup(FIELDS, sample(ROWS, KEYS), {
				key: null,
				slug: null,
				fields: [item("title", "Heading")],
			}),
		);
		expect(merged.fields.find((f) => f.field === "headline")).toMatchObject({
			from: "Name",
			origin: "fallback",
		});
		const greedy = mergeSuggestions(
			setup(FIELDS, sample(ROWS, KEYS), {
				key: null,
				slug: null,
				fields: [item("title", "Heading"), item("summary", "Name")],
			}),
		);
		expect(greedy.fields.find((f) => f.field === "headline")).toMatchObject({
			from: null,
			confidence: 0,
			rationale: "No column or path matches this field",
			origin: "fallback",
		});
	});

	it("never moves a displaced field onto a key that another field's pick kept", () => {
		// summary takes Heading from headline; headline's other candidate, Name, stays title's.
		const merged = mergeSuggestions(
			setup(FIELDS, sample(ROWS, KEYS), {
				key: null,
				slug: null,
				fields: [item("summary", "Heading")],
			}),
		);
		expect(merged.fields.map((f) => [f.field, f.from, f.origin])).toEqual([
			["title", "Name", "fallback"],
			["headline", null, "fallback"],
			["summary", "Heading", "ai"],
		]);
	});

	it("never replaces a settled field, even with an item for it", () => {
		// The route never sends a settled field (Task 9); this setup sends it to prove the guard.
		const fields = [field("name"), field("title")];
		const input = setup(fields, sample(ROWS, KEYS), {
			key: null,
			slug: null,
			fields: [item("name", "Heading")],
		});
		expect(input.names.fields.get("name")?.settled).toBe(true);
		const merged = mergeSuggestions(input);
		expect(merged.fields[0]).toMatchObject({
			field: "name",
			from: "Name",
			confidence: 1,
			origin: "fallback",
		});
		expect(merged.fields[1]).toMatchObject({ field: "title", from: "Heading" });
		expect(merged.method).toBe("fallback");
	});

	it("ignores a provider item that takes a settled field's key; that field falls back (pre-flight F1)", () => {
		// sku settles on sku by exact name and sku is the key column, which the route always sends.
		const rows = [
			{ sku: "1", Heading: "H" },
			{ sku: "2", Heading: "I" },
		];
		const input = setup([field("sku"), field("name")], sample(rows, ["sku", "Heading"]), {
			key: null,
			slug: null,
			fields: [item("name", "sku")],
		});
		expect(input.names.fields.get("sku")?.settled).toBe(true);
		expect(input.reply?.items).toEqual([expect.objectContaining({ field: "name", from: "sku" })]);
		const merged = mergeSuggestions(input);
		expect(merged.key.from).toBe("sku");
		expect(merged.fields).toEqual([
			expect.objectContaining({ field: "sku", from: "sku", confidence: 1, origin: "fallback" }),
			{
				field: "name",
				fieldType: "string",
				required: false,
				from: "Heading",
				confidence: 0.8,
				rationale: "A usual name for this field",
				origin: "fallback",
				mapping: "text",
			},
		]);
		expect(merged.method).toBe("fallback");
	});

	it("ignores a provider item that takes a key the base template's fields map (pre-flight F1, F2)", () => {
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "csv" },
			key: { from: "sku" },
			fields: { sku: { from: "sku", type: "text" }, title: { from: "Name", type: "text" } },
		} as Template;
		const fields = [field("sku"), ...FIELDS];
		const merged = mergeSuggestions(
			setup(fields, sample(ROWS, KEYS), {
				key: null,
				slug: null,
				fields: [item("headline", "Name"), item("summary", "sku")],
			}),
		);
		// Without the base template the reply stands, so the rows below test the base's keys.
		expect(merged.fields.find((f) => f.field === "headline")).toMatchObject({
			from: "Name",
			origin: "ai",
		});
		const kept = mergeSuggestions(
			setup(
				fields,
				sample(ROWS, KEYS),
				{ key: null, slug: null, fields: [item("headline", "Name"), item("summary", "sku")] },
				base,
			),
		);
		expect(kept.fields.map((f) => [f.field, f.from, f.origin])).toEqual([
			["sku", "sku", "template"],
			["title", "Name", "template"],
			["headline", "Heading", "fallback"],
			["summary", "Teaser", "fallback"],
		]);
		expect(kept.method).toBe("fallback");
	});

	it("uses the provider's key and slug, and drops a field suggestion that used the slug key", () => {
		const s = sample(ROWS, KEYS);
		const merged = mergeSuggestions(setup(FIELDS, s, { key: "Name", slug: "Teaser", fields: [] }));
		expect(merged.key).toEqual({
			from: "Name",
			confidence: 0.6,
			rationale: "Suggested by the model",
			origin: "ai",
		});
		expect(merged.slug).toEqual({
			from: "Teaser",
			confidence: 0.6,
			rationale: "Suggested by the model",
			origin: "ai",
		});
		expect(merged.fields.find((f) => f.field === "summary")).toMatchObject({ from: "Blurb" });
		expect(merged.method).toBe("ai");
	});

	it("says ai for a reply whose only used item is its key, fallback when every item was dropped", () => {
		const s = sample(ROWS, KEYS);
		expect(mergeSuggestions(setup(FIELDS, s, { key: "Name", slug: null, fields: [] })).method).toBe(
			"ai",
		);
		const dropped = mergeSuggestions(
			setup(FIELDS, s, {
				key: "nope",
				slug: null,
				fields: [item("missing", "Name"), item("title", "nope")],
			}),
		);
		expect(dropped.method).toBe("fallback");
	});

	it("says ai for a reply whose only used item is its slug, fallback for only a null item", () => {
		const s = sample(ROWS, KEYS);
		const slugOnly = mergeSuggestions(setup(FIELDS, s, { key: null, slug: "Blurb", fields: [] }));
		expect(slugOnly.slug).toMatchObject({ from: "Blurb", origin: "ai" });
		expect(slugOnly.method).toBe("ai");
		// A null item replaces its field but puts nothing of the provider's in the draft (Ruling 64).
		const nullOnly = mergeSuggestions(
			setup(FIELDS, s, { key: null, slug: null, fields: [item("summary", null)] }),
		);
		expect(nullOnly.fields[2]).toMatchObject({ field: "summary", from: null, origin: "ai" });
		expect(nullOnly.method).toBe("fallback");
	});

	it("keeps the base template's key, slug and mappings whole, and never offers their keys", () => {
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "csv" },
			key: { from: "sku" },
			slug: { from: "Teaser" },
			fields: { title: { from: "Name", type: "text" } },
		} as Template;
		const merged = mergeSuggestions(
			setup(
				FIELDS,
				sample(ROWS, KEYS),
				{
					key: "Heading",
					slug: "Blurb",
					fields: [item("title", "Heading"), item("summary", "Teaser")],
				},
				base,
			),
		);
		expect(merged.key).toEqual({
			from: "sku",
			confidence: 1,
			rationale: "From the base template",
			origin: "template",
		});
		expect(merged.slug).toMatchObject({ from: "Teaser", origin: "template" });
		expect(merged.fields[0]).toEqual({
			field: "title",
			fieldType: "string",
			required: true,
			from: "Name",
			confidence: 1,
			rationale: "From the base template",
			origin: "template",
			mapping: "text",
		});
		expect(merged.fields.map((f) => f.from)).not.toContain("Teaser");
		expect([...merged.mappings.keys()]).not.toContain("title");
	});
});

/** A settled `sku` (also the key column), an open `headline`, and a slug-named `Handle`. */
const PROBE_FIELDS = [field("sku"), field("headline")];
const PROBE = sample(
	[
		{ sku: "1", Name: "A", Handle: "a", Heading: "H" },
		{ sku: "2", Name: "B", Handle: "b", Heading: "I" },
	],
	["sku", "Name", "Handle", "Heading"],
);

describe("the merge's reserved keys (task 8 review)", () => {
	it("counts a reply item it ignores for a settled field's key in ignored", () => {
		const input = setup(PROBE_FIELDS, PROBE, {
			key: null,
			slug: null,
			fields: [item("headline", "sku")],
		});
		expect(input.names.fields.get("sku")?.settled).toBe(true);
		// The validator sees one item and no duplicate: only the merge knows the key is settled.
		expect(input.reply?.warnings).toEqual([]);
		const merged = mergeSuggestions(input);
		expect(merged.ignored).toBe(1);
		expect(merged.fields[1]).toMatchObject({ field: "headline", from: "Name", origin: "fallback" });
		expect(merged.method).toBe("fallback");
		expect(mergeAndDraft(input, DRAFT).ignored).toBe(1);
		expect(mergeSuggestions(setup(PROBE_FIELDS, PROBE)).ignored).toBe(0);
	});

	it("ignores a provider slug on a settled field's key, falling back to name matching's", () => {
		const merged = mergeSuggestions(
			setup(PROBE_FIELDS, PROBE, { key: "Name", slug: "sku", fields: [] }),
		);
		expect(merged.key).toMatchObject({ from: "Name", origin: "ai" });
		expect(merged.slug).toMatchObject({ from: "Handle", origin: "fallback" });
	});

	it("ignores a provider slug on the key column, falling back to name matching's", () => {
		// The validator refuses this pair; a hand-made reply proves the merge's own guard.
		const input = setup(PROBE_FIELDS, PROBE);
		const merged = mergeSuggestions({
			...input,
			reply: { items: [], key: "Name", slug: "Name", warnings: [] },
		});
		expect(merged.key).toMatchObject({ from: "Name", origin: "ai" });
		expect(merged.slug).toMatchObject({ from: "Handle", origin: "fallback" });
	});

	it("drops a suggested slug on the key column, never a base template's", () => {
		const input = setup(PROBE_FIELDS, PROBE, { key: "Handle", slug: null, fields: [] });
		expect(input.names.slug?.from).toBe("Handle");
		const merged = mergeSuggestions(input);
		expect(merged.key).toMatchObject({ from: "Handle", origin: "ai" });
		expect(merged.slug).toBeUndefined();
		expect(mergeAndDraft(input, DRAFT).template?.slug).toBeUndefined();
		const base = shapeChecked({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			slug: { from: "sku" },
			fields: { sku: { from: "sku", type: "text" } },
		});
		if (!base) throw new Error("the base template must pass");
		const kept = mergeSuggestions(setup(PROBE_FIELDS, PROBE, undefined, base));
		expect(kept.slug).toMatchObject({ from: "sku", origin: "template" });
	});

	it("ignores and counts a reply item on name matching's slug key (plan Ruling 21)", () => {
		const merged = mergeSuggestions(
			setup(PROBE_FIELDS, PROBE, { key: null, slug: null, fields: [item("headline", "Handle")] }),
		);
		expect(merged.slug).toMatchObject({ from: "Handle", origin: "fallback" });
		expect(merged.ignored).toBe(1);
		expect(merged.fields[1]).toMatchObject({ field: "headline", from: "Name", origin: "fallback" });
	});
});

describe("mergeAndDraft (spec step 7, Ruling 27)", () => {
	it("builds a shape-valid draft with the input's source and locale", () => {
		const { template, warnings } = mergeAndDraft(setup(FIELDS, sample(ROWS, KEYS)), DRAFT);
		expect(template).toMatchObject({
			version: 1,
			source: { format: "csv" },
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { type: "text", from: "Name" },
				headline: { type: "text", from: "Heading" },
				summary: { type: "text", from: "Teaser" },
			},
		});
		expect(warnings).toEqual([]);
	});

	it("falls back to the deterministic draft when the provider's fails the shape check", () => {
		const s = sample([{ title: "A", note: "n" }], ["title", "a..b"], "json");
		const fields = [field("title"), field("note")];
		const { merged, template, warnings } = mergeAndDraft(
			setup(fields, s, { key: null, slug: null, fields: [item("note", "a..b")] }),
			{ ...DRAFT, source: { format: "json" } },
		);
		expect(warnings).toEqual([{ code: "ai_draft_invalid" }]);
		expect(template?.fields).toEqual({ title: { type: "text", from: "title" } });
		expect(merged.method).toBe("fallback");
		expect(merged.fields[1]).toMatchObject({ field: "note", from: null });
	});

	it("answers ai_draft_invalid then no_field_matched when the rebuilt draft maps nothing", () => {
		const s = sample([{ id: "1" }], ["id", "a..b"], "json");
		const { merged, template, warnings } = mergeAndDraft(
			setup([field("note")], s, { key: null, slug: null, fields: [item("note", "a..b")] }),
			{ ...DRAFT, source: { format: "json" } },
		);
		expect(template).toBeNull();
		expect(warnings).toEqual([{ code: "ai_draft_invalid" }, { code: "no_field_matched" }]);
		expect(merged.fields).toEqual([expect.objectContaining({ field: "note", from: null })]);
	});

	it("keeps the reply merge's ignored count when the draft is rebuilt", () => {
		const s = sample([{ sku: "1" }], ["sku", "a..b"], "json");
		const { merged, template, warnings, ignored } = mergeAndDraft(
			setup([field("sku"), field("note"), field("other")], s, {
				key: null,
				slug: null,
				fields: [item("note", "a..b"), item("other", "sku")],
			}),
			{ ...DRAFT, source: { format: "json" } },
		);
		expect(warnings).toEqual([{ code: "ai_draft_invalid" }]);
		expect(template?.fields).toEqual({ sku: { type: "text", from: "sku" } });
		expect(ignored).toBe(1);
		expect(merged.ignored).toBe(0);
	});

	it("reports fallback when the provider's key is all it gave and no draft is built", () => {
		const input = setup([field("colour")], sample(ROWS, KEYS), {
			key: "Name",
			slug: null,
			fields: [],
		});
		expect(mergeSuggestions(input).method).toBe("ai");
		const { merged, template, warnings } = mergeAndDraft(input, DRAFT);
		expect(template).toBeNull();
		expect(warnings).toEqual([{ code: "no_field_matched" }]);
		expect(merged.method).toBe("fallback");
	});

	it("warns ai_draft_invalid only for a failing draft that holds provider output", () => {
		// b settles on a..b, an invalid JSON path; the reply only says "no key fits" for note.
		const s = sample([{ id: "1", "a..b": "v" }], ["id", "a..b"], "json");
		const input = setup([field("b"), field("note")], s, {
			key: null,
			slug: null,
			fields: [item("note", null)],
		});
		expect(input.names.fields.get("b")).toMatchObject({ from: "a..b", settled: true });
		const { merged, template, warnings } = mergeAndDraft(input, {
			...DRAFT,
			source: { format: "json" },
		});
		expect(template).toBeNull();
		expect(warnings).toEqual([{ code: "no_field_matched" }]);
		expect(merged.method).toBe("fallback");
	});

	it("answers null and no_field_matched when no field is mapped", () => {
		const { template, warnings, merged } = mergeAndDraft(
			setup([field("colour")], sample([{ sku: "1" }], ["sku"])),
			DRAFT,
		);
		expect(template).toBeNull();
		expect(warnings).toEqual([{ code: "no_field_matched" }]);
		expect(merged.fields).toEqual([
			{
				field: "colour",
				fieldType: "string",
				required: false,
				from: null,
				confidence: 0,
				rationale: "No column or path matches this field",
				origin: "fallback",
			},
		]);
	});

	it("keeps a base template's other blocks and adds only the fields it lacks", () => {
		const base = {
			version: 1,
			collection: "products",
			locale: "fr",
			source: { format: "csv" },
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
			rules: { owner: "feed-a" },
		};
		const parsed = shapeChecked(base);
		if (!parsed) throw new Error("the base template must pass");
		const { template } = mergeAndDraft(setup(FIELDS, sample(ROWS, KEYS), undefined, parsed), DRAFT);
		expect(template).toMatchObject({ locale: "fr", rules: { owner: "feed-a" } });
		expect(template?.fields).toEqual({
			title: { from: "Name", type: "text" },
			headline: { from: "Heading", type: "text" },
			summary: { from: "Teaser", type: "text" },
		});
	});

	it("adds the suggested entry slug to a base template that has none", () => {
		const base = shapeChecked({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
		});
		if (!base) throw new Error("the base template must pass");
		const rows = ROWS.map((r) => ({ ...r, Handle: `h${r.sku}` }));
		const { template } = mergeAndDraft(
			setup(FIELDS, sample(rows, [...KEYS, "Handle"]), undefined, base),
			DRAFT,
		);
		expect(template?.slug).toEqual({ from: "Handle" });
		expect(template?.key).toEqual({ from: "sku" });
	});

	it("builds no draft without a key column or a field mapping", () => {
		const input = setup(FIELDS, sample(ROWS, KEYS));
		const merged = mergeSuggestions(input);
		expect(buildDraft(input, DRAFT, merged)).not.toBeNull();
		const keyless = { ...merged, key: { ...merged.key, from: null } };
		expect(buildDraft(input, DRAFT, keyless)).toBeNull();
		expect(buildDraft(input, DRAFT, { ...merged, mappings: new Map() })).toBeNull();
	});
});

/** mulberry32: a small seeded generator, so a failing case can be replayed. */
function random(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TYPES = [
	"string",
	"text",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"json",
	"portableText",
	"image",
	"file",
	"slug",
	"url",
	"reference",
	"repeater",
];
const NAMES = [
	"title",
	"name",
	"price",
	"cost",
	"date",
	"image",
	"photo",
	"sku",
	"id",
	"body",
	"tags",
	"status",
	"handle",
	"a..b",
	"@x",
	"item/title",
	"Название",
	"😀",
	"",
];
const VALUES = [
	"1",
	"1,234",
	"01/02/2026",
	"2026-03-01",
	"https://x.example/a.png",
	"<p>x</p>",
	"yes",
	"red",
	"",
	" ",
	"x",
];

describe("the draft invariant (spec Ruling 27)", () => {
	it("always returns a shape-valid draft or null over 200 seeded generated cases", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const r = random(seed);
			const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
			const format = pick(["csv", "json", "xml"] as const);
			const keys = [
				...new Set(Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(NAMES))),
			].filter((k) => k !== "");
			if (keys.length === 0) continue;
			const rows = Array.from({ length: Math.floor(r() * 4) }, () =>
				Object.fromEntries(keys.filter(() => r() > 0.2).map((k) => [k, pick(VALUES)])),
			);
			const schema = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => ({
				slug: `f${i}_${pick(NAMES).replace(/[^a-z]/g, "") || "x"}`,
				label: pick(NAMES),
				type: pick(TYPES),
				required: r() > 0.7,
				validation: { options: ["red", "blue"] },
			}));
			const { eligible } = eligibleFields(schema);
			const s = sample(rows, keys, format);
			const reply = {
				key: r() > 0.5 ? pick(keys) : null,
				slug: r() > 0.5 ? pick([...keys, "nope"]) : null,
				fields: eligible.map((f) =>
					item(r() > 0.2 ? f.slug : "ghost", r() > 0.2 ? pick([...keys, "nope"]) : null, {
						dateFormat: r() > 0.7 ? pick(["dd/MM/yyyy", "qqqq", "unix"]) : null,
						decimalComma: r() > 0.7 ? true : null,
						portableTextFormat: r() > 0.7 ? pick(["html", "markdown", "text"]) : null,
					}),
				),
			};
			const input = setup(eligible, s, r() > 0.3 ? reply : undefined);
			const { merged, template } = mergeAndDraft(input, { ...DRAFT, source: { format } });
			if (template !== null) expect(shapeChecked(template), `seed ${seed}`).not.toBeNull();
			expect(
				merged.fields.map((f) => f.field),
				`seed ${seed}`,
			).toEqual(eligible.map((f) => f.slug));
			const used = merged.fields.map((f) => f.from).filter((k) => k !== null);
			expect(new Set(used).size, `seed ${seed}: a key maps two fields`).toBe(used.length);
			for (const k of used) expect(keys, `seed ${seed}`).toContain(k);
		}
	});
});
