import jsonata from "jsonata";

/** Longest expression a template may hold, in UTF-8 bytes. */
export const EXPRESSION_MAX_BYTES = 4096;

export interface ExpressionLimits {
	/** Evaluation steps (JSONata `evaluate` calls) per evaluation. */
	steps: number;
	/** Wall-clock milliseconds per evaluation (JSONata `timeout`, code D1012). */
	timeoutMs: number;
	/** Evaluation depth (JSONata `stack`, code D1011). */
	depth: number;
	/** Longest sequence (JSONata `sequence`, code D2015). */
	sequence: number;
}

/**
 * The limits every template expression runs with. Fixed in code: a template cannot change them.
 * On Workers `Date.now()` does not advance during pure CPU work, so the time limit never fires
 * there and the step count is what ends a runaway.
 *
 * A step is weighted by what the node produced: one for entering it, plus an array result's
 * length, plus one per `BYTES_PER_STEP` of a string, an object or an array's contents (sizes are
 * approximate, cached per object). A node that reads a large value therefore costs in proportion
 * to it, and so does a loop that reads it again; a built-in call that reads the context value
 * instead of an argument, and a field name looked up on an array, are charged for that value on
 * entry. That only bounds the work JSONata does inside one node when the work is about as large
 * as the node's arguments or result, so templates may only call the built-ins in
 * `ALLOWED_FUNCTIONS`, checked to be linear in what they are given; the few that can build far
 * more than they are given are capped (`$pad`, `$fromMillis`) or checked against the remaining
 * steps before they build anything (`$split`, `$join`, `$replace`). Built-ins can only be called,
 * never passed around as values: a built-in handed to `$map` or `$reduce`, or partially applied
 * with a large argument fixed, would run once per element without any node charging for it.
 * Regular expressions (which can backtrack for minutes inside one call), the transform operator
 * `|...|` (a deep copy), the wildcards `*` and `**`, grouping a sequence (`expr{...}`) and the
 * `@`/`#` bindings (the last three copy arrays quadratically in one node) are rejected at compile
 * time; an object constructor whose context is an array is charged for the same worst case.
 */
export const EXPRESSION_LIMITS: Readonly<ExpressionLimits> = {
	steps: 100_000,
	timeoutMs: 1000,
	depth: 200,
	sequence: 100_000,
};

/**
 * Functions that give a different result on every call (`$shuffle` uses `Math.random()`);
 * re-imports and crash repair need the same.
 */
const NONDETERMINISTIC_FUNCTIONS: ReadonlySet<string> = new Set([
	"now",
	"millis",
	"random",
	"shuffle",
]);

/**
 * The JSONata built-ins a template may call. Each one's work is about linear in its arguments
 * and result, which the step count charges; those marked below are replaced with a capped or
 * pre-checked version in `compileExpression`.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
	// Strings.
	"string", // no indentation (pretty-printing a deeply nested value is quadratic)
	"substring", // reimplemented without a per-character array
	"substringBefore",
	"substringAfter",
	"lowercase",
	"uppercase",
	"length", // reimplemented without a per-character array
	"trim",
	"pad", // width capped
	"contains", // string patterns only
	"replace", // string patterns only, result size checked first
	"split", // string separators only, result size checked first
	"join", // result size checked first
	"encodeUrlComponent",
	"encodeUrl",
	"decodeUrlComponent",
	"decodeUrl",
	// Numbers.
	"number",
	"floor",
	"ceil",
	"round",
	"abs",
	"sqrt",
	"power",
	"formatBase",
	"sum",
	"max",
	"min",
	"average",
	// Booleans and types.
	"boolean",
	"not",
	"exists",
	"type",
	// Arrays, objects and functions.
	"count",
	"map",
	"filter",
	"single",
	"reduce",
	"append",
	"reverse",
	"lookup",
	"keys",
	// Dates.
	"toMillis", // ISO 8601 only
	"fromMillis", // picture length and widths capped
]);

/**
 * Every built-in JSONata 2.2.2 defines: its static frame, plus `$now` and `$millis`, which each
 * expression binds. A `$` name that is in neither list is the template's own variable.
 */
