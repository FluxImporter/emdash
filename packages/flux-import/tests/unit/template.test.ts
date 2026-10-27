import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	type CompileContext,
	type CompiledTemplate,
	checkTemplate,
	compileTemplate,
	filterRecord,
	missingPathWarnings,
	slugify,
	type Template,
	templatePaths,
	templateSchema,
	unresolvedPaths,
} from "../../src/engine/template.js";

const template: Template = templateSchema.parse({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number" },
		released: { from: "Date", type: "date", format: "dd/MM/yyyy", tz: "Europe/Chisinau" },
	},
});

const row = {
	sku: " A1 ",
	handle: "Ștefan cel Mare!",
	Name: " Desk ",
	Price: "12.50",
	Date: "01/03/2026",
};

describe("templateSchema", () => {
	it("defaults the source to CSV and accepts the other formats", () => {
		expect(template.source).toEqual({ format: "csv" });
		const base = { version: 1, collection: "p", locale: "en", key: { from: "sku" } };
		const fields = { title: { from: "name", type: "text" } };
		for (const source of [
			{ format: "json" },
			{ format: "json", records: "data.products" },
			{ format: "jsonl" },
			{ format: "xml", records: "feed/item" },
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		for (const source of [
			{ format: "xlsx" },
			{ format: "xlsx", sheet: "Prices 2026", headerRow: 3 },
			{ format: "xlsx", sheet: 2, headerRow: 1_048_576 },
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		for (const source of [
			{ format: "xlsx", sheet: "" },
			{ format: "xlsx", sheet: "x".repeat(101) },
			{ format: "xlsx", sheet: 0 },
			{ format: "xlsx", sheet: 1.5 },
			{ format: "xlsx", headerRow: 0 },
			{ format: "xlsx", headerRow: 1_048_577 },
			{ format: "xlsx", headerRow: "1" },
		]) {
			expect(templateSchema.safeParse({ ...base, source, fields }).success).toBe(false);
		}
		expect(templateSchema.safeParse({ ...base, source: { format: "yaml" }, fields }).success).toBe(
			false,
		);
		expect(
			templateSchema.safeParse({ ...base, source: { format: "json", extra: 1 }, fields }).success,
		).toBe(false);
	});
	it("defaults tz to UTC", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { released: { from: "Date", type: "date" } },
		});
		expect(t.fields.released).toMatchObject({ tz: "UTC" });
	});

	it.each([
		["unknown version", { version: 2 }],
		["reserved target field", { fields: { flux_source_id: { from: "sku", type: "text" } } }],
		["bad field slug", { fields: { "Bad-Name": { from: "x", type: "text" } } }],
		["unknown timezone", { fields: { d: { from: "x", type: "date", tz: "Mars/Olympus" } } }],
		["no fields", { fields: {} }],
		["unknown property", { extra: true }],
	])("rejects %s", (_name, patch) => {
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
		};
		expect(templateSchema.safeParse({ ...base, ...patch }).success).toBe(false);
	});
});

/** Compiles the template, as each batch does, and applies it to one record value. */
async function apply(t: Template, value: unknown) {
	const compiled = compileTemplate(t);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return applyTemplate(compiled.compiled, value);
}

