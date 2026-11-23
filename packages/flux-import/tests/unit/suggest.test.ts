import { describe, expect, it } from "vitest";
import {
	bestDate,
	bestNumber,
	canon,
	createMapper,
	eligibleFields,
	joined,
	nameScore,
	norm,
	type Sample,
	type SuggestField,
	SYNONYMS,
	suggestByName,
} from "../../src/engine/suggest.js";
import type { SourceFormat } from "../../src/sources/reader.js";

const field = (slug: string, extra: Partial<SuggestField> = {}): SuggestField => ({
	slug,
	label: slug,
	type: "string",
	required: false,
	...extra,
});

/** A sample from rows of plain objects; a missing property is a missing value. */
function sample(
	rows: Record<string, unknown>[],
	keys?: string[],
	format: SourceFormat = "csv",
): Sample {
	const all = keys ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
	return { format, keys: all, rows: rows.map((r) => new Map(Object.entries(r))) };
}

const only = (keys: string[]) => sample([], keys);

describe("norm (spec step 1, Ruling 58)", () => {
	it.each([
		["productName", "csv", ["product", "name"]],
		["Product_Name", "csv", ["product", "name"]],
		["PRODUCT-NAME", "csv", ["product", "name"]],
		["SKUCode", "csv", ["sku", "code"]],
		["Prix TTC", "csv", ["prix", "ttc"]],
		["Désignation", "csv", ["designation"]],
		["item/title", "xml", ["title"]],
		["item/@id", "xml", ["id"]],
		["item/title/#text", "xml", ["title"]],
		["a.b.c", "json", ["c"]],
		["a.b.c", "jsonl", ["c"]],
		["Categories", "csv", ["category"]],
		["address", "csv", ["address"]],
		["", "csv", []],
		["Название", "csv", ["название"]],
		["Straße", "csv", ["straße"]],
		["😀🎉", "csv", []],
		["-- !! --", "csv", []],
		["Großes", "csv", ["großes"]],
	] as const)("%s (%s) gives %j", (name, format, tokens) => {
		expect(norm(name, format).tokens).toEqual(tokens);
	});

	it("keeps the whole path's tokens for the overlap score, without a trailing #text", () => {
		expect(norm("item/title/#text", "xml").pathTokens).toEqual(["item", "title"]);
		expect(norm("product.price_net", "json").pathTokens).toEqual(["product", "price", "net"]);
	});

	it("gives the same tokens on every run", () => {
		expect(norm("Straße")).toEqual(norm("Straße"));
	});
});

describe("synonyms (spec step 2, Ruling 70)", () => {
	it("maps every member, passed through norm(), to its group's canonical", () => {
		for (const [canonical, members] of SYNONYMS) {
			const group = joined(norm(canonical).tokens);
			for (const member of members) expect(canon(joined(norm(member).tokens)), member).toBe(group);
		}
		// The stemmer's own output: `status` is looked up as `statu`.
		expect(canon("state")).toBe("statu");
	});

	it("leaves a non-member as it is", () => {
		expect(canon("widget")).toBe("widget");
		expect(canon("colour")).toBe("colour");
	});
});

describe("nameScore (spec step 3)", () => {
	const title = field("title", { label: "Title" });

	it("scores exact names 1.0, synonyms 0.8, and overlap 0.6 × J from J = 0.5", () => {
		expect(nameScore(norm("Title"), title)).toEqual({
			score: 1,
			rationale: "Same name as the field",
		});
		expect(nameScore(norm("Name"), title)).toEqual({
			score: 0.8,
			rationale: "A usual name for this field",
		});
		const weight = field("shipping_weight", { label: "Shipping weight" });
		expect(nameScore(norm("weight_shipping_kg"), weight)).toEqual({
			score: 0.6 * (2 / 3),
			rationale: "Shares words with the field name",
		});
		expect(nameScore(norm("shipping_kg"), weight)).toBeNull();
	});

	it("matches a label as well as a slug (spec Ruling 21's example)", () => {
		const cost = field("cost_net", { label: "Unit cost" });
		expect(nameScore(norm("Unit cost"), cost)?.score).toBe(1);
	});

	it("matches non-Latin names exactly and never matches two empty names (Ruling 58)", () => {
		const name = field("nazvanie", { label: "Название" });
		const price = field("tsena", { label: "Цена" });
		expect(nameScore(norm("Название"), name)?.score).toBe(1);
		expect(nameScore(norm("Название"), price)).toBeNull();
		expect(nameScore(norm("😀"), field("emoji", { label: "🎉" }))).toBeNull();
		expect(nameScore(norm("😀"), field("x", { label: "😀" }))).toBeNull();
	});

	it("never scores a key whose own name is empty, even when its path shares words", () => {
		expect(norm("product.😀", "json").pathTokens).toEqual(["product"]);
		expect(nameScore(norm("product.😀", "json"), field("product"))).toBeNull();
	});

	it("scores an overlap of exactly one half (J = 0.5 is enough)", () => {
		expect(nameScore(norm("weight"), field("shipping_weight"))).toEqual({
			score: 0.3,
			rationale: "Shares words with the field name",
		});
	});
});

