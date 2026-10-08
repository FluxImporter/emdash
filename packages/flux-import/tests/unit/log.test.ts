import { describe, expect, it } from "vitest";
import { buildLogCsv, csvCell, LOG_COLUMNS, recordsToCsvLines } from "../../src/engine/log.js";
import { type RecordRow, recordKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

const row = (seq: number, patch: Partial<RecordRow> = {}): RecordRow => ({
	jobId: "j1",
	seq,
	start: 0,
	end: 0,
	status: "created",
	sourceKey: `S${seq}`,
	entryId: `e${seq}`,
	updatedAt: "2026-10-07T10:00:00.000Z",
	...patch,
});

describe("csvCell", () => {
	it.each([
		[null, ""],
		[undefined, ""],
		[42, "42"],
		["plain", "plain"],
		['say "hi", ok', '"say ""hi"", ok"'],
		["two\nlines", '"two\nlines"'],
		[" padded ", '" padded "'],
		['=HYPERLINK("x")', '"\'=HYPERLINK(""x"")"'],
		["+1", "'+1"],
		["-1", "'-1"],
		["@SUM(A1)", "'@SUM(A1)"],
		["\tx", "'\tx"],
	])("%j -> %s", (input, expected) => {
		expect(csvCell(input)).toBe(expected);
	});
});

describe("recordsToCsvLines", () => {
	it("writes one CRLF line per record with the first error's code and all messages", () => {
		const lines = recordsToCsvLines([
			row(0),
			row(1, {
				status: "failed",
				entryId: null,
				errors: [
					{ field: "price", code: "invalid_number", message: '"x" is not a number' },
					{ field: "slug", code: "empty_slug", message: "The slug would be empty" },
				],
			}),
			row(2, { status: "planned", action: "update" }),
		]);
		expect(lines).toBe(
			"1,created,S0,e0,,,,\r\n" +
				'2,failed,S1,,,invalid_number,price,"""x"" is not a number; The slug would be empty"\r\n' +
				"3,planned,S2,e2,update,,,\r\n",
		);
	});
});

describe("buildLogCsv", () => {
	it("writes the header and every record of the job in order, across pages", async () => {
		const { deps } = makeDeps();
		for (let seq = 249; seq >= 0; seq--) await deps.records.put(recordKey("j1", seq), row(seq));
		await deps.records.put(recordKey("j2", 0), row(0, { jobId: "j2" }));
		const csv = await buildLogCsv(deps, "j1");
		const lines = csv.trimEnd().split("\r\n");
		expect(lines[0]).toBe(LOG_COLUMNS.join(","));
		expect(lines.length).toBe(251);
		expect(lines[1]!.startsWith("1,")).toBe(true);
		expect(lines[250]!.startsWith("250,")).toBe(true);
	});

	it("filters by status", async () => {
		const { deps } = makeDeps();
		await deps.records.put(recordKey("j1", 0), row(0));
		await deps.records.put(recordKey("j1", 1), row(1, { status: "failed" }));
		const csv = await buildLogCsv(deps, "j1", { status: "failed" });
		expect(csv.trimEnd().split("\r\n").slice(1)).toEqual(["2,failed,S1,e1,,,,"]);
	});
});