describe("applyTemplate", () => {
	it("converts a row", async () => {
		expect(await apply(template, row)).toEqual({
			ok: true,
			value: {
				key: "A1",
				slug: "stefan-cel-mare",
				data: { title: " Desk ", price: 12.5, released: "2026-02-28T22:00:00.000Z" },
			},
		});
	});

	it("turns empty cells into null", async () => {
		const result = await apply(template, { ...row, Name: "", Price: "  ", Date: "" });
		expect(result.ok && result.value.data).toEqual({ title: null, price: null, released: null });
	});

	it.each(["1,234", "0x10", "Infinity", "12abc", "1.2.3", "1e999", "-1e999"])(
		"rejects number %s",
		async (Price) => {
			const result = await apply(template, { ...row, Price });
			expect(result).toMatchObject({
				ok: false,
				errors: [{ field: "price", code: "invalid_number" }],
			});
		},
	);

	it.each(["2026-03-01", "31/02/2026", "soon"])(
		"rejects date %s for format dd/MM/yyyy",
		async (dateStr) => {
			const result = await apply(template, { ...row, Date: dateStr });
			expect(result).toMatchObject({
				ok: false,
				errors: [{ field: "released", code: "invalid_date" }],
			});
		},
	);

	it("parses ISO dates when no format is given", async () => {
		const t = templateSchema.parse({
			...template,
			fields: { released: { from: "Date", type: "date" } },
		});
		const result = await apply(t, { ...row, Date: "2026-03-01T10:00:00+02:00" });
		expect(result.ok && result.value.data.released).toBe("2026-03-01T08:00:00.000Z");
	});

	it("collects every error, including a missing key and an empty slug", async () => {
		const result = await apply(template, { ...row, sku: "  ", handle: "!!!", Price: "x" });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.errors.map((e) => e.code).sort()).toEqual([
			"empty_slug",
			"invalid_number",
			"missing_key",
		]);
	});

	it("rejects keys longer than 256 characters", async () => {
		const result = await apply(template, { ...row, sku: "k".repeat(257) });
		expect(result).toMatchObject({ ok: false, errors: [{ code: "key_too_long" }] });
	});

	it("treats a missing column as an empty cell", async () => {
		const { Name: _omit, ...rest } = row;
		const result = await apply(template, rest);
		expect(result.ok && result.value.data.title).toBeNull();
	});

	it("omits slug when the template does not map it", async () => {
		const { slug: _s, ...noSlug } = template;
		const result = await apply(noSlug as Template, row);
		expect(result.ok && "slug" in result.value).toBe(false);
	});
});

describe("slugify", () => {
	it.each([
		["Ștefan cel Mare!", "stefan-cel-mare"],
		["  Hello   World  ", "hello-world"],
		["日本", ""],
		["a".repeat(300), "a".repeat(200)],
	])("%s", (input, expected) => {
		expect(slugify(input)).toBe(expected);
	});
});

describe("checkTemplate", () => {
	const fields = [
		{ slug: "title", type: "string" },
		{ slug: "price", type: "number" },
		{ slug: "released", type: "datetime" },
	];
	const headers = ["sku", "handle", "Name", "Price", "Date"];

	it("accepts a compatible template", () => {
		expect(checkTemplate(template, fields, headers)).toEqual([]);
	});

	it("reports unknown fields, incompatible types and missing columns", () => {
		const errors = checkTemplate(
			template,
			[
				{ slug: "title", type: "number" },
				{ slug: "released", type: "datetime" },
			],
			["sku", "Name", "Price", "Date"],
		);
		expect(errors).toEqual([
			'Column "handle" not found in the source',
			'Field "title" has type "number"; a text mapping needs one of string, text, url, slug',
			'Field "price" does not exist in collection "products"',
		]);
	});

	it("checks XLSX columns against the header, and lets a template read _row", () => {
		const xlsx = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xlsx" },
			key: { from: "_row" },
			fields: {
				title: { from: "Product name", type: "text" },
				price: { from: "Unit Price", type: "number" },
			},
		});
		expect(checkTemplate(xlsx, fields, ["Product name", "Unit Price"])).toEqual([]);
		expect(checkTemplate(xlsx, fields, ["Product name"])).toEqual([
			'Column "Unit Price" not found in the source',
		]);
	});
});

const jsonT = templateSchema.parse({
	version: 1,
	collection: "products",
	locale: "en",
	source: { format: "json" },
	key: { from: "sku" },
	slug: { from: "name" },
	fields: {
		title: { from: "name", type: "text" },
		price: { from: "price.amount", type: "number" },
		released: { from: "released", type: "date" },
	},
});

