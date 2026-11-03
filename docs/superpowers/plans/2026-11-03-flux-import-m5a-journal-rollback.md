# Flux Import M5a: run journal and rollback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below) and it changes no file. Tasks 1 and 3 can run in parallel worktrees; the rest follow in order (see "Parallel execution").

**Goal:** Make every real import job reversible. Before a job's first write to an entry it puts a write-ahead pre-image in a new `journal` storage collection (one row per job and entry: the live values, the slug, the links, the status, the schedule, the pending draft and the link row as they were), records the media items it creates in `journalMedia`, and stamps each link row with the job that last wrote it. `jobs/rollback` creates a rollback job, resumable and dry-runnable like an import, that reads the journal newest first, deletes the entries the job created (Trash, then a permanent delete, so the slugs are free again) and restores the ones it changed through the revert sequence (update, publish, unpublish, discard, restore draft, schedule), refusing every entry that changed after the job wrote it. Cancelling a job, and rolling one back, clear the URL source's `lastImport`. Templates stay `version: 1`; jobs gain the option `journal` (default `true`).

**Architecture:** `src/engine/types.ts` gains the journal types, `Job.kind`/`rollbackOf`/`rolledBackBy`/`journal`/`sourceId`, the record status `reverted`, the rollback actions and `LinkRow.jobId`; `src/emdash/storage.ts` and `src/plugin/definition.ts` the two collections (Task 1). `ContentPort` gains `getIncludingTrashed`, `trash`, `permanentDelete` and `revertStep`, and `EntrySnapshot` the status, schedule, draft flag, live values and timestamps, on the EmDash adapter and the fakes (Task 2). `src/engine/rollback-values.ts` holds the comparison and the boolean write-back (Task 3). `src/engine/journal.ts` builds and stores the pre-image; `processRecord` calls it before every write and the media helpers before every new upload (Task 4). `src/engine/rollback.ts` creates rollback jobs and their warnings, `src/plugin/retention.ts` purges journals, and `src/plugin/service.ts` caps Workers rollback batches at 3 (Task 5). `src/engine/revert.ts` is the rollback pass, which `runBatch` runs for `kind: "rollback"` (Task 6). Tasks 7 and 8 prove it on Node and on workerd.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-flux-import-m5a-journal-rollback-design.md` (all sections; amended by `a287d57` and `6cb9001`, see "Rulings" 1 and 5). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 5 split). Previous plan: `docs/superpowers/plans/2026-11-03-flux-import-m4e-locales.md`; its review: `docs/superpowers/notes/2026-11-03-m4e-review.md`.

Every code block in Tasks 1 to 8 was written, type-checked, linted and run while this plan was drafted (unit suite, the new Node integration file and the new workerd parity tests), then replayed task by task from `a47fbc1` (the spec commit; the two amendments after it change only the spec) in a fresh worktree by a script that parses this document's code blocks and replacements and applies them in order; results are in "Verification while drafting". EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's facts F1-F18 are cited as "spec F<n>".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. New: the route `jobs/rollback`, the job option `journal`, the storage collections `journal` (indexes `jobId`, `["jobId", "seq"]`) and `journalMedia` (indexes `jobId`, `["jobId", "seq"]`), and `LinkRow.jobId`. No new capability: the runtime handlers the rollback calls (`handleContentGetIncludingTrashed`, `handleContentDelete`, `handleContentPermanentDelete`, `handleContentPublish`, `handleContentUnpublish`, `handleContentSchedule`, `handleContentDiscardDraft`) are on the trusted runtime the plugin already uses (spec "Rollback").
- No new dependencies; no task touches `package.json` or `pnpm-lock.yaml`.
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine (`src/engine/`) never imports `emdash`; the runtime handlers are reached through `ContentPort` in `src/emdash/content.ts` only.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code (the tests use SQLite and `wrangler d1 execute` only to set up states no API offers). The importer never edits revisions, never restores from Trash and never deletes media or terms: what a rollback cannot undo is reported as a job warning.
- Vitest runs from `packages/flux-import` with file paths: `pnpm exec vitest run tests/unit/rollback.test.ts`. Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rollback.test.ts`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M5a"`. The new Node integration file starts its own server on port 4391; the shared server uses 4399, the workerd harness 4396, and the other suites 4392-4395, 4397 and 4398: never run two copies of the same harness at once. A Windows process (`Cursor.exe`) may hold 4397 through WSL's mirrored networking, which fails `retention.test.ts` in setup (Fact F3).
- Codes, exactly: record statuses `reverted` (new) and `planned`, `unchanged`, `conflict`, `failed`, `locked`; rollback actions `delete`, `trash`, `revert`; rollback errors `rollback_changed`, `rollback_has_translations`, `rollback_blocked`, `locked`, `journal_kind_unknown`; rollback warnings `rollback_trashed`, `rollback_schedule_passed`, `rollback_link_missing`, `nothing_to_roll_back`; import errors `journal_too_large`, `journal_incomplete`. Refusals are `invalid_transition` (409), `not_found` (404) and `invalid_options` (400), as for the other job routes.
- Never commit `sites/dev/.env`, tokens, or `sites/dev/emdash-env.d.ts` changes the dev server writes (the shared integration setup restores the file; restore it by hand after any other server run).
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 7 also passes its integration file (about 60 s with server start) and `pnpm test:integration`, Task 8 the targeted workerd tests (about 40 s); Task 9 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. Write-ahead before every write, first touch wins: the journal row is put with put-if-absent before the first create, update, publish of the importer's own draft, or media upload of the record; a second write of the same job to the same entry merges only fields the first pre-image lacks; a pre-image too large or one with a truncated reference selection fails the record before anything is written: Task 4 ("writes the pre-image before the update…", "keeps the first pre-image…", "fails a record whose pre-image is too large…").
2. Ownership is never guessed: a row is acted on only when the link row names the job and the entry's current `_rev`, when this rollback's own `writing` row names that `_rev` (resuming), or for a create made after the journal row and never changed since; everything else is `rollback_changed` and the entry is untouched: Task 6 ("ownership" tests), Task 7 (an editor's change, two jobs oldest first).
3. The revert sequence restores each pre-image exactly, on revisioned and plain collections: published, a draft the run published, the importer's pending draft under a published entry, a scheduled draft, a references-only change (spec F17): Task 6 (one test per shape), Task 7 (30 rows of every value kind on both collection types, and the pending draft), Task 0 V5.
4. Resumability: every step saves its `_rev` and step number on the record row before the next step, so a stopped batch continues without repeating a step; a delete stopped between Trash and the permanent delete finishes; a crashed batch's finished rows are counted once: Task 6 ("resuming a rollback"), Task 7 (SIGKILL mid-batch), Task 8 (a stop after the batch's writes).
5. Created entries leave no trace a re-import trips on: Trash then permanent delete for the job's own creates, so the same feed imports again without `SLUG_CONFLICT`; only Trash for crash-repaired ones; a root with active translations is refused: Task 6, Task 7, Task 8.
6. Imports without rollback are unchanged: dry runs and `journal: false` jobs write no journal; the only shared-code changes are the write-ahead calls in `processRecord` and the media helpers, `LinkRow.jobId`, the extra snapshot fields, the counter helper `bump`, and `lastImport` on cancel. The whole unit, integration and parity suites pass unchanged apart from the journal counts in the retention test and the `journal: false` in one link-import test.

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V7 are the facts the spec left unconfirmed. V1-V6 were proven while drafting with a temporary probe route (`probe/m5a`, calling the runtime's content handlers and counting D1 statements by wrapping the D1 binding's `prepare`) and a probe test on `sites/dev` (port 4420) and `sites/dev-cf` (port 4421), on a collection with revisions and one without, each with every M4a-M4d field type, a reference field, a tag taxonomy and two bylines. The probe was reverted; the Node and workerd results were identical after normalising IDs, revisions and timestamps.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds, under the plan's comparison.** An update whose `data` holds each value as `handleContentGet` returned it is accepted and reads back equal for text, number, integer, boolean, datetime, select, multiSelect, json, a custom slug field, image, file, Portable Text and `null`, when booleans compare by truth value (EmDash returns `1`/`0`; the rollback sends `Boolean(value)` for `boolean` target fields), an object's key order is ignored (an image value reads back with its keys in another order) and a `null` written reads back as an absent key (Ruling 4). | probe on Node and workerd, both collections; Task 3; Task 7 |
| V2 | **Holds.** `handleContentGet` and `handleContentList` with `fieldFilters` leave out trashed entries; `handleContentGetIncludingTrashed` returns a trashed entry with the `_rev` it had before the trash. | probe; Task 2 adapter tests |
| V3 | **Holds.** A created item has `createdAt === updatedAt`, and `handleContentGet` right after a create returns the `_rev` the create returned. | probe; Task 6 ownership of an unconfirmed create |
| V4 | **Holds.** Trash then permanent delete of a created entry, then a create with the same explicit slug and `flux_source_id`, succeeds on SQLite and D1. Permanently deleting a created translation leaves its source's terms and reference selection intact. | probe; Task 7 and Task 8 re-imports |
| V5 | **Failed for the first sequence, holds for the amended one.** With step 2 only publish or unpublish, "a draft never published that the run published" and "a future-scheduled draft that the run published" were not restored on either collection or database (spec F17, F18). The amended sequence (spec "Revert sequence", `a287d57`) restored all four pre-states on both collections exactly, the draft pointer and the live columns included. A links-only update (taxonomies, bylines) stages no draft; a references-only update does (spec F17). | probe; Task 6; Task 7 |
| V6 | **Holds.** A plugin storage value of 1 MiB of JSON is stored and read back on D1. | probe; `MAX_JOURNAL_BYTES` (Task 1) |
| V7 | **Per call, measured; per batch, re-measured in Task 9.** D1 ran 62-80 queries for an update with every field and link, 76 for a publish, 25-35 for an unpublish, 23 for a discard, 28-29 for a schedule and 10-12 for a read, so a reverted update costs about 175-265 queries and 10 rows would exceed the 1,000-query limit of one Workers invocation. The cap is 3 (Ruling 2). | probe; Task 9 Step 2 |
| E1 | EmDash refuses `orderBy` on a field no index of the collection names: `StorageQueryError: Cannot order by non-indexed field 'seq'` with the suggestion to add it to `storage.journalMedia.indexes` (`src/plugins/storage-query.ts:133-147`, `getIndexedFields` at `:96-108` counts every field of a composite index). The fakes do not check this, so the Node integration run found it: `journalMedia` has the index `["jobId", "seq"]` (spec amended in `6cb9001`). | Task 7 drafting run |
| E2 | An editor's schedule moves the entry's `_rev`, so the next import reports `pending_draft` for a scheduled draft and cannot write it. A `before.status` of `scheduled` arises in M5a only from a link row whose `writtenRev` is the scheduled revision (as an M5b scheduling import will leave it); Tasks 6 and 7 set that link state directly. | Task 7 drafting run |
| E3 | `createLinkSchema` with `linkNames("cf_m5a")` (byline slugs `cf_m5a-alex`, `cf_m5a-sam`) failed `400 VALIDATION_ERROR` on the byline create; with `cf-m5a-alex` and `cf-m5a-sam` it passes, so the workerd test overrides the two slugs. | Task 8 drafting run |
| E4 | The workerd harness is one site for every parity test, and the M4b test creates bylines with the same display names ("Alex Doe", "Sam Lee"), so a `match: "name"` byline mapping in a later test is ambiguous and fails its records. The M5a links test maps bylines by slug. It passed alone and failed only in the full `pnpm test:cf` run while drafting; after the change it passes together with the M4b test. | Task 8 drafting run |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition. Known since M3c; a re-run of the file settles it. | M3c-M4e plans |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d did not recur while drafting. If Task 8 or Task 9 sees it, capture the server log and record it in the review note. | M4d and M4e reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4397`, which WSL's mirrored networking shares, so `retention.test.ts` fails in setup with "Port 4397 is in use" (M4d review). | M4d and M4e reviews |

## Rulings this plan makes

1. **Revert sequence (spec amended in `a287d57`).** Step 2 publishes also when the entry is published with a draft and `before.status` is not `published` (on revisioned collections it makes step 1's values and slug live); step 3 unpublishes; step 4 discards a draft that `before.draft` does not account for (the one step 3's unpublish created, spec F18, or one step 1 staged on a never-published entry). Side effects, documented in the spec: an entry the run published for the first time is published once more before it is unpublished, so the publish hooks run again for it, and its `publishedAt` stays set (spec F12).
2. **Workers cap.** A rollback batch on Workers handles at most `WORKERS_ROLLBACK_BATCH_CAP = 3` rows (`workersBatchCap` in `src/plugin/service.ts`), from the per-call counts in Fact V7. Task 9 re-measures one batch of 3 reverted updates with the real code (V7) and the import's linked batch of `WORKERS_LINKED_BATCH_CAP = 10` on a translation template and on a references template (V8); a batch over about 900 queries lowers the cap in that task, recorded in the review note.
3. **References-only changes (spec F17).** An update whose only change is a reference selection stages a draft on a revisioned collection. The pre-image then holds `live: {}` (nothing in `data` changed) and the selection; the importer's publish moves the `_rev` the link records, so ownership holds; step 1 restores the selection, step 2 publishes it. Task 6 ("restores an entry whose only change was its references…") covers it, and an editor's later change of the same selection is still `rollback_changed`.
4. **Comparisons (`sameStored`).** Booleans compare by truth value, object keys in any order, and `null` equals an absent key, recursively; arrays compare in order. `restoredValue` sends `Boolean(value)` for a `boolean` target field and leaves other values as read. Tests compare pre-image and restored data with `sameStored`, everything else (status, schedule, slug, draft flag, links) exactly.
5. **Ownership (spec amended in `6cb9001`).** As the spec says, plus: a `create` row passes without a matching link row when its entry was created at or after the journal row's `at` and has `updatedAt === createdAt` (an adoption in step 1, or a create that crash repair found before its link row was saved; such an entry is only trashed); an `update` row whose job never wrote is `unchanged` also when the entry's `updatedAt` is before the journal row's `at`. Unchanged rows carry the warning `nothing_to_roll_back`: "Nothing to roll back: the import never wrote this entry" or "Nothing to roll back: the entry was never created, or was deleted since". A row saved as `writing` with `action: "delete"` whose entry is gone is a permanent delete that went through before the stop: `reverted`.
6. **Rollback job.** `createRollback` copies the original's `uploadId` (shown for the collection and locale; never read), `template` and `targetFields`, sets `kind: "rollback"`, `rollbackOf`, `dryRun` as asked, `publish: false`, `schemaReady: true`, `cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER }` and `retryFromSeq: Number.MAX_SAFE_INTEGER` (newest first), and the warnings of spec "Job warnings". A real one then marks the original `rolledBackBy` by compare-and-set; a lost race deletes the new job ("The job changed while its rollback was being created; try again"). Refusals: "Cannot roll back a rollback job", "Cannot roll back a dry-run job: it wrote nothing", "The job has no journal: it was created before rollback support or with journal: false", "Cannot roll back a <status> job: cancel it first", "Cannot roll back the job while one of its batches is running", "The job was already rolled back (rollback job <id>)". `uploadNeeded` is false for a rollback job and for a rolled-back original, so neither keeps a staged file.
7. **Transitions.** `jobs/cancel` refuses a rollback job ("Cannot cancel a rollback job: pause it, or resume it to finish"): a half-run rollback leaves the original half restored. `jobs/resume` and `jobs/retry` refuse a rolled-back original ("Cannot resume a job that was rolled back (rollback job <id>)"). `jobs/retry` of a rollback job re-reads its `failed`, `conflict`, `locked` and `writing` rows newest first. `jobs/cancel` and a real `jobs/rollback` clear the URL source's `lastImport` when it names the job (`clearLastImport`, compare-and-set).
8. **Record rows.** A rollback row is keyed `recordKey(rollbackJobId, journal.seq)`, `start` and `end` 0, with `action` (`delete`, `trash` or `revert`, also on a conflict), `entryId`, and while `writing` the `step` and `writtenRev` it reached. A dry run plans each row as the real run would, with `planned` for what would be reverted and the changes a restore would make (`field`, `before` as now, `after` as restored), and writes nothing else.
9. **Retention.** `purgeExpired` deletes an expired job's `journal` and `journalMedia` rows with its records (`PurgeResult.journal` counts both), keeps an original whose rollback job may still run (`created`, `running`, `paused`), and keeps no staged file for a rollback job.
10. **Journal scope.** `journaling(job)` is true for a real job with `journal !== false`; rollback jobs, dry runs and `journal: false` jobs write no journal. `createJob` stores `journal: true` by default for real jobs, nothing for dry runs.
11. **Media.** After an upload with `deduplicated: false`, and before the media map row, `journalMedia` gets `{ jobId, mediaId, url, seq }` keyed `${jobId}:${mediaId}`. The rollback lists at most 100 IDs ("…, and <n> more").
12. **Integration states no API offers.** The scheduled case sets the link row's `writtenRev` through SQLite (Fact E2). The kill-and-resume of a rollback is a SIGKILL mid-batch on Node; mid-sequence it is proven in the unit suite at every step (`beforeStep` throws), because a SIGKILL cannot be aimed between two runtime calls. The workerd harness is shared, so its "forced stop mid-batch" rewinds the job's cursor and counters through `wrangler d1 execute` after a batch, which is the state a stop after the writes and before the cursor save leaves.
13. **Tests not in the spec's list, or moved.** The parity tests (Task 8) do not import images or Portable Text; Task 7 covers them. The French-before-English case uses `jobs/retry` of the refused English rollback after the French one. The spec's "a URL source re-imports after a cancelled and after a rolled-back job" is one Node test.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (162 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 61 files / 1,434 tests pass (56 / 1,370 at `a47fbc1`) |
| Task 0 (V1-V7) | V1-V4 and V6 hold, V5 holds for the amended sequence, V7 per call (Facts V1-V7), on Node and workerd with a temporary probe route and probe test, reverted afterwards |
| Task-by-task replay | from `a47fbc1` in a fresh worktree, a script parsed this document and applied Tasks 1-8 in numeric order with no failed replacement; each "see them fail" step failed and each "see them pass" step passed with the counts given in the task; typecheck, lint and `pnpm test` passed after every task; the `packages/` tree is byte-identical to the drafting tree (git tree `8b3c452`) |
| Node integration | `rollback.test.ts`: 1 file / 14 tests pass in 61 s with server start, on the replayed tree. Full `pnpm test:integration` on the drafting tree: 14 of 15 files, 92 tests passed and 1 skipped in 639.5 s; `retention.test.ts` failed in setup on port 4397 (Fact F3) |
| workerd | full `pnpm test:cf` on the drafting tree: 15 of 16 tests passed in 1,419.4 s; the M5a links test failed on the shared site's byline names (Fact E4), was fixed, and `-t "M4b links\|M5a"` then passed (3 passed, 13 skipped). Task 9 runs the full suite again |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/types.ts`, `src/engine/jobs.ts`, `src/engine/batch.ts` (counters), `src/emdash/storage.ts`, `src/plugin/definition.ts` (storage), `src/plugin/service.ts`, `src/plugin/sources.ts`, `src/plugin/routes.ts` | Journal and rollback types, `bump`, `journalKey`, `MAX_JOURNAL_BYTES`; the `journal` option, `sourceId`, transition refusals; the storage collections; `clearLastImport` on cancel (Task 1) |
| `src/engine/ports.ts`, `src/emdash/content.ts`, `tests/unit/fakes.ts` | Snapshot fields, `getIncludingTrashed`, `trash`, `permanentDelete`, `revertStep` (Task 2) |
| `src/engine/rollback-values.ts` (new) | `sameStored`, `restoredValue`, `restoredData` (Task 3) |
| `src/engine/journal.ts` (new), `src/engine/batch.ts`, `src/engine/media.ts` | Pre-images and their storage; write-ahead calls; `LinkRow.jobId`; `journalMedia` (Task 4) |
| `src/engine/rollback.ts` (new), `src/plugin/retention.ts`, `src/plugin/definition.ts` (cron), `src/plugin/service.ts`, `src/plugin/routes.ts` | Rollback jobs, refusals and warnings; retention of journals; the Workers cap; `jobs/rollback` (Task 5) |
| `src/engine/revert.ts` (new), `src/engine/resolve.ts`, `src/engine/batch.ts` | The rollback pass and its retry pass; term and byline lookups for restored links; the `runBatch` branch (Task 6) |
| `tests/integration/rollback.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 7 and 8) |

`src/engine/diff.ts`, `src/engine/links.ts`, `src/engine/template.ts`, the Portable Text modules, the source readers and `src/plugin/schema-apply.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V7 | — | nothing (results above) | — |
| 1. Types, storage, job options, transitions | — | `src/engine/{types,jobs,batch}.ts`, `src/emdash/storage.ts`, `src/plugin/{definition,service,sources,routes}.ts`, `tests/unit/{fakes,storage.test,definition.test,journal-jobs.test}.ts` | sonnet |
| 2. Ports, adapter and fakes | 1 (`tests/unit/fakes.ts` with the journal collections) | `src/engine/ports.ts`, `src/emdash/content.ts`, `tests/unit/{fakes,fakes.test,content.test}.ts` | sonnet |
| 3. Comparison and write-back | — | `src/engine/rollback-values.ts`, `tests/unit/rollback-values.test.ts` | haiku |
| 4. Journal writes | 1, 2 (`JournalEntry`, `JournalBefore`, `journalKey`, `LinkRow.jobId`, `EntrySnapshot.live`/`hasDraft`/`status`, the fakes) | `src/engine/{journal,batch,media}.ts`, `tests/unit/{journal.test,link-import.test,rollback-fixture}.ts` | opus |
| 5. Rollback jobs, retention, route, cap | 1, 4 (`Job.kind`, `rolledBackBy`, the journal rows, `tests/unit/rollback-fixture.ts`) | `src/engine/rollback.ts`, `src/plugin/{retention,definition,service,routes}.ts`, `tests/unit/{definition.test,retention.test,rollback-jobs.test}.ts` | sonnet |
| 6. Rollback pass | 2-5 (`revertStep`, `trash`, `permanentDelete`, `sameStored`, `restoredData`, the journal, `createRollback`) | `src/engine/{revert,resolve,batch}.ts`, `tests/unit/rollback.test.ts` | opus |
| 7. Node integration | 6 | `tests/integration/rollback.test.ts` | sonnet |
| 8. workerd parity | 6 | `tests/integration-cf/parity.test.ts` | sonnet |
| 9. Review run and note | 0-8 | `docs/superpowers/notes/2026-11-03-m5a-review.md`, the roadmap; temporarily a probe (reverted) | opus |

Waves: **1 ∥ 3**, then **2**, then **4**, then **5**, then **6**, then **7 ∥ 8** (separate harnesses and files), then **9**. Files touched by more than one task: `tests/unit/fakes.ts` (Tasks 1, 2), `src/engine/batch.ts` (Tasks 1, 4, 6), `src/plugin/definition.ts`, `src/plugin/service.ts`, `src/plugin/routes.ts` and `tests/unit/definition.test.ts` (Tasks 1, 5); merge in numeric order. Pass counts in each task's "Run them to see them pass" step are for the task's own unit test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the unconfirmed facts (V1-V7)

**Files:** none.

**Interfaces:**
- Consumed: the runtime handlers of spec F5-F11 and F17-F18, through a temporary probe route.
- Produced: Facts V1-V7 (above) and the spec amendment `a287d57`; the Task 9 note records the results from the Facts table.

- [x] **V1** (Node and workerd, with and without revisions): every M4a-M4d value written back as read reads back equal under Ruling 4's comparison. Passed.
- [x] **V2**: trashed entries are left out of `handleContentGet` and `fieldFilters` lists; `handleContentGetIncludingTrashed` keeps the `_rev`. Passed.
- [x] **V3**: `createdAt === updatedAt` after a create, and the read `_rev` equals the create's. Passed.
- [x] **V4**: Trash then permanent delete frees the slug and the source ID on SQLite and D1; a deleted translation leaves its source's links. Passed.
- [x] **V5**: the first sequence failed two of four pre-states; the amended one restored all four on both collections and databases (Fact V5, spec `a287d57`).
- [x] **V6**: 1 MiB of JSON in plugin storage on D1. Passed.
- [x] **V7**: per-call D1 counts recorded (Fact V7); the batch is re-measured in Task 9.

### Task 1: Types, storage, job options and transitions