describe("type checks and option inference (spec step 4, Rulings 57, 63, 68)", () => {
	it.each([
		[["1,234.56", "12.5"], { thousands: "," }, false],
		[["1.234,56", "7,5"], { decimal: ",", thousands: "." }, false],
		[["12,5"], { decimal: "," }, false],
		[["1,234", "5,678"], { thousands: "," }, true],
		[["1 234,5"], { decimal: ",", thousands: " " }, false],
		[["42", "-3.5e2", 7], {}, false],
	])("reads %j with %j (ambiguous: %s)", (values, option, ambiguous) => {
		expect(bestNumber(values)).toEqual({ option, failures: 0, ambiguous });
	});

	it("takes the candidate that parses the most values when none parses all", () => {
		expect(bestNumber(["1,5", "2,5", "abc"])).toEqual({
			option: { decimal: "," },
			failures: 1,
			ambiguous: false,
		});
	});

	it.each([
		[["2026-03-01", "2026-03-02T10:00:00Z"], undefined, false],
		[["1700000000", 1700000001], "unix", false],
		[["1700000000000"], "unixMs", false],
		[["2026-03-01 10:00:00"], "yyyy-MM-dd HH:mm:ss", false],
		[["13/03/2026", "01/03/2026"], "dd/MM/yyyy", false],
		[["03/13/2026"], "MM/dd/yyyy", false],
		[["01.03.2026"], "dd.MM.yyyy", false],
		[["01-03-2026"], "dd-MM-yyyy", false],
		[["5 Mar 2026"], "d MMM yyyy", false],
		[["Mar 5, 2026"], "MMM d, yyyy", false],
		[["01/02/2026"], undefined, true],
	])("dates %j read as %s (ambiguous: %s)", (values, option, ambiguous) => {
		expect(bestDate(values)).toEqual({ option, failures: 0, ambiguous });
	});

	it("halves the score when more than half the values fail the best candidate", () => {
		const price = field("price", { label: "Price", type: "number" });
		const s = sample([
			{ Price: "1.5" },
			{ Price: "2" },
			{ Price: "x" },
			{ Price: "y" },
			{ Price: "z" },
		]);
		const out = suggestByName([price], s);
		expect(out.fields.get("price")).toMatchObject({
			from: "Price",
			hundredths: 50,
			rationale: "Same name as the field; the sample values do not look like number",
			settled: false,
		});
	});

	it("does not penalise a key without values", () => {
		const price = field("price", { label: "Price", type: "number" });
		const out = suggestByName([price], sample([{ Price: "" }, { Price: null }], ["Price"]));
		expect(out.fields.get("price")).toMatchObject({ hundredths: 100, settled: true });
	});

	it.each([
		["boolean", ["yes", "No", "1", false], { type: "boolean" }, 0],
		["select", ["red", "Blue"], { type: "select", ignoreCase: true }, 0],
		["multiSelect", ["red, blue", ["red"]], { type: "multiSelect" }, 0],
		["image", ["https://cdn.example/a.png", "not a url"], { type: "image" }, 1],
		["portableText", ["<p>Hi</p>", "plain"], { type: "portableText", format: "html" }, 0],
		["portableText", ["plain", "text"], { type: "portableText", format: "text" }, 0],
		["json", [{ a: 1 }], { type: "json" }, 0],
	] as const)("checks %s values %j", (type, values, mapping, failures) => {
		const f = field("f", { type, options: ["red", "blue"] });
		const s = sample(values.map((v) => ({ k: v })));
		expect(createMapper(s)(f, "k")).toMatchObject({ mapping: { ...mapping, from: "k" }, failures });
	});

	it("reads Unix times only from 9-10 or 12-13 digits", () => {
		expect(bestDate(["12345"])).toMatchObject({ failures: 1 });
		expect(bestDate(["12345"]).option).not.toBe("unix");
	});

	it("refuses a multiSelect value with no part", () => {
		const f = field("f", { type: "multiSelect", options: ["red"] });
		expect(createMapper(sample([{ k: " , " }, { k: "red" }]))(f, "k")).toMatchObject({
			failures: 1,
			checked: 2,
		});
	});

	it("keeps no pair below 0.3 after halving", () => {
		const weight = field("shipping_weight", { type: "number" });
		const kept = suggestByName([weight], sample([{ weight: "1" }]));
		expect(kept.fields.get("shipping_weight")).toMatchObject({ from: "weight", hundredths: 30 });
		const dropped = suggestByName([weight], sample([{ weight: "heavy" }]));
		expect(dropped.fields.get("shipping_weight")?.from).toBeNull();
		expect(dropped.candidates).toEqual([]);
	});

	it("memoises a check per key and mapping type, and per field for select (Ruling 68)", () => {
		const s = sample([{ d: "2026-03-01" }]);
		const mapper = createMapper(s);
		const a = mapper(field("a", { type: "datetime" }), "d");
		expect(mapper(field("b", { type: "datetime" }), "d")).toBe(a);
		expect(a).toEqual(createMapper(s)(field("c", { type: "datetime" }), "d"));
		const red = mapper(field("s1", { type: "select", options: ["x"] }), "d");
		expect(mapper(field("s2", { type: "select", options: ["2026-03-01"] }), "d")).not.toBe(red);
	});
});