export const JSONATA_FUNCTIONS: ReadonlySet<string> = new Set([
	...ALLOWED_FUNCTIONS,
	...NONDETERMINISTIC_FUNCTIONS,
	"match", // regular expressions only
	"formatNumber", // picture analysis is quadratic in the picture, which may come from the record
	"formatInteger", // the same
	"parseInteger", // the same
	"eval", // evaluates text as an expression
	"sort", // the default comparison is a quadratic merge that no step counts (6.7 s on 45,000)
	"distinct", // quadratic deep comparison of objects
	"clone", // a deep copy, and what the transform operator runs
	"spread",
	"merge",
	"each",
	"sift",
	"zip",
	"error",
	"assert",
	"base64encode", // depends on Node's global Buffer
	"base64decode",
]);

/**
 * The allowed built-ins that take the context value when an argument is left out (a `-` in
 * JSONata's signature), with how many arguments they need: `$length()` inside a lambda reads
 * the whole record, which no node produced, so such a call is charged for its context.
 */
const CONTEXT_ARGUMENTS: ReadonlyMap<string, number> = new Map([
	["string", 1],
	["substring", 2],
	["substringBefore", 2],
	["substringAfter", 2],
	["lowercase", 1],
	["uppercase", 1],
	["length", 1],
	["trim", 1],
	["pad", 2],
	["contains", 2],
	["replace", 3],
	["split", 2],
	["encodeUrlComponent", 1],
	["encodeUrl", 1],
	["decodeUrlComponent", 1],
	["decodeUrl", 1],
	["number", 1],
	["floor", 1],
	["ceil", 1],
	["round", 1],
	["abs", 1],
	["sqrt", 1],
	["power", 2],
	["formatBase", 1],
	["boolean", 1],
	["not", 1],
	["keys", 1],
	["lookup", 2],
	["toMillis", 1],
	["fromMillis", 1],
]);

/** JSONata's codes for its depth, time and sequence limits. */
const LIMIT_CODES: ReadonlySet<string> = new Set(["D1011", "D1012", "D2015"]);

/** JSONata calls the functions bound to these symbols before and after evaluating each node. */
const EVALUATE_ENTRY = Symbol.for("jsonata.__evaluate_entry");
const EVALUATE_EXIT = Symbol.for("jsonata.__evaluate_exit");

/**
 * Widest `$pad` a template may ask for, in characters. Padding is for fixed-width codes and
 * columns (SKUs, zero-filled numbers), which are far narrower; without a cap one call builds a
 * string of any width (100 million characters took about 2 s on Node 22).
 */
export const PAD_MAX_WIDTH = 10_000;

/**
 * Longest `$fromMillis` picture, in UTF-16 units, and its widest width modifier. JSONata pads a
 * component to its width in one call (`[Y,100000000]` built 1.65 GB), and analyses the digit
 * pattern of each component in time quadratic in its length; date pictures are a few dozen
 * characters with widths of a few digits.
 */
export const PICTURE_MAX_LENGTH = 256;
export const PICTURE_MAX_WIDTH = 64;

/**
 * Bytes (counted as UTF-16 units for strings) a result may hold per step charged for it. All
 * the strings, arrays and objects one evaluation builds are then about 100,000 x 256 bytes at
 * most, 25.6 million characters: about 51 MB of two-byte strings, within a Worker's 128 MB. At
 * 1 KiB per step one `$join` built a 91 million character string (96 MB) within the count.
 */
const BYTES_PER_STEP = 256;

function weightOf(bytes: number): number {
	return Math.ceil(bytes / BYTES_PER_STEP);
}