describe("applyTemplate with typed values", () => {
	it("takes JSON numbers as numbers and turns numbers and booleans into text", async () => {
		const result = await apply(jsonT, {
			sku: 1001,
			name: true,
			price: { amount: 12.5 },
			released: "2026-03-01",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "1001",
				slug: "true",
				data: { title: "true", price: 12.5, released: "2026-03-01T00:00:00.000Z" },
			},
		});
	});

	it("reads numeric strings, null and missing paths as before", async () => {
		const result = await apply(jsonT, { sku: "A1", name: "Desk", price: { amount: "7" } });
		expect(result.ok && result.value.data).toEqual({ title: "Desk", price: 7, released: null });
		const nulls = await apply(jsonT, { sku: "A1", name: "Desk", price: null, released: null });
		expect(nulls.ok && nulls.value.data).toEqual({ title: "Desk", price: null, released: null });
	});

	it("fails not_scalar for an object or array where a single value is expected", async () => {
		const result = await apply(jsonT, {
			sku: ["A1"],
			name: { first: "D" },
			price: { amount: [1] },
			released: { at: "x" },
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["sku", "not_scalar"],
			["slug", "not_scalar"],
			["title", "not_scalar"],
			["price", "not_scalar"],
			["released", "not_scalar"],
		]);
	});

	it("rejects booleans and non-finite numbers in number fields", async () => {
		const t = await apply(jsonT, { sku: "A", name: "n", price: { amount: false } });
		expect(t).toMatchObject({ ok: false, errors: [{ field: "price", code: "invalid_number" }] });
	});

	it("fails a non-object record with missing_key", async () => {
		const result = await apply(jsonT, "just a string");
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["missing_key", "empty_slug"]);
	});

	it("reads XML text elements and attributes", async () => {
		const xmlT = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xml", records: "feed/item" },
			key: { from: "@sku" },
			fields: {
				title: { from: "title", type: "text" },
				lang: { from: "title/@lang", type: "text" },
				price: { from: "price", type: "number" },
			},
		});
		const result = await apply(xmlT, {
			"@sku": "A1",
			title: { "@lang": "ro", "#text": "Masă" },
			price: "12.50",
		});
		expect(result).toEqual({
			ok: true,
			value: { key: "A1", data: { title: "Masă", lang: "ro", price: 12.5 } },
		});
	});
});

describe("checkTemplate for structured sources", () => {
	const fields = [
		{ slug: "title", type: "string" },
		{ slug: "price", type: "number" },
		{ slug: "released", type: "datetime" },
	];

	it("checks path syntax instead of columns", () => {
		expect(checkTemplate(jsonT, fields, null)).toEqual([]);
		const bad = templateSchema.parse({
			...jsonT,
			fields: { title: { from: "name..first", type: "text" } },
		});
		expect(checkTemplate(bad, fields, null)).toEqual(['"name..first" has an empty key']);
	});
});

describe("missingPathWarnings", () => {
	it("warns about each path no sampled record has", () => {
		const sample = [{ sku: "A1", name: "Desk", price: null }, { sku: "B2" }];
		let unresolved = templatePaths(jsonT);
		for (const value of sample) unresolved = unresolvedPaths(jsonT, unresolved, value);
		expect(missingPathWarnings(unresolved, sample.length)).toEqual([
			'Path "price.amount" was not found in the first 2 records',
			'Path "released" was not found in the first 2 records',
		]);
	});

	it("gives no warnings when no record was checked", () => {
		expect(missingPathWarnings(templatePaths(jsonT), 0)).toEqual([]);
	});
});

const RUNAWAY = "($f := function($n) { $f($n + 1) }; $f(0))";

/** A JSON template with the given source filter, key, slug and fields; compiled. */
function compiledJson(parts: {
	filter?: string;
	key?: object;
	slug?: object;
	fields?: object;
}): CompiledTemplate {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		source: { format: "json", ...(parts.filter === undefined ? {} : { filter: parts.filter }) },
		key: parts.key ?? { from: "sku" },
		...(parts.slug === undefined ? {} : { slug: parts.slug }),
		fields: parts.fields ?? { title: { from: "name", type: "text" } },
	});
	const compiled = compileTemplate(t);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return compiled.compiled;
}

