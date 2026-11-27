import { describe, expect, it } from "vitest";
import {
	booleanConverter,
	checkRules,
	jsonConverter,
	MAX_JSON_BYTES,
	multiSelectConverter,
	numberConverter,
	selectConverter,
	type TargetField,
} from "../../src/engine/values.js";

const ok = (value: unknown) => ({ ok: true, value });
const err = (code: string) => expect.objectContaining({ ok: false, code });

describe("numberConverter", () => {
	const plain = numberConverter({});
	const eu = numberConverter({ decimal: ",", thousands: "." });
	const spaced = numberConverter({ decimal: ",", thousands: " " });
	const us = numberConverter({ thousands: "," });

	it("keeps JSON numbers and the M2 grammar for text", () => {
		expect(plain(12.5)).toEqual(ok(12.5));
		expect(plain(" 7 ")).toEqual(ok(7));
		expect(plain("1e3")).toEqual(ok(1000));
		expect(plain("")).toEqual(ok(null));
		expect(plain(null)).toEqual(ok(null));
		expect(plain(undefined)).toEqual(ok(null));
		for (const bad of ["1,234", "0x10", "Infinity", "1e999", true, Number.NaN]) {
			expect(plain(bad)).toEqual(err("invalid_number"));
		}
		expect(plain([1])).toEqual(err("not_scalar"));
	});

	it("reads thousands separators that group the integer part in threes", () => {
		expect(eu("1.234.567,5")).toEqual(ok(1234567.5));
		expect(eu("-1.234")).toEqual(ok(-1234));
		expect(eu("12,5")).toEqual(ok(12.5));
		expect(eu("999")).toEqual(ok(999));
		expect(us("1,234,567.25")).toEqual(ok(1234567.25));
		expect(us("1,234e2")).toEqual(ok(123400));
		expect(spaced("1 234,5")).toEqual(ok(1234.5));
		expect(spaced("1 234 567,5")).toEqual(ok(1234567.5));
		expect(spaced("1 234,5")).toEqual(ok(1234.5));
		expect(spaced("1 234")).toEqual(ok(1234));
		expect(numberConverter({ thousands: "'" })("1'000'000")).toEqual(ok(1000000));
		expect(numberConverter({ thousands: "_" })("1_000")).toEqual(ok(1000));
		for (const bad of ["1.23", "12.34.567", "1.234.56", "1.5", ".234", "1..234", "1.234,5,6"]) {
			expect(eu(bad)).toEqual(err("invalid_number"));
		}
		for (const bad of ["1,23", "12,3456", "1,234.5.6"]) {
			expect(us(bad)).toEqual(err("invalid_number"));
		}
	});

	it("reads a decimal comma and refuses a point then", () => {
		const comma = numberConverter({ decimal: "," });
		expect(comma("3,25")).toEqual(ok(3.25));
		expect(comma("3.25")).toEqual(err("invalid_number"));
		expect(comma("1.234,5")).toEqual(err("invalid_number"));
	});
});

describe("booleanConverter", () => {
	const yesNo = booleanConverter({});

	it("reads JSON booleans, JSON 1 and 0, and the default tokens in any case", () => {
		expect(yesNo(true)).toEqual(ok(true));
		expect(yesNo(false)).toEqual(ok(false));
		expect(yesNo(1)).toEqual(ok(true));
		expect(yesNo(0)).toEqual(ok(false));
		for (const t of ["true", "YES", " y ", "1", "On"]) expect(yesNo(t)).toEqual(ok(true));
		for (const t of ["False", "no", "N", "0", "OFF"]) expect(yesNo(t)).toEqual(ok(false));
		expect(yesNo(" ")).toEqual(ok(null));
		expect(yesNo(null)).toEqual(ok(null));
	});

	it("lists the accepted tokens when a value is not a boolean", () => {
		expect(yesNo("maybe")).toEqual({
			ok: false,
			code: "invalid_boolean",
			message:
				'"maybe" is not a boolean; expected one of true, yes, y, 1, on, false, no, n, 0, off',
		});
		expect(yesNo(2)).toEqual(err("invalid_boolean"));
		expect(yesNo({ a: 1 })).toEqual(err("not_scalar"));
	});

	it("replaces a default list with the mapping's own", () => {
		const german = booleanConverter({ true: ["Ja"], false: ["Nein"] });
		expect(german("ja")).toEqual(ok(true));
		expect(german(" NEIN ")).toEqual(ok(false));
		expect(german("yes")).toEqual(err("invalid_boolean"));
		expect(german(true)).toEqual(ok(true));
		const onlyTrue = booleanConverter({ true: ["x"] });
		expect(onlyTrue("X")).toEqual(ok(true));
		expect(onlyTrue("no")).toEqual(ok(false));
		expect(onlyTrue("yes")).toEqual(err("invalid_boolean"));
	});
});

