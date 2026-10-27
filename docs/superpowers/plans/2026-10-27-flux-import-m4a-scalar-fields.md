# Flux Import M4a: scalar field types and `schema/apply` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 runs first and alone; Tasks 1 and 2, and later Tasks 4 and 5, can run in parallel worktrees (see "Parallel execution").

**Goal:** Map source values into every EmDash field type that holds a plain value (`boolean`, `select`, `multiSelect`, `datetime` with a site or IANA timezone or as a calendar date in a text field, `number` and `integer` with locale separators, `json`, custom `slug` fields), check each value against the target field's EmDash rules before writing so a dry run reports what a real run would hit, and add an additive `schema/apply` route that creates missing fields and select options. Templates stay `version: 1`; every addition is optional.

**Architecture:** Conversion moves out of `template.ts` into two pure modules. `src/engine/values.ts` builds one converter per mapping for numbers (thousands and decimal separators), booleans (token lists), selects and multi-selects (a `map`, then the field's options, ignoring case by default) and JSON, plus `checkRules`, the field rules EmDash enforces on writes (`required`, whole numbers, `min`/`max`, `minLength`/`maxLength`, `pattern`). `src/engine/dates.ts` reads ISO text, Luxon formats and Unix times in a zone, refuses a local time in a DST gap, takes the earlier instant in an overlap, and writes EmDash's canonical UTC form or a formatted calendar date for text fields. `template.ts` gains the new mapping types and options, builds the converters in `compileTemplate` from a context (the job's target field snapshot and site timezone), and runs the rules in `applyTemplate`. At job creation `listSchemaFields` reads each field's type, `required`, default and validation, `checkTemplate` checks the mapping against them (the compatibility table, `output` into datetime, `map` values that are not options, unmapped required fields, unusable fields, an invalid site timezone), and `createJob` stores the snapshot (`targetFields`) and, for `tz: "site"` templates, the site timezone the route read with `getSiteSetting("timezone")`. `planRecord` compares by target type (instants, booleans against EmDash's stored 0/1, deep equality for multi-selects and JSON). `src/plugin/schema-apply.ts` plans requested fields (or a template's) against the collection and applies them with `SchemaRegistry.createField`/`updateField`, then clears the caches EmDash's REST handler clears.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine, `astro/zod` in routes), Luxon 3.7, Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-27-flux-import-m4a-scalar-fields-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 4 split). Previous plan: `docs/superpowers/plans/2026-10-27-flux-import-m3d-xlsx.md`; its review: `docs/superpowers/notes/2026-10-27-m3d-review.md`.

Every code block in Tasks 1 to 8 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite, and the new workerd parity test on its own), then replayed task by task from `f3f3a23` (the code the spec commit `83e6a41` builds on; it changes only docs) by a script that applies this document's code blocks and replacements; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0.

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. One new plugin route, `schema/apply` (`import:execute`, `POST`); no new option and no new capability (plugins have none for writing schema, Fact E10).
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine's template schema uses `zod`; plugin route input schemas use `astro/zod`.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code; the schema changes through `runtime.schemaRegistry` (`createField`, `updateField`), never SQL. Content stays row-per-locale and every content call passes the template's locale, as before.
- Vitest runs from `packages/flux-import` with name filters: `pnpm exec vitest run values` (from the repo root, `pnpm --filter flux-import exec vitest run tests/unit/x.test.ts` finds no files). Integration: `pnpm exec vitest run --config vitest.integration.config.ts field-types`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M4a type"`. The workerd harness uses port 4396 and the Node harness 4399 (plus 4395 and 4398 for the suites that start their own server): never run two copies of the same harness at once.
- Error codes, exactly: the new value codes (`invalid_boolean`, `invalid_integer`, `invalid_option`, `too_many_items`, `invalid_json`, `value_too_large`, `required`, `out_of_range`, `too_short`, `too_long`, `pattern_mismatch`) are record errors, never job errors; template problems at job creation stay `invalid_template` (400) with one problem per field; `schema/apply` answers `VALIDATION_ERROR` (400) for invalid input and `COLLECTION_NOT_FOUND` (404) for an unknown collection, and reports an EmDash `SchemaError` in its response body (`error: { code, message }`), not as an HTTP error.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 7 also passes its integration file (about 10 s with server start) and `pnpm test:integration` (about 9 minutes), Task 8 the targeted workerd test (about 45 s); Task 9 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. A value that EmDash would refuse, or store as something else, must fail the record before the write, with the same verdict in a dry run — tests in Task 3 ("collects conversion and rule errors from every field", "checks records against the job's target snapshot and reads tz: site in its timezone") and Task 7 ("reports invalid_option, invalid_integer, required and a DST gap in a dry run without writing").
2. Dates must be exact instants: a local time in a DST gap fails, an overlap takes the earlier instant (Luxon alone does neither consistently, Fact L1), an explicit offset wins over `tz`, and `tz: "site"` uses the timezone stored on the job — tests in Task 2 ("fails a local time in a DST gap and takes the earlier instant in an overlap") and Task 7 (the CSV import reads `released` in Europe/Chisinau).
3. A re-run of the same source must plan `unchanged` for every type: booleans against the stored 0/1, multi-selects and JSON deeply, datetimes as instants — tests in Task 4 ("compares booleans with EmDash's stored 0 and 1", "compares multiSelect and json values deeply") and Task 7 ("re-runs as unchanged" for CSV and JSON).
4. `schema/apply` must be additive only: it never changes a field's type, never creates required, unique or defaulted fields, adds options without dropping the existing validation, and survives a concurrent creator and a mid-run `SchemaError` — tests in Task 6 ("adds missing options after the existing ones, keeping the rest of the validation", "re-plans a field another request created first", "stops at an EmDash error, returning what was applied, and a rerun is safe") and Task 7 ("leaving a conflicting field alone").
5. Jobs created before M4a must behave as in M2 (no snapshot: no rules, dates into datetime, mapping-type diff) — tests in Task 3 ("keeps M2 behaviour for jobs without a target snapshot") and Task 4 ("compares date mappings as instants for jobs without a target snapshot").

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1 and V2 are the facts the spec left unconfirmed; Task 0 re-checks them before any code is written.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | `getSiteSetting("timezone")` (imported from `emdash`) works inside a plugin route reached through `withEmDashRuntime()`, on Node and on workerd. It reads the `site:timezone` option through `getDb()`, which takes the request's database from the request context (`src/settings/index.ts:182-203`, `src/loader.ts:1576-1597`), cached per request only, so a value set by an earlier request is seen. Tests set it with `POST /_emdash/api/settings { "timezone": "Europe/Chisinau" }` (Bearer PAT; `settings:manage`; `src/astro/routes/api/settings.ts:49-70`), which accepts any string (`src/api/schemas/settings.ts:45`, `:91`), and restore it afterwards. Unset, the setting reads as `undefined`. | the Task 0 probe on `sites/dev` (the timezone came back as set); Task 7 and Task 8 runs (`siteTimezone: "Europe/Chisinau"` stored on the job and `released` converted with it, on Node and on workerd) |
| V2 | `invalidateCollectionCache` and `invalidateSchemaObjectCache` imported by the plugin act on the site's own caches: the workspace has one copy of `emdash@1.2.0` (`node_modules/.pnpm` holds one `emdash@1.2.0_…` directory; `packages/flux-import`, `sites/dev` and `sites/dev-cf` link to it), and the object cache keeps its backend and epochs on `globalThis` under `Symbol.for` keys (`src/object-cache/index.ts:147-181`), so even a second module copy would share them. The Task 0 probe sees the `schema` namespace in that global epoch map after the call, and a field created through `runtime.schemaRegistry.createField` is written and read back in the same request sequence. The dev sites configure no object cache, so `cachedQuery` is a passthrough there (`src/object-cache/index.ts:10-14`); the invalidation matters for sites that configure one. | `readlink -f` and `ls node_modules/.pnpm`; the Task 0 probe; Task 7 ("creates the fields from a template with schema/apply…" then the imports) |
| E1 | EmDash's REST field handler clears three caches after a field change (`invalidateFieldCaches`, `src/api/handlers/schema.ts:102-106`): `invalidateCollectionCache`, `invalidateSchemaObjectCache` (both exported from `emdash`, `src/index.ts:252-262`) and `invalidateSchemaCache` (the Zod schema cache, not exported). The Zod cache only feeds `getCachedSchema`/`validateContent` (`src/schema/zod-generator.ts:291-350`), which nothing on the write path calls: `validateContentData` builds the schema afresh from the registry on every write (`src/api/handlers/validation.ts:157-199`). So the plugin can clear the two it can reach and lose nothing. | source reading |
| E2 | `RESERVED_FIELD_SLUGS` (exported from `emdash`, `src/schema/types.ts:462-482`) includes `status`, `slug`, `id`, `terms`, `bylines`; `createField` refuses them with `RESERVED_SLUG` (`src/schema/registry.ts:1283-1286`). The spec's examples use a field named `status`, which EmDash refuses; this plan's tests use `stage`. | source reading; Task 6 test |
| E3 | `updateField` refuses to change `required` (or `unique`, or translatable to non-translatable) with `FIELD_UPDATE_REQUIRES_MIGRATION` (`src/schema/registry.ts:1523-1540`), even on an empty collection. A required field can only be created required (the REST create body accepts `required`, `src/api/schemas/schema.ts:214-230`). | Task 7 drafting run (`400 FIELD_UPDATE_REQUIRES_MIGRATION`) |
| E4 | EmDash's `JSON` column type has SQLite NUMERIC affinity, so a string stored in a `json` field that looks like a number comes back as a number (`"42"` → 42, `"007"` → 7, `"1e3"` → 1000), and a top-level boolean comes back as 1 or 0 (`serializeValue`, `src/database/repositories/content.ts:317-330`). Strings that start with `{` or `[` come back parsed (`deserializeValue`, `:342-356`). `multiSelect` arrays and `string`/`text` values (TEXT affinity) are unaffected. | a temporary integration probe on `sites/dev` (json values `"42"`, `"007"`, `"1e3"`, `true`, `1.0` read back as 42, 7, 1000, 1, 1; text `"12"` stayed `"12"`; text `"[1,2]"` read back as `[1,2]`) |
| E5 | Writes validate with a Zod schema built from the fields (`src/schema/zod-generator.ts:41-66`, `:81-210`, `:240-290`): `pattern` is compiled with `new RegExp(pattern)` and only when non-empty; `minLength`/`maxLength`/`pattern` apply to `string`, `text`, `url`, `slug` (and to a `select` without options, which the importer leaves to EmDash); `min`/`max` to `number` and `integer`; `integer` is `z.number().int()`; `datetime` needs `Z` or an offset with a four-digit year. Create validates the full record, update partially; a required field given `null` fails both (`src/api/handlers/validation.ts:149-230`). | source reading; Task 7 |
| E6 | `Field` (`src/schema/types.ts:320-344`) carries `required`, `defaultValue` (absent when none), `validation` and `unsupportedType` (set when the stored type is unknown; `type` then reads as `"string"`, `src/schema/registry.ts:2478-2491`). A storage-less field is a `reference` whose `validation.relation` is set (`isStoragelessField`, `src/schema/types.ts:120-125`). `EmDashRuntime.schemaRegistry` stays assignable to the widened `SchemaRegistryLike` and to `ApplyRegistry`. | source reading; `tsc` |
| E7 | A plugin route's `astro/zod` input schema runs before the handler; invalid input never reaches it. The `schema/apply` input is `.strict()`, so `required`, `unique`, `defaultValue` and `validation` on a field are refused there. | `definition.test.ts` |
| E8 | Publishing an entry of a routable collection needs an entry slug; EmDash derives one from a `title` field when the template maps no slug. Every integration collection in this plan has a mapped `title`. | a drafting probe without `title` failed every record with `emdash_validation_error` "Cannot publish routable content without a slug" |
| E9 | Through the content API a field whose stored value is `null` may be absent from `data`; tests compare such fields with `?? null`. | Task 7 drafting run |
| E10 | EmDash's plugin capability list has `schema:read` but nothing for writing schema (`src/plugins/manifest-schema.ts:29-57`); the importer writes schema through the trusted runtime as it already does for `flux_source_id`. | source reading |
| L1 | Luxon 3.7 resolves a nonexistent local time by moving it forward (New York `2026-03-08T02:30` → `03:30-04:00`), and an ambiguous one inconsistently: New York `2026-11-01T01:30` gives the earlier instant (`-04:00`), Chisinau `2026-10-25T03:30` the later (`+02:00`). `dates.ts` therefore reads the written wall-clock time in UTC and finds the earliest instant whose local time in the zone matches (`localInstant`), or none. Moldova (Europe/Chisinau) moves from 03:00 to 04:00 on 2026-03-29 and from 04:00 back to 03:00 on 2026-10-25. `DateTime.fromISO`/`fromFormat` with `{ zone, setZone: true }` keep the zone when the text has no offset and switch to the text's offset otherwise, which is how an explicit offset is detected. | `node -e` probes; `dates.test.ts` |
| L2 | `IANAZone.isValidZone` accepts `UTC`, `Etc/UTC` and IANA names and refuses `UTC+2`, `Mars/X` and `""`; `DateTime.now().setZone(tz).isValid` (the M2 template check) also accepts fixed offsets such as `UTC+2`. | `node -e` probe |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition. Known since M3c (its Fact F1); not caused by this plan. | M3c and M3d plans |

## Rulings this plan makes

- **Where the code lives.** Conversions are `src/engine/values.ts` (numbers, booleans, selects, multi-selects, JSON, the field rules, `TargetField`, `JsonValue`) and `src/engine/dates.ts` (dates). Both take structural option types, so they do not import the template schema and can be written in parallel. `template.ts` keeps text and slug conversion (they use `slugify`) and dispatches with `fieldConverter`. `compileTemplate(t, { targets, siteTimezone })` builds one converter per field, so token sets, option lookups and zones are built once per batch, not per record.
- **Option defaults.** New options are optional in the schema and defaulted in code (`ignoreCase` true, `separator` ",", `parse` true, `decimal` "."), so a stored template keeps exactly what the user wrote; only `tz` keeps its M2 schema default (`"UTC"`). `tz` accepts `"site"` beside the M2 check; `checkTemplate` requires the site timezone to be a valid IANA zone (`IANAZone.isValidZone`, Fact L2) only when a mapping uses `"site"`.
- **Booleans.** The overlap check runs on the effective lists after trimming and lower-casing: a `true` list that names a default `false` token (`true: ["no"]`) is refused (`"no" is both a true and a false token`). Tokens must not be blank. The `invalid_boolean` message lists the effective tokens as written.
- **Selects.** A `map` key matches exactly first, then ignoring case: when several keys are equal ignoring case, the first in template order wins. The mapped value is then matched against the options (exact, then the one option equal ignoring case; two options equal ignoring case make that spelling `invalid_option`). `checkTemplate` accepts a `map` value that matches an option the same way (so `"PUBLISHED"` fits `published` with `ignoreCase`). A `multiSelect` counts its items for `too_many_items` after dropping empty ones and before dropping duplicates; null array items are empty. A scalar (number, boolean) for a `multiSelect` is text and is split.
- **Numbers.** With `decimal: ","` a point anywhere is `invalid_number` (it would otherwise read `1.5` as one and a half). A separator left after the grouping match (`1.5`, `12.34.567`) is `invalid_number`. Integer checks are a field rule, not a conversion: `invalid_integer` for a fractional number or one beyond ±(2^53-1), only for `integer` targets.
- **JSON.** Besides the spec's `{`/`[` rule, a string value that looks like a number (`"007"`, `" 42 "`, `"1e3"`) fails `invalid_json`, with `parse` on or off: SQLite would store it as a number (Fact E4). With `parse: true`, text that parses to a string starting with `{` or `[` fails the same way. A top-level boolean is accepted as the spec says, reads back as 1 or 0 (Fact E4), and the diff treats it as unchanged (`deep` comparison accepts 0/1 for a boolean). `value_too_large` counts UTF-8 bytes of `JSON.stringify`.
- **Dates.** A Unix time accepts `[+-]digits[.digits]` (no exponent), rounded to the nearest millisecond. Years outside 0000-9999 (UTC) fail `invalid_date`, because EmDash's datetime check takes four-digit years only (Fact E5); the bound applies to `string` and `text` targets too, so one rule covers both. The DST message names the zone: `"2026-03-08T02:30" does not exist in America/New_York (the clocks skip it)`. A job without a snapshot formats as for a `datetime` target (M2).
- **Field rules.** `checkRules` runs only when the job has a snapshot entry for the field; a rule failure keeps the field out of `data`, and the record fails as in M2 (all errors collected, in field order: conversion error, or `required`, `invalid_integer`, `out_of_range`, `too_short`/`too_long`, `pattern_mismatch`). Lengths count UTF-16 code units (`String.length`, as Zod does). A pattern that does not compile is ignored.
- **Snapshot and site timezone.** `listSchemaFields` returns every field with `required`, `hasDefault`, `validation` reduced to the enforced keys of the right types (an empty `pattern` and non-array `options` are dropped), and `unsupported`/`storageless` flags. `createJob` always stores `targetFields` (mapped fields only); it stores `siteTimezone` only when a mapping uses `tz: "site"` (UTC when the route passed none). The `jobs/create` route reads the setting only for such templates (`needsSiteTimezone`), so other imports never depend on Fact V1; a blank or unset setting is UTC (`readSiteTimezone`).
- **Schema checks.** Problem messages, exactly: `Field "f" has type "t"; a <type> mapping needs one of …` (M2 wording, with the new lists), `Field "f" is a datetime field; "output" only formats text fields`, `Field "f" maps to "v", which is not one of its options (a, b)`, `Field "f" is required and has no default, but the template does not map it`, `Field "f" has a field type this EmDash version cannot read`, `Field "f" keeps its values outside the content table and cannot be imported`, `Field "f" reads dates in the site timezone, but "x" is not a valid IANA timezone`. Unmapped required fields are listed after the mapped fields' problems, in collection order. `flux_source_id` is never reported.
- **Diff.** `comparisonsOf(template, targets)` gives `instant` for `datetime` targets, `boolean` for `boolean`, `deep` for `multiSelect` and `json`, `plain` otherwise; without a snapshot, `instant` for date mappings (M2). `plain` treats a stored object or array as unchanged when the new text is exactly `JSON.stringify` of it (the spec's "canonical JSON"); other spellings plan an update.
- **`schema/apply` details.** Field problems are checked in the plugin (one message per problem, joined with "; ") after the route's Zod schema has checked shapes and types; a template is parsed with the engine's `templateSchema` and its problems are reported as `VALIDATION_ERROR` "The template is invalid: …". `fields` needs `collection`; with `template`, a given `collection` must match. A `create` change lists the options it creates with. A field whose type EmDash cannot read is a `conflict`. Labels default to the slug with underscores as spaces and the first letter upper-cased (`unit_price` → `Unit price`). `searchable` defaults to false, `indexed` to false, `translatable` to true. A `SchemaError` is recognised by its string `code` (as `ensureSourceIdField` does); other errors are rethrown (500). Caches are cleared once, after the run, when anything was applied, even if a later field stopped the run.
- **Integration fixtures.** The required field of the Node test is created required through the admin REST API before `schema/apply` runs (Fact E3); `min`, `max` and `pattern` are added afterwards with `PUT …/fields/:field`. The template-built `stock` mapping (a `number` mapping gives a `number` field) meets a pre-created `integer` field, which is the spec's "conflicting type reported and left unchanged" case, and lets the import test `integer` targets.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (118 files) |
| `pnpm test` | 39 files / 1,004 tests pass (35 / 907 at `f3f3a23`) |
| Task 0 probe | on `f3f3a23`: one `emdash@1.2.0_…` directory and all three links resolve to it; the probe test passed (the timezone set through the settings API came back from `getSiteSetting`, the `schema` namespace was in the global epoch map, and the new `probe_flag` field read back as 1); the probe was removed and the tree was clean |
| Task-by-task replay | A clean worktree at `f3f3a23`, with Tasks 1-8 applied in order by a script that copies these code blocks and applies these replacements (each must match exactly once): every "Run them to see them fail" step failed exactly as written, and after each task `pnpm typecheck`, `pnpm lint` and `pnpm test` passed with the counts in its passing step; the result was byte-identical to the prototype |
| Parallel branches | Task 2 replayed alone on `f3f3a23` (36 files / 914 tests), and Tasks 5 then 6 replayed on Task 3 without Task 4 (38 / 986, then 39 / 999): the same failing and passing runs, and `pnpm typecheck && pnpm lint && pnpm test` pass on each branch |
| `pnpm test:integration` | 10 files / 53 tests passed in 546 s (was 9 files / 48 tests); `field-types.test.ts` alone on the replayed tree: 5 tests in 8 s |
| `vitest run --config vitest.cf.config.ts -t "M4a type"` | the new parity test passes on the replayed tree (11.8 s test, 41.6 s with server start); the rest of `pnpm test:cf` was not re-run |
| Probes (Facts E4, E8, L1, L2) | a temporary integration probe of `json` storage and of a collection without `title` on `sites/dev`; `node -e` probes of Luxon; removed |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/values.ts` (new) | `TargetField`, `JsonValue`; number, boolean, select, multiSelect and JSON converters; `checkRules` |
| `src/engine/dates.ts` (new) | `dateConverter` (ISO, Luxon formats, Unix, zones, DST, output), `localInstant` |
| `src/engine/template.ts` | New mapping types and options; `FieldValue`, `ValueErrorCode`; `fieldConverter`; `compileTemplate` context; rules in `applyTemplate`; `SchemaField`, `checkTemplate` additions, `targetFieldsOf`, `usesSiteTimezone` |
| `src/engine/types.ts`, `src/engine/jobs.ts`, `src/engine/batch.ts` | `Job.targetFields`, `Job.siteTimezone`; `createJob` stores them; batches compile with them and plan with `comparisonsOf` |
| `src/engine/diff.ts` | `Comparison`, `deepEqual`, type-aware `planRecord`, `comparisonsOf` (replaces `dateFieldsOf`) |
| `src/emdash/schema.ts`, `src/emdash/timezone.ts` (new) | `RegistryField`, widened `listSchemaFields`; `readSiteTimezone`, `needsSiteTimezone` |
| `src/plugin/schema-apply.ts` (new), `src/plugin/routes.ts`, `src/plugin/definition.ts` | `schema/apply` planning and applying; the route; the site timezone in `jobs/create`; capability comment |
| `tests/fixtures/field-types.ts` (new), `tests/integration/client.ts`, `tests/integration/field-types.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs |

`src/emdash/content.ts`, `src/engine/ports.ts` (they pass `FieldValue` through), the source readers, `src/plugin/service.ts` (`StartJobInput` gains `siteTimezone` through `CreateJobInput`), `src/plugin/sources.ts` and `src/plugin/xlsx.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1 and V2 | — | nothing committed (a temporary route and test, reverted) | sonnet |
| 1. Value conversions | 0 | `src/engine/values.ts`, `tests/unit/values.test.ts` | sonnet |
| 2. Date conversions | 0 | `src/engine/dates.ts`, `tests/unit/dates.test.ts` | sonnet |
| 3. Mapping types and conversion wiring | 1 (converters, `checkRules`, `TargetField`, `JsonValue`, codes, token lists), 2 (`dateConverter`) | `src/engine/{template,types,batch}.ts`, `tests/unit/{template,batch}.test.ts` | sonnet |
| 4. Type-aware diff | 3 (`FieldValue`, `Job.targetFields`, mapping types) | `src/engine/{diff,batch}.ts`, `tests/unit/diff.test.ts` | sonnet |
| 5. Schema checks, snapshot and site timezone at job creation | 3 (mapping types, `TargetField`, `SITE_TIMEZONE`, `MappingType`) | `src/engine/{template,jobs}.ts`, `src/emdash/{schema,timezone}.ts`, `src/plugin/routes.ts`, `tests/unit/{template,schema,jobs,timezone}.test.ts` | sonnet |
| 6. `schema/apply` | 3 (`FieldMapping`, `templateSchema`), 5 (`routes.ts` after Task 5) | `src/plugin/{schema-apply,routes,definition}.ts`, `tests/unit/{schema-apply,definition}.test.ts` | sonnet |
| 7. Node integration | 4, 5, 6 | `tests/fixtures/field-types.ts`, `tests/integration/{client,field-types.test}.ts` | sonnet |
| 8. workerd parity | 7 (`tests/fixtures/field-types.ts`), 4-6 | `tests/integration-cf/parity.test.ts` | sonnet |
| 9. Review run and note | 1-8 | `docs/superpowers/notes/2026-10-27-m4a-review.md` | opus |

Waves: **0**, then **1 ∥ 2**, then **3**, then **4 ∥ 5**, then **6** (needs 5's `routes.ts`; it may start while 4 is still running, since they touch no common file), then **7**, then **8** (it imports Task 7's fixture; the two harnesses use different ports, but Task 8 is short and needs the fixture, so run it after 7), then **9**. No two tasks of one wave touch the same file. `batch.ts` is touched by Task 3 (the `compileTemplate` call) and Task 4 (the `planRecord` call), `template.ts` and `template.test.ts` by Tasks 3 and 5, and `routes.ts` by Tasks 5 and 6, always in different waves. Pass counts in each task's "Run them to see them pass" step are for the task's own test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the two unconfirmed EmDash facts (V1, V2)

**Files:**
- Temporary (never committed): `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration/probe.test.ts`

**Interfaces:**
- Consumes: `getSiteSetting`, `invalidateCollectionCache`, `invalidateSchemaObjectCache` from `emdash`; `runtime.schemaRegistry.createField`, `runtime.handleContentCreate`; the integration harness.
- Produces: a yes or no for V1 and V2, recorded in the Task 9 note. No code.

**Stop rule:** if any check below fails, stop, revert the probe, and report which check failed with its output. Do not start Task 1: the plan's site-timezone and cache steps (Tasks 5 and 6) rely on both facts.

- [ ] **Step 1: One copy of EmDash**

Run: `command ls node_modules/.pnpm | grep '^emdash@' ; readlink -f packages/flux-import/node_modules/emdash sites/dev/node_modules/emdash sites/dev-cf/node_modules/emdash`
Expected: one `emdash@1.2.0_…` directory, and all three links resolve to it.

- [ ] **Step 2: Add the probe route and test**

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { PluginRouteError, pluginResponse, ulid } from "emdash";
```
with:
```ts
import {
	getSiteSetting,
	invalidateCollectionCache,
	invalidateSchemaObjectCache,
	PluginRouteError,
	pluginResponse,
	ulid,
} from "emdash";
```
then replace
```ts
	"jobs/log.csv": logCsv,
};
```
with:
```ts
	"jobs/log.csv": logCsv,

	// Temporary probe for Facts V1 and V2; removed in Step 4.
	"probe/m4a": route(z.object({ collection: z.string() }), (ctx) =>
		withServices(ctx, async ({ runtime }) => {
			const timezone = await getSiteSetting("timezone");
			await runtime.schemaRegistry.createField(ctx.input.collection, {
				slug: "probe_flag",
				label: "Probe flag",
				type: "boolean",
			});
			invalidateCollectionCache(ctx.input.collection);
			invalidateSchemaObjectCache();
			const epochs = (globalThis as Record<symbol, unknown>)[
				Symbol.for("emdash:object-cache:epochs")
			] as Map<string, unknown> | undefined;
			const created = await runtime.handleContentCreate(ctx.input.collection, {
				data: { title: "Probe", probe_flag: true },
				locale: "en",
			});
			if (!created.success) return { timezone, error: created.error };
			return { timezone, id: created.data.item.id, epochs: epochs ? [...epochs.keys()] : null };
		}),
	),
};
```

Create `packages/flux-import/tests/integration/probe.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));

describe("M4a probe (temporary)", () => {
	it("reads the site timezone and writes a field created through the registry", async () => {
		await client.createProducts("it_probe");
		const before = await client.api<{ timezone?: string }>("GET", "/_emdash/api/settings");
		await client.api("POST", "/_emdash/api/settings", { timezone: "Europe/Chisinau" });
		try {
			const probe = await client.plugin<{
				timezone: unknown;
				id: string;
				epochs: string[] | null;
			}>("probe/m4a", { collection: "it_probe" });
			expect(probe.timezone).toBe("Europe/Chisinau");
			expect(probe.epochs).toEqual(expect.arrayContaining(["schema"]));
			const entry = await client.getEntry("it_probe", probe.id);
			expect(entry.item.data).toMatchObject({ title: "Probe", probe_flag: 1 });
			expect(await client.fieldSlugs("it_probe")).toContain("probe_flag");
		} finally {
			await client.api("POST", "/_emdash/api/settings", { timezone: before.timezone ?? "UTC" });
		}
	});
});
```

- [ ] **Step 3: Run the probe**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts probe`
Expected: PASS (1 test). It shows that `getSiteSetting("timezone")` returns the value set through the settings API from inside a plugin route (V1), that the cache calls reach the global epoch map EmDash's own reads use (the `schema` namespace is present, V2), and that a field created through the registry is written and read back at once (V2).

- [ ] **Step 4: Remove the probe**

Run: `git checkout packages/flux-import/src/plugin/routes.ts && rm packages/flux-import/tests/integration/probe.test.ts && git status --short`
Expected: a clean tree (the integration harness restores `sites/dev/emdash-env.d.ts` itself). Record the results of Steps 1 and 3 for the Task 9 note.

### Task 1: Value conversions: numbers, booleans, selects, JSON and field rules

**Files:**
- Create: `packages/flux-import/src/engine/values.ts`
- Test: `packages/flux-import/tests/unit/values.test.ts` (new)

**Interfaces:**
- Consumes: nothing from the project (pure functions).
- Produces (`src/engine/values.ts`):
  - `type JsonValue`; `type ConversionCode` (`not_scalar`, `invalid_number`, `invalid_boolean`, `invalid_option`, `too_many_items`, `invalid_json`, `value_too_large`); `type RuleCode` (`required`, `invalid_integer`, `out_of_range`, `too_short`, `too_long`, `pattern_mismatch`); `type Converted`
  - `type TargetField = { type: string; required: boolean; options?; min?; max?; minLength?; maxLength?; pattern? }`
  - option interfaces `NumberOptions`, `BooleanOptions`, `SelectOptions`, `MultiSelectOptions`, `JsonOptions` (every key `?: T | undefined`, so a parsed template mapping is assignable)
  - `TRUE_TOKENS`, `FALSE_TOKENS`, `MAX_ITEMS` (1,000), `MAX_JSON_BYTES` (1 MiB), `NOT_SCALAR_MESSAGE`
  - `numberConverter(o)`, `booleanConverter(o)`, `selectConverter(o, options)`, `multiSelectConverter(o, options)`, `jsonConverter(o)`: each `(raw: unknown) => Converted`
  - `checkRules(value: unknown, target: TargetField): { code: RuleCode; message: string }[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/values.test.ts`:
```ts
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

	it("refuses values over 1 MiB", () => {
		const big = "x".repeat(MAX_JSON_BYTES);
		expect(raw(big)).toEqual(err("value_too_large"));
		expect(raw(big.slice(2))).toMatchObject({ ok: true });
		expect(json({ s: big })).toEqual(err("value_too_large"));
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
		expect(codes("abc", { type: "select", maxLength: 1, pattern: "^x$" })).toEqual([]);
		expect(codes(["a"], { type: "multiSelect", min: 3 })).toEqual([]);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run values`
Expected: FAIL — `values.test.ts` cannot load `../../src/engine/values.js` ("Cannot find module"; no tests run).

- [ ] **Step 3: Implement the converters and the rules**

Create `packages/flux-import/src/engine/values.ts`:
```ts
/**
 * Conversions for the M4a field types (number separators, booleans, selects, multi-selects and
 * JSON) and the field rules EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:41-66,
 * :81-210, :240-290). Each converter is built once per mapping, so token sets and option lookups
 * are not rebuilt for every record.
 */

/** A JSON value, as EmDash stores in `json` fields. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ConversionCode =
	| "not_scalar"
	| "invalid_number"
	| "invalid_boolean"
	| "invalid_option"
	| "too_many_items"
	| "invalid_json"
	| "value_too_large";

export type RuleCode =
	| "required"
	| "invalid_integer"
	| "out_of_range"
	| "too_short"
	| "too_long"
	| "pattern_mismatch";

export type Converted =
	| { ok: true; value: JsonValue | string[] }
	| { ok: false; code: ConversionCode; message: string };

/**
 * What the importer knows about a target field: its EmDash type, whether it is required, and the
 * validation keys EmDash enforces. Stored on the job at creation (`Job.targetFields`).
 */
export type TargetField = {
	type: string;
	required: boolean;
	options?: string[];
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

export interface NumberOptions {
	decimal?: "." | "," | undefined;
	thousands?: "," | "." | " " | "'" | "_" | undefined;
}

export interface BooleanOptions {
	true?: string[] | undefined;
	false?: string[] | undefined;
}

export interface SelectOptions {
	map?: Record<string, string> | undefined;
	ignoreCase?: boolean | undefined;
}

export interface MultiSelectOptions extends SelectOptions {
	separator?: string | undefined;
}

export interface JsonOptions {
	parse?: boolean | undefined;
}

export const TRUE_TOKENS = ["true", "yes", "y", "1", "on"];
export const FALSE_TOKENS = ["false", "no", "n", "0", "off"];
export const MAX_ITEMS = 1000;
export const MAX_JSON_BYTES = 1024 * 1024;
/** Options named in an `invalid_option` message. */
const LISTED_OPTIONS = 20;

export const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NULL: Converted = { ok: true, value: null };

const fail = (code: ConversionCode, message: string): Converted => ({ ok: false, code, message });

/** A scalar as text (numbers and booleans as their string), `""` for null, null for objects. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Numbers: a JSON number as it is; text trimmed, with `thousands` grouping the integer part in
 * threes and `decimal` read as the point, then the M2 number grammar. A space separator also
 * matches U+00A0 and U+202F, which spreadsheets write as thousands separators.
 */
export function numberConverter(o: NumberOptions): (raw: unknown) => Converted {
	const decimal = o.decimal ?? ".";
	const sep =
		o.thousands === undefined
			? null
			: o.thousands === " "
				? "[ \\u00A0\\u202F]"
				: escapeRe(o.thousands);
	const grouped =
		sep === null
			? null
			: new RegExp(`^([+-]?)(\\d{1,3}(?:${sep}\\d{3})+)(?=$|${escapeRe(decimal)}|[eE])`);
	const seps = sep === null ? null : new RegExp(sep, "g");
	return (raw) => {
		if (typeof raw === "number") {
			return Number.isFinite(raw)
				? { ok: true, value: raw }
				: fail("invalid_number", `${raw} is not a number`);
		}
		if (typeof raw === "boolean") return fail("invalid_number", `${raw} is not a number`);
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const trimmed = text.trim();
		if (trimmed === "") return NULL;
		const bad = fail("invalid_number", `"${trimmed}" is not a number`);
		let s = trimmed;
		if (grouped !== null && seps !== null) {
			const m = grouped.exec(s);
			if (m) s = `${m[1]}${(m[2] as string).replace(seps, "")}${s.slice(m[0].length)}`;
			// A separator left over did not group the integer part in threes.
			if (s.replace(seps, "") !== s) return bad;
		}
		if (decimal === ",") {
			if (s.includes(".")) return bad;
			s = s.replace(",", ".");
		}
		if (!NUMBER_RE.test(s)) return bad;
		const n = Number(s);
		return Number.isFinite(n) ? { ok: true, value: n } : bad;
	};
}

const token = (s: string) => s.trim().toLowerCase();

/**
 * Booleans: JSON booleans as they are, JSON 1 and 0, and text looked up (trimmed, lower-cased) in
 * the token lists; a list set on the mapping replaces that default list.
 */
export function booleanConverter(o: BooleanOptions): (raw: unknown) => Converted {
	const trues = o.true ?? TRUE_TOKENS;
	const falses = o.false ?? FALSE_TOKENS;
	const lookup = new Map<string, boolean>([
		...trues.map((t) => [token(t), true] as const),
		...falses.map((t) => [token(t), false] as const),
	]);
	const accepted = `expected one of ${[...trues, ...falses].join(", ")}`;
	return (raw) => {
		if (typeof raw === "boolean") return { ok: true, value: raw };
		if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const key = token(text);
		if (key === "") return NULL;
		const value = lookup.get(key);
		if (value === undefined)
			return fail("invalid_boolean", `"${text.trim()}" is not a boolean; ${accepted}`);
		return { ok: true, value };
	};
}

const lower = (s: string) => s.toLowerCase();

/**
 * Matches one trimmed, non-empty text against `map` (exact key, then the first key equal ignoring
 * case) and then against the field's options (exact, then the one option equal ignoring case).
 * Returns the option as defined, or null. Without options any non-empty text is accepted.
 */
function optionMatcher(o: SelectOptions, options: readonly string[] | undefined) {
	const ignoreCase = o.ignoreCase ?? true;
	const map = new Map(Object.entries(o.map ?? {}));
	const mapLower = new Map<string, string>();
	for (const [k, v] of map) if (!mapLower.has(lower(k))) mapLower.set(lower(k), v);
	const exact = new Set(options ?? []);
	const byLower = new Map<string, string | null>();
	for (const option of options ?? []) {
		const key = lower(option);
		// Two options equal ignoring case make that spelling ambiguous.
		byLower.set(key, byLower.has(key) && byLower.get(key) !== option ? null : option);
	}
	const free = exact.size === 0;
	return (text: string): string | null => {
		const mapped = map.get(text) ?? (ignoreCase ? mapLower.get(lower(text)) : undefined) ?? text;
		if (free || exact.has(mapped)) return mapped;
		return ignoreCase ? (byLower.get(lower(mapped)) ?? null) : null;
	};
}

function optionsMessage(bad: string[], options: readonly string[]): string {
	const listed = options.slice(0, LISTED_OPTIONS).join(", ");
	const more = options.length > LISTED_OPTIONS ? `, … (${options.length} in all)` : "";
	const names = bad.map((b) => `"${b}"`).join(", ");
	return `${names} ${bad.length === 1 ? "is not an option" : "are not options"}; the options are ${listed}${more}`;
}

/** A select value: one option, matched as `optionMatcher` describes; fails `invalid_option`. */
export function selectConverter(
	o: SelectOptions,
	options: readonly string[] | undefined,
): (raw: unknown) => Converted {
	const match = optionMatcher(o, options);
	return (raw) => {
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const trimmed = text.trim();
		if (trimmed === "") return NULL;
		const value = match(trimmed);
		if (value === null) return fail("invalid_option", optionsMessage([trimmed], options ?? []));
		return { ok: true, value };
	};
}

/**
 * A multiSelect value: an array of scalars, or text split on `separator` (default ","). Items are
 * trimmed, empty items dropped, each matched as for a select, and duplicates dropped (first kept).
 * An empty result is null.
 */
export function multiSelectConverter(
	o: MultiSelectOptions,
	options: readonly string[] | undefined,
): (raw: unknown) => Converted {
	const match = optionMatcher(o, options);
	const separator = o.separator ?? ",";
	return (raw) => {
		let items: unknown[];
		if (Array.isArray(raw)) items = raw;
		else {
			const text = scalarText(raw);
			if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
			items = text.split(separator);
		}
		const texts: string[] = [];
		for (const item of items) {
			const text = scalarText(item);
			if (text === null)
				return fail(
					"not_scalar",
					"Expected a list of single values, found an object or array in it",
				);
			const trimmed = text.trim();
			if (trimmed !== "") texts.push(trimmed);
		}
		if (texts.length > MAX_ITEMS) {
			return fail("too_many_items", `${texts.length} items; at most ${MAX_ITEMS} are allowed`);
		}
		const values: string[] = [];
		const bad: string[] = [];
		for (const text of texts) {
			const value = match(text);
			if (value === null) {
				if (!bad.includes(text)) bad.push(text);
			} else if (!values.includes(value)) values.push(value);
		}
		if (bad.length > 0) return fail("invalid_option", optionsMessage(bad, options ?? []));
		return values.length === 0 ? NULL : { ok: true, value: values };
	};
}

/** Text EmDash would read back as JSON (src/database/repositories/content.ts:342-356). */
const looksLikeJson = (s: string) => s.startsWith("{") || s.startsWith("[");
/**
 * Text SQLite stores as a number in EmDash's `JSON` columns, whose type name gives them NUMERIC
 * affinity: `"007"` reads back as 7 (on SQLite and D1).
 */
const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/**
 * JSON: objects, arrays, numbers and booleans as they are. Text is parsed as JSON (`parse`, the
 * default) or kept as a string. A string value that starts with `{` or `[`, or looks like a
 * number, is refused either way, because EmDash would read it back as parsed JSON or as a
 * number. At most 1 MiB serialised.
 */
export function jsonConverter(o: JsonOptions): (raw: unknown) => Converted {
	const parse = o.parse ?? true;
	return (raw) => {
		let value: unknown = raw;
		if (raw === undefined || raw === null) return NULL;
		if (typeof raw === "string") {
			if (raw.trim() === "") return NULL;
			if (parse) {
				try {
					value = JSON.parse(raw);
				} catch {
					return fail("invalid_json", "The text is not valid JSON");
				}
			}
			if (typeof value === "string" && looksLikeJson(value)) {
				return fail(
					"invalid_json",
					"A JSON string that starts with { or [ would be read back as JSON; store it parsed",
				);
			}
			if (typeof value === "string" && NUMERIC_TEXT.test(value)) {
				return fail(
					"invalid_json",
					"A JSON string that looks like a number would be stored as a number; store a number",
				);
			}
		} else if (typeof raw === "number" && !Number.isFinite(raw)) {
			return fail("invalid_json", `${raw} is not a JSON number`);
		}
		const text = JSON.stringify(value);
		if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) {
			return fail("value_too_large", `The JSON value is larger than ${MAX_JSON_BYTES} bytes`);
		}
		return { ok: true, value: value as JsonValue };
	};
}

const TEXT_TYPES = new Set(["string", "text", "url", "slug"]);
const NUMBER_TYPES = new Set(["number", "integer"]);

/**
 * The field rules EmDash checks on writes, applied to a converted value: `required`, whole
 * numbers for `integer`, `min`/`max`, `minLength`/`maxLength` (UTF-16 code units, as Zod counts)
 * and `pattern` (compiled without flags, as EmDash does; a pattern that does not compile is
 * ignored). Every failing rule gives one error.
 */
export function checkRules(
	value: unknown,
	target: TargetField,
): { code: RuleCode; message: string }[] {
	if (value === null || value === undefined) {
		return target.required ? [{ code: "required", message: "The field is required" }] : [];
	}
	const errors: { code: RuleCode; message: string }[] = [];
	if (NUMBER_TYPES.has(target.type) && typeof value === "number") {
		if (target.type === "integer" && !Number.isSafeInteger(value)) {
			errors.push({
				code: "invalid_integer",
				message: Number.isInteger(value)
					? `${value} is beyond ±${Number.MAX_SAFE_INTEGER}`
					: `${value} is not a whole number`,
			});
		}
		if (target.min !== undefined && value < target.min) {
			errors.push({
				code: "out_of_range",
				message: `${value} is less than the minimum ${target.min}`,
			});
		}
		if (target.max !== undefined && value > target.max) {
			errors.push({
				code: "out_of_range",
				message: `${value} is more than the maximum ${target.max}`,
			});
		}
	}
	if (TEXT_TYPES.has(target.type) && typeof value === "string") {
		if (target.minLength !== undefined && value.length < target.minLength) {
			errors.push({
				code: "too_short",
				message: `The text has ${value.length} characters; the minimum is ${target.minLength}`,
			});
		}
		if (target.maxLength !== undefined && value.length > target.maxLength) {
			errors.push({
				code: "too_long",
				message: `The text has ${value.length} characters; the maximum is ${target.maxLength}`,
			});
		}
		const pattern = target.pattern === undefined ? null : compilePattern(target.pattern);
		if (pattern !== null && !pattern.test(value)) {
			errors.push({
				code: "pattern_mismatch",
				message: `The text does not match the pattern ${target.pattern}`,
			});
		}
	}
	return errors;
}

/** The pattern as EmDash compiles it, or null when it does not compile. */
function compilePattern(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run values`
Expected: PASS (24 tests in `values.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 36 files / 931 tests, from 35 / 907 at `f3f3a23`).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/values.ts packages/flux-import/tests/unit/values.test.ts
git commit -m "Convert numbers with separators, booleans, selects and JSON, and check EmDash's field rules"
```

### Task 2: Date conversions: zones, Unix times, DST and calendar dates

**Files:**
- Create: `packages/flux-import/src/engine/dates.ts`
- Test: `packages/flux-import/tests/unit/dates.test.ts` (new)

**Interfaces:**
- Consumes: Luxon (`DateTime`, `Zone`); L1.
- Produces (`src/engine/dates.ts`): `interface DateOptions { format?; tz: string; output? }` (`tz` already resolved from `"site"`); `type DateConverted`; `localInstant(wall: number, zone: Zone): number | null`; `dateConverter(o: DateOptions, targetType: string | null): (raw: unknown) => DateConverted`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/dates.test.ts`:
```ts
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { dateConverter, localInstant } from "../../src/engine/dates.js";

const ok = (value: string | null) => ({ ok: true, value });
const invalid = expect.objectContaining({ ok: false, code: "invalid_date" });

describe("dateConverter", () => {
	it("reads ISO text in the zone, keeping an explicit offset, into EmDash's canonical form", () => {
		const utc = dateConverter({ tz: "UTC" }, "datetime");
		expect(utc("2025-01-24T12:00")).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(utc("2025-01-24")).toEqual(ok("2025-01-24T00:00:00.000Z"));
		const chisinau = dateConverter({ tz: "Europe/Chisinau" }, "datetime");
		expect(chisinau("2026-03-01")).toEqual(ok("2026-02-28T22:00:00.000Z"));
		expect(chisinau("2026-07-01T10:00")).toEqual(ok("2026-07-01T07:00:00.000Z"));
		expect(chisinau("2026-03-01T10:00:00+05:00")).toEqual(ok("2026-03-01T05:00:00.000Z"));
		expect(chisinau("2026-03-01T10:00:00Z")).toEqual(ok("2026-03-01T10:00:00.000Z"));
		expect(chisinau(" ")).toEqual(ok(null));
		expect(chisinau(null)).toEqual(ok(null));
		expect(chisinau("soon")).toEqual({
			ok: false,
			code: "invalid_date",
			message: '"soon" is not a ISO 8601 date',
		});
		expect(chisinau({ at: "x" })).toEqual(expect.objectContaining({ code: "not_scalar" }));
		expect(chisinau(1700000000)).toEqual(invalid);
	});

	it("reads a Luxon format in the zone", () => {
		const de = dateConverter({ format: "dd/MM/yyyy HH:mm", tz: "Europe/Berlin" }, "datetime");
		expect(de("24/01/2025 13:00")).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(de("31/02/2025 13:00")).toEqual(invalid);
		const offset = dateConverter({ format: "dd/MM/yyyy HH:mm ZZ", tz: "Europe/Berlin" }, null);
		expect(offset("24/01/2025 13:00 +03:00")).toEqual(ok("2025-01-24T10:00:00.000Z"));
	});

	it("reads Unix seconds and milliseconds from numbers and text, fractions included", () => {
		const unix = dateConverter({ format: "unix", tz: "UTC" }, "datetime");
		expect(unix(1737720000)).toEqual(ok("2025-01-24T12:00:00.000Z"));
		expect(unix("1737720000.25")).toEqual(ok("2025-01-24T12:00:00.250Z"));
		expect(unix(" -86400 ")).toEqual(ok("1969-12-31T00:00:00.000Z"));
		expect(unix("17e8")).toEqual(invalid);
		expect(unix(true)).toEqual(invalid);
		expect(unix(1e15)).toEqual(invalid);
		const ms = dateConverter({ format: "unixMs", tz: "Asia/Tokyo" }, "datetime");
		expect(ms(1737720000123)).toEqual(ok("2025-01-24T12:00:00.123Z"));
		expect(ms("1737720000123.6")).toEqual(ok("2025-01-24T12:00:00.124Z"));
		const day = dateConverter({ format: "unix", tz: "Asia/Tokyo" }, "string");
		expect(day(1737720000 + 15 * 3600)).toEqual(ok("2025-01-25"));
	});

	it("fails a local time in a DST gap and takes the earlier instant in an overlap", () => {
		const ny = dateConverter({ tz: "America/New_York" }, "datetime");
		expect(ny("2026-03-08T02:30")).toEqual({
			ok: false,
			code: "invalid_date",
			message: '"2026-03-08T02:30" does not exist in America/New_York (the clocks skip it)',
		});
		expect(ny("2026-03-08T03:30")).toEqual(ok("2026-03-08T07:30:00.000Z"));
		expect(ny("2026-11-01T01:30")).toEqual(ok("2026-11-01T05:30:00.000Z"));
		expect(ny("2026-11-01T01:30-05:00")).toEqual(ok("2026-11-01T06:30:00.000Z"));
		const md = dateConverter({ format: "yyyy-MM-dd HH:mm", tz: "Europe/Chisinau" }, "datetime");
		// Moldova moves from 03:00 to 04:00 in spring, and from 04:00 back to 03:00 in autumn.
		expect(md("2026-03-29 03:30")).toEqual(invalid);
		expect(md("2026-10-25 03:30")).toEqual(ok("2026-10-25T00:30:00.000Z"));
		expect(md("2026-10-25 04:30")).toEqual(ok("2026-10-25T02:30:00.000Z"));
	});

	it("formats into text fields in the zone, by default as a calendar date", () => {
		const text = dateConverter({ tz: "Europe/Chisinau" }, "text");
		expect(text("2026-03-01T23:30:00Z")).toEqual(ok("2026-03-02"));
		const custom = dateConverter({ tz: "UTC", output: "dd.MM.yyyy HH:mm" }, "string");
		expect(custom("2026-03-01T08:05")).toEqual(ok("01.03.2026 08:05"));
		expect(dateConverter({ tz: "UTC", output: "yyyy" }, "datetime")("2026-03-01")).toEqual(
			ok("2026-03-01T00:00:00.000Z"),
		);
	});

	it("refuses years outside 0000-9999", () => {
		const utc = dateConverter({ tz: "UTC" }, "datetime");
		expect(utc("+010000-01-01")).toEqual(invalid);
		expect(utc("9999-12-31T23:59:59.999")).toEqual(ok("9999-12-31T23:59:59.999Z"));
		expect(dateConverter({ format: "unix", tz: "UTC" }, "datetime")(253402300800)).toEqual(invalid);
	});
});

describe("localInstant", () => {
	it("finds the earliest instant showing a wall-clock time, or none in a gap", () => {
		const zone = DateTime.utc().setZone("America/New_York").zone;
		expect(localInstant(Date.UTC(2026, 2, 8, 2, 30), zone)).toBeNull();
		expect(localInstant(Date.UTC(2026, 10, 1, 1, 30), zone)).toBe(Date.UTC(2026, 10, 1, 5, 30));
		expect(localInstant(Date.UTC(2026, 0, 1), zone)).toBe(Date.UTC(2026, 0, 1, 5));
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run dates`
Expected: FAIL — `dates.test.ts` cannot load `../../src/engine/dates.js` ("Cannot find module"; no tests run).

- [ ] **Step 3: Implement the converter**

Create `packages/flux-import/src/engine/dates.ts`:
```ts
import { DateTime, type Zone } from "luxon";

export interface DateOptions {
	/** A Luxon format, `"unix"` (seconds) or `"unixMs"` (milliseconds); ISO 8601 when absent. */
	format?: string | undefined;
	/** The zone for values without an offset, already resolved from `"site"`. */
	tz: string;
	/** The Luxon format for `string` and `text` targets; `yyyy-MM-dd` when absent. */
	output?: string | undefined;
}

export type DateConverted =
	| { ok: true; value: string | null }
	| { ok: false; code: "invalid_date" | "not_scalar"; message: string };

const DAY_MS = 86_400_000;
const UNIX_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";

/**
 * The earliest instant whose wall-clock time in `zone` is `wall` (a UTC timestamp holding the
 * local fields), or null when the local time does not exist there (a DST gap). An ambiguous time
 * (a DST overlap) has two such instants; the earlier is taken.
 */
export function localInstant(wall: number, zone: Zone): number | null {
	const offsets = new Set([
		zone.offset(wall - DAY_MS),
		zone.offset(wall),
		zone.offset(wall + DAY_MS),
	]);
	let best: number | null = null;
	for (const offset of offsets) {
		const instant = wall - offset * 60_000;
		if (zone.offset(instant) === offset && (best === null || instant < best)) best = instant;
	}
	return best;
}

/**
 * Dates: ISO 8601 text (or text in `format`) read in `tz` when it has no offset, or Unix seconds
 * or milliseconds (JSON numbers or text). Into a `datetime` field (or with no known target) the
 * value is EmDash's canonical form, UTC with milliseconds; into `string` and `text` fields it is
 * formatted in `tz` with `output`. A local time in a DST gap fails `invalid_date`; one in an
 * overlap takes the earlier instant. Years outside 0000-9999 fail too: EmDash's ISO check takes
 * four-digit years only.
 */
export function dateConverter(
	o: DateOptions,
	targetType: string | null,
): (raw: unknown) => DateConverted {
	const zone = DateTime.utc().setZone(o.tz).zone;
	const asText = targetType === "string" || targetType === "text";
	const output = o.output ?? "yyyy-MM-dd";
	const expected = o.format ?? "ISO 8601";
	const finish = (instant: number, shown: string): DateConverted => {
		const utc = DateTime.fromMillis(instant, { zone: "utc" });
		if (!utc.isValid || utc.year < 0 || utc.year > 9999) {
			return {
				ok: false,
				code: "invalid_date",
				message: `"${shown}" is outside the years 0000 to 9999`,
			};
		}
		const value = asText ? utc.setZone(zone).toFormat(output) : (utc.toISO() as string);
		return { ok: true, value };
	};
	return (raw) => {
		if (raw === undefined || raw === null) return { ok: true, value: null };
		if (typeof raw === "object")
			return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		const text = String(raw).trim();
		if (text === "") return { ok: true, value: null };
		const invalid: DateConverted = {
			ok: false,
			code: "invalid_date",
			message: `"${text}" is not a ${expected} date`,
		};
		if (o.format === "unix" || o.format === "unixMs") {
			if (typeof raw === "boolean" || !UNIX_RE.test(text)) return invalid;
			const n = Number(text);
			const ms = Math.round(o.format === "unix" ? n * 1000 : n);
			return Number.isFinite(ms) ? finish(ms, text) : invalid;
		}
		const options = { zone, setZone: true };
		const parsed =
			o.format === undefined
				? DateTime.fromISO(text, options)
				: DateTime.fromFormat(text, o.format, options);
		if (!parsed.isValid) return invalid;
		// The text carried its own offset (or zone): it names one instant.
		if (!parsed.zone.equals(zone)) return finish(parsed.toMillis(), text);
		// Otherwise read the written wall-clock time in UTC, where every local time exists, and
		// find the instant in `tz` that shows it.
		const written =
			o.format === undefined
				? DateTime.fromISO(text, { zone: "utc" })
				: DateTime.fromFormat(text, o.format, { zone: "utc" });
		const instant = localInstant(written.toMillis(), zone);
		if (instant === null) {
			return {
				ok: false,
				code: "invalid_date",
				message: `"${text}" does not exist in ${o.tz} (the clocks skip it)`,
			};
		}
		return finish(instant, text);
	};
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run dates`
Expected: PASS (7 tests in `dates.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 37 files / 938 tests after Task 1, or 36 / 914 when Task 2 runs alone on `f3f3a23`).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/dates.ts packages/flux-import/tests/unit/dates.test.ts
git commit -m "Read dates in a zone or as Unix times, refusing DST gaps and taking the earlier instant in overlaps"
```

### Task 3: Mapping types, options and conversion wiring

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/template.test.ts`, `packages/flux-import/tests/unit/batch.test.ts`

**Interfaces:**
- Consumes: Task 1 (converters, `checkRules`, `TargetField`, `JsonValue`, `ConversionCode`, `RuleCode`, `TRUE_TOKENS`, `FALSE_TOKENS`, `NOT_SCALAR_MESSAGE`), Task 2 (`dateConverter`).
- Produces (`src/engine/template.ts`): mapping types `boolean`, `select`, `multiSelect`, `json`, `slug` and the options of the spec's table; `SITE_TIMEZONE = "site"`; `type FieldMapping`, `type MappingType`; `type FieldValue = string | number | boolean | string[] | JsonValue | null`; `ValueErrorCode` with the new codes; `fieldConverter(mapping, target, siteTimezone)`; `interface CompileContext { targets?; siteTimezone? }`; `compileTemplate(t, context = {})`; `CompiledTemplate.converters` and `.targets`; the compatibility table of the spec (`text` also fills `slug`, `date` also `string` and `text`). Re-exports `JsonValue`, `TargetField`.
- Produces (`src/engine/types.ts`): `Job.targetFields?: Record<string, TargetField>`, `Job.siteTimezone?: string`.
- Produces (`src/engine/batch.ts`): each batch compiles the template with the job's `targetFields` and `siteTimezone`.

Between this task and Task 5 a new job has no snapshot (only Task 5 stores one), so it converts as M2 did except for the new types, whose selects accept any text; nothing is released in between.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, replace
```ts
import {
	applyTemplate,
	type CompiledTemplate,
	checkTemplate,
```
with:
```ts
import {
	applyTemplate,
	type CompileContext,
	type CompiledTemplate,
	checkTemplate,
```

then replace
```ts
		expect(errors).toEqual([
			'Column "handle" not found in the source',
			'Field "title" has type "number"; a text mapping needs one of string, text, url',
			'Field "price" does not exist in collection "products"',
		]);
```
with:
```ts
		expect(errors).toEqual([
			'Column "handle" not found in the source',
			'Field "title" has type "number"; a text mapping needs one of string, text, url, slug',
			'Field "price" does not exist in collection "products"',
		]);
```

then replace
```ts
		expect(templatePaths(t)).toEqual(["handle", "price"]);
	});
});
```
with:
```ts
		expect(templatePaths(t)).toEqual(["handle", "price"]);
	});
});

