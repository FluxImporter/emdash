# Flux Import M6b: scheduled URL imports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below), and Task 0 changes no file. Tasks 3, 4 and 6 can run in parallel worktrees after Task 2, and Tasks 8 and 9 after Task 7. The rest follow in order (see "Parallel execution").

**Goal:** Let an Administrator set up a schedule (a saved template at a pinned revision, a pinned URL source, a UTC cron expression and the job options) that imports the feed unattended: a due mark at each cron time, one pump task that does one unit of work per tick (a batch, else a launch), and a pause with a reason whenever a run cannot be trusted to go on alone.

**Architecture:** by task:
- **Task 1.** Groundwork. `Job` gains `origin: "schedule"`, `scheduleId`, `scheduled` and `feedSourceId` (set by URL-source jobs, `jobs/start` and rollbacks). `src/plugin/services.ts` (new) holds `buildServices(ctx, runtime, actor)`, `withScheduledServices` and `createJobFrom`, which take a `PluginContext`; the content and media ports take a `null` actor and the lock reader the sentinel user `""`; `jobs/next` runs a scheduled job's batch unattributed. `STORAGE.schedules`, the two `jobs` indexes, `users:read` and version 0.4.0.
- **Task 2.** `src/plugin/cron-syntax.ts` (the expression grammar) and `src/plugin/schedules.ts` (the schedule rows, their checks, the CRUD and run services, the busy and open-job checks, scheduler writes, pauses, the in-use and warning helpers, reconciliation).
- **Task 3.** The routes: `schedules/create|list|update|delete|run`; the in-use refusals of `templates/delete` and `sources/delete`; the warnings of `templates/update` and `sources/update`; the pauses of `jobs/cancel` and `jobs/rollback`; the reopening of a resumed or retried scheduled job.
- **Task 4.** `src/plugin/launch.ts`: due marks and the launch (busy check, claim, pins, creator check, job creation, result table, pauses).
- **Task 5.** `src/emdash/fence.ts` (the site fence read) and `src/plugin/pump.ts` (stand-down, finalization and the run log, one batch at the tick caps, the launch, the idle cancel); the tick caps and `nextBatch`'s limits in `src/plugin/service.ts`.
- **Task 6.** `src/plugin/retention.ts`: hourly, a bounded purge from a full scan, the scheduled-job guards and the saved cursor.
- **Task 7.** `src/plugin/scheduler.ts`: the cron hook's dispatch and its 180 s timeout, wired in `definition.ts` with reconciliation on activate and the hourly settings label; the integration helper `tests/integration/schedules-client.ts`.
- **Tasks 8 and 9.** Node integration on `sites/dev` (the acceptance with the real timer, then a deterministic tick driver) and workerd parity on `sites/dev-cf`, driven only by real `scheduled()` events with the cron timer stopped. Each adds the dev-only `POST /test/stop-cron-timer` to its own test site.
- **Task 10.** The review run: every suite, V5 on the final code, the manual check on both runtimes, the note, the spec amendments and the roadmap row.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` 4.5.4 in the engine, `astro/zod` in routes), Biome 2, EmDash 1.2.0, `@emdash-cms/auth` 1.2.0 (already a dependency), Astro 7.3, `@astrojs/cloudflare` 14 and Wrangler 4 for workerd. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-17-flux-import-m6b-scheduled-imports-design.md`, all sections, Rulings 1-52 binding (where a ruling is amended, the amendment). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 6 split). Previous plan: `docs/superpowers/plans/2026-11-16-flux-import-m6c-mcp-tools.md`. Reviews: `docs/superpowers/notes/2026-11-16-m6a-review.md`, `docs/superpowers/notes/2026-11-16-m6c-review.md`.

How this plan was checked while drafting (results in "Verification while drafting"):
- Task 0's facts were proven on Node and workerd with temporary probe routes, probe cron tasks, a pump and retention emulation and the M5a D1 counter, all removed afterwards.
- The code in Tasks 1-9 was written against the code at `6e21a18` and the EmDash 1.2.0 source. Every name, signature and fake it uses was checked against those files. It was not applied and run while drafting. Each task's "see them fail" and "see them pass" steps are the first run.

