# Flux Import M4b: taxonomies, references and bylines

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Second part of Milestone 4 (Field types and schema) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-4-split). Builds on M4a
([spec](./2026-10-27-flux-import-m4a-scalar-fields-design.md),
[review](../notes/2026-10-27-m4a-review.md)), merged at `15580df`.

## Goal

Import an entry's links to other objects, which EmDash keeps outside the entry's own columns:

- **Taxonomy terms.** Look terms up by slug or label, or by a `parent/child` path in hierarchical
  taxonomies. Optionally create the ones that are missing. Assign them through the content write's
  `taxonomies`.
- **Reference fields.** Link to target entries by entry ID, slug, or the source key this importer
  stored on them. Write through the content write's `references`.
- **Bylines.** Credit existing bylines by slug or exact display name through the content write's
  `bylines`. Bylines are never created.

The importer resolves every lookup before it writes, so a dry run reports the same missing terms,
entries and bylines that a real run would hit. The diff compares what EmDash reads back, so a re-run
plans `unchanged`. The template stays `version: 1` and every addition is optional.

## Decisions

| Topic | Decision |
| --- | --- |
| Template shape | References are fields (`type: "reference"` in `fields`) because they are collection fields. Taxonomies and bylines are not fields, so they get two new top-level template keys, `taxonomies` (keyed by taxonomy name) and `bylines`. |
| Writes | Everything goes through the trusted runtime's `handleContentCreate` / `handleContentUpdate` as `taxonomies` (term slugs), `references` (entry IDs) and `bylines` (`{ bylineId, roleLabel }`). These are written in the same transaction as the entry. The plugin-context delta methods (`addEntryTerms`, `removeEntryTerms`) are not used, because a mapped taxonomy replaces the entry's terms of that taxonomy, the same way a mapped field replaces its value. |
| Term creation | `ctx.taxonomies.createTerm`, which needs the `taxonomies:write` capability. It is the only sanctioned path: the runtime has no term-create method, and `handleTermCreate` is not exported from `emdash`. Terms are created only in a real run, before the record's plan, and only when the mapping sets `create: true`. A term created for a record that then fails, conflicts or is locked stays in place, and the next run finds it. |
| Term matching | `match: "slug"` (default) compares each path segment with term slugs exactly. `match: "label"` compares labels: an exact match first, then a case-insensitive match when exactly one label matches (the M4a select rule). A hierarchical taxonomy splits each value on `hierarchy` (default `/`) into a path from a root term. A flat taxonomy never splits, so a tag such as `AC/DC` stays one term. |
| Term locale | Terms are looked up and created in the template's locale only, with no fallback. EmDash resolves a write's term slugs strictly in the entry's locale (`assignTaxonomies` → `findBySlug(name, slug, locale)`), so a term that exists only in another locale cannot be assigned. Linking term translations is left to M4e. |
| Empty taxonomy value | Removes every term of that taxonomy from the entry (`taxonomies: { name: [] }`). On create the taxonomy is left out. |
| References | Only fields bound to a relation are supported: these are every reference field EmDash 1.2 creates. An unbound legacy field, which holds an ID in a text column, is a template problem, and the problem text points to "Bind a field that has no relation" in the docs. The target collection is the field's `validation.targetCollection`. |
| Reference lookup | `match: "id"` (default) finds an entry ID in the target collection in any locale. `match: "slug"` finds a slug in the template's locale. `match: "key"` finds the source key that a flux-import job wrote into the target collection under the template's locale: first the importer's link row (`collection:locale:key`), then `flux_source_id`. The importer always sends the resolved entry IDs, never slugs, because EmDash's own slug resolution ignores locale. |
| Reference limits | At most 50 entries per field per record. This is EmDash's first page of read-back (`REFERENCE_PAGE_LIMIT`), and the diff needs the whole selection to plan `unchanged`. More than 50 fails with `too_many_items`. A parent-side field whose `validation.multiple` is not `true` takes at most 1. Other relation limits (the far side, child-side fields) stay with EmDash and surface as `emdash_validation_error`. |
| Forward references | A `key` lookup for an entry that the same job has not written yet fails with `reference_not_found`. `jobs/retry`, or a second run, resolves it once the target exists. This is documented. The importer does not reorder records. |
| Bylines | Existing bylines only, matched by `slug` (default) or by `name` (`displayName` equal after trimming both, case-sensitive). They must exist in the template's locale, because EmDash hydrates credits strictly in the entry's locale and a credit without a variant there would read back as missing. Two bylines with the same name are `ambiguous_byline`. |
| Byline lookup | No exact name lookup is available to plugins. `ctx.bylines.list` has no search, and the repository's `search` is a `LIKE` that is not exported. So the importer pages through `ctx.bylines.list({ locale })`, 100 at a time, once per batch the first time a record needs a byline, and builds slug and name maps. It stops at 5,000 bylines. A lookup the loaded set does not answer after hitting that limit fails with `byline_lookup_limit`. |
| Byline roles | Source data sets no role labels. For a byline the entry is already credited with, the existing `roleLabel` is kept. New credits get `null`. |
| Read-back for the diff | References: `handleContentGet(…, { includeDrafts: true })`, compared by translation group. A staged draft selection is what reads back. Bylines: `item.bylines` with `source: "explicit"`, compared by translation group in order. Terms: `ctx.taxonomies.getEntryTerms(collection, entryId)` with no locale, so every locale row is returned, compared as a set of translation groups per mapped taxonomy. |
| Updates that change only links | When an update changes no data field and no slug, the importer leaves out `data` and sends only the changed `taxonomies`, `references` or `bylines`. On a collection with revisions this avoids staging a draft that is identical to the live entry. When any data field changed, the whole mapped `data` is sent as before (M2). |
| Revisioned collections | Taxonomies and bylines are live metadata, so EmDash writes them immediately even when `data` is staged as a draft and the job has `publish: false`. References are staged with the draft. This is documented as EmDash behaviour. The importer does not try to hide it. |
| Caching | Lookups are cached per batch. Each mapped taxonomy's terms are loaded once (`ctx.taxonomies.getTerms`), and terms created in the batch are added. Bylines are loaded once. Reference hits are cached per (target, match, value). Misses are not cached, because a later record in the same batch may create the target. |
| Workers batch cap | 10 records per `jobs/next` on Workers when the template maps taxonomies, references or bylines (20 otherwise, as before), because each record now makes more queries. |
| Capabilities | Add `taxonomies:write` (`ctx.taxonomies`: definitions, terms, entry terms, `createTerm`) and `bylines:read` (`ctx.bylines.list`). `content:*` and `schema:read` are kept. |
| `schema/apply` | Unchanged apart from reporting. It creates no reference fields, relations, taxonomies or bylines: the first two need `handleSchemaFieldCreate` / `createFieldRelation`, which are not exported, and plugins have no API for the last two. In template mode, a missing reference field plans `conflict` ("create reference fields in the admin"), and `taxonomies` / `bylines` are ignored. |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`), `@emdash-cms/plugin-types@0.6.0` and the docs on
2026-10-27.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | The runtime's create and update accept `taxonomies?: Record<string, string[]>` (term slugs), `references?: Record<string, string[]>` (entry IDs), `bylines?: Array<{ bylineId, roleLabel? }>` and `translationOf` | `src/emdash-runtime.ts:3455-3470` (create), `:3649-3679` (update); `src/api/handlers/content.ts:1206-1221`, `:1487-1502` |
| F2 | `taxonomies` resolves each slug with `findBySlug(name, slug, locale)` in the entry's locale and fails with `EmDashValidationError` ("Unknown taxonomy term", becomes `VALIDATION_ERROR`) when a slug is missing. It replaces that taxonomy's assignments (`setTermsForEntry`) inside the create or update transaction. It does **not** check that the taxonomy is attached to the collection | `src/api/handlers/content.ts:2866-2906`, `:1377-1379`, `:1673-1681`; `src/database/repositories/taxonomy.ts:252-262`, `:802-837` |
| F3 | Assignments are keyed by the entry's translation group and the term's translation group, so they are shared by every locale of the entry | `src/taxonomies/index.ts:1-11`; `src/database/repositories/taxonomy.ts:802-837`; [taxonomies guide, translate](https://docs.emdashcms.com/guides/taxonomies/#translate-taxonomies-and-terms) |
| F4 | No public runtime method creates terms. `ctx.taxonomies.createTerm(taxonomy, { label, slug?, parentId?, locale? })` with `taxonomies:write` calls `handleTermCreate`. That handler refuses `parentId` on a flat taxonomy, returns `CONFLICT` for an existing slug in the locale, and generates a unique slug from the label when `slug` is omitted (`generateUniqueSlug`, numeric suffix). Slugs are unique per (taxonomy, locale), not per parent | `src/plugins/context.ts:714-735`, `:1752-1758`; `src/api/handlers/taxonomies.ts:950-1085`; `src/database/repositories/taxonomy.ts:264-290`; [capabilities: creating and assigning taxonomy terms](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/#creating-and-assigning-taxonomy-terms) |
| F5 | `createTerm`'s `parentId` must be the parent's **row ID**: `validateParentTerm` reads it with `findById`. The stored `parent_id` is the parent's translation group | `src/api/handlers/taxonomies.ts:870-944` (`findById` at `:878`); `src/database/repositories/taxonomy.ts:161-170` |
| F6 | `ctx.taxonomies.getTerms(name, { locale })` returns every term of the taxonomy in the locale with `id`, `slug`, `label`, `parentId` (the parent's translation group) and `translationGroup`. `getEntryTerms(collection, entryId)` without a locale returns the assigned terms in every locale. `getAll()` returns the definitions with `hierarchical` and `collections`. Nothing looks a term up by path | `src/plugins/context.ts:401-438`; `src/database/repositories/taxonomy.ts:294-315`, `:728-749`; `src/plugins/types.ts:540-551`, `:663-704` |
| F7 | `handleContentGet` hydrates bylines but not taxonomy terms. It hydrates references only when `referenceOptions` is passed, and then gives the first page (50) per field with `nextCursor`, each entry carrying `id`, `slug`, `locale` and `translationGroup`. With `includeDrafts` a staged draft selection is read | `src/api/handlers/content.ts:1097-1135`, `:382-480`; `src/emdash-runtime.ts:3364-3372`; `src/references/staged.ts:50-52`; [REST: reference selections](https://docs.emdashcms.com/reference/rest-api/#reference-selections) |
| F8 | A reference field bound to a relation stores no column. Its value is refused in `data` ("set through 'references'") and lives as edges keyed by translation groups. `validation` carries `relation`, `relationSide`, `targetCollection` and `multiple`. New reference fields are always bound. An unbound legacy field keeps a TEXT column holding one ID (`z.string()`) | `src/schema/types.ts:107-125`, `:211-223`; `src/api/handlers/content.ts:671-716`; `src/api/handlers/schema.ts:587-640`; `src/schema/zod-generator.ts:203-204`; [field types: reference](https://docs.emdashcms.com/reference/field-types/#reference); [relations guide](https://docs.emdashcms.com/guides/relations/#bind-a-field-that-has-no-relation) |
| F9 | A selection is resolved before the write with `findManyByIdOrSlug` in the target collection (ID or slug in any locale; trashed entries are excluded). It is checked against the relation's limits on both ends, and order is kept on the parent side. Required bound fields must be present on create. On collections with revisions, an update stages the selection in the draft | `src/api/handlers/relations.ts:631-690`, `:844-882`; `src/database/repositories/content.ts:2378-2426`; `src/api/handlers/validate-references.ts:107-146`; `src/emdash-runtime.ts:3834-3870` |
| F10 | On collections with revisions, `data`, `slug` and `references` are draft-only, while `taxonomies` and `bylines` are written to the live row at once (`DRAFT_ONLY_UPDATE_KEYS`, `liveMetaTouched`) | `src/emdash-runtime.ts:299-307`, `:4018-4038`; [taxonomies guide: adding a term "takes effect immediately"](https://docs.emdashcms.com/guides/taxonomies/#add-one-term-to-several-posts) |
| F11 | Every content update advances `version`, so `_rev` (`version:updatedAt`) changes even when only taxonomies or bylines change | `src/database/repositories/content.ts:1030-1076`; `src/api/rev.ts:19-21` |
| F12 | `bylines` takes byline row IDs. `setContentBylines` maps them to translation groups, dedupes them, keeps their order, writes `roleLabel`, and throws a plain `Error` for an unknown ID. Credits are per content row (per locale). Hydration is strict for the entry's locale. No API creates bylines for plugins | `src/database/repositories/byline.ts:1330-1415`, `:951-1033`; `src/api/handlers/content.ts:312-353`; `src/plugins/types.ts:706-764` |
| F13 | `ctx.bylines.list({ locale, limit, cursor })` (with `bylines:read`) pages bylines newest first, at most 100 per page, with no search. `BylineInfo` has `id`, `slug`, `displayName`, `locale` and `translationGroup` | `src/plugins/byline-access.ts:106-140`; `src/plugins/types.ts:710-764`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/) |
| F14 | Capability strings: `taxonomies:read`, `taxonomies:write` (implies read), `bylines:read`. `ctx.taxonomies` and `ctx.bylines` are set only when declared. Taxonomy and byline capabilities grant no content access | `@emdash-cms/plugin-types` `dist/index.d.ts:621`; `src/plugins/context.ts:1752-1763`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/) |
| F15 | `handleContentGet` resolves its `id` argument as an ID **or a slug** (`findByIdOrSlug`) | `src/api/handlers/content.ts:1104-1108`; `src/database/repositories/content.ts:711-717` |

### Unconfirmed, proven by Task 0

- **V1.** `ctx.taxonomies` (with `createTerm`) and `ctx.bylines` are present in a **native**
  plugin's route context once declared, on Node and on workerd. The source builds them the same way
  for every plugin (F14), but the native route path has not been run with them yet.
- **V2.** On a collection with revisions, an update that sends only `taxonomies` succeeds with
  `_rev`. Its returned `_rev` then matches a fresh `handleContentGet`, so the M2 ownership check
  (`link.writtenRev === entry.rev`) still holds.
- **V3.** `handleContentGet(…, { includeDrafts: true })` returns the staged selection after an
  update on a collection with revisions, and the published selection after publish.

If any of these fails, the plan stops and the spec is amended before Task 1.

## Template additions

```json
{
	"version": 1,
	"collection": "posts",
	"locale": "en",
	"key": { "from": "id" },
	"fields": {
		"title": { "from": "Title", "type": "text" },
		"author": { "from": "AuthorKey", "type": "reference", "match": "key" },
		"related": { "from": "Related", "type": "reference", "match": "slug", "separator": "|" }
	},
	"taxonomies": {
		"category": { "from": "Categories", "match": "label", "separator": ",", "hierarchy": ">", "create": true },
		"tag": { "from": "Tags", "separator": "|" }
	},
	"bylines": { "from": "Authors", "match": "name", "separator": ";" }
}
```

Every mapping, including `taxonomies` entries and `bylines`, takes exactly one of `from` and `expr`.
Unknown keys are refused.

| Mapping | Option | Value |
| --- | --- | --- |
| `reference` field | `match` | `"id"` (default), `"slug"` or `"key"` |
| | `separator` | 1-10 characters, default `","`; used only for text values |
| `taxonomies.<name>` | `match` | `"slug"` (default) or `"label"` |
| | `separator` | 1-10 characters, default `","`; used only for text values |
| | `hierarchy` | 1-10 characters, default `"/"`; must differ from `separator`; applied only in hierarchical taxonomies |
| | `create` | boolean, default `false` |
| `bylines` | `match` | `"slug"` (default) or `"name"` |
| | `separator` | 1-10 characters, default `","` |

`taxonomies` takes at most 20 entries. Taxonomy names follow EmDash's rule (`/^[a-z][a-z0-9_]*$/`).

## Conversion rules

The M3a/M4a rules apply first. A missing path or `null` is empty. A value is an array of scalars, or
a scalar that, as text, is split on `separator`. Each item is trimmed and empty items are dropped.
An object or an array of arrays fails with `not_scalar`. Duplicates are dropped after resolution,
and the first one is kept. An empty result is `null` (see the empty rules below).

| Mapping | Item limits | Errors before lookup |
| --- | --- | --- |
| reference | at most 50 items; 1 when the field is single (parent side, `multiple` not `true`); each item 1-200 characters (`key`: 1-256, the key limit) | `not_scalar`, `too_many_items`, `required` (empty value into a required field) |
| taxonomy | at most 100 terms per taxonomy; a hierarchical item split on `hierarchy` into at most 10 segments, each trimmed and 1-200 characters, none empty (`a//b` fails) | `not_scalar`, `too_many_items`, `invalid_term_path` |
| bylines | at most 50 | `not_scalar`, `too_many_items` |