/** The products template from the M4a spec: every new mapping type and option. */
const typed = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number", decimal: ",", thousands: "." },
		stock: { from: "Stock", type: "number" },
		featured: { from: "Featured", type: "boolean", true: ["ja"], false: ["nein"] },
		status: { from: "Status", type: "select", map: { Live: "published" } },
		colours: { from: "Colours", type: "multiSelect", separator: "|" },
		released: { from: "Date", type: "date", format: "dd/MM/yyyy HH:mm", tz: "site" },
		sold_on: { from: "SoldAt", type: "date", format: "unix" },
		launch_day: { from: "Launch", type: "date", output: "yyyy-MM-dd" },
		specs: { from: "Specs", type: "json" },
		legacy_slug: { from: "Handle", type: "slug" },
	},
};

const targets: CompileContext["targets"] = {
	title: { type: "string", required: true, maxLength: 20 },
	price: { type: "number", required: false, min: 0 },
	stock: { type: "integer", required: false },
	featured: { type: "boolean", required: false },
	status: { type: "select", required: false, options: ["draft", "published"] },
	colours: { type: "multiSelect", required: false, options: ["red", "green", "blue"] },
	released: { type: "datetime", required: false },
	sold_on: { type: "datetime", required: false },
	launch_day: { type: "string", required: false, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
	specs: { type: "json", required: false },
	legacy_slug: { type: "slug", required: false },
};

const typedRow = {
	sku: "A1",
	Name: "Desk",
	Price: "1.234,50",
	Stock: "12",
	Featured: "JA",
	Status: "live",
	Colours: "Red | blue",
	Date: "24/01/2025 14:00",
	SoldAt: "1737720000",
	Launch: "2025-01-24T23:30:00Z",
	Specs: '{"w": 120, "tags": ["oak"]}',
	Handle: "Old Desk №1",
};

/** Compiles `typed` with the target snapshot (Europe/Chisinau as the site timezone). */
function typedCompiled(
	patch: object = {},
	context: CompileContext = { targets, siteTimezone: "Europe/Chisinau" },
) {
	const compiled = compileTemplate(templateSchema.parse({ ...typed, ...patch }), context);
	if (!compiled.ok) throw new Error(compiled.problems.join("; "));
	return compiled.compiled;
}

describe("templateSchema for M4a field types", () => {
	const issues = (fields: object) => {
		const result = templateSchema.safeParse({ ...typed, fields });
		return result.success ? [] : result.error.issues.map((i) => i.message);
	};

	it("accepts every type with its options, keeping them as written", () => {
		const t = templateSchema.parse(typed);
		expect(t.fields.price).toEqual({ from: "Price", type: "number", decimal: ",", thousands: "." });
		expect(t.fields.released).toMatchObject({ tz: "site" });
		expect(t.fields.launch_day).toEqual({
			from: "Launch",
			type: "date",
			output: "yyyy-MM-dd",
			tz: "UTC",
		});
		expect(t.fields.status).toEqual({ from: "Status", type: "select", map: { Live: "published" } });
		expect(
			issues({
				a: { expr: "x", type: "multiSelect", map: { x: "y" }, ignoreCase: false, separator: ";" },
				b: { from: "b", type: "json", parse: false },
				c: { from: "c", type: "boolean" },
				d: { from: "d", type: "number", decimal: ",", thousands: " " },
			}),
		).toEqual([]);
	});

	it.each([
		["an option of another type", { a: { from: "a", type: "text", decimal: "," } }],
		["slug options", { a: { from: "a", type: "slug", parse: true } }],
		["thousands equal to decimal", { a: { from: "a", type: "number", thousands: "." } }],
		[
			"thousands equal to a comma decimal",
			{ a: { from: "a", type: "number", decimal: ",", thousands: "," } },
		],
		["an unknown decimal", { a: { from: "a", type: "number", decimal: ";" } }],
		["a token in both lists", { a: { from: "a", type: "boolean", true: ["Ja"], false: [" ja "] } }],
		["a token in a default list", { a: { from: "a", type: "boolean", true: ["no"] } }],
		["a blank token", { a: { from: "a", type: "boolean", true: [" "] } }],
		["an empty token list", { a: { from: "a", type: "boolean", false: [] } }],
		[
			"51 tokens",
			{ a: { from: "a", type: "boolean", true: Array.from({ length: 51 }, (_, i) => `t${i}`) } },
		],
		["a token over 100 characters", { a: { from: "a", type: "boolean", true: ["t".repeat(101)] } }],
		["an empty map value", { a: { from: "a", type: "select", map: { x: "" } } }],
		[
			"a map key over 200 characters",
			{ a: { from: "a", type: "select", map: { ["k".repeat(201)]: "v" } } },
		],
		[
			"a map of 1,001 entries",
			{
				a: {
					from: "a",
					type: "multiSelect",
					map: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, "v"])),
				},
			},
		],
		["a non-boolean ignoreCase", { a: { from: "a", type: "select", ignoreCase: "yes" } }],
		[
			"a separator over 10 characters",
			{ a: { from: "a", type: "multiSelect", separator: "x".repeat(11) } },
		],
		["an empty output", { a: { from: "a", type: "date", output: "" } }],
		["an output over 100 characters", { a: { from: "a", type: "date", output: "y".repeat(101) } }],
		["an unknown timezone", { a: { from: "a", type: "date", tz: "Site" } }],
		["an unknown type", { a: { from: "a", type: "portableText" } }],
	])("refuses %s", (_name, fields) => {
		expect(issues(fields)).not.toEqual([]);
	});

	it("names the shared boolean token and the separator clash", () => {
		expect(issues({ a: { from: "a", type: "boolean", true: ["Ja"], false: ["JA"] } })).toEqual([
			'"ja" is both a true and a false token',
		]);
		expect(issues({ a: { from: "a", type: "number", thousands: "." } })).toEqual([
			"thousands must differ from decimal",
		]);
	});
});