describe("templateSchema with expressions", () => {
	const base = {
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: { title: { from: "name", type: "text" } },
	};
	const issues = (patch: object) => {
		const result = templateSchema.safeParse({ ...base, ...patch });
		return result.success ? [] : result.error.issues.map((i) => [i.path.join("."), i.message]);
	};
	const ONE = 'Set exactly one of "from" and "expr"';

	it("takes exactly one of from and expr for the key, the slug and each field", () => {
		expect(issues({ key: { expr: "sku" } })).toEqual([]);
		expect(issues({ slug: { expr: "$lowercase(name)" } })).toEqual([]);
		expect(issues({ fields: { title: { expr: "first & last", type: "text" } } })).toEqual([]);
		expect(issues({ key: { from: "sku", expr: "sku" } })).toEqual([["key", ONE]]);
		expect(issues({ key: {} })).toEqual([["key", ONE]]);
		expect(issues({ slug: { from: "a", expr: "a" } })).toEqual([["slug", ONE]]);
		expect(issues({ fields: { title: { type: "text" } } })).toEqual([["fields.title", ONE]]);
		expect(issues({ fields: { title: { from: "a", expr: "a", type: "number" } } })).toEqual([
			["fields.title", ONE],
		]);
		expect(issues({ key: { expr: "" } })).toMatchObject([["key.expr", expect.any(String)]]);
	});

	it("keeps format and tz on a date field with an expression", () => {
		const t = templateSchema.parse({
			...base,
			fields: {
				released: { expr: "date", type: "date", format: "dd/MM/yyyy", tz: "Europe/Chisinau" },
			},
		});
		expect(t.fields.released).toEqual({
			expr: "date",
			type: "date",
			format: "dd/MM/yyyy",
			tz: "Europe/Chisinau",
		});
	});

	it("accepts a filter for every format", () => {
		for (const source of [
			{ format: "csv", filter: "Price != ''" },
			{ format: "json", filter: "price > 0" },
			{ format: "jsonl", filter: "price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != 'X'" },
		]) {
			expect(templateSchema.parse({ ...base, source }).source).toEqual(source);
		}
		expect(issues({ source: { format: "json", filter: "" } })).toMatchObject([
			["source.filter", expect.any(String)],
		]);
	});
});

describe("compileTemplate", () => {
	it("compiles nothing for a template without expressions", () => {
		const result = compileTemplate(template);
		expect(result.ok).toBe(true);
		expect(result.ok && result.compiled).toMatchObject({ filter: null, key: null, slug: null });
		expect(result.ok && result.compiled.fields.size).toBe(0);
	});

	it("names every bad expression by its place in the template", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "json", filter: "price >" },
			key: { expr: "$random()" },
			slug: { expr: `'${"a".repeat(5000)}'` },
			fields: {
				title: { expr: "name", type: "text" },
				price: { expr: "$number(", type: "number" },
			},
		});
		const result = compileTemplate(t);
		expect(result).toEqual({
			ok: false,
			problems: [
				"source.filter: JSONata S0207 at character 7: Unexpected end of expression",
				"key.expr: $random cannot be used: expressions must give the same result on every run",
				"slug.expr: The expression is 5002 bytes; expressions are limited to 4096",
				expect.stringMatching(/^fields\.price\.expr: JSONata S0203 at character \d+: /),
			],
		});
	});
});

