# Flux Import M3b: record filters and JSONata field transforms

Status: draft for review. Part of Milestone 3 (Sources) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md). Builds on
[M3a](./2026-10-12-flux-import-m3a-formats-design.md) (JSON, JSON Lines, XML and pasted
sources), merged at `fab72bf`.

## Goal

Let a template skip records it does not want and compute field values from a record, in every
source format, without giving up any M2 or M3a guarantee: bounded memory, exact resume,
idempotent batches, per-record errors that never fail the job, and no duplicates after a crash.

## Decisions

| Topic | Decision |
| --- | --- |
| Expression language | JSONata (`jsonata@2.2.2`, pinned exactly) for both record filters and field transforms, in every format. No JSONPath or XPath engines. The M3a simple paths stay for plain mappings. |
| Record selection | M3a's `source.records` still locates records. M3b adds a per-record `source.filter`; it does not change how records are found. |
| Template version | Stays `version: 1`. All additions are optional, so existing templates stay valid and behave exactly as before. |
| Determinism | Expressions must be deterministic. `$now`, `$millis` and `$random` are rejected at job creation: re-imports report `unchanged` and crash repair compares planned data with stored data, both of which need the same input to give the same output. |
| `$eval` | Disabled. |
| Limits | Fixed in code, not configurable from a template (see Safety). |
| New dependency | `jsonata` only. MIT, no dependencies, about 80 KB minified, no `eval` or `new Function`, so it runs on workerd. |

## Template additions

```json
"source": { "format": "xml", "records": "rss/channel/item", "filter": "category = 'Desks' and price > 0" },
"key":    { "from": "@sku" },
"slug":   { "expr": "$lowercase($replace(title, ' ', '-'))" },
"fields": {
  "title": { "from": "title", "type": "text" },
  "price": { "expr": "$round($number(price) * 1.2, 2)", "type": "number" },
  "name":  { "expr": "first & ' ' & last", "type": "text" }
}
```

- `source.filter`: optional JSONata expression, allowed for every format (`csv`, `json`,
  `jsonl`, `xml`).
- `key`, `slug` and each field take exactly one of `from` (an M3a path or CSV column) or
  `expr` (a JSONata expression). Both or neither is a template error. Date fields keep their
  `format` and `tz` options with either.
- Expressions run against the same record object the M3a readers produce:
  - CSV: an object of column name to string. Names with spaces or symbols use backticks
    (`` `Unit Price` ``).
  - JSON and JSON Lines: the parsed record.
  - XML: the M3a element object. Attributes and text are `` `@sku` `` and `` `#text` ``.

## Semantics

### Filter

The filter is evaluated once per record:

| Result | Outcome |
| --- | --- |
| `true` | The record is imported |
| `false`, empty sequence or `undefined` | The record is skipped with status `filtered` |
| Anything else (a string, number, object, array) | The record fails with `filter_not_boolean` |
| The evaluation throws | The record fails with `filter_error`, or `expr_limit` for a limit |

A record that already has an `error` from the reader (`invalid_record`) fails as before, and its
filter is not evaluated.

### Order for each record

1. Read the record (M3a reader).
2. Evaluate the filter. A filtered record stops here: the key is not resolved and EmDash is never
   called.
3. Resolve `key`, then `slug`, from `from` or `expr`.
4. Resolve each field from `from` or `expr`.
5. Convert values with the M3a typed conversion (`not_scalar`, numbers into text, dates and so
   on). An expression result goes through exactly the same conversion as a path value; an
   `undefined` result is treated like a missing path (`null`).

All expression errors for a record are collected, like M3a value errors, so one record can report
several failing fields.

### `filtered` status and counter

- `RecordStatus` gains `filtered`; `Counters` gains `filtered`. Jobs created before M3b have no
  `filtered` counter and read it as `0`.
- A filtered record gets a record row like any other record, so a crash-revisited record is
  recounted correctly (the M2 counter-recount rule applies unchanged).
- Dry runs report filtered records with status `filtered`.
- The log CSV includes filtered records; its status filter accepts `filtered`.
- The retry pass does not retry filtered records (they are not failures).

## Safety

Each evaluation runs with these limits:

| Limit | Value | Mechanism |
| --- | --- | --- |
| Steps | 100,000 per evaluation | A counter in JSONata's `__evaluate_entry` hook that throws past the limit. This is the bound that holds on Workers, where `Date.now()` does not advance during pure CPU work and so a wall-clock timeout never fires. |
| Time | 1,000 ms per evaluation | JSONata's `timeout` option (code `D1012`), a backstop on Node. |
| Depth | 200 | JSONata's `stack` option (code `D1011`). |
| Sequence length | 100,000 | JSONata's `sequence` option (code `D2015`). |
| Expression length | 4 KiB | Checked at job creation. |
| Input | One record, at most 4 MiB | Existing M3a record cap. |

- `$eval` is bound to a function that throws, so it is never available to a template.
- `$now`, `$millis` and `$random` are rejected by walking the parsed expression tree for function
  calls with those names, including inside lambdas and nested blocks. A name inside a string
  literal is not a call and is allowed.
- Templates cannot define `$` variables or functions for expressions in M3b.
- Regular expression literals (`/…/`) are rejected at job creation, wherever they appear in an
  expression. A regex runs as one step that no limit can interrupt, and a pattern with nested
  repeats (`/(a+)+$/`) ran for 85 s on a 36-character string in testing; on Workers that would
  kill the batch and retry it forever. String patterns in `$contains`, `$split` and `$replace`
  match literal substrings and stay allowed. A linear-time regex engine may come later.

## Compilation

- `compileTemplate(template)` parses every expression once (filter, key, slug, fields), checks the
  length cap and banned functions, and returns compiled handles with the limits applied.
- Job creation calls it to validate the template; any problem fails creation with
  `invalid_template`.
- Each batch calls it once and reuses the handles for all of its records. There is no cache
  across batches (batches are separate invocations on Workers).
- Record mapping becomes `async`, because JSONata's `evaluate` is async.

## Errors

| Level | Code | When |
| --- | --- | --- |
| Job creation | `invalid_template` | Expression syntax error (message names the JSONata code and character position); expression over 4 KiB; a banned function; a regular expression literal; both or neither of `from` and `expr` |
| Record | `filter_error` | The filter throws |
| Record | `filter_not_boolean` | The filter returns something other than a boolean, empty or `undefined` |
| Record | `expr_error` | A key, slug or field expression throws; `field` names the template field (or `key` or `slug`) and the message includes the JSONata code |
| Record | `expr_limit` | A step, time, depth or sequence limit is hit in the filter or an expression, so users can tell "this data broke the expression" from "this expression is too heavy" |
| Record | M3a codes | `not_scalar`, `missing_key`, `invalid_number`, `invalid_date` and so on, applied to expression results |

Every record-level error fails only that record; the job continues. The retry pass evaluates
again.

## Job creation checks

- Missing-path warnings (M3a) cover `from` paths only. Expressions are not analysed for the paths
  they read.
- CSV header checks (M3a) cover `from` columns only.
- The filter and expressions are not run against the sample at creation time; problems with data
  show up as record errors.

## Routes

No new routes. `jobs/create` accepts the extended template and reports `invalid_template` for the
problems above. Job and record responses include the `filtered` counter and status.

## Testing

- Unit, sandbox: the step, time, depth and sequence limits each give `expr_limit`; `$eval`
  is blocked; `$now`, `$millis` and `$random` are rejected, including inside lambdas, and allowed
  inside string literals; regex literals are rejected in any position and string patterns are
  allowed; the 4 KiB cap; syntax errors report code and position.
- Unit, template: exactly one of `from` and `expr`; filters allowed for every format; existing
  templates parse and behave as before.
- Unit, engine: filter `true`, `false`, empty and non-boolean; filter errors; `expr` on key, slug
  and fields; typed conversion of expression results (`not_scalar`, numbers into text, dates);
  the `filtered` counter and status; dry runs show filtered records; filtered records never call
  the content port; crash resume gives the same counters and no duplicates; the retry pass skips
  filtered records; old jobs without `filtered` read it as `0`; the log CSV includes filtered rows.
- Integration on `sites/dev`: one import per format (CSV, JSON, JSON Lines, XML), each with a
  filter and an `expr` field.
- Cloudflare parity on `sites/dev-cf`: one JSON import with a filter and an expression, plus a
  runaway expression that ends as `expr_limit` (proving the step counter works where the clock
  does not advance).

## Out of scope for M3b

URL sources (M3c); XLSX (M3d); template-defined variables or functions; non-deterministic
functions (a fixed job timestamp may come later); regular expressions (a linear-time engine may
come later); JSONPath or XPath; analysing expressions for missing-path warnings.
