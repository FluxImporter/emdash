# Flux Import M4b: taxonomies, references and bylines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 runs first and alone; Tasks 1 and 2, and later Tasks 3, 4, 5 and 6, can run in parallel worktrees (see "Parallel execution").

**Goal:** Import an entry's links to other objects, which EmDash keeps outside the entry's own columns: taxonomy terms (by slug or label, as `parent/child` paths in hierarchical taxonomies, optionally created), reference fields bound to a relation (by entry ID, slug or the source key this importer stored), and existing bylines (by slug or exact display name). Every lookup runs before the write, so a dry run reports the same missing terms, entries and bylines a real run would hit; the diff compares what EmDash reads back, so a re-run plans `unchanged`. Templates stay `version: 1`; every addition is optional, and jobs created before M4b behave as before.

**Architecture:** Conversion stays synchronous: a new pure module `src/engine/links.ts` turns a reference field's value, each `taxonomies.<name>` value and the `bylines` value into lookup requests (texts and term paths) with the spec's limits, and `applyTemplate` puts them on `MappedRecord.links`, keeping reference fields out of `data`. A new asynchronous step, `resolveLinks` in `src/engine/resolve.ts`, runs after `applyTemplate` and before the plan: it looks every request up through a new `LookupPort` (`src/emdash/lookups.ts` over `ctx.taxonomies`, `ctx.bylines` and the runtime's content reads) with a per-batch `LookupCache`, collects every error, and only then creates missing terms (real runs, `create: true`); a dry run creates nothing and plans placeholder terms instead. At job creation `checkTemplate` checks reference targets (read once per target through `lookupFields`) and taxonomy definitions, and `createJob` stores the reference snapshot (relation side, target collection, `multiple`) in `targetFields` and a `taxonomies` snapshot (`hierarchical`). `ContentPort.get` reads reference selections (drafts included) and explicit bylines; `LookupPort.entryTerms` reads assigned terms; `planRecord` compares links by translation group (sets for taxonomies and child-side references, ordered lists otherwise). Writes go through `handleContentCreate`/`handleContentUpdate` as `taxonomies`, `references` and `bylines`; an update that changes only links leaves `data` out. The plugin declares `taxonomies:write` and `bylines:read`, and on Workers caps link-mapping jobs at 10 records per `jobs/next`.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine, `astro/zod` in routes), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-27-flux-import-m4b-taxonomies-references-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 4 split). Previous plan: `docs/superpowers/plans/2026-10-27-flux-import-m4a-scalar-fields.md`; its review: `docs/superpowers/notes/2026-10-27-m4a-review.md`.

Every code block in Tasks 1 to 9 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite, and the new workerd parity test on its own), then replayed task by task from `cc64bb4` (the spec commit; it changes only docs) by a script that applies this document's code blocks and replacements; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's Facts F1-F15 are cited as "spec F<n>".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. No new route and no new option. Two new capabilities, `taxonomies:write` and `bylines:read` (spec F14); `definePlugin` adds `taxonomies:read` itself (Fact E1).
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine's template schema uses `zod`; plugin route input schemas use `astro/zod`.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code. Terms are created only through `ctx.taxonomies.createTerm`; links are written only through the runtime's content create and update. Content stays row-per-locale: every content call passes the template's locale, except the `match: "id"` reference lookup, which the spec defines as "any locale".
- Vitest runs from `packages/flux-import` with name filters: `pnpm exec vitest run links` (from the repo root, `pnpm --filter flux-import exec vitest run tests/unit/x.test.ts` finds no files). Integration: `pnpm exec vitest run --config vitest.integration.config.ts links`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M4b links"`. The workerd harness uses port 4396 and the Node harness 4399 (plus 4395 and 4398 for the suites that start their own server): never run two copies of the same harness at once.
- Error codes, exactly: the new codes (`invalid_term_path`, `term_not_found`, `term_path_mismatch`, `ambiguous_term`, `invalid_term_slug`, `term_create_failed`, `reference_not_found`, `byline_not_found`, `ambiguous_byline`, `byline_lookup_limit`) and the new cases of `not_scalar`, `too_many_items`, `too_long`, `required` and `ambiguous_source_id` are record errors, never job errors. Template problems at job creation stay `invalid_template` (400) with one problem per field or taxonomy.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 8 also passes its integration file (about 10 s with server start) and `pnpm test:integration` (about 9 minutes), Task 9 the targeted workerd test (about 40 s); Task 10 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. A lookup that would fail must fail the record before anything is written or created, with the same verdict in a dry run: tests in Task 5 ("creates nothing when another link of the record fails", "fails missing terms without create, in a dry run too", "sees in a dry run the slug clash a real run would hit with a term it created"), Task 7 ("reports in a dry run what a real run would hit, without writing or creating", "creates nothing for a record whose lookups fail") and Task 8 ("reports missing terms, entries and bylines in a dry run…").
2. A re-run must plan `unchanged`: links compare by translation group (taxonomies and child-side references as sets, parent-side references and bylines in order), an empty value equals nothing, inferred bylines are ignored, and references read back with drafts: Task 6 ("compares taxonomies as sets…", "treats an empty value as equal to nothing…"), Task 4 ("reads reference selections with drafts only when asked…", "leaves out an inferred byline…"), Task 7 ("…re-runs unchanged") and Task 8 (CSV, JSON and `publish: false` re-runs).
3. Updates that change only links must leave `data` out (no identical draft on revisioned collections) and keep role labels; a data change sends the whole mapped `data` as in M2: Task 4 ("sends links on create and update, and leaves data out of an update without it"), Task 7 ("updates only the changed links, without data, keeping role labels", "sends the data again when a field changed, and clears a taxonomy given no value") and Task 8 ("clears a taxonomy given no value, sending only that link").
4. Term matching and creation must follow the spec exactly: slug paths from a root, one slug at any depth, labels exact then a unique case-insensitive match among siblings, row IDs as `parentId`, no slug sent in label mode, non-slugs refused in slug mode, a failed create re-read once: Task 5 ("resolveLinks: terms by slug", "…by label", "…creating terms").
5. Reference lookups must not cross the spec's lines: `id` mode refuses a slug (spec F15), `slug` mode stays in the template locale, `key` mode reads the link row then `flux_source_id`, hits are cached and misses are not, and a forward key reference fails then succeeds on retry: Task 2 ("finds an entry by exact ID in any locale, and by exact slug in the locale"), Task 5 ("resolveLinks: references"), Task 7 ("fails a forward key reference, and imports it on retry once the target exists") and Task 8.
6. Jobs and templates without links must behave exactly as before (no lookups, no `references` read, no `taxonomies` on the job, the Workers cap of 20): Task 1 ("gives null for empty links, and leaves links out of templates without them"), Task 3 ("skips the link checks it is given nothing for"), Task 7 ("leaves jobs of templates without links as before", `workersBatchCap`).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V3 are the facts the spec left unconfirmed; Task 0 re-checks them before any code is written.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | Once declared, `ctx.taxonomies` (with `createTerm`) and `ctx.bylines` are present in the native plugin's route context, on Node and on workerd. `createTerm(name, { label, parentId, locale })` with the parent's **row** ID creates a child, whose stored `parentId` is the parent's translation group (spec F5); a second `createTerm` with an existing slug throws an `Error` whose `code` is `"CONFLICT"` ("Term 'electronics' already exists in 'it_cat' (en)", `src/api/handlers/taxonomies.ts:986`). `ctx.bylines.list({ locale, limit: 100 })` returns `{ items, hasMore, cursor? }`; `getEntryTerms(collection, id)` without a locale works. | drafting probe route on `sites/dev` and on `sites/dev-cf` (both returned the two terms, the byline and the CONFLICT code); Task 0 re-checks it on Node; Tasks 8 and 9 use it |
| V2 | On a collection with revisions, `handleContentUpdate` with only `taxonomies` (or only `bylines`) and `_rev` succeeds on a published entry, stages no draft (`draftRevisionId` stays null, status `published`), and returns a `_rev` equal to a fresh `handleContentGet`'s; a stale `_rev` fails `CONFLICT` "Content has been modified since last read (version conflict)". An update with `data` plus all three links also returns the `_rev` a read gives, and publishing with it succeeds. Publishing after a taxonomy-only update (no draft) succeeds. | drafting probe on Node and workerd; Task 0; Task 8 ("clears a taxonomy given no value, sending only that link" stays `published`) |
| V3 | `handleContentGet(collection, id, locale, { includeDrafts: true })` returns the staged draft selection after a `references` update on a revisioned collection (`draftRevisionId` set), and the published selection after publish (draft null). Without `includeDrafts` the selection omits target entries that are unpublished drafts (`publishedOnly`), so the importer always reads with drafts. | drafting probe on Node and workerd; Task 0; Task 8 ("with publish: false writes terms and bylines live and stages references") |
| E1 | `definePlugin` adds `taxonomies:read` to the capabilities when `taxonomies:write` is declared (`src/plugins/types.ts:89`, implied capabilities), so the resolved list ends `…, "taxonomies:write", "bylines:read", "taxonomies:read"`. | `definition.test.ts` |
| E2 | A reference field created through `POST /_emdash/api/schema/collections/:c/fields` with `{ type: "reference", validation: { targetCollection, multiple? } }` is bound at once: `validation.relation` is `<collection>_<field>` and `relationSide` is `parent`. A single field's validation has no `multiple` key at all, so "single" means `multiple !== true`. | drafting probe on `sites/dev`; Task 8 fixture |
| E3 | Fixture endpoints (admin, Bearer PAT): `POST /_emdash/api/taxonomies { name, label, hierarchical, collections }`, `POST /_emdash/api/taxonomies/:name/terms { slug, label, locale }`, `POST /_emdash/api/admin/bylines { slug, displayName, locale }` (returns the byline with `id`). Reads: `GET /_emdash/api/taxonomies/:name/terms?locale=en`, `GET /_emdash/api/content/:c/:id/terms/:taxonomy` → `{ terms: [{ slug, … }] }`, and `GET /_emdash/api/content/:c/:id` hydrates `references` (with drafts, for admins) and `bylines` (`source: "explicit"` or inferred). | drafting runs of Tasks 8 and 9 |
| E4 | Reference read-back resolves each stored translation group to a variant, preferring the entry's locale and falling back to another (`pickVariant`, `src/api/handlers/relations.ts:380-400`, used by `resolveGroupSelection`, `:440-480`). The diff therefore compares groups, never IDs; the record log shows the ID read back. | source reading; Task 6 |
| E5 | `handleTermCreate` does not check the format of an explicit `slug` (it only checks uniqueness), and generates a unique slug from the label when none is sent (`src/api/handlers/taxonomies.ts:950-1085`). In `slug` mode the importer therefore refuses a segment that is not already a slug (`invalid_term_slug`) itself. | source reading; Task 5 |
| E6 | `ctx.bylines.list` pages newest first, at most 100 per call (`src/plugins/byline-access.ts:106-140`); the cursor of the last item continues it. | source reading; Task 2 ("pages bylines 100 at a time in the locale") |
| E7 | Publishing an entry of a routable collection needs a slug; EmDash derives one from `title`. Every integration collection in this plan maps `title` (M4a Fact E8). | M4a; Task 8 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition. Known since M3c; not caused by this plan. | M3c-M4a plans |

## Rulings this plan makes

- **Where the code lives.** `src/engine/links.ts` (limits, `LinkErrorCode`, request and resolved types, the three converters) is pure and synchronous, like M4a's `values.ts`. `src/engine/resolve.ts` holds the resolver and `LookupCache`. `src/emdash/lookups.ts` is the only code that touches `ctx.taxonomies` and `ctx.bylines`. Reference fields are `fields` mappings (`type: "reference"`); `taxonomies` and `bylines` are top-level template keys, as the spec says.
- **Conversion.** Items are trimmed, and empty items and exact duplicates are dropped during conversion, so the limits count distinct texts; duplicates that name the same object differently (an ID and its slug, a label and its case variant) are dropped after resolution by identity, the first kept. An item longer than the limit fails `too_long` (`MAX_ITEM_LENGTH` 200, `MAX_KEY_ITEM_LENGTH` 256 for `match: "key"`). An empty value into a required reference field fails `required` through M4a's `checkRules`. A hierarchical path is split only when the job's taxonomy snapshot says the taxonomy is hierarchical; without a snapshot entry a taxonomy is flat. `hierarchy` equal to `separator` is refused on the effective values (`"hierarchy must differ from separator"`), defaults included.
- **Taxonomy snapshot.** `LookupPort.taxonomyDefs` returns one definition per locale (`TaxonomyDef.locale`); the checks and the snapshot use the definition in the template's locale when there is one, else the first. A name with no definition is `Taxonomy "t" does not exist`; one whose definition does not list the collection is `Taxonomy "t" is not attached to collection "c"`. `hierarchy` on a flat taxonomy is the job warning `Taxonomy "t" is flat; its "hierarchy" separator is ignored`.
- **Schema check messages, exactly:** `Field "f" has type "t"; a reference mapping needs one of reference`; `Field "f" is a reference field without a relation; bind it first (https://docs.emdashcms.com/guides/relations/#bind-a-field-that-has-no-relation)`; `Field "f" links to collection "x", which does not exist`; `Field "f" finds entries by import key, but no entries were imported into "x"`. The target collections' fields are read once per job creation, only for mapped reference fields; taxonomy definitions only when the template maps taxonomies.
- **Resolution order.** Every lookup of the record is tried and every error collected; terms are created only when the record has no error, so a record that fails creates nothing (stricter than the spec's "before the record's plan", and what "a dry run reports what a real run hits" needs). Any `createTerm` failure (not only `CONFLICT`) reloads the taxonomy's terms and looks the segment up again; only when it is still missing does the record fail `term_create_failed` (`Could not create "seg" in "tax": <EmDash's message>`). A term created for a record that then fails to write stays, and is listed on the row's `newTerms`.
- **Dry runs.** A dry run adds placeholder terms (`planned:N` IDs, null group) to the batch cache, so a later record finds them, a slug clash a real run would hit shows up, and the plan counts the term as a change. A dry run's `match: "key"` reference to the job's own collection counts as found when an earlier record of the same dry run plans to create that key (loaded once per batch from the job's `planned` rows), as a real run would have written it by then.
- **References.** `id` mode reads `handleContentGet(target, value)` with no locale and requires the returned `id` to equal the value; `slug` mode reads in the template locale and requires the slug to equal. `key` mode reads the link row `target:locale:key`, verifies it with `content.get`, and falls back to `findBySourceId`; a link row whose entry is gone is not used. Read errors (`ContentWriteError`) fail the record with their `emdash_` code. Hits are cached per (target, match, value), misses are not.
- **Bylines.** Loaded once per batch, 100 per page, in the template locale, up to 5,000 (`MAX_BYLINE_LOOKUP`); `name` compares `displayName.trim()` with the item exactly; two bylines with that name fail `ambiguous_byline`. A miss after the limit was hit fails `byline_lookup_limit`.
- **Read-back and display.** `EntrySnapshot` gains `group` (the translation group), `references` (only when read with `{ references: true }`, which passes `includeDrafts: true`) and `bylines` (explicit credits only). Changes show terms as slug paths (`electronics/phones`), references as entry IDs and bylines as slugs. `RecordRow.newTerms` items read `taxonomy: Parent > Child` (labels).
- **Writes.** Create sends every non-empty link. Update sends only the changed links, and `data` and `slug` only when a data field or the slug changed; a byline that stays keeps its current `roleLabel`, a new one gets `null`. A links-only update on a revisioned collection stages no draft, so it sets no pending publish (Fact V2).
- **Caching and caps.** One `LookupCache` per `runBatch` call: terms per taxonomy (with the batch's created or planned ones), bylines, reference hits and the dry run's planned keys. `WORKERS_LINKED_BATCH_CAP` is 10 for templates that map any link (`usesLinks`); `runBatch`'s `maxRecords` takes a number or a function of the job.
- **`schema/apply`.** A template's reference mapping plans `conflict` (`Field "x" does not exist; create reference fields in the admin`, or `Field "x" is "string"; requested "reference"` for another type) and an existing reference field `unchanged`; `taxonomies` and `bylines` are ignored. This lands in Task 1 because it follows from the new mapping type.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (127 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 43 files / 1,101 tests pass (39 / 1,024 at `cc64bb4`) |
| Task 0 probe | on `cc64bb4`, the Step 1 probe type-checked and linted, and the probe test passed in 6.4 s: the terms `electronics` and `phones` (the child created under the root's row ID) and the byline `probe-alex` were listed (V1); the taxonomy-only update returned the `_rev` a fresh read gave, staged no draft and left the terms `["electronics"]` (V2); the references update read back as `[Sam]` with a draft, and as `[Sam]` live after publish (V3). Step 3 left a clean tree. A drafting probe of the same calls on `sites/dev-cf` passed on workerd too |
| Task-by-task replay | A clean worktree at `cc64bb4`, with Tasks 1-9 applied in order by a script that copies these code blocks and applies these replacements (each must match exactly once): every "Run them to see them fail" step failed exactly as written, and after each task `pnpm typecheck`, `pnpm lint` and `pnpm test` passed with the counts in its passing step; the result was byte-identical to the prototype (`git diff` empty) |
| Parallel branches | Task 2 replayed alone on `cc64bb4` (40 files / 1,031 tests), then Task 1 on it (41 / 1,051); Tasks 3, 4, 5 and 6 each replayed alone on that tree (41 / 1,061; 41 / 1,054; 42 / 1,073; 41 / 1,055): the same failing and passing runs, and `pnpm typecheck && pnpm lint && pnpm test` pass on each branch |
| `pnpm test:integration` | 11 files / 59 tests passed in 508 s on the prototype, which is byte-identical to the replay (was 10 files / 53 tests); `links.test.ts` alone on the replayed tree: 6 tests in 7.4 s |
| `vitest run --config vitest.cf.config.ts -t "M4b links"` | the new parity test passes on the replayed tree (1 passed, 8 skipped; 12.3 s test, 40.8 s with server start); the rest of `pnpm test:cf` was not re-run |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/links.ts` (new) | Limits, `LinkErrorCode`, `TermRequest`, `TaxonomySnapshot`, `LinkRequests`, `ResolvedItem`, `ResolvedLinks`; `linkItems`, `isSingleReference`, `referenceConverter`, `taxonomyConverter`, `bylinesConverter` |
| `src/engine/resolve.ts` (new) | `LookupCache`, `resolveLinks` (terms by slug or label, creation, placeholders; references by id, slug or key; bylines), `termPath` |
| `src/emdash/lookups.ts` (new) | `EmDashLookups`: `LookupPort` over `ctx.taxonomies`, `ctx.bylines` and `handleContentGet` |
| `src/engine/template.ts` | The `reference` mapping type, `taxonomies` and `bylines` keys; `MappedRecord.links`; link checks in `checkTemplate`; `taxonomiesOf`, `linkWarnings`, `usesLinks` |
| `src/engine/values.ts` | `TargetField` gains `relationSide`, `targetCollection`, `multiple` |
| `src/engine/ports.ts`, `src/engine/types.ts` | `LookupPort` and its types; `EntrySnapshot` links; `ContentPort` options and link writes; `Job.taxonomies`, `RecordRow.newTerms`, `EngineDeps.lookups` |
| `src/engine/diff.ts` | `CurrentLinks`, `LinkPlan`; link changes in `planRecord` |
| `src/engine/jobs.ts`, `src/engine/batch.ts` | Link checks and snapshots at job creation; resolution, link read-back and link writes per record; per-batch cache |
| `src/emdash/content.ts`, `src/emdash/schema.ts` | Reference and byline read-back, link writes, `writeError`; relation keys in `listSchemaFields` |
| `src/plugin/definition.ts`, `src/plugin/routes.ts`, `src/plugin/service.ts`, `src/plugin/schema-apply.ts` | Capabilities; `EmDashLookups` wiring; link schema at job creation and the Workers cap; reference conflicts in `schema/apply` |
| `tests/unit/fakes.ts`, `tests/fixtures/links.ts` (new), `tests/integration/{client,links.test}.ts`, `tests/integration-cf/parity.test.ts` | Fakes; Node and workerd proofs |

The source readers, `src/engine/dates.ts`, `src/engine/expressions.ts`, `src/plugin/sources.ts` and `src/plugin/xlsx.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V3 | — | nothing committed (a temporary capability change, route and test, reverted) | sonnet |
| 1. Link mappings and conversion | 0 | `src/engine/{links,template,values}.ts`, `src/plugin/schema-apply.ts`, `tests/unit/{links,schema-apply}.test.ts` | sonnet |
| 2. Lookup port | 0 | `src/engine/{ports,types}.ts`, `src/emdash/{lookups,content}.ts`, `src/plugin/{definition,routes}.ts`, `tests/unit/{lookups,definition}.test.ts`, `tests/unit/fakes.ts` | sonnet |
| 3. Schema checks and snapshots | 1 (mapping types, `TargetField` keys, `TaxonomySnapshot`), 2 (`LookupPort.taxonomyDefs`, `TaxonomyDef`, `EngineDeps.lookups`) | `src/engine/{template,jobs,types}.ts`, `src/emdash/schema.ts`, `src/plugin/service.ts`, `tests/unit/{template,schema,jobs,service}.test.ts` | sonnet |
| 4. Content port links | 2 (`EntrySnapshot.group`, `writeError`, `FakeLookups`) | `src/engine/ports.ts`, `src/emdash/content.ts`, `tests/unit/{content.test,fakes}.ts` | sonnet |
| 5. Resolver | 1 (`links.ts` types, `MappedRecord.links`), 2 (`LookupPort`, fakes) | `src/engine/resolve.ts`, `tests/unit/resolve.test.ts` | opus |
| 6. Link diff | 1 (`ResolvedLinks`, `ResolvedItem`) | `src/engine/diff.ts`, `tests/unit/diff.test.ts` | sonnet |
| 7. Batch integration | 3, 4, 5, 6 | `src/engine/{batch,resolve,template,types}.ts`, `src/plugin/service.ts`, `tests/unit/{link-import,service}.test.ts` | opus |
| 8. Node integration | 7 | `tests/fixtures/links.ts`, `tests/integration/{client,links.test}.ts` | sonnet |
| 9. workerd parity | 8 (`tests/fixtures/links.ts`) | `tests/integration-cf/parity.test.ts` | sonnet |
| 10. Review run and note | 1-9 | `docs/superpowers/notes/2026-10-27-m4b-review.md`, the roadmap | opus |

Waves: **0**, then **1 ∥ 2**, then **3 ∥ 4 ∥ 5 ∥ 6**, then **7**, then **8**, then **9** (it imports Task 8's fixture), then **10**. No two tasks of one wave touch the same file: `template.ts` is touched by Tasks 1, 3 and 7, `types.ts` by 2, 3 and 7, `ports.ts`, `content.ts` and `fakes.ts` by 2 and 4, `service.ts` by 3 and 7, `resolve.ts` by 5 and 7, always in different waves. Pass counts in each task's "Run them to see them pass" step are for the task's own test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the three unconfirmed EmDash facts (V1-V3)

**Files:**
- Temporary (never committed): `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration/probe.test.ts`

**Interfaces:**
- Consumes: `ctx.taxonomies` (`createTerm`, `getTerms`, `getEntryTerms`), `ctx.bylines.list`; `runtime.handleContentCreate`, `handleContentUpdate`, `handleContentPublish`, `handleContentGet` (with `{ includeDrafts: true }`); the integration harness.
- Produces: a yes or no for V1, V2 and V3, recorded in the Task 10 note. No code.

**Stop rule:** if any check below fails, stop, revert the probe, and report which check failed with its output. Do not start Task 1: term creation (Task 5), the M2 ownership check after link-only updates (Task 7) and the read-back diff (Tasks 4 and 6) rely on these facts.

- [ ] **Step 1: Add the probe**

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
		capabilities: ["content:read", "content:write", "content:publish", "schema:read"],
```
with:
```ts
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
		],
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
		withServices(ctx, ({ runtime }) => applySchema(runtime.schemaRegistry, ctx.input)),
	),
};
```
with:
```ts
		withServices(ctx, ({ runtime }) => applySchema(runtime.schemaRegistry, ctx.input)),
	),

	// Temporary probe for Facts V1-V3; removed in Step 4.
	"probe/m4b": route(z.object({ bylineId: z.string() }), (ctx) =>
		withServices(ctx, async ({ runtime, actor }) => {
			const tax = ctx.taxonomies;
			if (!tax?.createTerm || !ctx.bylines) return { v1: null };
			const root = await tax.createTerm("probe_cat", { label: "Electronics", locale: "en" });
			const child = await tax.createTerm("probe_cat", {
				label: "Phones",
				parentId: root.id,
				locale: "en",
			});
			const bylines = await ctx.bylines.list({ locale: "en", limit: 100 });
			const rev = (r: unknown) => (r as { data?: { _rev?: string } }).data?._rev ?? "";
			const item = (r: unknown) => (r as { data: { item: Record<string, unknown> } }).data.item;
			type Selection = Record<string, { children: { id: string }[] }>;
			const refs = (r: unknown) => {
				const selection = item(r).references as Selection | undefined;
				return (selection?.author?.children ?? []).map((c) => c.id);
			};
			const person = async (title: string) =>
				item(
					await runtime.handleContentCreate("probe_people", {
						data: { title },
						locale: "en",
						actor,
					}),
				).id as string;
			const alex = await person("Alex");
			const sam = await person("Sam");
			const created = await runtime.handleContentCreate("probe_posts", {
				data: { title: "Post" },
				locale: "en",
				actor,
				taxonomies: { probe_cat: [child.slug] },
				references: { author: [alex] },
				bylines: [{ bylineId: ctx.input.bylineId }],
			});
			const id = item(created).id as string;
			const live = await runtime.handleContentPublish("probe_posts", id, {
				_rev: rev(created),
				actor,
			});
			// V2: a taxonomy-only update on a collection with revisions.
			const tagged = await runtime.handleContentUpdate("probe_posts", id, {
				locale: "en",
				_rev: rev(live),
				actor,
				taxonomies: { probe_cat: [root.slug] },
			});
			const afterTag = await runtime.handleContentGet("probe_posts", id, "en");
			// V3: a selection staged by an update, then published.
			const staged = await runtime.handleContentUpdate("probe_posts", id, {
				locale: "en",
				_rev: rev(tagged),
				actor,
				references: { author: [sam] },
			});
			const draftRead = await runtime.handleContentGet("probe_posts", id, "en", {
				includeDrafts: true,
			});
			const published = await runtime.handleContentPublish("probe_posts", id, {
				_rev: rev(staged),
				actor,
			});
			const liveRead = await runtime.handleContentGet("probe_posts", id, "en", {
				includeDrafts: true,
			});
			return {
				v1: {
					terms: (await tax.getTerms("probe_cat", { locale: "en" })).map((t) => t.slug),
					bylines: bylines.items.map((b) => b.slug),
				},
				v2: {
					ok: tagged.success,
					rev: rev(tagged),
					read: rev(afterTag),
					draft: item(afterTag).draftRevisionId ?? null,
					terms: (await tax.getEntryTerms("probe_posts", id)).map((t) => t.slug),
				},
				v3: {
					staged: refs(draftRead),
					draft: (item(draftRead).draftRevisionId ?? null) !== null,
					published: published.success,
					live: refs(liveRead),
					people: [alex, sam],
				},
			};
		}),
	),
};
```

Create `packages/flux-import/tests/integration/probe.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));

type Probe = {
	v1: { terms: string[]; bylines: string[] } | null;
	v2: { ok: boolean; rev: string; read: string; draft: string | null; terms: string[] };
	v3: { staged: string[]; draft: boolean; published: boolean; live: string[]; people: string[] };
};

describe("M4b probe (temporary)", () => {
	it("reaches ctx.taxonomies and ctx.bylines, keeps _rev after a term update, reads staged references", async () => {
		for (const collection of ["probe_people", "probe_posts"]) {
			await client.createCollection(collection);
			await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, {
				slug: "title",
				label: "Title",
				type: "string",
			});
		}
		await client.api("POST", "/_emdash/api/schema/collections/probe_posts/fields", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: { targetCollection: "probe_people" },
		});
		await client.api("POST", "/_emdash/api/taxonomies", {
			name: "probe_cat",
			label: "Probe categories",
			hierarchical: true,
			collections: ["probe_posts"],
		});
		const byline = await client.api<{ id: string }>("POST", "/_emdash/api/admin/bylines", {
			slug: "probe-alex",
			displayName: "Alex",
			locale: "en",
		});
		const probe = await client.plugin<Probe>("probe/m4b", { bylineId: byline.id });
		expect(probe.v1).toEqual({ terms: ["electronics", "phones"], bylines: ["probe-alex"] });
		expect(probe.v2).toMatchObject({ ok: true, draft: null, terms: ["electronics"] });
		expect(probe.v2.read).toBe(probe.v2.rev);
		const [, sam] = probe.v3.people;
		expect(probe.v3).toMatchObject({ staged: [sam], draft: true, published: true, live: [sam] });
	});
});
```

- [ ] **Step 2: Run the probe**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts probe`
Expected: PASS (1 test). It shows that `ctx.taxonomies.createTerm` and `ctx.bylines` reach a native route and a child term is created under a parent's row ID (V1), that a taxonomy-only update of a published entry on a revisioned collection returns the `_rev` a fresh read gives, stages no draft and replaces the terms (V2), and that a references update is read back staged with `includeDrafts` and live after publish (V3).

- [ ] **Step 3: Remove the probe**

Run: `git checkout packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts && rm packages/flux-import/tests/integration/probe.test.ts && git status --short`
Expected: a clean tree (the integration harness restores `sites/dev/emdash-env.d.ts` itself). Record the result of Step 2 for the Task 10 note.

### Task 1: Link mappings and conversion

