# Flux Import M5b: record rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below), and Task 0 changes no file. Tasks 1, 2 and 3 can run in parallel worktrees, and so can Tasks 8 and 9. The rest follow in order (see "Parallel execution").

**Goal:** Let a template say how each record treats the entry it matches, and when the entry goes live. The template gains `rules`:
- `mode`: `upsert` (the default), `create` or `update`. A skipped record is `unchanged` with the warning `exists` or `not_found`.
- `updateFields`: an update compares and writes only the listed mappings.
- `protectEdited`: a mapping changed outside the import since the importer last wrote it is kept, and the record warns `field_edited`. Edits are detected by per-mapping fingerprints on the link row, using only reads the record already makes.

The template also gains a `publishAt` value mapping. A future time schedules the written content; a past, empty or too-near time publishes now. Every new write is journalled in the M5a format and rolls back. The revert sequence gains step 7, `unschedule`, and a rollback still owns an entry that EmDash's scheduler published since. Templates stay `version: 1`. A template without `rules` and `publishAt` behaves as in M5a, except that its link rows now also carry fingerprints.

**Architecture:** by task:
- **Task 1.** `src/engine/template.ts` gains the `rules` and `publishAt` schemas, the `publishAt` conversion, `mappingNames` and the job refusals. `src/engine/jobs.ts` and `src/plugin/routes.ts` gain `Job.revisions`. `src/emdash/schema.ts` reads `supports`.
- **Task 2.** `src/engine/fingerprints.ts` (new) holds the canonical forms and the digest.
- **Task 3.** `src/engine/revs.ts` (new) decodes `_rev`. `ContentPort` gains `schedule`, the revert steps gain `unschedule`, and the fakes model EmDash's `_rev`, schedule, unschedule, sweep and terms route.
- **Tasks 4-6.** `src/engine/rules.ts` (new) holds the decisions: write modes, narrowing, protection and the publish target. `src/engine/batch.ts` uses them, in this order:
  - Task 4: the early entry lookup, the mode skip and `updateFields` narrowing, then the recording and refresh of fingerprints.
  - Task 5: protection with side-effect-free resolution.
  - Task 6: the schedule call, its crash repair and the `publishAt` change.
- **Task 7.** `src/engine/revert.ts` gains step 7, ownership after the scheduler, and the link hand-back of `fields` and `scheduledAt`.
- **Tasks 8 and 9.** These prove it on Node and on workerd, through a dev-only route in each test site that runs EmDash's scheduled maintenance.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine), Biome 2, EmDash 1.2.0, Astro 7.3. Workerd parity runs through `@astrojs/cloudflare` 14 and Wrangler 4. Fingerprints use Web Crypto (`crypto.subtle.digest`), which Node 22 and workerd both provide. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-flux-import-m5b-record-rules-design.md`, all sections, amended by `eaebca2` (see Rulings 1-5). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 5 split). Previous plan: `docs/superpowers/plans/2026-11-03-flux-import-m5a-journal-rollback.md`. Its review: `docs/superpowers/notes/2026-11-03-m5a-review.md`. That review's fakes findings are the reason for Ruling 11.

How this plan was checked while drafting (results in "Verification while drafting"):
- Every code block in Tasks 1-9 was written, type-checked, linted and run: the unit suite, the new Node integration file, the new workerd parity tests and a temporary D1 query counter.
- The plan was then replayed task by task from `79cd131` (the spec commit) in a fresh worktree. A script parsed this document's code blocks and replacements and applied them in order.

Two citation conventions: EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0, and the spec's facts F1-F14 are cited as "spec F<n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID is `flux-import`. The package exports stay `fluxImport()`, `fluxImportRoutes()` and `createPlugin()`.
- New template keys: `rules` (`mode`, `updateFields`, `protectEdited`) and `publishAt` (`from` or `expr`, `format`, `tz`).
- New data fields: `Job.revisions`, `LinkRow.fields`, `LinkRow.scheduledAt`, and `JournalBefore.link.fields` and `.scheduledAt`.
- New port: `ContentPort.schedule`, and the revert step `unschedule`.
- No new route, storage collection or capability. `handleContentSchedule` and `handleContentUnschedule` are on the trusted runtime the plugin already uses (spec "Decisions", Capabilities).
- No new dependencies; no task touches `package.json` or `pnpm-lock.yaml`.

**Environment**
- Node `>=22.16`. Run `nvm use` (it reads `.nvmrc`) before any command. In agent shells, prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`, because the default node is v16.
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only: never `cat >`, `cat >>` or heredocs through `cat`.

**Code rules**
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- The engine (`src/engine/`) never imports `emdash`. The runtime handlers are reached only through `ContentPort` in `src/emdash/content.ts`.
- Use EmDash APIs only as documented or as read in `node_modules/emdash`, cited by file and line.
- No raw SQL in plugin code. The tests use SQLite only to strip a link row's `fields`, a state no API offers.
- The test sites' route `src/pages/test/run-scheduled.ts` answers 403 unless `import.meta.env.DEV`.

**Running tests**
- Vitest runs from `packages/flux-import` with file paths, for example `pnpm exec vitest run tests/unit/schedule.test.ts`.
- Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/record-rules.test.ts`.
- Workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M5b"`.
- Ports: the new Node integration file starts its own server on port 4391, the M5a rollback suite's port. The suites run one at a time (`fileParallelism: false`). The shared server uses 4399, the workerd harness 4396, and the other suites 4392-4395, 4397 and 4398. Never run two copies of the same harness at once.
- A Windows process (`Cursor.exe`) may hold 4397 through WSL's mirrored networking, which fails `retention.test.ts` in setup (Fact F3).

**Codes, exactly**
- Warnings: `exists`, `not_found`, `field_edited`, `not_scheduled`.
- Errors: `schedule_conflict` (conflict), `schedule_locked` (locked), `schedule_unverified` (conflict), `emdash_schedule_rejected` (failed), and `invalid_date` / `not_scalar` with field `publishAt` (failed).
- Job refusals: `invalid_template` and `invalid_options` (400). Rollback rows keep the M5a codes.
- The messages are given in the tasks, word for word.

**Repository hygiene**
- Never commit `sites/dev/.env`, tokens, or the changes the dev server writes to `sites/dev/emdash-env.d.ts`. The shared integration setup restores the file; restore it by hand after any other server run.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`.
- Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.

**Definition of done**
- `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root.
- Task 8 also passes its integration file (about 140 s with server start, most of it the wait for a schedule to fall due) and `pnpm test:integration`.
- Task 9 passes the targeted workerd tests (about 125 s with the server start, most of it the wait for a schedule to fall due).
- Task 10 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. **A skipped record has no side effects, and no decision costs a read the record did not already make.** The early lookup reuses the link row and `content.get`. A mode skip happens before any link resolution, term creation, media lookup, download or translation-source read. Evidence: Task 4 ("skips… before resolving anything", the translation tests).
2. **Canonical forms agree with the plan's comparison.** Two values `planRecord` calls the same must have the same fingerprint, for every value kind and every comparison mode. Evidence: Task 2 (the property test `same ⇒ equal fingerprint`), V1 on both databases.
3. **Protection never writes over an edited mapping.** Rows of the protection table:
   - a pre-M5b link counts every taxonomy as edited (spec F8);
   - an unmoved `_rev` vouches only for non-taxonomy mappings (Ruling 1);
   - protected mappings resolve without creating terms or downloading;
   - protection lifts only by equality or by a job without `protectEdited`.

   Evidence: Task 5, Task 8 (REST edits, the terms route, bylines, a stripped link row).
4. **The publish table is followed exactly.** A schedule call happens only after the importer's own write or for its own pending state, never for someone else's. Collections without revisions, and links-only updates, warn `not_scheduled` (Ruling 2). A stop between the schedule call and the link put is adopted only by `_rev` arithmetic, otherwise `schedule_unverified`. Evidence: Task 6, Task 8 (kill and resume).
5. **Rollback owns only what the importer and the scheduler did.** Step 7 runs exactly when the rollback would leave a schedule the pre-image lacked. Ownership after the scheduler accepts only the sweep's publish (one `version`, at or after the time, published, no draft, no schedule). Evidence: Task 7 (a mutation run against the M5a `revert.ts` fails 7 of its 10 tests), Task 8 (rollbacks before and after the sweep).
6. **Templates without rules behave as before.** The only changes they see are the fingerprints on their link rows (and the refresh that writes them once) and the `_rev` the fakes now encode as EmDash does. Every M2-M5a unit, integration and parity test passes. The only edits to them are that encoding (Task 3) and the `fields` in one journal expectation (Task 4).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V7 are the facts the spec left unconfirmed.

How V1-V6 were proven:
- A temporary probe route (`probe/m5b`) called the runtime's handlers: create, update, publish, schedule, unschedule and `runScheduledTasks`.
- A probe test ran it on `sites/dev` (port 4420) and `sites/dev-cf` (port 4421).
- Each site had a collection with revisions and one without. Each collection had every M4a-M4d field type, a single and a multiple reference, a child-side reference, a tag taxonomy and two bylines.
- The probe was reverted afterwards. The Node and workerd results were identical after normalising IDs, revisions and timestamps.

V7 was measured with the M5a D1 counter (Task 9 Step 2 of the M5a plan) on the finished code.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds under the canonical forms.** For every value kind, the fingerprint of the value sent equals the fingerprint of what `handleContentGet` and the terms route return afterwards, both live and staged in a draft. The raw values differ in ways the canonical forms absorb (Task 2):<br>- booleans read back as `1`/`0`;<br>- datetimes come back as UTC with milliseconds;<br>- an image reads back with extra keys;<br>- a `null` written reads back as an absent key;<br>- terms and child-side references come back as unordered sets. | Probe, 16/16 kinds on Node and on workerd, checked offline against the Task 2 functions; Task 2 property test |
| V2 | **Holds.** One edit changes only its own mapping's fingerprint:<br>- a REST `PUT` of one field (revisioned: draft save then publish; plain: direct) changes only that field's;<br>- a term change through the terms route changes only the taxonomy's and leaves `_rev` as it was (spec F8);<br>- a `PUT` of the bylines changes only the bylines'.<br>A `PUT` that sends the values back as read changes no fingerprint, but moves `_rev` (by 2 on the revisioned collection) and stages a draft. | Probe; Task 5; Task 8 |
| V3 | **Holds.** On both collections and databases:<br>- create then schedule gives `scheduled`;<br>- update of a published entry then schedule gives, on the revisioned collection, `published` with a draft and `scheduledAt`;<br>- a reschedule replaces the time;<br>- an update keeps the schedule;<br>- publish clears it.<br>Schedule and unschedule keep `version` and move `updatedAt` (spec F2, F3). A time in the past is `VALIDATION_ERROR`. A naive time was stored as UTC on the probe sites. The routable-slug requirement refused nothing that publish accepted.<br>Other observations:<br>- A revisioned update with data and links moved `version` by 2 (spec F7 says 1; nothing here depends on the step).<br>- On workerd, one publish returned an `updatedAt` a few milliseconds earlier than the previous one. The ownership rule compares the entry's `updatedAt` with the link's `scheduledAt`, never two EmDash timestamps. | Probe; Task 3 fakes; Task 6 |
| V4 | **Holds.** `runScheduledTasks()` publishes a due entry with one more `version`, `published`, no draft, `scheduledAt` null, and `publishedAt` equal to the scheduled time on first publication. It skips a trashed scheduled entry. Nothing sweeps on workerd under `astro dev`. Node's timer sweeps about once a minute. | Probe; Fact E1; Tasks 7-9 |
| V5 | **Holds.** `handleContentUnschedule` with `_rev` returns a scheduled draft to `draft`, and a published entry with a scheduled draft to `published` with its draft and no schedule. Followed by the M5a sequence, it restores both pre-states on both collection kinds. | Probe; Task 7 |
| V6 | **Holds.** `getCollectionWithFields` returns `supports` (and so does `getCollection`), so `Job.revisions` reads it at job creation. | Probe; Task 1 |
| V7 | **Holds; the caps stay.** D1 queries per `jobs/next` batch with the M5b code (limit 1,000):<br>- at `WORKERS_BATCH_CAP` 11, scheduled creates ran 685 and 660;<br>- 11 scheduled updates with `protectEdited` and a fingerprint refresh each (an editor's title the feed repeats) ran 770 and 772;<br>- at `WORKERS_LINKED_BATCH_CAP` 6 (three references, two taxonomies with a created path, two bylines), scheduled creates ran 605 and 590, and scheduled protected updates with a refresh ran 722 and 699;<br>- at `WORKERS_ROLLBACK_BATCH_CAP` 3, a rollback of those linked updates ran 490 per batch, a rollback of linked drafts the job scheduled (step 1, then step 7) ran 453, and unlinked scheduled updates ran 276-278.<br>The largest batch is 772, so no cap changes. | Temporary counter (`d1-count.ts` and a `d1-count.test.ts` with these cases), reverted; Task 10 re-measures |
| E1 | **Driving the sweep in tests.** A page in a test site can call `runScheduledTasks` from `emdash/middleware` (`dist/astro/middleware.d.mts:30-35`): it runs one pass of the runtime's scheduled maintenance, on Node and on workerd. Astro routes no file or folder whose name starts with `_`, so the page is `src/pages/test/run-scheduled.ts`. On Node the runtime's own timer may publish an entry first, so the tests check the entries' state, not the route's list. | Tasks 8 and 9 drafting runs |
| E2 | **Long timers fire early.** On this WSL2 machine a 64-second `setTimeout` once fired before the wall clock reached the time it waited for (the sweep at `16:32:30.677Z` for a schedule at `16:32:30.691Z`). The tests poll the sweep for up to a minute instead of sleeping once. | Task 8 drafting run |
| E3 | **Test rows need unique slugs.** EmDash slugs are unique per collection and locale, Trash included, so two rows named "Desk" in one collection fail the second create. The Node test derives each handle from the key and the name. | Task 8 drafting run |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart, and `crash.test.ts` can then fail its precondition. This has been known since M3c; re-running the file settles it. | M3c-M5a plans |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d did not recur while drafting. If Task 9 or Task 10 sees it, capture the server log and record it in the review note. | M4d-M5a reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4397`, which WSL's mirrored networking shares, so `retention.test.ts` fails in setup with "Port 4397 is in use". | M4d-M5a reviews |

## Rulings this plan makes

1. **An unmoved `_rev` vouches for every mapping but taxonomies** (spec amended in `eaebca2`). The spec's table, for a link row with `fields`, counts a mapping as edited when its fingerprint differs from the current value's. That misreads the importer's own pending draft:
   - the slug a draft stages is not readable (spec F13), so the current slug's fingerprint differs from the one sent;
   - the same is true of any value a later read cannot see as written.

   So, with `fields`, a mapping is edited when its fingerprint is missing, or when it differs **and** either the mapping is a taxonomy (term edits do not move `_rev`, spec F8) or `entry.rev !== link.writtenRev`. Without `fields`, the spec's two rows apply unchanged (`editedMappings` in `src/engine/rules.ts`).
2. **`not_scheduled` also covers links-only updates** (spec amended). An update of a published entry that changes only terms or bylines stages no draft (M5a V5), so it goes live at once on a revisioned collection too. The record warns `not_scheduled` with "Not scheduled: the update went live at once (the collection keeps no revisions, or only terms and bylines changed)" and makes no schedule call.
3. **Data sent on an update** (spec amended). As in M2-M5a, an update's `data` holds every listed, unprotected mapped data field, not only the changed ones; EmDash writes the unchanged ones back equal. Data and slug are left out when only links changed, as in M5a.
4. **A dry-run rollback reports step 7 through M5a's change** (spec amended). M5a's dry-run rollback already plans a schedule difference as `{ field: "scheduledAt", before: <current>, after: <restored> }`. Step 7 is that change with `after: null`, so no separate `publishAt` change is added.
5. **Spec F7, corrected** (spec amended). On a revisioned collection, an update that sends data and links together moves `version` by 2 (V3). Crash repair compares `version` only between the write's `_rev` and the schedule's, which no update separates, so no rule changes.
6. **Skipped rows in a dry run.** They are `planned` with `action: "unchanged"` and the `exists` or `not_found` warning, and count in `unchanged`, as a dry run's unchanged rows do today. They have no `changes`.
7. **Someone else's schedule is a pending state.** An entry with a `scheduledAt` that the link's `writtenRev` does not account for counts as pending, even without a draft. An update is then `pending_draft`, and an unchanged record stays `unchanged` (spec "Publish, draft or schedule", the "someone else's pending state" rows).
8. **Resolution errors still fail a record.** A protected mapping is resolved without side effects. If even that resolution errors (an unknown reference key, an ambiguous byline), the record fails as it would without protection: protection decides what is written, not whether the feed is valid.
9. **The schedule ownership rule** (`sweptSince` in `src/engine/revert.ts`). A link with `scheduledAt` and an entry whose `_rev` decodes (`decodeRev`, spec F1) to exactly one `version` past `writtenRev`, with `updatedAt >= link.scheduledAt`, `status: "published"`, no draft and no `scheduledAt`. A `writtenRev` that does not decode (a fake's or a pre-M5b link's) never passes. Trashed entries never pass.
10. **The link hand-back.** A restored link carries `before.link.fields` and `before.link.scheduledAt` (both copied into the journal by `linkBefore` since Task 1). Its `writtenRev` is the rollback's last `_rev`, as in M5a.
11. **The fakes model EmDash** (the M5a review's lesson). `FakeContent` encodes `_rev` as `base64("version:updatedAt")` (`encodeRev`). It also models:
    - a draft save that bumps `version` and keeps `updatedAt`;
    - schedule and unschedule, which keep `version` and stamp `updatedAt`;
    - publish, which clears the schedule;
    - unpublish, which leaves a stale draft;
    - term edits through `setTerms`, which leave the `_rev`;
    - slug uniqueness that includes Trash;
    - `runScheduled()`, the sweep.

    Tests read revisions through `revOf(id)`.
12. **Integration states no API offers.** The pre-M5b link row is made by removing `fields` through SQLite. The sweep runs through the dev-only route (Fact E1), polled (Fact E2). The kill-and-resume is a SIGKILL mid-batch of 300 scheduled creates, as in M3-M5a. Aiming a kill between the schedule call and the link put is not possible from outside, so that window is proven in the unit suite (`afterSchedule` throws).

## Verification while drafting

Run on Node v22.23.1 and EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (174 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 69 files / 1,634 tests pass (62 / 1,537 at `79cd131`) |
| Task 0 (V1-V7) | all hold (Facts V1-V7), on Node and workerd, with a temporary probe route and probe test and a temporary D1 counter, reverted afterwards |
| Task-by-task replay | From `79cd131` in a fresh worktree, a script parsed this document and applied Tasks 1-9 in numeric order with no failed replacement. Each "see them fail" step failed and each "see them pass" step passed with the counts given in the task. Typecheck, lint and `pnpm test` passed after every task. The resulting tree is byte-identical to the drafting tree (git tree `920909c`). Tasks 1, 2 and 3 were each also applied alone on `79cd131`: each typechecks and passes its own tests |
| Mutation check | Task 7's tests against Task 6's `revert.ts` (with a stub `sweptSince`): 7 of 10 fail |
| Node integration | `record-rules.test.ts`: 1 file / 14 tests pass in 141 s with the server start. Full `pnpm test:integration` on the drafting tree: 15 of 16 files, 107 tests passed and 1 skipped in 810.6 s; `retention.test.ts` failed in setup on port 4397 (Fact F3) |
| workerd | `-t "M5b"`: 3 passed, 16 skipped in 124 s. Full `pnpm test:cf` on the drafting tree: 19 of 19 tests passed in 1,529.5 s. Task 10 runs the full suites again |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/template.ts`, `src/engine/types.ts`, `src/engine/jobs.ts`, `src/engine/journal.ts`, `src/emdash/schema.ts`, `src/plugin/routes.ts` | `rules` and `publishAt` schemas, `publishAt` conversion, `mappingNames`, `rulesProblems`; `Job.revisions`, `LinkRow.fields`/`scheduledAt`, the journal's link snapshot; `collectionRevisions`, `publishAtCollection` (Task 1) |
| `src/engine/fingerprints.ts` (new), `src/engine/diff.ts` | Canonical forms, `fingerprint`, `currentForms`, `sentForms`, `fingerprintsOf`; `same` exported (Task 2) |
| `src/engine/revs.ts` (new), `src/engine/ports.ts`, `src/emdash/content.ts`, `src/engine/revert.ts`, `tests/unit/fakes.ts` | `encodeRev`, `decodeRev`; `ContentPort.schedule`, the `unschedule` step and its cost; the fakes as EmDash behaves (Task 3) |
| `src/engine/rules.ts` (new), `src/engine/batch.ts` | Write modes, narrowing, fingerprint recording and refresh (Task 4); protection, side-effect-free resolution (Task 5, with `src/engine/resolve.ts`); the publish target, schedule call and its crash repair (Task 6) |
| `src/engine/revert.ts` | Step 7, ownership after the scheduler, the link hand-back (Task 7) |
| `tests/integration/record-rules.test.ts` (new), `sites/dev/src/pages/test/run-scheduled.ts` (new), `sites/dev-cf/src/pages/test/run-scheduled.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 8 and 9) |

`src/engine/links.ts`, the Portable Text modules, the source readers, `src/plugin/definition.ts`, `src/plugin/service.ts` (the caps stay, V7) and `src/plugin/schema-apply.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V7 | — | nothing (results above) | — |
| 1. Template rules, `publishAt`, job options | — | `src/engine/{template,types,jobs,journal}.ts`, `src/emdash/schema.ts`, `src/plugin/routes.ts`, `tests/unit/rules-template.test.ts` | sonnet |
| 2. Fingerprints | — | `src/engine/{fingerprints,diff}.ts`, `tests/unit/fingerprints.test.ts` | opus |
| 3. Revisions, ports, adapter and fakes | — | `src/engine/{revs,ports,revert}.ts`, `src/emdash/content.ts`, `tests/unit/{fakes,fakes.test,content.test,batch.test,journal.test,rollback.test}.ts` | sonnet |
| 4. Early lookup, modes, `updateFields`, fingerprint recording | 1, 2, 3 (`ruled` inputs: `Template.rules`, `mappingNames`, `LinkRow.fields`; `fingerprintsOf`, `currentForms`, `sentForms`; `revOf` in the fakes) | `src/engine/{rules,batch}.ts`, `tests/unit/{record-rules,record-rules-translations,journal}.test.ts` | opus |
| 5. Protection | 4 (`rules.ts`, the early lookup, `ctx.fields`) | `src/engine/{rules,batch,resolve}.ts`, `tests/unit/protection.test.ts` | opus |
| 6. Publish, draft or schedule | 1, 3, 5 (`publishAt`, `Job.revisions`, `ContentPort.schedule`, `decodeRev`, the fakes' schedule hooks, the protected plan) | `src/engine/{rules,batch}.ts`, `tests/unit/{schedule.test,rollback-fixture}.ts` | opus |
| 7. Rollback step 7 and ownership after the scheduler | 3, 6 (`unschedule`, `decodeRev`, `runScheduled`, scheduling imports) | `src/engine/revert.ts`, `tests/unit/rollback-schedule.test.ts` | opus |
| 8. Node integration | 7 | `tests/integration/record-rules.test.ts`, `sites/dev/src/pages/test/run-scheduled.ts`, `sites/dev-cf/src/pages/test/run-scheduled.ts` | sonnet |
| 9. workerd parity | 7, and Task 8's `sites/dev-cf` route | `tests/integration-cf/parity.test.ts` | sonnet |
| 10. Review run and note | 0-9 | `docs/superpowers/notes/2026-11-04-m5b-review.md`, the roadmap; temporarily a D1 counter (reverted) | opus |

The waves:
1. **1 ∥ 2 ∥ 3.** No file is shared. Each was checked to build and pass alone on `79cd131`.
2. **4**
3. **5**
4. **6**
5. **7**
6. **8 ∥ 9.** Separate harnesses and files. Task 9 needs the `sites/dev-cf` route Task 8 creates, so whichever runs second merges after it, or Task 9 copies that file first.
7. **10**

Files touched by more than one task, merged in numeric order: `src/engine/batch.ts` and `src/engine/rules.ts` (Tasks 4, 5, 6), `src/engine/revert.ts` (Tasks 3, 7), and `tests/unit/journal.test.ts` (Tasks 3, 4).

Two notes on the counts in the tasks. Each task's "Run them to see them pass" step counts only the task's own unit test files. The full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the unconfirmed facts (V1-V7)

**Files:** none.

**Interfaces:**
- Consumes: the runtime handlers of spec F2-F5, F12 and F13, through a temporary probe route; the M5a D1 counter.
- Produces: Facts V1-V7 (above) and the spec amendments of Rulings 1-5 (`eaebca2`). The Task 10 note records the results from the Facts table.

- [x] **V1** (Node and workerd, with and without revisions): each value kind's fingerprint is the same sent and read back, live and in a draft, under Task 2's canonical forms. Passed.
- [x] **V2**: one REST edit, one terms-route change and one byline change each move only their own fingerprint, and a send-back moves none. Passed.
- [x] **V3**: the schedule states, `version` kept and `updatedAt` moved. Passed; F7's `version` step noted (Ruling 5).
- [x] **V4**: the sweep's publish is one `version`, published, no draft or schedule, `publishedAt` at the scheduled time; a trashed entry is skipped. Passed.
- [x] **V5**: unschedule as a revert step restores both pre-states. Passed.
- [x] **V6**: `getCollectionWithFields` returns `supports`. Passed.
- [x] **V7**: D1 queries per batch at each cap, at most 772. Passed; the caps stay.

### Task 1: Template rules, `publishAt` and job options

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/engine/journal.ts`, `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/rules-template.test.ts`

**Interfaces:**
- Consumes: the template schema and `applyTemplate`, `checkTemplate`, `templatePaths`, `usesSiteTimezone`, `dateConverter`; `createJob`, `CreateJobInput`; `linkBefore`; `SchemaRegistryLike`; the `jobs/create` route and `startImport`.
- Produces:
  - in `template.ts`:
    - `Template.publishAt?: { from?; expr?; format?; tz }`, with `tz` defaulting to `"UTC"`, `"site"` allowed and exactly one of `from`/`expr`;
    - `Template.rules?: { mode?; updateFields?; protectEdited? }`, with `MAX_UPDATE_FIELDS = 200`, and `TemplateRules`;
    - `MappedRecord.publishAt?: string | null`, the UTC ISO instant;
    - `CompiledTemplate.publishAt`;
    - `mappingNames(t)`, in field, slug, taxonomy, bylines order;
    - `rulesProblems(t)`, which `checkTemplate` reports as `invalid_template`;
  - `Job.revisions?: boolean`;
  - `LinkRow.fields?: Record<string, string>` and `LinkRow.scheduledAt?: string`, copied by `linkBefore` into `JournalBefore.link`;
  - `CreateJobInput.revisions?`, and `invalid_options` "publishAt needs publish: true";
  - `collectionRevisions(registry, collection)` and `publishAtCollection(template)` in `src/emdash/schema.ts`; `jobs/create` stores `revisions`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/rules-template.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { collectionRevisions, publishAtCollection } from "../../src/emdash/schema.js";
import { needsSiteTimezone } from "../../src/emdash/timezone.js";
import { createJob, JobError } from "../../src/engine/jobs.js";
import { preImage } from "../../src/engine/journal.js";
import type { EntrySnapshot } from "../../src/engine/ports.js";
import {
	applyTemplate,
	checkTemplate,
	compileTemplate,
	mappingNames,
	rulesProblems,
	type SchemaField,
	templatePaths,
	templateSchema,
} from "../../src/engine/template.js";
import { makeDeps } from "./fakes.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number" },
	},
	taxonomies: { category: { from: "Category" } },
	bylines: { from: "Authors" },
};
const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];
const parse = (extra: Record<string, unknown>) => templateSchema.parse({ ...base, ...extra });

describe("the rules and publishAt schemas (M5b)", () => {
	it("accepts every rule and a publishAt mapping, all optional", () => {
		const t = parse({
			publishAt: { from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" },
			rules: { mode: "update", updateFields: ["price"], protectEdited: true },
		});
		expect(t.rules).toEqual({ mode: "update", updateFields: ["price"], protectEdited: true });
		expect(t.publishAt).toEqual({ from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" });
		expect(parse({ publishAt: { expr: "'2026-12-01T09:00:00Z'" } }).publishAt?.tz).toBe("UTC");
		expect(parse({ rules: {} }).rules).toEqual({});
	});

	it("is strict and takes exactly one of from and expr", () => {
		const bad = [
			{ rules: { mode: "replace" } },
			{ rules: { extra: true } },
			{ rules: { updateFields: [] } },
			{ rules: { updateFields: Array.from({ length: 201 }, (_, i) => `f${i}`) } },
			{ rules: { protectEdited: "yes" } },
			{ publishAt: { from: "a", expr: "b" } },
			{ publishAt: {} },
			{ publishAt: { from: "a", output: "yyyy" } },
			{ publishAt: { from: "a", tz: "Mars/Olympus" } },
		];
		for (const extra of bad) {
			expect(templateSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
				false,
			);
		}
	});

	it("names each mapping as a record's changes do", () => {
		expect(mappingNames(parse({}))).toEqual([
			"title",
			"price",
			"slug",
			"taxonomies.category",
			"bylines",
		]);
	});

	it("refuses updateFields and protectEdited with mode create, unmapped names and repeats", () => {
		expect(rulesProblems(parse({ rules: { mode: "create", protectEdited: false } }))).toEqual([]);
		const createOnly =
			"rules.updateFields and rules.protectEdited apply to updates; mode create never updates";
		expect(rulesProblems(parse({ rules: { mode: "create", updateFields: ["price"] } }))).toEqual([
			createOnly,
		]);
		expect(rulesProblems(parse({ rules: { mode: "create", protectEdited: true } }))).toEqual([
			createOnly,
		]);
		expect(
			rulesProblems(
				parse({ rules: { updateFields: ["price", "stock", "price", "taxonomies.x"] } }),
			),
		).toEqual([
			'rules.updateFields lists "stock", which the template does not map',
			'rules.updateFields lists "price" more than once',
			'rules.updateFields lists "taxonomies.x", which the template does not map',
		]);
		const t = parse({ rules: { updateFields: ["slug", "bylines", "taxonomies.category"] } });
		expect(rulesProblems(t)).toEqual([]);
		expect(
			checkTemplate(parse({ rules: { updateFields: ["stock"] } }), schemaFields, null),
		).toEqual(['rules.updateFields lists "stock", which the template does not map']);
	});

	it("checks the publishAt column like the other paths", () => {
		const t = parse({ publishAt: { from: "go_live" } });
		expect(templatePaths(t)).toContain("go_live");
		expect(checkTemplate(t, schemaFields, ["sku", "handle", "Name", "Price"])).toContain(
			'Column "go_live" not found in the source',
		);
	});
});

describe("publishAt conversion (M5b)", () => {
	const convert = async (extra: Record<string, unknown>, value: unknown, siteTimezone?: string) => {
		const compiled = compileTemplate(parse(extra), siteTimezone ? { siteTimezone } : {});
		if (!compiled.ok) throw new Error(compiled.problems.join("; "));
		return applyTemplate(compiled.compiled, { sku: "A1", handle: "a1", Name: "Desk", go: value });
	};

	it("reads the time as a date into a datetime field: UTC ISO, or null when empty", async () => {
		const plain = await convert({ publishAt: { from: "go" } }, "2026-12-01T09:00:00+02:00");
		expect(plain).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T07:00:00.000Z" } });
		const site = await convert(
			{ publishAt: { from: "go", format: "dd/MM/yyyy HH:mm", tz: "site" } },
			"01/12/2026 09:00",
			"Europe/Chisinau",
		);
		expect(site).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T07:00:00.000Z" } });
		expect(await convert({ publishAt: { from: "go" } }, "")).toMatchObject({
			ok: true,
			value: { publishAt: null },
		});
		const constant = await convert({ publishAt: { expr: "'2026-12-01T09:00:00Z'" } }, null);
		expect(constant).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T09:00:00.000Z" } });
	});

	it("leaves publishAt out of a record whose template does not map it", async () => {
		const mapped = await convert({}, "2026-12-01");
		expect(mapped.ok && mapped.value).not.toHaveProperty("publishAt");
	});

	it("fails the record with invalid_date or not_scalar, field publishAt", async () => {
		expect(await convert({ publishAt: { from: "go" } }, "next tuesday")).toMatchObject({
			ok: false,
			errors: [{ field: "publishAt", code: "invalid_date" }],
		});
		expect(await convert({ publishAt: { from: "go" } }, { at: 1 })).toMatchObject({
			ok: false,
			errors: [{ field: "publishAt", code: "not_scalar" }],
		});
	});
});

describe("jobs with rules and publishAt (M5b)", () => {
	async function create(extra: Record<string, unknown>, opts: Record<string, unknown> = {}) {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,handle,Name,Price,Category,Authors,go\nS1,s1,Desk,10,,,\n");
		return createJob(deps, {
			uploadId: "u1",
			template: { ...base, ...extra },
			schemaFields,
			...opts,
		});
	}

	it("refuses publishAt with publish: false", async () => {
		const job = create({ publishAt: { from: "go" } }, { publish: false });
		await expect(job).rejects.toBeInstanceOf(JobError);
		await expect(job).rejects.toMatchObject({
			code: "invalid_options",
			message: "publishAt needs publish: true",
		});
	});

	it("refuses rules that cannot apply, as an invalid template", async () => {
		await expect(
			create({ rules: { mode: "create", updateFields: ["price"] } }),
		).rejects.toMatchObject({ code: "invalid_template" });
	});

	it("stores whether the collection keeps revisions when the template maps publishAt", async () => {
		expect((await create({ publishAt: { from: "go" } }, { revisions: false })).revisions).toBe(
			false,
		);
		expect((await create({ publishAt: { from: "go" } })).revisions).toBe(true);
		expect(await create({}, { revisions: false })).not.toHaveProperty("revisions");
	});

	it("stores the site time zone for publishAt with tz site", async () => {
		const job = await create(
			{ publishAt: { from: "go", tz: "site" } },
			{ siteTimezone: "Europe/Chisinau" },
		);
		expect(job.siteTimezone).toBe("Europe/Chisinau");
		expect(needsSiteTimezone({ ...base, publishAt: { from: "go", tz: "site" } })).toBe(true);
		expect(needsSiteTimezone({ ...base, publishAt: { from: "go" } })).toBe(false);
	});
});

describe("collectionRevisions and publishAtCollection (M5b)", () => {
	const registry = (supports?: string[]) => ({
		getField: async () => null,
		createField: async () => null,
		updateField: async () => null,
		getCollectionWithFields: async (slug: string) =>
			slug === "missing" ? null : { fields: [], ...(supports ? { supports } : {}) },
	});

	it("reads revisions from the collection's supports", async () => {
		expect(await collectionRevisions(registry(["drafts", "revisions"]), "products")).toBe(true);
		expect(await collectionRevisions(registry(["drafts"]), "products")).toBe(false);
		expect(await collectionRevisions(registry(), "products")).toBe(false);
		expect(await collectionRevisions(registry(["revisions"]), "missing")).toBe(false);
	});

	it("names the collection only for a valid template that maps publishAt", () => {
		expect(publishAtCollection({ ...base, publishAt: { from: "go" } })).toBe("products");
		expect(publishAtCollection(base)).toBeNull();
		expect(publishAtCollection({ ...base, publishAt: { from: "go" }, version: 2 })).toBeNull();
	});
});

describe("the journal's link snapshot (M5b)", () => {
	it("keeps the link row's fingerprints and schedule", () => {
		const entry: EntrySnapshot = {
			id: "e1",
			rev: "r1",
			slug: "desk",
			data: { title: "Desk" },
			pendingPublish: false,
			status: "published",
			scheduledAt: null,
			hasDraft: false,
		};
		const link = {
			collection: "products",
			locale: "en",
			sourceKey: "S1",
			entryId: "e1",
			writtenRev: "r1",
			jobId: "j0",
			fields: { title: "AAAAAAAAAAAAAAAA" },
			scheduledAt: "2026-12-01T07:00:00.000Z",
		};
		const touched = {
			fields: ["title"],
			slug: false,
			taxonomies: [],
			references: [],
			bylines: false,
			referencesUnknown: false,
		};
		expect(preImage(entry, link, touched, undefined)).toMatchObject({
			link: {
				jobId: "j0",
				writtenRev: "r1",
				fields: { title: "AAAAAAAAAAAAAAAA" },
				scheduledAt: "2026-12-01T07:00:00.000Z",
			},
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rules-template.test.ts`
Expected: FAIL (1 file; 12 tests failed, 3 passed: the schemas know no `rules` or `publishAt`, and `mappingNames`, `rulesProblems`, `collectionRevisions`, `publishAtCollection`, `Job.revisions` and the link snapshot's new fields do not exist yet).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/schema.ts`, replace
````ts
import { ContentWriteError } from "../engine/ports.js";
import { type FieldRules, type SchemaField, SOURCE_ID_FIELD } from "../engine/template.js";
import { emdashErrorCode } from "./errors.js";

/**
````
with:
````ts
import { ContentWriteError } from "../engine/ports.js";
import {
	type FieldRules,
	type SchemaField,
	SOURCE_ID_FIELD,
	templateSchema,
} from "../engine/template.js";
import { emdashErrorCode } from "./errors.js";

/**
````

In `packages/flux-import/src/emdash/schema.ts`, replace
````ts
		fieldSlug: string,
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(slug: string): Promise<{ fields: RegistryField[] } | null>;
}

/** The parts of EmDash's `Field` (src/schema/types.ts:320-344) the importer reads. */
````
with:
````ts
		fieldSlug: string,
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(
		slug: string,
	): Promise<{ fields: RegistryField[]; supports?: readonly string[] } | null>;
}

/** The parts of EmDash's `Field` (src/schema/types.ts:320-344) the importer reads. */
````

In `packages/flux-import/src/emdash/schema.ts`, replace
````ts
	};
}