Citation conventions: EmDash line numbers refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's facts are cited as "spec F<n>" and "spec P<n>", its rulings as "spec Ruling <n>"; this plan's facts as "Fact V<n>" or "Fact E<n>", its rulings as "plan Ruling <n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID is `flux-import`. The package exports stay `fluxImport()`, `fluxImportRoutes()` and `createPlugin()`.
- `FLUX_IMPORT_VERSION` goes to `0.4.0` (Task 1); `package.json` stays `0.1.0` until M8.
- Storage (Task 1): a new collection `schedules` with indexes `["name", "templateId", "sourceId"]`; `jobs` gains `["scheduled", "status", "createdAt"]` and `["feedSourceId", "status"]` (plan Ruling 2 amends the spec's `["feedSourceId", "dryRun", "status"]`). No other index changes.
- Capabilities: one added, `users:read` (spec Ruling 43). The MCP tool table, its descriptions and `tests/unit/fixtures/mcp-consent.txt` do not change (spec Ruling 50).
- New routes, all `POST`, JSON in and out, `permission: "import:execute"`, strict `astro/zod` inputs: `schedules/create`, `schedules/list`, `schedules/update`, `schedules/delete`, `schedules/run`. Existing routes keep their input; their output changes only as the spec says (`templates/update`'s `check.warnings`, and `sources/update`'s `warnings`, plan Ruling 14).
- Cron tasks: `retention` (`17 * * * *` from Task 6), `schedule-<id>` (the schedule's expression, `data: { scheduleId }`), `pump` (`*/10 * * * * *`).
- No new dependency. `@emdash-cms/auth`'s `Permissions` is already importable.

**Bounds, exactly** (in `src/plugin/schedules.ts` unless named otherwise)
- `MAX_SCHEDULES` 20, `RUN_LOG_SIZE` 20, `WRITE_ATTEMPTS` 5, `LAUNCH_CLAIM_STALE_MS` 600,000, `PUMP_TASK` `"pump"`, `PUMP_SCHEDULE` `"*/10 * * * * *"`; defaults `publish` true, `batchSize` 50 (1-500), `budgetMs` 4,000 (500-20,000).
- `LAUNCH_FAILURES_TO_PAUSE` 3 (`launch.ts`).
- `FINALIZE_PER_TICK` 2 (`pump.ts`).
- `TICK_BATCH_CAP` 6, `TICK_LINKED_BATCH_CAP` 3, `TICK_MISSING_SCAN_CAP` 20, `TICK_MISSING_BATCH_CAP` 5, `TICK_LOOKUP_BUDGET` 350 (`service.ts`; Fact V5 keeps the spec's values).
- `CRON_HOOK_TIMEOUT_MS` 180,000 (`scheduler.ts`); `CRON_MAX_LENGTH` 256 (`cron-syntax.ts`).
- `RETENTION_SCHEDULE` `"17 * * * *"`, `RETENTION_SCAN_PAGE` 20, `RETENTION_SCAN_MAX` 1,000, `RETENTION_QUERY_TARGET` 150, `RETENTION_PRUNE_MIN` 10, `RETENTION_CURSOR_KEY` `"retention:cursor"` (`retention.ts`).

**Codes and messages, exactly** (route errors are `ServiceError(code, message, status, details)`)
- `INVALID_CRON` 400: `` `${problem}. ${CRON_RULE}` `` for flux-import's own check, EmDash's message as it is when `schedule()` refuses (Fact E1). `CRON_RULE` = "Use five cron fields (minute, hour, day of month, month, day of week) or @hourly, @daily, @weekly, @monthly or @yearly; times are UTC".
- `MISSING_REQUIRED` 400 "The template removes missing entries (rules.missing); set missing to false, \"template\" or { maxPercent }".
- `INVALID_OPTIONS` 400 "The template has no rules.missing; leave missing out" and `` `missing.maxPercent ${n} is over the template's ${max}; a schedule can lower the threshold, never raise it` ``.
- `NOT_FOUND` 404 `` `Schedule ${id} not found` ``; `TEMPLATE_NOT_FOUND` 404 `` `Template ${id} not found` `` (M6a's `templateNotFound`); `SOURCE_NOT_FOUND` 404 `` `Source ${id} not found` ``.
- `NAME_TAKEN` 409 `` `A schedule named "${name}" already exists` ``; `SCHEDULE_LIMIT` 409 `` `A site has at most ${MAX_SCHEDULES} schedules; delete one first` ``.
- `TEMPLATE_CHANGED` 409 (M6a's `staleTemplate`); `TEMPLATE_PROBLEMS` 409 `` `Template ${id} does not fit the site; fix it before scheduling it` ``, `details: { problems }`.
- `SCHEDULE_CHANGED` 409 `` `Schedule ${id} is at revision ${current}, not ${given}; read it again` ``, `details: { revision }`.
- `SCHEDULE_BUSY` 409 `` `Schedule ${id} is busy with job ${jobId}; wait for it to finish or cancel it` ``, `details: { jobId }`.
- `SCHEDULE_DISABLED` 409 `` `Schedule ${id} is disabled; enable it first` `` (with `` ` (paused: ${reason})` `` before the semicolon when paused).
- `TEMPLATE_IN_USE` 409 `` `Template ${id} is used by schedule(s) ${names}; delete or change them first` ``, `details: { scheduleIds }`; `SOURCE_IN_USE` likewise with "Source".
- `CONFLICT` 409 "The schedule kept changing; try again" (a route's compare-and-set loop ran out).
- Warnings: `` `Schedule ${name} (${id}) runs revision ${n}; update it to run this revision` `` (`templates/update`) and `` `Schedule ${name} (${id}) pins this source's URL and credential; it pauses at its next run until it is enabled again` `` (`sources/update`).

**Environment**
- Node `>=22.16`. In agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only: never `cat >`, `cat >>` or heredocs through `cat`.
- Scratch files go in `.superpowers/wt/` (excluded from git), never `/tmp`, which WSL wipes on restart.
- Tokens live in memory (tests) or in a shell variable (manual runs), never in a file, a commit or a transcript excerpt.

**Code rules**
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- The engine (`src/engine/`) never imports `emdash`.
- Use EmDash APIs only as documented or as read in `node_modules`, cited by file and line.
- The only raw SQL is the fence read (`src/emdash/fence.ts`), a fixed Kysely `sql` template with no values, as the lock read is. No content query is added. Plugin storage is queried only on declared index fields, at most 100 rows a page, and never with a boolean `where` value (plan Ruling 2).
- Every scheduler write to a schedule row is a compare-and-set loop on the newest row (`WRITE_ATTEMPTS`), conditional on `current?.jobId` where the spec says so, and never changes `revision` (spec Rulings 34, 46).
- Schedules store and return codes only, never messages (spec Ruling 47); messages go to `ctx.log`, through `redact`.
- Biome: tabs, line width 100 (a tab counts 2). Run `pnpm format` (Biome's `check --write`) before `pnpm lint`; snippets here are formatted to that width, but the formatter's output wins.

**Running tests**
- Vitest runs from `packages/flux-import` with file paths, for example `pnpm exec vitest run tests/unit/schedules.test.ts`.
- Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/schedules.test.ts`.
- Workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M6b"`.
- Ports: the new Node integration file starts its own server on 4390. The shared server uses 4399, the workerd harness 4396, the other suites 4391-4395, 4397 and 4398. Never run two copies of the same harness at once. Task 0's probes used 4479 (Node) and 4478 (workerd).
- `tests/unit/schedule.test.ts` already exists (M5b, entry scheduling). New files are named `schedules.test.ts`, `schedule-routes.test.ts`, `schedule-fakes.ts` and so on (Fact E6).

**Repository hygiene**
- Never commit `sites/dev/.env`, tokens, or the changes the dev server writes to `sites/dev/emdash-env.d.ts` and `sites/dev-cf/emdash-env.d.ts`. The shared integration setup restores the first; restore both by hand after any other server run.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails with "1Password: failed to fill whole buffer", retry once; otherwise stop and report. Never pass `--no-gpg-sign`.
- Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.

**Definition of done**
- `pnpm format && pnpm typecheck && pnpm lint && pnpm test` pass from the repo root after every task (baseline at `6e21a18`: 88 unit files, 2,171 tests; 96 unit files after Task 7: Tasks 1, 3, 4 and 7 add one each, Tasks 2 and 5 two each).
- Task 6 also passes `tests/integration/retention.test.ts`; Task 8 its integration file and `pnpm test:integration`; Task 9 the targeted workerd tests; Task 10 runs everything, `pnpm test:cf` included (about 30 minutes).

## Review Focus

1. **A cancel or rollback of a scheduled job stops the schedule.** Without the pause, the next cron time re-imports what the Admin just undid or stopped (spec Ruling 32). Expected: `jobs/cancel` pauses `cancelled` with the job's ID, `jobs/rollback` pauses `rolled_back` and marks the run log entry, and finalization repeats both. Evidence: Task 3 ("jobs/cancel pauses the job's schedule; jobs/resume hands a finalized scheduled job back to the pump", "jobs/rollback of a scheduled job pauses its schedule and marks its run rolled back"), Task 5 ("finalizes a job as cancelled", "repeats a rollback's pause and marks the run rolled back"), Task 8 step 3.
2. **Overlapping ticks create one job.** On Node a hook that schedules or cancels a task starts a second tick while the first runs (spec F19, Fact V6). Expected: two launches of one due schedule at once create one job; a launch whose claim was replaced writes nothing. Evidence: Task 4 ("creates one job from two overlapping launches of one due schedule", "writes nothing once the claim changed under it"), plan Ruling 20.
3. **Scheduled writes are unattributed whoever drives the batch, and every edit lock is foreign.** An Admin's `jobs/next` on a scheduled job must not attribute part of an unattended import to that Admin (spec Ruling 5), and the sentinel user `""` must skip every leased entry. Expected: the batch's content port is built with `null`, the media port with no author, and the lock reader gets `""`. Evidence: Task 1 ("runs a scheduled job's batch through jobs/next with no actor and no media author", "writes without an actor: no actor or authorId, and the lock reader gets NO_USER", "compares with the sentinel user, which owns no lease"), Task 8 steps 1 and 7 (no author on entries or revisions after a `jobs/next` batch).
4. **Retention never purges a scheduled job before it is finalized, and stays bounded.** A purge of an open job would lose the run before its log entry, and an unbounded run breaks the tick (spec Ruling 39). Expected: an open scheduled job and a job a schedule's `current` names survive whatever their status and age; a run stops at its budget and resumes from its cursor. Evidence: Task 6 ("never purges an open scheduled job or one a launch claim names, whatever its status", "stops before a job it cannot finish within the budget, saves it as the cursor, and the next run finishes", "skips its deletes when the scan passes RETENTION_SCAN_MAX rows").
5. **An empty feed removes nothing, even at a 100 % threshold.** A feed that answers a header only would otherwise make every owned entry missing (spec Ruling 45). Expected: the job completes with `missing.verdict: "skipped"` and no removal, and the schedule pauses `empty_feed`. Evidence: Task 5 ("removes nothing on an empty feed at a 100 % threshold, and pauses empty_feed"), Task 8 step 4.

---

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0, `@emdash-cms/cloudflare` 1.2.0 and local workerd; tasks cite them by number. V1-V11 are the facts the spec left unconfirmed.

How V1-V11 were proven:
- A temporary `src/plugin/zz-probe.ts` added probe routes (`probe/cron`, `probe/due`, `probe/tasks`, `probe/d1`, `probe/fence`, `probe/users`, `probe/v3`, `probe/job-patch`, `probe/schedule-put`, …) and probe cron tasks dispatched from the cron hook (context and user checks, due marks, a pump emulating the spec's steps over the real engine, a bounded retention emulation, overlap and timeout probes). `definition.ts` declared the spec's storage, indexes and `users:read`; the content and media ports took a `null` actor through a temporary services builder. `probe/d1` patched the D1 binding's `prepare` to count statements between a start and a stop call (M5a's `countD1`).
- Node: `sites/dev` on port 4479 with its own SQLite file under `.superpowers/wt/scratch-m6b-plan/node-site/`, ticks run in a request through `POST /test/run-scheduled`. Workerd: `sites/dev-cf` on port 4478 with fresh local D1, ticks run as real scheduled events through `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*`, D1 read with `wrangler d1 execute DB --local`. Both used a temporary `POST /test/stop-cron-timer` in each test site.
- Every probe file was removed afterwards, `sites/dev/data.db*` matched their backup checksums (`sites/dev` had no uploads directory), `sites/dev-cf/.wrangler` was restored from its backup, and both `emdash-env.d.ts` files were restored. `git status` was clean and no token was in any scratch file.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Holds on both runtimes.** A plugin cron hook run by EmDash's Node timer and by a real `scheduled()` event on workerd got `ctx.storage`, `ctx.settings`, `ctx.taxonomies`, `ctx.bylines`, `ctx.cron` and, with `users:read` declared, `ctx.users`; `withRuntime` worked inside it | Probe task `probe-ctx`; Tasks 1, 7 |
| V2 | **Not provable locally** (spec F10). The D1 count of whole scheduled events is V5; the production check stays an Open issue | — |
| V3 | **Holds on both runtimes.** With no actor: `handleContentCreate`, `Update`, `Publish` (also with `origin: { source: "plugin", pluginId: "flux-import" }`), `Unpublish`, `Schedule`, `Unschedule`, a draft update, `DiscardDraft`, `Delete` (trash), `Restore` and `handleMediaUpload` succeeded. The entry's `author_id`, all three of its `revisions.author_id` and the media item's `author_id` were `NULL` (read with SQLite and `wrangler d1 execute`). `isEntryLocked(db, c, id, "")` was true for an Admin's live lock and false with the Admin's own ID | Probe route `probe/v3`; Task 1 |
| V4 | **Holds on both runtimes.** The fence query (spec F14) answered clear on a fresh site; import for an import row `running`, `verifying`, `failed` with `mutation_started_at` set and `cancelled` with it set; clear for a `cancelled` row without it; export for a running export; media for an `activating` row; with the transfer table dropped, clear, and media while activating | Probe route `probe/fence`; Task 5 |
| V5 | **Holds; the tick caps stay as the spec projects them.** Queries per scheduled event on local D1, the counter's own calls and the probe's KV log writes subtracted; EmDash's tick overhead (claim, finish updates, stale-lock recovery, publishing sweep, heartbeat) included. See the table below. Every pump batch at the tick caps stayed at or under 506 (≤ `PUMP_QUERY_TARGET` 550) and the worst tick measured 695 (< 900). The worst tick has 8 due marks, not the spec's nine: a tick claims at most 10 tasks (spec F4), and 9 + pump + retention is 11 | Probe tasks; Tasks 5, 6, 10 |
| V6 | **Holds, with one correction (Fact E1).** `list()` after `schedule()` gave `nextRunAt` 2026-11-18T00:00Z for `@daily` and 12:00Z for `0 */6 * * *` (at 10:5x Z). A task re-scheduled from its own hook kept the new expression and got its next run from the old one; `cancel()` in its own hook deleted it. On Node a `schedule()` inside a hook started a second tick while the first ran (second hook start 43.76 s, between the first's 42.75 s and 47.77 s). Disabling the plugin set `enabled = 0` on every task and ticks ran nothing; enabling re-enabled them and an overdue task ran once (both runtimes) | Probe tasks `probe-resched`, `probe-cancel`, `probe-inner`/`probe-second`, `probe-overdue`; Tasks 2, 4 |
| V7 | **Holds on Node; on workerd the handler is abandoned.** Node: a 10 s hook timeout logged `[cron] Hook failed … Hook timeout after 10000ms`, the next task's hook started at the timeout and the timed-out handler still logged its end. Workerd: the next task started at the timeout, the scheduled event's HTTP response returned after the tick, and the timed-out handler never logged its end (the invocation ended). Spec F5 is amended for workerd (Task 10) | Probe tasks `probe-sleep`/`probe-after`; Task 7 |
| V8 | **Holds on both runtimes.** `jobs/create { sourceId, templateId, templateRevision: 1 }` on a template at revision 2 answered `TEMPLATE_CHANGED` and the source got no `lastFetch` or `lastError` (no fetch); the same at revision 2 reached the fetch (`FETCH_FAILED` on a closed port) | Probe; Task 4 |
| V9 | **Holds on both runtimes.** After `POST /test/stop-cron-timer` (`withEmDashRuntime((r) => r.stopCron())`), no tick ran without a call (a probe task due every 10 s stayed at its count for 32 s on Node, and on workerd), and a `schedule()` call did not restart the timer; each `POST /test/run-scheduled` (Node) and each `GET /cdn-cgi/handler/scheduled` (workerd) ran exactly one tick, and an event with nothing due ran nothing. On workerd a fresh isolate's timer did not tick at all in 60 s before the stop (spec F16's "the timer also ticks" was not reproduced); the parity test stops it anyway | Probe; Tasks 8, 9 |
| V10 | **Holds; F7, F8 and F22 unchanged.** The installed `@emdash-cms/cloudflare@1.2.0` `src/worker.ts:80-120` takes only `generalCron`, runs `runScheduledTasks({ onPublished, invalidateContentCache })` in one `ctx.waitUntil`, and exports `PluginBridge` only; neither package's `src/` has `publishUpcomingWithinMs` or `EmDashRoom`, while the docs page ("Scheduled publishing", "Add the Worker entry point") describes both. `virtual-modules.ts` gives `astro dev` the Node timer under the Cloudflare adapter | Source and the `emdash-docs` MCP server, 2026-11-17 |
| V11 | **Holds on both runtimes.** `ctx.users.get(id)` in a cron hook: an existing Admin gave role 50; a deleted user `null`; a disabled user role 50 (the flag is invisible); a user demoted to Editor 40. One D1 query (a task with the read and a KV log write ran 17 queries, a task that did nothing 15) | Probe task `probe-users`; Task 4 |
| E1 | **EmDash's `schedule()` takes typos as one-shots.** Accepted as one-shot runs in the past: `every day at 3` (2001), `61 * * * *` (1960/1961), `0 3 * * 8` (2000), `*/0 * * * *` (1999); accepted as cron: the 6-field `0 3 * * * *`, `0 3 * * 7`, `0-7`, `JAN-MAR MON`, `5-10/2`, `sun`, `1,15`, `MON-FRI`, `L`, `?`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@midnight`. Refused with `` Invalid schedule "<x>": must be a valid cron expression or ISO 8601 datetime ``: `@reboot`, `not a cron`, `* * * *`, `0 24 * * *`, `0 3 32 * *`, `0 0 1 1 1/2`; the empty string with "must be 1-256 characters, got 0"; `0 3 31 2 *` with `` Invalid cron expression or no future run: "0 3 31 2 *" ``. So spec F2's "an invalid schedule makes `schedule()` throw" holds only for some typos, and flux-import must check each field's values and ranges itself (plan Ruling 3) | Probe route `probe/cron`, both runtimes; Task 2 |
| E2 | **The empty-feed skip already exists for every job.** `enterMissing` skips the phase with "Missing entries were not checked: the import read no record with a key" when the first pass read no keyed record (`src/engine/missing.ts:132-138`, tested in `tests/unit/missing.test.ts:113`). Spec Ruling 45's engine change is therefore not needed; finalization detects the empty feed (plan Ruling 8) | Source; Task 5 |
| E3 | **`runBatch` returns the stored job, unchanged, when its claim is refused** (`src/engine/batch.ts:2118-2120`), so a held lease and a status change are indistinguishable from the returned row alone (plan Ruling 4) | Source; Task 5 |
| E4 | **A boolean `where` value is bound as it is.** EmDash compares `json_extract(…)` as text with a boolean parameter for a boolean value (`src/plugins/storage-query.ts:209-212`), which no flux-import query does today and which PostgreSQL's strict types refuse; it was not exercised on SQLite or D1 while drafting (plan Ruling 2) | Source; Tasks 1, 2 |
| E5 | **`jobs` queries may filter on any field of any index** (`getIndexedFields`, `src/plugins/storage-query.ts:96-108`), so `{ scheduled: "open" }` alone is a valid query on the `["scheduled", "status", "createdAt"]` index | Source; Tasks 2, 5 |
| E6 | **`tests/unit/schedule.test.ts` exists** (M5b: scheduling entries' publication). New files avoid the name | Repository |
| E7 | **The integration helpers have no 500 feed and no user ID for a token.** `FeedServer` answers 404 for a path it does not serve, which the fetcher reports as `HTTP_ERROR` (a transient launch failure); `createUserToken` returns only the raw token, so a test finds its user through the schedule's `armedBy` | `tests/integration/feed-server.ts`, `tests/integration/db.ts:55-64`; Task 8 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 1.3-5.4 s (Task 0 saw tick durations of -1,197 and -1,351 ms); `crash.test.ts` can then fail its precondition, and a polling wait sees a step backwards. Re-running settles it | M3c-M6b |
| F2 | The one-off workerd `500 INTERNAL_ERROR` "Plugin route error" of M4d: if Task 9 or 10 sees it, capture the server log and record it | M4d-M6c reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4392` and `:4397` (WSL mirrored networking). If a suite fails in setup with "Port … is in use", check `ss -ltnp` and re-run | M5c-M6c reviews |

V5's measurements (workerd, local D1, 2026-11-17; "queries" as described in V5; wall time of the event):

| Scheduled event | D1 queries | Wall time |
| --- | --- | --- |
| Quiet tick, first after start / later | 77 / 10 | 153 / 30 ms |
| One probe task that does nothing | 11 | 31 ms |
| One due mark / nine due marks | 14 / 46 | 38 / 116 ms |
| Pump idle, self-cancel | 18 | 53 ms |
| Pump, finalization only (two jobs, one failed, `clearLastImport`) | 28 | 68 ms |
| Pump launch: unchanged content / a plain job / a plain update job / a linked job | 31 / 36 / 38 / 43 | 94 / 106 / 114 / 109 ms |
| Pump batch, 6 plain creates on a fresh collection (with `ensureSourceIdField`) / next ones | 448 / 426 | 928 / 869 ms |
| Pump batch, 6 plain published updates | 503-505 | 1,007-1,066 ms |
| Pump batch, 3 linked updates (title and category changed) | 491-506 | 939-974 ms |
| Pump batch, missing phase: count stage (20) / act stage (5 trashes) | 47-94 / 178-181 | 115-189 / 344-374 ms |
| Retention: 1,000-row scan, deletes to its budget (15 jobs) | 162 | 361 ms |
| **Worst:** 8 due marks + pump (2 finalizations + 3 linked updates with every link kind changing: reference, `slug` references, two taxonomies, bylines) + retention over 937-1,000 rows | **695** | 1,335 ms |
| The same with a title-and-category linked batch | 566-567 | 1,125 ms |

## Rulings this plan makes

1. **`POST /test/stop-cron-timer` lives in the test sites, never in the plugin.** Each test site gets `src/pages/test/stop-cron-timer.ts` (Task 8 for `sites/dev`, Task 9 for `sites/dev-cf`), built like the existing `run-scheduled.ts`: `export const prerender = false`, 403 unless `import.meta.env.DEV`, 403 without `X-EmDash-Request: 1`, then `withEmDashRuntime((runtime) => runtime.stopCron())`. Why there: plugin routes ship in every site that installs flux-import, so a plugin route, even one that answers 403 in production, would put a scheduler-stopping capability in the package and depend on the host's build flags; the test sites are not part of the package (`package.json` `exports` names only `src/`), are never deployed, and already hold the same kind of dev-only route. A production build of a test site answers 403 because `import.meta.env.DEV` is false at build time, as `run-scheduled.ts` does since M5b.
2. **The busy check filters dry runs in code, not in the query** (Fact E4; amends the spec's `["feedSourceId", "dryRun", "status"]` index). The index is `["feedSourceId", "status"]`; `busyJob` pages `{ feedSourceId, status: { in: ["created", "running", "paused"] } }` 20 at a time and returns the first job that is not a dry run. Unfinished dry runs on one source are few (M6c keeps an abandoned agent dry run), so the paging costs one query in practice.
3. **flux-import checks each cron field itself** (Fact E1; refines spec Ruling 7). `cronProblem` accepts five fields of comma-separated items, each `*`, `*/n`, `a`, `a-b` or `a-b/n`, with numbers in the field's range (minute 0-59, hour 0-23, day of month 1-31, month 1-12, day of week 0-7) and three-letter names only in month and day of week, steps from 1 to the field's maximum and only after `*` or a range, `a ≤ b`; or one of the five aliases; at most 256 characters, no leading or trailing space. EmDash's own refusal stays reachable (`0 3 31 2 *`) and answers `INVALID_CRON` with EmDash's message.
4. **The pump's held-lease test reads the lease from its own query** (Fact E3). The oldest open job whose `lease` is live (`expiresAt > now`) is no batch, and the launch may run; any other job gets `nextBatch`, which counts as the tick's unit even if a lease appeared in between (the claim then refuses and the tick is spent, which is safe).
5. **`schedules/update` schedules the task before it writes the row.** When the update ends enabled with a new expression or enables the schedule, `schedule()` runs first, so EmDash's refusal answers `INVALID_CRON` with no row change. If the row write then fails, the task is re-synchronised from the newest row (best effort; reconciliation repairs the rest). `schedules/create` follows the spec (write, schedule, delete the row on refusal).
6. **A disabled schedule is never due.** A pause, `enabled: false` and a disabled schedule's due mark task all drop `due`; the pump, the idle check and reconciliation consider only rows with `enabled && due`. Otherwise a mark on a disabled row would keep the pump alive forever.
7. **A launch in flight makes a schedule busy for the routes.** `schedules/delete`, `schedules/run` and a template or source change in `schedules/update` answer `SCHEDULE_BUSY` with `details.jobId` set to the claimed ID while `current` is younger than `LAUNCH_CLAIM_STALE_MS`, as for an open job; `schedules/run` adds the busy check of spec Ruling 33.
8. **Spec Ruling 45 needs no engine change** (Fact E2). Finalization reads an empty feed as `(job.missing?.fromSeq ?? job.cursor.seq) === 0` on a completed job, checked before the refused verdict; Task 5 pins the engine's skip for a scheduled job at a 100 % threshold.
9. **`createJobFrom` and the services move to `src/plugin/services.ts`**, taking a `PluginContext`, so the launch can create a job from a cron hook without importing `routes.ts`; `ensureRetentionScheduled` moves to `retention.ts` with its test, so `services.ts` does not import `routes.ts` either.
10. **`jobs/next` reads the job before choosing its services** (spec Ruling 5): one `get` more per call, so a scheduled job's batch is built with `buildServices(ctx, runtime, null)` whoever calls. `jobs/step` is unchanged: it refuses every non-agent job before any batch.
11. **A resumed or retried scheduled job that was already finalized is reopened** (spec Ruling 38). `jobs/resume` and `jobs/retry` set `scheduled: "open"` again on a closed scheduled job and arm `pump`. Finalization then replaces the job's run log entry when its outcome changed and writes nothing when the same entry is there (a crash between the schedule write and the close).
12. **Finalization repeats a rollback's pause too.** A finished job with `rolledBackBy` pauses its schedule `rolled_back` and its run log entry carries `rolledBack: { by, at }`, so a lost best-effort write in `jobs/rollback` is repaired, as the spec does for a cancel. The repair works only when the rollback comes before finalization (preflight F20): a rollback of a job already finalized is not seen again by the pump, so its pause rests on `jobs/rollback`'s own write. Like a cancel's, the repeated pause is skipped once a route has changed the schedule after the job (preflight F10), and it never replaces a pause already on the schedule.
13. **"Has a key" is the template's shape check.** `templateSchema` requires `key` (`src/engine/template.ts:335`), and a key may be an expression rather than `from`, so `templateForSave` covers spec "Behaviour" step 3's key check with no extra code.
14. **`sources/update` returns `warnings` only when there are some.** Its response stays the source row, with `warnings: string[]` added when a schedule pins the source with another fingerprint, so REST callers see no change otherwise (M6c Ruling 56's constraint).
15. **The schedule inputs are strict.** A misspelt key is refused (`VALIDATION_ERROR`) instead of ignored, as M6c's new inputs; the existing routes' inputs are unchanged.
16. **Retention counts one unit per storage call against `RETENTION_QUERY_TARGET`.** Scan pages, the schedules read, each `getVersioned`, `get`, `compareAndSet`, `query`, `deleteMany` and `delete` count 1. A job's purge starts only with `RETENTION_PRUNE_MIN` (10) units left; a purge cut short by the budget leaves the job marked purging, which the next run finishes. When a run stops for the budget it saves the ID of the next candidate under `RETENTION_CURSOR_KEY` and the next run starts there; a run that reached every candidate deletes the key.
17. **The cron hook's dispatch lives in `src/plugin/scheduler.ts`**, and `plugin:activate` runs `reconcile` (which also schedules `retention`) instead of `ensureRetentionScheduled`, so re-enabling the plugin also repairs the schedule tasks (spec "Reconciliation").
18. **The integration tests drive ticks deterministically after the acceptance.** The Node test's first step relies on EmDash's real timer (the acceptance: "with no further call"); then it stops the timer (`POST /test/stop-cron-timer`) and drives each tick by moving the named tasks' `next_run_at` into the past with `withDb` and calling `POST /test/run-scheduled`, one tick per call (Fact V9). The workerd test stops the timer first and drives every tick with `GET /cdn-cgi/handler/scheduled` after moving `next_run_at` with `wrangler d1 execute`.
19. **The creator check compares the role with `Permissions["import:execute"]`** from `@emdash-cms/auth` (spec F20), the level `hasPermission` uses, without converting the stored role to `RoleLevel` (whose `toRoleLevel` throws on an unknown level).
20. **A launch replaces a claim whose job has finished** (refines spec "Launch" step 2). A claim younger than `LAUNCH_CLAIM_STALE_MS` with no job under its ID, or a claim whose job is unfinished, is a launch in flight, and the launch stops without clearing `due`; a stale claim with no job, or one whose job has finished (a launch that crashed after creating the job and before recording it, whose job the pump then drove and finalized), is replaced. Without this a crashed launch's claim would hold the schedule until it went stale even after its job finished; with the unfinished check, two overlapping launches still create one job (spec F19).

## Verification while drafting

| Check | Result |
| --- | --- |
| Task 0 (V1-V11) | V1, V3, V4, V6, V8-V11 hold on Node and workerd; V5 holds (worst tick 695 < 900; every pump batch ≤ 506 ≤ 550); V7 holds on Node, and on workerd the timed-out handler is abandoned; V2 is not provable locally. No V3, V5 or V9 failure, so no stop |
| Tree after Task 0 | `git status` clean; `sites/dev/data.db*` identical to the backup; `sites/dev-cf/.wrangler` restored; both `emdash-env.d.ts` restored; no `ec_pat_` in any scratch file |
| Code in Tasks 1-9 | written against `6e21a18`; not applied or run while drafting (see "Spec" above) |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/{types,jobs,rollback}.ts`, `src/emdash/{content,media}.ts`, `src/plugin/services.ts` (new), `src/plugin/{routes,job-templates,agent,summaries,retention,definition}.ts`, `src/meta.ts` | The job fields, the services split, the unattributed ports, storage, capability and version (Task 1) |
| `src/plugin/cron-syntax.ts` (new), `src/plugin/schedules.ts` (new), `tests/unit/schedule-fakes.ts` (new) | The grammar and the schedule service (Task 2) |
| `src/plugin/routes.ts` | The schedule routes and the changes to existing routes (Task 3) |
| `src/plugin/launch.ts` (new) | Due marks and launches (Task 4) |
| `src/emdash/fence.ts` (new), `src/plugin/pump.ts` (new), `src/plugin/service.ts` | The fence read, the pump, the tick caps (Task 5) |
| `src/plugin/retention.ts` | The bounded hourly purge (Task 6) |
| `src/plugin/scheduler.ts` (new), `src/plugin/definition.ts`, `tests/integration/schedules-client.ts` (new) | The hook's dispatch and timeout; the integration helper (Task 7) |
| `tests/integration/schedules.test.ts` (new), `sites/dev/src/pages/test/stop-cron-timer.ts` (new) | Node proof (Task 8) |
| `tests/integration-cf/parity.test.ts`, `sites/dev-cf/src/pages/test/stop-cron-timer.ts` (new) | Workerd proof (Task 9) |
| `docs/superpowers/notes/2026-11-17-m6b-review.md` (new), the spec, the roadmap | The review (Task 10) |

`src/engine/batch.ts`, `src/engine/missing.ts`, `src/plugin/sources.ts`, `src/plugin/templates.ts` and `src/plugin/mcp.ts` do not change: the engine already skips an empty feed's missing phase (Fact E2), the routes add the in-use checks and warnings around the unchanged services, and no tool changes (spec Ruling 50).

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V11 | — | nothing (results above) | — |
| 1. Groundwork | — | `src/engine/{types,jobs,rollback}.ts`, `src/emdash/{content,media}.ts`, `src/plugin/{services,routes,job-templates,agent,summaries,retention,definition}.ts`, `src/meta.ts`, `tests/unit/{content,media-port,locks,jobs,rollback-jobs,agent,definition,retention,scheduled-actor}.test.ts` | opus |
| 2. Schedule service | 1 (`Job.scheduled`, `Job.feedSourceId`, `STORAGE.schedules`, `RETENTION_SCHEDULE` in `retention.ts`) | `src/plugin/{cron-syntax,schedules}.ts`, `tests/unit/{cron-syntax,schedules}.test.ts`, `tests/unit/schedule-fakes.ts` | opus |
| 3. Routes | 1 (`RouteServices`), 2 (`createSchedule`, `updateSchedule`, `deleteSchedule`, `runSchedule`, `listSchedules`, `reconcile`, `schedulesUsing`, `inUse`, `templateWarnings`, `sourceWarnings`, `pauseSchedule`, `withRollback`, `reopenScheduled`, `schedulesCollection`, `cronOf`) | `src/plugin/routes.ts`, `tests/unit/{schedule-routes,definition}.test.ts` | opus |
| 4. Launch | 1 (`createJobFrom`, `Services`), 2 (`writeSchedule`, `paused`, `busyJob`, `sourcePinOf`, `LAUNCH_CLAIM_STALE_MS`, `schedule-fakes.ts`) | `src/plugin/launch.ts`, `tests/unit/launch.test.ts` | opus |
| 6. Retention | 2 (`ScheduleRow`) | `src/plugin/retention.ts`, `tests/unit/retention.test.ts`, `tests/integration/retention.test.ts` | sonnet |
| 5. Pump | 4 (`launch`, `LaunchDeps`, `launchDeps`) | `src/emdash/fence.ts`, `src/plugin/{pump,service}.ts`, `tests/unit/{fence,pump,service}.test.ts` | opus |
| 7. Wiring | 3, 5 (`pumpTick`, `pumpDeps`), 6 (`purgeExpired`'s new deps) | `src/plugin/{scheduler,definition}.ts`, `tests/unit/{scheduler,definition}.test.ts`, `tests/integration/schedules-client.ts` | sonnet |
| 8. Node integration | 7 | `tests/integration/schedules.test.ts`, `sites/dev/src/pages/test/stop-cron-timer.ts` | sonnet |
| 9. Workerd parity | 7 | `tests/integration-cf/parity.test.ts`, `sites/dev-cf/src/pages/test/stop-cron-timer.ts` | sonnet |
| 10. Review run and note | 0-9 | the note, the spec, the roadmap; temporarily a D1 counter (removed) | opus |

The waves:
1. **1**
2. **2**
3. **3 ∥ 4 ∥ 6.** No file is shared: Task 3 only reads `schedules.ts`, Task 4 adds `launch.ts`, Task 6 only changes `retention.ts` and its tests (it imports `ScheduleRow` as a type). Each imports `schedule-fakes.ts` without changing it.
4. **5** (needs Task 4's `launch.ts`; may start as soon as Task 4 is merged, beside 3 and 6).
5. **7**
6. **8 ∥ 9.** Separate harnesses (ports 4390 and 4396), separate sites and files; both import Task 7's `schedules-client.ts` and change neither it nor any `src/` file.
7. **10**

Files touched by more than one task, merged in numeric order: `src/plugin/routes.ts` (Tasks 1, 3), `src/plugin/retention.ts` (Tasks 1, 6), `src/plugin/definition.ts` (Tasks 1, 7), `tests/unit/definition.test.ts` (Tasks 1, 3, 7), `tests/unit/retention.test.ts` (Tasks 1, 6). None of them is touched by two tasks of one wave.

---

### Task 0: Verify the unconfirmed facts (V1-V11)

**Files:** none.

**Interfaces:**
- Consumes: EmDash's cron API, scheduler and scheduled handler (spec F1-F22) through temporary probes; the M5a D1 counter.
- Produces: Facts V1-V11 and E1-E7, and plan Rulings 1-4, 8 and 19 (above). The Task 10 note records the results from the Facts table.

- [x] **V1**: the cron hook's context in a real `scheduled()` event and on Node. Passed.
- [x] **V2**: not provable locally; recorded through V5.
- [x] **V3**: writes without an actor, and the lock sentinel. Passed (the gate of the spec's "If V3, V5 or V9 … fail").
- [x] **V4**: the fence read. Passed.
- [x] **V5**: tick budgets. Passed: worst 695 < 900, every pump batch ≤ 550; caps unchanged.
- [x] **V6**: cron behaviour. Passed, with Fact E1 (plan Ruling 3).
- [x] **V7**: the hook timeout. Passed on Node; on workerd the handler is abandoned (Task 10 amends F5).
- [x] **V8**: a pinned-revision launch fetches nothing. Passed.
- [x] **V9**: the timer stop and one tick per call. Passed on both runtimes.
- [x] **V10**: F7, F8 and F22 unchanged.
- [x] **V11**: the creator check. Passed.

### Task 1: Job fields, the services split, unattributed writes, storage, capability and version

**Files:**
- Create: `packages/flux-import/src/plugin/services.ts`, `packages/flux-import/tests/unit/scheduled-actor.test.ts`
- Modify: `packages/flux-import/src/engine/types.ts` (`Job`), `src/engine/jobs.ts` (`CreateJobInput`, `createJob`), `src/engine/rollback.ts` (`createRollback`), `src/emdash/content.ts`, `src/emdash/media.ts`, `src/plugin/routes.ts`, `src/plugin/job-templates.ts` (`JobRequest`), `src/plugin/agent.ts` (`realRequest`), `src/plugin/summaries.ts` (`JobSummary.origin`), `src/plugin/retention.ts` (`ensureRetentionScheduled` moves in), `src/plugin/definition.ts`, `src/meta.ts`
- Test: `tests/unit/{content,media-port,locks,jobs,rollback-jobs,agent,definition,retention}.test.ts`

**Interfaces:**
- Consumes: `ActorInfo`, `PluginContext` (`emdash`); `isEntryLocked` (`src/emdash/locks.ts:12-48`); the request flow of `createJobFrom` (`src/plugin/routes.ts:536-611`).
- Produces:
  - `Job.origin?: "agent" | "schedule"`, `Job.scheduleId?: string`, `Job.scheduled?: "open" | "closed"`, `Job.feedSourceId?: string`; the same on `CreateJobInput` (`scheduled` only `"open"`) and `JobRequest`;
  - `content.ts`: `NO_USER` (`""`); `new EmDashContent(runtime, actor: ActorInfo | null, lockReader)`; `media.ts`: `new EmDashMedia(runtime, authorId: string | null, maxUploadSize)`;
  - `services.ts`: `interface Services { deps; uploads; storage; runtime; actor: ActorInfo | null; sources; keep; xlsx }`, `buildServices(ctx: PluginContext, runtime: EmDashRuntime, actor: ActorInfo | null): Services`, `withScheduledServices<T>(ctx: PluginContext, run: (s: Services) => Promise<T>): Promise<T>`, `createJobFrom(ctx: PluginContext, services: Services, request: JobRequest, given?: ResolvedTemplate): Promise<Job | SkippedJob>`;
  - `retention.ts`: `ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">)` (moved, unchanged);
  - `STORAGE.schedules`, the two `jobs` indexes, `users:read`, `FLUX_IMPORT_VERSION` `0.4.0`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/scheduled-actor.test.ts`:
````ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmDashUploads } from "../../src/emdash/uploads.js";
import { createJob, type CreateJobInput } from "../../src/engine/jobs.js";
import type { EngineDeps, Job } from "../../src/engine/types.js";
import { createPlugin } from "../../src/plugin/definition.js";
import { stagePaste } from "../../src/plugin/service.js";
import { withScheduledServices } from "../../src/plugin/services.js";
import { FakeStorage, MemoryKv, makeDeps } from "./fakes.js";

// As agent-routes.test.ts: the runtime and plugin storage are the engine's fakes. The port
// constructors record whom they were built for (spec Rulings 4, 5).
const state = vi.hoisted(() => ({
	deps: undefined as unknown,
	storage: undefined as unknown,
	actors: [] as unknown[],
	authors: [] as unknown[],
}));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({ storage: state.storage, config: { maxUploadSize: 1000 }, db: {}, schemaRegistry: {} }),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/content.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/content.js")>()),
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashContent: function (_runtime: unknown, actor: unknown) {
		state.actors.push(actor);
		return (state.deps as Record<string, unknown>).content;
	},
}));
vi.mock("../../src/emdash/lookups.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashLookups: function () {
		return (state.deps as Record<string, unknown>).lookups;
	},
}));
vi.mock("../../src/emdash/media.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the services call it with new
	EmDashMedia: function (_runtime: unknown, authorId: unknown) {
		state.authors.push(authorId);
		return (state.deps as Record<string, unknown>).media;
	},
}));

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];
const ADMIN = { id: "admin", role: 50, source: "api" };
const plugin = createPlugin();
let engine: EngineDeps;

beforeEach(() => {
	const storage = new FakeStorage();
	state.storage = storage;
	// The services read staged files through EmDashUploads; the job is created over the same copy.
	engine = { ...makeDeps().deps, source: new EmDashUploads(storage) };
	state.deps = engine;
	state.actors = [];
	state.authors = [];
});

const pluginContext = () =>
	({
		storage: { sources: new MemoryKv() },
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
	}) as never;

async function job(extra: Partial<CreateJobInput> = {}): Promise<Job> {
	const { uploadId } = await stagePaste(state.storage as FakeStorage, "sku,Name\nA,One\nB,Two\n");
	return createJob(engine, { uploadId, template, schemaFields, ...extra });
}

function next(id: string): Promise<Job> {
	const route = plugin.routes["jobs/next"]!;
	const ctx = { ...(pluginContext() as object), input: { id }, user: { id: "admin", role: 50 } };
	return route.handler(ctx as never) as Promise<Job>;
}

describe("unattributed scheduled writes (spec Rulings 4, 5)", () => {
	it("runs a scheduled job's batch through jobs/next with no actor and no media author", async () => {
		const scheduled = await job({ origin: "schedule", scheduleId: "S1", scheduled: "open" });
		const done = await next(scheduled.id);
		expect(done.counters.created).toBe(2);
		// The route's own services first (the Admin), then the batch's, with no user.
		expect(state.actors).toEqual([ADMIN, null]);
		expect(state.authors).toEqual(["admin", null]);
	});

	it("runs any other job's batch as the Admin who calls jobs/next", async () => {
		const plain = await job();
		expect((await next(plain.id)).counters.created).toBe(2);
		expect(state.actors).toEqual([ADMIN]);
		expect(state.authors).toEqual(["admin"]);
	});

	it("builds a cron task's services with no actor", async () => {
		const actor = await withScheduledServices(pluginContext(), async (s) => s.actor);
		expect(actor).toBeNull();
		expect(state.actors).toEqual([null]);
		expect(state.authors).toEqual([null]);
	});
});
````

In `packages/flux-import/tests/unit/content.test.ts`, import `NO_USER` with `EmDashContent` and add inside `describe("EmDashContent", …)`:
````ts
	it("writes without an actor: no actor or authorId, and the lock reader gets NO_USER (spec Ruling 5)", async () => {
		const runtime = new FakeRuntime();
		const lockCalls: string[] = [];
		const content = new EmDashContent(runtime, null, async (c, id, user) => {
			lockCalls.push(`${c}/${id}/${user}`);
			return false;
		});
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		await content.update({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-1",
			data: { title: "B" },
		});
		await content.publish({ collection: "products", locale: "en", id: "e1", rev: "rev-2" });
		expect(await content.isLocked("products", "en", "e1")).toBe(false);
		for (const call of runtime.calls) expect(JSON.stringify(call)).not.toMatch(/actor|authorId/);
		expect(NO_USER).toBe("");
		expect(lockCalls).toEqual(["products/e1/", "products/e1/"]);
	});
````

In `tests/unit/media-port.test.ts`, inside `describe("EmDashMedia", …)`:
````ts
	it("uploads without an author when the job has none (spec Ruling 4)", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, null, undefined);
		const bytes = new Uint8Array([1, 2, 3]);
		await media.upload({ filename: "a.png", contentType: "image/png", bytes });
		expect(runtime.uploads).toHaveLength(1);
		expect(runtime.uploads[0]).not.toHaveProperty("authorId");
	});
````

In `tests/unit/locks.test.ts`, import `NO_USER` from `../../src/emdash/content.js` and add inside `describe("foreignLockQuery", …)`:
````ts
	it("compares with the sentinel user, which owns no lease (spec Ruling 5)", () => {
		const { parameters } = foreignLockQuery(dummyDb("sqlite"), "products", "e1", NO_USER).compile();
		expect(parameters).toEqual(["products", "e1", "", 0, 1]);
	});
````

In `tests/unit/jobs.test.ts`, inside `describe("createJob", …)`:
````ts
	it("records a scheduled job's origin, schedule, open state and feed (M6b)", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			sourceId: "S1",
			origin: "schedule",
			scheduleId: "SCH1",
			scheduled: "open",
			feedSourceId: "S1",
		});
		expect(job).toMatchObject({
			origin: "schedule",
			scheduleId: "SCH1",
			scheduled: "open",
			feedSourceId: "S1",
			sourceId: "S1",
		});
		const plain = await createJob(deps, { uploadId: "u1", template, schemaFields });
		for (const key of ["origin", "scheduleId", "scheduled", "feedSourceId"]) {
			expect(key in plain).toBe(false);
		}
	});
````

In `tests/unit/rollback-jobs.test.ts`, inside `describe("jobs/rollback (M5a)", …)`:
````ts
	it("copies the original's feed, and none of its schedule markers (M6b, spec Ruling 33)", async () => {
		const { deps } = setup();
		const original = await importRows(deps, [desk]);
		await patch(deps, original.id, {
			origin: "schedule",
			scheduleId: "SCH1",
			scheduled: "closed",
			feedSourceId: "S1",
		});
		const { rollback } = await createRollback(deps, { id: original.id });
		expect(rollback.feedSourceId).toBe("S1");
		for (const key of ["origin", "scheduleId", "scheduled"]) expect(key in rollback).toBe(false);
	});
````

In `tests/unit/agent.test.ts`, inside `describe("startFromDryRun (M6c)", …)` (next to "runs a completed agent dry run with its upload, template revision and publish"):
````ts
	it("carries a URL-source dry run's source as feedSourceId only (M6b, spec Ruling 33)", async () => {
		const { deps, jobs, requests } = await setup();
		await jobs.put("D1", agentDryRun({ sourceId: "S1" }));
		await startFromDryRun(deps, { dryRunId: "D1" });
		expect(requests[0]).toMatchObject({ feedSourceId: "S1" });
		expect(requests[0]).not.toHaveProperty("sourceId");
	});
````

In `tests/unit/definition.test.ts`:
- the version test becomes `it("sets FLUX_IMPORT_VERSION to 0.4.0", …)` with `expect(FLUX_IMPORT_VERSION).toBe("0.4.0")`;
- in "declares the storage indexes the queries use", the `jobs` expectation becomes
  ````ts
		expect(STORAGE.jobs.indexes).toEqual([
			"status",
			"createdAt",
			"uploadId",
			"sourceUploadId",
			["templateId", "createdAt"],
			["scheduled", "status", "createdAt"],
			["feedSourceId", "status"],
		]);
  ````
  and it gains `expect(STORAGE.schedules.indexes).toEqual(["name", "templateId", "sourceId"]);`;
- in "has the retention setting, the activate hook and the cron hook", the capability list gains `"users:read"` after `"media:write"` (before the two implied read capabilities);
- move the whole `describe("ensureRetentionScheduled", …)` block to the end of `tests/unit/retention.test.ts`, with its imports (`ensureRetentionScheduled`, `RETENTION_SCHEDULE`, `RETENTION_TASK` from `../../src/plugin/retention.js`), and drop `ensureRetentionScheduled` from the `routes.js` import here (`RETENTION_SCHEDULE` and `RETENTION_TASK` stay imported only if another test here uses them; `pnpm lint` says).

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/scheduled-actor.test.ts tests/unit/content.test.ts tests/unit/media-port.test.ts tests/unit/locks.test.ts tests/unit/jobs.test.ts tests/unit/rollback-jobs.test.ts tests/unit/agent.test.ts tests/unit/definition.test.ts tests/unit/retention.test.ts`
Expected: FAIL: `services.js` and `NO_USER` do not exist, `createJob` and `createRollback` drop the new fields, the indexes, capability and version differ, `ensureRetentionScheduled` is not in `retention.js`.

- [ ] **Step 3: The job fields**

In `src/engine/types.ts`, replace the `origin` field of `Job` and its comment with:
````ts
	/**
	 * M6c: the job was created by the agent routes (`jobs/plan`, `jobs/start`), under their rules:
	 * a saved template, no missing phase, always a journal. M6b: `"schedule"`, created by a
	 * schedule's launch (spec Ruling 22). Never inferred from a job's shape, and never copied by a
	 * rollback (M6c spec Ruling 31).
	 */
	origin?: "agent" | "schedule";
	/** M6b: the schedule that launched the job; not copied by a rollback. */
	scheduleId?: string;
	/** M6b: a scheduled job is `"open"` until the pump finalizes it (spec Ruling 38). */
	scheduled?: "open" | "closed";
	/**
	 * M6b (spec Ruling 33): the URL source whose data the job reads, or that a rollback undoes. Set
	 * on every job `jobFromSource` creates, on a real job started from a URL-source dry run (which
	 * has no `sourceId`, M6c Ruling 9), and on a rollback, copied from its original.
	 */
	feedSourceId?: string;
````

In `src/engine/jobs.ts`, in `CreateJobInput` replace `origin?: "agent";` and its comment with:
````ts
	/** M6c: created by the agent routes; M6b: by a schedule's launch (`Job.origin`). */
	origin?: "agent" | "schedule";
	/** M6b: `Job.scheduleId`. */
	scheduleId?: string;
	/** M6b: a scheduled job starts open (`Job.scheduled`). */
	scheduled?: "open";
	/** M6b: `Job.feedSourceId`. */
	feedSourceId?: string;
````
and in `createJob`, after `...(input.dryRunOf === undefined ? {} : { dryRunOf: input.dryRunOf }),`:
````ts
		...(input.scheduleId === undefined ? {} : { scheduleId: input.scheduleId }),
		...(input.scheduled === undefined ? {} : { scheduled: input.scheduled }),
		...(input.feedSourceId === undefined ? {} : { feedSourceId: input.feedSourceId }),
````

In `src/engine/rollback.ts` (`createRollback`), after the `templateRevision` spread:
````ts
		// M6b (spec Ruling 33): a rollback undoes its original's feed, so the schedule stays busy.
		...(original.feedSourceId === undefined ? {} : { feedSourceId: original.feedSourceId }),
````

In `src/plugin/job-templates.ts`, in `JobRequest` replace `origin?: "agent" | undefined;` and its comment with:
````ts
	/** M6c: the agent routes' marker (spec Ruling 31); M6b: a schedule's launch. Never set by `jobs/create`. */
	origin?: "agent" | "schedule" | undefined;
	/** M6b, a launch: the schedule. */
	scheduleId?: string | undefined;
	/** M6b, a launch: the job starts open for the pump. */
	scheduled?: "open" | undefined;
	/** M6b, `jobs/start`: the URL source of the dry run the job imports (no `sourceId`). */
	feedSourceId?: string | undefined;
````

In `src/plugin/summaries.ts`, `JobSummary`'s `origin?: "agent";` becomes `origin?: "agent" | "schedule";`.

In `src/plugin/agent.ts`, `realRequest` becomes:
````ts
function realRequest(
	dryRun: AgentDryRun,
	id: string,
	input: StartInput,
	resolved: ResolvedTemplate,
): JobRequest {
	// M6b (spec Ruling 33): the real job reads the dry run's URL source; a dry run saved before
	// 0.4.0 names it only as `sourceId`. The real job still gets no `sourceId` (M6c Ruling 9).
	const feed = dryRun.feedSourceId ?? dryRun.sourceId;
	return {
		id,
		// The workbook for XLSX: startImport converts it again (spec P7).
		uploadId: dryRun.sourceUploadId ?? dryRun.uploadId,
		templateId: dryRun.templateId,
		dryRun: false,
		...agentOptions(resolved),
		dryRunOf: dryRun.id,
		publish: dryRun.publish,
		batchSize: input.batchSize ?? dryRun.batchSize,
		budgetMs: input.budgetMs ?? dryRun.budgetMs,
		...(feed === undefined ? {} : { feedSourceId: feed }),
	};
}
````

- [ ] **Step 4: The ports without an actor**

In `src/emdash/content.ts`, before `export class EmDashContent`:
````ts
/**
 * The lock reader's user when a write has no actor (spec Ruling 5): no lease belongs to it, so
 * every live lease is foreign and the entry is skipped as locked (Fact V3).
 */
export const NO_USER = "";
````
Change the class comment's first sentence to "`ContentPort` over the EmDash runtime. Writes run as `actor` (revision attribution and hooks only; the author is not changed), or with no user when `actor` is `null`, as EmDash's own unattended writes (spec F12)." The constructor becomes:
````ts
	constructor(
		private readonly runtime: ContentRuntime,
		private readonly actor: ActorInfo | null,
		private readonly lockReader: LockReader,
	) {}

	/** The `actor` option of a write: absent for an unattended write. */
	private get as(): { actor?: ActorInfo } {
		return this.actor === null ? {} : { actor: this.actor };
	}

	/** The user whose own lease does not lock the entry. */
	private get lockUser(): string {
		return this.actor?.id ?? NO_USER;
	}
````
Then, in the class body:
- the four lock reads `this.lockReader(…, this.actor.id)` (in the step method, `isLocked`, `publish` and `schedule`) pass `this.lockUser` instead of `this.actor.id`;
- in `create`, the two lines `authorId: this.actor.id,` and `actor: this.actor,` become `...(this.actor === null ? {} : { authorId: this.actor.id, actor: this.actor }),`;
- the five other `actor: this.actor` become `...this.as` (the step method's `const options = { _rev: rev, ...this.as };` and its update call; `update`'s, `publish`'s and `schedule`'s handler calls).
`grep -n "this.actor" src/emdash/content.ts` then shows only the two getters and `create`.

In `src/emdash/media.ts`, the constructor's `private readonly authorId: string,` becomes `private readonly authorId: string | null,` (comment: "`null`: an unattended upload, with no author (spec Ruling 4)"), and in `upload` the line `authorId: this.authorId,` becomes `...(this.authorId === null ? {} : { authorId: this.authorId }),`.

- [ ] **Step 5: `services.ts`, and `routes.ts` on top of it**

Move `ensureRetentionScheduled` from `src/plugin/routes.ts` to the end of `src/plugin/retention.ts` unchanged, adding `import type { PluginContext } from "emdash";` there.

Create `packages/flux-import/src/plugin/services.ts` from `routes.ts`'s `Services`, `withServices` body and `createJobFrom`, as follows:
````ts
import type { ActorInfo, PluginContext } from "emdash";
import { PluginRouteError, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale, resolveTranslationLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { listSchemaFields, readPublishAtCollection } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import type { EngineDeps, Job } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
import { defaultResolver, type NetOptions } from "../sources/net.js";
import {
	type JobRequest,
	jobTemplateRef,
	type ResolvedTemplate,
	resolveJobTemplate,
} from "./job-templates.js";
import { ensureRetentionScheduled } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import { mediaMaxBytes, type StartJobInput, type UploadKeeper } from "./service.js";
import {
	jobFromSource,
	latestSourceUploads,
	type SkippedJob,
	type SourceDeps,
	sourcesCollection,
} from "./sources.js";
import { templatesCollection } from "./templates.js";
import { fetchLimitsFor, startImport, XLSX_WORKERS_BUFFER, type XlsxStaging } from "./xlsx.js";

export interface Services {
	deps: EngineDeps;
	uploads: EmDashUploads;
	storage: UploadStorage;
	runtime: EmDashRuntime;
	/**
	 * Who the writes are made as: the calling user on a route, nobody in a cron task or for a
	 * scheduled job (spec Rulings 4, 5).
	 */
	actor: ActorInfo | null;
	sources: SourceDeps;
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
	/** Where an XLSX sheet is staged once converted, and its limits. */
	xlsx: XlsxStaging;
}

/**
 * The engine's dependencies over the trusted runtime, for one route call or one cron task (spec
 * "Cron tasks and the hook"). With `actor` null the content and media writes carry no user and
 * the lock reader treats every live lease as foreign (`NO_USER`).
 */
export function buildServices(
	ctx: PluginContext,
	runtime: EmDashRuntime,
	actor: ActorInfo | null,
): Services {
	if (!runtime.storage) {
		throw new PluginRouteError("NOT_CONFIGURED", "EmDash storage is not configured", 500);
	}
	const uploads = new EmDashUploads(runtime.storage);
	const collection = sourcesCollection(ctx.storage);
	const net: NetOptions = {
		resolver: defaultResolver(),
		allowPrivateNetwork: allowPrivateNetwork(),
		// A plain call: workerd rejects fetch() called as a method of another object.
		fetch: (input, init) => fetch(input, init),
	};
	const sources: SourceDeps = {
		sources: collection,
		jobs: pluginCollections(ctx.storage).jobs,
		settings: ctx.settings,
		storage: runtime.storage,
		net,
		limits: { ...FETCH_LIMITS, maxBytes: maxSourceBytes() },
		workers: onWorkers(),
		now: Date.now,
		newId: () => ulid(),
	};
	const keep: UploadKeeper = async (uploadId) =>
		(await latestSourceUploads(collection)).has(uploadId);
	const deps: EngineDeps = {
		...pluginCollections(ctx.storage),
		content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
			isEntryLocked(runtime.db, collection, entryId, userId),
		),
		lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime),
		// Media is fetched without credentials, behind the same SSRF guard as URL sources.
		media: new EmDashMedia(runtime, actor?.id ?? null, runtime.config.maxUploadSize),
		mediaFetcher: createMediaFetcher(net),
		source: uploads,
		now: Date.now,
		newId: () => ulid(),
	};
	const xlsx: XlsxStaging = {
		storage: runtime.storage,
		maxXlsxBytes: maxXlsxBytes(),
		maxSourceBytes: maxSourceBytes(),
		workers: onWorkers(),
		bufferBytes: XLSX_WORKERS_BUFFER,
	};
	return { deps, uploads, storage: runtime.storage, runtime, actor, sources, keep, xlsx };
}

/** A cron task's services: the route services' builder with no actor (spec Ruling 4). */
export function withScheduledServices<T>(
	ctx: PluginContext,
	run: (services: Services) => Promise<T>,
): Promise<T> {
	return withRuntime((runtime) => run(buildServices(ctx, runtime, null)));
}
````
Then append `createJobFrom`, moved from `routes.ts` with its comment, exported, with `ctx: PluginContext` in place of `ctx: RouteContext<unknown>`, and in its `start` closure the line `...(fromSource === undefined ? {} : { sourceId: fromSource }),` replaced by:
````ts
			...(request.scheduleId === undefined ? {} : { scheduleId: request.scheduleId }),
			...(request.scheduled === undefined ? {} : { scheduled: request.scheduled }),
			...(fromSource === undefined ? {} : { sourceId: fromSource }),
			// M6b (spec Ruling 33): the URL source whose data the job reads.
			...(feed === undefined ? {} : { feedSourceId: feed }),
````
with `const feed = fromSource ?? request.feedSourceId;` as the closure's first line. The rest of `createJobFrom` is unchanged.

In `src/plugin/routes.ts`:
- delete `interface Services`, `createJobFrom` and `ensureRetentionScheduled`; import `buildServices`, `createJobFrom` and `type Services` from `./services.js`;
- add, before `templateDeps`:
  ````ts
/** A route's services: the caller is always the actor (`withServices` refuses a call without one). */
type RouteServices = Services & { actor: ActorInfo };
  ````
  and type `templateDeps`'s second parameter and `agentRoute`'s `run` parameter as `RouteServices` (`jobs/step` reads `actor.id`); `agentDeps` keeps `Services`, since it passes them to `createJobFrom`;
- `withServices` becomes:
  ````ts
/** Builds the engine's dependencies for one request and maps service errors to HTTP errors. */
async function withServices<T>(
	ctx: RouteContext<unknown>,
	run: (services: RouteServices) => Promise<T>,
): Promise<T> {
	if (!ctx.user) throw PluginRouteError.unauthorized("Importing requires a signed-in user");
	const actor: ActorInfo = { id: ctx.user.id, role: ctx.user.role, source: "api" };
	return withRuntime(async (runtime) => {
		const services = buildServices(ctx, runtime, actor);
		try {
			return await run({ ...services, actor });
		} catch (e) {
			throw toRouteError(e);
		}
	});
}
  ````
- `"jobs/next"` becomes (plan Ruling 10):
  ````ts
	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, async (services) => {
			// Spec Ruling 5: a scheduled job's writes carry no user, whoever drives its batch.
			const job = await getJob(services.deps, ctx.input.id);
			const { deps, uploads, keep } =
				job.origin === "schedule" ? buildServices(ctx, services.runtime, null) : services;
			// A unique holder per call: two concurrent calls never share a lease.
			const holder = `${services.actor.id}:${ulid()}`;
			return withoutPlannedTerms(await nextBatch(deps, uploads, ctx.input.id, holder, keep));
		}),
	),
  ````
- remove the imports `routes.ts` no longer uses: `allowPrivateNetwork`, `maxSourceBytes`, `maxXlsxBytes`, `EmDashContent`, `isEntryLocked`, `EmDashLookups`, `EmDashMedia`, `readPublishAtCollection`, `pluginCollections`, `needsSiteTimezone`, `EmDashUploads`, `type UploadStorage`, `onWorkers`, `FETCH_LIMITS`, `createMediaFetcher`, `defaultResolver`, `type NetOptions`, `type JobRequest`, `jobTemplateRef`, `type ResolvedTemplate`, `RETENTION_SCHEDULE`, `RETENTION_TASK`, `type EmDashRuntime`, `mediaMaxBytes`, `type StartJobInput`, `type UploadKeeper`, `jobFromSource`, `latestSourceUploads`, `type SkippedJob`, `type SourceDeps`, `sourcesCollection`, `fetchLimitsFor`, `startImport`, `XLSX_WORKERS_BUFFER`, `type XlsxStaging`, and `type PluginContext`. `pnpm lint` reports any left over or any still needed.

In `src/plugin/definition.ts`, import `ensureRetentionScheduled` from `./retention.js` instead of `./routes.js`.

- [ ] **Step 6: Storage, capability and version**

In `src/meta.ts`, `FLUX_IMPORT_VERSION` becomes `"0.4.0"` (spec Ruling 30: a new storage collection, indexes and a capability).

In `src/plugin/definition.ts`, extend the `STORAGE` comment with "`schedules` holds the schedules (M6b): `name` serves the uniqueness check, `templateId` and `sourceId` the in-use checks of `templates/delete` and `sources/delete`; `jobs` `[\"scheduled\", \"status\", \"createdAt\"]` serves the pump's finalization and batch queries, `[\"feedSourceId\", \"status\"]` the busy check (plan Ruling 2)." and make `STORAGE`:
````ts
export const STORAGE = {
	jobs: {
		indexes: [
			"status",
			"createdAt",
			"uploadId",
			"sourceUploadId",
			["templateId", "createdAt"],
			["scheduled", "status", "createdAt"],
			["feedSourceId", "status"],
		],
	},
	templates: { indexes: ["name", "collection", "owner"] },
	records: {
		indexes: [
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
			["jobId", "sourceKey"],
		],
	},
	// M5c: the missing phase pages an owner's links in the template's collection and locale.
	links: { indexes: ["entryId", ["owner", "collection", "locale"]] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
	journal: { indexes: ["jobId", ["jobId", "seq"]] },
	journalMedia: { indexes: ["jobId", ["jobId", "seq"]] },
	schedules: { indexes: ["name", "templateId", "sourceId"] },
} satisfies PluginStorageConfig;
````
Add `"users:read"` as the last entry of `capabilities`, and append to the capabilities comment: "users:read (M6b) gates ctx.users, used for one check only: before each scheduled launch, the user who armed the schedule must still exist and hold import:execute (spec Ruling 43). It cannot see whether a user is disabled (spec F13)."

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/scheduled-actor.test.ts tests/unit/content.test.ts tests/unit/media-port.test.ts tests/unit/locks.test.ts tests/unit/jobs.test.ts tests/unit/rollback-jobs.test.ts tests/unit/agent.test.ts tests/unit/definition.test.ts tests/unit/retention.test.ts tests/unit/agent-routes.test.ts tests/unit/template-routes.test.ts tests/unit/mcp.test.ts`
Expected: PASS (`scheduled-actor.test.ts` 3 tests; one new test in each of the next six files). The consent fixture test in `mcp.test.ts` passes unchanged: no tool changed.

- [ ] **Step 8: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, 89 unit files.
```bash
git add packages/flux-import/src packages/flux-import/tests/unit
git commit -m "Add the scheduled job fields, split the services so cron tasks build them without an actor, and declare the M6b storage, users:read and version 0.4.0"
```

### Task 2: The cron grammar and the schedule service

**Files:**
- Create: `packages/flux-import/src/plugin/cron-syntax.ts`, `packages/flux-import/src/plugin/schedules.ts`, `packages/flux-import/tests/unit/schedule-fakes.ts`
- Test: `packages/flux-import/tests/unit/cron-syntax.test.ts` (new), `packages/flux-import/tests/unit/schedules.test.ts` (new)

**Interfaces:**
- Consumes: `fingerprint` (`src/engine/fingerprints.ts:41`); `templateForSave`, `readSavedTemplate`, `SavedTemplate` (`src/plugin/templates.ts`); `assertRevision`, `templateNotFound` (`src/plugin/template-errors.ts`); `MISSING_MAX_PERCENT_DEFAULT` (`src/engine/types.ts:39`); `RETENTION_SCHEDULE`, `RETENTION_TASK` (`src/plugin/retention.ts`); `page`, `Page`, `ServiceError` (`src/plugin/service.ts`); Task 1's `Job` fields and `STORAGE.schedules`.
- Produces:
  - `cron-syntax.ts`: `CRON_MAX_LENGTH`, `CRON_ALIASES`, `CRON_RULE`, `cronProblem(cron: string): string | null`;
  - `schedules.ts`: the types `ScheduleMissing`, `PauseReason`, `RunEntry`, `ScheduleRow`, `ScheduleView`, `CronPort`, `ScheduleDeps`, `CreateScheduleInput`, `UpdateScheduleInput`; the constants of "Bounds, exactly"; `scheduleTask(id)`, `scheduleIdOf(task)`, `schedulesCollection(storage)`, `cronOf(ctx)`, `armPump(cron)`, `sourcePinOf(source)`, `busyJob(jobs, sourceId)`, `openJobOf(jobs, scheduleId)`, `anyOpenJob(jobs)`, `writeSchedule(schedules, id, expected, change)`, `paused(row, reason, at, jobId?)`, `pauseSchedule(deps, id, reason, jobId, mark?)`, `withRollback(row, jobId, by, at)`, `reopenScheduled(jobs, cron, id)`, `viewOf(row, tasks)`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `runSchedule`, `listSchedules`, `reconcile`, `schedulesUsing`, `inUse`, `templateWarnings`, `sourceWarnings`;
  - `schedule-fakes.ts` (test helpers for Tasks 2-6): `NOW`, `FakeCron`, `PLAIN`, `OWNED`, `savedTemplate`, `sourceRow`, `scheduleRow`, `jobRow`, `scheduleDeps()`.

- [ ] **Step 1: Write the test helpers**

Create `packages/flux-import/tests/unit/schedule-fakes.ts`:
````ts
import type { Job } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import type { CronPort, ScheduleDeps, ScheduleRow } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { MemoryKv } from "./fakes.js";

export const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const AT = new Date(NOW).toISOString();

/** EmDash's cron for one plugin, in memory: names, expressions and data (spec F1, F3). */
export class FakeCron implements CronPort {
	readonly tasks = new Map<string, { schedule: string; data?: Record<string, unknown> }>();
	readonly calls: string[] = [];
	/** The expression `schedule()` refuses, as EmDash refuses a date that never comes (Fact E1). */
	refuse = "0 3 31 2 *";

	async schedule(name: string, opts: { schedule: string; data?: Record<string, unknown> }) {
		this.calls.push(`schedule ${name} ${opts.schedule}`);
		if (opts.schedule === this.refuse) {
			throw new Error(`Invalid cron expression or no future run: "${opts.schedule}"`);
		}
		const task = { schedule: opts.schedule };
		this.tasks.set(name, opts.data === undefined ? task : { ...task, data: opts.data });
	}

	async cancel(name: string) {
		this.calls.push(`cancel ${name}`);
		this.tasks.delete(name);
	}

	async list() {
		return [...this.tasks].map(([name, t]) => ({
			name,
			schedule: t.schedule,
			nextRunAt: "2026-11-18T03:00:00.000Z",
			lastRunAt: null,
		}));
	}
}

export const PLAIN = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
export const OWNED = {
	...PLAIN,
	rules: { owner: "shop", missing: { action: "trash", maxPercent: 10 } },
};

export function savedTemplate(id: string, template: object = PLAIN, revision = 1): SavedTemplate {
	return {
		id,
		name: id,
		template: template as SavedTemplate["template"],
		revision,
		collection: "products",
		locale: "en",
		format: "csv",
		createdAt: "",
		updatedAt: "",
		createdBy: "admin",
		updatedBy: "admin",
	};
}

export function sourceRow(id: string, extra: Partial<SourceRow> = {}): SourceRow {
	return { id, name: id, url: `https://feeds.example/${id}.csv`, createdAt: "", updatedAt: "", ...extra };
}

/** A schedule row as `createSchedule` writes it, on T1 and S1. */
export function scheduleRow(id: string, extra: Partial<ScheduleRow> = {}): ScheduleRow {
	return {
		id,
		name: id,
		templateId: "T1",
		templateRevision: 1,
		sourceId: "S1",
		sourcePin: "pin",
		cron: "0 3 * * *",
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		enabled: true,
		runs: [],
		launchFailures: 0,
		armedBy: "admin",
		revision: 1,
		createdAt: AT,
		updatedAt: AT,
		createdBy: "admin",
		updatedBy: "admin",
		...extra,
	};
}

export function jobRow(id: string, extra: Partial<Job> = {}): Job {
	return {
		id,
		status: "created",
		uploadId: "u1",
		template: PLAIN as unknown as Job["template"],
		dryRun: false,
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		cursor: { offset: 0, seq: 0 },
		counters: { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 },
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		failures: 0,
		createdAt: "2026-11-17T11:00:00.000Z",
		updatedAt: "2026-11-17T11:00:00.000Z",
		...extra,
	};
}

/**
 * The schedule service's dependencies in memory, with the indexes the plugin declares: templates
 * T1 (plain) and T2 (`rules.missing` at 10 %), source S1. `problems` are the site problems every
 * template has while the test sets them.
 */
export async function scheduleDeps() {
	const clock = { t: NOW };
	const problems: string[] = [];
	let ids = 0;
	const deps = {
		schedules: new MemoryKv<ScheduleRow>(STORAGE.schedules.indexes),
		jobs: new MemoryKv<Job>(STORAGE.jobs.indexes),
		templates: new MemoryKv<SavedTemplate>(STORAGE.templates.indexes),
		sources: new MemoryKv<SourceRow>(STORAGE.sources.indexes),
		cron: new FakeCron(),
		templateProblems: async () => [...problems],
		now: () => clock.t,
		newId: () => `SCH${++ids}`,
	} satisfies ScheduleDeps;
	await deps.templates.put("T1", savedTemplate("T1"));
	await deps.templates.put("T2", savedTemplate("T2", OWNED));
	await deps.sources.put("S1", sourceRow("S1"));
	return { deps, clock, problems };
}
````

- [ ] **Step 2: Write the failing tests**

Create `packages/flux-import/tests/unit/cron-syntax.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { cronProblem } from "../../src/plugin/cron-syntax.js";

describe("cronProblem (spec Ruling 7, plan Ruling 3)", () => {
	it.each([
		"0 3 * * *",
		"*/15 * * * *",
		"@hourly",
		"@daily",
		"@weekly",
		"@monthly",
		"@yearly",
		"0 3 * * 7",
		"0 3 * * 0-7",
		"0 0 1 JAN-MAR MON",
		"5-10/2 * * * *",
		"0 3 * * sun",
		"0 0 1,15 * *",
		"0 9 * * MON-FRI",
		// EmDash refuses this one itself (Fact E1); the route answers with its message.
		"0 3 31 2 *",
	])("accepts %s", (cron) => {
		expect(cronProblem(cron)).toBeNull();
	});

	it.each([
		["", "The schedule is empty"],
		[" 0 3 * * *", "The schedule starts or ends with a space"],
		["0 3 * * * *", "Expected 5 fields, found 6"],
		["2026-12-01T03:00:00Z", "Expected 5 fields, found 1"],
		["every day at 3", "Expected 5 fields, found 4"],
		["@reboot", "@reboot is not an accepted alias"],
		["@midnight", "@midnight is not an accepted alias"],
		["61 * * * *", 'minute: "61" is not a value from 0 to 59, a range or a step'],
		["0 24 * * *", 'hour: "24" is not a value from 0 to 23, a range or a step'],
		["0 3 32 * *", 'day of month: "32" is not a value from 1 to 31, a range or a step'],
		["0 3 L * *", 'day of month: "L" is not a value from 1 to 31, a range or a step'],
		["0 3 * * 8", 'day of week: "8" is not a value from 0 to 7, a range or a step'],
		["0 3 * * jan", 'day of week: "jan" is not a value from 0 to 7, a range or a step'],
		["0 3 * * mon-sun", 'day of week: "mon-sun" is not a value from 0 to 7, a range or a step'],
		["*/0 * * * *", 'minute: the step in "*/0" must be from 1 to 59'],
		["0 0 1 1 1/2", 'day of week: a step needs * or a range before it, not "1/2"'],
	])("refuses %j: %s", (cron, problem) => {
		expect(cronProblem(cron)).toBe(problem);
	});

	it("refuses more than 256 characters", () => {
		const cron = `0 3 * * ${"1,".repeat(124)}1`;
		expect(cron).toHaveLength(257);
		expect(cronProblem(cron)).toBe("The schedule is longer than 256 characters");
	});
});
````

Create `packages/flux-import/tests/unit/schedules.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/engine/fingerprints.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "../../src/plugin/retention.js";
import {
	busyJob,
	createSchedule,
	deleteSchedule,
	inUse,
	LAUNCH_CLAIM_STALE_MS,
	listSchedules,
	MAX_SCHEDULES,
	PUMP_SCHEDULE,
	PUMP_TASK,
	pauseSchedule,
	type RunEntry,
	reconcile,
	reopenScheduled,
	runSchedule,
	type ScheduleRow,
	schedulesUsing,
	sourceWarnings,
	templateWarnings,
	updateSchedule,
	withRollback,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	jobRow,
	NOW,
	PLAIN,
	savedTemplate,
	scheduleDeps,
	scheduleRow,
	sourceRow,
} from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();
const base = {
	name: "Nightly",
	templateId: "T1",
	templateRevision: 1,
	sourceId: "S1",
	cron: "0 3 * * *",
};
const pinOf = (url: string) => fingerprint({ url, credential: null });
const zero = { created: 0, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0, removed: 0 };

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof ServiceError) return e.code;
		throw e;
	}
	throw new Error("Expected a ServiceError");
}

describe("createSchedule", () => {
	it("creates an enabled schedule: the row, its pin and creator, and its task", async () => {
		const { deps } = await scheduleDeps();
		const view = await createSchedule(deps, "admin", base);
		expect(view).toMatchObject({
			id: "SCH1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			sourcePin: await pinOf("https://feeds.example/S1.csv"),
			cron: "0 3 * * *",
			publish: true,
			batchSize: 50,
			budgetMs: 4000,
			enabled: true,
			runs: [],
			launchFailures: 0,
			armedBy: "admin",
			revision: 1,
			createdAt: AT,
			createdBy: "admin",
			updatedBy: "admin",
			nextRunAt: "2026-11-18T03:00:00.000Z",
		});
		expect(view).not.toHaveProperty("missing");
		expect(await deps.schedules.get("SCH1")).toMatchObject({ name: "Nightly", revision: 1 });
		expect(deps.cron.tasks.get("schedule-SCH1")).toEqual({
			schedule: "0 3 * * *",
			data: { scheduleId: "SCH1" },
		});
	});

	it("refuses with the first failing check, in the spec's order", async () => {
		const { deps, problems } = await scheduleDeps();
		await deps.schedules.put("X", scheduleRow("X", { name: "Taken" }));
		await deps.templates.put("T3", savedTemplate("T3", PLAIN, 2));
		const broken = {
			name: "Taken",
			templateId: "nope",
			templateRevision: 1,
			sourceId: "nope",
			cron: "61 * * * *",
		};
		const create = (fix: object) => codeOf(createSchedule(deps, "admin", { ...broken, ...fix }));
		expect(await create({})).toBe("NAME_TAKEN");
		expect(await create({ name: "Free" })).toBe("TEMPLATE_NOT_FOUND");
		expect(await create({ name: "Free", templateId: "T3" })).toBe("TEMPLATE_CHANGED");
		problems.push("locale: xx is not a site locale");
		expect(await create({ name: "Free", templateId: "T1" })).toBe("TEMPLATE_PROBLEMS");
		problems.length = 0;
		expect(await create({ name: "Free", templateId: "T1" })).toBe("SOURCE_NOT_FOUND");
		expect(await create({ name: "Free", templateId: "T1", sourceId: "S1" })).toBe("INVALID_CRON");
		const owned = { name: "Free", templateId: "T2", sourceId: "S1", cron: "@daily" };
		expect(await create(owned)).toBe("MISSING_REQUIRED");
		expect((await deps.schedules.query({ limit: 100 })).items.map((i) => i.id)).toEqual(["X"]);
		expect(deps.cron.calls).toEqual([]);
	});

	it("refuses the 21st schedule, and names a template's site problems", async () => {
		const { deps, problems } = await scheduleDeps();
		for (let i = 0; i < MAX_SCHEDULES; i++) await deps.schedules.put(`X${i}`, scheduleRow(`X${i}`));
		expect(await codeOf(createSchedule(deps, "admin", base))).toBe("SCHEDULE_LIMIT");
		await deps.schedules.delete("X0");
		problems.push("collection: products does not exist");
		await expect(createSchedule(deps, "admin", base)).rejects.toMatchObject({
			code: "TEMPLATE_PROBLEMS",
			status: 409,
			details: { problems: ["collection: products does not exist"] },
		});
	});

	it("requires missing for a template with rules.missing, never above its threshold (spec Rulings 12, 13)", async () => {
		const { deps } = await scheduleDeps();
		const owned = { ...base, templateId: "T2" };
		expect(await codeOf(createSchedule(deps, "admin", owned))).toBe("MISSING_REQUIRED");
		const over = { ...owned, missing: { maxPercent: 11 } };
		await expect(createSchedule(deps, "admin", over)).rejects.toMatchObject({
			code: "INVALID_OPTIONS",
			message:
				"missing.maxPercent 11 is over the template's 10; a schedule can lower the threshold, never raise it",
		});
		const plain = { ...base, missing: "template" as const };
		expect(await codeOf(createSchedule(deps, "admin", plain))).toBe("INVALID_OPTIONS");
		const choices = [false, "template", { maxPercent: 10 }] as const;
		for (const [i, missing] of choices.entries()) {
			const view = await createSchedule(deps, "admin", { ...owned, name: `S${i}`, missing });
			expect(view.missing).toEqual(missing);
		}
	});

	it("deletes the row when EmDash refuses the expression, with EmDash's message (Fact E1)", async () => {
		const { deps } = await scheduleDeps();
		await expect(createSchedule(deps, "admin", { ...base, cron: "0 3 31 2 *" })).rejects.toMatchObject({
			code: "INVALID_CRON",
			message: 'Invalid cron expression or no future run: "0 3 31 2 *"',
		});
		expect((await deps.schedules.query({ limit: 100 })).items).toEqual([]);
	});

	it("creates a disabled schedule without a task", async () => {
		const { deps } = await scheduleDeps();
		const view = await createSchedule(deps, "admin", { ...base, enabled: false });
		expect(view).toMatchObject({ enabled: false, nextRunAt: null });
		expect(deps.cron.calls).toEqual([]);
	});
});

describe("updateSchedule", () => {
	it("refuses a missing schedule and a stale revision", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { revision: 2 }));
		expect(await codeOf(updateSchedule(deps, "admin", { id: "nope", revision: 1, name: "B" }))).toBe(
			"NOT_FOUND",
		);
		await expect(updateSchedule(deps, "admin", { id: "A", revision: 1, name: "B" })).rejects.toMatchObject(
			{ code: "SCHEDULE_CHANGED", details: { revision: 2 } },
		);
	});

	it("retries a write lost to the scheduler while the revision is current (spec Ruling 46)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		const cas = deps.schedules.compareAndSet.bind(deps.schedules);
		let tick = true;
		deps.schedules.compareAndSet = async (id, revision, data) => {
			if (tick) {
				tick = false;
				// A due mark lands between the route's read and its write.
				await writeSchedule(deps.schedules, "A", undefined, (r) => ({ ...r, due: { at: AT } }));
			}
			return cas(id, revision, data);
		};
		const view = await updateSchedule(deps, "editor", { id: "A", revision: 1, name: "Renamed" });
		expect(view).toMatchObject({ name: "Renamed", revision: 2, updatedBy: "editor", due: { at: AT } });
	});

	it("refuses a template or source change while a job is open or a launch in flight", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.sources.put("S2", sourceRow("S2"));
		await deps.schedules.put("A", scheduleRow("A"));
		const open = { status: "completed", origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...open, scheduled: "open" }));
		const move = () => updateSchedule(deps, "admin", { id: "A", revision: 1, sourceId: "S2" });
		await expect(move()).rejects.toMatchObject({ code: "SCHEDULE_BUSY", details: { jobId: "J1" } });
		await deps.jobs.put("J1", jobRow("J1", { ...open, scheduled: "closed" }));
		const claimedAt = new Date(clock.t - 60_000).toISOString();
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J2", claimedAt } }));
		await expect(move()).rejects.toMatchObject({ code: "SCHEDULE_BUSY", details: { jobId: "J2" } });
		clock.t += LAUNCH_CLAIM_STALE_MS;
		expect(await move()).toMatchObject({
			sourceId: "S2",
			sourcePin: await pinOf("https://feeds.example/S2.csv"),
		});
	});

	it("enabling clears the pause and failures, re-pins the source, takes the caller and schedules the task", async () => {
		const { deps } = await scheduleDeps();
		await deps.sources.put("S1", sourceRow("S1", { url: "https://feeds.example/moved.csv" }));
		const pause = { reason: "source_changed" as const, at: AT };
		await deps.schedules.put("A", scheduleRow("A", { enabled: false, pause, launchFailures: 2 }));
		const view = await updateSchedule(deps, "second", { id: "A", revision: 1, enabled: true });
		expect(view).toMatchObject({
			enabled: true,
			launchFailures: 0,
			armedBy: "second",
			sourcePin: await pinOf("https://feeds.example/moved.csv"),
			nextRunAt: "2026-11-18T03:00:00.000Z",
		});
		expect(view).not.toHaveProperty("pause");
		expect(deps.cron.tasks.has("schedule-A")).toBe(true);
	});

	it("disabling cancels the task and drops the due mark, and leaves the open job alone (spec Ruling 48)", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await deps.schedules.put("A", scheduleRow("A", { due: { at: AT } }));
		const running = { status: "running", origin: "schedule", scheduleId: "A", scheduled: "open" } as const;
		await deps.jobs.put("J1", jobRow("J1", running));
		const view = await updateSchedule(deps, "admin", { id: "A", revision: 1, enabled: false });
		expect(view).toMatchObject({ enabled: false, nextRunAt: null });
		expect(view).not.toHaveProperty("due");
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
		expect(await deps.jobs.get("J1")).toMatchObject({ status: "running", scheduled: "open" });
	});

	it("re-schedules on a new expression; EmDash's refusal leaves the row unchanged (plan Ruling 5)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		await updateSchedule(deps, "admin", { id: "A", revision: 1, cron: "@hourly" });
		expect(deps.cron.tasks.get("schedule-A")).toEqual({
			schedule: "@hourly",
			data: { scheduleId: "A" },
		});
		const refused = updateSchedule(deps, "admin", { id: "A", revision: 2, cron: "0 3 31 2 *" });
		await expect(refused).rejects.toMatchObject({ code: "INVALID_CRON" });
		expect(await deps.schedules.get("A")).toMatchObject({ cron: "@hourly", revision: 2 });
		const sixFields = updateSchedule(deps, "admin", { id: "A", revision: 2, cron: "0 3 * * * *" });
		expect(await codeOf(sixFields)).toBe("INVALID_CRON");
	});

	it("removes missing with null only when the template has no rules.missing", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { templateId: "T2", missing: "template" }));
		const keep = updateSchedule(deps, "admin", { id: "A", revision: 1, missing: null });
		expect(await codeOf(keep)).toBe("MISSING_REQUIRED");
		const change = { id: "A", revision: 1, templateId: "T1", templateRevision: 1, missing: null };
		expect(await updateSchedule(deps, "admin", change)).not.toHaveProperty("missing");
	});
});

