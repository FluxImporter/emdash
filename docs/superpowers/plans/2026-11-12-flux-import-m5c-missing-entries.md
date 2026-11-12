# Flux Import M5c: missing entries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below), and Task 0 changes no file. Tasks 1 and 3 can run in parallel worktrees, then Tasks 2 and 6, and at the end Tasks 7 and 8. The rest follow in order (see "Parallel execution").

**Goal:** Let a template name the entries its import creates, and say what happens to them when a later feed no longer holds them. The template gains two rules:
- `rules.owner`: a name stamped on the link row of every entry the job creates. Any record of another owner, or of none, drops the stamp.
- `rules.missing: { action: "trash" | "unpublish", maxPercent? }`: after a completed first pass, every owned entry whose key no record of the job had is moved to Trash or unpublished.

Nothing is ever deleted permanently. The phase counts first, against a threshold (default 25%), and changes nothing when the count is over it. It leaves an entry edited since the import wrote it, one with a pending draft or schedule, and (for Trash) a group root with active translations, each with a row that says why. Every change is journalled in the M5a format (a new journal kind, `trash`), and `jobs/rollback` undoes it: revert steps 8 `restore` and 9 `republish`, or M5a's sequence for an unpublish. A dry run plans the same rows. Templates stay `version: 1`; a template without `rules.owner` and `rules.missing` behaves as in M5b, except that it drops another template's owner stamp from a link it reaches.

**Architecture:** by task:
- **Task 1.** `src/engine/types.ts`, `src/engine/template.ts` and `src/engine/jobs.ts` gain the rules, job options, `Job.missingLimit`, `Job.unkeyed`, `Job.missing` and the new link, journal and row fields. `src/plugin/definition.ts` declares the links index and `content:restore`. The XLSX converter reports its skipped rows to `createJob`.
- **Task 2.** `src/engine/owner.ts` (new) holds the stamp rules. `src/engine/batch.ts` stamps, keeps and drops owners, saves the key of a failed record, counts `unkeyed`, and refuses a key whose entry the import moved to Trash. `src/engine/journal.ts` snapshots the new link fields.
- **Task 3.** `ContentPort` gains the revert step `restore`, `src/emdash/content.ts` calls `handleContentRestore`, and the fakes restore from Trash as EmDash does.
- **Task 4.** `src/engine/missing.ts` (new) holds the phase: entry, candidates, the seen query, the verdicts, the count stage, the threshold and the act stage. `src/engine/batch.ts` enters it after a completed first pass. `src/plugin/service.ts` gets the Workers caps.
- **Task 5.** `src/engine/missing.ts` gains crash repair, the `removed` recount and the next-seq read. `jobs/retry` stops before the phase's rows.
- **Task 6.** `src/engine/revert.ts` gains `restoreTrashed` (steps 8 and 9) and a link hand-back that keeps the owner.
- **Tasks 7 and 8.** These prove it on Node (`sites/dev`) and on workerd (`sites/dev-cf`).
- **Task 9.** The review run, the D1 measurements of V8 and the note.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine), Biome 2, EmDash 1.2.0, Astro 7.3. Workerd parity runs through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-flux-import-m5c-missing-entries-design.md`, all sections, Rulings 1-29 binding. Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 5 split). Previous plan: `docs/superpowers/plans/2026-11-04-flux-import-m5b-record-rules.md`. Its review: `docs/superpowers/notes/2026-11-04-m5b-review.md`.

How this plan was checked while drafting (results in "Verification while drafting"):
- Task 0's facts were proven on Node and workerd with a temporary probe route and probe test, removed afterwards.
- The code in Tasks 1-8 was written against the code at `affa006` and the EmDash 1.2.0 source, with every replaced passage copied from the files as they stand. It was not applied and run while drafting: each task's "see them fail" and "see them pass" steps are the first run. Where a step gives a test count, it is the count of the tests the task adds.

Two citation conventions: EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0, and the spec's facts F1-F16 and P1-P3 are cited as "spec F<n>" and "spec P<n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID is `flux-import`. The package exports stay `fluxImport()`, `fluxImportRoutes()` and `createPlugin()`.
- New template keys: `rules.owner` (1-100 characters of `[A-Za-z0-9._:-]`) and `rules.missing` (`action`: `"trash"` or `"unpublish"`, required; `maxPercent`: integer 0-100, default 25). Both strict and optional; `version` stays 1.
- New job option (`jobs/create`): `missing: false | { maxPercent }`.
- New data fields: `Job.missingLimit`, `Job.unkeyed`, `Job.missing`, `Job.phase: "missing"`, `Counters.removed`; `RecordStatus` `"removed"`; `RecordRow.action` `"unpublish"` and `"restore"`; `LinkRow.owner`, `.ownerSource`, `.missing`, and the same three in `JournalBefore.link`; `JournalEntry.kind` `"trash"`; `CreateJobInput.missing` and `.skippedRows`; `applyTemplate`'s failure gains `key`.
- New port step: `RevertStep` `"restore"` (`handleContentRestore`, spec F2).
- New storage index: `links` `["owner", "collection", "locale"]`. No new route or storage collection.
- New declared capability: `content:restore`, for disclosure: rollback restores from Trash through the trusted runtime, not `ctx.content` (spec F12, Ruling 18). Nothing else changes in the capability list.
- No new dependencies; no task touches `package.json` or `pnpm-lock.yaml`.

**Environment**
- Node `>=22.16`. Run `nvm use` (it reads `.nvmrc`) before any command. In agent shells, prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`, because the default node is v16.
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only: never `cat >`, `cat >>` or heredocs through `cat`.
- Scratch files go in `.superpowers/wt/` (excluded from git), never `/tmp`, which WSL wipes on restart.

**Code rules**
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- The engine (`src/engine/`) never imports `emdash`. The runtime handlers are reached only through `ContentPort` in `src/emdash/content.ts`.
- Use EmDash APIs only as documented or as read in `node_modules/emdash`, cited by file and line.
- No raw SQL in plugin code. Plugin storage is queried only on declared index fields (spec F10), at most 100 rows a page, at most 50 values in an `in` (`MISSING_PAGE`, spec F13).
- Every content read and write names the template's locale: the phase pages `links` by `{ owner, collection, locale }` and reads each entry with `content.get(collection, locale, id)`.
- The test sites' `src/pages/test/run-scheduled.ts` keeps answering 403 unless `import.meta.env.DEV`.

**Running tests**
- Vitest runs from `packages/flux-import` with file paths, for example `pnpm exec vitest run tests/unit/missing.test.ts`.
- Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/missing.test.ts`.
- Workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M5c"`.
- Ports: the new Node integration file starts its own server on port 4391, the M5a rollback suite's and the M5b record-rules suite's port. The suites run one at a time (`fileParallelism: false`). The shared server uses 4399, the workerd harness 4396, the other suites 4392-4395, 4397 and 4398. Never run two copies of the same harness at once.

**Codes, exactly**
- Missing rows, as warnings on `unchanged` rows: `missing_gone`, `missing_edited`, `missing_pending`, `missing_not_live`, `missing_has_translations`, `missing_over_count`.
- Missing rows, as errors: `locked` (locked), `missing_blocked` (failed), `missing_changed` (conflict), `missing_unverified` (conflict).
- Import rows: `missing_trashed` (conflict).
- Rollback rows: `rollback_changed` (conflict), `rollback_blocked` (failed), `locked`, `nothing_to_roll_back` (warning); the action of a reverted trash row is `restore`.
- Job refusals: `invalid_template` "rules.missing needs rules.owner"; `invalid_options` "The job option missing needs rules.missing in the template", "rules.missing needs the journal, so its changes can be rolled back" and "The job option missing.maxPercent must be an integer from 0 to 100".
- The messages and job warnings are given in the tasks, word for word (`MISSING_MESSAGES` and the warning functions in Task 4).

**Repository hygiene**
- Never commit `sites/dev/.env`, tokens, or the changes the dev server writes to `sites/dev/emdash-env.d.ts` and `sites/dev-cf/emdash-env.d.ts`. The shared integration setup restores the first; restore both by hand after any other server run.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`.
- Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.

**Definition of done**
- `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root after every task.
- Task 7 also passes its integration file and `pnpm test:integration`.
- Task 8 passes the targeted workerd tests.
- Task 9 runs everything, `pnpm test:cf` included (about 25 minutes).

## Review Focus

