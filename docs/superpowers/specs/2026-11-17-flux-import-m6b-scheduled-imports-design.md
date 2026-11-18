# Flux Import M6b: scheduled URL imports

Status: drafted 2026-11-17 (the user approved all remaining milestones up front on 2026-10-27;
design decisions are the implementer's rulings), and revised the same day after the spec review
(Rulings 31-52; amended rulings and sections are marked), then amended after implementation and
the review on 2026-11-18 (Rulings 53-85, [review](../notes/2026-11-17-m6b-review.md)). Third of four
parts of Milestone 6 (Automation) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-6-split), in the order M6a, M6c,
M6b, M6d (M6a spec, Ruling 35). Builds on M6c
([spec](./2026-11-16-flux-import-m6c-mcp-tools-design.md),
[review](../notes/2026-11-16-m6c-review.md)), merged at `1a96d4a`, and on M6a
([spec](./2026-11-16-flux-import-m6a-templates-design.md),
[review](../notes/2026-11-16-m6a-review.md)). It meets the other half of the milestone's
acceptance: **a scheduled import runs unattended**. It settles what M6a and M6c left to it: the
schedule's job options (M6a Ruling 12), a template deleted under a schedule (M6a Rulings 20, 45),
and the four points M6c handed on (M6c Ruling 43): lease competition, Ruling 9's extra run and the
`start_import` hand-off are settled here; `list_sources` with URL tokens redacted moves to M6d
with the other tools (Ruling 50).

## Goal

Today a job advances only when a client calls `jobs/next` (Admin, REST) or `next_batch` (agent,
MCP), one batch per call (P3). A feed that should be imported every night needs someone, or
something outside EmDash, to make those calls. M6b moves that into the site:

1. **A schedule** names a saved template (at a pinned revision), a URL source (pinned by a
   fingerprint of its URL and credential name), a UTC cron expression and the job options
   (`publish`, `batchSize`, `budgetMs`, `missing`). An Administrator creates, lists, updates,
   deletes and runs it through REST routes. *Amended by Ruling 40* (the source is pinned).
2. **A due mark.** At each cron time the schedule is marked due. That is all the cron time does:
   one compare-and-set, no fetch (Ruling 35).
3. **A pump.** One plugin cron task does all the heavy work, **one unit per tick on both
   runtimes**: it finalizes finished scheduled jobs, then runs at most one batch of one unfinished
   scheduled job, and only when no batch ran, at most one launch of one due schedule (a fetch,
   then, unless the content and the template are unchanged, one real, journalled job). It never
   launches while any unfinished import or rollback reads the schedule's source (Ruling 33).
   *Amended by Ruling 35.*
4. **Stopping safely.** A schedule pauses itself, with a reason, when its run cannot be trusted to
   go on unattended: a failed, cancelled or rolled-back job, a refused missing-entry verdict, an
   empty feed, a template or source that is gone or changed, a creator who no longer holds the
   import permission, a configuration error, or repeated fetch failures. It stands down while a
   site import, a site export or media-usage activation runs. *Amended by Rulings 32, 40, 43, 45.*
5. **No MCP change.** The schedule and source read tools move to M6d, so M6b changes no tool and
   needs no re-consent (Ruling 50). *Amended by Ruling 50* (was: two read tools).

## Non-goals

These are left out, for the reasons given under "Out of scope" and in the Rulings:
- schedules over uploads or pasted text (a schedule needs a source it can fetch again);
- one-shot (ISO datetime) and sub-minute schedules;
- MCP tools of any kind, `sources/overview` included (M6d, Ruling 50);
- handing `start_import` jobs to the scheduler (Ruling 24);
- attributing scheduled writes to a user (Rulings 4, 44);
- a dry run before each scheduled run, and approval gates;
- notifications (email, webhooks) when a schedule pauses;
- catching up missed runs;
- raising a template's missing-entry threshold from a schedule (Ruling 13);
- more than one unit of work per pump tick (Ruling 35);
- the admin screens (M7) and the README and `skills/` entry (M8).

## Decisions