/** An object's approximate size in bytes, kept for the next time the same object is charged. */
const objectSizes = new WeakMap<object, number>();

function isFunctionValue(value: object): boolean {
	return (
		typeof value === "function" ||
		(value as { _jsonata_lambda?: unknown })._jsonata_lambda === true ||
		(value as { _jsonata_function?: unknown })._jsonata_function === true
	);
}

/**
 * The approximate size of a value in bytes: a string's length, 8 for other scalars, and the sum
 * of an array's or object's members (with its keys). Objects are not changed once built, so
 * their size is computed once; arrays are summed each time (JSONata grows some in place).
 */
function sizeOf(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value !== "object" || value === null) return 8;
	if (isFunctionValue(value)) return 8;
	if (Array.isArray(value)) {
		let size = 8;
		for (const member of value) size += 8 + sizeOf(member);
		return size;
	}
	const known = objectSizes.get(value);
	if (known !== undefined) return known;
	let size = 16;
	for (const [key, member] of Object.entries(value)) size += key.length + 8 + sizeOf(member);
	objectSizes.set(value, size);
	return size;
}

/** The work a node's result stands for, on top of the one step for entering it. */
function resultWeight(result: unknown): number {
	if (typeof result === "string") return weightOf(result.length);
	if (typeof result !== "object" || result === null) return 0;
	if (Array.isArray(result)) return result.length + weightOf(sizeOf(result));
	return weightOf(sizeOf(result));
}

/**
 * An object constructor whose context is an array groups its members, and JSONata adds each
 * member to its group by copying the group's array: quadratic when the keys repeat (48,000
 * members under one key took 1.6 s). Charged on entry as that worst case, in steps of about 1,000
 * copies, which a context of a few hundred members barely notices.
 */
function groupWeight(node: { type?: unknown; value?: unknown }, input: unknown): number {
	if (node.type !== "unary" || node.value !== "{" || !Array.isArray(input)) return 0;
	return Math.ceil((input.length * input.length) / 1024);
}

/** A JSONata built-in as `$name` evaluates to it: the implementation and its signature. */
interface JsonataBuiltin {
	implementation: (this: jsonata.Focus, ...args: unknown[]) => unknown;
}

const builtins = new Map<string, Promise<JsonataBuiltin>>();

/** JSONata's own implementation of `$name`, read once from a plain expression. */
function builtin(name: string): Promise<JsonataBuiltin> {
	let found = builtins.get(name);
	if (found === undefined) {
		found = jsonata(`$${name}`).evaluate({}) as Promise<JsonataBuiltin>;
		builtins.set(name, found);
	}
	return found;
}

/** Calls JSONata's own `$name` with the same focus. */
async function original(name: string, focus: jsonata.Focus, args: unknown[]): Promise<unknown> {
	return (await builtin(name)).implementation.apply(focus, args);
}