**Files:**
- Create: `packages/flux-import/src/engine/links.ts`
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/values.ts`, `packages/flux-import/src/plugin/schema-apply.ts`
- Test: `packages/flux-import/tests/unit/links.test.ts` (new), `packages/flux-import/tests/unit/schema-apply.test.ts`

**Interfaces:**
- Consumes: M4a `values.ts` (`TargetField`, `NOT_SCALAR_MESSAGE`, `checkRules`), `template.ts` (`compileTemplate`, `applyTemplate`, `fieldConverter`), `schema-apply.ts` (`planFields`).
- Produces:
  - `src/engine/links.ts`: `MAX_REFERENCES` (50), `MAX_TERMS` (100), `MAX_TERM_SEGMENTS` (10), `MAX_BYLINES` (50), `MAX_ITEM_LENGTH` (200), `MAX_KEY_ITEM_LENGTH` (256), `DEFAULT_SEPARATOR` (`","`), `DEFAULT_HIERARCHY` (`"/"`); `type LinkErrorCode`; `type TermRequest = { path: string[] }`; `type TaxonomySnapshot = { hierarchical: boolean }`; `type LinkRequests`; `type ResolvedItem = { group: string | null; value: string; text: string }`; `type ResolvedLinks`; `type LinkConverted<T>`; `linkItems(raw, separator)`; `isSingleReference(target)`; `referenceConverter(o, target)`, `taxonomyConverter(o, snapshot)`, `bylinesConverter(o)`.
  - `src/engine/template.ts`: the `reference` field mapping (`match: "id" | "slug" | "key"`, `separator`); `Template.taxonomies` (at most 20, names `/^[a-z][a-z0-9_]{0,62}$/`; `match: "slug" | "label"`, `separator`, `hierarchy`, `create`) and `Template.bylines` (`match: "slug" | "name"`, `separator`); `type TaxonomyMapping`, `type BylinesMapping`; `MappedRecord.links?: LinkRequests`; `CompileContext.taxonomies`; `CompiledTemplate.taxonomies`/`bylines`; link errors under the reference field, `taxonomies.<name>` and `bylines`; `templatePaths` lists the link paths; `COMPATIBLE.reference = ["reference"]`.
  - `src/engine/values.ts`: `TargetField.relationSide?`, `targetCollection?`, `multiple?`.
  - `src/plugin/schema-apply.ts`: reference mappings plan `conflict` (missing field, other type) or `unchanged`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/links.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	bylinesConverter,
	isSingleReference,
	linkItems,
	referenceConverter,
	taxonomyConverter,
} from "../../src/engine/links.js";
import {
	applyTemplate,
	type CompileContext,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
} from "../../src/engine/template.js";
import type { TargetField } from "../../src/engine/values.js";

const ok = (value: unknown) => ({ ok: true, value });
const err = (code: string) => expect.objectContaining({ ok: false, code });

const single: TargetField = { type: "reference", required: false, relationSide: "parent" };
const multiple: TargetField = { ...single, multiple: true };
const childSide: TargetField = { type: "reference", required: false, relationSide: "child" };

describe("linkItems", () => {
	it("splits text on the separator, trims, and drops empty items and exact duplicates", () => {
		expect(linkItems(" a , b,,a, ", ",")).toEqual({ ok: true, items: ["a", "b"] });
		expect(linkItems("a|b", "|")).toEqual({ ok: true, items: ["a", "b"] });
		expect(linkItems("a, b", ";")).toEqual({ ok: true, items: ["a, b"] });
		expect(linkItems(["x", " y ", null, "", 7, true, "x"], ",")).toEqual({
			ok: true,
			items: ["x", "y", "7", "true"],
		});
		expect(linkItems(42, ",")).toEqual({ ok: true, items: ["42"] });
		expect(linkItems(null, ",")).toEqual({ ok: true, items: [] });
		expect(linkItems(undefined, ",")).toEqual({ ok: true, items: [] });
	});

	it("refuses objects and nested arrays", () => {
		expect(linkItems({ a: 1 }, ",")).toEqual(err("not_scalar"));
		expect(linkItems([["a"]], ",")).toEqual(err("not_scalar"));
		expect(linkItems([{ a: 1 }], ",")).toEqual(err("not_scalar"));
	});
});

describe("referenceConverter", () => {
	it("gives the items, or null when there are none", () => {
		const convert = referenceConverter({}, multiple);
		expect(convert("01A, 01B")).toEqual(ok(["01A", "01B"]));
		expect(convert(["01A", "01B", "01A"])).toEqual(ok(["01A", "01B"]));
		expect(convert(" ")).toEqual(ok(null));
		expect(convert(null)).toEqual(ok(null));
		expect(referenceConverter({ separator: "|" }, multiple)("a,b|c")).toEqual(ok(["a,b", "c"]));
	});

	it("takes at most 50 entries, and 1 for a single field", () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `e${i}`);
		expect(referenceConverter({}, multiple)(fifty)).toEqual(ok(fifty));
		expect(referenceConverter({}, multiple)([...fifty, "e50"])).toEqual({
			ok: false,
			code: "too_many_items",
			message: "51 items; at most 50 are allowed",
		});
		expect(referenceConverter({}, single)("a")).toEqual(ok(["a"]));
		expect(referenceConverter({}, single)("a, a")).toEqual(ok(["a"]));
		expect(referenceConverter({}, single)("a, b")).toEqual({
			ok: false,
			code: "too_many_items",
			message: "2 items; at most 1 is allowed",
		});
		expect(referenceConverter({}, childSide)("a, b")).toEqual(ok(["a", "b"]));
		expect(referenceConverter({}, null)("a, b")).toEqual(ok(["a", "b"]));
	});

	it("refuses items longer than a slug or ID can be, and longer than a key for match key", () => {
		expect(referenceConverter({}, multiple)("x".repeat(200))).toEqual(ok(["x".repeat(200)]));
		expect(referenceConverter({}, multiple)("x".repeat(201))).toEqual(err("too_long"));
		expect(referenceConverter({ match: "key" }, multiple)("k".repeat(256))).toEqual(
			ok(["k".repeat(256)]),
		);
		expect(referenceConverter({ match: "key" }, multiple)("k".repeat(257))).toEqual(
			err("too_long"),
		);
	});

	it("knows single fields: the parent side without multiple", () => {
		expect(isSingleReference(single)).toBe(true);
		expect(isSingleReference(multiple)).toBe(false);
		expect(isSingleReference(childSide)).toBe(false);
		expect(isSingleReference(null)).toBe(false);
	});
});

describe("taxonomyConverter", () => {
	const tree = taxonomyConverter({}, { hierarchical: true });
	const flat = taxonomyConverter({}, { hierarchical: false });

	it("splits hierarchical items into trimmed paths", () => {
		expect(tree("Electronics / Phones, News")).toEqual(
			ok([{ path: ["Electronics", "Phones"] }, { path: ["News"] }]),
		);
		const custom = taxonomyConverter({ separator: "|", hierarchy: ">" }, { hierarchical: true });
		expect(custom("a > b | c")).toEqual(ok([{ path: ["a", "b"] }, { path: ["c"] }]));
		expect(tree(["a/b", "c"])).toEqual(ok([{ path: ["a", "b"] }, { path: ["c"] }]));
		expect(tree("")).toEqual(ok(null));
	});

	it("never splits a flat taxonomy's items", () => {
		expect(flat("AC/DC, Rock")).toEqual(ok([{ path: ["AC/DC"] }, { path: ["Rock"] }]));
		expect(taxonomyConverter({}, null)("a/b")).toEqual(ok([{ path: ["a/b"] }]));
	});

	it("refuses empty levels, more than 10 levels and levels over 200 characters", () => {
		expect(tree("a//b")).toEqual({
			ok: false,
			code: "invalid_term_path",
			message: '"a//b" has an empty level',
		});
		expect(tree("a/")).toEqual(err("invalid_term_path"));
		expect(tree("a/ /b")).toEqual(err("invalid_term_path"));
		const ten = Array.from({ length: 10 }, (_, i) => `l${i}`).join("/");
		expect(tree(ten)).toMatchObject({ ok: true });
		expect(tree(`${ten}/l10`)).toEqual({
			ok: false,
			code: "invalid_term_path",
			message: `"${ten}/l10" has 11 levels; at most 10 are allowed`,
		});
		expect(tree(`a/${"x".repeat(201)}`)).toEqual(err("invalid_term_path"));
		expect(flat("x".repeat(201))).toEqual(err("invalid_term_path"));
	});

	it("takes at most 100 terms", () => {
		const terms = Array.from({ length: 101 }, (_, i) => `t${i}`);
		expect(flat(terms.slice(0, 100))).toMatchObject({ ok: true });
		expect(flat(terms)).toEqual({
			ok: false,
			code: "too_many_items",
			message: "101 items; at most 100 are allowed",
		});
	});
});

describe("bylinesConverter", () => {
	it("gives at most 50 slugs or names", () => {
		const convert = bylinesConverter({ separator: ";" });
		expect(convert("alex; Sam Lee")).toEqual(ok(["alex", "Sam Lee"]));
		expect(convert("")).toEqual(ok(null));
		const many = Array.from({ length: 51 }, (_, i) => `b${i}`);
		expect(bylinesConverter({})(many.slice(0, 50))).toMatchObject({ ok: true });
		expect(bylinesConverter({})(many)).toEqual(err("too_many_items"));
		expect(convert({ a: 1 })).toEqual(err("not_scalar"));
	});
});

const base = {
	version: 1,
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "Title", type: "text" } },
};

describe("templateSchema for links", () => {
	it("accepts the spec template, keeping the options as written", () => {
		const t = templateSchema.parse({
			...base,
			fields: {
				title: { from: "Title", type: "text" },
				author: { from: "AuthorKey", type: "reference", match: "key" },
				related: { from: "Related", type: "reference", match: "slug", separator: "|" },
			},
			taxonomies: {
				category: {
					from: "Categories",
					match: "label",
					separator: ",",
					hierarchy: ">",
					create: true,
				},
				tag: { from: "Tags", separator: "|" },
			},
			bylines: { from: "Authors", match: "name", separator: ";" },
		});
		expect(t.fields.author).toEqual({ from: "AuthorKey", type: "reference", match: "key" });
		expect(t.taxonomies).toEqual({
			category: {
				from: "Categories",
				match: "label",
				separator: ",",
				hierarchy: ">",
				create: true,
			},
			tag: { from: "Tags", separator: "|" },
		});
		expect(t.bylines).toEqual({ from: "Authors", match: "name", separator: ";" });
		expect(templateSchema.parse(base)).not.toHaveProperty("taxonomies");
	});

	it("refuses bad link options, names and unknown keys", () => {
		const issues = (extra: Record<string, unknown>) => {
			const parsed = templateSchema.safeParse({ ...base, ...extra });
			return parsed.success
				? []
				: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		};
		expect(
			issues({ fields: { a: { from: "A", type: "reference", match: "title" } } }),
		).toHaveLength(1);
		expect(issues({ fields: { a: { from: "A", type: "reference", separator: "" } } })).toHaveLength(
			1,
		);
		expect(issues({ taxonomies: { tag: { from: "T", separator: "/" } } })).toEqual([
			"taxonomies.tag: hierarchy must differ from separator",
		]);
		expect(issues({ taxonomies: { tag: { from: "T", hierarchy: "," } } })).toEqual([
			"taxonomies.tag: hierarchy must differ from separator",
		]);
		expect(issues({ taxonomies: { tag: { from: "T", separator: "/", hierarchy: ">" } } })).toEqual(
			[],
		);
		expect(issues({ taxonomies: { Tag: { from: "T" } } })).toEqual([
			'taxonomies.Tag: Invalid taxonomy name "Tag"',
		]);
		expect(issues({ taxonomies: { tag: { from: "T", expr: "T" } } })).toEqual([
			'taxonomies.tag: Set exactly one of "from" and "expr"',
		]);
		expect(issues({ taxonomies: { tag: { from: "T", parent: "x" } } })).toHaveLength(1);
		expect(issues({ bylines: { from: "B", match: "email" } })).toHaveLength(1);
		expect(issues({ bylines: { from: "B", roleLabel: "Editor" } })).toHaveLength(1);
		const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, { from: "T" }]));
		expect(issues({ taxonomies: many })).toEqual(["taxonomies: Map at most 20 taxonomies"]);
	});
});

const linked: Template = templateSchema.parse({
	...base,
	fields: {
		title: { from: "Title", type: "text" },
		author: { from: "Author", type: "reference", match: "key" },
		related: { from: "Related", type: "reference", separator: "|" },
	},
	taxonomies: {
		category: { from: "Categories", hierarchy: ">" },
		tag: { expr: "Tags" },
	},
	bylines: { from: "Authors", separator: ";" },
});

const context: CompileContext = {
	targets: {
		title: { type: "string", required: false },
		author: { type: "reference", required: true, relationSide: "parent" },
		related: { type: "reference", required: false, relationSide: "parent", multiple: true },
	},
	taxonomies: { category: { hierarchical: true }, tag: { hierarchical: false } },
};

function compiled(t: Template = linked, c: CompileContext = context) {
	const result = compileTemplate(t, c);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

describe("applyTemplate with links", () => {
	const row = {
		id: "P1",
		Title: "Hello",
		Author: "A1",
		Related: "one|two",
		Categories: "Electronics > Phones, News",
		Tags: ["AC/DC", "Rock"],
		Authors: "alex; Sam Lee",
	};

	it("keeps reference fields out of data and puts every link into links", async () => {
		expect(await applyTemplate(compiled(), row)).toEqual({
			ok: true,
			value: {
				key: "P1",
				data: { title: "Hello" },
				links: {
					references: { author: ["A1"], related: ["one", "two"] },
					taxonomies: {
						category: [{ path: ["Electronics", "Phones"] }, { path: ["News"] }],
						tag: [{ path: ["AC/DC"] }, { path: ["Rock"] }],
					},
					bylines: ["alex", "Sam Lee"],
				},
			},
		});
	});

	it("gives null for empty links, and leaves links out of templates without them", async () => {
		const result = await applyTemplate(compiled(), {
			...row,
			Related: "",
			Categories: null,
			Tags: [],
			Authors: " ; ",
		});
		expect(result.ok && result.value.links).toEqual({
			references: { author: ["A1"], related: null },
			taxonomies: { category: null, tag: null },
			bylines: null,
		});
		const plain = templateSchema.parse(base);
		expect(await applyTemplate(compiled(plain, {}), row)).toEqual({
			ok: true,
			value: { key: "P1", data: { title: "Hello" } },
		});
	});

	it("collects link errors with their field names, alongside field errors", async () => {
		const result = await applyTemplate(compiled(), {
			...row,
			Title: { a: 1 },
			Author: "",
			Related: Array.from({ length: 51 }, (_, i) => `r${i}`),
			Categories: "a>>b",
			Tags: [["x"]],
			Authors: Array.from({ length: 51 }, (_, i) => `b${i}`),
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["title", "not_scalar"],
			["author", "required"],
			["related", "too_many_items"],
			["taxonomies.category", "invalid_term_path"],
			["taxonomies.tag", "not_scalar"],
			["bylines", "too_many_items"],
		]);
	});

	it("reads link expressions and reports their failures under the link's name", async () => {
		const t = templateSchema.parse({
			...base,
			taxonomies: { tag: { expr: "Title + 1" } },
			bylines: { expr: "Authors" },
		});
		const result = await applyTemplate(compiled(t, {}), row);
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["taxonomies.tag", "expr_error"],
		]);
		const bad = templateSchema.parse({
			...base,
			taxonomies: { tag: { expr: "(" } },
			bylines: { expr: "[" },
		});
		const problems = compileTemplate(bad);
		expect(!problems.ok && problems.problems.map((p) => p.split(":")[0])).toEqual([
			"taxonomies.tag.expr",
			"bylines.expr",
		]);
	});

	it("does not split hierarchical paths without the job's taxonomy snapshot", async () => {
		const result = await applyTemplate(compiled(linked, { targets: context.targets }), row);
		expect(result.ok && result.value.links?.taxonomies?.category).toEqual([
			{ path: ["Electronics > Phones"] },
			{ path: ["News"] },
		]);
	});

	it("lists taxonomy and bylines paths as template paths", () => {
		expect(templatePaths(linked)).toEqual([
			"id",
			"Title",
			"Author",
			"Related",
			"Categories",
			"Authors",
		]);
	});
});
```

In `packages/flux-import/tests/unit/schema-apply.test.ts`, replace
```ts
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
```
with:
```ts
	});
});

describe("template links", () => {
	it("never creates reference fields, and ignores taxonomies and bylines", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "author", type: "reference", validation: null },
			{ slug: "editor", type: "string" },
		]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "T", type: "text" },
				author: { from: "A", type: "reference" },
				editor: { from: "E", type: "reference", match: "slug" },
				related: { from: "R", type: "reference", match: "key" },
			},
			taxonomies: { category: { from: "C", create: true } },
			bylines: { from: "B" },
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{ field: "title", action: "create", type: "string" },
			{ field: "author", action: "unchanged", type: "reference" },
			{
				field: "editor",
				action: "conflict",
				type: "reference",
				message: 'Field "editor" is "string"; requested "reference"',
			},
			{
				field: "related",
				action: "conflict",
				type: "reference",
				message: 'Field "related" does not exist; create reference fields in the admin',
			},
		]);
		expect(result.applied).toEqual(["title"]);
		expect(registry.calls).toHaveLength(1);
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run links schema-apply`
Expected: FAIL — `links.test.ts` cannot load `../../src/engine/links.js` ("Cannot find module"; no tests run), and 1 of 21 tests in `schema-apply.test.ts` fails: "never creates reference fields, and ignores taxonomies and bylines" (`ServiceError: The template is invalid`; the old schema knows no `reference` type and refuses the `taxonomies` and `bylines` keys).

- [ ] **Step 3: Add the link mappings and converters**

Create `packages/flux-import/src/engine/links.ts`:
```ts
/**
 * Conversion of the M4b link mappings: reference fields, `taxonomies` and `bylines`. A converter
 * turns one source value into lookup requests (texts and term paths), not IDs; the resolver
 * (resolve.ts) looks them up before the record is planned.
 */
import { NOT_SCALAR_MESSAGE, type TargetField } from "./values.js";

/** References per field: EmDash's first page of read-back (`REFERENCE_PAGE_LIMIT`). */
export const MAX_REFERENCES = 50;
export const MAX_TERMS = 100;
export const MAX_TERM_SEGMENTS = 10;
export const MAX_BYLINES = 50;
/** The longest reference, term segment or flat term the importer looks up. */
export const MAX_ITEM_LENGTH = 200;
/** `match: "key"` items are source keys, which may be as long as a record key. */
export const MAX_KEY_ITEM_LENGTH = 256;
export const DEFAULT_SEPARATOR = ",";
export const DEFAULT_HIERARCHY = "/";

/** Errors from link conversion and resolution; all are record errors. */
export type LinkErrorCode =
	| "invalid_term_path"
	| "term_not_found"
	| "term_path_mismatch"
	| "ambiguous_term"
	| "invalid_term_slug"
	| "term_create_failed"
	| "reference_not_found"
	| "ambiguous_source_id"
	| "byline_not_found"
	| "ambiguous_byline"
	| "byline_lookup_limit";

/** One term the source names: its path from a root (one segment in a flat taxonomy). */
export type TermRequest = { path: string[] };

/** What a job knows about a mapped taxonomy (`Job.taxonomies`). */
export type TaxonomySnapshot = { hierarchical: boolean };

/** A record's converted links; `null` is an empty value, which clears the link on update. */
export type LinkRequests = {
	taxonomies?: Record<string, TermRequest[] | null>;
	references?: Record<string, string[] | null>;
	bylines?: string[] | null;
};

/** One resolved link item (resolve.ts). */
export type ResolvedItem = {
	/**
	 * What the diff compares: the translation group of the term, entry or byline; null for a
	 * term a dry run would create.
	 */
	group: string | null;
	/** What EmDash is sent: a term slug, an entry ID or a byline ID ("" for a term not created). */
	value: string;
	/** How the record shows it: a term's slug path, an entry ID or a byline slug. */
	text: string;
};

/** A record's links, resolved; an empty list clears the link. */
export type ResolvedLinks = {
	taxonomies?: Record<string, ResolvedItem[]>;
	references?: Record<string, ResolvedItem[]>;
	bylines?: ResolvedItem[];
};

export type LinkConverted<T> =
	| { ok: true; value: T[] | null }
	| {
			ok: false;
			code: "not_scalar" | "too_many_items" | "too_long" | LinkErrorCode;
			message: string;
	  };

/** A scalar as text (numbers and booleans as their string), `""` for null, null for objects. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

/**
 * The items of a link value: an array of scalars, or a scalar split on `separator` as text. Items
 * are trimmed, and empty items and exact duplicates are dropped (the first is kept).
 */
export function linkItems(
	raw: unknown,
	separator: string,
): { ok: true; items: string[] } | { ok: false; code: "not_scalar"; message: string } {
	let parts: unknown[];
	if (Array.isArray(raw)) parts = raw;
	else {
		const text = scalarText(raw);
		if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		parts = text.split(separator);
	}
	const items: string[] = [];
	for (const part of parts) {
		const text = scalarText(part);
		if (text === null) {
			return {
				ok: false,
				code: "not_scalar",
				message: "Expected a list of single values, found an object or array in it",
			};
		}
		const trimmed = text.trim();
		if (trimmed !== "" && !items.includes(trimmed)) items.push(trimmed);
	}
	return { ok: true, items };
}

const tooMany = (count: number, max: number) => ({
	ok: false as const,
	code: "too_many_items" as const,
	message: `${count} items; at most ${max} ${max === 1 ? "is" : "are"} allowed`,
});

/** Whether a reference field takes one entry: the parent side of a relation not marked multiple. */
export function isSingleReference(target: TargetField | null): boolean {
	return target !== null && target.relationSide === "parent" && target.multiple !== true;
}

/**
 * A reference value: at most 50 items, or 1 for a single field, each 1-200 characters (256 for
 * `match: "key"`). `required` is checked by `checkRules`, as for other fields.
 */
export function referenceConverter(
	o: { separator?: string | undefined; match?: "id" | "slug" | "key" | undefined },
	target: TargetField | null,
): (raw: unknown) => LinkConverted<string> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	const max = isSingleReference(target) ? 1 : MAX_REFERENCES;
	const longest = o.match === "key" ? MAX_KEY_ITEM_LENGTH : MAX_ITEM_LENGTH;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > max) return tooMany(items.length, max);
		const long = items.find((item) => item.length > longest);
		if (long !== undefined) {
			return {
				ok: false,
				code: "too_long",
				message: `"${long.slice(0, 40)}…" is longer than ${longest} characters`,
			};
		}
		return { ok: true, value: items.length === 0 ? null : items };
	};
}

/**
 * A taxonomy value: at most 100 terms. In a hierarchical taxonomy each item is a path split on
 * `hierarchy` into at most 10 trimmed segments of 1-200 characters; a flat taxonomy never splits,
 * so a tag such as `AC/DC` stays one term.
 */
export function taxonomyConverter(
	o: { separator?: string | undefined; hierarchy?: string | undefined },
	taxonomy: TaxonomySnapshot | null,
): (raw: unknown) => LinkConverted<TermRequest> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	const hierarchy = o.hierarchy ?? DEFAULT_HIERARCHY;
	const hierarchical = taxonomy?.hierarchical ?? false;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > MAX_TERMS) return tooMany(items.length, MAX_TERMS);
		const terms: TermRequest[] = [];
		for (const item of items) {
			const path = hierarchical ? item.split(hierarchy).map((s) => s.trim()) : [item];
			const problem =
				path.length > MAX_TERM_SEGMENTS
					? `has ${path.length} levels; at most ${MAX_TERM_SEGMENTS} are allowed`
					: path.some((s) => s === "")
						? "has an empty level"
						: path.some((s) => s.length > MAX_ITEM_LENGTH)
							? `has a level longer than ${MAX_ITEM_LENGTH} characters`
							: null;
			if (problem !== null) {
				return {
					ok: false,
					code: "invalid_term_path",
					message: `"${item.slice(0, 80)}" ${problem}`,
				};
			}
			terms.push({ path });
		}
		return { ok: true, value: terms.length === 0 ? null : terms };
	};
}

/** A bylines value: at most 50 slugs or names. */
export function bylinesConverter(o: {
	separator?: string | undefined;
}): (raw: unknown) => LinkConverted<string> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > MAX_BYLINES) return tooMany(items.length, MAX_BYLINES);
		return { ok: true, value: items.length === 0 ? null : items };
	};
}
```

In `packages/flux-import/src/engine/values.ts`, replace
```ts
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

export interface NumberOptions {
```
with:
```ts
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	/** Reference fields: the end of the relation this field sits on. */
	relationSide?: "parent" | "child";
	/** Reference fields: the collection the field links to. */
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
};

export interface NumberOptions {
```

In `packages/flux-import/src/engine/template.ts`, replace
```ts
} from "../sources/reader.js";
import { dateConverter } from "./dates.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";
import {
	booleanConverter,
	type ConversionCode,
```
with:
```ts
} from "../sources/reader.js";
import { dateConverter } from "./dates.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";
import {
	bylinesConverter,
	DEFAULT_HIERARCHY,
	DEFAULT_SEPARATOR,
	type LinkConverted,
	type LinkErrorCode,
	type LinkRequests,
	referenceConverter,
	type TaxonomySnapshot,
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import {
	booleanConverter,
	type ConversionCode,
```

then replace
```ts
export const SITE_TIMEZONE = "site";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

```
with:
```ts
export const SITE_TIMEZONE = "site";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** EmDash's taxonomy name rule (`createTaxonomyDefBody`, src/api/schemas/taxonomies.ts:18-31). */
const TAXONOMY_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_TAXONOMIES = 20;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

```

then replace
```ts
	)
	.min(1)
	.max(50);
const optionMap = z
	.record(z.string().min(1).max(200), z.string().min(1).max(200))
	.refine((m) => Object.keys(m).length <= 1000, { message: "map takes at most 1,000 entries" });
```
with:
```ts
	)
	.min(1)
	.max(50);
const separator = z.string().min(1).max(10);
const optionMap = z
	.record(z.string().min(1).max(200), z.string().min(1).max(200))
	.refine((m) => Object.keys(m).length <= 1000, { message: "map takes at most 1,000 entries" });
```

then replace
```ts
			type: z.literal("multiSelect"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
			separator: z.string().min(1).max(10).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
```
with:
```ts
			type: z.literal("multiSelect"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
```

then replace
```ts
		.object({ ...valueSource, type: z.literal("slug") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
const valueMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
```
with:
```ts
		.object({ ...valueSource, type: z.literal("slug") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("reference"),
			match: z.enum(["id", "slug", "key"]).optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
const valueMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

const taxonomyMapping = z
	.object({
		...valueSource,
		match: z.enum(["slug", "label"]).optional(),
		separator: separator.optional(),
		hierarchy: separator.optional(),
		create: z.boolean().optional(),
	})
	.strict()
	.refine(hasOneSource, ONE_SOURCE)
	.refine((m) => (m.hierarchy ?? DEFAULT_HIERARCHY) !== (m.separator ?? DEFAULT_SEPARATOR), {
		message: "hierarchy must differ from separator",
	});

const bylinesMapping = z
	.object({
		...valueSource,
		match: z.enum(["slug", "name"]).optional(),
		separator: separator.optional(),
	})
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
```

then replace
```ts
				}
			}
		}),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];

export type { JsonValue, TargetField };
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
export type MappedRecord = { key: string; slug?: string; data: Record<string, FieldValue> };
export type ValueErrorCode =
	| "filter_error"
	| "filter_not_boolean"
```
with:
```ts
				}
			}
		}),
		/** Terms to assign, by taxonomy name; each replaces the entry's terms of that taxonomy. */
		taxonomies: z
			.record(z.string(), taxonomyMapping)
			.superRefine((taxonomies, ctx) => {
				const names = Object.keys(taxonomies);
				if (names.length > MAX_TAXONOMIES) {
					ctx.addIssue({
						code: "custom",
						message: `Map at most ${MAX_TAXONOMIES} taxonomies`,
					});
				}
				for (const name of names) {
					if (!TAXONOMY_NAME_RE.test(name)) {
						ctx.addIssue({
							code: "custom",
							message: `Invalid taxonomy name "${name}"`,
							path: [name],
						});
					}
				}
			})
			.optional(),
		/** Existing bylines to credit, in order; replaces the entry's bylines. */
		bylines: bylinesMapping.optional(),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
export type BylinesMapping = NonNullable<Template["bylines"]>;

export type { JsonValue, LinkRequests, TargetField, TaxonomySnapshot, TermRequest };
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
/**
 * One record after the template: the key, the slug, the field values, and the link requests
 * (reference fields, taxonomies, bylines) when the template maps any. Reference fields are kept
 * out of `data`.
 */
export type MappedRecord = {
	key: string;
	slug?: string;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
};
export type ValueErrorCode =
	| "filter_error"
	| "filter_not_boolean"
```

then replace
```ts
	| "invalid_date"
	| "empty_slug"
	| ConversionCode
	| RuleCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
```
with:
```ts
	| "invalid_date"
	| "empty_slug"
	| ConversionCode
	| RuleCode
	| LinkErrorCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
```

then replace
```ts
				target?.type ?? null,
			);
		}
	}
}

/** A template with its expressions parsed once, for every record of a batch. */
```
with:
```ts
				target?.type ?? null,
			);
		}
		case "reference":
			return referenceConverter(mapping, target);
	}
}

/** A link mapping read from `from` or `expr` and converted to lookup requests. */
export interface LinkReader<T> {
	readonly from: string | undefined;
	readonly expr: CompiledExpression | null;
	readonly convert: (raw: unknown) => LinkConverted<T>;
}

/** A template with its expressions parsed once, for every record of a batch. */
```

then replace
```ts
	readonly converters: ReadonlyMap<string, FieldConverter>;
	/** The job's target field snapshot; null for jobs created before M4a (no field rules). */
	readonly targets: Readonly<Record<string, TargetField>> | null;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
```
with:
```ts
	readonly converters: ReadonlyMap<string, FieldConverter>;
	/** The job's target field snapshot; null for jobs created before M4a (no field rules). */
	readonly targets: Readonly<Record<string, TargetField>> | null;
	/** Each mapped taxonomy's reader, by taxonomy name. */
	readonly taxonomies: ReadonlyMap<string, LinkReader<TermRequest>>;
	/** The bylines reader, or null when the template maps no bylines. */
	readonly bylines: LinkReader<string> | null;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
```

then replace
```ts
	targets?: Readonly<Record<string, TargetField>> | undefined;
	/** The site timezone stored on the job; `UTC` when absent. */
	siteTimezone?: string | undefined;
}

/**
```
with:
```ts
	targets?: Readonly<Record<string, TargetField>> | undefined;
	/** The site timezone stored on the job; `UTC` when absent. */
	siteTimezone?: string | undefined;
	/** The mapped taxonomies as they were at job creation (M4b); flat when absent. */
	taxonomies?: Readonly<Record<string, TaxonomySnapshot>> | undefined;
}

/**
```

then replace
```ts
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, compiled: { template: t, filter, key, slug, fields, converters, targets } };
}

function kindOf(value: unknown): string {
```
with:
```ts
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
		taxonomies.set(name, {
			from: mapping.from,
			expr: compile(`taxonomies.${name}.expr`, mapping.expr),
			convert: taxonomyConverter(mapping, context.taxonomies?.[name] ?? null),
		});
	}
	const bylines =
		t.bylines === undefined
			? null
			: {
					from: t.bylines.from,
					expr: compile("bylines.expr", t.bylines.expr),
					convert: bylinesConverter(t.bylines),
				};
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		compiled: {
			template: t,
			filter,
			key,
			slug,
			fields,
			converters,
			targets,
			taxonomies,
			bylines,
		},
	};
}

function kindOf(value: unknown): string {
```

