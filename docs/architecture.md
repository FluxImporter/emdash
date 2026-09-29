# EmDash Import: proposed architecture

Status: proposal, awaiting approval before any plugin code is written. Grounded in
[docs/phase-0-report.md](./phase-0-report.md).

## Decision: a native plugin plus a small trusted-route integration, in one npm package

Sandboxed is ruled out by the numbers alone: 8 MiB request bodies, 8 MiB buffered fetches,
50 ms CPU and 10 subrequests per invocation, no React, no schema writes. Native is required for
the React mapper anyway.

Native `definePlugin()` still cannot do four things the feature set needs: accept large source
files, write content with slug, status, taxonomies, references, bylines, `_rev` and entry locks,
create collections and fields, or upload media with EmDash's hash dedupe. All four are available
to trusted site code through `locals.emdash` (`EmDashHandlers`) and `withEmDashRuntime()`, both
public and typed. So the package has two halves that the site registers with two lines:

```js
// astro.config.mjs
import emdash from "emdash/astro";
import { emdashImport, emdashImportRoutes } from "emdash-import";

export default defineConfig({
	integrations: [
		emdash({ plugins: [emdashImport()] }),
		emdashImportRoutes(),
	],
});
```

| Half | Mechanism | Owns |
| --- | --- | --- |
| Plugin (`definePlugin`) | plugin storage, settings, cron hook, plugin routes, MCP tools, React admin entry | jobs, templates, logs, progress, scheduling, MCP, the wizard UI |
| Trusted routes (`injectRoute`) | Astro API routes under `/_emdash/api/import/…` with `locals.emdash` | streaming source upload to storage, the record writer, schema creation, media download with dedupe |

The job engine is one module used by both halves. Plugin routes and the cron hook call it
through `withEmDashRuntime()` so the writer always has the runtime; the trusted upload route is
the only place that needs the raw `Request`.

Names are placeholders: plugin id `emdash-import`, package `emdash-import`, permission checks on
the existing `import:execute` permission (admin) for runs and `schema:manage` for schema changes.

### Why not alternatives

- **REST from the plugin route with forwarded cookies.** Workers cannot fetch their own route,
  and scheduled runs have no cookie. Rejected.
- **Browser-driven batches only, like core's WXR importer.** Works for interactive runs, fails
  the scheduled-import and MCP requirements. Kept as the interactive driver (the wizard polls and
  advances), not as the only driver.
- **Plugin-only with `ctx.content.update()`.** Loses `_rev`, entry locks, save hooks, slug and
  status. Rejected for writes; `ctx.content` is still used for reads, publish actions and restore.

## Capabilities declared by the plugin

`schema:read`, `content:read`, `content:write`, `content:revisions:read`, `content:publish`,
`content:restore`, `taxonomies:write`, `bylines:read`, `media:read`, `media:write`,
`network:request:unrestricted`. Each is justified in the README (milestone 8). The trusted
routes need no capability; they run with the site's authority and check `locals.user` with
`hasPermission()` from `@emdash-cms/auth` (`packages/auth/src/index.ts:39`). `withEmDashRuntime()`
is documented as "fully trusted: the callback gets the raw runtime with no auth or CSRF checks,
same trust level as plugin cron" (`packages/core/src/astro/middleware.ts`), so every caller of
the engine validates its own input before reaching it.

## Module layout

```
src/
  index.ts                 descriptor factory + createPlugin() (definePlugin)
  astro/integration.ts     emdashImportRoutes(): injectRoute for trusted endpoints
  astro/routes/            upload, write-batch, schema-apply, media-fetch handlers
  engine/
    job.ts                 job state machine, claims, cursor, pause/cancel
    batch.ts               time- and count-bounded batch runner
    mapping.ts             mapping template -> per-record plan (create/update/skip/delete)
    diff.ts                dry-run diff and "edited in admin" detection
    keys.ts                unique-key strategies (source id, slug, field)
  sources/
    csv.ts xml.ts json.ts xlsx.ts   streaming record readers over a byte range
    url.ts                 fetch with headers, SSRF guard, ETag/Last-Modified
    select.ts              XPath / JSONPath / row filters
  transforms/
    jsonata.ts             safe expression evaluation (interpreter, no eval)
    fields/                text, number, boolean, date+tz, select, reference,
                           portable-text (html, markdown), image, file, taxonomy path, byline, locale
  writer/
    content.ts             handleContentCreate/Update with _rev, locks, status, publish/schedule
    schema.ts              additive SchemaRegistry changes
    media.ts               handleMediaUpload({ url }) with dedupe, URL rewriting in Portable Text
    rollback.ts            pre-image snapshots + restore/trash
  admin/
    index.tsx              pages/widgets exports
    wizard/                Source -> Target -> Map -> Options -> Preview -> Run
    api.ts                 apiFetch wrappers for plugin and trusted routes
  mcp.ts                   list_templates, dry_run, start_import, import_status
tests/
  unit/  integration/  fixtures/ (10 rows, 10,000 rows, malformed)
```

