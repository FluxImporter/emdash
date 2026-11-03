# Flux Import M4e: locales and translation links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below); its one step adds i18n to both dev sites. Tasks 0, 1, 3 and 4 can run in parallel worktrees, Task 2 needs Task 1 (see "Parallel execution").

**Goal:** Import translations of entries as EmDash translations, one template (and one job) per locale. A template keeps its single `locale` and gains an optional top-level `translationOf: { from | expr, locale? }`: the column holding the source key of the entry the record translates, in `translationOf.locale` (the site's default locale when left out). The importer finds the source entry the way M4b finds a `match: "key"` reference (link row, then `flux_source_id`) and creates the record's entry with EmDash's `translationOf`, so it joins the source's translation group. For a record with a value, the mappings EmDash shares across a translation group (non-translatable fields, reference fields, taxonomies) are not read, converted, resolved, downloaded, compared or written; the job warns once that they are left to EmDash. A record with an empty value is an entry of its own, as today. A dry run makes the same lookups and writes nothing. Templates stay `version: 1`; templates without `translationOf` behave exactly as in M4a-M4d.

**Architecture:** Job creation resolves `translationOf.locale` next to `locale` (`resolveTranslationLocale` in `src/emdash/locale.ts`, passed to `startJob` as a fifth argument), refuses it without i18n with at least two locales, snapshots `translatable: false` per mapped field (`listSchemaFields`, `targetFieldsOf`), stores `Job.sharedRequired` (required non-translatable fields the template leaves to EmDash) and adds one job warning (`translationWarnings`). `applyTemplate` reads the value right after the key (`MappedRecord.translationOf`) and skips `CompiledTemplate.shared` and every taxonomy for a record with a value, or fails `required` for `sharedRequired` without one. `ContentPort.create` takes `translationOf` and `ContentPort.translations` reads a group (`handleContentTranslations`). `findTranslationSource` (`src/engine/resolve.ts`) reuses M4b's key lookup with the locale in its batch cache key. `processRecord` finds the source next to link resolution, judges it with the record's entry by the spec's decision table (`checkTranslation`), adds a `translationOf` change to a planned linked create, writes a linked create with `translationOf`, `flux_source_id` set to the value and only the bylines as links, and maps a `CONFLICT` or `NOT_FOUND` from that create to `translation_exists` and `translation_source_not_found`. Crash repair looks a linked record's entry up by the value.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-flux-import-m4e-locales-design.md` (all sections; amended by `e6416c7`, see "Rulings" 4 and 13). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 4 split). Previous plan: `docs/superpowers/plans/2026-11-02-flux-import-m4d-portable-text.md`; its review: `docs/superpowers/notes/2026-11-02-m4d-review.md`.

Every code block in Tasks 0 to 7 was written, type-checked, linted and run while this plan was drafted (unit suite, the new Node integration file and the new workerd parity test), then replayed task by task from `12dfdaa` (the spec commit; it changes only docs) in a fresh worktree by a script that parses this document's code blocks and replacements and applies them in order; results are in "Verification while drafting". EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's facts F1-F13 are cited as "spec F<n>".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. No new route, option, capability, storage collection or index: `handleContentTranslations` is on the trusted runtime the plugin already uses (spec "Capabilities").
- No new dependencies; no task touches `package.json` or `pnpm-lock.yaml`.
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine's template schema uses `zod`. The engine (`src/engine/`) never imports `emdash`; i18n is read in `src/emdash/locale.ts` only.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code. Translations are created only through `ContentPort.create` with `translationOf`; the importer never writes `translation_group` or `locale` itself, never moves an entry between groups, and never writes a shared mapping for a record with a `translationOf` value.
- Vitest runs from `packages/flux-import` with file paths: `pnpm exec vitest run tests/unit/translation-import.test.ts`. Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/translations.test.ts`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M4e"`. The new Node integration file starts its own server on port 4392; the shared server uses 4399, the workerd harness 4396, and the other suites 4393-4395, 4397 and 4398: never run two copies of the same harness at once. A Windows process (`Cursor.exe`) may hold 4397 through WSL's mirrored networking, which fails `retention.test.ts` in setup (Fact F3).
- Codes, exactly: record errors `translation_source_not_found` (also a warning on update), `translation_exists`, `translation_of_missing`, `ambiguous_source_id` (M2's), `not_scalar` and `key_too_long` with field `translationOf`, `required` for `Job.sharedRequired`; record warning `translation_not_linked`. Template problems at job creation stay `invalid_template` (400) with one problem per detail.
- Never commit `sites/dev/.env`, tokens, or `sites/dev/emdash-env.d.ts` changes the dev server writes (the shared integration setup restores the file; restore it by hand after any other server run).
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 6 also passes its integration file (about 14 s with server start) and `pnpm test:integration` (about 9 minutes), Task 7 the targeted workerd tests (about 45 s); Task 8 runs everything, `pnpm test:cf` included (about 20 minutes).

## Review Focus

1. Shared values are never written from a translation: for a record with a value, non-translatable fields, reference fields and taxonomies are not read (so a bad or empty value cannot fail the record), not looked up, not downloaded and not in the create or update; the linked create sends only translatable data, the slug, `flux_source_id` (the value) and the bylines: Task 2 ("keeps only the fields a translation owns…"), Task 5 ("creates translations in their sources' groups…", "updates an entry of its own that now names a source…"), Task 6 (French entries carry the English `sku` and `price` although the French feed holds `XX` and `n/a`), Task 7.
2. The decision table (spec "Resolution, diff and writes"), row by row: Task 5 has one test per row (source missing on create and on update, `translation_exists`, linked create, other group, same group, own entry, `translation_of_missing`), plus the `CONFLICT` and `NOT_FOUND` mapping of the create.
3. No editor's translation is ever adopted or overwritten: `translation_exists` before a create, also on `jobs/retry`, where crash repair could otherwise find the editor's entry by its copied `flux_source_id` (Ruling 4): Task 5 ("fails translation_exists for a translation it did not create, also on retry"), Task 6 (an editor's German translation).
4. Re-runs converge: a linked record in the right group plans `unchanged`; a source job's later change of a shared value reaches the translation through EmDash and the translation job stays `unchanged`; neither job's run moves the other's entry revision (Fact V3): Task 5, Task 6 ("syncs a new English price…", "stages a French draft with publish: false…"), Task 7.
5. Locale handling: `translationOf.locale` resolved with the site's casing, defaulted to the default locale, refused without i18n, for an unconfigured locale, for `locale` itself and when left out while `locale` is the default; every lookup names one locale (no fallback): Task 1, Task 4 ("names one locale…").
6. Jobs and templates without `translationOf` behave as before: the only shared-code changes are the reference cache key (now with the locale, Task 4), `translatable: false` in snapshots (absent for translatable fields, so existing snapshots are unchanged), the `group` of the fake content (still the entry's ID unless created with `translationOf`), and the i18n block in both dev sites (Fact V5: the whole integration and parity suites pass with it).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V6 are the facts the spec left unconfirmed; all six were proven while drafting with a temporary probe route (`probe/m4e`, calling the runtime's `handleContentCreate`, `handleContentUpdate`, `handleContentPublish`, `handleContentGet` with `includeDrafts`, `handleContentList`, `handleContentTranslations`, `handleContentDelete`, and `getI18nConfig`/`isI18nEnabled` from `emdash`) on `sites/dev` (port 4410) and `sites/dev-cf` (port 4411), each with i18n `en`, `fr`, `de`, on a collection without revisions and one with revisions. Each collection had non-translatable `sku`, `price` and indexed `flux_source_id`, a reference field, a tag taxonomy and a byline with `fr` and `de` rows. The probe was reverted; the Node and workerd results were identical after normalising IDs, revisions and timestamps.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds.** A create with `translationOf` gives the new entry the source's `translationGroup`; its `sku`, `price` and `flux_source_id` hold the source's values (`S1`, `10`, `E1`) although `WRONG`, `99` and `OTHER` were sent; it reads the source's tag (`new`, the English term) and reference selection; with `bylines` left out it has the source's credit (shown through the byline's `fr` row, Fact E1), and with `bylines: []` none. `handleContentGet` gives the source `translationGroup === id` and the translation another group than its ID. The translation is a `draft`. | probe on Node and workerd, both collections; Tasks 5-7 re-prove it through imports |
| V2 | **Holds.** A second create for the same group and locale (`fr` or `FR`) returns `CONFLICT` "Translation already exists in locale "fr" for this content item"; `handleContentTranslations` lists the group's entries with `id`, `locale`, `slug`, `status`, `updatedAt`; an unknown ID returns `NOT_FOUND`; a create with `translationOf` a trashed entry returns `NOT_FOUND` "Translation source content not found", and `handleContentTranslations` of a trashed entry `NOT_FOUND`; a trashed translation does not block a new one in its locale (the new one takes the source's current shared values). | probe on Node and workerd |
| V3 | **Holds.** An update of the translation with only translatable `data` (and a slug and `bylines: []`), and its publish, leave the source's `_rev`, `updatedAt` and `draftRevisionId` unchanged, without and with revisions. | probe on Node and workerd; Task 6 "stages a French draft with publish: false…" re-proves it through imports |
| V4 | **Recorded.** An update of the source that changes `price` reaches both translations (and on the revisioned collection after the source's publish). It moves every translation's `_rev`; a translation with a pending draft gets a new draft revision holding the new price (its draft title kept). So a translation with the importer's pending draft (`publish: false`) no longer matches its link's `writtenRev` after the sync: its next run reports `pending_draft` when it plans an update, and stays `unchanged` without publishing otherwise (Task 8 records it as an open issue). | probe on Node and workerd |
| V5 | **Holds.** With `i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] }` in both sites, `getI18nConfig()` inside a plugin route returns `{ defaultLocale: "en", locales: ["en", "fr", "de"], prefixDefaultLocale: false }` and `isI18nEnabled()` `true` on Node and workerd. `pnpm test:integration` with it: 12 of 13 files passed, 69 tests passed and 1 skipped in 544.4 s; the 13th, `retention.test.ts`, failed in setup because `Cursor.exe` held port 4397 (Fact F3), and passed alone (1 test, 73.0 s) with its port moved to 4389 in the drafting tree. `pnpm test:cf` with it: 1 file / 13 tests passed in 1,571.7 s. The docs key is Astro's top-level `i18n` block ([i18n guide: configure locales](https://docs.emdashcms.com/guides/internationalization/#configure-locales)); no `routing` block, which the guide says would break the admin. No `FLUX_DEV_I18N` switch is needed. | probe; full suites in the drafting worktree |
| V6 | **Holds.** `handleContentList(collection, { locale: "fr", limit: 2, fieldFilters: { flux_source_id: "K1" } })` returns exactly the French translation (and `de` the German one, `en` the source), on Node and workerd. | probe; Task 5 and Task 6 crash repair |
| E1 | Byline credits are copied by group, but render per locale: `hydrateBylines` shows a credit only where the byline has a row in the entry's locale (`src/api/handlers/content.ts:312-353`, "Strict per-locale (migration 040)"). A translation created without `bylines` whose source credits an English-only byline reads back with no bylines, yet keeps the junction rows. | probe (first run without `fr` byline rows: no credit shown) |
| E2 | A reference selection read from a translation names the targets' variants in the reading locale when they exist (`children[].id` is the French entry, `translationGroup` the English one). The diff compares groups (M4b), so nothing changes for it. | Task 6 "imports French translations…" |
| E3 | `handleContentTranslations` returns `locale: string | null` per row (`src/api/handlers/content.ts:2777-2840`); with i18n configured EmDash always stores a locale. | source reading; Task 3 |
| E4 | A completed job with no failed, conflict or locked rows releases its staged file (`uploadNeeded`, M3c), so `jobs/retry` of such a job fails `source_missing`. Task 6's repair test keeps a failing row in the job. | drafting run of Task 6 |
| E5 | As for any create that a crash interrupts before its written revision is saved (M2), a repaired linked create is left as a draft and reported `publish_unverified`. | Task 5 "repairs a crash after a linked create…" |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition, and M4c's slow-download deferral test can read `seq: 1`. Known since M3c; a re-run of the file settles it. | M3c-M4d plans |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d (Fact F2 there) did not recur while drafting. If Task 7 or Task 8 sees it, capture the server log and record it in the review note. | M4d plan and review |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4397`, which WSL's mirrored networking shares, so `retention.test.ts` fails in setup with "Port 4397 is in use" (M4d review). While drafting, `retention.test.ts` passed with i18n on when its port was moved to 4389 in the drafting tree only. | drafting runs |

## Rulings this plan makes

1. **Where the source locale is resolved.** `startJob` takes a fifth argument, `resolveTranslation: TranslationLocaleResolver` (`(sourceLocale: string | undefined, locale: string) => LocaleResolution`), after `resolveLocale`; `startImport` passes it through and `jobs/create` passes `resolveTranslationLocale`. The default refuses every `translationOf` (no site configuration means no i18n), as the default `keepLocale` keeps every locale. `resolveTranslationLocale(sourceLocale, locale, config = getI18nConfig())` refuses when `config` is null or has fewer than two locales (the test `isI18nEnabled` makes, which reads only the global config), defaults to `config.defaultLocale`, refuses the default when it equals `locale`, and otherwise resolves like `locale` (`resolveSiteLocale`). `checkTemplate` adds the problems a direct `createJob` call can still reach: `translationOf.locale` not set, or equal to `locale` ignoring case. A `translationOf` that is not an object, or whose `locale` is not a string, is left to the template schema.
2. **Messages.** Job creation: `translationOf needs i18n with at least two locales`; `translationOf.locale: Locale "es" is not configured for this site`; `translationOf.locale is required: locale is the default locale ("en")`; `translationOf.locale must differ from locale ("fr")`; `translationOf.locale is not set`. The job warning: `Records with a translationOf value leave these to EmDash, which shares them across the translation group: ` followed by `field "a"`/`fields "a", "b"`, `reference field …`/`reference fields …`, `taxonomy …`/`taxonomies …`, joined with `; `, in template order. Records, all with field `translationOf`: `translation_source_not_found` "No entry in "products" (en) was imported with the key "E3"" (M4b's message), as a warning with "; the entry is updated without its source" appended, and from a create's `NOT_FOUND` "The source entry <id> (en: E3) no longer exists"; `translation_exists` "The source entry already has a translation in fr (entry <id>) that this import did not create"; `translation_of_missing` "The entry is a translation, so the record needs a translationOf value: without one its shared values would overwrite its translation group's"; `translation_not_linked` "The entry is not a translation of en: E2, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation".
3. **An unreadable value still links.** A `translationOf` value whose expression fails, that is not scalar or that is over 256 characters fails the record, and the shared mappings are not read for it either, so the record reports only that problem (no spurious `required` for `sharedRequired`).
4. **Crash repair by the value, guarded (spec amended).** For a record with a value, crash repair looks the entry up with `findBySourceId(collection, locale, <value>)` as the spec says, but an entry found that way is taken only when the record's earlier row is `writing` or names that entry. An editor's translation created through the admin carries the source's `flux_source_id` too (spec F1), so without the guard a `jobs/retry` of a `translation_exists` row would adopt and overwrite it, against spec "Existing translation". With the guard, a missed repair (a `writing` row overwritten by a later failure) ends in `translation_exists` naming the importer's own entry, never in a duplicate or an adopted entry.
5. **One lookup path for sources.** `findTranslationSource` is M4b's `findReference` with `match: "key"` in the source locale, so it shares its costs (`COST_CALL` for the link row, `COST_READ` per content read), its `sourceIdReady` rule (a dry run before the field exists uses link rows only) and the batch cache `LookupCache.entries`, whose key now includes the locale (a reference and a source with the same key in two locales are different entries). Misses are not cached.
6. **Costs.** A template with `translationOf` counts as using links: `COST_RECORD` per record, the Workers cap `WORKERS_LINKED_BATCH_CAP`, and `COST_READ` for the entry read through the link row and for crash repair, as for templates with links. The group read before a planned create costs `COST_READ`; the race re-read after a create's `CONFLICT` is not charged.
7. **The change.** A planned linked create appends `{ field: "translationOf", before: null, after: "<source locale>: <value>" }` after the other changes, in the provisional plan and in the final one. No other plan carries it.
8. **Linked create.** `flux_source_id` is the value; `translationOf` is the source's entry ID; the links are only the bylines, sent whenever the template maps `bylines` (an empty list included), never taxonomies or references (`translationLinks`). An entry of its own (no value) is created exactly as before.
9. **Create errors.** `emdash_not_found` from a linked create becomes `translation_source_not_found`; `emdash_conflict` becomes `translation_exists` when a re-read of the group finds the entry in the job's locale, and stays `emdash_conflict` otherwise. Both rows keep `action: "create"`.
10. **`sharedRequired` errors** come after every other error of the record, one `required` per field in schema order.
11. **Fakes.** `FakeContent` stores a `group` per entry, emulates `translationOf` on create (source in the same collection or `emdash_not_found`, a taken locale `emdash_conflict`, `sharedFields` copied from the source, the group's terms and references, the credits unless `bylines` is given) and answers `translations`. `sharedFields` starts with `flux_source_id`, as `ensureSourceIdField` creates it non-translatable.
12. **Integration crash.** The spec's "kill-and-resume after a linked create and before its link is saved" is proven deterministically in the unit suite (Task 5, `afterWrite` throws after the create). The Node integration test recreates the state such a crash leaves (the record row back to `writing`, the link row removed, through the test's SQLite handle) and runs `jobs/retry`, because a SIGKILL cannot be aimed between the create and the link write. The M2 kill-and-resume suite (`crash.test.ts`) still runs unchanged with i18n on (Fact V5).
13. **Spec amendments** (`e6416c7`): spec F5 notes Fact E1; the "Crash repair" decision gains Ruling 4's guard; "Open issues" records V4's outcome. Nothing else in the spec changes.
14. **Tests not in the spec's list, or moved.** The parity test (Task 7) does not import images; Task 6 covers the shared photo. The spec's "a German job linking to the same English entries" and "an editor's French translation makes `translation_exists`" are one Node test with a German editor's translation (Task 6), and the French case is in Task 5.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (151 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 56 files / 1,349 tests pass (52 / 1,302 at `12dfdaa`) |
| Task 0 (V1-V6) | all six proven on Node and workerd with a temporary probe route and probe test, reverted afterwards (Facts V1-V6) |
| Task-by-task replay | from `12dfdaa` in a fresh worktree, a script parsed this document and applied Tasks 0-7 in numeric order with no failed replacement; each "see them fail" step failed and each "see them pass" step passed with the counts given in the task; typecheck, lint and `pnpm test` passed after every task; the result is byte-identical to the drafting tree (git tree `557356f`) |
| Node integration | on the replayed tree, `translations.test.ts`: 1 file / 8 tests pass in about 13 s with server start. Full `pnpm test:integration` on the replayed tree: 13 of 14 files, 77 tests passed and 1 skipped in 562.4 s; `retention.test.ts` failed in setup on port 4397 (Fact F3) and passes on another port (Fact V5) |
| workerd | on the replayed tree, `-t "M4e"`: 1 passed, 13 skipped, 20.2 s (3.1 s of tests). Full `pnpm test:cf` was run with i18n on before the M4e test existed (Fact V5); Task 8 runs it with the M4e test |

## File map

| File | Responsibility |
| --- | --- |
| `sites/dev/astro.config.mjs`, `sites/dev-cf/astro.config.mjs` | i18n `en`, `fr`, `de` (Task 0) |
| `src/engine/template.ts`, `src/engine/values.ts`, `src/engine/types.ts`, `src/engine/jobs.ts`, `src/emdash/schema.ts`, `src/emdash/locale.ts`, `src/plugin/service.ts`, `src/plugin/xlsx.ts`, `src/plugin/routes.ts` | The `translationOf` schema and paths, `translatable` snapshots, the `checkTemplate` exemption and locale checks, `sharedRequiredOf`, `isSharedMapping`, `translationWarnings`, `usesLinks`; `Job.sharedRequired`; `resolveTranslationLocale` and its plumbing (Task 1) |
| `src/engine/template.ts` | `MappedRecord.translationOf`, `CompiledTemplate.translationOf`/`shared`/`sharedRequired`, `CompileContext.sharedRequired`; reading the value and skipping the shared mappings in `applyTemplate` (Task 2) |
| `src/engine/ports.ts`, `src/emdash/content.ts`, `tests/unit/fakes.ts` | `translationOf` on create, `translations` (Task 3) |
| `src/engine/resolve.ts` | `findTranslationSource`, `sourceNotFoundMessage`, the locale in the reference cache key (Task 4) |
| `src/engine/batch.ts` | Source lookup, `checkTranslation`, crash repair by value, the change, linked creates and their error mapping, `sharedRequired` wiring (Task 5) |
| `tests/fixtures/translations.ts` (new), `tests/integration/translations.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 6 and 7) |

`src/engine/diff.ts`, `src/engine/links.ts`, `src/engine/media.ts`, the Portable Text modules, the source readers, `src/plugin/definition.ts` and `src/plugin/schema-apply.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V6, i18n in the sites | — | `sites/dev/astro.config.mjs`, `sites/dev-cf/astro.config.mjs` | sonnet |
| 1. Template, locales and job creation | — | `src/engine/{template,values,types,jobs}.ts`, `src/emdash/{schema,locale}.ts`, `src/plugin/{service,xlsx,routes}.ts`, `tests/unit/translation-template.test.ts` | sonnet |
| 2. `applyTemplate`: the value and the shared skip | 1 (`translationOf` in `Template`, `isSharedMapping`, `TargetField.translatable`, `SchemaField.translatable`) | `src/engine/template.ts`, `tests/unit/translation-apply.test.ts` | sonnet |
| 3. Ports, adapter and fakes | — | `src/engine/ports.ts`, `src/emdash/content.ts`, `tests/unit/{fakes,fakes.test,content.test}.ts` | sonnet |
| 4. Source lookup | — | `src/engine/resolve.ts`, `tests/unit/translation-source.test.ts` | sonnet |
| 5. Decisions and writes | 0-4 (`MappedRecord.translationOf`, `CompileContext.sharedRequired`, `Job.sharedRequired`, `ContentPort.translations`, `create` with `translationOf`, the fakes, `findTranslationSource`, `sourceNotFoundMessage`) | `src/engine/batch.ts`, `tests/unit/translation-import.test.ts` | opus |
| 6. Node integration | 5 | `tests/fixtures/translations.ts`, `tests/integration/translations.test.ts` | sonnet |
| 7. workerd parity | 6 (`tests/fixtures/translations.ts`) | `tests/integration-cf/parity.test.ts` | sonnet |
| 8. Review run and note | 0-7 | `docs/superpowers/notes/2026-11-03-m4e-review.md`, the roadmap | opus |

Waves: **0 ∥ 1 ∥ 3 ∥ 4**, then **2**, then **5**, then **6**, then **7** (it imports Task 6's fixture), then **8**. Every file is touched by exactly one task except `src/engine/template.ts` (Tasks 1 and 2, in that order). Pass counts in each task's "Run them to see them pass" step are for the task's own test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the unconfirmed facts (V1-V6) and turn on i18n in the dev sites

**Files:**
- Modify: `sites/dev/astro.config.mjs`, `sites/dev-cf/astro.config.mjs`

**Interfaces:**
- Consumed: Astro's top-level `i18n` config (EmDash reads it, spec F9); the runtime handlers of Facts V1-V6.
- Produced: both sites with i18n `en`, `fr`, `de` (default `en`), which Tasks 6 and 7 need; Facts V1-V6 and E1. The Task 8 note records the results from the Facts table.

- [x] **V1** (Node and workerd, without and with revisions): a create with `translationOf` joins the group, takes the source's shared values over the ones sent, reads the source's terms and selection, copies credits only without `bylines`; the source's group is its ID, the translation's is not. Passed (credits render per locale, Fact E1).
- [x] **V2**: a second create in the locale is `CONFLICT`; `handleContentTranslations` lists the group; a trashed source is `NOT_FOUND`; a trashed translation does not block a new one. Passed.
- [x] **V3**: a translation's update without shared fields, and its publish, leave the source's `_rev` and `updatedAt` unchanged, without and with revisions. Passed.
- [x] **V4**: a source update syncs into the translations and moves their `_rev`, a pending draft included (recorded, Fact V4).
- [x] **V5**: `getI18nConfig()` and `isI18nEnabled()` inside a plugin route on Node and workerd; both full suites with i18n on. Passed (Fact V5).
- [x] **V6**: `handleContentList` with `locale: "fr"` and a `flux_source_id` filter finds the translation, on Node and workerd. Passed.

- [ ] **Step 1: Turn on i18n in both sites**

In `sites/dev-cf/astro.config.mjs`, replace
````js
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
````
with:
````js
export default defineConfig({
	output: "server",
	// Translation imports (M4e) need i18n with more than one locale.
	i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] },
	adapter: cloudflare(),
	integrations: [
````

In `sites/dev/astro.config.mjs`, replace
````js
export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
````
with:
````js
export default defineConfig({
	output: "server",
	// Translation imports (M4e) need i18n with more than one locale.
	i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] },
	adapter: node({
		mode: "standalone",
````

- [ ] **Step 2: Check and commit**

Run (from the repo root): `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS (52 files / 1,302 tests; the unit suite does not start a site). Then:
```bash
git add sites/dev/astro.config.mjs sites/dev-cf/astro.config.mjs
git commit -m "Configure the locales en, fr and de in both dev sites for translation imports"
```

### Task 1: Template, locales and job creation

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/values.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/emdash/locale.ts`, `packages/flux-import/src/plugin/service.ts`, `packages/flux-import/src/plugin/xlsx.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/translation-template.test.ts`

**Interfaces:**
- Consumes: `templateSchema`, `valueSource`/`hasOneSource`, `checkTemplate`, `targetFieldsOf`, `linkWarnings`, `usesLinks`; `resolveSiteLocale`, `getI18nConfig`, `I18nConfig` (spec F9); `startJob`, `startImport`, `withSiteLocale`, `prop`; `listSchemaFields` and `RegistryField`.
- Produces: `Template.translationOf?: { from?: string; expr?: string; locale?: string }` (strict, one of `from`/`expr`); `templatePaths` includes `translationOf.from`; `SchemaField.translatable?: false`, `TargetField.translatable?: false` (only recorded when false); `RegistryField.translatable?: boolean`; `checkTemplate` exempts required non-translatable unmapped fields when `translationOf` is mapped, and checks the source locale (Ruling 1); `sharedRequiredOf(t, fields): string[]`; `isSharedMapping(mapping, target): boolean`; `translationWarnings(t, targets): string[]` (Ruling 2); `usesLinks` true for `translationOf`; `Job.sharedRequired?: string[]` (stored when non-empty); `I18N_REQUIRED_MESSAGE`, `resolveTranslationLocale(sourceLocale, locale, config?)` in `src/emdash/locale.ts`; `TranslationLocaleResolver` and `startJob(deps, input, lookupFields, resolveLocale?, resolveTranslation?)`, `startImport(…, resolveLocale?, resolveTranslation?)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/translation-template.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import {
	I18N_REQUIRED_MESSAGE,
	resolveSiteLocale,
	resolveTranslationLocale,
} from "../../src/emdash/locale.js";
import { listSchemaFields, type SchemaRegistryLike } from "../../src/emdash/schema.js";
import { createJob, JobError } from "../../src/engine/jobs.js";
import {
	checkTemplate,
	type SchemaField,
	sharedRequiredOf,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
	translationWarnings,
	usesLinks,
} from "../../src/engine/template.js";
import { startJob, WORKERS_LINKED_BATCH_CAP, workersBatchCap } from "../../src/plugin/service.js";
import { makeDeps } from "./fakes.js";

const i18n = { defaultLocale: "en", locales: ["en", "fr", "de"] };

const raw = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	fields: { title: { from: "Nom", type: "text" } },
	...extra,
});
const parse = (extra: Record<string, unknown> = {}): Template => templateSchema.parse(raw(extra));

const fields: SchemaField[] = [
	{ slug: "title", type: "string", required: true },
	{ slug: "sku", type: "string", required: true, translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "weight", type: "number", required: true, hasDefault: true, translatable: false },
	{ slug: "flux_source_id", type: "string", translatable: false },
];

describe("translationOf in the template", () => {
	it("reads one of from and expr, with an optional locale", () => {
		expect(parse().translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(parse({ translationOf: { expr: "en_id" } }).translationOf).toEqual({ expr: "en_id" });
		for (const bad of [
			{},
			{ from: "a", expr: "b" },
			{ from: "a", locale: "" },
			{ from: "a", match: "slug" },
			"en_id",
		]) {
			expect(templateSchema.safeParse(raw({ translationOf: bad })).success).toBe(false);
		}
		expect(templateSchema.parse(raw({ translationOf: undefined })).translationOf).toBeUndefined();
	});

	it("checks its column against the CSV header", () => {
		const t = parse();
		expect(templatePaths(t)).toEqual(["id", "en_id", "Nom"]);
		expect(checkTemplate(t, fields, ["id", "Nom"])).toEqual([
			'Column "en_id" not found in the source',
		]);
	});

	it("needs a source locale other than the job's", () => {
		const own = fields.filter((f) => f.slug === "title");
		expect(checkTemplate(parse(), own, null)).toEqual([]);
		expect(checkTemplate(parse({ translationOf: { from: "en_id" } }), own, null)).toEqual([
			"translationOf.locale is not set",
		]);
		expect(
			checkTemplate(parse({ translationOf: { from: "en_id", locale: "FR" } }), own, null),
		).toEqual(['translationOf.locale must differ from locale ("fr")']);
	});

	it("leaves required non-translatable fields to EmDash, and lists them as shared required", () => {
		const t = parse();
		expect(checkTemplate(t, fields, null)).toEqual([]);
		expect(sharedRequiredOf(t, fields)).toEqual(["sku"]);
		// A translatable required field must still be mapped.
		const untitled = parse({ fields: { sku: { from: "SKU", type: "text" } } });
		expect(checkTemplate(untitled, fields, null)).toEqual([
			'Field "title" is required and has no default, but the template does not map it',
		]);
		expect(sharedRequiredOf(untitled, fields)).toEqual([]);
		// Without translationOf nothing changes.
		const plain = parse({ translationOf: undefined, locale: "en" });
		expect(checkTemplate(plain, fields, null)).toEqual([
			'Field "sku" is required and has no default, but the template does not map it',
		]);
		expect(sharedRequiredOf(plain, fields)).toEqual([]);
	});

	it("records translatable: false in the field snapshot only when it is false", () => {
		const t = parse({
			fields: {
				title: { from: "Nom", type: "text" },
				price: { from: "Prix", type: "number" },
			},
		});
		expect(targetFieldsOf(t, fields)).toEqual({
			title: { type: "string", required: true },
			price: { type: "number", required: false, translatable: false },
		});
	});

	it("warns once about the mappings records with a value leave to EmDash", () => {
		const t = parse({
			fields: {
				title: { from: "Nom", type: "text" },
				sku: { from: "SKU", type: "text" },
				price: { from: "Prix", type: "number" },
				related: { from: "Related", type: "reference", match: "key" },
			},
			taxonomies: { category: { from: "Category" } },
		});
		const targets = targetFieldsOf(t, [
			...fields,
			{ slug: "related", type: "reference", storageless: true, targetCollection: "products" },
		]);
		expect(translationWarnings(t, targets)).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price"; reference field "related"; taxonomy "category"',
		]);
		const one = parse({ fields: { price: { from: "Prix", type: "number" } } });
		expect(translationWarnings(one, targetFieldsOf(one, fields))).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: field "price"',
		]);
		const none = parse();
		expect(translationWarnings(none, targetFieldsOf(none, fields))).toEqual([]);
		const plain = parse({
			translationOf: undefined,
			fields: { price: { from: "Prix", type: "number" } },
		});
		expect(translationWarnings(plain, targetFieldsOf(plain, fields))).toEqual([]);
	});

	it("counts as a template with links", () => {
		const t = parse();
		expect(usesLinks(t)).toBe(true);
		expect(usesLinks({ ...t, translationOf: undefined })).toBe(false);
	});
});

describe("translatable in the schema snapshot", () => {
	it("reads Field.translatable, recording only false", async () => {
		const registry = {
			getCollectionWithFields: async () => ({
				fields: [
					{ slug: "title", type: "string" },
					{ slug: "body", type: "text", translatable: true },
					{ slug: "sku", type: "string", translatable: false },
				],
			}),
		} as unknown as SchemaRegistryLike;
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string", required: false, hasDefault: false, validation: {} },
			{ slug: "body", type: "text", required: false, hasDefault: false, validation: {} },
			{
				slug: "sku",
				type: "string",
				required: false,
				hasDefault: false,
				validation: {},
				translatable: false,
			},
		]);
	});
});

describe("resolveTranslationLocale", () => {
	it("needs i18n with at least two locales", () => {
		const refused = { ok: false, message: I18N_REQUIRED_MESSAGE };
		expect(resolveTranslationLocale("en", "fr", null)).toEqual(refused);
		expect(resolveTranslationLocale("en", "fr", { defaultLocale: "en", locales: ["en"] })).toEqual(
			refused,
		);
		expect(I18N_REQUIRED_MESSAGE).toBe("translationOf needs i18n with at least two locales");
	});

	it("resolves a given locale like the job's, and defaults to the site's default locale", () => {
		expect(resolveTranslationLocale("EN", "fr", i18n)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale("de", "fr", i18n)).toEqual({ ok: true, locale: "de" });
		expect(resolveTranslationLocale(undefined, "fr", i18n)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale("es", "fr", i18n)).toEqual({
			ok: false,
			message: 'translationOf.locale: Locale "es" is not configured for this site',
		});
		expect(resolveTranslationLocale(undefined, "en", i18n)).toEqual({
			ok: false,
			message: 'translationOf.locale is required: locale is the default locale ("en")',
		});
	});
});

describe("startJob and createJob with translationOf", () => {
	const csv = "id,en_id,Nom,Prix\nF1,E1,Bureau,10\n";
	const resolveLocale = (locale: string) => resolveSiteLocale(locale, i18n);
	const resolveTranslation = (source: string | undefined, locale: string) =>
		resolveTranslationLocale(source, locale, i18n);
	const lookup = async () => fields;

	it("stores the resolved source locale, the shared required fields and the warning", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const template = raw({
			locale: "FR",
			translationOf: { from: "en_id" },
			fields: { title: { from: "Nom", type: "text" }, price: { from: "Prix", type: "number" } },
		});
		const job = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false },
			lookup,
			resolveLocale,
			resolveTranslation,
		);
		expect(job.template.locale).toBe("fr");
		expect(job.template.translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(job.sharedRequired).toEqual(["sku"]);
		expect(job.targetFields?.price).toEqual({
			type: "number",
			required: false,
			translatable: false,
		});
		expect(job.warnings).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: field "price"',
		]);
		expect(workersBatchCap(job)).toBe(WORKERS_LINKED_BATCH_CAP);
	});

	it("refuses translationOf without i18n, or with a locale the site cannot use", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const input = { uploadId: "u1", template: raw(), dryRun: false };
		await expect(startJob(deps, input, lookup)).rejects.toMatchObject({
			code: "invalid_template",
			details: [I18N_REQUIRED_MESSAGE],
		});
		const own = { ...input, template: raw({ locale: "en", translationOf: { from: "en_id" } }) };
		await expect(
			startJob(deps, own, lookup, resolveLocale, resolveTranslation),
		).rejects.toMatchObject({
			details: ['translationOf.locale is required: locale is the default locale ("en")'],
		});
		const same = { ...input, template: raw({ translationOf: { from: "en_id", locale: "Fr" } }) };
		await expect(
			startJob(deps, same, lookup, resolveLocale, resolveTranslation),
		).rejects.toMatchObject({
			details: ['translationOf.locale must differ from locale ("fr")'],
		});
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("leaves a malformed translationOf to the template schema", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const template = raw({ translationOf: { from: "en_id", locale: 7 } });
		const error = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false },
			lookup,
			resolveLocale,
			resolveTranslation,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JobError);
		expect((error as JobError).details).toEqual([
			"translationOf.locale: Invalid input: expected string, received number",
		]);
	});

	it("stores no shared required fields when every one is mapped or has a default", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "id,en_id,Nom,SKU\nF1,E1,Bureau,S\n");
		const template = raw({
			fields: { title: { from: "Nom", type: "text" }, sku: { from: "SKU", type: "text" } },
		});
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields: fields });
		expect(job.sharedRequired).toBeUndefined();
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/translation-template.test.ts`
Expected: FAIL (1 file, 14 tests failed: the new exports do not exist yet).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/locale.ts`, replace
````ts
	}
}

````
with:
````ts
	}
}

export const I18N_REQUIRED_MESSAGE = "translationOf needs i18n with at least two locales";

/**
 * Resolves a template's `translationOf.locale` against the job's resolved `locale`: refused
 * without i18n with at least two locales (EmDash syncs shared values only then, spec M4e F6, F7;
 * the same test as `isI18nEnabled`, src/i18n/config.ts:81-85), resolved like `locale` when given,
 * and the site's default locale when left out, which must then differ from `locale`. Messages
 * are whole template problems.
 */
export function resolveTranslationLocale(
	sourceLocale: string | undefined,
	locale: string,
	config: I18nConfig | null = getI18nConfig(),
): LocaleResolution {
	if (config === null || config.locales.length < 2) {
		return { ok: false, message: I18N_REQUIRED_MESSAGE };
	}
	if (sourceLocale === undefined) {
		if (config.defaultLocale.toLowerCase() === locale.toLowerCase()) {
			return {
				ok: false,
				message: `translationOf.locale is required: locale is the default locale ("${config.defaultLocale}")`,
			};
		}
		return { ok: true, locale: config.defaultLocale };
	}
	const resolved = resolveSiteLocale(sourceLocale, config);
	return resolved.ok
		? resolved
		: { ok: false, message: `translationOf.locale: ${resolved.message}` };
}

````

In `packages/flux-import/src/emdash/schema.ts`, replace
````ts
		| undefined;
	unsupportedType?: unknown;
}

````
with:
````ts
		| undefined;
	unsupportedType?: unknown;
	/** Absent or true: per locale; false: shared across a translation group. */
	translatable?: boolean;
}

````

then replace
````ts
 * collection does not exist: type, `required`, whether it has a default, the validation keys
 * EmDash enforces, whether EmDash cannot read its type or keeps its values elsewhere (a
 * reference bound to a relation, `isStoragelessField` in src/schema/types.ts:120-125), and a
 * reference field's relation side, target collection and `multiple`.
 */
export async function listSchemaFields(
````
with:
````ts
 * collection does not exist: type, `required`, whether it has a default, the validation keys
 * EmDash enforces, whether EmDash cannot read its type or keeps its values elsewhere (a
 * reference bound to a relation, `isStoragelessField` in src/schema/types.ts:120-125), a
 * reference field's relation side, target collection and `multiple`, and `translatable: false`
 * (src/schema/types.ts:341-342).
 */
export async function listSchemaFields(
````

then replace
````ts
				: {}),
			...(f.type === "reference" ? relationOf(f) : {}),
		};
	});
````
with:
````ts
				: {}),
			...(f.type === "reference" ? relationOf(f) : {}),
			...(f.translatable === false ? { translatable: false as const } : {}),
		};
	});
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	type SchemaField,
	SOURCE_ID_FIELD,
	type Template,
	targetFieldsOf,
````
with:
````ts
	type SchemaField,
	SOURCE_ID_FIELD,
	sharedRequiredOf,
	type Template,
	targetFieldsOf,
````

then replace
````ts
	templatePaths,
	templateSchema,
	unresolvedPaths,
	usesMedia,
````
with:
````ts
	templatePaths,
	templateSchema,
	translationWarnings,
	unresolvedPaths,
	usesMedia,
````

then replace
````ts
				);
	const taxonomyDefs = linkSchema.taxonomies ?? [];
	const warnings = [...(input.warnings ?? []), ...sampled, ...linkWarnings(template, taxonomyDefs)];

	const now = new Date(deps.now()).toISOString();
````
with:
````ts
				);
	const taxonomyDefs = linkSchema.taxonomies ?? [];
	const targetFields = targetFieldsOf(template, input.schemaFields);
	const warnings = [
		...(input.warnings ?? []),
		...sampled,
		...linkWarnings(template, taxonomyDefs),
		...translationWarnings(template, targetFields),
	];
	const sharedRequired = sharedRequiredOf(template, input.schemaFields);

	const now = new Date(deps.now()).toISOString();
````

then replace
````ts
		...(columns === null ? {} : { columns }),
		warnings,
		targetFields: targetFieldsOf(template, input.schemaFields),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		...(template.taxonomies === undefined
````
with:
````ts
		...(columns === null ? {} : { columns }),
		warnings,
		targetFields,
		...(sharedRequired.length > 0 ? { sharedRequired } : {}),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		...(template.taxonomies === undefined
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
		key: valueMapping,
		slug: valueMapping.optional(),
		fields: z.record(z.string(), fieldMapping).superRefine((fields, ctx) => {
			const names = Object.keys(fields);
````
with:
````ts
		key: valueMapping,
		slug: valueMapping.optional(),
		/**
		 * The source key of the entry this record translates, in `locale` (the site's default
		 * locale when left out; job creation always stores it). M4e.
		 */
		translationOf: z
			.object({ ...valueSource, locale: z.string().min(1).optional() })
			.strict()
			.refine(hasOneSource, ONE_SOURCE)
			.optional(),
		fields: z.record(z.string(), fieldMapping).superRefine((fields, ctx) => {
			const names = Object.keys(fields);
````

then replace
````ts
	const froms = [
		t.key.from,
		t.slug?.from,
		...Object.values(t.fields).flatMap((m) =>
````
with:
````ts
	const froms = [
		t.key.from,
		t.translationOf?.from,
		t.slug?.from,
		...Object.values(t.fields).flatMap((m) =>
````

then replace
````ts
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
};

````
with:
````ts
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
	/** EmDash shares the field's value across a translation group (`Field.translatable: false`). */
	translatable?: false;
};

````

then replace
````ts
 * to the collection, more than five image and file mappings, more than three `portableText`
 * mappings, and image or file fields whose `allowedMimeTypes` EmDash's upload can never
 * satisfy. The link checks run only on what `links` carries.
 */
export function checkTemplate(
````
with:
````ts
 * to the collection, more than five image and file mappings, more than three `portableText`
 * mappings, and image or file fields whose `allowedMimeTypes` EmDash's upload can never
 * satisfy. A template that maps `translationOf` needs its source locale set and different from
 * `locale`, and leaves required non-translatable fields to EmDash (`sharedRequiredOf`). The link
 * checks run only on what `links` carries.
 */
export function checkTemplate(
````

then replace
````ts
			!f.hasDefault &&
			!Object.hasOwn(t.fields, f.slug) &&
			f.slug !== SOURCE_ID_FIELD
		) {
			errors.push(
				`Field "${f.slug}" is required and has no default, but the template does not map it`,
			);
		}
	}
````
with:
````ts
			!f.hasDefault &&
			!Object.hasOwn(t.fields, f.slug) &&
			f.slug !== SOURCE_ID_FIELD &&
			// A translation takes the value from its source (spec M4e F1).
			!(t.translationOf !== undefined && f.translatable === false)
		) {
			errors.push(
				`Field "${f.slug}" is required and has no default, but the template does not map it`,
			);
		}
	}
	const source = t.translationOf;
	if (source !== undefined) {
		if (source.locale === undefined) errors.push("translationOf.locale is not set");
		else if (source.locale.toLowerCase() === t.locale.toLowerCase()) {
			errors.push(`translationOf.locale must differ from locale ("${t.locale}")`);
		}
	}
````

then replace
````ts
/**
 * The snapshot of each mapped field stored on the job (`Job.targetFields`): its type, `required`,
 * and the validation keys EmDash enforces. Run `checkTemplate` first; unknown fields are skipped.
 */
export function targetFieldsOf(t: Template, fields: SchemaField[]): Record<string, TargetField> {
````
with:
````ts
/**
 * The snapshot of each mapped field stored on the job (`Job.targetFields`): its type, `required`,
 * the validation keys EmDash enforces, and `translatable: false`. Run `checkTemplate` first;
 * unknown fields are skipped.
 */
export function targetFieldsOf(t: Template, fields: SchemaField[]): Record<string, TargetField> {
````

then replace
````ts
				? { allowedMimeTypes: v.allowedMimeTypes }
				: {}),
		};
	}
````
with:
````ts
				? { allowedMimeTypes: v.allowedMimeTypes }
				: {}),
			...(f.translatable === false ? { translatable: false as const } : {}),
		};
	}
````

then replace
````ts
}

/** Whether the template maps reference fields, taxonomies or bylines. */
export function usesLinks(t: Template): boolean {
	return (
		t.taxonomies !== undefined ||
		t.bylines !== undefined ||
````
with:
````ts
}

/**
 * The required fields EmDash shares across a translation group (`translatable: false`) that have
 * no default and that a template mapping `translationOf` leaves unmapped: a linked record takes
 * them from its source, and a record without a value fails `required` for them
 * (`Job.sharedRequired`). Empty for other templates.
 */
export function sharedRequiredOf(t: Template, fields: readonly SchemaField[]): string[] {
	if (t.translationOf === undefined) return [];
	return fields
		.filter(
			(f) =>
				f.required === true &&
				!f.hasDefault &&
				f.translatable === false &&
				!Object.hasOwn(t.fields, f.slug) &&
				f.slug !== SOURCE_ID_FIELD,
		)
		.map((f) => f.slug);
}

/**
 * Whether a mapping holds a value EmDash shares across a translation group: a field that is not
 * translatable, or any reference field (edges are keyed by translation group, spec M4e F4).
 */
export function isSharedMapping(mapping: FieldMapping, target: TargetField | undefined): boolean {
	return mapping.type === "reference" || target?.translatable === false;
}

/**
 * The job warning for a template that maps `translationOf` and shared mappings (fields that are
 * not translatable, reference fields, taxonomies), which records with a value leave to EmDash.
 */
export function translationWarnings(
	t: Template,
	targets: Readonly<Record<string, TargetField>>,
): string[] {
	if (t.translationOf === undefined) return [];
	const fields: string[] = [];
	const references: string[] = [];
	for (const [field, mapping] of Object.entries(t.fields)) {
		if (mapping.type === "reference") references.push(field);
		else if (isSharedMapping(mapping, targets[field])) fields.push(field);
	}
	const taxonomies = Object.keys(t.taxonomies ?? {});
	const part = (one: string, many: string, names: readonly string[]) =>
		names.length === 0
			? []
			: [`${names.length === 1 ? one : many} ${names.map((n) => `"${n}"`).join(", ")}`];
	const parts = [
		...part("field", "fields", fields),
		...part("reference field", "reference fields", references),
		...part("taxonomy", "taxonomies", taxonomies),
	];
	if (parts.length === 0) return [];
	return [
		`Records with a translationOf value leave these to EmDash, which shares them across the translation group: ${parts.join("; ")}`,
	];
}

/**
 * Whether the template maps reference fields, taxonomies or bylines, or finds a translation
 * source (`translationOf`, M4e): each record then looks entries up.
 */
export function usesLinks(t: Template): boolean {
	return (
		t.translationOf !== undefined ||
		t.taxonomies !== undefined ||
		t.bylines !== undefined ||
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	 */
	sourceIdField?: boolean;
	/** The mapped taxonomies as they were at job creation; absent when none are mapped. */
	taxonomies?: Record<string, TaxonomySnapshot>;
````
with:
````ts
	 */
	sourceIdField?: boolean;
	/**
	 * Required fields shared across a translation group that the template leaves unmapped
	 * (`sharedRequiredOf`): a record without a `translationOf` value fails `required` for each.
	 * Absent when there are none (M4e).
	 */
	sharedRequired?: string[];
	/** The mapped taxonomies as they were at job creation; absent when none are mapped. */
	taxonomies?: Record<string, TaxonomySnapshot>;
````

In `packages/flux-import/src/engine/values.ts`, replace
````ts
	/** Image and file fields: the types the field accepts (EmDash checks them on save). */
	allowedMimeTypes?: string[];
};

````
with:
````ts
	/** Image and file fields: the types the field accepts (EmDash checks them on save). */
	allowedMimeTypes?: string[];
	/** EmDash shares the field's value across a translation group (`translatable: false`, M4e). */
	translatable?: false;
};

````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
````
with:
````ts
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale, resolveTranslationLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
````

then replace
````ts
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
					(locale) => resolveSiteLocale(locale),
				);
			};
````
with:
````ts
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
					(locale) => resolveSiteLocale(locale),
					(sourceLocale, locale) => resolveTranslationLocale(sourceLocale, locale),
				);
			};
````

In `packages/flux-import/src/plugin/service.ts`, replace
````ts
import type { LocaleResolution } from "../emdash/locale.js";
import { type StagedUpload, stageUpload, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
````
with:
````ts
import { I18N_REQUIRED_MESSAGE, type LocaleResolution } from "../emdash/locale.js";
import { type StagedUpload, stageUpload, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
````

then replace
````ts
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;
export type LocaleResolver = (locale: string) => LocaleResolution;

const keepLocale: LocaleResolver = (locale) => ({ ok: true, locale });

function collectionOf(template: unknown): string | null {
````
with:
````ts
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;
export type LocaleResolver = (locale: string) => LocaleResolution;
/** Resolves `translationOf.locale` (absent: the default locale) for a job in `locale`. */
export type TranslationLocaleResolver = (
	sourceLocale: string | undefined,
	locale: string,
) => LocaleResolution;

const keepLocale: LocaleResolver = (locale) => ({ ok: true, locale });
/** Without a site configuration there is no i18n, so `translationOf` is refused. */
const noTranslations: TranslationLocaleResolver = () => ({
	ok: false,
	message: I18N_REQUIRED_MESSAGE,
});

function collectionOf(template: unknown): string | null {
````

then replace
````ts
/**
 * Replaces the template's locale with the site's casing of it, so entries are stored and found
 * under the locale EmDash writes. A template without a string locale is left for createJob to
 * report.
 */
function withSiteLocale(template: unknown, resolveLocale: LocaleResolver): unknown {
	if (
		typeof template !== "object" ||
````
with:
````ts
/**
 * Replaces the template's locale with the site's casing of it, so entries are stored and found
 * under the locale EmDash writes, and sets `translationOf.locale` the same way (the default
 * locale when left out). A template without a string locale, or with a `translationOf` that is
 * not an object or whose locale is not a string, is left for createJob to report.
 */
function withSiteLocale(
	template: unknown,
	resolveLocale: LocaleResolver,
	resolveTranslation: TranslationLocaleResolver,
): unknown {
	if (
		typeof template !== "object" ||
````

then replace
````ts
		]);
	}
	return { ...template, locale: resolved.locale };
}

````
with:
````ts
		]);
	}
	const source = prop(template, "translationOf");
	const sourceLocale = prop(source, "locale");
	if (
		typeof source !== "object" ||
		source === null ||
		(sourceLocale !== undefined && typeof sourceLocale !== "string")
	) {
		return { ...template, locale: resolved.locale };
	}
	const translation = resolveTranslation(sourceLocale, resolved.locale);
	if (!translation.ok) {
		throw new JobError("invalid_template", "The template is invalid", [translation.message]);
	}
	return {
		...template,
		locale: resolved.locale,
		translationOf: { ...source, locale: translation.locale },
	};
}

````

then replace
````ts

/**
 * Creates a job after resolving the template locale and reading the target collection's fields,
 * its reference targets' fields and, for templates that map taxonomies, the taxonomy definitions.
 */
export async function startJob(
````
with:
````ts

/**
 * Creates a job after resolving the template locale (and `translationOf.locale`) and reading the
 * target collection's fields, its reference targets' fields and, for templates that map
 * taxonomies, the taxonomy definitions.
 */
export async function startJob(
````

then replace
````ts
	lookupFields: FieldLookup,
	resolveLocale: LocaleResolver = keepLocale,
): Promise<Job> {
	const template = withSiteLocale(input.template, resolveLocale);
	const collection = collectionOf(template);
	// Without a collection name the template is invalid; createJob reports that with details.
````
with:
````ts
	lookupFields: FieldLookup,
	resolveLocale: LocaleResolver = keepLocale,
	resolveTranslation: TranslationLocaleResolver = noTranslations,
): Promise<Job> {
	const template = withSiteLocale(input.template, resolveLocale, resolveTranslation);
	const collection = collectionOf(template);
	// Without a collection name the template is invalid; createJob reports that with details.
````

In `packages/flux-import/src/plugin/xlsx.ts`, replace
````ts
	sampleSource,
	startJob,
} from "./service.js";

````
with:
````ts
	sampleSource,
	startJob,
	type TranslationLocaleResolver,
} from "./service.js";

````

then replace
````ts
	lookupFields: FieldLookup,
	resolveLocale?: LocaleResolver,
): Promise<Job> {
	const source = xlsxSource(input.template);
	if (source === null) return startJob(deps, input, lookupFields, resolveLocale);
	const converted = await convertXlsx(deps, staging, input.uploadId, source);
	try {
````
with:
````ts
	lookupFields: FieldLookup,
	resolveLocale?: LocaleResolver,
	resolveTranslation?: TranslationLocaleResolver,
): Promise<Job> {
	const source = xlsxSource(input.template);
	if (source === null) {
		return startJob(deps, input, lookupFields, resolveLocale, resolveTranslation);
	}
	const converted = await convertXlsx(deps, staging, input.uploadId, source);
	try {
````

then replace
````ts
			lookupFields,
			resolveLocale,
		);
	} catch (e) {
````
with:
````ts
			lookupFields,
			resolveLocale,
			resolveTranslation,
		);
	} catch (e) {
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/translation-template.test.ts`
Expected: PASS (1 file, 14 tests). Full suite after this task: 53 files / 1,316 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/values.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/emdash/schema.ts packages/flux-import/src/emdash/locale.ts packages/flux-import/src/plugin/service.ts packages/flux-import/src/plugin/xlsx.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/translation-template.test.ts
git commit -m "Accept translationOf in templates, resolve its locale and snapshot translatable fields at job creation"
```

### Task 2: `applyTemplate`: the value and the shared skip

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`
- Test: `packages/flux-import/tests/unit/translation-apply.test.ts`

**Interfaces:**
- Consumes: Task 1's `Template.translationOf`, `isSharedMapping`, `TargetField.translatable`, `SchemaField.translatable`, `targetFieldsOf`; `MAX_KEY_LENGTH`, `scalarText`, `NOT_SCALAR_MESSAGE`, `FAILED`.
- Produces: `MappedRecord.translationOf?: string` (trimmed; absent when blank or not mapped); `CompiledTemplate.translationOf: CompiledExpression | null`, `CompiledTemplate.shared: ReadonlySet<string>` (empty without `translationOf`), `CompiledTemplate.sharedRequired: readonly string[]`; `CompileContext.sharedRequired?: readonly string[]`; `applyTemplate` reads the value after the key, skips `shared` and every taxonomy for a record with a value (Ruling 3), and adds `required` for each of `sharedRequired` to a record without one (Ruling 10).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/translation-apply.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	type SchemaField,
	type Template,
	targetFieldsOf,
	templateSchema,
} from "../../src/engine/template.js";

const fields: SchemaField[] = [
	{ slug: "title", type: "string", required: true },
	{ slug: "sku", type: "string", required: true, translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "photo", type: "image" },
	{ slug: "badge", type: "image", translatable: false },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
];

const template: Template = templateSchema.parse({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Nom", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Prix", type: "number", decimal: "," },
		photo: { from: "Photo", type: "image" },
		badge: { from: "Badge", type: "image" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: { category: { from: "Category" } },
	bylines: { from: "Authors" },
});

function compiled(t: Template = template, sharedRequired: string[] = []): CompiledTemplate {
	const result = compileTemplate(t, { targets: targetFieldsOf(t, fields), sharedRequired });
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

const row = {
	id: "F1",
	en_id: " E1 ",
	handle: "Bureau",
	Nom: "Bureau",
	SKU: "",
	Prix: "abc",
	Photo: "https://example.com/fr.png",
	Badge: "not a url",
	Related: "E2|E3",
	Category: "Office",
	Authors: "alex",
};

describe("applyTemplate with translationOf", () => {
	it("keeps only the fields a translation owns for a record with a value", async () => {
		const c = compiled();
		expect([...c.shared]).toEqual(["sku", "price", "badge", "related"]);
		// The empty required sku, the bad price and the bad badge URL are never read.
		expect(await applyTemplate(c, row)).toEqual({
			ok: true,
			value: {
				key: "F1",
				translationOf: "E1",
				slug: "bureau",
				data: { title: "Bureau" },
				links: { bylines: ["alex"] },
				media: {
					photo: { kind: "image", url: "https://example.com/fr.png", alt: null, refresh: false },
				},
			},
		});
	});

	it("reads every mapping for a record without a value", async () => {
		for (const blank of ["", "   ", undefined, null]) {
			const result = await applyTemplate(compiled(), {
				...row,
				en_id: blank,
				SKU: "S1",
				Prix: "12,5",
				Badge: "https://example.com/badge.png",
			});
			expect(result).toEqual({
				ok: true,
				value: {
					key: "F1",
					slug: "bureau",
					data: { title: "Bureau", sku: "S1", price: 12.5 },
					links: {
						references: { related: ["E2", "E3"] },
						taxonomies: { category: [{ path: ["Office"] }] },
						bylines: ["alex"],
					},
					media: {
						photo: { kind: "image", url: "https://example.com/fr.png", alt: null, refresh: false },
						badge: {
							kind: "image",
							url: "https://example.com/badge.png",
							alt: null,
							refresh: false,
						},
					},
				},
			});
		}
	});

	it("fails required for the shared required fields only without a value", async () => {
		const t = templateSchema.parse({
			...template,
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const c = compiled(t, ["sku"]);
		expect(await applyTemplate(c, row)).toMatchObject({ ok: true, value: { translationOf: "E1" } });
		expect(await applyTemplate(c, { ...row, en_id: "" })).toEqual({
			ok: false,
			errors: [{ field: "sku", code: "required", message: "The field is required" }],
		});
	});

	it("reads the value with the key's rules", async () => {
		const c = compiled();
		const value = (en_id: unknown) => applyTemplate(c, { ...row, en_id });
		expect(await value(12)).toMatchObject({ ok: true, value: { translationOf: "12" } });
		expect(await value({ id: "E1" })).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "not_scalar",
					message: expect.stringContaining("object or array"),
				},
			],
		});
		expect(await value("x".repeat(257))).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "key_too_long",
					message: "Keys are limited to 256 characters",
				},
			],
		});
		expect(await value(` ${"x".repeat(256)} `)).toMatchObject({
			ok: true,
			value: { translationOf: "x".repeat(256) },
		});
	});

	it("reads an expression, and a failing one skips the shared mappings", async () => {
		const t = templateSchema.parse({
			...template,
			translationOf: { expr: '$exists(en_id) ? "EN-" & $trim(en_id) : ""', locale: "en" },
		});
		expect(await applyTemplate(compiled(t), row)).toMatchObject({
			ok: true,
			value: { translationOf: "EN-E1" },
		});
		const broken = templateSchema.parse({
			...template,
			translationOf: { expr: "en_id + 1", locale: "en" },
		});
		expect(await applyTemplate(compiled(broken), row)).toEqual({
			ok: false,
			errors: [
				{
					field: "translationOf",
					code: "expr_error",
					message: expect.stringMatching(/^JSONata T2001 /),
				},
			],
		});
	});

	it("reports a bad translationOf expression at compile time", () => {
		const t = templateSchema.parse({ ...template, translationOf: { expr: "(", locale: "en" } });
		const result = compileTemplate(t);
		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.problems).toEqual([
			expect.stringMatching(/^translationOf\.expr: JSONata S0\d+ at character \d+: /),
		]);
	});

	it("shares nothing without translationOf", () => {
		const t = templateSchema.parse({ ...template, locale: "en", translationOf: undefined });
		expect([...compiled(t).shared]).toEqual([]);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/translation-apply.test.ts`
Expected: FAIL (6 failed, 1 passed: "reads every mapping for a record without a value" already holds).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/template.ts`, replace
````ts
 * when it maps image or file fields (null for an empty value), and the Portable Text drafts when
 * it maps `portableText` fields (null for an empty value). Reference, media and Portable Text
 * fields are kept out of `data`.
 */
export type MappedRecord = {
	key: string;
	slug?: string;
	data: Record<string, FieldValue>;
````
with:
````ts
 * when it maps image or file fields (null for an empty value), and the Portable Text drafts when
 * it maps `portableText` fields (null for an empty value). Reference, media and Portable Text
 * fields are kept out of `data`. `translationOf` is the trimmed source key of the entry the
 * record translates (M4e), absent when the template maps none or the value is blank.
 */
export type MappedRecord = {
	key: string;
	translationOf?: string;
	slug?: string;
	data: Record<string, FieldValue>;
````

then replace
````ts
	/** The slug's `expr`, or null when there is no slug or it reads `from`. */
	readonly slug: CompiledExpression | null;
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
````
with:
````ts
	/** The slug's `expr`, or null when there is no slug or it reads `from`. */
	readonly slug: CompiledExpression | null;
	/** The `translationOf` `expr`, or null when there is none or it reads `from`. */
	readonly translationOf: CompiledExpression | null;
	/**
	 * The fields a record with a `translationOf` value does not read (`isSharedMapping`): EmDash
	 * shares their values across the translation group. Empty without `translationOf`.
	 */
	readonly shared: ReadonlySet<string>;
	/** `Job.sharedRequired`: fields a record without a `translationOf` value fails `required` for. */
	readonly sharedRequired: readonly string[];
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
````

then replace
````ts
	/** The mapped taxonomies as they were at job creation (M4b); flat when absent. */
	taxonomies?: Readonly<Record<string, TaxonomySnapshot>> | undefined;
}

````
with:
````ts
	/** The mapped taxonomies as they were at job creation (M4b); flat when absent. */
	taxonomies?: Readonly<Record<string, TaxonomySnapshot>> | undefined;
	/** `Job.sharedRequired` (M4e); none when absent. */
	sharedRequired?: readonly string[] | undefined;
}

````

then replace
````ts
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
````
with:
````ts
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const translationOf = compile("translationOf.expr", t.translationOf?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
````

then replace
````ts
		if (mapping.type === "portableText") portableText.set(name, portableTextOptions(mapping));
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
````
with:
````ts
		if (mapping.type === "portableText") portableText.set(name, portableTextOptions(mapping));
	}
	const shared = new Set(
		t.translationOf === undefined
			? []
			: Object.keys(t.fields).filter((name) =>
					isSharedMapping(t.fields[name] as FieldMapping, targets?.[name]),
				),
	);
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
````

then replace
````ts
			key,
			slug,
			fields,
			converters,
````
with:
````ts
			key,
			slug,
			translationOf,
			shared,
			sharedRequired: context.sharedRequired ?? [],
			fields,
			converters,
````

then replace
````ts
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests, and Portable Text into `portableText`, as drafts. `warnings` is
 * present when a Portable Text conversion reported something, also for a record that fails. Run
 * `filterRecord` first.
 */
````
with:
````ts
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests, and Portable Text into `portableText`, as drafts. `warnings` is
 * present when a Portable Text conversion reported something, also for a record that fails.
 * After the key it reads `translationOf` (M4e): a record with a value does not read the shared
 * mappings (`CompiledTemplate.shared`, every taxonomy), so they can neither fail it nor be
 * written; a record without one fails `required` for each of `sharedRequired`. Run
 * `filterRecord` first.
 */
````

then replace
````ts
	}

	let slug: string | undefined;
	if (t.slug) {
````
with:
````ts
	}

	let translationOf: string | undefined;
	// A value that cannot be read still names a source: the record fails, without reading the
	// shared mappings.
	let linked = false;
	if (t.translationOf) {
		const field = "translationOf";
		const sourceRaw = await read(field, t.translationOf.from, c.translationOf);
		linked = sourceRaw === FAILED;
		if (sourceRaw !== FAILED) {
			const sourceText = scalarText(sourceRaw);
			const sourceKey = sourceText?.trim() ?? "";
			if (sourceText === null) {
				linked = true;
				errors.push({ field, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
			} else if (sourceKey !== "") {
				linked = true;
				if (sourceKey.length > MAX_KEY_LENGTH) {
					const message = `Keys are limited to ${MAX_KEY_LENGTH} characters`;
					errors.push({ field, code: "key_too_long", message });
				} else translationOf = sourceKey;
			}
		}
	}

	let slug: string | undefined;
	if (t.slug) {
````

then replace
````ts
	const sources: PortableTextSource[] = [];
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
````
with:
````ts
	const sources: PortableTextSource[] = [];
	for (const [field, mapping] of Object.entries(t.fields)) {
		if (linked && c.shared.has(field)) continue;
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
````

then replace
````ts
	}
	if (sources.length > 0) convertSources(sources, portableText, errors, warnings);
	for (const [name, reader] of c.taxonomies) {
		const field = `taxonomies.${name}`;
		const raw = await read(field, reader.from, reader.expr);
````
with:
````ts
	}
	if (sources.length > 0) convertSources(sources, portableText, errors, warnings);
	// Assignments are keyed by translation group: a translation shares its source's terms.
	for (const [name, reader] of linked ? [] : c.taxonomies) {
		const field = `taxonomies.${name}`;
		const raw = await read(field, reader.from, reader.expr);
````

then replace
````ts

	if (c.portableText.size > 0) limitPortableText(c, portableText, errors, warnings);

	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
````
with:
````ts

	if (c.portableText.size > 0) limitPortableText(c, portableText, errors, warnings);
	if (!linked) {
		for (const field of c.sharedRequired) {
			errors.push({ field, code: "required", message: "The field is required" });
		}
	}

	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (translationOf !== undefined) mapped.translationOf = translationOf;
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/translation-apply.test.ts`
Expected: PASS (1 file, 7 tests). Full suite after this task: 54 files / 1,323 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/tests/unit/translation-apply.test.ts
git commit -m "Read translationOf after the key and leave shared mappings unread for records that name a source"
```

### Task 3: Ports, adapter and fakes

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/emdash/content.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/content.test.ts`, `packages/flux-import/tests/unit/fakes.test.ts`

**Interfaces:**
- Consumes: `ContentPort`, `ContentRuntime`, `EmDashContent`, `writeError`, `parse`; EmDash `handleContentCreate` body `translationOf` (`src/emdash-runtime.ts:3455-3471`) and `handleContentTranslations` (`:4776-4777`, Fact E3).
- Produces: `ContentPort.create` input `translationOf?: string`; `ContentPort.translations(collection, id): Promise<{ id: string; locale: string }[]>` (`NOT_FOUND` is `[]`, a row without a locale is left out, other errors `ContentWriteError` `emdash_<code>`, a malformed answer `emdash_bad_response`); `ContentRuntime.handleContentCreate` body `translationOf?: string`, `ContentRuntime.handleContentTranslations(collection, id)`; `FakeContent.sharedFields: Set<string>` and the emulation of Ruling 11.

- [ ] **Step 1: Write the failing tests and the fakes**

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;
````
with:
````ts
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	/** What handleContentTranslations answers. */
	translationsResult: HandlerResult = fail("NOT_FOUND", "Content item not found");
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;
````

then replace
````ts
		item.version++;
		return this.envelope(item);
	}
}
````
with:
````ts
		item.version++;
		return this.envelope(item);
	}
	async handleContentTranslations(collection: string, id: string) {
		this.calls.push(["translations", collection, id]);
		return this.translationsResult;
	}
}
````

then replace
````ts
		]);
	});
});

````
with:
````ts
		]);
	});
});

describe("EmDashContent translations (M4e)", () => {
	it("sends translationOf on create", async () => {
		const { runtime, content } = setup();
		await content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau", flux_source_id: "E1" },
			translationOf: "e0",
			bylines: [],
		});
		expect(runtime.calls[0]).toEqual([
			"create",
			"products",
			{
				data: { title: "Bureau", flux_source_id: "E1" },
				locale: "fr",
				authorId: "u1",
				actor,
				translationOf: "e0",
				bylines: [],
			},
		]);
	});

	it("lists the group's entries and locales, and nothing for a missing entry", async () => {
		const { runtime, content } = setup();
		expect(await content.translations("products", "nope")).toEqual([]);
		runtime.translationsResult = ok({
			translationGroup: "e1",
			translations: [
				{ id: "e1", locale: "en", slug: "desk", status: "published", updatedAt: "t" },
				{ id: "e2", locale: "fr", slug: "bureau", status: "draft", updatedAt: "t" },
				{ id: "e3", locale: null, slug: null, status: "draft", updatedAt: "t" },
			],
		});
		expect(await content.translations("products", "e2")).toEqual([
			{ id: "e1", locale: "en" },
			{ id: "e2", locale: "fr" },
		]);
		expect(runtime.calls.at(-1)).toEqual(["translations", "products", "e2"]);
	});

	it("reports other translation read errors and bad responses as ContentWriteError", async () => {
		const { runtime, content } = setup();
		runtime.translationsResult = fail("INTERNAL_ERROR", "boom");
		const failed = await content.translations("products", "e1").catch((e: unknown) => e);
		expect(failed).toBeInstanceOf(ContentWriteError);
		expect(failed).toMatchObject({
			code: "emdash_internal_error",
			message: "Reading the translations failed: boom",
		});
		runtime.translationsResult = ok({ translations: [{ locale: "en" }] });
		await expect(content.translations("products", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});

````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
import { describe, expect, it } from "vitest";
import { MemoryKv } from "./fakes.js";

describe("MemoryKv", () => {
````
with:
````ts
import { describe, expect, it } from "vitest";
import { FakeContent, MemoryKv } from "./fakes.js";

describe("MemoryKv", () => {
````

then replace
````ts
	});
});

````
with:
````ts
	});
});

describe("FakeContent translations", () => {
	it("joins the source's group with its shared values and credits, as EmDash", async () => {
		const content = new FakeContent();
		content.sharedFields.add("price");
		const source = await content.create({
			collection: "products",
			locale: "en",
			data: { title: "Desk", price: 10, flux_source_id: "E1" },
			taxonomies: { tag: ["new"] },
			bylines: [{ bylineId: "b1", roleLabel: null }],
		});
		const fr = await content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau", price: 99, flux_source_id: "F1" },
			translationOf: source.id,
		});
		const de = await content.create({
			collection: "products",
			locale: "de",
			data: { title: "Tisch" },
			translationOf: fr.id,
			bylines: [],
		});
		expect(await content.get("products", "fr", fr.id)).toMatchObject({
			group: source.id,
			data: { title: "Bureau", price: 10, flux_source_id: "E1" },
			bylines: [{ id: "b1" }],
		});
		expect(await content.get("products", "de", de.id)).toMatchObject({
			group: source.id,
			data: { title: "Tisch", price: 10, flux_source_id: "E1" },
			bylines: [],
		});
		expect(content.entries.get(fr.id)?.taxonomies).toEqual({ tag: ["new"] });
		expect(await content.translations("products", de.id)).toEqual([
			{ id: source.id, locale: "en" },
			{ id: fr.id, locale: "fr" },
			{ id: de.id, locale: "de" },
		]);
		expect(await content.translations("products", "nope")).toEqual([]);
	});

	it("refuses a missing source and a locale the group already has", async () => {
		const content = new FakeContent();
		const source = await content.create({ collection: "products", locale: "en", data: {} });
		const create = (translationOf: string) =>
			content.create({ collection: "products", locale: "en", data: {}, translationOf });
		await expect(create("nope")).rejects.toMatchObject({ code: "emdash_not_found" });
		await expect(create(source.id)).rejects.toMatchObject({ code: "emdash_conflict" });
	});
});

````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	slug: string | null;
	data: Record<string, unknown>;
	rev: number;
	pendingPublish: boolean;
````
with:
````ts
	slug: string | null;
	data: Record<string, unknown>;
	/** The translation group: the entry's own ID, or its source's group (EmDash, spec M4e F3). */
	group: string;
	rev: number;
	pendingPublish: boolean;
````

then replace
````ts
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	private next = 0;

````
with:
````ts
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	/**
	 * The non-translatable fields: a create with `translationOf` takes their values from the
	 * source, as EmDash does (spec M4e F1).
	 */
	readonly sharedFields = new Set<string>(["flux_source_id"]);
	private next = 0;

````

then replace
````ts
			slug: e.slug,
			data: structuredClone(e.data),
			group: e.id,
			pendingPublish: e.pendingPublish,
			...(options.references
````
with:
````ts
			slug: e.slug,
			data: structuredClone(e.data),
			group: e.group,
			pendingPublish: e.pendingPublish,
			...(options.references
````

then replace
````ts
			slug?: string;
			data: Record<string, unknown>;
		} & LinkWrites,
	) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const id = `e${++this.next}`;
		const entry: StoredEntry = {
			id,
````
with:
````ts
			slug?: string;
			data: Record<string, unknown>;
			translationOf?: string;
		} & LinkWrites,
	) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const source =
			input.translationOf === undefined ? undefined : this.entries.get(input.translationOf);
		if (input.translationOf !== undefined) {
			if (!source || source.collection !== input.collection) {
				throw new ContentWriteError(
					"emdash_not_found",
					"Creating the entry failed: Translation source content not found",
				);
			}
			const taken = [...this.entries.values()].some(
				(e) => e.group === source.group && e.locale === input.locale,
			);
			if (taken) {
				throw new ContentWriteError(
					"emdash_conflict",
					`Creating the entry failed: Translation already exists in locale "${input.locale}" for this content item`,
				);
			}
		}
		const id = `e${++this.next}`;
		const data = structuredClone(input.data);
		for (const field of source ? this.sharedFields : []) {
			if (source && Object.hasOwn(source.data, field)) data[field] = source.data[field];
			else delete data[field];
		}
		const entry: StoredEntry = {
			id,
````

then replace
````ts
			locale: input.locale,
			slug: input.slug ?? null,
			data: structuredClone(input.data),
			rev: 1,
			pendingPublish: true,
			taxonomies: {},
			references: {},
			bylines: [],
		};
		this.writeLinks(entry, input);
````
with:
````ts
			locale: input.locale,
			slug: input.slug ?? null,
			data,
			group: source?.group ?? id,
			rev: 1,
			pendingPublish: true,
			// As EmDash: terms and references are the group's; credits are copied unless given.
			taxonomies: structuredClone(source?.taxonomies ?? {}),
			references: structuredClone(source?.references ?? {}),
			bylines: input.bylines === undefined ? structuredClone(source?.bylines ?? []) : [],
		};
		this.writeLinks(entry, input);
````

then replace
````ts
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
	}
}
````
with:
````ts
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
	}
	async translations(collection: string, id: string) {
		this.calls.push(`translations:${id}`);
		const e = this.entries.get(id);
		if (!e || e.collection !== collection) return [];
		return [...this.entries.values()]
			.filter((t) => t.collection === collection && t.group === e.group)
			.map((t) => ({ id: t.id, locale: t.locale }));
	}
}
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/content.test.ts tests/unit/fakes.test.ts`
Expected: FAIL (2 files, 3 failed in `content.test.ts`, 21 passed; the fakes tests pass with the fakes of Step 1).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :759 (schemaRegistry).
 */
export interface ContentRuntime {
````
with:
````ts
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :4776 (translations), :759 (schemaRegistry).
 */
export interface ContentRuntime {
````

then replace
````ts
			locale?: string;
			authorId?: string;
			actor?: ActorInfo;
		} & LinkWrites,
````
with:
````ts
			locale?: string;
			authorId?: string;
			translationOf?: string;
			actor?: ActorInfo;
		} & LinkWrites,
````

then replace
````ts
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
}

````
with:
````ts
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentTranslations(collection: string, id: string): Promise<HandlerResult>;
}

````

then replace
````ts
/** `{ items, nextCursor? }` from list (src/api/types.ts:10). */
const listResult = z.object({ items: z.array(z.object({ id: z.string() })) });

function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
````
with:
````ts
/** `{ items, nextCursor? }` from list (src/api/types.ts:10). */
const listResult = z.object({ items: z.array(z.object({ id: z.string() })) });

/** `{ translationGroup, translations }` from translations (src/api/handlers/content.ts:2777-2840). */
const translationsResult = z.object({
	translations: z.array(z.object({ id: z.string(), locale: z.string().nullable() })),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
````

then replace
````ts
			slug?: string;
			data: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }> {
````
with:
````ts
			slug?: string;
			data: Record<string, FieldValue>;
			translationOf?: string;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }> {
````

then replace
````ts
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...linksOf(input),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
````
with:
````ts
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...(input.translationOf === undefined ? {} : { translationOf: input.translationOf }),
			...linksOf(input),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
````

then replace
````ts
	}

	async update(
		input: {
````
with:
````ts
	}

	/** Rows without a locale (never written by EmDash with i18n) are left out. */
	async translations(collection: string, id: string): Promise<{ id: string; locale: string }[]> {
		const result = await this.runtime.handleContentTranslations(collection, id);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return [];
			throw writeError("Reading the translations", result.error);
		}
		const { translations } = parse(translationsResult, result.data, "Reading the translations");
		return translations.flatMap((t) => (t.locale === null ? [] : [{ id: t.id, locale: t.locale }]));
	}

	async update(
		input: {
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	create(
		input: {
````
with:
````ts
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	/**
	 * `translationOf`: the ID of an entry of the same collection; the new entry joins its
	 * translation group, and EmDash replaces every non-translatable field in `data` with the
	 * source's value and copies its byline credits when `bylines` is not given (spec M4e F1, F5).
	 * A source that does not exist is `emdash_not_found`; a group that already has an entry in the
	 * locale is `emdash_conflict`.
	 */
	create(
		input: {
````

then replace
````ts
			slug?: string;
			data: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }>;
	/**
	 * On revisioned collections `data`, `slug` and `references` are staged as a draft, which
````
with:
````ts
			slug?: string;
			data: Record<string, FieldValue>;
			translationOf?: string;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }>;
	/**
	 * The active entries of the entry's translation group, the entry included (EmDash
	 * `handleContentTranslations`); empty when the entry does not exist.
	 */
	translations(collection: string, id: string): Promise<{ id: string; locale: string }[]>;
	/**
	 * On revisioned collections `data`, `slug` and `references` are staged as a draft, which
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/content.test.ts tests/unit/fakes.test.ts`
Expected: PASS (2 files, 24 tests). Full suite after this task: 54 files / 1,328 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/content.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/content.test.ts packages/flux-import/tests/unit/fakes.test.ts
git commit -m "Create entries as translations and read translation groups through the content port"
```

### Task 4: Source lookup

**Files:**
- Modify: `packages/flux-import/src/engine/resolve.ts`
- Test: `packages/flux-import/tests/unit/translation-source.test.ts`

**Interfaces:**
- Consumes: `findReference`, `referenceKey`, `NOT_FOUND_BY`, `LookupCache.entries`, `COST_CALL`, `COST_READ`, `linkKey`.
- Produces: `findTranslationSource(deps, cache, collection, locale, key, sourceIdReady): Promise<{ id: string; group: string } | null>` (Ruling 5; throws `ContentWriteError`); `sourceNotFoundMessage(collection, locale, key): string`; the reference cache key includes the locale.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/translation-source.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { ContentWriteError } from "../../src/engine/ports.js";
import {
	COST_CALL,
	COST_READ,
	findTranslationSource,
	LookupCache,
	sourceNotFoundMessage,
} from "../../src/engine/resolve.js";
import { linkKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

async function setup() {
	const { deps } = makeDeps();
	const desk = await deps.content.create({
		collection: "products",
		locale: "en",
		data: { title: "Desk", flux_source_id: "E1" },
	});
	const fr = await deps.content.create({
		collection: "products",
		locale: "fr",
		data: { title: "Bureau", flux_source_id: "E1" },
	});
	return { deps, desk, fr };
}

const find = (
	deps: ReturnType<typeof makeDeps>["deps"],
	cache: LookupCache,
	key: string,
	locale = "en",
	sourceIdReady = true,
) => findTranslationSource(deps, cache, "products", locale, key, sourceIdReady);

describe("findTranslationSource", () => {
	it("finds the source by the source locale's link row, verified, and caches the hit", async () => {
		const { deps, desk } = await setup();
		await deps.links.put(linkKey("products", "en", "E1"), {
			collection: "products",
			locale: "en",
			sourceKey: "E1",
			entryId: desk.id,
		});
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + COST_READ);
		expect(deps.content.calls).not.toContain("find:E1");
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + COST_READ);
	});

	it("falls back to flux_source_id in the source locale, past a stale link row", async () => {
		const { deps, desk } = await setup();
		await deps.links.put(linkKey("products", "en", "E1"), {
			collection: "products",
			locale: "en",
			sourceKey: "E1",
			entryId: "gone",
		});
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + 2 * COST_READ);
		expect(deps.content.calls).toContain("find:E1");
	});

	it("names one locale: an entry of another locale with the same source ID is not it", async () => {
		const { deps, desk, fr } = await setup();
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1", "de")).toBeNull();
		expect(await find(deps, cache, "E1", "fr")).toEqual({ id: fr.id, group: fr.id });
		expect(await find(deps, cache, "E1", "en")).toEqual({ id: desk.id, group: desk.id });
	});

	it("does not cache a miss, and reads link rows only before the source ID field exists", async () => {
		const { deps } = await setup();
		const cache = new LookupCache();
		expect(await find(deps, cache, "E9")).toBeNull();
		expect(await find(deps, cache, "E9")).toBeNull();
		expect(deps.content.calls.filter((c) => c === "find:E9")).toHaveLength(2);
		expect(await find(deps, cache, "E1", "en", false)).toBeNull();
		expect(deps.content.calls).not.toContain("find:E1");
	});

	it("throws an ambiguous source ID for the record to report", async () => {
		const { deps } = await setup();
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		await expect(find(deps, new LookupCache(), "E1")).rejects.toMatchObject({
			code: "ambiguous_source_id",
		});
	});

	it("words a missing source like a missing key reference", () => {
		expect(sourceNotFoundMessage("products", "en", "E9")).toBe(
			'No entry in "products" (en) was imported with the key "E9"',
		);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/translation-source.test.ts`
Expected: FAIL (1 file, 6 tests failed: `findTranslationSource` does not exist yet).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/resolve.ts`, replace
````ts
}

const referenceKey = (target: string, match: string, value: string) =>
	`${target}\u0000${match}\u0000${value}`;

/** One reference item: the hit from the batch cache, or a lookup; null when nothing matches. */
````
with:
````ts
}

const referenceKey = (target: string, match: string, value: string, locale: string) =>
	`${target}\u0000${match}\u0000${locale}\u0000${value}`;

/** One reference item: the hit from the batch cache, or a lookup; null when nothing matches. */
````

then replace
````ts
	sourceIdReady: boolean,
): Promise<{ id: string; group: string } | null> {
	const key = referenceKey(target, match, value);
	const hit = cache.entries.get(key);
	if (hit) return hit;
````
with:
````ts
	sourceIdReady: boolean,
): Promise<{ id: string; group: string } | null> {
	// The locale is part of the key: a translation source is looked up in another locale (M4e).
	const key = referenceKey(target, match, value, locale);
	const hit = cache.entries.get(key);
	if (hit) return hit;
````

then replace
````ts
}

const NOT_FOUND_BY = {
	id: (target: string, value: string) => `No entry in "${target}" has the ID "${value}"`,
````
with:
````ts
}

/**
 * The entry a record translates (M4e): the entry imported with `key` into `collection` in the
 * source `locale`, found as a `match: "key"` reference is (the link row, verified, then the
 * source ID when `sourceIdReady`), with its translation group; null when there is none. Hits
 * are cached for the batch, misses are not. Throws `ContentWriteError` for an ambiguous source
 * ID or an EmDash read error.
 */
export function findTranslationSource(
	deps: ResolveDeps,
	cache: LookupCache,
	collection: string,
	locale: string,
	key: string,
	sourceIdReady: boolean,
): Promise<{ id: string; group: string } | null> {
	return findReference(deps, cache, collection, "key", key, locale, sourceIdReady);
}

const NOT_FOUND_BY = {
	id: (target: string, value: string) => `No entry in "${target}" has the ID "${value}"`,
````

then replace
````ts
};

async function resolveReferences(
	deps: ResolveDeps,
````
with:
````ts
};

/** The message for a source key that no entry was imported with. */
export function sourceNotFoundMessage(collection: string, locale: string, key: string): string {
	return NOT_FOUND_BY.key(collection, key, locale);
}

async function resolveReferences(
	deps: ResolveDeps,
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/translation-source.test.ts`
Expected: PASS (1 file, 6 tests). Full suite after this task: 55 files / 1,334 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/resolve.ts packages/flux-import/tests/unit/translation-source.test.ts
git commit -m "Find a translation's source by its key in the source locale, cached per batch"
```

### Task 5: Decisions and writes

**Files:**
- Modify: `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/translation-import.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Job.sharedRequired`, `Template.translationOf`, `usesLinks`), Task 2 (`MappedRecord.translationOf`, `CompileContext.sharedRequired`), Task 3 (`ContentPort.create` with `translationOf`, `ContentPort.translations`, `FakeContent.sharedFields` and its emulation), Task 4 (`findTranslationSource`, `sourceNotFoundMessage`); `decideRecord`, `writeRecord`, `createLinks`, `sourceIdReady`, `JOB_LEVEL_WRITE_ERRORS`, `planRecord`, `COST_RECORD`, `COST_READ`.
- Produces: in `src/engine/batch.ts`: `RecordCtx.translationOf?: string`; `checkTranslation` (the decision table), `translationIn`, `translationExists`, `withChange` (Ruling 7), `translationLinks` (Ruling 8), `createTranslation` (Ruling 9); crash repair by the value with Ruling 4's guard; the costs of Ruling 6; `sharedRequired` passed to `compileTemplate`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/translation-import.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import { type Job, linkKey, type RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "sku", type: "string", translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "badge", type: "image", translatable: false },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
	{ slug: "flux_source_id", type: "string", translatable: false },
];

const english = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "id" },
	fields: {
		title: { from: "Name", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Price", type: "number" },
	},
};

const french = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Nom", type: "text" },
		sku: { from: "SKU", type: "text" },
		price: { from: "Prix", type: "number" },
		badge: { from: "Badge", type: "image" },
		related: { from: "Related", type: "reference", match: "key" },
	},
	taxonomies: { tag: { from: "Tags" } },
	bylines: { from: "Authors" },
	...extra,
});

const EN_CSV = "id,Name,SKU,Price\nE1,Desk,S1,10\nE2,Lamp,S2,20\n";
const FR_HEADER = "id,en_id,handle,Nom,SKU,Prix,Badge,Related,Tags,Authors\n";
const frRow = (id: string, enId: string, name: string, extra = ",,,https://x.test/b.png,E2,new,") =>
	`${id},${enId},${name.toLowerCase()},${name}${extra}\n`;

function setup() {
	const { deps, clock } = makeDeps();
	deps.content.sharedFields.add("sku").add("price").add("badge");
	deps.lookups.defs.push({
		name: "tag",
		hierarchical: false,
		collections: ["products"],
		locale: "en",
	});
	deps.lookups.addTerm("tag", "new", "New", undefined, "fr");
	deps.lookups.addByline("alex", "Alex", "fr");
	return { deps, clock };
}

async function start(
	deps: Deps,
	template: unknown,
	csv: string,
	opts: { dryRun?: boolean; fields?: SchemaField[] } = {},
): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const fields = opts.fields ?? schemaFields;
	return createJob(deps, {
		uploadId: upload,
		template,
		schemaFields: fields,
		linkSchema: { targets: { products: fields }, taxonomies: deps.lookups.defs },
		...(opts.dryRun ? { dryRun: true } : {}),
	});
}

async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 100; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

async function run(deps: Deps, template: unknown, csv: string, opts = {}) {
	const job = await start(deps, template, csv, opts);
	const done = await runToEnd(deps, job.id);
	return { job: done, rows: await rows(deps, job.id) };
}

/** The English entries by key, after an English job. */
async function importEnglish(deps: Deps, csv = EN_CSV) {
	await run(deps, english, csv);
	const byKey = new Map(
		[...deps.content.entries.values()]
			.filter((e) => e.locale === "en")
			.map((e) => [e.data.flux_source_id as string, e]),
	);
	return byKey;
}

/** Records each create's input. */
function recordCreates(deps: Deps) {
	const creates: Record<string, unknown>[] = [];
	const create = deps.content.create.bind(deps.content);
	deps.content.create = async (input) => {
		creates.push(structuredClone(input));
		return create(input);
	};
	return creates;
}

const frEntry = (deps: Deps, slug: string) =>
	[...deps.content.entries.values()].find((e) => e.locale === "fr" && e.slug === slug);

describe("importing translations", () => {
	it("creates translations in their sources' groups, leaves shared values to EmDash, and re-runs unchanged", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const creates = recordCreates(deps);
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau", ",,abc,not a url,E9,missing,");
		const first = await run(deps, french(), csv);
		expect(first.job.warnings).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price", "badge"; reference field "related"; taxonomy "tag"',
		]);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 0 });
		const desk = en.get("E1")!;
		const [row] = first.rows;
		expect(row).toMatchObject({
			status: "created",
			sourceKey: "F1",
			changes: [
				{ field: "slug", before: null, after: "bureau" },
				{ field: "title", before: null, after: "Bureau" },
				{ field: "translationOf", before: null, after: "en: E1" },
			],
		});
		expect(creates).toEqual([
			{
				collection: "products",
				locale: "fr",
				slug: "bureau",
				data: { title: "Bureau", flux_source_id: "E1" },
				translationOf: desk.id,
				bylines: [],
			},
		]);
		const bureau = frEntry(deps, "bureau")!;
		expect(bureau).toMatchObject({
			group: desk.id,
			data: { title: "Bureau", sku: "S1", price: 10, flux_source_id: "E1" },
		});
		expect(deps.mediaFetcher.calls).toEqual([]);
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: bureau.id,
		});

		const again = await run(deps, french(), csv);
		expect(again.job.counters).toMatchObject({ unchanged: 1 });
		expect(again.rows[0]).toMatchObject({ status: "unchanged", entryId: bureau.id });
	});

	it("credits the bylines a mapped value names, and none for an empty one", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const creates = recordCreates(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau", ",,,,,,alex"));
		const alex = deps.lookups.storedBylines.find((b) => b.slug === "alex")!;
		expect(creates[0]).toMatchObject({
			translationOf: en.get("E1")!.id,
			bylines: [{ bylineId: alex.id, roleLabel: null }],
		});
		const withoutBylines = french();
		delete (withoutBylines as Record<string, unknown>).bylines;
		const second = recordCreates(deps);
		await run(deps, withoutBylines, FR_HEADER + frRow("F2", "E2", "Lampe"));
		expect(second[0]).toMatchObject({ translationOf: en.get("E2")!.id });
		expect(second[0]).not.toHaveProperty("bylines");
	});

	it("fails a record whose source does not exist, and creates it on retry after the source job", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F3", "E3", "Chaise");
		const first = await run(deps, french(), csv);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(first.rows[1]).toMatchObject({
			status: "failed",
			sourceKey: "F3",
			errors: [
				{
					field: "translationOf",
					code: "translation_source_not_found",
					message: 'No entry in "products" (en) was imported with the key "E3"',
				},
			],
		});
		await importEnglish(deps, `${EN_CSV}E3,Chair,S3,30\n`);
		await transitionJob(deps, first.job.id, "retry");
		const retried = await runToEnd(deps, first.job.id);
		expect(retried.counters).toMatchObject({ created: 2, failed: 0 });
		expect(frEntry(deps, "chaise")?.data).toMatchObject({ sku: "S3", price: 30 });
	});

	it("fails translation_exists for a translation it did not create, also on retry", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const editor = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau (éditeur)" },
			translationOf: en.get("E1")!.id,
		});
		const first = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const failure = {
			status: "failed",
			errors: [
				{
					field: "translationOf",
					code: "translation_exists",
					message: `The source entry already has a translation in fr (entry ${editor.id}) that this import did not create`,
				},
			],
		};
		expect(first.rows[0]).toMatchObject(failure);
		await transitionJob(deps, first.job.id, "retry");
		await runToEnd(deps, first.job.id);
		expect((await rows(deps, first.job.id))[0]).toMatchObject(failure);
		expect(deps.content.entries.get(editor.id)?.data.title).toBe("Bureau (éditeur)");
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toBeNull();
	});

	it("imports a record without a value as an entry of its own, with every mapping", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const creates = recordCreates(deps);
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F4", "", "Tabouret", ",S4,40,,,new,"));
		expect(row).toMatchObject({ status: "created" });
		const own = frEntry(deps, "tabouret")!;
		expect(own.group).toBe(own.id);
		expect(own.data).toMatchObject({ sku: "S4", price: 40, flux_source_id: "F4" });
		expect(creates[0]).not.toHaveProperty("translationOf");
		expect(creates[0]).toMatchObject({ taxonomies: { tag: ["new"] } });
	});

	it("fails required for a shared required field only for a record without a value", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const fields = schemaFields.map((f) => (f.slug === "sku" ? { ...f, required: true } : f));
		const template = french({
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F4", "", "Tabouret");
		const job = await start(deps, template, csv, { fields });
		expect(job.sharedRequired).toEqual(["sku"]);
		await runToEnd(deps, job.id);
		const [linked, own] = await rows(deps, job.id);
		expect(linked).toMatchObject({ status: "created" });
		expect(own).toMatchObject({
			status: "failed",
			errors: [{ field: "sku", code: "required", message: "The field is required" }],
		});
	});

	it("fails translation_of_missing when a linked record loses its value", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		const price = frEntry(deps, "bureau")?.data.price;
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "", "Bureau", ",S9,99,,,,"));
		expect(row).toMatchObject({
			status: "failed",
			entryId: frEntry(deps, "bureau")?.id,
			errors: [{ field: "translationOf", code: "translation_of_missing" }],
		});
		expect(frEntry(deps, "bureau")?.data.price).toBe(price);
	});

	it("updates an entry of its own that now names a source, warning it is not linked", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F4", "", "Tabouret", ",S4,40,,,,"));
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F4", "E2", "Tabouret bas", ",S9,99,,,,"));
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", before: "tabouret", after: "tabouret-bas" },
				{ field: "title", before: "Tabouret", after: "Tabouret bas" },
			],
			warnings: [
				{
					field: "translationOf",
					code: "translation_not_linked",
					message:
						"The entry is not a translation of en: E2, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation",
				},
			],
		});
		// The shared mappings were not read, so the entry keeps its own values.
		expect(frEntry(deps, "tabouret-bas")?.data).toMatchObject({ sku: "S4", price: 40 });
	});

	it("updates a translation whose source is gone, with a warning", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		deps.content.entries.delete(en.get("E1")!.id);
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau neuf"));
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", before: "bureau", after: "bureau-neuf" },
				{ field: "title", before: "Bureau", after: "Bureau neuf" },
			],
			warnings: [
				{
					code: "translation_source_not_found",
					message:
						'No entry in "products" (en) was imported with the key "E1"; the entry is updated without its source',
				},
			],
		});
	});

	it("plans a dry run with the source and group reads and writes nothing", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const before = deps.content.entries.size;
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F3", "E3", "Chaise");
		const { job, rows: planned } = await run(deps, french(), csv, { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(planned[0]).toMatchObject({
			status: "planned",
			action: "create",
			changes: expect.arrayContaining([{ field: "translationOf", before: null, after: "en: E1" }]),
		});
		expect(planned[1]).toMatchObject({ errors: [{ code: "translation_source_not_found" }] });
		expect(deps.content.entries.size).toBe(before);
		expect(deps.content.calls.filter((c) => c.startsWith("translations:"))).toHaveLength(1);
	});

	it("finds sources by link row only in a dry run before the source ID field exists", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		const fields = schemaFields.filter((f) => f.slug !== "flux_source_id");
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau");
		const linked = await run(deps, french(), csv, { dryRun: true, fields });
		expect(linked.rows[0]).toMatchObject({ status: "planned", action: "create" });
		await deps.links.delete(linkKey("products", "en", "E1"));
		const unlinked = await run(deps, french(), csv, { dryRun: true, fields });
		expect(unlinked.rows[0]).toMatchObject({
			errors: [{ code: "translation_source_not_found" }],
		});
		expect(deps.content.calls).not.toContain("find:E1");
	});

	it("reports an ambiguous source ID as the record's error", async () => {
		const { deps } = setup();
		await importEnglish(deps);
		await deps.links.delete(linkKey("products", "en", "E1"));
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		const {
			rows: [row],
		} = await run(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		expect(row).toMatchObject({
			status: "failed",
			errors: [{ field: "translationOf", code: "ambiguous_source_id" }],
		});
	});

	it("maps a CONFLICT and a NOT_FOUND from the create to their codes", async () => {
		const { deps } = setup();
		const en = await importEnglish(deps);
		const desk = en.get("E1")!;
		let raced = false;
		deps.content.failWrite = (data) => {
			if (data.title === "Bureau" && !raced) {
				// Another writer adds the French translation between the group read and the create.
				raced = true;
				void deps.content.create({
					collection: "products",
					locale: "fr",
					data: { title: "Racer" },
					translationOf: desk.id,
				});
				return new ContentWriteError("emdash_conflict", "Translation already exists");
			}
			if (data.title === "Lampe") {
				return new ContentWriteError("emdash_not_found", "Translation source content not found");
			}
			return null;
		};
		const csv = FR_HEADER + frRow("F1", "E1", "Bureau") + frRow("F2", "E2", "Lampe");
		const {
			rows: [conflict, gone],
		} = await run(deps, french(), csv);
		const racer = [...deps.content.entries.values()].find((e) => e.data.title === "Racer")!.id;
		expect(conflict).toMatchObject({
			status: "failed",
			action: "create",
			errors: [{ code: "translation_exists", message: expect.stringContaining(racer) }],
		});
		expect(gone).toMatchObject({
			status: "failed",
			errors: [
				{
					code: "translation_source_not_found",
					message: `The source entry ${en.get("E2")!.id} (en: E2) no longer exists`,
				},
			],
		});
	});

	it("charges each record's lookups to the batch budget, with source hits cached", async () => {
		// Per linked create: COST_RECORD 25, the source's link row 1 and read 5, the group read 5.
		const plain = french({
			fields: { title: { from: "Nom", type: "text" } },
			taxonomies: undefined,
			bylines: undefined,
		});
		const csv =
			FR_HEADER +
			frRow("F1", "E1", "Bureau") +
			frRow("F2", "E1", "Bureau 2") +
			frRow("F3", "E2", "Lampe");
		for (const [budget, seq] of [
			[36, 1],
			[37, 2],
			// The second record finds E1 in the cache (25 + 5), so 66 is spent after two.
			[66, 2],
			[67, 3],
		] as const) {
			const { deps } = setup();
			await importEnglish(deps);
			const job = await start(deps, plain, csv);
			const after = await runBatch(deps, job.id, "driver", Number.POSITIVE_INFINITY, budget);
			expect([budget, after.cursor.seq]).toEqual([budget, seq]);
		}
	});

	it("repairs a crash after a linked create by the source key, creating no second entry", async () => {
		const { deps, clock } = setup();
		const en = await importEnglish(deps);
		const job = await start(deps, french(), FR_HEADER + frRow("F1", "E1", "Bureau"));
		let crash = true;
		deps.content.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toBeNull();
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		// As for any create the crash interrupted: the draft is not provably this job's, so it is
		// left unpublished (M2).
		expect(done.counters).toMatchObject({ created: 0, conflict: 1, failed: 0 });
		const fr = [...deps.content.entries.values()].filter((e) => e.locale === "fr");
		expect(fr).toHaveLength(1);
		expect(fr[0]?.group).toBe(en.get("E1")!.id);
		expect((await rows(deps, job.id))[0]).toMatchObject({
			entryId: fr[0]?.id,
			errors: [{ code: "publish_unverified" }],
		});
		expect(await deps.links.get(linkKey("products", "fr", "F1"))).toMatchObject({
			entryId: fr[0]?.id,
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/translation-import.test.ts`
Expected: FAIL (14 failed, 1 passed: "imports a record without a value as an entry of its own" already holds).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type CurrentLinks,
	comparisonsOf,
````
with:
````ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type Change,
	type CurrentLinks,
	comparisonsOf,
````

then replace
````ts
	COST_READ,
	COST_RECORD,
	LookupCache,
	loadTerms,
	resolveLinks,
	termPath,
} from "./resolve.js";
````
with:
````ts
	COST_READ,
	COST_RECORD,
	findTranslationSource,
	LookupCache,
	loadTerms,
	resolveLinks,
	sourceNotFoundMessage,
	termPath,
} from "./resolve.js";
````

then replace
````ts
	/** The record's Portable Text values, written with the data; absent when it maps none. */
	portableText?: Record<string, PortableTextPlanItem | null>;
};

````
with:
````ts
	/** The record's Portable Text values, written with the data; absent when it maps none. */
	portableText?: Record<string, PortableTextPlanItem | null>;
	/** A create's translation source (its entry ID, M4e); absent for an entry of its own. */
	translationOf?: string;
};

````

then replace
````ts
		const drafts = mapped.value.portableText;
		const hasImages = Object.values(drafts ?? {}).some((d) => d !== null && d.images.length > 0);
		if (requests || mediaRequests || hasImages) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
````
with:
````ts
		const drafts = mapped.value.portableText;
		const hasImages = Object.values(drafts ?? {}).some((d) => d !== null && d.images.length > 0);
		// A template with translationOf looks entries up for every record (M4e).
		const translating = job.template.translationOf !== undefined;
		const lookingUp = requests !== undefined || translating;
		if (lookingUp || mediaRequests || hasImages) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
````

then replace
````ts
			else errors.push(...resolution.errors);
		}
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
````
with:
````ts
			else errors.push(...resolution.errors);
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = mapped.value.translationOf;
		let source: { id: string; group: string } | null = null;
		if (translates !== undefined) {
			try {
				source = await findTranslationSource(
					deps,
					cache,
					collection,
					job.template.translationOf?.locale ?? "",
					translates,
					sourceIdReady(job),
				);
			} catch (e) {
				if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
				errors.push({ field: "translationOf", code: e.code, message: e.message });
			}
		}
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
````

then replace
````ts
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		if (link && requests) cache.spend(COST_READ);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
````
with:
````ts
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		if (link && lookingUp) cache.spend(COST_READ);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
````

then replace
````ts
		let repaired = false;
		if (!entry && existing !== null && sourceIdReady(job)) {
			if (requests) cache.spend(COST_READ);
			entry = await deps.content.findBySourceId(collection, locale, sourceKey, read);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
				repaired = true;
````
with:
````ts
		let repaired = false;
		if (!entry && existing !== null && sourceIdReady(job)) {
			if (lookingUp) cache.spend(COST_READ);
			// A translation's source ID is its source's key (spec M4e F1), which an editor's
			// translation carries too: such an entry is taken only for a row this job was writing.
			const found = await deps.content.findBySourceId(
				collection,
				locale,
				translates ?? sourceKey,
				read,
			);
			if (
				found &&
				(translates === undefined || existing.status === "writing" || existing.entryId === found.id)
			) {
				entry = found;
				link = { collection, locale, sourceKey, entryId: found.id };
				await deps.links.put(ctx.linkId, link);
				repaired = true;
````

then replace
````ts
		}
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
````
with:
````ts
		}
		entryId = entry?.id ?? null;
		let translationChange: Change | undefined;
		if (translating) {
			const verdict = await checkTranslation(deps, cache, job, entry, translates, source);
			if ("error" in verdict) {
				return { status: "failed", sourceKey, entryId, errors: [verdict.error] };
			}
			found.warnings.push(...verdict.warnings);
			if (verdict.change && source) {
				ctx.translationOf = source.id;
				translationChange = verdict.change;
			}
		}
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
````

then replace
````ts
			}
		}
		const plan = planRecord(entry, mapped.value, comparisons, links, media, ctx.portableText);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
````
with:
````ts
			}
		}
		const plan = withChange(
			planRecord(entry, mapped.value, comparisons, links, media, ctx.portableText),
			translationChange,
		);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
````

then replace
````ts
			}
		}
		const final = planRecord(entry, mapped.value, comparisons, links, ctx.media, ctx.portableText);
		action = final.action;
		if (entry && final.action === "unchanged") {
````
with:
````ts
			}
		}
		const final = withChange(
			planRecord(entry, mapped.value, comparisons, links, ctx.media, ctx.portableText),
			translationChange,
		);
		action = final.action;
		if (entry && final.action === "unchanged") {
````

then replace
````ts
}

/**
 * A `required` error for each required Portable Text field that holds a value in the source but
````
with:
````ts
}

/** The plan with a linked create's `translationOf` change last (M4e). */
function withChange(plan: RecordPlan, change: Change | undefined): RecordPlan {
	return change === undefined ? plan : { ...plan, changes: [...plan.changes, change] };
}

/** The ID of the group's entry in `locale` (EmDash's casing ignored), or null when it has none. */
async function translationIn(
	deps: EngineDeps,
	collection: string,
	sourceId: string,
	locale: string,
): Promise<string | null> {
	const lower = locale.toLowerCase();
	const entries = await deps.content.translations(collection, sourceId);
	return entries.find((t) => t.locale.toLowerCase() === lower)?.id ?? null;
}

function translationExists(locale: string, id: string): RecordError {
	return {
		field: "translationOf",
		code: "translation_exists",
		message: `The source entry already has a translation in ${locale} (entry ${id}) that this import did not create`,
	};
}

/**
 * The decision table of spec M4e ("Resolution, diff and writes") for a template that maps
 * `translationOf`: an error fails the record; warnings go on its row; `change` marks a linked
 * create. `value` is the record's `translationOf` value, `source` what it found.
 */
async function checkTranslation(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	value: string | undefined,
	source: { id: string; group: string } | null,
): Promise<{ error: RecordError } | { warnings: RecordError[]; change?: Change }> {
	const { collection, locale } = job.template;
	const sourceLocale = job.template.translationOf?.locale ?? "";
	const field = "translationOf";
	if (value === undefined) {
		// EmDash sets a translation's group to its source's (spec M4e F3).
		if (entry?.group !== undefined && entry.group !== entry.id) {
			return {
				error: {
					field,
					code: "translation_of_missing",
					message:
						"The entry is a translation, so the record needs a translationOf value: without one its shared values would overwrite its translation group's",
				},
			};
		}
		return { warnings: [] };
	}
	const missing = sourceNotFoundMessage(collection, sourceLocale, value);
	if (entry === null) {
		if (source === null) {
			return { error: { field, code: "translation_source_not_found", message: missing } };
		}
		cache.spend(COST_READ);
		const taken = await translationIn(deps, collection, source.id, locale);
		if (taken !== null) return { error: translationExists(locale, taken) };
		return { warnings: [], change: { field, before: null, after: `${sourceLocale}: ${value}` } };
	}
	if (source === null) {
		const message = `${missing}; the entry is updated without its source`;
		return { warnings: [{ field, code: "translation_source_not_found", message }] };
	}
	if ((entry.group ?? entry.id) !== source.group) {
		const message = `The entry is not a translation of ${sourceLocale}: ${value}, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation`;
		return { warnings: [{ field, code: "translation_not_linked", message }] };
	}
	return { warnings: [] };
}

/**
 * A `required` error for each required Portable Text field that holds a value in the source but
````

then replace
````ts
}

/** A create's links: every non-empty one. New byline credits have no role label. */
function createLinks(resolved: ResolvedLinks | undefined): LinkWrites {
````
with:
````ts
}

/**
 * A linked create's links (M4e): only the bylines, always when mapped, an empty list included,
 * since EmDash copies the source's credits when none are given (spec M4e F5). Terms and
 * references are the translation group's.
 */
function translationLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	if (resolved?.bylines === undefined) return {};
	return { bylines: resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null })) };
}

/** A create's links: every non-empty one. New byline credits have no role label. */
function createLinks(resolved: ResolvedLinks | undefined): LinkWrites {
````

then replace
````ts
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry) {
		written = await deps.content.create({
			collection,
````
with:
````ts
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry && ctx.translationOf !== undefined) {
		const value = mapped.translationOf ?? sourceKey;
		const created = await createTranslation(ctx, ctx.translationOf, value, plan, {
			collection,
			locale,
			...slugPart,
			// EmDash copies the source's source ID; sent so it is the same where the field is
			// translatable (spec M4e "Writes").
			data: { ...data, [SOURCE_ID_FIELD]: value },
			...translationLinks(ctx.links),
		});
		if ("status" in created) return created;
		written = created;
	} else if (!entry) {
		written = await deps.content.create({
			collection,
````

then replace
````ts
}

async function importPass(
	deps: EngineDeps,
````
with:
````ts
}

/**
 * Creates the entry as a translation of `sourceId`, found by the source key `value`. A source
 * trashed since it was found fails `translation_source_not_found`; an entry another writer added
 * in the locale meanwhile (a `CONFLICT`) fails `translation_exists`.
 */
async function createTranslation(
	ctx: RecordCtx,
	sourceId: string,
	value: string,
	plan: RecordPlan,
	input: Omit<Parameters<EngineDeps["content"]["create"]>[0], "translationOf">,
): Promise<{ id: string; rev: string } | RowFields> {
	const { deps, sourceKey } = ctx;
	try {
		return await deps.content.create({ ...input, translationOf: sourceId });
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		const failed = (error: RecordError): RowFields => ({
			status: "failed",
			sourceKey,
			entryId: null,
			action: plan.action,
			errors: [error],
		});
		if (e.code === "emdash_not_found") {
			const sourceLocale = ctx.job.template.translationOf?.locale ?? "";
			const message = `The source entry ${sourceId} (${sourceLocale}: ${value}) no longer exists`;
			return failed({ field: "translationOf", code: "translation_source_not_found", message });
		}
		if (e.code === "emdash_conflict") {
			const taken = await translationIn(deps, input.collection, sourceId, input.locale);
			if (taken !== null) return failed(translationExists(input.locale, taken));
		}
		throw e;
	}
}

async function importPass(
	deps: EngineDeps,
````

then replace
````ts
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
		});
		if (!compiled.ok) {
````
with:
````ts
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
			sharedRequired: job.sharedRequired,
		});
		if (!compiled.ok) {
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/translation-import.test.ts`
Expected: PASS (1 file, 15 tests). Full suite after this task: 56 files / 1,349 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/translation-import.test.ts
git commit -m "Create records that name a source as translations in its group, and judge existing entries by their group"
```

### Task 6: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/fixtures/translations.ts`, `packages/flux-import/tests/integration/translations.test.ts`

**Interfaces:**
- Consumes: Tasks 0-5 through the plugin routes; `Client`, `devBypass`, `startServer`, `stopServer`, `FeedServer`, `withDb`, `RED_PNG`, `BLUE_PNG`; the REST routes `POST /_emdash/api/schema/collections/{c}/fields` (with `translatable`), `GET /_emdash/api/content/{c}?locale=…`, `GET /_emdash/api/content/{c}/{id}/translations`, `POST /_emdash/api/content/{c}` with `translationOf`.
- Produces: `tests/fixtures/translations.ts`: `TranslationNames`, `translationNames`, `createTranslationSchema`, `englishTemplate`, `translationTemplate`, `ENGLISH_HEADER`, `TRANSLATION_HEADER`, `englishCsv`, `TranslationRow`, `translationCsv`, `listLocale`, `translationsOf` (Task 7 imports them).

- [ ] **Step 1: Write the fixture and the tests**

Create `packages/flux-import/tests/fixtures/translations.ts`:
````ts
/**
 * Schema, sources and templates for the M4e translation imports on the Node and workerd sites
 * (both configure the locales en, fr and de): a revisioned `products` collection with a
 * translatable title and image, non-translatable `sku` and `price`, a reference field and a tag
 * taxonomy; an English template and translation templates that name English keys.
 */
import type { Client, Product } from "../integration/client.js";

export type TranslationNames = { products: string; tag: string };

export function translationNames(prefix: string): TranslationNames {
	return { products: `${prefix}_products`, tag: `${prefix}_tag` };
}

/** Creates the collection (with revisions), its fields and the tag taxonomy with the term `new`. */
export async function createTranslationSchema(client: Client, n: TranslationNames): Promise<void> {
	await client.createCollection(n.products);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "sku", label: "SKU", type: "string", translatable: false },
		{ slug: "price", label: "Price", type: "number", translatable: false },
		{ slug: "photo", label: "Photo", type: "image" },
		{
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { targetCollection: n.products, multiple: true },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${n.products}/fields`, field);
	}
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.tag,
		label: "Tags",
		collections: [n.products],
	});
	await client.api("POST", `/_emdash/api/taxonomies/${n.tag}/terms`, {
		slug: "new",
		label: "New",
		locale: "en",
	});
}

/** English products: every mapping, `related` by import key. */
export function englishTemplate(n: TranslationNames) {
	return {
		version: 1,
		collection: n.products,
		locale: "en",
		key: { from: "id" },
		slug: { from: "handle" },
		fields: {
			title: { from: "Name", type: "text" },
			sku: { from: "SKU", type: "text" },
			price: { from: "Price", type: "number" },
			photo: { from: "Photo", type: "image" },
			related: { from: "Related", type: "reference", match: "key" },
		},
		taxonomies: { [n.tag]: { from: "Tags" } },
	};
}

/**
 * A translation of the English products into `locale`: the same mappings, and `translationOf`
 * from `en_id` in the default locale (left out, so job creation fills it in).
 */
export function translationTemplate(n: TranslationNames, locale: "fr" | "de") {
	return { ...englishTemplate(n), locale, translationOf: { from: "en_id" } };
}

export const ENGLISH_HEADER = "id,handle,Name,SKU,Price,Photo,Related,Tags";
export const TRANSLATION_HEADER = "id,en_id,handle,Name,SKU,Price,Photo,Related,Tags";

/** An English CSV; the first row has `photo`, and every later row is related to the first. */
export function englishCsv(
	rows: [id: string, name: string, sku: string, price: number][],
	photo = "",
): string {
	const lines = rows.map(([id, name, sku, price], i) =>
		[
			id,
			name.toLowerCase(),
			name,
			sku,
			price,
			i === 0 ? photo : "",
			i === 0 ? "" : rows[0]?.[0],
			"new",
		].join(","),
	);
	return [ENGLISH_HEADER, ...lines, ""].join("\n");
}

export type TranslationRow = {
	id: string;
	/** The English key; "" for an entry of its own. */
	enId: string;
	name: string;
	photo?: string;
	sku?: string;
	price?: string;
	related?: string;
	tags?: string;
};

/**
 * A translation CSV. By default the shared columns hold values that must never be written to a
 * linked entry, and would fail a record that reads them: another SKU, a price that is not a
 * number, an unknown reference and an unknown tag.
 */
export function translationCsv(rows: TranslationRow[]): string {
	const lines = rows.map((r) =>
		[
			r.id,
			r.enId,
			r.name.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.sku ?? "XX",
			r.price ?? "n/a",
			r.photo ?? "",
			r.related ?? "NOPE",
			r.tags ?? "missing",
		].join(","),
	);
	return [TRANSLATION_HEADER, ...lines, ""].join("\n");
}

/** Every entry of the collection in one locale. */
export async function listLocale(client: Client, collection: string, locale: string) {
	const page = await client.api<{ items: Product[] }>(
		"GET",
		`/_emdash/api/content/${collection}?locale=${locale}&limit=100`,
	);
	return page.items;
}

/** The entry's translation group: its ID and the locale of each of its entries, by ID. */
export async function translationsOf(client: Client, collection: string, id: string) {
	const data = await client.api<{
		translationGroup: string;
		translations: { id: string; locale: string }[];
	}>("GET", `/_emdash/api/content/${collection}/${id}/translations`);
	return {
		group: data.translationGroup,
		locales: Object.fromEntries(data.translations.map((t) => [t.locale, t.id])),
	};
}
````

Create `packages/flux-import/tests/integration/translations.test.ts`:
````ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { BLUE_PNG, RED_PNG } from "../fixtures/media.js";
import {
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	type TranslationRow,
	translationCsv,
	translationNames,
	translationsOf,
	translationTemplate,
} from "../fixtures/translations.js";
import { Client, devBypass, type Product } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4392;
const n = translationNames("it_m4e");

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	feeds.feeds.set("/desk.png", { body: RED_PNG, contentType: "image/png" });
	feeds.feeds.set("/lampe.png", { body: BLUE_PNG, contentType: "image/png" });
	// Its own server: photos are fetched from 127.0.0.1 (allowPrivateNetwork).
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await createTranslationSchema(client, n);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

async function importCsv(
	csv: string,
	template: object,
	opts: { dryRun?: boolean; publish?: boolean } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: 10,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const french = translationTemplate(n, "fr");
const german = translationTemplate(n, "de");
const frCsv = (rows: TranslationRow[]) => translationCsv(rows);

async function get(id: string, locale: string) {
	return client.api<{ item: Product & { translationGroup: string; locale: string }; _rev: string }>(
		"GET",
		`/_emdash/api/content/${n.products}/${id}?locale=${locale}`,
	);
}

const bySource = async (locale: string) =>
	new Map((await listLocale(client, n.products, locale)).map((e) => [e.slug, e]));

const english = new Map<string, Product>();
const photoUrl = (path: string) => feeds.url(path);
const requestsFor = (path: string) => feeds.requests.filter((r) => r.path === path).length;

describe("M4e translations end to end", () => {
	it("imports French translations into the English groups, with the English shared values", async () => {
		const en = await importCsv(
			englishCsv(
				[
					["E1", "Desk", "S1", 100],
					["E2", "Lamp", "S2", 20],
				],
				photoUrl("/desk.png"),
			),
			englishTemplate(n),
		);
		expect(en.job.counters).toMatchObject({ created: 2, failed: 0 });
		for (const e of await listLocale(client, n.products, "en")) {
			english.set(e.data.flux_source_id as string, e);
		}
		const csv = frCsv([
			{ id: "F1", enId: "E1", name: "Bureau", photo: photoUrl("/desk.png") },
			{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
		]);
		const fr = await importCsv(csv, french);
		expect(fr.job.template.translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(fr.job.warnings).toEqual([
			`Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price"; reference field "related"; taxonomy "${n.tag}"`,
		]);
		expect(fr.job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(fr.rows[0]?.changes).toContainEqual({
			field: "translationOf",
			before: null,
			after: "en: E1",
		});
		const desk = english.get("E1") as Product;
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect(bureau.data).toMatchObject({
			title: "Bureau",
			sku: "S1",
			price: 100,
			flux_source_id: "E1",
		});
		expect(await translationsOf(client, n.products, desk.id)).toEqual({
			group: desk.id,
			locales: { en: desk.id, fr: bureau.id },
		});
		expect(await client.entryTerms(n.products, bureau.id, n.tag)).toEqual(["new"]);
		// The photo is translatable: the French entry has its own value, the same library item for
		// the shared URL, downloaded once.
		expect((bureau.data.photo as { id: string }).id).toBe((desk.data.photo as { id: string }).id);
		expect(requestsFor("/desk.png")).toBe(1);
		expect(requestsFor("/lampe.png")).toBe(1);
		const lampe = (await bySource("fr")).get("lampe") as Product;
		// The selection is the group's, read in the entry's locale (spec M4e F4).
		const related = (await get(lampe.id, "fr")).item.references?.related?.children ?? [];
		expect(related.map((c) => c.translationGroup)).toEqual([desk.id]);

		const again = await importCsv(csv, french);
		expect(again.job.counters).toMatchObject({ unchanged: 2 });
		expect(requestsFor("/desk.png") + requestsFor("/lampe.png")).toBe(2);
	});

	it("syncs a new English price into the French entry, which then re-runs unchanged", async () => {
		const en = await importCsv(
			englishCsv(
				[
					["E1", "Desk", "S1", 120],
					["E2", "Lamp", "S2", 20],
				],
				photoUrl("/desk.png"),
			),
			englishTemplate(n),
		);
		expect(en.job.counters).toMatchObject({ updated: 1, unchanged: 1 });
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect(bureau.data.price).toBe(120);
		const fr = await importCsv(
			frCsv([
				{ id: "F1", enId: "E1", name: "Bureau", photo: photoUrl("/desk.png") },
				{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
			]),
			french,
		);
		expect(fr.job.counters).toMatchObject({ unchanged: 2 });
	});

	it("fails rows whose source does not exist, and creates them on retry after the English job", async () => {
		const csv = frCsv([{ id: "F3", enId: "E3", name: "Chaise" }]);
		const first = await importCsv(csv, french);
		expect(first.rows[0]).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "translationOf",
					code: "translation_source_not_found",
					message: `No entry in "${n.products}" (en) was imported with the key "E3"`,
				},
			],
		});
		await importCsv(englishCsv([["E3", "Chair", "S3", 30]]), englishTemplate(n));
		await client.plugin("jobs/retry", { id: first.job.id });
		const retried = await client.runToEnd(first.job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const chaise = (await bySource("fr")).get("chaise") as Product;
		expect(chaise.data).toMatchObject({ sku: "S3", price: 30 });
	});

	it("plans a German dry run with the translationOf change and writes nothing", async () => {
		const { job, rows } = await importCsv(
			frCsv([{ id: "D1", enId: "E1", name: "Schreibtisch" }]),
			german,
			{ dryRun: true },
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).toMatchObject({ status: "planned", action: "create" });
		expect(rows[0]?.changes).toContainEqual({
			field: "translationOf",
			before: null,
			after: "en: E1",
		});
		expect(await listLocale(client, n.products, "de")).toEqual([]);
	});

	it("links German entries to the same groups, and refuses a group an editor already translated", async () => {
		const lamp = english.get("E2") as Product;
		const editor = await client.api<{ item: { id: string } }>(
			"POST",
			`/_emdash/api/content/${n.products}`,
			{
				data: { title: "Lampe (Redaktion)" },
				locale: "de",
				translationOf: lamp.id,
			},
		);
		const { job, rows } = await importCsv(
			frCsv([
				{ id: "D1", enId: "E1", name: "Schreibtisch" },
				{ id: "D2", enId: "E2", name: "Lampe" },
			]),
			german,
		);
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(rows[1]).toMatchObject({
			status: "failed",
			errors: [
				{
					code: "translation_exists",
					message: `The source entry already has a translation in de (entry ${editor.item.id}) that this import did not create`,
				},
			],
		});
		const desk = english.get("E1") as Product;
		const { locales } = await translationsOf(client, n.products, desk.id);
		expect(Object.keys(locales).sort()).toEqual(["de", "en", "fr"]);
	});

	it("imports a row without a value as an entry of its own, and refuses to unlink a translation", async () => {
		const own = await importCsv(
			frCsv([
				{ id: "F4", enId: "", name: "Tabouret", sku: "S4", price: "40", related: "", tags: "" },
			]),
			french,
		);
		expect(own.job.counters).toMatchObject({ created: 1, failed: 0 });
		const tabouret = (await bySource("fr")).get("tabouret") as Product;
		expect(tabouret.data).toMatchObject({ sku: "S4", price: 40, flux_source_id: "F4" });
		expect((await translationsOf(client, n.products, tabouret.id)).group).toBe(tabouret.id);

		const unlinked = await importCsv(
			frCsv([{ id: "F1", enId: "", name: "Bureau", sku: "S9", price: "9", related: "", tags: "" }]),
			french,
		);
		expect(unlinked.rows[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "translation_of_missing" }],
		});
		expect(((await bySource("fr")).get("bureau") as Product).data.price).toBe(120);
	});

	it("stages a French draft with publish: false and publishes it later, leaving the English entry alone", async () => {
		const desk = english.get("E1") as Product;
		const before = await get(desk.id, "en");
		const csv = frCsv([
			{ id: "F1", enId: "E1", name: "Grand bureau", photo: photoUrl("/desk.png") },
		]);
		const draft = await importCsv(csv, french, { publish: false });
		expect(draft.rows[0]).toMatchObject({ status: "updated" });
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect((await get(bureau.id, "fr")).item.draftRevisionId).not.toBeNull();
		const published = await importCsv(csv, french);
		expect(published.rows[0]).toMatchObject({ status: "updated" });
		const after = await get(desk.id, "en");
		expect(after._rev).toBe(before._rev);
		expect(after.item.draftRevisionId).toBeNull();
		expect((await get(bureau.id, "fr")).item).toMatchObject({
			status: "published",
			draftRevisionId: null,
			data: { title: "Grand bureau", price: 120 },
		});
	});

	it("repairs a linked create whose link was never saved, and creates no second entry", async () => {
		// The failing second row keeps the job's file for jobs/retry.
		const first = await importCsv(
			frCsv([
				{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
				{ id: "F9", enId: "E9", name: "Rien" },
			]),
			french,
		);
		expect(first.rows.map((r) => r.status)).toEqual(["unchanged", "failed"]);
		// As a crash would leave it: the row still writing, the link not saved.
		const lampe = (await bySource("fr")).get("lampe") as Product;
		withDb(server.dbPath, (db) => {
			db.prepare(
				"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
			).run("flux-import", "links", `${n.products}:fr:F2`);
			const moved = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_set(data, '$.status', 'writing') WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.jobId') = ? AND json_extract(data, '$.sourceKey') = ?",
				)
				.run("flux-import", "records", first.job.id, "F2");
			expect(moved.changes).toBe(1);
		});
		await client.plugin("jobs/retry", { id: first.job.id });
		const repaired = await client.runToEnd(first.job.id);
		expect(repaired.counters).toMatchObject({ updated: 1, failed: 1, conflict: 0 });
		const rows = await client.records(first.job.id);
		expect(rows[0]).toMatchObject({ status: "updated", entryId: lampe.id });
		const lamp = english.get("E2") as Product;
		expect((await translationsOf(client, n.products, lamp.id)).locales.fr).toBe(lampe.id);
		expect(
			(await listLocale(client, n.products, "fr")).filter((e) => e.data.flux_source_id === "E2"),
		).toHaveLength(1);
	});
});
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/translations.test.ts`
Expected: PASS (1 file, 8 tests, about 13 s with the server start). This proves on Node that French translations join the English groups with the English shared values and their own title, slug and photo (one download for the shared URL), that a French re-run is `unchanged`, that an English price change reaches the French entry and the French re-run stays `unchanged`, that missing sources fail and `jobs/retry` creates them after the English job, that a German dry run plans the `translationOf` change and writes nothing, that an editor's German translation makes `translation_exists`, that a row without a value is an entry of its own and that removing a linked row's value fails `translation_of_missing`, that `publish: false` then `publish: true` leaves the English entry's revision unchanged (Fact V3), and that a linked create whose link was lost is repaired without a second entry (Ruling 12). Then run `pnpm test:integration` (about 9 minutes; Fact F1 and Fact F3 describe the known flakes): all files pass.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`; restore `sites/dev/emdash-env.d.ts` if the dev server changed it (`git checkout sites/dev/emdash-env.d.ts`), then:
```bash
git add packages/flux-import/tests/fixtures/translations.ts packages/flux-import/tests/integration/translations.test.ts
git commit -m "Prove M4e translation imports end to end on the Node dev site"
```

