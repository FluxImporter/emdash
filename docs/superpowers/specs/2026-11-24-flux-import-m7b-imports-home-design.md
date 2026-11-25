# flux-import M7b: the Imports home in the EmDash admin

Date: 2026-11-24. Roadmap row: Milestone 7 (`2026-10-07-flux-import-roadmap-design.md`, "Milestone 7
split"), second part. M7a (`2026-11-23-flux-import-m7a-admin-wizard-design.md`, merged as PR #19)
shipped the import wizard; M7b is the home that manages what the wizard and the API create. The
agreed mockup is the "Imports home" box in `.superpowers/brainstorm/54303-1795444286/content/
flow-and-home.html` (local).

## Intent

After M7a an Administrator can run an import from the admin, but everything that outlives one
run is still reachable only through the API or MCP: the history of jobs and their rollback, the
saved templates, the URL sources and their credentials, and the schedules. M7b gives that a home
in the admin, one page with four tabs and a "New import" button, so a site owner can see what was
imported, undo it, reuse a template, keep a feed's address and credential, and set an import to
run on its own, without touching the API.

Success: on `sites/dev`, an Administrator who has never seen the API, starting from the M7a
acceptance data, finds the import they ran in Jobs, opens its log, rolls it back after seeing what
the rollback will do, exports its template and imports it again under another name, adds a URL
source with a credential, creates a daily schedule from the template and that source, runs it
now, sees the run in Jobs and in the schedule's run log, pauses and deletes the schedule, and
clears the dry runs Preview left behind. That manual run, recorded in the review note, is M7b's
acceptance.

## Goals

- One page, "Imports", with Jobs, Templates, Sources and Schedules tabs and a "New import" button,
  as in the agreed mockup.
- Rollback from the admin, always after a dry-run summary of what it will do.
- Scheduling from the admin: create, edit, pause, resume, run now, delete.
- The home shows what really happened: real imports only in Jobs, dry runs folded away and
  clearable, and the site fence shown when it stops schedules.
- Looks and behaves like M7a and the rest of the admin: Kumo, the admin's theme, message
  descriptors, keyboard and screen-reader support.

## Non-goals (M7b)

- Editing a template's mapping outside the wizard. "Use" opens the wizard with the template
  loaded; the wizard's "Save the changes" is how a template is edited. M7b renames, describes,
  exports, imports and deletes.
- New engine features, formats or field types. AI provider settings stay in EmDash's plugin
  settings screen.
- A dashboard widget, notifications or email.
- Agents' MCP flows: unchanged.

## Anti-goals (would make M7b a failure even if it works)

- Jobs that are mostly dry runs, or a list so heavy it is slow on a site with hundreds of jobs.
- A rollback that deletes entries without first saying how many and which way.
- A schedule that silently does nothing (fenced site, disabled, paused after a failure) with no
  word on screen.
- A credential value shown anywhere, or an upload ID, or a source URL's query string where the
  list only needs the host.
- A second copy of a host library, or classes the admin's CSS doesn't ship (M7a's rules).

## Constraints

- EmDash 1.2.0's native React admin, as in M7a: the plugin's `admin` entry, `pages`, Kumo 2.6.0,
  Lingui, React Query, `apiFetch` with `X-EmDash-Request: 1`. The admin module's runtime imports
  stay M7a's set. Every string is a message descriptor; only the admin's prebuilt CSS classes.
- Administrators only, like every flux-import route.
- Server changes are limited to the four additions below (decided by the user). Everything else
  calls routes that exist today: `jobs/list|get|log.csv|pause|resume|cancel|retry|rollback|
  records`, `templates/list|get|update|delete|export|import`, `sources/list|create|update|delete|
  fetch`, `credentials/list|set|delete`, `schedules/list|create|update|delete|run`.
- M7a's open issues bound the design: the host doesn't remount a plugin page on its own
  navigation (Ruling 12), Kumo classes missing from the admin CSS have no effect.

## Approaches considered

One sensible way: native React pages in the plugin, as M7a (approach 1 of M7a, which the user
chose). Iframes or Astro pages were ruled out in M7a; the home must share the wizard's libraries,
messages, error sentences and test harness, so building it anywhere else would duplicate them.

## Decided by the user

- Scope: M7b is the Imports home with four tabs and a "New import" button; rollback and scheduling
  from the admin (M7 split, scope B).
- The layout and contents of the home as in the mockup's "Imports home" box, and the playback of
  2026-11-24 ("all good"), including the proposals marked as the coordinator's below.
- **Yes to three small server additions** (2026-11-24): a real-imports filter and summaries on the
  job list, a way to clear dry runs, and the site fence's state for the Schedules tab.
- **Yes to a fourth, split rollback counts** (2026-11-24, after the builder check): the rollback
  dialog says exactly how many entries will be deleted and how many restored, so rollback jobs
  count each kind separately.

## Where it lives (coordinator's call, approved in the playback)

- A new plugin page, the home, labelled "Imports", and M7a's wizard at `/import` labelled "New
  import", both in one sidebar folder "Imports" through `PluginAdminPage.group` (EmDash 1.2.0
  `types-*.d.mts`, "Pages sharing a group … share a folder with that label in the Plugins
  section"). The home's path is the plan's to verify (`/` if EmDash mounts it at the plugin root,
  otherwise `/imports`).
- "New import" on the home and "Start a new import" on the wizard's Run screen lead to the wizard;
  each row that names a job links to the wizard's Run screen (`/import?step=run&job=<id>`), which
  M7a already supports.
- The selected tab is kept in the URL (`?tab=jobs|templates|sources|schedules`), read at mount, so
  a reload or a shared link opens the same tab. Default: Jobs.

## The home

```
Imports                                                    [ New import ]
 Jobs | Templates | Sources | Schedules
```

A page heading, the tabs (Kumo `Tabs`, with a tabpanel), and the button. Each tab loads its list
when first shown and keeps it in React Query; actions invalidate what they change.

### Jobs

- Real imports only (no dry runs), newest first, a page at a time ("Load more").
- Each row: the template's name (or "One-off import"), the collection and locale, when it started
  (relative, with the exact time in a tooltip or accessible text), the origin (wizard, API, agent,
  schedule — whatever the job records), the status in words with a text badge, and the counts
  (created, updated, unchanged, failed; "rolled back" when it was).
- Actions per row, offered only when the job's state allows them: Open (the Run screen), Download
  log (all, failed only), Pause, Resume, Cancel (confirmed), Retry failed records, Roll back.
- **Resume and Retry go to the Run screen** (coordinator's call, builder check): only a schedule's
  jobs are driven by the server's pump; a wizard or API job moves only while a page calls
  `jobs/next`. So Resume and Retry make their call and open the job's Run screen
  (`/import?step=run&job=<id>`), which drives it as M7a does. A scheduled job's row only changes
  its status, since the pump drives it, and says so.
- **Rollback jobs are rows too** (coordinator's call, builder check): "Rollback of {import}", with
  their own status. The original shows "rolling back" while its rollback is unfinished and "rolled
  back" only once it is done (read from the rollback job, since the engine marks the original when
  the rollback starts). An unfinished rollback's row offers "Continue the rollback", which reopens
  the rollback dialog on that job and drives it; the Run screen is not taught rollback jobs.
- **Roll back:** a dialog first runs `jobs/rollback` with `dryRun: true` and drives it to the end
  (the same driver as M7a's Run), then says what the rollback will do in plain words, from the
  split counts (server addition 4): entries it will delete (those the job created), entries it
  will restore (those it updated), entries it will bring back from Trash or republish, and any it
  cannot undo (edited since, already gone), with counts. "Roll back" runs it for real and drives it,
  with progress in the dialog; "Keep the import" closes it. A rolled-back job shows "rolled back"
  and has no second rollback. A scheduled job's rollback pauses its schedule (server behaviour,
  M6b); the dialog says so.
- **Dry runs:** one collapsed line under the list, "{n} dry runs", expanded on demand to a short
  list, with "Clear dry runs" (confirmed). Clearing removes dry-run jobs that are not running and
  their staged files (server addition 2), and says how many were cleared. Which dry runs
  (coordinator's call, builder check): the wizard's Preview dry runs and dry rollbacks once they are
  finished or idle; an agent's dry run (`origin: "agent"`) only once it has been idle for 24 hours
  and was never started (`startedAs` absent), so an agent that means to `jobs/start` it is not
  broken.
- Empty state: "No imports yet." with the "New import" button.

### Templates

- Every saved template, by name, with its collection and locale, description, revision and last
  change.
- Actions: Use (opens the wizard with the template loaded: M7a's template picker path, through the
  URL or the wizard's own loader; the plan picks), Export (downloads the template's JSON through
  `templates/export`), Rename and describe (`templates/update` with the revision; a stale revision
  shows the "changed elsewhere" sentence), Delete (confirmed; a template a schedule runs is refused
  by the server, and the dialog names the schedules).
- **Schedules pinned to an edited template or source** (coordinator's call, builder check): a
  template's rename or description raises its revision, and a source's edit changes its pin, so
  every schedule on the old one would pause at its next launch (`template_changed`,
  `source_changed`). Before saving, the dialog names those schedules and offers "Also update these
  schedules", checked by default; when checked, each is updated with `schedules/update` to the new
  revision or source after the save, and any that fails is named. Unchecked, the dialog says they
  will pause. A schedule never stops without a word.
- **Import a template:** a file chooser for a template JSON (`templates/import`), with an optional
  new name and owner; the server's problems are shown in plain words.
- Empty state with a pointer to the wizard ("Save as template" in Options).

### Sources

- Every URL source: name, the URL's host and path (never the query), the credential's name or
  "No credential", and the last fetch (when, and its outcome in words).
- Actions: Add (name, URL, credential), Edit (the same fields; `sources/update`), Fetch now
  (`sources/fetch`, the outcome shown), Delete (confirmed; a source a schedule reads is refused and
  the dialog names the schedules).
- **Credentials**, in the same tab below the sources: names and header names only, never values.
  Add or replace (name, header, value: the value is a password input, sent once, never read back),
  delete (confirmed; the sources that use it are named, as the server allows).
- Empty states for both.

### Schedules

- Each schedule: name, template and source names, when it runs in words ("Every day at 06:00",
  "Every hour", or the cron expression for custom ones), next run, last launch and its outcome in
  words, and its state: running, paused (with the reason in words: failed launches, cancelled,
  rolled back, feed empty, and so on, from the row's `pause.reason`), or disabled.
- Actions: Pause and Resume (`schedules/update` with `enabled`), Run now (`schedules/run`; it is
  queued, and the row says so until the launch shows), Edit, Delete (confirmed), and its run log
  (the row's `runs`, each with its job linked to the Run screen).
- **Create and edit** (a dialog): a name, a saved template (its revision taken from the list), a
  URL source, when it runs, and the job options (publish or draft, batch size; missing entries as
  the template sets them, or off, or a lower threshold, when the template has `rules.missing`).
  When it runs (coordinator's call, approved): Hourly (at minute …), Daily (at a time), Weekly (on
  a day, at a time), or Custom (a cron expression, checked by the server: `INVALID_CRON` shown in
  words). Times are the site's: the plan verifies how EmDash evaluates cron (UTC, M6b Ruling 39)
  and either converts or says "UTC" plainly; it never silently shifts the hour.
- Only a saved template and a URL source can be scheduled; with none of either, the dialog says
  what to create first and links to it.
- **The fence:** while EmDash fences the site (an export, an import, a media-usage activation),
  scheduled runs stand down; a banner over the tab says so, with the fence's kind in words
  (server addition 3).

## Server additions (decided by the user; the only server changes)

1. **Job summaries and a real-imports filter.** `jobs/list` (or a new read-only route, the plan
   decides after checking every caller, including MCP's `list_jobs` if it reads it) can return
   summaries instead of whole rows (the fields the Jobs table shows, no planned terms, no cursor
   internals) and can exclude dry runs, so the Jobs tab reads one light page. The filter must be
   served by storage (an indexed field or an equivalent query), not by reading every row.
2. **Clearing dry runs.** A route that deletes dry-run jobs that are finished or abandoned (not
   leased and not touched for the plan's chosen idle time), with their records, journal rows and
   staged files, reusing retention's per-job purge; bounded per call (a page), answering how many
   it cleared and whether more remain. It never touches a real job and never a dry run that is
   running. It also relieves the M6b busy check (more than 100 unfinished dry runs on a source).
3. **The fence state.** The site fence (`readFence`) exposed read-only to Administrators, in
   `schedules/list`'s answer or a small route (the plan decides), as a kind code the admin turns
   into words.
4. **Split rollback counts.** A rollback job (dry or real) counts what it does by kind, beside
   today's `reverted` total: entries deleted (the import created them), entries restored to their
   earlier revision (it updated them), and entries brought back from Trash or republished (its
   missing phase acted on them), plus today's `conflict` and `failed` for those it cannot undo. The
   counts are kept in the job's counters as the rollback runs, never by reading every record; old
   rollback jobs without them read as unknown and the dialog falls back to the total.

Each addition gets unit and integration tests and runs in the workerd parity suite. No storage
migration beyond what an index needs; no capability change.

## Errors, loading and empty states

- Every failure shows M7a's sentences (`describeError`, `describeJobError`), plus the M7b codes the
  routes answer (`IN_USE` naming the schedules, `INVALID_CRON`, `NAME_TAKEN`, a stale revision).
  No raw server text except the allow-listed details M7a defined; never an upload ID or a
  credential value.
- Loading: a Kumo loader per tab; actions disable their button and announce busy.
- A 403 shows "Only administrators can import." once for the page.
- Every confirm dialog names what will happen and to what, in one sentence.

## Accessibility

- Tabs with a tabpanel; a heading per tab; tables with headers and row actions in menus or buttons
  that have accessible names naming the row ("Roll back Products feed, today 10:14").
- Status badges carry text. Live regions announce action results (cleared 12 dry runs, queued the
  run, rollback finished).
- Every dialog is labelled, traps and returns focus, and closes with Escape unless work is in
  flight.

## Architecture inside the package

- `src/admin/home/`: the page, one folder per tab, their dialogs and messages, reusing M7a's `api`,
  `queries`, `errors`, `run-driver`, `i18n`, `limits` and harness. Shared pieces M7a has (the job
  driver, error banners, "Try again") are reused, not copied.
- New API adapters and query hooks for the new and newly used routes, in `api.ts` and
  `queries.ts`.
- `src/admin/index.tsx` gains the home page; the descriptor and runtime `admin.pages` gain it with
  the `group`; the wizard's page entry gains the group and its new label.
- Server additions in `src/plugin` (routes, service, retention reuse) and their storage index if
  any, with the descriptor's routes list updated.
- Version 0.7.0.

## Testing

- Component tests per tab in happy-dom through M7a's `mockRoutes` (every request checked for the
  CSRF header), including each action's request body, its confirm dialog and its error sentence.
- Flow tests on the assembled home: rollback with its dry-run summary; export then import a
  template; a schedule created, run now, paused and deleted; clearing dry runs.
- Server additions: unit tests, integration tests on `sites/dev`, and parity tests on workerd.
- The manual acceptance run in the Intent, with screenshots, recorded in the review note, on
  `sites/dev` (and the home opened on `sites/dev-cf`).

## Coordinator's calls (for the user to check)

1. The home and the wizard share one sidebar folder "Imports" ("Imports" and "New import").
2. Roll back always runs a dry rollback first and shows its counts before the real one.
3. Dry runs are folded into one line in Jobs, with "Clear dry runs".
4. Schedule timing: Hourly, Daily, Weekly, or a custom cron; never a silent time-zone shift.
5. Credentials are managed in the Sources tab; values are write-only.
6. Templates are edited through the wizard ("Use", then "Save the changes"); the home renames,
   describes, exports, imports and deletes.
7. Resume and Retry on a Jobs row open the Run screen, which drives the job (only scheduled jobs
   are driven by the server).
8. Rollback jobs are their own rows; the original reads "rolled back" only once its rollback is
   done, and an unfinished rollback is continued from the rollback dialog.
9. Editing a template or source that schedules use offers "Also update these schedules", checked,
   so they don't pause at their next launch.
10. "Clear dry runs" clears the wizard's dry runs and dry rollbacks; an agent's dry run only after
    24 hours idle and never started.

## Left to the builder

The exact table layout and responsive behaviour at 768 px; the wording of every sentence (plain,
one per error, as M7a); which row actions sit in a menu; page sizes; the relative-time format.

## Open questions for the plan's Task 0 (verify, don't guess)

- The home's page path and whether EmDash mounts a plugin page at `/`; how `group` renders.
- Whether plugin storage can filter jobs by `dryRun` with an index, and what an index addition
  costs on an existing site (D1 and SQLite).
- Every caller of `jobs/list` (admin, MCP, tests) and whether summaries can replace whole rows
  there or need a new route.
- Retention's per-job purge: reusable for a single dry run without its scan bounds?
- How a job records its origin (wizard, API, agent, schedule) and its template's name.
- How EmDash evaluates plugin cron expressions (time zone) on both hosts.
- `templates/export`'s answer shape (a file or JSON) and `templates/import`'s input.
- `readFence`'s kinds and cost.

## Amendments from the plan and review

Added 2026-11-24 by the review (`../notes/2026-11-24-m7b-review.md`). Each names the plan ruling or
fact it comes from; where an amendment and the text above differ, the amendment wins.

1. **Summaries on a new route** (plan Ruling 1, Fact D1). Server addition 1 is a new read-only
   route, `jobs/summaries { dryRun?: boolean, cursor? }` → `Page<JobListItem>`, eight rows a page,
   newest first. `jobs/list` keeps its whole rows, since tests and callers read them; no MCP tool
   calls either.
2. **The index and its build** (plan Ruling 2, Facts V2, V3). The filter is the plugin storage index
   `["dryRun", "createdAt"]` on `jobs`, queried with the boolean as is (V2 held on SQLite and D1).
   EmDash creates it itself at the first scheduler tick after a deploy (16-44 ms on 5,000 jobs); no
   migration. Until then the query answers through the general index and a sort.
3. **The list item** (plan Ruling 3). `JobListItem` carries what the table and its actions need, no
   template, cursor, lease, planned terms or error message (only `errorCode`), with `rollbackable`
   computed by the server and `rollbackStatus` read per rolled-back import on the page.
4. **Names and origins composed in the admin** (plan Ruling 4, Fact D2). A job records no template
   name and records its origin only as `agent` or `schedule`: a row's name is its template's from
   the template list ("One-off import" without one, "Deleted template" when gone), and wizard and
   API jobs share the origin "Admin or API".
5. **The clear route's rule and bounds** (plan Ruling 6). `jobs/clear-dry-runs { cursor? }` →
   `{ cleared, more, cursor? }` scans 20 dry runs a call, oldest first, within 150 metered storage
   calls. Clearable: no live lease, and either an agent's dry run never started and idle 24 hours,
   or any other dry run (dry rollbacks included) completed, cancelled, failed or idle 1 hour. The
   row, records and journal go at once; the staged file only once the dry run has been idle 1
   hour, so an open Preview's Run still imports it. The admin repeats the call while `more`, at most
   50 times a click. The page reads "Dry runs: {count}" and announces "Dry runs cleared: {count}."
   (pre-flight F18), not "{count} dry runs".
6. **The split counts beside the counters** (plan Ruling 7, Fact D8). The counts live in
   `job.undo { deleted, restored, recovered }` with `job.missingFrom`, beside `counters`, not in
   them: the agents' `processed` and the admin's rate sum every counter. They are kept as the
   rollback runs; a retry pass rebuilds them inside its existing end-of-retry tally, which adds no
   record reads (pre-flight F21). Rollback rows in `jobs/list`, `jobs/get` and `jobs/next` gain the
   two fields, an additive change; `summarize` is unchanged (pre-flight F22).
7. **The fence route** (plan Ruling 8). Server addition 3 is `schedules/fence {}` → `{ fence }`, so
   `schedules/list` keeps its shape. EmDash itself refuses every plugin POST during a site import
   (503 `TRANSFER_IMPORT_IN_PROGRESS`) or when its fence check fails (503
   `TRANSFER_FENCE_CHECK_FAILED`), so the route answers only `clear`, `export` or `media` in
   practice; in those two cases the whole home answers that code's sentence, starting with its
   access check, rather than the Schedules banner (pre-flight F3).
8. **The pages and the wizard's title** (plan Ruling 9, Fact V1). The home is at `/imports`
   ("Imports", `clock-counter-clockwise`), first in `admin.pages`, so the plugin root opens it; the
   wizard keeps `/import` as "New import"; both in the group "Imports". The wizard's heading reads
   "New import". EmDash draws a folder's items without icons. Links into the home use `/imports`,
   since at the bare root the folder starts collapsed. A finished import's Run screen links to the
   home ("See all imports").
9. **"Use" by `?template=`** (plan Ruling 12). "Use" opens `/import?template=<id>`; the wizard reads
   it once at page load, removes it from the URL, preselects the template, and loads it once a file
   is sampled ("Choose the data, then use the template.").
10. **UTC timing** (plan Ruling 13, Fact V4). EmDash runs plugin cron in UTC on both hosts, so
    times are entered and shown in UTC and every time in the Schedules tab says "UTC", the last
    launch and run log included.
11. **The re-pin by `enabled: true`** (plan Ruling 14, Fact D10). `schedules/update` re-pins a
    source only on a new source or `enabled: true`, so "Also update these schedules" after a source
    edit updates the enabled schedules with `enabled: true` (which also re-arms them as the editor
    and resets their launch failures; the dialog says so); disabled ones re-pin when resumed. Resume
    of a schedule paused for `template_changed` also moves it to the template's current revision.
12. **The in-use codes** (plan Ruling 16). The refusals are `TEMPLATE_IN_USE` and `SOURCE_IN_USE`
    (not `IN_USE`), with `details.scheduleIds`, which the dialogs turn into schedule names.
13. **Polling `schedules/list` reconciles** (pre-flight F23). Every poll of `schedules/list` also
    reconciles the cron tasks, as every `schedules/*` call does; accepted, and the separate fence
    route keeps the fence out of it.

## Open issues

From the review (`../notes/2026-11-24-m7b-review.md`, which has the details):

- **A site import, or a failed fence check, takes the whole home to one sentence.** EmDash refuses
  every plugin POST then (503 `TRANSFER_IMPORT_IN_PROGRESS` or `TRANSFER_FENCE_CHECK_FAILED`), so
  the access check fails and the page reads "A site import is running, so imports and their
  schedules wait until it ends." (or the fence-check sentence) with Try again, never the Schedules
  banner, which only an export or a media activation reaches (amendment 7, pre-flight F3).
- **Clearing dry runs empties an open Preview's records table.** The dry run's row, records and
  journal go at once, so a Preview still open elsewhere pages `jobs/records` into `NOT_FOUND`; its
  Run still works, since the staged file stays for an hour (pre-flight F26).
- **A template revision that adds `rules.missing` fails its pinned schedules' update** with
  `MISSING_REQUIRED`; the dialog names them, and each needs an Edit by hand.
- **An Edit of a schedule paused for `template_changed`** checks its missing-entries choice against
  the current template in the browser and against the pinned revision on the server, and re-pins
  only when the template is chosen again; Resume does re-pin.
- **A schedule's run log can lag the Jobs tab**: its entry is written a moment after the job's
  status, and the Schedules tab polls every 60 s when nothing is due.
- **The dry-run line does not poll**; it catches up on the next load or action.
- **At 768 px the Jobs table scrolls sideways** to reach Records and Actions; the Templates row's
  buttons wrap at 1280 px; failures read as a sentence in some tabs and a banner in others. Left for
  a later layout pass.
- **Kumo's `Empty` renders its title as an `<h2>`** under each tab's `<h2>` (as in M7a).