## Data model (plugin storage)

| Collection | Key | Indexes | Purpose |
| --- | --- | --- | --- |
| `templates` | ulid | `name`, `collection`, `updatedAt` | saved mapping templates, exportable JSON |
| `jobs` | ulid | `status`, `templateId`, `createdAt`, `scheduleName` | one import run: source ref, options, cursor, counters, `_rev`-guarded state |
| `records` | `${jobId}:${sourceKey}` | `jobId`, `["jobId","status"]`, `["jobId","seq"]` | per-record outcome, error, entry id, pre-image snapshot for rollback |
| `links` | `${collection}:${sourceKey}` | `collection`, `entryId` | source id to entry id map, survives across runs |
| `schedules` | name | `templateId` | URL schedule config, last ETag, last run |

Job state moves with `compareAndSet` so two drivers (browser poll, cron, MCP) cannot run the
same batch twice. A batch is idempotent: it re-reads the cursor, processes records whose
`records` row is absent or `pending`, and writes the cursor last.

## Execution model

1. **Stage the source.** Upload streams into `emdash.storage` at `import/<jobId>/source`; URL
   sources are fetched by the server into the same key (so retries and cron re-runs read the
   same bytes). Pasted snippets go straight to storage too.
2. **Sample.** The first ~20 records feed the preview, the AI mapping suggestion and the schema
   diff.
3. **Batch.** Each call to `POST /_emdash/api/import/jobs/:id/next` claims the job, reads from the
   saved byte offset (CSV/JSON Lines/XML stream) or row index (XLSX, JSON array), processes up to
   `batchSize` records within a wall-clock budget (default 4 s, both configurable), then persists
   cursor and counters. Drivers: the wizard while open, the cron hook when scheduled, and an
   external scheduler through the same route with a PAT.
4. **Write.** Per record, in order: resolve key; load current entry with `_rev`; compute the plan;
   dry-run stops here. Otherwise media first (download, dedupe, rewrite URLs in Portable Text),
   then taxonomy terms (paths split on `>`, created top-down), then `handleContentCreate` or
   `handleContentUpdate` with `_rev` and `actor`, honoring entry locks (a locked entry is logged
   and skipped, never overridden), then publish, schedule or leave as draft through the
   revision-fenced `ctx.content` actions.
5. **Finish.** Delete-missing pass (trash, unpublish or permanent delete per option), summary,
   CSV log export from `records`.

XLSX cannot be streamed by row from a zipped workbook without materialising the sheet XML; it is
read with a streaming zip reader per sheet and bounded by a configurable size limit that is
documented as smaller than the CSV limit.

## Schema changes

Additive only. The mapper computes a diff against `ctx.schema`; the user confirms; the trusted
`schema-apply` route creates missing collections and fields through `SchemaRegistry` and refuses
any type change. Then the wizard reloads the schema before mapping.

## Safety rails

- No `eval`; JSONata for expressions, with a step limit and a timeout per evaluation.
- SSRF guard on every user-supplied URL (block private ranges, resolve-and-check, limited
  redirects), matching the intent of core's `import/ssrf.ts`.
- Trusted routes require `import:execute`, and the host's CSRF middleware covers them because they
  sit under `/_emdash/api`. Both are verified by tests in milestone 2.
- Media respects `maxUploadSize` and the allowlist; failures are logged per record.
- Rollback restores from the pre-image snapshot for updates and trashes created entries, using
  `restore()` and `delete()`; it is itself a job and therefore resumable.

## Milestone mapping

Unchanged from the brief. Milestone 2 (MVP) will prove the two-half design end to end: CSV
upload through the trusted route, a plugin job, batch writes with `_rev`, the kill-and-resume test
with no duplicates, and `pnpm typecheck && pnpm lint && pnpm test` plus a `pnpm dev` run against a
local site.

## Open points for your decision

1. Package and plugin names (`emdash-import` is a placeholder).
2. Byline creation for authors that do not exist yet: create them interactively in the Preview
   step through the bylines REST API (recommended for v1), or add a trusted route that writes
   bylines server-side so scheduled runs can create them too.
3. Whether the external "run next batch" trigger should be a PAT-authenticated trusted route
   only, or also accept a per-job secret URL.
