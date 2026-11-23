import { describe, expect, it } from "vitest";
import { RESERVED_FIELD_SLUGS } from "../../src/admin/limits.js";
import { inferFieldType, proposeField } from "../../src/admin/wizard/map/new-fields/infer.js";

describe("inferFieldType", () => {
	const cases: [string, unknown[], string][] = [
		["no values", [], "string"],
		["only empty values", [undefined, null, "", "  "], "string"],
		["integers as text", ["1", "2", "-30", "+4"], "integer"],
		["integers as numbers", [12, 7], "integer"],
		["decimals and integers", ["9.5", "10"], "number"],
		["JSON numbers", [1.25, 3], "number"],
		["an exponent", ["1e3", "2"], "number"],
		["ones and zeros", ["1", "0"], "boolean"],
		["JSON ones and zeros", [1, 0, 1], "boolean"],
		["booleans", [true, false], "boolean"],
		["boolean words", ["Yes", "no", "TRUE", " false "], "boolean"],
		["a dd/MM/yyyy date", ["01/03/2026"], "datetime"],
		[
			"ISO dates",
			["2026-03-01", "2026-03-01T10:20:30Z", "2026-03-01T10:20:30.5+02:00"],
			"datetime",
		],
		["an ISO date with a space", ["2026-03-01 10:20"], "datetime"],
		["an impossible ISO date", ["2026-13-01"], "string"],
		["an impossible dd/MM date", ["32/01/2026"], "string"],
		["URLs", ["https://example.com/a", "http://example.com"], "url"],
		["a URL of another scheme", ["https://example.com", "ftp://example.com"], "string"],
		["a long value", ["short", "x".repeat(201)], "text"],
		["200 characters", ["x".repeat(200)], "string"],
		["mixed values", ["1", "two"], "string"],
		["empties beside integers", ["", "5", undefined, null], "integer"],
		["an object", [{ a: 1 }], "string"],
		["a long object", [{ a: "x".repeat(300) }], "text"],
		["a mix of true and integers", [true, "7"], "string"],
	];

	it.each(cases)("infers %s", (_, values, type) => {
		expect(inferFieldType(values)).toBe(type);
	});
});

describe("proposeField", () => {
	const column = (key: string, values: unknown[] = ["a"]) => ({ key, values });

	it("lower-cases the key into a slug, with the key as label", () => {
		expect(proposeField(column("Released"), [])).toEqual({
			key: "Released",
			slug: "released",
			label: "Released",
			type: "string",
			translatable: true,
			searchable: false,
		});
	});

	it("replaces runs outside a-z0-9 with one underscore, trimmed", () => {
		expect(proposeField(column("  Unit -- Price (EUR) "), []).slug).toBe("unit_price_eur");
		expect(proposeField(column("price/#text"), []).slug).toBe("price_text");
	});

	it("prefixes f_ when the slug does not start with a letter", () => {
		expect(proposeField(column("2nd price"), []).slug).toBe("f_2nd_price");
		expect(proposeField(column("@id"), []).slug).toBe("id_2");
		expect(proposeField(column("_row"), []).slug).toBe("row");
	});

	it("names a key with no letters or digits field", () => {
		expect(proposeField(column("#"), []).slug).toBe("field");
	});

	it("drops accents rather than the letters", () => {
		expect(proposeField(column("Préis Ünit"), []).slug).toBe("preis_unit");
	});

	it("adds _2, _3… when the slug is taken", () => {
		expect(proposeField(column("Released"), ["released"]).slug).toBe("released_2");
		expect(proposeField(column("Released"), ["released", "released_2"]).slug).toBe("released_3");
	});

	it("treats EmDash's reserved slugs and flux_source_id as taken (preflight F16)", () => {
		expect(proposeField(column("Status"), []).slug).toBe("status_2");
		expect(proposeField(column("id"), []).slug).toBe("id_2");
		expect(proposeField(column("flux_source_id"), []).slug).toBe("flux_source_id_2");
		for (const reserved of RESERVED_FIELD_SLUGS) {
			expect(proposeField(column(reserved), []).slug).toBe(`${reserved}_2`);
		}
	});

	it("keeps slugs to 63 characters, suffix included", () => {
		const key = "a".repeat(70);
		expect(proposeField(column(key), []).slug).toBe("a".repeat(63));
		expect(proposeField(column(key), ["a".repeat(63)]).slug).toBe(`${"a".repeat(61)}_2`);
		const underscored = `${"a".repeat(62)} b`;
		expect(proposeField(column(underscored), []).slug).toBe("a".repeat(62));
	});

	it("cuts a 300-character key's label to 200 characters, trimmed (preflight F16)", () => {
		const key = `${"k".repeat(199)} ${"x".repeat(100)}`;
		const field = proposeField(column(key), []);
		expect(field.label).toBe("k".repeat(199));
		expect(field.slug).toHaveLength(63);
		expect(field.key).toBe(key);
	});

	it("trims the label and folds its whitespace", () => {
		expect(proposeField(column("  Unit\n\tprice  "), []).label).toBe("Unit price");
	});

	it("never cuts a label inside a surrogate pair", () => {
		const label = proposeField(column(`${"k".repeat(199)}😀`), []).label;
		expect(label).toBe("k".repeat(199));
	});

	it("labels a key that is only spaces with its slug", () => {
		expect(proposeField(column("   "), []).label).toBe("field");
	});

	it("infers the type from the column's values", () => {
		expect(proposeField(column("Price", ["9.5", "10"]), []).type).toBe("number");
	});
});