then replace
```ts

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug and each field from `from` or `expr` and converts them, collecting every
 * error. An expression result goes through the same conversion as a path value, and `undefined`
 * reads as a missing path. Run `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
```
with:
```ts

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug, each field, each taxonomy and the bylines from `from` or `expr` and converts
 * them, collecting every error. An expression result goes through the same conversion as a path
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests. Run `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
```

then replace
```ts
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
```
with:
```ts
	}

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
```

then replace
```ts
		const target = c.targets?.[field];
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length === 0) data[field] = result.value;
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}

/**
 * Every source path the template reads: key, slug and field `from`s, without duplicates.
 * Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [t.key.from, t.slug?.from, ...Object.values(t.fields).map((m) => m.from)];
	return [...new Set(froms.filter((path): path is string => path !== undefined))];
}

```
with:
```ts
		const target = c.targets?.[field];
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else data[field] = result.value;
	}
	for (const [name, reader] of c.taxonomies) {
		const field = `taxonomies.${name}`;
		const raw = await read(field, reader.from, reader.expr);
		if (raw === FAILED) continue;
		const result = reader.convert(raw);
		if (!result.ok) errors.push({ field, code: result.code, message: result.message });
		else {
			links.taxonomies ??= {};
			links.taxonomies[name] = result.value;
		}
	}
	if (c.bylines !== null) {
		const raw = await read("bylines", c.bylines.from, c.bylines.expr);
		if (raw !== FAILED) {
			const result = c.bylines.convert(raw);
			if (!result.ok) errors.push({ field: "bylines", code: result.code, message: result.message });
			else links.bylines = result.value;
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	return { ok: true, value: mapped };
}

/**
 * Every source path the template reads: key, slug, field, taxonomy and bylines `from`s, without
 * duplicates. Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [
		t.key.from,
		t.slug?.from,
		...Object.values(t.fields).map((m) => m.from),
		...Object.values(t.taxonomies ?? {}).map((m) => m.from),
		t.bylines?.from,
	];
	return [...new Set(froms.filter((path): path is string => path !== undefined))];
}

```

then replace
```ts
	multiSelect: ["multiSelect"],
	json: ["json"],
	slug: ["slug", "string"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
```
with:
```ts
	multiSelect: ["multiSelect"],
	json: ["json"],
	slug: ["slug", "string"],
	reference: ["reference"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
```

In `packages/flux-import/src/plugin/schema-apply.ts`, replace
```ts
	"slug",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];

/** EmDash's indexable types (`emdash` src/schema/types.ts:56-66), of those above. */
const INDEXABLE: ReadonlySet<string> = new Set([
```
with:
```ts
	"slug",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
 * A template's reference mapping asks for a reference field, which `schema/apply` never creates:
 * it needs a relation, and the handlers that create one are not exported by EmDash.
 */
type RequestType = ApplyFieldType | "reference";

/** EmDash's indexable types (`emdash` src/schema/types.ts:56-66), of those above. */
const INDEXABLE: ReadonlySet<string> = new Set([
```

then replace
```ts

export interface FieldRequest {
	slug: string;
	type: ApplyFieldType;
	label?: string | undefined;
	options?: string[] | undefined;
	indexed?: boolean | undefined;
```
with:
```ts

export interface FieldRequest {
	slug: string;
	type: RequestType;
	label?: string | undefined;
	options?: string[] | undefined;
	indexed?: boolean | undefined;
```

then replace
```ts
	const field = request.slug;
	const type = request.type;
	if (existing === undefined) {
		const options = request.options === undefined ? {} : { options: request.options };
		return { change: { field, action: "create", type, ...options } };
	}
```
with:
```ts
	const field = request.slug;
	const type = request.type;
	if (existing === undefined) {
		if (type === "reference") {
			const message = `Field "${field}" does not exist; create reference fields in the admin`;
			return { change: { field, action: "conflict", type, message } };
		}
		const options = request.options === undefined ? {} : { options: request.options };
		return { change: { field, action: "create", type, ...options } };
	}
```

then replace
```ts
	try {
		for (const [i, request] of requests.entries()) {
			let plan = plans[i] as (typeof plans)[number];
			if (plan.change.action === "create") {
				try {
					await registry.createField(collection, {
						slug: request.slug,
```
with:
```ts
	try {
		for (const [i, request] of requests.entries()) {
			let plan = plans[i] as (typeof plans)[number];
			// A reference request never plans `create` (planField); the type check narrows it.
			if (plan.change.action === "create" && request.type !== "reference") {
				try {
					await registry.createField(collection, {
						slug: request.slug,
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run links schema-apply`
Expected: PASS (40 tests: 19 in `links.test.ts`, 21 in `schema-apply.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 40 files / 1,044 tests, from 39 / 1,024 at `cc64bb4`).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/links.ts packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/values.ts packages/flux-import/src/plugin/schema-apply.ts packages/flux-import/tests/unit/links.test.ts packages/flux-import/tests/unit/schema-apply.test.ts
git commit -m "Convert reference, taxonomy and byline mappings into link requests"
```

### Task 2: Lookup port over taxonomies, bylines and content reads

**Files:**
- Create: `packages/flux-import/src/emdash/lookups.ts`
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/emdash/content.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/lookups.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: `TaxonomyAccess`, `TaxonomyAccessWithWrite`, `TaxonomyTermInfo`, `BylineAccess` types from `emdash`; `ctx.taxonomies`/`ctx.bylines` (V1, E1, E6); `runtime.handleContentGet` (spec F15).
- Produces:
  - `src/engine/ports.ts`: `EntrySnapshot.group?`; `interface TaxonomyDef { name; hierarchical; collections; locale }`, `interface TermInfo { id; slug; label; parentId; group }`, `interface BylineRef { id; slug; displayName; group }`, `interface LookupPort { taxonomyDefs; terms; createTerm; entryTerms; bylines; findEntry }` (signatures as in the spec's "Batch integration").
  - `src/engine/types.ts`: `EngineDeps.lookups: LookupPort`.
  - `src/emdash/content.ts`: `writeError(op, error)` exported; snapshots carry `group` from `translationGroup`.
  - `src/emdash/lookups.ts`: `BYLINE_PAGE` (100), `interface EntryReader`, `class EmDashLookups implements LookupPort` (constructor `(taxonomies, bylines, runtime)`).
  - `src/plugin/definition.ts`: capabilities `+ "taxonomies:write", "bylines:read"`; `src/plugin/routes.ts`: `lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime)`.
  - `tests/unit/fakes.ts`: `FakeLookups` (`addTerm`, `addByline`, `defs`, `storedTerms`, `storedBylines`, `calls`, `failCreate`; bylines in pages of 2), wired into `makeDeps`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/lookups.test.ts`:
```ts
import type { BylineAccess, TaxonomyAccessWithWrite, TaxonomyTermInfo } from "emdash";
import { describe, expect, it } from "vitest";
import type { HandlerResult } from "../../src/emdash/content.js";
import { EmDashLookups, type EntryReader } from "../../src/emdash/lookups.js";
import { ContentWriteError } from "../../src/engine/ports.js";

const term = (over: Partial<TaxonomyTermInfo>): TaxonomyTermInfo => ({
	id: "t1",
	taxonomy: "category",
	slug: "news",
	label: "News",
	parentId: null,
	data: null,
	locale: "en",
	translationGroup: "g1",
	...over,
});

function taxonomies(calls: unknown[][]): TaxonomyAccessWithWrite {
	return {
		getAll: async () => [
			{
				name: "category",
				label: "Categories",
				labelSingular: null,
				hierarchical: true,
				collections: ["posts"],
				locale: "en",
			},
		],
		getTerms: async (taxonomy, options) => {
			calls.push(["getTerms", taxonomy, options]);
			return [term({}), term({ id: "t2", slug: "tech", parentId: "g1", translationGroup: null })];
		},
		getEntryTerms: async (collection, entryId, options) => {
			calls.push(["getEntryTerms", collection, entryId, options]);
			return [
				term({}),
				term({ id: "t1-fr", locale: "fr", slug: "actualites" }),
				term({ id: "t9", taxonomy: "tag", slug: "x", translationGroup: "g9" }),
			];
		},
		createTerm: async (taxonomy, input) => {
			calls.push(["createTerm", taxonomy, input]);
			if (input.slug === "taken") {
				throw Object.assign(new Error("Term 'taken' already exists"), { code: "CONFLICT" });
			}
			return term({ id: "t3", slug: input.slug ?? "phones", label: input.label, parentId: "g1" });
		},
		addEntryTerms: async () => [],
		removeEntryTerms: async () => [],
	};
}

function bylines(calls: unknown[][]): BylineAccess {
	return {
		get: async () => null,
		getEntriesBylines: async () => [],
		list: async (options) => {
			calls.push(["list", options]);
			const byline = {
				id: "b1",
				slug: "alex",
				displayName: "Alex",
				bio: null,
				websiteUrl: null,
				avatarMediaId: null,
				locale: "en",
				translationGroup: "bg1",
			};
			return options?.cursor
				? { items: [byline], hasMore: false }
				: { items: [byline], hasMore: true, cursor: "c2" };
		},
	};
}

class Reader implements EntryReader {
	readonly calls: unknown[][] = [];
	constructor(private readonly answer: (id: string, locale?: string) => HandlerResult) {}
	async handleContentGet(collection: string, id: string, locale?: string) {
		this.calls.push([collection, id, locale]);
		return this.answer(id, locale);
	}
}

const found = (id: string, slug: string, translationGroup?: string): HandlerResult => ({
	success: true,
	data: { item: { id, slug, translationGroup }, _rev: "r" },
});

describe("EmDashLookups", () => {
	it("maps taxonomy definitions and terms, with the translation group as the group", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			bylines(calls),
			new Reader(() => found("x", "x")),
		);
		expect(await lookups.taxonomyDefs()).toEqual([
			{ name: "category", hierarchical: true, collections: ["posts"], locale: "en" },
		]);
		expect(await lookups.terms("category", "en")).toEqual([
			{ id: "t1", slug: "news", label: "News", parentId: null, group: "g1" },
			{ id: "t2", slug: "tech", label: "News", parentId: "g1", group: "t2" },
		]);
		expect(calls).toEqual([["getTerms", "category", { locale: "en" }]]);
	});

	it("creates terms through createTerm and passes EmDash's errors on", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			undefined,
			new Reader(() => found("x", "x")),
		);
		const input = { label: "Phones", parentId: "t1", locale: "en" };
		expect(await lookups.createTerm("category", input)).toEqual({
			id: "t3",
			slug: "phones",
			label: "Phones",
			parentId: "g1",
			group: "g1",
		});
		expect(calls).toEqual([["createTerm", "category", input]]);
		await expect(
			lookups.createTerm("category", { label: "T", slug: "taken", locale: "en" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("groups an entry's terms by taxonomy, once per translation group, across locales", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			undefined,
			new Reader(() => found("x", "x")),
		);
		expect(await lookups.entryTerms("posts", "e1")).toEqual({ category: ["g1"], tag: ["g9"] });
		expect(calls).toEqual([["getEntryTerms", "posts", "e1", undefined]]);
	});

	it("pages bylines 100 at a time in the locale", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(undefined, bylines(calls), new Reader(() => found("x", "x")));
		const first = await lookups.bylines("en");
		expect(first).toEqual({
			items: [{ id: "b1", slug: "alex", displayName: "Alex", group: "bg1" }],
			cursor: "c2",
		});
		expect(await lookups.bylines("en", "c2")).not.toHaveProperty("cursor");
		expect(calls).toEqual([
			["list", { locale: "en", limit: 100 }],
			["list", { locale: "en", limit: 100, cursor: "c2" }],
		]);
	});

	it("finds an entry by exact ID in any locale, and by exact slug in the locale", async () => {
		const reader = new Reader((id) =>
			id === "missing"
				? { success: false, error: { code: "NOT_FOUND", message: "nope" } }
				: id === "01A" || id === "desk"
					? found("01A", "desk", "G1")
					: found("01B", "01A-slug"),
		);
		const lookups = new EmDashLookups(undefined, undefined, reader);
		expect(await lookups.findEntry("products", "id", "01A", "en")).toEqual({
			id: "01A",
			group: "G1",
		});
		// The handler also answers slugs: a slug asked as an ID is not found, and the reverse.
		expect(await lookups.findEntry("products", "id", "desk", "en")).toBeNull();
		expect(await lookups.findEntry("products", "slug", "desk", "en")).toEqual({
			id: "01A",
			group: "G1",
		});
		expect(await lookups.findEntry("products", "slug", "01A", "en")).toBeNull();
		expect(await lookups.findEntry("products", "slug", "other", "en")).toBeNull();
		expect(await lookups.findEntry("products", "id", "missing", "en")).toBeNull();
		expect(reader.calls).toEqual([
			["products", "01A", undefined],
			["products", "desk", undefined],
			["products", "desk", "en"],
			["products", "01A", "en"],
			["products", "other", "en"],
			["products", "missing", undefined],
		]);
		const group = await lookups.findEntry("products", "slug", "01A-slug", "en");
		expect(group).toEqual({ id: "01B", group: "01B" });
	});

	it("turns other read errors into emdash_ codes", async () => {
		const reader = new Reader(() => ({
			success: false,
			error: { code: "CONTENT_GET_ERROR", message: "Failed" },
		}));
		const lookups = new EmDashLookups(undefined, undefined, reader);
		const error = await lookups.findEntry("products", "id", "x", "en").catch((e) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "emdash_content_get_error" });
	});

	it("says which capability is missing", async () => {
		const lookups = new EmDashLookups(undefined, undefined, new Reader(() => found("x", "x")));
		await expect(lookups.terms("tag", "en")).rejects.toThrow("declare taxonomies:write");
		await expect(lookups.bylines("en")).rejects.toThrow("declare bylines:read");
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
			"content:write",
			"content:publish",
			"schema:read",
		]);
	});

```
with:
```ts
			"content:write",
			"content:publish",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			// definePlugin adds the read capability that taxonomies:write implies.
			"taxonomies:read",
		]);
	});

```

In `packages/flux-import/tests/unit/fakes.ts`, replace
```ts
import { EmDashStorageError } from "emdash";
import type { UploadStorage } from "../../src/emdash/uploads.js";
import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type KvCollection,
	SourceMissingError,
	type SourcePort,
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
```
with:
```ts
import { EmDashStorageError } from "emdash";
import type { UploadStorage } from "../../src/emdash/uploads.js";
import {
	type BylineRef,
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type KvCollection,
	type LookupPort,
	SourceMissingError,
	type SourcePort,
	type TaxonomyDef,
	type TermInfo,
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
```

then replace
```ts
			rev: String(e.rev),
			slug: e.slug,
			data: structuredClone(e.data),
			pendingPublish: e.pendingPublish,
		};
	}
```
with:
```ts
			rev: String(e.rev),
			slug: e.slug,
			data: structuredClone(e.data),
			group: e.id,
			pendingPublish: e.pendingPublish,
		};
	}
```

then replace
```ts
	}
}

export class FakeSource implements SourcePort {
	readonly uploads = new Map<string, Uint8Array>();
	opens = 0;
```
with:
```ts
	}
}

type StoredTerm = TermInfo & { taxonomy: string; locale: string };

/**
 * In-memory `LookupPort`: terms and bylines added by tests (a term's group is its ID), entries
 * from the `FakeContent` (an entry's group is its ID), and entry terms set by tests.
 */
export class FakeLookups implements LookupPort {
	readonly defs: TaxonomyDef[] = [];
	readonly storedTerms: StoredTerm[] = [];
	readonly storedBylines: (BylineRef & { locale: string })[] = [];
	/** Entry terms by entry ID: term groups by taxonomy. */
	readonly assigned = new Map<string, Record<string, string[]>>();
	readonly calls: string[] = [];
	/** Return an error to make creating this term fail. */
	failCreate: (taxonomy: string, input: { label: string; slug?: string }) => Error | null = () =>
		null;
	private next = 0;

	constructor(private readonly content: FakeContent) {}

	/** Adds a term; `parent` is the parent's slug in the same taxonomy and locale. */
	addTerm(taxonomy: string, slug: string, label: string, parent?: string, locale = "en"): TermInfo {
		const parentTerm =
			parent === undefined
				? null
				: this.storedTerms.find(
						(t) => t.taxonomy === taxonomy && t.locale === locale && t.slug === parent,
					);
		if (parent !== undefined && !parentTerm) throw new Error(`No parent term ${parent}`);
		const id = `t${++this.next}`;
		const term = { id, slug, label, parentId: parentTerm?.group ?? null, group: id };
		this.storedTerms.push({ ...term, taxonomy, locale });
		return term;
	}

	addByline(slug: string, displayName: string, locale = "en"): BylineRef {
		const id = `b${++this.next}`;
		const byline = { id, slug, displayName, group: id };
		this.storedBylines.push({ ...byline, locale });
		return byline;
	}

	async taxonomyDefs() {
		this.calls.push("defs");
		return structuredClone(this.defs);
	}

	async terms(taxonomy: string, locale: string) {
		this.calls.push(`terms:${taxonomy}:${locale}`);
		return this.storedTerms
			.filter((t) => t.taxonomy === taxonomy && t.locale === locale)
			.map(({ taxonomy: _t, locale: _l, ...term }) => term);
	}

	async createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	) {
		this.calls.push(`create:${taxonomy}:${input.slug ?? input.label}`);
		const failure = this.failCreate(taxonomy, input);
		if (failure) throw failure;
		const inLocale = this.storedTerms.filter(
			(t) => t.taxonomy === taxonomy && t.locale === input.locale,
		);
		if (input.slug !== undefined && inLocale.some((t) => t.slug === input.slug)) {
			throw Object.assign(new Error(`Term '${input.slug}' already exists`), { code: "CONFLICT" });
		}
		const parent =
			input.parentId === undefined ? null : this.storedTerms.find((t) => t.id === input.parentId);
		if (input.parentId !== undefined && !parent) {
			throw Object.assign(new Error("Parent term not found"), { code: "VALIDATION_ERROR" });
		}
		// EmDash generates a unique slug from the label when none is given.
		let slug = input.slug ?? input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		for (let n = 1; input.slug === undefined && inLocale.some((t) => t.slug === slug); n++) {
			slug = `${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${n}`;
		}
		const parentSlug = parent?.slug;
		return this.addTerm(taxonomy, slug, input.label, parentSlug, input.locale);
	}

	async entryTerms(_collection: string, entryId: string) {
		this.calls.push(`entryTerms:${entryId}`);
		return structuredClone(this.assigned.get(entryId) ?? {});
	}

	/** Pages of two, so tests see the cursor. */
	async bylines(locale: string, cursor?: string) {
		this.calls.push(`bylines:${locale}:${cursor ?? ""}`);
		const all = this.storedBylines
			.filter((b) => b.locale === locale)
			.map(({ locale: _l, ...b }) => b);
		const start = cursor === undefined ? 0 : Number(cursor);
		const items = all.slice(start, start + 2);
		return start + 2 < all.length ? { items, cursor: String(start + 2) } : { items };
	}

	async findEntry(collection: string, by: "id" | "slug", value: string, locale: string) {
		this.calls.push(`find:${collection}:${by}:${value}`);
		for (const e of this.content.entries.values()) {
			if (e.collection !== collection) continue;
			if (by === "id" ? e.id === value : e.locale === locale && e.slug === value) {
				return { id: e.id, group: e.id };
			}
		}
		return null;
	}
}

export class FakeSource implements SourcePort {
	readonly uploads = new Map<string, Uint8Array>();
	opens = 0;
```

then replace
```ts
export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content: new FakeContent(),
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```
with:
```ts
export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content,
		lookups: new FakeLookups(content),
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run lookups definition`
Expected: FAIL — `lookups.test.ts` cannot load `../../src/emdash/lookups.js` (no tests run), and 1 of 14 tests in `definition.test.ts` fails: "has the retention setting, the activate hook and the cron hook" (the capabilities lack `taxonomies:write`, `bylines:read` and the implied `taxonomies:read`).

- [ ] **Step 3: Add the port, the EmDash adapter and the capabilities**

In `packages/flux-import/src/engine/ports.ts`, replace
```ts
	rev: string;
	slug: string | null;
	data: Record<string, unknown>;
	/**
	 * The entry has a draft that is not live, or is not published (EmDash: `status` is not
	 * `"published"` or `draftRevisionId` is set). On collections without revisions writes are
```
with:
```ts
	rev: string;
	slug: string | null;
	data: Record<string, unknown>;
	/** The entry's translation group, shared by its locales; absent when EmDash gives none. */
	group?: string;
	/**
	 * The entry has a draft that is not live, or is not published (EmDash: `status` is not
	 * `"published"` or `draftRevisionId` is set). On collections without revisions writes are
```

then replace
```ts
	ensureSourceIdField(collection: string): Promise<void>;
}

export interface SourcePort {
	/**
	 * An offset at or past the source size yields an empty stream. EmDash's ranged download returns
```
with:
```ts
	ensureSourceIdField(collection: string): Promise<void>;
}

/** A taxonomy definition (`TaxonomyDefInfo`, one per locale). */
export interface TaxonomyDef {
	name: string;
	hierarchical: boolean;
	/** The collections the taxonomy is attached to. */
	collections: string[];
	locale: string;
}

/** A taxonomy term in one locale. `parentId` is the parent's translation group, null for a root. */
export interface TermInfo {
	/** The term's row ID in its locale, which `createTerm` takes as `parentId`. */
	id: string;
	slug: string;
	label: string;
	parentId: string | null;
	group: string;
}

/** A byline in one locale. */
export interface BylineRef {
	id: string;
	slug: string;
	displayName: string;
	group: string;
}

/**
 * Lookups for links (taxonomy terms, bylines, reference targets). Every method reads EmDash as
 * it is now; `createTerm` is the only write.
 */
export interface LookupPort {
	taxonomyDefs(): Promise<TaxonomyDef[]>;
	/** Every term of the taxonomy in the locale. */
	terms(taxonomy: string, locale: string): Promise<TermInfo[]>;
	/** Throws EmDash's error (with its `code`, e.g. `CONFLICT`) when the term cannot be created. */
	createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	): Promise<TermInfo>;
	/** The term translation groups assigned to the entry, by taxonomy (every locale's rows). */
	entryTerms(collection: string, entryId: string): Promise<Record<string, string[]>>;
	/** One page of the locale's bylines (at most 100), newest first; `cursor` when more follow. */
	bylines(locale: string, cursor?: string): Promise<{ items: BylineRef[]; cursor?: string }>;
	/**
	 * An entry of the collection by exact ID (any locale) or by exact slug in the locale, with its
	 * translation group; null when there is none.
	 */
	findEntry(
		collection: string,
		by: "id" | "slug",
		value: string,
		locale: string,
	): Promise<{ id: string; group: string } | null>;
}

export interface SourcePort {
	/**
	 * An offset at or past the source size yields an empty stream. EmDash's ranged download returns
```

In `packages/flux-import/src/engine/types.ts`, replace
```ts
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, SourcePort } from "./ports.js";
import type { Template } from "./template.js";
import type { TargetField } from "./values.js";

```
with:
```ts
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, SourcePort } from "./ports.js";
import type { Template } from "./template.js";
import type { TargetField } from "./values.js";

```

then replace
```ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	content: ContentPort;
	source: SourcePort;
	now: () => number;
	newId: () => string;
```
with:
```ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	content: ContentPort;
	lookups: LookupPort;
	source: SourcePort;
	now: () => number;
	newId: () => string;
```

In `packages/flux-import/src/emdash/content.ts`, replace
```ts
		slug: z.string().nullable(),
		status: z.string(),
		locale: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
	}),
```
with:
```ts
		slug: z.string().nullable(),
		status: z.string(),
		locale: z.string().nullable().optional(),
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
	}),
```

then replace
```ts
 * handlers, src/api/handlers/content.ts:1006, :1413, :1709) becomes `collection_missing`, which
 * fails the job rather than each record.
 */
function writeError(op: string, error: HandlerResult["error"]): ContentWriteError {
	const code = error?.code ?? "UNKNOWN_ERROR";
	if (code === "COLLECTION_NOT_FOUND") {
		return new ContentWriteError("collection_missing", `${op} failed: ${error?.message ?? code}`);
```
with:
```ts
 * handlers, src/api/handlers/content.ts:1006, :1413, :1709) becomes `collection_missing`, which
 * fails the job rather than each record.
 */
export function writeError(op: string, error: HandlerResult["error"]): ContentWriteError {
	const code = error?.code ?? "UNKNOWN_ERROR";
	if (code === "COLLECTION_NOT_FOUND") {
		return new ContentWriteError("collection_missing", `${op} failed: ${error?.message ?? code}`);
```

then replace
```ts
		// (hydrateDraftData without includeStagedSlug, src/emdash-runtime.ts:3389-3442).
		slug: item.slug,
		data: item.data,
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
	};
```
with:
```ts
		// (hydrateDraftData without includeStagedSlug, src/emdash-runtime.ts:3389-3442).
		slug: item.slug,
		data: item.data,
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
	};
```

Create `packages/flux-import/src/emdash/lookups.ts`:
```ts
import type {
	BylineAccess,
	TaxonomyAccess,
	TaxonomyAccessWithWrite,
	TaxonomyTermInfo,
} from "emdash";
import type { BylineRef, LookupPort, TaxonomyDef, TermInfo } from "../engine/ports.js";
import { type HandlerResult, writeError } from "./content.js";

/** The runtime's content read (`emdash` src/emdash-runtime.ts:3364); the runtime is assignable. */
export interface EntryReader {
	handleContentGet(collection: string, id: string, locale?: string): Promise<HandlerResult>;
}

/** Bylines per page: the most `ctx.bylines.list` returns (src/plugins/byline-access.ts). */
export const BYLINE_PAGE = 100;

function termOf(t: TaxonomyTermInfo): TermInfo {
	return {
		id: t.id,
		slug: t.slug,
		label: t.label,
		parentId: t.parentId,
		group: t.translationGroup ?? t.id,
	};
}

function itemOf(data: unknown): { id: string; slug: string | null; group: string } | null {
	const item =
		typeof data === "object" && data !== null && "item" in data
			? (data.item as Record<string, unknown> | null)
			: null;
	if (item === null || typeof item !== "object" || typeof item.id !== "string") return null;
	const slug = typeof item.slug === "string" ? item.slug : null;
	const group = typeof item.translationGroup === "string" ? item.translationGroup : item.id;
	return { id: item.id, slug, group };
}

/**
 * `LookupPort` over the plugin context's `ctx.taxonomies` (`taxonomies:write`), `ctx.bylines`
 * (`bylines:read`) and the runtime's content reads. EmDash sets the context objects only for
 * declared capabilities (src/plugins/context.ts:1752-1763); a missing one throws when used.
 */
export class EmDashLookups implements LookupPort {
	constructor(
		private readonly taxonomies: TaxonomyAccess | TaxonomyAccessWithWrite | undefined,
		private readonly bylineAccess: BylineAccess | undefined,
		private readonly runtime: EntryReader,
	) {}

	private tax(): TaxonomyAccess {
		if (!this.taxonomies) {
			throw new Error("flux-import: ctx.taxonomies is missing; declare taxonomies:write");
		}
		return this.taxonomies;
	}

	async taxonomyDefs(): Promise<TaxonomyDef[]> {
		const defs = await this.tax().getAll();
		return defs.map((d) => ({
			name: d.name,
			hierarchical: d.hierarchical,
			collections: d.collections,
			locale: d.locale,
		}));
	}

	async terms(taxonomy: string, locale: string): Promise<TermInfo[]> {
		return (await this.tax().getTerms(taxonomy, { locale })).map(termOf);
	}

	async createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	): Promise<TermInfo> {
		const create = this.tax().createTerm;
		if (!create) throw new Error("flux-import: creating terms needs taxonomies:write");
		return termOf(await create.call(this.taxonomies, taxonomy, input));
	}

	async entryTerms(collection: string, entryId: string): Promise<Record<string, string[]>> {
		// Without a locale every locale's rows come back; assignments are per translation group.
		const terms = await this.tax().getEntryTerms(collection, entryId);
		const groups: Record<string, string[]> = {};
		for (const t of terms) {
			const list = groups[t.taxonomy] ?? [];
			const group = t.translationGroup ?? t.id;
			if (!list.includes(group)) list.push(group);
			groups[t.taxonomy] = list;
		}
		return groups;
	}

	async bylines(locale: string, cursor?: string): Promise<{ items: BylineRef[]; cursor?: string }> {
		if (!this.bylineAccess) {
			throw new Error("flux-import: ctx.bylines is missing; declare bylines:read");
		}
		const page = await this.bylineAccess.list({
			locale,
			limit: BYLINE_PAGE,
			...(cursor === undefined ? {} : { cursor }),
		});
		const items = page.items.map((b) => ({
			id: b.id,
			slug: b.slug,
			displayName: b.displayName,
			group: b.translationGroup,
		}));
		return page.hasMore && page.cursor ? { items, cursor: page.cursor } : { items };
	}

	/**
	 * `handleContentGet` finds an entry by ID or slug (src/database/repositories/content.ts:711-717),
	 * so the answer must match the way asked: the same ID, or the same slug in the locale.
	 */
	async findEntry(
		collection: string,
		by: "id" | "slug",
		value: string,
		locale: string,
	): Promise<{ id: string; group: string } | null> {
		const result =
			by === "id"
				? await this.runtime.handleContentGet(collection, value)
				: await this.runtime.handleContentGet(collection, value, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Looking up a referenced entry", result.error);
		}
		const item = itemOf(result.data);
		if (item === null) return null;
		const matches = by === "id" ? item.id === value : item.slug === value;
		return matches ? { id: item.id, group: item.group } : null;
	}
}
```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// Declared for disclosure on the admin plugins page. The importer reads and writes content,
		// adds the flux_source_id field and creates fields for schema/apply through the trusted
		// runtime (withEmDashRuntime), not through ctx.content, so these do not gate any call it
		// makes; plugins have no schema-writing capability to declare. URL sources are fetched with
		// the runtime's own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through
		// ctx.http, so no network capability is declared.
		capabilities: ["content:read", "content:write", "content:publish", "schema:read"],
		storage: STORAGE,
		routes,
		admin: {
```
with:
```ts
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// The content and schema capabilities are declared for disclosure on the admin plugins
		// page. The importer reads and writes content, adds the flux_source_id field and creates
		// fields for schema/apply through the trusted runtime (withEmDashRuntime), not through
		// ctx.content, so these do not gate any call it makes; plugins have no schema-writing
		// capability to declare. The other two gate calls the importer makes: taxonomies:write
		// gives ctx.taxonomies, which reads taxonomies, terms and entry terms and creates missing
		// terms (createTerm, the only sanctioned way to create one); bylines:read gives
		// ctx.bylines, whose list is the only way to look bylines up. Entries are assigned their
		// terms, references and bylines through the runtime's content writes. URL sources are
		// fetched with the runtime's own fetch() behind the plugin's SSRF guard
		// (src/sources/net.ts), not through ctx.http, so no network capability is declared.
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
		],
		storage: STORAGE,
		routes,
		admin: {
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
```
with:
```ts
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
```

then replace
```ts
			content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
```
with:
```ts
			content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run lookups definition`
Expected: PASS (21 tests: 7 in `lookups.test.ts`, 14 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 41 files / 1,051 tests after Task 1, or 40 / 1,031 on `cc64bb4` alone).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/emdash/lookups.ts packages/flux-import/src/emdash/content.ts packages/flux-import/src/engine/ports.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/lookups.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Add a lookup port over ctx.taxonomies, ctx.bylines and content reads, and declare taxonomies:write and bylines:read"
```

### Task 3: Schema checks and snapshots at job creation

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/template.test.ts`, `packages/flux-import/tests/unit/schema.test.ts`, `packages/flux-import/tests/unit/jobs.test.ts`, `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Task 1 (mapping types, `TargetField` relation keys, `TaxonomySnapshot`, `DEFAULT_HIERARCHY`), Task 2 (`LookupPort.taxonomyDefs`, `TaxonomyDef`, `EngineDeps.lookups`, `FakeLookups`); E2.
- Produces:
  - `src/engine/template.ts`: `SchemaField.relationSide?`/`targetCollection?`/`multiple?`; `type LinkSchema = { targets?: Record<string, SchemaField[] | null>; taxonomies?: TaxonomyDef[] }`; `BIND_REFERENCE_DOCS`; `checkTemplate(t, fields, columns?, siteTimezone?, links?)`; `targetFieldsOf` keeps the relation keys; `taxonomiesOf(t, defs)`; `linkWarnings(t, defs)`.
  - `src/engine/types.ts`: `Job.taxonomies?: Record<string, TaxonomySnapshot>`.
  - `src/engine/jobs.ts`: `CreateJobInput.linkSchema?`; `createJob` checks with it, stores `taxonomies` (only when the template maps any) and adds the link warnings.
  - `src/emdash/schema.ts`: `RegistryField.validation` and `listSchemaFields` carry `relationSide`, `targetCollection`, `multiple`.
  - `src/plugin/service.ts`: `linkSchemaFor` (each mapped reference target's fields once; taxonomy definitions only when the template maps taxonomies); `StartJobInput` omits `linkSchema`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, replace
```ts
	checkTemplate,
	compileTemplate,
	filterRecord,
	missingPathWarnings,
	type SchemaField,
	slugify,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
	unresolvedPaths,
```
with:
```ts
	checkTemplate,
	compileTemplate,
	filterRecord,
	type LinkSchema,
	linkWarnings,
	missingPathWarnings,
	type SchemaField,
	slugify,
	type Template,
	targetFieldsOf,
	taxonomiesOf,
	templatePaths,
	templateSchema,
	unresolvedPaths,
```

then replace
```ts
			colours: { type: "multiSelect", required: false },
		});
	});
});