describe("applyTemplate with M4a field types", () => {
	it("converts every type against the target snapshot", async () => {
		const result = await applyTemplate(typedCompiled(), typedRow);
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: {
					title: "Desk",
					price: 1234.5,
					stock: 12,
					featured: true,
					status: "published",
					colours: ["red", "blue"],
					released: "2025-01-24T12:00:00.000Z",
					sold_on: "2025-01-24T12:00:00.000Z",
					launch_day: "2025-01-24",
					specs: { w: 120, tags: ["oak"] },
					legacy_slug: "old-desk-no1",
				},
			},
		});
	});

	it("takes typed JSON values", async () => {
		const result = await applyTemplate(typedCompiled(), {
			...typedRow,
			Price: 9.5,
			Stock: 3,
			Featured: false,
			Colours: ["GREEN", "green"],
			SoldAt: 1737720000,
			Specs: [1, 2],
		});
		expect(result.ok && result.value.data).toMatchObject({
			price: 9.5,
			stock: 3,
			featured: false,
			colours: ["green"],
			sold_on: "2025-01-24T12:00:00.000Z",
			specs: [1, 2],
		});
	});

	it("reads tz: site in the job's site timezone, and UTC without one", async () => {
		const plain = typedCompiled({}, { targets });
		const result = await applyTemplate(plain, typedRow);
		expect(result.ok && result.value.data.released).toBe("2025-01-24T14:00:00.000Z");
	});

	it("collects conversion and rule errors from every field", async () => {
		const result = await applyTemplate(typedCompiled(), {
			...typedRow,
			Name: "",
			Price: "-1",
			Stock: "2,5",
			Featured: "maybe",
			Status: "gone",
			Colours: "red|pink",
			Date: "29/03/2026 03:30",
			Launch: "2025-01-24",
			Specs: "{",
			Handle: "!!!",
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["title", "required"],
			["price", "out_of_range"],
			["stock", "invalid_number"],
			["featured", "invalid_boolean"],
			["status", "invalid_option"],
			["colours", "invalid_option"],
			["released", "invalid_date"],
			["specs", "invalid_json"],
			["legacy_slug", "empty_slug"],
		]);
		const integer = await applyTemplate(typedCompiled(), { ...typedRow, Stock: "2.5" });
		expect(!integer.ok && integer.errors).toEqual([
			{ field: "stock", code: "invalid_integer", message: "2.5 is not a whole number" },
		]);
		const long = await applyTemplate(typedCompiled(), { ...typedRow, Name: "x".repeat(21) });
		expect(!long.ok && long.errors.map((e) => e.code)).toEqual(["too_long"]);
	});

	it("checks the rules on expression results too", async () => {
		const c = typedCompiled({
			fields: { ...typed.fields, stock: { expr: "$number(Stock) / 5", type: "number" } },
		});
		const result = await applyTemplate(c, typedRow);
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["stock", "invalid_integer"],
		]);
		const rounded = typedCompiled({
			fields: { ...typed.fields, stock: { expr: "$round($number(Stock) / 5)", type: "number" } },
		});
		expect(await applyTemplate(rounded, typedRow)).toMatchObject({
			ok: true,
			value: { data: { stock: 2 } },
		});
	});

	it("keeps M2 behaviour for jobs without a target snapshot", async () => {
		const m2 = typedCompiled({}, {});
		const result = await applyTemplate(m2, {
			...typedRow,
			Name: "",
			Stock: "2.5",
			Status: "anything",
		});
		expect(result.ok && result.value.data).toMatchObject({
			title: null,
			stock: 2.5,
			status: "anything",
			launch_day: "2025-01-24T23:30:00.000Z",
		});
	});
});
```

In `packages/flux-import/tests/unit/batch.test.ts`, replace
```ts
			["failed", "validation"],
			["created", undefined],
		]);
	});
