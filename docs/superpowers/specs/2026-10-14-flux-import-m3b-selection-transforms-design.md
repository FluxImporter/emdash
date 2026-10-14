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
| Determinism | Expressions must be deterministic. `$now`, `$millis`, `$random` and `$shuffle` are rejected at job creation: re-imports report `unchanged` and crash repair compares planned data with stored data, both of which need the same input to give the same output. |
| Built-in functions | An allowlist (see Safety). `$eval` and every other built-in outside it fail job creation. |
| Limits | Fixed in code, not configurable from a template (see Safety). |
| New dependency | `jsonata` only. MIT, no dependencies, about 80 KB minified, no `eval` or `new Function`, so it runs on workerd. |

## Template additions

```json
"source": { "format": "xml", "records": "rss/channel/item", "filter": "category = 'Desks' and $number(price) > 0" },
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
| Steps | 100,000 per evaluation | A counter in JSONata's `__evaluate_entry` and `__evaluate_exit` hooks that throws past the limit. Each step is weighted by the size of what it reads and produces (see below). On Workers, where `Date.now()` does not advance during pure CPU work so a wall-clock timeout never fires, this count is the only bound. |
| Time | 1,000 ms per evaluation | JSONata's `timeout` option (code `D1012`), a backstop on Node. |
| Depth | 200 | JSONata's `stack` option (code `D1011`). |
| Sequence length | 100,000 | JSONata's `sequence` option (code `D2015`). |
| Expression length | 4 KiB | Checked at job creation. |
| Input | One record, at most 4 MiB | Existing M3a record cap. |

Work that happens inside JSONata (inside one built-in call or one operator) is not a step, and
on Workers it runs until the isolate's CPU or memory limit kills the batch, which is then retried
forever. Every rule below exists to keep that work proportional to something the count charges.

**Step weighting.** Entering a node is one step. When a node finishes, its result adds its length
if it is an array, plus one step per 256 bytes of its approximate size: a string's length, or the
summed size of an array's or object's members and keys (cached per object, so reading the same
large object again is cheap to measure but charged again). Two kinds of node read a value no node
produced, such as the record itself, and are charged for it when they start: a built-in call that
takes its argument from the context (`$keys()` inside a lambda) and a field name looked up on an
array. A loop that reads a large value, compares large objects with `=`, or builds large results
therefore runs out of steps in proportion to the data. The weighting has a cost: reading an array
of more than about 40,000 elements, or a string of several MiB more than a few times, ends as
`expr_limit`.

**Allowlisted built-ins.** Templates may call only these built-ins, each checked to do work about
linear in its arguments and result:

- Strings: `$string`, `$substring`, `$substringBefore`, `$substringAfter`, `$lowercase`,
  `$uppercase`, `$length`, `$trim`, `$pad`, `$contains`, `$replace`, `$split`, `$join`,
  `$encodeUrlComponent`, `$encodeUrl`, `$decodeUrlComponent`, `$decodeUrl`.
- Numbers: `$number`, `$floor`, `$ceil`, `$round`, `$abs`, `$sqrt`, `$power`, `$formatBase`, `$sum`,
  `$max`, `$min`, `$average`.
- Booleans and types: `$boolean`, `$not`, `$exists`, `$type`.
- Arrays and objects: `$count`, `$map`, `$filter`, `$single`, `$reduce`, `$append`, `$reverse`,
  `$lookup`, `$keys`.
- Dates: `$toMillis`, `$fromMillis`.

Any reference to another JSONata built-in (a call, a reference passed as a value, a partial
application, either side of `~>`, a variable or parameter of that name) fails job creation with
`invalid_template`: "$sort is not available in templates". That covers `$sort` (a quadratic merge
that no step counts: 6.7 s on 45,000 numbers), `$distinct` (quadratic deep comparison), `$clone`,
`$eval`, `$match`, `$formatNumber`, `$formatInteger` and `$parseInteger` (picture analysis
quadratic in a picture that may come from the record), `$base64encode` and `$base64decode`,
`$spread`, `$merge`, `$each`, `$sift`, `$zip`, `$error` and `$assert`. `$now`, `$millis`, `$random`
and `$shuffle` keep their own message (expressions must be deterministic). The order-by operator
`^(…)` stays: it evaluates its sort key for each comparison, so its work is counted.

**Built-ins are called, not passed around.** An allowed built-in may only appear as a direct call:
`$string(x)`, `x ~> $string()` or `items.$string()`. Passing one as a value (`$map(xs, $string)`),
partially applying it (`$substring(s, ?)`), binding it to a variable, or naming a variable or
parameter after it fails job creation. A built-in handed to `$map` or `$reduce` runs once per
element natively, and a partial application can fix a 4 MiB argument for every call, with no node
charging for either. A lambda (`function($v) { $string($v) }`) does the same with every call
counted. The template's own variables and lambdas, with other names, are allowed.

**Operators rejected at job creation.** Regular expression literals (`/…/`), anywhere: a regex
runs as one step that no limit can interrupt, and `/(a+)+$/` ran for 85 s on a 36-character string
in testing. String patterns in `$contains`, `$split` and `$replace` match literal substrings and
stay allowed; those three take only string patterns (not matcher functions). The transform
operator `|…|`, which deep-copies its input. The wildcards `*` and `**`: `*` concatenates arrays
quadratically and took 7.4 s on a record with 100,000 array-valued keys.

**Caps and checks inside allowed built-ins.** These are replaced with versions that behave the
same except as listed:

- `$pad` widths are capped at 10,000 characters (`expr_error` past it).
- `$fromMillis` pictures are capped at 256 characters and their width modifiers at 64 (`expr_error`
  past them): JSONata pads a component to its width in one call (`[Y,100000000]` built 1.65 GB).
  The picture is scanned without a regular expression.
- `$toMillis` with a picture string fails with `expr_error`: JSONata turns the picture into a
  regular expression and runs it on the value (16 `[f]` on a 38-character value took 107 s). The
  picture can come from the record, so this is checked at evaluation. The ISO 8601 form stays;
  date fields' `format` option parses other layouts.
- `$length` and `$substring` count code points without building an array of every character
  (JSONata's own versions held about 308 MB for a 4 MiB string).
- `$string` with indentation (`$string(x, true)`) fails with `expr_error`: indenting a value
  nested a few thousand deep builds a string quadratic in its depth.
- `$replace`, `$split` and `$join` count what they would build first and end as `expr_limit`
  before building more than the steps left allow (`$replace(s, 'x', s)`, `$split(s, '')`).

**What this bounds, and what it does not.** With these rules the worst expressions found in
testing (loops over `$pad`, `$replace`, `$encodeUrlComponent`, deep `=`, objects, the order-by
operator) end as `expr_limit` within about 0.35 s on Node 22 without a clock, and one evaluation
can build at most about 25 million characters of strings. That is a measured bound, not a proof:
JSONata does other work inside operators, and an operator or built-in found to do more than linear
work in what is charged needs its own rule. On Node the 1,000 ms timeout remains a backstop, which
makes `expr_limit` from it depend on machine load.

## Compilation

- `compileTemplate(template)` parses every expression once (filter, key, slug, fields), checks the
  length cap and the rules in Safety, and returns compiled handles with the limits applied.
- Job creation calls it to validate the template; any problem fails creation with
  `invalid_template`.
- Each batch calls it once and reuses the handles for all of its records. There is no cache
  across batches (batches are separate invocations on Workers).
- Record mapping becomes `async`, because JSONata's `evaluate` is async.

## Errors

| Level | Code | When |
| --- | --- | --- |
| Job creation | `invalid_template` | Expression syntax error (message names the JSONata code and character position); expression over 4 KiB; `$now`, `$millis`, `$random` or `$shuffle`; a built-in outside the allowlist, or an allowed one not called directly; a regular expression literal; the transform operator; a wildcard; both or neither of `from` and `expr` |
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

- Unit, sandbox: the step, time, depth and sequence limits each give `expr_limit`; `$now`,
  `$millis`, `$random` and `$shuffle` are rejected, including inside lambdas, and allowed inside
  string literals; every built-in outside the allowlist (`$eval` included) is rejected in every
  form, every allowed one works, and allowed ones must be called directly; the list of built-ins
  matches the ones JSONata defines; the transform operator and wildcards are rejected; regex
  literals are rejected in any position and string patterns are allowed; the caps on `$pad`,
  `$fromMillis` and `$string`; `$length` and `$substring` match JSONata's results; loops over
  large strings, arrays and objects, deep `=`, and oversized `$replace`, `$split` and `$join` end
  as `expr_limit` without a clock; the 4 KiB cap; syntax errors report code and position.
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