describe("filterRecord", () => {
	it.each([
		["true", "price > 0", { keep: true }],
		["false", "price > 100", { keep: false }],
		["an empty sequence", "tags[$ = 'none']", { keep: false }],
		["undefined (a missing path)", "missing", { keep: false }],
	])("handles %s", async (_name, filter, expected) => {
		const record = { sku: "A", price: 5, tags: ["a", "b"] };
		expect(await filterRecord(compiledJson({ filter }), record)).toEqual(expected);
	});

	it("keeps every record when the template has no filter", async () => {
		expect(await filterRecord(compiledJson({}), { sku: "A" })).toEqual({ keep: true });
	});

	it.each([
		["a string", "'yes'"],
		["a number", "1"],
		["an object", "{ 'a': 1 }"],
		["an array", "tags"],
		["null", "null"],
	])("fails a filter that gives %s with filter_not_boolean", async (kind, filter) => {
		const result = await filterRecord(compiledJson({ filter }), { tags: ["a", "b"] });
		expect(result).toEqual({
			error: {
				field: "filter",
				code: "filter_not_boolean",
				message: `The filter must give true or false; it gave ${kind}`,
			},
		});
	});

	it("fails a filter that throws with filter_error, and a runaway one with expr_limit", async () => {
		expect(await filterRecord(compiledJson({ filter: "price > 0" }), { price: "5" })).toEqual({
			error: {
				field: "filter",
				code: "filter_error",
				message: expect.stringMatching(/^JSONata T2009 at character 7: /),
			},
		});
		expect(await filterRecord(compiledJson({ filter: RUNAWAY }), {})).toEqual({
			error: {
				field: "filter",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		});
	});
});

describe("applyTemplate with expressions", () => {
	it("computes the key, the slug and fields, and mixes them with paths", async () => {
		const c = compiledJson({
			key: { expr: "$uppercase(sku)" },
			slug: { expr: "first & ' ' & last" },
			fields: {
				title: { expr: "first & ' ' & last", type: "text" },
				price: { expr: "$round(price.amount * 1.2, 2)", type: "number" },
				sku: { from: "sku", type: "text" },
			},
		});
		const result = await applyTemplate(c, {
			sku: "a1",
			first: "Ada",
			last: "Lovelace",
			price: { amount: 10.555 },
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				slug: "ada-lovelace",
				data: { title: "Ada Lovelace", price: 12.67, sku: "a1" },
			},
		});
	});

	it("converts expression results like path values", async () => {
		const c = compiledJson({
			fields: {
				text: { expr: "price * 2", type: "text" },
				count: { expr: "$string(price)", type: "number" },
				released: {
					expr: "$substring(stamp, 0, 10)",
					type: "date",
					format: "dd/MM/yyyy",
					tz: "Europe/Chisinau",
				},
				nothing: { expr: "missing", type: "text" },
			},
		});
		const result = await applyTemplate(c, { sku: "A", price: 6.25, stamp: "01/03/2026 10:00" });
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A",
				data: {
					text: "12.5",
					count: 6.25,
					released: "2026-02-28T22:00:00.000Z",
					nothing: null,
				},
			},
		});
	});

	it("fails objects and arrays from expressions with not_scalar, and undefined keys as missing", async () => {
		const c = compiledJson({
			key: { expr: "missing" },
			fields: {
				obj: { expr: "{ 'a': name }", type: "text" },
				list: { expr: "tags", type: "text" },
			},
		});
		const result = await applyTemplate(c, { name: "n", tags: ["a", "b"] });
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["key", "missing_key"],
			["obj", "not_scalar"],
			["list", "not_scalar"],
		]);
	});

	it("collects expr_error and expr_limit for the key, the slug and each field", async () => {
		const c = compiledJson({
			key: { expr: "sku + 1" },
			slug: { expr: "$substring(1)" },
			fields: {
				title: { expr: RUNAWAY, type: "text" },
				price: { expr: "price", type: "number" },
				ok: { from: "sku", type: "text" },
			},
		});
		const result = await applyTemplate(c, { sku: "A", price: "n/a" });
		expect(!result.ok && result.errors).toEqual([
			{ field: "key", code: "expr_error", message: expect.stringMatching(/^JSONata T2001 /) },
			{ field: "slug", code: "expr_error", message: expect.stringMatching(/^JSONata T0411 /) },
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
			{ field: "price", code: "invalid_number", message: '"n/a" is not a number' },
		]);
	});

	it("reports the sequence and depth limits as expr_limit too", async () => {
		const deep = "($f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(1000))";
		const c = compiledJson({
			fields: {
				big: { expr: "$count([1..200000])", type: "number" },
				deep: { expr: deep, type: "number" },
			},
		});
		const result = await applyTemplate(c, { sku: "A" });
		expect(!result.ok && result.errors).toEqual([
			{ field: "big", code: "expr_limit", message: expect.stringMatching(/^JSONata D2015 /) },
			{ field: "deep", code: "expr_limit", message: expect.stringMatching(/^JSONata D1011 /) },
		]);
		expect(
			await filterRecord(compiledJson({ filter: "$count([1..200000]) > 0" }), { sku: "A" }),
		).toEqual({
			error: {
				field: "filter",
				code: "expr_limit",
				message: expect.stringMatching(/^JSONata D2015 /),
			},
		});
	});

	it("does not list expression paths as template paths", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "json" },
			key: { expr: "sku" },
			slug: { from: "handle" },
			fields: { title: { expr: "name", type: "text" }, price: { from: "price", type: "number" } },
		});
		expect(templatePaths(t)).toEqual(["handle", "price"]);
	});
});

/** The products template from the M4a spec: every new mapping type and option. */
const typed = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number", decimal: ",", thousands: "." },
		stock: { from: "Stock", type: "number" },
		featured: { from: "Featured", type: "boolean", true: ["ja"], false: ["nein"] },
		status: { from: "Status", type: "select", map: { Live: "published" } },
		colours: { from: "Colours", type: "multiSelect", separator: "|" },
		released: { from: "Date", type: "date", format: "dd/MM/yyyy HH:mm", tz: "site" },
		sold_on: { from: "SoldAt", type: "date", format: "unix" },
		launch_day: { from: "Launch", type: "date", output: "yyyy-MM-dd" },
		specs: { from: "Specs", type: "json" },
		legacy_slug: { from: "Handle", type: "slug" },
	},
};

