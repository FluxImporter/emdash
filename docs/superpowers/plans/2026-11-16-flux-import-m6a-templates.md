# Flux Import M6a: saved templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below), and Task 0 changes no file. Tasks 1 and 2 can run in parallel worktrees, then Tasks 3 and 5, and at the end Tasks 7 and 8. The rest follow in order (see "Parallel execution").

**Goal:** Give templates a life of their own: named, revisioned templates in plugin storage with CRUD routes, validation that refuses what can never run and reports what does not fit the site, a versioned JSON export and import with an owner check, and jobs, job listings and `schema/apply` by `templateId`, with each job keeping a snapshot. The URL-source "unchanged" skip becomes template-aware.

**Architecture:** by task:
- **Task 1.** Storage: `STORAGE.templates`, the jobs index `["templateId", "createdAt"]`, `KvCollection.compareAndDelete`, `Job.templateId` and `Job.templateRevision`, `FLUX_IMPORT_VERSION` 0.3.0. The unit fake `MemoryKv` gains `compareAndDelete`, EmDash's keyset cursor and an optional index check.
- **Task 2.** `src/engine/shape.ts` (new) holds `templateShapeProblems` (the eight steps; steps 3-6 leave `checkTemplate`). `createJob` and `schema/apply` run it first. `src/plugin/templates.ts` (new) starts with the template-route checks (version, shape, size), the name rule and `readSavedTemplate`.
- **Task 3.** `src/plugin/templates.ts` gains the service: list, get, create, update and delete with revisions, the site checks and the owner warnings.
- **Task 4.** `src/plugin/template-files.ts` (new): export and import, with the owner refusal and override.
- **Task 5.** Jobs by template: `src/plugin/job-templates.ts` (new) resolves a `templateId` and the URL-source template reference; `createJob`, `createRollback` and `listJobs` carry or filter `templateId`; `jobFromSource` compares the template.
- **Task 6.** `src/plugin/routes.ts`: the seven template routes, and `jobs/create`, `jobs/list` and `schema/apply` by `templateId`.
- **Tasks 7 and 8.** These prove it on Node (`sites/dev`) and workerd (`sites/dev-cf`).
- **Task 9.** The review run, the route budgets of V5 measured on D1, and the note.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` 4.5.4 in the engine, `astro/zod` in routes), Biome 2, EmDash 1.2.0, Astro 7.3. Workerd parity runs through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-16-flux-import-m6a-templates-design.md`, all sections, Rulings 1-47 binding (where a ruling says "Amended by", the amendment). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 6 split). Previous plan: `docs/superpowers/plans/2026-11-12-flux-import-m5c-missing-entries.md`. Its review: `docs/superpowers/notes/2026-11-12-m5c-review.md`.

How this plan was checked while drafting (results in "Verification while drafting"):
- Task 0's facts were proven on Node and workerd with a temporary probe route and probe test, removed afterwards; V3 ran over every template the unit suite parses.
- The code in Tasks 1-8 was written against the code at `198a6c6` and the EmDash 1.2.0 source. Every name, signature and fake it uses was checked against those files. It was not applied and run while drafting, except `paddedTemplate` (Task 2), whose algorithm was run against `templateSchema` at the sizes the tests use. Each task's "see them fail" and "see them pass" steps are the first run.

Citation conventions: EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's facts are cited as "spec F<n>" and "spec P<n>", its rulings as "spec Ruling <n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID is `flux-import`. The package exports stay `fluxImport()`, `fluxImportRoutes()` and `createPlugin()`.
- `FLUX_IMPORT_VERSION` becomes `0.3.0`; `package.json` stays `0.1.0` until M8.
- New storage: collection `templates` with indexes `["name", "collection", "owner"]`; `jobs` gains `["templateId", "createdAt"]`. No `uniqueIndexes` (spec Ruling 5).
- New routes, all `POST`, JSON in and out, `permission: "import:execute"`, not raw: `templates/list`, `templates/get`, `templates/create`, `templates/update`, `templates/delete`, `templates/export`, `templates/import`.
- Changed routes: `jobs/create` (`templateId`, `templateRevision`; exactly one of `template` and `templateId`), `jobs/list` (`templateId`), `schema/apply` (`templateId`; exactly one of `fields`, `template` and `templateId`).
- No new capability (spec Ruling 14). The capability list stays exactly as at `198a6c6`.
- Templates stay `version: 1`; the file envelope is `formatVersion: 1`, `format: "flux-import.template"`.
- No new dependencies; no task touches `package.json` or `pnpm-lock.yaml`.