describe("selectConverter", () => {
	const options = ["draft", "published", "Archived"];

	it("matches options exactly, then ignoring case, and stores the option as defined", () => {
		const select = selectConverter({}, options);
		expect(select("draft")).toEqual(ok("draft"));
		expect(select(" PUBLISHED ")).toEqual(ok("published"));
		expect(select("archived")).toEqual(ok("Archived"));
		expect(select("")).toEqual(ok(null));
		expect(select({})).toEqual(err("not_scalar"));
		expect(select("gone")).toEqual({
			ok: false,
			code: "invalid_option",
			message: '"gone" is not an option; the options are draft, published, Archived',
		});
	});

	it("maps source values first, exactly and then ignoring case", () => {
		const select = selectConverter({ map: { Live: "published", Hidden: "draft" } }, options);
		expect(select("Live")).toEqual(ok("published"));
		expect(select("live")).toEqual(ok("published"));
		expect(select("hidden")).toEqual(ok("draft"));
		expect(select("draft")).toEqual(ok("draft"));
	});

	it("lets the first map key in template order win a case-insensitive match", () => {
		const select = selectConverter({ map: { live: "x", Live: "published" } }, ["x", "published"]);
		expect(select("LIVE")).toEqual(ok("x"));
		expect(select("Live")).toEqual(ok("published"));
	});

	it("matches exactly only with ignoreCase off", () => {
		const select = selectConverter({ ignoreCase: false, map: { Live: "published" } }, options);
		expect(select("Live")).toEqual(ok("published"));
		expect(select("live")).toEqual(err("invalid_option"));
		expect(select("Draft")).toEqual(err("invalid_option"));
		expect(select("draft")).toEqual(ok("draft"));
	});

	it("refuses a spelling that matches two options ignoring case", () => {
		const select = selectConverter({}, ["red", "Red", "blue"]);
		expect(select("Red")).toEqual(ok("Red"));
		expect(select("RED")).toEqual(err("invalid_option"));
		expect(select("BLUE")).toEqual(ok("blue"));
	});

	it("accepts any text for a select without options, after the map", () => {
		const free = selectConverter({ map: { a: "Alpha" } }, undefined);
		expect(free(" anything ")).toEqual(ok("anything"));
		expect(free(42)).toEqual(ok("42"));
		expect(free("A")).toEqual(ok("Alpha"));
		expect(selectConverter({}, [])("x")).toEqual(ok("x"));
	});

	it("lists at most 20 options in the message", () => {
		const many = Array.from({ length: 25 }, (_, i) => `o${i}`);
		const result = selectConverter({}, many)("x");
		expect(result).toMatchObject({ ok: false, code: "invalid_option" });
		expect(!result.ok && result.message).toBe(
			`"x" is not an option; the options are ${many.slice(0, 20).join(", ")}, … (25 in all)`,
		);
	});
});

