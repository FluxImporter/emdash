# Flux Import M4a: scalar field types and `schema/apply`

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). First part of Milestone 4 (Field types and schema) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-4-split). Builds on M3a-M3d
(sources, filters and expressions, URL sources, XLSX), merged at `f3f3a23`.

## Goal

Map source values into every EmDash field type that holds a plain value, with no external objects:
`boolean`, `select`, `multiSelect`, `datetime` (with a site or IANA timezone, or into a text field
as a calendar date), `number` and `integer` (with locale separators), `json` and custom `slug`
fields. The importer checks each value against the target field's EmDash rules before it writes, so
a dry run reports the failures a real run would hit. An additive `schema/apply` route creates
missing fields and adds select options, so a template can be made to fit a collection without the
admin. Template stays `version: 1`; every addition is optional.

## Decisions

| Topic | Decision |
| --- | --- |
| Mapping types | New `type` values in `fields`: `boolean`, `select`, `multiSelect`, `json`, `slug`. `text`, `number` and `date` gain options. Names follow EmDash field types where they match (`select`, `multiSelect`, `json`, `slug`); `text`, `number` and `date` keep their M2 names. |
| Field rules | At job creation the importer reads the target fields and stores a snapshot of their type, `required` and the `validation` keys EmDash enforces (`options`, `min`, `max`, `minLength`, `maxLength`, `pattern`) on the job (`targetFields`). Each record is checked against the snapshot. EmDash still validates every write; a failure it reports and the importer did not catch stays `emdash_validation_error`. A schema change after job creation is picked up by a new job, not by `jobs/next` or `jobs/retry`. Jobs created before M4a have no snapshot and keep M2 behaviour. |
| Site timezone | `tz: "site"` uses the site's timezone setting (`getSiteSetting("timezone")`, fallback `UTC`), read once at job creation and stored on the job (`siteTimezone`), so a resumed or retried job converts the same way. Default `tz` stays `UTC`. |
| Datetime storage | Into a `datetime` field the value is written as EmDash's canonical form, UTC with three-digit milliseconds (`2025-01-24T12:00:00.000Z`). Into a `string` or `text` field the value is formatted in the mapping's timezone with `output` (default `yyyy-MM-dd`), the calendar-date shape EmDash's docs recommend for non-instants. |
| DST | A local time that does not exist in the timezone (spring-forward gap) fails with `invalid_date`. An ambiguous local time (fall-back overlap) takes the earlier instant. EmDash rejects both for naive API input; the importer converts before EmDash sees the value, and an overlap is common in real exports, so it is accepted and documented. |
| Booleans | Case-insensitive token lists, defaults `true, yes, y, 1, on` / `false, no, n, 0, off`, replaceable per mapping. JSON booleans pass; JSON `1`/`0` map to `true`/`false`. |
| Select matching | `map` (source value to option) first, then the field's options, case-insensitive by default (`ignoreCase: true`) with the stored value being the option as defined. No match fails with `invalid_option`. A field without options accepts any non-empty string, as EmDash does. |
| Integers | A `number` mapping into an `integer` field must give a whole number within ±2^53-1; no rounding (`invalid_integer`). Expressions can round (`$round`). |
| JSON | Objects, arrays, numbers and booleans pass as they are; strings are parsed as JSON text by default. At most 1 MiB serialised. |
| Diff | Type-aware: booleans compare with EmDash's stored `0`/`1`, `multiSelect` and `json` compare deeply (object keys in any order, arrays in order), datetimes as instants. |
| `schema/apply` | Additive only: creates missing fields and adds missing select options. Never changes a field's type, removes or renames anything, or creates a required, unique or defaulted field. A field of another type is reported as a conflict and left alone. Dry run returns the plan. Fields are created with `SchemaRegistry.createField`, the M2 path for `flux_source_id`. |
| Field types not in M4a | `portableText`, `image`, `file`, `reference`, `repeater` and `blocks` cannot be mapped or created in M4a (M4b-M4d add the first four; `repeater` and `blocks` are out of scope for v1). |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`) and the docs on 2026-10-27.

| Fact | Evidence |
| --- | --- |
| 17 field types; column types: `boolean` INTEGER, `datetime` TEXT, `select` TEXT, `multiSelect` JSON, `json` JSON, `slug` TEXT, `integer` INTEGER, `number` REAL | `src/schema/types.ts:13-31`, `:80-98`; [field types reference](https://docs.emdashcms.com/reference/field-types/) |
| Writes are validated by a Zod schema generated from the fields: `boolean` accepts `true`/`false` (and `0`/`1`); `datetime` needs `Z` or an offset; `select`/`multiSelect` are enums when `validation.options` is non-empty, any string otherwise; `integer` is `z.number().int()`; `string`, `text`, `slug` are `z.string()` with `minLength`, `maxLength`, `pattern`; `number`/`integer` take `min`, `max`; `json` is unchecked; non-required fields are nullish | `src/schema/zod-generator.ts:41-66` (required, nullish), `:81-210` (base schemas), `:240-290` (validation rules) |
| The trusted create path validates the full record (`partial: false`), so required fields must be present on create; update validates partially; `""` counts as missing for a required field; errors come back as `VALIDATION_ERROR` with `details.issues` | `src/emdash-runtime.ts:3605-3608` (create), `:3816-3818`, `:3916-3918` (update, `partial: true`); `src/api/handlers/validation.ts:149-330` |
| Booleans are stored as `0`/`1` and read back as numbers; objects and arrays are stored with `JSON.stringify` and read back parsed; strings are stored as they are, and a stored string that starts with `{` or `[` and parses as JSON is read back parsed | `src/database/repositories/content.ts:317-356`; comment at `src/schema/zod-generator.ts:106-115` |
| Datetimes are normalised to `toISOString()` UTC; naive values are resolved in the `site:timezone` option and rejected when ambiguous or nonexistent | `src/datetime-normalization.ts:207-258`; `src/database/content-datetime.ts:80-100`; [field types reference, datetime](https://docs.emdashcms.com/reference/field-types/#datetime) |
| The site timezone is readable with `getSiteSetting("timezone")` from `emdash` | `src/settings/index.ts:182-203`, `src/settings/types.ts:67`; [Site settings guide](https://docs.emdashcms.com/guides/site-settings/#read-one-setting) |
| The `slug` field type does not generate or sanitise its value | [field types reference, slug](https://docs.emdashcms.com/reference/field-types/#slug); `src/schema/zod-generator.ts:95-98` |
| `SchemaRegistry.createField(collection, CreateFieldInput)` validates the slug (`/^[a-z][a-z0-9_]*$/`, at most 63), rejects reserved slugs (`RESERVED_SLUG`) and existing fields (`FIELD_EXISTS`), checks `indexed` against the indexable types (`FIELD_NOT_INDEXABLE`), and adds the column; `updateField` replaces `validation` as a whole | `src/schema/registry.ts:1276-1415`, `:1417-1600`, `:160-178`; `src/schema/slug.ts:6-9`; `src/schema/types.ts:56-66`, `:462-482` |
| The REST field-create handler also clears caches (`invalidateCollectionCache`, `invalidateSchemaObjectCache`); both are exported from `emdash`, the handler itself is not | `src/api/handlers/schema.ts:102-106`, `:587-665`; `src/index.ts:252-262` |
| Indexable types: `string`, `url`, `number`, `integer`, `boolean`, `datetime`, `select`, `reference`, `slug` | `src/schema/types.ts:56-66`; [collections concept](https://docs.emdashcms.com/concepts/collections/#field-rules) |

## Template additions

```json
{
	"version": 1,
	"collection": "products",
	"locale": "en",
	"key": { "from": "sku" },
	"fields": {
		"title": { "from": "Name", "type": "text" },
		"price": { "from": "Price", "type": "number", "decimal": ",", "thousands": "." },
		"stock": { "from": "Stock", "type": "number" },
		"featured": { "from": "Featured", "type": "boolean", "true": ["ja"], "false": ["nein"] },
		"status": { "from": "Status", "type": "select", "map": { "Live": "published" } },
		"colours": { "from": "Colours", "type": "multiSelect", "separator": "|" },
		"released": { "from": "Date", "type": "date", "format": "dd/MM/yyyy HH:mm", "tz": "site" },
		"sold_on": { "from": "SoldAt", "type": "date", "format": "unix" },
		"launch_day": { "from": "Launch", "type": "date", "output": "yyyy-MM-dd" },
		"specs": { "from": "Specs", "type": "json" },
		"legacy_slug": { "from": "Handle", "type": "slug" }
	}
}
```

Every mapping still takes exactly one of `from` and `expr`. Options per type (all optional; unknown
keys are refused, as before):

| Type | Option | Value |
| --- | --- | --- |
| `number` | `decimal` | `"."` (default) or `","` |
| | `thousands` | one of `","`, `"."`, `" "`, `"'"`, `"_"`; must differ from `decimal` |
| `date` | `format` | a Luxon format, or `"unix"` (seconds, may be fractional) or `"unixMs"` (milliseconds); default ISO 8601 |
| | `tz` | an IANA zone or `"site"`; default `"UTC"` |
| | `output` | a Luxon format, 1-100 characters; only for `string` and `text` targets |
| `boolean` | `true`, `false` | 1-50 strings each, 1-100 characters, compared case-insensitively after trimming; setting one replaces that default list; the two lists must not share a token |
| `select`, `multiSelect` | `map` | object of source value to option, at most 1,000 entries, keys and values 1-200 characters |
| | `ignoreCase` | boolean, default `true` |
| `multiSelect` | `separator` | 1-10 characters, default `","`; used only for text values |
| `json` | `parse` | boolean, default `true` |

`text` and `slug` take no options.

## Conversion rules

The M3a rules still apply first: a missing path or `null` is empty; an object or array where a
single value is expected fails with `not_scalar` (except `multiSelect` and `json`, which take them);
numbers and booleans become their string where text is expected. An empty value (empty or
whitespace-only text, or `null`) becomes `null` for every type, which clears the field on update.
Conversion then runs the field rules (next section).

| Type | Accepts | Result | Errors |
| --- | --- | --- | --- |
| `text` | any scalar | the text as given (untrimmed, as in M2) | `not_scalar` |
| `number` | JSON number; text | the number. Text: trimmed; with `thousands`, separators must group the integer part in threes (`1.234.567,5`); a space separator also matches U+00A0 and U+202F; `decimal` is then read as the point; the M2 number grammar applies to what is left | `invalid_number` |
| | into an `integer` field | the number if it is whole and within ±(2^53-1) | `invalid_integer` |
| `boolean` | JSON boolean; JSON `1`/`0`; text | `true` or `false`. Text is trimmed and lower-cased (`toLowerCase`) and looked up in the token lists | `invalid_boolean` (message lists the accepted tokens) |
| `date` | text; JSON number with `unix`/`unixMs` | ISO text is read with `tz` as the zone for values without an offset (a value with `Z` or an offset keeps it); a `format` is read in `tz`; `unix`/`unixMs` read whole or decimal numbers (as JSON numbers or text). Into `datetime`: `toUTC().toISO()` (`…T12:00:00.000Z`). Into `string`/`text`: formatted in `tz` with `output`, default `yyyy-MM-dd` | `invalid_date` (unparseable; outside Luxon's range; a local time in a DST gap, detected by rebuilding the parsed wall-clock time in `tz` and comparing) |
| `select` | any scalar | trimmed text, looked up in `map` (exact key first, then case-insensitive when `ignoreCase`), then matched against the field's options: an exact match, else with `ignoreCase` the one option equal ignoring case. The stored value is the option as defined | `invalid_option` (no match, or more than one option matches ignoring case); message lists up to 20 options |
| `multiSelect` | array of scalars; text | text is split on `separator`; each item is trimmed, empty items dropped, then mapped and matched as for `select`; duplicates after matching are dropped, first occurrence kept. An empty result is `null` | `not_scalar` (an item is an object or array), `invalid_option` (one error naming every bad item), `too_many_items` (more than 1,000) |
| `json` | anything | objects, arrays, numbers and booleans as they are. Text with `parse: true` is parsed as JSON (`"[1,2]"` gives an array, `"\"x\""` the string `x`). With `parse: false`, text is kept as a JSON string, except text starting with `{` or `[`, which EmDash would read back as JSON | `invalid_json` (unparseable text; or the `parse: false` case above), `value_too_large` (over 1 MiB as JSON) |
| `slug` | any scalar | the M2 `slugify` of the text (NFKD, ASCII lower case, runs of other characters to `-`, at most 200 characters) | `empty_slug` (nothing left after slugify), `not_scalar` |

### Field rules

Applied after conversion, using the job's `targetFields` snapshot, in this order; every failing
rule adds an error, and the record fails when any value failed (as in M2, all errors of a record
are collected).

| Rule | Applies to | Error |
| --- | --- | --- |
| `required` and the value is `null` | every type | `required` |
| `options` (non-empty) | `select`, `multiSelect` | `invalid_option` (handled during matching) |
| whole number | `integer` targets | `invalid_integer` |
| `min`, `max` | `number`, `integer` targets | `out_of_range` |
| `minLength`, `maxLength` (UTF-16 code units, as Zod counts) | `string`, `text`, `url`, `slug` targets | `too_short`, `too_long` |
| `pattern` (`new RegExp(pattern)`, no flags, as EmDash) | `string`, `text`, `url`, `slug` targets | `pattern_mismatch` |

A pattern that does not compile is ignored by the importer (EmDash refuses such patterns when the
field is saved through the API). URL safety for `url` fields stays with EmDash (failures appear as
`emdash_validation_error`), because its write check depends on the request context.

New `ValueErrorCode`s: `invalid_boolean`, `invalid_integer`, `invalid_option`, `too_many_items`,
`invalid_json`, `value_too_large`, `required`, `out_of_range`, `too_short`, `too_long`,
`pattern_mismatch`. `invalid_date`, `invalid_number`, `empty_slug` and `not_scalar` gain the cases
above. Record log, CSV export and dry-run records carry them unchanged.

## Schema compatibility at job creation

`checkTemplate` compares each mapping with the collection field (job creation fails with
`invalid_template` and one problem per field):

| Mapping type | Field types it can fill |
| --- | --- |
| `text` | `string`, `text`, `url`, `slug` |
| `number` | `number`, `integer` |
| `date` | `datetime`, `string`, `text` |
| `boolean` | `boolean` |
| `select` | `select` |
| `multiSelect` | `multiSelect` |
| `json` | `json` |
| `slug` | `slug`, `string` |

Further problems:

- `output` on a `date` mapping into a `datetime` field (`output` only formats text).
- A `map` value that is not one of the field's options, when the field has options.
- A required field of the collection that the template does not map and that has no
  `defaultValue`: every create would fail. (`flux_source_id` is never required. M5's update-only
  mode will relax this check.)
- A mapped field that is storage-less or has an unsupported type (`Field.unsupportedType`).
- `tz: "site"` when the site timezone setting is not a valid IANA zone.

The snapshot stored on the job, per mapped field:

```ts
type TargetField = {
	type: FieldType; // EmDash field type
	required: boolean;
	options?: string[];
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};
// Job gains: targetFields?: Record<string, TargetField>; siteTimezone?: string;
```

`listSchemaFields` grows to return `required`, `defaultValue !== undefined` and `validation`;
`SchemaRegistryLike.getCollectionWithFields` is widened accordingly.

## Diff and writes

- `FieldValue` becomes `string | number | boolean | string[] | JsonValue | null`. `ContentPort`
  and `EmDashContent` pass values through unchanged.
- `planRecord` compares by target field type (from the snapshot; jobs without one fall back to the
  M2 mapping-type comparison): `datetime` as instants (M2); `boolean` with `0`/`1` read as
  `false`/`true`; `multiSelect` and `json` by deep equality (object keys in any order, arrays in
  order; `-0` equals `0`); everything else with `Object.is`. A `date` into a `string` field
  compares as text.
- Known limitation, documented: a `text` value that starts with `{` or `[` and is valid JSON is read
  back by EmDash as parsed JSON, so such a record always plans an update. The engine compares the
  parsed value with the text parsed the same way, which removes the false update when the text is
  canonical JSON; other spellings still update.

## `schema/apply` route

Plugin route, `import:execute` like all others.

Input (Zod, strict):

```json
{
	"collection": "products",
	"fields": [
		{ "slug": "featured", "type": "boolean" },
		{ "slug": "status", "type": "select", "options": ["draft", "published"], "label": "Status" },
		{ "slug": "sku_code", "type": "string", "indexed": true, "translatable": false }
	],
	"addOptions": true,
	"dryRun": false
}
```

- Exactly one of `fields` (1-100 entries) and `template` (a template; its `collection` is used
  unless `collection` is also given, which must then match). From a template, each mapping gives a
  field: `text` → `string`, `number` → `number`, `date` → `datetime` (`string` when `output` is
  set), `boolean` → `boolean`, `select` / `multiSelect` → the same type with the distinct `map`
  values as options (no options without `map`), `json` → `json`, `slug` → `slug`.
- A field: `slug` (`/^[a-z][a-z0-9_]*$/`, at most 63, not in EmDash's reserved list and not
  `flux_source_id`), `type` (`string`, `text`, `url`, `number`, `integer`, `boolean`, `datetime`,
  `select`, `multiSelect`, `json`, `slug`), `label` (1-200 characters; default from the slug,
  `unit_price` → `Unit price`), `options` (only `select`/`multiSelect`, 1-500 distinct strings of
  1-200 characters), `indexed` (only indexable types), `searchable`, `translatable` (default `true`,
  EmDash's default). `required`, `unique`, `defaultValue` and `validation` are not accepted.
  Duplicate slugs in one request are refused.
- `addOptions` (default `false`): add requested options that an existing `select`/`multiSelect`
  field lacks. `dryRun` (default `false`).

Plan, per field, in request order:

| Existing field | Action |
| --- | --- |
| none | `create` |
| same type, no options requested, or all requested options present, or the field has no options (accepts any string) | `unchanged` |
| same type, some options missing, `addOptions: true` | `add_options` (the existing options followed by the missing ones in request order) |
| same type, some options missing, `addOptions: false` | `conflict`, message names the missing options |
| another type | `conflict`, message names both types |

Apply: when `dryRun` is false the plan runs in order. `create` calls
`registry.createField(collection, { slug, label, type, indexed, searchable, translatable,
validation: options ? { options } : undefined })`; `add_options` calls
`registry.updateField(collection, slug, { validation: { ...existing.validation, options } })`
(the whole validation object, because `updateField` replaces it). `FIELD_EXISTS` from a concurrent
creator re-reads the field and re-plans it. Conflicts are never applied; other fields still are.
After any change the route calls `invalidateCollectionCache(collection)` and
`invalidateSchemaObjectCache()`, which the REST handler does and `SchemaRegistry` does not. A
`SchemaError` stops the run: the response lists what was applied and the error (`code`, `message`);
running the request again is safe because applied fields plan as `unchanged`.

Output:

```json
{
	"collection": "products",
	"dryRun": false,
	"changes": [
		{ "field": "featured", "action": "create", "type": "boolean" },
		{ "field": "status", "action": "add_options", "type": "select", "options": ["published"] },
		{ "field": "sku_code", "action": "conflict", "type": "string", "message": "Field \"sku_code\" is \"integer\"; requested \"string\"" }
	],
	"applied": ["featured", "status"],
	"error": null
}
```

Route errors: unknown collection `COLLECTION_NOT_FOUND` (404); invalid input `VALIDATION_ERROR`
(400). Field creation never touches `flux_source_id`; `jobs/next` keeps adding it on the first
write as in M2.

`jobs/create` and `sources/sample` are unchanged apart from the new template keys; the template
validation error lists all problems as before.

## Testing

- Unit, conversion: each type with JSON, CSV-text and XLSX-shaped inputs: boolean default and
  custom tokens, case, `1`/`0`, overlapping lists refused; number separators (grouping valid and
  invalid, NBSP, `decimal` equal to `thousands` refused), integer targets (whole, fractional,
  beyond 2^53); select with `map`, `ignoreCase` on and off, ambiguous case-only options, free
  selects; multiSelect from arrays and text, separators, empty items, duplicates, 1,001 items,
  nested objects; date ISO with and without offset, formats, `unix` and `unixMs` (numbers and
  text, fractional), `tz` IANA and `site`, DST gap fails and overlap takes the earlier instant
  (Europe/Chisinau and America/New_York), `output` into text; json from objects, text parsed,
  `parse: false` with `{` refused, 1 MiB limit; slug slugify and `empty_slug`.
- Unit, field rules: `required`, `out_of_range`, `too_short`, `too_long`, `pattern_mismatch`, a
  bad pattern ignored; all errors of a record collected; jobs without `targetFields` behave as M2.
- Unit, schema checks: the compatibility table both ways; `output` into `datetime`; `map` values
  not in options; unmapped required field with and without default; storage-less and unsupported
  fields; invalid site timezone.
- Unit, diff: booleans against `0`/`1`, multiSelect order, json key order, datetimes, canonical
  JSON-looking text.
- Unit, `schema/apply`: planning every row of the table; from a template; `addOptions` merge
  order; reserved and duplicate slugs; `indexed` on `json` refused; dry run calls nothing;
  `FIELD_EXISTS` race; stop on a `SchemaError` with partial results; cache invalidation called.
- Integration on `sites/dev`: a collection with one field of each M4a type (with options, `min`,
  `max`, `maxLength`, `pattern`, a required field) created by `schema/apply` from a template, then
  a CSV and a JSON import covering every type; read back through the content API and compare
  (booleans, arrays, canonical datetimes); a dry run reports `invalid_option`, `invalid_integer` and
  `required` without writing; a re-run is `unchanged` for every record; `tz: "site"` after setting
  the site timezone through the admin settings API; `schema/apply` with `addOptions`, then an import
  that uses the new option; a conflicting type reported and left unchanged.
- Cloudflare parity on `sites/dev-cf`: `schema/apply` and one import with boolean, select,
  multiSelect, json and a site-timezone date on D1.

## Out of scope for M4a

Taxonomies, references and bylines (M4b); media (M4c); Portable Text (M4d); locales and translation
links (M4e); `repeater` and `blocks` fields; creating collections; changing a field's type,
`required`, `unique`, defaults or validation other than adding options; URL-field pre-checks;
entry-slug conflict handling (an existing slug stays `emdash_slug_conflict`); refreshing
`targetFields` on retry.