```
with:
```ts
			["failed", "validation"],
			["created", undefined],
		]);
	});

	it("checks records against the job's target snapshot and reads tz: site in its timezone", async () => {
		const { deps } = makeDeps();
		deps.source.add(
			"u1",
			"sku,Name,Price,Day\nS0,Desk,2,2026-03-01 10:00\nS1,,2.5,2026-03-01 10:00\n",
		);
		const typed = {
			...template,
			fields: {
				...template.fields,
				day: { from: "Day", type: "date", format: "yyyy-MM-dd HH:mm", tz: "site" },
			},
		};
		const created = await createJob(deps, {
			uploadId: "u1",
			template: typed,
			schemaFields: [...schemaFields, { slug: "day", type: "datetime" }],
		});
		await deps.jobs.put(created.id, {
			...created,
			targetFields: {
				title: { type: "string", required: true },
				price: { type: "integer", required: false },
				day: { type: "datetime", required: false },
			},
			siteTimezone: "Europe/Chisinau",
		});
		const done = await runToEnd(deps, created.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 1 });
		expect([...deps.content.entries.values()][0]?.data).toMatchObject({
			title: "Desk",
			price: 2,
			day: "2026-03-01T08:00:00.000Z",
		});
		const rows = (await deps.records.query({ where: { jobId: created.id, status: "failed" } }))
			.items;
		expect(rows[0]?.data.errors?.map((e) => [e.field, e.code])).toEqual([
			["slug", "empty_slug"],
			["title", "required"],
			["price", "invalid_integer"],
		]);
	});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run template batch`
Expected: FAIL — 10 of 131 tests. In `template.test.ts`: the M4a schema and conversion tests (the old schema refuses every new type, `ZodError`), "names the shared boolean token and the separator clash", and the M2 compatibility message (it now lists `string, text, url, slug`); in `batch.test.ts`: the snapshot test (`JobError: The template is invalid`). The `refuses …` cases already pass, because the old schema refuses every new type.

- [ ] **Step 3: Add the mapping types and wire the converters**

In `packages/flux-import/src/engine/template.ts`, replace
```ts
	XLSX_ROW_FIELD,
} from "../sources/reader.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";

export const SOURCE_ID_FIELD = "flux_source_id";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;
```
with:
```ts
	XLSX_ROW_FIELD,
} from "../sources/reader.js";
import { dateConverter } from "./dates.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";
import {
	booleanConverter,
	type ConversionCode,
	checkRules,
	FALSE_TOKENS,
	type JsonValue,
	jsonConverter,
	multiSelectConverter,
	NOT_SCALAR_MESSAGE,
	numberConverter,
	type RuleCode,
	selectConverter,
	type TargetField,
	TRUE_TOKENS,
} from "./values.js";

export const SOURCE_ID_FIELD = "flux_source_id";
/** `tz: "site"` reads dates in the site's timezone setting, stored on the job at creation. */
export const SITE_TIMEZONE = "site";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;
```

then replace
```ts
	.string()
	.min(1)
	.refine((tz) => DateTime.now().setZone(tz).isValid, { message: "Unknown timezone" });

/** Where a key, slug or field value comes from: a source path (`from`) or a JSONata `expr`. */
```
with:
```ts
	.string()
	.min(1)
	.refine((tz) => tz === SITE_TIMEZONE || DateTime.now().setZone(tz).isValid, {
		message: "Unknown timezone",
	});
const tokens = z
	.array(
		z
			.string()
			.min(1)
			.max(100)
			.refine((t) => t.trim() !== "", { message: "Tokens cannot be blank" }),
	)
	.min(1)
	.max(50);
const optionMap = z
	.record(z.string().min(1).max(200), z.string().min(1).max(200))
	.refine((m) => Object.keys(m).length <= 1000, { message: "map takes at most 1,000 entries" });

/** Where a key, slug or field value comes from: a source path (`from`) or a JSONata `expr`. */
```

then replace
```ts
	(m.from === undefined) !== (m.expr === undefined);

const fieldMapping = z.discriminatedUnion("type", [
	z
```
with:
```ts
	(m.from === undefined) !== (m.expr === undefined);

const token = (t: string) => t.trim().toLowerCase();

/** The token both effective boolean lists share, if any (a list not set is the default). */
function sharedToken(m: { true?: string[] | undefined; false?: string[] | undefined }) {
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

const fieldMapping = z.discriminatedUnion("type", [
	z
```

then replace
```ts
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("number") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
```
with:
```ts
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("number"),
			decimal: z.enum([".", ","]).optional(),
			thousands: z.enum([",", ".", " ", "'", "_"]).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE)
		.refine((m) => m.thousands === undefined || m.thousands !== (m.decimal ?? "."), {
			message: "thousands must differ from decimal",
		}),
	z
		.object({
```

then replace
```ts
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
```
with:
```ts
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
			output: z.string().min(1).max(100).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("boolean"),
			true: tokens.optional(),
			false: tokens.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE)
		.superRefine((m, ctx) => {
			const shared = sharedToken(m);
			if (shared !== undefined) {
				ctx.addIssue({ code: "custom", message: `"${shared}" is both a true and a false token` });
			}
		}),
	z
		.object({
			...valueSource,
			type: z.literal("select"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("multiSelect"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
			separator: z.string().min(1).max(10).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("json"), parse: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("slug") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
```

then replace
```ts

export type Template = z.infer<typeof templateSchema>;
type FieldMapping = Template["fields"][string];

export type FieldValue = string | number | null;
export type MappedRecord = { key: string; slug?: string; data: Record<string, FieldValue> };
export type ValueErrorCode =
```
with:
```ts

export type Template = z.infer<typeof templateSchema>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];

export type { JsonValue, TargetField };
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
export type MappedRecord = { key: string; slug?: string; data: Record<string, FieldValue> };
export type ValueErrorCode =
```

then replace
```ts
	| "expr_error"
	| "expr_limit"
	| "not_scalar"
	| "missing_key"
	| "key_too_long"
	| "invalid_number"
	| "invalid_date"
	| "empty_slug";
export type ValueError = { field: string; code: ValueErrorCode; message: string };

```
with:
```ts
	| "expr_error"
	| "expr_limit"
	| "missing_key"
	| "key_too_long"
	| "invalid_date"
	| "empty_slug"
	| ConversionCode
	| RuleCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

```

then replace
```ts
	| { ok: true; value: FieldValue }
	| { ok: false; code: ValueErrorCode; message: string };

const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";

/** A source value as text (numbers and booleans as their string), or null for an object or array. */
```
with:
```ts
	| { ok: true; value: FieldValue }
	| { ok: false; code: ValueErrorCode; message: string };
export type FieldConverter = (raw: unknown) => Converted;

/** A source value as text (numbers and booleans as their string), or null for an object or array. */
```

then replace
```ts
}

function convertText(mapping: FieldMapping, raw: string): Converted {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, value: null };
	switch (mapping.type) {
		case "text":
			return { ok: true, value: raw };
		case "number": {
			if (!NUMBER_RE.test(trimmed)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			const n = Number(trimmed);
			if (!Number.isFinite(n)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			return { ok: true, value: n };
		}
		case "date": {
			const dt = mapping.format
				? DateTime.fromFormat(trimmed, mapping.format, { zone: mapping.tz })
				: DateTime.fromISO(trimmed, { zone: mapping.tz });
			if (!dt.isValid) {
				const expected = mapping.format ?? "ISO 8601";
				return {
					ok: false,
					code: "invalid_date",
					message: `"${trimmed}" is not a ${expected} date`,
				};
			}
			return { ok: true, value: dt.toUTC().toISO() };
		}
	}
}

/**
 * Converts a typed source value. A JSON number goes into a number field as it is; numbers and
 * booleans become their string for text and date fields; `true`/`false` are not numbers; an
 * object or array fails with `not_scalar`; a missing path or `null` is `null`.
 */
function convert(mapping: FieldMapping, raw: unknown): Converted {
	if (mapping.type === "number" && typeof raw === "number") {
		return Number.isFinite(raw)
			? { ok: true, value: raw }
			: { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	if (mapping.type === "number" && typeof raw === "boolean") {
		return { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	const text = scalarText(raw);
	if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
	return convertText(mapping, text);
}

```
with:
```ts
}

/** Text as given (untrimmed); `slug` through `slugify`, failing `empty_slug` if nothing is left. */
function textConverter(slug: boolean): FieldConverter {
	return (raw) => {
		const text = scalarText(raw);
		if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		if (text.trim() === "") return { ok: true, value: null };
		if (!slug) return { ok: true, value: text };
		const value = slugify(text);
		if (value === "") return { ok: false, code: "empty_slug", message: "The slug would be empty" };
		return { ok: true, value };
	};
}

/**
 * The conversion for one mapping (values.ts, dates.ts): a missing path or `null` is empty, an
 * object or array fails `not_scalar` except for `multiSelect` and `json`, and empty text is
 * `null`. `target` is the field from the job's snapshot (null for jobs created before M4a): it
 * gives select options and whether a date goes into a text field. `tz: "site"` reads
 * `siteTimezone`.
 */
export function fieldConverter(
	mapping: FieldMapping,
	target: TargetField | null,
	siteTimezone: string,
): FieldConverter {
	switch (mapping.type) {
		case "text":
			return textConverter(false);
		case "slug":
			return textConverter(true);
		case "number":
			return numberConverter(mapping);
		case "boolean":
			return booleanConverter(mapping);
		case "select":
			return selectConverter(mapping, target?.options);
		case "multiSelect":
			return multiSelectConverter(mapping, target?.options);
		case "json":
			return jsonConverter(mapping);
		case "date": {
			const tz = mapping.tz === SITE_TIMEZONE ? siteTimezone : mapping.tz;
			return dateConverter(
				{ format: mapping.format, tz, output: mapping.output },
				target?.type ?? null,
			);
		}
	}
}

```

then replace
```ts
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
}

```
with:
```ts
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
	/** Each field's conversion, by field name. */
	readonly converters: ReadonlyMap<string, FieldConverter>;
	/** The job's target field snapshot; null for jobs created before M4a (no field rules). */
	readonly targets: Readonly<Record<string, TargetField>> | null;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
export interface CompileContext {
	targets?: Readonly<Record<string, TargetField>> | undefined;
	/** The site timezone stored on the job; `UTC` when absent. */
	siteTimezone?: string | undefined;
}

```

then replace
```ts
export function compileTemplate(
	t: Template,
): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] } {
	const problems: string[] = [];
```
with:
```ts
export function compileTemplate(
	t: Template,
	context: CompileContext = {},
): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] } {
	const problems: string[] = [];
```

then replace
```ts
	const slug = compile("slug.expr", t.slug?.expr);
	const fields = new Map<string, CompiledExpression>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, compiled: { template: t, filter, key, slug, fields } };
}

```
with:
```ts
	const slug = compile("slug.expr", t.slug?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
		converters.set(
			name,
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, compiled: { template: t, filter, key, slug, fields, converters, targets } };
}

```

then replace
```ts
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
		const result = convert(mapping, raw);
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

```
with:
```ts
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
		const result = (c.converters.get(field) as FieldConverter)(raw);
		if (!result.ok) {
			errors.push({ field, code: result.code, message: result.message });
			continue;
		}
		const target = c.targets?.[field];
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length === 0) data[field] = result.value;
	}

```

then replace
```ts
export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<FieldMapping["type"], string[]> = {
	text: ["string", "text", "url"],
	number: ["number", "integer"],
	date: ["datetime"],
};

```
with:
```ts
export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<MappingType, string[]> = {
	text: ["string", "text", "url", "slug"],
	number: ["number", "integer"],
	date: ["datetime", "string", "text"],
	boolean: ["boolean"],
	select: ["select"],
	multiSelect: ["multiSelect"],
	json: ["json"],
	slug: ["slug", "string"],
};

```

In `packages/flux-import/src/engine/types.ts`, replace
```ts
import type { ContentPort, KvCollection, SourcePort } from "./ports.js";
import type { Template } from "./template.js";

export const BATCH_SIZE_DEFAULT = 50;
```
with:
```ts
import type { ContentPort, KvCollection, SourcePort } from "./ports.js";
import type { Template } from "./template.js";
import type { TargetField } from "./values.js";

export const BATCH_SIZE_DEFAULT = 50;
```

then replace
```ts
	/** XLSX: the uploaded workbook; `uploadId` is the JSON Lines it was converted to. */
	sourceUploadId?: string;
	cursor: { offset: number; seq: number };
	counters: Counters;
```
with:
```ts
	/** XLSX: the uploaded workbook; `uploadId` is the JSON Lines it was converted to. */
	sourceUploadId?: string;
	/**
	 * The mapped fields as they were at job creation (type, `required`, validation), checked
	 * before every write. Absent on jobs created before M4a, which keep M2 behaviour.
	 */
	targetFields?: Record<string, TargetField>;
	/** The site timezone read at job creation, for `tz: "site"`; absent before M4a (UTC). */
	siteTimezone?: string;
	cursor: { offset: number; seq: number };
	counters: Counters;
```

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
		}
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job));
		if (!compiled.ok) {
			outcome = {
```
with:
```ts
		}
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
		});
		if (!compiled.ok) {
			outcome = {
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run template batch`
Expected: PASS (131 tests in `template.test.ts` and `batch.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 37 files / 967 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/batch.test.ts
git commit -m "Map booleans, selects, multi-selects, JSON and slugs, and check each value against the job's field snapshot"
```

### Task 4: Type-aware diff

**Files:**
- Modify: `packages/flux-import/src/engine/diff.ts`, `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/diff.test.ts`

**Interfaces:**
- Consumes: Task 3 (`FieldValue`, `Template` with the new mapping types, `Job.targetFields`); E4.
- Produces (`src/engine/diff.ts`): `type Comparison = "instant" | "boolean" | "deep" | "plain"`; `deepEqual(a, b)`; `planRecord(current, next, comparisons: ReadonlyMap<string, Comparison>)`; `comparisonsOf(t, targets?)`. `dateFieldsOf` is removed (its only caller was `batch.ts`).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `packages/flux-import/tests/unit/diff.test.ts` with:
```ts
import { describe, expect, it } from "vitest";
import { type Comparison, comparisonsOf, deepEqual, planRecord } from "../../src/engine/diff.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
const next = {
	key: "A1",
	slug: "desk",
	data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00.000Z", note: null },
};

describe("planRecord", () => {
	it("plans a create with every non-null field and the slug", () => {
		expect(planRecord(null, next, dates)).toEqual({
			action: "create",
			changes: [
				{ field: "slug", before: null, after: "desk" },
				{ field: "title", before: null, after: "Desk" },
				{ field: "price", before: null, after: 12.5 },
				{ field: "released", before: null, after: "2026-03-01T08:00:00.000Z" },
			],
		});
	});

	it("is unchanged when values match, treating undefined as null and dates by instant", () => {
		const current = {
			slug: "desk",
			data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00Z" },
		};
		expect(planRecord(current, next, dates)).toEqual({ action: "unchanged", changes: [] });
	});

	it("lists only the fields that differ", () => {
		const current = {
			slug: "old-desk",
			data: { title: "Desk", price: 10, released: "2026-03-01T08:00:00Z", note: "x" },
		};
		expect(planRecord(current, next, dates)).toEqual({
			action: "update",
			changes: [
				{ field: "slug", before: "old-desk", after: "desk" },
				{ field: "price", before: 10, after: 12.5 },
				{ field: "note", before: "x", after: null },
			],
		});
	});

	it("ignores the slug when the template does not map one", () => {
		const { slug: _s, ...noSlug } = next;
		const current = {
			slug: "anything",
			data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00Z" },
		};
		expect(planRecord(current, noSlug, dates).action).toBe("unchanged");
	});

	it("treats an unparseable stored date as different", () => {
		const current = { slug: "desk", data: { title: "Desk", price: 12.5, released: "garbage" } };
		expect(planRecord(current, next, dates).changes.map((c) => c.field)).toEqual(["released"]);
	});

	it("compares booleans with EmDash's stored 0 and 1", () => {
		const how = new Map<string, Comparison>([["on", "boolean"]]);
		const plan = (before: unknown, after: boolean | null) =>
			planRecord({ slug: null, data: { on: before } }, { key: "k", data: { on: after } }, how)
				.action;
		expect(plan(1, true)).toBe("unchanged");
		expect(plan(0, false)).toBe("unchanged");
		expect(plan(true, true)).toBe("unchanged");
		expect(plan(0, true)).toBe("update");
		expect(plan(1, false)).toBe("update");
		expect(plan(null, false)).toBe("update");
		expect(plan(0, null)).toBe("update");
	});

	it("compares multiSelect and json values deeply", () => {
		const how = new Map<string, Comparison>([
			["tags", "deep"],
			["specs", "deep"],
		]);
		const current = {
			slug: null,
			data: { tags: ["red", "blue"], specs: { w: 120, dims: [1, 2], meta: { a: null } } },
		};
		const same = { tags: ["red", "blue"], specs: { meta: { a: null }, dims: [1, 2], w: 120 } };
		expect(planRecord(current, { key: "k", data: same }, how).action).toBe("unchanged");
		const reordered = { ...same, tags: ["blue", "red"] };
		expect(planRecord(current, { key: "k", data: reordered }, how).changes).toEqual([
			{ field: "tags", before: ["red", "blue"], after: ["blue", "red"] },
		]);
		const moved = { ...same, specs: { w: 120, dims: [2, 1], meta: { a: null } } };
		expect(planRecord(current, { key: "k", data: moved }, how).action).toBe("update");
		const json = (before: unknown, after: unknown) =>
			planRecord(
				{ slug: null, data: { specs: before } },
				{ key: "k", data: { specs: after as never } },
				how,
			).action;
		expect(json(1, true)).toBe("unchanged");
		expect(json(5, 5)).toBe("unchanged");
		expect(json("x", "x")).toBe("unchanged");
		expect(json({ a: 1 }, { a: 1, b: 2 })).toBe("update");
	});

	it("does not plan an update for text EmDash read back as JSON when it is canonical", () => {
		const plain = new Map<string, Comparison>();
		const plan = (before: unknown, after: string) =>
			planRecord({ slug: null, data: { note: before } }, { key: "k", data: { note: after } }, plain)
				.action;
		expect(plan({ a: [1, 2] }, '{"a":[1,2]}')).toBe("unchanged");
		expect(plan([1, "x"], '[1,"x"]')).toBe("unchanged");
		expect(plan({ a: [1, 2] }, '{ "a": [1, 2] }')).toBe("update");
		expect(plan("{x", "{x")).toBe("unchanged");
		expect(plan(5, "5")).toBe("update");
	});
});

describe("deepEqual", () => {
	it("compares keys in any order, arrays in order and -0 as 0", () => {
		expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(deepEqual([1, 2], [2, 1])).toBe(false);
		expect(deepEqual(-0, 0)).toBe(true);
		expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
		expect(deepEqual([1], { 0: 1 })).toBe(false);
		expect(deepEqual(null, {})).toBe(false);
	});
});

describe("comparisonsOf", () => {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			released: { from: "Date", type: "date" },
			day: { from: "Date", type: "date" },
			on: { from: "On", type: "boolean" },
			tags: { from: "Tags", type: "multiSelect" },
			specs: { from: "Specs", type: "json" },
			status: { from: "Status", type: "select" },
		},
	});

	it("compares by the target field type", () => {
		const targets = {
			title: { type: "string" },
			released: { type: "datetime" },
			day: { type: "string" },
			on: { type: "boolean" },
			tags: { type: "multiSelect" },
			specs: { type: "json" },
			status: { type: "select" },
		};
		expect(Object.fromEntries(comparisonsOf(t, targets))).toEqual({
			title: "plain",
			released: "instant",
			day: "plain",
			on: "boolean",
			tags: "deep",
			specs: "deep",
			status: "plain",
		});
	});

	it("compares date mappings as instants for jobs without a target snapshot", () => {
		expect(Object.fromEntries(comparisonsOf(t))).toMatchObject({
			title: "plain",
			released: "instant",
			day: "instant",
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run diff`
Expected: FAIL — 6 of 11 tests: the boolean, deep and canonical-JSON comparisons plan `update` ("expected 'update' to be 'unchanged'"), and `deepEqual` and `comparisonsOf` are not functions.

- [ ] **Step 3: Compare by target type**

Replace the contents of `packages/flux-import/src/engine/diff.ts` with:
```ts
import type { FieldValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
export type PlanAction = "create" | "update" | "unchanged";
export type RecordPlan = { action: PlanAction; changes: Change[] };
export type CurrentEntry = { slug: string | null; data: Record<string, unknown> };

/**
 * How a field's stored value is compared with the mapped one: `instant` for datetimes, `boolean`
 * against EmDash's stored 0/1, `deep` for multiSelect and json values, `plain` for the rest.
 */
export type Comparison = "instant" | "boolean" | "deep" | "plain";

/** Object keys in any order, arrays in order, `-0` equal to `0`. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	const bo = b as Record<string, unknown>;
	const ao = a as Record<string, unknown>;
	return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

function same(before: unknown, after: FieldValue, how: Comparison): boolean {
	const b = before ?? null;
	if (b === null || after === null) return b === after;
	// EmDash stores a boolean as 0 or 1 and reads it back as that number, in boolean fields and
	// as the whole value of a json field.
	if ((how === "boolean" || how === "deep") && typeof after === "boolean") {
		return b === after || b === (after ? 1 : 0);
	}
	switch (how) {
		case "instant":
			if (typeof b === "string" && typeof after === "string") {
				const tb = Date.parse(b);
				return !Number.isNaN(tb) && tb === Date.parse(after);
			}
			return Object.is(b, after);
		case "deep":
			return deepEqual(b, after);
		default:
			// EmDash reads stored text that starts with { or [ and parses as JSON back parsed: such
			// text is unchanged when it is exactly the parsed value's canonical JSON.
			if (typeof after === "string" && typeof b === "object") return JSON.stringify(b) === after;
			return Object.is(b, after);
	}
}

export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
		if (next.slug !== undefined) changes.push({ field: "slug", before: null, after: next.slug });
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		return { action: "create", changes };
	}
	if (next.slug !== undefined && current.slug !== next.slug) {
		changes.push({ field: "slug", before: current.slug, after: next.slug });
	}
	for (const [field, after] of Object.entries(next.data)) {
		const before = Object.hasOwn(current.data, field) ? current.data[field] : null;
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}

const BY_TARGET: Record<string, Comparison> = {
	datetime: "instant",
	boolean: "boolean",
	multiSelect: "deep",
	json: "deep",
};

/**
 * How each mapped field compares: by the target field's type from the job's snapshot, or, for
 * jobs created before M4a, `instant` for date mappings (all of which went into datetime fields).
 */
export function comparisonsOf(
	t: Template,
	targets?: Readonly<Record<string, { type: string }>>,
): Map<string, Comparison> {
	return new Map(
		Object.entries(t.fields).map(([field, mapping]): [string, Comparison] => {
			const target = targets?.[field];
			if (target === undefined) return [field, mapping.type === "date" ? "instant" : "plain"];
			return [field, BY_TARGET[target.type] ?? "plain"];
		}),
	);
}
```

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import { dateFieldsOf, type PlanAction, planRecord, type RecordPlan } from "./diff.js";
import { JobError, jobReader, jobTemplate, updateJob, upgradeJob } from "./jobs.js";
import { ContentWriteError, type EntrySnapshot, SourceMissingError } from "./ports.js";
```
with:
```ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import { comparisonsOf, type PlanAction, planRecord, type RecordPlan } from "./diff.js";
import { JobError, jobReader, jobTemplate, updateJob, upgradeJob } from "./jobs.js";
import { ContentWriteError, type EntrySnapshot, SourceMissingError } from "./ports.js";
```

then replace
```ts
		}
		entryId = entry?.id ?? null;
		const plan = planRecord(entry, mapped.value, dateFieldsOf(job.template));
		action = plan.action;
		if (job.dryRun)
```
with:
```ts
		}
		entryId = entry?.id ?? null;
		const plan = planRecord(entry, mapped.value, comparisonsOf(job.template, job.targetFields));
		action = plan.action;
		if (job.dryRun)
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run diff`
Expected: PASS (11 tests in `diff.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 37 files / 972 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/diff.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/diff.test.ts
git commit -m "Compare booleans with stored 0 and 1, and multi-selects and JSON deeply, when planning updates"
```

### Task 5: Schema checks, field snapshot and site timezone at job creation

**Files:**
- Create: `packages/flux-import/src/emdash/timezone.ts`
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/template.test.ts`, `schema.test.ts`, `jobs.test.ts`, `timezone.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 (mapping types, `TargetField`, `SITE_TIMEZONE`, `MappingType`, `FieldMapping`); `getSiteSetting` (V1); E2, E5, E6, L2.
- Produces (`src/engine/template.ts`): `type FieldRules`; `SchemaField` gains optional `required`, `hasDefault`, `validation`, `unsupported`, `storageless`; `checkTemplate(t, fields, columns, siteTimezone = "UTC")` with the spec's further problems; `targetFieldsOf(t, fields)`; `usesSiteTimezone(t)`.
- Produces (`src/engine/jobs.ts`): `CreateJobInput.siteTimezone?: string` (and so `StartJobInput`); `createJob` stores `targetFields` and, for `tz: "site"` templates, `siteTimezone`.
- Produces (`src/emdash/schema.ts`): `interface RegistryField`; `SchemaRegistryLike.getCollectionWithFields` returns `{ fields: RegistryField[] }`; `listSchemaFields` returns the widened `SchemaField`s.
- Produces (`src/emdash/timezone.ts`): `readSiteTimezone(read?)`, `needsSiteTimezone(template: unknown)`.
- Produces (`src/plugin/routes.ts`): `jobs/create` passes `siteTimezone` for `tz: "site"` templates.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, replace
```ts
	filterRecord,
	missingPathWarnings,
	slugify,
	type Template,
	templatePaths,
	templateSchema,
```
with:
```ts
	filterRecord,
	missingPathWarnings,
	type SchemaField,
	slugify,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
```

then replace
```ts
			launch_day: "2025-01-24T23:30:00.000Z",
		});
	});
});
```
with:
```ts
			launch_day: "2025-01-24T23:30:00.000Z",
		});
	});
});

