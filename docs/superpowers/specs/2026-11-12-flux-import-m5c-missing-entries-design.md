# Flux Import M5c: missing entries

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Revised 2026-11-12 after the spec review (Rulings 21-29). Third of
three parts of Milestone 5 (Record rules and safety) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-5-split). Builds on M5b
([spec](./2026-11-04-flux-import-m5b-record-rules-design.md),
[review](../notes/2026-11-04-m5b-review.md)), merged at `20e8c07`. The direction was fixed by the
M5a outline ([M5a spec, "Outline of M5b and M5c"](./2026-11-03-flux-import-m5a-journal-rollback-design.md#outline-of-m5b-and-m5c));
this spec settles it against the code and EmDash 1.2.0, and amends it where noted (the owner moves
from `rules.missing.owner` to `rules.owner`, Ruling 29 M9).

## Goal

A template can say what happens to the entries its import created when a later feed no longer
holds them:

- **Owner** (`rules.owner`): a name the template gives its entries. A create stamps it on the
  entry's link row. Only entries stamped with the same owner, and touched since only by that
  owner, are ever considered. Entries created before M5c, by another owner, without an owner or by
  an editor are never touched.
- **Missing entries** (`rules.missing`): after a **completed** import pass, every owned entry whose
  key no record of the job had is **moved to Trash** or **unpublished**. Nothing is ever deleted
  permanently.
- **Safety**: a threshold (`maxPercent`, default 25) is checked on the whole set before anything
  is changed. Over it, nothing is changed and the job says why. An entry that was edited since the
  import last wrote it, has a pending draft or schedule, or (for Trash) has active translations, is
  left alone and reported.
- **Journal and rollback**: every trash and unpublish is journalled in the M5a format (one new
  journal kind, `trash`), and `jobs/rollback` undoes it: an entry is restored from Trash and
  republished, an unpublished one republished. The revert sequence gains steps 8 and 9.
- **Dry run**: plans the same rows and reports the threshold verdict.

The template stays `version: 1`. Everything new is optional. A template without `rules.owner` and
`rules.missing` behaves exactly as in M5b, except that a link stamped with another template's
owner loses the stamp when one of its records reaches it (Rulings 2, 21).

## Decisions

| Topic | Decision |
| --- | --- |
| Shape | `rules.owner: string` and `rules.missing: { action, maxPercent? }` sit in `rules`, next to M5b's `mode`, `updateFields` and `protectEdited`, so a saved template (M6) carries them. `missing` needs `owner`. The job option `missing` overrides the threshold or turns the phase off for one run. All optional and additive, so `version` stays 1 (Rulings 1, 7, 28). |
| What "owner" means | An explicit name, stamped on `LinkRow.owner` by the job's own creates. The code has no other stable identity: `LinkRow` is keyed `collection:locale:sourceKey` and shared by every template with that key (`src/engine/types.ts:200-228`, `linkKey` `:376-378`); `jobId` names the last job that wrote the link and changes every run (`putLink`, `src/engine/batch.ts:353-372`); `lastImport` is per URL source, not per template, and names only the newest job (`src/plugin/sources.ts:33-43`). Templates have no ID until M6 (Ruling 1). |
| Losing ownership | Any record of a template whose owner differs, or that has none, that reaches a link stamped with an owner drops the stamp, whatever its outcome: written, unchanged, skipped by its mode, protected (Rulings 2, 21). |
| Which run acts | Only a real import job's first pass that **completed** (no job-level error), read at least one record with a key, and had no record without a readable key (record errors, unreadable keys, rows a reader skipped). Not a cancelled, failed or paused pass, not a retry pass, not a rollback job, not a job with `journal: false` (refused at creation). A dry run plans (Rulings 5, 24, 25). |
| What "seen" means | A record row of this job, from its first pass, with the entry's source key, in any status, including a record that failed on another field after its key was read (Ruling 24). A filtered record is not seen: the filter is part of what the feed selects (Ruling 4). |
| Two stages | **Count** reads every owned link and every unseen entry; **act** runs only when the count passes the threshold, and decides and acts on each entry again. A stop between them loses nothing (Ruling 6). |
| Threshold | Refused when `found × 100 > maxPercent × base`. `found` counts every unseen candidate whose entry exists, whether or not the act stage would change it (Ruling 22). `base` is the owner's unmarked candidate links minus this job's creates (`counters.created`) on a real run, the candidate links on a dry run (Ruling 23). A refusal changes nothing, sets `Job.missing.verdict = "refused"` with a job warning, and the job still completes (Rulings 6, 7). |
| Editor safety | An entry is acted on only when it is as the importer left it: its `_rev` is the link's `writtenRev`, or EmDash's scheduler published the importer's schedule since (M5b "Ownership after the scheduler published"). Otherwise it is `unchanged` with `missing_edited`, **whatever `protectEdited` says** (Ruling 8). |
| Pending state | An entry with a pending draft or a schedule is `unchanged` with `missing_pending`, also when the importer made it (Ruling 9). |
| Translations | Trash leaves a group root with other active entries (`missing_has_translations`), as M5a's rollback does. Unpublish acts on the one locale. Each locale's template has its own owner and links (Ruling 10). |
| Concurrent jobs | A link whose `jobId` is a job created after this one is not counted and not acted on (job IDs are ULIDs, F15) (Ruling 11). |
| Mixed sources | The phase refuses as a whole when an owned candidate link was stamped by a job from another URL source (`LinkRow.ownerSource`, Ruling 27). Two templates sharing one owner name is otherwise the operator's responsibility ("Template documentation"). |
| Delete | Not offered. A permanent delete cannot be rolled back (F4) (Ruling 12). |
| Journal | Trash: a `trash` journal row with the M5a `before`. Unpublish: an `update` row with `before.status: "published"` and empty `live`, which the M5a revert sequence already rolls back (Ruling 13). |
| Rollback | Trash rows: step 8 `restore` (`handleContentRestore` with `_rev`, F2), then step 9 `republish` when the entry was published. Unpublish rows: the M5a sequence (step 2 publishes). The link goes back to `before.link`, owner included (Ruling 13). |
| Marked links | After acting, the link row is saved with `missing: { jobId, action, at }`. A marked link is left out of later counts. Any import write to the entry clears the mark (Ruling 14). |
| Keys that come back | An unpublished entry that reappears is republished by the M2/M5b rule for the importer's own pending state. A trashed one is not restored automatically: its record is `conflict`, `missing_trashed` (Ruling 15). |
| Rows and counters | Each entry the act stage decides gets a record row after the import's rows (`seq >= Job.missing.fromSeq`): `removed` (new status and counter) with `action: "trash" \| "unpublish"`, or `unchanged`, `locked`, `conflict`, `failed` with a code. `jobs/retry` does not touch these rows; the next completed run decides their entries afresh (Rulings 17, 26). |
| Capabilities | `content:restore` is added to the declared list for disclosure: rollback restores from Trash through the trusted runtime (F12). Nothing else changes (Ruling 18). |

## EmDash facts this design relies on

Checked on 2026-11-12 against `emdash@1.2.0` (package `src/`, cited as file:line), the docs
(`emdash-docs` MCP) and the Cloudflare D1 docs, and confirmed by the spec review. M5a's facts (M5a
F1-F18) and M5b's (M5b F1-F15) still hold; the ones below are new, sharpened, or re-checked for
M5c. All are **confirmed** from source or docs unless marked otherwise.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | **Trash.** `handleContentDelete(collection, id)` on the runtime runs `content:beforeDelete` (a refusal is `DELETE_BLOCKED`), then sets only `deleted_at` on an active row and releases the entry's locks. It takes no `_rev` and no actor, and does not check locks on this path (the REST route and admin do). `version`, `updated_at`, the slug, the status, the revision pointers and `scheduled_at` stay, so **`_rev` does not move**. An entry already in Trash is `NOT_FOUND` | `src/emdash-runtime.ts:4093-4123`; `src/api/handlers/content.ts:1867-1910`; `src/database/repositories/content.ts:1618-1634`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) "Move to Trash" row (lock "Enforced" there describes REST and admin); [hooks: content:beforeDelete](https://docs.emdashcms.com/reference/hooks/#contentbeforedelete) |
| F2 | **Restore.** `handleContentRestore(collection, id, { _rev })` is fenced on `version` and `updated_at` of the trashed row (stale: `CONFLICT`), and sets `deleted_at = NULL`, `live_revision_id = NULL`, `status = 'draft'`, `scheduled_at = NULL`, `updated_at = now`, `version + 1`. It keeps the slug, `published_at`, `draft_revision_id` and the revisions. A translation slot taken meanwhile is `CONFLICT` ("An active translation already exists in this locale"). It fires `content:afterRestore`; no before-hook can refuse it, and it is not lock-checked. So restore **moves `_rev`** and never brings back the status or schedule | `src/emdash-runtime.ts:4136-4161`; `src/api/handlers/content.ts:1912-1965`; `src/database/repositories/content.ts:1643-1674`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) "Restore from Trash" row ("Clears the live pointer; preserves any draft pointer"); [working with content](https://docs.emdashcms.com/guides/working-with-content/#move-content-to-trash) ("comes back as a draft with no schedule") |
| F3 | **Publishing a restored entry.** Publish reads the active row (`findById` filters `deleted_at IS NULL`). On a revisioned collection it promotes `draft_revision_id`, else `live_revision_id`, else a new revision made from the columns; without revisions (`promoteRevision` false) it keeps or creates a live revision from the columns. It keeps an existing `published_at`. So a restored entry that had no draft publishes its columns, which hold the live data it had when trashed; one that had a draft would publish the draft | `src/database/repositories/content.ts:615-621`, `:2486-2525` (`:2490-2499`, `:2501`), `:2583-2592`, `:2608`; M5b F4 |
| F4 | **Permanent delete** works on trashed rows only, removes the row and its revisions and cannot be undone | `src/database/repositories/content.ts:1689-1700`; `src/emdash-runtime.ts:4163-4177`; M5a F8; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F5 | **Slugs while trashed.** The unique constraint is `(slug, locale)` with no `deleted_at` condition, so a trashed entry keeps its slug and a create with that slug is `SLUG_CONFLICT`. Restore never changes the slug, so it cannot conflict on it | `src/schema/registry.ts:1905-1906`; `src/api/handlers/content.ts:1436-1460` (M5a F9); `src/database/repositories/content.ts:1656-1661` |
| F6 | **Translation slots.** One active entry per (translation group, locale): the unique index has `WHERE deleted_at IS NULL`, so a trashed translation frees its locale and its restore can conflict | `src/schema/registry.ts:1968-1972`; M5a F16 |
| F7 | **Unpublish.** `handleContentUnpublish(collection, id, { _rev })` runs `content:beforeUnpublish` (`UNPUBLISH_REJECTED`), is fenced on `version`, `updated_at`, status and the pointers, sets `status = 'draft'`, `live_revision_id = NULL`, `scheduled_at = NULL`, `version + 1`, and keeps a pending draft or creates one from the live revision. Every entry the phase unpublishes is published with a live revision, so **afterwards it always has a draft pointer**: `status: "draft"`, `hasDraft: true`, no live pointer, no schedule, one `version` past the `_rev` sent (on a collection without revisions the draft holds the first publish's values and hides the columns, M5a F18). A draft with no live pointer and no schedule is returned unchanged | `src/database/repositories/content.ts:2727-2790` (`:2739-2741` the no-op, `:2746-2757` the draft from the live revision); `src/emdash-runtime.ts:4652-4684`; `src/api/handlers/content.ts:2575-2600`; M5a F10, F18 |
| F8 | **Reads leave Trash out.** `handleContentGet` and `handleContentList` (so `content.get` and `findBySourceId`) do not return trashed entries; `handleContentGetIncludingTrashed` does, with the `_rev` it had | M5a V2 (proven); `src/emdash-runtime.ts:3364-3377` |
| F9 | **Create stages no draft.** `handleContentCreate` writes the columns with `status` defaulting to `draft` and no draft revision, so an entry the importer created and never published has `hasDraft` false | `src/api/handlers/content.ts:1205-1325` (`:1323`) |
| F10 | **Plugin storage queries.** A `where` or `orderBy` field must be declared in some index of the collection (fields of composite indexes count one by one), else `StorageQueryError`. `limit` is at most 100. `in` binds one parameter per value. Without `orderBy` pages are ordered by `(created_at, id)` and the cursor carries both values; with `orderBy` the cursor re-reads the cursor row, which must still exist | `src/plugins/storage-query.ts:93-127`, `:215-219`; `src/database/repositories/plugin-storage.ts:354-473` (`:357`, `:390-396`, `:409-410`, `:449`) |
| F11 | **Plugin storage writes and indexes.** `put` upserts and keeps `created_at`, so a cursor without `orderBy` is stable while rows are rewritten. Declared indexes are created (and orphans removed) by `syncDeclaredStorageIndexes` once per process from the scheduler path; a missing physical index slows queries but never fails them, since validation uses the manifest | `src/database/repositories/plugin-storage.ts:149-170`; `src/plugins/storage-indexes.ts:236-297`; `src/emdash-runtime.ts:1031-1041` |
| F12 | **Capabilities.** `content:restore` is a current plugin capability, for reading and restoring trashed content, and gates `ctx.content`'s restore methods; `content:write` covers `ctx.content.delete()` (Trash); `content:publish` covers unpublish. The importer uses the trusted runtime, not `ctx.content`, so these are declared for disclosure | `src/plugins/manifest-schema.ts:37`; `src/plugins/context.ts:1734`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/); `packages/flux-import/src/plugin/definition.ts:44-65` |
| F13 | **D1 limits.** At most 100 bound parameters per query, and the Workers paid plan's 1,000 queries per invocation (the caps of M5a and M5b are measured against it) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/); M5b review V7 |
| F14 | **Hooks on the importer's calls.** `content:afterDelete` (with `permanent: false`) after a trash, `content:afterRestore` after a restore, `content:afterUnpublish` after an unpublish. Another plugin's `content:beforeDelete` can refuse a trash; there is no `beforeRestore` | `src/emdash-runtime.ts:4117-4120`, `:4150-4158`; [hooks](https://docs.emdashcms.com/plugins/creating-plugins/hooks/#contentbeforedelete) |
| F15 | **Job IDs.** Jobs get `ulid()` from `emdash`, re-exported from `ulidx`: 48 bits of milliseconds then randomness, so IDs of jobs created in different milliseconds sort by creation time. **Unconfirmed** for IDs made in the same millisecond (not monotonic) and across processes with skewed clocks (V6) | `packages/flux-import/src/plugin/routes.ts:3`, `:197`, `:212`; `src/index.ts:147` |
| F16 | **The scheduler's publish** keeps the importer's ownership only through M5b's rule (`sweptSince` plus `holdsScheduled`, which reads the scheduling job's journal row) | `packages/flux-import/src/engine/rules.ts:190-259`; M5b F5, F6 |

### Facts about flux-import's own code

| # | Fact | Evidence |
| --- | --- | --- |
| P1 | **The key is lost on a mapping error.** `applyTemplate` reads the key first and keeps reading every mapping, then returns `{ ok: false, errors }` without the key when any mapping failed; `decideRecord` then saves the row with `sourceKey: null`. So today a record whose key was read but whose price failed to convert has no key on its row | `src/engine/template.ts:743-786`, `:918`; `src/engine/batch.ts:827-830` |
| P2 | **What the readers skip without a record.** Every reader yields a record with `error` for a row it cannot parse (CSV `column_count`, JSON and JSON Lines `invalid_record`, XML and XLSX record errors), so those rows fail before their key (P1 covers them). Readers skip without a record only: CSV lines with no bytes (`rowHasContent` false); JSON Lines blank lines; XLSX rows with no value at all, and **XLSX rows whose only values are unreadable cells** (`converter.skipped`, reported only as a job warning); XML elements outside the records path, and JSON members outside the records array, which are not records by the template's own definition. Pasted text is staged as an upload and read by the same readers | `src/sources/csv.ts:66-75`, `:99`; `src/sources/csv-reader.ts:19-31`; `src/sources/json.ts:56-74`, `:466-481`; `src/sources/xlsx.ts:106-111`, `:280-301`, `:321-324`; `src/sources/xml.ts:52-58`, `:326`; `src/plugin/service.ts:159-166` |
| P3 | **Source identity on a job.** A job created from a URL source records `Job.sourceId`, the source row's stable ID (M5a). A file upload or a paste records only `uploadId`, which is new for every upload. So only URL sources have a stable identity | `src/engine/types.ts:60-61`, `:68`; `src/engine/jobs.ts:188`; `src/plugin/sources.ts:22-36`, `:404-429` |

### Unconfirmed, to be proven by Task 0

Each item is proven on Node (SQLite) and workerd (D1), on a collection with revisions and one
without, through a temporary probe route as in M5a and M5b.

- **V1. Trash and restore round trip.** A published entry without a draft, trashed through
  `handleContentDelete`: `_rev`, slug, status and `scheduledAt` read through
  `handleContentGetIncludingTrashed` are unchanged; `content.get` and `findBySourceId` miss it.
  `handleContentRestore` with that `_rev` gives a draft, no schedule, `version + 1`; a publish with
  the returned `_rev` gives back the pre-trash data, slug, terms, references, bylines, status and
  `publishedAt` (compared with `sameStored`). A never-published draft created by the importer
  (F9) trashed and restored reads back equal without a publish. Restore with a stale `_rev` is
  `CONFLICT`; restore of a translation whose locale was taken meanwhile is `CONFLICT`.
- **V2. Unpublish rolled back by the M5a sequence.** On both collection kinds, a published entry
  without a draft, unpublished with `_rev`, reads exactly F7's state afterwards (draft pointer
  set), then is rolled back by the M5a revert sequence with an `update` pre-image `{ status:
  "published", scheduledAt: null, live: {} }`: step 2 alone (and step 4 where F18 leaves a draft)
  restores data, slug, status, no draft and `publishedAt`.
- **V3. An unpublished entry that comes back.** The next real import of its key, with the link
  saved at the unpublish's `_rev`, treats it as the importer's own pending state and republishes it
  (written or `finishUnchanged`), with and without `protectEdited`, on both collection kinds; the
  link's `missing` mark is gone afterwards.
- **V4. The new links index.** Adding `["owner", "collection", "locale"]` to the existing `links`
  collection: on an upgraded site (rows saved without `owner`), `query({ where: { owner,
  collection, locale } })` validates at once, the physical index appears after the next scheduler
  tick (F11), and paging 100 at a time with the returned cursor across separate requests visits
  every matching row once while other rows are `put` in between.
- **V5. The seen query on D1.** `records.query({ where: { jobId, sourceKey: { in: keys } } })`
  with `MISSING_PAGE` (50) keys runs on D1 within the 100-parameter limit (F13) and returns every
  row with those keys across pages.
- **V6. Job ID order.** Jobs created by consecutive `jobs/create` calls get IDs in creation order
  (F15). If same-millisecond order cannot be relied on, the comparison uses `Job.createdAt` of the
  link's job and a job read (one per distinct `jobId`, cached per batch), and this spec is amended.
- **V7. Trash of a translation.** Trashing a non-root translation leaves its source's data, terms,
  references and status unchanged, and `translations()` of the source no longer lists it.
- **V8. D1 query counts.** A count batch at `WORKERS_MISSING_SCAN_CAP` (provisional 40 reads), an
  act batch at `WORKERS_MISSING_BATCH_CAP` (provisional 10) of trashes and one of unpublishes, each
  with the journal and the `removed` recount, and a rollback batch at `WORKERS_ROLLBACK_BATCH_CAP`
  (3) of trash rows (steps 8 and 9) and of unpublish rows. Each must stay under 900 queries (the
  margin M5b kept). A cap that does not fit is lowered to what does.

If V1, V2 or V4 fail, the plan stops and this spec is amended before Task 1.

## Template and job

```json
{
	"version": 1,
	"collection": "products",
	"locale": "en",
	"key": { "from": "sku" },
	"slug": { "from": "handle" },
	"rules": {
		"owner": "shop-feed",
		"missing": { "action": "unpublish", "maxPercent": 10 }
	},
	"fields": { "title": { "from": "Name", "type": "text" } }
}
```

| Option | Value | Default |
| --- | --- | --- |
| `rules.owner` | 1-100 characters of `[A-Za-z0-9._:-]` | none: creates are not stamped |
| `rules.missing.action` | `"trash"`, `"unpublish"` | required when `missing` is given |
| `rules.missing.maxPercent` | integer 0-100 | 25 |
| job option `missing` (`jobs/create`) | `false` (skip the phase for this run), or `{ maxPercent }` (replaces the template's for this run) | the template's |

Refused at job creation:

- `rules.missing` without `rules.owner`: `invalid_template`, "rules.missing needs rules.owner".
- The job option `missing` when the template has no `rules.missing`: `invalid_options`.
- `rules.missing` with `journal: false`: `invalid_options`, "rules.missing needs the journal, so
  its changes can be rolled back".

```ts
// Template rules gain (zod, strict):
//   owner?: string
//   missing?: { action: "trash" | "unpublish"; maxPercent?: number }
// CreateJobInput and the jobs/create route gain: missing?: false | { maxPercent: number }
// CreateJobInput gains skippedRows?: number   (XLSX: converter.skipped, Ruling 25)
// Job gains:
//   missingLimit?: { maxPercent: number } | false   (resolved at creation; absent: no rules.missing)
//   unkeyed?: number   (first-pass rows without a readable key, skipped rows included; absent: 0)
//   missing?: {        (absent until the first pass completes)
//     stage: "count" | "act" | "done";
//     fromSeq: number;            // first seq of the missing rows: the import's record count
//     cursor?: string;            // the links query cursor within the stage
//     owned: number;              // count stage: candidate links
//     found: number;              // count stage: unseen candidates whose entry exists
//     rows: number;               // act stage: rows written
//     removed: number;            // act stage: entries trashed or unpublished (or planned);
//                                 //   recounted from the rows at each act batch (Ruling 29 M1)
//     verdict?: "act" | "refused" | "skipped";
//   }
// Job.phase gains "missing". Counters gain removed?: number (absent: 0).
// RecordStatus gains "removed". RecordRow.action also takes "unpublish" (import job rows) and
//   "restore" (rollback rows of trash journal rows).
// LinkRow gains:
//   owner?: string                         (see "Owner")
//   ownerSource?: string                   (the stamping job's sourceId, URL sources only)
//   missing?: { jobId: string; action: "trash" | "unpublish"; at: string }
// JournalBefore.link gains owner?, ownerSource?, missing?
// JournalEntry.kind gains "trash" (with before, entryId, confirmed absent)
// applyTemplate's failure gains key?: string (Ruling 24)
// RevertStep gains "restore"; ContentRuntime gains handleContentRestore
// ContentPort.revertStep takes step "restore" (rev: the trashed entry's); trash and
//   revertStep("unpublish") exist since M5a
// STORAGE.links.indexes gains ["owner", "collection", "locale"]
```

## Owner

- **Stamping (Ruling 29 M7).** A link save carries `owner: rules.owner` (and `ownerSource:
  job.sourceId` when the job has one) only for an entry this job is shown to have created: the
  save right after the job's own create in `writeRecord` (a linked create included), or crash
  repair finishing a row whose journal `create` row names the entry with `confirmed: true`, or whose
  record row is `writing` with `action: "create"` and that `entryId`. An entry crash repair adopted
  by `flux_source_id` alone (`confirmed: false`) is not stamped. Only a repair stamps this way: a
  record that finds its link (a `jobs/retry` pass included) never stamps again, since another
  owner may have dropped the stamp since (Ruling 30).
- **Keeping.** A link save by a template whose `rules.owner` equals the stored link's keeps
  `owner` and `ownerSource`. `putLink` reads them from `ctx.link` (or `ctx.stored` after crash
  repair), which every record already reads (no extra read). The M5b fingerprint refresh keeps
  them.
- **Dropping (Rulings 2, 21).** A record whose template's owner differs from the link's, or that
  has none, drops `owner` and `ownerSource` as soon as it has read the link, whatever its outcome:
  its own `putLink` saves the link without them, and a record that writes no link (unchanged,
  skipped by `mode: "create"` or `"update"`, every difference protected, `pending_draft`,
  `locked`, failed after the link read) puts the stored link once without them, keeping every
  other field (`writtenRev`, `jobId`, `fields`, `unconfirmed`, `scheduledAt`, `missing`). That
  costs one link put, only when the owners differ, and only once per link (the next record finds
  no stamp). A dry run drops nothing. The drop is not journalled: a rollback of this job restores
  the stamp only where the journal's link snapshot holds it, which fails safe.
- **Dropping before the link read (Ruling 30).** A record of another owner, or of none, that fails
  after its key was read but before it read the link (a mapping error, or on the plain path a link
  or media resolution error before the entry lookup) reads the link once and drops a foreign stamp
  the same way. That costs one link read per such failure, and nothing in a dry run. A record
  whose key failed reads nothing. A record that defers (`MediaDeferred`) or hits a job-level error
  skips the drop until it is decided again.
- **Rollback.** The journal's link snapshot holds `owner`, `ownerSource` and `missing`, and the
  M5a link hand-back restores them with the rest of `before.link`. A rolled-back create deletes its
  link (M5a).
- **Not stamped.** Entries created before M5c, or by a template without `rules.owner`, have no
  owner and stay unowned: there is no adoption (Out of scope). An editor's entry never has a link
  row.

## Template documentation

The template docs (and M6's saved templates) state, next to `rules.owner`:

- **One owner name, one feed.** Two templates with the same owner, collection and locale act as one
  import: each one's missing phase treats the other's entries as its own, and trashes or
  unpublishes the ones its own feed lacks. Giving each feed its own owner is the operator's
  responsibility. The phase refuses when it can tell that two URL sources share the owner (Ruling
  27); it cannot tell for uploads and pastes, which have no stable identity (P3).
- **Small feeds.** With the default 25%, an owner with fewer than four entries refuses as soon as
  one is missing (1 of 3 is 34%), and one with four accepts one (25% is not more than 25%). Use the
  job option `missing: { maxPercent }` for a run where more are expected to go, after a dry run.
- **Recurring feeds whose items come back** should use `unpublish` (Ruling 15).
- **A refused run** is re-run with the job option; for an unchanged URL source also with `force:
  true`, since otherwise the `lastImport` skip returns it as unchanged (M5a).

## The missing phase

### When it runs

When `importPass` returns `done` for a real or dry-run import job whose `missingLimit` is set and
not `false`, the batch does not complete the job. It checks:

1. `Job.unkeyed` is 0. Otherwise `verdict: "skipped"`, job warning "Missing entries were not
   checked: <n> records had no readable key (or were skipped by the reader), so their entries may
   be in the feed".
2. At least one first-pass record had a key: `counters.created + updated + unchanged + locked +
   conflict + failed > unkeyed` (filtered records have no key). Otherwise `skipped`, "Missing
   entries were not checked: the import read no record with a key".

Then it sets `phase: "missing"`, `missing: { stage: "count", fromSeq: cursor.seq, owned: 0,
found: 0, rows: 0, removed: 0 }` and returns not done; the next `jobs/next` runs the count stage.
A skip completes the job in the same batch. A retry pass never enters the phase, and a job
cancelled, paused or failed before the pass completed never reaches it (Ruling 5).

**What `unkeyed` counts (Rulings 24, 25).** It starts at the job's `skippedRows` (the XLSX
converter's `converter.skipped`, rows with only unreadable cells, P2), passed by `startImport`
from `convertXlsx` into `createJob`. `processRecord` bumps it for a row saved `failed` with
`sourceKey: null` (and, as counters are, for such a row met again after a crash). After the
change below, that row is only a record with a reader error, a filter error, or a key that is
missing, empty, not a scalar or too long. The other silent skips of P2 (blank CSV and JSON Lines
lines, XLSX rows with no value, elements and members outside the records path) hold no data, so
they do not count.

**Keys of records that fail later (Ruling 24).** `applyTemplate` returns `{ ok: false, errors,
key }` when the key was read and is valid (no error on the key's field), and `decideRecord` saves
such a failed row with `sourceKey: key` instead of `null` (`src/engine/batch.ts:829-830`). Nothing
else reads a failed row's `sourceKey` except the seen query and `jobs/records`, so the change only
makes the log show the key. A record whose key failed has no `key`, and stays `sourceKey: null`.

### Candidates

Both stages page the owner's links:

```ts
links.query({ where: { owner, collection, locale }, limit: 100, cursor })   // no orderBy (F10, F11)
```

A link is a **candidate** when it has no `missing` mark and its `jobId` is not a job created after
this one (`link.jobId > job.id`, F15, Ruling 11). Each candidate counts toward `owned`.

**Mixed sources (Ruling 27).** A candidate with an `ownerSource` that is not this job's `sourceId`
(also when this job has none) means a job from another URL source created entries under this
owner. The count stage then stops: `verdict: "refused"`, `stage: "done"`, nothing changed, job
warning "Missing entries were left alone: owner <owner> also has entries created from another URL
source (<sourceId>); give each feed its own owner". The check reads only the links already paged.

For each page, the candidates' keys go in pages of `MISSING_PAGE` (50, F13) to

```ts
records.query({ where: { jobId: job.id, sourceKey: { in: keys } }, limit: 100 })   // paged
```

A key with a row whose `seq < fromSeq` is **seen**. A row with `seq >= fromSeq` is this phase's
own earlier row (crash repair, below). Every unseen candidate is read (`content.get`, with
`getIncludingTrashed` when it misses) and decided.

### Verdicts

| The entry | Counts toward `found` | Verdict | Row (act stage) |
| --- | --- | --- | --- |
| Not found, or in Trash (not marked by this importer) | no | leave | `unchanged`, `missing_gone`: "Nothing to do: the entry no longer exists or is in Trash" |
| Its `_rev` is not the link's `writtenRev`, and the scheduler's publish (F16) does not explain it | yes | leave | `unchanged`, `missing_edited`: "Left alone: the entry changed after the import last wrote it (an editor or another process)" |
| Has a pending draft or a schedule (`hasDraft`, `scheduledAt`) | yes | leave | `unchanged`, `missing_pending`: "Left alone: the entry has a draft or a schedule that is not live" |
| `unpublish`, and the entry is a draft (never published, or unpublished) | yes | leave | `unchanged`, `missing_not_live`: "Nothing to do: the entry is not published" |
| `trash`, and the entry is its group's root (`group === id`) and `translations()` lists another active entry | yes | leave | `unchanged`, `missing_has_translations`: "Left alone: the entry has translations that are still active" |
| Otherwise | yes | **act** | see "Act stage" |

The order of the checks is the table's. Every unseen candidate whose entry exists counts toward
`found`, whatever its verdict (Ruling 22): the threshold measures how much of the owner's content
the feed no longer holds, not how much the phase would change, so a feed that lost most of its
items is refused even when most of them happen to be edited. The editor check is the M5a ownership
test by revision (and the M5b one after the scheduler), read from the link the query returned. The
swept case reads the scheduling job's journal row (`journalKey(link.jobId, linkId)`), only when
`_rev` differs and the link has `scheduledAt`; a purged journal fails it, so the entry counts as
edited.

### Count stage

Pages candidates and reads each unseen one, tallying `owned` and `found` on the job (saved with the
cursor at each release). Every read counts against `WORKERS_MISSING_SCAN_CAP`, misses and the
`getIncludingTrashed` that follows them included (Ruling 29 M8). When the links are exhausted, with
`base = owned - counters.created` on a real run (this job's creates are owned links that cannot be
missing, Ruling 23) and `base = owned` on a dry run (whose creates made no links):

- `found === 0`: `stage: "done"`, nothing to do, the job completes.
- over the threshold (`found × 100 > maxPercent × base`):
  - real run: `verdict: "refused"`, `stage: "done"`, job warning "Missing entries were left alone:
    <found> of the <base> entries owner <owner> created before this import are not in the feed
    (<p>%), more than the limit of <maxPercent>%. Check the feed, then import it again with the job
    option missing: { maxPercent: <p> } to apply it (with force: true for an unchanged URL source)."
    `<p>` is `ceil(found × 100 / base)`, so the suggested option passes (Ruling 29 M4). The job
    completes with no change.
  - dry run: `verdict: "refused"`, the same warning reworded ("a real run would leave them
    alone"), and the act stage still runs to plan the rows (Ruling 16).
- otherwise `verdict: "act"`, `stage: "act"`, the cursor reset.

### Act stage

Each act batch first recounts `removed` from this phase's rows (`records.query` by `jobId`, status
`removed` or, on a dry run, `planned`, and `seq >= fromSeq`, paged; Ruling 29 M1), so a batch lost
after acting cannot let the cap below be exceeded. It then pages candidates again (a fresh cursor at
the stage's start) and decides each unseen one again (state may have changed since the count). Each
decided entry gets a row `recordKey(job.id, seq)` with `seq = max(fromSeq + rows, last missing
row's seq + 1)` (the last one read once per batch, `records.query` by `seq` descending, limit 1),
`start` and `end` 0, the link's `sourceKey` and the entry ID.

- **Not more than counted.** Once `removed === found`, a further act verdict is `unchanged`,
  `missing_over_count` ("Left alone: more entries were missing than when the import counted them;
  run the import again"), so the threshold's approval is never exceeded (Ruling 20).
- **Dry run.** An act verdict is `planned` with `action` and `changes: [{ field: "status", before:
  <status>, after: "trashed" | "draft" }]`; nothing is written, no journal, no link.
- **Real run, act.** For entry `E` at `_rev` `R` and link `L`:
  1. `isLocked`: `locked`, `locked` ("Not changed: the entry is being edited (locked)").
  2. Journal write-ahead, put-if-absent at `journalKey(job.id, linkId)`: `{ kind: "trash" |
     "update", seq, entryId: E.id, before: { link: snapshot(L), rev: R, status: E.status,
     scheduledAt: null, live: {} }, at }`.
  3. Save the row `writing` with `action` and `writtenRev: R`.
  4. The call: `trash(collection, E.id)` (no `_rev`, F1), or `revertStep({ step: "unpublish",
     rev: R })` (F7). `blocked`: `failed`, `missing_blocked` ("Not changed: a plugin refused:
     <message>"). Unpublish `conflict`: `conflict`, `missing_changed` ("Not changed: the entry
     changed since it was read"); `locked`: `locked`. Trash `not_found`: `unchanged`,
     `missing_gone`. In each of these cases the call did not land, so the journal row of step 2 is
     deleted before the row is saved (Ruling 29 M2): the rollback then has nothing to look at.
  5. `putLink`-like save of `L` with `writtenRev` (trash: `R`, which Trash keeps, F1; unpublish:
     the returned `_rev`), `jobId: job.id`, `missing: { jobId, action, at }`, and `owner`,
     `ownerSource`, `fields`, `unconfirmed`, `scheduledAt` as they were.
  6. The row becomes `removed`; `removed` counters bump.

The stage ends when the links are exhausted: `stage: "done"`, the job completes.

**A stop part way (Ruling 29 M3).** A cancel during the count or act stage, a pause that is never
resumed, or a job that fails (three unexpected errors) leaves the phase unfinished: no entry, or
fewer entries than a full run would, are removed. This is safe: every change made is journalled
and owned, the threshold was approved before the first one, and the next completed run of the feed
decides the rest afresh. A paused or failed job resumes the stage where it stopped.

## Editor safety

- **Ruling 8, edited entries are always skipped.** M5b's `protectEdited` decides whether a
  *field* may be overwritten; trash and unpublish change the whole entry's visibility. An edit is
  a person's signal that the entry matters outside the feed, so the importer leaves such entries
  whatever the template says, as the M2 rule leaves someone else's pending draft. The check uses
  `_rev` only, so it costs no read beyond the entry's own. Term edits and reference edges set
  elsewhere do not move `_rev` (M5b F8, F15), so they are not seen as edits here (Open issues);
  reading terms and selections for every missing entry would cost two reads per entry for a
  change that is undone by restoring from Trash.
- **Pending state, Ruling 9.** Restore keeps the draft pointer and publish then promotes the draft
  (F2, F3), and unpublish keeps a draft (F7), so rolling back either over a pending draft would
  publish it. A schedule would be lost by Trash's restore (F2). Rather than journal and restore
  drafts and schedules here, the phase leaves such entries; the importer's own pending state
  included, because it too is not what the site shows.
- **Locks.** Checked before the call, as for every importer write; the trusted Trash does not check
  them (F1).
- **The window.** Trash takes no `_rev` (F1): an edit between the read and the call is not seen.
  The window is one entry's processing time (Open issues).

## Translations

- **Links are per locale** (`linkKey`), and each locale's template has its own owner and its own
  missing phase. A translation template's missing phase acts on its translations only.
- **Trash of a group root with active translations is left** (`missing_has_translations`,
  Ruling 10), as M5a's rollback refuses to delete such a root. Trashing a translation frees its
  locale (F6) and leaves the source (V7).
- **Unpublish acts on one locale**: each locale has its own status (M5b "Translations").
- **Sync moves `_rev`.** A source publish that syncs shared values into a translation moves the
  translation's `_rev` (M5b review), so a translation the source job wrote into reads as edited
  and is left (`missing_edited`). This fails safe.
- **Rollback.** A restored translation whose locale was taken meanwhile gives `CONFLICT` (F2):
  `rollback_changed` with "the entry's translation slot is taken".

## Keys that come back

- **Unpublished.** The link names the job at the unpublish's `_rev`, and the entry is in F7's state
  (a draft with a draft pointer), so the next import of the key finds the importer's own pending
  state (`ownPending`) and republishes it, written or through `finishUnchanged` (V3). The write's
  `putLink` drops the `missing` mark. With `publish: false` the entry stays a draft and the mark
  stays, which only keeps it out of later counts.
- **Trashed.** `content.get` misses the entry (F8), so the record would create a new entry: a
  duplicate, or `SLUG_CONFLICT` with the old slug (F5). Instead, a record whose link has `missing:
  { action: "trash" }` and whose entry is not active is `conflict`, `missing_trashed` ("Not
  imported: the import moved this entry to Trash because it was missing from an earlier feed
  (job <jobId>); restore it from Trash, or roll that job back, then retry"). It costs no read: the
  link is read already. After a restore by hand the entry is a draft at a new `_rev`, so the record
  reports `pending_draft` until an editor publishes it (Ruling 15, Open issues).

## Journal and rollback

| Write | Journal (M5a format) | Rollback |
| --- | --- | --- |
| Trash | `trash` row: `entryId`, `before` (link snapshot with `owner`, `rev`, `status`, `scheduledAt: null`, `live: {}`) | Steps 8 and 9 |
| Unpublish | `update` row: the same `before` | M5a sequence: step 2 publishes; step 4 discards the draft F18 left |

**Journal format.** `before.link` gains `owner`, `ownerSource` and `missing` when present. All
optional; no other change. A `trash` row read by an M5b rollback is `journal_kind_unknown` and left
(safe). A write-ahead row whose call did not land is deleted (act step 4).

**Rollback of a `trash` row** (`restoreTrashed`, beside M5a's `deleteCreated` and
`restoreChanged`):

1. **Find.** By `entryId`, active first, then in Trash.
2. **Ownership.** In Trash, and the link names the job (`jobId === rollbackOf`, `entryId`) at
   `writtenRev === entry.rev` (Trash keeps `_rev`, F1); or the row is this rollback's own
   (`writing` with `writtenRev === entry.rev`, resuming). Active and as `before` read it (link
   equal to `before.link`, `rev === before.rev`): the trash never ran (a stop before the journal
   row's deletion), `unchanged`, `nothing_to_roll_back`. Otherwise `conflict`, `rollback_changed`
   ("Not rolled back: the entry was restored or changed after the import moved it to Trash").
3. **Lock**, as every step.
4. **Step 8 `restore`.** `restore` with `entry.rev` (F2). `CONFLICT`: `rollback_changed` (the
   translation-slot message when the group already has an active entry in the locale).
5. **Step 9 `republish`** when `before.status === "published"`: `publish` with step 8's `_rev`. A
   hook's refusal is `failed`, `rollback_blocked`; `jobs/retry` of the rollback continues from
   step 8.
6. **Link.** Put back as `before.link` (owner kept, no `missing` mark), `writtenRev` the final
   `_rev` when `before.rev === before.link.writtenRev` (M5a hand-back). The row is `reverted`,
   `action: "restore"`.

| Step | When | Call |
| --- | --- | --- |
| 8 restore | trash rows: the entry is in Trash | `handleContentRestore` with `_rev` (F2) |
| 9 republish | trash rows: after step 8, `before.status === "published"` | `handleContentPublish` with step 8's `_rev` (F3) |

Steps 8 and 9 run only for `trash` rows, and steps 1-7 never do, so the saved `step` numbers keep
their meaning for every row kind. `reached()` (the resumed-step check) treats step 8 as reached
when the entry is active, a draft, without a schedule and one `version` past `before.rev`, and
step 9 when it is also published without a draft (V1). A dry-run rollback plans `{ field:
"status", before: "trashed", after: before.status }`. `STEP_COST.restore` is 15; `ROW_RESERVE`
(165) covers restore plus republish.

**Rollback of an `update` row from an unpublish** is M5a's: ownership by the link the unpublish
saved, step 2 publishes (V2). Its row is `revert`.

**Order.** A job's missing rows have the highest `seq`, so its rollback undoes them first. Rolling
back the job that created an entry before the job that trashed it reports `rollback_changed` for
it (its link names the later job; M5a "Created entries" step 0 also refuses an entry trashed by
someone else). Last in, first out, as M5a.

## Counters

`counterFor` (import jobs) counts a `removed` row as `removed`, and a `planned` row whose action is
`trash` or `unpublish` as `removed`; `tallyCounters` (after a retry pass) does the same through
`counterFor`, so the `removed` counter survives a retry of the import's own rows (Ruling 29 M10).
The rollback's `counterOf` is unchanged: `restore` joins its rollback actions.

## Crash repair

- **Count stage.** Tallies and cursor are saved together at each release; a stop re-counts the
  page. Nothing is written.
- **Act stage, a row met again.** The seen query returns this phase's earlier rows (`seq >=
  fromSeq`). A row that is not `writing` is skipped (its outcome is already in the recounted
  `removed` and in the counters the release saved, or is recounted by `tallyCounters`). A `writing`
  row resumes:
  - Trash: the entry in Trash at the row's `writtenRev` with the link not yet marked: the trash
    landed (it keeps `_rev`, F1); finish at step 5. Active at `writtenRev`: send the trash. Any
    other state: `conflict`, `missing_unverified` ("Maybe changed: the import stopped while
    changing this entry and cannot tell whether someone changed it since").
  - Unpublish: active at `writtenRev`: send it. In F7's state (a draft with a draft pointer, no
    live pointer, no schedule) exactly one `version` past `writtenRev` (M5b F1), with the link not
    yet moved: the unpublish landed; finish at step 5. Otherwise `missing_unverified`.
- **Act stage, rows written but not counted.** The next seq is read from the last missing row,
  never from the saved `rows` alone, so a row a lost batch wrote is not overwritten; `removed` is
  recounted from the rows (Act stage).
- **No retry (Ruling 26).** `retryPass` reads only rows with `seq < missing.fromSeq` (`seq: { gte:
  retryFromSeq, lt: fromSeq }`). A missing row left `locked`, `conflict`, `failed` or
  `missing_unverified` stays as it is; its link is not marked, so the next completed run of the
  feed counts and decides the entry afresh. The count stage never runs again in the same job.

## Dry run

The first pass plans as today, then the count stage runs on the same links and verdicts, and the
act stage plans a `planned` row (`action` `trash` or `unpublish`, counted `removed`) for every act
verdict and an `unchanged` row with the code for every other unseen entry. Over the threshold the
rows are still planned, and the job warning says a real run would leave them all (Ruling 16). A dry
run journals and writes nothing, and drops no owner stamp. A dry run's first pass creates no links,
so its own "creates" are never candidates.

## Workers and Node

- **Count stage cost.** One links query per 100 links, one records query per 50 keys, and one
  `content.get` (10-12 queries, M5a Results) per unseen candidate, plus `getIncludingTrashed` on a
  miss, `translations()` for a trashed root, and one journal read for a swept entry. On Workers a
  batch makes at most `WORKERS_MISSING_SCAN_CAP` reads (provisional 40, V8), every read counted.
  The lookup budget is charged `COST_CALL` per storage query and `COST_READ` per read. Seen
  candidates cost no read.
- **Act stage cost.** The `removed` recount (one query per 100 rows), the same reads again, then
  per acted entry a lock check, the journal put-if-absent, two row saves, the call (trash:
  `COST_READ` × 5 as in M5a; unpublish 15), a link put, and a journal delete when the call did not
  land. On Workers a batch decides at most `WORKERS_MISSING_BATCH_CAP` entries (provisional 10, V8).
- **Rollback.** Steps 8 and 9 cost about a restore and a publish (76 queries, M5a Results); the
  3-row cap holds (V8).
- **Import cost.** One link put per link whose owner stamp a record of another owner drops (once
  per link, Ruling 21). Nothing else: the owner comes from the link already read, `unkeyed` is a
  job counter, and `missing_trashed` uses the link already read.
- **Node.** The job's `batchSize` bounds both stages.
- `workersBatchCap(job)` returns the missing caps while `job.phase === "missing"`.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| `rules.owner` | 1-100 characters, `[A-Za-z0-9._:-]` | Stored on every owned link row and used as a query value |
| `maxPercent` | 0-100 | A share |
| `MISSING_PAGE` | 50 keys per seen query | D1's 100 bound parameters (F13), with room for the plugin, collection and job parameters |
| Links per query | 100 | Plugin storage maximum (F10) |
| `WORKERS_MISSING_SCAN_CAP` | 40 reads per call (provisional) | About 500 queries for reads, V8 |
| `WORKERS_MISSING_BATCH_CAP` | 10 entries per call (provisional) | Up to about 70 queries per unpublish, V8 |
| Acts per job | at most `found` | Ruling 20 |

## Testing

- **Unit, template and job:** the `owner` and `missing` schemas (strict, bounds, defaults); the
  refusals (`missing` without `owner`, the job option without `rules.missing`, `journal: false`);
  `missingLimit` resolved from template and option, `false`; `skippedRows` stored as `unkeyed`.
- **Unit, reading the key:** `applyTemplate` returns the key with a later mapping's error, and not
  with a key error (missing, empty, not scalar, too long); the failed row carries the key and is
  seen; a reader error, a filter error and a key error count as `unkeyed`.
- **Unit, readers:** an XLSX sheet with a row of only unreadable cells gives `skippedRows: 1` and
  the phase is skipped; blank CSV and JSON Lines lines and empty XLSX rows do not count.
- **Unit, owner (fakes):** stamped by a create, a linked create, and crash repair of a create the
  journal confirms or the `writing` row names; not stamped for an entry adopted by source ID;
  kept by the same owner and by a refresh; restored by a rollback's link hand-back. **Required
  sequence (Ruling 21):** template A (owner `a`) creates K; template B (owner `b`, and again with
  no owner) reads K and is, in turn, unchanged, skipped by `mode: "create"`, skipped by `mode:
  "update"` on another key, protected on every difference, `pending_draft` and `locked`; after
  each, K's link has no owner, exactly one extra link put was made, and A's next run with K
  missing does not count or touch K. A dry run of B drops nothing.
- **Unit, phase (fakes):** entered only after a completed first pass, skipped for `unkeyed` and for
  no keyed record, never after retry, cancel or failure. Candidates: marked links and later jobs'
  links left out; seen by any status, a failed-with-key record included; filtered records unseen;
  51 and 101 keys across pages; the mixed-source refusal (a link with another `ownerSource`, and
  this job without one). Every verdict row, including the swept entry with and without its
  journal; `found` counting the left-alone verdicts and not `missing_gone`. The threshold at its
  boundaries (equal passes, one more refuses), the base without this job's creates, the dry-run
  base, the small-feed cases (1 of 3 refuses, 1 of 4 passes), the suggested percent rounded up and
  passing, the job option override and `false`, `found === 0`. The act stage: each call outcome,
  the journal row deleted when the call did not land, the cap at `found` (`missing_over_count`)
  with `removed` recounted after a lost batch, the link saved with `missing` and the kept fields.
  Crash repair: a stop after the write-ahead, after the `writing` save, after the call and after
  the link save, for both actions, and `missing_unverified`; the next seq after a lost batch.
  `jobs/retry` leaving missing rows untouched and keeping `removed`. Cancel, pause and failure
  mid-stage. `missing_trashed` on a reappearing key, and republish of an unpublished one.
  Rollback: steps 8 and 9, `reached()` for both, the slot conflict, a hook refusal and retry,
  `rollback_changed` when restored by hand, `nothing_to_roll_back` before the trash, an unpublish
  row by the M5a sequence, LIFO with the creating job. Dry runs plan the same verdicts, over the
  threshold too, and write nothing. Clock-dependent rules run under the moving clock.
- **Integration on `sites/dev`:** a feed of 20 with `owner` and `missing: unpublish`, then 18 of
  them: two unpublished, `removed: 2`; then all 20 again: both republished. The same with `trash`,
  then the two keys back: `missing_trashed`; a rollback of the trashing job restores and republishes
  them exactly (V1's comparison) and the re-run imports without `SLUG_CONFLICT`. An editor's edit
  of one missing entry (REST `PUT` and publish) and an editor's draft on another: left with their
  codes. A feed of 10 of the 20: refused at 25%, nothing changed, then accepted with the job option.
  A dry run planning and writing nothing. A record with a bad key: phase skipped. A second
  template with another owner reading the same keys unchanged: the entries lose the owner and are
  never removed. A French translation job with its own owner trashing a translation; an English job
  leaving a source with translations. SIGKILL mid-act, resumed with every entry changed once.
- **Cloudflare parity on `sites/dev-cf`:** an unpublish and a trash run, a refusal, and a rollback
  restoring the trashed entries on D1; V1-V8 on D1.

## Plan sizing

Nine tasks: (0) prove V1-V8; (1) template `owner` and `missing`, job options, `missingLimit`,
`skippedRows`, the links index; (2) the key on failed records, `unkeyed`, owner stamping, keeping
and dropping (the extra put), the journal's link snapshot, `missing_trashed`; (3) ports and
adapter: `restore`, and the fakes' Trash and restore as EmDash does them (F1, F2); (4) the phase
entry, candidates, the mixed-source refusal, seen and verdicts, the count stage and the threshold;
(5) the act stage, its journal, rows, counters and crash repair; (6) rollback steps 8 and 9,
`restoreTrashed`, the link hand-back; (7) Node integration and workerd parity; (8) the review run,
V8 re-measured, and the note. A final fix wave follows the whole-branch review.

## Rulings

1. **The owner is an explicit name in `rules.owner`, stamped on the link row by creates.** The
   code has no stable template identity: link rows are shared by key, `jobId` changes every run and
   `lastImport` is per URL source (Decisions, "What owner means"). An explicit name survives
   template edits, and M6's saved templates can default it to their ID. Stamping only on create
   is the roadmap's "entries this import created".
2. **A template with another owner, or none, drops the stamp.** Otherwise a feed could trash an
   entry a second feed keeps importing, whose next run would then fail `SLUG_CONFLICT` or create a
   duplicate (F5, F8). Dropping fails safe: the entry is only never removed. A template without an
   owner drops it too, because it is a feed the owner's feed does not know about. Amended by
   Ruling 21: any record that reaches the link drops it, not only a write.
3. **No adoption.** Entries created before M5c or before `rules.owner` was set are never handled,
   since nothing proves which template created them (a `flux_source_id` equal to the key is shared
   by every template with that key). Out of scope; see Open issues.
4. **Seen is any row of the job with the key; filtered records are unseen.** A record that failed
   after its key was read is in the feed, so its entry is not missing (Ruling 24 makes its row carry
   the key). A filter selects what the import covers, so an entry whose record it drops is missing
   (the "only in-stock products, take the rest down" use case); the threshold and the dry run guard
   a filter change.
5. **Only a completed first pass with every key read.** A record without a readable key could hide
   a present entry (M5a outline); Ruling 25 adds rows a reader skips. A retry never re-enters the
   phase, so the threshold's decision is made once, on the whole pass. Cancelled, paused and failed
   passes never reach it, by construction: the phase starts only when `importPass` returns `done`.
6. **Count, then act; refuse whole.** The threshold needs the whole set before any change, and the
   set can be larger than one Workers call can read, so the count is its own resumable stage. A
   refusal changes nothing and the job still completes, with the numbers in a warning and
   `Job.missing`: the import itself succeeded, and M6's automation reads the verdict.
7. **`maxPercent` 25 by default; a job option overrides it or turns the phase off for one run.**
   The M5a outline's default. `false` lets an operator import a partial feed without the phase.
   Amended by Rulings 22, 23 (what is counted, and the base) and 28 (no `maxCount`).
8. **Edited entries are always left, whatever `protectEdited` says** (Editor safety).
9. **Pending drafts and schedules are always left, the importer's own included** (Editor safety).
10. **Trash leaves group roots with active translations; unpublish acts per locale** (Translations).
    It mirrors M5a's `rollback_has_translations`, so one rule decides when a root may leave the
    site.
11. **Links written by a later job are not candidates.** A later job of the same owner may be
    creating entries while this phase runs; their keys are not in this job's feed. Job IDs are
    time-ordered ULIDs (F15, V6), so the test costs no read.
12. **No permanent delete.** It cannot be rolled back (F4), which the milestone's acceptance needs;
    an administrator empties Trash.
13. **`trash` is a new journal kind; unpublish is an `update`; rollback adds steps 8 and 9.**
    Unpublish's pre-state ("published, no draft, no schedule") is exactly what M5a's sequence
    restores. Trash needs a restore first, which no M5a step does, and a kind an older rollback
    refuses rather than misreads. Numbering after M5b's step 7 keeps every saved step number's
    meaning.
14. **Acted links are marked, and marks leave later counts.** Without the mark, entries already in
    Trash or unpublished would be counted again on every run and push a long-lived feed over its
    threshold. Any import write clears it, so a key that comes back is counted again.
15. **A trashed entry is not restored when its key comes back; an unpublished one is republished.**
    Unpublish needs no new code (M2/M5b own-pending rule). An automatic restore would add a
    journalled restore to the import path and a re-trash step to the rollback; the conflict is
    explicit, creates no duplicate and is undone by a restore or a rollback. `unpublish` is the
    action for feeds whose items come and go (Template documentation).
16. **A dry run plans every row, over the threshold too.** The operator needs to see which entries
    a refusal is about; the warning states the verdict a real run would reach.
17. **Missing rows are record rows after the import's, with status `removed`.** They then appear
    in `jobs/records` and `jobs/log.csv` and order the journal for rollback. A status of their own
    keeps `updated` meaning a written update. Amended by Ruling 26: `jobs/retry` does not take them.
18. **`content:restore` is declared.** For disclosure, as the other content capabilities (F12):
    the rollback restores through the trusted runtime.
19. **New Workers caps, set by measurement.** The phase's per-entry cost differs from a record's,
    so it gets its own caps, provisional until V8.
20. **The act stage never removes more than the count found.** State can change between the
    stages; the threshold approved a number, not a list.

Added by the spec review (binding rulings of the coordinator):

21. **(C1) Any record that reaches a stamped link drops a foreign stamp, whatever its outcome.**
    An unchanged record, a mode skip and a fully protected record write no link, so dropping only
    in `putLink` would leave the stamp on an entry a second feed still holds, and the owner's phase
    would remove it. The drop is one link put, only when the owners differ, once per link. The
    sequence is a required test (Testing, "Unit, owner").
22. **(I1) The threshold counts every unseen candidate whose entry exists.** Edited, pending,
    unpublished-already, translated and over-count entries count too; only `missing_gone` does
    not. The threshold guards against a broken or truncated feed, which shows in how many owned
    entries the feed lacks, not in how many the phase can change. The phase still acts only on the
    entries that pass the checks, and at most `found` of them.
23. **(I2) The base is the owned links minus this job's creates.** A job's own creates are owned
    candidates that can never be missing, so counting them would dilute the percentage by the
    feed's new items. A dry run, which creates no links, uses the candidate count.
24. **(I3) A record whose key was read is seen even when another field fails.** `applyTemplate`
    returns the key with the errors of a later mapping, and `decideRecord` saves it on the failed
    row (The missing phase, "Keys of records that fail later"). Only a record with no key or an
    unreadable key (missing, empty, not a scalar, too long), a reader error or a filter error is
    unkeyed. Without this, one bad price, which hides no entry, would skip the whole phase on every
    run until the feed is fixed.
25. **(I4) Rows a reader skips while they hold data count as unkeyed.** Of the readers (CSV, JSON,
    JSON Lines, XML, XLSX, and pasted text, which goes through them), only XLSX drops such rows
    silently: rows whose only values are unreadable cells (`converter.skipped`, P2). `convertXlsx`
    returns the count, `createJob` starts `unkeyed` at it, and the phase is skipped. The other
    skips hold no data (blank lines, empty rows) or are outside the template's records path by
    definition.
26. **(I5) `jobs/retry` does not touch missing rows.** A retry decides import rows only; the next
    completed run of the feed decides a missing entry afresh, against the threshold of that run.
    Resuming a `writing` row within the phase stays, since it finishes a change already started
    and journalled.
27. **(I6) Owner names are the operator's responsibility; the phase refuses when URL sources mix.**
    Documented under "Template documentation". The only stable source identity a job records is a
    URL source's `sourceId` (P3); creates stamp it on the link as `ownerSource`, and the phase
    refuses as a whole, changing nothing, when an owned candidate carries another one (also when
    this job is an upload). Uploads and pastes have no stable identity, so for them only the
    documentation applies. The check reads nothing beyond the links the stage pages.
28. **No `maxCount`.** Over-engineering: `maxPercent` with the per-job override covers the cases,
    and one limit is one rule to explain.
29. **The review's minor findings, accepted:**
    - M1: each act batch recounts `removed` from the rows, so a lost batch cannot raise the cap.
    - M2: a write-ahead journal row is deleted when the call does not land.
    - M3: a cancel, pause or failure during either stage removes fewer entries, which is safe
      (Act stage, "A stop part way").
    - M4: the suggested percent is rounded up, and the warning mentions `force: true` for URL
      sources.
    - M5: small-feed behaviour is documented (Template documentation).
    - M6: the state after an unpublish is spelled out, with its draft pointer (F7, Crash repair).
    - M7: only an entry the journal or the row shows this job created is stamped (Owner).
    - M8: every read, misses included, counts against the scan cap.
    - M9: `rules.owner` (not `rules.missing.owner`) amends the M5a outline, so a template can stamp
      entries before it turns the phase on.
    - M10: `counterFor` and `tallyCounters` count the `removed` status and planned missing rows.
30. **(Task 2 review) Every failed record that holds a key drops a foreign stamp, and a retry never
    restamps.** A record that failed after its key but before its link read would otherwise leave
    another template's stamp on an entry its feed still holds, and that template's next run could
    remove it. One link read per such failure is the price. Crash repair stamps only when it
    repairs the link: a confirmed journal create from an earlier pass would otherwise restamp, on
    `jobs/retry`, an entry whose stamp another owner dropped.

## Out of scope for M5c

Permanent delete as an action; adopting entries created without an owner; restoring a trashed
entry automatically when its key comes back; journalling and restoring pending drafts or schedules
of missing entries; treating term or reference edits as edits for the missing phase; a missing
phase after a retry pass, and retrying missing rows; per-entry overrides; an absolute count limit;
telling two upload or paste feeds with one owner apart; deleting stale link rows of entries deleted
by hand.

## Open issues carried forward

- **New in this design.**
  - Trash takes no `_rev` (F1): an edit made between the entry's read and the trash call is not
    seen, and the edited entry goes to Trash. The window is one entry's processing time; rollback
    or a restore by hand undoes it. The same window as M5a's rollback deletes.
  - Term assignments and reference edges set elsewhere move no `_rev` (M5b F8, F15), so an entry
    edited only there is not "edited" for the missing phase.
  - A translation the source job synced into reads as edited and is never removed until the
    translation job writes it again.
  - An entry restored from Trash by hand comes back as a draft at a new `_rev` (F2): its next
    import reports `pending_draft` until an editor publishes it.
  - A trashed entry whose key comes back stays a `missing_trashed` conflict on every run until it is
    restored or its job rolled back. Use `unpublish` for feeds whose items return.
  - Entries with a pending draft or schedule are never removed, the importer's own included.
  - The percentage's base counts links whose entries were deleted or trashed by hand
    (`missing_gone` rows on every run); the threshold is then more permissive than the live count.
  - The ULID order is milliseconds only (F15, V6); two jobs of one owner created in the same
    millisecond may not see each other as later.
  - A refusal of an unchanged URL source can only be re-run with `force: true` (Template
    documentation).
  - Ownership is dropped silently when another template reaches an owned entry; no job warning
    counts the drops. A drop by a record that is not journalled is not undone by a rollback.
  - Two upload or paste feeds sharing one owner name are not detected (P3); only URL sources are.
  - A missing row left `locked`, `conflict` or `failed` waits for the next completed run.
  - A swept entry is owned only while the scheduling job's journal exists (retention period); after
    it is purged, the entry reads as edited.
  - A file that is itself truncated is not detectable; the threshold is the guard.
- **From M5b** (`2026-11-04-m5b-review.md`), unchanged: translation sync moving `_rev`; CPU on
  Workers for heavy Portable Text; the measured headroom of the linked cap; the M5b spec's open
  issues; the known gaps; the ledger items; the known flakes (F1, F2, F3 on port 4397).
- **From M5a and earlier**, as carried in the M5b review, unchanged; the production Cloudflare
  build blocker from M2 still stands.