1. **A foreign stamp never survives a record that reached its link** (Ruling 21). An owned entry that another feed still holds must never be counted, whatever that feed's record did: unchanged, skipped by its mode, protected on every difference, `pending_draft`, `locked`, or failed after the link read. Each costs at most one link put, and a dry run puts nothing. Evidence: Task 2 (the required sequence, with a put counter), Task 4 (A's next run does not count K), Task 7 (a second template with another owner).
2. **The threshold is decided on the whole set before any change** (Rulings 6, 20, 22, 23). `found` counts every unseen candidate whose entry exists, the left-alone ones included. `base` leaves out this job's creates. The act stage never removes more than `found`, also after a lost batch. Evidence: Task 4 (boundaries, small feeds, the rounded-up suggestion, the dry-run base), Task 5 (the recount after a lost batch), Task 7 (refusal, then acceptance with the option).
3. **Only an entry exactly as the importer left it is changed** (Rulings 8, 9, 10). An edit, a draft or a schedule, an already-unpublished entry, or a group root with active translations is reported and left. A swept schedule counts as the importer's only while the scheduling job's journal holds the values. Evidence: Task 4 (every verdict row, the swept entry with and without its journal), Task 7 (a REST edit and an editor's draft).
4. **Every change is journalled before it lands, and rolls back** (Rulings 13, 29 M2). The write-ahead row is deleted when the call did not land. A stop at any point resumes to one change per entry or reports `missing_unverified`. Rollback steps 8 and 9 restore exactly what was trashed (V1). Evidence: Task 5 (a stop at each point, for both actions), Task 6 (steps 8 and 9, `reached()`, the slot conflict), Task 7 (SIGKILL mid-act, and a rollback compared field by field).
5. **Templates without `rules.owner` and `rules.missing` behave as in M5b.** The only changes they see are four:
   - the key on a failed row;
   - the owner drop;
   - `missing_trashed` on a link that names a trashed entry;
   - the `unkeyed` counter.

   Evidence: every M2-M5b unit, integration and parity test passes. The only edits to them are the fakes' sortable IDs (Task 3), the definition expectations (Task 1) and the failed rows that now carry their key (Task 2).

---

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V8 are the facts the spec left unconfirmed.

How V1-V7 were proven:
- A temporary plugin route `probe/m5c` called the runtime's handlers (`handleContentGet`, `handleContentGetIncludingTrashed`, `handleContentDelete`, `handleContentRestore`, `handleContentPublish`, `handleContentUnpublish`, `handleContentTranslations`). It also called the plugin's own storage collections (`links`, `records`, `journal`) and `ulid()`. On workerd each call was wrapped in the M5a D1 counter (`countD1`).
- A temporary probe test drove it on `sites/dev` (port 4420, its own SQLite file under `.superpowers/wt/scratch-m5c-plan/`) and on `sites/dev-cf` (port 4421, fresh local D1).
- Each site had a collection with revisions (`createProducts`), one without (`supports: ["drafts"]`), the M4b link schema (two references, two taxonomies, two bylines) and the M4e translation schema.
- V4 ran in two server starts on the same database: the first with `STORAGE.links.indexes` as it is, the second with `["owner", "collection", "locale"]` added.
- Every probe file was removed afterwards, `routes.ts` and `definition.ts` were reverted, and `sites/dev/data.db` was compared byte for byte with its backup. The Node and workerd results were identical.

V8 cannot be measured before the phase exists. Its numbers below are projections from the measured per-call D1 counts; Task 9 measures the real batches.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds.** On both runtimes and the three collections, a published entry without a draft, trashed with `handleContentDelete`:<br>- reads back through `handleContentGetIncludingTrashed` with the same `_rev`, slug, status and `scheduledAt`, and `deletedAt` set;<br>- is missed by `content.get` and by `findBySourceId`.<br>`handleContentRestore` with a stale `_rev` (version − 1) is `CONFLICT`. With the trashed `_rev` it returns `status: "draft"`, no schedule, no live and no draft revision, one `version` more, and the slug unchanged. A publish with the returned `_rev` then gives back the data, slug, terms, references, bylines, status and `publishedAt` exactly (`_rev` aside; `version` is then 2 past the trashed one). A never-published draft the importer created (`publish: false`) trashed and restored reads back equal without a publish. A French translation trashed, its slot taken by a new translation, then restored: `CONFLICT` "An active translation already exists in this locale". | Probe on Node and workerd; Tasks 3, 6, 7 |
| V2 | **Holds.** On both collection kinds, `handleContentUnpublish` with `_rev` of a published entry without a draft gives `status: "draft"`, no live revision, a draft revision, no schedule, one `version` more; the read then shows `hasDraft: true`. With the link moved to the unpublish's `_rev` and the job's journal row replaced by an `update` pre-image `{ link: { jobId, writtenRev }, rev, status: "published", scheduledAt: null, live: {} }`, `jobs/rollback` reverted the row at step 2 alone, on both kinds, and the entry read back exactly as before the unpublish (no draft, `publishedAt` kept). Step 4 never ran: the publish clears the draft on a collection without revisions too. | Probe; Tasks 4, 6, 7 |
| V3 | **Holds.** On both kinds, an entry unpublished with the link moved to the unpublish's `_rev`, imported again: `updated` and published without a draft, with the same values (`finishUnchanged`), with `rules.protectEdited`, and with a changed price (written). That the write also drops the `missing` mark is Task 2's code and test. | Probe; Tasks 2, 7 |
| V4 | **Holds.** 320 link rows saved without the index (260 with `owner: "o1"`, 40 `"o2"`, 20 none):<br>- a query on `owner` was refused with `StorageQueryError` (Node log: "Cannot query on non-indexed field");<br>- after the index was added to the manifest and the server restarted, `query({ where: { owner, collection, locale } })` validated at once;<br>- `_plugin_indexes` and `sqlite_master` listed neither index (not even the old `entryId` one) until the first scheduler tick (`POST /test/run-scheduled`), and both afterwards.<br>Paging 100 at a time across separate requests, with eight `o1` rows (visited and not yet visited) and 20 new `o2` rows put after the first page, visited all 260 `o1` rows once in three pages. On D1 each page was 1 query. | Probe, both runtimes; Tasks 1, 4 |
| V5 | **Holds.** 120 record rows of one job (two per key, 60 keys) and one row of another job: `records.query({ where: { jobId, sourceKey: { in: keys } }, limit: 100 })` with 50 keys returned the 100 rows of those keys and with 10 keys the other 20, each once, 1 D1 query per page. `where: { jobId, seq: { gte } }, orderBy: { seq: "desc" }, limit: 1` returned the last row (1 query). `seq: { gte: 10, lt: 20 }` with a status `in` returned exactly seqs 10-19. | Probe, both runtimes; Tasks 4, 5 |
| V6 | **Holds for jobs, not within one millisecond.** 20 consecutive `jobs/create` calls got IDs in creation order on both runtimes. 2,000 `ulid()` calls in a tight loop: 1,956 (Node) and 1,991 (workerd) consecutive pairs shared a millisecond, and about half of them (996 and 994) were out of order: `ulidx`'s `ulid()` is not monotonic. The spec's fallback (`Job.createdAt`) has millisecond precision too, so it cannot order such jobs either: see Ruling 1. | Probe; Task 4 |
| V7 | **Holds.** Trashing the French translation of E1 left E1's data, terms, references, slug and status unchanged, and `handleContentTranslations` of E1 listed `en, fr` before and `en` after. | Probe, both runtimes; Tasks 4, 7 |
| V8 | **Projected; Task 9 measures.** D1 queries per call, measured by the probe on workerd:<br>- `content.get` 6 (14 with reference selections), a miss 2, `getIncludingTrashed` 4;<br>- trash 19, restore 18, unpublish 33, publish 36-48, `translations` 2, `isLocked` 1;<br>- each plugin storage get, put, query page or put-if-absent 1.<br>The `jobs/next` overhead (job claim, lease, release, `withServices`) was 10-20 in the M5b review. Projected batches:<br>- a count batch of 40 reads, about 40 × 6 + 4 + 15 ≈ 260;<br>- an act batch of 10 trashes, about 10 × (6 + 2 + 1 + 2 + 19 + 2 + 1) + 20 ≈ 350;<br>- an act batch of 10 unpublishes, about 10 × (6 + 1 + 2 + 33 + 2 + 1) + 20 ≈ 470;<br>- a rollback batch of 3 trash rows, about 3 × (2 + 4 + 1 + 1 + 3 + 18 + 48 + 1) + 20 ≈ 260;<br>- a rollback batch of 3 unpublish rows, about 3 × (6 + 1 + 1 + 3 + 48 + 1) + 20 ≈ 200.<br>All are well under 900, so the provisional caps (40, 10, 3) stay. | Probe counter; Task 9 Step 2 |
| E1 | **The dev route needs the CSRF header on Node.** `POST /test/run-scheduled` without `X-EmDash-Request: 1` answered 403 on `sites/dev` under `astro dev`, and 200 with it. The tests send the header (with the PAT) on both sites. | Probe |
| E2 | **Declared indexes appear only at a scheduler tick** (V4): a fresh process has none of the plugin's physical indexes until `runScheduledTasks` or Node's timer runs once. Queries validate against the manifest meanwhile and only run slower. | Probe; spec F11 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart, and `crash.test.ts` can then fail its precondition. This has been known since M3c; re-running the file settles it. | M3c-M5b plans |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d did not recur while drafting. If Task 8 or Task 9 sees it, capture the server log and record it in the review note. | M4d-M5b reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4397`, which WSL's mirrored networking shares, so `retention.test.ts` fails in setup with "Port 4397 is in use". | M4d-M5b reviews |

## Rulings this plan makes

1. **Jobs created in the same millisecond count as later** (V6, amends the spec's V6 fallback). A link's job is later than this job when its ID sorts after this job's, or when both are ULIDs with the same 10-character time part and the IDs differ (`laterJob` in `src/engine/missing.ts`). Such a link is neither counted nor acted on. That fails safe: an entry is only ever not removed. The spec's fallback, `Job.createdAt`, has millisecond precision too and would cost a job read per distinct `jobId`. Clock skew across processes stays an open issue.
2. **`ruled()` ignores `owner` and `missing`.** A template whose `rules` holds only those keys keeps the M5b record order (no early lookup), so it behaves as one without `rules`. Any other key, `rules: {}` included, keeps M5b's early lookup.
3. **The count stage reads only `content.get`.** Whether a missing entry is in Trash or gone, it does not count toward `found`, so the count needs no `getIncludingTrashed`. The act stage calls `getIncludingTrashed` only when resuming a `writing` trash row, where the answer decides whether the trash landed. Each call counts against the caps (Ruling 29 M8).
4. **Batches process whole link pages.** Each links query asks for at most as many rows as the batch can still read (count stage) or decide (act stage), and at most 100. A batch then never stops mid-page, and `Job.missing.cursor` alone says where the next one starts. Seen candidates take page slots but cost no read.
5. **`missing_trashed` in a dry run too.** A dry run would otherwise plan a create that the real run refuses (`SLUG_CONFLICT` or a duplicate, spec F5, F8). It costs no read: the link is already read.
6. **`found === 0` sets `verdict: "act"`** and ends the phase. M6's automation reads one verdict per completed phase.
7. **Where the template documentation goes.** The repository has no user-facing template reference yet; M6 adds one with saved templates. The spec's "Template documentation" text goes into the doc comment of `rules.owner` in `src/engine/template.ts` and into the review note's "Open issues", so M6 copies it from there.
8. **Missing rows carry their code as a warning when `unchanged`, as an error otherwise**, as M5a's rollback rows do (`nothing_to_roll_back` is a warning, `rollback_changed` an error).
9. **The dry-run refusal warning**, which the spec gives only as "reworded": "Missing entries: `<found>` of the `<base>` entries owner `<owner>` created before this import are not in the feed (`<p>`%), more than the limit of `<maxPercent>`%, so a real run would leave them alone. Check the feed, then import it again with the job option missing: { maxPercent: `<p>` } to apply it (with force: true for an unchanged URL source)."
10. **A content error during an act** fails the row with EmDash's code, like an import row. The write-ahead journal row stays, because the call may have landed. The rollback then finds the link unmoved and reports `nothing_to_roll_back`, or `rollback_changed` if the call did land.
11. **The fakes' IDs sort like ULIDs.** `makeDeps().newId` returns `id00000001`, `id00000002`, …, so `laterJob` compares fake job IDs as it compares ULIDs. No test depends on the old `id1` form.
12. **Task split.** Task 4 builds the phase end to end, journal and link mark included. Task 5 adds what makes it survive a stop: crash repair of a `writing` row, the `removed` recount, the next seq read from the last row, and the retry boundary. The spec's plan sizing put the whole act stage in its task 5. This split gives each task a reviewable deliverable.
13. **The swept case's journal row.** An entry acted on through the scheduler's publish (`_rev` past the link's `writtenRev`) is journalled with `before.rev` the entry's `_rev`. M5a's link hand-back then leaves the link at the scheduling job's revision. After a rollback, that entry reads as edited to the next phase, which fails safe (Open issues).
14. **A stopped act starts over.** A `writing` missing row whose call did not land (the entry is still active at the row's `writtenRev`, or active at all for a trash) deletes its journal row and is decided again at the same seq, so a fresh read journals the entry as it now is. A left-alone row of a real run also deletes the journal row under its key. A batch that stopped between the journal put and the `writing` row left one, and no call was sent for it. This costs one storage call per left-alone row.

## Verification while drafting

| Check | Result |
| --- | --- |
| Task 0 (V1-V7) | all hold (Facts V1-V7) on Node and workerd, with a temporary probe route, probe test and D1 counter, removed afterwards; V6 holds for consecutive jobs only (Ruling 1) |
| Task 0 (V8) | projected from measured per-call counts (Fact V8); Task 9 measures the batches |
| Tree after Task 0 | `git status` clean; `sites/dev/data.db` identical to its backup; both `emdash-env.d.ts` restored |
| Code in Tasks 1-8 | written against `affa006`; not applied or run while drafting (see the note under "Spec") |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/types.ts`, `src/engine/template.ts`, `src/engine/jobs.ts`, `src/engine/rules.ts`, `src/plugin/definition.ts`, `src/plugin/routes.ts`, `src/plugin/xlsx.ts`, `src/sources/xlsx.ts` | Types, schemas, job options and refusals, `missingLimitOf`, `ruled()`, the index and capability, `skippedRows` (Task 1) |
| `src/engine/owner.ts` (new), `src/engine/batch.ts`, `src/engine/journal.ts` | Stamping, keeping and dropping owners; the key on failed rows; `unkeyed`; `missing_trashed`; the link snapshot (Task 2) |
| `src/engine/ports.ts`, `src/emdash/content.ts`, `src/engine/revert.ts` (`STEP_COST` only), `tests/unit/fakes.ts` | The `restore` step and the fakes' restore (Task 3) |
| `src/engine/missing.ts` (new), `src/engine/batch.ts`, `src/plugin/service.ts` | The phase (Task 4); its crash repair, recount and the retry boundary (Task 5) |
| `src/engine/revert.ts` | `restoreTrashed`, steps 8 and 9, the link hand-back (Task 6) |
| `tests/integration/missing.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 7 and 8) |

`src/engine/links.ts`, the Portable Text modules, `src/engine/diff.ts`, `src/engine/fingerprints.ts`, `src/plugin/schema-apply.ts` and `src/plugin/retention.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V8 | — | nothing (results above) | — |
| 1. Template rules, job options, types, index | — | `src/engine/{types,template,jobs,rules}.ts`, `src/plugin/{definition,routes,xlsx}.ts`, `src/sources/xlsx.ts`, `tests/unit/{missing-template,definition,xlsx-import}.test.ts` | sonnet |
| 2. Owner stamps, keys of failed records, `unkeyed`, `missing_trashed` | 1 (`Template.rules.owner`, `LinkRow.owner`/`ownerSource`/`missing`, `JournalBefore.link`, `Job.unkeyed`) | `src/engine/{owner,batch,journal,template}.ts`, `tests/unit/{owner,missing-keys}.test.ts`, failed-row expectations in existing tests | opus |
| 3. The `restore` step, adapter and fakes | — | `src/engine/{ports,revert}.ts`, `src/emdash/content.ts`, `tests/unit/{fakes,fakes.test,content.test}.ts` | sonnet |
| 4. The missing phase | 1, 2, 3 (`missingLimit`, `ownerOf`, `linkBefore`, the stamps, the fakes' Trash and sortable IDs) | `src/engine/{missing,batch}.ts`, `src/plugin/service.ts`, `tests/unit/{missing,service}.test.ts` | opus |
| 5. Crash repair, recount, retry boundary | 4, 6 (`missingPass`, `restoreTrashed` for the end-to-end rollbacks) | `src/engine/{missing,batch}.ts`, `tests/unit/missing-repair.test.ts` | opus |
| 6. Rollback steps 8 and 9 | 1, 3 (`JournalEntry.kind "trash"`, `RevertStep "restore"`, the fakes' restore) | `src/engine/revert.ts`, `tests/unit/rollback-trash.test.ts` | opus |
| 7. Node integration | 5 | `tests/integration/missing.test.ts` | sonnet |
| 8. workerd parity | 5 | `tests/integration-cf/parity.test.ts` | sonnet |
| 9. Review run and note | 0-8 | `docs/superpowers/notes/2026-11-12-m5c-review.md`, the roadmap; temporarily a D1 counter (removed) | opus |

The waves:
1. **1 ∥ 3.** No file is shared (Task 3 touches `revert.ts` only for `STEP_COST`).
2. **2 ∥ 6.** Task 2 touches `batch.ts`, `journal.ts`, `owner.ts` and `template.ts`; Task 6 only `revert.ts`. Task 6's tests write their journal rows directly, so they need neither Task 2 nor Task 4.
3. **4**
4. **5**
5. **7 ∥ 8.** Separate harnesses, files and ports.
6. **9**

Files touched by more than one task, merged in numeric order: `src/engine/batch.ts` (Tasks 2, 4, 5), `src/engine/missing.ts` (Tasks 4, 5), `src/engine/revert.ts` (Tasks 3, 6), `src/engine/template.ts` (Tasks 1, 2).

---

### Task 0: Verify the unconfirmed facts (V1-V8)

**Files:** none.

**Interfaces:**
- Consumes: the runtime handlers of spec F1, F2, F7 and F8, and plugin storage (spec F10, F11), through a temporary probe route; the M5a D1 counter.
- Produces: Facts V1-V8 and Rulings 1 and 3 (above). The Task 9 note records the results from the Facts table.

- [x] **V1**: trash keeps `_rev`, slug, status and schedule and hides the entry from reads; restore is fenced, gives a draft one `version` on, and a publish brings back the exact entry; a slot taken meanwhile is `CONFLICT`. Passed on both runtimes and collection kinds.
- [x] **V2**: unpublish leaves a draft pointer; the M5a sequence restores the entry at step 2. Passed.
- [x] **V3**: an unpublished entry that comes back is republished, written or unchanged, with and without `protectEdited`. Passed.
- [x] **V4**: the new index validates at once, materializes at the next tick, and the cursor visits every owned row once while rows are put. Passed.
- [x] **V5**: the seen query with 50 keys, paged, within D1's parameter limit. Passed.
- [x] **V6**: consecutive jobs sort by creation; same-millisecond IDs do not (Ruling 1). Passed with that amendment.
- [x] **V7**: trashing a translation leaves its source and leaves the group. Passed.
- [x] **V8**: per-call D1 counts measured; batch totals projected under 900. The batches are measured in Task 9.

### Task 1: Template rules, job options, types and the links index

**Files:**
- Modify: `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/engine/rules.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/src/plugin/xlsx.ts`, `packages/flux-import/src/sources/xlsx.ts`
- Test: `packages/flux-import/tests/unit/missing-template.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`, `packages/flux-import/tests/unit/xlsx-import.test.ts`

**Interfaces:**
- Consumes: `templateSchema`, `rulesSchema`, `createJob`, `CreateJobInput`, `ruled`, `STORAGE`, the `jobs/create` route, `convertXlsx`, `startImport`, `openXlsx`.
- Produces:
  - in `types.ts`:
    - `MissingAction = "trash" | "unpublish"`;
    - `LinkMissing = { jobId: string; action: MissingAction; at: string }`;
    - `MissingState = { stage: "count" | "act" | "done"; fromSeq: number; cursor?: string; owned: number; found: number; rows: number; removed: number; verdict?: "act" | "refused" | "skipped" }`;
    - `MISSING_MAX_PERCENT_DEFAULT = 25`;
    - `Job.missingLimit?: { maxPercent: number } | false`, `Job.unkeyed?: number`, `Job.missing?: MissingState`, `Job.phase` adds `"missing"`;
    - `Counters.removed?: number`;
    - `RecordStatus` adds `"removed"`, `RollbackAction` adds `"restore"`, and `RecordRow.action?: PlanAction | RollbackAction | MissingAction`;
    - `LinkRow.owner?`, `LinkRow.ownerSource?`, `LinkRow.missing?: LinkMissing`, the same three in `JournalBefore.link`;
    - `JournalEntry.kind: "create" | "update" | "trash"`;
  - in `template.ts`: `OWNER_PATTERN`, and `Template.rules.owner?` and `Template.rules.missing?: { action: MissingAction; maxPercent?: number }`;
  - in `jobs.ts`: `CreateJobInput.missing?: false | { maxPercent: number }`, `CreateJobInput.skippedRows?: number`, and `missingLimitOf(template, option): Job["missingLimit"]`;
  - in `rules.ts`: `ruled(t)` false for a template whose `rules` holds only `owner` and `missing` (Ruling 2);
  - `STORAGE.links.indexes` `["entryId", ["owner", "collection", "locale"]]`, and the capability `content:restore`;
  - the route option `missing` and the record status `removed` in `routes.ts`;
  - `XlsxSheet.skipped(): number`, `ConvertedSheet.skippedRows`, passed by `startImport` as `skippedRows`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/missing-template.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { createJob, missingLimitOf } from "../../src/engine/jobs.js";
import { ruled } from "../../src/engine/rules.js";
import { type SchemaField, templateSchema } from "../../src/engine/template.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { makeDeps } from "./fakes.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields: SchemaField[] = [{ slug: "title", type: "string" }];
const withRules = (rules?: unknown) => ({ ...base, ...(rules === undefined ? {} : { rules }) });
const parse = (rules: unknown) => templateSchema.safeParse(withRules(rules));

describe("rules.owner and rules.missing (M5c)", () => {
	it("accepts an owner and a missing rule, each optional", () => {
		expect(parse({ owner: "shop-feed", missing: { action: "unpublish", maxPercent: 10 } }).success).toBe(true);
		expect(parse({ owner: "a.b:c_d-1" }).success).toBe(true);
		expect(parse({ owner: "x".repeat(100), missing: { action: "trash" } }).success).toBe(true);
		expect(parse({ owner: "o", missing: { action: "trash", maxPercent: 0 } }).success).toBe(true);
		expect(parse({ owner: "o", missing: { action: "trash", maxPercent: 100 } }).success).toBe(true);
	});

	it("is strict and bounded", () => {
		for (const rules of [
			{ owner: "" },
			{ owner: "x".repeat(101) },
			{ owner: "shop feed" },
			{ owner: "ünï" },
			{ owner: 5 },
			{ missing: { action: "delete" } },
			{ missing: {} },
			{ missing: { action: "trash", maxPercent: 101 } },
			{ missing: { action: "trash", maxPercent: -1 } },
			{ missing: { action: "trash", maxPercent: 2.5 } },
			{ missing: { action: "trash", maxCount: 3 } },
			{ missing: { owner: "o", action: "trash" } },
		]) {
			expect(parse(rules).success, JSON.stringify(rules)).toBe(false);
		}
	});

	it("keeps the M5b record order for rules that hold only owner and missing", () => {
		const t = (rules?: unknown) => templateSchema.parse(withRules(rules));
		expect(ruled(t())).toBe(false);
		expect(ruled(t({}))).toBe(true);
		expect(ruled(t({ owner: "o" }))).toBe(false);
		expect(ruled(t({ owner: "o", missing: { action: "trash" } }))).toBe(false);
		expect(ruled(t({ owner: "o", mode: "update" }))).toBe(true);
		expect(ruled(t({ owner: "o", protectEdited: true }))).toBe(true);
	});

	it("declares the links index the phase queries by", () => {
		expect(STORAGE.links.indexes).toContainEqual(["owner", "collection", "locale"]);
	});
});

describe("jobs with rules.missing (M5c)", () => {
	async function create(rules: unknown, opts: Record<string, unknown> = {}) {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name\nA1,Desk\n");
		return createJob(deps, { uploadId: "u1", template: withRules(rules), schemaFields, ...opts });
	}

	it("refuses rules.missing without rules.owner", async () => {
		await expect(create({ missing: { action: "trash" } })).rejects.toMatchObject({
			code: "invalid_template",
			message: "rules.missing needs rules.owner",
		});
	});

	it("refuses the job option without rules.missing, and rules.missing without the journal", async () => {
		await expect(create({ owner: "o" }, { missing: false })).rejects.toMatchObject({
			code: "invalid_options",
			message: "The job option missing needs rules.missing in the template",
		});
		await expect(create(undefined, { missing: { maxPercent: 5 } })).rejects.toMatchObject({
			code: "invalid_options",
		});
		await expect(
			create({ owner: "o", missing: { action: "trash" } }, { journal: false }),
		).rejects.toMatchObject({
			code: "invalid_options",
			message: "rules.missing needs the journal, so its changes can be rolled back",
		});
		// A dry run keeps no journal, so journal: false does not matter to it.
		const dry = await create({ owner: "o", missing: { action: "trash" } }, { journal: false, dryRun: true });
		expect(dry.missingLimit).toEqual({ maxPercent: 25 });
		for (const maxPercent of [-1, 101, 2.5]) {
			await expect(
				create({ owner: "o", missing: { action: "trash" } }, { missing: { maxPercent } }),
			).rejects.toMatchObject({
				code: "invalid_options",
				message: "The job option missing.maxPercent must be an integer from 0 to 100",
			});
		}
	});

	it("resolves missingLimit from the template and the job option", async () => {
		expect(await create({ owner: "o" })).not.toHaveProperty("missingLimit");
		expect((await create({ owner: "o", missing: { action: "trash" } })).missingLimit).toEqual({
			maxPercent: 25,
		});
		expect(
			(await create({ owner: "o", missing: { action: "unpublish", maxPercent: 10 } })).missingLimit,
		).toEqual({ maxPercent: 10 });
		expect(
			(await create({ owner: "o", missing: { action: "trash", maxPercent: 10 } }, { missing: { maxPercent: 50 } }))
				.missingLimit,
		).toEqual({ maxPercent: 50 });
		expect(
			(await create({ owner: "o", missing: { action: "trash" } }, { missing: false })).missingLimit,
		).toBe(false);
	});

	it("stores the reader's skipped rows as unkeyed", async () => {
		expect((await create({ owner: "o", missing: { action: "trash" } }, { skippedRows: 2 })).unkeyed).toBe(2);
		expect(await create({ owner: "o" }, { skippedRows: 0 })).not.toHaveProperty("unkeyed");
	});

	it("is pure for missingLimitOf", () => {
		const t = templateSchema.parse(withRules({ owner: "o", missing: { action: "trash" } }));
		expect(missingLimitOf(t, undefined)).toEqual({ maxPercent: 25 });
		expect(missingLimitOf(t, false)).toBe(false);
		expect(missingLimitOf(templateSchema.parse(base), undefined)).toBeUndefined();
	});
});
````

In `packages/flux-import/tests/unit/definition.test.ts`, replace
````ts
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
````
with:
````ts
		expect(STORAGE.links.indexes).toEqual(["entryId", ["owner", "collection", "locale"]]);
````
and replace
````ts
			"content:publish",
			"schema:read",
````
with:
````ts
			"content:publish",
			"content:restore",
			"schema:read",
````
(If `definePlugin` reorders or adds implied capabilities, the run in Step 2 shows where; keep the list as `definePlugin` returns it, with `content:restore` after `content:publish`.)

In `packages/flux-import/tests/unit/xlsx-import.test.ts`, add at the end of the `describe("startImport", …)` block (before its closing `});`):
````ts
	it("passes the rows the converter skipped to the job as unkeyed (M5c)", async () => {
		const { deps, staging, stage } = setup();
		const header = row(
			1,
			'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c>',
		);
		const rows =
			header +
			row(2, '<c r="A2" t="inlineStr"><is><t>K1</t></is></c><c r="B2" t="inlineStr"><is><t>One</t></is></c>') +
			// 29 February 1900 with a date style: unreadable, and the row's only value.
			row(3, '<c r="A3" s="1"><v>60</v></c>');
		const book = await stage(await workbook({ sheets: [{ name: "Sheet1", rows }], cellXfs: [0, 14] }));
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xlsx" },
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
			rules: { owner: "o", missing: { action: "trash" } },
		};
		const job = await startImport(deps, staging, { uploadId: book, template, dryRun: false }, fields);
		expect(job.unkeyed).toBe(1);
		expect(job.warnings).toContain("1 row had only unreadable cells and was skipped (first at row 3)");
	});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing-template.test.ts tests/unit/definition.test.ts tests/unit/xlsx-import.test.ts`
Expected: FAIL. The schema refuses `owner` and `missing`, `missingLimitOf` does not exist, the index and capability are not declared, and `job.unkeyed` is undefined.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	/** Rollback jobs: rows reverted, or that a dry run would revert. Absent on imports (read as 0). */
	reverted?: number;
}
````
with:
````ts
	/** Rollback jobs: rows reverted, or that a dry run would revert. Absent on imports (read as 0). */
	reverted?: number;
	/**
	 * Import jobs (M5c): entries the missing phase moved to Trash or unpublished, or that a dry run
	 * would. Absent until the first one (read as 0).
	 */
	removed?: number;
}

/** What the missing phase does to an owned entry the feed no longer holds (M5c). */
export type MissingAction = "trash" | "unpublish";

/** The mark the missing phase leaves on a link it acted on (M5c); any import write clears it. */
export type LinkMissing = { jobId: string; action: MissingAction; at: string };

/** The default `rules.missing.maxPercent` (spec M5c, Ruling 7). */
export const MISSING_MAX_PERCENT_DEFAULT = 25;

/** The missing phase's state on its job (spec M5c "Template and job"). */
export interface MissingState {
	stage: "count" | "act" | "done";
	/** The first seq of the phase's rows: the import's record count. */
	fromSeq: number;
	/** The links query cursor within the stage; absent at a stage's start. */
	cursor?: string;
	/** Count stage: candidate links. */
	owned: number;
	/** Count stage: unseen candidates whose entry exists. */
	found: number;
	/** Act stage: rows written. */
	rows: number;
	/** Act stage: entries trashed or unpublished (or planned); recounted at each act batch. */
	removed: number;
	verdict?: "act" | "refused" | "skipped";
}
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	revisions?: boolean;
	uploadId: string;
````
with:
````ts
	revisions?: boolean;
	/**
	 * M5c: the missing phase's threshold, resolved at job creation from `rules.missing` and the job
	 * option `missing` (`false`: the option turned the phase off). Absent without `rules.missing`.
	 */
	missingLimit?: { maxPercent: number } | false;
	/**
	 * M5c: first-pass rows without a readable key, the rows the XLSX converter skipped included.
	 * Any skips the missing phase (spec "When it runs"). Absent: 0.
	 */
	unkeyed?: number;
	/** M5c: the missing phase; absent until the job's first pass completes. */
	missing?: MissingState;
	uploadId: string;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	phase: "import" | "retry";
````
with:
````ts
	phase: "import" | "retry" | "missing";
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	| "filtered"
	| "reverted";

/** What a rollback row does to its entry (M5a). */
export type RollbackAction = "delete" | "trash" | "revert";
````
with:
````ts
	| "filtered"
	| "reverted"
	| "removed";

/** What a rollback row does to its entry (M5a); M5c adds `restore`, for a `trash` journal row. */
export type RollbackAction = "delete" | "trash" | "revert" | "restore";
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	action?: PlanAction | RollbackAction;
````
with:
````ts
	action?: PlanAction | RollbackAction | MissingAction;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	 * the schedule it set, or one an update kept. Absent when none.
	 */
	scheduledAt?: string;
}
````
with:
````ts
	 * the schedule it set, or one an update kept. Absent when none.
	 */
	scheduledAt?: string;
	/**
	 * M5c: the `rules.owner` of the template whose job created the entry. Kept by link saves of
	 * that owner, dropped by any record of another owner or of none (spec "Owner").
	 */
	owner?: string;
	/** M5c: the URL source of the job that stamped `owner`; absent for uploads and pastes. */
	ownerSource?: string;
	/** M5c: the missing phase moved the entry to Trash or unpublished it. */
	missing?: LinkMissing;
}
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
		unconfirmed?: string[];
		scheduledAt?: string;
	} | null;
````
with:
````ts
		unconfirmed?: string[];
		scheduledAt?: string;
		/** M5c: the owner stamp and missing mark, restored with the rest of the link. */
		owner?: string;
		ownerSource?: string;
		missing?: LinkMissing;
	} | null;
````

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	kind: "create" | "update";
````
with:
````ts
	/** `trash` (M5c): the missing phase moved the entry to Trash; `entryId` and `before` are set. */
	kind: "create" | "update" | "trash";
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
/** How each record treats the entry it matches (M5b); every rule is optional. */
const rulesSchema = z
	.object({
		mode: z.enum(["upsert", "create", "update"]).optional(),
		updateFields: z.array(z.string().min(1).max(200)).min(1).max(MAX_UPDATE_FIELDS).optional(),
		protectEdited: z.boolean().optional(),
	})
	.strict();
````
with:
````ts
/** A `rules.owner` name (M5c): it is stored on every owned link row and used as a query value. */
export const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * How each record treats the entry it matches (M5b), and the entries a later feed no longer
 * holds (M5c); every rule is optional.
 *
 * `owner` (M5c) names the entries this template's jobs create; `missing` needs it. One owner
 * name, one feed: two templates with the same owner, collection and locale act as one import,
 * each one's missing phase treating the other's entries as its own. The phase refuses when it
 * can tell that two URL sources share the owner; it cannot tell for uploads and pastes. With the
 * default `maxPercent` of 25, an owner with fewer than four entries refuses as soon as one is
 * missing (1 of 3 is 34%), and one with four accepts one. Feeds whose items come back should use
 * `unpublish`: a trashed entry whose key returns stays a `missing_trashed` conflict until it is
 * restored. A refused run is re-run with the job option `missing: { maxPercent }`, for an
 * unchanged URL source also with `force: true`.
 */
const rulesSchema = z
	.object({
		mode: z.enum(["upsert", "create", "update"]).optional(),
		updateFields: z.array(z.string().min(1).max(200)).min(1).max(MAX_UPDATE_FIELDS).optional(),
		protectEdited: z.boolean().optional(),
		owner: z
			.string()
			.regex(OWNER_PATTERN, "An owner is 1-100 characters of A-Z, a-z, 0-9, '.', '_', ':' and '-'")
			.optional(),
		missing: z
			.object({
				action: z.enum(["trash", "unpublish"]),
				maxPercent: z.number().int().min(0).max(100).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
````

In `packages/flux-import/src/engine/rules.ts`, replace
````ts
export function ruled(t: Template): boolean {
	return t.rules !== undefined || t.publishAt !== undefined;
}
````
with:
````ts
export function ruled(t: Template): boolean {
	// M5c: `owner` and `missing` do not change a record's order (plan Ruling 2).
	const keys = Object.keys(t.rules ?? {});
	const onlyM5c = keys.length > 0 && keys.every((k) => k === "owner" || k === "missing");
	return (t.rules !== undefined && !onlyM5c) || t.publishAt !== undefined;
}
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	/** Whether the collection keeps revisions (M5b), for templates that map `publishAt`; default true. */
	revisions?: boolean;
};
````
with:
````ts
	/** Whether the collection keeps revisions (M5b), for templates that map `publishAt`; default true. */
	revisions?: boolean;
	/**
	 * M5c: `false` skips the missing phase for this run; `{ maxPercent }` replaces the template's
	 * threshold for this run. Only with `rules.missing`.
	 */
	missing?: false | { maxPercent: number };
	/** M5c, XLSX: rows the converter skipped because their only values were unreadable. */
	skippedRows?: number;
};

/**
 * The job's missing-phase threshold (M5c): absent without `rules.missing`, `false` when the job
 * option turns the phase off, else the option's `maxPercent` or the template's (default 25).
 */
export function missingLimitOf(
	template: Template,
	option: CreateJobInput["missing"],
): Job["missingLimit"] {
	const rule = template.rules?.missing;
	if (rule === undefined) return undefined;
	if (option === false) return false;
	return { maxPercent: option?.maxPercent ?? rule.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT };
}
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	type Job,
	type JobStatus,
} from "./types.js";
````
with:
````ts
	type Job,
	type JobStatus,
	MISSING_MAX_PERCENT_DEFAULT,
} from "./types.js";
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	if (template.publishAt !== undefined && input.publish === false) {
		throw new JobError("invalid_options", "publishAt needs publish: true");
	}
````
with:
````ts
	if (template.publishAt !== undefined && input.publish === false) {
		throw new JobError("invalid_options", "publishAt needs publish: true");
	}
	// M5c (spec "Template and job"): the refusals of rules.missing and the job option missing.
	if (template.rules?.missing !== undefined && template.rules.owner === undefined) {
		throw new JobError("invalid_template", "rules.missing needs rules.owner");
	}
	if (input.missing !== undefined && template.rules?.missing === undefined) {
		throw new JobError(
			"invalid_options",
			"The job option missing needs rules.missing in the template",
		);
	}
	const percent = input.missing === undefined || input.missing === false ? 0 : input.missing.maxPercent;
	if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
		throw new JobError(
			"invalid_options",
			"The job option missing.maxPercent must be an integer from 0 to 100",
		);
	}
	if (template.rules?.missing !== undefined && !input.dryRun && input.journal === false) {
		throw new JobError(
			"invalid_options",
			"rules.missing needs the journal, so its changes can be rolled back",
		);
	}
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
	const now = new Date(deps.now()).toISOString();
	const dryRun = input.dryRun ?? false;
````
with:
````ts
	const now = new Date(deps.now()).toISOString();
	const dryRun = input.dryRun ?? false;
	const missingLimit = missingLimitOf(template, input.missing);
````

In `packages/flux-import/src/engine/jobs.ts`, replace
````ts
		...(template.publishAt === undefined ? {} : { revisions: input.revisions ?? true }),
		uploadId: input.uploadId,
````
with:
````ts
		...(template.publishAt === undefined ? {} : { revisions: input.revisions ?? true }),
		...(missingLimit === undefined ? {} : { missingLimit }),
		...(input.skippedRows ? { unkeyed: input.skippedRows } : {}),
		uploadId: input.uploadId,
````

In `packages/flux-import/src/plugin/definition.ts`, replace
````ts
	links: { indexes: ["entryId"] },
````
with:
````ts
	// M5c: the missing phase pages an owner's links in the template's collection and locale.
	links: { indexes: ["entryId", ["owner", "collection", "locale"]] },
````
and replace
````ts
		// own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through ctx.http,
		// so no network capability is declared.
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
````
with:
````ts
		// own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through ctx.http,
		// so no network capability is declared. content:restore (M5c) is declared for disclosure
		// too: a rollback of the missing phase restores trashed entries through the runtime's
		// handleContentRestore, not ctx.content (emdash src/plugins/manifest-schema.ts:37).
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
			"content:restore",
````

In `packages/flux-import/src/plugin/routes.ts`, replace
````ts
	"filtered",
	"reverted",
] as const satisfies readonly RecordStatus[];
````
with:
````ts
	"filtered",
	"reverted",
	"removed",
] as const satisfies readonly RecordStatus[];
````
and replace
````ts
		/** Keep a journal so the job can be rolled back (M5a); default true. */
		journal: z.boolean().optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
````
with:
````ts
		/** Keep a journal so the job can be rolled back (M5a); default true. */
		journal: z.boolean().optional(),
		/** M5c: skip the missing phase for this run, or replace its threshold. */
		missing: z
			.union([z.literal(false), z.object({ maxPercent: z.number().int().min(0).max(100) }).strict()])
			.optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
````
and replace
````ts
					...(input.journal === undefined ? {} : { journal: input.journal }),
````
with:
````ts
					...(input.journal === undefined ? {} : { journal: input.journal }),
					...(input.missing === undefined ? {} : { missing: input.missing }),
````

In `packages/flux-import/src/sources/xlsx.ts`, replace
````ts
	/** Header renames, then cells ignored or unreadable so far: all of them once `lines` is done. */
	warnings(): string[];
}
````
with:
````ts
	/** Header renames, then cells ignored or unreadable so far: all of them once `lines` is done. */
	warnings(): string[];
	/** M5c: rows skipped so far because their only values were unreadable (spec P2). */
	skipped(): number;
}
````
and replace
````ts
	return {
		columns: names,
		lines: lines(),
		warnings: () => [
````
with:
````ts
	return {
		columns: names,
		lines: lines(),
		skipped: () => converter.skipped,
		warnings: () => [
````

In `packages/flux-import/src/plugin/xlsx.ts`, replace
````ts
export interface ConvertedSheet {
	uploadId: string;
	columns: string[];
	warnings: string[];
}
````
with:
````ts
export interface ConvertedSheet {
	uploadId: string;
	columns: string[];
	warnings: string[];
	/** M5c: rows skipped with only unreadable cells, which the job counts as unkeyed. */
	skippedRows: number;
}
````
and replace
````ts
	return { uploadId: staged.uploadId, columns: sheet.columns, warnings: sheet.warnings() };
````
with:
````ts
	return {
		uploadId: staged.uploadId,
		columns: sheet.columns,
		warnings: sheet.warnings(),
		skippedRows: sheet.skipped(),
	};
````
and replace
````ts
				columns: converted.columns,
				warnings: converted.warnings,
			},
````
with:
````ts
				columns: converted.columns,
				warnings: converted.warnings,
				...(converted.skippedRows > 0 ? { skippedRows: converted.skippedRows } : {}),
			},
````

Any other implementation of `XlsxSheet` or literal `ConvertedSheet` that `pnpm typecheck` reports (test doubles included) gains `skipped: () => 0` or `skippedRows: 0`.

- [ ] **Step 4: Run them to see them pass**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing-template.test.ts tests/unit/definition.test.ts tests/unit/xlsx-import.test.ts`
Expected: PASS (the 10 new tests, and every earlier test of the three files).

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/types.ts packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/engine/rules.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/src/plugin/xlsx.ts packages/flux-import/src/sources/xlsx.ts packages/flux-import/tests/unit/missing-template.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/xlsx-import.test.ts
git commit -m "Add rules.owner, rules.missing and the job option missing, with the links index and content:restore"
```

### Task 2: Owner stamps, keys of failed records, `unkeyed` and `missing_trashed`

**Files:**
- Create: `packages/flux-import/src/engine/owner.ts`
- Modify: `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/engine/journal.ts`, `packages/flux-import/src/engine/template.ts`
- Test: `packages/flux-import/tests/unit/owner.test.ts` (new), `packages/flux-import/tests/unit/missing-keys.test.ts` (new); failed-row expectations in existing tests (Step 4)

**Interfaces:**
- Consumes: Task 1's `Template.rules.owner`, `LinkRow.owner`/`ownerSource`/`missing`, `JournalBefore.link`, `Job.unkeyed`, `Job.sourceId`; `putLink`, `refreshFields`, `entryByLink`, `decide`, `decideRecord`, `writeRecord`, `processRecord`, `linkBefore`, `applyTemplate`; the rollback fixture.
- Produces:
  - `src/engine/owner.ts`:
    - `ownerOf(job: Job): string | undefined`;
    - `foreignStamp(job: Job, link: LinkRow | null): boolean`;
    - `ownership(job: Job, stored: LinkRow | null, stamp: boolean): Pick<LinkRow, "owner" | "ownerSource">`;
    - `withoutStamp(link: LinkRow): LinkRow`;
  - `linkBefore(link: LinkRow)` exported from `journal.ts`, copying `owner`, `ownerSource` and `missing`;
  - `applyTemplate`'s failure `{ ok: false; errors; warnings?; key?: string }`, with `key` when the key was read and valid;
  - a failed record row with `sourceKey` set to that key;
  - `Job.unkeyed` bumped for a first-pass row saved `failed` with `sourceKey: null`;
  - `RecordCtx.read`, `RecordCtx.linkPut`, `RecordCtx.stamp`, and `Found.ctx`;
  - the conflict `missing_trashed`, with `MISSING_TRASHED_MESSAGE(jobId)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/owner.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import { journalKey, type LinkRow, type RecordRow, recordKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";
import {
	csv,
	type Deps,
	entryOf,
	importRows,
	journalOf,
	type Row,
	records,
	runToEnd,
	setup,
	start,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10, tags: "new", authors: "alex" };
const lamp: Row = { sku: "B2", name: "Lamp", price: 5, tags: "sale", authors: "sam" };
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const owned = (owner: string, rules: Record<string, unknown> = {}) => ({
	extra: { rules: { owner, ...rules } },
});
/** Lists the link rows each save names. */
const countPuts = (deps: Deps) => {
	const puts: string[] = [];
	const put = deps.links.put.bind(deps.links);
	deps.links.put = async (id: string, row: LinkRow) => {
		puts.push(id);
		return put(id, row);
	};
	return puts;
};

describe("stamping the owner (M5c)", () => {
	it("stamps a create, with the URL source, and keeps the stamp on the same owner's writes", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { ...owned("shop"), sourceId: "src1" });
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop", ownerSource: "src1" });
		await importRows(deps, [{ ...desk, price: 11 }], owned("shop"));
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop", ownerSource: "src1" });
		// An unchanged record of the same owner puts nothing.
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 11 }], owned("shop"));
		expect(puts).toEqual([]);
	});

	it("stamps no entry without rules.owner, and never adopts one", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
		await importRows(deps, [{ ...desk, price: 12 }], owned("shop"));
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
	});

	/** A stop right after the create returned: the job's link put fails once. */
	async function stopAfterCreate(deps: Deps, clock: { t: number }, jobId: string) {
		const put = deps.links.put.bind(deps.links);
		deps.links.put = async () => {
			throw new Error("stop");
		};
		await expect(runBatch(deps, jobId, "h1")).rejects.toThrow("stop");
		deps.links.put = put;
		// The lease of the stopped batch expires.
		clock.t += LEASE_GRACE_MS + 60_000;
	}

	it("stamps crash repair of a create its writing row names", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		await stopAfterCreate(deps, clock, job.id);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "writing", action: "create" });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop" });
	});

	it("stamps crash repair of a create the journal confirms", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		await stopAfterCreate(deps, clock, job.id);
		// The row lost the entry ID (a stop before its save); the journal still names the create.
		const key = recordKey(job.id, 0);
		const row = (await deps.records.get(key)) as RecordRow;
		await deps.records.put(key, { ...row, entryId: null });
		expect((await journalOf(deps, job.id))[0]).toMatchObject({ kind: "create", confirmed: true });
		await runToEnd(deps, job.id);
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "shop" });
	});

	it("does not stamp an entry crash repair adopted by its source ID alone", async () => {
		const { deps, clock } = setup();
		const job = await start(deps, csv([desk]), owned("shop"));
		// A stop inside the create: the journal row never learns the entry.
		deps.content.afterWrite = () => {
			throw new Error("stop");
		};
		await expect(runBatch(deps, job.id, "h1")).rejects.toThrow("stop");
		deps.content.afterWrite = () => {};
		clock.t += LEASE_GRACE_MS + 60_000;
		await runToEnd(deps, job.id);
		const link = await linkOf(deps, "A1");
		expect(link.entryId).toBe(entryOf(deps, "A1").id);
		expect(link).not.toHaveProperty("owner");
	});

	it("stamps a linked create", async () => {
		const { deps } = makeDeps();
		deps.content.sharedFields.add("sku");
		const fields: SchemaField[] = [
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
		const french = {
			...english,
			locale: "fr",
			translationOf: { from: "en_id", locale: "en" },
			rules: { owner: "fr-feed" },
		};
		deps.source.add("en", "id,Name\nE1,Desk\n");
		deps.source.add("fr", "id,en_id,Name\nF1,E1,Bureau\n");
		const en = await createJob(deps, { uploadId: "en", template: english, schemaFields: fields });
		await runToEnd(deps, en.id);
		const fr = await createJob(deps, { uploadId: "fr", template: french, schemaFields: fields });
		expect((await runToEnd(deps, fr.id)).counters).toMatchObject({ created: 1 });
		expect(await deps.links.get("products:fr:F1")).toMatchObject({ owner: "fr-feed" });
	});
});

