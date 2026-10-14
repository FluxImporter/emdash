import { describe, expect, it } from "vitest";
import {
	type CompiledExpression,
	compileExpression,
	EXPRESSION_LIMITS,
	EXPRESSION_MAX_BYTES,
	type ExpressionLimits,
	PAD_MAX_WIDTH,
} from "../../src/engine/expressions.js";

function compiled(text: string, limits?: Partial<ExpressionLimits>): CompiledExpression {
	const result = compileExpression(text, { ...EXPRESSION_LIMITS, ...limits });
	if (!result.ok) throw new Error(result.problem);
	return result.expression;
}

const evaluate = (text: string, input: unknown = {}, limits?: Partial<ExpressionLimits>) =>
	compiled(text, limits).evaluate(input);

const RUNAWAY = "($f := function($n, $a) { $n > 0 ? $f($n - 1, $a + 1) : $a }; $f(10000000, 0))";

describe("compileExpression", () => {
	it("evaluates against a record: strings, numbers, backtick names, XML keys", async () => {
		expect(await evaluate("first & ' ' & last", { first: "Ada", last: "Lovelace" })).toEqual({
			ok: true,
			value: "Ada Lovelace",
		});
		expect(await evaluate("$round($number(price) * 1.2, 2)", { price: "10.555" })).toEqual({
			ok: true,
			value: 12.67,
		});
		expect(await evaluate("`Unit Price`", { "Unit Price": "3" })).toEqual({ ok: true, value: "3" });
		expect(await evaluate("`@sku` & '/' & `#text`", { "@sku": "A1", "#text": "x" })).toEqual({
			ok: true,
			value: "A1/x",
		});
	});

	it("gives undefined for a missing path and an empty result", async () => {
		expect(await evaluate("nope", { a: 1 })).toEqual({ ok: true, value: undefined });
		expect(await evaluate("items[x > 5]", { items: [{ x: 1 }] })).toEqual({
			ok: true,
			value: undefined,
		});
	});

	it("reports a syntax error with its JSONata code and character position", () => {
		expect(compileExpression("price >")).toEqual({
			ok: false,
			problem: "JSONata S0207 at character 7: Unexpected end of expression",
		});
		expect(compileExpression("$substring(name, 0")).toMatchObject({
			ok: false,
			problem: expect.stringMatching(/^JSONata S0203 at character \d+: /),
		});
	});

	it(`rejects an expression over ${EXPRESSION_MAX_BYTES} UTF-8 bytes`, () => {
		const fits = `'${"a".repeat(EXPRESSION_MAX_BYTES - 2)}'`;
		expect(compileExpression(fits).ok).toBe(true);
		// 2,048 two-byte characters: 4,098 bytes with the quotes, under 4,096 characters.
		const over = `'${"ț".repeat(EXPRESSION_MAX_BYTES / 2)}'`;
		expect(compileExpression(over)).toEqual({
			ok: false,
			problem: `The expression is 4098 bytes; expressions are limited to ${EXPRESSION_MAX_BYTES}`,
		});
	});

	it.each([
		["a direct call", "$now()", "$now"],
		["a call inside a lambda", "$map(items, function($v) { $v & $millis() })", "$millis"],
		["a call in a nested block", "(($x := 1); ($random() > 0.5))", "$random"],
		["a reference passed as a value", "$map([1, 2], $random)", "$random"],
		["a reference bound to a variable", "($t := $now; $t())", "$now"],
		["a call through ~>", "name ~> $now()", "$now"],
		["several at once", "$now() & $millis()", "$millis, $now"],
		["$shuffle", "$shuffle(items)", "$shuffle"],
		["$shuffle with another", "$shuffle(items)[0] & $random()", "$random, $shuffle"],
		["a lambda parameter named after one", "$map(items, function($random) { $random })", "$random"],
		["a variable named after one", "($now := 1; $now + 1)", "$now"],
	])("rejects $now, $millis, $random and $shuffle: %s", (_name, text, names) => {
		expect(compileExpression(text)).toEqual({
			ok: false,
			problem: `${names} cannot be used: expressions must give the same result on every run`,
		});
	});

	it("allows the banned names inside string literals and as field names", async () => {
		expect(await evaluate("'$now() and $random()'")).toEqual({
			ok: true,
			value: "$now() and $random()",
		});
		expect(await evaluate("now & random", { now: "a", random: "b" })).toEqual({
			ok: true,
			value: "ab",
		});
	});

	it.each([
		["a function argument", "$match(name, /a+/)"],
		["a lambda body", "$map(items, function($v) { $contains($v, /x/i) })"],
		["a variable in a block", "($r := /a/; $replace(name, $r, 'b'))"],
		["a predicate", "items[$contains(name, /x/)]"],
		["a call through ~>", "name ~> $split(/,/)"],
		["the whole expression", "/(a+)+$/"],
		["next to a banned function", "$now() & $match(name, /a/)"],
	])("rejects a regular expression in %s", (_name, text) => {
		expect(compileExpression(text)).toEqual({
			ok: false,
			problem: "Regular expressions are not supported in templates",
		});
	});

	it("matches string patterns literally, never as regular expressions", async () => {
		expect(await evaluate("$contains(name, 'a.c')", { name: "abc" })).toEqual({
			ok: true,
			value: false,
		});
		expect(await evaluate("$split(name, '.')", { name: "a.b.c" })).toEqual({
			ok: true,
			value: ["a", "b", "c"],
		});
		expect(await evaluate("$replace(name, '(a+)+$', '-')", { name: "aaaa(a+)+$" })).toEqual({
			ok: true,
			value: "aaaa-",
		});
		expect(await evaluate("'/a+/'")).toEqual({ ok: true, value: "/a+/" });
	});

	it("blocks $eval, called directly or through a variable", async () => {
		for (const text of ["$eval('1 + 1')", "($e := $eval; $e('1'))"]) {
			const result = await evaluate(text);
			expect(result).toEqual({
				ok: false,
				limit: false,
				message: "$eval is not available in templates",
			});
		}
	});

	it("reports a data error with its JSONata code, not as a limit", async () => {
		expect(await evaluate("price > 0", { price: "3" })).toEqual({
			ok: false,
			limit: false,
			message:
				'JSONata T2009 at character 7: The values "3" and 0 either side of operator ">" must be of the same data type',
		});
	});

	it("stops a runaway expression at the step limit", async () => {
		const result = await evaluate(RUNAWAY, {}, { timeoutMs: 60_000 });
		expect(result).toEqual({
			ok: false,
			limit: true,
			message: `Expression exceeded ${EXPRESSION_LIMITS.steps} evaluation steps`,
		});
	});

	// Each of these ran for seconds to minutes inside a handful of steps before results were
	// weighted. No time limit here: on Workers the clock does not advance, so the count alone
	// must end them, and the 5 s test timeout fails the test if it does not.
	it.each([
		[
			"a built-in sum over a range, in a loop",
			"$sum($map([1..200], function($i){ $sum([1..100000]) }))",
		],
		[
			"a built-in map over a range, in a loop",
			"$sum($map([1..20], function($i){ $count($map([1..100000], $string)) }))",
		],
		[
			"a padded string, in a loop",
			`$sum($map([1..20000], function($i){ $length($pad('', ${PAD_MAX_WIDTH})) }))`,
		],
		["a long string read over and over", "$sum($map([1..1000], function($i){ $length(s) }))"],
	])("stops %s at the step limit, without a clock", { timeout: 5000 }, async (_name, text) => {
		const input = { s: "x".repeat(1024 * 1024) };
		expect(await evaluate(text, input, { timeoutMs: 1_000_000_000 })).toEqual({
			ok: false,
			limit: true,
			message: `Expression exceeded ${EXPRESSION_LIMITS.steps} evaluation steps`,
		});
	});

	it("charges an array result by its length and a string result by its KiB", async () => {
		// A range is charged twice: once as the range, once as the array constructor around it.
		expect(await evaluate("$count([1..40000])")).toEqual({ ok: true, value: 40000 });
		expect(await evaluate("$count([1..50000])")).toEqual({
			ok: false,
			limit: true,
			message: `Expression exceeded ${EXPRESSION_LIMITS.steps} evaluation steps`,
		});
		// A 64 KiB string read from the record: 64 for the string, plus a few steps.
		const kib = { s: "x".repeat(64 * 1024) };
		expect(await evaluate("$length(s)", kib, { steps: 100 })).toEqual({ ok: true, value: 65536 });
		expect(await evaluate("$length(s)", kib, { steps: 60 })).toMatchObject({
			ok: false,
			limit: true,
		});
	});

	it(`caps $pad at ${PAD_MAX_WIDTH} characters, either way`, async () => {
		expect(await evaluate(`$length($pad('a', ${PAD_MAX_WIDTH}))`)).toEqual({
			ok: true,
			value: PAD_MAX_WIDTH,
		});
		expect(await evaluate(`$pad('7', -3, '0')`)).toEqual({ ok: true, value: "007" });
		for (const width of [PAD_MAX_WIDTH + 1, -(PAD_MAX_WIDTH + 1), 10_000_000]) {
			expect(await evaluate(`$pad('a', ${width})`)).toEqual({
				ok: false,
				limit: false,
				message: `$pad width is limited to ${PAD_MAX_WIDTH} characters`,
			});
		}
		// A width read from the record is checked the same way.
		expect(await evaluate("$pad(name, w)", { name: "a", w: 20_000 })).toMatchObject({
			ok: false,
			limit: false,
		});
	});

	it("pads with a long fill string exactly as JSONata does, without repeating all of it", async () => {
		const fill = "ab".repeat(500_000);
		expect(await evaluate("$pad('x', 5, fill)", { fill })).toEqual({ ok: true, value: "xabab" });
		expect(await evaluate("$pad('x', -5, '😀é')")).toEqual({ ok: true, value: "😀é😀éx" });
		expect(await evaluate("$pad(name, 4)", { name: "ab" })).toEqual({ ok: true, value: "ab  " });
		expect(await evaluate("name ~> $pad(3)", { name: "ab" })).toEqual({ ok: true, value: "ab " });
	});

	it("reads an ISO 8601 timestamp with $toMillis", async () => {
		expect(await evaluate("$toMillis('2024-01-01T10:00:00Z')")).toEqual({
			ok: true,
			value: 1704103200000,
		});
		expect(await evaluate("$toMillis(d)", { d: "2024-01-01T10:00:00.250+02:00" })).toEqual({
			ok: true,
			value: 1704096000250,
		});
		expect(await evaluate("d.$toMillis()", { d: "2024-01-01T00:00:00Z" })).toEqual({
			ok: true,
			value: 1704067200000,
		});
		expect(await evaluate("$toMillis(nope)")).toEqual({ ok: true, value: undefined });
		expect(await evaluate("$toMillis('soon')")).toMatchObject({
			ok: false,
			limit: false,
			message: expect.stringMatching(/^JSONata D3110 /),
		});
	});

	// JSONata turns a picture into a regular expression and runs it on the value: sixteen `[f]`
	// on this 38-character value backtracked for 107 s in about 6 steps.
	const PICTURE_PROBLEM =
		"$toMillis with a picture is not available in templates; use the date field's format option";
	const SLOW_VALUE = `${"1".repeat(37)}x`;
	const SLOW_PICTURE = "[f]".repeat(16);

	it("rejects $toMillis with a picture written in the expression", { timeout: 5000 }, async () => {
		expect(await evaluate(`$toMillis(v, '${SLOW_PICTURE}')`, { v: SLOW_VALUE })).toEqual({
			ok: false,
			limit: false,
			message: PICTURE_PROBLEM,
		});
		expect(await evaluate("$toMillis('2024-01-01', '[Y]-[M]-[D]')")).toEqual({
			ok: false,
			limit: false,
			message: PICTURE_PROBLEM,
		});
	});

	it("rejects $toMillis with a picture taken from the record", { timeout: 5000 }, async () => {
		const record = { v: SLOW_VALUE, fmt: SLOW_PICTURE };
		for (const text of [
			"$toMillis(v, fmt)",
			"($t := $toMillis; $t(v, fmt))",
			"v ~> $toMillis(fmt)",
		]) {
			expect(await evaluate(text, record)).toEqual({
				ok: false,
				limit: false,
				message: PICTURE_PROBLEM,
			});
		}
	});

	it("counts steps per evaluation, so one handle evaluates many records", async () => {
		const sum = compiled("$sum($map([1..1000], function($v) { $v }))", { steps: 5000 });
		for (let i = 0; i < 20; i++) {
			expect(await sum.evaluate({})).toEqual({ ok: true, value: 500500 });
		}
	});

	it("stops at the time limit (D1012)", async () => {
		const result = await evaluate(RUNAWAY, {}, { steps: Number.POSITIVE_INFINITY, timeoutMs: 5 });
		expect(result).toMatchObject({
			ok: false,
			limit: true,
			message: expect.stringMatching(/^JSONata D1012 at character \d+: Evaluation timeout/),
		});
	});

	it("stops at the depth limit (D1011)", async () => {
		const deep = "($f := function($n) { $n > 0 ? 1 + $f($n - 1) : 0 }; $f(1000))";
		expect(await evaluate(deep)).toMatchObject({
			ok: false,
			limit: true,
			message: expect.stringMatching(/^JSONata D1011 at character \d+: Stack overflow/),
		});
		const shallow = "($f := function($n) { $n > 0 ? 1 + $f($n - 1) : 0 }; $f(20))";
		expect(await evaluate(shallow)).toEqual({ ok: true, value: 20 });
	});

	it("stops at the sequence limit (D2015)", async () => {
		expect(await evaluate("$count([1..200000])")).toMatchObject({
			ok: false,
			limit: true,
			message: expect.stringMatching(/^JSONata D2015 at character \d+: /),
		});
	});
});