describe("deleteSchedule", () => {
	it("deletes at the revision and cancels the task, unless a job is open or a launch in flight", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const current = { jobId: "J9", claimedAt: AT };
		await deps.schedules.put("A", scheduleRow("A", { current }));
		expect(await codeOf(deleteSchedule(deps, { id: "A", revision: 2 }))).toBe("SCHEDULE_CHANGED");
		await expect(deleteSchedule(deps, { id: "A", revision: 1 })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J9" },
		});
		clock.t += LAUNCH_CLAIM_STALE_MS;
		const failed = { status: "failed", origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...failed, scheduled: "open" }));
		await expect(deleteSchedule(deps, { id: "A", revision: 1 })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J1" },
		});
		await deps.jobs.put("J1", jobRow("J1", { ...failed, scheduled: "closed" }));
		expect(await deleteSchedule(deps, { id: "A", revision: 1 })).toEqual({ deleted: true });
		expect(await deps.schedules.get("A")).toBeNull();
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
	});
});

describe("runSchedule", () => {
	it("refuses a disabled or paused schedule (SCHEDULE_DISABLED)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { enabled: false }));
		const pause = { reason: "job_failed" as const, at: AT };
		await deps.schedules.put("B", scheduleRow("B", { enabled: false, pause }));
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_DISABLED",
			message: "Schedule A is disabled; enable it first",
		});
		await expect(runSchedule(deps, { id: "B" })).rejects.toMatchObject({
			message: "Schedule B is disabled (paused: job_failed); enable it first",
		});
		expect(await codeOf(runSchedule(deps, { id: "nope" }))).toBe("NOT_FOUND");
	});

	it.each([
		["an Admin's import", { status: "running" }],
		["an agent's real import", { status: "created", origin: "agent" }],
		["another schedule's paused job", { status: "paused", origin: "schedule", scheduleId: "Z" }],
		["a rollback", { status: "running", kind: "rollback" }],
	] as const)("is busy while %s reads the source (spec Ruling 33)", async (_what, extra) => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		await deps.jobs.put("J1", jobRow("J1", { feedSourceId: "S1", ...extra }));
		await expect(runSchedule(deps, { id: "A" })).rejects.toMatchObject({
			code: "SCHEDULE_BUSY",
			details: { jobId: "J1" },
		});
	});

	it("is not busy for a dry run or a finished job, and pages past dry runs (plan Ruling 2)", async () => {
		const { deps } = await scheduleDeps();
		for (let i = 0; i < 25; i++) {
			await deps.jobs.put(`D${i}`, jobRow(`D${i}`, { feedSourceId: "S1", dryRun: true }));
		}
		await deps.jobs.put("J1", jobRow("J1", { feedSourceId: "S1", status: "completed" }));
		expect(await busyJob(deps.jobs, "S1")).toBeNull();
		await deps.jobs.put("Z9", jobRow("Z9", { feedSourceId: "S1", status: "paused" }));
		expect((await busyJob(deps.jobs, "S1"))?.id).toBe("Z9");
	});

	it("queues a due mark, with force when asked, and arms the pump; an older mark is kept (spec Ruling 51)", async () => {
		const { deps, clock } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A"));
		expect((await runSchedule(deps, { id: "A" })).due).toEqual({ at: AT });
		expect(deps.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		clock.t += 60_000;
		const forced = await runSchedule(deps, { id: "A", force: true });
		expect(forced).toMatchObject({ due: { at: AT, force: true }, revision: 1 });
	});
});

describe("listSchedules", () => {
	it("lists every schedule with its next run, null when disabled, and codes only (spec Ruling 47)", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const lastLaunch = { at: AT, outcome: "failed" as const, errorCode: "HTTP_ERROR" };
		await deps.schedules.put("A", scheduleRow("A", { lastLaunch }));
		const run: RunEntry = { jobId: "J1", at: AT, outcome: "failed", counters: { ...zero, failed: 3 } };
		const pause = { reason: "job_failed" as const, at: AT, jobId: "J1" };
		await deps.schedules.put("B", scheduleRow("B", { enabled: false, pause, runs: [run] }));
		const page = await listSchedules(deps);
		expect(page.items.map((s) => [s.id, s.nextRunAt])).toEqual([
			["A", "2026-11-18T03:00:00.000Z"],
			["B", null],
		]);
		expect(page.hasMore).toBe(false);
		const keys = (value: unknown): string[] =>
			value !== null && typeof value === "object"
				? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
				: [];
		expect(keys(page)).not.toContain("message");
	});
});

describe("reconcile (spec Ruling 29)", () => {
	it("schedules missing or changed tasks, cancels orphans, arms the pump and fixes retention", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-B", { schedule: "@hourly" });
		await deps.cron.schedule("schedule-GONE", { schedule: "@daily" });
		await deps.cron.schedule(RETENTION_TASK, { schedule: "5 4 * * *" });
		await deps.schedules.put("A", scheduleRow("A"));
		await deps.schedules.put("B", scheduleRow("B", { cron: "@daily" }));
		await deps.schedules.put("C", scheduleRow("C", { enabled: false }));
		const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;
		await deps.jobs.put("J1", jobRow("J1", open));
		expect(await reconcile(deps)).toEqual({
			scheduled: ["schedule-A", "schedule-B"],
			cancelled: ["schedule-GONE"],
			pump: true,
			retention: true,
		});
		expect(deps.cron.tasks.get("schedule-B")).toEqual({
			schedule: "@daily",
			data: { scheduleId: "B" },
		});
		expect(deps.cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
		deps.cron.calls.length = 0;
		const quiet = { scheduled: [], cancelled: [], pump: false, retention: false };
		expect(await reconcile(deps)).toEqual(quiet);
		expect(deps.cron.calls).toEqual([]);
	});
});

