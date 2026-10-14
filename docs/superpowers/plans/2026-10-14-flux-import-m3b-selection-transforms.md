# Flux Import M3b: record filters and JSONata field transforms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a template skip records (`source.filter`) and compute the key, slug and field values (`expr`) with JSONata, in every source format, keeping every M2 and M3a guarantee: bounded memory, exact resume, idempotent batches, per-record errors that never fail the job, and no duplicates after a crash.

**Architecture:** A new `src/engine/expressions.ts` wraps `jsonata@2.2.2`: it parses an expression once, rejects oversized expressions, regular-expression literals and references to `$now`, `$millis` and `$random` by walking the parsed tree, binds `$eval` to a function that throws, and evaluates with a per-evaluation step counter (JSONata's `__evaluate_entry` hook) plus JSONata's own `timeout`, `stack` and `sequence` options, returning `{ ok, value }` or `{ ok: false, limit, message }` without throwing. `engine/template.ts` takes exactly one of `from` or `expr` for the key, the slug and each field, adds `source.filter`, compiles a template into a `CompiledTemplate` (`compileTemplate`), and maps records asynchronously (`filterRecord`, then `applyTemplate`) through the unchanged M3a typed conversion. Job creation compiles the template (`invalid_template` on any problem); each batch compiles it once and reuses the handles; a filtered record is saved with status `filtered` and counted in a new `filtered` counter that jobs created before M3b read as 0.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4.5.4 (engine) and `astro/zod` (routes), Luxon 3, Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. One new dependency: `jsonata` 2.2.2, pinned exactly.

**Spec:** `docs/superpowers/specs/2026-10-14-flux-import-m3b-selection-transforms-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. Previous plan: `docs/superpowers/plans/2026-10-12-flux-import-m3a-formats.md`; its review: `docs/superpowers/notes/2026-10-12-m3a-review.md`.

Every code block in Tasks 1 to 5 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite and the new workerd parity test on its own), then removed; results are in "Verification while drafting". JSONata line numbers below refer to `node_modules/.pnpm/jsonata@2.2.2/node_modules/jsonata/jsonata.js`.

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`.
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- Never `eval` or `new Function` (JSONata uses neither).
- Expression language: JSONata (`jsonata@2.2.2`, pinned exactly) for both record filters and field transforms, in every format. No JSONPath or XPath engines. The M3a simple paths stay for plain mappings. `jsonata` is the only new dependency.
- Template stays `version: 1`. All additions are optional, so existing templates stay valid and behave exactly as before.
- `key`, `slug` and each field take exactly one of `from` (an M3a path or CSV column) or `expr` (a JSONata expression). Both or neither is a template error. Date fields keep their `format` and `tz` options with either.
- `$now`, `$millis` and `$random` are rejected at job creation; `$eval` is disabled; templates cannot define `$` variables or functions.
- Regular expressions are not supported: any regex literal anywhere in an expression (filter, key, slug, field) fails job creation with `invalid_template` ("Regular expressions are not supported in templates"). String patterns in `$contains`, `$split` and `$replace` stay allowed (they match literally). A safe regex engine may come later.
- Limits are fixed in code, not configurable from a template: steps 100,000 per evaluation; time 1,000 ms per evaluation (`D1012`); depth 200 (`D1011`); sequence length 100,000 (`D2015`); expression length 4 KiB (checked at job creation); input one record of at most 4 MiB (the M3a cap).
- Record order: read the record; evaluate the filter (a filtered record stops there: the key is not resolved and EmDash is never called); resolve `key`, then `slug`; resolve each field; convert values with the M3a typed conversion. An `undefined` expression result is treated like a missing path.
- Error codes, exactly: job creation `invalid_template`; record level `filter_error`, `filter_not_boolean`, `expr_error`, `expr_limit`, plus the M3a codes (`not_scalar`, `missing_key`, `invalid_number`, `invalid_date`, …).
- `RecordStatus` gains `filtered`; `Counters` gains `filtered`. Jobs created before M3b have no `filtered` counter and read it as `0`. The retry pass does not retry filtered records.
- No new routes. Plugin route input schemas import `z` from `"astro/zod"`; the engine keeps `zod` 4.5.4.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 4 also passes `pnpm test:integration` (about 7 minutes) and Task 5 the targeted workerd test (about 40 s); Task 6 runs everything, `pnpm test:cf` included (about 15 minutes).

## Review Focus

1. A CSV filter written like a JSON one (`Price > 4`) compares a string cell with a number: every record must fail with `filter_error` (JSONata T2009) and nothing may be imported or silently skipped — test in Task 3 ("fails every record of a CSV filter that compares text with a number").
2. A filter that returns something other than a boolean (`price` instead of `price > 0`, a string, `null`) must fail its records with `filter_not_boolean`, not import them or drop them as filtered — tests in Task 2 ("fails a filter that gives %s with filter_not_boolean") and Task 3 ("fail only their record and the job completes").
3. A crash after some filtered rows were saved must recount them exactly once, with no duplicate entries — test in Task 3 ("are recounted, not double-counted, after a crash mid-batch").
4. Re-importing the same file with a filter and expressions must report every kept record `unchanged` (expressions are deterministic) — test in Task 4 (the second run in each format's case).
5. A runaway expression on Workers must end as a per-record `expr_limit`, not run until the CPU limit kills the batch, and a regular expression (which no limit can interrupt) must never reach evaluation — tests in Task 1 ("stops a runaway expression at the step limit", "rejects a regular expression in %s") and Task 5 (workerd parity).

## Facts this plan relies on

Found while writing this plan, against `jsonata@2.2.2` on Node v22.23.1 and local workerd; tasks cite them by number.

| # | Fact | Evidence |
| --- | --- | --- |
| J1 | `jsonata(text, { timeout, stack, sequence })` takes the limits as its second argument. Before every node evaluation JSONata increments `environment.base.depth` and runs `guardrails()`: depth over `stack` throws `D1011`, `Date.now()` past `timeout` throws `D1012` (both checked only when `timeout` or `stack` is set). `sequence` is enforced when sequences grow and in the range operator (`D2015`). Depth is decremented on exit, so it measures current nesting, not work done; tail calls are trampolined, so a tail-recursive loop never reaches `D1011` and runs until the step counter or the clock stops it. | `jsonata.js` 3507-3605 (`evaluate`), 5584-5700 (`jsonata()`), 3080-3100 and 4520-4535 (`D2015`); probe: `$f(1000)` non-tail → `D1011` after 4 ms, a tail-recursive loop → never `D1011` |
| J2 | `evaluate` calls `environment.lookup(Symbol.for('jsonata.__evaluate_entry'))` before each node and awaits it with `(node, input, environment)`. `expr.assign(symbol, fn)` binds it (frame bindings are a plain object, so a symbol key works); `evaluate(input, bindings)` cannot, because it copies bindings with `Object.keys`. Every frame of one evaluation shares `environment.base` (the per-evaluation root frame; `createFrame` copies `base`), so a `WeakMap` keyed by it counts steps per evaluation. The typings declare `assign(name: string, …)`, so the symbol needs a cast. | `jsonata.js` 3513, 5332-5365, 5612-5615, 5708-5710; `jsonata.d.ts` |
| J3 | 100,000 steps of a tail-recursive loop take about 40 ms on Node 22; `[1..100000].($ * 2)` hits the step limit before the sequence limit. | probe while drafting |
| J4 | JSONata errors are plain objects, not `Error`s: `{ code, position, token, value, message }` (`message` filled in from the code's template). Syntax errors are thrown by `jsonata()` itself: `price >` → `S0207` at position 7, "Unexpected end of expression". An error thrown by a bound function or by the entry hook propagates as is, with `position` and `token` added when it passes a function call. | `jsonata.js` 5556-5571, 5584-5595; probe |
| J5 | Results: a missing path or an empty sequence gives `undefined`; several values give an array marked `sequence: true`; a one-value sequence collapses to the value; `null` stays `null`; a lambda comes back as an object. | probe |
| J6 | `$eval` lives in the static frame; `assign("eval", fn)` on the compiled expression shadows it, including when the expression passes `$eval` around as a value. `$now()` and `$millis()` read a timestamp taken at the start of each `evaluate`. | `jsonata.js` 5598-5605; probe |
| J7 | AST shape: a call is `{ type: "function", procedure: { type: "variable", value: "now" }, arguments }`; partial application is `type: "partial"`; `~>` is `type: "apply"`; a lambda's body is under `body` (tail calls as `thunk` lambdas); a string literal is `{ type: "string" }`. Walking every object reachable from `expr.ast()` and matching `type: "variable"` finds calls and references in lambdas and nested blocks, and never matches text inside strings. | `expr.ast()` dumps while drafting |
| J8 | A backtracking regular expression is one native call: `$match('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', /(a+)+$/)` ran for 85 s on Node 22, and neither the step counter nor the clock interrupted it, hence the ruling that rejects regex literals. A regex literal parses to `{ type: "regex", value: RegExp }` (the parser builds the `RegExp`, flags plus `g`, without running it) wherever it sits: a function argument, a lambda body, a block, a predicate, the right side of `~>`. The only other `RegExp`s JSONata builds come from `$toMillis`/`$fromMillis` picture strings (fixed digit and name classes) and its signature checks. `$contains`, `$split` and `$replace` with a string pattern use `indexOf`/`split` (`jsonata.js` 1708-1724, 1866-1876, 2087-2089), so `'a.c'` and `'(a+)+$'` match literally; `$match` with a string fails its signature (`T0410`). | `jsonata.js` 4598-4605, 5840-5850; probe and `expr.ast()` dumps while drafting |
| J11 | Remaining single-step work is size-bound: `$pad('x', 100000000)` takes about 2.1 s on Node 22 in one step; at 400 million characters V8 ends it with "Invalid array length" after 2.2 s, and doubling a string in a loop fails at once with "Invalid string length". Both come back as `expr_error`. | probe while drafting |
| J9 | `jsonata` ships CommonJS (`main: jsonata.js`, no `exports`) with `jsonata.d.ts` (`export =`). `import jsonata from "jsonata"` type-checks under `module: NodeNext` with `verbatimModuleSyntax`, and loads in Vitest, under `astro dev` on Node (`sites/dev`) and under workerd (`sites/dev-cf`) with no configuration change. | Tasks 1, 4 and 5 run while drafting |
| J10 | `pnpm --filter flux-import add jsonata@2.2.2 --save-exact` also re-resolves the optional `@cloudflare/kumo` peer `zod` under `@emdash-cms/cloudflare` in `pnpm-lock.yaml` (4.5.4 → 4.6.5, `sites/dev-cf` only). That is pnpm's peer resolution, not a change made by hand; commit the lockfile as pnpm writes it. | `git diff pnpm-lock.yaml` while drafting |

## Rulings this plan makes

- **Regex literals are rejected** (user ruling), by the same tree walk as banned names: any `regex` node fails compilation with `Regular expressions are not supported in templates`, checked before banned names, so an expression with both reports the regex problem.
- **Banned names are rejected wherever they are referenced**, not only where called: `$map(a, $random)` and `($t := $now; $t())` call them too. The walk matches `variable` nodes named `now`, `millis` or `random`; text inside string literals and field names (`now & random`) stays allowed. Message: `$now cannot be used: expressions must give the same result on every run` (several names are listed, sorted, comma-separated).
- **Error messages.** A JSONata failure reads `JSONata <code> at character <position>: <message>` (position left out when JSONata gives none); the step limit reads `Expression exceeded 100000 evaluation steps`; `$eval` reads `$eval is not available in templates` and is an `expr_error` (or `filter_error`). Job-creation problems are prefixed with the template location: `source.filter: …`, `key.expr: …`, `slug.expr: …`, `fields.<name>.expr: …`.
- **4 KiB is 4,096 UTF-8 bytes.** An empty expression (`""`) fails the Zod schema (`min(1)`), like an empty `from`, so it is `invalid_template` with the Zod message.
- **The filter is its own step.** `filterRecord(compiled, value)` returns `{ keep }` or `{ error }`; a filter error or a non-boolean result fails the record with that one error, before the key is read (the record has no key to report). `null` is "anything else" in the spec's table, so it is `filter_not_boolean`. Filter errors have `field: "filter"`.
- **Field names in expression errors.** `expr_error` and `expr_limit` name `key`, `slug` or the template field. A key read with `from` keeps reporting its column name as before; the `missing_key` message stays "The key column is empty" for both.
- **An expression that fails reads as nothing else.** Its field gets the expression error only; the value is not also reported as missing or invalid.
- **`limits` on `compileExpression` is for tests only** (to exercise `D1012` without the step limit); `compileTemplate` always uses `EXPRESSION_LIMITS`.
- **Compiled handles are per batch.** `runBatch` calls `compileTemplate` once per batch. A stored job whose expressions no longer compile (a stored template edited by hand, a JSONata upgrade) fails at its next batch with job error `invalid_template` and the problems joined by `; `.
- **Old jobs are upgraded on read.** `upgradeJob(job)` fills in missing counters with 0; the batch claim, `updateJob` (so every transition and failure note), `getJob` and `listJobs` use it, and the next write stores the full counters.
- **`sources/sample` accepts `source.filter`** (the route's `source` schema mirrors `sourceSchema`, and `definition.test.ts` checks they agree) and ignores it: samples show the raw records the filter will see.
- **`processRecord` takes the compiled template** as a new third argument; it is only called from `batch.ts`.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (87 files; the one Biome info about `recommended` is unchanged) |
| `pnpm test` | 27 files / 481 tests pass (25 files / 414 tests before this plan) in about 14 s |
| Task-by-task replay | After each task's files, `pnpm typecheck`, `pnpm lint` and `pnpm test` passed with the counts given in each task's passing-run step; Task 3's new tests were run against Task 2's source first and failed exactly as its Step 2 says |
| `pnpm test:integration` | 7 files / 34 tests pass in 374 s (was 6 files / 29 tests); the new `selection.test.ts` runs in about 1 s of test time |
| `vitest run --config vitest.cf.config.ts -t runaway` | the new parity test passes (11.7 s test, 40 s with server start); the rest of `pnpm test:cf` was not re-run |

## File map

| File | Responsibility |
| --- | --- |
| `packages/flux-import/package.json`, `pnpm-lock.yaml` | `jsonata` 2.2.2, exact |
| `src/engine/expressions.ts` (new) | `compileExpression`: length cap, parse, banned-name and regex walk, `$eval` blocked, step counter, limits, error mapping |
| `src/engine/template.ts` | `from` xor `expr`, `source.filter`, `compileTemplate`, `filterRecord`, async `applyTemplate`, `templatePaths` over `from` only |
| `src/engine/types.ts` | `filtered` status and counter |
| `src/engine/batch.ts` | Compile once per batch; filter, then map; `filtered` rows; old jobs upgraded on claim |
| `src/engine/jobs.ts` | `invalid_template` for expressions at creation; `upgradeJob` |
| `src/plugin/service.ts`, `src/plugin/routes.ts` | Old jobs read with `filtered: 0`; `filtered` record status and `source.filter` in route schemas |
| `tests/fixtures/formats.ts` | `SELECTION` filter and title expression per format, `withSelection` |

`src/engine/log.ts`, `src/engine/diff.ts` and every file under `src/sources/` do not change.

---

### Task 1: Expression sandbox

**Files:**
- Modify: `packages/flux-import/package.json`, `pnpm-lock.yaml` (new dependency `jsonata` 2.2.2)
- Create: `packages/flux-import/src/engine/expressions.ts`
- Test: `packages/flux-import/tests/unit/expressions.test.ts`

**Interfaces:**
- Consumes: `jsonata@2.2.2` (`jsonata(text, { timeout, stack, sequence }): jsonata.Expression`, `Expression.evaluate(input): Promise<unknown>`, `Expression.assign(name, value)`, `Expression.ast()`; J1 to J7, J9).
- Produces (`src/engine/expressions.ts`):
  - `const EXPRESSION_MAX_BYTES = 4096`
  - `interface ExpressionLimits { steps: number; timeoutMs: number; depth: number; sequence: number }`; `const EXPRESSION_LIMITS: Readonly<ExpressionLimits>` = `{ steps: 100_000, timeoutMs: 1000, depth: 200, sequence: 100_000 }`
  - `type Evaluation = { ok: true; value: unknown } | { ok: false; limit: boolean; message: string }` (`limit` is true for the step limit and for JSONata `D1011`, `D1012`, `D2015`)
  - `interface CompiledExpression { readonly text: string; evaluate(input: unknown): Promise<Evaluation> }` (never throws)
  - `type CompileResult = { ok: true; expression: CompiledExpression } | { ok: false; problem: string }`
  - `compileExpression(text: string, limits: Readonly<ExpressionLimits> = EXPRESSION_LIMITS): CompileResult` (fails with `Regular expressions are not supported in templates` for any regex literal, and with the banned-function message for `$now`, `$millis`, `$random`)

Why first: everything else evaluates through this module, and its limits are what keep a template from stalling a batch (Review Focus 5).

- [ ] **Step 1: Add the dependency**

Run: `source ~/.nvm/nvm.sh && nvm use >/dev/null && pnpm --filter flux-import add jsonata@2.2.2 --save-exact`
Expected: `packages/flux-import/package.json` gains `"jsonata": "2.2.2",` between `"@emdash-cms/auth"` and `"kysely"` in `dependencies`; `pnpm-lock.yaml` gains the `jsonata@2.2.2` entries and re-resolves one optional `zod` peer under `@emdash-cms/cloudflare` (J10). Do not edit the lockfile by hand.

- [ ] **Step 2: Write the failing tests**

Create `packages/flux-import/tests/unit/expressions.test.ts`:
```ts
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
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/expressions.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/expressions.js'` (the module does not exist yet).

- [ ] **Step 4: Implement**

Create `packages/flux-import/src/engine/expressions.ts`:
```ts
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

/** Functions that give a different result on every call; re-imports and crash repair need the same. */
const BANNED_FUNCTIONS: ReadonlySet<string> = new Set(["now", "millis", "random"]);

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
	readonly text: string;
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
function describe(e: unknown): string {
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
 * `$millis` or `$random`. `$eval` is bound
 * to a function that throws. `limits` is for tests; templates always get `EXPRESSION_LIMITS`.
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
		return { ok: false, problem: describe(e) };
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
			text,
			async evaluate(input) {
				try {
					return { ok: true, value: await expr.evaluate(input) };
				} catch (e) {
					const limit =
						e instanceof StepLimitError || (isJsonataFailure(e) && LIMIT_CODES.has(e.code));
					return { ok: false, limit, message: describe(e) };
				}
			},
		},
	};
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/expressions.test.ts`
Expected: PASS (27 tests, about 0.3 s; the time-limit test stops after about 5 ms, the step-limit tests after about 40 ms). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 26 files / 441 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/package.json pnpm-lock.yaml packages/flux-import/src/engine/expressions.ts packages/flux-import/tests/unit/expressions.test.ts
git commit -m "Add the JSONata expression sandbox with step, time, depth and sequence limits"
```

### Task 2: Template expressions, the filter and async mapping

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts` (schema, `compileTemplate`, `filterRecord`, async `applyTemplate`, `templatePaths`)
- Modify: `packages/flux-import/src/engine/types.ts` (`filtered` status and counter)
- Modify: `packages/flux-import/src/engine/batch.ts` (compile once per batch; filter, then map; `filtered` rows)
- Test: `packages/flux-import/tests/unit/template.test.ts`, `packages/flux-import/tests/unit/batch.test.ts`

**Interfaces:**
- Consumes: Task 1 `compileExpression(text): CompileResult`, `CompiledExpression`; M3a `resolvePath(value, path, format)`, `scalarText`, `convert`, `slugify` (template.ts, unchanged); `jobTemplate(job): Template` (jobs.ts).
- Produces (`src/engine/template.ts`):
  - `Template` now has `key: { from?: string; expr?: string }`, `slug?: { from?: string; expr?: string }`, each field `{ from?: string; expr?: string; type; … }` (exactly one of `from`/`expr`, Zod message `Set exactly one of "from" and "expr"`), and `source.filter?: string`; `sourceSchema` accepts `filter`.
  - `ValueErrorCode` adds `"filter_error" | "filter_not_boolean" | "expr_error" | "expr_limit"`.
  - `interface CompiledTemplate { readonly template: Template; readonly filter: CompiledExpression | null; readonly key: CompiledExpression | null; readonly slug: CompiledExpression | null; readonly fields: ReadonlyMap<string, CompiledExpression> }`
  - `compileTemplate(t: Template): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] }` (problems prefixed `source.filter: `, `key.expr: `, `slug.expr: `, `fields.<name>.expr: `)
  - `filterRecord(c: CompiledTemplate, value: unknown): Promise<{ keep: boolean } | { error: ValueError }>`
  - `applyTemplate(c: CompiledTemplate, value: unknown): Promise<{ ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] }>` (was synchronous and took a `Template`)
  - `templatePaths(t)` lists `from` paths only.
- Produces (`src/engine/types.ts`): `RecordStatus` adds `"filtered"`; `Counters` adds `filtered: number`; `emptyCounters()` includes `filtered: 0`.
- Produces (`src/engine/batch.ts`): `processRecord(deps, job, template: CompiledTemplate, rec, opts)` (new third argument); `runBatch` fails the job with `{ code: "invalid_template", message }` when the stored template no longer compiles.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, replace the import block
```ts
import {
	applyTemplate,
	checkTemplate,
	missingPathWarnings,
```
with:
```ts
import {
	applyTemplate,
	type CompiledTemplate,
	checkTemplate,
	compileTemplate,
	filterRecord,
	missingPathWarnings,
```
insert before `describe("applyTemplate", () => {`:
```ts
/** Compiles the template, as each batch does, and applies it to one record value. */
async function apply(t: Template, value: unknown) {
	const compiled = compileTemplate(t);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return applyTemplate(compiled.compiled, value);
}

```
In the two existing blocks `describe("applyTemplate", …)` and `describe("applyTemplate with typed values", …)`, replace every call `applyTemplate(` with `await apply(` (16 calls) and make every test callback in those two blocks `async` (`() => {` becomes `async () => {`; the `it.each` callbacks `(Price) => {` and `(dateStr) => {` become `async (Price) => {` and `async (dateStr) => {`). The expectations do not change: existing templates behave exactly as before.

Append to the end of the file:
```ts
const RUNAWAY = "($f := function($n) { $f($n + 1) }; $f(0))";

/** A JSON template with the given source filter, key, slug and fields; compiled. */
function compiledJson(parts: {
	filter?: string;
	key?: object;
	slug?: object;
	fields?: object;
}): CompiledTemplate {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		source: { format: "json", ...(parts.filter === undefined ? {} : { filter: parts.filter }) },
		key: parts.key ?? { from: "sku" },
		...(parts.slug === undefined ? {} : { slug: parts.slug }),
		fields: parts.fields ?? { title: { from: "name", type: "text" } },
	});
	const compiled = compileTemplate(t);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return compiled.compiled;
}

describe("templateSchema with expressions", () => {
	const base = {
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: { title: { from: "name", type: "text" } },
	};
	const issues = (patch: object) => {
		const result = templateSchema.safeParse({ ...base, ...patch });
		return result.success ? [] : result.error.issues.map((i) => [i.path.join("."), i.message]);
	};
	const ONE = 'Set exactly one of "from" and "expr"';

	it("takes exactly one of from and expr for the key, the slug and each field", () => {
		expect(issues({ key: { expr: "sku" } })).toEqual([]);
		expect(issues({ slug: { expr: "$lowercase(name)" } })).toEqual([]);
		expect(issues({ fields: { title: { expr: "first & last", type: "text" } } })).toEqual([]);
		expect(issues({ key: { from: "sku", expr: "sku" } })).toEqual([["key", ONE]]);
		expect(issues({ key: {} })).toEqual([["key", ONE]]);
		expect(issues({ slug: { from: "a", expr: "a" } })).toEqual([["slug", ONE]]);
		expect(issues({ fields: { title: { type: "text" } } })).toEqual([["fields.title", ONE]]);
		expect(issues({ fields: { title: { from: "a", expr: "a", type: "number" } } })).toEqual([
			["fields.title", ONE],
		]);
		expect(issues({ key: { expr: "" } })).toMatchObject([["key.expr", expect.any(String)]]);
	});

	it("keeps format and tz on a date field with an expression", () => {
		const t = templateSchema.parse({
			...base,
			fields: {
				released: { expr: "date", type: "date", format: "dd/MM/yyyy", tz: "Europe/Chisinau" },
			},
		});
		expect(t.fields.released).toEqual({
			expr: "date",
			type: "date",
			format: "dd/MM/yyyy",
			tz: "Europe/Chisinau",
		});
	});

	it("accepts a filter for every format", () => {
		for (const source of [
			{ format: "csv", filter: "Price != ''" },
			{ format: "json", filter: "price > 0" },
			{ format: "jsonl", filter: "price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != 'X'" },
		]) {
			expect(templateSchema.parse({ ...base, source }).source).toEqual(source);
		}
		expect(issues({ source: { format: "json", filter: "" } })).toMatchObject([
			["source.filter", expect.any(String)],
		]);
	});
});

describe("compileTemplate", () => {
	it("compiles nothing for a template without expressions", () => {
		const result = compileTemplate(template);
		expect(result.ok).toBe(true);
		expect(result.ok && result.compiled).toMatchObject({ filter: null, key: null, slug: null });
		expect(result.ok && result.compiled.fields.size).toBe(0);
	});

	it("names every bad expression by its place in the template", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "json", filter: "price >" },
			key: { expr: "$random()" },
			slug: { expr: `'${"a".repeat(5000)}'` },
			fields: {
				title: { expr: "name", type: "text" },
				price: { expr: "$number(", type: "number" },
			},
		});
		const result = compileTemplate(t);
		expect(result).toEqual({
			ok: false,
			problems: [
				"source.filter: JSONata S0207 at character 7: Unexpected end of expression",
				"key.expr: $random cannot be used: expressions must give the same result on every run",
				"slug.expr: The expression is 5002 bytes; expressions are limited to 4096",
				expect.stringMatching(/^fields\.price\.expr: JSONata S0203 at character \d+: /),
			],
		});
	});
});

describe("filterRecord", () => {
	it.each([
		["true", "price > 0", { keep: true }],
		["false", "price > 100", { keep: false }],
		["an empty sequence", "tags[$ = 'none']", { keep: false }],
		["undefined (a missing path)", "missing", { keep: false }],
	])("handles %s", async (_name, filter, expected) => {
		const record = { sku: "A", price: 5, tags: ["a", "b"] };
		expect(await filterRecord(compiledJson({ filter }), record)).toEqual(expected);
	});

	it("keeps every record when the template has no filter", async () => {
		expect(await filterRecord(compiledJson({}), { sku: "A" })).toEqual({ keep: true });
	});

	it.each([
		["a string", "'yes'"],
		["a number", "1"],
		["an object", "{ 'a': 1 }"],
		["an array", "tags"],
		["null", "null"],
	])("fails a filter that gives %s with filter_not_boolean", async (kind, filter) => {
		const result = await filterRecord(compiledJson({ filter }), { tags: ["a", "b"] });
		expect(result).toEqual({
			error: {
				field: "filter",
				code: "filter_not_boolean",
				message: `The filter must give true or false; it gave ${kind}`,
			},
		});
	});

	it("fails a filter that throws with filter_error, and a runaway one with expr_limit", async () => {
		expect(await filterRecord(compiledJson({ filter: "price > 0" }), { price: "5" })).toEqual({
			error: {
				field: "filter",
				code: "filter_error",
				message: expect.stringMatching(/^JSONata T2009 at character 7: /),
			},
		});
		expect(await filterRecord(compiledJson({ filter: RUNAWAY }), {})).toEqual({
			error: {
				field: "filter",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		});
	});
});

describe("applyTemplate with expressions", () => {
	it("computes the key, the slug and fields, and mixes them with paths", async () => {
		const c = compiledJson({
			key: { expr: "$uppercase(sku)" },
			slug: { expr: "first & ' ' & last" },
			fields: {
				title: { expr: "first & ' ' & last", type: "text" },
				price: { expr: "$round(price.amount * 1.2, 2)", type: "number" },
				sku: { from: "sku", type: "text" },
			},
		});
		const result = await applyTemplate(c, {
			sku: "a1",
			first: "Ada",
			last: "Lovelace",
			price: { amount: 10.555 },
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				slug: "ada-lovelace",
				data: { title: "Ada Lovelace", price: 12.67, sku: "a1" },
			},
		});
	});

	it("converts expression results like path values", async () => {
		const c = compiledJson({
			fields: {
				text: { expr: "price * 2", type: "text" },
				count: { expr: "$string(price)", type: "number" },
				released: {
					expr: "$substring(stamp, 0, 10)",
					type: "date",
					format: "dd/MM/yyyy",
					tz: "Europe/Chisinau",
				},
				nothing: { expr: "missing", type: "text" },
			},
		});
		const result = await applyTemplate(c, { sku: "A", price: 6.25, stamp: "01/03/2026 10:00" });
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A",
				data: {
					text: "12.5",
					count: 6.25,
					released: "2026-02-28T22:00:00.000Z",
					nothing: null,
				},
			},
		});
	});

	it("fails objects and arrays from expressions with not_scalar, and undefined keys as missing", async () => {
		const c = compiledJson({
			key: { expr: "missing" },
			fields: {
				obj: { expr: "{ 'a': name }", type: "text" },
				list: { expr: "tags", type: "text" },
			},
		});
		const result = await applyTemplate(c, { name: "n", tags: ["a", "b"] });
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["key", "missing_key"],
			["obj", "not_scalar"],
			["list", "not_scalar"],
		]);
	});

	it("collects expr_error and expr_limit for the key, the slug and each field", async () => {
		const c = compiledJson({
			key: { expr: "sku + 1" },
			slug: { expr: "$substring(1)" },
			fields: {
				title: { expr: RUNAWAY, type: "text" },
				price: { expr: "price", type: "number" },
				ok: { from: "sku", type: "text" },
			},
		});
		const result = await applyTemplate(c, { sku: "A", price: "n/a" });
		expect(!result.ok && result.errors).toEqual([
			{ field: "key", code: "expr_error", message: expect.stringMatching(/^JSONata T2001 /) },
			{ field: "slug", code: "expr_error", message: expect.stringMatching(/^JSONata T0411 /) },
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
			{ field: "price", code: "invalid_number", message: '"n/a" is not a number' },
		]);
	});

	it("does not list expression paths as template paths", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "json" },
			key: { expr: "sku" },
			slug: { from: "handle" },
			fields: { title: { expr: "name", type: "text" }, price: { from: "price", type: "number" } },
		});
		expect(templatePaths(t)).toEqual(["handle", "price"]);
	});
});
```

In `packages/flux-import/tests/unit/batch.test.ts` every job now has a `filtered` counter. In the test "publishes publish_locked drafts once unlocked and keeps still-locked records locked", replace
```ts
			locked: 1,
			conflict: 0,
			failed: 0,
		});
```
with:
```ts
			locked: 1,
			conflict: 0,
			failed: 0,
			filtered: 0,
		});
```
in "retries failed and conflicting records only", replace
```ts
		const tally = { created: 0, updated: 0, unchanged: 0, failed: 0, locked: 0, conflict: 0 };
```
with:
```ts
		const tally = {
			created: 0,
			updated: 0,
			unchanged: 0,
			failed: 0,
			locked: 0,
			conflict: 0,
			filtered: 0,
		};
```
and in "recovers a record left writing by a crash mid-retry and keeps counters exact", replace
```ts
			failed: 0,
			locked: 0,
			conflict: 0,
		});
```
with:
```ts
			failed: 0,
			locked: 0,
			conflict: 0,
			filtered: 0,
		});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/template.test.ts tests/unit/batch.test.ts`
Expected: FAIL — in `template.test.ts` every test that calls `apply`, `compileTemplate`, `compiledJson` or `filterRecord` fails with `compileTemplate is not a function` or `filterRecord is not a function`, and the schema tests with `expr` or `filter` fail (Zod rejects the unknown keys); in `batch.test.ts` the three edited tests fail because the counters have no `filtered`.

- [ ] **Step 3: Implement the template**

In `packages/flux-import/src/engine/template.ts`:

Add after `import { CSV_SOURCE, SOURCE_FORMATS, type SourceFormat } from "../sources/reader.js";`:
```ts
import { type CompiledExpression, compileExpression } from "./expressions.js";
```

Replace `const column = z.string().min(1);` with:
```ts
const column = z.string().min(1);
const expression = z.string().min(1);
```

Replace the whole `const fieldMapping = z.discriminatedUnion("type", [ … ]);` declaration with:
```ts
/** Where a key, slug or field value comes from: a source path (`from`) or a JSONata `expr`. */
const valueSource = { from: column.optional(), expr: expression.optional() };
const ONE_SOURCE = { message: 'Set exactly one of "from" and "expr"' };
const hasOneSource = (m: { from?: string | undefined; expr?: string | undefined }) =>
	(m.from === undefined) !== (m.expr === undefined);

const fieldMapping = z.discriminatedUnion("type", [
	z
		.object({ ...valueSource, type: z.literal("text") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("number") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("date"),
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
const valueMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);
```

Replace the `sourceSchema` doc comment and declaration with:
```ts
/**
 * The template's `source` block. Which formats take `records` is checked by `checkSource`
 * (sources/readers.ts), so a misplaced `records` is reported as `invalid_source`. `filter` is a
 * JSONata expression evaluated per record, for every format.
 */
export const sourceSchema = z
	.object({
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
		filter: expression.optional(),
	})
	.strict();
```

In `templateSchema`, replace
```ts
		key: z.object({ from: column }).strict(),
		slug: z.object({ from: column }).strict().optional(),
```
with:
```ts
		key: valueMapping,
		slug: valueMapping.optional(),
```

Replace
```ts
export type ValueErrorCode =
	| "not_scalar"
```
with:
```ts
export type ValueErrorCode =
	| "filter_error"
	| "filter_not_boolean"
	| "expr_error"
	| "expr_limit"
	| "not_scalar"
```

Replace the whole `applyTemplate` function (from `/** Applies the template to one record value (a CSV row object, a JSON value, an XML object). */` to its closing brace) with:
```ts
/** A template with its expressions parsed once, for every record of a batch. */
export interface CompiledTemplate {
	readonly template: Template;
	readonly filter: CompiledExpression | null;
	/** The key's `expr`, or null when it reads `from`. */
	readonly key: CompiledExpression | null;
	/** The slug's `expr`, or null when there is no slug or it reads `from`. */
	readonly slug: CompiledExpression | null;
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
}

/**
 * Parses every expression of the template (filter, key, slug, fields) once. Problems name the
 * template location: `source.filter: JSONata S0207 at character 7: Unexpected end of expression`.
 */
export function compileTemplate(
	t: Template,
): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const compile = (label: string, text: string | undefined): CompiledExpression | null => {
		if (text === undefined) return null;
		const result = compileExpression(text);
		if (result.ok) return result.expression;
		problems.push(`${label}: ${result.problem}`);
		return null;
	};
	const filter = compile("source.filter", t.source.filter);
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const fields = new Map<string, CompiledExpression>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, compiled: { template: t, filter, key, slug, fields } };
}

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	return `a ${typeof value}`;
}

/**
 * Runs the template's `source.filter` on one record value. `true` (or no filter) keeps the record;
 * `false`, an empty result or `undefined` skips it (`filtered`); anything else, or a failure,
 * fails it with `filter_not_boolean`, `filter_error` or `expr_limit`.
 */
export async function filterRecord(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ keep: boolean } | { error: ValueError }> {
	if (c.filter === null) return { keep: true };
	const result = await c.filter.evaluate(value);
	if (!result.ok) {
		const code = result.limit ? "expr_limit" : "filter_error";
		return { error: { field: "filter", code, message: result.message } };
	}
	if (result.value === true) return { keep: true };
	if (result.value === false || result.value === undefined) return { keep: false };
	const message = `The filter must give true or false; it gave ${kindOf(result.value)}`;
	return { error: { field: "filter", code: "filter_not_boolean", message } };
}

/** Marks a value whose expression failed; the failure is already in the record's errors. */
const FAILED = Symbol("failed");

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug and each field from `from` or `expr` and converts them, collecting every
 * error. An expression result goes through the same conversion as a path value, and `undefined`
 * reads as a missing path. Run `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] }> {
	const t = c.template;
	const errors: ValueError[] = [];
	const read = async (
		field: string,
		from: string | undefined,
		expr: CompiledExpression | null | undefined,
	): Promise<unknown> => {
		if (expr === null || expr === undefined) {
			return resolvePath(value, from ?? "", t.source.format);
		}
		const result = await expr.evaluate(value);
		if (result.ok) return result.value;
		errors.push({
			field,
			code: result.limit ? "expr_limit" : "expr_error",
			message: result.message,
		});
		return FAILED;
	};

	const keyField = t.key.from ?? "key";
	const keyRaw = await read(keyField, t.key.from, c.key);
	let key = "";
	if (keyRaw !== FAILED) {
		const keyText = scalarText(keyRaw);
		key = keyText?.trim() ?? "";
		if (keyText === null) {
			errors.push({ field: keyField, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
		} else if (key === "") {
			errors.push({ field: keyField, code: "missing_key", message: "The key column is empty" });
		} else if (key.length > MAX_KEY_LENGTH) {
			errors.push({
				field: keyField,
				code: "key_too_long",
				message: `Keys are limited to ${MAX_KEY_LENGTH} characters`,
			});
		}
	}

	let slug: string | undefined;
	if (t.slug) {
		const slugRaw = await read("slug", t.slug.from, c.slug);
		if (slugRaw !== FAILED) {
			const slugText = scalarText(slugRaw);
			if (slugText === null) {
				errors.push({ field: "slug", code: "not_scalar", message: NOT_SCALAR_MESSAGE });
			} else {
				slug = slugify(slugText);
				if (slug === "") {
					errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
				}
			}
		}
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
		const result = convert(mapping, raw);
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}
```

Replace the `templatePaths` doc comment and function with:
```ts
/**
 * Every source path the template reads: key, slug and field `from`s, without duplicates.
 * Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [t.key.from, t.slug?.from, ...Object.values(t.fields).map((m) => m.from)];
	return [...new Set(froms.filter((path): path is string => path !== undefined))];
}
```

- [ ] **Step 4: Add the `filtered` status and counter**

In `packages/flux-import/src/engine/types.ts`, replace
```ts
	conflict: number;
	failed: number;
}
```
with:
```ts
	conflict: number;
	failed: number;
	/** Records the template's filter skipped. Absent on jobs created before M3b (read as 0). */
	filtered: number;
}
```
replace
```ts
	| "failed"
	| "planned";
```
with:
```ts
	| "failed"
	| "planned"
	| "filtered";
```
and replace the body of `emptyCounters` with:
```ts
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
```

- [ ] **Step 5: Run batches on the compiled template**

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
import { applyTemplate, type MappedRecord, SOURCE_ID_FIELD } from "./template.js";
```
with:
```ts
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	filterRecord,
	type MappedRecord,
	SOURCE_ID_FIELD,
} from "./template.js";
```

In `processRecord`, add the parameter `template: CompiledTemplate,` after `job: Job,`, and replace `const row = await decide(deps, job, rec, existing, save);` with `const row = await decide(deps, job, template, rec, existing, save);`.

In `decide`, add the parameter `template: CompiledTemplate,` after `job: Job,`, and replace
```ts
	const mapped = applyTemplate(jobTemplate(job), rec.value);
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };
```
with:
```ts
	const filter = await filterRecord(template, rec.value);
	if ("error" in filter) {
		return { status: "failed", sourceKey: null, entryId: null, errors: [filter.error] };
	}
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };
```

In `importPass`, add the parameter `template: CompiledTemplate,` after `job: Job,` and replace `await processRecord(deps, job, rec, { retry: false });` with `await processRecord(deps, job, template, rec, { retry: false });`.

In `retryPass`, add the parameter `template: CompiledTemplate,` after `job: Job,` and replace
```ts
			await processRecord(deps, job, await readOneRecord(deps, job, row), { retry: true });
```
with:
```ts
			const rec = await readOneRecord(deps, job, row);
			await processRecord(deps, job, template, rec, { retry: true });
```

In `runBatch`, replace
```ts
		outcome =
			job.phase === "retry"
				? await retryPass(deps, job, started, limit)
				: await importPass(deps, job, started, limit);
```
with:
```ts
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job));
		if (!compiled.ok) {
			outcome = {
				done: false,
				error: { code: "invalid_template", message: compiled.problems.join("; ") },
			};
		} else {
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit)
					: await importPass(deps, job, template, started, limit);
		}
```
`counterFor` needs no change: its `default` branch returns `row.status`, and `filtered` is now a counter. The retry pass's status list (`failed`, `conflict`, `locked`, `writing`) leaves filtered rows alone.

- [ ] **Step 6: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/template.test.ts tests/unit/batch.test.ts`
Expected: PASS (61 tests in `template.test.ts`, 39 in `batch.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 26 files / 462 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/flux-import/src/engine packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/batch.test.ts
git commit -m "Take from or expr for every mapping, filter records, and map them asynchronously"
```

### Task 3: Jobs: expression checks at creation, filtered records, old jobs and routes

**Files:**
- Modify: `packages/flux-import/src/engine/jobs.ts` (`compileTemplate` at creation, `upgradeJob`, `updateJob`)
- Modify: `packages/flux-import/src/engine/batch.ts` (`claim` upgrades the stored job)
- Modify: `packages/flux-import/src/plugin/service.ts` (`getJob`, `listJobs`)
- Modify: `packages/flux-import/src/plugin/routes.ts` (`filtered` record status, `source.filter`)
- Modify: `packages/flux-import/tests/fixtures/formats.ts` (`SELECTION`, `withSelection`)
- Create: `packages/flux-import/tests/unit/selection.test.ts`
- Test: `packages/flux-import/tests/unit/jobs.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 2 `compileTemplate`, `filterRecord`, `applyTemplate`, `processRecord(deps, job, template, rec, opts)`, `Counters.filtered`, `RecordStatus` `"filtered"`, `emptyCounters()`; `buildLogCsv(deps, jobId, { status })` (log.ts, unchanged); fixtures `jsonTemplate`, `xmlTemplate`, `productsJson`, `productsJsonl`, `productsXml` (`tests/fixtures/formats.ts`), `productsCsv`, `template` (`tests/integration/fixtures.ts`); fakes `makeDeps()` (`deps.content.calls`, `afterWrite`, `failWrite`).
- Produces:
  - `upgradeJob(job: Job): Job` (`src/engine/jobs.ts`): the job with every counter, missing ones (a pre-M3b `filtered`) as 0.
  - `createJob` throws `JobError("invalid_template", "The template has invalid expressions", problems)` for any `compileTemplate` problem, before reading the source.
  - Routes: `jobs/records` and `jobs/log.csv` accept `status: "filtered"`; the `sources/sample` `source` schema accepts `filter` (and the sample ignores it).
  - Fixtures (`tests/fixtures/formats.ts`, used again by Tasks 4 and 5): `SELECTION: Record<"csv" | "json" | "jsonl" | "xml", { filter: string; title: string }>`; `withSelection<T extends { source?: Record<string, string>; fields: object }>(template: T, format)` returns the template with that format's `source.filter` and `fields.title = { expr, type: "text" }`. Over the 10-record fixtures the filter keeps SKU-4 to SKU-9 (price 4.5 and up) and filters SKU-0 to SKU-3; `title` becomes `"<sku> / <name>"`.

- [ ] **Step 1: Write the tests**

Append to `packages/flux-import/tests/fixtures/formats.ts`:
```ts
/**
 * Per format: a `source.filter` that keeps products 4 and up (price 4.5 and more) and an `expr`
 * that computes `title` as "<sku> / <name>". Expressions see the record the reader produces: CSV
 * cells are strings, so the CSV filter converts the price; XML `title` and `price` carry
 * attributes, so they are objects with `#text`.
 */
export const SELECTION = {
	csv: { filter: "$number(Price) > 4", title: "sku & ' / ' & Name" },
	json: { filter: "price.amount > 4", title: "sku & ' / ' & name" },
	jsonl: { filter: "price.amount > 4", title: "sku & ' / ' & name" },
	xml: {
		filter: "$number(price.`#text`) > 4",
		title: "`@sku` & ' / ' & title.`#text`",
	},
} as const;

/** `template` with its format's `SELECTION` filter and `title` expression. */
export function withSelection<T extends { source?: Record<string, string>; fields: object }>(
	template: T,
	format: keyof typeof SELECTION,
) {
	const { filter, title } = SELECTION[format];
	return {
		...template,
		source: { ...(template.source ?? { format: "csv" }), filter },
		fields: { ...template.fields, title: { expr: title, type: "text" } },
	};
}
```

Create `packages/flux-import/tests/unit/selection.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { buildLogCsv } from "../../src/engine/log.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { EngineDeps, Job } from "../../src/engine/types.js";
import { getJob, listJobs } from "../../src/plugin/service.js";
import {
	jsonTemplate,
	productsJson,
	productsJsonl,
	productsXml,
	withSelection,
	xmlTemplate,
} from "../fixtures/formats.js";
import { template as csvTemplate, productsCsv } from "../integration/fixtures.js";
import { makeDeps } from "./fakes.js";

const schemaFields = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "released", type: "datetime" },
];

async function setup(
	body: string,
	template: unknown,
	opts: { dryRun?: boolean; batchSize?: number } = {},
) {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", body);
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, ...opts });
	return { deps, clock, job };
}

