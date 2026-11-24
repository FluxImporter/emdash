# Flux Import M7b: the Imports home in the EmDash admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 runs first and alone: it proves Facts V1-V5 with live probes and changes no tracked file; a failed fact gates the tasks it names. Then Tasks 1-4 in parallel; then 5, 6 and 7; then 8-12 and 14; then 13; then 15; then 16 (see "Parallel execution"). Each task stands alone: its Interfaces block names everything it uses from other tasks.

**Goal:** One page, "Imports", at `/_emdash/admin/plugins/flux-import/imports`, with Jobs, Templates, Sources and Schedules tabs and a "New import" button, so an Administrator can see what was imported, roll it back after a dry-run summary, reuse and move templates, keep a feed's address and credential, and schedule imports, without the API.

**Architecture:** A second native React page in M7a's admin module (`src/admin/home/`), sharing its peers, `api`, `queries`, `errors`, `run-driver`, `i18n`, `limits` and test harness. Each tab is its own folder; the home takes the tabs as props, as the wizard takes its steps. Four server additions, and only these: a `jobs/summaries` route over a new `["dryRun", "createdAt"]` jobs index, a bounded `jobs/clear-dry-runs` route that reuses retention's per-job purge, a read-only `schedules/fence` route, and split counts on rollback jobs (`job.undo`). Everything else calls routes that exist.

**Tech Stack:** As M7a, unchanged: React 19.2.4, `@cloudflare/kumo` 2.6.0, `@lingui/core` and `@lingui/react` 5.9.5, `@tanstack/react-query` 5.90.21, `@dnd-kit/core` 6.3.1 (not used by M7b), EmDash 1.2.0 (`emdash/plugin-utils`), TypeScript 5.9 strict ESM (two passes: NodeNext and `tsconfig.admin.json`), Vitest 4.1 (`unit` node project, `admin` happy-dom 21.0.4 project), Testing Library, Biome 2. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-24-flux-import-m7b-imports-home-design.md`, all sections; "Decided by the user", "Where it lives" and "Coordinator's calls" 1-10 are binding. Mockup (local): the "Imports home" box in `.superpowers/brainstorm/54303-1795444286/content/flow-and-home.html`. Previous plan and review: `docs/superpowers/plans/2026-11-23-flux-import-m7a-admin-wizard.md`, `docs/superpowers/notes/2026-11-23-m7a-review.md`; the M7a spec's "Amendments" and "Open issues" bind this plan where it touches the wizard. Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (row 7, "Milestone 7 split").

Citation conventions: EmDash paths are under `node_modules/emdash/src/` (1.2.0); admin paths under `@emdash-cms/admin@1.2.0/dist/`; package paths under `packages/flux-import/`. This plan's facts are "Fact V<n>" (unverified, Task 0) and "Fact D<n>" (read from source while drafting); its rulings "plan Ruling <n>"; the spec's calls "Coordinator's call <n>"; M7a's "M7a Ruling <n>" and "M7a amendment <n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID stays `flux-import`. `FLUX_IMPORT_VERSION` becomes `0.7.0` (Task 15). No capability change, no new dependency or peer, no change to `adminEntry` or `admin.entry`.
- `admin.pages` becomes, in this order (Task 15, Fact V1, plan Ruling 9):
  `[{ path: "/imports", label: "Imports", icon: "clock-counter-clockwise", group: "Imports" }, { path: "/import", label: "New import", icon: "upload-simple", group: "Imports" }]`. The module's `pages` export keys the same paths, `/imports` first.
- **The only server changes** are the four additions (spec "Server additions"): `jobs/summaries` and `schedules/fence` (Task 1), the `["dryRun", "createdAt"]` jobs index (Task 1), `jobs/clear-dry-runs` (Task 5), `job.undo` and `job.missingFrom` on rollback jobs (Task 2). `jobs/list`, `schedules/list`, `summarize` and every MCP tool answer exactly as before. No storage migration: EmDash creates the declared index itself (Fact D5).
- The admin module's runtime imports stay M7a's set (`react`, `@cloudflare/kumo`, `@lingui/core`, `@lingui/react`, `@tanstack/react-query`, `@dnd-kit/core`, `emdash/plugin-utils`, its own files); server code and `emdash` by whole-clause `import type` only. `tests/unit/admin-boundary.test.ts` enforces it over every new file unchanged.
- Plugin route URLs are `/_emdash/api/plugins/flux-import/<route>`, every request through `apiFetch` with `X-EmDash-Request: 1`, GETs included (M7a Fact D2). Admin links: the home `/_emdash/admin/plugins/flux-import/imports`, the wizard `…/import`, a job's Run screen `…/import?step=run&job=<id>`, a template in the wizard `…/import?template=<id>` (plan Ruling 12).

**Text and accessibility**
- Every visible string is a `Msg` in its folder's `messages.ts`, rendered through `useT()` (M7a Ruling 2): IDs `^flux-import\.[a-z0-9-]+(\.[a-z0-9-]+)+$`, placeholders `{name}` only, no plural or select syntax (so counts read "Entries to delete: 2", never "2 entries"). English only.
- Copy the spec fixes: "Imports", "New import", "Jobs", "Templates", "Sources", "Schedules", "No imports yet.", "{count} dry runs", "Clear dry runs", "Rollback of {name}", "One-off import", "Keep the import", "Roll back", "Continue the rollback", "Also update these schedules", "No credential", "Only administrators can import." (once for the page). The copy each task's tests pin is binding; the rest is the builder's (spec "Left to the builder").
- Tabs are Kumo `Tabs` with the home's own `<div role="tabpanel">` (as M7a's Source step), each with an `<h2>`. Tables have header cells. Every row action is a button or menu item whose accessible name names the row: `{action} {name}, {when}` ("Roll back Products feed, today 10:14"). Status badges carry text. One polite live region per page announces action results. Every dialog is labelled, traps and returns focus, and closes with Escape unless work is in flight.
- Loading and work in flight (spec "Errors, loading and empty states"): a Kumo `Loader` with an accessible name while a tab's list loads; a button whose call is in flight is disabled with `aria-busy`; every failure is `describeError`'s sentence (with "Try again" where a retry can help, never after a 403).
- Styling: Kumo components and the admin's prebuilt utility classes only (M7a Ruling 9; the boundary test checks every `className` literal). Kumo's own classes that the admin's CSS lacks have no effect (M7a open issue): Fact V5 names the components safe to use.

**Never on screen** (spec Anti-goals): a credential value (after it is typed), an upload ID, a source URL's userinfo or query string, `lastError.message`, `lastFetch.uploadId`, a job's error message in the list, raw server text beyond M7a's allow-listed details. Job IDs only in URLs and log file names.

**Environment, code rules, tests, hygiene:** exactly M7a's Global Constraints ("Environment", "Code rules", "Running tests", "Repository hygiene"): Node ≥ 22.16 via `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`; `cat` is `cat -n` (write files with the editor tools); scratch in `.superpowers/wt/`, never `/tmp`; never ports 4392, 4396 or 4397, and check a port with `curl` first; `pnpm exec astro dev stop` stops a detached dev server; `exactOptionalPropertyTypes` (optional Kumo props passed conditionally), hand-typed Kumo callback parameters, `.js` import extensions, Kysely `sql`/`sql.ref()` only, every content query filters by locale, `import.meta.env.DEV`; no `console.*` in `src/admin/`; component tests mock the global `fetch` under the real `apiFetch` with `mockRoutes` (the harness file is not modified); signed commits through 1Password (retry once on "failed to fill whole buffer", never `--no-gpg-sign`); commit messages end at the body, with no `Co-Authored-By`, no "Generated with", no AI attribution. Never call a real AI provider.

**Definition of done**
- `pnpm format && pnpm typecheck && pnpm lint && pnpm test` pass from the repo root after every task. Baseline at `efc2d34`: 127 files (114 node, 13 happy-dom). This plan adds 7 node files (`job-summaries`, `rollback-undo`, `clear-dry-runs`, `admin-pinned`, `admin-rollback`, `admin-cron`, `admin-jobs`) and 8 happy-dom files (`home`, `rollback`, `dry-runs`, `templates`, `sources`, `schedules`, `jobs`, `home-flow`): 142 files.
- `pnpm test:integration` (22 files with `home.test.ts`) and `pnpm test:cf` (29 tests) pass (Tasks 14, 16).

## Review Focus

1. **Clearing dry runs next to work that still needs them.** A real job (including one `jobs/start` or the wizard started from the dry run, which reads the dry run's own upload, M7a amendment 7), a dry run whose batch holds a live lease, a wizard dry run unfinished and touched within `DRY_RUN_IDLE_MS`, an agent dry run that was started (`startedAs`) or idle under 24 hours, a `jobs/start` claim landing during the clear, a staged file another job or a URL source's latest fetch still holds. Expected: none of these is touched; the rest go with their records, journal rows and files; a page that clears nothing says why. Tests: Task 5 ("never touches a real job…", "keeps a dry run whose batch holds a live lease", "keeps an agent dry run…", "keeps the staged file…", "loses to a concurrent jobs/start claim"), Task 9 ("says why nothing was cleared").
2. **A rollback raced, resumed, or made before 0.7.0.** A second tab presses Roll back after the first started; a rollback is closed mid-run and continued from its row; a crash re-runs a row; a retry turns a conflict into a revert; a rollback job made by 0.6.0 has no `undo`. Expected: the race reads "This import is already being rolled back." with "Continue the rollback" on the existing job; each row counts once under exactly one kind, also across retry and crash repair; an old job shows the total only. Tests: Task 2 ("counts a row once when a crash re-runs it", "moves a row's kind on retry", "leaves a rollback job made before 0.7.0 without undo"), Task 8 ("offers Continue the rollback when another tab started it first", "falls back to the total"), Task 13 ("continues an unfinished rollback from its row").
3. **A secret or internal value reaching the screen.** A source URL `https://u:p@feed.example.com/a/b.json?token=s3cret`, a `lastError.message` that quotes it, a `lastFetch.uploadId`, a credential value just typed, a failed job's `error.message` holding an upload ID. Expected: the list shows `feed.example.com/a/b.json`, the error's code as a sentence, the credential's name and header only; none of the other strings occur in the document. Tests: Task 11 ("lists name, host and path only…", "adds a credential through a password input and never shows the value again"), Task 13 ("never shows a job's error message or an upload ID").
4. **Schedules pinned to an edited template or source.** A template renamed with three schedules on it (one disabled, one busy, one fine); a source whose name only changes; a source whose URL changes with one enabled and one disabled schedule. Expected: the dialog names the schedules before saving; checked, each is updated after the save and a failure (`SCHEDULE_BUSY`) is named with "It will pause at its next run"; unchecked, the dialog says they will pause; a name-only source edit offers nothing; a URL edit updates the enabled schedule only. Tests: Task 7 (`pinnedSchedules`, `pinUpdate`, `updatePinned`), Task 10 ("renames … then updates the pinned schedules", "names a pinned schedule whose update failed"), Task 11 ("offers Also update … only when the URL or credential changes").
5. **Hundreds of jobs, most of them dry runs.** Expected: the Jobs tab reads `jobs/summaries` pages of `JOB_PAGE` (never `jobs/list`), served by the `["dryRun", "createdAt"]` index, "Load more" by cursor; dry runs are one line under the list; a row's name falls back to "One-off import" (inline template) or "Deleted template". Tests: Task 1 ("queries only indexed fields", "lists real imports newest first, a page at a time"), Task 13 ("reads jobs/summaries … never jobs/list", "loads the next page with the cursor", "names rows …").

---

## Facts this plan relies on

