import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { dateConverter, localInstant } from "../../src/engine/dates.js";

const ok = (value: string | null) => ({ ok: true, value });
const invalid = expect.objectContaining({ ok: false, code: "invalid_date" });

describe("dateConverter", () => {
	it("reads ISO text in the zone, keeping an explicit offset, into EmDash's canonical form", () => {
		const utc = dateConverter({ tz: "UTC" }, "datetime");
		expect(utc("2025-01-24T12:00")).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(utc("2025-01-24")).toEqual(ok("2025-01-24T00:00:00.000Z"));
		const chisinau = dateConverter({ tz: "Europe/Chisinau" }, "datetime");
		expect(chisinau("2026-03-01")).toEqual(ok("2026-02-28T22:00:00.000Z"));
		expect(chisinau("2026-07-01T10:00")).toEqual(ok("2026-07-01T07:00:00.000Z"));
		expect(chisinau("2026-03-01T10:00:00+05:00")).toEqual(ok("2026-03-01T05:00:00.000Z"));
		expect(chisinau("2026-03-01T10:00:00Z")).toEqual(ok("2026-03-01T10:00:00.000Z"));
		expect(chisinau(" ")).toEqual(ok(null));
		expect(chisinau(null)).toEqual(ok(null));
		expect(chisinau("soon")).toEqual({
			ok: false,
			code: "invalid_date",
			message: '"soon" is not a ISO 8601 date',
		});
		expect(chisinau({ at: "x" })).toEqual(expect.objectContaining({ code: "not_scalar" }));
		expect(chisinau(1700000000)).toEqual(invalid);
	});

	it("reads a Luxon format in the zone", () => {
		const de = dateConverter({ format: "dd/MM/yyyy HH:mm", tz: "Europe/Berlin" }, "datetime");
		expect(de("24/01/2025 13:00")).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(de("31/02/2025 13:00")).toEqual(invalid);
		const offset = dateConverter({ format: "dd/MM/yyyy HH:mm ZZ", tz: "Europe/Berlin" }, null);
		expect(offset("24/01/2025 13:00 +03:00")).toEqual(ok("2025-01-24T10:00:00.000Z"));
	});

	it("reads Unix seconds and milliseconds from numbers and text, fractions included", () => {
		const unix = dateConverter({ format: "unix", tz: "UTC" }, "datetime");
		expect(unix(1737720000)).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(unix("1737720000.25")).toEqual(ok("2025-01-24T12:00:00.250Z"));
		expect(unix(" -86400 ")).toEqual(ok("1969-12-31T00:00:00.000Z"));
		expect(unix("17e8")).toEqual(invalid);
		expect(unix(true)).toEqual(invalid);
		expect(unix(1e15)).toEqual(invalid);
		const ms = dateConverter({ format: "unixMs", tz: "Asia/Tokyo" }, "datetime");
		expect(ms(1737720000123)).toEqual(ok("2025-01-24T12:00:00.123Z"));
		expect(ms("1737720000123.6")).toEqual(ok("2025-01-24T12:00:00.124Z"));
		const day = dateConverter({ format: "unix", tz: "Asia/Tokyo" }, "string");
		expect(day(1737720000 + 15 * 3600)).toEqual(ok("2025-01-25"));
	});

	it("fails a local time in a DST gap and takes the earlier instant in an overlap", () => {
		const ny = dateConverter({ tz: "America/New_York" }, "datetime");
		expect(ny("2026-03-08T02:30")).toEqual({
			ok: false,
			code: "invalid_date",
			message: '"2026-03-08T02:30" does not exist in America/New_York (the clocks skip it)',
		});
		expect(ny("2026-03-08T03:30")).toEqual(ok("2026-03-08T07:30:00.000Z"));
		expect(ny("2026-11-01T01:30")).toEqual(ok("2026-11-01T05:30:00.000Z"));
		expect(ny("2026-11-01T01:30-05:00")).toEqual(ok("2026-11-01T06:30:00.000Z"));
		const md = dateConverter({ format: "yyyy-MM-dd HH:mm", tz: "Europe/Chisinau" }, "datetime");
		// Moldova moves from 03:00 to 04:00 in spring, and from 04:00 back to 03:00 in autumn.
		expect(md("2026-03-29 03:30")).toEqual(invalid);
		expect(md("2026-10-25 03:30")).toEqual(ok("2026-10-25T00:30:00.000Z"));
		expect(md("2026-10-25 04:30")).toEqual(ok("2026-10-25T02:30:00.000Z"));
	});

	it("formats into text fields in the zone, by default as a calendar date", () => {
		const text = dateConverter({ tz: "Europe/Chisinau" }, "text");
		expect(text("2026-03-01T23:30:00Z")).toEqual(ok("2026-03-02"));
		const custom = dateConverter({ tz: "UTC", output: "dd.MM.yyyy HH:mm" }, "string");
		expect(custom("2026-03-01T08:05")).toEqual(ok("01.03.2026 08:05"));
		expect(dateConverter({ tz: "UTC", output: "yyyy" }, "datetime")("2026-03-01")).toEqual(
			ok("2026-03-01T00:00:00.000Z"),
		);
	});

	it("refuses years outside 0000-9999", () => {
		const utc = dateConverter({ tz: "UTC" }, "datetime");
		expect(utc("+010000-01-01")).toEqual(invalid);
		expect(utc("9999-12-31T23:59:59.999")).toEqual(ok("9999-12-31T23:59:59.999Z"));
		expect(dateConverter({ format: "unix", tz: "UTC" }, "datetime")(253402300800)).toEqual(invalid);
	});
});