**Bounds, exactly**
- `TEMPLATE_MAX_BYTES` = 262,144 (256 KiB), the UTF-8 length of `JSON.stringify` of the parsed template, on the template routes only (create, update, import; spec Ruling 28).
- Names: NFC first; 1-100 characters (UTF-16 code units, as Zod's `max` and source names count, plan Ruling 3); no leading or trailing whitespace (`/^\s|\s$/u`); no `/[\p{Cc}\p{Cf}]/u`. Descriptions: at most 2,000 characters.
- `TEMPLATE_PAGE` = 8 summaries per `templates/list` page, no `orderBy`. Owner query: `{ owner, collection }`, limit 100. Links query: limit 1. Name query: limit 2.
- Inline `jobs/create` keeps M5c's codes, messages and limits: no size cap, version 2 is `invalid_template` "The template is invalid".

**Codes and messages, exactly** (route errors are `ServiceError(code, message, status, details)`)
- `INVALID_TEMPLATE` 400 "The template is invalid", `details: { problems }`.
- `UNSUPPORTED_TEMPLATE_VERSION` 400 "This template has format version <n>; this version of flux-import reads version 1".
- `TEMPLATE_TOO_LARGE` 413 "The template is <bytes> bytes of JSON; at most 262144 are allowed".
- `INVALID_FILE` 400, one of: "The file is not a flux-import template file"; `The file's format is not "flux-import.template"`; "formatVersion must be the integer 1"; "The file has no template"; "The file has no name; give one with name"; "The file's name is not a valid template name (<TEMPLATE_NAME_RULE>); give one with name"; "The file's description must be text of at most 2,000 characters".
- `UNSUPPORTED_FILE_VERSION` 400 "This file was written by a newer flux-import (file format <n>, generator <version>); this site reads file format 1" (`<version>` is `generator.version` when it is a string, else `unknown`).
- `NOT_FOUND` 404 "Template <id> not found" (template routes); `TEMPLATE_NOT_FOUND` 404, same message (`jobs/create`, `schema/apply`).
- `NAME_TAKEN` 409 `A template named "<name>" already exists`, `details: { id }`.
- `OWNER_IN_USE` 409, `details: { owner, templates, links }` (Task 4 gives the message).
- `TEMPLATE_CHANGED` 409 "Template <id> is at revision <current>, not <given>; read it again" (`details: { revision }`), or "Template <id> changed while it was being saved; read it again" (`details: { revision }` when the row still exists).
- `TEMPLATE_NAME_RULE` = "A template name is 1-100 characters, with no leading or trailing whitespace and no control or format characters".
- The owner warnings and the shape problems are given word for word in Tasks 2 and 3.

**Environment**
- Node `>=22.16`. In agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only: never `cat >`, `cat >>` or heredocs through `cat`.
- Scratch files go in `.superpowers/wt/` (excluded from git), never `/tmp`, which WSL wipes on restart.

**Code rules**
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- The engine (`src/engine/`) never imports `emdash`.
- Use EmDash APIs only as documented or as read in `node_modules/emdash`, cited by file and line.
- No raw SQL and no content query in plugin code (spec "Security"). Plugin storage is queried only on declared index fields, at most 100 rows a page.
- Route input is validated with `astro/zod` without transforms (an MCP tool's input must stay representable as JSON Schema, M6c); names are NFC-normalised in the service.
- `createdBy` and `updatedBy` come from the route's caller (`actor.id`), never from the body.
- The test sites' `src/pages/test/run-scheduled.ts` keeps answering 403 unless `import.meta.env.DEV`.

**Running tests**
- Vitest runs from `packages/flux-import` with file paths, for example `pnpm exec vitest run tests/unit/shape.test.ts`.
- Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/templates.test.ts`.
- Workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M6a"`.
- Ports: the new Node integration file starts its own server on 4391 (the M5a-M5c suites' port; the suites run one at a time). The shared server uses 4399, the workerd harness 4396, the other suites 4392-4395, 4397 and 4398. Never run two copies of the same harness at once.

**Repository hygiene**
- Never commit `sites/dev/.env`, tokens, or the changes the dev server writes to `sites/dev/emdash-env.d.ts` and `sites/dev-cf/emdash-env.d.ts`. The shared integration setup restores the first; restore both by hand after any other server run.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails with "1Password: failed to fill whole buffer", retry once; otherwise stop and report. Never pass `--no-gpg-sign`.
- Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.

**Definition of done**
- `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root after every task.
- Task 7 also passes its integration file and `pnpm test:integration`; Task 8 the targeted workerd tests; Task 9 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. **A template body of any shape is refused without crashing.** The `__proto__` walk (shape step 2) reads raw route input, which can nest arrays or objects tens of thousands of levels deep inside 1 MiB. A recursive walk throws `RangeError` and the route answers 500. Expected: `INVALID_TEMPLATE` with the schema's problems. Evidence: Task 2 ("does not overflow the stack on a deeply nested input").
2. **The size cap counts UTF-8 bytes, not string length.** A template written in Cyrillic or with accented names is up to twice as large in bytes; one under 256 Ki characters but over 256 KiB must be refused, or its job row can pass the 1 MiB conditional-write cap (spec F3). Evidence: Task 2 ("counts UTF-8 bytes").
3. **The inline fingerprint ignores key order.** Clients serialise the same template with keys in different orders; the unchanged-content skip must treat them as the same template, else every scheduled run of an unchanged feed creates a job. Evidence: Task 5 (`jobTemplateRef` with reordered keys).
4. **A stored row that no longer parses stays readable and is refused at use, not with a 500.** After a downgrade, or a row written by a newer version, `templates/list`, `get` and `export` still work; `jobs/create { templateId }` refuses `INVALID_TEMPLATE` with the key's path. Evidence: Task 4 (export of such a row), Task 5 (`createJob` from it).
5. **An import file with an unusable name is refused cleanly and rescued by `name`.** Hand-edited files carry names with trailing spaces or tabs. Expected: `INVALID_FILE` naming the rule; the same file with a `name` override imports. Evidence: Task 4.

---

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0, Zod 4.5.4 and local workerd; tasks cite them by number. V1-V5 are the facts the spec left unconfirmed.

How V1, V2, V4 and V5 were proven:
- A temporary plugin route `probe/m6a` (body limit raised to 8 MiB) used the plugin's storage collections directly (`ctx.storage.templates`, `.jobs`, `.links`), the runtime's schema registry (`listSchemaFields`), `EmDashLookups.taxonomyDefs()`, and `sqlite_master` through Kysely's `sql` with a bound pattern. On workerd each call was wrapped in the M5a D1 counter (`countD1`, `docs/superpowers/plans/2026-11-03-flux-import-m5a-journal-rollback.md`, Task 9 Step 2), and the bytes of every returned document were summed.
- A temporary probe test drove it on `sites/dev` (port 4420, its own SQLite file under `.superpowers/wt/scratch-m6a-plan/`) and on `sites/dev-cf` (port 4421, fresh local D1), in two server starts per site: the first with `definition.ts` as at `198a6c6`, after a real M5c import job (3 rows, `rules.owner`); the second with `STORAGE.templates` and the jobs index added.
- Every probe file was removed afterwards, `routes.ts` and `definition.ts` were reverted, `sites/dev/data.db*` matched their backup checksums, `sites/dev-cf/.wrangler` was restored from its backup, and both `emdash-env.d.ts` files were restored (the dev-cf one regenerated from the restored state). The Node and workerd results agreed.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds; `TEMPLATE_MAX_BYTES` stays 256 KiB.** On both runtimes, a valid template of exactly 262,144 bytes of JSON (136 text fields; `templateSchema` 3-4 ms, `compileTemplate` 12-16 ms) was `put`, read back (`get`), replaced by `compareAndSet` with its revision, and created by `compareAndSet(id, null)`; a job row holding it (272,329 bytes) was created and updated by `compareAndSet`. Each storage call was 1 D1 query. The same held at 524,288 and 900,000 bytes. At 1,040,000 bytes the template row still worked, and the job row (1,067,430 bytes) was refused before any query with `TypeError: Conditional storage value must not exceed 1 MiB of JSON` (emdash `src/plugins/conditional-storage.ts:21-30`). So local D1 does not count bound values against its 100 KB statement limit (spec F6), and the binding limit is the conditional-write cap, as spec Ruling 39 says. Production D1 is unverified, as for every parity result | Probe, both runtimes; Tasks 2, 8 |
| V2 | **Holds.** Before the upgrade, `jobs.query({ where: { templateId } })` was refused: `StorageQueryError: Cannot query on non-indexed field 'templateId'.`, and `ctx.storage.templates` was absent. After the restart with the new declarations, `templates.query({ where: { name } })`, `templates.query({ where: { owner, collection }, limit: 100 })`, `jobs.query({ where: { templateId }, orderBy: { createdAt: "desc" } })` and the same with `status` validated at once. `sqlite_master` listed **no** plugin index at all in the fresh process (not even the M5c ones) until `POST /test/run-scheduled`; afterwards all 23, including `idx_plugin_flux-import_jobs_templateId_createdAt` and the three `templates` indexes. A job row stored without `templateId` was not matched; one with `templateId: "T1"` was, with and without `status` | Probe, both runtimes; Tasks 1, 5, 7, 8 |
| V3 | **Holds.** A temporary Vitest setup file wrapped `templateSchema.safeParse` for the whole unit suite (78 files) plus every exported integration fixture builder: for each of the 222 distinct templates that parsed, `parse(parse(t))` deep-equalled `parse(t)`, and parsing its JSON round trip gave the same JSON. Eight in-memory unit fixtures carried explicit `undefined` keys (`slug`, `taxonomies`, `bylines`), which JSON drops; stored rows are JSON, so this changes nothing. Defaults written into the stored form are `source: { format: "csv" }` and `tz: "UTC"` on `date` mappings and `publishAt` (`src/engine/template.ts:157`, `:269`, `:324`, `:335`; the spec's Ruling 42 names only the first) | Probe; Task 2 (table test) |
| V4 | **Holds.** On both runtimes: `compareAndDelete(id, staleRevision)` returned `{ applied: false }` and the row still existed; with the revision `getVersioned` returned it gave `{ applied: true }` (1 D1 query) and the row was gone; a second call with that revision gave `{ applied: false }` | Probe; Tasks 1, 3, 8 |
| V5 | **Per call measured; the routes are projected here and measured in Task 9.** On D1: each storage `get`, `getVersioned`, `put`, `compareAndSet`, `compareAndDelete` and query page 1 query; `listSchemaFields` 2; `taxonomyDefs()` 1. Bytes read: `templates.query({ limit: 8 })` over 256 KiB rows 2,099,216 (8 rows, 16 ms on local D1); the owner query over 9 such rows 2,361,618; a 256 KiB `get` 262,402; the schema reads of a collection with two reference fields and two taxonomies under 1 KB. Projected per route (plus EmDash's own auth queries, outside the handler): list 1; get and export 1; create and import about 9 (name 1, fields 2, each reference target 2, taxonomies 1, owner 1, links 1, write 1); update about 10; delete 2; `jobs/create { templateId }` today's plus 1. All far under 50. Bytes: list at most about 2.1 MB; create and import about 0.3-0.8 MB with one or two same-owner templates (100 × 256 KiB in the misconfigured worst case, spec "Workers and Node") | Probe counter; Task 9 Step 2 |
| E1 | **Zod 4.5.4's `z.record` drops a `__proto__` key silently.** `JSON.parse('{"__proto__":"Draft","a":"b"}')` has an own `__proto__` key; `optionMap.parse` of it returns `{ a: "b" }` with no `__proto__` own key and an unchanged prototype. A strict `z.object` refuses the same key as `Unrecognized key: "__proto__"`. So a walk of the **parsed** template (spec step 2) can never find the key, and the mapping entry is lost without a word; plan Ruling 1 walks the raw input | Node, Zod 4.5.4; Task 2 |
| E2 | **The dev route needs the CSRF header on Node** (M5c E1): `POST /test/run-scheduled` is sent with `X-EmDash-Request: 1` on both sites | M5c plan; Tasks 7, 8 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while integration servers restart, and `crash.test.ts` can then fail its precondition; re-running the file settles it | M3c-M5c |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d: if Task 8 or 9 sees it, capture the server log and record it | M4d-M5c reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4397` (WSL mirrored networking), so `retention.test.ts` fails in setup with "Port 4397 is in use". While drafting, the workerd probe's first start also found 4421 briefly in use right after the Node probe stopped; a re-run seconds later was clean | M5c review; drafting |

## Rulings this plan makes

1. **The `__proto__` walk reads the raw input** (Fact E1; amends spec "Validation" step 2, which says "parsed"). `protoKeyProblems(input)` walks the input with an explicit stack (Review Focus 1) and reports `<path>: "__proto__" is not allowed as a key`, `<path>` being the dot path of the object holding the key (`template` at the root). Its problems join the schema's in step 1's result.
2. **`MemoryKv` models EmDash's paging and index check.** Without `orderBy` its cursor is keyset by creation, as EmDash's `(created_at, id)` (spec F2; `database/repositories/plugin-storage.ts:357-449`), so a page after a delete skips nothing; with `orderBy` it keeps its offset cursor. Built with `indexes`, it refuses a `where` or `orderBy` field no index declares, with EmDash's message. The spec's paging test (17 rows, a delete between pages) cannot pass on the old offset cursor.
3. **Name length counts UTF-16 code units**, as `z.string().max()` and source names do.
4. **The inline fingerprint is `fingerprint(parsed)`.** `fingerprint` already hashes `stableJson` of its argument (`src/engine/fingerprints.ts:42-46`); the spec's `fingerprint(stableJson(parsed))` would hash the JSON string of that string. Same determinism, one canonicalisation.
5. **`ServiceError.details` widens to `Readonly<Record<string, unknown>>`** (it is `{ code: string }` today); `PluginRouteError` takes `unknown` details (emdash `src/plugins/route-error.ts:6-11`).
6. **The shape result is grouped, so `createJob` keeps M5c's errors.** `templateShapeProblems` returns step 1-2 problems as a refusal, and steps 3-6 (`fit`), 7 (`expressions`) and 8 (`source`) as separate lists. `createJob` keeps M5c's order of refusals: the schema ("The template is invalid"), the option checks, expressions ("The template has invalid expressions"), source (`invalid_source`), then `[...fit, ...checkTemplate(…)]` as "The template does not fit the source or schema". The template routes and `schema/apply` refuse on any of them. Where an existing test's expected `toEqual` list fails only on order, change it to the new order.
7. **`schema/apply` keeps `VALIDATION_ERROR`** for an inline template, with "The template is invalid: <problems joined by "; ">" over every shape problem.
8. **Site checks resolve the locale as `jobs/create` does, and report a translation-locale failure once.** When `resolveTranslation` fails, its message is the problem and `checkTemplate`'s "translationOf.locale is not set" (`TRANSLATION_LOCALE_NOT_SET`) is dropped. Owner checks compare locales through `resolveLocale` (each row's locale and the template's), and the warnings name the resolved locale (the template's as written when it does not resolve).
9. **Module layout.** Shape in `src/engine/shape.ts`; the template service in `src/plugin/templates.ts`; export and import in `src/plugin/template-files.ts`; `templateId` resolution for jobs in `src/plugin/job-templates.ts`, so Tasks 3 and 5 touch different files.
10. **Import details.** `template` absent from the file is `INVALID_FILE`; the file's `name` is required unless the request gives `name`, and then it is ignored; the size is checked again after an `owner` override (an override can add up to 120 bytes). The site checks run once, before the owner refusal and the name check (both read their results).
11. **Template dependencies are built per handler** (`templateDeps(ctx, services)` in `routes.ts`), so routes that do not touch templates do not need the `templates` collection (`tests/unit/rollback-route.test.ts` mocks only `pluginCollections` and `sourcesCollection`).
12. **Updates always run the site checks**, so `check` is returned on every update (spec "Validation": "computed on every create, update and import").
13. **An empty description is no description**: create stores none for `""`; update removes it for `null` or `""`.
14. **The jobs from a saved template carry its ID and revision only when it is saved.** An inline job has neither field; a rollback job copies whichever its original has.

## Verification while drafting

| Check | Result |
| --- | --- |
| Task 0 (V1, V2, V4, V5) | hold on Node and workerd (Facts), with a temporary probe route, probe test and D1 counter, removed afterwards; V5's routes are projected from per-call counts and measured in Task 9 |
| Task 0 (V3) | holds over 222 parsed templates (Fact V3) |
| Zod on `__proto__` | Fact E1; plan Ruling 1 |
| `paddedTemplate` (Task 2) | the algorithm was run at 1,000-307,200 bytes (40 sizes each from 11 starts): exact size, keys 1-200 characters, at most 1,000 entries a map; `templateSchema.parse` keeps the size and `compileTemplate` accepts it at 262,144, 262,145 and 307,200 bytes |
| Tree after Task 0 | `git status` clean; `sites/dev/data.db*` identical to the backup; `sites/dev-cf/.wrangler` restored; both `emdash-env.d.ts` restored |
| Code in Tasks 1-8 | written against `198a6c6`; not applied or run while drafting (see "Spec" above) |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/ports.ts`, `src/emdash/storage.ts`, `src/engine/types.ts`, `src/plugin/definition.ts`, `src/meta.ts`, `tests/unit/fakes.ts` | `compareAndDelete`, `Job.templateId`/`templateRevision`, the collection and index, the version, the fake's cursor and index check (Task 1) |
| `src/engine/shape.ts` (new), `src/engine/template.ts`, `src/engine/jobs.ts`, `src/plugin/schema-apply.ts`, `src/plugin/service.ts` (`ServiceError`), `src/plugin/templates.ts` (new), `tests/fixtures/templates.ts` (new) | The shape function, the trimmed `checkTemplate`, the template-route checks, names (Task 2) |
| `src/plugin/templates.ts`, `src/plugin/service.ts` (`linkSchemaFor`) | CRUD, revisions, site checks, owner warnings (Task 3) |
| `src/plugin/template-files.ts` (new) | Export and import (Task 4) |
| `src/plugin/job-templates.ts` (new), `src/engine/jobs.ts`, `src/engine/rollback.ts`, `src/plugin/service.ts` (`listJobs`), `src/plugin/sources.ts` | Jobs by template, the template-aware skip (Task 5) |
| `src/plugin/routes.ts` | The routes (Task 6) |
| `tests/integration/templates.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 7 and 8) |

`src/engine/batch.ts`, `src/engine/missing.ts`, `src/engine/revert.ts`, `src/engine/journal.ts` and `src/plugin/retention.ts` do not change: every later step already reads `job.template` (spec P2), and retention reads no other collection (spec P7).

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V5 | — | nothing (results above) | — |
| 1. Storage | — | `src/engine/{ports,types}.ts`, `src/emdash/storage.ts`, `src/plugin/definition.ts`, `src/meta.ts`, `tests/unit/{fakes,fakes.test,storage.test,definition.test}.ts` | sonnet |
| 2. Shape and template-route checks | — | `src/engine/{shape,template,jobs}.ts`, `src/plugin/{templates,schema-apply,service}.ts`, `tests/fixtures/templates.ts`, `tests/unit/{shape,template-save,schema-apply,template,portable-text-template,translation-template,rules-template}.test.ts` | opus |
| 3. Template service | 1, 2 (`compareAndDelete`, `MemoryKv(indexes)`, `STORAGE.templates`, `templateForSave`, `SavedTemplate`) | `src/plugin/{templates,service}.ts`, `tests/unit/{templates-fixture.ts,templates.test.ts}` | opus |
| 4. Export and import | 3 (`TemplateDeps`, `siteCheck`, `insertTemplate`, `templateSetup`) | `src/plugin/template-files.ts`, `tests/unit/template-files.test.ts` | sonnet |
| 5. Jobs by template | 1, 2 (`Job.templateId`, `SavedTemplate`, `readSavedTemplate`, `paddedTemplate`) | `src/plugin/{job-templates,sources,service}.ts`, `src/engine/{jobs,rollback}.ts`, one line of `src/plugin/routes.ts`, `tests/unit/{template-jobs,sources,xlsx-import}.test.ts` | opus |
| 6. Routes | 3, 4, 5 | `src/plugin/routes.ts`, `tests/unit/{definition,template-routes}.test.ts` | sonnet |
| 7. Node integration | 6 | `tests/integration/templates.test.ts` | sonnet |
| 8. workerd parity | 6 | `tests/integration-cf/parity.test.ts` | sonnet |
| 9. Review run and note | 0-8 | `docs/superpowers/notes/2026-11-16-m6a-review.md`, the roadmap; temporarily a D1 counter (removed) | opus |

The waves:
1. **1 ∥ 2.** No file is shared.
2. **3 ∥ 5.** Both edit `src/plugin/service.ts`, in different functions (Task 3 exports `linkSchemaFor`; Task 5 changes `listJobs`); merge in numeric order.
3. **4**
4. **6**
5. **7 ∥ 8.** Separate harnesses, files and ports.
6. **9**

Files touched by more than one task, merged in numeric order: `src/plugin/templates.ts` (Tasks 2, 3), `src/engine/jobs.ts` (Tasks 2, 5), `src/plugin/service.ts` (Tasks 2, 3, 5), `src/plugin/routes.ts` (Tasks 5, 6), `tests/unit/definition.test.ts` (Tasks 1, 6).

---

### Task 0: Verify the unconfirmed facts (V1-V5)

**Files:** none.

**Interfaces:**
- Consumes: plugin storage (spec F1-F5), the schema registry and `ctx.taxonomies` through a temporary probe route; the M5a D1 counter.
- Produces: Facts V1-V5 and E1, and plan Rulings 1 and 2 (above). The Task 9 note records the results from the Facts table.

- [x] **V1**: a 256 KiB template row and a job row holding it, `put`, `get` and `compareAndSet`, on SQLite and D1. Passed; the cap stays 256 KiB.
- [x] **V2**: the new collection and the jobs index validate at once after the upgrade, appear at the next scheduler tick, and match only jobs with `templateId`. Passed.
- [x] **V3**: parsing is idempotent over every template the suites parse. Passed.
- [x] **V4**: `compareAndDelete` at a stale revision deletes nothing. Passed.
- [x] **V5**: per-call D1 queries and bytes measured; route budgets projected under 50 queries and about 2 MiB, measured in Task 9.

### Task 1: Storage: the `templates` collection, the jobs index, `compareAndDelete`, the fakes and the version

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts` (`KvCollection`), `packages/flux-import/src/emdash/storage.ts` (`kvCollection`), `packages/flux-import/src/engine/types.ts` (`Job`), `packages/flux-import/src/plugin/definition.ts` (`STORAGE` and its comment), `packages/flux-import/src/meta.ts`
- Modify: `packages/flux-import/tests/unit/fakes.ts` (`MemoryKv`)
- Test: `packages/flux-import/tests/unit/fakes.test.ts`, `packages/flux-import/tests/unit/storage.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: `KvCollection<T>`, `kvCollection`, `STORAGE`, `MemoryKv`, emdash `StorageCollection.compareAndDelete(id, expectedRevision): Promise<{ applied: boolean }>` (`src/plugins/types.ts:285`).
- Produces:
  - `KvCollection<T>.compareAndDelete(id: string, expectedRevision: string): Promise<{ applied: boolean }>`;
  - `Job.templateId?: string` and `Job.templateRevision?: number` (doc: "M6a: the saved template the job was created from, and its revision then; absent for an inline template. A rollback job copies both.");
  - `STORAGE.templates = { indexes: ["name", "collection", "owner"] }`, `STORAGE.jobs.indexes` ending in `["templateId", "createdAt"]`;
  - `FLUX_IMPORT_VERSION = "0.3.0"`;
  - `new MemoryKv<T>(indexes?: ReadonlyArray<string | ReadonlyArray<string>>)`, `MemoryKv.compareAndDelete`, a keyset cursor without `orderBy`, and `rows: Map<string, { value: T; revision: number; created: number }>`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/fakes.test.ts`, add inside `describe("MemoryKv", …)`:
````ts
	it("pages without orderBy in creation order, and a cursor survives a delete of a row it returned (plan Ruling 2)", async () => {
		const kv = new MemoryKv<{ n: number }>();
		for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) await kv.put(id, { n: i });
		const first = await kv.query({ limit: 2 });
		expect(first.items.map((i) => i.id)).toEqual(["a", "b"]);
		await kv.delete("a");
		// A rewrite keeps its place, as EmDash's put keeps created_at.
		await kv.put("d", { n: 30 });
		const second = await kv.query({ limit: 2, cursor: first.cursor as string });
		expect(second.items.map((i) => i.id)).toEqual(["c", "d"]);
		const third = await kv.query({ limit: 2, cursor: second.cursor as string });
		expect(third).toEqual({ items: [{ id: "e", data: { n: 4 } }], hasMore: false });
	});

	it("refuses fields no declared index names when built with indexes, as EmDash does", async () => {
		const kv = new MemoryKv<{ name: string }>(["name", ["templateId", "createdAt"]]);
		await kv.put("a", { name: "x" });
		await expect(kv.query({ where: { name: "x" } })).resolves.toMatchObject({ hasMore: false });
		await expect(kv.query({ where: { templateId: "T" }, orderBy: { createdAt: "desc" } })).resolves.toBeDefined();
		await expect(kv.query({ where: { owner: "o" } })).rejects.toThrow(
			"Cannot query on non-indexed field 'owner'.",
		);
		await expect(kv.query({ orderBy: { updatedAt: "asc" } })).rejects.toThrow(
			"Cannot query on non-indexed field 'updatedAt'.",
		);
		// Without indexes the fake accepts any field, as every existing test relies on.
		await expect(new MemoryKv<{ owner: string }>().query({ where: { owner: "o" } })).resolves.toBeDefined();
	});

	it("deletes with compareAndDelete only at the stored revision (spec F3, V4)", async () => {
		const kv = new MemoryKv<{ n: number }>();
		await kv.put("a", { n: 1 });
		const stale = await kv.getVersioned("a");
		await kv.put("a", { n: 2 });
		expect(await kv.compareAndDelete("a", stale!.revision)).toEqual({ applied: false });
		expect(await kv.get("a")).toEqual({ n: 2 });
		const current = await kv.getVersioned("a");
		expect(await kv.compareAndDelete("a", current!.revision)).toEqual({ applied: true });
		expect(await kv.get("a")).toBeNull();
		expect(await kv.compareAndDelete("a", current!.revision)).toEqual({ applied: false });
	});
````

In `packages/flux-import/tests/unit/storage.test.ts`, add inside `describe("kvCollection", …)`:
````ts
	it("passes compareAndDelete through with the expected revision", async () => {
		const kv = kvCollection<{ n: number }>(asStorage(new MemoryKv<unknown>()));
		await kv.put("c", { n: 9 });
		const c = await kv.getVersioned("c");
		expect(await kv.compareAndDelete("c", "0")).toEqual({ applied: false });
		expect(await kv.get("c")).toEqual({ n: 9 });
		expect(await kv.compareAndDelete("c", c!.revision)).toEqual({ applied: true });
		expect(await kv.get("c")).toBeNull();
	});
````

In `packages/flux-import/tests/unit/definition.test.ts`:
- replace `expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId", "sourceUploadId"]);` with:
````ts
		expect(STORAGE.jobs.indexes).toEqual([
			"status",
			"createdAt",
			"uploadId",
			"sourceUploadId",
			["templateId", "createdAt"],
		]);
		expect(STORAGE.templates.indexes).toEqual(["name", "collection", "owner"]);
		expect(FLUX_IMPORT_VERSION).toBe("0.3.0");
````
- add `import { FLUX_IMPORT_VERSION } from "../../src/meta.js";` to its imports. The capability expectation stays as it is (spec Ruling 14).

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/fakes.test.ts tests/unit/storage.test.ts tests/unit/definition.test.ts`
Expected: FAIL — the cursor test returns `["d", "e"]` on page two (offset cursor), `compareAndDelete` is not a function, `STORAGE.templates` is undefined, the version is `0.2.0`. `pnpm typecheck` also fails on `compareAndDelete`.

- [ ] **Step 3: Implement**

- `ports.ts`: add `compareAndDelete(id: string, expectedRevision: string): Promise<{ applied: boolean }>;` to `KvCollection<T>`, after `compareAndSet`, with the doc "Deletes the row only when its stored revision is `expectedRevision` (M6a)."
- `storage.ts`: `compareAndDelete: (id, expectedRevision) => collection.compareAndDelete(id, expectedRevision),`.
- `types.ts`: the two `Job` fields (Interfaces), after `sourceId`.
- `definition.ts`: the two `STORAGE` changes; extend the comment: "`templates` holds saved templates (M6a): `name` serves the uniqueness check, `collection` the listing filter, `owner` with `collection` the shared-owner warning; `jobs` `["templateId", "createdAt"]` lists a template's jobs newest first."
- `meta.ts`: `0.3.0`.
- `fakes.ts` `MemoryKv`:
  - `constructor(indexes?: ReadonlyArray<string | ReadonlyArray<string>>)` stores `new Set(indexes.flat())` or `null`;
  - `write` keeps a row's `created` on a rewrite and gives a new row `++this.created`;
  - `compareAndDelete(id, expected)` deletes when `String(row.revision) === expected`;
  - `query` first checks every `where` and `orderBy` key against the set (when there is one) and throws `new Error(\`Cannot query on non-indexed field '${field}'.\`)` (EmDash's wording, `src/plugins/storage-query.ts`);
  - without `orderBy`: items in `created` order; the cursor is `` `c${created}` `` of the page's last item; a page with a cursor takes the items whose `created` is greater. With `orderBy`: the offset cursor as today.

- [ ] **Step 4: Run them to see them pass, and the whole suite**

Run: `pnpm exec vitest run tests/unit/fakes.test.ts tests/unit/storage.test.ts tests/unit/definition.test.ts`
Expected: PASS (4 new tests and 1 changed one).
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. Every existing query without `orderBy` (the missing phase's link pages, retention, `latestSourceUploads`, `uploadInUse`) pages append-only or rewritten-in-place rows, where the keyset and the offset cursor return the same pages. If one fails, find out why before changing anything: EmDash pages by the keyset, so a test that passed only on the offset cursor was testing the fake, and the code it covers may skip rows on a real site. Report it in the task's summary.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/storage.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/meta.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/fakes.test.ts packages/flux-import/tests/unit/storage.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Declare the templates collection and the jobs templateId index, add compareAndDelete to the storage port, and bump the plugin to 0.3.0"
```

### Task 2: The shape function, the template-route checks and names

**Files:**
- Create: `packages/flux-import/src/engine/shape.ts`, `packages/flux-import/src/plugin/templates.ts`, `packages/flux-import/tests/fixtures/templates.ts`
- Modify: `packages/flux-import/src/engine/template.ts` (`checkTemplate`, `TRANSLATION_LOCALE_NOT_SET`), `packages/flux-import/src/engine/jobs.ts` (`createJob`), `packages/flux-import/src/plugin/schema-apply.ts` (`resolveRequests`), `packages/flux-import/src/plugin/service.ts` (`ServiceError.details`)
- Test: `packages/flux-import/tests/unit/shape.test.ts` (new), `packages/flux-import/tests/unit/template-save.test.ts` (new), `packages/flux-import/tests/unit/schema-apply.test.ts`; moved expectations in `tests/unit/template.test.ts`, `tests/unit/portable-text-template.test.ts`, `tests/unit/translation-template.test.ts`, `tests/unit/rules-template.test.ts`

**Interfaces:**
- Consumes: `templateSchema`, `Template`, `templatePaths`, `rulesProblems`, `compileTemplate` (`template.ts`); `pathProblem` (`sources/paths.ts`); `checkSource` (`sources/readers.ts`); `MAX_MEDIA_MAPPINGS` (`engine/media.ts`); `MAX_PORTABLE_TEXT_MAPPINGS`, `utf8Length` (`engine/portable-text.ts`); `ServiceError`.
- Produces:
  - in `src/engine/shape.ts`:
    ```ts
    export type TemplateShape =
    	| { ok: false; problems: string[] } // step 1 (schema) and step 2 (__proto__ keys)
    	| { ok: true; template: Template; fit: string[]; expressions: string[]; source: string[] };
    export function templateShapeProblems(input: unknown): TemplateShape;
    export function protoKeyProblems(input: unknown): string[];
    /** Every problem of a template that parsed: fit, expressions, source, in that order. */
    export function shapeProblems(shape: Extract<TemplateShape, { ok: true }>): string[];
    ```
  - in `template.ts`: `export const TRANSLATION_LOCALE_NOT_SET = "translationOf.locale is not set";`, and `checkTemplate` without steps 3-6 (same signature);
  - in `src/plugin/templates.ts`: `TEMPLATE_MAX_BYTES = 262_144`, `TEMPLATE_NAME_MAX = 100`, `TEMPLATE_DESCRIPTION_MAX = 2000`, `TEMPLATE_NAME_RULE`, `templateNameProblem(name: string): string | null` (checks `name.normalize("NFC")`), `templateForSave(input: unknown): Template`, `assertTemplateSize(t: Template): void`, `readSavedTemplate(row: Pick<SavedTemplate, "template">): unknown`, and the types:
    ```ts
    export interface SavedTemplate {
    	id: string;
    	name: string;
    	description?: string;
    	template: Template;
    	revision: number;
    	collection: string;
    	locale: string;
    	owner?: string;
    	format: SourceFormat;
    	createdAt: string;
    	updatedAt: string;
    	createdBy: string;
    	updatedBy: string;
    }
    export type TemplateSummary = Omit<SavedTemplate, "template">;
    export interface TemplateCheck { problems: string[]; warnings: string[] }
    export interface SavedResult { template: SavedTemplate; check: TemplateCheck }
    ```
  - `ServiceError.details?: Readonly<Record<string, unknown>>`;
  - in `tests/fixtures/templates.ts`: `utf8Bytes(value: unknown): number` and `paddedTemplate(collection: string, bytes: number): Record<string, unknown>` (a CSV template whose parsed JSON is exactly `bytes` UTF-8 bytes: `key` from `sku`, `title` from `Name` (text), `stage_a` and `stage_b` from `Stage` (select, maps of padding keys to `"live"`)).

- [ ] **Step 1: Write the fixture and the failing tests**

Create `packages/flux-import/tests/fixtures/templates.ts` (the algorithm was run while drafting; see "Verification while drafting"):
````ts
/** Templates of an exact JSON size for the M6a size checks (unit, Node and workerd). */

export const utf8Bytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * A CSV template whose JSON, parsed or not (it holds every default), is exactly `bytes` UTF-8
 * bytes: two select mappings (`stage_a`, `stage_b`, from `Stage`) whose maps send padding keys to
 * "live". Each map holds at most 1,000 keys of at most 200 characters, as the schema allows.
 */
export function paddedTemplate(collection: string, bytes: number): Record<string, unknown> {
	const maps: Record<string, string>[] = [{}, {}];
	const template = {
		version: 1,
		source: { format: "csv" },
		collection,
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			stage_a: { from: "Stage", type: "select", map: maps[0] },
			stage_b: { from: "Stage", type: "select", map: maps[1] },
		},
	};
	let n = 0;
	let last = "";
	const mapOf = (i: number) => maps[i < 1000 ? 0 : 1] as Record<string, string>;
	const add = (length: number) => {
		last = `k${n}-`.padEnd(length, "x");
		mapOf(n)[last] = "live";
		n++;
	};
	const widenLast = (by: number) => {
		const map = mapOf(n - 1);
		delete map[last];
		last = last.padEnd(last.length + by, "x");
		map[last] = "live";
	};
	// A 150-character key costs 160 bytes (quotes, colon, "live", comma): the bulk at once.
	const bulk = Math.max(0, Math.floor((bytes - utf8Bytes(template) - 400) / 160));
	for (let i = 0; i < bulk; i++) add(150);
	while (bytes - utf8Bytes(template) > 170) add(150);
	const left = bytes - utf8Bytes(template);
	if (left < 20) {
		widenLast(left);
	} else {
		add(8);
		widenLast(bytes - utf8Bytes(template));
	}
	if (utf8Bytes(template) !== bytes) {
		throw new Error(`paddedTemplate: ${utf8Bytes(template)} bytes, not ${bytes}`);
	}
	return template;
}
````

Create `packages/flux-import/tests/unit/shape.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { createJob, JobError } from "../../src/engine/jobs.js";
import { protoKeyProblems, templateShapeProblems } from "../../src/engine/shape.js";
import { checkTemplate, type SchemaField, templateSchema } from "../../src/engine/template.js";
import { typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, xmlTemplate } from "../fixtures/formats.js";
import { linkNames, peopleTemplate, postsTemplate } from "../fixtures/links.js";
import { mediaTemplate } from "../fixtures/media.js";
import { portableTextTemplate } from "../fixtures/portable-text.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { englishTemplate, translationNames, translationTemplate } from "../fixtures/translations.js";
import { xlsxTemplate } from "../fixtures/xlsx.js";
import { template as integrationTemplate } from "../integration/fixtures.js";
import { makeDeps } from "./fakes.js";
import { template as rollbackTemplate } from "./rollback-fixture.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const title: SchemaField[] = [{ slug: "title", type: "string" }];

/** The problems createJob reports for `template`, or [] when it creates the job. */
async function jobProblems(
	template: unknown,
	schemaFields: SchemaField[],
	body: string,
): Promise<string[]> {
	const { deps } = makeDeps();
	deps.source.add("u1", body);
	try {
		await createJob(deps, { uploadId: "u1", template, schemaFields });
	} catch (e) {
		if (e instanceof JobError) return e.details;
		throw e;
	}
	return [];
}

const files = Object.fromEntries(
	Array.from({ length: 6 }, (_, i) => [`m${i}`, { from: `U${i}`, type: "file" }]),
);
const rich = Object.fromEntries(
	["a", "b", "c", "d"].map((f) => [f, { from: f.toUpperCase(), type: "portableText", format: "html" }]),
);

/** Steps 3-6: each refused alone, by the shape function and once by createJob (spec Ruling 27). */
const FIT: {
	name: string;
	template: Record<string, unknown>;
	fields: SchemaField[];
	body: string;
	problem: string;
}[] = [
	{
		name: "six image and file fields",
		template: { ...base, fields: files },
		fields: Object.keys(files).map((slug) => ({ slug, type: "file" })),
		body: "sku,U0,U1,U2,U3,U4,U5\nA1,,,,,,\n",
		problem: "The template maps 6 image and file fields; at most 5 are allowed",
	},
	{
		name: "four portableText fields",
		template: { ...base, fields: rich },
		fields: Object.keys(rich).map((slug) => ({ slug, type: "portableText" })),
		body: "sku,A,B,C,D\nA1,,,,\n",
		problem: "The template maps 4 portableText fields; at most 3 are allowed",
	},
	{
		name: "a JSON path with an empty key",
		template: {
			...base,
			source: { format: "json" },
			fields: { title: { from: "name..first", type: "text" } },
		},
		fields: title,
		body: '[{"sku":"A1","name":{"first":"x"}}]',
		problem: '"name..first" has an empty key',
	},
	{
		name: "an XML path with an invalid name",
		template: {
			...base,
			source: { format: "xml", records: "feed/item" },
			key: { from: "@sku" },
			fields: { title: { from: "1bad", type: "text" } },
		},
		fields: title,
		body: '<feed><item sku="A1"><title>x</title></item></feed>',
		problem: '"1bad" has an invalid element or attribute name "1bad"',
	},
	{
		name: "translationOf.locale equal to locale in another case",
		template: { ...base, locale: "fr", translationOf: { from: "en_id", locale: "FR" } },
		fields: title,
		body: "sku,en_id,Name\nA1,E1,Desk\n",
		problem: 'translationOf.locale must differ from locale ("fr")',
	},
	{
		name: "a rules conflict",
		template: { ...base, rules: { mode: "create", protectEdited: true } },
		fields: title,
		body: "sku,Name\nA1,Desk\n",
		problem: "rules.updateFields and rules.protectEdited apply to updates; mode create never updates",
	},
];

describe("templateShapeProblems (spec Validation, Ruling 27)", () => {
	it.each(FIT)("refuses $name, reports it once in createJob, and checkTemplate no longer does", async (c) => {
		const shape = templateShapeProblems(c.template);
		expect(shape).toMatchObject({ ok: true, fit: [c.problem], expressions: [], source: [] });
		const problems = await jobProblems(c.template, c.fields, c.body);
		expect(problems.filter((p) => p === c.problem)).toHaveLength(1);
		expect(checkTemplate(templateSchema.parse(c.template), c.fields, null)).not.toContain(c.problem);
	});

	it("accepts five image and file fields and three portableText fields", () => {
		const five = Object.fromEntries(Object.entries(files).slice(0, 5));
		const three = Object.fromEntries(Object.entries(rich).slice(0, 3));
		expect(templateShapeProblems({ ...base, fields: five })).toMatchObject({ ok: true, fit: [] });
		expect(templateShapeProblems({ ...base, fields: three })).toMatchObject({ ok: true, fit: [] });
	});

	it("refuses the schema (step 1), expressions (step 7) and the source block (step 8) on their own", () => {
		const schema = templateShapeProblems({ ...base, version: "1" });
		expect(schema.ok).toBe(false);
		expect(!schema.ok && schema.problems.some((p) => p.startsWith("version: "))).toBe(true);
		const expr = templateShapeProblems({ ...base, key: { expr: "$now()" } });
		expect(expr).toMatchObject({ ok: true, fit: [], source: [] });
		expect(expr.ok && expr.expressions.length === 1 && expr.expressions[0]?.startsWith("key.expr: ")).toBe(true);
		expect(templateShapeProblems({ ...base, source: { format: "json", sheet: 1 } })).toMatchObject({
			ok: true,
			fit: [],
			expressions: [],
			source: ["source.sheet is only allowed for xlsx"],
		});
	});

	it("refuses a __proto__ key in a select map, which the schema alone would drop (Fact E1)", () => {
		const input = JSON.parse(
			'{"version":1,"collection":"products","locale":"en","key":{"from":"sku"},"fields":{"stage":{"from":"S","type":"select","map":{"__proto__":"live","a":"b"}}}}',
		);
		expect(templateSchema.safeParse(input).success).toBe(true);
		expect(templateShapeProblems(input)).toEqual({
			ok: false,
			problems: ['fields.stage.map: "__proto__" is not allowed as a key'],
		});
	});

	it("refuses a __proto__ key at another depth and at the root", () => {
		const nested = JSON.parse(
			'{"version":1,"collection":"products","locale":"en","key":{"from":"sku"},"fields":{"title":{"from":"Name","type":"text"}},"rules":{"__proto__":{"mode":"create"}}}',
		);
		const shape = templateShapeProblems(nested);
		expect(shape.ok).toBe(false);
		expect(!shape.ok && shape.problems).toContain('rules: "__proto__" is not allowed as a key');
		expect(protoKeyProblems(JSON.parse('{"__proto__":1}'))).toEqual([
			'template: "__proto__" is not allowed as a key',
		]);
		expect(protoKeyProblems(JSON.parse('[{"a":[{"__proto__":1}]}]'))).toEqual([
			'0.a.0: "__proto__" is not allowed as a key',
		]);
	});

	it("does not overflow the stack on a deeply nested input (Review Focus 1)", () => {
		let deep: unknown = "x";
		for (let i = 0; i < 100_000; i++) deep = [deep];
		const run = () => templateShapeProblems({ ...base, extra: deep });
		expect(run).not.toThrow();
		const shape = run();
		expect(shape.ok).toBe(false);
		expect(!shape.ok && shape.problems).toContain('template: Unrecognized key: "extra"');
	});
});

describe("V3: parsing the stored form changes nothing (spec Ruling 3)", () => {
	const links = linkNames("v3");
	const tr = translationNames("v3");
	const fixtures: [string, unknown][] = [
		["integration template", integrationTemplate("v3")],
		["typesTemplate csv", typesTemplate("v3")],
		["typesTemplate json", typesTemplate("v3", "json")],
		["xlsxTemplate", xlsxTemplate("v3", { sheet: "Products", headerRow: 2 })],
		["jsonTemplate", jsonTemplate("v3")],
		["xmlTemplate", xmlTemplate("v3")],
		["peopleTemplate", peopleTemplate(links)],
		["postsTemplate csv", postsTemplate(links)],
		["postsTemplate json", postsTemplate(links, "json")],
		["mediaTemplate", mediaTemplate("v3", { refresh: true })],
		["portableTextTemplate", portableTextTemplate("v3")],
		["portableTextTemplate markdown", portableTextTemplate("v3", { format: "markdown", photo: true })],
		["englishTemplate", englishTemplate(tr)],
		["translationTemplate", translationTemplate(tr, "fr")],
		[
			"rollback fixture with rules",
			rollbackTemplate({
				rules: { owner: "o", missing: { action: "trash", maxPercent: 10 }, protectEdited: true },
				publishAt: { from: "Go", tz: "site" },
			}),
		],
		["padded", paddedTemplate("v3", 20_000)],
	];

	it.each(fixtures)("%s", (_name, t) => {
		const once = templateSchema.parse(t);
		const stored = JSON.parse(JSON.stringify(once));
		expect(templateSchema.parse(stored)).toEqual(once);
		expect(JSON.stringify(templateSchema.parse(stored))).toBe(JSON.stringify(once));
	});
});
````

Create `packages/flux-import/tests/unit/template-save.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { templateSchema } from "../../src/engine/template.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	TEMPLATE_MAX_BYTES,
	TEMPLATE_NAME_RULE,
	templateForSave,
	templateNameProblem,
} from "../../src/plugin/templates.js";
import { paddedTemplate, utf8Bytes } from "../fixtures/templates.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};

function thrown(run: () => unknown): ServiceError {
	try {
		run();
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not throw");
}

describe("templateForSave (the template routes, spec Ruling 28)", () => {
	it("returns the parsed template, defaults applied", () => {
		expect(templateForSave(base)).toEqual(templateSchema.parse(base));
		expect(templateForSave(base).source).toEqual({ format: "csv" });
	});

	it("refuses an integer version other than 1 with its own code", () => {
		expect(thrown(() => templateForSave({ ...base, version: 2 }))).toMatchObject({
			code: "UNSUPPORTED_TEMPLATE_VERSION",
			status: 400,
			message: "This template has format version 2; this version of flux-import reads version 1",
		});
	});

	it("leaves every other bad version or shape to the schema, with its path", () => {
		const { version: _v, ...noVersion } = base;
		for (const [input, prefix] of [
			[{ ...base, version: "1" }, "version: "],
			[noVersion, "version: "],
			[{ ...base, version: 1.5 }, "version: "],
			[[base], "template: "],
			["template", "template: "],
			[null, "template: "],
		] as const) {
			const e = thrown(() => templateForSave(input));
			expect(e, JSON.stringify(input)).toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
			const problems = (e.details?.problems ?? []) as string[];
			expect(problems.some((p) => p.startsWith(prefix)), JSON.stringify(problems)).toBe(true);
		}
	});

	it("refuses every shape problem, fit, expressions and source alike", () => {
		const e = thrown(() =>
			templateForSave({ ...base, key: { expr: "$now()" }, rules: { mode: "create", protectEdited: true } }),
		);
		expect(e).toMatchObject({ code: "INVALID_TEMPLATE", message: "The template is invalid" });
		expect(e.details?.problems).toHaveLength(2);
	});

	it("accepts a template exactly at TEMPLATE_MAX_BYTES and refuses one byte more", () => {
		expect(TEMPLATE_MAX_BYTES).toBe(262_144);
		const at = templateForSave(paddedTemplate("products", TEMPLATE_MAX_BYTES));
		expect(utf8Bytes(at)).toBe(TEMPLATE_MAX_BYTES);
		expect(thrown(() => templateForSave(paddedTemplate("products", TEMPLATE_MAX_BYTES + 1)))).toMatchObject({
			code: "TEMPLATE_TOO_LARGE",
			status: 413,
			message: "The template is 262145 bytes of JSON; at most 262144 are allowed",
		});
	});

	it("counts UTF-8 bytes, not string length (Review Focus 2)", () => {
		const t = paddedTemplate("products", TEMPLATE_MAX_BYTES - 1000) as {
			fields: { title: { from: string } };
		};
		t.fields.title.from = "é".repeat(600);
		expect(JSON.stringify(t).length).toBeLessThan(TEMPLATE_MAX_BYTES);
		expect(utf8Bytes(t)).toBeGreaterThan(TEMPLATE_MAX_BYTES);
		expect(thrown(() => templateForSave(t))).toMatchObject({ code: "TEMPLATE_TOO_LARGE" });
	});
});

describe("templateNameProblem (spec Names, Ruling 38)", () => {
	it("accepts 1 and 100 characters and refuses 0 and 101", () => {
		expect(templateNameProblem("a")).toBeNull();
		expect(templateNameProblem("x".repeat(100))).toBeNull();
		expect(templateNameProblem("")).toBe(TEMPLATE_NAME_RULE);
		expect(templateNameProblem("x".repeat(101))).toBe(TEMPLATE_NAME_RULE);
	});

	it("refuses leading or trailing whitespace, control and format characters", () => {
		for (const name of [" Feed", "Feed ", "Feed\t", "Fe\u0007ed", "Fe‍ed", "Fe‮ed", " Feed"]) {
			expect(templateNameProblem(name), JSON.stringify(name)).toBe(TEMPLATE_NAME_RULE);
		}
		expect(templateNameProblem("Shop feed (nightly) — été")).toBeNull();
	});

	it("checks the NFC form", () => {
		// 100 precomposed characters written with combining marks are 200 code units before NFC.
		expect(templateNameProblem("é".repeat(100))).toBeNull();
	});
});
````

In `packages/flux-import/tests/unit/schema-apply.test.ts`, add inside `describe("applySchema", …)`:
````ts
	it("refuses a template with a shape problem the schema accepts (M6a)", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`m${i}`, { from: `U${i}`, type: "file" }]),
		);
		const template = { version: 1, collection: "products", locale: "en", key: { from: "sku" }, fields: files };
		await expect(applySchema(new FakeApplyRegistry(), { template })).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
			message:
				"The template is invalid: The template maps 6 image and file fields; at most 5 are allowed",
		});
	});
````

Move the expectations `checkTemplate` no longer meets (each becomes a shape assertion; import `templateShapeProblems` from `../../src/engine/shape.js` where needed):
- `tests/unit/template.test.ts`, "checks path syntax instead of columns": `checkTemplate(bad, fields, null)` now `toEqual([])`; add `expect(templateShapeProblems(bad)).toMatchObject({ ok: true, fit: ['"name..first" has an empty key'] });`.
- `tests/unit/template.test.ts`, "allows at most five image and file mappings": `checkTemplate(t(six), fields, null)` now `toEqual([])`; add `expect(templateShapeProblems(six-template-input)).toMatchObject({ ok: true, fit: ["The template maps 6 image and file fields; at most 5 are allowed"] })` with the raw object `t(six)` was parsed from.
- `tests/unit/portable-text-template.test.ts`, "needs a portableText field and allows at most three mappings": the four-field `checkTemplate` now `toEqual([])`; the shape assertion takes its message.
- `tests/unit/translation-template.test.ts`, "needs a source locale other than the job's": the `locale: "FR"` `checkTemplate` now `toEqual([])`; the shape assertion takes `'translationOf.locale must differ from locale ("fr")'`. "translationOf.locale is not set" stays a `checkTemplate` problem. The `startJob` case at its line 276 (`details: ['translationOf.locale must differ…']`) is unchanged: `createJob` reports fit problems in "does not fit".
- `tests/unit/rules-template.test.ts`, "refuses updateFields and protectEdited with mode create, …": the last `checkTemplate` now `toEqual([])`; `rulesProblems` expectations stay.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/shape.test.ts tests/unit/template-save.test.ts tests/unit/schema-apply.test.ts tests/unit/template.test.ts tests/unit/portable-text-template.test.ts tests/unit/translation-template.test.ts tests/unit/rules-template.test.ts`
Expected: FAIL — `src/engine/shape.js` and `src/plugin/templates.js` do not exist, `checkTemplate` still reports the moved problems, `schema/apply` accepts six file fields. The V3 table fails only on the missing import; once `shape.ts` exists it passes (V3 holds), which is its purpose as a guard.

- [ ] **Step 3: Implement `src/engine/shape.ts`**

`templateShapeProblems(input)` runs, in order (spec "Validation"):
1. `templateSchema.safeParse(input)`; issues as `` `${i.path.join(".") || "template"}: ${i.message}` `` (as `createJob` today);
2. `protoKeyProblems(input)`; when either list is non-empty, return `{ ok: false, problems: [...schema, ...proto] }`;
3. for every `templatePaths(t)` path of a `json`, `jsonl` or `xml` template, `pathProblem(path, format)` (CSV and XLSX columns stay in `checkTemplate`);
4. the image/file cap and the portableText cap, with today's messages;
5. when `t.translationOf?.locale` is set and equals `t.locale` ignoring case, `` `translationOf.locale must differ from locale ("${t.locale}")` ``;
6. `rulesProblems(t)`;
7. `compileTemplate(t)`'s problems as `expressions`;
8. `checkSource(t.source)` as `source`.

Steps 3-6 go into `fit` in that order. `protoKeyProblems` walks with an explicit stack of `[value, path]` (no recursion, Review Focus 1), visiting array elements by index and plain objects by `Object.keys`; an own key `__proto__` gives `` `${path.join(".") || "template"}: "__proto__" is not allowed as a key` ``, in visiting order (depth-first, keys in order). `shapeProblems(shape)` is `[...shape.fit, ...shape.expressions, ...shape.source]`.

- [ ] **Step 4: Trim `checkTemplate`, and run the shape in `createJob` and `schema/apply`**

- `template.ts` `checkTemplate`: the path loop keeps only the CSV/XLSX column branch; remove the two caps, the "must differ" branch and `errors.push(...rulesProblems(t))`; push `TRANSLATION_LOCALE_NOT_SET` where it pushed the literal. Rewrite its doc comment to list what it still checks and say that `templateShapeProblems` checks the rest.
- `jobs.ts` `createJob` (plan Ruling 6): replace the `templateSchema.safeParse` block with `templateShapeProblems(input.template)` (`!shape.ok` → `invalid_template` "The template is invalid", `shape.problems`); keep the `publishAt` and `missing` option checks where they are; then `shape.expressions` → "The template has invalid expressions"; then `shape.source` → `invalid_source` "The source block is invalid"; then `const problems = [...shape.fit, ...checkTemplate(template, input.schemaFields, columns, siteTimezone, linkSchema)]` for "The template does not fit the source or schema". Drop the now-unused imports.
- `schema-apply.ts` `resolveRequests` (plan Ruling 7): `templateShapeProblems(input.template)`; a refusal or any `shapeProblems` → `ServiceError("VALIDATION_ERROR", \`The template is invalid: ${problems.join("; ")}\`, 400)`.

- [ ] **Step 5: Implement the template-route checks in `src/plugin/templates.ts`**

- `TEMPLATE_NAME_RULE`, the three bounds and the types (Interfaces; `SourceFormat` from `../sources/reader.js`).
- `templateNameProblem(name)`: on `const n = name.normalize("NFC")`, `TEMPLATE_NAME_RULE` when `n.length` is 0 or over 100, when `/^\s|\s$/u.test(n)`, or when `/[\p{Cc}\p{Cf}]/u.test(n)`; else `null`.
- `templateForSave(input)`: when `input` is a non-array object with an own `version` that is an integer other than 1, `UNSUPPORTED_TEMPLATE_VERSION` (400); then `templateShapeProblems(input)`: a refusal, or any `shapeProblems`, is `ServiceError("INVALID_TEMPLATE", "The template is invalid", 400, { problems })`; then `assertTemplateSize(template)` and return it.
- `assertTemplateSize(t)`: `const bytes = utf8Length(JSON.stringify(t))`; over `TEMPLATE_MAX_BYTES` → `ServiceError("TEMPLATE_TOO_LARGE", \`The template is ${bytes} bytes of JSON; at most ${TEMPLATE_MAX_BYTES} are allowed\`, 413)`.
- `readSavedTemplate(row)`: returns `row.template`. Doc: "The one place a stored template is read for use (`jobs/create`, `schema/apply`), which re-validate it. A future template `version` 2 upgrades version 1 rows here (spec "Versioning"); M6a has nothing to upgrade."
- `service.ts`: `readonly details?: Readonly<Record<string, unknown>>` on `ServiceError` (plan Ruling 5).

- [ ] **Step 6: Run the tests, then the whole suite**

Run: the Step 2 command. Expected: PASS (6 + 1 + 1 + 1 + 1 + 1 + 16 V3 rows in `shape.test.ts`, 7 + 3 in `template-save.test.ts`, 1 in `schema-apply.test.ts`, and the moved expectations).
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. M5c's `jobs/create` problem sets are unchanged as sets; fix only order-only differences (plan Ruling 6) and name each in the commit body.

- [ ] **Step 7: Commit**

```bash
git add packages/flux-import/src/engine/shape.ts packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/plugin/schema-apply.ts packages/flux-import/src/plugin/service.ts packages/flux-import/src/plugin/templates.ts packages/flux-import/tests/fixtures/templates.ts packages/flux-import/tests/unit/shape.test.ts packages/flux-import/tests/unit/template-save.test.ts packages/flux-import/tests/unit/schema-apply.test.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/portable-text-template.test.ts packages/flux-import/tests/unit/translation-template.test.ts packages/flux-import/tests/unit/rules-template.test.ts
git commit -m "Check templates in one shape function that refuses every site-independent problem, and add the template-route version, size and name checks"
```

### Task 3: The template service: CRUD, revisions, site checks and owner warnings

**Files:**
- Modify: `packages/flux-import/src/plugin/templates.ts`, `packages/flux-import/src/plugin/service.ts` (export `linkSchemaFor`, narrow its first parameter)
- Create: `packages/flux-import/tests/unit/templates-fixture.ts`
- Test: `packages/flux-import/tests/unit/templates.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `KvCollection.compareAndDelete`, `new MemoryKv(indexes)`, `STORAGE.templates`, `STORAGE.links`; Task 2's `templateForSave`, `templateNameProblem`, `SavedTemplate`, `TemplateSummary`, `TemplateCheck`, `SavedResult`, `TRANSLATION_LOCALE_NOT_SET`; `checkTemplate`, `linkWarnings`, `translationWarnings`, `targetFieldsOf`, `usesSiteTimezone` (`template.ts`); `FieldLookup`, `LocaleResolver`, `TranslationLocaleResolver`, `Page`, `page`, `ServiceError` (`service.ts`); `kvCollection` (`emdash/storage.ts`); `LookupPort` (`engine/ports.ts`); `LinkRow` (`engine/types.ts`).
- Produces, in `src/plugin/templates.ts`:
  ```ts
  export const TEMPLATE_PAGE = 8;
  export const OWNER_QUERY_LIMIT = 100;
  export interface TemplateDeps {
  	templates: KvCollection<SavedTemplate>;
  	links: KvCollection<LinkRow>;
  	lookups: Pick<LookupPort, "taxonomyDefs">;
  	lookupFields: FieldLookup;
  	resolveLocale: LocaleResolver;
  	resolveTranslation: TranslationLocaleResolver;
  	/** The site timezone setting; read only for templates with tz: "site". */
  	siteTimezone: () => Promise<string>;
  	now: () => number;
  	newId: () => string;
  }
  /** Who already uses a template's owner in its collection and locale (spec Ruling 30). */
  export interface OwnerUse { owner: string; locale: string; templates: { id: string; name: string }[]; links: boolean }
  export interface CreateTemplateInput { name: string; description?: string | undefined; template: unknown }
  export interface UpdateTemplateInput {
  	id: string;
  	revision: number;
  	name?: string | undefined;
  	description?: string | null | undefined;
  	template?: unknown;
  }
  export function templatesCollection(storage: Record<string, StorageCollection | undefined>): KvCollection<SavedTemplate>;
  export async function siteCheck(deps: TemplateDeps, t: Template, selfId?: string): Promise<{ check: TemplateCheck; owner: OwnerUse | null }>;
  export async function assertNameFree(deps: Pick<TemplateDeps, "templates">, name: string, self?: string): Promise<void>;
  /** Writes a new row at revision 1 (create, import); `name` is already NFC and free. */
  export async function insertTemplate(deps: TemplateDeps, user: string, fields: { name: string; description?: string | undefined; template: Template }, check: TemplateCheck): Promise<SavedResult>;
  export async function listTemplates(deps: Pick<TemplateDeps, "templates">, opts: { collection?: string | undefined; cursor?: string | undefined }): Promise<Page<TemplateSummary>>;
  export async function getTemplate(deps: Pick<TemplateDeps, "templates">, id: string): Promise<SavedTemplate>;
  export async function createTemplate(deps: TemplateDeps, user: string, input: CreateTemplateInput): Promise<SavedResult>;
  export async function updateTemplate(deps: TemplateDeps, user: string, input: UpdateTemplateInput): Promise<SavedResult>;
  export async function deleteTemplate(deps: Pick<TemplateDeps, "templates">, input: { id: string; revision: number }): Promise<{ deleted: true }>;
  ```
  and in `service.ts`: `export async function linkSchemaFor(deps: { lookups: Pick<LookupPort, "taxonomyDefs"> }, template: unknown, fields: SchemaField[], lookupFields: FieldLookup, collection: string | null): Promise<LinkSchema>` (body unchanged);
- in `tests/unit/templates-fixture.ts`: `PRODUCTS`, `productTemplate(extra?)`, `templateSetup(opts?)` returning `{ deps, clock, lookups, templates, links }` (Step 1).

The owner warnings, word for word (`<locale>` per plan Ruling 8):
- `Saved template <name> (<id>) uses the same owner <owner> for <collection>/<locale>: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`
- `Owner <owner> already owns entries in <collection>/<locale>: this template will treat them as its own (and with rules.missing may trash or unpublish the ones its feed lacks)`

- [ ] **Step 1: Write the fixture and the failing tests**

Create `packages/flux-import/tests/unit/templates-fixture.ts`:
````ts
/** The template service over the fakes: a products and a posts collection, English and French. */
import { resolveSiteLocale, resolveTranslationLocale } from "../../src/emdash/locale.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { LinkRow } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import type { SavedTemplate, TemplateDeps } from "../../src/plugin/templates.js";
import { FakeContent, FakeLookups, MemoryKv } from "./fakes.js";

export const PRODUCTS: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];

export const productTemplate = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
	...extra,
});

const i18n = { defaultLocale: "en", locales: ["en", "fr"] };

export function templateSetup(opts: { collections?: Record<string, SchemaField[]> } = {}) {
	const clock = { t: Date.parse("2026-11-16T10:00:00Z") };
	const collections = opts.collections ?? { products: PRODUCTS, posts: [{ slug: "title", type: "string" }] };
	let id = 0;
	const lookups = new FakeLookups(new FakeContent());
	const templates = new MemoryKv<SavedTemplate>(STORAGE.templates.indexes);
	const links = new MemoryKv<LinkRow>(STORAGE.links.indexes);
	const deps: TemplateDeps = {
		templates,
		links,
		lookups,
		lookupFields: async (collection) => collections[collection] ?? null,
		resolveLocale: (locale) => resolveSiteLocale(locale, i18n),
		resolveTranslation: (source, locale) => resolveTranslationLocale(source, locale, i18n),
		siteTimezone: async () => "UTC",
		now: () => clock.t,
		newId: () => `T${String(++id).padStart(4, "0")}`,
	};
	return { deps, clock, lookups, templates, links };
}

/** A link row as the import writes it, with only the fields the owner query reads. */
export const ownedLink = (owner: string, locale = "en", collection = "products") =>
	({ owner, collection, locale, entryId: `e-${owner}-${locale}` }) as LinkRow;
````

Create `packages/flux-import/tests/unit/templates.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { templateSchema } from "../../src/engine/template.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	updateTemplate,
} from "../../src/plugin/templates.js";
import { ownedLink, productTemplate, templateSetup } from "./templates-fixture.js";

async function failure(p: Promise<unknown>): Promise<ServiceError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not fail");
}

const NOW = "2026-11-16T10:00:00.000Z";
const owned = (extra: Record<string, unknown> = {}) => productTemplate({ rules: { owner: "shop" }, ...extra });

describe("templates/create and templates/get", () => {
	it("saves the parsed template with its copied fields, revision 1 and the caller", async () => {
		const { deps } = templateSetup();
		const result = await createTemplate(deps, "u1", { name: "Shop feed", template: owned() });
		expect(result).toEqual({
			template: {
				id: "T0001",
				name: "Shop feed",
				template: templateSchema.parse(owned()),
				revision: 1,
				collection: "products",
				locale: "en",
				owner: "shop",
				format: "csv",
				createdAt: NOW,
				updatedAt: NOW,
				createdBy: "u1",
				updatedBy: "u1",
			},
			check: { problems: [], warnings: [] },
		});
		expect(await getTemplate(deps, "T0001")).toEqual(result.template);
		expect(await failure(getTemplate(deps, "T9999"))).toMatchObject({
			code: "NOT_FOUND",
			status: 404,
			message: "Template T9999 not found",
		});
	});

	it("keeps a description, stores none for an empty one, and copies no owner when there is none", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", description: "Nightly", template: productTemplate() });
		expect(a.template).toMatchObject({ description: "Nightly" });
		expect(a.template).not.toHaveProperty("owner");
		const b = await createTemplate(deps, "u1", { name: "B", description: "", template: productTemplate() });
		expect(b.template).not.toHaveProperty("description");
	});

	it("refuses an invalid template and writes nothing", async () => {
		const { deps, templates } = templateSetup();
		expect(
			await failure(createTemplate(deps, "u1", { name: "A", template: productTemplate({ version: 2 }) })),
		).toMatchObject({ code: "UNSUPPORTED_TEMPLATE_VERSION" });
		expect(
			await failure(createTemplate(deps, "u1", { name: "A", template: productTemplate({ key: { expr: "$now()" } }) })),
		).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(templates.rows.size).toBe(0);
	});

	it("saves templates whose collection, field, taxonomy or locale is missing, and reports each", async () => {
		const { deps, lookups } = templateSetup();
		lookups.defs.push({ name: "color", hierarchical: false, collections: ["posts"], locale: "en" });
		const save = (name: string, template: object) => createTemplate(deps, "u1", { name, template });
		expect((await save("A", productTemplate({ collection: "nope" }))).check.problems).toEqual([
			'Collection "nope" does not exist',
		]);
		const stock = { title: { from: "Name", type: "text" }, stock: { from: "Stock", type: "number" } };
		expect((await save("B", productTemplate({ fields: stock }))).check.problems).toEqual([
			'Field "stock" does not exist in collection "products"',
		]);
		expect(
			(await save("C", productTemplate({ taxonomies: { color: { from: "Color" } } }))).check.problems,
		).toEqual(['Taxonomy "color" is not attached to collection "products"']);
		const locale = await save("D", productTemplate({ locale: "xx" }));
		expect(locale.check.problems).toHaveLength(1);
		expect(locale.check.problems[0]).toMatch(/^locale: /);
		expect((await listTemplates(deps, {})).items).toHaveLength(4);
	});

	it("reports an unfillable translationOf.locale once (plan Ruling 8)", async () => {
		const { deps } = templateSetup();
		const { check } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate({ translationOf: { from: "en_id" } }),
		});
		expect(check.problems).toEqual([
			'translationOf.locale is required: locale is the default locale ("en")',
		]);
	});

	it("stores names as NFC, and a decomposed name takes the precomposed one", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "Café", template: productTemplate() });
		expect(a.template.name).toBe("Café");
		expect(
			await failure(createTemplate(deps, "u1", { name: "Café", template: productTemplate() })),
		).toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			message: 'A template named "Café" already exists',
			details: { id: a.template.id },
		});
	});
});