async function runToEnd(deps: EngineDeps, id: string): Promise<Job> {
	for (let i = 0; i < 10_000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: EngineDeps, jobId: string) {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((r) => r.data);
}

const titles = (deps: ReturnType<typeof makeDeps>["deps"]) =>
	Object.fromEntries(
		[...deps.content.entries.values()].map((e) => [e.data.flux_source_id, e.data.title]),
	);

const FORMATS = [
	["CSV", productsCsv, withSelection(csvTemplate("products"), "csv"), 'Product 4, "quoted"'],
	[
		"JSON",
		(n: number) => productsJson(n),
		withSelection(jsonTemplate("products"), "json"),
		'Product 4, "quoted" & <tagged> ț',
	],
	[
		"JSON Lines",
		productsJsonl,
		withSelection(jsonTemplate("products", { format: "jsonl" }), "jsonl"),
		'Product 4, "quoted" & <tagged> ț',
	],
	[
		"XML",
		productsXml,
		withSelection(xmlTemplate("products"), "xml"),
		'Product 4, "quoted" & <tagged> ț',
	],
] as const;

describe.each(FORMATS)("filter and expr on %s", (_name, body, template, name4) => {
	it("imports the records the filter keeps, with computed titles, and counts the rest", async () => {
		const { deps, job } = await setup(body(10), template, { batchSize: 3 });
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed" });
		expect(done.counters).toEqual({
			created: 6,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 4,
		});
		expect(titles(deps)).toMatchObject({ "SKU-4": `SKU-4 / ${name4}` });
		expect(Object.keys(titles(deps)).sort()).toEqual(
			["SKU-4", "SKU-5", "SKU-6", "SKU-7", "SKU-8", "SKU-9"].sort(),
		);
		const statuses = (await rows(deps, job.id)).map((r) => [r.status, r.sourceKey]);
		expect(statuses.slice(0, 5)).toEqual([
			["filtered", null],
			["filtered", null],
			["filtered", null],
			["filtered", null],
			["created", "SKU-4"],
		]);
	});
});

describe("filtered records", () => {
	const csvSelection = withSelection(csvTemplate("products"), "csv");

	it("never reach the content port, and need no key", async () => {
		const body =
			"sku,Name,Price,Released,Handle\r\n,No key,1,01/03/2026,x\r\nS1,Cheap,2,01/03/2026,y\r\n";
		const { deps, job } = await setup(body, csvSelection);
		const touched: string[] = [];
		for (const method of [
			"get",
			"findBySourceId",
			"isLocked",
			"create",
			"update",
			"publish",
		] as const) {
			const original = deps.content[method].bind(deps.content) as (...a: unknown[]) => unknown;
			(deps.content as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
				touched.push(method);
				return original(...args);
			};
		}
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { filtered: 2, failed: 0 } });
		expect(touched).toEqual([]);
	});

	it("fails every record of a CSV filter that compares text with a number", async () => {
		const template = { ...csvTemplate("products"), source: { format: "csv", filter: "Price > 4" } };
		const { deps, job } = await setup(productsCsv(3), template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 0, failed: 3, filtered: 0 },
		});
		const errors = (await rows(deps, job.id)).map((r) => r.errors);
		expect(errors).toEqual(
			Array.from({ length: 3 }, () => [
				{
					field: "filter",
					code: "filter_error",
					message: expect.stringMatching(/^JSONata T2009 /),
				},
			]),
		);
		expect(deps.content.entries.size).toBe(0);
	});

	it("never include a record the reader could not parse: it fails as before", async () => {
		// A broken line has no value; run through the filter, it would read as filtered.
		const body = `${productsJsonl(5)}{"sku": "B", broken\n`;
		const template = withSelection(jsonTemplate("products", { format: "jsonl" }), "jsonl");
		const { deps, job } = await setup(body, template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 1, failed: 1, filtered: 4 },
		});
		expect((await rows(deps, job.id)).map((r) => [r.status, r.errors?.[0]?.code]).slice(4)).toEqual(
			[
				["created", undefined],
				["failed", "invalid_record"],
			],
		);
	});

	it("show as filtered in a dry run", async () => {
		const { deps, job } = await setup(productsCsv(6), csvSelection, { dryRun: true });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 2, filtered: 4 });
		expect((await rows(deps, job.id)).map((r) => r.status)).toEqual([
			"filtered",
			"filtered",
			"filtered",
			"filtered",
			"planned",
			"planned",
		]);
		expect(deps.content.entries.size).toBe(0);
	});

	it("are recounted, not double-counted, after a crash mid-batch", async () => {
		const { deps, clock, job } = await setup(productsCsv(10), csvSelection, { batchSize: 10 });
		let crashOn: string | null = "e2";
		deps.content.afterWrite = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ filtered: 4, failed: 0 });
		expect(done.counters.created + done.counters.conflict).toBe(6);
		const keys = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(keys).toHaveLength(6);
		expect(new Set(keys).size).toBe(6);
	});

	it("are not retried", async () => {
		const { deps, job } = await setup(productsCsv(10), csvSelection);
		let flaky = true;
		deps.content.failWrite = (data) =>
			flaky && data.flux_source_id === "SKU-5"
				? new ContentWriteError("timeout", "Upstream timeout")
				: null;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({
			created: 5,
			failed: 1,
			filtered: 4,
		});
		flaky = false;
		const callsBefore = deps.content.calls.length;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried).toMatchObject({
			status: "completed",
			counters: { created: 6, failed: 0, filtered: 4 },
		});
		expect(deps.content.calls.slice(callsBefore)).toEqual([
			"find:SKU-5",
			"create:e6",
			"publish:e6",
		]);
	});

	it("appear in the log CSV, which can be filtered to them", async () => {
		const { deps, job } = await setup(productsCsv(6), csvSelection);
		await runToEnd(deps, job.id);
		const lines = (await buildLogCsv(deps, job.id)).trimEnd().split("\r\n");
		expect(lines.slice(1, 6)).toEqual([
			"1,filtered,,,,,,",
			"2,filtered,,,,,,",
			"3,filtered,,,,,,",
			"4,filtered,,,,,,",
			"5,created,SKU-4,e1,create,,,",
		]);
		const only = (await buildLogCsv(deps, job.id, { status: "filtered" })).trimEnd().split("\r\n");
		expect(only).toHaveLength(5);
	});
});

