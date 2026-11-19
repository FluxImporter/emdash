# Flux Import: roadmap and Milestone 2 design

Status: approved 2026-10-07; revised 2026-10-08 with the M2 verification findings
([m2-verification](../notes/2026-10-07-m2-verification.md)). Supersedes the milestone order in [brief.md](../../brief.md) and the open
points in [architecture.md](../../architecture.md). Grounded in
[phase-0-report.md](../../phase-0-report.md) and the EmDash docs as of 2026-10-07.

## Goal

A native EmDash plugin that imports structured data (CSV, XML, JSON, XLSX; upload, URL or pasted)
into EmDash collections with a field mapper, resumable batched jobs, dry-run diffs, media, scheduling,
MCP tools and rollback. The full feature set in `brief.md` stays the target; this document changes
the order of delivery and settles the decisions the brief and Phase 0 left open.

## Decisions

| Topic | Decision |
| --- | --- |
| Names | Plugin ID `flux-import`. Exports `fluxImport()` (plugin descriptor) and `fluxImportRoutes()` (Astro integration). npm package name is chosen in Milestone 8. |
| Architecture | Native plugin plus a trusted-route Astro integration in one package, as in `architecture.md`. Only the source upload is a trusted route; everything else is a plugin route and reaches the runtime handlers through `withEmDashRuntime()`. |
| Sequencing | Backend and API first. The plugin routes are the primary interface for the whole project; MCP tools wrap them in M6; the React wizard is built last (M7) on the stable API. |
| Edit locks | The trusted write path (`handleContentUpdate`) is not covered by EmDash's lock enforcement, which lives in the REST route. There is no public lock API, so the writer reads the internal `_emdash_entry_locks` table through `runtime.db` (joined to `_emdash_collections.edit_locking`, expiry compared to the database clock, dialect-specific), treats a lease held by the importing user as unlocked, and skips and logs locked entries. The race between check and write is documented, not closed; an integration test pins the internal table. |
| Plugin events | No custom event bus is documented. The importer emits none; its writes fire the core `content:*` hooks, and job state is available through routes and MCP. |
| Bylines | Byline creation is not public REST (MCP tools only). v1 maps to existing bylines by name or slug and reports missing ones per record. |
| AI mapping | The admin stores a provider API key in encrypted plugin settings. The feature is hidden when no key is set. |
| External trigger | "Run next batch" from an external scheduler is the `jobs/next` plugin route with a PAT. No per-job secret URLs. |
| Duplicate safety | A text field `flux_source_id` (`type: "string"`, `indexed: true`, `translatable: false`) is added to each target collection (additive) and set on every created entry, so recovery after a crash can find an entry created before its record was saved. Fields cannot be hidden in EmDash 1.2.0, so it is visible and read-only by convention until an M7 field widget hides it. |
| Publishing | Per-job option `publish` (boolean, default `true`), added in M2. On revisioned collections `handleContentUpdate` only stages a draft, so with `publish: true` the writer publishes each entry it created or updated with the `_rev` its write returned. It never publishes an entry this job did not write (an editor's pending draft stays a draft). M5 extends the option with scheduling. |
| Staged sources | `emdash.storage` keys are publicly downloadable at `/_emdash/api/media/file/<key>`. Uploads use unguessable keys (ULID plus random suffix), keys never appear in public responses, and staged files are deleted when a job reaches a terminal state and by retention cleanup. |
| Permissions | All routes require `import:execute` (Admin, level 50, defined in `@emdash-cms/auth`). PAT callers need the `admin` scope. |
| XLSX | Last source in M3, with its own lower size limit, because a zipped workbook cannot be streamed by row cheaply. |

## Roadmap

Every milestone ends with a review stop and must pass `pnpm typecheck && pnpm lint && pnpm test`
plus a run against the local EmDash site (`sites/dev`), reported with results.

| # | Milestone | Scope | Done when |
| --- | --- | --- | --- |
| 1 | Phase 0 | Report and architecture | Done (commit `95ec14f`) |
| 2 | Engine MVP | Workspace and dev site, CSV upload, template v1 (text, number, date, slug), create/update by source key, publish option, job engine, lock skip, record log and CSV export, dry-run diff, `jobs/retry`, a `sites/dev-cf` Cloudflare site for parity | 10,000 rows import; kill-and-resume gives no duplicates, and any entry a crash leaves unpublished is reported as `publish_unverified`; locked entries skipped; dry-run writes nothing; Node and `workerd` pass |
| 3 | Sources (split into M3a–M3d, see [M3a spec](./2026-10-12-flux-import-m3a-formats-design.md)) | JSON, XML, URL (auth headers, SSRF guard, ETag/Last-Modified), pasted snippets, record selection (XPath, JSONPath, row filters), JSONata transforms, then XLSX | Valid, large and malformed fixtures per format |
| 4 | Field types and schema (split into M4a–M4e, see [Milestone 4 split](#milestone-4-split)) | Boolean, select, date with timezone, taxonomy paths, media from URL (hash dedupe, `maxUploadSize`, URL rewriting in Portable Text), HTML and Markdown to Portable Text with unknown markup reported, references, bylines (existing only), locales and translation links, additive `schema/apply` route | Each field type has unit and integration tests |
| 5 | Record rules and safety (split into M5a–M5c, see [Milestone 5 split](#milestone-5-split)) | Create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin" via revisions; delete, trash or unpublish missing entries; publish, draft or schedule; rollback as a resumable job | A finished run rolls back to its pre-run state |
| 6 | Automation (split into M6a–M6d, see [Milestone 6 split](#milestone-6-split)) | Template CRUD and JSON export/import, cron-scheduled URL imports, MCP tools `list_templates`, `dry_run`, `start_import`, `import_status`, AI mapping suggestion route | A scheduled import runs unattended; an agent completes an import over MCP |
| 7 | React admin wizard | Source, Target, Map, Options, Preview, Run on the M2 to M6 API; drag-and-drop mapping; schema diff confirmation; AI suggestions; live progress, pause, cancel, log download | Manual end-to-end run in `pnpm dev` |
| 8 | Ship | README with a justification per capability, `skills/` entry for agents, packaging, npm publish | A fresh site installs from npm and imports a file |

Non-goals for v1 are unchanged from the brief: no e-commerce, no user or password import, no
WordPress migration (link to EmDash's built-in importer instead).

## Milestone 2 design

### Workspace

- `packages/flux-import`: the npm package. Directory layout follows `architecture.md`, limited to
  what M2 uses: `src/index.ts`, `src/astro/`, `src/engine/`, `src/sources/csv.ts`, `src/writer/`.
- `sites/dev`: a local EmDash site on Node and SQLite that installs the package from the
  workspace. Integration tests and milestone review runs use it. A second configuration runs the
  same site under `workerd` for the parity check.

### API

The upload is the only trusted route, because plugin routes buffer bodies and cap them at 8 MiB.

| Route | Kind | Input | Output |
| --- | --- | --- | --- |
| `POST /_emdash/api/flux-import/uploads?filename=` | trusted (`injectRoute`) | raw request body, streamed | `{ uploadId, bytes, sha256 }` |
| `sources/sample` | plugin | `{ uploadId, n }`, `n` at most 20 | `{ headers, rows }` |
| `jobs/create` | plugin | `{ uploadId, template, dryRun, publish?, batchSize?, budgetMs? }` | job |
| `jobs/next` | plugin | `{ id }` | job status and counters after one batch |
| `jobs/get` | plugin | `{ id }` | job |
| `jobs/list` | plugin | `{ status?, cursor? }` | page of jobs |
| `jobs/pause`, `jobs/resume`, `jobs/cancel` | plugin | `{ id }` | job |
| `jobs/retry` | plugin | `{ id }` | job, re-queued to re-process `failed`, `conflict` and `locked` records and repair unfinished writes |
| `jobs/records` | plugin | `{ id, status?, cursor? }` | page of record outcomes |
| `jobs/log.csv` | plugin, raw response | `{ id }` | CSV file |

All routes require `import:execute`. Plugin route inputs are validated with Zod. EmDash's middleware
authenticates the upload route and applies CSRF; the route also checks
`hasPermission(locals.user, "import:execute")` from `@emdash-cms/auth` and enforces the
`maxSourceBytes` setting while reading. On Node the local storage adapter buffers the whole upload
in memory, so the default limit stays modest; R2 and S3 stream. Plugin routes live under
`/_emdash/api/plugins/flux-import/`.

### Template v1

```json
{
	"version": 1,
	"collection": "products",
	"locale": "en",
	"key": { "from": "sku" },
	"slug": { "from": "handle" },
	"fields": {
		"title": { "from": "Name", "type": "text" },
		"price": { "from": "Price", "type": "number" },
		"released": { "from": "Date", "type": "date", "format": "dd/MM/yyyy", "tz": "Europe/Chisinau" }
	}
}
```

The format only grows additively: M3 adds `expr` (JSONata) and selection, M4 adds field types,
M5 adds record rules. `version` stays 1 until a change cannot be additive.

### Plugin storage

| Collection | Key | Indexes | Purpose |
| --- | --- | --- | --- |
| `jobs` | ULID | `status`, `createdAt` | template, upload ref, options, state, lease, cursor, counters |
| `records` | `${jobId}:${seq}` | `jobId`, `["jobId","status"]`, `["jobId","seq"]`, `["jobId","status","seq"]` | per-record outcome, reason code, message, entry ID, diff (dry-run) |
| `links` | `${collection}:${locale}:${sourceKey}` | `entryId` | source key to entry ID, kept across runs |

### Job lifecycle

States: `created`, `running`, `paused`, `completed`, `cancelled`, `failed`. `running` and `paused`
move both ways; the last three are terminal except that `failed` can be resumed after the cause is
fixed.

`jobs/next`:

1. Claim a lease (`holder`, `expiresAt`) on the job with compare-and-set. If another holder has a
   live lease, return the current status without work. An expired lease can be taken over.
2. Read records from the saved cursor (byte offset plus sequence number) and process up to
   `batchSize` (default 50, maximum 500), checking `budgetMs` (default 4,000) between records.
3. Save cursor and counters, release the lease. Mark `completed` at end of input.

### Writing a record

1. Parse and apply the template. Value errors make the record `failed`.
2. Resolve the entry: `links` by source key; if the record was left in `writing` by a crash, look
   the entry up by `flux_source_id` and repair the link.
3. Dry-run: compute the create, update or skip diff, save it on the record, stop.
4. For an update, read the entry with `_rev` and its lock state. A locked entry makes the record
   `locked` with reason `locked`.
5. Mark the record `writing`, then call `handleContentCreate` (with `flux_source_id` set) or
   `handleContentUpdate` with `_rev` and `actor`. A stale `_rev` makes the record `conflict`.
6. With `publish: true`, call `handleContentPublish` with the `_rev` the write returned. A publish
   that fails leaves the record `conflict` or `locked` with an error code `publish_conflict` or
   `publish_locked`; a retry publishes the pending draft. A crash between write and publish is
   repaired on resume when the write's revision was recorded (the record's `writtenRev` still
   matches the entry); otherwise the entry stays a draft and the record is `conflict` with
   `publish_unverified`. An entry with an unpublished draft that this importer did not write is
   never updated or published (`conflict`, `pending_draft`).
7. Save the link and mark the record `created`, `updated` or `unchanged`.

Before the first write of a non-dry-run job, the engine adds `flux_source_id` to the target
collection if it is missing, through `SchemaRegistry` (additive only).

### Errors

- Record-level problems (parse, type, validation, conflict, lock) never fail the job; they are
  logged with a reason code and message.
- The job becomes `failed` only when it cannot continue: missing upload, CSV unreadable past the
  cursor, collection or locale gone. It can be resumed after the cause is fixed.
- Conflicts are not retried inside a batch; `jobs/retry` re-processes `failed`, `conflict` and
  `locked` records and repairs unfinished writes.
- `withEmDashRuntime()` is fully trusted, so the engine only receives input that a route has
  already validated.
- A daily plugin cron task deletes `records` and staged uploads older than the retention setting
  (default 30 days).

### Verified facts (M2 verification report)

Answered on 2026-10-08 against `emdash@1.2.0`; details and evidence in
`docs/superpowers/notes/2026-10-07-m2-verification.md`.

1. Lock state: no public API; read `_emdash_entry_locks` through `runtime.db` (see Decisions).
2. Byte ranges: `storage.download(key, { range: { offset } })` works on all adapters. An offset at
   or past the end returns the whole file without `range`, so the source port checks
   `offset >= size` first and treats it as end of input.
3. A route injected under `/_emdash/api/flux-import/...` gets EmDash's auth and CSRF middleware.
4. Plugin route names with slashes (`jobs/create`) work, and plugin routes reach the runtime through
   `withEmDashRuntime()`.
5. `SchemaRegistry` (exported from `emdash`) creates the field; fields cannot be hidden.
6. Content writes: `handleContentCreate`, `handleContentUpdate`, `handleContentGet`,
   `handleContentList` (`fieldFilters` on indexed fields only), `handleContentPublish`; a stale
   `_rev` returns `{ success: false, error: { code: "CONFLICT" } }`.
7. The workspace resolves two copies of `emdash@1.2.0` (`@astrojs/react` 6 and 7); M2b aligns them.

### Testing

- Unit (vitest): CSV reader resuming at a byte offset, quoted fields and newlines, template
  application, date parsing with format and timezone.
- Integration against `sites/dev`: fixtures with 10 rows, 10,000 rows and malformed input; a
  locked entry is skipped; a dry-run writes nothing; kill-and-resume aborts after a content write
  and before the record is saved, resumes, and asserts 10,000 entries with unique
  `flux_source_id`.
- Harness: `@emdash-cms/plugin-test` supports sandboxed plugins only, so integration tests start
  `sites/dev` on a temporary SQLite file, call `POST /_emdash/api/setup/dev-bypass?token=1&content=0`
  (dev only) for an Admin PAT, and drive the routes over HTTP. A foreign lock needs a second user,
  created through the admin API.
- `workerd`: a `sites/dev-cf` site (`@astrojs/cloudflare`, `@emdash-cms/cloudflare`, D1, R2) runs
  the upload and batch flow on the same fixtures and proves `withEmDashRuntime()`, ranged reads on
  R2 and the lock query on D1.

## Milestone 4 split

Added 2026-10-27. Milestone 4 is delivered in five parts, each with its own spec, plan and review,
in dependency order. Each part ends with unit and integration tests for its field types.

| Part | Scope | Status |
| --- | --- | --- |
| **M4a** ([spec](./2026-10-27-flux-import-m4a-scalar-fields-design.md)) | Scalar field types with no external objects: boolean, select and multiSelect, date with site or IANA timezone (and calendar dates into text fields), number and integer with locale separators, json, custom slug fields; field-rule checks before write; type-aware diff; additive `schema/apply` route | Done ([review](../notes/2026-10-27-m4a-review.md)) |
| **M4b** ([spec](./2026-10-27-flux-import-m4b-taxonomies-references-design.md)) | Taxonomy paths, references and bylines: term lookup by slug or `parent/child` path with optional creation, assigned through the content write's `taxonomies`; reference fields by entry ID, slug or source key (`references` for relation-bound fields); existing bylines only, by slug or exact name, through `bylines` | Done ([review](../notes/2026-10-27-m4b-review.md)) |
| **M4c** ([spec](./2026-10-27-flux-import-m4c-media-design.md)) | Media from URL into image and file fields: fetch through the M3c fetcher and SSRF guard, `maxUploadSize`, content-hash dedupe via `handleMediaUpload`, alt text, site-wide URL-to-media map | Done ([review](../notes/2026-10-27-m4c-review.md)) |
| **M4d** ([spec](./2026-11-02-flux-import-m4d-portable-text-design.md)) | HTML and Markdown to Portable Text, with unknown markup reported per record, and image URLs in Portable Text rewritten to media from M4c | Done ([review](../notes/2026-11-02-m4d-review.md)) |
| **M4e** ([spec](./2026-11-03-flux-import-m4e-locales-design.md)) | Locales and translation links: one template per locale, `translationOf` resolved from another locale's source key, non-translatable fields left to EmDash's sync | Done ([review](../notes/2026-11-03-m4e-review.md)) |

## Milestone 5 split

Added 2026-11-03. Milestone 5 is delivered in three parts, each with its own spec, plan and review.
Rollback comes first, so that the journal it reads is fixed before the later parts add the writes
it must undo: every write M5b and M5c add is journalled in the M5a format, and each of them extends
the rollback for its own writes. Each part ships with its own unit, Node integration and workerd
tests, and M5a alone meets the milestone's acceptance for the writes M2-M4e make.

| Part | Scope | Status |
| --- | --- | --- |
| **M5a** ([spec](./2026-11-03-flux-import-m5a-journal-rollback-design.md)) | Run journal and rollback: a write-ahead pre-image of every entry a job creates or changes (data, slug, links, status, schedule, pending draft), a record of the media it creates, the job that last wrote each link; `jobs/rollback` as a resumable, dry-runnable job that deletes created entries and restores changed ones, refusing entries changed since; `lastImport` cleared on cancel and rollback | Done ([review](../notes/2026-11-03-m5a-review.md)) |
| **M5b** ([spec](./2026-11-04-flux-import-m5b-record-rules-design.md)) | Record rules: create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin" through per-field fingerprints on the link row; publish, draft or schedule, with a per-record schedule; all journalled | Done ([review](../notes/2026-11-04-m5b-review.md)) |
| **M5c** ([spec](./2026-11-12-flux-import-m5c-missing-entries-design.md)) | Missing entries: trash or unpublish entries this import created that a completed run did not see, behind a safety threshold; journalled, and rolled back by restoring from Trash or republishing | Done ([review](../notes/2026-11-12-m5c-review.md)) |

## Milestone 6 split

Added 2026-11-16, revised the same day after the M6a spec review. Milestone 6 is delivered in four
parts, each with its own spec, plan and review, in the order M6a, M6c, M6b, M6d. Each part depends
only on the ones before it: the MCP tools wrap the template and job routes (M6c on M6a), a schedule
runs a saved template (M6b on M6a) and adds its own tools to M6c's list, and mapping suggestions
produce a template that M6a saves (M6d on M6a). M6c comes before M6b because M6b carries the most
risk (the `scheduled()` handler on a production build, blocked since M2, and the D1 budget of a
shared cron tick) and the tools do not need it; the cost is a second administrator consent when
M6b's tools change the list (M6a spec, Ruling 35). The feasibility of each part was checked against
`emdash@1.2.0` and the docs on 2026-11-16 (M6a spec, "EmDash facts" and "Outline of M6c, M6b and
M6d"). M6c meets the agent half of the milestone's acceptance ("an agent completes an import over
MCP"), M6b the other ("a scheduled import runs unattended"). The M6c spec corrects one fact of the
M6a outline: plugin MCP tools are refused during a site *import*, not an export; during an export
every successful plugin tool call, reads included, restarts it (M6c spec, F9 and Ruling 24). The M6b
spec settles M6b's two risks: a real `scheduled()` event runs on the `sites/dev-cf` dev server
(`/cdn-cgi/handler/scheduled`), while the production build still fails as in M2, so the acceptance
on Cloudflare is proven on the dev server; and every due task of a Cron Trigger tick shares one D1
budget with EmDash's own scheduled work, so a pump does all heavy work, one batch or one launch
per tick on both runtimes (M6b spec, F10, F16, F17, Rulings 18, 26, 35). After its review the M6b
spec moves `list_sources`, `list_schedules` and the `sources/overview` route to M6d, which adds
tools anyway, so M6b changes no tool and sites re-consent once, with M6d (M6b spec, Ruling 50).

| Part | Scope | Status |
| --- | --- | --- |
| **M6a** ([spec](./2026-11-16-flux-import-m6a-templates-design.md)) | Saved templates: a `templates` plugin storage collection with CRUD routes, optimistic concurrency by revision, every site-independent check refused on save and site checks reported; owner checks against saved templates and existing links, refused on import for templates with `rules.missing`; JSON export and import in a versioned file envelope; `jobs/create`, `jobs/list` and `schema/apply` by `templateId`, with the job keeping a snapshot; the URL-source "unchanged" skip made template-aware. Feasible with the documented plugin storage API | Done ([review](../notes/2026-11-16-m6a-review.md)) |
| **M6c** ([spec](./2026-11-16-flux-import-m6c-mcp-tools-design.md)) | MCP tools: `list_templates`, `get_template`, `dry_run`, `start_import`, `next_batch`, `import_status` as plugin MCP tools (`flux-import__<name>`), each over one private JSON route with the same input schema: the M6a `templates/list` and `templates/get`, and new `jobs/plan`, `jobs/start`, `jobs/step` and `jobs/status`, which return compact job summaries instead of whole job rows. Saved templates only; data comes as text in the dry run (at most 1 MiB) or from an existing URL source, and no upload ID crosses the tool boundary; `start_import` runs exactly a completed agent dry run, once; `next_batch` advances only agent jobs; agent jobs always journal and never remove missing entries, all enforced server-side. Feasible: EmDash 1.2.0 serves the tools once an administrator enables them (any tool change disables them again), to tokens with `mcp:tools` or `mcp:tools:flux-import`; every plugin tool is refused during a site import, and every successful call restarts a running site export | Done ([review](../notes/2026-11-16-m6c-review.md)) |
| **M6b** ([spec](./2026-11-17-flux-import-m6b-scheduled-imports-design.md)) | Scheduled URL imports: a `schedules` plugin storage collection (at most 20) naming a saved template at a pinned revision, a URL source pinned by a fingerprint of its URL and credential name, a UTC cron expression (5 fields or an alias, checked field by field by flux-import, because EmDash's parser takes typos as one-shots) and the job options; REST routes `schedules/create`, `list`, `update`, `delete` and `run` (which queues a launch). Each schedule's EmDash cron task only marks it due; a `pump` task, present only while there is work, does all heavy work one unit per tick on both runtimes: bounded finalization, then one batch of one open scheduled job, else one launch (a fetch, then a journalled job through the `jobs/create { sourceId, templateId }` path, the template-aware unchanged skip included). A launch is busy while any unfinished import or rollback of any origin reads the source; every cron write is conditional on the launch claim, because ticks overlap, a launch whose claim was lost cancels its job, and a route's pause always wins. On Workers a batch runs at about half the request caps (6 plain or 3 linked records), because every due task of a tick shares one 1,000-query D1 budget with EmDash; the worst tick measured 691 queries on local D1. Scheduled writes carry no user, whoever drives the batch, and EmDash's revisions of them have no author; each schedule keeps a run log of its last 20 runs, and `users:read` is added for one check: the Admin who armed the schedule must still exist and hold `import:execute` (a disabled user cannot be detected). Removals run only when the schedule opts in, never above the template's threshold; a cancel or rollback of a scheduled job, a refused verdict, an empty feed, a failed job, a changed or deleted template or source, a configuration error or three fetch failures pause the schedule; the scheduler stands down during a site import, export or media-usage activation. No MCP tool is added (the read tools move to M6d), and `start_import` jobs are not handed to the scheduler. Retention becomes hourly and bounded (150 storage calls a run, resumed from a cursor). The Cloudflare acceptance is proven on the dev server's real `scheduled()` event with EmDash's timer stopped: the production build still fails as in M2, and the D1 limit per tick is checked at the first deploy | Done ([review](../notes/2026-11-17-m6b-review.md)) |
| **M6d** ([spec](./2026-11-19-flux-import-m6d-ai-mapping-design.md)) | AI mapping suggestions: a `templates/suggest` route (REST, Admin) that proposes a template's field mappings from a source sample (text, an upload or a URL source) and the collection schema, as a draft that passes the shape check and is never saved. A deterministic name-matching suggester (normalised names, a synonym table, a type check of the sample values) is always the answer without a provider or when one fails. Optional providers, set in the plugin's settings with an encrypted key: Anthropic through the official SDK (`claude-opus-5-5`, effort `low`, structured output, the server-side refusal fallback) or an OpenAI-compatible endpoint, both called through `ctx.http` under the new `network:request:unrestricted` capability, since an Admin-set base URL cannot be listed in `allowedHosts`; at most 5 records with values cut to 200 characters leave the site, 30 provider calls an hour. Also the read tools M6b deferred: `list_sources` (hosts only) over `sources/overview` and `list_schedules` (codes only, no user IDs, no `sourcePin`) over `schedules/overview`, so the tool list changes once (M6b spec, Rulings 21, 47, 50); no `suggest_mapping` tool. Version 0.5.0 | In progress |