```
with:
```ts
			colours: { type: "multiSelect", required: false },
		});
	});
});

describe("checkTemplate for links", () => {
	const linked = templateSchema.parse({
		version: 1,
		collection: "posts",
		locale: "en",
		key: { from: "id" },
		fields: {
			title: { from: "Title", type: "text" },
			author: { from: "Author", type: "reference", match: "key" },
			related: { from: "Related", type: "reference", match: "slug" },
		},
		taxonomies: { category: { from: "Categories" }, tag: { from: "Tags", hierarchy: ">" } },
		bylines: { from: "Authors" },
	});
	const bound = (over: Partial<SchemaField> = {}): SchemaField => ({
		slug: "author",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "people",
		...over,
	});
	const fields: SchemaField[] = [
		{ slug: "title", type: "string" },
		bound(),
		bound({ slug: "related", targetCollection: "posts", multiple: true }),
	];
	const defs = [
		{ name: "category", hierarchical: true, collections: ["posts"], locale: "en" },
		{ name: "tag", hierarchical: false, collections: ["pages", "posts"], locale: "en" },
	];
	const targets = {
		people: [
			{ slug: "name", type: "string" },
			{ slug: "flux_source_id", type: "string" },
		],
		posts: fields,
	};
	const check = (f: SchemaField[] = fields, links: LinkSchema = { targets, taxonomies: defs }) =>
		checkTemplate(linked, f, null, "UTC", links);

	it("accepts bound reference fields and attached taxonomies", () => {
		expect(check()).toEqual([]);
	});

	it("refuses reference mappings into other types, unbound fields and missing targets", () => {
		expect(
			check([
				{ slug: "title", type: "string" },
				{ slug: "author", type: "string" },
				{ slug: "related", type: "reference", validation: {} },
			]),
		).toEqual([
			'Field "author" has type "string"; a reference mapping needs one of reference',
			'Field "related" is a reference field without a relation; bind it first (https://docs.emdashcms.com/guides/relations/#bind-a-field-that-has-no-relation)',
		]);
		expect(check(fields, { targets: { ...targets, people: null }, taxonomies: defs })).toEqual([
			'Field "author" links to collection "people", which does not exist',
		]);
	});

	it("needs imported entries in the target for match key", () => {
		const people = [{ slug: "name", type: "string" }];
		expect(check(fields, { targets: { ...targets, people }, taxonomies: defs })).toEqual([
			'Field "author" finds entries by import key, but no entries were imported into "people"',
		]);
	});

	it("keeps refusing other mappings into a bound reference field", () => {
		const text = templateSchema.parse({
			...linked,
			fields: { author: { from: "Author", type: "text" } },
			taxonomies: undefined,
		});
		expect(checkTemplate(text, fields, null)).toEqual([
			'Field "author" keeps its values outside the content table and cannot be imported',
		]);
	});

	it("refuses unknown taxonomies and ones the collection does not use", () => {
		expect(
			check(fields, {
				targets,
				taxonomies: [{ name: "tag", hierarchical: false, collections: ["pages"], locale: "en" }],
			}),
		).toEqual([
			'Taxonomy "category" does not exist',
			'Taxonomy "tag" is not attached to collection "posts"',
		]);
		const attachedInFrench = [
			defs[0]!,
			{ name: "tag", hierarchical: false, collections: ["pages"], locale: "en" },
			{ name: "tag", hierarchical: false, collections: ["posts"], locale: "fr" },
		];
		expect(check(fields, { targets, taxonomies: attachedInFrench })).toEqual([]);
	});

	it("skips the link checks it is given nothing for", () => {
		expect(checkTemplate(linked, fields, null)).toEqual([]);
	});

	it("snapshots reference fields and taxonomies, and warns about hierarchy on a flat one", () => {
		expect(targetFieldsOf(linked, fields)).toEqual({
			title: { type: "string", required: false },
			author: {
				type: "reference",
				required: false,
				relationSide: "parent",
				targetCollection: "people",
			},
			related: {
				type: "reference",
				required: false,
				relationSide: "parent",
				targetCollection: "posts",
				multiple: true,
			},
		});
		const twoLocales = [
			{ name: "category", hierarchical: false, collections: ["posts"], locale: "fr" },
			...defs,
		];
		expect(taxonomiesOf(linked, twoLocales)).toEqual({
			category: { hierarchical: true },
			tag: { hierarchical: false },
		});
		expect(linkWarnings(linked, defs)).toEqual([
			'Taxonomy "tag" is flat; its "hierarchy" separator is ignored',
		]);
		const french = templateSchema.parse({ ...linked, locale: "de" });
		expect(taxonomiesOf(french, twoLocales)).toEqual({
			category: { hierarchical: false },
			tag: { hierarchical: false },
		});
	});
});

```

In `packages/flux-import/tests/unit/schema.test.ts`, replace
```ts
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});

	it("lists required, defaults, the enforced validation keys and unusable fields", async () => {
		const registry: SchemaRegistryLike = Object.assign(new FakeRegistry(), {
			getCollectionWithFields: async () => ({
				fields: [
```
with:
```ts
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});

	it("lists required, defaults, the enforced validation keys, unusable fields and relations", async () => {
		const registry: SchemaRegistryLike = Object.assign(new FakeRegistry(), {
			getCollectionWithFields: async () => ({
				fields: [
```

then replace
```ts
					{ slug: "qty", type: "integer", required: false, validation: { min: 0, max: 5 } },
					{ slug: "weird", type: "string", unsupportedType: { type: "geo", path: "type" } },
					{ slug: "author", type: "reference", validation: { relation: "posts_author" } },
					{ slug: "legacy", type: "reference", validation: null },
					{ slug: "loose", type: "text", validation: { pattern: "", min: "1" as never } },
				],
```
with:
```ts
					{ slug: "qty", type: "integer", required: false, validation: { min: 0, max: 5 } },
					{ slug: "weird", type: "string", unsupportedType: { type: "geo", path: "type" } },
					{ slug: "author", type: "reference", validation: { relation: "posts_author" } },
					{
						slug: "related",
						type: "reference",
						validation: {
							relation: "posts_related",
							relationSide: "child",
							targetCollection: "posts",
							multiple: true,
						},
					},
					{ slug: "legacy", type: "reference", validation: null },
					{ slug: "loose", type: "text", validation: { pattern: "", min: "1" as never } },
				],
```

then replace
```ts
				validation: {},
				storageless: true,
			},
			{ slug: "legacy", type: "reference", required: false, hasDefault: false, validation: {} },
			{ slug: "loose", type: "text", required: false, hasDefault: false, validation: {} },
		]);
```
with:
```ts
				validation: {},
				storageless: true,
			},
			{
				slug: "related",
				type: "reference",
				required: false,
				hasDefault: false,
				validation: {},
				storageless: true,
				relationSide: "child",
				targetCollection: "posts",
				multiple: true,
			},
			{ slug: "legacy", type: "reference", required: false, hasDefault: false, validation: {} },
			{ slug: "loose", type: "text", required: false, hasDefault: false, validation: {} },
		]);
```

In `packages/flux-import/tests/unit/jobs.test.ts`, replace
```ts
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
```
with:
```ts
	});
});

describe("createJob with links", () => {
	const linked = {
		...template,
		fields: { title: { from: "Name", type: "text" }, maker: { from: "Maker", type: "reference" } },
		taxonomies: { category: { from: "Cat" }, tag: { from: "Tag", hierarchy: ">" } },
	};
	const linkedFields = [
		{ slug: "title", type: "string" },
		{
			slug: "maker",
			type: "reference",
			storageless: true,
			relationSide: "parent" as const,
			targetCollection: "makers",
		},
	];
	const taxonomies = [
		{ name: "category", hierarchical: true, collections: ["products"], locale: "en" },
		{ name: "tag", hierarchical: false, collections: ["products"], locale: "en" },
	];

	it("stores the taxonomy snapshot, the reference snapshot and the link warnings", async () => {
		const { deps } = setup("sku,Name,Maker,Cat,Tag\n");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: linked,
			schemaFields: linkedFields,
			linkSchema: { targets: { makers: [] }, taxonomies },
		});
		expect(job.taxonomies).toEqual({
			category: { hierarchical: true },
			tag: { hierarchical: false },
		});
		expect(job.targetFields?.maker).toEqual({
			type: "reference",
			required: false,
			relationSide: "parent",
			targetCollection: "makers",
		});
		expect(job.warnings).toEqual(['Taxonomy "tag" is flat; its "hierarchy" separator is ignored']);
		const plain = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(plain).not.toHaveProperty("taxonomies");
	});

	it("refuses a missing target collection and an unattached taxonomy", async () => {
		const { deps } = setup("sku,Name,Maker,Cat,Tag\n");
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: linked,
				schemaFields: linkedFields,
				linkSchema: { targets: { makers: null }, taxonomies: taxonomies.slice(1) },
			}),
		).rejects.toMatchObject({
			code: "invalid_template",
			details: [
				'Field "maker" links to collection "makers", which does not exist',
				'Taxonomy "category" does not exist',
			],
		});
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
		});
		expect(deps.jobs.rows.size).toBe(0);
	});
});

describe("staged upload lifecycle", () => {
```
with:
```ts
		});
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("reads each reference target's fields once, and taxonomy definitions only when mapped", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name,Maker,Brand,Cat\nS1,A,m,b,c\n");
		deps.lookups.defs.push({
			name: "category",
			hierarchical: true,
			collections: ["products"],
			locale: "en",
		});
		const looked: string[] = [];
		const lookup = async (collection: string) => {
			looked.push(collection);
			const ref = { type: "reference", storageless: true, relationSide: "parent" as const };
			if (collection === "products") {
				return [
					{ slug: "title", type: "string" },
					{ ...ref, slug: "maker", targetCollection: "makers" },
					{ ...ref, slug: "brand", targetCollection: "makers" },
					{ ...ref, slug: "unmapped", targetCollection: "others" },
				];
			}
			return collection === "makers" ? [{ slug: "flux_source_id", type: "string" }] : null;
		};
		const linked = {
			...template,
			fields: {
				title: { from: "Name", type: "text" },
				maker: { from: "Maker", type: "reference", match: "key" },
				brand: { from: "Brand", type: "reference" },
			},
			taxonomies: { category: { from: "Cat" } },
		};
		const job = await startJob(deps, { uploadId: "u1", template: linked, dryRun: true }, lookup);
		expect(looked).toEqual(["products", "makers"]);
		expect(deps.lookups.calls).toEqual(["defs"]);
		expect(job.taxonomies).toEqual({ category: { hierarchical: true } });
		deps.lookups.calls.length = 0;
		deps.source.add("u2", csv(1));
		await startJob(deps, { uploadId: "u2", template, dryRun: true }, fields);
		expect(deps.lookups.calls).toEqual([]);
	});
});

describe("staged upload lifecycle", () => {
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run template schema jobs service`
Expected: FAIL — 10 of 213 tests (the `schema` filter also runs `schema-apply.test.ts`, which passes). In `template.test.ts` six of the seven "checkTemplate for links" tests ("keeps refusing other mappings into a bound reference field" already passes through the M4a storage-less check); in `jobs.test.ts` both "createJob with links" tests (`JobError: The template does not fit the source or schema` and a missing snapshot); in `service.test.ts` "reads each reference target's fields once, and taxonomy definitions only when mapped"; in `schema.test.ts` "lists required, defaults, the enforced validation keys, unusable fields and relations" (no relation keys yet).

- [ ] **Step 3: Check links and store the snapshots**

In `packages/flux-import/src/engine/template.ts`, replace
```ts
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import {
	booleanConverter,
	type ConversionCode,
```
with:
```ts
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
	type ConversionCode,
```

then replace
```ts
	unsupported?: boolean;
	/** The field keeps its values outside the content table (a bound reference). */
	storageless?: boolean;
};

export const COMPATIBLE: Record<MappingType, string[]> = {
	text: ["string", "text", "url", "slug"],
```
with:
```ts
	unsupported?: boolean;
	/** The field keeps its values outside the content table (a bound reference). */
	storageless?: boolean;
	/** Reference fields: the end of the relation the field sits on. */
	relationSide?: "parent" | "child";
	/** Reference fields: the collection the field links to. */
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
};

/** What job creation reads besides the collection's fields, for links (M4b). */
export type LinkSchema = {
	/** The fields of each reference field's target collection; null when it does not exist. */
	targets?: Readonly<Record<string, SchemaField[] | null>>;
	/** Every taxonomy definition, in every locale. */
	taxonomies?: readonly TaxonomyDef[];
};

/** EmDash's guide to binding a reference field that predates relations. */
export const BIND_REFERENCE_DOCS =
	"https://docs.emdashcms.com/guides/relations/#bind-a-field-that-has-no-relation";

export const COMPATIBLE: Record<MappingType, string[]> = {
	text: ["string", "text", "url", "slug"],
```

then replace
```ts
	return new Set(options.filter((o) => o.toLowerCase() === lower)).size === 1;
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
```
with:
```ts
	return new Set(options.filter((o) => o.toLowerCase() === lower)).size === 1;
}

/**
 * Problems with a reference mapping: the field must be a reference bound to a relation, its
 * target collection must exist, and `match: "key"` needs entries imported into the target.
 */
function referenceProblems(
	field: string,
	mapping: Extract<FieldMapping, { type: "reference" }>,
	target: SchemaField,
	links: LinkSchema,
): string[] {
	if (target.type !== "reference") {
		return [
			`Field "${field}" has type "${target.type}"; a reference mapping needs one of reference`,
		];
	}
	const collection = target.targetCollection;
	if (!target.storageless || collection === undefined) {
		return [
			`Field "${field}" is a reference field without a relation; bind it first (${BIND_REFERENCE_DOCS})`,
		];
	}
	const targetFields = links.targets?.[collection];
	if (targetFields === null) {
		return [`Field "${field}" links to collection "${collection}", which does not exist`];
	}
	if (
		mapping.match === "key" &&
		targetFields !== undefined &&
		!targetFields.some((f) => f.slug === SOURCE_ID_FIELD)
	) {
		return [
			`Field "${field}" finds entries by import key, but no entries were imported into "${collection}"`,
		];
	}
	return [];
}

/** Problems with one mapping against its existing collection field. */
function fieldProblems(
	field: string,
	mapping: FieldMapping,
	target: SchemaField,
	siteTimezone: string,
	links: LinkSchema,
): string[] {
	if (target.unsupported) {
		return [`Field "${field}" has a field type this EmDash version cannot read`];
	}
	if (mapping.type === "reference") return referenceProblems(field, mapping, target, links);
	if (target.storageless) {
		return [`Field "${field}" keeps its values outside the content table and cannot be imported`];
	}
```

then replace
```ts
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, fields
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, and required fields with no
 * default that the template does not map (every create would fail).
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
	siteTimezone = "UTC",
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
```
with:
```ts
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, fields
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, and taxonomies that do not exist or are not attached
 * to the collection. The link checks run only on what `links` carries.
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
	siteTimezone = "UTC",
	links: LinkSchema = {},
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
```

then replace
```ts
		if (target === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else {
			errors.push(...fieldProblems(field, mapping, target, siteTimezone));
		}
	}
	for (const f of fields) {
```
with:
```ts
		if (target === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else {
			errors.push(...fieldProblems(field, mapping, target, siteTimezone, links));
		}
	}
	if (links.taxonomies !== undefined) {
		for (const name of Object.keys(t.taxonomies ?? {})) {
			// EmDash does not check attachment when it assigns terms, so the importer does.
			const defs = links.taxonomies.filter((d) => d.name === name);
			if (defs.length === 0) errors.push(`Taxonomy "${name}" does not exist`);
			else if (!defs.some((d) => d.collections.includes(t.collection))) {
				errors.push(`Taxonomy "${name}" is not attached to collection "${t.collection}"`);
			}
		}
	}
	for (const f of fields) {
```

then replace
```ts
			...(v.minLength === undefined ? {} : { minLength: v.minLength }),
			...(v.maxLength === undefined ? {} : { maxLength: v.maxLength }),
			...(v.pattern ? { pattern: v.pattern } : {}),
		};
	}
	return targets;
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
```
with:
```ts
			...(v.minLength === undefined ? {} : { minLength: v.minLength }),
			...(v.maxLength === undefined ? {} : { maxLength: v.maxLength }),
			...(v.pattern ? { pattern: v.pattern } : {}),
			...(f.relationSide === undefined ? {} : { relationSide: f.relationSide }),
			...(f.targetCollection === undefined ? {} : { targetCollection: f.targetCollection }),
			...(f.multiple === undefined ? {} : { multiple: f.multiple }),
		};
	}
	return targets;
}

/**
 * The definition of each mapped taxonomy that applies to the template: the one in its locale,
 * else the first. Run `checkTemplate` first; unknown taxonomies are skipped.
 */
function taxonomyDefsOf(t: Template, defs: readonly TaxonomyDef[]): Map<string, TaxonomyDef> {
	const found = new Map<string, TaxonomyDef>();
	for (const name of Object.keys(t.taxonomies ?? {})) {
		const named = defs.filter((d) => d.name === name);
		const def = named.find((d) => d.locale === t.locale) ?? named[0];
		if (def !== undefined) found.set(name, def);
	}
	return found;
}

/** The snapshot of each mapped taxonomy stored on the job (`Job.taxonomies`). */
export function taxonomiesOf(
	t: Template,
	defs: readonly TaxonomyDef[],
): Record<string, TaxonomySnapshot> {
	const snapshot: Record<string, TaxonomySnapshot> = {};
	for (const [name, def] of taxonomyDefsOf(t, defs)) {
		snapshot[name] = { hierarchical: def.hierarchical };
	}
	return snapshot;
}

/** Warnings for link mappings that work but do less than they say: `hierarchy` on a flat taxonomy. */
export function linkWarnings(t: Template, defs: readonly TaxonomyDef[]): string[] {
	const warnings: string[] = [];
	for (const [name, def] of taxonomyDefsOf(t, defs)) {
		if (!def.hierarchical && t.taxonomies?.[name]?.hierarchy !== undefined) {
			warnings.push(`Taxonomy "${name}" is flat; its "hierarchy" separator is ignored`);
		}
	}
	return warnings;
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
```

In `packages/flux-import/src/engine/types.ts`, replace
```ts
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, SourcePort } from "./ports.js";
import type { Template } from "./template.js";
import type { TargetField } from "./values.js";

export const BATCH_SIZE_DEFAULT = 50;
```
with:
```ts
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, SourcePort } from "./ports.js";
import type { TaxonomySnapshot, Template } from "./template.js";
import type { TargetField } from "./values.js";

export const BATCH_SIZE_DEFAULT = 50;
```

then replace
```ts
	targetFields?: Record<string, TargetField>;
	/** The site timezone read at job creation, for `tz: "site"`; absent before M4a (UTC). */
	siteTimezone?: string;
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
```
with:
```ts
	targetFields?: Record<string, TargetField>;
	/** The site timezone read at job creation, for `tz: "site"`; absent before M4a (UTC). */
	siteTimezone?: string;
	/** The mapped taxonomies as they were at job creation; absent when none are mapped. */
	taxonomies?: Record<string, TaxonomySnapshot>;
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
```

In `packages/flux-import/src/engine/jobs.ts`, replace
```ts
import {
	checkTemplate,
	compileTemplate,
	missingPathWarnings,
	noRecordsWarning,
	type SchemaField,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
	unresolvedPaths,
```
with:
```ts
import {
	checkTemplate,
	compileTemplate,
	type LinkSchema,
	linkWarnings,
	missingPathWarnings,
	noRecordsWarning,
	type SchemaField,
	type Template,
	targetFieldsOf,
	taxonomiesOf,
	templatePaths,
	templateSchema,
	unresolvedPaths,
```

then replace
```ts
	warnings?: string[];
	/** The site's timezone setting, for templates with `tz: "site"`; UTC when absent. */
	siteTimezone?: string;
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
```
with:
```ts
	warnings?: string[];
	/** The site's timezone setting, for templates with `tz: "site"`; UTC when absent. */
	siteTimezone?: string;
	/** Reference targets' fields and the taxonomy definitions, for the link checks. */
	linkSchema?: LinkSchema;
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
```

then replace
```ts
	}

	const siteTimezone = usesSiteTimezone(template) ? (input.siteTimezone ?? "UTC") : undefined;
	const problems = checkTemplate(template, input.schemaFields, columns, siteTimezone);
	if (problems.length > 0) {
		throw new JobError(
			"invalid_template",
```
with:
```ts
	}

	const siteTimezone = usesSiteTimezone(template) ? (input.siteTimezone ?? "UTC") : undefined;
	const linkSchema = input.linkSchema ?? {};
	const problems = checkTemplate(template, input.schemaFields, columns, siteTimezone, linkSchema);
	if (problems.length > 0) {
		throw new JobError(
			"invalid_template",
```

then replace
```ts
			: await asJobError(() =>
					sampleWarnings(deps, reader, template, input.uploadId, located.bodyOffset),
				);
	const warnings = [...(input.warnings ?? []), ...sampled];

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
```
with:
```ts
			: await asJobError(() =>
					sampleWarnings(deps, reader, template, input.uploadId, located.bodyOffset),
				);
	const taxonomyDefs = linkSchema.taxonomies ?? [];
	const warnings = [...(input.warnings ?? []), ...sampled, ...linkWarnings(template, taxonomyDefs)];

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
```

then replace
```ts
		warnings,
		targetFields: targetFieldsOf(template, input.schemaFields),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
```
with:
```ts
		warnings,
		targetFields: targetFieldsOf(template, input.schemaFields),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		...(template.taxonomies === undefined
			? {}
			: { taxonomies: taxonomiesOf(template, taxonomyDefs) }),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
```

In `packages/flux-import/src/emdash/schema.ts`, replace
```ts
	type: string;
	required?: boolean;
	defaultValue?: unknown;
	validation?: (FieldRules & { relation?: string | undefined }) | null | undefined;
	unsupportedType?: unknown;
}

```
with:
```ts
	type: string;
	required?: boolean;
	defaultValue?: unknown;
	validation?:
		| (FieldRules & {
				relation?: string | undefined;
				relationSide?: string | undefined;
				targetCollection?: string | undefined;
				multiple?: boolean | undefined;
		  })
		| null
		| undefined;
	unsupportedType?: unknown;
}

```

then replace
```ts
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
with:
```ts
	return rules;
}

/** A reference field's relation keys (`emdash` src/schema/types.ts:107-125), as given. */
function relationOf(
	f: RegistryField,
): Pick<SchemaField, "relationSide" | "targetCollection" | "multiple"> {
	const v = f.validation ?? {};
	return {
		...(v.relationSide === "parent" || v.relationSide === "child"
			? { relationSide: v.relationSide }
			: {}),
		...(typeof v.targetCollection === "string" && v.targetCollection !== ""
			? { targetCollection: v.targetCollection }
			: {}),
		...(typeof v.multiple === "boolean" ? { multiple: v.multiple } : {}),
	};
}

/**
 * The collection's fields for `checkTemplate` and the job's target snapshot, or `null` when the
 * collection does not exist: type, `required`, whether it has a default, the validation keys
 * EmDash enforces, whether EmDash cannot read its type or keeps its values elsewhere (a
 * reference bound to a relation, `isStoragelessField` in src/schema/types.ts:120-125), and a
 * reference field's relation side, target collection and `multiple`.
 */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
```

then replace
```ts
			...(f.type === "reference" && typeof relation === "string" && relation !== ""
				? { storageless: true }
				: {}),
		};
	});
}
```
with:
```ts
			...(f.type === "reference" && typeof relation === "string" && relation !== ""
				? { storageless: true }
				: {}),
			...(f.type === "reference" ? relationOf(f) : {}),
		};
	});
}
```

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import type { SchemaField } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```
with:
```ts
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import type { LinkSchema, SchemaField } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```

then replace
```ts
	return stageUpload(storage, new Blob([bytes]).stream(), PASTE_MAX_BYTES, bytes.byteLength);
}

export type StartJobInput = Omit<CreateJobInput, "schemaFields">;
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;
export type LocaleResolver = (locale: string) => LocaleResolution;

```
with:
```ts
	return stageUpload(storage, new Blob([bytes]).stream(), PASTE_MAX_BYTES, bytes.byteLength);
}

export type StartJobInput = Omit<CreateJobInput, "schemaFields" | "linkSchema">;
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;
export type LocaleResolver = (locale: string) => LocaleResolution;

```

then replace
```ts
	return { ...template, locale: resolved.locale };
}

/** Creates a job after resolving the template locale and reading the target collection's fields. */
export async function startJob(
	deps: EngineDeps,
	input: StartJobInput,
```
with:
```ts
	return { ...template, locale: resolved.locale };
}

/** The value of `key` on an object, or undefined. */
function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/**
 * What the link checks read, once per job creation: the fields of every collection a mapped
 * reference field links to, and the taxonomy definitions when the template maps taxonomies.
 * The template is not parsed yet, so shapes are checked loosely; createJob reports bad ones.
 */
async function linkSchemaFor(
	deps: EngineDeps,
	template: unknown,
	fields: SchemaField[],
	lookupFields: FieldLookup,
): Promise<LinkSchema> {
	const mapped = prop(template, "fields");
	const targets: Record<string, SchemaField[] | null> = {};
	for (const f of fields) {
		const target = f.targetCollection;
		if (target === undefined || Object.hasOwn(targets, target)) continue;
		if (prop(prop(mapped, f.slug), "type") !== "reference") continue;
		targets[target] = await lookupFields(target);
	}
	const taxonomies = prop(template, "taxonomies");
	const mapsTaxonomies = typeof taxonomies === "object" && taxonomies !== null;
	return { targets, taxonomies: mapsTaxonomies ? await deps.lookups.taxonomyDefs() : [] };
}

/**
 * Creates a job after resolving the template locale and reading the target collection's fields,
 * its reference targets' fields and, for templates that map taxonomies, the taxonomy definitions.
 */
export async function startJob(
	deps: EngineDeps,
	input: StartJobInput,
```

then replace
```ts
	if (schemaFields === null) {
		throw new JobError("invalid_template", `Collection "${collection}" does not exist`);
	}
	return createJob(deps, { ...input, template, schemaFields });
}

export async function getJob(deps: EngineDeps, id: string): Promise<Job> {
```
with:
```ts
	if (schemaFields === null) {
		throw new JobError("invalid_template", `Collection "${collection}" does not exist`);
	}
	const linkSchema = await linkSchemaFor(deps, template, schemaFields, lookupFields);
	return createJob(deps, { ...input, template, schemaFields, linkSchema });
}

