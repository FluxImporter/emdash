# Flux Import M4e: locales and translation links

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Fifth and last part of Milestone 4 (Field types and schema) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-4-split). Builds on M4d
([spec](./2026-11-02-flux-import-m4d-portable-text-design.md),
[review](../notes/2026-11-02-m4d-review.md)), merged at `10b73e5`.

## Goal

Import translations of entries as EmDash translations, one template (and one job) per locale:

- A template keeps its single `locale`. A new optional `translationOf` mapping names the column that
  holds the **source key** of the entry this record translates, and the locale that entry lives in
  (`translationOf.locale`, the site's default locale when left out).
- The importer finds the source entry by that key the way M4b finds a `match: "key"` reference
  (link row, then `flux_source_id`), and creates the record's entry with EmDash's `translationOf`,
  so it joins the source's translation group.
- Values EmDash shares across a translation group are **left to EmDash**: for a record that names a
  source, non-translatable fields, reference fields and taxonomies are not read, converted, resolved,
  downloaded, compared or written. EmDash copies non-translatable values from the source when it
  creates the translation, and keeps them in sync afterwards. The job lists the skipped mappings in
  one warning.
- A record with an empty `translationOf` value is imported as an entry of its own (a new group), as
  every record is today, unless its existing entry is already a translation (then it fails, see
  Decisions).

A dry run resolves the source and checks the group, and writes nothing. The template stays
`version: 1` and the addition is optional. Templates without `translationOf` behave exactly as in
M4a–M4d.

## Decisions

| Topic | Decision |
| --- | --- |
| Template shape | One template per locale, as since M2: `locale` stays a single string. `translationOf: { from \| expr, locale? }` at the top level, next to `key` and `slug`, because it is not a collection field. Its value is a source key in `translationOf.locale`. A per-record locale column, or one job importing several locales, is out of scope: each locale is its own job on the same file or on a per-locale file. |
| Source locale | `translationOf.locale` is resolved at job creation like `locale` (`resolveSiteLocale`, configured casing) and stored in the job's template. Left out, it is the site's default locale (`getI18nConfig().defaultLocale`, F9). It must differ from `locale`. One source locale per template. |
| i18n required | A template that maps `translationOf` needs i18n with at least two locales (`isI18nEnabled()`, F9). Without it EmDash never syncs non-translatable fields (F6, F7), so a translation would keep the values it was created with forever. Job creation refuses it (`invalid_template`, "translationOf needs i18n with at least two locales"). |
| Source lookup | By source key only, in the template's collection and the source locale: the link row `collection:sourceLocale:key`, verified with `content.get`, else `findBySourceId(collection, sourceLocale, key)`, as M4b's `findReference` for `match: "key"`. `match: "id"` and `"slug"` for the source are out of scope (YAGNI): every source the importer can link is one it imported, and that is what the roadmap asks. EmDash only accepts a source in the same collection (F1), so there is no target collection to choose. |
| The value | Read right after the key, with the key's rules: scalar text, trimmed, at most 256 characters (`not_scalar`, `key_too_long` with field `translationOf`). Blank or missing is "no source". The value alone decides, per record, whether the shared mappings are skipped (below). |
| Shared values | For a record with a value, the template's **shared mappings** are skipped: fields whose snapshot says `translatable: false`, every `reference` field (edges are keyed by translation group, F4), and every `taxonomies` entry (assignments are keyed by translation group, F4). They are not read or converted, so an empty or bad value in them cannot fail the record, no term is created and no media is downloaded for them. Writing them from a translation would change the source and every other locale (F6, F7). Bylines (per row, F5), the slug (per locale, F8) and translatable fields are written as usual. |
| Shared values warning | One job warning at creation when a template maps `translationOf` and any shared mapping, for example: `Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price"; reference field "related"; taxonomies "category"`. No per-record warning, because every translated record would carry the same one. |
| Records without a value | Every mapping is converted and written, as today; the entry becomes the first of its own group, and its shared values sync to translations added to it later. A required non-translatable field with no default that the template does not map is not a template problem when `translationOf` is mapped (linked records get it from the source), but a record without a value fails `required` for it before any write. |
| Source missing | A record with a value whose source is not found, and that has no entry yet, **fails** `translation_source_not_found`. It is not created on its own: EmDash links translations only on create (F2), so an entry created alone could never join the group later. It is not deferred: nothing guarantees the source job runs, so a deferral could block the job forever. `jobs/retry` (or a re-run) after the source locale's job has run creates it. This is the M4b rule for forward references. |
| Source in the same job, another job | The source can never be in the same job, because its locale differs from the job's. It must have been written by another (real) job, earlier. Two jobs running at the same time: records whose source does not exist yet fail as above and are retried. Documented as "import the source locale first". |
| Source missing for an existing entry | The record has an entry already (from an earlier run): the update goes ahead over its translatable mappings, with a `translation_source_not_found` **warning**. The source is only needed for the group check, and a source deleted in the admin should not freeze its translations. |
| Group check | When the entry exists and the source is found, the entry's translation group must equal the source's. If not (the entry was created on its own by an earlier run without a value, or the feed now names another source), the record gets a `translation_not_linked` warning and is updated, without its shared mappings. EmDash cannot move an entry into another group: `translation_group` is a system column and the update path has no `translationOf` (F2). The warning says to trash the entry so the next run creates it as a translation. |
| Value removed from a translation | A record without a value whose existing entry is a translation of another entry (its group is not its own ID, F3) **fails** `translation_of_missing`: its shared values would overwrite the source's and the whole group's. A feed that drops the column for linked rows has to keep it. |
| Existing translation | Before planning a create, the importer reads the source's group (`handleContentTranslations`, F10). If it already has an entry in the job's locale (an editor's translation, or one a cancelled job left without a link), the record fails `translation_exists` with that entry's ID. Adopting it is out of scope: its `flux_source_id` is the source's (F1), so the importer cannot tell its own entry from an editor's. A `CONFLICT` from the create itself (a race) is mapped to the same code after the same read. |
| Writes | A linked create sends `translationOf: <source entry ID>`, the translatable data, the slug when mapped, `flux_source_id: <the translationOf value>` (the value EmDash copies from the source anyway, F1; sent so the stored value is the same on a collection whose `flux_source_id` is translatable, M2 review), no `taxonomies` and no `references`. When the template maps `bylines`, the create always sends them, an empty list included, because EmDash copies the source's credits when `bylines` is left out (F5) and the next run would then plan an update to clear them. Without a `bylines` mapping the copied credits stay and are never compared. Updates of linked records send only the translatable data, the slug and the bylines. |
| Crash repair | A linked entry's `flux_source_id` is the source key, not the record's key (F1). Crash repair (an earlier row of this job, no link) therefore looks the entry up with `findBySourceId(collection, locale, <translationOf value>)` for a record with a value, and with the record's key otherwise. The link row stays keyed by the record's own key (`collection:locale:key`). The unique index on (group, locale) (F8) means a missed repair ends in `translation_exists`, never a duplicate. |
| Diff | Shared mappings of a linked record are not in the mapped record, so they are never compared and never in `changes`. A planned linked create adds `{ field: "translationOf", before: null, after: "en: SKU-1" }`. An existing entry in the right group adds nothing, so a re-run plans `unchanged`. |
| Dry run | The same lookups as a real run (link row, `flux_source_id` when the collection already has the field, the group read), and no write. A missing source fails the record in a dry run too. A dry run cannot see what a dry run of the source locale would create (documented): dry-run the source locale for real first, or accept the failures. |
| Publish | Unchanged. EmDash creates the translation as a draft (`status: "draft"` default, F11); with `publish: true` the importer publishes it as every other create. Each locale's status is its own. |
| Fallback | Not used. Every lookup of the importer names one locale exactly. EmDash's fallback chain applies only to single-entry queries in templates (F12), never to writes, and a missing source is never taken from a fallback locale. |
| References (M4b) | Skipped for linked records (shared). For records without a value they resolve in the job's locale as in M4b. A `match: "key"` reference from another template to an entry this milestone created finds it through its link row; the `flux_source_id` fallback finds it by its source's key, not its own (documented). |
| Taxonomies and bylines (M4b) | Taxonomies are skipped for linked records (shared); a created translation shares the source's terms (F4). Bylines are per row and looked up in the job's locale, as in M4b. Linking term translations (`createTerm` takes `translationOf`, F13) stays out of scope. |
| Media (M4c, M4d) | Unchanged per locale: the media map is locale-free, so the same URL in the source's and the translation's feed is downloaded once. A non-translatable `image`, `file` or `portableText` field is a shared mapping and is skipped for linked records, so nothing is downloaded for it. |
| Lookup cost | `usesLinks` is true for a template that maps `translationOf`: `COST_RECORD` per record and the Workers batch cap `WORKERS_LINKED_BATCH_CAP` (10). The source costs `COST_CALL` (link row) plus `COST_READ` per content read, and the group read before a create `COST_READ`. Source hits are cached per batch by (collection, source locale, key); misses are not cached, as in M4b. |
| `schema/apply` | Unchanged. It already takes `translatable` per requested field (M4a). |
| Capabilities | Unchanged. `handleContentTranslations` is on the trusted runtime the plugin already uses. |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`) and the docs on 2026-11-03.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | `handleContentCreate` takes `translationOf` (the source's row ID). It reads the source with `findById` in the same collection (trashed excluded; missing is `NOT_FOUND`), refuses a locale the source's group already has (`CONFLICT`, "Translation already exists in locale …"), and replaces every non-translatable, non-storageless field in the data with the source's value (removing it when the source has none), after `beforeSave` hooks and before validation. So a supplied non-translatable value, `flux_source_id` included, never wins. The insert is `INSERT … SELECT … FROM <table> AS translation_source WHERE id = ? AND deleted_at IS NULL`, one statement | `src/emdash-runtime.ts:3455-3471`, `:3488-3528`, `:3554-3563`; `src/database/repositories/content.ts:469-486`, `:503-507`, `:615-630`; [capabilities: creating and translating content](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/#creating-and-translating-content) |
| F2 | Translations are linked only on create. `translation_group` (and `locale`) are system columns that `data` cannot set, and `handleContentUpdate` has no `translationOf` | `src/database/repositories/content.ts:280-292`; `src/emdash-runtime.ts:3649-3679` |
| F3 | A create without `translationOf` sets `translation_group` to the new row's own ID; with it, to `COALESCE(source.translation_group, source.id)`. So an entry whose group differs from its ID is a translation of another entry | `src/database/repositories/content.ts:419-441`, `:469-472` |
| F4 | Taxonomy assignments and reference edges are keyed by translation group: a translation shares the source's terms and selections, a `taxonomies` or `references` write from any locale replaces them for the whole group, and a required reference field is not demanded on a translation create | `src/api/handlers/content.ts:1279-1282`, `:1372-1391`; `src/api/handlers/validate-references.ts:127-135`; M4b F3, F8; [i18n guide: translatable fields](https://docs.emdashcms.com/guides/internationalization/#choose-which-fields-are-translatable) |
| F5 | Byline credits are per row. A translation create copies the source's credits only when `bylines` is `undefined`; an explicit list (also `[]`) is written instead | `src/api/handlers/content.ts:1343-1353`; M4b F12 |
| F6 | An update that sends `data` copies the non-translatable fields **present in `data`** to every other row of the group, when i18n is enabled. A sibling that already holds the value is left untouched; on revisioned collections a changed sibling gets a new live revision, and a pending draft takes the value only where it still holds the previous one | `src/api/handlers/content.ts:1646-1655`; `src/database/repositories/content.ts:1457-1515`; [i18n guide](https://docs.emdashcms.com/guides/internationalization/#choose-which-fields-are-translatable) |
| F7 | On revisioned collections publishing copies the non-translatable values that changed between the live and the published state to the group, when i18n is enabled | `src/api/handlers/content.ts:2451-2462` |
| F8 | Slugs are unique per (slug, locale); a generated slug is made unique within the entry's locale. One active entry per (translation group, locale): unique index on `(translation_group, lower(locale)) WHERE deleted_at IS NULL` | `src/schema/registry.ts:1906`, `:1970-1972`; `src/database/repositories/content.ts:516-530`; `src/api/handlers/content.ts:1301-1311`, `:1436-1449` |
| F9 | i18n comes from Astro's `i18n` config: `getI18nConfig()` (`defaultLocale`, `locales`, `fallback`), stored in a `globalThis` symbol store, so a second copy of `emdash` sees it; `isI18nEnabled()` is true with more than one locale; `resolveContentCreateLocale` matches configured locales without case and refuses others when i18n is configured. All are exported from `emdash` | `src/i18n/config.ts:17-37`, `:54-85`; `src/index.ts:195-200`; [i18n guide: configure locales](https://docs.emdashcms.com/guides/internationalization/#configure-locales) |
| F10 | `handleContentTranslations(collection, id)` on the runtime returns `{ translationGroup, translations: [{ id, locale, slug, status, updatedAt }] }` for the group's active rows (REST `GET /content/{collection}/{id}/translations`, MCP `content_translations`) | `src/emdash-runtime.ts:4776-4777`; `src/api/handlers/content.ts:2777-2840`; `src/database/repositories/content.ts:2278-2290`; [i18n guide: listing translations](https://docs.emdashcms.com/guides/internationalization/#listing-translations) |
| F11 | Names: REST and runtime bodies say `translationOf`; content items carry `translationGroup` and `locale`; the table column is `translation_group`. A create without `status` is a draft | `src/api/schemas/content.ts:236`; `src/emdash-runtime.ts:594`; `src/api/handlers/content.ts:1320-1331` |
| F12 | Fallback (`getFallbackChain`, `fallback` in the config) applies to single-entry queries (`getEmDashEntry`) only; list queries return one locale | `src/i18n/config.ts:92-115`; [i18n guide: fallback chain](https://docs.emdashcms.com/guides/internationalization/#fallback-chain) |
| F13 | Fields carry `translatable: boolean` (default `true`); `createTerm` input also accepts `translationOf` | `src/schema/types.ts:341-342`; `src/plugins/types.ts:561-568` |

The docs say the admin's **Translate** pre-fills translatable fields from the source and keeps the
slug. The runtime create does neither (F1 copies only non-translatable fields), so a translation
template must map every translatable field it needs, and `checkTemplate`'s required-field check
stays as it is for translatable fields.

### Unconfirmed, proven by Task 0

- **V1.** A create through the trusted runtime with `translationOf` joins the source's group on Node
  (SQLite) and workerd (D1): the new entry's `translationGroup` is the source's, its non-translatable
  fields and `flux_source_id` hold the source's values although others were sent, it reads the
  source's taxonomy terms (`entryTerms`) and reference selection, it has the source's byline credits
  when `bylines` is left out and none when `bylines: []` is sent, and `handleContentGet` returns
  `translationGroup === id` for the source and not for the translation (F3).
- **V2.** A second create for the same group and locale returns `CONFLICT`;
  `handleContentTranslations` lists the group with IDs and locales; a trashed source returns
  `NOT_FOUND`; a trashed translation does not block a new one.
- **V3.** An update of a translation whose `data` holds no non-translatable field, and a publish of a
  new translation, leave the source's `_rev` and `updatedAt` unchanged, on a collection without
  revisions and on one with revisions. Without this a translation job's run would make the source
  job's next run report conflicts.
- **V4.** An update of the source that changes a non-translatable field reaches the translation
  (F6, F7). Recorded, not required: whether the translation's `_rev` moves, and what the
  translation job's next run reports when the translation has the importer's pending draft
  (`publish: false`) at that moment.
- **V5.** With `i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] }` in `sites/dev` and
  `sites/dev-cf`, the existing integration and parity suites still pass, and `getI18nConfig()` /
  `isI18nEnabled()` return the configuration inside a plugin route on Node and on workerd.
- **V6.** `handleContentList(collection, { locale: "fr", fieldFilters: { flux_source_id: <source key> } })`
  finds the French translation (the basis of crash repair for linked records), on Node and workerd.

If V1, V3 or V6 fail, the plan stops and the spec is amended before Task 1. If V5 breaks existing
tests, the sites get an `FLUX_DEV_I18N=1` switch and the locale tests start their own server with it.
V4 only feeds the review's open issues.

## Template additions

```json
{
	"version": 1,
	"source": { "format": "csv" },
	"collection": "products",
	"locale": "fr",
	"key": { "from": "id" },
	"translationOf": { "from": "en_id", "locale": "en" },
	"slug": { "from": "handle" },
	"fields": {
		"title": { "from": "Nom", "type": "text" },
		"body": { "from": "Description", "type": "portableText", "format": "html" },
		"price": { "from": "Prix", "type": "number", "decimal": "," }
	}
}
```

With `price` non-translatable, the job warns once that records with a `translationOf` value leave
`price` to EmDash. A row whose `en_id` is empty becomes a French entry of its own, `price` included.
When the French feed uses the same key as the English one, `key` and `translationOf` read the same
column.

| Option | Value |
| --- | --- |
| `translationOf.from` / `expr` | Exactly one, as for `key` |
| `translationOf.locale` | A configured locale other than `locale`; default the site's default locale |

Job creation (`startJob`, `createJob`) adds:

- `translationOf.locale` resolved (or defaulted) through the same resolver as `locale`; problems:
  i18n not enabled, the locale not configured, equal to `locale`, or left out while `locale` is the
  default locale.
- `SchemaField` and `TargetField` gain `translatable?: false` (from `Field.translatable`, F13, only
  recorded when false), read by `listSchemaFields`.
- `checkTemplate` exempts required, non-translatable, unmapped fields without a default when the
  template maps `translationOf`; `createJob` stores them as `Job.sharedRequired` for the per-record
  `required` check of records without a value.
- The shared-values job warning (Decisions), next to `linkWarnings`.
- `usesLinks` returns true for `translationOf`.

## Resolution, diff and writes

`applyTemplate` reads `translationOf` after the key. `MappedRecord` gains
`translationOf?: string` (the trimmed value, absent when blank). With a value, the shared mappings
(`job.targetFields[field].translatable === false`, `reference` fields, `taxonomies`) are not read;
without one, `Job.sharedRequired` fields fail `required`. `CompiledTemplate` keeps the shared set,
built once per batch from the job's snapshot.

`decideRecord`, for a template that maps `translationOf`:

1. **Source.** With a value, `findTranslationSource(collection, sourceLocale, value)` next to the
   link resolution: `{ id, group } | null`. `ambiguous_source_id` and EmDash read errors are record
   errors, collected with the others. A miss is kept until the entry is known.
2. **Entry.** As today (link row, crash repair). Crash repair looks up the `translationOf` value as the
   `flux_source_id` when the record has one.
3. **Decide.**

   | Value | Entry | Source | Result |
   | --- | --- | --- | --- |
   | given | none | not found | `failed`, `translation_source_not_found` |
   | given | none | found, group has an entry in the job's locale | `failed`, `translation_exists` (that entry's ID in the message) |
   | given | none | found | plan `create` with the `translationOf` change |
   | given | exists | not found | plan over translatable mappings; warning `translation_source_not_found` |
   | given | exists | found, other group | plan over translatable mappings; warning `translation_not_linked` |
   | given | exists | found, same group | plan over translatable mappings |
   | blank | none | — | plan `create`, all mappings (an entry of its own) |
   | blank | exists, group is not its ID | — | `failed`, `translation_of_missing` |
   | blank | exists, its own group | — | plan over all mappings (as today) |

   The `translation_exists` read happens in dry runs too, and only for planned creates.
4. **Downloads, pending-draft and lock checks, publish.** Unchanged (M2-M4d); the skipped mappings
   produce no lookups or downloads.
5. **Write.** `content.create` gains `translationOf?: string` (the source's entry ID). A linked
   create: data without shared mappings, `flux_source_id` set to the `translationOf` value, no
   `taxonomies` or `references`, `bylines` always sent when mapped. An `emdash_conflict` from a
   linked create re-reads the group: an entry in the job's locale makes the record
   `translation_exists`; an `emdash_not_found` makes it `translation_source_not_found`.

| Code | Kind | When |
| --- | --- | --- |
| `translation_source_not_found` | error on create, warning on update | No entry in the source locale has the key |
| `translation_exists` | error | The source's group already has an entry in the job's locale that is not this record's |
| `translation_of_missing` | error | A record without a value whose entry is a translation of another entry |
| `translation_not_linked` | warning | The entry exists but is not in the source's group; EmDash cannot move it |
| `ambiguous_source_id` | error | More than one entry in the source locale has the key (as M2) |
| `not_scalar`, `key_too_long` | error | The value, field `translationOf` |
| `required` | error | A record without a value and an unmapped required non-translatable field |

Ports and engine types:

```ts
// ContentPort.create input gains: translationOf?: string
// ContentPort gains:
//   translations(collection: string, id: string): Promise<{ id: string; locale: string }[]>
//   (handleContentTranslations; NOT_FOUND is [])
// ContentRuntime: handleContentCreate body gains translationOf?: string; gains
//   handleContentTranslations(collection: string, id: string): Promise<HandlerResult>
// Template gains: translationOf?: { from?: string; expr?: string; locale?: string }
//   (locale always set on a stored job)
// MappedRecord gains: translationOf?: string
// SchemaField, TargetField gain: translatable?: false
// Job gains: sharedRequired?: string[]
```

Re-runs: a linked record in the right group compares only its translatable mappings and plans
`unchanged` when they hold. When the source job later changes a shared value, EmDash syncs it into
the translation (F6, F7); the translation job does not compare it, so its next run is still
`unchanged` (V4 records whether the translation's `_rev` moves). `jobs/retry` re-processes
`translation_source_not_found` and `translation_exists` records like every other failure.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `translationOf` value | 256 characters, the key limit | It is a source key |
| Source locales | One per template | One template per locale (roadmap) |
| Extra reads per record | Link row, at most two content reads for the source, one group read per planned create | Within the M4b lookup budget; source hits are cached per batch |
| Workers batch | `WORKERS_LINKED_BATCH_CAP` (10) | As for every template with links |

No new size limits.

## Testing

- **Unit, template:** the `translationOf` schema (one of `from`/`expr`, strict); the default and
  resolved source locale; refused without i18n, for an unconfigured locale, for `locale` itself;
  the value's rules (trim, blank, `not_scalar`, `key_too_long`); shared mappings skipped for a
  record with a value, including a required non-translatable field with an empty value that does not
  fail it; `required` for `sharedRequired` on a record without a value; the `checkTemplate`
  exemption; the shared-values warning text; `usesLinks`.
- **Unit, engine (fakes):** every row of the decision table; source by link row, by
  `flux_source_id`, not found, ambiguous, dry run without the field (link rows only); the batch
  cache; the create input (`translationOf`, `flux_source_id` from the value, no `taxonomies` or
  `references`, `bylines: []` for a mapped empty value); a `CONFLICT` and a `NOT_FOUND` from the
  create mapped to their codes; crash repair by the value; the `translationOf` change on a planned
  create and none on a re-run; no media lookups or downloads for a skipped image field.
- **Integration on `sites/dev`** with i18n (`en`, `fr`, `de`), a `products` collection with
  non-translatable `sku` and `price`, a translatable `image` field, a taxonomy and a reference
  field: an English job, then a French job whose rows name English keys, gives French entries in
  the English groups (`/translations`) with the English `sku` and `price`, the English terms, their
  own title, slug and image (downloaded once when the URL is shared); a re-run of the French job is
  `unchanged`; an English re-run with a new price syncs it into the French entries and a French
  re-run stays `unchanged`; French rows whose source does not exist fail, and `jobs/retry` after the
  English job creates them; a French dry run plans creates with the `translationOf` change and
  writes nothing; an editor's French translation makes `translation_exists`; a row with an empty
  value becomes a French entry of its own with its own price; removing the value of a linked row
  fails `translation_of_missing`; a German job linking to the same English entries; a revisioned
  collection with `publish: false` then `publish: true`; kill-and-resume after a linked create and
  before its link is saved repairs the link and creates no second entry.
- **Cloudflare parity on `sites/dev-cf`:** an English and a French job into D1: the group is linked,
  the shared values come from the source, a French re-run is `unchanged`, and a missing source fails
  and is created by `jobs/retry`.

## Plan sizing

About seven tasks: (0) prove V1-V6 and add i18n to both sites; (1) template schema, locale
resolution and defaulting, i18n check, `translatable` in the field snapshots, `checkTemplate`
exemption, `sharedRequired`, the job warning, `usesLinks`; (2) `applyTemplate`: the value and the
shared-mapping skip; (3) ports and adapter: `translationOf` on create, `translations`; (4) source
resolution with cache and costs, the decision table, crash repair by value; (5) writes, error
mapping, the diff change; (6) integration and parity tests, and the review note.

## Out of scope for M4e

A per-record locale column and several locales in one job; finding the source by entry ID or slug;
linking an existing entry into a group, moving an entry between groups, or unlinking one (EmDash
1.2.0 cannot, F2); adopting an existing translation; a translation template that writes shared
values; translations across collections (EmDash links only within one collection, F1); term,
byline and menu translations (`createTerm` takes `translationOf`, F13, but terms are looked up in
the job's locale only, as in M4b); locale fallback for lookups; foreseeing a source that a dry run of
the source locale would create. The production Cloudflare build blocker from M2 still stands.

## Open issues carried forward

- **New in this design.**
  - A translation whose source was deleted keeps the source's group ID, so its shared values never
    change again, and a record for it without a value fails `translation_of_missing`.
  - `translation_not_linked` and the missing-source warning repeat on every run until the entry is
    trashed or the source returns.
  - The `flux_source_id` fallback of a `match: "key"` reference finds a translation by its source's
    key, not its own.
  - The M2 cross-job duplicate window (M2 review, issue 5) becomes `translation_exists` for linked
    records instead of a duplicate; for records without a value it is unchanged.
  - V4's outcome: if a sync moves the translation's `_rev`, a translation with the importer's
    pending draft reports `pending_draft` on its next run.
- **From M4d** (`2026-11-02-m4d-review.md`), unchanged: a persistently failing image re-plans
  `update`; refresh on a shared URL converges after one extra update; a field-dependent type
  refusal is fetched once per record; the open-block JSON estimate leaves out link definitions;
  later fields' warnings are lost past the record's JSON budget; no integration test for the `text`
  format or the editor round trip; the known flakes (WSL clock step, the unexplained workerd
  `500 INTERNAL_ERROR`, port-in-use from Windows processes); the M4d known gaps and the M4c
  carry-overs listed there.
- **From M4b** (`2026-10-27-m4b-review.md`): term translations are still not linked (now an explicit
  out-of-scope item above); the rest unchanged.
- The M2-M4a open issues (`2026-10-08-m2-review.md` through `2026-10-27-m4a-review.md`) are
  unchanged.