/**
 * The collection's fields for `checkTemplate` and the job's target snapshot, or `null` when the
 * collection does not exist: type, `required`, whether it has a default, the validation keys
````
with:
````ts
	};
}

/**
 * Whether the collection keeps revisions (M5b): its `supports` lists `"revisions"`
 * (`emdash` src/schema/types.ts:264-272, spec M5b F12, V6). False for a collection that does not
 * exist, which job creation then refuses.
 */
export async function collectionRevisions(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<boolean> {
	const found = await registry.getCollectionWithFields(collection);
	return found?.supports?.includes("revisions") ?? false;
}

/**
 * The collection of a template from a request that maps `publishAt` (M5b), whose revisions job
 * creation reads; null otherwise. An invalid template has none: job creation reports it.
 */
export function publishAtCollection(template: unknown): string | null {
	const parsed = templateSchema.safeParse(template);
	return parsed.success && parsed.data.publishAt !== undefined ? parsed.data.collection : null;
}

/**
 * The collection's fields for `checkTemplate` and the job's target snapshot, or `null` when the
 * collection does not exist: type, `required`, whether it has a default, the validation keys
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	journal?: boolean;
	/** The URL source the job's file was fetched from (M5a). */
	sourceId?: string;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
````
with:
````ts
	journal?: boolean;
	/** The URL source the job's file was fetched from (M5a). */
	sourceId?: string;
	/** Whether the collection keeps revisions (M5b), for templates that map `publishAt`; default true. */
	revisions?: boolean;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
		);
	}
	const template = parsed.data;
	const compiled = compileTemplate(template);
	if (!compiled.ok) {
		throw new JobError(
````
with:
````ts
		);
	}
	const template = parsed.data;
	if (template.publishAt !== undefined && input.publish === false) {
		throw new JobError("invalid_options", "publishAt needs publish: true");
	}
	const compiled = compileTemplate(template);
	if (!compiled.ok) {
		throw new JobError(
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
		// A dry run writes nothing, so it keeps no journal.
		...(dryRun ? {} : { journal: input.journal ?? true }),
		...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
````
with:
````ts
		// A dry run writes nothing, so it keeps no journal.
		...(dryRun ? {} : { journal: input.journal ?? true }),
		...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
		...(template.publishAt === undefined ? {} : { revisions: input.revisions ?? true }),
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
````

In `packages/flux-import/src/engine/journal.ts`, replace
````ts
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
	};
}
````
with:
````ts
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
		...(link.fields === undefined ? {} : { fields: link.fields }),
		...(link.scheduledAt === undefined ? {} : { scheduledAt: link.scheduledAt }),
	};
}
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
 * by `checkSource` (sources/readers.ts), so a misplaced one is reported as `invalid_source`.
````
with:
````ts
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/**
 * When the record's content goes live (M5b): a time read like a `date` mapping into a `datetime`
 * field. A future time schedules the written content; a past or empty one publishes it now.
 */
const publishAtMapping = z
	.object({ ...valueSource, format: z.string().min(1).optional(), tz: timezone.default("UTC") })
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/** The most names `rules.updateFields` lists (M5b). */
export const MAX_UPDATE_FIELDS = 200;

/** How each record treats the entry it matches (M5b); every rule is optional. */
const rulesSchema = z
	.object({
		mode: z.enum(["upsert", "create", "update"]).optional(),
		updateFields: z.array(z.string().min(1).max(200)).min(1).max(MAX_UPDATE_FIELDS).optional(),
		protectEdited: z.boolean().optional(),
	})
	.strict();

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
 * by `checkSource` (sources/readers.ts), so a misplaced one is reported as `invalid_source`.
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
			.optional(),
		/** Existing bylines to credit, in order; replaces the entry's bylines. */
		bylines: bylinesMapping.optional(),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
````
with:
````ts
			.optional(),
		/** Existing bylines to credit, in order; replaces the entry's bylines. */
		bylines: bylinesMapping.optional(),
		/** The record's publication time (M5b); only with the job option `publish: true`. */
		publishAt: publishAtMapping.optional(),
		/** Write mode, update scope and edit protection (M5b). */
		rules: rulesSchema.optional(),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
export type TemplateRules = NonNullable<Template["rules"]>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	key: string;
	translationOf?: string;
	slug?: string;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
````
with:
````ts
	key: string;
	translationOf?: string;
	slug?: string;
	/** The publication time as UTC ISO (M5b); null when empty, absent when not mapped. */
	publishAt?: string | null;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	readonly slug: CompiledExpression | null;
	/** The `translationOf` `expr`, or null when there is none or it reads `from`. */
	readonly translationOf: CompiledExpression | null;
	/**
	 * The fields a record with a `translationOf` value does not read (`isSharedMapping`): EmDash
	 * shares their values across the translation group. Empty without `translationOf`.
````
with:
````ts
	readonly slug: CompiledExpression | null;
	/** The `translationOf` `expr`, or null when there is none or it reads `from`. */
	readonly translationOf: CompiledExpression | null;
	/** The `publishAt` `expr` and conversion (M5b), or null when the template maps none. */
	readonly publishAt: { expr: CompiledExpression | null; convert: FieldConverter } | null;
	/**
	 * The fields a record with a `translationOf` value does not read (`isSharedMapping`): EmDash
	 * shares their values across the translation group. Empty without `translationOf`.
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const translationOf = compile("translationOf.expr", t.translationOf?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
````
with:
````ts
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const translationOf = compile("translationOf.expr", t.translationOf?.expr);
	const publishAtExpr = compile("publishAt.expr", t.publishAt?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
			key,
			slug,
			translationOf,
			shared,
			sharedRequired: context.sharedRequired ?? [],
			fields,
````
with:
````ts
			key,
			slug,
			translationOf,
			publishAt:
				t.publishAt === undefined
					? null
					: {
							expr: publishAtExpr,
							convert: publishAtConverter(t.publishAt, context.siteTimezone ?? "UTC"),
						},
			shared,
			sharedRequired: context.sharedRequired ?? [],
			fields,
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	};
}

/** A `portableText` mapping's options with their defaults filled in. */
export function portableTextOptions(
	mapping: Extract<FieldMapping, { type: "portableText" }>,
````
with:
````ts
	};
}

/**
 * The `publishAt` conversion (M5b): a `date` mapping into a `datetime` field, so the value is UTC
 * ISO; `tz: "site"` reads `siteTimezone`.
 */
function publishAtConverter(
	mapping: NonNullable<Template["publishAt"]>,
	siteTimezone: string,
): FieldConverter {
	const tz = mapping.tz === SITE_TIMEZONE ? siteTimezone : mapping.tz;
	return dateConverter({ format: mapping.format, tz }, "datetime");
}

/** A `portableText` mapping's options with their defaults filled in. */
export function portableTextOptions(
	mapping: Extract<FieldMapping, { type: "portableText" }>,
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
		}
	}

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
````
with:
````ts
		}
	}

	let publishAt: string | null | undefined;
	if (c.publishAt !== null && t.publishAt !== undefined) {
		const raw = await read("publishAt", t.publishAt.from, c.publishAt.expr);
		if (raw !== FAILED) {
			const result = c.publishAt.convert(raw);
			if (result.ok) publishAt = result.value as string | null;
			else errors.push({ field: "publishAt", code: result.code, message: result.message });
		}
	}

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	if (errors.length > 0) return { ok: false, errors, ...reported };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (translationOf !== undefined) mapped.translationOf = translationOf;
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	if (c.portableText.size > 0) mapped.portableText = portableText;
````
with:
````ts
	if (errors.length > 0) return { ok: false, errors, ...reported };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (translationOf !== undefined) mapped.translationOf = translationOf;
	if (publishAt !== undefined) mapped.publishAt = publishAt;
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	if (c.portableText.size > 0) mapped.portableText = portableText;
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
		t.key.from,
		t.translationOf?.from,
		t.slug?.from,
		...Object.values(t.fields).flatMap((m) =>
			m.type === "image" ? [m.from, m.alt?.from] : [m.from],
		),
````
with:
````ts
		t.key.from,
		t.translationOf?.from,
		t.slug?.from,
		t.publishAt?.from,
		...Object.values(t.fields).flatMap((m) =>
			m.type === "image" ? [m.from, m.alt?.from] : [m.from],
		),
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
			errors.push(`translationOf.locale must differ from locale ("${t.locale}")`);
		}
	}
	return errors;
}
````
with:
````ts
			errors.push(`translationOf.locale must differ from locale ("${t.locale}")`);
		}
	}
	errors.push(...rulesProblems(t));
	return errors;
}

/**
 * The template's mapping names (M5b), as a record's `changes` name them: each field, `slug`,
 * `taxonomies.<name>` for each taxonomy and `bylines`. `rules.updateFields` lists these, and the
 * link row keeps one fingerprint per name.
 */
export function mappingNames(t: Template): string[] {
	return [
		...Object.keys(t.fields),
		...(t.slug === undefined ? [] : ["slug"]),
		...Object.keys(t.taxonomies ?? {}).map((name) => `taxonomies.${name}`),
		...(t.bylines === undefined ? [] : ["bylines"]),
	];
}

/**
 * What `rules` cannot ask (M5b): `updateFields` or `protectEdited` with `mode: "create"`, which
 * never updates, and an `updateFields` name the template does not map or lists twice.
 */
export function rulesProblems(t: Template): string[] {
	const rules = t.rules;
	if (rules === undefined) return [];
	const errors: string[] = [];
	if (
		rules.mode === "create" &&
		(rules.updateFields !== undefined || rules.protectEdited === true)
	) {
		errors.push(
			"rules.updateFields and rules.protectEdited apply to updates; mode create never updates",
		);
	}
	const mapped = new Set(mappingNames(t));
	const seen = new Set<string>();
	for (const name of rules.updateFields ?? []) {
		if (seen.has(name)) errors.push(`rules.updateFields lists "${name}" more than once`);
		else if (!mapped.has(name)) {
			errors.push(`rules.updateFields lists "${name}", which the template does not map`);
		}
		seen.add(name);
	}
	return errors;
}
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
}
````
with:
````ts

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return (
		t.publishAt?.tz === SITE_TIMEZONE ||
		Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE)
	);
}
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	purging?: boolean;
	/** An import job created from a URL source: the source's ID (M5a). */
	sourceId?: string;
	uploadId: string;
	template: Template;
	dryRun: boolean;
````
with:
````ts
	purging?: boolean;
	/** An import job created from a URL source: the source's ID (M5a). */
	sourceId?: string;
	/**
	 * Whether the collection keeps revisions (M5b, read at job creation when the template maps
	 * `publishAt`): without them an update of a published entry is live at once and cannot be
	 * scheduled. Absent when the template maps no `publishAt`.
	 */
	revisions?: boolean;
	uploadId: string;
	template: Template;
	dryRun: boolean;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	writtenRev?: string;
	/** The job that produced `writtenRev` (M5a); absent on links saved before M5a. */
	jobId?: string;
}

/** The pre-image of an entry a job updated (M5a): what the entry held before its first write. */
export interface JournalBefore {
	/** The link row before the job; null when there was none. */
	link: { jobId?: string; writtenRev?: string } | null;
	/**
	 * The entry's `_rev` when the pre-image was read. When it is not `link.writtenRev`, someone
	 * changed the entry after the earlier job, and a rollback hands the link back unchanged.
````
with:
````ts
	writtenRev?: string;
	/** The job that produced `writtenRev` (M5a); absent on links saved before M5a. */
	jobId?: string;
	/**
	 * One fingerprint per mapping name, of the value the importer last wrote or found equal to its
	 * feed (M5b); absent on links saved before M5b.
	 */
	fields?: Record<string, string>;
	/**
	 * The time the entry was scheduled for at `writtenRev`, as far as the importer knows (M5b):
	 * the schedule it set, or one an update kept. Absent when none.
	 */
	scheduledAt?: string;
}

