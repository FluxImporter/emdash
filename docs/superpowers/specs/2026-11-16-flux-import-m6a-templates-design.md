# Flux Import M6a: saved templates, JSON export and import

Status: drafted 2026-11-16 (the user approved all remaining milestones up front on 2026-10-27;
design decisions are the implementer's rulings). Revised the same day after the spec review
(Rulings 27-47; amended rulings are marked), and amended after implementation to match the code
(Rulings 48-57, "Amendments after implementation"). First of four parts of Milestone 6 (Automation) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-6-split), in the order M6a, M6c,
M6b, M6d (Ruling 35). Builds on M5c
([spec](./2026-11-12-flux-import-m5c-missing-entries-design.md),
[review](../notes/2026-11-12-m5c-review.md)), merged at `74ec874`. The later parts (M6c MCP tools,
M6b scheduled URL imports, M6d AI mapping suggestions) are outlined at the end, with the EmDash
facts that decide their feasibility, so that the split and its order rest on the same evidence as
this part.

## Goal

Today a template exists only inside the `jobs/create` request that uses it, and inside the job that
request creates (`src/plugin/routes.ts:246-269`, `src/engine/jobs.ts:142-150`, `:246`). M6a gives
templates a life of their own:

- **Saved templates.** An administrator (or, from M6c, an agent) creates, lists, reads, updates and
  deletes named templates. Each one has a stable ID and a revision number that moves on every
  change.
- **Validation in two levels.** Saving refuses a template that could never run anywhere: the
  checks that depend only on the template (Ruling 27). Checks against the site (collection, fields,
  taxonomies, locales, source columns) are run and **reported**, not refused, so a template can be
  saved before its fields exist, or imported from another site and fixed afterwards with
  `schema/apply`.
- **Export and import.** A saved template is exported as one JSON document in a versioned envelope
  that holds nothing site-specific beyond the template itself, and a document of that format is
  imported as a new saved template, on the same site or another, with an owner check that keeps an
  imported copy from taking over another feed's entries (Ruling 30).
- **Jobs from saved templates.** `jobs/create` takes a `templateId` instead of an inline
  `template`. The job keeps a snapshot of the template as it was, and records the template's ID and
  revision; editing or deleting the template never changes a job. `jobs/list` filters by template,
  and `schema/apply` takes a `templateId` too.

An inline `template` keeps working as in M5c: the same checks, error codes and limits (the
256 KiB cap and `UNSUPPORTED_TEMPLATE_VERSION` apply to the template routes only, Ruling 28). One
behaviour changes for every job created from a URL source, inline or saved: the "unchanged content"
skip now also requires the same template (Ruling 29). A job made from a saved template behaves
exactly like one made from the same template inline. The template format stays `version: 1`
(roadmap, "Template v1").

## Non-goals

Schedules and the job options a schedule would carry (M6b); MCP tools (M6c); mapping suggestions
(M6d); the admin screens (M7); a template history beyond the current revision; lookup by name;
duplicating a template in one call; exporting several templates in one file; signed export files;
per-template permissions; a default `rules.owner`; bounding inline templates in `jobs/create`
beyond today's body limit. See "Out of scope" for the reasons.

## Decisions

| Topic | Decision |
| --- | --- |
| Where | A new plugin storage collection `templates`, one document per saved template, keyed by ULID. Not plugin settings (admin-form values, no queries) and not KV (no indexes; `list` loads every key) (F1, F9, Ruling 1). |
| Row | Name, optional description, the parsed template, a `revision` number, timestamps and user IDs, and four fields copied from the template for queries and listings: `collection`, `locale`, `owner`, `format` (Storage). |
| Validation | **Shape** (`templateShapeProblems`: the schema, the site-independent checks moved out of `checkTemplate`, expressions, source block) refuses with `INVALID_TEMPLATE`. **Site checks** (what is left of `checkTemplate`, without source columns, plus locales and the owner warnings) are returned as `check: { problems, warnings }` and never refuse a save. `jobs/create` runs both, as today (Rulings 4, 27). |
| Names | 1-100 characters after NFC normalisation, no leading or trailing whitespace, no control or format characters (`\p{Cc}`, `\p{Cf}`), unique among saved templates by a check before the write, as URL sources do. No `uniqueIndexes` (F4, Rulings 5, 38, 43). |
| Concurrency | Every update and delete names the `revision` it read; a different current revision is `409 TEMPLATE_CHANGED`. The write itself is a storage compare-and-set (or compare-and-delete), so a change that lands between the read and the write also gives 409 (F3, Rulings 6, 37). |
| Jobs | `jobs/create` takes exactly one of `template` and `templateId` (with an optional expected `templateRevision`). The job stores the template it parsed, as today, plus `templateId` and `templateRevision`, which a rollback job copies. Resume, retry, the missing phase and rollback read the job's copy only (Rulings 2, 41). |
| URL sources | `lastImport` records the template (`templateId` and `templateRevision`, or a fingerprint of an inline template); a real run is skipped as unchanged only when the content hash **and** the template match (Ruling 29). |
| Export | `templates/export` returns `{ filename, file }` as an ordinary JSON route response, where `file` is `{ format: "flux-import.template", formatVersion: 1, exportedAt, generator, name, description?, template }`. No IDs, user IDs, site URL, sources, credentials or job options (Rulings 8, 9). |
| Import | `templates/import` takes `{ file, name?, owner? }` and always creates a new saved template. A taken name is `409 NAME_TAKEN` unless `name` overrides it. A template with `rules.missing` whose owner already owns entries or is used by another saved template is `409 OWNER_IN_USE` unless `owner` overrides it. Replacing an existing template is `templates/update` with the file's `template` (Rulings 10, 30). |
| Versions | Two numbers: the file envelope's `formatVersion` and the template's `version`, both 1. An unknown value of either is refused on the template routes with its own code; unknown keys inside the template are refused (strict schema), unknown envelope keys are ignored. No migration code until a version 2 exists (Rulings 11, 28). |
| Size | A saved template's JSON is at most `TEMPLATE_MAX_BYTES` (256 KiB, UTF-8), checked on create, update and import only (F3, Rulings 13, 28, 39). |
| Owner | No default `rules.owner`. Create and update warn when the owner is used by another saved template with the same collection and locale, or already owns entries there; import refuses in those cases for a template with `rules.missing` (Rulings 7, 30). |
| Capabilities | None added. Templates live in plugin storage, which needs no capability; the site checks read the schema through the trusted runtime and taxonomies through `ctx.taxonomies`, both already declared (F12, Ruling 14). |
| Version | `FLUX_IMPORT_VERSION` goes from 0.2.0 to 0.3.0: M6a adds a storage collection and a `jobs` index (F5, Ruling 16). |

## EmDash facts this design relies on