describe("scheduler writes and pauses", () => {
	it("writes only while current?.jobId is what the writer decided on (spec Ruling 34)", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { current: { jobId: "J1", claimedAt: AT } }));
		const mark = (r: ScheduleRow): ScheduleRow => ({
			...r,
			lastLaunch: { at: AT, outcome: "unchanged" },
		});
		expect(await writeSchedule(deps.schedules, "A", "J0", mark)).toBeNull();
		expect(await writeSchedule(deps.schedules, "A", undefined, mark)).toBeNull();
		expect(await writeSchedule(deps.schedules, "A", "J1", mark)).toMatchObject({
			lastLaunch: { outcome: "unchanged" },
		});
		expect(await writeSchedule(deps.schedules, "gone", undefined, mark)).toBeNull();
	});

	it("pauses from a route: disabled with the reason, no claim or mark, the task cancelled, the run marked", async () => {
		const { deps } = await scheduleDeps();
		await deps.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const run: RunEntry = { jobId: "J1", at: AT, outcome: "completed", counters: zero };
		const current = { jobId: "J2", claimedAt: AT };
		await deps.schedules.put("A", scheduleRow("A", { due: { at: AT }, current, runs: [run] }));
		const mark = (r: ScheduleRow) => withRollback(r, "J1", "R1", AT);
		expect(await pauseSchedule(deps, "A", "rolled_back", "J1", mark)).toBe(true);
		const row = await deps.schedules.get("A");
		expect(row).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", at: AT, jobId: "J1" },
			runs: [{ ...run, rolledBack: { by: "R1", at: AT } }],
		});
		expect(row).not.toHaveProperty("due");
		expect(row).not.toHaveProperty("current");
		expect(deps.cron.tasks.has("schedule-A")).toBe(false);
		expect(await pauseSchedule(deps, "gone", "cancelled", "J1")).toBe(false);
	});

	it("names the schedules that use a template or source, and warns about the ones an edit pauses", async () => {
		const { deps } = await scheduleDeps();
		await deps.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		const hourly = { name: "Hourly", templateId: "T2", sourceId: "S2", sourcePin: "p2" };
		await deps.schedules.put("B", scheduleRow("B", hourly));
		const byTemplate = await schedulesUsing(deps.schedules, { templateId: "T1" });
		expect(byTemplate.map((s) => s.id)).toEqual(["A"]);
		expect(inUse("Template", "T1", byTemplate)).toMatchObject({
			code: "TEMPLATE_IN_USE",
			status: 409,
			message: "Template T1 is used by schedule(s) Nightly; delete or change them first",
			details: { scheduleIds: ["A"] },
		});
		expect(templateWarnings(byTemplate, 2)).toEqual([
			"Schedule Nightly (A) runs revision 1; update it to run this revision",
		]);
		expect(templateWarnings(byTemplate, 1)).toEqual([]);
		const bySource = await schedulesUsing(deps.schedules, { sourceId: "S2" });
		expect(inUse("Source", "S2", bySource).code).toBe("SOURCE_IN_USE");
		expect(sourceWarnings(bySource, "p3")).toEqual([
			"Schedule Hourly (B) pins this source's URL and credential; it pauses at its next run until it is enabled again",
		]);
		expect(sourceWarnings(bySource, "p2")).toEqual([]);
	});

	it("reopens a finalized scheduled job that is resumed or retried, and arms the pump (plan Ruling 11)", async () => {
		const { deps } = await scheduleDeps();
		const closed = { status: "running", origin: "schedule", scheduleId: "A", scheduled: "closed" } as const;
		await deps.jobs.put("J1", jobRow("J1", closed));
		await deps.jobs.put("J2", jobRow("J2", { status: "running" }));
		await reopenScheduled(deps.jobs, deps.cron, "J1");
		await reopenScheduled(deps.jobs, deps.cron, "J2");
		expect(await deps.jobs.get("J1")).toMatchObject({ scheduled: "open" });
		expect(await deps.jobs.get("J2")).not.toHaveProperty("scheduled");
		expect(deps.cron.calls).toEqual([`schedule ${PUMP_TASK} ${PUMP_SCHEDULE}`]);
	});
});
````

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/cron-syntax.test.ts tests/unit/schedules.test.ts`
Expected: FAIL: `cron-syntax.js` and `schedules.js` do not exist.

- [ ] **Step 4: Write `cron-syntax.ts`**

Create `packages/flux-import/src/plugin/cron-syntax.ts`:
````ts
/**
 * The schedule expressions flux-import accepts (spec Ruling 7, plan Ruling 3): five cron fields or
 * one of five aliases, which EmDash evaluates in UTC. EmDash's own parser takes far more and turns
 * many typos, such as `61 * * * *`, into one-shot runs in the past (Fact E1), so each field is
 * checked here; EmDash's `schedule()` still validates what passes (a date that never comes, such
 * as `0 3 31 2 *`).
 */

export const CRON_MAX_LENGTH = 256;
export const CRON_ALIASES: readonly string[] = [
	"@hourly",
	"@daily",
	"@weekly",
	"@monthly",
	"@yearly",
];
export const CRON_RULE =
	"Use five cron fields (minute, hour, day of month, month, day of week) or @hourly, @daily, @weekly, @monthly or @yearly; times are UTC";

interface Field {
	name: string;
	min: number;
	max: number;
	/** Three-letter names; the first one is `first`. */
	names?: readonly string[];
	first?: number;
}

const FIELDS: readonly Field[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{
		name: "month",
		min: 1,
		max: 12,
		first: 1,
		names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
	},
	// 0 and 7 are both Sunday, as EmDash's parser reads them (Fact E1).
	{
		name: "day of week",
		min: 0,
		max: 7,
		first: 0,
		names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
	},
];

const NUMBER = /^\d{1,2}$/;

/** The field's value for `text`: a number in its range or one of its names; else null. */
function valueOf(text: string, field: Field): number | null {
	if (NUMBER.test(text)) {
		const n = Number(text);
		return n >= field.min && n <= field.max ? n : null;
	}
	const i = field.names?.indexOf(text.toLowerCase()) ?? -1;
	return i < 0 ? null : i + (field.first ?? 0);
}

function itemProblem(item: string, field: Field): string | null {
	const bad = `${field.name}: "${item}" is not a value from ${field.min} to ${field.max}, a range or a step`;
	const [range = "", step, extra] = item.split("/");
	if (extra !== undefined || range === "") return bad;
	if (step !== undefined) {
		const n = NUMBER.test(step) ? Number(step) : 0;
		if (n < 1 || n > field.max) {
			return `${field.name}: the step in "${item}" must be from 1 to ${field.max}`;
		}
	}
	if (range === "*") return null;
	const [from = "", to, more] = range.split("-");
	if (more !== undefined) return bad;
	const a = valueOf(from, field);
	if (to === undefined) {
		if (a === null) return bad;
		return step === undefined
			? null
			: `${field.name}: a step needs * or a range before it, not "${item}"`;
	}
	const b = valueOf(to, field);
	return a === null || b === null || a > b ? bad : null;
}

/** Null when `cron` is a schedule flux-import accepts, else what is wrong with it. */
export function cronProblem(cron: string): string | null {
	if (cron.length === 0) return "The schedule is empty";
	if (cron.length > CRON_MAX_LENGTH) {
		return `The schedule is longer than ${CRON_MAX_LENGTH} characters`;
	}
	if (cron.trim() !== cron) return "The schedule starts or ends with a space";
	if (cron.startsWith("@")) {
		return CRON_ALIASES.includes(cron) ? null : `${cron} is not an accepted alias`;
	}
	const parts = cron.split(/\s+/);
	if (parts.length !== FIELDS.length) return `Expected 5 fields, found ${parts.length}`;
	for (const [i, part] of parts.entries()) {
		const field = FIELDS[i] as Field;
		for (const item of part.split(",")) {
			const problem = itemProblem(item, field);
			if (problem !== null) return problem;
		}
	}
	return null;
}
````

- [ ] **Step 5: Write `schedules.ts`**

Create `packages/flux-import/src/plugin/schedules.ts`:
````ts
/** Schedules (M6b): rows, checks, the route services, scheduler writes and reconciliation. */
import type { PluginContext, StorageCollection } from "emdash";
import { kvCollection } from "../emdash/storage.js";
import { fingerprint } from "../engine/fingerprints.js";
import type { KvCollection } from "../engine/ports.js";
import type { Template } from "../engine/template.js";
import { type Job, MISSING_MAX_PERCENT_DEFAULT } from "../engine/types.js";
import { CRON_RULE, cronProblem } from "./cron-syntax.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type Page, page, ServiceError } from "./service.js";
import type { SourceRow } from "./sources.js";
import { assertRevision, templateNotFound } from "./template-errors.js";
import { readSavedTemplate, type SavedTemplate, templateForSave } from "./templates.js";

/** One page holds every schedule for the pump and the list (spec Ruling 17). */
export const MAX_SCHEDULES = 20;
/** Run log entries kept per schedule, newest first (spec Ruling 42). */
export const RUN_LOG_SIZE = 20;
/** Attempts of a compare-and-set loop on a schedule row (spec "Writes"). */
export const WRITE_ATTEMPTS = 5;
/** A claim older than this with no job is a crashed launch (EmDash's stale-lock time, spec F6). */
export const LAUNCH_CLAIM_STALE_MS = 600_000;
export const PUMP_TASK = "pump";
export const PUMP_SCHEDULE = "*/10 * * * * *";
export const SCHEDULE_DEFAULTS = { publish: true, batchSize: 50, budgetMs: 4_000 } as const;

export type ScheduleMissing = false | "template" | { maxPercent: number };

export type PauseReason =
	| "template_gone"
	| "template_changed"
	| "source_gone"
	| "source_changed"
	| "creator_gone"
	| "invalid_template"
	| "credential_missing"
	| "url_blocked"
	| "too_large"
	| "fetch_failed"
	| "job_failed"
	| "cancelled"
	| "rolled_back"
	| "missing_refused"
	| "empty_feed";

export interface RunEntry {
	jobId: string;
	/** When the job finished (its `updatedAt`). */
	at: string;
	outcome: "completed" | "failed" | "cancelled" | "missing_refused" | "empty_feed";
	counters: {
		created: number;
		updated: number;
		unchanged: number;
		failed: number;
		conflict: number;
		locked: number;
		removed: number;
	};
	/** The rollback job and when it was made (spec Ruling 42). */
	rolledBack?: { by: string; at: string };
}

export interface ScheduleRow {
	id: string;
	name: string;
	templateId: string;
	templateRevision: number;
	sourceId: string;
	/** `sourcePinOf` the source when the schedule was armed (spec Ruling 40). */
	sourcePin: string;
	cron: string;
	publish: boolean;
	batchSize: number;
	/** Wall time per batch (spec Ruling 16). */
	budgetMs: number;
	/** Set exactly when the template has `rules.missing` (spec Ruling 12). */
	missing?: ScheduleMissing;
	enabled: boolean;
	pause?: { reason: PauseReason; at: string; jobId?: string };
	/** Set by `schedule-<id>` and `schedules/run`; consumed by a launch (spec Ruling 35). */
	due?: { at: string; force?: true };
	/** The launch claim only: set before the fetch, cleared once the launch ends (spec Ruling 38). */
	current?: { jobId: string; claimedAt: string };
	lastLaunch?: {
		at: string;
		outcome: "started" | "unchanged" | "busy" | "failed";
		jobId?: string;
		/** Codes only, never messages (spec Ruling 47). */
		errorCode?: string;
	};
	runs: RunEntry[];
	launchFailures: number;
	/** The user of the last create or update that enabled the schedule (spec Ruling 43). */
	armedBy: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	updatedBy: string;
}

/** What the routes return: the row and its task's next run (`null` while disabled). */
export type ScheduleView = ScheduleRow & { nextRunAt: string | null };

/** `ctx.cron` (spec F1); always present in EmDash 1.2.0. */
export type CronPort = NonNullable<PluginContext["cron"]>;
type CronTask = Awaited<ReturnType<CronPort["list"]>>[number];

export interface ScheduleDeps {
	schedules: KvCollection<ScheduleRow>;
	jobs: KvCollection<Job>;
	templates: Pick<KvCollection<SavedTemplate>, "get">;
	sources: Pick<KvCollection<SourceRow>, "get">;
	cron: CronPort;
	/** The site problems of a template (M6a `siteCheck`), for the route's site. */
	templateProblems: (template: Template) => Promise<string[]>;
	now: () => number;
	newId: () => string;
}

export interface CreateScheduleInput {
	name: string;
	templateId: string;
	templateRevision: number;
	sourceId: string;
	cron: string;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
	missing?: ScheduleMissing | undefined;
	enabled?: boolean | undefined;
}

export interface UpdateScheduleInput {
	id: string;
	revision: number;
	name?: string | undefined;
	templateId?: string | undefined;
	templateRevision?: number | undefined;
	sourceId?: string | undefined;
	cron?: string | undefined;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
	/** `null` removes it (only for a template without `rules.missing`). */
	missing?: ScheduleMissing | null | undefined;
	enabled?: boolean | undefined;
}

const TASK_PREFIX = "schedule-";
const PAGE = 20;
const UNFINISHED = ["created", "running", "paused"];
const iso = (ms: number) => new Date(ms).toISOString();

export const scheduleTask = (id: string): string => `${TASK_PREFIX}${id}`;

export function scheduleIdOf(task: string): string | null {
	return task.startsWith(TASK_PREFIX) ? task.slice(TASK_PREFIX.length) : null;
}

/** The `schedules` storage collection declared in the plugin definition. */
export function schedulesCollection(
	storage: Record<string, StorageCollection | undefined>,
): KvCollection<ScheduleRow> {
	if (!storage.schedules) throw new Error("flux-import: the schedules storage collection is missing");
	return kvCollection<ScheduleRow>(storage.schedules);
}

export function cronOf(ctx: Pick<PluginContext, "cron">): CronPort {
	if (!ctx.cron) throw new Error("flux-import: EmDash's cron API is not available");
	return ctx.cron;
}

/** Schedules (or re-arms) the pump; an upsert (spec F3). */
export function armPump(cron: CronPort): Promise<void> {
	return cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
}

/** The pin of a source: its URL and credential name (spec Ruling 40). */
export function sourcePinOf(source: Pick<SourceRow, "url" | "credential">): Promise<string> {
	return fingerprint({ url: source.url, credential: source.credential ?? null });
}

const notFound = (id: string) => new ServiceError("NOT_FOUND", `Schedule ${id} not found`, 404);

const busy = (id: string, jobId: string) =>
	new ServiceError(
		"SCHEDULE_BUSY",
		`Schedule ${id} is busy with job ${jobId}; wait for it to finish or cancel it`,
		409,
		{ jobId },
	);

const keptChanging = () =>
	new ServiceError("CONFLICT", "The schedule kept changing; try again", 409);

function assertScheduleRevision(row: ScheduleRow, revision: number): void {
	if (row.revision !== revision) {
		throw new ServiceError(
			"SCHEDULE_CHANGED",
			`Schedule ${row.id} is at revision ${row.revision}, not ${revision}; read it again`,
			409,
			{ revision: row.revision },
		);
	}
}

/**
 * The unfinished real import or rollback that reads `sourceId`'s data, if any (spec Ruling 33).
 * Dry runs never make a schedule busy; they are skipped here, not in the query (plan Ruling 2).
 */
export async function busyJob(jobs: KvCollection<Job>, sourceId: string): Promise<Job | null> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { feedSourceId: sourceId, status: { in: UNFINISHED } },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		const real = result.items.find((i) => !i.data.dryRun);
		if (real) return real.data;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return null;
}

/** A job the schedule launched that the pump has not finalized yet. */
export async function openJobOf(jobs: KvCollection<Job>, scheduleId: string): Promise<Job | null> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { scheduled: "open" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		const mine = result.items.find((i) => i.data.scheduleId === scheduleId);
		if (mine) return mine.data;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return null;
}

export async function anyOpenJob(jobs: KvCollection<Job>): Promise<boolean> {
	return (await jobs.query({ where: { scheduled: "open" }, limit: 1 })).items.length > 0;
}

/** The job that keeps a route from changing the schedule: a launch in flight or an open job (plan Ruling 7). */
async function routeBusy(deps: ScheduleDeps, row: ScheduleRow): Promise<string | null> {
	const claim = row.current;
	if (claim && deps.now() - Date.parse(claim.claimedAt) < LAUNCH_CLAIM_STALE_MS) return claim.jobId;
	return (await openJobOf(deps.jobs, row.id))?.id ?? null;
}

/**
 * A scheduler write (spec Rulings 34, 46): applies `change` to the newest row while
 * `current?.jobId` is still `expected`, retrying a lost compare-and-set. `revision` is left alone.
 * Null when the row is gone, `current` changed, `change` returned null or every attempt lost.
 */
export async function writeSchedule(
	schedules: KvCollection<ScheduleRow>,
	id: string,
	expected: string | undefined,
	change: (row: ScheduleRow) => ScheduleRow | null,
): Promise<ScheduleRow | null> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await schedules.getVersioned(id);
		if (!read || read.value.current?.jobId !== expected) return null;
		const next = change(read.value);
		if (next === null) return null;
		if ((await schedules.compareAndSet(id, read.revision, next)).applied) return next;
	}
	return null;
}

/** The row paused: disabled with the reason; the claim and the due mark go (plan Ruling 6). */
export function paused(
	row: ScheduleRow,
	reason: PauseReason,
	at: string,
	jobId?: string,
): ScheduleRow {
	const { current: _current, due: _due, ...rest } = row;
	return { ...rest, enabled: false, pause: { reason, at, ...(jobId === undefined ? {} : { jobId }) } };
}

/** Marks a run log entry rolled back (spec Ruling 42). */
export function withRollback(row: ScheduleRow, jobId: string, by: string, at: string): ScheduleRow {
	return {
		...row,
		runs: row.runs.map((r) => (r.jobId === jobId ? { ...r, rolledBack: { by, at } } : r)),
	};
}

/**
 * Pauses a schedule from a route (spec Ruling 32: a cancel or rollback of its job), then cancels
 * its task; `mark` changes the row further. False when the row is gone or every attempt lost.
 */
export async function pauseSchedule(
	deps: Pick<ScheduleDeps, "schedules" | "cron" | "now">,
	id: string,
	reason: PauseReason,
	jobId: string,
	mark: (row: ScheduleRow) => ScheduleRow = (row) => row,
): Promise<boolean> {
	const at = iso(deps.now());
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await deps.schedules.getVersioned(id);
		if (!read) return false;
		const next = mark(paused(read.value, reason, at, jobId));
		if ((await deps.schedules.compareAndSet(id, read.revision, next)).applied) {
			await deps.cron.cancel(scheduleTask(id));
			return true;
		}
	}
	return false;
}

/**
 * Reopens a finalized scheduled job that an Admin resumed or retried, and arms the pump, so the
 * pump drives it again (spec Ruling 38, plan Ruling 11). No-op for any other job.
 */
export async function reopenScheduled(
	jobs: KvCollection<Job>,
	cron: CronPort,
	id: string,
): Promise<void> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await jobs.getVersioned(id);
		if (!read || read.value.origin !== "schedule" || read.value.scheduled !== "closed") return;
		if ((await jobs.compareAndSet(id, read.revision, { ...read.value, scheduled: "open" })).applied) {
			await armPump(cron);
			return;
		}
	}
}

export function viewOf(row: ScheduleRow, tasks: readonly CronTask[]): ScheduleView {
	const task = row.enabled ? tasks.find((t) => t.name === scheduleTask(row.id)) : undefined;
	return { ...row, nextRunAt: task?.nextRunAt ?? null };
}

async function assertNameFree(
	schedules: KvCollection<ScheduleRow>,
	name: string,
	self?: string,
): Promise<void> {
	const found = await schedules.query({ where: { name }, limit: 2 });
	if (found.items.some((i) => i.id !== self)) {
		throw new ServiceError("NAME_TAKEN", `A schedule named "${name}" already exists`, 409);
	}
}

/** The template at `revision`, its shape and its site checks (spec "Behaviour" step 3, plan Ruling 13). */
async function checkedTemplate(
	deps: ScheduleDeps,
	id: string,
	revision: number,
): Promise<Template> {
	const row = await deps.templates.get(id);
	if (!row) throw templateNotFound("TEMPLATE_NOT_FOUND", id);
	assertRevision(id, row.revision, revision);
	const template = templateForSave(readSavedTemplate(row));
	const problems = await deps.templateProblems(template);
	if (problems.length > 0) {
		throw new ServiceError(
			"TEMPLATE_PROBLEMS",
			`Template ${id} does not fit the site; fix it before scheduling it`,
			409,
			{ problems },
		);
	}
	return template;
}

async function checkedSource(deps: ScheduleDeps, id: string): Promise<SourceRow> {
	const row = await deps.sources.get(id);
	if (!row) throw new ServiceError("SOURCE_NOT_FOUND", `Source ${id} not found`, 404);
	return row;
}

function checkCron(cron: string): void {
	const problem = cronProblem(cron);
	if (problem !== null) throw new ServiceError("INVALID_CRON", `${problem}. ${CRON_RULE}`, 400);
}

/** Spec Rulings 12, 13: required with `rules.missing`, refused without, never above it. */
function checkMissing(template: Template, missing: ScheduleMissing | undefined): void {
	const rule = template.rules?.missing;
	if (rule === undefined) {
		if (missing !== undefined) {
			throw new ServiceError(
				"INVALID_OPTIONS",
				"The template has no rules.missing; leave missing out",
				400,
			);
		}
		return;
	}
	if (missing === undefined) {
		throw new ServiceError(
			"MISSING_REQUIRED",
			'The template removes missing entries (rules.missing); set missing to false, "template" or { maxPercent }',
			400,
		);
	}
	const max = rule.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT;
	if (typeof missing === "object" && missing.maxPercent > max) {
		throw new ServiceError(
			"INVALID_OPTIONS",
			`missing.maxPercent ${missing.maxPercent} is over the template's ${max}; a schedule can lower the threshold, never raise it`,
			400,
		);
	}
}

/** EmDash's refusal of an expression flux-import accepted (Fact E1) is `INVALID_CRON`. */
async function scheduleTaskOf(cron: CronPort, row: Pick<ScheduleRow, "id" | "cron">): Promise<void> {
	try {
		await cron.schedule(scheduleTask(row.id), { schedule: row.cron, data: { scheduleId: row.id } });
	} catch (e) {
		if (e instanceof Error && /^Invalid (schedule|cron expression)/.test(e.message)) {
			throw new ServiceError("INVALID_CRON", e.message, 400);
		}
		throw e;
	}
}

/** `schedules/create` (spec "Behaviour"): every check before any write, in the spec's order. */
export async function createSchedule(
	deps: ScheduleDeps,
	user: string,
	input: CreateScheduleInput,
): Promise<ScheduleView> {
	const name = input.name.normalize("NFC");
	await assertNameFree(deps.schedules, name);
	if ((await deps.schedules.query({ limit: MAX_SCHEDULES })).items.length >= MAX_SCHEDULES) {
		throw new ServiceError(
			"SCHEDULE_LIMIT",
			`A site has at most ${MAX_SCHEDULES} schedules; delete one first`,
			409,
		);
	}
	const template = await checkedTemplate(deps, input.templateId, input.templateRevision);
	const source = await checkedSource(deps, input.sourceId);
	checkCron(input.cron);
	checkMissing(template, input.missing);
	const now = iso(deps.now());
	const row: ScheduleRow = {
		id: deps.newId(),
		name,
		templateId: input.templateId,
		templateRevision: input.templateRevision,
		sourceId: input.sourceId,
		sourcePin: await sourcePinOf(source),
		cron: input.cron,
		publish: input.publish ?? SCHEDULE_DEFAULTS.publish,
		batchSize: input.batchSize ?? SCHEDULE_DEFAULTS.batchSize,
		budgetMs: input.budgetMs ?? SCHEDULE_DEFAULTS.budgetMs,
		...(input.missing === undefined ? {} : { missing: input.missing }),
		enabled: input.enabled ?? true,
		runs: [],
		launchFailures: 0,
		armedBy: user,
		revision: 1,
		createdAt: now,
		updatedAt: now,
		createdBy: user,
		updatedBy: user,
	};
	if (!(await deps.schedules.compareAndSet(row.id, null, row)).applied) throw keptChanging();
	if (row.enabled) {
		try {
			await scheduleTaskOf(deps.cron, row);
		} catch (e) {
			await deps.schedules.delete(row.id);
			throw e;
		}
	}
	return viewOf(row, await deps.cron.list());
}

/**
 * `schedules/update` (spec "Behaviour", Rulings 46, 48): the checks run against the row at
 * `revision`; the write merges onto the newest row, so a scheduler write in between is kept and
 * retried over, and only another route write (a new `revision`) is `SCHEDULE_CHANGED`.
 */
export async function updateSchedule(
	deps: ScheduleDeps,
	user: string,
	input: UpdateScheduleInput,
): Promise<ScheduleView> {
	const first = await deps.schedules.get(input.id);
	if (!first) throw notFound(input.id);
	assertScheduleRevision(first, input.revision);
	const name = input.name?.normalize("NFC");
	if (name !== undefined && name !== first.name) await assertNameFree(deps.schedules, name, first.id);
	const templateId = input.templateId ?? first.templateId;
	const templateRevision = input.templateRevision ?? first.templateRevision;
	const sourceId = input.sourceId ?? first.sourceId;
	const templateChanged =
		templateId !== first.templateId || templateRevision !== first.templateRevision;
	if (templateChanged || sourceId !== first.sourceId) {
		const jobId = await routeBusy(deps, first);
		if (jobId !== null) throw busy(first.id, jobId);
	}
	const missing = input.missing === undefined ? first.missing : (input.missing ?? undefined);
	if (templateChanged || input.missing !== undefined) {
		checkMissing(await checkedTemplate(deps, templateId, templateRevision), missing);
	}
	const enabling = input.enabled === true;
	const source =
		sourceId !== first.sourceId || enabling ? await checkedSource(deps, sourceId) : null;
	const sourcePin = source === null ? first.sourcePin : await sourcePinOf(source);
	if (input.cron !== undefined) checkCron(input.cron);
	const cron = input.cron ?? first.cron;
	// Plan Ruling 5: EmDash's refusal leaves the row unchanged.
	if ((input.enabled ?? first.enabled) && (enabling || input.cron !== undefined)) {
		await scheduleTaskOf(deps.cron, { id: first.id, cron });
	}
	const now = iso(deps.now());
	let read = await deps.schedules.getVersioned(input.id);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		if (!read) throw notFound(input.id);
		const row = read.value;
		assertScheduleRevision(row, input.revision);
		const enabled = input.enabled ?? row.enabled;
		const { missing: _missing, pause, due, ...rest } = row;
		const next: ScheduleRow = {
			...rest,
			name: name ?? row.name,
			templateId,
			templateRevision,
			sourceId,
			sourcePin,
			cron,
			publish: input.publish ?? row.publish,
			batchSize: input.batchSize ?? row.batchSize,
			budgetMs: input.budgetMs ?? row.budgetMs,
			...(missing === undefined ? {} : { missing }),
			enabled,
			// Enabling clears the pause and the failures and takes the caller as creator.
			...(enabling ? { launchFailures: 0, armedBy: user } : pause ? { pause } : {}),
			// A disabled schedule is never due (plan Ruling 6).
			...(enabled && due ? { due } : {}),
			revision: row.revision + 1,
			updatedAt: now,
			updatedBy: user,
		};
		if ((await deps.schedules.compareAndSet(row.id, read.revision, next)).applied) {
			if (!next.enabled) await deps.cron.cancel(scheduleTask(row.id));
			return viewOf(next, await deps.cron.list());
		}
		read = await deps.schedules.getVersioned(input.id);
	}
	// The task may now hold the new expression: put it back as the newest row says (plan Ruling 5).
	const newest = await deps.schedules.get(input.id);
	if (newest?.enabled) await scheduleTaskOf(deps.cron, newest).catch(() => {});
	throw keptChanging();
}

/** `schedules/delete`: at `revision`, never while busy (spec "Behaviour", plan Ruling 7). */
export async function deleteSchedule(
	deps: ScheduleDeps,
	input: { id: string; revision: number },
): Promise<{ deleted: true }> {
	let read = await deps.schedules.getVersioned(input.id);
	if (!read) throw notFound(input.id);
	assertScheduleRevision(read.value, input.revision);
	const jobId = await routeBusy(deps, read.value);
	if (jobId !== null) throw busy(input.id, jobId);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		if (!read) throw notFound(input.id);
		assertScheduleRevision(read.value, input.revision);
		if ((await deps.schedules.compareAndDelete(input.id, read.revision)).applied) {
			// The pump cancels itself once nothing is due or open (spec Ruling 36).
			await deps.cron.cancel(scheduleTask(input.id));
			return { deleted: true };
		}
		read = await deps.schedules.getVersioned(input.id);
	}
	throw keptChanging();
}

/** `schedules/run` (spec Ruling 51): queues a due mark and arms the pump; never fetches. */
export async function runSchedule(
	deps: ScheduleDeps,
	input: { id: string; force?: boolean | undefined },
): Promise<ScheduleView> {
	const row = await deps.schedules.get(input.id);
	if (!row) throw notFound(input.id);
	if (!row.enabled) {
		const why = row.pause ? ` (paused: ${row.pause.reason})` : "";
		throw new ServiceError(
			"SCHEDULE_DISABLED",
			`Schedule ${input.id} is disabled${why}; enable it first`,
			409,
		);
	}
	const claimed = await routeBusy(deps, row);
	const job = claimed === null ? await busyJob(deps.jobs, row.sourceId) : null;
	const jobId = claimed ?? job?.id ?? null;
	if (jobId !== null) throw busy(input.id, jobId);
	const at = iso(deps.now());
	const written = await writeSchedule(deps.schedules, input.id, row.current?.jobId, (r) =>
		r.enabled
			? {
					...r,
					due: {
						at: r.due?.at ?? at,
						...(input.force === true || r.due?.force ? { force: true as const } : {}),
					},
				}
			: null,
	);
	if (!written) throw keptChanging();
	await armPump(deps.cron);
	return viewOf(written, await deps.cron.list());
}

/** `schedules/list`: rows and next runs; rows hold codes only (spec Ruling 47). */
export async function listSchedules(
	deps: Pick<ScheduleDeps, "schedules" | "cron">,
	cursor?: string,
): Promise<Page<ScheduleView>> {
	const rows = page(
		await deps.schedules.query({ limit: MAX_SCHEDULES, ...(cursor ? { cursor } : {}) }),
	);
	const tasks = await deps.cron.list();
	return { ...rows, items: rows.items.map((row) => viewOf(row, tasks)) };
}