export async function getJob(deps: EngineDeps, id: string): Promise<Job> {
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run template schema jobs service`
Expected: PASS (213 tests: 114 in `template.test.ts`, 44 in `jobs.test.ts`, 28 in `service.test.ts`, 6 in `schema.test.ts`, 21 in `schema-apply.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 41 files / 1,061 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/emdash/schema.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/schema.test.ts packages/flux-import/tests/unit/jobs.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Check link mappings against reference targets and taxonomies at job creation, and store their snapshots"
```

### Task 4: Content port: link read-back and link writes

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/emdash/content.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/content.test.ts`

**Interfaces:**
- Consumes: Task 2 (`EntrySnapshot.group`, `writeError`, `FakeLookups`); spec F1, F7, F10, F12; V2, V3.
- Produces:
  - `src/engine/ports.ts`: `type LinkedEntry = { group; id }`, `type BylineCredit = { group; id; slug; roleLabel }`, `type LinkWrites = { taxonomies?; references?; bylines? }`, `type GetOptions = { references?: boolean }`; `EntrySnapshot.references?`/`bylines?`; `ContentPort.get(collection, locale, id, options?)`, `findBySourceId(collection, locale, key, options?)`; `create(input & LinkWrites)`; `update(input & LinkWrites)` with `data` optional.
  - `src/emdash/content.ts`: `get` passes `{ includeDrafts: true }` only with `references`; snapshots carry references and explicit bylines; writes pass the links.
  - `tests/unit/fakes.ts`: `FakeContent` stores and reads back links (`linkWrites`, `bylineSlug`); a links-only update sets no pending publish; `FakeLookups.entryTerms` reads `FakeContent`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/content.test.ts`, replace
```ts
	});
});

```
with:
```ts
	});
});

describe("EmDashContent links", () => {
	const credit = (id: string, slug: string, source: string, roleLabel: string | null = null) => ({
		byline: { id, slug, displayName: slug, translationGroup: `g-${id}` },
		sortOrder: 0,
		roleLabel,
		source,
	});

	it("reads reference selections with drafts only when asked, and explicit bylines always", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "posts", locale: "en", data: { title: "A" } });
		const gets: unknown[][] = [];
		const base = runtime.handleContentGet.bind(runtime);
		runtime.handleContentGet = async (c: string, id: string, ...rest: unknown[]) => {
			gets.push([c, id, ...rest]);
			const result = await base(c, id);
			const item = (result.data as { item: Record<string, unknown> }).item;
			item.bylines = [credit("b1", "alex", "explicit", "Editor"), credit("b2", "sam", "explicit")];
			if (rest[1]) {
				item.references = {
					related: {
						children: [
							{ id: "p2", slug: "two", translationGroup: "g2" },
							{ id: "p3", slug: "three", translationGroup: null },
						],
						nextCursor: "c",
					},
				};
			}
			return result;
		};
		const plain = await content.get("posts", "en", "e1");
		expect(plain).not.toHaveProperty("references");
		expect(plain?.bylines).toEqual([
			{ group: "g-b1", id: "b1", slug: "alex", roleLabel: "Editor" },
			{ group: "g-b2", id: "b2", slug: "sam", roleLabel: null },
		]);
		const linked = await content.get("posts", "en", "e1", { references: true });
		expect(linked?.references).toEqual({
			related: [
				{ group: "g2", id: "p2" },
				{ group: "p3", id: "p3" },
			],
		});
		expect(gets).toEqual([
			["posts", "e1", "en"],
			["posts", "e1", "en", { includeDrafts: true }],
		]);
		await content.create({ collection: "posts", locale: "en", data: { flux_source_id: "S1" } });
		const found = await content.findBySourceId("posts", "en", "S1", { references: true });
		expect(found?.references).toEqual(linked?.references);
	});

	it("leaves out an inferred byline, which the entry was not given", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "posts", locale: "en", data: { title: "A" } });
		const base = runtime.handleContentGet.bind(runtime);
		runtime.handleContentGet = async (c: string, id: string) => {
			const result = await base(c, id);
			(result.data as { item: Record<string, unknown> }).item.bylines = [
				credit("b9", "owner", "inferred"),
			];
			return result;
		};
		expect((await content.get("posts", "en", "e1"))?.bylines).toEqual([]);
	});

	it("sends links on create and update, and leaves data out of an update without it", async () => {
		const { runtime, content } = setup();
		await content.create({
			collection: "posts",
			locale: "en",
			data: { title: "A" },
			taxonomies: { category: ["news"] },
			references: { related: ["p2"] },
			bylines: [{ bylineId: "b1", roleLabel: null }],
		});
		expect(runtime.calls[0]).toEqual([
			"create",
			"posts",
			{
				data: { title: "A" },
				locale: "en",
				authorId: "u1",
				actor,
				taxonomies: { category: ["news"] },
				references: { related: ["p2"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		]);
		await content.update({
			collection: "posts",
			locale: "en",
			id: "e1",
			rev: "rev-1",
			taxonomies: { category: [] },
		});
		expect(runtime.calls[1]).toEqual([
			"update",
			"posts",
			"e1",
			{ locale: "en", _rev: "rev-1", actor, taxonomies: { category: [] } },
		]);
	});
});

```

In `packages/flux-import/tests/unit/fakes.ts`, replace
```ts
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type KvCollection,
	type LookupPort,
	SourceMissingError,
	type SourcePort,
```
with:
```ts
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type KvCollection,
	type LinkWrites,
	type LookupPort,
	SourceMissingError,
	type SourcePort,
```

then replace
```ts
	data: Record<string, unknown>;
	rev: number;
	pendingPublish: boolean;
};

export class FakeContent implements ContentPort {
```
with:
```ts
	data: Record<string, unknown>;
	rev: number;
	pendingPublish: boolean;
	/** Term slugs by taxonomy, entry IDs by reference field, byline credits: as written. */
	taxonomies: Record<string, string[]>;
	references: Record<string, string[]>;
	bylines: { bylineId: string; roleLabel: string | null }[];
};

export class FakeContent implements ContentPort {
```

then replace
```ts
	afterWrite: (id: string) => void = () => {};
	/** Return a ContentWriteError to make a write with this data fail. */
	failWrite: (data: Record<string, unknown>) => ContentWriteError | null = () => null;
	/** Return a reason to make publishing this entry fail. */
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	private next = 0;

	private snap(e: StoredEntry): EntrySnapshot {
		return {
			id: e.id,
			rev: String(e.rev),
```
with:
```ts
	afterWrite: (id: string) => void = () => {};
	/** Return a ContentWriteError to make a write with this data fail. */
	failWrite: (data: Record<string, unknown>) => ContentWriteError | null = () => null;
	/** A byline's slug, for read-back; `makeDeps` answers from its `FakeLookups`. */
	bylineSlug: (id: string) => string = (id) => id;
	/** Every write's links, as given. */
	readonly linkWrites: LinkWrites[] = [];
	/** Return a reason to make publishing this entry fail. */
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	private next = 0;

	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
			rev: String(e.rev),
```

then replace
```ts
			data: structuredClone(e.data),
			group: e.id,
			pendingPublish: e.pendingPublish,
		};
	}
	async get(collection: string, locale: string, id: string) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale ? this.snap(e) : null;
	}
	async findBySourceId(collection: string, locale: string, sourceId: string) {
		this.calls.push(`find:${sourceId}`);
		for (const e of this.entries.values()) {
			if (
```
with:
```ts
			data: structuredClone(e.data),
			group: e.id,
			pendingPublish: e.pendingPublish,
			...(options.references
				? {
						references: Object.fromEntries(
							Object.entries(e.references).map(([f, ids]) => [
								f,
								ids.map((id) => ({ group: id, id })),
							]),
						),
					}
				: {}),
			bylines: e.bylines.map((b) => ({
				group: b.bylineId,
				id: b.bylineId,
				slug: this.bylineSlug(b.bylineId),
				roleLabel: b.roleLabel,
			})),
		};
	}
	async get(collection: string, locale: string, id: string, options?: GetOptions) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale ? this.snap(e, options) : null;
	}
	async findBySourceId(collection: string, locale: string, sourceId: string, options?: GetOptions) {
		this.calls.push(`find:${sourceId}`);
		for (const e of this.entries.values()) {
			if (
```

then replace
```ts
				e.locale === locale &&
				e.data.flux_source_id === sourceId
			) {
				return this.snap(e);
			}
		}
		return null;
	}
	async isLocked(_c: string, _l: string, id: string) {
		return this.locked.has(id);
	}
	async create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, unknown>;
	}) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const id = `e${++this.next}`;
		this.entries.set(id, {
			id,
			collection: input.collection,
			locale: input.locale,
```
with:
```ts
				e.locale === locale &&
				e.data.flux_source_id === sourceId
			) {
				return this.snap(e, options);
			}
		}
		return null;
	}
	/** Writes the links given; each replaces that link's value. */
	private writeLinks(e: StoredEntry, input: LinkWrites) {
		const links: LinkWrites = {
			...(input.taxonomies ? { taxonomies: input.taxonomies } : {}),
			...(input.references ? { references: input.references } : {}),
			...(input.bylines ? { bylines: input.bylines } : {}),
		};
		this.linkWrites.push(structuredClone(links));
		Object.assign(e.taxonomies, structuredClone(input.taxonomies ?? {}));
		Object.assign(e.references, structuredClone(input.references ?? {}));
		if (input.bylines) e.bylines = structuredClone(input.bylines);
	}
	async isLocked(_c: string, _l: string, id: string) {
		return this.locked.has(id);
	}
	async create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, unknown>;
		} & LinkWrites,
	) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const id = `e${++this.next}`;
		const entry: StoredEntry = {
			id,
			collection: input.collection,
			locale: input.locale,
```

then replace
```ts
			data: structuredClone(input.data),
			rev: 1,
			pendingPublish: true,
		});
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: "1" };
	}
	async update(input: {
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, unknown>;
	}): Promise<WriteResult> {
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		e.data = { ...e.data, ...structuredClone(input.data) };
		if (input.slug !== undefined) e.slug = input.slug;
		e.rev++;
		e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
```
with:
```ts
			data: structuredClone(input.data),
			rev: 1,
			pendingPublish: true,
			taxonomies: {},
			references: {},
			bylines: [],
		};
		this.writeLinks(entry, input);
		this.entries.set(id, entry);
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: "1" };
	}
	async update(
		input: {
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, unknown>;
		} & LinkWrites,
	): Promise<WriteResult> {
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		e.data = { ...e.data, ...structuredClone(input.data ?? {}) };
		if (input.slug !== undefined) e.slug = input.slug;
		this.writeLinks(e, input);
		e.rev++;
		// As EmDash on revisioned collections: terms and bylines are live metadata (no draft).
		if (input.data !== undefined || input.slug !== undefined || input.references) {
			e.pendingPublish = true;
		}
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
```

then replace
```ts
type StoredTerm = TermInfo & { taxonomy: string; locale: string };

/**
 * In-memory `LookupPort`: terms and bylines added by tests (a term's group is its ID), entries
 * from the `FakeContent` (an entry's group is its ID), and entry terms set by tests.
 */
export class FakeLookups implements LookupPort {
	readonly defs: TaxonomyDef[] = [];
	readonly storedTerms: StoredTerm[] = [];
	readonly storedBylines: (BylineRef & { locale: string })[] = [];
	/** Entry terms by entry ID: term groups by taxonomy. */
	readonly assigned = new Map<string, Record<string, string[]>>();
	readonly calls: string[] = [];
	/** Return an error to make creating this term fail. */
	failCreate: (taxonomy: string, input: { label: string; slug?: string }) => Error | null = () =>
```
with:
```ts
type StoredTerm = TermInfo & { taxonomy: string; locale: string };

/**
 * In-memory `LookupPort`: terms and bylines added by tests (a term's group is its ID), and
 * entries and entry terms from the `FakeContent` (an entry's group is its ID).
 */
export class FakeLookups implements LookupPort {
	readonly defs: TaxonomyDef[] = [];
	readonly storedTerms: StoredTerm[] = [];
	readonly storedBylines: (BylineRef & { locale: string })[] = [];
	readonly calls: string[] = [];
	/** Return an error to make creating this term fail. */
	failCreate: (taxonomy: string, input: { label: string; slug?: string }) => Error | null = () =>
```

then replace
```ts
		return this.addTerm(taxonomy, slug, input.label, parentSlug, input.locale);
	}

	async entryTerms(_collection: string, entryId: string) {
		this.calls.push(`entryTerms:${entryId}`);
		return structuredClone(this.assigned.get(entryId) ?? {});
	}

	/** Pages of two, so tests see the cursor. */
```
with:
```ts
		return this.addTerm(taxonomy, slug, input.label, parentSlug, input.locale);
	}

	/** The groups of the term slugs the `FakeContent` entry was given, by taxonomy. */
	async entryTerms(_collection: string, entryId: string) {
		this.calls.push(`entryTerms:${entryId}`);
		const e = this.content.entries.get(entryId);
		const groups: Record<string, string[]> = {};
		for (const [taxonomy, slugs] of Object.entries(e?.taxonomies ?? {})) {
			if (slugs.length === 0) continue;
			groups[taxonomy] = slugs.map((slug) => {
				const term = this.storedTerms.find(
					(t) => t.taxonomy === taxonomy && t.locale === e?.locale && t.slug === slug,
				);
				return term?.group ?? `unknown:${slug}`;
			});
		}
		return groups;
	}

	/** Pages of two, so tests see the cursor. */
```

then replace
```ts
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content,
		lookups: new FakeLookups(content),
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```
with:
```ts
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	const lookups = new FakeLookups(content);
	content.bylineSlug = (id) => lookups.storedBylines.find((b) => b.id === id)?.slug ?? id;
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content,
		lookups,
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run content`
Expected: FAIL — 3 of 15 tests in `content.test.ts`: the three "EmDashContent links" tests (no `references` or `bylines` on the snapshot, `includeDrafts` never passed, and links not sent with the writes).

- [ ] **Step 3: Read and write links**

In `packages/flux-import/src/engine/ports.ts`, replace
```ts
	}): Promise<{ items: { id: string; data: T }[]; cursor?: string; hasMore: boolean }>;
}

/** `rev`, `slug` and `data` reflect the latest revision, draft included. */
export interface EntrySnapshot {
	id: string;
```
with:
```ts
	}): Promise<{ items: { id: string; data: T }[]; cursor?: string; hasMore: boolean }>;
}

/** A linked entry as read back: its translation group and the ID of the variant read. */
export type LinkedEntry = { group: string; id: string };

/** An explicit byline credit as read back, in credit order. */
export type BylineCredit = { group: string; id: string; slug: string; roleLabel: string | null };

/** Links a write assigns; each one given replaces that link's current value. */
export type LinkWrites = {
	/** Term slugs in the entry's locale, by taxonomy. */
	taxonomies?: Record<string, string[]>;
	/** Target entry IDs, by reference field. */
	references?: Record<string, string[]>;
	bylines?: { bylineId: string; roleLabel: string | null }[];
};

/** `rev`, `slug` and `data` reflect the latest revision, draft included. */
export interface EntrySnapshot {
	id: string;
```

then replace
```ts
	 * live immediately, so only an unpublished status counts there.
	 */
	pendingPublish: boolean;
}

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null>;
	/** Throws `ContentWriteError("ambiguous_source_id", …)` when more than one entry matches. */
	findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null>;
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<{ id: string; rev: string }>;
	/** On revisioned collections this stages a draft; `publish` makes it live. */
	update(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<WriteResult>;
	/**
	 * Makes the given revision live. On collections without revisions this succeeds as a no-op
	 * returning the current revision.
```
with:
```ts
	 * live immediately, so only an unpublished status counts there.
	 */
	pendingPublish: boolean;
	/**
	 * Each reference field's selection (the first 50), a staged draft selection first; only when
	 * read with `references`.
	 */
	references?: Record<string, LinkedEntry[]>;
	/** The entry's explicit byline credits in its locale (not the author fallback). */
	bylines?: BylineCredit[];
}

/** `references`: also read every reference field's selection, drafts included. */
export type GetOptions = { references?: boolean };

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(
		collection: string,
		locale: string,
		id: string,
		options?: GetOptions,
	): Promise<EntrySnapshot | null>;
	/** Throws `ContentWriteError("ambiguous_source_id", …)` when more than one entry matches. */
	findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
		options?: GetOptions,
	): Promise<EntrySnapshot | null>;
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }>;
	/**
	 * On revisioned collections `data`, `slug` and `references` are staged as a draft, which
	 * `publish` makes live; `taxonomies` and `bylines` are written live at once (EmDash).
	 * Without `data` no data field is written.
	 */
	update(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<WriteResult>;
	/**
	 * Makes the given revision live. On collections without revisions this succeeds as a no-op
	 * returning the current revision.
```

In `packages/flux-import/src/emdash/content.ts`, replace
```ts
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
```
with:
```ts
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
```

then replace
```ts
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
	handleContentGet(collection: string, id: string, locale?: string): Promise<HandlerResult>;
	handleContentList(
		collection: string,
		params: { locale?: string; limit?: number; fieldFilters?: ContentFieldFilters },
```
with:
```ts
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
	handleContentGet(
		collection: string,
		id: string,
		locale?: string,
		referenceOptions?: { includeDrafts: boolean },
	): Promise<HandlerResult>;
	handleContentList(
		collection: string,
		params: { locale?: string; limit?: number; fieldFilters?: ContentFieldFilters },
```

then replace
```ts
			locale?: string;
			authorId?: string;
			actor?: ActorInfo;
		},
	): Promise<HandlerResult>;
	handleContentUpdate(
		collection: string,
```
with:
```ts
			locale?: string;
			authorId?: string;
			actor?: ActorInfo;
		} & LinkWrites,
	): Promise<HandlerResult>;
	handleContentUpdate(
		collection: string,
```

then replace
```ts
			locale?: string;
			_rev?: string;
			actor?: ActorInfo;
		},
	): Promise<HandlerResult>;
	handleContentPublish(
		collection: string,
```
with:
```ts
			locale?: string;
			_rev?: string;
			actor?: ActorInfo;
		} & LinkWrites,
	): Promise<HandlerResult>;
	handleContentPublish(
		collection: string,
```

then replace
```ts
/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;

/** `{ item, _rev }` from get, create, update and publish (src/api/handlers/content.ts:1135). */
const itemResult = z.object({
	item: z.object({
```
with:
```ts
/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;

/** One reference field's first page (src/api/handlers/content.ts:382-480). */
const referencePage = z.object({
	children: z.array(
		z.object({ id: z.string(), translationGroup: z.string().nullable().optional() }),
	),
});

/** A byline credit as `hydrateBylines` gives it (src/api/handlers/content.ts:312-353). */
const bylineCredit = z.object({
	byline: z.object({
		id: z.string(),
		slug: z.string(),
		translationGroup: z.string().nullable().optional(),
	}),
	roleLabel: z.string().nullable().optional(),
	source: z.string().optional(),
});

/** `{ item, _rev }` from get, create, update and publish (src/api/handlers/content.ts:1135). */
const itemResult = z.object({
	item: z.object({
```

then replace
```ts
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
	}),
	_rev: z.string(),
});
```
with:
```ts
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
		references: z.record(z.string(), referencePage).optional(),
		bylines: z.array(bylineCredit).optional(),
	}),
	_rev: z.string(),
});
```

then replace
```ts
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
	};
}

```
with:
```ts
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
		...(item.references === undefined
			? {}
			: {
					references: Object.fromEntries(
						Object.entries(item.references).map(([field, page]) => [
							field,
							page.children.map((c) => ({ group: c.translationGroup ?? c.id, id: c.id })),
						]),
					),
				}),
		...(item.bylines === undefined
			? {}
			: {
					// An inferred credit (the author's byline) is not one the entry was given.
					bylines: item.bylines
						.filter((c) => c.source !== "inferred")
						.map((c) => ({
							group: c.byline.translationGroup ?? c.byline.id,
							id: c.byline.id,
							slug: c.byline.slug,
							roleLabel: c.roleLabel ?? null,
						})),
				}),
	};
}

/** The links of a write, without the ones not given. */
function linksOf(input: LinkWrites): LinkWrites {
	return {
		...(input.taxonomies === undefined ? {} : { taxonomies: input.taxonomies }),
		...(input.references === undefined ? {} : { references: input.references }),
		...(input.bylines === undefined ? {} : { bylines: input.bylines }),
	};
}

```

then replace
```ts
		private readonly lockReader: LockReader,
	) {}

	async get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentGet(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
```
with:
```ts
		private readonly lockReader: LockReader,
	) {}

	/**
	 * With `references`, every reference field's selection is read as an editor sees it: a
	 * selection staged in a draft first (`includeDrafts`, src/api/handlers/content.ts:360-480).
	 */
	async get(
		collection: string,
		locale: string,
		id: string,
		options: GetOptions = {},
	): Promise<EntrySnapshot | null> {
		const result = options.references
			? await this.runtime.handleContentGet(collection, id, locale, { includeDrafts: true })
			: await this.runtime.handleContentGet(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
```

then replace
```ts
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentList(collection, {
			locale,
```
with:
```ts
		collection: string,
		locale: string,
		sourceId: string,
		options: GetOptions = {},
	): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentList(collection, {
			locale,
```

then replace
```ts
			);
		}
		const [only] = items;
		return only ? this.get(collection, locale, only.id) : null;
	}

	isLocked(collection: string, _locale: string, id: string): Promise<boolean> {
		return this.lockReader(collection, id, this.actor.id);
	}

	async create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<{ id: string; rev: string }> {
		const result = await this.runtime.handleContentCreate(input.collection, {
			data: input.data,
			locale: input.locale,
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
		const { id, rev } = snapshotOf(result.data, "Creating the entry");
		return { id, rev };
	}

	async update(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<WriteResult> {
		const result = await this.runtime.handleContentUpdate(input.collection, input.id, {
			data: input.data,
			locale: input.locale,
			_rev: input.rev,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
```
with:
```ts
			);
		}
		const [only] = items;
		return only ? this.get(collection, locale, only.id, options) : null;
	}

	isLocked(collection: string, _locale: string, id: string): Promise<boolean> {
		return this.lockReader(collection, id, this.actor.id);
	}

	async create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }> {
		const result = await this.runtime.handleContentCreate(input.collection, {
			data: input.data,
			locale: input.locale,
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...linksOf(input),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
		const { id, rev } = snapshotOf(result.data, "Creating the entry");
		return { id, rev };
	}

	async update(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<WriteResult> {
		const result = await this.runtime.handleContentUpdate(input.collection, input.id, {
			...(input.data === undefined ? {} : { data: input.data }),
			locale: input.locale,
			_rev: input.rev,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...linksOf(input),
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run content`
Expected: PASS (15 tests). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 41 files / 1,064 tests in numeric order, or 41 / 1,054 on Tasks 1 and 2 alone).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/content.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/content.test.ts
git commit -m "Read reference selections and bylines back and write links through the content port"
```

### Task 5: Resolver and per-batch cache

**Files:**
- Create: `packages/flux-import/src/engine/resolve.ts`
- Test: `packages/flux-import/tests/unit/resolve.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`LinkRequests`, `ResolvedItem`, `ResolvedLinks`, `TaxonomySnapshot`, `TermRequest`, `slugify`), Task 2 (`LookupPort`, `TermInfo`, `BylineRef`, `FakeLookups`); `ContentPort.get`/`findBySourceId`, `ContentWriteError`, `linkKey`; V1, E5, E6.
- Produces (`src/engine/resolve.ts`): `MAX_BYLINE_LOOKUP` (5,000); `type ResolveDeps = { lookups; content; links }`; `type ResolveContext = { template; targets; taxonomies; dryRun; plannedKey? }`; `type LinkError`; `type Resolution = { ok: true; links; newTerms } | { ok: false; errors; newTerms }`; `class LookupCache`; `resolveLinks(deps, cache, ctx, requests): Promise<Resolution>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/resolve.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { LinkRequests } from "../../src/engine/links.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import {
	LookupCache,
	MAX_BYLINE_LOOKUP,
	type ResolveContext,
	resolveLinks,
} from "../../src/engine/resolve.js";
import { templateSchema } from "../../src/engine/template.js";
import { linkKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Options = {
	category?: Record<string, unknown>;
	tag?: Record<string, unknown>;
	bylines?: Record<string, unknown>;
	dryRun?: boolean;
};

function setup(o: Options = {}) {
	const { deps } = makeDeps();
	const template = templateSchema.parse({
		version: 1,
		collection: "posts",
		locale: "en",
		key: { from: "id" },
		fields: {
			title: { from: "Title", type: "text" },
			maker: { from: "Maker", type: "reference" },
			related: { from: "Related", type: "reference", match: "slug" },
			author: { from: "Author", type: "reference", match: "key" },
		},
		taxonomies: {
			category: { from: "Categories", ...o.category },
			tag: { from: "Tags", ...o.tag },
		},
		bylines: { from: "Authors", ...o.bylines },
	});
	const ref = (targetCollection: string) => ({
		type: "reference",
		required: false,
		relationSide: "parent" as const,
		multiple: true,
		targetCollection,
	});
	const ctx: ResolveContext = {
		template,
		targets: { maker: ref("makers"), related: ref("posts"), author: ref("people") },
		taxonomies: { category: { hierarchical: true }, tag: { hierarchical: false } },
		dryRun: o.dryRun ?? false,
	};
	const cache = new LookupCache();
	const resolve = (links: LinkRequests) => resolveLinks(deps, cache, ctx, links);
	return { deps, cache, ctx, resolve };
}

const paths = (...items: string[]) => items.map((i) => ({ path: i.split("/") }));

/** A category tree: electronics/phones, electronics/laptops, news, and phones' child "cases". */
function tree(deps: ReturnType<typeof makeDeps>["deps"]) {
	const l = deps.lookups;
	return {
		electronics: l.addTerm("category", "electronics", "Electronics"),
		phones: l.addTerm("category", "phones", "Phones", "electronics"),
		laptops: l.addTerm("category", "laptops", "Laptops", "electronics"),
		cases: l.addTerm("category", "cases", "Cases", "phones"),
		news: l.addTerm("category", "news", "News"),
		rock: l.addTerm("tag", "rock", "Rock"),
		acdc: l.addTerm("tag", "ac-dc", "AC/DC"),
	};
}

describe("resolveLinks: terms by slug", () => {
	it("finds flat slugs, paths from a root, and one segment at any depth", async () => {
		const { deps, resolve } = setup();
		const t = tree(deps);
		const result = await resolve({
			taxonomies: {
				category: paths("electronics/phones", "cases", "news"),
				tag: [{ path: ["ac-dc"] }],
			},
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				taxonomies: {
					category: [
						{ group: t.phones.group, value: "phones", text: "electronics/phones" },
						{ group: t.cases.group, value: "cases", text: "electronics/phones/cases" },
						{ group: t.news.group, value: "news", text: "news" },
					],
					tag: [{ group: t.acdc.group, value: "ac-dc", text: "ac-dc" }],
				},
			},
		});
	});

	it("fails a missing slug and a slug under another parent", async () => {
		const { deps, resolve } = setup();
		tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("news/phones", "electronics/tablets", "phones/cases/x") },
		});
		expect(!result.ok && result.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "term_path_mismatch",
				message: 'Term "phones" in "category" is at "electronics/phones", not under "news/phones"',
			},
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term with the slug "electronics/tablets" in "category"',
			},
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term with the slug "phones/cases/x" in "category"',
			},
		]);
		const root = await resolve({ taxonomies: { category: paths("phones/cases") } });
		expect(!root.ok && root.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
	});

	it("loads each taxonomy's terms once per batch", async () => {
		const { deps, resolve } = setup();
		tree(deps);
		await resolve({ taxonomies: { category: paths("news"), tag: paths("rock") } });
		await resolve({ taxonomies: { category: paths("electronics") } });
		expect(deps.lookups.calls).toEqual(["terms:category:en", "terms:tag:en"]);
	});
});

describe("resolveLinks: terms by label", () => {
	it("walks from the roots, matching exactly and then ignoring case", async () => {
		const { deps, resolve } = setup({ category: { match: "label" }, tag: { match: "label" } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: {
				category: paths("Electronics/phones", "NEWS"),
				tag: [{ path: ["ac/dc"] }],
			},
		});
		expect(result.ok && result.links.taxonomies).toEqual({
			category: [
				{ group: t.phones.group, value: "phones", text: "electronics/phones" },
				{ group: t.news.group, value: "news", text: "news" },
			],
			tag: [{ group: t.acdc.group, value: "ac-dc", text: "ac-dc" }],
		});
		// A label is looked up among the parent's children only: Phones is not a root.
		const nested = await resolve({ taxonomies: { category: paths("Phones") } });
		expect(!nested.ok && nested.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "term_not_found",
				message: 'No term labelled "Phones" in "category"',
			},
		]);
	});

	it("refuses two siblings with the same label, but not cousins", async () => {
		const { deps, resolve } = setup({ category: { match: "label" } });
		const l = deps.lookups;
		l.addTerm("category", "a", "A");
		l.addTerm("category", "b", "B");
		l.addTerm("category", "x-1", "X", "a");
		l.addTerm("category", "x-2", "X", "b");
		l.addTerm("category", "y-1", "Y", "a");
		l.addTerm("category", "y-2", "y", "a");
		l.addTerm("category", "z-1", "Zed", "b");
		l.addTerm("category", "z-2", "ZED", "b");
		l.addTerm("category", "x-3", "X", "b");
		const cousins = await resolve({
			taxonomies: { category: paths("A/X", "a/Y", "A/y", "B/Zed") },
		});
		// An exact label wins over one equal ignoring case.
		expect(cousins.ok && cousins.links.taxonomies?.category?.map((i) => i.value)).toEqual([
			"x-1",
			"y-1",
			"y-2",
			"z-1",
		]);
		const ambiguous = await resolve({ taxonomies: { category: paths("B/X", "B/zed") } });
		expect(!ambiguous.ok && ambiguous.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "ambiguous_term",
				message: 'More than one term in "category" is labelled "X" under "B"',
			},
			{
				field: "taxonomies.category",
				code: "ambiguous_term",
				message: 'More than one term in "category" is labelled "zed" under "B"',
			},
		]);
	});
});

