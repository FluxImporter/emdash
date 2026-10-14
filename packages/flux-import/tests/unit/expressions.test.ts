import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import {
	ALLOWED_FUNCTIONS,
	type CompiledExpression,
	compileExpression,
	type Evaluation,
	EXPRESSION_LIMITS,
	EXPRESSION_MAX_BYTES,
	type ExpressionLimits,
	JSONATA_FUNCTIONS,
	PAD_MAX_WIDTH,
	PICTURE_MAX_LENGTH,
	PICTURE_MAX_WIDTH,
} from "../../src/engine/expressions.js";

function compiled(text: string, limits?: Partial<ExpressionLimits>): CompiledExpression {
	const result = compileExpression(text, { ...EXPRESSION_LIMITS, ...limits });
	if (!result.ok) throw new Error(result.problem);
	return result.expression;
}

const evaluate = (text: string, input: unknown = {}, limits?: Partial<ExpressionLimits>) =>
	compiled(text, limits).evaluate(input);

/** A result with JSONata's sequence arrays copied to plain arrays, which drop its flags. */
function plain(result: Evaluation): Evaluation {
	return result.ok && Array.isArray(result.value)
		? { ...result, value: [...result.value] }
		: result;
}

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

	it("rejects $eval, called directly or through a variable", () => {
		for (const text of ["$eval('1 + 1')", "($e := $eval; $e('1'))"]) {
			expect(compileExpression(text)).toEqual({
				ok: false,
				problem: "$eval is not available in templates",
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
			"$sum($map([1..20], function($i){ $count($map([1..100000], function($v){ $string($v) })) }))",
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

	it("charges an array result by its length and a string result by its size", async () => {
		// A range is charged twice: once as the range, once as the array constructor around it.
		expect(await evaluate("$count([1..40000])")).toEqual({ ok: true, value: 40000 });
		expect(await evaluate("$count([1..50000])")).toEqual({
			ok: false,
			limit: true,
			message: `Expression exceeded ${EXPRESSION_LIMITS.steps} evaluation steps`,
		});
		// A 64 KiB string read from the record: 256 (one per 256 characters) for the name, about as
		// much for the path holding it, plus a few steps.
		const kib = { s: "x".repeat(64 * 1024) };
		expect(await evaluate("$length(s)", kib, { steps: 530 })).toEqual({ ok: true, value: 65536 });
		expect(await evaluate("$length(s)", kib, { steps: 500 })).toMatchObject({
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
		for (const text of ["$toMillis(v, fmt)", "v ~> $toMillis(fmt)"]) {
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

	describe("built-in functions", () => {
		const LIMIT = {
			ok: false,
			limit: true,
			message: `Expression exceeded ${EXPRESSION_LIMITS.steps} evaluation steps`,
		};

		it("knows every built-in JSONata defines", () => {
			const source = readFileSync(createRequire(import.meta.url).resolve("jsonata"), "utf8");
			const bound = [...source.matchAll(/staticFrame\.bind\('(\w+)'/g)].map((m) => m[1]);
			expect(bound.length).toBeGreaterThan(60);
			// `$now` and `$millis` are bound by each expression, not in the static frame.
			expect(new Set([...bound, "now", "millis"])).toEqual(JSONATA_FUNCTIONS);
		});

		const record = {
			s: "Hello, World",
			n: 3.7,
			xs: [3, 1, 2],
			words: ["a", "b"],
			o: { a: 1, b: 2 },
			d: "2024-01-01T00:00:00Z",
			u: "a b&c",
		};
		const ALLOWED_CASES: [string, unknown][] = [
			["$string(o)", '{"a":1,"b":2}'],
			["$substring(s, -5, 3)", "Wor"],
			["$substringBefore(s, ',')", "Hello"],
			["$substringAfter(s, ', ')", "World"],
			["$lowercase(s)", "hello, world"],
			["$uppercase(s)", "HELLO, WORLD"],
			["$length(s)", 12],
			["$trim('  a \n b ')", "a b"],
			["$pad('7', -3, '0')", "007"],
			["$contains(s, 'World')", true],
			["$replace(s, 'l', 'L', 2)", "HeLLo, World"],
			["$split(s, ', ')", ["Hello", "World"]],
			["$join(words, '-')", "a-b"],
			["$encodeUrlComponent(u)", "a%20b%26c"],
			["$encodeUrl('https://x.test/a b')", "https://x.test/a%20b"],
			["$decodeUrlComponent('a%20b%26c')", "a b&c"],
			["$decodeUrl('https://x.test/a%20b')", "https://x.test/a b"],
			["$number('4.5')", 4.5],
			["$floor(n)", 3],
			["$ceil(n)", 4],
			["$round(n)", 4],
			["$abs(-2)", 2],
			["$sqrt(16)", 4],
			["$power(2, 10)", 1024],
			["$formatBase(255, 16)", "ff"],
			["$sum(xs)", 6],
			["$max(xs)", 3],
			["$min(xs)", 1],
			["$average(xs)", 2],
			["$boolean(s)", true],
			["$not(true)", false],
			["$exists(nope)", false],
			["$type(o)", "object"],
			["$count(xs)", 3],
			["$map(xs, function($v) { $v * 2 })", [6, 2, 4]],
			["$filter(xs, function($v) { $v > 1 })", [3, 2]],
			["$single(xs, function($v) { $v = 1 })", 1],
			["$reduce(xs, function($a, $v) { $a + $v })", 6],
			["$append(xs, 4)", [3, 1, 2, 4]],
			["$reverse(xs)", [2, 1, 3]],
			["$lookup(o, 'b')", 2],
			["$keys(o)", ["a", "b"]],
			["$toMillis(d)", 1704067200000],
			["$fromMillis(0, '[Y0001]-[M01]-[D01]')", "1970-01-01"],
		];

		it("covers each allowed built-in below", () => {
			const called = ALLOWED_CASES.map(([text]) => /^\$(\w+)\(/.exec(text)?.[1]);
			expect(new Set(called)).toEqual(ALLOWED_FUNCTIONS);
		});

		it.each(ALLOWED_CASES)("allows %s", async (text, value) => {
			expect(plain(await evaluate(text, record))).toEqual({ ok: true, value });
		});

		const DENIED = [...JSONATA_FUNCTIONS].filter(
			(name) =>
				!ALLOWED_FUNCTIONS.has(name) && !["now", "millis", "random", "shuffle"].includes(name),
		);

		it.each(DENIED)("rejects $%s", (name) => {
			expect(compileExpression(`$${name}(xs)`)).toEqual({
				ok: false,
				problem: `$${name} is not available in templates`,
			});
		});

		it.each([
			["a reference passed as a value", "$map(xs, $clone)", "$clone is"],
			["a partial application", "$merge(?)", "$merge is"],
			["the right of ~>", "xs ~> $sort", "$sort is"],
			["a variable bound to one", "($d := $distinct; $d(xs))", "$distinct is"],
			["a lambda parameter named after one", "function($eval) { 1 }", "$eval is"],
			["several", "$sort(xs) & $distinct(xs) & $sort(xs)", "$distinct, $sort are"],
		])("rejects an unavailable built-in in %s", (_name, text, names) => {
			expect(compileExpression(text)).toEqual({
				ok: false,
				problem: `${names} not available in templates`,
			});
		});

		it.each([
			["passed to $map", "$map(xs, $string)", "$string"],
			["partially applied", "$map([1, 2], $substring(s, ?))", "$substring"],
			["named on the right of ~>", "s ~> $trim", "$trim"],
			["bound to a variable", "($f := $length; $f(s))", "$length"],
			["used as a parameter name", "$map(xs, function($length) { $length })", "$length"],
			["assigned", "($string := 1; $string)", "$string"],
			["several", "$map(xs, $string) & $map(xs, $abs)", "$abs, $string"],
		])("requires an allowed built-in to be called directly, not %s", (_name, text, names) => {
			expect(compileExpression(text)).toEqual({
				ok: false,
				problem: `${names} can only be called directly in templates: built-in functions cannot be passed as values, bound to variables or partially applied`,
			});
		});

		it("allows direct calls in every form, and the template's own variables and lambdas", async () => {
			expect(await evaluate("s ~> $substring(7)", record)).toEqual({ ok: true, value: "World" });
			expect(plain(await evaluate("words.$uppercase()", record))).toEqual({
				ok: true,
				value: ["A", "B"],
			});
			expect(
				plain(await evaluate("($double := function($v) { $v * 2 }; $map(xs, $double))", record)),
			).toEqual({ ok: true, value: [6, 2, 4] });
			expect(
				plain(
					await evaluate("($f := function($a, $b) { $a & $b }; $map(words, $f('-', ?)))", record),
				),
			).toEqual({ ok: true, value: ["-a", "-b"] });
			expect(
				await evaluate("($t := $trim(s); $c := function() { $count(xs) }; $t & $c())", record),
			).toEqual({ ok: true, value: "Hello, World3" });
		});

		it("rejects the transform operator and the wildcards", () => {
			expect(compileExpression("$ ~> |o|{'c': 3}|")).toEqual({
				ok: false,
				problem: "The transform operator |...| is not supported in templates",
			});
			for (const text of ["*", "o.*", "$count(**)"]) {
				expect(compileExpression(text)).toEqual({
					ok: false,
					problem: "The wildcards * and ** are not supported in templates; name the fields",
				});
			}
			// Multiplication is not a wildcard.
			expect(compileExpression("n * 2").ok).toBe(true);
		});

		// Without a clock, as on Workers: the count alone must end these, and the 5 s test timeout
		// fails the test if it does not.
		const items = Array.from({ length: 50_000 }, (_, i) => ({ n: i, name: `item ${i}` }));
		it.each([
			["the whole record, read in a loop", "$count($map([1..1000], function($i) { $ }))"],
			[
				"a deep comparison, in a loop",
				"($c := items; $count($map([1..1000], function($i) { items = $c })))",
			],
			[
				"the keys of every item, in a loop",
				"$count($map([1..1000], function($i) { $keys(items) }))",
			],
			["a string of the record, in a loop", "$count($map([1..1000], function($i) { $string($) }))"],
		])("stops %s at the step limit, without a clock", { timeout: 5000 }, async (_name, text) => {
			expect(await evaluate(text, { items }, { timeoutMs: 1_000_000_000 })).toEqual(LIMIT);
		});

		it.each([
			["a built-in reading it", "$count($map([1..30000], function($v) { $keys() }))"],
			["a field name looked up on it", "$count($map([1..30000], function($v) { nope }))"],
		])(
			"charges a record that is an array for %s, in a loop",
			{ timeout: 5000 },
			async (_name, text) => {
				expect(await evaluate(text, items, { timeoutMs: 1_000_000_000 })).toEqual(LIMIT);
			},
		);

		it("charges an object result by its size", async () => {
			// About 64 KiB of object, read once: well within 100,000 steps, but not within 200.
			const wide = { o: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i])) };
			expect(await evaluate("$count($keys(o))", wide)).toEqual({ ok: true, value: 4000 });
			expect(await evaluate("$type(o)", wide, { steps: 200 })).toMatchObject({
				ok: false,
				limit: true,
			});
		});

		const raw = (text: string, input: unknown) => jsonata(text).evaluate(input);
		const STRINGS = ["", "abc", "a😀b😀c", "\ud800x\udc00", "héllo wörld"];

		it("counts $length in code points exactly as JSONata does", async () => {
			for (const s of STRINGS) {
				expect(await evaluate("$length(s)", { s })).toEqual({
					ok: true,
					value: await raw("$length(s)", { s }),
				});
			}
		});

		it("takes $substring exactly as JSONata does, negative and fractional bounds included", async () => {
			for (const s of STRINGS) {
				for (const start of [-10, -3, -1, -2.5, 0, 1, 2, 2.5, 10]) {
					for (const count of [undefined, -1, 0, 1, 2, 2.7, 10]) {
						const text =
							count === undefined ? `$substring(s, ${start})` : `$substring(s, ${start}, ${count})`;
						expect([text, s, await evaluate(text, { s })]).toEqual([
							text,
							s,
							{ ok: true, value: await raw(text, { s }) },
						]);
					}
				}
			}
		});

		it("reads a 4 MiB string's $length and $substring without a per-character array", async () => {
			const s = `${"é".repeat(4 * 1024 * 1024 - 1)}😀`;
			const started = performance.now();
			expect(await evaluate("$length(s)", { s })).toEqual({ ok: true, value: 4 * 1024 * 1024 });
			expect(await evaluate("$substring(s, -2)", { s })).toEqual({ ok: true, value: "é😀" });
			expect(await evaluate("$substring(s, 3, 2)", { s })).toEqual({ ok: true, value: "éé" });
			// JSONata's own versions build an array of 4 million one-character strings each time.
			expect(performance.now() - started).toBeLessThan(1000);
		});

		it("refuses $string with indentation", async () => {
			expect(await evaluate("$string(o, true)", record)).toEqual({
				ok: false,
				limit: false,
				message: "$string with indentation is not available in templates",
			});
			expect(await evaluate("$string(o, false)", record)).toEqual({
				ok: true,
				value: '{"a":1,"b":2}',
			});
		});

		it("replaces and splits exactly as JSONata does with string patterns", async () => {
			const s = "a.b.c$";
			for (const text of [
				"$replace(s, '.', '$0')",
				"$replace(s, '.', '-', 1)",
				"$replace(s, '.', '-', 1.5)",
				"$replace(s, '.', '-', 0)",
				"$replace(s, 'x', '-')",
				"$replace(s, '$', '$$')",
				"$split(s, '.')",
				"$split(s, '.', 2)",
				"$split(s, '')",
				"$join(['a', 'b'])",
			]) {
				expect([text, await evaluate(text, { s })]).toEqual([
					text,
					{ ok: true, value: await raw(text, { s }) },
				]);
			}
			for (const [text, code] of [
				["$replace(s, '', '-')", "D3010"],
				["$replace(s, '.', '-', -1)", "D3011"],
				["$split(s, '.', -1)", "D3020"],
			] as const) {
				expect(await evaluate(text, { s })).toMatchObject({
					ok: false,
					limit: false,
					message: expect.stringContaining(`JSONata ${code}`),
				});
			}
		});

		it("takes only string patterns in $contains, $replace and $split", async () => {
			const matcher = "function($s) { { 'match': 'a', 'start': 0, 'end': 1, 'groups': [] } }";
			for (const text of [
				`$contains(s, ${matcher})`,
				`$replace(s, ${matcher}, 'x')`,
				`$split(s, ${matcher})`,
				"$replace(s, 'a', function($m) { 'x' })",
			]) {
				expect(await evaluate(text, { s: "abc" })).toMatchObject({
					ok: false,
					limit: false,
					message: expect.stringMatching(/^JSONata T0410 /),
				});
			}
		});

		it.each([
			["$replace with a long replacement", "$replace(k, 'x', k)"],
			["$split into single characters", "$split(s, '')"],
			["$join with a long separator", "$join($map([1..1000], function($v) { 'a' }), k)"],
		])("stops %s before building its result", { timeout: 5000 }, async (_name, text) => {
			const input = { s: "x".repeat(4 * 1024 * 1024), k: "x".repeat(256 * 1024) };
			expect(await evaluate(text, input, { timeoutMs: 1_000_000_000 })).toEqual(LIMIT);
		});

		it(`caps $fromMillis widths at ${PICTURE_MAX_WIDTH} and pictures at ${PICTURE_MAX_LENGTH} characters`, async () => {
			expect(await evaluate(`$length($fromMillis(0, '[Y,${PICTURE_MAX_WIDTH}]'))`)).toEqual({
				ok: true,
				value: PICTURE_MAX_WIDTH,
			});
			expect(await evaluate("$fromMillis(0, '[[Y,99999]]')")).toEqual({
				ok: true,
				value: "[Y,99999]",
			});
			for (const picture of [
				"[Y,100000000]",
				"[Y,*-100000000]",
				`[Y,${PICTURE_MAX_WIDTH + 1}]`,
				"[D01]/[M , 1 0 0 0 0 0]",
				"[Y,0x100]",
			]) {
				expect(await evaluate("$fromMillis(0, p)", { p: picture })).toEqual({
					ok: false,
					limit: false,
					message: `$fromMillis widths are limited to ${PICTURE_MAX_WIDTH}`,
				});
			}
			expect(await evaluate("$fromMillis(0, p)", { p: "[Y]".repeat(100) })).toEqual({
				ok: false,
				limit: false,
				message: `$fromMillis pictures are limited to ${PICTURE_MAX_LENGTH} characters`,
			});
		});
	});
});