describe("templates/list", () => {
	it("pages 8 summaries in creation order without the template, across a delete (spec Ruling 32)", async () => {
		const { deps } = templateSetup();
		for (let i = 1; i <= 17; i++) {
			await createTemplate(deps, "u1", { name: `T${i}`, template: productTemplate() });
		}
		const first = await listTemplates(deps, {});
		expect(first.items.map((s) => s.name)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
		expect(first.items.some((s) => "template" in s)).toBe(false);
		expect(first.hasMore).toBe(true);
		await deleteTemplate(deps, { id: first.items[2]!.id, revision: 1 });
		const second = await listTemplates(deps, { cursor: first.cursor });
		expect(second.items.map((s) => s.name)).toEqual(["T9", "T10", "T11", "T12", "T13", "T14", "T15", "T16"]);
		const third = await listTemplates(deps, { cursor: second.cursor });
		expect(third.items.map((s) => s.name)).toEqual(["T17"]);
		expect(third.hasMore).toBe(false);
	});

	it("filters by collection", async () => {
		const { deps } = templateSetup();
		await createTemplate(deps, "u1", { name: "P", template: productTemplate() });
		await createTemplate(deps, "u1", {
			name: "Q",
			template: { ...productTemplate({ collection: "posts" }), fields: { title: { from: "Name", type: "text" } } },
		});
		expect((await listTemplates(deps, { collection: "posts" })).items.map((s) => s.name)).toEqual(["Q"]);
	});
});

describe("templates/update and templates/delete", () => {
	it("moves the revision, keeps createdAt and createdBy, and copies fields from the new template", async () => {
		const { deps, clock } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: owned() });
		clock.t += 60_000;
		const posts = { ...productTemplate({ collection: "posts", locale: "fr" }), fields: { title: { from: "Name", type: "text" } } };
		const { template: next, check } = await updateTemplate(deps, "u2", {
			id: row.id,
			revision: 1,
			template: posts,
		});
		expect(next).toMatchObject({
			revision: 2,
			collection: "posts",
			locale: "fr",
			createdAt: NOW,
			createdBy: "u1",
			updatedAt: "2026-11-16T10:01:00.000Z",
			updatedBy: "u2",
		});
		expect(next).not.toHaveProperty("owner");
		expect(check).toEqual({ problems: [], warnings: [] });
		expect(await getTemplate(deps, row.id)).toEqual(next);
	});

	it("renames, keeps its own name, refuses a taken one, and removes the description with null", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", description: "x", template: productTemplate() });
		const b = await createTemplate(deps, "u1", { name: "B", template: productTemplate() });
		expect((await updateTemplate(deps, "u1", { id: a.template.id, revision: 1, name: "A" })).template.revision).toBe(2);
		expect(
			await failure(updateTemplate(deps, "u1", { id: a.template.id, revision: 2, name: "B" })),
		).toMatchObject({ code: "NAME_TAKEN", details: { id: b.template.id } });
		const cleared = await updateTemplate(deps, "u1", { id: a.template.id, revision: 2, description: null });
		expect(cleared.template).not.toHaveProperty("description");
		expect((await updateTemplate(deps, "u1", { id: a.template.id, revision: 3, name: "A2" })).template.name).toBe("A2");
	});

	it("refuses a stale revision with the current one, and an invalid template, changing nothing", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: productTemplate() });
		await updateTemplate(deps, "u1", { id: row.id, revision: 1, description: "x" });
		expect(await failure(updateTemplate(deps, "u1", { id: row.id, revision: 1, name: "B" }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: `Template ${row.id} is at revision 2, not 1; read it again`,
			details: { revision: 2 },
		});
		expect(
			await failure(updateTemplate(deps, "u1", { id: row.id, revision: 2, template: { version: 1 } })),
		).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(await failure(updateTemplate(deps, "u1", { id: "T9999", revision: 1, name: "x" }))).toMatchObject({
			code: "NOT_FOUND",
		});
		expect((await getTemplate(deps, row.id)).revision).toBe(2);
	});

	it("refuses an update whose compare-and-set loses to a write after the read (spec Ruling 6)", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: productTemplate() });
		const write = templates.compareAndSet.bind(templates);
		templates.compareAndSet = async (id, expected, data) => {
			const current = await templates.get(id);
			if (current) await templates.put(id, { ...current, revision: 2, name: "Other" });
			return write(id, expected, data);
		};
		expect(await failure(updateTemplate(deps, "u2", { id: row.id, revision: 1, description: "x" }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			message: `Template ${row.id} changed while it was being saved; read it again`,
			details: { revision: 2 },
		});
		expect(await getTemplate(deps, row.id)).toMatchObject({ name: "Other" });
	});

	it("deletes at the named revision only, also when a write lands before the delete (spec Ruling 37)", async () => {
		const { deps, templates } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", template: productTemplate() });
		await updateTemplate(deps, "u1", { id: a.template.id, revision: 1, description: "x" });
		expect(await failure(deleteTemplate(deps, { id: a.template.id, revision: 1 }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			details: { revision: 2 },
		});
		const b = await createTemplate(deps, "u1", { name: "B", template: productTemplate() });
		const remove = templates.compareAndDelete.bind(templates);
		templates.compareAndDelete = async (id, expected) => {
			const current = await templates.get(id);
			if (current) await templates.put(id, { ...current, revision: 2 });
			return remove(id, expected);
		};
		expect(await failure(deleteTemplate(deps, { id: b.template.id, revision: 1 }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			message: `Template ${b.template.id} changed while it was being saved; read it again`,
		});
		templates.compareAndDelete = remove;
		expect(await deleteTemplate(deps, { id: a.template.id, revision: 2 })).toEqual({ deleted: true });
		expect(await failure(getTemplate(deps, a.template.id))).toMatchObject({ code: "NOT_FOUND" });
		expect(await failure(deleteTemplate(deps, { id: a.template.id, revision: 2 }))).toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("owner warnings (spec Rulings 7, 30, 31)", () => {
	it("warns about another saved template with the same owner, collection and locale", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", template: owned() });
		expect(a.check.warnings).toEqual([]);
		const b = await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "EN" }) });
		expect(b.check.warnings).toEqual([
			`Saved template A (${a.template.id}) uses the same owner shop for products/en: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		]);
		expect((await createTemplate(deps, "u1", { name: "C", template: owned({ locale: "fr" }) })).check.warnings).toEqual([]);
		// Updating B names A, never B itself.
		const updated = await updateTemplate(deps, "u1", { id: b.template.id, revision: 1, description: "x" });
		expect(updated.check.warnings).toHaveLength(1);
		expect(updated.check.warnings[0]).toContain(`(${a.template.id})`);
	});

	it("queries saved templates by { owner, collection } only, and links in the resolved locale", async () => {
		const { deps, templates, links } = templateSetup();
		const templateWheres: unknown[] = [];
		const linkWheres: unknown[] = [];
		const queryTemplates = templates.query.bind(templates);
		templates.query = async (opts) => {
			templateWheres.push({ where: opts.where, limit: opts.limit });
			return queryTemplates(opts);
		};
		const queryLinks = links.query.bind(links);
		links.query = async (opts) => {
			linkWheres.push({ where: opts.where, limit: opts.limit });
			return queryLinks(opts);
		};
		await createTemplate(deps, "u1", { name: "A", template: owned({ locale: "EN" }) });
		expect(templateWheres).toContainEqual({ where: { owner: "shop", collection: "products" }, limit: 100 });
		expect(linkWheres).toEqual([{ where: { owner: "shop", collection: "products", locale: "en" }, limit: 1 }]);
		linkWheres.length = 0;
		await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "xx" }) });
		expect(linkWheres).toEqual([]);
	});

	it("warns when the owner already owns entries in the resolved locale, and not in another", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		const en = await createTemplate(deps, "u1", { name: "A", template: owned({ locale: "EN" }) });
		expect(en.check.warnings).toEqual([
			"Owner shop already owns entries in products/en: this template will treat them as its own (and with rules.missing may trash or unpublish the ones its feed lacks)",
		]);
		const fr = await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "fr" }) });
		expect(fr.check.warnings).toEqual([]);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: FAIL — `createTemplate` and the other functions are not exported.

- [ ] **Step 3: Implement**

In `service.ts`, export `linkSchemaFor` with the narrowed first parameter (Interfaces); `startJob` passes `deps` as before.

In `templates.ts`:
- `templatesCollection(storage)`: as `sourcesCollection` (`src/plugin/sources.ts:97-102`), error "flux-import: the templates storage collection is missing".
- `copied(t: Template)`: `{ collection: t.collection, locale: t.locale, ...(t.rules?.owner === undefined ? {} : { owner: t.rules.owner }), format: t.source.format }`, spread into every written row (spec "Copied fields").
- `siteCheck(deps, t, selfId)` (spec "Site checks", plan Ruling 8):
  1. `const resolved = deps.resolveLocale(t.locale)`; not ok → problem `` `locale: ${resolved.message}` ``; `locale` is the resolved one or `t.locale`.
  2. With `t.translationOf`: `deps.resolveTranslation(t.translationOf.locale, locale)`; ok → the effective template's `translationOf.locale` is the result; not ok → its message is a problem.
  3. `const fields = await deps.lookupFields(t.collection)`; `null` → `` `Collection "${t.collection}" does not exist` ``; else `linkSchemaFor(deps, effective, fields, deps.lookupFields, t.collection)`, the timezone `usesSiteTimezone(t) ? await deps.siteTimezone() : "UTC"`, the problems of `checkTemplate(effective, fields, null, tz, links)` (without `TRANSLATION_LOCALE_NOT_SET` when step 2 failed), and the warnings `linkWarnings(effective, links.taxonomies ?? [])` and `translationWarnings(effective, targetFieldsOf(effective, fields))`.
  4. With `t.rules?.owner`: `OwnerUse` from `templates.query({ where: { owner, collection: t.collection }, limit: OWNER_QUERY_LIMIT })`, keeping rows whose `id !== selfId` and whose locale resolves (or, unresolvable, equals as written) to the same locale; and, only when step 1 resolved, `links.query({ where: { owner, collection, locale: resolved }, limit: 1 })`. Each template and the links add their warning (above). Without an owner, `owner: null`.
- `assertNameFree(deps, name, self)`: `templates.query({ where: { name }, limit: 2 })`; another row → `NAME_TAKEN` with `details: { id }`.
- `insertTemplate`: the row from the clock (`new Date(deps.now()).toISOString()`) and `deps.newId()`, written with `compareAndSet(id, null, row)`; not applied → `throw new Error(\`Template id ${id} already exists\`)`.
- `createTemplate`: `templateForSave(input.template)`; `name = input.name.normalize("NFC")`; `assertNameFree`; `siteCheck`; `insertTemplate`. The description is kept when non-empty (plan Ruling 13).
- `updateTemplate` (spec Ruling 6, plan Ruling 12), in this order: `templateForSave(input.template)` when given; `getVersioned(id)` (`NOT_FOUND`); a row revision other than `input.revision` → `TEMPLATE_CHANGED` "…is at revision <current>, not <given>; read it again", `details: { revision }`; a new NFC name different from the row's → `assertNameFree(…, id)`; `siteCheck(deps, template, id)`; the next row (`revision + 1`, `updatedAt`, `updatedBy`, copied fields of the effective template, description set, kept or removed); `compareAndSet(id, storageRevision, next)`; not applied → re-read and throw `TEMPLATE_CHANGED` "Template <id> changed while it was being saved; read it again" with `details: { revision }` of the re-read row, or without `details` when it is gone. No retry: the caller's revision is stale.
- `deleteTemplate`: `getVersioned` (`NOT_FOUND`), the revision check as above, `compareAndDelete(id, storageRevision)`; not applied → the same "changed while it was being saved" error.
- `listTemplates`: `templates.query({ ...(collection ? { where: { collection } } : {}), limit: TEMPLATE_PAGE, ...(cursor ? { cursor } : {}) })` through `page()`, each item without `template`.

- [ ] **Step 4: Run them to see them pass, and the whole suite**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS (17 tests).
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/templates.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/templates-fixture.ts packages/flux-import/tests/unit/templates.test.ts
git commit -m "Add the saved-template service: revisioned create, update and delete, paged listing, site checks and owner warnings"
```

### Task 4: Export and import

**Files:**
- Create: `packages/flux-import/src/plugin/template-files.ts`
- Test: `packages/flux-import/tests/unit/template-files.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's `TemplateDeps`, `getTemplate`, `siteCheck`, `assertNameFree`, `insertTemplate`, `OwnerUse`, `SavedResult`, `templateSetup`, `productTemplate`, `ownedLink`; Task 2's `templateForSave`, `assertTemplateSize`, `templateNameProblem`, `TEMPLATE_NAME_RULE`, `TEMPLATE_DESCRIPTION_MAX`; `slugify` (`template.ts`); `FLUX_IMPORT_ID`, `FLUX_IMPORT_VERSION` (`meta.ts`); `ServiceError`.
- Produces, in `src/plugin/template-files.ts`:
  ```ts
  export const TEMPLATE_FILE_FORMAT = "flux-import.template";
  export const TEMPLATE_FILE_VERSION = 1;
  export interface TemplateFile {
  	format: typeof TEMPLATE_FILE_FORMAT;
  	formatVersion: typeof TEMPLATE_FILE_VERSION;
  	exportedAt: string;
  	generator: { plugin: string; version: string };
  	name: string;
  	description?: string;
  	template: unknown;
  }
  export function templateFilename(name: string): string;
  export async function exportTemplate(deps: Pick<TemplateDeps, "templates" | "now">, id: string): Promise<{ filename: string; file: TemplateFile }>;
  export interface ImportTemplateInput { file: unknown; name?: string | undefined; owner?: string | undefined }
  export async function importTemplate(deps: TemplateDeps, user: string, input: ImportTemplateInput): Promise<SavedResult>;
  ```

The `OWNER_IN_USE` refusal, word for word: `Owner <owner> is already used in <collection>/<locale> (<uses>); this template has rules.missing, so its missing phase would treat those entries as its own. Import it with owner set to a new owner name, or to "<owner>" to keep this one`, where `<uses>` is `saved templates <id>, <id>` and/or `existing entries`, joined by ` and `; `details: { owner, templates: [ids], links }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/template-files.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { FLUX_IMPORT_VERSION } from "../../src/meta.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	exportTemplate,
	importTemplate,
	TEMPLATE_FILE_FORMAT,
	templateFilename,
} from "../../src/plugin/template-files.js";
import { createTemplate, TEMPLATE_MAX_BYTES, TEMPLATE_NAME_RULE } from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { ownedLink, productTemplate, templateSetup } from "./templates-fixture.js";

async function failure(p: Promise<unknown>): Promise<ServiceError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not fail");
}

const missing = (owner = "shop") =>
	productTemplate({ rules: { owner, missing: { action: "unpublish", maxPercent: 10 } } });
const file = (extra: Record<string, unknown> = {}) => ({
	format: TEMPLATE_FILE_FORMAT,
	formatVersion: 1,
	name: "Shop feed",
	template: productTemplate(),
	...extra,
});

describe("templates/export (spec Rulings 8, 9)", () => {
	it("holds exactly the envelope and the stored template, nothing site-specific", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "Shop feed",
			description: "Nightly",
			template: missing(),
		});
		const out = await exportTemplate(deps, row.id);
		expect(out.filename).toBe("flux-import-template-shop-feed.json");
		expect(Object.keys(out.file)).toEqual([
			"format",
			"formatVersion",
			"exportedAt",
			"generator",
			"name",
			"description",
			"template",
		]);
		expect(out.file).toEqual({
			format: "flux-import.template",
			formatVersion: 1,
			exportedAt: "2026-11-16T10:00:00.000Z",
			generator: { plugin: "flux-import", version: FLUX_IMPORT_VERSION },
			name: "Shop feed",
			description: "Nightly",
			template: row.template,
		});
		const text = JSON.stringify(out);
		for (const value of [row.id, "u1", '"revision"', "createdAt", "updatedBy"]) {
			expect(text).not.toContain(value);
		}
		const plain = await createTemplate(deps, "u1", { name: "Plain", template: productTemplate() });
		expect(Object.keys((await exportTemplate(deps, plain.template.id)).file)).not.toContain("description");
	});

	it("exports a media baseUrl as written, query string included (spec Ruling 40)", async () => {
		const { deps } = templateSetup();
		const baseUrl = "https://cdn.example.com/files/?token=abc123";
		const fields = { title: { from: "Name", type: "text" }, body: { from: "Body", type: "portableText", format: "html", baseUrl } };
		const { template: row } = await createTemplate(deps, "u1", { name: "Body", template: productTemplate({ fields }) });
		const { file: out } = await exportTemplate(deps, row.id);
		expect((out.template as { fields: { body: { baseUrl: string } } }).fields.body.baseUrl).toBe(baseUrl);
	});

	it("names the file after the slugified name, cut to 80 characters", () => {
		expect(templateFilename("Shop feed")).toBe("flux-import-template-shop-feed.json");
		expect(templateFilename("!!!")).toBe("flux-import-template-template.json");
		expect(templateFilename(`${"a".repeat(79)} b`)).toBe(`flux-import-template-${"a".repeat(79)}.json`);
	});

	it("exports a stored row that no longer parses, as stored (Review Focus 4, spec Ruling 11)", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "Old", template: productTemplate() });
		const future = { ...row.template, futureRule: true } as typeof row.template;
		await templates.put(row.id, { ...row, template: future });
		expect((await exportTemplate(deps, row.id)).file.template).toEqual(future);
		expect(await failure(exportTemplate(deps, "T9999"))).toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("templates/import", () => {
	it("round-trips an export into a new row at revision 1 by the importer", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "Shop feed", template: productTemplate() });
		const { file: exported } = await exportTemplate(deps, row.id);
		const { template: copy, check } = await importTemplate(deps, "u2", { file: exported, name: "Copy" });
		expect(copy).toMatchObject({ name: "Copy", revision: 1, createdBy: "u2", updatedBy: "u2" });
		expect(copy.id).not.toBe(row.id);
		expect(copy.template).toEqual(row.template);
		expect(check).toEqual({ problems: [], warnings: [] });
	});

	it("reads a hand-written file without generator, ignores unknown envelope keys and a __proto__ key", async () => {
		const { deps } = templateSetup();
		expect((await importTemplate(deps, "u1", { file: file({ extra: 1 }) })).template.name).toBe("Shop feed");
		const sneaky = JSON.parse(
			`{"format":"flux-import.template","formatVersion":1,"name":"Sneaky","template":${JSON.stringify(productTemplate())},"__proto__":{"template":{"version":2}}}`,
		);
		const imported = await importTemplate(deps, "u1", { file: sneaky });
		expect(imported.template.template.version).toBe(1);
		expect(Object.prototype).not.toHaveProperty("template");
	});

	it("refuses files that are not template files, with INVALID_FILE or UNSUPPORTED_FILE_VERSION", async () => {
		const { deps } = templateSetup();
		const cases: [unknown, string, string][] = [
			[null, "INVALID_FILE", "The file is not a flux-import template file"],
			[[file()], "INVALID_FILE", "The file is not a flux-import template file"],
			["{}", "INVALID_FILE", "The file is not a flux-import template file"],
			[file({ format: "other" }), "INVALID_FILE", 'The file\'s format is not "flux-import.template"'],
			[file({ formatVersion: "1" }), "INVALID_FILE", "formatVersion must be the integer 1"],
			[
				file({ formatVersion: 2, generator: { plugin: "flux-import", version: "9.9.9" } }),
				"UNSUPPORTED_FILE_VERSION",
				"This file was written by a newer flux-import (file format 2, generator 9.9.9); this site reads file format 1",
			],
			[
				file({ formatVersion: 3 }),
				"UNSUPPORTED_FILE_VERSION",
				"This file was written by a newer flux-import (file format 3, generator unknown); this site reads file format 1",
			],
			[file({ template: undefined }), "INVALID_FILE", "The file has no template"],
			[file({ description: "x".repeat(2001) }), "INVALID_FILE", "The file's description must be text of at most 2,000 characters"],
			[file({ name: 5 }), "INVALID_FILE", "The file has no name; give one with name"],
		];
		for (const [input, code, message] of cases) {
			expect(await failure(importTemplate(deps, "u1", { file: input })), JSON.stringify(input)).toMatchObject({
				code,
				status: 400,
				message,
			});
		}
	});

	it("refuses a template version, an unknown template key and a bad shape like the other template routes", async () => {
		const { deps } = templateSetup();
		expect(
			await failure(importTemplate(deps, "u1", { file: file({ template: productTemplate({ version: 2 }) }) })),
		).toMatchObject({ code: "UNSUPPORTED_TEMPLATE_VERSION" });
		const unknown = await failure(
			importTemplate(deps, "u1", { file: file({ template: productTemplate({ rules: { owner: "o", keepForever: true } }) }) }),
		);
		expect(unknown).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(unknown.details?.problems).toContain('rules: Unrecognized key: "keepForever"');
	});

	it("refuses a taken name, and imports under the name override", async () => {
		const { deps } = templateSetup();
		const first = await importTemplate(deps, "u1", { file: file() });
		expect(await failure(importTemplate(deps, "u1", { file: file() }))).toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			details: { id: first.template.id },
		});
		expect((await importTemplate(deps, "u1", { file: file(), name: "Shop feed 2" })).template.name).toBe("Shop feed 2");
	});

	it("refuses a file name that breaks the name rule, and the name override rescues it (Review Focus 5)", async () => {
		const { deps } = templateSetup();
		expect(await failure(importTemplate(deps, "u1", { file: file({ name: "Shop feed " }) }))).toMatchObject({
			code: "INVALID_FILE",
			message: `The file's name is not a valid template name (${TEMPLATE_NAME_RULE}); give one with name`,
		});
		const rescued = await importTemplate(deps, "u1", { file: file({ name: "Shop feed\t" }), name: "Shop feed" });
		expect(rescued.template.name).toBe("Shop feed");
	});
});

