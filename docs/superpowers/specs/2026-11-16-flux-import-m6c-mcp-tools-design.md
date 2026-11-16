# Flux Import M6c: MCP tools

Status: drafted 2026-11-16 (the user approved all remaining milestones up front on 2026-10-27;
design decisions are the implementer's rulings). Second of four parts of Milestone 6 (Automation)
of [the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-6-split), in the order M6a,
M6c, M6b, M6d (M6a spec, Ruling 35). Builds on M6a
([spec](./2026-11-16-flux-import-m6a-templates-design.md),
[review](../notes/2026-11-16-m6a-review.md)), merged at `912da1c`. It meets the agent half of the
milestone's acceptance: **an agent completes an import over MCP**. It corrects one M6a fact about
the site export fence (Ruling 24).

## Goal

flux-import's routes are its primary interface (roadmap, "Sequencing"), and since M6a every route
an agent needs is a private JSON POST route with a permission (M6a Ruling 17). M6c exposes a small
set of them as plugin MCP tools on the site's MCP server (`/_emdash/api/mcp`), so that an agent
with a scoped token can do, from tool descriptions alone, what an administrator does through the
API:

1. **Find a template.** List the saved templates and read the one that fits the data.
2. **Plan.** Run a dry run of that template over data the agent holds as text (CSV, JSON,
   JSON Lines or XML, at most 1 MiB) or over a URL source an administrator set up, and read the
   plan: counts per outcome, and sample rows with their changes and errors.
3. **Run.** After the user has seen the plan and agreed, run exactly that plan for real: the same
   staged data, the same template revision and the same options.
4. **Drive and watch.** Advance either job one batch per call until it is done, then read the
   result.

The tools are thin. Each one is a private plugin route with the same input schema object, so a
tool can never accept what its route refuses. The responses are compact summaries, never whole job
rows.

## Non-goals

These are left out, for the reasons given under "Out of scope" and in the Rulings:
- inline templates and template create, update, delete, export or import tools;
- `schema/apply`;
- URL source and credential tools, and listing sources;
- a source upload (binary or base64) over MCP;
- rollback, pause, resume, cancel and retry tools;
- listing jobs;
- output schemas;
- a multi-batch driver route;
- an `mcp` actor source on content writes;
- schedules and their tools (M6b);
- mapping suggestions (M6d);
- the admin screens (M7);
- the agent skill and README (M8).

## Decisions

| Topic | Decision |
| --- | --- |
| Tools | Six: `list_templates`, `get_template`, `dry_run`, `start_import`, `next_batch`, `import_status` (Ruling 1). EmDash names them `flux-import__<name>` (F2, Ruling 19). |
| Routes | One route per tool, and the tool's `input` is the route's own `input` schema object (Ruling 2). `list_templates` and `get_template` use the M6a routes unchanged. The other four use new routes `jobs/plan`, `jobs/start`, `jobs/step` and `jobs/status`, because `jobs/create`, `jobs/next` and `jobs/get` return whole job rows (P2, P3, Ruling 3). |
| Responses | A `JobSummary` (at most a few KB) for every job tool. `import_status` adds, on request, a page of at most 10 record summaries with bounded previews. There are no output schemas (F7, Ruling 18). |
| Templates | Saved templates only: `dry_run` takes a `templateId` (Ruling 4). |
| Data | `dry_run` takes either `text` (staged as `sources/paste` stages it, at most 1 MiB) or the `sourceId` of an existing URL source. No upload ID ever appears in a tool's input or output (P5, Ruling 5). No binary data goes over MCP (F10, Ruling 6). |
| Real runs | `start_import` takes the ID of a **completed dry run** and nothing that changes the outcome. It imports the dry run's staged file with the same template at the same revision, and the same `publish` and missing-entry setting. Only `batchSize` and `budgetMs` may change (Ruling 7). |
| Safety limits | Agent jobs always keep a journal (Ruling 10). Removal of missing entries is opt-in per dry run and never above the template's threshold (Ruling 11). Saved templates only (Ruling 4). |
| Annotations | `start_import` and `next_batch` are `destructive: true`, the other four `false`. EmDash gives plugin tools no `readOnlyHint` (F2, Ruling 17). |
| Consent | An administrator enables the tools once ("Agent access" on the Plugins page). Any change to the tool list, a description or a schema disables them until enabled again (F3). A committed snapshot test makes every such change deliberate (Ruling 20). |
| Access | The route permission stays `import:execute` (Admin). Token calls need `mcp:tools` or `mcp:tools:flux-import`; `admin` does not grant them (F4). The recommended token carries `mcp:tools:flux-import` alone (Ruling 26). |
| Storage | No new collection, index or capability, and no version bump. `Job` gains the optional `dryRunOf` (Ruling 27). |

## EmDash facts this design relies on

Checked on 2026-11-16 against:
- `emdash@1.2.0` (package `src/`, cited as file:line);
- `@modelcontextprotocol/sdk@1.32.1`, the copy EmDash resolves (`dist/esm/server/`, cited as `sdk` file:line);
- `@emdash-cms/auth@1.2.0`, `@emdash-cms/plugin-types@0.6.0` and `@emdash-cms/admin@1.2.0`;
- the docs, through the `emdash-docs` MCP server and the pages it returns.

M6a's facts (F1-F12, F-M1-F-M3) still hold except F-M4, which F9 corrects. All facts below are
**confirmed** from source or docs unless marked otherwise. The ones still unconfirmed are listed
under "To verify in Task 0".

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | **Tool definitions.** `definePlugin({ mcp: { tools } })` takes `Record<string, { description, route, input, output?, destructive? }>`. A local name must match `^[a-zA-Z0-9_-]+$`. `definePlugin` throws for a tool whose route is unknown, public, `response: "raw"`, not a POST-compatible JSON route, or without `permission`. "POST-compatible JSON" means `response !== "raw"`, `methods` absent or including `POST`, and `request` absent or `body: "json"`, so a route with a declared JSON body cap (M6a Ruling 51) qualifies | `src/plugins/types.ts:1949-1959`; `src/plugins/define-plugin.ts:31`, `:160-176`; `@emdash-cms/plugin-types` `dist/index.js:94-96`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#exposing-a-route-as-an-mcp-tool) |
| F2 | **Registration and names.** The runtime collects each configured plugin's tools, skipping a tool whose route fails F1's checks or whose permission is unknown, and keying it `${plugin.id}__${name}`; `destructive` defaults to `false`. The MCP server registers each as `${tool.pluginId}__${tool.name}` with `annotations: { destructiveHint: tool.destructive }` and nothing else: a plugin tool can never carry `readOnlyHint`. The admin's Plugins page shows the same `${plugin.id}__${tool.name}` with a "Destructive" badge. The docs speak of an "MCP-safe plugin prefix" (different only for scoped IDs) and tell clients to read `tools/list` for the generated name | `src/emdash-runtime.ts:5724-5762` (`:5750-5751`, `:5759`); `src/mcp/server.ts:908-917`; `@emdash-cms/admin` `dist/index.js:52905-52914`; [MCP server](https://docs.emdashcms.com/reference/mcp-server/#plugin-tools) |
| F3 | **Consent.** Enabled tools are listed only when the plugin's state has `mcpToolsEnabled`, status `active`, the plugin is enabled, and the stored `mcpToolsConsent` equals a fresh serialization. That serialization is every tool's name, description, route, permission, destructive flag and the draft-7 JSON Schema of `input` (and `output`), sorted by name. The plugin version is not part of it. An administrator with `plugins:manage` stores the snapshot with `PUT /_emdash/api/admin/plugins/<id>/mcp { enabled: true }`, which the Plugins page's "Agent access" switch calls. The plugin list reports `mcpToolsEnabled` from the state alone, without comparing the snapshot, so **after a tool change the switch still shows "on" while the tools are gone** | `src/emdash-runtime.ts:5802-5842`; `src/astro/routes/api/admin/plugins/[id]/mcp.ts:13-41`; `src/api/handlers/plugins.ts:98`; `@emdash-cms/admin` `dist/index.js:52878-52904`; `@emdash-cms/auth` `src/rbac.ts:84` |
| F4 | **Authentication and scopes.** The MCP endpoint accepts bearer tokens (PAT or OAuth) only: any other request gets the OAuth discovery 401, so there is no cookie and no CSRF path. The middleware's per-path scope rules skip the endpoint, so each tool checks its own. A plugin tool requires `mcp:tools` or `mcp:tools:<pluginId>`, and `hasScope` answers that check without consulting `admin` (the `admin` scope does **not** grant plugin tools). Then the route's permission is checked against the user's role. A failure is `INSUFFICIENT_SCOPE` or `INSUFFICIENT_PERMISSIONS`, and is audited as `denied`. `mcp:tools:<id>` is a valid PAT scope (`^mcp:tools:[a-z][a-z0-9_-]*$`); the OAuth metadata's `scopes_supported` lists the fixed scopes only (with `mcp:tools`, without per-plugin ones) | `src/astro/middleware/auth.ts:286-292`, `:841-844`; `src/mcp/server.ts:918-953`; `@emdash-cms/auth` `src/tokens.ts:46-70`, `:106-117`; `src/astro/routes/api/well-known/oauth-authorization-server.ts:31`; [MCP server, Scopes](https://docs.emdashcms.com/reference/mcp-server/) |
| F5 | **Dispatch.** A call becomes an internal `POST` to the route with `JSON.stringify(input)` as its body, through `handlePluginApiRoute`. So the route's `request` declaration (its `maxBytes`) and its `input` validation apply as for an HTTP call, but the plugin catch-all route's own token-scope check (`admin`) does not. The MCP caller is passed as `routeCtx.user`. Every call writes an audit row (`plugin_tool_invoke`, resource `flux-import__<name>`, `success` or `failure`) | `src/emdash-runtime.ts:5844-5882`, `:5597-5668` (`:5625`, `:5628`); `src/plugins/routes.ts:132-143`, `:240-262` |
| F6 | **Input.** The SDK validates `arguments` with the tool's schema and passes the **parsed** value to the callback, which EmDash forwards. A z.object strips unknown keys unless it is strict. A failure is answered as a tool error whose text is `Input validation error: …`, **without** `_meta.code`. The route then validates the same value again and answers its own failure as `VALIDATION_ERROR` with `z.formatError` details. The SDK applies no element limit to tool input by default | `sdk` `server/mcp.js:206-225`, `:161-170`, `:174-196`, `:41-48`; `src/plugins/routes.ts:244-258` |
| F7 | **Output.** Without `output`, a route's result is returned as one text block of `JSON.stringify(data, null, 2)`. With `output`, the result must be an object and is sent both as that text and as `structuredContent`. The SDK checks `structuredContent` against the schema **after** the handler has run, and a mismatch becomes an error result. So a write that succeeded is then reported as failed | `src/mcp/server.ts:388-393`, `:965-978`; `sdk` `server/mcp.js:165-170`, `:229-251` |
| F8 | **Errors.** A route failure (a `PluginRouteError` from the handler, an input failure, an `INVALID_PLUGIN_REQUEST` body error) arrives as `isError: true` with text `[CODE] message` and `_meta: { code, details? }`. A thrown error is caught by the wrapper as `INTERNAL_ERROR` with its message. The docs describe the same envelope | `src/mcp/server.ts:401-416`, `:501-519`, `:899-903`; `src/plugins/routes.ts:280-300`; `src/emdash-runtime.ts:5626-5638`; [MCP server, Errors](https://docs.emdashcms.com/reference/mcp-server/#errors) |
| F9 | **The site write fence (corrects M6a F-M4 and Ruling 46).** Every MCP tool not annotated `readOnlyHint: true` (so every plugin tool, F2) reads the fence before it runs. The fence refuses the call during a **site import** (`TRANSFER_IMPORT_IN_PROGRESS`), from its first execution step until it completes or a failed or cancelled one is abandoned. It also refuses during media-usage activation (`MEDIA_USAGE_ACTIVATION_IN_PROGRESS`), and when the fence cannot be read (`TRANSFER_FENCE_CHECK_FAILED`). A running **export** does not refuse the call. Instead, every successful fenced call bumps the export's `write_epoch`, and the export restarts when it finds its fence changed. After three attempts it fails with `TRANSFER_EXPORT_CONCURRENT_WRITES`. So during an export, **even `list_templates` and `import_status` restart it** | `src/mcp/server.ts:862-906`; `src/transfer/fence.ts:65-133`, `:149-163`; `src/transfer/export/exporter.ts:738-742`, `:826-830`; [site transfer](https://docs.emdashcms.com/guides/site-transfer/) "Export a site", "Writes are blocked during an import"; [MCP server, Import](https://docs.emdashcms.com/reference/mcp-server/) |
| F10 | **Size limits.** The SDK transport refuses a request body over 4 MiB (`DEFAULT_MAX_REQUEST_BODY_SIZE`; EmDash passes no option) with HTTP 413, and a JSON-RPC batch of more than 100 messages. Below that, the route's own body cap applies to the re-serialized input (F5). Neither EmDash nor the SDK caps a tool's response; none was found in either. Tool arguments are JSON, so binary data can travel only as encoded text, and no flux-import route accepts encoded binary | `sdk` `server/requestBody.js:1-57`, `server/webStandardStreamableHttp.js:83`, `:489-506`; `src/astro/routes/api/mcp.ts:33-59`; `packages/flux-import/src/plugin/routes.ts:429-441` |
| F11 | **Two Zod copies.** EmDash types a tool's `input` with `astro/zod`, but serializes the consent snapshot with its own `zod`, and the SDK converts schemas for `tools/list` with its own `zod`. In this workspace, `astro/zod` is `zod/v4` from `zod@4.6.5`, while EmDash and the SDK resolve `zod@4.5.4`. So EmDash's normal case is converting a schema built by another Zod copy. **To verify (V2):** that every flux-import tool schema converts the same way through both | `src/plugins/types.ts:47`; `src/emdash-runtime.ts:23`, `:5836-5838`; `sdk` `server/mcp.js:115-135`; `node_modules/.pnpm/astro@7.3.7…/node_modules/astro/dist/zod.js:1-7` |
| F12 | **A stateless endpoint.** Each MCP request builds a new server: it reads the enabled plugin tools (all plugin states, one query), serializes the consent snapshot (inside a filter, once per tool), registers every core and plugin tool, and serves one JSON-RPC message or batch. **To verify (V7):** the D1 queries and CPU this adds per tool call | `src/astro/routes/api/mcp.ts:22-59`; `src/emdash-runtime.ts:5802-5820`; `src/mcp/server.ts:853-860` |
| F13 | **No MCP capability.** The manifest's capability list has no MCP or tool entry; exposing routes as tools needs no capability | `src/plugins/manifest-schema.ts:29-57` |
| F14 | **The transfer tools' precedent.** `site_import_start` is `destructiveHint: true` and its docs say to show the user the plan and get confirmation first; it starts only from a plan named by digest. `site_export_status` and `site_import_resume` run one bounded step per call, and the agent repeats them until `nextRequestInMs` is `null` | [MCP server, Site transfer](https://docs.emdashcms.com/reference/mcp-server/); `src/mcp/server.ts:114-124`, `:3756-3960` |
| F15 | **Test tokens.** The dev-bypass PAT has `content:*`, `media:*`, `schema:*` and `admin`, but no `mcp:tools` scope, so it cannot call plugin tools. It can enable them (`/_emdash/api/admin/*` needs `admin`) and mint a PAT with any valid scope through `POST /_emdash/api/admin/api-tokens`, which requires the Admin role | `src/astro/routes/api/setup/dev-bypass.ts:146-167`; `src/astro/routes/api/admin/api-tokens/index.ts:15-21`, `:51-70`; `src/astro/middleware/auth.ts:808-810` |

### Facts about flux-import's own code

| # | Fact | Evidence |
| --- | --- | --- |
| P1 | **Every route is MCP-ready.** Each is built by `route()`: `POST`, `permission: "import:execute"`, an `astro/zod` input. The template-taking routes declare `request: { body: "json", maxBytes: 2 MiB }`, which still passes F1. The exception is `jobs/log.csv`, a raw `GET` route, which can never be a tool | `src/plugin/routes.ts:86`, `:285-301`, `:396-412`; M6a Ruling 17 |
| P2 | **`jobs/create` returns the whole job.** The result holds the template snapshot (up to 256 KiB from a saved template, 1 MiB inline), `targetFields`, `taxonomies`, the lease (holder `<userId>:<ulid>`) and `uploadId`. With a `sourceId`, a real run on unchanged content returns `{ skipped: "unchanged", sourceId, uploadId }` instead. Dry runs are never skipped | `src/plugin/routes.ts:495-566`; `src/engine/types.ts:67-189`; `src/plugin/sources.ts:99-103`, `:423-458` |
| P3 | **`jobs/next` and `jobs/get` return the whole job too.** `jobs/next` runs one batch. The claim succeeds only for a `created` or `running` job without a live lease; otherwise it returns the job unchanged. The lease lasts `budgetMs` + 30 s. On Workers a call processes at most `WORKERS_BATCH_CAP` (11), `WORKERS_LINKED_BATCH_CAP` (6), `WORKERS_ROLLBACK_BATCH_CAP` (3) or the missing-phase caps (40 and 10) records, set from D1 measurements just under 1,000 queries | `src/plugin/routes.ts:568-579`; `src/engine/batch.ts:127`, `:137-161`, `:2112-2125`; `src/plugin/service.ts:41-97`, `:417-433` |
| P4 | **Pasted text.** `sources/paste` takes `{ format, text }` with a 1 MiB body cap and refuses `xlsx`. `stagePaste` refuses empty text (`EMPTY_BODY`) and text over `PASTE_MAX_BYTES` (1 MiB of UTF-8, 413 `TOO_LARGE`), and stages the text like an upload. The template's source block, not `format`, decides how the text is parsed | `src/plugin/routes.ts:427-441`; `src/plugin/service.ts:37-38`, `:193-200` |
| P5 | **An upload ID is a download capability.** A staged file's key is derived from its upload ID (`flux-import-<id>.csv`), and `emdash.storage` serves every such key publicly at `/_emdash/api/media/file/<key>` until the job's file is released or retention deletes it | `src/emdash/uploads.ts:9-15`, `:32-36`; roadmap "Staged sources" |
| P6 | **Dry-run results.** A dry run's planned rows count toward `created`, `updated`, `unchanged` or `removed` by their action. Each record row holds `changes` (`{ field, before, after }`, values of any size, Portable Text included), `errors`, `warnings`, `newTerms` and `newMedia`. Rows are read by `jobs/records` 50 at a time, by `["jobId", "status", "seq"]` | `src/engine/counters.ts:8-24`; `src/engine/types.ts:191-247`; `src/engine/diff.ts:4-6`; `src/plugin/service.ts:466-479`; `src/plugin/definition.ts:30-38` |
| P7 | **Real runs after dry runs.** A completed dry run keeps its staged file (`uploadNeeded`), so a real run can read the same file. An XLSX job's `uploadId` is the JSON Lines conversion, and `sourceUploadId` the workbook, so `startImport` must receive the workbook to convert it again | `src/plugin/service.ts:342-356`; `src/plugin/xlsx.ts:179-205`; `src/engine/types.ts:135-136` |
| P8 | **Job options.** `batchSize` 1-500 (default 50), `budgetMs` 500-25,000 (default 4,000). `journal` (default true) is what makes a real run rollbackable (M5a). `missing: false` skips the M5c phase for a run, and `{ maxPercent }` replaces the template's threshold (default 25). `publish` defaults to true | `src/engine/types.ts:8-10`, `:39`; `src/engine/jobs.ts:114-137`; `src/plugin/routes.ts:303-341` |
| P9 | **Saved templates for jobs.** `resolveJobTemplate` reads the row, refuses `TEMPLATE_NOT_FOUND` and, given a revision, `TEMPLATE_CHANGED`, and returns the template with `{ id, revision }`. `jobs/create` then validates the template as it validates an inline one | `src/plugin/job-templates.ts:15-29`; `src/plugin/routes.ts:500-511` |
| P10 | **Listing.** `templates/list` returns `TemplateSummary` rows (no template body), 8 a page, measured at 1 D1 query and at most 2,099,488 bytes read. `jobs/list` pages 8 **whole** job rows, which can read about 8 MiB for inline-template jobs (M6a open issue) | `src/plugin/templates.ts:127`; `src/plugin/service.ts:27-35`, `:447-464`; M6a review, V5 and Open issues |
| P11 | **The plugin ID.** `flux-import`, a simple ID, so the MCP-safe prefix equals the ID (F2) | `src/meta.ts:1` |

### To verify in Task 0

Each item is proven on Node (`sites/dev`, SQLite) and workerd (`sites/dev-cf`, D1). The Task 0
probe is a temporary MCP tool on an existing route (`list_templates` over `templates/list`) plus an
SDK client script in `.superpowers/wt/scratch-m6c/`. Every probe file is removed afterwards, as in
M5a-M6a.

- **V1. Names (M6a Ruling 44).** `tools/list` lists `flux-import__list_templates`, and the
  generated name is the same in the admin's Plugins page.
- **V2. Schemas across Zod copies (F11).** For every tool's `input`:
  - EmDash's consent serialization succeeds on both runtimes;
  - it is byte-identical across two server processes;
  - the SDK's `tools/list` schema has the expected properties, `required`, enums, bounds,
    `.describe()` texts and, for `.strict()` objects, `additionalProperties: false`;
  - a `.refine()`d object keeps its properties.

  If conversion fails or differs, the tool schemas are built with the package's own `zod`
  (the copy EmDash and the SDK use), and this spec is amended.
- **V3. Pass-through.** The route receives the SDK's parsed arguments. An unknown key is refused
  by a strict schema before the route runs (F6). A route refusal arrives with `_meta.code` and
  `details` (F8). A 2 MiB + 1 byte body to `jobs/plan` is `INVALID_PLUGIN_REQUEST` (413).
- **V4. Consent lifecycle (F3).**
  - Before consent: no `flux-import__*` tool is listed, and a call is "Tool … not found".
  - After `PUT …/mcp { enabled: true }`: all six are listed.
  - After a changed snapshot (the stored consent edited through `withDb`): none are listed, while
    `GET /_emdash/api/admin/plugins` still reports `mcpToolsEnabled: true`.
  - Disabling and enabling again restores them.
- **V5. Scopes and permissions (F4).**
  - A PAT with only `admin` gets `INSUFFICIENT_SCOPE`.
  - A PAT with only `mcp:tools:flux-import` calls every flux-import tool, and gets
    `INSUFFICIENT_SCOPE` from `content_list`.
  - A PAT with `mcp:tools` works too.
  - An Editor-role user's token with `mcp:tools` gets `INSUFFICIENT_PERMISSIONS`.
  - Each refusal writes a `denied` audit row.
  - Recorded, not blocking: whether EmDash's OAuth consent can grant `mcp:tools:flux-import`.
- **V6. The fence (F9).**
  - With a `_emdash_transfer_operations` row of kind `import` in state `running` (written
    through `withDb`), every flux-import tool fails `TRANSFER_IMPORT_IN_PROGRESS`.
  - With a running `export` row, a successful `list_templates` increments its `write_epoch` by
    one, and a refused call (for example `NOT_FOUND`) does not.
- **V7. Budgets (F12).** On workerd, measure:
  - the D1 queries one tool call adds outside the route handler (bearer auth, plugin states, the
    fence, the audit row);
  - the CPU time of a `tools/list` and of a `list_templates` call with six tools enabled;
  - one `next_batch` for each Workers cap kind (P3), at its cap, from the M5a-M5c measurement
    fixtures, plus that overhead.

  Each must stay under 1,000 queries. Any that does not lowers its cap by the excess and the spec
  is amended.
- **V8. Sizes.** On both runtimes, measure four things:
  - `dry_run` with 1 MiB of CSV text full of `"` and `\` (the JSON-escaped body near 2 MiB)
    succeeds;
  - 1 MiB + 1 byte is `TOO_LARGE` (413);
  - the response size of `import_status` with `records` on 10 rows of 3 Portable Text fields each;
  - the bytes it reads (the job row and the 10 record rows).

  If the read passes about 2 MiB, `RECORD_PAGE` is lowered.
- **V9. A malformed cursor.** Measure what `list_templates` and `import_status` answer for
  `cursor: "x"`. If it is `INTERNAL_ERROR`, the two routes catch the storage cursor error and
  answer `400 INVALID_CURSOR`, and this spec is amended.

If V2 or V7 fail, the plan stops and this spec is amended before Task 1.

## Tools

All tools are registered by `definePlugin({ mcp: { tools } })` in `src/plugin/definition.ts`,
from a table in a new `src/plugin/mcp.ts`. Each tool's `input` is the same schema object as its
route's `input`. Every field has a `.describe()` text, because the agent sees only the JSON Schema
and the description (F6, Ruling 21). Names below are the local names; agents see
`flux-import__<name>` (F2).

| Tool | Route | Destructive | Input | Output |
| --- | --- | --- | --- | --- |
| `list_templates` | `templates/list` (M6a, unchanged) | no | `{ collection?, cursor? }` | `{ items: TemplateSummary[], cursor?, hasMore }`, 8 a page (P10) |
| `get_template` | `templates/get` (M6a, unchanged) | no | `{ id }` | `SavedTemplate` (M6a "Storage") |
| `dry_run` | `jobs/plan` (new) | no | `{ templateId, templateRevision?, text?, sourceId?, publish?, missing?, batchSize?, budgetMs? }`, exactly one of `text` and `sourceId` | `{ job: JobSummary }` |
| `start_import` | `jobs/start` (new) | **yes** | `{ dryRunId, batchSize?, budgetMs? }` | `{ job: JobSummary }` |
| `next_batch` | `jobs/step` (new) | **yes** | `{ id }` | `{ job: JobSummary }` |
| `import_status` | `jobs/status` (new) | no | `{ id, records?, cursor? }` | `{ job: JobSummary, records?: { items: RecordSummary[], cursor?, hasMore } }` |

### Descriptions

These texts are part of the consent snapshot (F3). They are drafted here and settled in the plan.
After the release, every change to one costs each site a re-consent (Ruling 20).

- **`list_templates`:** "List the import templates an administrator saved on this site, 8 per
  page. Each item has the template's id, name, description, target collection and locale, and
  source format. Pass the returned cursor for the next page. Read a template with get_template to
  see which columns or paths its data needs."
- **`get_template`:** "Read one saved import template by id: how source columns or paths map to
  collection fields, its record rules, and its current revision. Use it to prepare data that fits
  before calling dry_run."
- **`dry_run`:** "Plan an import from a saved template without changing the site. Give
  `templateId` and the data. Either pass `text`, which is CSV, JSON, JSON Lines or XML in the
  template's format, at most 1 MiB. Or pass the `sourceId` of a URL source an administrator set
  up. Returns a job: call next_batch with its id until `next` is `done`, then review it with
  import_status. Pass `records: "planned"` or `records: "failed"` there to see sample rows. Show the
  user the plan, and call start_import only if they agree. Set `missing: true` only when the data is
  the complete feed: the plan then includes removing entries this template imported before that are
  no longer in the data."
- **`start_import`:** "Run a completed dry run for real. It imports the dry run's data with the
  same template revision and options. Call it only after the user has seen the dry run's summary
  and agreed. Returns the new job: call next_batch with its id until `next` is `done`. Every real
  import keeps a journal, so an administrator can roll it back."
- **`next_batch`:** "Advance a job by one batch and return its summary. Repeat while `next` is
  `next_batch`. If `next` is `wait`, another call is running a batch: wait until `busyUntil` and
  call again. `done` means finished, and `stopped` means paused, failed or cancelled (see `error`).
  A real import's batch writes entries; a dry run's writes none."
- **`import_status`:** "Read a job's summary without advancing it: its status, records read, the
  count of each outcome, warnings and error. Pass `records` with an outcome (`planned`, `created`,
  `updated`, `unchanged`, `failed`, `conflict`, `locked`, `filtered`, `removed`) for up to 10 rows
  of it, with short previews of their changes and errors. Pass the returned cursor for more."

### Input schemas

Shared pieces are those of `routes.ts`: `jobId`, `templateId`, `sourceId`, `cursor`,
`templateRevision` and `RECORD_STATUSES`. The new schemas are built with `astro/zod` like every
route (F11, Ruling 25). They are strict objects, so a misspelt key is refused before the route runs
(F6), rather than stripped and silently ignored.

```ts
// jobs/plan, the dry_run tool
z.object({
	templateId: templateId.describe("A saved template's id, from list_templates"),
	templateRevision: templateRevision.optional()
		.describe("Refuse with TEMPLATE_CHANGED unless the template is at this revision"),
	text: z.string().min(1).optional()
		.describe("The data, in the template's source format, at most 1 MiB"),
	sourceId: sourceId.optional().describe("A URL source's id, given by the user or an administrator"),
	publish: z.boolean().optional().describe("Publish written entries (default true); false keeps them as drafts"),
	missing: z.boolean().optional()
		.describe("Also plan removing entries this template imported earlier that the data no longer holds (default false)"),
	batchSize: z.number().int().min(1).max(500).optional(),
	budgetMs: z.number().int().min(500).max(25_000).optional(),
}).strict().refine((i) => (i.text === undefined) !== (i.sourceId === undefined), {
	message: "Set exactly one of text and sourceId",
});

// jobs/start, the start_import tool
z.object({
	dryRunId: jobId.describe("The id of a completed dry run, from dry_run"),
	batchSize: z.number().int().min(1).max(500).optional(),
	budgetMs: z.number().int().min(500).max(25_000).optional(),
}).strict();

// jobs/step, the next_batch tool
z.object({ id: jobId.describe("The job's id") }).strict();

// jobs/status, the import_status tool
z.object({
	id: jobId.describe("The job's id"),
	records: z.enum(RECORD_STATUSES).optional().describe("Also list rows with this outcome"),
	cursor: cursor.describe("From the previous import_status call with the same records value"),
}).strict();
```

`list_templates` and `get_template` reuse the existing `templates/list` and `templates/get` input
objects, moved to named constants. They are not made strict: that would change what the REST
routes accept, and the SDK strips the unknown keys before the route sees them (F6).

### `JobSummary`

```ts
interface JobSummary {
	id: string;
	kind: "import" | "rollback";
	status: JobStatus;              // created | running | paused | completed | cancelled | failed
	dryRun: boolean;
	phase: "import" | "retry" | "missing";
	collection: string;             // job.template.collection
	locale: string;                 // job.template.locale, as the job resolved it
	templateId?: string;            // M6a
	templateRevision?: number;
	dryRunOf?: string;              // M6c: a real job started from this dry run
	rollbackOf?: string;            // M5a
	rolledBackBy?: string;
	publish: boolean;
	missing: { maxPercent: number } | false | null;  // job.missingLimit; null: no rules.missing
	processed: number;              // records read so far (cursor.seq)
	counters: {                     // every counter, 0 when absent (P6)
		created: number; updated: number; unchanged: number; locked: number; conflict: number;
		failed: number; filtered: number; reverted: number; removed: number;
	};
	missingPhase?: { stage: "count" | "act" | "done"; verdict?: "act" | "refused" | "skipped";
		owned: number; found: number; removed: number };  // M5c, when started
	error: { code: string; message: string } | null;
	warnings: string[];             // the first WARNINGS_SHOWN (10), each cut to TEXT_PREVIEW (300) chars
	warningCount: number;
	busyUntil?: string;             // ISO: a live lease's expiry (never its holder)
	next: "next_batch" | "wait" | "done" | "stopped";
	createdAt: string;
	updatedAt: string;
}
```

`next` is computed as follows:
- `created`, or `running` without a live lease: `next_batch`;
- `running` with a live lease: `wait`;
- `completed`: `done`;
- `paused`, `failed` or `cancelled`: `stopped`.

A summary never holds the following (Ruling 3):
- the template body;
- `targetFields`, `taxonomies`, `plannedTerms`, `deferred` or `cursor`;
- the lease holder, which is `<userId>:<ulid>`;
- `uploadId` or `sourceUploadId` (Ruling 5);
- `sourceId`.

`jobs/plan` with a `sourceId` never returns a skip: dry runs are never skipped (P2).

### `RecordSummary`

```ts
interface RecordSummary {
	seq: number;
	status: RecordStatus;
	action?: string;                // create | update | unchanged | delete | trash | revert | restore | unpublish
	sourceKey: string | null;
	entryId: string | null;
	changes: { field: string; before: string; after: string }[];  // first CHANGES_SHOWN (20)
	changeCount: number;
	errors: { field?: string; code: string; message: string }[];   // first ERRORS_SHOWN (5)
	errorCount: number;
	warningCount: number;
	newTerms: string[];             // first NAMES_SHOWN (5)
	newMedia: string[];             // first NAMES_SHOWN (5); `field: url`
}
```

`before` and `after` are previews: `JSON.stringify(value)` cut to `VALUE_PREVIEW` (200)
characters, with `…` appended when cut, and `"(none)"` for `undefined`. Messages, terms and media
entries are cut to `TEXT_PREVIEW` (300). The preview code cuts by code point, so a cut never splits
a surrogate pair. The page is `RECORD_PAGE` (10) rows by `seq`, on the existing
`["jobId", "status", "seq"]` index. `listRecords` gains a `limit` option, and `jobs/records` keeps
its 50.

### Errors

Every error reaches the agent as `[CODE] message` with `_meta.code` and, where the route gives
them, `_meta.details` (F8). The one exception is the SDK's input validation (F6).

| Code | Tools | When |
| --- | --- | --- |
| (no code) `Input validation error: …` | all | The arguments fail the tool schema: a wrong type, a bound, or an unknown key on a strict schema (F6) |
| `VALIDATION_ERROR` | all | The route's input check, when a value passes the SDK but not the route (the `refine` rules: neither or both of `text` and `sourceId`); `details` is `z.formatError` (F6) |
| `INSUFFICIENT_SCOPE`, `INSUFFICIENT_PERMISSIONS` | all | F4 |
| `TRANSFER_IMPORT_IN_PROGRESS`, `MEDIA_USAGE_ACTIVATION_IN_PROGRESS`, `TRANSFER_FENCE_CHECK_FAILED` | all | The site write fence (F9) |
| `INVALID_PLUGIN_REQUEST` | `dry_run` | A body over `PLAN_BODY_MAX_BYTES` (2 MiB), 413 (F5, P1) |
| `INVALID_CURSOR` | `list_templates`, `import_status` | Only if V9 shows a 500 today |
| `NOT_FOUND` | `get_template`, `start_import`, `next_batch`, `import_status` | No template or job with that ID; for `start_import`, no dry run with that ID |
| `TEMPLATE_NOT_FOUND`, `TEMPLATE_CHANGED` | `dry_run`, `start_import` | P9. On `start_import`: the dry run's template was deleted, or is no longer at the dry run's revision (Ruling 7) |
| `INVALID_TEMPLATE`, `INVALID_OPTIONS`, `INVALID_SOURCE` | `dry_run`, `start_import` | `jobs/create`'s refusals, with `details.problems` (M6a Ruling 50); a template whose fields do not exist yet is refused here (Ruling 13) |
| `INVALID_FORMAT` | `dry_run` | `text` with a template whose source format is `xlsx` (Ruling 6) |
| `EMPTY_BODY`, `TOO_LARGE` | `dry_run` | `text` is whitespace, or over 1 MiB of UTF-8, 413 (P4) |
| the M3c fetch codes, `CREDENTIAL_MISSING`, `CONFLICT` | `dry_run` | `sourceId`: as `jobs/create` with a source |
| `NOT_A_DRY_RUN` | `start_import` | The job is a real import or a rollback, 400 |
| `DRY_RUN_INCOMPLETE` | `start_import` | The dry run's status is not `completed`, 409; `details.status` names it |
| `UPLOAD_NOT_FOUND`, `SOURCE_MISSING` | `start_import` | The dry run's staged file is gone (P7) |
| `INTERNAL_ERROR` | all | An uncaught error (F8) |

## Routes

All four new routes are built by `route()` (`POST`, `import:execute`, P1) and run in
`withServices`, as every route does.

### `jobs/plan`

`jobs/plan` declares `request: { body: "json", maxBytes: PLAN_BODY_MAX_BYTES }`, which is 2 MiB:
enough for 1 MiB of text after JSON escaping, which can double `"` and `\` (V8).

1. Resolve the saved template (`resolveJobTemplate` with `templateRevision`, P9).
2. With `text`:
   - refuse `INVALID_FORMAT` when `template.source.format` is `xlsx` (a schema-valid template's
     format is read; an unparseable one reaches step 4 and is refused there);
   - stage the text with `stagePaste` (P4).
3. Build `StartJobInput` exactly as `jobs/create` does, with these settings:
   - `dryRun: true`;
   - `savedTemplate: { id, revision }`;
   - `journal` left to its default;
   - `missing: false` unless `missing === true`, and no `maxPercent` ever (Ruling 11);
   - `publish`, `batchSize` and `budgetMs` passed through.

   The `jobs/create` handler body is moved into a shared `createJobFrom(ctx, services, request)`,
   which both routes call, so the two cannot drift.
4. With `text`, start the job from the staged upload. With `sourceId`, go through `jobFromSource`
   (a dry run fetches and is never skipped, P2).
5. If step 4 throws after step 2 staged a file, delete that file (best effort; retention removes it
   otherwise, M6a P7) and rethrow.
6. Return `{ job: summarize(job) }`.

### `jobs/start`

1. `getJob(dryRunId)`. A missing job is `NOT_FOUND`. `kind === "rollback"` or `dryRun === false` is
   `NOT_A_DRY_RUN`. A status other than `completed` is `DRY_RUN_INCOMPLETE`.
2. Find the template:
   - with `templateId` on the dry run: `resolveJobTemplate(templateId, templateRevision)`, so a
     template edited or deleted since the dry run is refused (`TEMPLATE_CHANGED`,
     `TEMPLATE_NOT_FOUND`, Ruling 7);
   - without it (an inline dry run an administrator made through `jobs/create`): the dry run's own
     snapshot, through `jobTemplate`.
3. Build `StartJobInput` with these settings:
   - `uploadId: dryRun.sourceUploadId ?? dryRun.uploadId` (the workbook for XLSX, P7);
   - `dryRun: false`;
   - `publish: dryRun.publish`;
   - `missing: dryRun.missingLimit` when it is `false` or `{ maxPercent }` (left out when the
     template has no `rules.missing`);
   - `journal` left to its default (`true`, Ruling 10);
   - `batchSize` and `budgetMs` from the input, else the dry run's;
   - `savedTemplate`, when the dry run had one;
   - `dryRunOf: dryRun.id`.

   No `sourceId` is set (Ruling 9).
4. Create through `createJobFrom`'s upload path (`startImport`, which converts a workbook again).
   The template is validated as at any job creation, so a schema change since the dry run that
   breaks the template is refused with its problems.
5. Return `{ job: summarize(job) }`.

Two `start_import` calls with one `dryRunId` create two real jobs (Ruling 8).

### `jobs/step`

`nextBatch(deps, uploads, id, holder, keep)` exactly as `jobs/next` does, then
`{ job: summarize(job) }`.

### `jobs/status`

`getJob(id)`, and with `records`,
`listRecords(deps, { id, status: records, cursor, limit: RECORD_PAGE })`. Returns
`{ job: summarize(job), records?: { items: rows.map(summarizeRecord), cursor?, hasMore } }`.

### Engine and type changes

- `Job` gains `dryRunOf?: string`, set by `jobs/start` and copied into nothing else (a rollback of
  the real job does not need it). `CreateJobInput` and `StartJobInput` gain it.
- `listRecords` gains `limit?: number`, 1-100, default `PAGE_SIZE`.
- `summarize(job: Job): JobSummary` and `summarizeRecord(row: RecordRow): RecordSummary` live in a
  new `src/plugin/summaries.ts`. They are pure, have unit tests, and never read storage.
- `createJobFrom` (above) is extracted from the `jobs/create` handler without behaviour change. The
  existing route tests pin that.

## The agent's flow

The acceptance sequence, which the integration test runs with the SDK client and the manual check
runs with a real agent:

1. `list_templates`, then `get_template { id }` for the one whose collection fits.
2. `dry_run { templateId, text }`, which returns `next: "next_batch"`.
3. `next_batch { id }`, repeated until `next: "done"`. On Workers, each call does at most 6-11
   records (P3).
4. `import_status { id }`, then `import_status { id, records: "planned" }` and
   `{ records: "failed" }` if `failed > 0`. The agent shows the user the counts and samples.
5. On the user's agreement: `start_import { dryRunId }`, which returns a new job.
6. `next_batch { id }` until `done`, then `import_status { id }`: the counters match the dry run's,
   unless the site changed between the two (conflicts and locks are reported per record).

Stopping is not calling `next_batch` again. The job stays `running` without a lease until an
administrator pauses, cancels or rolls it back through the API (Ruling 14), or until retention
removes it.

## Security

- **Who.** Three gates apply:
  - **The administrator's consent.** Nothing is callable until an administrator enables the
    plugin's tools, and any change to them disables them again (F3).
  - **The token's scope.** A token needs `mcp:tools:flux-import` or `mcp:tools`; `admin` is not
    enough (F4).
  - **The user's role.** Every tool's route requires `import:execute`, so the token's user must be
    an Admin.

  The endpoint takes bearer tokens only, so there is no session or CSRF path (F4). Every call and
  every refusal is in the audit log (F5).
- **The recommended token** carries `mcp:tools:flux-import` and nothing else. Such a token can call
  the six tools and no core tool, and cannot reach the REST plugin routes, which need `admin`
  (F4, F5). So for that token the tool surface below is the whole of what it can do, even though
  its user is an Admin (Ruling 26). M8's README says so. Tests mint their tokens at run time from
  the dev-bypass PAT (F15). No token is committed or written to a file.
- **What an agent can do to content.** Only what a saved template does: create and update entries
  in that template's collection and locale. That includes its taxonomies, references, bylines and
  media, publish or draft per the template and the dry run's `publish`, and, only with
  `missing: true`, trash or unpublish entries that template owns, up to the template's threshold.
  - **Only saved templates.** An agent can neither write a mapping nor edit one (Ruling 4).
  - **Every write follows a completed dry run** of the same data, template revision and options
    (Ruling 7). The client confirms the destructive `start_import` and `next_batch` calls
    (Ruling 17).
  - **Every real run keeps a journal**, so an administrator can roll it back (`jobs/rollback`, M5a)
    (Ruling 10).
  - **The removal threshold is never raised** (Ruling 11).
  - **No schema changes**, so no new fields (Ruling 13).
- **What an agent can read.** Every template body (`get_template`), and every job's summary and
  record previews. Previews show current field values of the entries a job touched, drafts
  included, and source values. They go into the agent's transcript and so to its model provider.
  That is the same data an Admin reads through the API, but it leaves the site. M8's docs say so.
  Previews are cut to 200 characters a value (bounded, not redacted).
- **No capabilities in the transcript.** No upload ID crosses the tool boundary (Ruling 5): an
  upload ID is a public download URL for the staged data (P5), and a transcript is not a private
  channel. URL source URLs and credentials never appear either. The tools do not return sources,
  and the summary omits `sourceId`.
- **Network.** `dry_run { sourceId }` makes the server fetch an administrator's URL through the M3c
  fetcher and SSRF guard, with its stored credential. The agent cannot set or see the URL, the
  header or the value. No tool makes the server fetch a URL the agent chose, except the media URLs
  inside the agent's own data, which the template's image and file mappings download behind the
  same guard (M4c). An agent can thus make the server fetch public URLs it names in the data, as an
  Admin can today.
- **The fence.** Every tool refuses during a site import and media-usage activation, and every
  successful call restarts a running export (F9, Ruling 24). An agent polling `import_status`
  during an export can make it fail after three restarts. M8's docs say not to drive imports while
  an export runs.
- **No SQL, no content queries.** M6c adds no raw SQL and no content query. The new routes read
  plugin storage (jobs, records, templates) and call the existing job engine, whose content queries
  already filter by locale (M4e). The locale rule is unaffected.
- **Input bounds.** Bounds apply at three layers: the SDK's 4 MiB request (F10), the route's 2 MiB
  body, and 1 MiB of text. The template is the saved one, checked when it was saved and again at
  job creation (M6a). The text is parsed by the M3a readers under their existing limits.

## Workers and Node

The routes do what the existing routes do, plus summaries. The MCP path adds a fixed overhead per
call (F12), which V7 measures.

| Tool | Route work (D1 queries, from M6a V5 and M5a-M5c) | Bytes read | Response |
| --- | --- | --- | --- |
| `list_templates` | 1 | at most 2,099,488 (P10) | 8 summaries, a few KB |
| `get_template` | 1 | at most about 262 KB | the template, as stored |
| `dry_run` | `jobs/create { templateId }`: 8. With `text`, one storage write (R2 or local, not D1). With `sourceId`, plus the source's get and compare-and-set and the fetch | the template row | a summary |
| `start_import` | 1 (the dry run) + `jobs/create { templateId }`'s 8 | the dry-run row (at most about 270 KB for a saved template) + the template row | a summary |
| `next_batch` | `jobs/next` under the Workers caps: at most about 900 (P3) | as `jobs/next` | a summary |
| `import_status` | 1, or 2 with `records` | the job row (at most 1 MiB for an inline-template job), plus 10 record rows (V8) | a summary, plus at most 10 record summaries |

- **The MCP overhead** adds these per call, outside the handler: bearer authentication, the plugin
  states query, the fence query, the audit insert, and during an export the epoch update. V7
  measures it. It is projected at 5-8 queries. That fits inside the margin the Workers caps leave
  under 1,000 (the largest measured batch is 978, M5a V8; caps were set at about 900). If V7 shows
  otherwise, the caps drop (V7).
- **CPU.** Each request serializes the consent snapshot once per enabled tool, six tools each time
  (F12), and builds the server. V7 measures it next to a REST call.
- **Node** has no extra limits. `next_batch` on Node processes the job's `batchSize` (up to 500)
  within `budgetMs` (up to 25 s).
- **Call counts.** An agent driving a 10,000-row import on Workers needs about 900-1,700
  `next_batch` calls, at 6-11 records a call. On Node it needs 20-200 calls, depending on
  `batchSize`. Agent-driven imports suit tens to a few thousand records. Feeds belong to M6b's
  schedules (Open issues).

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `text` | at most 1 MiB of UTF-8 (`PASTE_MAX_BYTES`) | The existing paste limit (P4). In practice an agent's output budget binds far earlier |
| `PLAN_BODY_MAX_BYTES` | 2 MiB | 1 MiB of text after JSON escaping (V8); under the SDK's 4 MiB (F10) |
| `WARNINGS_SHOWN` | 10 per summary, each at most `TEXT_PREVIEW` (300) chars | A summary stays at a few KB; `warningCount` gives the total |
| `RECORD_PAGE` | 10 record summaries per `import_status` | Rows are read whole (F2 in M6a), and a row's changes can hold Portable Text; V8 measures the read |
| `CHANGES_SHOWN` | 20 per record, previews of `VALUE_PREVIEW` (200) chars per side | A record summary stays at about 10 KB at most |
| `ERRORS_SHOWN` | 5 per record, messages at most 300 chars | `errorCount` gives the total |
| `NAMES_SHOWN` | 5 new terms and 5 new media per record | As above |
| `list_templates` page | 8 (M6a) | Unchanged |

## Testing

- **Unit, summaries:**
  - `summarize` on an import, a dry run, a rollback, a missing-phase job and a pre-M3a job;
  - counters default to 0;
  - each `next` value, including a `running` job with an expired lease (`next_batch`) and a live
    one (`wait`, `busyUntil` set);
  - 11 warnings give 10, and `warningCount` 11; a 301-character warning is cut to 300;
  - the summary has no key among `template`, `targetFields`, `taxonomies`, `plannedTerms`,
    `deferred`, `lease`, `uploadId`, `sourceUploadId`, `sourceId`, `cursor` (checked against the
    object's keys, recursively).

  `summarizeRecord`:
  - a 21-change row gives 20 and `changeCount` 21;
  - previews at 200 and 201 characters, a surrogate pair at the cut, and `undefined`;
  - 6 errors give 5;
  - `newTerms` and `newMedia` at 5 and 6.
- **Unit, routes (MemoryKv and the existing fakes):**
  - **`jobs/plan`:**
    - with `text`: the job is a dry run from the saved template, `missing: false` by default,
      the template's threshold with `missing: true`, and `journal` never set;
    - with `sourceId`: never skipped;
    - `xlsx` with `text` is `INVALID_FORMAT`; empty text is `EMPTY_BODY`; 1 MiB + 1 byte is
      `TOO_LARGE`;
    - neither or both of `text` and `sourceId` is `VALIDATION_ERROR`;
    - a stale `templateRevision` is `TEMPLATE_CHANGED`;
    - a failing creation deletes the staged file.
  - **`jobs/start`:**
    - a completed dry run gives a real job with the same upload, template revision, `publish`
      and missing limit, `journal` true and `dryRunOf` set;
    - an XLSX dry run uses `sourceUploadId`;
    - an inline dry run uses its snapshot;
    - refusals: a real job (`NOT_A_DRY_RUN`), a rollback job (`NOT_A_DRY_RUN`), a running dry
      run (`DRY_RUN_INCOMPLETE`), a template edited since (`TEMPLATE_CHANGED`) and a deleted one
      (`TEMPLATE_NOT_FOUND`);
    - `batchSize` overrides;
    - a second start from the same dry run creates a second job, whose records come out
      `unchanged`;
    - the real job has no `sourceId`, and the source's `lastImport` is unchanged.
  - **`jobs/step`:** equals `jobs/next` on the same fixture.
  - **`jobs/status`:** `records` pages 10 by `seq`, the cursor continues, and no `records` reads
    no record rows.
  - **`createJobFrom`:** the existing `jobs/create` tests pass unchanged.
- **Unit, definition:**
  - `mcp.tools` has exactly the six names;
  - each references a route that passes F1's checks (`definePlugin` does not throw);
  - each tool's `input` is `===` its route's `input`;
  - `start_import` and `next_batch` are destructive and the others are not;
  - every field of every tool schema has a description;
  - **the consent snapshot test:** `serializePluginMcpConsent`'s algorithm (F3) is applied to the
    six tools and compared with a committed fixture,
    `tests/unit/fixtures/mcp-consent.json`. A change to a name, description, route, permission,
    flag or schema fails the test until the fixture is updated in the same commit (Ruling 20);
  - every new route queries only indexed fields.
- **Integration on `sites/dev`, with a real MCP client.** `tests/integration/mcp.test.ts` uses
  `@modelcontextprotocol/sdk`'s `Client` with `StreamableHTTPClientTransport` (a new
  devDependency, pinned to the 1.32.1 that EmDash resolves) against the started site.
  1. **Setup.** The dev-bypass PAT enables the tools (`PUT /_emdash/api/admin/plugins/flux-import/mcp`)
     and mints a PAT with `["mcp:tools:flux-import"]` (F15). Both are held in memory only.
  2. **Discovery.** `tools/list` holds the six `flux-import__*` names (V1), with
     `destructiveHint` true on the two.
  3. **The acceptance sequence** of "The agent's flow", with a 20-row CSV as `text` through a
     template saved with `templates/create`, then the same through a URL source served by the
     existing feed server. Its results are checked through REST, with the entries read in the
     template's locale: the counts match, the entries exist and are published, and the real job
     has a journal and rolls back (`jobs/rollback` over REST).
  4. **Negative cases:**
     - a call before consent (not listed);
     - the admin-only PAT (`INSUFFICIENT_SCOPE`);
     - `content_list` with the plugin-scoped PAT (`INSUFFICIENT_SCOPE`);
     - an unknown key (input validation error, no route call: no audit row);
     - `start_import` on a running dry run (`DRY_RUN_INCOMPLETE`);
     - a template edited between the two (`TEMPLATE_CHANGED`);
     - a fence row (`TRANSFER_IMPORT_IN_PROGRESS`, V6);
     - the consent voided through `withDb` (tools gone, V4).

     The sequence also checks the audit rows for one call of each tool.
- **Cloudflare parity on `sites/dev-cf`.** Feasible: the workerd harness serves the site over HTTP
  on a port (`tests/integration-cf/global-setup.ts`), so the same SDK client connects. It runs
  setup, discovery and the acceptance sequence with `text` on D1 and R2, at the Workers caps, and
  the V7 measurements. This adds about 2 minutes to `test:cf`.
- **The manual agent run (the acceptance, recorded in the review note).** A real MCP client
  (Claude Code, `claude mcp add --transport http`, with an `Authorization: Bearer` header from an
  environment variable) connects to `sites/dev` started by the integration harness on a throwaway
  database. It is given a 20-row CSV in the prompt, and one instruction: "import this into the
  products collection with the saved template; show me the dry run first". The note records:
  - the tool calls in order;
  - whether the agent ran the dry run, showed it and waited;
  - the final counts;
  - the entries in the admin;
  - anything in the descriptions the agent misread, which is fixed before release, since a later
    fix costs a re-consent.

  The PAT is minted for the run and revoked after it. The transcript excerpt holds no token. A
  run against `sites/dev-cf` is optional and recorded if made.

## Plan sizing

Seven tasks:
- (0) Prove V1-V9.
- (1) Summaries (`summaries.ts`) and `listRecords`' `limit`.
- (2) `createJobFrom`, extracted from `jobs/create`.
- (3) The four routes, and `Job.dryRunOf`.
- (4) The tool table, its definition tests and the consent snapshot.
- (5) Node integration with the SDK client, and workerd parity.
- (6) The review run: V7 and V8 on the final code, the manual agent run, and the note.

A final fix wave follows the whole-branch review. Tasks 1 and 2 can run in parallel.

## Rulings

1. **Six tools.** Each is needed for an agent to complete an import, and none can be folded into
   another without breaking a rule below:
   - **`list_templates`:** the roadmap's discovery tool.
   - **`get_template`:** an agent must know which columns or paths a template reads before it can
     produce data that fits. The dry run's "does not fit" problems reveal only missing CSV columns,
     and JSON and XML paths only as warnings.
   - **`dry_run`:** the roadmap's planning tool.
   - **`start_import`:** the roadmap's run tool.
   - **`next_batch`:** a job advances only through `jobs/next` (M2), so without it nothing runs.
   - **`import_status`:** the roadmap's read tool.

   Every other candidate was weighed and left out (Rulings 4, 5, 13, 14, 15). Every one left out
   can join with M6b, whose schedule tools already cost a second consent (M6a Ruling 35). Anything
   left out past M6b costs a third.
2. **One route per tool, and the tool's input is the route's input object.** A tool's arguments
   reach its route unchanged (F5, F6), so a separate tool schema could only drift from the route's.
   No tool pins a value through a schema default (such as `dryRun: z.literal(true).default(true)`
   over `jobs/create`). The SDK does apply defaults (F6), but then the route would trust the tool
   layer for a safety property. Giving `dry_run` and `start_import` their own routes keeps each
   contract explicit, and usable over REST (M7) with the same meaning.
3. **The new routes return summaries, never job rows.** A job row carries:
   - the template snapshot (up to 1 MiB);
   - the field and taxonomy snapshots;
   - the lease holder (a user ID);
   - the upload ID (P2, P3).

   An agent needs none of these. They cost context, and two of them leak. The summary is a few KB
   and has a fixed shape the tests pin. The M6a open issue about `jobs/list` reading whole rows is
   not hit, because no tool lists jobs. It stays with M7's job list.
4. **Saved templates only.** `dry_run` takes a `templateId`, and there are no template CRUD tools.
   An agent then runs only mappings an Admin saved and reviewed. For the recommended token
   (Ruling 26) that is a real boundary, since it cannot reach `templates/create` over REST. The
   inline `template` is `z.unknown()`, which gives an agent no schema to follow (M6a outline).
   Template tools can join with M6b if agents need to author templates.
5. **Data comes in as text in `dry_run`, or from an existing URL source. There is no paste tool,
   and no upload ID in any tool's input or output.** `sources/paste` returns an upload ID. That ID
   is a public download URL for the staged data (P5), and an agent's transcript goes to its model
   provider. Folding the text into `dry_run` stages it inside the call. `start_import` then names
   the dry run, never the file (Ruling 7), so an agent never holds an ID that reads data. URL
   sources are used by ID only (Ruling 15).
6. **No binary data over MCP.** Tool arguments are JSON (F10). Accepting base64 would add a
   decoding path, a size multiplier and a new limit for one format. XLSX reaches an agent's import
   only through a URL source, and `text` with an `xlsx` template is `INVALID_FORMAT`.
7. **`start_import` runs exactly a completed dry run.** It takes the dry run's ID and nothing that
   changes the outcome. It reads the dry run's staged file, the workbook for XLSX (P7), the same
   template at the same revision, re-read so that an Admin's edit or delete since the dry run is
   refused rather than bypassed, and the same `publish` and missing-entry setting. So the plan the
   user approved is what is written, over the same data, as `site_import_start` starts only from a
   named plan (F14). It also makes Ruling 5 possible. The dry run must be `completed`, so the plan
   was whole when shown. `batchSize` and `budgetMs` may change: they set the pace, not the
   outcome. Entries changed between the two runs are handled per record, as in any run (conflicts,
   locks, M5b's fingerprints).
8. **The real job records `dryRunOf`, and a dry run can be started twice.** `dryRunOf` lets a
   reader tie a real run to its plan. A second `start_import` from the same dry run creates a
   second job. Source keys and links make its records `unchanged` (M2), so a retried call after a
   lost response does no harm. An idempotency mark on the dry run would cost a compare-and-set and
   a recovery path, to prevent a harmless duplicate.
9. **A real job from a URL-source dry run carries no `sourceId` and records no `lastImport`.** It
   imports the dry run's staged copy, not a new fetch, so the source's "last imported content"
   would be guessed. The cost is that the source's next real run on unchanged content is not
   skipped, which imports nothing new (M6a Ruling 29's accepted cost).
10. **Agent jobs always keep a journal.** The tools offer no `journal` option, so every real run an
    agent starts can be rolled back by an Admin (M5a). An agent is the caller most likely to need
    that.
11. **Removing missing entries is opt-in and never above the template's threshold.** Removal is the
    only way an agent's import can touch entries that are not in its data. An agent's data is
    often partial, and a partial run with the template's `rules.missing` would trash or unpublish
    up to the threshold (M5c). So `missing` defaults to `false`; `true` runs the template's own
    rule, and the dry run shows the removals (`removed`) before `start_import` copies the setting.
    The `{ maxPercent }` override of `jobs/create` is not offered.
12. **`publish` is offered on `dry_run`.** Draft-only imports are the review pattern EmDash's AI
    tools guide recommends. `false` is never less safe than the default, and the setting is copied
    to the real run.
13. **No schema tool, and `dry_run` is a `jobs/create` dry run only.** `schema/apply` changes a
    collection's fields, which is an Admin's decision, and its dry run plans a schema rather than
    an import. A template whose fields do not exist yet is refused by `dry_run` with its problems
    (`INVALID_TEMPLATE`). The agent reports them, and an Admin applies the schema.
14. **No rollback, pause, resume, cancel or retry tools.** Stopping is not calling `next_batch`.
    Undoing is an Admin's `jobs/rollback`, from a journal Ruling 10 guarantees. A rollback tool
    would let an agent delete entries in bulk with one call. These are the first candidates to join
    with M6b's consent, if the manual run shows agents need them.
15. **No source tools.** Creating or editing a URL source makes the server fetch an address the
    agent chose, with credentials it could select. Listing sources would show their URLs, which
    may carry tokens in the query string. Schedules name sources, so `list_sources` belongs with
    M6b's tools. Until then the user gives the agent the ID.
16. **`next_batch` runs one batch per call.** One batch per invocation is what the Workers caps
    allow under D1's 1,000 queries (P3). A driver that ran several batches per call could not do
    more on Workers, and on Node the job's `batchSize` already does. This is the pattern of
    `site_import_resume` (F14).
17. **`start_import` and `next_batch` are destructive; the other four are not.** `start_import` is
    where the user's approval belongs (F14). `next_batch` is where entries are written, and it
    advances any running job, an Admin's included. The read tools cannot be marked read-only,
    because EmDash 1.2.0 gives plugin tools only `destructiveHint` (F2). Clients therefore see them
    as non-destructive writers, and the fence treats them as writes (Ruling 24).
18. **No output schemas.** With `output`, the SDK validates after the route has run, and a mismatch
    reports a successful `start_import` as an error (F7). An agent would retry and start a second
    job. Every output field change would also void consent (F3), and every response would be sent
    twice. The response shapes are documented in the descriptions and pinned by the summary tests.
19. **Local names are snake_case, and the generated name is checked.** EmDash's core tools are
    snake_case (`content_list`). The generated name is `flux-import__<name>` in 1.2.0 source (F2).
    V1 records it from `tools/list`, which settles M6a Ruling 44.
20. **The consent snapshot is a committed fixture.** Any change to a tool's name, description,
    route, permission, flag or schema disables the tools on every site until an Admin enables them
    again, with no warning in the admin (F3). A test that compares the snapshot with a fixture makes
    each such change a deliberate edit in the same commit. The release notes then name it. M6b's
    schedule tools are the first planned change.
21. **Agent guidance lives in the descriptions and field descriptions.** That is all an agent sees
    (F6). The descriptions state the order (dry run, show, confirm, start), what `next` means, and
    when to set `missing`, as EmDash's own write tools state their retry protocol in parameter
    descriptions (`src/mcp/server.ts:66-90`). The manual agent run tests them before release
    (Testing).
22. **Summaries carry a `next` hint and `busyUntil`.** An agent needs no knowledge of job states or
    leases to drive a job. `busyUntil` shows a live lease without its holder.
23. **`import_status` reads one job and, on request, one bounded page of one outcome.** Reviewing a
    plan means seeing examples, not every row. Ten rows with 200-character previews show what will
    change, within a bounded response. V8 measures the read. The full log stays `jobs/log.csv`,
    which cannot be a tool (P1).
24. **Plugin tools are refused during a site import, and every successful call restarts a running
    export.** This corrects M6a F-M4 and Ruling 46, which said plugin tools are blocked during a
    site export. The fence refuses calls only during an import or media-usage activation. During an
    export a call runs, and then bumps the export's write epoch, so even `list_templates` restarts
    the export, which fails after three restarts (F9). flux-import cannot mark its read tools
    read-only (F2), so the behaviour is documented (Security, M8 docs, Open issues) and not worked
    around.
25. **Tool schemas use `astro/zod`, like the routes.** EmDash types tool `input` with `astro/zod`
    (F11), and Ruling 2 makes the tool's schema the route's. V2 proves that the cross-copy
    conversion works and is stable. If it does not, the schemas move to the package's `zod` with a
    cast, and the spec is amended.
26. **The recommended token is `mcp:tools:flux-import` alone.** `mcp:tools` would add every other
    plugin's tools, and `admin` would add every core tool and the REST routes. The plugin-scoped
    token makes the six tools the agent's whole reach (Security). Tests mint tokens at run time and
    hold them in memory; none is committed.
27. **No new capability, storage collection, index or version bump.** Tools need no capability
    (F13). The routes reuse the engine and the records index. `dryRunOf` is an unindexed optional
    field, and the docs ask for a version bump for storage changes only (M6a F5).
    `FLUX_IMPORT_VERSION` stays 0.3.0.
28. **Text that fails to make a job is deleted at once.** A refused `dry_run` would otherwise leave
    a staged copy of the agent's data in public storage until retention (P5). The delete is best
    effort, and retention still covers a failure.

## Out of scope

- **Inline templates, and template CRUD, export and import tools** (Ruling 4).
- **`schema/apply`** (Ruling 13).
- **Sources and credentials** (Ruling 15).
- **Binary and base64 data** (Ruling 6).
- **Rollback, pause, resume, cancel and retry tools** (Ruling 14).
- **Listing jobs.** Agents keep the IDs their calls return; see Open issues.
- **Output schemas** (Ruling 18).
- **A multi-batch driver** (Ruling 16).
- **The `mcp` actor source.** `ActorInfo.source` accepts `"mcp"` (`src/plugins/types.ts:1391-1395`).
  A route can tell an MCP call from a REST one only by the internal request's URL (F5), which is
  not a documented contract. Writes are attributed to the token's user with source `"api"`, as
  today.
- **Schedules (M6b), suggestions (M6d), the admin (M7), and the README and `skills/` entry (M8).**
  The skill teaches the flow of "The agent's flow".

## Open issues

- **The export restart** (F9, Ruling 24). Any plugin tool call during a site export restarts it,
  reads included, and three restarts fail it. Only EmDash can fix this, by letting plugin tools
  declare `readOnlyHint`. It is documented for users in M8.
- **The stale "Agent access" switch** (F3). After an upgrade that changes the tools, the admin shows
  the tools enabled while none are served. The administrator must switch them off and on. M8's
  upgrade notes say so, and M6b's release notes repeat it.
- **OAuth and the plugin scope** (F4, V5). EmDash's OAuth metadata advertises `mcp:tools` but not
  `mcp:tools:flux-import`. If V5 shows the consent page cannot grant the narrower scope, OAuth
  clients get `mcp:tools` (every plugin's tools), and the narrow token is a PAT only.
- **Discovering IDs.** An agent cannot list jobs or sources. In a new conversation it must be given
  a job ID or source ID. `list_sources` is planned with M6b (Ruling 15). A job listing waits for a
  summary-row read (the M6a `jobs/list` issue, now M7's).
- **Large imports through an agent.** On Workers, 6-11 records per `next_batch` call means about
  1,000 calls per 10,000 rows (Workers and Node). Agents suit small and medium imports. Feeds belong
  to M6b's schedules.
- **Content leaves the site in previews** (Security). Record previews put entry values, drafts
  included, into the agent's transcript. They are bounded, not redacted.
- **The plan can go stale.** Between `dry_run` and `start_import`, entries can change. The real run
  reports conflicts and locks per record, and its counts may differ from the plan's.
- **Two real jobs from one dry run running at once** (Ruling 8). Their writes to the same entries
  race, and the loser reports `conflict` per record. This is harmless and visible, but noisy.
- **The per-request consent serialization** (F12). Its CPU cost grows with the number of tools
  squared; V7 measures it at six.
- **Production D1 is unverified**, as for every milestone since M2. The first deploy repeats V7.
- **Carried forward.** These are unchanged by M6c:
  - the M2-M6a open issues;
  - the `package.json` version (0.1.0) against `FLUX_IMPORT_VERSION` (0.3.0), until M8;
  - the production Cloudflare build blocker from M2.