| Topic | Decision |
| --- | --- |
| Schedule record | A new plugin storage collection `schedules`, one document per schedule, keyed by ULID, indexed on `name`, `templateId` and `sourceId`. At most `MAX_SCHEDULES` (20) per site (Rulings 1, 17). |
| Template | Named by ID **and pinned revision**. A different current revision pauses the schedule (`template_changed`) until an Admin updates the schedule to it (Ruling 11). A template or source a schedule names cannot be deleted (`TEMPLATE_IN_USE`, `SOURCE_IN_USE`); a race with the delete pauses the schedule (M6a Ruling 45). |
| Source | Named by ID and pinned by `sourcePin`, a fingerprint of its URL and credential name taken when the schedule is armed. A change pauses the schedule (`source_changed`) (Ruling 40). |
| Cron | One recurring EmDash cron task per enabled schedule, `schedule-<id>`, with the schedule's expression: 5 fields or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, evaluated in UTC (F2). It only marks the schedule due and arms the pump (Ruling 35). No seconds field, no ISO one-shot (Ruling 7). |
| Pump | One recurring task `pump` (`*/10 * * * * *`), present only while some schedule is due or some scheduled job is open (Ruling 36). Each tick, on both runtimes: bounded finalization, then at most one batch of one open scheduled job (the tick caps on Workers, the job's own `batchSize` on Node), then, only if no batch ran, at most one launch (Rulings 35, 38). |
| Launch | Inside the pump: the busy check, the claim (compare-and-set of `current`), the template and source pins, the creator check, then the same path as `jobs/create { sourceId, templateId }`: the template-aware unchanged skip applies (P5). `force` only through `schedules/run`, which queues a due mark (Rulings 8, 9, 51). |
| One job at a time | A launch is `busy` while any unfinished real import or rollback reads the schedule's source, whatever its origin, found through a new indexed `feedSourceId` (Ruling 33). |
| Job | `origin: "schedule"`, `scheduleId`, `sourceId`, `feedSourceId`, `scheduled: "open"` until finalized; always `journal: true`; options from the schedule. Driven by the pump, and by an Admin's `jobs/next` (the documented external trigger); never by `next_batch` (Rulings 22, 38). |
| Actor | None. Scheduled writes carry no user, as EmDash's own unattended writes do: no `authorId` on created entries and media, **no author on EmDash revisions**, no actor for hooks. The schedule records who armed it, and a run log of its last 20 runs (Rulings 4, 5, 42, 44). |
| Capabilities | **`users:read`**, used only for the creator check: before each launch the user who armed the schedule must exist with a role that holds `import:execute`, or the schedule pauses `creator_gone`. Disabled users cannot be detected (F13, Ruling 43). *Amended by Ruling 43* (was: none). |
| Missing entries | A schedule whose template has `rules.missing` must state `missing`: `false`, `"template"`, or `{ maxPercent }` no higher than the template's. A refused verdict completes the job without removals and pauses the schedule; a first pass that reads no record skips the phase and pauses `empty_feed` (Rulings 12, 13, 45). |
| Failures | Configuration errors pause at once; transient fetch errors pause after `LAUNCH_FAILURES_TO_PAUSE` (3) in a row; a failed job pauses the schedule and clears the source's `lastImport`; a cancel or rollback of a scheduled job pauses it too (Rulings 14, 15, 32). |
| Site fence | Launches and pump batches stand down (skip, no pause) while a site import, a site export or media-usage activation runs. During an export this is stricter than EmDash, which lets writes run and restarts the export (Rulings 19, 31). |
| Routes | REST only: `schedules/create`, `schedules/list`, `schedules/update`, `schedules/delete`, `schedules/run`. All private JSON POST, `import:execute` (Rulings 20, 50). |
| Tools | None added in M6b. `sources/overview`, `list_sources` and `list_schedules` move to M6d, whose tools change the list anyway, so sites re-consent once (Ruling 50). |
| Retention | Hourly (`17 * * * *`) and bounded per run, from a full scan that keeps only IDs and upload IDs; it never purges an open scheduled job or one a schedule's `current` names (Rulings 25, 39). |
| Version | `FLUX_IMPORT_VERSION` 0.3.0 → 0.4.0: a new storage collection, new `jobs` indexes and a capability (M6a F5). |

## EmDash facts this design relies on

Checked on 2026-11-17 against:
- `emdash@1.2.0` (package `src/`, cited as file:line) and `@emdash-cms/auth@1.2.0`;
- `@emdash-cms/cloudflare@1.2.0` (`src/worker.ts`), `@astrojs/cloudflare@14.3.4`,
  `@cloudflare/vite-plugin@1.63.0` (cited as `vite-plugin` `dist/index.mjs:<line>`);
- the docs, through the `emdash-docs` MCP server, and the Cloudflare docs (D1 and Workers limits);
- two runs on this machine on 2026-11-17 (F16, F17), whose logs are in the git-ignored
  `.superpowers/wt/scratch-m6b/`.

M6a's facts F1-F12 and F-C1-F-C5 and M6c's F1-F15 still hold; F-C1-F-C5 are restated and sharpened
below. All facts are **confirmed** from source, docs or a run unless marked otherwise; the
unconfirmed ones are listed under "To verify in Task 0".

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | **The cron API.** `ctx.cron` (`CronAccess`, "always available, scoped to plugin") has `schedule(name, { schedule, data? })`, `cancel(name)` and `list()`, which returns each enabled task's `name`, `schedule`, `nextRunAt` and `lastRunAt`. The `cron` hook gets `{ name, data?, scheduledAt }` and the plugin context, and needs no capability. The docs document the hook and name `ctx.cron.schedule()`; the method's parameters and the semantics below are in source only | `src/plugins/types.ts:1107-1152`; `src/plugins/cron.ts:251-318`; [hooks reference](https://docs.emdashcms.com/reference/hooks/#cron) |
| F2 | **Schedule syntax.** A task name is 1-128 characters matching `^[a-zA-Z][a-zA-Z0-9_-]*$`. A schedule is 1-256 characters: a cron expression parsed by `croner` (5 fields, 6 with seconds, or an alias such as `@daily`), or an ISO 8601 datetime, which makes a one-shot. Cron expressions are evaluated in UTC on every host ("Matches the Workers runtime"). An invalid schedule makes `schedule()` throw `Invalid schedule "…": must be a valid cron expression or ISO 8601 datetime`. None of `nextCronTime`, `validateSchedule` or `isOneShot` is exported from `emdash` | `src/plugins/cron.ts:18-19`, `:345-394`, `:396-436`; `dist/index.d.mts` (exports `NodeCronScheduler` only); [hooks reference](https://docs.emdashcms.com/reference/hooks/#cron) |
| F3 | **Upsert and cancel.** `schedule()` upserts per (plugin, name): it sets the expression, data and next run, re-enables the task, and keeps a task that is `running` as `running`. `cancel()` deletes the row whatever its status. Both call the scheduler's `reschedule()` | `src/plugins/cron.ts:259-296` |
| F4 | **A tick.** One `UPDATE … RETURNING` claims at most 10 due, idle, enabled tasks, oldest `next_run_at` first; the executor runs their hooks one after another **within that tick**, and a hook's error is caught and logged. A recurring task's next run is computed from the **claimed** expression and the **tick's** time, so missed runs are not caught up (one late run, then the next slot). A one-shot that fails is retried up to 5 times with backoff (1-16 minutes); one that succeeds is deleted by row ID, so a one-shot that re-schedules itself from its own hook deletes its own new schedule. Invalid task data or an unsatisfiable expression disables the task. *Amended by F19*: ticks themselves can overlap | `src/plugins/cron.ts:78-211` (`:84-104`, `:131-137`, `:173-177`, `:181-204`) |
| F5 | **Hook dispatch and timeout.** The cron hook goes only to the plugin that owns the task. It runs under the hook's `timeout` through `Promise.race`, which rejects at the timeout but **does not stop the handler**: it keeps running while the executor moves on to the next task. flux-import's cron hook declares 60 s. *Amended by Ruling 57*: on workerd the handler is abandoned when the invocation ends (Fact V7), and the hook declares 180 s (Ruling 16) | `src/plugins/hooks.ts:443-454`, `:1029-1061`; `src/emdash-runtime.ts:2187-2192`; `packages/flux-import/src/plugin/definition.ts:105-107` |
| F6 | **Stale locks.** A task left `running` for 10 minutes is set back to idle. Recovery runs after every tick and once at runtime start | `src/plugins/cron.ts:21-22`, `:217-228`; `src/emdash-runtime.ts:960-964`, `:2216-2234` |
| F7 | **Drivers.** The generated scheduler module gives every runtime a `NodeCronScheduler` timer **except a Cloudflare production build**: `astro dev` under the Cloudflare adapter gets the timer too. The timer wakes at the next due task, 1-60 s apart, and runs the tick, stale-lock recovery and the maintenance pass side by side. On a Cloudflare build the Worker's `scheduled()` handler (`createScheduledHandler`) runs `runScheduledTasks()` inside one `ctx.waitUntil`: the tick (all claimed tasks in sequence), stale-lock recovery, then the scheduled-publishing sweep, the hourly cleanup, the one-time storage index sync, the scheduled backup check and the heartbeat. `runtime.stopCron()` is public and stops the timer for the life of the isolate (`reschedule()` is a no-op once stopped) | `src/astro/integration/virtual-modules.ts:542-561`; `src/plugins/scheduler/node.ts:15-26`, `:44-60`, `:62-128`; `@emdash-cms/cloudflare` `src/worker.ts:84-120`; `src/astro/middleware.ts:300-309`; `src/emdash-runtime.ts:944-1007`, `:1047-1051` |
| F8 | **What a Cloudflare site configures.** A Cron Trigger in `triggers.crons` of `wrangler.jsonc` (the templates use `* * * * *`) and the `scheduled` handler from `@emdash-cms/cloudflare/worker` exported from the entry point `main` names. Without either, plugin cron tasks never run on Cloudflare. A trigger other than every minute needs `createScheduledHandler({ generalCron })` with the same expression. `emdash doctor` checks the wiring; a new or changed trigger can take 15 minutes to start; preview deployments run no Cron Triggers. *Amended by F23*: the docs describe a newer handler than 1.2.0's | [Cloudflare deployment](https://docs.emdashcms.com/deployment/cloudflare/) ("Configure bindings", "Add the Worker entry point", "Scheduled publishing", previews); `sites/dev-cf/wrangler.jsonc:9`; `sites/dev-cf/src/worker.ts:1-9` |
| F9 | **Workers limits for a Cron Trigger.** D1: 1,000 queries per Worker invocation on the paid plan, 50 on the free plan ("read subrequest limits"); a `db.batch()` counts once. Workers Paid: 10,000 subrequests per invocation, CPU time 30 s per Cron Trigger invocation for intervals under an hour (15 minutes for an hour or more), 10 ms on the free plan; wall time 15 minutes per Cron Trigger invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/); [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (CPU time, Duration, Subrequests) |
| F10 | **One budget per tick.** A Cron Trigger fires `scheduled()` once; F7 runs every claimed task of every plugin, the publishing sweep and the maintenance inside that one invocation, and F9 states the D1 limit per invocation with no exception for Cron Triggers. So **all due tasks of a tick share one 1,000-query budget** with EmDash's own scheduled work. This settles M6a F-C4's open point by reading. Local workerd does not enforce the limit (M5a), so it is not provable on this machine (V2) | F7, F9 |
| F11 | **Exceeding the budget mid-tick.** Once the limit is reached, every later D1 statement in the invocation fails. That includes the executor's own update that sets a finished task back to idle (`cron.ts:197-204`) and the stale-lock recovery in the same invocation, so the task stays `running` until a later tick's recovery, 10 minutes on (F6), and the publishing sweep after it fails too. Inferred from F4, F6, F7 and the D1 error "Too many API requests by single Worker invocation" | `src/plugins/cron.ts:197-204`, `:217-228`; `src/emdash-runtime.ts:954-971`; [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) "Batch limits" |
| F12 | **Unattended writes carry no user in EmDash.** A cron event has no user. `ctx.content.create` reaches `runtime.handleContentCreate` with neither `actor` nor `authorId`, and scheduled publishing calls `handleContentPublish` with `origin: { source: "scheduler" }` and no actor. In the content handlers `actor` and `authorId` are optional; a staged revision's author is `actor?.id`; no `author_id` column has a foreign key; content-policy hooks receive an actor only for `api`, `mcp` and `visual-editor` origins. `withEmDashRuntime()` is "the same trust level as plugin cron" | `src/plugins/types.ts:1143-1147`, `:1391-1401`; `src/plugins/context.ts:792-806`; `src/emdash-runtime.ts:898-914`, `:2294-2323`, `:3455-3474`, `:3623-3629`, `:3943-3948`, `:4490-4495`; `src/database/migrations/001_initial.ts:22`, `:88`; `src/schema/registry.ts:1874`; `src/astro/middleware.ts:340-342`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#calling-routes-from-queue-and-scheduled-handlers) |
| F13 | **`users:read`.** The capability exists and gives `ctx.users.get`, `getByEmail` and `list`. `get(id)` is one `users` row read by ID and returns `{ id, email, name, role, createdAt }`, or `null` for a user that does not exist. The user's `disabled` flag is not among them, while EmDash refuses a disabled user at session and token authentication. So the capability tells whether a user exists and their role, **not whether they are disabled**. `routeCtx.user` is separate and needs no capability | `src/plugins/manifest-schema.ts:53`; `src/plugins/types.ts:978-1003`; `src/plugins/context.ts:1444-1497`, `:1818-1820`; `src/database/repositories/user.ts:79-87`; `src/astro/middleware/auth.ts:688`, `:738-742`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/); [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#the-authenticated-caller) |
| F14 | **The site write fence does not cover cron.** *Corrected by the spec review (Ruling 31).* `readSiteWriteFence` answers, in one query: an **import** fence for an import that is `running` or `verifying`, or `failed` **or `cancelled`** after its mutation started; a **media** fence while media-usage activation is `activating`; and whether an **export** is running. When the transfer tables are missing it falls back to the media fence alone; a read error is `TRANSFER_FENCE_CHECK_FAILED`. **An export is not a fence:** EmDash lets the write run and, through the `recordWrite` that `assertSiteWriteAllowed` returns, bumps every running export's `write_epoch`, so the export restarts. The middleware applies this to every API write path that is not exempt, plugin routes included; EmDash's scheduled publishing and plugin `ctx.content` writes apply it themselves. The cron tick and direct calls of the runtime's content handlers do not. The fence functions are not exported from `emdash` | `src/transfer/fence.ts:63-133` (`:79-104`), `:148-182`; `src/astro/middleware/media-usage-write-fence.ts:18-38`; `src/emdash-runtime.ts:898-914`, `:2132`, `:3455-3647`; `package.json` `exports` |
| F15 | **A disabled plugin's tasks.** Disabling a plugin disables all its cron tasks; enabling it re-enables them, and a task whose `next_run_at` passed meanwhile is due at once and runs once (F4) | `src/plugins/cron.ts:327-341`; `src/emdash-runtime.ts:1188` |
| F16 | **A real `scheduled()` event in the workerd harness.** `@astrojs/cloudflare` 14.3.4 keeps the site's `main` (`./src/worker.ts`) in `astro dev`, and the Cloudflare Vite plugin forwards `/cdn-cgi/handler/scheduled` to Miniflare's scheduled trigger. Observed 2026-11-17 on `sites/dev-cf` (astro dev, port 4478, a throwaway local D1): before any trigger EmDash's heartbeat option (`system:scheduler:last_completed_at`) was absent; three `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*` at 10:20:28, 10:20:44 and 10:20:50 UTC each answered 200 and moved it to 10:20:28.435, 10:20:44.196 and 10:20:50.461. So the site's own `scheduled()` handler ran `runScheduledTasks()` as a scheduled event. In the same harness the timer of F7 also ticks. *Amended by Ruling 58*: not reproduced (Fact V9) | `vite-plugin` `dist/index.mjs:90355-90390`; `@astrojs/cloudflare` `dist/wrangler.js:36`; run log `.superpowers/wt/scratch-m6b/astro-dev.log` |
| F17 | **The production build blocker still stands.** Reproduced 2026-11-17: `astro build` of `sites/dev-cf` succeeds; `wrangler dev -c dist/server/wrangler.json --test-scheduled` starts; `/_emdash/api/health` and `/__scheduled` answer 500, and `/cdn-cgi/handler/scheduled` logs `[scheduled] runScheduledTasks failed: TypeError: Class extends value undefined is not a constructor or null` at `dist/server/chunks/kysely_*.mjs:1848`, the M2 error | `docs/superpowers/notes/2026-10-08-m2-review.md:33`; run logs `.superpowers/wt/scratch-m6b/build.log`, `wrangler-dev.log` |
| F18 | **Content-cache invalidation.** EmDash purges edge-cache tags after plugin content actions (`runPluginContentAction`, with the invalidator `runScheduledTasks` or the plugin route passes), not after direct calls of the runtime's content handlers, which flux-import makes in requests and in cron alike | `src/emdash-runtime.ts:4214-4255`; `src/astro/routes/api/plugins/[pluginId]/[...path].ts:36`; `@emdash-cms/cloudflare` `src/worker.ts:107-110` |
| F19 | **Ticks overlap.** *Added by the spec review.* On Node, `schedule()` and `cancel()` call `reschedule()`, which clears the timer and re-arms it at least 1 s out, and `executeTick` keeps no in-progress flag, so a hook that schedules or cancels a task starts a **second tick while the first still runs**; a claimed task is never claimed twice (F4), but different tasks run side by side. On Workers, a tick that outlasts the trigger interval overlaps the next invocation. So nothing may rely on tasks running one after another | `src/plugins/scheduler/node.ts:52-60`, `:62-128`; F4; [Cloudflare deployment](https://docs.emdashcms.com/deployment/cloudflare/#scheduled-publishing) ("consecutive runs can overlap") |
| F20 | **The import permission is Admin.** `import:execute` maps to `Role.ADMIN` (50), and `hasPermission(user, permission)` compares `user.role` with that level, so a `{ role }` from `ctx.users.get` suffices | `@emdash-cms/auth` `src/rbac.ts:87`, `:113-119`; `src/types.ts:14` |
| F21 | **Storage queries.** A `where` value can be an equality, a range, `{ in: [...] }` or `{ startsWith }`, on indexed fields only; a query returns whole documents, with no projection (M6a F2) | `src/plugins/types.ts:168-191`; `src/plugins/storage-query.ts:65-81`, `:224-255`; M6a F2 |
| F22 | **The scheduled-handler docs are ahead of 1.2.0.** The docs' handler waits for entries scheduled up to 70 s ahead, mention `publishUpcomingWithinMs`, and their entry point exports `EmDashRoom` and `EmDashRoomSite`. None of these is in `@emdash-cms/cloudflare@1.2.0` or `emdash@1.2.0` source: the 1.2.0 handler takes only `generalCron`, publishes only what is due, and its module exports only `PluginBridge` | [Cloudflare deployment](https://docs.emdashcms.com/deployment/cloudflare/); `@emdash-cms/cloudflare` `src/worker.ts:17`, `:80-120`; no match for `publishUpcomingWithinMs` in either package's `src/` |

### Facts about flux-import's own code

| # | Fact | Evidence |
| --- | --- | --- |
| P1 | **The cron hook today** runs only the daily `retention` task (`0 3 * * *`), with a 60 s timeout, through `withRuntime` and `ctx.storage`. The task is scheduled by `plugin:activate` and by every `jobs/create` | `src/plugin/definition.ts:101-122`; `src/plugin/routes.ts:168-174`, `:548`; `src/plugin/retention.ts:5-7` |
| P2 | **Every engine service needs a request user.** `withServices` refuses a call without `ctx.user` and builds `actor = { id, role, source: "api" }`, which `EmDashContent` passes to every write (and as `authorId` on creates), `EmDashMedia` as the media `authorId`, and the lock reader as the user whose own lease counts as unlocked | `src/plugin/routes.ts:236-241`, `:268-274`; `src/emdash/content.ts:267-277`, `:449-453`; `src/emdash/media.ts:62-100`; `src/emdash/locks.ts:12-48` |
| P3 | **How jobs advance.** Only `jobs/next` (any job) and `jobs/step` (agent jobs only) run a batch, each with a unique holder `<userId>:<ulid>`. `runBatch` claims the lease by compare-and-set (lease `budgetMs` + 30 s), returns the job unchanged when it is not `created` or `running` or another live lease exists, and saves cursor and counters as it releases. An unexpected error is noted on the job (lease kept) and rethrown; the third in a row fails the job | `src/plugin/routes.ts:744-749`, `:834-838`; `src/engine/batch.ts:2105-2161`, `:2170-2201`; M6c P3 |
| P4 | **The Workers caps** (records per batch: 11 plain, 6 linked, 3 rollback, 40 and 10 in the missing phase; lookup budget 600) were set so that one batch stays near 900 D1 queries; M6c measured 667-891 for `jobs/step` batches | `src/plugin/service.ts:41-97`, `:109-117`; M6c review, V7 |
| P5 | **The URL-source path.** `jobFromSource` fetches first, skips a real run without `force` only when the hash **and** the template equal `lastImport` (M6a Ruling 29), and records `lastImport` when the job is **created**, not when it completes. `lastImport` is cleared only by a cancel or a rollback of that job, so after a **failed** job the same content is skipped | `src/plugin/sources.ts:416-458`, `:396-410`; `src/plugin/routes.ts` (`transition`) |
| P6 | **Missing-phase verdicts.** The count stage refuses when the share of owned entries absent from the feed is over the threshold, or when an owned link was created from another URL source; a refused real job completes with `missing.verdict: "refused"`, no removals and a warning. `createJob` refuses any `missing` option on a template without `rules.missing` | `src/engine/missing.ts:254-262`, `:296-323`; M6c P12 |
| P7 | **Retention is unbounded.** One run reads every job row (whole documents, 100 a page) and deletes every due job's record and journal rows, 100 per `deleteMany`, with no budget | `src/plugin/retention.ts:52-130` |
| P8 | **A fetch can outlast the hook.** `FETCH_LIMITS.totalMs` is 120 s, twice the cron hook's 60 s timeout (F5) | `src/sources/fetcher.ts:23-27` |
| P9 | **Source rows hold the URL.** `sources/list` and `sources/get` return whole rows, `url` included (at most 2,048 characters, query string kept); a credential is referenced by name | `src/plugin/sources.ts:22-36`, `:155-172`; `src/plugin/routes.ts:720-730` |
| P10 | **Agent jobs.** `Job.origin` is `"agent"` or absent; `jobs/step` refuses any other job (`JOB_NOT_AGENT`, 403); summaries say `next: "not_agent"` for such a job; `createRollback` copies no `origin` | `src/engine/types.ts:100-109`; `src/plugin/agent.ts:262`; M6c Rulings 30, 31, 61 |
| P11 | **Job creation under a known ID.** `createJob` takes an optional `id` and throws `JobExistsError` when a job with it exists (M6c `start_import`'s claim-then-create) | M6c "Engine, type and retention changes"; `src/engine/jobs.ts` |
| P12 | **Deletes check nothing.** `templates/delete` and `sources/delete` delete by revision or ID without looking for references | `src/plugin/templates.ts:434-444`; `src/plugin/sources.ts` (`deleteSource`) |
| P13 | **The MCP tool table** has six entries; the committed consent fixture pins their snapshot | `src/plugin/mcp.ts:118-146`; `tests/unit/fixtures/mcp-consent.txt` (M6c Ruling 48) |
| P14 | **Test ticks.** Both dev sites have a dev-only `POST /test/run-scheduled` that runs `runScheduledTasks()` inside a request (403 in production builds) | `sites/dev/src/pages/test/run-scheduled.ts`; `sites/dev-cf/src/pages/test/run-scheduled.ts` |
| P15 | **Version.** `FLUX_IMPORT_VERSION` is 0.3.0 | `src/meta.ts:2` |
| P16 | **Which jobs name a source.** *Added by the spec review.* A job from `jobFromSource` (real or dry) carries `sourceId`; a rollback job copies `template`, `templateId` and `templateRevision` but not `sourceId`; an agent's real job from a URL-source dry run carries none (M6c Ruling 9). `sourceId` also stamps `ownerSource` on the links a job writes. `jobs` has no index on `sourceId` | `src/engine/rollback.ts:118-140`; `src/engine/owner.ts:27-34`; `src/plugin/definition.ts:28`; M6c Ruling 9 |
| P17 | **Ownership without a source.** A link with no `ownerSource` (an inline, paste or agent import) is never foreign in the missing phase, so a schedule with the same owner treats it as its own candidate | `src/engine/missing.ts:250-262`; `src/engine/owner.ts:27-34` |
| P18 | **The retention setting's label** says "deleted daily. 0 deletes them at the next daily run." | `src/plugin/definition.ts:94` |

### To verify in Task 0

Each item is proven on Node (`sites/dev`, SQLite) and workerd (`sites/dev-cf`, D1) through a
temporary probe (route, cron task or tool) and the M5a D1 counter, as in M5a-M6c, and removed
afterwards. Scratch files go in `.superpowers/wt/scratch-m6b/`.

- **V1. A plugin cron hook in a real `scheduled()` event.** With a temporary probe task due,
  `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*` on the workerd harness runs flux-import's cron
  hook with `ctx.storage`, `ctx.settings`, `ctx.taxonomies`, `ctx.bylines`, `ctx.cron` and (with the
  capability declared) `ctx.users`, and `withRuntime` works inside it (F16 proved the handler, not
  a plugin hook).
- **V2. One budget per tick.** Not provable locally (F10). Task 0 records the D1 count of a whole
  scheduled event (V5) and the production check moves to the first deploy (Open issues).
- **V3. Writes without an actor.** Through the content and media ports with no actor:
  `handleContentCreate`, `Update`, `Publish`, `Unpublish`, `Schedule`, `Unschedule`, `Delete`
  (trash), `Restore`, `DiscardDraft` and `handleMediaUpload` succeed on SQLite and D1. Created
  entries and media have no author, and **the revisions EmDash records for them have no author**.
  The lock reader with the sentinel user `""` treats every live lease as foreign. Publish with
  `origin: { source: "plugin", pluginId: "flux-import" }` behaves as with no origin.
- **V4. The fence read.** flux-import's copy of F14's query, run through `runtime.db`, answers
  "clear" on a fresh site; "import" for an import row that is `running`, `verifying`, or `failed`
  or `cancelled` with `mutation_started_at` set, and "clear" for a cancelled one without it;
  "export" for a running export; "media" for an `activating` row (each written through `withDb`);
  and the media fence alone when the transfer table is missing, on SQLite and D1.
- **V5. Tick budgets on workerd.** Count every D1 statement of one scheduled event (the M5a
  `countD1` wrapper around the event) for each row of the "Workers and Node" table:
  - a quiet tick (no flux-import task due, nothing to publish);
  - due marks (one, and nine in one tick);
  - a pump tick of each kind: idle (and its self-cancel), finalization only (two jobs, one of them
    failed, so `clearLastImport` runs), a launch on unchanged content, a launch that creates a job
    (plain and linked templates), and one batch at each tick cap: plain creates on a fresh
    collection (with `ensureSourceIdField`), plain published updates, linked updates, the missing
    phase's count and act stages;
  - one bounded retention run with the scan at 1,000 job rows and deletes to its budget;
  - **the worst tick:** nine due marks, a finalizing pump tick with a linked-update batch, and a
    retention run, in one event.

  Each pump batch must stay at or under `PUMP_QUERY_TARGET` (550), and **the worst tick under
  900**. A cap that does not is lowered by the excess, and the spec is amended.
- **V6. Cron behaviour.** On both runtimes: `schedule()` refuses a malformed expression with the
  F2 message; a task re-scheduled from its own hook keeps the new expression and gets its next run
  from the old one (F4); `cancel()` of a task inside its own hook deletes it and the executor's
  update is a no-op; on Node a `schedule()` inside a hook starts a second tick while the first runs
  (F19); disabling and enabling the plugin disables and re-enables `schedule-*` and `pump`, and an
  overdue `schedule-<id>` runs once (F15); `list()` after `schedule()` gives the expected
  `nextRunAt` for `@daily` and `0 */6 * * *`.
- **V7. The hook timeout.** A probe hook that outlives its timeout keeps running after EmDash
  logs the failure (F5), and the next task's hook starts meanwhile. This fixes the reasoning of
  Ruling 16.
- **V8. A pinned-revision launch.** `jobs/create { sourceId, templateId, templateRevision }`
  on a template at another revision is `TEMPLATE_CHANGED` before any fetch, on both runtimes
  (`createJobFrom` resolves the template before `jobFromSource` fetches,
  `src/plugin/routes.ts:542-605`), so a launch that pauses `template_changed` stages nothing.
- **V9. The scheduled path on workerd** (Ruling 41). A dev-only `POST /test/stop-cron-timer` in
  `sites/dev-cf` calls `withEmDashRuntime((r) => r.stopCron())` (F7). After it, with a probe task
  due every 10 s: no tick happens for 30 s without a call, and each
  `GET /cdn-cgi/handler/scheduled` runs exactly one tick (the probe's counter moves by one per
  call). If the timer cannot be stopped (another isolate starts it again), V9 records that, and the
  parity test is described as **not** proving the scheduled path.
- **V10. Re-check F7, F8 and F22.** The scheduler module, the 1.2.0 scheduled handler and the
  docs' handler (`publishUpcomingWithinMs`, the 70 s wait, `EmDashRoom`) are re-read against the
  installed packages; the spec records any change, and the M8 docs follow 1.2.0's handler.
- **V11. The creator check.** With `users:read` declared, `ctx.users.get` in a cron hook returns the
  user's role, `null` for a deleted user, and the unchanged role for a disabled user (F13), on both
  runtimes, in one D1 query.

If V3, V5 or V9's timer stop fail, the plan stops and this spec is amended before Task 1.

## Storage

```ts
// STORAGE gains (src/plugin/definition.ts):
//   schedules: { indexes: ["name", "templateId", "sourceId"] },
//   jobs: { indexes: [...as today, ["scheduled", "status", "createdAt"],
//                     ["feedSourceId", "dryRun", "status"]] },
//   Amended by Ruling 54: the index is ["feedSourceId", "status"], dry runs filtered in code.

type ScheduleMissing = false | "template" | { maxPercent: number };

type PauseReason =
	| "template_gone"      // the template no longer exists (M6a Ruling 45)
	| "template_changed"   // the template is at another revision than the schedule's (Ruling 11)
	| "source_gone"        // the source no longer exists
	| "source_changed"     // the source's URL or credential name changed (Ruling 40)
	| "creator_gone"       // the user who armed it is gone or lost import:execute (Ruling 43)
	| "invalid_template"   // createJob refused the template, options or source block
	| "credential_missing" // the source's credential is gone
	| "url_blocked"        // the SSRF guard refused the source's host
	| "too_large"          // the source is over the size limit
	| "fetch_failed"       // LAUNCH_FAILURES_TO_PAUSE transient launch failures in a row
	| "job_failed"         // the schedule's job failed
	| "cancelled"          // an Admin cancelled the schedule's job (Ruling 32)
	| "rolled_back"        // an Admin rolled back the schedule's job (Ruling 32)
	| "missing_refused"    // the job's missing phase refused its removals
	| "empty_feed";        // the job's first pass read no record (Ruling 45)

interface RunEntry {           // Ruling 42
	jobId: string;
	at: string;                  // when the job finished
	outcome: "completed" | "failed" | "cancelled" | "missing_refused" | "empty_feed";
	counters: { created: number; updated: number; unchanged: number; failed: number;
		conflict: number; locked: number; removed: number };
	rolledBack?: { by: string; at: string };  // the rollback job, set by jobs/rollback
}

interface ScheduleRow {
	id: string;                  // ULID, also the storage key
	name: string;                // as template names (M6a "Names"), unique by check
	templateId: string;
	templateRevision: number;    // pinned (Ruling 11)
	sourceId: string;
	sourcePin: string;           // fingerprint({ url, credential }) when armed (Ruling 40)
	cron: string;                // 5 fields or an alias, UTC (Ruling 7)
	publish: boolean;            // default true
	batchSize: number;           // 1-500, default 50
	budgetMs: number;            // 500-20,000, default 4,000: wall time (Ruling 16)
	missing?: ScheduleMissing;   // set exactly when the template has rules.missing (Ruling 12)
	enabled: boolean;
	pause?: { reason: PauseReason; at: string; jobId?: string };
	/** Set by schedule-<id> or schedules/run; consumed by the pump's launch (Ruling 35). */
	due?: { at: string; force?: true };
	/** The launch claim only: set before the fetch, cleared once the launch ends (Ruling 38). */
	current?: { jobId: string; claimedAt: string };
	lastLaunch?: {
		at: string;
		outcome: "started" | "unchanged" | "busy" | "failed";
		jobId?: string;
		errorCode?: string;        // codes only, never messages (Ruling 47)
	};
	runs: RunEntry[];            // the last RUN_LOG_SIZE (20) finished jobs, newest first
	launchFailures: number;      // transient launch failures in a row
	armedBy: string;             // the user of the last create or update that enabled it (Ruling 43)
	revision: number;            // 1 on create, + 1 on every route update (M6a Ruling 6)
	createdAt: string;
	updatedAt: string;
	createdBy: string;           // routeCtx.user, never from the body
	updatedBy: string;
}

// What schedules/list returns: the row, plus the cron task's next run.
type ScheduleView = ScheduleRow & { nextRunAt: string | null };

// Job gains (src/engine/types.ts):
//   origin?: "agent" | "schedule"   (was "agent"; P10)
//   scheduleId?: string             (on a job a schedule launched; not copied by a rollback)
//   scheduled?: "open" | "closed"   (on a scheduled job: "open" until the pump finalizes it)
//   feedSourceId?: string           (the URL source whose data the job reads or undoes, Ruling 33)
```

- **Indexes.** `schedules`: `name` serves the uniqueness check; `templateId` and `sourceId` the
  in-use checks of `templates/delete` and `sources/delete` (Ruling 10). The pump and
  `schedules/list` read the whole collection, at most `MAX_SCHEDULES` (20) rows in one page,
  without `orderBy`. `jobs`: `["scheduled", "status", "createdAt"]` serves the pump's finalization
  and batch queries (Ruling 38); `["feedSourceId", "dryRun", "status"]` the busy check
  (Ruling 33). *Amended by Rulings 33, 38.*
- **`feedSourceId`** is set on every job that reads a source's data or undoes such a job: a job
  from `jobFromSource` (real or dry: the source), an agent's real job from a URL-source dry run
  (copied from the dry run, without `sourceId`, so M6c Ruling 9 holds), and a rollback job (copied
  from its original's `feedSourceId`). Jobs saved before 0.4.0 have none (Open issues).
- **Writes.** Route writes check `revision` and compare-and-set the storage revision, as templates
  do; a compare-and-set lost to a tick's write while the caller's `revision` still matches is
  retried, at most 5 times, and is never answered `SCHEDULE_CHANGED` (Ruling 46). Cron writes and
  the route side effects of Ruling 32 are compare-and-set loops of at most 5 attempts on the
  newest row, each **conditional on `current?.jobId`** being what the writer decided on (Ruling
  34), and leave `revision` alone, so an Admin's update is refused only by another Admin's update.
  *Amended by Ruling 79*: a route pause (cancel, rollback) is not conditional on `current?.jobId`
  and always wins; the scheduler's own pauses never replace one.
- **Retention.** Schedules and their run logs are never purged. A run log entry's `jobId` may name
  a purged job. Retention keeps its own cursor between runs in plugin KV (`retention:cursor`, M6a
  F9: internal state belongs in KV).
- **The cron tasks.** `schedule-<id>` exists while the schedule exists **and** is enabled, with
  `data: { scheduleId }`. `pump` exists while some schedule is due or some job is
  `scheduled: "open"` (Ruling 36). A reconciliation keeps them so (see "Reconciliation").

## Routes

All routes are plugin routes under `/_emdash/api/plugins/flux-import/`, built by `route()`:
`POST`, JSON in and out, `permission: "import:execute"` (Admin), `astro/zod` input, errors through
`toRouteError`. Each is MCP-ready (M6a Ruling 17); none becomes a tool in M6b (Ruling 50).

| Route | Input | Output |
| --- | --- | --- |
| `schedules/create` | `{ name, templateId, templateRevision, sourceId, cron, publish?, batchSize?, budgetMs?, missing?, enabled? }` | `{ schedule: ScheduleView }` |
| `schedules/list` | `{ cursor? }` | `{ items: ScheduleView[], cursor?, hasMore }` |
| `schedules/update` | `{ id, revision, name?, templateId?, templateRevision?, sourceId?, cron?, publish?, batchSize?, budgetMs?, missing?: ScheduleMissing \| null, enabled? }`, at least one change | `{ schedule: ScheduleView }` |
| `schedules/delete` | `{ id, revision }` | `{ deleted: true }` |
| `schedules/run` | `{ id, force? }` | `{ queued: true, schedule: ScheduleView }` |

*Amended by Ruling 50*: `sources/overview` and its `SourceSummary` move to M6d. *Amended by Ruling
51*: `schedules/run` queues a due mark instead of launching in the request.

### Behaviour

- **`schedules/create`** checks, in order, before any write:
  1. the name (M6a "Names") and `NAME_TAKEN`;
  2. `MAX_SCHEDULES` (`SCHEDULE_LIMIT`, 409);
  3. the template exists (`TEMPLATE_NOT_FOUND`) at `templateRevision` (`TEMPLATE_CHANGED`), passes
     the shape checks and has no site problem (M6a "Site checks": a problem is
     `TEMPLATE_PROBLEMS`, 409, with `details.problems`), and has a key (`key.from`);
  4. the source exists (`SOURCE_NOT_FOUND`); its `url` and `credential` give `sourcePin`;
  5. the expression (Ruling 7; `INVALID_CRON`);
  6. the options (`batchSize`, `budgetMs` bounds; `missing` as Ruling 12: `MISSING_REQUIRED` when
     the template has `rules.missing` and `missing` is absent, `INVALID_OPTIONS` when it is set on a
     template without it or `maxPercent` is over the template's).

  It then writes the row (`compareAndSet(id, null)`, `armedBy` the caller), and, when `enabled`
  (default `true`), schedules `schedule-<id>`. An expression EmDash refuses after flux-import's own
  check (F2) deletes the row and answers `INVALID_CRON` with EmDash's message. The name and limit
  checks race with a concurrent create, as M6a's names do; the race is accepted (Ruling 49).
- **`schedules/update`** runs the same checks on the changed fields against the row at `revision`
  (`SCHEDULE_CHANGED`, 409, on a mismatch; Ruling 46 for a tick's write). Changing `templateId`
  needs `templateRevision`. `missing: null` removes it (allowed only when the template has no
  `rules.missing`). Setting `enabled: true` clears `pause` and `launchFailures`, takes `sourcePin`
  again from the source as it is now, sets `armedBy` to the caller, and re-schedules the task;
  `enabled: false` cancels the task. **Disabling a schedule does not stop its running job**: the
  pump drives every open scheduled job (Ruling 38); the Admin cancels the job, which per Ruling 32
  pauses the schedule anyway (Ruling 48). Changing `cron` re-schedules the task. Changing the
  template or source of a schedule with an open job is `SCHEDULE_BUSY` (409, `details.jobId`).
- **`schedules/delete`** refuses while an open job names the schedule (`SCHEDULE_BUSY`; cancel the
  job or let it finish and be finalized), deletes the row at `revision` (compare-and-delete),
  cancels `schedule-<id>`, and leaves `pump` to cancel itself (Ruling 36).
- **`schedules/run`** refuses a disabled or paused schedule (`SCHEDULE_DISABLED`, 409: enable it
  first, which is the deliberate step) and a busy one (`SCHEDULE_BUSY`, 409, with the job that
  makes it busy, by the busy check of Ruling 33). Otherwise it sets `due: { at, force? }` and
  arms `pump`, and answers at once. The pump launches at its next tick, with the same checks again,
  so a run never starts beside another job (Ruling 51).
- **`schedules/list`** reads all schedules (one page) and `ctx.cron.list()` (one query), and joins
  `nextRunAt` by task name (`null` for a disabled schedule). It returns **codes only**:
  `pause.reason`, `lastLaunch.errorCode` and run outcomes, never a message (Ruling 47). A
  message stays in the job (`jobs/get`) and in the server log.
- **Existing routes:**
  - `templates/delete` refuses `TEMPLATE_IN_USE` (409, `details.scheduleIds`) when a schedule names
    the template (`schedules.query({ where: { templateId }, limit: 5 })`); `sources/delete` refuses
    `SOURCE_IN_USE` likewise (Ruling 10).
  - `templates/update` is unchanged: a new revision pauses the schedules pinned to the old one at
    their next launch (Ruling 11), and its response gains `check.warnings` naming them ("Schedule
    <name> (<id>) runs revision <n>; update it to run this revision"). `sources/update` warns the
    same way when it changes the URL or credential of a source a schedule pins (Ruling 40).
  - `jobs/cancel` on a job with a `scheduleId` also pauses that schedule (`cancelled`, with the job's
    ID), and `jobs/rollback` of such a job pauses it (`rolled_back`) and sets the job's run log entry
    `rolledBack` (Ruling 32). Both are best effort after the job change succeeded, as `lastImport`
    is cleared today; the pump's finalization repeats the pause for a cancel it finds.
  - `jobs/next`, `jobs/pause`, `resume` and `retry` work on scheduled jobs as on any job
    (Ruling 22). A batch run through `jobs/next` on a scheduled job writes unattributed (Ruling 5).
    A resumed or retried scheduled job stays `scheduled: "open"`, so the pump drives it (Ruling 38).
  - `jobs/step` keeps refusing every non-agent job, scheduled jobs included (`JOB_NOT_AGENT`), and
    summaries show `next: "not_agent"` and `origin: "schedule"` for them.
  - `jobs/create` is unchanged; its `missing: { maxPercent }` override stays the Admin's way to
    apply a refused verdict once (Ruling 13), and the job it makes carries `feedSourceId`, so the
    schedule's launches are busy while it runs (Ruling 33).
  - `jobs/start` (M6c) copies the dry run's `sourceId` into the real job's `feedSourceId`.

### Errors

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | The input fails its schema (bounds, unknown `missing` shape, no change on update) |
| `INVALID_CRON` | 400 | The expression is not 5 fields or an allowed alias, or EmDash refuses it; the message names the rule or quotes EmDash's |
| `INVALID_OPTIONS` | 400 | `missing` set for a template without `rules.missing`, or `maxPercent` over the template's |
| `MISSING_REQUIRED` | 400 | The template has `rules.missing` and `missing` is absent |
| `NOT_FOUND` | 404 | No schedule with that ID |
| `TEMPLATE_NOT_FOUND`, `SOURCE_NOT_FOUND` | 404 | As named |
| `NAME_TAKEN` | 409 | Another schedule has the name |
| `SCHEDULE_LIMIT` | 409 | `MAX_SCHEDULES` schedules exist |
| `TEMPLATE_CHANGED` | 409 | The template is not at `templateRevision` |
| `TEMPLATE_PROBLEMS` | 409 | The template has site problems; `details.problems` |
| `SCHEDULE_CHANGED` | 409 | `revision` is not the current one (Ruling 46: never for a tick's write) |
| `SCHEDULE_BUSY` | 409 | Delete, a template or source change, or `schedules/run`, while a job keeps the schedule busy; `details.jobId` |
| `SCHEDULE_DISABLED` | 409 | `schedules/run` on a disabled or paused schedule |
| `TEMPLATE_IN_USE`, `SOURCE_IN_USE` | 409 | The template or source is named by a schedule; `details.scheduleIds` |
| `INVALID_CURSOR` | 400 | As every route (M6c Ruling 45) |

*Amended by Ruling 51*: `schedules/run` no longer answers launch errors; they are recorded on the
schedule by the pump.

## Tools

*Amended by Ruling 50.* M6b adds no tool and changes none, so the consent snapshot and its fixture
(P13) are unchanged and no site re-consents. `sources/overview` (with `SourceSummary`: id, name,
host only, a credential flag, the last fetch and the last error **code**), `list_sources` and
`list_schedules` move to M6d, whose tools change the list anyway, so sites re-consent once. The
rules that bind them there are recorded here so M6d inherits them:
- `list_sources` shows a source's host, never its path, query or fragment (Ruling 21);
- `list_schedules` and every schedule response give codes only, never messages (Ruling 47);
- **no user ID goes to MCP**: the tool view of a schedule leaves out `armedBy`, `createdBy` and
  `updatedBy`, and a run log entry's `rolledBack.by` is the rollback job's ID, not a user's
  (Ruling 47);
- the tool input is the route's input object (M6c Ruling 2).

## The scheduler

### Cron tasks and the hook

*Amended by Rulings 35, 36.* The cron hook dispatches on `event.name`:

| Task | Expression | Exists while | Does |
| --- | --- | --- | --- |
| `retention` | `17 * * * *` (was `0 3 * * *`) | always | a bounded purge (Rulings 25, 39); reconciliation (below) |
| `schedule-<id>` | the schedule's `cron` | the schedule exists and is enabled | marks the schedule due and arms `pump`: no fetch, no job (Ruling 35) |
| `pump` | `*/10 * * * * *` | some schedule is due or some job is `scheduled: "open"` | one unit of work per tick (below) |

The hook's `timeout` goes from 60 s to `CRON_HOOK_TIMEOUT_MS` (180 s), above the longest unit a
pump tick does (a launch: the fetch's 120 s wall bound plus job creation). A hook never throws for
an expected failure: it records it on the schedule and returns. An unexpected error is logged with
`ctx.log.error` and rethrown, which EmDash logs and which leaves a recurring task for its next run
(F4).

Ticks can overlap (F19): two pump ticks, a pump tick and a due mark, or a tick and a route can run
at once. Nothing below relies on order: every schedule write is a compare-and-set conditional on
`current?.jobId` (Ruling 34), every launch claims before it fetches (Ruling 9), and every batch
holds the job's lease (P3).

Every task builds its services with `withScheduledServices(ctx)`: the services `withServices`
builds, from the cron hook's `PluginContext` instead of a `RouteContext`, with **no actor**
(Ruling 4). `withServices` is split so that both share one builder; routes keep requiring
`ctx.user`.

### Due marks

`schedule-<id>` reads the schedule (one get) and, when it exists and is enabled, compare-and-sets
`due: { at: event.scheduledAt }` on that row, conditional on the `current?.jobId` it read; then it
arms `pump` (`ctx.cron.schedule`, an upsert). A schedule that is already due keeps its older mark
(one launch, not two). A missing or disabled schedule cancels its own task. That is three or four
D1 queries and no network.

### The pump

Each tick, on both runtimes, in this order (Ruling 35):

1. **Stand down** when the site fence is up (Ruling 19): no write, and the tick ends.
2. **Finalize**, bounded: `jobs.query({ where: { scheduled: "open", status: { in: ["completed",
   "failed", "cancelled"] } }, limit: FINALIZE_PER_TICK })` (2), and finalize each (see
   "Finalization").
3. **One batch.** `jobs.query({ where: { scheduled: "open", status: { in: ["created", "running"] } },
   orderBy: { createdAt: "asc" }, limit: 1 })`: the oldest open scheduled job, whatever its
   schedule's state and whether or not a schedule's `current` names it (Ruling 38). Run one batch:
   `runBatch(deps, jobId, "schedule:<scheduleId>:<ulid>", caps, lookupBudget)`, with the tick caps
   on Workers and the job's own `batchSize` on Node, then release the staged file when the job
   finishes (as `nextBatch`). A batch that ran is the tick's unit. A held lease (an Admin's
   `jobs/next`) returns the job unchanged and counts as no batch. An unexpected batch error is
   caught (the engine has already noted it, P3), logged, and counts as the unit.
4. **At most one launch**, only if no batch ran: the enabled schedule with the oldest `due.at`
   (see "Launch").
5. **Idle check**, only if steps 2-4 did nothing: when no schedule is due and no job is
   `scheduled: "open"` (`limit: 1`), cancel `pump`, then read the schedules once more and re-arm
   `pump` if one became due meanwhile (Ruling 36).

A paused open job is neither finalized nor batched; it keeps the schedule busy (Ruling 33) until an
Admin resumes or cancels it.

### Launch

`launch(schedule)`, step 4 of the pump:

1. **Busy** (Ruling 33): `jobs.query({ where: { feedSourceId: schedule.sourceId, dryRun: false,
   status: { in: ["created", "running", "paused"] } }, limit: 1 })`. A match (any origin: an
   Admin's import, an agent's real import, another schedule's job, a rollback of any of them)
   records `lastLaunch.outcome: "busy"`, clears `due`, and stops. *Amended by Ruling 54*
   (`dryRun` is filtered in code, at most 5 pages).
2. **Claim.** When `current` is set: no job with its ID and a claim younger than
   `LAUNCH_CLAIM_STALE_MS` (10 minutes) is another launch in flight: stop without clearing `due`; an
   older claim with no job is cleared. Then generate the job ID and compare-and-set
   `current: { jobId, claimedAt }`, conditional on `current?.jobId` being what step 2 read
   (Ruling 34). A lost compare-and-set re-reads and repeats this step, at most 5 times.
   *Amended by Ruling 77* (a claim whose job finished is replaced; one whose job is unfinished is
   in flight however old) *and Ruling 78* (a launch whose claim was lost cancels its job).
3. **Pins and creator**, each a pause on failure (the pause also clears `current` and `due`):
   - `resolveJobTemplate(templateId, templateRevision)`: `TEMPLATE_NOT_FOUND` pauses
     `template_gone`, `TEMPLATE_CHANGED` pauses `template_changed` (Ruling 11);
   - the source row: missing pauses `source_gone`; a `fingerprint({ url, credential })` other than
     `sourcePin` pauses `source_changed` (Ruling 40);
   - `ctx.users.get(armedBy)`: `null`, or a role without `import:execute` (F20), pauses
     `creator_gone` (Ruling 43).
4. **Create.** `createJobFrom` with the template resolved in step 3 (M6c Ruling 55) and
   `{ sourceId, templateId, templateRevision, dryRun: false, force: due.force ?? false, id: jobId,
   origin: "schedule", scheduleId, scheduled: "open", feedSourceId: sourceId, publish, batchSize,
   budgetMs, journal: true, missing }` (`JobRequest` gains these fields), where `missing` maps
   `"template"` to no option, `false` to `false` and `{ maxPercent }` to itself (P6). This is
   `jobFromSource`: fetch, the template-aware skip, `createJob` under the claimed ID, `lastImport`
   (P5). `JobExistsError` (an overlapping launch under the same claim, F19) takes that job.
5. **Record** the result in one compare-and-set conditional on `current?.jobId === jobId`, clearing
   `current` and `due` in every case (Ruling 38):

   | Result | `lastLaunch.outcome` | Effect |
   | --- | --- | --- |
   | a job | `started`, `jobId` | `launchFailures` 0; the job is open, so the pump drives it |
   | `{ skipped: "unchanged" }` | `unchanged` | `launchFailures` 0 |
   | `SOURCE_NOT_FOUND` / `NOT_FOUND` of the source | `failed` | pause `source_gone` |
   | `CREDENTIAL_MISSING` | `failed` | pause `credential_missing` |
   | `URL_BLOCKED` | `failed` | pause `url_blocked` |
   | `TOO_LARGE` | `failed` | pause `too_large` |
   | `INVALID_TEMPLATE`, `INVALID_OPTIONS`, `INVALID_SOURCE` (the template no longer fits the site or the feed's columns) | `failed` | pause `invalid_template` |
   | `FETCH_FAILED`, `HTTP_ERROR`, `TOO_MANY_REDIRECTS`, `LENGTH_REQUIRED`, `CONFLICT`, any other error | `failed` | `launchFailures` + 1; at `LAUNCH_FAILURES_TO_PAUSE` (3) pause `fetch_failed` |

   A pause sets `enabled: false` and `pause: { reason, at }`, and cancels `schedule-<id>`. The
   error's code goes in `lastLaunch.errorCode`; its message goes to `ctx.log.warn`, redacted.

### Finalization

For each `scheduled: "open"` job that is finished (pump step 2), in one pass:

| Job | Run log outcome | Effect on the schedule |
| --- | --- | --- |
| `completed`, first pass read no record (`(missing?.fromSeq ?? cursor.seq) === 0`, Ruling 53) | `empty_feed` | pause `empty_feed` (Ruling 45) |
| `completed` with `missing.verdict: "refused"` | `missing_refused` | pause `missing_refused` (Ruling 13) |
| `completed` otherwise | `completed` | none |
| `failed` | `failed` | pause `job_failed`; `clearLastImport(sourceId, jobId)` so the same content runs again once the cause is fixed (Ruling 15) |
| `cancelled` | `cancelled` | pause `cancelled` (Ruling 32), repeating the cancel route's pause; `lastImport` was cleared by the cancel route |

The schedule write (run log entry at the head of `runs`, at most `RUN_LOG_SIZE` kept, and any
pause) is conditional on `current?.jobId` as read; then the job is compare-and-set to
`scheduled: "closed"`. A crash between the two finalizes the job again at the next tick; the run
log entry is keyed by `jobId`, so it is written once. A schedule that no longer exists only closes
the job. A rollback of a finalized job is handled by `jobs/rollback` itself (Ruling 32).

### Missing entries, empty feeds, journal and rollback

- **Every scheduled job keeps a journal** (`journal: true` always, as agent jobs, M6c Ruling 10),
  so any unattended run, its removals included, can be rolled back by an Admin with
  `jobs/rollback`. A rollback job carries no `origin` and is driven by the Admin through
  `jobs/next`, never by the pump; it carries `feedSourceId`, so the schedule stays busy while it
  runs, and the rollback pauses the schedule (`rolled_back`), so the next cron time does not
  re-import what was just undone (Ruling 32).
- **The missing phase runs unattended only by explicit choice** (Ruling 12): the template has
  `rules.missing` and the schedule says `"template"` or `{ maxPercent }` (never higher than the
  template's, Ruling 13). Its threshold and owner checks are M5c's, and a scheduled job carries the
  schedule's `sourceId`, so links created from another source refuse the phase (P6). Links with no
  source (P17) are not refused; see Open issues.
- **An empty feed removes nothing** (Ruling 45). A scheduled job whose first pass ends with
  `cursor.seq === 0` skips the missing phase (`missing.verdict: "skipped"`, with a warning), and
  finalization pauses the schedule `empty_feed`. This is an engine change for jobs with
  `origin: "schedule"`: the threshold would refuse an empty feed only when the template's
  `maxPercent` is under 100.
- **A refused verdict pauses the schedule.** The run imported the feed but removed nothing. The
  Admin checks the feed, then either fixes it and re-enables the schedule, or applies the removals
  once with `jobs/create { sourceId, templateId, missing: { maxPercent: p }, force: true }` (M5c's
  own message says so), then re-enables. That job carries `feedSourceId`, so no launch runs beside
  it (Ruling 33).
- **Dry runs** are never scheduled, and never make a schedule busy (Ruling 33).

### Reconciliation

The `retention` task (hourly), and every `schedules/*` route, call `reconcile(ctx)`: one
`ctx.cron.list()` and one schedules read, then:
- schedule `schedule-<id>` for every enabled schedule whose task is missing or has another
  expression;
- cancel every `schedule-*` task with no enabled schedule;
- arm `pump` when a schedule is due or a job is `scheduled: "open"` (one indexed query) and it is
  missing;
- schedule `retention` at `RETENTION_SCHEDULE` when it is missing or has another expression.

This repairs a lost race between a route and a tick (F3, F19), a site restored from a backup or a
transfer whose cron table and plugin storage disagree, and a pre-0.4.0 site's daily retention task,
which is re-scheduled hourly. Re-enabling the plugin re-enables every task, and each overdue
`schedule-<id>` runs once, which marks its schedule due once (F15, Ruling 49).

### Site fence (Rulings 19, 31)

`siteFence(runtime.db)` mirrors F14's single query, with Kysely's `sql` template and no
interpolated values: an import that is `running` or `verifying`, or `failed` or `cancelled` with
`mutation_started_at` set; a running export; media-usage activation `activating`; and, when the
transfer table is missing, the media fence alone. Any of the three makes launches and batches
stand down; a read error counts as fenced (EmDash's own
`TRANSFER_FENCE_CHECK_FAILED` rule). Standing down during an **export** is stricter than EmDash,
which lets writes run and restarts the export (F14); flux-import keeps it, because a scheduled
import can write for minutes, each batch would restart the export, and EmDash fails an export after
three restarts (M6c F9). Due marks still run (they write only plugin storage). An integration test
pins the query against EmDash's tables (as M2 pinned `_emdash_entry_locks`), so an EmDash upgrade
that changes them fails a test, not a site.

## Security

- **Who sets up a schedule.** Every route requires `import:execute` (Admin); token callers need the
  `admin` scope; cookie callers send `X-EmDash-Request: 1`. `createdBy`, `updatedBy` and `armedBy`
  come from `routeCtx.user`. Agents have no schedule access in M6b (Ruling 50).
- **The actor of unattended writes** (Rulings 4, 5, 44). A scheduled job's content and media writes
  are made with no actor and no `authorId`, exactly as EmDash's own unattended writes (F12).
  **In EmDash, scheduled writes are unattributed**: entries a schedule creates have no author, and
  **the revisions EmDash records for them have no author**, so the admin's revision history shows
  no one for them. Other plugins' save hooks see no actor; content-policy hooks see no actor
  whatever the origin. The lock reader uses the sentinel user `""`, so **every** live edit lock is
  foreign and the entry is skipped as `locked`. Accountability lives outside EmDash's revisions:
  the schedule (`armedBy`, `createdBy`, `updatedBy`), its run log of the last 20 runs (Ruling 42),
  the job (`scheduleId`, `origin`) and the journal.
- **The creator check** (Ruling 43). Before each launch the user who armed the schedule must exist
  and hold `import:execute` (Admin), read with `ctx.users.get` (one query, F13, F20); otherwise the
  schedule pauses `creator_gone`. **A disabled user cannot be detected**: `users:read` does not
  expose the flag (F13), so a disabled Admin's schedule keeps running until another Admin disables
  it, or the user is deleted or demoted.
- **Capabilities.** One added, `users:read`, justified by the creator check alone: it reads one
  user by ID before each launch, and nothing else uses `ctx.users`. Plugin storage, KV and cron need
  none (M6a F12); the fence read uses the trusted runtime's database, as the lock read always has
  (roadmap "Edit locks"), and declares nothing. *Amended by Ruling 43.*
- **Consent.** M6b changes no MCP tool, so no site re-consents (Ruling 50). *Amended by Ruling 50.*
- **Unattended destructive actions.** What a schedule can do without a person present is bounded
  by an Admin's earlier, explicit choices:
  - **Only a saved template, at the revision the Admin armed** (Ruling 11). A later edit of the
    template, by anyone, pauses the schedule instead of running unreviewed mappings or rules.
  - **Only the source the Admin armed, as it was** (Ruling 40). A changed URL or credential name
    pauses the schedule until an Admin re-enables it. *Amended by Ruling 40.*
  - **Only while the Admin who armed it still holds the import permission** (Ruling 43).
  - **Removals only when the Admin chose them for this schedule** (Ruling 12), never above the
    template's threshold (Ruling 13); a refused verdict and an empty feed stop the schedule
    (Ruling 45).
  - **Every write journalled**, so every run can be rolled back, and a rollback or cancel stops
    the schedule instead of being redone at the next cron time (Ruling 32).
  - **Never beside another import or rollback of the same source** (Ruling 33), and a failed job
    stops the schedule.
  - **Nothing during a site import, export or media-usage activation** (Rulings 19, 31).
- **Writes outlive what was armed** (preflight F9, Ruling 74). The bounds above are checked at
  each launch, not during a job:
  - an open scheduled job keeps running after its schedule is disabled or deleted, and after the
    Admin who armed it is demoted or deleted (Ruling 48); the creator check runs only before the
    next launch;
  - `jobs/resume` and `jobs/retry` reopen a closed scheduled job (Ruling 65) whatever the
    schedule's state and whatever `armedBy`'s role now; the Admin who resumes it is the one who
    chose to, but its writes stay unattributed;
  - an open job keeps the `missingLimit` it was created with after the schedule's `missing`
    changes. A change of the template, the source or `missing` on an enabled schedule re-arms it
    to the Admin making the change (`armedBy`), and a change of `missing` is refused while the
    schedule is busy.
- **The cron hook's errors reach EmDash's log redacted** (Ruling 81). EmDash's executor logs a
  hook's thrown error with its stack (`console.error`), so the hook rethrows a new `Error` with the
  redacted message and no `cause`.
- **Untrusted data.** Launch and job errors can quote the feed and the fetcher's text. Schedules
  store and return codes only (Ruling 47); messages stay on the job and in the server log,
  redacted of upload IDs.
- **Network.** A schedule fetches only its source's URL, and media URLs its template maps, both
  behind the SSRF guard. `allowPrivateNetwork` stays development-only.
- **SQL and content queries.** The only raw SQL is the fence read: a fixed `sql` template with no
  values. The engine's content queries already filter by locale (M4e); M6b adds no content query.
- **Tests and tokens.** Tests use the dev-bypass PAT and PATs minted at run time, held in memory
  only (M6c Ruling 26). No token is committed or written to a file.

## Workers and Node

### The tick budget on Workers

*Amended by Ruling 37.* A Cron Trigger invocation runs every due task of every plugin plus
EmDash's scheduled work inside one D1 budget of 1,000 queries (F10), and going over it breaks the
rest of the tick, EmDash's bookkeeping included (F11). The pump does one unit per tick, so
flux-import's worst tick is the sum below. The pump is one of the at most 10 tasks a tick claims
(F4), so when it runs, at most nine other tasks (due marks and `retention`) share the tick; with
more than ten due, the pump may wait for the next tick.

| Work in one tick | Bound | Projected D1 queries (V5 measures) | Measured on the final code (Ruling 83) |
| --- | --- | --- | --- |
| EmDash: claim, a finish update per task, stale-lock recovery, publishing sweep with nothing due, heartbeat | per tick | 10-40 | 10 a tick; 91 on the first event after a start |
| Due marks | at most 8 beside the pump and `retention` | 4 each (get, compare-and-set, pump upsert, EmDash's finish): ≤ 32 | 40 for eight, 12 for one (each event re-created `pump`) |
| Retention | one run, hourly (Ruling 39) | ≤ `RETENTION_QUERY_TARGET` 150 | 156 over 995 job rows: 150 metered and about 6 the hook makes outside the meter |
| Pump, fixed part | fence (1), schedules read (1), finalize query (1), two finalizations (job get and compare-and-set, schedule get and compare-and-set, `clearLastImport` up to 2: ≤ 6 each), batch query (1), idle check (≤ 3) | ≤ 19 | 16 when idle; 27 with two finalizations, one of them a failed, rolled-back job (about 9 statements) |
| Pump unit: **one** of | a batch at the tick caps (`PUMP_QUERY_TARGET`), or a launch (busy query 1, schedule get and claim 2, template 1, source 1, user 1, fetch's source get and compare-and-sets ≤ 3, `jobs/create`'s reads and write ≤ 9, `lastImport` ≤ 3, result 2: about 25) | ≤ 550 | whole pump events: launches 35-45, 6 plain creates 429-453, 6 plain published updates 506-508, 3 linked updates 498-511 |
| **Worst flux-import tick** | | **about 790**, under the 900 V5 must show | **691** (eight marks, two finalizations, a linked batch of three updates, retention at its budget) |

The tick caps, projected from M6c's measurements (a batch costs about 240 queries plus 57 per plain
published update, about 130 plus 120 per linked update) and fixed by V5:

| Cap | Workers request cap (P4) | Tick cap |
| --- | --- | --- |
| Plain records | 11 | `TICK_BATCH_CAP` 6 |
| Linked records (references, taxonomies, bylines, media) | 6 | `TICK_LINKED_BATCH_CAP` 3 |
| Missing phase, count stage | 40 | `TICK_MISSING_SCAN_CAP` 20 |
| Missing phase, act stage | 10 | `TICK_MISSING_BATCH_CAP` 5 |
| Lookup budget | 600 | `TICK_LOOKUP_BUDGET` 350 |

What this leaves out of flux-import's control: other plugins' tasks and a large scheduled-
publishing backlog in the same tick. A site with heavy cron work from other plugins can still go
over 1,000. That is documented (M8), and is the reason Ruling 18 keeps a margin rather than
spending to the limit.

### The free plan

The free plan allows 50 D1 queries per invocation and 10 ms of CPU per Cron Trigger (F9). One
batch costs hundreds of queries (P4), as `jobs/next` already did since M2. Scheduled imports need
the paid plan.

*Amended by Ruling 84.* Retention alone can exceed the free plan's cap. Its hourly run scans 20
job rows a query and deletes in statements of 50 rows, so a run that purges more than about 6 jobs,
or scans more than about 900 job rows, passes 50 queries on its own. The tick then fails (F11),
and once the scan alone is over the cap, retention never deletes again. On the free plan even an
unscheduled site's retention stops working as jobs accumulate.

### CPU and wall time

*Amended by Ruling 35.* One unit per tick bounds each pump tick's time on both runtimes:
- **a batch:** at most the job's `budgetMs` of **wall time** (at most 20 s for a schedule), plus
  the media grace for a download in flight;
- **a launch:** the fetch's wall bound, `FETCH_LIMITS.totalMs` (120 s, P8), plus job creation (an
  XLSX conversion of at most 10 MiB on Workers);
- **finalization:** a few storage calls.

On Workers a Cron Trigger under an hour gets 30 s of CPU and 15 minutes of wall time (F9). A
launch's fetch is mostly I/O; hashing and staging cost CPU in proportion to the body
(`maxSourceBytes`). A batch's CPU is a `jobs/next` batch at a smaller cap. A launch that takes over
a minute overlaps the next trigger's invocation (F19), which has its own budget; its pump task is
still claimed, so the next tick runs no second pump. V5 records wall times.

### The honest ceiling

On Workers a scheduled job advances about one batch a minute: about 6 plain records or 3 linked
records a minute, or 8,600 and 4,300 a day, and a launch takes the place of a batch in its tick.
Unchanged records are cheaper to process but count against the same record caps. That suits feeds
of a few thousand rows a day that change partly. A larger feed on Workers has two documented ways:
- an external scheduler calling `jobs/next` with a PAT (roadmap "External trigger"), each call its
  own invocation at the request caps (11 or 6 records), sharing the job through its lease;
- Node, where the pump runs the job's own `batchSize` (up to 500) every 10 s.

### Node

No D1 limits. The pump runs every 10 s, one unit per tick, the batch at the job's own `batchSize`
within its `budgetMs`. EmDash's timer can run ticks side by side (F19), so a long pump tick does not
hold up publishing; the overlapping work is kept safe by leases and conditional writes.
*Amended by Ruling 35* (no separate Node path).

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `MAX_SCHEDULES` | 20 | One storage page for the pump and the list; due marks per tick |
| `PUMP_SCHEDULE` | `*/10 * * * * *` | Every 10 s on Node; once per Cron Trigger on Workers (F4) |
| Units per pump tick | 1 (a batch, else a launch) | Ruling 35 |
| `FINALIZE_PER_TICK` | 2 | The pump's fixed part stays small (Ruling 37) |
| Tick caps | 6, 3, 20, 5 records; lookup budget 350 | `PUMP_QUERY_TARGET` 550 per batch (V5) |
| `budgetMs` of a schedule | 500-20,000 ms of wall time, default 4,000 | Under the 30 s Cron Trigger CPU limit with margin (F9); under the hook timeout |
| `CRON_HOOK_TIMEOUT_MS` | 180,000 | Above a launch's 120 s fetch plus job creation (Ruling 16) |
| `LAUNCH_CLAIM_STALE_MS` | 600,000 | A crashed launch's claim is cleared after EmDash's own stale-lock time (F6) |
| `LAUNCH_FAILURES_TO_PAUSE` | 3 | Transient fetch failures in a row before a pause (Ruling 14) |
| `RUN_LOG_SIZE` | 20 entries | A few KB per schedule row (Ruling 42) |
| `RETENTION_SCHEDULE` | `17 * * * *` | Hourly, off EmDash's hourly cleanup at minute 0 (F7) |
| Retention scan | pages of `RETENTION_SCAN_PAGE` (20) job rows, at most `RETENTION_SCAN_MAX` (1,000) rows | The full scan behind the keep and held sets (Ruling 39) |
| Retention per run | `RETENTION_QUERY_TARGET` 150 queries, scan pages included | Ruling 39 |

## Testing

- **Unit, schedule service (`MemoryKv`, a fake cron, a fake fence, a fake user lookup, the existing
  engine fakes):**
  - create: each check of "Behaviour" refuses on its own case, in order; the cron grammar accepts
    `0 3 * * *`, `*/15 * * * *`, `@daily` and refuses 6 fields, an ISO datetime, `@reboot`, an empty
    string and 257 characters; `missing` required, refused, over the template's, `"template"`,
    `false`, `{ maxPercent }` at the template's value; the row (with `sourcePin` and `armedBy`) and
    the task are written, and a fake `schedule()` that throws deletes the row;
  - update: revision checks; a compare-and-set lost to a tick's write with the caller's `revision`
    still current is retried, not refused (Ruling 46); `SCHEDULE_BUSY` for a template or source
    change with an open job; `enabled` true clears the pause and failures, re-pins the source, sets
    `armedBy` and schedules, false cancels and leaves the open job running; a new `cron`
    re-schedules;
  - delete: busy, stale claim; `run`: disabled, busy (an Admin's import, an agent's real import and
    a rollback on the same source each), queued with `force`;
  - `templates/delete` and `sources/delete` refuse `TEMPLATE_IN_USE` and `SOURCE_IN_USE`;
    `templates/update` and `sources/update` warn about pinned schedules;
  - `jobs/cancel` and `jobs/rollback` of a scheduled job pause its schedule (`cancelled`,
    `rolled_back`) and the rollback marks the run log entry; of any other job they touch no
    schedule;
  - `schedules/list` holds no message string (checked recursively against the stored messages of
    a failed launch and a failed job).
- **Unit, due marks:** a mark on an enabled schedule arms the pump; an existing mark is kept; a
  disabled or missing schedule cancels its task; the write is conditional on `current?.jobId`.
- **Unit, pump:** stands down when fenced (and due marks still land); finalizes at most two jobs per
  tick, as the table says, each outcome with its run log entry and pause, `clearLastImport` for a
  failed job, the job closed after the schedule write and a repeat after a crash between them
  writing one entry; runs at most one batch (the oldest open job, including a resumed job no
  `current` names and a job of a disabled schedule), at the tick caps on Workers (the `onWorkers`
  seam) and the job's `batchSize` on Node; launches only when no batch ran; treats a held lease as
  no batch; leaves a paused job and an agent job alone; cancels itself when idle and re-arms when a
  mark lands between its read and its cancel; the holder is `schedule:<id>:<ulid>`.
- **Unit, launch:** every row of the launch table, including: `busy` for each kind of unfinished job
  on the source and not for a dry run; a younger claim keeps `due`, an older one is cleared; a lost
  claim compare-and-set retried; `template_gone`, `template_changed`, `source_gone`,
  `source_changed` (URL changed; credential renamed), `creator_gone` (user deleted; user demoted to
  Editor), and a disabled user passing (F13, pinned so the gap is visible); `unchanged` with the
  same template revision and `started` after a revision change (M6a Ruling 29); the job has
  `origin: "schedule"`, `scheduleId`, `sourceId`, `feedSourceId`, `scheduled: "open"`,
  `journal: true`, the claimed ID and the schedule's options; `missing` mapped for each value;
  three transient failures pause `fetch_failed`, two then a success reset the count; a `force` mark
  on unchanged content starts a job; every write conditional on `current?.jobId`, with an
  overlapping launch (F19) creating one job.
- **Unit, actor:** a scheduled job's batch, run by the pump and by `jobs/next` with an Admin, writes
  with no actor and no `authorId`, and the lock reader gets `""`; an Admin job's batch still writes
  as the Admin.
- **Unit, engine:** a scheduled job whose first pass reads no record skips the missing phase with
  a warning (Ruling 45); a rollback job and an agent real job carry `feedSourceId`.
- **Unit, retention:** the scan keeps only IDs and upload IDs and counts each page against the
  budget; a run deletes until the budget and resumes from the saved cursor; a job a schedule's
  `current` names and a `scheduled: "open"` job are never purged, whatever their status; finished
  jobs still go, unfinished ones never (M6c Ruling 41); a collection over `RETENTION_SCAN_MAX` rows
  skips the run's deletes with a warning; reconciliation re-schedules a missing `schedule-<id>`,
  arms `pump` for a due schedule, cancels an orphan task, and moves `retention` to hourly.
- **Unit, definition:** `STORAGE.schedules` and the new `jobs` indexes; `users:read` in the
  capabilities with its comment; the hook's timeout; the retention setting's description says
  "hourly", not "daily" (P18); `FLUX_IMPORT_VERSION` 0.4.0; `mcp.tools` and the consent fixture
  unchanged (Ruling 50); every new query names indexed fields only.
- **Integration on `sites/dev`** (`tests/integration/schedules.test.ts`, the existing feed server):
  1. **The acceptance.** Create a template and a URL source over a 20-row CSV, then a schedule with
     `cron: "* * * * *"`. With **no further call**, within 150 s the schedule is marked due, the
     pump launches a job and completes it: 20 entries, published, read back in the template's
     locale, with no author and no revision author; the run log has one `completed` entry with the
     counters.
  2. **Unchanged, changed.** The next minute's launch records `unchanged`. The feed changes two rows;
     the following launch starts a job that updates two and leaves 18 `unchanged`.
  3. **Rollback and cancel stop the schedule.** `jobs/rollback` of the second job pauses the
     schedule `rolled_back` and marks its run log entry; while the rollback job is unfinished,
     `schedules/run` is `SCHEDULE_BUSY`; after re-enabling, a launch runs. A cancelled scheduled job
     pauses `cancelled`.
  4. **Missing entries.** A template with `rules.missing` (`maxPercent: 10`) and a schedule with
     `missing: "template"`: a feed that drops one of 20 rows trashes it; a feed that drops five
     completes with `verdict: "refused"`, removes nothing, and pauses `missing_refused`; an
     empty feed (header only) removes nothing and pauses `empty_feed`.
  5. **Stops.** A template updated to revision 2 pauses `template_changed`;
     `schedules/update { templateRevision: 2, enabled: true }` resumes it. A source URL changed
     through `sources/update` pauses `source_changed`. A template row deleted through `withDb` (the
     in-use refusal blocks the route) pauses `template_gone`. The arming Admin demoted to Editor
     pauses `creator_gone`. A source URL answering 500 three times pauses `fetch_failed`. A failed
     job pauses `job_failed`, and the re-enabled schedule imports the same content again.
  6. **Fence.** A `running` import row in `_emdash_transfer_operations` (through `withDb`): the
     pump runs no batch and no launch and writes nothing; a running export row the same; removing
     them resumes it (V4 pinned).
  7. **Busy and resumed jobs.** An Admin's `jobs/create { sourceId }` real import on the schedule's
     source keeps launches `busy` until it ends. A scheduled job paused by an Admin keeps the next
     launch `busy` and is not batched; resumed, the pump drives it to the end. `jobs/next` on a
     running scheduled job and the pump share it by lease, and the job's counters are exact.
  8. **Run now.** `schedules/run` with `force` on unchanged content queues a launch that starts a
     job at the pump's next tick.
  9. **No MCP change.** `tools/list` holds M6c's six names, and the stored consent still equals the
     fixture.

  Waits use polling with timeouts, not sleeps of fixed length, and `/test/run-scheduled` (P14)
  wherever a tick may be hurried. Expected run time: about 7 minutes.
- **Cloudflare parity on `sites/dev-cf`** (Ruling 41). The test first calls
  `POST /test/stop-cron-timer` (V9), then drives the acceptance sequence (1) and the
  missing-entries refusal (4) with `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*` only. It
  asserts that **job progress happens only in step with those calls**: after each call the job's
  `processed` and status are read; between calls the test waits 15 s and asserts nothing moved; each
  call moves the job by at most one unit (one batch of at most `TICK_BATCH_CAP` records, or one
  launch). If V9 showed that the timer cannot be stopped, the assertion between calls is dropped
  and the review note states that the parity test does **not** prove the scheduled path. V5 runs in
  Task 0 and again in the review run, on the final code.
- **The production build** is not testable while F17 stands (Ruling 26). The review note records a
  fresh `astro build` and `wrangler dev --test-scheduled` attempt; if the blocker is gone by then,
  the acceptance sequence runs on the build with `/__scheduled`.
- **The manual check (the acceptance, recorded in the review note).** `sites/dev` started by the
  harness on a throwaway database, a schedule on the feed server with `*/2 * * * *`, left alone
  for 10 minutes while the feed changes once: the note records each launch outcome, the run log,
  the jobs and their counters, and the entries in the admin; then the same on `sites/dev-cf` with a
  loop of scheduled events after stopping the timer.

## Plan sizing

Eight tasks, then a final fix wave after the whole-branch review:
- (0) Prove V1-V11, and add `POST /test/stop-cron-timer` to `sites/dev-cf` (V9).
- (1) Storage: the `schedules` collection, the `jobs` indexes, `Job.origin`/`scheduleId`/
  `scheduled`/`feedSourceId` (set by `jobFromSource`, `jobs/start` and `createRollback`), the
  `users:read` capability, the version bump; the services split (`withScheduledServices`, an
  optional actor in the content and media ports, the lock sentinel).
- (2) The schedule service and routes: CRUD, checks, the cron grammar, the source pin, the busy
  check, reconciliation, the in-use refusals and warnings, the cancel and rollback pauses.
- (3) Due marks and launch: the claim, the pins and creator check, `createJobFrom` with the claimed
  ID and `origin`, the result table and pauses.
- (4) The pump: finalization and the run log, the batch, the idle cancel, the tick caps, the empty
  feed rule in the engine, the site fence read.
- (5) Retention: the full scan, the bounded purge, the scheduled-job guards, hourly, the settings
  description; the hook dispatch and timeout.
- (6) Node integration and workerd parity.
- (7) The review run: V5 on the final code, the manual check, the note.

Tasks 4 and 5 can run in parallel after 3.

## Rulings

1. **Schedules are documents in a new plugin storage collection.** They are operational records that
   Admins list and change concurrently (as templates, M6a Ruling 1). The cron table holds when a
   task runs, but not the schedule's options, state and history, and `ctx.cron.list()` gives only
   name, expression and times (F1).
2. **One EmDash cron task per schedule, plus one pump.** EmDash parses and validates the expression,
   computes the next run in UTC and claims due tasks atomically (F2-F4); flux-import would otherwise
   need its own cron parser, since EmDash exports none (F2). The pump is separate because a launch
   is one fetch and one job creation, while a job needs many batches across many ticks. *Amended by
   Rulings 35 and 36* (the schedule's task only marks it due; the pump exists only while needed).
3. **The pump owns all batches of scheduled jobs; launches never run a batch.** One task per tick
   then decides how much of the D1 budget flux-import spends on batches (Ruling 18). *Amended by
   Ruling 35* (the pump owns launches too).
4. **Scheduled writes carry no user.** The early idea was to store the schedule creator's user ID
   and run the writes as that user, re-checked before each run with `users:read`. Declined as the
   writes' actor:
   - EmDash's own unattended writes carry no user: plugin `ctx.content` writes and scheduled
     publishing pass no actor, and no `author_id` has a foreign key (F12). A cron run has no caller
     (F12; M6a F-C5), so attributing it to a person would claim an act they did not make at that
     time, and other plugins' save hooks would see a user, with source `"api"`, who was not there.
   - `users:read` cannot tell a disabled user from an active one (F13), so running "as" a user
     would let a disabled Admin's schedule keep writing as them.

   The cost: entries a schedule creates have no author (and no author-inferred byline), and the
   schedule, not the entry, says who set it up. *Amended by Ruling 43* (`users:read` is added for a
   creator check, not for the actor) *and Ruling 44* (stated for EmDash revisions).
5. **A scheduled job's writes are unattributed whoever drives the batch.** The actor follows the
   job (`origin: "schedule"`), not the caller, so an Admin's `jobs/next` on a scheduled job does not
   attribute part of an unattended import to that Admin. The lock reader's sentinel `""` makes every
   live lock foreign, the safe reading when no user is present.
6. **No new capability.** Rulings 4 and 19; plugin storage, KV and cron need none (M6a F12).
   *Amended by Ruling 43* (`users:read` is added).
7. **Expressions are 5-field cron or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, in
   UTC.** A seconds field would fetch a source several times a minute on Node and run once a minute
   on Workers anyway (F4); an ISO one-shot is deleted by EmDash after one run (F4) and is what
   `schedules/run` already gives. flux-import checks the grammar itself, so that EmDash's broader
   parser (F2) never turns a typo into a one-shot, and EmDash's `schedule()` then validates the
   expression. Time zones are not offered: EmDash evaluates every expression in UTC on every host
   (F2), and the list shows `nextRunAt` so the Admin sees what UTC means. *Amended by Rulings 55
   and 56* (flux-import's field grammar; croner's day rules).
8. **A launch is `jobs/create { sourceId, templateId }`, through the same code.** The fetch, the
   template-aware skip, job creation and `lastImport` are M3c's and M6a's, unchanged, so a scheduled
   job is exactly a job an Admin could have created, with `origin`, `scheduleId` and the claimed ID
   added. `force` is not a schedule option: unchanged content is the common case, and a forced run
   is a person's decision (`schedules/run { force }`).
9. **One job per schedule at a time, claimed before the job exists.** The schedule's `current` is
   compare-and-set with the new job's ID before the fetch, and the job is created under that ID
   (P11), as `start_import` claims its dry run first (M6c Ruling 38). Two launches cannot both
   create a job, and a crash leaves at most a claim with no job, cleared after
   `LAUNCH_CLAIM_STALE_MS`. A paused job blocks the next launch, because an Admin paused it on
   purpose. `schedules/run` refuses a disabled schedule. *Amended by Rulings 33 and 38* (busy means
   any unfinished import or rollback of the source; `current` is the claim only) *and Ruling 51*
   (`schedules/run` queues).
10. **Templates and sources in use cannot be deleted; a race pauses.** Deleting either would break
    the schedule silently at its next launch. The check and the delete race with a schedule created
    in between (M6a Ruling 45), so a launch that finds either gone pauses with a reason instead of
    failing.
11. **The template revision is pinned.** A schedule runs the revision the Admin armed it with; a
    different current revision pauses it (`template_changed`) until the Admin updates the schedule.
    Following the latest revision would let any template edit (a new mapping, a new
    `rules.missing`, another owner) run unattended without anyone looking at it as a schedule;
    `start_import` refuses the same change for the same reason (M6c Ruling 7). The cost is one
    `schedules/update` per template edit, and `templates/update` warns which schedules it affects.
12. **The missing phase runs unattended only by an explicit choice per schedule.** A schedule whose
    template has `rules.missing` must state `missing` (`false`, `"template"` or `{ maxPercent }`);
    one whose template has none must not (P6). Removing entries is the only unattended action that
    touches entries absent from the feed, so the Admin who arms the schedule says so in the
    schedule, not only once in the template.
13. **A schedule can lower the threshold, never raise it, and a refused verdict pauses.** M5c's
    `{ maxPercent }` override exists to apply a refused verdict once, after a person looked at the
    feed; on a schedule it would apply that decision to every future run of a feed nobody watches.
    A refused verdict means the feed lost more than the template allows, which is either a broken
    feed or a real change, and needs a person: the run imported the feed and removed nothing, and
    the schedule waits.
14. **Configuration errors pause at once; transient ones after three in a row.** A missing template,
    source or credential, a blocked host, an oversized feed or a template that no longer fits will
    fail every run the same way, so retrying them only adds noise. Network and HTTP errors are often
    transient; three in a row is long enough to ride out a feed's short outage on an hourly or daily
    schedule, and short enough to stop a broken feed within a day.
15. **A failed job pauses the schedule and clears `lastImport`.** `lastImport` is recorded when the
    job is created (P5), so after a failure the same content would be skipped forever; clearing it,
    as a cancel does, makes the re-enabled schedule import it again. The pause makes a person look:
    the job failed after the engine's own three retries (P3), so the cause is not transient.
16. **The hook timeout is 180 s, and every task bounds its own time.** EmDash's timeout does not stop
    a handler (F5): if it fired first, EmDash would log a failure for a task that is still working
    and, within that tick, start the next task beside it. The tasks bound themselves (the fetch at
    120 s, a batch at `budgetMs` ≤ 20 s of wall time), and the timeout sits above both. A schedule's
    `budgetMs` is capped at 20 s, under the 30 s CPU limit of a Cron Trigger (F9). *Amended by
    Ruling 34*: ticks overlap anyway (F19), so the timeout is about honest failure reporting, not
    about keeping tasks in sequence.
17. **At most 20 schedules.** The pump and the list read the collection in one page, and due marks
    are claimed beside the pump in one tick. Twenty covers a site's feeds; more would need paging.
18. **On Workers the pump runs one batch per tick, at caps about half the request caps.** All tasks
    of a tick share 1,000 D1 queries with EmDash (F10), and going over breaks the tick for everyone
    (F11). A pump batch is held to about 550 queries. The caps come from M6c's measured cost per
    record and are fixed by V5. Running batches until a budget is reached would need a count of the
    invocation's D1 queries, which the plugin API does not give. *Amended by Rulings 35 and 37*
    (one unit per tick on both runtimes; the arithmetic of the new model).
19. **The scheduler stands down during a site import, a site export and media-usage activation.**
    EmDash fences its own scheduled publishing and every API write (F14), but not plugin cron or the
    runtime's content handlers, which flux-import calls. A scheduled import during a site import
    would write into a site being replaced. The fence is read with the same query EmDash uses,
    through the trusted runtime's database, as the lock table is read (roadmap "Edit locks"), and
    pinned by a test, since EmDash exports no fence function. *Amended by Ruling 31* (what the
    fence covers, and why the export stand-down is kept).
20. **Five REST routes for schedules.** An Admin needs create, list, update (which also pauses and
    resumes through `enabled`), delete, and run now; `get` is not needed at 20 rows a list.
    Creating, changing or running a schedule sets up unattended writes, removals included, with no
    dry run and no human at the time they happen; that is an Admin's decision, as template
    authoring is (M6c Ruling 4). `run_schedule` as a tool was considered and left out: it would let
    an agent cause a real write with no dry run (M6c Ruling 35) and bring forward a run that can
    remove entries (M6c Ruling 29). *Amended by Ruling 50* (the read tools move to M6d).
21. **`list_sources` shows the host only.** A URL can carry a secret in its query, its path or its
    fragment, and the importer cannot tell a token from a path (M6a Ruling 40). The host is what M6c
    already lets an agent see through fetch errors (M6c Ruling 57). `lastError` gives the code
    without its message. The tool is backed by a new `sources/overview` route, not `sources/list`,
    so that no REST caller's response changes (M6c Ruling 56's constraint) and the tool's input is
    its route's (M6c Ruling 2). *Amended by Ruling 50*: the rule binds M6d, which builds it.
22. **Each driver drives its own jobs: the pump only `origin: "schedule"`, `next_batch` only
    `origin: "agent"`, `jobs/next` any.** This settles M6c Ruling 43's lease competition: the pump
    and an agent never compete for a job. An Admin's `jobs/next` may share a scheduled job with the
    pump; the lease keeps them safe (P3), and it is the documented way to go faster on Workers
    ("The honest ceiling"). `next_batch` on a scheduled job stays `JOB_NOT_AGENT`: an agent cannot
    drive unattended work.
23. **The tool change costs one re-consent, now.** Two tools change the snapshot (M6c F3); before
    M8 only dev sites pay it (M6c Ruling 39). *Amended by Ruling 50*: M6b changes no tool; the
    re-consent happens once, with M6d.
24. **`start_import` jobs are not handed to the scheduler.** M6c Ruling 37 left it open. Declined:
    - an agent's job runs while the agent drives it, and "stopping is not calling `next_batch`"
      (M6c "The agent's flow"); a hand-off would let an import continue after the agent and its user
      stopped, with no Admin having set anything up;
    - the opt-in would be a new `start_import` input, a consent change made for a flow that the
      Workers ceiling limits anyway (one batch a minute, Ruling 18);
    - large or recurring feeds belong to schedules, which an Admin sets up.
25. **Retention becomes hourly and bounded.** With schedules, jobs and their record and journal
    rows accumulate steadily, and the daily run deletes them all in one invocation (P7): a feed of
    a few thousand changed rows a day already passes 1,000 D1 queries at 03:00, the same tick as
    the pump. Each run now deletes a bounded number of rows and runs every hour at minute 17.
    Unfinished jobs are still never purged (M6c Ruling 41). The change applies to every site, with
    or without schedules, and reconciliation moves the existing daily task. *Amended by Ruling 39*
    (the full scan, the scheduled-job guards, the budget and the label).
26. **The acceptance on Cloudflare is proven on the dev server's real `scheduled()` event; the
    production build stays blocked.** F17 reproduces the M2 build failure today, so a built Worker
    cannot run at all on this machine. `astro dev` runs the site's own `src/worker.ts`, and a
    scheduled event through `/cdn-cgi/handler/scheduled` runs the same `createScheduledHandler`,
    `runScheduledTasks` and executor code in workerd against local D1 and R2 (F16). What it cannot
    show is the production bundling and the enforced D1 limit (V2); both move to the first deploy.
    *Amended by Ruling 41* (the test must show the progress comes from those events).
27. **Ruling 9 of M6c's extra run is accepted.** A real job from an agent's URL-source dry run records
    no `lastImport` (M6c Ruling 9), so the next scheduled launch of that source with the same
    template is not skipped. That run finds every record `unchanged` and costs one job's batches.
    Recording `lastImport` from `start_import` would guess at which fetch the dry run read.
28. **`budgetMs` and `batchSize` belong to the schedule, `journal` does not exist.** M6a Ruling 12
    put job options on the schedule: `publish`, `batchSize`, `budgetMs` and `missing` are there.
    Every scheduled job journals, so an unattended run can always be undone.
29. **The scheduler reconciles its cron tasks from storage.** The cron table and plugin storage are
    written separately (a route writes the row, then schedules the task), and a restore or transfer
    can bring one without the other. Storage is the truth; the hourly reconciliation and every
    schedules route repair the cron table from it.
30. **Version 0.4.0.** A new storage collection and indexes need a version bump (M6a F5).

### Added by the spec review (binding rulings of the coordinator)

31. **F14 is corrected, and the export stand-down is kept as stricter than EmDash.** The import fence
    also covers a cancelled import whose mutation started; a missing transfer table falls back to
    the media fence alone. EmDash does not fence writes during an export: it lets them run and bumps
    the export's write epoch, which restarts it (F14). flux-import still stands down during an
    export, which is stricter than EmDash: a scheduled job writes batch after batch for minutes,
    each would restart the export, and three restarts fail it (M6c F9). Bumping the epoch itself
    would mean writing EmDash's internal transfer table. Amends Ruling 19 and "Site fence".
32. **A rollback or cancel of a scheduled job pauses its schedule.** Otherwise the next cron time
    re-imports what the Admin just undid or stopped. `jobs/rollback` of a job with a `scheduleId`
    pauses the schedule `rolled_back` and marks the job's run log entry; `jobs/cancel` pauses it
    `cancelled`, and the pump's finalization repeats that pause for a cancel it finds. Re-enabling
    is the Admin's explicit step. Amends Ruling 9 and the finalization table (a cancel had no
    effect).
33. **A launch is busy while any unfinished import or rollback reads the schedule's source.** The
    rule was "the schedule's own previous job". It now covers every real job and every rollback of
    any origin whose `feedSourceId` is the source: an Admin's import or its `{ maxPercent }` re-run,
    an agent's real import, another schedule's job, a resumed or retried scheduled job, and any
    rollback of them. Two writers over the same feed's entries would race, and a launch beside a
    rollback would re-import what it undoes. The check is one indexed query
    (`["feedSourceId", "dryRun", "status"]`); `feedSourceId` is a new field because `sourceId` also
    stamps link ownership and is absent from rollbacks and agent jobs (P16). Dry runs never make a
    schedule busy: they write nothing, and an abandoned agent dry run is kept unfinished forever
    (M6c Ruling 41), which would block the schedule forever. `schedules/run` answers
    `SCHEDULE_BUSY` by the same check. Amends Rulings 9 and 22.
34. **Every cron write is conditional on `current?.jobId`, and nothing relies on tasks running in
    order.** The "one after another" premise holds only within one tick: on Node a hook that
    schedules or cancels a task makes `reschedule()` re-arm the timer, so a second tick starts while
    the first runs, and on Workers a long tick overlaps the next invocation (F19). So every claim,
    due mark, launch result, finalization and pause is a compare-and-set loop on the newest row that
    re-checks `current?.jobId` against the value its decision was made on, re-decides when it
    differs, and never sets a field it does not own. Amends Ruling 16's premise, F4 and the
    "Writes" rule of Storage.
35. **All heavy work happens in the pump, one unit per tick, on both runtimes.** `schedule-<id>` only
    marks its schedule due (a get and one compare-and-set, no fetch) and arms the pump. Each pump
    tick does, in order: bounded finalization; at most one batch of one open scheduled job; and, only
    if no batch ran, at most one launch of one due schedule (fetch, then create). This bounds every
    invocation's CPU, wall time and D1 queries by one unit, on Workers and Node alike, and drops the
    separate Node path (one batch of each running job per tick). `budgetMs` is wall time, and a
    launch's wall bound is the fetch's 120 s timeout plus job creation. The cost is latency: a
    launch waits while another scheduled job has a batch to run, and on Workers each launch takes a
    tick from the batches. Amends Rulings 2, 3, 8 (where the launch runs) and 18, and "The
    scheduler".
36. **The pump exists only while it has work.** It is armed by a due mark, `schedules/run` and
    reconciliation, and it cancels itself when no schedule is due and no job is open. Its cancel
    is followed by a second read of the schedules, which re-arms it if a mark landed meanwhile:
    since a due mark writes the mark before it arms the pump, either the second read sees the mark
    or the arm comes after the cancel. Hourly reconciliation repairs anything left. Amends Ruling 2.
37. **The tick arithmetic is redone for the one-unit model.** A tick holds EmDash's work, due marks
    (at most eight beside the pump and retention, since a tick claims ten), one retention run, the
    pump's fixed part (fence, schedules read, two finalizations, the job queries, the idle check)
    and one unit; the projection is about 790 queries ("Workers and Node"). V5 must measure the
    worst tick under 900. Amends Ruling 18 and the budget table.
38. **The pump drives every open scheduled job; `current` is only the launch claim.** A job created
    by a launch carries `scheduled: "open"` until the pump finalizes it, and the pump finds batches
    and finalizations through the indexed `["scheduled", "status", "createdAt"]` query, not through
    the schedule's `current`. So a scheduled job an Admin resumes or retries after it stopped is
    driven again instead of being orphaned, and a job of a disabled or deleted schedule still
    finishes and is finalized. `current` is set before the fetch and cleared when the launch ends,
    whatever its result; Ruling 33's busy check stops a second launch beside an open job. Amends
    Ruling 9, "Storage" and "Pump".
39. **Retention keeps its bounded purge, with a full scan for the keep and held sets, and never
    purges a scheduled job before it is finalized.** A page-by-page purge with sets built from the
    current page alone could delete a staged file that a job on a later page still reads, or an
    original a rollback on a later page holds. So each run first scans every job to build the keep
    set (upload IDs) and the held set (originals of rollbacks), keeping only IDs and upload IDs. EmDash's storage query has no
    projection (F21), so the scan reads rows whole, 20 per page, keeps those fields and drops the
    rest; each page is one query, counted against `RETENTION_QUERY_TARGET` (150). A raw projected
    read of `_plugin_storage` was considered and rejected: it is an internal table, and its JSON
    functions differ between SQLite and PostgreSQL. A collection over `RETENTION_SCAN_MAX` (1,000)
    rows makes the run skip its deletes with a warning (Open issues). The purge never takes a job
    that a schedule's `current` names (one schedules read) or a `scheduled: "open"` job, whatever
    its status, so the pump always finalizes it first. The settings description in
    `definition.ts` (P18) changes from "deleted daily" to "deleted hourly"; that edit ships with the
    retention change (Task 5), since the current code still runs daily. Amends Ruling 25.
    *Amended by Rulings 72 and 82* (pages of 50; the label shipped with the hook wiring).
40. **The source is pinned.** Arming a schedule stores `sourcePin`, a fingerprint of the source's
    URL and credential name (`fingerprint`, `src/engine/fingerprints.ts:24-42`). A launch whose source has
    another URL or credential name pauses `source_changed`, and re-enabling takes the pin again.
    A source URL is a destination for unattended fetches and, with its credential, defines what
    "the feed" is; changing it should not silently re-point a schedule that can remove entries.
    `sources/update` warns which schedules it will pause. Amends the Goal, Security ("Only the
    source the Admin named") and the roadmap row.
41. **The Cloudflare parity test must show that progress comes from scheduled events.** The dev
    server also runs EmDash's timer (F7), which would drive the same tasks. The test stops it first
    (`runtime.stopCron()` through a dev-only `POST /test/stop-cron-timer` in `sites/dev-cf`, F7),
    then asserts that the job moves only in step with `/cdn-cgi/handler/scheduled` calls and not
    between them. V9 proves the stop works; if it does not, the review note says plainly that the
    parity test does not prove the scheduled path. Amends Ruling 26 and "Testing".
42. **Each schedule keeps a run log of its last 20 runs.** An entry per finished job: `jobId`, time,
    counters, outcome and rollback status. It lives on the schedule row, which retention never
    purges, so the history of unattended runs survives the jobs and their records being purged,
    and a reader can see what each run did and whether it was rolled back. It is written by
    finalization (keyed by `jobId`, so once) and by `jobs/rollback`.
43. **`users:read` is added for one check: before each launch, the user who armed the schedule
    must still exist and hold `import:execute`.** `ctx.users.get(id)` reads one user and returns
    the role, or `null` for a deleted user (F13), and `hasPermission` compares the role with
    `import:execute`'s level, Admin (F20). So the check is one query per launch, and a schedule
    whose Admin was deleted or demoted pauses `creator_gone` instead of running on that Admin's
    authority. "The creator" is `armedBy`, the user of the last create or update that enabled the
    schedule, so another Admin can take a schedule over by re-enabling it. **A disabled user cannot
    be detected**: `UserInfo` has no `disabled` flag (F13), so a disabled Admin's schedule runs until
    the user is deleted or demoted, or another Admin disables the schedule (Open issues). The writes
    still carry no actor (Ruling 4). Amends Rulings 4 and 6, Decisions and Security.
44. **Scheduled writes are unattributed in EmDash revisions, and the spec says so plainly.** With no
    actor, EmDash records the revisions of scheduled writes with no author (F12): the revision
    history shows no one. The run log (Ruling 42), `armedBy` and the journal are where "who" is
    answered. Amends Ruling 4 and Security.
45. **An empty feed skips the missing phase and pauses the schedule.** A scheduled job whose first
    pass reads no record (a feed that answered with a header only, or nothing) would otherwise make
    every owned entry missing; with a threshold of 100 % it would remove them all. The engine skips
    the phase for such a job (`origin: "schedule"`, `cursor.seq === 0`), and finalization pauses
    `empty_feed`. An empty feed needs a person whatever the template allows. *Amended by Ruling 53*
    (the engine already skips the phase for every job; finalization detects the empty feed).
46. **Routes retry a compare-and-set lost to a tick.** Ticks write schedule rows without changing
    `revision` (due marks, launches, finalization), so a route whose compare-and-set loses to one,
    while the caller's `revision` is still the current one, re-reads and retries (at most 5 times)
    instead of answering `SCHEDULE_CHANGED`. Only another route write, which bumps `revision`, is
    a conflict the caller sees.
47. **Schedules return codes only, and no user ID goes to MCP.** `schedules/list` returns pause
    reasons, launch error codes and run outcomes, never messages: messages quote feed data and
    fetcher text, and the job keeps them (redacted) for an Admin who reads it. When M6d exposes
    schedules over MCP, the tool view leaves out `armedBy`, `createdBy` and `updatedBy`, and a run
    log entry names its rollback by job ID only.
48. **Disabling a schedule does not stop its running job.** The pump drives every open scheduled job
    (Ruling 38), so a disabled schedule's job finishes. An Admin who wants it stopped cancels it,
    which pauses the schedule anyway (Ruling 32). Stopping a job is a job action, not a schedule
    setting.
49. **Overdue schedules fire once after the plugin is re-enabled, and the name and limit races are
    accepted.** Re-enabling the plugin re-enables every cron task; each `schedule-<id>` whose time
    passed meanwhile runs once (F15, F4), marking its schedule due once, and the pump launches them
    one per tick. The name uniqueness and the `MAX_SCHEDULES` checks run before the write, so two
    concurrent creates can both pass; the result is a duplicate name or 21 schedules, which the list
    shows and an Admin fixes, as M6a accepts for template names (M6a Ruling 5).
50. **The read tools and `sources/overview` move to M6d; M6b adds no MCP tool.** M6d also adds tools,
    so the next re-consent happens once instead of twice. M6b then changes no tool, no description
    and no schema, needs no re-consent, and keeps the consent fixture. Rulings 21 and 47 bind M6d's
    tools. Amends Rulings 20, 21, 23, the Goal, Decisions, "Routes", "Tools" and the roadmap.
51. **`schedules/run` stays, and queues.** It sets the due mark (with `force` when asked) and arms the
    pump, after the disabled and busy checks; the pump launches at its next tick, with every check
    again. So a run never happens beside another job (Ruling 33), and the request never fetches.
    Amends Ruling 9 and "Routes".
52. **The scheduled-handler docs describe a newer EmDash than 1.2.0, and Task 0 re-checks F7 and
    F8.** The docs' handler waits up to 70 s for upcoming entries (`publishUpcomingWithinMs`) and
    their entry point exports room classes; 1.2.0 has none of it (F22). A future handler that waits
    in the same invocation would add wall time to every tick, not D1 queries. V10 records what the
    installed packages do, and the M8 docs follow the installed version.

### Amendments from the plan and review

Recorded by the review (`../notes/2026-11-17-m6b-review.md`); each names the plan ruling, fact or
review finding behind it. They override the text above where they differ; markers at the amended
text point here.

53. **Ruling 45 needs no engine change** (Fact E2, plan Ruling 8). The engine already skips the
    missing phase when the first pass read no keyed record. Finalization reads an empty feed as
    `(job.missing?.fromSeq ?? job.cursor.seq) === 0` on a completed job, before the refused verdict.
54. **The busy index is `["feedSourceId", "status"]`, with dry runs filtered in code** (Fact E4,
    plan Ruling 2): a boolean `where` value is bound as it is. `busyJob` reads at most 5 pages of
    20 (`BUSY_SCAN_PAGES`) and fails closed beyond them (preflight F13; Open issues).
55. **flux-import checks each cron field itself** (Fact E1, plan Ruling 3): `schedule()` takes typos
    as one-shots in the past. Five fields of `*`, `*/n`, `a`, `a-b` or `a-b/n` within each field's
    range (names in month and day of week), or the five aliases, at most 256 characters. The grammar
    also refuses a day of month that none of the listed months has (`0 3 31 2 *`,
    `0 0 31 4,6,9,11 *`), item by item, because such a schedule never fires or crashes croner; this
    is stricter than EmDash (each listed day is checked, `1,31` with April included, and the day of
    week is not considered). A stepped day item is refused only when every value in it is such a
    day, month steps are expanded to exact sets, and a `RangeError` from EmDash's cron library is
    `INVALID_CRON` with its message (Task 2 rulings).
56. **Croner's behaviour is EmDash's, and differs from Vixie cron.** A stepped day of month with a
    day of week ORs the two (`0 0 */24 * mon` runs every Monday and on days 1 and 25), and croner
    10.0.1 can skip early-March runs after a February run when the day list holds a day February
    lacks (`0 0 1,31 * *` from 2027-02-10 next runs on March 31, not March 1). flux-import does not
    work around either; the M8 docs should state them, and the second is an upstream report candidate.
57. **F5 differs on workerd** (Fact V7): a timed-out hook's handler is abandoned when the invocation
    ends instead of running on. The hook's timeout is `CRON_HOOK_TIMEOUT_MS` 180 s (Ruling 16), not
    F5's 60 s.
58. **F16's "the timer also ticks" was not reproduced** (Fact V9): a fresh workerd isolate's timer
    did not tick in 60 s. The parity test stops it anyway (Ruling 41).
59. **V5 measured eight due marks, not nine**: nine marks, the pump and retention are eleven tasks,
    and a tick claims at most ten (F4).
60. **`POST /test/stop-cron-timer` lives in the test sites, never in the plugin** (plan Ruling 1):
    403 unless `import.meta.env.DEV`, 403 without `X-EmDash-Request: 1`; both sites' files are
    identical, and both integration tests check the 403 without the header.
61. **The pump's held-lease test reads the lease from its own query** (Fact E3, plan Ruling 4): a
    live lease means no batch, and the launch may run; any other job gets a batch, which is the
    tick's unit even if its claim is refused.
62. **`schedules/update` schedules the task before it writes the row** (plan Ruling 5), so EmDash's
    refusal changes nothing. Any failure after that re-synchronises the task from the newest row
    (scheduled if enabled, cancelled if disabled or gone; Task 2 review).
63. **A disabled schedule is never due** (plan Ruling 6): a pause, `enabled: false` and a disabled
    schedule's due-mark task drop `due`; the pump, the idle check and reconciliation consider only
    rows with `enabled && due`.
64. **A launch in flight makes a schedule busy for the routes** (plan Ruling 7): `schedules/delete`,
    `schedules/run` and a template or source change answer `SCHEDULE_BUSY` with the claimed ID
    while `current` is younger than `LAUNCH_CLAIM_STALE_MS`.
65. **A resumed or retried scheduled job that was already finalized is reopened** (plan Ruling 11):
    `scheduled: "open"` again and the pump armed, whatever the schedule's state ("Security").
    Finalization then replaces the job's run log entry when its outcome changed, and writes nothing
    when the same entry is there.
66. **Finalization repeats a rollback's pause, as a cancel's** (plan Ruling 12), and marks the run
    `rolledBack`. It works only when the rollback comes before finalization (preflight F20), and a
    repeated cancel or rollback pause is skipped once a route changed the schedule after the job
    (`row.updatedAt > job.updatedAt`, preflight F10). Any route edit, even a rename, therefore stops
    the repeat; that matters only when the route's own best-effort pause was lost too.
67. **`createJobFrom` and the services builders move to `src/plugin/services.ts`** (plan Ruling 9);
    `ensureRetentionScheduled` moves to `retention.ts`.
68. **`jobs/next` reads the job before it builds its services** (plan Ruling 10): one `get` more per
    call, so a scheduled job's batch is unattributed whoever calls. `jobs/step` is unchanged.
69. **"Has a key" is the template's shape check** (plan Ruling 13): `templateSchema` requires `key`,
    and a key may be an expression, not only `from`. Amends "Behaviour" step 3's `key.from` rule.
70. **`sources/update` returns `warnings` only when there are some** (plan Ruling 14), so REST callers
    see no change otherwise.
71. **The schedule inputs are strict** (plan Ruling 15): a misspelt key is `VALIDATION_ERROR`. Their
    bodies are capped at 16 KiB (`SCHEDULE_BODY_MAX_BYTES`), and a schedule name refusal has its own
    wording ("A schedule name is 1-100 characters, …"; Task 3 review).
72. **Retention counts one unit per storage call, and deletes in pages of 50** (plan Ruling 16, Task 6
    review): EmDash's `deleteMany` runs one statement per 50 IDs (`SQL_BATCH_SIZE`), so a page of 50
    keeps each metered call one D1 statement. A run may pass its target by one call (the cursor
    write).
73. **The cron hook's dispatch lives in `src/plugin/scheduler.ts`, and `plugin:activate` runs
    `reconcile`** (plan Ruling 17), without the runtime (preflight F5: a runtime inside activation
    waits for the init lock on a fresh database), and never throws: a failed activation would make
    EmDash disable the plugin, so it logs a redacted error and hourly retention repairs the tasks.
74. **An update that changes the template, the source or `missing` of an enabled schedule re-arms it
    to the caller, and a change of `missing` is refused while the schedule is busy** (preflight F9).
    Writes outliving what was armed are stated in "Security".
75. **The integration tests drive ticks deterministically after the acceptance** (plan Ruling 18).
    Their failing feed answers 404, not 500 (Fact E7): the fetcher reports both as `HTTP_ERROR`, a
    transient launch failure.
76. **The creator check compares the stored role with `Permissions["import:execute"]`** (plan
    Ruling 19, F20); a missing `ctx.users` or a non-numeric role fails closed (`creator_gone`).
77. **A launch replaces a claim whose job has finished** (plan Ruling 20; amends "Launch" step 2). A
    claim younger than `LAUNCH_CLAIM_STALE_MS` with no job, or one whose job is unfinished however
    old, is a launch in flight; a stale claim with no job, or one whose job has finished, is replaced.
78. **A launch whose claim was lost cancels and closes the job it created** (preflight F6), so a pause
    or a rollback is never beaten by a launch already in flight; a cancelled orphan reaching
    finalization is closed with no run entry and no pause.
79. **A route pause always wins and drops the claim; an automatic pause never replaces one**
    (preflight F7, Task 5 ruling). `pauseSchedule` (cancel, rollback) is not conditional on
    `current?.jobId` and overwrites any pause; the launch's record and finalization keep a pause
    already on the row (`pausedKeeping`). Amends "Storage > Writes" for route pauses.
80. **The pump drives only `origin: "schedule"` jobs** (preflight F8, Ruling 22): any other open job
    is closed with no run and no batch, and closing it is the tick's unit.
81. **The cron hook rethrows a new `Error` with the redacted message and no `cause`** (Task 7 review,
    preflight F12), because EmDash's executor logs a thrown error with its stack.
82. **The "hourly" settings label shipped with the hook wiring (Task 7)**, not with the retention
    change, since the definition files were busy in that wave (preflight F14; amends Ruling 39).
83. **The tick budget is re-measured on the final code** ("The tick budget on Workers", V5 in the
    review): a worst-case finalization (a failed, rolled-back job) is about 9 statements, so the
    pump's fixed part is about 21-22; the retention hook adds about 6 calls the meter does not count
    (settings, latest uploads, and reconciliation's `cron.list`, schedules read and open-job check);
    the worst event measured 691.
84. **On the free plan, retention can exceed the 50-query cap on its own** ("The free plan").
85. **Smaller behaviours fixed by the reviews:** a due mark is one read and one compare-and-set, then
    the pump (4 queries), and cancels the task of a schedule disabled or deleted meanwhile; a stored
    `errorCode` is a well-formed code or `INTERNAL_ERROR`; the busy record is conditional on a due
    mark; `schedules/run` maps a lost write to `SCHEDULE_DISABLED` or `SCHEDULE_BUSY` when the
    re-read shows why, and a row deleted meanwhile answers `CONFLICT`; reconciliation reports
    failures in `ReconcileResult.failed`; `schedules/list` projects the row's known fields; a
    rolled-back run's log entry has the rollback's time in `at` (the original's `updatedAt`).

## Out of scope

- **Uploaded or pasted sources:** a schedule has to fetch new data at each run.
- **One-shot and sub-minute schedules** (Ruling 7), **time zones** other than UTC (Ruling 7), and
  **catching up missed runs** (F4: EmDash runs one late run, then the next slot).
- **Every MCP tool**, `sources/overview` included (M6d, Ruling 50), and **`run_schedule`**
  (Ruling 20).
- **The `start_import` hand-off** (Ruling 24).
- **A user actor for scheduled writes** (Rulings 4, 44).
- **Notifications** when a schedule pauses: the plugin has no `email:send`, and a capability for it
  is M7's or M8's call. The pause is visible in `schedules/list`.
- **A dry run per scheduled run, or approval gates:** the schedule is the Admin's standing approval,
  bounded as "Security" says.
- **Raising thresholds from a schedule** (Ruling 13).
- **The admin screens** (M7) and **the README, upgrade notes and `skills/` entry** (M8).

## Open issues

- **The D1 budget per tick is inferred, not measured on Cloudflare** (F10, V2). Local workerd does
  not enforce it. The first deploy must run V5's sequence against production, with `wrangler tail`
  showing every tick "Ok" and no `Too many API requests` error.
- **Other plugins and EmDash's publishing backlog share the tick** (Ruling 18). flux-import keeps
  its share under about 790 queries; a site whose other cron work is heavy can still exceed 1,000,
  which breaks that tick's bookkeeping for every plugin (F11). M8 documents it.
- **The production build blocker** (F17, Ruling 26), unchanged since M2: the scheduled handler on a
  build is unverified.
- **The parity test may not prove the scheduled path** if V9 finds that the dev server's timer
  cannot be stopped (Ruling 41).
- **The fence read depends on EmDash internals** (Ruling 19): two internal tables, pinned by a test.
  An EmDash release that exports a fence function should replace it.
- **Disabled users are not detected** (Ruling 43). A disabled Admin's schedule keeps running until
  the user is deleted or demoted, or another Admin disables it. If EmDash exposes the flag to
  `users:read`, the creator check should use it. M7's schedule list should show `armedBy`.
- **Unattributed content** (Rulings 4, 44): entries and revisions a schedule writes have no author.
  If EmDash adds a documented system or plugin actor, scheduled writes should use it.
- **Ownership without a source** (P17). Agent paste jobs (and inline or upload imports) stamp the
  owner without `ownerSource`, so the entries they create count as a schedule's own removal
  candidates when the schedule's template has the same owner. M5c's owner warnings and M6a's
  `OWNER_IN_USE` cover saved templates, not paste jobs. A fix would stamp a non-source origin on
  such links and refuse it in a scheduled job's missing phase.
- **Jobs saved before 0.4.0 have no `feedSourceId`** (Ruling 33), so an import left unfinished
  across the upgrade does not make a schedule busy. Schedules are new in 0.4.0, so only a job
  started before the upgrade and still running when a schedule is created on its source is missed.
- **Retention over 1,000 jobs** (Ruling 39): a site that keeps more than `RETENTION_SCAN_MAX` job
  rows (a long retention period with many runs) skips its deletes with a warning until
  `retentionDays` is lowered. Summary rows (the M6a `jobs/list` issue) would lift it.
- **More than 100 unfinished dry runs on one source make it busy** (Ruling 54, preflight F13).
  `busyJob` reads at most 5 pages of 20 and fails closed: every launch and `schedules/run` on that
  source answers busy, naming a dry run as the busy job, until the dry runs finish or are
  cancelled. M6c keeps abandoned agent dry runs; M7's dry-run clean-up should remove the case.
- **Retention on the free plan** (Ruling 84): above about 6 purged jobs or 900 scanned job rows a
  run exceeds 50 queries on its own, and once the scan alone does, retention never deletes again.
  M8 documents it beside "imports need the paid plan".
- **Croner's early-month skip** (Ruling 56): `0 0 1,31 * *` after a February run next fires on
  March 31. EmDash's (croner 10.0.1), not flux-import's; an upstream report candidate.
- **A rolled-back run's log entry shows the rollback's time** (Ruling 85), not the job's end:
  `createRollback` moves the original's `updatedAt`. Nothing reads it today; M7's run list should
  show `rolledBack.at` instead.
- **The finalization repeat of a lost route pause is fragile** (Ruling 66): any route edit after the
  job, a rename included, stops it. It matters only when the route's best-effort pause was lost too.
- **`sourcePin` can confirm a guessed URL** (Task 2 review). It is a fingerprint of the URL and
  credential name, so an Admin who can read a schedule can test a guess against it. Only Admins
  read it today; M6d's MCP view of schedules leaves `sourcePin` out.
- **Throughput on Workers** ("The honest ceiling"): about 6 plain or 3 linked records a minute.
  Feeds larger than a few thousand changed rows a day need Node or an external `jobs/next` trigger.
- **Edge-cache invalidation** (F18): imported entries, scheduled or not, are written through the
  runtime's handlers, which do not purge edge-cache tags. With a cache provider, pages may show
  stale content until their TTL. This predates M6b and becomes more visible without a person
  watching; the fix (purging the written entries' tags after each batch) is a separate change.
- **A template edit or a source change pauses its schedules** (Rulings 11, 40) until each is
  re-enabled. M7 can offer "update the schedules too" on save.
- **Clock skew** (M5c review, M6c review F1): the missing phase orders jobs by ULID time; a host
  clock that steps back can make it skip links (fail-safe). Unattended runs make this rarer to
  notice; the refused or reduced verdict is visible on the job.
- **From M6c and M6a** (each documented there): the export restart on every tool call during a site
  export; consent changes an EmDash or Zod upgrade can make; the server-side approval gate (M7);
  OAuth and the plugin scope; agent jobs not bound to their user; unfinished agent jobs
  accumulating; the redaction gaps; production D1 unverified.
- **Carried forward:** the M2-M6c open issues, and the `package.json` version (0.1.0) against
  `FLUX_IMPORT_VERSION` (0.4.0) until M8.
