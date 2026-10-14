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
 * The step limit is the bound that holds on Workers, where `Date.now()` does not advance during
 * pure CPU work, so the time limit never fires there.
 *
 * A built-in call is one node, and one call can run a whole native loop (`$sum` over a range,
 * `$map` with a built-in, `$string` of a large value). So a step is weighted by what the node
 * produced: one for entering it, plus an array result's length and a string result's length in
 * KiB (rounded up). Native work that is linear in its result or in an array it was handed (an
 * array reaches a call only as some node's result, which was charged) is then bounded by the
 * same 100,000 count, without a clock. `$pad` widths are capped (`PAD_MAX_WIDTH`). Regular
 * expressions, which can backtrack for minutes on a short string inside one call, are rejected at
 * compile time, and `$toMillis` with a picture string (which JSONata turns into a regular
 * expression run on the data) fails at evaluation.
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
const BANNED_FUNCTIONS: ReadonlySet<string> = new Set(["now", "millis", "random", "shuffle"]);

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

/** The work a node's result stands for, on top of the one step for entering it. */
function resultWeight(result: unknown): number {
	if (Array.isArray(result)) return result.length;
	if (typeof result === "string") return Math.ceil(result.length / 1024);
	return 0;
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

/**
 * `$toMillis` without a picture (ISO 8601). With one, JSONata builds a regular expression from
 * the picture and runs it on the value: `[f]` sixteen times on a 38-character value backtracked
 * for 107 s in one call. The picture may come from the record, so it is refused at evaluation.
 */
async function toMillis(
	this: jsonata.Focus,
	timestamp: unknown,
	picture?: unknown,
): Promise<unknown> {
	if (picture !== undefined) {
		throw new Error(
			"$toMillis with a picture is not available in templates; use the date field's format option",
		);
	}
	return (await builtin("toMillis")).implementation.call(this, timestamp);
}

/** `$pad` with its width capped at `PAD_MAX_WIDTH`. */
async function pad(
	this: jsonata.Focus,
	str: unknown,
	width: number,
	char?: unknown,
): Promise<unknown> {
	const wide = Math.abs(Math.trunc(width));
	if (!(wide <= PAD_MAX_WIDTH)) {
		throw new Error(`$pad width is limited to ${PAD_MAX_WIDTH} characters`);
	}
	// JSONata repeats `char` to the padding length, then keeps that many characters: a long `char`
	// would build `width` copies of itself first. The first `2 * width` UTF-16 units hold at least
	// `width` whole characters, which is all the padding can use.
	const fill = typeof char === "string" && char.length > 2 * wide ? char.slice(0, 2 * wide) : char;
	const args = fill === undefined ? [str, width] : [str, width, fill];
	return (await builtin("pad")).implementation.apply(this, args);
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

/** Rejected for every regular-expression literal: no regex engine here can be interrupted. */
const REGEX_PROBLEM = "Regular expressions are not supported in templates";

/**
 * What the parsed expression uses that templates may not: the names of banned functions it refers
 * to, and whether it holds a regular-expression literal (a `regex` node, wherever it sits: a
 * function argument, a lambda body, a block, a predicate). Any reference to a banned function
 * counts, not only a call: `$x := $now; $x()` and `$map(a, $random)` call them too. Text inside a
 * string literal is a `string` node, so `'$now()'` and `'/a+/'` are allowed; string patterns in
 * `$contains`, `$split` and `$replace` match literally and never become a `RegExp`.
 */
function forbiddenNodes(ast: unknown): { banned: string[]; regex: boolean } {
	const found = new Set<string>();
	let regex = false;
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
		if (
			record.type === "variable" &&
			typeof record.value === "string" &&
			BANNED_FUNCTIONS.has(record.value)
		) {
			found.add(record.value);
		}
		if (record.type === "regex") regex = true;
		stack.push(...Object.values(record));
	}
	return { banned: [...found].sort(), regex };
}

/**
 * Parses a template expression once and returns a handle that evaluates it with `limits`. Fails
 * for an expression over `EXPRESSION_MAX_BYTES`, a syntax error (the message names the JSONata
 * code and character position), a regular-expression literal, or a reference to `$now`,
 * `$millis`, `$random` or `$shuffle`. `$eval` is bound to a function that throws, `$toMillis`
 * to one that throws when given a picture, and `$pad` to one that caps the width. `limits` is
 * for tests; templates always get `EXPRESSION_LIMITS`.
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
	const { banned, regex } = forbiddenNodes(expr.ast());
	if (regex) return { ok: false, problem: REGEX_PROBLEM };
	if (banned.length > 0) {
		const names = banned.map((n) => `$${n}`).join(", ");
		return {
			ok: false,
			problem: `${names} cannot be used: expressions must give the same result on every run`,
		};
	}

	// One count per evaluation: every frame of an evaluation shares its `base` environment.
	const steps = new WeakMap<object, number>();
	const charge = (environment: { base: object }, cost: number) => {
		const n = (steps.get(environment.base) ?? 0) + cost;
		steps.set(environment.base, n);
		if (n > limits.steps) throw new StepLimitError(limits.steps);
	};
	const onEntry = (_node: unknown, _input: unknown, environment: { base: object }) =>
		charge(environment, 1);
	const onExit = (
		_node: unknown,
		_input: unknown,
		environment: { base: object },
		result: unknown,
	) => {
		const cost = resultWeight(result);
		if (cost > 0) charge(environment, cost);
	};
	// The typings only allow string names; JSONata looks the hooks up by these symbols.
	expr.assign(EVALUATE_ENTRY as unknown as string, onEntry);
	expr.assign(EVALUATE_EXIT as unknown as string, onExit);
	expr.assign("eval", () => {
		throw new Error("$eval is not available in templates");
	});
	// The same signatures as JSONata's own, so arguments are checked and defaulted alike.
	expr.registerFunction("toMillis", toMillis, "<s-s?:n>");
	expr.registerFunction("pad", pad, "<s-ns?:s>");

	return {
		ok: true,
		expression: {
			async evaluate(input) {
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