**Files:**
- Modify: `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/emdash/storage.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/service.ts`, `packages/flux-import/src/plugin/sources.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/journal-jobs.test.ts`, `packages/flux-import/tests/unit/fakes.ts`, `packages/flux-import/tests/unit/storage.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: `Job`, `Counters`, `RecordRow`, `LinkRow`, `EngineDeps`, `KvCollection`; `createJob`, `transitionJob`, `updateJob`; `pluginCollections`, `STORAGE`; `uploadNeeded`; `SourceRow.lastImport`, `jobFromSource`; the `jobs/create` and transition routes.
- Produces: `Counters.reverted?`; `Job.kind?: "import" | "rollback"`, `rollbackOf?`, `rolledBackBy?`, `journal?: boolean`, `sourceId?`; `RecordStatus` with `reverted`; `RollbackAction = "delete" | "trash" | "revert"`; `RecordRow.action?: PlanAction | RollbackAction`, `RecordRow.step?: number`; `LinkRow.jobId?: string`; `JournalBefore`, `JournalEntry`, `JournalMedia`; `EngineDeps.journal`, `EngineDeps.journalMedia`; `journalKey(jobId, linkId)`, `journalMediaKey(jobId, mediaId)`, `MAX_JOURNAL_BYTES = 1024 * 1024`, `bump(counters, key, by?)`; `CreateJobInput.journal?`/`sourceId?`, exported `batchOptions`; the transition refusals of Ruling 7; `clearLastImport(deps, sourceId, jobId)`; `jobFromSource`'s `create(uploadId, sourceId)`; the storage collections `journal` and `journalMedia`; `jobs/create` accepts `journal`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/definition.test.ts`, replace
````ts
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
		expect(STORAGE.media.indexes).toEqual(["jobId", "mediaId"]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
````
with:
````ts
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
		expect(STORAGE.media.indexes).toEqual(["jobId", "mediaId"]);
		expect(STORAGE.journal.indexes).toEqual(["jobId", ["jobId", "seq"]]);
		expect(STORAGE.journalMedia.indexes).toEqual(["jobId", ["jobId", "seq"]]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type { EngineDeps, Job, LinkRow, MediaMapRow, RecordRow } from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import {
````
with:
````ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type {
	EngineDeps,
	Job,
	JournalEntry,
	JournalMedia,
	LinkRow,
	MediaMapRow,
	RecordRow,
} from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import {
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		mediaMap: new MemoryKv<MediaMapRow>(),
		content,
		lookups,
		media: new FakeMedia(),
````
with:
````ts
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		mediaMap: new MemoryKv<MediaMapRow>(),
		journal: new MemoryKv<JournalEntry>(),
		journalMedia: new MemoryKv<JournalMedia>(),
		content,
		lookups,
		media: new FakeMedia(),
````

Create `packages/flux-import/tests/unit/journal-jobs.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { batchOptions, createJob, JobError, transitionJob } from "../../src/engine/jobs.js";
import {
	bump,
	emptyCounters,
	type Job,
	journalKey,
	journalMediaKey,
} from "../../src/engine/types.js";
import { uploadNeeded } from "../../src/plugin/service.js";
import { clearLastImport, type SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv, makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];

async function setup(opts: { dryRun?: boolean; journal?: boolean; sourceId?: string } = {}) {
	const { deps } = makeDeps();
	deps.source.add("u1", "sku,Name\nS1,Desk\n");
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, ...opts });
	return { deps, job };
}

async function patch(deps: ReturnType<typeof makeDeps>["deps"], id: string, change: Partial<Job>) {
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, ...change });
}

describe("job options for the journal (M5a)", () => {
	it("keeps a journal for real runs by default, and none for dry runs", async () => {
		expect((await setup()).job.journal).toBe(true);
		expect((await setup({ journal: false })).job.journal).toBe(false);
		const dry = await setup({ dryRun: true, journal: true });
		expect(dry.job).not.toHaveProperty("journal");
	});

	it("stores the URL source the job came from", async () => {
		expect((await setup({ sourceId: "src1" })).job.sourceId).toBe("src1");
		expect((await setup()).job).not.toHaveProperty("sourceId");
	});

	it("checks and defaults the batch options", () => {
		expect(batchOptions({})).toEqual({ batchSize: 50, budgetMs: 4000 });
		expect(() => batchOptions({ batchSize: 0 })).toThrow(JobError);
		expect(() => batchOptions({ budgetMs: 100 })).toThrow("budgetMs must be an integer");
	});

	it("keys journal rows by job and link, and media by job and media ID", () => {
		expect(journalKey("j1", "products:en:S1")).toBe("j1:products:en:S1");
		expect(journalMediaKey("j1", "m1")).toBe("j1:m1");
	});

	it("counts reverted rows, which import jobs do not have", () => {
		const counters = emptyCounters();
		expect(counters).not.toHaveProperty("reverted");
		bump(counters, "reverted");
		bump(counters, "created", 2);
		bump(counters, "created", -1);
		expect(counters).toMatchObject({ reverted: 1, created: 1 });
	});
});

describe("transitions of rolled-back and rollback jobs (M5a)", () => {
	it("refuses to resume or retry a job that was rolled back", async () => {
		const { deps, job } = await setup();
		await patch(deps, job.id, { status: "failed", rolledBackBy: "rb1" });
		await expect(transitionJob(deps, job.id, "resume")).rejects.toThrow(
			"Cannot resume a job that was rolled back (rollback job rb1)",
		);
		await patch(deps, job.id, { status: "completed" });
		await expect(transitionJob(deps, job.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
		});
	});

	it("refuses to cancel a rollback job, and retries one newest first", async () => {
		const { deps, job } = await setup();
		await patch(deps, job.id, { kind: "rollback", rollbackOf: "j0" });
		await expect(transitionJob(deps, job.id, "cancel")).rejects.toThrow(
			"Cannot cancel a rollback job: pause it, or resume it to finish",
		);
		expect((await transitionJob(deps, job.id, "pause")).status).toBe("paused");
		await patch(deps, job.id, { status: "completed" });
		const retried = await transitionJob(deps, job.id, "retry");
		expect(retried).toMatchObject({
			status: "running",
			phase: "retry",
			retryFromSeq: Number.MAX_SAFE_INTEGER,
		});
	});

	it("never keeps the staged file for a rollback job or a rolled-back job", async () => {
		const { job } = await setup();
		const failed = { ...job, status: "failed" as const };
		expect(uploadNeeded(failed)).toBe(true);
		expect(uploadNeeded({ ...failed, rolledBackBy: "rb1" })).toBe(false);
		expect(uploadNeeded({ ...failed, kind: "rollback", rollbackOf: "j0" })).toBe(false);
	});
});

describe("clearLastImport (M5a)", () => {
	const row = (jobId: string): SourceRow => ({
		id: "src1",
		name: "Feed",
		url: "https://example.com/feed.csv",
		lastImport: { sha256: "abc", uploadId: "u1", jobId, at: "2026-11-03T10:00:00.000Z" },
		createdAt: "2026-11-03T10:00:00.000Z",
		updatedAt: "2026-11-03T10:00:00.000Z",
	});

	it("clears lastImport only when it names the job", async () => {
		const sources = new MemoryKv<SourceRow>();
		await sources.put("src1", row("j1"));
		await clearLastImport({ sources }, "src1", "j2");
		expect((await sources.get("src1"))?.lastImport?.jobId).toBe("j1");
		await clearLastImport({ sources }, "src1", "j1");
		expect(await sources.get("src1")).not.toHaveProperty("lastImport");
		await clearLastImport({ sources }, "missing", "j1");
	});
});
````

In `packages/flux-import/tests/unit/storage.test.ts`, replace
````ts
});

describe("pluginCollections", () => {
	it("requires the jobs, records, links and media collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s, links: s })).toThrow(
			"storage collections",
		);
		expect(Object.keys(pluginCollections({ jobs: s, records: s, links: s, media: s }))).toEqual([
			"jobs",
			"records",
			"links",
			"mediaMap",
		]);
	});
});
````
with:
````ts
});

describe("pluginCollections", () => {
	it("requires the jobs, records, links, media, journal and journalMedia collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s, links: s, media: s })).toThrow(
			"storage collections",
		);
		expect(
			Object.keys(
				pluginCollections({
					jobs: s,
					records: s,
					links: s,
					media: s,
					journal: s,
					journalMedia: s,
				}),
			),
		).toEqual(["jobs", "records", "links", "mediaMap", "journal", "journalMedia"]);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/journal-jobs.test.ts tests/unit/storage.test.ts`
Expected: FAIL (3 files; 11 tests failed, 14 passed: the journal collections, the `journal` option, `sourceId` and the transition refusals do not exist yet).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/storage.ts`, replace
````ts
import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type { Job, LinkRow, MediaMapRow, RecordRow } from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;
````
with:
````ts
import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type {
	Job,
	JournalEntry,
	JournalMedia,
	LinkRow,
	MediaMapRow,
	RecordRow,
} from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;
````

In `packages/flux-import/src/emdash/storage.ts`, replace
````ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
}

/** The engine's collections declared in the plugin definition (`media` is the media map), typed. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links, media } = storage;
	if (!jobs || !records || !links || !media) {
		throw new Error(
			"flux-import: the jobs, records, links and media storage collections are missing",
		);
	}
	return {
````
with:
````ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	journal: KvCollection<JournalEntry>;
	journalMedia: KvCollection<JournalMedia>;
}

/** The engine's collections declared in the plugin definition (`media` is the media map), typed. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links, media, journal, journalMedia } = storage;
	if (!jobs || !records || !links || !media || !journal || !journalMedia) {
		throw new Error(
			"flux-import: the jobs, records, links, media, journal and journalMedia storage collections are missing",
		);
	}
	return {
````

In `packages/flux-import/src/emdash/storage.ts`, replace
````ts
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
		mediaMap: kvCollection<MediaMapRow>(media),
	};
}
````
with:
````ts
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
		mediaMap: kvCollection<MediaMapRow>(media),
		journal: kvCollection<JournalEntry>(journal),
		journalMedia: kvCollection<JournalMedia>(journalMedia),
	};
}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	SOURCE_ID_FIELD,
} from "./template.js";
import {
	type Counters,
	capErrors,
	capWarnings,
````
with:
````ts
	SOURCE_ID_FIELD,
} from "./template.js";
import {
	bump,
	type Counters,
	capErrors,
	capWarnings,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor and counters.
		const counter = counterFor(existing);
		if (counter) job.counters[counter]++;
		return;
	}
````
with:
````ts
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor and counters.
		const counter = counterFor(existing);
		if (counter) bump(job.counters, counter);
		return;
	}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) job.counters[old]--;
	}
	const counter = counterFor(row);
	if (counter) job.counters[counter]++;
}

/** What the write helpers need about the record being processed. */
````
with:
````ts
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
}

/** What the write helpers need about the record being processed. */
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: PlanAction | undefined,
	writtenRev: string | undefined,
): RowFields {
	return {
````
with:
````ts
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: RecordRow["action"],
	writtenRev: string | undefined,
): RowFields {
	return {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		});
		for (const { data } of page.items) {
			const counter = counterFor(data);
			if (counter) counters[counter]++;
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
````
with:
````ts
		});
		for (const { data } of page.items) {
			const counter = counterFor(data);
			if (counter) bump(counters, counter);
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	publish?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
````
with:
````ts
	publish?: boolean;
	batchSize?: number;
	budgetMs?: number;
	/** Keep a journal so the job can be rolled back (M5a); a real run only, default true. */
	journal?: boolean;
	/** The URL source the job's file was fetched from (M5a). */
	sourceId?: string;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
const BUDGET_MS_MAX = 25_000;
const CAS_ATTEMPTS = 5;

export async function createJob(deps: EngineDeps, input: CreateJobInput): Promise<Job> {
	const batchSize = input.batchSize ?? BATCH_SIZE_DEFAULT;
	const budgetMs = input.budgetMs ?? BUDGET_MS_DEFAULT;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE_MAX) {
````
with:
````ts
const BUDGET_MS_MAX = 25_000;
const CAS_ATTEMPTS = 5;

/** The batch size and budget, defaulted and checked (`invalid_options`). */
export function batchOptions(input: { batchSize?: number; budgetMs?: number }): {
	batchSize: number;
	budgetMs: number;
} {
	const batchSize = input.batchSize ?? BATCH_SIZE_DEFAULT;
	const budgetMs = input.budgetMs ?? BUDGET_MS_DEFAULT;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE_MAX) {
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
			`budgetMs must be an integer from ${BUDGET_MS_MIN} to ${BUDGET_MS_MAX}`,
		);
	}

	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
````
with:
````ts
			`budgetMs must be an integer from ${BUDGET_MS_MIN} to ${BUDGET_MS_MAX}`,
		);
	}
	return { batchSize, budgetMs };
}

export async function createJob(deps: EngineDeps, input: CreateJobInput): Promise<Job> {
	const { batchSize, budgetMs } = batchOptions(input);

	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	const sharedRequired = sharedRequiredOf(template, input.schemaFields);

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
		id: deps.newId(),
		status: "created",
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
		dryRun: input.dryRun ?? false,
		publish: input.publish ?? true,
		batchSize,
		budgetMs,
````
with:
````ts
	const sharedRequired = sharedRequiredOf(template, input.schemaFields);

	const now = new Date(deps.now()).toISOString();
	const dryRun = input.dryRun ?? false;
	const job: Job = {
		id: deps.newId(),
		status: "created",
		// A dry run writes nothing, so it keeps no journal.
		...(dryRun ? {} : { journal: input.journal ?? true }),
		...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
		dryRun,
		publish: input.publish ?? true,
		batchSize,
		budgetMs,
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
				`Cannot ${action} a ${job.status}${job.dryRun ? " dry-run" : ""} job`,
			);
		}
		switch (action) {
			case "pause":
				return { ...job, status: "paused" };
````
with:
````ts
				`Cannot ${action} a ${job.status}${job.dryRun ? " dry-run" : ""} job`,
			);
		}
		const rollback = job.kind === "rollback";
		if (action === "cancel" && rollback) {
			// Rows it reverted no longer match the original's links, so it could not start over.
			throw new JobError(
				"invalid_transition",
				"Cannot cancel a rollback job: pause it, or resume it to finish",
			);
		}
		if ((action === "resume" || action === "retry") && job.rolledBackBy !== undefined) {
			throw new JobError(
				"invalid_transition",
				`Cannot ${action} a job that was rolled back (rollback job ${job.rolledBackBy})`,
			);
		}
		switch (action) {
			case "pause":
				return { ...job, status: "paused" };
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
			case "cancel":
				return { ...withoutPlannedTerms(job), status: "cancelled" };
			case "retry":
				return { ...job, status: "running", phase: "retry", retryFromSeq: 0, error: null };
		}
	});
}
````
with:
````ts
			case "cancel":
				return { ...withoutPlannedTerms(job), status: "cancelled" };
			case "retry":
				// A rollback retries its rows newest first, like its first pass.
				return {
					...job,
					status: "running",
					phase: "retry",
					retryFromSeq: rollback ? Number.MAX_SAFE_INTEGER : 0,
					error: null,
				};
		}
	});
}
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	failed: number;
	/** Records the template's filter skipped. Absent on jobs created before M3b (read as 0). */
	filtered: number;
}

/** A term a dry run plans to create, kept on the job so later batches see it. */
````
with:
````ts
	failed: number;
	/** Records the template's filter skipped. Absent on jobs created before M3b (read as 0). */
	filtered: number;
	/** Rollback jobs: rows reverted, or that a dry run would revert. Absent on imports (read as 0). */
	reverted?: number;
}

/** A term a dry run plans to create, kept on the job so later batches see it. */
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
export interface Job {
	id: string;
	status: JobStatus;
	uploadId: string;
	template: Template;
	dryRun: boolean;
````
with:
````ts
export interface Job {
	id: string;
	status: JobStatus;
	/** `rollback` for a rollback job (M5a); absent for an import job. */
	kind?: "import" | "rollback";
	/** A rollback job: the import job it rolls back. */
	rollbackOf?: string;
	/** An import job: the real rollback job created for it; it can no longer be resumed or retried. */
	rolledBackBy?: string;
	/**
	 * A real import job keeps a journal of what it changes, so it can be rolled back (M5a). Absent
	 * on dry runs and on jobs created before M5a, which have no journal.
	 */
	journal?: boolean;
	/** An import job created from a URL source: the source's ID (M5a). */
	sourceId?: string;
	uploadId: string;
	template: Template;
	dryRun: boolean;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	| "conflict"
	| "failed"
	| "planned"
	| "filtered";

export interface RecordError {
	field?: string;
````
with:
````ts
	| "conflict"
	| "failed"
	| "planned"
	| "filtered"
	| "reverted";

/** What a rollback row does to its entry (M5a). */
export type RollbackAction = "delete" | "trash" | "revert";

export interface RecordError {
	field?: string;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	status: RecordStatus;
	sourceKey: string | null;
	entryId: string | null;
	action?: PlanAction;
	changes?: Change[];
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
````
with:
````ts
	status: RecordStatus;
	sourceKey: string | null;
	entryId: string | null;
	action?: PlanAction | RollbackAction;
	changes?: Change[];
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	 * `MAX_RECORD_WARNINGS`. Absent when there are none.
	 */
	warnings?: RecordError[];
	updatedAt: string;
}
````
with:
````ts
	 * `MAX_RECORD_WARNINGS`. Absent when there are none.
	 */
	warnings?: RecordError[];
	/** Rollback rows: the last revert step done (M5a); absent before the first. */
	step?: number;
	updatedAt: string;
}
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	 * published, else the write's). A pending draft at any other revision is not the importer's.
	 */
	writtenRev?: string;
}

/**
````
with:
````ts
	 * published, else the write's). A pending draft at any other revision is not the importer's.
	 */
	writtenRev?: string;
	/** The job that produced `writtenRev` (M5a); absent on links saved before M5a. */
	jobId?: string;
}

/** The pre-image of an entry a job updated (M5a): what the entry held before its first write. */
export interface JournalBefore {
	/** The link row before the job; null when there was none. */
	link: { jobId?: string; writtenRev?: string } | null;
	status: string;
	scheduledAt: string | null;
	/** The live slug, when the job changed the slug. */
	slug?: string | null;
	/** Live values of the fields the job changed or published. */
	live: Record<string, unknown>;
	/** The pending draft's values of the same fields, when the entry had a draft. */
	draft?: Record<string, unknown>;
	links?: {
		/** Term translation groups, by taxonomy. */
		taxonomies?: Record<string, string[]>;
		/** Target entry IDs, by reference field. */
		references?: Record<string, string[]>;
		bylines?: { bylineId: string; roleLabel: string | null }[];
	};
}

/**
 * One entry a real job wrote (plugin storage `journal`, keyed `journalKey(jobId, linkKey)`),
 * written before the job's first write to it.
 */
export interface JournalEntry {
	jobId: string;
	/** The record that first touched the entry; rollback order. */
	seq: number;
	collection: string;
	locale: string;
	sourceKey: string;
	kind: "create" | "update";
	/** null until a create returns. */
	entryId: string | null;
	/** create: this job's create call returned `entryId` (not found by crash repair). */
	confirmed?: boolean;
	/** create: the `flux_source_id` the create sends (the translationOf value for a linked create). */
	sourceIdValue?: string;
	/** update only. */
	before?: JournalBefore;
	/** ISO time of the write-ahead put. */
	at: string;
}

/** A media item a job's upload created (plugin storage `journalMedia`, `journalMediaKey`). */
export interface JournalMedia {
	jobId: string;
	mediaId: string;
	url: string;
	seq: number;
}

/**
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	content: ContentPort;
	lookups: LookupPort;
	media: MediaPort;
````
with:
````ts
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	journal: KvCollection<JournalEntry>;
	journalMedia: KvCollection<JournalMedia>;
	content: ContentPort;
	lookups: LookupPort;
	media: MediaPort;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	return `${collection}:${locale}:${sourceKey}`;
}

/** Warnings kept on one record row. */
export const MAX_RECORD_WARNINGS = 20;
/** Errors kept on one record row, so that no producer can make a row too large to store. */
````
with:
````ts
	return `${collection}:${locale}:${sourceKey}`;
}

/** The journal row of the entry a link names, for one job (M5a). */
export function journalKey(jobId: string, linkId: string): string {
	return `${jobId}:${linkId}`;
}

export function journalMediaKey(jobId: string, mediaId: string): string {
	return `${jobId}:${mediaId}`;
}

/** The largest journal row, in bytes of JSON (M5a); D1 stores more (spec V6). */
export const MAX_JOURNAL_BYTES = 1024 * 1024;

/** Adds `by` to a counter; `reverted` is absent on import jobs. */
export function bump(counters: Counters, key: keyof Counters, by = 1): void {
	counters[key] = (counters[key] ?? 0) + by;
}

/** Warnings kept on one record row. */
export const MAX_RECORD_WARNINGS = 20;
/** Errors kept on one record row, so that no producer can make a row too large to store. */
````

In `packages/flux-import/src/plugin/definition.ts`, replace
````ts
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it. `media` is the site-wide media map; its
 * `jobId` and `mediaId` indexes let a job's own media be listed (M5 rollback, audit).
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
````
with:
````ts
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it. `media` is the site-wide media map; its
 * `jobId` and `mediaId` indexes let a job's own media be listed (M5 rollback, audit).
 * `journal` holds what each real job changed, one row per (job, entry), read newest first by a
 * rollback (`["jobId", "seq"]`); `journalMedia` the media items each job's uploads created (M5a).
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
````

In `packages/flux-import/src/plugin/definition.ts`, replace
````ts
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
````
with:
````ts
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
	journal: { indexes: ["jobId", ["jobId", "seq"]] },
	journalMedia: { indexes: ["jobId", ["jobId", "seq"]] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
	type UploadKeeper,
} from "./service.js";
import {
	createSource,
	deleteSource,
	fetchSource,
````
with:
````ts
	type UploadKeeper,
} from "./service.js";
import {
	clearLastImport,
	createSource,
	deleteSource,
	fetchSource,
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
		publish: z.boolean().optional(),
		batchSize: z.number().int().optional(),
		budgetMs: z.number().int().optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of uploadId and sourceId",
````
with:
````ts
		publish: z.boolean().optional(),
		batchSize: z.number().int().optional(),
		budgetMs: z.number().int().optional(),
		/** Keep a journal so the job can be rolled back (M5a); default true. */
		journal: z.boolean().optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of uploadId and sourceId",
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, keep }) =>
			changeJob(deps, uploads, ctx.input.id, action, keep).then(withoutPlannedTerms),
		),
	);
}
````
with:
````ts

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, async ({ deps, uploads, keep, sources }) => {
			const job = await changeJob(deps, uploads, ctx.input.id, action, keep);
			// A cancelled job no longer makes its source skip the next import of the same content.
			if (action === "cancel" && job.sourceId !== undefined) {
				await clearLastImport(sources, job.sourceId, job.id).catch(() => {});
			}
			return withoutPlannedTerms(job);
		}),
	);
}
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
			const { input } = ctx;
			// Read once here and stored on the job, so a resumed or retried job converts the same way.
			const siteTimezone = needsSiteTimezone(input.template) ? await readSiteTimezone() : undefined;
			const start = (upload: string) => {
				const options: StartJobInput = {
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
````
with:
````ts
			const { input } = ctx;
			// Read once here and stored on the job, so a resumed or retried job converts the same way.
			const siteTimezone = needsSiteTimezone(input.template) ? await readSiteTimezone() : undefined;
			const start = (upload: string, fromSource?: string) => {
				const options: StartJobInput = {
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					...(fromSource === undefined ? {} : { sourceId: fromSource }),
					...(input.journal === undefined ? {} : { journal: input.journal }),
					mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
````

In `packages/flux-import/src/plugin/service.ts`, replace
````ts
	return upgradeJob(job);
}

/** Whether a job may still read its staged file (resume, retry, or a real run after a dry run). */
export function uploadNeeded(job: Job): boolean {
	switch (job.status) {
		case "cancelled":
			return false;
````
with:
````ts
	return upgradeJob(job);
}

/**
 * Whether a job may still read its staged file (resume, retry, or a real run after a dry run).
 * A rollback job never reads it, and a rolled-back job can no longer be resumed or retried.
 */
export function uploadNeeded(job: Job): boolean {
	if (job.kind === "rollback" || job.rolledBackBy !== undefined) return false;
	switch (job.status) {
		case "cancelled":
			return false;
````

In `packages/flux-import/src/plugin/sources.ts`, replace
````ts
	}
}

/**
 * `jobs/create` with a `sourceId`: fetches first (conditional GET and hash decide whether a new
 * copy is staged), then skips the job only for a real run without `force` whose content equals
````
with:
````ts
	}
}

/**
 * Clears the source's `lastImport` when it names `jobId`, so the next import of the same content
 * runs: the job was cancelled or rolled back (M5a). Best effort, like `recordImport`; a missing
 * source is left alone.
 */
export async function clearLastImport(
	deps: Pick<SourceDeps, "sources">,
	sourceId: string,
	jobId: string,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.sources.getVersioned(sourceId);
		if (!current || current.value.lastImport?.jobId !== jobId) return;
		const { lastImport: _last, ...rest } = current.value;
		const result = await deps.sources.compareAndSet(sourceId, current.revision, rest);
		if (result.applied) return;
	}
}

/**
 * `jobs/create` with a `sourceId`: fetches first (conditional GET and hash decide whether a new
 * copy is staged), then skips the job only for a real run without `force` whose content equals
````

In `packages/flux-import/src/plugin/sources.ts`, replace
````ts
	deps: SourceDeps,
	sourceId: string,
	options: { force: boolean; dryRun: boolean },
	create: (uploadId: string) => Promise<Job>,
): Promise<Job | SkippedJob> {
	const fetched = await fetchSource(deps, sourceId, options.force);
	const source = await getSource(deps, sourceId);
	if (!options.force && !options.dryRun && source.lastImport?.sha256 === fetched.sha256) {
		return { skipped: "unchanged", sourceId, uploadId: fetched.uploadId };
	}
	const job = await create(fetched.uploadId);
	if (!options.dryRun) {
		// Best effort: the job exists, so a storage error here must not fail the request (a retry
		// would create a second job).
````
with:
````ts
	deps: SourceDeps,
	sourceId: string,
	options: { force: boolean; dryRun: boolean },
	create: (uploadId: string, sourceId: string) => Promise<Job>,
): Promise<Job | SkippedJob> {
	const fetched = await fetchSource(deps, sourceId, options.force);
	const source = await getSource(deps, sourceId);
	if (!options.force && !options.dryRun && source.lastImport?.sha256 === fetched.sha256) {
		return { skipped: "unchanged", sourceId, uploadId: fetched.uploadId };
	}
	const job = await create(fetched.uploadId, sourceId);
	if (!options.dryRun) {
		// Best effort: the job exists, so a storage error here must not fail the request (a retry
		// would create a second job).
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/journal-jobs.test.ts tests/unit/storage.test.ts`
Expected: PASS (3 files, 25 tests). Full suite after this task: 57 files / 1,379 tests (56 / 1,370 at `a47fbc1`).

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src packages/flux-import/tests/unit
git commit -m "Add the M5a journal and rollback types, the journal storage collections, the journal job option and the rollback transition rules"
```

### Task 2: Ports, adapter and fakes

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/emdash/content.ts`
- Test: `packages/flux-import/tests/unit/fakes.ts`, `packages/flux-import/tests/unit/fakes.test.ts`, `packages/flux-import/tests/unit/content.test.ts`

**Interfaces:**
- Consumes: Task 1's fakes (the journal collections in `makeDeps`); `ContentRuntime`, `itemResult`, `snapshotOf`, `HandlerResult`; the runtime handlers `handleContentGetIncludingTrashed`, `handleContentDelete`, `handleContentPermanentDelete`, `handleContentPublish`, `handleContentUnpublish`, `handleContentSchedule`, `handleContentDiscardDraft` (spec F6-F11, F18).
- Produces: `EntrySnapshot.status`, `scheduledAt`, `hasDraft`, `live?` (the live values when a draft exists, spec F5), `createdAt?`, `updatedAt?`; `EntryState`; `StepResult` (`{ ok: true; state }` or `{ ok: false; reason: "conflict" | "blocked"; message }`); `RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule"`; `ContentPort.getIncludingTrashed(collection, locale, id)`, `trash(collection, id)` (`ok`, `blocked` with the hook's message, `not_found`), `permanentDelete(collection, id): Promise<boolean>`, `revertStep(input)`; in the fakes: `status`, `scheduledAt`, `live`, `trashed`, `createdAt`/`updatedAt` per entry, `plainCollections`, `blockDelete`, `blockStep`, `beforeStep`, `now`, revisioned updates that stage `live`, publish that clears `live` and `scheduledAt`, trashed entries hidden from `get`, `findBySourceId` and `translations`.

- [ ] **Step 1: Write the failing tests and the fakes**

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
	status: string;
	locale: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	version: number;
};

const ok = (data: unknown): HandlerResult => ({ success: true, data });
const fail = (code: string, message = code): HandlerResult => ({
	success: false,
````
with:
````ts
	status: string;
	locale: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	version: number;
	scheduledAt?: string | null;
	deletedAt?: string | null;
	liveData?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
};

const ok = (data: unknown): HandlerResult => ({ success: true, data });
const fail = (code: string, message = code): HandlerResult => ({
	success: false,
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
	readonly items = new Map<string, Item>();
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	/** What handleContentTranslations answers. */
	translationsResult: HandlerResult = fail("NOT_FOUND", "Content item not found");
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;

	private envelope(item: Item) {
		return ok({ item: { ...item, authorId: null }, _rev: `rev-${item.version}` });
````
with:
````ts
	readonly items = new Map<string, Item>();
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	/** What handleContentTranslations answers. */
	translationsResult: HandlerResult = fail("NOT_FOUND", "Content item not found");
	/** When set, what the next rollback handler (delete, unpublish, schedule, discard) answers. */
	stepOverride: HandlerResult | null = null;
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;

	private envelope(item: Item) {
		return ok({ item: { ...item, authorId: null }, _rev: `rev-${item.version}` });
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
	}
	async handleContentTranslations(collection: string, id: string) {
		this.calls.push(["translations", collection, id]);
		return this.translationsResult;
	}
}

const actor = { id: "u1", role: 50 };

function setup(locked: (c: string, id: string, user: string) => boolean = () => false) {
````
with:
````ts
	}
	async handleContentTranslations(collection: string, id: string) {
		this.calls.push(["translations", collection, id]);
		return this.translationsResult;
	}
	private override(): HandlerResult | null {
		const result = this.stepOverride;
		this.stepOverride = null;
		return result;
	}
	async handleContentGetIncludingTrashed(collection: string, id: string, locale?: string) {
		this.calls.push(["getTrashed", collection, id, locale]);
		const item = this.items.get(id);
		return item ? this.envelope(item) : fail("NOT_FOUND");
	}
	async handleContentDelete(collection: string, id: string) {
		this.calls.push(["delete", collection, id]);
		const forced = this.override();
		if (forced) return forced;
		const item = this.items.get(id);
		if (!item || item.deletedAt) return fail("NOT_FOUND");
		item.deletedAt = "2026-11-03T10:00:00.000Z";
		return ok({ deleted: true, id });
	}
	async handleContentPermanentDelete(collection: string, id: string) {
		this.calls.push(["permanentDelete", collection, id]);
		const item = this.items.get(id);
		if (!item?.deletedAt) return fail("NOT_FOUND");
		this.items.delete(id);
		return ok({ deleted: true, id });
	}
	private step(id: string, options: Record<string, unknown>, change: (item: Item) => void) {
		const forced = this.override();
		if (forced) return forced;
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (options._rev !== `rev-${item.version}`) return fail("CONFLICT", "stale");
		change(item);
		item.version++;
		return this.envelope(item);
	}
	async handleContentUnpublish(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["unpublish", collection, id, options]);
		return this.step(id, options, (item) => {
			item.status = "draft";
			item.draftRevisionId = "from-live";
		});
	}
	async handleContentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["schedule", collection, id, scheduledAt, options]);
		return this.step(id, options, (item) => {
			item.scheduledAt = scheduledAt;
			if (item.status !== "published") item.status = "scheduled";
		});
	}
	async handleContentDiscardDraft(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["discard", collection, id, options]);
		return this.step(id, options, (item) => {
			item.draftRevisionId = null;
		});
	}
}

const actor = { id: "u1", role: 50 };

function setup(locked: (c: string, id: string, user: string) => boolean = () => false) {
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
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
````
with:
````ts
			{ id: "e2", locale: "fr" },
		]);
		expect(runtime.calls.at(-1)).toEqual(["translations", "products", "e2"]);
	});

	it("reports other translation read errors and bad responses as ContentWriteError (M4e)", async () => {
		const { runtime, content } = setup();
		runtime.translationsResult = fail("INTERNAL_ERROR", "boom");
		const failed = await content.translations("products", "e1").catch((e: unknown) => e);
		expect(failed).toBeInstanceOf(ContentWriteError);
		expect(failed).toMatchObject({
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
		await expect(content.translations("products", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});
````
with:
````ts
		await expect(content.translations("products", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});

describe("EmDashContent for rollbacks (M5a)", () => {
	it("reads status, schedule, draft, live data and timestamps into the snapshot", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const item = runtime.items.get("e1") as Item;
		Object.assign(item, {
			status: "published",
			draftRevisionId: "d1",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			liveData: { title: "Live" },
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-02T00:00:00.000Z",
		});
		expect(await content.get("products", "en", "e1")).toMatchObject({
			status: "published",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			hasDraft: true,
			pendingPublish: true,
			live: { title: "Live" },
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-02T00:00:00.000Z",
		});
		item.draftRevisionId = null;
		const plain = await content.get("products", "en", "e1");
		expect(plain).toMatchObject({ hasDraft: false, pendingPublish: false });
		expect(plain).not.toHaveProperty("live");
		expect(plain).not.toHaveProperty("trashed");
	});

	it("reads a trashed entry, moves entries to Trash and deletes trashed ones", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(await content.trash("products", "e1")).toEqual({ ok: true });
		expect(await content.getIncludingTrashed("products", "en", "e1")).toMatchObject({
			id: "e1",
			rev: "rev-1",
			trashed: true,
		});
		expect(await content.getIncludingTrashed("products", "fr", "e1")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", "nope")).toBeNull();
		expect(await content.trash("products", "e1")).toEqual({
			ok: false,
			reason: "not_found",
			message: "NOT_FOUND",
		});
		runtime.stepOverride = fail("DELETE_BLOCKED", "Delete blocked by plugin hook");
		expect(await content.trash("products", "e1")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Delete blocked by plugin hook",
		});
		expect(await content.permanentDelete("products", "e1")).toBe(true);
		expect(await content.permanentDelete("products", "e1")).toBe(false);
		runtime.stepOverride = fail("CONTENT_DELETE_ERROR", "boom");
		await expect(content.trash("products", "e2")).rejects.toMatchObject({
			code: "emdash_content_delete_error",
		});
	});

	it("runs each revert step with the revision and reports the entry's state", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const base = { collection: "products", locale: "en", id: "e1" };
		const updated = await content.revertStep({
			...base,
			rev: "rev-1",
			step: "update",
			data: { title: "B" },
			slug: "b",
			taxonomies: { tag: ["new"] },
		});
		expect(updated).toEqual({
			ok: true,
			state: { rev: "rev-2", status: "draft", scheduledAt: null, hasDraft: true },
		});
		expect(runtime.calls.at(-1)).toEqual([
			"update",
			"products",
			"e1",
			{
				data: { title: "B" },
				locale: "en",
				_rev: "rev-1",
				actor,
				slug: "b",
				taxonomies: { tag: ["new"] },
			},
		]);
		const published = await content.revertStep({ ...base, rev: "rev-2", step: "publish" });
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		expect(runtime.calls.at(-1)).toEqual(["publish", "products", "e1", { _rev: "rev-2", actor }]);
		const unpublished = await content.revertStep({ ...base, rev: "rev-3", step: "unpublish" });
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		const discarded = await content.revertStep({ ...base, rev: "rev-4", step: "discard" });
		expect(discarded).toMatchObject({ ok: true, state: { rev: "rev-5", hasDraft: false } });
		expect(runtime.calls.at(-1)).toEqual(["discard", "products", "e1", { _rev: "rev-4" }]);
		const at = "2026-12-01T00:00:00.000Z";
		const scheduled = await content.revertStep({
			...base,
			rev: "rev-5",
			step: "schedule",
			scheduledAt: at,
		});
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at },
		});
		expect(runtime.calls.at(-1)).toEqual([
			"schedule",
			"products",
			"e1",
			at,
			{ _rev: "rev-5", actor },
		]);
	});

	it("maps a stale revision to conflict and hook refusals to blocked", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const base = { collection: "products", locale: "en", id: "e1" };
		expect(await content.revertStep({ ...base, rev: "stale", step: "update", data: {} })).toEqual({
			ok: false,
			reason: "conflict",
			message: "version conflict",
		});
		for (const code of ["PUBLISH_REJECTED", "UNPUBLISH_REJECTED", "SCHEDULE_REJECTED"]) {
			runtime.stepOverride = fail(code, "Not on Fridays");
			expect(await content.revertStep({ ...base, rev: "rev-1", step: "unpublish" })).toEqual({
				ok: false,
				reason: "blocked",
				message: "Not on Fridays",
			});
		}
		runtime.stepOverride = fail("VALIDATION_ERROR", "Scheduled date must be in the future");
		await expect(
			content.revertStep({ ...base, rev: "rev-1", step: "schedule", scheduledAt: "x" }),
		).rejects.toMatchObject({ code: "emdash_validation_error" });
	});
});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		await expect(create(source.id)).rejects.toMatchObject({ code: "emdash_conflict" });
	});
});
````
with:
````ts
		await expect(create(source.id)).rejects.toMatchObject({ code: "emdash_conflict" });
	});
});