/** Array-slice bounds (`ToIntegerOrInfinity`, then relative to `length`), as JSONata relies on. */
function sliceIndex(index: number, length: number): number {
	const n = Number.isNaN(index) ? 0 : Math.trunc(index);
	return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-16 width of the code point at `offset`: 2 for a surrogate pair, 1 otherwise. */
function codePointWidth(str: string, offset: number): number {
	return isHighSurrogate(str.charCodeAt(offset)) &&
		offset + 1 < str.length &&
		isLowSurrogate(str.charCodeAt(offset + 1))
		? 2
		: 1;
}

/** Code points in `str`, as `for...of` counts them (a lone surrogate is one). */
function codePointLength(str: string): number {
	let count = 0;
	for (let offset = 0; offset < str.length; offset += codePointWidth(str, offset)) count++;
	return count;
}

/** `str` from code point `from` up to code point `to` (both already within bounds). */
function codePointSlice(str: string, from: number, to: number): string {
	if (from >= to) return "";
	let index = 0;
	let offset = 0;
	while (index < from) {
		offset += codePointWidth(str, offset);
		index++;
	}
	const start = offset;
	while (index < to) {
		offset += codePointWidth(str, offset);
		index++;
	}
	return str.slice(start, offset);
}

/** JSONata's `$length` (code points), without building an array of every character. */
function length(str: string | undefined): number | undefined {
	return str === undefined ? undefined : codePointLength(str);
}

/** JSONata's `$substring` (code points, negative start from the end), without the array. */
function substring(str: string | undefined, start: number, count?: number): string | undefined {
	if (str === undefined) return undefined;
	const total = codePointLength(str);
	const begin = total + start < 0 ? 0 : start;
	if (count === undefined) return codePointSlice(str, sliceIndex(begin, total), total);
	if (count <= 0) return "";
	const end = begin >= 0 ? begin + count : total + begin + count;
	return codePointSlice(str, sliceIndex(begin, total), sliceIndex(end, total));
}

/** Non-overlapping occurrences of a non-empty `pattern` in `str`, counting up to `max`. */
function countMatches(str: string, pattern: string, max: number): number {
	let count = 0;
	for (
		let at = str.indexOf(pattern);
		at !== -1 && count < max;
		at = str.indexOf(pattern, at + pattern.length)
	) {
		count++;
	}
	return count;
}

/** Checks a `$fromMillis` picture's length and every width modifier, without a regular expression. */
function checkPicture(picture: string): void {
	if (picture.length > PICTURE_MAX_LENGTH) {
		throw new Error(`$fromMillis pictures are limited to ${PICTURE_MAX_LENGTH} characters`);
	}
	// The same scan as JSONata's: `[[` is a literal, a marker runs to the next `]`, whitespace in
	// it is ignored, and the width follows its last comma as `min` or `min-max`.
	let pos = 0;
	while (pos < picture.length) {
		if (picture[pos] !== "[") {
			pos++;
			continue;
		}
		if (picture[pos + 1] === "[") {
			pos += 2;
			continue;
		}
		const close = picture.indexOf("]", pos);
		if (close === -1) return; // JSONata reports the missing bracket (D3135).
		let marker = "";
		for (const ch of picture.slice(pos + 1, close)) if (ch.trim() !== "") marker += ch;
		const comma = marker.lastIndexOf(",");
		if (comma !== -1) {
			for (const part of marker.slice(comma + 1).split("-")) {
				// biome-ignore lint/correctness/useParseIntRadix: JSONata parses widths without one (`0x100` is 256).
				if (Number.parseInt(part) > PICTURE_MAX_WIDTH) {
					throw new Error(`$fromMillis widths are limited to ${PICTURE_MAX_WIDTH}`);
				}
			}
		}
		pos = close + 1;
	}
}

/**
 * Deepest nesting of arrays an expression may read. JSONata looks a field name up through nested
 * arrays by recursing and copying every level, natively: 99,999 leaves under 997 levels took 1.85 s
 * and 99 MB for one `a.k`. The reader allows nesting to 1,000, so a deeper record fails every
 * expression as a limit before evaluation.
 */
export const ARRAY_MAX_DEPTH = 32;
const ARRAY_DEPTH_PROBLEM = `The record nests arrays more than ${ARRAY_MAX_DEPTH} levels deep`;

/** Each record's array depth, computed once for all of its expressions. */
const arrayDepths = new WeakMap<object, number>();

/** Most arrays on any path from `value` down to a leaf, without recursion. */
function arrayDepth(value: unknown): number {
	if (typeof value !== "object" || value === null) return 0;
	const known = arrayDepths.get(value);
	if (known !== undefined) return known;
	let deepest = 0;
	const stack: [unknown, number][] = [[value, 0]];
	while (stack.length > 0) {
		const [node, above] = stack.pop() as [unknown, number];
		if (typeof node !== "object" || node === null) continue;
		const depth = Array.isArray(node) ? above + 1 : above;
		if (depth > deepest) deepest = depth;
		for (const member of Array.isArray(node) ? node : Object.values(node)) {
			if (typeof member === "object" && member !== null) stack.push([member, depth]);
		}
	}
	arrayDepths.set(value, deepest);
	return deepest;
}

class StepLimitError extends Error {
	constructor(readonly steps: number) {
		super(`Expression exceeded ${steps} evaluation steps`);
		this.name = "StepLimitError";
	}
}

export type Evaluation =
	| { ok: true; value: unknown }
	| {
			ok: false;
			/** A step, time, depth or sequence limit stopped it (`expr_limit`), not the data. */
			limit: boolean;
			message: string;
	  };

export interface CompiledExpression {
	/** Evaluates against one record. Never throws: failures come back as `ok: false`. */
	evaluate(input: unknown): Promise<Evaluation>;
}

export type CompileResult =
	| { ok: true; expression: CompiledExpression }
	| { ok: false; problem: string };

interface JsonataFailure {
	code: string;
	message?: unknown;
	position?: unknown;
}

function isJsonataFailure(e: unknown): e is JsonataFailure {
	return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string";
}

/** "JSONata S0207 at character 7: Unexpected end of expression", or the error's own message. */
function describeFailure(e: unknown): string {
	if (e instanceof StepLimitError) return e.message;
	if (isJsonataFailure(e)) {
		const at = typeof e.position === "number" ? ` at character ${e.position}` : "";
		const message = typeof e.message === "string" ? e.message : "";
		return `JSONata ${e.code}${at}: ${message}`;
	}
	return e instanceof Error ? e.message : String(e);
}

/** "$a, $b" for a sorted list of names. */
function names(found: Iterable<string>): string {
	return [...found]
		.sort()
		.map((n) => `$${n}`)
		.join(", ");
}

/**
 * The first reason the parsed expression is not allowed in a template, if any. It walks every
 * node, so a reference counts wherever it sits: a lambda body, a block, a predicate, either side
 * of `~>`. Text inside a string literal is a `string` node, so `'$now()'` and `'/a+/'` are
 * allowed; string patterns in `$contains`, `$split` and `$replace` match literally and never
 * become a `RegExp`. In order:
 * - a regular-expression literal (a `regex` node);
 * - any reference to `$now`, `$millis`, `$random` or `$shuffle`, not only a call:
 *   `$x := $now; $x()` and `$map(a, $random)` call them too;
 * - any reference to a JSONata built-in outside `ALLOWED_FUNCTIONS`;
 * - grouping a sequence (`expr{...}`), the `@$x` and `#$i` bindings, the transform operator
 *   `|...|` and the wildcards `*` and `**`;
 * - an allowed built-in that is not called directly (`$string(x)`, `x ~> $string()`): passed as
 *   a value, partially applied, bound to a variable or used as a parameter name.
 * When the expression is allowed, it returns the nodes that call a built-in on the context value
 * (`readsContext`), which evaluation charges for that value.
 */
function checkTemplate(ast: unknown): { problem: string } | { readsContext: Set<object> } {
	const nodes: Record<string, unknown>[] = [];
	const seen = new Set<object>();
	const stack: unknown[] = [ast];
	while (stack.length > 0) {
		const node = stack.pop();
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node)) {
			stack.push(...node);
			continue;
		}
		const record = node as Record<string, unknown>;
		nodes.push(record);
		stack.push(...Object.values(record));
	}
	// A call is a `function` node whose `procedure` is the variable naming what it calls. A call
	// on the right of `~>` gets the left side as its first argument, and JSONata evaluates it as
	// part of the `apply` node.
	const called = new Set<unknown>();
	const readsContext = new Set<object>();
	const contextCall = (call: unknown, extra: number) => {
		const { procedure, arguments: args } = call as { procedure?: unknown; arguments?: unknown };
		const name = (procedure as { value?: unknown } | undefined)?.value;
		const needs = typeof name === "string" ? CONTEXT_ARGUMENTS.get(name) : undefined;
		return needs !== undefined && Array.isArray(args) && args.length + extra < needs;
	};
	for (const node of nodes) {
		if (node.type === "function") {
			called.add(node.procedure);
			if (contextCall(node, 0)) readsContext.add(node);
		}
		const rhs = node.rhs as { type?: unknown } | undefined;
		if (node.type === "apply" && rhs?.type === "function" && contextCall(rhs, 1)) {
			readsContext.add(node);
		}
	}

	let regex = false;
	let transform = false;
	let wildcard = false;
	let groupBy = false;
	let binding = false;
	const nondeterministic = new Set<string>();
	const unavailable = new Set<string>();
	const uncalled = new Set<string>();
	for (const node of nodes) {
		if (node.type === "regex") regex = true;
		if (node.type === "transform") transform = true;
		if (node.type === "wildcard" || node.type === "descendant") wildcard = true;
		// `a{…}` puts a `group` on the node it follows; an object constructor on its own
		// (`{"a": price}`) is a `unary` node with no `group`.
		if ("group" in node) groupBy = true;
		if (typeof node.focus === "string" || typeof node.index === "string") binding = true;
		if (node.type !== "variable" || typeof node.value !== "string") continue;
		const name = node.value;
		if (NONDETERMINISTIC_FUNCTIONS.has(name)) nondeterministic.add(name);
		else if (ALLOWED_FUNCTIONS.has(name)) {
			if (!called.has(node)) uncalled.add(name);
		} else if (JSONATA_FUNCTIONS.has(name)) unavailable.add(name);
	}
	if (regex) return { problem: "Regular expressions are not supported in templates" };
	if (nondeterministic.size > 0) {
		return {
			problem: `${names(nondeterministic)} cannot be used: expressions must give the same result on every run`,
		};
	}
	if (unavailable.size > 0) {
		const verb = unavailable.size === 1 ? "is" : "are";
		return { problem: `${names(unavailable)} ${verb} not available in templates` };
	}
	if (transform) return { problem: "The transform operator |...| is not supported in templates" };
	if (groupBy) {
		return {
			problem:
				"Grouping a sequence (expr{…}) is not supported in templates; an object constructor on its own ({…}) is",
		};
	}
	if (binding) {
		return { problem: "The focus and index bindings @$x and #$i are not supported in templates" };
	}
	if (wildcard) {
		return { problem: "The wildcards * and ** are not supported in templates; name the fields" };
	}
	if (uncalled.size > 0) {
		return {
			problem: `${names(uncalled)} can only be called directly in templates: built-in functions cannot be passed as values, bound to variables or partially applied`,
		};
	}
	return { readsContext };
}