### Task 7: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Task 6's `tests/fixtures/translations.ts`; the parity harness (`client`, `listAll`, `records`, `runToEnd`).
- Produces: the workerd test "imports M4e translations on D1: linked groups, shared values, re-run unchanged, retry".

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
````ts
	postsJson,
} from "../fixtures/portable-text.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
````
with:
````ts
	postsJson,
} from "../fixtures/portable-text.js";
import {
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	translationCsv,
	translationNames,
	translationsOf,
	translationTemplate,
} from "../fixtures/translations.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
````

then replace
````ts
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
````
with:
````ts
	});

	it("imports M4e translations on D1: linked groups, shared values, re-run unchanged, retry", async () => {
		const n = translationNames("cf_m4e");
		await createTranslationSchema(client, n);
		const run = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", {
				uploadId,
				template,
				dryRun: false,
				budgetMs: 20_000,
			});
			return client.runToEnd(job.id);
		};
		const en = await run(
			englishCsv([
				["E1", "Desk", "S1", 100],
				["E2", "Lamp", "S2", 20],
			]),
			englishTemplate(n),
		);
		expect(en.counters).toMatchObject({ created: 2, failed: 0 });
		const english = new Map(
			(await listLocale(client, n.products, "en")).map((e) => [e.data.flux_source_id, e]),
		);
		const csv = translationCsv([
			{ id: "F1", enId: "E1", name: "Bureau" },
			{ id: "F2", enId: "E2", name: "Lampe" },
			{ id: "F3", enId: "E3", name: "Chaise" },
		]);
		const fr = await run(csv, translationTemplate(n, "fr"));
		expect(fr.counters).toMatchObject({ created: 2, failed: 1 });
		const failed = await client.records(fr.id, "failed");
		expect(failed.map((r) => r.errors?.[0]?.code)).toEqual(["translation_source_not_found"]);
		const french = new Map((await listLocale(client, n.products, "fr")).map((e) => [e.slug, e]));
		const desk = english.get("E1") as Product;
		const bureau = french.get("bureau") as Product;
		expect(bureau.data).toMatchObject({
			title: "Bureau",
			sku: "S1",
			price: 100,
			flux_source_id: "E1",
		});
		expect(await translationsOf(client, n.products, desk.id)).toEqual({
			group: desk.id,
			locales: { en: desk.id, fr: bureau.id },
		});
		expect(await client.entryTerms(n.products, bureau.id, n.tag)).toEqual(["new"]);

		const again = await run(csv, translationTemplate(n, "fr"));
		expect(again.counters).toMatchObject({ unchanged: 2, failed: 1 });
		await run(englishCsv([["E3", "Chair", "S3", 30]]), englishTemplate(n));
		await client.plugin("jobs/retry", { id: fr.id });
		const retried = await client.runToEnd(fr.id);
		expect(retried.counters).toMatchObject({ created: 3, failed: 0 });
		const chaise = (await listLocale(client, n.products, "fr")).find((e) => e.slug === "chaise");
		expect(chaise?.data).toMatchObject({ sku: "S3", price: 30, flux_source_id: "E3" });
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
````