describe("checkTemplate for M4a field types", () => {
	const t = templateSchema.parse(typed);
	const columns = Object.keys(typedRow);
	const fields: SchemaField[] = [
		{ slug: "title", type: "string", required: true },
		{ slug: "price", type: "number" },
		{ slug: "stock", type: "integer" },
		{ slug: "featured", type: "boolean" },
		{ slug: "status", type: "select", validation: { options: ["draft", "Published"] } },
		{ slug: "colours", type: "multiSelect" },
		{ slug: "released", type: "datetime" },
		{ slug: "sold_on", type: "datetime" },
		{ slug: "launch_day", type: "text" },
		{ slug: "specs", type: "json" },
		{ slug: "legacy_slug", type: "slug" },
		{ slug: "flux_source_id", type: "string", required: true },
		{ slug: "sku_code", type: "string", required: true, hasDefault: true },
		{ slug: "notes", type: "text", required: false },
	];
	const check = (patch: Partial<Record<string, Partial<SchemaField>>>, tz = "Europe/Chisinau") =>
		checkTemplate(
			t,
			fields.map((f) => ({ ...f, ...patch[f.slug] })),
			columns,
			tz,
		);

	it("accepts the spec template on fitting fields (map values match options ignoring case)", () => {
		expect(check({})).toEqual([]);
	});

	it.each([
		["text", ["string", "text", "url", "slug"], ["number", "select", "json"]],
		["number", ["number", "integer"], ["string", "boolean"]],
		["date", ["datetime", "string", "text"], ["url", "slug", "number"]],
		["boolean", ["boolean"], ["integer", "string"]],
		["select", ["select"], ["multiSelect", "string"]],
		["multiSelect", ["multiSelect"], ["select", "json"]],
		["json", ["json"], ["text", "multiSelect"]],
		["slug", ["slug", "string"], ["text", "url"]],
	])("lets a %s mapping fill %j and not %j", (type, good, bad) => {
		const one = templateSchema.parse({ ...typed, fields: { f: { from: "x", type } } });
		for (const fieldType of good) {
			expect(checkTemplate(one, [{ slug: "f", type: fieldType }], null)).toEqual([]);
		}
		for (const fieldType of bad) {
			expect(checkTemplate(one, [{ slug: "f", type: fieldType }], null)).toEqual([
				expect.stringMatching(
					`^Field "f" has type "${fieldType}"; a ${type} mapping needs one of `,
				),
			]);
		}
	});

	it("refuses output into a datetime field and map values that are not options", () => {
		const bad = templateSchema.parse({
			...typed,
			fields: {
				...typed.fields,
				launch_day: { from: "Launch", type: "date", output: "yyyy" },
				status: { from: "Status", type: "select", map: { a: "draft", b: "gone", c: "PUBLISHED" } },
				colours: { from: "Colours", type: "multiSelect", map: { r: "Red" }, ignoreCase: false },
			},
		});
		const patched = fields.map((f) =>
			f.slug === "launch_day"
				? { ...f, type: "datetime" }
				: f.slug === "colours"
					? { ...f, validation: { options: ["red"] } }
					: f,
		);
		expect(checkTemplate(bad, patched, columns, "UTC")).toEqual([
			'Field "status" maps to "gone", which is not one of its options (draft, Published)',
			'Field "colours" maps to "Red", which is not one of its options (red)',
			'Field "launch_day" is a datetime field; "output" only formats text fields',
		]);
	});

	it("reports an unmapped required field without a default", () => {
		expect(check({ notes: { required: true } })).toEqual([
			'Field "notes" is required and has no default, but the template does not map it',
		]);
		expect(check({ notes: { required: true, hasDefault: true } })).toEqual([]);
	});

	it("refuses unsupported and storage-less fields", () => {
		expect(check({ title: { unsupported: true }, specs: { storageless: true } })).toEqual([
			'Field "title" has a field type this EmDash version cannot read',
			'Field "specs" keeps its values outside the content table and cannot be imported',
		]);
	});

	it("refuses tz: site when the site timezone is not a valid IANA zone", () => {
		expect(check({}, "Mars/Base")).toEqual([
			'Field "released" reads dates in the site timezone, but "Mars/Base" is not a valid IANA timezone',
		]);
		expect(check({}, "UTC")).toEqual([]);
	});
});

describe("targetFieldsOf", () => {
	it("snapshots type, required and the enforced validation keys of mapped fields", () => {
		const t = templateSchema.parse(typed);
		const snapshot = targetFieldsOf(t, [
			{ slug: "title", type: "string", required: true, validation: { maxLength: 20, pattern: "" } },
			{ slug: "price", type: "number", validation: { min: 0, max: 1e6 } },
			{ slug: "status", type: "select", validation: { options: ["draft"] } },
			{ slug: "colours", type: "multiSelect", validation: { options: [] } },
			{ slug: "notes", type: "text", required: true },
		]);
		expect(snapshot).toEqual({
			title: { type: "string", required: true, maxLength: 20 },
			price: { type: "number", required: false, min: 0, max: 1e6 },
			status: { type: "select", required: false, options: ["draft"] },
			colours: { type: "multiSelect", required: false },
		});
	});
});
```

In `packages/flux-import/tests/unit/schema.test.ts`, replace
```ts
		const registry = new FakeRegistry();
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string" },
		]);
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});
});
```
with:
```ts
		const registry = new FakeRegistry();
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string", required: false, hasDefault: false, validation: {} },
		]);
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});

	it("lists required, defaults, the enforced validation keys and unusable fields", async () => {
		const registry: SchemaRegistryLike = Object.assign(new FakeRegistry(), {
			getCollectionWithFields: async () => ({
				fields: [
					{
						slug: "sku",
						type: "string",
						required: true,
						defaultValue: "",
						validation: { minLength: 2, maxLength: 9, pattern: "^[A-Z]", options: [] },
					},
					{ slug: "status", type: "select", validation: { options: ["a", "b"] } },
					{ slug: "qty", type: "integer", required: false, validation: { min: 0, max: 5 } },
					{ slug: "weird", type: "string", unsupportedType: { type: "geo", path: "type" } },
					{ slug: "author", type: "reference", validation: { relation: "posts_author" } },
					{ slug: "legacy", type: "reference", validation: null },
					{ slug: "loose", type: "text", validation: { pattern: "", min: "1" as never } },
				],
			}),
		});
		expect(await listSchemaFields(registry, "products")).toEqual([
			{
				slug: "sku",
				type: "string",
				required: true,
				hasDefault: true,
				validation: { options: [], minLength: 2, maxLength: 9, pattern: "^[A-Z]" },
			},
			{
				slug: "status",
				type: "select",
				required: false,
				hasDefault: false,
				validation: { options: ["a", "b"] },
			},
			{
				slug: "qty",
				type: "integer",
				required: false,
				hasDefault: false,
				validation: { min: 0, max: 5 },
			},
			{
				slug: "weird",
				type: "string",
				required: false,
				hasDefault: false,
				validation: {},
				unsupported: true,
			},
			{
				slug: "author",
				type: "reference",
				required: false,
				hasDefault: false,
				validation: {},
				storageless: true,
			},
			{ slug: "legacy", type: "reference", required: false, hasDefault: false, validation: {} },
			{ slug: "loose", type: "text", required: false, hasDefault: false, validation: {} },
		]);
	});
});
```

In `packages/flux-import/tests/unit/jobs.test.ts`, replace
```ts
			},
		);
	});

```
with:
```ts
			},
		);
	});

	it("stores the target field snapshot, and the site timezone only for tz: site", async () => {
		const { deps } = setup("sku,Name,Day\nA1,Desk,2026-03-01\n");
		const fields = [
			{ slug: "title", type: "string", required: true, validation: { maxLength: 40 } },
			{ slug: "day", type: "datetime" },
			{ slug: "body", type: "text" },
		];
		const dated = (tz: string) => ({
			...template,
			fields: { ...template.fields, day: { from: "Day", type: "date", tz } },
		});
		const job = await createJob(deps, {
			uploadId: "u1",
			template: dated("site"),
			schemaFields: fields,
			siteTimezone: "Europe/Chisinau",
		});
		expect(job).toMatchObject({
			targetFields: {
				title: { type: "string", required: true, maxLength: 40 },
				day: { type: "datetime", required: false },
			},
			siteTimezone: "Europe/Chisinau",
		});
		expect(job.targetFields).not.toHaveProperty("body");
		const fixed = await createJob(deps, {
			uploadId: "u1",
			template: dated("Asia/Tokyo"),
			schemaFields: fields,
			siteTimezone: "Europe/Chisinau",
		});
		expect(fixed).not.toHaveProperty("siteTimezone");
		const unset = await createJob(deps, {
			uploadId: "u1",
			template: dated("site"),
			schemaFields: fields,
		});
		expect(unset.siteTimezone).toBe("UTC");
	});

	it("refuses tz: site with an invalid site timezone, and unmapped required fields", async () => {
		const { deps } = setup("sku,Name,Day\nA1,Desk,2026-03-01\n");
		const err = await createJob(deps, {
			uploadId: "u1",
			template: { ...template, fields: { day: { from: "Day", type: "date", tz: "site" } } },
			schemaFields: [
				{ slug: "title", type: "string", required: true },
				{ slug: "day", type: "datetime" },
			],
			siteTimezone: "Moon/Base",
		}).catch((e: unknown) => e);
		expect(err).toMatchObject({
			code: "invalid_template",
			details: [
				'Field "day" reads dates in the site timezone, but "Moon/Base" is not a valid IANA timezone',
				'Field "title" is required and has no default, but the template does not map it',
			],
		});
	});

```

Create `packages/flux-import/tests/unit/timezone.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { needsSiteTimezone, readSiteTimezone } from "../../src/emdash/timezone.js";

describe("readSiteTimezone", () => {
	it("reads the setting, falling back to UTC when it is not set", async () => {
		expect(await readSiteTimezone(async () => "Europe/Chisinau")).toBe("Europe/Chisinau");
		expect(await readSiteTimezone(async () => undefined)).toBe("UTC");
		expect(await readSiteTimezone(async () => " ")).toBe("UTC");
		// An invalid zone is passed on: job creation reports it for templates that use it.
		expect(await readSiteTimezone(async () => "Mars/Base")).toBe("Mars/Base");
	});
});