/**
 * Parses a template expression once and returns a handle that evaluates it with `limits`. Fails
 * for an expression over `EXPRESSION_MAX_BYTES`, a syntax error (the message names the JSONata
 * code and character position), or anything `templateProblem` rejects. The built-ins that can
 * build far more than they are given are replaced with versions that cap or pre-check their
 * result (see `EXPRESSION_LIMITS`). `limits` is for tests; templates always get
 * `EXPRESSION_LIMITS`.
 */
export function compileExpression(
	text: string,
	limits: Readonly<ExpressionLimits> = EXPRESSION_LIMITS,
): CompileResult {
	const bytes = new TextEncoder().encode(text).byteLength;
	if (bytes > EXPRESSION_MAX_BYTES) {
		return {
			ok: false,
			problem: `The expression is ${bytes} bytes; expressions are limited to ${EXPRESSION_MAX_BYTES}`,
		};
	}
	let expr: jsonata.Expression;
	try {
		expr = jsonata(text, {
			timeout: limits.timeoutMs,
			stack: limits.depth,
			sequence: limits.sequence,
		});
	} catch (e) {
		return { ok: false, problem: describeFailure(e) };
	}
	const checked = checkTemplate(expr.ast());
	if ("problem" in checked) return { ok: false, problem: checked.problem };
	const { readsContext } = checked;

	// One count per evaluation: every frame of an evaluation shares its `base` environment.
	type Frame = { base: object };
	const steps = new WeakMap<object, number>();
	const charge = (environment: Frame, cost: number) => {
		const n = (steps.get(environment.base) ?? 0) + cost;
		steps.set(environment.base, n);
		if (n > limits.steps) throw new StepLimitError(limits.steps);
	};
	/** Fails before building a result that would cost more than the steps left. */
	const ensureRoom = (focus: jsonata.Focus, cost: number) => {
		const environment = focus.environment as unknown as Frame;
		if ((steps.get(environment.base) ?? 0) + cost > limits.steps) {
			throw new StepLimitError(limits.steps);
		}
	};
	// Entering a node is one step. Two kinds of node also read their context value natively,
	// which may be the record itself and so was not charged as any node's result: a built-in
	// call that takes its argument from the context, and a field name looked up on an array
	// (which reads every member).
	const onEntry = (
		node: { type?: unknown; value?: unknown },
		input: unknown,
		environment: Frame,
	) => {
		const readsInput = readsContext.has(node) || (node.type === "name" && Array.isArray(input));
		charge(environment, 1 + (readsInput ? resultWeight(input) : 0) + groupWeight(node, input));
	};
	const onExit = (_node: unknown, _input: unknown, environment: Frame, result: unknown) => {
		const cost = resultWeight(result);
		if (cost > 0) charge(environment, cost);
	};
	// The typings only allow string names; JSONata looks the hooks up by these symbols.
	expr.assign(EVALUATE_ENTRY as unknown as string, onEntry);
	expr.assign(EVALUATE_EXIT as unknown as string, onExit);

	// Replacements, registered with JSONata's own signatures except where noted, so arguments
	// are checked and defaulted alike.
	expr.registerFunction("length", length, "<s-:n>");
	expr.registerFunction("substring", substring, "<s-nn?:s>");

	// `$string` without indentation: indenting a value nested a few thousand deep builds a string
	// quadratic in its depth.
	expr.registerFunction(
		"string",
		function (this: jsonata.Focus, value: unknown, prettify?: boolean) {
			if (prettify === true) {
				throw new Error("$string with indentation is not available in templates");
			}
			return original("string", this, [value]);
		},
		"<x-b?:s>",
	);

	// `$pad` with its width capped at `PAD_MAX_WIDTH`.
	expr.registerFunction(
		"pad",
		function (this: jsonata.Focus, str: unknown, width: number, char?: unknown) {
			const wide = Math.abs(Math.trunc(width));
			if (!(wide <= PAD_MAX_WIDTH)) {
				throw new Error(`$pad width is limited to ${PAD_MAX_WIDTH} characters`);
			}
			// JSONata repeats `char` to the padding length, then keeps that many characters: a long
			// `char` would build `width` copies of itself first. The first `2 * width` UTF-16 units
			// hold at least `width` whole characters, which is all the padding can use.
			const fill =
				typeof char === "string" && char.length > 2 * wide ? char.slice(0, 2 * wide) : char;
			return original("pad", this, fill === undefined ? [str, width] : [str, width, fill]);
		},
		"<s-ns?:s>",
	);

	// String patterns only (JSONata also takes a matcher function): a template lambda as matcher
	// could make `$replace` copy the whole string once per call.
	expr.registerFunction(
		"contains",
		function (this: jsonata.Focus, str: unknown, token: unknown) {
			return original("contains", this, [str, token]);
		},
		"<s-s:b>",
	);

	// JSONata's `$replace` with a string pattern, which inserts the replacement literally. Its own
	// version appends to a string once per match (64,000 matches took about 3 ms per call); this
	// one collects the pieces and joins them once, after checking the result's size.
	expr.registerFunction(
		"replace",
		function (
			this: jsonata.Focus,
			str: string | undefined,
			pattern: string,
			replacement: string,
			limit?: number,
		) {
			if (str === undefined) return undefined;
			if (pattern === "" || (limit !== undefined && limit < 0)) {
				// JSONata's own errors (D3010, D3011).
				const args = [str, pattern, replacement, ...(limit === undefined ? [] : [limit])];
				return original("replace", this, args);
			}
			const max = limit ?? Number.POSITIVE_INFINITY;
			const matches = countMatches(str, pattern, max);
			const size = str.length + matches * (replacement.length - pattern.length);
			ensureRoom(this, Math.ceil(matches / 16) + weightOf(size));
			if (matches < max) return str.split(pattern).join(replacement);
			const pieces: string[] = [];
			let from = 0;
			while (pieces.length < matches) {
				const at = str.indexOf(pattern, from);
				pieces.push(str.slice(from, at));
				from = at + pattern.length;
			}
			pieces.push(str.slice(from));
			return pieces.join(replacement);
		},
		"<s-ssn?:s>",
	);

	expr.registerFunction(
		"split",
		function (this: jsonata.Focus, str: string | undefined, separator: string, limit?: number) {
			if (str !== undefined) {
				const max = typeof limit === "number" && limit >= 0 ? limit : Number.POSITIVE_INFINITY;
				const pieces =
					separator === ""
						? Math.min(str.length, max)
						: Math.min(countMatches(str, separator, max) + 1, max);
				ensureRoom(this, pieces + weightOf(str.length));
			}
			return original(
				"split",
				this,
				limit === undefined ? [str, separator] : [str, separator, limit],
			);
		},
		"<s-sn?:a<s>>",
	);

	expr.registerFunction(
		"join",
		function (this: jsonata.Focus, strs: unknown, separator?: string) {
			if (Array.isArray(strs)) {
				let size = Math.max(strs.length - 1, 0) * (separator ?? "").length;
				for (const s of strs) size += typeof s === "string" ? s.length : 0;
				ensureRoom(this, weightOf(size));
			}
			return original("join", this, separator === undefined ? [strs] : [strs, separator]);
		},
		"<a<s>s?:s>",
	);

	// `$toMillis` without a picture (ISO 8601). With one, JSONata builds a regular expression from
	// the picture and runs it on the value: `[f]` sixteen times on a 38-character value
	// backtracked for 107 s in one call. The picture may come from the record, so it is refused
	// at evaluation.
	expr.registerFunction(
		"toMillis",
		function (this: jsonata.Focus, timestamp: unknown, picture?: unknown) {
			if (picture !== undefined) {
				throw new Error(
					"$toMillis with a picture is not available in templates; use the date field's format option",
				);
			}
			return original("toMillis", this, [timestamp]);
		},
		"<s-s?:n>",
	);

	expr.registerFunction(
		"fromMillis",
		function (this: jsonata.Focus, millis: unknown, picture?: string, timezone?: string) {
			if (picture !== undefined) checkPicture(picture);
			const args = [millis, picture, timezone];
			while (args.length > 1 && args[args.length - 1] === undefined) args.pop();
			return original("fromMillis", this, args);
		},
		"<n-s?s?:s>",
	);

	return {
		ok: true,
		expression: {
			async evaluate(input) {
				if (arrayDepth(input) > ARRAY_MAX_DEPTH) {
					return { ok: false, limit: true, message: ARRAY_DEPTH_PROBLEM };
				}
				try {
					return { ok: true, value: await expr.evaluate(input) };
				} catch (e) {
					const limit =
						e instanceof StepLimitError || (isJsonataFailure(e) && LIMIT_CODES.has(e.code));
					return { ok: false, limit, message: describeFailure(e) };
				}
			},
		},
	};
}