describe("expression errors in a batch", () => {
	const template = {
		version: 1,
		collection: "products",
		locale: "en",
		source: { format: "json", filter: "$exists(keep) ? keep : price > 4" },
		key: { from: "sku" },
		fields: { title: { expr: "$uppercase(name)", type: "text" } },
	};

	it("fail only their record and the job completes", async () => {
		const body = JSON.stringify([
			{ sku: "A", price: 5, name: "a" },
			{ sku: "B", price: "5", name: "b" },
			{ sku: "C", price: 1, name: "c" },
			{ sku: "D", price: 7, name: { first: "d" } },
			{ sku: "E", price: 5, name: "e", keep: "yes" },
			{ sku: "F", price: 6, name: "f" },
		]);
		const { deps, job } = await setup(body, template);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 2, failed: 3, filtered: 1 },
		});
		expect((await rows(deps, job.id)).map((r) => [r.status, r.errors?.[0]?.code])).toEqual([
			["created", undefined],
			["failed", "filter_error"],
			["filtered", undefined],
			["failed", "expr_error"],
			["failed", "filter_not_boolean"],
			["created", undefined],
		]);
		expect(titles(deps)).toEqual({ A: "A", F: "F" });
	});

	it("reports a runaway expression as expr_limit", async () => {
		const runaway = {
			...template,
			source: { format: "json" },
			fields: { title: { expr: "($f := function($n) { $f($n + 1) }; $f(0))", type: "text" } },
		};
		const { deps, job } = await setup('[{"sku": "A"}]', runaway);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { failed: 1 } });
		expect((await rows(deps, job.id))[0]!.errors).toEqual([
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		]);
	});

	it("fails a stored job whose expression no longer compiles with invalid_template", async () => {
		const { deps, job } = await setup('[{"sku": "A", "price": 5, "name": "a"}]', template);
		const stored = (await deps.jobs.get(job.id))!;
		await deps.jobs.put(job.id, {
			...stored,
			template: { ...stored.template, source: { format: "json", filter: "price >" } },
		});
		const after = await runBatch(deps, job.id, "driver");
		expect(after).toMatchObject({
			status: "failed",
			error: {
				code: "invalid_template",
				message: "source.filter: JSONata S0207 at character 7: Unexpected end of expression",
			},
		});
		expect(deps.content.entries.size).toBe(0);
	});
});