const targets: CompileContext["targets"] = {
	title: { type: "string", required: true, maxLength: 20 },
	price: { type: "number", required: false, min: 0 },
	stock: { type: "integer", required: false },
	featured: { type: "boolean", required: false },
	status: { type: "select", required: false, options: ["draft", "published"] },
	colours: { type: "multiSelect", required: false, options: ["red", "green", "blue"] },
	released: { type: "datetime", required: false },
	sold_on: { type: "datetime", required: false },
	launch_day: { type: "string", required: false, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
	specs: { type: "json", required: false },
	legacy_slug: { type: "slug", required: false },
};

const typedRow = {
	sku: "A1",
	Name: "Desk",
	Price: "1.234,50",
	Stock: "12",
	Featured: "JA",
	Status: "live",
	Colours: "Red | blue",
	Date: "24/01/2025 14:00",
	SoldAt: "1737720000",
	Launch: "2025-01-24T23:30:00Z",
	Specs: '{"w": 120, "tags": ["oak"]}',
	Handle: "Old Desk №1",
};

/** Compiles `typed` with the target snapshot (Europe/Chisinau as the site timezone). */
function typedCompiled(
	patch: object = {},
	context: CompileContext = { targets, siteTimezone: "Europe/Chisinau" },
) {
	const compiled = compileTemplate(templateSchema.parse({ ...typed, ...patch }), context);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return compiled.compiled;
}

describe("templateSchema for M4a field types", () => {
	const issues = (fields: object) => {
		const result = templateSchema.safeParse({ ...typed, fields });
		return result.success ? [] : result.error.issues.map((i) => i.message);
	};

	it("accepts every type with its options, keeping them as written", () => {
		const t = templateSchema.parse(typed);
		expect(t.fields.price).toEqual({ from: "Price", type: "number", decimal: ",", thousands: "." });
		expect(t.fields.released).toMatchObject({ tz: "site" });
		expect(t.fields.launch_day).toEqual({
			from: "Launch",
			type: "date",
			output: "yyyy-MM-dd",
			tz: "UTC",
		});
		expect(t.fields.status).toEqual({ from: "Status", type: "select", map: { Live: "published" } });
		expect(
			issues({
				a: { expr: "x", type: "multiSelect", map: { x: "y" }, ignoreCase: false, separator: ";" },
				b: { from: "b", type: "json", parse: false },
				c: { from: "c", type: "boolean" },
				d: { from: "d", type: "number", decimal: ",", thousands: " " },
			}),
		).toEqual([]);
	});

	it.each([
		["an option of another type", { a: { from: "a", type: "text", decimal: "," } }],
		["slug options", { a: { from: "a", type: "slug", parse: true } }],
		["thousands equal to decimal", { a: { from: "a", type: "number", thousands: "." } }],
		[
			"thousands equal to a comma decimal",
			{ a: { from: "a", type: "number", decimal: ",", thousands: "," } },
		],
		["an unknown decimal", { a: { from: "a", type: "number", decimal: ";" } }],
		["a token in both lists", { a: { from: "a", type: "boolean", true: ["Ja"], false: [" ja "] } }],
		["a token in a default list", { a: { from: "a", type: "boolean", true: ["no"] } }],
		["a blank token", { a: { from: "a", type: "boolean", true: [" "] } }],
		["an empty token list", { a: { from: "a", type: "boolean", false: [] } }],
		[
			"51 tokens",
			{ a: { from: "a", type: "boolean", true: Array.from({ length: 51 }, (_, i) => `t${i}`) } },
		],
		["a token over 100 characters", { a: { from: "a", type: "boolean", true: ["t".repeat(101)] } }],
		["an empty map value", { a: { from: "a", type: "select", map: { x: "" } } }],
		[
			"a map key over 200 characters",
			{ a: { from: "a", type: "select", map: { ["k".repeat(201)]: "v" } } },
		],
		[
			"a map of 1,001 entries",
			{
				a: {
					from: "a",
					type: "multiSelect",
					map: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, "v"])),
				},
			},
		],
		["a non-boolean ignoreCase", { a: { from: "a", type: "select", ignoreCase: "yes" } }],
		[
			"a separator over 10 characters",
			{ a: { from: "a", type: "multiSelect", separator: "x".repeat(11) } },
		],
		["an empty output", { a: { from: "a", type: "date", output: "" } }],
		["an output over 100 characters", { a: { from: "a", type: "date", output: "y".repeat(101) } }],
		["an unknown timezone", { a: { from: "a", type: "date", tz: "Site" } }],
		["an unknown type", { a: { from: "a", type: "portableText" } }],
	])("refuses %s", (_name, fields) => {
		expect(issues(fields)).not.toEqual([]);
	});

	it("names the shared boolean token and the separator clash", () => {
		expect(issues({ a: { from: "a", type: "boolean", true: ["Ja"], false: ["JA"] } })).toEqual([
			'"ja" is both a true and a false token',
		]);
		expect(issues({ a: { from: "a", type: "number", thousands: "." } })).toEqual([
			"thousands must differ from decimal",
		]);
	});
});