describe("resolveLinks: creating terms", () => {
	it("creates a missing chain in label mode, passing parent row IDs and no slug", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Phones/Cases", "Garden/Tools/Hand Tools") },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([
			"create:category:Garden",
			"create:category:Tools",
			"create:category:Hand Tools",
		]);
		const garden = deps.lookups.storedTerms.find((x) => x.label === "Garden")!;
		const tools = deps.lookups.storedTerms.find((x) => x.label === "Tools")!;
		const hand = deps.lookups.storedTerms.find((x) => x.label === "Hand Tools")!;
		expect(tools.parentId).toBe(garden.group);
		expect(hand.parentId).toBe(tools.group);
		expect(result).toEqual({
			ok: true,
			newTerms: [
				"category: Garden",
				"category: Garden > Tools",
				"category: Garden > Tools > Hand Tools",
			],
			links: {
				taxonomies: {
					category: [
						{ group: t.cases.group, value: "cases", text: "electronics/phones/cases" },
						{ group: hand.group, value: "hand-tools", text: "garden/tools/hand-tools" },
					],
				},
			},
		});
		const again = await resolve({ taxonomies: { category: paths("Garden/Tools/Hand Tools") } });
		expect(again).toMatchObject({ ok: true, newTerms: [] });
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
	});

	it("creates under an existing parent, and shares a new parent between two items", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const t = tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Tablets", "Toys/Cars", "Toys/Dolls") },
		});
		const tablets = deps.lookups.storedTerms.find((x) => x.label === "Tablets")!;
		expect(tablets.parentId).toBe(t.electronics.group);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([
			"create:category:Tablets",
			"create:category:Toys",
			"create:category:Cars",
			"create:category:Dolls",
		]);
		expect(result.newTerms).toEqual([
			"category: Electronics > Tablets",
			"category: Toys",
			"category: Toys > Cars",
			"category: Toys > Dolls",
		]);
	});

	it("creates with the segment as slug and label in slug mode, refusing non-slugs", async () => {
		const { deps, resolve } = setup({ category: { create: true } });
		tree(deps);
		const result = await resolve({ taxonomies: { category: paths("electronics/tablets") } });
		expect(result.ok && result.links.taxonomies?.category?.[0]?.text).toBe("electronics/tablets");
		expect(deps.lookups.storedTerms.find((x) => x.slug === "tablets")).toMatchObject({
			label: "tablets",
		});
		const bad = await resolve({
			taxonomies: { category: paths("electronics/Big Phones", "toys") },
		});
		expect(!bad.ok && bad.errors).toEqual([
			{
				field: "taxonomies.category",
				code: "invalid_term_slug",
				message:
					'"Big Phones" is not a slug, so no term can be created with it (use lowercase letters, digits and hyphens, or match: "label")',
			},
		]);
		// The record failed a lookup, so nothing was created for it, not even "toys".
		expect(deps.lookups.storedTerms.some((x) => x.slug === "toys")).toBe(false);
		const elsewhere = await resolve({ taxonomies: { category: paths("toys/phones") } });
		expect(!elsewhere.ok && elsewhere.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
		expect(deps.lookups.storedTerms.some((x) => x.slug === "toys")).toBe(false);
	});

	it("creates nothing when another link of the record fails", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		const result = await resolve({
			taxonomies: { category: paths("Garden") },
			bylines: ["nobody"],
		});
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["byline_not_found"]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	it("re-reads the terms after a failed create and uses the term a concurrent run made", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		deps.lookups.failCreate = (taxonomy, input) => {
			deps.lookups.addTerm(taxonomy, "garden", input.label);
			return Object.assign(new Error("Term 'garden' already exists"), { code: "CONFLICT" });
		};
		const result = await resolve({ taxonomies: { category: paths("Garden") } });
		expect(result).toMatchObject({
			ok: true,
			newTerms: [],
			links: { taxonomies: { category: [{ value: "garden", text: "garden" }] } },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("terms"))).toHaveLength(2);
	});

	it("fails term_create_failed when the term still cannot be found", async () => {
		const { deps, resolve } = setup({ category: { match: "label", create: true } });
		deps.lookups.failCreate = () =>
			Object.assign(new Error("Parent term not found"), { code: "VALIDATION_ERROR" });
		const result = await resolve({ taxonomies: { category: paths("Garden/Tools") } });
		expect(result).toEqual({
			ok: false,
			newTerms: [],
			errors: [
				{
					field: "taxonomies.category",
					code: "term_create_failed",
					message: 'Could not create "Garden" in "category": Parent term not found',
				},
			],
		});
	});

	it("creates nothing in a dry run, listing what a real run would create", async () => {
		const { deps, resolve } = setup({
			category: { match: "label", create: true },
			dryRun: true,
		});
		tree(deps);
		const result = await resolve({
			taxonomies: { category: paths("Electronics/Phones/Chargers", "Electronics/Tablets", "News") },
		});
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
		expect(result).toMatchObject({
			ok: true,
			newTerms: ["category: Electronics > Phones > Chargers", "category: Electronics > Tablets"],
		});
		expect(result.ok && result.links.taxonomies?.category).toEqual([
			{ group: null, value: "", text: "electronics/phones/chargers" },
			{ group: null, value: "", text: "electronics/tablets" },
			{ group: expect.any(String), value: "news", text: "news" },
		]);
		// A later record of the batch finds the term, as it would after a real run created it.
		const later = await resolve({ taxonomies: { category: paths("Electronics/Tablets") } });
		expect(later).toEqual({
			ok: true,
			newTerms: [],
			links: {
				taxonomies: { category: [{ group: null, value: "", text: "electronics/tablets" }] },
			},
		});
		expect(deps.lookups.storedTerms.some((x) => x.label === "Tablets")).toBe(false);
	});

	it("sees in a dry run the slug clash a real run would hit with a term it created", async () => {
		const { resolve } = setup({ category: { create: true }, dryRun: true });
		expect((await resolve({ taxonomies: { category: paths("toys") } })).ok).toBe(true);
		const clash = await resolve({ taxonomies: { category: paths("news/toys") } });
		expect(!clash.ok && clash.errors.map((e) => e.code)).toEqual(["term_path_mismatch"]);
	});

	it("fails missing terms without create, in a dry run too", async () => {
		const { resolve } = setup({ dryRun: true });
		const result = await resolve({ taxonomies: { category: paths("garden") } });
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["term_not_found"]);
	});
});

describe("resolveLinks: references", () => {
	async function entries(deps: ReturnType<typeof makeDeps>["deps"]) {
		const maker = await deps.content.create({
			collection: "makers",
			locale: "en",
			slug: "acme",
			data: {},
		});
		const post = await deps.content.create({
			collection: "posts",
			locale: "en",
			slug: "hello",
			data: {},
		});
		const french = await deps.content.create({
			collection: "posts",
			locale: "fr",
			slug: "bonjour",
			data: {},
		});
		const person = await deps.content.create({
			collection: "people",
			locale: "en",
			data: { flux_source_id: "P1" },
		});
		return { maker, post, french, person };
	}

	it("finds entries by ID in any locale, by slug in the locale, and by key", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		const linked = await deps.content.create({ collection: "people", locale: "en", data: {} });
		await deps.links.put(linkKey("people", "en", "P2"), {
			collection: "people",
			locale: "en",
			sourceKey: "P2",
			entryId: linked.id,
		});
		const result = await resolve({
			references: {
				maker: [e.maker.id],
				related: ["hello"],
				author: ["P1", "P2"],
			},
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				references: {
					maker: [{ group: e.maker.id, value: e.maker.id, text: e.maker.id }],
					related: [{ group: e.post.id, value: e.post.id, text: e.post.id }],
					author: [
						{ group: e.person.id, value: e.person.id, text: e.person.id },
						{ group: linked.id, value: linked.id, text: linked.id },
					],
				},
			},
		});
		const other = await resolve({ references: { maker: [e.french.id], related: ["bonjour"] } });
		expect(!other.ok && other.errors).toEqual([
			{
				field: "maker",
				code: "reference_not_found",
				message: `No entry in "makers" has the ID "${e.french.id}"`,
			},
			{
				field: "related",
				code: "reference_not_found",
				message: 'No entry in "posts" (en) has the slug "bonjour"',
			},
		]);
	});

	it("does not take a slug in id mode, or a stale link", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		await deps.links.put(linkKey("people", "en", "P9"), {
			collection: "people",
			locale: "en",
			sourceKey: "P9",
			entryId: "gone",
		});
		const result = await resolve({ references: { maker: ["acme"], author: ["P9"] } });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "maker",
				code: "reference_not_found",
				message: 'No entry in "makers" has the ID "acme"',
			},
			{
				field: "author",
				code: "reference_not_found",
				message: 'No entry in "people" (en) was imported with the key "P9"',
			},
		]);
		expect(e.maker.id).not.toBe("acme");
	});

	it("caches hits but not misses, so a later record can find an entry created meanwhile", async () => {
		const { deps, resolve } = setup();
		const e = await entries(deps);
		await resolve({ references: { maker: [e.maker.id], related: ["later"] } });
		await resolve({ references: { maker: [e.maker.id] } });
		expect(deps.lookups.calls.filter((c) => c.startsWith("find:makers"))).toHaveLength(1);
		await deps.content.create({ collection: "posts", locale: "en", slug: "later", data: {} });
		const found = await resolve({ references: { related: ["later"] } });
		expect(found.ok).toBe(true);
	});

	it("fails the record, not the job, on an ambiguous source ID or a read error", async () => {
		const { deps, resolve } = setup();
		await entries(deps);
		await deps.content.create({
			collection: "people",
			locale: "en",
			data: { flux_source_id: "P1" },
		});
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		const result = await resolve({ references: { author: ["P1"] } });
		expect(!result.ok && result.errors).toEqual([
			{ field: "author", code: "ambiguous_source_id", message: "More than one entry" },
		]);
		deps.lookups.findEntry = async () => {
			throw new Error("database is gone");
		};
		await expect(resolve({ references: { maker: ["x"] } })).rejects.toThrow("database is gone");
	});

	it("drops a second item that names the same entry or term, and resolves empty values to nothing", async () => {
		const { deps, resolve } = setup({ tag: { match: "label" } });
		const e = await entries(deps);
		const t = tree(deps);
		const result = await resolve({
			references: { maker: [e.maker.id], related: ["hello"] },
			taxonomies: { category: null, tag: paths("Rock", "ROCK") },
			bylines: null,
		});
		expect(result).toEqual({
			ok: true,
			newTerms: [],
			links: {
				references: {
					maker: [{ group: e.maker.id, value: e.maker.id, text: e.maker.id }],
					related: [{ group: e.post.id, value: e.post.id, text: e.post.id }],
				},
				taxonomies: { category: [], tag: [{ group: t.rock.group, value: "rock", text: "rock" }] },
				bylines: [],
			},
		});
		const related = templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: { related: { from: "R", type: "reference" } },
		});
		const ids = await resolveLinks(
			deps,
			new LookupCache(),
			{
				template: related,
				targets: {
					related: { type: "reference", required: false, targetCollection: "posts" },
				},
				taxonomies: {},
				dryRun: false,
			},
			{ references: { related: [e.post.id, e.post.id] } },
		);
		expect(ids.ok && ids.links.references?.related).toHaveLength(1);
	});
});

describe("resolveLinks: bylines", () => {
	it("finds bylines by slug, or by trimmed display name, case-sensitive", async () => {
		const { deps, resolve } = setup({ bylines: { match: "name" } });
		const alex = deps.lookups.addByline("alex", " Alex Doe ");
		const sam = deps.lookups.addByline("sam", "Sam");
		deps.lookups.addByline("sam-fr", "Sam", "fr");
		deps.lookups.addByline("lee", "Lee");
		const result = await resolve({ bylines: ["Sam", "Alex Doe", "Sam"] });
		expect(result.ok && result.links.bylines).toEqual([
			{ group: sam.group, value: sam.id, text: "sam" },
			{ group: alex.group, value: alex.id, text: "alex" },
		]);
		const lower = await resolve({ bylines: ["sam"] });
		expect(!lower.ok && lower.errors).toEqual([
			{ field: "bylines", code: "byline_not_found", message: 'No byline (en) has the name "sam"' },
		]);
		// Loaded once per batch, two per page in the fake.
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines"))).toEqual([
			"bylines:en:",
			"bylines:en:2",
		]);
	});

	it("refuses two bylines with the same name", async () => {
		const { deps, resolve } = setup({ bylines: { match: "name" } });
		deps.lookups.addByline("sam-a", "Sam");
		deps.lookups.addByline("sam-b", "Sam");
		const result = await resolve({ bylines: ["Sam"] });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "bylines",
				code: "ambiguous_byline",
				message: 'More than one byline (en) is named "Sam"',
			},
		]);
		const bySlug = setup();
		bySlug.deps.lookups.addByline("sam-a", "Sam");
		expect((await bySlug.resolve({ bylines: ["sam-a"] })).ok).toBe(true);
	});

	it(`stops loading at ${MAX_BYLINE_LOOKUP} bylines and says so for a byline it did not find`, async () => {
		const { deps, resolve } = setup();
		for (let i = 0; i < MAX_BYLINE_LOOKUP + 2; i++) deps.lookups.addByline(`b${i}`, `B ${i}`);
		const result = await resolve({ bylines: ["b0", "b4999", "b5000"] });
		expect(!result.ok && result.errors).toEqual([
			{
				field: "bylines",
				code: "byline_lookup_limit",
				message: `No byline (en) with the slug "b5000" among the first ${MAX_BYLINE_LOOKUP}; the site has more`,
			},
		]);
		expect(deps.lookups.calls).toHaveLength(MAX_BYLINE_LOOKUP / 2);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run resolve`
Expected: FAIL — `resolve.test.ts` cannot load `../../src/engine/resolve.js` ("Cannot find module"; no tests run).

- [ ] **Step 3: Implement the resolver**

Create `packages/flux-import/src/engine/resolve.ts`:
```ts
/**
 * Resolution of a record's link requests (links.ts) to what EmDash stores: term slugs, entry
 * IDs and byline IDs, each with the translation group the diff compares. Every lookup of the
 * record is tried and every error collected first; terms are created only after that, in a real
 * run, so a record that fails a lookup creates nothing.
 */
import type {
	LinkRequests,
	ResolvedItem,
	ResolvedLinks,
	TaxonomySnapshot,
	TermRequest,
} from "./links.js";
import {
	type BylineRef,
	type ContentPort,
	ContentWriteError,
	type KvCollection,
	type LookupPort,
	type TermInfo,
} from "./ports.js";
import { slugify, type TargetField, type Template } from "./template.js";
import { type LinkRow, linkKey } from "./types.js";

/** Bylines loaded per batch at most; a lookup this set cannot answer is `byline_lookup_limit`. */
export const MAX_BYLINE_LOOKUP = 5000;

export type { ResolvedItem, ResolvedLinks };

export type ResolveDeps = {
	lookups: LookupPort;
	content: ContentPort;
	links: KvCollection<LinkRow>;
};

export type ResolveContext = {
	template: Template;
	/** The job's target field snapshot: reference fields' target collections. */
	targets: Readonly<Record<string, TargetField>>;
	/** The job's taxonomy snapshot; a taxonomy missing from it is flat. */
	taxonomies: Readonly<Record<string, TaxonomySnapshot>>;
	dryRun: boolean;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
export type LinkError = { field: string; code: string; message: string };

export type Resolution =
	| { ok: true; links: ResolvedLinks; newTerms: string[] }
	| { ok: false; errors: LinkError[]; newTerms: string[] };

/** A taxonomy's terms in the job's locale, indexed by slug, group and parent. */
class TermIndex {
	readonly bySlug = new Map<string, TermInfo>();
	readonly byGroup = new Map<string, TermInfo>();
	private readonly children = new Map<string | null, TermInfo[]>();

	constructor(terms: readonly TermInfo[]) {
		for (const term of terms) this.add(term);
	}

	add(term: TermInfo): void {
		if (!this.bySlug.has(term.slug)) this.bySlug.set(term.slug, term);
		this.byGroup.set(term.group, term);
		const siblings = this.children.get(term.parentId) ?? [];
		siblings.push(term);
		this.children.set(term.parentId, siblings);
	}

	childrenOf(parent: TermInfo | null): TermInfo[] {
		return this.children.get(parent?.group ?? null) ?? [];
	}

	/** Every term, for a flat taxonomy's label lookup. */
	all(): TermInfo[] {
		return [...this.byGroup.values()];
	}

	/** The term and its ancestors, root first. */
	pathOf(term: TermInfo): TermInfo[] {
		const path = [term];
		for (let at = term; at.parentId !== null && path.length <= 100; ) {
			const parent = this.byGroup.get(at.parentId);
			if (!parent) break;
			path.unshift(parent);
			at = parent;
		}
		return path;
	}
}

type BylineIndex = {
	bySlug: Map<string, BylineRef>;
	byName: Map<string, BylineRef[]>;
	/** Every byline of the locale was loaded. */
	complete: boolean;
};

/**
 * Lookups shared by the records of one batch: each mapped taxonomy's terms (with the terms the
 * batch creates), the bylines, and reference hits. Misses are not kept, because a later record
 * of the batch may create what was missing.
 */
export class LookupCache {
	readonly terms = new Map<string, TermIndex>();
	/** Terms a dry run would have created, numbered for their placeholder IDs. */
	planned = 0;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();
}

/** A matched term, or why there is none; `missing` lists the path's segments still to create. */
type TermMatch =
	| { kind: "found"; term: TermInfo }
	| { kind: "missing"; parent: TermInfo | null; missing: string[] }
	| { kind: "error"; code: string; message: string };

/**
 * The one term among `candidates` whose label is `label`: an exact match first, then the only
 * one equal ignoring case (the M4a select rule). Two matches are ambiguous.
 */
function byLabel(candidates: readonly TermInfo[], label: string): TermInfo | "ambiguous" | null {
	const exact = candidates.filter((t) => t.label.trim() === label);
	if (exact.length === 1) return exact[0] as TermInfo;
	if (exact.length > 1) return "ambiguous";
	const lower = label.toLowerCase();
	const loose = candidates.filter((t) => t.label.trim().toLowerCase() === lower);
	if (loose.length === 1) return loose[0] as TermInfo;
	return loose.length > 1 ? "ambiguous" : null;
}

/** Finds one term request in the index, without creating anything. */
function matchTerm(
	index: TermIndex,
	taxonomy: string,
	request: TermRequest,
	o: { match: "slug" | "label"; create: boolean; hierarchical: boolean },
): TermMatch {
	const { path } = request;
	const shown = path.join("/");
	const notFound: TermMatch = {
		kind: "error",
		code: "term_not_found",
		message: `No term ${o.match === "label" ? "labelled" : "with the slug"} "${shown}" in "${taxonomy}"`,
	};
	if (o.match === "label") {
		let parent: TermInfo | null = null;
		for (const [i, segment] of path.entries()) {
			const candidates = o.hierarchical ? index.childrenOf(parent) : index.all();
			const found = byLabel(candidates, segment);
			if (found === "ambiguous") {
				const where =
					parent === null
						? ""
						: ` under "${index
								.pathOf(parent)
								.map((t) => t.label)
								.join(" > ")}"`;
				return {
					kind: "error",
					code: "ambiguous_term",
					message: `More than one term in "${taxonomy}" is labelled "${segment}"${where}`,
				};
			}
			if (found === null) {
				return o.create ? { kind: "missing", parent, missing: path.slice(i) } : notFound;
			}
			parent = found;
		}
		return { kind: "found", term: parent as TermInfo };
	}
	// Slugs are unique per taxonomy and locale, so one segment names a term at any depth.
	const last = path[path.length - 1] as string;
	const term = index.bySlug.get(last);
	if (path.length === 1) {
		if (term) return { kind: "found", term };
		return o.create ? { kind: "missing", parent: null, missing: path } : notFound;
	}
	const mismatch = (existing: TermInfo): TermMatch => ({
		kind: "error",
		code: "term_path_mismatch",
		message: `Term "${existing.slug}" in "${taxonomy}" is at "${index
			.pathOf(existing)
			.map((t) => t.slug)
			.join("/")}", not under "${shown}"`,
	});
	if (!o.create) {
		if (!term) return notFound;
		const chain = index.pathOf(term).map((t) => t.slug);
		return chain.join("/") === shown ? { kind: "found", term } : mismatch(term);
	}
	let parent: TermInfo | null = null;
	for (const [i, segment] of path.entries()) {
		const existing = index.bySlug.get(segment);
		if (!existing) {
			// A slug that exists elsewhere cannot be created under a new parent.
			const elsewhere = path.slice(i + 1).find((s) => index.bySlug.has(s));
			if (elsewhere !== undefined) return mismatch(index.bySlug.get(elsewhere) as TermInfo);
			return { kind: "missing", parent, missing: path.slice(i) };
		}
		if (existing.parentId !== (parent?.group ?? null)) return mismatch(existing);
		parent = existing;
	}
	return { kind: "found", term: parent as TermInfo };
}

/** The terms of one taxonomy in the locale, loaded once per batch. */
async function termIndex(
	deps: ResolveDeps,
	cache: LookupCache,
	taxonomy: string,
	locale: string,
): Promise<TermIndex> {
	let index = cache.terms.get(taxonomy);
	if (!index) {
		index = new TermIndex(await deps.lookups.terms(taxonomy, locale));
		cache.terms.set(taxonomy, index);
	}
	return index;
}

const labelPath = (terms: readonly { label: string }[]) => terms.map((t) => t.label).join(" > ");

/** A dry run's stand-in for a term it would create; never sent to EmDash. */
const PLANNED = "planned:";

function termItem(index: TermIndex, term: TermInfo): ResolvedItem {
	const planned = term.id.startsWith(PLANNED);
	return {
		group: planned ? null : term.group,
		value: planned ? "" : term.slug,
		text: index
			.pathOf(term)
			.map((t) => t.slug)
			.join("/"),
	};
}

/**
 * Creates the missing segments of one path under `parent`, in order, reusing a term the batch
 * created meanwhile. A failed create (a concurrent creator's `CONFLICT`, or anything else) reloads
 * the terms and looks the segment up again before giving up. A dry run adds a placeholder
 * instead, so later records of the batch find the term as they would in a real run.
 */
async function createPath(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	taxonomy: string,
	match: "slug" | "label",
	start: TermInfo | null,
	missing: readonly string[],
	created: string[],
): Promise<{ ok: true; term: TermInfo } | { ok: false; message: string }> {
	const locale = ctx.template.locale;
	let parent = start;
	for (const segment of missing) {
		let index = await termIndex(deps, cache, taxonomy, locale);
		const under = parent;
		const find = (ix: TermIndex): TermInfo | null => {
			if (match === "slug") {
				const bySlug = ix.bySlug.get(segment);
				return bySlug && bySlug.parentId === (under?.group ?? null) ? bySlug : null;
			}
			const byLabelled = byLabel(ix.childrenOf(under), segment);
			return byLabelled === "ambiguous" ? null : byLabelled;
		};
		let term = find(index);
		if (!term && ctx.dryRun) {
			const id = `${PLANNED}${++cache.planned}`;
			const slug = match === "slug" ? segment : slugify(segment);
			term = { id, slug, label: segment, parentId: parent?.group ?? null, group: id };
			index.add(term);
			created.push(`${taxonomy}: ${labelPath(index.pathOf(term))}`);
		}
		if (!term) {
			try {
				term = await deps.lookups.createTerm(taxonomy, {
					label: segment,
					...(match === "slug" ? { slug: segment } : {}),
					...(parent === null ? {} : { parentId: parent.id }),
					locale,
				});
				index.add(term);
				created.push(`${taxonomy}: ${labelPath(index.pathOf(term))}`);
			} catch (e) {
				index = new TermIndex(await deps.lookups.terms(taxonomy, locale));
				cache.terms.set(taxonomy, index);
				term = find(index);
				if (!term) {
					const reason = e instanceof Error ? e.message : String(e);
					return {
						ok: false,
						message: `Could not create "${segment}" in "${taxonomy}": ${reason}`,
					};
				}
			}
		}
		parent = term;
	}
	return { ok: true, term: parent as TermInfo };
}

/** Resolves one taxonomy's terms; creation is planned in `pending`, not done. */
type PendingTerm = {
	taxonomy: string;
	match: "slug" | "label";
	position: number;
	parent: TermInfo | null;
	missing: string[];
	path: string[];
};

async function resolveTerms(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	taxonomy: string,
	requests: readonly TermRequest[],
	errors: LinkError[],
	pending: PendingTerm[],
): Promise<ResolvedItem[]> {
	const mapping = ctx.template.taxonomies?.[taxonomy];
	const match = mapping?.match ?? "slug";
	const create = mapping?.create ?? false;
	const hierarchical = ctx.taxonomies[taxonomy]?.hierarchical ?? false;
	const field = `taxonomies.${taxonomy}`;
	const index = await termIndex(deps, cache, taxonomy, ctx.template.locale);
	const items: ResolvedItem[] = [];
	for (const request of requests) {
		const found = matchTerm(index, taxonomy, request, { match, create, hierarchical });
		if (found.kind === "error") {
			errors.push({ field, code: found.code, message: found.message });
			continue;
		}
		if (found.kind === "found") {
			items.push(termItem(index, found.term));
			continue;
		}
		const bad = match === "slug" ? found.missing.find((s) => slugify(s) !== s) : undefined;
		if (bad !== undefined) {
			errors.push({
				field,
				code: "invalid_term_slug",
				message: `"${bad}" is not a slug, so no term can be created with it (use lowercase letters, digits and hyphens, or match: "label")`,
			});
			continue;
		}
		pending.push({
			taxonomy,
			match,
			position: items.length,
			parent: found.parent,
			missing: found.missing,
			path: request.path,
		});
		items.push({ group: null, value: "", text: request.path.join("/") });
	}
	return items;
}

const referenceKey = (target: string, match: string, value: string) =>
	`${target}\u0000${match}\u0000${value}`;

/** One reference item: the hit from the batch cache, or a lookup; null when nothing matches. */
async function findReference(
	deps: ResolveDeps,
	cache: LookupCache,
	target: string,
	match: "id" | "slug" | "key",
	value: string,
	locale: string,
): Promise<{ id: string; group: string } | null> {
	const key = referenceKey(target, match, value);
	const hit = cache.entries.get(key);
	if (hit) return hit;
	let found: { id: string; group: string } | null = null;
	if (match === "key") {
		// The importer's own link first, verified; then the source ID it wrote into the entry.
		const link = await deps.links.get(linkKey(target, locale, value));
		const linked = link ? await deps.content.get(target, locale, link.entryId) : null;
		const entry = linked ?? (await deps.content.findBySourceId(target, locale, value));
		found = entry ? { id: entry.id, group: entry.group ?? entry.id } : null;
	} else {
		found = await deps.lookups.findEntry(target, match, value, locale);
	}
	if (found) cache.entries.set(key, found);
	return found;
}

const NOT_FOUND_BY = {
	id: (target: string, value: string) => `No entry in "${target}" has the ID "${value}"`,
	slug: (target: string, value: string, locale: string) =>
		`No entry in "${target}" (${locale}) has the slug "${value}"`,
	key: (target: string, value: string, locale: string) =>
		`No entry in "${target}" (${locale}) was imported with the key "${value}"`,
};

async function resolveReferences(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	field: string,
	values: readonly string[],
	errors: LinkError[],
): Promise<ResolvedItem[]> {
	const mapping = ctx.template.fields[field];
	const match = mapping?.type === "reference" ? (mapping.match ?? "id") : "id";
	const target = ctx.targets[field]?.targetCollection;
	const locale = ctx.template.locale;
	if (target === undefined) {
		errors.push({
			field,
			code: "reference_not_found",
			message: "The job does not know which collection this field links to",
		});
		return [];
	}
	const items: ResolvedItem[] = [];
	for (const value of values) {
		try {
			const found = await findReference(deps, cache, target, match, value, locale);
			if (found) items.push({ group: found.group, value: found.id, text: found.id });
			else {
				const message = NOT_FOUND_BY[match](target, value, locale);
				errors.push({ field, code: "reference_not_found", message });
			}
		} catch (e) {
			// A lookup that fails on this value (an ambiguous source ID, an EmDash read error)
			// fails the record, not the job.
			if (!(e instanceof ContentWriteError)) throw e;
			errors.push({ field, code: e.code, message: e.message });
		}
	}
	return items;
}

/** The locale's bylines, loaded once per batch, at most `MAX_BYLINE_LOOKUP`. */
async function bylineIndex(
	deps: ResolveDeps,
	cache: LookupCache,
	locale: string,
): Promise<BylineIndex> {
	if (cache.bylines) return cache.bylines;
	const index: BylineIndex = { bySlug: new Map(), byName: new Map(), complete: true };
	let cursor: string | undefined;
	let loaded = 0;
	do {
		const page = await deps.lookups.bylines(locale, cursor);
		for (const byline of page.items) {
			if (!index.bySlug.has(byline.slug)) index.bySlug.set(byline.slug, byline);
			const name = byline.displayName.trim();
			index.byName.set(name, [...(index.byName.get(name) ?? []), byline]);
		}
		loaded += page.items.length;
		cursor = page.cursor;
		if (cursor !== undefined && loaded >= MAX_BYLINE_LOOKUP) {
			index.complete = false;
			break;
		}
	} while (cursor !== undefined);
	cache.bylines = index;
	return index;
}

async function resolveBylines(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	values: readonly string[],
	errors: LinkError[],
): Promise<ResolvedItem[]> {
	const match = ctx.template.bylines?.match ?? "slug";
	const locale = ctx.template.locale;
	const index = await bylineIndex(deps, cache, locale);
	const items: ResolvedItem[] = [];
	for (const value of values) {
		const found =
			match === "slug"
				? [index.bySlug.get(value)].filter((b) => b !== undefined)
				: (index.byName.get(value) ?? []);
		if (found.length > 1) {
			errors.push({
				field: "bylines",
				code: "ambiguous_byline",
				message: `More than one byline (${locale}) is named "${value}"`,
			});
		} else if (found.length === 1) {
			const byline = found[0] as BylineRef;
			items.push({ group: byline.group, value: byline.id, text: byline.slug });
		} else if (index.complete) {
			errors.push({
				field: "bylines",
				code: "byline_not_found",
				message: `No byline (${locale}) has the ${match} "${value}"`,
			});
		} else {
			errors.push({
				field: "bylines",
				code: "byline_lookup_limit",
				message: `No byline (${locale}) with the ${match} "${value}" among the first ${MAX_BYLINE_LOOKUP}; the site has more`,
			});
		}
	}
	return items;
}

/** Drops later items with the same identity: the same group, or the same text for new terms. */
function distinct(items: readonly ResolvedItem[]): ResolvedItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const id = item.group === null ? `new:${item.text}` : item.group;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

/**
 * Resolves a record's link requests. An empty value (null) resolves to an empty list. Without
 * errors, a real run then creates the missing terms of `create: true` taxonomies; a dry run
 * creates nothing and lists them in `newTerms` (as a real run lists the ones it created), with
 * placeholders that later records of the batch find.
 */
export async function resolveLinks(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	links: LinkRequests,
): Promise<Resolution> {
	const errors: LinkError[] = [];
	const pending: PendingTerm[] = [];
	const resolved: ResolvedLinks = {};
	for (const [field, values] of Object.entries(links.references ?? {})) {
		const items = await resolveReferences(deps, cache, ctx, field, values ?? [], errors);
		resolved.references ??= {};
		resolved.references[field] = items;
	}
	for (const [taxonomy, requests] of Object.entries(links.taxonomies ?? {})) {
		const items = await resolveTerms(deps, cache, ctx, taxonomy, requests ?? [], errors, pending);
		resolved.taxonomies ??= {};
		resolved.taxonomies[taxonomy] = items;
	}
	if (links.bylines !== undefined) {
		resolved.bylines = await resolveBylines(deps, cache, ctx, links.bylines ?? [], errors);
	}
	if (errors.length > 0) return { ok: false, errors, newTerms: [] };

	const newTerms: string[] = [];
	for (const p of pending) {
		const items = resolved.taxonomies?.[p.taxonomy] as ResolvedItem[];
		const created = await createPath(
			deps,
			cache,
			ctx,
			p.taxonomy,
			p.match,
			p.parent,
			p.missing,
			newTerms,
		);
		if (!created.ok) {
			errors.push({
				field: `taxonomies.${p.taxonomy}`,
				code: "term_create_failed",
				message: created.message,
			});
			continue;
		}
		const index = cache.terms.get(p.taxonomy) as TermIndex;
		items[p.position] = termItem(index, created.term);
	}
	if (errors.length > 0) return { ok: false, errors, newTerms };
	for (const field of Object.keys(resolved.references ?? {})) {
		const refs = resolved.references as Record<string, ResolvedItem[]>;
		refs[field] = distinct(refs[field] ?? []);
	}
	for (const taxonomy of Object.keys(resolved.taxonomies ?? {})) {
		const terms = resolved.taxonomies as Record<string, ResolvedItem[]>;
		terms[taxonomy] = distinct(terms[taxonomy] ?? []);
	}
	if (resolved.bylines) resolved.bylines = distinct(resolved.bylines);
	return { ok: true, links: resolved, newTerms };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run resolve`
Expected: PASS (22 tests). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 42 files / 1,086 tests in numeric order, or 42 / 1,073 on Tasks 1 and 2 alone).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/resolve.ts packages/flux-import/tests/unit/resolve.test.ts
git commit -m "Resolve terms, references and bylines per batch, creating missing terms only after every lookup succeeds"
```

### Task 6: Link changes in the record plan

**Files:**
- Modify: `packages/flux-import/src/engine/diff.ts`
- Test: `packages/flux-import/tests/unit/diff.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ResolvedItem`, `ResolvedLinks`); E4.
- Produces (`src/engine/diff.ts`): `type CurrentItem = { group: string; text: string }`; `type CurrentLinks`; `type LinkPlan = { resolved; current; childSide }`; `planRecord(current, next, comparisons, links?)`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/diff.test.ts`, replace
```ts
import { describe, expect, it } from "vitest";
import { type Comparison, comparisonsOf, deepEqual, planRecord } from "../../src/engine/diff.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
```
with:
```ts
import { describe, expect, it } from "vitest";
import {
	type Comparison,
	type CurrentLinks,
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	planRecord,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
```

then replace
```ts
		});
	});
});