describe("jobs created before M3b", () => {
	it("read a missing filtered counter as 0", async () => {
		const { deps, job } = await setup(productsCsv(2), csvTemplate("products"));
		const { filtered: _omit, ...oldCounters } = job.counters;
		await deps.jobs.put(job.id, { ...job, counters: oldCounters } as Job);
		expect((await getJob(deps, job.id)).counters.filtered).toBe(0);
		expect((await listJobs(deps, {})).items[0]!.counters.filtered).toBe(0);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toEqual({
			created: 2,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
		});
		expect((await deps.jobs.get(job.id))!.counters.filtered).toBe(0);
	});

	it("take a pause before their first batch and still read 0", async () => {
		const { deps, job } = await setup(productsCsv(2), csvTemplate("products"));
		const { filtered: _omit, ...oldCounters } = job.counters;
		await deps.jobs.put(job.id, { ...job, counters: oldCounters } as Job);
		const paused = await transitionJob(deps, job.id, "pause");
		expect(paused.counters.filtered).toBe(0);
	});
});
```

In `packages/flux-import/tests/unit/jobs.test.ts`, insert before `it("rejects a missing upload or unreadable header", async () => {`:
```ts
	it("rejects bad expressions with invalid_template, naming each one", async () => {
		const { deps } = setup();
		const bad = {
			...template,
			source: { format: "csv", filter: "Name = " },
			key: { expr: "$now()" },
		};
		await expect(
			createJob(deps, { uploadId: "u1", template: bad, schemaFields }),
		).rejects.toMatchObject({
			code: "invalid_template",
			message: "The template has invalid expressions",
			details: [
				"source.filter: JSONata S0207 at character 7: Unexpected end of expression",
				"key.expr: $now cannot be used: expressions must give the same result on every run",
			],
		});
		const both = { ...template, key: { from: "sku", expr: "sku" } };
		await expect(
			createJob(deps, { uploadId: "u1", template: both, schemaFields }),
		).rejects.toMatchObject({
			code: "invalid_template",
			details: ['key: Set exactly one of "from" and "expr"'],
		});
	});

	it("checks only from columns against the CSV header, and does not run expressions", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template: {
				...template,
				source: { format: "csv", filter: "Missing = 'x'" },
				fields: { title: { expr: "Nowhere & Name", type: "text" } },
			},
			schemaFields,
		});
		expect(job).toMatchObject({
			status: "created",
			source: { format: "csv", filter: "Missing = 'x'" },
			counters: { filtered: 0 },
		});
	});

