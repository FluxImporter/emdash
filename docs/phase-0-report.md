# Phase 0: architecture verification

Findings for the seven questions, with file references. Everything below was read from the
EmDash source at commit `7d06f5d4` (main, 2026-09-29, `emdash@1.0.1`), deepened to 400 commits
for history. Paths are relative to the EmDash repository root.

## How this was verified, and what could not be

- The `emdash-docs` MCP server and `https://docs.emdashcms.com` were unreachable from this
  session (the outbound proxy answered 403 for both). The docs site source is in the repository
  under `docs/src/content/docs/`, so every docs citation below points at that source.
- GitHub's API and HTML pages for `emdash-cms/emdash` were also blocked, so issues #3391 and
  #3392 could not be read. See question 3 for what the git history does show.
- Correction to `CLAUDE.md`: EmDash is not pre-1.0 any more. `AGENTS.md` says "EmDash is
  published, in active use, and on 1.x" and asks for additive changes only; `packages/core`
  is at 1.0.1. The API still moves quickly, so the docs-first rule stands.

## 1. Native plugin runtime: what `ctx` exposes

`definePlugin()` lives in `packages/core/src/plugins/define-plugin.ts:74` and returns a
`ResolvedPlugin`. Its header comment states the trust model: native plugins "have full access
to the runtime — capabilities are still enforced by `PluginContextFactory`, but there is no
isolation boundary". The same `PluginContextFactory` (`packages/core/src/plugins/context.ts`)
builds the context for native and sandboxed plugins, so `ctx` has the same shape in both.

`PluginContext` (`packages/core/src/plugins/types.ts:1056`):

| Member | Capability | Notes |
| --- | --- | --- |
| `plugin`, `log`, `site`, `url()` | always | |
| `storage.<collection>` | always | JSON records with declared indexes, CAS, `updateIf`, cursor queries (`types.ts:271`) |
| `kv`, `settings` | always | `settings` supports encrypted `secret` fields |
| `cron` | always | see question 3 |
| `schema` | `schema:read` | `listCollections()`, `getCollection()` only (`types.ts:467`) |
| `content` | `content:read`, `content:write`, `content:revisions:read`, `content:publish`, `content:restore` | `types.ts:573` |
| `taxonomies` | `taxonomies:read`, `taxonomies:write` | `types.ts:663` |
| `bylines` | `bylines:read` | read only (`types.ts:752`) |
| `media` | `media:read`, `media:bytes:read`, `media:metadata:write`, `media:write` | `types.ts:890` |
| `http` | `network:request`, `network:request:unrestricted` | buffered, 8 MiB each way (`http-wire.ts:1`) |
| `users` | `users:read` | read only (`types.ts:993`) |
| `redirects`, `comments`, `email` | respective capabilities | not needed here |

Capability strings are the `PLUGIN_CAPABILITIES` list in `@emdash-cms/plugin-types`; the
creating-plugins skill (`skills/creating-plugins/SKILL.md`) tabulates them.

### What it can and cannot do

| Need | Through `ctx`? | Evidence |
| --- | --- | --- |
| Create or alter collections and fields | **No.** `ctx.schema` is read only. | `skills/creating-plugins/references/sandbox-boundaries.md` ("Schema access is read-only"), `SchemaAccess` at `types.ts:467` |
| Create users | **No.** `ctx.users` is a directory lookup. | `UserAccess` at `types.ts:993` |
| Create bylines | **No.** `bylines:read` only; PR #3394 added reads and hooks, no writes. | `BylineAccess` at `types.ts:752` |
| Create menus | **No.** No menu API on `ctx` at all. | `types.ts` has no menu access interface |
| Upload media | **Yes**, with `media:write`: `ctx.media.upload(filename, contentType, ArrayBuffer)` and `getUploadUrl()`. | `types.ts:920`, `context.ts:1018` |
| Taxonomy terms | **Yes**, with `taxonomies:write`: `createTerm()` (supports `parentId`), `addEntryTerms()`, `removeEntryTerms()`. Cannot create taxonomy definitions or attach them to collections. | `types.ts:561`, `types.ts:690`, sandbox-boundaries.md |
| Content create | **Partially.** `ctx.content.create(collection, data, { locale, translationOf })`. Only field data, SEO, locale and translation source are forwarded to the runtime; no slug, status, publishedAt, taxonomies, references or bylines. | `emdash-runtime.ts:2180` (`contentCreate` callback), `EmDashRuntime.handleContentCreate` at `emdash-runtime.ts:3322` |
| Content update | **Partially, and without safety rails.** `ctx.content.update(collection, id, data)` writes through `ContentRepository.updateDraftAware()` directly: no `_rev` check, no entry-lock check, no `content:beforeSave` hooks, field data only. | `context.ts:857`, `database/repositories/content.ts:1210` |
| Publish, unpublish, schedule, restore | **Yes**, revision-fenced with `_rev` from `getVersioned()`. | `types.ts:635`, `types.ts:655` |
| Revisions | **Read only** with `content:revisions:read`: `listRevisions()`, `getRevision()`. | `types.ts:573` |

