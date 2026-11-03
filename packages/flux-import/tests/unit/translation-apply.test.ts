import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	type SchemaField,
	type Template,
	targetFieldsOf,
	templateSchema,
} from "../../src/engine/template.js";

const fields: SchemaField[] = [
	{ slug: "title", type: "string", required: true },
	{ slug: "sku", type: "string", required: true, translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "photo", type: "image" },
	{ slug: "badge", type: "image", translatable: false },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
];

const template: Template = templateSchema.parse({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Nom", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Prix", type: "number", decimal: "," },
		photo: { from: "Photo", type: "image" },
		badge: { from: "Badge", type: "image" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: { category: { from: "Category" } },
	bylines: { from: "Authors" },
});

function compiled(t: Template = template, sharedRequired: string[] = []): CompiledTemplate {
	const result = compileTemplate(t, { targets: targetFieldsOf(t, fields), sharedRequired });
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

const row = {
	id: "F1",
	en_id: " E1 ",
	handle: "Bureau",
	Nom: "Bureau",
	SKU: "",
	Prix: "abc",
	Photo: "https://example.com/fr.png",
	Badge: "not a url",
	Related: "E2|E3",
	Category: "Office",
	Authors: "alex",
};

describe("applyTemplate with translationOf", () => {
	it("keeps only the fields a translation owns for a record with a value", async () => {
		const c = compiled();
		expect([...c.shared]).toEqual(["sku", "price", "badge", "related"]);
		// The empty required sku, the bad price and the bad badge URL are never read.
		expect(await applyTemplate(c, row)).toEqual({
			ok: true,
			value: {
				key: "F1",
				translationOf: "E1",
				slug: "bureau",
				data: { title: "Bureau" },
				links: { bylines: ["alex"] },
				media: {
					photo: { kind: "image", url: "https://example.com/fr.png", alt: null, refresh: false },
				},
			},
		});
	});

	it("reads every mapping for a record without a value", async () => {
		for (const blank of ["", "   ", undefined, null]) {
			const result = await applyTemplate(compiled(), {
				...row,
				en_id: blank,
				SKU: "S1",
				Prix: "12,5",
				Badge: "https://example.com/badge.png",
			});
			expect(result).toEqual({
				ok: true,
				value: {
					key: "F1",
					slug: "bureau",
					data: { title: "Bureau", sku: "S1", price: 12.5 },
					links: {
						references: { related: ["E2", "E3"] },
						taxonomies: { category: [{ path: ["Office"] }] },
						bylines: ["alex"],
					},
					media: {
						photo: { kind: "image", url: "https://example.com/fr.png", alt: null, refresh: false },
						badge: {
							kind: "image",
							url: "https://example.com/badge.png",
							alt: null,
							refresh: false,
						},
					},
				},
			});
		}
	});

	it("fails required for the shared required fields only without a value", async () => {
		const t = templateSchema.parse({
			...template,
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const c = compiled(t, ["sku"]);
		expect(await applyTemplate(c, row)).toMatchObject({ ok: true, value: { translationOf: "E1" } });
		expect(await applyTemplate(c, { ...row, en_id: "" })).toEqual({
			ok: false,
			errors: [{ field: "sku", code: "required", message: "The field is required" }],
		});
	});

	it("reads the value with the key's rules", async () => {
		const c = compiled();
		const value = (en_id: unknown) => applyTemplate(c, { ...row, en_id });
		expect(await value(12)).toMatchObject({ ok: true, value: { translationOf: "12" } });
		expect(await value({ id: "E1" })).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "not_scalar",
					message: expect.stringContaining("object or array"),
				},
			],
		});
		expect(await value("x".repeat(257))).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "key_too_long",
					message: "Keys are limited to 256 characters",
				},
			],
		});
		expect(await value(` ${"x".repeat(256)} `)).toMatchObject({
			ok: true,
			value: { translationOf: "x".repeat(256) },
		});
	});

	it("reads an expression, and a failing one skips the shared mappings", async () => {
		const t = templateSchema.parse({
			...template,
			translationOf: { expr: '$exists(en_id) ? "EN-" & $trim(en_id) : ""', locale: "en" },
		});
		expect(await applyTemplate(compiled(t), row)).toMatchObject({
			ok: true,
			value: { translationOf: "EN-E1" },
		});
		const broken = templateSchema.parse({
			...template,
			translationOf: { expr: "en_id + 1", locale: "en" },
		});
		expect(await applyTemplate(compiled(broken), row)).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "expr_error",
					message: expect.stringMatching(/^JSONata T2001 /),
				},
			],
		});
	});

	it("reports a bad translationOf expression at compile time", () => {
		const t = templateSchema.parse({ ...template, translationOf: { expr: "(", locale: "en" } });
		const result = compileTemplate(t);
		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.problems).toEqual([
			expect.stringMatching(/^translationOf\.expr: JSONata S0\d+ at character \d+: /),
		]);
	});

	it("shares nothing without translationOf", () => {
		const t = templateSchema.parse({ ...template, locale: "en", translationOf: undefined });
		expect([...compiled(t).shared]).toEqual([]);
	});
});