Conversion is synchronous, as in M4a. It gives lookup requests, not IDs. A new asynchronous
**resolution** step runs after `applyTemplate` and before the plan (see the batch section).

### Resolution

| What | Rule | Errors |
| --- | --- | --- |
| Term, `match: "slug"` | Flat: the term whose slug equals the item. Hierarchical path `a/b/c`: the term with slug `c`, whose parent chain must be exactly the terms with slugs `b`, `a`, with `a` a root. A one-segment item matches a term at any depth, because slugs are unique per taxonomy and locale | `term_not_found`, `term_path_mismatch` (the slug exists under another parent) |
| Term, `match: "label"` | Walk from the roots: segment 1 among root terms, segment 2 among its children, and so on, each by the label rule (exact, then a unique case-insensitive match). A flat taxonomy compares among all terms | `term_not_found`, `ambiguous_term` (two siblings match) |
| Term creation (`create: true`, real run) | Missing segments are created in order with `createTerm(name, { label, parentId: <parent row id>, locale })`. In `label` mode the label is the segment and no slug is sent (EmDash generates one). In `slug` mode the slug and the label are both the segment, and a segment that is not already a slug (the M2 `slugify(segment) !== segment`) fails `invalid_term_slug` instead. On `CONFLICT` (a concurrent creator) the terms are reloaded and the segment looked up again. In `label` mode, two jobs that create the same label at the same time can make two terms. This is documented | `term_create_failed` (any other error, with EmDash's message) |
| Term creation in a dry run | Nothing is created. The record plans the assignment, and the missing terms are listed in the row's `newTerms` | none |
| Reference `id` | `handleContentGet(target, value)` with no locale. The returned `id` must equal the value, because the handler also accepts slugs (F15) | `reference_not_found` |
| Reference `slug` | `handleContentGet(target, value, locale)`. The returned `slug` must equal the value | `reference_not_found` |
| Reference `key` | The link row `target:locale:value`, verified with `content.get`, else `findBySourceId(target, locale, value)` | `reference_not_found`, `ambiguous_source_id` |
| Byline | Slug or name in the batch's byline maps (template locale) | `byline_not_found`, `ambiguous_byline`, `byline_lookup_limit` |

Errors carry the field: the reference field's slug, `taxonomies.<name>`, or `bylines`. Every lookup
of the record is tried and all errors are collected, as in M4a. A record with any error fails
without a write.

New `ValueErrorCode`s: `term_not_found`, `term_path_mismatch`, `ambiguous_term`,
`invalid_term_path`, `invalid_term_slug`, `term_create_failed`, `reference_not_found`,
`byline_not_found`, `ambiguous_byline`, `byline_lookup_limit`. `too_many_items`, `required`,
`not_scalar` and `ambiguous_source_id` gain the cases above.

## Schema checks at job creation

`checkTemplate` gains these problems:

- A `reference` mapping into a field that is not `reference` (`COMPATIBLE.reference = ["reference"]`),
  into an unbound reference field (pointing to the docs on binding), or into a field whose target
  collection does not exist.
- `match: "key"` when the target collection has no `flux_source_id` field ("no entries were
  imported into it"), unless the target is the job's own collection (the job adds the field on its
  first real batch, so a self-referencing first import is allowed).
- The M4a `storageless` problem now applies only to non-reference mappings.
- A `taxonomies` name that has no definition in any locale, or whose definition does not list the
  collection in `collections`. EmDash itself does not check attachment on content writes (F2).
- `hierarchy` set on a flat taxonomy: a warning (stored on the job), not a problem.

The checks read the target collections' fields (`lookupFields(target)`, cached per job creation)
and `ctx.taxonomies.getAll()` once.

Snapshots stored on the job:

```ts
type TargetField = {
	// … M4a keys
	/** reference fields: */
	relationSide?: "parent" | "child";
	targetCollection?: string;
	multiple?: boolean;
};
// Job gains: taxonomies?: Record<string, { hierarchical: boolean }>;
```

`RegistryField.validation` and `listSchemaFields` are widened to carry `relation`, `relationSide`,
`targetCollection` and `multiple`.

## Diff and writes

- `MappedRecord` gains `links?: { taxonomies?: Record<string, TermRequest[]>; references?: Record<string, string[]>; bylines?: string[] | null }`.
  This holds the converted requests. Reference fields are removed from `data`. After resolution,
  `ResolvedLinks` holds, per item, the identity used for comparison (translation group, or `null`
  for a term not yet created), the value sent to EmDash (term slug, entry ID, byline ID), and a
  display text for the record log (term slug path, entry ID, byline slug).
- `ContentPort.get` gains an option `{ references?: boolean }`. When set, `EmDashContent` passes
  `{ includeDrafts: true }` and the snapshot carries `references` (groups and IDs per field). The
  snapshot also always carries the explicit bylines (group, ID, slug, `roleLabel`). A new
  `LookupPort.entryTerms(collection, entryId)` gives the assigned terms as groups per taxonomy, and
  is called only when the template maps taxonomies.
- Comparison:

  | Link | Compared as |
  | --- | --- |
  | taxonomy | set of term translation groups; any uncreated term (dry run) is a change |
  | reference, parent side | ordered list of translation groups |
  | reference, child side | set of translation groups (EmDash keeps no order there) |
  | bylines | ordered list of translation groups |

  `null` (empty value) equals an empty current selection.
- Changes: `{ field: "taxonomies.category", before: ["news"], after: ["news", "electronics/phones"] }`,
  `{ field: "related", before: [<ids>], after: [<ids>] }`, `{ field: "bylines", before: ["alex"], after: ["alex", "sam"] }`.
  `RecordRow` gains `newTerms?: string[]` (`"category: Electronics > Phones"`), set on dry runs
  (terms that would be created) and on real runs (terms created for the record).
- `ContentPort.create` / `update` gain `taxonomies`, `references` and `bylines`. Create sends every
  non-empty link. Update sends only the changed links, and sends `data` (and slug) only when a data
  field or the slug changed. `bylines` keeps the current `roleLabel` for bylines that stay.
- Write errors: an unknown term or reference that disappeared after resolution comes back as
  `emdash_validation_error` / `emdash_not_found`. An unknown byline ID (a plain `Error` inside the
  transaction) comes back with the handler's generic code, prefixed `emdash_` as in M2.

## Batch integration

`processRecord` → `decide` becomes: filter → `applyTemplate` → **`resolveLinks(lookups, cache,
job, mapped, { dryRun })`** → link lookup → `content.get` (with references when mapped) and
`entryTerms` (when taxonomies are mapped) → `planRecord` → write. `runBatch` creates the per-batch
`LookupCache`. `EngineDeps` gains `lookups: LookupPort`:

```ts
interface LookupPort {
	taxonomyDefs(): Promise<{ name: string; hierarchical: boolean; collections: string[] }[]>;
	terms(taxonomy: string, locale: string): Promise<TermInfo[]>;
	createTerm(taxonomy: string, input: { label: string; slug?: string; parentId?: string; locale: string }): Promise<TermInfo>;
	entryTerms(collection: string, entryId: string): Promise<Record<string, string[]>>; // groups
	bylines(locale: string, cursor?: string): Promise<{ items: BylineRef[]; cursor?: string }>;
	findEntry(collection: string, by: "id" | "slug", value: string, locale: string): Promise<{ id: string; group: string } | null>;
}
```

`EmDashLookups` implements it over `ctx.taxonomies`, `ctx.bylines` and the runtime. Jobs created
before M4b have no `taxonomies`/`bylines` keys and behave as before.

## Testing

- **Unit, conversion:** arrays and separated text, trimming, empty items, duplicates, limits
  (51 references, 2 into a single field, 101 terms, 11 segments), `a//b`, `hierarchy` equal to
  `separator` refused, a flat taxonomy not split, required empty reference.
- **Unit, resolution:** slug flat and path (`term_path_mismatch`), label exact and case-insensitive,
  ambiguous siblings, creation of a chain (parent row IDs passed, `label` mode with no slug, `slug`
  mode refusing a non-slug), `CONFLICT` re-read, dry run creating nothing and listing `newTerms`;
  references by ID (a slug passed to `id` mode is not found), slug in locale, key via link and via
  `flux_source_id`, misses not cached, hits cached; bylines by slug and name, ambiguous names, the
  5,000 limit.
- **Unit, schema checks:** reference compatibility, unbound field, missing target, `key` without
  `flux_source_id`, unknown and unattached taxonomy, `hierarchy` warning on a flat taxonomy.
- **Unit, diff and writes:** set vs ordered comparison, child-side sets, `null` against empty,
  update with only links omits `data`, role labels kept, create sends links.
- **Integration on `sites/dev`:** fixtures through the REST API: a hierarchical `category` and a flat
  `tag` attached to a test collection (`/_emdash/api/taxonomies`), an `authors` collection imported
  first by flux-import (for `key`), a bound single reference and a bound multiple reference field
  (schema API with `targetCollection`), two bylines (`/_emdash/api/admin/bylines`). Then:
  - a CSV import with label paths and `create: true` builds the tree, and a re-run is `unchanged`;
  - a JSON import with arrays;
  - a dry run reports `term_not_found` and `reference_not_found` and `newTerms` without writing;
  - a forward `key` reference fails and then succeeds on `jobs/retry`;
  - a revisioned collection with `publish: false`: terms live at once and the references staged
    (read back through the content API);
  - an empty value clears a taxonomy.
- **Cloudflare parity on `sites/dev-cf`:** one import with a created term path, a `key` reference
  and a byline on D1, plus a re-run `unchanged`.

## Plan sizing

About nine tasks: (0) prove V1-V3; (1) template schema and conversion; (2) schema checks and
snapshots; (3) `LookupPort` and `EmDashLookups`; (4) resolver and per-batch cache; (5)
`ContentPort` read-back and write extensions; (6) diff, batch integration, `newTerms`, Workers cap;
(7) capabilities, route wiring, `schema/apply` conflict reporting; (8) integration and parity tests,
review note. If it runs long, bylines (in tasks 1, 3, 4 and 6) can move to a follow-up without
affecting the rest.

## Out of scope for M4b

Creating bylines, taxonomy definitions, relations or reference fields; attaching taxonomies to
collections; unbound (legacy) reference fields; more than 50 references per field; byline role
labels from the source; term descriptions and term translations; additive "keep existing terms"
mode (M5 "update only these fields"); `translationOf` and per-locale lookups other than the
template's locale (M4e); media (M4c); Portable Text (M4d).