describe("FakeContent for rollbacks (M5a)", () => {
	const at = (ms: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + ms).toISOString();
	function setup() {
		const clock = { t: Date.parse("2026-10-07T10:00:00Z") };
		const content = new FakeContent();
		content.now = () => clock.t;
		return { content, clock };
	}
	const base = { collection: "products", locale: "en" };

	it("stamps creates and writes, and stages drafts only on collections with revisions", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "draft",
			scheduledAt: null,
			hasDraft: false,
			createdAt: at(0),
			updatedAt: at(0),
		});
		clock.t += 1000;
		await content.publish({ id, rev: "1" });
		await content.update({ id, rev: "2", data: { title: "B" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
			live: { title: "A" },
			data: { title: "B" },
			updatedAt: at(1000),
		});
		await content.update({ id, rev: "3", taxonomies: { tag: ["new"] } });
		expect((await content.get("products", "en", id))?.live).toEqual({ title: "A" });

		content.plainCollections.add("plain");
		const plain = await content.create({ ...base, collection: "plain", data: { title: "A" } });
		await content.publish({ id: plain.id, rev: "1" });
		await content.update({ id: plain.id, rev: "2", data: { title: "B" } });
		expect(await content.get("plain", "en", plain.id)).toMatchObject({
			hasDraft: false,
			pendingPublish: false,
			data: { title: "B" },
		});
	});

	it("moves entries to Trash, hides them from reads and deletes them for good", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: { flux_source_id: "K" } });
		content.blockDelete = () => "Not today";
		expect(await content.trash("products", id)).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not today",
		});
		content.blockDelete = () => null;
		expect(await content.permanentDelete("products", id)).toBe(false);
		expect(await content.trash("products", id)).toEqual({ ok: true });
		expect(await content.get("products", "en", id)).toBeNull();
		expect(await content.findBySourceId("products", "en", "K")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", id)).toMatchObject({
			rev: "1",
			trashed: true,
		});
		expect((await content.trash("products", id)).ok).toBe(false);
		expect(await content.permanentDelete("products", id)).toBe(true);
		expect(content.entries.has(id)).toBe(false);
	});

	it("runs revert steps with revision checks, hook refusals and EmDash's draft rules", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const step = (rev: string, s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({ ...base, id, rev, step: s, ...extra });
		expect(await step("9", "publish")).toMatchObject({ ok: false, reason: "conflict" });
		const published = await step("1", "publish");
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		const unpublished = await step("2", "unpublish");
		// As EmDash: the unpublish creates a draft from the live revision (spec M5a F18).
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		expect(await step("3", "discard")).toMatchObject({ ok: true, state: { hasDraft: false } });
		await expect(step("4", "schedule", { scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		const scheduled = await step("4", "schedule", { scheduledAt: at(60_000) });
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at(60_000) },
		});
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		expect(await step("5", "publish")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not on Fridays",
		});
		const updated = await step("5", "update", { data: { title: "B" }, slug: "b" });
		expect(updated).toMatchObject({ ok: true, state: { hasDraft: true } });
		expect(content.entries.get(id)).toMatchObject({ slug: "b", data: { title: "B" } });
	});
});
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	type MediaInfo,
	type MediaPort,
	type MediaUploadError,
	SourceMissingError,
	type SourcePort,
	type TaxonomyDef,
	type TermInfo,
	type Where,
````
with:
````ts
	type MediaInfo,
	type MediaPort,
	type MediaUploadError,
	type RevertStep,
	SourceMissingError,
	type SourcePort,
	type StepResult,
	type TaxonomyDef,
	type TermInfo,
	type Where,
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	taxonomies: Record<string, string[]>;
	references: Record<string, string[]>;
	bylines: { bylineId: string; roleLabel: string | null }[];
};

export class FakeContent implements ContentPort {
````
with:
````ts
	taxonomies: Record<string, string[]>;
	references: Record<string, string[]>;
	bylines: { bylineId: string; roleLabel: string | null }[];
	/** M5a: `draft`, `scheduled` or `published`, and the schedule. */
	status: string;
	scheduledAt: string | null;
	/**
	 * M5a: the live data and slug while a draft revision is pending (on a collection with
	 * revisions, a write staged after the entry's columns); null without one. `data` and `slug`
	 * always hold the latest values, the draft's included.
	 */
	live: { data: Record<string, unknown>; slug: string | null } | null;
	trashed: boolean;
	createdAt: string;
	updatedAt: string;
};

export class FakeContent implements ContentPort {
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	 * source, as EmDash does (spec M4e F1).
	 */
	readonly sharedFields = new Set<string>(["flux_source_id"]);
	private next = 0;

	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
````
with:
````ts
	 * source, as EmDash does (spec M4e F1).
	 */
	readonly sharedFields = new Set<string>(["flux_source_id"]);
	/** M5a: collections without revisions, whose writes go straight to the live columns. */
	readonly plainCollections = new Set<string>();
	/** M5a: return a message to make a `content:beforeDelete` hook refuse the trash. */
	blockDelete: (id: string) => string | null = () => null;
	/** M5a: return a message to make a policy hook refuse a publish, unpublish or schedule. */
	blockStep: (step: RevertStep, id: string) => string | null = () => null;
	/** M5a: called at the start of every rollback step; throw from it to simulate a crash. */
	beforeStep: (step: RevertStep | "trash" | "delete", id: string) => void = () => {};
	/** The clock for timestamps and schedules; `makeDeps` gives it the test clock. */
	now: () => number = () => Date.parse("2026-10-07T10:00:00Z");
	private next = 0;

	private stamp(): string {
		return new Date(this.now()).toISOString();
	}

	/** A write that changes the row: a new revision and `updatedAt`. */
	private touch(e: StoredEntry): void {
		e.rev++;
		e.updatedAt = this.stamp();
	}

	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
			data: structuredClone(e.data),
			group: e.group,
			pendingPublish: e.pendingPublish,
			...(options.references
				? {
						references: Object.fromEntries(
````
with:
````ts
			data: structuredClone(e.data),
			group: e.group,
			pendingPublish: e.pendingPublish,
			status: e.status,
			scheduledAt: e.scheduledAt,
			hasDraft: e.live !== null,
			...(e.live ? { live: structuredClone(e.live.data) } : {}),
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			...(options.references
				? {
						references: Object.fromEntries(
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	}
	async get(collection: string, locale: string, id: string, options?: GetOptions) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale ? this.snap(e, options) : null;
	}
	async findBySourceId(collection: string, locale: string, sourceId: string, options?: GetOptions) {
		this.calls.push(`find:${sourceId}`);
````
with:
````ts
	}
	async get(collection: string, locale: string, id: string, options?: GetOptions) {
		const e = this.entries.get(id);
		return e && !e.trashed && e.collection === collection && e.locale === locale
			? this.snap(e, options)
			: null;
	}
	async getIncludingTrashed(collection: string, locale: string, id: string) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale
			? { ...this.snap(e, { references: true }), trashed: e.trashed }
			: null;
	}
	async trash(_collection: string, id: string) {
		this.beforeStep("trash", id);
		const e = this.entries.get(id);
		if (!e || e.trashed) return { ok: false as const, reason: "not_found" as const, message: "" };
		const blocked = this.blockDelete(id);
		if (blocked !== null)
			return { ok: false as const, reason: "blocked" as const, message: blocked };
		// As EmDash: only deleted_at is set, so the revision stays (spec M5a F6).
		e.trashed = true;
		this.calls.push(`trash:${id}`);
		return { ok: true as const };
	}
	async permanentDelete(_collection: string, id: string) {
		this.beforeStep("delete", id);
		const e = this.entries.get(id);
		if (!e?.trashed) return false;
		this.entries.delete(id);
		this.calls.push(`delete:${id}`);
		return true;
	}
	async revertStep(
		input: {
			collection: string;
			id: string;
			rev: string;
			step: RevertStep;
			slug?: string | null;
			data?: Record<string, unknown>;
			scheduledAt?: string;
		} & LinkWrites,
	): Promise<StepResult> {
		this.beforeStep(input.step, input.id);
		const e = this.entries.get(input.id);
		if (!e || e.trashed) throw new ContentWriteError("emdash_not_found", "Entry not found");
		if (String(e.rev) !== input.rev) {
			return { ok: false, reason: "conflict", message: "Revision precondition did not match" };
		}
		const blocked = input.step === "update" ? null : this.blockStep(input.step, e.id);
		if (blocked !== null) return { ok: false, reason: "blocked", message: blocked };
		switch (input.step) {
			case "update": {
				const { slug, ...rest } = input;
				const written = await this.update({
					...rest,
					...(slug === undefined || slug === null ? {} : { slug }),
				});
				if (!written.ok) return { ok: false, reason: "conflict", message: written.reason };
				break;
			}
			case "publish": {
				const published = await this.publish({ id: e.id, rev: input.rev });
				if (!published.ok) return { ok: false, reason: "conflict", message: published.reason };
				break;
			}
			case "unpublish":
				if (e.status !== "draft" || e.scheduledAt !== null) {
					// As EmDash, also without revisions: a draft is created from the live revision (F18).
					e.live ??= { data: structuredClone(e.data), slug: e.slug };
					e.status = "draft";
					e.scheduledAt = null;
					e.pendingPublish = true;
					this.touch(e);
				}
				break;
			case "discard":
				if (e.live) {
					e.data = e.live.data;
					e.slug = e.live.slug;
					e.live = null;
					e.pendingPublish = e.status !== "published";
					e.rev++;
				}
				break;
			case "schedule": {
				const at = input.scheduledAt ?? "";
				if (!(Date.parse(at) > this.now())) {
					throw new ContentWriteError(
						"emdash_validation_error",
						"Rolling back the entry (schedule) failed: Scheduled date must be in the future",
					);
				}
				e.scheduledAt = at;
				if (e.status !== "published") e.status = "scheduled";
				this.touch(e);
				break;
			}
		}
		if (input.step !== "update" && input.step !== "publish") {
			this.calls.push(`${input.step}:${e.id}`);
		}
		return {
			ok: true,
			state: {
				rev: String(e.rev),
				status: e.status,
				scheduledAt: e.scheduledAt,
				hasDraft: e.live !== null,
			},
		};
	}
	async findBySourceId(collection: string, locale: string, sourceId: string, options?: GetOptions) {
		this.calls.push(`find:${sourceId}`);
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		}
		for (const e of this.entries.values()) {
			if (
				e.collection === collection &&
				e.locale === locale &&
				e.data.flux_source_id === sourceId
````
with:
````ts
		}
		for (const e of this.entries.values()) {
			if (
				!e.trashed &&
				e.collection === collection &&
				e.locale === locale &&
				e.data.flux_source_id === sourceId
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		}
		const id = `e${++this.next}`;
		const data = structuredClone(input.data);
		for (const field of source ? this.sharedFields : []) {
			if (source && Object.hasOwn(source.data, field)) data[field] = source.data[field];
			else delete data[field];
````
with:
````ts
		}
		const id = `e${++this.next}`;
		const data = structuredClone(input.data);
		const created = this.stamp();
		for (const field of source ? this.sharedFields : []) {
			if (source && Object.hasOwn(source.data, field)) data[field] = source.data[field];
			else delete data[field];
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
			taxonomies: structuredClone(source?.taxonomies ?? {}),
			references: structuredClone(source?.references ?? {}),
			bylines: input.bylines === undefined ? structuredClone(source?.bylines ?? []) : [],
		};
		this.writeLinks(entry, input);
		this.entries.set(id, entry);
````
with:
````ts
			taxonomies: structuredClone(source?.taxonomies ?? {}),
			references: structuredClone(source?.references ?? {}),
			bylines: input.bylines === undefined ? structuredClone(source?.bylines ?? []) : [],
			status: "draft",
			scheduledAt: null,
			live: null,
			trashed: false,
			createdAt: created,
			updatedAt: created,
		};
		this.writeLinks(entry, input);
		this.entries.set(id, entry);
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
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
````
with:
````ts
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		const staged = input.data !== undefined || input.slug !== undefined || input.references;
		const plain = this.plainCollections.has(e.collection);
		// On revisioned collections data, slug and references are staged in a draft (spec M5a F17).
		if (staged && !plain) e.live ??= { data: structuredClone(e.data), slug: e.slug };
		e.data = { ...e.data, ...structuredClone(input.data ?? {}) };
		if (input.slug !== undefined) e.slug = input.slug;
		this.writeLinks(e, input);
		this.touch(e);
		// As EmDash on revisioned collections: terms and bylines are live metadata (no draft).
		if (staged && !plain) e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		e.pendingPublish = false;
		e.rev++;
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: String(e.rev) };
	}
````
with:
````ts
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		e.pendingPublish = false;
		e.status = "published";
		e.scheduledAt = null;
		e.live = null;
		this.touch(e);
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: String(e.rev) };
	}
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
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
with:
````ts
	async translations(collection: string, id: string) {
		this.calls.push(`translations:${id}`);
		const e = this.entries.get(id);
		if (!e || e.trashed || e.collection !== collection) return [];
		return [...this.entries.values()]
			.filter((t) => !t.trashed && t.collection === collection && t.group === e.group)
			.map((t) => ({ id: t.id, locale: t.locale }));
	}
}
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	const lookups = new FakeLookups(content);
	content.bylineSlug = (id) => lookups.storedBylines.find((b) => b.id === id)?.slug ?? id;
	const deps = {
````
with:
````ts
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	content.now = () => clock.t;
	const lookups = new FakeLookups(content);
	content.bylineSlug = (id) => lookups.storedBylines.find((b) => b.id === id)?.slug ?? id;
	const deps = {
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/content.test.ts tests/unit/fakes.test.ts`
Expected: FAIL (`content.test.ts`: 4 tests failed, the adapter's new methods do not exist yet; `fakes.test.ts` passes, since the fakes are part of Step 1; 27 of 31 tests pass).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
````
with:
````ts
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type RevertStep,
	type StepResult,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
/**
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :4776 (translations), :759 (schemaRegistry).
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
````
with:
````ts
/**
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :4776 (translations), :759 (schemaRegistry); for rollbacks
 * (M5a) :3374 (get including Trash), :4093 (delete), :4163 (permanent delete), :4652 (unpublish),
 * :4686 (schedule), :4764 (discard draft).
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentTranslations(collection: string, id: string): Promise<HandlerResult>;
}

/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;
````
with:
````ts
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentTranslations(collection: string, id: string): Promise<HandlerResult>;
	handleContentGetIncludingTrashed(
		collection: string,
		id: string,
		locale?: string,
	): Promise<HandlerResult>;
	handleContentDelete(collection: string, id: string): Promise<HandlerResult>;
	handleContentPermanentDelete(collection: string, id: string): Promise<HandlerResult>;
	handleContentUnpublish(
		collection: string,
		id: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentDiscardDraft(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}

/** The codes EmDash's policy hooks refuse a publish, unpublish or schedule with (M5a). */
const HOOK_REFUSALS: ReadonlySet<string> = new Set([
	"PUBLISH_REJECTED",
	"UNPUBLISH_REJECTED",
	"SCHEDULE_REJECTED",
]);

/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
		locale: z.string().nullable().optional(),
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
		references: z.record(z.string(), referencePage).optional(),
		bylines: z.array(bylineCredit).optional(),
	}),
````
with:
````ts
		locale: z.string().nullable().optional(),
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		/** The live column values, when `handleContentGet` hydrated a draft (spec M5a F5). */
		liveData: z.record(z.string(), z.unknown()).optional(),
		draftRevisionId: z.string().nullable().optional(),
		scheduledAt: z.string().nullable().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().nullable().optional(),
		references: z.record(z.string(), referencePage).optional(),
		bylines: z.array(bylineCredit).optional(),
	}),
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
	);
}

function snapshotOf(data: unknown, op: string): EntrySnapshot & { locale: string | null } {
	const { item, _rev } = parse(itemResult, data, op);
	return {
		id: item.id,
		rev: _rev,
````
with:
````ts
	);
}

function snapshotOf(
	data: unknown,
	op: string,
): EntrySnapshot & { locale: string | null; trashed: boolean } {
	const { item, _rev } = parse(itemResult, data, op);
	const hasDraft = (item.draftRevisionId ?? null) !== null;
	return {
		id: item.id,
		rev: _rev,
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
		data: item.data,
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
		...(item.references === undefined
			? {}
			: {
````
with:
````ts
		data: item.data,
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || hasDraft,
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		hasDraft,
		...(hasDraft && item.liveData !== undefined ? { live: item.liveData } : {}),
		...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
		...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
		trashed: (item.deletedAt ?? null) !== null,
		...(item.references === undefined
			? {}
			: {
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
	};
}

/** The links of a write, without the ones not given. */
function linksOf(input: LinkWrites): LinkWrites {
	return {
````
with:
````ts
	};
}

/** Whether an entry's locale (null without i18n) is `locale`, ignoring case. */
function sameLocale(entryLocale: string | null, locale: string): boolean {
	return entryLocale === null || entryLocale.toLowerCase() === locale.toLowerCase();
}

/** The links of a write, without the ones not given. */
function linksOf(input: LinkWrites): LinkWrites {
	return {
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		// EmDash stores the configured casing of a locale (resolveContentCreateLocale,
		// src/i18n/config.ts:54-76), so compare without case.
		return entryLocale === null || entryLocale.toLowerCase() === locale.toLowerCase()
			? snapshot
			: null;
	}

	async findBySourceId(
````
with:
````ts
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const {
			locale: entryLocale,
			trashed: _trashed,
			...snapshot
		} = snapshotOf(result.data, "Reading the entry");
		// EmDash stores the configured casing of a locale (resolveContentCreateLocale,
		// src/i18n/config.ts:54-76), so compare without case.
		return sameLocale(entryLocale, locale) ? snapshot : null;
	}

	async getIncludingTrashed(
		collection: string,
		locale: string,
		id: string,
	): Promise<(EntrySnapshot & { trashed: boolean }) | null> {
		const result = await this.runtime.handleContentGetIncludingTrashed(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		return sameLocale(entryLocale, locale) ? snapshot : null;
	}

	async trash(
		collection: string,
		id: string,
	): Promise<{ ok: true } | { ok: false; reason: "blocked" | "not_found"; message: string }> {
		const result = await this.runtime.handleContentDelete(collection, id);
		if (result.success) return { ok: true };
		const message = result.error?.message ?? "";
		if (result.error?.code === "DELETE_BLOCKED") return { ok: false, reason: "blocked", message };
		if (result.error?.code === "NOT_FOUND") return { ok: false, reason: "not_found", message };
		throw writeError("Moving the entry to Trash", result.error);
	}

	async permanentDelete(collection: string, id: string): Promise<boolean> {
		const result = await this.runtime.handleContentPermanentDelete(collection, id);
		if (result.success) return true;
		if (result.error?.code === "NOT_FOUND") return false;
		throw writeError("Deleting the entry", result.error);
	}

	async revertStep(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			step: RevertStep;
			slug?: string | null;
			data?: Record<string, unknown>;
			scheduledAt?: string;
		} & LinkWrites,
	): Promise<StepResult> {
		const { collection, id, rev } = input;
		const options = { _rev: rev, actor: this.actor };
		let result: HandlerResult;
		switch (input.step) {
			case "update":
				result = await this.runtime.handleContentUpdate(collection, id, {
					...(input.data === undefined ? {} : { data: input.data }),
					locale: input.locale,
					_rev: rev,
					actor: this.actor,
					...(input.slug === undefined || input.slug === null ? {} : { slug: input.slug }),
					...linksOf(input),
				});
				break;
			case "publish":
				result = await this.runtime.handleContentPublish(collection, id, options);
				break;
			case "unpublish":
				result = await this.runtime.handleContentUnpublish(collection, id, options);
				break;
			case "discard":
				result = await this.runtime.handleContentDiscardDraft(collection, id, { _rev: rev });
				break;
			case "schedule":
				result = await this.runtime.handleContentSchedule(
					collection,
					id,
					input.scheduledAt ?? "",
					options,
				);
				break;
		}
		const op = `Rolling back the entry (${input.step})`;
		if (!result.success) {
			const code = result.error?.code ?? "";
			const message = result.error?.message ?? code;
			if (code === "CONFLICT") return { ok: false, reason: "conflict", message };
			if (HOOK_REFUSALS.has(code)) return { ok: false, reason: "blocked", message };
			throw writeError(op, result.error);
		}
		const after = snapshotOf(result.data, op);
		return {
			ok: true,
			state: {
				rev: after.rev,
				status: after.status,
				scheduledAt: after.scheduledAt,
				hasDraft: after.hasDraft,
			},
		};
	}

	async findBySourceId(
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
	 * live immediately, so only an unpublished status counts there.
	 */
	pendingPublish: boolean;
	/**
	 * Each reference field's selection (the first 50), a staged draft selection first; only when
	 * read with `references`.
````
with:
````ts
	 * live immediately, so only an unpublished status counts there.
	 */
	pendingPublish: boolean;
	/** EmDash's status: `draft`, `scheduled` or `published` (M5a). */
	status: string;
	/** When a scheduled entry or draft is due to publish; null when none is set (M5a). */
	scheduledAt: string | null;
	/** The entry has a draft revision (`draftRevisionId`, M5a). */
	hasDraft: boolean;
	/** The live column values while the entry has a draft (EmDash `liveData`, M5a). */
	live?: Record<string, unknown>;
	/** ISO timestamps of the entry's row (M5a); absent when EmDash gives none. */
	createdAt?: string;
	updatedAt?: string;
	/**
	 * Each reference field's selection (the first 50), a staged draft selection first; only when
	 * read with `references`.
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(
		collection: string,
````
with:
````ts

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

/** The state a rollback step left the entry in (M5a). */
export type EntryState = {
	rev: string;
	status: string;
	scheduledAt: string | null;
	hasDraft: boolean;
};

/**
 * A rollback step's outcome (M5a): a stale `rev` is `conflict`; a plugin hook's refusal
 * (`PUBLISH_REJECTED`, `UNPUBLISH_REJECTED`, `SCHEDULE_REJECTED`) is `blocked` with its message.
 */
export type StepResult =
	| { ok: true; state: EntryState }
	| { ok: false; reason: "conflict" | "blocked"; message: string };

/** The rollback's writes to a changed entry (spec M5a "Revert sequence"). */
export type RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule";

export interface ContentPort {
	get(
		collection: string,
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
	 * existing field must be verified to be indexed.
	 */
	ensureSourceIdField(collection: string): Promise<void>;
}

/** A taxonomy definition (`TaxonomyDefInfo`, one per locale). */
````
with:
````ts
	 * existing field must be verified to be indexed.
	 */
	ensureSourceIdField(collection: string): Promise<void>;
	/**
	 * The entry, also when it is in Trash (`trashed`); a trashed entry keeps the `rev` it had
	 * (spec M5a F6, V2). Null when there is none in the locale.
	 */
	getIncludingTrashed(
		collection: string,
		locale: string,
		id: string,
	): Promise<(EntrySnapshot & { trashed: boolean }) | null>;
	/**
	 * Moves an active entry to Trash (spec M5a F6). `blocked`: a `content:beforeDelete` hook
	 * refused; `not_found`: no active entry has the ID.
	 */
	trash(
		collection: string,
		id: string,
	): Promise<{ ok: true } | { ok: false; reason: "blocked" | "not_found"; message: string }>;
	/** Deletes a trashed entry for good (spec M5a F8); false when no trashed entry has the ID. */
	permanentDelete(collection: string, id: string): Promise<boolean>;
	/**
	 * One rollback write with the entry's current `rev` (M5a): `update` (data, slug and links as
	 * in `update`), `publish`, `unpublish`, `discard` (the draft) or `schedule` (at `scheduledAt`).
	 */
	revertStep(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			step: RevertStep;
			slug?: string | null;
			data?: Record<string, unknown>;
			scheduledAt?: string;
		} & LinkWrites,
	): Promise<StepResult>;
}

/** A taxonomy definition (`TaxonomyDefInfo`, one per locale). */
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/content.test.ts tests/unit/fakes.test.ts`
Expected: PASS (2 files, 31 tests). Full suite after this task: 57 files / 1,386 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/content.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/fakes.test.ts packages/flux-import/tests/unit/content.test.ts
git commit -m "Read status, schedule, draft and live values of entries, and add Trash, permanent delete and the revert steps to the content port"
```

### Task 3: Comparison and write-back

**Files:**
- Create: `packages/flux-import/src/engine/rollback-values.ts`
- Test: `packages/flux-import/tests/unit/rollback-values.test.ts`

**Interfaces:**
- Consumes: `TargetField` (its `type`).
- Produces: `sameStored(a, b): boolean` (Ruling 4); `restoredValue(value, target)`; `restoredData(values, targets)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/rollback-values.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { restoredData, restoredValue, sameStored } from "../../src/engine/rollback-values.js";

describe("sameStored (spec M5a V1)", () => {
	it("compares a boolean with its stored 1 or 0 by truth value", () => {
		expect(sameStored(1, true)).toBe(true);
		expect(sameStored(false, 0)).toBe(true);
		expect(sameStored(true, 0)).toBe(false);
		expect(sameStored(true, "true")).toBe(false);
		expect(sameStored(true, 2)).toBe(false);
	});

	it("ignores the key order of objects, as an image value reads back", () => {
		const read = {
			id: "m1",
			provider: "local",
			width: 4,
			alt: "A desk",
			meta: { storageKey: "k.png", caption: null, blurhash: "L$" },
			blurhash: "L$",
		};
		const back = {
			blurhash: "L$",
			meta: { blurhash: "L$", caption: null, storageKey: "k.png" },
			alt: "A desk",
			width: 4,
			provider: "local",
			id: "m1",
		};
		expect(sameStored(read, back)).toBe(true);
		expect(sameStored(read, { ...back, alt: "Other" })).toBe(false);
		expect(sameStored([1, 2], [2, 1])).toBe(false);
		expect(sameStored([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
	});

	it("reads null as an absent key, at the top and inside objects", () => {
		expect(sameStored(null, undefined)).toBe(true);
		expect(sameStored({ a: 1, b: null }, { a: 1 })).toBe(true);
		expect(sameStored({ a: 1 }, { a: 1, b: 0 })).toBe(false);
		expect(sameStored(null, 0)).toBe(false);
		expect(sameStored(null, "")).toBe(false);
	});

	it("compares other values exactly, -0 equal to 0", () => {
		expect(sameStored("a", "a")).toBe(true);
		expect(sameStored("1", 1)).toBe(false);
		expect(sameStored(-0, 0)).toBe(true);
		expect(sameStored({ a: [1] }, { a: [1, 2] })).toBe(false);
		expect(sameStored([], {})).toBe(false);
	});
});

describe("restoredValue", () => {
	it("sends a boolean field's stored 1 or 0 as a boolean and a missing value as null", () => {
		const boolean = { type: "boolean", required: false };
		expect(restoredValue(1, boolean)).toBe(true);
		expect(restoredValue(0, boolean)).toBe(false);
		expect(restoredValue(true, boolean)).toBe(true);
		expect(restoredValue(1, { type: "number", required: false })).toBe(1);
		expect(restoredValue(undefined, undefined)).toBeNull();
		expect(restoredValue({ a: 1 }, undefined)).toEqual({ a: 1 });
	});

	it("converts every field of a pre-image by the job's snapshot", () => {
		expect(
			restoredData(
				{ featured: 0, price: 1, body: null },
				{ featured: { type: "boolean", required: false } },
			),
		).toEqual({ featured: false, price: 1, body: null });
		expect(restoredData({ featured: 1 }, undefined)).toEqual({ featured: 1 });
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rollback-values.test.ts`
Expected: FAIL (1 file: `src/engine/rollback-values.ts` does not exist yet, so no test runs).

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/engine/rollback-values.ts`:
````ts
import type { TargetField } from "./values.js";

/**
 * Whether two stored values are the same as EmDash reads them back (spec M5a V1): a missing value
 * and `null` are the same (a `null` written reads back as an absent key, also inside objects), a
 * boolean and its stored `1`/`0` are the same, object keys compare in any order, arrays in order,
 * and `-0` equals `0`.
 */
export function sameStored(a: unknown, b: unknown): boolean {
	const x = a ?? null;
	const y = b ?? null;
	if (x === y) return true;
	if (typeof x === "boolean" || typeof y === "boolean") {
		return truthOf(x) !== null && truthOf(x) === truthOf(y);
	}
	if (typeof x === "number" && typeof y === "number") return x === y;
	if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
	if (Array.isArray(x) || Array.isArray(y)) {
		if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
		return x.every((item, i) => sameStored(item, y[i]));
	}
	const xo = x as Record<string, unknown>;
	const yo = y as Record<string, unknown>;
	const keys = new Set([...Object.keys(xo), ...Object.keys(yo)]);
	return [...keys].every((k) => sameStored(xo[k], yo[k]));
}

/** A boolean, or the 1/0 EmDash stores for one; null for anything else. */
function truthOf(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === 0) return value === 1;
	return null;
}

/**
 * A field's value as a rollback writes it back: exactly as read, except that a boolean field's
 * stored `1`/`0` is sent as `true`/`false` (spec M5a V1), and a missing value as `null`.
 */
export function restoredValue(value: unknown, target: TargetField | undefined): unknown {
	if (value === undefined || value === null) return null;
	if (target?.type === "boolean" && (value === 0 || value === 1)) return value === 1;
	return value;
}

/** `restoredValue` for every field of a pre-image, by the job's field snapshot. */
export function restoredData(
	values: Readonly<Record<string, unknown>>,
	targets: Readonly<Record<string, TargetField>> | undefined,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([field, value]) => [field, restoredValue(value, targets?.[field])]),
	);
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/rollback-values.test.ts`
Expected: PASS (1 file, 6 tests). Full suite after this task: 58 files / 1,392 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/rollback-values.ts packages/flux-import/tests/unit/rollback-values.test.ts
git commit -m "Compare stored values the way EmDash reads them back, and write booleans back as booleans"
```

### Task 4: Journal writes

**Files:**
- Create: `packages/flux-import/src/engine/journal.ts`
- Modify: `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/engine/media.ts`
- Test: `packages/flux-import/tests/unit/journal.test.ts`, `packages/flux-import/tests/unit/rollback-fixture.ts`, `packages/flux-import/tests/unit/link-import.test.ts`

**Interfaces:**
- Consumes: Task 1's `JournalEntry`, `JournalBefore`, `JournalMedia`, `journalKey`, `journalMediaKey`, `MAX_JOURNAL_BYTES`, `LinkRow.jobId`; Task 2's `EntrySnapshot.status`/`scheduledAt`/`hasDraft`/`live` and the fakes; `processRecord`, `RecordCtx`, `putLink`, `finishUnchanged`, `writeRecord`, crash repair; `CurrentLinks`, `ResolvedLinks`; `obtainRecordMedia`, `MediaContext`.
- Produces: `journaling(job)`; `JournalTarget`; `draftFields(entry)`; `Touched`; `preImage(entry, link, touched, current)` (a `JournalBefore`, or `journal_incomplete` for a truncated selection); `mergeBefore(first, next)`; `journalUpdate(t, entryId, before)` (put-if-absent, merge, `journal_too_large`); `journalCreate(t, sourceIdValue)`; `journalCreated(t, entryId, confirmed)`; `RecordCtx.seq`/`link`/`current`; `putLink` sets `jobId`; `MediaDeps.journalMedia`, `MediaContext.journal?: { seq }`; the test fixture `tests/unit/rollback-fixture.ts` (`schemaFields`, `template`, `csv`, `seed`, `setup`, `start`, `runToEnd`, `importRows`, `records`, `journalOf`, `entryOf`, `termGroup`, `bylineId`, `url`, `Deps`), which Tasks 5 and 6 import.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/journal.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { mergeBefore } from "../../src/engine/journal.js";
import { type JournalBefore, journalKey, linkKey } from "../../src/engine/types.js";
import {
	bylineId,
	csv,
	entryOf,
	importRows,
	journalOf,
	records,
	runToEnd,
	setup,
	start,
	termGroup,
	url,
} from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, featured: true, tags: "new", authors: "alex" };

describe("the journal of a real import (M5a)", () => {
	it("journals a create before the write and its entry once the create returns", async () => {
		const { deps } = setup();
		let during: unknown;
		deps.content.afterWrite = () => {
			during = structuredClone([...deps.journal.rows.values()].map((r) => r.value));
		};
		const job = await importRows(deps, [desk]);
		expect(during).toEqual([
			{
				jobId: job.id,
				seq: 0,
				collection: "products",
				locale: "en",
				sourceKey: "A1",
				kind: "create",
				entryId: null,
				sourceIdValue: "A1",
				at: "2026-10-07T10:00:00.000Z",
			},
		]);
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({ kind: "create", entryId: entryOf(deps, "A1").id, confirmed: true });
		expect(await deps.links.get(linkKey("products", "en", "A1"))).toMatchObject({
			jobId: job.id,
			writtenRev: String(entryOf(deps, "A1").rev),
		});
	});

	it("journals an update's live values, slug, links, status, schedule and link row", async () => {
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = String(entry.rev);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
		expect(second.counters).toMatchObject({ updated: 1 });
		const [row] = await journalOf(deps, second.id);
		expect(row).toEqual({
			jobId: second.id,
			seq: 0,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: entry.id,
			before: {
				link: { jobId: first.id, writtenRev: rev },
				status: "published",
				scheduledAt: null,
				slug: "desk",
				live: { title: "Desk", price: 10 },
				links: {
					taxonomies: { tag: [termGroup(deps, "new")] },
					bylines: [{ bylineId: bylineId(deps, "alex"), roleLabel: null }],
				},
			},
			at: "2026-10-07T10:00:00.000Z",
		});
	});

	it("journals the live and draft values of the importer's own pending draft it publishes", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", data: { price: 20 } });
		// The same data with publish: true only publishes the draft (finishUnchanged).
		const third = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(third.counters).toMatchObject({ updated: 1 });
		const [row] = await journalOf(deps, third.id);
		expect(row?.before).toMatchObject({
			status: "published",
			live: { price: 10 },
			draft: { price: 20 },
		});
		expect(row?.before).not.toHaveProperty("slug");
		// A write over the draft that also publishes keeps every field the publish makes live.
		await importRows(deps, [{ ...desk, price: 30 }], { publish: false });
		const fifth = await importRows(deps, [{ ...desk, name: "Table", price: 30 }]);
		const [written] = await journalOf(deps, fifth.id);
		expect(written?.before).toMatchObject({
			live: { title: "Desk", price: 20 },
			draft: { title: "Desk", price: 30 },
			slug: "desk",
		});
	});

	it("keeps the first touch's pre-image and adds only what later writes touch first", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [
			{ ...desk, price: 20 },
			{ ...desk, name: "Table", price: 20 },
		]);
		expect(job.counters).toMatchObject({ updated: 2 });
		const rows = await journalOf(deps, job.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			seq: 0,
			before: { live: { price: 10, title: "Desk" }, slug: "desk" },
		});
	});

	it("merges a later write's fields, draft values and links without replacing the first's", () => {
		const first: JournalBefore = {
			link: null,
			status: "published",
			scheduledAt: null,
			live: { price: 10 },
			draft: { price: 11 },
			links: { taxonomies: { tag: ["t1"] } },
		};
		const next: JournalBefore = {
			link: { jobId: "x" },
			status: "draft",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			slug: "desk",
			live: { price: 99, title: "Desk" },
			links: {
				taxonomies: { tag: ["t2"], colour: ["c1"] },
				references: { related: ["e9"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		};
		expect(mergeBefore(first, next)).toEqual({
			link: null,
			status: "published",
			scheduledAt: null,
			slug: "desk",
			live: { price: 10, title: "Desk" },
			draft: { price: 11, title: "Desk" },
			links: {
				taxonomies: { tag: ["t1"], colour: ["c1"] },
				references: { related: ["e9"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		});
		expect(mergeBefore(first, { ...first, status: "draft" })).toBeNull();
	});

	it("marks a create that crash repair found as not confirmed", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]));
		let crash = true;
		deps.content.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("crash after the create");
			}
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash after the create");
		const stored = await deps.jobs.get(job.id);
		await deps.jobs.put(job.id, { ...(stored as typeof job), lease: null });
		const done = await runToEnd(deps, job.id);
		// As for any repaired create (M2): left as a draft, publish_unverified.
		expect(done.counters).toMatchObject({ conflict: 1 });
		expect(deps.content.entries.size).toBe(1);
		const [row] = await journalOf(deps, job.id);
		expect(row).toMatchObject({
			kind: "create",
			entryId: entryOf(deps, "A1").id,
			confirmed: false,
		});
	});

	it("fails a record whose pre-image is too large, before any write", async () => {
		const { deps } = setup();
		const big = "x".repeat(1024 * 1024);
		await importRows(deps, [{ ...desk, name: big }]);
		const entry = entryOf(deps, "A1");
		const rev = entry.rev;
		const job = await importRows(deps, [{ ...desk, name: "Desk" }]);
		expect(job.counters).toMatchObject({ failed: 1 });
		const [row] = await records(deps, job.id);
		expect(row?.errors?.[0]).toMatchObject({ code: "journal_too_large" });
		expect(entry.rev).toBe(rev);
		expect(await journalOf(deps, job.id)).toEqual([]);
		// Without a journal the record imports.
		const plain = await importRows(deps, [{ ...desk, name: "Desk" }], { journal: false });
		expect(plain.counters).toMatchObject({ updated: 1 });
	});

	it("fails a record that changes a reference field read only in part", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk }, { sku: "A2", name: "Lamp", related: "A1" }]);
		const lamp = entryOf(deps, "A2");
		const get = deps.content.get.bind(deps.content);
		deps.content.get = async (collection, locale, id, options) => {
			const entry = await get(collection, locale, id, options);
			return entry && id === lamp.id && options?.references
				? { ...entry, referencesTruncated: ["related"] }
				: entry;
		};
		const rev = lamp.rev;
		const job = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A1" }]);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "failed",
			errors: [{ field: "related", code: "journal_incomplete" }],
		});
		expect(lamp.rev).toBe(rev);
	});

	it("keeps no journal for journal: false or a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { journal: false });
		await importRows(deps, [{ ...desk, price: 1 }], { dryRun: true });
		await importRows(deps, [{ ...desk, price: 2 }], { journal: false });
		expect(deps.journal.rows.size).toBe(0);
	});

	it("journals media its uploads create, and not media found by its bytes", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [
			{ ...desk, img: url("a.png") },
			{ sku: "A2", name: "Lamp", img: url("copy.png") },
			{ sku: "A3", name: "Shelf", img: url("a.png") },
		]);
		expect(job.counters).toMatchObject({ created: 3 });
		const page = await deps.journalMedia.query({ where: { jobId: job.id } });
		expect(page.items.map((i) => i.data)).toEqual([
			{ jobId: job.id, mediaId: "m1", url: url("a.png"), seq: 0 },
		]);
		expect(page.items[0]?.id).toBe(`${job.id}:m1`);
		const none = await importRows(deps, [{ sku: "B1", name: "Bench", img: url("b.png") }], {
			journal: false,
		});
		expect((await deps.journalMedia.query({ where: { jobId: none.id } })).items).toEqual([]);
	});

	it("keys rows by job and link", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		expect(
			await deps.journal.get(journalKey(job.id, linkKey("products", "en", "A1"))),
		).toMatchObject({ kind: "create" });
	});
});
````