/**
 * The required sequence (spec Ruling 21): template A (owner a) creates K; a record of template B
 * (owner b, and again with no owner) reaches K's link and, whatever its outcome, drops the stamp
 * with exactly one link put.
 */
describe("dropping a foreign stamp (M5c, Ruling 21)", () => {
	const outcomes: [string, (deps: Deps) => Promise<void>, Row, Record<string, unknown>, string][] = [
		["unchanged", async () => {}, desk, {}, "unchanged"],
		["skipped by mode create", async () => {}, { ...desk, price: 99 }, { mode: "create" }, "unchanged"],
		[
			"skipped by mode update (the entry is gone)",
			async (deps) => {
				deps.content.entries.delete(entryOf(deps, "A1").id);
			},
			desk,
			{ mode: "update" },
			"unchanged",
		],
		[
			"protected on every difference",
			async (deps) => {
				const e = entryOf(deps, "A1");
				await deps.content.update({ collection: "products", locale: "en", id: e.id, rev: deps.content.revOf(e.id), data: { price: 42 } });
				await deps.content.publish({ id: e.id, rev: deps.content.revOf(e.id) });
			},
			{ ...desk, price: 43 },
			{ protectEdited: true },
			"unchanged",
		],
		[
			"pending_draft",
			async (deps) => {
				const e = entryOf(deps, "A1");
				await deps.content.update({ collection: "products", locale: "en", id: e.id, rev: deps.content.revOf(e.id), data: { price: 42 } });
			},
			{ ...desk, price: 43 },
			{},
			"conflict",
		],
		[
			"locked",
			async (deps) => {
				deps.content.locked.add(entryOf(deps, "A1").id);
			},
			{ ...desk, price: 43 },
			{},
			"locked",
		],
	];

	for (const owner of ["b", undefined]) {
		for (const [name, prepare, row, rules, status] of outcomes) {
			it(`drops it when B (${owner ?? "no owner"}) is ${name}`, async () => {
				const { deps } = setup();
				await importRows(deps, [desk], owned("a"));
				await prepare(deps);
				const before = await linkOf(deps, "A1");
				const puts = countPuts(deps);
				const job = await importRows(deps, [row], {
					extra: { rules: { ...(owner ? { owner } : {}), ...rules } },
				});
				expect((await records(deps, job.id))[0]?.status).toBe(status);
				const after = await linkOf(deps, "A1");
				expect(after).not.toHaveProperty("owner");
				expect(after).not.toHaveProperty("ownerSource");
				expect(puts.filter((id) => id === "products:en:A1")).toHaveLength(1);
				// The link still names the entry, job and revision it did.
				expect(after).toMatchObject({
					entryId: before.entryId,
					jobId: before.jobId,
					writtenRev: before.writtenRev,
				});
			});
		}
	}

	it("drops it when B writes the entry, and puts the link only once", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], owned("a"));
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 20 }], owned("b"));
		expect(await linkOf(deps, "A1")).not.toHaveProperty("owner");
		// The write's own link saves (written, published), no extra put for the stamp.
		expect(puts.every((id) => id === "products:en:A1")).toBe(true);
		const job = await importRows(deps, [{ ...desk, price: 20 }], owned("b"));
		expect(job.counters).toMatchObject({ unchanged: 1 });
	});

	it("drops nothing in a dry run of B", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], owned("a"));
		const puts = countPuts(deps);
		await importRows(deps, [{ ...desk, price: 20 }, lamp], { ...owned("b"), dryRun: true });
		expect(puts).toEqual([]);
		expect(await linkOf(deps, "A1")).toMatchObject({ owner: "a" });
	});
});

describe("the journal's link snapshot (M5c)", () => {
	it("keeps the owner, its source and the missing mark", async () => {
		const { deps } = setup();
		await importRows(deps, [desk], { ...owned("a"), sourceId: "src1" });
		const linkId = "products:en:A1";
		const link = await linkOf(deps, "A1");
		await deps.links.put(linkId, {
			...link,
			missing: { jobId: "id00000099", action: "unpublish", at: "2026-10-07T10:00:00.000Z" },
		});
		const job = await importRows(deps, [{ ...desk, price: 30 }], owned("a"));
		const [row] = await journalOf(deps, job.id);
		expect(row?.before?.link).toMatchObject({
			owner: "a",
			ownerSource: "src1",
			missing: { jobId: "id00000099", action: "unpublish" },
		});
		// The write cleared the mark (spec Ruling 14) and kept the owner.
		const after = await linkOf(deps, "A1");
		expect(after).not.toHaveProperty("missing");
		expect(after).toMatchObject({ owner: "a" });
		expect(await deps.journal.get(journalKey(job.id, linkId))).not.toBeNull();
	});
});
````

In `packages/flux-import/tests/unit/rollback-fixture.ts`, replace
````ts
	/** M5b: whether the collection keeps revisions, for templates that map publishAt. */
	revisions?: boolean;
	extra?: Record<string, unknown>;
};
````
with:
````ts
	/** M5b: whether the collection keeps revisions, for templates that map publishAt. */
	revisions?: boolean;
	/** M5c: the URL source the job's file came from (`Job.sourceId`). */
	sourceId?: string;
	/** M5c: the job option `missing`. */
	missing?: false | { maxPercent: number };
	extra?: Record<string, unknown>;
};
````

Create `packages/flux-import/tests/unit/missing-keys.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { applyTemplate, compileTemplate, templateSchema } from "../../src/engine/template.js";
import type { LinkRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	setup,
	start,
	runToEnd,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10 };

describe("the key of a record that fails later (M5c, Ruling 24)", () => {
	const compiled = () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { price: { from: "Price", type: "number" } },
		});
		const c = compileTemplate(t);
		if (!c.ok) throw new Error(c.problems.join("; "));
		return c.compiled;
	};

	it("returns the key with a later mapping's error", async () => {
		expect(await applyTemplate(compiled(), { sku: " A1 ", Price: "n/a" })).toMatchObject({
			ok: false,
			key: "A1",
			errors: [{ field: "price" }],
		});
	});

	it("returns no key when the key itself fails", async () => {
		for (const sku of [undefined, "", "  ", { a: 1 }, "x".repeat(10_000)]) {
			const result = await applyTemplate(compiled(), { sku, Price: "n/a" });
			expect(result.ok).toBe(false);
			expect(result, JSON.stringify(sku)).not.toHaveProperty("key");
		}
	});

	it("saves the key on the failed row", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [{ ...desk, price: "n/a" as never }]);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "failed", sourceKey: "A1" });
		expect(job).not.toHaveProperty("unkeyed");
	});
});

describe("unkeyed (M5c, Rulings 24 and 25)", () => {
	it("counts reader errors, filter errors and key errors, not failures after the key", async () => {
		const { deps } = setup();
		const body =
			"sku,Name,Price,Featured,Img,Related,Tags,Authors\n" +
			"A1,Desk,10,,,,,\n" + // fine
			",NoKey,1,,,,,\n" + // missing_key
			"B2,Lamp,n/a,,,,,\n" + // fails after its key
			"C3,Short\n"; // column_count: a reader error
		const job = await start(deps, body);
		const done = await runToEnd(deps, job.id);
		expect(done.unkeyed).toBe(2);
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.sourceKey])).toEqual([
			["created", "A1"],
			["failed", null],
			["failed", "B2"],
			["failed", null],
		]);
	});

	it("counts a filter error as unkeyed and a filtered record not at all", async () => {
		const { deps } = setup();
		const body = "sku,Name,Price,Featured,Img,Related,Tags,Authors\nA1,Desk,10,,,,,\nB2,Lamp,5,,,,,\n";
		const filtered = await runToEnd(deps, (await start(deps, body, { extra: { source: { format: "csv", filter: "$number(Price) > 6" } } })).id);
		expect(filtered.counters.filtered).toBe(1);
		expect(filtered).not.toHaveProperty("unkeyed");
		const broken = await runToEnd(deps, (await start(deps, body, { extra: { source: { format: "csv", filter: "$error('x')" } } })).id);
		expect(broken.unkeyed).toBe(2);
	});

	it("counts blank CSV lines not at all", async () => {
		const { deps } = setup();
		const body = "sku,Name,Price,Featured,Img,Related,Tags,Authors\nA1,Desk,10,,,,,\n\n\nB2,Lamp,5,,,,,\n";
		const job = await runToEnd(deps, (await start(deps, body)).id);
		expect(job.counters.created).toBe(2);
		expect(job).not.toHaveProperty("unkeyed");
	});
});

describe("a key whose entry the import moved to Trash (M5c, Ruling 15)", () => {
	const mark = async (deps: Deps, key: string, action: "trash" | "unpublish") => {
		const id = `products:en:${key}`;
		const link = (await deps.links.get(id)) as LinkRow;
		await deps.links.put(id, {
			...link,
			missing: { jobId: "id00000042", action, at: "2026-10-07T10:00:00.000Z" },
		});
	};

	it("is a conflict, with no read and no create, also in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await mark(deps, "A1", "trash");
		await deps.content.trash("products", entryOf(deps, "A1").id);
		deps.content.calls.length = 0;
		for (const dryRun of [false, true]) {
			const job = await importRows(deps, [desk], { dryRun });
			const [row] = await records(deps, job.id);
			expect(row).toMatchObject({
				status: "conflict",
				sourceKey: "A1",
				errors: [
					{
						code: "missing_trashed",
						message:
							"Not imported: the import moved this entry to Trash because it was missing from an earlier feed (job id00000042); restore it from Trash, or roll that job back, then retry",
					},
				],
			});
		}
		expect(deps.content.calls.filter((c) => c.startsWith("create:") || c.startsWith("find:"))).toEqual([]);
	});

	it("imports as usual once the entry is restored by hand, or for an unpublish mark", async () => {
		const { deps } = setup();
		await importRows(deps, [desk, { sku: "B2", name: "Lamp", price: 5 }]);
		await mark(deps, "B2", "unpublish");
		const job = await importRows(deps, [desk, { sku: "B2", name: "Lamp", price: 6 }]);
		expect(job.counters).toMatchObject({ unchanged: 1, updated: 1, conflict: 0 });
		expect(await deps.links.get("products:en:B2")).not.toHaveProperty("missing");
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/owner.test.ts tests/unit/missing-keys.test.ts`
Expected: FAIL. No link carries `owner`, `applyTemplate` returns no `key`, failed rows have `sourceKey: null`, `unkeyed` is undefined, and a trashed key creates an entry again.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/engine/owner.ts`:
````ts
/**
 * The owner stamp on a link row (spec M5c "Owner"): which template's jobs created the entry, so
 * that template's missing phase may remove it. Only a create stamps it, a link save of the same
 * owner keeps it, and any record of another owner, or of none, drops it.
 */
import type { Job, LinkRow } from "./types.js";

/** The job's `rules.owner`; undefined when its template names none. */
export function ownerOf(job: Job): string | undefined {
	return job.template.rules?.owner;
}

/** Whether the link carries an owner stamp that is not this job's (Rulings 2, 21). */
export function foreignStamp(job: Job, link: LinkRow | null): boolean {
	return link?.owner !== undefined && link.owner !== ownerOf(job);
}

/**
 * The owner fields a link save of this job carries: the job's owner and URL source when it
 * created the entry (`stamp`), the stored ones when the stored link has the job's owner, else
 * none, which drops a foreign stamp.
 */
export function ownership(
	job: Job,
	stored: LinkRow | null,
	stamp: boolean,
): Pick<LinkRow, "owner" | "ownerSource"> {
	const owner = ownerOf(job);
	if (owner === undefined) return {};
	if (stamp) return { owner, ...(job.sourceId === undefined ? {} : { ownerSource: job.sourceId }) };
	if (stored?.owner !== owner) return {};
	return {
		owner,
		...(stored.ownerSource === undefined ? {} : { ownerSource: stored.ownerSource }),
	};
}

/** The link without its owner stamp, every other field kept. */
export function withoutStamp(link: LinkRow): LinkRow {
	const { owner: _owner, ownerSource: _source, ...rest } = link;
	return rest;
}
````

In `packages/flux-import/src/engine/journal.ts`, replace
````ts
function linkBefore(link: LinkRow): NonNullable<JournalBefore["link"]> {
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
		...(link.fields === undefined ? {} : { fields: link.fields }),
		...(link.unconfirmed === undefined ? {} : { unconfirmed: link.unconfirmed }),
		...(link.scheduledAt === undefined ? {} : { scheduledAt: link.scheduledAt }),
	};
}
````
with:
````ts
/** The link row as a journal pre-image keeps it (M5a), with M5b's and M5c's fields. */
export function linkBefore(link: LinkRow): NonNullable<JournalBefore["link"]> {
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
		...(link.fields === undefined ? {} : { fields: link.fields }),
		...(link.unconfirmed === undefined ? {} : { unconfirmed: link.unconfirmed }),
		...(link.scheduledAt === undefined ? {} : { scheduledAt: link.scheduledAt }),
		...(link.owner === undefined ? {} : { owner: link.owner }),
		...(link.ownerSource === undefined ? {} : { ownerSource: link.ownerSource }),
		...(link.missing === undefined ? {} : { missing: link.missing }),
	};
}
````

In `packages/flux-import/src/engine/template.ts`, replace
````ts
	| { ok: false; errors: ValueError[]; warnings?: ValueWarning[] }
> {
	const t = c.template;
````
with:
````ts
	| { ok: false; errors: ValueError[]; warnings?: ValueWarning[]; key?: string }
> {
	const t = c.template;
````
and replace
````ts
	let translationOf: string | undefined;
	// A value that cannot be read still names a source: the record fails, without reading the
````
with:
````ts
	// M5c (Ruling 24): the key is the first mapping read, so it was read and is valid exactly when
	// no error was pushed so far; a record with such a key is in the feed whatever else fails.
	const keyRead = keyRaw !== FAILED && errors.length === 0;
	let translationOf: string | undefined;
	// A value that cannot be read still names a source: the record fails, without reading the
````
and replace
````ts
	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported };
````
with:
````ts
	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported, ...(keyRead ? { key } : {}) };
````

In `packages/flux-import/src/engine/batch.ts`, add to the imports:
````ts
import { foreignStamp, ownerOf, ownership, withoutStamp } from "./owner.js";
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
}
````
with:
````ts
	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
	if (!opts.retry && unkeyedRow(row)) job.unkeyed = (job.unkeyed ?? 0) + 1;
}

/** M5c: a row whose record had no readable key (a reader, filter or key error). */
function unkeyedRow(row: Pick<RecordRow, "status" | "sourceKey">): boolean {
	return row.status === "failed" && row.sourceKey === null;
}
````

In the same function, replace
````ts
		const counter = counterFor(existing);
		if (counter) bump(job.counters, counter);
		return;
	}
````
(the crash path at the top of `processRecord`) with:
````ts
		const counter = counterFor(existing);
		if (counter) bump(job.counters, counter);
		if (unkeyedRow(existing)) job.unkeyed = (job.unkeyed ?? 0) + 1;
		return;
	}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
````
with:
````ts
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
	/**
	 * M5c: the link row as `entryByLink` read it, before crash repair; null until then. A foreign
	 * owner stamp on it is dropped once the record is decided (`settleOwner`).
	 */
	read: LinkRow | null;
	/** M5c: a link put of this record happened (a save, a refresh or a repair). */
	linkPut: boolean;
	/** M5c: this job created the entry, so its link saves stamp the owner (spec "Owner"). */
	stamp: boolean;
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
		...(ctx.unconfirmed?.length ? { unconfirmed: ctx.unconfirmed } : {}),
		...(scheduledAt === null ? {} : { scheduledAt }),
	});
````
with:
````ts
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	ctx.linkPut = true;
	// M5c: the owner as this job's create stamps it or its own owner keeps it; a write never
	// carries the missing mark (spec Ruling 14).
	const stored = ctx.stored?.entryId === entryId ? ctx.stored : null;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
		...(ctx.unconfirmed?.length ? { unconfirmed: ctx.unconfirmed } : {}),
		...(scheduledAt === null ? {} : { scheduledAt }),
		...ownership(ctx.job, stored, ctx.stamp),
	});
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	if (same && sameFields(stored.fields, ctx.fields)) return;
	const { unconfirmed: _old, ...rest } = stored;
	await ctx.deps.links.put(ctx.linkId, {
		...rest,
		fields: ctx.fields,
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
	});
}
````
with:
````ts
	const foreign = foreignStamp(ctx.job, stored);
	if (same && sameFields(stored.fields, ctx.fields) && !foreign) return;
	const { unconfirmed: _old, ...rest } = foreign ? withoutStamp(stored) : stored;
	ctx.linkPut = true;
	await ctx.deps.links.put(ctx.linkId, {
		...rest,
		fields: ctx.fields,
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
	});
}

/**
 * M5c (spec Rulings 2, 21): a record that reached a link stamped with another owner, or whose
 * template has none, drops the stamp whatever its outcome. A record whose own link put already
 * applied `ownership` needs nothing more; any other puts the link once, every other field kept.
 * A dry run drops nothing. Not journalled.
 */
async function settleOwner(ctx: RecordCtx): Promise<void> {
	if (ctx.job.dryRun || ctx.linkPut) return;
	const link = ctx.stored ?? ctx.read;
	if (link === null || !foreignStamp(ctx.job, link)) return;
	await ctx.deps.links.put(ctx.linkId, withoutStamp(link));
}

/** The import message of a key whose entry the missing phase moved to Trash (spec Ruling 15). */
export const MISSING_TRASHED_MESSAGE = (jobId: string) =>
	`Not imported: the import moved this entry to Trash because it was missing from an earlier feed (job ${jobId}); restore it from Trash, or roll that job back, then retry`;

/** M5c: the conflict of a record whose link says the import trashed its entry, which is gone. */
function trashedByImport(
	link: LinkRow | null,
	entry: EntrySnapshot | null,
	sourceKey: string,
): RowFields | null {
	if (entry !== null || link?.missing?.action !== "trash") return null;
	return {
		status: "conflict",
		sourceKey,
		entryId: link.entryId,
		errors: [{ code: "missing_trashed", message: MISSING_TRASHED_MESSAGE(link.missing.jobId) }],
	};
}
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	const { collection, locale } = ctx.job.template;
	const link = await ctx.deps.links.get(ctx.linkId);
	if (link && lookingUp) cache.spend(COST_READ);
````
with:
````ts
	const { collection, locale } = ctx.job.template;
	const link = await ctx.deps.links.get(ctx.linkId);
	ctx.read = link;
	if (link && lookingUp) cache.spend(COST_READ);
````

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
type Found = { newTerms: string[]; newMedia: string[]; warnings: RecordError[] };
````
with:
````ts
type Found = {
	newTerms: string[];
	newMedia: string[];
	warnings: RecordError[];
	/** M5c: the record's context once its key was read, for `settleOwner`. */
	ctx?: RecordCtx;
};
````

In `decide`, replace
````ts
	try {
		row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	} catch (e) {
````
with:
````ts
	try {
		row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
		if (found.ctx) await settleOwner(found.ctx);
	} catch (e) {
````

In `decideRecord`, replace
````ts
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };
````
with:
````ts
	if (!mapped.ok) {
		// M5c (Ruling 24): the key, when it was read, marks the record as in the feed.
		return { status: "failed", sourceKey: mapped.key ?? null, entryId: null, errors: mapped.errors };
	}
````
and replace
````ts
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		stored: null,
		linkSaved: false,
````
with:
````ts
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		read: null,
		linkPut: false,
		stamp: false,
		stored: null,
		linkSaved: false,
````
and replace
````ts
		save,
	};
	// Known so far, so that a ContentWriteError from any content call still reports it.
````
with:
````ts
		save,
	};
	found.ctx = ctx;
	// Known so far, so that a ContentWriteError from any content call still reports it.
````
and replace
````ts
			early = await entryByLink(ctx, cache, readFor(narrowed), lookingUpFor(narrowed));
			const skip = modeSkip(job.template, early.entry, existing);
````
with:
````ts
			early = await entryByLink(ctx, cache, readFor(narrowed), lookingUpFor(narrowed));
			const trashed = trashedByImport(early.link, early.entry, sourceKey);
			if (trashed) return trashed;
			const skip = modeSkip(job.template, early.entry, existing);
````
and replace
````ts
		let { link, entry } = early ?? (await entryByLink(ctx, cache, read, lookingUp));
````
with:
````ts
		let { link, entry } = early ?? (await entryByLink(ctx, cache, read, lookingUp));
		const trashed = early ? null : trashedByImport(link, entry, sourceKey);
		if (trashed) return trashed;
````
and replace
````ts
		if (repaired && link) {
			await deps.links.put(ctx.linkId, link);
````
with:
````ts
		if (repaired && link) {
			ctx.linkPut = true;
			await deps.links.put(ctx.linkId, link);
````
and replace
````ts
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
````
with:
````ts
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		// M5c (Ruling 29 M7): crash repair stamps only an entry this job is shown to have created.
		if (entry && existing && ownerOf(job) !== undefined && !job.dryRun) {
			ctx.stamp = await createdHere(ctx, existing, entry.id);
		}
````

Add after `settleOwner`:
````ts
/**
 * M5c: whether this job created the entry it now resumes (spec "Owner", Ruling 29 M7): its row
 * was `writing` a create of that entry, or its journal row records a create of it that this
 * job's own call returned (`confirmed`). An entry found by source ID alone is not.
 */
async function createdHere(ctx: RecordCtx, existing: RecordRow, entryId: string): Promise<boolean> {
	if (existing.status === "writing" && existing.action === "create" && existing.entryId === entryId) {
		return true;
	}
	if (!journaling(ctx.job)) return false;
	const row = await ctx.deps.journal.get(journalKey(ctx.job.id, ctx.linkId));
	return row?.kind === "create" && row.confirmed === true && row.entryId === entryId;
}
````

In `writeRecord`, replace
````ts
	if (!entry && journaling(job)) await journalCreated(ctx, written.id, true);
````
with:
````ts
	if (!entry && journaling(job)) await journalCreated(ctx, written.id, true);
	// M5c: the job's own create (a linked one included) stamps the owner on the link.
	if (!entry) ctx.stamp = true;
````

- [ ] **Step 4: Run them to see them pass, and update the failed-row expectations**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/owner.test.ts tests/unit/missing-keys.test.ts`
Expected: PASS (the new tests of both files).