describe("templates/import owner checks (spec Ruling 30)", () => {
	it("refuses rules.missing whose owner already owns entries, and imports with an owner override", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		expect(await failure(importTemplate(deps, "u1", { file: file({ template: missing() }) }))).toMatchObject({
			code: "OWNER_IN_USE",
			status: 409,
			message:
				'Owner shop is already used in products/en (existing entries); this template has rules.missing, so its missing phase would treat those entries as its own. Import it with owner set to a new owner name, or to "shop" to keep this one',
			details: { owner: "shop", templates: [], links: true },
		});
		const moved = await importTemplate(deps, "u1", { file: file({ template: missing() }), owner: "shop-2" });
		expect(moved.template).toMatchObject({ owner: "shop-2", template: { rules: { owner: "shop-2" } } });
		expect(moved.check.warnings).toEqual([]);
	});

	it("refuses rules.missing whose owner another saved template uses, and keeps it when the override names it", async () => {
		const { deps } = templateSetup();
		const saved = await createTemplate(deps, "u1", { name: "Original", template: missing() });
		expect(await failure(importTemplate(deps, "u1", { file: file({ template: missing() }) }))).toMatchObject({
			code: "OWNER_IN_USE",
			details: { owner: "shop", templates: [saved.template.id], links: false },
		});
		const kept = await importTemplate(deps, "u1", { file: file({ template: missing() }), owner: "shop" });
		expect(kept.template.owner).toBe("shop");
		expect(kept.check.warnings).toHaveLength(1);
	});

	it("only warns without rules.missing, and an override adds an owner the template lacked", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		await createTemplate(deps, "u1", { name: "Original", template: productTemplate({ rules: { owner: "shop" } }) });
		const warned = await importTemplate(deps, "u1", {
			file: file({ template: productTemplate({ rules: { owner: "shop" } }) }),
		});
		expect(warned.check.warnings).toHaveLength(2);
		const added = await importTemplate(deps, "u1", { file: file(), name: "No owner", owner: "fresh" });
		expect(added.template).toMatchObject({ owner: "fresh", template: { rules: { owner: "fresh" } } });
	});

	it("checks the size again after the owner override (plan Ruling 10)", async () => {
		const { deps } = templateSetup();
		const full = paddedTemplate("products", TEMPLATE_MAX_BYTES);
		expect((await importTemplate(deps, "u1", { file: file({ template: full }) })).template.revision).toBe(1);
		expect(
			await failure(importTemplate(deps, "u1", { file: file({ template: full }), name: "Bigger", owner: "o" })),
		).toMatchObject({ code: "TEMPLATE_TOO_LARGE" });
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/template-files.test.ts`
Expected: FAIL — `src/plugin/template-files.js` does not exist.

- [ ] **Step 3: Implement `src/plugin/template-files.ts`**

- `templateFilename(name)`: `const slug = slugify(name).slice(0, 80).replace(/-+$/, "")`; `` `flux-import-template-${slug || "template"}.json` ``.
- `exportTemplate`: `getTemplate`, then the file with keys in the order of `TemplateFile` (`description` only when the row has one), `exportedAt` from `deps.now()`, `generator: { plugin: FLUX_IMPORT_ID, version: FLUX_IMPORT_VERSION }`, `template: row.template` as stored, not re-validated (spec Ruling 11).
- `importTemplate` (spec "Export file format", plan Ruling 10): read the envelope only through `own(file, key)` = `Object.hasOwn(file, key) ? file[key] : undefined`, never by spread; then, in order:
  1. not a non-array object → `INVALID_FILE` "The file is not a flux-import template file"; `format` not exactly `TEMPLATE_FILE_FORMAT` → `INVALID_FILE` (`format` message);
  2. `formatVersion`: an integer other than 1 → `UNSUPPORTED_FILE_VERSION` (generator from `own(own(file, "generator"), "version")` when a string, else `unknown`); anything but 1 → `INVALID_FILE` "formatVersion must be the integer 1";
  3. `template` `undefined` → "The file has no template"; `description` neither `undefined` nor a string of at most `TEMPLATE_DESCRIPTION_MAX` → the description message;
  4. the name: `input.name` when given; else `own(file, "name")` must be a string (else "The file has no name; …") passing `templateNameProblem` (else "The file's name is not a valid template name (…)"); then `.normalize("NFC")`;
  5. `templateForSave(template)`; with `input.owner`, `t = { ...t, rules: { ...t.rules, owner: input.owner } }` and `assertTemplateSize(t)`;
  6. `const { check, owner } = await siteCheck(deps, t)`; without `input.owner`, with `t.rules?.missing` and an `owner` with templates or links → `OWNER_IN_USE` (message and details above, `<locale>` = `owner.locale`);
  7. `assertNameFree(deps, name)`; `insertTemplate(deps, user, { name, description, template: t }, check)`.

- [ ] **Step 4: Run them to see them pass, and the whole suite**

Run: `pnpm exec vitest run tests/unit/template-files.test.ts`
Expected: PASS (15 tests).
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/template-files.ts packages/flux-import/tests/unit/template-files.test.ts
git commit -m "Export saved templates as versioned JSON files and import them as new templates, refusing an owner already in use for rules.missing"
```

### Task 5: Jobs from saved templates and the template-aware skip

**Files:**
- Create: `packages/flux-import/src/plugin/job-templates.ts`
- Modify: `packages/flux-import/src/engine/jobs.ts` (`CreateJobInput`, `createJob`), `packages/flux-import/src/engine/rollback.ts` (`createRollback`), `packages/flux-import/src/plugin/service.ts` (`listJobs`), `packages/flux-import/src/plugin/sources.ts` (`LastImport`, `ImportTemplate`, `jobFromSource`, `recordImport`)
- Test: `packages/flux-import/tests/unit/template-jobs.test.ts` (new), `packages/flux-import/tests/unit/sources.test.ts`

**Interfaces:**
- Consumes: Task 1's `Job.templateId`/`templateRevision`, `MemoryKv(indexes)`, `STORAGE.jobs`; Task 2's `SavedTemplate`, `readSavedTemplate`, `paddedTemplate`; `templateSchema`, `fingerprint` (`engine/fingerprints.ts`); `runBatch`, `transitionJob`, `createRollback`, `makeDeps`.
- Produces:
  - `CreateJobInput.savedTemplate?: { id: string; revision: number }`; `createJob` stores it as `templateId` and `templateRevision` (plan Ruling 14). `StartJobInput` carries it unchanged (it is `Omit<CreateJobInput, …>`).
  - `createRollback` copies `templateId` and `templateRevision` from the original when set (spec Ruling 41).
  - `listJobs(deps: Pick<EngineDeps, "jobs">, opts: { status?: JobStatus; templateId?: string; cursor?: string })`: `where` holds `status` and `templateId` when given, `orderBy: { createdAt: "desc" }` as today.
  - in `sources.ts`: `export type ImportTemplate = { id: string; revision: number } | { fingerprint: string };`, `LastImport.template?: ImportTemplate`, `export function sameTemplate(a: ImportTemplate | undefined, b: ImportTemplate | null): boolean`, and `jobFromSource(deps, sourceId, options: { force: boolean; dryRun: boolean; template: ImportTemplate | null }, create)`.
  - in `src/plugin/job-templates.ts`:
    ```ts
    export interface ResolvedTemplate { template: unknown; saved?: { id: string; revision: number } }
    /** jobs/create and schema/apply with a templateId: the stored template, through readSavedTemplate. */
    export async function resolveJobTemplate(
    	templates: Pick<KvCollection<SavedTemplate>, "get">,
    	id: string,
    	revision?: number,
    ): Promise<ResolvedTemplate>;
    /** The template a URL-source job records in lastImport (spec Ruling 29); null when it does not parse. */
    export async function jobTemplateRef(resolved: ResolvedTemplate): Promise<ImportTemplate | null>;
    ```
    `resolveJobTemplate` throws `TEMPLATE_NOT_FOUND` (404, "Template <id> not found") and, for a `revision` other than the row's, `TEMPLATE_CHANGED` (409, "Template <id> is at revision <current>, not <given>; read it again", `details: { revision }`). `jobTemplateRef`: `{ id, revision }` for a saved template; else `{ fingerprint: await fingerprint(parsed) }` of `templateSchema.safeParse(resolved.template)` (plan Ruling 4), or `null`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/template-jobs.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, JobError, transitionJob } from "../../src/engine/jobs.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type SchemaField, templateSchema } from "../../src/engine/template.js";
import type { Job } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { jobTemplateRef, resolveJobTemplate } from "../../src/plugin/job-templates.js";
import { listJobs, ServiceError } from "../../src/plugin/service.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { MemoryKv, makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "Name" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
};
const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];
const csv = (n: number) => {
	let out = "sku,Name,Price\n";
	for (let i = 0; i < n; i++) out += `S${i},Item ${i},${i}\n`;
	return out;
};