In `packages/flux-import/tests/unit/link-import.test.ts`, replace
````ts
async function start(
	deps: Deps,
	csv: string,
	opts: { dryRun?: boolean; publish?: boolean; extra?: Record<string, unknown> } = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
````
with:
````ts
async function start(
	deps: Deps,
	csv: string,
	opts: {
		dryRun?: boolean;
		publish?: boolean;
		journal?: boolean;
		extra?: Record<string, unknown>;
	} = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
````

In `packages/flux-import/tests/unit/link-import.test.ts`, replace
````ts
		expect(entry.taxonomies).toEqual({ category: ["phones"], tag: [] });
	});

	it("rewrites a reference field whose selection was read only in part", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
````
with:
````ts
		expect(entry.taxonomies).toEqual({ category: ["phones"], tag: [] });
	});

	it("rewrites a reference field whose selection was read only in part (without a journal)", async () => {
		const { deps } = makeDeps();
		await seed(deps);
		const first = await start(deps, CSV);
````

In `packages/flux-import/tests/unit/link-import.test.ts`, replace
````ts
				: entry;
		};
		deps.content.linkWrites.length = 0;
		const second = await start(deps, CSV);
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ updated: 1, unchanged: 1 });
		const [, row] = await rows(deps, second.id);
````
with:
````ts
				: entry;
		};
		deps.content.linkWrites.length = 0;
		// A journal could not restore the field (M5a journal_incomplete), so the job keeps none.
		const second = await start(deps, CSV, { journal: false });
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ updated: 1, unchanged: 1 });
		const [, row] = await rows(deps, second.id);
````

Create `packages/flux-import/tests/unit/rollback-fixture.ts`:
````ts
/**
 * A products collection for the M5a journal and rollback tests: text, number, boolean, image and
 * reference fields, a slug, a tag taxonomy and bylines, over the fakes.
 */
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, JournalEntry, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

export type Deps = ReturnType<typeof makeDeps>["deps"];

export const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "featured", type: "boolean" },
	{ slug: "photo", type: "image" },
	{
		slug: "related",
		type: "reference",
		storageless: true,
		relationSide: "parent",
		targetCollection: "products",
		multiple: true,
	},
	{ slug: "flux_source_id", type: "string" },
];

export const template = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "Name" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number" },
		featured: { from: "Featured", type: "boolean" },
		photo: { from: "Img", type: "image" },
		related: { from: "Related", type: "reference", match: "key", separator: "|" },
	},
	taxonomies: { tag: { from: "Tags", separator: "|" } },
	bylines: { from: "Authors", separator: "|" },
	...extra,
});

export type Row = {
	sku: string;
	name: string;
	price?: number;
	featured?: boolean;
	img?: string;
	related?: string;
	tags?: string;
	authors?: string;
};

export function csv(rows: Row[]): string {
	const lines = rows.map((r) =>
		[
			r.sku,
			r.name,
			r.price ?? "",
			r.featured === undefined ? "" : String(r.featured),
			r.img ?? "",
			r.related ?? "",
			r.tags ?? "",
			r.authors ?? "",
		].join(","),
	);
	return ["sku,Name,Price,Featured,Img,Related,Tags,Authors", ...lines, ""].join("\n");
}

export const url = (name: string) => `https://cdn.test/${name}`;
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

/** The tag taxonomy with `new` and `sale`, the bylines `alex` and `sam`, and three images. */
export function seed(deps: Deps): void {
	deps.lookups.defs.push({
		name: "tag",
		hierarchical: false,
		collections: ["products"],
		locale: "en",
	});
	deps.lookups.addTerm("tag", "new", "New");
	deps.lookups.addTerm("tag", "sale", "Sale");
	deps.lookups.addByline("alex", "Alex");
	deps.lookups.addByline("sam", "Sam");
	deps.mediaFetcher.files.set(url("a.png"), { body: PNG(1), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("b.png"), { body: PNG(2), contentType: "image/png" });
	// The same bytes as a.png under another URL: the upload finds the stored item.
	deps.mediaFetcher.files.set(url("copy.png"), { body: PNG(1), contentType: "image/png" });
}

export function setup() {
	const made = makeDeps();
	seed(made.deps);
	return made;
}

export type StartOptions = {
	dryRun?: boolean;
	publish?: boolean;
	journal?: boolean;
	batchSize?: number;
	extra?: Record<string, unknown>;
};

export async function start(deps: Deps, body: string, opts: StartOptions = {}): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, body);
	const { extra, ...rest } = opts;
	return createJob(deps, {
		uploadId: upload,
		template: template(extra),
		schemaFields,
		linkSchema: {
			targets: { products: [{ slug: "flux_source_id", type: "string" }] },
			taxonomies: deps.lookups.defs,
		},
		mediaMaxBytes: 1000,
		...rest,
	});
}

export async function runToEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running" && job.status !== "created") return job;
	}
	throw new Error("did not finish");
}

/** Starts an import and runs it to the end. */
export async function importRows(deps: Deps, rows: Row[], opts: StartOptions = {}): Promise<Job> {
	const job = await start(deps, csv(rows), opts);
	return runToEnd(deps, job.id);
}

