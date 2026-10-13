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
| 4 | Field types and schema | Boolean, select, date with timezone, taxonomy paths, media from URL (hash dedupe, `maxUploadSize`, URL rewriting in Portable Text), HTML and Markdown to Portable Text with unknown markup reported, references, bylines (existing only), locales and translation links, additive `schema/apply` route | Each field type has unit and integration tests |
| 5 | Record rules and safety | Create-only, update-only or both; "update only these fields"; "never overwrite fields edited in the admin" via revisions; delete, trash or unpublish missing entries; publish, draft or schedule; rollback as a resumable job | A finished run rolls back to its pre-run state |
| 6 | Automation | Template CRUD and JSON export/import, cron-scheduled URL imports, MCP tools `list_templates`, `dry_run`, `start_import`, `import_status`, AI mapping suggestion route | A scheduled import runs unattended; an agent completes an import over MCP |
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