function savedRow(t: unknown, revision = 1, id = "TPL1"): SavedTemplate {
	const parsed = templateSchema.parse(t);
	return {
		id,
		name: "Saved",
		template: parsed,
		revision,
		collection: parsed.collection,
		locale: parsed.locale,
		format: parsed.source.format,
		createdAt: "2026-11-16T10:00:00.000Z",
		updatedAt: "2026-11-16T10:00:00.000Z",
		createdBy: "u1",
		updatedBy: "u1",
	};
}

async function failure(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (e) {
		return e;
	}
	throw new Error("did not fail");
}

async function runToEnd(deps: Parameters<typeof runBatch>[0], id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

describe("resolveJobTemplate and jobTemplateRef", () => {
	it("returns the stored template with its ID and revision, or refuses a missing or stale one", async () => {
		const templates = new MemoryKv<SavedTemplate>(STORAGE.templates.indexes);
		const row = savedRow(template, 2);
		await templates.put(row.id, row);
		expect(await resolveJobTemplate(templates, "TPL1")).toEqual({
			template: row.template,
			saved: { id: "TPL1", revision: 2 },
		});
		expect(await resolveJobTemplate(templates, "TPL1", 2)).toMatchObject({ saved: { revision: 2 } });
		expect(await failure(resolveJobTemplate(templates, "TPL1", 1))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: "Template TPL1 is at revision 2, not 1; read it again",
			details: { revision: 2 },
		});
		const missing = await failure(resolveJobTemplate(templates, "NOPE"));
		expect(missing).toBeInstanceOf(ServiceError);
		expect(missing).toMatchObject({ code: "TEMPLATE_NOT_FOUND", status: 404, message: "Template NOPE not found" });
	});

	it("references a saved template by ID and revision, an inline one by a key-order-free fingerprint (Review Focus 3)", async () => {
		expect(await jobTemplateRef({ template, saved: { id: "TPL1", revision: 3 } })).toEqual({ id: "TPL1", revision: 3 });
		const a = await jobTemplateRef({ template });
		const reordered = { fields: template.fields, key: template.key, slug: template.slug, locale: "en", collection: "products", version: 1 };
		expect(await jobTemplateRef({ template: reordered })).toEqual(a);
		expect(a).toEqual({ fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
		const changed = { ...template, fields: { ...template.fields, price: { from: "Cost", type: "number" } } };
		expect(await jobTemplateRef({ template: changed })).not.toEqual(a);
		// The default source block makes an explicit CSV source the same template.
		expect(await jobTemplateRef({ template: { ...template, source: { format: "csv" } } })).toEqual(a);
		expect(await jobTemplateRef({ template: { version: 2 } })).toBeNull();
	});
});

describe("jobs from saved templates (spec Rulings 2, 41)", () => {
	it("creates the same job as from the template inline, plus templateId and templateRevision", async () => {
		const inline = makeDeps().deps;
		inline.source.add("u1", csv(3));
		const fromInline = await createJob(inline, { uploadId: "u1", template, schemaFields });
		const saved = makeDeps().deps;
		saved.source.add("u1", csv(3));
		const templates = new MemoryKv<SavedTemplate>();
		await templates.put("TPL1", savedRow(template, 4));
		const resolved = await resolveJobTemplate(templates, "TPL1");
		const fromSaved = await createJob(saved, {
			uploadId: "u1",
			template: resolved.template,
			schemaFields,
			...(resolved.saved ? { savedTemplate: resolved.saved } : {}),
		});
		expect(fromSaved).toEqual({ ...fromInline, templateId: "TPL1", templateRevision: 4 });
		expect(fromInline).not.toHaveProperty("templateId");
	});

	it("keeps M5c's inline refusals: version 2 is invalid_template, and 300 KiB is accepted (spec Ruling 28)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name,Stage\nA1,Desk,live\n");
		const two = await failure(createJob(deps, { uploadId: "u1", template: { ...template, version: 2 }, schemaFields }));
		expect(two).toBeInstanceOf(JobError);
		expect(two).toMatchObject({ code: "invalid_template", message: "The template is invalid" });
		expect((two as JobError).details.some((p) => p.startsWith("version: "))).toBe(true);
		const stage: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "stage_a", type: "select", validation: { options: ["live"] } },
			{ slug: "stage_b", type: "select", validation: { options: ["live"] } },
		];
		const big = await createJob(deps, { uploadId: "u1", template: paddedTemplate("products", 300 * 1024), schemaFields: stage });
		expect(big.status).toBe("created");
	});

	it("refuses a stored row that no longer parses, with the key's path (Review Focus 4)", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const templates = new MemoryKv<SavedTemplate>();
		const row = savedRow(template);
		await templates.put(row.id, { ...row, template: { ...row.template, futureRule: true } as SavedTemplate["template"] });
		const resolved = await resolveJobTemplate(templates, row.id);
		const refused = await failure(createJob(deps, { uploadId: "u1", template: resolved.template, schemaFields }));
		expect(refused).toMatchObject({ code: "invalid_template" });
		expect((refused as JobError).details).toContain('template: Unrecognized key: "futureRule"');
	});

	it("resumes, retries and rolls back from its snapshot after the template is updated and deleted", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(6));
		const templates = new MemoryKv<SavedTemplate>();
		await templates.put("TPL1", savedRow(template, 1));
		const resolved = await resolveJobTemplate(templates, "TPL1");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: resolved.template,
			schemaFields,
			batchSize: 2,
			...(resolved.saved ? { savedTemplate: resolved.saved } : {}),
		});
		expect((await runBatch(deps, job.id, "driver")).counters.created).toBe(2);
		await transitionJob(deps, job.id, "pause");
		// The template now maps the title from Price, and then it is deleted.
		const edited = { ...template, fields: { title: { from: "Price", type: "text" }, price: { from: "Price", type: "number" } } };
		await templates.put("TPL1", savedRow(edited, 2));
		await templates.delete("TPL1");
		await transitionJob(deps, job.id, "resume");
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", templateId: "TPL1", templateRevision: 1 });
		const titles = () => [...deps.content.entries.values()].map((e) => e.data.title).sort();
		expect(titles()).toEqual(["Item 0", "Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]);
		await transitionJob(deps, job.id, "retry");
		expect((await runToEnd(deps, job.id)).status).toBe("completed");
		expect(titles()).toEqual(["Item 0", "Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]);
		const { rollback } = await createRollback(deps, { id: job.id });
		expect(rollback).toMatchObject({ kind: "rollback", templateId: "TPL1", templateRevision: 1 });
		expect((await runToEnd(deps, rollback.id)).counters.reverted).toBe(6);
	});
});