Read while drafting, at commit `efc2d34`, from the package source, EmDash 1.2.0, `@emdash-cms/admin` 1.2.0 and Kumo 2.6.0 in `node_modules`. V1-V5 answer the spec's open questions that need a running site; Task 0 proves them. D1-D20 answer the rest from source.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **The home mounts at `/imports`, and `group` makes one sidebar folder.** Expected: with the `admin.pages` of Global Constraints and `pages: { "/imports": …, "/import": … }`, the manifest's `plugins["flux-import"].adminPages` carries both entries with `group: "Imports"`; the sidebar's Plugins section shows a folder "Imports" holding "Imports" and "New import"; `/_emdash/admin/plugins/flux-import` opens the home (the root falls back to the first registered page); `clock-counter-clockwise` renders as an icon; a Kumo `Link` from the home to `…/import?step=run&job=<id>` opens the wizard's Run screen on that job. **Unverified → Task 0; gates Task 15** | admin `index.js:221-229` (root fallback), `:3895-3907` (any Phosphor name), `:43724-43745` (group → folder), `:43538-43542` (active by prefix, Fact D16); `emdash-runtime.ts:3074`, `:3122` (pages passed whole); `types-C4P7F1Vq.d.mts:1476-1486` |
| V2 | **The dry-run filter is served by storage on both hosts.** Expected: `jobs.query({ where: { dryRun: false }, orderBy: { createdAt: "desc" }, limit: 8 })` returns only real jobs on SQLite (`sites/dev`) and D1 (`sites/dev-cf`), and `EXPLAIN QUERY PLAN` on SQLite uses `idx_plugin_flux-import_jobs_dryRun_createdAt`. **Unverified → Task 0; gates Task 1** (fallback: query `dryRun: 0` and `1`, Fact D5) | `storage-query.ts:113-127` (where fields must be declared), `:209-212` (a boolean binds as itself); `db/node-sqlite-compat.ts:100` (Node SQLite binds `true`/`false` as 1/0); D1's binding unread |
| V3 | **The new index builds on an existing site.** Expected: EmDash creates it at the first scheduler tick after the deploy (`CREATE INDEX IF NOT EXISTS`, once per process) on both hosts; on a scratch copy of `sites/dev`'s database with 5,000 job rows it takes under 1 s; before it exists, the query still answers (only slower). **Unverified → Task 0; gates Task 1's Step 3 note and Task 14's index test** | `emdash-runtime.ts:994-1000`, `:1025-1040`; `storage-indexes.ts:45-80`, `:236`, `:265-290` (a failure is logged, never fatal) |
| V4 | **EmDash runs plugin cron in UTC on both hosts.** Expected: a schedule `0 6 * * *` answers `nextRunAt` ending `T06:00:00.000Z` on `sites/dev` and `sites/dev-cf`, whatever the machine's zone. **Unverified on a live site → Task 0; gates Task 12's wording** | `plugins/cron.ts:18-19` (`CRON_TIMEZONE = "UTC"`), `:346-351`; `plugin/cron-syntax.ts` `CRON_RULE` ("times are UTC"); `retention.ts:9-11` |
| V5 | **Kumo `Tabs`, `Table`, `DropdownMenu` and `Collapsible` look right under the admin's prebuilt CSS** (open, closed, focused, disabled; light and dark). **Unverified → Task 0; gates Tasks 9 and 13** (fallbacks: a plain disclosure button for `Collapsible`, row buttons for `DropdownMenu`) | Kumo `dist/src/index.d.ts:61-62` and its exports; M7a amendment 9 and open issues |
| D1 | **`jobs/list` keeps its whole rows; summaries need a new route.** Its callers read whole `Job`s: `tests/integration/behaviours.test.ts:115,304`, `templates.test.ts:269`, `tests/integration-cf/parity.test.ts:1061`, `tests/unit/template-routes.test.ts:209-248`, `template-jobs.test.ts:217-263`, `service.test.ts:449`, `selection.test.ts:328`. No MCP tool and no admin code calls it | `grep` of `jobs/list` and `listJobs`; `src/plugin/mcp.ts` |
| D2 | **A job records its origin only as `"agent"` or `"schedule"`.** Wizard and API jobs have none, and no template name: only `templateId`/`templateRevision`, which a rollback copies; `scheduleId` is not copied | `src/engine/types.ts:94-120`; `src/engine/rollback.ts:123-129` |
| D3 | `summarize` (M6c's `JobSummary`) is the agents' shape, with `next`, `busyUntil` and warnings; M7b leaves it untouched | `src/plugin/summaries.ts:39-74`, `:186-231` |
| D4 | `JOB_PAGE = 8`: a storage query reads whole rows, and a job holds its template (up to 256 KiB) | `src/plugin/service.ts:28-35` |
| D5 | Plugin storage refuses a `where` or `orderBy` field no index declares (`MemoryKv` with `STORAGE` indexes does too); `StorageCollection` has `count` and `getMany`, flux-import's `KvCollection` port neither | `storage-query.ts:113-146`; `plugins/types.ts:288-294`; `src/engine/ports.ts:5-26`; `tests/unit/fakes.ts:76-140` |
| D6 | **Retention's per-job purge is two closures inside `purgeExpired`**: `markPurging` (re-check under compare-and-set, never an original whose rollback job exists) and `prune` (records, journal, journalMedia, then the job, bounded by `left()`). Staged files go only through `purgeBefore(cutoff, keep)` | `src/plugin/retention.ts:104-142`, `:229-258`, `:303-314` |
| D7 | `releaseUploadIfUnused` refuses while `uploadNeeded(job)`, which is true for every dry run that still exists; `uploadInUse` and the `keep` hook (a source's latest fetch) are the other two checks | `src/plugin/service.ts:420-493`; `src/plugin/services.ts:86-87` |
| D8 | **Rollback counters cannot hold the split.** `counterOf` maps every reverted or planned rollback row to `reverted`; the actions are `delete`, `trash` (a created entry), `revert` (an update, or the missing phase's unpublish, journalled as `update`), `restore` (the missing phase's `trash`). The agents' `processed` and the admin driver's rate sum every counter, so new counters would double them | `src/engine/revert.ts:104-120`, `:210-281`, `:343-371`, `:1014-1018`; `src/engine/missing.ts:733-748`; `src/plugin/summaries.ts:155-158`; `src/admin/run-driver.ts:116-117`; `src/engine/types.ts:226` |
| D9 | A real `jobs/rollback` marks the original `rolledBackBy` when it creates the rollback job; a dry one marks nothing. `rollbackRefusal` decides what can be rolled back. A second real rollback answers 409 `INVALID_TRANSITION` "The job was already rolled back (rollback job …)" | `src/engine/rollback.ts:36-53`, `:103-168`; `src/plugin/routes.ts:265-277` |
| D10 | **Schedules.** `MAX_SCHEDULES = 20`, one page holds them all; `ScheduleView` = row + `nextRunAt`; 15 `PauseReason`s; codes `TEMPLATE_IN_USE`/`SOURCE_IN_USE` (`details.scheduleIds`), `SCHEDULE_CHANGED`, `SCHEDULE_BUSY`, `SCHEDULE_DISABLED`, `SCHEDULE_LIMIT`, `TEMPLATE_PROBLEMS` (`details.problems`), `INVALID_CRON`, `MISSING_REQUIRED`, `NAME_TAKEN`. `updateSchedule` re-pins the source only on a new `sourceId` or `enabled: true` (which also clears failures and re-arms with the caller); a new `templateId` needs `templateRevision`; `missing` is required with `rules.missing` and refused without | `src/plugin/schedules.ts:22-110`, `:193-230`, `:452-491`, `:615-696`, `:754-763`, `:835-871`; `src/plugin/routes.ts:550-601`; `src/plugin/template-errors.ts:22-39` |
| D11 | Cron is UTC on every host (`CRON_RULE`, retention's comment) — the source side of V4 | `plugins/cron.ts:18-19`; `src/plugin/cron-syntax.ts` |
| D12 | `readFence(db)` is one static query: `"clear" \| "import" \| "export" \| "media" \| "error"` (a failed read is `"error"`, fenced); the pump stands down on anything but `clear` | `src/emdash/fence.ts:8`, `:71-82`; `src/plugin/pump.ts:223-226` |
| D13 | `templates/export` answers `{ filename, file }` (JSON, `format: "flux-import.template"`); `templates/import` takes `{ file: unknown, name?, owner? }` under a 2 MiB body cap and answers `SavedResult`; refusals `INVALID_FILE`, `UNSUPPORTED_FILE_VERSION`, `OWNER_IN_USE`, `NAME_TAKEN`, `INVALID_TEMPLATE`, `TEMPLATE_TOO_LARGE`, `UNSUPPORTED_TEMPLATE_VERSION` | `src/plugin/template-files.ts:20-167`; `src/plugin/routes.ts:309`, `:1048-1071` |
| D14 | `templates/update { id, revision, name?, description?: string \| null, template? }`; every change raises the revision by one, so a rename alone pauses every schedule on the template at its next launch (`template_changed`) | `src/plugin/templates.ts:407-445`; `src/plugin/routes.ts:535-548`; `src/plugin/launch.ts:203-224` |
| D15 | `sources/update { id, name?, url?, credential?: string \| null }`; a URL or credential change clears `lastFetch`, `lastError`, `lastImport`. `SourceRow.lastFetch` holds `uploadId`; `lastError` holds `code` and `message`. `credentials/delete` does not check sources | `src/plugin/sources.ts:22-36`, `:192-252`; `src/sources/fetcher.ts:30-39`; `src/plugin/credentials.ts:143-153` |
| D16 | A sidebar item is active when the path starts with its own, so a home at the plugin root (`/`) would light up beside "New import" on every wizard URL | admin `index.js:43538-43542` |
| D17 | The wizard loads a saved template only after a file is sampled (`TemplatePicker`), and reads the URL once at mount (M7a Ruling 12) | `src/admin/wizard/source/TemplatePicker.tsx:21-75`; `src/admin/wizard/Wizard.tsx:26-35` |
| D18 | Kumo 2.6.0 exports `Tabs`, `Table`, `DropdownMenu`, `Collapsible`, `Dialog`, `Tooltip`, `Badge`, `Banner`, `Empty`, `Checkbox`, `RadioGroup`, `Select`, `Input`, `Link`, `Loader`, `Meter` | Kumo `dist/src/index.d.ts` |
| D19 | `jobs/start` claims a dry run with a compare-and-set of `startedAs`; a real job from it has `dryRunOf` | `src/plugin/agent.ts:174-234` |
| D20 | The M6b busy check reads unfinished dry runs on a source and fails closed past `BUSY_SCAN_PAGES` pages | `src/plugin/schedules.ts:224-247` |

## Rulings this plan makes

1. **A new read-only route, `jobs/summaries`; `jobs/list` is unchanged** (Fact D1, spec addition 1). Input `{ dryRun?: boolean (default false), cursor? }`, strict. Answer `Page<JobListItem>`, `JOB_PAGE` (8) a page (Fact D4), newest first.
2. **The filter is the index `["dryRun", "createdAt"]`** on `jobs`, queried with `where: { dryRun }` and `orderBy: { createdAt }`. If V2 fails for booleans on a host, the query binds `0`/`1` (JSON booleans read as integers on SQLite and D1) and Task 1 says so in a comment.
3. **`JobListItem`** (Task 1 Interfaces) holds what the Jobs table and its actions need and nothing else: no template, cursor, lease holder, planned terms or error message (`errorCode` only). `rollbackable` is `rollbackRefusal(job, now) === null`, so the admin never re-derives it. `rollbackStatus` is read with one `jobs.get` per rolled-back import on the page (at most 8).
4. **Names and origins are composed in the admin** (Fact D2): a row's name is its template's from `useAllTemplates()`, "One-off import" without `templateId`, "Deleted template" when the ID is not listed; a rollback row reads "Rollback of {name}". Origin: "Agent", "Schedule", else "Admin or API" (wizard and API jobs cannot be told apart).
5. **The original reads "Rolling back", "Rolled back" or "Rollback cancelled"** from `rollbackStatus` (`completed` → rolled back; `cancelled` → rollback cancelled; any other, or the rollback job gone, → rolling back) (Coordinator's call 8, Fact D9).
6. **`jobs/clear-dry-runs { cursor? }` → `{ cleared, more, cursor? }`** (spec addition 2, Coordinator's call 10). Per call it scans `CLEAR_PAGE` (20) dry runs oldest first by the same index, within `CLEAR_QUERY_TARGET` (150) metered storage calls. A dry run is clearable when it has no live lease and either (agent) `startedAs` is absent and it has been idle `AGENT_DRY_RUN_IDLE_MS` (24 h), or (any other, dry rollbacks included) it is `completed`, `cancelled` or `failed`, or idle `DRY_RUN_IDLE_MS` (1 h). It is removed with `purgeJob` (retention's per-job purge, extracted, Fact D6), then its files with `releaseFiles` (Fact D7), best effort (retention finishes a left file). **A dry run's staged file is released only once the dry run has been idle `DRY_RUN_IDLE_MS`** (coordinator's ruling on the drafter's question 1): the wizard's Run imports the dry run's own upload (`state.dryRun.uploadId`, M7a amendment 7), so a Preview still open in another tab keeps a working Run; the row, records and journal go at once, and retention removes the left file later. A purge cut short leaves the job marked `purging`; the reply is `more: true` without a cursor, so the next call starts over and finishes it. The admin repeats the call while `more`, at most 50 calls per click.
7. **The split counts live in `job.undo`, beside `counters`, not in them** (Fact D8; amends the spec's "kept in the job's counters", same intent: kept on the job as it runs, never by reading every record). `undo: { deleted, restored, recovered }` is set to zeros when a rollback job is created; `job.missingFrom` copies the original's `missing.fromSeq`. A row counts toward `undo` exactly when it counts toward `reverted`: `delete`/`trash` → `deleted`; `restore` → `recovered`; `revert` → `recovered` at or past `missingFrom`, else `restored`. A job without `undo` (made before 0.7.0) is "unknown" and the dialog shows the total.
8. **The fence is its own route, `schedules/fence {}` → `{ fence: Fence }`** (spec addition 3), read-only and without the reconciliation of `schedules/*`, so `schedules/list` keeps its shape. The Schedules tab shows a banner for every kind but `clear`.
9. **Pages** (spec "Where it lives", Facts V1, D16): the home at `/imports`, labelled "Imports", icon `clock-counter-clockwise`; the wizard keeps `/import`, labelled "New import"; both `group: "Imports"`; the home is first in `pages`, so the plugin root opens it. The wizard's `<h1>` becomes "New import" too.
10. **The tab is in the URL** (`?tab=jobs|templates|sources|schedules`, default Jobs), read once at mount and written with `history.replaceState(history.state, "", url)` (M7a Ruling 12). Only the selected tab is mounted; React Query keeps each list.
11. **Leaving for the wizard is a full-page navigation** (Kumo `Link href`, or `window.location.assign`), so the wizard always mounts fresh and reads its URL (M7a open issue on remounting). Resume and Retry make their call, then open the job's Run screen, except a scheduled job's, which only refreshes and says "The schedule runs this job; its status updates here." (Coordinator's call 7).
12. **"Use" a template opens `/import?template=<id>`**: the wizard's Source step preselects that template in its picker and says "Choose the data, then use the template."; the template loads once a file is sampled, as today (Fact D17).
13. **Timing is built in UTC and says so** (Coordinator's call 4, Facts V4, D11): Hourly `m * * * *`, Daily `m h * * *`, Weekly `m h * * d` (0 = Sunday), Custom (any expression, checked by the server). An expression is read back into the builder only when it matches one of those three patterns exactly (no leading zeros); anything else is Custom. Times are never converted; every time shown in the tab carries "UTC".
14. **Pinned schedules** (Coordinator's call 9, Facts D10, D14, D15). A template's save pins every schedule with its `templateId`; each is updated with `{ id, revision, templateId, templateRevision: <new> }`. A source's save changes a pin only when its URL or credential changes; then every *enabled* schedule on it is updated with `{ id, revision, enabled: true }`, the only update that re-pins a source (it also resets the launch-failure count and re-arms the schedule as the editor; the dialog says so). Disabled schedules re-pin when resumed, so none is listed. Updates run one at a time after the save; failures are named.
15. **Polling.** The Jobs tab refetches its loaded pages every 5 s while any loaded row is `created` or `running`; the Schedules tab refetches the list and the fence every 5 s while any schedule has `due` or `current`, else every 60 s. Nothing polls in a hidden tab.
16. **M7b's error codes join `ERROR_MESSAGES`** (Task 6): `TEMPLATE_IN_USE`, `SOURCE_IN_USE`, `SCHEDULE_CHANGED`, `SCHEDULE_BUSY`, `SCHEDULE_DISABLED`, `SCHEDULE_LIMIT`, `TEMPLATE_PROBLEMS`, `INVALID_CRON`, `MISSING_REQUIRED`, `INVALID_FILE`, `UNSUPPORTED_FILE_VERSION`, `OWNER_IN_USE`. An in-use refusal names the schedules from `details.scheduleIds` through the schedule list; `TEMPLATE_CHANGED` and `SCHEDULE_CHANGED` read "This … changed elsewhere." with "Reload". `INVALID_FILE` and `INVALID_CRON` are added to `DETAIL_CODES` (their messages are the specifics, with no host or secret).
17. **Template files.** Export saves `JSON.stringify(file, null, 2)` as a `Blob` named `filename` (as `downloadLog`). Import reads the chosen file with `File.text()`; a file over `TEMPLATE_BODY_MAX_BYTES` (2 MiB, mirrored in `limits.ts` and pinned) or not JSON is refused in the browser with a sentence, before any request.
18. **A credential's deletion names the sources that use it**, read from the source list (Fact D15), and says they will fail to fetch until it is set again.
19. **A source shows `host + pathname`** of `new URL(url)` (never userinfo, query or fragment) and its last fetch as "Fetched {when}" (`lastFetch`), or "Failed {when}: {sentence}" (`lastError`, when newer), or "Never fetched"; the sentence comes from `lastError.code` through `describeError`, never its message.
20. **Times read "today 10:14", "yesterday 10:14", or a medium date and short time** in the browser's zone, via `Intl.DateTimeFormat` with the Lingui locale, inside `<time dateTime={iso}>` with the exact time as `title` and as screen-reader text. Schedule times are the exception (Ruling 13).

## Verification while drafting

| Check | Result |
| --- | --- |
| D1-D20 | Read from source at `efc2d34`, with the file and line cited in each row |
| V1-V5 | Not probed while drafting: Task 0 proves them before any other task starts |
| Tasks 1-16 | Written against `efc2d34`; nothing was built or run while drafting. Test names, inputs and copy in the steps are binding |

## File map

All paths under `packages/flux-import/` unless they start at the repo root.

| File | Responsibility |
| --- | --- |
| `src/plugin/summaries.ts`, `src/plugin/service.ts`, `src/plugin/routes.ts`, `src/plugin/definition.ts` | `JobListItem`, `listItem`, `listJobSummaries`, `jobs/summaries`, `schedules/fence`, the index (Task 1); `releaseFiles`, `jobs/clear-dry-runs` (Task 5); `admin.pages` (Task 15) |
| `src/engine/types.ts`, `src/engine/rollback.ts`, `src/engine/revert.ts` | `RollbackUndo`, `job.undo`, `job.missingFrom`, `undoKind` (Task 2) |
| `src/plugin/retention.ts`, `src/plugin/dry-runs.ts` | `purgeJob`, `metered`; `clearable`, `clearDryRuns` (Task 5) |
| `src/admin/home/{Home.tsx,url.ts,links.ts,messages.ts}`, `src/admin/home/shared/{ConfirmDialog.tsx,When.tsx,messages.ts}` | The page, tabs, URL, links, live region, confirm dialog, times (Task 3) |
| `src/admin/wizard/url.ts`, `src/admin/wizard/source/{TemplatePicker.tsx,messages.ts}` | `?template=` (Task 4) |
| `src/admin/{api.ts,queries.ts,errors.ts,limits.ts}` | Adapters, queries, sentences, mirrored limits (Task 6; `clearDryRuns` Task 9) |
| `src/admin/home/pinned/*` | Pinned schedules (Task 7) |
| `src/admin/home/jobs/rollback/*`, `src/admin/home/jobs/dry-runs/*`, `src/admin/home/jobs/{JobsTab.tsx,JobRow.tsx,actions.ts,messages.ts}` | Rollback dialog (Task 8), dry runs (Task 9), the Jobs tab (Task 13) |
| `src/admin/home/templates/*`, `src/admin/home/sources/*`, `src/admin/home/schedules/*` | The three other tabs (Tasks 10, 11, 12) |
| `tests/integration/home.test.ts`, `tests/integration-cf/parity.test.ts` | The additions on `sites/dev` and workerd (Task 14) |
| `src/admin/index.tsx`, `src/admin/messages.ts`, `src/meta.ts` | Wiring, the wizard's title, 0.7.0 (Task 15) |
| `docs/superpowers/notes/2026-11-24-m7b-review.md`, the spec, the roadmap | The review (Task 16) |

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify | — | scratch only | opus |
| 1. Summaries, fence, index | 0 (V2, V3) | `src/plugin/{summaries,service,routes,definition}.ts`, `tests/unit/{job-summaries,definition}.test.ts` | opus |
| 2. Split rollback counts | 0 | `src/engine/{types,rollback,revert}.ts`, `tests/unit/rollback-undo.test.ts` | opus |
| 3. Home shell | 0 | `src/admin/home/{Home.tsx,url.ts,links.ts,messages.ts}`, `src/admin/home/shared/*`, `tests/admin/home.test.tsx` | sonnet |
| 4. `?template=` in the wizard | 0 | `src/admin/wizard/url.ts`, `src/admin/wizard/source/{TemplatePicker.tsx,messages.ts}`, `tests/unit/admin-state.test.ts`, `tests/admin/source.test.tsx` | sonnet |
| 5. Clear dry runs | 1 | `src/plugin/{retention,dry-runs,service,routes}.ts`, `tests/unit/{clear-dry-runs,definition}.test.ts` | opus |
| 6. Adapters, queries, errors | 1, 3 | `src/admin/{api,queries,errors,limits}.ts`, `tests/unit/admin-{api,errors,limits}.test.ts`, `tests/admin/{queries.test.tsx,home-fixtures.ts}` | sonnet |
| 7. Pinned schedules | 3 | `src/admin/home/pinned/*`, `tests/unit/admin-pinned.test.ts` | opus |
| 8. Rollback dialog | 2, 3, 6 | `src/admin/home/jobs/rollback/*`, `tests/unit/admin-rollback.test.ts`, `tests/admin/rollback.test.tsx` | opus |
| 9. Dry runs | 3, 5, 6 | `src/admin/home/jobs/dry-runs/*`, `src/admin/api.ts`, `tests/unit/admin-api.test.ts`, `tests/admin/dry-runs.test.tsx` | sonnet |
| 10. Templates | 3, 4, 6, 7 | `src/admin/home/templates/*`, `tests/admin/templates.test.tsx` | sonnet |
| 11. Sources | 3, 6, 7 | `src/admin/home/sources/*`, `tests/admin/sources.test.tsx` | sonnet |
| 12. Schedules | 3, 6 | `src/admin/home/schedules/*`, `tests/unit/admin-cron.test.ts`, `tests/admin/schedules.test.tsx` | opus |
| 13. Jobs | 3, 6, 8, 9 | `src/admin/home/jobs/{JobsTab.tsx,JobRow.tsx,actions.ts,messages.ts}`, `tests/unit/admin-jobs.test.ts`, `tests/admin/jobs.test.tsx` | opus |
| 14. Integration and parity | 1, 2, 5 | `tests/integration/home.test.ts`, `tests/integration-cf/parity.test.ts` | sonnet |
| 15. Assembly | 3-13, V1 | `src/admin/{index.tsx,messages.ts}`, `src/plugin/definition.ts`, `src/meta.ts`, `tests/unit/definition.test.ts`, `tests/admin/{index,wizard,home-flow}.test.tsx` | opus |
| 16. Review | 0-15 | the note, the spec, the roadmap; scratch only | opus |

The waves:
1. **0** alone.
2. **1 ∥ 2 ∥ 3 ∥ 4.** No shared file: server routes, the engine, the home folder, the wizard's URL and picker.
3. **5 ∥ 6 ∥ 7.** Task 5 is the only server task; Task 6 consumes Task 1's types (`JobListItem`, `ClearDryRunsReply`) by `import type`; Task 7 takes the schedule update as a function argument, so it imports no adapter.
4. **8 ∥ 9 ∥ 10 ∥ 11 ∥ 12 ∥ 14.** Each owns its folder. Task 9 alone adds `api.clearDryRuns` (its route exists after Task 5) and its `ROUTE_INPUTS` row. Task 14 owns only test files.
5. **13** (composes 8 and 9).
6. **15** (wires the tabs, the pages and the version).
7. **16.**

Files touched by more than one task, merged in numeric order: `src/plugin/routes.ts` and `src/plugin/service.ts` (1, 5), `src/plugin/definition.ts` (1, 15), `tests/unit/definition.test.ts` (1, 5, 15), `src/admin/api.ts` and `tests/unit/admin-api.test.ts` (6, 9). None is touched by two tasks of one wave.

---

### Task 0: Verify Facts V1-V5

**Files:** none tracked. A scratch worktree `.superpowers/wt/scratch-m7b-t0/` (`git worktree add`), its own `sites/dev` database and uploads, a scratch `sites/dev-cf` D1 state, and `playwright-core` 1.56.1 in the session scratchpad (M7a Fact D12). All removed at the end.

**Interfaces:**
- Consumes: EmDash 1.2.0, the admin 1.2.0, Kumo 2.6.0, the sites.
- Produces: each fact marked "holds" or "fails, with what was seen", in the ledger `.superpowers/sdd/2026-11-24-flux-import-m7b-imports-home/progress.md`; Task 16 copies them into the review note. A failed fact stops the task it gates until the coordinator rules (each row names the fallback).

- [ ] **Step 1: Probe build.** In the worktree only: add the `admin.pages` of Global Constraints to `src/plugin/definition.ts`; add `"/imports": Probe` before `"/import"` in `src/admin/index.tsx`, where `Probe` renders a Kumo `Tabs`, a `Table` of two rows, a `DropdownMenu` with two items, a `Collapsible`, and a Kumo `Link` to `/_emdash/admin/plugins/flux-import/import?step=run&job=<id>`; add `["dryRun", "createdAt"]` to `STORAGE.jobs.indexes`; add a probe route `probe/dry` that answers `ctx.storage.jobs.query({ where: { dryRun: ctx.input.dry }, orderBy: { createdAt: "desc" }, limit: 8 })`'s IDs and `dryRun` values.
- [ ] **Step 2: V1, V2, V3, V4 on `sites/dev`.** Start it on a free port with a scratch `FLUX_DEV_DB`, `FLUX_DEV_UPLOADS` and `EMDASH_ENCRYPTION_KEY`. With a dev-bypass PAT held in shell memory: create two real jobs and two dry runs (`jobs/create` with `productsCsv(3)`), call `probe/dry { dry: false }` and `{ dry: true }` (V2: only the matching jobs); wait for a scheduler tick, then `SELECT name FROM sqlite_master WHERE name LIKE 'idx_plugin_flux-import_jobs_dryRun%'` with `node:sqlite` and `EXPLAIN QUERY PLAN` of `SELECT id FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'jobs' AND json_extract(data, '$.dryRun') = 0 ORDER BY json_extract(data, '$.createdAt') DESC LIMIT 8` (V2, V3). On a copy of that database with 5,000 inserted job rows, time the `CREATE INDEX` statement `generateCreateIndexSql` makes (V3). Save a template and a URL source (FeedServer), create a schedule `0 6 * * *`, read `nextRunAt` from `schedules/list` (V4). In headless Chromium, open `setup/dev-bypass?redirect=/_emdash/admin/plugins/flux-import`, press "Get Started" (M7a Fact D11), and check the sidebar folder, the root opening the probe, the icon, the `Link` opening the Run screen, and the manifest's `adminPages` (V1). Screenshot the probe in light and dark at 1280 px, with the menu and the collapsible open and a control focused (V5).
- [ ] **Step 3: V2, V3, V4 on `sites/dev-cf`.** Start it on a free port; repeat V2's calls, read the index with `wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master WHERE name LIKE 'idx_plugin_flux-import_jobs_dryRun%'"` after a scheduled event, and V4's `nextRunAt`.
- [ ] **Step 4: Record and clean up.** Record each fact with its evidence (values, timings, screenshot names kept in the scratch folder). Stop both servers (`pnpm exec astro dev stop`), remove the worktree, the databases, the browser and the scratch folder; `git checkout --` any `emdash-env.d.ts` a server changed; `git status` is clean. Gates: V1 → Task 15 (fallback: no `group`, the two labels as they are); V2 → Task 1 (fallback in plan Ruling 2); V3 → Task 14's index test (fallback: the test asserts the answer, not the index, and the note records it); V4 → Task 12 (fallback: the tab converts nothing and says "in the server's time"; coordinator rules); V5 → Tasks 9 and 13 (fallbacks in the V5 row).

### Task 1: Job summaries, the fence route and the dry-run index

**Files:**
- Modify: `src/plugin/summaries.ts`, `src/plugin/service.ts`, `src/plugin/routes.ts`, `src/plugin/definition.ts` (`STORAGE.jobs.indexes` only), `tests/unit/definition.test.ts`
- Test: `tests/unit/job-summaries.test.ts`

**Interfaces:**
- Consumes: `Job`, `JobStatus`, `Counters` (`src/engine/types.ts`); `rollbackRefusal` (`src/engine/rollback.ts`); `upgradeJob` (`src/engine/jobs.ts`); `readFence`, `Fence` (`src/emdash/fence.ts`); `page`, `Page`, `JOB_PAGE` (`service.ts`); `MemoryKv`, `makeDeps` (`tests/unit/fakes.ts`).
- Produces:
  ```ts
  // summaries.ts
  export interface JobListItem {
  	id: string; kind: "import" | "rollback"; status: JobStatus; dryRun: boolean;
  	origin?: "agent" | "schedule"; scheduleId?: string;
  	collection: string; locale: string; templateId?: string;
  	rollbackOf?: string; rolledBackBy?: string;
  	rollbackStatus?: JobStatus;   // the rollback job's status; absent when it is gone
  	startedAs?: string;
  	rollbackable: boolean;        // rollbackRefusal(job, now) === null
  	leased: boolean;              // lease !== null && lease.expiresAt > now
  	counters: Required<Pick<Counters, "created" | "updated" | "unchanged" | "failed" | "conflict" | "locked" | "filtered" | "reverted" | "removed">>;
  	errorCode?: string;           // job.error.code only
  	createdAt: string; updatedAt: string;
  }
  export function listItem(job: Job, rollbackStatus: JobStatus | undefined, now: number): JobListItem;
  export interface ClearDryRunsReply { cleared: number; more: boolean; cursor?: string } // Task 5 implements the route
  // service.ts
  export async function listJobSummaries(deps: Pick<EngineDeps, "jobs" | "now">, opts: { dryRun: boolean; cursor?: string }): Promise<Page<JobListItem>>;
  // routes.ts
  export const JOB_SUMMARIES_INPUT: z.ZodType<{ dryRun?: boolean; cursor?: string }>; // z.object({ dryRun: z.boolean().optional(), cursor }).strict()
  //   "jobs/summaries": route(JOB_SUMMARIES_INPUT, …listJobSummaries(deps, { dryRun: input.dryRun ?? false, cursor? }))
  //   "schedules/fence": route(z.object({}).strict(), …({ fence: await readFence(runtime.db) }))
  // definition.ts: STORAGE.jobs.indexes gains ["dryRun", "createdAt"], last
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/job-summaries.test.ts` (jobs in `new MemoryKv<Job>(STORAGE.jobs.indexes)`, so an undeclared field throws, Fact D5):
```ts
it("lists real imports newest first, a page at a time, without dry runs (Review Focus 5)", async () => {
	// 10 real jobs J01..J10 and 5 dry runs D1..D5, createdAt increasing
	const first = await listJobSummaries(deps, { dryRun: false });
	expect(first.items.map((j) => j.id)).toEqual(["J10", "J09", "J08", "J07", "J06", "J05", "J04", "J03"]);
	expect(first.hasMore).toBe(true);
	const second = await listJobSummaries(deps, { dryRun: false, cursor: first.cursor! });
	expect(second.items.map((j) => j.id)).toEqual(["J02", "J01"]);
	expect(second.hasMore).toBe(false);
});
it("lists only dry runs with dryRun true, dry rollbacks included", …);
it("queries only indexed fields: where dryRun, orderBy createdAt (Review Focus 5)", async () => {
	const query = vi.spyOn(jobs, "query");
	await listJobSummaries(deps, { dryRun: false });
	expect(query).toHaveBeenCalledWith({ where: { dryRun: false }, orderBy: { createdAt: "desc" }, limit: JOB_PAGE });
});
it("reads the rollback's status for a rolled-back import, and none once the rollback is gone", …); // rollbackStatus "running", then undefined after jobs.delete(R)
it("marks rollbackable exactly as rollbackRefusal: a completed journalled import only", …); // completed+journal → true; dry run, rolledBackBy, running, live lease, no journal, kind rollback → false
it("keeps the fields the table needs and nothing else", () => {
	expect(Object.keys(listItem(fullJob, "completed", NOW)).sort()).toEqual([
		"collection", "counters", "createdAt", "dryRun", "errorCode", "id", "kind", "leased", "locale", "origin",
		"rollbackOf", "rollbackStatus", "rollbackable", "rolledBackBy", "scheduleId", "startedAs", "status",
		"templateId", "updatedAt"]);
	expect(JSON.stringify(listItem(fullJob, undefined, NOW))).not.toContain(UPLOAD_ID); // nor error.message, template, lease.holder
});
it("reads counters absent on old jobs as 0", …); // a job without filtered, reverted, removed
it("answers schedules/fence with readFence's kind", async () => {
	// vi.mock("../../src/emdash/fence.js", () => ({ readFence: vi.fn(async () => "export") })), runtime mocked as rollback-route.test.ts
	expect(await call("schedules/fence", {})).toEqual({ fence: "export" });
});
it("answers jobs/summaries through the route with dryRun false by default", …);
```
`tests/unit/definition.test.ts`: `ROUTES` gains `"jobs/summaries"` and `"schedules/fence"`; the jobs index assertion gains `["dryRun", "createdAt"]` last; a new `it`: both inputs are strict (`{ dryRun: false, extra: 1 }` and `{ x: 1 }` refused) and `jobs/summaries` accepts `{}`, `{ dryRun: true }`, `{ cursor: "c" }`.

- [ ] **Step 2: See them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run --project unit tests/unit/job-summaries.test.ts tests/unit/definition.test.ts`
Expected: FAIL (`listJobSummaries` is not exported; the routes are missing).

- [ ] **Step 3: Implement**

`listJobSummaries`: one `deps.jobs.query({ where: { dryRun }, orderBy: { createdAt: "desc" }, limit: JOB_PAGE, cursor? })` (plan Ruling 2: with V2's fallback, `dryRun ? 1 : 0`); for each row with `kind !== "rollback"` and `rolledBackBy`, `deps.jobs.get(rolledBackBy)` for its status; `listItem(upgradeJob(row), status, deps.now())`. `listItem` copies each optional field only when set. Above `STORAGE`, extend the comment: `["dryRun", "createdAt"]` serves `jobs/summaries` and `jobs/clear-dry-runs` (M7b), built by EmDash at its first scheduler tick (Fact V3).

- [ ] **Step 4: See them pass**

Same command. Expected: PASS. Mutation checks: drop `where` (the dry-run test fails); order `asc` (the first test fails); copy `error.message` into the item (the keys test fails).

- [ ] **Step 5: Commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/plugin packages/flux-import/tests/unit/job-summaries.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Add job summaries with a dry-run filter, its storage index and the fence route"
```

### Task 2: Split counts on rollback jobs

**Files:**
- Modify: `src/engine/types.ts`, `src/engine/rollback.ts`, `src/engine/revert.ts`
- Test: `tests/unit/rollback-undo.test.ts`

**Interfaces:**
- Consumes: `setup`, `importRows` (`tests/unit/rollback-fixture.ts`); the missing-phase fixtures as `tests/unit/rollback-trash.test.ts` builds them; `summarize` (`src/plugin/summaries.ts`).
- Produces:
  ```ts
  // types.ts
  /** M7b: what a rollback job's reverted rows did (plan Ruling 7). */
  export interface RollbackUndo { deleted: number; restored: number; recovered: number }
  // Job gains (both on rollback jobs only):
  undo?: RollbackUndo;     // created by 0.7.0 or later; absent: unknown
  missingFrom?: number;    // the original's missing.fromSeq, when its missing phase had started
  // revert.ts
  export function undoKind(action: string | undefined, seq: number, missingFrom: number | undefined): keyof RollbackUndo | null;
  // delete | trash → "deleted"; restore → "recovered"; revert → seq >= missingFrom ? "recovered" : "restored"; else null
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/rollback-undo.test.ts`:
```ts
it("starts a rollback job with undo zeros and the original's missingFrom", async () => {
	const { rollback } = await createRollback(deps, { id: original.id, dryRun: true });
	expect(rollback.undo).toEqual({ deleted: 0, restored: 0, recovered: 0 });
	expect(rollback.missingFrom).toBe(original.missing?.fromSeq); // absent without a missing phase
});
it("counts a dry rollback of 2 creates and 1 update: deleted 2, restored 1, beside reverted 3", async () => {
	const done = await runRollback(deps, original.id, { dryRun: true });
	expect(done.undo).toEqual({ deleted: 2, restored: 1, recovered: 0 });
	expect(done.counters.reverted).toBe(3);
});
it("counts the real rollback the same way as its dry run", …);
it("counts the missing phase's trash and unpublish as recovered", …);   // 1 trashed + 1 unpublished → recovered 2
it("counts a created entry moved to Trash (no link) as deleted", …);
it("counts no conflict, failure or nothing-to-roll-back row", …);       // an edited entry → conflict 1, undo unchanged
it("moves a row's kind on retry: a conflict retried to reverted adds one, once (Review Focus 2)", …);
it("rebuilds undo with the counters when the retry pass tallies", …);
it("counts a row once when a crash re-runs it (Review Focus 2)", …);    // the stored row exists, cursor not saved
it("leaves a rollback job made before 0.7.0 without undo (Review Focus 2)", …); // delete undo, run: still undefined, reverted counted
it("leaves the agents' summary counters unchanged", () =>
	expect(Object.keys(summarize(done, NOW).counters).sort()).toEqual(
		["conflict", "created", "failed", "filtered", "locked", "removed", "reverted", "unchanged", "updated"]));
it.each([["delete", 5, undefined, "deleted"], ["trash", 5, 3, "deleted"], ["restore", 5, 3, "recovered"],
	["revert", 2, 3, "restored"], ["revert", 3, 3, "recovered"], ["revert", 9, undefined, "restored"], [undefined, 1, undefined, null]])
	("undoKind(%s, %i, %s) is %s", (action, seq, from, kind) => expect(undoKind(action, seq, from)).toBe(kind));
```

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run --project unit tests/unit/rollback-undo.test.ts`
Expected: FAIL (`undo` undefined; `undoKind` not exported).

- [ ] **Step 3: Implement**

- `createRollback`: `undo: { deleted: 0, restored: 0, recovered: 0 }`, and `missingFrom: original.missing.fromSeq` when `original.missing` is set.
- `revertRow`: wherever it bumps a counter (the crash-repair branch, the new row, and the retry's `-1` of the old row), and only when `counterOf(row) === "reverted"` and `job.undo` exists, bump `job.undo[undoKind(row.action, journal.seq, job.missingFrom)]` by the same amount.
- `tallyRollback(deps, job)` (now takes the job): rebuilds `undo` from the rows when `job.undo` exists, with each row's `seq`.
- Nothing else reads `undo`; `summarize` and `upgradeJob` are unchanged.

- [ ] **Step 4: See them pass**

Same command, plus `pnpm exec vitest run --project unit tests/unit/rollback*.test.ts tests/unit/agent*.test.ts tests/unit/summaries.test.ts`. Expected: PASS. Mutation checks: count `undo` for a conflict (fails "counts no conflict…"); drop the retry's decrement (fails "moves a row's kind on retry").

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/engine packages/flux-import/tests/unit/rollback-undo.test.ts
git commit -m "Count what a rollback deletes, restores and brings back, beside its total"
```

### Task 3: The home shell

**Files:**
- Create: `src/admin/home/Home.tsx`, `src/admin/home/url.ts`, `src/admin/home/links.ts`, `src/admin/home/messages.ts`, `src/admin/home/shared/ConfirmDialog.tsx`, `src/admin/home/shared/When.tsx`, `src/admin/home/shared/messages.ts`
- Test: `tests/admin/home.test.tsx`

**Interfaces:**
- Consumes: M7a's `useT`, `Msg`, `Values` (`i18n.ts`), `useCredentials` (`queries.ts`), `describeError`, `ERROR_MESSAGES` (`errors.ts`), `M.tryAgain` (`messages.ts`); the harness.
- Produces:
  ```ts
  // url.ts (plan Ruling 10)
  export const TABS = ["jobs", "templates", "sources", "schedules"] as const;
  export type TabId = (typeof TABS)[number];
  export function readTab(search: string): TabId;   // unknown or absent → "jobs"
  export function writeTab(tab: TabId): void;       // sets ?tab=, keeps other params, replaceState(history.state, …)
  // links.ts (plan Rulings 11, 12)
  export const HOME_URL = "/_emdash/admin/plugins/flux-import/imports";
  export const WIZARD_URL = "/_emdash/admin/plugins/flux-import/import";
  export function runUrl(jobId: string): string;        // `${WIZARD_URL}?step=run&job=${encodeURIComponent(jobId)}`
  export function templateUrl(templateId: string): string; // `${WIZARD_URL}?template=${encodeURIComponent(templateId)}`
  export function openPage(url: string): void;          // window.location.assign(url)
  // Home.tsx
  export type TabComponents = Readonly<Record<TabId, ComponentType>>;
  export function Home(props: { tabs: TabComponents }): JSX.Element;
  export function useHome(): { tab: TabId; goTo(tab: TabId): void; announce(text: string): void };
  // shared/ConfirmDialog.tsx — Kumo Dialog, as SchemaDiffDialog
  export function ConfirmDialog(props: {
  	open: boolean; title: string; sentence: string; confirmLabel: string; danger?: boolean; busy: boolean;
  	error?: ReactNode; children?: ReactNode; onConfirm(): void; onClose(): void;
  }): JSX.Element;   // Escape and Cancel close unless busy; the confirm button shows busy (aria-busy)
  // shared/When.tsx (plan Ruling 20)
  export function whenLabel(iso: string, now: number, locale: string, t: (m: Msg, v?: Values) => string): string; // "today 10:14" | "yesterday 10:14" | medium date, short time
  export function When(props: { iso: string }): JSX.Element; // <time dateTime title>{label}<span className="sr-only">{exact}</span></time>
  ```
  `Home`: the access probe as `Wizard` does (a 403 renders only "Only administrators can import." once, any other failure its sentence and "Try again"); then `<h1>` "Imports", a Kumo `Link` "New import" to `WIZARD_URL`, Kumo `Tabs` "Jobs | Templates | Sources | Schedules", and `<div role="tabpanel" aria-label={tab}>` holding `<h2>` and only the selected tab's component; one `<div aria-live="polite" className="sr-only">` fed by `announce`.

- [ ] **Step 1: Write the failing tests**

`tests/admin/home.test.tsx` (tabs are dummies rendering their name):
```ts
it("shows the administrators-only state once for the page on a 403", async () => {
	mockRoutes({ "credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
	renderAdmin(<Home tabs={DUMMY} />);
	expect(await screen.findAllByText("Only administrators can import.")).toHaveLength(1);
	expect(screen.queryByRole("tablist")).toBeNull();
});
it("renders Imports, the New import link to the wizard and four tabs with a tabpanel", async () => {
	expect(await screen.findByRole("heading", { level: 1, name: "Imports" })).toBeVisible();
	expect(screen.getByRole("link", { name: "New import" })).toHaveAttribute("href", "/_emdash/admin/plugins/flux-import/import");
	expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Jobs", "Templates", "Sources", "Schedules"]);
	expect(screen.getByRole("tabpanel")).toHaveTextContent("jobs-tab");
});
it("opens the tab named in ?tab=, and Jobs for an unknown one", …);
it("writes ?tab= with replaceState keeping history.state, and mounts only the shown tab", …);
it("goTo switches the tab from inside a tab", …);
it("announces through one polite live region", …);
it("closes a ConfirmDialog with Escape unless busy, and returns focus to its opener", …);
it("labels times today, yesterday and older, with the exact time as accessible text", …); // fixed now, locale "en"
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/home.test.tsx`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home packages/flux-import/tests/admin/home.test.tsx
git commit -m "Add the Imports home shell: tabs in the URL, the access probe, confirm dialogs and times"
```

### Task 4: "Use" a template: `?template=` in the wizard

**Files:**
- Modify: `src/admin/wizard/url.ts`, `src/admin/wizard/source/TemplatePicker.tsx`, `src/admin/wizard/source/messages.ts`, `tests/unit/admin-state.test.ts`, `tests/admin/source.test.tsx`

**Interfaces:**
- Consumes: M7a's `useAllTemplates`, `TemplatePicker`.
- Produces: `readUrl(search): { step: StepId | null; job: string | null; template: string | null }` (empty → null). `TemplatePicker` takes its initial selection from `readUrl(window.location.search).template` when that ID is in the list, and then shows "Choose the data, then use the template." until a file is sampled (plan Ruling 12). Nothing else in the wizard changes.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-state.test.ts`: the existing `readUrl` assertions gain `template: null`; new: `expect(readUrl("?template=T1")).toEqual({ step: null, job: null, template: "T1" })`.
`tests/admin/source.test.tsx`:
```ts
it("preselects the template named in ?template= and loads it once a file is sampled", …);
// history.replaceState(null, "", "?template=T1"); templates/list → [T1 "Products feed"]; the picker shows "Products feed";
// upload a CSV → "Use this template" → templates/get { id: "T1" } → Preview
it("ignores a ?template= that is not in the list", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-state.test.ts && pnpm exec vitest run --project admin tests/admin/source.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard packages/flux-import/tests/unit/admin-state.test.ts packages/flux-import/tests/admin/source.test.tsx
git commit -m "Open the wizard with a saved template chosen from the URL"
```

### Task 5: Clear dry runs

**Files:**
- Create: `src/plugin/dry-runs.ts`
- Modify: `src/plugin/retention.ts`, `src/plugin/service.ts`, `src/plugin/routes.ts`, `tests/unit/definition.test.ts`
- Test: `tests/unit/clear-dry-runs.test.ts`

**Interfaces:**
- Consumes: Task 1's `ClearDryRunsReply` and the `["dryRun", "createdAt"]` index; `uploadInUse`, `UploadStore`, `UploadKeeper` (`service.ts`); `busyJob` (`schedules.ts`); the fakes (`MemoryKv`, `FakeStorage`, `makeDeps`).
- Produces:
  ```ts
  // retention.ts (extracted from purgeExpired; its behaviour is unchanged, Fact D6)
  export function metered<T extends object>(target: T, meter: { used: number }): T;
  export type PurgeOutcome = "purged" | "skipped" | "stuck" | "out";
  export async function purgeJob(
  	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia">,
  	id: string,
  	due: (job: Job) => boolean,                 // re-checked on the versioned row before marking
  	opts?: { left?: () => number; counts?: { records: { n: number }; journal: { n: number } } },
  ): Promise<PurgeOutcome>;                     // skipped: not due, changed, or an original whose rollback job exists
  // service.ts
  export async function releaseFiles(deps: Pick<EngineDeps, "jobs">, uploads: UploadStore,
  	job: Pick<Job, "id" | "uploadId" | "sourceUploadId">, keep?: UploadKeeper): Promise<boolean>;
  //   releaseUploadIfUnused = uploadNeeded check, then releaseFiles
  // dry-runs.ts (plan Ruling 6)
  export const CLEAR_PAGE = 20, CLEAR_QUERY_TARGET = 150, CLEAR_CALL_MIN = 10;
  export const DRY_RUN_IDLE_MS = 3_600_000, AGENT_DRY_RUN_IDLE_MS = 86_400_000;
  export function clearable(job: Job, now: number): boolean;
  export async function clearDryRuns(deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
  	uploads: UploadStore, keep: UploadKeeper, cursor?: string): Promise<ClearDryRunsReply>;
  // routes.ts: "jobs/clear-dry-runs": route(z.object({ cursor }).strict(), …clearDryRuns(deps, uploads, keep, cursor))
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/clear-dry-runs.test.ts` (jobs in `MemoryKv(STORAGE.jobs.indexes)`; `clock.t` fixed):
```ts
it("clears finished dry runs and dry rollbacks with their records and staged files, and counts them", async () => {
	// D1 completed, D2 cancelled, R1 dry rollback completed, each updated > DRY_RUN_IDLE_MS ago; 3 records each; uploads U1, U2 staged
	expect(await clearDryRuns(deps, uploads, keepNone)).toEqual({ cleared: 3, more: false });
	expect(await deps.jobs.get("D1")).toBeNull();
	expect((await deps.records.query({ where: { jobId: "D1" } })).items).toEqual([]);
	expect(uploads.deleted).toEqual(expect.arrayContaining(["U1", "U2"]));
});
it("never touches a real job, even one started from the dry run (Review Focus 1)", …);
it("clears a dry run that finished a minute ago but keeps its staged file, so an open Preview's Run still imports it (Ruling 6)", …);
it("keeps a dry run whose batch holds a live lease (Review Focus 1)", …);  // lease.expiresAt > now, status completed? running
it("keeps an unfinished wizard dry run idle under DRY_RUN_IDLE_MS, and clears it after", …);
it("keeps an agent dry run that was started, or idle under 24 hours; clears one idle 24 hours, never started (Review Focus 1)", …);
it("keeps the staged file a real job still reads, and a URL source's latest fetch (Review Focus 1)", …);
	// real job J with uploadId U1 and failed 1 (uploadNeeded); keep(U2) true → D1, D2 cleared, U1 and U2 not deleted
it("loses to a concurrent jobs/start claim: the claimed dry run stays (Review Focus 1)", …);
	// jobs.getVersioned stubbed once to return the row with startedAs set, as a claim between scan and mark
it("stops at CLEAR_QUERY_TARGET calls with more and no cursor; the next call finishes the purging job", …); // a dry run with 400 records
it("answers more and a cursor while dry runs remain past the page", …); // 25 clearable → 20 cleared, more, cursor; then 5
it("relieves the M6b busy check: 101 idle unfinished dry runs on a source no longer make it busy", …); // busyJob before: a job; after clearing: null
it("accepts only { cursor? } on the route", …);
```
`tests/unit/definition.test.ts`: `ROUTES` gains `"jobs/clear-dry-runs"`.
`tests/unit/retention.test.ts` is not edited: it must still pass unchanged.

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/clear-dry-runs.test.ts tests/unit/definition.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`purgeJob`: the body of `markPurging` and `prune` moved out of `purgeExpired` (which now calls it with its own `due`, `left` and `counts`). `clearDryRuns`:
```ts
const meter = { used: 0 }; const left = () => CLEAR_QUERY_TARGET - meter.used;
const m = { jobs: metered(deps.jobs, meter), records: metered(deps.records, meter),
	journal: metered(deps.journal, meter), journalMedia: metered(deps.journalMedia, meter) };
const now = deps.now();
const page = await m.jobs.query({ where: { dryRun: true }, orderBy: { createdAt: "asc" }, limit: CLEAR_PAGE, ...(cursor ? { cursor } : {}) });
let cleared = 0;
for (const { data } of page.items) {
	if (!clearable(data, now)) continue;
	if (left() < CLEAR_CALL_MIN) return { cleared, more: true };          // starts over next call
	const ended = await purgeJob(m, data.id, (j) => j.dryRun && clearable(j, now), { left });
	if (ended === "out") return { cleared, more: true };
	if (ended !== "purged") continue;
	cleared++;
	if (now - Date.parse(data.updatedAt) >= DRY_RUN_IDLE_MS)               // plan Ruling 6: a fresh dry run's file stays
		await releaseFiles(deps, uploads, data, keep).catch(() => false);  // retention removes a file left here
}
return page.hasMore && page.cursor ? { cleared, more: true, cursor: page.cursor } : { cleared, more: false };
```
`clearable(job, now)`: `job.dryRun`, no live lease, then plan Ruling 6 (idle = `now - Date.parse(job.updatedAt)`).

- [ ] **Step 4: See them pass**

Same command, plus `pnpm exec vitest run --project unit tests/unit/retention.test.ts tests/unit/schedules.test.ts tests/unit/service.test.ts`. Expected: PASS. Mutation checks: drop the lease check (the lease test fails); drop `startedAs` (the agent test fails); release before purging (the claim test fails).

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/plugin packages/flux-import/tests/unit/clear-dry-runs.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Clear finished and abandoned dry runs with retention's per-job purge, a page at a time"
```

### Task 6: Adapters, queries, errors and limits for the home

**Files:**
- Modify: `src/admin/api.ts`, `src/admin/queries.ts`, `src/admin/errors.ts`, `src/admin/limits.ts`, `tests/unit/admin-api.test.ts`, `tests/unit/admin-errors.test.ts`, `tests/unit/admin-limits.test.ts`, `tests/admin/queries.test.tsx`
- Create: `tests/admin/home-fixtures.ts`

**Interfaces:**
- Consumes: Task 1's `JobListItem` and routes; server types by `import type`: `ScheduleView`, `CreateScheduleInput`, `UpdateScheduleInput` (`schedules.ts`), `Fence` (`emdash/fence.ts`), `TemplateFile` (`template-files.ts`), `SavedResult`, `TemplateSummary`, `SourceRow`, `CredentialInfo`, `Job`, `Page`.
- Produces:
  ```ts
  // api.ts — added to `api`
  jobSummaries(i: { dryRun: boolean; cursor?: string }, signal?: AbortSignal): Promise<Page<JobListItem>>;
  rollback(i: { id: string; dryRun: boolean }): Promise<Job>;
  updateTemplate(i: { id: string; revision: number; name?: string; description?: string | null; template?: unknown }): Promise<SavedResult>; // widened; the wizard's calls are unchanged
  deleteTemplate(i: { id: string; revision: number }): Promise<{ deleted: true }>;
  exportTemplate(i: { id: string }): Promise<{ filename: string; file: TemplateFile }>;
  importTemplate(i: { file: unknown; name?: string; owner?: string }): Promise<SavedResult>;
  updateSource(i: { id: string; name?: string; url?: string; credential?: string | null }): Promise<SourceRow>;
  deleteSource(i: { id: string }): Promise<{ deleted: true }>;
  setCredential(i: { name: string; header: string; value: string }): Promise<CredentialInfo>;
  deleteCredential(i: { name: string }): Promise<{ deleted: true }>;
  listSchedules(i: { cursor?: string }, signal?: AbortSignal): Promise<Page<ScheduleView>>;
  createSchedule(i: CreateScheduleInput): Promise<{ schedule: ScheduleView }>;
  updateSchedule(i: UpdateScheduleInput): Promise<{ schedule: ScheduleView }>;
  deleteSchedule(i: { id: string; revision: number }): Promise<{ deleted: true }>;
  runSchedule(i: { id: string; force?: boolean }): Promise<{ queued: true; schedule: ScheduleView }>;
  fence(): Promise<{ fence: Fence }>;
  // api.ts — free function
  export function saveJson(value: unknown, filename: string): void; // Blob + object URL, as downloadLog (plan Ruling 17)
  // queries.ts — keys and hooks
  queryKeys.jobs = ["flux-import", "jobs"]; queryKeys.dryRuns = ["flux-import", "dry-runs"];
  queryKeys.schedules = ["flux-import", "schedules"]; queryKeys.fence = ["flux-import", "fence"];
  export function useJobPages(): UseInfiniteQueryResult<InfiniteData<Page<JobListItem>, string | undefined>>; // jobSummaries { dryRun: false }; next page param = cursor while hasMore; refetchInterval per plan Ruling 15
  export function useDryRuns(): UseQueryResult<Page<JobListItem>>;          // first page of { dryRun: true }
  export function useSchedules(): UseQueryResult<ScheduleView[]>;           // every page; refetchInterval per plan Ruling 15
  export function useFence(): UseQueryResult<Fence>;                        // follows useSchedules' interval
  export function useTemplate(id: string | null): UseQueryResult<SavedTemplate>; // templates/get; no request while null
  // errors.ts: plan Ruling 16's twelve codes in WIZARD_ERROR_CODES and ERROR_MESSAGES; INVALID_FILE, INVALID_CRON in DETAIL_CODES
  export function scheduleNames(e: unknown, schedules: readonly ScheduleView[]): string | null; // names from details.scheduleIds, comma-joined
  // limits.ts (pinned to the server's in admin-limits.test.ts)
  export const TEMPLATE_BODY_MAX_BYTES = 2_097_152, TEMPLATE_DESCRIPTION_MAX = 2000, JOB_PAGE = 8, MAX_SCHEDULES = 20,
  	SOURCE_NAME_MAX = 100, SCHEDULE_BATCH_MAX = 500;
  export const CREDENTIAL_NAME: RegExp; export const HEADER_NAME: RegExp;   // credentials.ts
  // tests/admin/home-fixtures.ts
  export function item(over?: Partial<JobListItem>): JobListItem;
  export function schedule(over?: Partial<ScheduleView>): ScheduleView;
  export function templateRow(over?: Partial<TemplateSummary>): TemplateSummary;
  export function sourceRow(over?: Partial<SourceRow>): SourceRow;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-api.test.ts`: `ROUTE_INPUTS` gains one row per new adapter (each recorded body parsed by its route's own schema, as M7a's test does); new: `it("saves a template file as pretty JSON under its filename", …)`. `tests/unit/admin-errors.test.ts`: the existing "has a sentence for every code" covers the new codes; new: `it("names the schedules of an in-use refusal from details.scheduleIds", …)` (`TEMPLATE_IN_USE` with `["S1", "S2"]` → `"Nightly, Hourly"`). `tests/unit/admin-limits.test.ts`: each new constant equals the server's (`routes.ts`, `templates.ts`, `service.ts`, `schedules.ts`, `credentials.ts`). `tests/admin/queries.test.tsx`: `useJobPages` fetches the next page with the first page's cursor; `useSchedules` follows two pages; `useTemplate(null)` sends nothing.

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-api.test.ts tests/unit/admin-errors.test.ts tests/unit/admin-limits.test.ts && pnpm exec vitest run --project admin tests/admin/queries.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/api.ts packages/flux-import/src/admin/queries.ts packages/flux-import/src/admin/errors.ts packages/flux-import/src/admin/limits.ts packages/flux-import/tests/unit/admin-api.test.ts packages/flux-import/tests/unit/admin-errors.test.ts packages/flux-import/tests/unit/admin-limits.test.ts packages/flux-import/tests/admin/queries.test.tsx packages/flux-import/tests/admin/home-fixtures.ts
git commit -m "Add the home's route adapters, queries, error sentences and mirrored limits"
```

### Task 7: Pinned schedules

**Files:**
- Create: `src/admin/home/pinned/pinned.ts`, `src/admin/home/pinned/PinnedSchedules.tsx`, `src/admin/home/pinned/messages.ts`
- Test: `tests/unit/admin-pinned.test.ts`

**Interfaces:**
- Consumes: `ScheduleView`, `SourceRow` by `import type`; `useT`; `describeError`; Kumo `Checkbox`.
- Produces (plan Ruling 14):
  ```ts
  export type PinChange = { kind: "template"; templateId: string } | { kind: "source"; sourceId: string };
  export interface PinUpdate { id: string; revision: number; templateId?: string; templateRevision?: number; enabled?: true }
  export function pinnedSchedules(schedules: readonly ScheduleView[], change: PinChange): ScheduleView[];
  //   template: every schedule with that templateId; source: the enabled ones with that sourceId
  export function sourcePinChanged(row: Pick<SourceRow, "url" | "credential">, edit: { url?: string; credential?: string | null }): boolean;
  export function pinUpdate(s: ScheduleView, change: PinChange, newRevision?: number): PinUpdate;
  export async function updatePinned(rows: readonly ScheduleView[], change: PinChange, newRevision: number | undefined,
  	update: (i: PinUpdate) => Promise<unknown>): Promise<{ updated: string[]; failed: { name: string; error: unknown }[] }>; // one at a time
  export function PinnedSchedules(props: { rows: readonly ScheduleView[]; kind: PinChange["kind"]; checked: boolean;
  	onCheckedChange(checked: boolean): void }): JSX.Element | null;  // null without rows
  export function PinnedFailures(props: { failed: { name: string; error: unknown }[] }): JSX.Element | null;
  ```
  Copy: "These schedules run this template: {names}." / "These schedules read this source: {names}."; the checkbox "Also update these schedules" (checked by default); unchecked: "They will pause at their next run until they are updated."; for a source: "Updating them also clears their failed launches and arms them as you."; a failure: "Couldn't update {name}: {reason} It will pause at its next run."

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-pinned.test.ts`:
```ts
it("pins every schedule of a template, enabled or not (Review Focus 4)", …);
it("pins only the enabled schedules of a source (Review Focus 4)", …);
it("sees a source pin change only for a new URL or credential", () => {
	expect(sourcePinChanged({ url: "https://a.example/x" }, { url: "https://a.example/x" })).toBe(false);
	expect(sourcePinChanged({ url: "https://a.example/x" }, { credential: "feed-token" })).toBe(true);
	expect(sourcePinChanged({ url: "https://a.example/x", credential: "k" }, { credential: null })).toBe(true);
});
it("updates a template's schedules to the new revision, a source's with enabled true", () => {
	expect(pinUpdate(s1, { kind: "template", templateId: "T1" }, 4)).toEqual({ id: "S1", revision: 2, templateId: "T1", templateRevision: 4 });
	expect(pinUpdate(s1, { kind: "source", sourceId: "SRC1" })).toEqual({ id: "S1", revision: 2, enabled: true });
});
it("updates one at a time and names each failure, going on after it (Review Focus 4)", …); // S2 SCHEDULE_BUSY → failed [{ name: "Hourly" }], updated ["S1", "S3"]
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-pinned.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces** (the components are exercised by Tasks 10 and 11).

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/pinned packages/flux-import/tests/unit/admin-pinned.test.ts
git commit -m "Find and update the schedules pinned to an edited template or source"
```

### Task 8: The rollback dialog

**Files:**
- Create: `src/admin/home/jobs/rollback/RollbackDialog.tsx`, `src/admin/home/jobs/rollback/plan.ts`, `src/admin/home/jobs/rollback/messages.ts`
- Test: `tests/unit/admin-rollback.test.ts`, `tests/admin/rollback.test.tsx`

**Interfaces:**
- Consumes: Task 2's `Job.undo`; Task 6's `api.rollback`, `api.getJob`, `api.resume`, `api.next`, `queryKeys`; M7a's `useJobDriver`, `describeError`, `describeJobError`; Task 3's `useHome().announce`.
- Produces:
  ```ts
  // plan.ts
  export interface RollbackPlan { total: number; deleted?: number; restored?: number; recovered?: number; kept: number; gone: number }
  export function planOf(job: Job): RollbackPlan;  // total = reverted; kept = conflict + failed + locked; gone = unchanged; the three from undo when present
  export function planLines(plan: RollbackPlan): { msg: Msg; values: Values }[]; // non-zero lines only; without undo, the total line
  // RollbackDialog.tsx
  export type RollbackTarget =
  	| { kind: "start"; jobId: string; name: string; when: string; scheduleName: string | null }
  	| { kind: "continue"; rollbackId: string; status: JobStatus; name: string };
  export function RollbackDialog(props: { target: RollbackTarget; onClose(): void }): JSX.Element;
  ```
  Phases (one reducer): `checking` (`jobs/rollback { id, dryRun: true }`, then `useJobDriver` to its end, "Checking what the rollback will do…") → `ready` (the plan lines, the schedule line, "Roll back" and "Keep the import") → `rolling` (`jobs/rollback { id, dryRun: false }`, driven with a `Meter` of rows done; Escape and Close disabled) → `done` ("Rollback finished." announced, `jobs` and `dryRuns` invalidated, "Close") or `error` (sentence, "Try again" re-running the failed step). `continue`: `jobs/resume` first when `paused` or `failed`, then `rolling`. A 409 `INVALID_TRANSITION` on the real call → `jobs/get` on the original; with `rolledBackBy` → "This import is already being rolled back." and "Continue the rollback" (→ `continue` on that ID).
  Copy (binding): title "Roll back {name}?"; lines "Entries the import created, to delete: {count}", "Entries it updated, to restore to their earlier version: {count}", "Entries it moved to Trash or unpublished, to bring back: {count}", "Entries edited since, which stay as they are: {count}", "Entries already gone: {count}", and without `undo` "Entries to roll back: {count}"; "Its schedule {name} will be paused."

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-rollback.test.ts`: `planOf` and `planLines` for a job with `undo { deleted: 2, restored: 1, recovered: 1 }`, `conflict: 1`, `unchanged: 0` (four lines, in that order) and for one without `undo` (`reverted: 3` → `"Entries to roll back: 3"` and the kept line).
`tests/admin/rollback.test.tsx`:
```ts
it("runs a dry rollback first and says exactly what it will delete, restore and bring back", async () => {
	const { calls } = mockRoutes({ "jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL), "jobs/next": nextScript });
	renderAdmin(<RollbackDialog target={START} onClose={vi.fn()} />);
	expect(await screen.findByText("Entries the import created, to delete: 2")).toBeVisible();
	expect(screen.getByText("Entries it updated, to restore to their earlier version: 1")).toBeVisible();
	expect(calls.filter((c) => c.route === "jobs/rollback").map((c) => c.body)).toEqual([{ id: "J1", dryRun: true }]);
});
it("falls back to the total for a rollback made before 0.7.0 (Review Focus 2)", …);
it("rolls back only on Roll back, drives it with progress and announces Rollback finished.", …);
it("closes with Keep the import after the dry run and sends no real rollback", …);
it("does not close on Escape while the rollback runs", …);
it("says a scheduled job's schedule will be paused", …);              // scheduleName "Nightly" → "Its schedule Nightly will be paused."
it("offers Continue the rollback when another tab started it first (Review Focus 2)", …); // real → fail INVALID_TRANSITION 409; jobs/get → rolledBackBy "R9"; continue drives R9
it("continues a paused rollback: resumes it, then drives it", …);     // calls: jobs/resume { id: "R1" }, then jobs/next { id: "R1" }…
it("shows the sentence and Try again when the dry rollback fails", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-rollback.test.ts && pnpm exec vitest run --project admin tests/admin/rollback.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS. Mutation check: send `dryRun: false` first (the first test fails).

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/jobs/rollback packages/flux-import/tests/unit/admin-rollback.test.ts packages/flux-import/tests/admin/rollback.test.tsx
git commit -m "Add the rollback dialog: a dry rollback's counts first, then the rollback with progress"
```

### Task 9: Dry runs under the Jobs list

**Files:**
- Create: `src/admin/home/jobs/dry-runs/DryRuns.tsx`, `src/admin/home/jobs/dry-runs/messages.ts`
- Modify: `src/admin/api.ts` (`clearDryRuns`), `tests/unit/admin-api.test.ts` (its `ROUTE_INPUTS` row)
- Test: `tests/admin/dry-runs.test.tsx`

**Interfaces:**
- Consumes: Task 5's route and `ClearDryRunsReply`; Task 6's `useDryRuns`, `queryKeys`, `home-fixtures`; Task 3's `ConfirmDialog`, `When`, `useHome`.
- Produces: `api.clearDryRuns(i: { cursor?: string }): Promise<ClearDryRunsReply>`; `export function DryRuns(props: { names: (item: JobListItem) => string }): JSX.Element | null` (null with no dry runs). Collapsed: a disclosure (Kumo `Collapsible`, or Fact V5's fallback) "{count} dry runs" or "More than {count} dry runs" (`hasMore`); open: a short list (name, collection and locale, `When`, status in words); "Clear dry runs" → `ConfirmDialog` "Clear the finished and idle dry runs, with their staged files?" → the call, repeated with `cursor` while `more`, at most 50 calls (plan Ruling 6) → "Cleared {count} dry runs." announced, or, when 0, "No dry runs could be cleared now: running ones, and an agent's from the last 24 hours, are kept." → `dryRuns` invalidated.

- [ ] **Step 1: Write the failing tests**

`tests/admin/dry-runs.test.tsx`:
```ts
it("shows one collapsed line, 3 dry runs, and nothing without dry runs", …);
it("says More than 8 dry runs when the first page has more", …);
it("expands to a short list with name, collection and locale, when and status", …);
it("clears after confirming, following the cursor while more, and announces Cleared 12 dry runs.", async () => {
	const { calls } = mockRoutes({ "jobs/summaries": () => DRY_PAGE,
		"jobs/clear-dry-runs": (b) => ((b as { cursor?: string }).cursor ? { cleared: 4, more: false } : { cleared: 8, more: true, cursor: "c1" }) });
	// open, Clear dry runs, confirm
	expect(calls.filter((c) => c.route === "jobs/clear-dry-runs").map((c) => c.body)).toEqual([{}, { cursor: "c1" }]);
	expect(await screen.findByText("Cleared 12 dry runs.")).toBeInTheDocument();
});
it("says why nothing was cleared (Review Focus 1)", …);
it("stops after 50 calls", …);
```
`tests/unit/admin-api.test.ts`: `ROUTE_INPUTS["jobs/clear-dry-runs"]` with `{ cursor: "c1" }`.

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/dry-runs.test.tsx && pnpm exec vitest run --project unit tests/unit/admin-api.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/jobs/dry-runs packages/flux-import/src/admin/api.ts packages/flux-import/tests/unit/admin-api.test.ts packages/flux-import/tests/admin/dry-runs.test.tsx
git commit -m "Fold dry runs into one line under the jobs, with Clear dry runs"
```

### Task 10: The Templates tab

**Files:**
- Create: `src/admin/home/templates/{TemplatesTab.tsx,EditTemplateDialog.tsx,ImportTemplateDialog.tsx,messages.ts}`
- Test: `tests/admin/templates.test.tsx`

**Interfaces:**
- Consumes: Task 6's `useAllTemplates`, `useSchedules`, `api.updateTemplate|deleteTemplate|exportTemplate|importTemplate|updateSchedule`, `saveJson`, `scheduleNames`, `TEMPLATE_BODY_MAX_BYTES`, `TEMPLATE_DESCRIPTION_MAX`, `OWNER_PATTERN`; Task 7's `pinnedSchedules`, `updatePinned`, `PinnedSchedules`, `PinnedFailures`; Task 3's `ConfirmDialog`, `When`, `useHome`, `templateUrl`.
- Produces: `export function TemplatesTab(): JSX.Element`.
  - A table: name, "{collection} · {locale}", description, "Revision {revision}", last change (`When` of `updatedAt`). Row actions (names per Global Constraints): Use (a `Link` to `templateUrl(id)`), Export, Rename and describe, Delete.
  - **Rename and describe:** name (1-100), description (≤ 2,000; empty sends `null`), `PinnedSchedules` for `pinnedSchedules(schedules, { kind: "template", templateId })`. Save: `templates/update { id, revision, name?, description? }` (changed fields only), then, when checked, `updatePinned(…, saved.template.revision, api.updateSchedule)`; `PinnedFailures` for any failure; `TEMPLATE_CHANGED` → "This template changed elsewhere." with "Reload" (refetch).
  - **Delete:** `ConfirmDialog` "Delete the template {name}? Jobs made from it keep their copy."; `TEMPLATE_IN_USE` → "{names} run this template. Delete or change those schedules first."
  - **Export:** `templates/export { id }` → `saveJson(file, filename)`.
  - **Import a template:** a file input (`.json`), optional new name and owner (`OWNER_PATTERN`); plan Ruling 17's browser checks; `templates/import { file, name?, owner? }`; `OWNER_IN_USE` → its sentence and focus on the owner field; success announces "Imported {name}."
  - Empty: "No saved templates yet." with "Save one from the wizard: Options, Save as template." and a link to the wizard. A `Loader` while loading; errors as `describeError` with "Try again".

- [ ] **Step 1: Write the failing tests**

```ts
it("lists every template with collection and locale, description, revision and last change", …);
it("links Use to the wizard with ?template=", …);    // href "/_emdash/admin/plugins/flux-import/import?template=T1"
it("exports through templates/export and saves the file under its filename", …);
it("renames and describes at the revision, then updates the pinned schedules (Review Focus 4)", async () => {
	// templates/update → revision 4; schedules S1 (enabled), S2 (disabled) on T1
	expect(updateBodies).toEqual([{ id: "T1", revision: 3, name: "Products feed v2", description: "Daily" }]);
	expect(scheduleBodies).toEqual([
		{ id: "S1", revision: 2, templateId: "T1", templateRevision: 4 },
		{ id: "S2", revision: 5, templateId: "T1", templateRevision: 4 }]);
});
it("names a pinned schedule whose update failed, and says it will pause (Review Focus 4)", …); // S2 → SCHEDULE_BUSY: "Couldn't update Hourly: … It will pause at its next run."
it("says the schedules will pause when Also update is unchecked, and updates none", …);
it("shows TEMPLATE_CHANGED as changed elsewhere, and Reload refetches", …);
it("refuses to delete a template a schedule runs, naming the schedules", …); // TEMPLATE_IN_USE { scheduleIds: ["S1"] } → "Nightly run this template. …"
it("imports a file with a new name and owner, and shows OWNER_IN_USE and INVALID_FILE in words", …);
it("refuses a file that is not JSON or over 2 MiB before sending it", …); // no templates/import call
it("shows the empty state with the pointer to Save as template", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/templates.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/templates packages/flux-import/tests/admin/templates.test.tsx
git commit -m "Add the Templates tab: use, export, import, rename, describe and delete"
```

### Task 11: The Sources tab and credentials

**Files:**
- Create: `src/admin/home/sources/{SourcesTab.tsx,SourceDialog.tsx,Credentials.tsx,display.ts,messages.ts}`
- Test: `tests/admin/sources.test.tsx`

**Interfaces:**
- Consumes: Task 6's `useAllSources`, `useCredentials`, `useSchedules`, `api.createSource|updateSource|deleteSource|fetchSource|setCredential|deleteCredential|updateSchedule`, `scheduleNames`, `CREDENTIAL_NAME`, `HEADER_NAME`, `SOURCE_NAME_MAX`; Task 7's pinned helpers; Task 3's shared pieces.
- Produces: `export function SourcesTab(): JSX.Element`; `display.ts`: `export function urlLabel(url: string): string` (`host + pathname`, plan Ruling 19), `export function lastFetchState(row: SourceRow): { kind: "never" } | { kind: "fetched"; at: string } | { kind: "failed"; at: string; code: string }`.
  - Sources table: name, `urlLabel`, credential name or "No credential", last fetch ("Fetched {when}", "Failed {when}: {sentence}", "Never fetched"). Actions: Fetch now (`sources/fetch { id }` → "New content fetched." or "No change since the last fetch.", announced), Edit, Delete; "Add a source".
  - **Add / Edit** (`SourceDialog`): name, URL, credential (a select of names, plus "No credential"). Edit sends changed fields only (`credential: null` to remove); when `sourcePinChanged`, `PinnedSchedules` for the enabled schedules, then `updatePinned` (plan Ruling 14). `CONFLICT` → "A source with this name already exists."
  - **Delete:** `ConfirmDialog`; `SOURCE_IN_USE` names the schedules.
  - **Credentials** (below, `<h3>`): name and header; "Add or replace a credential" (name, header, value as `<Input type="password" autoComplete="off">`, cleared after the call; `credentials/set` once); Delete with a `ConfirmDialog` naming the sources that use it (plan Ruling 18).
  - Empty states: "No URL sources yet." and "No credentials yet."

- [ ] **Step 1: Write the failing tests**

```ts
it("lists name, host and path only, the credential's name, and the last fetch in words (Review Focus 3)", async () => {
	// url "https://u:p@feed.example.com/a/b.json?token=s3cret"; lastFetch { uploadId: UPLOAD_ID, at: … };
	// lastError newer { code: "HTTP_ERROR", message: "HTTP 500 from https://u:p@feed.example.com/a/b.json?token=s3cret" }
	expect(await screen.findByText("feed.example.com/a/b.json")).toBeVisible();
	for (const secret of ["s3cret", "u:p", UPLOAD_ID, "HTTP 500 from"]) expect(document.body.textContent).not.toContain(secret);
});
it("adds a source with name, URL and credential", …);             // sources/create { name, url, credential: "feed-token" }
it("offers Also update for enabled schedules only when the URL or credential changes (Review Focus 4)", …);
	// name only: no PinnedSchedules, no schedules/update; URL: S1 (enabled) → { id: "S1", revision: 2, enabled: true }; S2 (disabled) untouched
it("fetches now and says whether the content changed", …);
it("refuses to delete a source a schedule reads, naming the schedules", …);
it("adds a credential through a password input and never shows the value again (Review Focus 3)", …);
	// credentials/set { name: "feed-token", header: "Authorization", value: "Bearer k-123" }; then no "k-123" in the document
it("deletes a credential after naming the sources that use it", …);
it("shows both empty states", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/sources.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same command. Expected: PASS. Mutation check: render `row.url` (the secrets test fails).

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/sources packages/flux-import/tests/admin/sources.test.tsx
git commit -m "Add the Sources tab with write-only credentials"
```

### Task 12: The Schedules tab

**Files:**
- Create: `src/admin/home/schedules/{SchedulesTab.tsx,ScheduleDialog.tsx,FenceBanner.tsx,RunLog.tsx,cron.ts,messages.ts}`
- Test: `tests/unit/admin-cron.test.ts`, `tests/admin/schedules.test.tsx`

**Interfaces:**
- Consumes: Task 6's `useSchedules`, `useFence`, `useAllTemplates`, `useAllSources`, `useTemplate`, `api.createSchedule|updateSchedule|deleteSchedule|runSchedule`, `MAX_SCHEDULES`, `SCHEDULE_BATCH_MAX`; `PauseReason`, `ScheduleView`, `RunEntry` by `import type`; Task 3's shared pieces, `useHome().goTo`, `runUrl`.
- Produces:
  ```ts
  // cron.ts (plan Ruling 13)
  export type Timing =
  	| { kind: "hourly"; minute: number } | { kind: "daily"; hour: number; minute: number }
  	| { kind: "weekly"; day: number; hour: number; minute: number } | { kind: "custom"; cron: string };
  export function toCron(t: Timing): string;
  export function fromCron(cron: string): Timing;  // exact patterns only, numbers without leading zeros, in range
  export function describeTiming(t: Timing): { msg: Msg; values: Values }; // "Every hour at minute {minute}" | "Every day at {time} UTC" | "Every {day} at {time} UTC" | "Custom: {cron} (UTC)"
  export const PAUSE_MESSAGES: Readonly<Record<PauseReason, Msg>>; // one per reason (15)
  export function pauseMessage(reason: string): Msg;               // unknown → "for a reason this version does not know"
  export function launchMessage(l: NonNullable<ScheduleView["lastLaunch"]>): Msg; // started | unchanged | busy | failed (with errorCode's sentence)
  // SchedulesTab.tsx
  export function SchedulesTab(): JSX.Element;
  ```
  - **The fence:** `FenceBanner` over the table for any kind but `clear`: import "An import into this site is running, so scheduled runs wait until it ends."; export "An export of this site is running, …"; media "EmDash is turning on media tracking, …"; error "flux-import couldn't check whether the site is busy, so scheduled runs wait." (plan Ruling 8).
  - **Table:** name, template and source names (from the lists; "Deleted template"/"Deleted source"), `describeTiming(fromCron(cron))`, next run ("{time} UTC" or "Not scheduled"), last launch (`When` and `launchMessage`), state: "Queued" while `due`, else "Running" (enabled), "Paused: {reason}" (disabled with a `pause`), or "Paused" (disabled without one: the spec's "disabled", which is what the Pause button leaves). Actions: Pause/Resume (`schedules/update { id, revision, enabled }`), Run now (`schedules/run { id }` → "Queued" and announced; `SCHEDULE_BUSY`, `SCHEDULE_DISABLED` in words), Edit, Delete (`ConfirmDialog`, `{ id, revision }`), Run log (`RunLog`: each run's time, outcome in words and counts, its job linked with `runUrl`).
  - **Create and Edit** (`ScheduleDialog`): name; template (a select; its revision from the list); URL source; when it runs (`RadioGroup` Hourly/Daily/Weekly/Custom, the time inputs, "Times are in UTC, as EmDash runs schedules."); publish or draft; batch size (1-500, optional); when `useTemplate(id)` shows `rules.missing`: missing entries "As the template sets" (`"template"`, default), "Off" (`false`), "A lower threshold" (`{ maxPercent }`, at most the template's). Create sends every field; Edit only the changed ones, with `templateRevision` whenever `templateId` changes. `INVALID_CRON` under the Custom field; `TEMPLATE_PROBLEMS` lists its problems; `SCHEDULE_CHANGED` → changed elsewhere with Reload.
  - **Nothing to schedule:** with no template or no URL source, the dialog says "Save a template and add a URL source first." with buttons that `goTo("templates")` and `goTo("sources")`. At `MAX_SCHEDULES`, "New schedule" is disabled with the reason.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-cron.test.ts`:
```ts
it.each([[{ kind: "hourly", minute: 5 }, "5 * * * *"], [{ kind: "daily", hour: 6, minute: 0 }, "0 6 * * *"],
	[{ kind: "weekly", day: 1, hour: 6, minute: 30 }, "30 6 * * 1"]])("writes %j as %s and reads it back", (t, cron) => {
	expect(toCron(t as Timing)).toBe(cron); expect(fromCron(cron)).toEqual(t);
});
it.each(["@daily", "0 6 * * 1-5", "*/15 * * * *", "00 6 * * *", "0 24 * * *", "0 6 1 * *"])("reads %s as custom", (cron) =>
	expect(fromCron(cron)).toEqual({ kind: "custom", cron }));
it("says Every day at 06:00 UTC", () => expect(interpolate(…describeTiming({ kind: "daily", hour: 6, minute: 0 }))).toBe("Every day at 06:00 UTC"));
it("has a sentence for every pause reason, and one for an unknown reason", …); // PAUSE_MESSAGES satisfies Record<PauseReason, Msg>; 15 keys
```
`tests/admin/schedules.test.tsx`:
```ts
it("lists names, timing in words with UTC, next run, last launch and the state with its pause reason in words", …);
it("shows the fence banner with its kind in words, and none when clear", …);
it("creates a daily schedule from a template at its listed revision and a URL source", async () => {
	expect(createBody).toEqual({ name: "Nightly products", templateId: "T1", templateRevision: 3, sourceId: "SRC1",
		cron: "0 6 * * *", publish: true });
});
it("asks for missing entries only when the template has rules.missing, sending template by default", …);
it("shows INVALID_CRON in words under a custom expression", …);
it("says what to create first, with buttons to Templates and Sources", …);
it("runs now and shows Queued until the launch; SCHEDULE_BUSY and SCHEDULE_DISABLED in words", …);
it("pauses and resumes with enabled at the row's revision", …);
it("deletes after confirming", …);
it("shows the run log with each job linked to its Run screen", …);
it("edits only what changed, with templateRevision whenever templateId changes", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-cron.test.ts && pnpm exec vitest run --project admin tests/admin/schedules.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/schedules packages/flux-import/tests/unit/admin-cron.test.ts packages/flux-import/tests/admin/schedules.test.tsx
git commit -m "Add the Schedules tab: create, edit, pause, resume, run now, delete, and the site fence"
```

### Task 13: The Jobs tab

**Files:**
- Create: `src/admin/home/jobs/{JobsTab.tsx,JobRow.tsx,actions.ts,messages.ts}`
- Test: `tests/unit/admin-jobs.test.ts`, `tests/admin/jobs.test.tsx`

**Interfaces:**
- Consumes: Task 8's `RollbackDialog`, `RollbackTarget`; Task 9's `DryRuns`; Task 6's `useJobPages`, `useAllTemplates`, `useSchedules`, `api.pause|resume|cancel|retry`, `downloadLog`, `queryKeys`, `home-fixtures`; Task 3's `When`, `whenLabel`, `ConfirmDialog`, `useHome`, `runUrl`, `openPage`, `WIZARD_URL`.
- Produces:
  ```ts
  // actions.ts (pure; plan Rulings 3-5, 11)
  export type JobAction = "open" | "log" | "pause" | "resume" | "cancel" | "retry" | "rollback" | "continueRollback";
  export function jobActions(i: JobListItem): JobAction[];
  //   import: open, log; pause (created|running); resume (paused|failed, no rolledBackBy); cancel (created|running|paused|failed);
  //   retry (completed, failed+conflict+locked > 0, no rolledBackBy); rollback (rollbackable)
  //   rollback job: log; continueRollback (created|running|paused|failed)
  export type JobState = JobStatus | "rolling_back" | "rolled_back" | "rollback_cancelled";
  export function jobState(i: JobListItem): JobState;
  export function jobName(i: JobListItem, templates: ReadonlyMap<string, string>): { msg: Msg; values?: Values };
  export function originMsg(i: JobListItem): Msg;  // "Agent" | "Schedule" | "Admin or API"
  export function JobsTab(): JSX.Element;
  ```
  - A table of `useJobPages()`'s rows: name, "{collection} · {locale}", started (`When`), origin, status (a `Badge` with the state's words: "Waiting to start", "Running", "Paused", "Completed", "Cancelled", "Failed", "Rolling back", "Rolled back", "Rollback cancelled"), counts ("Created {created} · Updated {updated} · Unchanged {unchanged} · Failed {failed}"; a rollback row "Rolled back {reverted} · Kept {kept}"). "Load more" while `hasNextPage`. Below: `<DryRuns names={…} />`.
  - Row actions in a Kumo `DropdownMenu` (or Fact V5's fallback), each named `{action} {name}, {when}`: Open (`runUrl`), Download log and Download failed records (`downloadLog(id)`, `downloadLog(id, "failed")`), Pause, Resume and Retry (the call, then `openPage(runUrl(id))`; a scheduled job's only refreshes and announces "The schedule runs this job; its status updates here."), Cancel (`ConfirmDialog` "Cancel the import {name}? Records already written stay."), Roll back (`RollbackDialog` `start`, with the schedule's name when `origin === "schedule"`), Continue the rollback (`RollbackDialog` `continue`). Every action invalidates `jobs`.
  - Empty: "No imports yet." with a "New import" link to `WIZARD_URL`. Failures: `describeError` with "Try again".

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-jobs.test.ts`: a table over `jobActions` (one row per status and kind, plus rolled back, dry, scheduled), `jobState` (`rollbackStatus` completed / running / cancelled / absent), `jobName` (template listed, inline, deleted, rollback of each).
`tests/admin/jobs.test.tsx`:
```ts
it("reads jobs/summaries with dryRun false and never jobs/list (Review Focus 5)", async () => {
	const { calls } = mockRoutes(ROUTES);
	renderAdmin(<JobsTab />);
	await screen.findByRole("table");
	expect(calls.find((c) => c.route === "jobs/summaries")?.body).toEqual({ dryRun: false });
	expect(calls.some((c) => c.route === "jobs/list")).toBe(false);
});
it("loads the next page with the cursor on Load more (Review Focus 5)", …);
it("names rows from the template list: One-off import, Deleted template, Rollback of Products feed (Review Focus 5)", …);
it("shows collection and locale, the exact start time as accessible text, origin, status in words and counts", …);
it("reads Rolling back while the rollback runs and Rolled back once it is done", …);
it("names each row action with the row: Roll back Products feed, today 10:14", …);
it("resumes and retries, then opens the Run screen; a scheduled job's only refreshes and says so", …); // window.location.assign spy
it("cancels after confirming", …);
it("downloads the log, all and failed only", …);                   // GET log.csv ?id=J1 and ?id=J1&status=failed
it("opens the rollback dialog, and continues an unfinished rollback from its row (Review Focus 2)", …);
it("never shows a job's error message or an upload ID (Review Focus 3)", …);
it("shows the empty state with New import", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/admin-jobs.test.ts && pnpm exec vitest run --project admin tests/admin/jobs.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces.**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS. Mutation checks: offer Roll back on `completed` without `rollbackable` (the actions table fails); read `jobs/list` (the first test fails).

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/home/jobs/JobsTab.tsx packages/flux-import/src/admin/home/jobs/JobRow.tsx packages/flux-import/src/admin/home/jobs/actions.ts packages/flux-import/src/admin/home/jobs/messages.ts packages/flux-import/tests/unit/admin-jobs.test.ts packages/flux-import/tests/admin/jobs.test.tsx
git commit -m "Add the Jobs tab: real imports, their actions, rollbacks and the dry-run line"
```

### Task 14: The server additions on `sites/dev` and workerd

**Files:**
- Create: `tests/integration/home.test.ts` (port 4399; check it with `curl` first)
- Modify: `tests/integration-cf/parity.test.ts` (one `it`)

**Interfaces:**
- Consumes: Tasks 1, 2 and 5's routes; `startServer`, `stopServer`, `Client`, `devBypass`, `withDb`, `productsCsv`, `template` (`tests/integration/*`); the parity file's `d1` and `client`.
- Produces: no interface.

- [ ] **Step 1: Write the tests**

`tests/integration/home.test.ts`:
```ts
it("lists real imports without dry runs through jobs/summaries, newest first, by cursor", …); // 9 real + 3 dry → 8 + 1
it("clears finished dry runs with their staged files and keeps a running one", …);          // uploads dir no longer holds the dry runs' files; the running one stays
it("answers schedules/fence clear, then import while a transfer row runs", …);              // withDb insert into _emdash_transfer_operations, as mcp.test.ts:282-292
it("splits a rollback's counts on a real site: dry and real alike", …);                     // import 3, update 1 → dry rollback undo { deleted: 2, restored: 1, recovered: 0 }, then the real one
it("builds the dryRun index at the first scheduler tick (Fact V3)", …);                      // sqlite_master; with V3's fallback, the answer only
```
`tests/integration-cf/parity.test.ts`: `it("lists, clears, fences and splits M7b's additions on D1 and R2", …)` — summaries without dry runs; a cleared dry run's file gone from R2 (`client` upload read answers 404); the fence through `d1("INSERT INTO _emdash_transfer_operations …")` and back; a dry rollback's `undo`.

- [ ] **Step 2: Run them** — `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/home.test.ts`, then `pnpm exec vitest run --config vitest.cf.config.ts -t "M7b"` with nothing else running (M7a review: the workerd suite needs the machine). Expected: PASS. A failure here is a bug in Task 1, 2 or 5: fix it there (with its unit test) in this task's commit, and say so in the report.

- [ ] **Step 3: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/tests/integration/home.test.ts packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Test the job summaries, dry-run clearing, fence and split rollback counts on SQLite and D1"
```

### Task 15: Assembly, the pages and 0.7.0

**Files:**
- Modify: `src/admin/index.tsx`, `src/admin/messages.ts` (`pageTitle` → "New import"), `src/plugin/definition.ts` (`admin.pages`), `src/meta.ts` (`"0.7.0"`), `tests/unit/definition.test.ts`, `tests/admin/index.test.tsx`, `tests/admin/wizard.test.tsx`, `tests/admin/fixtures.ts` (the manifest's flux-import entry: version 0.7.0 and the two pages)
- Create: `tests/admin/home-flow.test.tsx`

**Interfaces:**
- Consumes: Task 3's `Home`; Tasks 10-13's tabs; Fact V1.
- Produces: `pages: PluginAdminExports["pages"] = { "/imports": ImportsPage, "/import": ImportPage }` (in that order), `ImportsPage = () => <Home tabs={{ jobs: JobsTab, templates: TemplatesTab, sources: SourcesTab, schedules: SchedulesTab }} />`; `admin.pages` as in Global Constraints; `fields` unchanged.

- [ ] **Step 1: Write the failing tests**

`tests/unit/definition.test.ts`: "sets FLUX_IMPORT_VERSION to 0.7.0"; `admin.pages` equals the two entries with `group: "Imports"`.
`tests/admin/index.test.tsx`: `Object.keys(pages)` is `["/imports", "/import"]`; `pages["/imports"]` renders the heading "Imports" and the Jobs tab; the wizard's `<h1>` reads "New import" (also in `wizard.test.tsx`).
`tests/admin/home-flow.test.tsx` (one `mockRoutes` table per flow; the call order asserted):
```ts
it("rolls back an import after its dry-run summary", …);
	// Jobs → Roll back Products feed → jobs/rollback dryRun true → next… → "Entries the import created, to delete: 10"
	// → Roll back → jobs/rollback dryRun false → next… → "Rollback finished." → the row reads Rolled back
it("exports a template, then imports it under another name", …);  // templates/export → saveJson; Import a template → templates/import { file, name: "Products feed copy" } → listed
it("creates a daily schedule, runs it now, pauses it and deletes it", …);
it("clears the dry runs Preview left behind", …);
it("never sends a request without X-EmDash-Request", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project unit tests/unit/definition.test.ts && pnpm exec vitest run --project admin tests/admin/index.test.tsx tests/admin/wizard.test.tsx tests/admin/home-flow.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Wire as in Interfaces.** If Fact V1 failed, drop `group` and say so in the commit body and the ledger.

- [ ] **Step 4: See them pass**, then the whole suite: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS: 142 files, the boundary test green over the full graph.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/admin/index.tsx packages/flux-import/src/admin/messages.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/meta.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/admin/index.test.tsx packages/flux-import/tests/admin/wizard.test.tsx packages/flux-import/tests/admin/fixtures.ts packages/flux-import/tests/admin/home-flow.test.tsx
git commit -m "Add the Imports home beside New import in one sidebar folder, version 0.7.0"
```

### Task 16: Polish, acceptance, the review note and the roadmap

**Files:**
- Create: `docs/superpowers/notes/2026-11-24-m7b-review.md`
- Modify: `docs/superpowers/specs/2026-11-24-flux-import-m7b-imports-home-design.md` (amendments, open issues), `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (the M7b row of "Milestone 7 split"), and any `src/admin/**` file the polish fixes (with its tests)
- Temporarily (never committed): scripts, a scratch database and uploads, and screenshots in `.superpowers/wt/scratch-m7b-review/`

**Interfaces:**
- Consumes: everything above.
- Produces: the note with the acceptance run; the spec's amendments for plan Rulings 1-20 and Task 0's facts; the roadmap row.

- [ ] **Step 1: The design critique and polish pass**

Invoke the `impeccable:impeccable` skill on the four tabs, their dialogs and their empty, loading and error states: critique, then polish, in the admin's light and dark themes at 1280 px and 768 px, with Step 3's site and headless Chromium for screenshots. Check hierarchy and spacing against the admin's own list screens and M7a's wizard; Kumo consistency; plain copy, one sentence per error; WCAG AA contrast and text size; focus order, visible focus, the tab and dialog keyboard paths. Fix each finding in its own small commit with the owning task's tests updated (`pnpm format && pnpm typecheck && pnpm lint && pnpm test` before each); findings not fixed go to "Design findings" with the reason. The polish adds no dependency, no route and no class outside the admin's CSS.

- [ ] **Step 2: Every suite**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`, the last with nothing else on the machine. Expected: PASS: 142 files; 22 integration files; 29 parity tests. Record counts, run times and flakes (M7a Facts F1, F3: rerun `translations.test.ts` and `retention.test.ts` alone on free ports if their ports are held) in "Checks".

- [ ] **Step 3: The manual acceptance run (spec "Intent")**

Set-up, as M7a's Task 16 Step 3 and its review's set-up:
- A script in `.superpowers/wt/scratch-m7b-review/`, bundled with the lockfile's esbuild, starts `FakeAiServer` (`tests/integration/fake-ai.ts`) and a `FeedServer` (`tests/integration/feed-server.ts`) with two feeds: `/products.json` (`productsJson(10)`, open) and `/secure.json` (`productsJson(12)`, `authorization: "Bearer <random>"`), on free ports in 4600-4699.
- `sites/dev` with `astro dev` on a free port, `FLUX_DEV_ALLOW_PRIVATE_NETWORK=1`, a scratch `FLUX_DEV_DB` and `FLUX_DEV_UPLOADS`, a throwaway `EMDASH_ENCRYPTION_KEY`; the AI settings pointed at the fake through a dev-bypass PAT held in memory, and cleared at the end.
- Headless Chromium with a DevTools port, one script per step, `setup/dev-bypass?redirect=/_emdash/admin/plugins/flux-import`, "Get Started".
- **The M7a acceptance data, rebuilt through the wizard** (not part of the acceptance): `productsCsv(10)` into `posts`/`en`, Preview, Run; then From URL `/products.json`, saved in Options as template "Products feed", Preview, Run. The Previews leave their dry runs.

Then, as an Administrator who never touches the API, a screenshot at each step:
1. The sidebar shows the folder "Imports" with "Imports" and "New import"; the plugin root opens the home on Jobs. Jobs lists the two imports (no dry runs) and "{n} dry runs".
2. Open the "Products feed" import's log: Download log and Download failed records save their files.
3. Roll it back: the dialog runs the dry rollback and says "Entries the import created, to delete: 10"; "Roll back"; progress; "Rollback finished."; the row reads "Rolled back" and a "Rollback of Products feed" row is listed.
4. Templates: export "Products feed" (the file is saved), then "Import a template" with that file and the name "Products feed copy"; both are listed.
5. Sources: add the credential `feed-token` (header `Authorization`, the value typed once), then the source "Products (secure)" at `/secure.json` with it; the row shows the host and path and the credential's name, and the typed value appears nowhere; "Fetch now" says "New content fetched."
6. Schedules: create "Nightly products", Daily at 06:00 ("Every day at 06:00 UTC"), from "Products feed" and "Products (secure)"; Run now ("Queued", then the launch); Jobs shows the scheduled run with origin "Schedule"; the schedule's run log links it to its Run screen.
7. Pause it (the state reads "Paused"; Resume would arm it again), then delete it after the confirm dialog.
8. Jobs: Clear dry runs; "Cleared {n} dry runs."; the line is gone.
9. Open the home on `sites/dev-cf` (`pnpm exec astro dev` there, on a free port) and screenshot each tab.

Also record one page load's module URLs (one each for Kumo, Lingui and React Query, M7a Fact V2), and anything that did not behave as the spec says. Stop every server, clear the settings, restore any changed `emdash-env.d.ts` with `git checkout --`, remove the scratch folder; `git status` shows only the intended files.

- [ ] **Step 4: The review note**

Create `docs/superpowers/notes/2026-11-24-m7b-review.md`, with the M7a note's sections:
````markdown
# M7b review: the Imports home in the EmDash admin

Branch `m7b-imports-home`, plan `docs/superpowers/plans/2026-11-24-flux-import-m7b-imports-home.md`,
spec `docs/superpowers/specs/2026-11-24-flux-import-m7b-imports-home-design.md`.

Date: … · Commit: `…` · Node: v22.23.1 · EmDash 1.2.0 · Kumo 2.6.0

## Checks
(the six commands, counts, run times, flakes)

## Facts V1-V5
(Task 0's result for each, and whether the acceptance run confirmed it; D1-D20 where the run touched them)

## Review Focus
(the plan's five items: the tests that answer each, and what the acceptance run showed)

## The acceptance run
(Step 3, step by step, with screenshot names)

## Design findings
(Step 1: fixed, with commits; not fixed, with reasons)

## Rulings
(plan Rulings 1-20, each with what the code does now; process, pre-flight and coordinator rulings; by task)

## Deviations from the plan
(anything the implementation changed, with the reason)

## Whole-branch review
(the reviewer's findings and their fixes)

## Open issues
(new ones; the spec's and M7a's carried forward, marking those M7b closed: jobs/list's whole rows, the silent fence, uncleared dry runs)
````
Fill every section from the runs; leave no placeholder.

- [ ] **Step 5: The spec's amendments and the roadmap**

In the spec, add "Amendments from the plan and review", one line each naming the plan ruling or fact: summaries on a new route (Ruling 1, Fact D1); the index and its build (Ruling 2, Facts V2, V3); the list item (Ruling 3); names and origins composed in the admin (Ruling 4, Fact D2); the clear route's rule and bounds (Ruling 6); the split counts beside the counters (Ruling 7, Fact D8); the fence route (Ruling 8); the pages and the wizard's title (Ruling 9, Fact V1); "Use" by `?template=` (Ruling 12); UTC timing (Ruling 13, Fact V4); the re-pin by `enabled: true` (Ruling 14, Fact D10); the in-use codes `TEMPLATE_IN_USE` and `SOURCE_IN_USE` (Ruling 16). Add the review's open issues to "Open issues".
In the roadmap's "Milestone 7 split", the M7b row: link the spec, say what shipped in the M7a row's style, last cell `Done ([review](../notes/2026-11-24-m7b-review.md))`.

- [ ] **Step 6: Commit**

Run (repo root): `pnpm format && pnpm lint`, then `git status`: only the note, the spec, the roadmap and polish files already committed in Step 1.
```bash
git add docs/superpowers/notes/2026-11-24-m7b-review.md docs/superpowers/specs/2026-11-24-flux-import-m7b-imports-home-design.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 7b review results, amend the spec and mark M7b done in the roadmap"
```

## After this plan

M7b is done when Task 16's commit is in and the tree is clean. Open the pull request into `claude/adoring-hawking-y7zfj2` with a summary of the note's Checks, Rulings and acceptance run, and its test plan (the six commands and the manual run). No attribution trailer. Next is M8 (ship).