```
with:
```ts
		});
	});
});

describe("planRecord with links", () => {
	const item = (group: string | null, text = group ?? "new") => ({
		group,
		value: group ?? "",
		text,
	});
	const cur = (group: string, text = group) => ({ group, text });
	const record = { key: "P1", data: { title: "Hello" } };
	const entry = { slug: "hello", data: { title: "Hello" } };
	const plan = (resolved: ResolvedLinks, current: CurrentLinks, childSide: string[] = []) => {
		const links: LinkPlan = { resolved, current, childSide: new Set(childSide) };
		return planRecord(entry, record, new Map(), links);
	};

	it("compares taxonomies as sets, parent-side references and bylines in order", () => {
		const current: CurrentLinks = {
			taxonomies: { category: [cur("g1", "news"), cur("g2", "tech")] },
			references: { related: [cur("p1"), cur("p2")], parents: [cur("q1"), cur("q2")] },
			bylines: [cur("b1", "alex"), cur("b2", "sam")],
		};
		expect(
			plan(
				{
					taxonomies: { category: [item("g2", "tech"), item("g1", "news")] },
					references: { related: [item("p1"), item("p2")], parents: [item("q2"), item("q1")] },
					bylines: [item("b1", "alex"), item("b2", "sam")],
				},
				current,
				["parents"],
			),
		).toEqual({ action: "unchanged", changes: [] });
		expect(
			plan(
				{
					taxonomies: { category: [item("g1", "news"), item("g3", "electronics/phones")] },
					references: { related: [item("p2"), item("p1")], parents: [item("q1")] },
					bylines: [item("b2", "sam"), item("b1", "alex")],
				},
				current,
				["parents"],
			),
		).toEqual({
			action: "update",
			changes: [
				{ field: "related", before: ["p1", "p2"], after: ["p2", "p1"] },
				{ field: "parents", before: ["q1", "q2"], after: ["q1"] },
				{
					field: "taxonomies.category",
					before: ["news", "tech"],
					after: ["news", "electronics/phones"],
				},
				{ field: "bylines", before: ["alex", "sam"], after: ["sam", "alex"] },
			],
		});
	});

	it("treats an empty value as equal to nothing, and clears what the entry has", () => {
		expect(plan({ taxonomies: { tag: [] }, references: { related: [] }, bylines: [] }, {})).toEqual(
			{ action: "unchanged", changes: [] },
		);
		expect(
			plan(
				{ taxonomies: { tag: [] }, bylines: [] },
				{ taxonomies: { tag: [cur("t1", "rock")] }, bylines: [cur("b1", "alex")] },
			),
		).toEqual({
			action: "update",
			changes: [
				{ field: "taxonomies.tag", before: ["rock"], after: null },
				{ field: "bylines", before: ["alex"], after: null },
			],
		});
	});

	it("always plans a term a dry run would create as a change", () => {
		expect(
			plan(
				{ taxonomies: { category: [item("g1", "news"), item(null, "Garden/Tools")] } },
				{ taxonomies: { category: [cur("g1", "news")] } },
			).changes,
		).toEqual([
			{ field: "taxonomies.category", before: ["news"], after: ["news", "Garden/Tools"] },
		]);
	});

	it("lists the non-empty links of a new entry after its fields", () => {
		const links: LinkPlan = {
			resolved: {
				references: { related: [item("p1")], maker: [] },
				taxonomies: { category: [item("g1", "news")], tag: [] },
				bylines: [item("b1", "alex")],
			},
			current: {},
			childSide: new Set(),
		};
		expect(planRecord(null, { ...record, slug: "hello" }, new Map(), links)).toEqual({
			action: "create",
			changes: [
				{ field: "slug", before: null, after: "hello" },
				{ field: "title", before: null, after: "Hello" },
				{ field: "related", before: null, after: ["p1"] },
				{ field: "taxonomies.category", before: null, after: ["news"] },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run diff`
Expected: FAIL — 4 of 15 tests in `diff.test.ts`: the four "planRecord with links" tests (the old `planRecord` ignores its fourth argument, so links never plan a change).

- [ ] **Step 3: Compare links**

In `packages/flux-import/src/engine/diff.ts`, replace
```ts
import type { FieldValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
```
with:
```ts
import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { FieldValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
```

then replace
```ts
	}
}

export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
```
with:
```ts
	}
}

/** One link the entry holds now: its translation group and how the record shows it. */
export type CurrentItem = { group: string; text: string };

/** What the entry holds now for the links the template maps; a link not given is empty. */
export type CurrentLinks = {
	taxonomies?: Record<string, CurrentItem[]>;
	references?: Record<string, CurrentItem[]>;
	bylines?: CurrentItem[];
};

/** A record's resolved links and the entry's current ones, for `planRecord`. */
export type LinkPlan = {
	resolved: ResolvedLinks;
	current: CurrentLinks;
	/** Reference fields on the child side of their relation, which keep no order. */
	childSide: ReadonlySet<string>;
};

/**
 * Whether the entry already holds the resolved items: the same translation groups, in order or
 * as a set. A term not created yet (a dry run) is always a change.
 */
function sameLinks(
	current: readonly CurrentItem[],
	next: readonly ResolvedItem[],
	ordered: boolean,
) {
	if (next.some((item) => item.group === null) || current.length !== next.length) return false;
	if (ordered) return current.every((item, i) => item.group === next[i]?.group);
	const groups = new Set(current.map((item) => item.group));
	return groups.size === next.length && next.every((item) => groups.has(item.group as string));
}

const texts = (items: readonly { text: string }[]) =>
	items.length === 0 ? null : items.map((item) => item.text);

/**
 * The link changes, in order: reference fields, taxonomies (`taxonomies.<name>`), bylines.
 * Taxonomies and child-side references compare as sets, the rest in order; an empty value equals
 * an empty current link. Without a current entry, every non-empty link is a change.
 */
function linkChanges(links: LinkPlan, exists: boolean): Change[] {
	const { resolved, current } = links;
	const changes: Change[] = [];
	const compare = (
		field: string,
		before: readonly CurrentItem[],
		after: readonly ResolvedItem[],
		ordered: boolean,
	) => {
		if (!exists) {
			if (after.length > 0) changes.push({ field, before: null, after: texts(after) });
		} else if (!sameLinks(before, after, ordered)) {
			changes.push({ field, before: texts(before), after: texts(after) });
		}
	};
	for (const [field, after] of Object.entries(resolved.references ?? {})) {
		compare(field, current.references?.[field] ?? [], after, !links.childSide.has(field));
	}
	for (const [taxonomy, after] of Object.entries(resolved.taxonomies ?? {})) {
		compare(`taxonomies.${taxonomy}`, current.taxonomies?.[taxonomy] ?? [], after, false);
	}
	if (resolved.bylines !== undefined) {
		compare("bylines", current.bylines ?? [], resolved.bylines, true);
	}
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field or a link differs, else `unchanged`. `links` is given when the template maps links.
 */
export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
```

then replace
```ts
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		return { action: "create", changes };
	}
	if (next.slug !== undefined && current.slug !== next.slug) {
```
with:
```ts
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
	if (next.slug !== undefined && current.slug !== next.slug) {
```

then replace
```ts
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}

```
with:
```ts
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}

```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run diff`
Expected: PASS (15 tests). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 42 files / 1,090 tests in numeric order, or 41 / 1,055 on Tasks 1 and 2 alone).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/diff.ts packages/flux-import/tests/unit/diff.test.ts
git commit -m "Compare links by translation group in the record plan"
```

### Task 7: Batch integration, `newTerms` and the Workers cap

**Files:**
- Modify: `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/engine/resolve.ts`, `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/link-import.test.ts` (new), `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Tasks 3-6 (`Job.taxonomies`, `targetFields` relation keys; `ContentPort` options and `LinkWrites`; `resolveLinks`, `LookupCache`; `LinkPlan`, `planRecord`); V2.
- Produces:
  - `src/engine/batch.ts`: `processRecord(…, opts: { retry; cache? })`; `decide` resolves links after `applyTemplate` and before the link lookup, reads the entry with `{ references }` and the assigned terms, plans with `LinkPlan`, writes links; `runBatch(…, maxRecords: number | ((job: Job) => number))` with one `LookupCache` per call.
  - `src/engine/resolve.ts`: `termPath(cache, taxonomy, group)`; `ResolveContext.plannedKey` used for dry-run key references.
  - `src/engine/types.ts`: `RecordRow.newTerms?: string[]`.
  - `src/engine/template.ts`: `usesLinks(t)`.
  - `src/plugin/service.ts`: `WORKERS_LINKED_BATCH_CAP` (10), `workersBatchCap(job)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/link-import.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError, type LinkWrites } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{
		slug: "maker",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "makers",
	},
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
];

const template = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		maker: { from: "Maker", type: "reference", match: "slug" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: {
		category: { from: "Category", match: "label", hierarchy: ">", create: true },
		tag: { from: "Tags", separator: "|" },
	},
	bylines: { from: "Authors", separator: "|" },
	...extra,
});

const HEADER = "sku,Name,Maker,Related,Category,Tags,Authors\n";

async function seed(deps: Deps) {
	await deps.content.create({ collection: "makers", locale: "en", slug: "acme", data: {} });
	deps.lookups.defs.push(
		{ name: "category", hierarchical: true, collections: ["products"], locale: "en" },
		{ name: "tag", hierarchical: false, collections: ["products"], locale: "en" },
	);
	deps.lookups.addTerm("category", "electronics", "Electronics");
	deps.lookups.addTerm("tag", "new", "New");
	deps.lookups.addTerm("tag", "sale", "Sale");
	deps.lookups.addByline("alex", "Alex");
	deps.lookups.addByline("sam", "Sam");
}

async function start(
	deps: Deps,
	csv: string,
	opts: { dryRun?: boolean; publish?: boolean; extra?: Record<string, unknown> } = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const { extra, ...rest } = opts;
	return createJob(deps, {
		uploadId: upload,
		template: template(extra),
		schemaFields,
		linkSchema: {
			targets: { makers: [], products: [{ slug: "flux_source_id", type: "string" }] },
			taxonomies: deps.lookups.defs,
		},
		...rest,
	});
}

async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

const CSV = `${HEADER}A1,Desk,acme,,Electronics > Phones,new|sale,alex|sam\nA2,Lamp,,A1,Electronics,new,sam\n`;

describe("importing links", () => {
	it("creates entries with their terms, references and bylines, and re-runs unchanged", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const job = await start(deps, CSV);
		expect(job.taxonomies).toEqual({
			category: { hierarchical: true },
			tag: { hierarchical: false },
		});
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 2, failed: 0 });
		const [a1, a2] = await rows(deps, job.id);
		const phones = deps.lookups.storedTerms.find((t) => t.label === "Phones")!;
		const makerId = [...deps.content.entries.values()].find((e) => e.slug === "acme")!.id;
		expect(a1).toMatchObject({
			status: "created",
			newTerms: ["category: Electronics > Phones"],
			changes: [
				{ field: "title", before: null, after: "Desk" },
				{ field: "maker", before: null, after: [makerId] },
				{ field: "taxonomies.category", before: null, after: ["electronics/phones"] },
				{ field: "taxonomies.tag", before: null, after: ["new", "sale"] },
				{ field: "bylines", before: null, after: ["alex", "sam"] },
			],
		});
		expect(a2).not.toHaveProperty("newTerms");
		const entry1 = deps.content.entries.get(a1!.entryId!)!;
		expect(entry1).toMatchObject({
			taxonomies: { category: ["phones"], tag: ["new", "sale"] },
			references: { maker: [makerId] },
			bylines: [
				{ bylineId: deps.lookups.storedBylines[0]!.id, roleLabel: null },
				{ bylineId: deps.lookups.storedBylines[1]!.id, roleLabel: null },
			],
		});
		expect(phones.parentId).not.toBeNull();
		// A2 links to A1 by import key, which the same job wrote first.
		expect(deps.content.entries.get(a2!.entryId!)?.references).toEqual({ related: [a1!.entryId] });

		const again = await start(deps, CSV);
		const rerun = await runToEnd(deps, again.id);
		expect(rerun.counters).toMatchObject({ unchanged: 2, created: 0, updated: 0 });
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
	});

	it("loads terms and bylines once per batch", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const job = await start(deps, CSV);
		await runToEnd(deps, job.id);
		expect(deps.lookups.calls.filter((c) => c.startsWith("terms:"))).toEqual([
			"terms:category:en",
			"terms:tag:en",
		]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines:"))).toHaveLength(1);
	});

	it("reports in a dry run what a real run would hit, without writing or creating", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}A1,Desk,acme,,Electronics > Phones,new,alex\nA2,Lamp,nobody,A9,Garden,old,lee\n`;
		const job = await start(deps, csv, { dryRun: true });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 1 });
		const [a1, a2] = await rows(deps, job.id);
		expect(a1).toMatchObject({
			status: "planned",
			action: "create",
			newTerms: ["category: Electronics > Phones"],
		});
		expect(a2).toMatchObject({
			status: "failed",
			sourceKey: "A2",
			errors: [
				{ field: "maker", code: "reference_not_found" },
				{ field: "related", code: "reference_not_found" },
				{ field: "taxonomies.tag", code: "term_not_found" },
				{ field: "bylines", code: "byline_not_found" },
			],
		});
		// Only the seeded maker exists; the dry run looked A9 up but wrote nothing.
		expect(deps.content.calls).toEqual(["create:e1", "find:A9"]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	it("finds in a dry run a key an earlier record would create, across batches", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}C1,One,,,,,\nC2,Two,,C1,,,\nC3,Three,,C1|C2,,,\nC4,Four,,C5,,,\nC5,Five,,,,,\n`;
		const job = await start(deps, csv, { dryRun: true });
		await deps.jobs.put(job.id, { ...job, batchSize: 2 });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 4, failed: 1 });
		const planned = await rows(deps, job.id);
		expect(planned[2]).toMatchObject({
			status: "planned",
			changes: [
				{ field: "title", before: null, after: "Three" },
				{ field: "related", before: null, after: ["C1", "C2"] },
			],
		});
		// A forward reference fails as it would in a real run.
		expect(planned[3]).toMatchObject({
			status: "failed",
			errors: [{ field: "related", code: "reference_not_found" }],
		});
		const real = await start(deps, csv);
		expect((await runToEnd(deps, real.id)).counters).toMatchObject({ created: 4, failed: 1 });
	});

	it("updates only the changed links, without data, keeping role labels", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
		await runToEnd(deps, first.id);
		const [a1] = await rows(deps, first.id);
		const entry = deps.content.entries.get(a1!.entryId!)!;
		entry.bylines[1]!.roleLabel = "Photos";
		const updates: unknown[] = [];
		const update = deps.content.update.bind(deps.content);
		deps.content.update = async (input) => {
			updates.push(input);
			return update(input);
		};
		const changed = `${HEADER}A1,Desk,acme,,Electronics > Phones,sale,sam|alex\n`;
		const second = await start(deps, changed);
		await runToEnd(deps, second.id);
		const [row] = await rows(deps, second.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "taxonomies.tag", before: ["new", "sale"], after: ["sale"] },
				{ field: "bylines", before: ["alex", "sam"], after: ["sam", "alex"] },
			],
		});
		const [alex, sam] = deps.lookups.storedBylines;
		expect(updates).toEqual([
			{
				collection: "products",
				locale: "en",
				id: entry.id,
				rev: expect.any(String),
				taxonomies: { tag: ["sale"] },
				bylines: [
					{ bylineId: sam!.id, roleLabel: "Photos" },
					{ bylineId: alex!.id, roleLabel: null },
				],
			},
		]);
	});

	it("sends the data again when a field changed, and clears a taxonomy given no value", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
		await runToEnd(deps, first.id);
		const writes: LinkWrites[] = deps.content.linkWrites;
		writes.length = 0;
		const changed = `${HEADER}A1,Desk 2,acme,,Electronics > Phones,,alex|sam\n`;
		const second = await start(deps, changed);
		await runToEnd(deps, second.id);
		const [row] = await rows(deps, second.id);
		expect(row?.changes).toEqual([
			{ field: "title", before: "Desk", after: "Desk 2" },
			{ field: "taxonomies.tag", before: ["new", "sale"], after: null },
		]);
		expect(writes).toEqual([{ taxonomies: { tag: [] } }]);
		const entry = deps.content.entries.get(row!.entryId!)!;
		expect(entry.data).toMatchObject({ title: "Desk 2" });
		expect(entry.taxonomies).toEqual({ category: ["phones"], tag: [] });
	});

	it("fails a forward key reference, and imports it on retry once the target exists", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}B1,Shelf,,B2,,,\nB2,Stool,,,,,\n`;
		const job = await start(deps, csv);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 1 });
		const [b1] = await rows(deps, job.id);
		expect(b1).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "related",
					code: "reference_not_found",
					message: 'No entry in "products" (en) was imported with the key "B2"',
				},
			],
		});
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 2, failed: 0 });
		const [fixed, b2] = await rows(deps, job.id);
		expect(deps.content.entries.get(fixed!.entryId!)?.references).toEqual({
			related: [b2!.entryId],
		});
	});

	it("creates nothing for a record whose lookups fail", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const csv = `${HEADER}A1,Desk,acme,,Garden > Tools,new,nobody\n`;
		const job = await start(deps, csv);
		await runToEnd(deps, job.id);
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			sourceKey: "A1",
			errors: [{ field: "bylines", code: "byline_not_found" }],
		});
		expect(row).not.toHaveProperty("newTerms");
		expect(deps.lookups.storedTerms.some((t) => t.label === "Garden")).toBe(false);
		expect(deps.content.entries.size).toBe(1);
	});

	it("keeps the created terms on the row of a record that then fails to write", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		deps.content.failWrite = () => new ContentWriteError("emdash_validation_error", "Invalid");
		const csv = `${HEADER}A1,Desk,acme,,Garden > Tools,new,alex\n`;
		const job = await start(deps, csv);
		await runToEnd(deps, job.id);
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			newTerms: ["category: Garden", "category: Garden > Tools"],
			errors: [{ code: "emdash_validation_error" }],
		});
		// The next run finds the terms instead of creating them again.
		deps.content.failWrite = () => null;
		const again = await start(deps, csv);
		await runToEnd(deps, again.id);
		const [ok] = await rows(deps, again.id);
		expect(ok).toMatchObject({ status: "created" });
		expect(ok).not.toHaveProperty("newTerms");
	});

	it("leaves jobs of templates without links as before", async () => {
		const { deps } = makeDeps();
		deps.source.add("p1", "sku,Name\nA1,Desk\n");
		const job = await createJob(deps, {
			uploadId: "p1",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { title: { from: "Name", type: "text" } },
			},
			schemaFields: [{ slug: "title", type: "string" }],
		});
		expect(job).not.toHaveProperty("taxonomies");
		await runToEnd(deps, job.id);
		expect(deps.lookups.calls).toEqual([]);
		expect(deps.content.linkWrites).toEqual([{}]);
	});
});
```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
	startJob,
	uploadNeeded,
	WORKERS_BATCH_CAP,
} from "../../src/plugin/service.js";
import { FakeStorage, makeDeps } from "./fakes.js";

```
with:
```ts
	startJob,
	uploadNeeded,
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { FakeStorage, makeDeps } from "./fakes.js";

```

then replace
```ts
	});
});

describe("nextBatch on Workers", () => {
	it(`processes at most ${WORKERS_BATCH_CAP} records per call, keeping the job's batch size`, async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
```
with:
```ts
	});
});

describe("workersBatchCap", () => {
	it(`caps jobs that map links at ${WORKERS_LINKED_BATCH_CAP} records`, async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		expect(workersBatchCap(job)).toBe(WORKERS_BATCH_CAP);
		const tagged = { ...job.template, bylines: { from: "Name" } };
		expect(workersBatchCap({ ...job, template: tagged })).toBe(WORKERS_LINKED_BATCH_CAP);
		const referenced = {
			...job.template,
			fields: { ...job.template.fields, maker: { from: "Name", type: "reference" as const } },
		};
		expect(workersBatchCap({ ...job, template: referenced })).toBe(WORKERS_LINKED_BATCH_CAP);
	});
});

describe("nextBatch on Workers", () => {
	it(`processes at most ${WORKERS_BATCH_CAP} records per call, keeping the job's batch size`, async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run link-import service`
Expected: FAIL — 10 of 39 tests: 9 of the 10 in `link-import.test.ts` (all but "leaves jobs of templates without links as before", which passes already; the batch never resolves or writes links), and in `service.test.ts` "caps jobs that map links at undefined records" (`TypeError: workersBatchCap is not a function`; the name shows `undefined` until the constant exists).

- [ ] **Step 3: Resolve, compare and write links in batches**

In `packages/flux-import/src/engine/types.ts`, replace
```ts
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
	writtenRev?: string;
	updatedAt: string;
}

```
with:
```ts
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
	writtenRev?: string;
	/**
	 * Terms created for the record (`taxonomy: Parent > Child`), or that a dry run would create.
	 * Absent when there are none.
	 */
	newTerms?: string[];
	updatedAt: string;
}

```

In `packages/flux-import/src/engine/template.ts`, replace
```ts
	return warnings;
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
```
with:
```ts
	return warnings;
}