describe("jobs/list by template (spec Ruling 41)", () => {
	it("lists a template's imports and rollbacks newest first, with and without status, on indexed fields", async () => {
		const jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
		const put = (id: string, at: string, extra: Partial<Job>) =>
			jobs.put(id, { id, status: "completed", createdAt: at, ...extra } as Job);
		await put("J1", "2026-11-16T10:00:00.000Z", { templateId: "TPL1", templateRevision: 1 });
		await put("J2", "2026-11-16T10:01:00.000Z", {});
		await put("J3", "2026-11-16T10:02:00.000Z", { templateId: "TPL1", templateRevision: 1, kind: "rollback", status: "running" });
		await put("J4", "2026-11-16T10:03:00.000Z", { templateId: "TPL2", templateRevision: 1 });
		expect((await listJobs({ jobs }, { templateId: "TPL1" })).items.map((j) => j.id)).toEqual(["J3", "J1"]);
		expect((await listJobs({ jobs }, { templateId: "TPL1", status: "completed" })).items.map((j) => j.id)).toEqual(["J1"]);
		expect((await listJobs({ jobs }, {})).items.map((j) => j.id)).toEqual(["J4", "J3", "J2", "J1"]);
	});
});
````

In `packages/flux-import/tests/unit/sources.test.ts`:
- in `describe("jobFromSource", …)`, replace the constants with
  ````ts
	const T = { fingerprint: "inline-T" } as const;
	const REAL = { force: false, dryRun: false, template: T };
	const DRY = { force: false, dryRun: true, template: T };
  ````
  and in "skips a real run of content already imported, and forces one" add `template: T,` to the expected `lastImport`; give the two inline option objects (`{ force: true, dryRun: false }` in that test and `{ force: false, dryRun: false }` in "clears lastFetch, lastError and lastImport …") `template: T`. In `tests/unit/xlsx-import.test.ts`, the `jobFromSource(…, { force: true, dryRun }, …)` call gains `template: null`.
- add at the end of `describe("jobFromSource", …)`:
  ````ts
	it("skips unchanged content only for the same template (spec Ruling 29)", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, etagged(() => BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { created, create } = creator();
		const run = (template: ImportTemplate | null, force = false) =>
			jobFromSource(deps, "S1", { force, dryRun: false, template }, create);
		const A = { id: "TA", revision: 1 };
		const B = { id: "TB", revision: 1 };
		expect(await run(A)).toMatchObject({ id: "J1" });
		expect(await run(B)).toMatchObject({ id: "J2" });
		expect(await run(A)).toMatchObject({ id: "J3" });
		expect(await run(A)).toMatchObject({ skipped: "unchanged" });
		expect((await getSource(deps, "S1")).lastImport).toMatchObject({ jobId: "J3", template: A });
		// The same saved template at revision 2.
		expect(await run({ id: "TA", revision: 2 })).toMatchObject({ id: "J4" });
		expect(await run({ id: "TA", revision: 2 })).toMatchObject({ skipped: "unchanged" });
		// Inline: the same fingerprint skips, another runs, and an unparsed template never skips.
		expect(await run({ fingerprint: "f1" })).toMatchObject({ id: "J5" });
		expect(await run({ fingerprint: "f1" })).toMatchObject({ skipped: "unchanged" });
		expect(await run({ fingerprint: "f2" })).toMatchObject({ id: "J6" });
		expect(await run(null)).toMatchObject({ id: "J7" });
		expect(created).toHaveLength(7);
		// force still runs; a dry run is never skipped nor recorded.
		expect(await run({ fingerprint: "f2" }, true)).toMatchObject({ id: "J8" });
	});

	it("runs once after the upgrade: a lastImport without template never matches", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, etagged(() => BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { create } = creator();
		await jobFromSource(deps, "S1", REAL, create);
		const row = await getSource(deps, "S1");
		const { template: _t, ...before } = row.lastImport as LastImport;
		await deps.sources.put("S1", { ...row, lastImport: before });
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J2" });
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ skipped: "unchanged" });
	});

	it("compares templates by kind, ID, revision and fingerprint", () => {
		expect(sameTemplate({ id: "T", revision: 1 }, { id: "T", revision: 1 })).toBe(true);
		expect(sameTemplate({ id: "T", revision: 1 }, { id: "T", revision: 2 })).toBe(false);
		expect(sameTemplate({ id: "T", revision: 1 }, { id: "U", revision: 1 })).toBe(false);
		expect(sameTemplate({ fingerprint: "f" }, { fingerprint: "f" })).toBe(true);
		expect(sameTemplate({ fingerprint: "f" }, { id: "f", revision: 1 })).toBe(false);
		expect(sameTemplate(undefined, { fingerprint: "f" })).toBe(false);
		expect(sameTemplate({ fingerprint: "f" }, null)).toBe(false);
	});
  ````
  and add `type ImportTemplate`, `type LastImport` and `sameTemplate` to the file's import from `../../src/plugin/sources.js`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/template-jobs.test.ts tests/unit/sources.test.ts tests/unit/xlsx-import.test.ts`