describe("assignment (spec step 5, Ruling 62)", () => {
	it("gives exact over synonym over overlap", () => {
		const out = suggestByName([field("title", { label: "Title" })], only(["Heading", "title"]));
		expect(out.fields.get("title")).toMatchObject({
			from: "title",
			hundredths: 100,
			settled: true,
		});
	});

	it("settles only a pick at 100 hundredths (spec Ruling 51)", () => {
		const out = suggestByName([field("title")], only(["Name"]));
		expect(out.fields.get("title")).toMatchObject({ hundredths: 80, settled: false });
	});

	it("breaks a tie by the key's first-seen position", () => {
		const out = suggestByName([field("title")], only(["Heading", "Name"]));
		expect(out.fields.get("title")).toMatchObject({ from: "Heading", hundredths: 80 });
	});

	it("gives a shared key to the required field first, then by schema order", () => {
		const fields = [field("title"), field("headline", { required: true })];
		expect(suggestByName(fields, only(["Name"])).fields.get("headline")?.from).toBe("Name");
		const both = [field("title"), field("headline")];
		expect(suggestByName(both, only(["Name"])).fields.get("title")?.from).toBe("Name");
	});

	it("compares integer hundredths, so 0.6 × 2/3 ties a halved 0.8 and key order decides", () => {
		const price = field("price", { label: "Shipping weight", type: "number" });
		const s = sample(
			[
				{ weight_shipping_kg: "1.5", Cost: "n/a" },
				{ weight_shipping_kg: "2", Cost: "free" },
			],
			["weight_shipping_kg", "Cost"],
		);
		const out = suggestByName([price], s);
		expect(out.fields.get("price")).toMatchObject({ from: "weight_shipping_kg", hundredths: 40 });
		expect(out.candidates.map((c) => [c.key, c.hundredths])).toEqual([
			["weight_shipping_kg", 40],
			["Cost", 40],
		]);
	});

	it("orders a tie across fields by schema order before key order", () => {
		const out = suggestByName([field("title"), field("summary")], only(["Teaser", "Name"]));
		expect(out.candidates.map((c) => [c.field, c.key, c.hundredths])).toEqual([
			["title", "Name", 80],
			["summary", "Teaser", 80],
		]);
	});

	it("gives each candidate its own mapping object", () => {
		const out = suggestByName([field("title"), field("headline")], only(["Name"]));
		const [a, b] = out.candidates;
		expect(a?.mapping).toEqual(b?.mapping);
		expect(a?.mapping).not.toBe(b?.mapping);
	});

	it("maps each key to one field and each field to one key, and explains an unmatched field", () => {
		const out = suggestByName([field("title"), field("subject")], only(["Name"]));
		expect(out.fields.get("title")?.from).toBe("Name");
		expect(out.fields.get("subject")).toEqual({
			from: null,
			hundredths: 0,
			rationale: "No column or path matches this field",
			settled: false,
		});
	});

	it("never offers an excluded key (spec Ruling 59)", () => {
		const out = suggestByName([field("title")], only(["Name"]), {
			excludedKeys: new Set(["Name"]),
			base: { hasSlug: true },
		});
		expect(out.fields.get("title")?.from).toBeNull();
		expect(out.key).toBeNull();
	});

	it("pins the broad members: an exact name beats them (Ruling 70)", () => {
		const labels = suggestByName([field("label"), field("tag")], only(["label"]));
		expect(labels.fields.get("label")).toMatchObject({ from: "label", hundredths: 100 });
		expect(labels.fields.get("tag")?.from).toBeNull();
		const types = suggestByName([field("type"), field("category")], only(["type"]));
		expect(types.fields.get("type")?.from).toBe("type");
		const category = suggestByName([field("category")], only(["type"]));
		expect(category.fields.get("category")).toMatchObject({ from: "type", hundredths: 80 });
	});

	it("warns about ambiguous number and date formats for the fields that got them", () => {
		const fields = [field("price", { type: "number" }), field("released", { type: "datetime" })];
		const s = sample([{ price: "1,234", released: "01/02/2026" }]);
		const out = suggestByName(fields, s);
		expect(out.fields.get("released")?.mapping).toEqual({ type: "date", from: "released" });
		expect(out.warnings).toContainEqual({ code: "number_format_ambiguous", fields: ["price"] });
		expect(out.warnings).toContainEqual({ code: "date_format_ambiguous", fields: ["released"] });
	});
});

