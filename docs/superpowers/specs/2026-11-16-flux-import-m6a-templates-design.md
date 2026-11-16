# Flux Import M6a: saved templates, JSON export and import

Status: drafted 2026-11-16 (the user approved all remaining milestones up front on 2026-10-27;
design decisions are the implementer's rulings). First of four parts of Milestone 6 (Automation)
of [the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-6-split). Builds on M5c
([spec](./2026-11-12-flux-import-m5c-missing-entries-design.md),
[review](../notes/2026-11-12-m5c-review.md)), merged at `74ec874`. The parts after it (M6b
scheduled URL imports, M6c MCP tools, M6d AI mapping suggestions) are outlined at the end, with the
EmDash facts that decide their feasibility, so that the split and its order rest on the same
evidence as this part.

## Goal

Today a template exists only inside the `jobs/create` request that uses it, and inside the job that
request creates (`src/plugin/routes.ts:246-269`, `src/engine/jobs.ts:142-150`, `:246`). M6a gives
templates a life of their own:

- **Saved templates.** An administrator (or, from M6c, an agent) creates, lists, reads, updates and
  deletes named templates. Each one has a stable ID and a revision number that moves on every
  change.
- **Validation in two levels.** Saving refuses a template whose shape is wrong (the same schema and
  expression checks `jobs/create` runs today). Checks against the site (collection, fields,
  taxonomies, locales) are run and **reported**, not refused, so a template can be saved before its
  fields exist, or imported from another site and fixed afterwards with `schema/apply`.
- **Export and import.** A saved template is exported as one JSON document in a versioned envelope
  that holds nothing site-specific beyond the template itself, and a document of that format is
  imported as a new saved template, on the same site or another.
- **Jobs from saved templates.** `jobs/create` takes a `templateId` instead of an inline
  `template`. The job keeps a snapshot of the template as it was, and records the template's ID and
  revision; editing or deleting the template never changes a job. `jobs/list` filters by template,
  and `schema/apply` takes a `templateId` too.

Nothing about importing changes: an inline `template` keeps working exactly as in M5c, and a job
made from a saved template behaves exactly like one made from the same template inline. The
template format stays `version: 1` (roadmap, "Template v1").

## Non-goals

Schedules and the job options a schedule would carry (M6b); MCP tools (M6c); mapping suggestions
(M6d); the admin screens (M7); a template history beyond the current revision; duplicating a
template in one call; exporting several templates in one file; signed export files; per-template
permissions; a default `rules.owner`; bounding inline templates in `jobs/create` beyond today's
body limit. See "Out of scope" for the reasons.

## Decisions

| Topic | Decision |
| --- | --- |
| Where | A new plugin storage collection `templates`, one document per saved template, keyed by ULID. Not plugin settings (admin-form values, no queries) and not KV (no indexes; `list` loads every key) (F1, F9, Ruling 1). |
| Row | Name, optional description, the parsed template, a `revision` number, timestamps and user IDs, and four fields copied from the template for queries and listings: `collection`, `locale`, `owner`, `format` (Storage). |
| Validation | **Structural** (template schema, `rulesProblems`, expression compilation, source block) refuses with `INVALID_TEMPLATE`. **Site checks** (`checkTemplate` against the schema without source columns, locales, the shared-owner warning) are returned as `check: { problems, warnings }` and never refuse a save. `jobs/create` refuses as it does today (Rulings 3, 4). |
| Names | 1-100 characters, no leading or trailing whitespace, no control characters, unique among saved templates by a check before the write, as URL sources do. No `uniqueIndexes` (F4, Ruling 5). |
| Concurrency | Every update and delete names the `revision` it read; a different current revision is `409 TEMPLATE_CHANGED`. The write itself is a storage compare-and-set, so a change that lands between the read and the write also gives 409 (F3, Ruling 6). |
| Jobs | `jobs/create` takes exactly one of `template` and `templateId` (with an optional expected `templateRevision`). The job stores the template it parsed, as today, plus `templateId` and `templateRevision`. Resume, retry, the missing phase and rollback read the job's copy only (Ruling 2). |
| Export | `templates/export` returns `{ filename, file }` as an ordinary JSON route response, where `file` is `{ format: "flux-import.template", formatVersion: 1, exportedAt, generator, name, description?, template }`. No IDs, user IDs, site URL, sources, credentials or job options (Rulings 8, 9). |
| Import | `templates/import` takes `{ file, name? }` and always creates a new saved template. A taken name is `409 NAME_TAKEN` unless `name` overrides it. Replacing an existing template is `templates/update` with the file's `template` (Ruling 10). |
| Versions | Two numbers: the file envelope's `formatVersion` and the template's `version`, both 1. An unknown value of either is refused with its own code and message; unknown keys inside the template are refused (strict schema), unknown envelope keys are ignored. No migration code until a version 2 exists (Ruling 11). |
| Size | A saved template's JSON is at most `TEMPLATE_MAX_BYTES` (256 KiB, UTF-8), checked on create, update and import (F3, F6, Ruling 13). |
| Owner | No default `rules.owner`. A save whose template shares `rules.owner`, `collection` and `locale` with another saved template gets a warning (Ruling 7). |
| Capabilities | None added. Templates live in plugin storage, which needs no capability; the site checks read the schema through the trusted runtime and taxonomies through `ctx.taxonomies`, both already declared (F12, Ruling 14). |
| Version | `FLUX_IMPORT_VERSION` goes from 0.2.0 to 0.3.0: M6a adds a storage collection and a `jobs` index (F5, Ruling 16). |

## EmDash facts this design relies on

Checked on 2026-11-16 against `emdash@1.2.0` (package `src/`, cited as file:line), the docs
(`emdash-docs` MCP and the pages it returns) and the Cloudflare D1 docs. M5c's facts (F1-F16) and
the earlier parts' still hold. All are **confirmed** from source or docs unless marked otherwise;
the unconfirmed ones are listed under "To verify in Task 0".

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | **Plugin storage collections.** A collection declared in `definePlugin({ storage })` offers `get`, `put`, `delete`, `exists`, `getVersioned`, `compareAndSet`, `compareAndDelete`, `getMany`, `putMany`, `deleteMany`, `query` (always paginated) and `count`. Collections are scoped to the plugin; native plugins declare them in `definePlugin()` | `src/plugins/types.ts:271-319`; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Collection API", "How collections are isolated" |
| F2 | **Queries.** `limit` is 1-100 (default 50); `where` and `orderBy` fields must appear in a declared index (each field of a composite counts); without `orderBy` pages follow `(created_at, id)` and the cursor carries both values, so it survives rewrites and deletes; with `orderBy` the cursor re-reads its row, which must still exist | `src/database/repositories/plugin-storage.ts:357`; M5c F10, F11; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Index design" |
| F3 | **Conditional writes.** `compareAndSet(id, null, v)` creates only when absent; with a revision it replaces only when the stored revision matches; a failed precondition is `{ applied: false }`. `compareAndDelete(id, revision)` deletes only at that revision. Conditional writes take a JSON value of at most 1 MiB (UTF-8) and keys of at most 1,024 characters; the docs state no size limit for a plain `put` | `src/plugins/conditional-storage.ts:1-30` (`:3`, `:26-27`); `src/plugins/types.ts:279-285`; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Conditional writes" |
| F4 | **Unique indexes.** `uniqueIndexes` exist and in 1.2.0 create `CREATE UNIQUE INDEX … ON _plugin_storage(plugin_id, collection, …)`. The error a duplicate `put` raises is **not documented**. A later EmDash release ships migration `095_plugin_storage_unique_scope`, which needs a maintenance window (no rolling deploy) on every site that has a plugin unique index; 1.2.0's migrations end at `091` | `@emdash-cms/plugin-types@0.6.0` `dist/index.d.ts:803-818`; `src/plugins/storage-indexes.ts:72-81`; `src/database/migrations/` (last `091_redirect_artifacts.ts`); [updating](https://docs.emdashcms.com/deployment/updating/) "Fixed: plugin storage uniqueness" |
| F5 | **Adding a collection or index.** EmDash creates declared indexes when the plugin loads (once per process, from the scheduler path); a missing physical index slows a query but never fails it. The docs ask for a version bump whenever an index is added, removed or changed | M5c F11; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Adding indexes" |
| F6 | **D1 limits.** Row, string or BLOB at most 2,000,000 bytes; 100 bound parameters per query; 1,000 queries per Worker invocation on the paid plan and 50 on the free plan; an SQL statement of at most 100,000 bytes. Whether a bound value counts toward the statement length is **not stated** (V1) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| F7 | **Route bodies.** A plugin route's JSON body defaults to at most 1 MiB, and a route may raise it to 8 MiB with `request: { body: "json", maxBytes }` | `@emdash-cms/plugin-types@0.6.0` `dist/index.js:4-5`; `packages/flux-import/src/plugin/routes.ts:343-355` (`sources/paste`) |
| F8 | **Private routes.** They require their declared `permission`; cookie-authenticated calls need `X-EmDash-Request: 1` (all methods); token calls are exempt from the header but need the `admin` scope and the permission. `routeCtx.user` is the authenticated caller | [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/) "Authentication and CSRF", "The authenticated caller"; roadmap "Permissions" |
| F9 | **Settings and KV.** `ctx.settings` and `ctx.kv` offer `get`, `getVersioned`, `compareAndSet`, `compareAndDelete`, `set`, `delete` and `list(prefix?)`; no index or paged query. Settings are for user-configurable values (secret ones encrypted with `EMDASH_ENCRYPTION_KEY`), KV for internal state and caches; queryable records belong in storage | `src/plugins/types.ts:335-363`; [settings](https://docs.emdashcms.com/plugins/creating-plugins/settings/) "Read and write settings", "Secret values"; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Storage vs content vs KV" |
| F10 | **Routes that can become MCP tools.** `definePlugin` accepts `mcp.tools`, each `{ description, route, input, output?, destructive? }`, and refuses a tool whose route is unknown, public, `response: "raw"`, not a POST-compatible JSON route, or without `permission`. So a raw route (such as `jobs/log.csv`) can never be a tool, and every M6a route must stay a JSON POST with a permission | `src/plugins/types.ts:1949-1959`; `src/plugins/define-plugin.ts:160-176`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/) "Exposing a route as an MCP tool"; `packages/flux-import/src/plugin/routes.ts:310-326` |
| F11 | **IDs.** `ulid()` is exported from `emdash` (re-exported from `ulidx`); job and source IDs already use it | `packages/flux-import/src/plugin/routes.ts:3`, `:198`, `:213`; M5c F15 |
| F12 | **Capabilities.** Plugin storage, settings, KV and cron need no capability; `schema:read` and `taxonomies:write` (already declared) cover `ctx.schema` and `ctx.taxonomies`; there is no capability for plugin storage itself | `src/plugins/manifest-schema.ts:30-58`; `src/plugins/types.ts:1056-1112`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/); `packages/flux-import/src/plugin/definition.ts:60-69` |

