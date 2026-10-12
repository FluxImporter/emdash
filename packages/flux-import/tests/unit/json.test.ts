import { describe, expect, it } from "vitest";
import { dropBytes } from "../../src/sources/csv.js";
import { jsonlReader, jsonReader } from "../../src/sources/json.js";
import { MAX_RECORD_BYTES, SourceError } from "../../src/sources/reader.js";
import { collect, expectReaderInvariants, readAll, streamOf } from "./helpers.js";

/** Decoys before the records: a "data.products" path inside another key, brackets in strings. */
const WRAPPED =
	"﻿{\n" +
	'  "meta": { "data": { "products": "decoy" }, "note": "a ] } [ { \\" tricky", "list": [1, [2, {"x": "]"}]] },\n' +
	'  "count": -1.5e3, "ok": true, "none": null,\n' +
	'  "data": { "skip": "products", "products": [\n' +
	'    {"sku": "A1", "name": "Ș, ț and \\"quotes\\" 日本 🚀", "price": {"amount": 12.5}},\n' +
	'    {"sku": "B2", "nested": {"deep": [[[{"a": "}"}]]]}, "esc": "\\u00e9\\n\\\\"} ,\n' +
	'    "just a string", 42 ,null,\n' +
	'    {"sku": "C3"}\n' +
	"  ] },\n" +
	'  "after": [1, 2]\n' +
	"}";

const values = (recs: { value: unknown }[]) => recs.map((r) => r.value);