/** The pre-image of an entry a job updated (M5a): what the entry held before its first write. */
export interface JournalBefore {
	/** The link row before the job, its fingerprints and schedule included (M5b); null when none. */
	link: {
		jobId?: string;
		writtenRev?: string;
		fields?: Record<string, string>;
		scheduledAt?: string;
	} | null;
	/**
	 * The entry's `_rev` when the pre-image was read. When it is not `link.writtenRev`, someone
	 * changed the entry after the earlier job, and a rollback hands the link back unchanged.
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
````
with:
````ts
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { collectionRevisions, listSchemaFields, publishAtCollection } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
			const { input } = ctx;
			// Read once here and stored on the job, so a resumed or retried job converts the same way.
			const siteTimezone = needsSiteTimezone(input.template) ? await readSiteTimezone() : undefined;
			const start = (upload: string, fromSource?: string) => {
				const options: StartJobInput = {
					uploadId: upload,
````
with:
````ts
			const { input } = ctx;
			// Read once here and stored on the job, so a resumed or retried job converts the same way.
			const siteTimezone = needsSiteTimezone(input.template) ? await readSiteTimezone() : undefined;
			// Read once here: whether a published entry's update can be scheduled (M5b).
			const scheduled = publishAtCollection(input.template);
			const revisions =
				scheduled === null
					? undefined
					: await collectionRevisions(runtime.schemaRegistry, scheduled);
			const start = (upload: string, fromSource?: string) => {
				const options: StartJobInput = {
					uploadId: upload,
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
					...(input.journal === undefined ? {} : { journal: input.journal }),
					mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
````
with:
````ts
					...(input.journal === undefined ? {} : { journal: input.journal }),
					mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(revisions === undefined ? {} : { revisions }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/rules-template.test.ts`
Expected: PASS (1 file, 15 tests). Full suite after this task: 63 files / 1,552 tests (62 / 1,537 at `79cd131`).

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src packages/flux-import/tests/unit/rules-template.test.ts
git commit -m "Add record rules and publishAt to the template, the revisions job option and the link fields of M5b"
```

### Task 2: Fingerprints

**Files:**
- Create: `packages/flux-import/src/engine/fingerprints.ts`
- Modify: `packages/flux-import/src/engine/diff.ts`
- Test: `packages/flux-import/tests/unit/fingerprints.test.ts`

**Interfaces:**
- Consumes: `same`, `Comparison`, `canonicalPortableText`; `MappedRecord`; `ResolvedLinks`, `ResolvedItem`; `MediaPlanItem`, `PortableTextPlanItem`.
- Produces:
  - `same(before, after, how)`, exported from `diff.ts`;
  - `FINGERPRINT_LENGTH = 16` and `stableJson(value)`, which sorts keys;
  - `fingerprint(canonical)`: SHA-256, the first 12 bytes in base64url;
  - the canonical forms:
    - `canonicalData(value, how)`: booleans by truth value, `-0` as `0`, instants as epoch ms, a plain object as `JSON.stringify`, `null` when empty;
    - `canonicalMedia(value)`: `{ id, alt }`;
    - `canonicalRichText(value)`;
    - `canonicalGroups(groups, ordered)`;
  - `recordMappings(record)`;
  - `currentForms(entry, record, comparisons, current, childSide)` and `sentForms(record, comparisons, links, media, portableText, childSide)`;
  - `fingerprintsOf(forms)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/fingerprints.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import {
	type Comparison,
	canonicalPortableText,
	deepEqual,
	type LinkPlan,
	planRecord,
	same,
} from "../../src/engine/diff.js";
import {
	canonicalData,
	canonicalGroups,
	canonicalMedia,
	canonicalRichText,
	currentForms,
	FINGERPRINT_LENGTH,
	fingerprint,
	fingerprintsOf,
	recordMappings,
	sentForms,
	stableJson,
} from "../../src/engine/fingerprints.js";
import type { FieldValue, MappedRecord } from "../../src/engine/template.js";

/** Stored values as EmDash reads them back, and mapped values as the importer sends them. */
const VALUES: unknown[] = [
	null,
	undefined,
	0,
	-0,
	1,
	2.5,
	-3,
	true,
	false,
	"",
	"text",
	"1",
	"true",
	"2026-12-01T07:00:00.000Z",
	"2026-12-01T07:00:00Z",
	"2026-12-01T09:00:00+02:00",
	"2026-12-01",
	"not a date",
	'{"a":1}',
	'{"b":2,"a":1}',
	"[1,2]",
	{ a: 1 },
	{ b: 2, a: 1 },
	{ a: { y: 2, b: [3, 1] }, z: 1 },
	{ z: 1, a: { b: [3, 1], y: 2 } },
	[1, 2],
	[2, 1],
	["red", "blue"],
	["blue", "red"],
	[],
	{},
	[true, 1],
	[1, 1],
];
const MAPPED = VALUES.filter((v) => v !== undefined) as FieldValue[];
const KINDS: Comparison[] = ["plain", "boolean", "instant", "deep"];

describe("canonical forms agree with the plan's comparison (M5b)", () => {
	it("gives equal fingerprints to every pair the plan calls the same", async () => {
		let pairs = 0;
		for (const how of KINDS) {
			for (const stored of VALUES) {
				for (const mapped of MAPPED) {
					if (!same(stored, mapped, how)) continue;
					pairs++;
					const a = await fingerprint(canonicalData(stored, how));
					const b = await fingerprint(canonicalData(mapped, how));
					expect(a, `${how}: ${stableJson(stored)} vs ${stableJson(mapped)}`).toBe(b);
				}
			}
		}
		expect(pairs).toBeGreaterThan(100);
	});

	it("reads back what EmDash stores as the value sent (spec V1)", () => {
		expect(canonicalData(1, "boolean")).toBe(canonicalData(true, "boolean"));
		expect(canonicalData(0, "deep")).toBe(canonicalData(false, "deep"));
		expect(canonicalData("2026-12-01T07:00:00.000Z", "instant")).toBe(
			canonicalData("2026-12-01T09:00:00+02:00", "instant"),
		);
		expect(canonicalData({ b: 2, a: 1 }, "plain")).toBe('{"b":2,"a":1}');
		expect(canonicalData(undefined, "plain")).toBeNull();
		expect(stableJson(canonicalData({ z: 1, a: [2, 1] }, "deep"))).toBe(
			stableJson({ a: [2, 1], z: 1 }),
		);
	});

	it("tells different values apart", async () => {
		expect(await fingerprint(canonicalData(1, "plain"))).not.toBe(
			await fingerprint(canonicalData(2, "plain")),
		);
		expect(await fingerprint(canonicalData(["a", "b"], "deep"))).not.toBe(
			await fingerprint(canonicalData(["b", "a"], "deep")),
		);
		expect(await fingerprint(null)).not.toBe(await fingerprint(""));
	});

	it("keeps the media ID and the stored alt, and nothing else", () => {
		const sent = { id: "m1", provider: "local", filename: "a.png", alt: "A desk", meta: {} };
		const read = {
			id: "m1",
			alt: "A desk",
			blurhash: "x",
			meta: { storageKey: "k", caption: null },
		};
		expect(canonicalMedia(sent)).toEqual(canonicalMedia(read));
		expect(canonicalMedia({ id: "m1" })).toEqual({ id: "m1", alt: null });
		expect(canonicalMedia({ id: "m1", alt: "Editor's alt" })).not.toEqual(
			canonicalMedia({ id: "m1" }),
		);
		expect(canonicalMedia("m2")).toEqual({ id: "m2", alt: null });
		expect(canonicalMedia(null)).toBeNull();
	});

	it("compares Portable Text as the plan does, and a value that is not Portable Text never", () => {
		const sent = [
			{
				_type: "block",
				style: "normal",
				markDefs: [{ _type: "link", _key: "l1", href: "https://x.test" }],
				children: [{ _type: "span", text: "Hi", marks: ["l1", "strong"] }],
			},
		];
		const read = [
			{
				_type: "block",
				_key: "k9",
				markDefs: [{ _key: "q", _type: "link", href: "https://x.test" }],
				children: [{ _key: "s", _type: "span", text: "Hi", marks: ["strong", "q"] }],
			},
		];
		expect(deepEqual(canonicalPortableText(sent), canonicalPortableText(read))).toBe(true);
		expect(stableJson(canonicalRichText(sent))).toBe(stableJson(canonicalRichText(read)));
		expect(canonicalRichText([])).toBeNull();
		expect(canonicalRichText("<p>Hi</p>")).toEqual({ notPortableText: '"<p>Hi</p>"' });
	});

	it("orders links unless they are a set, and treats an empty list as null", () => {
		expect(canonicalGroups(["b", "a"], true)).toEqual(["b", "a"]);
		expect(canonicalGroups(["b", "a"], false)).toEqual(["a", "b"]);
		expect(canonicalGroups([], true)).toBeNull();
	});

	it("is 16 base64url characters, stable across key order", async () => {
		const a = await fingerprint({ b: 1, a: [1, { d: 2, c: 3 }] });
		const b = await fingerprint({ a: [1, { c: 3, d: 2 }], b: 1 });
		expect(a).toBe(b);
		expect(a).toHaveLength(FINGERPRINT_LENGTH);
		expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});
});

describe("a record's forms (M5b)", () => {
	const record: MappedRecord = {
		key: "S1",
		slug: "desk",
		data: { title: "Desk", featured: true, released: "2026-12-01T07:00:00.000Z" },
		media: { photo: { kind: "image", url: "https://cdn.test/a.png", alt: null, refresh: false } },
		portableText: { body: null },
		links: {
			references: { related: ["S2"], held_by: ["S3", "S4"] },
			taxonomies: { tag: [] },
			bylines: null,
		},
	};
	const comparisons = new Map<string, Comparison>([
		["title", "plain"],
		["featured", "boolean"],
		["released", "instant"],
	]);
	const childSide = new Set(["held_by"]);

	it("names every mapping the record carries", () => {
		expect(recordMappings(record)).toEqual([
			"title",
			"featured",
			"released",
			"photo",
			"body",
			"slug",
			"related",
			"held_by",
			"taxonomies.tag",
			"bylines",
		]);
		expect(recordMappings({ key: "S1", data: { title: "A" } })).toEqual(["title"]);
	});

	it("gives what the record sends and what the entry then holds the same fingerprints", async () => {
		const links = {
			references: {
				related: [{ group: "g2", value: "e2", text: "e2" }],
				held_by: [
					{ group: "g4", value: "e4", text: "e4" },
					{ group: "g3", value: "e3", text: "e3" },
				],
			},
			taxonomies: { tag: [] },
			bylines: [],
		};
		const media = {
			photo: { mediaId: "m1", value: { id: "m1", provider: "local" }, text: "m1", alt: null },
		};
		const sent = sentForms(record, comparisons, links, media, { body: null }, childSide);
		const entry = {
			slug: "desk",
			data: {
				title: "Desk",
				featured: 1,
				released: "2026-12-01T07:00:00.000Z",
				photo: { id: "m1", blurhash: "x", meta: { caption: null } },
			},
		};
		const current = {
			references: {
				related: [{ group: "g2", text: "e2" }],
				held_by: [
					{ group: "g3", text: "e3" },
					{ group: "g4", text: "e4" },
				],
			},
			taxonomies: { tag: [] },
			bylines: [],
		};
		const read = currentForms(entry, record, comparisons, current, childSide);
		expect(await fingerprintsOf(read)).toEqual(await fingerprintsOf(sent));
		// A plan of the same values is unchanged.
		const plain: MappedRecord = { key: "S1", slug: "desk", data: record.data };
		const plan: LinkPlan = { resolved: links, current, childSide };
		expect(planRecord(entry, plain, comparisons, plan).action).toBe("unchanged");
	});

	it("never matches a truncated selection", async () => {
		const read = currentForms(
			{ slug: null, data: {} },
			{ key: "S1", data: {}, links: { references: { related: [] } } },
			comparisons,
			{ references: { related: [] }, referencesTruncated: ["related"] },
			new Set(),
		);
		expect(read.related).toEqual({ truncated: [] });
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/fingerprints.test.ts`
Expected: FAIL (1 file: `src/engine/fingerprints.ts` does not exist yet, so no test runs).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/diff.ts`, replace
````ts
	return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

function same(before: unknown, after: FieldValue, how: Comparison): boolean {
	const b = before ?? null;
	if (b === null || after === null) return b === after;
	// EmDash stores a boolean as 0 or 1 and reads it back as that number, in boolean fields and
````
with:
````ts
	return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/** Whether a stored value equals a mapped one under the field's comparison. */
export function same(before: unknown, after: FieldValue, how: Comparison): boolean {
	const b = before ?? null;
	if (b === null || after === null) return b === after;
	// EmDash stores a boolean as 0 or 1 and reads it back as that number, in boolean fields and
````

Create `packages/flux-import/src/engine/fingerprints.ts`:
````ts
/**
 * Fingerprints of mapping values (spec M5b "Fingerprints"): one per mapping name, the SHA-256 of
 * the value's canonical form serialized as JSON with sorted object keys, cut to 12 bytes and
 * written as base64url (16 characters). Two values `planRecord` calls the same have the same
 * canonical form, so the fingerprint of what the importer wrote equals the fingerprint of what
 * the entry holds until someone changes it.
 */
import {
	type Comparison,
	type CurrentEntry,
	type CurrentItem,
	type CurrentLinks,
	canonicalPortableText,
	type MediaPlanItem,
	type PortableTextPlanItem,
} from "./diff.js";
import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { MappedRecord } from "./template.js";

/** The characters a stored fingerprint has. */
export const FINGERPRINT_LENGTH = 16;

/** JSON with object keys sorted at every level; `-0` is `0`, as JSON writes it. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function base64url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The fingerprint of a canonical form (Web Crypto, on Node 22 and workerd). */
export async function fingerprint(canonical: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableJson(canonical));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return base64url(digest.slice(0, 12));
}

/** EmDash stores booleans as 1 and 0 and reads them back as those numbers. */
const asBoolean = (value: unknown): unknown => (value === 1 ? true : value === 0 ? false : value);

/**
 * A data field's canonical form under its comparison (`diff.ts` `same`): booleans by truth value
 * (`boolean` and `deep`), instants as epoch milliseconds, and otherwise (`plain`, and `boolean`
 * for a value that is not one) a stored object as its JSON text, since EmDash reads text that
 * parses as JSON back parsed; `-0` is `0`, and an empty value null.
 */
export function canonicalData(value: unknown, how: Comparison): unknown {
	const v = value ?? null;
	if (v === null) return null;
	switch (how) {
		case "deep":
			return asBoolean(v);
		case "instant": {
			if (typeof v !== "string") return v;
			const t = Date.parse(v);
			return Number.isNaN(t) ? v : t;
		}
		default: {
			const x = how === "boolean" ? asBoolean(v) : v;
			if (typeof x === "object" && x !== null) return JSON.stringify(x);
			return Object.is(x, -0) ? 0 : x;
		}
	}
}

/** A stored image or file value's media ID: its `id`, or the value itself when it is a string. */
function mediaIdOf(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && "id" in value) {
		return typeof value.id === "string" ? value.id : null;
	}
	return null;
}

/**
 * An image or file value's canonical form: the media ID and the stored alt, whether or not the
 * template maps alt (an editor's alt change is an edit); null when empty.
 */
export function canonicalMedia(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	const alt =
		typeof value === "object" && "alt" in value && typeof value.alt === "string" ? value.alt : null;
	return { id: mediaIdOf(value), alt };
}

/**
 * A Portable Text value's canonical form: `canonicalPortableText`, null when empty, and a form of
 * its own for a value that is not Portable Text, which therefore always differs.
 */
export function canonicalRichText(value: unknown): unknown {
	if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
		return null;
	}
	return canonicalPortableText(value) ?? { notPortableText: stableJson(value) };
}

/** Linked items' translation groups, in order or sorted (a set); null when there are none. */
export function canonicalGroups(groups: readonly string[], ordered: boolean): unknown {
	if (groups.length === 0) return null;
	return ordered ? [...groups] : [...groups].sort();
}

/** The mapping names a mapped record carries, as `rules.updateFields` and the link row name them. */
export function recordMappings(record: MappedRecord): string[] {
	const links = record.links;
	return [
		...Object.keys(record.data),
		...Object.keys(record.media ?? {}),
		...Object.keys(record.portableText ?? {}),
		...(record.slug === undefined ? [] : ["slug"]),
		...Object.keys(links?.references ?? {}),
		...Object.keys(links?.taxonomies ?? {}).map((name) => `taxonomies.${name}`),
		...(links?.bylines === undefined ? [] : ["bylines"]),
	];
}

const groupsOf = (items: readonly CurrentItem[]) => items.map((i) => i.group);

/**
 * The canonical form of each mapping the record carries, as the entry holds it now: data, media
 * and Portable Text from the read (a pending draft's values first), the live slug, and the links
 * the plan compared. A truncated reference selection has a form that matches no written value.
 */
export function currentForms(
	entry: CurrentEntry,
	record: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	current: CurrentLinks,
	childSide: ReadonlySet<string>,
): Record<string, unknown> {
	const forms: Record<string, unknown> = {};
	const stored = (field: string) => (Object.hasOwn(entry.data, field) ? entry.data[field] : null);
	for (const field of Object.keys(record.data)) {
		forms[field] = canonicalData(stored(field), comparisons.get(field) ?? "plain");
	}
	for (const field of Object.keys(record.media ?? {})) forms[field] = canonicalMedia(stored(field));
	for (const field of Object.keys(record.portableText ?? {})) {
		forms[field] = canonicalRichText(stored(field));
	}
	if (record.slug !== undefined) forms.slug = entry.slug;
	for (const field of Object.keys(record.links?.references ?? {})) {
		const groups = groupsOf(current.references?.[field] ?? []);
		forms[field] = current.referencesTruncated?.includes(field)
			? { truncated: groups }
			: canonicalGroups(groups, !childSide.has(field));
	}
	for (const taxonomy of Object.keys(record.links?.taxonomies ?? {})) {
		forms[`taxonomies.${taxonomy}`] = canonicalGroups(
			groupsOf(current.taxonomies?.[taxonomy] ?? []),
			false,
		);
	}
	if (record.links?.bylines !== undefined) {
		forms.bylines = canonicalGroups(groupsOf(current.bylines ?? []), true);
	}
	return forms;
}

const resolvedGroups = (items: readonly ResolvedItem[]) =>
	items.flatMap((i) => (i.group === null ? [] : [i.group]));

/**
 * The canonical form of each mapping as the record writes it: the mapped data and slug, the
 * media and Portable Text values sent, and the resolved links' groups.
 */
export function sentForms(
	record: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links: ResolvedLinks | undefined,
	media: Readonly<Record<string, MediaPlanItem | null>> | undefined,
	portableText: Readonly<Record<string, PortableTextPlanItem | null>> | undefined,
	childSide: ReadonlySet<string>,
): Record<string, unknown> {
	const forms: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(record.data)) {
		forms[field] = canonicalData(value, comparisons.get(field) ?? "plain");
	}
	for (const [field, item] of Object.entries(media ?? {})) {
		forms[field] = canonicalMedia(item?.value ?? null);
	}
	for (const [field, item] of Object.entries(portableText ?? {})) {
		forms[field] = canonicalRichText(item?.blocks ?? null);
	}
	if (record.slug !== undefined) forms.slug = record.slug;
	for (const [field, items] of Object.entries(links?.references ?? {})) {
		forms[field] = canonicalGroups(resolvedGroups(items), !childSide.has(field));
	}
	for (const [taxonomy, items] of Object.entries(links?.taxonomies ?? {})) {
		forms[`taxonomies.${taxonomy}`] = canonicalGroups(resolvedGroups(items), false);
	}
	if (links?.bylines !== undefined) {
		forms.bylines = canonicalGroups(resolvedGroups(links.bylines), true);
	}
	return forms;
}

/** The fingerprint of each form, by mapping name. */
export async function fingerprintsOf(
	forms: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [name, form] of Object.entries(forms)) out[name] = await fingerprint(form);
	return out;
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/fingerprints.test.ts`
Expected: PASS (1 file, 10 tests). Full suite after this task: 64 files / 1,562 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/fingerprints.ts packages/flux-import/src/engine/diff.ts packages/flux-import/tests/unit/fingerprints.test.ts
git commit -m "Fingerprint each mapping's value in a canonical form that agrees with the plan's comparison"
```

### Task 3: Revisions, ports, adapter and fakes

**Files:**
- Create: `packages/flux-import/src/engine/revs.ts`
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/emdash/content.ts`, `packages/flux-import/src/engine/revert.ts`
- Test: `packages/flux-import/tests/unit/fakes.ts`, `packages/flux-import/tests/unit/fakes.test.ts`, `packages/flux-import/tests/unit/content.test.ts`, `packages/flux-import/tests/unit/batch.test.ts`, `packages/flux-import/tests/unit/journal.test.ts`, `packages/flux-import/tests/unit/rollback.test.ts`

**Interfaces:**
- Consumes: `ContentPort`, `RevertStep`, `WriteResult`, `ContentWriteError`; `EmDashContent`, `ContentRuntime`, `writeError`; `STEP_COST`; `FakeContent` and its hooks.
- Produces:
  - `encodeRev(version, updatedAt)` and `decodeRev(rev)`, which returns `{ version, updatedAt }` or `null`;
  - `ContentPort.schedule({ collection, locale, id, rev, scheduledAt }): Promise<WriteResult>`. It is lock-checked; `CONFLICT` becomes `conflict`, and other errors throw `ContentWriteError`, with `emdash_schedule_rejected` for a hook's refusal;
  - `RevertStep` gains `"unschedule"`, `ContentRuntime.handleContentUnschedule` is added, and `STEP_COST.unschedule = 15`;
  - in the fakes:
    - the encoded `_rev` and `revOf(id)`;
    - `makeLive`, `setSchedule`, `schedule()`, the `beforeSchedule` and `afterSchedule` hooks, and `blockStep("schedule")`;
    - the `unschedule` step, `setTerms(id, taxonomy, slugs)` and `runScheduled()`.

- [ ] **Step 1: Write the failing tests and the fakes**

In `packages/flux-import/tests/unit/batch.test.ts`, replace
````ts
			true,
		);
		const link = await deps.links.get("products:en:S0");
		expect(link?.writtenRev).toBe(String(deps.content.entries.get("e1")!.rev));
	});

	it("explains conflict and locked rows from the write and the lock check", async () => {
````
with:
````ts
			true,
		);
		const link = await deps.links.get("products:en:S0");
		expect(link?.writtenRev).toBe(deps.content.revOf("e1"));
	});

	it("explains conflict and locked rows from the write and the lock check", async () => {
````

In `packages/flux-import/tests/unit/batch.test.ts`, replace
````ts
		clock.t += draftJob.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, draftJob.id);
		expect(done.counters).toMatchObject({ created: 3, conflict: 0 });
		expect((await deps.links.get("products:en:S1"))?.writtenRev).toBe(
			String(deps.content.entries.get("e2")!.rev),
		);

		const second = await createJob(deps, { uploadId: "u1", template, schemaFields });
		const published = await runToEnd(deps, second.id);
````
with:
````ts
		clock.t += draftJob.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, draftJob.id);
		expect(done.counters).toMatchObject({ created: 3, conflict: 0 });
		expect((await deps.links.get("products:en:S1"))?.writtenRev).toBe(deps.content.revOf("e2"));

		const second = await createJob(deps, { uploadId: "u1", template, schemaFields });
		const published = await runToEnd(deps, second.id);
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
			item.draftRevisionId = null;
		});
	}
}

const actor = { id: "u1", role: 50 };
````
with:
````ts
			item.draftRevisionId = null;
		});
	}
	async handleContentUnschedule(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["unschedule", collection, id, options]);
		return this.step(id, options, (item) => {
			item.scheduledAt = null;
			if (item.status !== "published") item.status = "draft";
		});
	}
}

const actor = { id: "u1", role: 50 };
````

In `packages/flux-import/tests/unit/content.test.ts`, replace
````ts
		).rejects.toMatchObject({ code: "emdash_validation_error" });
	});
});
````
with:
````ts
		).rejects.toMatchObject({ code: "emdash_validation_error" });
	});
});

describe("EmDashContent schedule and unschedule (M5b)", () => {
	const base = { collection: "products", locale: "en", id: "e1" };
	const at = "2026-12-01T07:00:00.000Z";

	it("schedules at the given revision as the importing user and returns the new revision", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(await content.schedule({ ...base, rev: "rev-1", scheduledAt: at })).toEqual({
			ok: true,
			rev: "rev-2",
		});
		expect(runtime.calls.at(-1)).toEqual([
			"schedule",
			"products",
			"e1",
			at,
			{ _rev: "rev-1", actor },
		]);
		expect(await content.schedule({ ...base, rev: "rev-1", scheduledAt: at })).toEqual({
			ok: false,
			reason: "conflict",
		});
	});

	it("checks the lock first, and throws a hook's refusal and other errors with EmDash's code", async () => {
		const locked = new Set(["e1"]);
		const { runtime, content } = setup((_c, id) => locked.has(id));
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const before = runtime.calls.length;
		expect(await content.schedule({ ...base, rev: "rev-1", scheduledAt: at })).toEqual({
			ok: false,
			reason: "locked",
		});
		expect(runtime.calls).toHaveLength(before);
		locked.clear();
		runtime.stepOverride = fail("SCHEDULE_REJECTED", "Not on Fridays");
		await expect(
			content.schedule({ ...base, rev: "rev-1", scheduledAt: at }),
		).rejects.toMatchObject({
			code: "emdash_schedule_rejected",
			message: "Scheduling the entry failed: Not on Fridays",
		});
		runtime.stepOverride = fail("VALIDATION_ERROR", "Scheduled date must be in the future");
		await expect(
			content.schedule({ ...base, rev: "rev-1", scheduledAt: at }),
		).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
	});

	it("unschedules as revert step 7, lock checked, with the revision only", async () => {
		const locked = new Set<string>();
		const { runtime, content } = setup((_c, id) => locked.has(id));
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		await content.revertStep({ ...base, rev: "rev-1", step: "schedule", scheduledAt: at });
		const unscheduled = await content.revertStep({ ...base, rev: "rev-2", step: "unschedule" });
		expect(unscheduled).toMatchObject({
			ok: true,
			state: { rev: "rev-3", status: "draft", scheduledAt: null },
		});
		expect(runtime.calls.at(-1)).toEqual(["unschedule", "products", "e1", { _rev: "rev-2" }]);
		locked.add("e1");
		expect(await content.revertStep({ ...base, rev: "rev-3", step: "unschedule" })).toMatchObject({
			ok: false,
			reason: "locked",
		});
	});
});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
import { describe, expect, it } from "vitest";
import { FakeContent, MemoryKv } from "./fakes.js";

describe("MemoryKv", () => {
````
with:
````ts
import { describe, expect, it } from "vitest";
import { decodeRev, encodeRev } from "../../src/engine/revs.js";
import { FakeContent, MemoryKv } from "./fakes.js";

describe("MemoryKv", () => {
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
			updatedAt: at(0),
		});
		clock.t += 1000;
		await content.publish({ id, rev: "1" });
		await content.update({ id, rev: "2", data: { title: "B" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
````
with:
````ts
			updatedAt: at(0),
		});
		clock.t += 1000;
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), data: { title: "B" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
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
````
with:
````ts
			data: { title: "B" },
			updatedAt: at(1000),
		});
		await content.update({ id, rev: content.revOf(id), taxonomies: { tag: ["new"] } });
		expect((await content.get("products", "en", id))?.live).toEqual({ title: "A" });

		content.plainCollections.add("plain");
		const plain = await content.create({ ...base, collection: "plain", data: { title: "A" } });
		await content.publish({ id: plain.id, rev: content.revOf(plain.id) });
		await content.update({ id: plain.id, rev: content.revOf(plain.id), data: { title: "B" } });
		expect(await content.get("plain", "en", plain.id)).toMatchObject({
			hasDraft: false,
			pendingPublish: false,
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts

	it("moves entries to Trash, hides them from reads and deletes them for good", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: { flux_source_id: "K" } });
		content.blockDelete = () => "Not today";
		expect(await content.trash("products", id)).toEqual({
			ok: false,
````
with:
````ts

	it("moves entries to Trash, hides them from reads and deletes them for good", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, data: { flux_source_id: "K" } });
		content.blockDelete = () => "Not today";
		expect(await content.trash("products", id)).toEqual({
			ok: false,
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		expect(await content.get("products", "en", id)).toBeNull();
		expect(await content.findBySourceId("products", "en", "K")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", id)).toMatchObject({
			rev: "1",
			trashed: true,
		});
		expect((await content.trash("products", id)).ok).toBe(false);
````
with:
````ts
		expect(await content.get("products", "en", id)).toBeNull();
		expect(await content.findBySourceId("products", "en", "K")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", id)).toMatchObject({
			rev,
			trashed: true,
		});
		expect((await content.trash("products", id)).ok).toBe(false);
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
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

	const stepOf =
		(content: FakeContent, id: string, collection = "products") =>
		(rev: number, s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({ collection, locale: "en", id, rev: String(rev), step: s, ...extra });

	it("answers locked before any step, not conflict", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		content.locked.add(id);
		const step = stepOf(content, id);
		for (const s of ["update", "publish", "unpublish", "discard"] as const) {
			expect(await step(1, s)).toMatchObject({ ok: false, reason: "locked" });
			expect(await step(99, s)).toMatchObject({ ok: false, reason: "locked" });
		}
	});
````
with:
````ts
	it("runs revert steps with revision checks, hook refusals and EmDash's draft rules", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const step = (s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({ ...base, id, rev: content.revOf(id), step: s, ...extra });
		expect(await content.revertStep({ ...base, id, rev: "stale", step: "publish" })).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		const published = await step("publish");
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		const unpublished = await step("unpublish");
		// As EmDash: the unpublish creates a draft from the live revision (spec M5a F18).
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		expect(await step("discard")).toMatchObject({ ok: true, state: { hasDraft: false } });
		await expect(step("schedule", { scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		const scheduled = await step("schedule", { scheduledAt: at(60_000) });
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at(60_000) },
		});
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		expect(await step("publish")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Not on Fridays",
		});
		const updated = await step("update", { data: { title: "B" }, slug: "b" });
		expect(updated).toMatchObject({ ok: true, state: { hasDraft: true } });
		expect(content.entries.get(id)).toMatchObject({ slug: "b", data: { title: "B" } });
	});

	/** A revert step at the entry's current `_rev`. */
	const stepOf =
		(content: FakeContent, id: string, collection = "products") =>
		(s: Parameters<FakeContent["revertStep"]>[0]["step"], extra = {}) =>
			content.revertStep({
				collection,
				locale: "en",
				id,
				rev: content.revOf(id),
				step: s,
				...extra,
			});

	it("answers locked before any step, not conflict", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, data: {} });
		content.locked.add(id);
		const step = stepOf(content, id);
		for (const s of ["update", "publish", "unpublish", "discard", "unschedule"] as const) {
			expect(await step(s)).toMatchObject({ ok: false, reason: "locked" });
			const stale = { collection: "products", locale: "en", id, rev: "stale", step: s };
			expect(await content.revertStep(stale)).toMatchObject({ ok: false, reason: "locked" });
		}
	});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
			data: { t: "A" },
		});
		const step = stepOf(content, id, "plain");
		await step(1, "publish");
		await content.update({ id, rev: "2", data: { t: "B" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "B" });
		await step(3, "unpublish");
		const drafted = await content.get("plain", "en", id);
		// The draft is the live revision saved at the publish; it hides the columns (F18).
		expect(drafted).toMatchObject({ status: "draft", hasDraft: true, data: { t: "A" } });
		expect(drafted?.live).toEqual({ t: "B" });
		await content.update({ id, rev: "4", data: { t: "C" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "A" });
		expect(content.entries.get(id)?.data).toEqual({ t: "C" });
		await step(5, "discard");
		expect(await content.get("plain", "en", id)).toMatchObject({
			hasDraft: false,
			data: { t: "C" },
````
with:
````ts
			data: { t: "A" },
		});
		const step = stepOf(content, id, "plain");
		await step("publish");
		await content.update({ id, rev: content.revOf(id), data: { t: "B" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "B" });
		await step("unpublish");
		const drafted = await content.get("plain", "en", id);
		// The draft is the live revision saved at the publish; it hides the columns (F18).
		expect(drafted).toMatchObject({ status: "draft", hasDraft: true, data: { t: "A" } });
		expect(drafted?.live).toEqual({ t: "B" });
		await content.update({ id, rev: content.revOf(id), data: { t: "C" } });
		expect((await content.get("plain", "en", id))?.data).toEqual({ t: "A" });
		expect(content.entries.get(id)?.data).toEqual({ t: "C" });
		await step("discard");
		expect(await content.get("plain", "en", id)).toMatchObject({
			hasDraft: false,
			data: { t: "C" },
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A", u: "x" } });
		const step = stepOf(content, id, "plain");
		await step(1, "publish");
		await content.update({ id, rev: "2", data: { t: "B" } });
		await step(3, "publish");
		await step(4, "unpublish");
		// The live revision was made at the first publish and kept by the second.
		const drafted = await content.get("plain", "en", id);
		expect(drafted).toMatchObject({ hasDraft: true, data: { t: "A", u: "x" } });
````
with:
````ts
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A", u: "x" } });
		const step = stepOf(content, id, "plain");
		await step("publish");
		await content.update({ id, rev: content.revOf(id), data: { t: "B" } });
		await step("publish");
		await step("unpublish");
		// The live revision was made at the first publish and kept by the second.
		const drafted = await content.get("plain", "en", id);
		expect(drafted).toMatchObject({ hasDraft: true, data: { t: "A", u: "x" } });
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A" } });
		const step = stepOf(content, id, "plain");
		await step(1, "publish");
		await step(2, "unpublish");
		await step(3, "discard");
		clock.t += 1;
		await step(4, "schedule", { scheduledAt: at(60_000) });
		expect(await step(5, "unpublish")).toMatchObject({ ok: true, state: { hasDraft: false } });
	});

	it("creates no draft on unpublish when no live revision exists", async () => {
````
with:
````ts
		content.plainCollections.add("plain");
		const { id } = await content.create({ ...base, collection: "plain", data: { t: "A" } });
		const step = stepOf(content, id, "plain");
		await step("publish");
		await step("unpublish");
		await step("discard");
		clock.t += 1;
		await step("schedule", { scheduledAt: at(60_000) });
		expect(await step("unpublish")).toMatchObject({ ok: true, state: { hasDraft: false } });
	});

	it("creates no draft on unpublish when no live revision exists", async () => {
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
			const { id } = await content.create({ ...base, collection, data: {} });
			const step = stepOf(content, id, collection);
			clock.t += 1;
			await step(1, "schedule", { scheduledAt: at(60_000) });
			expect(await step(2, "unpublish")).toMatchObject({
				ok: true,
				state: { status: "draft", scheduledAt: null, hasDraft: false },
			});
````
with:
````ts
			const { id } = await content.create({ ...base, collection, data: {} });
			const step = stepOf(content, id, collection);
			clock.t += 1;
			await step("schedule", { scheduledAt: at(60_000) });
			expect(await step("unpublish")).toMatchObject({
				ok: true,
				state: { status: "draft", scheduledAt: null, hasDraft: false },
			});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
	it("reads the live slug while a draft is pending", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await content.publish({ id, rev: "1" });
		await content.update({ id, rev: "2", slug: "b" });
		expect(await content.get("products", "en", id)).toMatchObject({ slug: "a", hasDraft: true });
		expect(content.entries.get(id)?.slug).toBe("b");
	});
````
with:
````ts
	it("reads the live slug while a draft is pending", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), slug: "b" });
		expect(await content.get("products", "en", id)).toMatchObject({ slug: "a", hasDraft: true });
		expect(content.entries.get(id)?.slug).toBe("b");
	});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
	it("writes a null slug", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await stepOf(content, id)(1, "update", { slug: null });
		// The slug is staged in a draft, so the live slug is still read.
		expect(content.entries.get(id)?.slug).toBeNull();
	});
````
with:
````ts
	it("writes a null slug", async () => {
		const { content } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		await stepOf(content, id)("update", { slug: null });
		// The slug is staged in a draft, so the live slug is still read.
		expect(content.entries.get(id)?.slug).toBeNull();
	});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		await content.trash("products", fr.id);
		await expect(
			content.create({ ...base, locale: "fr", data: {}, translationOf: id }),
		).resolves.toMatchObject({ rev: "1" });
	});

	it("keeps slugs unique per collection and locale, Trash included", async () => {
````
with:
````ts
		await content.trash("products", fr.id);
		await expect(
			content.create({ ...base, locale: "fr", data: {}, translationOf: id }),
		).resolves.toHaveProperty("rev");
	});

	it("keeps slugs unique per collection and locale, Trash included", async () => {
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		});
		await content.create({ ...base, locale: "fr", slug: "a", data: {} });
		const b = await content.create({ ...base, slug: "b", data: {} });
		await expect(content.update({ id: b.id, rev: "1", slug: "a" })).rejects.toMatchObject({
			code: "emdash_slug_conflict",
		});
		await content.trash("products", a.id);
````
with:
````ts
		});
		await content.create({ ...base, locale: "fr", slug: "a", data: {} });
		const b = await content.create({ ...base, slug: "b", data: {} });
		await expect(content.update({ id: b.id, rev: b.rev, slug: "a" })).rejects.toMatchObject({
			code: "emdash_slug_conflict",
		});
		await content.trash("products", a.id);
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
			"references",
		);
		await expect(
			content.revertStep({ collection: "products", locale: "en", id, rev: "1", step: "discard" }),
		).rejects.toMatchObject({ code: "emdash_not_found" });
	});
````
with:
````ts
			"references",
		);
		await expect(
			content.revertStep({ collection: "products", locale: "en", id, rev: "any", step: "discard" }),
		).rejects.toMatchObject({ code: "emdash_not_found" });
	});
````

In `packages/flux-import/tests/unit/fakes.test.ts`, replace
````ts
		const { id } = await content.create({ ...base, data: {} });
		content.blockStep = () => "No";
		const step = stepOf(content, id);
		expect(await step(1, "update", { data: { a: 1 } })).toMatchObject({ ok: true });
		expect(await step(2, "discard")).toMatchObject({ ok: true });
	});
});
````
with:
````ts
		const { id } = await content.create({ ...base, data: {} });
		content.blockStep = () => "No";
		const step = stepOf(content, id);
		expect(await step("update", { data: { a: 1 } })).toMatchObject({ ok: true });
		expect(await step("discard")).toMatchObject({ ok: true });
	});
});

describe("FakeContent as EmDash schedules and revises (M5b)", () => {
	const at = (ms: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + ms).toISOString();
	function setup() {
		const clock = { t: Date.parse("2026-10-07T10:00:00Z") };
		const content = new FakeContent();
		content.now = () => clock.t;
		return { content, clock };
	}
	const base = { collection: "products", locale: "en" };

	it("encodes the revision as EmDash does: base64 of version and updatedAt", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		expect(rev).toBe(btoa(`1:${at(0)}`));
		expect(decodeRev(rev)).toEqual({ version: 1, updatedAt: at(0) });
		expect(encodeRev(1, at(0))).toBe(rev);
		expect(content.revOf(id)).toBe(rev);
		expect(decodeRev("not base64!")).toBeNull();
		expect(decodeRev(btoa("x:2026-10-07T10:00:00.000Z"))).toBeNull();
		expect(decodeRev(btoa("3:"))).toBeNull();
	});

	it("schedules without a new version: only updatedAt moves, so a standing clock keeps the revision", async () => {
		const { content, clock } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const same = await content.schedule({ ...base, id, rev, scheduledAt: at(120_000) });
		expect(same).toEqual({ ok: true, rev });
		clock.t += 5;
		const moved = await content.schedule({ ...base, id, rev, scheduledAt: at(180_000) });
		expect(moved.ok && decodeRev(moved.rev)).toEqual({ version: 1, updatedAt: at(5) });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "scheduled",
			scheduledAt: at(180_000),
		});
		expect(content.calls).toEqual([`create:${id}`, `schedule:${id}`, `schedule:${id}`]);
	});

	it("keeps a published entry published with its draft due, and an update keeps the schedule", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: { title: "A" } });
		await content.publish({ id, rev: content.revOf(id) });
		await content.update({ id, rev: content.revOf(id), data: { title: "B" } });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		await content.update({ id, rev: content.revOf(id), data: { title: "C" } });
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "published",
			hasDraft: true,
			scheduledAt: at(60_000),
			data: { title: "C" },
			live: { title: "A" },
		});
	});

	it("refuses a schedule that is stale, locked, refused by a hook or not in the future", async () => {
		const { content, clock } = setup();
		const { id, rev } = await content.create({ ...base, slug: "a", data: {} });
		const input = { ...base, id, rev, scheduledAt: at(60_000) };
		expect(await content.schedule({ ...input, rev: "stale" })).toEqual({
			ok: false,
			reason: "conflict",
		});
		content.locked.add(id);
		expect(await content.schedule(input)).toEqual({ ok: false, reason: "locked" });
		content.locked.clear();
		content.blockStep = (s) => (s === "schedule" ? "Not on Fridays" : null);
		await expect(content.schedule(input)).rejects.toMatchObject({
			code: "emdash_schedule_rejected",
		});
		content.blockStep = () => null;
		await expect(content.schedule({ ...input, scheduledAt: at(0) })).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
		clock.t += 1;
		expect(content.calls).toEqual([`create:${id}`]);
	});

	it("unschedules without a new version, and does nothing to an entry without a schedule", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		const step = () =>
			content.revertStep({ ...base, id, rev: content.revOf(id), step: "unschedule" });
		const before = content.revOf(id);
		expect(await step()).toMatchObject({ ok: true, state: { rev: before, status: "draft" } });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		content.blockStep = () => "never asked";
		clock.t += 1;
		const unscheduled = await step();
		expect(unscheduled).toMatchObject({
			ok: true,
			state: { status: "draft", scheduledAt: null },
		});
		expect(unscheduled.ok && decodeRev(unscheduled.state.rev)).toEqual({
			version: 1,
			updatedAt: at(2),
		});
	});

	it("changes terms through the terms route without moving the revision (F8)", async () => {
		const { content } = setup();
		const { id, rev } = await content.create({ ...base, data: {}, taxonomies: { tag: ["old"] } });
		content.setTerms(id, "tag", ["new"]);
		expect(content.revOf(id)).toBe(rev);
		expect(content.entries.get(id)?.taxonomies.tag).toEqual(["new"]);
	});

	it("publishes due entries as the scheduler does: one version, live, no draft or schedule", async () => {
		const { content, clock } = setup();
		const draft = await content.create({ ...base, slug: "a", data: { title: "A" } });
		const live = await content.create({ ...base, slug: "b", data: { title: "B" } });
		await content.publish({ id: live.id, rev: content.revOf(live.id) });
		await content.update({ id: live.id, rev: content.revOf(live.id), data: { title: "B2" } });
		const trashed = await content.create({ ...base, slug: "c", data: {} });
		const later = await content.create({ ...base, slug: "d", data: {} });
		clock.t += 1;
		for (const id of [draft.id, live.id, trashed.id]) {
			await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		}
		await content.schedule({
			...base,
			id: later.id,
			rev: content.revOf(later.id),
			scheduledAt: at(120_000),
		});
		await content.trash("products", trashed.id);
		const versions = new Map([...content.entries.values()].map((e) => [e.id, e.rev]));
		expect(content.runScheduled()).toEqual([]);
		clock.t = Date.parse(at(60_000));
		expect(content.runScheduled()).toEqual([draft.id, live.id]);
		for (const id of [draft.id, live.id]) {
			expect(content.entries.get(id)?.rev).toBe((versions.get(id) ?? 0) + 1);
			expect(await content.get("products", "en", id)).toMatchObject({
				status: "published",
				hasDraft: false,
				scheduledAt: null,
				updatedAt: at(60_000),
			});
		}
		expect((await content.get("products", "en", live.id))?.data).toEqual({ title: "B2" });
		expect(content.entries.get(trashed.id)).toMatchObject({ status: "scheduled", trashed: true });
		expect(content.entries.get(later.id)).toMatchObject({ status: "scheduled" });
	});

	it("unschedules a due entry whose publish a hook refuses, as the scheduler does", async () => {
		const { content, clock } = setup();
		const { id } = await content.create({ ...base, slug: "a", data: {} });
		clock.t += 1;
		await content.schedule({ ...base, id, rev: content.revOf(id), scheduledAt: at(60_000) });
		content.blockStep = (s) => (s === "publish" ? "Not on Fridays" : null);
		clock.t = Date.parse(at(60_000));
		expect(content.runScheduled()).toEqual([]);
		expect(await content.get("products", "en", id)).toMatchObject({
			status: "draft",
			scheduledAt: null,
		});
		expect(content.entries.get(id)?.rev).toBe(1);
	});
});
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type {
	EngineDeps,
	Job,
````
with:
````ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import { encodeRev } from "../../src/engine/revs.js";
import type {
	EngineDeps,
	Job,
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	data: Record<string, unknown>;
	/** The translation group: the entry's own ID, or its source's group (EmDash, spec M4e F3). */
	group: string;
	rev: number;
	pendingPublish: boolean;
	/** Term slugs by taxonomy, entry IDs by reference field, byline credits: as written. */
````
with:
````ts
	data: Record<string, unknown>;
	/** The translation group: the entry's own ID, or its source's group (EmDash, spec M4e F3). */
	group: string;
	/** EmDash's `version`; the entry's `_rev` encodes it with `updatedAt` (`revOf`, spec M5b F1). */
	rev: number;
	pendingPublish: boolean;
	/** Term slugs by taxonomy, entry IDs by reference field, byline credits: as written. */
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	/**
	 * The non-translatable fields: a create with `translationOf` takes their values from the
	 * source, as EmDash does (spec M4e F1).
````
with:
````ts
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	/** M5b: called at the start of schedule; throw from it to simulate a crash before it. */
	beforeSchedule: (id: string) => void = () => {};
	/** M5b: called after a schedule landed; throw from it to simulate a crash before its save. */
	afterSchedule: (id: string) => void = () => {};
	/**
	 * The non-translatable fields: a create with `translationOf` takes their values from the
	 * source, as EmDash does (spec M4e F1).
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		return new Date(this.now()).toISOString();
	}

	/** A write that changes the row: a new revision and `updatedAt`. */
	private touch(e: StoredEntry): void {
		e.rev++;
		e.updatedAt = this.stamp();
	}

	/** As EmDash: a slug is unique per collection and locale, and Trash still holds it. */
	private checkSlug(
		collection: string,
````
with:
````ts
		return new Date(this.now()).toISOString();
	}

	/** A write that changes the row: a new version and `updatedAt`. */
	private touch(e: StoredEntry): void {
		e.rev++;
		e.updatedAt = this.stamp();
	}

	/** The entry's `_rev`, as EmDash encodes it: `base64("<version>:<updatedAt>")` (M5b F1). */
	private encoded(e: StoredEntry): string {
		return encodeRev(e.rev, e.updatedAt);
	}

	/** The current `_rev` of an entry, for tests that write as an editor would. */
	revOf(id: string): string {
		const e = this.entries.get(id);
		if (!e) throw new Error(`No entry ${id}`);
		return this.encoded(e);
	}

	/** As EmDash: a slug is unique per collection and locale, and Trash still holds it. */
	private checkSlug(
		collection: string,
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
			rev: String(e.rev),
			// As hydrateDraftData: a pending draft changes the data, never the live slug.
			slug: e.live?.slug ?? e.slug,
			data: structuredClone(e.stale ? { ...e.data, ...e.stale.data } : e.data),
````
with:
````ts
	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
			rev: this.encoded(e),
			// As hydrateDraftData: a pending draft changes the data, never the live slug.
			slug: e.live?.slug ?? e.slug,
			data: structuredClone(e.stale ? { ...e.data, ...e.stale.data } : e.data),
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
			throw new ContentWriteError("emdash_not_found", "Entry not found");
		}
		if (this.locked.has(e.id)) return { ok: false, reason: "locked", message: "locked" };
		if (String(e.rev) !== input.rev) {
			return { ok: false, reason: "conflict", message: "Revision precondition did not match" };
		}
		// Only publish, unpublish and schedule run policy hooks; a discard cannot be refused.
		const blocked =
			input.step === "update" || input.step === "discard" ? null : this.blockStep(input.step, e.id);
		if (blocked !== null) return { ok: false, reason: "blocked", message: blocked };
		switch (input.step) {
			case "update": {
````
with:
````ts
			throw new ContentWriteError("emdash_not_found", "Entry not found");
		}
		if (this.locked.has(e.id)) return { ok: false, reason: "locked", message: "locked" };
		if (this.encoded(e) !== input.rev) {
			return { ok: false, reason: "conflict", message: "Revision precondition did not match" };
		}
		// Only publish, unpublish and schedule run policy hooks; a discard, an update and an
		// unschedule (no beforeUnschedule hook, spec M5b F3) cannot be refused.
		const unhooked = ["update", "discard", "unschedule"];
		const blocked = unhooked.includes(input.step) ? null : this.blockStep(input.step, e.id);
		if (blocked !== null) return { ok: false, reason: "blocked", message: blocked };
		switch (input.step) {
			case "update": {
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
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
````
with:
````ts
					e.rev++;
				}
				break;
			case "schedule":
				this.setSchedule(e, input.scheduledAt ?? "", "Rolling back the entry (schedule)");
				break;
			case "unschedule":
				// As EmDash: a no-op without a schedule; else the status goes back to draft unless
				// published, and only `updated_at` moves (repositories/content.ts:2155-2198).
				if (e.scheduledAt !== null) {
					e.scheduledAt = null;
					if (e.status !== "published") e.status = "draft";
					e.updatedAt = this.stamp();
				}
				break;
		}
		if (input.step !== "update" && input.step !== "publish") {
			this.calls.push(`${input.step}:${e.id}`);
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		return {
			ok: true,
			state: {
				rev: String(e.rev),
				status: e.status,
				scheduledAt: e.scheduledAt,
				hasDraft: this.hasDraft(e),
````
with:
````ts
		return {
			ok: true,
			state: {
				rev: this.encoded(e),
				status: e.status,
				scheduledAt: e.scheduledAt,
				hasDraft: this.hasDraft(e),
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		this.entries.set(id, entry);
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: "1" };
	}
	async update(
		input: {
````
with:
````ts
		this.entries.set(id, entry);
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: this.encoded(entry) };
	}
	async update(
		input: {
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		this.checkSlug(e.collection, e.locale, input.slug, e.id);
````
with:
````ts
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		this.checkSlug(e.collection, e.locale, input.slug, e.id);
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		if (staged && !plain) e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
	}
	async publish(input: { id: string; rev: string }): Promise<WriteResult> {
		this.beforePublish(input.id);
````
with:
````ts
		if (staged && !plain) e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: this.encoded(e) };
	}
	async publish(input: { id: string; rev: string }): Promise<WriteResult> {
		this.beforePublish(input.id);
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		const forced = this.failPublish(e.id);
		if (forced) return { ok: false, reason: forced };
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		e.pendingPublish = false;
		e.status = "published";
		e.scheduledAt = null;
````
with:
````ts
		const forced = this.failPublish(e.id);
		if (forced) return { ok: false, reason: forced };
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		this.makeLive(e);
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: this.encoded(e) };
	}

	/** EmDash's publish (F4): status, draft and schedule cleared, a new version and `updated_at`. */
	private makeLive(e: StoredEntry): void {
		e.pendingPublish = false;
		e.status = "published";
		e.scheduledAt = null;
````

In `packages/flux-import/tests/unit/fakes.ts`, replace
````ts
		if (this.plainCollections.has(e.collection)) e.published ??= { data: structuredClone(e.data) };
		else e.published = { data: structuredClone(e.data) };
		this.touch(e);
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: String(e.rev) };
	}
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
````
with:
````ts
		if (this.plainCollections.has(e.collection)) e.published ??= { data: structuredClone(e.data) };
		else e.published = { data: structuredClone(e.data) };
		this.touch(e);
	}

	/**
	 * EmDash's schedule (spec M5b F2): a time not after now is refused; a draft becomes
	 * `scheduled` and a published entry stays published; `version` is kept and only `updated_at`
	 * moves, so at a clock that has not moved the `_rev` stays the same, as in EmDash.
	 */
	private setSchedule(e: StoredEntry, at: string, op: string): void {
		if (!(Date.parse(at) > this.now())) {
			throw new ContentWriteError(
				"emdash_validation_error",
				`${op} failed: Scheduled date must be in the future`,
			);
		}
		e.scheduledAt = at;
		if (e.status !== "published") e.status = "scheduled";
		e.updatedAt = this.stamp();
	}

	async schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult> {
		this.beforeSchedule(input.id);
		const e = this.entries.get(input.id);
		if (!e || e.trashed) throw new ContentWriteError("emdash_not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		const blocked = this.blockStep("schedule", e.id);
		if (blocked !== null) {
			throw new ContentWriteError(
				"emdash_schedule_rejected",
				`Scheduling the entry failed: ${blocked}`,
			);
		}
		this.setSchedule(e, input.scheduledAt, "Scheduling the entry");
		this.calls.push(`schedule:${e.id}`);
		this.afterSchedule(e.id);
		return { ok: true, rev: this.encoded(e) };
	}

	/**
	 * An editor's term change through the admin terms route (spec M5b F8): only the entry's term
	 * assignments change, so its `_rev` stays as it was.
	 */
	setTerms(id: string, taxonomy: string, slugs: string[]): void {
		const e = this.entries.get(id);
		if (!e) throw new Error(`No entry ${id}`);
		e.taxonomies[taxonomy] = [...slugs];
	}

	/**
	 * One pass of EmDash's scheduler (`publishDueContent`, spec M5b F5): every active entry due by
	 * now is published without a revision check; a publish hook's refusal unschedules it instead.
	 * Returns the IDs published.
	 */
	runScheduled(): string[] {
		const published: string[] = [];
		for (const e of this.entries.values()) {
			if (e.trashed || e.scheduledAt === null || Date.parse(e.scheduledAt) > this.now()) continue;
			if (this.blockStep("publish", e.id) !== null) {
				e.scheduledAt = null;
				if (e.status !== "published") e.status = "draft";
				e.updatedAt = this.stamp();
				continue;
			}
			this.makeLive(e);
			this.calls.push(`scheduled:${e.id}`);
			published.push(e.id);
		}
		return published;
	}
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
````

In `packages/flux-import/tests/unit/journal.test.ts`, replace
````ts
		expect(row).toMatchObject({ kind: "create", entryId: entryOf(deps, "A1").id, confirmed: true });
		expect(await deps.links.get(linkKey("products", "en", "A1"))).toMatchObject({
			jobId: job.id,
			writtenRev: String(entryOf(deps, "A1").rev),
		});
	});
````
with:
````ts
		expect(row).toMatchObject({ kind: "create", entryId: entryOf(deps, "A1").id, confirmed: true });
		expect(await deps.links.get(linkKey("products", "en", "A1"))).toMatchObject({
			jobId: job.id,
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
	});
````

In `packages/flux-import/tests/unit/journal.test.ts`, replace
````ts
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = String(entry.rev);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
````
with:
````ts
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = deps.content.revOf(entry.id);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
````

In `packages/flux-import/tests/unit/journal.test.ts`, replace
````ts
	const entry = entryOf(deps, "A1");
	const result = await deps.content.update({
		id: entry.id,
		rev: String(entry.rev),
		data: { price },
	});
	if (!result.ok) throw new Error(result.reason);
````
with:
````ts
	const entry = entryOf(deps, "A1");
	const result = await deps.content.update({
		id: entry.id,
		rev: deps.content.revOf(entry.id),
		data: { price },
	});
	if (!result.ok) throw new Error(result.reason);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		// The link is handed back to the job before, at the rollback's revision.
		expect(await linkOf(deps, "A1")).toMatchObject({
			jobId: (await deps.jobs.query({ where: {} })).items[0]?.id,
			writtenRev: String(entryOf(deps, "A1").rev),
		});
		// The same feed imports again.
		const again = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
````
with:
````ts
		// The link is handed back to the job before, at the rollback's revision.
		expect(await linkOf(deps, "A1")).toMatchObject({
			jobId: (await deps.jobs.query({ where: {} })).items[0]?.id,
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
		// The same feed imports again.
		const again = await importRows(deps, [changed, { sku: "A2", name: "Lamp", related: "A1" }]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
				collection: "products",
				locale: "en",
				id: e.id,
				rev: String(e.rev),
				step: "schedule",
				scheduledAt: at,
			});
````
with:
````ts
				collection: "products",
				locale: "en",
				id: e.id,
				rev: deps.content.revOf(e.id),
				step: "schedule",
				scheduledAt: at,
			});
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
			// As a scheduling import (M5b) would leave it: the importer's revision on the link.
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: String(e.rev),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
````
with:
````ts
			// As a scheduling import (M5b) would leave it: the importer's revision on the link.
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: deps.content.revOf(e.id),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		// An editor's change after a references-only import is still caught.
		const second = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		const e = entryOf(deps, "A2");
		await deps.content.update({ id: e.id, rev: String(e.rev), references: { related: [] } });
		const refused = await rollBack(deps, second.id);
		expect(refused.counters).toMatchObject({ conflict: 1, reverted: 0 });
	});
````
with:
````ts
		// An editor's change after a references-only import is still caught.
		const second = await importRows(deps, [{ sku: "A2", name: "Lamp", related: "A3" }]);
		const e = entryOf(deps, "A2");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			references: { related: [] },
		});
		const refused = await rollBack(deps, second.id);
		expect(refused.counters).toMatchObject({ conflict: 1, reverted: 0 });
	});
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const after = stateOf(deps, "A1");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
````
with:
````ts
		await importRows(deps, [desk]);
		const job = await importRows(deps, [changed]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const after = stateOf(deps, "A1");
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		const link = await linkOf(deps, "A1");
		// An editor changes the entry, then a job's write-ahead put happens and its write does not.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		clock.t += 1000;
		// The job of the ghost row; it writes another entry, so A1's link stays as it was.
		const ghost = await importRows(deps, [{ sku: "Z1", name: "Other" }]);
````
with:
````ts
		const link = await linkOf(deps, "A1");
		// An editor changes the entry, then a job's write-ahead put happens and its write does not.
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		clock.t += 1000;
		// The job of the ghost row; it writes another entry, so A1's link stays as it was.
		const ghost = await importRows(deps, [{ sku: "Z1", name: "Other" }]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
				collection: "products",
				locale: "en",
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
````
with:
````ts
				collection: "products",
				locale: "en",
				id: e.id,
				rev: deps.content.revOf(e.id),
				step: "schedule",
				scheduledAt: new Date(clock.t + 60_000).toISOString(),
			});
			const link = await linkOf(deps, "A1");
			await deps.links.put(linkKey("products", "en", "A1"), {
				...link!,
				writtenRev: deps.content.revOf(e.id),
			});
			const before = stateOf(deps, "A1");
			const job = await importRows(deps, [changed]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		collection: "products",
		locale: "en",
		id: e.id,
		rev: String(e.rev),
		step: "schedule",
		scheduledAt: at,
	});
	const link = await linkOf(deps, "A1");
	await deps.links.put(linkKey("products", "en", "A1"), { ...link!, writtenRev: String(e.rev) });
}

type Shape = { name: string; plain: boolean; prepare: (deps: Deps, t: number) => Promise<void> };
````
with:
````ts
		collection: "products",
		locale: "en",
		id: e.id,
		rev: deps.content.revOf(e.id),
		step: "schedule",
		scheduledAt: at,
	});
	const link = await linkOf(deps, "A1");
	await deps.links.put(linkKey("products", "en", "A1"), {
		...link!,
		writtenRev: deps.content.revOf(e.id),
	});
}

type Shape = { name: string; plain: boolean; prepare: (deps: Deps, t: number) => Promise<void> };
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		const { deps } = setup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor's work" } });
		// As EmDash 1.2.0: staging a draft leaves updated_at alone.
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
````
with:
````ts
		const { deps } = setup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor's work" },
		});
		// As EmDash 1.2.0: staging a draft leaves updated_at alone.
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		// The job stages a draft, which leaves updatedAt before its journal row's time.
		const job = await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
		// The job stages a draft, which leaves updatedAt before its journal row's time.
		const job = await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await importRows(deps, [desk]);
		const a = await importRows(deps, [{ ...desk, price: 11 }]);
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor title" } });
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		const writtenByA = (await linkOf(deps, "A1"))?.writtenRev;
		expect((await rollBack(deps, a.id, { dryRun: true })).counters).toMatchObject({ conflict: 1 });
		const b = await importRows(deps, [{ ...desk, price: 12 }]);
````
with:
````ts
		await importRows(deps, [desk]);
		const a = await importRows(deps, [{ ...desk, price: 11 }]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor title" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const writtenByA = (await linkOf(deps, "A1"))?.writtenRev;
		expect((await rollBack(deps, a.id, { dryRun: true })).counters).toMatchObject({ conflict: 1 });
		const b = await importRows(deps, [{ ...desk, price: 12 }]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		deps.content.plainCollections.add("products");
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
````
with:
````ts
		deps.content.plainCollections.add("products");
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		// A crash before the link save, never resumed; then an editor stages a draft.
		await deps.links.delete(linkKey("products", "en", "A1"));
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
````
with:
````ts
		// A crash before the link save, never resumed; then an editor stages a draft.
		await deps.links.delete(linkKey("products", "en", "A1"));
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		expect(e.updatedAt).toBe(e.createdAt);
		const done = await rollBack(deps, job.id);
		const [row] = await records(deps, done.id);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await crash(deps, rollback.id, "crash before update");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.title).toBe("Editor");
````
with:
````ts
		await crash(deps, rollback.id, "crash before update");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.title).toBe("Editor");
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		deps.content.beforeStep = () => {};
		// Published with a draft, as step 1 left it, but at the editor's revision.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { price: 77 } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.price).toBe(77);
````
with:
````ts
		deps.content.beforeStep = () => {};
		// Published with a draft, as step 1 left it, but at the editor's revision.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { price: 77 } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.price).toBe(77);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		const stopped = await deps.records.get(recordKey(rollback.id, 0));
		expect(stopped).toMatchObject({
			status: "writing",
			writtenRev: String(entryOf(deps, "A1").rev),
		});
		expect(stopped).not.toHaveProperty("pendingStep");
		const done = await runToEnd(deps, rollback.id);
````
with:
````ts
		const stopped = await deps.records.get(recordKey(rollback.id, 0));
		expect(stopped).toMatchObject({
			status: "writing",
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
		expect(stopped).not.toHaveProperty("pendingStep");
		const done = await runToEnd(deps, rollback.id);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		deps.content.beforeStep = () => {};
		// Published without a draft, as step 2 would leave it, but with the editor's title.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
		deps.content.beforeStep = () => {};
		// Published without a draft, as step 2 would leave it, but with the editor's title.
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), taxonomies: { tag: ["sale"] } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
````
with:
````ts
		await crash(deps, rollback.id, "killed after update");
		deps.content.afterStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			taxonomies: { tag: ["sale"] },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		deps.content.beforeStep = () => {};
		// Published with the restored live values, but the editor's draft instead of the importer's.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { price: 55 } });
		expect(await deps.records.get(recordKey(rollback.id, 0))).toMatchObject({ pendingStep: 5 });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
````
with:
````ts
		deps.content.beforeStep = () => {};
		// Published with the restored live values, but the editor's draft instead of the importer's.
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { price: 55 } });
		expect(await deps.records.get(recordKey(rollback.id, 0))).toMatchObject({ pendingStep: 5 });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		deps.content.beforeStep = () => {};
		// The editor publishes step 1's values, then stages a draft of a field the import never wrote.
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { notes: "Editor" } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
````
with:
````ts
		deps.content.beforeStep = () => {};
		// The editor publishes step 1's values, then stages a draft of a field the import never wrote.
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { notes: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), slug: "editors-desk" });
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").slug).toBe("editors-desk");
````
with:
````ts
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), slug: "editors-desk" });
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").slug).toBe("editors-desk");
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
			await crash(deps, rollback.id, "killed after update");
			deps.content.afterStep = () => {};
			const e = entryOf(deps, "A1");
			await deps.content.update({ id: e.id, rev: String(e.rev), ...edit });
			const done = await runToEnd(deps, rollback.id);
			const row = (await records(deps, done.id)).find((r) => r.entryId === e.id);
			expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
			await crash(deps, rollback.id, "killed after update");
			deps.content.afterStep = () => {};
			const e = entryOf(deps, "A1");
			await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), ...edit });
			const done = await runToEnd(deps, rollback.id);
			const row = (await records(deps, done.id)).find((r) => r.entryId === e.id);
			expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		};
		await crash(deps, rollback.id, "killed after the unpublish");
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor's title" } });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
		};
		await crash(deps, rollback.id, "killed after the unpublish");
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor's title" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		const e = entryOf(deps, "A1");
		const w = await deps.content.update({
			id: e.id,
			rev: String(e.rev),
			data: { title: "Editor" },
		});
		if (!w.ok) throw new Error("the editor's write failed");
````
with:
````ts
		const e = entryOf(deps, "A1");
		const w = await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		if (!w.ok) throw new Error("the editor's write failed");
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		const { deps } = tickingSetup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor" } });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
````
with:
````ts
		const { deps } = tickingSetup();
		const job = await importRows(deps, [desk], { publish: false });
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(e.trashed).toBe(false);
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: String(e.rev) });
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { notes: "Editor" } });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
````
with:
````ts
		await crash(deps, rollback.id, "crash before publish");
		deps.content.beforeStep = () => {};
		const e = entryOf(deps, "A1");
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { notes: "Editor" },
		});
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ conflict: 1, reverted: 0 });
		expect(entryOf(deps, "A1").data.notes).toBe("Editor");
````

In `packages/flux-import/tests/unit/rollback.test.ts`, replace
````ts
		};
		await crash(deps, rollback.id, "killed after step 1");
		const e = entryOf(deps, "A1");
		await deps.content.update({ id: e.id, rev: String(e.rev), data: { title: "Editor draft" } });
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````
with:
````ts
		};
		await crash(deps, rollback.id, "killed after step 1");
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor draft" },
		});
		const done = await runToEnd(deps, rollback.id);
		const [row] = await records(deps, done.id);
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "rollback_changed" }] });
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/batch.test.ts tests/unit/content.test.ts tests/unit/fakes.test.ts tests/unit/journal.test.ts tests/unit/rollback.test.ts`
Expected: FAIL (5 files: `batch.test.ts`, `fakes.test.ts`, `journal.test.ts` and `rollback.test.ts` cannot load, because the fakes import `src/engine/revs.ts`, which does not exist yet; `content.test.ts` fails the 3 new schedule and unschedule tests and passes 24).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}

/** The codes EmDash's policy hooks refuse a publish, unpublish or schedule with (M5a). */
````
with:
````ts
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
	/** M5b: src/emdash-runtime.ts:4733 (no hook can refuse it, spec M5b F3). */
	handleContentUnschedule(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}

/** The codes EmDash's policy hooks refuse a publish, unpublish or schedule with (M5a). */
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
					options,
				);
				break;
		}
		const op = `Rolling back the entry (${input.step})`;
		if (!result.success) {
````
with:
````ts
					options,
				);
				break;
			case "unschedule":
				result = await this.runtime.handleContentUnschedule(collection, id, { _rev: rev });
				break;
		}
		const op = `Rolling back the entry (${input.step})`;
		if (!result.success) {
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
		return { ok: true, rev: snapshotOf(result.data, "Publishing the entry").rev };
	}

	ensureSourceIdField(collection: string): Promise<void> {
		return ensureSourceIdField(this.runtime.schemaRegistry, collection);
	}
