import { describe, expect, it } from "vitest";
import { resolvePath, sampleColumns } from "../../src/admin/wizard/sample.js";
import { resolvePath as engineResolvePath } from "../../src/sources/paths.js";
import type { SourceFormat } from "../../src/sources/reader.js";

/** The browser's copy of `resolvePath` agrees with the engine's (plan Ruling 8, preflight F23). */
describe("resolvePath", () => {
	const xml = {
		"@id": "7",
		title: "Hello",
		price: { "@currency": "EUR", "#text": "9.50" },
		flag: { "@set": "yes" },
		body: { p: ["one", "two"] },
		tags: { tag: ["a", "b"] },
	};
	const cases: [string, unknown, string, SourceFormat][] = [
		["JSON nested", { a: { b: { c: 3 } } }, "a.b.c", "json"],
		["JSON missing", { a: { b: 1 } }, "a.x", "json"],
		["JSON null", { a: null }, "a", "json"],
		["JSON through null", { a: null }, "a.b", "json"],
		["JSON Lines nested", { a: { b: "x" } }, "a.b", "jsonl"],
		["array stop", { a: [{ b: 1 }, { b: 2 }] }, "a.b", "json"],
		["inherited key", { a: 1 }, "toString", "json"],
		["XML attribute", xml, "@id", "xml"],
		["XML #text", xml, "price/#text", "xml"],
		["XML #text of a text element", xml, "title/#text", "xml"],
		["XML #text past a string", xml, "title/#text/x", "xml"],
		["XML text element", xml, "price", "xml"],
		["XML attribute-only element", xml, "flag", "xml"],
		["XML child element", xml, "body/p", "xml"],
		["XML element attribute", xml, "price/@currency", "xml"],
		["CSV dotted header", { "a.b": "1", a: { b: "2" } }, "a.b", "csv"],
		["CSV missing column", { a: "1" }, "b", "csv"],
		["XLSX column", { Name: "x", _row: 2 }, "_row", "xlsx"],
		["CSV non-object", "text", "a", "csv"],
	];

	it.each(cases)("agrees with the engine on %s", (_, value, path, format) => {
		expect(resolvePath(value, path, format)).toEqual(engineResolvePath(value, path, format));
	});

	it("reads an attribute-only XML element as empty text and #text as its text", () => {
		expect(resolvePath(xml, "flag", "xml")).toBe("");
		expect(resolvePath(xml, "price", "xml")).toBe("9.50");
		expect(resolvePath(xml, "title/#text", "xml")).toBe("Hello");
	});
});

describe("sampleColumns", () => {
	it("builds CSV columns from headers and rows, undefined for short rows", () => {
		const columns = sampleColumns(
			{
				headers: ["sku", "name", "price"],
				rows: [
					["A1", "Pen", "1.50"],
					["B2", "Ink"],
				],
			},
			"csv",
		);
		expect(columns).toEqual([
			{ key: "sku", values: ["A1", "B2"] },
			{ key: "name", values: ["Pen", "Ink"] },
			{ key: "price", values: ["1.50", undefined] },
		]);
	});

	it("builds JSON/XML columns from paths and records", () => {
		const json = sampleColumns(
			{
				records: [{ id: 1, meta: { tags: ["a"] } }, { id: 2 }],
				paths: ["id", "meta.tags"],
			},
			"json",
		);
		expect(json).toEqual([
			{ key: "id", values: [1, 2] },
			{ key: "meta.tags", values: [["a"], undefined] },
		]);

		const xml = sampleColumns(
			{
				records: [{ "@id": "1", title: "A" }, { title: { "#text": "B", "@lang": "en" } }],
				paths: ["@id", "title"],
			},
			"xml",
		);
		expect(xml).toEqual([
			{ key: "@id", values: ["1", undefined] },
			{ key: "title", values: ["A", "B"] },
		]);
	});

	it("has keys and no values for a header-only CSV, and nothing for an empty JSON sample", () => {
		expect(sampleColumns({ headers: ["a"], rows: [] }, "csv")).toEqual([{ key: "a", values: [] }]);
		expect(sampleColumns({ records: [], paths: [] }, "json")).toEqual([]);
	});
});