describe("dateConverter edge cases", () => {
	it("applies an explicit offset or zone in the text once", () => {
		const fixed = dateConverter({ tz: "UTC+2" }, "datetime");
		expect(fixed("2026-01-01T00:00+02:00")).toEqual(ok("2025-12-31T22:00:00.000Z"));
		const named = dateConverter(
			{ format: "yyyy-MM-dd HH:mm z", tz: "America/New_York" },
			"datetime",
		);
		expect(named("2026-11-01 01:30 America/New_York")).toEqual(ok("2026-11-01T05:30:00.000Z"));
	});

	it("takes a date's first instant when midnight falls in a DST gap", () => {
		const cl = dateConverter({ tz: "America/Santiago" }, "datetime");
		expect(cl("2026-09-06")).toEqual(ok("2026-09-06T04:00:00.000Z"));
		expect(cl("2026-09-06T00:30")).toEqual(invalid);
		expect(dateConverter({ tz: "America/Santiago" }, "text")("2026-09-06")).toEqual(
			ok("2026-09-06"),
		);
		const fmt = dateConverter({ format: "dd/MM/yyyy", tz: "America/Havana" }, "datetime");
		expect(fmt("08/03/2026")).toEqual(ok("2026-03-08T05:00:00.000Z"));
	});

	it("refuses time-only ISO text, bad zones, and bare numbers without a unix format", () => {
		const utc = dateConverter({ tz: "UTC" }, "datetime");
		expect(utc("12:00")).toEqual(invalid);
		expect(utc("12:00:00")).toEqual(invalid);
		expect(utc(2025)).toEqual(invalid);
		expect(utc(2025n)).toEqual(invalid);
		expect(utc("2025")).toEqual(ok("2025-01-01T00:00:00.000Z"));
		const bad = dateConverter({ tz: "Mars/X" }, "datetime")("2026-01-01");
		expect(bad).toEqual(expect.objectContaining({ ok: false, code: "invalid_date" }));
		expect((bad as { message: string }).message).toContain("Mars/X");
	});
});

describe("localInstant", () => {
	it("finds the earliest instant showing a wall-clock time, or none in a gap", () => {
		const zone = DateTime.utc().setZone("America/New_York").zone;
		expect(localInstant(Date.UTC(2026, 2, 8, 2, 30), zone)).toBeNull();
		expect(localInstant(Date.UTC(2026, 10, 1, 1, 30), zone)).toBe(Date.UTC(2026, 10, 1, 5, 30));
		expect(localInstant(Date.UTC(2026, 0, 1), zone)).toBe(Date.UTC(2026, 0, 1, 5));
	});
});