````
with:
````ts
		return { ok: true, rev: snapshotOf(result.data, "Publishing the entry").rev };
	}

	async schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult> {
		if (await this.lockReader(input.collection, input.id, this.actor.id)) {
			return { ok: false, reason: "locked" };
		}
		const result = await this.runtime.handleContentSchedule(
			input.collection,
			input.id,
			input.scheduledAt,
			{ _rev: input.rev, actor: this.actor },
		);
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Scheduling the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Scheduling the entry").rev };
	}

	ensureSourceIdField(collection: string): Promise<void> {
		return ensureSourceIdField(this.runtime.schemaRegistry, collection);
	}
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
	| { ok: true; state: EntryState }
	| { ok: false; reason: "conflict" | "blocked" | "locked"; message: string };

/** The rollback's writes to a changed entry (spec M5a "Revert sequence"). */
export type RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule";

export interface ContentPort {
	get(
````
with:
````ts
	| { ok: true; state: EntryState }
	| { ok: false; reason: "conflict" | "blocked" | "locked"; message: string };

/**
 * The rollback's writes to a changed entry (spec M5a "Revert sequence"); M5b adds `unschedule`
 * (step 7), which no hook can refuse (spec M5b F3).
 */
export type RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule" | "unschedule";

export interface ContentPort {
	get(
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
		id: string;
		rev: string;
	}): Promise<WriteResult>;
	/**
	 * Idempotent. Creates `flux_source_id` as `string`, `indexed: true`, `translatable: false`; an
	 * existing field must be verified to be indexed.
````
with:
````ts
		id: string;
		rev: string;
	}): Promise<WriteResult>;
	/**
	 * Schedules the entry's content for `scheduledAt` (UTC ISO) at the given revision (M5b, spec
	 * F2): a draft becomes `scheduled`, a published entry stays `published` with its draft due.
	 * `version` is kept and `updated_at` moves, so the returned revision differs only there. Lock
	 * checked like `publish`; a hook's refusal (`emdash_schedule_rejected`), a time not in the
	 * future (`emdash_validation_error`) and other EmDash errors throw `ContentWriteError`.
	 */
	schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult>;
	/**
	 * Idempotent. Creates `flux_source_id` as `string`, `indexed: true`, `translatable: false`; an
	 * existing field must be verified to be indexed.
````

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
	permanentDelete(collection: string, id: string): Promise<boolean>;
	/**
	 * One rollback write with the entry's current `rev` (M5a): `update` (data, slug and links as
	 * in `update`), `publish`, `unpublish`, `discard` (the draft) or `schedule` (at `scheduledAt`).
	 */
	revertStep(
		input: {
````
with:
````ts
	permanentDelete(collection: string, id: string): Promise<boolean>;
	/**
	 * One rollback write with the entry's current `rev` (M5a): `update` (data, slug and links as
	 * in `update`), `publish`, `unpublish`, `discard` (the draft), `schedule` (at `scheduledAt`)
	 * or `unschedule` (M5b: clears the schedule; a no-op on an entry without one).
	 */
	revertStep(
		input: {
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
	unpublish: 15,
	discard: 10,
	schedule: 15,
};
/** Trash and permanent delete, which V7 did not measure: `COST_READ` x 5. */
const COST_DELETE = COST_READ * 5;
````
with:
````ts
	unpublish: 15,
	discard: 10,
	schedule: 15,
	// M5b step 7, costed as a schedule (spec M5b "Caps").
	unschedule: 15,
};
/** Trash and permanent delete, which V7 did not measure: `COST_READ` x 5. */
const COST_DELETE = COST_READ * 5;
````

Create `packages/flux-import/src/engine/revs.ts`:
````ts
/**
 * EmDash's `_rev` (spec M5b F1): base64 of `<version>:<updatedAt>` (`emdash` src/api/rev.ts:19-40).
 * EmDash fences every mutation on both parts. The importer decodes it only where the spec says
 * so (a resumed schedule, ownership after the scheduler), and fails closed when it cannot.
 */
export type DecodedRev = { version: number; updatedAt: string };

/** The `_rev` of a version and `updated_at`, as EmDash encodes it. */
export function encodeRev(version: number, updatedAt: string): string {
	return btoa(`${version}:${updatedAt}`);
}

/** The version and `updated_at` a `_rev` names; null when it is not one EmDash would write. */
export function decodeRev(rev: string): DecodedRev | null {
	let text: string;
	try {
		text = atob(rev);
	} catch {
		return null;
	}
	const colon = text.indexOf(":");
	if (colon === -1) return null;
	const version = Number(text.slice(0, colon));
	const updatedAt = text.slice(colon + 1);
	if (!Number.isInteger(version) || updatedAt === "" || Number.isNaN(Date.parse(updatedAt))) {
		return null;
	}
	return { version, updatedAt };
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/batch.test.ts tests/unit/content.test.ts tests/unit/fakes.test.ts tests/unit/journal.test.ts tests/unit/rollback.test.ts`
Expected: PASS (5 files, 189 tests). Full suite after this task: 64 files / 1,573 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/revs.ts packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/content.ts packages/flux-import/src/engine/revert.ts packages/flux-import/tests/unit
git commit -m "Add the schedule port and the unschedule revert step, and make the fakes encode revisions and schedule as EmDash does"
```

### Task 4: Early lookup, write modes, `updateFields` and fingerprint recording

**Files:**
- Create: `packages/flux-import/src/engine/rules.ts`
- Modify: `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/record-rules.test.ts`, `packages/flux-import/tests/unit/record-rules-translations.test.ts`, `packages/flux-import/tests/unit/journal.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Template.rules`, `mappingNames`, `LinkRow.fields`); Task 2 (`currentForms`, `sentForms`, `fingerprintsOf`); Task 3's fakes; `processRecord`, `decideRecord`, `writeRecord`, `finishUnchanged`, `putLink`, `RecordCtx`.
- Produces:
  - in `rules.ts`:
    - `ruled(t)`: the template has `rules` or `publishAt`;
    - `EXISTS_MESSAGE` and `NOT_FOUND_MESSAGE`, `modeSkip(t, entry, existing)`;
    - `narrowRecord(record, keep)`, `mappingOf(change, record)` and `sameFields(a, b)`;
  - in `batch.ts`:
    - for a ruled template, the early entry lookup, then the mode skip, then narrowing;
    - `RecordCtx.stored`, `.fields` and `.linkSaved`;
    - `putLink` carries `fields`, and `nextFields`, `refreshFields` and `entryByLink` are added.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/journal.test.ts`, replace
````ts
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = deps.content.revOf(entry.id);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
````
with:
````ts
		const first = await importRows(deps, [desk]);
		const entry = entryOf(deps, "A1");
		const rev = deps.content.revOf(entry.id);
		// The first job's fingerprints (M5b), which the snapshot keeps with the link.
		const fields = (await deps.links.get("products:en:A1"))?.fields;
		expect(Object.keys(fields ?? {}).sort()).toEqual([
			"bylines",
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"taxonomies.tag",
			"title",
		]);
		const second = await importRows(deps, [
			{ ...desk, name: "Table", price: 12, tags: "sale", authors: "sam" },
		]);
````

In `packages/flux-import/tests/unit/journal.test.ts`, replace
````ts
			kind: "update",
			entryId: entry.id,
			before: {
				link: { jobId: first.id, writtenRev: rev },
				// The entry is as the first job left it.
				rev,
				status: "published",
````
with:
````ts
			kind: "update",
			entryId: entry.id,
			before: {
				link: { jobId: first.id, writtenRev: rev, fields },
				// The entry is as the first job left it.
				rev,
				status: "published",
````

Create `packages/flux-import/tests/unit/record-rules-translations.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "flux_source_id", type: "string", translatable: false },
];
const english = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "Name", type: "text" } },
};
const french = (rules: Record<string, unknown>) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	fields: { title: { from: "Nom", type: "text" } },
	rules,
});

async function run(
	deps: Deps,
	template: unknown,
	csv: string,
): Promise<{ job: Job; rows: RecordRow[] }> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const created = await createJob(deps, {
		uploadId: upload,
		template,
		schemaFields,
		linkSchema: { targets: { products: schemaFields } },
	});
	let job = created;
	for (let i = 0; i < 100 && (job.status === "created" || job.status === "running"); i++) {
		job = await runBatch(deps, created.id, "driver");
	}
	const page = await deps.records.query({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
	return { job, rows: page.items.map((i) => i.data) };
}

describe("write modes on linked records (M5b, M4e)", () => {
	it("skips a linked record without an entry in update mode, before the source lookup", async () => {
		const { deps } = makeDeps();
		await run(deps, english, "id,Name\nE1,Desk\n");
		deps.content.calls.length = 0;
		const { rows } = await run(
			deps,
			french({ mode: "update" }),
			"id,en_id,Nom\nF1,E1,Bureau\nF2,E9,Lampe\n",
		);
		expect(rows.map((r) => [r.status, r.warnings?.map((w) => w.code)])).toEqual([
			["unchanged", ["not_found"]],
			["unchanged", ["not_found"]],
		]);
		// Neither the source nor its translations were read.
		expect(deps.content.calls).toEqual([]);
	});

	it("creates a translation in create mode, then skips it as existing", async () => {
		const { deps } = makeDeps();
		await run(deps, english, "id,Name\nE1,Desk\n");
		const first = await run(deps, french({ mode: "create" }), "id,en_id,Nom\nF1,E1,Bureau\n");
		expect(first.job.counters).toMatchObject({ created: 1 });
		deps.content.calls.length = 0;
		const second = await run(deps, french({ mode: "create" }), "id,en_id,Nom\nF1,E1,Table\n");
		expect(second.rows[0]).toMatchObject({ status: "unchanged", warnings: [{ code: "exists" }] });
		expect(deps.content.calls.some((c) => c.startsWith("translations:"))).toBe(false);
	});

	it("updates an existing translation in update mode as an upsert would", async () => {
		const { deps } = makeDeps();
		await run(deps, english, "id,Name\nE1,Desk\n");
		await run(deps, french({}), "id,en_id,Nom\nF1,E1,Bureau\n");
		const { rows } = await run(deps, french({ mode: "update" }), "id,en_id,Nom\nF1,E1,Table\n");
		expect(rows[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "title", after: "Table" }],
		});
	});
});
````