export async function records(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

export async function journalOf(deps: Deps, jobId: string): Promise<JournalEntry[]> {
	const page = await deps.journal.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

/** The fake entry imported with this key. */
export function entryOf(deps: Deps, key: string) {
	const entry = [...deps.content.entries.values()].find((e) => e.data.flux_source_id === key);
	if (!entry) throw new Error(`No entry for ${key}`);
	return entry;
}

/** A term's translation group (the fake's term ID) by slug. */
export function termGroup(deps: Deps, slug: string): string {
	const term = deps.lookups.storedTerms.find((t) => t.slug === slug);
	if (!term) throw new Error(`No term ${slug}`);
	return term.group;
}

export function bylineId(deps: Deps, slug: string): string {
	const byline = deps.lookups.storedBylines.find((b) => b.slug === slug);
	if (!byline) throw new Error(`No byline ${slug}`);
	return byline.id;
}
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/journal.test.ts tests/unit/link-import.test.ts`
Expected: FAIL (`journal.test.ts` cannot load `src/engine/journal.ts`; `link-import.test.ts` passes, 23 tests).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	upgradeJob,
	withoutPlannedTerms,
} from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
````
with:
````ts
	upgradeJob,
	withoutPlannedTerms,
} from "./jobs.js";
import {
	draftFields,
	journalCreate,
	journalCreated,
	journaling,
	journalUpdate,
	preImage,
} from "./journal.js";
import type { ResolvedLinks } from "./links.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
type RecordCtx = {
	deps: EngineDeps;
	job: Job;
	sourceKey: string;
	linkId: string;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
````
with:
````ts
type RecordCtx = {
	deps: EngineDeps;
	job: Job;
	/** The record's sequence number, which orders its journal row (M5a). */
	seq: number;
	sourceKey: string;
	linkId: string;
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
	/** The entry's current links, as the plan compared them; absent when the template maps none. */
	current?: CurrentLinks;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
	});
}
````
with:
````ts
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
		jobId: ctx.job.id,
	});
}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	};
}

function mediaContext(job: Job): MediaContext {
	return {
		jobId: job.id,
		dryRun: job.dryRun,
		maxBytes: job.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
		targets: job.targetFields ?? {},
	};
}
````
with:
````ts
	};
}

function mediaContext(job: Job, seq: number): MediaContext {
	return {
		jobId: job.id,
		dryRun: job.dryRun,
		maxBytes: job.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
		targets: job.targetFields ?? {},
		...(journaling(job) ? { journal: { seq } } : {}),
	};
}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	const ctx: RecordCtx = {
		deps,
		job,
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		save,
	};
	// Known so far, so that a ContentWriteError from any content call still reports it.
````
with:
````ts
	const ctx: RecordCtx = {
		deps,
		job,
		seq: rec.seq,
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		save,
	};
	// Known so far, so that a ContentWriteError from any content call still reports it.
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
		if (mediaRequests) {
			const looked = await lookupRecordMedia(deps, cache, mediaContext(job), mediaRequests);
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
````
with:
````ts
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
		if (mediaRequests) {
			const looked = await lookupRecordMedia(
				deps,
				cache,
				mediaContext(job, rec.seq),
				mediaRequests,
			);
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				drafts,
				template.portableText,
			);
````
with:
````ts
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				drafts,
				template.portableText,
			);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			return { status: "failed", sourceKey, entryId, errors: [sharedOnTranslation()] };
		}
		// A repaired link is saved only for an entry the record may write.
		if (repaired && link) await deps.links.put(ctx.linkId, link);
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
````
with:
````ts
			return { status: "failed", sourceKey, entryId, errors: [sharedOnTranslation()] };
		}
		// A repaired link is saved only for an entry the record may write.
		if (repaired && link) {
			await deps.links.put(ctx.linkId, link);
			// Crash repair may have found an editor's entry: a rollback only moves it to Trash.
			if (entry && journaling(job)) await journalCreated(ctx, entry.id, false);
		}
		ctx.link = link;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		if (links) ctx.current = links.current;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
			const obtained = await obtainRecordMedia(deps, cache, mediaContext(job), lookups);
			found.newMedia = obtained.newMedia;
			if (!obtained.ok) {
				return {
````
with:
````ts
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
			const obtained = await obtainRecordMedia(deps, cache, mediaContext(job, rec.seq), lookups);
			found.newMedia = obtained.newMedia;
			if (!obtained.ok) {
				return {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			const obtained = await obtainPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				images,
				found.newMedia,
			);
````
with:
````ts
			const obtained = await obtainPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				images,
				found.newMedia,
			);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		// A pending draft at the revision this importer last produced is its own (an earlier
		// `publish: false` run or a failed publish), so publishing it puts no one else's work live.
		if (job.publish && entry.pendingPublish && link?.writtenRev === entry.rev) {
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
````
with:
````ts
		// A pending draft at the revision this importer last produced is its own (an earlier
		// `publish: false` run or a failed publish), so publishing it puts no one else's work live.
		if (job.publish && entry.pendingPublish && link?.writtenRev === entry.rev) {
			// Publishing makes the draft's values live: the journal keeps the live ones first.
			const failure = journaling(job) ? await journalPublish(ctx, entry, link) : null;
			if (failure) return { status: "failed", sourceKey, entryId, errors: [failure] };
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	return writes;
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
````
with:
````ts
	return writes;
}

/** Journals the publish of the importer's own pending draft: every field it makes live (M5a). */
async function journalPublish(
	ctx: RecordCtx,
	entry: EntrySnapshot,
	link: LinkRow | null,
): Promise<RecordError | null> {
	const touched = {
		fields: draftFields(entry),
		slug: false,
		taxonomies: [],
		references: [],
		bylines: false,
	};
	const before = preImage(entry, link, touched, undefined);
	if ("code" in before) return before;
	return journalUpdate(ctx, entry.id, before);
}

/**
 * The write-ahead journal row of a write (M5a): a create's source ID, or the pre-image of every
 * field and link an update changes and, when it publishes, of every field its publish makes live.
 */
async function journalWrite(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	plan: RecordPlan,
	data: Readonly<Record<string, FieldValue>>,
	media: Readonly<Record<string, FieldValue>>,
): Promise<RecordError | null> {
	if (!entry) {
		await journalCreate(ctx, ctx.translationOf?.value ?? ctx.sourceKey);
		return null;
	}
	const changed = new Set(plan.changes.map((c) => c.field));
	const fields = new Set<string>();
	for (const field of changed) {
		if (Object.hasOwn(data, field)) fields.add(field);
		else if (field.endsWith(".alt") && Object.hasOwn(media, field.slice(0, -4))) {
			fields.add(field.slice(0, -4));
		}
	}
	if (ctx.job.publish) for (const field of draftFields(entry)) fields.add(field);
	fields.delete(SOURCE_ID_FIELD);
	const resolved = ctx.links;
	const touched = {
		fields: [...fields],
		slug: changed.has("slug"),
		taxonomies: Object.keys(resolved?.taxonomies ?? {}).filter((t) =>
			changed.has(`taxonomies.${t}`),
		),
		references: Object.keys(resolved?.references ?? {}).filter((f) => changed.has(f)),
		bylines: resolved?.bylines !== undefined && changed.has("bylines"),
	};
	const before = preImage(entry, ctx.link, touched, ctx.current);
	if ("code" in before) return before;
	return journalUpdate(ctx, entry.id, before);
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
): Promise<RowFields> {
	const { deps, job, sourceKey, save } = ctx;
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media and Portable Text fields are data fields: their values (null clears one) are written
	// with the rest.
````
with:
````ts
): Promise<RowFields> {
	const { deps, job, sourceKey, save } = ctx;
	const { collection, locale } = job.template;
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media and Portable Text fields are data fields: their values (null clears one) are written
	// with the rest.
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		media[field] = item?.blocks ?? null;
	}
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry && ctx.translationOf !== undefined) {
		const { sourceId, value } = ctx.translationOf;
````
with:
````ts
		media[field] = item?.blocks ?? null;
	}
	const data = { ...mapped.data, ...media };
	// The journal row comes before the first write, so a crash leaves nothing it does not know of.
	if (journaling(job)) {
		const failure = await journalWrite(ctx, entry, plan, data, media);
		if (failure) {
			return {
				status: "failed",
				sourceKey,
				entryId: entry?.id ?? null,
				action: plan.action,
				errors: [failure],
			};
		}
	}
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	let written: { id: string; rev: string };
	if (!entry && ctx.translationOf !== undefined) {
		const { sourceId, value } = ctx.translationOf;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		}
		written = { id: entry.id, rev: result.rev };
	}
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
````
with:
````ts
		}
		written = { id: entry.id, rev: result.rev };
	}
	if (!entry && journaling(job)) await journalCreated(ctx, written.id, true);
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
````

Create `packages/flux-import/src/engine/journal.ts`:
````ts
import type { CurrentLinks } from "./diff.js";
import type { EntrySnapshot } from "./ports.js";
import { sameStored } from "./rollback-values.js";
import { SOURCE_ID_FIELD } from "./template.js";
import {
	type EngineDeps,
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	type LinkRow,
	MAX_JOURNAL_BYTES,
	type RecordError,
} from "./types.js";

const CAS_ATTEMPTS = 5;

/** Whether the job keeps a journal: a real run created with `journal: true` (M5a). */
export function journaling(job: Job): boolean {
	return job.journal === true && !job.dryRun;
}

/** Where a record's journal row goes and what it names. */
export type JournalTarget = {
	deps: EngineDeps;
	job: Job;
	seq: number;
	sourceKey: string;
	linkId: string;
};

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

function base(t: JournalTarget): Omit<JournalEntry, "kind" | "entryId"> {
	const { collection, locale } = t.job.template;
	return {
		jobId: t.job.id,
		seq: t.seq,
		collection,
		locale,
		sourceKey: t.sourceKey,
		at: iso(t.deps),
	};
}

function tooLarge(row: JournalEntry): RecordError | null {
	const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
	if (bytes <= MAX_JOURNAL_BYTES) return null;
	return {
		code: "journal_too_large",
		message: `Not imported: what the entry holds now is ${bytes} bytes, more than the journal keeps (${MAX_JOURNAL_BYTES}); import with journal: false to skip rollback support`,
	};
}

/**
 * The fields whose draft and live values differ: what publishing the entry's pending draft makes
 * live. Empty when the entry has no draft.
 */
export function draftFields(entry: EntrySnapshot): string[] {
	const live = entry.live;
	if (live === undefined) return [];
	const fields = new Set([...Object.keys(live), ...Object.keys(entry.data)]);
	fields.delete(SOURCE_ID_FIELD);
	return [...fields].filter((f) => !sameStored(live[f], entry.data[f]));
}

/** What a write is about to change, for `preImage`. */
export type Touched = {
	/** Data fields the write changes or publishes. */
	fields: readonly string[];
	slug: boolean;
	taxonomies: readonly string[];
	references: readonly string[];
	bylines: boolean;
};

/**
 * The entry's pre-image for the fields and links a write touches, read from the snapshot the
 * import already made (`current` for the terms). A changed reference field whose selection was
 * truncated cannot be restored: `journal_incomplete`.
 */
export function preImage(
	entry: EntrySnapshot,
	link: LinkRow | null,
	touched: Touched,
	current: CurrentLinks | undefined,
): JournalBefore | RecordError {
	const truncated = touched.references.filter((f) => entry.referencesTruncated?.includes(f));
	if (truncated.length > 0) {
		return {
			field: truncated[0] as string,
			code: "journal_incomplete",
			message:
				"Not imported: the field holds more references than the import reads, so a rollback could not restore it",
		};
	}
	const live: Record<string, unknown> = {};
	const draft: Record<string, unknown> = {};
	for (const field of touched.fields) {
		live[field] = (entry.live ?? entry.data)[field] ?? null;
		if (entry.live) draft[field] = entry.data[field] ?? null;
	}
	const links: NonNullable<JournalBefore["links"]> = {};
	for (const taxonomy of touched.taxonomies) {
		links.taxonomies ??= {};
		links.taxonomies[taxonomy] = (current?.taxonomies?.[taxonomy] ?? []).map((t) => t.group);
	}
	for (const field of touched.references) {
		links.references ??= {};
		links.references[field] = (entry.references?.[field] ?? []).map((r) => r.id);
	}
	if (touched.bylines) {
		links.bylines = (entry.bylines ?? []).map((b) => ({ bylineId: b.id, roleLabel: b.roleLabel }));
	}
	return {
		link: link === null ? null : linkBefore(link),
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		...(touched.slug ? { slug: entry.slug } : {}),
		live,
		...(entry.live ? { draft } : {}),
		...(Object.keys(links).length > 0 ? { links } : {}),
	};
}

function linkBefore(link: LinkRow): NonNullable<JournalBefore["link"]> {
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
	};
}

/**
 * The first touch's pre-image with what a later write of the same job adds: fields and links the
 * earlier writes did not touch, read before this write (so still the pre-run value). Status,
 * schedule and the link row stay the first touch's. Null when nothing is new.
 */
export function mergeBefore(first: JournalBefore, next: JournalBefore): JournalBefore | null {
	let changed = false;
	const merged: JournalBefore = structuredClone(first);
	for (const [field, value] of Object.entries(next.live)) {
		if (Object.hasOwn(merged.live, field)) continue;
		merged.live[field] = value;
		// A field the earlier writes did not touch has the same draft and live value then.
		if (merged.draft) merged.draft[field] = next.draft?.[field] ?? value;
		changed = true;
	}
	if (next.slug !== undefined && merged.slug === undefined) {
		merged.slug = next.slug;
		changed = true;
	}
	for (const kind of ["taxonomies", "references"] as const) {
		for (const [name, items] of Object.entries(next.links?.[kind] ?? {})) {
			if (merged.links?.[kind]?.[name] !== undefined) continue;
			merged.links ??= {};
			merged.links[kind] ??= {};
			(merged.links[kind] as Record<string, string[]>)[name] = items;
			changed = true;
		}
	}
	if (next.links?.bylines && !merged.links?.bylines) {
		merged.links ??= {};
		merged.links.bylines = next.links.bylines;
		changed = true;
	}
	return changed ? merged : null;
}

/**
 * Write-ahead for an update: stores the pre-image before the job's first write to the entry
 * (put-if-absent), or adds what this write touches first to the row an earlier write stored. A
 * row too large fails the record before any write.
 */
export async function journalUpdate(
	t: JournalTarget,
	entryId: string,
	before: JournalBefore,
): Promise<RecordError | null> {
	const key = journalKey(t.job.id, t.linkId);
	const row: JournalEntry = { ...base(t), kind: "update", entryId, before };
	const large = tooLarge(row);
	if (large) return large;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		if ((await t.deps.journal.compareAndSet(key, null, row)).applied) return null;
		const stored = await t.deps.journal.getVersioned(key);
		if (!stored) continue;
		// The job created the entry: rolling back deletes it, whatever it wrote afterwards.
		if (stored.value.kind !== "update" || stored.value.before === undefined) return null;
		const merged = mergeBefore(stored.value.before, before);
		if (merged === null) return null;
		const next: JournalEntry = { ...stored.value, before: merged };
		const larger = tooLarge(next);
		if (larger) return larger;
		if ((await t.deps.journal.compareAndSet(key, stored.revision, next)).applied) return null;
	}
	throw new Error(`Could not save the journal row ${key} after ${CAS_ATTEMPTS} attempts`);
}

/**
 * Write-ahead for a create: `entryId` stays null until the create returns. A create row an
 * earlier attempt stored is kept; an update row (its entry has gone since) is replaced.
 */
export async function journalCreate(t: JournalTarget, sourceIdValue: string): Promise<void> {
	const key = journalKey(t.job.id, t.linkId);
	const row: JournalEntry = { ...base(t), kind: "create", entryId: null, sourceIdValue };
	if ((await t.deps.journal.compareAndSet(key, null, row)).applied) return;
	const stored = await t.deps.journal.get(key);
	if (stored?.kind === "create") return;
	await t.deps.journal.put(key, row);
}

/**
 * Records the entry of a create row: `confirmed` when this job's create returned it, not when
 * crash repair found it (it may be an editor's). A row that already names an entry is kept.
 */
export async function journalCreated(
	t: Pick<JournalTarget, "deps" | "job" | "linkId">,
	entryId: string,
	confirmed: boolean,
): Promise<void> {
	const key = journalKey(t.job.id, t.linkId);
	const stored = await t.deps.journal.get(key);
	if (stored?.kind !== "create") return;
	if (stored.entryId !== null && !confirmed) return;
	await t.deps.journal.put(key, { ...stored, entryId, confirmed });
}
````

In `packages/flux-import/src/engine/media.ts`, replace
````ts
import { parseSourceUrl } from "../sources/net.js";
import { ContentWriteError, type MediaInfo, MediaUploadError } from "./ports.js";
import { COST_CALL, COST_MEDIA, type LinkError, type LookupCache } from "./resolve.js";
import type { EngineDeps, MediaMapRow } from "./types.js";
import type { JsonValue, TargetField } from "./values.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
````
with:
````ts
import { parseSourceUrl } from "../sources/net.js";
import { ContentWriteError, type MediaInfo, MediaUploadError } from "./ports.js";
import { COST_CALL, COST_MEDIA, type LinkError, type LookupCache } from "./resolve.js";
import { type EngineDeps, journalMediaKey, type MediaMapRow } from "./types.js";
import type { JsonValue, TargetField } from "./values.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
````

In `packages/flux-import/src/engine/media.ts`, replace
````ts
/** The least time a download other than the batch's first may start with. */
export const MEDIA_MIN_LEFT_MS = 5000;

export type MediaDeps = Pick<EngineDeps, "media" | "mediaFetcher" | "mediaMap" | "now">;

/** What the resolver needs from the job. */
export type MediaContext = {
````
with:
````ts
/** The least time a download other than the batch's first may start with. */
export const MEDIA_MIN_LEFT_MS = 5000;

export type MediaDeps = Pick<
	EngineDeps,
	"media" | "mediaFetcher" | "mediaMap" | "journalMedia" | "now"
>;

/** What the resolver needs from the job. */
export type MediaContext = {
````

In `packages/flux-import/src/engine/media.ts`, replace
````ts
	maxBytes: number;
	/** The job's target field snapshot: each media field's `allowedMimeTypes`. */
	targets: Readonly<Record<string, TargetField>>;
};

/** One media field after the map lookup. */
````
with:
````ts
	maxBytes: number;
	/** The job's target field snapshot: each media field's `allowedMimeTypes`. */
	targets: Readonly<Record<string, TargetField>>;
	/** A real job with a journal (M5a): items its uploads create are journalled under `seq`. */
	journal?: { seq: number };
};

/** One media field after the map lookup. */
````

In `packages/flux-import/src/engine/media.ts`, replace
````ts
			...(request.alt === null ? {} : { alt: request.alt }),
		});
		cache.mediaItems.set(item.id, item);
		await deps.mediaMap.put(lookup.key, {
			url: request.url,
			mediaId: item.id,
````
with:
````ts
			...(request.alt === null ? {} : { alt: request.alt }),
		});
		cache.mediaItems.set(item.id, item);
		// Before the map row, so the item is on the job's list whatever happens next (M5a).
		if (!deduplicated && ctx.journal) {
			await deps.journalMedia.put(journalMediaKey(ctx.jobId, item.id), {
				jobId: ctx.jobId,
				mediaId: item.id,
				url: request.url,
				seq: ctx.journal.seq,
			});
		}
		await deps.mediaMap.put(lookup.key, {
			url: request.url,
			mediaId: item.id,
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/journal.test.ts tests/unit/link-import.test.ts`
Expected: PASS (2 files, 34 tests). Full suite after this task: 59 files / 1,403 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/journal.ts packages/flux-import/src/engine/batch.ts packages/flux-import/src/engine/media.ts packages/flux-import/tests/unit/journal.test.ts packages/flux-import/tests/unit/rollback-fixture.ts packages/flux-import/tests/unit/link-import.test.ts
git commit -m "Journal a pre-image before every write of a real job, record the media it creates, and stamp link rows with the job"
```

### Task 5: Rollback jobs, retention, route and Workers cap

**Files:**
- Create: `packages/flux-import/src/engine/rollback.ts`
- Modify: `packages/flux-import/src/plugin/retention.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/service.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/rollback-jobs.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`, `packages/flux-import/tests/unit/retention.test.ts`

**Interfaces:**
- Consumes: Task 1's job fields, `batchOptions`, `clearLastImport`; Task 4's journal rows, `journalMedia` and `tests/unit/rollback-fixture.ts`; `JobError`, `purgeExpired`, `workersBatchCap`, `WORKERS_LINKED_BATCH_CAP`, `withServices`, `route`.
- Produces: `MAX_LISTED_MEDIA = 100`; `RollbackInput`; `rollbackRefusal(job, now)`; `rollbackWarnings(deps, jobId)`; `createRollback(deps, input): Promise<{ rollback; original }>` (Ruling 6); `PurgeResult.journal`; `purgeExpired` takes `journal` and `journalMedia` (Ruling 9); `WORKERS_ROLLBACK_BATCH_CAP = 3` (Ruling 2); the route `jobs/rollback` (`id`, `dryRun?`, `batchSize?`, `budgetMs?`); `jobs/records` accepts the status `reverted`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/definition.test.ts`, replace
````ts
	"jobs/resume",
	"jobs/cancel",
	"jobs/retry",
	"jobs/records",
	"jobs/log.csv",
	"schema/apply",
````
with:
````ts
	"jobs/resume",
	"jobs/cancel",
	"jobs/retry",
	"jobs/rollback",
	"jobs/records",
	"jobs/log.csv",
	"schema/apply",
````

In `packages/flux-import/tests/unit/retention.test.ts`, replace
````ts

		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toEqual({ jobs: 1, records: 2, uploads: 2 });
		expect(await deps.jobs.get(old.id)).toBeNull();
		expect(await deps.jobs.get(recent.id)).not.toBeNull();
		expect((await deps.records.query({ where: { jobId: old.id } })).items).toEqual([]);
````
with:
````ts

		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toEqual({ jobs: 1, records: 2, journal: 2, uploads: 2 });
		expect(await deps.jobs.get(old.id)).toBeNull();
		expect(await deps.jobs.get(recent.id)).not.toBeNull();
		expect((await deps.records.query({ where: { jobId: old.id } })).items).toEqual([]);
````

Create `packages/flux-import/tests/unit/rollback-jobs.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { createRollback, rollbackRefusal } from "../../src/engine/rollback.js";
import type { Job } from "../../src/engine/types.js";
import { purgeExpired } from "../../src/plugin/retention.js";
import {
	WORKERS_LINKED_BATCH_CAP,
	WORKERS_ROLLBACK_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { type Deps, importRows, setup, url } from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, tags: "new" };
const DAY = 24 * 60 * 60 * 1000;

async function patch(deps: Deps, id: string, change: Partial<Job>) {
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, ...change });
}

describe("jobs/rollback (M5a)", () => {
	it("creates a rollback job that reads the journal newest first, and marks the original", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const { rollback, original: marked } = await createRollback(deps, {
			id: original.id,
			batchSize: 5,
		});
		expect(rollback).toMatchObject({
			status: "created",
			kind: "rollback",
			rollbackOf: original.id,
			uploadId: original.uploadId,
			template: original.template,
			targetFields: original.targetFields,
			dryRun: false,
			publish: false,
			batchSize: 5,
			budgetMs: 4000,
			cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
			counters: { reverted: 0, created: 0 },
			phase: "import",
			retryFromSeq: Number.MAX_SAFE_INTEGER,
			schemaReady: true,
			warnings: [],
		});
		expect(marked.rolledBackBy).toBe(rollback.id);
		expect((await deps.jobs.get(original.id))?.rolledBackBy).toBe(rollback.id);
		expect(await deps.jobs.get(rollback.id)).toEqual(rollback);
	});

	it("sets nothing for a dry run, and allows any number of them", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const first = await createRollback(deps, { id: original.id, dryRun: true });
		const second = await createRollback(deps, { id: original.id, dryRun: true });
		expect(first.rollback.dryRun).toBe(true);
		expect(second.rollback.id).not.toBe(first.rollback.id);
		expect(await deps.jobs.get(original.id)).not.toHaveProperty("rolledBackBy");
	});

	it("refuses dry runs, rollbacks, jobs without a journal, running jobs and a second rollback", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const refused = (id: string) =>
			createRollback(deps, { id }).catch((e: { code: string; message: string }) => e);
		const dry = await importRows(deps, [desk], { dryRun: true });
		expect(await refused(dry.id)).toMatchObject({
			code: "invalid_transition",
			message: "Cannot roll back a dry-run job: it wrote nothing",
		});
		const plain = await importRows(deps, [desk], { journal: false });
		expect(await refused(plain.id)).toMatchObject({
			message:
				"The job has no journal: it was created before rollback support or with journal: false",
		});
		const { rollback } = await createRollback(deps, { id: original.id });
		expect(await refused(rollback.id)).toMatchObject({
			message: "Cannot roll back a rollback job",
		});
		expect(await refused(original.id)).toMatchObject({
			message: `The job was already rolled back (rollback job ${rollback.id})`,
		});
		expect(await refused("nope")).toMatchObject({ code: "not_found" });
		await expect(createRollback(deps, { id: plain.id, batchSize: 0 })).rejects.toMatchObject({
			code: "invalid_options",
		});
	});

	it("refuses a job that may still write, until it is cancelled", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const now = deps.now();
		for (const status of ["created", "running", "paused"] as const) {
			expect(rollbackRefusal({ ...job, status }, now)).toBe(
				`Cannot roll back a ${status} job: cancel it first`,
			);
		}
		for (const status of ["completed", "cancelled", "failed"] as const) {
			expect(rollbackRefusal({ ...job, status }, now)).toBeNull();
		}
		const leased = {
			...job,
			status: "failed" as const,
			lease: { holder: "x", expiresAt: now + 1 },
		};
		expect(rollbackRefusal(leased, now)).toBe(
			"Cannot roll back the job while one of its batches is running",
		);
		expect(rollbackRefusal({ ...job, journal: undefined as never }, now)).toContain("no journal");
	});

	it("deletes the new job when the original changed meanwhile", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const cas = deps.jobs.compareAndSet.bind(deps.jobs);
		deps.jobs.compareAndSet = async (id, expected, data) =>
			id === original.id ? { applied: false } : cas(id, expected, data);
		await expect(createRollback(deps, { id: original.id })).rejects.toMatchObject({
			code: "invalid_transition",
			message: "The job changed while its rollback was being created; try again",
		});
		expect((await deps.jobs.query({ where: { kind: "rollback" } })).items).toEqual([]);
	});

	it("warns about the media and terms the import created, which are kept", async () => {
		const { deps } = setup();
		const original = await importRows(
			deps,
			[
				{ ...desk, img: url("a.png"), tags: "fresh" },
				{ sku: "A2", name: "Lamp", img: url("b.png"), tags: "fresh|bright" },
			],
			{ extra: { taxonomies: { tag: { from: "Tags", separator: "|", create: true } } } },
		);
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		expect(rollback.warnings).toEqual([
			"The import created 2 media items, which are kept (EmDash cannot tell whether other content uses them): m1, m2",
			"The import created 2 terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms",
		]);
	});

	it("lists at most 100 media IDs, then a count", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		for (let i = 0; i < 102; i++) {
			await deps.journalMedia.put(`${original.id}:m${i}`, {
				jobId: original.id,
				mediaId: `m${i}`,
				url: url(`${i}.png`),
				seq: i,
			});
		}
		const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
		const [warning] = rollback.warnings ?? [];
		expect(warning).toMatch(
			/^The import created 102 media items, .*: m0, m1, .*, m99, and 2 more$/,
		);
	});

	it("caps a rollback batch on Workers at three rows", () => {
		expect(WORKERS_ROLLBACK_BATCH_CAP).toBe(3);
		const job = { template: { fields: {}, collection: "p", locale: "en" } } as unknown as Job;
		expect(workersBatchCap({ ...job, kind: "rollback" })).toBe(3);
		expect(workersBatchCap({ ...job, template: { ...job.template, taxonomies: {} } } as Job)).toBe(
			WORKERS_LINKED_BATCH_CAP,
		);
	});
});

describe("retention of journals and rollbacks (M5a)", () => {
	const purger = { purgeBefore: async () => 0 };

	it("deletes an expired job's journal rows, and keeps an original whose rollback may still run", async () => {
		const { deps, clock } = setup();
		const kept = await importRows(deps, [desk]);
		const gone = await importRows(deps, [{ sku: "B1", name: "Bench", img: url("a.png") }]);
		clock.t += 31 * DAY;
		const { rollback } = await createRollback(deps, { id: kept.id });
		const result = await purgeExpired(deps, purger, 30);
		// The original of a rollback job that may still run stays; the other job goes.
		expect(result).toMatchObject({ jobs: 1, journal: 2 });
		expect(await deps.jobs.get(gone.id)).toBeNull();
		expect(await deps.jobs.get(kept.id)).not.toBeNull();
		expect((await deps.journal.query({ where: { jobId: gone.id } })).items).toEqual([]);
		expect((await deps.journalMedia.query({ where: { jobId: gone.id } })).items).toEqual([]);
		expect((await deps.journal.query({ where: { jobId: kept.id } })).items).toHaveLength(1);
		// Once the rollback is done, the original goes.
		await patch(deps, rollback.id, { status: "completed" });
		expect(await purgeExpired(deps, purger, 30)).toMatchObject({ jobs: 1, journal: 1 });
		expect(await deps.jobs.get(kept.id)).toBeNull();
	});

	it("does not keep the original's file for a rollback job", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		const { rollback } = await createRollback(deps, { id: original.id });
		await deps.jobs.delete(original.id);
		const keeps: ReadonlySet<string>[] = [];
		await purgeExpired(
			deps,
			{
				purgeBefore: async (_cutoff: Date, keep: ReadonlySet<string> = new Set()) => {
					keeps.push(keep);
					return 0;
				},
			},
			30,
		);
		expect(await deps.jobs.get(rollback.id)).not.toBeNull();
		expect(keeps[0]?.has(original.uploadId)).toBe(false);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/retention.test.ts tests/unit/rollback-jobs.test.ts`
Expected: FAIL (3 files: `rollback-jobs.test.ts` cannot load `src/engine/rollback.ts`; `definition.test.ts` and `retention.test.ts` fail 2 of their 20 tests, the new route and the journal count).

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/engine/rollback.ts`:
````ts
import { batchOptions, JobError, upgradeJob } from "./jobs.js";
import { type EngineDeps, emptyCounters, type Job } from "./types.js";

/** Media IDs the rollback job's warning lists; past them it gives a count. */
export const MAX_LISTED_MEDIA = 100;
const PAGE = 100; // plugin storage query limit

export type RollbackInput = {
	/** The import job to roll back. */
	id: string;
	dryRun?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

/** Why `job` cannot be rolled back now, or null when it can (spec M5a "Which jobs"). */
export function rollbackRefusal(job: Job, now: number): string | null {
	if (job.kind === "rollback") return "Cannot roll back a rollback job";
	if (job.dryRun) return "Cannot roll back a dry-run job: it wrote nothing";
	if (job.journal !== true) {
		return "The job has no journal: it was created before rollback support or with journal: false";
	}
	if (job.rolledBackBy !== undefined) {
		return `The job was already rolled back (rollback job ${job.rolledBackBy})`;
	}
	if (job.status === "created" || job.status === "running" || job.status === "paused") {
		return `Cannot roll back a ${job.status} job: cancel it first`;
	}
	if (job.lease && job.lease.expiresAt > now) {
		return "Cannot roll back the job while one of its batches is running";
	}
	return null;
}

/**
 * The rollback job's warnings: the media items the import created and the terms it created,
 * both kept (spec M5a F13, F14).
 */
export async function rollbackWarnings(deps: EngineDeps, jobId: string): Promise<string[]> {
	const warnings: string[] = [];
	const media: string[] = [];
	let count = 0;
	let cursor: string | undefined;
	do {
		const page = await deps.journalMedia.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			count++;
			if (media.length < MAX_LISTED_MEDIA) media.push(data.mediaId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	if (count > 0) {
		const more = count > media.length ? `, and ${count - media.length} more` : "";
		warnings.push(
			`The import created ${count} media items, which are kept (EmDash cannot tell whether other content uses them): ${media.join(", ")}${more}`,
		);
	}
	const terms = new Set<string>();
	cursor = undefined;
	do {
		const page = await deps.records.query({
			where: { jobId },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) for (const term of data.newTerms ?? []) terms.add(term);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	if (terms.size > 0) {
		warnings.push(
			`The import created ${terms.size} terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms`,
		);
	}
	return warnings;
}

/**
 * Creates the rollback job of an import (`jobs/rollback`), driven by `jobs/next`. A real rollback
 * marks the original `rolledBackBy` with compare-and-set after creating the rollback job, and
 * deletes the new job when it loses the race. Returns both jobs.
 */
export async function createRollback(
	deps: EngineDeps,
	input: RollbackInput,
): Promise<{ rollback: Job; original: Job }> {
	const { batchSize, budgetMs } = batchOptions(input);
	const current = await deps.jobs.getVersioned(input.id);
	if (!current) throw new JobError("not_found", `Job ${input.id} not found`);
	const original = upgradeJob(current.value);
	const refusal = rollbackRefusal(original, deps.now());
	if (refusal !== null) throw new JobError("invalid_transition", refusal);
	const dryRun = input.dryRun ?? false;
	const warnings = await rollbackWarnings(deps, original.id);
	const now = new Date(deps.now()).toISOString();
	const rollback: Job = {
		id: deps.newId(),
		status: "created",
		kind: "rollback",
		rollbackOf: original.id,
		// Shown for the collection and locale; a rollback never reads the original's file.
		uploadId: original.uploadId,
		template: original.template,
		dryRun,
		publish: false,
		batchSize,
		budgetMs,
		...(original.targetFields === undefined ? {} : { targetFields: original.targetFields }),
		warnings,
		// Journal rows are read newest first, below `cursor.seq`.
		cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
		counters: { ...emptyCounters(), reverted: 0 },
		lease: null,
		phase: "import",
		retryFromSeq: Number.MAX_SAFE_INTEGER,
		schemaReady: true,
		error: null,
		failures: 0,
		createdAt: now,
		updatedAt: now,
	};
	const created = await deps.jobs.compareAndSet(rollback.id, null, rollback);
	if (!created.applied) throw new Error(`Job id ${rollback.id} already exists`);
	if (dryRun) return { rollback, original };
	const marked = await deps.jobs.compareAndSet(original.id, current.revision, {
		...current.value,
		rolledBackBy: rollback.id,
		updatedAt: now,
	});
	if (!marked.applied) {
		await deps.jobs.delete(rollback.id);
		throw new JobError(
			"invalid_transition",
			"The job changed while its rollback was being created; try again",
		);
	}
	return { rollback, original: { ...original, rolledBackBy: rollback.id } };
}
````

In `packages/flux-import/src/plugin/definition.ts`, replace
````ts
					const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
					const result = await withRuntime(async (runtime) => {
						if (!runtime.storage) throw new Error("flux-import: EmDash storage is not configured");
						const { jobs, records } = pluginCollections(ctx.storage);
						return purgeExpired(
							{ jobs, records, now: Date.now },
							new EmDashUploads(runtime.storage),
							days,
							await latestSourceUploads(sourcesCollection(ctx.storage)),
````
with:
````ts
					const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
					const result = await withRuntime(async (runtime) => {
						if (!runtime.storage) throw new Error("flux-import: EmDash storage is not configured");
						const { jobs, records, journal, journalMedia } = pluginCollections(ctx.storage);
						return purgeExpired(
							{ jobs, records, journal, journalMedia, now: Date.now },
							new EmDashUploads(runtime.storage),
							days,
							await latestSourceUploads(sourcesCollection(ctx.storage)),
````

In `packages/flux-import/src/plugin/retention.ts`, replace
````ts
import type { EngineDeps } from "../engine/types.js";

export const RETENTION_TASK = "retention";
/** Daily at 03:00 UTC; EmDash evaluates cron expressions in UTC on every host. */
````
with:
````ts
import type { KvCollection } from "../engine/ports.js";
import type { EngineDeps, Job } from "../engine/types.js";

export const RETENTION_TASK = "retention";
/** Daily at 03:00 UTC; EmDash evaluates cron expressions in UTC on every host. */
````

In `packages/flux-import/src/plugin/retention.ts`, replace
````ts
export interface PurgeResult {
	jobs: number;
	records: number;
	uploads: number;
}
````
with:
````ts
export interface PurgeResult {
	jobs: number;
	records: number;
	/** Journal and journalMedia rows (M5a). */
	journal: number;
	uploads: number;
}
````

In `packages/flux-import/src/plugin/retention.ts`, replace
````ts
	purgeBefore(cutoff: Date, keep?: ReadonlySet<string>): Promise<number>;
}

async function deleteRecords(deps: Pick<EngineDeps, "records">, jobId: string): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await deps.records.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return deleted;
		const n = await deps.records.deleteMany(page.items.map((i) => i.id));
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return deleted;
		deleted += n;
	}
}

/**
 * Deletes jobs created before the cutoff with their record rows, and staged files last modified
 * before it, except files in `keepUploads`. A job with a live lease is left for the next run.
 * Links are kept: they map source keys to entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
````
with:
````ts
	purgeBefore(cutoff: Date, keep?: ReadonlySet<string>): Promise<number>;
}

type JobRows = Pick<KvCollection<unknown>, "query" | "deleteMany">;

/** Deletes a job's rows of one collection (records, journal or journalMedia). */
async function deleteRows(rows: JobRows, jobId: string): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await rows.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return deleted;
		const n = await rows.deleteMany(page.items.map((i) => i.id));
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return deleted;
		deleted += n;
	}
}

/** A rollback job that may still run, which needs its original's journal. */
async function rollbackPending(deps: Pick<EngineDeps, "jobs">, job: Job): Promise<boolean> {
	if (job.rolledBackBy === undefined) return false;
	const rollback = await deps.jobs.get(job.rolledBackBy);
	return rollback !== null && ["created", "running", "paused"].includes(rollback.status);
}

/**
 * Deletes jobs created before the cutoff with their record and journal rows, and staged files
 * last modified before it, except files in `keepUploads`. A job with a live lease, or whose
 * rollback job may still run, is left for the next run. Links are kept: they map source keys to
 * entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
````

In `packages/flux-import/src/plugin/retention.ts`, replace
````ts
			...(cursor ? { cursor } : {}),
		});
		for (const { id, data } of page.items) {
			if (!(data.lease && data.lease.expiresAt > now)) expired.push(id);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	let records = 0;
	for (const id of expired) {
		records += await deleteRecords(deps, id);
		await deps.jobs.delete(id);
	}
````
with:
````ts
			...(cursor ? { cursor } : {}),
		});
		for (const { id, data } of page.items) {
			if (data.lease && data.lease.expiresAt > now) continue;
			if (await rollbackPending(deps, data)) continue;
			expired.push(id);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	let records = 0;
	let journal = 0;
	for (const id of expired) {
		records += await deleteRows(deps.records, id);
		journal += await deleteRows(deps.journal, id);
		journal += await deleteRows(deps.journalMedia, id);
		await deps.jobs.delete(id);
	}
````

In `packages/flux-import/src/plugin/retention.ts`, replace
````ts
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of page.items) {
			keep.add(data.uploadId);
			if (data.sourceUploadId !== undefined) keep.add(data.sourceUploadId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return { jobs: expired.length, records, uploads: await uploads.purgeBefore(cutoff, keep) };
}
````
with:
````ts
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of page.items) {
			// A rollback job names its original's file but never reads it.
			if (data.kind === "rollback") continue;
			keep.add(data.uploadId);
			if (data.sourceUploadId !== undefined) keep.add(data.sourceUploadId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return {
		jobs: expired.length,
		records,
		journal,
		uploads: await uploads.purgeBefore(cutoff, keep),
	};
}
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
````
with:
````ts
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import { createRollback } from "../engine/rollback.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
	"failed",
	"planned",
	"filtered",
] as const satisfies readonly RecordStatus[];

const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
````
with:
````ts
	"failed",
	"planned",
	"filtered",
	"reverted",
] as const satisfies readonly RecordStatus[];

const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
		),
	),

	"jobs/pause": transition("pause"),
	"jobs/resume": transition("resume"),
	"jobs/cancel": transition("cancel"),
````
with:
````ts
		),
	),

	// A real rollback marks the original rolled back and frees its URL source for a re-import.
	"jobs/rollback": route(
		z.object({
			id: jobId,
			dryRun: z.boolean().optional(),
			batchSize: z.number().int().optional(),
			budgetMs: z.number().int().optional(),
		}),
		(ctx) =>
			withServices(ctx, async ({ deps, sources }) => {
				const { id, dryRun, batchSize, budgetMs } = ctx.input;
				const { rollback, original } = await createRollback(deps, {
					id,
					...(dryRun === undefined ? {} : { dryRun }),
					...(batchSize === undefined ? {} : { batchSize }),
					...(budgetMs === undefined ? {} : { budgetMs }),
				});
				if (!rollback.dryRun && original.sourceId !== undefined) {
					await clearLastImport(sources, original.sourceId, original.id).catch(() => {});
				}
				return rollback;
			}),
	),

	"jobs/pause": transition("pause"),
	"jobs/resume": transition("resume"),
	"jobs/cancel": transition("cancel"),
````

In `packages/flux-import/src/plugin/service.ts`, replace
````ts
 */
export const WORKERS_LINKED_BATCH_CAP = 10;

/**
 * The lookup cost one jobs/next call may spend on Workers (see `COST_READ`): D1 allows 1,000
 * queries per invocation, and EmDash's lookups run several queries per call.
````
with:
````ts
 */
export const WORKERS_LINKED_BATCH_CAP = 10;

/**
 * Rollback rows one jobs/next call reverts on Workers (M5a). A reverted update runs up to seven
 * content calls, about 175-265 D1 queries with EmDash's own (spec M5a V5 results), so three rows
 * stay under the 1,000-query limit.
 */
export const WORKERS_ROLLBACK_BATCH_CAP = 3;

/**
 * The lookup cost one jobs/next call may spend on Workers (see `COST_READ`): D1 allows 1,000
 * queries per invocation, and EmDash's lookups run several queries per call.
````

In `packages/flux-import/src/plugin/service.ts`, replace
````ts

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	return usesLinks(job.template) || usesMedia(job.template)
		? WORKERS_LINKED_BATCH_CAP
		: WORKERS_BATCH_CAP;
````
with:
````ts

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	if (job.kind === "rollback") return WORKERS_ROLLBACK_BATCH_CAP;
	return usesLinks(job.template) || usesMedia(job.template)
		? WORKERS_LINKED_BATCH_CAP
		: WORKERS_BATCH_CAP;
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/definition.test.ts tests/unit/retention.test.ts tests/unit/rollback-jobs.test.ts`
Expected: PASS (3 files, 30 tests). Full suite after this task: 60 files / 1,413 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/rollback.ts packages/flux-import/src/plugin packages/flux-import/tests/unit/rollback-jobs.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/retention.test.ts
git commit -m "Create rollback jobs through jobs/rollback, purge journals with their jobs, and cap Workers rollback batches at three rows"
```

### Task 6: The rollback pass

**Files:**
- Create: `packages/flux-import/src/engine/revert.ts`
- Modify: `packages/flux-import/src/engine/resolve.ts`, `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/rollback.test.ts`

**Interfaces:**
- Consumes: Task 2's `getIncludingTrashed`, `trash`, `permanentDelete`, `revertStep`, `StepResult`, the fakes' `blockDelete`/`blockStep`/`beforeStep`/`plainCollections`; Task 3's `sameStored`, `restoredData`; Task 4's journal rows and fixture; Task 5's `createRollback`; `LookupCache`, `lookupTerms`/`bylineIndex` (through the new helpers), `findBySourceId`, `translations`, `isLocked`, `recordKey`, `linkKey`, `bump`.
- Produces: `termOfGroup(cache, taxonomy, group)`, `bylineIdsOf(deps, cache, locale)` in `resolve.ts`; `CHANGED_MESSAGE`; `rollbackPass(deps, job, started, limit, cache)` and `rollbackRetryPass(…)` (spec "Per row", "Created entries", "Revert sequence", "Links after a rollback", "Dry run"; Rulings 3, 5 and 8); `runBatch` runs them for `job.kind === "rollback"` (the import's steps move to `importBatch`).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/rollback.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { createRollback } from "../../src/engine/rollback.js";
import { sameStored } from "../../src/engine/rollback-values.js";
import { type Job, journalKey, linkKey, recordKey } from "../../src/engine/types.js";
import { type Deps, entryOf, importRows, records, runToEnd, setup } from "./rollback-fixture.js";

const desk = { sku: "A1", name: "Desk", price: 10, featured: true, tags: "new", authors: "alex" };
const changed = {
	...desk,
	name: "Table",
	price: 12,
	featured: false,
	tags: "sale",
	authors: "sam",
};
const linkOf = (deps: Deps, key: string) => deps.links.get(linkKey("products", "en", key));

/** What a rollback restores: status, schedule, slug, data, draft and links (empty links absent). */
function stateOf(deps: Deps, key: string) {
	const e = entryOf(deps, key);
	const links = (m: Record<string, string[]>) =>
		Object.fromEntries(Object.entries(m).filter(([, v]) => v.length > 0));
	return structuredClone({
		status: e.status,
		scheduledAt: e.scheduledAt,
		slug: e.slug,
		data: e.data,
		live: e.live,
		taxonomies: links(e.taxonomies),
		references: links(e.references),
		bylines: e.bylines,
	});
}

type State = ReturnType<typeof stateOf>;

/** Equal under the rollback's comparison (spec M5a V1). */
function expectRestored(after: State, before: State) {
	const { data: a, live: al, ...restA } = after;
	const { data: b, live: bl, ...restB } = before;
	expect(restA).toEqual(restB);
	expect(sameStored(a, b)).toBe(true);
	expect(sameStored(al, bl)).toBe(true);
}

async function rollBack(
	deps: Deps,
	id: string,
	opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { rollback } = await createRollback(deps, { id, ...opts });
	return runToEnd(deps, rollback.id);
}

/** Runs batches until one fails with `message`, then clears the lease as a takeover would. */
async function crash(deps: Deps, id: string, message: string) {
	await expect(runBatch(deps, id, "driver")).rejects.toThrow(message);
	const job = (await deps.jobs.get(id)) as Job;
	await deps.jobs.put(id, { ...job, lease: null });
}

const count = (deps: Deps, call: string) => deps.content.calls.filter((c) => c === call).length;

describe("rolling back an import (M5a)", () => {
	it("deletes the entries the job created and restores the ones it changed, newest first", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
		expect(job.counters).toMatchObject({ created: 1, updated: 1 });
		const lamp = entryOf(deps, "A2").id;
		const done = await rollBack(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { reverted: 2, conflict: 0 } });
		expect(deps.content.entries.has(lamp)).toBe(false);
		expectRestored(stateOf(deps, "A1"), before);
		const rows = await records(deps, done.id);
		// Newest first: the record of A2 (seq 1) before A1 (seq 0).
		expect(rows.map((r) => [r.seq, r.status, r.action])).toEqual([
			[0, "reverted", "revert"],
			[1, "reverted", "delete"],
		]);
		expect(deps.content.calls.filter((c) => /^(trash|delete):/.test(c))).toEqual([
			`trash:${lamp}`,
			`delete:${lamp}`,
		]);
		expect(await linkOf(deps, "A2")).toBeNull();
		// The link is handed back to the job before, at the rollback's revision.
		expect(await linkOf(deps, "A1")).toMatchObject({
			jobId: (await deps.jobs.query({ where: {} })).items[0]?.id,
			writtenRev: String(entryOf(deps, "A1").rev),
		});
		// The same feed imports again.
		const again = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
		expect(again.counters).toMatchObject({ created: 1, updated: 1, failed: 0, conflict: 0 });
	});

	it("restores an entry that was a draft before the run published it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const before = stateOf(deps, "A1");
		expect(before).toMatchObject({ status: "draft", live: null });
		const job = await importRows(deps, [changed]);
		expect(entryOf(deps, "A1").status).toBe("published");
		const id = entryOf(deps, "A1").id;
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		// Publish the restored values, unpublish, discard the draft the unpublish created (F18).
		expect(deps.content.calls.slice(-4)).toEqual([
			`update:${id}`,
			`publish:${id}`,
			`unpublish:${id}`,
			`discard:${id}`,
		]);
	});

	it("restores the importer's pending draft under the live values it published", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, price: 20 }], { publish: false });
		const before = stateOf(deps, "A1");
		expect(before.live).toMatchObject({ data: { price: 10 } });
		const job = await importRows(deps, [changed]);
		expect(entryOf(deps, "A1").live).toBeNull();
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A1"), before);
		// The restored draft is the importer's again: the next publishing run publishes it.
		const next = await importRows(deps, [{ ...desk, price: 20 }]);
		expect(next.counters).toMatchObject({ updated: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({ live: null, data: { price: 20 } });
	});

	it("schedules a scheduled draft again, or leaves it a draft when the time has passed", async () => {
		for (const passed of [false, true]) {
			const { deps, clock } = setup();
			await importRows(deps, [desk], { publish: false });
			const e = entryOf(deps, "A1");
			const at = new Date(clock.t + 60_000).toISOString();
			await deps.content.revertStep({
				collection: "products",
				id: e.id,
				rev: String(e.rev),
				step: "schedule",
				scheduledAt: at,
			});
			// As a scheduling import (M5b) would leave it: the importer's revision on the link.
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: String(e.rev),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
			expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
			if (passed) clock.t += 120_000;
			const done = await rollBack(deps, job.id);
			const [row] = await records(deps, done.id);
			if (passed) {
				expect(stateOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
				expect(row?.warnings).toEqual([
					{
						code: "rollback_schedule_passed",
						message: `The entry was scheduled for ${at}, which has passed; it is left as a draft`,
					},
				]);
			} else {
				expectRestored(stateOf(deps, "A1"), before);
				expect(row).not.toHaveProperty("warnings");
			}
		}
	});

	it("restores entries of a collection without revisions, discarding the stale draft", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk], { publish: false });
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1").live).toBeNull();
		await rollBack(deps, job.id);
		expectRestored(stateOf(deps, "A1"), before);
		expect(deps.content.calls.slice(-3)).toEqual([
			`update:${id}`,
			`unpublish:${id}`,
			`discard:${id}`,
		]);
	});

	it("restores an entry whose only change was its references, which staged a draft (F17)", async () => {
		const { deps } = setup();
		await importRows(deps, [
			{ sku: "A1", name: "Desk" },
			{ sku: "A2", name: "Lamp", related: "A1" },
			{ sku: "A3", name: "Shelf" },
		]);
		const before = stateOf(deps, "A2");
		const job = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		expect(job.counters).toMatchObject({ updated: 1 });
		const [journal] = (await deps.journal.query({ where: { jobId: job.id } })).items;
		expect(journal?.data.before).toMatchObject({
			live: {},
			links: { references: { related: [entryOf(deps, "A1").id] } },
		});
		expect(journal?.data.before).not.toHaveProperty("slug");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expectRestored(stateOf(deps, "A2"), before);
		// An editor's change after a references-only import is still caught.
		const second = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		const e = entryOf(deps, "A2");
		await deps.content.update({ id: e.id, rev: String(e.rev), references: { related: [] } });
		const refused = await rollBack(deps, second.id);
		expect(refused.counters).toMatchObject({ conflict: 1, reverted: 0 });
	});
});

describe("ownership (M5a)", () => {
	it("leaves an entry an editor changed after the job, and reports it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const after = stateOf(deps, "A1");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			action: "revert",
			errors: [
				{
					code: "rollback_changed",
					message:
						"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand",
				},
			],
		});
		expect(stateOf(deps, "A1")).toEqual(after);
	});

	it("rolls back later jobs first: newest first restores, oldest first conflicts", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const initial = stateOf(deps, "A1");
		const b = await importRows(deps, [changed]);
		const afterB = stateOf(deps, "A1");
		const c = await importRows(deps, [{ ...changed, price: 99 }]);
		// Oldest first: B's write is no longer the last.
		const early = await rollBack(deps, b.id, { dryRun: true });
		expect(early.counters).toMatchObject({ conflict: 1 });
		await rollBack(deps, c.id);
		expectRestored(stateOf(deps, "A1"), afterB);
		await rollBack(deps, b.id);
		expectRestored(stateOf(deps, "A1"), initial);
	});

	it("leaves an update row the job never wrote, and a create it never made", async () => {
		const { deps, clock } = setup();
		const first = await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		await rollBack(deps, job.id);
		// A journal row whose write never happened (a crash right after the write-ahead put).
		const e = entryOf(deps, "A1");
		const link = await linkOf(deps, "A1");
		clock.t += 1000;
		const ghost = await importRows(deps, [desk]);
		expect(ghost.counters).toMatchObject({ unchanged: 1 });
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "A1")), {
			jobId: ghost.id,
			seq: 0,
			collection: "products",
			locale: "en",
			sourceKey: "A1",
			kind: "update",
			entryId: e.id,
			before: { link: { ...link }, status: "published", scheduledAt: null, live: { price: 1 } },
			at: new Date(clock.t).toISOString(),
		});
		await deps.journal.put(journalKey(ghost.id, linkKey("products", "en", "Z9")), {
			jobId: ghost.id,
			seq: 1,
			collection: "products",
			locale: "en",
			sourceKey: "Z9",
			kind: "create",
			entryId: null,
			sourceIdValue: "Z9",
			at: new Date(clock.t).toISOString(),
		});
		const done = await rollBack(deps, ghost.id);
		expect(done.counters).toMatchObject({ unchanged: 2, reverted: 0 });
		const rows = await records(deps, done.id);
		expect(rows.map((r) => r.warnings?.[0]?.message)).toEqual([
			"Nothing to roll back: the import never wrote this entry",
			"Nothing to roll back: the entry was never created, or was deleted since",
		]);
		expect(entryOf(deps, "A1").data.price).toBe(10);
		expect(first.id).toBeDefined();
	});

	it("finds a create whose write-ahead row has no entry, and only moves it to Trash", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		const { confirmed: _, ...unconfirmed } = row!;
		await deps.journal.put(key, { ...unconfirmed, entryId: null });
		await deps.links.delete(linkKey("products", "en", "A1"));
		const entry = deps.content.entries.get(entryOf(deps, "A1").id)!;
		// Changed after its creation: not taken.
		const created = entry.createdAt;
		entry.updatedAt = new Date(Date.parse(created!) + 1000).toISOString();
		const refused = await rollBack(deps, job.id, { dryRun: true });
		expect(refused.counters).toMatchObject({ unchanged: 1 });
		entry.updatedAt = created;
		const done = await rollBack(deps, job.id);
		const [rolled] = await records(deps, done.id);
		expect(rolled).toMatchObject({
			status: "reverted",
			action: "trash",
			entryId: entry.id,
			warnings: [{ code: "rollback_trashed" }],
		});
		expect(entry.trashed).toBe(true);
	});

	it("only moves an entry crash repair found to Trash", async () => {
		const { deps } = setup();
		const { start, csv } = await import("./rollback-fixture.js");
		const job = await start(deps, csv([desk]));
		let once = true;
		deps.content.afterWrite = () => {
			if (once) {
				once = false;
				throw new Error("crash after the create");
			}
		};
		await crash(deps, job.id, "crash after the create");
		await runToEnd(deps, job.id);
		const id = entryOf(deps, "A1").id;
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			action: "trash",
			warnings: [
				{
					code: "rollback_trashed",
					message:
						"Moved to Trash, not deleted: the import found this entry by crash repair, so it may not have created it",
				},
			],
		});
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
	});

	it("keeps a created entry whose translations are still active", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const source = entryOf(deps, "A1");
		const fr = await deps.content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau" },
			translationOf: source.id,
		});
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "rollback_has_translations",
					message:
						"Not rolled back: the entry has translations that are still active; roll back the jobs of its translations first",
				},
			],
		});
		expect(deps.content.entries.has(source.id)).toBe(true);
		// Once the translation is gone, a retry deletes it.
		await deps.content.trash("products", fr.id);
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(deps.content.entries.has(source.id)).toBe(false);
	});

	it("leaves a locked entry for a retry", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		deps.content.locked.add(entryOf(deps, "A1").id);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ locked: 1 });
		deps.content.locked.clear();
		await transitionJob(deps, done.id, "retry");
		expect((await runToEnd(deps, done.id)).counters).toMatchObject({ reverted: 1, locked: 0 });
	});
});

describe("resuming a rollback (M5a)", () => {
	it("finishes a delete that stopped between Trash and the permanent delete", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const id = entryOf(deps, "A1").id;
		const { rollback } = await createRollback(deps, { id: job.id });
		let once = true;
		deps.content.beforeStep = (step) => {
			if (step === "delete" && once) {
				once = false;
				throw new Error("crash before the delete");
			}
		};
		await crash(deps, rollback.id, "crash before the delete");
		expect(deps.content.entries.get(id)?.trashed).toBe(true);
		expect(await deps.records.get(recordKey(rollback.id, 0))).toMatchObject({
			status: "writing",
			action: "delete",
			step: 1,
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expect(deps.content.entries.has(id)).toBe(false);
		expect(count(deps, `trash:${id}`)).toBe(1);
	});

	it("continues a revert sequence after a crash at every step, without repeating a step", async () => {
		for (const at of ["update", "publish", "unpublish", "discard", "schedule"] as const) {
			const { deps, clock } = setup();
			await importRows(deps, [desk], { publish: false });
			const e = entryOf(deps, "A1");
			await deps.content.revertStep({
				collection: "products",
				id: e.id,
				rev: String(e.rev),
				step: "schedule",
				scheduledAt: new Date(clock.t + 60_000).toISOString(),
			});
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: String(e.rev),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
			const { rollback } = await createRollback(deps, { id: job.id });
			let armed = true;
			let seen = 0;
			deps.content.beforeStep = (step) => {
				if (step !== at) return;
				seen++;
				// The second update (the draft) is step 5; this sequence has none.
				if (armed) {
					armed = false;
					throw new Error(`crash at ${at}`);
				}
			};
			await crash(deps, rollback.id, `crash at ${at}`);
			const done = await runToEnd(deps, rollback.id);
			expect(done.counters).toMatchObject({ reverted: 1 });
			expectRestored(stateOf(deps, "A1"), before);
			// Each step ran once after the crash (the crashed attempt never reached EmDash).
			expect(seen).toBe(2);
		}
	});

	it("skips a row a crashed batch finished but did not count", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk, { sku: "A2", name: "Lamp" }]);
		const { rollback } = await createRollback(deps, { id: job.id, batchSize: 1 });
		await runBatch(deps, rollback.id, "driver");
		const stored = (await deps.jobs.get(rollback.id)) as Job;
		// The batch's cursor and counters were lost.
		await deps.jobs.put(rollback.id, {
			...stored,
			cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
			counters: { ...stored.counters, reverted: 0 },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2 });
	});
});

describe("refusals and warnings during a rollback (M5a)", () => {
	it("fails a row a plugin hook refused, and continues from the saved step on retry", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = stateOf(deps, "A1");
		const job = await importRows(deps, [changed]);
		const id = entryOf(deps, "A1").id;
		deps.content.blockStep = (step) => (step === "publish" ? "Publishing is frozen" : null);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "failed",
			action: "revert",
			step: 1,
			errors: [
				{
					code: "rollback_blocked",
					message: "Not rolled back: a plugin refused the publish: Publishing is frozen",
				},
			],
		});
		const updates = count(deps, `update:${id}`);
		deps.content.blockStep = () => null;
		await transitionJob(deps, done.id, "retry");
		const retried = await runToEnd(deps, done.id);
		expect(retried.counters).toMatchObject({ reverted: 1, failed: 0 });
		expect(count(deps, `update:${id}`)).toBe(updates);
		expectRestored(stateOf(deps, "A1"), before);
	});

	it("fails a delete a content:beforeDelete hook refused", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		deps.content.blockDelete = () => "Delete blocked by plugin hook";
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "failed",
			action: "delete",
			errors: [
				{
					code: "rollback_blocked",
					message: "Not rolled back: a plugin refused the delete: Delete blocked by plugin hook",
				},
			],
		});
	});

	it("leaves out a term that no longer exists, with a warning", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const index = deps.lookups.storedTerms.findIndex((t) => t.slug === "new");
		const [gone] = deps.lookups.storedTerms.splice(index, 1);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({
			status: "reverted",
			warnings: [
				{
					field: "taxonomies.tag",
					code: "rollback_link_missing",
					message: `Left out: the term ${gone?.group} no longer exists, so the entry does not get it back`,
				},
			],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual([]);
	});

	it("reports a journal row of a kind this version does not know", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk]);
		const key = journalKey(job.id, linkKey("products", "en", "A1"));
		const row = await deps.journal.get(key);
		await deps.journal.put(key, { ...row!, kind: "trash" as never });
		const done = await rollBack(deps, job.id);
		const [rolled] = await records(deps, done.id);
		expect(rolled).toMatchObject({ status: "failed", errors: [{ code: "journal_kind_unknown" }] });
	});
});

describe("dry-run rollback (M5a)", () => {
	it("plans every row as a real rollback would and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed, { sku: "A2", name: "Lamp" }]);
		const calls = deps.content.calls.length;
		const links = structuredClone([...deps.links.rows.values()].map((r) => r.value));
		const done = await rollBack(deps, job.id, { dryRun: true });
		expect(done).toMatchObject({ status: "completed", counters: { reverted: 2 } });
		const rows = await records(deps, done.id);
		expect(rows.map((r) => [r.status, r.action])).toEqual([
			["planned", "revert"],
			["planned", "delete"],
		]);
		expect(rows[0]?.changes).toEqual([
			{ field: "slug", before: "table", after: "desk" },
			{ field: "title", before: "Table", after: "Desk" },
			{ field: "price", before: 12, after: 10 },
			{ field: "featured", before: false, after: true },
			{ field: "taxonomies.tag", before: ["sale"], after: ["new"] },
			{
				field: "bylines",
				before: [deps.lookups.storedBylines[1]?.id],
				after: [deps.lookups.storedBylines[0]?.id],
			},
		]);
		expect(deps.content.calls.slice(calls).filter((c) => !c.startsWith("translations:"))).toEqual(
			[],
		);
		expect([...deps.links.rows.values()].map((r) => r.value)).toEqual(links);
		expect(await deps.jobs.get(job.id)).not.toHaveProperty("rolledBackBy");
		// A real rollback afterwards does what the dry run planned.
		expect((await rollBack(deps, job.id)).counters).toMatchObject({ reverted: 2 });
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rollback.test.ts`
Expected: FAIL (1 file, 21 tests failed: `runBatch` does not run rollback jobs yet).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	sourceNotFoundMessage,
	termPath,
} from "./resolve.js";
import {
	applyTemplate,
	type CompiledTemplate,
````
with:
````ts
	sourceNotFoundMessage,
	termPath,
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import {
	applyTemplate,
	type CompiledTemplate,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	}
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
````
with:
````ts
	}
}