/** Whether the template maps reference fields, taxonomies or bylines. */
export function usesLinks(t: Template): boolean {
	return (
		t.taxonomies !== undefined ||
		t.bylines !== undefined ||
		Object.values(t.fields).some((m) => m.type === "reference")
	);
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
```

In `packages/flux-import/src/engine/resolve.ts`, replace
```ts
	/** The job's taxonomy snapshot; a taxonomy missing from it is flat. */
	taxonomies: Readonly<Record<string, TaxonomySnapshot>>;
	dryRun: boolean;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
```
with:
```ts
	/** The job's taxonomy snapshot; a taxonomy missing from it is flat. */
	taxonomies: Readonly<Record<string, TaxonomySnapshot>>;
	dryRun: boolean;
	/**
	 * A dry run's own plans: whether an earlier record of the job would create an entry with
	 * this key in the job's collection and locale, as a real run would have by now.
	 */
	plannedKey?: (key: string) => Promise<boolean>;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
```

then replace
```ts
	readonly terms = new Map<string, TermIndex>();
	/** Terms a dry run would have created, numbered for their placeholder IDs. */
	planned = 0;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();
}
```
with:
```ts
	readonly terms = new Map<string, TermIndex>();
	/** Terms a dry run would have created, numbered for their placeholder IDs. */
	planned = 0;
	/** A dry run's keys planned for creation in the job's collection, once loaded. */
	plannedKeys: Set<string> | null = null;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();
}
```

then replace
```ts
	for (const value of values) {
		try {
			const found = await findReference(deps, cache, target, match, value, locale);
			if (found) items.push({ group: found.group, value: found.id, text: found.id });
			else {
				const message = NOT_FOUND_BY[match](target, value, locale);
				errors.push({ field, code: "reference_not_found", message });
			}
```
with:
```ts
	for (const value of values) {
		try {
			const found = await findReference(deps, cache, target, match, value, locale);
			const own = match === "key" && target === ctx.template.collection;
			if (found) items.push({ group: found.group, value: found.id, text: found.id });
			else if (own && ctx.dryRun && ctx.plannedKey && (await ctx.plannedKey(value))) {
				items.push({ group: null, value: "", text: value });
			} else {
				const message = NOT_FOUND_BY[match](target, value, locale);
				errors.push({ field, code: "reference_not_found", message });
			}
```

then replace
```ts
	return { ok: true, links: resolved, newTerms };
}

```
with:
```ts
	return { ok: true, links: resolved, newTerms };
}

/**
 * How the record log shows an assigned term: its slug path when the batch loaded it (the
 * template's locale), else its translation group.
 */
export function termPath(cache: LookupCache, taxonomy: string, group: string): string {
	const index = cache.terms.get(taxonomy);
	const term = index?.byGroup.get(group);
	if (!index || !term) return group;
	return index
		.pathOf(term)
		.map((t) => t.slug)
		.join("/");
}

```

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import { comparisonsOf, type PlanAction, planRecord, type RecordPlan } from "./diff.js";
import { JobError, jobReader, jobTemplate, updateJob, upgradeJob } from "./jobs.js";
import { ContentWriteError, type EntrySnapshot, SourceMissingError } from "./ports.js";
import {
	applyTemplate,
	type CompiledTemplate,
```
with:
```ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type PlanAction,
	planRecord,
	type RecordPlan,
} from "./diff.js";
import { JobError, jobReader, jobTemplate, updateJob, upgradeJob } from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	SourceMissingError,
} from "./ports.js";
import { LookupCache, resolveLinks, termPath } from "./resolve.js";
import {
	applyTemplate,
	type CompiledTemplate,
```

then replace
```ts
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	opts: { retry: boolean },
): Promise<void> {
	const key = recordKey(job.id, rec.seq);
	const existing = await deps.records.get(key);
```
with:
```ts
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	opts: { retry: boolean; cache?: LookupCache },
): Promise<void> {
	const key = recordKey(job.id, rec.seq);
	const existing = await deps.records.get(key);
```

then replace
```ts
	const save = (fields: RowFields) =>
		deps.records.put(key, { ...base, ...fields, updatedAt: iso(deps) });

	const row = await decide(deps, job, template, rec, existing, save);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
```
with:
```ts
	const save = (fields: RowFields) =>
		deps.records.put(key, { ...base, ...fields, updatedAt: iso(deps) });

	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
```

then replace
```ts
	sourceKey: string;
	linkId: string;
	save: (fields: RowFields) => Promise<void>;
};

const PENDING_DRAFT_MESSAGE =
```
with:
```ts
	sourceKey: string;
	linkId: string;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
};

const PENDING_DRAFT_MESSAGE =
```

then replace
```ts
	return published;
}

async function decide(
	deps: EngineDeps,
	job: Job,
```
with:
```ts
	return published;
}

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
 */
async function currentLinks(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: ResolvedLinks,
): Promise<CurrentLinks> {
	const current: CurrentLinks = {};
	if (resolved.references) {
		current.references = {};
		for (const field of Object.keys(resolved.references)) {
			const refs = entry.references?.[field] ?? [];
			current.references[field] = refs.map((r) => ({ group: r.group, text: r.id }));
		}
	}
	if (resolved.taxonomies) {
		const assigned = await deps.lookups.entryTerms(job.template.collection, entry.id);
		current.taxonomies = {};
		for (const taxonomy of Object.keys(resolved.taxonomies)) {
			current.taxonomies[taxonomy] = (assigned[taxonomy] ?? []).map((group) => ({
				group,
				text: termPath(cache, taxonomy, group),
			}));
		}
	}
	if (resolved.bylines) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/**
 * The keys an earlier record of this dry run plans to create, loaded once per batch from the
 * job's record rows; the batch adds its own as it plans them.
 */
async function plannedKeys(deps: EngineDeps, job: Job, cache: LookupCache): Promise<Set<string>> {
	if (cache.plannedKeys) return cache.plannedKeys;
	const keys = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await deps.records.query({
			where: { jobId: job.id, status: "planned" },
			orderBy: { seq: "asc" },
			limit: RETRY_PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			if (data.action === "create" && data.sourceKey !== null) keys.add(data.sourceKey);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	cache.plannedKeys = keys;
	return keys;
}

/** The link plan for `planRecord`; child-side reference fields compare as sets. */
async function linkPlan(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	resolved: ResolvedLinks,
): Promise<LinkPlan> {
	const childSide = new Set(
		Object.keys(resolved.references ?? {}).filter(
			(field) => job.targetFields?.[field]?.relationSide === "child",
		),
	);
	const current = entry ? await currentLinks(deps, cache, job, entry, resolved) : {};
	return { resolved, current, childSide };
}

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, whatever happens to the record afterwards.
 */
async function decide(
	deps: EngineDeps,
	job: Job,
```

then replace
```ts
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
```
with:
```ts
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found = { newTerms: [] as string[] };
	const row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	return found.newTerms.length > 0 ? { ...row, newTerms: found.newTerms } : row;
}

async function decideRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: { newTerms: string[] },
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
```

then replace
```ts
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		let link = await deps.links.get(ctx.linkId);
		let entry = link ? await deps.content.get(collection, locale, link.entryId) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null) {
			entry = await deps.content.findBySourceId(collection, locale, sourceKey);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
```
with:
```ts
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		if (requests) {
			const resolution = await resolveLinks(
				deps,
				cache,
				{
					template: job.template,
					targets: job.targetFields ?? {},
					taxonomies: job.taxonomies ?? {},
					dryRun: job.dryRun,
					plannedKey: async (key) => (await plannedKeys(deps, job, cache)).has(key),
				},
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (!resolution.ok) {
				return { status: "failed", sourceKey, entryId: null, errors: resolution.errors };
			}
			ctx.links = resolution.links;
		}
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null) {
			entry = await deps.content.findBySourceId(collection, locale, sourceKey, read);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
```

then replace
```ts
			}
		}
		entryId = entry?.id ?? null;
		const plan = planRecord(entry, mapped.value, comparisonsOf(job.template, job.targetFields));
		action = plan.action;
		if (job.dryRun)
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		if (!entry) return await writeRecord(ctx, null, plan, mapped.value);
		if (plan.action === "unchanged")
			return await finishUnchanged(ctx, entry, link, existing, repaired);
```
with:
```ts
			}
		}
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		const plan = planRecord(entry, mapped.value, comparisons, links);
		action = plan.action;
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys?.add(sourceKey);
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (!entry) return await writeRecord(ctx, null, plan, mapped.value);
		if (plan.action === "unchanged")
			return await finishUnchanged(ctx, entry, link, existing, repaired);
```

then replace
```ts
	};
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
```
with:
```ts
	};
}

/** A create's links: every non-empty one. New byline credits have no role label. */
function createLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (items.length === 0) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (items.length === 0) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && resolved.bylines.length > 0) {
		writes.bylines = resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null }));
	}
	return writes;
}

/**
 * An update's links: only the changed ones, each replacing the entry's (an empty list clears
 * it). A byline the entry is already credited with keeps its role label.
 */
function updateLinks(
	resolved: ResolvedLinks | undefined,
	plan: RecordPlan,
	entry: EntrySnapshot,
): LinkWrites {
	const changed = new Set(plan.changes.map((c) => c.field));
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (!changed.has(`taxonomies.${taxonomy}`)) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (!changed.has(field)) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && changed.has("bylines")) {
		const roles = new Map((entry.bylines ?? []).map((b) => [b.group, b.roleLabel]));
		writes.bylines = resolved.bylines.map((b) => ({
			bylineId: b.value,
			roleLabel: roles.get(b.group as string) ?? null,
		}));
	}
	return writes;
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
```

then replace
```ts
			locale,
			...slugPart,
			data: { ...mapped.data, [SOURCE_ID_FIELD]: sourceKey },
		});
	} else {
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...slugPart,
			data: mapped.data,
		});
		if (!result.ok) {
			return result.reason === "conflict"
```
with:
```ts
			locale,
			...slugPart,
			data: { ...mapped.data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out: on a collection with revisions that
		// would stage a draft identical to the live entry.
		const dataChanged = plan.changes.some(
			(c) => c.field === "slug" || Object.hasOwn(mapped.data, c.field),
		);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data: mapped.data } : {}),
			...updateLinks(ctx.links, plan, entry),
		});
		if (!result.ok) {
			return result.reason === "conflict"
```

then replace
```ts
	template: CompiledTemplate,
	started: number,
	limit: number,
): Promise<Outcome> {
	const stream = await deps.source.open(job.uploadId, job.cursor.offset);
	let processed = 0;
```
with:
```ts
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const stream = await deps.source.open(job.uploadId, job.cursor.offset);
	let processed = 0;
```

then replace
```ts
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		await processRecord(deps, job, template, rec, { retry: false });
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
```
with:
```ts
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		await processRecord(deps, job, template, rec, { retry: false, cache });
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
```

then replace
```ts
	template: CompiledTemplate,
	started: number,
	limit: number,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
```
with:
```ts
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
```

then replace
```ts
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			await processRecord(deps, job, template, rec, { retry: true });
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
```
with:
```ts
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			await processRecord(deps, job, template, rec, { retry: true, cache });
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
```

then replace
```ts
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` when that is smaller; the job is not changed.
 */
export async function runBatch(
	deps: EngineDeps,
	jobId: string,
	holder: string,
	maxRecords = Number.POSITIVE_INFINITY,
): Promise<Job> {
	const claimed = await claim(deps, jobId, holder);
	if (!claimed.ok) return claimed.job;
	const job = claimed.job;
	const started = deps.now();
	const limit = Math.min(job.batchSize, maxRecords);
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
```
with:
```ts
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link lookups are cached for the batch.
 */
export async function runBatch(
	deps: EngineDeps,
	jobId: string,
	holder: string,
	maxRecords: number | ((job: Job) => number) = Number.POSITIVE_INFINITY,
): Promise<Job> {
	const claimed = await claim(deps, jobId, holder);
	if (!claimed.ok) return claimed.job;
	const job = claimed.job;
	const started = deps.now();
	const cap = typeof maxRecords === "number" ? maxRecords : maxRecords(job);
	const limit = Math.min(job.batchSize, cap);
	const cache = new LookupCache();
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
```

then replace
```ts
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
		});
		if (!compiled.ok) {
			outcome = {
```
with:
```ts
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
		});
		if (!compiled.ok) {
			outcome = {
```

then replace
```ts
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit)
					: await importPass(deps, job, template, started, limit);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
```
with:
```ts
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit, cache)
					: await importPass(deps, job, template, started, limit, cache);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
```

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import type { LinkSchema, SchemaField } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```
with:
```ts
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```

then replace
```ts
 * and each record costs about nine plugin storage calls plus EmDash's own content queries.
 */
export const WORKERS_BATCH_CAP = 20;

/** A failure the route layer turns into an HTTP error with this code and status. */
export class ServiceError extends Error {
```
with:
```ts
 * and each record costs about nine plugin storage calls plus EmDash's own content queries.
 */
export const WORKERS_BATCH_CAP = 20;
/**
 * `WORKERS_BATCH_CAP` for jobs whose template maps reference fields, taxonomies or bylines: each
 * record also looks its links up and reads them back.
 */
export const WORKERS_LINKED_BATCH_CAP = 10;

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	return usesLinks(job.template) ? WORKERS_LINKED_BATCH_CAP : WORKERS_BATCH_CAP;
}

/** A failure the route layer turns into an HTTP error with this code and status. */
export class ServiceError extends Error {
```

then replace
```ts
		deps,
		id,
		holder,
		onWorkers() ? WORKERS_BATCH_CAP : Number.POSITIVE_INFINITY,
	);
	await releaseQuietly(deps, uploads, job, keep);
	return job;
```
with:
```ts
		deps,
		id,
		holder,
		onWorkers() ? workersBatchCap : Number.POSITIVE_INFINITY,
	);
	await releaseQuietly(deps, uploads, job, keep);
	return job;
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run link-import service`
Expected: PASS (39 tests: 10 in `link-import.test.ts`, 29 in `service.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 43 files / 1,101 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/batch.ts packages/flux-import/src/engine/resolve.ts packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/link-import.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Resolve and write links in batches, list new terms on records, and cap linked Workers batches at 10"
```

### Task 8: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/fixtures/links.ts`, `packages/flux-import/tests/integration/links.test.ts`
- Modify: `packages/flux-import/tests/integration/client.ts`

**Interfaces:**
- Consumes: Tasks 1-7 through HTTP; the integration harness (`Client`, `runToEnd`, `records`, `listAll`); E2, E3, E7; V1-V3.
- Produces: `tests/fixtures/links.ts` (`LinkNames`, `linkNames(prefix)`, `createLinkSchema(client, n)`, `PEOPLE_CSV`, `peopleTemplate`, `postsTemplate(n, format?)`, `POSTS_CSV`, `postsStored(n)`, `POSTS_JSON`); `Client.entryTerms(collection, id, taxonomy)`, `Product.references`/`bylines`; six integration tests.

- [ ] **Step 1: Add the fixture, the client helpers and the tests**

Create `packages/flux-import/tests/fixtures/links.ts`:
```ts
/**
 * Schema, sources and templates for the M4b link imports on the Node and workerd sites: a
 * `people` collection imported first (for `match: "key"`), a `posts` collection with a single
 * reference to people and a multiple reference to posts, a hierarchical category taxonomy and a
 * flat tag taxonomy attached to posts, and two bylines.
 */
import type { Client } from "../integration/client.js";

export type LinkNames = {
	people: string;
	posts: string;
	category: string;
	tag: string;
	/** Byline slugs. */
	alex: string;
	sam: string;
};

export function linkNames(prefix: string): LinkNames {
	return {
		people: `${prefix}_people`,
		posts: `${prefix}_posts`,
		category: `${prefix}_category`,
		tag: `${prefix}_tag`,
		alex: `${prefix}-alex`,
		sam: `${prefix}-sam`,
	};
}

/**
 * Creates both collections (with revisions), the reference fields, both taxonomies (the tags
 * `new` and `sale` exist) and the bylines "Alex Doe" and "Sam Lee", through the admin API.
 */
export async function createLinkSchema(client: Client, n: LinkNames): Promise<void> {
	for (const collection of [n.people, n.posts]) {
		await client.createCollection(collection);
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
		});
	}
	await client.api("POST", `/_emdash/api/schema/collections/${n.posts}/fields`, {
		slug: "author",
		label: "Author",
		type: "reference",
		validation: { targetCollection: n.people },
	});
	await client.api("POST", `/_emdash/api/schema/collections/${n.posts}/fields`, {
		slug: "related",
		label: "Related",
		type: "reference",
		validation: { targetCollection: n.posts, multiple: true },
	});
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.category,
		label: "Categories",
		hierarchical: true,
		collections: [n.posts],
	});
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.tag,
		label: "Tags",
		collections: [n.posts],
	});
	for (const [slug, label] of [
		["new", "New"],
		["sale", "Sale"],
	]) {
		await client.api("POST", `/_emdash/api/taxonomies/${n.tag}/terms`, {
			slug,
			label,
			locale: "en",
		});
	}
	for (const [slug, displayName] of [
		[n.alex, "Alex Doe"],
		[n.sam, "Sam Lee"],
	]) {
		await client.api("POST", "/_emdash/api/admin/bylines", { slug, displayName, locale: "en" });
	}
}

export const PEOPLE_CSV = "id,Name\nA1,Alex\nA2,Sam\n";

export function peopleTemplate(n: LinkNames) {
	return {
		version: 1,
		collection: n.people,
		locale: "en",
		key: { from: "id" },
		fields: { title: { from: "Name", type: "text" } },
	};
}

/** Posts: `author` by import key, `related` by slug, categories by label path, tags by slug. */
export function postsTemplate(n: LinkNames, format: "csv" | "json" = "csv") {
	return {
		version: 1,
		collection: n.posts,
		locale: "en",
		source: { format },
		key: { from: "id" },
		fields: {
			title: { from: "Title", type: "text" },
			author: { from: "Author", type: "reference", match: "key" },
			related: { from: "Related", type: "reference", match: "slug", separator: "|" },
		},
		taxonomies: {
			[n.category]: {
				from: "Categories",
				match: "label",
				separator: ";",
				hierarchy: ">",
				create: true,
			},
			[n.tag]: { from: "Tags", separator: "|" },
		},
		bylines: { from: "Authors", match: "name", separator: ";" },
	};
}

/** P2 links to P1 by its slug, and P3 to both; P1 and P3 share a new category path. */
export const POSTS_CSV = [
	"id,Title,Author,Related,Categories,Tags,Authors",
	"P1,Desk review,A1,,Electronics > Phones,new|sale,Alex Doe",
	"P2,Lamp review,A2,desk-review,Garden,new,Sam Lee;Alex Doe",
	"P3,Chair review,A1,desk-review|lamp-review,Electronics > Phones;Electronics > Laptops,,",
	"",
].join("\n");

/** What `POSTS_CSV` stores, per key: term slugs, byline slugs, and link targets by key. */
export function postsStored(n: LinkNames) {
	return {
		P1: {
			category: ["phones"],
			tag: ["new", "sale"],
			bylines: [n.alex],
			author: "A1",
			related: [],
		},
		P2: {
			category: ["garden"],
			tag: ["new"],
			bylines: [n.sam, n.alex],
			author: "A2",
			related: ["P1"],
		},
		P3: {
			category: ["phones", "laptops"],
			tag: [],
			bylines: [],
			author: "A1",
			related: ["P1", "P2"],
		},
	};
}

/** The same posts as JSON records with arrays, under other keys. */
export const POSTS_JSON = JSON.stringify([
	{
		id: "J1",
		Title: "Desk guide",
		Author: "A2",
		Related: ["desk-review", "lamp-review"],
		Categories: ["Electronics > Phones", "Garden"],
		Tags: ["sale"],
		Authors: ["Sam Lee"],
	},
]);
```

In `packages/flux-import/tests/integration/client.ts`, replace
```ts
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	liveRevisionId: string | null;
}

/** HTTP client for the dev site with an Admin PAT (Bearer tokens skip the CSRF header). */
```
with:
```ts
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	liveRevisionId: string | null;
	/** Reference selections (the first page), a staged draft selection first. */
	references?: Record<string, { children: { id: string; translationGroup: string | null }[] }>;
	bylines?: { byline: { slug: string }; roleLabel: string | null; source: string }[];
}

/** HTTP client for the dev site with an Admin PAT (Bearer tokens skip the CSRF header). */
```

then replace
```ts
		);
	}

	async runToEnd(id: string, maxBatches = 1000): Promise<Job> {
		for (let i = 0; i < maxBatches; i++) {
			const job = await this.plugin("jobs/next", { id });
```
with:
```ts
		);
	}

	/** The slugs of the entry's terms in one taxonomy. */
	async entryTerms(collection: string, id: string, taxonomy: string): Promise<string[]> {
		const data = await this.api<{ terms: { slug: string }[] }>(
			"GET",
			`/_emdash/api/content/${collection}/${id}/terms/${taxonomy}`,
		);
		return data.terms.map((t) => t.slug);
	}

	async runToEnd(id: string, maxBatches = 1000): Promise<Job> {
		for (let i = 0; i < maxBatches; i++) {
			const job = await this.plugin("jobs/next", { id });
```

Create `packages/flux-import/tests/integration/links.test.ts`:
```ts
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	createLinkSchema,
	linkNames,
	PEOPLE_CSV,
	POSTS_CSV,
	POSTS_JSON,
	peopleTemplate,
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import { Client, type Product } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));
const n = linkNames("it");

async function importText(
	body: string,
	template: object,
	opts: { filename?: string; dryRun?: boolean; publish?: boolean } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(body, opts.filename ?? "data.csv");
	const job = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: 10,
	});
	return client.runToEnd(job.id);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

const entry = async (collection: string, id: string) =>
	(await client.api<{ item: Product }>("GET", `/_emdash/api/content/${collection}/${id}?locale=en`))
		.item;

/** An entry's links as keys and slugs: terms, bylines, and reference targets by import key. */
async function linksOf(id: string, keysById: Map<string, string>) {
	const item = await entry(n.posts, id);
	const keys = (field: string) =>
		(item.references?.[field]?.children ?? []).map((c) => keysById.get(c.id) ?? c.id);
	return {
		category: await client.entryTerms(n.posts, id, n.category),
		tag: await client.entryTerms(n.posts, id, n.tag),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
		author: keys("author")[0],
		related: keys("related"),
	};
}

async function keysById(): Promise<Map<string, string>> {
	const all = [...(await client.listAll(n.people)), ...(await client.listAll(n.posts))];
	return new Map(all.map((e) => [e.id, e.data.flux_source_id as string]));
}

describe("M4b links end to end", () => {
	beforeAll(async () => {
		await createLinkSchema(client, n);
		const people = await importText(PEOPLE_CSV, peopleTemplate(n));
		expect(people.counters).toMatchObject({ created: 2, failed: 0 });
	});

	it("reports missing terms, entries and bylines in a dry run, and the terms it would create", async () => {
		const csv = [
			"id,Title,Author,Related,Categories,Tags,Authors",
			"D1,Dry one,A1,,Electronics > Phones,new,Alex Doe",
			"D2,Dry two,A9,no-such-post,Garden,old,Nobody",
			"",
		].join("\n");
		const job = await importText(csv, postsTemplate(n), { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		const rows = await client.records(job.id);
		expect(rows[0]).toMatchObject({
			status: "planned",
			newTerms: [`${n.category}: Electronics`, `${n.category}: Electronics > Phones`],
		});
		expect(rows[1]?.errors?.map((e) => [e.field, e.code])).toEqual([
			["author", "reference_not_found"],
			["related", "reference_not_found"],
			[`taxonomies.${n.tag}`, "term_not_found"],
			["bylines", "byline_not_found"],
		]);
		expect(await client.listAll(n.posts)).toEqual([]);
		const terms = await client.api<{ terms: unknown[] }>(
			"GET",
			`/_emdash/api/taxonomies/${n.category}/terms?locale=en`,
		);
		expect(terms.terms).toEqual([]);
	});

	it("builds the category tree, links every post, and re-runs as unchanged", async () => {
		const job = await importText(POSTS_CSV, postsTemplate(n));
		expect(job.counters).toMatchObject({ created: 3, failed: 0 });
		const rows: RecordRow[] = await client.records(job.id);
		expect(rows.map((r) => r.newTerms)).toEqual([
			[`${n.category}: Electronics`, `${n.category}: Electronics > Phones`],
			[`${n.category}: Garden`],
			[`${n.category}: Electronics > Laptops`],
		]);
		const keys = await keysById();
		const posts = await byKey(n.posts);
		for (const [key, expected] of Object.entries(postsStored(n))) {
			const post = posts.get(key);
			expect(post?.status, key).toBe("published");
			expect(await linksOf(post!.id, keys), key).toEqual(expected);
		}
		const again = await importText(POSTS_CSV, postsTemplate(n));
		expect(again.counters).toMatchObject({ unchanged: 3, created: 0, updated: 0, failed: 0 });
	});

	it("imports JSON arrays and re-runs them as unchanged", async () => {
		const template = postsTemplate(n, "json");
		const job = await importText(POSTS_JSON, template, { filename: "posts.json" });
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		const j1 = (await byKey(n.posts)).get("J1")!;
		expect(await linksOf(j1.id, await keysById())).toEqual({
			category: ["phones", "garden"],
			tag: ["sale"],
			bylines: [n.sam],
			author: "A2",
			related: ["P1", "P2"],
		});
		const again = await importText(POSTS_JSON, template, { filename: "posts.json" });
		expect(again.counters).toMatchObject({ unchanged: 1 });
	});

	it("fails a key reference to an entry not imported yet, and imports it on retry", async () => {
		const csv = "id,Title,Author,Related,Categories,Tags,Authors\nF1,Forward,A3,,,,\n";
		const job = await importText(csv, postsTemplate(n));
		expect(job.counters).toMatchObject({ failed: 1 });
		expect((await client.records(job.id))[0]?.errors?.[0]).toMatchObject({
			field: "author",
			code: "reference_not_found",
		});
		await importText("id,Name\nA3,Ari\n", peopleTemplate(n));
		await client.plugin("jobs/retry", { id: job.id });
		const retried = await client.runToEnd(job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const f1 = (await byKey(n.posts)).get("F1")!;
		expect((await linksOf(f1.id, await keysById())).author).toBe("A3");
	});

	it("with publish: false writes terms and bylines live and stages references", async () => {
		const changed = POSTS_CSV.replace(
			"P1,Desk review,A1,,Electronics > Phones,new|sale,Alex Doe",
			"P1,Desk review,A2,lamp-review,Electronics > Phones,sale,Sam Lee",
		);
		const job = await importText(changed, postsTemplate(n), { publish: false });
		expect(job.counters).toMatchObject({ updated: 1, unchanged: 2 });
		const [row] = (await client.records(job.id)).filter((r) => r.status === "updated");
		expect(row?.changes?.map((c) => c.field)).toEqual([
			"author",
			"related",
			`taxonomies.${n.tag}`,
			"bylines",
		]);
		const p1 = (await byKey(n.posts)).get("P1")!;
		const item = await entry(n.posts, p1.id);
		// References are staged in a draft; terms and bylines are live metadata in EmDash.
		expect(item.draftRevisionId).not.toBeNull();
		expect(await linksOf(p1.id, await keysById())).toMatchObject({
			tag: ["sale"],
			bylines: [n.sam],
			author: "A2",
			related: ["P2"],
		});
		const rerun = await importText(changed, postsTemplate(n), { publish: false });
		expect(rerun.counters).toMatchObject({ unchanged: 3 });
		// A publishing run publishes the draft this importer staged.
		const publish = await importText(changed, postsTemplate(n));
		expect(publish.counters).toMatchObject({ updated: 1, unchanged: 2 });
		expect((await entry(n.posts, p1.id)).draftRevisionId).toBeNull();
	});

	it("clears a taxonomy given no value, sending only that link", async () => {
		const cleared = POSTS_CSV.replace(
			"P2,Lamp review,A2,desk-review,Garden,new,Sam Lee;Alex Doe",
			"P2,Lamp review,A2,desk-review,Garden,,Sam Lee;Alex Doe",
		);
		const job = await importText(cleared, postsTemplate(n));
		// P1 goes back to its first values; P2 loses its tags.
		const row = (await client.records(job.id)).find((r) => r.sourceKey === "P2");
		expect(row).toMatchObject({ status: "updated" });
		expect(row?.changes).toEqual([{ field: `taxonomies.${n.tag}`, before: ["new"], after: null }]);
		const p2 = (await byKey(n.posts)).get("P2")!;
		expect(await client.entryTerms(n.posts, p2.id, n.tag)).toEqual([]);
		expect(p2.status).toBe("published");
		const again = await importText(cleared, postsTemplate(n));
		expect(again.counters).toMatchObject({ unchanged: 3, updated: 0 });
	});
});
```

- [ ] **Step 2: Run the new file on the shared dev server**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts links`
Expected: PASS (6 tests; about 7 s including the server start). It also proves V1-V3 in use: terms created through `ctx.taxonomies.createTerm`, link-only updates on a revisioned collection that keep the entry `published`, and references staged by `publish: false` read back with drafts.

- [ ] **Step 3: Run the whole Node suite**

Run: `pnpm test:integration`
Expected: 11 files / 59 tests pass in about 510 s (10 / 53 before) (Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles).

- [ ] **Step 4: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/fixtures/links.ts packages/flux-import/tests/integration/client.ts packages/flux-import/tests/integration/links.test.ts
git commit -m "Prove taxonomies, references and bylines end to end on the Node dev site"
```

### Task 9: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7 through HTTP; Task 8's fixture (`linkNames`, `createLinkSchema`, `PEOPLE_CSV`, `peopleTemplate`, `POSTS_CSV`, `postsTemplate`, `postsStored`); the parity harness; V1-V3 on workerd and D1.
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
import type { SourceRow } from "../../src/plugin/sources.js";
import { TYPES_CSV, TYPES_CSV_STORED, typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
import { productsCsv, template } from "../integration/fixtures.js";
import { CF_SITE_DIR } from "./global-setup.js";
```
with:
```ts
import type { SourceRow } from "../../src/plugin/sources.js";
import { TYPES_CSV, TYPES_CSV_STORED, typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import {
	createLinkSchema,
	linkNames,
	PEOPLE_CSV,
	POSTS_CSV,
	peopleTemplate,
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
import { productsCsv, template } from "../integration/fixtures.js";
import { CF_SITE_DIR } from "./global-setup.js";
```

then replace
```ts
		}
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
```
with:
```ts
		}
	});

	it("imports M4b links on D1: a created term path, a key reference and bylines", async () => {
		const n = linkNames("cf");
		await createLinkSchema(client, n);
		const importLinked = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			return client.runToEnd(job.id);
		};
		expect((await importLinked(PEOPLE_CSV, peopleTemplate(n))).counters).toMatchObject({
			created: 2,
		});
		const done = await importLinked(POSTS_CSV, postsTemplate(n));
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		const people = new Map(
			(await client.listAll(n.people)).map((e) => [e.id, e.data.flux_source_id as string]),
		);
		const posts = await byKey(n.posts);
		const expected = postsStored(n);
		for (const key of ["P1", "P2"] as const) {
			const post = posts.get(key)!;
			const { item } = await client.api<{ item: Product }>(
				"GET",
				`/_emdash/api/content/${n.posts}/${post.id}?locale=en`,
			);
			const author = item.references?.author?.children[0]?.id;
			expect(people.get(author ?? ""), key).toBe(expected[key].author);
			expect(
				item.bylines?.map((b) => b.byline.slug),
				key,
			).toEqual(expected[key].bylines);
			expect(await client.entryTerms(n.posts, post.id, n.category), key).toEqual(
				expected[key].category,
			);
			expect(await client.entryTerms(n.posts, post.id, n.tag), key).toEqual(expected[key].tag);
		}
		expect((await importLinked(POSTS_CSV, postsTemplate(n))).counters).toMatchObject({
			unchanged: 3,
		});
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
```

- [ ] **Step 2: Run the new test on workerd**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M4b links"`
Expected: PASS (1 test, about 12 s plus 30 s of server start; the other eight are skipped). This proves on workerd and D1 that `ctx.taxonomies.createTerm` builds a term path, that a `key` reference and bylines resolve and read back, and that a re-run is `unchanged`. The full `pnpm test:cf` runs in Task 10.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove an M4b link import on workerd"
```

### Task 10: M4b review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-m4b-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`

**Interfaces:**
- Consumes: everything above, and the Task 0 results.
- Produces: the filled-in review note and the roadmap status; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 25 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass`, record each result:
1. Create the link schema with `createLinkSchema(client, linkNames("m4b"))` from `tests/fixtures/links.ts` (or the same REST calls by hand) and import `PEOPLE_CSV` with `peopleTemplate`. Run `jobs/create` with `postsTemplate` and `POSTS_CSV` as a dry run: `jobs/records` shows the three rows `planned`, with `newTerms` listing `m4b_category: Electronics`, `m4b_category: Electronics > Phones`, `m4b_category: Garden` and `m4b_category: Electronics > Laptops`; the category taxonomy in the admin still has no terms.
2. Run it for real: the admin's taxonomy screen shows the tree Electronics → Phones, Laptops and Garden; each post's editor shows its author, related posts, tags and bylines as `postsStored` lists them.
3. Run it again: `unchanged: 3`.
4. Change one post's `Author` to `A9` and a `Tags` value to `old`, and run a dry run: the row fails with `reference_not_found` and `term_not_found`, and `jobs/log.csv` carries both codes.
5. Run the original file with `publish: false` after changing one post's tags and related posts: the tags show at once on the live entry, the related posts appear only in the draft (the admin's draft view), and a publishing run publishes them. Restore `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-27-m4b-review.md` from this template and fill in every `…`:
````markdown
# Milestone 4b review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0)

| Fact | Check | Result |
| --- | --- | --- |
| V1: `ctx.taxonomies` (with `createTerm`) and `ctx.bylines` in a native route, Node and workerd | probe route; Task 9 on workerd | … |
| V2: a taxonomy-only update on a revisioned collection keeps `_rev` in step with a read | probe route; Task 8 | … |
| V3: `includeDrafts` reads the staged selection, then the published one | probe route; Task 8 | … |

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
| Conversion: arrays and separated text, trimming, empty items, duplicates, limits (51 references, 2 into a single field, 101 terms, 11 segments), `a//b`, `hierarchy` equal to `separator` refused, a flat taxonomy not split, required empty reference | `links.test.ts` | … |
| Resolution: slug flat and path (`term_path_mismatch`), label exact and case-insensitive, ambiguous siblings, creation of a chain (parent row IDs, label mode without slug, slug mode refusing a non-slug), `CONFLICT` re-read, dry run creating nothing and listing `newTerms`; references by ID (a slug is not found), slug in locale, key via link and `flux_source_id`, misses not cached, hits cached; bylines by slug and name, ambiguous names, the 5,000 limit | `resolve.test.ts`, `lookups.test.ts` | … |
| Schema checks: reference compatibility, unbound field, missing target, `key` without `flux_source_id`, unknown and unattached taxonomy, `hierarchy` warning on a flat taxonomy | `template.test.ts`, `jobs.test.ts`, `service.test.ts` | … |
| Diff and writes: set vs ordered comparison, child-side sets, `null` against empty, update with only links omits `data`, role labels kept, create sends links | `diff.test.ts`, `content.test.ts`, `link-import.test.ts` | … |
| Integration on `sites/dev`: tree built by a CSV with label paths and `create: true` and a re-run `unchanged`; JSON arrays; dry run with `term_not_found`, `reference_not_found` and `newTerms` without writing; forward `key` reference then `jobs/retry`; `publish: false` with terms live and references staged; an empty value clears a taxonomy | `links.test.ts` | … |
| workerd: a created term path, a `key` reference and bylines on D1, and a re-run `unchanged` | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Dry run lists `newTerms`, creates nothing | … | … |
| 2 | Real run: term tree and links in the admin | … | … |
| 3 | Re-run unchanged | … | … |
| 4 | Dry-run lookup errors in records and log CSV | … | … |
| 5 | `publish: false`: terms live, references in the draft, then published | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Mark M4b done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| M4b | Taxonomy paths, references and bylines: term lookup by slug or `parent/child` path with optional creation, assigned through the content write's `taxonomies`; reference fields by entry ID, slug or source key (`references` for relation-bound fields); existing bylines only, by slug or exact name, through `bylines` | Planned |
```
with:
```markdown
| **M4b** ([spec](./2026-10-27-flux-import-m4b-taxonomies-references-design.md)) | Taxonomy paths, references and bylines: term lookup by slug or `parent/child` path with optional creation, assigned through the content write's `taxonomies`; reference fields by entry ID, slug or source key (`references` for relation-bound fields); existing bylines only, by slug or exact name, through `bylines` | Done ([review](../notes/2026-10-27-m4b-review.md)) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-10-27-m4b-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 4b review results and mark M4b done in the roadmap"
```

---

## After this plan

M4b is the second part of Milestone 4. Known gaps carried forward, all documented in the spec: a mapped taxonomy replaces the entry's terms of that taxonomy (an additive mode waits for M5's "update only these fields"); terms and bylines are looked up in the template's locale only, and term translations are not linked (M4e); a `key` reference to an entry the job writes later fails until `jobs/retry` or a second run; two jobs creating the same label at the same time in `label` mode can make two terms; bylines are never created, and role labels never come from the source; more than 50 references per field and unbound (legacy) reference fields are refused; on revisioned collections taxonomies and bylines are written live even when `publish: false` stages the data (EmDash behaviour). M4c (media) and M4d (Portable Text) build on the same `LookupPort`/resolver split for objects outside the entry. The M2-M4a open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-10-27-m4a-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands.