```
and insert before `it("stores a warning for each path none of the first 20 records has", async () => {`:
```ts
	it("warns about from paths only, not about paths an expression reads", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", JSON.stringify([{ sku: "S1" }]));
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT(
				{ format: "json", filter: "nowhere = 1" },
				{ title: { expr: "missing.path", type: "text" } },
			),
			schemaFields,
		});
		expect(job.warnings).toEqual([]);
	});

```

In `packages/flux-import/tests/unit/definition.test.ts`, in "validates route input with Zod", insert after the `jobs/records` `status: "bogus"` expectation:
```ts
		for (const route of ["jobs/records", "jobs/log.csv"]) {
			expect(plugin.routes[route]!.input!.safeParse({ id: "J1", status: "filtered" }).success).toBe(
				true,
			);
		}
```
and in "accepts and rejects the same source blocks as the template schema", insert after `{ format: "json", records: "data.items" },`:
```ts
			{ format: "csv", filter: "Price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != ''" },
			{ format: "json", filter: "" },
			{ format: "json", filter: 5 },
```

- [ ] **Step 2: Run them to see which fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/selection.test.ts tests/unit/jobs.test.ts tests/unit/definition.test.ts`
Expected: FAIL — exactly 5 tests: "rejects bad expressions with invalid_template, naming each one" (`promise resolved … instead of rejecting`: creation does not compile expressions yet), "validates route input with Zod" and "accepts and rejects the same source blocks as the template schema" (the route schemas reject `filtered` and `filter`), and both "jobs created before M3b" tests (`expected undefined to be +0`). The other `selection.test.ts` tests already pass: they pin the batch behaviour Task 2 wired in (filtered rows, reader errors before the filter, the CSV text-versus-number trap, dry runs, crash recount, retry, log, expression errors).