Then run `pnpm exec vitest run` (the whole unit suite). Tests that expect `sourceKey: null` on a row that failed after its key now see the key (spec P1, Ruling 24); for example a bad price in `batch.test.ts`, `template.test.ts`'s `applyTemplate` failures, and the M4a value tests. Change each such expectation to the record's key, and an `applyTemplate` failure expectation to include `key`, nothing else. A row that failed on its key, its filter or its reader keeps `sourceKey: null`. List every changed test in the commit body.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/owner.ts packages/flux-import/src/engine/batch.ts packages/flux-import/src/engine/journal.ts packages/flux-import/src/engine/template.ts packages/flux-import/tests/unit
git commit -m "Stamp, keep and drop the owner on link rows, keep the key of failed records, count unkeyed rows and refuse keys the import trashed"
```

### Task 3: The `restore` step, adapter and fakes

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/emdash/content.ts`, `packages/flux-import/src/engine/revert.ts` (`STEP_COST` only), `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/fakes.test.ts`, `packages/flux-import/tests/unit/content.test.ts`

**Interfaces:**
- Consumes: `RevertStep`, `ContentRuntime`, `EmDashContent.revertStep`, `FakeContent`, `makeDeps`, `STEP_COST`.
- Produces:
  - `RevertStep` adds `"restore"`: `revertStep({ step: "restore", rev })` with the trashed entry's `_rev` (spec F2);
  - `ContentRuntime.handleContentRestore(collection, id, options?: { _rev?: string })`;
  - `STEP_COST.restore = 15`;
  - `TRANSLATION_SLOT_TAKEN` in `ports.ts` (EmDash's message, spec F2);
  - in the fakes: `FakeContent`'s restore (spec F2), and `makeDeps().newId` giving `id00000001`, … (Ruling 11).

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/fakes.test.ts`, add at the end of the file:
````ts
describe("FakeContent restore from Trash (M5c, spec F1, F2)", () => {
	const make = async () => {
		const { deps } = makeDeps();
		const created = await deps.content.create({
			collection: "products",
			locale: "en",
			slug: "desk",
			data: { title: "Desk" },
		});
		const published = await deps.content.publish({ id: created.id, rev: created.rev });
		if (!published.ok) throw new Error("publish");
		return { deps, id: created.id, rev: published.rev };
	};

	it("trashes without moving _rev, and restores as a draft one version on, fenced", async () => {
		const { deps, id, rev } = await make();
		expect(await deps.content.trash("products", id)).toEqual({ ok: true });
		expect(deps.content.revOf(id)).toBe(rev);
		const stale = await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id,
			rev: "c3RhbGU=",
			step: "restore",
		});
		expect(stale).toMatchObject({ ok: false, reason: "conflict" });
		const restored = await deps.content.revertStep({ collection: "products", locale: "en", id, rev, step: "restore" });
		expect(restored).toMatchObject({
			ok: true,
			state: { status: "draft", scheduledAt: null, hasDraft: false },
		});
		const snap = await deps.content.get("products", "en", id);
		expect(snap).toMatchObject({ status: "draft", slug: "desk", data: { title: "Desk" } });
		expect(deps.content.calls).toContain(`restore:${id}`);
		const again = await deps.content.revertStep({
			collection: "products",
			locale: "en",
			id,
			rev: restored.ok ? restored.state.rev : "",
			step: "restore",
		});
		// An active entry is not in Trash: EmDash's restore is a conflict then.
		expect(again).toMatchObject({ ok: false, reason: "conflict" });
	});

	it("publishes a restored entry back to its data, keeping publishedAt", async () => {
		const { deps, id, rev } = await make();
		const publishedAt = (await deps.content.get("products", "en", id))?.publishedAt;
		await deps.content.trash("products", id);
		const restored = await deps.content.revertStep({ collection: "products", locale: "en", id, rev, step: "restore" });
		if (!restored.ok) throw new Error("restore");
		const back = await deps.content.revertStep({ collection: "products", locale: "en", id, rev: restored.state.rev, step: "publish" });
		expect(back).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		expect(await deps.content.get("products", "en", id)).toMatchObject({
			status: "published",
			publishedAt,
			data: { title: "Desk" },
		});
	});

	it("refuses a restore into a locale its group fills again", async () => {
		const { deps, id } = await make();
		const fr = await deps.content.create({ collection: "products", locale: "fr", data: { title: "Bureau" }, translationOf: id });
		const rev = deps.content.revOf(fr.id);
		await deps.content.trash("products", fr.id);
		await deps.content.create({ collection: "products", locale: "fr", data: { title: "Pupitre" }, translationOf: id });
		expect(
			await deps.content.revertStep({ collection: "products", locale: "fr", id: fr.id, rev, step: "restore" }),
		).toEqual({ ok: false, reason: "conflict", message: TRANSLATION_SLOT_TAKEN });
	});

	it("gives job IDs that sort in creation order", () => {
		const { deps } = makeDeps();
		const ids = Array.from({ length: 12 }, () => deps.newId());
		expect(ids[0]).toBe("id00000001");
		expect([...ids].sort()).toEqual(ids);
	});
});
````
Add `TRANSLATION_SLOT_TAKEN` to the file's import from `../../src/engine/ports.js` (add that import if the file has none).

In `packages/flux-import/tests/unit/content.test.ts`, add to `FakeRuntime` (after `handleContentUnschedule`):
````ts
	async handleContentRestore(collection: string, id: string, options: Record<string, unknown> = {}) {
		this.calls.push(["restore", collection, id, options]);
		const forced = this.override();
		if (forced) return forced;
		const item = this.items.get(id);
		if (!item?.deletedAt) return fail("NOT_FOUND", `Trashed content item not found: ${id}`);
		if (options._rev !== `rev-${item.version}`) return fail("CONFLICT", "Content changed while restoring");
		item.deletedAt = null;
		item.status = "draft";
		item.scheduledAt = null;
		item.version++;
		const envelope = this.envelope(item);
		return ok({ restored: true, ...(envelope.data as object) });
	}
````
and add at the end of the file:
````ts
describe("EmDashContent restore (M5c)", () => {
	const base = { collection: "products", locale: "en", id: "e1" };

	it("restores as revert step 8, lock checked, with the revision only", async () => {
		const locked = new Set<string>();
		const { runtime, content } = setup((_c, id) => locked.has(id));
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		await content.trash("products", "e1");
		const restored = await content.revertStep({ ...base, rev: "rev-1", step: "restore" });
		expect(restored).toMatchObject({ ok: true, state: { rev: "rev-2", status: "draft" } });
		expect(runtime.calls.at(-1)).toEqual(["restore", "products", "e1", { _rev: "rev-1" }]);
		await content.trash("products", "e1");
		expect(await content.revertStep({ ...base, rev: "rev-1", step: "restore" })).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		locked.add("e1");
		expect(await content.revertStep({ ...base, rev: "rev-2", step: "restore" })).toMatchObject({
			ok: false,
			reason: "locked",
		});
	});

	it("passes a slot conflict on with EmDash's message", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		await content.trash("products", "e1");
		runtime.stepOverride = fail("CONFLICT", "An active translation already exists in this locale");
		expect(await content.revertStep({ ...base, rev: "rev-1", step: "restore" })).toEqual({
			ok: false,
			reason: "conflict",
			message: "An active translation already exists in this locale",
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/fakes.test.ts tests/unit/content.test.ts`
Expected: FAIL. `restore` is not a revert step, `TRANSLATION_SLOT_TAKEN` does not exist, and the IDs are `id1`, ….

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/ports.ts`, replace
````ts
/**
 * The rollback's writes to a changed entry (spec M5a "Revert sequence"); M5b adds `unschedule`
 * (step 7), which no hook can refuse (spec M5b F3).
 */
export type RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule" | "unschedule";
````
with:
````ts
/**
 * The rollback's writes to a changed entry (spec M5a "Revert sequence"); M5b adds `unschedule`
 * (step 7), which no hook can refuse (spec M5b F3). M5c adds `restore` (step 8): out of Trash,
 * fenced on the trashed entry's `_rev`, back as a draft with no schedule (spec M5c F2).
 */
export type RevertStep =
	| "update"
	| "publish"
	| "unpublish"
	| "discard"
	| "schedule"
	| "unschedule"
	| "restore";

/**
 * EmDash's message for a restore into a locale its translation group fills again (`emdash`
 * src/api/handlers/content.ts:1950, spec M5c F2, V1), which a `restore` conflict carries.
 */
export const TRANSLATION_SLOT_TAKEN = "An active translation already exists in this locale";
````

In `packages/flux-import/src/emdash/content.ts`, replace
````ts
	/** M5b: src/emdash-runtime.ts:4733 (no hook can refuse it, spec M5b F3). */
	handleContentUnschedule(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}
````
with:
````ts
	/** M5b: src/emdash-runtime.ts:4733 (no hook can refuse it, spec M5b F3). */
	handleContentUnschedule(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
	/** M5c: src/emdash-runtime.ts:4136-4161 (no hook can refuse it, no lock check; spec M5c F2). */
	handleContentRestore(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}
````
and replace
````ts
			case "unschedule":
				result = await this.runtime.handleContentUnschedule(collection, id, { _rev: rev });
				break;
		}
````
with:
````ts
			case "unschedule":
				result = await this.runtime.handleContentUnschedule(collection, id, { _rev: rev });
				break;
			case "restore":
				// Lock checked above like every step, although EmDash's restore does not check it.
				result = await this.runtime.handleContentRestore(collection, id, { _rev: rev });
				break;
		}
````

In `packages/flux-import/src/engine/revert.ts`, replace
````ts
	// M5b step 7, costed as a schedule (spec M5b "Caps").
	unschedule: 15,
};
````
with:
````ts
	// M5b step 7, costed as a schedule (spec M5b "Caps").
	unschedule: 15,
	// M5c step 8: 18 D1 queries (plan Fact V8), costed as an unpublish.
	restore: 15,
};
````

In `packages/flux-import/tests/unit/fakes.ts`, add `TRANSLATION_SLOT_TAKEN` to the import from `../../src/engine/ports.js`. Then replace
````ts
		this.beforeStep(input.step, input.id);
		const e = this.entries.get(input.id);
		if (!e || e.trashed || e.collection !== input.collection || e.locale !== input.locale) {
````
with:
````ts
		this.beforeStep(input.step, input.id);
		if (input.step === "restore") return this.restore(input);
		const e = this.entries.get(input.id);
		if (!e || e.trashed || e.collection !== input.collection || e.locale !== input.locale) {
````
and add as a method of `FakeContent`, after `revertStep`:
````ts
	/**
	 * As EmDash's restore (repositories/content.ts:1643-1674, spec M5c F2): fenced on `version` and
	 * `updated_at`; an entry not in Trash is a conflict (the UPDATE matches no row); a group that
	 * fills the locale again is a conflict with EmDash's message. The entry comes back as a draft
	 * without a live revision or schedule, one version on, its slug, `publishedAt` and any draft
	 * kept.
	 */
	private restore(input: { collection: string; locale: string; id: string; rev: string }): StepResult {
		const e = this.entries.get(input.id);
		if (!e || e.collection !== input.collection || e.locale !== input.locale) {
			throw new ContentWriteError(
				"emdash_not_found",
				`Rolling back the entry (restore) failed: Trashed content item not found: ${input.id}`,
			);
		}
		if (this.locked.has(e.id)) return { ok: false, reason: "locked", message: "locked" };
		if (!e.trashed || this.encoded(e) !== input.rev) {
			return { ok: false, reason: "conflict", message: "Content changed while restoring" };
		}
		const taken = [...this.entries.values()].some(
			(o) =>
				o.id !== e.id &&
				!o.trashed &&
				o.group === e.group &&
				o.locale.toLowerCase() === e.locale.toLowerCase(),
		);
		if (taken) return { ok: false, reason: "conflict", message: TRANSLATION_SLOT_TAKEN };
		e.trashed = false;
		e.published = null;
		e.status = "draft";
		e.scheduledAt = null;
		e.pendingPublish = true;
		this.touch(e);
		this.calls.push(`restore:${e.id}`);
		this.afterStep("restore", e.id);
		return {
			ok: true,
			state: {
				rev: this.encoded(e),
				status: e.status,
				scheduledAt: e.scheduledAt,
				hasDraft: this.hasDraft(e),
			},
		};
	}
````
`revertStep` is `async`, so returning the method's value resolves it as before.

In `makeDeps`, replace
````ts
		newId: () => `id${++id}`,
````
with:
````ts
		// Sortable like EmDash's ULIDs, so a later job's ID sorts after an earlier one's (M5c).
		newId: () => `id${String(++id).padStart(8, "0")}`,
````

- [ ] **Step 4: Run them to see them pass**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/fakes.test.ts tests/unit/content.test.ts`
Expected: PASS (the 6 new tests and every earlier one).

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash/content.ts packages/flux-import/src/engine/revert.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/fakes.test.ts packages/flux-import/tests/unit/content.test.ts
git commit -m "Add the restore revert step through handleContentRestore, and restore from Trash in the fakes"
```

### Task 4: The missing phase

**Files:**
- Create: `packages/flux-import/src/engine/missing.ts`
- Modify: `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/missing.test.ts` (new), `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `Job.missingLimit`, `Job.unkeyed`, `MissingState`, `MissingAction`, `LinkRow.owner`/`ownerSource`/`missing`, `JournalEntry.kind "trash"`, `Counters.removed`, `RecordStatus "removed"`;
  - Task 2: `ownerOf`, `linkBefore`, the stamps;
  - Task 3: the fakes' Trash and sortable IDs;
  - M5b: `sweptSince`, `holdsScheduled`;
  - `LookupCache`, `COST_CALL`, `COST_READ`, `importBatch`, `release`, `counterFor`, `workersBatchCap`.
- Produces:
  - in `src/engine/missing.ts`:
    - `MISSING_PAGE = 50`;
    - `MISSING_MESSAGES`, a record of the six `unchanged` codes' messages;
    - `laterJob(linkJob: string | undefined, jobId: string): boolean`;
    - `isCandidate(link: LinkRow, job: Job): boolean`;
    - `enterMissing(job: Job): { done: boolean }`;
    - `missingPass(deps: EngineDeps, job: Job, started: number, limit: number, cache: LookupCache): Promise<{ done: boolean }>`;
    - `missingCounter(row): keyof Counters | null`;
    - the internal `seenOf`, `verdictOf`, `countStage`, `finishCount`, `actStage`, `decideNew`, `act`, `send` and `finish`, which Task 5 extends;
  - in `batch.ts`: `importBatch` runs `missingPass` while `job.phase === "missing"` and calls `enterMissing` when the first pass completes; `release` saves `missing` and `unkeyed`; `counterFor` counts `removed` rows and planned `trash`/`unpublish` rows as `removed`;
  - in `service.ts`: `WORKERS_MISSING_SCAN_CAP = 40` and `WORKERS_MISSING_BATCH_CAP = 10`, and `workersBatchCap(job)` returning them while `job.phase === "missing"`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/missing.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { laterJob, MISSING_MESSAGES } from "../../src/engine/missing.js";
import { type Job, journalKey, type LinkRow, type RecordRow } from "../../src/engine/types.js";
import {
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
	csv,
} from "./rollback-fixture.js";

const items = (keys: number[]): Row[] =>
	keys.map((i) => ({ sku: `K${i}`, name: `Item ${i}`, price: i }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const rules = (action: "trash" | "unpublish", extra: Record<string, unknown> = {}, owner = "shop") => ({
	rules: { owner, missing: { action, ...extra } },
});
const opts = (action: "trash" | "unpublish", more: StartOptions = {}, extra: Record<string, unknown> = {}) => ({
	...more,
	extra: { ...rules(action, extra), ...more.extra },
});
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
/** The rows the missing phase wrote, by key. */
const missingRows = async (deps: Deps, job: Job) => {
	const from = job.missing?.fromSeq ?? Number.POSITIVE_INFINITY;
	return new Map(
		(await records(deps, job.id)).filter((r) => r.seq >= from).map((r) => [r.sourceKey, r] as const),
	);
};
const codes = (row: RecordRow | undefined) =>
	[...(row?.warnings ?? []), ...(row?.errors ?? [])].map((w) => w.code);
/** An editor's change through the content API, published as the admin publishes it. */
async function edit(deps: Deps, key: string, data: Record<string, unknown>, publish = true) {
	const id = entryOf(deps, key).id;
	await deps.content.update({ collection: "products", locale: "en", id, rev: deps.content.revOf(id), data });
	if (publish) await deps.content.publish({ id, rev: deps.content.revOf(id) });
}
/** Eight owned, published entries K0-K7. */
async function eight(action: "trash" | "unpublish", extra: Record<string, unknown> = {}) {
	const made = setup();
	await importRows(made.deps, items(range(0, 8)), opts(action, {}, extra));
	return made;
}

describe("entering the missing phase (M5c)", () => {
	it("runs after a completed first pass and finds nothing on the first run", async () => {
		const { deps } = setup();
		const job = await importRows(deps, items(range(0, 4)), opts("trash"));
		expect(job).toMatchObject({
			status: "completed",
			phase: "missing",
			missing: { stage: "done", fromSeq: 4, owned: 4, found: 0, rows: 0, removed: 0, verdict: "act" },
		});
	});

	it("is skipped when a record had no readable key", async () => {
		const { deps } = await eight("trash");
		const body = items(range(0, 6)).concat([{ sku: "", name: "No key", price: 1 }]);
		const job = await importRows(deps, body, opts("trash"));
		expect(job.missing).toMatchObject({ stage: "done", verdict: "skipped" });
		expect(job.warnings).toContain(
			"Missing entries were not checked: 1 records had no readable key (or were skipped by the reader), so their entries may be in the feed",
		);
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("is skipped when no record had a key, and not entered with missing: false", async () => {
		const { deps } = await eight("trash");
		const filtered = await importRows(deps, items(range(0, 8)), {
			extra: { ...rules("trash"), source: { format: "csv", filter: "false" } },
		});
		expect(filtered.missing).toMatchObject({ verdict: "skipped" });
		expect(filtered.warnings).toContain("Missing entries were not checked: the import read no record with a key");
		const off = await importRows(deps, items(range(0, 2)), { ...opts("trash"), missing: false });
		expect(off).not.toHaveProperty("missing");
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("is never entered by a cancelled pass", async () => {
		const { deps } = await eight("trash");
		const job = await start(deps, csv(items([0])), {
			...opts("trash"),
			batchSize: 1,
		});
		await transitionJob(deps, job.id, "cancel");
		const stored = await runBatch(deps, job.id, "h");
		expect(stored.status).toBe("cancelled");
		expect(stored).not.toHaveProperty("missing");
	});
});

describe("unpublish and trash (M5c)", () => {
	it("unpublishes the owned entries the feed no longer holds, journals and marks them", async () => {
		const { deps } = await eight("unpublish");
		const job = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		expect(job.counters).toMatchObject({ unchanged: 6, removed: 2 });
		expect(job.missing).toMatchObject({ stage: "done", owned: 8, found: 2, rows: 2, removed: 2, verdict: "act" });
		const rows = await missingRows(deps, job);
		for (const key of ["K6", "K7"]) {
			expect(rows.get(key)).toMatchObject({ status: "removed", action: "unpublish", start: 0, end: 0 });
			const entry = entryOf(deps, key);
			expect(entry.status).toBe("draft");
			expect(await linkOf(deps, key)).toMatchObject({
				owner: "shop",
				jobId: job.id,
				writtenRev: deps.content.revOf(entry.id),
				missing: { jobId: job.id, action: "unpublish" },
			});
		}
		const journal = (await journalOf(deps, job.id)).filter((j) => j.seq >= 8);
		expect(journal.map((j) => [j.kind, j.sourceKey, j.before?.status, j.before?.live])).toEqual([
			["update", "K6", "published", {}],
			["update", "K7", "published", {}],
		]);
		// A later run leaves marked links out.
		const again = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		expect(again.missing).toMatchObject({ owned: 6, found: 0 });
	});

	it("moves them to Trash, keeping the link's revision", async () => {
		const { deps } = await eight("trash");
		const before = await linkOf(deps, "K7");
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.counters.removed).toBe(1);
		expect(entryOf(deps, "K7").trashed).toBe(true);
		expect(await linkOf(deps, "K7")).toMatchObject({
			writtenRev: before.writtenRev,
			missing: { jobId: job.id, action: "trash" },
		});
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toMatchObject({
			kind: "trash",
			entryId: entryOf(deps, "K7").id,
			before: { rev: before.writtenRev, status: "published", scheduledAt: null, live: {}, link: { owner: "shop" } },
		});
	});

	it("reports each call that does not land and deletes its journal row", async () => {
		const { deps } = await eight("unpublish");
		deps.content.locked.add(entryOf(deps, "K4").id);
		deps.content.blockStep = (step, id) => (id === entryOf(deps, "K5").id ? "No." : null);
		deps.content.beforeStep = (step, id) => {
			// Another write lands between the read and the unpublish.
			if (step === "unpublish" && id === entryOf(deps, "K6").id) {
				const e = deps.content.entries.get(id);
				if (e) e.rev++;
			}
		};
		const job = await importRows(deps, items([0, 1, 2, 3, 7]), opts("unpublish", { missing: { maxPercent: 50 } }));
		const rows = await missingRows(deps, job);
		expect(rows.get("K4")).toMatchObject({ status: "locked", errors: [{ code: "locked", message: "Not changed: the entry is being edited (locked)" }] });
		expect(rows.get("K5")).toMatchObject({ status: "failed", errors: [{ code: "missing_blocked", message: "Not changed: a plugin refused: No." }] });
		expect(rows.get("K6")).toMatchObject({ status: "conflict", errors: [{ code: "missing_changed", message: "Not changed: the entry changed since it was read" }] });
		for (const key of ["K4", "K5", "K6"]) {
			expect(await deps.journal.get(journalKey(job.id, `products:en:${key}`)), key).toBeNull();
			expect(await linkOf(deps, key)).not.toHaveProperty("missing");
		}
	});

	it("leaves an entry trashed meanwhile, and a hook's refusal of the trash", async () => {
		const { deps } = await eight("trash");
		deps.content.blockDelete = (id) => (id === entryOf(deps, "K7").id ? "Keep it." : null);
		deps.content.beforeStep = (step, id) => {
			const e = deps.content.entries.get(id);
			if (step === "trash" && e?.data.flux_source_id === "K6") e.trashed = true;
		};
		const job = await importRows(deps, items(range(0, 6)), opts("trash"));
		const rows = await missingRows(deps, job);
		expect(codes(rows.get("K6"))).toEqual(["missing_gone"]);
		expect(rows.get("K7")).toMatchObject({ status: "failed", errors: [{ code: "missing_blocked", message: "Not changed: a plugin refused: Keep it." }] });
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).toBeNull();
		expect(await deps.journal.get(journalKey(job.id, "products:en:K7"))).toBeNull();
	});
});

describe("the threshold (M5c, Rulings 6, 22, 23)", () => {
	it("passes at the limit and refuses one past it, suggesting a percent that passes", async () => {
		const at = await eight("unpublish");
		const ok = await importRows(at.deps, items(range(0, 6)), opts("unpublish"));
		expect(ok.missing).toMatchObject({ found: 2, verdict: "act", removed: 2 });

		const { deps } = await eight("unpublish");
		const refused = await importRows(deps, items(range(0, 5)), opts("unpublish"));
		expect(refused.status).toBe("completed");
		expect(refused.missing).toMatchObject({ stage: "done", found: 3, removed: 0, verdict: "refused" });
		expect(refused.warnings).toContain(
			"Missing entries were left alone: 3 of the 8 entries owner shop created before this import are not in the feed (38%), more than the limit of 25%. Check the feed, then import it again with the job option missing: { maxPercent: 38 } to apply it (with force: true for an unchanged URL source).",
		);
		expect([...deps.content.entries.values()].every((e) => e.status === "published")).toBe(true);
		const applied = await importRows(deps, items(range(0, 5)), { ...opts("unpublish"), missing: { maxPercent: 38 } });
		expect(applied.missing).toMatchObject({ verdict: "act", removed: 3 });
	});

	it("leaves this job's creates out of the base, and counts the dry run's candidates", async () => {
		const { deps } = await eight("unpublish");
		// 5 of the 8 old ones and 4 new ones: 3 of 8 missing is 38%, though 3 of the 12 owned is 25%.
		const real = await importRows(deps, items([...range(0, 5), ...range(8, 12)]), opts("unpublish"));
		expect(real.missing).toMatchObject({ owned: 12, found: 3, verdict: "refused" });
		const other = await eight("unpublish");
		const dry = await importRows(other.deps, items(range(0, 6)), { ...opts("unpublish"), dryRun: true });
		expect(dry.missing).toMatchObject({ owned: 8, found: 2, verdict: "act", removed: 2 });
	});

	it("refuses 1 of 3 and accepts 1 of 4 by default", async () => {
		for (const [owned, verdict] of [[3, "refused"], [4, "act"]] as const) {
			const { deps } = setup();
			await importRows(deps, items(range(0, owned)), opts("trash"));
			const job = await importRows(deps, items(range(0, owned - 1)), opts("trash"));
			expect(job.missing?.verdict, String(owned)).toBe(verdict);
		}
	});

	it("counts edited, pending and translated entries toward found, but not gone ones", async () => {
		const { deps } = await eight("trash");
		await edit(deps, "K5", { price: 55 });
		await edit(deps, "K6", { price: 66 }, false);
		deps.content.entries.delete(entryOf(deps, "K7").id);
		// K5 and K6 are left alone, yet 2 of 8 count: the feed lost them (Ruling 22).
		const job = await importRows(deps, items(range(0, 4).concat([4])), opts("trash"));
		expect(job.missing).toMatchObject({ found: 2, verdict: "act", removed: 0 });
		const rows = await missingRows(deps, job);
		expect(codes(rows.get("K5"))).toEqual(["missing_edited"]);
		expect(codes(rows.get("K6"))).toEqual(["missing_pending"]);
		expect(codes(rows.get("K7"))).toEqual(["missing_gone"]);
		expect(rows.get("K7")?.warnings?.[0]?.message).toBe(MISSING_MESSAGES.missing_gone);
	});

	it("refuses a feed that lost most entries even when all of them are edited", async () => {
		const { deps } = await eight("trash");
		for (const key of ["K5", "K6", "K7"]) await edit(deps, key, { price: 99 });
		const job = await importRows(deps, items(range(0, 5)), opts("trash"));
		expect(job.missing).toMatchObject({ found: 3, verdict: "refused" });
	});
});

describe("candidates (M5c)", () => {
	it("leaves out marked links, later jobs' links and other owners' entries", async () => {
		const { deps } = await eight("trash");
		// K7's link names a later job; K6's is marked by an earlier run.
		await deps.links.put("products:en:K7", { ...(await linkOf(deps, "K7")), jobId: "id99999999" });
		await deps.links.put("products:en:K6", {
			...(await linkOf(deps, "K6")),
			missing: { jobId: "id00000001", action: "trash", at: "2026-10-07T10:00:00.000Z" },
		});
		const job = await importRows(deps, items(range(0, 6)), opts("trash"));
		expect(job.missing).toMatchObject({ owned: 6, found: 0 });
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(entryOf(deps, "K7").trashed).toBe(false);
		expect(laterJob("01J0000000AAAAAAAAAAAAAAAA", "01J0000000BBBBBBBBBBBBBBBB")).toBe(true);
		expect(laterJob("01J0000000BBBBBBBBBBBBBBBB", "01J0000000AAAAAAAAAAAAAAAA")).toBe(true);
		expect(laterJob("01H0000000BBBBBBBBBBBBBBBB", "01J0000000AAAAAAAAAAAAAAAA")).toBe(false);
		expect(laterJob(undefined, "id00000002")).toBe(false);
		expect(laterJob("id00000002", "id00000002")).toBe(false);
	});

	it("counts a record that failed after its key as seen, and a filtered one as unseen", async () => {
		const { deps } = await eight("trash", { maxPercent: 50 });
		const body = items(range(0, 6)).concat([{ sku: "K6", name: "Item 6", price: "n/a" as never }]);
		const job = await importRows(deps, body, opts("trash", {}, { maxPercent: 50 }));
		expect(entryOf(deps, "K6").trashed).toBe(false);
		expect(entryOf(deps, "K7").trashed).toBe(true);
		const filtered = await importRows(deps, items(range(0, 6)), {
			extra: { ...rules("trash", { maxPercent: 50 }), source: { format: "csv", filter: "sku != 'K5'" } },
		});
		expect(filtered.counters.filtered).toBe(1);
		expect(entryOf(deps, "K5").trashed).toBe(true);
		expect(job.missing?.removed).toBe(1);
	});

	it("pages 101 owned links and their keys in seen queries of 50", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 101)), { ...opts("unpublish"), batchSize: 500 });
		const queries: unknown[] = [];
		const query = deps.records.query.bind(deps.records);
		deps.records.query = async (q) => {
			const keys = (q.where?.sourceKey as { in?: string[] } | undefined)?.in;
			if (keys) queries.push(keys.length);
			return query(q);
		};
		const job = await importRows(deps, items(range(1, 100)), { ...opts("unpublish"), batchSize: 500 });
		expect(job.missing).toMatchObject({ owned: 101, found: 2, removed: 2 });
		expect(entryOf(deps, "K0").status).toBe("draft");
		expect(entryOf(deps, "K100").status).toBe("draft");
		expect(Math.max(...(queries as number[]))).toBeLessThanOrEqual(50);
	});

	it("refuses as a whole when another URL source created entries under the owner", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 8)), { ...opts("trash"), sourceId: "src1" });
		for (const [sourceId, label] of [["src2", "src2"], [undefined, "an upload"]] as const) {
			const job = await importRows(deps, items(range(0, 7)), {
				...opts("trash"),
				...(sourceId ? { sourceId } : {}),
			});
			expect(job.missing, label).toMatchObject({ stage: "done", verdict: "refused", removed: 0 });
			expect(job.warnings).toContain(
				"Missing entries were left alone: owner shop also has entries created from another URL source (src1); give each feed its own owner",
			);
		}
		expect(entryOf(deps, "K7").trashed).toBe(false);
		const same = await importRows(deps, items(range(0, 7)), { ...opts("trash"), sourceId: "src1" });
		expect(same.missing?.removed).toBe(1);
	});

	it("never counts an entry another owner's record reached (Ruling 21)", async () => {
		const { deps } = await eight("trash");
		await importRows(deps, items([7]), { extra: { rules: { owner: "other" } } });
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(job.missing).toMatchObject({ owned: 7, found: 0 });
		expect(entryOf(deps, "K7").trashed).toBe(false);
	});
});

