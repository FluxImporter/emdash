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
 * A built-in call is one step, so neither the step counter nor the clock interrupts it. Regular
 * expressions, which can backtrack for minutes on a short string, are therefore rejected at
 * compile time. What remains is size-bound work such as `$pad` with a huge width (about 2 s for
 * 100 million characters on Node 22), which V8's string and array length limits end.
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

/** JSONata calls the function bound to this symbol before evaluating each node. */
const EVALUATE_ENTRY = Symbol.for("jsonata.__evaluate_entry");

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
 * `$millis`, `$random` or `$shuffle`. `$eval` is bound to a function that throws. `limits` is
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
	const countStep = (_node: unknown, _input: unknown, environment: { base: object }) => {
		const n = (steps.get(environment.base) ?? 0) + 1;
		steps.set(environment.base, n);
		if (n > limits.steps) throw new StepLimitError(limits.steps);
	};
	// The typings only allow string names; JSONata looks the hook up by this symbol.
	expr.assign(EVALUATE_ENTRY as unknown as string, countStep);
	expr.assign("eval", () => {
		throw new Error("$eval is not available in templates");
	});

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