describe("needsSiteTimezone", () => {
	const template = (tz?: string) => ({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: { day: { from: "Day", type: "date", ...(tz === undefined ? {} : { tz }) } },
	});

	it("is true only for a valid template with a tz: site date mapping", () => {
		expect(needsSiteTimezone(template("site"))).toBe(true);
		expect(needsSiteTimezone(template("Europe/Chisinau"))).toBe(false);
		expect(needsSiteTimezone(template())).toBe(false);
		expect(needsSiteTimezone({ ...template("site"), version: 2 })).toBe(false);
		expect(needsSiteTimezone(null)).toBe(false);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run template schema jobs timezone`
Expected: FAIL — `timezone.test.ts` cannot load `../../src/emdash/timezone.js`, and 9 of 153 tests fail: both `listSchemaFields` tests (it returns only slug and type), five `template.test.ts` tests (none of the new problems is reported; `targetFieldsOf` is missing) and both new `jobs.test.ts` tests (no snapshot is stored; the invalid site timezone and the unmapped required field create a job). The compatibility-table tests already pass after Task 3.

- [ ] **Step 3: Check templates against the fields and store the snapshot**

In `packages/flux-import/src/engine/template.ts`, replace
```ts
import { DateTime } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
```
with:
```ts
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
```

then replace
```ts
}

export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<MappingType, string[]> = {
```
with:
```ts
}

/** The validation keys EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:240-290). */
export type FieldRules = Pick<
	TargetField,
	"options" | "min" | "max" | "minLength" | "maxLength" | "pattern"
>;

/**
 * A collection field as `checkTemplate` sees it. Only `slug` and `type` are always known; the
 * rest comes from `listSchemaFields` and is absent in callers that only check types.
 */
export type SchemaField = {
	slug: string;
	type: string;
	required?: boolean;
	/** The field has a `defaultValue`, which EmDash fills in when a create leaves it out. */
	hasDefault?: boolean;
	validation?: FieldRules;
	/** The stored type is one this EmDash cannot interpret (`Field.unsupportedType`). */
	unsupported?: boolean;
	/** The field keeps its values outside the content table (a bound reference). */
	storageless?: boolean;
};

const COMPATIBLE: Record<MappingType, string[]> = {
```

then replace
```ts
};

/**
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, and
 * fields the collection lacks or types it cannot take.
 */
export function checkTemplate(
```
with:
```ts
};

/** Whether `value` names one of `options`, as the select matching would find it. */
function matchesOption(value: string, options: readonly string[], ignoreCase: boolean): boolean {
	if (options.includes(value)) return true;
	return ignoreCase && options.some((o) => o.toLowerCase() === value.toLowerCase());
}

/** Problems with one mapping against its existing collection field. */
function fieldProblems(
	field: string,
	mapping: FieldMapping,
	target: SchemaField,
	siteTimezone: string,
): string[] {
	if (target.unsupported) {
		return [`Field "${field}" has a field type this EmDash version cannot read`];
	}
	if (target.storageless) {
		return [`Field "${field}" keeps its values outside the content table and cannot be imported`];
	}
	const compatible = COMPATIBLE[mapping.type];
	if (!compatible.includes(target.type)) {
		return [
			`Field "${field}" has type "${target.type}"; a ${mapping.type} mapping needs one of ${compatible.join(", ")}`,
		];
	}
	const problems: string[] = [];
	if (mapping.type === "date") {
		if (mapping.output !== undefined && target.type === "datetime") {
			problems.push(`Field "${field}" is a datetime field; "output" only formats text fields`);
		}
		if (mapping.tz === SITE_TIMEZONE && !IANAZone.isValidZone(siteTimezone)) {
			problems.push(
				`Field "${field}" reads dates in the site timezone, but "${siteTimezone}" is not a valid IANA timezone`,
			);
		}
	}
	if ((mapping.type === "select" || mapping.type === "multiSelect") && mapping.map) {
		const options = target.validation?.options ?? [];
		if (options.length > 0) {
			const ignoreCase = mapping.ignoreCase ?? true;
			const bad = [...new Set(Object.values(mapping.map))].filter(
				(v) => !matchesOption(v, options, ignoreCase),
			);
			for (const value of bad) {
				problems.push(
					`Field "${field}" maps to "${value}", which is not one of its options (${options.join(", ")})`,
				);
			}
		}
	}
	return problems;
}

/**
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, fields
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, and required fields with no
 * default that the template does not map (every create would fail).
 */
export function checkTemplate(
```

then replace
```ts
	fields: SchemaField[],
	columns: readonly string[] | null,
): string[] {
	const errors: string[] = [];
```
with:
```ts
	fields: SchemaField[],
	columns: readonly string[] | null,
	siteTimezone = "UTC",
): string[] {
	const errors: string[] = [];
```

then replace
```ts
		if (problem !== null) errors.push(problem);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f.type]));
	for (const [field, mapping] of Object.entries(t.fields)) {
		const type = byslug.get(field);
		if (type === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else if (!COMPATIBLE[mapping.type].includes(type)) {
			errors.push(
				`Field "${field}" has type "${type}"; a ${mapping.type} mapping needs one of ${COMPATIBLE[mapping.type].join(", ")}`,
			);
		}
```
with:
```ts
		if (problem !== null) errors.push(problem);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	for (const [field, mapping] of Object.entries(t.fields)) {
		const target = byslug.get(field);
		if (target === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else {
			errors.push(...fieldProblems(field, mapping, target, siteTimezone));
		}
	}
	for (const f of fields) {
		if (
			f.required &&
			!f.hasDefault &&
			!Object.hasOwn(t.fields, f.slug) &&
			f.slug !== SOURCE_ID_FIELD
		) {
			errors.push(
				`Field "${f.slug}" is required and has no default, but the template does not map it`,
			);
		}
```

then replace
```ts
	return errors;
}
```
with:
```ts
	return errors;
}

/**
 * The snapshot of each mapped field stored on the job (`Job.targetFields`): its type, `required`,
 * and the validation keys EmDash enforces. Run `checkTemplate` first; unknown fields are skipped.
 */
export function targetFieldsOf(t: Template, fields: SchemaField[]): Record<string, TargetField> {
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	const targets: Record<string, TargetField> = {};
	for (const field of Object.keys(t.fields)) {
		const f = byslug.get(field);
		if (f === undefined) continue;
		const v = f.validation ?? {};
		targets[field] = {
			type: f.type,
			required: f.required ?? false,
			...(v.options && v.options.length > 0 ? { options: v.options } : {}),
			...(v.min === undefined ? {} : { min: v.min }),
			...(v.max === undefined ? {} : { max: v.max }),
			...(v.minLength === undefined ? {} : { minLength: v.minLength }),
			...(v.maxLength === undefined ? {} : { maxLength: v.maxLength }),
			...(v.pattern ? { pattern: v.pattern } : {}),
		};
	}
	return targets;
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
}
```

In `packages/flux-import/src/engine/jobs.ts`, replace
```ts
	type SchemaField,
	type Template,
	templatePaths,
	templateSchema,
	unresolvedPaths,
} from "./template.js";
import {
```
with:
```ts
	type SchemaField,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
	unresolvedPaths,
	usesSiteTimezone,
} from "./template.js";
import {
```

then replace
```ts
	/** XLSX: warnings from the conversion, stored before the job's own. */
	warnings?: string[];
	dryRun?: boolean;
	publish?: boolean;
```
with:
```ts
	/** XLSX: warnings from the conversion, stored before the job's own. */
	warnings?: string[];
	/** The site's timezone setting, for templates with `tz: "site"`; UTC when absent. */
	siteTimezone?: string;
	dryRun?: boolean;
	publish?: boolean;
```

then replace
```ts
	}

	const problems = checkTemplate(template, input.schemaFields, columns);
	if (problems.length > 0) {
		throw new JobError(
```
with:
```ts
	}

	const siteTimezone = usesSiteTimezone(template) ? (input.siteTimezone ?? "UTC") : undefined;
	const problems = checkTemplate(template, input.schemaFields, columns, siteTimezone);
	if (problems.length > 0) {
		throw new JobError(
```

then replace
```ts
		...(columns === null ? {} : { columns }),
		warnings,
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
```
with:
```ts
		...(columns === null ? {} : { columns }),
		warnings,
		targetFields: targetFieldsOf(template, input.schemaFields),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
```

In `packages/flux-import/src/emdash/schema.ts`, replace
```ts
import { ContentWriteError } from "../engine/ports.js";
import { type SchemaField, SOURCE_ID_FIELD } from "../engine/template.js";
import { emdashErrorCode } from "./errors.js";

```
with:
```ts
import { ContentWriteError } from "../engine/ports.js";
import { type FieldRules, type SchemaField, SOURCE_ID_FIELD } from "../engine/template.js";
import { emdashErrorCode } from "./errors.js";

```

then replace
```ts
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(
		slug: string,
	): Promise<{ fields: Array<{ slug: string; type: string }> } | null>;
}

```
with:
```ts
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(slug: string): Promise<{ fields: RegistryField[] } | null>;
}

/** The parts of EmDash's `Field` (src/schema/types.ts:320-344) the importer reads. */
export interface RegistryField {
	slug: string;
	type: string;
	required?: boolean;
	defaultValue?: unknown;
	validation?: (FieldRules & { relation?: string | undefined }) | null | undefined;
	unsupportedType?: unknown;
}

```

then replace
```ts
}

/** The collection's fields for `checkTemplate`, or `null` when the collection does not exist. */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
```
with:
```ts
}

/** The validation keys the importer checks, as numbers, strings and string arrays only. */
function rulesOf(validation: RegistryField["validation"]): FieldRules {
	const v = validation ?? {};
	const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
	const rules: FieldRules = {};
	if (Array.isArray(v.options) && v.options.every((o) => typeof o === "string")) {
		rules.options = [...v.options];
	}
	for (const key of ["min", "max", "minLength", "maxLength"] as const) {
		const n = num(v[key]);
		if (n !== undefined) rules[key] = n;
	}
	if (typeof v.pattern === "string" && v.pattern !== "") rules.pattern = v.pattern;
	return rules;
}

/**
 * The collection's fields for `checkTemplate` and the job's target snapshot, or `null` when the
 * collection does not exist: type, `required`, whether it has a default, the validation keys
 * EmDash enforces, and whether EmDash cannot read its type or keeps its values elsewhere (a
 * reference bound to a relation, `isStoragelessField` in src/schema/types.ts:120-125).
 */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
```

then replace
```ts
): Promise<SchemaField[] | null> {
	const found = await registry.getCollectionWithFields(collection);
	return found ? found.fields.map((f) => ({ slug: f.slug, type: f.type })) : null;
}
```
with:
```ts
): Promise<SchemaField[] | null> {
	const found = await registry.getCollectionWithFields(collection);
	if (!found) return null;
	return found.fields.map((f) => {
		const relation = f.validation?.relation;
		return {
			slug: f.slug,
			type: f.type,
			required: f.required === true,
			hasDefault: f.defaultValue !== undefined,
			validation: rulesOf(f.validation),
			...(f.unsupportedType === undefined ? {} : { unsupported: true }),
			...(f.type === "reference" && typeof relation === "string" && relation !== ""
				? { storageless: true }
				: {}),
		};
	});
}
```

Create `packages/flux-import/src/emdash/timezone.ts`:
```ts
import { getSiteSetting } from "emdash";
import { templateSchema, usesSiteTimezone } from "../engine/template.js";

/**
 * The site's timezone setting (`site:timezone`, read with `getSiteSetting`, `emdash`
 * src/settings/index.ts:182-203), or UTC when it is not set.
 */
export async function readSiteTimezone(
	read: () => Promise<string | undefined> = () => getSiteSetting("timezone"),
): Promise<string> {
	const tz = await read();
	return typeof tz === "string" && tz.trim() !== "" ? tz : "UTC";
}

/**
 * Whether a template from a request reads dates in the site timezone. An invalid template does
 * not: job creation reports its problems without reading the setting.
 */