describe("verdicts (M5c)", () => {
	it("leaves drafts for unpublish and group roots with active translations for trash", async () => {
		const { deps } = setup();
		await importRows(deps, items(range(0, 4)), { ...opts("unpublish"), publish: false });
		await importRows(deps, items(range(4, 8)), opts("unpublish"));
		const job = await importRows(deps, items(range(1, 8)), opts("unpublish"));
		expect(codes((await missingRows(deps, job)).get("K0"))).toEqual(["missing_not_live"]);

		const t = await eight("trash");
		const root = entryOf(t.deps, "K7");
		await t.deps.content.create({ collection: "products", locale: "fr", data: { title: "Sept" }, translationOf: root.id });
		const trash = await importRows(t.deps, items(range(0, 7)), opts("trash"));
		expect(codes((await missingRows(t.deps, trash)).get("K7"))).toEqual(["missing_has_translations"]);
		expect(root.trashed).toBe(false);
	});

	it("leaves an entry with someone's schedule", async () => {
		const { deps, clock } = await eight("trash");
		const id = entryOf(deps, "K7").id;
		await edit(deps, "K7", { price: 70 }, false);
		await deps.content.schedule({ collection: "products", locale: "en", id, rev: deps.content.revOf(id), scheduledAt: new Date(clock.t + 3_600_000).toISOString() });
		const job = await importRows(deps, items(range(0, 7)), opts("trash"));
		expect(codes((await missingRows(deps, job)).get("K7"))).toEqual(["missing_edited"]);
	});

	it("takes the scheduler's publish of the importer's schedule as the importer's, while its journal holds", async () => {
		for (const purged of [false, true]) {
			const { deps, clock } = setup();
			ticking(clock);
			const at = new Date(clock.t + 3_600_000).toISOString();
			await importRows(deps, items(range(0, 8)), opts("unpublish"));
			const scheduled = await importRows(deps, items(range(0, 8)).map((r) => ({ ...r, price: (r.price ?? 0) + 100 })), {
				extra: { ...rules("unpublish"), publishAt: { expr: `'${at}'` } },
			});
			clock.t = Date.parse(at) + 60_000;
			deps.content.runScheduled();
			if (purged) await deps.journal.delete(journalKey(scheduled.id, "products:en:K7"));
			const job = await importRows(deps, items(range(0, 7)).map((r) => ({ ...r, price: (r.price ?? 0) + 100 })), opts("unpublish"));
			const row = (await missingRows(deps, job)).get("K7");
			if (purged) expect(codes(row), "purged").toEqual(["missing_edited"]);
			else expect(row).toMatchObject({ status: "removed", action: "unpublish" });
		}
	});

	it("never removes more than the count found (Ruling 20)", async () => {
		const { deps } = await eight("trash");
		const k6 = entryOf(deps, "K6");
		const saved = structuredClone(k6);
		deps.content.entries.delete(k6.id);
		const job = await start(deps, csv(items(range(0, 6))), opts("trash"));
		let stored = await runBatch(deps, job.id, "h");
		while (stored.missing?.stage !== "act") stored = await runBatch(deps, job.id, "h");
		expect(stored.missing).toMatchObject({ found: 1 });
		// The entry comes back between the stages, as the importer left it.
		deps.content.entries.set(saved.id, saved);
		const done = await runToEnd(deps, job.id);
		const rows = await missingRows(deps, done);
		expect([...rows.values()].map((r) => r.status).sort()).toEqual(["removed", "unchanged"]);
		const left = [...rows.values()].find((r) => r.status === "unchanged");
		expect(codes(left)).toEqual(["missing_over_count"]);
		expect(left?.warnings?.[0]?.message).toBe(
			"Left alone: more entries were missing than when the import counted them; run the import again",
		);
		expect(done.counters.removed).toBe(1);
	});
});

describe("dry runs (M5c, Ruling 16)", () => {
	it("plan the same rows and write nothing, over the threshold too", async () => {
		const { deps } = await eight("trash");
		await edit(deps, "K7", { price: 77 });
		const links = JSON.stringify([...deps.links.rows.entries()]);
		const dry = await importRows(deps, items(range(0, 5)), { ...opts("trash"), dryRun: true });
		expect(dry.missing).toMatchObject({ found: 3, verdict: "refused", removed: 2 });
		expect(dry.warnings).toContain(
			"Missing entries: 3 of the 8 entries owner shop created before this import are not in the feed (38%), more than the limit of 25%, so a real run would leave them alone. Check the feed, then import it again with the job option missing: { maxPercent: 38 } to apply it (with force: true for an unchanged URL source).",
		);
		const rows = await missingRows(deps, dry);
		expect(rows.get("K5")).toMatchObject({
			status: "planned",
			action: "trash",
			changes: [{ field: "status", before: "published", after: "trashed" }],
		});
		expect(codes(rows.get("K7"))).toEqual(["missing_edited"]);
		expect(dry.counters.removed).toBe(2);
		expect(JSON.stringify([...deps.links.rows.entries()])).toBe(links);
		expect(await journalOf(deps, dry.id)).toEqual([]);
		expect([...deps.content.entries.values()].every((e) => !e.trashed)).toBe(true);
	});

	it("plan an unpublish as a change to draft", async () => {
		const { deps } = await eight("unpublish");
		const dry = await importRows(deps, items(range(0, 7)), { ...opts("unpublish"), dryRun: true });
		expect((await missingRows(deps, dry)).get("K7")).toMatchObject({
			status: "planned",
			action: "unpublish",
			changes: [{ field: "status", before: "published", after: "draft" }],
		});
	});
});
````

The fixture's helpers (`setup`, `start`, `importRows`, `runToEnd`, `records`, `journalOf`, `entryOf`, `ticking`, `csv`) are M5a's and M5b's; Task 2 gave `StartOptions` its `sourceId` and `missing` fields. Where a test above needs a fact the fakes do not hold yet (a `trashed` flag, `translations`), Task 3 added it.

