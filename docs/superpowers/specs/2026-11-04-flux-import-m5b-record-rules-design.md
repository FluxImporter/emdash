# Flux Import M5b: record rules

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Second of three parts of Milestone 5 (Record rules and safety) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-5-split). Builds on M5a
([spec](./2026-11-03-flux-import-m5a-journal-rollback-design.md),
[review](../notes/2026-11-03-m5a-review.md)), merged at `113f760`.

## Goal

A template can say how each record treats the entry it matches, and when it goes live:

- **Write mode** (`rules.mode`): `upsert` (create or update, today's behaviour and the default),
  `create` (only create; a record whose entry exists is skipped) or `update` (only update; a record
  without an entry is skipped).
- **Only these fields** (`rules.updateFields`): an update compares and writes only the listed
  mappings. A create still writes every mapping.
- **Never overwrite edits made outside the import** (`rules.protectEdited`): a mapping whose value
  changed since the importer last wrote it is not written, and the record warns `field_edited`.
  The importer detects this with per-mapping fingerprints kept on the link row, using only the
  reads it already makes.
- **Publish, draft or schedule**: the job option `publish` stays (`true` publishes, `false` leaves
  drafts). A new template mapping, `publishAt`, gives each record a publication time. A future
  time schedules the written content. A past or empty time publishes now.
- **Rollback**: every new write goes into the M5a journal and rolls back. The format grows only by
  optional fields.

The template stays `version: 1`. Everything new is optional. A template without `rules` and
`publishAt` behaves exactly as in M5a. The one exception is that its link rows now also carry
fingerprints, which change no decision.

## Decisions

| Topic | Decision |
| --- | --- |
| Shape | `rules: { mode?, updateFields?, protectEdited? }` sits in the template, next to `key` and `slug`, so a saved template (M6) carries it. `publishAt` sits at the template's top level because it is a value mapping like `key`, `slug` and `translationOf`. It is not a rule. The job option `publish` stays a boolean with default `true`. Each addition is optional and additive, so `version` stays 1, as the roadmap's "Template v1" requires. |
| `publish` and `publishAt` | `publishAt` only applies with `publish: true`. Combining it with `publish: false` is refused at job creation (`invalid_options`, "publishAt needs publish: true"). A per-job time is a constant expression (`"expr": "'2026-12-01T09:00:00+02:00'"`), so no per-job option is added (YAGNI). |
| Skipped records | A record skipped by its mode is `unchanged`, with the warning `exists` (`mode: "create"`) or `not_found` (`mode: "update"`). There is no new counter or status, as the M5a outline says. Dry runs report the same row. |
| What "exists" means | The entry is the one the record resolves to today: its link row's entry, read back with `content.get`. In `create` mode, an entry the record's own earlier row was writing (a resumed or retried write) is not "existing". That write is finished as today. An entry an editor created without a link row is unknown to the importer, as before. |
| `updateFields` | It lists mapping names: a field name (scalar, reference, image, file or Portable Text field), `slug`, `taxonomies.<name>` or `bylines`. These are the names the record's `changes` already use; an image's `.alt` is covered by its field. Each listed name must be mapped by the template, with no duplicates and at least one name, otherwise the job is refused with `invalid_template`. On an update, unlisted mappings are not resolved (no term is created, nothing is looked up or downloaded), compared, written, journalled or fingerprinted. A create writes every mapping. |
| Conversion of unlisted mappings | The record is still converted whole (`applyTemplate`) before its entry is known, so a value error in an unlisted mapping fails the record on update too. The key is read in the same pass, so skipping conversion would mean splitting `applyTemplate` (Open issues). |
| Edit detection | Fingerprints on the link row, as the M5a outline ruled. The rejected alternatives and the facts behind them are under ["Edited outside the import"](#edited-outside-the-import). |
| Protected mapping | It is not written and not in `changes`. The record gets a warning `field_edited` naming it. A record whose only differences are protected is `unchanged`. Protection lifts in two cases: the entry's value equals the feed's again (then nothing needs writing and the fingerprint is refreshed), or a job without `protectEdited` writes the mapping. |
| Protection scope | It covers every mapping kind (data fields, slug, each taxonomy, each reference field, bylines), one fingerprint each. It never relaxes the M2 rules: an entry with someone else's pending draft is still `pending_draft`, and a locked entry is still `locked`. |
| Protected mappings are resolved without side effects | They resolve the way a dry run does. Terms are looked up but not created, and a missing term means the value differs. Media and Portable Text images are looked up in the media map and not downloaded, and a miss means the value differs. This lets protection lift by equality for every kind, at no cost beyond today's lookups. |
| Status changes are not "fields" | `rules.updateFields` and `protectEdited` do not cover status. Status is already protected by the M2 rule: the importer publishes or schedules only an entry that is published without a draft, or whose pending state is its own (`link.writtenRev === entry.rev`). |
| Draft mode | `publish: false` never unpublishes or unschedules. A schedule the importer set earlier stays, and EmDash publishes the latest draft at that time (F5). This is documented, as with `publish: false` today. |
| Past and empty `publishAt` | The record is published now, so its `publishedAt` is the import time. Backdating `publishedAt` is out of scope: the runtime's create body type has no `publishedAt`, and setting it over REST needs `content:publish_any` (F11). A time less than `SCHEDULE_LEAD_MS` (60 s) ahead also counts as now, because EmDash refuses a time that is not in the future when it checks (F2). |
| Time zone | `publishAt` is converted like a `date` mapping into a `datetime` field (M4a): `format`, and `tz` defaulting to `UTC` or set to `site`, which reads the site time zone at job creation. The value sent to EmDash is UTC ISO, which EmDash stores as given (F2). |
| Already-scheduled entries | A schedule the importer set (the entry's `_rev` is the link's `writtenRev`) is replaced, kept or published by the record's `publishAt`. A schedule an editor set is someone else's pending state and is left alone (M2 rule). |
| Collections without revisions | An update to a published entry goes live at once (F9), so there is nothing to schedule. The record warns `not_scheduled` and makes no schedule call. The job reads whether the collection has revisions at creation (`Job.revisions`, F12). |
| Rollback | A schedule is journalled as part of an `update`'s `before.status` and `before.scheduledAt`. The M5a format already holds these; M5a did not write them. The revert sequence gains step 7, `unschedule`. Ownership also accepts an entry that EmDash's scheduler published since (`_rev` arithmetic, F1, F6). The journal's link snapshot gains the link row's new fields. |
| Capabilities | Unchanged. Schedule and unschedule go through the trusted runtime the importer already uses (`content:publish` is declared for disclosure). |

## EmDash facts this design relies on

Checked on 2026-11-03 against `emdash@1.2.0` (package `src/`, cited as file:line) and the docs
(`emdash-docs` MCP). M5a's facts (M5a F1-F18) still hold; the ones below are new or sharpened. All
are **confirmed** from source unless marked otherwise.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | `_rev` is `base64("<version>:<updatedAt>")`, and EmDash decodes it the same way (`decodeRev`). Every mutation is fenced on both parts | `src/api/rev.ts:19-21`, `:27-40`, `:47-66`; `src/database/repositories/content.ts:52-59` |
| F2 | `handleContentSchedule(collection, id, scheduledAt, { _rev, actor })` normalizes the time (offsets accepted; a naive value is read in `site:timezone`) and refuses a time not after now (`VALIDATION_ERROR`). It requires a routable slug, as publish does. It runs `content:beforeSchedule` (`SCHEDULE_REJECTED`) and fires `content:afterSchedule`. It sets `status` to `scheduled` (a published entry stays `published`), `scheduled_at` and `updated_at`, and does **not** bump `version`. So `_rev` moves, `version` does not, and a second call replaces the schedule. The response is `{ item, _rev }` | `src/emdash-runtime.ts:4686-4731`; `src/api/handlers/content.ts:2163-2217`; `src/database/repositories/content.ts:2096-2147` (`:2107-2110` future check, `:2118-2134` the write); `src/database/content-datetime.ts:81-102`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) "Schedule" row |
| F3 | `handleContentUnschedule(collection, id, { _rev })` exists on the runtime. There is no `beforeUnschedule` hook (it cannot be refused) and it fires `content:afterUnschedule`. A draft or scheduled entry becomes `draft` and a published one stays `published`. It sets `scheduled_at = NULL` and `updated_at`, with no `version` bump. It is a no-op when no schedule is set | `src/emdash-runtime.ts:4733-4758`; `src/api/handlers/content.ts:2222-2268`; `src/database/repositories/content.ts:2155-2198`; [hooks](https://docs.emdashcms.com/reference/hooks/#contentbeforeschedule) |
| F4 | Publish (both collection kinds) sets `status = 'published'`, `draft_revision_id = NULL` and `scheduled_at = NULL`, sets `updated_at` to now and runs `version + 1`. Revisioned collections copy the draft (or live) revision into the columns and apply a staged slug | `src/database/repositories/content.ts:2486-2525`, `:2583`, `:2620-2635` |
| F5 | Due entries are published by `publishDueContent`, which calls the runtime's `handleContentPublish` with `origin: { source: "scheduler" }`, so `content:beforePublish` runs again and a refusal unschedules the entry. It selects `scheduled_at <= now AND deleted_at IS NULL` (trashed entries are skipped), whatever the status. On first publication it sets `publishedAt` to the scheduled time. Edits after scheduling keep the schedule, and the draft as it is at due time is what goes live. Node runs the sweep on a timer; Workers need a Cron Trigger; `runtime.runScheduledTasks()` runs one pass | `src/emdash-runtime.ts:898-914`, `:933-975`; `src/scheduled-publish.ts:113-225` (`:165`); `src/database/repositories/content.ts:2231-2239`; [working with content: publish or schedule](https://docs.emdashcms.com/guides/working-with-content/#publish-or-schedule-changes) |
| F6 | So a scheduled entry that the sweep publishes, with no other change in between, ends up exactly one `version` past the `_rev` its schedule returned, `published`, with no draft, no `scheduledAt`, and `updatedAt` at or after the scheduled time (F2, F4, F5). Any edit adds at least one more `version` (F7, F8) | derived from F2, F4, F5, F7, F8; **unconfirmed** until V4 |
| F7 | On a revisioned collection, a save that touches only `data`, `slug` or `references` stages a draft revision with `version + 1` and leaves `updated_at` alone. `_rev` therefore moves on every admin draft save, autosave included (the admin autosaves through the same `PUT`). On a collection without revisions an update writes the columns, stays `published` and is live at once, with `version + 1` and a new `updated_at`. An update keeps `status` and `scheduled_at`. Measured in planning (V3): a revisioned update that sends data and links together moves `version` by 2; no rule depends on the step | `src/database/repositories/content.ts:1034-1076`, `:2831-2855` (`:2840-2841`); `src/emdash-runtime.ts:3943-4037` |
| F8 | Term assignments made through the admin's terms route (`setTermsForEntry`) touch only `content_taxonomies`, so `version`, `updated_at` and `_rev` do not move. `taxonomies`, `bylines` and `references` sent in a `PUT` body do move `version` | `src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].ts:180`; `src/database/repositories/taxonomy.ts:802-837`; `src/database/repositories/byline.ts:1405-1409`; `src/database/repositories/content.ts:1072-1076`; M5a review I3 |
| F9 | The admin's `PUT /content/{collection}/{id}` calls the same runtime `handleContentUpdate` the importer calls, with `actor = { id, role }` and the lock check added. Content rows have no `updated_by` or source column. Revisions store only `author_id` (M5a F3), and the importer passes its route user as `actor` too | `src/astro/routes/api/content/[collection]/[id].ts:69-151` (`:134`); `src/schema/registry.ts:1871-1885`; `src/emdash-runtime.ts:3943-3948`; `packages/flux-import/src/emdash/content.ts` (`actor: this.actor`) |
| F10 | `content:afterSave` gets the saved item (draft-hydrated), `isNew`, `actor`, `locale` and `translationOf`, but not the previous data. `content:beforeSave` gets only the incoming data. Both fire for trusted runtime writes, and update has no option to skip them. `afterSave` runs deferred in `after()` | `src/plugins/hooks.ts:76-92`, `:561-667`; `src/plugins/types.ts:1408-1434`; `src/emdash-runtime.ts:3742-3760`, `:4074-4085`, `:6105-6130` |
| F11 | The runtime's create body type has `status` but no `publishedAt` or `scheduledAt`. The handler accepts `publishedAt` only by passing it through untyped. The REST `PUT` needs `publish_any` to send `publishedAt`. Create cannot schedule | `src/emdash-runtime.ts:3457-3471`, `:3617-3629`; `src/api/handlers/content.ts:1205-1222`; M5a F12 |
| F12 | A collection's `supports` (with `"revisions"`) is part of its definition and is what publish reads to decide whether it promotes a revision | `src/schema/types.ts:264-272`; `src/schema/registry.ts:380-386`; `src/api/handlers/content.ts:254-270` |
| F13 | `handleContentGet` returns `data` as `{ ...liveData, ...draftData }` when a draft exists, `liveData` as the columns, and `_rev` from the row (M5a F5). The slug staged in a draft is not returned | `src/emdash-runtime.ts:3364-3453` |
| F14 | `handleContentDiscardDraft` keeps `scheduled_at` and `status`, with `version + 1` | `src/database/repositories/content.ts:2863-2905` |
| F15 | Reference edges live in `_emdash_content_references`, keyed by the two entries' **translation groups**, and are written without touching either entry's row. A field bound to the parent end replaces that entry's children (`setChildren`), one bound to the child end replaces its parents (`setParents`), each addressed by the selecting entry's group. So an edge set from the other entry of the relation, or through a translation of the entry, changes what the entry's reference field reads while its `version`, `updated_at` and `_rev` stay. Added in the Task 5 review | `src/api/handlers/relations.ts:782-812` ("no row of either collection has changed"); `src/database/repositories/relation.ts:612-658`, `:679-736`; `dist/staged-DboEaWsV.mjs:332-370`, `:390` |

### Unconfirmed, to be proven by Task 0

Each item is proven on Node (SQLite) and workerd (D1), on a collection with revisions and one
without, through a temporary probe route as in M5a.

- **V1. Fingerprint round trip.** For every value kind M4a-M4e write (text, number, integer,
  boolean, datetime, select, multiSelect, json, slug fields, image with and without alt, file,
  Portable Text, references in order and as a child-side set, terms, bylines, `null`), the
  fingerprint of the value sent equals the fingerprint of the value `handleContentGet` (and
  `entryTerms`) returns afterwards, both live and when staged in a draft. The comparison is the
  one `planRecord` uses. A kind that fails gets its canonical form fixed before Task 1.
- **V2. Admin edits change exactly one fingerprint.** A REST `PUT` of one field (on the revisioned
  collection: draft save, then publish; on the plain one: direct), a term change through the terms
  route, and a byline change through `PUT` each change only that mapping's fingerprint. A `PUT`
  that sends the stored values back unchanged changes none.
- **V3. Schedule through the trusted runtime.** Each of these leaves the stated state, and in each
  `version` is unchanged and `updatedAt` moved (F2): create then schedule (`scheduled`); update a
  published entry then schedule (revisioned: `published`, a draft and `scheduledAt`);
  reschedule; publish a scheduled entry (`scheduledAt` cleared); update a scheduled entry
  (schedule kept, F7). Also: the routable-slug requirement refuses no entry that publish accepts.
- **V4. The sweep.** `runtime.runScheduledTasks()`, called from the probe, publishes a due entry
  with exactly F6's result: one `version`, `published`, no draft, `scheduledAt` null, `publishedAt`
  equal to the scheduled time on first publication. It skips a trashed scheduled entry. On
  workerd the same pass runs through the probe (or the `scheduled()` test endpoint).
- **V5. Unschedule as a revert step.** On both collection kinds, `handleContentUnschedule` with
  `_rev` returns a scheduled draft to `draft`, and a published entry with a scheduled draft to
  `published` with its draft and no schedule. Followed by the M5a sequence, it restores the
  pre-states "draft, not scheduled" and "published without a draft" after an import that scheduled
  them.
- **V6. `supports` at job creation.** `SchemaRegistry.getCollectionWithFields` (what
  `listSchemaFields` calls) returns the collection's `supports`. If it does not, the plan reads
  `getCollection` (F12).
- **V7. D1 query counts.** A batch at `WORKERS_BATCH_CAP` (11) of creates that are scheduled, and
  of updates that are scheduled with `protectEdited` and a fingerprint refresh; a batch at
  `WORKERS_LINKED_BATCH_CAP` (6) of the same with three references, two taxonomies and bylines;
  and a rollback batch at `WORKERS_ROLLBACK_BATCH_CAP` (3) whose rows run step 7. Each must stay
  under 1,000 queries. If one does not, its cap is lowered to what fits, as in M5a.

If V1, V3 or V4 fail, the plan stops and this spec is amended before Task 1.

## Template and job

```json
{
	"version": 1,
	"collection": "products",
	"locale": "en",
	"key": { "from": "sku" },
	"slug": { "from": "handle" },
	"publishAt": { "from": "go_live", "format": "dd/MM/yyyy HH:mm", "tz": "site" },
	"rules": {
		"mode": "upsert",
		"updateFields": ["price", "stock", "taxonomies.category"],
		"protectEdited": true
	},
	"fields": {
		"title": { "from": "Name", "type": "text" },
		"price": { "from": "Price", "type": "number" },
		"stock": { "from": "Stock", "type": "integer" }
	},
	"taxonomies": { "category": { "from": "Category" } }
}
```

| Option | Value | Default |
| --- | --- | --- |
| `rules.mode` | `"upsert"`, `"create"`, `"update"` | `"upsert"` |
| `rules.updateFields` | 1-200 unique mapping names, each mapped by the template | every mapping |
| `rules.protectEdited` | boolean | `false` |
| `publishAt` | `{ from \| expr, format?, tz? }`, exactly one of `from`/`expr`; `tz` an IANA zone or `"site"` | not mapped: publish per `publish` |

These combinations are refused at job creation:

- `updateFields` or `protectEdited: true` with `mode: "create"`: `invalid_template`, "rules.updateFields and rules.protectEdited apply to updates; mode create never updates".
- An `updateFields` name the template does not map, or a repeated one: `invalid_template`.
- `publishAt` with `publish: false`: `invalid_options`.

Job creation also:

- adds `publishAt` with `tz: "site"` to `usesSiteTimezone` and to the route's `needsSiteTimezone`;
- stores `Job.revisions` (whether the collection supports revisions, F12, V6) when the template
  maps `publishAt`.

```ts
// Template gains (zod, strict):
//   publishAt?: { from?: string; expr?: string; format?: string; tz: string }   (tz default "UTC")
//   rules?: { mode?: "upsert" | "create" | "update"; updateFields?: string[]; protectEdited?: boolean }
// MappedRecord gains: publishAt?: string | null   (UTC ISO; null when empty; absent when not mapped)
// Job gains: revisions?: boolean   (set when the template maps publishAt)
// LinkRow gains:
//   fields?: Record<string, string>   (mapping name -> fingerprint; see "Fingerprints")
//   unconfirmed?: string[]            (mappings whose fingerprint writtenRev does not vouch for;
//                                      see "Unconfirmed fingerprints"; omitted when empty)
//   scheduledAt?: string              (the time the write that produced writtenRev scheduled the entry for)
// JournalBefore.link gains: fields?: Record<string, string>; unconfirmed?: string[]; scheduledAt?: string
// EntrySnapshot gains: publishedAt?: string | null   (EmDash's published_at; null: never published)
//   (status, scheduledAt, hasDraft, live are there since M5a)
// JournalEntry.wrote gains (written when a publish or a schedule follows the write; see
// "Ownership after the scheduler published" and "Crash repair"):
//   fields?: Record<string, string>   (field -> fingerprint of the data the publish makes live)
//   slug?: string                     (the slug the write sends, when it sends one)
//   publishedAt?: string | null       (the entry's as read before the write; null for a create)
// journalCreate(target, sourceIdValue, wrote?)   (a create's row carries wrote too)
// ContentPort gains:
//   schedule(input: { collection; locale; id; rev; scheduledAt }): Promise<WriteResult>
//     (lock-checked like publish; SCHEDULE_REJECTED and other EmDash errors throw ContentWriteError)
// RevertStep gains "unschedule"; ContentRuntime gains handleContentUnschedule
```

A `publishAt` value that fails conversion fails the record with `invalid_date` (or `not_scalar`),
field `publishAt`, before any lookup or write.

## Write modes

| Mode | Entry found (not this record's own earlier write) | No entry |
| --- | --- | --- |
| `upsert` | update (as today) | create (as today) |
| `create` | `unchanged`, warning `exists`: "Skipped: the entry exists and the import only creates entries (mode create)" | create |
| `update` | update | `unchanged`, warning `not_found`: "Skipped: no entry has this key and the import only updates entries (mode update)" |

- **When the mode is decided.** Right after the key is read and before any link resolution, media
  lookup or download. The entry is looked up early: the link row, then `content.get`, the same
  two reads the record makes today, moved forward and reused. A skipped record therefore creates
  no term, downloads nothing and reads no translation source. The early lookup is used whenever
  the template has `rules` or `publishAt`; other templates keep today's order.
- **Crash repair.** In `create` mode a record whose earlier row is `writing`, or names the found
  entry, resumes as today and is not skipped. This covers the stop between the link put and the
  publish (the `writing` row) and a `jobs/retry` of a `publish_*` or `schedule_*` row (its row
  names the entry). Crash repair by `flux_source_id` still runs only when no link resolves, and
  what it finds is this job's own create. In `update` mode nothing is ever created, so there is
  nothing for crash repair to find: a record without a link entry is skipped.
- **Duplicate keys in one feed.** In `create` mode the first record creates and later ones are
  skipped `exists`, because the link names this job and their own rows do not name the entry. A
  dry run cannot see this (nothing is created), so it plans `create` for each, as an upsert dry
  run already does for duplicate keys (Open issues).
- **Translations (M4e).** `create` mode skips a linked record whose entry exists before the
  source lookup. With no entry, the M4e decision table applies unchanged (`translation_exists` for
  an editor's translation, `translation_source_not_found`). `update` mode skips a linked record
  without an entry before the source lookup, so `translation_source_not_found` is never reported
  for it. The M4e checks on existing entries (`translation_of_missing`, `translation_not_linked`)
  run as today in `upsert` and `update` modes.
- **Dry run and diff.** The same lookups and the same verdict. A skipped row has no `changes`.
- **Retry.** Skipped rows are `unchanged` and not retried.

## Only these fields

`updateFields` narrows an **update** to the listed mappings:

| Kind | Unlisted on update |
| --- | --- |
| Scalar data field | Converted (a bad value fails the record), not compared, not written |
| Slug | Not compared, not sent |
| Reference field, `taxonomies.<name>`, `bylines` | Not resolved (no lookup, no term created), not compared, not sent |
| Image, file | Not looked up in the media map, not downloaded, not compared, not written |
| Portable Text | Converted, images not looked up or downloaded, not compared, not written |

- An update's `data` holds the listed data fields that are not protected, plus their media and
  Portable Text values. Unchanged ones are sent back equal, as in M2-M5a. The M5a rule stays: data
  and slug are left out when only links changed. (Amended in planning: "only the listed data
  fields that changed" would have changed how M2-M5a write an update for no gain.)
- **Required fields.** Required-field checks (M4a, `emptiedRequired`) apply to written fields
  only. An unlisted field keeps its stored value, which EmDash already accepted.
- **Journal.** The pre-image holds what the update changes, as in M5a, plus every pending-draft
  field whose value differs (M5a, "What is captured"), listed or not, because rolling back
  publishes the restored live values.
- **Crash repair.** An entry found by crash repair (no link resolved first) was this job's own
  create, so every mapping is resolved, compared and written as for a create. Narrowing applies
  only to an entry found through its link row.
- **Translations.** A linked record also drops its shared mappings (M4e). The two exclusions add
  up.

## Edited outside the import

### Checking the M5a ruling against the facts

The M5a outline ruled: fingerprints per mapping on the link row, no extra reads. The facts uphold
it, with three amendments.

- **Revisions and hooks cannot tell an admin edit.** A REST edit and an importer write call the
  same `handleContentUpdate` with the same kind of `actor` (F9). Revisions store only the actor
  (M5a F3), and `_rev` moves for every save (F7) and for scheduling (F2). An `afterSave` hook could
  see the actor but not the previous data (F10). Recording edits from it would cost a plugin
  storage write for every save on the site, from a deferred `after()` that can be lost. It would
  still not tell the importer apart, because the importer passes its route user as `actor`. So the
  outline's reason stands: only the importer can remember what it wrote.
- **No extra reads holds.** Every value a fingerprint needs is already read to plan the record:
  data from `content.get` (draft first, F13), the live slug, the reference selections (read only
  when references are mapped), the explicit bylines, and the terms (`entryTerms`, read only when
  taxonomies are mapped). The fingerprints written after a write come from the values the
  importer sent, so no read-back is needed (V1).
- **Amendment 1: term edits do not move `_rev` (F8).** The outline's fallback for link rows
  without fingerprints ("`entry.rev === link.writtenRev` means nothing was edited") is wrong for
  taxonomies. Under that fallback taxonomies count as edited (below).
- **Amendment 2: a draft-only admin save moves `_rev` but not `updated_at` (F7).** Detection
  therefore never uses timestamps. An entry with an editor's pending draft is refused before
  fingerprints matter (`pending_draft`). The staged slug is not readable (F13), which is safe for
  the same reason.
- **Amendment 3: a rollback rewrites values.** The link row's fingerprints must go back with the
  rest of the link, so the journal's link snapshot gains `fields` (Journal and rollback).
- **Amendment 4 (Task 5 review): reference edges set elsewhere do not move `_rev` (F15).** Like
  taxonomies, reference fields are always compared with their fingerprints.

### Fingerprints

- **What one covers.** One fingerprint per mapping name (as in `updateFields`). It is the SHA-256
  (Web Crypto `crypto.subtle.digest`, available on Node 22 and workerd) of the mapping's
  **canonical form**, serialized as JSON with object keys sorted. It is stored as the first 12
  bytes in base64url, 16 characters.
- **Canonical forms.** Each one is built so that two values `planRecord` calls the same have the
  same canonical form:

  | Kind | Canonical form |
  | --- | --- |
  | `boolean` comparison | `true`/`false` (EmDash's `1`/`0` mapped) |
  | `instant` comparison | epoch milliseconds of a parseable string; otherwise the value |
  | `deep` comparison | the value, with a top-level `1`/`0` mapped as for booleans |
  | `plain` comparison | a stored object as `JSON.stringify` (EmDash's order); `-0` as `0`; else the value |
  | Image, file | `{ id, alt }`: the media ID and the stored alt (`null` when absent), whether or not the template maps alt. An editor's alt change is an edit |
  | Portable Text | `canonicalPortableText(value)`; a value that is not Portable Text has a canonical form of its own and so always differs |
  | Slug | the live slug |
  | Taxonomy | the sorted term translation groups |
  | Reference field | the targets' groups, in order, or sorted for a child-side field |
  | Bylines | the bylines' groups, in order (role labels are not compared, as in M4b) |
  | Empty / missing | `null` |

- **Where it lives.** `LinkRow.fields`, keyed by mapping name. A link row is
  `collection:locale:sourceKey`, so templates sharing a key share it. Every write replaces the
  fingerprints of the mappings it compared and keeps the others.
- **When they are recorded.** On every real job, whatever its rules, so that protection works from
  the first job after an upgrade. After a write, each mapping the record compared gets a new
  fingerprint: a written mapping gets the fingerprint of the value sent; a mapping equal to the
  feed gets the fingerprint of its current value; a protected mapping that differs keeps its old
  fingerprint, or stays without one. Unlisted mappings, and a linked record's shared mappings,
  keep theirs. Every `putLink` carries them, with `unconfirmed` (below).
- **Unconfirmed fingerprints** (Task 5 review). A link save moves `writtenRev`, and an unmoved
  `_rev` vouches for every fingerprint but the always-compared ones. So a fingerprint the save
  only carries must not be vouched for unless it describes the entry at the new `writtenRev`.
  `LinkRow.unconfirmed` lists the mappings whose fingerprint does not:
  - every protected mapping, whether it keeps an old fingerprint or has none (the editor's value
    differs from what the importer last wrote);
  - a carried fingerprint of a mapping the record does not carry (unlisted, another template's),
    unless it was confirmed and the entry, as read, was still at the stored `writtenRev`.

  The scheduler's publish moves `_rev` and vouches for nothing here (Task 5 review, round 2): an
  editor who unschedules after the time and then discards the draft leaves the same shape
  (`sweptSince`), and after a real sweep the importer's values are live, so they compare equal.
  A sweep therefore makes the fingerprints an `updateFields` run carries unconfirmed; the next run
  that maps them finds them equal and confirms them.

  A recomputed fingerprint (written, or found equal to the feed) is confirmed, so a mapping leaves
  the list once the importer writes it or its current fingerprint equals the stored one. The list
  is omitted when empty, and the journal's link snapshot carries it.
- **Refresh.** A record that writes nothing but would change the fingerprint set (a pre-M5b link
  row, or a protection that lifted) puts the link once with the new `fields`. It keeps
  `writtenRev`, `jobId` and `scheduledAt`, because ownership did not change. A refresh is not
  journalled: it does not change the entry, and the next job's link snapshot reads it. Dry runs
  write nothing.

### Protection

With `protectEdited`, for an existing entry found through its link row (crash repair entries are
the job's own, above):

A mapping is **always compared** when it is a taxonomy (term edits leave `_rev`, F8), a reference
field (edges set elsewhere leave it, F15) or listed in `unconfirmed`. The entry is **unmoved** only
when `entry.rev === writtenRev`; a scheduler's publish counts as a move (above).

| The mapping on the link row | It counts as edited when |
| --- | --- |
| has a fingerprint | it differs from the current value's, and the mapping is always compared or the entry has moved |
| has none (every mapping of a link from before M5b, or one a link with `fields` lacks) | the mapping is always compared, or the entry has moved |

Amended in the Task 5 review: a missing fingerprint applies the pre-M5b rule to that mapping alone
(I1). Counting it as always edited would keep it protected forever, since only a write gives it a
fingerprint.

Amended in planning: an unmoved `_rev` vouches for every mapping that is not always compared, also
when the link has `fields`. Only term edits and edges set elsewhere leave `_rev` (F8, F15), and a
fingerprint can differ without an edit: the importer's own pending draft stages a slug the read
cannot show (F13), so comparing alone would call the importer's own slug edited. The Task 5 review
added references and `unconfirmed` to the always-compared mappings.

A mapping that counts as edited is resolved without side effects (Decisions) and compared:

- If it equals the feed, nothing is written, there is no warning, and its fingerprint becomes the
  current value's. Protection has lifted.
- If it differs, it is **protected**: left out of the plan's `changes` and of the write, with a
  warning `{ field: <name>, code: "field_edited", message: "Not updated: the value was changed
  outside the import since the import last wrote it" }`. The dry run reports the same warning.

How it applies elsewhere:

- **Links and terms.** Each taxonomy, each reference field and the bylines are one mapping each.
  Renaming a term is not an edit to the entry (the group stays); assigning another term is.
- **Translation sync.** A shared value an editor changes on a translation syncs into the source
  (M4e F6), so the source's fingerprint differs and the value is protected. This is correct: it was
  edited outside the import. A source job's sync into a translation (M4e V4) changes no fingerprint
  the translation job keeps, because linked records do not map shared values. That is better than
  `_rev`, which the sync moves.
- **M5a ownership.** Fingerprints do not take part in it: a rollback still owns an entry by its link
  row's `jobId` and `writtenRev` (plus the scheduled-publish rule below). A protected mapping is
  never written, so it is never journalled, and the rollback never touches it.
- **Rollback.** The link goes back to `before.link`, `fields` included. After a rollback of job B,
  the entry's values for B's mappings are those of B's pre-image. When B found the entry as A left
  it, they match A's fingerprints again. When an editor had changed it between A and B (`before.rev
  !== before.link.writtenRev`), the editor's values differ from A's fingerprints and stay
  protected. That is the M5a hand-over rule applied to fields.
- **A job without `protectEdited`** writes as today. The values it writes become the
  fingerprints, which lifts every protection it overwrote.

## Publish, draft or schedule

The record's **target** with `publish: true`: `now` when `publishAt` is not mapped, is empty, or
is less than `SCHEDULE_LEAD_MS` ahead of `deps.now()`; otherwise `at T`. With `publish: false`
nothing changes (draft).

| Entry before the record | Data plan | Target `now` | Target `at T` |
| --- | --- | --- | --- |
| none | create | create, publish (as today) | create, `schedule(T)` |
| published, no draft | update | update, publish (as today) | revisioned: update (stages a draft), `schedule(T)`; without revisions, or when only terms and bylines change (no draft is staged, M5a V5): update (live at once), warning `not_scheduled` |
| published, no draft | unchanged | `unchanged` | `unchanged` (nothing pending to schedule) |
| the importer's own pending state (`writtenRev === entry.rev`: a draft, a scheduled draft, or a published entry with its draft) | update | update, publish | update, then `schedule(T)` unless the entry is already scheduled for exactly `T` (an update keeps the schedule, F7) |
| the importer's own pending state | unchanged | publish (as today; it also clears an earlier schedule, F4) | `schedule(T)`; `unchanged` when it is already scheduled for exactly `T` |
| someone else's pending state (draft or schedule) | update | `pending_draft` (as today) | `pending_draft` |
| someone else's pending state | unchanged | `unchanged` (as today) | `unchanged` |

- **Someone else's schedule, a deliberate change.** The pending check counts a schedule the
  link's `writtenRev` does not account for, even on a published entry without a draft, for every
  template, those without `publishAt` included. Before M5b such an update was written and
  published, which cleared the editor's schedule (F4). It is now `pending_draft`, with the message
  "Not imported: the entry is scheduled, and this import did not schedule it" (a pending draft
  keeps "Not imported: the entry has an unpublished draft that this import did not write").
- **`not_scheduled` only on a written update.** The warning describes an update that went live
  at once, so a row that was not written (`locked`, `pending_draft`, a rev conflict) does not
  carry it. A dry run's planned row does. When downloads leave only links to update, the plan made
  after them decides it.
- **The schedule call.** It is made right after the write, with the write's `_rev`, in place of
  the publish. It saves the link with the `_rev` it returned and `scheduledAt: T`. A stale `_rev`
  or an editor's lock gives `schedule_conflict` or `schedule_locked` ("Saved as a draft: the entry
  changed / is locked, so it was not scheduled"), on the model of `publish_conflict` and
  `publish_locked`. A hook's refusal (`SCHEDULE_REJECTED`) or any other EmDash error fails the
  record with the `emdash_*` code, after the write. A retry then schedules the importer's own
  draft (the "unchanged" rows above).
- **Status of the row.** `created` or `updated`. A record that only schedules or reschedules is
  `updated` (action `update`). Its `changes` hold one entry
  `{ field: "publishAt", before: <entry's scheduledAt or null>, after: T }`. A record published
  now gets no `publishAt` change, as publishing has none today.
- **Crash repair.** Rows with `schedule_*` errors count as unfinished, like `publish_*`. When a
  stop falls between the schedule call and the link put, the resumed record finds the entry
  pending at a `_rev` that is not its `writtenRev`. It takes the schedule as landed only when the
  entry's `_rev` decodes (F1) to the same `version` as `writtenRev` with a later `updatedAt`, and
  its `scheduledAt` equals `T`. A schedule changes no `version` (F2), and any edit adds one (F7,
  F8 for anything but terms). It then saves the link with the entry's `_rev` and `scheduledAt`.
  Otherwise the row is `conflict`, `schedule_unverified` ("Saved as a draft and maybe scheduled:
  the entry may have changed after the import wrote it, so it was not verified"), as
  `publish_unverified` is.
  - Scheduling the importer's own pending draft (no write) first saves a `writing` row with the
    draft's `_rev` as `writtenRev`, so a stop after that call is repaired the same way.
  - A landed schedule is recognised by the record's `publishAt` whatever the target is when the
    record resumes. If the time is now within the lead, the schedule is adopted (link saved with
    `scheduledAt`) and then published. If the sweep already published it (`sweptSince`: one
    `version` past `writtenRev`, at or after the time, published, no draft, no schedule), the
    link is saved at the swept `_rev` with `scheduledAt`, so rollback owns the result. That shape
    is also what an editor's unschedule and discard after the time leave, so the swept entry is
    adopted only when the record reached crash repair unchanged with no protected mapping: the
    entry then holds the record's values for every mapping (Task 5 review, round 2). Otherwise the
    link is not moved, and the protected mappings go on `unconfirmed`.
  - Both checks need the row's `entryId` to be the entry found: an editor's entry that crash
    repair finds by `flux_source_id` is never taken as landed, even at the same `version` and
    time.
  - (Final review A-I1.) "Holds the record's values for every mapping" compares only the
    mappings the plan compares: `updateFields` leaves the others out, and the importer's own
    draft may hold fields no mapping covers. So the swept entry is adopted only when, in
    addition, its whole live data is what the job journalled for the scheduled write: the
    journal row's `wrote.fields` (and `wrote.slug`, and the `publishedAt` rule) as in "Ownership
    after the scheduler published", one shared check (`holdsScheduled`). A job without a journal
    (`journal: false`), or a row without `wrote.fields`, adopts nothing: the link stays as
    written and the next run judges the entry.
- **A publish whose link save a stop lost** (final review A-I2). Each publish the importer sends
  is preceded by a `writing` row with the `_rev` it publishes as `writtenRev`: a write's (saved
  since M2) and, now, the importer's own pending draft's (`finishUnchanged`, as the schedule of
  that draft already does). A resumed row whose target is now adopts the entry (the link saved at
  its `_rev`, no `scheduledAt`) only when all hold: its `_rev` decodes to exactly one `version`
  past `writtenRev`; it is `published` with no draft and no schedule; no mapping is protected;
  and its live data and slug are what the journal recorded the publish makes live
  (`wrote.fields`, `wrote.slug`, `holdsWrote`). The journal therefore records `wrote` for every
  write a publish follows, not only scheduled ones. An editor's save on a collection without
  revisions, or a discard of the importer's draft, leaves the same shape with other values and is
  not adopted; without a journal nothing is. Otherwise the link is left alone and a rollback
  reports `rollback_changed`.
- **Downloads that outlast the lead.** The target is fixed when the record is read. If the
  record's downloads take longer than `SCHEDULE_LEAD_MS`, the time may be past when the schedule
  call is made. EmDash then refuses it (`VALIDATION_ERROR`, F2), and the record fails with
  `emdash_validation_error` after the write, leaving the importer's own draft. A retry finds the
  time past and publishes that draft now.
- **The sweep.** EmDash publishes the entry at `T` (F5). The next import finds it published
  without a draft and treats it as any published entry. The link's `writtenRev` is then stale,
  which matters only to rollback ownership (below) and to protection. With `protectEdited`,
  fingerprints are value-based, so the sweep changes none of their values; but the moved `_rev`
  vouches for none of them, so the next link save carries them as `unconfirmed` until a run finds
  them equal ("Unconfirmed fingerprints", Task 5 review round 2).
- **Dry run.** It plans the same: the `publishAt` change, and `not_scheduled` when `Job.revisions`
  is false and the entry is published.
- **Translations.** Each locale has its own status, and each template its own `publishAt`. When
  the sweep publishes a source, EmDash syncs its shared values to the group (M4e F7), as any
  publish does.

## Order of a record

For a template with `rules` or `publishAt` (others keep M5a's order):

1. Filter, `applyTemplate` (whole record: key, `publishAt`, every mapping).
2. Early entry lookup: link row, `content.get` (references read when mapped).
3. Mode: skip `exists` or `not_found` (Write modes).
4. Narrow to `updateFields` (an entry found through its link only).
5. Current links of the remaining mappings (`entryTerms` when taxonomies remain), and protection
   (fingerprints).
6. Link resolution, translation source, media and image lookups: real for unprotected mappings,
   side-effect free for protected ones.
7. Crash repair when no entry was found, then the M4e checks.
8. Plan. Protected changes become `field_edited` warnings. The `publishAt` change is added.
9. Dry run: stop. Otherwise the pending-draft and lock checks, downloads (unprotected only), the
   journal, the write, then publish or schedule, then `putLink` with fingerprints. For an
   `unchanged` record: `finishUnchanged` (publish or schedule the importer's own pending state),
   then the fingerprint refresh.

## Journal and rollback

| New write | Journal (M5a format) | Rollback |
| --- | --- | --- |
| Create, then schedule | `create` row, as today | Deleted (Trash, then permanent delete when confirmed). A trashed scheduled entry is never published by the sweep (F5) |
| Update with `updateFields` or protection | `update` row over the written mappings plus the differing pending-draft fields (M5a) | M5a revert sequence |
| Update, then schedule | `update` row; `before.status` and `before.scheduledAt` already hold the pre-run state | M5a sequence plus step 7 |
| Schedule or reschedule only (unchanged data) | `update` row written like `finishUnchanged`'s publish: `before.live` holds every field whose draft and live values differ, plus status, schedule and the link snapshot | Steps as needed: 6 puts back an earlier schedule, 7 removes the job's own |
| Fingerprint refresh | none | The link snapshot of a later job holds it |

**Journal format.** `before.link` gains the link row's `fields`, `unconfirmed` and `scheduledAt`
when present.
All three are optional, so M5a rows read as before and an M5a rollback ignores them. No new journal
kind is needed.

**Revert sequence, step 7 `unschedule`** (new, after M5a's six):

| Step | When | Call |
| --- | --- | --- |
| 7 unschedule | `state.scheduledAt` is set and `before.scheduledAt` is null, or has passed (`rollback_schedule_passed`), and the schedule is the import's: the job link's `scheduledAt`, or the passed `before.scheduledAt`. Any other schedule (an editor's, set after a stop) makes the row `rollback_changed` (Task 7 review I2) | `handleContentUnschedule` with the previous step's `_rev` (F3) |

Step 6 and step 7 exclude each other. Step 2 (publish) already clears a schedule (F4), so step 7
runs only for an entry the rollback leaves unpublished or published without republishing, for
example a draft the job scheduled. Unschedule has no hook and cannot be refused. It is
lock-checked like every step. `reached()` (the resumed-step check) treats step 7 as reached when
`scheduledAt` is null. The step is numbered 7 so that M5a rows' saved `step` numbers keep their
meaning. A dry-run rollback plans it as M5a's schedule change, `{ field: "scheduledAt", before:
<current>, after: null }` (amended in planning: M5a's dry run already reports a schedule
difference that way, so a second `publishAt` change would report it twice).

**Link hand-back.** The restored link carries `before.link.fields`, `before.link.unconfirmed` and
`before.link.scheduledAt`.
When `before.link` was null, the link is deleted (M5a). Amended in the Task 7 review: when the
link moves to the rollback's revision (the entry was as the earlier job left it), every restored
fingerprint is unconfirmed, since it was confirmed at the earlier job's revision (P5); and
`scheduledAt` is handed back only when the entry is left scheduled for that time, so a schedule
step 7 removed, or one that passed, never lets the earlier job's rollback take an editor's later
publish for the scheduler's (I1).

**Ownership after the scheduler published.** A rollback row whose link names the job
(`jobId === rollbackOf`, `entryId` matching) but whose `writtenRev` differs from the entry's `_rev`
is owned when all of these hold:

- the link has `scheduledAt`;
- the entry's `_rev` decodes to exactly one `version` more than `writtenRev`;
- the entry is `published` with no draft and no `scheduledAt`;
- its `updatedAt` is at or after the link's `scheduledAt`;
- (Task 7 review) the entry shows what the job left it to publish, from the journal row's
  `wrote`: its live data has the fingerprint of every field the scheduled publish made live (the
  entry's data with the importer's own pending draft and what the write sent, recorded on any
  write after which the entry may stay scheduled, a publish that then fails included), its slug
  is the one the write sent, and its `publishedAt` is the one the scheduler gives it. The sweep
  sets `publishedAt` to the scheduled time only on a first publication and keeps it otherwise
  (`src/scheduled-publish.ts:164-165`), so the expected value is the `publishedAt` read before the
  write, or the link's `scheduledAt` when that was null. Times compare as instants. A row without
  `wrote.fields`, or with none, fails. On both sides an absent field counts as null: EmDash reads
  an entry without its null columns (`mapRow`, `repositories/content.ts:2926-2934`).

That is exactly the sweep's publish (F6). An editor's manual "publish now" before `T` fails the
`updatedAt` test. An editor's unschedule and discard after `T` fails the values. On an entry
never published, an editor's publish after `T`, or a reschedule the sweep then publishes, fails
`publishedAt`; on one published before, such a publish changes no content and is not told apart.
Any edit adds a `version`. The rule applies to created entries (delete) and changed ones (revert) alike, and
the revert sequence then runs from the published state. A row that fails it stays
`rollback_changed`, as in M5a.

**Codes.**

| Code | Kind | When |
| --- | --- | --- |
| `exists` | warning (`unchanged`) | `mode: "create"` and the entry exists |
| `not_found` | warning (`unchanged`) | `mode: "update"` and no entry has the key |
| `field_edited` | warning | A protected mapping differs from the feed; not written |
| `not_scheduled` | warning | The published entry's update went live at once: the collection has no revisions, or only terms and bylines changed (amended in planning) |
| `schedule_conflict`, `schedule_locked` | conflict, locked | The schedule call met a stale `_rev` or an editor's lock; saved as a draft |
| `schedule_unverified` | conflict | A resumed schedule cannot be proven to be the importer's |
| `invalid_date`, `not_scalar` | failed, field `publishAt` | The `publishAt` value cannot be read |
| `emdash_schedule_rejected` | failed | A `content:beforeSchedule` hook refused |

## Workers and Node

- **Costs per record.** The early lookup moves today's two reads forward and does not add any.
  Skipped records cost less (no lookups, no write). Fingerprints cost CPU only: one digest per
  mapping per record. The schedule call replaces the publish (M5a Results: 28-29 D1 queries for a
  schedule, 76 for a publish), so a scheduled record costs no more than a published one. A refresh
  adds one plugin storage put, once per entry after the upgrade and once when a protection lifts.
  The link row grows by about 40-100 bytes per mapping (the name, quoted, and a 16-character
  fingerprint), plus the name again while it is listed in `unconfirmed`. A journal row of a write
  that a publish or schedule follows grows by the same per data field (`wrote.fields`).
- **Caps.** `WORKERS_BATCH_CAP` (11), `WORKERS_LINKED_BATCH_CAP` (6) and
  `WORKERS_ROLLBACK_BATCH_CAP` (3) stay, subject to V7. The rollback's longest sequence keeps five
  content calls, because step 7 replaces step 6. `STEP_COST.unschedule` is 15, as for schedule.
  `ROW_RESERVE` is 165 (Task 7 review, from 135): `COST_RECORD` (25), the longest sequence
  (update, publish, unpublish, update, and schedule or unschedule: 35 + 35 + 15 + 35 + 15) and a
  term read (5).
- **Lookup budget.** Protected links are looked up as unprotected ones are (`COST_READ`, the M4b
  costs). Unlisted mappings cost nothing.
- **Node.** No change: the job's `batchSize` applies.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `rules.updateFields` | 1-200 unique names, each mapped | A template maps at most a few dozen; schema bound |
| Fingerprints per link row | One per mapping, 16 characters each | No growth past the template |
| `SCHEDULE_LEAD_MS` | 60,000 | EmDash refuses a time that is not in the future at its own clock (F2); a minute absorbs the time between the record's read and the call. Downloads that take longer fail the record with `emdash_validation_error`; a retry publishes it ("Publish, draft or schedule", Crash repair) |
| `publishAt` years | 0000-9999 | `dateConverter` (M4a) |
| New batch caps | none (V7), pending Task 10's re-measurement on the finished code | V7 measured 772 D1 queries for the largest batch; Task 10 measures again, including the longest rollback sequence (final review) |

## Testing

- **Unit, template and job:** the `rules` and `publishAt` schemas (strict, one of `from`/`expr`);
  the refusals (`updateFields` or `protectEdited` with `create`, unmapped and repeated names, an
  empty list, `publishAt` with `publish: false`); `tz: "site"` reading the site time zone;
  `Job.revisions`; `publishAt` conversion, empty, `invalid_date`.
- **Unit, engine (fakes):** each mode row, including a resumed `writing` row and a `publish_*` retry
  in `create` mode, duplicate keys, linked records, and no lookups, terms or downloads for a
  skipped record; `updateFields` narrowing for every kind, with no term created and nothing
  downloaded for an unlisted mapping; crash repair comparing every mapping; canonical forms
  against `planRecord`'s comparison for every kind (property test: `same(a, b)` implies equal
  fingerprints); fingerprints recorded after creates, updates and refreshes, merged across
  templates, kept for protected and unlisted mappings; each row of the protection table, including
  the pre-M5b fallback with a term change; side-effect-free resolution of protected links and
  media; lifting by equality and by a job without `protectEdited`; every row of the publish table;
  `not_scheduled`; the lead margin; `schedule_conflict`, `schedule_locked`, a hook refusal, and the
  resumed schedule adopted by `_rev` arithmetic or `schedule_unverified`; the journal for each new
  write path, and `before.link.fields`; rollback step 7 and its `reached()` check; ownership after
  the scheduler (adopted, and refused for an editor's publish before `T` and for one more
  `version`); dry runs planning the same verdicts and writing nothing. Clock-dependent rules run
  under the moving clock (M5a open issue).
- **Integration on `sites/dev`:** create-only and update-only runs over a feed with new and
  existing keys; `updateFields` leaving an unlisted field an editor changed; with `protectEdited`,
  an editor's REST edit of one field (revisioned: draft save then publish; plain: direct), a term
  change through the terms route and a byline change, each kept with `field_edited` while the other
  mappings update, then lifted by a job without `protectEdited`; a pre-M5b link row (fields removed
  through SQLite) and its fallback; a schedule in the future (created and updated entries, both
  collection kinds), a reschedule, a past time publishing now, the sweep driven through
  `runScheduledTasks` in a probe route publishing them, a re-run after the sweep `unchanged`; a
  rollback before the sweep (the entries' schedules removed or restored) and after it (ownership
  after the scheduler); a French translation job with `mode: "update"`; kill-and-resume between the
  schedule call and the link put.
- **Cloudflare parity on `sites/dev-cf`:** a create-only then update-only pair; protection of an
  edited field on D1; a scheduled create and update, the sweep through the probe, then a rollback
  restoring them; V1-V7 on D1.

## Plan sizing

Ten tasks, as planned (amended): (0) prove V1-V7; (1) template rules, `publishAt`, job options
and `Job.revisions`; (2) fingerprints and canonical forms; (3) revisions (`encodeRev`,
`decodeRev`), the `schedule` port, the adapter and the fakes; (4) the early lookup, modes,
`updateFields` and fingerprint recording; (5) protection; (6) publish, draft or schedule, with its
crash repair; (7) rollback step 7, ownership after the scheduler and the link hand-back; (8) Node
integration; (9) workerd parity; (10) the review run and note. A final fix wave follows the
whole-branch review.

## Out of scope for M5b

Backdating `publishedAt` (F11); unpublishing or unscheduling as an import action (`publish: false`
never takes content down, and M5c handles unpublishing missing entries); a per-job schedule
option (a constant `publishAt` expression covers it); protecting status changes beyond the M2
pending-state rule; writing over an editor's pending draft with protection; skipping conversion
of unlisted mappings; field-level protection of values EmDash itself changes (hooks of other
plugins, translation sync), which counts as edits; predicting duplicate keys in a `create` dry run.

## Open issues carried forward

- **New in this design.**
  - A value error in an unlisted mapping fails an update (conversion is whole). Splitting
    `applyTemplate` so the key is read first would lift it.
  - Another plugin's `content:beforeSave` hook that rewrites a value makes the stored value differ
    from what was sent, so the field reads as edited and is protected. It already makes
    `planRecord` plan an update on every run today.
  - Saving Portable Text in the admin editor without changes may still alter it beyond what
    `canonicalPortableText` ignores (M4d's untested editor round trip). The field then reads as
    edited. This fails safe.
  - A change to a canonical form in a later version makes stored fingerprints differ, so the
    affected mappings read as edited until they equal the feed. This fails safe.
  - On link rows from before M5b, the first protected run cannot see term edits (F8) or reference
    edits made elsewhere (F15), so every mapped taxonomy and reference field that differs from the
    feed is protected until a job without `protectEdited` writes it or its value equals the feed.
  - For a link from before M5b whose entry has moved since `writtenRev`, every mapping counts as
    edited. So every mapping that differs from the feed stays protected and warns `field_edited`
    on each run, including mappings no one touched, until the entry's value equals the feed or a
    run without `protectEdited` writes it.
  - A slug staged in the importer's own draft is not readable (F13). Once an editor saves another
    field into that draft, `_rev` moves, the live slug differs from the staged slug's fingerprint,
    and the run warns `field_edited` for the slug although only the other field was edited. This
    fails safe: the slug is not written, and the draft is someone else's pending state anyway.
    The same holds after an editor discards the importer's draft, where the dropped values count as
    edits.
  - A reference field with more selections than the read returns (50, `referencesTruncated`) has a
    canonical form no written value has, so with `protectEdited` it never lifts: it stays protected
    until a job without `protectEdited` writes it.
  - Terms and reference edges are read before the write and are not fenced by `_rev` (F8, F15). A
    term or edge an editor changes between the importer's read and its write is not seen: when the
    write changes that taxonomy or reference field, it replaces the editor's change. The window is
    one record's processing time.
  - `publish: false` over an entry the importer scheduled earlier keeps the schedule, so the new
    draft goes live at that time (F5, F7).
  - A past `publishAt` publishes now: `publishedAt` is the import time, not the feed's.
  - The ownership-after-the-scheduler rule and the resumed-schedule rule decode `_rev` (F1), which
    is EmDash's internal format. A change to it in a later EmDash release makes both rules fail
    closed (`rollback_changed`, `schedule_unverified`).
  - A dry run in `create` mode plans `create` for every duplicate key.
  - `rules: {}` (an empty rules object) makes `ruled()` true, so the template takes the early
    lookup order (spec "Order of a record") without changing any decision. Harmless; noted in the
    final review.
  - The crash-repair and rollback value checks compare the fields the journal recorded
    (`wrote.fields`). A field that was null (absent) when the job wrote and that an editor set
    since is not among them. Any such edit also adds a `version`, so it is caught only by the
    version count, which an editor's single save on a collection without revisions passes.
  - The root `biome.json` lints `packages/**` and the root JSON files only, so `sites/**` (the
    test sites' pages, `run-scheduled.ts` included) is not linted by `pnpm lint`. Unchanged by
    M5b.
  - The sweep's re-run of `content:beforePublish` can refuse at `T` and unschedule the entry (F5).
    The import does not see this, and the entry stays an importer-owned draft at a `_rev` the link
    does not name. The next run reports it `pending_draft`.
- **From M5a** (`2026-11-03-m5a-review.md`), unchanged: the staged slug and references not in the
  pre-image; media and terms kept; `publishedAt` kept; a single row that could exceed the Workers
  limit in extreme cases; the import caps measured on local D1 only; the lookup budget's rate; the
  spec's open issues (references removed by a permanent delete, no actor on Trash and delete, the
  orphaned rollback job, the fakes' clock, three storage calls per create, `sourceId` missing on
  pre-M5a jobs, F18's spurious `rollback_changed`, the `required` check, an unwritten `update` row
  passing as `unchanged`, rollback order, partial writes on D1, the rollback window, `lastImport`
  at creation); the ledger items; the known flakes (F1, F2, port 4397). The M5a integration test
  that set a scheduled entry's link state through SQLite can now schedule through the import.
- **From M4e and earlier**, as carried in the M5a review, unchanged; the production Cloudflare
  build blocker from M2 still stands.