describe("multiSelectConverter", () => {
	const options = ["red", "green", "blue"];
	const multi = multiSelectConverter({}, options);

	it("splits text on the separator, trims, drops empty items and duplicates", () => {
		expect(multi("red, GREEN,,red , ")).toEqual(ok(["red", "green"]));
		expect(multiSelectConverter({ separator: "|" }, options)("blue|red")).toEqual(
			ok(["blue", "red"]),
		);
		expect(multiSelectConverter({ separator: " / " }, options)("red / blue")).toEqual(
			ok(["red", "blue"]),
		);
		expect(multi(" , ")).toEqual(ok(null));
		expect(multi("")).toEqual(ok(null));
	});

	it("takes arrays of scalars, ignoring the separator", () => {
		expect(multi(["Blue", "red", null, " "])).toEqual(ok(["blue", "red"]));
		expect(multi([])).toEqual(ok(null));
		expect(multiSelectConverter({}, undefined)([1, true, "a,b"])).toEqual(ok(["1", "true", "a,b"]));
		expect(multi(["red", { x: 1 }])).toEqual(err("not_scalar"));
		expect(multi([["red"]])).toEqual(err("not_scalar"));
		expect(multi({ red: true })).toEqual(err("not_scalar"));
	});

	it("names every bad item in one error", () => {
		expect(multi("red, pink, cyan, pink")).toEqual({
			ok: false,
			code: "invalid_option",
			message: '"pink", "cyan" are not options; the options are red, green, blue',
		});
	});

	it("maps items and refuses more than 1,000", () => {
		const mapped = multiSelectConverter({ map: { rot: "red", grün: "green" } }, options);
		expect(mapped("Rot|grün")).toEqual(err("invalid_option"));
		expect(mapped("Rot,grün")).toEqual(ok(["red", "green"]));
		const free = multiSelectConverter({}, undefined);
		expect(free(Array.from({ length: 1000 }, (_, i) => `t${i}`))).toMatchObject({ ok: true });
		expect(free(Array.from({ length: 1001 }, (_, i) => `t${i}`))).toEqual(err("too_many_items"));
	});
});

describe("jsonConverter", () => {
	const json = jsonConverter({});
	const raw = jsonConverter({ parse: false });

	it("keeps objects, arrays, numbers and booleans, and parses text", () => {
		expect(json({ b: [1, { c: null }] })).toEqual(ok({ b: [1, { c: null }] }));
		expect(json([1, "a"])).toEqual(ok([1, "a"]));
		expect(json(4.5)).toEqual(ok(4.5));
		expect(json(false)).toEqual(ok(false));
		expect(json("[1,2]")).toEqual(ok([1, 2]));
		expect(json(' {"a": true} ')).toEqual(ok({ a: true }));
		expect(json('"x"')).toEqual(ok("x"));
		expect(json("12")).toEqual(ok(12));
		expect(json("null")).toEqual(ok(null));
		expect(json("  ")).toEqual(ok(null));
		expect(json(null)).toEqual(ok(null));
		expect(json("{oops")).toEqual(err("invalid_json"));
		expect(json("'single'")).toEqual(err("invalid_json"));
	});

	it("keeps text as a string with parse off, unless EmDash would read it back as JSON", () => {
		expect(raw("plain text")).toEqual(ok("plain text"));
		expect(raw(" [not parsed")).toEqual(ok(" [not parsed"));
		expect(raw("[1,2]")).toEqual(err("invalid_json"));
		expect(raw("{x")).toEqual(err("invalid_json"));
		expect(json('"[1]"')).toEqual(err("invalid_json"));
		expect(raw({ a: 1 })).toEqual(ok({ a: 1 }));
	});

	it("refuses strings SQLite would store as numbers in a JSON column", () => {
		for (const text of ["007", " 42 ", "-1.5", "1e3", ".5"]) {
			expect(raw(text)).toEqual(err("invalid_json"));
			expect(json(JSON.stringify(text))).toEqual(err("invalid_json"));
		}
		expect(raw("0x10")).toEqual(ok("0x10"));
		expect(raw("12 apples")).toEqual(ok("12 apples"));
		expect(json("7")).toEqual(ok(7));
	});

	it("refuses numbers that overflow to Infinity", () => {
		for (const text of ["1e999", '{"a":1e999}', "[-1e400]"]) {
			expect(json(text)).toEqual(err("invalid_json"));
		}
	});

	it("refuses values nested too deeply", () => {
		const deep = "[".repeat(10000) + "]".repeat(10000);
		expect(json(deep)).toEqual(err("invalid_json"));
		let nested: unknown[] = [];
		for (let i = 0; i < 10000; i++) nested = [nested];
		expect(json(nested)).toEqual({
			ok: false,
			code: "invalid_json",
			message: "The JSON value is nested too deeply",
		});
	});

	it("refuses values over 1 MiB", () => {
		const big = "x".repeat(MAX_JSON_BYTES);
		expect(raw(big)).toEqual(err("value_too_large"));
		expect(raw(big.slice(2))).toMatchObject({ ok: true });
		expect(json({ s: big })).toEqual(err("value_too_large"));
	});
});

