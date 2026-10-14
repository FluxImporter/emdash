import { describe, expect, it } from "vitest";
import {
	type CompiledExpression,
	compileExpression,
	EXPRESSION_LIMITS,
	EXPRESSION_MAX_BYTES,
	type ExpressionLimits,
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
	])("rejects $now, $millis and $random: %s", (_name, text, names) => {
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
