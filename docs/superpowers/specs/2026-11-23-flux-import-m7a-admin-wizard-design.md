# flux-import M7a: the import wizard in the EmDash admin

Date: 2026-11-23. Roadmap row: Milestone 7 (`2026-10-07-flux-import-roadmap-design.md`), split
into M7a (this spec: the wizard and its run screen) and M7b (the Imports home: jobs, templates,
sources, schedules). Mockups agreed in the design conversation are kept in
`.superpowers/brainstorm/` (local): `map-v2.html` (the Map step) and `flow-and-home.html` (the
other steps and M7b's home).

## Intent

flux-import is EmDash's equivalent of WP All Import. Milestones 2 to 6 built the whole engine and
its API: sources, templates, record rules, rollback, schedules, MCP tools and mapping suggestions.
Today only a developer or an AI agent can use it, through HTTP routes or MCP. M7a gives a site
Administrator a screen in the EmDash admin that takes a file, a URL or a pasted snippet to a
finished import without touching the API: pick the source, pick the collection, map the fields
(drag and drop, pre-filled by name matching or AI), set the options, see a dry run, run it and
watch it.

Success: an Administrator who has never seen the API imports the 10-row products fixture and a
JSON feed into `sites/dev` from the admin alone, maps a date and a taxonomy, creates one missing
field through the schema diff, sees the dry run, runs it, pauses and resumes it, and downloads the
log. That manual end-to-end run, recorded in the review note, is the roadmap's acceptance.

## Goals

- A six-step wizard: Source, Target, Map, Options, Preview, Run.
- The Map step as agreed (layout A plus a detail panel): drag source keys onto fields, or pick a
  key without dragging; suggestions pre-filled automatically; additive field creation behind a
  confirmed schema diff.
- Every route call goes through routes that already exist. M7a adds no engine behaviour.
- Looks and behaves like the rest of the EmDash admin: Kumo components, the admin's theme, its
  navigation and sign-in, translatable text.
- Works with a keyboard and a screen reader.

## Non-goals (M7a)

- The Imports home (job history, rollback, templates library, sources and credentials, schedules):
  M7b. M7a's Run screen links to rollback and scheduling only by saying they are in M7b's home
  (or, if M7b is not merged yet, nothing).
- New engine features, new import formats, new field types.
- A WordPress importer (EmDash's own WXR importer covers it; the Source step links to it).
- Real AI provider calls in tests (the standing rule; the fake from M6d is used).

## Anti-goals (would make M7a a failure even if it works)

- Anything that changes the schema or writes content without an explicit confirmation: schema
  changes only through the confirmed diff; content only after Preview and an explicit Run.
- A mapper that only works with a mouse.
- Shipping a second copy of React, Kumo, Lingui or React Query into the admin bundle.
- Showing provider text, keys, credentials or upload IDs anywhere they are not already shown by
  the API.
- Losing a running job because the page was closed: a job always stays resumable.

## Constraints

- **EmDash 1.2.0 native React admin** (docs: "React admin extensions", "Distributing native
  plugins"):
  - The descriptor's `adminEntry` and the runtime's `admin.entry` name the same module,
    `flux-import/admin`, exported by the package as `./admin` → `./src/admin/index.tsx` (source,
    compiled by the host).
  - `admin.pages` declares `/import` (label "Import", Phosphor icon to be chosen, e.g.
    `upload-simple`), mounted at `/_emdash/admin/plugins/flux-import/import`. M7b adds `/` (the
    home); until then the plugin root opens `/import` (the docs: the root opens the first page).
  - The admin module exports `pages: PluginAdminExports["pages"]` keyed by the declared paths.
  - Plugin route calls use `apiFetch` and `parseApiResponse` from `emdash/plugin-utils`;
    `apiFetch` adds `X-EmDash-Request: 1`.
  - Host-owned libraries are peer dependencies: `react`, `@cloudflare/kumo` at exactly the
    admin's version (**2.6.0** for `@emdash-cms/admin` 1.2.0, as installed; the docs' example
    shows 2.19.0 for a later release), `@lingui/core`, `@lingui/react`, `@tanstack/react-query`,
    `@emdash-cms/admin`, `emdash`.
  - Text goes through the shared Lingui instance with message IDs; English is the fallback; no
    catalog ships in M7a beyond English.
- **Permissions**: every route the wizard calls needs `import:execute` (Admin); the admin page is
  shown to whoever EmDash shows plugin pages to, and the routes refuse everyone else. The wizard
  shows a clear "Administrators only" state on a 403.
- **Project rules** (CLAUDE.md): TypeScript strict, ESM, `import type`, `.js` imports, Biome.
- **Dependencies**: pnpm's `minimumReleaseAge: 20160` applies. New: `@dnd-kit/core`,
  `@dnd-kit/sortable` if needed, `@dnd-kit/utilities` (the versions `@emdash-cms/admin` 1.2.0
  resolves, so the site installs one copy), and dev-only Testing Library and a DOM environment for
  component tests. Nothing else.
- **No engine change.** If a step needs data no route returns, the builder stops and reports it;
  a small read-only route may be added only with a coordinator ruling.

## Approaches considered

1. **React pages inside the plugin (chosen).** EmDash's documented path for native plugins; host
   React, Kumo, Lingui and React Query; `@dnd-kit` for accessible drag and drop; one wizard state
   holding the draft template, which every relevant route already accepts inline. Chosen by the
   user's go-ahead after the trade-offs below.
2. **Block Kit pages.** Server-rendered JSON blocks, no React. Rejected: no drag and drop, no
   custom live views, no three-pane mapper.
3. **A standalone page outside the admin** (a trusted Astro route with its own app). Rejected: it
   loses the admin's chrome, sign-in and look and duplicates what EmDash provides.

Drag and drop: `@dnd-kit` (keyboard and pointer sensors, live announcements) over native HTML5
drag and drop, which has no keyboard or touch support.

## Decided by the user

- Scope B, split: M7a is the wizard and run screen; M7b is the Imports home with four tabs (Jobs,
  Templates, Sources, Schedules) and a "New import" button.
- Map layout A: source keys with sample values on the left, collection fields on the right, drag a
  key onto a field; used keys dimmed; each mapping shows who suggested it (AI or name matching)
  and how sure; uncertain ones marked "check".
- The proposals in `map-v2.html` and `flow-and-home.html`, approved with "go": the detail panel,
  mapping without dragging, field creation behind a confirmed list, automatic suggestions with
  "Ask again", and the Source, Target, Options, Preview and Run screens as sketched.

## The wizard

One page, `/import`, with a step bar (1 Source … 6 Run). Back and Next move between steps; a step
can be revisited, and changing an earlier step invalidates what depends on it (a new source clears
the sample and the suggestion; a new collection clears the mapping; any change after Preview
discards the dry run). The wizard state lives in memory for the page's life, held by one reducer;
the current step is mirrored in the URL's query (`?step=map`) so a reload shows the right step
heading, but a reload loses the unsaved draft, and the page warns before unloading while a draft
has unsaved work (the job itself survives on the server).

### 1. Source

- Tabs: **Upload file**, **From URL**, **Paste**, **Saved source**.
  - Upload: the trusted route `POST /_emdash/api/flux-import/uploads?filename=<name>` with the
    file as the body (`.csv`, `.json`, `.jsonl`, `.ndjson`, `.xml`, `.xlsx`), with upload progress.
    It returns an upload ID.
  - From URL: `sources/create` (URL, optional credential name from `credentials/list`; adding a
    credential is M7b, so M7a lists existing ones only), then `sources/fetch`.
  - Paste: `sources/paste` (format chosen, text up to the route's limit); XLSX is refused by the
    route and not offered.
  - Saved source: `sources/list`, pick one.
- Format detection: from the file extension or the URL source's reported format, overridable by a
  format select. The template's `source` block has only `format`, `records`, `sheet`, `headerRow`
  and `filter` (`template.ts:319-327`), so there are no CSV delimiter or encoding options; XLSX
  gets sheet and header row.
- Records path, in the engine's syntax (not JSONPath or XPath; `src/sources/paths.ts:17-48`):
  dot-separated keys for JSON, slash-separated element names from the root for XML (for example
  `feed/item`); and an optional row filter. Both are written into the template's `source` block.
- The upload route answers 201 with `{ uploadId, bytes }` and needs `Content-Length` on Workers
  (`upload-route.ts:50-69`); upload progress uses `XMLHttpRequest` (or `fetch` without progress)
  with the same CSRF header `apiFetch` sends.
- A sample (`sources/sample`, 5 records by default) shows the detected keys and a few values;
  errors from the route show inline with their code's message.
- **Start from a saved template**: `templates/list`, pick one; the wizard loads it
  (`templates/get`), fills Target, Map and Options from it, and opens Preview. The template's
  revision is kept so `jobs/create` can pass `templateRevision`.
- A link to EmDash's own WordPress importer, for WXR files.

### 2. Target

- Collection: a select over the site's collections. Locale: a select over the site's locales,
  defaulting to the default locale. Optional "Translation of": the M4e translation-linking options
  the template supports.
- The schema is read live. The builder uses the existing read the engine uses (the plugin has
  `schema:read`) if a route exposes it; otherwise EmDash's own admin API that the admin itself uses
  (the manifest or the schema API, verified in the docs). No new route without a ruling.

### 3. Map (agreed layout A plus the detail panel)

- **Left: source keys** from the sample, each with one sample value; keys already used are dimmed
  but still draggable (one key may feed several fields only where the template allows it; the
  suggestion never maps one key to two fields, but the user may).
- **Middle: the collection's fields**, plus the template's **Key** (the unique import key) and
  **Slug** rows at the top, and rows for the template's non-field mappings the engine supports:
  taxonomies (one row per taxonomy assigned to the collection, from EmDash's
  `GET /_emdash/api/taxonomies`), bylines, `publishAt` and `translationOf`. `templates/suggest`
  never fills these (M6d non-goals), so they start empty. Each row: field label (required ones marked), type, the mapped key as a
  chip with a remove button, and a badge: "AI · high/medium/low", "Name · high/…", or "check"
  when the suggestion was uncertain or a format must be confirmed. Unmappable field types (the
  suggester's "fields not offered") are shown disabled with the reason.
- **Right: the detail panel** for the selected field: the source-key picker (the keyboard path,
  same effect as a drop), type-specific settings exactly as the template grammar allows (date
  format and timezone; number decimal and thousands; boolean values; select value mapping;
  taxonomy path delimiter; Portable Text source format; image and file options; reference lookup;
  byline matching), the sample values before and after conversion, and the suggestion's
  rationale. A mapping takes either a source key (`from`) or an expression (`expr`, JSONata), never
  both (`template.ts:101-104`): the panel offers "Source key" or "Expression" as a switch, and an
  expression replaces the key.
- **Before/after samples** come from a dry run of a small sample. The builder uses an existing
  route that converts sample values (for example `jobs/plan` over the pasted or sampled records,
  or a dry run on a few records); if none fits without writes, the panel shows the raw samples
  only and the Preview step is where conversions show. No new route without a ruling.
- **Suggestions**: on entering Map with no mapping yet, the wizard calls `templates/suggest` with
  the collection, locale and the sample (`uploadId`, `sourceId` or `text`), and no `ai` flag: the
  route then uses the configured provider if there is one and returns no warning when the setting
  is "none" (`src/plugin/suggest.ts:372-381`). `ai.available` in the reply drives the status line. The response's draft fills
  the mapping; each field's `origin`, `confidence` and `rationale` drive the badges and panel;
  `warnings` show as a dismissible summary in plain words (one sentence per code; codes from the
  M6d warning table); `method` and `sent` show in the status line ("AI (Anthropic) · 4 filled, 1
  to check", or "Name matching"). "Ask again" re-runs it; it never overwrites a mapping the user
  set by hand without asking.
- **New fields**: dropping a key on "+ add a new field" (or choosing it in the picker) proposes a
  field: slug and label from the key, a type inferred from the sample (the user can change it among
  the types `schema/apply` accepts), translatable/searchable defaults as `schema/apply` has them.
  Proposed fields are listed in a "New fields" section of the Map step. Before leaving Map, if any
  are proposed, a confirmation dialog shows the schema diff (`schema/apply` with `dryRun: true`)
  and applies it on confirm (`dryRun: false`), then reloads the schema. Existing field types are
  never changed; the route refuses that anyway.
- **Validation** before Next: the template passes the engine's shape check (the wizard calls
  `templates/create` only when saving; for validation it relies on `jobs/create`'s and
  `schema/apply`'s refusals and, if the builder finds one, an exported client-safe shape check;
  otherwise required fields unmapped and the Key unmapped are checked in the UI).

### 4. Options

The record rules and run options the engine supports, each with one plain-language line of help:

- Records: create and update / create only / update only; "update only these fields" (a
  multi-select of mapped fields); "never overwrite fields edited in the admin".
- Status: publish / draft / schedule. The template has only a per-record `publishAt` mapping,
  applied with `publish: true` (`template.ts:262-270`, `:387-388`). **Coordinator's call:**
  "Schedule" offers two forms: "the same date for every record" (a date picker, written as a
  constant JSONata `expr` in `publishAt`) and "a date from the feed" (a source key, with the date
  settings of the Map panel).
- Missing from the feed: leave / unpublish / trash, with the stop threshold (percent). There is no
  delete action in the engine (`template.ts:300-306`), so none is offered.
- **Owner** (coordinator's call). `rules.missing` needs `rules.owner` (`template.ts:293-310`), and
  only entries stamped with an owner when created can later count as missing. So every import the
  wizard runs sets an owner, always, not only when a missing action is chosen. It is derived, not
  typed: the saved template's name as a slug (for example `products-feed`), or, for a one-off run,
  `wizard-<collection>-<locale>`; shown under "Advanced", editable, and checked against the other
  saved templates for the same collection and locale (a clash is shown as a warning: two imports
  with one owner behave as one, and each one's missing phase can touch the other's entries). A
  missing action is offered only with "Save as template", because a one-off first run has nothing
  to find missing.
- Journal for rollback: on by default and not offered as a switch in M7a (rollback is M7b's, but
  the journal must exist when M7b ships).
- Batch size: hidden behind "Advanced", default the engine's.
- **Save as template**: off by default; a name; on Run the wizard saves it with
  `templates/create` and runs the job from the saved template (`templateId`, `templateRevision`).
  A template is required to schedule the import later (M7b). The name is checked against
  `templates/list` when it is typed, so a clash shows here, not after Preview.
- **Started from a saved template and then edited** (coordinator's call): Options shows three
  choices, default the first: "Run with these changes without saving them" (the job runs the
  draft inline, so it has no `templateId`), "Save the changes to <template>" (`templates/update`
  at its revision; any schedule warnings the route returns are shown before Run), and "Save as a
  new template". Unedited, the job runs from the saved template by ID and revision.

### 5. Preview (dry run)

- `jobs/create` with `dryRun: true` and the draft template (or the saved template), then the
  wizard drives the dry run with `jobs/next` until it finishes, showing progress.
- Counts per action (create, update, unchanged, failed, missing → the chosen action) and a
  paginated table from `jobs/records` with each record's key, action, what would change, and its
  errors in plain words. A filter by action.
- "Back to Map" keeps the mapping; "Run import" creates the real job.

### 6. Run

- `jobs/create` with `dryRun: false`, then the page drives `jobs/next` in a loop while it is open
  (the architecture's "the wizard drives while open"). Counters and records per second always.
- **What is imported** (coordinator's call): exactly what Preview showed. A completed dry run
  keeps its staged file (`service.ts:420-427`), so Run passes the dry run's `uploadId`, for a URL
  source too, instead of `sourceId` (which would fetch the URL again and could import different
  data, or answer `skipped: "unchanged"`). The cost: a URL-source job run from the wizard records
  no `lastImport`, so the first scheduled run of that source (M7b) re-reads content it could have
  skipped; its records come out `unchanged`, which is correct, only slower.
- **Progress** (coordinator's call): a job stores no total (`types.ts:199-200`). Within the
  session the dry run's record count is the total, so the bar and the time-left estimate are
  determinate. A job reopened from `/import?job=<id>` with no known total shows an indeterminate
  bar with the counters; no route is added for it.
- **Pause** (`jobs/pause`), **Resume** (`jobs/resume`), **Cancel** (`jobs/cancel`, with a
  confirmation), **Download log** (`GET jobs/log.csv?id=…`, optionally only failed records).
- Leaving the page pauses nothing on the server: the job stays open and resumable; the page says
  so. Coming back to `/import?job=<id>` reopens the Run screen for that job and resumes driving it
  (M7b lists jobs; M7a supports the URL).
- On completion: a summary with counts, a link to the log, and links to the new entries'
  collection. Failed records can be retried (`jobs/retry`).
- Errors: a failed `jobs/next` call is retried with backoff a few times, then the screen shows the
  error and a "Try again" button; the job is never left half-driven without a message.

### The `flux_source_id` field

The roadmap's duplicate-safety decision says the `flux_source_id` field "is visible and read-only
by convention until an M7 field widget hides it". M7a adds a field widget (the admin module's
`fields` export) that renders the value read-only and collapsed, if EmDash 1.2.0 lets a plugin
assign a widget to a field it creates (`schema/apply` creates `flux_source_id`). The builder
verifies this in the docs and the installed source; if a plugin cannot assign it, this item moves
to the open issues.

## Errors, loading and empty states

- Every route error is shown with its code mapped to a sentence (a table in the admin module, one
  entry per code the wizard can meet; unknown codes show the route's message).
- Loading: Kumo's loader per panel, never a blank page.
- Empty states: no collections; a source with no records; a sample with no keys; no saved
  templates or sources.
- 403: "Only administrators can import." 

## Accessibility

- Every drag has a keyboard path (the picker in the detail panel, and @dnd-kit's keyboard sensor
  with screen-reader announcements).
- The step bar is a list of links with `aria-current="step"`.
- Badges carry text, not colour alone. Focus moves to the step heading on step change.
- Contrast and text size meet WCAG AA in the admin's light and dark themes.

## Architecture inside the package

- `packages/flux-import/src/admin/index.tsx`: the `pages` (and `fields`, if the widget lands)
  exports.
- `src/admin/api.ts`: one typed function per route the wizard calls, over `apiFetch` and
  `parseApiResponse`; types imported from the plugin's route input and output types where they are
  exported (`import type` only, so no server code enters the browser bundle).
- `src/admin/wizard/`: the reducer and its state type, one component per step, the Map step's
  three panes, the schema-diff dialog, the run driver (a hook that loops `jobs/next`).
- `src/admin/messages.ts`: message IDs and English defaults; the error-code table.
- React Query for reads (collections, sources, templates, samples); the reducer for the draft.
- The admin module imports nothing from `src/engine`, `src/plugin` or `src/sources` at runtime
  (types only), so no Node or server code is bundled for the browser. A test pins this.

## Testing

- Unit: the reducer (every transition and invalidation), the API adapters (request shapes against
  the route input schemas), the error-code table (every code the wizard can meet), the run driver
  (backoff, pause, cancel, completion).
- Component: each step with Testing Library on a DOM environment, the routes mocked at `apiFetch`;
  the Map step's keyboard path (pick a key without dragging) and a @dnd-kit drag.
- A bundle check: the admin entry's import graph holds no `src/engine`, `src/plugin` or
  `src/sources` runtime import and no second React/Kumo/Lingui/React Query.
- The existing unit, Node integration and workerd suites keep passing; M7a changes no route.
- Acceptance: the manual end-to-end run in `pnpm dev` on `sites/dev` (and the Map step and Run
  screen opened on `sites/dev-cf`), recorded in the review note with screenshots, covering the
  success criteria above. AI suggestions are shown with the local fake provider from M6d's tests
  (never a real provider): `FakeAiServer` in `tests/integration/fake-ai.ts`, started separately
  for `pnpm dev` and reached through `aiBaseUrl` with `allowPrivateNetwork`, as
  `tests/integration/suggest.test.ts:15-40` does. A dry run creates no `flux_source_id` field (the
  first real batch does, `batch.ts:2078-2080`), so Preview changes no schema.
- A design critique and polish pass with the impeccable skill on the built screens, its findings
  fixed or recorded.

## Coordinator's calls (for the user to check)

Settled after the builder check, each marked where it applies above:

1. Every wizard import sets a derived owner; a missing action needs "Save as template".
2. Run imports exactly the previewed file (the dry run's upload), even for a URL source.
3. Editing a started-from template defaults to running the changes without saving them, with
   "save to the template" and "save as new" as choices.
4. "Schedule" offers one date for all records or a date from the feed.
5. The progress bar is indeterminate only for a job reopened by URL.

## Left to the builder

- Exact Kumo components per control, spacing and icons, within the admin's conventions.
- The Phosphor icon for the page.
- How the reducer is split into files.
- Whether `@dnd-kit/sortable` is needed (probably not: keys are dragged onto targets, not sorted).
- Which DOM environment (happy-dom or jsdom) the component tests use.

## Open questions for the plan's Task 0 (verify, don't guess)

1. Where the wizard reads collections, fields and locales from (a plugin route or EmDash's
   manifest/schema API), and in what shape.
2. Whether `@dnd-kit` versions resolve to the admin's copy in the site's install.
3. Whether a plugin can attach a field widget to `flux_source_id`.
4. Whether any existing route can show before/after conversion of sample values without writing.
5. How the admin module's Lingui messages are extracted (by hand in M7a, or a Lingui build).
6. That `apiFetch` handles the trusted upload route (`/_emdash/api/flux-import/uploads`) and a
   raw `GET` for the log CSV.

## Amendments from the plan and review

Recorded by the review (`../notes/2026-11-23-m7a-review.md`); each names the plan ruling or fact
behind it. They override the text above where they differ.

1. **The `flux_source_id` widget lands, with one server change** (plan Ruling 1, Fact V3;
   amends "The `flux_source_id` field" and "No engine change"). The coordinator answered yes:
   `ensureSourceIdField` creates the field with `widget: "flux-import:source-id"` and sets that
   widget on an existing `flux_source_id` that has none, in the same idempotent pass; it never
   overwrites another widget. The admin module exports `fields: { "source-id": SourceIdField }`,
   which renders the value read-only and collapsed. Fields on existing sites get the widget on
   their next real import. No other server change was made.
2. **Messages live beside their components, and `useT()` interpolates the English itself**
   (plan Ruling 2, Fact V5; amends "Architecture inside the package"'s single `messages.ts`). Each
   folder has a `messages.ts` of `{ id, message }` descriptors; the error and warning tables live
   in `src/admin/errors.ts`. `translate` asks Lingui only for an ID its catalog holds and
   substitutes `{name}` placeholders in the English otherwise, so no uncompiled message reaches
   Lingui in a production build and placeholders always work. A test keeps IDs unique and
   placeholders simple across every `messages.ts`.
3. **Route errors are read from the envelope** (plan Ruling 3, Fact D1). `parseApiResponse`
   drops the error code, so `readError` builds `ApiError(code, message, status, details?)` from
   `{ success: false, error }`; a body that is not JSON is `HTTP_<status>`, and a rejected
   `fetch` stays a `TypeError`. Successful replies are still unwrapped by `parseApiResponse`.
4. **The log is downloaded through `apiFetch`** (plan Ruling 4, Fact D2): a private route's GET
   needs `X-EmDash-Request: 1` under session auth, so a plain link answers 403. The reply becomes
   a `Blob` and an object URL, named from `content-disposition`, else `flux-import-<id>.csv`.
5. **The schema is read from EmDash's manifest and schema API** (plan Ruling 5, Fact V1):
   collections, locales and taxonomies from `GET /_emdash/api/manifest`, a collection's fields
   from `GET /_emdash/api/schema/collections/<slug>?includeFields=true`. Hidden collections are
   listed as "(hidden)"; `flux_source_id` is never a target.
6. **The Map panel shows raw sample values; Preview shows conversions** (plan Ruling 6,
   Fact V4; the spec's own fallback). No route converts samples without writing; the panel says
   "Converted values show in Preview".
7. **Every source becomes an upload ID in the Source step** (plan Ruling 7): upload, paste
   (`sources/paste`), URL (`sources/create`, then `sources/fetch`) and saved source
   (`sources/fetch { id }`). `sources/sample`, `templates/suggest` and both `jobs/create` calls
   take that `uploadId`; a source ID is kept for display only.
8. **Server constants and `resolvePath` are mirrored in the browser** (plan Ruling 8):
   `src/admin/limits.ts` and `src/admin/wizard/sample.ts` hold copies, and node tests pin each to
   the server's, since the admin may not import server code at runtime.
9. **Only Kumo and the admin's prebuilt utility classes** (plan Ruling 9, Fact D3). The host
   does not scan plugin sources, so a test reads every `className` literal and requires each class
   in `@emdash-cms/admin/dist/styles.css`. The review found one consequence: Kumo classes the
   admin never compiled (`has-[[data-disabled]]:opacity-50` on a disabled radio group) have no
   effect, so a control must use a Kumo style the admin's CSS has (open issues).
10. **Component tests mock the global `fetch` beneath the real `apiFetch`** (plan Ruling 11;
    refines "Testing"'s "mocked at `apiFetch`"), so every test also checks the CSRF header.
11. **Template-save timing** (plan Ruling 13). "Save the changes to <template>" runs
    `templates/update` on Options' Next, so its schedule warnings show at the top of Preview;
    Preview and Run then use the new revision. "Save as template" and "Save as a new template" run
    `templates/create` on Run, and only while Options offers them (`saveOffered`). An unedited
    saved template runs by ID and revision; "Run with these changes without saving them" runs the
    draft inline.
12. **Run-driver policy** (plan Ruling 14): retries after 1, 3 and 9 s for a `TypeError`, a 429
    or a 5xx, then the error with "Try again"; any other 4xx at once; 2 s between calls while
    another holder's lease is live (any non-null `lease` in a reply), 0.5 s after a reply with no
    progress and no lease; the driver stops on `completed`, `cancelled`, `failed` or `paused`.
13. **The owner is derived** (plan Ruling 15, coordinator's call 1): the saved template's name,
    lower-cased, runs outside `[a-z0-9]` to `-`, trimmed of `-`, cut to 100 characters; else
    `wizard-<collection>-<locale>`. The clash check lists every page of `templates/list` for the
    collection and warns when another template has the same owner and locale.
14. **"The same date for every record"** (plan Ruling 16, coordinator's call 4) is
    `publishAt: { expr: JSON.stringify("<yyyy-MM-ddTHH:mm>"), tz: "site" }` with `publish: true`.
15. **Access is probed once on mount with `credentials/list`** (plan Ruling 17): a 403 there
    renders only "Only administrators can import."; any other failure its sentence and "Try
    again". Once granted, a later failed probe never drops the draft.
16. **The sites declare `@cloudflare/kumo` 2.6.0 and `zod` 4.5.4** (Task 1 review). A direct
    Kumo or admin dependency in flux-import otherwise lets pnpm split `emdash` by its optional
    peers into variants with different Kumo copies. `sites/dev` and `sites/dev-cf` declare both to
    steer pnpm to one `emdash`/admin/Kumo variant. Bump them together with the Kumo version
    EmDash's admin uses, never one alone; the admin-package tests catch a split.
17. **A finished run offers "Start a new import"** (Task 16 acceptance run; amends "6. Run"). A
    completed or cancelled job's Run screen remounts the wizard with an empty draft and drops
    `?job=` from the URL. Without it a finished run was a dead end: the host's sidebar link
    changes the URL without remounting the page, and a reload reopens the job.

## Open issues

From the review (`../notes/2026-11-23-m7a-review.md`, which has the details):

- **The host does not remount the page on its own navigation.** The sidebar's Import link, or
  any navigation to `/import` with another query, changes the URL but not the wizard, which reads
  the URL once at mount. "Start a new import" covers the finished-run case; a reload covers the
  rest.
- **Kumo classes missing from the admin's prebuilt CSS have no effect.** Plan Ruling 9's test
  checks the plugin's own classes, not those Kumo's components apply. Kumo's group-level disabled
  style was the one found; others may exist. Each control's look should be checked in the browser.
- **The admin has two sidebar entries named "Import"**: EmDash's WordPress importer (Admin) and
  this page (Plugins). The label is the spec's; a clearer one (for example "Import data") would
  need the descriptor and runtime `admin.pages` changed together.
- **Kumo's `Empty` always renders an `<h2>`**, so the empty states under the Source step's `<h3>`
  sections break the heading order. Kumo 2.6.0 has no prop for the level.
- **A new field's settings need a return to Map.** The schema diff applies on Map's Next and the
  wizard moves to Options, so a new `datetime` field's date format is set by going back to Map.
- **Taxonomy terms match by slug by default.** A feed value such as `EUR` with "Create missing
  terms" on fails every record ("not a slug") until "Match terms by" is set to Label. Preview
  shows the failure in plain words; the default is the template grammar's.
- **Every Preview leaves a dry-run job and its staged file** until retention removes them; the
  wizard cancels and deletes none. A Preview left before its dry run finishes leaves the job
  unfinished, and more than 100 unfinished dry runs on one URL source make it busy for schedules
  (M6b Ruling 54). M7b's job list should show and clear them.
- **"Waiting for the previous batch to finish" stays through the reopened page's own first
  batch**: the driver learns that it holds the lease only from that batch's reply.
- **The production build is unverified** (carried from M2): the acceptance ran on `astro dev`, so
  Fact V5's production Lingui path and the admin bundle's single copies are proven by tests and
  the dev server's module URLs only.
- **Small gaps left by the whole-branch review:** a "name taken" flag set in Options can outlive
  its cause after the Map edits are undone (Options re-checks it when opened); Preview's Run
  import follows `canRun`, not `reachable(run)` (they agree on every path today); a `?job=` the
  server refuses as invalid reads "try again" beside "Start a new import"; a 4xx from Run's own
  `templates/create` or `jobs/create` offers only Try again (the step bar still links Options).
- **Carried to M7b** from M6: `jobs/list` returns whole job rows (M6a); a fenced site stops
  schedules silently, and the admin should show the fence (M6b final review); abandoned agent dry
  runs make a source busy (M6c, M6b Ruling 54).