- [ ] **Step 2: Run it**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M4e"`
Expected: PASS (1 passed, 13 skipped; about 3 s of tests plus about 17 s of server start). This proves on workerd and D1 that the French entries join the English groups with the English shared values and terms, that a French re-run is `unchanged`, and that a missing source fails and is created by `jobs/retry` after the English job. The full `pnpm test:cf` runs in Task 8.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove M4e translation imports on workerd and D1"
```

### Task 8: M4e review run

**Files:**
- Create: `docs/superpowers/notes/2026-11-03-m4e-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`

**Interfaces:**
- Consumes: everything above, and the Task 0 results in "Facts this plan relies on".
- Produces: the filled-in review note and the roadmap status; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 20 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Facts F1-F3 describe the known flakes). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` and `sites/dev/uploads` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass`, record each result:
1. Create the schema with `createTranslationSchema(client, translationNames("m4e"))` from `tests/fixtures/translations.ts` (or the same REST calls by hand), import `englishCsv([["E1", "Desk", "S1", 100], ["E2", "Lamp", "S2", 20]])` with `englishTemplate`, then run `jobs/create` with `translationTemplate(n, "fr")` and `translationCsv([{ id: "F1", enId: "E1", name: "Bureau" }, { id: "F3", enId: "E3", name: "Chaise" }])` as a dry run: F1 is `planned` with the change `translationOf: en: E1`, F3 fails `translation_source_not_found`, the job has the shared-values warning, and nothing is written.
2. Run it for real and open the English entry in the admin: its translations panel lists French; the French entry shows `Bureau`, the English SKU and price, and the English tag.
3. Change the English price in the admin, publish it, and re-run the French job: `unchanged: 1`, `failed: 1`; the French entry shows the new price.
4. In the admin, use **Translate** on E2 to make a German translation by hand, then run `translationTemplate(n, "de")` with `translationCsv([{ id: "D2", enId: "E2", name: "Lampe" }])`: D2 fails `translation_exists` naming the editor's entry, which is unchanged.
5. Remove `i18n` from `sites/dev/astro.config.mjs` temporarily and restart: `jobs/create` with the French template fails `invalid_template` with "translationOf needs i18n with at least two locales". Put `i18n` back. Restore `sites/dev/data.db*` and `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-11-03-m4e-review.md` from this template and fill in every `…`:
````markdown
# Milestone 4e review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0)

| Fact | Check | Result |
| --- | --- | --- |
| V1: a create with `translationOf` joins the group, takes the source's shared values, terms, selection and (without `bylines`) credits, on Node and workerd | drafting probe (plan Facts); Tasks 5-7 | … |
| V2: `CONFLICT` for a taken locale; `handleContentTranslations` lists the group; a trashed source is `NOT_FOUND`; a trashed translation does not block a new one | drafting probe; Task 5 | … |
| V3: a translation's update and publish leave the source's `_rev` and `updatedAt` unchanged, without and with revisions | drafting probe; Task 6 | … |
| V4: a source update syncs into the translation (recorded: the translation's `_rev` moves, a pending draft gets a new draft revision) | drafting probe; Task 6 | … |
| V5: i18n in both sites, read inside a plugin route; the existing suites pass with it | drafting probe and suites; Step 1 | … |
| V6: `handleContentList` by locale and `flux_source_id` finds the translation, on Node and workerd | drafting probe; Tasks 5 and 6 | … |

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
| Unit, template: the schema, the default and resolved source locale, the refusals, the value's rules, the shared skip (a required non-translatable field with an empty value does not fail), `required` for `sharedRequired`, the `checkTemplate` exemption, the warning text, `usesLinks` | `translation-template.test.ts`, `translation-apply.test.ts` | … |
| Unit, engine: every row of the decision table; source by link row, by `flux_source_id`, not found, ambiguous, dry run without the field; the batch cache; the create input; `CONFLICT` and `NOT_FOUND`; crash repair by the value; the change on a planned create and none on a re-run; no media for a skipped image field | `translation-source.test.ts`, `translation-import.test.ts`, `content.test.ts`, `fakes.test.ts` | … |
| Integration on `sites/dev` (spec list, with Rulings 12 and 14) | `translations.test.ts` (integration) | … |
| Cloudflare parity on `sites/dev-cf` | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Dry run: planned change, missing source, warning, nothing written | … | … |
| 2 | Real run: the admin shows the French translation with the English shared values and tag | … | … |
| 3 | An English price change in the admin reaches the French entry; French re-run `unchanged` | … | … |
| 4 | An editor's German translation makes `translation_exists` and stays unchanged | … | … |
| 5 | Without i18n, `translationOf` is refused at job creation | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Mark M4e done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| M4e | Locales and translation links: one template per locale, `translationOf` resolved from another locale's source key, non-translatable fields left to EmDash's sync | Planned |
```
with:
```markdown
| **M4e** ([spec](./2026-11-03-flux-import-m4e-locales-design.md)) | Locales and translation links: one template per locale, `translationOf` resolved from another locale's source key, non-translatable fields left to EmDash's sync | Done ([review](../notes/2026-11-03-m4e-review.md)) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-11-03-m4e-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 4e review results and mark M4e done in the roadmap"
```

---

## After this plan

M4e is the last part of Milestone 4. Known gaps carried forward, all documented in the spec or in the rulings above: a per-record locale column and several locales in one job; finding the source by entry ID or slug; linking, moving or unlinking an existing entry (EmDash 1.2.0 cannot); adopting an existing translation; translations across collections; term, byline and menu translations; locale fallback for lookups; foreseeing a source that a dry run of the source locale would create. New open issues: a translation whose source was deleted keeps its group and fails `translation_of_missing` without a value; `translation_not_linked` and the missing-source warning repeat on every run; the `flux_source_id` fallback of a `match: "key"` reference finds a translation by its source's key; the M2 cross-job duplicate window becomes `translation_exists` for linked records; after a source sync a translation with the importer's pending draft reports `pending_draft` or stays unpublished (Fact V4); copied byline credits show only where the byline has a row in the translation's locale (Fact E1); a missed crash repair of a linked record ends in `translation_exists` naming the importer's own entry (Ruling 4). The M2-M4d open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-11-02-m4d-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands.