async function allSchedules(schedules: KvCollection<ScheduleRow>): Promise<ScheduleRow[]> {
	const rows: ScheduleRow[] = [];
	let cursor: string | undefined;
	do {
		const result = await schedules.query({ limit: MAX_SCHEDULES, ...(cursor ? { cursor } : {}) });
		rows.push(...result.items.map((i) => i.data));
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return rows;
}

export interface ReconcileResult {
	scheduled: string[];
	cancelled: string[];
	pump: boolean;
	retention: boolean;
}

/**
 * Repairs the cron tasks from storage (spec "Reconciliation", Ruling 29): each enabled schedule's
 * task with its expression, no task without an enabled schedule, the pump while something is due
 * or open, and `retention` at `RETENTION_SCHEDULE`. An expression EmDash refuses stays
 * unscheduled (the list shows no next run).
 */
export async function reconcile(
	deps: Pick<ScheduleDeps, "schedules" | "jobs" | "cron">,
): Promise<ReconcileResult> {
	const tasks = await deps.cron.list();
	const rows = await allSchedules(deps.schedules);
	const byName = new Map(tasks.map((t) => [t.name, t]));
	const result: ReconcileResult = { scheduled: [], cancelled: [], pump: false, retention: false };
	const wanted = new Set<string>();
	for (const row of rows) {
		if (!row.enabled) continue;
		const name = scheduleTask(row.id);
		wanted.add(name);
		if (byName.get(name)?.schedule === row.cron) continue;
		try {
			await scheduleTaskOf(deps.cron, row);
			result.scheduled.push(name);
		} catch {
			// Left unscheduled; schedules/update with a valid expression repairs it.
		}
	}
	for (const task of tasks) {
		if (scheduleIdOf(task.name) !== null && !wanted.has(task.name)) {
			await deps.cron.cancel(task.name);
			result.cancelled.push(task.name);
		}
	}
	if (!byName.has(PUMP_TASK)) {
		if (rows.some((r) => r.enabled && r.due) || (await anyOpenJob(deps.jobs))) {
			await armPump(deps.cron);
			result.pump = true;
		}
	}
	if (byName.get(RETENTION_TASK)?.schedule !== RETENTION_SCHEDULE) {
		await deps.cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
		result.retention = true;
	}
	return result;
}

/** Up to five schedules that name the template or the source (spec Ruling 10). */
export async function schedulesUsing(
	schedules: KvCollection<ScheduleRow>,
	where: { templateId: string } | { sourceId: string },
	limit = 5,
): Promise<ScheduleRow[]> {
	return (await schedules.query({ where, limit })).items.map((i) => i.data);
}

/** `TEMPLATE_IN_USE` or `SOURCE_IN_USE` (spec Ruling 10). */
export function inUse(kind: "Template" | "Source", id: string, rows: ScheduleRow[]): ServiceError {
	return new ServiceError(
		`${kind.toUpperCase()}_IN_USE`,
		`${kind} ${id} is used by schedule(s) ${rows.map((r) => r.name).join(", ")}; delete or change them first`,
		409,
		{ scheduleIds: rows.map((r) => r.id) },
	);
}

/** `templates/update`'s warnings: schedules pinned to another revision (spec Ruling 11). */
export function templateWarnings(rows: ScheduleRow[], revision: number): string[] {
	return rows
		.filter((r) => r.templateRevision !== revision)
		.map(
			(r) =>
				`Schedule ${r.name} (${r.id}) runs revision ${r.templateRevision}; update it to run this revision`,
		);
}

/** `sources/update`'s warnings: schedules pinned to another URL or credential (spec Ruling 40). */
export function sourceWarnings(rows: ScheduleRow[], pin: string): string[] {
	return rows
		.filter((r) => r.sourcePin !== pin)
		.map(
			(r) =>
				`Schedule ${r.name} (${r.id}) pins this source's URL and credential; it pauses at its next run until it is enabled again`,
		);
}
````

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/cron-syntax.test.ts tests/unit/schedules.test.ts`
Expected: PASS (`cron-syntax.test.ts` 32 tests; `schedules.test.ts` 27 tests).

- [ ] **Step 7: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, 91 unit files.
```bash
git add packages/flux-import/src/plugin/cron-syntax.ts packages/flux-import/src/plugin/schedules.ts packages/flux-import/tests/unit/schedule-fakes.ts packages/flux-import/tests/unit/cron-syntax.test.ts packages/flux-import/tests/unit/schedules.test.ts
git commit -m "Add the schedule service: the cron grammar, schedule checks and writes, the busy check, pauses and reconciliation"
```

### Task 3: The schedule routes and the changes to the existing routes

**Files:**
- Modify: `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/schedule-routes.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 2's `createSchedule`, `updateSchedule`, `deleteSchedule`, `runSchedule`, `listSchedules`, `reconcile`, `schedulesUsing`, `inUse`, `templateWarnings`, `sourceWarnings`, `sourcePinOf`, `pauseSchedule`, `withRollback`, `reopenScheduled`, `schedulesCollection`, `cronOf`, `MAX_SCHEDULES`, `ScheduleDeps`, `ScheduleRow`; Task 1's `RouteServices`; M6a's `siteCheck` (`src/plugin/templates.ts:211`).
- Produces: the routes `schedules/create`, `schedules/list`, `schedules/update`, `schedules/delete`, `schedules/run`; the exported inputs `SCHEDULE_CREATE_INPUT`, `SCHEDULE_UPDATE_INPUT`; `templates/update`'s schedule warnings, `sources/update`'s `warnings`, the in-use refusals, and the cancel, rollback, resume and retry side effects.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/definition.test.ts`, add to `ROUTES` after `"templates/import"`:
````ts
	"schedules/create",
	"schedules/list",
	"schedules/update",
	"schedules/delete",
	"schedules/run",
````

Create `packages/flux-import/tests/unit/schedule-routes.test.ts`:
````ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../../src/engine/fingerprints.js";
import type { Job } from "../../src/engine/types.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { RETENTION_TASK } from "../../src/plugin/retention.js";
import { PUMP_TASK, type ScheduleRow, type ScheduleView } from "../../src/plugin/schedules.js";
import type { Page } from "../../src/plugin/service.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedResult, SavedTemplate } from "../../src/plugin/templates.js";
import { FakeStorage, MemoryKv } from "./fakes.js";
import { type Deps, importRows, setup } from "./rollback-fixture.js";
import { FakeCron, jobRow, savedTemplate, scheduleRow, sourceRow } from "./schedule-fakes.js";

// As agent-routes.test.ts: the runtime and plugin storage are the engine's fakes.
const state = vi.hoisted(() => ({ deps: undefined as unknown, storage: undefined as unknown }));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({
			storage: state.storage,
			config: { maxUploadSize: 1000 },
			db: {},
			schemaRegistry: {
				getCollectionWithFields: async (slug: string) =>
					slug === "products"
						? { fields: [{ slug: "title", type: "string" }], supports: [] }
						: null,
			},
		}),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/content.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashContent: function () {
		return (state.deps as Record<string, unknown>).content;
	},
}));
vi.mock("../../src/emdash/lookups.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashLookups: function () {
		return (state.deps as Record<string, unknown>).lookups;
	},
}));
vi.mock("../../src/emdash/media.js", () => ({
	// biome-ignore lint/complexity/useArrowFunction: the route calls it with new
	EmDashMedia: function () {
		return (state.deps as Record<string, unknown>).media;
	},
}));

const plugin = createPlugin();
let deps: Deps;
let cron: FakeCron;
let kv: {
	templates: MemoryKv<SavedTemplate>;
	sources: MemoryKv<SourceRow>;
	schedules: MemoryKv<ScheduleRow>;
};

beforeEach(async () => {
	deps = setup().deps;
	state.deps = deps;
	state.storage = new FakeStorage();
	cron = new FakeCron();
	kv = {
		templates: new MemoryKv(STORAGE.templates.indexes),
		sources: new MemoryKv(STORAGE.sources.indexes),
		schedules: new MemoryKv(STORAGE.schedules.indexes),
	};
	await kv.templates.put("T1", savedTemplate("T1"));
	await kv.sources.put("S1", sourceRow("S1"));
});

function context(input: unknown) {
	return {
		input,
		user: { id: "admin", role: 50 },
		storage: kv,
		cron,
		settings: { get: async () => undefined },
		taxonomies: { getAll: async () => [] },
		bylines: {},
	} as never;
}

async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
	const route = plugin.routes[name]!;
	return (await route.handler(context(route.input!.parse(input)))) as T;
}

const zero = { created: 0, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0, removed: 0 };

describe("the schedule routes (M6b)", () => {
	it("creates, lists, updates, runs and deletes a schedule, reconciling the tasks after each call", async () => {
		const input = {
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "0 3 * * *",
		};
		const { schedule } = await call<{ schedule: ScheduleView }>("schedules/create", input);
		const task = `schedule-${schedule.id}`;
		expect(schedule).toMatchObject({ name: "Nightly", armedBy: "admin", revision: 1 });
		expect(schedule.nextRunAt).toBe("2026-11-18T03:00:00.000Z");
		// The reconciliation after the call scheduled retention too (spec "Reconciliation").
		expect([...cron.tasks.keys()].sort()).toEqual([RETENTION_TASK, task].sort());
		const list = await call<Page<ScheduleView>>("schedules/list", {});
		expect(list.items.map((s) => s.id)).toEqual([schedule.id]);
		const update = { id: schedule.id, revision: 1, cron: "@hourly" };
		const updated = await call<{ schedule: ScheduleView }>("schedules/update", update);
		expect(updated.schedule).toMatchObject({ cron: "@hourly", revision: 2 });
		expect(cron.tasks.get(task)?.schedule).toBe("@hourly");
		expect(await call("schedules/run", { id: schedule.id })).toMatchObject({
			queued: true,
			schedule: { due: { at: expect.any(String) } },
		});
		expect(cron.tasks.has(PUMP_TASK)).toBe(true);
		const deleted = await call("schedules/delete", { id: schedule.id, revision: 2 });
		expect(deleted).toEqual({ deleted: true });
		expect(cron.tasks.has(task)).toBe(false);
	});

	it("refuses unknown keys, bounds, an update with no change, and templateId without templateRevision", () => {
		const input = (name: string) => plugin.routes[name]!.input!;
		const create = {
			name: "N",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "@daily",
		};
		const parses = (name: string, value: object) => input(name).safeParse(value).success;
		expect(parses("schedules/create", create)).toBe(true);
		expect(parses("schedules/create", { ...create, enable: true })).toBe(false);
		expect(parses("schedules/create", { ...create, budgetMs: 499 })).toBe(false);
		expect(parses("schedules/create", { ...create, budgetMs: 20_001 })).toBe(false);
		expect(parses("schedules/create", { ...create, batchSize: 501 })).toBe(false);
		expect(parses("schedules/create", { ...create, missing: { maxPercent: 10, x: 1 } })).toBe(false);
		expect(parses("schedules/create", { ...create, name: " N" })).toBe(false);
		expect(parses("schedules/update", { id: "A", revision: 1 })).toBe(false);
		expect(parses("schedules/update", { id: "A", revision: 1, templateId: "T2" })).toBe(false);
		expect(parses("schedules/update", { id: "A", revision: 1, missing: null })).toBe(true);
		expect(parses("schedules/run", { id: "A", forced: true })).toBe(false);
		expect(parses("schedules/delete", { id: "A" })).toBe(false);
	});

	it("refuses to delete a template or a source a schedule names (spec Ruling 10)", async () => {
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		await expect(call("templates/delete", { id: "T1", revision: 1 })).rejects.toMatchObject({
			code: "TEMPLATE_IN_USE",
			status: 409,
			details: { scheduleIds: ["A"] },
		});
		await expect(call("sources/delete", { id: "S1" })).rejects.toMatchObject({
			code: "SOURCE_IN_USE",
			status: 409,
			details: { scheduleIds: ["A"] },
		});
		expect(await kv.templates.get("T1")).not.toBeNull();
		expect(await kv.sources.get("S1")).not.toBeNull();
	});

	it("templates/update warns about the schedules pinned to another revision (spec Ruling 11)", async () => {
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly" }));
		const saved = await call<SavedResult>("templates/update", {
			id: "T1",
			revision: 1,
			description: "v2",
		});
		expect(saved.template.revision).toBe(2);
		expect(saved.check.warnings).toContain(
			"Schedule Nightly (A) runs revision 1; update it to run this revision",
		);
	});

	it("sources/update warns only when a schedule pins another URL or credential (plan Ruling 14)", async () => {
		const pin = await fingerprint({ url: "https://feeds.example/S1.csv", credential: null });
		await kv.schedules.put("A", scheduleRow("A", { name: "Nightly", sourcePin: pin }));
		const renamed = await call<SourceRow>("sources/update", { id: "S1", name: "Feed" });
		expect(renamed).not.toHaveProperty("warnings");
		const moved = await call<SourceRow & { warnings?: string[] }>("sources/update", {
			id: "S1",
			url: "https://feeds.example/other.csv",
		});
		expect(moved.warnings).toEqual([
			"Schedule Nightly (A) pins this source's URL and credential; it pauses at its next run until it is enabled again",
		]);
	});

	it("jobs/cancel pauses the job's schedule; jobs/resume hands a finalized scheduled job back to the pump", async () => {
		await cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await kv.schedules.put("A", scheduleRow("A"));
		const scheduled = { origin: "schedule", scheduleId: "A" } as const;
		await deps.jobs.put("J1", jobRow("J1", { ...scheduled, status: "running", scheduled: "open" }));
		await call("jobs/cancel", { id: "J1" });
		expect(await kv.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", jobId: "J1" },
		});
		expect(cron.tasks.has("schedule-A")).toBe(false);
		await deps.jobs.put("J2", jobRow("J2", { ...scheduled, status: "failed", scheduled: "closed" }));
		expect(await call("jobs/resume", { id: "J2" })).toMatchObject({ status: "running" });
		expect(await deps.jobs.get("J2")).toMatchObject({ scheduled: "open" });
		expect(cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("jobs/rollback of a scheduled job pauses its schedule and marks its run rolled back (spec Ruling 32)", async () => {
		const original = await importRows(deps, [{ sku: "A1", name: "Desk", price: 10 }]);
		const marked = { origin: "schedule", scheduleId: "A", scheduled: "closed" } as const;
		await deps.jobs.put(original.id, { ...original, ...marked });
		const run = { jobId: original.id, at: original.updatedAt, outcome: "completed" as const };
		await kv.schedules.put("A", scheduleRow("A", { runs: [{ ...run, counters: zero }] }));
		const rollback = await call<Job>("jobs/rollback", { id: original.id });
		expect(await kv.schedules.get("A")).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", jobId: original.id },
			runs: [{ jobId: original.id, rolledBack: { by: rollback.id, at: rollback.createdAt } }],
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/schedule-routes.test.ts tests/unit/definition.test.ts`
Expected: FAIL: no `schedules/*` routes; the in-use, warning, pause and reopen side effects are missing.

- [ ] **Step 3: The inputs and the schedule routes**

In `src/plugin/routes.ts`, import from `./schedules.js`: `cronOf`, `createSchedule`, `deleteSchedule`, `inUse`, `listSchedules`, `MAX_SCHEDULES`, `pauseSchedule`, `reconcile`, `reopenScheduled`, `runSchedule`, `type ScheduleDeps`, `type ScheduleRow`, `schedulesCollection`, `schedulesUsing`, `sourcePinOf`, `sourceWarnings`, `templateWarnings`, `updateSchedule`, `withRollback`; add `siteCheck` to the `./templates.js` import.

After `templateUpdateInput`, add:
````ts
const scheduleId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid schedule ID");
const scheduleRevision = z.number().int().min(1);
/** Spec Ruling 12: `false`, `"template"` or a lower threshold; the service checks it against the template. */
const scheduleMissing = z.union([
	z.literal(false),
	z.literal("template"),
	z.object({ maxPercent: z.number().int().min(0).max(100) }).strict(),
]);
/** The schedule options and their bounds (spec "Bounded work"). */
const scheduleOptions = {
	publish: z.boolean().optional(),
	batchSize: z.number().int().min(1).max(500).optional(),
	budgetMs: z.number().int().min(500).max(20_000).optional(),
	enabled: z.boolean().optional(),
};

/**
 * `schedules/create` (spec "Routes"). Strict (plan Ruling 15). The name follows M6a "Names"; the
 * expression is checked by the service, so its refusal is `INVALID_CRON`, not a schema error.
 */
export const SCHEDULE_CREATE_INPUT = z
	.object({
		name: templateName,
		templateId,
		templateRevision,
		sourceId,
		cron: z.string(),
		...scheduleOptions,
		missing: scheduleMissing.optional(),
	})
	.strict();

/** `schedules/update`: at least one change; a new `templateId` names its revision. */
export const SCHEDULE_UPDATE_INPUT = z
	.object({
		id: scheduleId,
		revision: scheduleRevision,
		name: templateName.optional(),
		templateId: templateId.optional(),
		templateRevision: templateRevision.optional(),
		sourceId: sourceId.optional(),
		cron: z.string().optional(),
		...scheduleOptions,
		missing: scheduleMissing.nullable().optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).some((key) => key !== "id" && key !== "revision"), {
		message: "Change at least one field",
	})
	.refine((input) => input.templateId === undefined || input.templateRevision !== undefined, {
		message: "templateId needs templateRevision",
	});
````

After `templateDeps`, add:
````ts
/** The schedule service's dependencies for one request (M6b). */
function scheduleDeps(ctx: RouteContext<unknown>, services: RouteServices): ScheduleDeps {
	const templates = templateDeps(ctx, services);
	return {
		schedules: schedulesCollection(ctx.storage),
		jobs: services.deps.jobs,
		templates: templates.templates,
		sources: services.sources.sources,
		cron: cronOf(ctx),
		templateProblems: async (template) => (await siteCheck(templates, template)).check.problems,
		now: Date.now,
		newId: () => ulid(),
	};
}

/** What a route needs to pause a schedule (spec Ruling 32). */
function scheduleWrites(ctx: RouteContext<unknown>) {
	return { schedules: schedulesCollection(ctx.storage), cron: cronOf(ctx), now: Date.now };
}

/**
 * A `schedules/*` route: the call, then a reconciliation of the cron tasks, whatever the call
 * answered (spec "Reconciliation"). A reconciliation that fails is left to the next one.
 */
function scheduleRoute<T>(
	input: z.ZodType<T>,
	run: (ctx: RouteContext<T>, deps: ScheduleDeps, actor: ActorInfo) => Promise<unknown>,
): PluginRoute<T> {
	return route(input, (ctx) =>
		withServices(ctx, async (services) => {
			const deps = scheduleDeps(ctx, services);
			try {
				return await run(ctx, deps, services.actor);
			} finally {
				await reconcile(deps).catch(() => {});
			}
		}),
	);
}
````

Add to `routes`, after `"templates/import"`:
````ts
	"schedules/create": scheduleRoute(SCHEDULE_CREATE_INPUT, async (ctx, deps, actor) => ({
		schedule: await createSchedule(deps, actor.id, ctx.input),
	})),

	"schedules/list": scheduleRoute(z.object({ cursor }).strict(), (ctx, deps) =>
		listSchedules(deps, ctx.input.cursor),
	),

	"schedules/update": scheduleRoute(SCHEDULE_UPDATE_INPUT, async (ctx, deps, actor) => ({
		schedule: await updateSchedule(deps, actor.id, ctx.input),
	})),

	"schedules/delete": scheduleRoute(
		z.object({ id: scheduleId, revision: scheduleRevision }).strict(),
		(ctx, deps) => deleteSchedule(deps, ctx.input),
	),

	// Spec Ruling 51: queues a due mark; the pump launches at its next tick.
	"schedules/run": scheduleRoute(
		z.object({ id: scheduleId, force: z.boolean().optional() }).strict(),
		async (ctx, deps) => ({ queued: true, schedule: await runSchedule(deps, ctx.input) }),
	),
````

- [ ] **Step 4: The existing routes**

`templates/update`'s handler becomes:
````ts
			withServices(ctx, async (services) => {
				const { id, revision, name, description, template } = ctx.input;
				const saved = await updateTemplate(templateDeps(ctx, services), services.actor.id, {
					id,
					revision,
					...(name === undefined ? {} : { name }),
					...(description === undefined ? {} : { description }),
					...(template === undefined ? {} : { template }),
				});
				// M6b (spec Ruling 11): the schedules still pinned to another revision.
				const using = await schedulesUsing(
					schedulesCollection(ctx.storage),
					{ templateId: id },
					MAX_SCHEDULES,
				);
				const pinned = templateWarnings(using, saved.template.revision);
				if (pinned.length === 0) return saved;
				return { ...saved, check: { ...saved.check, warnings: [...saved.check.warnings, ...pinned] } };
			}),
````

`templates/delete`'s handler becomes:
````ts
		withServices(ctx, async (services) => {
			// M6b (spec Ruling 10): never delete a template a schedule runs.
			const using = await schedulesUsing(schedulesCollection(ctx.storage), {
				templateId: ctx.input.id,
			});
			if (using.length > 0) throw inUse("Template", ctx.input.id, using);
			return deleteTemplate(templateDeps(ctx, services), ctx.input);
		}),
````

`sources/delete`'s handler becomes:
````ts
		withServices(ctx, async ({ sources }) => {
			// M6b (spec Ruling 10): never delete a source a schedule reads.
			const using = await schedulesUsing(schedulesCollection(ctx.storage), {
				sourceId: ctx.input.id,
			});
			if (using.length > 0) throw inUse("Source", ctx.input.id, using);
			return deleteSource(sources, ctx.input.id);
		}),
````

`sources/update`'s handler becomes:
````ts
		(ctx) =>
			withServices(ctx, async ({ sources }) => {
				const row = await updateSource(sources, ctx.input);
				// M6b (spec Ruling 40, plan Ruling 14): `warnings` only when a schedule pins another
				// URL or credential, so the response is unchanged otherwise.
				const using = await schedulesUsing(
					schedulesCollection(ctx.storage),
					{ sourceId: row.id },
					MAX_SCHEDULES,
				);
				const warnings = sourceWarnings(using, await sourcePinOf(row));
				return warnings.length === 0 ? row : { ...row, warnings };
			}),
````

`transition` becomes:
````ts
function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, async ({ deps, uploads, keep, sources }) => {
			const job = await changeJob(deps, uploads, ctx.input.id, action, keep);
			// A cancelled job no longer makes its source skip the next import of the same content.
			if (action === "cancel" && job.sourceId !== undefined) {
				await clearLastImport(sources, job.sourceId, job.id).catch(() => {});
			}
			// M6b (spec Ruling 32): cancelling a scheduled job pauses its schedule; best effort, as
			// the pump's finalization repeats it.
			if (action === "cancel" && job.scheduleId !== undefined) {
				await pauseSchedule(scheduleWrites(ctx), job.scheduleId, "cancelled", job.id).catch(
					() => {},
				);
			}
			// Plan Ruling 11: a finalized scheduled job that runs again is the pump's again.
			if (action === "resume" || action === "retry") {
				await reopenScheduled(deps.jobs, cronOf(ctx), job.id).catch(() => {});
			}
			return withoutPlannedTerms(job);
		}),
	);
}
````

In `jobs/rollback`, after the `clearLastImport` block:
````ts
				// M6b (spec Ruling 32, plan Ruling 12): a real rollback of a scheduled job pauses its
				// schedule and marks its run; the pump's finalization repeats both.
				if (!rollback.dryRun && original.scheduleId !== undefined) {
					const mark = (row: ScheduleRow) =>
						withRollback(row, original.id, rollback.id, rollback.createdAt);
					await pauseSchedule(
						scheduleWrites(ctx),
						original.scheduleId,
						"rolled_back",
						original.id,
						mark,
					).catch(() => {});
				}
````

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/schedule-routes.test.ts tests/unit/definition.test.ts tests/unit/template-routes.test.ts tests/unit/agent-routes.test.ts tests/unit/mcp.test.ts`
Expected: PASS (`schedule-routes.test.ts` 7 tests). `mcp.test.ts`'s consent fixture is unchanged: no schedule route is a tool (spec Ruling 50).

- [ ] **Step 6: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS; one unit file more than before this task (92 when Task 3 lands first in its wave).
```bash
git add packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/schedule-routes.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Add the schedule routes, refuse deleting a template or source a schedule uses, and pause a schedule when its job is cancelled or rolled back"
```

### Task 4: Due marks and the launch

**Files:**
- Create: `packages/flux-import/src/plugin/launch.ts`
- Test: `packages/flux-import/tests/unit/launch.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `createJobFrom`, `Services`, `JobRequest` fields; Task 2's `writeSchedule`, `paused`, `busyJob`, `sourcePinOf`, `armPump`, `scheduleTask`, `schedulesCollection`, `cronOf`, `LAUNCH_CLAIM_STALE_MS`, `WRITE_ATTEMPTS`, `ScheduleRow`, `PauseReason`, `CronPort`, and `schedule-fakes.ts`; `resolveJobTemplate` (`src/plugin/job-templates.ts:46`); `JobExistsError`, `JobError` (`src/engine/jobs.ts`); `redact` (`src/plugin/summaries.ts:111`); `Permissions` (`@emdash-cms/auth`).
- Produces: `LAUNCH_FAILURES_TO_PAUSE` (3); `LaunchDeps`; `LaunchOutcome` (`"busy" | "in_flight" | "started" | "unchanged" | "failed" | "paused"`); `errorCode(e: unknown): string`; `markDue(deps, scheduleId, scheduledAt): Promise<"marked" | "kept" | "cancelled">`; `launch(deps, row): Promise<LaunchOutcome>`; `launchDeps(ctx: PluginContext, services: Services): LaunchDeps`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/launch.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { JobError, JobExistsError } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import type { JobRequest } from "../../src/plugin/job-templates.js";
import { type LaunchDeps, launch, markDue } from "../../src/plugin/launch.js";
import {
	PUMP_SCHEDULE,
	PUMP_TASK,
	type ScheduleRow,
	sourcePinOf,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { ServiceError } from "../../src/plugin/service.js";
import type { SkippedJob } from "../../src/plugin/sources.js";
import { jobRow, NOW, scheduleDeps, scheduleRow, sourceRow } from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();

/**
 * The launch's dependencies over `scheduleDeps`: Admin "admin" (50) and editor "editor" (40);
 * `create` records each request and answers with `answer`, storing a job it returns.
 */
async function setup(extra: Partial<ScheduleRow> = {}) {
	const { deps: base, clock } = await scheduleDeps();
	const roles = new Map([
		["admin", 50],
		["editor", 40],
	]);
	const requests: JobRequest[] = [];
	const warnings: string[] = [];
	const fake = {
		answer: async (request: JobRequest): Promise<Job | SkippedJob> =>
			jobRow(request.id ?? "", { origin: "schedule", scheduleId: request.scheduleId ?? "" }),
	};
	let ids = 0;
	const deps: LaunchDeps = {
		schedules: base.schedules,
		jobs: base.jobs,
		templates: base.templates,
		sources: base.sources,
		cron: base.cron,
		userRole: async (id) => roles.get(id) ?? null,
		create: async (request) => {
			requests.push(request);
			const result = await fake.answer(request);
			if ("id" in result) await base.jobs.put(result.id, result);
			return result;
		},
		warn: (message) => {
			warnings.push(message);
		},
		now: () => clock.t,
		newId: () => `J${++ids}`,
	};
	const sourcePin = await sourcePinOf(sourceRow("S1"));
	// Due unless the test passes `due: undefined`.
	const { due, ...rest } = { due: { at: AT }, ...extra };
	await base.schedules.put("A", scheduleRow("A", { sourcePin, ...rest, ...(due ? { due } : {}) }));
	const row = async () => (await base.schedules.get("A")) as ScheduleRow;
	return { deps, base, clock, requests, warnings, fake, row };
}

describe("launch (spec \"Launch\")", () => {
	it("creates the job under the claimed ID with the schedule's options, and records it started", async () => {
		const t = await setup({ templateId: "T2", missing: { maxPercent: 5 }, due: { at: AT, force: true } });
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(t.requests).toEqual([
			{
				id: "J1",
				sourceId: "S1",
				templateId: "T2",
				templateRevision: 1,
				dryRun: false,
				force: true,
				origin: "schedule",
				scheduleId: "A",
				scheduled: "open",
				feedSourceId: "S1",
				publish: true,
				batchSize: 50,
				budgetMs: 4000,
				journal: true,
				missing: { maxPercent: 5 },
			},
		]);
		const row = await t.row();
		expect(row).toMatchObject({
			lastLaunch: { at: AT, outcome: "started", jobId: "J1" },
			launchFailures: 0,
			enabled: true,
		});
		expect(row).not.toHaveProperty("current");
		expect(row).not.toHaveProperty("due");
	});

	it.each([
		["template", {}],
		[false, { missing: false }],
	] as const)("maps the schedule's missing %j to the job options %j", async (missing, expected) => {
		const t = await setup({ templateId: "T2", missing });
		await launch(t.deps, await t.row());
		expect(t.requests[0]).toMatchObject(expected);
		if (missing === "template") expect(t.requests[0]).not.toHaveProperty("missing");
	});

	it("records unchanged content and resets the failure count", async () => {
		const t = await setup({ launchFailures: 2 });
		t.fake.answer = async () => ({ skipped: "unchanged", sourceId: "S1", uploadId: "u1" });
		expect(await launch(t.deps, await t.row())).toBe("unchanged");
		expect(await t.row()).toMatchObject({
			lastLaunch: { at: AT, outcome: "unchanged" },
			launchFailures: 0,
		});
	});

	it("is busy while another real import reads the source: records busy and clears the mark (spec Ruling 33)", async () => {
		const t = await setup();
		await t.base.jobs.put("J9", jobRow("J9", { status: "running", feedSourceId: "S1" }));
		expect(await launch(t.deps, await t.row())).toBe("busy");
		const row = await t.row();
		expect(row.lastLaunch).toEqual({ at: AT, outcome: "busy", jobId: "J9" });
		expect(row).not.toHaveProperty("due");
		expect(t.requests).toEqual([]);
	});

	it("leaves a young claim with no job in flight, and replaces a stale claim or one whose job finished (plan Ruling 20)", async () => {
		const young = { jobId: "X", claimedAt: new Date(NOW - 60_000).toISOString() };
		const t = await setup({ current: young });
		expect(await launch(t.deps, await t.row())).toBe("in_flight");
		expect(await t.row()).toMatchObject({ current: young, due: { at: AT } });
		t.clock.t += 600_000;
		expect(await launch(t.deps, await t.row())).toBe("started");
		await t.base.jobs.put("Y", jobRow("Y", { status: "completed", feedSourceId: "S1" }));
		await writeSchedule(t.base.schedules, "A", undefined, (r) => ({
			...r,
			due: { at: AT },
			current: { jobId: "Y", claimedAt: new Date(t.clock.t).toISOString() },
		}));
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(t.requests.map((r) => r.id)).toEqual(["J2", "J3"]);
	});

	it.each([
		["template_gone", "TEMPLATE_NOT_FOUND", { templateId: "nope" }],
		["template_changed", "TEMPLATE_CHANGED", { templateRevision: 2 }],
		["source_gone", "SOURCE_NOT_FOUND", { sourceId: "S9" }],
		["source_changed", "SOURCE_CHANGED", { sourcePin: "other" }],
		["creator_gone", "CREATOR_GONE", { armedBy: "ghost" }],
		["creator_gone", "CREATOR_GONE", { armedBy: "editor" }],
	] as const)("pauses %s (%s) before any fetch", async (reason, code, extra) => {
		const t = await setup();
		await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, ...extra }));
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		expect(await launch(t.deps, await t.row())).toBe("paused");
		const row = await t.row();
		expect(row).toMatchObject({
			enabled: false,
			pause: { reason, at: AT },
			lastLaunch: { at: AT, outcome: "failed", errorCode: code },
		});
		expect(row).not.toHaveProperty("current");
		expect(row).not.toHaveProperty("due");
		expect(t.base.cron.tasks.has("schedule-A")).toBe(false);
		expect(t.requests).toEqual([]);
	});

	it.each([
		["source_gone", new ServiceError("NOT_FOUND", "Source S1 not found", 404)],
		["credential_missing", new ServiceError("CREDENTIAL_MISSING", 'Credential "k" does not exist', 409)],
		["url_blocked", new ServiceError("URL_BLOCKED", "blocked", 400)],
		["too_large", new ServiceError("TOO_LARGE", "too large", 413)],
		["invalid_template", new JobError("invalid_template", "Template is invalid")],
		["invalid_template", new JobError("invalid_options", "Options are invalid")],
		["invalid_template", new JobError("invalid_source", "Missing column sku")],
	] as const)("pauses %s on the launch error %s", async (reason, error) => {
		const t = await setup();
		t.fake.answer = async () => {
			throw error;
		};
		expect(await launch(t.deps, await t.row())).toBe("paused");
		const code = error instanceof JobError ? error.code.toUpperCase() : error.code;
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason },
			lastLaunch: { outcome: "failed", errorCode: code },
		});
	});

	it("counts transient failures and pauses fetch_failed at the third; the message goes to the log only", async () => {
		const t = await setup();
		t.fake.answer = async () => {
			throw new ServiceError("HTTP_ERROR", "The server answered 503", 502);
		};
		for (const failures of [1, 2]) {
			expect(await launch(t.deps, await t.row())).toBe("failed");
			expect(await t.row()).toMatchObject({
				enabled: true,
				launchFailures: failures,
				lastLaunch: { outcome: "failed", errorCode: "HTTP_ERROR" },
			});
			await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, due: { at: AT } }));
		}
		expect(await launch(t.deps, await t.row())).toBe("paused");
		expect(await t.row()).toMatchObject({
			enabled: false,
			launchFailures: 3,
			pause: { reason: "fetch_failed" },
		});
		expect(JSON.stringify(await t.row())).not.toContain("503");
		expect(t.warnings).toHaveLength(3);
		expect(t.warnings[0]).toBe(
			"flux-import: schedule A: launch failed (HTTP_ERROR): The server answered 503",
		);
	});

	it("counts an unexpected error as a transient failure", async () => {
		const t = await setup();
		t.fake.answer = async () => {
			throw new Error("boom");
		};
		expect(await launch(t.deps, await t.row())).toBe("failed");
		expect(await t.row()).toMatchObject({
			launchFailures: 1,
			lastLaunch: { errorCode: "INTERNAL_ERROR" },
		});
	});

	it("creates one job from two overlapping launches of one due schedule (spec F19)", async () => {
		const t = await setup();
		const row = await t.row();
		const outcomes = await Promise.all([launch(t.deps, row), launch(t.deps, row)]);
		expect(outcomes.sort()).toEqual(["in_flight", "started"]);
		expect(t.requests).toHaveLength(1);
		expect((await t.base.jobs.query({ limit: 10 })).items).toHaveLength(1);
	});

	it("writes nothing once the claim changed under it (spec Ruling 34)", async () => {
		const t = await setup();
		t.fake.answer = async (request) => {
			// A route paused the schedule mid-launch, which drops the claim.
			const { current: _current, ...rest } = await t.row();
			await t.base.schedules.put("A", { ...rest, enabled: false });
			return jobRow(request.id ?? "", { origin: "schedule", scheduleId: "A" });
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		const row = await t.row();
		expect(row).not.toHaveProperty("lastLaunch");
		expect(row.due).toEqual({ at: AT });
		expect(await t.base.jobs.get("J1")).not.toBeNull();
	});

	it("takes the job an overlapping launch created under the same claim (spec F19)", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", jobRow("J1", { status: "completed", origin: "schedule", scheduleId: "A" }));
		t.fake.answer = async (request) => {
			throw new JobExistsError(request.id ?? "");
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect((await t.row()).lastLaunch).toEqual({ at: AT, outcome: "started", jobId: "J1" });
	});
});