### Facts about flux-import's own code

| # | Fact | Evidence |
| --- | --- | --- |
| P1 | **Templates are inline today.** `jobs/create` takes `template: z.unknown()`; `createJob` parses it with `templateSchema` (strict, `version: z.literal(1)`) and stores the parsed value on the job. `schema/apply` takes an inline `template` too | `src/plugin/routes.ts:246-269`, `:284-295`; `src/engine/jobs.ts:139-150`, `:235-251`; `src/engine/template.ts:332-394`; `src/plugin/schema-apply.ts:400-431` |
| P2 | **What a job reads later.** Resume, retry, the missing phase and rollback read `job.template` (through `jobTemplate`, which also fills the source block of jobs stored before M3a); nothing re-reads a request's template | `src/engine/jobs.ts:339-342`; `src/engine/batch.ts:930-1003`; `src/engine/owner.ts:10`; `src/engine/revert.ts:163`; `src/engine/journal.ts:44` |
| P3 | **The template's checks.** Shape: `templateSchema` with the `rules` refinement (`rules.missing` needs `rules.owner`); `compileTemplate` (JSONata compiled, not evaluated); `checkSource`. Site: `startJob` reads the collection's fields, reference targets' fields and taxonomy definitions and resolves locales, then `checkTemplate(t, fields, columns, siteTimezone, links)`, which skips the column checks when `columns` is `null`, and `rulesProblems` | `src/engine/template.ts:293-315`, `:1342-1425`, `:1445-1467`; `src/engine/jobs.ts:182-215`; `src/plugin/service.ts:226-321` |
| P4 | **The URL-source precedent.** Source names are unique by a `query({ where: { name } })` before the write (`assertNameFree`), updates are compare-and-set loops on the newest row, and the race between the check and the write is accepted | `src/plugin/sources.ts:119-124`, `:174-211` |
| P5 | **The storage port.** `KvCollection` has `get`, `put`, `delete`, `deleteMany`, `getVersioned`, `compareAndSet` and `query`, but no `compareAndDelete`; `MemoryKv` (the unit fake) mirrors it | `src/engine/ports.ts:5-24`; `src/emdash/storage.ts:19-37`; `tests/unit/fakes.ts:76-134` |
| P6 | **Job listing.** `jobs/list` filters by `status` and orders by `createdAt` descending; `jobs` is indexed on `status`, `createdAt`, `uploadId`, `sourceUploadId` | `src/plugin/routes.ts:476-483`; `src/plugin/service.ts:438-451`; `src/plugin/definition.ts:22-23` |
| P7 | **Retention.** The daily task deletes expired jobs with their rows and staged files; it reads no other collection, so saved templates are kept forever | `src/plugin/retention.ts:47-116`; `src/plugin/definition.ts:95-112` |
| P8 | **Version.** `FLUX_IMPORT_VERSION` is 0.2.0 (M5c bumped it for its `links` index); `package.json` stays 0.1.0 until M8 | `src/meta.ts:2`; M5c review "Versions" |