describe("jsonReader", () => {
	it("walks the records path, skipping other keys, and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(jsonReader("data.products"), WRAPPED);
		expect(values(recs)).toEqual([
			{ sku: "A1", name: 'Ș, ț and "quotes" 日本 🚀', price: { amount: 12.5 } },
			{ sku: "B2", nested: { deep: [[[{ a: "}" }]]] }, esc: "é\n\\" },
			"just a string",
			42,
			null,
			{ sku: "C3" },
		]);
		expect(recs.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
		const bytes = new TextEncoder().encode(WRAPPED);
		expect(new TextDecoder().decode(bytes.subarray(recs[3]!.start, recs[3]!.end))).toBe("42");
	});

	it("reads a top-level array and skips a BOM", async () => {
		const input = '﻿ [ {"a": 1}, {"a": 2} ]  ';
		const recs = await expectReaderInvariants(jsonReader(), input);
		expect(values(recs)).toEqual([{ a: 1 }, { a: 2 }]);
		expect(await jsonReader().locate(streamOf(input))).toEqual({ bodyOffset: 3 + 2 });
	});

	it("reads an empty array as no records", async () => {
		expect(await readAll(jsonReader(), "[ ]")).toEqual([]);
		expect(await readAll(jsonReader("a"), '{"a": []}', 1)).toEqual([]);
	});

	it("parses deep nesting inside a record", async () => {
		const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
		const recs = await readAll(jsonReader(), `[${deep}, {"b": 1}]`, 1000);
		expect(recs).toHaveLength(2);
		expect(recs[0]!.error).toBeUndefined();
	});

	it("fails only the record whose bytes do not parse", async () => {
		const input = '[{"a": 1}, {"a": }, {"a": tru}, {"a": 3}]';
		const recs = await expectReaderInvariants(jsonReader(), input);
		expect(recs.map((r) => [r.value, r.error?.code])).toEqual([
			[{ a: 1 }, undefined],
			[null, "invalid_record"],
			[null, "invalid_record"],
			[{ a: 3 }, undefined],
		]);
	});

	it("fails a record that is not valid UTF-8", async () => {
		const bytes = new Uint8Array([0x5b, 0x22, 0xc3, 0x28, 0x22, 0x5d]); // ["\xC3("]
		const [rec] = await readAll(jsonReader(), bytes);
		expect(rec!.error).toMatchObject({ code: "invalid_record" });
	});

	it.each([
		["an unterminated string", '[{"a": 1}, {"a": "open]', 11],
		["an unterminated array", '[{"a": 1}, {"a": 2}', 19],
		["mismatched brackets", '[{"a": 1}, {"a": [1}]', 19],
		["two values without a comma", "[1 2]", 3],
		["a trailing comma", "[1, ]", 4],
		["a leading comma", "[, 1]", 1],
	])("fails the job with source_syntax and its offset for %s", async (_name, input, offset) => {
		const reader = jsonReader();
		const error = await readAll(reader, input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax", offset });
	});

	it("yields the records before a structural error, then throws", async () => {
		const input = '[{"a": 1}, {"a": 2}, {"a": "open';
		const seen: unknown[] = [];
		const read = jsonReader().read(dropBytes(streamOf(input), 1), { startOffset: 1, startSeq: 0 });
		const error = await (async () => {
			for await (const rec of read) seen.push(rec.value);
		})().catch((e: unknown) => e);
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
		expect(error).toMatchObject({ code: "source_syntax", offset: 21 });
	});

	it.each([
		["a top-level object without records", undefined, '{"a": []}', /source\.records/],
		["a top-level scalar", undefined, '"text"', /a string, not an array/],
		["an empty document", undefined, "  ", /empty/],
		[
			"a missing key",
			"data.items",
			'{"data": {"products": []}}',
			/Key "items" in "data" not found/,
		],
		[
			"a value that is not an array",
			"data",
			'{"data": {"x": 1}}',
			/"data" is an object, not an array/,
		],
		["a path through a scalar", "data.items", '{"data": 5}', /"data" is a number, not an object/],
		["a records path on an array", "data", "[1]", /needs an object/],
	])("fails locate with invalid_source for %s", async (_name, records, input, message) => {
		const error = await jsonReader(records)
			.locate(streamOf(input, 2))
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "invalid_source",
			message: expect.stringMatching(message),
		});
	});

	it("finds the first of duplicate keys", async () => {
		const recs = await readAll(jsonReader("a"), '{"a": [1], "a": [2]}');
		expect(values(recs)).toEqual([1]);
	});

	it("fails a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const input = `[1, "${"x".repeat(MAX_RECORD_BYTES)}"]`;
		const error = await readAll(jsonReader(), input).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "source_syntax", offset: 4 });
	});

	it("accepts a record just under the cap", async () => {
		const input = `["${"x".repeat(MAX_RECORD_BYTES - 10)}"]`;
		expect(await readAll(jsonReader(), input)).toHaveLength(1);
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		const utf16 = new Uint8Array([0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]);
		await expect(jsonReader().locate(streamOf(utf16, 1))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("samples records and their field paths", async () => {
		const sample = await jsonReader("data.products").sample(streamOf(WRAPPED), 2);
		expect(sample).toEqual({
			records: values((await readAll(jsonReader("data.products"), WRAPPED)).slice(0, 2)),
			paths: ["sku", "name", "price.amount", "nested.deep", "esc"],
		});
	});
});

describe("jsonlReader", () => {
	const LINES =
		'﻿{"sku": "A1", "name": "日本 🚀"}\r\n' +
		"\r\n" +
		"   \n" +
		'{"sku": "B2", "tags": ["x", "y"]}\n' +
		"{broken\n" +
		"[1, 2]\n" +
		'{"sku": "C3"}';

	it("reads one record per non-blank line and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(jsonlReader(), LINES);
		expect(recs.map((r) => [r.seq, r.value, r.error?.code])).toEqual([
			[0, { sku: "A1", name: "日本 🚀" }, undefined],
			[1, { sku: "B2", tags: ["x", "y"] }, undefined],
			[2, null, "invalid_record"],
			[3, [1, 2], undefined],
			[4, { sku: "C3" }, undefined],
		]);
		expect(recs[0]!.start).toBe(3);
		expect(recs.at(-1)!.end).toBe(new TextEncoder().encode(LINES).length);
	});

	it("locates after the BOM", async () => {
		expect(await jsonlReader().locate(streamOf(LINES))).toEqual({ bodyOffset: 3 });
		expect(await jsonlReader().locate(streamOf(""))).toEqual({ bodyOffset: 0 });
	});

	it("fails the job for a line larger than MAX_RECORD_BYTES", async () => {
		const input = `{"a": 1}\n"${"x".repeat(MAX_RECORD_BYTES)}"\n`;
		await expect(readAll(jsonlReader(), input)).rejects.toMatchObject({
			code: "source_syntax",
			offset: 9,
		});
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		const utf16 = new Uint8Array([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
		await expect(
			collect(jsonlReader().read(streamOf(utf16), { startOffset: 0, startSeq: 0 })),
		).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("samples records and paths", async () => {
		expect(await jsonlReader().sample(streamOf(LINES), 20)).toEqual({
			records: [
				{ sku: "A1", name: "日本 🚀" },
				{ sku: "B2", tags: ["x", "y"] },
				[1, 2],
				{ sku: "C3" },
			],
			paths: ["sku", "name", "tags"],
		});
	});
});
