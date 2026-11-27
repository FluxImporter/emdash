import { describe, expect, it } from "vitest";
import { csvReader } from "../../src/sources/csv-reader.js";
import {
	positioned,
	SAMPLE_MAX_BYTES,
	SourceError,
	type SourceRecord,
	takeSample,
} from "../../src/sources/reader.js";
import { collect, expectReaderInvariants, readAll, streamOf } from "./helpers.js";

async function* records(list: SourceRecord[]): AsyncGenerator<SourceRecord> {
	yield* list;
}

describe("positioned", () => {
	it("skips a UTF-8 BOM split across one-byte chunks and keeps absolute offsets", async () => {
		const chunks = await collect(positioned(streamOf("﻿ab", 1), 0));
		expect(chunks.map((c) => [c.offset, [...c.bytes]])).toEqual([
			[3, []],
			[3, [0x61]],
			[4, [0x62]],
		]);
	});

	it("starts at the given offset without looking for a BOM", async () => {
		const chunks = await collect(positioned(streamOf("xy"), 10));
		expect(chunks.map((c) => c.offset)).toEqual([10]);
	});

	it("passes inputs shorter than a BOM through", async () => {
		const chunks = await collect(positioned(streamOf("a"), 0));
		expect(chunks.map((c) => [c.offset, c.bytes.length])).toEqual([[0, 1]]);
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		for (const bom of [
			[0xff, 0xfe],
			[0xfe, 0xff],
		]) {
			const error = await collect(positioned(streamOf(new Uint8Array([...bom, 0x41, 0])), 0)).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(SourceError);
			expect(error).toMatchObject({ code: "unsupported_encoding", offset: 0 });
		}
	});
});

describe("takeSample", () => {
	const rec = (seq: number, size: number, error = false): SourceRecord => ({
		seq,
		start: seq * size,
		end: (seq + 1) * size,
		value: seq,
		...(error ? { error: { code: "invalid_record", message: "bad" } } : {}),
	});

	it("skips records with errors and stops at n", async () => {
		const list = [rec(0, 1), rec(1, 1, true), rec(2, 1), rec(3, 1)];
		expect(await takeSample(records(list), 2)).toEqual([0, 2]);
	});

	it("stops once the sampled records reach SAMPLE_MAX_BYTES, keeping at least one", async () => {
		const big = SAMPLE_MAX_BYTES / 2;
		expect(await takeSample(records([rec(0, big), rec(1, big), rec(2, big)]), 20)).toEqual([0, 1]);
		expect(await takeSample(records([rec(0, SAMPLE_MAX_BYTES * 2)]), 20)).toEqual([0]);
	});

	it("does not add a record that would take the sample past SAMPLE_MAX_BYTES", async () => {
		const list: SourceRecord[] = [
			{ seq: 0, start: 0, end: 700_000, value: 0 },
			{ seq: 1, start: 700_000, end: 1_400_000, value: 1 },
			{ seq: 2, start: 1_400_000, end: 1_400_010, value: 2 },
		];
		expect(await takeSample(records(list), 20)).toEqual([0]);
	});
});

const TRICKY =
	"﻿sku,name,notes\r\n" +
	'A1,"Ș, ț and ""quotes""","line one\r\nline two"\r\n' +
	"\r\n" +
	"B2,日本 🚀\n" +
	"C3,last,no newline";

describe("csvReader", () => {
	it("locates the body after the header and returns the columns", async () => {
		expect(await csvReader([]).locate(streamOf(TRICKY))).toEqual({
			bodyOffset: 3 + "sku,name,notes\r\n".length,
			columns: ["sku", "name", "notes"],
		});
	});

	it("keeps every invariant and reports column_count with the expected count", async () => {
		const reader = csvReader(["sku", "name", "notes"]);
		const recs = await expectReaderInvariants(reader, TRICKY);
		expect(recs.map((r) => [r.seq, r.value, r.error])).toEqual([
			[0, { sku: "A1", name: 'Ș, ț and "quotes"', notes: "line one\r\nline two" }, undefined],
			[
				1,
				{ sku: "B2", name: "日本 🚀", notes: "" },
				{ code: "column_count", message: "Expected 3 columns" },
			],
			[2, { sku: "C3", name: "last", notes: "no newline" }, undefined],
		]);
	});

	it("turns CSV syntax errors into SourceError csv_syntax with the offset", async () => {
		const error = await readAll(csvReader(["a", "b"]), 'a,b\n1,"open\n').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "csv_syntax", offset: 4 });
		await expect(csvReader([]).locate(streamOf(""))).rejects.toMatchObject({ code: "csv_syntax" });
	});

	it("samples rows as objects with the header as paths", async () => {
		expect(await csvReader([]).sample(streamOf("sku,name\nA,1\nB\n"), 5)).toEqual({
			records: [
				{ sku: "A", name: "1" },
				{ sku: "B", name: "" },
			],
			paths: ["sku", "name"],
		});
	});
});