describe("markDue (spec \"Due marks\")", () => {
	it("marks the schedule due at the event's time and arms the pump; an older mark is kept", async () => {
		const t = await setup({ due: undefined });
		const at = "2026-11-17T03:00:00.000Z";
		expect(await markDue(t.deps, "A", at)).toBe("marked");
		expect((await t.row()).due).toEqual({ at });
		expect(t.base.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		expect(await markDue(t.deps, "A", "2026-11-17T04:00:00.000Z")).toBe("kept");
		expect((await t.row()).due).toEqual({ at });
	});

	it("cancels the task of a missing or disabled schedule", async () => {
		const t = await setup({ due: undefined, enabled: false });
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await t.base.cron.schedule("schedule-B", { schedule: "0 3 * * *" });
		expect(await markDue(t.deps, "A", AT)).toBe("cancelled");
		expect(await markDue(t.deps, "B", AT)).toBe("cancelled");
		expect([...t.base.cron.tasks.keys()]).toEqual([]);
		expect(await t.row()).not.toHaveProperty("due");
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/launch.test.ts`
Expected: FAIL: `launch.js` does not exist.

- [ ] **Step 3: Write `launch.ts`**

Create `packages/flux-import/src/plugin/launch.ts`:
````ts
/** Due marks and the launch of a scheduled job (M6b spec "Due marks", "Launch"). */
import { Permissions } from "@emdash-cms/auth";
import type { PluginContext } from "emdash";
import { ulid } from "emdash";
import { JobError, JobExistsError } from "../engine/jobs.js";
import type { KvCollection } from "../engine/ports.js";
import type { Job } from "../engine/types.js";
import { type JobRequest, type ResolvedTemplate, resolveJobTemplate } from "./job-templates.js";
import {
	armPump,
	busyJob,
	type CronPort,
	cronOf,
	LAUNCH_CLAIM_STALE_MS,
	type PauseReason,
	paused,
	type ScheduleRow,
	scheduleTask,
	schedulesCollection,
	sourcePinOf,
	WRITE_ATTEMPTS,
	writeSchedule,
} from "./schedules.js";
import { ServiceError } from "./service.js";
import { createJobFrom, type Services } from "./services.js";
import type { SkippedJob, SourceRow } from "./sources.js";
import { redact } from "./summaries.js";
import { type SavedTemplate, templatesCollection } from "./templates.js";

/** Transient launch failures in a row before the schedule pauses `fetch_failed` (spec Ruling 14). */
export const LAUNCH_FAILURES_TO_PAUSE = 3;

export interface LaunchDeps {
	schedules: KvCollection<ScheduleRow>;
	jobs: KvCollection<Job>;
	templates: Pick<KvCollection<SavedTemplate>, "get">;
	sources: Pick<KvCollection<SourceRow>, "get">;
	cron: CronPort;
	/** The user's role, or null when there is no such user (`ctx.users.get`, spec Ruling 43). */
	userRole: (id: string) => Promise<number | null>;
	/** `createJobFrom` with the cron task's services (no actor) and the resolved template. */
	create: (request: JobRequest, resolved: ResolvedTemplate) => Promise<Job | SkippedJob>;
	/** `ctx.log.warn`: a launch error's message, which never goes on the schedule (spec Ruling 47). */
	warn: (message: string) => void;
	now: () => number;
	newId: () => string;
}

export type LaunchOutcome = "busy" | "in_flight" | "started" | "unchanged" | "failed" | "paused";

/** The pause each launch error code causes; any other code is transient (spec "Launch" step 5). */
const PAUSES: Readonly<Record<string, PauseReason>> = {
	SOURCE_NOT_FOUND: "source_gone",
	NOT_FOUND: "source_gone",
	CREDENTIAL_MISSING: "credential_missing",
	URL_BLOCKED: "url_blocked",
	TOO_LARGE: "too_large",
	INVALID_TEMPLATE: "invalid_template",
	INVALID_OPTIONS: "invalid_template",
	INVALID_SOURCE: "invalid_template",
};

const UNFINISHED = ["created", "running", "paused"];
const iso = (ms: number) => new Date(ms).toISOString();

/** A launch error's code: a service or route error's, a job error's in capitals, else `INTERNAL_ERROR`. */
export function errorCode(e: unknown): string {
	if (e instanceof ServiceError) return e.code;
	if (e instanceof JobError) return e.code.toUpperCase();
	const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
	return typeof code === "string" ? code : "INTERNAL_ERROR";
}

/**
 * `schedule-<id>` (spec "Due marks"): marks an enabled schedule due at the event's time and arms
 * the pump; a schedule already due keeps its older mark. A missing or disabled schedule cancels
 * its own task.
 */
export async function markDue(
	deps: Pick<LaunchDeps, "schedules" | "cron">,
	scheduleId: string,
	scheduledAt: string,
): Promise<"marked" | "kept" | "cancelled"> {
	const row = await deps.schedules.get(scheduleId);
	if (!row?.enabled) {
		await deps.cron.cancel(scheduleTask(scheduleId));
		return "cancelled";
	}
	let marked = false;
	if (!row.due) {
		const written = await writeSchedule(deps.schedules, scheduleId, row.current?.jobId, (r) =>
			r.enabled && !r.due ? { ...r, due: { at: scheduledAt } } : null,
		);
		marked = written !== null;
	}
	await armPump(deps.cron);
	return marked ? "marked" : "kept";
}

/**
 * Step 2 of the launch: claims the schedule for `jobId`. Null when the schedule is gone, disabled
 * or no longer due, or another launch is in flight. A stale claim with no job, or a claim whose
 * job has finished (a launch that crashed after creating it, whose job the pump then drove and
 * finalized), is replaced (plan Ruling 20).
 */
async function claim(deps: LaunchDeps, id: string, jobId: string): Promise<ScheduleRow | null> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await deps.schedules.getVersioned(id);
		if (!read?.value.enabled || !read.value.due) return null;
		const held = read.value.current;
		if (held) {
			const job = await deps.jobs.get(held.jobId);
			const young = deps.now() - Date.parse(held.claimedAt) < LAUNCH_CLAIM_STALE_MS;
			// In flight: a young claim with no job yet, or a claim whose job has not finished.
			if (job === null ? young : UNFINISHED.includes(job.status)) return null;
		}
		const next = { ...read.value, current: { jobId, claimedAt: iso(deps.now()) } };
		if ((await deps.schedules.compareAndSet(id, read.revision, next)).applied) return next;
	}
	return null;
}

/**
 * Step 5: one write, conditional on the claim, that clears `current` and `due` and applies
 * `change`, pausing when `reason` is set (and then cancelling the schedule's task).
 */
async function record(
	deps: LaunchDeps,
	id: string,
	jobId: string,
	change: (row: ScheduleRow) => ScheduleRow,
	reason?: PauseReason,
): Promise<void> {
	const at = iso(deps.now());
	const written = await writeSchedule(deps.schedules, id, jobId, (row) => {
		const next = change(row);
		if (reason !== undefined) return paused(next, reason, at);
		const { current: _current, due: _due, ...rest } = next;
		return rest;
	});
	if (written !== null && reason !== undefined) await deps.cron.cancel(scheduleTask(id));
}

/** A launch that failed with `code`: a pause, or one more transient failure (spec Ruling 14). */
async function failed(
	deps: LaunchDeps,
	row: ScheduleRow,
	jobId: string,
	code: string,
	reason: PauseReason | undefined,
): Promise<LaunchOutcome> {
	const lastLaunch = { at: iso(deps.now()), outcome: "failed" as const, errorCode: code };
	if (reason !== undefined) {
		await record(deps, row.id, jobId, (r) => ({ ...r, lastLaunch }), reason);
		return "paused";
	}
	const failures = row.launchFailures + 1;
	const pause = failures >= LAUNCH_FAILURES_TO_PAUSE ? "fetch_failed" : undefined;
	await record(deps, row.id, jobId, (r) => ({ ...r, lastLaunch, launchFailures: failures }), pause);
	return pause === undefined ? "failed" : "paused";
}

/** The job option for the schedule's `missing` (spec "Launch" step 4, P6). */
function missingOption(row: ScheduleRow): Pick<JobRequest, "missing"> {
	if (row.missing === undefined || row.missing === "template") return {};
	return { missing: row.missing };
}

/** One launch of a due schedule (spec "Launch"), the pump's step 4. Never throws for an expected failure. */
export async function launch(deps: LaunchDeps, due: ScheduleRow): Promise<LaunchOutcome> {
	// 1. Busy: any unfinished real import or rollback reading the source (spec Ruling 33).
	const busy = await busyJob(deps.jobs, due.sourceId);
	if (busy !== null) {
		const lastLaunch = { at: iso(deps.now()), outcome: "busy" as const, jobId: busy.id };
		await writeSchedule(deps.schedules, due.id, due.current?.jobId, (r) => {
			const { due: _due, ...rest } = r;
			return { ...rest, lastLaunch };
		});
		return "busy";
	}
	// 2. Claim.
	const jobId = deps.newId();
	const row = await claim(deps, due.id, jobId);
	if (row === null) return "in_flight";
	// 3. Pins and creator, each a pause before any fetch.
	let resolved: ResolvedTemplate;
	try {
		resolved = await resolveJobTemplate(deps.templates, row.templateId, row.templateRevision);
	} catch (e) {
		const code = errorCode(e);
		if (code === "TEMPLATE_NOT_FOUND") return failed(deps, row, jobId, code, "template_gone");
		if (code === "TEMPLATE_CHANGED") return failed(deps, row, jobId, code, "template_changed");
		return failed(deps, row, jobId, code, undefined);
	}
	const source = await deps.sources.get(row.sourceId);
	if (source === null) return failed(deps, row, jobId, "SOURCE_NOT_FOUND", "source_gone");
	if ((await sourcePinOf(source)) !== row.sourcePin) {
		return failed(deps, row, jobId, "SOURCE_CHANGED", "source_changed");
	}
	const role = await deps.userRole(row.armedBy);
	if (role === null || role < Permissions["import:execute"]) {
		return failed(deps, row, jobId, "CREATOR_GONE", "creator_gone");
	}
	// 4. Create, as jobs/create { sourceId, templateId } does, under the claimed ID.
	const request: JobRequest = {
		id: jobId,
		sourceId: row.sourceId,
		templateId: row.templateId,
		templateRevision: row.templateRevision,
		dryRun: false,
		force: row.due?.force === true,
		origin: "schedule",
		scheduleId: row.id,
		scheduled: "open",
		feedSourceId: row.sourceId,
		publish: row.publish,
		batchSize: row.batchSize,
		budgetMs: row.budgetMs,
		journal: true,
		...missingOption(row),
	};
	let result: Job | SkippedJob;
	try {
		result = await deps.create(request, resolved);
	} catch (e) {
		// An overlapping launch under the same claim created the job first (spec F19).
		const existing = e instanceof JobExistsError ? await deps.jobs.get(e.id) : null;
		if (existing === null) {
			const code = errorCode(e);
			const message = e instanceof Error ? e.message : String(e);
			deps.warn(`flux-import: schedule ${row.id}: launch failed (${code}): ${redact(message)}`);
			return failed(deps, row, jobId, code, PAUSES[code]);
		}
		result = existing;
	}
	// 5. Record.
	const at = iso(deps.now());
	if ("skipped" in result) {
		const lastLaunch = { at, outcome: "unchanged" as const };
		await record(deps, row.id, jobId, (r) => ({ ...r, lastLaunch, launchFailures: 0 }));
		return "unchanged";
	}
	const lastLaunch = { at, outcome: "started" as const, jobId: result.id };
	await record(deps, row.id, jobId, (r) => ({ ...r, lastLaunch, launchFailures: 0 }));
	return "started";
}

/** The launch's dependencies in a cron task (spec "Cron tasks and the hook"). */
export function launchDeps(ctx: PluginContext, services: Services): LaunchDeps {
	return {
		schedules: schedulesCollection(ctx.storage),
		jobs: services.deps.jobs,
		templates: templatesCollection(ctx.storage),
		sources: services.sources.sources,
		cron: cronOf(ctx),
		userRole: async (id) => {
			if (!ctx.users) throw new Error("flux-import: ctx.users is not available (users:read)");
			return (await ctx.users.get(id))?.role ?? null;
		},
		create: (request, resolved) => createJobFrom(ctx, services, request, resolved),
		warn: (message) => ctx.log.warn(message),
		now: Date.now,
		newId: () => ulid(),
	};
}
````

`failed` for a template error other than the two codes (`resolveJobTemplate` throws nothing else today) is a transient failure, as "any other error".

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/launch.test.ts`
Expected: PASS (26 tests).

- [ ] **Step 5: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS; one unit file more than before this task.
```bash
git add packages/flux-import/src/plugin/launch.ts packages/flux-import/tests/unit/launch.test.ts
git commit -m "Add due marks and the scheduled launch: busy check, claim, pins, creator check, job creation and its outcome"
```

### Task 5: The site fence, the tick caps and the pump

**Files:**
- Create: `packages/flux-import/src/emdash/fence.ts`, `packages/flux-import/src/plugin/pump.ts`
- Modify: `packages/flux-import/src/plugin/service.ts` (tick caps, `nextBatch`'s limits)
- Test: `packages/flux-import/tests/unit/fence.test.ts` (new), `packages/flux-import/tests/unit/pump.test.ts` (new), `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Task 4's `launch`, `LaunchDeps`, `LaunchOutcome`, `launchDeps`; Task 2's `writeSchedule`, `paused`, `anyOpenJob`, `armPump`, `scheduleTask`, `MAX_SCHEDULES`, `RUN_LOG_SIZE`, `WRITE_ATTEMPTS`, `PUMP_TASK`, `RunEntry`, `PauseReason`, `ScheduleRow` and `schedule-fakes.ts`; `nextBatch`, `workersBatchCap` (`src/plugin/service.ts:120`, `:417`); `clearLastImport` (`src/plugin/sources.ts:408`); `EmDashDb` (`src/emdash/locks.ts:4`); `redact`.
- Produces:
  - `fence.ts`: `type Fence = "clear" | "import" | "export" | "media" | "error"`, `readFence(db: EmDashDb): Promise<Fence>`;
  - `service.ts`: `TICK_BATCH_CAP` 6, `TICK_LINKED_BATCH_CAP` 3, `TICK_MISSING_SCAN_CAP` 20, `TICK_MISSING_BATCH_CAP` 5, `TICK_LOOKUP_BUDGET` 350, `tickBatchCap(job)`, `interface BatchLimits { maxRecords: number | ((job: Job) => number); lookupBudget: number }`, `routeLimits(workers)`, `tickLimits(workers)`, and `nextBatch(deps, uploads, id, holder, keep?, limits?)`;
  - `pump.ts`: `FINALIZE_PER_TICK` 2, `PumpDeps`, `PumpTick`, `pumpTick(deps): Promise<PumpTick>`, `pumpDeps(ctx: PluginContext, services: Services): PumpDeps`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/fence.test.ts`:
````ts
import type { Database } from "emdash";
import {
	type CompiledQuery,
	type DatabaseConnection,
	type Driver,
	Kysely,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import { readFence } from "../../src/emdash/fence.js";

/** A database whose every query is answered by `answer` (rows, or a thrown error). */
function fakeDb(answer: (sql: string, n: number) => unknown[]) {
	const queries: CompiledQuery[] = [];
	const connection: DatabaseConnection = {
		executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
			queries.push(query);
			return { rows: answer(query.sql, queries.length) as R[] };
		},
		streamQuery: () => {
			throw new Error("not used");
		},
	};
	const driver: Driver = {
		init: async () => {},
		acquireConnection: async () => connection,
		beginTransaction: async () => {},
		commitTransaction: async () => {},
		rollbackTransaction: async () => {},
		releaseConnection: async () => {},
		destroy: async () => {},
	};
	const db = new Kysely<Database>({
		dialect: {
			createAdapter: () => new SqliteAdapter(),
			createDriver: () => driver,
			createIntrospector: (k) => new SqliteIntrospector(k),
			createQueryCompiler: () => new SqliteQueryCompiler(),
		},
	});
	return { db, queries };
}

const none = { media_state: null, import_id: null, export_id: null };
const missing = (table: string) => new Error(`no such table: ${table}`);

describe("readFence (spec \"Site fence\", Fact V4)", () => {
	it.each([
		["clear", none],
		["import", { ...none, import_id: "op1" }],
		["export", { ...none, export_id: "op2" }],
		["media", { ...none, media_state: "activating" }],
		["clear", { ...none, media_state: "done" }],
	] as const)("reads %s from EmDash's single query", async (fence, row) => {
		const { db } = fakeDb(() => [row]);
		expect(await readFence(db)).toBe(fence);
	});

	it("runs EmDash's readSiteWriteFence query, with no parameters", async () => {
		const { db, queries } = fakeDb(() => [none]);
		await readFence(db);
		expect(queries).toHaveLength(1);
		const sql = queries[0]?.sql ?? "";
		expect(sql).toContain("WHERE task_key = 'incremental_capture'");
		expect(sql).toContain("state IN ('running', 'verifying')");
		expect(sql).toContain(
			"OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL)",
		);
		expect(sql).toContain("WHERE kind = 'export' AND state = 'running'");
		expect(queries[0]?.parameters).toEqual([]);
	});

	it("falls back to the media fence alone when the transfer table is missing", async () => {
		const transfer = missing("_emdash_transfer_operations");
		const activating = fakeDb((_sql, n) => {
			if (n === 1) throw transfer;
			return [{ state: "activating" }];
		});
		expect(await readFence(activating.db)).toBe("media");
		const quiet = fakeDb((_sql, n) => {
			if (n === 1) throw transfer;
			return [];
		});
		expect(await readFence(quiet.db)).toBe("clear");
		const fresh = fakeDb((_sql, n) => {
			throw n === 1 ? transfer : missing("_emdash_media_usage_activation");
		});
		expect(await readFence(fresh.db)).toBe("clear");
	});

	it("counts a read error as fenced, and reads PostgreSQL's missing relation as missing", async () => {
		const broken = fakeDb(() => {
			throw new Error("disk I/O error");
		});
		expect(await readFence(broken.db)).toBe("error");
		const postgres = fakeDb((_sql, n) => {
			if (n === 1) throw new Error('relation "_emdash_transfer_operations" does not exist');
			return [];
		});
		expect(await readFence(postgres.db)).toBe("clear");
	});
});
````

Create `packages/flux-import/tests/unit/pump.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import type { Fence } from "../../src/emdash/fence.js";
import type { Job } from "../../src/engine/types.js";
import type { JobRequest } from "../../src/plugin/job-templates.js";
import { type PumpDeps, pumpTick } from "../../src/plugin/pump.js";
import {
	PUMP_SCHEDULE,
	PUMP_TASK,
	type RunEntry,
	type ScheduleRow,
	sourcePinOf,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { importRows, setup as engineSetup } from "./rollback-fixture.js";
import { jobRow, NOW, scheduleDeps, scheduleRow, sourceRow } from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();
const zero = { created: 0, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0, removed: 0 };
const open = { origin: "schedule", scheduleId: "A", scheduled: "open" } as const;

/**
 * The pump's dependencies over `scheduleDeps`, with schedule A (on T1 and S1, pinned, armed by
 * the Admin), a fence the test sets, and a batch that records its calls and completes the job.
 */
async function setup(extra: Partial<ScheduleRow> = {}) {
	const { deps: base, clock } = await scheduleDeps();
	const state = { fence: "clear" as Fence };
	const batches: [string, string][] = [];
	const requests: JobRequest[] = [];
	const cleared: string[] = [];
	const errors: string[] = [];
	let ids = 0;
	const deps: PumpDeps = {
		schedules: base.schedules,
		jobs: base.jobs,
		templates: base.templates,
		sources: base.sources,
		cron: base.cron,
		userRole: async (id) => (id === "admin" ? 50 : null),
		create: async (request) => {
			requests.push(request);
			const job = jobRow(request.id ?? "", { ...open, scheduleId: request.scheduleId ?? "" });
			await base.jobs.put(job.id, job);
			return job;
		},
		warn: () => {},
		now: () => clock.t,
		newId: () => `N${++ids}`,
		fence: async () => state.fence,
		batch: async (id, holder) => {
			batches.push([id, holder]);
			const job = (await base.jobs.get(id)) as Job;
			const done = { ...job, status: "completed" as const, cursor: { offset: 9, seq: 1 } };
			await base.jobs.put(id, done);
			return done;
		},
		clearLastImport: async (sourceId, jobId) => {
			cleared.push(`${sourceId}/${jobId}`);
		},
		error: (message) => {
			errors.push(message);
		},
	};
	const sourcePin = await sourcePinOf(sourceRow("S1"));
	await base.schedules.put("A", scheduleRow("A", { sourcePin, ...extra }));
	await base.cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
	const row = async (id = "A") => (await base.schedules.get(id)) as ScheduleRow;
	return { deps, base, clock, state, batches, requests, cleared, errors, row };
}

/** A finished scheduled job of schedule A that read one record. */
const finished = (id: string, extra: Partial<Job> = {}) =>
	jobRow(id, { ...open, status: "completed", cursor: { offset: 9, seq: 1 }, ...extra });

describe("pumpTick (spec \"The pump\")", () => {
	it.each(["import", "export", "media", "error"] as const)(
		"stands down while the site fence reads %s: no finalization, batch, launch or write",
		async (fence) => {
			const t = await setup({ due: { at: AT } });
			t.state.fence = fence;
			await t.base.jobs.put("J1", finished("J1"));
			await t.base.jobs.put("J2", jobRow("J2", open));
			expect(await pumpTick(t.deps)).toEqual({ fence, finalized: [] });
			expect(t.batches).toEqual([]);
			expect(t.requests).toEqual([]);
			expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "open" });
			expect((await t.row()).due).toEqual({ at: AT });
		},
	);

	it("finalizes at most two finished jobs per tick", async () => {
		const t = await setup();
		for (const id of ["J1", "J2", "J3"]) await t.base.jobs.put(id, finished(id));
		expect((await pumpTick(t.deps)).finalized).toHaveLength(2);
		expect((await pumpTick(t.deps)).finalized).toHaveLength(1);
		expect((await t.row()).runs.map((r) => r.jobId).sort()).toEqual(["J1", "J2", "J3"]);
	});

	it.each([
		["completed", {}, undefined],
		["empty_feed", { cursor: { offset: 0, seq: 0 } }, "empty_feed"],
		["missing_refused", { missing: { stage: "done", fromSeq: 1, owned: 9, found: 9, rows: 0, removed: 0, verdict: "refused" } }, "missing_refused"],
		["failed", { status: "failed" }, "job_failed"],
		["cancelled", { status: "cancelled" }, "cancelled"],
	] as const)("finalizes a job as %s", async (outcome, extra, reason) => {
		const t = await setup();
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		const counters = { ...jobRow("x").counters, created: 2, removed: 1 };
		await t.base.jobs.put("J1", finished("J1", { counters, sourceId: "S1", ...(extra as Partial<Job>) }));
		await pumpTick(t.deps);
		const row = await t.row();
		const entry: RunEntry = {
			jobId: "J1",
			at: "2026-11-17T11:00:00.000Z",
			outcome,
			counters: { ...zero, created: 2, removed: 1 },
		};
		expect(row.runs).toEqual([entry]);
		if (reason === undefined) {
			expect(row).toMatchObject({ enabled: true });
			expect(t.base.cron.tasks.has("schedule-A")).toBe(true);
		} else {
			expect(row).toMatchObject({ enabled: false, pause: { reason, at: AT, jobId: "J1" } });
			expect(t.base.cron.tasks.has("schedule-A")).toBe(false);
		}
		expect(t.cleared).toEqual(outcome === "failed" ? ["S1/J1"] : []);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
	});

	it("repeats a rollback's pause and marks the run rolled back (plan Ruling 12)", async () => {
		const t = await setup();
		await t.base.jobs.put("R1", jobRow("R1", { kind: "rollback", createdAt: AT }));
		await t.base.jobs.put("J1", finished("J1", { rolledBackBy: "R1" }));
		await pumpTick(t.deps);
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason: "rolled_back", jobId: "J1" },
			runs: [{ jobId: "J1", outcome: "completed", rolledBack: { by: "R1", at: AT } }],
		});
	});

	it("writes a run log entry once, replaces it when the outcome changed, and keeps 20 (plan Ruling 11)", async () => {
		const older: RunEntry[] = Array.from({ length: 20 }, (_, i) => ({
			jobId: `OLD${i}`,
			at: AT,
			outcome: "completed",
			counters: zero,
		}));
		const t = await setup({ runs: older });
		await t.base.jobs.put("J1", finished("J1"));
		await pumpTick(t.deps);
		const first = await t.base.schedules.getVersioned("A");
		expect(first?.value.runs).toHaveLength(20);
		expect(first?.value.runs[0]).toMatchObject({ jobId: "J1", outcome: "completed" });
		expect(first?.value.runs.at(-1)?.jobId).toBe("OLD18");
		// A crash between the schedule write and the close: the same entry is not written again.
		await t.base.jobs.put("J1", finished("J1"));
		await pumpTick(t.deps);
		expect((await t.base.schedules.getVersioned("A"))?.revision).toBe(first?.revision);
		// Retried and failed: the entry is replaced at the head.
		await t.base.jobs.put("J1", finished("J1", { status: "failed" }));
		await pumpTick(t.deps);
		const runs = (await t.row()).runs;
		expect(runs.filter((r) => r.jobId === "J1")).toEqual([expect.objectContaining({ outcome: "failed" })]);
		expect(runs[0]?.jobId).toBe("J1");
	});

	it("closes a job whose schedule no longer exists, and leaves a job that runs again open", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", finished("J1", { scheduleId: "GONE" }));
		await pumpTick(t.deps);
		expect(await t.base.jobs.get("J1")).toMatchObject({ scheduled: "closed" });
		// Finalization reads the job as finished; a retry makes it run again before the close.
		await t.base.jobs.put("J2", finished("J2"));
		const getVersioned = t.base.jobs.getVersioned.bind(t.base.jobs);
		t.base.jobs.getVersioned = async (id) => {
			const read = await getVersioned(id);
			return read && id === "J2" ? { ...read, value: { ...read.value, status: "running" } } : read;
		};
		await pumpTick(t.deps);
		expect(await t.base.jobs.get("J2")).toMatchObject({ scheduled: "open" });
	});

	it("runs one batch of the oldest open job under a schedule holder, and launches nothing that tick", async () => {
		const t = await setup({ due: { at: AT } });
		await t.base.jobs.put("J1", jobRow("J1", { ...open, createdAt: "2026-11-17T11:00:02.000Z" }));
		await t.base.jobs.put("J2", jobRow("J2", { ...open, status: "running", createdAt: "2026-11-17T11:00:01.000Z" }));
		const tick = await pumpTick(t.deps);
		expect(tick).toEqual({ fence: "clear", finalized: [], batch: "J2" });
		expect(t.batches).toEqual([["J2", "schedule:A:N1"]]);
		expect(t.requests).toEqual([]);
	});

	it("treats a live lease as no batch and launches the schedule due the longest (plan Ruling 4)", async () => {
		const t = await setup({ due: { at: "2026-11-17T03:00:00.000Z" } });
		const sourcePin = (await t.row()).sourcePin;
		await t.base.schedules.put("B", scheduleRow("B", { sourcePin, due: { at: "2026-11-17T02:00:00.000Z" } }));
		const lease = { holder: "admin:x", expiresAt: NOW + 30_000 };
		await t.base.jobs.put("J1", jobRow("J1", { ...open, status: "running", lease, feedSourceId: "S9" }));
		const tick = await pumpTick(t.deps);
		expect(t.batches).toEqual([]);
		expect(tick.launch).toEqual({ scheduleId: "B", outcome: "started" });
		expect(t.requests.map((r) => r.scheduleId)).toEqual(["B"]);
	});

	it("neither finalizes nor batches a paused open job, and keeps the pump while it is open", async () => {
		const t = await setup();
		await t.base.jobs.put("J1", jobRow("J1", { ...open, status: "paused" }));
		expect(await pumpTick(t.deps)).toEqual({ fence: "clear", finalized: [] });
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("logs a batch error, which still counts as the tick's unit", async () => {
		const t = await setup({ due: { at: AT } });
		await t.base.jobs.put("J1", jobRow("J1", open));
		t.deps.batch = async () => {
			throw new Error("D1_ERROR: too many SQL variables");
		};
		expect((await pumpTick(t.deps)).batch).toBe("J1");
		expect(t.errors).toEqual(["flux-import: scheduled job J1: batch failed: D1_ERROR: too many SQL variables"]);
		expect(t.requests).toEqual([]);
	});

	it("cancels itself when idle, and re-arms when a schedule became due meanwhile (spec Ruling 36)", async () => {
		const t = await setup();
		expect((await pumpTick(t.deps)).idle).toBe("cancelled");
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(false);
		await t.base.cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
		const cancel = t.base.cron.cancel.bind(t.base.cron);
		t.base.cron.cancel = async (name) => {
			await cancel(name);
			await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, due: { at: AT } }));
		};
		expect((await pumpTick(t.deps)).idle).toBe("rearmed");
		expect(t.base.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
	});

	it("ignores a disabled schedule's due mark (plan Ruling 6)", async () => {
		const t = await setup({ enabled: false, due: { at: AT } });
		const tick = await pumpTick(t.deps);
		expect(tick).toEqual({ fence: "clear", finalized: [], idle: "cancelled" });
		expect(t.requests).toEqual([]);
	});

	it("removes nothing on an empty feed at a 100 % threshold, and pauses empty_feed (Fact E2, spec Ruling 45)", async () => {
		const engine = engineSetup().deps;
		const rules = { rules: { owner: "shop", missing: { action: "trash", maxPercent: 100 } } };
		await importRows(engine, [{ sku: "A1", name: "Desk" }], { extra: rules, sourceId: "S1" });
		const empty = await importRows(engine, [], { extra: rules, sourceId: "S1" });
		expect(empty.missing).toMatchObject({ verdict: "skipped" });
		expect(empty.counters.removed ?? 0).toBe(0);
		expect([...engine.content.entries.values()].every((e) => !e.trashed)).toBe(true);
		const t = await setup();
		await t.base.jobs.put(empty.id, { ...empty, ...open });
		await pumpTick(t.deps);
		expect(await t.row()).toMatchObject({
			enabled: false,
			pause: { reason: "empty_feed", jobId: empty.id },
			runs: [{ jobId: empty.id, outcome: "empty_feed" }],
		});
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/fence.test.ts tests/unit/pump.test.ts`
Expected: FAIL: `fence.js` and `pump.js` do not exist.

- [ ] **Step 3: Write `fence.ts`**

Create `packages/flux-import/src/emdash/fence.ts`:
````ts
import { sql } from "kysely";
import type { EmDashDb } from "./locks.js";

/**
 * Whether the site takes writes now (M6b spec "Site fence", Rulings 19, 31): `"clear"`, or what
 * fences it. flux-import stands down for a running export too, which EmDash itself does not.
 */
export type Fence = "clear" | "import" | "export" | "media" | "error";

interface FenceRow {
	media_state: string | null;
	import_id: string | null;
	export_id: string | null;
}

/**
 * EmDash's `readSiteWriteFence` query (emdash 1.2.0 `src/transfer/fence.ts`, Fact V4), word for
 * word: EmDash exports no fence API, so the internal tables are read as the lock reader reads
 * `_emdash_entry_locks`. A static query: no value is interpolated. Task 8 pins it against a site.
 */
const FENCE_QUERY = sql<FenceRow>`
	SELECT
		(
			SELECT state FROM _emdash_media_usage_activation
			WHERE task_key = 'incremental_capture'
		) AS media_state,
		(
			SELECT id FROM _emdash_transfer_operations
			WHERE kind = 'import'
				AND (
					state IN ('running', 'verifying')
					OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL)
				)
			LIMIT 1
		) AS import_id,
		(
			SELECT id FROM _emdash_transfer_operations
			WHERE kind = 'export' AND state = 'running'
			LIMIT 1
		) AS export_id
`;

const MEDIA_QUERY = sql<{ state: string }>`
	SELECT state FROM _emdash_media_usage_activation WHERE task_key = 'incremental_capture'
`;

/** EmDash's `isMissingTableError` (src/database/db-errors.ts): SQLite, D1 and PostgreSQL wording. */
function isMissingTable(e: unknown): boolean {
	const message = e instanceof Error ? e.message : String(e);
	if (message.includes("no such table")) return true;
	if (message.includes("does not exist") || message.includes("doesn't exist")) {
		return message.includes("relation") || message.includes("table");
	}
	return false;
}

/** Before the transfer tables exist, the media fence alone (as EmDash's fallback). */
async function mediaFence(db: EmDashDb): Promise<Fence> {
	try {
		const row = (await MEDIA_QUERY.execute(db)).rows[0];
		return row?.state === "activating" ? "media" : "clear";
	} catch (e) {
		return isMissingTable(e) ? "clear" : "error";
	}
}

/** One read of the site fence; a read error counts as fenced (EmDash's `TRANSFER_FENCE_CHECK_FAILED`). */
export async function readFence(db: EmDashDb): Promise<Fence> {
	let row: FenceRow | undefined;
	try {
		row = (await FENCE_QUERY.execute(db)).rows[0];
	} catch (e) {
		return isMissingTable(e) ? mediaFence(db) : "error";
	}
	if (row?.import_id) return "import";
	if (row?.export_id) return "export";
	if (row?.media_state === "activating") return "media";
	return "clear";
}
````

- [ ] **Step 4: The tick caps in `service.ts`**

After `WORKERS_LOOKUP_BUDGET`, add:
````ts
/**
 * A pump tick's batch on Workers (M6b spec "Bounded work"): the tick also finalizes, reads the
 * fence and may be one of ten tasks in one scheduled event, so its batch stays under
 * `PUMP_QUERY_TARGET` (550 D1 queries; Fact V5 measured at most 506 at these caps).
 */
export const TICK_BATCH_CAP = 6;
export const TICK_LINKED_BATCH_CAP = 3;
export const TICK_MISSING_SCAN_CAP = 20;
export const TICK_MISSING_BATCH_CAP = 5;
export const TICK_LOOKUP_BUDGET = 350;

/** `workersBatchCap` at the tick caps. */
export function tickBatchCap(job: Job): number {
	if (job.kind === "rollback") return WORKERS_ROLLBACK_BATCH_CAP;
	if (job.phase === "missing") {
		return job.missing?.stage === "count" ? TICK_MISSING_SCAN_CAP : TICK_MISSING_BATCH_CAP;
	}
	return usesLinks(job.template) || usesMedia(job.template)
		? TICK_LINKED_BATCH_CAP
		: TICK_BATCH_CAP;
}

/** The records and lookups one batch may spend: `maxRecords` and `lookupBudget` of `runBatch`. */
export interface BatchLimits {
	maxRecords: number | ((job: Job) => number);
	lookupBudget: number;
}

/** `jobs/next`'s limits: the Workers caps on Workers; on Node the job's own `batchSize`. */
export function routeLimits(workers: boolean): BatchLimits {
	return workers
		? { maxRecords: workersBatchCap, lookupBudget: WORKERS_LOOKUP_BUDGET }
		: { maxRecords: Number.POSITIVE_INFINITY, lookupBudget: Number.POSITIVE_INFINITY };
}

/** A pump tick's limits: the tick caps on Workers; on Node the job's own `batchSize` (spec Ruling 35). */
export function tickLimits(workers: boolean): BatchLimits {
	return workers
		? { maxRecords: tickBatchCap, lookupBudget: TICK_LOOKUP_BUDGET }
		: routeLimits(false);
}
````
and `nextBatch` becomes:
````ts
export async function nextBatch(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	holder: string,
	keep: UploadKeeper = keepNone,
	limits: BatchLimits = routeLimits(onWorkers()),
): Promise<Job> {
	const job = await runBatch(deps, id, holder, limits.maxRecords, limits.lookupBudget);
	await releaseQuietly(deps, uploads, job, keep);
	return job;
}
````
(`WORKERS_ROLLBACK_BATCH_CAP` is defined above `tickBatchCap` at line 68; `usesLinks` and `usesMedia` are the imports `workersBatchCap` already uses.) In `tests/unit/service.test.ts`, import `tickBatchCap` and `tickLimits` with the other `service.js` names and add after `describe("Workers caps of the missing phase (M5c)", …)`:
````ts
describe("pump tick caps (M6b, Fact V5)", () => {
	it("caps a tick's batch below a jobs/next batch on Workers, and leaves Node to batchSize", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		const tagged = { ...job, template: { ...job.template, bylines: { from: "Name" } } };
		const missing = { fromSeq: 0, owned: 0, found: 0, rows: 0, removed: 0 };
		const counting = { ...job, phase: "missing", missing: { ...missing, stage: "count" } } as unknown as Job;
		const acting = { ...job, phase: "missing", missing: { ...missing, stage: "act" } } as unknown as Job;
		expect([job, tagged, counting, acting].map(tickBatchCap)).toEqual([6, 3, 20, 5]);
		expect(tickLimits(true)).toEqual({ maxRecords: tickBatchCap, lookupBudget: 350 });
		expect(tickLimits(false)).toEqual({
			maxRecords: Number.POSITIVE_INFINITY,
			lookupBudget: Number.POSITIVE_INFINITY,
		});
	});
});
````

- [ ] **Step 5: Write `pump.ts`**

Create `packages/flux-import/src/plugin/pump.ts`:
````ts
/** The pump (M6b spec "The pump", Ruling 35): finalize, then one batch, else one launch. */
import type { PluginContext } from "emdash";
import { type Fence, readFence } from "../emdash/fence.js";
import { onWorkers } from "../emdash/workers.js";
import type { KvCollection } from "../engine/ports.js";
import type { Job } from "../engine/types.js";
import { type LaunchDeps, type LaunchOutcome, launch, launchDeps } from "./launch.js";
import {
	anyOpenJob,
	armPump,
	MAX_SCHEDULES,
	type PauseReason,
	PUMP_TASK,
	paused,
	RUN_LOG_SIZE,
	type RunEntry,
	type ScheduleRow,
	scheduleTask,
	WRITE_ATTEMPTS,
	writeSchedule,
} from "./schedules.js";
import { nextBatch, tickLimits } from "./service.js";
import type { Services } from "./services.js";
import { clearLastImport } from "./sources.js";
import { redact } from "./summaries.js";

/** Finished scheduled jobs finalized per tick (spec Ruling 37). */
export const FINALIZE_PER_TICK = 2;
const FINISHED = ["completed", "failed", "cancelled"];
const ACTIVE = ["created", "running"];

export interface PumpDeps extends LaunchDeps {
	/** The site fence (spec Ruling 19). */
	fence: () => Promise<Fence>;
	/** `nextBatch` at the tick's limits: one batch, the staged file released when the job ends. */
	batch: (id: string, holder: string) => Promise<Job>;
	/** `clearLastImport`, so a failed job's content runs again once fixed (spec Ruling 15). */
	clearLastImport: (sourceId: string, jobId: string) => Promise<void>;
	/** `ctx.log.error`. */
	error: (message: string) => void;
}

/** What one tick did, for the hook's log and the tests. */
export interface PumpTick {
	fence: Fence;
	finalized: string[];
	batch?: string;
	launch?: { scheduleId: string; outcome: LaunchOutcome };
	idle?: "cancelled" | "rearmed";
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The run log outcome of a finished job and its pause (spec "Finalization", plan Ruling 8). */
function verdictOf(job: Job): { outcome: RunEntry["outcome"]; pause?: PauseReason } {
	if (job.status === "failed") return { outcome: "failed", pause: "job_failed" };
	if (job.status === "cancelled") return { outcome: "cancelled", pause: "cancelled" };
	// The first pass read no record: the engine skipped the missing phase (Fact E2).
	if ((job.missing?.fromSeq ?? job.cursor.seq) === 0) {
		return { outcome: "empty_feed", pause: "empty_feed" };
	}
	if (job.missing?.verdict === "refused") {
		return { outcome: "missing_refused", pause: "missing_refused" };
	}
	return { outcome: "completed" };
}

function countersOf(job: Job): RunEntry["counters"] {
	const c = job.counters;
	return {
		created: c.created,
		updated: c.updated,
		unchanged: c.unchanged,
		failed: c.failed,
		conflict: c.conflict,
		locked: c.locked,
		removed: c.removed ?? 0,
	};
}

/**
 * Writes the run log entry (at the head, `RUN_LOG_SIZE` kept) and the pause, conditional on
 * `current?.jobId` (spec Ruling 34). True when the entry is recorded, was already there, or the
 * schedule is gone; false when the write lost, so the next tick finalizes the job again.
 */
async function recordRun(
	deps: PumpDeps,
	scheduleId: string,
	entry: RunEntry,
	reason: PauseReason | undefined,
): Promise<boolean> {
	const row = await deps.schedules.get(scheduleId);
	if (row === null) return true;
	const at = iso(deps.now());
	let already = false;
	const written = await writeSchedule(deps.schedules, scheduleId, row.current?.jobId, (r) => {
		const old = r.runs.find((run) => run.jobId === entry.jobId);
		if (old !== undefined && JSON.stringify(old) === JSON.stringify(entry)) {
			already = true;
			return null;
		}
		const runs = [entry, ...r.runs.filter((run) => run.jobId !== entry.jobId)].slice(
			0,
			RUN_LOG_SIZE,
		);
		return reason === undefined ? { ...r, runs } : paused({ ...r, runs }, reason, at, entry.jobId);
	});
	if (written !== null && reason !== undefined) await deps.cron.cancel(scheduleTask(scheduleId));
	return already || written !== null;
}

/** Closes the job, only while it is still finished and open (a retry may have restarted it). */
async function close(jobs: KvCollection<Job>, id: string): Promise<void> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await jobs.getVersioned(id);
		if (!read || read.value.scheduled !== "open" || !FINISHED.includes(read.value.status)) return;
		const next: Job = { ...read.value, scheduled: "closed" };
		if ((await jobs.compareAndSet(id, read.revision, next)).applied) return;
	}
}

/** Finalizes one finished scheduled job (spec "Finalization", plan Rulings 11, 12). */
async function finalize(deps: PumpDeps, job: Job): Promise<void> {
	const { outcome, pause } = verdictOf(job);
	let rolledBack: RunEntry["rolledBack"];
	if (job.rolledBackBy !== undefined) {
		const rollback = await deps.jobs.get(job.rolledBackBy);
		rolledBack = { by: job.rolledBackBy, at: rollback?.createdAt ?? job.updatedAt };
	}
	const entry: RunEntry = {
		jobId: job.id,
		at: job.updatedAt,
		outcome,
		counters: countersOf(job),
		...(rolledBack === undefined ? {} : { rolledBack }),
	};
	const reason = rolledBack === undefined ? pause : "rolled_back";
	if (job.scheduleId !== undefined && !(await recordRun(deps, job.scheduleId, entry, reason))) return;
	if (job.status === "failed" && job.sourceId !== undefined) {
		await deps.clearLastImport(job.sourceId, job.id).catch(() => {});
	}
	await close(deps.jobs, job.id);
}

/** The enabled schedules with a due mark, the oldest mark first (plan Ruling 6). */
async function dueSchedules(schedules: KvCollection<ScheduleRow>): Promise<ScheduleRow[]> {
	const rows = (await schedules.query({ limit: MAX_SCHEDULES })).items.map((i) => i.data);
	const at = (row: ScheduleRow) => row.due?.at ?? "";
	return rows
		.filter((row) => row.enabled && row.due !== undefined)
		.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

/** One pump tick (spec "The pump"). An expected failure is recorded, never thrown. */
export async function pumpTick(deps: PumpDeps): Promise<PumpTick> {
	// 1. Stand down while the site is fenced.
	const fence = await deps.fence();
	const tick: PumpTick = { fence, finalized: [] };
	if (fence !== "clear") return tick;
	// 2. Finalize, bounded.
	const done = await deps.jobs.query({
		where: { scheduled: "open", status: { in: FINISHED } },
		limit: FINALIZE_PER_TICK,
	});
	for (const { data } of done.items) {
		await finalize(deps, data);
		tick.finalized.push(data.id);
	}
	// 3. One batch of the oldest open job, unless an Admin's call holds its lease (plan Ruling 4).
	const active = await deps.jobs.query({
		where: { scheduled: "open", status: { in: ACTIVE } },
		orderBy: { createdAt: "asc" },
		limit: 1,
	});
	const oldest = active.items[0]?.data;
	if (oldest !== undefined && !(oldest.lease !== null && oldest.lease.expiresAt > deps.now())) {
		const holder = `schedule:${oldest.scheduleId ?? "none"}:${deps.newId()}`;
		try {
			await deps.batch(oldest.id, holder);
		} catch (e) {
			// The engine has already noted it on the job (P3); the batch was the tick's unit.
			const message = e instanceof Error ? e.message : String(e);
			deps.error(`flux-import: scheduled job ${oldest.id}: batch failed: ${redact(message)}`);
		}
		tick.batch = oldest.id;
		return tick;
	}
	// 4. At most one launch.
	const [due] = await dueSchedules(deps.schedules);
	if (due !== undefined) {
		tick.launch = { scheduleId: due.id, outcome: await launch(deps, due) };
		return tick;
	}
	// 5. Idle: cancel, then re-arm if a schedule became due meanwhile (spec Ruling 36).
	if (tick.finalized.length === 0 && !(await anyOpenJob(deps.jobs))) {
		await deps.cron.cancel(PUMP_TASK);
		tick.idle = "cancelled";
		if ((await dueSchedules(deps.schedules)).length > 0) {
			await armPump(deps.cron);
			tick.idle = "rearmed";
		}
	}
	return tick;
}

/** The pump's dependencies in the cron hook, with the scheduled (actorless) services. */
export function pumpDeps(ctx: PluginContext, services: Services): PumpDeps {
	return {
		...launchDeps(ctx, services),
		fence: () => readFence(services.runtime.db),
		batch: (id, holder) =>
			nextBatch(services.deps, services.uploads, id, holder, services.keep, tickLimits(onWorkers())),
		clearLastImport: (sourceId, jobId) => clearLastImport(services.sources, sourceId, jobId),
		error: (message) => ctx.log.error(message),
	};
}
````

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/fence.test.ts tests/unit/pump.test.ts tests/unit/service.test.ts tests/unit/agent-routes.test.ts`
Expected: PASS (`fence.test.ts` 8 tests, `pump.test.ts` 20 tests, one new test in `service.test.ts`); the `jobs/next` and `nextBatch on Workers` tests pass unchanged, since `routeLimits(onWorkers())` is what `nextBatch` used before.

- [ ] **Step 7: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS; two unit files more than before this task.
```bash
git add packages/flux-import/src/emdash/fence.ts packages/flux-import/src/plugin/pump.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/fence.test.ts packages/flux-import/tests/unit/pump.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Add the site fence read, the pump tick caps and the pump: finalization, one batch or one launch, and the idle check"
```

### Task 6: Bounded hourly retention

**Files:**
- Modify: `packages/flux-import/src/plugin/retention.ts`
- Test: `packages/flux-import/tests/unit/retention.test.ts`, `packages/flux-import/tests/integration/retention.test.ts`

**Interfaces:**
- Consumes: Task 2's `ScheduleRow` (as a type only: `schedules.ts` imports this file's constants, so a value import would be a cycle) and `schedule-fakes.ts`'s `scheduleRow`; Task 1's `ensureRetentionScheduled` in this file.
- Produces: `RETENTION_SCHEDULE` `"17 * * * *"`, `RETENTION_SCAN_PAGE` 20, `RETENTION_SCAN_MAX` 1,000, `RETENTION_QUERY_TARGET` 150, `RETENTION_PRUNE_MIN` 10, `RETENTION_CURSOR_KEY` `"retention:cursor"`; `interface RetentionBounds { schedules; kv; target }`; `PurgeResult` gains optional `skipped`, `more`, `queries`; `purgeExpired(deps, uploads, days, keepUploads?, bounds?)`; `ensureRetentionScheduled` re-schedules a task at another expression.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/retention.test.ts`, extend the imports:
````ts
import {
	ensureRetentionScheduled,
	purgeExpired,
	RETENTION_CURSOR_KEY,
	RETENTION_SCHEDULE,
	RETENTION_TASK,
} from "../../src/plugin/retention.js";
import type { ScheduleRow } from "../../src/plugin/schedules.js";
import { MemoryKv, makeDeps } from "./fakes.js";
import { scheduleRow } from "./schedule-fakes.js";
````
and add after `describe("purgeExpired", …)`:
````ts
/** Plugin KV in memory. */
class KvStore {
	readonly values = new Map<string, unknown>();
	async get<T>(key: string): Promise<T | null> {
		return (this.values.get(key) as T | undefined) ?? null;
	}
	async set(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}
}

/** `n` completed jobs a day old (retention 0 days), and the bounds of a run. */
async function expired(n: number) {
	const made = makeDeps();
	made.deps.source.add("u1", "sku,Name\nA,1\n");
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const job = await createJob(made.deps, { uploadId: "u1", template, schemaFields });
		await made.deps.jobs.put(job.id, { ...job, status: "completed" });
		ids.push(job.id);
	}
	made.clock.t += DAY;
	const schedules = new MemoryKv<ScheduleRow>();
	const kv = new KvStore();
	const bounds = (target: number) => ({ schedules, kv, target });
	return { ...made, ids, schedules, kv, bounds };
}

describe("bounded retention (M6b, spec Ruling 39, plan Ruling 16)", () => {
	it("never purges an open scheduled job or one a launch claim names, whatever its status", async () => {
		const { deps, ids, schedules, bounds } = await expired(3);
		const [open, claimed, plain] = ids as [string, string, string];
		await deps.jobs.put(open, { ...((await deps.jobs.get(open)) as Job), scheduled: "open" });
		const current = { jobId: claimed, claimedAt: "2026-01-01T00:00:00.000Z" };
		await schedules.put("A", scheduleRow("A", { current }));
		const result = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		expect(result.jobs).toBe(1);
		expect(await deps.jobs.get(plain)).toBeNull();
		expect(await deps.jobs.get(open)).not.toBeNull();
		expect(await deps.jobs.get(claimed)).not.toBeNull();
	});

	it("stops before a job it cannot finish within the budget, saves it as the cursor, and the next run finishes", async () => {
		const { deps, ids, kv, bounds } = await expired(3);
		// Scan page, schedules read, cursor read: 3. Each job: getVersioned, compareAndSet, three
		// row queries and the delete: 6. A third job would start with 5 < RETENTION_PRUNE_MIN left.
		const first = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(20));
		expect(first).toEqual({ jobs: 2, records: 0, journal: 0, uploads: 2, more: true, queries: 16 });
		expect(kv.values.get(RETENTION_CURSOR_KEY)).toBe(ids[2]);
		const second = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(20));
		expect(second).toEqual({ jobs: 1, records: 0, journal: 0, uploads: 2, queries: 10 });
		expect(kv.values.has(RETENTION_CURSOR_KEY)).toBe(false);
		for (const id of ids) expect(await deps.jobs.get(id)).toBeNull();
	});

	it("leaves a job cut short marked purging, and the next run finishes it", async () => {
		const { deps, ids, bounds } = await expired(1);
		const id = ids[0] as string;
		for (let seq = 0; seq < 450; seq++) {
			await deps.records.put(`${id}:${seq}`, { jobId: id, seq, status: "created" } as never);
		}
		// 3 to start, 2 to mark, four pages of 100 rows (a query and a deleteMany each), then the
		// cursor write, the one call a run makes past its target.
		const first = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(13));
		expect(first).toMatchObject({ jobs: 0, records: 400, more: true, queries: 14 });
		expect(await deps.jobs.get(id)).toMatchObject({ purging: true });
		const second = await purgeExpired(deps, new Purger(), 0, new Set(), bounds(150));
		expect(second).toMatchObject({ jobs: 1, records: 50 });
		expect(deps.records.rows.size).toBe(0);
	});

	it("skips its deletes when the scan passes RETENTION_SCAN_MAX rows", async () => {
		const { deps, ids, bounds } = await expired(1);
		const job = (await deps.jobs.get(ids[0] as string)) as Job;
		for (let i = 0; i < 1000; i++) await deps.jobs.put(`X${i}`, { ...job, id: `X${i}` });
		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 0, new Set(), bounds(150));
		expect(result).toEqual({ jobs: 0, records: 0, journal: 0, uploads: 0, skipped: 1000, queries: 50 });
		expect(purger.cutoffs).toEqual([]);
		expect(deps.jobs.rows.size).toBe(1001);
	});
});
````