In `packages/flux-import/tests/unit/service.test.ts`, add `WORKERS_MISSING_BATCH_CAP`, `WORKERS_MISSING_SCAN_CAP` and `workersBatchCap` to the import from `../../src/plugin/service.js` (where not imported yet), and add at the end of the file:
````ts
describe("Workers caps of the missing phase (M5c)", () => {
	it("reads at most 40 entries per count batch and decides at most 10 per act batch", () => {
		const job = { kind: "import", phase: "missing", template: { version: 1 } } as unknown as Job;
		expect(WORKERS_MISSING_SCAN_CAP).toBe(40);
		expect(WORKERS_MISSING_BATCH_CAP).toBe(10);
		expect(workersBatchCap({ ...job, missing: { stage: "count", fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 } })).toBe(40);
		expect(workersBatchCap({ ...job, missing: { stage: "act", fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 } })).toBe(10);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing.test.ts tests/unit/service.test.ts`
Expected: FAIL. `src/engine/missing.ts` does not exist, so the file does not load, and the service caps are not exported.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/engine/missing.ts`:
````ts
/**
 * The missing phase (spec M5c "The missing phase"). After a completed first pass, the owner's
 * entries that no record of the job had are first counted against the threshold, then moved to
 * Trash or unpublished. Each change is journalled before it is made, so `jobs/rollback` undoes
 * it. A dry run plans the same rows and changes nothing.
 */
import { linkBefore } from "./journal.js";
import { ownerOf } from "./owner.js";
import { ContentWriteError, type EntrySnapshot } from "./ports.js";
import { COST_CALL, COST_READ, type LookupCache } from "./resolve.js";
import { holdsScheduled, sweptSince } from "./rules.js";
import {
	bump,
	type Counters,
	type EngineDeps,
	type Job,
	type JournalEntry,
	journalKey,
	type LinkRow,
	linkKey,
	type MissingAction,
	type MissingState,
	type RecordError,
	type RecordRow,
	recordKey,
} from "./types.js";

type Outcome = { done: boolean };
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

/** Keys per seen query: D1 binds at most 100 parameters a query (spec F13). */
export const MISSING_PAGE = 50;
/** Links per query: the plugin storage maximum (spec F10). */
const LINK_PAGE = 100;
/** A trash and an unpublish cost what a rollback's do (`COST_DELETE`, `STEP_COST.unpublish`). */
const COST_TRASH = COST_READ * 5;
const COST_UNPUBLISH = 15;
/** What one decided entry may cost the act stage: two reads, six storage calls and a trash. */
const ACT_RESERVE = COST_READ * 2 + COST_CALL * 6 + COST_TRASH;

/** The messages of the `unchanged` missing rows (spec "Verdicts", "Act stage"), by code. */
export const MISSING_MESSAGES = {
	missing_gone: "Nothing to do: the entry no longer exists or is in Trash",
	missing_edited:
		"Left alone: the entry changed after the import last wrote it (an editor or another process)",
	missing_pending: "Left alone: the entry has a draft or a schedule that is not live",
	missing_not_live: "Nothing to do: the entry is not published",
	missing_has_translations: "Left alone: the entry has translations that are still active",
	missing_over_count:
		"Left alone: more entries were missing than when the import counted them; run the import again",
} as const;
export type MissingCode = keyof typeof MISSING_MESSAGES;

const LOCKED_MESSAGE = "Not changed: the entry is being edited (locked)";
const CHANGED_MESSAGE = "Not changed: the entry changed since it was read";
export const UNVERIFIED_MESSAGE =
	"Maybe changed: the import stopped while changing this entry and cannot tell whether someone changed it since";
const blockedMessage = (message: string) => `Not changed: a plugin refused: ${message}`;

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

/** The ULID form (`ulidx`): 10 characters of milliseconds, then 16 of randomness. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Whether a link's job was created after this one (spec Ruling 11, plan Ruling 1): its ID sorts
 * after this job's, or both are ULIDs of the same millisecond, which `ulid()` does not order
 * (plan Fact V6). Such a link is not this job's to judge.
 */
export function laterJob(linkJob: string | undefined, jobId: string): boolean {
	if (linkJob === undefined || linkJob === jobId) return false;
	if (linkJob > jobId) return true;
	return ULID.test(linkJob) && ULID.test(jobId) && linkJob.slice(0, 10) === jobId.slice(0, 10);
}

/** A link the phase counts and may act on: not marked, and not written by a later job. */
export function isCandidate(link: LinkRow, job: Job): boolean {
	return link.missing === undefined && !laterJob(link.jobId, job.id);
}

/** The counter a missing row counts toward: `removed` for an act, done or planned. */
export function missingCounter(row: Pick<RecordRow, "status">): keyof Counters | null {
	switch (row.status) {
		case "writing":
			return null;
		case "removed":
		case "planned":
			return "removed";
		default:
			return row.status as keyof Counters;
	}
}

function skip(job: Job, fromSeq: number, warning: string): Outcome {
	job.missing = { stage: "done", fromSeq, owned: 0, found: 0, rows: 0, removed: 0, verdict: "skipped" };
	job.warnings = [...(job.warnings ?? []), warning];
	return { done: true };
}

/**
 * After a completed first pass (spec "When it runs"): enters the phase when the job has a
 * threshold, every first-pass record had a readable key, and at least one had a key. Otherwise
 * the job completes now, with a warning when the phase was skipped.
 */
export function enterMissing(job: Job): Outcome {
	if (job.missingLimit === undefined || job.missingLimit === false) return { done: true };
	const fromSeq = job.cursor.seq;
	const unkeyed = job.unkeyed ?? 0;
	if (unkeyed > 0) {
		return skip(
			job,
			fromSeq,
			`Missing entries were not checked: ${unkeyed} records had no readable key (or were skipped by the reader), so their entries may be in the feed`,
		);
	}
	const c = job.counters;
	if (c.created + c.updated + c.unchanged + c.locked + c.conflict + c.failed <= unkeyed) {
		return skip(job, fromSeq, "Missing entries were not checked: the import read no record with a key");
	}
	job.phase = "missing";
	job.missing = { stage: "count", fromSeq, owned: 0, found: 0, rows: 0, removed: 0 };
	return { done: false };
}

/** One batch of the phase: a count batch or an act batch. */
export async function missingPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const m = job.missing;
	if (m === undefined || m.stage === "done") return { done: true };
	return m.stage === "count"
		? countStage(deps, job, m, started, limit, cache)
		: actStage(deps, job, m, started, limit, cache);
}

/** One page of the owner's links in the template's collection and locale (spec "Candidates"). */
function linkPage(deps: EngineDeps, job: Job, cursor: string | undefined, limit: number, cache: LookupCache) {
	const { collection, locale } = job.template;
	cache.spend(COST_CALL);
	return deps.links.query({
		where: { owner: ownerOf(job), collection, locale },
		limit,
		...(cursor === undefined ? {} : { cursor }),
	});
}

type Seen = {
	/** A first-pass row of the job has the key: the entry is in the feed. */
	imported: boolean;
	/** This phase's latest row for the key (crash repair, Task 5); null when none. */
	own: RecordRow | null;
};

/** The job's rows with the candidates' keys, `MISSING_PAGE` keys a query (spec "Candidates"). */
async function seenOf(
	deps: EngineDeps,
	job: Job,
	fromSeq: number,
	keys: readonly string[],
	cache: LookupCache,
): Promise<Map<string, Seen>> {
	const out = new Map<string, Seen>();
	for (let i = 0; i < keys.length; i += MISSING_PAGE) {
		const chunk = keys.slice(i, i + MISSING_PAGE);
		let cursor: string | undefined;
		do {
			cache.spend(COST_CALL);
			const page = await deps.records.query({
				where: { jobId: job.id, sourceKey: { in: chunk } },
				limit: LINK_PAGE,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const { data } of page.items) {
				if (data.sourceKey === null) continue;
				const seen = out.get(data.sourceKey) ?? { imported: false, own: null };
				if (data.seq < fromSeq) seen.imported = true;
				else if (seen.own === null || data.seq > seen.own.seq) seen.own = data;
				out.set(data.sourceKey, seen);
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
	}
	return out;
}

/**
 * The count stage (spec "Count stage"): pages the owner's links, tallies the candidates
 * (`owned`) and the unseen ones whose entry exists (`found`), one `content.get` each (plan
 * Ruling 3), whole pages only (plan Ruling 4). Refuses as a whole on a candidate from another
 * URL source (Ruling 27); at the end, applies the threshold.
 */
async function countStage(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const { collection, locale } = job.template;
	let reads = 0;
	for (;;) {
		const affordable = Math.floor((cache.budget - cache.spent) / COST_READ);
		const left = Math.min(limit - reads, affordable);
		if (left <= 0 && reads > 0) return { done: false };
		const page = await linkPage(deps, job, m.cursor, Math.min(LINK_PAGE, Math.max(1, left)), cache);
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		const foreign = candidates.find(
			(link) => link.ownerSource !== undefined && link.ownerSource !== job.sourceId,
		);
		if (foreign?.ownerSource !== undefined) {
			delete m.cursor;
			m.stage = "done";
			m.verdict = "refused";
			job.warnings = [
				...(job.warnings ?? []),
				`Missing entries were left alone: owner ${ownerOf(job)} also has entries created from another URL source (${foreign.ownerSource}); give each feed its own owner`,
			];
			return { done: true };
		}
		m.owned += candidates.length;
		const seen = await seenOf(deps, job, m.fromSeq, candidates.map((l) => l.sourceKey), cache);
		for (const link of candidates) {
			if (seen.get(link.sourceKey)?.imported) continue;
			cache.spend(COST_READ);
			reads++;
			if ((await deps.content.get(collection, locale, link.entryId)) !== null) m.found++;
		}
		if (!page.hasMore || page.cursor === undefined) return { done: finishCount(job, m) };
		m.cursor = page.cursor;
		if (deps.now() - started >= job.budgetMs) return { done: false };
	}
}

/**
 * The threshold (spec "Count stage", Rulings 22, 23, 29 M4): refused when `found × 100 >
 * maxPercent × base`, `base` the candidates less this job's creates (a dry run's creates made no
 * links). A real refusal ends the phase; a dry run still plans the rows (Ruling 16). Returns
 * whether the job is done.
 */
function finishCount(job: Job, m: MissingState): boolean {
	delete m.cursor;
	if (m.found === 0) {
		m.stage = "done";
		m.verdict = "act";
		return true;
	}
	const maxPercent = job.missingLimit === false || job.missingLimit === undefined ? 0 : job.missingLimit.maxPercent;
	const base = job.dryRun ? m.owned : m.owned - job.counters.created;
	if (m.found * 100 > maxPercent * base) {
		const p = base > 0 ? Math.ceil((m.found * 100) / base) : 100;
		const owner = ownerOf(job);
		const what = `${m.found} of the ${base} entries owner ${owner} created before this import are not in the feed (${p}%), more than the limit of ${maxPercent}%`;
		const how = `Check the feed, then import it again with the job option missing: { maxPercent: ${p} } to apply it (with force: true for an unchanged URL source).`;
		job.warnings = [
			...(job.warnings ?? []),
			job.dryRun
				? `Missing entries: ${what}, so a real run would leave them alone. ${how}`
				: `Missing entries were left alone: ${what}. ${how}`,
		];
		m.verdict = "refused";
		if (!job.dryRun) {
			m.stage = "done";
			return true;
		}
	} else {
		m.verdict = "act";
	}
	m.stage = "act";
	return false;
}

/** What the act stage needs about the job and the link it decides. */
type ActCtx = {
	deps: EngineDeps;
	job: Job;
	m: MissingState;
	link: LinkRow;
	action: MissingAction;
	cache: LookupCache;
};

/**
 * The act stage (spec "Act stage"): pages the candidates again and decides each unseen one
 * again, one row each after the import's rows, at most `limit` a batch, whole pages only.
 */
async function actStage(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const action = job.template.rules?.missing?.action;
	if (action === undefined) throw new Error(`Job ${job.id} has no rules.missing`);
	let seq = m.fromSeq + m.rows;
	let decided = 0;
	for (;;) {
		const affordable = Math.floor((cache.budget - cache.spent) / ACT_RESERVE);
		const left = Math.min(limit - decided, affordable);
		if (left <= 0 && decided > 0) return { done: false };
		const page = await linkPage(deps, job, m.cursor, Math.min(LINK_PAGE, Math.max(1, left)), cache);
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		const seen = await seenOf(deps, job, m.fromSeq, candidates.map((l) => l.sourceKey), cache);
		for (const link of candidates) {
			const s = seen.get(link.sourceKey);
			if (s?.imported) continue;
			// A row this phase already decided (Task 5 resumes a `writing` one).
			if (s?.own) continue;
			await decideNew({ deps, job, m, link, action, cache }, seq);
			seq++;
			m.rows++;
			decided++;
		}
		if (!page.hasMore || page.cursor === undefined) {
			delete m.cursor;
			m.stage = "done";
			return { done: true };
		}
		m.cursor = page.cursor;
		if (deps.now() - started >= job.budgetMs) return { done: false };
	}
}

/** Saves a missing row at `seq` (start and end 0: it reads no record). */
function saver(ctx: ActCtx, seq: number) {
	const { deps, job } = ctx;
	return (fields: RowFields) =>
		deps.records.put(recordKey(job.id, seq), {
			jobId: job.id,
			seq,
			start: 0,
			end: 0,
			...fields,
			updatedAt: iso(deps),
		});
}

function rowOf(
	ctx: ActCtx,
	status: RowFields["status"],
	entryId: string | null,
	extra: Partial<RowFields> = {},
): RowFields {
	return { status, sourceKey: ctx.link.sourceKey, entryId, action: ctx.action, ...extra };
}

function unchanged(ctx: ActCtx, entryId: string | null, code: MissingCode): RowFields {
	const { action: _action, ...row } = rowOf(ctx, "unchanged", entryId);
	return { ...row, warnings: [{ code, message: MISSING_MESSAGES[code] }] };
}

const issue = (code: string, message: string): RecordError => ({ code, message });

/** Counts a decided row on the job, and `removed` on the phase. */
function count(ctx: ActCtx, row: RowFields): void {
	const counter = missingCounter(row);
	if (counter) bump(ctx.job.counters, counter);
	if (counter === "removed") ctx.m.removed++;
}

/**
 * Whether the entry is as the importer left it (spec "Editor safety", Ruling 8): at the link's
 * `writtenRev`, or published by EmDash's scheduler from the importer's schedule since (M5b),
 * which the scheduling job's journal row must still show (spec F16).
 */
async function importerLeft(ctx: ActCtx, entry: EntrySnapshot): Promise<boolean> {
	const { deps, job, link, cache } = ctx;
	if (entry.rev === link.writtenRev) return true;
	if (link.scheduledAt === undefined || link.jobId === undefined || !sweptSince(link, entry)) {
		return false;
	}
	cache.spend(COST_READ);
	const { collection, locale } = job.template;
	const journal = await deps.journal.get(
		journalKey(link.jobId, linkKey(collection, locale, link.sourceKey)),
	);
	return holdsScheduled(job, journal?.wrote, link.scheduledAt, entry);
}

/** The verdict table of spec "Verdicts", in its order; `null` acts. */
async function verdictOf(ctx: ActCtx, entry: EntrySnapshot | null): Promise<MissingCode | null> {
	const { deps, job, action, cache } = ctx;
	if (entry === null) return "missing_gone";
	if (!(await importerLeft(ctx, entry))) return "missing_edited";
	if (entry.hasDraft || entry.scheduledAt !== null) return "missing_pending";
	if (action === "unpublish" && entry.status !== "published") return "missing_not_live";
	if (action === "trash" && (entry.group ?? entry.id) === entry.id) {
		cache.spend(COST_CALL);
		const group = await deps.content.translations(job.template.collection, entry.id);
		if (group.some((t) => t.id !== entry.id)) return "missing_has_translations";
	}
	return null;
}

/** Decides a candidate the phase has no row for yet, and saves its row at `seq`. */
async function decideNew(ctx: ActCtx, seq: number): Promise<void> {
	const { deps, job, m, link, action, cache } = ctx;
	const { collection, locale } = job.template;
	const save = saver(ctx, seq);
	let row: RowFields;
	try {
		cache.spend(COST_READ);
		const entry = await deps.content.get(collection, locale, link.entryId);
		const code = await verdictOf(ctx, entry);
		if (entry === null || code !== null) row = unchanged(ctx, entry?.id ?? null, code ?? "missing_gone");
		else if (m.removed >= m.found) row = unchanged(ctx, entry.id, "missing_over_count");
		else if (job.dryRun) {
			row = rowOf(ctx, "planned", entry.id, {
				changes: [{ field: "status", before: entry.status, after: action === "trash" ? "trashed" : "draft" }],
			});
		} else row = await act(ctx, entry, seq, save);
	} catch (e) {
		// Plan Ruling 10: the write-ahead row stays, since the call may have landed.
		if (!(e instanceof ContentWriteError)) throw e;
		row = rowOf(ctx, "failed", link.entryId, { errors: [issue(e.code, e.message)] });
	}
	await save(row);
	count(ctx, row);
}

/**
 * A real run's act (spec "Act stage", steps 1-6): the lock, the journal row put if absent, the
 * `writing` row, the call, then the link with its mark.
 */
async function act(
	ctx: ActCtx,
	entry: EntrySnapshot,
	seq: number,
	save: (fields: RowFields) => Promise<void>,
): Promise<RowFields> {
	const { deps, job, link, action, cache } = ctx;
	const { collection, locale } = job.template;
	cache.spend(COST_CALL);
	if (await deps.content.isLocked(collection, locale, entry.id)) {
		return rowOf(ctx, "locked", entry.id, { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	const key = journalKey(job.id, linkKey(collection, locale, link.sourceKey));
	const journal: JournalEntry = {
		jobId: job.id,
		seq,
		collection,
		locale,
		sourceKey: link.sourceKey,
		kind: action === "trash" ? "trash" : "update",
		entryId: entry.id,
		before: { link: linkBefore(link), rev: entry.rev, status: entry.status, scheduledAt: null, live: {} },
		at: iso(deps),
	};
	cache.spend(COST_CALL * 2);
	// A row an earlier, stopped attempt stored is this phase's own and is kept.
	await deps.journal.compareAndSet(key, null, journal);
	await save(rowOf(ctx, "writing", entry.id, { writtenRev: entry.rev }));
	return send(ctx, entry.id, entry.rev, key);
}

/**
 * The call (step 4) and, when it landed, the link (step 5). A call that did not land deletes the
 * write-ahead journal row (Ruling 29 M2).
 */
async function send(ctx: ActCtx, id: string, rev: string, key: string): Promise<RowFields> {
	const { deps, job, action, cache } = ctx;
	const { collection, locale } = job.template;
	if (action === "trash") {
		cache.spend(COST_TRASH);
		const trashed = await deps.content.trash(collection, id);
		if (trashed.ok) return finish(ctx, id, rev);
		await deps.journal.delete(key);
		return trashed.reason === "blocked"
			? rowOf(ctx, "failed", id, { errors: [issue("missing_blocked", blockedMessage(trashed.message))] })
			: unchanged(ctx, id, "missing_gone");
	}
	cache.spend(COST_UNPUBLISH);
	const result = await deps.content.revertStep({ collection, locale, id, rev, step: "unpublish" });
	if (result.ok) return finish(ctx, id, result.state.rev);
	await deps.journal.delete(key);
	switch (result.reason) {
		case "blocked":
			return rowOf(ctx, "failed", id, { errors: [issue("missing_blocked", blockedMessage(result.message))] });
		case "locked":
			return rowOf(ctx, "locked", id, { errors: [issue("locked", LOCKED_MESSAGE)] });
		case "conflict":
			return rowOf(ctx, "conflict", id, { errors: [issue("missing_changed", CHANGED_MESSAGE)] });
	}
}

/**
 * Step 5: the link at the revision the entry now has (Trash keeps it, spec F1), naming this job,
 * with the mark; owner, fields, unconfirmed names and schedule as they were.
 */
async function finish(ctx: ActCtx, id: string, rev: string): Promise<RowFields> {
	const { deps, job, link, action } = ctx;
	const { collection, locale } = job.template;
	ctx.cache.spend(COST_CALL);
	await deps.links.put(linkKey(collection, locale, link.sourceKey), {
		...link,
		writtenRev: rev,
		jobId: job.id,
		missing: { jobId: job.id, action, at: iso(deps) },
	});
	return rowOf(ctx, "removed", id, { writtenRev: rev });
}
````

In `packages/flux-import/src/engine/batch.ts`, add to the imports:
````ts
import { enterMissing, missingPass } from "./missing.js";
````
replace
````ts
		case "planned":
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
					: "unchanged";
````
with:
````ts
		case "planned":
			// M5c: a dry run's planned trash or unpublish counts as removed (Ruling 29 M10).
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
					: row.action === "trash" || row.action === "unpublish"
						? "removed"
						: "unchanged";
````
replace
````ts
			...(job.created ? { created: job.created } : {}),
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
````
with:
````ts
			...(job.created ? { created: job.created } : {}),
			// M5c: the missing phase and the first pass's unkeyed rows.
			...(job.missing ? { missing: job.missing } : {}),
			...(job.unkeyed ? { unkeyed: job.unkeyed } : {}),
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
````
replace
````ts
	cache: LookupCache,
): Promise<Outcome> {
	if (!job.dryRun && !job.schemaReady) {
````
with:
````ts
	cache: LookupCache,
): Promise<Outcome> {
	// M5c: the missing phase reads links and entries, not the source.
	if (job.phase === "missing") return missingPass(deps, job, started, limit, cache);
	if (!job.dryRun && !job.schemaReady) {
````
and replace
````ts
	const template = compiled.compiled;
	return job.phase === "retry"
		? retryPass(deps, job, template, started, limit, cache)
		: importPass(deps, job, template, started, limit, cache);
}
````
with:
````ts
	const template = compiled.compiled;
	if (job.phase === "retry") return retryPass(deps, job, template, started, limit, cache);
	const outcome = await importPass(deps, job, template, started, limit, cache);
	// M5c: a completed first pass enters the missing phase, or completes when it is skipped.
	return outcome.done ? enterMissing(job) : outcome;
}
````

In `packages/flux-import/src/plugin/service.ts`, replace
````ts
export const WORKERS_ROLLBACK_BATCH_CAP = 3;
````
with:
````ts
export const WORKERS_ROLLBACK_BATCH_CAP = 3;

/**
 * Entries one jobs/next call reads in the missing phase's count stage on Workers (M5c). Every
 * read counts, misses included (spec Ruling 29 M8). Plan Fact V8 projects about 260 D1 queries
 * for 40; Task 9 measures it.
 */
export const WORKERS_MISSING_SCAN_CAP = 40;

/**
 * Entries one jobs/next call decides in the missing phase's act stage on Workers (M5c): a read,
 * a lock check, the journal row, two row saves, the trash or unpublish (19 or 33 D1 queries) and
 * the link. Plan Fact V8 projects about 470 queries for 10 unpublishes; Task 9 measures it.
 */
export const WORKERS_MISSING_BATCH_CAP = 10;
````
and replace
````ts
export function workersBatchCap(job: Job): number {
	if (job.kind === "rollback") return WORKERS_ROLLBACK_BATCH_CAP;
````
with:
````ts
export function workersBatchCap(job: Job): number {
	if (job.kind === "rollback") return WORKERS_ROLLBACK_BATCH_CAP;
	if (job.phase === "missing") {
		return job.missing?.stage === "count" ? WORKERS_MISSING_SCAN_CAP : WORKERS_MISSING_BATCH_CAP;
	}
````

- [ ] **Step 4: Run them to see them pass**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing.test.ts tests/unit/service.test.ts`
Expected: PASS (every test of `missing.test.ts`, and the new service test).

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/missing.ts packages/flux-import/src/engine/batch.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/missing.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Add the missing phase: candidates, the seen query, verdicts, the count stage and threshold, and the journalled act stage"
```

### Task 5: Crash repair, the recount and the retry boundary

**Files:**
- Modify: `packages/flux-import/src/engine/missing.ts`, `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/missing-repair.test.ts` (new)

**Interfaces:**
- Consumes:
  - Task 4: `actStage`, `decideNew`, `finish`, `saver`, `rowOf`, `unchanged`, `count`, `UNVERIFIED_MESSAGE`;
  - Task 6: `restoreTrashed`, for the end-to-end rollbacks of the tests;
  - `decodeRev`, `tallyCounters`, `retryPass`, `createRollback`, `transitionJob`.
- Produces:
  - in `missing.ts`: `repair` (the next seq read from the phase's last row, and `removed` counted again after a lost batch), `resumeRow` and `landed` (a `writing` row finished, started over or reported `missing_unverified`), the `writing` row of a link this job already marked finished as `removed`, and the journal clean-up of left-alone rows (plan Ruling 14);
  - in `batch.ts`: the job's counters tallied from the rows when the phase completes, and `retryPass` bounded by `seq < missing.fromSeq`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/missing-repair.test.ts`:
````ts
/**
 * The missing phase across stops (spec M5c "Crash repair"): a call that landed is finished once,
 * one that did not starts over, rows a lost batch saved are counted once, and a retry leaves the
 * phase's rows alone. A rollback undoes the phase.
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { transitionJob } from "../../src/engine/jobs.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type Job, journalKey, type LinkRow } from "../../src/engine/types.js";
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
} from "./rollback-fixture.js";

const items = (keys: number[]): Row[] =>
	keys.map((i) => ({ sku: `K${i}`, name: `Item ${i}`, price: i }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const opts = (action: "trash" | "unpublish", more: StartOptions = {}): StartOptions => ({
	...more,
	extra: { rules: { owner: "shop", missing: { action, maxPercent: 50 } } },
});
const linkOf = async (deps: Deps, key: string) =>
	(await deps.links.get(`products:en:${key}`)) as LinkRow;
const rowsFrom = async (deps: Deps, job: Job) =>
	(await records(deps, job.id)).filter((r) => r.seq >= (job.missing?.fromSeq ?? 0));

/** Drops a stopped batch's lease, so the next batch resumes the job at once. */
async function unlease(deps: Deps, id: string) {
	const j = await deps.jobs.get(id);
	if (j) await deps.jobs.put(id, { ...j, lease: null });
}

/** Runs batches until one throws "stop"; the hook arms the stop. */
async function runUntilStop(deps: Deps, jobId: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const job = await runBatch(deps, jobId, "w1");
			if (job.status !== "running" && job.status !== "created") throw new Error("finished");
		} catch (e) {
			if ((e as Error).message === "stop") return unlease(deps, jobId);
			throw e;
		}
	}
	throw new Error("never stopped");
}

/** Eight owned, published entries, then a job whose feed lacks K6 and K7, started. */
async function second(action: "trash" | "unpublish", more: StartOptions = {}) {
	const made = setup();
	await importRows(made.deps, items(range(0, 8)), opts(action));
	const job = await start(made.deps, csv(items(range(0, 6))), opts(action, more));
	return { ...made, job };
}

describe("a stop during an act (M5c crash repair)", () => {
	it("finishes a trash that landed once, without a second call", async () => {
		const { deps, job } = await second("trash");
		const trash = deps.content.trash.bind(deps.content);
		let calls = 0;
		deps.content.trash = async (collection, id) => {
			calls++;
			const result = await trash(collection, id);
			if (calls === 1) throw new Error("stop");
			return result;
		};
		await runUntilStop(deps, job.id);
		expect((await rowsFrom(deps, (await deps.jobs.get(job.id)) as Job)).map((r) => r.status)).toEqual(["writing"]);
		const done = await runToEnd(deps, job.id);
		expect(calls).toBe(2);
		expect(done.counters.removed).toBe(2);
		expect(done.missing).toMatchObject({ rows: 2, removed: 2 });
		expect((await rowsFrom(deps, done)).map((r) => [r.sourceKey, r.status])).toEqual([
			["K6", "removed"],
			["K7", "removed"],
		]);
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id, action: "trash" } });
		expect((await journalOf(deps, job.id)).filter((j) => j.kind === "trash")).toHaveLength(2);
	});

	it("starts a call that never went out over, journalling the entry as it now is", async () => {
		const { deps, job } = await second("trash");
		let armed = true;
		deps.content.beforeStep = (step) => {
			if (step === "trash" && armed) {
				armed = false;
				throw new Error("stop");
			}
		};
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		expect(done.counters.removed).toBe(2);
		expect(entryOf(deps, "K6").trashed).toBe(true);
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).toMatchObject({
			kind: "trash",
			before: { rev: (await linkOf(deps, "K6")).writtenRev },
		});
	});

	it("reports an edit after the stop as edited, and drops the stopped attempt's journal row", async () => {
		const { deps, job } = await second("trash");
		let armed = true;
		deps.content.beforeStep = (step) => {
			if (step === "trash" && armed) {
				armed = false;
				throw new Error("stop");
			}
		};
		await runUntilStop(deps, job.id);
		const k6 = entryOf(deps, "K6");
		await deps.content.update({ collection: "products", locale: "en", id: k6.id, rev: deps.content.revOf(k6.id), data: { price: 60 } });
		await deps.content.publish({ id: k6.id, rev: deps.content.revOf(k6.id) });
		const done = await runToEnd(deps, job.id);
		const k6Row = (await rowsFrom(deps, done)).find((r) => r.sourceKey === "K6");
		expect(k6Row?.warnings?.map((w) => w.code)).toEqual(["missing_edited"]);
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).toBeNull();
		expect(k6.trashed).toBe(false);
	});

	it("drops a journal row a stop left before its writing row (plan Ruling 14)", async () => {
		const { deps, job } = await second("trash");
		const put = deps.records.put.bind(deps.records);
		let armed = true;
		deps.records.put = async (k, v) => {
			if (armed && v.status === "writing") {
				armed = false;
				throw new Error("stop");
			}
			return put(k, v);
		};
		await runUntilStop(deps, job.id);
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).not.toBeNull();
		const k6 = entryOf(deps, "K6");
		await deps.content.update({ collection: "products", locale: "en", id: k6.id, rev: deps.content.revOf(k6.id), data: { price: 60 } });
		await deps.content.publish({ id: k6.id, rev: deps.content.revOf(k6.id) });
		await runToEnd(deps, job.id);
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).toBeNull();
	});

	it("finishes a row whose link put landed before the stop", async () => {
		const { deps, job } = await second("trash");
		const put = deps.records.put.bind(deps.records);
		let armed = true;
		deps.records.put = async (k, v) => {
			if (armed && v.status === "removed") {
				armed = false;
				throw new Error("stop");
			}
			return put(k, v);
		};
		await runUntilStop(deps, job.id);
		expect(await linkOf(deps, "K6")).toMatchObject({ missing: { jobId: job.id } });
		const done = await runToEnd(deps, job.id);
		expect(await records(deps, job.id).then((rows) => rows.filter((r) => r.status === "writing"))).toEqual([]);
		expect(done.counters.removed).toBe(2);
		expect(done.missing?.removed).toBe(2);
	});

	it("finishes an unpublish that landed, at the revision it left", async () => {
		const { deps, job } = await second("unpublish");
		let armed = true;
		deps.content.afterStep = (step) => {
			if (step === "unpublish" && armed) {
				armed = false;
				throw new Error("stop");
			}
		};
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		const k6 = entryOf(deps, "K6");
		expect(k6.status).toBe("draft");
		expect(await linkOf(deps, "K6")).toMatchObject({ writtenRev: deps.content.revOf(k6.id), jobId: job.id });
		expect(done.counters.removed).toBe(2);
		expect(deps.content.calls.filter((c) => c.startsWith("unpublish:"))).toHaveLength(2);
	});

	it("cannot tell an unpublish that landed from an editor's later change", async () => {
		const { deps, job } = await second("unpublish");
		let armed = true;
		deps.content.afterStep = (step) => {
			if (step === "unpublish" && armed) {
				armed = false;
				throw new Error("stop");
			}
		};
		await runUntilStop(deps, job.id);
		const k6 = entryOf(deps, "K6");
		await deps.content.update({ collection: "products", locale: "en", id: k6.id, rev: deps.content.revOf(k6.id), data: { price: 60 } });
		const done = await runToEnd(deps, job.id);
		const row = (await rowsFrom(deps, done)).find((r) => r.sourceKey === "K6");
		expect(row).toMatchObject({
			status: "conflict",
			errors: [
				{
					code: "missing_unverified",
					message:
						"Maybe changed: the import stopped while changing this entry and cannot tell whether someone changed it since",
				},
			],
		});
		// The call may have landed: its journal row stays for a rollback (spec "Crash repair").
		expect(await deps.journal.get(journalKey(job.id, "products:en:K6"))).not.toBeNull();
		expect(await linkOf(deps, "K6")).not.toHaveProperty("missing");
	});
});

describe("a lost batch (M5c)", () => {
	it("counts rows a batch saved before its release was lost once, and continues the seq", async () => {
		const { deps, job } = await second("trash", { batchSize: 1 });
		const compareAndSet = deps.jobs.compareAndSet.bind(deps.jobs);
		let armed = true;
		deps.jobs.compareAndSet = async (k, expected, next) => {
			if (armed && next.missing?.stage === "act" && next.missing.rows === 1) {
				armed = false;
				throw new Error("stop");
			}
			return compareAndSet(k, expected, next);
		};
		await runUntilStop(deps, job.id);
		const done = await runToEnd(deps, job.id);
		const rows = await rowsFrom(deps, done);
		expect(rows.map((r) => [r.seq, r.sourceKey, r.status])).toEqual([
			[6, "K6", "removed"],
			[7, "K7", "removed"],
		]);
		expect(done.missing).toMatchObject({ rows: 2, removed: 2 });
		expect(done.counters).toMatchObject({ unchanged: 6, removed: 2 });
	});

	it("never removes more than found after a lost batch (the recount)", async () => {
		const { deps, job } = await second("trash", { batchSize: 1 });
		const compareAndSet = deps.jobs.compareAndSet.bind(deps.jobs);
		let armed = true;
		deps.jobs.compareAndSet = async (k, expected, next) => {
			if (armed && next.missing?.stage === "act" && next.missing.rows === 1) {
				armed = false;
				throw new Error("stop");
			}
			return compareAndSet(k, expected, next);
		};
		await runUntilStop(deps, job.id);
		const stored = (await deps.jobs.get(job.id)) as Job;
		// The saved job still says no row was decided; the recount reads the row the lost batch saved.
		expect(stored.missing).toMatchObject({ rows: 0, removed: 0, found: 2 });
		const done = await runToEnd(deps, job.id);
		expect(done.missing?.removed).toBe(2);
	});
});

describe("cancel, pause and retry (M5c)", () => {
	it("stops on a cancel mid-stage, and resumes from the cursor after a pause", async () => {
		const made = setup();
		await importRows(made.deps, items(range(0, 8)), opts("unpublish"));
		const job = await start(made.deps, csv(items(range(0, 5))), opts("unpublish", { batchSize: 1 }));
		let stored = await runBatch(made.deps, job.id, "w1");
		while ((stored.missing?.rows ?? 0) < 1) stored = await runBatch(made.deps, job.id, "w1");
		await transitionJob(made.deps, job.id, "pause");
		await transitionJob(made.deps, job.id, "resume");
		const done = await runToEnd(made.deps, job.id);
		expect(done.missing).toMatchObject({ stage: "done", rows: 3, removed: 3 });

		const other = await second("unpublish", { batchSize: 1 });
		stored = await runBatch(other.deps, other.job.id, "w1");
		while ((stored.missing?.rows ?? 0) < 1) stored = await runBatch(other.deps, other.job.id, "w1");
		await transitionJob(other.deps, other.job.id, "cancel");
		const cancelled = await runBatch(other.deps, other.job.id, "w1");
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.missing).toMatchObject({ stage: "act", rows: 1 });
		expect(entryOf(other.deps, "K7").status).toBe("published");
	});

	it("retries the first pass's failed rows and leaves the phase's rows alone", async () => {
		const made = setup();
		const { deps } = made;
		await importRows(deps, items(range(0, 8)), opts("trash"));
		deps.content.blockDelete = (id) => (id === entryOf(deps, "K7").id ? "Keep it." : null);
		const body = items(range(0, 5)).concat([{ sku: "K5", name: "Item 5", price: "n/a" as never }]);
		const job = await importRows(deps, body, opts("trash"));
		const failed = (await rowsFrom(deps, job)).find((r) => r.sourceKey === "K7");
		expect(failed?.status).toBe("failed");
		deps.content.blockDelete = () => null;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		const after = (await rowsFrom(deps, retried)).find((r) => r.sourceKey === "K7");
		expect(after).toEqual(failed);
		expect(entryOf(deps, "K7").trashed).toBe(false);
		expect(retried.counters.removed).toBe(1);
	});
});

describe("rolling the phase back (M5c)", () => {
	it("restores and republishes trashed entries, and a later import finds them as before", async () => {
		const { deps } = setup();
		const first = await importRows(deps, items(range(0, 8)), opts("trash"));
		const before = structuredClone(entryOf(deps, "K7"));
		const trashing = await importRows(deps, items(range(0, 6)), opts("trash"));
		expect(entryOf(deps, "K7").trashed).toBe(true);
		const { rollback } = await createRollback(deps, { id: trashing.id });
		const rolled = await runToEnd(deps, rollback.id);
		expect(rolled.counters.reverted).toBe(2);
		const k7 = entryOf(deps, "K7");
		expect(k7).toMatchObject({ trashed: false, status: "published", data: before.data, slug: before.slug });
		expect(await linkOf(deps, "K7")).toMatchObject({ jobId: first.id, owner: "shop", writtenRev: deps.content.revOf(k7.id) });
		expect(await linkOf(deps, "K7")).not.toHaveProperty("missing");
		const again = await importRows(deps, items(range(0, 8)), opts("trash"));
		expect(again.counters).toMatchObject({ unchanged: 8, failed: 0 });
	});

	it("republishes unpublished entries through the M5a sequence", async () => {
		const { deps } = setup();
		const first = await importRows(deps, items(range(0, 8)), opts("unpublish"));
		const unpublishing = await importRows(deps, items(range(0, 6)), opts("unpublish"));
		const { rollback } = await createRollback(deps, { id: unpublishing.id });
		await runToEnd(deps, rollback.id);
		for (const key of ["K6", "K7"]) {
			const e = entryOf(deps, key);
			expect(e.status, key).toBe("published");
			expect(await linkOf(deps, key)).toMatchObject({ jobId: first.id, owner: "shop", writtenRev: deps.content.revOf(e.id) });
			expect(await linkOf(deps, key)).not.toHaveProperty("missing");
		}
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing-repair.test.ts`
Expected: FAIL. The resumed rows stay `writing` (Task 4 skips a row the phase already has), the lost batch's rows are counted twice or overwritten, the retry reads the phase's rows as records, and the edited entry's journal row stays. The two rollback tests pass once Task 6 is merged; they fail before it with `journal_kind_unknown`.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/missing.ts`, add to the imports:
````ts
import { decodeRev } from "./revs.js";
````
and add after `actStage`:
````ts
/**
 * Before each act batch (spec "Crash repair"): rows a stopped batch saved before its release was
 * lost are past `fromSeq + rows`. The next seq follows the last row, and `removed` is counted again
 * from the rows, so the stage never removes more than it found (Ruling 20).
 */
async function repair(deps: EngineDeps, job: Job, m: MissingState, cache: LookupCache): Promise<void> {
	cache.spend(COST_CALL);
	const last = await deps.records.query({
		where: { jobId: job.id, seq: { gte: m.fromSeq } },
		orderBy: { seq: "desc" },
		limit: 1,
	});
	const lastSeq = last.items[0]?.data.seq;
	if (lastSeq === undefined || lastSeq + 1 <= m.fromSeq + m.rows) return;
	m.rows = lastSeq + 1 - m.fromSeq;
	let removed = 0;
	let cursor: string | undefined;
	do {
		cache.spend(COST_CALL);
		const page = await deps.records.query({
			where: { jobId: job.id, seq: { gte: m.fromSeq }, status: { in: ["removed", "planned"] } },
			limit: LINK_PAGE,
			...(cursor === undefined ? {} : { cursor }),
		});
		removed += page.items.length;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	m.removed = removed;
}

/**
 * A `writing` row a stopped batch left (spec "Crash repair"): finished when its call landed,
 * started over at the same seq when it did not (plan Ruling 14), `missing_unverified` when the
 * entry moved since and the call may have landed. That row keeps its journal row.
 */
async function resumeRow(ctx: ActCtx, row: RecordRow): Promise<void> {
	const { deps, job, link, cache } = ctx;
	const { collection, locale } = job.template;
	const key = journalKey(job.id, linkKey(collection, locale, link.sourceKey));
	let fields: RowFields | null;
	try {
		fields =
			row.entryId === null || row.writtenRev === undefined
				? null
				: await landed(ctx, row.entryId, row.writtenRev);
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		fields = rowOf(ctx, "failed", row.entryId, { errors: [issue(e.code, e.message)] });
	}
	if (fields === null) {
		cache.spend(COST_CALL);
		await deps.journal.delete(key);
		return decideNew(ctx, row.seq);
	}
	await saver(ctx, row.seq)(fields);
	count(ctx, fields);
}

/** Whether a stopped call landed: its finished row, null when it did not, or an unverified row. */
async function landed(ctx: ActCtx, id: string, rev: string): Promise<RowFields | null> {
	const { deps, job, action, cache } = ctx;
	const { collection, locale } = job.template;
	cache.spend(COST_READ);
	const active = await deps.content.get(collection, locale, id);
	if (action === "trash") {
		if (active !== null) return null;
		// Plan Ruling 3: only here does the act stage look in Trash. Trash keeps `_rev` (spec F1).
		cache.spend(COST_READ);
		const trashed = await deps.content.getIncludingTrashed(collection, locale, id);
		if (trashed === null) return null;
		return trashed.rev === rev ? finish(ctx, id, rev) : unverified(ctx, id);
	}
	if (active === null || active.rev === rev) return null;
	// An unpublish moves the version on by one and leaves a draft without a schedule (spec V2).
	const now = decodeRev(active.rev);
	const was = decodeRev(rev);
	const unpublished =
		now !== null &&
		was !== null &&
		now.version === was.version + 1 &&
		active.status !== "published" &&
		active.scheduledAt === null;
	return unpublished ? finish(ctx, id, active.rev) : unverified(ctx, id);
}

function unverified(ctx: ActCtx, id: string): RowFields {
	return rowOf(ctx, "conflict", id, { errors: [issue("missing_unverified", UNVERIFIED_MESSAGE)] });
}
````
In `actStage`, replace
````ts
	let seq = m.fromSeq + m.rows;
````
with:
````ts
	await repair(deps, job, m, cache);
	let seq = m.fromSeq + m.rows;
````
and replace
````ts
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		const seen = await seenOf(deps, job, m.fromSeq, candidates.map((l) => l.sourceKey), cache);
		for (const link of candidates) {
			const s = seen.get(link.sourceKey);
			if (s?.imported) continue;
			// A row this phase already decided (Task 5 resumes a `writing` one).
			if (s?.own) continue;
````
(the `actStage` loop head) with:
````ts
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		// A stop after step 5's link put, before the row save: the link already carries this
		// job's mark, so it is no candidate, and its `writing` row is finished here.
		const marked = page.items.map((i) => i.data).filter((link) => link.missing?.jobId === job.id);
		const keys = [...candidates, ...marked].map((l) => l.sourceKey);
		const seen = await seenOf(deps, job, m.fromSeq, keys, cache);
		for (const link of marked) {
			const own = seen.get(link.sourceKey)?.own;
			if (own?.status !== "writing") continue;
			const ctx = { deps, job, m, link, action, cache };
			const row = rowOf(ctx, "removed", own.entryId, link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev });
			await saver(ctx, own.seq)(row);
			count(ctx, row);
		}
		for (const link of candidates) {
			const s = seen.get(link.sourceKey);
			if (s?.imported) continue;
			// A row this phase already decided; a `writing` one a stop left is resumed.
			if (s?.own) {
				if (s.own.status === "writing") {
					await resumeRow({ deps, job, m, link, action, cache }, s.own);
					decided++;
				}
				continue;
			}
````
In `decideNew`, replace
````ts
		if (entry === null || code !== null) row = unchanged(ctx, entry?.id ?? null, code ?? "missing_gone");
		else if (m.removed >= m.found) row = unchanged(ctx, entry.id, "missing_over_count");
````
with:
````ts
		if (entry === null || code !== null) row = unchanged(ctx, entry?.id ?? null, code ?? "missing_gone");
		else if (m.removed >= m.found) row = unchanged(ctx, entry.id, "missing_over_count");
		if (row !== undefined && !job.dryRun) {
			// Plan Ruling 14: a journal row a stop left before its `writing` row; no call went out.
			cache.spend(COST_CALL);
			await deps.journal.delete(journalKey(job.id, linkKey(collection, locale, link.sourceKey)));
		}
````
and, since `row` is now read before it is always assigned, declare it as `let row: RowFields | undefined;` and turn the two following branches into:
````ts
		if (row === undefined && job.dryRun && entry !== null) {
			row = rowOf(ctx, "planned", entry.id, {
				changes: [{ field: "status", before: entry.status, after: action === "trash" ? "trashed" : "draft" }],
			});
		} else if (row === undefined && entry !== null) row = await act(ctx, entry, seq, save);
````
followed, before `await save(row)`, by `if (row === undefined) throw new Error("unreachable: no missing row decided");`.

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	// M5c: the missing phase reads links and entries, not the source.
	if (job.phase === "missing") return missingPass(deps, job, started, limit, cache);
````
with:
````ts
	// M5c: the missing phase reads links and entries, not the source. Its last batch tallies the
	// counters from the rows, so a lost batch's rows count once (spec "Crash repair").
	if (job.phase === "missing") {
		const outcome = await missingPass(deps, job, started, limit, cache);
		if (outcome.done) job.counters = await tallyCounters(deps, job.id);
		return outcome;
	}
````
and in `retryPass` replace
````ts
				seq: { gte: job.retryFromSeq },
````
with:
````ts
				// M5c: the missing phase's rows read no record; a retry leaves them (spec "Retry").
				seq:
					job.missing === undefined
						? { gte: job.retryFromSeq }
						: { gte: job.retryFromSeq, lt: job.missing.fromSeq },
````

- [ ] **Step 4: Run them to see them pass**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/missing-repair.test.ts tests/unit/missing.test.ts`
Expected: PASS, the two rollback tests included once Task 6 is merged.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/missing.ts packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/missing-repair.test.ts
git commit -m "Repair the missing phase after a stop: resume writing rows, recount removed, continue the seq, and keep retries to the first pass"
```

### Task 6: Rollback steps 8 and 9

**Files:**
- Modify: `packages/flux-import/src/engine/revert.ts`
- Test: `packages/flux-import/tests/unit/rollback-trash.test.ts` (new)

**Interfaces:**
- Consumes:
  - Task 1: `JournalEntry.kind "trash"`, `RollbackAction "restore"`, `JournalBefore.link` with `owner`, `ownerSource` and `missing`;
  - Task 3: `RevertStep "restore"`, `STEP_COST.restore`, `TRANSLATION_SLOT_TAKEN`, the fakes' restore;
  - `decideRow`, `findEntry`, `rowOf`, `restoreChanged`'s link hand-back, `decodeRev`.
- Produces:
  - `restoreTrashed(ctx, entry)`: step 8 restores the entry from Trash, step 9 publishes it when the journal's `before.status` is `published`, then the link goes back as it was before the act;
  - `handBack(ctx, entryId, before, state, linked)`, extracted from `restoreChanged` and used by both, carrying `owner`, `ownerSource` and `missing` from `before.link`;
  - `ROLLBACK_ACTIONS` with `"restore"`, so its rows count as reverted, unchanged or failed like the others.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/rollback-trash.test.ts`:
````ts
/**
 * Rolling back a trash of the missing phase (spec M5c "Rollback", steps 8 and 9). The journal
 * rows are written here as the act stage writes them, so these tests need neither Task 2 nor 4.
 */
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { linkBefore } from "../../src/engine/journal.js";
import { createRollback } from "../../src/engine/rollback.js";
import { type Job, journalKey, type LinkRow, type RecordRow } from "../../src/engine/types.js";
import { type Deps, entryOf, importRows, records, runToEnd, setup } from "./rollback-fixture.js";

const KEY = "products:en:K9";
const linkOf = async (deps: Deps) => (await deps.links.get(KEY)) as LinkRow;

/** K9 from an earlier job, then a later job that trashed it as missing, journalled. */
async function trashed(opts: { publish?: boolean } = {}) {
	const made = setup();
	const { deps } = made;
	const owner = { extra: { rules: { owner: "shop" } } };
	const earlier = await importRows(deps, [{ sku: "K9", name: "Item 9", price: 9 }], {
		...owner,
		...(opts.publish === false ? { publish: false } : {}),
	});
	const job = await importRows(deps, [{ sku: "K1", name: "Item 1", price: 1 }], owner);
	const link = await linkOf(deps);
	const before = structuredClone(entryOf(deps, "K9"));
	await deps.journal.put(journalKey(job.id, KEY), {
		jobId: job.id,
		seq: 50,
		collection: "products",
		locale: "en",
		sourceKey: "K9",
		kind: "trash",
		entryId: before.id,
		before: { link: linkBefore(link), rev: link.writtenRev, status: before.status, scheduledAt: null, live: {} },
		at: new Date(deps.now()).toISOString(),
	});
	expect((await deps.content.trash("products", before.id)).ok).toBe(true);
	await deps.links.put(KEY, {
		...link,
		jobId: job.id,
		missing: { jobId: job.id, action: "trash", at: new Date(deps.now()).toISOString() },
	});
	return { ...made, earlier, job, before };
}

async function rollBack(deps: Deps, job: Job, dryRun = false) {
	const { rollback } = await createRollback(deps, { id: job.id, ...(dryRun ? { dryRun } : {}) });
	const done = await runToEnd(deps, rollback.id);
	const row = (await records(deps, rollback.id)).find((r) => r.sourceKey === "K9") as RecordRow;
	return { done, row };
}

describe("rolling back a trash (M5c steps 8 and 9)", () => {
	it("restores and republishes the entry, and hands the link back", async () => {
		const { deps, earlier, job, before } = await trashed();
		const { row } = await rollBack(deps, job);
		expect(row).toMatchObject({ status: "reverted", action: "restore", entryId: before.id });
		const after = entryOf(deps, "K9");
		expect(after).toMatchObject({ trashed: false, status: "published", data: before.data, slug: before.slug });
		const link = await linkOf(deps);
		expect(link).toMatchObject({ jobId: earlier.id, owner: "shop", writtenRev: deps.content.revOf(after.id) });
		expect(link).not.toHaveProperty("missing");
	});

	it("restores a draft without publishing it", async () => {
		const { deps, job } = await trashed({ publish: false });
		const { row } = await rollBack(deps, job);
		expect(row.status).toBe("reverted");
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "draft" });
		expect(deps.content.calls.filter((c) => c.startsWith("publish:"))).toHaveLength(0);
	});

	it("plans the restore in a dry run and changes nothing", async () => {
		const { deps, job } = await trashed();
		const { row } = await rollBack(deps, job, true);
		expect(row).toMatchObject({
			status: "planned",
			action: "restore",
			changes: [{ field: "status", before: "trashed", after: "published" }],
		});
		expect(entryOf(deps, "K9").trashed).toBe(true);
	});

	it("finds nothing to roll back when the trash never landed", async () => {
		const { deps, job, before } = await trashed();
		await deps.content.revertStep({ collection: "products", locale: "en", id: before.id, rev: deps.content.revOf(before.id), step: "restore" });
		const { missing: _mark, ...unmarked } = await linkOf(deps);
		await deps.links.put(KEY, unmarked);
		const { row } = await rollBack(deps, job);
		expect(row.warnings?.map((w) => w.code)).toEqual(["nothing_to_roll_back"]);
	});

	it("refuses an entry restored, or changed and trashed again, since", async () => {
		for (const trashAgain of [false, true]) {
			const { deps, job, before } = await trashed();
			const id = before.id;
			await deps.content.revertStep({ collection: "products", locale: "en", id, rev: deps.content.revOf(id), step: "restore" });
			if (trashAgain) {
				await deps.content.update({ collection: "products", locale: "en", id, rev: deps.content.revOf(id), data: { price: 90 } });
				await deps.content.trash("products", id);
			}
			const { row } = await rollBack(deps, job);
			expect(row, String(trashAgain)).toMatchObject({
				status: "conflict",
				errors: [
					{
						code: "rollback_changed",
						message: "Not rolled back: the entry was restored or changed after the import moved it to Trash",
					},
				],
			});
		}
	});

	it("reports a taken translation slot, a lock and a plugin's refusal", async () => {
		const slot = await trashed();
		const twin = { ...structuredClone(slot.before), id: "twin", trashed: false };
		slot.deps.content.entries.set("twin", twin);
		expect((await rollBack(slot.deps, slot.job)).row).toMatchObject({
			status: "conflict",
			errors: [{ code: "rollback_changed", message: "Not rolled back: the entry's translation slot is taken" }],
		});

		const locked = await trashed();
		locked.deps.content.locked.add(locked.before.id);
		expect((await rollBack(locked.deps, locked.job)).row.status).toBe("locked");

		const blocked = await trashed();
		blocked.deps.content.blockStep = (step) => (step === "restore" ? "No." : null);
		expect((await rollBack(blocked.deps, blocked.job)).row).toMatchObject({
			status: "failed",
			errors: [{ code: "rollback_blocked", message: "Not rolled back: a plugin refused the restore: No." }],
		});
	});

	it("resumes after a stop once the restore landed, publishing without a second restore", async () => {
		const { deps, job } = await trashed();
		const { rollback } = await createRollback(deps, { id: job.id });
		deps.content.afterStep = (step) => {
			if (step === "restore") throw new Error("stop");
		};
		await expect(runToEnd(deps, rollback.id)).rejects.toThrow("stop");
		deps.content.afterStep = () => {};
		const stopped = await deps.jobs.get(rollback.id);
		if (stopped) await deps.jobs.put(rollback.id, { ...stopped, lease: null });
		await runBatch(deps, rollback.id, "w2");
		await runToEnd(deps, rollback.id);
		expect(entryOf(deps, "K9")).toMatchObject({ trashed: false, status: "published" });
		expect(deps.content.calls.filter((c) => c.startsWith("restore:"))).toHaveLength(1);
	});
});
````

If `runToEnd` swallows the stop as an unexpected batch error instead of rethrowing it (check `runBatch`'s handling in `batch.ts`), replace the `rejects.toThrow` line with a loop of `runBatch` calls that catches the error, as `runUntilStop` in Task 5's test does.

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rollback-trash.test.ts`
Expected: FAIL. `decideRow` reports `journal_kind_unknown` for the `trash` rows.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/revert.ts`, add to the imports `TRANSLATION_SLOT_TAKEN` from `./ports.js` and `decodeRev` from `./revs.js`, and next to the other messages:
````ts
/** M5c: an entry the missing phase trashed that is no longer as the phase left it. */
const TRASH_CHANGED_MESSAGE =
	"Not rolled back: the entry was restored or changed after the import moved it to Trash";
const SLOT_TAKEN_MESSAGE = "Not rolled back: the entry's translation slot is taken";
````
Replace
````ts
const ROLLBACK_ACTIONS: ReadonlySet<string> = new Set(["delete", "trash", "revert"]);
````
with:
````ts
const ROLLBACK_ACTIONS: ReadonlySet<string> = new Set(["delete", "trash", "revert", "restore"]);
````
In `decideRow`, replace
````ts
	if (journal.kind !== "create" && journal.kind !== "update") {
````
with:
````ts
	if (journal.kind !== "create" && journal.kind !== "update" && journal.kind !== "trash") {
````
and
````ts
	const found = await findEntry(ctx);
	if (!found) {
````
with:
````ts
	const found = await findEntry(ctx);
	// M5c: a trash of the missing phase is undone by a restore (spec "Rollback").
	if (journal.kind === "trash") return restoreTrashed(ctx, found?.entry ?? null);
	if (!found) {
````
In `restoreChanged`, replace everything from
````ts
	// The link goes back to the job before, at the rollback's revision, so that job's rollback
````
to the end of the function with:
````ts
	await handBack(ctx, entry.id, before, state, linked);
	return rowOf(ctx, "reverted");
}
````
and add the extracted function after it, with the code that was there and the M5c fields:
````ts
/**
 * The link goes back to the job before, at the rollback's revision, so that job's rollback and
 * the next import see the entry as that job left it. M5c: with the owner stamp and mark it had.
 */
async function handBack(
	ctx: RowCtx,
	entryId: string,
	before: JournalBefore,
	state: EntryState,
	linked: boolean,
): Promise<void> {
	const { deps, journal } = ctx;
	const { collection, locale } = journal;
	const id = linkKey(collection, locale, journal.sourceKey);
	if (before.link === null) {
		if (linked) await deps.links.delete(id);
		return;
	}
	// Only when the entry was as that job left it: an editor's change in between stays one.
	const moved =
		before.link.writtenRev !== undefined &&
		before.rev !== undefined &&
		before.rev === before.link.writtenRev;
	// At the rollback's revision the link records the schedule the entry is left with: the
	// earlier job's only while the entry is still scheduled for that time (review I1).
	const scheduledAt = moved
		? sameInstant(state.scheduledAt, before.link.scheduledAt ?? null)
			? before.link.scheduledAt
			: undefined
		: before.link.scheduledAt;
	// M5b: the fingerprints describe the entry at that job's revision, not at the rollback's.
	const unconfirmed = moved
		? [...new Set([...(before.link.unconfirmed ?? []), ...Object.keys(before.link.fields ?? {})])]
		: (before.link.unconfirmed ?? []);
	await deps.links.put(id, {
		collection,
		locale,
		sourceKey: journal.sourceKey,
		entryId,
		...(before.link.writtenRev === undefined
			? {}
			: { writtenRev: moved ? state.rev : before.link.writtenRev }),
		...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
		...(before.link.fields === undefined ? {} : { fields: before.link.fields }),
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
		...(scheduledAt === undefined ? {} : { scheduledAt }),
		// M5c: the owner the link had, and its mark (none, for a link the phase acted on).
		...(before.link.owner === undefined ? {} : { owner: before.link.owner }),
		...(before.link.ownerSource === undefined ? {} : { ownerSource: before.link.ownerSource }),
		...(before.link.missing === undefined ? {} : { missing: before.link.missing }),
	});
}
````
Keep the existing comments of the moved code in full where they are longer than above; the logic is unchanged.

Then add, after `handBack`:
````ts
/**
 * Whether a restore step sent before a stop shows its result (spec "Crash repair"): step 8 an
 * active, unpublished entry one version past the revision it was sent at; step 9 a published one
 * without a draft, one version on again.
 */
function reachedTrash(step: number, entry: Found, sentAt: string): boolean {
	const now = decodeRev(entry.rev);
	const was = decodeRev(sentAt);
	if (now === null || was === null || entry.trashed || now.version !== was.version + 1) return false;
	return step === 8 ? entry.status !== "published" : entry.status === "published" && !entry.hasDraft;
}

/**
 * Steps 8 and 9 (spec M5c "Rollback"): the entry the missing phase moved to Trash is restored,
 * then published when it was published before. Owned while it is in Trash at the revision the
 * phase left (Trash keeps `_rev`, spec F1) and its link carries this job's mark.
 */
async function restoreTrashed(ctx: RowCtx, entry: Found | null): Promise<RowFields> {
	const { deps, job, journal, existing } = ctx;
	const { collection, locale } = journal;
	const before = journal.before;
	ctx.action = "restore";
	if (entry === null) {
		// Emptied from Trash or deleted for good: there is nothing left to restore.
		return rowOf(ctx, "unchanged", { warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)] });
	}
	ctx.entryId = entry.id;
	if (before === undefined) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TRASH_CHANGED_MESSAGE)] });
	}
	const linkId = linkKey(collection, locale, journal.sourceKey);
	const link = await deps.links.get(linkId);
	const marked =
		link !== null &&
		link.entryId === entry.id &&
		link.jobId === job.rollbackOf &&
		link.missing?.jobId === job.rollbackOf;
	const resumed =
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	const pending =
		!resumed &&
		existing?.status === "writing" &&
		existing.pendingStep !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev !== undefined &&
		reachedTrash(existing.pendingStep, entry, existing.writtenRev)
			? existing.pendingStep
			: undefined;
	const ownTrash = entry.trashed && marked && link.writtenRev === entry.rev && entry.rev === before.rev;
	if (!resumed && pending === undefined && !ownTrash) {
		// Plan Ruling 10: an active entry whose link the phase never marked was never trashed.
		if (!entry.trashed && !marked) {
			return rowOf(ctx, "unchanged", { warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)] });
		}
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TRASH_CHANGED_MESSAGE)] });
	}
	if (await deps.content.isLocked(collection, locale, entry.id)) {
		return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	if (job.dryRun) {
		return rowOf(ctx, "planned", {
			changes: [{ field: "status", before: "trashed", after: before.status }],
		});
	}
	let state: EntryState = {
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		hasDraft: entry.hasDraft,
	};
	let done = pending ?? (resumed ? (existing?.step ?? 0) : 0);
	ctx.written = { rev: state.rev, step: done };
	const run = async (step: 8 | 9, revert: "restore" | "publish"): Promise<RowFields | null> => {
		if (done >= step) return null;
		await ctx.save(rowOf(ctx, "writing", { pendingStep: step }));
		ctx.cache.spend(STEP_COST[revert]);
		const result = await deps.content.revertStep({ collection, locale, id: entry.id, rev: state.rev, step: revert });
		if (result.ok) {
			state = result.state;
			done = step;
			ctx.written = { rev: state.rev, step };
			return null;
		}
		switch (result.reason) {
			case "conflict":
				return rowOf(ctx, "conflict", {
					errors: [
						issue(
							"rollback_changed",
							result.message === TRANSLATION_SLOT_TAKEN ? SLOT_TAKEN_MESSAGE : TRASH_CHANGED_MESSAGE,
						),
					],
				});
			case "locked":
				return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
			default:
				return rowOf(ctx, "failed", {
					errors: [issue("rollback_blocked", `Not rolled back: a plugin refused the ${revert}: ${result.message}`)],
				});
		}
	};
	const restored = await run(8, "restore");
	if (restored) return restored;
	if (before.status === "published") {
		const published = await run(9, "publish");
		if (published) return published;
	}
	await ctx.save(rowOf(ctx, "writing"));
	await handBack(ctx, entry.id, before, state, link?.entryId === entry.id);
	return rowOf(ctx, "reverted");
}
````
`restoreTrashed` reaches `link.writtenRev` only behind `marked`, which narrows `link` to non-null; if the compiler does not narrow through the `const`, write `link !== null && marked && …` there.

- [ ] **Step 4: Run them to see them pass**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/rollback-trash.test.ts tests/unit/rollback-*.test.ts`
Expected: PASS. M5a's and M5b's rollback tests pass unchanged: `handBack` is the old hand-back, moved.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/revert.ts packages/flux-import/tests/unit/rollback-trash.test.ts
git commit -m "Roll back a missing-phase trash: restore the entry, publish it again when it was published, and hand the link back with its owner"
```

### Task 7: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/integration/missing.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through the plugin routes; `Client`, `devBypass`, `startServer`, `stopServer`, `productsCsv`, `template`, and the `createTranslationSchema` fixture of M4e.
- Produces: the spec's Node integration list, run against EmDash 1.2.0 on SQLite.

- [ ] **Step 1: Write the tests**

Create `packages/flux-import/tests/integration/missing.test.ts`:
````ts
/**
 * M5c on Node (spec "Testing", integration): the missing phase through the plugin routes, against
 * EmDash's own trash, restore and unpublish, and its rollback. Its own server: the kill-and-resume
 * test stops it.
 */
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
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

// The M5a rollback suite's port: suites run one at a time, and this one kills its own server.
const PORT = 4391;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

const owned = (collection: string, missing?: object, owner = "shop") => ({
	...template(collection),
	rules: { owner, ...(missing ? { missing } : {}) },
});

async function importCsv(
	body: string,
	jobTemplate: object,
	opts: { dryRun?: boolean; missing?: object | false; batchSize?: number; budgetMs?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(body);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: opts.dryRun ?? false,
		batchSize: opts.batchSize ?? 50,
		...(opts.missing === undefined ? {} : { missing: opts.missing }),
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const missingRows = (job: Job, rows: RecordRow[]) =>
	new Map(rows.filter((r) => r.seq >= (job.missing?.fromSeq ?? Infinity)).map((r) => [r.sourceKey, r]));
const codes = (row: RecordRow | undefined) =>
	[...(row?.warnings ?? []), ...(row?.errors ?? [])].map((w) => w.code);

async function byKey(collection: string) {
	return new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));
}

/** The IDs of the entries in Trash, as the admin's Trash view lists them (M5a's route). */
async function trashed(collection: string, locale = "en"): Promise<string[]> {
	const { items } = await client.api<{ items: { id: string }[] }>(
		"GET",
		`/_emdash/api/content/${collection}/trash?locale=${locale}&limit=100`,
	);
	return items.map((i) => i.id).sort();
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
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}, 180_000);

afterAll(async () => {
	await stopServer(server);
});

describe("M5c missing entries on Node", () => {
	it("unpublishes two missing entries, and republishes them when the feed has them again", async () => {
		await client.createProducts("it_m5c_unpub");
		const t = owned("it_m5c_unpub", { action: "unpublish" });
		await importCsv(productsCsv(20), t);
		const { job, rows } = await importCsv(productsCsv(18), t);
		expect(job.missing).toMatchObject({ stage: "done", owned: 20, found: 2, removed: 2, verdict: "act" });
		expect(job.counters).toMatchObject({ unchanged: 18, removed: 2 });
		const entries = await byKey("it_m5c_unpub");
		for (const key of ["SKU-18", "SKU-19"]) {
			expect(missingRows(job, rows).get(key)?.status, key).toBe("removed");
			expect(entries.get(key)?.status, key).toBe("draft");
		}
		const back = await importCsv(productsCsv(20), t);
		expect(back.job.counters).toMatchObject({ failed: 0, conflict: 0 });
		const after = await byKey("it_m5c_unpub");
		expect([...after.values()].every((e) => e.status === "published")).toBe(true);
	});

	it("trashes a missing entry, refuses to recreate it, and a rollback restores and republishes it", async () => {
		await client.createProducts("it_m5c_trash");
		const t = owned("it_m5c_trash", { action: "trash" });
		await importCsv(productsCsv(8), t);
		const before = (await byKey("it_m5c_trash")).get("SKU-7");
		const { job } = await importCsv(productsCsv(7), t);
		expect(job.counters.removed).toBe(1);
		expect(await trashed("it_m5c_trash")).toEqual([before?.id]);
		// The feed has it again: the record is refused with missing_trashed, not a SLUG_CONFLICT.
		const again = await importCsv(productsCsv(8), t, { missing: false });
		const row = again.rows.find((r) => r.sourceKey === "SKU-7");
		expect(row).toMatchObject({ status: "failed" });
		expect(codes(row)).toEqual(["missing_trashed"]);
		const created = await client.plugin("jobs/rollback", { id: job.id, batchSize: 10 });
		const rolled = await client.runToEnd(created.id);
		expect(rolled.counters).toMatchObject({ reverted: 1, conflict: 0, failed: 0 });
		const restored = (await byKey("it_m5c_trash")).get("SKU-7");
		expect(restored).toMatchObject({ status: "published", slug: before?.slug, data: before?.data });
		const rerun = await importCsv(productsCsv(8), t);
		expect(rerun.job.counters).toMatchObject({ unchanged: 8, failed: 0, conflict: 0 });
	});

	it("leaves an edited entry and one with a pending draft alone", async () => {
		await client.createProducts("it_m5c_edit");
		const t = owned("it_m5c_edit", { action: "trash", maxPercent: 50 });
		await importCsv(productsCsv(8), t);
		const entries = await byKey("it_m5c_edit");
		// As record-rules.test.ts edits: a PUT with the current _rev, then a publish of the draft.
		const put = async (key: string, title: string) => {
			const id = entries.get(key)?.id as string;
			const { _rev } = await client.getEntry("it_m5c_edit", id);
			return client.api<{ _rev: string }>("PUT", `/_emdash/api/content/it_m5c_edit/${id}?locale=en`, {
				data: { title },
				_rev,
			});
		};
		const saved = await put("SKU-6", "Edited");
		await client.api("POST", `/_emdash/api/content/it_m5c_edit/${entries.get("SKU-6")?.id}/publish?locale=en`, {
			_rev: saved._rev,
		});
		await put("SKU-7", "Draft only");
		const { job, rows } = await importCsv(productsCsv(6), t);
		const m = missingRows(job, rows);
		expect(codes(m.get("SKU-6"))).toEqual(["missing_edited"]);
		expect(codes(m.get("SKU-7"))).toEqual(["missing_pending"]);
		expect(await trashed("it_m5c_edit")).toEqual([]);
	});

	it("refuses 10 of 20 missing, then applies them with the job option", async () => {
		await client.createProducts("it_m5c_limit");
		const t = owned("it_m5c_limit", { action: "unpublish" });
		await importCsv(productsCsv(20), t);
		const refused = await importCsv(productsCsv(10), t);
		expect(refused.job.missing).toMatchObject({ found: 10, removed: 0, verdict: "refused" });
		expect(refused.job.warnings?.some((w) => w.includes("missing: { maxPercent: 50 }"))).toBe(true);
		expect([...(await byKey("it_m5c_limit")).values()].every((e) => e.status === "published")).toBe(true);
		const dry = await importCsv(productsCsv(10), t, { dryRun: true, missing: { maxPercent: 50 } });
		expect(dry.job.counters.removed).toBe(10);
		expect([...(await byKey("it_m5c_limit")).values()].every((e) => e.status === "published")).toBe(true);
		const applied = await importCsv(productsCsv(10), t, { missing: { maxPercent: 50 } });
		expect(applied.job.missing).toMatchObject({ removed: 10, verdict: "act" });
	});

	it("skips the phase when a record has no key, and a second owner takes the stamp off", async () => {
		await client.createProducts("it_m5c_skip");
		const t = owned("it_m5c_skip", { action: "trash", maxPercent: 50 });
		await importCsv(productsCsv(4), t);
		const noKey = productsCsv(3).concat(`,"No key",1,01/03/2026,no-key\r\n`);
		const skipped = await importCsv(noKey, t);
		expect(skipped.job.missing).toMatchObject({ verdict: "skipped" });
		expect(await trashed("it_m5c_skip")).toEqual([]);
		// Another owner's record reaches SKU-3: neither owner counts it from now on (Ruling 21).
		await importCsv(productsCsv(4), owned("it_m5c_skip", undefined, "other"));
		const after = await importCsv(productsCsv(3), t);
		expect(after.job.missing).toMatchObject({ owned: 3, found: 0 });
		expect(await trashed("it_m5c_skip")).toEqual([]);
	});

	it("trashes a French translation alone, and leaves an English root with an active translation", async () => {
		const n = translationNames("it_m5c_i18n");
		await createTranslationSchema(client, n);
		const english = { ...englishTemplate(n), rules: { owner: "shop-en" } };
		const french = { ...translationTemplate(n, "fr"), rules: { owner: "shop-fr" } };
		const trash = { action: "trash", maxPercent: 50 };
		await importCsv(englishCsv([["E1", "Desk", "D-1", 10], ["E2", "Lamp", "L-1", 5]]), english);
		const frenchRows = [
			{ id: "F1", enId: "E1", name: "Bureau" },
			{ id: "F2", enId: "E2", name: "Lampe" },
		];
		await importCsv(translationCsv(frenchRows), french);
		const lampBefore = (await listLocale(client, n.products, "en")).find((e) => e.data.title === "Lamp");
		// F2 is missing from the French feed: it goes to Trash, and its English source stays (Fact V7).
		const fr = await importCsv(translationCsv(frenchRows.slice(0, 1)), { ...french, rules: { owner: "shop-fr", missing: trash } });
		expect(fr.job.counters.removed).toBe(1);
		expect((await listLocale(client, n.products, "fr")).map((e) => e.data.title)).toEqual(["Bureau"]);
		const lamp = (await listLocale(client, n.products, "en")).find((e) => e.data.title === "Lamp");
		expect(lamp).toMatchObject({ status: "published", data: lampBefore?.data });
		// E1 is missing from the English feed, but F1 still translates it.
		const en = await importCsv(englishCsv([["E2", "Lamp", "L-1", 5]]), { ...english, rules: { owner: "shop-en", missing: trash } });
		expect(codes(missingRows(en.job, en.rows).get("E1"))).toEqual(["missing_has_translations"]);
		expect(await trashed(n.products)).toEqual([]);
	});

	it("survives a kill mid-act: every missing entry is unpublished once", async () => {
		await client.createProducts("it_m5c_crash");
		const t = owned("it_m5c_crash", { action: "unpublish" });
		await importCsv(productsCsv(300), t, { batchSize: 100 });
		const { uploadId } = await client.upload(productsCsv(240));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: t,
			dryRun: false,
			batchSize: 100,
			budgetMs: 2_000,
		});
		let job = await client.plugin("jobs/next", { id: created.id });
		while (job.missing?.stage !== "act") job = await client.plugin("jobs/next", { id: created.id });
		const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
		await sleep(400);
		await stopServer(server, "SIGKILL");
		const interrupted = (await inFlight) === null;
		await restart();
		await waitForLease(created.id);
		if (!interrupted) throw new Error("The kill did not cut off a jobs/next call in flight");
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { unchanged: 240, removed: 60, failed: 0, conflict: 0 },
			missing: { stage: "done", removed: 60 },
		});
		expect(await client.records(created.id, "writing")).toEqual([]);
		const entries = await byKey("it_m5c_crash");
		expect([...entries.values()].filter((e) => e.status === "draft")).toHaveLength(60);
	}, 300_000);
});
````

`client.createProducts` makes a revisioned collection (M2), so the `PUT` of SKU-7 stages a draft, which is what `missing_pending` needs.

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/missing.test.ts`
Expected: PASS, in about 2-3 minutes with the server start and the 300-row job.

- [ ] **Step 3: Commit**

```bash
git add packages/flux-import/tests/integration/missing.test.ts
git commit -m "Prove the missing phase on Node: unpublish, trash and rollback, editor safety, the threshold, a skipped phase, translations and a kill mid-act"
```

### Task 8: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 through the plugin routes on D1; `importRules`, `byKey`, `d1`, `client`.
- Produces: the spec's Cloudflare parity cases, each named with `M5c`, so `-t "M5c"` runs them.

- [ ] **Step 1: Write the tests**

Append inside `describe("workerd parity (D1, R2)", …)` in `packages/flux-import/tests/integration-cf/parity.test.ts`:
````ts
	it("unpublishes M5c missing entries on D1 within the Workers caps, and republishes them", async () => {
		await client.createProducts("cf_m5c_unpub");
		const rules = { rules: { owner: "shop", missing: { action: "unpublish", maxPercent: 50 } } };
		await importRules("cf_m5c_unpub", productsCsv(60), rules);
		const { uploadId } = await client.upload(productsCsv(45));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: { ...template("cf_m5c_unpub"), ...rules },
			dryRun: false,
			budgetMs: 20_000,
		});
		const batches: Job[] = [];
		let job = await client.plugin("jobs/next", { id: created.id });
		while (job.status === "running") {
			batches.push(job);
			job = await client.plugin("jobs/next", { id: created.id });
		}
		expect(job).toMatchObject({ status: "completed", counters: { unchanged: 45, removed: 15 } });
		// The act stage decides at most WORKERS_MISSING_BATCH_CAP (10) entries a batch.
		const acts = batches.map((b) => b.missing?.rows ?? 0);
		for (let i = 1; i < acts.length; i++) expect(acts[i] - acts[i - 1]).toBeLessThanOrEqual(10);
		const entries = await byKey("cf_m5c_unpub");
		expect([...entries.values()].filter((e) => e.status === "draft")).toHaveLength(15);
		const back = await importRules("cf_m5c_unpub", productsCsv(60), rules);
		expect(back.counters).toMatchObject({ failed: 0, conflict: 0 });
		expect([...(await byKey("cf_m5c_unpub")).values()].every((e) => e.status === "published")).toBe(true);
	});

	it("trashes an M5c missing entry on D1 and restores it by rollback", async () => {
		await client.createProducts("cf_m5c_trash");
		const rules = { rules: { owner: "shop", missing: { action: "trash" } } };
		await importRules("cf_m5c_trash", productsCsv(8), rules);
		const before = (await byKey("cf_m5c_trash")).get("SKU-7");
		const job = await importRules("cf_m5c_trash", productsCsv(7), rules);
		expect(job.counters.removed).toBe(1);
		expect((await byKey("cf_m5c_trash")).has("SKU-7")).toBe(false);
		const rollback = await client.plugin("jobs/rollback", { id: job.id, budgetMs: 20_000 });
		const done = await client.runToEnd(rollback.id);
		expect(done.counters).toMatchObject({ reverted: 1, conflict: 0, failed: 0 });
		expect((await byKey("cf_m5c_trash")).get("SKU-7")).toMatchObject({
			status: "published",
			slug: before?.slug,
			data: before?.data,
		});
		const again = await importRules("cf_m5c_trash", productsCsv(8), rules);
		expect(again.counters).toMatchObject({ unchanged: 8, failed: 0, conflict: 0 });
	});

	it("refuses an M5c feed that lost too many entries on D1", async () => {
		await client.createProducts("cf_m5c_limit");
		const rules = { rules: { owner: "shop", missing: { action: "trash" } } };
		await importRules("cf_m5c_limit", productsCsv(8), rules);
		const job = await importRules("cf_m5c_limit", productsCsv(5), rules);
		expect(job.missing).toMatchObject({ found: 3, removed: 0, verdict: "refused" });
		expect((await byKey("cf_m5c_limit")).size).toBe(8);
	});
````
Add `Job` to the file's type imports if the file does not already import it (it does: `import type { Job } from "../../src/engine/types.js"`).

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M5c"`
Expected: PASS, in about 90 s with the server start.

- [ ] **Step 3: Commit**

```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove the missing phase on workerd: unpublish within the caps, trash and rollback, and the threshold on D1"
```

### Task 9: M5c review run

**Files:**
- Create: `docs/superpowers/notes/2026-11-12-m5c-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. If Step 2 lowers a cap, also `packages/flux-import/src/plugin/service.ts` and the tests that name it.
- Temporarily (reverted before the commit): `packages/flux-import/src/plugin/d1-count.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration-cf/d1-count.test.ts`

**Interfaces:**
- Consumes: everything above, and the Task 0 results in "Facts this plan relies on".
- Produces: the filled-in review note, the V8 counts measured (and a lowered cap if one is over the limit), and the roadmap status.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass. `pnpm test:cf` takes about 25 minutes; Facts F1-F3 describe the known flakes. Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Measure D1 queries per batch (V8)**

Create the M5a counter again, `packages/flux-import/src/plugin/d1-count.ts` (Task 9 Step 2 of `docs/superpowers/plans/2026-11-03-flux-import-m5a-journal-rollback.md`, unchanged). Wrap the `jobs/next` handler's `nextBatch(…)` call in `packages/flux-import/src/plugin/routes.ts` as there:
```ts
countD1(() => nextBatch(…)).then(({ value, queries }) => ({ ...withoutPlannedTerms(value), d1Queries: queries }))
```
Then create `packages/flux-import/tests/integration-cf/d1-count.test.ts`, which calls `jobs/next` one batch at a time and records `d1Queries` and `missing.stage` for every batch. It needs these cases, with `budgetMs: 20_000`, on `client.createProducts(…)` collections:
1. **Count stage.** 100 owned entries, then a feed of 50 with `missing: { action: "trash" }` and the job option `missing: { maxPercent: 50 }`: the count batches read 40 entries each (`WORKERS_MISSING_SCAN_CAP`), the last fewer.
2. **Act stage, trash.** The same job's act batches: 10 trashes each (`WORKERS_MISSING_BATCH_CAP`).
3. **Act stage, unpublish.** The same with `action: "unpublish"`: 10 unpublishes each.
4. **Rollback.** The rollback of each of those jobs: 3 restore-and-publish rows a batch, and 3 M5a unpublish reverts a batch (`WORKERS_ROLLBACK_BATCH_CAP`).

Run: `pnpm exec vitest run --config vitest.cf.config.ts tests/integration-cf/d1-count.test.ts`. Record every batch's count in the note; Fact V8 has the drafting projections (count about 260, trash about 350, unpublish about 470, rollback about 260 and 200).

If a batch is over about 900 queries, lower that cap in `src/plugin/service.ts` to the largest count that fits: `WORKERS_MISSING_SCAN_CAP`, `WORKERS_MISSING_BATCH_CAP` or `WORKERS_ROLLBACK_BATCH_CAP`. Then change the tests that name the cap (`tests/unit/service.test.ts`, Task 8's batch check), re-run `pnpm test` and `pnpm exec vitest run --config vitest.cf.config.ts -t "M5a|M5b|M5c"`.

Finally, delete `src/plugin/d1-count.ts` and `tests/integration-cf/d1-count.test.ts` and revert the `routes.ts` wrap (`git checkout packages/flux-import/src/plugin/routes.ts`). `git status` must show only the cap change, if any.

- [ ] **Step 3: Manual checks against `pnpm dev`**

Work on the normal dev database:
- Back up `sites/dev/data.db*` and `sites/dev/uploads` first.
- An agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`.
- Get an Admin PAT from `setup/dev-bypass`.

Record each result:
1. Create a revisioned collection with `client.createProducts("m5c")` and import `productsCsv(8)` with `template("m5c")` and `rules: { owner: "shop", missing: { action: "trash" } }`. Import `productsCsv(6)` with the same rules: two rows `removed`. The admin's Trash shows the two entries, and the collection list shows six.
2. Restore one of the two from Trash in the admin, then run `jobs/rollback` of the last job: one row `reverted` (`restore`) and one `conflict` with "Not rolled back: the entry was restored or changed after the import moved it to Trash". The admin shows both entries active; the rolled-back one is published.
3. Import `productsCsv(4)` with the same rules: the job completes with the refusal warning naming 50%, and nothing goes to Trash.
4. Restore `sites/dev/data.db*` and `sites/dev/uploads`, and revert `sites/dev/emdash-env.d.ts`. `git status` must be clean apart from the note and any cap change.

- [ ] **Step 4: Write the review note**

Create `docs/superpowers/notes/2026-11-12-m5c-review.md` from this template and fill in every `…`:
```markdown
# Milestone 5c review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0) and query counts (Step 2)

| Fact | Check | Result |
| --- | --- | --- |
| V1: trash keeps `_rev`, slug, status and schedule; restore is fenced, gives a draft one version on, and a publish brings the entry back exactly; a taken slot is `CONFLICT` | drafting probe (plan Facts); Tasks 3, 6, 7, 8 | … |
| V2: unpublish leaves a draft pointer one version on; the M5a sequence restores the entry at step 2 | drafting probe; Tasks 5, 7, 8 | … |
| V3: a template with `owner` and `missing` only keeps the M5b record order | drafting probe; Task 1 | … |
| V4: the owner index is required, validates after a restart and appears at a scheduler tick; paging is stable under rewrites | drafting probe; Tasks 4, 7 | … |
| V5: the 50-key `in` query, `seq` desc with limit 1, `seq` ranges with `status in` | drafting probe; Tasks 4, 5 | … |
| V6: job IDs of one millisecond are not ordered (plan Ruling 1) | drafting probe; Task 4 (`laterJob`) | … |
| V7: trashing a translation leaves its source; the group lists the rest | drafting probe; Task 7 | … |
| V8: D1 queries per batch at `WORKERS_MISSING_SCAN_CAP`, `WORKERS_MISSING_BATCH_CAP` and `WORKERS_ROLLBACK_BATCH_CAP` (limit 1,000) | Step 2 | … per batch; caps … |

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
| Unit, template and job: `rules.owner`, `rules.missing`, the job option, refusals, the index and capability | `missing-template.test.ts`, `definition.test.ts`, `xlsx-import.test.ts` | … |
| Unit, stamps and keys: stamping, keeping, dropping, `foreignStamp`, the key on failed rows, `unkeyed`, `missing_trashed` | `owner.test.ts`, `missing-keys.test.ts` | … |
| Unit, the phase: entry and skips, candidates, the seen query, the threshold, every verdict, call outcomes, the over-count, dry runs, caps | `missing.test.ts`, `service.test.ts` | … |
| Unit, crash repair: each stop point, lost batches, cancel, pause, retry, end-to-end rollback | `missing-repair.test.ts` | … |
| Unit, rollback steps 8 and 9 | `rollback-trash.test.ts`, `fakes.test.ts`, `content.test.ts` | … |
| Integration on `sites/dev` | `missing.test.ts` (integration) | … |
| Cloudflare parity on `sites/dev-cf` | `parity.test.ts` (`-t "M5c"`) | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Two missing entries go to Trash | … | … |
| 2 | The rollback restores one; the hand-restored one is a conflict | … | … |
| 3 | A feed that lost half its entries is refused | … | … |

## Deviations from the plan

…

## Open issues for the next part

- Template documentation for M6 (plan Ruling 7): …the text of the `rules.owner` doc comment…
- Clock skew across processes can order job IDs wrongly (plan Ruling 1).
- A rolled-back swept entry reads as edited to the next phase (plan Ruling 13).
…
```

- [ ] **Step 5: Mark M5c done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| **M5c** | Missing entries: trash or unpublish entries this import created that a completed run did not see, behind a safety threshold; journalled, and rolled back by restoring from Trash or republishing | Planned |
```
with:
```markdown
| **M5c** ([spec](./2026-11-12-flux-import-m5c-missing-entries-design.md)) | Missing entries: trash or unpublish entries this import created that a completed run did not see, behind a safety threshold; journalled, and rolled back by restoring from Trash or republishing | Done ([review](../notes/2026-11-12-m5c-review.md)) |
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-11-12-m5c-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 5c review results and mark M5c done in the roadmap"
```
If Step 2 lowered a cap, add `packages/flux-import/src/plugin/service.ts` and the changed tests to the same commit, and say so in the message body.

---

## After this plan

M5c completes Milestone 5: an import can now stamp an owner on the entries it creates and, after a completed run, move the owner's entries the feed no longer has to Trash or unpublish them, behind a threshold, journalled and reversible by rollback.

Known gaps carried forward, all documented in the spec or in the rulings above:
- no permanent delete of missing entries (spec "Decisions");
- an unpublish does not touch a draft or a schedule someone else set; such entries are left alone;
- job IDs from processes with skewed clocks can order wrongly (Ruling 1);
- a rolled-back swept entry reads as edited to the next phase (Ruling 13);
- the template reference documentation waits for M6 (Ruling 7).

M6 (saved templates and automation) reads `Job.missing.verdict` to report or stop a scheduled feed. The M2-M5b open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-11-04-m5b-review.md`) are unchanged by this plan. The production Cloudflare build blocker from M2 still stands.