describe("applyTemplate with M4a field types", () => {
	it("converts every type against the target snapshot", async () => {
		const result = await applyTemplate(typedCompiled(), typedRow);
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: {
					title: "Desk",
					price: 1234.5,
					stock: 12,
					featured: true,
					status: "published",
					colours: ["red", "blue"],
					released: "2025-01-24T12:00:00.000Z",
					sold_on: "2025-01-24T12:00:00.000Z",
					launch_day: "2025-01-24",
					specs: { w: 120, tags: ["oak"] },
					legacy_slug: "old-desk-no1",
				},
			},
		});
	});

	it("takes typed JSON values", async () => {
		const result = await applyTemplate(typedCompiled(), {
			...typedRow,
			Price: 9.5,
			Stock: 3,
			Featured: false,
			Colours: ["GREEN", "green"],
			SoldAt: 1737720000,
			Specs: [1, 2],
		});
		expect(result.ok && result.value.data).toMatchObject({
			price: 9.5,
			stock: 3,
			featured: false,
			colours: ["green"],
			sold_on: "2025-01-24T12:00:00.000Z",
			specs: [1, 2],
		});
	});

	it("reads tz: site in the job's site timezone, and UTC without one", async () => {
		const plain = typedCompiled({}, { targets });
		const result = await applyTemplate(plain, typedRow);
		expect(result.ok && result.value.data.released).toBe("2025-01-24T14:00:00.000Z");
	});

	it("collects conversion and rule errors from every field", async () => {
		const result = await applyTemplate(typedCompiled(), {
			...typedRow,
			Name: "",
			Price: "-1",
			Stock: "2,5",
			Featured: "maybe",
			Status: "gone",
			Colours: "red|pink",
			Date: "29/03/2026 03:30",
			Launch: "2025-01-24",
			Specs: "{",
			Handle: "!!!",
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["title", "required"],
			["price", "out_of_range"],
			["stock", "invalid_number"],
			["featured", "invalid_boolean"],
			["status", "invalid_option"],
			["colours", "invalid_option"],
			["released", "invalid_date"],
			["specs", "invalid_json"],
			["legacy_slug", "empty_slug"],
		]);
		const integer = await applyTemplate(typedCompiled(), { ...typedRow, Stock: "2.5" });
		expect(!integer.ok && integer.errors).toEqual([
			{ field: "stock", code: "invalid_integer", message: "2.5 is not a whole number" },
		]);
		const long = await applyTemplate(typedCompiled(), { ...typedRow, Name: "x".repeat(21) });
		expect(!long.ok && long.errors.map((e) => e.code)).toEqual(["too_long"]);
	});

	it("checks the rules on expression results too", async () => {
		const c = typedCompiled({
			fields: { ...typed.fields, stock: { expr: "$number(Stock) / 5", type: "number" } },
		});
		const result = await applyTemplate(c, typedRow);
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["stock", "invalid_integer"],
		]);
		const rounded = typedCompiled({
			fields: { ...typed.fields, stock: { expr: "$round($number(Stock) / 5)", type: "number" } },
		});
		expect(await applyTemplate(rounded, typedRow)).toMatchObject({
			ok: true,
			value: { data: { stock: 2 } },
		});
	});

	it("keeps M2 behaviour for jobs without a target snapshot", async () => {
		const m2 = typedCompiled({}, {});
		const result = await applyTemplate(m2, {
			...typedRow,
			Name: "",
			Stock: "2.5",
			Status: "anything",
		});
		expect(result.ok && result.value.data).toMatchObject({
			title: null,
			stock: 2.5,
			status: "anything",
			launch_day: "2025-01-24T23:30:00.000Z",
		});
	});
});