describe("the key column and the entry slug (spec steps 6, 7, Ruling 71)", () => {
	it("prefers a usual identifier name with distinct values at 0.9", () => {
		const out = suggestByName(
			[],
			sample([
				{ Name: "a", SKU: "1" },
				{ Name: "b", SKU: "2" },
			]),
		);
		expect(out.key).toEqual({
			from: "SKU",
			hundredths: 90,
			rationale: "A usual name for a record identifier",
		});
		expect(out.warnings).toEqual([]);
	});

	it("gives 0.6 when a value is empty or missing", () => {
		const blank = suggestByName([], sample([{ id: "1" }, { id: " " }]));
		expect(blank.key).toMatchObject({ from: "id", hundredths: 60 });
		const missing = suggestByName([], sample([{ id: "1" }, {}], ["id"]));
		expect(missing.key).toMatchObject({ from: "id", hundredths: 60 });
	});

	it("needs a key unless a base template is given, and warns sample_empty only with keys", () => {
		expect(() => suggestByName([], only([]))).toThrow("suggestByName needs at least one key");
		const based = suggestByName([], only([]), { base: { hasSlug: false } });
		expect(based).toMatchObject({ key: null, slug: null, warnings: [] });
	});

	it("gives 0.6 and key_not_unique_in_sample when its values repeat or are empty", () => {
		const out = suggestByName([], sample([{ id: "1" }, { id: " 1" }]));
		expect(out.key).toMatchObject({ from: "id", hundredths: 60 });
		expect(out.warnings).toEqual([{ code: "key_not_unique_in_sample" }]);
	});

	it("reads distinct case-sensitively after trimming", () => {
		expect(suggestByName([], sample([{ id: "a" }, { id: "A" }])).key?.hundredths).toBe(90);
	});

	it("takes the first key with present, distinct values at 0.4, else the first key at 0.1", () => {
		const unique = suggestByName(
			[],
			sample([
				{ Name: "x", "Ref No": "1" },
				{ Name: "x", "Ref No": "2" },
			]),
		);
		expect(unique.key).toEqual({
			from: "Ref No",
			hundredths: 40,
			rationale: "Its sample values are all present and distinct",
		});
		expect(unique.warnings).toEqual([{ code: "key_guessed" }]);
		const none = suggestByName(
			[],
			sample([
				{ A: "x", B: "y" },
				{ A: "x", B: "y" },
			]),
		);
		expect(none.key).toEqual({
			from: "A",
			hundredths: 10,
			rationale: "The first column or path; none looks like a record identifier",
		});
	});

	it("with no record: rule 1 at 0.6 without the uniqueness warning, else rule 3", () => {
		const named = suggestByName([], only(["Name", "sku"]));
		expect(named.key).toMatchObject({ from: "sku", hundredths: 60 });
		expect(named.warnings).toEqual([{ code: "sample_empty" }]);
		const first = suggestByName([], only(["Name", "Other"]));
		expect(first.key).toMatchObject({ from: "Name", hundredths: 10 });
		expect(first.warnings).toEqual([{ code: "sample_empty" }, { code: "key_guessed" }]);
	});

	it("lets the key column also fill a field, and keeps the slug key from fields", () => {
		const fields = [field("id", { label: "ID" }), field("handle")];
		const out = suggestByName(
			fields,
			sample([
				{ id: "1", Handle: "a" },
				{ id: "2", Handle: "b" },
			]),
		);
		expect(out.key?.from).toBe("id");
		expect(out.fields.get("id")).toMatchObject({ from: "id", settled: true });
		expect(out.slug).toEqual({
			from: "Handle",
			hundredths: 80,
			rationale: "A usual name for a URL slug",
		});
		expect(out.fields.get("handle")?.from).toBeNull();
	});

	it("never takes the key column or an excluded key as the slug", () => {
		const keyed = suggestByName([], only(["Handle"]));
		expect(keyed.key?.from).toBe("Handle");
		expect(keyed.slug).toBeNull();
		const excluded = suggestByName([], only(["Handle", "slug"]), {
			excludedKeys: new Set(["Handle"]),
			base: { hasSlug: false },
		});
		expect(excluded.slug?.from).toBe("slug");
	});

	it("suggests no slug when the base template has one", () => {
		const out = suggestByName([], only(["Handle"]), { base: { hasSlug: true } });
		expect(out.slug).toBeNull();
	});
});

