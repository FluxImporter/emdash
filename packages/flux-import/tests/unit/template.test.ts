import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	checkTemplate,
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

describe("applyTemplate", () => {
	it("converts a row", () => {
		expect(applyTemplate(template, row)).toEqual({
			ok: true,
			value: {
				key: "A1",
				slug: "stefan-cel-mare",
				data: { title: " Desk ", price: 12.5, released: "2026-02-28T22:00:00.000Z" },
			},
		});
	});

	it("turns empty cells into null", () => {
		const result = applyTemplate(template, { ...row, Name: "", Price: "  ", Date: "" });
		expect(result.ok && result.value.data).toEqual({ title: null, price: null, released: null });
	});

	it.each(["1,234", "0x10", "Infinity", "12abc", "1.2.3", "1e999", "-1e999"])(
		"rejects number %s",
		(Price) => {
			const result = applyTemplate(template, { ...row, Price });
			expect(result).toMatchObject({
				ok: false,
				errors: [{ field: "price", code: "invalid_number" }],
			});
		},
	);

	it.each(["2026-03-01", "31/02/2026", "soon"])(
		"rejects date %s for format dd/MM/yyyy",
		(dateStr) => {
			const result = applyTemplate(template, { ...row, Date: dateStr });
			expect(result).toMatchObject({
				ok: false,
				errors: [{ field: "released", code: "invalid_date" }],
			});
		},
	);

	it("parses ISO dates when no format is given", () => {
		const t = templateSchema.parse({
			...template,
			fields: { released: { from: "Date", type: "date" } },
		});
		const result = applyTemplate(t, { ...row, Date: "2026-03-01T10:00:00+02:00" });
		expect(result.ok && result.value.data.released).toBe("2026-03-01T08:00:00.000Z");
	});

	it("collects every error, including a missing key and an empty slug", () => {
		const result = applyTemplate(template, { ...row, sku: "  ", handle: "!!!", Price: "x" });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.errors.map((e) => e.code).sort()).toEqual([
			"empty_slug",
			"invalid_number",
			"missing_key",
		]);
	});

	it("rejects keys longer than 256 characters", () => {
		const result = applyTemplate(template, { ...row, sku: "k".repeat(257) });
		expect(result).toMatchObject({ ok: false, errors: [{ code: "key_too_long" }] });
	});

	it("treats a missing column as an empty cell", () => {
		const { Name: _omit, ...rest } = row;
		const result = applyTemplate(template, rest);
		expect(result.ok && result.value.data.title).toBeNull();
	});

	it("omits slug when the template does not map it", () => {
		const { slug: _s, ...noSlug } = template;
		const result = applyTemplate(noSlug as Template, row);
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
	it("takes JSON numbers as numbers and turns numbers and booleans into text", () => {
		const result = applyTemplate(jsonT, {
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

	it("reads numeric strings, null and missing paths as before", () => {
		const result = applyTemplate(jsonT, { sku: "A1", name: "Desk", price: { amount: "7" } });
		expect(result.ok && result.value.data).toEqual({ title: "Desk", price: 7, released: null });
		const nulls = applyTemplate(jsonT, { sku: "A1", name: "Desk", price: null, released: null });
		expect(nulls.ok && nulls.value.data).toEqual({ title: "Desk", price: null, released: null });
	});

	it("fails not_scalar for an object or array where a single value is expected", () => {
		const result = applyTemplate(jsonT, {
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

	it("rejects booleans and non-finite numbers in number fields", () => {
		const t = applyTemplate(jsonT, { sku: "A", name: "n", price: { amount: false } });
		expect(t).toMatchObject({ ok: false, errors: [{ field: "price", code: "invalid_number" }] });
	});

	it("fails a non-object record with missing_key", () => {
		const result = applyTemplate(jsonT, "just a string");
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["missing_key", "empty_slug"]);
	});

	it("reads XML text elements and attributes", () => {
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
		const result = applyTemplate(xmlT, {
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