### To verify in Task 0

Each item is proven on Node (SQLite) and workerd (D1) through a temporary probe route, as in M5a-M5c.

- **V1. A large template row on D1.** `put` and `get` (and `compareAndSet`) of a `templates` row
  whose template is 256 KiB of JSON works on D1 and SQLite (F3, F6: whether a bound value counts
  against the 100 KB statement limit is not stated). If it fails, `TEMPLATE_MAX_BYTES` is lowered
  to the largest size that works, with a margin, and this spec is amended.
- **V2. The new collection and index on an upgraded site.** On a site with M5c data, after the
  upgrade: `templates.query({ where: { name } })` and `jobs.query({ where: { templateId },
  orderBy: { createdAt: "desc" } })` validate at once; the physical indexes appear after the next
  scheduler tick (F5); jobs saved without `templateId` are simply not matched.
- **V3. Parsing is idempotent.** For every template fixture in the unit and integration suites,
  `templateSchema.parse(templateSchema.parse(t))` deep-equals `templateSchema.parse(t)` (defaults
  such as `source` are applied once, nothing is dropped), so storing the parsed form and parsing it
  again at job creation changes nothing (Ruling 3).
- **V4. `compareAndDelete`.** At a stale revision it returns `{ applied: false }` and deletes
  nothing, on SQLite and D1 (F3); the revision `getVersioned` returns is the one it takes.