describe("eligibility (spec Ruling 31)", () => {
	it("leaves out flux_source_id silently and warns about references and the rest", () => {
		const { eligible, warnings } = eligibleFields([
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "flux_source_id", type: "string" },
			{ slug: "author", type: "reference" },
			{ slug: "gallery", type: "repeater" },
			{ slug: "body", type: "blocks" },
			{ slug: "legacy", type: "string", unsupported: true },
			{ slug: "colour", type: "color" },
			{ slug: "size", type: "select", validation: { options: ["S", "M"] } },
		]);
		expect(eligible).toEqual([
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "size", label: "size", type: "select", required: false, options: ["S", "M"] },
		]);
		expect(warnings).toEqual([
			{ code: "reference_not_suggested", fields: ["author"] },
			{ code: "fields_not_eligible", fields: ["gallery", "body", "legacy", "colour"] },
		]);
	});
});

describe("bounded work", () => {
	it("normalises each field's names once per call, not once per key", () => {
		let labelReads = 0;
		const fields = Array.from({ length: 50 }, (_, i): SuggestField => {
			const f = field(`alpha_${i}`);
			Object.defineProperty(f, "label", {
				get: () => {
					labelReads++;
					return `Alpha ${i}`;
				},
			});
			return f;
		});
		const keys = Array.from({ length: 80 }, (_, i) => `Beta ${i}`);
		const out = suggestByName(fields, only(keys));
		expect(out.candidates).toEqual([]);
		expect(labelReads).toBeLessThanOrEqual(fields.length);
	});
});

describe("determinism", () => {
	const fields = [field("title"), field("headline"), field("price", { type: "number" })];
	const s = sample([
		{ Name: "a", price: "1" },
		{ Name: "b", price: "2" },
	]);

	it("gives deep-equal output for the same input", () => {
		expect(suggestByName(fields, s)).toEqual(suggestByName(fields, s));
	});

	it("changes only what the tie order says when the schema order changes", () => {
		const reversed = suggestByName([...fields].reverse(), s);
		expect(reversed.fields.get("headline")?.from).toBe("Name");
		expect(reversed.fields.get("title")?.from).toBeNull();
		expect(reversed.fields.get("price")).toEqual(suggestByName(fields, s).fields.get("price"));
	});
});