Create `packages/flux-import/tests/unit/record-rules.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import type { LinkRow } from "../../src/engine/types.js";
import {
	csv,
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	runToEnd,
	setup,
	start,
	termGroup,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const lamp: Row = { sku: "B2", name: "Lamp", price: 5, tags: "sale", authors: "sam" };
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const rules = (r: Record<string, unknown>) => ({ extra: { rules: r } });
/** A tag mapping that creates missing terms, so tests can see whether one was created. */
const creatingTags = { tag: { from: "Tags", separator: "|", create: true } };

describe("write modes (M5b)", () => {
	it("skips an existing entry in create mode and creates a new one", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = deps.content.revOf(entryOf(deps, "A1").id);
		deps.lookups.calls.length = 0;
		deps.content.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, price: 99 }, lamp], rules({ mode: "create" }));
		expect(job.counters).toMatchObject({ created: 1, unchanged: 1, updated: 0 });
		const [skipped, created] = await records(deps, job.id);
		expect(skipped).toMatchObject({
			status: "unchanged",
			entryId: entryOf(deps, "A1").id,
			warnings: [
				{
					code: "exists",
					message: "Skipped: the entry exists and the import only creates entries (mode create)",
				},
			],
		});
		expect(skipped).not.toHaveProperty("changes");
		expect(created).toMatchObject({ status: "created", action: "create" });
		expect(deps.content.revOf(entryOf(deps, "A1").id)).toBe(before);
		expect(entryOf(deps, "A1").data.price).toBe(10);
		// The skipped record looked nothing up: the lamp's terms and bylines only.
		expect(deps.content.calls.filter((c) => c.includes(entryOf(deps, "A1").id))).toEqual([]);
	});

	it("skips a record without an entry in update mode, before any lookup", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		deps.lookups.calls.length = 0;
		const job = await importRows(
			deps,
			[
				{ ...desk, price: 12 },
				{ ...lamp, tags: "brand-new", img: url("a.png") },
			],
			{ extra: { rules: { mode: "update" }, taxonomies: creatingTags } },
		);
		expect(job.counters).toMatchObject({ updated: 1, unchanged: 1, created: 0 });
		const [, skipped] = await records(deps, job.id);
		expect(skipped).toMatchObject({
			status: "unchanged",
			entryId: null,
			warnings: [
				{
					code: "not_found",
					message:
						"Skipped: no entry has this key and the import only updates entries (mode update)",
				},
			],
		});
		expect(deps.lookups.storedTerms.some((t) => t.slug === "brand-new")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.content.entries.size).toBe(1);
		expect(entryOf(deps, "A1").data.price).toBe(12);
	});

	it("creates the first of two records with one key and skips the second in create mode", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk, { ...desk, price: 20 }], rules({ mode: "create" }));
		expect(job.counters).toMatchObject({ created: 1, unchanged: 1 });
		expect((await records(deps, job.id))[1]?.warnings?.[0]?.code).toBe("exists");
		expect(entryOf(deps, "A1").data.price).toBe(10);
	});

	it("reports the same rows in a dry run, which plans a create for each duplicate key", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 99 }, lamp, lamp], {
			...rules({ mode: "create" }),
			dryRun: true,
		});
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.action, r.warnings?.[0]?.code])).toEqual([
			["planned", "unchanged", "exists"],
			["planned", "create", undefined],
			["planned", "create", undefined],
		]);
		expect(rows[0]).not.toHaveProperty("changes");
		expect(job.counters).toMatchObject({ unchanged: 1, created: 2 });
		const update = await importRows(deps, [lamp], { ...rules({ mode: "update" }), dryRun: true });
		expect((await records(deps, update.id))[0]).toMatchObject({
			status: "planned",
			action: "unchanged",
			warnings: [{ code: "not_found" }],
		});
	});

	it("finishes a resumed write in create mode rather than skipping it", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]), rules({ mode: "create" }));
		deps.content.beforePublish = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing" });
		deps.content.beforePublish = () => {};
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, unchanged: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published" });
	});

	it("retries a failed publish in create mode, which publishes the record's own draft", async () => {
		const { deps } = setup();
		deps.content.failPublish = () => "conflict";
		const job = await importRows(deps, [desk], rules({ mode: "create" }));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "publish_conflict" }],
		});
		deps.content.failPublish = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 1, conflict: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published" });
	});

	it("does not retry skipped rows", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [desk], rules({ mode: "create" }));
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ unchanged: 1 });
	});
});

describe("updateFields (M5b)", () => {
	it("compares and writes only the listed mappings of an update", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png"), related: "" }]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Editor" },
		});
		await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
		deps.mediaFetcher.calls.length = 0;
		deps.lookups.calls.length = 0;
		const job = await importRows(
			deps,
			[{ ...desk, name: "Desk 2", price: 12, img: url("b.png"), tags: "fresh", authors: "sam" }],
			{ extra: { rules: { updateFields: ["price"] }, taxonomies: creatingTags } },
		);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [{ field: "price", before: 10, after: 12 }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({
			slug: "desk",
			data: { title: "Editor", price: 12 },
			bylines: [{ bylineId: expect.any(String) }],
		});
		// Unlisted: no term created, no image downloaded, no byline lookup.
		expect(deps.lookups.storedTerms.some((t) => t.slug === "fresh")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines"))).toEqual([]);
	});

	it("writes every mapping on a create", async () => {
		const { deps } = setup();
		const job = await importRows(
			deps,
			[{ ...desk, img: url("a.png") }],
			rules({ updateFields: ["price"] }),
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({
			slug: "desk",
			data: { title: "Desk", price: 10, photo: { id: expect.any(String) } },
			taxonomies: { tag: ["new"] },
		});
	});

	it("compares every mapping of an entry crash repair found, which the job created", async () => {
		const { deps } = setup();
		const job = await start(deps, csv([desk]), {
			...rules({ updateFields: ["price"] }),
			publish: false,
		});
		deps.content.afterWrite = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterWrite = () => {};
		// The create landed and its link was never saved: crash repair finds the entry.
		expect(await deps.links.get("products:en:A1")).toBeNull();
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		// Every mapping was compared, not only the listed one.
		expect(Object.keys((await linkOf(deps, "A1")).fields ?? {}).sort()).toEqual([
			"bylines",
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"taxonomies.tag",
			"title",
		]);
	});

	it("keeps a translation's shared mappings and the unlisted ones out of the write", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(
			deps,
			[{ ...desk, name: "Desk 2", tags: "sale" }],
			rules({ updateFields: ["taxonomies.tag"] }),
		);
		expect((await records(deps, job.id))[0]?.changes?.map((c) => c.field)).toEqual([
			"taxonomies.tag",
		]);
		expect(entryOf(deps, "A1")).toMatchObject({ slug: "desk", data: { title: "Desk" } });
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
	});
});

describe("fingerprints on the link row (M5b)", () => {
	it("records one per mapping after a create, on a template without rules", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const { fields } = await linkOf(deps, "A1");
		expect(Object.keys(fields ?? {}).sort()).toEqual([
			"bylines",
			"featured",
			"photo",
			"price",
			"related",
			"slug",
			"taxonomies.tag",
			"title",
		]);
		for (const value of Object.values(fields ?? {})) expect(value).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});

	it("gives a written mapping a new fingerprint and keeps the others", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const first = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(deps, [{ ...desk, price: 12 }]);
		const second = (await linkOf(deps, "A1")).fields ?? {};
		expect(second.price).not.toBe(first.price);
		expect({ ...second, price: first.price }).toEqual(first);
	});

	it("keeps an unlisted mapping's fingerprint, and merges two templates sharing the key", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const first = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(
			deps,
			[{ ...desk, name: "Desk 2", price: 12 }],
			rules({ updateFields: ["price"] }),
		);
		const second = (await linkOf(deps, "A1")).fields ?? {};
		expect(second.title).toBe(first.title);
		expect(second.slug).toBe(first.slug);
		expect(second.price).not.toBe(first.price);
	});

	it("gives a mapping equal to the feed the fingerprint of the entry's value", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, featured: true }]);
		const e = entryOf(deps, "A1");
		// EmDash reads a boolean back as 1; the fingerprint is the same.
		e.data.featured = 1;
		const before = (await linkOf(deps, "A1")).fields ?? {};
		await importRows(deps, [{ ...desk, featured: true, price: 11 }]);
		expect((await linkOf(deps, "A1")).fields?.featured).toBe(before.featured);
	});

	it("refreshes a link saved before M5b once, keeping its revision and job", async () => {
		const { deps } = setup();
		const first = await importRows(deps, [desk]);
		const saved = await linkOf(deps, "A1");
		const { fields: _fields, ...old } = saved;
		await deps.links.put("products:en:A1", old);
		const puts: string[] = [];
		const put = deps.links.put.bind(deps.links);
		deps.links.put = async (id: string, row: LinkRow) => {
			puts.push(id);
			return put(id, row);
		};
		const job = await importRows(deps, [desk]);
		expect(job.counters).toMatchObject({ unchanged: 1 });
		expect(puts).toEqual(["products:en:A1"]);
		expect(await linkOf(deps, "A1")).toEqual({ ...old, jobId: first.id, fields: saved.fields });
		await importRows(deps, [desk]);
		expect(puts).toEqual(["products:en:A1"]);
	});

	it("writes nothing in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const saved = await linkOf(deps, "A1");
		const { fields: _fields, ...old } = saved;
		await deps.links.put("products:en:A1", old);
		await importRows(deps, [{ ...desk, price: 30 }], { dryRun: true });
		expect(await linkOf(deps, "A1")).toEqual(old);
	});

	it("fingerprints the terms the entry holds, so a term changed through the terms route differs", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = (await linkOf(deps, "A1")).fields ?? {};
		deps.content.setTerms(entryOf(deps, "A1").id, "tag", ["sale"]);
		await importRows(deps, [{ ...desk, tags: "sale" }]);
		const after = (await linkOf(deps, "A1")).fields ?? {};
		expect(after["taxonomies.tag"]).not.toBe(before["taxonomies.tag"]);
		expect(termGroup(deps, "sale")).toBeDefined();
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/journal.test.ts tests/unit/record-rules-translations.test.ts tests/unit/record-rules.test.ts`
Expected: FAIL (3 files; 15 tests failed, 29 passed: `record-rules.test.ts` 12 of 18, `record-rules-translations.test.ts` 2 of 3, and in `journal.test.ts` the update's link snapshot, which now holds `fields`).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	planRecord,
	type RecordPlan,
} from "./diff.js";
import {
	JobError,
	jobReader,
````
with:
````ts
	planRecord,
	type RecordPlan,
} from "./diff.js";
import { currentForms, fingerprintsOf, recordMappings, sentForms } from "./fingerprints.js";
import {
	JobError,
	jobReader,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	type MediaInfo,
	SourceMissingError,
````
with:
````ts
import {
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type MediaInfo,
	SourceMissingError,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import { originalProblem } from "./rollback.js";
import {
	applyTemplate,
	type CompiledTemplate,
````
with:
````ts
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import { originalProblem } from "./rollback.js";
import { mappingOf, modeSkip, narrowRecord, ruled, sameFields } from "./rules.js";
import {
	applyTemplate,
	type CompiledTemplate,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	linkId: string;
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
	/** The job may already have written the entry (see `JournalTarget.mayHaveWritten`). */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing` (see `JournalTarget.resuming`). */
````
with:
````ts
	linkId: string;
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
	/**
	 * The link row as stored once the entry is known: `link`, or the one crash repair saved (M5b,
	 * for the fingerprint refresh); null when there is none.
	 */
	stored: LinkRow | null;
	/** The fingerprints every link save of this record carries (M5b); absent in a dry run. */
	fields?: Record<string, string>;
	/** A link save of this record carried `fields` (M5b), so no refresh is needed. */
	linkSaved: boolean;
	/** The job may already have written the entry (see `JournalTarget.mayHaveWritten`). */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing` (see `JournalTarget.resuming`). */
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	};
}

/** Saves the link with the latest revision this importer produced for the entry. */
function putLink(ctx: RecordCtx, entryId: string, writtenRev: string): Promise<void> {
	const { collection, locale } = ctx.job.template;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
````
with:
````ts
	};
}

/**
 * Saves the link with the latest revision this importer produced for the entry, and the
 * record's fingerprints (M5b).
 */
function putLink(ctx: RecordCtx, entryId: string, writtenRev: string): Promise<void> {
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		entryId,
		writtenRev,
		jobId: ctx.job.id,
	});
}

async function publishRev(ctx: RecordCtx, id: string, rev: string) {
	const { collection, locale } = ctx.job.template;
	const published = await ctx.deps.content.publish({ collection, locale, id, rev });
````
with:
````ts
		entryId,
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
	});
}

/**
 * The fingerprints the record's link saves carry (spec M5b "When they are recorded"): each
 * mapping the record compared gets the fingerprint of the value it writes, or, when the entry
 * already holds the feed's value, of that value; `kept` mappings and the ones the record does not
 * carry (unlisted, a linked record's shared ones) keep the stored link's.
 */
async function nextFields(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	record: MappedRecord,
	plan: RecordPlan,
	links: LinkPlan | undefined,
	kept: ReadonlySet<string> = new Set(),
): Promise<Record<string, string>> {
	const comparisons = comparisonsOf(ctx.job.template, ctx.job.targetFields);
	const childSide = links?.childSide ?? new Set<string>();
	const changed = new Set(plan.changes.map((c) => mappingOf(c, record)));
	const sent = sentForms(record, comparisons, ctx.links, ctx.media, ctx.portableText, childSide);
	const held = entry
		? currentForms(entry, record, comparisons, links?.current ?? {}, childSide)
		: {};
	const forms: Record<string, unknown> = {};
	for (const name of recordMappings(record)) {
		if (kept.has(name)) continue;
		forms[name] = entry === null || changed.has(name) ? sent[name] : held[name];
	}
	return { ...(ctx.stored?.fields ?? {}), ...(await fingerprintsOf(forms)) };
}

/**
 * Saves a record's new fingerprints when it wrote no link (spec M5b "Refresh"): a link from
 * before M5b, or a protection that lifted. Revision, job and schedule stay, since ownership did
 * not change. Not journalled.
 */
async function refreshFields(ctx: RecordCtx): Promise<void> {
	const stored = ctx.stored;
	if (ctx.linkSaved || ctx.fields === undefined || stored === null) return;
	if (sameFields(stored.fields, ctx.fields)) return;
	await ctx.deps.links.put(ctx.linkId, { ...stored, fields: ctx.fields });
}

async function publishRev(ctx: RecordCtx, id: string, rev: string) {
	const { collection, locale } = ctx.job.template;
	const published = await ctx.deps.content.publish({ collection, locale, id, rev });
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	return { resolved, current, childSide };
}

/**
 * What a record found to create or download, and the warnings of its conversion and images,
 * listed on its row whatever happens to it.
````
with:
````ts
	return { resolved, current, childSide };
}

/** The link row, then the entry it names: the two reads every record makes (M5b: early). */
async function entryByLink(
	ctx: RecordCtx,
	cache: LookupCache,
	read: GetOptions,
	lookingUp: boolean,
): Promise<{ link: LinkRow | null; entry: EntrySnapshot | null }> {
	const { collection, locale } = ctx.job.template;
	const link = await ctx.deps.links.get(ctx.linkId);
	if (link && lookingUp) cache.spend(COST_READ);
	const entry = link ? await ctx.deps.content.get(collection, locale, link.entryId, read) : null;
	return { link, entry };
}

/**
 * What a record found to create or download, and the warnings of its conversion and images,
 * listed on its row whatever happens to it.
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		mayHaveWritten: false,
		resuming: false,
		save,
````
with:
````ts
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		stored: null,
		linkSaved: false,
		mayHaveWritten: false,
		resuming: false,
		save,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		const mediaRequests = mapped.value.media;
		const drafts = mapped.value.portableText;
		const hasImages = Object.values(drafts ?? {}).some((d) => d !== null && d.images.length > 0);
		// A template with translationOf looks entries up for every record (M4e).
		const translating = job.template.translationOf !== undefined;
		const lookingUp = requests !== undefined || translating;
		if (lookingUp || mediaRequests || hasImages) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
````
with:
````ts
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		// A template with translationOf looks entries up for every record (M4e).
		const translating = job.template.translationOf !== undefined;
		const lookingUp = mapped.value.links !== undefined || translating;
		const drafted = Object.values(mapped.value.portableText ?? {});
		if (lookingUp || mapped.value.media || drafted.some((d) => d !== null && d.images.length > 0)) {
			cache.spend(COST_RECORD);
		}
		// Reference selections are read only when the template maps reference fields.
		const read = { references: mapped.value.links?.references !== undefined };
		// M5b: with record rules the entry is looked up first, and the mode and the update scope
		// decided before any link, translation source or media is looked up.
		let early: { link: LinkRow | null; entry: EntrySnapshot | null } | null = null;
		let record = mapped.value;
		if (ruled(job.template)) {
			early = await entryByLink(ctx, cache, read, lookingUp);
			const skip = modeSkip(job.template, early.entry, existing);
			if (skip !== null) {
				found.warnings.push(skip);
				const id = early.entry?.id ?? null;
				return job.dryRun
					? { status: "planned", sourceKey, entryId: id, action: "unchanged" }
					: { status: "unchanged", sourceKey, entryId: id };
			}
			const listed = job.template.rules?.updateFields;
			if (early.entry !== null && listed !== undefined) {
				const names = new Set(listed);
				record = narrowRecord(record, (name) => names.has(name));
			}
		}
		const requests = record.links;
		const mediaRequests = record.media;
		const drafts = record.portableText;
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = mapped.value.translationOf;
		let source: { id: string; group: string } | null = null;
		if (translates !== undefined) {
			try {
````
with:
````ts
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = record.translationOf;
		let source: { id: string; group: string } | null = null;
		if (translates !== undefined) {
			try {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		if (link && lookingUp) cache.spend(COST_READ);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
````
with:
````ts
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) {
			return { status: "failed", sourceKey, entryId: early?.entry?.id ?? null, errors };
		}
		let { link, entry } = early ?? (await entryByLink(ctx, cache, read, lookingUp));
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		}
		// A repaired link is made up from the entry found: the pre-image records that none existed.
		ctx.link = repaired ? null : link;
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
````
with:
````ts
		}
		// A repaired link is made up from the entry found: the pre-image records that none existed.
		ctx.link = repaired ? null : link;
		ctx.stored = link;
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			}
		}
		const plan = withChange(
			planRecord(entry, mapped.value, comparisons, links, media, ctx.portableText),
			translationChange,
		);
		action = plan.action;
````
with:
````ts
			}
		}
		const plan = withChange(
			planRecord(entry, record, comparisons, links, media, ctx.portableText),
			translationChange,
		);
		action = plan.action;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
			if (plan.action === "unchanged")
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
````
with:
````ts
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
			if (plan.action === "unchanged") {
				ctx.fields = await nextFields(ctx, entry, record, plan, links);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups && misses.length === 0) return await writeRecord(ctx, entry, plan, mapped.value);
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
````
with:
````ts
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups && misses.length === 0) {
			ctx.fields = await nextFields(ctx, entry, record, plan, links);
			return await writeRecord(ctx, entry, plan, record);
		}
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			}
		}
		const final = withChange(
			planRecord(entry, mapped.value, comparisons, links, ctx.media, ctx.portableText),
			translationChange,
		);
		action = final.action;
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, mapped.value);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
````
with:
````ts
			}
		}
		const final = withChange(
			planRecord(entry, record, comparisons, links, ctx.media, ctx.portableText),
			translationChange,
		);
		action = final.action;
		ctx.fields = await nextFields(ctx, entry, record, final, links);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, record);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
			return { status: "updated", sourceKey, entryId, action: "update" };
		}
		return { status: "unchanged", sourceKey, entryId };
	}
	const action = existing?.action;
````
with:
````ts
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
			return { status: "updated", sourceKey, entryId, action: "update" };
		}
		await refreshFields(ctx);
		return { status: "unchanged", sourceKey, entryId };
	}
	const action = existing?.action;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev);
	}
	return {
		status: action === "create" ? "created" : "updated",
		sourceKey,
````
with:
````ts
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev);
	}
	await refreshFields(ctx);
	return {
		status: action === "create" ? "created" : "updated",
		sourceKey,
````

Create `packages/flux-import/src/engine/rules.ts`:
````ts
/**
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
 * is read, before any link, translation source or media lookup (spec M5b "Order of a record").
 */
export function ruled(t: Template): boolean {
	return t.rules !== undefined || t.publishAt !== undefined;
}

export const EXISTS_MESSAGE =
	"Skipped: the entry exists and the import only creates entries (mode create)";
export const NOT_FOUND_MESSAGE =
	"Skipped: no entry has this key and the import only updates entries (mode update)";

/**
 * The warning that skips a record under its write mode, or null when it goes on. `entry` is the
 * entry its link row names, read back. In `create` mode an entry the record's own earlier row was
 * writing, or names (a resumed or retried write), is finished as before, not skipped.
 */
export function modeSkip(
	t: Template,
	entry: EntrySnapshot | null,
	existing: RecordRow | null,
): RecordError | null {
	const mode = t.rules?.mode ?? "upsert";
	if (mode === "update" && entry === null) return { code: "not_found", message: NOT_FOUND_MESSAGE };
	if (mode !== "create" || entry === null) return null;
	const own = existing !== null && (existing.status === "writing" || existing.entryId === entry.id);
	return own ? null : { code: "exists", message: EXISTS_MESSAGE };
}

function pick<T>(
	values: Readonly<Record<string, T>>,
	keep: (name: string) => boolean,
	name: (key: string) => string = (key) => key,
): Record<string, T> {
	return Object.fromEntries(Object.entries(values).filter(([key]) => keep(name(key))));
}

/**
 * The record with only the mappings `keep` names (spec M5b "Only these fields"): an unlisted
 * mapping is then neither resolved, compared, written nor fingerprinted. The key, `translationOf`
 * and `publishAt` stay; a kind left without mappings is dropped.
 */
export function narrowRecord(record: MappedRecord, keep: (name: string) => boolean): MappedRecord {
	const out: MappedRecord = { key: record.key, data: pick(record.data, keep) };
	if (record.translationOf !== undefined) out.translationOf = record.translationOf;
	if (record.slug !== undefined && keep("slug")) out.slug = record.slug;
	if (record.publishAt !== undefined) out.publishAt = record.publishAt;
	const media = pick(record.media ?? {}, keep);
	if (Object.keys(media).length > 0) out.media = media;
	const portableText = pick(record.portableText ?? {}, keep);
	if (Object.keys(portableText).length > 0) out.portableText = portableText;
	const links: LinkRequests = {};
	const references = pick(record.links?.references ?? {}, keep);
	if (Object.keys(references).length > 0) links.references = references;
	const taxonomies = pick(record.links?.taxonomies ?? {}, keep, (name) => `taxonomies.${name}`);
	if (Object.keys(taxonomies).length > 0) links.taxonomies = taxonomies;
	if (record.links?.bylines !== undefined && keep("bylines")) links.bylines = record.links.bylines;
	if (Object.keys(links).length > 0) out.links = links;
	return out;
}

/**
 * The mapping a change belongs to: its field, with a media field's `.alt` folded into the field;
 * null for `translationOf` and `publishAt`, which are not mappings.
 */
export function mappingOf(change: Change, record: MappedRecord): string | null {
	const { field } = change;
	if (field === "translationOf" || field === "publishAt") return null;
	if (field.endsWith(".alt") && Object.hasOwn(record.media ?? {}, field.slice(0, -4))) {
		return field.slice(0, -4);
	}
	return field;
}

/** Whether two fingerprint maps hold the same names and values. */
export function sameFields(
	a: Readonly<Record<string, string>> | undefined,
	b: Readonly<Record<string, string>>,
): boolean {
	const left = a ?? {};
	const keys = Object.keys(b);
	return Object.keys(left).length === keys.length && keys.every((key) => left[key] === b[key]);
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/journal.test.ts tests/unit/record-rules-translations.test.ts tests/unit/record-rules.test.ts`
Expected: PASS (3 files, 44 tests). Full suite after this task: 66 files / 1,594 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/rules.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/record-rules.test.ts packages/flux-import/tests/unit/record-rules-translations.test.ts packages/flux-import/tests/unit/journal.test.ts
git commit -m "Apply write modes and updateFields after an early entry lookup, and keep each mapping's fingerprint on the link row"
```

### Task 5: Protection of edited mappings

**Files:**
- Modify: `packages/flux-import/src/engine/rules.ts`, `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/engine/resolve.ts`
- Test: `packages/flux-import/tests/unit/protection.test.ts`

**Interfaces:**
- Consumes: Task 4 (`rules.ts`, the early lookup, `ctx.fields`, `narrowRecord`); `ResolveContext`; `lookedUpMedia`; the Portable Text planning; `linkPlan`, `currentLinks`.
- Produces:
  - `ResolveContext.quiet?: boolean`: a quiet resolution creates no pending term;
  - `editedMappings(names, link, rev, current)` (Ruling 1);
  - `FIELD_EDITED_MESSAGE` and `protectPlan(plan, record, edited)`;
  - in `batch.ts`:
    - `MappedLinks`; `currentLinks` takes the mapped requests, and `linkPlan` the known current links;
    - `childSideOf`, `mergeLinks` and `unprotected`;
    - the record is split into an own part and a quiet part, and protected changes are removed from the plan and the write, with their fingerprints kept.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/protection.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { editedMappings, FIELD_EDITED_MESSAGE } from "../../src/engine/rules.js";
import type { LinkRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	setup,
	url,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const protect = { extra: { rules: { protectEdited: true } } };
const KEY = "products:en:A1";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;
const edited = (field: string) => ({ field, code: "field_edited", message: FIELD_EDITED_MESSAGE });

/** An editor's published change of the desk, through the same update and publish as REST. */
async function editDesk(
	deps: Deps,
	change: Parameters<Deps["content"]["update"]>[0] extends infer T ? Partial<T> : never,
) {
	const e = entryOf(deps, "A1");
	await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), ...change });
	await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
}

describe("which mappings count as edited (M5b)", () => {
	const link = (extra: Partial<LinkRow>): LinkRow => ({
		collection: "products",
		locale: "en",
		sourceKey: "A1",
		entryId: "e1",
		writtenRev: "r1",
		...extra,
	});
	const names = ["title", "price", "taxonomies.tag"];
	const now = { title: "T", price: "P", "taxonomies.tag": "G" };

	it("compares fingerprints, and trusts an unmoved revision for all but taxonomies", () => {
		const fields = { title: "T", price: "old", "taxonomies.tag": "old" };
		expect([...editedMappings(names, link({ fields }), "r1", now)]).toEqual(["taxonomies.tag"]);
		expect([...editedMappings(names, link({ fields }), "r2", now)]).toEqual([
			"price",
			"taxonomies.tag",
		]);
		const missing = { title: "T", "taxonomies.tag": "G" };
		expect([...editedMappings(names, link({ fields: missing }), "r1", now)]).toEqual(["price"]);
	});

	it("falls back on the revision for a link from before M5b, taxonomies always edited", () => {
		expect([...editedMappings(names, link({}), "r1", now)]).toEqual(["taxonomies.tag"]);
		expect([...editedMappings(names, link({}), "r2", now)]).toEqual(names);
		const { writtenRev: _w, ...repaired } = link({});
		expect([...editedMappings(names, repaired, "r1", now)]).toEqual(names);
	});
});