- [ ] **Step 3: Check expressions at job creation and upgrade old jobs**

In `packages/flux-import/src/engine/jobs.ts`, add `compileTemplate,` after `checkTemplate,` in the `./template.js` import, and replace
```ts
	const template = parsed.data;

	const sourceProblems = checkSource(template.source);
```
with:
```ts
	const template = parsed.data;
	const compiled = compileTemplate(template);
	if (!compiled.ok) {
		throw new JobError("invalid_template", "The template has invalid expressions", compiled.problems);
	}

	const sourceProblems = checkSource(template.source);
```
Insert before `/** A stored job's template; templates stored before M3a have no source block and are CSV. */`:
```ts
/** A stored job with every counter; jobs created before M3b have no `filtered` counter. */
export function upgradeJob(job: Job): Job {
	return { ...job, counters: { ...emptyCounters(), ...job.counters } };
}

```
and in `updateJob` replace
```ts
		const next = { ...change(current.value), updatedAt: new Date(deps.now()).toISOString() };
```
with:
```ts
		const next = {
			...change(upgradeJob(current.value)),
			updatedAt: new Date(deps.now()).toISOString(),
		};
```

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
import { JobError, jobReader, jobTemplate, updateJob } from "./jobs.js";
```
with:
```ts
import { JobError, jobReader, jobTemplate, updateJob, upgradeJob } from "./jobs.js";
```
and in `claim` replace `const job = current.value;` with `const job = upgradeJob(current.value);` and
```ts
	if (!result.applied) return { ok: false, job: (await deps.jobs.get(jobId)) ?? job };