export function needsSiteTimezone(template: unknown): boolean {
	const parsed = templateSchema.safeParse(template);
	return parsed.success && usesSiteTimezone(parsed.data);
}
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
```
with:
```ts
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
```

then replace
```ts
	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime, sources, xlsx }) => {
			const { input } = ctx;
			const start = (upload: string) => {
				const options: StartJobInput = {
```
with:
```ts
	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, async ({ deps, runtime, sources, xlsx }) => {
			const { input } = ctx;
			// Read once here and stored on the job, so a resumed or retried job converts the same way.
			const siteTimezone = needsSiteTimezone(input.template) ? await readSiteTimezone() : undefined;
			const start = (upload: string) => {
				const options: StartJobInput = {
```

then replace
```ts
					template: input.template,
					dryRun: input.dryRun,
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
```
with:
```ts
					template: input.template,
					dryRun: input.dryRun,
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run template schema jobs timezone`
Expected: PASS (155 tests in the four files). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 38 files / 991 tests, or 38 / 986 without Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/emdash/schema.ts packages/flux-import/src/emdash/timezone.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/schema.test.ts packages/flux-import/tests/unit/jobs.test.ts packages/flux-import/tests/unit/timezone.test.ts
git commit -m "Check mappings against field types and rules at job creation, and store the field snapshot and site timezone"
```

### Task 6: `schema/apply`

**Files:**
- Create: `packages/flux-import/src/plugin/schema-apply.ts`
- Modify: `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/src/plugin/definition.ts`
- Test: `packages/flux-import/tests/unit/schema-apply.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 3 (`FieldMapping`, `Template`, `templateSchema`, `SOURCE_ID_FIELD`), Task 5 (`routes.ts` as it leaves it); `RESERVED_FIELD_SLUGS`, `invalidateCollectionCache`, `invalidateSchemaObjectCache` from `emdash` (E1, E2, V2); `emdashErrorCode`; `ServiceError`.
- Produces (`src/plugin/schema-apply.ts`): `APPLY_FIELD_TYPES`, `type ApplyFieldType`, `MAX_APPLY_FIELDS` (100); `interface FieldRequest`, `ApplyInput`, `FieldChange`, `ApplyResult`, `ApplyRegistry`; `invalidateFieldCaches(collection)`; `labelOf(slug)`; `requestsFromTemplate(t)`; `requestProblems(requests)`; `planField(request, existing, addOptions)`; `applySchema(registry, input, invalidate = invalidateFieldCaches)`.
- Produces (`src/plugin/routes.ts`): the `schema/apply` route (`import:execute`, `POST`).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/schema-apply.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	type ApplyRegistry,
	applySchema,
	type FieldRequest,
	labelOf,
	planField,
	requestProblems,
} from "../../src/plugin/schema-apply.js";
import { ServiceError } from "../../src/plugin/service.js";

type Stored = {
	slug: string;
	type: string;
	validation?: { options?: string[]; maxLength?: number } | null | undefined;
	unsupportedType?: unknown;
};

const schemaError = (code: string, message: string) =>
	Object.assign(new Error(message), { name: "SchemaError", code });

class FakeApplyRegistry implements ApplyRegistry {
	readonly collections = new Map<string, Stored[]>();
	readonly calls: string[] = [];
	/** Fields another request creates just before our create of the same slug. */
	readonly raced = new Map<string, Stored>();
	/** A create of this slug fails with this error. */
	failOn: { slug: string; error: Error } | null = null;

	constructor(fields: Stored[] = []) {
		this.collections.set("products", fields);
	}

	async getCollectionWithFields(slug: string) {
		const fields = this.collections.get(slug);
		return fields ? { fields: fields.map((f) => ({ ...f })) } : null;
	}

	async createField(collection: string, input: Parameters<ApplyRegistry["createField"]>[1]) {
		this.calls.push(`create:${input.slug}:${JSON.stringify(input)}`);
		const fields = this.collections.get(collection)!;
		if (this.failOn?.slug === input.slug) throw this.failOn.error;
		const raced = this.raced.get(input.slug);
		if (raced) {
			fields.push(raced);
			throw schemaError("FIELD_EXISTS", `Field "${input.slug}" already exists`);
		}
		fields.push({ slug: input.slug, type: input.type, validation: input.validation ?? null });
		return {};
	}

	async updateField(
		collection: string,
		slug: string,
		input: { validation: Record<string, unknown> },
	) {
		this.calls.push(`update:${slug}:${JSON.stringify(input.validation)}`);
		const field = this.collections.get(collection)!.find((f) => f.slug === slug)!;
		field.validation = input.validation as Stored["validation"];
		return {};
	}
}

const invalidations: string[] = [];
const invalidate = (collection: string) => {
	invalidations.push(collection);
};

describe("planField", () => {
	const select: FieldRequest = { slug: "stage", type: "select", options: ["draft", "live"] };

	it("plans every row of the table", () => {
		expect(planField(select, undefined, false).change).toEqual({
			field: "stage",
			action: "create",
			type: "select",
			options: ["draft", "live"],
		});
		const same = {
			slug: "stage",
			type: "select",
			validation: { options: ["live", "draft", "old"] },
		};
		expect(planField(select, same, false).change.action).toBe("unchanged");
		expect(planField({ slug: "stage", type: "select" }, same, false).change.action).toBe(
			"unchanged",
		);
		const free = { slug: "stage", type: "select", validation: null };
		expect(planField(select, free, false).change.action).toBe("unchanged");
		const lacking = {
			slug: "stage",
			type: "select",
			validation: { options: ["draft"], maxLength: 9 },
		};
		expect(planField(select, lacking, true)).toEqual({
			change: { field: "stage", action: "add_options", type: "select", options: ["live"] },
			options: ["draft", "live"],
		});
		expect(planField(select, lacking, false).change).toEqual({
			field: "stage",
			action: "conflict",
			type: "select",
			message: 'Field "stage" lacks the options "live"; set addOptions to add them',
		});
		expect(
			planField({ slug: "sku_code", type: "string" }, { slug: "sku_code", type: "integer" }, true)
				.change,
		).toEqual({
			field: "sku_code",
			action: "conflict",
			type: "string",
			message: 'Field "sku_code" is "integer"; requested "string"',
		});
		const odd = {
			slug: "sku_code",
			type: "string",
			unsupportedType: { type: "geo", path: "type" },
		};
		expect(planField({ slug: "sku_code", type: "string" }, odd, true).change.action).toBe(
			"conflict",
		);
	});
});

describe("requestProblems", () => {
	it("refuses bad, reserved and duplicate slugs, misplaced options and unindexable types", () => {
		expect(
			requestProblems([
				{ slug: "Bad", type: "string" },
				{ slug: "status", type: "select" },
				{ slug: "flux_source_id", type: "string" },
				{ slug: "a".repeat(64), type: "string" },
				{ slug: "ok", type: "string", options: ["a"] },
				{ slug: "ok", type: "json", indexed: true },
				{ slug: "tags", type: "multiSelect", options: [] },
				{ slug: "tags2", type: "multiSelect", options: ["a", "a"] },
				{ slug: "tags3", type: "select", options: ["x".repeat(201)] },
				{ slug: "named", type: "text", label: "" },
				{ slug: "fine", type: "datetime", indexed: true, searchable: true, translatable: false },
			]),
		).toEqual([
			'Field "Bad": slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters',
			'Field "status": the slug is reserved',
			'Field "flux_source_id": the slug is reserved',
			`Field "${"a".repeat(64)}": slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters`,
			'Field "ok": only select and multiSelect fields take options',
			'Field "ok" is requested twice',
			'Field "ok": json fields cannot be indexed',
			'Field "tags": give 1-500 options',
			'Field "tags2": options must be distinct',
			'Field "tags3": options are 1-200 characters',
			'Field "named": labels are 1-200 characters',
		]);
	});
});

describe("applySchema", () => {
	it("creates missing fields with defaults, in request order, and clears caches once", async () => {
		const registry = new FakeApplyRegistry([{ slug: "title", type: "string" }]);
		invalidations.length = 0;
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "featured", type: "boolean" },
					{ slug: "title", type: "string" },
					{ slug: "unit_price", type: "number", indexed: true, label: "Price" },
					{ slug: "stage", type: "select", options: ["draft", "live"], translatable: false },
				],
			},
			invalidate,
		);
		expect(result).toEqual({
			collection: "products",
			dryRun: false,
			changes: [
				{ field: "featured", action: "create", type: "boolean" },
				{ field: "title", action: "unchanged", type: "string" },
				{ field: "unit_price", action: "create", type: "number" },
				{ field: "stage", action: "create", type: "select", options: ["draft", "live"] },
			],
			applied: ["featured", "unit_price", "stage"],
			error: null,
		});
		expect(registry.calls).toEqual([
			'create:featured:{"slug":"featured","label":"Featured","type":"boolean","indexed":false,"searchable":false,"translatable":true}',
			'create:unit_price:{"slug":"unit_price","label":"Price","type":"number","indexed":true,"searchable":false,"translatable":true}',
			'create:stage:{"slug":"stage","label":"Stage","type":"select","indexed":false,"searchable":false,"translatable":false,"validation":{"options":["draft","live"]}}',
		]);
		expect(invalidations).toEqual(["products"]);
	});

	it("adds missing options after the existing ones, keeping the rest of the validation", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "stage", type: "select", validation: { options: ["draft"], maxLength: 9 } },
		]);
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [{ slug: "stage", type: "select", options: ["live", "draft", "gone"] }],
				addOptions: true,
			},
			invalidate,
		);
		expect(result.changes).toEqual([
			{ field: "stage", action: "add_options", type: "select", options: ["live", "gone"] },
		]);
		expect(registry.calls).toEqual([
			'update:stage:{"options":["draft","live","gone"],"maxLength":9}',
		]);
	});

	it("reports conflicts and applies the other fields", async () => {
		const registry = new FakeApplyRegistry([{ slug: "sku_code", type: "integer" }]);
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "sku_code", type: "string" },
					{ slug: "specs", type: "json" },
				],
			},
			invalidate,
		);
		expect(result.changes.map((c) => c.action)).toEqual(["conflict", "create"]);
		expect(result.applied).toEqual(["specs"]);
		expect(registry.collections.get("products")![0]).toEqual({ slug: "sku_code", type: "integer" });
	});

	it("plans a dry run without calling the registry's writers or clearing caches", async () => {
		const registry = new FakeApplyRegistry();
		invalidations.length = 0;
		const result = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "featured", type: "boolean" }], dryRun: true },
			invalidate,
		);
		expect(result).toMatchObject({ dryRun: true, applied: [], changes: [{ action: "create" }] });
		expect(registry.calls).toEqual([]);
		expect(invalidations).toEqual([]);
	});

	it("re-plans a field another request created first", async () => {
		const registry = new FakeApplyRegistry();
		registry.raced.set("stage", {
			slug: "stage",
			type: "select",
			validation: { options: ["draft"] },
		});
		registry.raced.set("specs", { slug: "specs", type: "text" });
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "stage", type: "select", options: ["draft", "live"] },
					{ slug: "specs", type: "json" },
				],
				addOptions: true,
			},
			invalidate,
		);
		expect(result.changes).toEqual([
			{ field: "stage", action: "add_options", type: "select", options: ["live"] },
			{
				field: "specs",
				action: "conflict",
				type: "json",
				message: 'Field "specs" is "text"; requested "json"',
			},
		]);
		expect(result.applied).toEqual(["stage"]);
	});

	it("stops at an EmDash error, returning what was applied, and a rerun is safe", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = {
			slug: "b",
			error: schemaError("RESERVED_SLUG", 'Field slug "b" is reserved'),
		};
		invalidations.length = 0;
		const input = {
			collection: "products",
			fields: [
				{ slug: "a", type: "boolean" as const },
				{ slug: "b", type: "boolean" as const },
				{ slug: "c", type: "boolean" as const },
			],
		};
		const result = await applySchema(registry, input, invalidate);
		expect(result).toMatchObject({
			applied: ["a"],
			error: { code: "RESERVED_SLUG", message: 'Field slug "b" is reserved' },
		});
		expect(invalidations).toEqual(["products"]);
		registry.failOn = null;
		const again = await applySchema(registry, input, invalidate);
		expect(again.changes.map((c) => c.action)).toEqual(["unchanged", "create", "create"]);
		expect(again.applied).toEqual(["b", "c"]);
	});

	it("rethrows errors that are not EmDash's", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = { slug: "a", error: new TypeError("boom") };
		await expect(
			applySchema(
				registry,
				{ collection: "products", fields: [{ slug: "a", type: "json" }] },
				invalidate,
			),
		).rejects.toThrow("boom");
	});

	it("takes the fields from a template", async () => {
		const registry = new FakeApplyRegistry();
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "Name", type: "text" },
				price: { from: "Price", type: "number" },
				released: { from: "Date", type: "date" },
				launch_day: { from: "Launch", type: "date", output: "yyyy-MM-dd" },
				featured: { from: "F", type: "boolean" },
				stage: { from: "S", type: "select", map: { Live: "live", Up: "live", Hidden: "draft" } },
				colours: { from: "C", type: "multiSelect" },
				specs: { from: "J", type: "json" },
				handle: { from: "H", type: "slug" },
			},
		};
		const result = await applySchema(registry, { template, dryRun: true }, invalidate);
		expect(result.collection).toBe("products");
		expect(result.changes).toEqual([
			{ field: "title", action: "create", type: "string" },
			{ field: "price", action: "create", type: "number" },
			{ field: "released", action: "create", type: "datetime" },
			{ field: "launch_day", action: "create", type: "string" },
			{ field: "featured", action: "create", type: "boolean" },
			{ field: "stage", action: "create", type: "select", options: ["live", "draft"] },
			{ field: "colours", action: "create", type: "multiSelect" },
			{ field: "specs", action: "create", type: "json" },
			{ field: "handle", action: "create", type: "slug" },
		]);
		const mismatch = await applySchema(
			registry,
			{ collection: "other", template },
			invalidate,
		).catch((e: unknown) => e);
		expect(mismatch).toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
		const invalid = await applySchema(
			registry,
			{ template: { ...template, version: 2 } },
			invalidate,
		).catch((e: unknown) => e);
		expect(invalid).toMatchObject({
			code: "VALIDATION_ERROR",
			message: expect.stringMatching(/^The template is invalid: version/),
		});
	});

	it("refuses an unknown collection and invalid requests before planning", async () => {
		const registry = new FakeApplyRegistry();
		const missing = await applySchema(
			registry,
			{ collection: "nope", fields: [{ slug: "a", type: "json" }] },
			invalidate,
		).catch((e: unknown) => e);
		expect(missing).toBeInstanceOf(ServiceError);
		expect(missing).toMatchObject({ code: "COLLECTION_NOT_FOUND", status: 404 });
		const bad = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "specs", type: "json", indexed: true }] },
			invalidate,
		).catch((e: unknown) => e);
		expect(bad).toMatchObject({
			code: "VALIDATION_ERROR",
			status: 400,
			message: 'Field "specs": json fields cannot be indexed',
		});
		expect(registry.calls).toEqual([]);
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
		expect(labelOf("sku")).toBe("Sku");
		expect(labelOf("a__b_")).toBe("A b");
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
	"jobs/records",
	"jobs/log.csv",
];
const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;
```
with:
```ts
	"jobs/records",
	"jobs/log.csv",
	"schema/apply",
];
const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;
```

then replace
```ts
		);
		expect(create.safeParse({ ...base, sourceId: "a/b" }).success).toBe(false);
	});

```
with:
```ts
		);
		expect(create.safeParse({ ...base, sourceId: "a/b" }).success).toBe(false);
	});

	it("validates schema/apply input, refusing required, unique, defaults and validation", () => {
		const apply = plugin.routes["schema/apply"]!.input!;
		const field = { slug: "stage", type: "select", options: ["draft"], label: "Stage" };
		expect(apply.safeParse({ collection: "products", fields: [field] }).success).toBe(true);
		expect(apply.safeParse({ template: {}, addOptions: true, dryRun: true }).success).toBe(true);
		expect(apply.safeParse({ collection: "products" }).success).toBe(false);
		expect(apply.safeParse({ fields: [field], template: {} }).success).toBe(false);
		expect(apply.safeParse({ collection: "products", fields: [] }).success).toBe(false);
		expect(
			apply.safeParse({ collection: "products", fields: Array.from({ length: 101 }, () => field) })
				.success,
		).toBe(false);
		for (const extra of [
			{ required: true },
			{ unique: true },
			{ defaultValue: "draft" },
			{ validation: { options: ["x"] } },
		]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ ...field, ...extra }] }).success,
			).toBe(false);
		}
		for (const type of ["portableText", "image", "file", "reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
		}
		expect(apply.safeParse({ collection: "products", fields: [field], extra: 1 }).success).toBe(
			false,
		);
	});

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run schema-apply definition`
Expected: FAIL — `schema-apply.test.ts` cannot load `../../src/plugin/schema-apply.js`; in `definition.test.ts` 2 of 14 tests fail (the route list lacks `schema/apply`, and its input test cannot read the route).

- [ ] **Step 3: Plan and apply fields, and add the route**

Create `packages/flux-import/src/plugin/schema-apply.ts`:
```ts
import {
	invalidateCollectionCache,
	invalidateSchemaObjectCache,
	RESERVED_FIELD_SLUGS,
} from "emdash";
import { emdashErrorCode } from "../emdash/errors.js";
import {
	type FieldMapping,
	SOURCE_ID_FIELD,
	type Template,
	templateSchema,
} from "../engine/template.js";
import { ServiceError } from "./service.js";

/** The field types `schema/apply` creates: every type that holds a plain value. */
export const APPLY_FIELD_TYPES = [
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"json",
	"slug",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];

/** EmDash's indexable types (`emdash` src/schema/types.ts:56-66), of those above. */
const INDEXABLE: ReadonlySet<string> = new Set([
	"string",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"slug",
]);
const FIELD_SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_APPLY_FIELDS = 100;
const MAX_OPTIONS = 500;

export interface FieldRequest {
	slug: string;
	type: ApplyFieldType;
	label?: string | undefined;
	options?: string[] | undefined;
	indexed?: boolean | undefined;
	searchable?: boolean | undefined;
	translatable?: boolean | undefined;
}

export interface ApplyInput {
	collection?: string | undefined;
	fields?: FieldRequest[] | undefined;
	template?: unknown;
	addOptions?: boolean | undefined;
	dryRun?: boolean | undefined;
}

export type ApplyAction = "create" | "add_options" | "unchanged" | "conflict";

export interface FieldChange {
	field: string;
	action: ApplyAction;
	type: string;
	/** `create`: the options created with; `add_options`: the options added. */
	options?: string[];
	/** Why a field is a conflict. */
	message?: string;
}

export interface ApplyResult {
	collection: string;
	dryRun: boolean;
	changes: FieldChange[];
	/** The fields created or given options, in order. */
	applied: string[];
	/** The EmDash error that stopped the run, if one did. */
	error: { code: string; message: string } | null;
}

/** An existing field, as `getCollectionWithFields` returns it (`emdash` src/schema/types.ts:320). */
interface ExistingField {
	slug: string;
	type: string;
	validation?: { options?: string[] | undefined } | null | undefined;
	unsupportedType?: unknown;
}

/**
 * The part of EmDash's `SchemaRegistry` this route uses (`emdash` src/schema/registry.ts:1276,
 * :1417); `EmDashRuntime.schemaRegistry` is assignable to it. `updateField` replaces
 * `validation` as a whole.
 */
export interface ApplyRegistry {
	getCollectionWithFields(slug: string): Promise<{ fields: ExistingField[] } | null>;
	createField(
		collection: string,
		input: {
			slug: string;
			label: string;
			type: ApplyFieldType;
			indexed: boolean;
			searchable: boolean;
			translatable: boolean;
			validation?: { options: string[] };
		},
	): Promise<unknown>;
	updateField(
		collection: string,
		slug: string,
		input: { validation: Record<string, unknown> },
	): Promise<unknown>;
}

/**
 * Clears the caches EmDash's REST field handler clears after a field change (src/api/handlers/
 * schema.ts:102-106); `SchemaRegistry` does not. Its third call, the Zod schema cache, is not
 * exported and the write path does not read it (validateContentData builds the schema afresh,
 * src/api/handlers/validation.ts:149-190).
 */
export function invalidateFieldCaches(collection: string): void {
	invalidateCollectionCache(collection);
	invalidateSchemaObjectCache();
}

/** `unit_price` → `Unit price`. */
export function labelOf(slug: string): string {
	const words = slug.replace(/_+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The field a template mapping asks for (`date` with `output` is text, so `string`). */
function requestFor(field: string, mapping: FieldMapping): FieldRequest {
	switch (mapping.type) {
		case "text":
			return { slug: field, type: "string" };
		case "date":
			return { slug: field, type: mapping.output === undefined ? "datetime" : "string" };
		case "select":
		case "multiSelect": {
			const options = [...new Set(Object.values(mapping.map ?? {}))];
			return { slug: field, type: mapping.type, ...(options.length > 0 ? { options } : {}) };
		}
		default:
			return { slug: field, type: mapping.type };
	}
}

/** The fields a template maps, in template order. */
export function requestsFromTemplate(t: Template): FieldRequest[] {
	return Object.entries(t.fields).map(([field, mapping]) => requestFor(field, mapping));
}

/** Problems with the requested fields, each naming its field. */
export function requestProblems(requests: readonly FieldRequest[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const r of requests) {
		const name = `Field "${r.slug}"`;
		if (!FIELD_SLUG_RE.test(r.slug)) {
			problems.push(
				`${name}: slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters`,
			);
		} else if (RESERVED_FIELD_SLUGS.includes(r.slug) || r.slug === SOURCE_ID_FIELD) {
			problems.push(`${name}: the slug is reserved`);
		}
		if (seen.has(r.slug)) problems.push(`${name} is requested twice`);
		seen.add(r.slug);
		if (r.label !== undefined && (r.label.length < 1 || r.label.length > 200)) {
			problems.push(`${name}: labels are 1-200 characters`);
		}
		if (r.options !== undefined) {
			if (r.type !== "select" && r.type !== "multiSelect") {
				problems.push(`${name}: only select and multiSelect fields take options`);
			} else if (r.options.length < 1 || r.options.length > MAX_OPTIONS) {
				problems.push(`${name}: give 1-${MAX_OPTIONS} options`);
			} else if (r.options.some((o) => o.length < 1 || o.length > 200)) {
				problems.push(`${name}: options are 1-200 characters`);
			} else if (new Set(r.options).size !== r.options.length) {
				problems.push(`${name}: options must be distinct`);
			}
		}
		if (r.indexed && !INDEXABLE.has(r.type)) {
			problems.push(`${name}: ${r.type} fields cannot be indexed`);
		}
	}
	return problems;
}

/** The plan for one requested field, and for `add_options` the full option list to store. */
export function planField(
	request: FieldRequest,
	existing: ExistingField | undefined,
	addOptions: boolean,
): { change: FieldChange; options?: string[] } {
	const field = request.slug;
	const type = request.type;
	if (existing === undefined) {
		const options = request.options === undefined ? {} : { options: request.options };
		return { change: { field, action: "create", type, ...options } };
	}
	if (existing.unsupportedType !== undefined) {
		const message = `Field "${field}" has a field type this EmDash version cannot read`;
		return { change: { field, action: "conflict", type, message } };
	}
	if (existing.type !== type) {
		const message = `Field "${field}" is "${existing.type}"; requested "${type}"`;
		return { change: { field, action: "conflict", type, message } };
	}
	const current = existing.validation?.options ?? [];
	const missing = (request.options ?? []).filter((o) => !current.includes(o));
	// A field without options accepts any string, so nothing is missing.
	if (missing.length === 0 || current.length === 0) {
		return { change: { field, action: "unchanged", type } };
	}
	if (!addOptions) {
		const names = missing.map((o) => `"${o}"`).join(", ");
		const message = `Field "${field}" lacks the options ${names}; set addOptions to add them`;
		return { change: { field, action: "conflict", type, message } };
	}
	return {
		change: { field, action: "add_options", type, options: missing },
		options: [...current, ...missing],
	};
}

/**
 * `schema/apply`: plans the requested fields (or a template's) against the collection and, unless
 * `dryRun`, creates missing fields and adds missing select options, in request order. Additive
 * only: conflicts are reported and never applied. A field another request creates first is
 * re-planned; an EmDash error stops the run and is returned with what was applied so far, and a
 * rerun is safe because applied fields plan as `unchanged`.
 */
export async function applySchema(
	registry: ApplyRegistry,
	input: ApplyInput,
	invalidate: (collection: string) => void = invalidateFieldCaches,
): Promise<ApplyResult> {
	const { collection, requests } = resolveRequests(input);
	const problems = requestProblems(requests);
	if (problems.length > 0) throw new ServiceError("VALIDATION_ERROR", problems.join("; "), 400);
	const read = async () => {
		const found = await registry.getCollectionWithFields(collection);
		if (!found) {
			throw new ServiceError(
				"COLLECTION_NOT_FOUND",
				`Collection "${collection}" does not exist`,
				404,
			);
		}
		return new Map(found.fields.map((f) => [f.slug, f]));
	};
	const addOptions = input.addOptions ?? false;
	const dryRun = input.dryRun ?? false;
	let existing = await read();
	const plans = requests.map((r) => planField(r, existing.get(r.slug), addOptions));
	const result: ApplyResult = {
		collection,
		dryRun,
		changes: plans.map((p) => p.change),
		applied: [],
		error: null,
	};
	if (dryRun) return result;
	try {
		for (const [i, request] of requests.entries()) {
			let plan = plans[i] as (typeof plans)[number];
			if (plan.change.action === "create") {
				try {
					await registry.createField(collection, {
						slug: request.slug,
						label: request.label ?? labelOf(request.slug),
						type: request.type,
						indexed: request.indexed ?? false,
						searchable: request.searchable ?? false,
						translatable: request.translatable ?? true,
						...(request.options === undefined ? {} : { validation: { options: request.options } }),
					});
					result.applied.push(request.slug);
					continue;
				} catch (e) {
					if (emdashErrorCode(e) !== "FIELD_EXISTS") throw e;
					existing = await read();
					plan = planField(request, existing.get(request.slug), addOptions);
					result.changes[i] = plan.change;
				}
			}
			if (plan.change.action === "add_options" && plan.options !== undefined) {
				const field = existing.get(request.slug);
				await registry.updateField(collection, request.slug, {
					validation: { ...(field?.validation ?? {}), options: plan.options },
				});
				result.applied.push(request.slug);
			}
		}
	} catch (e) {
		const code = emdashErrorCode(e);
		if (code === undefined || e instanceof ServiceError) throw e;
		result.error = { code, message: e instanceof Error ? e.message : String(e) };
	} finally {
		if (result.applied.length > 0) invalidate(collection);
	}
	return result;
}

/** The collection and field requests: from `fields`, or from a template's mappings. */
function resolveRequests(input: ApplyInput): { collection: string; requests: FieldRequest[] } {
	if ((input.fields === undefined) === (input.template === undefined)) {
		throw new ServiceError("VALIDATION_ERROR", "Set exactly one of fields and template", 400);
	}
	if (input.fields !== undefined) {
		if (input.collection === undefined) {
			throw new ServiceError("VALIDATION_ERROR", "collection is required with fields", 400);
		}
		return { collection: input.collection, requests: input.fields };
	}
	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
		const problems = parsed.error.issues.map(
			(i) => `${i.path.join(".") || "template"}: ${i.message}`,
		);
		throw new ServiceError(
			"VALIDATION_ERROR",
			`The template is invalid: ${problems.join("; ")}`,
			400,
		);
	}
	const t = parsed.data;
	if (input.collection !== undefined && input.collection !== t.collection) {
		throw new ServiceError(
			"VALIDATION_ERROR",
			`collection "${input.collection}" does not match the template's "${t.collection}"`,
			400,
		);
	}
	return { collection: t.collection, requests: requestsFromTemplate(t) };
}
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import {
	changeJob,
```
with:
```ts
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import { APPLY_FIELD_TYPES, applySchema, MAX_APPLY_FIELDS } from "./schema-apply.js";
import {
	changeJob,
```

then replace
```ts
	});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
```
with:
```ts
	});

/** Slugs, label lengths, options and indexing are checked by `applySchema` (one message each). */
const applyField = z
	.object({
		slug: z.string(),
		type: z.enum(APPLY_FIELD_TYPES),
		label: z.string().optional(),
		options: z.array(z.string()).optional(),
		indexed: z.boolean().optional(),
		searchable: z.boolean().optional(),
		translatable: z.boolean().optional(),
	})
	.strict();

const applyInput = z
	.object({
		collection: z.string().min(1).max(63).optional(),
		fields: z.array(applyField).min(1).max(MAX_APPLY_FIELDS).optional(),
		template: z.unknown().optional(),
		addOptions: z.boolean().optional(),
		dryRun: z.boolean().optional(),
	})
	.strict()
	.refine((input) => (input.fields === undefined) !== (input.template === undefined), {
		message: "Set exactly one of fields and template",
	});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
```

then replace
```ts

	"jobs/log.csv": logCsv,
};
```
with:
```ts

	"jobs/log.csv": logCsv,

	// Additive only: creates missing fields and adds missing select options.
	"schema/apply": route(applyInput, (ctx) =>
		withServices(ctx, ({ runtime }) => applySchema(runtime.schemaRegistry, ctx.input)),
	),
};
```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// Declared for disclosure on the admin plugins page. The importer reads and writes content
		// and adds the flux_source_id field through the trusted runtime (withEmDashRuntime), not
		// through ctx.content, so these do not gate any call it makes. URL sources are fetched with
		// the runtime's own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through
		// ctx.http, so no network capability is declared.
```
with:
```ts
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// Declared for disclosure on the admin plugins page. The importer reads and writes content,
		// adds the flux_source_id field and creates fields for schema/apply through the trusted
		// runtime (withEmDashRuntime), not through ctx.content, so these do not gate any call it
		// makes; plugins have no schema-writing capability to declare. URL sources are fetched with
		// the runtime's own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through
		// ctx.http, so no network capability is declared.
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run schema-apply definition`
Expected: PASS (26 tests: 12 in `schema-apply.test.ts`, 14 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 39 files / 1,004 tests, or 39 / 999 without Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/schema-apply.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/tests/unit/schema-apply.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Add schema/apply, which creates missing fields and select options and never changes existing ones"
```

### Task 7: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/fixtures/field-types.ts`, `packages/flux-import/tests/integration/field-types.test.ts`
- Modify: `packages/flux-import/tests/integration/client.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through HTTP; the shared harness (`Client`, `inject("baseUrl")`, `inject("token")`); the settings API (V1); E3, E8, E9.
- Produces: `TYPES_COLUMNS`, `typesTemplate(collection, format)`, `TYPES_CSV`, `TYPES_CSV_STORED`, `TYPES_JSON` (`tests/fixtures/field-types.ts`); `Client.createCollection`, `Client.fields`, `Client.updateField` (`createProducts` now calls `createCollection`).

- [ ] **Step 1: Add the fixture and the client helpers**

Create `packages/flux-import/tests/fixtures/field-types.ts`:
```ts
/**
 * Sources and templates that map one field of every M4a type, for the Node and workerd
 * integration tests. The CSV gives every value as text; the JSON gives typed values (numbers,
 * booleans, arrays, objects). Both use the same column names, so one template serves both.
 */

export const TYPES_COLUMNS = [
	"sku",
	"Name",
	"Code",
	"Price",
	"Stock",
	"Featured",
	"Stage",
	"Colours",
	"Released",
	"SoldAt",
	"Launch",
	"Specs",
	"Handle",
] as const;

/** The template: `released` reads the site timezone, `launch_day` is a calendar date in text. */
export function typesTemplate(collection: string, format: "csv" | "json" = "csv") {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format },
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			code: { from: "Code", type: "text" },
			price: { from: "Price", type: "number", decimal: ",", thousands: "." },
			stock: { from: "Stock", type: "number" },
			featured: { from: "Featured", type: "boolean", true: ["ja"], false: ["nein"] },
			stage: {
				from: "Stage",
				type: "select",
				map: { Live: "live", Draft: "draft", Hidden: "hidden" },
			},
			colours: {
				from: "Colours",
				type: "multiSelect",
				separator: "|",
				map: { Rot: "red", Grün: "green", Blau: "blue" },
			},
			released: { from: "Released", type: "date", format: "dd.MM.yyyy HH:mm", tz: "site" },
			sold_on: { from: "SoldAt", type: "date", format: "unix" },
			launch_day: { from: "Launch", type: "date", tz: "Europe/Chisinau", output: "yyyy-MM-dd" },
			specs: { from: "Specs", type: "json" },
			legacy: { from: "Handle", type: "slug" },
		},
	};
}