/** An import job's batch: the source-ID field, the compiled template, then a pass. */
async function importBatch(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	if (!job.dryRun && !job.schemaReady) {
		await deps.content.ensureSourceIdField(job.template.collection);
		job.schemaReady = true;
	}
	// Parsed once per batch and reused for every record; job creation already checked them.
	const compiled = compileTemplate(jobTemplate(job), {
		targets: job.targetFields,
		siteTimezone: job.siteTimezone,
		taxonomies: job.taxonomies,
		sharedRequired: job.sharedRequired,
	});
	if (!compiled.ok) {
		return {
			done: false,
			error: { code: "invalid_template", message: compiled.problems.join("; ") },
		};
	}
	const template = compiled.compiled;
	return job.phase === "retry"
		? retryPass(deps, job, template, started, limit, cache)
		: importPass(deps, job, template, started, limit, cache);
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	cache.mediaDeadline = started + job.budgetMs + MEDIA_GRACE_MS;
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
			await deps.content.ensureSourceIdField(job.template.collection);
			job.schemaReady = true;
		}
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
			sharedRequired: job.sharedRequired,
		});
		if (!compiled.ok) {
			outcome = {
				done: false,
				error: { code: "invalid_template", message: compiled.problems.join("; ") },
			};
		} else {
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit, cache)
					: await importPass(deps, job, template, started, limit, cache);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