```
with:
```ts
	if (!result.applied) {
		const stored = await deps.jobs.get(jobId);
		return { ok: false, job: stored ? upgradeJob(stored) : job };
	}
```

- [ ] **Step 4: Read old jobs in the service and accept the new values in routes**

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
import { type CreateJobInput, createJob, JobError, transitionJob } from "../engine/jobs.js";
```
with:
```ts
import {
	type CreateJobInput,
	createJob,
	JobError,
	transitionJob,
	upgradeJob,
} from "../engine/jobs.js";
```
in `getJob` replace `return job;` with `return upgradeJob(job);`, and replace the body of `listJobs` with:
```ts
	const jobs = page(
		await deps.jobs.query({
			...(opts.status ? { where: { status: opts.status } } : {}),
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
	return { ...jobs, items: jobs.items.map(upgradeJob) };
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
	"failed",
	"planned",
] as const satisfies readonly RecordStatus[];
```
with:
```ts
	"failed",
	"planned",
	"filtered",
] as const satisfies readonly RecordStatus[];
```
and replace
```ts
const source = z
	.object({ format: format.default("csv"), records: z.string().min(1).optional() })
	.strict();
```
with:
```ts
const source = z
	.object({
		format: format.default("csv"),
		records: z.string().min(1).optional(),
		filter: z.string().min(1).optional(),
	})
	.strict();
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/selection.test.ts tests/unit/jobs.test.ts tests/unit/definition.test.ts`
Expected: PASS (16 tests in `selection.test.ts`, 37 in `jobs.test.ts`, 8 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 27 files / 481 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src packages/flux-import/tests/fixtures/formats.ts packages/flux-import/tests/unit
git commit -m "Reject bad expressions at job creation, count filtered records, and read old jobs with a filtered counter"
```

### Task 4: Node integration: a filter and an expression in every format

**Files:**
- Create: `packages/flux-import/tests/integration/selection.test.ts`

**Interfaces:**
- Consumes: Task 3 fixtures (`withSelection`, `SELECTION`) and the M3a ones (`jsonTemplate`, `xmlTemplate`, `productsJson`, `productsJsonl`, `productsXml` in `tests/fixtures/formats.ts`; `productsCsv`, `template` in `tests/integration/fixtures.ts`); harness `Client` (`createProducts`, `upload(body, filename)`, `plugin(route, input)`, `runToEnd`, `listAll`, `records(id, status)`, `raw(method, path)`), `ApiError`; `inject("baseUrl")`, `inject("token")` (shared dev server from `tests/integration/global-setup.ts`).
- Produces: one integration test file; no code.

- [ ] **Step 1: Write the test**

Create `packages/flux-import/tests/integration/selection.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import {
	jsonTemplate,
	productsJson,
	productsJsonl,
	productsXml,
	withSelection,
	xmlTemplate,
} from "../fixtures/formats.js";
import { ApiError, Client } from "./client.js";
import { template as csvTemplate, productsCsv } from "./fixtures.js";

const client = new Client(inject("baseUrl"), inject("token"));

const NAME_4 = 'Product 4, "quoted" & <tagged> ț';
const CASES = [
	{
		name: "CSV",
		collection: "it_sel_csv",
		filename: "feed.csv",
		body: productsCsv(10),
		template: (c: string) => withSelection(csvTemplate(c), "csv"),
		title4: 'SKU-4 / Product 4, "quoted"',
	},
	{
		name: "JSON",
		collection: "it_sel_json",
		filename: "feed.json",
		body: productsJson(10, { wrapped: true }),
		template: (c: string) =>
			withSelection(jsonTemplate(c, { format: "json", records: "data.products" }), "json"),
		title4: `SKU-4 / ${NAME_4}`,
	},
	{
		name: "JSON Lines",
		collection: "it_sel_jsonl",
		filename: "feed.jsonl",
		body: productsJsonl(10),
		template: (c: string) => withSelection(jsonTemplate(c, { format: "jsonl" }), "jsonl"),
		title4: `SKU-4 / ${NAME_4}`,
	},
	{
		name: "XML",
		collection: "it_sel_xml",
		filename: "feed.xml",
		body: productsXml(10),
		template: (c: string) => withSelection(xmlTemplate(c), "xml"),
		title4: `SKU-4 / ${NAME_4}`,
	},
];

describe.each(CASES)("filter and expr on $name (10 records)", (c) => {
	it("imports the six records the filter keeps with computed titles and logs the rest", async () => {
		await client.createProducts(c.collection);
		const { uploadId } = await client.upload(c.body, c.filename);
		const template = c.template(c.collection);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ status: "created", source: template.source, warnings: [] });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 6, filtered: 4, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(c.collection);
		expect(entries.map((e) => e.data.flux_source_id).sort()).toEqual([
			"SKU-4",
			"SKU-5",
			"SKU-6",
			"SKU-7",
			"SKU-8",
			"SKU-9",
		]);
		const four = entries.find((e) => e.data.flux_source_id === "SKU-4")!;
		expect(four).toMatchObject({ slug: "product-4", status: "published" });
		expect(four.data).toMatchObject({ title: c.title4, price: 4.5 });

		const filtered = await client.records(job.id, "filtered");
		expect(filtered.map((r) => [r.seq, r.sourceKey, r.entryId])).toEqual([
			[0, null, null],
			[1, null, null],
			[2, null, null],
			[3, null, null],
		]);
		const res = await client.raw(
			"GET",
			`/_emdash/api/plugins/flux-import/jobs/log.csv?id=${job.id}&status=filtered`,
		);
		expect(res.status).toBe(200);
		expect((await res.text()).trimEnd().split("\r\n").slice(1)).toEqual([
			"1,filtered,,,,,,",
			"2,filtered,,,,,,",
			"3,filtered,,,,,,",
			"4,filtered,,,,,,",
		]);

		// The same file again: expressions are deterministic, so nothing changes.
		const again = await client.plugin("jobs/create", {
			uploadId: (await client.upload(c.body, c.filename)).uploadId,
			template,
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({
			unchanged: 6,
			updated: 0,
			filtered: 4,
		});
	});
});

describe("expressions at job creation", () => {
	it("answers 400 INVALID_TEMPLATE for a syntax error or a banned function", async () => {
		await client.createProducts("it_sel_bad");
		const { uploadId } = await client.upload(productsJson(2), "bad.json");
		for (const patch of [
			{ source: { format: "json", filter: "price.amount >" } },
			{ key: { expr: "sku & $random()" } },
			{ key: { from: "sku", expr: "sku" } },
		]) {
			const error = await client
				.plugin("jobs/create", {
					uploadId,
					template: { ...jsonTemplate("it_sel_bad"), ...patch },
					dryRun: true,
				})
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status: 400, code: "INVALID_TEMPLATE" });
		}
	});
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter flux-import exec vitest run --config vitest.integration.config.ts tests/integration/selection.test.ts --reporter=verbose`
Expected: PASS (5 tests; about 1 s of tests plus the dev server start). The second run in each case proves Review Focus 4: the same file reports 6 `unchanged` and 4 `filtered`.

- [ ] **Step 3: Run the whole integration suite**

Run: `pnpm test:integration`
Expected: PASS (7 files / 34 tests, about 7 minutes). Then `pnpm typecheck && pnpm lint && pnpm test`. `git status` must show only this task's file: the global setup restores `sites/dev/emdash-env.d.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/flux-import/tests/integration/selection.test.ts
git commit -m "Prove a filter and an expression end to end in CSV, JSON, JSON Lines and XML"
```

### Task 5: workerd parity: a filter, an expression and a runaway expression on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Task 3 `withSelection`; `jsonTemplate`, `productsJson` (`tests/fixtures/formats.ts`); parity harness (`client`, `inject("cfBaseUrl")`, `inject("cfToken")`); `Client.records(id, status)`.
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
import { jsonTemplate, productsJson } from "../fixtures/formats.js";
```
with:
```ts
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
```
and insert before `it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {`:
```ts
	it("filters and computes JSON records, and stops a runaway expression by its step count", async () => {
		await client.createProducts("cf_select");
		const { uploadId } = await client.upload(productsJson(10), "feed.json");
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: withSelection(jsonTemplate("cf_select"), "json"),
			dryRun: false,
			batchSize: 4,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 6, filtered: 4, failed: 0 },
		});
		const entries = await client.listAll("cf_select");
		expect(entries.find((e) => e.data.flux_source_id === "SKU-4")?.data.title).toBe(
			'SKU-4 / Product 4, "quoted" & <tagged> ț',
		);

		// workerd does not advance Date.now() during pure CPU work, so JSONata's timeout never
		// fires there; only the step counter can end this expression.
		const runaway = jsonTemplate("cf_select");
		const template = {
			...runaway,
			fields: {
				...runaway.fields,
				title: { expr: "($f := function($n) { $f($n + 1) }; $f(0))", type: "text" },
			},
		};
		const one = await client.upload(productsJson(1), "one.json");
		const stuck = await client.plugin("jobs/create", {
			uploadId: one.uploadId,
			template,
			dryRun: false,
		});
		expect(await client.runToEnd(stuck.id)).toMatchObject({
			status: "completed",
			counters: { failed: 1 },
		});
		const [row] = await client.records(stuck.id, "failed");
		expect(row?.errors).toEqual([
			{
				field: "title",
				code: "expr_limit",
				message: "Expression exceeded 100000 evaluation steps",
			},
		]);
	});

```

- [ ] **Step 2: Run the new test on workerd**

Run: `pnpm --filter flux-import exec vitest run --config vitest.cf.config.ts -t runaway --reporter=verbose`
Expected: PASS (1 test, about 12 s plus 30 s of server start; the other four are skipped). This proves that `jsonata` loads under workerd (J9) and that the step counter ends a runaway expression there as `expr_limit` with the step message (Review Focus 5). The full `pnpm test:cf` takes about 15 minutes because of its 10,000-row case; it runs in Task 6.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove filters, expressions and the step limit on workerd"
```

### Task 6: M3b review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-14-m3b-review.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 15 minutes, almost all of it the unchanged 10,000-row case). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with a PAT, record each result:
1. Upload a 10-row products CSV (columns `sku,Name,Price`, prices 0.5 to 9.5) and create a dry run into `posts` with `source: { format: "csv", filter: "$number(Price) > 4" }`, `key: { from: "sku" }` and `title: { expr: "sku & ' / ' & Name", type: "text" }`: the job completes with `created: 6` (planned) and `filtered: 4`; `jobs/records` with `status: "filtered"` lists 4 rows; the planned changes show titles like `SKU-4 / …`.
2. `jobs/create` with `key: { expr: "$now()" }`: HTTP 400 `INVALID_TEMPLATE`, message `The template has invalid expressions`, `details.problems` = `["key.expr: $now cannot be used: expressions must give the same result on every run"]`. Then with `source.filter` = `$contains(Name, /desk/i)`: 400 `INVALID_TEMPLATE`, `details.problems` = `["source.filter: Regular expressions are not supported in templates"]`.
3. A real run of one record with `title: { expr: "($f := function($n) { $f($n + 1) }; $f(0))", type: "text" }`: the record fails with `expr_limit` ("Expression exceeded 100000 evaluation steps"), the job completes, and `/_emdash/api/health` answers at once afterwards.
4. `GET jobs/log.csv?id=<check 1 job>&status=filtered`: a CSV with the header and 4 `filtered` lines.
5. Restore `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-14-m3b-review.md` from this template and fill in every `…`:
````markdown
# Milestone 3b review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0  ·  jsonata 2.2.2

## Automated checks

| Command | Result | Summary (files / tests / duration) |
| --- | --- | --- |
| `pnpm typecheck` | … | … |
| `pnpm lint` | … | … |
| `pnpm test` | … | … |
| `pnpm test:integration` | … | … |
| `pnpm test:cf` | … | … |

## Spec "Testing" coverage

| Item | Evidence | Result |
| --- | --- | --- |
| Sandbox: step, time, depth and sequence limits give `expr_limit`; `$eval` blocked; `$now`, `$millis`, `$random` rejected (lambdas included, string literals allowed); regex literals rejected anywhere, string patterns literal; 4 KiB cap; syntax errors with code and position | `expressions.test.ts` | … |
| Template: exactly one of `from` and `expr`; filters for every format; existing templates unchanged | `template.test.ts` | … |
| Engine: filter true, false, empty, non-boolean, errors; `expr` on key, slug and fields; typed conversion of results; `filtered` counter and status; dry runs; content port never called; crash resume; retry skips filtered; old jobs read 0; log CSV | `template.test.ts`, `selection.test.ts`, `jobs.test.ts` | … |
| Integration: one import per format with a filter and an `expr` field | `tests/integration/selection.test.ts` | … |
| workerd: JSON filter and expression, runaway expression ends as `expr_limit` | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | CSV dry run with a filter and an expression | … | … |
| 2 | Banned function and regex rejected at creation | … | … |
| 3 | Runaway expression ends as `expr_limit` | … | … |
| 4 | Log CSV filtered to `filtered` | … | … |
| 5 | Working tree clean | … | … |

## Regular expressions and single-step work

Regex literals are rejected at job creation (user ruling; a backtracking regex ran for 85 s on a 36-character string, J8 in the plan). A safe regex engine may come later. What remains is size-bound single-step work such as `$pad` with a huge width (about 2 s for 100 million characters on Node, J11), ended by V8's length limits.

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-14-m3b-review.md
git commit -m "Add the Milestone 3b review results"
```

---

## After this plan

M3b ends here with the review stop. M3c adds URL sources behind `SourcePort`; M3d adds XLSX with a row-index cursor. Expressions stay deterministic until a later milestone adds a fixed job timestamp. The M2 and M3a open issues (`docs/superpowers/notes/2026-10-08-m2-review.md`, `docs/superpowers/notes/2026-10-12-m3a-review.md`) are unchanged by this plan; expressions add CPU per record, which matters most on Workers, where `WORKERS_BATCH_CAP` (20 records per `jobs/next`) still bounds a call.
