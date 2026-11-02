import { describe, expect, it } from "vitest";
import {
	buildLogCsv,
	csvCell,
	LOG_COLUMNS,
	LogTooLargeError,
	recordsToCsvLines,
} from "../../src/engine/log.js";
import { capErrors, capWarnings, type RecordRow, recordKey } from "../../src/engine/types.js";
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
			"1,created,S0,e0,,,,,\r\n" +
				'2,failed,S1,,,invalid_number,price,"""x"" is not a number; The slug would be empty",\r\n' +
				"3,planned,S2,e2,update,,,,\r\n",
		);
	});

	it("ends each line with the record's warnings", () => {
		const lines = recordsToCsvLines([
			row(0, {
				warnings: [
					{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
					{ code: "warnings_truncated", message: "3 more warnings" },
				],
			}),
		]);
		expect(lines).toBe(
			"1,created,S0,e0,,,,,body: unknown_markup: Kept the text of 1 <table> element; warnings_truncated: 3 more warnings\r\n",
		);
	});
});

describe("capWarnings", () => {
	it("keeps at most 20 warnings, the last saying how many more there were", () => {
		const warnings = Array.from({ length: 25 }, (_, i) => ({
			field: "body",
			code: "image_dropped",
			message: `w${i}`,
		}));
		expect(capWarnings(warnings.slice(0, 20))).toEqual(warnings.slice(0, 20));
		expect(capWarnings(warnings)).toEqual([
			...warnings.slice(0, 19),
			{ code: "warnings_truncated", message: "6 more warnings" },
		]);
	});

	it("cuts each message to 1,000 characters", () => {
		const long = { field: "body", code: "link_dropped", message: "x".repeat(5000) };
		const [cut] = capWarnings([long]);
		expect(cut).toEqual({ ...long, message: `${"x".repeat(999)}…` });
		expect(capErrors([long])).toEqual([cut]);
	});
});

describe("capErrors", () => {
	it("keeps at most 50 errors, the last saying how many more there were", () => {
		const errors = Array.from({ length: 60 }, (_, i) => ({
			field: "body",
			code: "invalid_media_url",
			message: `e${i}`,
		}));
		expect(capErrors(errors.slice(0, 50))).toEqual(errors.slice(0, 50));
		expect(capErrors(errors)).toEqual([
			...errors.slice(0, 49),
			{ code: "errors_truncated", message: "11 more errors" },
		]);
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

	it("stops reading pages as soon as the byte budget is exceeded", async () => {
		const { deps } = makeDeps();
		for (let seq = 0; seq < 250; seq++) await deps.records.put(recordKey("j1", seq), row(seq));
		let queries = 0;
		const query = deps.records.query.bind(deps.records);
		deps.records.query = (opts) => {
			queries++;
			return query(opts);
		};
		const error = await buildLogCsv(deps, "j1", { maxBytes: 500 }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LogTooLargeError);
		expect(queries).toBe(1);
		// A budget the whole log fits in changes nothing; it counts UTF-8 bytes, not characters
		// ("éé" has as many characters as "S0" but two more bytes).
		const full = await buildLogCsv(deps, "j1");
		const bytes = new TextEncoder().encode(full).byteLength;
		expect(await buildLogCsv(deps, "j1", { maxBytes: bytes })).toBe(full);
		await deps.records.put(recordKey("j1", 0), row(0, { sourceKey: "éé" }));
		await expect(buildLogCsv(deps, "j1", { maxBytes: bytes })).rejects.toBeInstanceOf(
			LogTooLargeError,
		);
	});

	it("filters by status", async () => {
		const { deps } = makeDeps();
		await deps.records.put(recordKey("j1", 0), row(0));
		await deps.records.put(recordKey("j1", 1), row(1, { status: "failed" }));
		const csv = await buildLogCsv(deps, "j1", { status: "failed" });
		expect(csv.trimEnd().split("\r\n").slice(1)).toEqual(["2,failed,S1,e1,,,,,"]);
	});
});