describe("never overwriting edits made outside the import (M5b)", () => {
	it("keeps an editor's published change of one field and updates the others", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor's desk" } });
		const job = await importRows(deps, [{ ...desk, name: "Desk 2", price: 12 }], protect);
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [
				{ field: "slug", after: "desk-2" },
				{ field: "price", before: 10, after: 12 },
			],
			warnings: [edited("title")],
		});
		expect(entryOf(deps, "A1").data).toMatchObject({ title: "Editor's desk", price: 12 });
		// Not journalled: a rollback never touches it.
		const [journal] = await journalOf(deps, job.id);
		expect(Object.keys(journal?.before?.live ?? {})).toEqual(["price"]);
	});

	it("protects a term changed through the terms route, which leaves the revision (F8)", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		deps.content.setTerms(entryOf(deps, "A1").id, "tag", ["sale"]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			changes: [{ field: "price" }],
			warnings: [edited("taxonomies.tag")],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["sale"]);
	});

	it("protects bylines an editor changed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const sam = deps.lookups.storedBylines.find((b) => b.slug === "sam")?.id ?? "";
		await editDesk(deps, { bylines: [{ bylineId: sam, roleLabel: null }] });
		const job = await importRows(deps, [desk], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("bylines")],
		});
		expect(entryOf(deps, "A1").bylines).toEqual([{ bylineId: sam, roleLabel: null }]);
	});

	it("resolves a protected mapping without side effects: no term created, no download", async () => {
		const { deps } = setup();
		await importRows(deps, [{ ...desk, img: url("a.png") }]);
		const e = entryOf(deps, "A1");
		await editDesk(deps, { data: { photo: { ...(e.data.photo as object), alt: "Editor's alt" } } });
		deps.content.setTerms(e.id, "tag", ["sale"]);
		deps.mediaFetcher.calls.length = 0;
		const job = await importRows(deps, [{ ...desk, img: url("b.png"), tags: "fresh" }], {
			extra: {
				rules: { protectEdited: true },
				taxonomies: { tag: { from: "Tags", separator: "|", create: true } },
			},
		});
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("photo"), edited("taxonomies.tag")],
		});
		expect(deps.lookups.storedTerms.some((t) => t.slug === "fresh")).toBe(false);
		expect(deps.mediaFetcher.urls()).toEqual([]);
	});

	it("lifts protection when the entry's value equals the feed again, refreshing its fingerprint", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const before = (await linkOf(deps)).fields ?? {};
		await editDesk(deps, { data: { title: "Desk 2" } });
		const job = await importRows(deps, [{ ...desk, name: "Desk 2" }], protect);
		const [row] = await records(deps, job.id);
		expect(row).not.toHaveProperty("warnings");
		expect(row?.changes?.map((c) => c.field)).toEqual(["slug"]);
		const after = (await linkOf(deps)).fields ?? {};
		expect(after.title).not.toBe(before.title);
		// The next run finds nothing edited.
		await editDesk(deps, { data: { price: 10 } });
		const again = await importRows(deps, [{ ...desk, name: "Desk 2" }], protect);
		expect((await records(deps, again.id))[0]).toMatchObject({ status: "unchanged" });
		expect((await records(deps, again.id))[0]).not.toHaveProperty("warnings");
	});

	it("lifts protection when a job without protectEdited writes the mapping", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		await importRows(deps, [desk]);
		expect(entryOf(deps, "A1").data.title).toBe("Desk");
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
	});

	it("leaves a record whose only differences are protected unchanged, and keeps their fingerprints", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		const before = (await linkOf(deps)).fields ?? {};
		const job = await importRows(deps, [desk], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("title")],
		});
		expect((await linkOf(deps)).fields?.title).toBe(before.title);
		expect(await journalOf(deps, job.id)).toEqual([]);
	});

	it("reports the same warning in a dry run and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await editDesk(deps, { data: { title: "Editor" } });
		const link = await linkOf(deps);
		const job = await importRows(deps, [{ ...desk, price: 12 }], { ...protect, dryRun: true });
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "planned",
			action: "update",
			changes: [{ field: "price" }],
			warnings: [edited("title")],
		});
		expect(await linkOf(deps)).toEqual(link);
		expect(entryOf(deps, "A1").data.price).toBe(10);
	});

	it("keeps the M2 rule: someone else's pending draft is still refused", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.update({
			id: e.id,
			rev: deps.content.revOf(e.id),
			data: { title: "Draft" },
		});
		const job = await importRows(deps, [{ ...desk, price: 12 }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "pending_draft" }],
		});
	});

	it("falls back on the revision for a link saved before M5b, and counts taxonomies as edited", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const { fields: _fields, ...old } = await linkOf(deps);
		await deps.links.put(KEY, old);
		const job = await importRows(deps, [{ ...desk, price: 12, tags: "sale" }], protect);
		expect((await records(deps, job.id))[0]).toMatchObject({
			changes: [{ field: "price" }],
			warnings: [edited("taxonomies.tag")],
		});
		expect(entryOf(deps, "A1").taxonomies.tag).toEqual(["new"]);
		// Equal taxonomies lift at once; an edit since the link counts every mapping as edited.
		const { fields: _f, ...bare } = await linkOf(deps);
		await deps.links.put(KEY, bare);
		await editDesk(deps, { data: { featured: true } });
		const next = await importRows(deps, [{ ...desk, name: "Desk 3", price: 12 }], protect);
		expect((await records(deps, next.id))[0]).toMatchObject({
			status: "unchanged",
			warnings: [edited("slug"), edited("title"), edited("featured")],
		});
	});

	it("does not take the slug staged in the importer's own draft for an edit", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await importRows(deps, [{ ...desk, name: "Desk 2" }], { ...protect, publish: false });
		expect(entryOf(deps, "A1").slug).toBe("desk-2");
		const job = await importRows(deps, [{ ...desk, name: "Desk 2", price: 11 }], {
			...protect,
			publish: false,
		});
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/protection.test.ts`
Expected: FAIL (1 file; 9 tests failed, 4 passed: `editedMappings` does not exist yet and nothing is protected; the 4 that pass expect what an unprotected job also does: the two lifting tests, the M2 pending-draft refusal and the importer's own staged slug).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import { originalProblem } from "./rollback.js";
import { mappingOf, modeSkip, narrowRecord, ruled, sameFields } from "./rules.js";
import {
	applyTemplate,
	type CompiledTemplate,
````
with:
````ts
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import { originalProblem } from "./rollback.js";
import {
	editedMappings,
	mappingOf,
	modeSkip,
	narrowRecord,
	protectPlan,
	ruled,
	sameFields,
} from "./rules.js";
import {
	applyTemplate,
	type CompiledTemplate,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	return published;
}

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
````
with:
````ts
	return published;
}

/** The links a record maps: resolved ones, or (M5b) the requests before resolution. */
type MappedLinks = {
	references?: Readonly<Record<string, unknown>>;
	taxonomies?: Readonly<Record<string, unknown>>;
	bylines?: unknown;
};

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: ResolvedLinks,
): Promise<CurrentLinks> {
	const current: CurrentLinks = {};
	if (resolved.references) {
````
with:
````ts
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: MappedLinks,
): Promise<CurrentLinks> {
	const current: CurrentLinks = {};
	if (resolved.references) {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			}));
		}
	}
	if (resolved.bylines) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/**
 * Whether the job's collection can be filtered by `flux_source_id`: a dry run does not add the
 * field, so it needs the collection to have it already (`sourceIdField`, read at job creation).
````
with:
````ts
			}));
		}
	}
	if (resolved.bylines !== undefined) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/** The reference fields on the child side of their relation, which keep no order. */
function childSideOf(job: Job, links: MappedLinks | undefined): Set<string> {
	return new Set(
		Object.keys(links?.references ?? {}).filter(
			(field) => job.targetFields?.[field]?.relationSide === "child",
		),
	);
}

/** Two resolutions of one record's links, as one (M5b: its unprotected and protected parts). */
function mergeLinks(a: ResolvedLinks | undefined, b: ResolvedLinks): ResolvedLinks {
	const merged: ResolvedLinks = { ...a };
	if (b.references) merged.references = { ...merged.references, ...b.references };
	if (b.taxonomies) merged.taxonomies = { ...merged.taxonomies, ...b.taxonomies };
	if (b.bylines !== undefined) merged.bylines = b.bylines;
	return merged;
}

/**
 * The record without its protected mappings (M5b), which are neither written nor journalled:
 * also taken out of the media and Portable Text values the write sends.
 */
function unprotected(ctx: RecordCtx, record: MappedRecord, names: ReadonlySet<string>) {
	if (names.size === 0) return record;
	for (const name of names) {
		if (ctx.media) delete ctx.media[name];
		if (ctx.portableText) delete ctx.portableText[name];
	}
	return narrowRecord(record, (name) => !names.has(name));
}

/**
 * Whether the job's collection can be filtered by `flux_source_id`: a dry run does not add the
 * field, so it needs the collection to have it already (`sourceIdField`, read at job creation).
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	return planned;
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
````
with:
````ts
	return planned;
}

/**
 * The link plan for `planRecord`; child-side reference fields compare as sets. `known` is the
 * entry's current links when the record already read them (M5b, protection).
 */
async function linkPlan(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	resolved: ResolvedLinks,
	known?: CurrentLinks,
): Promise<LinkPlan> {
	const childSide = childSideOf(job, resolved);
	const current = entry ? (known ?? (await currentLinks(deps, cache, job, entry, resolved))) : {};
	return { resolved, current, childSide };
}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
				record = narrowRecord(record, (name) => names.has(name));
			}
		}
		const requests = record.links;
		const mediaRequests = record.media;
		const drafts = record.portableText;
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
				deps,
				cache,
				{
					template: job.template,
					targets: job.targetFields ?? {},
					taxonomies: job.taxonomies ?? {},
					dryRun: job.dryRun,
					plannedKey: (key) => plannedKey(deps, job, cache, key, rec.seq),
					sourceIdReady: sourceIdReady(job),
				},
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (journaling(job)) noteCreated(job, resolution.newTerms);
			if (resolution.ok) ctx.links = resolution.links;
			else errors.push(...resolution.errors);
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = record.translationOf;
````
with:
````ts
				record = narrowRecord(record, (name) => names.has(name));
			}
		}
		// M5b: with protectEdited, the mappings edited since the import last wrote them are
		// resolved without side effects, and never written while they differ from the feed.
		let edited = new Set<string>();
		let known: CurrentLinks | undefined;
		if (early?.entry && early.link && job.template.rules?.protectEdited) {
			const { entry, link } = early;
			known = record.links ? await currentLinks(deps, cache, job, entry, record.links) : {};
			const comparisons = comparisonsOf(job.template, job.targetFields);
			const childSide = childSideOf(job, record.links);
			const forms = currentForms(entry, record, comparisons, known, childSide);
			const held = await fingerprintsOf(forms);
			edited = editedMappings(recordMappings(record), link, entry.rev, held);
		}
		const own = edited.size > 0 ? narrowRecord(record, (name) => !edited.has(name)) : record;
		const quiet = edited.size > 0 ? narrowRecord(record, (name) => edited.has(name)) : null;
		const requests = own.links;
		const mediaRequests = own.media;
		const drafts = own.portableText;
		const errors: { field: string; code: string; message: string }[] = [];
		const resolveContext = {
			template: job.template,
			targets: job.targetFields ?? {},
			taxonomies: job.taxonomies ?? {},
			dryRun: job.dryRun,
			plannedKey: (key: string) => plannedKey(deps, job, cache, key, rec.seq),
			sourceIdReady: sourceIdReady(job),
		};
		if (requests) {
			const resolution = await resolveLinks(deps, cache, resolveContext, requests);
			found.newTerms = resolution.newTerms;
			if (journaling(job)) noteCreated(job, resolution.newTerms);
			if (resolution.ok) ctx.links = resolution.links;
			else errors.push(...resolution.errors);
		}
		if (quiet?.links) {
			const context = { ...resolveContext, quiet: true };
			const resolution = await resolveLinks(deps, cache, context, quiet.links);
			if (resolution.ok) ctx.links = mergeLinks(ctx.links, resolution.links);
			else errors.push(...resolution.errors);
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = record.translationOf;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) {
			return { status: "failed", sourceKey, entryId: early?.entry?.id ?? null, errors };
		}
````
with:
````ts
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		// Protected media and images: looked up in the media map, never downloaded; a miss differs.
		let quietMedia: Record<string, MediaPlanItem | null> | undefined;
		if (quiet?.media) {
			const looked = await lookupRecordMedia(deps, cache, mediaContext(job, rec.seq), quiet.media);
			quietMedia = lookedUpMedia(looked.lookups, true, job.id);
			errors.push(...looked.errors);
		}
		let quietText: Record<string, PortableTextPlanItem | null> | undefined;
		if (quiet?.portableText) {
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				quiet.portableText,
				template.portableText,
			);
			quietText = portableTextPlan(quiet.portableText, looked.images);
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) {
			return { status: "failed", sourceKey, entryId: early?.entry?.id ?? null, errors };
		}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		ctx.stored = link;
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		if (links) ctx.current = links.current;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
		if (drafts && images) {
			ctx.portableText = portableTextPlan(drafts, images);
			const required = emptiedRequired(ctx.portableText, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, errors: required };
			}
		}
		const plan = withChange(
			planRecord(entry, record, comparisons, links, media, ctx.portableText),
			translationChange,
		);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
````
with:
````ts
		ctx.stored = link;
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links, known) : undefined;
		if (links) ctx.current = links.current;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media =
			lookups || quietMedia
				? { ...(lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : {}), ...quietMedia }
				: undefined;
		if (drafts && images) {
			const assembled = portableTextPlan(drafts, images);
			const required = emptiedRequired(assembled, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, errors: required };
			}
			ctx.portableText = { ...assembled, ...quietText };
		} else if (quietText) ctx.portableText = quietText;
		const guarded = protectPlan(
			planRecord(entry, record, comparisons, links, media, ctx.portableText),
			record,
			edited,
		);
		found.warnings.push(...guarded.warnings);
		const plan = withChange(guarded.plan, translationChange);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		}
		if (entry) {
			if (plan.action === "unchanged") {
				ctx.fields = await nextFields(ctx, entry, record, plan, links);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
````
with:
````ts
		}
		if (entry) {
			if (plan.action === "unchanged") {
				ctx.fields = await nextFields(ctx, entry, record, plan, links, guarded.protectedNames);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			}
		}
		if (!lookups && misses.length === 0) {
			ctx.fields = await nextFields(ctx, entry, record, plan, links);
			return await writeRecord(ctx, entry, plan, record);
		}
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
````
with:
````ts
			}
		}
		if (!lookups && misses.length === 0) {
			ctx.fields = await nextFields(ctx, entry, record, plan, links, guarded.protectedNames);
			const written = unprotected(ctx, record, guarded.protectedNames);
			return await writeRecord(ctx, entry, plan, written);
		}
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
					errors: obtained.errors,
				};
			}
			ctx.media = obtainedMedia(obtained.media);
		}
		if (drafts && images && misses.length > 0) {
			const obtained = await obtainPortableTextImages(
````
with:
````ts
					errors: obtained.errors,
				};
			}
			ctx.media = { ...obtainedMedia(obtained.media), ...quietMedia };
		}
		if (drafts && images && misses.length > 0) {
			const obtained = await obtainPortableTextImages(
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
					errors: obtained.errors,
				};
			}
			ctx.portableText = portableTextPlan(drafts, images);
			const required = emptiedRequired(ctx.portableText, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, action: plan.action, errors: required };
			}
		}
		const final = withChange(
			planRecord(entry, record, comparisons, links, ctx.media, ctx.portableText),
			translationChange,
		);
		action = final.action;
		ctx.fields = await nextFields(ctx, entry, record, final, links);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, record);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
````
with:
````ts
					errors: obtained.errors,
				};
			}
			const assembled = portableTextPlan(drafts, images);
			const required = emptiedRequired(assembled, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, action: plan.action, errors: required };
			}
			ctx.portableText = { ...assembled, ...quietText };
		}
		// Protected values were not downloaded, so they protect the same mappings as before.
		const kept = protectPlan(
			planRecord(entry, record, comparisons, links, ctx.media ?? media, ctx.portableText),
			record,
			edited,
		);
		const final = withChange(kept.plan, translationChange);
		action = final.action;
		ctx.fields = await nextFields(ctx, entry, record, final, links, kept.protectedNames);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, unprotected(ctx, record, kept.protectedNames));
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
````

In `packages/flux-import/src/engine/resolve.ts`, replace
````ts
	 * a lookup by source ID in the job's own collection would fail. Absent counts as ready.
	 */
	sourceIdReady?: boolean;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
````
with:
````ts
	 * a lookup by source ID in the job's own collection would fail. Absent counts as ready.
	 */
	sourceIdReady?: boolean;
	/**
	 * Resolve without side effects (M5b, protected mappings): terms are matched but none is
	 * created or planned, so a missing term stays `group: null` and always differs.
	 */
	quiet?: boolean;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
````

In `packages/flux-import/src/engine/resolve.ts`, replace
````ts
	if (errors.length > 0) return { ok: false, errors, newTerms: [] };

	const newTerms: string[] = [];
	for (const p of pending) {
		const items = resolved.taxonomies?.[p.taxonomy] as ResolvedItem[];
		const created = await createPath(
			deps,
````
with:
````ts
	if (errors.length > 0) return { ok: false, errors, newTerms: [] };

	const newTerms: string[] = [];
	for (const p of ctx.quiet ? [] : pending) {
		const items = resolved.taxonomies?.[p.taxonomy] as ResolvedItem[];
		const created = await createPath(
			deps,
````

In `packages/flux-import/src/engine/rules.ts`, replace
````ts
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
````
with:
````ts
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change, RecordPlan } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { LinkRow, RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
````

In `packages/flux-import/src/engine/rules.ts`, replace
````ts
	const keys = Object.keys(b);
	return Object.keys(left).length === keys.length && keys.every((key) => left[key] === b[key]);
}
````
with:
````ts
	const keys = Object.keys(b);
	return Object.keys(left).length === keys.length && keys.every((key) => left[key] === b[key]);
}

/**
 * The mappings that count as edited outside the import (spec M5b "Protection"), from the link row
 * and the fingerprints of the entry's current values. With fingerprints, a mapping counts as
 * edited when its fingerprint is missing or differs; but a mapping other than a taxonomy whose
 * entry is still at the link's `writtenRev` is not edited, since only term edits leave `_rev` (F8)
 * and the read cannot show a slug staged in the importer's own draft (F13). Without fingerprints
 * (a link from before M5b), taxonomies always count as edited, and the rest unless the entry is
 * still at `writtenRev`.
 */
export function editedMappings(
	names: readonly string[],
	link: LinkRow,
	rev: string,
	current: Readonly<Record<string, string>>,
): Set<string> {
	const unmoved = link.writtenRev !== undefined && link.writtenRev === rev;
	const edited = new Set<string>();
	for (const name of names) {
		const taxonomy = name.startsWith("taxonomies.");
		const stored = link.fields?.[name];
		if (link.fields === undefined) {
			if (taxonomy || !unmoved) edited.add(name);
		} else if (stored === undefined) edited.add(name);
		else if ((taxonomy || !unmoved) && stored !== current[name]) edited.add(name);
	}
	return edited;
}

export const FIELD_EDITED_MESSAGE =
	"Not updated: the value was changed outside the import since the import last wrote it";

/**
 * The plan without the changes of edited mappings, which are protected: not written, each named
 * by a `field_edited` warning. A plan left without changes is `unchanged`.
 */
export function protectPlan(
	plan: RecordPlan,
	record: MappedRecord,
	edited: ReadonlySet<string>,
): { plan: RecordPlan; protectedNames: Set<string>; warnings: RecordError[] } {
	const protectedNames = new Set<string>();
	const changes: Change[] = [];
	for (const change of plan.changes) {
		const name = mappingOf(change, record);
		if (name !== null && edited.has(name)) protectedNames.add(name);
		else changes.push(change);
	}
	const warnings = [...protectedNames].map((field) => ({
		field,
		code: "field_edited",
		message: FIELD_EDITED_MESSAGE,
	}));
	if (protectedNames.size === 0) return { plan, protectedNames, warnings };
	const action = plan.action === "update" && changes.length === 0 ? "unchanged" : plan.action;
	return { plan: { action, changes }, protectedNames, warnings };
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/protection.test.ts`
Expected: PASS (1 file, 13 tests). Full suite after this task: 67 files / 1,607 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/rules.ts packages/flux-import/src/engine/batch.ts packages/flux-import/src/engine/resolve.ts packages/flux-import/tests/unit/protection.test.ts
git commit -m "Keep values edited outside the import with protectEdited, resolving protected mappings without side effects"
```

### Task 6: Publish, draft or schedule

**Files:**
- Modify: `packages/flux-import/src/engine/rules.ts`, `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/schedule.test.ts`, `packages/flux-import/tests/unit/rollback-fixture.ts`

**Interfaces:**
- Consumes: Task 1 (`MappedRecord.publishAt`, `Job.revisions`); Task 3 (`ContentPort.schedule`, `decodeRev`, the fakes' schedule hooks); Task 5 (the protected plan); `finishUnchanged`, the pending-draft check, `putLink`.
- Produces:
  - in `rules.ts`:
    - `SCHEDULE_LEAD_MS = 60_000`;
    - `Target` and `targetOf(job, record, now)`;
    - `sameInstant(a, b)`;
    - `NOT_SCHEDULED_MESSAGE`;
    - `ownPending(entry, link)`, `schedulePlan(job, entry, link, plan, record, at)` and `scheduleLanded(entry, writtenRev, at)`;
  - in `batch.ts`:
    - `ctx.target` and `ctx.schedule`;
    - `putLink(…, scheduledAt)`, `scheduleRev` and `scheduleFailed` (`schedule_conflict`, `schedule_locked`);
    - the pending check includes a schedule (Ruling 7);
    - `finishUnchanged` publishes or schedules the importer's own pending state and adopts a landed schedule, or returns `schedule_unverified`;
  - in `rollback-fixture.ts`: `StartOptions.revisions` and `ticking(clock)`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/rollback-fixture.ts`, replace
````ts
	publish?: boolean;
	journal?: boolean;
	batchSize?: number;
	extra?: Record<string, unknown>;
};

export async function start(deps: Deps, body: string, opts: StartOptions = {}): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, body);
````
with:
````ts
	publish?: boolean;
	journal?: boolean;
	batchSize?: number;
	/** M5b: whether the collection keeps revisions, for templates that map publishAt. */
	revisions?: boolean;
	extra?: Record<string, unknown>;
};

/**
 * Makes the test clock move 3 ms on every read, so writes get distinct timestamps as they do in
 * EmDash; the fixed clock suits tests that compare times.
 */
export function ticking(clock: { t: number }): void {
	let t = clock.t;
	Object.defineProperty(clock, "t", {
		get: () => {
			t += 3;
			return t;
		},
		set: (v: number) => {
			t = v;
		},
	});
}

export async function start(deps: Deps, body: string, opts: StartOptions = {}): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, body);
````

Create `packages/flux-import/tests/unit/schedule.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { decodeRev } from "../../src/engine/revs.js";
import { NOT_SCHEDULED_MESSAGE, SCHEDULE_LEAD_MS } from "../../src/engine/rules.js";
import type { LinkRow } from "../../src/engine/types.js";
import {
	csv,
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	runToEnd,
	type StartOptions,
	setup,
	start,
	ticking,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const KEY = "products:en:A1";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;
/** A time `ms` after the test clock's start. */
const T0 = Date.parse("2026-10-07T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const HOUR = 3_600_000;
const scheduleAt = (time: string, opts: StartOptions = {}): StartOptions => ({
	...opts,
	extra: { ...opts.extra, publishAt: { expr: `'${time}'` } },
});
const later = (deps: Deps) => deps.content.calls.filter((c) => c.startsWith("schedule:"));

describe("publishAt: publish now or schedule (M5b)", () => {
	it("creates and schedules a record whose time is ahead, and saves the schedule's revision", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({ status: "created", action: "create" });
		expect(row?.changes?.at(-1)).toEqual({ field: "publishAt", before: null, after: at(HOUR) });
		const e = entryOf(deps, "A1");
		expect(e).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			jobId: job.id,
			scheduledAt: at(HOUR),
		});
		expect(deps.content.calls).not.toContain(`publish:${e.id}`);
	});

	it("publishes now for an empty, past or near time", async () => {
		for (const time of ["", at(-HOUR), at(SCHEDULE_LEAD_MS - 1)]) {
			const { deps } = setup();
			const job = await importRows(deps, [desk], scheduleAt(time));
			const [row] = await records(deps, job.id);
			expect(row?.changes?.map((c) => c.field)).not.toContain("publishAt");
			expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
		}
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(SCHEDULE_LEAD_MS)));
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled" });
	});

	it("updates a published entry, staging a draft, and schedules it", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "updated",
			changes: [
				{ field: "price", before: 10, after: 12 },
				{ field: "publishAt", before: null, after: at(HOUR) },
			],
		});
		expect(await deps.content.get("products", "en", entryOf(deps, "A1").id)).toMatchObject({
			status: "published",
			hasDraft: true,
			scheduledAt: at(HOUR),
			live: { price: 10 },
		});
	});

	it("warns not_scheduled for a published entry whose update goes live at once", async () => {
		const { deps } = setup();
		deps.content.plainCollections.add("products");
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], {
			...scheduleAt(at(HOUR)),
			revisions: false,
		});
		const [row] = await records(deps, job.id);
		expect(row).toMatchObject({
			status: "updated",
			changes: [{ field: "price" }],
			warnings: [{ code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
		expect(later(deps)).toEqual([]);
		// Terms and bylines are live on a collection with revisions too.
		const { deps: other } = setup();
		await importRows(other, [desk]);
		const links = await importRows(other, [{ ...desk, tags: "sale" }], scheduleAt(at(HOUR)));
		expect((await records(other, links.id))[0]?.warnings?.[0]?.code).toBe("not_scheduled");
		expect(later(other)).toEqual([]);
	});

	it("leaves a published entry without a draft unchanged when nothing changed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "unchanged" });
		expect(later(deps)).toEqual([]);
	});

	it("schedules the importer's own draft when nothing else changed, journalling it", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toEqual(
			expect.objectContaining({
				status: "updated",
				action: "update",
				changes: [{ field: "publishAt", before: null, after: at(HOUR) }],
			}),
		);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		const [journal] = await journalOf(deps, job.id);
		expect(journal).toMatchObject({
			kind: "update",
			before: { status: "draft", scheduledAt: null },
		});
	});

	it("reschedules the importer's own schedule, and keeps it when the time is the same", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const same = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, same.id))[0]).toMatchObject({ status: "unchanged" });
		const moved = await importRows(deps, [desk], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, moved.id))[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "publishAt", before: at(HOUR), after: at(2 * HOUR) }],
		});
		// An update keeps the schedule, so the same time needs no second call.
		deps.content.calls.length = 0;
		const updated = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, updated.id))[0]?.changes?.map((c) => c.field)).toEqual(["price"]);
		expect(later(deps)).toEqual([]);
		expect(await linkOf(deps)).toMatchObject({ scheduledAt: at(2 * HOUR) });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(2 * HOUR) });
	});

	it("publishes the importer's own schedule now when the time has passed", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const job = await importRows(deps, [desk], scheduleAt(at(-HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "updated" });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("refuses an entry someone else scheduled, as a pending state", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		await importRows(deps, [desk]);
		const e = entryOf(deps, "A1");
		await deps.content.schedule({
			collection: "products",
			locale: "en",
			id: e.id,
			rev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "pending_draft" }],
		});
		expect(entryOf(deps, "A1")).toMatchObject({ scheduledAt: at(HOUR) });
	});

	it("keeps the importer's earlier schedule with publish: false (F7)", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		await importRows(deps, [{ ...desk, price: 12 }], { publish: false });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		expect(await linkOf(deps)).toMatchObject({ scheduledAt: at(HOUR) });
	});

	it("saves as a draft with schedule_conflict or schedule_locked", async () => {
		for (const [reason, change] of [
			["conflict", (deps: Deps, id: string) => deps.content.entries.get(id)!.rev++],
			["locked", (deps: Deps, id: string) => deps.content.locked.add(id)],
		] as const) {
			const { deps } = setup();
			deps.content.beforeSchedule = (id) => {
				change(deps, id);
			};
			const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
			expect((await records(deps, job.id))[0]).toMatchObject({
				status: reason,
				action: "create",
				errors: [{ code: `schedule_${reason}` }],
			});
			expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		}
	});

	it("fails the record on a hook's refusal after the write, and a retry schedules its draft", async () => {
		const { deps } = setup();
		deps.content.blockStep = (step) => (step === "schedule" ? "Not on Fridays" : null);
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "emdash_schedule_rejected" }],
		});
		deps.content.blockStep = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ updated: 1, failed: 0 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("adopts a schedule that landed before a stop, by the revision's version and time", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.afterSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterSchedule = () => {};
		const row = (await records(deps, job.id))[0];
		const e = entryOf(deps, "A1");
		expect(row).toMatchObject({ status: "writing" });
		const wrote = decodeRev(row?.writtenRev ?? "");
		const now = decodeRev(deps.content.revOf(e.id));
		expect(now?.version).toBe(wrote?.version);
		expect(now?.updatedAt).not.toBe(wrote?.updatedAt);
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		expect(await linkOf(deps)).toMatchObject({
			writtenRev: deps.content.revOf(e.id),
			scheduledAt: at(HOUR),
		});
		expect(later(deps)).toHaveLength(1);
	});

	it("reports schedule_unverified when the entry moved by a version after the stop", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.afterSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.afterSchedule = () => {};
		const e = entryOf(deps, "A1");
		// A field the template does not map: the record's data is unchanged, the version is not.
		await deps.content.update({ id: e.id, rev: deps.content.revOf(e.id), data: { notes: "Ed" } });
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		await runToEnd(deps, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({
			status: "conflict",
			errors: [{ code: "schedule_unverified" }],
		});
	});

	it("schedules again after a stop before the schedule call", async () => {
		const { deps, clock } = setup();
		ticking(clock);
		const job = await start(deps, csv([desk]), scheduleAt(at(HOUR)));
		deps.content.beforeSchedule = () => {
			throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "w1")).rejects.toThrow("crash");
		deps.content.beforeSchedule = () => {};
		const leased = (await deps.jobs.get(job.id)) as NonNullable<
			Awaited<ReturnType<Deps["jobs"]["get"]>>
		>;
		await deps.jobs.put(job.id, { ...leased, lease: null });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1 });
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
	});

	it("plans the same in a dry run and writes nothing", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk, { ...desk, sku: "B2" }], {
			...scheduleAt(at(HOUR)),
			dryRun: true,
		});
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.action, r.changes?.at(-1)?.field])).toEqual([
			["planned", "update", "publishAt"],
			["planned", "create", "publishAt"],
		]);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("finds the entry the scheduler published as any published entry", async () => {
		const { deps, clock } = setup();
		await importRows(
			deps,
			[desk],
			scheduleAt(at(HOUR), { extra: { rules: { protectEdited: true } } }),
		);
		const fields = (await linkOf(deps)).fields;
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([entryOf(deps, "A1").id]);
		const job = await importRows(
			deps,
			[desk],
			scheduleAt(at(2 * HOUR), { extra: { rules: { protectEdited: true } } }),
		);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "unchanged" });
		expect((await records(deps, job.id))[0]).not.toHaveProperty("warnings");
		expect((await linkOf(deps)).fields).toEqual(fields);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/schedule.test.ts`
Expected: FAIL (1 file; 16 tests failed, 1 passed: `publishAt` is read but nothing schedules; only "leaves a published entry without a draft unchanged when nothing changed" passes).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	mappingOf,
	modeSkip,
	narrowRecord,
	protectPlan,
	ruled,
	sameFields,
} from "./rules.js";
import {
	applyTemplate,
````
with:
````ts
	mappingOf,
	modeSkip,
	narrowRecord,
	ownPending,
	protectPlan,
	ruled,
	sameFields,
	sameInstant,
	scheduleLanded,
	schedulePlan,
	type Target,
	targetOf,
} from "./rules.js";
import {
	applyTemplate,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	fields?: Record<string, string>;
	/** A link save of this record carried `fields` (M5b), so no refresh is needed. */
	linkSaved: boolean;
	/** The job may already have written the entry (see `JournalTarget.mayHaveWritten`). */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing` (see `JournalTarget.resuming`). */
````
with:
````ts
	fields?: Record<string, string>;
	/** A link save of this record carried `fields` (M5b), so no refresh is needed. */
	linkSaved: boolean;
	/** When the record's content goes live (M5b). */
	target: Target;
	/** The schedule the record makes, as its `publishAt` change (M5b); absent when none. */
	schedule?: Change;
	/** The job may already have written the entry (see `JournalTarget.mayHaveWritten`). */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing` (see `JournalTarget.resuming`). */
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
}

/**
 * Saves the link with the latest revision this importer produced for the entry, and the
 * record's fingerprints (M5b).
 */