Expected: FAIL — `src/plugin/job-templates.js` does not exist; `sameTemplate` is not exported; a second template on unchanged content is skipped; the job and rollback lack `templateId`.

- [ ] **Step 3: Implement**

- `jobs.ts`: the `CreateJobInput` field (doc: "M6a: the saved template `template` was read from; the job records its ID and revision"), and `...(input.savedTemplate === undefined ? {} : { templateId: input.savedTemplate.id, templateRevision: input.savedTemplate.revision })` after `sourceId` in the job literal.
- `rollback.ts`: the two fields copied after `rollbackOf`, each only when the original has it.
- `service.ts` `listJobs`: the `opts` type and `where` (Interfaces); the parameter narrows to `Pick<EngineDeps, "jobs">`.
- `sources.ts`: the types and `sameTemplate` (both `id` and `revision` equal, or both fingerprints equal; `undefined` or `null` never matches). In `jobFromSource`, the skip needs `sameTemplate(source.lastImport?.template, options.template)` besides the hash; the recorded `lastImport` gains `template` when `options.template` is not `null`. Update the doc comment: "…whose content and template equal `lastImport` (spec Ruling 29)".
- `job-templates.ts`: as in Interfaces; the template comes from `readSavedTemplate(row)`.

- [ ] **Step 4: Run them to see them pass, and the whole suite**

Run: the Step 2 command. Expected: PASS (8 tests in `template-jobs.test.ts`, 3 new in `sources.test.ts`, the changed ones).
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. `routes.ts` still calls `jobFromSource` without `template` until Task 6: give it `template: null` now (never skipped, recorded without a template) so the tree typechecks, with the comment `// M6a Task 6 passes the job's template reference.`

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/job-templates.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/engine/rollback.ts packages/flux-import/src/plugin/service.ts packages/flux-import/src/plugin/sources.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/template-jobs.test.ts packages/flux-import/tests/unit/sources.test.ts packages/flux-import/tests/unit/xlsx-import.test.ts
git commit -m "Record the saved template and revision on jobs and their rollbacks, list a template's jobs, and skip unchanged URL content only for the same template"
```

### Task 6: The routes

**Files:**
- Modify: `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/definition.test.ts`, `packages/flux-import/tests/unit/template-routes.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 3-5 (`TemplateDeps`, `templatesCollection`, `listTemplates`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `exportTemplate`, `importTemplate`, `resolveJobTemplate`, `jobTemplateRef`, `templateNameProblem`, `TEMPLATE_NAME_RULE`, `TEMPLATE_DESCRIPTION_MAX`, `listJobs`); `listSchemaFields`, `resolveSiteLocale`, `resolveTranslationLocale`, `readSiteTimezone`, `OWNER_PATTERN`, `ulid`.
- Produces: the seven template routes and the changed `jobs/create`, `jobs/list` and `schema/apply` (Global Constraints), each a JSON `POST` with `permission: "import:execute"` through `route()`, so `definePlugin`'s MCP route checks accept them (spec F10, Ruling 17).

The route inputs (in `routes.ts`, `astro/zod`, no transforms):
```ts
const templateId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid template ID");
const templateName = z.string().refine((n) => templateNameProblem(n) === null, TEMPLATE_NAME_RULE);
const description = z.string().max(TEMPLATE_DESCRIPTION_MAX);
const revision = z.number().int().min(1);
const owner = z
	.string()
	.regex(OWNER_PATTERN, "An owner is 1-100 characters of A-Z, a-z, 0-9, '.', '_', ':' and '-'");
// templates/list   z.object({ collection: z.string().min(1).max(63).optional(), cursor })
// templates/get    z.object({ id: templateId })            templates/export  the same
// templates/create z.object({ name: templateName, description: description.optional(), template: z.unknown() })
// templates/update z.object({ id: templateId, revision, name: templateName.optional(),
//                    description: description.nullable().optional(), template: z.unknown().optional() })
//                    .refine((i) => i.name !== undefined || i.description !== undefined || i.template !== undefined,
//                            { message: "Change at least one of name, description and template" })
// templates/delete z.object({ id: templateId, revision })
// templates/import z.object({ file: z.unknown(), name: templateName.optional(), owner: owner.optional() })
// jobs/create      createInput with template: z.unknown().optional(), templateId: templateId.optional(),
//                    templateRevision: revision.optional(), and two more refines:
//                    exactly one of template and templateId ("Set exactly one of template and templateId"),
//                    templateRevision only with templateId ("templateRevision needs templateId")
// jobs/list        adds templateId: templateId.optional()
// schema/apply     applyInput with templateId: templateId.optional(); its refine becomes exactly one of
//                    fields, template and templateId ("Set exactly one of fields, template and templateId")
```

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/definition.test.ts`:
- add to `ROUTES`: `"templates/list"`, `"templates/get"`, `"templates/create"`, `"templates/update"`, `"templates/delete"`, `"templates/export"`, `"templates/import"`;
- add `import { definePlugin } from "emdash";` to the imports;
- add inside `describe("createPlugin", …)`:
````ts
	it("declares the M6a routes as JSON POST routes that pass definePlugin's MCP route checks (spec F10)", () => {
		const names = ROUTES.filter((r) => r.startsWith("templates/"));
		expect(names).toHaveLength(7);
		for (const name of names) {
			expect(plugin.routes[name], name).toMatchObject({ methods: ["POST"], permission: "import:execute" });
			expect(plugin.routes[name]).not.toHaveProperty("response");
		}
		const tools = (routes: string[]) =>
			Object.fromEntries(
				routes.map((route) => [route.replace(/\W/g, "_"), { description: route, route, input: z.object({}) }]),
			);
		const define = (routes: string[]) =>
			definePlugin({ id: "probe-m6a", version: "0.0.1", routes: plugin.routes, mcp: { tools: tools(routes) } });
		expect(() => define([...names, "jobs/create", "jobs/list", "schema/apply"])).not.toThrow();
		// The check bites: the raw log route can never be a tool.
		expect(() => define(["jobs/log.csv"])).toThrow("cannot reference a raw response route");
	});

	it("validates the template route inputs", () => {
		const input = (name: string) => plugin.routes[name]!.input!;
		const t = { version: 1 };
		const create = input("templates/create");
		expect(create.safeParse({ name: "Feed", template: t }).success).toBe(true);
		expect(create.safeParse({ name: "Feed", description: "x".repeat(2000), template: t }).success).toBe(true);
		expect(create.safeParse({ name: "Feed", description: "x".repeat(2001), template: t }).success).toBe(false);
		for (const name of ["", "x".repeat(101), " Feed", "Feed‍"]) {
			expect(create.safeParse({ name, template: t }).success, JSON.stringify(name)).toBe(false);
		}
		// The caller cannot set the author: unknown keys are stripped.
		expect(create.parse({ name: "Feed", template: t, createdBy: "mallory" })).not.toHaveProperty("createdBy");
		const update = input("templates/update");
		expect(update.safeParse({ id: "T1", revision: 1, description: null }).success).toBe(true);
		expect(update.safeParse({ id: "T1", revision: 1 }).success).toBe(false);
		expect(update.safeParse({ id: "T1", name: "x" }).success).toBe(false);
		expect(update.safeParse({ id: "T1", revision: 0, name: "x" }).success).toBe(false);
		expect(input("templates/delete").safeParse({ id: "T1" }).success).toBe(false);
		expect(input("templates/delete").safeParse({ id: "T1", revision: 2 }).success).toBe(true);
		expect(input("templates/get").safeParse({ id: "a/b" }).success).toBe(false);
		const imp = input("templates/import");
		expect(imp.safeParse({ file: {}, owner: "shop-2" }).success).toBe(true);
		expect(imp.safeParse({ file: {}, owner: "shop feed" }).success).toBe(false);
		expect(imp.safeParse({ file: {}, name: "Feed " }).success).toBe(false);
		expect(input("templates/list").safeParse({ collection: "products" }).success).toBe(true);
	});

	it("takes exactly one of template and templateId in jobs/create, and of fields, template and templateId in schema/apply", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const base = { uploadId: UPLOAD_ID, dryRun: false };
		expect(create.safeParse({ ...base, templateId: "01JZTPL" }).success).toBe(true);
		expect(create.safeParse({ ...base, templateId: "01JZTPL", templateRevision: 3 }).success).toBe(true);
		expect(create.safeParse({ ...base }).success).toBe(false);
		expect(create.safeParse({ ...base, template: {}, templateId: "01JZTPL" }).success).toBe(false);
		expect(create.safeParse({ ...base, template: {}, templateRevision: 3 }).success).toBe(false);
		const apply = plugin.routes["schema/apply"]!.input!;
		expect(apply.safeParse({ templateId: "01JZTPL", collection: "products" }).success).toBe(true);
		expect(apply.safeParse({ templateId: "01JZTPL", template: {} }).success).toBe(false);
		expect(apply.safeParse({}).success).toBe(false);
		expect(plugin.routes["jobs/list"]!.input!.safeParse({ templateId: "01JZTPL", status: "completed" }).success).toBe(true);
	});
````

Create `packages/flux-import/tests/unit/template-routes.test.ts` (the `tests/unit/rollback-route.test.ts` pattern):
````ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import type { SavedResult, SavedTemplate } from "../../src/plugin/templates.js";
import { MemoryKv, makeDeps } from "./fakes.js";

const state = vi.hoisted(() => ({ deps: undefined as unknown }));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({
			storage: new (await import("./fakes.js")).FakeStorage(),
			config: { maxUploadSize: 1000 },
			db: {},
			schemaRegistry: {
				getCollectionWithFields: async (slug: string) =>
					slug === "products" ? { fields: [{ slug: "title", type: "string" }], supports: [] } : null,
			},
		}),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));

const plugin = createPlugin();
let templates: MemoryKv<SavedTemplate>;

function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
	const route = plugin.routes[name]!;
	return route.handler({
		input: route.input!.parse(input),
		user: { id: "admin", role: 50 },
		storage: { templates, sources: new MemoryKv() },
		settings: { get: async () => undefined },
		taxonomies: { getAll: async () => [] },
		bylines: {},
	} as never) as Promise<T>;
}

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};

describe("template routes (M6a)", () => {
	beforeEach(() => {
		state.deps = makeDeps().deps;
		templates = new MemoryKv<SavedTemplate>();
	});

	it("creates as the caller, never as a body field, and returns the check", async () => {
		const created = await call<SavedResult>("templates/create", { name: "Feed", template, createdBy: "mallory" });
		expect(created.template).toMatchObject({ createdBy: "admin", updatedBy: "admin", revision: 1 });
		expect(created.check).toEqual({ problems: [], warnings: [] });
		const missing = await call<SavedResult>("templates/create", {
			name: "Elsewhere",
			template: { ...template, collection: "nope" },
		});
		expect(missing.check.problems).toEqual(['Collection "nope" does not exist']);
	});

	it("maps a stale revision to a 409 route error with the current revision", async () => {
		const { template: row } = await call<SavedResult>("templates/create", { name: "Feed", template });
		await call("templates/update", { id: row.id, revision: 1, description: "x" });
		await expect(call("templates/delete", { id: row.id, revision: 1 })).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "TEMPLATE_CHANGED",
			status: 409,
			details: { revision: 2 },
		});
	});

	it("exports, imports and lists", async () => {
		const { template: row } = await call<SavedResult>("templates/create", { name: "Shop feed", template });
		const out = await call<{ filename: string; file: unknown }>("templates/export", { id: row.id });
		expect(out.filename).toBe("flux-import-template-shop-feed.json");
		await call("templates/import", { file: out.file, name: "Copy" });
		const page = await call<{ items: { name: string }[] }>("templates/list", {});
		expect(page.items.map((i) => i.name)).toEqual(["Shop feed", "Copy"]);
	});

	it("applies the schema from a saved template, and refuses a collection that is not the template's", async () => {
		const { template: row } = await call<SavedResult>("templates/create", { name: "Feed", template });
		const dry = await call<{ collection: string; dryRun: boolean }>("schema/apply", { templateId: row.id, dryRun: true });
		expect(dry).toMatchObject({ collection: "products", dryRun: true });
		await expect(call("schema/apply", { templateId: row.id, collection: "other", dryRun: true })).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
			message: 'collection "other" does not match the template\'s "products"',
		});
		await expect(call("schema/apply", { templateId: "NOPE", dryRun: true })).rejects.toMatchObject({
			code: "TEMPLATE_NOT_FOUND",
			status: 404,
		});
	});

	it("lists jobs by template", async () => {
		const deps = state.deps as ReturnType<typeof makeDeps>["deps"];
		await deps.jobs.put("J1", { id: "J1", status: "completed", createdAt: "2026-11-16T10:00:00.000Z", templateId: "TPL1" } as Job);
		await deps.jobs.put("J2", { id: "J2", status: "completed", createdAt: "2026-11-16T10:01:00.000Z" } as Job);
		const listed = await call<{ items: Job[] }>("jobs/list", { templateId: "TPL1" });
		expect(listed.items.map((j) => j.id)).toEqual(["J1"]);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/template-routes.test.ts`
Expected: FAIL — the template routes do not exist; `jobs/create` without `template` parses; `jobs/list` drops `templateId`.

- [ ] **Step 3: Implement the routes**

In `routes.ts`:
- `templateDeps(ctx: RouteContext<unknown>, { deps, runtime }: Services): TemplateDeps` (plan Ruling 11): `templates: templatesCollection(ctx.storage)`, `links: deps.links`, `lookups: deps.lookups`, `lookupFields: (c) => listSchemaFields(runtime.schemaRegistry, c)`, `resolveLocale: (l) => resolveSiteLocale(l)`, `resolveTranslation: (s, l) => resolveTranslationLocale(s, l)`, `siteTimezone: () => readSiteTimezone()`, `now: Date.now`, `newId: () => ulid()`.
- the inputs above and the seven routes, each `route(input, (ctx) => withServices(ctx, (services) => …))` calling its service function with `templateDeps(ctx, services)` and `services.actor.id` as the user. Keep every input key that may be `undefined` out of the service call when absent, as the existing routes do (`exactOptionalPropertyTypes`).
- `jobs/create`: before `siteTimezone`, `const resolved = input.templateId === undefined ? { template: input.template } : await resolveJobTemplate(templatesCollection(ctx.storage), input.templateId, input.templateRevision)`; use `resolved.template` everywhere `input.template` is used now (`needsSiteTimezone`, `readPublishAtCollection`, `StartJobInput.template`, `fetchLimitsFor`); put `...(resolved.saved ? { savedTemplate: resolved.saved } : {})` into `StartJobInput`; for `sourceId`, `template: await jobTemplateRef(resolved)` in `jobFromSource`'s options (replacing Task 5's `null`).
- `jobs/list`: pass `templateId` through to `listJobs`.
- `schema/apply`: with `templateId`, `const { templateId: id, ...rest } = ctx.input` and `applySchema(runtime.schemaRegistry, { ...rest, template: (await resolveJobTemplate(templatesCollection(ctx.storage), id)).template })`; otherwise as today. `applySchema` still checks a given `collection` against the template's (spec "Jobs from saved templates").

- [ ] **Step 4: Run them to see them pass, and the whole suite**