````
with:
````ts
	cache.mediaDeadline = started + job.budgetMs + MEDIA_GRACE_MS;
	let outcome: Outcome;
	try {
		// A rollback reads its original's journal, not a source file (M5a).
		if (job.kind === "rollback") {
			outcome =
				job.phase === "retry"
					? await rollbackRetryPass(deps, job, started, limit, cache)
					: await rollbackPass(deps, job, started, limit, cache);
		} else {
			outcome = await importBatch(deps, job, started, limit, cache);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
````

In `packages/flux-import/src/engine/resolve.ts`, replace
````ts
	await termIndex(deps, cache, taxonomy, locale);
}

/**
 * How the record log shows an assigned term: its slug path when the batch loaded it (the
 * template's locale), else its translation group.
````
with:
````ts
	await termIndex(deps, cache, taxonomy, locale);
}

/** A loaded taxonomy's term with this translation group (M5a rollback); undefined when none. */
export function termOfGroup(
	cache: LookupCache,
	taxonomy: string,
	group: string,
): TermInfo | undefined {
	return cache.terms.get(taxonomy)?.byGroup.get(group);
}

/**
 * The IDs of the locale's bylines, loaded once per batch (M5a rollback); null when the locale has
 * more than `MAX_BYLINE_LOOKUP`, so a byline not loaded may still exist.
 */
export async function bylineIdsOf(
	deps: ResolveDeps,
	cache: LookupCache,
	locale: string,
): Promise<ReadonlySet<string> | null> {
	const index = await bylineIndex(deps, cache, locale);
	if (!index.complete) return null;
	return new Set([...index.byName.values()].flat().map((b) => b.id));
}

/**
 * How the record log shows an assigned term: its slug path when the batch loaded it (the
 * template's locale), else its translation group.
````

Create `packages/flux-import/src/engine/revert.ts`:
````ts
/**
 * The rollback pass (spec M5a "Rollback"): walks an import's journal newest first and, per row,
 * finds the entry, checks that it is as the import (or this rollback) left it and not locked,
 * then deletes a created entry or restores a changed one, step by step so that a resumed batch
 * continues where it stopped. A dry run decides every row the same way and writes nothing.
 */
import type { Change } from "./diff.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type EntryState,
	type LinkWrites,
	type RevertStep,
	type StepResult,
} from "./ports.js";
import {
	bylineIdsOf,
	COST_CALL,
	COST_RECORD,
	type LookupCache,
	loadTerms,
	termOfGroup,
} from "./resolve.js";
import { restoredData, sameStored } from "./rollback-values.js";
import {
	bump,
	type Counters,
	capErrors,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	linkKey,
	type RecordError,
	type RecordRow,
	type RollbackAction,
	recordKey,
} from "./types.js";

type Outcome = { done: boolean };
type StepFailure = Extract<StepResult, { ok: false }>;
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

/** Plugin storage query limit. */
const PAGE = 100;

export const CHANGED_MESSAGE =
	"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand";
const LOCKED_MESSAGE = "Not rolled back: the entry is being edited (locked)";
const NOTHING_MESSAGE = "Nothing to roll back: the entry was never created, or was deleted since";
const NEVER_WRITTEN_MESSAGE = "Nothing to roll back: the import never wrote this entry";
const TRASHED_MESSAGE =
	"Moved to Trash, not deleted: the import found this entry by crash repair, so it may not have created it";
const TRANSLATIONS_MESSAGE =
	"Not rolled back: the entry has translations that are still active; roll back the jobs of its translations first";

const ROLLBACK_ACTIONS: ReadonlySet<string> = new Set(["delete", "trash", "revert"]);

/** The counter a rollback row counts toward: reverted, or planned to be, as `reverted`. */
function counterOf(row: RowFields): keyof Counters | null {
	switch (row.status) {
		case "writing":
			return null;
		case "planned":
			return row.action !== undefined && ROLLBACK_ACTIONS.has(row.action)
				? "reverted"
				: "unchanged";
		case "reverted":
			return "reverted";
		default:
			return row.status;
	}
}

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

/** The rollback job's original import; job creation always sets it. */
function originalOf(job: Job): string {
	if (job.rollbackOf === undefined) throw new Error(`Job ${job.id} is not a rollback job`);
	return job.rollbackOf;
}

/** The first pass: journal rows below `cursor.seq`, newest first. */
export async function rollbackPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
		const page = await deps.journal.query({
			where: { jobId: originalOf(job), seq: { lt: job.cursor.seq } },
			orderBy: { seq: "desc" },
			limit: Math.min(limit - processed, PAGE),
		});
		if (page.items.length === 0) return { done: true };
		for (const { data } of page.items) {
			await revertRow(deps, job, data, { retry: false, cache });
			job.cursor = { offset: 0, seq: data.seq };
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
}

/** `jobs/retry`: rows left failed, conflict, locked or writing, newest first. */
export async function rollbackRetryPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const { collection, locale } = job.template;
	let processed = 0;
	for (;;) {
		const page = await deps.records.query({
			where: {
				jobId: job.id,
				status: { in: ["failed", "conflict", "locked", "writing"] },
				seq: { lt: job.retryFromSeq },
			},
			orderBy: { seq: "desc" },
			limit: Math.min(limit, PAGE),
		});
		if (page.items.length === 0) {
			job.counters = await tallyRollback(deps, job.id);
			return { done: true };
		}
		for (const { data: row } of page.items) {
			const key = journalKey(originalOf(job), linkKey(collection, locale, row.sourceKey ?? ""));
			const entry = await deps.journal.get(key);
			// A journal row is only deleted with its job, which retention keeps meanwhile.
			if (entry) await revertRow(deps, job, entry, { retry: true, cache });
			job.retryFromSeq = row.seq;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
}

/** Rebuilds a rollback job's counters from its rows, as an import's retry does. */
async function tallyRollback(deps: EngineDeps, jobId: string): Promise<Counters> {
	const counters: Counters = { ...emptyCounters(), reverted: 0 };
	let cursor: string | undefined;
	for (;;) {
		const page = await deps.records.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			const counter = counterOf(data);
			if (counter) bump(counters, counter);
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
	}
}

/** Decides and carries out one journal row, saving its record row as an import saves its own. */
async function revertRow(
	deps: EngineDeps,
	job: Job,
	journal: JournalEntry,
	opts: { retry: boolean; cache: LookupCache },
): Promise<void> {
	const key = recordKey(job.id, journal.seq);
	const existing = await deps.records.get(key);
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor.
		const counter = counterOf(existing);
		if (counter) bump(job.counters, counter);
		return;
	}
	const save = (fields: RowFields) =>
		deps.records.put(key, {
			jobId: job.id,
			seq: journal.seq,
			start: 0,
			end: 0,
			...fields,
			...(fields.errors ? { errors: capErrors(fields.errors) } : {}),
			...(fields.warnings ? { warnings: capWarnings(fields.warnings) } : {}),
			updatedAt: iso(deps),
		});
	opts.cache.spend(COST_RECORD);
	const ctx: RowCtx = { deps, job, journal, existing, save, cache: opts.cache, warnings: [] };
	let row: RowFields;
	try {
		row = await decideRow(ctx);
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		row = {
			status: "failed",
			sourceKey: journal.sourceKey,
			entryId: ctx.entryId ?? journal.entryId,
			...(ctx.action ? { action: ctx.action } : {}),
			...(ctx.written ? { writtenRev: ctx.written.rev, step: ctx.written.step } : {}),
			errors: [{ code: e.code, message: e.message }],
		};
	}
	if (ctx.warnings.length > 0)
		row = { ...row, warnings: [...(row.warnings ?? []), ...ctx.warnings] };
	await save(row);
	if (existing && opts.retry) {
		const old = counterOf(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterOf(row);
	if (counter) bump(job.counters, counter);
}

type RowCtx = {
	deps: EngineDeps;
	job: Job;
	journal: JournalEntry;
	existing: RecordRow | null;
	save: (fields: RowFields) => Promise<void>;
	cache: LookupCache;
	warnings: RecordError[];
	/** Known so far, so that an unexpected EmDash error still reports them. */
	entryId?: string;
	action?: RollbackAction;
	/** The last step done and the revision it left. */
	written?: { rev: string; step: number };
};

type Found = EntrySnapshot & { trashed: boolean };

/** Step 1 of "Per row": the entry by ID (active first, then in Trash), or a create's by source ID. */
async function findEntry(ctx: RowCtx): Promise<{ entry: Found; adopted: boolean } | null> {
	const { deps, journal, existing } = ctx;
	const { collection, locale } = journal;
	const id = journal.entryId ?? existing?.entryId ?? null;
	if (id !== null) {
		const active = await deps.content.get(collection, locale, id, { references: true });
		if (active) return { entry: { ...active, trashed: false }, adopted: false };
		const trashed = await deps.content.getIncludingTrashed(collection, locale, id);
		return trashed ? { entry: trashed, adopted: false } : null;
	}
	if (journal.kind !== "create" || journal.sourceIdValue === undefined) return null;
	// A crash before the create returned, or a partial create on D1: the entry is taken only when
	// it was created after the write-ahead row and never changed since (spec M5a V3).
	const found = await deps.content.findBySourceId(collection, locale, journal.sourceIdValue);
	if (
		found?.createdAt === undefined ||
		found.createdAt < journal.at ||
		found.updatedAt !== found.createdAt
	) {
		return null;
	}
	return { entry: { ...found, trashed: false }, adopted: true };
}

function rowOf(
	ctx: RowCtx,
	status: RowFields["status"],
	extra: Partial<RowFields> = {},
): RowFields {
	return {
		status,
		sourceKey: ctx.journal.sourceKey,
		entryId: ctx.entryId ?? ctx.journal.entryId,
		...(ctx.action ? { action: ctx.action } : {}),
		...(ctx.written ? { writtenRev: ctx.written.rev, step: ctx.written.step } : {}),
		...extra,
	};
}

const issue = (code: string, message: string, field?: string): RecordError =>
	field === undefined ? { code, message } : { field, code, message };

async function decideRow(ctx: RowCtx): Promise<RowFields> {
	const { deps, job, journal, existing } = ctx;
	if (journal.kind !== "create" && journal.kind !== "update") {
		return rowOf(ctx, "failed", {
			errors: [
				issue(
					"journal_kind_unknown",
					`Not rolled back: the journal row is of a kind this version does not know (${String(journal.kind)})`,
				),
			],
		});
	}
	const found = await findEntry(ctx);
	if (!found) {
		// A crash after the permanent delete, before the row was saved: the delete is done.
		if (existing?.status === "writing" && existing.action === "delete") {
			ctx.action = "delete";
			const id = linkKey(journal.collection, journal.locale, journal.sourceKey);
			const link = await deps.links.get(id);
			if (link?.entryId === existing.entryId) await deps.links.delete(id);
			return rowOf(ctx, "reverted", existing.entryId ? { entryId: existing.entryId } : {});
		}
		return rowOf(ctx, "unchanged", { warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)] });
	}
	const { entry, adopted } = found;
	ctx.entryId = entry.id;
	ctx.action = journal.kind === "create" ? "delete" : "revert";

	// Ownership: as the import left it (its link row), or as this rollback left it (resuming).
	const linkId = linkKey(journal.collection, journal.locale, journal.sourceKey);
	const link = await deps.links.get(linkId);
	const resumed =
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	const owned =
		link !== null &&
		link.jobId === job.rollbackOf &&
		link.entryId === entry.id &&
		link.writtenRev === entry.rev;
	// A create made after the write-ahead row and never changed since (spec M5a V3): found by
	// source ID after a crash, or one whose link was never saved or names no job.
	const untouched =
		journal.kind === "create" &&
		(adopted ||
			(entry.createdAt !== undefined &&
				entry.createdAt >= journal.at &&
				entry.updatedAt === entry.createdAt));
	if (resumed && existing) ctx.written = { rev: entry.rev, step: existing.step ?? 0 };
	if (!resumed && !owned && !untouched) {
		const before = journal.before;
		const neverWritten =
			journal.kind === "update" &&
			link?.jobId !== job.rollbackOf &&
			(entry.rev === before?.link?.writtenRev ||
				(entry.updatedAt !== undefined && entry.updatedAt < journal.at));
		if (neverWritten) {
			return rowOf(ctx, "unchanged", {
				warnings: [issue("nothing_to_roll_back", NEVER_WRITTEN_MESSAGE)],
			});
		}
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
	}
	if (await deps.content.isLocked(journal.collection, journal.locale, entry.id)) {
		return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	return journal.kind === "create"
		? deleteCreated(ctx, entry, adopted, link?.entryId === entry.id)
		: restoreChanged(ctx, entry, link?.entryId === entry.id);
}

/** "Created entries": Trash, then a permanent delete when the import's own create made it. */
async function deleteCreated(
	ctx: RowCtx,
	entry: Found,
	adopted: boolean,
	linked: boolean,
): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection } = journal;
	if (!entry.trashed && (entry.group ?? entry.id) === entry.id) {
		const group = await deps.content.translations(collection, entry.id);
		if (group.some((t) => t.id !== entry.id)) {
			return rowOf(ctx, "conflict", {
				errors: [issue("rollback_has_translations", TRANSLATIONS_MESSAGE)],
			});
		}
	}
	const confirmed = journal.confirmed === true && !adopted;
	ctx.action = confirmed ? "delete" : "trash";
	const warnings = confirmed ? [] : [issue("rollback_trashed", TRASHED_MESSAGE)];
	if (job.dryRun)
		return rowOf(ctx, "planned", { changes: [], ...(warnings.length ? { warnings } : {}) });
	ctx.written = { rev: entry.rev, step: ctx.written?.step ?? 0 };
	await ctx.save(rowOf(ctx, "writing"));
	if (!entry.trashed) {
		const trashed = await deps.content.trash(collection, entry.id);
		if (!trashed.ok) {
			if (trashed.reason === "blocked") {
				return rowOf(ctx, "failed", {
					errors: [
						issue(
							"rollback_blocked",
							`Not rolled back: a plugin refused the delete: ${trashed.message}`,
						),
					],
				});
			}
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
		}
		// Trash keeps the revision (spec M5a F6), so a resumed row still passes ownership.
		ctx.written = { rev: entry.rev, step: 1 };
		await ctx.save(rowOf(ctx, "writing"));
	}
	if (confirmed) await deps.content.permanentDelete(collection, entry.id);
	if (linked) await deps.links.delete(linkKey(collection, journal.locale, journal.sourceKey));
	return rowOf(ctx, "reverted", warnings.length ? { warnings } : {});
}

/** The links of the pre-image as an update writes them; missing targets are left out and warned. */
async function restoredLinks(
	ctx: RowCtx,
	links: NonNullable<JournalBefore["links"]>,
): Promise<LinkWrites> {
	const { deps, job, journal, cache } = ctx;
	const writes: LinkWrites = {};
	const missing = (field: string, what: string) =>
		ctx.warnings.push(
			issue(
				"rollback_link_missing",
				`Left out: ${what} no longer exists, so the entry does not get it back`,
				field,
			),
		);
	for (const [taxonomy, groups] of Object.entries(links.taxonomies ?? {})) {
		await loadTerms(deps, cache, taxonomy, journal.locale);
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = groups.flatMap((group) => {
			const term = termOfGroup(cache, taxonomy, group);
			if (term) return [term.slug];
			missing(`taxonomies.${taxonomy}`, `the term ${group}`);
			return [];
		});
	}
	for (const [field, ids] of Object.entries(links.references ?? {})) {
		const target = job.targetFields?.[field]?.targetCollection ?? journal.collection;
		const kept: string[] = [];
		for (const id of ids) {
			cache.spend(COST_CALL);
			if (await deps.lookups.findEntry(target, "id", id, journal.locale)) kept.push(id);
			else missing(field, `the entry ${id}`);
		}
		writes.references ??= {};
		writes.references[field] = kept;
	}
	if (links.bylines) {
		const known = await bylineIdsOf(deps, cache, journal.locale);
		writes.bylines = links.bylines.filter((b) => {
			if (known === null || known.has(b.bylineId)) return true;
			missing("bylines", `the byline ${b.bylineId}`);
			return false;
		});
	}
	return writes;
}

/** What a dry run plans for a changed entry: each value it would get back. */
async function plannedChanges(
	ctx: RowCtx,
	entry: Found,
	before: JournalBefore,
	links: LinkWrites,
): Promise<Change[]> {
	const changes: Change[] = [];
	const add = (field: string, now: unknown, back: unknown) => {
		if (!sameStored(now, back))
			changes.push({ field, before: now ?? null, after: (back ?? null) as never });
	};
	if (before.slug !== undefined) add("slug", entry.slug, before.slug);
	for (const [field, value] of Object.entries(before.live)) {
		add(field, (entry.live ?? entry.data)[field], value);
	}
	for (const [field, value] of Object.entries(before.draft ?? {})) {
		add(`draft.${field}`, entry.data[field], value);
	}
	if (links.taxonomies) {
		ctx.cache.spend(COST_CALL);
		const assigned = await ctx.deps.lookups.entryTerms(ctx.journal.collection, entry.id);
		for (const [taxonomy, slugs] of Object.entries(links.taxonomies)) {
			const now = (assigned[taxonomy] ?? []).map(
				(g) => termOfGroup(ctx.cache, taxonomy, g)?.slug ?? g,
			);
			add(`taxonomies.${taxonomy}`, now.length ? now : null, slugs.length ? slugs : null);
		}
	}
	for (const [field, ids] of Object.entries(links.references ?? {})) {
		const now = (entry.references?.[field] ?? []).map((r) => r.id);
		add(field, now.length ? now : null, ids.length ? ids : null);
	}
	if (links.bylines) {
		const now = (entry.bylines ?? []).map((b) => b.id);
		const back = links.bylines.map((b) => b.bylineId);
		add("bylines", now.length ? now : null, back.length ? back : null);
	}
	add("status", entry.status, before.status);
	add("scheduledAt", entry.scheduledAt, before.scheduledAt);
	return changes;
}

/**
 * "Revert sequence": 1 restore the live values, slug and links; 2 publish; 3 unpublish; 4 discard
 * the draft the entry did not have; 5 restore the draft; 6 schedule. Each step is chosen from the
 * entry's state after the previous one and saved with the revision it returned, so a resumed row
 * skips the steps done and re-derives the rest.
 */
async function restoreChanged(ctx: RowCtx, entry: Found, linked: boolean): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection, locale } = journal;
	const before = journal.before;
	ctx.action = "revert";
	if (before === undefined || entry.trashed) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
	}
	const links = before.links ? await restoredLinks(ctx, before.links) : {};
	const passed =
		before.scheduledAt !== null && !(Date.parse(before.scheduledAt) > deps.now())
			? [
					issue(
						"rollback_schedule_passed",
						`The entry was scheduled for ${before.scheduledAt}, which has passed; it is left as a draft`,
					),
				]
			: [];
	ctx.warnings.push(...passed);
	if (job.dryRun) {
		return rowOf(ctx, "planned", { changes: await plannedChanges(ctx, entry, before, links) });
	}
	let state: EntryState = {
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		hasDraft: entry.hasDraft,
	};
	let done = ctx.written?.step ?? 0;
	ctx.written = { rev: state.rev, step: done };
	await ctx.save(rowOf(ctx, "writing"));
	const run = async (
		step: number,
		input: { step: RevertStep } & Partial<Parameters<EngineDeps["content"]["revertStep"]>[0]>,
	): Promise<StepFailure | null> => {
		if (done >= step) return null;
		const result = await deps.content.revertStep({
			...input,
			collection,
			locale,
			id: entry.id,
			rev: state.rev,
		});
		if (!result.ok) return result;
		state = result.state;
		done = step;
		ctx.written = { rev: state.rev, step };
		await ctx.save(rowOf(ctx, "writing"));
		return null;
	};
	const hasLive = Object.keys(before.live).length > 0;
	const steps: (() => Promise<StepFailure | null>)[] = [
		async () =>
			hasLive || before.slug !== undefined || before.links !== undefined
				? run(1, {
						step: "update",
						...(hasLive ? { data: restoredData(before.live, job.targetFields) } : {}),
						...(before.slug === undefined ? {} : { slug: before.slug }),
						...links,
					})
				: null,
		async () => {
			const publish =
				before.status === "published"
					? state.status !== "published" || state.hasDraft
					: state.status === "published" && state.hasDraft;
			return publish ? run(2, { step: "publish" }) : null;
		},
		async () =>
			before.status !== "published" && state.status === "published"
				? run(3, { step: "unpublish" })
				: null,
		async () => (before.draft === undefined && state.hasDraft ? run(4, { step: "discard" }) : null),
		async () =>
			before.draft !== undefined && Object.keys(before.draft).length > 0
				? run(5, { step: "update", data: restoredData(before.draft, job.targetFields) })
				: null,
		async () => {
			const at = before.scheduledAt;
			if (at === null || passed.length > 0) return null;
			const same = state.scheduledAt !== null && Date.parse(state.scheduledAt) === Date.parse(at);
			return same ? null : run(6, { step: "schedule", scheduledAt: at });
		},
	];
	for (const [i, next] of steps.entries()) {
		const failed = await next();
		if (failed === null) continue;
		if (failed.reason === "conflict") {
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
		}
		const name = ["update", "publish", "unpublish", "discard", "update", "schedule"][i];
		return rowOf(ctx, "failed", {
			errors: [
				issue(
					"rollback_blocked",
					`Not rolled back: a plugin refused the ${name}: ${failed.message}`,
				),
			],
		});
	}
	// The link goes back to the job before, at the rollback's revision, so that job's rollback
	// and the next import see the entry as that job left it.
	const id = linkKey(collection, locale, journal.sourceKey);
	if (before.link === null) {
		if (linked) await deps.links.delete(id);
	} else {
		await deps.links.put(id, {
			collection,
			locale,
			sourceKey: journal.sourceKey,
			entryId: entry.id,
			...(before.link.writtenRev === undefined ? {} : { writtenRev: state.rev }),
			...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
		});
	}
	return rowOf(ctx, "reverted");
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/rollback.test.ts`
Expected: PASS (1 file, 21 tests). Full suite after this task: 61 files / 1,434 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/revert.ts packages/flux-import/src/engine/resolve.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/rollback.test.ts
git commit -m "Run rollback jobs: delete the entries a job created and restore the ones it changed, newest first and resumable step by step"
```

### Task 7: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/integration/rollback.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through the plugin routes (`jobs/create`, `jobs/next`, `jobs/get`, `jobs/records`, `jobs/rollback`, `jobs/retry`, `jobs/cancel`, `sources/create`); `Client`, `devBypass`, `startServer`, `stopServer`, `FeedServer`, `withDb`, `RED_PNG`, `BLUE_PNG`, `productsCsv`, `template`, the translation fixtures; `sameStored`; the REST routes `POST /_emdash/api/schema/collections` (with and without `revisions`), `PUT /_emdash/api/content/{c}/{id}`, `POST /_emdash/api/content/{c}/{id}/schedule`, `GET /_emdash/api/content/{c}/trash`.
- Produces: the Node proof of the spec's integration list (Rulings 12 and 13).

- [ ] **Step 1: Write the tests**

Create `packages/flux-import/tests/integration/rollback.test.ts`:
````ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sameStored } from "../../src/engine/rollback-values.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { BLUE_PNG, RED_PNG } from "../fixtures/media.js";
import {
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	translationCsv,
	translationNames,
	translationTemplate,
} from "../fixtures/translations.js";
import { Client, devBypass, type Product } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
const TAG = "it_rb_tag";
const ALEX = "it-rb-alex";
const SAM = "it-rb-sam";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

/** A collection with every kind of value a rollback restores, revisioned or plain. */
async function createRollbackSchema(collection: string, revisions: boolean): Promise<void> {
	await client.api("POST", "/_emdash/api/schema/collections", {
		slug: collection,
		label: collection,
		supports: revisions ? ["drafts", "revisions"] : ["drafts"],
		editLocking: true,
	});
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "price", label: "Price", type: "number" },
		{ slug: "featured", label: "Featured", type: "boolean" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "body", label: "Body", type: "portableText" },
		{
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { targetCollection: collection, multiple: true },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

function rollbackTemplate(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "id" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			featured: { from: "Featured", type: "boolean" },
			photo: { from: "Photo", type: "image" },
			body: { from: "Body", type: "portableText", format: "markdown" },
			related: { from: "Related", type: "reference", match: "key", separator: "|" },
		},
		taxonomies: { [TAG]: { from: "Tags", separator: "|", create: true } },
		bylines: { from: "Authors", match: "name", separator: ";" },
	};
}

type Row = { id: string; name: string; price: number; featured: boolean; tags: string };

/** Rows `U1`… as the first job leaves them, or as the second job changes them (`changed`). */
function rows(prefix: string, n: number, changed = false): Row[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `${prefix}${i + 1}`,
		name: `${changed ? "Changed" : "Item"} ${prefix}${i + 1}`,
		price: changed ? i + 100 : i + 1,
		featured: !changed,
		tags: changed ? "sale|fresh" : "new",
	}));
}

function rollbackCsv(list: Row[], changed = false): string {
	const photo = feeds.url(changed ? "/rb-blue.png" : "/rb-red.png");
	const lines = list.map((r, i) =>
		[
			r.id,
			r.name.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.price,
			r.featured,
			photo,
			`"${changed ? "## Changed\n\nNew *body*" : "Body of **item**"}"`,
			// Each row links to the one before it; the changed rows to the first.
			i === 0 ? "" : changed ? list[0]?.id : list[i - 1]?.id,
			r.tags,
			changed ? "Sam Lee" : "Alex Doe",
		].join(","),
	);
	return ["id,Handle,Name,Price,Featured,Photo,Body,Related,Tags,Authors", ...lines, ""].join("\n");
}

async function importCsv(
	csv: string,
	jobTemplate: object,
	opts: { publish?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: opts.batchSize ?? 10,
	});
	return client.runToEnd(created.id);
}