In the `describe("ensureRetentionScheduled", …)` block Task 1 moved here, the first test becomes:
````ts
	it("schedules the hourly task once", async () => {
````
with `expect(scheduled).toEqual([`${RETENTION_TASK}@17 * * * *`]);`, and add:
````ts
	it("moves a pre-0.4.0 daily task to the hourly expression (spec Ruling 39)", async () => {
		const scheduled: string[] = [];
		const cron = {
			list: async () => [
				{ name: RETENTION_TASK, schedule: "0 3 * * *", nextRunAt: "", lastRunAt: null },
			],
			schedule: async (name: string, opts: { schedule: string }) => {
				scheduled.push(`${name}@${opts.schedule}`);
			},
			cancel: async () => {},
		};
		await ensureRetentionScheduled({ cron });
		expect(RETENTION_SCHEDULE).toBe("17 * * * *");
		expect(scheduled).toEqual([`${RETENTION_TASK}@17 * * * *`]);
	});
````

In `tests/integration/retention.test.ts`, the expectation `expect(task?.schedule).toBe("0 3 * * *");` becomes `expect(task?.schedule).toBe("17 * * * *");`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/retention.test.ts`
Expected: FAIL: the constants do not exist, `purgeExpired` takes no bounds and purges the open and claimed jobs, and the task is daily.

- [ ] **Step 3: Write the bounded purge**

In `src/plugin/retention.ts`:
- add `import type { PluginContext } from "emdash";` (Task 1 added it for `ensureRetentionScheduled`) and `import type { ScheduleRow } from "./schedules.js";`;
- replace `RETENTION_SCHEDULE` and its comment, and add the bounds after `RETENTION_DAYS_DEFAULT`:
````ts
/**
 * Hourly at minute 17 (M6b spec Ruling 39), off EmDash's own hourly cleanup at minute 0; EmDash
 * evaluates cron expressions in UTC on every host.
 */
export const RETENTION_SCHEDULE = "17 * * * *";
/** Job rows per scan page (spec "Bounded work"): rows are read whole, so pages stay small. */
export const RETENTION_SCAN_PAGE = 20;
/** Over this many job rows a run deletes nothing and warns (spec Ruling 39, Open issues). */
export const RETENTION_SCAN_MAX = 1_000;
/** Storage calls one run may make, scan pages included (plan Ruling 16). */
export const RETENTION_QUERY_TARGET = 150;
/** A job's purge starts only with this many calls left. */
export const RETENTION_PRUNE_MIN = 10;
/** Where a run that stopped at its budget leaves the next job to purge (plugin KV, M6a F9). */
export const RETENTION_CURSOR_KEY = "retention:cursor";
````
- `PurgeResult` gains:
````ts
	/** M6b: job rows seen when the scan passed `RETENTION_SCAN_MAX`; the run deleted nothing. */
	skipped?: number;
	/** M6b: the run stopped at its budget; the next run starts at the saved cursor. */
	more?: true;
	/** M6b: storage calls the run made, when it ran with bounds. */
	queries?: number;
````
- after `UploadPurger`, add:
````ts
/** M6b: what bounds a cron run of the purge (spec Ruling 39, plan Ruling 16). */
export interface RetentionBounds {
	/** Every schedule (at most 20, one page): a job a launch claim names is never purged. */
	schedules: Pick<KvCollection<ScheduleRow>, "query">;
	/** Plugin KV, for `RETENTION_CURSOR_KEY`. */
	kv: Pick<PluginContext["kv"], "get" | "set" | "delete">;
	/** Storage calls the run may make. */
	target: number;
}

/** The fields the purge reads from a job; the scan drops the rest of each row (spec Ruling 39). */
type Scanned = Pick<
	Job,
	| "id"
	| "kind"
	| "status"
	| "createdAt"
	| "lease"
	| "purging"
	| "scheduled"
	| "rollbackOf"
	| "uploadId"
	| "sourceUploadId"
>;
const SCANNED = [
	"id",
	"kind",
	"status",
	"createdAt",
	"lease",
	"purging",
	"scheduled",
	"rollbackOf",
	"uploadId",
	"sourceUploadId",
] as const satisfies readonly (keyof Scanned)[];

function slim(job: Job): Scanned {
	const out: Record<string, unknown> = {};
	for (const key of SCANNED) if (job[key] !== undefined) out[key] = job[key];
	return out as Scanned;
}

/** Counts each method call on `target` against the run's budget (plan Ruling 16). */
function metered<T extends object>(target: T, meter: { used: number }): T {
	return new Proxy(target, {
		get(t, key, receiver) {
			const value = Reflect.get(t, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				meter.used++;
				return Reflect.apply(value, t, args);
			};
		},
	});
}
````
- `deleteRows` takes the budget:
````ts
/** Deletes a job's rows of one collection; false when it stopped with rows left. */
async function deleteRows(
	rows: JobRows,
	jobId: string,
	count: { n: number },
	left: () => number,
): Promise<boolean> {
	for (;;) {
		// Out of budget: the job stays marked purging and the next run finishes it.
		if (left() <= 0) return false;
		const page = await rows.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return true;
		const n = await rows.deleteMany(page.items.map((i) => i.id));
		count.n += n;
		// Nothing deleted means the same page would come back forever; the next run tries again.
		if (n === 0) return false;
	}
}
````
- `purgeExpired`'s comment gains "M6b: the scan reads `RETENTION_SCAN_PAGE` rows a page and keeps only the fields it needs; over `RETENTION_SCAN_MAX` rows the run deletes nothing (`skipped`). An open scheduled job and a job a schedule's launch claim names are never purged. With `bounds`, every storage call counts against `bounds.target`: a job's purge starts only with `RETENTION_PRUNE_MIN` calls left, and a run that stops saves the job it stopped at under `RETENTION_CURSOR_KEY`, where the next run starts." and its body becomes:
````ts
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "journal" | "journalMedia" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
	keepUploads: ReadonlySet<string> = new Set(),
	bounds?: RetentionBounds,
): Promise<PurgeResult> {
	const now = deps.now();
	const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
	const meter = { used: 0 };
	const target = bounds?.target ?? Number.POSITIVE_INFINITY;
	const left = () => target - meter.used;
	const jobs = metered(deps.jobs, meter);
	const records = metered(deps.records, meter);
	const journal = metered(deps.journal, meter);
	const journalMedia = metered(deps.journalMedia, meter);
	const kv = bounds === undefined ? undefined : metered(bounds.kv, meter);
	const result = (r: PurgeResult): PurgeResult =>
		bounds === undefined ? r : { ...r, queries: meter.used };

	// The full scan behind the keep and held sets (spec Ruling 39).
	const all: Scanned[] = [];
	let cursor: string | undefined;
	do {
		const page = await jobs.query({
			limit: RETENTION_SCAN_PAGE,
			...(cursor ? { cursor } : {}),
		});
		all.push(...page.items.map((i) => slim(i.data)));
		cursor = page.hasMore ? page.cursor : undefined;
		if (cursor && all.length >= RETENTION_SCAN_MAX) {
			return result({ jobs: 0, records: 0, journal: 0, uploads: 0, skipped: all.length });
		}
	} while (cursor);

	// A launch claim's job waits for its launch, an open job for the pump's finalization.
	const claimed = new Set<string>();
	if (bounds !== undefined) {
		const schedules = await metered(bounds.schedules, meter).query({ limit: 100 });
		for (const { data } of schedules.items) if (data.current) claimed.add(data.current.jobId);
	}
	// A job marked purging is committed to deletion: a run that stopped half way (even one from
	// before spec Ruling 41, when any status was purged) is finished.
	const due = (job: Scanned) =>
		(FINISHED.has(job.status) || job.purging === true) &&
		job.createdAt < cutoff &&
		!(job.lease && job.lease.expiresAt > now) &&
		job.scheduled !== "open" &&
		!claimed.has(job.id);
	// Rollback jobs go first (when due), so an original they held can go in the same run.
	const rollbacks = all.filter((job) => job.kind === "rollback");
	const holders = new Map<string, string[]>();
	for (const { id, rollbackOf } of rollbacks) {
		if (rollbackOf !== undefined) holders.set(rollbackOf, [...(holders.get(rollbackOf) ?? []), id]);
	}
	const order = [...rollbacks, ...all.filter((job) => job.kind !== "rollback")].filter(due);
	const saved = kv === undefined ? null : await kv.get<string>(RETENTION_CURSOR_KEY);
	const at = saved === null ? -1 : order.findIndex((job) => job.id === saved);
	const queue = at <= 0 ? order : [...order.slice(at), ...order.slice(0, at)];

	const pruned = new Set<string>();
	const counts = { records: { n: 0 }, journal: { n: 0 } };
	// Marks the job before any of its rows go, so a rollback cannot start on a half-deleted
	// journal; false when the job changed since the scan (it was resumed or retried, took a
	// lease, or a rollback was created for it). The re-check comes first, so even a job already
	// marked purging keeps its rows while a batch holds its lease.
	const markPurging = async (id: string): Promise<boolean> => {
		const current = await jobs.getVersioned(id);
		if (!current || !due(current.value)) return false;
		if (isPurging(current.value)) return true;
		const job = current.value;
		if (job.kind !== "rollback" && job.rolledBackBy !== undefined) {
			if (await jobs.get(job.rolledBackBy)) return false;
		}
		const next: Job = { ...job, purging: true };
		return (await jobs.compareAndSet(id, current.revision, next)).applied;
	};
	/** False only when the budget ran out part way. */
	const prune = async (id: string): Promise<boolean> => {
		if (!(await markPurging(id))) return true;
		const complete =
			(await deleteRows(records, id, counts.records, left)) &&
			(await deleteRows(journal, id, counts.journal, left)) &&
			(await deleteRows(journalMedia, id, counts.journal, left));
		if (!complete) return left() > 0;
		await jobs.delete(id);
		pruned.add(id);
		return true;
	};
	let stopped: string | undefined;
	for (const job of queue) {
		if (left() < RETENTION_PRUNE_MIN) {
			stopped = job.id;
			break;
		}
		// An original stays while a rollback that names it stays.
		if ((holders.get(job.id) ?? []).some((rollback) => !pruned.has(rollback))) continue;
		if (!(await prune(job.id))) {
			stopped = job.id;
			break;
		}
	}
	if (kv !== undefined) {
		if (stopped !== undefined) await kv.set(RETENTION_CURSOR_KEY, stopped);
		else if (saved !== null) await kv.delete(RETENTION_CURSOR_KEY);
	}

	// Surviving jobs still read their source file (and an XLSX job's workbook), however old it is.
	const keep = new Set<string>(keepUploads);
	for (const job of all) {
		if (pruned.has(job.id)) continue;
		// A rollback job names its original's file but never reads it.
		if (job.kind === "rollback") continue;
		keep.add(job.uploadId);
		if (job.sourceUploadId !== undefined) keep.add(job.sourceUploadId);
	}
	return result({
		jobs: pruned.size,
		records: counts.records.n,
		journal: counts.journal.n,
		uploads: await uploads.purgeBefore(new Date(cutoff), keep),
		...(stopped === undefined ? {} : { more: true as const }),
	});
}
````
(The staged files are not D1 rows, so `purgeBefore` is not counted.)

- `ensureRetentionScheduled` becomes:
````ts
/** Schedules `retention` at `RETENTION_SCHEDULE`; a pre-0.4.0 daily task moves to hourly. */
export async function ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">): Promise<void> {
	if (!ctx.cron) return;
	const tasks = await ctx.cron.list();
	if (tasks.find((t) => t.name === RETENTION_TASK)?.schedule !== RETENTION_SCHEDULE) {
		await ctx.cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
	}
}
````

In the second test's arithmetic, the first run makes 16 calls (3 + 6 + 6, then the cursor write) and the second 10 (3 + 6, then the cursor delete); the third test's first run makes 14 (3 + 2 + 8, then the cursor write). If a number differs, find the uncounted or extra call before changing the expectation: the accounting is plan Ruling 16's.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/retention.test.ts tests/unit/rollback-jobs.test.ts`
Expected: PASS (5 new tests in `retention.test.ts`; the existing purge tests pass unchanged: without bounds the result has no new key).

Run: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/retention.test.ts`
Expected: PASS: `plugin:activate` scheduled `retention` at `17 * * * *`, and the hook (still the unbounded call until Task 7) purges the aged job.

- [ ] **Step 5: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS; the unit file count is unchanged by this task.
```bash
git add packages/flux-import/src/plugin/retention.ts packages/flux-import/tests/unit/retention.test.ts packages/flux-import/tests/integration/retention.test.ts
git commit -m "Make retention hourly and bounded: a slim scan with a row limit, a query budget with a saved cursor, and no purge of open or claimed scheduled jobs"
```

### Task 7: The cron hook, activation and the integration helpers

**Files:**
- Create: `packages/flux-import/src/plugin/scheduler.ts`, `packages/flux-import/tests/integration/schedules-client.ts`
- Modify: `packages/flux-import/src/plugin/definition.ts`
- Test: `packages/flux-import/tests/unit/scheduler.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 4's `markDue`; Task 5's `pumpTick`, `pumpDeps`; Task 6's `purgeExpired` bounds, `RETENTION_QUERY_TARGET`, `RETENTION_SCAN_MAX`; Task 2's `reconcile`, `scheduleIdOf`, `schedulesCollection`, `cronOf`, `PUMP_TASK`; Task 1's `withScheduledServices`.
- Produces:
  - `scheduler.ts`: `CRON_HOOK_TIMEOUT_MS` (180,000), `interface CronEvent { name: string; data?: Record<string, unknown>; scheduledAt: string }`, `cronHook(event, ctx): Promise<void>`, `activate(ctx): Promise<void>`;
  - `schedules-client.ts` (Tasks 8, 9): `type ScheduleView` re-export, `waitFor(read, done, { timeoutMs, label })`, `stopCronTimer(baseUrl)`, `runScheduled(baseUrl)`, `dueNow(dbPath, names)`, `tick(server, names)`, `dueSql(names)`, `taskNames(id)`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/definition.test.ts`, "has the retention setting, the activate hook and the cron hook" gains, before the capability list:
````ts
		expect(plugin.hooks.cron?.timeout).toBe(180_000);
		expect(plugin.admin.settingsSchema?.retentionDays).toMatchObject({
			description:
				"Job records and staged source files older than this are deleted hourly. 0 deletes them at the next hourly run.",
		});
````
in place of `expect(plugin.hooks.cron?.timeout).toBe(60_000);`.

Create `packages/flux-import/tests/unit/scheduler.test.ts`:
````ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE } from "../../src/plugin/definition.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "../../src/plugin/retention.js";
import { PUMP_SCHEDULE, PUMP_TASK, type ScheduleRow } from "../../src/plugin/schedules.js";
import { activate, cronHook } from "../../src/plugin/scheduler.js";
import { FakeStorage, MemoryKv, makeDeps } from "./fakes.js";
import { FakeCron, NOW, scheduleRow } from "./schedule-fakes.js";

// As scheduled-actor.test.ts: the runtime and plugin storage are the engine's fakes; the fence
// reads clear (its query is fence.test.ts's).
const state = vi.hoisted(() => ({ deps: undefined as unknown, storage: undefined as unknown }));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({ storage: state.storage, config: { maxUploadSize: 1000 }, db: {}, schemaRegistry: {} }),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/emdash/fence.js", () => ({ readFence: async () => "clear" }));

let cron: FakeCron;
let schedules: MemoryKv<ScheduleRow>;
const logs: string[] = [];

beforeEach(() => {
	state.deps = makeDeps().deps;
	state.storage = new FakeStorage();
	cron = new FakeCron();
	schedules = new MemoryKv(STORAGE.schedules.indexes);
	logs.length = 0;
});

function context() {
	const log = (level: string) => (message: string) => {
		logs.push(`${level}: ${message}`);
	};
	return {
		storage: { schedules, sources: new MemoryKv(STORAGE.sources.indexes), templates: new MemoryKv() },
		cron,
		kv: { get: async () => null, set: async () => {}, delete: async () => false },
		settings: { get: async () => undefined },
		taxonomies: {},
		bylines: {},
		users: { get: async () => null },
		log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
	} as never;
}

const event = (name: string) => ({ name, scheduledAt: new Date(NOW).toISOString() });

describe("cronHook (spec \"Cron tasks and the hook\")", () => {
	it("marks a schedule due from its task, and ignores a task it does not know", async () => {
		await schedules.put("A", scheduleRow("A"));
		await cronHook(event("schedule-A"), context());
		expect((await schedules.get("A"))?.due).toEqual({ at: new Date(NOW).toISOString() });
		expect(cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		await cronHook(event("something-else"), context());
		expect(cron.calls).toEqual([`schedule ${PUMP_TASK} ${PUMP_SCHEDULE}`]);
	});

	it("runs retention with its bounds, then reconciles the tasks", async () => {
		await schedules.put("A", scheduleRow("A"));
		await cron.schedule(RETENTION_TASK, { schedule: "0 3 * * *" });
		await cronHook(event(RETENTION_TASK), context());
		expect(logs).toContain("info: Removed expired import data");
		expect(cron.tasks.get(RETENTION_TASK)).toEqual({ schedule: RETENTION_SCHEDULE });
		expect(cron.tasks.get("schedule-A")).toEqual({
			schedule: "0 3 * * *",
			data: { scheduleId: "A" },
		});
	});

	it("runs a pump tick with the scheduled services, which cancels an idle pump", async () => {
		await cron.schedule(PUMP_TASK, { schedule: PUMP_SCHEDULE });
		await cronHook(event(PUMP_TASK), context());
		expect(cron.tasks.has(PUMP_TASK)).toBe(false);
	});

	it("logs and rethrows an unexpected error", async () => {
		const ctx = { ...(context() as object), storage: {} } as never;
		await expect(cronHook(event("schedule-A"), ctx)).rejects.toThrow(
			"the schedules storage collection is missing",
		);
		expect(logs).toEqual(["error: flux-import: cron task schedule-A failed"]);
	});
});

describe("activate", () => {
	it("reconciles the tasks: retention hourly, each enabled schedule's task", async () => {
		await schedules.put("A", scheduleRow("A"));
		await activate(context());
		expect([...cron.tasks.keys()].sort()).toEqual([RETENTION_TASK, "schedule-A"].sort());
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/scheduler.test.ts tests/unit/definition.test.ts`
Expected: FAIL: `scheduler.js` does not exist; the timeout is 60,000 and the description says "daily".

- [ ] **Step 3: Write `scheduler.ts`**

Create `packages/flux-import/src/plugin/scheduler.ts`:
````ts
/** The cron hook's dispatch and plugin activation (M6b spec "Cron tasks and the hook", plan Ruling 17). */
import type { PluginContext } from "emdash";
import { markDue } from "./launch.js";
import { pumpDeps, pumpTick } from "./pump.js";
import {
	purgeExpired,
	RETENTION_DAYS_DEFAULT,
	RETENTION_QUERY_TARGET,
	RETENTION_SCAN_MAX,
	RETENTION_TASK,
} from "./retention.js";
import { cronOf, PUMP_TASK, reconcile, scheduleIdOf, schedulesCollection } from "./schedules.js";
import { withScheduledServices } from "./services.js";
import { latestSourceUploads, sourcesCollection } from "./sources.js";

/** Above a launch's 120 s fetch plus job creation (spec Ruling 16). */
export const CRON_HOOK_TIMEOUT_MS = 180_000;

/** The cron hook's event (emdash 1.2.0 does not export its type). */
export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

/** `retention`: the bounded purge, then the reconciliation of the tasks (spec "Reconciliation"). */
async function retention(ctx: PluginContext): Promise<void> {
	const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
	await withScheduledServices(ctx, async ({ deps, uploads }) => {
		const schedules = schedulesCollection(ctx.storage);
		const keep = await latestSourceUploads(sourcesCollection(ctx.storage));
		const result = await purgeExpired(deps, uploads, days, keep, {
			schedules,
			kv: ctx.kv,
			target: RETENTION_QUERY_TARGET,
		});
		if (result.skipped === undefined) {
			ctx.log.info("Removed expired import data", result);
		} else {
			ctx.log.warn(
				`flux-import: retention deleted nothing: more than ${RETENTION_SCAN_MAX} jobs are kept; lower retentionDays`,
				result,
			);
		}
		const repaired = await reconcile({ schedules, jobs: deps.jobs, cron: cronOf(ctx) });
		const changed =
			repaired.scheduled.length > 0 ||
			repaired.cancelled.length > 0 ||
			repaired.pump ||
			repaired.retention;
		if (changed) ctx.log.info("Repaired the schedule tasks", repaired);
	});
}

/**
 * The plugin's cron hook: `retention`, `pump` and each `schedule-<id>`. An expected failure is
 * recorded on its schedule and never thrown; an unexpected one is logged and rethrown, which
 * EmDash logs, leaving a recurring task for its next run (spec F4).
 */
export async function cronHook(event: CronEvent, ctx: PluginContext): Promise<void> {
	try {
		if (event.name === RETENTION_TASK) {
			await retention(ctx);
			return;
		}
		if (event.name === PUMP_TASK) {
			const tick = await withScheduledServices(ctx, (services) =>
				pumpTick(pumpDeps(ctx, services)),
			);
			if (tick.batch !== undefined || tick.launch !== undefined || tick.finalized.length > 0) {
				ctx.log.info("Pump tick", tick);
			}
			return;
		}
		const id = scheduleIdOf(event.name);
		if (id !== null) {
			const deps = { schedules: schedulesCollection(ctx.storage), cron: cronOf(ctx) };
			await markDue(deps, id, event.scheduledAt);
		}
	} catch (e) {
		ctx.log.error(`flux-import: cron task ${event.name} failed`, {
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

/** `plugin:activate`: repairs every task from storage, `retention` included (plan Ruling 17). */
export async function activate(ctx: PluginContext): Promise<void> {
	await withScheduledServices(ctx, ({ deps }) =>
		reconcile({ schedules: schedulesCollection(ctx.storage), jobs: deps.jobs, cron: cronOf(ctx) }),
	);
}
````

- [ ] **Step 4: Wire it in `definition.ts`**

- Replace the imports of `pluginCollections`, `EmDashUploads`, `purgeExpired`, `RETENTION_TASK`, `ensureRetentionScheduled`, `withRuntime`, `latestSourceUploads` and `sourcesCollection` with `import { activate, CRON_HOOK_TIMEOUT_MS, cronHook } from "./scheduler.js";` (keep `RETENTION_DAYS_DEFAULT` from `./retention.js` and `routes` from `./routes.js`).
- The `retentionDays` description becomes "Job records and staged source files older than this are deleted hourly. 0 deletes them at the next hourly run." (spec P18).
- `hooks` becomes:
````ts
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await activate(ctx);
			},
			cron: {
				timeout: CRON_HOOK_TIMEOUT_MS,
				handler: (event, ctx) => cronHook(event, ctx),
			},
		},
````
`ensureRetentionScheduled` stays exported from `retention.ts` for `createJobFrom`.

- [ ] **Step 5: Write the integration helpers**

Create `packages/flux-import/tests/integration/schedules-client.ts`:
````ts
import type { ScheduleView } from "../../src/plugin/schedules.js";
import { withDb } from "./db.js";
import type { DevServer } from "./server.js";

export type { ScheduleView };

/** A cron task name this file writes into SQL: flux-import's own names and ULIDs only. */
const TASK_NAME = /^[0-9A-Za-z_-]{1,80}$/;

/** The tasks a schedule's launch needs: its due mark and the pump. */
export const taskNames = (scheduleId: string): string[] => [`schedule-${scheduleId}`, "pump"];

/** Polls `read` every 250 ms until `done` holds; fails with `label` and the last value. */
export async function waitFor<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	{ timeoutMs, label }: { timeoutMs: number; label: string },
): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last = await read();
	while (!done(last)) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
		}
		await new Promise((r) => setTimeout(r, 250));
		last = await read();
	}
	return last;
}