function putLink(ctx: RecordCtx, entryId: string, writtenRev: string): Promise<void> {
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	return ctx.deps.links.put(ctx.linkId, {
````
with:
````ts
}

/**
 * Saves the link with the latest revision this importer produced for the entry, the record's
 * fingerprints, and the schedule the entry has at that revision (M5b).
 */
function putLink(
	ctx: RecordCtx,
	entryId: string,
	writtenRev: string,
	scheduledAt: string | null = null,
): Promise<void> {
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	return ctx.deps.links.put(ctx.linkId, {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
	});
}

/**
 * The fingerprints the record's link saves carry (spec M5b "When they are recorded"): each
 * mapping the record compared gets the fingerprint of the value it writes, or, when the entry
````
with:
````ts
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
		...(scheduledAt === null ? {} : { scheduledAt }),
	});
}

/** Schedules the revision the record wrote (M5b) and saves the link with the schedule's. */
async function scheduleRev(ctx: RecordCtx, id: string, rev: string, at: string) {
	const { collection, locale } = ctx.job.template;
	const scheduled = await ctx.deps.content.schedule({
		collection,
		locale,
		id,
		rev,
		scheduledAt: at,
	});
	if (scheduled.ok) await putLink(ctx, id, scheduled.rev, at);
	return scheduled;
}

function scheduleFailed(
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: RecordRow["action"],
	writtenRev: string | undefined,
): RowFields {
	return {
		status: reason,
		sourceKey,
		entryId: id,
		...(action ? { action } : {}),
		...(writtenRev === undefined ? {} : { writtenRev }),
		errors: [
			{
				code: `schedule_${reason}`,
				message:
					reason === "locked"
						? "Saved as a draft: the entry is locked, so it was not scheduled"
						: "Saved as a draft: the entry changed before it could be scheduled",
			},
		],
	};
}

/**
 * The fingerprints the record's link saves carry (spec M5b "When they are recorded"): each
 * mapping the record compared gets the fingerprint of the value it writes, or, when the entry
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		link: null,
		stored: null,
		linkSaved: false,
		mayHaveWritten: false,
		resuming: false,
		save,
````
with:
````ts
		link: null,
		stored: null,
		linkSaved: false,
		target: targetOf(job, mapped.value, deps.now()),
		mayHaveWritten: false,
		resuming: false,
		save,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		found.warnings.push(...guarded.warnings);
		const plan = withChange(guarded.plan, translationChange);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
````
with:
````ts
		found.warnings.push(...guarded.warnings);
		const plan = withChange(guarded.plan, translationChange);
		action = plan.action;
		// M5b: the schedule this plan makes, or why an update cannot be scheduled.
		const target = ctx.target;
		const scheduled =
			target.kind === "at" ? schedulePlan(job, entry, link, plan, record, target.at) : null;
		if (scheduled !== null && "warning" in scheduled) found.warnings.push(scheduled.warning);
		if (scheduled !== null && "change" in scheduled) ctx.schedule = scheduled.change;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
			for (const [url, { field }] of misses) {
				if (!listed.has(url)) found.newMedia.push(`${field}: ${url}`);
			}
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
			if (plan.action === "unchanged") {
				ctx.fields = await nextFields(ctx, entry, record, plan, links, guarded.protectedNames);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
					"conflict",
````
with:
````ts
			for (const [url, { field }] of misses) {
				if (!listed.has(url)) found.newMedia.push(`${field}: ${url}`);
			}
			const schedule = ctx.schedule;
			return {
				status: "planned",
				sourceKey,
				entryId,
				action: schedule && plan.action === "unchanged" ? "update" : plan.action,
				changes: schedule ? [...plan.changes, schedule] : plan.changes,
			};
		}
		if (entry) {
			if (plan.action === "unchanged") {
				ctx.fields = await nextFields(ctx, entry, record, plan, links, guarded.protectedNames);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			// A schedule someone else set is pending too (M5b): a publish would clear it.
			const pending = entry.pendingPublish || entry.scheduledAt !== null;
			if (pending && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
					"conflict",
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		);
		const final = withChange(kept.plan, translationChange);
		action = final.action;
		ctx.fields = await nextFields(ctx, entry, record, final, links, kept.protectedNames);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
````
with:
````ts
		);
		const final = withChange(kept.plan, translationChange);
		action = final.action;
		if (target.kind === "at") {
			const again = schedulePlan(job, entry, link, final, record, target.at);
			if (again !== null && "change" in again) ctx.schedule = again.change;
			else delete ctx.schedule;
		}
		ctx.fields = await nextFields(ctx, entry, record, final, links, kept.protectedNames);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		.map(([field]) => ({ field, code: "required", message: "The field is required" }));
}

/** The entry already holds the mapped data: finish an unfinished write or publish our own draft. */
async function finishUnchanged(
	ctx: RecordCtx,
	entry: EntrySnapshot,
````
with:
````ts
		.map(([field]) => ({ field, code: "required", message: "The field is required" }));
}

/**
 * The entry already holds the mapped data: finish an unfinished write, or publish or schedule
 * the importer's own pending state (M5b: schedule it when the record's target is a time).
 */
async function finishUnchanged(
	ctx: RecordCtx,
	entry: EntrySnapshot,
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some((e) => e.code.startsWith("publish_"))));
	if (!unfinished) {
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
with:
````ts
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey, target } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some(
					(e) => e.code.startsWith("publish_") || e.code.startsWith("schedule_"),
				)));
	if (!unfinished) {
		// A pending state at the revision this importer last produced is its own (an earlier
		// `publish: false` run, a failed publish, or a schedule), so publishing or scheduling it puts
		// no one else's work live.
		if (job.publish && ownPending(entry, link)) {
			if (target.kind === "at" && ctx.schedule === undefined) {
				await refreshFields(ctx);
				return { status: "unchanged", sourceKey, entryId };
			}
			// Publishing makes the draft's values live: the journal keeps the live ones first.
			const failure = journaling(job) ? await journalPublish(ctx, entry, link) : null;
			if (failure) return { status: "failed", sourceKey, entryId, errors: [failure] };
			if (target.kind === "at" && ctx.schedule !== undefined) {
				const scheduled = await scheduleRev(ctx, entryId, entry.rev, target.at);
				if (!scheduled.ok)
					return scheduleFailed(scheduled.reason, sourceKey, entryId, "update", entry.rev);
				return {
					status: "updated",
					sourceKey,
					entryId,
					action: "update",
					changes: [ctx.schedule],
				};
			}
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	// version-derived, so a different entry (an editor's copy) can carry the same string.
	const proven =
		writtenRev !== undefined && existing?.entryId === entry.id && entry.rev === writtenRev;
	if (job.publish && entry.pendingPublish) {
		// Publish only the exact revision this job wrote; anything newer may be an editor's draft.
		if (!proven) {
			return {
````
with:
````ts
	// version-derived, so a different entry (an editor's copy) can carry the same string.
	const proven =
		writtenRev !== undefined && existing?.entryId === entry.id && entry.rev === writtenRev;
	if (job.publish && entry.pendingPublish && target.kind === "at") {
		const at = target.at;
		// A schedule this record sent may have landed before the stop: the same version as the
		// write's, a later updated_at, and the time asked for (spec M5b "Crash repair").
		const landed =
			writtenRev !== undefined &&
			existing?.entryId === entry.id &&
			scheduleLanded(entry, writtenRev, at);
		if (landed || (proven && sameInstant(entry.scheduledAt, at))) {
			await putLink(ctx, entryId, entry.rev, at);
		} else if (proven) {
			const scheduled = await scheduleRev(ctx, entryId, entry.rev, at);
			if (!scheduled.ok)
				return scheduleFailed(scheduled.reason, sourceKey, entryId, action, writtenRev);
		} else {
			return {
				status: "conflict",
				sourceKey,
				entryId,
				...(action ? { action } : {}),
				...(writtenRev === undefined ? {} : { writtenRev }),
				errors: [
					{
						code: "schedule_unverified",
						message:
							"Saved as a draft and maybe scheduled: the entry may have changed after the import wrote it, so it was not verified",
					},
				],
			};
		}
	} else if (job.publish && entry.pendingPublish) {
		// Publish only the exact revision this job wrote; anything newer may be an editor's draft.
		if (!proven) {
			return {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	} else if (!job.publish && proven && link?.writtenRev !== writtenRev) {
		// The crash came between saving the written revision and saving the link: the draft is
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev);
	}
	await refreshFields(ctx);
	return {
````
with:
````ts
	} else if (!job.publish && proven && link?.writtenRev !== writtenRev) {
		// The crash came between saving the written revision and saving the link: the draft is
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev, entry.scheduledAt);
	}
	await refreshFields(ctx);
	return {
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
		action: plan.action,
		writtenRev: written.rev,
	});
	await putLink(ctx, written.id, written.rev);
	if (job.publish) {
		const published = await publishRev(ctx, written.id, written.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, written.id, plan.action, written.rev);
	}
	return {
		status: plan.action === "create" ? "created" : "updated",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		changes: plan.changes,
	};
}
````
with:
````ts
		action: plan.action,
		writtenRev: written.rev,
	});
	// An update keeps the entry's schedule (spec M5b F7), which the link records with the revision.
	await putLink(ctx, written.id, written.rev, entry?.scheduledAt ?? null);
	if (ctx.target.kind === "now") {
		const published = await publishRev(ctx, written.id, written.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, written.id, plan.action, written.rev);
	} else if (ctx.target.kind === "at" && ctx.schedule !== undefined) {
		const scheduled = await scheduleRev(ctx, written.id, written.rev, ctx.target.at);
		if (!scheduled.ok)
			return scheduleFailed(scheduled.reason, sourceKey, written.id, plan.action, written.rev);
	}
	return {
		status: plan.action === "create" ? "created" : "updated",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		changes: ctx.schedule ? [...plan.changes, ctx.schedule] : plan.changes,
	};
}
````

In `packages/flux-import/src/engine/rules.ts`, replace
````ts
import type { Change, RecordPlan } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { LinkRow, RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
````
with:
````ts
import type { Change, RecordPlan } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import { decodeRev } from "./revs.js";
import type { MappedRecord, Template } from "./template.js";
import type { Job, LinkRow, RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
````

In `packages/flux-import/src/engine/rules.ts`, replace
````ts
	const action = plan.action === "update" && changes.length === 0 ? "unchanged" : plan.action;
	return { plan: { action, changes }, protectedNames, warnings };
}
````
with:
````ts
	const action = plan.action === "update" && changes.length === 0 ? "unchanged" : plan.action;
	return { plan: { action, changes }, protectedNames, warnings };
}

/**
 * How far ahead a `publishAt` time must be to schedule (spec M5b "Bounded work"): EmDash refuses
 * a time that is not after its own clock (F2), and this absorbs the time between the record's
 * read and the schedule call. A nearer, past or empty time publishes now.
 */
export const SCHEDULE_LEAD_MS = 60_000;

/** When the record's content goes live: kept as a draft, published now, or scheduled at a time. */
export type Target = { kind: "draft" } | { kind: "now" } | { kind: "at"; at: string };

/** The record's target (spec M5b "Publish, draft or schedule"). */
export function targetOf(job: Job, record: MappedRecord, now: number): Target {
	if (!job.publish) return { kind: "draft" };
	const at = record.publishAt;
	if (at === undefined || at === null || Date.parse(at) - now < SCHEDULE_LEAD_MS) {
		return { kind: "now" };
	}
	return { kind: "at", at };
}

/** Whether two times name the same instant; null names none. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
	if (a === null || a === undefined || b === null || b === undefined) return a === b;
	return Date.parse(a) === Date.parse(b);
}

export const NOT_SCHEDULED_MESSAGE =
	"Not scheduled: the update went live at once (the collection keeps no revisions, or only terms and bylines changed)";

/**
 * Whether the importer's own pending state is what the entry shows (M2): a draft, a schedule or
 * a published entry's draft at the revision the link records.
 */
export function ownPending(entry: EntrySnapshot, link: LinkRow | null): boolean {
	return (entry.pendingPublish || entry.scheduledAt !== null) && link?.writtenRev === entry.rev;
}

/**
 * The schedule a record makes for target `at` (spec M5b decision table), as the change it adds
 * (`publishAt`, from the entry's schedule to `at`); or the `not_scheduled` warning when an update
 * of a published entry goes live at once; or nothing when the entry is already scheduled for
 * exactly `at` (an update keeps the schedule), when nothing is pending, or when the pending state
 * is someone else's.
 */
export function schedulePlan(
	job: Job,
	entry: EntrySnapshot | null,
	link: LinkRow | null,
	plan: RecordPlan,
	record: MappedRecord,
	at: string,
): { change: Change } | { warning: RecordError } | null {
	const change = { field: "publishAt", before: entry?.scheduledAt ?? null, after: at };
	if (entry === null) return { change };
	if (sameInstant(entry.scheduledAt, at)) return null;
	if (plan.action === "unchanged") return ownPending(entry, link) ? { change } : null;
	// Data, slug and references stage a draft on a collection with revisions (F7); terms and
	// bylines are written live.
	const stages =
		job.revisions !== false &&
		plan.changes.some((c) => {
			const name = mappingOf(c, record);
			return name !== null && name !== "bylines" && !name.startsWith("taxonomies.");
		});
	if (entry.status === "published" && !entry.hasDraft && !stages) {
		return { warning: { code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE } };
	}
	return { change };
}

/**
 * Whether a resumed record's entry shows the schedule it was writing (spec M5b "Crash repair"):
 * the same version as the revision it wrote, with a later `updated_at` (a schedule moves only
 * that, F2), scheduled for `at`. False when either revision cannot be decoded.
 */
export function scheduleLanded(entry: EntrySnapshot, writtenRev: string, at: string): boolean {
	const now = decodeRev(entry.rev);
	const wrote = decodeRev(writtenRev);
	if (now === null || wrote === null) return false;
	return (
		now.version === wrote.version &&
		Date.parse(now.updatedAt) > Date.parse(wrote.updatedAt) &&
		sameInstant(entry.scheduledAt, at)
	);
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/schedule.test.ts`
Expected: PASS (1 file, 17 tests). Full suite after this task: 68 files / 1,624 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/rules.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/schedule.test.ts packages/flux-import/tests/unit/rollback-fixture.ts
git commit -m "Schedule each record at its publishAt time, publish it now when the time is past, and adopt a schedule a stop cut off"
```

### Task 7: Rollback step 7 and ownership after the scheduler

**Files:**
- Modify: `packages/flux-import/src/engine/revert.ts`
- Test: `packages/flux-import/tests/unit/rollback-schedule.test.ts`

**Interfaces:**
- Consumes: Task 3 (`decodeRev`, the `unschedule` step, `runScheduled` in the fakes); Task 6 (scheduling imports and the link's `scheduledAt`); the M5a revert sequence (`owned`, `reached`, the step list, the link hand-back).
- Produces:
  - `sweptSince(entry, link)`, exported (Ruling 9); `owned` also accepts a non-trashed entry that it passes;
  - step 7 runs `unschedule` when the state keeps a schedule that `before.scheduledAt` lacks, or one that has passed;
  - `reached(7)` holds when `scheduledAt` is null;
  - the restored link carries `before.link.fields` and `before.link.scheduledAt` (Ruling 10).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/rollback-schedule.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import type { EntrySnapshot } from "../../src/engine/ports.js";
import { sweptSince } from "../../src/engine/revert.js";
import { encodeRev } from "../../src/engine/revs.js";
import { createRollback } from "../../src/engine/rollback.js";
import type { Job, LinkRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	runToEnd,
	type StartOptions,
	setup,
	ticking,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const KEY = "products:en:A1";
const T0 = Date.parse("2026-10-07T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const HOUR = 3_600_000;
const scheduleAt = (time: string, opts: StartOptions = {}): StartOptions => ({
	...opts,
	extra: { ...opts.extra, publishAt: { expr: `'${time}'` } },
});
const count = (deps: Deps, call: string) => deps.content.calls.filter((c) => c === call).length;

async function rollBack(deps: Deps, id: string, opts: { dryRun?: boolean } = {}): Promise<Job> {
	const { rollback } = await createRollback(deps, { id, ...opts });
	return runToEnd(deps, rollback.id);
}

function setupTicking() {
	const made = setup();
	ticking(made.clock);
	return made;
}

describe("ownership after the scheduler (M5b)", () => {
	const link = (extra: Partial<LinkRow> = {}): LinkRow => ({
		collection: "products",
		locale: "en",
		sourceKey: "A1",
		entryId: "e1",
		writtenRev: encodeRev(3, at(0)),
		scheduledAt: at(HOUR),
		...extra,
	});
	const entry = (version: number, updatedAt: string, extra: Partial<EntrySnapshot> = {}) => ({
		id: "e1",
		rev: encodeRev(version, updatedAt),
		slug: null,
		data: {},
		pendingPublish: false,
		status: "published",
		scheduledAt: null,
		hasDraft: false,
		...extra,
	});

	it("takes exactly the scheduler's publish: one version, published, at or after the time", () => {
		expect(sweptSince(entry(4, at(HOUR)), link())).toBe(true);
		expect(sweptSince(entry(4, at(HOUR + 5)), link())).toBe(true);
		// An editor's publish before the time, one more version, a draft or a schedule left.
		expect(sweptSince(entry(4, at(HOUR - 1)), link())).toBe(false);
		expect(sweptSince(entry(5, at(HOUR)), link())).toBe(false);
		expect(sweptSince(entry(4, at(HOUR), { hasDraft: true }), link())).toBe(false);
		expect(sweptSince(entry(4, at(HOUR), { status: "draft" }), link())).toBe(false);
		expect(sweptSince(entry(4, at(HOUR), { scheduledAt: at(2 * HOUR) }), link())).toBe(false);
		// Without a recorded schedule, or with a revision that is not EmDash's, never.
		const { scheduledAt: _s, ...unscheduled } = link();
		expect(sweptSince(entry(4, at(HOUR)), unscheduled)).toBe(false);
		expect(sweptSince(entry(4, at(HOUR)), link({ writtenRev: "3" }))).toBe(false);
		expect(sweptSince({ ...entry(4, at(HOUR)), rev: "garbage" }, link())).toBe(false);
	});

	it("deletes a created entry the scheduler published", async () => {
		const { deps, clock } = setupTicking();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		clock.t = T0 + HOUR;
		expect(deps.content.runScheduled()).toEqual([id]);
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(deps.content.entries.has(id)).toBe(false);
	});

	it("restores an updated entry the scheduler published, from the published state", async () => {
		const { deps, clock } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		clock.t = T0 + HOUR;
		deps.content.runScheduled();
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", data: { price: 12 } });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		expect(await deps.content.get("products", "en", entryOf(deps, "A1").id)).toMatchObject({
			status: "published",
			hasDraft: false,
			scheduledAt: null,
			data: { price: 10 },
		});
	});

	it("refuses an entry an editor published before the time, or changed after the scheduler", async () => {
		for (const edit of ["publish early", "edit after"] as const) {
			const { deps, clock } = setupTicking();
			const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
			const e = entryOf(deps, "A1");
			if (edit === "publish early") {
				await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
			} else {
				clock.t = T0 + HOUR;
				deps.content.runScheduled();
				await deps.content.update({
					id: e.id,
					rev: deps.content.revOf(e.id),
					data: { notes: "x" },
				});
			}
			const done = await rollBack(deps, job.id);
			expect(done.counters, edit).toMatchObject({ conflict: 1, reverted: 0 });
			expect((await records(deps, done.id))[0]?.errors?.[0]?.code).toBe("rollback_changed");
			expect(deps.content.entries.has(e.id)).toBe(true);
		}
	});
});

describe("rollback step 7, unschedule (M5b)", () => {
	it("deletes a created and scheduled entry, which the scheduler then never publishes", async () => {
		const { deps } = setupTicking();
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const id = entryOf(deps, "A1").id;
		await rollBack(deps, job.id);
		expect(deps.content.entries.has(id)).toBe(false);
	});

	it("unschedules the importer's own draft it scheduled, leaving it a draft", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled" });
		const done = await rollBack(deps, job.id);
		expect(done.counters).toMatchObject({ reverted: 1 });
		const id = entryOf(deps, "A1").id;
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
		expect(count(deps, `unschedule:${id}`)).toBe(1);
	});

	it("needs no unschedule when the publish of step 2 cleared the schedule", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk]);
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(HOUR)));
		await rollBack(deps, job.id);
		const id = entryOf(deps, "A1").id;
		expect(count(deps, `unschedule:${id}`)).toBe(0);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "published", scheduledAt: null });
	});

	it("puts an earlier schedule back with step 6, and unschedules one that has passed", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const job = await importRows(deps, [desk], scheduleAt(at(3 * HOUR)));
		expect(entryOf(deps, "A1")).toMatchObject({ scheduledAt: at(3 * HOUR) });
		const dry = await rollBack(deps, job.id, { dryRun: true });
		expect((await records(deps, dry.id))[0]?.changes).toEqual([
			{ field: "scheduledAt", before: at(3 * HOUR), after: at(HOUR) },
		]);
		await rollBack(deps, job.id);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "scheduled", scheduledAt: at(HOUR) });
		// Again, once the first time has passed: the entry is left a draft without a schedule.
		const { deps: other, clock: otherClock } = setupTicking();
		await importRows(other, [desk], scheduleAt(at(HOUR)));
		const second = await importRows(other, [desk], scheduleAt(at(3 * HOUR)));
		otherClock.t = T0 + 2 * HOUR;
		const done = await rollBack(other, second.id);
		expect((await records(other, done.id))[0]?.warnings?.map((w) => w.code)).toEqual([
			"rollback_schedule_passed",
		]);
		expect(entryOf(other, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("adopts an unschedule that reached EmDash before the stop, without repeating it", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], { publish: false });
		const job = await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const { rollback } = await createRollback(deps, { id: job.id });
		const id = entryOf(deps, "A1").id;
		deps.content.afterStep = (step) => {
			if (step === "unschedule") throw new Error("stop");
		};
		await expect(runBatch(deps, rollback.id, "driver")).rejects.toThrow("stop");
		deps.content.afterStep = () => {};
		const stopped = (await deps.jobs.get(rollback.id)) as Job;
		await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		const done = await runToEnd(deps, rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0 });
		expect(count(deps, `unschedule:${id}`)).toBe(1);
		expect(entryOf(deps, "A1")).toMatchObject({ status: "draft", scheduledAt: null });
	});

	it("hands the link back with its fingerprints and schedule", async () => {
		const { deps } = setupTicking();
		await importRows(deps, [desk], scheduleAt(at(HOUR)));
		const first = (await deps.links.get(KEY)) as LinkRow;
		const job = await importRows(deps, [{ ...desk, price: 12 }], scheduleAt(at(2 * HOUR)));
		expect((await deps.links.get(KEY))?.fields?.price).not.toBe(first.fields?.price);
		await rollBack(deps, job.id);
		const back = (await deps.links.get(KEY)) as LinkRow;
		expect(back).toMatchObject({
			jobId: first.jobId,
			fields: first.fields,
			scheduledAt: at(HOUR),
			writtenRev: deps.content.revOf(entryOf(deps, "A1").id),
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rollback-schedule.test.ts`
Expected: FAIL (1 file; 7 tests failed, 3 passed: `sweptSince` does not exist, step 7 does not run and the link comes back without `fields` and `scheduledAt`; the 3 that pass are M5a behaviour: a refusal, the delete of a scheduled create, and no unschedule after step 2's publish).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
	loadTerms,
	termOfGroup,
} from "./resolve.js";
import { restoredData, sameStored } from "./rollback-values.js";
import { SOURCE_ID_FIELD } from "./template.js";
import {
````
with:
````ts
	loadTerms,
	termOfGroup,
} from "./resolve.js";
import { decodeRev } from "./revs.js";
import { restoredData, sameStored } from "./rollback-values.js";
import { SOURCE_ID_FIELD } from "./template.js";
import {
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts

type Found = EntrySnapshot & { trashed: boolean };

/** Step 1 of "Per row": the entry by ID (active first, then in Trash), or a create's by source ID. */
async function findEntry(ctx: RowCtx): Promise<{ entry: Found; adopted: boolean } | null> {
	const { deps, journal, existing } = ctx;
````
with:
````ts

type Found = EntrySnapshot & { trashed: boolean };

/**
 * Whether EmDash's scheduler published the entry since the import scheduled it, and nothing else
 * changed it (spec M5b "Ownership after the scheduler"): the link records a schedule; the entry is
 * exactly one version past the link's revision (a schedule keeps the version, the publish adds
 * one, any edit another, F6); it is published with no draft and no schedule; and it was updated
 * at or after the scheduled time (an editor's publish before it fails). Revisions that cannot be
 * decoded fail closed.
 */
export function sweptSince(entry: EntrySnapshot, link: LinkRow): boolean {
	if (link.scheduledAt === undefined || link.writtenRev === undefined) return false;
	const now = decodeRev(entry.rev);
	const wrote = decodeRev(link.writtenRev);
	if (now === null || wrote === null || now.version !== wrote.version + 1) return false;
	return (
		entry.status === "published" &&
		!entry.hasDraft &&
		entry.scheduledAt === null &&
		Date.parse(now.updatedAt) >= Date.parse(link.scheduledAt)
	);
}

/** Step 1 of "Per row": the entry by ID (active first, then in Trash), or a create's by source ID. */
async function findEntry(ctx: RowCtx): Promise<{ entry: Found; adopted: boolean } | null> {
	const { deps, journal, existing } = ctx;
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	const owned =
		link !== null &&
		link.jobId === job.rollbackOf &&
		link.entryId === entry.id &&
		link.writtenRev === entry.rev;
	// A create made after the write-ahead row and never changed since (spec M5a V3): found by
	// source ID after a crash, or one whose link was never saved. A link that names the entry and a
	// revision settles it: EmDash keeps `updated_at` when an edit only stages a draft
````
with:
````ts
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	// M5b: also an entry the import scheduled and EmDash's scheduler published since.
	const owned =
		link !== null &&
		link.jobId === job.rollbackOf &&
		link.entryId === entry.id &&
		(link.writtenRev === entry.rev || (!entry.trashed && sweptSince(entry, link)));
	// A create made after the write-ahead row and never changed since (spec M5a V3): found by
	// source ID after a crash, or one whose link was never saved. A link that names the entry and a
	// revision settles it: EmDash keeps `updated_at` when an edit only stages a draft
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
 * Whether the entry shows what revert steps 1 to `step` would have left it with (spec M5a "Per
 * row", resuming). Cumulative, so an editor's change made after the stop is never adopted: every
 * step needs step 1's result (the restored live values, the slug the read shows, the references,
 * bylines and terms), steps 5 and 6 also the restored draft values, and each step its own
 * result: 2 published without a draft, 3 not published, 4 no draft, 6 the schedule.
 */
async function reached(
	ctx: RowCtx,
````
with:
````ts
 * Whether the entry shows what revert steps 1 to `step` would have left it with (spec M5a "Per
 * row", resuming). Cumulative, so an editor's change made after the stop is never adopted: every
 * step needs step 1's result (the restored live values, the slug the read shows, the references,
 * bylines and terms), steps 5 to 7 also the restored draft values, and each step its own
 * result: 2 published without a draft, 3 not published, 4 no draft, 6 the schedule, 7 (M5b) no
 * schedule.
 */
async function reached(
	ctx: RowCtx,
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
				entry.scheduledAt !== null &&
				Date.parse(entry.scheduledAt) === Date.parse(before.scheduledAt)
			);
		default:
			return false;
	}
````
with:
````ts
				entry.scheduledAt !== null &&
				Date.parse(entry.scheduledAt) === Date.parse(before.scheduledAt)
			);
		case 7:
			return entry.scheduledAt === null;
		default:
			return false;
	}
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts

/**
 * "Revert sequence": 1 restore the live values, slug and links; 2 publish; 3 unpublish; 4 discard
 * the draft the entry did not have; 5 restore the draft; 6 schedule. Each step is chosen from the
 * entry's state after the previous one and saved with the revision it returned, so a resumed row
 * skips the steps done and re-derives the rest.
 */
async function restoreChanged(
	ctx: RowCtx,
````
with:
````ts

/**
 * "Revert sequence": 1 restore the live values, slug and links; 2 publish; 3 unpublish; 4 discard
 * the draft the entry did not have; 5 restore the draft; 6 schedule; 7 unschedule (M5b: a
 * schedule the entry did not have, or one that has passed). Each step is chosen from the entry's
 * state after the previous one and saved with the revision it returned, so a resumed row skips
 * the steps done and re-derives the rest.
 */
async function restoreChanged(
	ctx: RowCtx,
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
			const same = state.scheduledAt !== null && Date.parse(state.scheduledAt) === Date.parse(at);
			return same ? null : run(6, { step: "schedule", scheduledAt: at });
		},
	];
	for (const [i, next] of steps.entries()) {
		const failed = await next();
````
with:
````ts
			const same = state.scheduledAt !== null && Date.parse(state.scheduledAt) === Date.parse(at);
			return same ? null : run(6, { step: "schedule", scheduledAt: at });
		},
		// Step 2's publish already cleared a schedule (F4); step 6 excludes this one.
		async () =>
			state.scheduledAt !== null && (before.scheduledAt === null || passed.length > 0)
				? run(7, { step: "unschedule" })
				: null,
	];
	for (const [i, next] of steps.entries()) {
		const failed = await next();
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
		if (failed.reason === "locked") {
			return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
		}
		const name = ["update", "publish", "unpublish", "discard", "update", "schedule"][i];
		return rowOf(ctx, "failed", {
			errors: [
				issue(
````
with:
````ts
		if (failed.reason === "locked") {
			return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
		}
		const names = ["update", "publish", "unpublish", "discard", "update", "schedule", "unschedule"];
		const name = names[i];
		return rowOf(ctx, "failed", {
			errors: [
				issue(
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
								: before.link.writtenRev,
					}),
			...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
		});
	}
	return rowOf(ctx, "reverted");
````
with:
````ts
								: before.link.writtenRev,
					}),
			...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
			// M5b: the fingerprints and schedule the link had before the job.
			...(before.link.fields === undefined ? {} : { fields: before.link.fields }),
			...(before.link.scheduledAt === undefined ? {} : { scheduledAt: before.link.scheduledAt }),
		});
	}
	return rowOf(ctx, "reverted");
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/rollback-schedule.test.ts`
Expected: PASS (1 file, 10 tests). Full suite after this task: 69 files / 1,634 tests.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/revert.ts packages/flux-import/tests/unit/rollback-schedule.test.ts
git commit -m "Unschedule in rollbacks, own entries the scheduler published, and hand links back with their fingerprints"
```

### Task 8: Node integration on `sites/dev`

**Files:**
- Create: `sites/dev/src/pages/test/run-scheduled.ts`, `sites/dev-cf/src/pages/test/run-scheduled.ts`, `packages/flux-import/tests/integration/record-rules.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1-7, through the plugin routes `jobs/create`, `jobs/next`, `jobs/get`, `jobs/records` and `jobs/rollback`;
  - the test helpers: `Client`, `devBypass`, `startServer`, `stopServer`, `withDb`, `productsCsv`, `template` and the translation fixtures;
  - the REST routes: `POST /_emdash/api/schema/collections` (with and without `revisions`), `PUT /_emdash/api/content/{c}/{id}`, `POST /_emdash/api/content/{c}/{id}/publish`, `POST /_emdash/api/content/{c}/{id}/terms/{taxonomy}`, `POST /_emdash/api/taxonomies/{t}/terms` and `POST /_emdash/api/admin/bylines`;
  - `runScheduledTasks` from `emdash/middleware` (Fact E1).
- Produces: the dev-only route `POST /test/run-scheduled` on both test sites (403 outside `astro dev`), and the Node proof of the spec's integration list (Ruling 12).

- [ ] **Step 1: Add the dev-only sweep route to both test sites**

Create `sites/dev-cf/src/pages/test/run-scheduled.ts`:
````ts
import type { APIRoute } from "astro";
import { runScheduledTasks } from "emdash/middleware";

export const prerender = false;

/**
 * Dev only: runs EmDash's scheduled maintenance now (`emdash/middleware` `runScheduledTasks`), what
 * the Worker's `scheduled()` handler does on a Cron Trigger, which `astro dev` never fires.
 */
export const POST: APIRoute = async () => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	const { published } = await runScheduledTasks();
	return Response.json({ published });
};
````

Create `sites/dev/src/pages/test/run-scheduled.ts`:
````ts
import type { APIRoute } from "astro";
import { runScheduledTasks } from "emdash/middleware";

export const prerender = false;

/**
 * Dev only: runs EmDash's scheduled maintenance now (`emdash/middleware` `runScheduledTasks`), so
 * the integration tests publish due entries without waiting up to a minute for the Node timer.
 */
export const POST: APIRoute = async () => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	const { published } = await runScheduledTasks();
	return Response.json({ published });
};
````

- [ ] **Step 2: Write the tests**

Create `packages/flux-import/tests/integration/record-rules.test.ts`:
````ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
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
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

// The M5a rollback suite's port: suites run one at a time, and this one kills its own server.
const PORT = 4391;
const TAG = "it_rr_tag";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;
const terms: Record<string, string> = {};
const bylines: Record<string, string> = {};

const KINDS = [
	["revisioned", "it_rr_rev", true],
	["plain", "it_rr_plain", false],
] as const;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

async function createSchema(collection: string, revisions: boolean): Promise<void> {
	await client.api("POST", "/_emdash/api/schema/collections", {
		slug: collection,
		label: collection,
		supports: revisions ? ["drafts", "revisions"] : ["drafts"],
		editLocking: true,
	});
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "price", label: "Price", type: "number" },
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

function rulesTemplate(collection: string, extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "id" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
		},
		taxonomies: { [TAG]: { from: "Tags", separator: "|" } },
		bylines: { from: "Authors", match: "slug", separator: ";" },
		...extra,
	};
}

type Row = { id: string; name: string; price: number; tags?: string; authors?: string };

function csv(rows: Row[]): string {
	const lines = rows.map((r) =>
		[
			r.id,
			`${r.id}-${r.name}`.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.price,
			r.tags ?? "new",
			r.authors ?? "it-rr-alex",
		].join(","),
	);
	return ["id,Handle,Name,Price,Tags,Authors", ...lines, ""].join("\n");
}