async function rollBack(
	id: string,
	opts: { dryRun?: boolean; batchSize?: number; budgetMs?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const created = await client.plugin("jobs/rollback", { id, batchSize: 10, ...opts });
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

/** What a rollback restores, as the content API reads it back. */
async function stateOf(collection: string, id: string) {
	const { item } = await client.api<{ item: Product & { scheduledAt?: string | null } }>(
		"GET",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
	);
	return {
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		slug: item.slug,
		hasDraft: item.draftRevisionId !== null,
		data: item.data,
		tags: (await client.entryTerms(collection, id, TAG).catch(() => [])).sort(),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
		related: (item.references?.related?.children ?? []).map((c) => c.id),
	};
}

type State = Awaited<ReturnType<typeof stateOf>>;

function expectSame(after: State, before: State) {
	const { data: a, ...restA } = after;
	const { data: b, ...restB } = before;
	expect(restA).toEqual(restB);
	if (!sameStored(a, b)) expect(a).toEqual(b);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function statesOf(collection: string): Promise<Map<string, State>> {
	const out = new Map<string, State>();
	for (const [key, e] of await byKey(collection)) out.set(key, await stateOf(collection, e.id));
	return out;
}

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	await feeds.start();
	feeds.feeds.set("/rb-red.png", { body: RED_PNG, contentType: "image/png" });
	feeds.feeds.set("/rb-blue.png", { body: BLUE_PNG, contentType: "image/png" });
	// Its own server: photos are fetched from 127.0.0.1 (allowPrivateNetwork), and one test kills it.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await createRollbackSchema("it_rb_rev", true);
	await createRollbackSchema("it_rb_plain", false);
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: TAG,
		label: "Tags",
		collections: ["it_rb_rev", "it_rb_plain"],
	});
	for (const slug of ["new", "sale"]) {
		await client.api("POST", `/_emdash/api/taxonomies/${TAG}/terms`, {
			slug,
			label: slug,
			locale: "en",
		});
	}
	for (const [slug, displayName] of [
		[ALEX, "Alex Doe"],
		[SAM, "Sam Lee"],
	]) {
		await client.api("POST", "/_emdash/api/admin/bylines", { slug, displayName, locale: "en" });
	}
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

describe.each([
	["revisioned", "it_rb_rev", true],
	["plain", "it_rb_plain", false],
])("M5a rollback of a create-and-update job (%s collection)", (_kind, collection, firstRun) => {
	const first = rows("U", 10);
	const second = [...rows("U", 10, true), ...rows("N", 20, true)];
	let before: Map<string, State>;
	let job: Job;
	let reimport: Job;

	beforeAll(async () => {
		const seeded = await importCsv(rollbackCsv(first), rollbackTemplate(collection));
		expect(seeded.counters).toMatchObject({ created: 10, failed: 0 });
		before = await statesOf(collection);
		job = await importCsv(rollbackCsv(second, true), rollbackTemplate(collection));
		expect(job.counters).toMatchObject({ created: 20, updated: 10, failed: 0, conflict: 0 });
	});

	it("plans the rollback in a dry run, writing nothing, with the kept media and terms", async () => {
		const after = await statesOf(collection);
		const dry = await rollBack(job.id, { dryRun: true });
		expect(dry.job.counters).toMatchObject({ reverted: 30, conflict: 0, failed: 0 });
		expect(dry.rows.every((r) => r.status === "planned")).toBe(true);
		// The second collection's job reuses the photo and the term the first one created.
		expect(dry.job.warnings).toEqual(
			firstRun
				? [
						expect.stringMatching(/^The import created 1 media items, which are kept .*: \S+$/),
						expect.stringMatching(/^The import created 1 terms, which are kept/),
					]
				: [],
		);
		expect(await statesOf(collection)).toEqual(after);
		expect(await client.plugin("jobs/get", { id: job.id })).not.toHaveProperty("rolledBackBy");
	});

	it("deletes the created entries and restores the changed ones exactly", async () => {
		const done = await rollBack(job.id);
		expect(done.job).toMatchObject({
			status: "completed",
			counters: { reverted: 30, conflict: 0, failed: 0 },
		});
		const now = await statesOf(collection);
		expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [key, state] of before) expectSame(now.get(key) as State, state);
		// The created entries are gone, not in Trash.
		const trash = await client.api<{ items: unknown[] }>(
			"GET",
			`/_emdash/api/content/${collection}/trash?locale=en`,
		);
		expect(trash.items).toEqual([]);
	});

	it("imports the same feed again without slug conflicts", async () => {
		reimport = await importCsv(rollbackCsv(second, true), rollbackTemplate(collection));
		expect(reimport.counters).toMatchObject({ created: 20, updated: 10, failed: 0, conflict: 0 });
	});

	it("leaves an entry an editor changed after the job, and reports it", async () => {
		const u1 = (await byKey(collection)).get("U1") as Product;
		const { _rev } = await client.getEntry(collection, u1.id);
		await client.api("PUT", `/_emdash/api/content/${collection}/${u1.id}`, {
			data: { title: "Editor title" },
			_rev,
		});
		const edited = await stateOf(collection, u1.id);
		const done = await rollBack(reimport.id);
		expect(done.job.counters).toMatchObject({ reverted: 29, conflict: 1 });
		expect(done.rows.find((r) => r.sourceKey === "U1")).toMatchObject({
			status: "conflict",
			errors: [{ code: "rollback_changed" }],
		});
		expect(await stateOf(collection, u1.id)).toEqual(edited);
	});
});

describe("M5a rollback order and drafts", () => {
	it("rolls back later jobs first; oldest first conflicts", async () => {
		await client.createProducts("it_rb_chain");
		const t = template("it_rb_chain");
		await importCsv(productsCsv(3), t);
		const initial = await statesOf("it_rb_chain");
		const b = await importCsv(
			productsCsv(3, (i) => `${i + 10}`),
			t,
		);
		const afterB = await statesOf("it_rb_chain");
		const c = await importCsv(
			productsCsv(3, (i) => `${i + 20}`),
			t,
		);
		const early = await rollBack(b.id, { dryRun: true });
		expect(early.job.counters).toMatchObject({ conflict: 3, reverted: 0 });
		expect(early.rows.every((r) => r.errors?.[0]?.code === "rollback_changed")).toBe(true);
		await rollBack(c.id);
		for (const [key, state] of afterB) {
			expectSame((await statesOf("it_rb_chain")).get(key) as State, state);
		}
		expect((await rollBack(b.id)).job.counters).toMatchObject({ reverted: 3 });
		const now = await statesOf("it_rb_chain");
		for (const [key, state] of initial) expectSame(now.get(key) as State, state);
	});

	it("leaves the pending draft of a publish: false job when the publishing job after it is rolled back", async () => {
		await client.createProducts("it_rb_drafts");
		const t = template("it_rb_drafts");
		await importCsv(productsCsv(2), t);
		const staged = await importCsv(
			productsCsv(2, (i) => `${i + 50}`),
			t,
			{ publish: false },
		);
		expect(staged.counters).toMatchObject({ updated: 2 });
		const pending = await statesOf("it_rb_drafts");
		expect([...pending.values()].every((s) => s.hasDraft)).toBe(true);
		const published = await importCsv(
			productsCsv(2, (i) => `${i + 70}`),
			t,
		);
		expect(published.counters).toMatchObject({ updated: 2, conflict: 0 });
		expect((await rollBack(published.id)).job.counters).toMatchObject({ reverted: 2 });
		const now = await statesOf("it_rb_drafts");
		for (const [key, state] of pending) expectSame(now.get(key) as State, state);
		// The draft is the importer's again: publishing the same values goes through.
		const again = await importCsv(
			productsCsv(2, (i) => `${i + 50}`),
			t,
		);
		expect(again.counters).toMatchObject({ conflict: 0, failed: 0 });
	});

	it("schedules a scheduled entry again", async () => {
		await client.createProducts("it_rb_sched");
		const t = template("it_rb_sched");
		await importCsv(productsCsv(1), t, { publish: false });
		const entry = (await byKey("it_rb_sched")).get("SKU-0") as Product;
		const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		await client.api("POST", `/_emdash/api/content/it_rb_sched/${entry.id}/schedule`, {
			scheduledAt: at,
		});
		const scheduled = await stateOf("it_rb_sched", entry.id);
		expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: at });
		// As a scheduling import (M5b) would leave it: the link holds the scheduled revision, so the
		// next import owns the draft. No API writes a link row, so the test sets it in the database.
		const { _rev } = await client.getEntry("it_rb_sched", entry.id);
		withDb(server.dbPath, (db) => {
			const moved = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_set(data, '$.writtenRev', ?) WHERE plugin_id = 'flux-import' AND collection = 'links' AND json_extract(data, '$.entryId') = ?",
				)
				.run(_rev, entry.id);
			if (moved.changes !== 1) throw new Error(`No link row for ${entry.id}`);
		});
		const job = await importCsv(
			productsCsv(1, () => "9"),
			t,
		);
		expect(job.counters).toMatchObject({ updated: 1, conflict: 0 });
		expect((await rollBack(job.id)).job.counters).toMatchObject({ reverted: 1 });
		expectSame(await stateOf("it_rb_sched", entry.id), scheduled);
	});

	it("rolls back a French translation job before the English one", async () => {
		const n = translationNames("it_rbt");
		await createTranslationSchema(client, n);
		const en = await importCsv(
			englishCsv([
				["E1", "Desk", "S1", 100],
				["E2", "Lamp", "S2", 20],
			]),
			englishTemplate(n),
		);
		expect(en.counters).toMatchObject({ created: 2, failed: 0 });
		const fr = await importCsv(
			translationCsv([
				{ id: "F1", enId: "E1", name: "Bureau" },
				{ id: "F2", enId: "E2", name: "Lampe" },
			]),
			translationTemplate(n, "fr"),
		);
		expect(fr.counters).toMatchObject({ created: 2, failed: 0 });
		const blocked = await rollBack(en.id);
		expect(blocked.job.counters).toMatchObject({ conflict: 2, reverted: 0 });
		expect(blocked.rows.every((r) => r.errors?.[0]?.code === "rollback_has_translations")).toBe(
			true,
		);
		expect((await rollBack(fr.id)).job.counters).toMatchObject({ reverted: 2 });
		expect(await listLocale(client, n.products, "fr")).toEqual([]);
		await client.plugin("jobs/retry", { id: blocked.job.id });
		const retried = await client.runToEnd(blocked.job.id);
		expect(retried.counters).toMatchObject({ reverted: 2, conflict: 0 });
		expect(await listLocale(client, n.products, "en")).toEqual([]);
	});

	it("re-imports a URL source after a rolled-back and after a cancelled job", async () => {
		await client.createProducts("it_rb_url");
		feeds.feeds.set("/rb.csv", { body: productsCsv(3), etag: true });
		const source = await client.plugin<SourceRow>("sources/create", {
			name: "Rollback feed",
			url: feeds.url("/rb.csv"),
		});
		const create = () =>
			client.plugin<Job | { skipped: string }>("jobs/create", {
				sourceId: source.id,
				template: template("it_rb_url"),
				dryRun: false,
			});
		const first = (await create()) as Job;
		await client.runToEnd(first.id);
		expect(await create()).toMatchObject({ skipped: "unchanged" });
		await rollBack(first.id);
		const second = await create();
		expect(second).not.toHaveProperty("skipped");
		expect((await client.runToEnd((second as Job).id)).counters).toMatchObject({ created: 3 });

		feeds.feeds.set("/rb.csv", { body: productsCsv(4), etag: true });
		const third = (await create()) as Job;
		await client.plugin("jobs/cancel", { id: third.id });
		const fourth = await create();
		expect(fourth).not.toHaveProperty("skipped");
		expect((await client.runToEnd((fourth as Job).id)).counters).toMatchObject({
			created: 1,
			unchanged: 3,
		});
	});
});

describe("M5a kill and resume of a rollback", () => {
	it("finishes a rollback a crash cut off mid-batch, deleting every entry once", async () => {
		await client.createProducts("it_rb_crash");
		const rowsCount = 300;
		const job = await importCsv(productsCsv(rowsCount), template("it_rb_crash"), {
			batchSize: 100,
		});
		expect(job.counters).toMatchObject({ created: rowsCount });
		const created = await client.plugin("jobs/rollback", {
			id: job.id,
			batchSize: 100,
			budgetMs: 2_000,
		});
		await client.plugin("jobs/next", { id: created.id });
		const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
		await sleep(400);
		await stopServer(server, "SIGKILL");
		const interrupted = (await inFlight) === null;
		await restart();
		const killed = await waitForLease(created.id);
		if (!interrupted) throw new Error("The kill did not cut off a jobs/next call in flight");
		expect(killed.status).toBe("running");
		expect(killed.cursor.seq).toBeLessThan(rowsCount);
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { reverted: rowsCount, failed: 0, conflict: 0 },
		});
		expect(await client.records(created.id, "writing")).toEqual([]);
		expect(await client.listAll("it_rb_crash")).toEqual([]);
		const again = await importCsv(productsCsv(rowsCount), template("it_rb_crash"), {
			batchSize: 100,
		});
		expect(again.counters).toMatchObject({ created: rowsCount, failed: 0 });
	});
});
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rollback.test.ts`
Expected: PASS (1 file, 14 tests, about 60 s with the server start). This proves on Node, for a revisioned and a plain collection, that a job creating 20 entries and updating 10 (taxonomy with a created term, multiple reference, bylines, image, Portable Text, boolean) is planned by a dry run without a write and with the kept-media and kept-terms warnings, then rolled back to exactly the data, slug, status, draft flag, terms, bylines and references read before it, with the created entries gone (not in Trash) and the same feed importing again without a conflict; that an editor's change is `rollback_changed` and left as the editor made it; that two jobs roll back newest first and conflict oldest first; that the importer's pending draft (`publish: false`) survives the rollback of the publishing job after it; that a scheduled entry is scheduled again; that an English rollback refused for active French translations completes on `jobs/retry` after the French rollback; that a URL source re-imports after a rolled-back and after a cancelled job; and that a rollback killed mid-batch (SIGKILL) finishes after the restart with every entry deleted once. Then run `pnpm test:integration` (Fact F1 and Fact F3 describe the known flakes): all files pass.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`; restore `sites/dev/emdash-env.d.ts` if the dev server changed it (`git checkout sites/dev/emdash-env.d.ts`), then:
```bash
git add packages/flux-import/tests/integration/rollback.test.ts
git commit -m "Prove M5a rollbacks end to end on the Node dev site"
```

### Task 8: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through the plugin routes; the parity harness (`client`, `d1`, `byKey`, `importCsv`), `createLinkSchema`, `linkNames`, `PEOPLE_CSV`, `POSTS_CSV`, `peopleTemplate`, `postsTemplate`.
- Produces: the workerd tests "rolls back an M5a create-and-update job on D1, resumed after a stop mid-batch" and "restores M5a links on D1: terms, bylines and references".

- [ ] **Step 1: Add the tests**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
````ts
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
	});

	it("reads edit locks from D1: the importer's own lock passes, another user's lock skips", async () => {
		await client.createProducts("cf_locks");
		await importCsv("cf_locks", productsCsv(2));
````
with:
````ts
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
	});

	it("rolls back an M5a create-and-update job on D1, resumed after a stop mid-batch", async () => {
		await client.createProducts("cf_m5a");
		await importCsv("cf_m5a", productsCsv(5));
		const stateOf = async () =>
			new Map(
				[...(await byKey("cf_m5a"))].map(([key, e]) => [
					key,
					{ slug: e.slug, status: e.status, data: e.data },
				]),
			);
		const before = await stateOf();
		const feed = productsCsv(10, (i) => `${i + 40}`);
		const job = await importCsv("cf_m5a", feed);
		expect(job.counters).toMatchObject({ created: 5, updated: 5, failed: 0 });
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const first = await client.plugin("jobs/next", { id: rollback.id });
		// The Workers cap: three rows per rollback batch.
		expect(first.counters.reverted).toBe(3);
		// A stop after the batch wrote its rows, before it saved its cursor: put both back.
		d1(
			`UPDATE _plugin_storage SET data = json_set(data, '$.cursor.seq', 9007199254740991, '$.counters.reverted', 0) WHERE plugin_id = 'flux-import' AND collection = 'jobs' AND id = '${rollback.id}'`,
		);
		const done = await client.runToEnd(rollback.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { reverted: 10, conflict: 0, failed: 0 },
		});
		expect(await stateOf()).toEqual(before);
		const again = await importCsv("cf_m5a", feed);
		expect(again.counters).toMatchObject({ created: 5, updated: 5, failed: 0, conflict: 0 });
	});

	it("restores M5a links on D1: terms, bylines and references", async () => {
		// Byline slugs take no underscore.
		const n = { ...linkNames("cf_m5a"), alex: "cf-m5a-alex", sam: "cf-m5a-sam" };
		await createLinkSchema(client, n);
		const importLinked = async (csv: string, template: object) => {
			const { uploadId } = await client.upload(csv);
			const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
			return client.runToEnd(job.id);
		};
		// The M4b test's bylines have the same display names, so these match by slug.
		const template = {
			...postsTemplate(n),
			bylines: { from: "Authors", match: "slug", separator: ";" },
		};
		const bySlug = (csv: string) => csv.replaceAll("Alex Doe", n.alex).replaceAll("Sam Lee", n.sam);
		await importLinked(PEOPLE_CSV, peopleTemplate(n));
		expect((await importLinked(bySlug(POSTS_CSV), template)).counters).toMatchObject({
			created: 3,
			failed: 0,
		});
		const linksOf = async () => {
			const out: Record<string, unknown> = {};
			for (const [key, post] of await byKey(n.posts)) {
				const { item } = await client.api<{ item: Product }>(
					"GET",
					`/_emdash/api/content/${n.posts}/${post.id}?locale=en`,
				);
				out[key] = {
					author: item.references?.author?.children.map((c) => c.id),
					related: item.references?.related?.children.map((c) => c.id),
					bylines: item.bylines?.filter((b) => b.source === "explicit").map((b) => b.byline.slug),
					category: await client.entryTerms(n.posts, post.id, n.category),
					tag: await client.entryTerms(n.posts, post.id, n.tag),
				};
			}
			return out;
		};
		const before = await linksOf();
		const changed = [
			"id,Title,Author,Related,Categories,Tags,Authors",
			"P1,Desk review,A2,lamp-review,Garden,sale,Sam Lee",
			"P2,Lamp review,A1,,Electronics > Tablets,,Alex Doe",
			"",
		].join("\n");
		const job = await importLinked(bySlug(changed), template);
		expect(job.counters).toMatchObject({ updated: 2, failed: 0 });
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, failed: 0, conflict: 0 });
		expect(done.warnings).toEqual([
			expect.stringMatching(/^The import created 1 terms, which are kept/),
		]);
		expect(await linksOf()).toEqual(before);
	});

	it("reads edit locks from D1: the importer's own lock passes, another user's lock skips", async () => {
		await client.createProducts("cf_locks");
		await importCsv("cf_locks", productsCsv(2));
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M5a"`
Expected: PASS (2 passed, 14 skipped; about 20 s of tests plus about 20 s of server start). This proves on workerd and D1 that a job creating 5 entries and updating 5 is rolled back in batches of three (the Workers cap), resumes correctly after a stop that lost the first batch's cursor and counters (Ruling 12), restores the entries exactly and lets the same feed import again; and that terms, bylines and both kinds of references are restored, with the kept-terms warning. The full `pnpm test:cf` runs in Task 9.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove M5a rollbacks on workerd and D1"
```

### Task 9: M5a review run

**Files:**
- Create: `docs/superpowers/notes/2026-11-03-m5a-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`; if Step 2 lowers a cap, `packages/flux-import/src/plugin/service.ts` and the tests that name it
- Temporarily (reverted before the commit): `packages/flux-import/src/plugin/d1-count.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration-cf/d1-count.test.ts`

**Interfaces:**
- Consumes: everything above, and the Task 0 results in "Facts this plan relies on".
- Produces: the filled-in review note, the measured V7 and V8 counts (and a lowered cap if one is over the limit), and the roadmap status.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` about 25 minutes, almost all of it the unchanged 10,000-row case; Facts F1-F3 describe the known flakes). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Measure D1 queries per batch (V7 and V8)**

Create the temporary counter `packages/flux-import/src/plugin/d1-count.ts`:
```ts
// TEMPORARY (Task 9 Step 2): counts D1 statements during one call. Reverted before the commit.
import { onWorkers } from "../emdash/workers.js";

export async function countD1<T>(run: () => Promise<T>): Promise<{ value: T; queries: number | null }> {
	if (!onWorkers()) return { value: await run(), queries: null };
	const spec = "cloudflare:workers";
	const mod = (await import(/* @vite-ignore */ spec)) as { env: Record<string, unknown> };
	const db = mod.env.DB as object;
	let n = 0;
	const restores: (() => void)[] = [];
	const patch = (proto: Record<string, unknown>) => {
		const original = proto.prepare as (...a: unknown[]) => unknown;
		proto.prepare = function (this: unknown, ...a: unknown[]) {
			n++;
			return original.apply(this, a);
		};
		restores.push(() => {
			proto.prepare = original;
		});
	};
	patch(Object.getPrototypeOf(db));
	const withSession = (db as { withSession?: (...a: unknown[]) => unknown }).withSession;
	if (withSession) {
		const sp = Object.getPrototypeOf(withSession.call(db, "first-unconstrained") as object);
		if (sp !== Object.getPrototypeOf(db)) patch(sp);
	}
	try {
		return { value: await run(), queries: n };
	} finally {
		for (const r of restores) r();
	}
}
```
In `packages/flux-import/src/plugin/routes.ts`, wrap the `jobs/next` handler's `nextBatch(…)` call as `countD1(() => nextBatch(…)).then(({ value, queries }) => ({ ...withoutPlannedTerms(value), d1Queries: queries }))` (import `countD1` from `./d1-count.js`). Then create `packages/flux-import/tests/integration-cf/d1-count.test.ts`, reusing the parity file's helpers (copy `client` and the fixtures' imports), with three cases that call `jobs/next` one batch at a time and print `d1Queries` for every batch:
1. **V7.** `createLinkSchema(client, { ...linkNames("cf_v7"), alex: "cf-v7-alex", sam: "cf-v7-sam" })`; import `PEOPLE_CSV`, then `POSTS_CSV` with `postsTemplate`; import the three posts again with another title, author, related post, category, tag and byline each (three reverted updates with every link kind); `jobs/rollback` of that job with `budgetMs: 20_000`; run it to the end. The largest batch must stay under about 900 queries.
2. **V8, translation template.** `createTranslationSchema(client, translationNames("cf_v8"))`; import 10 English rows with `englishTemplate`, then 10 French rows naming them with `translationTemplate(n, "fr")`, `batchSize: 10`, `budgetMs: 20_000`.
3. **V8, references template.** On the V7 schema, import 10 posts whose `Related` column names three earlier posts each, with categories, tags and bylines, `batchSize: 10`, `budgetMs: 20_000`.

Run: `pnpm exec vitest run --config vitest.cf.config.ts tests/integration-cf/d1-count.test.ts`. Record every batch's count in the note. If a V7 batch is over about 900, lower `WORKERS_ROLLBACK_BATCH_CAP` in `src/plugin/service.ts` to the largest count of rows that fits (per-row cost: the largest batch divided by its rows) and change the `3` in `tests/unit/rollback-jobs.test.ts` ("caps a rollback batch on Workers at three rows") and in the parity test ("rolls back an M5a create-and-update job…": `first.counters.reverted`) to match; if a V8 batch is over about 900, lower `WORKERS_LINKED_BATCH_CAP` the same way (it settles the M4e open issue on linked batches). Re-run `pnpm test` and `pnpm exec vitest run --config vitest.cf.config.ts -t "M5a"` after any change. Then delete `src/plugin/d1-count.ts` and `tests/integration-cf/d1-count.test.ts` and revert the `routes.ts` wrap (`git checkout packages/flux-import/src/plugin/routes.ts`); `git status` shows only the cap change, if any.

- [ ] **Step 3: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` and `sites/dev/uploads` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass`, record each result:
1. Create a revisioned collection with `client.createProducts("m5a")`, import `productsCsv(3)` with `template("m5a")`, then `productsCsv(5, (i) => String(i + 10))` (3 updated, 2 created). Run `jobs/rollback` with `dryRun: true`: 5 `planned` rows, the updated ones with their changes, nothing written (check in the admin).
2. Run it for real: the two created entries are gone (also from the admin's Trash), the three updated entries show their first prices in the admin, and their revision history has the rollback's revisions on top.
3. Import the second feed again: `created: 2`, `updated: 3`, no conflict. Edit one entry's title in the admin and publish it; run `jobs/rollback` of the last job: that entry's row is `conflict` with `rollback_changed`, the editor's title stays, the other four rows are `reverted`.
4. Run `jobs/cancel` on the rollback job of a fresh rollback before its first batch: `409` "Cannot cancel a rollback job: pause it, or resume it to finish"; `jobs/resume` of a rolled-back original: `409` naming the rollback job.
5. Restore `sites/dev/data.db*` and `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note and any cap change.

- [ ] **Step 4: Write the review note**

Create `docs/superpowers/notes/2026-11-03-m5a-review.md` from this template and fill in every `…`:
```markdown
# Milestone 5a review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0) and query counts (Step 2)

| Fact | Check | Result |
| --- | --- | --- |
| V1: values written back as read compare equal (booleans by truth, key order ignored, null as absent), on Node and workerd | drafting probe (plan Facts); Tasks 3 and 7 | … |
| V2: trashed entries left out of reads and source-ID lists; `getIncludingTrashed` keeps `_rev` | drafting probe; Task 2 | … |
| V3: `createdAt === updatedAt` after a create; the read `_rev` is the create's | drafting probe; Task 6 | … |
| V4: Trash and permanent delete free the slug on SQLite and D1; a deleted translation keeps its source's links | drafting probe; Tasks 7 and 8 | … |
| V5: the amended revert sequence restores the four pre-states on both collection types (the first sequence failed two) | drafting probe; Tasks 6 and 7 | … |
| V6: 1 MiB plugin storage value on D1 | drafting probe | … |
| V7: D1 queries per rollback batch of `WORKERS_ROLLBACK_BATCH_CAP` reverted updates with every link kind (limit 1,000) | Step 2 | … per batch; cap … |
| V8: D1 queries per linked import batch of `WORKERS_LINKED_BATCH_CAP` on a translation template and on a references template | Step 2 | … per batch; cap … |

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
| Unit, journal: write-ahead before each kind of write, first touch wins and merge, `journal_too_large`, `journal_incomplete`, `journalMedia`, `LinkRow.jobId`, no journal for dry runs and `journal: false` | `journal.test.ts`, `journal-jobs.test.ts` | … |
| Unit, rollback: every "Per row" verdict and each pre-image shape of the revert sequence, ownership (link row, resumed row, editor, later job), the chain, translations, unconfirmed creates, resumes, hook refusals, passed schedule, missing term, dry run | `rollback.test.ts`, `rollback-values.test.ts`, `content.test.ts`, `fakes.test.ts` | … |
| Unit, jobs: `jobs/rollback` refusals and warnings, `rolledBackBy` blocks resume and retry, cancel refused, retention, `lastImport` on cancel and rollback, the Workers cap | `rollback-jobs.test.ts`, `journal-jobs.test.ts` | … |
| Integration on `sites/dev` (spec list, with Rulings 12 and 13) | `rollback.test.ts` (integration) | … |
| Cloudflare parity on `sites/dev-cf` | `parity.test.ts` (`-t "M5a"`) | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Dry-run rollback plans every row and writes nothing | … | … |
| 2 | Rollback deletes the created entries (not in Trash) and restores the updated ones | … | … |
| 3 | The feed re-imports cleanly; an editor's change is `rollback_changed` and kept | … | … |
| 4 | Cancel refused for a rollback job; resume refused for a rolled-back job | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
```

- [ ] **Step 5: Mark M5a done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| **M5a** ([spec](./2026-11-03-flux-import-m5a-journal-rollback-design.md)) | Run journal and rollback: a write-ahead pre-image of every entry a job creates or changes (data, slug, links, status, schedule, pending draft), a record of the media it creates, the job that last wrote each link; `jobs/rollback` as a resumable, dry-runnable job that deletes created entries and restores changed ones, refusing entries changed since; `lastImport` cleared on cancel and rollback | Spec |
```
with:
```markdown
| **M5a** ([spec](./2026-11-03-flux-import-m5a-journal-rollback-design.md)) | Run journal and rollback: a write-ahead pre-image of every entry a job creates or changes (data, slug, links, status, schedule, pending draft), a record of the media it creates, the job that last wrote each link; `jobs/rollback` as a resumable, dry-runnable job that deletes created entries and restores changed ones, refusing entries changed since; `lastImport` cleared on cancel and rollback | Done ([review](../notes/2026-11-03-m5a-review.md)) |
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-11-03-m5a-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 5a review results and mark M5a done in the roadmap"
```
If Step 2 lowered a cap, add `packages/flux-import/src/plugin/service.ts` and the changed tests to the same commit and say so in the message body.

---

## After this plan

M5a meets Milestone 5's acceptance ("a finished run rolls back to its pre-run state") for the writes M2-M4e make. Known gaps carried forward, all documented in the spec or in the rulings above: media and terms a job created are kept (EmDash cannot tell whether other content uses a media item, and has no term deletion for plugins); a crash between a media upload and its `journalMedia` put leaves the item off the list; an entry crash repair found is only moved to Trash; restored non-translatable values sync to translations and move their `_rev`, so translation jobs must be rolled back first; an entry the run published for the first time keeps `publishedAt` and sees the publish hooks once more (Ruling 1); revisions written by the job and the rollback stay in the entry's history; jobs created before M5a, dry runs and `journal: false` jobs cannot be rolled back. M5b (record rules) and M5c (missing entries) journal their writes in the M5a format and extend the revert sequence. The M2-M4e open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-11-03-m4e-review.md`) are unchanged by this plan, except the linked batch cap, which Task 9 measures (V8); the production Cloudflare build blocker from M2 still stands.