Checked on 2026-11-16 against `emdash@1.2.0` (package `src/`, cited as file:line), the docs
(`emdash-docs` MCP and the pages it returns) and the Cloudflare D1 docs, and confirmed by the spec
review. M5c's facts (F1-F16) and the earlier parts' still hold. All are **confirmed** from source
or docs unless marked otherwise; the unconfirmed ones are listed under "To verify in Task 0".

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | **Plugin storage collections.** A collection declared in `definePlugin({ storage })` offers `get`, `put`, `delete`, `exists`, `getVersioned`, `compareAndSet`, `compareAndDelete`, `getMany`, `putMany`, `deleteMany`, `query` (always paginated), `count`, and `updateIf` (a predicate-guarded single-statement update of an existing row's fields, never an insert; M6a does not use it). Collections are scoped to the plugin; native plugins declare them in `definePlugin()` | `src/plugins/types.ts:271-319` (`updateIf` `:296-311`); [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Collection API", "How collections are isolated" |
| F2 | **Queries.** `limit` is 1-100 (default 50); `where` and `orderBy` fields must appear in a declared index (each field of a composite counts); without `orderBy` pages follow `(created_at, id)` and the cursor carries both values, so it survives rewrites and deletes; with `orderBy` the cursor re-reads its row, which must still exist. A query returns whole documents: there is no projection | `src/database/repositories/plugin-storage.ts:357`, `:354-473`; M5c F10, F11; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Index design" |
| F3 | **Conditional writes.** `compareAndSet(id, null, v)` creates only when absent; with a revision it replaces only when the stored revision matches; a failed precondition is `{ applied: false }`. `compareAndDelete(id, revision)` deletes only at that revision. Conditional writes take a JSON value of at most 1 MiB (UTF-8) and keys of at most 1,024 characters; the docs state no size limit for a plain `put`. flux-import writes jobs with `compareAndSet` (`updateJob`) | `src/plugins/conditional-storage.ts:1-30` (`:3`, `:26-27`); `src/plugins/types.ts:279-285`; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Conditional writes"; `packages/flux-import/src/engine/jobs.ts:344-360` |
| F4 | **Unique indexes.** `uniqueIndexes` exist and in 1.2.0 create `CREATE UNIQUE INDEX … ON _plugin_storage(plugin_id, collection, …)`, non-partial. The error a duplicate `put` raises is **not documented**. The docs describe a later release whose migration `095_plugin_storage_unique_scope` makes unique indexes "enforce uniqueness only in the plugin and collection that declares them", warn that an older instance "can recreate the non-partial indexes and restore the cross-collection constraint", and require a maintenance window (no rolling deploy) on every site with a plugin unique index. The docs' account of the old indexes as cross-collection is not visible in the 1.2.0 source, whose leading `(plugin_id, collection)` columns scope them; either way the upgrade cost stands. 1.2.0's migrations end at `091` | `@emdash-cms/plugin-types@0.6.0` `dist/index.d.ts:803-818`; `src/plugins/storage-indexes.ts:72-81`; `src/database/migrations/` (last `091_redirect_artifacts.ts`); [updating](https://docs.emdashcms.com/deployment/updating/) "Fixed: plugin storage uniqueness" |
| F5 | **Adding a collection or index.** EmDash creates declared indexes when the plugin loads (once per process, from the scheduler path); a missing physical index slows a query but never fails it. The docs ask for a version bump whenever an index is added, removed or changed | M5c F11; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Adding indexes" |
| F6 | **D1 limits.** Row, string or BLOB at most 2,000,000 bytes; 100 bound parameters per query; 1,000 queries per Worker invocation on the paid plan and 50 on the free plan; an SQL statement of at most 100,000 bytes. Whether a bound value counts toward the statement length is **not stated** (V1) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| F7 | **Route bodies.** A plugin route's JSON body defaults to at most 1 MiB, and a route may raise it to 8 MiB with `request: { body: "json", maxBytes }` | `@emdash-cms/plugin-types@0.6.0` `dist/index.js:4-5`; `packages/flux-import/src/plugin/routes.ts:343-355` (`sources/paste`). *Amended by Ruling 51*: the default applies only to a route that declares `request` |
| F8 | **Private routes.** They require their declared `permission`; cookie-authenticated calls need `X-EmDash-Request: 1` (all methods); token calls are exempt from the header but need the `admin` scope and the permission. `routeCtx.user` is the authenticated caller | [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/) "Authentication and CSRF", "The authenticated caller"; roadmap "Permissions" |
| F9 | **Settings and KV.** `ctx.settings` and `ctx.kv` offer `get`, `getVersioned`, `compareAndSet`, `compareAndDelete`, `set`, `delete` and `list(prefix?)`; no index or paged query. Settings are for user-configurable values (secret ones encrypted with `EMDASH_ENCRYPTION_KEY`), KV for internal state and caches; queryable records belong in storage | `src/plugins/types.ts:335-363`; [settings](https://docs.emdashcms.com/plugins/creating-plugins/settings/) "Read and write settings", "Secret values"; [storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/) "Storage vs content vs KV" |
| F10 | **Routes that can become MCP tools.** `definePlugin` accepts `mcp.tools`, each `{ description, route, input, output?, destructive? }`, and refuses a tool whose route is unknown, public, `response: "raw"`, not a POST-compatible JSON route, or without `permission`. So a raw route (such as `jobs/log.csv`) can never be a tool, and every M6a route must stay a JSON POST with a permission | `src/plugins/types.ts:1949-1959`; `src/plugins/define-plugin.ts:160-176`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/) "Exposing a route as an MCP tool"; `packages/flux-import/src/plugin/routes.ts:310-326` |
| F11 | **IDs.** `ulid()` is exported from `emdash` (re-exported from `ulidx`); job and source IDs already use it | `packages/flux-import/src/plugin/routes.ts:3`, `:198`, `:213`; M5c F15 |
| F12 | **Capabilities.** Plugin storage, settings, KV and cron need no capability; `schema:read` and `taxonomies:write` (already declared) cover `ctx.schema` and `ctx.taxonomies`; there is no capability for plugin storage itself | `src/plugins/manifest-schema.ts:30-58`; `src/plugins/types.ts:1056-1112`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/); `packages/flux-import/src/plugin/definition.ts:60-69` |

### Facts about flux-import's own code

| # | Fact | Evidence |
| --- | --- | --- |
| P1 | **Templates are inline today.** `jobs/create` takes `template: z.unknown()`; `createJob` parses it with `templateSchema` (strict, `version: z.literal(1)`) and stores the parsed value on the job. `schema/apply` takes an inline `template` too | `src/plugin/routes.ts:246-269`, `:284-295`; `src/engine/jobs.ts:139-150`, `:235-251`; `src/engine/template.ts:332-394`; `src/plugin/schema-apply.ts:400-431` |
| P2 | **What a job reads later.** Resume, retry, the missing phase and rollback read `job.template`, through `jobTemplate` where the source block matters (it fills the CSV source of jobs stored before M3a); nothing re-reads a request's template. A rollback job copies `template` from its original and nothing else of it | `src/engine/jobs.ts:339-342`; `src/engine/batch.ts:930-1003`; `src/engine/owner.ts:10`; `src/engine/revert.ts:163`; `src/engine/journal.ts:44`; `src/engine/rollback.ts:118-126` |
| P3 | **The template's checks today.** Shape: `templateSchema` with the `rules` refinement (`rules.missing` needs `rules.owner`); `compileTemplate` (JSONata compiled, not evaluated); `checkSource`. Then `startJob` reads the collection's fields, reference targets' fields and taxonomy definitions and resolves locales, and `checkTemplate(t, fields, columns, siteTimezone, links)` mixes site checks with checks that need no site: `pathProblem` for JSON and XML paths, the image/file cap (`MAX_MEDIA_MAPPINGS` 5), the portableText cap (`MAX_PORTABLE_TEXT_MAPPINGS` 3), `translationOf.locale` equal to `locale`, and `rulesProblems` | `src/engine/template.ts:293-315`, `:1342-1425` (`:1351-1373`, `:1416-1423`), `:1445-1467`; `src/engine/jobs.ts:182-215`; `src/plugin/service.ts:226-321`; `src/engine/media.ts:15`; `src/engine/portable-text.ts:20` |
| P4 | **The URL-source precedent.** Source names are unique by a `query({ where: { name } })` before the write (`assertNameFree`), updates are compare-and-set loops on the newest row, and the race between the check and the write is accepted | `src/plugin/sources.ts:119-124`, `:174-211` |
| P5 | **The storage port.** `KvCollection` has `get`, `put`, `delete`, `deleteMany`, `getVersioned`, `compareAndSet` and `query`, but no `compareAndDelete`; `MemoryKv` (the unit fake) mirrors it | `src/engine/ports.ts:5-24`; `src/emdash/storage.ts:19-37`; `tests/unit/fakes.ts:76-134` |
| P6 | **Job listing.** `jobs/list` filters by `status` and orders by `createdAt` descending; `jobs` is indexed on `status`, `createdAt`, `uploadId`, `sourceUploadId` | `src/plugin/routes.ts:476-483`; `src/plugin/service.ts:438-451`; `src/plugin/definition.ts:22-23` |
| P7 | **Retention.** The daily task deletes expired jobs with their rows and staged files; it reads no other collection, so saved templates are kept forever | `src/plugin/retention.ts:47-116`; `src/plugin/definition.ts:95-112` |
| P8 | **Version.** `FLUX_IMPORT_VERSION` is 0.2.0 (M5c bumped it for its `links` index); `package.json` stays 0.1.0 until M8 | `src/meta.ts:2`; M5c review "Versions" |
| P9 | **The unchanged-content skip ignores the template.** `jobFromSource` skips a real run without `force` when the fetched hash equals `lastImport.sha256`; `LastImport` holds `sha256`, `uploadId`, `jobId`, `at`. So a second template on the same source, or the same template after an edit, is skipped while the content is unchanged | `src/plugin/sources.ts:38-43`, `:406-429` (`:414`) |
| P10 | **Links by owner.** Link rows carry `owner` (M5c) in the site's casing of the locale the job resolved, and `links` is indexed on `["owner", "collection", "locale"]` | `src/plugin/definition.ts:33-34`; M5c "Owner"; `src/plugin/service.ts:226-264` |
| P11 | **Record keys a template accepts.** `fields` and `taxonomies` keys are checked against slug patterns, but a select or multiSelect `map` (`optionMap`) is a record with any key of 1-200 characters, `__proto__` included | `src/engine/template.ts:98-100`, `:349-386` |
| P12 | **Fingerprints.** `stableJson` gives a canonical JSON string and `fingerprint` a SHA-256 of it with Web Crypto, on Node and workerd | `src/engine/fingerprints.ts:24-55` |

### To verify in Task 0

Each item is proven on Node (SQLite) and workerd (D1) through a temporary probe route, as in M5a-M5c.

- **V1. A large template row on D1.** `put`, `get` and `compareAndSet` of a `templates` row whose
  template is 256 KiB of JSON, and `compareAndSet` of a job row holding it, work on D1 and SQLite
  (F3, F6: whether a bound value counts against the 100 KB statement limit is not stated). If not,
  `TEMPLATE_MAX_BYTES` is lowered to the largest size that works, with a margin, and this spec is
  amended.
- **V2. The new collection and index on an upgraded site.** On a site with M5c data, after the
  upgrade: `templates.query({ where: { name } })`, `templates.query({ where: { owner, collection } })`
  and `jobs.query({ where: { templateId }, orderBy: { createdAt: "desc" } })` validate at once; the
  physical indexes appear after the next scheduler tick (F5); jobs saved without `templateId` are
  not matched.
- **V3. Parsing is idempotent.** For every template fixture in the unit and integration suites,
  `templateSchema.parse(templateSchema.parse(t))` deep-equals `templateSchema.parse(t)` (defaults
  such as `source` are applied once, nothing is dropped), so storing the parsed form and parsing it
  again at job creation changes nothing (Ruling 3).
- **V4. `compareAndDelete`.** At a stale revision it returns `{ applied: false }` and deletes
  nothing, on SQLite and D1 (F3); the revision `getVersioned` returns is the one it takes.
- **V5. Route budget.** For each M6a route: the D1 queries **and the bytes read** (the summed JSON
  size of the documents its storage calls return), with the site checks on a collection with a
  reference field and two taxonomies, and `templates/list` on a page of 8 templates of 256 KiB.
  Each route stays under 50 queries (the free plan's limit, F6) and about 2 MiB read: measured,
  not projected.

If V1 or V3 fail, the plan stops and this spec is amended before Task 1. (The MCP tool name check
that was V6 moved to M6c, Ruling 44.)

## Storage

```ts
// STORAGE gains (src/plugin/definition.ts):
//   templates: { indexes: ["name", "collection", "owner"] },
//   jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId", ["templateId", "createdAt"]] },

interface SavedTemplate {
	id: string;              // ULID, also the storage key
	name: string;            // NFC, see "Names"
	description?: string;    // at most 2,000 characters
	template: Template;      // templateSchema's output (defaults applied), Rulings 3, 42
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
//   (copied into rollback jobs, Ruling 41)
// CreateJobInput gains: savedTemplate?: { id: string; revision: number }
// LastImport gains (src/plugin/sources.ts): template?: { id: string; revision: number }
//   | { fingerprint: string }   (Ruling 29)
// KvCollection gains: compareAndDelete(id, expectedRevision): Promise<{ applied: boolean }> (P5)
```

- **Indexes.** `name` serves the uniqueness check; `collection` the listing filter; `owner` (with
  `collection`) the shared-owner warning. Nothing orders by a field, so no `updatedAt` index
  (Ruling 15). The jobs index `["templateId", "createdAt"]` serves `jobs/list { templateId }`
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
| `templates/list` | `{ collection?, cursor? }` | `{ items: TemplateSummary[], cursor?, hasMore }`, `TEMPLATE_PAGE` (8) a page, creation order (Ruling 32) |
| `templates/get` | `{ id }` | `SavedTemplate` |
| `templates/create` | `{ name, description?, template }` | `{ template: SavedTemplate, check }` |
| `templates/update` | `{ id, revision, name?, description?: string \| null, template? }`, at least one change | `{ template: SavedTemplate, check }` |
| `templates/delete` | `{ id, revision }` | `{ deleted: true }` |
| `templates/export` | `{ id }` | `{ filename, file: TemplateFile }` |
| `templates/import` | `{ file, name?, owner? }` | `{ template: SavedTemplate, check }` |
| `jobs/create` | as today, plus `templateId?`, `templateRevision?`; exactly one of `template` and `templateId` | job (as today) |
| `jobs/list` | as today, plus `templateId?` | page of jobs, rollback jobs included (Ruling 41) |
| `schema/apply` | as today, plus `templateId?`; exactly one of `fields`, `template` and `templateId` | as today |

`check` is `{ problems: string[], warnings: string[] }` (see "Validation"). `templates/get` and
`templates/export` return the row as stored, without running checks. There is no lookup by name
(Ruling 43).

### Errors

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | The route input fails its Zod schema (EmDash's route validation), including names, descriptions and the `owner` override out of bounds |
| `INVALID_TEMPLATE` | 400 | Shape validation fails; `details.problems` lists `path: message` for every issue, as `jobs/create` does. Also a template that is not an object, has no `version`, or a `version` that is not a number (`"1"` included) (Ruling 28) |
| `UNSUPPORTED_TEMPLATE_VERSION` | 400 | Template routes only: `template.version` is an integer other than 1: "This template has format version <n>; this version of flux-import reads version 1" |
| `INVALID_FILE` | 400 | `templates/import`: the file is not an object, or `format` is not `"flux-import.template"`, or a required envelope field is missing or out of bounds |
| `UNSUPPORTED_FILE_VERSION` | 400 | `formatVersion` is an integer other than 1: "This file was written by a newer flux-import (file format <n>, generator <version>); this site reads file format 1" |
| `TEMPLATE_TOO_LARGE` | 413 | Template routes only: the parsed template's JSON is over `TEMPLATE_MAX_BYTES` |
| `NOT_FOUND` | 404 | No template with that ID (`jobs/create`, `schema/apply`: `TEMPLATE_NOT_FOUND`) |
| `NAME_TAKEN` | 409 | Another saved template has the name; `details.id` names it |
| `OWNER_IN_USE` | 409 | `templates/import` without `owner`: the template has `rules.missing`, and its owner already owns entries in its collection and locale or is used there by another saved template; `details` names the template IDs and whether links exist |
| `TEMPLATE_CHANGED` | 409 | The current revision is not the one named (update, delete, `jobs/create` with `templateRevision`), or a write landed between the read and the compare-and-set or compare-and-delete; `details.revision` is the current revision when known |

## Names

- Normalised to NFC first; the normalised form is what is checked, compared and stored. Then 1-100
  characters, refused when they start or end with whitespace or contain a control or format
  character (`/[\p{Cc}\p{Cf}]/u`, which covers zero-width and bidirectional marks). Compared exactly
  (case-sensitive), as source names are (P4) (Ruling 38).
- **Unique by check.** Create, import and a rename query `templates` by the normalised `name`
  (limit 2) and refuse `NAME_TAKEN` when another row has it, then write. Two creates of the same
  name at the same moment can both pass the check; the result is two rows with one name, which the
  listing shows and an administrator renames. Nothing looks a template up by name, so the race
  never makes a request ambiguous (Rulings 5, 43).

## Validation

### Shape (refuses)

`templateShapeProblems(input)` is the one function every template check runs first: `jobs/create`
(through `createJob`), `schema/apply`, and the template routes. It returns the parsed template or
problems, and contains exactly:

1. `templateSchema.safeParse` (strict; the `rules` refinement included), every issue as
   `path: message` (P1, P3).
2. A walk of the parsed template refusing any object key `__proto__`, at any depth
   (`<path>: "__proto__" is not allowed as a key`); only select and multiSelect `map` keys can
   reach it, since the other records have slug patterns (P11, Ruling 36). *Amended by Ruling 48*
   (the walk reads the raw input).
3. `pathProblem` for every path of a JSON, JSON Lines or XML template (`templatePaths`); CSV and
   XLSX column names are checked against the source's columns, which is a site check.
4. At most `MAX_MEDIA_MAPPINGS` (5) image and file fields and `MAX_PORTABLE_TEXT_MAPPINGS` (3)
   portableText fields.
5. When `translationOf.locale` is set, it differs from `locale` (case-insensitive).
6. `rulesProblems` (mode and `updateFields` conflicts).
7. `compileTemplate` (expressions compiled, never evaluated).
8. `checkSource` (which formats take `records`, `sheet`, `headerRow`).

Steps 3-6 move out of `checkTemplate`, which no longer reports them, so nothing is reported twice
(Ruling 27). Every problem refuses with `INVALID_TEMPLATE`; `checkSource` problems keep their own
`invalid_source` code in `jobs/create`. A template that passes this function can run on a site
whose schema and source fit it: every check left depends on the site or the source.

On the template routes only (Ruling 28), two checks come around it:

- **Before:** when `template` is an object (not an array) and `version` is an integer other than 1,
  `UNSUPPORTED_TEMPLATE_VERSION`. A non-object template, a missing `version`, and a non-number
  `version` (`"1"` included) fall through to step 1, which reports `INVALID_TEMPLATE` with the path
  (`template` or `version`).
- **After:** the UTF-8 length of `JSON.stringify(parsed)` is at most `TEMPLATE_MAX_BYTES`, else
  `TEMPLATE_TOO_LARGE`.

`jobs/create` with an inline template keeps today's codes, messages and limits: version 2 is
`INVALID_TEMPLATE` from the schema, and the only size bound is the 1 MiB route body (F7). Its
shape and site problems are reported together in one `invalid_template` error, "The template does
not fit the source or schema", as today; the set of problems is the same as in M5c, only their
order may differ. *Amended by Rulings 50 and 51* (M5c's separate refusals are kept; the body
limit is a declared 2 MiB).

### Site checks (reported)

After the shape checks pass, the template routes run the checks that need the site but no source
(P3), and return them as `check`:

- **problems** (would refuse `jobs/create`): the locale and `translationOf.locale` not resolvable
  on the site (`resolveSiteLocale`, `resolveTranslationLocale`), and `translationOf.locale` not set
  where the site has no default to fill it; the collection missing; what remains of
  `checkTemplate(t, fields, null, siteTimezone, linkSchema)`: missing fields, incompatible types,
  unknown or unattached taxonomies, required fields not mapped, unreadable field types, an invalid
  site timezone for `publishAt`. With `columns: null` it skips the CSV and XLSX column checks
  (Ruling 22).
- **warnings** (never refuse on create and update): `linkWarnings`, `translationWarnings`, and the
  two **owner** warnings, when `rules.owner` is set (Rulings 7, 30, 31):
  - *Another saved template*: `templates.query({ where: { owner, collection }, limit: 100 })`, every
    other row with the same `locale` gives "Saved template <name> (<id>) uses the same owner <owner>
    for <collection>/<locale>: the two act as one import, and each one's missing phase treats the
    other's entries as its own; give each feed its own owner".
  - *Existing entries*: with the locale resolved as `jobs/create` resolves it (the site's casing,
    P10), `links.query({ where: { owner, collection, locale }, limit: 1 })`; a row gives "Owner
    <owner> already owns entries in <collection>/<locale>: this template will treat them as its own
    (and with rules.missing may trash or unpublish the ones its feed lacks)". When the locale does
    not resolve, this check is skipped (the locale is already a problem).
- **Import** turns the owner warnings into a refusal for a template with `rules.missing`, unless
  the request gives `owner` (see "Export file format").

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
  and constants. A media mapping's `baseUrl` is part of the template and is exported as written,
  so a token in its query string or an internal host travels with the file (Security, Ruling 40).
- **`templates/import`** reads the envelope by picking its known keys (`format`, `formatVersion`,
  `name`, `description`, `template`; `exportedAt` and `generator` only for messages, not trusted)
  and ignores every other key, without copying or spreading the object (Ruling 36). It checks
  `format` (exactly `"flux-import.template"`, else `INVALID_FILE`) and `formatVersion` (1; another
  integer is `UNSUPPORTED_FILE_VERSION`, anything else `INVALID_FILE`), then:
  1. The template-route checks on `template` (version, shape, size).
  2. With `owner` given: `owner` must match `OWNER_PATTERN` and replaces `rules.owner` (added when
     the template had none). An override is checked like any owner and only warned about: naming
     an owner explicitly is the operator's decision, including keeping the same one to move a feed
     between environments (Ruling 30).
  3. Without `owner`, for a template with `rules.missing`: the two owner checks of "Site checks";
     either finding is `409 OWNER_IN_USE`. Without `rules.missing` they are warnings.
  4. The name check (on `name` when given, else `file.name`), `NAME_TAKEN` on a clash.
  5. The other site checks, returned as `check`; a row with revision 1 is created, `createdBy` the
     importer.

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
- **Defaults are frozen at save.** The stored template is the schema's output, so the defaults in
  force when it was saved (today only `source: { format: "csv" }`) are written into it. A later
  plugin version that changed a default would not change saved templates; it would have to bump
  `version` or upgrade them in `readSavedTemplate` (Ruling 42).

## Jobs from saved templates

- **`jobs/create { templateId, templateRevision?, … }`.** The route reads the row first (404
  `TEMPLATE_NOT_FOUND`; with `templateRevision`, a different revision is `TEMPLATE_CHANGED`), then
  proceeds exactly as with `template: row.template`: the site timezone and `publishAt` collection
  reads, `fetchLimitsFor`, `startImport`, `jobFromSource` for a `sourceId` (`src/plugin/routes.ts:
  409-461`). Setting both `template` and `templateId`, or neither, is `VALIDATION_ERROR`.
- **The job's snapshot.** `createJob` stores the template it parsed, as today, plus `templateId`
  and `templateRevision`. A later update or delete of the template changes no job: resume, retry,
  the missing phase and rollback read `job.template`, through `jobTemplate` as today (P2,
  Ruling 2). The revision on the job says which version of the template it ran.
- **Rollback jobs** copy `templateId` and `templateRevision` from their original, beside the
  `template` they already copy (`src/engine/rollback.ts:118-126`), so `jobs/list { templateId }`
  lists a template's imports and their rollbacks (Ruling 41).
- **`jobs/list { templateId }`** returns that template's jobs newest first; with `status` too, both
  filter.
- **`schema/apply { templateId }`** reads the row and plans from `row.template` as from an inline
  template (`src/plugin/schema-apply.ts:400-431`); `collection`, when given, must still match.
- **Owner and missing.** A job from a saved template uses its `rules.owner` and `rules.missing` as
  written; nothing defaults the owner to the template ID (Ruling 7).

### The unchanged-content skip (Ruling 29)

`jobFromSource` skips a real run without `force` when the fetched content equals the last
imported one (P9). That ignored the template, so a second template on the same source, or a
template edited to map a new field, was skipped while the feed was unchanged. Now:

- `lastImport` gains `template`: `{ id, revision }` for a job from a saved template, or
  `{ fingerprint }` for an inline one, where `fingerprint` is `fingerprint(stableJson(parsed))`
  of the parsed template (P12), computed in the route before the fetch. *Amended by Ruling 49*
  (`fingerprint(parsed)`).
- The skip needs `sha256` equal **and** `template` equal (same `id` and `revision`, or the same
  `fingerprint`). Anything else creates the job. A `lastImport` saved before M6a has no `template`
  and never matches, so the first run of each source after the upgrade creates its job once.
- An inline template that does not parse has no fingerprint and is never skipped; `createJob`
  reports it.
- `lastImport` still names one job (the newest real one); two templates alternating on one source
  each create a job every time, which is the correct result, since each must import the content.

## Security

- **Who.** Every route requires `import:execute` (Admin, `src/plugin/routes.ts:71`); token callers
  need the `admin` scope; cookie callers send `X-EmDash-Request: 1` (F8). `createdBy` and
  `updatedBy` come from `routeCtx.user`, never from the body. M6c adds the MCP path, which keeps the
  route permission (Outline).
- **Imported files are untrusted input.** The envelope is read by known keys; the template goes
  through the same strict schema, expression compilation and source checks as `jobs/create`, a
  `__proto__` key walk (P11) and a size bound. Expressions are compiled, never evaluated, on save
  and import; they are evaluated only by a job, under M3b's limits, as today.
- **Ownership.** An imported or copied template with `rules.missing` cannot silently take over an
  owner that already has entries or another saved template (`OWNER_IN_USE`), because its missing
  phase could trash or unpublish them (M5c "Template documentation", Ruling 30).
- **No secrets in templates.** URL credentials stay in the encrypted `credentials` setting and are
  referenced by URL sources, not by templates; a template body is stored in plain JSON in plugin
  storage and copied onto every job. The docs for M8 state that a template must not hold secrets
  (an expression can hold any string). An export file carries no credential, credential name,
  source URL, user ID or site URL (Ruling 9). **A media `baseUrl` is the exception to watch:** it
  is a URL the template author typed and is exported as written, so a token in it, or an internal
  host name, goes into every export file. The M8 docs say so; the importer does not rewrite it
  (Ruling 40).
- **No SQL, no content queries.** M6a uses the plugin storage API only; it adds no raw SQL and no
  content query (the site checks read the schema, taxonomy definitions and the plugin's own link
  rows, not entries), so the locale rule for content queries is unaffected. Existing content
  queries are unchanged.
- **Display.** Names and descriptions are plain text; control and format characters are refused in
  names (Ruling 38); the M7 admin renders both escaped (React).
- **Tests.** Integration tests use the dev-bypass PAT created at run time (roadmap "Testing"); no
  token is committed.

## Workers and Node

Every M6a route makes a handful of plugin storage calls plus, for the site checks, EmDash's schema
and taxonomy reads. Projected D1 queries and bytes read (V5 measures both):

| Route | Storage calls | Site checks | Projected D1 queries | Projected bytes read |
| --- | --- | --- | --- | --- |
| `templates/list` | 1 query of `TEMPLATE_PAGE` (8) | none | 1-2 | at most 8 × 256 KiB = 2 MiB |
| `templates/get` | 1 get | none | 1 | at most 256 KiB |
| `templates/create`, `templates/import` | name query (2 rows), owner query (`{ owner, collection }`, up to 100 rows), links query (1 row), `compareAndSet(id, null)` | collection fields, each reference target's fields, taxonomy definitions when mapped | about 10-25 | 2 + up to 100 template rows (see below) |
| `templates/update` | `getVersioned`, name query on rename, owner and links queries, `compareAndSet` | as create, when `template` changes | about 10-25 | as create, plus the row |
| `templates/delete` | `getVersioned`, `compareAndDelete` | none | 2-3 | the row |
| `templates/export` | 1 get | none | 1 | the row |
| `jobs/create { templateId }` | 1 get more than today | as today | today's + 1 | today's + the row |

The owner query returns whole rows (F2), so its worst case is 100 rows of 256 KiB. That needs 100
saved templates with one owner in one collection, which is the misconfiguration the warning exists
for; real counts are one or two. All routes stay far under the paid plan's 1,000 queries per
invocation and are meant to stay under the free plan's 50 (F6). CPU is one schema parse and one
JSONata compilation per template, as `jobs/create` already spends. Node has no extra limits.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `TEMPLATE_MAX_BYTES` | 256 KiB of JSON (UTF-8) | Every write of a template row, and of each job row that holds a copy, is a conditional write capped at 1 MiB of JSON (F3); 256 KiB leaves the job row room for its own fields (targets, warnings, counters); V1 (Ruling 39) |
| Name | 1-100 characters, NFC | Typed by people and agents; used as a query value |
| Description | at most 2,000 characters | Listing payloads stay small |
| `TEMPLATE_PAGE` | 8 summaries per `templates/list` page | A query returns whole documents (F2): 8 rows of at most 256 KiB read about 2 MiB (Ruling 32) |
| Owner query | 100 rows, `{ owner, collection }` | One storage page (F2); more than 100 templates with one owner in one collection is reported from the first 100 (Ruling 31) |
| Links query | 1 row | Existence is all the warning needs |
| Name query | 2 rows | Enough to tell taken |

## Testing

- **Unit, shape:** each of `templateShapeProblems`' eight steps refuses on its own case; a
  `__proto__` key in a select `map` and at another depth; the image/file cap at 5 and 6, the
  portableText cap at 3 and 4, a bad JSON path and an XML path problem, `translationOf.locale`
  equal to `locale` in another case, and a `rules` conflict, each refused by the template routes
  and reported **once** by `jobs/create` (`checkTemplate` no longer reports them). Template routes:
  `version` 2 (`UNSUPPORTED_TEMPLATE_VERSION`), `version: "1"`, a missing `version`, an array and a
  string template (all `INVALID_TEMPLATE`); a template exactly at `TEMPLATE_MAX_BYTES` (accepted)
  and one byte over (refused). Inline `jobs/create`: version 2 still `INVALID_TEMPLATE`, a 300 KiB
  template still accepted, and the M5c test suite's `jobs/create` problem sets unchanged. **V3** as
  a table test over every template fixture: parse of the parse equals the parse.
- **Unit, names:** 1 and 100 characters, 0 and 101, leading or trailing space, a control character,
  a zero-width joiner and a bidirectional mark (`\p{Cf}`); a decomposed `é` taken by a precomposed
  one (`NAME_TAKEN`) and stored as NFC; description at 2,000 and 2,001.
- **Unit, service (`MemoryKv`, `FakeLookups`, the fake schema lookup):** create, get, list paging
  (17 rows: three pages of 8, 8, 1, with a delete between pages) and the `collection` filter;
  summaries carry no `template`; update with the right and a stale revision, a rename to a taken
  name, a rename to its own name, `description: null`; a compare-and-set or compare-and-delete lost
  between read and write gives `TEMPLATE_CHANGED`; delete without `revision` is `VALIDATION_ERROR`;
  copied fields follow the template on every update. Site checks: a missing collection, a missing
  field, an unattached taxonomy and an unknown locale are `problems` and the row is saved. Owner
  warnings: another saved template with the same owner, collection and locale; none when the
  locale differs or the row is itself; existing links in the resolved locale (`EN` resolved to
  `en`), none in another locale; the query uses `{ owner, collection }` only.
- **Unit, export and import:** export holds exactly the envelope keys and none of `id`, `revision`,
  `createdBy`, timestamps; a `baseUrl` with a query string is exported as written; the filename for
  an ordinary name, a name that slugifies to nothing, and a long one. Import: round trip (export
  then import gives an equal `template`, a new ID and revision 1); a hand-written file without
  `generator`; unknown envelope keys ignored and an envelope with a `__proto__` key read safely;
  an unknown key inside `template` refused with its path; `format` wrong, `formatVersion` 2 and
  `"1"`, `UNSUPPORTED_TEMPLATE_VERSION`; name taken, then the `name` override. Owner: a template
  with `rules.missing` whose owner has links is `OWNER_IN_USE`, so is one whose owner another saved
  template uses; both import with an `owner` override (which replaces `rules.owner`, and is added
  when absent); without `rules.missing` both import with warnings; an override not matching
  `OWNER_PATTERN` is refused.
- **Unit, jobs:** `jobs/create` input refuses both and neither of `template` and `templateId`; a job
  from a saved template equals one from the same inline template except for `templateId` and
  `templateRevision`; `templateRevision` stale; the template updated and then deleted after the job
  was created, then the job resumed, retried and rolled back from its snapshot; the rollback job
  carries `templateId` and `templateRevision`; `jobs/list { templateId }` lists the import and its
  rollback, and with `status`; `schema/apply { templateId }`, and with a mismatched `collection`.
- **Unit, the unchanged-content skip (Ruling 29):** one URL source, unchanged content: template A
  runs, then template B runs (not skipped), then A again (not skipped, since `lastImport` names B),
  then A again (skipped). The same saved template edited (revision 2) and re-run on unchanged
  content: not skipped; run again: skipped. An inline template, the same object again: skipped; one
  field changed: not skipped. A `lastImport` without `template` (saved before M6a): not skipped.
  `force` and dry runs as before.
- **Unit, definition:** `STORAGE.templates` and the jobs index are declared; every new route is POST
  with `import:execute`, not raw, so it passes `definePlugin`'s MCP route checks (F10); every query
  the new code makes names only indexed fields (the existing definition test's pattern);
  `FLUX_IMPORT_VERSION` is 0.3.0.
- **Integration on `sites/dev`:** create a template whose collection has no `price` field yet
  (saved, with the problem reported); `schema/apply { templateId }`; update it (problems gone,
  revision 2); import 10 rows with `jobs/create { templateId }` and pause the job; update the
  template again (revision 3) and resume the job, which keeps revision 2's mapping and records
  `templateRevision: 2`; export, import the file under another name (with the template's
  `rules.missing`, refused `OWNER_IN_USE` because the original's job created owned entries, then
  imported with an `owner` override), run a dry run from the copy; delete the original and list its
  jobs. A URL-source job from a saved template (`sourceId` plus `templateId`), then a second
  template on the same unchanged source, which is not skipped.
- **Cloudflare parity on `sites/dev-cf`:** the CRUD sequence, a job from a saved template and an
  export-import round trip on D1; V1, V2, V4 and V5 on D1.

## Plan sizing

Seven tasks: (0) prove V1-V5; (1) storage: the `templates` collection, the jobs index, the
`compareAndDelete` port and fakes, the version bump; (2) `templateShapeProblems` (moving steps 3-6
out of `checkTemplate`), the template-route version and size checks, names, `readSavedTemplate`;
(3) the template service: CRUD, revisions, site checks, the owner warnings; (4) export and import,
with the owner refusal and override; (5) routes, `jobs/create`, `jobs/list` and `schema/apply` by
`templateId`, the job's and the rollback job's `templateId` and `templateRevision`, and the
`lastImport` template; (6) Node integration, workerd parity, the review run with V5 measured, and
the note. A final fix wave follows the whole-branch review.

## Rulings

1. **Saved templates are documents in a new plugin storage collection.** Storage has indexes,
   paged queries and compare-and-set (F1-F3). Settings hold admin-form values and KV internal
   state, neither queryable (F9); a template is an operational record that people and agents list
   and change concurrently.
2. **A job keeps a snapshot; it never re-reads its template.** Jobs already store the parsed
   template and every later step reads that copy (P2). Editing a template under a paused or failed
   job would otherwise change what a resume or retry writes, and a rollback's journal would no
   longer match the mapping that produced it. The job records `templateId` and `templateRevision`
   so the operator can tell which version ran.
3. **The stored template is the schema's output, and it is re-validated at every use.** Storing the
   parsed form applies defaults once and makes exports deterministic; V3 proves parsing it again
   changes nothing. Re-validating at `jobs/create` covers rows written by another plugin version.
   *Amended by Ruling 42* (defaults frozen at save).
4. **Shape refuses; the site is reported.** A template that cannot run anywhere is never useful, so
   it is refused as `jobs/create` refuses it. A template whose collection or fields are missing is
   useful: it may be saved before `schema/apply` creates the fields, or imported from another site.
   Site problems are returned on every save and enforced by `jobs/create`, where they matter;
   storing them would go stale as the schema changes. *Amended by Ruling 27* (which checks are
   shape).
5. **Names are unique by a check, not by a unique index.** The error a duplicate raises is
   undocumented, and a later EmDash release migrates plugin unique indexes with a maintenance window
   on every site that has one (F4); a plugin should not impose that on its users for a display
   name. The check-then-write race is the one URL sources accept (P4). *Amended by Ruling 43* (no
   name lookup, so no `AMBIGUOUS_NAME`).
6. **Optimistic concurrency by revision number, enforced by compare-and-set.** People in the admin
   and agents over MCP (M6c) will edit the same templates; a lost update would silently change a
   feed's mapping. The integer is readable in responses and on jobs; the storage revision closes the
   window between the read and the write (F3). *Amended by Ruling 37* (delete needs the revision).
7. **No default `rules.owner`.** M5c Ruling 1 suggested that saved templates could default the owner
   to their ID. Declined: the ID changes on export and import and is new for a copy, so the same
   feed imported on a second site, or a template re-imported after a delete, would get a new owner
   and silently stop owning (and so stop removing) the entries it created. An explicit name
   survives both. *Amended by Ruling 30* (the owner checks also read links, and import refuses).
8. **Export is a JSON route response, not a raw download.** A raw route can never become an MCP tool
   (F10), and M6c needs an agent to export and import; the admin (M7) saves the returned `file` as a
   download in the browser. The envelope gives the file a self-describing `format` and
   `formatVersion`.
9. **Exports are site-neutral.** IDs, revisions, user IDs, timestamps other than `exportedAt`,
   sources, credentials and job options are left out: a file may be shared with another team or
   committed to a repository, and those values are either secret, personal, or meaningless on
   another site. *See Ruling 40* for the one value inside the template that can still leak.
10. **Import always creates.** Replacing a template by file is an update with a revision check, which
    `templates/update` already offers with the file's `template`; an import that could overwrite by
    name would bypass that check.
11. **Two version numbers, both refused when unknown, and no migration code yet.** The template's
    `version` is the format of mappings and rules; the envelope's `formatVersion` the shape of the
    file. An unknown template key is refused rather than dropped, because the key may be a safety
    rule. An unknown envelope key is ignored, because only the template is acted on. The upgrade
    point (`readSavedTemplate`) is named so a version 2 has one place to land; writing upgrade code
    before a second version exists would be speculative. *Amended by Ruling 28* (the version code is
    for template routes only).
12. **A saved template holds the template only.** Job options (`publish`, `batchSize`, `budgetMs`,
    `journal`, `missing`) and the source belong to a run, and M6b's schedule is the record that ties
    a template, a source and options together. Keeping them out keeps one meaning per record and
    keeps exports portable.
13. **256 KiB per template.** The largest realistic template (200 mapped fields with expressions) is
    well under 64 KiB; 256 KiB leaves room, pending V1. *Amended by Ruling 39* (the reason is the
    1 MiB conditional-write cap).
14. **No new capability.** Plugin storage needs none (F12); the site checks reuse the schema and
    taxonomy access M2-M4 declared and justified (`src/plugin/definition.ts:45-69`).
15. **Listing without `orderBy`.** Pages in creation order keep a stable cursor while rows are
    updated or deleted (F2); ordering by `updatedAt` or `name` would move rows between pages and
    break the cursor when its row is deleted. Admins and agents sort client-side. *Amended by
    Ruling 32* (page size).
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
    schedule names the template (with the race of Ruling 45).
21. **Name rules.** Exact comparison as for sources; no leading or trailing whitespace and no
    control characters, because names are typed by agents and two names that differ only by a
    trailing space would be indistinguishable in a list. *Amended by Ruling 38* (NFC, `\p{Cc}` and
    `\p{Cf}`).
22. **Site checks run without source columns.** A saved template has no source; `checkTemplate`
    already skips column checks for `columns: null` (P3), and `jobs/create` checks the columns of
    the actual source.

### Rulings on the M6 split (the parts after M6a)

23. **Order: templates, then schedules, then MCP tools, then suggestions.** *Amended by Ruling 35*
    (the order is now templates, MCP tools, schedules, suggestions).
24. **Plugin MCP tools are supported, so M6c uses them as the roadmap planned.** EmDash 1.2.0 lets
    a plugin expose private JSON routes as MCP tools on the site MCP server (F-M1). No workaround is
    needed. M6c must plan for the administrator's enable step and the `mcp:tools` scope (F-M2,
    F-M3).
25. **M6d calls a provider's HTTP API through `ctx.http` and `allowedHosts`.** *Amended by
    Ruling 34*: the transport is left to M6d's spec.
26. **Plugin cron is available, but its signature is documented only in source.** The docs name
    `ctx.cron.schedule()` and document the `cron` hook (F-C1); the parameters and semantics come
    from `emdash@1.2.0` source, which the retention task already relies on. M6b treats the source as
    authoritative, pins behaviour with tests, and proves the unknowns (F-C4, F-C5) in its Task 0.

### Added by the spec review (binding rulings of the coordinator)

27. **The shape function holds every check that does not depend on the site.** `pathProblem` for
    JSON and XML paths, the image/file and portableText caps, `translationOf.locale` equal to
    `locale`, and `rulesProblems` depend on the template alone, so they move from `checkTemplate`
    into `templateShapeProblems` (whose eight steps are listed exactly under "Validation"), and
    `checkTemplate` no longer reports them, so `rulesProblems` is not reported twice. A template
    that saves can then always run on a site that fits it. Amends Rulings 4 and 22.
28. **The size cap and `UNSUPPORTED_TEMPLATE_VERSION` belong to the template routes only.** Inline
    `jobs/create` keeps its M5c codes, messages and limits, so no existing caller changes. On the
    template routes a non-object template, a missing `version` and a non-number `version`
    (`"1"` included) are `INVALID_TEMPLATE` from the schema with their path;
    `UNSUPPORTED_TEMPLATE_VERSION` is only for an integer other than 1. Amends Ruling 11.
29. **The unchanged-content skip compares the template too.** `jobFromSource` compared the hash only
    (P9), so a second template on a source, or an edited template, was skipped while the feed was
    unchanged, and the change never reached the site. `lastImport` records `templateId` and
    `templateRevision`, or a fingerprint of an inline template, and the skip needs both the hash and
    the template to match. A `lastImport` from before M6a never matches. The cost is one job more
    per source after the upgrade and one per template switch, which import nothing new where the
    content is unchanged (`unchanged` rows).
30. **Owner collisions through import or copy are checked against links, and import refuses them.**
    The saved-template comparison alone missed the main case: an owner that already has entries
    (from inline jobs, a deleted template, or the same feed on this site) whose new template's
    missing phase would treat them as its own. The owner checks also query `links` on its
    `["owner", "collection", "locale"]` index with the resolved locale (P10). Import refuses
    `OWNER_IN_USE` when the template has `rules.missing` and either check finds something, unless
    the request names `owner`, which replaces `rules.owner` and is then only warned about. Create
    and update keep the warnings only, since an administrator editing a template is choosing its
    owner deliberately. Amends Ruling 7.
31. **The saved-template owner query is `{ owner, collection }`.** Both fields are indexed; the
    locale is filtered in memory, so the query reads fewer whole rows than `{ owner }` alone (F2).
32. **`templates/list` returns 8 summaries a page.** A storage query returns whole documents (F2), so
    a page of 50 could read 50 × 256 KiB. Eight rows read at most about 2 MiB. Lowering the page
    size is the simplest option: a separate summary collection would need a second write per change
    and a way to keep the two in step. Amends Ruling 15.
33. **V5 measures bytes read as well as queries.** The routes' cost on Workers is memory and time
    for the documents read, not only the query count.
34. **"No AI binding" is a fact about the plugin API; M6d's spec chooses the transport.** The plugin
    capability list and `PluginContext` have no AI member (F-A1); that says what EmDash gives a
    plugin, not what the feature may use. The M6d spec chooses among: (a) a provider HTTPS API
    called with the runtime's `fetch()` behind the plugin's existing SSRF guard, which matches
    `definition.ts`'s convention of fetching without declaring `network:request`
    (`src/plugin/definition.ts:55-57`), with the key in a `secret` setting (F9); (b) a Workers AI
    binding read from the Worker's `env` on Cloudflare, outside the plugin API; (c) the
    deterministic name-matching suggester, which needs neither and is the fallback in any case.
    Replaces Ruling 25.
35. **Order: M6a, M6c, M6b, M6d.** The MCP tools need only templates and the job routes, and M6b
    carries the most risk: the `scheduled()` handler on a production build (blocked since M2) and the
    D1 budget of a shared cron tick (F-C4). Shipping M6c first delivers the agent half of the
    acceptance without waiting on those. The cost: M6b's schedule tools change the tool list, so the
    administrator consents a second time (F-M3). M6d depends only on M6a. Amends Ruling 23.
36. **`__proto__` keys are refused, and the envelope is read by known keys.** A select `map` accepts
    any key (P11), and a spread or merge of a parsed object with a `__proto__` key can change a
    prototype in later code; refusing the key in the shape function and picking envelope fields by
    name removes the case instead of relying on every later reader to be careful.
37. **Delete needs the revision.** As updates do (Decisions, "Concurrency"): a delete without it
    could remove a template another administrator has just changed, and a revision-less delete that
    lost its compare-and-delete would have no defined outcome. Amends Ruling 6.
38. **Names are NFC-normalised, and control and format characters are refused.** Two names that
    look the same in a list must compare the same; `\p{Cf}` covers zero-width and bidirectional
    marks, which make names that look alike or render reordered. Amends Ruling 21.
39. **The size rationale is the conditional-write cap.** Templates and jobs are written with
    `compareAndSet`, which takes at most 1 MiB of JSON (F3); a job row carries the template and its
    own fields, so the template keeps well under a quarter of that. D1's 2 MB row is not the binding
    limit. Amends Ruling 13.
40. **A media `baseUrl` can carry a token or an internal host into exports.** It is documented in
    Security and Open issues and in the M8 template docs; the export does not rewrite or strip it,
    because the mapping needs it to resolve relative URLs and the importer cannot tell a token from a
    path.
41. **Rollback jobs carry `templateId` and `templateRevision`.** `createRollback` copies `template`
    from its original (P2); copying the two fields too makes `jobs/list { templateId }` list a
    template's imports with their rollbacks, which is what an operator reviewing a template's history
    needs.
42. **Snapshots go through `jobTemplate`, and stored templates freeze the defaults in force at
    save.** Jobs from saved templates are read like any job (P2). A stored template carries the
    schema's defaults as written values; a later default change reaches saved templates only
    through `version` or `readSavedTemplate`, which keeps a saved template meaning what was
    reviewed when it was saved. Amends Ruling 3.
43. **No lookup by name.** `templates/get` takes an ID only, and `AMBIGUOUS_NAME` is gone; `NAME_TAKEN`
    stays. IDs are what jobs, schedules and tools store; a name lookup would make the accepted name
    race (Ruling 5) a source of ambiguous requests. Amends Ruling 5.
44. **The MCP tool name check moves to M6c.** It decides nothing in M6a; M6c's Task 0 records the
    generated name for the plugin ID `flux-import`.
45. **A schedule run must handle a template that is gone.** M6b refuses deleting a template a
    schedule names, but the check and the delete race (a schedule can be created between them), so
    a schedule run that finds no template pauses the schedule with a reason instead of failing.
46. **Plugin MCP tools are fenced like writes, read tools included.** *Corrected by the M6c spec,
    Ruling 24; this ruling first said they are blocked during a site export.* EmDash registers
    plugin tools with `destructiveHint` only and fences every tool not annotated `readOnlyHint`
    (`src/mcp/server.ts:875-906`, `:908-917`), so M6c documents that `list_templates` and
    `import_status` are refused during a site import, and that a successful call restarts a running
    site export.
47. **The integration sequence pins the snapshot.** The update after the job starts makes revision 3,
    and the resumed job keeps revision 2's mapping and `templateRevision: 2` (Testing).

## Amendments after implementation

Added by the M6a review run (plan Task 9). They come from the plan's rulings, which the coordinator
accepted as amendments before Task 1, and from the Task 6 review. Each is binding and amends the
text above where it says otherwise; the code reads as these rulings say.

48. **(Plan Ruling 1) The `__proto__` walk reads the raw input, not the parsed template.** Zod
    4.5.4's `z.record` drops a `__proto__` key without a word (plan Fact E1), so a walk of the parsed
    template (Validation, step 2) can never find one. `protoKeyProblems(input)` walks the raw route
    input with an explicit stack, so a deeply nested body cannot overflow the call stack
    (Review Focus 1). It never walks into a `__proto__` key's value, and it stops after
    `MAX_PROTO_PROBLEMS` (20) keys, so its work stays linear in the input (Task 2 review). A path
    over 200 characters is shortened to its first and last `PATH_KEEP` (100) characters. The
    problems join step 1's, and Zod's `Unrecognized key: "__proto__"` at the same path is dropped
    so the key is reported once. Amends Validation step 2.
49. **(Plan Ruling 4) The inline fingerprint is `fingerprint(parsed)`.** `fingerprint` already
    hashes `stableJson` of its argument (P12, `src/engine/fingerprints.ts:42-46`). The literal
    `fingerprint(stableJson(parsed))` would hash the JSON string of that string. The result is
    just as deterministic and ignores key order (Review Focus 3), with one canonicalisation instead
    of two. Amends "The unchanged-content skip".
50. **(Plan Ruling 6) Inline `jobs/create` keeps M5c's separate refusals.** The Shape section says
    that inline shape and site problems are "reported together in one `invalid_template` error".
    That contradicts Ruling 28, which keeps M5c's codes and messages, and Ruling 28 binds.
    `templateShapeProblems` returns its results in groups, and `createJob` refuses in M5c's order:
    1. a schema or `__proto__` failure: "The template is invalid";
    2. the option checks;
    3. expressions: "The template has invalid expressions";
    4. `invalid_source`: "The source block is invalid";
    5. `[...fit, ...checkTemplate(…)]`: "The template does not fit the source or schema".

    Only the order inside the last list changed: the moved fit checks come first. The template
    routes and `schema/apply` refuse on any group; `schema/apply` keeps `VALIDATION_ERROR`
    "The template is invalid: …" (plan Ruling 7). Amends Validation, "Shape".
51. **(Task 6 review) F7 is corrected: EmDash's 1 MiB body default applies only to a route that
    declares `request`.** A route without `request` reads its body with `request.json()` and no
    limit (`node_modules/emdash/src/plugins/routes.ts:136-143`). The default
    `PLUGIN_ROUTE_DEFAULT_BODY_BYTES` applies only to a declared body
    (`src/plugins/route-wire.ts:185-186`). M6a therefore declares
    `request: { body: "json", maxBytes: 2 MiB }` (`TEMPLATE_BODY_MAX_BYTES`) on the five routes that
    take a template:
    - `jobs/create`;
    - `schema/apply`;
    - `templates/create`;
    - `templates/update`;
    - `templates/import`.

    2 MiB holds any serialisation of a 256 KiB template; pretty-printed, Task 8 measured 282,039
    bytes. An inline `jobs/create` template was already bounded by the 1 MiB conditional-write cap
    on its job row (F3), so no job that could be created before is refused. That reason does not
    hold for `schema/apply`, which writes no job (Ruling 53). The other template routes declare
    nothing. A declared JSON body is still an MCP-ready
    route (`isJsonPostRouteContract`, M6c), and an MCP tool call goes through the same cap. Amends
    F7, and "the only size bound is the 1 MiB route body" under Shape, which now reads 2 MiB.
52. **(Task 6) The five capped routes answer `INVALID_PLUGIN_REQUEST` for a body that is not JSON
    or is too large.** An empty or malformed JSON body to `jobs/create`, `schema/apply` or
    `templates/create`, `update` or `import` now gets 400 `INVALID_PLUGIN_REQUEST` "Plugin route
    request body is not valid JSON" (`route-wire.ts:193-198`). It used to get `VALIDATION_ERROR`
    "Invalid request body". A body over 2 MiB gets 413 `INVALID_PLUGIN_REQUEST` "Plugin route request
    body exceeds 2097152 bytes", and the handler is never called. `sources/paste` already behaved
    this way. Only bodies that aren't JSON are affected; every valid JSON body is validated by the
    route's Zod input as before. Proven over HTTP on Node (`tests/integration/templates.test.ts`,
    "HTTP checks") and the 413 also on workerd (`parity.test.ts`, the 256 KiB test). Amends Errors.
53. **(Final review) `schema/apply` bodies over 2 MiB are refused, an accepted change.** The cap of
    Ruling 51 also applies to `schema/apply`, which writes no job, so the 1 MiB job-row bound never
    held it. An M5c `fields` or inline `template` body over 2 MiB, which it accepted before, now gets
    413 `INVALID_PLUGIN_REQUEST`. That is a schema of thousands of fields, far beyond any
    collection the admin builds. The comment on `TEMPLATE_BODY_MAX_BYTES` says so. Amends F7 with
    Ruling 51.
54. **(Final review) `jobs/create` without a template is `VALIDATION_ERROR`.** With `template` now
    optional and `templateId` beside it, a body with neither fails the route input's refinement:
    400 `VALIDATION_ERROR` "Invalid request body", whose issue reads "Set exactly one of template
    and templateId" (`node_modules/emdash/src/plugins/routes.ts:246-258`). In M5c it reached
    `createJob` and was 400 `INVALID_TEMPLATE` "The template is invalid". A body with both is
    refused the same way. Amends Errors and Ruling 28, which kept the inline codes only for a
    template that is sent.
55. **(Plan Ruling 7, final review) Inline `schema/apply` refuses every shape problem.**
    `schema/apply` runs `templateShapeProblems` and refuses on any group. A template with
    fit, expression or source problems, such as a JSON path with an empty key, too many media
    fields, an expression that does not compile, or `source.sheet` on CSV, used to be planned
    from. It is now 400 `VALIDATION_ERROR` "The template is invalid: <problems joined by "; ">"",
    the code M5c used for the schema's own problems. Such a template could never run a job, so a
    schema planned from it was of no use. Amends Validation, "Shape".
56. **(Final review) `jobs/list` returns 8 jobs a page, filtered or not.** A storage query returns
    whole documents (F2), and every job holds its template. One from a saved template holds up to
    256 KiB. A page of `PAGE_SIZE` (50) of `jobs/list { templateId }` could read about 13 MB,
    against V5's "about 2 MiB". `JOB_PAGE` = 8 (`src/plugin/service.ts`) pages every
    `jobs/list` call, as `TEMPLATE_PAGE` does for `templates/list` (Ruling 32). Clients already
    page with the cursor. Inline-template jobs can still hold up to 1 MiB each (Open issues).
    Amends API (`jobs/list`) and "Workers and Node".
57. **V5 is measured** (M6a review, `docs/superpowers/notes/2026-11-16-m6a-review.md`). On local
    workerd and D1, the site had a collection with two reference fields and two taxonomies, eight
    saved templates of 256 KiB, and one other template sharing the owner. Every M6a route ran 1-9
    D1 queries inside its handler:
    - `templates/create` and `templates/import`: 9;
    - `templates/update`: 8;
    - `jobs/create { templateId }`: one more than the same template inline;
    - `templates/delete`: 2;
    - the reads: 1.

    The largest reads are the two full pages: `templates/list` reads 2,099,488 bytes and
    `jobs/list { templateId }` 2,103,912 (at `JOB_PAGE`, Ruling 56). Both are within 0.4 % of
    2 MiB, so the bound stays "about 2 MiB" (Ruling 32) and is not loosened. Production D1 is
    unverified. Settles V5 and "Workers and Node".

## Outline of M6c, M6b and M6d

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
| F-M1 | **Plugin MCP tools.** `mcp.tools` entries map a local name to a private, permissioned, JSON POST route with a Zod `input` (required) and `output` (optional) and a `destructive` flag; EmDash registers them on `/_emdash/api/mcp` as `<pluginId>__<name>` in 1.2.0 source (the docs speak of an "MCP-safe plugin prefix"; M6c Task 0 records the name, Ruling 44) and dispatches a call to the route with the MCP caller as `routeCtx.user`, writing an audit row | `src/plugins/types.ts:1949-1959`; `src/plugins/define-plugin.ts:160-176`; `src/mcp/server.ts:842-981`; `src/emdash-runtime.ts:5724-5800`, `:5844-5882`; [API routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/#exposing-a-route-as-an-mcp-tool); [MCP server](https://docs.emdashcms.com/reference/mcp-server/#plugin-tools) |
| F-M2 | **Scopes and permissions.** A token call needs `mcp:tools` or `mcp:tools:flux-import`; the `admin` scope does **not** imply them. The route's permission (`import:execute`) is checked against the user's role | `src/mcp/server.ts:918-952`; `@emdash-cms/auth` `src/tokens.ts:46-70`, `:106-117` |
| F-M3 | **Consent.** Tools are listed only after an administrator (`plugins:manage`) enables the plugin's MCP surface; the consent is a snapshot of every tool's name, description, route, permission, flag and JSON schemas, so any change to the tool list or a schema disables the tools until consented again | `src/emdash-runtime.ts:5802-5842`; `src/astro/routes/api/admin/plugins/[id]/mcp.ts:13-41` |
| F-M4 | **The export fence.** Every MCP tool not annotated `readOnlyHint: true` is fenced while a site export runs, and plugin tools are registered with `destructiveHint` only. *Corrected by the M6c spec (F9, Ruling 24)*: the fence refuses calls during a site import; during an export a successful call runs and restarts the export | `src/mcp/server.ts:875-906`, `:908-917` |
| F-A1 | **No AI access in the plugin API.** The capability list has no AI or model capability and `PluginContext` has no AI member; the docs' AI pages cover MCP clients (AI tools guide) and the first-party AI Search plugin, which binds Cloudflare AI Search in its own configuration | `src/plugins/manifest-schema.ts:30-58`; `src/plugins/types.ts:1056-1112`; [AI tools](https://docs.emdashcms.com/guides/ai-tools/); [AI Search](https://docs.emdashcms.com/plugins/ai-search/) |
| F-A2 | **Network access today.** flux-import fetches URL sources and media with the runtime's `fetch()` behind its own SSRF guard and declares no network capability; `network:request` with `allowedHosts` would give `ctx.http` instead | `packages/flux-import/src/plugin/definition.ts:55-57`; `packages/flux-import/src/plugin/routes.ts:183-188`; `src/plugins/manifest-schema.ts:31-32`; `src/plugins/define-plugin.ts:134` |

### M6c, MCP tools

Tools over the existing routes: `list_templates` (`templates/list`), `dry_run` (`jobs/create` with
`dryRun: true`), `start_import` (`jobs/create`, `destructive: true`), `import_status` (`jobs/get`),
plus the step an agent needs to drive a job, since a job advances only through `jobs/next` (M2):
either a `next_batch` tool or a driver route, decided in M6c's spec. An agent cannot stream an
upload over MCP, so its sources are URL sources and pasted text (`sources/paste`, 1 MiB). Tool
inputs use `templateId` rather than an inline template where possible, since the inline template's
schema is `z.unknown()` and gives an agent no guidance. Documented: the administrator's enable
step, the scopes (F-M2), the re-consent after any tool change (F-M3, including the one M6b will
cause, Ruling 35), and that every tool, read tools included, refuses during a site export (F-M4,
Ruling 46; *corrected by the M6c spec, Ruling 24*: refused during a site import, and restarting a
running export). Task 0 records the generated tool names (Ruling 44). Acceptance: an agent completes an
import over MCP.

### M6b, scheduled URL imports

A `schedules` collection: a saved template ID, a URL source ID, a cron expression (validated with
F-C2's rules, UTC), the job options (`publish`, `batchSize`, `budgetMs`, `journal`, `missing`),
`enabled`, the actor's user ID, and the last run's job, outcome and time. One recurring cron task
per schedule (`schedule-<id>`) only fetches the source and creates the job (`jobFromSource`, whose
`lastImport` skip, now template-aware (Ruling 29), avoids a second job for unchanged content); a
single recurring `pump` task advances running scheduled jobs one batch at a time within the tick's
budget (F-C3, F-C4). A run is skipped while the schedule's previous job is still running; a refused
missing phase (`Job.missing.verdict === "refused"`, M5c Ruling 6), repeated failures, or a template
or source that is gone (Ruling 45) pause the schedule with a reason. Deleting a template named by a
schedule is refused (Ruling 20). Schedule tools join M6c's list, with a second consent (Ruling 35).
Acceptance: a scheduled import runs unattended on Node and on `sites/dev-cf`.

### M6d, AI mapping suggestions

A `mapping/suggest` route takes a staged upload (or a sample) and a collection and returns proposed
`fields` mappings with a reason per field, sending a model at most the headers, a few sample rows
and the field list, and returning the deterministic name-matching suggestions when no model is
configured. The transport (Ruling 34) is chosen by M6d's spec. The result is a template the caller
saves with M6a or passes to `jobs/create`; nothing is written by the route.

## Out of scope for M6a

A template history (jobs keep the revisions they ran); lookup by name (Ruling 43); a
`templates/duplicate` route (export and import, or get and create, do it); several templates in one
file; signed or encrypted export files; per-template permissions (every route is Admin); a default
`rules.owner` (Ruling 7); storing site-check results; job options, sources or schedules in a
template (Ruling 12, M6b); bounding inline `jobs/create` templates beyond the 1 MiB body limit
(Ruling 28); comparing job options in the unchanged-content skip; MCP tools, schedules and
suggestions (M6c, M6b, M6d); the admin screens (M7); the template format reference in the README,
with M5c's owner text and the `baseUrl` warning (M8).

## Open issues

- **Name race.** Two simultaneous creates or imports with one name both succeed, and the list shows
  two rows with one name until an administrator renames one (Ruling 5). Nothing looks templates up
  by name, so no request becomes ambiguous.
- **Stale site checks.** A template saved without problems can acquire them when the schema changes;
  they surface at the next save or at `jobs/create`, not on `templates/get`.
- **Owner checks outside saved templates.** The owner checks run on the template routes. An inline
  template in `jobs/create` that takes over an owner is not warned about (M5c's guards still apply),
  and an import with an explicit `owner` override is only warned about (Ruling 30).
- **The owner check reads whole rows.** Up to 100 saved templates of one owner and collection are
  read in full (Workers and Node); only a misconfigured site has more than one or two.
- **Plain-text templates.** Template bodies are not encrypted and are copied onto every job; an
  expression that embeds a secret would be stored in clear. Documented, not prevented.
- **`baseUrl` in exports.** A media mapping's `baseUrl` is exported as written, so a token in it or
  an internal host name reaches every export file (Ruling 40).
- **Unsigned files.** An imported file is validated, not authenticated; an administrator importing a
  file from elsewhere trusts its mappings and rules, as with a template pasted into `jobs/create`.
- **The skip after the upgrade.** Every URL source runs once more on unchanged content after M6a,
  since pre-M6a `lastImport` rows carry no template (Ruling 29). Job options are not compared: an
  unchanged source with the same template and different options (`publish: false` then `true`) is
  still skipped unless `force` is set.
- **Dangling `templateId`.** Jobs of a deleted template keep its ID; `templates/get` on it is 404.
- **Downgrades.** A row saved by a newer plugin version with keys this version does not know can be
  listed, read and exported, but `jobs/create` and `schema/apply` refuse it until it is updated.
- **Inline-template jobs in `jobs/list`** (final review). A job with an inline template can hold up
  to 1 MiB (the conditional-write cap), so a plain `jobs/list` page of 8 can still read about
  8 MiB. The fix is summary rows or a trimmed response, in M6c or M7 (Ruling 56).
- **The `__proto__` duplicate filter** (final review, cosmetic). The walk drops Zod's singular
  `Unrecognized key: "__proto__"` at the same path (Ruling 48), but not the plural
  `Unrecognized keys: "x", "__proto__"`, which also names other keys, so such a key is reported
  twice.
- **From M5c** (`2026-11-12-m5c-review.md`), unchanged: the open issues of the M5c spec and review,
  the version mismatch between `package.json` and `FLUX_IMPORT_VERSION` until M8, the known flakes
  (F1, F2, F3 on port 4397), and the production Cloudflare build blocker from M2.