async function importCsv(
	body: string,
	jobTemplate: object,
	opts: { publish?: boolean; dryRun?: boolean; batchSize?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(body);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: opts.batchSize ?? 10,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function rollBack(id: string): Promise<{ job: Job; rows: RecordRow[] }> {
	const created = await client.plugin("jobs/rollback", { id, batchSize: 10 });
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function entryId(collection: string, key: string): Promise<string> {
	const entry = (await byKey(collection)).get(key);
	if (!entry) throw new Error(`No entry for ${collection}/${key}`);
	return entry.id;
}

/** The entry as EmDash reads it back: status, schedule, draft, data, terms and bylines. */
async function stateOf(collection: string, id: string) {
	const { item } = await client.api<{ item: Product & { scheduledAt?: string | null } }>(
		"GET",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
	);
	return {
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		hasDraft: item.draftRevisionId !== null,
		title: item.data.title,
		price: item.data.price,
		tags: (await client.entryTerms(collection, id, TAG)).sort(),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
	};
}

/**
 * An editor's change through the content API, published as the admin publishes it: a
 * revisioned collection stages a draft that the publish makes live; a plain one writes at once.
 */
async function edit(collection: string, id: string, change: object): Promise<void> {
	const { _rev } = await client.getEntry(collection, id);
	const saved = await client.api<{ _rev: string }>(
		"PUT",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
		{ ...change, _rev },
	);
	const { item } = await client.getEntry(collection, id);
	if (item.draftRevisionId === null) return;
	await client.api("POST", `/_emdash/api/content/${collection}/${id}/publish?locale=en`, {
		_rev: saved._rev,
	});
}

/** Sets the entry's terms through the terms route, which leaves its revision (V2). */
async function setTerms(collection: string, id: string, slugs: string[]): Promise<void> {
	await client.api("POST", `/_emdash/api/content/${collection}/${id}/terms/${TAG}`, {
		termIds: slugs.map((s) => terms[s]),
	});
}

/** Runs EmDash's scheduled maintenance now, through the dev site's test route. */
async function sweep(): Promise<string[]> {
	const res = await fetch(`${server.baseUrl}/test/run-scheduled`, { method: "POST" });
	if (!res.ok) throw new Error(`run-scheduled answered ${res.status}`);
	const body = (await res.json()) as { published: { id: string }[] };
	return body.published.map((p) => p.id);
}

/**
 * Sweeps until every entry in `due` (collection, ID) is published, by this route or by the Node
 * timer. Polled rather than timed once: under WSL a long timer can fire before the wall clock
 * reaches the time it waited for.
 */
async function sweepUntil(at: string, due: [string, string][]): Promise<void> {
	const until = Date.parse(at) + 60_000;
	await sleep(Math.max(0, Date.parse(at) - Date.now()));
	for (;;) {
		await sweep();
		const states = await Promise.all(due.map(([c, id]) => stateOf(c, id)));
		if (states.every((s) => s.status === "published" && s.scheduledAt === null)) return;
		if (Date.now() > until) throw new Error("The scheduler did not publish the due entries");
		await sleep(1_000);
	}
}

const codes = (row: RecordRow | undefined) => (row?.warnings ?? []).map((w) => w.code);
const fieldsOf = (row: RecordRow | undefined) => (row?.changes ?? []).map((c) => c.field);
const edited = (row: RecordRow | undefined) =>
	(row?.warnings ?? [])
		.filter((w) => w.code === "field_edited")
		.map((w) => w.field)
		.sort();

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	// Its own server: the kill-and-resume test stops it.
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	for (const [, collection, revisions] of KINDS) await createSchema(collection, revisions);
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: TAG,
		label: "Tags",
		collections: KINDS.map(([, c]) => c),
	});
	for (const slug of ["new", "sale"]) {
		const made = await client.api<{ term: { id: string } }>(
			"POST",
			`/_emdash/api/taxonomies/${TAG}/terms`,
			{ slug, label: slug, locale: "en" },
		);
		terms[slug] = made.term.id;
	}
	for (const [slug, displayName] of [
		["it-rr-alex", "Alex Doe"],
		["it-rr-sam", "Sam Lee"],
	] as const) {
		const made = await client.api<{ id: string }>("POST", "/_emdash/api/admin/bylines", {
			slug,
			displayName,
			locale: "en",
		});
		bylines[slug] = made.id;
	}
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

describe.each(KINDS)("M5b write modes and protection (%s collection)", (_kind, collection) => {
	const t = (extra: Record<string, unknown> = {}) => rulesTemplate(collection, extra);

	it("creates only new keys in create mode and updates only existing keys in update mode", async () => {
		await importCsv(csv([{ id: "M1", name: "Desk", price: 10 }]), t());
		const create = await importCsv(
			csv([
				{ id: "M1", name: "Desk changed", price: 11 },
				{ id: "M2", name: "Lamp", price: 5 },
			]),
			t({ rules: { mode: "create" } }),
		);
		expect(create.job.counters).toMatchObject({ created: 1, unchanged: 1, failed: 0 });
		expect(create.rows.map((r) => [r.status, codes(r)])).toEqual([
			["unchanged", ["exists"]],
			["created", []],
		]);
		const update = await importCsv(
			csv([
				{ id: "M1", name: "Desk changed", price: 11 },
				{ id: "M3", name: "Chair", price: 7 },
			]),
			t({ rules: { mode: "update" } }),
		);
		expect(update.rows.map((r) => [r.status, codes(r)])).toEqual([
			["updated", []],
			["unchanged", ["not_found"]],
		]);
		const keys = await byKey(collection);
		expect([...keys.keys()].filter((k) => k.startsWith("M")).sort()).toEqual(["M1", "M2"]);
		expect(keys.get("M1")?.data).toMatchObject({ title: "Desk changed", price: 11 });
	});

	it("updates only the listed fields, leaving an unlisted field an editor changed", async () => {
		await importCsv(csv([{ id: "F1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "F1");
		await edit(collection, id, { data: { title: "Editor's desk" } });
		const { rows } = await importCsv(
			csv([{ id: "F1", name: "Feed desk", price: 12, tags: "sale" }]),
			t({ rules: { updateFields: ["price"] } }),
		);
		expect(rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(rows[0])).toEqual(["price"]);
		expect(await stateOf(collection, id)).toMatchObject({
			title: "Editor's desk",
			price: 12,
			tags: ["new"],
		});
	});

	it("keeps an editor's field, term and byline changes, updates the rest, then lifts them", async () => {
		await importCsv(csv([{ id: "P1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "P1");
		await edit(collection, id, { data: { title: "Editor's desk" } });
		await setTerms(collection, id, ["sale"]);
		await edit(collection, id, {
			bylines: [{ bylineId: bylines["it-rr-sam"], roleLabel: null }],
		});
		const protectedRun = await importCsv(
			csv([{ id: "P1", name: "Desk", price: 12 }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(protectedRun.rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(protectedRun.rows[0])).toEqual(["price"]);
		expect(edited(protectedRun.rows[0])).toEqual(["bylines", "taxonomies.it_rr_tag", "title"]);
		expect(await stateOf(collection, id)).toMatchObject({
			status: "published",
			hasDraft: false,
			title: "Editor's desk",
			price: 12,
			tags: ["sale"],
			bylines: ["it-rr-sam"],
		});
		// A job without protectEdited writes the feed's values, and protection lifts.
		await importCsv(csv([{ id: "P1", name: "Desk", price: 12 }]), t());
		expect(await stateOf(collection, id)).toMatchObject({
			title: "Desk",
			tags: ["new"],
			bylines: ["it-rr-alex"],
		});
		const again = await importCsv(
			csv([{ id: "P1", name: "Desk", price: 13 }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(again.rows[0]).toMatchObject({ status: "updated" });
		expect(codes(again.rows[0])).toEqual([]);
	});

	it("falls back on the revision for a link saved before M5b, counting terms as edited", async () => {
		await importCsv(csv([{ id: "L1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "L1");
		withDb(server.dbPath, (db) => {
			const stripped = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_remove(data, '$.fields') WHERE plugin_id = ? AND collection = ? AND id = ?",
				)
				.run("flux-import", "links", `${collection}:en:L1`);
			expect(stripped.changes).toBe(1);
		});
		const { rows } = await importCsv(
			csv([{ id: "L1", name: "Desk", price: 12, tags: "sale" }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(rows[0])).toEqual(["price"]);
		expect(edited(rows[0])).toEqual(["taxonomies.it_rr_tag"]);
		expect(await stateOf(collection, id)).toMatchObject({ price: 12, tags: ["new"] });
	});
});

describe("M5b publish, draft or schedule, and the scheduler", () => {
	// Past the 60-second lead, with time for the imports below to run first.
	let at: string;
	const later = () => new Date(Date.parse(at) + 3_600_000).toISOString();
	const scheduled = (collection: string, publishAt: string) =>
		rulesTemplate(collection, { publishAt: { expr: `'${publishAt}'` } });
	const jobs: Record<string, Job> = {};

	beforeAll(async () => {
		at = new Date(Date.now() + 90_000).toISOString();
		for (const [kind, collection] of KINDS) {
			// Seeded and published now: S2 (re-run after the sweep), R2 (rolled back after it),
			// B2 (rolled back before it).
			await importCsv(
				csv([
					{ id: "S2", name: "Seeded", price: 1 },
					{ id: "R2", name: "Seeded", price: 1 },
					{ id: "B2", name: "Seeded", price: 1 },
				]),
				rulesTemplate(collection),
			);
			for (const prefix of ["S", "R", "B"]) {
				jobs[`${kind}:${prefix}`] = (
					await importCsv(
						csv([
							{ id: `${prefix}1`, name: "Created", price: 2 },
							{ id: `${prefix}2`, name: "Updated", price: 2 },
						]),
						scheduled(collection, at),
					)
				).job;
			}
		}
	});

	it("schedules created entries, and updates a revisioned collection keeps live until the time", async () => {
		for (const [kind, collection, revisions] of KINDS) {
			const job = jobs[`${kind}:S`] as Job;
			const rows = await client.records(job.id);
			expect(
				rows.map((r) => r.status),
				kind,
			).toEqual(["created", "updated"]);
			expect(
				rows[0]?.changes?.find((c) => c.field === "publishAt"),
				kind,
			).toMatchObject({
				after: at,
			});
			expect(await stateOf(collection, await entryId(collection, "S1")), kind).toMatchObject({
				status: "scheduled",
				scheduledAt: at,
			});
			const updated = await stateOf(collection, await entryId(collection, "S2"));
			if (revisions) {
				expect(updated, kind).toMatchObject({
					status: "published",
					scheduledAt: at,
					hasDraft: true,
				});
				expect(codes(rows[1]), kind).toEqual([]);
			} else {
				// A plain collection has no draft to hold the update: it goes live at once.
				expect(updated, kind).toMatchObject({ status: "published", scheduledAt: null });
				expect(updated.title, kind).toBe("Updated");
				expect(codes(rows[1]), kind).toEqual(["not_scheduled"]);
			}
		}
	});

	it("reschedules to a new time, and publishes at once for a time already passed", async () => {
		for (const [kind, collection] of KINDS) {
			await importCsv(csv([{ id: "T1", name: "Timed", price: 1 }]), scheduled(collection, at));
			const moved = await importCsv(
				csv([{ id: "T1", name: "Timed", price: 1 }]),
				scheduled(collection, later()),
			);
			expect(moved.rows[0], kind).toMatchObject({ status: "updated" });
			expect(fieldsOf(moved.rows[0]), kind).toEqual(["publishAt"]);
			const id = await entryId(collection, "T1");
			expect(await stateOf(collection, id), kind).toMatchObject({
				status: "scheduled",
				scheduledAt: later(),
			});
			const past = await importCsv(
				csv([{ id: "T2", name: "Past", price: 1 }]),
				scheduled(collection, "2020-01-01T00:00:00.000Z"),
			);
			expect(past.rows[0], kind).toMatchObject({ status: "created" });
			expect(await stateOf(collection, await entryId(collection, "T2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
			});
		}
	});

	it("rolls back scheduled entries before the time: deleted, or restored without the schedule", async () => {
		for (const [kind, collection] of KINDS) {
			const created = await entryId(collection, "B1");
			const done = await rollBack((jobs[`${kind}:B`] as Job).id);
			expect(done.job.counters, kind).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
			expect((await byKey(collection)).has("B1"), kind).toBe(false);
			expect(await sweep()).not.toContain(created);
			expect(await stateOf(collection, await entryId(collection, "B2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
				hasDraft: false,
				title: "Seeded",
				price: 1,
			});
		}
	});

	it("publishes them through the scheduler; a re-run is unchanged; a rollback still owns them", async () => {
		const due: [string, string][] = [];
		for (const [, collection] of KINDS) {
			for (const key of ["S1", "R1"]) due.push([collection, await entryId(collection, key)]);
		}
		await sweepUntil(at, due);
		for (const [kind, collection] of KINDS) {
			for (const key of ["S1", "S2", "R1", "R2"]) {
				expect(
					await stateOf(collection, await entryId(collection, key)),
					`${kind} ${key}`,
				).toMatchObject({ status: "published", scheduledAt: null, hasDraft: false, price: 2 });
			}
			const rerun = await importCsv(
				csv([
					{ id: "S1", name: "Created", price: 2 },
					{ id: "S2", name: "Updated", price: 2 },
				]),
				scheduled(collection, at),
			);
			expect(
				rerun.rows.map((r) => r.status),
				kind,
			).toEqual(["unchanged", "unchanged"]);
			const done = await rollBack((jobs[`${kind}:R`] as Job).id);
			expect(done.job.counters, kind).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
			expect((await byKey(collection)).has("R1"), kind).toBe(false);
			expect(await stateOf(collection, await entryId(collection, "R2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
				hasDraft: false,
				title: "Seeded",
				price: 1,
			});
		}
	});
});

describe("M5b write modes on a translation job", () => {
	it("updates existing French translations and skips the keys without one", async () => {
		const n = translationNames("it_rr_i18n");
		await createTranslationSchema(client, n);
		await importCsv(
			englishCsv([
				["E1", "Desk", "D-1", 10],
				["E2", "Lamp", "L-1", 5],
			]),
			englishTemplate(n),
		);
		const french = translationTemplate(n, "fr");
		await importCsv(translationCsv([{ id: "F1", enId: "E1", name: "Bureau" }]), french);
		const { rows } = await importCsv(
			translationCsv([
				{ id: "F1", enId: "E1", name: "Grand bureau" },
				{ id: "F2", enId: "E2", name: "Lampe" },
			]),
			{ ...french, rules: { mode: "update" } },
		);
		expect(rows.map((r) => [r.status, codes(r)])).toEqual([
			["updated", []],
			["unchanged", ["not_found"]],
		]);
		expect((await listLocale(client, n.products, "fr")).map((e) => e.data.title)).toEqual([
			"Grand bureau",
		]);
	});
});

describe("M5b kill and resume of a scheduling job", () => {
	it("schedules every entry once when a crash cuts the job off mid-batch", async () => {
		await client.createProducts("it_rr_crash");
		const rowsCount = 300;
		const publishAt = new Date(Date.now() + 3_600_000).toISOString();
		const { uploadId } = await client.upload(productsCsv(rowsCount));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: { ...template("it_rr_crash"), publishAt: { expr: `'${publishAt}'` } },
			dryRun: false,
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
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: rowsCount, failed: 0, conflict: 0 },
		});
		expect(await client.records(created.id, "writing")).toEqual([]);
		const entries = await client.listAll("it_rr_crash");
		expect(entries).toHaveLength(rowsCount);
		expect(
			entries.filter(
				(e) =>
					e.status !== "scheduled" || (e as { scheduledAt?: string }).scheduledAt !== publishAt,
			),
		).toEqual([]);
	});
});
````

- [ ] **Step 3: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/record-rules.test.ts`

Expected: PASS (1 file, 14 tests, about 140 s with the server start). On Node, for a revisioned and a plain collection, this proves:
- **Write modes and narrowing.** Create-only and update-only runs skip existing and missing keys with `exists` and `not_found`. `updateFields` leaves an unlisted field an editor changed.
- **Protection.** With `protectEdited`, an editor's REST edit of the title, a term change through the terms route and a byline change are kept with `field_edited` while the price updates. A job without `protectEdited` then lifts all three. A pre-M5b link row (its `fields` removed through SQLite) falls back on the revision and counts terms as edited.
- **Scheduling.** Created entries are scheduled. Updates of a revisioned collection stay live with a scheduled draft; those of a plain one go live with `not_scheduled`. A reschedule changes only `publishAt`, and a past time publishes at once.
- **Rollback before the sweep.** It deletes a scheduled create, which the sweep then never publishes, and restores a scheduled update without its schedule.
- **The sweep and after.** The sweep, through the dev route and polled (Fact E2), publishes the scheduled entries. A re-run is then `unchanged`, and a rollback of a swept job still owns its entries.
- **Translations.** A French translation job in `mode: "update"` updates the existing translation and skips the key without one.
- **Kill and resume.** A job scheduling 300 entries, killed mid-batch (SIGKILL), finishes after the restart with every entry scheduled once at the job's time.

Then run `pnpm test:integration`: all files pass. Facts F1 and F3 describe the known flakes.

- [ ] **Step 4: Commit**

`pnpm typecheck && pnpm lint && pnpm test`. Restore `sites/dev/emdash-env.d.ts` if the dev server changed it (`git checkout sites/dev/emdash-env.d.ts`), then:
```bash
git add sites/dev/src/pages/test/run-scheduled.ts sites/dev-cf/src/pages/test/run-scheduled.ts packages/flux-import/tests/integration/record-rules.test.ts
git commit -m "Prove M5b record rules end to end on the Node dev site, with a dev-only route that runs the scheduled publish"
```

### Task 9: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7 through the plugin routes; the parity harness (`client`, `byKey`, `importCsv`, `productsCsv`, `template`); the `sites/dev-cf` route from Task 8.
- Produces: three workerd tests:
  - "applies M5b write modes on D1: create only, then update only";
  - "keeps an M5b edited field on D1 and updates the others";
  - "schedules an M5b create and update on D1, publishes them by the scheduler, and rolls back".

- [ ] **Step 1: Add the tests**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
````ts
	return client.runToEnd(job.id);
}

describe("workerd parity (D1, R2)", () => {
	it("uploads to R2 and imports 10 rows through plugin routes that reach the runtime", async () => {
		await client.createProducts("cf_e2e");
````
with:
````ts
	return client.runToEnd(job.id);
}

/** The products template with M5b `rules` or `publishAt`. */
async function importRules(collection: string, csv: string, extra: object) {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: { ...template(collection), ...extra },
		dryRun: false,
		budgetMs: 20_000,
	});
	return client.runToEnd(job.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("workerd parity (D1, R2)", () => {
	it("uploads to R2 and imports 10 rows through plugin routes that reach the runtime", async () => {
		await client.createProducts("cf_e2e");
````

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
````ts
		);
		expect(blocked.counters).toMatchObject({ updated: 1, locked: 1 });
	});
});
````
with:
````ts
		);
		expect(blocked.counters).toMatchObject({ updated: 1, locked: 1 });
	});

	it("applies M5b write modes on D1: create only, then update only", async () => {
		await client.createProducts("cf_m5b_modes");
		await importCsv("cf_m5b_modes", productsCsv(2));
		const create = await importRules(
			"cf_m5b_modes",
			productsCsv(4, () => "7"),
			{
				rules: { mode: "create" },
			},
		);
		expect(create.counters).toMatchObject({ created: 2, unchanged: 2, failed: 0 });
		const update = await importRules(
			"cf_m5b_modes",
			productsCsv(6, () => "8"),
			{
				rules: { mode: "update" },
			},
		);
		expect(update.counters).toMatchObject({ updated: 4, unchanged: 2, failed: 0 });
		const entries = await byKey("cf_m5b_modes");
		expect(entries.size).toBe(4);
		expect([...entries.values()].every((e) => e.data.price === 8)).toBe(true);
	});

	it("keeps an M5b edited field on D1 and updates the others", async () => {
		await client.createProducts("cf_m5b_protect");
		await importCsv("cf_m5b_protect", productsCsv(1));
		const id = (await byKey("cf_m5b_protect")).get("SKU-0")?.id ?? "";
		const { _rev } = await client.getEntry("cf_m5b_protect", id);
		const saved = await client.api<{ _rev: string }>(
			"PUT",
			`/_emdash/api/content/cf_m5b_protect/${id}?locale=en`,
			{ data: { title: "Editor's title" }, _rev },
		);
		await client.api("POST", `/_emdash/api/content/cf_m5b_protect/${id}/publish?locale=en`, {
			_rev: saved._rev,
		});
		const job = await importRules(
			"cf_m5b_protect",
			productsCsv(1, () => "9"),
			{ rules: { protectEdited: true } },
		);
		expect(job.counters).toMatchObject({ updated: 1, failed: 0 });
		const [row] = await client.records(job.id);
		expect(row?.changes?.map((c) => c.field)).toEqual(["price"]);
		expect(row?.warnings?.map((w) => [w.code, w.field])).toEqual([["field_edited", "title"]]);
		expect((await client.getEntry("cf_m5b_protect", id)).item.data).toMatchObject({
			title: "Editor's title",
			price: 9,
		});
	});

	it("schedules an M5b create and update on D1, publishes them by the scheduler, and rolls back", async () => {
		await client.createProducts("cf_m5b_sched");
		await importCsv("cf_m5b_sched", productsCsv(1));
		const before = (await byKey("cf_m5b_sched")).get("SKU-0");
		// Past the 60-second lead; nothing sweeps under astro dev until the test route runs.
		const at = new Date(Date.now() + 75_000).toISOString();
		const job = await importRules(
			"cf_m5b_sched",
			productsCsv(2, () => "11"),
			{
				publishAt: { expr: `'${at}'` },
			},
		);
		expect(job.counters).toMatchObject({ created: 1, updated: 1, failed: 0 });
		const stateOf = async (key: string) => {
			const entry = (await byKey("cf_m5b_sched")).get(key);
			const { item } = await client.getEntry("cf_m5b_sched", entry?.id ?? "");
			const { scheduledAt } = item as Product & { scheduledAt?: string | null };
			return { status: item.status, scheduledAt, draft: item.draftRevisionId !== null };
		};
		expect(await stateOf("SKU-0")).toEqual({ status: "published", scheduledAt: at, draft: true });
		expect(await stateOf("SKU-1")).toEqual({ status: "scheduled", scheduledAt: at, draft: false });
		await sleep(Math.max(0, Date.parse(at) - Date.now()));
		for (let i = 0; ; i++) {
			const res = await fetch(`${client.baseUrl}/test/run-scheduled`, { method: "POST" });
			expect(res.status).toBe(200);
			const states = [await stateOf("SKU-0"), await stateOf("SKU-1")];
			if (states.every((s) => s.status === "published" && s.scheduledAt === null)) break;
			// Under WSL a long timer can fire before the wall clock reaches the time.
			if (i > 60) throw new Error(`Not published: ${JSON.stringify(states)}`);
			await sleep(1_000);
		}
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
		const after = await byKey("cf_m5b_sched");
		expect([...after.keys()]).toEqual(["SKU-0"]);
		expect(after.get("SKU-0")).toMatchObject({ status: "published", data: before?.data });
	});
});
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M5b"`

Expected: PASS (3 passed, 16 skipped; about 125 s with the server start, most of it the wait for a schedule to fall due). This proves on workerd and D1:
- a create-only then update-only pair;
- protection of an editor's published title while the price updates;
- a scheduled create and update (the update of a revisioned collection published with a scheduled draft), published by the sweep through the dev route, then rolled back by a job that owns them after the scheduler.

The full `pnpm test:cf` runs in Task 10.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove M5b record rules and scheduling on workerd and D1"
```

### Task 10: M5b review run

**Files:**
- Create: `docs/superpowers/notes/2026-11-04-m5b-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. If Step 2 lowers a cap, also `packages/flux-import/src/plugin/service.ts` and the tests that name it.
- Temporarily (reverted before the commit): `packages/flux-import/src/plugin/d1-count.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration-cf/d1-count.test.ts`

**Interfaces:**
- Consumes: everything above, and the Task 0 results in "Facts this plan relies on".
- Produces: the filled-in review note, the re-measured V7 counts (and a lowered cap if one is over the limit), and the roadmap status.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass. `pnpm test:cf` takes about 25 minutes, almost all of it the unchanged 10,000-row case; Facts F1-F3 describe the known flakes. Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Re-measure D1 queries per batch (V7)**

Create the M5a counter again, `packages/flux-import/src/plugin/d1-count.ts` (Task 9 Step 2 of `docs/superpowers/plans/2026-11-03-flux-import-m5a-journal-rollback.md`, unchanged). Wrap the `jobs/next` handler's `nextBatch(…)` call in `packages/flux-import/src/plugin/routes.ts` as there:
```ts
countD1(() => nextBatch(…)).then(({ value, queries }) => ({ ...withoutPlannedTerms(value), d1Queries: queries }))
```
Then create `packages/flux-import/tests/integration-cf/d1-count.test.ts`, which calls `jobs/next` one batch at a time and records `d1Queries` for every batch. It needs these cases, with `budgetMs: 20_000`:
1. **Unlinked.**
   - On `client.createProducts("cf_m5b_v7a")`: 22 creates with `publishAt` a day ahead.
   - On `cf_m5b_v7b`: 22 published entries whose titles an editor changed (`PUT` then `publish`). Then 22 updates with the same titles, new prices, `publishAt` and `rules: { protectEdited: true }` (each a schedule and a fingerprint refresh).
   - The rollback of that job.
2. **Linked.**
   - On `createLinkSchema(client, { ...linkNames("cf_m5b_v7"), alex: "cf-m5b-v7-alex", sam: "cf-m5b-v7-sam" })`, with bylines matched by slug, `PEOPLE_CSV` and six base posts: 12 scheduled creates, each with three references (`base-4|base-5|base-6`), two category paths, two tags and two bylines.
   - 12 published posts whose titles an editor changed, then a scheduled, protected update of them that changes every link and repeats the edited titles. Then its rollback.
   - Six drafts (`publish: false`), then a scheduled update of them. Then its rollback, which runs step 1 and step 7.

Run: `pnpm exec vitest run --config vitest.cf.config.ts tests/integration-cf/d1-count.test.ts`. Record every batch's count in the note; Fact V7 has the drafting numbers.

If a batch is over about 900 queries, lower that job kind's cap in `src/plugin/service.ts` to the largest count of rows that fits, as in M5a: `WORKERS_BATCH_CAP`, `WORKERS_LINKED_BATCH_CAP` or `WORKERS_ROLLBACK_BATCH_CAP`. Then change the tests that name the cap, re-run `pnpm test` and `pnpm exec vitest run --config vitest.cf.config.ts -t "M5a|M5b"`.

Finally, delete `src/plugin/d1-count.ts` and `tests/integration-cf/d1-count.test.ts` and revert the `routes.ts` wrap (`git checkout packages/flux-import/src/plugin/routes.ts`). `git status` must show only the cap change, if any.

- [ ] **Step 3: Manual checks against `pnpm dev`**

Work on the normal dev database:
- Back up `sites/dev/data.db*` and `sites/dev/uploads` first.
- An agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`.
- Get an Admin PAT from `setup/dev-bypass`.

Record each result:
1. Create a revisioned collection with `client.createProducts("m5b")` and import `productsCsv(3)` with `template("m5b")`. Edit one entry's title in the admin and publish it. Import `productsCsv(3, (i) => String(i + 10))` with `rules: { protectEdited: true }`: three rows `updated`, the edited one with `field_edited` on `title`, and the admin shows the editor's title with the new price.
2. Import `productsCsv(4, (i) => String(i + 20))` with `rules: { mode: "update" }` and a `publishAt` two minutes ahead: three rows `updated` and one `unchanged` with `not_found`. The admin shows the three entries as published with a scheduled change at that time. Within about a minute after the time (Node's timer, Fact V4), they show the new prices with no pending change.
3. Run `jobs/rollback` of the last job: three rows `reverted`. The entries show the previous prices, with no schedule.
4. Restore `sites/dev/data.db*` and `sites/dev/uploads`, and revert `sites/dev/emdash-env.d.ts`. `git status` must be clean apart from the note and any cap change.

- [ ] **Step 4: Write the review note**

Create `docs/superpowers/notes/2026-11-04-m5b-review.md` from this template and fill in every `…`:
```markdown
# Milestone 5b review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0) and query counts (Step 2)

| Fact | Check | Result |
| --- | --- | --- |
| V1: each value kind's fingerprint is the same sent and read back, live and in a draft, on Node and workerd | drafting probe (plan Facts); Task 2 property test; Task 8 | … |
| V2: one REST edit, one terms-route change, one byline change each move only their own fingerprint; a send-back moves none | drafting probe; Tasks 5 and 8 | … |
| V3: schedule, reschedule, update and publish leave the stated states; schedule keeps `version` and moves `updatedAt` | drafting probe; Tasks 3 and 6 | … |
| V4: the sweep publishes with one `version`, no draft, no schedule, `publishedAt` at the time; skips Trash | drafting probe; Tasks 7-9 | … |
| V5: unschedule as a revert step restores both pre-states | drafting probe; Task 7 | … |
| V6: `getCollectionWithFields` returns `supports` | drafting probe; Task 1 | … |
| V7: D1 queries per batch at `WORKERS_BATCH_CAP`, `WORKERS_LINKED_BATCH_CAP` and `WORKERS_ROLLBACK_BATCH_CAP` with scheduling, protection, refresh and step 7 (limit 1,000) | Step 2 | … per batch; caps … |

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
| Unit, template and job: schemas, refusals, `tz: "site"`, `Job.revisions`, `publishAt` conversion | `rules-template.test.ts` | … |
| Unit, engine: each mode row (resumed write, `publish_*` retry in create mode, duplicate keys, linked records, no side effects when skipped), `updateFields` for every kind, crash repair, fingerprints (canonical forms, property test, recording, merging, refresh), every protection row, side-effect-free resolution, lifting, the publish table, `not_scheduled`, the lead margin, `schedule_conflict`/`_locked`, a hook refusal, `schedule_unverified` and adoption, the journal of each write path, step 7 and `reached()`, ownership after the scheduler, dry runs | `fingerprints.test.ts`, `record-rules.test.ts`, `record-rules-translations.test.ts`, `protection.test.ts`, `schedule.test.ts`, `rollback-schedule.test.ts`, `fakes.test.ts`, `content.test.ts` | … |
| Integration on `sites/dev` (spec list, with Ruling 12) | `record-rules.test.ts` (integration) | … |
| Cloudflare parity on `sites/dev-cf` | `parity.test.ts` (`-t "M5b"`) | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | An editor's title is kept with `field_edited`; the price updates | … | … |
| 2 | Update-only skips the new key; the updates are scheduled and published by Node's timer | … | … |
| 3 | The rollback restores the previous prices with no schedule | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
```

- [ ] **Step 5: Mark M5b done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| **M5b** ([spec](./2026-11-04-flux-import-m5b-record-rules-design.md)) | Record rules: create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin" through per-field fingerprints on the link row; publish, draft or schedule, with a per-record schedule; all journalled | Planned |
```
with:
```markdown
| **M5b** ([spec](./2026-11-04-flux-import-m5b-record-rules-design.md)) | Record rules: create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin" through per-field fingerprints on the link row; publish, draft or schedule, with a per-record schedule; all journalled | Done ([review](../notes/2026-11-04-m5b-review.md)) |
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-11-04-m5b-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 5b review results and mark M5b done in the roadmap"
```
If Step 2 lowered a cap, add `packages/flux-import/src/plugin/service.ts` and the changed tests to the same commit, and say so in the message body.

---

## After this plan

M5b gives Milestone 5 its record rules: create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin"; and publish, draft or schedule, all journalled and reversible.

Known gaps carried forward, all documented in the spec or in the rulings above:
- an unlisted mapping is still converted, so a bad value in it fails the record (spec "Decisions");
- a dry run cannot see the second of two duplicate keys skipped in `create` mode;
- `publishedAt` is never backdated;
- `publish: false` never takes a schedule away;
- protection does not cover status changes beyond the M2 pending-state rule;
- a rollback restores but never deletes the revisions it and the job wrote.

M5c (missing entries) journals its writes in the M5a format and extends the revert sequence after step 7. The M2-M5a open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-11-03-m5a-review.md`) are unchanged by this plan. The production Cloudflare build blocker from M2 still stands.