- **V5. Route budget.** Each M6a route stays under 50 D1 queries (the free plan's limit, F6) with
  the site checks on a collection with a reference field and two taxonomies: measured, not
  projected.
- **V6. MCP eligibility (recorded for M6c, not shipped).** A throwaway build with
  `mcp: { tools: { list_templates: { route: "templates/list", … } } }` passes `definePlugin`'s
  checks, appears in `getPluginMcpTools()`, and the generated tool name for the plugin ID
  `flux-import` is recorded (1.2.0 source builds `${pluginId}__${name}`, `src/mcp/server.ts:908-911`;
  the docs speak of an "MCP-safe plugin prefix", which may differ).

If V1 or V3 fail, the plan stops and this spec is amended before Task 1.

## Storage

```ts
// STORAGE gains (src/plugin/definition.ts):
//   templates: { indexes: ["name", "collection", "owner"] },
//   jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId", ["templateId", "createdAt"]] },

interface SavedTemplate {
	id: string;              // ULID, also the storage key
	name: string;            // 1-100 characters, see "Names"
	description?: string;    // at most 2,000 characters
	template: Template;      // templateSchema's output (defaults applied), Ruling 3
	revision: number;        // 1 on create, + 1 on every update
	// Copied from `template` on every write, for queries and listings:
	collection: string;      // template.collection
	locale: string;          // template.locale, as written (not the site's casing)
	owner?: string;          // template.rules?.owner
	format: SourceFormat;    // template.source.format
	createdAt: string;       // ISO
	updatedAt: string;
	createdBy: string;       // user ID of the caller (routeCtx.user, F8); never exported
	updatedBy: string;
}

// What templates/list returns: a row without its template body.
type TemplateSummary = Omit<SavedTemplate, "template">;

// Job gains (src/engine/types.ts): templateId?: string; templateRevision?: number
// CreateJobInput gains: savedTemplate?: { id: string; revision: number }
// KvCollection gains: compareAndDelete(id, expectedRevision): Promise<{ applied: boolean }> (P5)
```

- **Indexes.** `name` serves the uniqueness check and `templates/get { name }`; `collection` the
  listing filter; `owner` the shared-owner warning. Nothing orders by a field, so no `updatedAt`
  index (Ruling 15). The jobs index `["templateId", "createdAt"]` serves `jobs/list { templateId }`
  newest first; both its fields pass the indexed-field check on their own (F2).
- **Copied fields.** Index fields must be top-level identifiers
  (`src/plugins/manifest-schema.ts:187-188`), so `collection`, `locale`, `owner` and `format` are
  copied out of the template on every write. They are derived, never accepted from the caller.
- **Retention.** Saved templates are not purged (P7). Deleting a template leaves the jobs made from
  it untouched (Ruling 2); their `templateId` then names a template that is gone, and
  `jobs/list { templateId }` still finds them.

## API

All routes are plugin routes under `/_emdash/api/plugins/flux-import/`, `POST`, JSON in and out,
`permission: "import:execute"`, input validated with `astro/zod` as the existing routes are
(`src/plugin/routes.ts:239-244`), errors mapped through `toRouteError` (F8, F10).

| Route | Input | Output |
| --- | --- | --- |
| `templates/list` | `{ collection?, cursor? }` | `{ items: TemplateSummary[], cursor?, hasMore }`, 50 a page, creation order |
| `templates/get` | `{ id }` or `{ name }` | `SavedTemplate` |
| `templates/create` | `{ name, description?, template }` | `{ template: SavedTemplate, check }` |
| `templates/update` | `{ id, revision, name?, description?: string \| null, template? }`, at least one change | `{ template: SavedTemplate, check }` |
| `templates/delete` | `{ id, revision? }` | `{ deleted: true }` |
| `templates/export` | `{ id }` | `{ filename, file: TemplateFile }` |
| `templates/import` | `{ file, name? }` | `{ template: SavedTemplate, check }` |
| `jobs/create` | as today, plus `templateId?`, `templateRevision?`; exactly one of `template` and `templateId` | job (as today) |
| `jobs/list` | as today, plus `templateId?` | page of jobs |
| `schema/apply` | as today, plus `templateId?`; exactly one of `fields`, `template` and `templateId` | as today |

`check` is `{ problems: string[], warnings: string[] }` (see "Validation"). `templates/get` and
`templates/export` return the row as stored, without running checks.

### Errors

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | The route input fails its Zod schema (EmDash's route validation), including names and descriptions out of bounds |
| `INVALID_TEMPLATE` | 400 | Structural validation fails; `details.problems` lists `path: message` for every issue, as `jobs/create` does |
| `UNSUPPORTED_TEMPLATE_VERSION` | 400 | `template.version` is not 1: "This template has format version <n>; this version of flux-import reads version 1" |
| `INVALID_FILE` | 400 | `templates/import`: the file is not an object, or `format` is not `"flux-import.template"`, or a required envelope field is missing or out of bounds |
| `UNSUPPORTED_FILE_VERSION` | 400 | `formatVersion` is not 1: "This file was written by a newer flux-import (file format <n>, generator <version>); this site reads file format 1" |
| `TEMPLATE_TOO_LARGE` | 413 | The parsed template's JSON is over `TEMPLATE_MAX_BYTES` |
| `NOT_FOUND` | 404 | No template with that ID or name (`jobs/create`, `schema/apply`: `TEMPLATE_NOT_FOUND`) |
| `NAME_TAKEN` | 409 | Another saved template has the name; `details.id` names it |
| `AMBIGUOUS_NAME` | 409 | `templates/get { name }` found two rows (the accepted race, Ruling 5); `details.ids` lists them |
| `TEMPLATE_CHANGED` | 409 | The current revision is not the one named (update, delete, `jobs/create` with `templateRevision`), or a write landed between the read and the compare-and-set; `details.revision` is the current revision when known |

## Names

- 1-100 characters, not trimmed; refused when they start or end with whitespace or contain a
  control character (`/[\u0000-\u001f\u007f]/`). Compared exactly (case-sensitive), as source names
  are (P4).
- **Unique by check.** Create, import and a rename query `templates` by `name` (limit 2) and refuse
  `NAME_TAKEN` when another row has it, then write. Two creates of the same name at the same moment
  can both pass the check; the result is two rows with one name, which every name lookup reports as
  `AMBIGUOUS_NAME` until one is renamed or deleted (Ruling 5). Lookups by ID are unaffected.

## Validation

### Structural (refuses)

On `templates/create`, `templates/update` with a `template`, and `templates/import`, in this order:

1. `template` is an object whose `version` is 1, else `UNSUPPORTED_TEMPLATE_VERSION` (a template
   with no `version` falls through to step 2, which reports it with its path).
2. `templateSchema.safeParse` (strict; the `rules` refinement included), else `INVALID_TEMPLATE`
   with every issue as `path: message` (P1, P3).
3. `rulesProblems`, `compileTemplate` (expressions compiled, never evaluated) and `checkSource`,
   each failure `INVALID_TEMPLATE` with its problems (P3).
4. The UTF-8 length of `JSON.stringify(parsed)` is at most `TEMPLATE_MAX_BYTES`, else
   `TEMPLATE_TOO_LARGE`.

The parsed value is what is stored (Ruling 3). These are exactly the checks `createJob` runs before
it opens the source (`src/engine/jobs.ts:142-195`), factored into one function both call, so a
template that saves is never refused by `jobs/create` for its shape.

### Site checks (reported)

After the structural checks pass, the same request runs the checks `startJob` runs that need no
source (P3), and returns them as `check`:

- **problems** (would refuse `jobs/create` today): the locale and `translationOf.locale` not
  resolvable on the site (`resolveSiteLocale`, `resolveTranslationLocale`); the collection missing;
  `checkTemplate(t, fields, null, siteTimezone, linkSchema)`, which reports missing fields,
  incompatible types, unknown or unattached taxonomies, required fields not mapped and so on, and
  skips the column checks because there is no source (`columns: null`).
- **warnings** (never refuse): `linkWarnings`, `translationWarnings`, and the **shared owner**:
  when `rules.owner` is set, `templates.query({ where: { owner }, limit: 100 })` and every other
  row with the same `collection` and `locale` gives "Saved template <name> (<id>) uses the same
  owner <owner> for <collection>/<locale>: the two act as one import, and each one's missing phase
  treats the other's entries as its own; give each feed its own owner" (M5c "Template
  documentation", Ruling 7).

The site timezone is read only when the template uses `tz: "site"` (`needsSiteTimezone`, as
`jobs/create` does). `check` is computed on every create, update and import and is not stored: the
schema can change after a save, so a stored verdict would go stale; `jobs/create` checks again
with the source's columns, and refuses as it does today.

## Export file format

```json
{
	"format": "flux-import.template",
	"formatVersion": 1,
	"exportedAt": "2026-11-16T10:00:00.000Z",
	"generator": { "plugin": "flux-import", "version": "0.3.0" },
	"name": "Shop feed",
	"description": "Nightly products feed from the shop",
	"template": {
		"version": 1,
		"source": { "format": "csv" },
		"collection": "products",
		"locale": "en",
		"key": { "from": "sku" },
		"rules": { "owner": "shop-feed", "missing": { "action": "unpublish", "maxPercent": 10 } },
		"fields": { "title": { "from": "Name", "type": "text" } }
	}
}
```

- **`templates/export`** returns `{ filename, file }`. `filename` is
  `flux-import-template-<slugified name or "template">.json` (`slugify` from `template.ts`, at most
  80 characters). The file holds the stored template as is; it is not re-validated, so a template
  saved by a newer plugin version and read after a downgrade can still be exported (Ruling 11).
- **What it never holds** (Ruling 9): the row's ID, revision, timestamps and user IDs; the site URL
  or name; URL sources, credentials or their names; job options; jobs. A template itself holds only
  names (collection, fields, taxonomies, locales, owner) and the source's own paths, expressions
  and constants; a media `baseUrl` is part of the mapping and stays.
- **`templates/import`** validates the envelope (`format` exactly `"flux-import.template"`,
  `formatVersion` exactly 1, `name` and `description` as on create, `exportedAt` and `generator`
  optional and not trusted), ignores any other envelope key, then runs the structural checks on
  `template`, the name check (on `name` when given, else `file.name`), the size check, and the
  site checks. It creates a row with revision 1; `createdBy` is the importer.

### Versioning

- **The template format** is `version: 1` and stays 1 while every change is additive (roadmap,
  "Template v1"). The schema is strict, so a template with a key this plugin version does not know
  (one exported by a newer version, for example) is refused with the key's path, not imported with
  the key dropped: a dropped rule could be a safety rule (`protectEdited`, `missing.maxPercent`)
  (Ruling 11).
- **The file envelope** is `formatVersion: 1`. It changes only when the envelope's meaning changes
  (for example, several templates in one file); new optional envelope keys do not bump it, since
  readers ignore unknown envelope keys.
- **Stored rows** hold the template's own `version`. When a version 2 exists, one function
  (`readSavedTemplate`) upgrades a stored or imported version 1 template on read; M6a ships no such
  code, only the explicit refusal of an unknown version, so the single place for the upgrade is
  named now and nothing speculative is built (Ruling 11). A row is re-validated at every use
  (`jobs/create`, `schema/apply`), never trusted because it was valid when saved.

## Jobs from saved templates

- **`jobs/create { templateId, templateRevision?, … }`.** The route reads the row first (404
  `TEMPLATE_NOT_FOUND`; with `templateRevision`, a different revision is `TEMPLATE_CHANGED`), then
  proceeds exactly as with `template: row.template`: the site timezone and `publishAt` collection
  reads, `fetchLimitsFor`, `startImport`, `jobFromSource` for a `sourceId` (`src/plugin/routes.ts:
  409-461`). Setting both `template` and `templateId`, or neither, is `VALIDATION_ERROR`.
- **The job's snapshot.** `createJob` stores the template it parsed, as today, plus `templateId`
  and `templateRevision`. A later update or delete of the template changes no job: resume, retry,
  the missing phase and rollback read `job.template` (P2, Ruling 2). The revision on the job says
  which version of the template it ran.
- **`jobs/list { templateId }`** returns that template's jobs newest first; with `status` too, both
  filter.
- **`schema/apply { templateId }`** reads the row and plans from `row.template` as from an inline
  template (`src/plugin/schema-apply.ts:400-431`); `collection`, when given, must still match.
- **Owner and missing.** A job from a saved template uses its `rules.owner` and `rules.missing` as
  written; nothing defaults the owner to the template ID (Ruling 7).

## Security

- **Who.** Every route requires `import:execute` (Admin, `src/plugin/routes.ts:71`); token callers
  need the `admin` scope; cookie callers send `X-EmDash-Request: 1` (F8). `createdBy` and
  `updatedBy` come from `routeCtx.user`, never from the body. M6c adds the MCP path, which keeps the
  route permission (Outline).
- **Imported files are untrusted input.** The envelope is checked field by field; the template goes
  through the same strict schema, expression compilation and source checks as `jobs/create`, and a
  size bound. Expressions are compiled, never evaluated, on save and import; they are evaluated only
  by a job, under M3b's limits, as today. Field and taxonomy names in a template are checked
  against `SLUG_RE`-style patterns by the schema, so keys such as `__proto__` are refused.
- **No secrets in templates.** URL credentials stay in the encrypted `credentials` setting and are
  referenced by URL sources, not by templates; a template body is stored in plain JSON in plugin
  storage and copied onto every job. The docs for M8 state that a template must not hold secrets
  (an expression can hold any string). An export file carries no credential, credential name,
  source URL, user ID or site URL (Ruling 9).
- **No SQL, no content queries.** M6a uses the plugin storage API only; it adds no raw SQL and no
  content query (the site checks read the schema and taxonomy definitions, not entries), so the
  locale rule for content queries is unaffected. Existing content queries are unchanged.
- **Display.** Names and descriptions are plain text; the M7 admin renders them escaped (React).
- **Tests.** Integration tests use the dev-bypass PAT created at run time (roadmap "Testing"); no
  token is committed.

## Workers and Node

Every M6a route makes a handful of plugin storage calls plus, for the site checks, EmDash's schema
and taxonomy reads. Projected D1 queries (V5 measures them):

| Route | Storage calls | Site checks | Projected D1 queries |
| --- | --- | --- | --- |
| `templates/list` | 1 query | none | 1-2 |
| `templates/get` | 1 get, or 1 query by name | none | 1-2 |
| `templates/create`, `templates/import` | name query, owner query, `compareAndSet(id, null)` | collection fields, each reference target's fields, taxonomy definitions when mapped | about 10-25 |
| `templates/update` | `getVersioned`, name query on rename, owner query, `compareAndSet` | as create, when `template` changes | about 10-25 |
| `templates/delete` | `getVersioned`, `compareAndDelete` | none | 2-3 |
| `templates/export` | 1 get | none | 1 |
| `jobs/create { templateId }` | 1 get more than today | as today | today's + 1 |

All stay far under the paid plan's 1,000 queries per invocation and are meant to stay under the
free plan's 50 (F6). CPU is one schema parse and one JSONata compilation per template, as
`jobs/create` already spends. Node has no extra limits.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `TEMPLATE_MAX_BYTES` | 256 KiB of JSON (UTF-8) | Under the 1 MiB conditional-write value limit (F3) and the 1 MiB default route body (F7) with room for the envelope; the job row holds the template too, under D1's 2 MB row (F6); V1 |
| Name | 1-100 characters | Typed by people and agents; used as a query value |
| Description | at most 2,000 characters | Listing payloads stay small (50 summaries a page) |
| `templates/list` page | 50 | `PAGE_SIZE` as the other lists (`src/plugin/service.ts:27`); storage maximum 100 (F2) |
| Shared-owner query | 100 rows | One storage page (F2); more than 100 templates with one owner is reported from the first 100 |
| Name query | 2 rows | Enough to tell taken from ambiguous |

## Testing

- **Unit, validation:** `version` 2 and absent; a strict-schema refusal with its path; the `rules`
  refinement; an invalid expression; a bad source block; a template exactly at
  `TEMPLATE_MAX_BYTES` (accepted) and one byte over (refused); names at 1 and 100 characters, 0 and
  101, leading or trailing space, a control character; description at 2,000 and 2,001. **V3** as a
  table test over every template fixture: parse of the parse equals the parse.
- **Unit, service (`MemoryKv`, `FakeLookups`, the fake schema lookup):** create, get by ID and by
  name, list paging (51 rows, a delete between pages) and the `collection` filter; summaries carry
  no `template`; update with the right and a stale revision, a rename to a taken name, a rename to
  its own name, `description: null`; a compare-and-set lost between read and write gives
  `TEMPLATE_CHANGED`; delete with and without revision, stale; `NAME_TAKEN` and `AMBIGUOUS_NAME`
  (two rows seeded with one name); copied fields follow the template on every update. Site checks:
  a missing collection, a missing field, an unattached taxonomy and an unknown locale are
  `problems` and the row is saved; the shared-owner warning for same owner, collection and locale,
  and none when the collection or locale differs or the row is itself.
- **Unit, export and import:** export holds exactly the envelope keys and none of `id`, `revision`,
  `createdBy`, timestamps; the filename for an ordinary name, a name that slugifies to nothing, and
  a long one. Import: round trip (export then import gives an equal `template`, a new ID and
  revision 1); a hand-written file without `generator`; unknown envelope keys ignored; an unknown
  key inside `template` refused with its path; `format` wrong, `formatVersion` 2,
  `UNSUPPORTED_TEMPLATE_VERSION`; name taken, then the `name` override.
- **Unit, jobs:** `jobs/create` input refuses both and neither of `template` and `templateId`; a job
  from a saved template equals one from the same inline template except for `templateId` and
  `templateRevision`; `templateRevision` stale; the template updated and then deleted after the job
  was created, then the job resumed, retried and rolled back from its snapshot; `jobs/list
  { templateId }` and with `status`; `schema/apply { templateId }`, and with a mismatched
  `collection`.
- **Unit, definition:** `STORAGE.templates` and the jobs index are declared; every new route is POST
  with `import:execute`, not raw, so it passes `definePlugin`'s MCP route checks (F10); every query
  the new code makes names only indexed fields (the existing definition test's pattern);
  `FLUX_IMPORT_VERSION` is 0.3.0.
- **Integration on `sites/dev`:** create a template whose collection has no `price` field yet
  (saved, with the problem reported), `schema/apply { templateId }`, update it (problems gone,
  revision 2), import 10 rows with `jobs/create { templateId }`, update the template again while
  the job is paused and resume it (the job runs revision 2's mapping), export, import the file under
  another name, run a dry run from the copy; delete the original and list its jobs. A URL-source job
  from a saved template (`sourceId` plus `templateId`).
- **Cloudflare parity on `sites/dev-cf`:** the CRUD sequence, a job from a saved template and an
  export-import round trip on D1; V1, V2, V4 and V5 on D1.

## Plan sizing

Seven tasks: (0) prove V1-V6; (1) storage: the `templates` collection, the jobs index, the
`compareAndDelete` port and fakes, the version bump; (2) the shared structural validation
(factored out of `createJob`), names, size, `readSavedTemplate`; (3) the template service: CRUD,
revisions, site checks, the shared-owner warning; (4) export and import; (5) routes, and
`jobs/create`, `jobs/list` and `schema/apply` by `templateId`, with the job's `templateId` and
`templateRevision`; (6) Node integration, workerd parity, the review run with V5 measured, and the
note. A final fix wave follows the whole-branch review.

## Rulings

1. **Saved templates are documents in a new plugin storage collection.** Storage has indexes,
   paged queries and compare-and-set (F1-F3). Settings hold admin-form values and KV internal
   state, neither queryable (F9); a template is an operational record that people and agents list,
   search by name and change concurrently.
2. **A job keeps a snapshot; it never re-reads its template.** Jobs already store the parsed
   template and every later step reads that copy (P2). Editing a template under a paused or failed
   job would otherwise change what a resume or retry writes, and a rollback's journal would no
   longer match the mapping that produced it. The job records `templateId` and `templateRevision`
   so the operator can tell which version ran.
3. **The stored template is the schema's output, and it is re-validated at every use.** Storing the
   parsed form applies defaults once and makes exports deterministic; V3 proves parsing it again
   changes nothing. Re-validating at `jobs/create` covers rows written by another plugin version.
4. **Shape refuses; the site is reported.** A template that cannot be parsed or compiled is never
   useful, so it is refused as `jobs/create` refuses it. A template whose collection or fields are
   missing is useful: it may be saved before `schema/apply` creates the fields, or imported from
   another site. Site problems are returned on every save and enforced by `jobs/create`, where
   they matter; storing them would go stale as the schema changes.
5. **Names are unique by a check, not by a unique index.** The error a duplicate raises is
   undocumented, and a later EmDash release migrates plugin unique indexes with a maintenance window
   on every site that has one (F4); a plugin should not impose that on its users for a display
   name. The check-then-write race is the one URL sources accept (P4); its result is reported as
   `AMBIGUOUS_NAME` by name lookups and never affects lookups by ID, which jobs use.
6. **Optimistic concurrency by revision number, enforced by compare-and-set.** People in the admin
   and agents over MCP (M6c) will edit the same templates; a lost update would silently change a
   feed's mapping. The integer is readable in responses and on jobs; the storage revision closes the
   window between the read and the write (F3).
7. **No default `rules.owner`.** M5c Ruling 1 suggested that saved templates could default the owner
   to their ID. Declined: the ID changes on export and import and is new for a copy, so the same
   feed imported on a second site, or a template re-imported after a delete, would get a new owner
   and silently stop owning (and so stop removing) the entries it created. An explicit name
   survives both. The shared-owner warning operationalises M5c's "one owner name, one feed"
   documentation among saved templates.
8. **Export is a JSON route response, not a raw download.** A raw route can never become an MCP tool
   (F10), and M6c needs an agent to export and import; the admin (M7) saves the returned `file` as a
   download in the browser. The envelope gives the file a self-describing `format` and
   `formatVersion`.
9. **Exports are site-neutral.** IDs, revisions, user IDs, timestamps other than `exportedAt`,
   sources, credentials and job options are left out: a file may be shared with another team or
   committed to a repository, and those values are either secret, personal, or meaningless on
   another site.
10. **Import always creates.** Replacing a template by file is an update with a revision check, which
    `templates/update` already offers with the file's `template`; an import that could overwrite by
    name would bypass that check.
11. **Two version numbers, both refused when unknown, and no migration code yet.** The template's
    `version` is the format of mappings and rules; the envelope's `formatVersion` the shape of the
    file. An unknown template key is refused rather than dropped, because the key may be a safety
    rule. An unknown envelope key is ignored, because only the template is acted on. The upgrade
    point (`readSavedTemplate`) is named so a version 2 has one place to land; writing upgrade code
    before a second version exists would be speculative.
12. **A saved template holds the template only.** Job options (`publish`, `batchSize`, `budgetMs`,
    `journal`, `missing`) and the source belong to a run, and M6b's schedule is the record that ties
    a template, a source and options together. Keeping them out keeps one meaning per record and
    keeps exports portable.
13. **256 KiB per template.** The largest realistic template (200 mapped fields with expressions) is
    well under 64 KiB; 256 KiB leaves room while staying far from the 1 MiB conditional-write and
    route-body limits (F3, F7) and from D1's row size (F6), pending V1.
14. **No new capability.** Plugin storage needs none (F12); the site checks reuse the schema and
    taxonomy access M2-M4 declared and justified (`src/plugin/definition.ts:45-69`).
15. **Listing without `orderBy`.** Pages in creation order keep a stable cursor while rows are
    updated or deleted (F2); ordering by `updatedAt` or `name` would move rows between pages and
    break the cursor when its row is deleted. Admins and agents sort a page client-side; a template
    list is short.
16. **One jobs index and a version bump.** `["templateId", "createdAt"]` serves the only new jobs
    query; the docs require a version bump for new indexes and collections (F5), so 0.3.0.
17. **Every M6a route is MCP-ready.** POST, JSON in and out, a permission, not raw (F10), so M6c can
    expose `templates/list` as `list_templates` (and the others) without changing a route.
18. **The storage port gains `compareAndDelete`.** A revision-checked delete is the same guarantee
    as a revision-checked update; EmDash offers it (F3) and the port lacked it (P5).
19. **`schema/apply` takes a `templateId`.** It is how an imported template's missing fields are
    created on a new site; asking the caller to fetch and resend the template would be a needless
    round trip.
20. **Deleting a template does not look at jobs.** Jobs hold snapshots (Ruling 2), so nothing breaks;
    M6b adds the one reference that does matter (a schedule) and refuses the delete while a
    schedule names the template.
21. **Name rules.** Exact comparison as for sources; no leading or trailing whitespace and no
    control characters, because names are typed by agents and looked up exactly, and two names that
    differ only by a trailing space would be indistinguishable in a list.
22. **Site checks run without source columns.** A saved template has no source; `checkTemplate`
    already skips column checks for `columns: null` (P3), and `jobs/create` checks the columns of
    the actual source.

### Rulings on the M6 split (the parts after M6a)

23. **Order: templates, then schedules, then MCP tools, then suggestions.** A schedule runs a saved
    template (M6b needs M6a); the MCP tools wrap the template, job and schedule routes, so M6c comes
    after the routes it exposes exist, and an administrator consents to the tool list once (F-M3
    below: a changed tool list needs a new consent); suggestions produce a template that M6a saves
    and M6b and M6c run, and depend on nothing after them.
24. **Plugin MCP tools are supported, so M6c uses them as the roadmap planned.** EmDash 1.2.0 lets
    a plugin expose private JSON routes as MCP tools on the site MCP server (F-M1). No workaround is
    needed. M6c must plan for the administrator's enable step and the `mcp:tools` scope (F-M2,
    F-M3).
25. **There is no AI binding for plugins; M6d calls a provider's HTTP API.** No plugin capability
    and no `PluginContext` member gives access to Workers AI or any model (F-A1). The closest
    documented route is the roadmap's own decision: a provider API key in an encrypted `secret`
    setting (F9), called through `ctx.http` with `network:request` and the provider's host in
    `allowedHosts` (F-A2), so the network access is declared and limited. M6d also ships a
    deterministic suggester (header and field-name matching) that needs no key, so the route is
    useful when no key is set.
26. **Plugin cron is available, but its signature is documented only in source.** The docs name
    `ctx.cron.schedule()` and document the `cron` hook (F-C1); the parameters and semantics come
    from `emdash@1.2.0` source, which the retention task already relies on. M6b treats the source as
    authoritative, pins behaviour with tests, and proves the unknowns (F-C4, F-C5) in its Task 0.

## Outline of M6b-M6d

Recorded so that the split rests on evidence; each part's own spec settles its design against the
code and EmDash at that time.

### Facts for the later parts

| # | Fact | Evidence |
| --- | --- | --- |
| F-C1 | **Plugin cron API.** `ctx.cron` (`CronAccess`, typed optional but "always available, scoped to plugin") has `schedule(name, { schedule, data? })`, `cancel(name)` and `list()` (name, schedule, `nextRunAt`, `lastRunAt`). The `cron` hook receives `{ name, data?, scheduledAt }` and the plugin context, with no user. The docs name `ctx.cron.schedule()` and document the hook and its event, but not the method's parameters | `src/plugins/types.ts:1107-1152`; [hooks reference](https://docs.emdashcms.com/reference/hooks/#cron); `packages/flux-import/src/plugin/routes.ts:127-133` |
| F-C2 | **Schedules.** A task name is 1-128 characters of `^[a-zA-Z][a-zA-Z0-9_-]*$`; a schedule is a 5- or 6-field cron expression, an alias (`@daily`), or an ISO 8601 datetime for a one-shot, at most 256 characters, evaluated in UTC on every host; `schedule()` upserts per (plugin, name) and does not clobber a running task | `src/plugins/cron.ts:18-19`, `:259-287`, `:345-436` |
| F-C3 | **Execution.** Each tick claims at most 10 due tasks and runs them one after another in the same invocation; a recurring task's next run is computed from the tick's time; a failed hook leaves a recurring task idle for its next run and retries a one-shot up to 5 times with backoff (1-16 minutes); a task stuck `running` for 10 minutes is released. The hook runs under its configured `timeout` (flux-import uses 60 s), and a failure is thrown to the executor | `src/plugins/cron.ts:78-228`; `src/plugins/hooks.ts:1029-1061`; `src/emdash-runtime.ts:2187-2192`; `packages/flux-import/src/plugin/definition.ts:95-97` |
| F-C4 | **Drivers.** On Node a timer wakes at the next due task, at most every 60 s and at least 1 s apart. On Cloudflare tasks run only from the Worker's `scheduled()` Cron Trigger (`* * * * *` in `sites/dev-cf`). **To verify (M6b Task 0):** that the 1,000-query D1 limit (F6) counts once for the whole scheduled invocation, which then bounds all due tasks together (about one import batch a minute on Workers); the M2 production build blocker left `scheduled()` on a build unverified | `src/plugins/scheduler/node.ts:15-26`, `:62-103`; `src/emdash-runtime.ts:934-965`; [Cloudflare deployment](https://docs.emdashcms.com/deployment/cloudflare/#scheduled-publishing); `sites/dev-cf/wrangler.jsonc`; `docs/superpowers/notes/2026-10-08-m2-review.md:33` |
| F-C5 | **No caller in cron.** `withEmDashRuntime()` is fully trusted and usable from scheduled handlers ("the same trust level as plugin cron"); the content writes need an actor. **To verify (M6b Task 0):** storing the schedule creator's user ID as the actor, and re-checking that user's existence and role before each run, which needs `ctx.users` (`users:read`, a new capability to justify) | [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#calling-routes-from-queue-and-scheduled-handlers); `packages/flux-import/src/plugin/routes.ts:171-177`; `src/plugins/manifest-schema.ts:53` |
| F-M1 | **Plugin MCP tools.** `mcp.tools` entries map a local name to a private, permissioned, JSON POST route with a Zod `input` (required) and `output` (optional) and a `destructive` flag; EmDash registers them on `/_emdash/api/mcp` as `<pluginId>__<name>` (an "MCP-safe plugin prefix" per the docs; V6) and dispatches a call to the route with the MCP caller as `routeCtx.user`, writing an audit row | `src/plugins/types.ts:1949-1959`; `src/plugins/define-plugin.ts:160-176`; `src/mcp/server.ts:842-981`; `src/emdash-runtime.ts:5724-5800`, `:5844-5882`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#exposing-a-route-as-an-mcp-tool); [MCP server](https://docs.emdashcms.com/reference/mcp-server/#plugin-tools) |
| F-M2 | **Scopes and permissions.** A token call needs `mcp:tools` or `mcp:tools:flux-import`; the `admin` scope does **not** imply them. The route's permission (`import:execute`) is checked against the user's role | `src/mcp/server.ts:918-952`; `@emdash-cms/auth` `src/tokens.ts:46-70`, `:106-117` |
| F-M3 | **Consent.** Tools are listed only after an administrator (`plugins:manage`) enables the plugin's MCP surface; the consent is a snapshot of every tool's name, description, route, permission, flag and JSON schemas, so any change to the tool list or a schema disables the tools until consented again | `src/emdash-runtime.ts:5802-5842`; `src/astro/routes/api/admin/plugins/[id]/mcp.ts:13-41` |
| F-A1 | **No AI access for plugins.** The capability list has no AI or model capability and `PluginContext` has no AI member; the docs' AI pages cover MCP clients (AI tools guide) and the first-party AI Search plugin, which binds Cloudflare AI Search in its own configuration | `src/plugins/manifest-schema.ts:30-58`; `src/plugins/types.ts:1056-1112`; [AI tools](https://docs.emdashcms.com/guides/ai-tools/); [AI Search](https://docs.emdashcms.com/plugins/ai-search/) |
| F-A2 | **Network access.** `network:request` gives `ctx.http`, limited to `allowedHosts` declared in `definePlugin`. **To verify (M6d Task 0):** that `allowedHosts` is enforced for a native plugin's `ctx.http` as for a sandboxed one | `src/plugins/manifest-schema.ts:31-32`; `src/plugins/define-plugin.ts:134`; [plugins overview](https://docs.emdashcms.com/plugins/overview/) "Call external APIs" |

### M6b, scheduled URL imports

A `schedules` collection: a saved template ID, a URL source ID, a cron expression (validated with
F-C2's rules, UTC), the job options (`publish`, `batchSize`, `budgetMs`, `journal`, `missing`),
`enabled`, the actor's user ID, and the last run's job, outcome and time. One recurring cron task
per schedule (`schedule-<id>`) only fetches the source and creates the job (`jobFromSource`, whose
`lastImport` skip already avoids a second job for unchanged content, M5a); a single recurring
`pump` task advances running scheduled jobs one batch at a time within the tick's budget (F-C3,
F-C4). A run is skipped while the schedule's previous job is still running; a refused missing
phase (`Job.missing.verdict === "refused"`, M5c Ruling 6) or repeated failures pause the schedule
with a reason. Deleting a template named by a schedule is refused (Ruling 20). Acceptance: a
scheduled import runs unattended on Node and on `sites/dev-cf`.

### M6c, MCP tools

Tools over the existing routes: `list_templates` (`templates/list`), `dry_run` (`jobs/create` with
`dryRun: true`), `start_import` (`jobs/create`, `destructive: true`), `import_status` (`jobs/get`,
read-only), plus the step an agent needs to drive a job, since a job advances only through
`jobs/next` (M2): either a `next_batch` tool or a driver route, decided in M6c's spec. An agent
cannot stream an upload over MCP, so its sources are URL sources and pasted text (`sources/paste`,
1 MiB). Tool inputs use `templateId` rather than an inline template where possible, since the inline
template's schema is `z.unknown()` and gives an agent no guidance. The administrator's enable step,
the scopes (F-M2) and the re-consent after any tool change (F-M3) are documented. Acceptance: an
agent completes an import over MCP.

### M6d, AI mapping suggestions

A `mapping/suggest` route takes a staged upload (or a sample) and a collection and returns proposed
`fields` mappings with a reason per field; with a provider key in a `secret` setting it asks the
provider through `ctx.http` (Ruling 25), sending only the headers, at most a few sample rows and the
field list, and without a key it returns the deterministic suggestions. The result is a template the
caller saves with M6a or passes to `jobs/create`; nothing is written by the route.

## Out of scope for M6a

A template history (jobs keep the revisions they ran); a `templates/duplicate` route (export and
import, or get and create, do it); several templates in one file; signed or encrypted export
files; per-template permissions (every route is Admin); a default `rules.owner` (Ruling 7); storing
site-check results; job options, sources or schedules in a template (Ruling 12, M6b); bounding inline
`jobs/create` templates beyond the 1 MiB body limit; MCP tools, schedules and suggestions (M6b-M6d);
the admin screens (M7); the template format reference in the README, with M5c's owner text (M8).

## Open issues

- **Name race.** Two simultaneous creates or imports with one name both succeed; name lookups then
  report `AMBIGUOUS_NAME` until an administrator renames one (Ruling 5).
- **Stale site checks.** A template saved without problems can acquire them when the schema changes;
  they surface at the next save or at `jobs/create`, not on `templates/get`.
- **Shared owners outside saved templates.** The warning sees only saved templates; an inline
  template in `jobs/create` with the same owner is not compared (M5c's guards still apply).
- **Plain-text templates.** Template bodies are not encrypted and are copied onto every job; an
  expression that embeds a secret would be stored in clear. Documented, not prevented.
- **Unsigned files.** An imported file is validated, not authenticated; an administrator importing a
  file from elsewhere trusts its mappings and rules, as with a template pasted into `jobs/create`.
- **Dangling `templateId`.** Jobs of a deleted template keep its ID; `templates/get` on it is 404.
- **Downgrades.** A row saved by a newer plugin version with keys this version does not know can be
  listed, read and exported, but `jobs/create` and `schema/apply` refuse it until it is updated.
- **From M5c** (`2026-11-12-m5c-review.md`), unchanged: the open issues of the M5c spec and review,
  the version mismatch between `package.json` and `FLUX_IMPORT_VERSION` until M8, the known flakes
  (F1, F2, F3 on port 4397), and the production Cloudflare build blocker from M2.
