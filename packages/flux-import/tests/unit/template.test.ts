import { describe, expect, it } from "vitest";
import {
	applyTemplate,
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
			'Field "title" has type "number"; a text mapping needs one of string, text, url',
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