Two more limits of the plugin media path matter for an importer. First,
`ctx.media.upload()` does not deduplicate by content hash; it writes to storage and creates a
record (`context.ts:1061`). Only the REST upload handler hashes and reuses existing items
(`api/handlers/media-upload.ts:146`). Second, since PR #3405 trusted plugins may upload only the
default media allowlist (PNG, JPEG, GIF, WebP, AVIF, video, audio, PDF), so a CSV or XML source
file cannot be parked in the media library.

### The supported path for everything else: trusted site code

The native-plugin docs are explicit that hook and route handlers "receive the plugin context, not
the Astro context, so `Astro.locals` is not available in them"
(`docs/src/content/docs/plugins/creating-native-plugins/your-first-native-plugin.mdx`). The
sandbox-boundaries reference says direct database access "require[s] trusted site code". EmDash
exposes that trusted surface in two public, typed places:

1. **`locals.emdash`** in an Astro API route, typed as `EmDashHandlers`
   (`packages/core/src/astro/types.ts:276`). It includes
   `handleContentCreate` (`:326`, accepts `slug`, `status`, `authorId`, `bylines`, `locale`,
   `translationOf`, `taxonomies`, `references`, `createdAt`, `publishedAt`, `actor`),
   `handleContentUpdate` (`:346`, same plus `_rev`), `handleMediaUpload` (`:455`, accepts
   `base64` **or `url`**, applies the allowlist, `maxUploadSize` and content-hash dedupe),
   `storage` and `db` (`:613`, commented "Direct access to storage and database for advanced use
   cases"), and `hooks`.
2. **`withEmDashRuntime(fn)`** from `emdash/middleware`
   (`packages/core/src/astro/middleware.ts:344`), documented for "a Cloudflare Queue consumer, a
   `scheduled()` handler, or any other platform-event handler that has no request". It resolves
   the same runtime singleton, so a plugin route or cron hook can reach `runtime.handleContent*`,
   `runtime.storage` and `runtime.db` without a request.

Schema writes have a public class: `SchemaRegistry` is exported from `emdash`
(`packages/core/src/index.ts:485`) with `createCollection()` (`schema/registry.ts:516`),
`createField()` (`:1276`) and `updateField()` (`:1417`); it takes a Kysely `db`. The REST routes
use the same handlers under `schema:manage` (`astro/routes/api/schema/collections/index.ts:32`).
Byline and menu creation are only reachable through their REST routes (`POST /_emdash/api/bylines`
under `bylines:manage`, `POST /_emdash/api/menus` under `menus:manage`); the handlers
`handleBylineCreate` (`api/handlers/bylines.ts:129`) and `handleMenuCreate`
(`api/handlers/menus.ts:144`) are not exported from `emdash`. Entry locks are enforced by the REST
content route through `claimEntryLockForWrite`
(`astro/routes/api/content/[collection]/[id].ts:118`), which is also internal.

A native npm package can ship trusted site routes as a normal Astro integration that calls
`injectRoute`, which is how core installs its own routes (`astro/integration/index.ts:670`).
There is no hook for a plugin descriptor to contribute an integration, so it is a second entry
in `astro.config.mjs`.

## 2. WXR, Gutenberg and HTML to Portable Text

- **Gutenberg and WP-flavoured HTML.** `@emdash-cms/gutenberg-to-portable-text` (1.0.1, published)
  exports `gutenbergToPortableText(content: string, options?: ConvertOptions): PortableTextBlock[]`
  (`packages/gutenberg-to-portable-text/src/index.ts:124`). `ConvertOptions` is
  `{ mediaMap?, customTransformers?, generateKeys?, keyGenerator? }` (`src/types.ts:239`).
  Unknown blocks are never dropped: `fallbackTransformer` emits `{ _type: "htmlBlock", html,
  originalBlockName, originalAttrs }` (`src/transformers/index.ts:66`). Content without block
  comments reaches the parser as a freeform block with `blockName === null`, which also resolves
  to the fallback (`src/transformers/index.ts:100`); `index.ts:21` has regex-based HTML element
  handling whose exact freeform behaviour I will confirm with fixtures in milestone 5 rather than
  assume. The core WXR importer uses this function for every post
  (`packages/core/src/import/sources/wxr.ts:287`).
- **Markdown.** `markdownToPortableText(markdown)` and `portableTextToMarkdown(blocks)` live in
  `packages/core/src/client/portable-text.ts:179` and `:54`, exported through `emdash/client`
  (`packages/core/package.json` exports `./client`). Unknown blocks round-trip as opaque fences.
- **Generic HTML.** There is no dedicated HTML-to-Portable-Text function. The Contentful package
  converts Contentful rich-text JSON, not HTML.
- **WXR.** The WXR parser and normaliser are exported from `emdash`: `wxrSource`, `parseWxrDate`,
  `wordpressRestSource`, `importReusableBlocksAsSections`, plus the `ImportSource`,
  `NormalizedItem` and related types (`packages/core/src/index.ts:540`). The import execution
  itself is an Astro route (`astro/routes/api/import/wordpress/execute.ts`), not a reusable
  function. Its SSRF helpers (`ssrfSafeFetch`, `validateExternalUrl`) are exported from
  `import/index.ts` but not re-exported from the `emdash` root.

## 3. Plugin cron

**API.** `ctx.cron` implements `CronAccess` (`types.ts:1121`): `schedule(name, { schedule, data? })`,
`cancel(name)`, `list()`. The plugin handles the `cron` hook with
`(event: { name, data?, scheduledAt }, ctx)`. A schedule is a 5- or 6-field cron expression or an
alias such as `@daily` (parsed by `croner` in UTC), or an ISO 8601 date-time for a one-shot task
(`packages/core/src/plugins/cron.ts:251` for `CronAccessImpl`, `:380` onwards for validation).
Task names are `[A-Za-z][A-Za-z0-9_-]*`, at most 128 characters, upserted per plugin and name.

**Native plugins.** Yes. The context factory attaches `CronAccessImpl` for every plugin, and the
executor dispatches through `HookPipeline.invokeCronHook(pluginId, event)`
(`packages/core/src/plugins/hooks.ts:1019`), which finds the hook in the shared pipeline that
holds native and sandboxed plugins alike. The forms plugin, a native plugin, schedules a weekly
cleanup this way (`packages/plugins/forms/src/index.ts:100`).

**Dispatch.**

- Node: `NodeCronScheduler` (`plugins/scheduler/node.ts`) wakes at the next due time, capped at
  60 seconds (`:26`), and calls `CronExecutor.tick()`.
- Cloudflare: the runtime starts no scheduler (`emdash-runtime.ts:455`). The Worker's
  `scheduled()` handler from `createScheduledHandler()` (`packages/cloudflare/src/worker.ts:84`)
  calls `runScheduledTasks()` inside `waitUntil`, which runs `cronExecutor.tick()`, stale-lock
  recovery, scheduled publishing, cleanup and backups (`emdash-runtime.ts:935`). This needs
  `"triggers": { "crons": ["* * * * *"] }` in `wrangler.jsonc` and the exported handler
  (`docs/src/content/docs/deployment/cloudflare.mdx:44`); `emdash doctor` checks both
  (`cli/commands/doctor.ts:186`). Under `astro dev` the timer scheduler still runs (PR #1636).
- `tick()` claims at most 10 due tasks per run (`cron.ts:101`), runs each hook through
  `executeWithTimeout` with the hook's own `timeout`, which defaults to **5000 ms**
  (`define-plugin.ts`, `resolveHook`; `hooks.ts:437`). A failed recurring hook is logged and the
  next run is still computed; one-shots retry with backoff up to 5 times. Locks older than 10
  minutes are recovered (`cron.ts:22`).

Consequence for us: cron is reliable enough to *trigger* work every minute, but the hook must
not run an import batch inline. It should claim the job and hand off to a bounded batch runner,
with an explicit `timeout` on the hook.

**Issues #3391 and #3392.** Not readable from this session (see the top of this report). What the
history shows: PR #3390 (commit `f3f7cc31`, "resolve plugin cron schedules in UTC") and PR #3484
(commit `0993a3d9`, 2026-09-26, "make plugin cron scheduling resilient"). The #3484 changeset says
one-shot due times are now stored as canonical UTC (with migration `088_cron_oneshot_utc.ts`),
and "invalid saved task data or a recurring schedule with no future run is now disabled after it
is claimed instead of blocking the rest of the batch and being retried indefinitely". No commit
message or changeset references #3391 or #3392 by number. If you paste the two issue titles, or
grant this session GitHub access to `emdash-cms/emdash`, I will confirm whether #3484 closed them.

## 4. Native React admin pages

**Registration** needs three matching pieces
(`docs/src/content/docs/plugins/creating-native-plugins/react-admin.mdx`):

1. The descriptor's `adminEntry` (`astro/integration/runtime.ts:106`) names the browser module.
   Astro bundles it statically through the `virtual:emdash/admin-registry` module
   (`astro/integration/virtual-modules.ts:327`).
2. The runtime's `admin.entry`, `admin.pages` and `admin.widgets` (`PluginAdminConfig`,
   `types.ts:2107`) declare the surfaces.
3. The admin module exports `pages`, `widgets`, `fields`, `contentEditorPanels` and
   `contentListColumns` (`packages/admin/src/lib/plugin-context.tsx:16`). Pages mount at
   `/_emdash/admin/plugins/<plugin-id><path>`; the root falls back to the first page
   (`plugin-context.tsx:62`).

**Host surface.** The package declares these as peers so it shares the host instances
(`creating-native-plugins/distributing.mdx:59`): `react` 18 or 19, `@cloudflare/kumo`
(all controls), `@lingui/core` and `@lingui/react` (shared i18n instance; plugins load their own
catalog into it), `@tanstack/react-query` (a `QueryClient` is in the tree), `@emdash-cms/admin`
and `emdash`. `@emdash-cms/admin` exports the router helpers `Link`, `useNavigate`, `useParams`,
components such as `MediaPickerModal`, `ContentList` and `PortableTextEditor`, the `lib/api`
client functions, `cn` and `useLocale` (`packages/admin/src/index.ts`). `AGENTS.md` rules apply:
Kumo only, every string through Lingui, RTL-safe logical Tailwind classes.

**Calling plugin routes.** `apiFetch()` and `parseApiResponse()` from `emdash/plugin-utils`
(`packages/core/src/plugin-utils.ts:27`). `apiFetch` sets `X-EmDash-Request: 1`; the session
cookie authenticates. Routes live at `/_emdash/api/plugins/<plugin-id>/<route>` and the host
checks the route's `permission` before dispatch (`plugins/http-route-dispatch.ts:75`, `:108`).
The native handler receives one `RouteContext` (`types.ts:1867`): `input`, `request`,
`requestMeta`, `user`, plus the plugin context. The same `apiFetch` reaches core REST routes
(schema, bylines, menus) with the admin's own permissions.

## 5. Large file uploads through a plugin route

Plugin routes cannot stream. The host buffers the body before the handler runs
(`plugins/routes.ts:132`, `plugins/route-wire.ts:177`) and proxies `ctx.request.json()`,
`.formData()`, `.arrayBuffer()` and friends to throw (`plugins/routes.ts:47`). The limits are
constants in `packages/plugin-types/src/routes.ts:3`: 1 MiB default body, 8 MiB maximum via
`request.maxBytes`, at most 100 multipart parts of 1 MiB each. An undeclared POST route parses
JSON only.

There is no blob store on `ctx`: `ctx.storage.<collection>` holds JSON documents. The `Storage`
interface (`packages/core/src/storage/types.ts:157`: `upload` accepting a `ReadableStream`,
`download`, `delete`, `exists`, `list`, `getSignedUploadUrl`) is reachable only from trusted
code as `locals.emdash.storage` or `runtime.storage` (`astro/types.ts:613`).
`ctx.media.getUploadUrl()` does hand out a presigned direct-to-storage URL (`context.ts:1028`),
but it creates a pending media record and is restricted to the media allowlist, so it is not a
home for CSV, XML, JSON or XLSX sources.

For its own importer, core uses a trusted Astro route with `request.formData()`
(`astro/routes/api/import/wordpress/analyze.ts:121`), re-sends the file with every chunk, and
processes 30 posts per Worker invocation with an `{ offset, source }` cursor
(`execute.ts:41`, `:44`).

Conclusion: source files must enter through a trusted site route that streams `request.body`
into `emdash.storage` under an import-scoped key, and batches must re-open the object with
`storage.download()` and parse from a saved byte offset.

## 6. Runtime limits: Workers versus Node

Verified in the repository:

- Sandboxed plugins get 50 ms CPU, 10 subrequests, 128 MB, 30 s wall time per invocation
  (`docs/src/content/docs/deployment/plugin-sandbox.mdx:115`). Native plugins have "no
  per-plugin limits" (`creating-plugins/choosing-a-format.mdx`), so platform limits apply.
- Plugin HTTP bodies are 8 MiB each way (`plugins/http-wire.ts:1`). Media byte reads are 10 MiB
  by default and 16 MiB maximum (media reference).
- Core sizes its own work for D1 and Workers: `SQL_BATCH_SIZE` chunks for D1's bind-parameter
  cap (`AGENTS.md`), 100 promotions per collection per scheduled tick, 30 posts per import chunk.
- Nothing in `packages/core/src` uses `eval` or `new Function`.

Not verifiable in this session because `developers.cloudflare.com` was blocked; the following
is from my own knowledge of the Workers platform and should be checked against the limits page
before we pin batch sizes:

| Limit | Cloudflare Workers | Node |
| --- | --- | --- |
| CPU time per invocation | 30 s default on paid plans, raisable to 5 min with `limits.cpu_ms`; 10 ms on the free plan | none |
| Memory | 128 MB per isolate | process memory |
| Subrequests | 1,000 per invocation on paid plans, 50 on free; 6 simultaneous connections | none |
| Request body | plan-wide: 100 MB Free and Pro, 200 MB Business, 500 MB Enterprise | server config |
| `scheduled()` wall time | up to 15 minutes | n/a |
| `eval` / `new Function` | throw `EvalError` (code generation from strings is disallowed) | available |

Design consequences: batches are bounded by a wall-clock budget and a record count, the cursor is
persisted after every batch, media downloads count against the subrequest budget, and the
transform language must be an interpreter with no code generation.

## 7. Exposing MCP tools from a plugin

Declare `mcp.tools` in `definePlugin()`; each `PluginMcpToolDefinition` is
`{ description, route, input: ZodType, output?: ZodType, destructive?: boolean }`
(`types.ts:1933`). `definePlugin` validates that the name matches `[A-Za-z0-9_-]+`, the route
exists, is private, is a JSON POST route, and declares a `permission`
(`define-plugin.ts:127`). The MCP server registers each tool as `<pluginId>__<name>`
(`packages/core/src/mcp/server.ts:911`). A call needs the route's permission on the caller's
role plus the token scope `mcp:tools:<pluginId>` (`server.ts:920`), and an administrator must
enable MCP tools for the plugin (`mcpToolsEnabled`, `emdash-runtime.ts:5645`, admin route
`astro/routes/api/admin/plugins/[id]/mcp.ts`). PR #3468 (commit `aa054aea`) fixed registration
for built plugins in `plugins: []`; source-level native plugins keep `mcp` in the module and were
always registered.

## Test infrastructure available to us

`@emdash-cms/plugin-test` exports `createPluginTestHost()` (fast hook, route, storage, KV,
settings tests) and `createPluginRuntimeTestHost()` (real content actions, media, scheduling with
a controlled clock, restart, authorization, CSRF) (`packages/plugin-test/src/index.ts:18`,
`:112`). Core's own tests use Node's built-in SQLite with no DB mocks, and `workerd` parity tests
live in `packages/core/tests/workerd/`.
