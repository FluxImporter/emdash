import { describe, expect, it } from "vitest";
import {
	CsvSyntaxError,
	dropBytes,
	MAX_RECORD_BYTES,
	normalizeHeaders,
	parseCsvRows,
	readCsvHeader,
	readCsvRecords,
	readCsvSample,
} from "../../src/sources/csv.js";
import { collect, streamOf } from "./helpers.js";

const TRICKY =
	"﻿sku,name,notes\r\n" +
	'A1,"Ș, ț and ""quotes""","line one\r\nline two"\r\n' +
	"\r\n" +
	"B2,日本 🚀,plain\r\n" +
	"C3,last,no newline";

const fields = (rows: { fields: string[] }[]) => rows.map((r) => r.fields);

describe("parseCsvRows", () => {
	it("parses BOM, CRLF, quoted commas, escaped quotes, embedded newlines and multibyte text", async () => {
		const rows = await collect(parseCsvRows(streamOf(TRICKY)));
		expect(fields(rows)).toEqual([
			["sku", "name", "notes"],
			["A1", 'Ș, ț and "quotes"', "line one\r\nline two"],
			["B2", "日本 🚀", "plain"],
			["C3", "last", "no newline"],
		]);
	});

	it("gives identical rows and offsets when the stream is split at every byte", async () => {
		const whole = await collect(parseCsvRows(streamOf(TRICKY)));
		const bytewise = await collect(parseCsvRows(streamOf(TRICKY, 1)));
		expect(bytewise).toEqual(whole);
	});

	it("reports offsets that resume exactly on a record boundary", async () => {
		const bytes = new TextEncoder().encode(TRICKY);
		const all = await collect(parseCsvRows(streamOf(bytes)));
		for (let i = 1; i < all.length; i++) {
			const from = all[i - 1]!.end;
			const resumed = await collect(parseCsvRows(dropBytes(streamOf(bytes, 3), from), from));
			expect(resumed).toEqual(all.slice(i));
		}
		expect(all.at(-1)!.end).toBe(bytes.length);
	});

	it("skips the BOM so the first row starts at byte 3", async () => {
		const [first] = await collect(parseCsvRows(streamOf(TRICKY)));
		expect(first!.start).toBe(3);
	});

	it("keeps a row of empty fields but skips blank lines", async () => {
		const rows = await collect(parseCsvRows(streamOf("a,b\n\n,\n")));
		expect(fields(rows)).toEqual([
			["a", "b"],
			["", ""],
		]);
	});

	it("throws CsvSyntaxError with the row offset for an unterminated quote", async () => {
		const input = 'a,b\n1,"open\n';
		await expect(collect(parseCsvRows(streamOf(input)))).rejects.toMatchObject({
			name: "CsvSyntaxError",
			offset: 4,
		});
	});

	it("handles files shorter than three bytes", async () => {
		expect(fields(await collect(parseCsvRows(streamOf("a"))))).toEqual([["a"]]);
		expect(await collect(parseCsvRows(streamOf("")))).toEqual([]);
	});
});

describe("headers", () => {
	it("reads the header and the offset where records start", async () => {
		const header = await readCsvHeader(streamOf(TRICKY));
		expect(header.headers).toEqual(["sku", "name", "notes"]);
		expect(header.bodyOffset).toBe(3 + "sku,name,notes\r\n".length);
	});

	it("names blank headers by position and trims the rest", () => {
		expect(normalizeHeaders([" sku ", "", "name"])).toEqual(["sku", "column_2", "name"]);
	});

	it("rejects duplicate headers", () => {
		expect(() => normalizeHeaders(["sku", "sku"])).toThrow(CsvSyntaxError);
	});

	it("rejects an empty file", async () => {
		await expect(readCsvHeader(streamOf(""))).rejects.toBeInstanceOf(CsvSyntaxError);
	});
});

describe("readCsvRecords", () => {
	it("maps fields to headers, numbers records and flags column-count mismatches", async () => {
		const input = "sku,name\nA1,One\nB2\nC3,Three,extra\n";
		const { headers, bodyOffset } = await readCsvHeader(streamOf(input));
		const records = await collect(
			readCsvRecords(dropBytes(streamOf(input), bodyOffset), {
				headers,
				startOffset: bodyOffset,
				startSeq: 0,
			}),
		);
		expect(records.map((r) => [r.seq, r.values, r.error])).toEqual([
			[0, { sku: "A1", name: "One" }, undefined],
			[1, { sku: "B2", name: "" }, "column_count"],
			[2, { sku: "C3", name: "Three" }, "column_count"],
		]);
	});

	it("stores a __proto__ header as plain data", async () => {
		const input = "__proto__,x\n1,2\n";
		const { headers, bodyOffset } = await readCsvHeader(streamOf(input));
		const [rec] = await collect(
			readCsvRecords(dropBytes(streamOf(input), bodyOffset), {
				headers,
				startOffset: bodyOffset,
				startSeq: 0,
			}),
		);
		expect(Object.getPrototypeOf(rec!.values)).toBe(Object.prototype);
		expect(Object.keys(rec!.values)).toEqual(["__proto__", "x"]);
	});
});

describe("record size limit", () => {
	it("rejects a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const huge = `sku,notes\nA1,ok\nB2,"${"x".repeat(MAX_RECORD_BYTES)}"\n`;
		const error = await collect(parseCsvRows(streamOf(huge))).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CsvSyntaxError);
		expect(error).toMatchObject({ offset: "sku,notes\nA1,ok\n".length });
	});

	it("accepts a record just under the limit", async () => {
		const big = `sku,notes\nA1,${"x".repeat(MAX_RECORD_BYTES - 10)}\n`;
		const rows = await collect(parseCsvRows(streamOf(big)));
		expect(rows).toHaveLength(2);
	});
});

describe("readCsvSample", () => {
	it("returns the headers and the first n rows", async () => {
		const sample = await readCsvSample(streamOf("sku,name\nA,1\nB,2\nC,3\n"), 2);
		expect(sample).toEqual({
			headers: ["sku", "name"],
			rows: [
				["A", "1"],
				["B", "2"],
			],
		});
	});

	it("returns fewer rows when the file is short and rejects an empty file", async () => {
		expect(await readCsvSample(streamOf("sku\nA\n"), 20)).toEqual({
			headers: ["sku"],
			rows: [["A"]],
		});
		await expect(readCsvSample(streamOf(""), 5)).rejects.toBeInstanceOf(CsvSyntaxError);
	});
});
