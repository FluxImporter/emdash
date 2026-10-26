import { describe, expect, it } from "vitest";
import { checkSource, readerFor } from "../../src/sources/readers.js";
import { readAll } from "./helpers.js";

describe("checkSource", () => {
	it.each([
		[{ format: "csv" }, []],
		[{ format: "json" }, []],
		[{ format: "json", records: "data.products" }, []],
		[{ format: "jsonl" }, []],
		[{ format: "xml", records: "feed/item" }, []],
		[{ format: "xlsx" }, []],
		[{ format: "xlsx", sheet: "Products", headerRow: 3 }, []],
		[{ format: "xlsx", sheet: 2 }, []],
		[{ format: "xlsx", records: "x" }, ["source.records is not allowed for xlsx"]],
		[{ format: "csv", sheet: "Products" }, ["source.sheet is only allowed for xlsx"]],
		[
			{ format: "xml", records: "feed/item", sheet: 1, headerRow: 2 },
			["source.sheet is only allowed for xlsx", "source.headerRow is only allowed for xlsx"],
		],
		[
			{ format: "json", headerRow: 2, records: "a..b" },
			["source.headerRow is only allowed for xlsx", 'source.records: "a..b" has an empty key'],
		],
		[{ format: "csv", records: "x" }, ["source.records is not allowed for csv"]],
		[{ format: "jsonl", records: "x" }, ["source.records is not allowed for jsonl"]],
		[{ format: "xml" }, ['source.records is required for xml, as in "feed/item"']],
		[{ format: "json", records: "a..b" }, ['source.records: "a..b" has an empty key']],
		[
			{ format: "xml", records: "item" },
			[
				'source.records: "item" must name the root element and the record element, as in "feed/item"',
			],
		],
	] as const)("%j", (source, problems) => {
		expect(checkSource(source)).toEqual(problems);
	});
});

describe("readerFor", () => {
	it("returns the reader for each format", async () => {
		const read = async (
			source: Parameters<typeof readerFor>[0],
			body: string,
			columns?: string[],
		) => (await readAll(readerFor(source, columns), body)).map((r) => r.value);
		expect(await read({ format: "csv" }, "a\n1\n", ["a"])).toEqual([{ a: "1" }]);
		expect(await read({ format: "json" }, "[1]")).toEqual([1]);
		expect(await read({ format: "json", records: "x" }, '{"x": [2]}')).toEqual([2]);
		expect(await read({ format: "jsonl" }, "3\n")).toEqual([3]);
		expect(await read({ format: "xml", records: "r/i" }, "<r><i>4</i></r>")).toEqual([
			{ "#text": "4" },
		]);
		// An XLSX job reads the JSON Lines its sheet was converted to.
		expect(await read({ format: "xlsx" }, '{"Name":"Desk","_row":2}\n', ["Name"])).toEqual([
			{ Name: "Desk", _row: 2 },
		]);
	});
});