Run: `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/template-routes.test.ts`
Expected: PASS (3 new in `definition.test.ts` plus the changed `ROUTES` list; 5 in `template-routes.test.ts`). If the dry `schema/apply` needs more of the schema registry than the mock offers, extend the mock (`getCollectionWithFields` is what `applySchema` reads, `src/plugin/schema-apply.ts:293-340`), not the route.
Run (repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, `rollback-route.test.ts` included (it never builds `templateDeps`).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/template-routes.test.ts
git commit -m "Add the template routes and take a templateId in jobs/create, jobs/list and schema/apply"
```

### Task 7: Node integration (`sites/dev`)

**Files:**
- Create: `packages/flux-import/tests/integration/templates.test.ts`

**Interfaces:**
- Consumes: Task 6's routes; `startServer`, `stopServer`, `Client`, `ApiError`, `devBypass`, `FeedServer`, `withDb`, `productsCsv`, `template` (integration helpers); `paddedTemplate` (Task 2); `TEMPLATE_MAX_BYTES`, `SavedResult`, `TemplateSummary`; `TemplateFile` (Task 4); `ApplyResult`.
- Produces: the Node proof of the spec's integration list (spec "Testing"), and V2 on SQLite through the plugin's own routes.

- [ ] **Step 1: Write the tests**

Create `packages/flux-import/tests/integration/templates.test.ts`:
````ts
/**
 * M6a on Node (spec "Testing", integration): saved templates through the plugin routes on SQLite,
 * jobs and URL sources from them, export and import, and the jobs index. Its own server on the
 * M5a-M5c suites' port (they run one at a time), with private-network feeds allowed.
 */
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { TemplateFile } from "../../src/plugin/template-files.js";
import { type SavedResult, TEMPLATE_MAX_BYTES, type TemplateSummary } from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
const feeds = new FeedServer();
let server: DevServer;
let client: Client;

type Skipped = { skipped: "unchanged"; sourceId: string; uploadId: string };
const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);
const owned = (collection: string, missing?: object, owner = "shop") => ({
	...template(collection),
	rules: { owner, ...(missing ? { missing } : {}) },
});

async function save(name: string, body: object): Promise<SavedResult> {
	return client.plugin<SavedResult>("templates/create", { name, template: body });
}

async function importById(templateId: string, csv: string, extra: object = {}): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin<Job>("jobs/create", { uploadId, templateId, dryRun: false, ...extra });
	return client.runToEnd(job.id);
}

beforeAll(async () => {
	await feeds.start();
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}, 180_000);

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

describe("M6a saved templates on Node", () => {
	it("creates, reads, lists, updates and deletes a template with revisions", async () => {
		await client.createProducts("it_m6a_crud");
		const created = await save("Nightly feed", template("it_m6a_crud"));
		expect(created.check).toEqual({ problems: [], warnings: [] });
		expect(created.template).toMatchObject({ revision: 1, collection: "it_m6a_crud", locale: "en", format: "csv" });
		const { id } = created.template;
		expect(await client.plugin("templates/get", { id })).toEqual(created.template);
		const listed = await client.plugin<{ items: TemplateSummary[] }>("templates/list", { collection: "it_m6a_crud" });
		expect(listed.items.map((i) => i.id)).toEqual([id]);
		expect(listed.items[0]).not.toHaveProperty("template");
		const updated = await client.plugin<SavedResult>("templates/update", { id, revision: 1, description: "Every night" });
		expect(updated.template).toMatchObject({ revision: 2, description: "Every night" });
		const stale = await failure(client.plugin("templates/update", { id, revision: 1, name: "Other" }));
		expect(stale).toBeInstanceOf(ApiError);
		expect(stale).toMatchObject({ status: 409, code: "TEMPLATE_CHANGED" });
		expect(await failure(save("Nightly feed", template("it_m6a_crud")))).toMatchObject({ status: 409, code: "NAME_TAKEN" });
		expect(await client.plugin("templates/delete", { id, revision: 2 })).toEqual({ deleted: true });
		expect(await failure(client.plugin("templates/get", { id }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
	});

	it("saves a template for a collection that does not exist yet, and reports it", async () => {
		const { check } = await save("Later", template("it_m6a_later"));
		expect(check.problems).toEqual(['Collection "it_m6a_later" does not exist']);
		await client.createProducts("it_m6a_later");
		const { items } = await client.plugin<{ items: TemplateSummary[] }>("templates/list", { collection: "it_m6a_later" });
		const again = await client.plugin<SavedResult>("templates/update", { id: items[0]!.id, revision: 1, description: "now" });
		expect(again.check.problems).toEqual([]);
	});

	it("follows a template from save through schema/apply, a paused job, export, import and delete (spec Testing)", async () => {
		const C = "it_m6a_flow";
		await client.createCollection(C);
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "released", label: "Released", type: "datetime" },
		]) {
			await client.api("POST", `/_emdash/api/schema/collections/${C}/fields`, field);
		}
		const t = owned(C, { action: "unpublish" }, "flow");
		const created = await save("Flow feed", t);
		expect(created.check.problems).toEqual([`Field "price" does not exist in collection "${C}"`]);
		const { id } = created.template;
		const applied = await client.plugin<ApplyResult>("schema/apply", { templateId: id });
		expect(applied).toMatchObject({ error: null, applied: ["price"] });
		const updated = await client.plugin<SavedResult>("templates/update", { id, revision: 1, description: "Nightly" });
		expect(updated).toMatchObject({ template: { revision: 2 }, check: { problems: [] } });

		// 10 rows in batches of 5: one batch, pause, a new revision that maps the title elsewhere, resume.
		const { uploadId } = await client.upload(productsCsv(10));
		const job = await client.plugin<Job>("jobs/create", { uploadId, templateId: id, dryRun: false, batchSize: 5 });
		expect(job).toMatchObject({ templateId: id, templateRevision: 2 });
		await client.plugin("jobs/next", { id: job.id });
		await client.plugin("jobs/pause", { id: job.id });
		const remapped = { ...t, fields: { ...t.fields, title: { from: "Handle", type: "text" } } };
		await client.plugin("templates/update", { id, revision: 2, template: remapped });
		await client.plugin("jobs/resume", { id: job.id });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", templateRevision: 2, counters: { created: 10, failed: 0 } });
		const titles = (await client.listAll(C)).map((e) => String(e.data.title));
		expect(titles).toHaveLength(10);
		expect(titles.every((title) => title.startsWith("Product "))).toBe(true);
		expect(await failure(importById(id, productsCsv(10), { templateRevision: 2 }))).toMatchObject({
			status: 409,
			code: "TEMPLATE_CHANGED",
		});

		// Export, then import under another name: the original's job owns entries, so rules.missing
		// is refused until the copy gets its own owner.
		const out = await client.plugin<{ filename: string; file: TemplateFile }>("templates/export", { id });
		expect(out.filename).toBe("flux-import-template-flow-feed.json");
		expect(JSON.stringify(out.file)).not.toContain(id);
		expect(await failure(client.plugin("templates/import", { file: out.file, name: "Flow copy" }))).toMatchObject({
			status: 409,
			code: "OWNER_IN_USE",
		});
		const copy = await client.plugin<SavedResult>("templates/import", {
			file: out.file,
			name: "Flow copy",
			owner: "flow-copy",
		});
		expect(copy.template).toMatchObject({ owner: "flow-copy", revision: 1 });
		const dryUpload = await client.upload(productsCsv(10));
		const dry = await client.plugin<Job>("jobs/create", {
			uploadId: dryUpload.uploadId,
			templateId: copy.template.id,
			dryRun: true,
		});
		expect(await client.runToEnd(dry.id)).toMatchObject({ status: "completed", dryRun: true });

		// Delete the original: its jobs keep its ID, a new job is refused, and a rollback still runs.
		expect(await client.plugin("templates/delete", { id, revision: 3 })).toEqual({ deleted: true });
		expect(await failure(importById(id, productsCsv(10)))).toMatchObject({ status: 404, code: "TEMPLATE_NOT_FOUND" });
		const rollback = await client.plugin<Job>("jobs/rollback", { id: job.id });
		expect(await client.runToEnd(rollback.id)).toMatchObject({ templateId: id, counters: { reverted: 10 } });
		const listed = await client.plugin<{ items: Job[] }>("jobs/list", { templateId: id });
		expect(listed.items.map((j) => j.id)).toEqual([rollback.id, job.id]);
	});

	it("applies the schema from a saved template, and imports a near-cap template on SQLite (V1)", async () => {
		await client.createCollection("it_m6a_big");
		const big = paddedTemplate("it_m6a_big", TEMPLATE_MAX_BYTES);
		const { template: row } = await save("Big", big);
		const applied = await client.plugin<ApplyResult>("schema/apply", { templateId: row.id });
		expect(applied.error).toBeNull();
		expect(applied.applied).toEqual(["title", "stage_a", "stage_b"]);
		const job = await importById(row.id, "sku,Name,Stage\nA1,Desk,live\nA2,Chair,live\n");
		expect(job).toMatchObject({ status: "completed", counters: { created: 2, failed: 0 } });
		expect(await failure(save("Bigger", paddedTemplate("it_m6a_big", TEMPLATE_MAX_BYTES + 1)))).toMatchObject({
			status: 413,
			code: "TEMPLATE_TOO_LARGE",
		});
	});

	it("skips unchanged URL content only for the same template (spec Ruling 29)", async () => {
		await client.createProducts("it_m6a_url");
		feeds.feeds.set("/m6a.csv", { body: productsCsv(4), etag: true });
		const source = await client.plugin<SourceRow>("sources/create", { name: "M6a feed", url: feeds.url("/m6a.csv") });
		const a = await save("Feed A", template("it_m6a_url"));
		const b = await save("Feed B", { ...template("it_m6a_url"), fields: { title: { from: "Name", type: "text" } } });
		const run = (templateId: string) =>
			client.plugin<Job | Skipped>("jobs/create", { sourceId: source.id, templateId, dryRun: false });
		const first = await run(a.template.id);
		if ("skipped" in first) throw new Error("expected a job");
		await client.runToEnd(first.id);
		expect(await run(a.template.id)).toMatchObject({ skipped: "unchanged" });
		const other = await run(b.template.id);
		expect(other).not.toHaveProperty("skipped");
		if (!("skipped" in other)) await client.runToEnd(other.id);
		const inline = await client.plugin<Job | Skipped>("jobs/create", {
			sourceId: source.id,
			template: template("it_m6a_url"),
			dryRun: false,
		});
		expect(inline).not.toHaveProperty("skipped");
	});

	it("creates the jobs templateId index at the next scheduler tick (V2)", async () => {
		const res = await fetch(`${server.baseUrl}/test/run-scheduled`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		expect(res.status).toBe(200);
		const names = withDb(server.dbPath, (db) =>
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ? ORDER BY name")
				.all("idx_plugin_flux-import_%")
				.map((r) => (r as { name: string }).name),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"idx_plugin_flux-import_jobs_templateId_createdAt",
				"idx_plugin_flux-import_templates_name",
				"idx_plugin_flux-import_templates_collection",
				"idx_plugin_flux-import_templates_owner",
			]),
		);
	});
});
````

- [ ] **Step 2: Run it**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/templates.test.ts`
Expected: PASS (6 tests). A failure here is a bug in Tasks 1-6 (or a fact Task 0 got wrong): fix it there with a unit test that shows it, never by loosening this file. The URL test's inline job runs because its fingerprint is not the saved templates' reference (spec Ruling 29).

- [ ] **Step 3: Run the whole Node integration suite**

Run: `pnpm test:integration`
Expected: PASS. Known flakes: F1 (`crash.test.ts` after a clock step) and F3 (port 4397); re-run the file and record it.

- [ ] **Step 4: Restore the site files and commit**

Run: `git status --short` — expected: only the new test file. If `sites/dev/emdash-env.d.ts` shows as modified, `git checkout sites/dev/emdash-env.d.ts`.
```bash
git add packages/flux-import/tests/integration/templates.test.ts
git commit -m "Prove saved templates on Node: CRUD, jobs and URL sources by templateId, export and import, and the jobs index"
```

### Task 8: workerd parity (`sites/dev-cf`)

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Task 6's routes; the parity file's `client`, `importRules`, `FeedServer` (already imported); `paddedTemplate`; `TEMPLATE_MAX_BYTES`, `SavedResult`; `ApplyResult` (already imported).
- Produces: the workerd proof (spec "Testing", parity): a near-cap template through a job on D1 (V1), `compareAndDelete` (V4), the jobs index (V2) and the template-aware skip.

- [ ] **Step 1: Write the tests**

Add the imports `import { type SavedResult, TEMPLATE_MAX_BYTES } from "../../src/plugin/templates.js";` and `import { paddedTemplate } from "../fixtures/templates.js";`, then add at the end of `describe("workerd parity (D1, R2)", …)`:
````ts
	it("saves, updates, exports, imports and deletes an M6a template on D1, at revisions (V4)", async () => {
		await client.createProducts("cf_m6a_crud");
		const created = await client.plugin<SavedResult>("templates/create", {
			name: "cf crud",
			template: template("cf_m6a_crud"),
		});
		expect(created.check).toEqual({ problems: [], warnings: [] });
		const { id } = created.template;
		await client.plugin("templates/update", { id, revision: 1, description: "x" });
		await expect(client.plugin("templates/delete", { id, revision: 1 })).rejects.toMatchObject({
			status: 409,
			code: "TEMPLATE_CHANGED",
		});
		const out = await client.plugin<{ file: unknown }>("templates/export", { id });
		const copy = await client.plugin<SavedResult>("templates/import", { file: out.file, name: "cf crud copy" });
		expect(copy.template).toMatchObject({ revision: 1, template: created.template.template });
		expect(await client.plugin("templates/delete", { id, revision: 2 })).toEqual({ deleted: true });
		await expect(client.plugin("templates/get", { id })).rejects.toMatchObject({ status: 404 });
	});

	it("imports an M6a template of 256 KiB on D1 through every job write, and refuses one byte more (V1)", async () => {
		await client.createCollection("cf_m6a_big");
		const { template: row } = await client.plugin<SavedResult>("templates/create", {
			name: "cf big",
			template: paddedTemplate("cf_m6a_big", TEMPLATE_MAX_BYTES),
		});
		const applied = await client.plugin<ApplyResult>("schema/apply", { templateId: row.id });
		expect(applied.error).toBeNull();
		let csv = "sku,Name,Stage\n";
		for (let i = 0; i < 30; i++) csv += `B${i},Item ${i},live\n`;
		const { uploadId } = await client.upload(csv);
		const created = await client.plugin<Job>("jobs/create", {
			uploadId,
			templateId: row.id,
			dryRun: false,
			batchSize: 10,
			budgetMs: 20_000,
		});
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({ status: "completed", templateId: row.id, counters: { created: 30, failed: 0 } });
		const rollback = await client.plugin<Job>("jobs/rollback", { id: done.id, budgetMs: 20_000 });
		expect(await client.runToEnd(rollback.id)).toMatchObject({ status: "completed", counters: { reverted: 30 } });
		await expect(
			client.plugin("templates/create", {
				name: "cf bigger",
				template: paddedTemplate("cf_m6a_big", TEMPLATE_MAX_BYTES + 1),
			}),
		).rejects.toMatchObject({ status: 413, code: "TEMPLATE_TOO_LARGE" });
	});

	it("lists an M6a template's jobs on D1 and skips unchanged URL content only for the same template", async () => {
		await client.createProducts("cf_m6a_url");
		const feeds = new FeedServer();
		await feeds.start();
		try {
			feeds.feeds.set("/m6a.csv", { body: productsCsv(4), etag: true });
			const source = await client.plugin<SourceRow>("sources/create", { name: "cf m6a", url: feeds.url("/m6a.csv") });
			const save = (name: string) =>
				client.plugin<SavedResult>("templates/create", { name, template: template("cf_m6a_url") });
			const [a, b] = [await save("cf url A"), await save("cf url B")];
			const run = (templateId: string) =>
				client.plugin<Job | { skipped: "unchanged" }>("jobs/create", {
					sourceId: source.id,
					templateId,
					dryRun: false,
					budgetMs: 20_000,
				});
			const first = await run(a.template.id);
			if ("skipped" in first) throw new Error("expected a job");
			await client.runToEnd(first.id);
			expect(await run(a.template.id)).toMatchObject({ skipped: "unchanged" });
			const other = await run(b.template.id);
			if ("skipped" in other) throw new Error("expected a job for another template");
			await client.runToEnd(other.id);
			const listed = await client.plugin<{ items: Job[] }>("jobs/list", { templateId: a.template.id });
			expect(listed.items.map((j) => j.id)).toEqual([first.id]);
		} finally {
			await feeds.stop();
		}
	});
````

Before writing the third test, check how the existing workerd URL-source tests reach a local feed (search the file for `FeedServer`); if they use another helper or another host, use theirs instead and keep the assertions.

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M6a"`
Expected: PASS (3 tests). If one fails with F2's one-off 500, capture the server log and re-run; a repeatable failure is a bug to fix in Tasks 1-6 with a unit test first.

- [ ] **Step 3: Restore the site files and commit**

`git status --short` — expected: only the parity file (`sites/dev-cf/emdash-env.d.ts` is ignored; `.wrangler` is the harness's).
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove saved templates on workerd: revisions, a 256 KiB template through a job on D1, and the template-aware skip"
```

### Task 9: Review run, D1 budgets and the note

**Files:**
- Create: `docs/superpowers/notes/2026-11-16-m6a-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (the M6a row)
- Temporarily: the M5a D1 counter in `src/emdash/storage.ts` (reverted before the commit)

**Interfaces:**
- Consumes: everything above; the M5a D1 counter (`docs/superpowers/plans/2026-11-03-flux-import-m5a-journal-rollback.md`, Task 9 Step 2).
- Produces: the M6a review note and the roadmap update.

- [ ] **Step 1: Run every check**

From the repo root: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf` (about 25 minutes for `test:cf`). Expected: PASS. Record each suite's file and test counts for the note, and every flake met (F1-F3) with its re-run.

- [ ] **Step 2: Measure the template routes on D1 (V5)**

Apply the M5a counter as that plan's Task 9 Step 2 does, and also sum the JSON bytes of every document the plugin storage adapter returns. Start `sites/dev-cf`, and with a temporary script under `.superpowers/wt/` (never committed) call, on a collection with two reference fields and two taxonomies (the M4b links fixture: `createLinkSchema`, `postsTemplate`), and with eight saved templates of 256 KiB (`paddedTemplate`) and one other template sharing the owner:
- `templates/list` (first page and the second), `templates/get`, `templates/export`;
- `templates/create` and `templates/import` of the posts template with `rules.owner`;
- `templates/update` with a new template; `templates/delete`;
- `jobs/create { templateId }` and `jobs/list { templateId }`;
- `schema/apply { templateId, dryRun: true }`.

Expected: every route under 50 D1 queries (Workers free plan, spec "Workers and Node") and the reads under about 2.5 MB; record the counts and bytes in the note next to the projection in Fact V5. Then revert the counter (`git checkout packages/flux-import/src/emdash/storage.ts`), restore `sites/dev-cf/.wrangler` if the script used the harness's state, and confirm `git status --short` is clean.

- [ ] **Step 3: Manual checks**

On a `sites/dev` server of its own (the integration harness's `startServer(4391)` from a scratch script under `.superpowers/wt/`, so `sites/dev/data.db` is never touched), through the plugin routes with `curl` and the dev-bypass PAT kept in an environment variable (never written to a file in the repo):
1. Create a template, export it, edit the file by hand (rename, add a trailing space to `name`), import it: the trailing space is `INVALID_FILE`, `name` rescues it (Review Focus 5).
2. Post a `templates/create` body whose template holds 50,000 nested arrays: `INVALID_TEMPLATE`, no 500, the server keeps answering (Review Focus 1).
3. Save a template, stop the server, and on a copy of the site's database (through `withDb`, `tests/integration/db.ts`) add an unknown key to the row's `template` JSON; restart on the copy and check that `templates/list`, `templates/get` and `templates/export` answer, and that `jobs/create { templateId }` answers `400 INVALID_TEMPLATE` naming the key (Review Focus 4). Delete the copy afterwards.

Restore `sites/dev/emdash-env.d.ts` if the dev server changed it.

- [ ] **Step 4: Write the review note**

Create `docs/superpowers/notes/2026-11-16-m6a-review.md` from this template:
````markdown
# M6a review: saved templates

Branch `m6a-templates`, plan `docs/superpowers/plans/2026-11-16-flux-import-m6a-templates.md`,
spec `docs/superpowers/specs/2026-11-16-flux-import-m6a-templates-design.md`.

## Checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` | |
| `pnpm test` | <files> files, <tests> tests |
| `pnpm test:integration` | <files> files, <tests> tests; flakes met: |
| `pnpm test:cf` | <tests> tests; flakes met: |

## Facts V1-V5

<Task 0's results from the plan's Facts table, one line each, and Step 2's measured route budgets:>

| Route | D1 queries | Bytes read | Projected (V5) |
| --- | --- | --- | --- |

## Review Focus

<For each of the plan's five items: the evidence (test name, manual check) and the result.>

## Manual checks

<Step 3's three checks and their results.>

## Open issues

<Anything found and not fixed, with the reason and the milestone that takes it; "None" if none.>
````

- [ ] **Step 5: Update the roadmap and commit**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, change the M6a row's status from `Planned` to `Done ([review](../notes/2026-11-16-m6a-review.md))`. Then:
```bash
git add docs/superpowers/notes/2026-11-16-m6a-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 6a review results and mark M6a done in the roadmap"
```
`git status --short` must then be empty.

## After this plan

M6a gives templates a life of their own: named and revisioned in plugin storage, refused on save when they can never run, reported on when they do not fit the site, exported and imported as versioned files with an owner check, and run by `templateId` from a snapshot each job keeps.

Next, in the roadmap's order (Milestone 6 split):
- **M6c** (MCP tools) declares tools over these routes and the job routes; Task 6's `definePlugin` check is its precondition (spec F10, Ruling 17), and route inputs stay free of transforms for it.
- **M6b** (scheduled URL imports) names a saved template by `templateId`, reads `Job.missing.verdict`, and relies on the template-aware skip (spec Ruling 29); a deleted template stops its schedule.
- **M6d** (mapping suggestions) produces a template that `templates/create` saves.
- The admin screens for templates come in M7; the template format reference, with M5c's owner text and the `baseUrl` warning, in M8.

Known gaps carried forward, all in the spec's "Open issues" or the rulings above: the name race (spec Ruling 5), stale site checks between saves, owner checks only on the template routes, whole-row owner reads, plain-text template bodies, `baseUrl` in exports, unsigned files, one extra run per URL source after the upgrade and job options not compared by the skip, dangling `templateId` on the jobs of a deleted template, and downgrade rows refused at use. A template `version` 2 upgrades rows in `readSavedTemplate` (spec "Versioning"). The M2-M5c open issues, the `package.json` version mismatch until M8 and the production Cloudflare build blocker from M2 are unchanged; production D1 limits stay unverified, so the first deploy should repeat Task 9 Step 2 against it.