describe("checkRules on a select without options", () => {
	it("applies the text rules, and not when the select has options", () => {
		const free = { type: "select", required: false, maxLength: 3, pattern: "^a" };
		expect(checkRules("bcde", free).map((e) => e.code)).toEqual(["too_long", "pattern_mismatch"]);
		expect(checkRules("bcde", { ...free, options: ["bcde"] })).toEqual([]);
	});
});

describe("checkRules", () => {
	const target = (t: Partial<TargetField>): TargetField => ({
		type: "string",
		required: false,
		...t,
	});
	const codes = (value: unknown, t: Partial<TargetField>) =>
		checkRules(value, target(t)).map((e) => e.code);

	it("requires a value for required fields", () => {
		expect(checkRules(null, target({ required: true }))).toEqual([
			{ code: "required", message: "The field is required" },
		]);
		expect(codes(null, {})).toEqual([]);
		expect(codes("", { required: true })).toEqual([]);
		expect(codes(false, { type: "boolean", required: true })).toEqual([]);
	});

	it("checks whole numbers and ranges", () => {
		expect(codes(3, { type: "integer" })).toEqual([]);
		expect(codes(3.5, { type: "integer" })).toEqual(["invalid_integer"]);
		expect(codes(2 ** 53, { type: "integer" })).toEqual(["invalid_integer"]);
		expect(codes(-(2 ** 53 - 1), { type: "integer" })).toEqual([]);
		expect(codes(3.5, { type: "number" })).toEqual([]);
		expect(codes(-1, { type: "number", min: 0, max: 10 })).toEqual(["out_of_range"]);
		expect(codes(11, { type: "integer", min: 0, max: 10 })).toEqual(["out_of_range"]);
		expect(codes(10, { type: "number", min: 0, max: 10 })).toEqual([]);
		expect(checkRules(0.5, target({ type: "integer", min: 1 }))).toEqual([
			{ code: "invalid_integer", message: "0.5 is not a whole number" },
			{ code: "out_of_range", message: "0.5 is less than the minimum 1" },
		]);
	});

	it("checks lengths in UTF-16 code units and patterns without flags", () => {
		expect(codes("ab", { minLength: 3 })).toEqual(["too_short"]);
		expect(codes("abcd", { type: "text", maxLength: 3 })).toEqual(["too_long"]);
		expect(codes("😀😀", { type: "slug", maxLength: 3 })).toEqual(["too_long"]);
		expect(codes("abc", { type: "url", minLength: 3, maxLength: 3 })).toEqual([]);
		expect(codes("abc", { pattern: "^[A-Z]+$" })).toEqual(["pattern_mismatch"]);
		expect(codes("ABC", { pattern: "^[A-Z]+$" })).toEqual([]);
		expect(codes("a", { minLength: 2, pattern: "^\\d+$" })).toEqual([
			"too_short",
			"pattern_mismatch",
		]);
	});

	it("ignores a pattern that does not compile, and rules for other types", () => {
		expect(codes("abc", { pattern: "([" })).toEqual([]);
		expect(
			codes("abc", { type: "select", options: ["abc"], maxLength: 1, pattern: "^x$" }),
		).toEqual([]);
		expect(codes(["a"], { type: "multiSelect", min: 3 })).toEqual([]);
	});
});