async function post(baseUrl: string, path: string): Promise<unknown> {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	return res.json();
}

/** Stops EmDash's cron timer for the rest of the server's life (plan Ruling 1, Fact V9). */
export async function stopCronTimer(baseUrl: string): Promise<void> {
	await post(baseUrl, "/test/stop-cron-timer");
}

/** One scheduler tick on Node: EmDash's `runScheduledTasks` through the test route (Fact V9). */
export async function runScheduled(baseUrl: string): Promise<void> {
	await post(baseUrl, "/test/run-scheduled");
}

/** The SQL that makes flux-import's `names` due now; names are checked, so the text is safe. */
export function dueSql(names: string[]): string {
	for (const name of names) {
		if (!TASK_NAME.test(name)) throw new Error(`Not a task name: ${name}`);
	}
	const list = names.map((name) => `'${name}'`).join(", ");
	return `UPDATE _emdash_cron_tasks SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE plugin_id = 'flux-import' AND task_name IN (${list})`;
}

/** Makes `names` due now in the Node site's SQLite file, with bound parameters. */
export function dueNow(dbPath: string, names: string[]): void {
	withDb(dbPath, (db) => {
		const marks = names.map(() => "?").join(", ");
		db.prepare(
			`UPDATE _emdash_cron_tasks SET next_run_at = ? WHERE plugin_id = 'flux-import' AND task_name IN (${marks})`,
		).run("2000-01-01T00:00:00.000Z", ...names);
	});
}

/** One deterministic tick on Node after `stopCronTimer`: `names` due, then one scheduler run. */
export async function tick(server: DevServer, names: string[]): Promise<void> {
	dueNow(server.dbPath, names);
	await runScheduled(server.baseUrl);
}
````

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/unit/scheduler.test.ts tests/unit/definition.test.ts`
Expected: PASS (`scheduler.test.ts` 5 tests).

- [ ] **Step 7: Run the checks and commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, 96 unit files.
```bash
git add packages/flux-import/src/plugin/scheduler.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/tests/unit/scheduler.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/integration/schedules-client.ts
git commit -m "Dispatch the cron hook to retention, the pump and due marks, reconcile on activation, and add the schedule integration helpers"
```

### Task 8: The Node integration test

**Files:**
- Create: `sites/dev/src/pages/test/stop-cron-timer.ts`, `packages/flux-import/tests/integration/schedules.test.ts`

**Interfaces:**
- Consumes: Task 7's `schedules-client.ts` and the whole plugin; `startServer`, `stopServer`, `Client`, `devBypass`, `ApiError`, `withDb`, `createUserToken`, `FeedServer`, `productsCsv`, `MALFORMED_CSV`, `template` (existing helpers).
- Produces: `POST /test/stop-cron-timer` on `sites/dev` (plan Ruling 1); the spec's integration steps 1-8. Step 9 (no MCP change) is the existing `tests/integration/mcp.test.ts`, which asserts M6c's six tool names and the stored consent against the fixture and runs in the same suite unchanged; it is not repeated here.

- [ ] **Step 1: The dev-only stop route**

Create `sites/dev/src/pages/test/stop-cron-timer.ts`:
````ts
import type { APIRoute } from "astro";
import { withEmDashRuntime } from "emdash/middleware";

export const prerender = false;

/**
 * Dev only (M6b plan Ruling 1): stops EmDash's cron timer for this server's life, so the
 * integration tests drive every scheduler tick themselves through `/test/run-scheduled`. A test
 * site route, never a plugin route: plugin routes ship to every site. A production build answers
 * 403 (`import.meta.env.DEV` is false at build time), and the call changes server state, so it
 * needs `X-EmDash-Request: 1` as `run-scheduled.ts` does.
 */
export const POST: APIRoute = async ({ request }) => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	if (request.headers.get("X-EmDash-Request") !== "1") return new Response(null, { status: 403 });
	await withEmDashRuntime((runtime) => runtime.stopCron());
	return Response.json({ stopped: true });
};
````

- [ ] **Step 2: Write the test**

Create `packages/flux-import/tests/integration/schedules.test.ts`:
````ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedResult } from "../../src/plugin/templates.js";
import { Client, devBypass } from "./client.js";
import { createUserToken, withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { MALFORMED_CSV, productsCsv, template } from "./fixtures.js";
import {
	type ScheduleView,
	stopCronTimer,
	taskNames,
	tick,
	waitFor,
} from "./schedules-client.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4390;
const COLL = "m6b_products";
const OWNED = "m6b_owned";
/** After the acceptance, schedules never come due by the clock; the test marks them (plan Ruling 18). */
const YEARLY = "0 0 1 1 *";

let server: DevServer;
let client: Client;
const feeds = new FeedServer();
/** The first schedule, its source and template, shared by steps 1-3 and 5-8. */
const a = { id: "", sourceId: "", templateId: "" };

beforeAll(async () => {
	await feeds.start();
	// URL sources here fetch from 127.0.0.1, which needs allowPrivateNetwork.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts(COLL);
	await client.createProducts(OWNED);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

async function schedule(id: string, as: Client = client): Promise<ScheduleView> {
	const page = await as.plugin<{ items: ScheduleView[] }>("schedules/list", {});
	const found = page.items.find((s) => s.id === id);
	if (!found) throw new Error(`No schedule ${id}`);
	return found;
}

async function create(input: Record<string, unknown>, as: Client = client): Promise<ScheduleView> {
	const body = { cron: YEARLY, ...input };
	return (await as.plugin<{ schedule: ScheduleView }>("schedules/create", body)).schedule;
}

async function update(id: string, change: Record<string, unknown>): Promise<ScheduleView> {
	const { revision } = await schedule(id);
	const body = { id, revision, ...change };
	return (await client.plugin<{ schedule: ScheduleView }>("schedules/update", body)).schedule;
}

/** One due mark of the schedule, then pump ticks until `done` holds (Fact V9: one tick per call). */
async function run(
	id: string,
	done: (s: ScheduleView) => boolean,
	maxTicks = 40,
): Promise<ScheduleView> {
	await tick(server, taskNames(id));
	for (let i = 0; i < maxTicks; i++) {
		const s = await schedule(id);
		if (done(s)) return s;
		await tick(server, ["pump"]);
	}
	throw new Error(`Schedule ${id} did not settle: ${JSON.stringify(await schedule(id))}`);
}

const ranAgain = (before: ScheduleView) => (s: ScheduleView) =>
	s.runs.length > 0 && s.runs[0]?.jobId !== before.runs[0]?.jobId;
const pausedFor = (reason: string) => (s: ScheduleView) => s.pause?.reason === reason;

async function source(name: string, path: string, body: string): Promise<SourceRow> {
	feeds.feeds.set(path, { body, etag: true });
	return client.plugin<SourceRow>("sources/create", { name, url: `${feeds.baseUrl}${path}` });
}

async function saved(name: string, t: object): Promise<string> {
	return (await client.plugin<SavedResult>("templates/create", { name, template: t })).template.id;
}

/** The stored row, read from SQLite: no route call while the site is fenced (step 6). */
function stored(id: string): unknown {
	return withDb(server.dbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'schedules' AND id = ?")
			.get(id) as { data: string };
		return JSON.parse(row.data);
	});
}

function authoredRows(): number[] {
	return withDb(server.dbPath, (db) => {
		const entries = db
			.prepare("SELECT COUNT(*) AS n FROM ec_m6b_products WHERE author_id IS NOT NULL")
			.get() as { n: number };
		const revisions = db
			.prepare("SELECT COUNT(*) AS n FROM revisions WHERE collection = ? AND author_id IS NOT NULL")
			.get(COLL) as { n: number };
		return [entries.n, revisions.n];
	});
}

describe("scheduled URL imports (M6b)", { timeout: 600_000 }, () => {
	it("1. launches and completes a scheduled import with no further call (the acceptance)", async () => {
		const src = await source("M6b feed", "/m6b.csv", productsCsv(20));
		a.sourceId = src.id;
		a.templateId = await saved("M6b", template(COLL));
		const created = await create({
			name: "Every minute",
			templateId: a.templateId,
			templateRevision: 1,
			sourceId: a.sourceId,
			cron: "* * * * *",
		});
		a.id = created.id;
		const done = await waitFor(
			() => schedule(a.id),
			(s) => s.runs.length >= 1,
			{ timeoutMs: 150_000, label: "the first scheduled run" },
		);
		expect(done.runs.at(-1)).toMatchObject({
			outcome: "completed",
			counters: { created: 20, updated: 0, failed: 0, removed: 0 },
		});
		const entries = await client.listAll(COLL);
		expect(entries).toHaveLength(20);
		expect(entries.every((e) => e.status === "published")).toBe(true);
		// Spec Rulings 4, 5: no author on the entries, none on their revisions.
		expect(authoredRows()).toEqual([0, 0]);
		// From here every tick is the test's (plan Ruling 18).
		await stopCronTimer(server.baseUrl);
		await update(a.id, { cron: YEARLY });
	});

	it("2. records unchanged content, then updates the two changed rows", async () => {
		const unchanged = await run(a.id, (s) => s.lastLaunch?.outcome === "unchanged" && !s.due);
		feeds.feeds.set("/m6b.csv", {
			body: productsCsv(20, (i) => (i < 2 ? `${i}.75` : `${i}.5`)),
			etag: true,
		});
		const changed = await run(a.id, ranAgain(unchanged));
		expect(changed.runs[0]).toMatchObject({
			outcome: "completed",
			counters: { created: 0, updated: 2, unchanged: 18 },
		});
	});

	it("3. pauses on a rollback and on a cancel, and is busy while the rollback runs", async () => {
		const second = (await schedule(a.id)).runs[0]?.jobId as string;
		const rollback = await client.plugin<Job>("jobs/rollback", { id: second });
		let s = await schedule(a.id);
		expect(s).toMatchObject({ enabled: false, pause: { reason: "rolled_back", jobId: second } });
		expect(s.runs[0]?.rolledBack).toEqual({ by: rollback.id, at: rollback.createdAt });
		await update(a.id, { enabled: true });
		const busy = client.plugin("schedules/run", { id: a.id });
		await expect(busy).rejects.toMatchObject({ code: "SCHEDULE_BUSY" });
		await client.runToEnd(rollback.id);
		// The rollback cleared lastImport, so the same feed runs again and re-applies the two rows.
		s = await run(a.id, ranAgain(s));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { updated: 2 } });
		// A cancel: launch on a changed feed, then cancel before the pump's first batch.
		feeds.feeds.set("/m6b.csv", { body: productsCsv(20, (i) => `${i}.25`), etag: true });
		const before = s;
		s = await run(a.id, (x) => x.lastLaunch?.outcome === "started" && x.lastLaunch.at !== before.lastLaunch?.at);
		const job = s.lastLaunch?.jobId as string;
		await client.plugin("jobs/cancel", { id: job });
		expect(await schedule(a.id)).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", jobId: job },
		});
		const finalized = await run(a.id, (x) => x.runs[0]?.jobId === job);
		expect(finalized.runs[0]?.outcome).toBe("cancelled");
	});

	it("4. removes one missing entry, refuses five, and removes nothing on an empty feed", async () => {
		const owned = {
			...template(OWNED),
			rules: { owner: "m6b", missing: { action: "trash", maxPercent: 10 } },
		};
		const src = await source("Owned feed", "/owned.csv", productsCsv(20));
		const b = await create({
			name: "Owned",
			templateId: await saved("M6b owned", owned),
			templateRevision: 1,
			sourceId: src.id,
			missing: "template",
		});
		let s = await run(b.id, (x) => x.runs.length === 1);
		feeds.feeds.set("/owned.csv", { body: productsCsv(19), etag: true });
		s = await run(b.id, ranAgain(s));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { removed: 1 } });
		feeds.feeds.set("/owned.csv", { body: productsCsv(14), etag: true });
		s = await run(b.id, pausedFor("missing_refused"));
		expect(s.runs[0]).toMatchObject({ outcome: "missing_refused", counters: { removed: 0 } });
		await update(b.id, { enabled: true });
		feeds.feeds.set("/owned.csv", { body: productsCsv(0), etag: true });
		s = await run(b.id, pausedFor("empty_feed"));
		expect(s.runs[0]).toMatchObject({ outcome: "empty_feed", counters: { removed: 0 } });
		expect(await client.listAll(OWNED)).toHaveLength(19);
		await client.plugin("schedules/delete", { id: b.id, revision: s.revision });
	});

	it("5. pauses for a changed template or source, a deleted template, a demoted creator, failed fetches and a failed job", async () => {
		await update(a.id, { enabled: true });
		// template_changed, then resumed at revision 2.
		await client.plugin("templates/update", { id: a.templateId, revision: 1, description: "v2" });
		let s = await run(a.id, pausedFor("template_changed"));
		s = await update(a.id, { templateRevision: 2, enabled: true });
		expect(s.pause).toBeUndefined();
		// source_changed, then re-armed on the new URL.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20), etag: true });
		await client.plugin("sources/update", { id: a.sourceId, url: `${feeds.baseUrl}/m6b-moved.csv` });
		s = await run(a.id, pausedFor("source_changed"));
		await update(a.id, { enabled: true });
		// template_gone: the in-use refusal blocks the route, so the row goes through withDb.
		const doomed = await saved("M6b doomed", template(COLL));
		const d = await create({ name: "Doomed", templateId: doomed, templateRevision: 1, sourceId: a.sourceId });
		withDb(server.dbPath, (db) =>
			db
				.prepare("DELETE FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'templates' AND id = ?")
				.run(doomed),
		);
		s = await run(d.id, pausedFor("template_gone"));
		await client.plugin("schedules/delete", { id: d.id, revision: s.revision });
		// creator_gone: a second Admin arms a schedule and is demoted to Editor (Fact E7).
		const second = new Client(server.baseUrl, createUserToken(server.dbPath, 50));
		const e = await create(
			{ name: "Second Admin", templateId: a.templateId, templateRevision: 2, sourceId: a.sourceId },
			second,
		);
		withDb(server.dbPath, (db) => db.prepare("UPDATE users SET role = 40 WHERE id = ?").run(e.armedBy));
		s = await run(e.id, pausedFor("creator_gone"));
		await client.plugin("schedules/delete", { id: e.id, revision: s.revision });
		// fetch_failed: three transient failures (an unknown path answers 404, HTTP_ERROR).
		feeds.feeds.delete("/m6b-moved.csv");
		for (const failures of [1, 2]) {
			s = await run(a.id, (x) => x.launchFailures === failures);
			expect(s.lastLaunch).toMatchObject({ outcome: "failed", errorCode: "HTTP_ERROR" });
		}
		s = await run(a.id, pausedFor("fetch_failed"));
		expect(s.launchFailures).toBe(3);
		// job_failed, and the re-enabled schedule imports the same content again (spec Ruling 15).
		feeds.feeds.set("/m6b-moved.csv", { body: MALFORMED_CSV, etag: true });
		await update(a.id, { enabled: true });
		s = await run(a.id, pausedFor("job_failed"));
		const failed = s.runs[0]?.jobId;
		expect(s.runs[0]?.outcome).toBe("failed");
		await update(a.id, { enabled: true });
		s = await run(a.id, (x) => pausedFor("job_failed")(x) && x.runs[0]?.jobId !== failed);
		expect(s.lastLaunch?.outcome).toBe("started");
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20), etag: true });
		await update(a.id, { enabled: true });
	});

	it("6. stands down while a site import or export runs, and resumes after (Fact V4)", async () => {
		const insert = (id: string, kind: string, state: string, started: string | null) =>
			withDb(server.dbPath, (db) =>
				db
					.prepare(
						"INSERT INTO _emdash_transfer_operations (id, kind, state, staging_secret, created_by, mutation_started_at) VALUES (?, ?, ?, 'x', 'test', ?)",
					)
					.run(id, kind, state, started),
			);
		const remove = (id: string) =>
			withDb(server.dbPath, (db) =>
				db.prepare("DELETE FROM _emdash_transfer_operations WHERE id = ?").run(id),
			);
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20, (i) => `${i}.95`), etag: true });
		for (const [id, kind] of [
			["m6b-import", "import"],
			["m6b-export", "export"],
		] as const) {
			insert(id, kind, "running", kind === "import" ? new Date().toISOString() : null);
			// Due marks still run while fenced; they write only plugin storage (spec "Site fence").
			await tick(server, taskNames(a.id));
			const fenced = stored(a.id) as ScheduleView;
			expect(fenced.due).toBeDefined();
			for (let i = 0; i < 3; i++) await tick(server, ["pump"]);
			// The pump wrote nothing: the row is as the due mark left it.
			expect(stored(a.id)).toEqual(fenced);
			remove(id);
		}
		const before = await schedule(a.id);
		const s = await run(a.id, ranAgain(before));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { updated: 20 } });
	});

	it("7. is busy while another import reads the source, and shares a scheduled job with jobs/next", async () => {
		// An Admin's real import on the same source.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20, (i) => `${i}.15`), etag: true });
		const admin = await client.plugin<Job>("jobs/create", {
			sourceId: a.sourceId,
			templateId: a.templateId,
			dryRun: false,
		});
		let s = await run(a.id, (x) => x.lastLaunch?.outcome === "busy");
		expect(s.lastLaunch?.jobId).toBe(admin.id);
		await client.runToEnd(admin.id);
		// A scheduled job an Admin pauses is not batched and keeps the next launch busy.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(120, (i) => `${i}.35`), etag: true });
		const before = s;
		s = await run(a.id, (x) => x.lastLaunch?.outcome === "started" && x.lastLaunch.at !== before.lastLaunch?.at);
		const job = s.lastLaunch?.jobId as string;
		await client.plugin("jobs/pause", { id: job });
		const pausedJob = await client.plugin<Job>("jobs/get", { id: job });
		await tick(server, ["pump"]);
		expect((await client.plugin<Job>("jobs/get", { id: job })).counters).toEqual(pausedJob.counters);
		s = await run(a.id, (x) => x.lastLaunch?.outcome === "busy" && x.lastLaunch.jobId === job);
		// Resumed: one batch through jobs/next, the rest by the pump, sharing the lease.
		await client.plugin("jobs/resume", { id: job });
		await client.plugin<Job>("jobs/next", { id: job });
		s = await run(a.id, (x) => x.runs[0]?.jobId === job);
		const done = await client.plugin<Job>("jobs/get", { id: job });
		const { created, updated, unchanged, failed } = done.counters;
		expect([created + updated + unchanged, failed]).toEqual([120, 0]);
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { created, updated, unchanged } });
		expect(authoredRows()).toEqual([0, 0]);
	});

	it("8. runs now with force on unchanged content", async () => {
		const before = await schedule(a.id);
		const queued = await client.plugin<{ queued: true; schedule: ScheduleView }>("schedules/run", {
			id: a.id,
			force: true,
		});
		expect(queued.schedule.due).toMatchObject({ force: true });
		let s = queued.schedule;
		for (let i = 0; i < 40 && !ranAgain(before)(s); i++) {
			await tick(server, ["pump"]);
			s = await schedule(a.id);
		}
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { unchanged: 120 } });
		expect(s.lastLaunch?.outcome).toBe("started");
	});
});
````

Notes the implementer checks while running it:
- In step 5 a schedule pinned to revision 2 is created through `second` after `templates/update`, so `templateRevision: 2` is right; step 7's `jobs/create` uses the template's current revision (none given).
- Step 6 reads the schedule row from SQLite while a transfer row is present, so no route call meets EmDash's own fence, and compares the whole row before and after the fenced ticks: a pump that wrote anything (a claim, a run, `lastLaunch`) fails it. It also pins the fence query against EmDash's real tables, as M2 pinned `_emdash_entry_locks` (spec "Site fence").

- [ ] **Step 3: Run it**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/schedules.test.ts`
Expected: PASS (8 tests) in about 6-8 minutes; step 1 alone waits up to 150 s for EmDash's real timer. If a step times out, read the `Timed out`/`did not settle` message: it carries the schedule row, whose `lastLaunch.errorCode` and `pause.reason` say why; the job's message is in `jobs/get`. On "Port … is in use", check `ss -ltnp` (Fact F3).

Then run the whole integration suite: `pnpm test:integration` (repo root). Expected: PASS, with `retention.test.ts` reading `17 * * * *` (Task 6) and `mcp.test.ts` unchanged (step 9).

- [ ] **Step 4: Commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint`
```bash
git add sites/dev/src/pages/test/stop-cron-timer.ts packages/flux-import/tests/integration/schedules.test.ts
git commit -m "Add the Node integration test of scheduled imports and the dev-only route that stops the cron timer"
```

### Task 9: The workerd parity test

**Files:**
- Create: `sites/dev-cf/src/pages/test/stop-cron-timer.ts`
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts` (one test, last in the file)

**Interfaces:**
- Consumes: Task 7's `dueSql`, `taskNames`, `ScheduleView`; Task 5's `TICK_BATCH_CAP`; the file's `client`, `d1`, `sleep`, `FeedServer`, `productsCsv`, `template`.
- Produces: `POST /test/stop-cron-timer` on `sites/dev-cf` (plan Ruling 1); spec "Cloudflare parity" (Ruling 41): the acceptance sequence and the missing-entries refusal driven only by `GET /cdn-cgi/handler/scheduled`.

- [ ] **Step 1: The dev-only stop route**

Create `sites/dev-cf/src/pages/test/stop-cron-timer.ts` with the same content as `sites/dev/src/pages/test/stop-cron-timer.ts` (Task 8 Step 1), byte for byte: `withEmDashRuntime` and `stopCron()` are the same under the Cloudflare adapter's `astro dev` (Fact V9 stopped the timer on both).

- [ ] **Step 2: Write the test**

In `tests/integration-cf/parity.test.ts`, add to the imports `import { TICK_BATCH_CAP } from "../../src/plugin/service.js";` (beside `WORKERS_BATCH_CAP`) and `import { dueSql, type ScheduleView, taskNames } from "../integration/schedules-client.js";`, and add as the last test of `describe("workerd parity (D1, R2)", …)`; it stops the timer, so nothing may follow it:
````ts
	it("runs M6b schedules on D1 only in step with scheduled events, one unit per event", async () => {
		const stop = await fetch(`${client.baseUrl}/test/stop-cron-timer`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		expect(stop.status).toBe(200);
		const scheduled = async (names: string[]) => {
			d1(dueSql(names));
			const res = await fetch(`${client.baseUrl}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
			expect(res.status).toBe(200);
		};
		const scheduleOf = async (id: string) => {
			const page = await client.plugin<{ items: ScheduleView[] }>("schedules/list", {});
			return page.items.find((s) => s.id === id) as ScheduleView;
		};
		/** What a unit moves: the schedule's last launch and run count, and its job's position. */
		const progress = async (id: string) => {
			const s = await scheduleOf(id);
			const jobId = s.lastLaunch?.jobId;
			const job = jobId === undefined ? null : await client.plugin<Job>("jobs/get", { id: jobId });
			return {
				launch: s.lastLaunch?.at ?? null,
				runs: s.runs.length,
				job: job === null ? null : { id: job.id, status: job.status, seq: job.cursor.seq },
			};
		};
		const feeds = new FeedServer();
		await feeds.start();
		try {
			await client.createProducts("cf_m6b");
			feeds.feeds.set("/m6b.csv", { body: productsCsv(20), etag: true });
			const source = await client.plugin<SourceRow>("sources/create", {
				name: "M6b feed",
				url: feeds.url("/m6b.csv"),
			});
			const saved = await client.plugin<SavedResult>("templates/create", {
				name: "CF M6b",
				template: template("cf_m6b"),
			});
			const { schedule } = await client.plugin<{ schedule: ScheduleView }>("schedules/create", {
				name: "CF M6b",
				templateId: saved.template.id,
				templateRevision: 1,
				sourceId: source.id,
				cron: "0 0 1 1 *",
			});
			// The acceptance sequence: one due mark, then pump events only. Each event moves the
			// schedule by at most one unit, and nothing moves in the 15 s between events.
			let names = taskNames(schedule.id);
			let before = await progress(schedule.id);
			for (let i = 0; i < 12 && before.runs === 0; i++) {
				await scheduled(names);
				names = ["pump"];
				const after = await progress(schedule.id);
				const launched = after.launch !== before.launch;
				const moved = after.job === null ? 0 : after.job.seq - (before.job?.seq ?? 0);
				// A launch is the unit of its tick: no batch ran beside it.
				if (launched) expect(moved).toBe(0);
				else expect(moved).toBeLessThanOrEqual(TICK_BATCH_CAP);
				await sleep(15_000);
				expect(await progress(schedule.id)).toEqual(after);
				before = after;
			}
			const done = await scheduleOf(schedule.id);
			expect(done.runs[0]).toMatchObject({ outcome: "completed", counters: { created: 20 } });
			expect(await client.listAll("cf_m6b")).toHaveLength(20);

			// The missing-entries refusal (spec step 4), events only.
			await client.createProducts("cf_m6b_owned");
			const owned = {
				...template("cf_m6b_owned"),
				rules: { owner: "cf-m6b", missing: { action: "trash", maxPercent: 10 } },
			};
			feeds.feeds.set("/owned.csv", { body: productsCsv(20), etag: true });
			const ownedSource = await client.plugin<SourceRow>("sources/create", {
				name: "M6b owned feed",
				url: feeds.url("/owned.csv"),
			});
			const ownedTemplate = await client.plugin<SavedResult>("templates/create", {
				name: "CF M6b owned",
				template: owned,
			});
			const { schedule: b } = await client.plugin<{ schedule: ScheduleView }>("schedules/create", {
				name: "CF M6b owned",
				templateId: ownedTemplate.template.id,
				templateRevision: 1,
				sourceId: ownedSource.id,
				cron: "0 0 1 1 *",
				missing: "template",
			});
			const drive = async (done: (s: ScheduleView) => boolean) => {
				await scheduled(taskNames(b.id));
				for (let i = 0; i < 60; i++) {
					const s = await scheduleOf(b.id);
					if (done(s)) return s;
					await scheduled(["pump"]);
				}
				throw new Error(`Schedule ${b.id} did not settle: ${JSON.stringify(await scheduleOf(b.id))}`);
			};
			await drive((s) => s.runs.length === 1);
			feeds.feeds.set("/owned.csv", { body: productsCsv(14), etag: true });
			const refused = await drive((s) => s.pause?.reason === "missing_refused");
			expect(refused.runs[0]).toMatchObject({ outcome: "missing_refused", counters: { removed: 0 } });
			expect(await client.listAll("cf_m6b_owned")).toHaveLength(20);
		} finally {
			await feeds.stop();
		}
	});
````

- [ ] **Step 3: Run it**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M6b"`
Expected: PASS in about 3-4 minutes (the 15 s waits of the acceptance sequence: 20 rows at `TICK_BATCH_CAP` 6 are a launch, four batches and a finalization). Then the whole parity suite: `pnpm test:cf` (repo root). Expected: PASS. If the one-off workerd `500 INTERNAL_ERROR` "Plugin route error" appears (Fact F2), capture the server log for the Task 10 note.

- [ ] **Step 4: Commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint`
```bash
git add sites/dev-cf/src/pages/test/stop-cron-timer.ts packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Add the workerd parity test of scheduled imports, driven only by scheduled events"
```

### Task 10: The review run, the note, the spec and the roadmap

**Files:**
- Create: `docs/superpowers/notes/2026-11-17-m6b-review.md`
- Modify: `docs/superpowers/specs/2026-11-17-flux-import-m6b-scheduled-imports-design.md` (amendments and open issues), `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (the M6b row)
- Temporarily (never committed): a D1 counter in `sites/dev-cf/src/pages/test/d1-count.ts` and a measuring script in `.superpowers/wt/scratch-m6b-review/`

**Interfaces:**
- Consumes: everything above.
- Produces: the review note; V5 on the final code; the manual check on both runtimes; the spec's amendments for plan Rulings 1-20 and Facts E1, E2, E4, V7; the roadmap row "Done".

- [ ] **Step 1: Every suite**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: PASS: 96 unit files, every integration and parity test. Record the counts, the run times and any flake (Facts F1-F3) in the note's "Checks".

- [ ] **Step 2: V5 on the final code (the D1 count of a worst tick)**

Spec V5's question, on the shipped code instead of Task 0's emulation: the D1 queries of one scheduled event on `sites/dev-cf` stay under 900 with eight due marks, a pump tick running one batch at the tick caps, and retention.
1. Add, uncommitted, `sites/dev-cf/src/pages/test/d1-count.ts`: a dev-only (`import.meta.env.DEV`, `X-EmDash-Request: 1`) `POST` route whose `{ action: "start" }` wraps `prepare` on the prototype of `env.DB` (`import { env } from "cloudflare:workers"`) with a counter and whose `{ action: "stop" }` restores it and answers `{ queries }`, as Task 0's `probe/d1` did. Never under `packages/`.
2. With a scratch script in `.superpowers/wt/scratch-m6b-review/` (the PAT from dev-bypass in process memory only; never in a file), on a fresh `sites/dev-cf` (`rm -rf sites/dev-cf/.wrangler/state`, `node node_modules/astro/bin/astro.mjs dev --ignore-lock`): stop the timer; create eight schedules on one template and source, with one open scheduled job of a linked template mid-run (Task 0's worst batch: references, taxonomies and bylines, an update batch); then make all eight `schedule-*` tasks, `pump` and `retention` due with `wrangler d1 execute` and send one `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*` between `start` and `stop`.
3. Measure each part alone as Task 0 did: a quiet event, one due mark, the pump idle, finalization only, a launch, a plain batch and a linked batch at the tick caps, retention at its budget. Record the table beside Task 0's (b-facts "V5").
Expected: the worst event under 900 queries and every pump batch at most 550. If a number is over, stop and report rather than raise a cap here: a cap change is a spec change.
4. Remove the route and the script; `git status` shows nothing of them; `sites/dev-cf/.wrangler/state` reset.

- [ ] **Step 3: The manual check (the acceptance, both runtimes)**

1. `sites/dev` on a throwaway database through the integration harness's `startServer` (a scratch script under `.superpowers/wt/scratch-m6b-review/`), the feed server serving 20 rows, a template and a source, and a schedule with `cron: "*/2 * * * *"`; leave it alone for 10 minutes and change the feed once (two rows) after about 4 minutes. Record each launch outcome (`schedules/list`), the run log, the jobs and their counters (`jobs/list`, `jobs/get`), and in the admin: the entries published, no author on them, the revision history showing no one for the scheduled writes.
2. The same on `sites/dev-cf`, with the timer stopped and a loop sending one scheduled event every 20 s for 10 minutes (making `schedule-<id>` due every sixth event, `pump` every event).
3. Note anything a person would trip over (the list's codes, a pause reason, the settings text).

- [ ] **Step 4: The review note**

Create `docs/superpowers/notes/2026-11-17-m6b-review.md`, structured as the M6c note (`docs/superpowers/notes/2026-11-16-m6c-review.md`):
````markdown
# M6b review: scheduled URL imports

Branch `m6b-scheduled-imports`, plan `docs/superpowers/plans/2026-11-17-flux-import-m6b-scheduled-imports.md`,
spec `docs/superpowers/specs/2026-11-17-flux-import-m6b-scheduled-imports-design.md`.

Date: … · Commit: `…` (checks, measurements and the manual run), docs on top · Node: v22.23.1 · EmDash 1.2.0

## Checks
(the five commands, counts, run times, flakes)

## Facts V1-V11
(each fact's result from the plan's Task 0 table, and V5 again on the final code with the table of Step 2)

## Review Focus
(the plan's five items, each with the test or measurement that answers it)

## The manual run
(Step 3, both runtimes)

## Rulings
(plan Rulings 1-20, each with what the code does now)

## Deviations from the plan
(anything the implementation changed, with the reason)

## Open issues
(spec "Open issues" carried forward: production D1 per tick (V2), F17's production build, more than 1,000 jobs for retention, a disabled creator undetectable (F13), links with no source (P17); plus anything new)
````
Fill every section from the runs; leave no placeholder.

- [ ] **Step 5: The spec's amendments and the roadmap row**

In the spec, add under "Rulings" an "Amendments from the plan and review" list, one line each, naming the plan ruling or fact: Ruling 45's engine change dropped (Fact E2, plan Ruling 8); the busy index `["feedSourceId", "status"]` with dry runs filtered in code (Fact E4, plan Ruling 2); flux-import's own field grammar for `cron` (Fact E1, plan Ruling 3); F5 on workerd: a timed-out handler is abandoned (Fact V7); F16's timer ticks not reproduced (Fact V9); V5's "nine marks + pump + retention" is eleven tasks, of which a tick claims ten, so eight marks were measured; the stop-timer route in the test sites (plan Ruling 1); a launch replaces a claim whose job exists (plan Ruling 20); `schedules/update` schedules the task before writing (plan Ruling 5); a disabled schedule is never due (plan Ruling 6); routes are busy during a launch claim (plan Ruling 7); resumed or retried finalized jobs reopen (plan Ruling 11); finalization repeats a rollback's pause (plan Ruling 12). Add the review's new open issues to "Open issues".

In the roadmap, the M6b row's last cell becomes `Done ([review](../notes/2026-11-17-m6b-review.md))`, and its description says what shipped in the row's existing style (the M6c row is the model); adjust a claim the review disproved.

- [ ] **Step 6: Commit**

Run (repo root): `pnpm format && pnpm lint`, then `git status`: only the note, the spec and the roadmap.
```bash
git add docs/superpowers/notes/2026-11-17-m6b-review.md docs/superpowers/specs/2026-11-17-flux-import-m6b-scheduled-imports-design.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 6b review results, amend the spec and mark M6b done in the roadmap"
```

## After this plan

M6b is done when Task 10's commit is in and the tree is clean. Open the pull request into `claude/adoring-hawking-y7zfj2` with the summary of the note's Checks and Rulings and its test plan (the five commands); no attribution trailer. Next is M6d (AI mapping suggestions), which also adds the schedule tools to M6c's list, so sites re-consent once (spec Ruling 50).