/** Three rows that fit the fields' rules once the site timezone is Europe/Chisinau. */
export const TYPES_CSV = [
	TYPES_COLUMNS.join(","),
	'C1,Desk,ABC-1,"1.234,50",12,ja,Live,red|Blau,24.01.2025 14:00,1737720000,2025-01-24T23:30:00Z,"{""w"": 120, ""tags"": [""oak""]}",Old Desk',
	'C2,Chair,ABC-2,"99,5",3,NEIN,draft,Grün,01.07.2025 09:30,1751362200.5,2025-07-01T10:00:00Z,"[1,2]",chair',
	"C3,Lamp,ABC-3,0,0,Ja,HIDDEN,,29.03.2026 02:30,1774742400,2026-03-29T00:30:00Z,,Lamp №3",
	"",
].join("\n");

/** What `TYPES_CSV` reads back as through EmDash's content API, by source key. */
export const TYPES_CSV_STORED = {
	C1: {
		title: "Desk",
		code: "ABC-1",
		price: 1234.5,
		stock: 12,
		featured: 1,
		stage: "live",
		colours: ["red", "blue"],
		released: "2025-01-24T12:00:00.000Z",
		sold_on: "2025-01-24T12:00:00.000Z",
		launch_day: "2025-01-25",
		specs: { w: 120, tags: ["oak"] },
		legacy: "old-desk",
	},
	C2: {
		title: "Chair",
		price: 99.5,
		stock: 3,
		featured: 0,
		stage: "draft",
		colours: ["green"],
		released: "2025-07-01T06:30:00.000Z",
		sold_on: "2025-07-01T09:30:00.500Z",
		launch_day: "2025-07-01",
		specs: [1, 2],
		legacy: "chair",
	},
	C3: {
		title: "Lamp",
		price: 0,
		stock: 0,
		featured: 1,
		stage: "hidden",
		released: "2026-03-29T00:30:00.000Z",
		launch_day: "2026-03-29",
		legacy: "lamp-no3",
	},
};

/** Typed JSON records with the same columns. */
export const TYPES_JSON = JSON.stringify([
	{
		sku: "J1",
		Name: "Shelf",
		Code: "XYZ-9",
		Price: 1500.25,
		Stock: 7,
		Featured: true,
		Stage: "Live",
		Colours: ["Grün", "red", "green"],
		Released: "05.05.2025 08:00",
		SoldAt: 1746432000,
		Launch: "2025-05-05T08:00:00Z",
		Specs: { d: { x: 1 }, tags: ["oak", "ash"] },
		Handle: "Shelf Big",
	},
	{
		sku: "J2",
		Name: "Stool",
		Code: "XYZ-10",
		Price: 20,
		Stock: 1,
		Featured: false,
		Stage: "draft",
		Colours: [],
		Released: "06.05.2025 08:00",
		SoldAt: "1746432000",
		Launch: "2025-05-06T08:00:00Z",
		Specs: '{"note":"parsed"}',
		Handle: "stool",
	},
]);
```

In `packages/flux-import/tests/integration/client.ts`, replace
```ts
	/** Creates a revisioned collection with edit locking and the fields the template maps. */
	async createProducts(slug: string): Promise<void> {
		await this.api("POST", "/_emdash/api/schema/collections", {
			slug,
			label: slug,
			supports: ["drafts", "revisions"],
			editLocking: true,
		});
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
```
with:
```ts
	/** Creates a revisioned collection with edit locking and the fields the template maps. */
	async createProducts(slug: string): Promise<void> {
		await this.createCollection(slug);
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
```

then replace
```ts
	}

	async fieldSlugs(collection: string): Promise<string[]> {
		const data = await this.api<{ item: { fields: { slug: string }[] } }>(
			"GET",
			`/_emdash/api/schema/collections/${collection}?includeFields=true`,
		);
		return data.item.fields.map((f) => f.slug);
	}

```
with:
```ts
	}

	/** Creates a revisioned collection with edit locking and no fields. */
	async createCollection(slug: string): Promise<void> {
		await this.api("POST", "/_emdash/api/schema/collections", {
			slug,
			label: slug,
			supports: ["drafts", "revisions"],
			editLocking: true,
		});
	}

	async fields(
		collection: string,
	): Promise<{ slug: string; type: string; required: boolean; validation?: unknown }[]> {
		const data = await this.api<{
			item: { fields: { slug: string; type: string; required: boolean; validation?: unknown }[] };
		}>("GET", `/_emdash/api/schema/collections/${collection}?includeFields=true`);
		return data.item.fields;
	}

	async fieldSlugs(collection: string): Promise<string[]> {
		return (await this.fields(collection)).map((f) => f.slug);
	}

	/** Changes a field through the admin API (`PUT …/fields/:field`; `validation` is required). */
	async updateField(
		collection: string,
		field: string,
		body: { required?: boolean; validation: Record<string, unknown> | null },
	): Promise<void> {
		await this.api("PUT", `/_emdash/api/schema/collections/${collection}/fields/${field}`, body);
	}

```

Create `packages/flux-import/tests/integration/field-types.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { RecordRow } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import { TYPES_CSV, TYPES_CSV_STORED, TYPES_JSON, typesTemplate } from "../fixtures/field-types.js";
import { Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));
const COLLECTION = "it_types";

async function importText(body: string, filename: string, template: object, dryRun = false) {
	const { uploadId } = await client.upload(body, filename);
	const job = await client.plugin("jobs/create", { uploadId, template, dryRun, batchSize: 10 });
	return client.runToEnd(job.id);
}

const byKey = async () =>
	new Map((await client.listAll(COLLECTION)).map((e) => [e.data.flux_source_id as string, e.data]));

describe("M4a field types end to end", () => {
	let timezone: string | undefined;

	beforeAll(async () => {
		const settings = await client.api<{ timezone?: string }>("GET", "/_emdash/api/settings");
		timezone = settings.timezone;
		await client.api("POST", "/_emdash/api/settings", { timezone: "Europe/Chisinau" });
	});

	afterAll(async () => {
		await client.api("POST", "/_emdash/api/settings", { timezone: timezone ?? "UTC" });
	});

	it("creates the fields from a template with schema/apply, leaving a conflicting field alone", async () => {
		await client.createCollection(COLLECTION);
		// schema/apply never creates a required field, and EmDash refuses to make an existing field
		// required without a content migration: an editor creates this one in the admin.
		await client.api("POST", `/_emdash/api/schema/collections/${COLLECTION}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			validation: { maxLength: 40 },
		});
		const integer = await client.plugin<ApplyResult>("schema/apply", {
			collection: COLLECTION,
			fields: [{ slug: "stock", type: "integer" }],
		});
		expect(integer.changes).toEqual([{ field: "stock", action: "create", type: "integer" }]);

		const template = typesTemplate(COLLECTION);
		const dry = await client.plugin<ApplyResult>("schema/apply", { template, dryRun: true });
		expect(dry.applied).toEqual([]);
		expect(await client.fieldSlugs(COLLECTION)).toEqual(["title", "stock"]);

		const applied = await client.plugin<ApplyResult>("schema/apply", { template });
		expect(applied.changes).toEqual([
			{ field: "title", action: "unchanged", type: "string" },
			{ field: "code", action: "create", type: "string" },
			{ field: "price", action: "create", type: "number" },
			{
				field: "stock",
				action: "conflict",
				type: "number",
				message: 'Field "stock" is "integer"; requested "number"',
			},
			{ field: "featured", action: "create", type: "boolean" },
			{ field: "stage", action: "create", type: "select", options: ["live", "draft", "hidden"] },
			{
				field: "colours",
				action: "create",
				type: "multiSelect",
				options: ["red", "green", "blue"],
			},
			{ field: "released", action: "create", type: "datetime" },
			{ field: "sold_on", action: "create", type: "datetime" },
			{ field: "launch_day", action: "create", type: "string" },
			{ field: "specs", action: "create", type: "json" },
			{ field: "legacy", action: "create", type: "slug" },
		]);
		expect(applied.applied).toHaveLength(10);
		expect(applied.error).toBeNull();
		const fields = await client.fields(COLLECTION);
		expect(fields.find((f) => f.slug === "stock")?.type).toBe("integer");
		expect(fields.find((f) => f.slug === "stage")?.validation).toEqual({
			options: ["live", "draft", "hidden"],
		});

		// Rules schema/apply never sets, set through the admin API as an editor would.
		await client.updateField(COLLECTION, "code", { validation: { pattern: "^[A-Z]{3}-\\d+$" } });
		await client.updateField(COLLECTION, "price", { validation: { min: 0, max: 100000 } });

		const again = await client.plugin<ApplyResult>("schema/apply", { template });
		expect(again.applied).toEqual([]);
		expect(again.changes.filter((c) => c.action !== "unchanged").map((c) => c.field)).toEqual([
			"stock",
		]);
	});

	it("imports CSV text into every type, reads it back exactly, and re-runs as unchanged", async () => {
		const template = typesTemplate(COLLECTION);
		const done = await importText(TYPES_CSV, "types.csv", template);
		expect(done).toMatchObject({
			status: "completed",
			siteTimezone: "Europe/Chisinau",
			counters: { created: 3, failed: 0 },
			targetFields: {
				title: { type: "string", required: true, maxLength: 40 },
				stock: { type: "integer", required: false },
				price: { type: "number", required: false, min: 0, max: 100000 },
				stage: { type: "select", required: false, options: ["live", "draft", "hidden"] },
			},
		});
		const stored = await byKey();
		for (const [key, expected] of Object.entries(TYPES_CSV_STORED)) {
			expect(stored.get(key), key).toMatchObject(expected);
		}
		const rerun = await importText(TYPES_CSV, "types.csv", template);
		expect(rerun.counters).toMatchObject({ created: 0, updated: 0, unchanged: 3, failed: 0 });
	});

	it("imports typed JSON values, and re-runs as unchanged", async () => {
		const template = typesTemplate(COLLECTION, "json");
		const done = await importText(TYPES_JSON, "types.json", template);
		expect(done.counters).toMatchObject({ created: 2, failed: 0 });
		const stored = await byKey();
		expect(stored.get("J1")).toMatchObject({
			price: 1500.25,
			stock: 7,
			featured: 1,
			stage: "live",
			colours: ["green", "red"],
			released: "2025-05-05T05:00:00.000Z",
			sold_on: "2025-05-05T08:00:00.000Z",
			launch_day: "2025-05-05",
			specs: { d: { x: 1 }, tags: ["oak", "ash"] },
			legacy: "shelf-big",
		});
		expect(stored.get("J2")).toMatchObject({ featured: 0, specs: { note: "parsed" } });
		expect(stored.get("J2")?.colours ?? null).toBeNull();
		const rerun = await importText(TYPES_JSON, "types.json", template);
		expect(rerun.counters).toMatchObject({ unchanged: 2, updated: 0, failed: 0 });
	});

	it("reports invalid_option, invalid_integer, required and a DST gap in a dry run without writing", async () => {
		const before = (await client.listAll(COLLECTION)).length;
		const csv = [
			"sku,Name,Code,Price,Stock,Featured,Stage,Colours,Released,SoldAt,Launch,Specs,Handle",
			"D1,Desk,ABC-1,1,1,ja,Archived,red,01.01.2025 10:00,0,2025-01-01,,d1",
			"D2,Desk,ABC-1,1,2.5,ja,live,red|pink,01.01.2025 10:00,0,2025-01-01,,d2",
			"D3,,ABC-1,1,1,ja,live,,29.03.2026 03:30,0,2025-01-01,,d3",
			"D4,Desk,abc,-1,1,vielleicht,live,,01.01.2025 10:00,0,2025-01-01,{,d4",
			"",
		].join("\n");
		const done = await importText(csv, "bad.csv", typesTemplate(COLLECTION), true);
		expect(done.counters).toMatchObject({ failed: 4, created: 0 });
		const rows = await client.records(done.id, "failed");
		const codes = (row: RecordRow | undefined) => row?.errors?.map((e) => [e.field, e.code]);
		expect(rows.map(codes)).toEqual([
			[["stage", "invalid_option"]],
			[
				["stock", "invalid_integer"],
				["colours", "invalid_option"],
			],
			[
				["title", "required"],
				["released", "invalid_date"],
			],
			[
				["code", "pattern_mismatch"],
				["price", "out_of_range"],
				["featured", "invalid_boolean"],
				["specs", "invalid_json"],
			],
		]);
		expect((await client.listAll(COLLECTION)).length).toBe(before);
	});

	it("adds a select option with schema/apply and then imports a value that uses it", async () => {
		const request = {
			collection: COLLECTION,
			fields: [{ slug: "stage", type: "select", options: ["archived"] }],
		};
		const refused = await client.plugin<ApplyResult>("schema/apply", request);
		expect(refused.changes).toEqual([
			{
				field: "stage",
				action: "conflict",
				type: "select",
				message: 'Field "stage" lacks the options "archived"; set addOptions to add them',
			},
		]);
		const added = await client.plugin<ApplyResult>("schema/apply", {
			...request,
			addOptions: true,
		});
		expect(added).toMatchObject({
			changes: [{ field: "stage", action: "add_options", options: ["archived"] }],
			applied: ["stage"],
		});
		const csv = [
			"sku,Name,Code,Price,Stock,Featured,Stage,Colours,Released,SoldAt,Launch,Specs,Handle",
			"A1,Archive box,ABC-7,5,1,nein,ARCHIVED,,01.01.2025 10:00,0,2025-01-01,,a1",
			"",
		].join("\n");
		const done = await importText(csv, "archived.csv", typesTemplate(COLLECTION));
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		expect((await byKey()).get("A1")).toMatchObject({
			stage: "archived",
			released: "2025-01-01T08:00:00.000Z",
		});
	});
});
```

- [ ] **Step 2: Run the new file on the shared dev server**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts field-types`
Expected: PASS (5 tests; about 8 s including the server start). The first test is also the check of Fact V2 in use: fields created by `schema/apply` are written by the imports that follow, through the same runtime.

- [ ] **Step 3: Run the whole Node suite**

Run: `pnpm test:integration`
Expected: 10 files / 53 tests pass in about 550 s (9 / 48 before) (Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles).

- [ ] **Step 4: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/fixtures/field-types.ts packages/flux-import/tests/integration/client.ts packages/flux-import/tests/integration/field-types.test.ts
git commit -m "Prove every M4a field type and schema/apply end to end on the Node dev site"
```

### Task 8: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through HTTP; Task 7's fixture (`typesTemplate`, `TYPES_CSV`, `TYPES_CSV_STORED`); the parity harness (`client`, `byKey`); V1 on workerd; E4 on D1.
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
import { describe, expect, inject, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
```
with:
```ts
import { describe, expect, inject, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { TYPES_CSV, TYPES_CSV_STORED, typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
```

then replace
```ts
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
```
with:
```ts
	});

	it("creates fields with schema/apply and imports every M4a type on D1, in the site timezone", async () => {
		const settings = await client.api<{ timezone?: string }>("GET", "/_emdash/api/settings");
		await client.api("POST", "/_emdash/api/settings", { timezone: "Europe/Chisinau" });
		try {
			await client.api("POST", "/_emdash/api/schema/collections", {
				slug: "cf_types",
				label: "cf_types",
				supports: ["drafts", "revisions"],
			});
			await client.api("POST", "/_emdash/api/schema/collections/cf_types/fields", {
				slug: "stock",
				label: "Stock",
				type: "integer",
				validation: null,
			});
			const template = typesTemplate("cf_types");
			const applied = await client.plugin<ApplyResult>("schema/apply", { template });
			expect(applied).toMatchObject({ applied: expect.any(Array), error: null });
			expect(applied.changes.filter((c) => c.action !== "create")).toEqual([
				{
					field: "stock",
					action: "conflict",
					type: "number",
					message: 'Field "stock" is "integer"; requested "number"',
				},
			]);
			const { uploadId } = await client.upload(TYPES_CSV, "types.csv");
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			expect(job.siteTimezone).toBe("Europe/Chisinau");
			const done = await client.runToEnd(job.id);
			expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
			const stored = await byKey("cf_types");
			for (const [key, expected] of Object.entries(TYPES_CSV_STORED)) {
				expect(stored.get(key)?.data, key).toMatchObject(expected);
			}
			const { uploadId: again } = await client.upload(TYPES_CSV, "types.csv");
			const rerun = await client.plugin("jobs/create", {
				uploadId: again,
				template,
				dryRun: false,
			});
			expect((await client.runToEnd(rerun.id)).counters).toMatchObject({ unchanged: 3 });
		} finally {
			await client.api("POST", "/_emdash/api/settings", { timezone: settings.timezone ?? "UTC" });
		}
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
```

- [ ] **Step 2: Run the new test on workerd**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M4a type"`
Expected: PASS (1 test, about 12 s plus 30 s of server start; the other seven are skipped). This proves on workerd and D1 that `schema/apply` creates the fields through the runtime's registry, that `getSiteSetting("timezone")` works in a plugin route there (V1), and that booleans, selects, multi-selects, JSON and the site-timezone date read back and re-run as unchanged. The full `pnpm test:cf` runs in Task 9.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove schema/apply and an M4a field type import on workerd"
```

### Task 9: M4a review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-m4a-review.md`

**Interfaces:**
- Consumes: everything above, and the Task 0 results.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 25 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass`, record each result:
1. Create a collection `m4a_items` with a required `title` (string) through the admin API. `schema/apply { template: typesTemplate("m4a_items"), dryRun: true }` lists a `create` for every other field and `applied: []`; the same without `dryRun` creates them; a third call answers `unchanged` for every field.
2. `schema/apply { collection: "m4a_items", fields: [{ "slug": "status", "type": "select" }] }` → 400 `VALIDATION_ERROR` ("the slug is reserved"); `fields: [{ "slug": "stage", "type": "json" }]` → a `conflict` naming both types, and the field is unchanged in the admin.
3. Set the site timezone in the admin (Settings → General) to Europe/Chisinau, upload `TYPES_CSV` from `tests/fixtures/field-types.ts` (written to a file), and run `jobs/create` with `typesTemplate("m4a_items")`: the job shows `siteTimezone: "Europe/Chisinau"` and `targetFields`; after `jobs/next` the three entries show the values of `TYPES_CSV_STORED` in the admin editor (the boolean as a checked box, the multi-select as chips, the JSON as an object).
4. Run the same import as a dry run with a row whose `Stage` is `Gone` and whose `Stock` is `2.5`: `jobs/records` shows `invalid_option` (listing the options) and `invalid_integer`, and `jobs/log.csv` carries both codes.
5. Run it again for real with the original file: `unchanged: 3`. Restore the site timezone, `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-27-m4a-review.md` from this template and fill in every `…`:
````markdown
# Milestone 4a review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0)

| Fact | Check | Result |
| --- | --- | --- |
| V1: `getSiteSetting("timezone")` in a plugin route | probe route; settings API | … |
| V2: cache invalidation reaches the site's caches | one `emdash` copy; `schema` epoch present; field created and written | … |

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
| Conversion: booleans (tokens, case, 1/0, overlap refused); numbers (grouping, NBSP, decimal equal to thousands refused, integer targets); selects (map, ignoreCase, ambiguous options, free selects); multi-selects (arrays, text, separators, empty items, duplicates, 1,001 items, nested objects); dates (ISO with and without offset, formats, unix and unixMs, IANA and site zones, DST gap and overlap in Europe/Chisinau and America/New_York, output into text); JSON (objects, parsed text, `parse: false` with `{`, 1 MiB); slugs | `values.test.ts`, `dates.test.ts`, `template.test.ts` | … |
| Field rules: required, out_of_range, too_short, too_long, pattern_mismatch, a bad pattern ignored, all errors collected, jobs without targetFields as M2 | `values.test.ts`, `template.test.ts`, `batch.test.ts` | … |
| Schema checks: compatibility both ways, output into datetime, map values not in options, unmapped required with and without default, storage-less and unsupported fields, invalid site timezone | `template.test.ts`, `schema.test.ts`, `jobs.test.ts` | … |
| Diff: booleans against 0/1, multiSelect order, json key order, datetimes, canonical JSON-looking text | `diff.test.ts` | … |
| `schema/apply`: every plan row, from a template, addOptions merge order, reserved and duplicate slugs, indexed json refused, dry run, FIELD_EXISTS race, stop on SchemaError, cache invalidation | `schema-apply.test.ts`, `definition.test.ts` | … |
| Integration on `sites/dev`: fields from a template, CSV and JSON imports of every type read back, dry-run errors without writes, re-run unchanged, `tz: "site"`, addOptions then an import using the option, a conflicting type left unchanged | `field-types.test.ts` | … |
| workerd: `schema/apply` and one import with boolean, select, multiSelect, json and a site-timezone date on D1 | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | `schema/apply` dry run, apply, rerun | … | … |
| 2 | Reserved slug refused, conflicting type left alone | … | … |
| 3 | Site-timezone import, values in the admin editor | … | … |
| 4 | Dry-run errors in records and log CSV | … | … |
| 5 | Re-run unchanged | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-27-m4a-review.md
git commit -m "Add the Milestone 4a review results"
```

---

## After this plan

M4a is the first part of Milestone 4. Known gaps carried forward: a top-level boolean in a `json` field reads back as 1 or 0 (Fact E4); text that EmDash reads back as JSON still plans an update unless it is canonical JSON; `schema/apply` cannot create required, unique or defaulted fields or change validation other than adding options, and EmDash refuses to make an existing field required (Fact E3); URL-field safety stays with EmDash (`emdash_validation_error`); a `json` value of up to 1 MiB is also stored in the job's record row as a planned change. M4b (taxonomies, references, bylines), M4c (media) and M4d (Portable Text) build on `fieldConverter`, the snapshot and `schema/apply`. The M2-M3d open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-10-27-m3d-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands.
