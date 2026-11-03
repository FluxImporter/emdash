# Flux Import M5a: run journal and rollback

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). First of three parts of Milestone 5 (Record rules and safety) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-5-split). Builds on M4e
([spec](./2026-11-03-flux-import-m4e-locales-design.md),
[review](../notes/2026-11-03-m4e-review.md)), merged at `ca58695`.

## Goal

A finished import can be rolled back to its pre-run state:

- Every real (not dry-run) job keeps a **journal**: before its first write to an entry, the
  importer stores what that entry held (or that it did not exist), and it stores the ID of every
  media item it creates.
- `jobs/rollback` creates a **rollback job**, driven by `jobs/next` like an import, resumable on
  Node and Workers, and dry-runnable. It walks the journal newest first: an entry the job created is
  deleted, and an entry it changed gets back its data, slug, links, status, schedule and pending
  draft. An entry changed since the job last wrote it (by an editor or a later job) is left alone
  and reported.
- Media the job created and terms it created are **kept and listed**: EmDash 1.2.0 gives plugins
  no way to see whether a media item is still used, and no way to delete a term (F13, F14).
- The carried-forward `lastImport` issue is settled: a cancelled or rolled-back job no longer makes
  its URL source skip the next import.

The template is unchanged. Jobs gain one creation option, `journal` (default `true`).

## Why this split

M5 is split so that rollback's data needs are fixed before anything writes data rollback must undo.
M5a journals the writes M2-M4e make today (create, update, publish of the importer's own draft,
links, media), and its pre-image already holds what M5b and M5c will change: status and schedule
(M5b's draft and schedule rules), and the row's existence (M5c's trash). M5b and M5c each add their
writes to the journal in this format and extend the rollback for them; neither changes the format.
See [Outline of M5b and M5c](#outline-of-m5b-and-m5c).

## Decisions

| Topic | Decision |
| --- | --- |
| What "pre-run state" means | Per entry the job wrote: whether it exists (active), its `status`, `scheduledAt`, live slug, and, for every field and link the job changed, the live value and the pending draft's value. Revision history, `publishedAt` and `updatedAt` are not part of it (F2, F12). Entries the job did not write are not touched. |
| Why not revisions | EmDash revisions cannot tell the importer from an editor: a revision row stores only `author_id`, which is the `jobs/next` caller, usually the same admin who edits (F3). They exist only on collections with revisions, are pruned to the newest 50 per entry (F3), and a revision restore takes no `_rev` and only stages a draft (F4). The journal is the importer's own record and covers every collection. |
| Journal storage | A new plugin storage collection `journal`, one row per (job, entry), keyed `${jobId}:${linkKey}`, so a second write of the same job to the same entry (a duplicate key in the feed, a retry, a crash repair) finds the row. Indexes `jobId`, `["jobId", "seq"]`. Media get a second collection `journalMedia`, keyed `${jobId}:${mediaId}`, indexes `jobId`, `["jobId", "seq"]` (the rollback warning lists them by `seq`, and EmDash refuses to order by a field no index names: `StorageQueryError: Cannot order by non-indexed field`). Both are deleted with their job by retention. |
| Write-ahead | The journal row is written **before** the job's first write to the entry, with put-if-absent (`compareAndSet(key, null, row)`). A crash after it and before the write leaves a row for an unchanged entry, which rollback recognises as unchanged (Rollback, "Ownership"). A crash before it leaves nothing changed. |
| First touch wins | A later write of the same job to the same entry keeps the stored pre-image and adds only fields and links that the earlier writes did not change, taken from the entry as read before this write (which then still holds the pre-run value). `status`, `scheduledAt` and the link-row snapshot come from the first touch only. |
| What is captured | For an update: the fields and links in the write's `changes`, and, when the write publishes a pending draft (`job.publish` with `pendingPublish`), every field whose draft and live values differ (from `liveData`, F5), since publishing makes them live. For each such field: `live` (the column value: `liveData[field]` when a draft exists, else `data[field]`) and, when a draft exists, `draft` (`data[field]`). Missing values are stored as `null`. Links: the groups of the mapped taxonomies' terms, the IDs of the mapped reference fields' targets, the explicit byline credits with their role labels, as `currentLinks` already reads them. The slug: the live slug (F5) when the write changes it. For a create: the `flux_source_id` value the create sends. |
| Link rows | `LinkRow` gains `jobId`, the job that produced `writtenRev`. Every `putLink` sets it. A journal row stores the link row as it was before the job (`jobId`, `writtenRev`, or that there was none), so rolling back a later job hands the entry back to the earlier one (Rollback, "Links after a rollback"). |
| Created media | After an upload that made a new item (`deduplicated: false`), and before the media map row is written, a `journalMedia` row `{ jobId, mediaId, url, seq }` is put. This is the record the M4c review asked for: the map's `jobId` and `created` are not used. A crash between the upload and this put loses the item from the list (documented). |
| Size | A journal row is at most `MAX_JOURNAL_BYTES` (1 MiB) of JSON. A record whose pre-image would be larger fails before any write with `journal_too_large`. A pre-image of a reference field whose selection was truncated (more than the first page read, `referencesTruncated`) is incomplete: the record fails `journal_incomplete` before any write. |
| `journal: false` | A job created with `journal: false` keeps no journal and cannot be rolled back. It is the escape for feeds whose entries exceed the size cap; the default is `true`. Jobs created before M5a have no `journal` field and cannot be rolled back either. |
| Dry runs | A dry-run import keeps no journal and cannot be rolled back. A rollback can itself be a dry run: it reads and decides every row and writes nothing (Rollback, "Dry run"). |
| Which jobs | A real import job with `journal: true`, in `completed`, `cancelled` or `failed`, without a live lease, not rolled back already (`rolledBackBy`). Running or paused jobs must be cancelled first. One real rollback per job (dry-run rollbacks are not limited). A rollback of a rollback is refused. |
| After a rollback | The original job gets `rolledBackBy: <rollback job ID>` when a real rollback is created. It can then no longer be resumed or retried (`invalid_transition`), so its writes cannot come back behind the rollback. A dry-run rollback sets nothing. |
| Rollback job lifecycle | The `jobs` collection and lifecycle of M2: `created`, `running`, `paused`, `completed`, `failed`. `jobs/pause`, `jobs/resume` and `jobs/retry` work (retry re-processes `conflict`, `locked`, `failed` and `writing` rows, after an editor resolved them). `jobs/cancel` is refused: a half-done rollback cannot be restarted cleanly (rows it reverted no longer match the original's link rows), so it is paused instead. |
| Order | Newest first: journal rows by `seq` descending. Across jobs the rule is last in, first out: rolling back an older job before a newer one that wrote the same entries reports those entries as changed since. |
| Created entries | Deleted: moved to Trash and then deleted permanently (F6, F8). Trash alone would keep the slug (slugs are unique per locale including trashed rows, F9), so the next run of the same feed would fail `SLUG_CONFLICT` for every record. Only an entry the job's own create returned is deleted permanently (`confirmed`); one the importer found by crash repair is only moved to Trash (warning `rollback_trashed`), because crash repair can take an editor's entry (M4e adoption window). |
| Changed entries | Restored through the same writes the importer uses, each with the `_rev` of the previous step (Rollback, "Revert sequence"). |
| Terms | Terms the job created stay: EmDash 1.2.0 has no term deletion for plugins or on the runtime (F14). Assignments are restored. The rollback job warns once with the number of kept terms; the original job's records list them (`newTerms`). |
| Media | Media the job created stays: deletion is permanent, does not rewrite references, and plugins cannot read media usage in 1.2.0 (F13), so the importer cannot tell whether another entry or a later job uses an item. Media field values are restored. The rollback job lists the kept item IDs (at most 100, then a count) in one warning, for deletion in the Media Library, whose "Used in" shows usage. |
| Translations (M4e) | A created entry that is its own group's root (`group === id`) and whose group has other active entries is not deleted: `conflict`, `rollback_has_translations` ("roll back the jobs of its translations first"). A created translation is deleted like any created entry; that frees its locale in the group (F16). A changed entry's restored non-translatable values sync to its translations as any update does (M4e F6), which moves their `_rev`: rolling back the translation jobs afterwards reports them as changed since (documented; roll back translation jobs first). |
| Locks | Every step reads the lock table first, as the import's writes do; a lock held by another user makes the row `locked`. Trash and permanent delete are not lock-checked by EmDash on the trusted path (F6), so the importer's check is the only one. |
| `lastImport` | `Job` gains `sourceId` when created from a URL source. Cancelling a job, and creating a real rollback of one, clear the source's `lastImport` when it names that job, so the next import of unchanged content runs. A failed job keeps it (it can be resumed). |
| Capabilities | Unchanged. Deletes, unpublish and schedule go through the trusted runtime the importer already uses (`content:write`, `content:publish` are declared for disclosure). Nothing is restored from Trash in M5a (M5c adds `content:restore`). |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`) and the docs on 2026-11-03.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | Statuses are `draft`, `scheduled` and `published`; Trash is separate from status (`deleted_at`). A published entry can have a pending draft and a future schedule. Content items carry `status`, `scheduledAt`, `publishedAt`, `liveRevisionId`, `draftRevisionId`, `version`, `createdAt`, `updatedAt` | `src/database/repositories/types.ts:299-330`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F2 | `_rev` is `base64("<version>:<updatedAt>")`, checked against both; any write that bumps `version` or `updated_at` changes it | `src/api/rev.ts:16-21`, `:47-66` |
| F3 | Revisions exist only on collections with `supports: ["revisions"]`. A revision row is `id, collection, entry_id, data, author_id, created_at`: no source or origin. `author_id` is the save's `actor.id`. After a save the entry's revisions are pruned to the newest 50 | `src/database/types.ts:7-14`; `src/emdash-runtime.ts:3835`, `:3943-3947`, `:4004`; `src/database/repositories/revision.ts:14-21`, `:322-336` |
| F4 | `handleRevisionList`, `handleRevisionGet`, `handleRevisionRestore(revisionId, callerUserId)` are on the runtime. Restore takes no `_rev`, stages the revision as the draft (it does not publish) and writes a new revision authored by the caller | `src/emdash-runtime.ts:5124-5132`; `src/api/handlers/revision.ts:102-195`; `src/database/repositories/content.ts:1095-1150`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F5 | `handleContentGet` replaces `data` with the pending draft's data and returns the live column values as `liveData` when a draft exists; the staged slug is not returned | `src/emdash-runtime.ts:3364-3450`; `src/database/repositories/types.ts:320-330` |
| F6 | `handleContentDelete(collection, id)` moves an entry to Trash: no `_rev`, no lock check, `content:beforeDelete` hooks can refuse it (`DELETE_BLOCKED`); it sets only `deleted_at` (so `version`, `updated_at` and `_rev` are unchanged) and releases the entry's locks. `handleContentGetIncludingTrashed` reads a trashed entry | `src/emdash-runtime.ts:3374-3377`, `:4093-4123`; `src/api/handlers/content.ts:1867-1910`; `src/database/repositories/content.ts:1618-1634` |
| F7 | `handleContentRestore(collection, id, { _rev })` restores from Trash as a draft with no schedule and no live pointer; a stale `_rev`, or a translation slot taken meanwhile, is `CONFLICT` | `src/emdash-runtime.ts:4136-4161`; `src/api/handlers/content.ts:1912-1965`; `src/database/repositories/content.ts:1643-1674` |
| F8 | `handleContentPermanentDelete(collection, id)` deletes trashed rows only, with their revisions, SEO, comments, byline credits and locks; the group's terms and reference edges go only when no other row of the group is left. It cannot be undone | `src/emdash-runtime.ts:4163-4177`; `src/api/handlers/content.ts:1971-2062`; [working with content](https://docs.emdashcms.com/guides/working-with-content/#move-content-to-trash) |
| F9 | Slugs are unique per `(slug, locale)` with no `deleted_at` condition, so a trashed entry keeps its slug; an explicit slug that collides is `SLUG_CONFLICT` | `src/schema/registry.ts:1905-1906`; `src/api/handlers/content.ts:1436-1460` |
| F10 | `handleContentUnpublish(collection, id, { _rev, actor })` runs `content:beforeUnpublish`, makes the entry a draft, clears the live pointer and the schedule, keeps `publishedAt`, and on revisioned collections keeps a pending draft or creates one from the live revision | `src/emdash-runtime.ts:320-325`, `:4652-4684`; `src/api/handlers/content.ts:2575-2600`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F11 | `handleContentSchedule(collection, id, scheduledAt, { _rev, actor })` refuses a time not in the future (`VALIDATION_ERROR`); a published entry stays `published` (the schedule applies to its draft), others become `scheduled`. Publishing clears `scheduledAt`. Due entries are published by EmDash's sweep (Node cron maintenance, Workers `scheduled()`) | `src/emdash-runtime.ts:4686-4758`; `src/database/repositories/content.ts:2096-2136`; `src/scheduled-publish.ts:1-11`; [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F12 | `publishedAt` is set on first publish and preserved by unpublish; overriding it needs `content:publish_any` | [content lifecycle](https://docs.emdashcms.com/reference/content-lifecycle/) |
| F13 | `handleMediaDelete(id)` deletes a media row and its stored object permanently, with no Trash and without rewriting references. The media-usage reads (`handleMediaUsageSummaries`, `handleMediaUsageDetails`) are not on the runtime and not exported from `emdash` (only activation, progress and repair are) | `src/emdash-runtime.ts:4947-4957`; `src/api/handlers/media.ts:361-404`; `src/api/handlers/media-usage.ts:182-230`; `src/index.ts:95-97`; [media library: delete media safely](https://docs.emdashcms.com/guides/media-library/#delete-media-safely) |
| F14 | No term deletion is available to the importer: the runtime has no taxonomy-term handlers, `ctx.taxonomies` offers `createTerm`, `addEntryTerms` and `removeEntryTerms` only, and `handleTermDelete` is neither on the runtime nor exported | `src/emdash-runtime.ts` (handler list, no term methods); `src/api/handlers/taxonomies.ts:1328`; `src/index.ts`; [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/#creating-and-assigning-taxonomy-terms) |
| F15 | Plugins on `ctx.content` get publish, unpublish, schedule and unschedule with `content:publish`, Trash reads and restore with `content:restore`, revision reads with `content:revisions:read`. The importer does not use `ctx.content` (roadmap, Architecture) | [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/) |
| F16 | One active entry per (translation group, locale): the unique index has `WHERE deleted_at IS NULL`, so a trashed translation frees its locale | `src/schema/registry.ts:1970-1972`; M4e V2 |
| F17 | On a collection with revisions an update writes no columns: `data`, `slug` and `references` are staged in a draft revision (only publish writes the columns and the slug), whatever the entry's status. An update with only `taxonomies` and `bylines` stages no draft; one with only `references` does | `src/emdash-runtime.ts:3649-3990` ("Content table columns = published data"); plan V5 |
| F18 | Unpublish creates a draft from the live revision when the entry has none, also on a collection without revisions, where publish keeps the live revision of the first publish (`promoteRevision`): there the new draft holds stale values and hides the columns. `handleContentDiscardDraft(collection, id, { _rev })` clears the draft pointer and keeps `updated_at` | `src/database/repositories/content.ts:2450-2560`, `:2727-2790`, `:2863-2903`; plan V5 |

### Unconfirmed, to be proven by Task 0

- **V1. Write-back round trip.** An update whose `data` holds a field's value exactly as
  `handleContentGet` returned it is accepted and reads back equal under the plan's comparison, for
  every type M4a-M4d write: text, number, integer, boolean (EmDash returns `0`/`1`; rollback sends
  `Boolean(value)` for `boolean` fields), datetime, select, multiSelect, json, custom slug fields,
  image and file values, Portable Text, and `null`. On Node and D1. If a type fails, the plan adds
  its conversion before Task 1.
- **V2. Trash and lookups.** `handleContentGet` and `handleContentList` with `fieldFilters` (the
  basis of `findBySourceId`) leave out trashed entries; `handleContentGetIncludingTrashed` returns
  a trashed entry with the `_rev` it had before the trash.
- **V3. Create timestamps.** A created item has `createdAt === updatedAt`, and `handleContentGet`
  right after a create returns the `_rev` the create returned.
- **V4. Delete frees the slug.** Trash then permanent delete of a created entry, then a create with
  the same explicit slug and `flux_source_id`, succeeds on SQLite and D1. Permanently deleting a
  created translation leaves its source's terms and reference selection intact.
- **V5. Revert sequence.** On a collection with revisions and one without, the sequence in
  "Revert sequence" restores status, `scheduledAt`, data, slug, terms, references and bylines for:
  published without a draft; a draft never published that the run published; a published entry
  with the importer's pending draft (a `publish: false` run) that a `publish: true` run published;
  a future-scheduled draft that the run published. A links-only update on a revisioned collection
  stages no draft. Unpublish on a revisioned collection keeps a staged draft's data (F10).
- **V6. Row size on D1.** A plugin storage value of 1 MiB of JSON is stored and read back on D1.
- **V7. D1 query count.** One rollback batch of `WORKERS_ROLLBACK_BATCH_CAP` reverted updates stays
  under 1,000 D1 queries (measured with the D1 binding's query log in `sites/dev-cf`).

If V1, V2 or V5 fail, the plan stops and this spec is amended before Task 1. V7 sets the Workers
cap: if 10 rows exceed the limit, the cap is lowered to what fits.

**Results (plan drafting, 2026-11-03, amended here).** V1, V2, V3, V4 and V6 hold on SQLite and
D1. V1 holds under a comparison where, at the field's top level, booleans compare by truth value
(EmDash returns `1`/`0`) and a `null` written reads back as an absent value; below the top level
values compare strictly (null, booleans and absent keys distinct), but an object's key order is
ignored (an image value reads back with its keys in another order). V5 **failed** for the sequence first specified (step 2
only publish or unpublish) in two of the four pre-states, "a draft never published that the run
published" and "a future-scheduled draft that the run published", on both collections and both
databases: without revisions every field read back with the run's values (the unpublish turned
the run's live revision into a draft, F18); with revisions the slug stayed the run's and the live
columns kept the run's values (F17). The amended sequence below restored all four pre-states on
both collections exactly, the draft pointer and the live columns included. V7 could not be
measured before the rollback exists; per call, D1 ran 62-80 queries for an update with every
field and link, 76 for a publish, 25-35 for an unpublish, 23 for a discard, 28-29 for a schedule
and 10-12 for a read, so a reverted update costs about 175-265 queries and 10 rows would exceed
the 1,000-query limit. The Workers cap is 3 (`WORKERS_ROLLBACK_BATCH_CAP`); the plan's review task
re-measures it with the real rollback (V7) and the import's linked batch (V8).

## The journal

```ts
// plugin storage `journal`, key `${jobId}:${linkKey}`
interface JournalEntry {
	jobId: string;
	/** The record that first touched the entry; rollback order. */
	seq: number;
	collection: string;
	locale: string;
	sourceKey: string;
	kind: "create" | "update";
	/** null until a create returns. */
	entryId: string | null;
	/** create: this job's create call returned `entryId` (not found by crash repair). */
	confirmed?: boolean;
	/** create: the `flux_source_id` the create sends (the translationOf value for a linked create). */
	sourceIdValue?: string;
	/** update only. */
	before?: {
		/** The link row before the job; null when there was none. */
		link: { jobId?: string; writtenRev?: string } | null;
		status: string;
		scheduledAt: string | null;
		/** The live slug, when the job changed the slug. */
		slug?: string | null;
		/** Live values of the fields the job changed or published. */
		live: Record<string, unknown>;
		/** The pending draft's values of the same fields, when the entry had a draft. */
		draft?: Record<string, unknown>;
		links?: {
			/** Term translation groups, by taxonomy. */
			taxonomies?: Record<string, string[]>;
			/** Target entry IDs, by reference field. */
			references?: Record<string, string[]>;
			bylines?: { bylineId: string; roleLabel: string | null }[];
		};
	};
	/** ISO time of the write-ahead put. */
	at: string;
}

// plugin storage `journalMedia`, key `${jobId}:${mediaId}`
interface JournalMedia {
	jobId: string;
	mediaId: string;
	url: string;
	seq: number;
}
```

Where the engine writes it:

| Point | Write |
| --- | --- |
| `writeRecord`, before the `writing` save, for a create | put-if-absent `{ kind: "create", entryId: null, sourceIdValue }` |
| `writeRecord`, right after the create returns | put with `entryId` and `confirmed: true` |
| `writeRecord`, before the `writing` save, for an update | put-if-absent `{ kind: "update", entryId, before }`; on an existing row, merge the new fields and links |
| `finishUnchanged`, before publishing the importer's own draft | as for an update; `live` holds every field whose `liveData` differs from `data` |
| Crash repair adopts an entry for a `create` row without `entryId` | put with `entryId` and `confirmed: false` |
| `obtainRecordMedia` / Portable Text images, after an upload with `deduplicated: false` | put `journalMedia` |
| `putLink` | the link row gains `jobId: job.id` |

`EntrySnapshot` gains `status`, `scheduledAt`, `createdAt`, `updatedAt` and `live?` (`liveData`
when a draft exists), parsed by `snapshotOf`. `JOB_LEVEL_WRITE_ERRORS` is unchanged: a journal
storage error is an unexpected error (`noteFailure`), as a failing record save is today.

## Rollback

### API

| Route | Input | Output |
| --- | --- | --- |
| `jobs/rollback` (new) | `{ id, dryRun?, batchSize?, budgetMs? }` | the rollback job (status `created`) |
| `jobs/create` | adds `journal?: boolean` | job |
| `jobs/next`, `jobs/get`, `jobs/list`, `jobs/records`, `jobs/log.csv`, `jobs/pause`, `jobs/resume`, `jobs/retry` | unchanged | work on rollback jobs |
| `jobs/cancel` | unchanged | refused for a rollback job (`invalid_transition`) |

`jobs/rollback` refuses (`invalid_transition`, 409): a dry-run job; a rollback job; a job in
`created`, `running` or `paused`, or with a live lease; a job with `rolledBackBy`; a job without
`journal: true` ("The job has no journal: it was created before rollback support or with
journal: false"). A real rollback sets `rolledBackBy` on the original with compare-and-set in the
same step that creates the rollback job (rollback job first, then the CAS; a lost CAS deletes the
new job and returns the conflict), then clears the source's `lastImport` when it names the
original.

```ts
// Job gains:
//   kind?: "import" | "rollback"        (absent: import)
//   rollbackOf?: string                  (rollback jobs)
//   rolledBackBy?: string                (originals)
//   journal?: boolean                    (import jobs; absent before M5a: no journal)
//   sourceId?: string                    (import jobs from a URL source)
// A rollback job copies collection and locale from the original's template for display, has
// `uploadId` of the original (unused), `cursor.seq` = the journal seq it continues below
// (Number.MAX_SAFE_INTEGER at start), and `dryRun`.
// Counters gain `reverted` (absent: 0). RecordStatus gains "reverted". `counterFor` counts a
//   rollback row that is `reverted`, or `planned` with a rollback action, as `reverted`.
// RecordRow.action also takes "delete" | "trash" | "revert" on rollback rows; RecordRow gains
//   step?: number (the last revert step done).
// LinkRow gains jobId?: string.
```

`runBatch` branches on `job.kind === "rollback"` to `rollbackPass` (and its retry pass) under the
same lease, budget and `failures` handling. `uploadNeeded` is false for rollback jobs and for
originals with `rolledBackBy`; retention's keep set ignores rollback jobs' `uploadId`.

### Per row

`rollbackPass` reads journal rows of `rollbackOf` with `seq < cursor.seq`, ordered by `seq`
descending, up to the batch size; after each row the cursor moves to its `seq`. Each row has a
record row in the rollback job, keyed `recordKey(rollbackJobId, journal.seq)`, with `start` and
`end` 0, the journal's `sourceKey` and the entry ID. A row whose record exists and is not
`writing` is counted and skipped (crash), as in `processRecord`.

1. **Find the entry.** By `entryId`, in the journal's collection and locale, active first, then
   including Trash (F6). A `create` row without `entryId` (a crash before the create returned, or
   an M4e partial create on D1) looks the entry up with `findBySourceId(collection, locale,
   sourceIdValue)` and takes it only when exactly one entry matches, its `createdAt` is at or after
   the journal row's `at`, and `updatedAt === createdAt` (V3); it is then handled as unconfirmed.
   No entry: `unchanged`, warning `nothing_to_roll_back` ("Nothing to roll back: the entry was
   never created, or was deleted since"). A row saved as `writing` with `action: "delete"` whose
   entry is gone is the permanent delete of a stopped batch: `reverted`, and its link row is
   deleted when it still names the entry.
2. **Ownership.** The entry is as the job left it when the link row (`links.get(linkKey)`) has
   `jobId === rollbackOf`, `entryId` equal to the entry's ID and `writtenRev === entry.rev`; or as
   this rollback left it when the row is `writing` with `writtenRev === entry.rev` (resuming).
   Otherwise `conflict`, `rollback_changed`: "Not rolled back: the entry changed after the import
   wrote it (an editor or a later import); roll back later imports first or revert it by hand".
   An `update` row whose job never wrote (a crash after the write-ahead put) has a link row from an
   earlier job; it is `unchanged`, warning `nothing_to_roll_back` ("Nothing to roll back: the
   import never wrote this entry"), when the entry's `rev` equals `before.link.writtenRev` or its
   `updatedAt` is before the journal row's `at`, and `conflict` otherwise. A `create` row passes
   ownership without a matching link row when its entry was created at or after the journal row's
   `at` and never changed since (`updatedAt === createdAt`, V3): the step 1 adoption, or a create
   crash repair found before the link row was saved. Such an entry is only moved to Trash unless
   the job's own create returned it (`confirmed`).
3. **Lock.** `isLocked` true: `locked`.
4. **Act**, saving the row as `writing` (with `action`) first and after every step with the step's
   returned `_rev` as `writtenRev` and the step number, so a resumed batch continues where it
   stopped. Each step sends the previous step's `_rev`; a `CONFLICT` is `rollback_changed`.
5. **Link.** After the last step: for a deleted or trashed entry the link row is deleted when it
   still names the entry; for a restored entry it is put back as `before.link` with `writtenRev`
   set to the final `_rev` (or deleted when `before.link` is null). The row becomes `reverted`.

### Created entries

1. When the entry is its group's root and `translations()` lists another active entry:
   `conflict`, `rollback_has_translations`.
2. Active: `handleContentDelete` (F6). `DELETE_BLOCKED` is `failed`, `rollback_blocked`, with the
   hook's message.
3. `confirmed`: `handleContentPermanentDelete` (F8), `action: "delete"`. Not confirmed: stop in
   Trash, `action: "trash"`, warning `rollback_trashed` ("Moved to Trash, not deleted: the import
   found this entry by crash repair, so it may not have created it").

Trash keeps `_rev` (F6), so a batch that stops between the two calls passes ownership on resume
and finishes the delete.

### Revert sequence (changed entries)

| Step | When | Call |
| --- | --- | --- |
| 1 restore live | `before.live`, `before.slug` or `before.links` is not empty | `update` with `data = before.live` (booleans by the job's `targetFields`, V1), `slug = before.slug` when present, and the links in `before.links` (term groups resolved to slugs in the entry's locale with `lookups.terms`, cached per batch) |
| 2 publish | `before.status === "published"` and the entry has a pending draft or is not published; or `before.status !== "published"` and the entry is published with a draft (revisioned collections: it makes step 1's values and slug live, F17) | `publish` |
| 3 unpublish | `before.status !== "published"` and the entry is published | `unpublish` (F10) |
| 4 discard | `before.draft` is absent and the entry has a draft (the draft step 3's unpublish created, F18, or one step 1 staged on a never-published entry) | `discardDraft` |
| 5 restore draft | `before.draft` | `update` with `data = before.draft` |
| 6 schedule | `before.scheduledAt` later than now and not equal to the entry's | `schedule(before.scheduledAt)` (F11) |

Steps 2-4 were amended after V5 (see "Results" above). Their side effects: an entry the run
published for the first time is published once more before it is unpublished, so the publish
hooks (`content:beforePublish`, `content:afterPublish`) run again for it, and its `publishedAt`
stays set (F12). A step is chosen from the entry's state after the previous step, so a resumed row
re-derives the same choices.

A term, byline or reference target that no longer exists is left out of the links with a warning
`rollback_link_missing`. A `before.scheduledAt` already past is not rescheduled: warning
`rollback_schedule_passed` ("The entry was scheduled for <time>, which has passed; it is left as a
draft"). On collections without revisions step 1 writes the live columns, step 2 changes only the
status, step 4 discards the stale draft step 3's unpublish created (F18), and step 5 never applies
(no drafts). `content:beforePublish`, `content:beforeUnpublish`
and `content:beforeSchedule` refusals (`PUBLISH_REJECTED` and the others) make the row `failed`,
`rollback_blocked`, with the hook's reason; earlier steps stay done and `jobs/retry` continues from
the saved step.

### Links after a rollback

Restoring the link row to `before.link` (with the rollback's final `_rev`) is what lets rollbacks
chain: after rolling back job B, an entry B changed is again "as job A left it" for A's rollback,
because its link row names A and its `_rev`. The importer's own pending draft that the rollback
restores (step 5) is then recognised as the importer's by the next import (M2 `writtenRev` rule).

### Dry run

A dry-run rollback runs steps 1-3 of "Per row" and plans step 4: rows are `planned` with the
`action` (`delete`, `trash`, `revert`), `changes` listing for each field and link the value it
would get back (`before` the current value, `after` the journal's), and the same `conflict`,
`locked` and warnings a real run would give. It writes no content, no link rows and sets no
`rolledBackBy`.

### Job warnings

At creation the rollback job gets, when they apply: "The import created <n> media items, which are
kept (EmDash cannot tell whether other content uses them): <ids>, …" (at most 100 IDs); and
"The import created <n> terms, which are kept (EmDash 1.2.0 has no term deletion for plugins);
the import's records list them under newTerms". Both come from `Job.created`, a summary the
import job keeps while it runs (term names and media IDs, at most 100 of each, with totals),
saved with each batch, so creating the rollback job scans no rows. A job with a journal always
has it once it has created anything; a job without one cannot be rolled back.

| Code | Kind | When |
| --- | --- | --- |
| `rollback_changed` | conflict | The entry changed after the job's last write, or a step's `_rev` was stale |
| `rollback_has_translations` | conflict | A created root entry has translations that are still active |
| `rollback_blocked` | failed | A plugin hook refused the delete, publish, unpublish or schedule |
| `rollback_trashed` | warning | A created entry found by crash repair was moved to Trash, not deleted |
| `rollback_schedule_passed` | warning | The entry's former schedule has passed |
| `rollback_link_missing` | warning | A term, byline or reference target of the pre-image no longer exists |
| `locked` | locked | Another user holds the entry's lock |
| `journal_too_large` | import error | The record's pre-image is over `MAX_JOURNAL_BYTES` |
| `journal_incomplete` | import error | A changed reference field's current selection was truncated |
| `journal_kind_unknown` | failed | A journal row of a kind this version does not know (a downgrade) |
| `nothing_to_roll_back` | warning (`unchanged`) | The job never wrote the entry, or the entry it created is gone |

## Translations, crash repair and the M4e issues

- **Partial creates on D1 (M4e review).** The write-ahead `create` row lets rollback find an entry a
  failed linked create left behind (step 1), and move it to Trash (unconfirmed). The import's own
  `translation_exists` loop on such an orphan is unchanged (M4e open issue); rolling the job back is
  now a way out.
- **Adoption window (M4e review).** An editor's translation that crash repair adopted is journalled
  as the importer's: as `update` (with the editor's content as the pre-image, so rollback restores
  it) when the link existed, or as an unconfirmed `create` when the row was `writing` for a create,
  which rollback only moves to Trash. Rollback never permanently deletes an adopted entry.
- **V3/V4 (M4e).** A translation job's writes do not move the source's `_rev` (M4e V3), so its
  rollback leaves the source alone. A source job's re-run that syncs shared values moves the
  translations' `_rev` (M4e V4): the translation job's rollback then reports those entries
  `rollback_changed`. Documented: roll back translation jobs before the source job, and do not
  re-run the source job in between.
- **Reference-only changes (F17).** An import that changed only an entry's references staged a
  draft on a collection with revisions (and published it with `publish: true`). Its pre-image has
  `links.references` and no `live`; step 1 sends only the references, which stages a draft again,
  and step 2 publishes it when the entry was published before, or step 4 discards it when it was a
  draft without one. The ownership check compares revisions, so it treats this entry like any
  other.
- **Pending drafts.** The importer writes over a pending draft only when it is its own (M2), so a
  pre-image's `draft` is always the importer's earlier draft; an editor's pending draft is never in
  a journal.

## Workers and Node

The rollback job is a job: one bounded batch per `jobs/next`, lease and takeover, budget checks
between rows, three unexpected errors fail it, `jobs/resume` continues. Every content call is
idempotent under its `_rev`, and the row's saved step and `writtenRev` make a crash mid-sequence
resumable. D1 runs a handler's statements without a transaction (M4e review), so a step can fail
after a partial write; the next attempt sees a `_rev` that is neither the link's nor the row's and
reports `rollback_changed` (documented, as for partial creates).

On Workers one `jobs/next` processes at most `WORKERS_ROLLBACK_BATCH_CAP` (3) rows, from the
per-call D1 counts (Results; re-measured as V7 in the plan's review task), with `WORKERS_LOOKUP_BUDGET` for term lookups. On Node the job's `batchSize` applies.

Import cost: a create adds two storage calls (the write-ahead put and the `entryId` put), an update
one (the put-if-absent; a get and put more when the row exists), a created media item one. No
extra content reads: everything in the pre-image comes from the reads the import already makes.

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| Journal row | `MAX_JOURNAL_BYTES` = 1 MiB of JSON | Within D1's row size (V6); the record row already holds up to 1 MiB values (M4a) |
| Rollback batch on Workers | `WORKERS_ROLLBACK_BATCH_CAP` = 3 | Up to seven content calls per row, about 175-265 D1 queries (Results, V7) |
| Rollback batch on Node | the rollback job's `batchSize` (default 50, maximum 500) | As imports |
| Media IDs in the warning | 100, then a count | Job size |
| Rollbacks per job | One | `rolledBackBy` |
| Rollback window | The retention period (`retentionDays`, default 30) | Journal rows are deleted with their job; an original that a rollback job names in `rollbackOf` (real or dry run, in any status) is kept until that rollback job is pruned |

## Retention

`purgeExpired` deletes an expired job's `journal` and `journalMedia` rows with its records. An
original that a rollback job names (`rollbackOf`, real or dry run, in any status) is kept while
that rollback job exists; when the rollback job has expired and is pruned, its original goes in
the same run if it has also expired. A job whose rows could not all be deleted stays for the next
run. Link rows are kept, as before.

## Testing

- **Unit, journal (fakes):** a create writes the write-ahead row before `content.create` and the
  `entryId` after; an update stores `live`, `draft` (with a pending own draft), `slug`, links,
  status, `scheduledAt` and the link row's `jobId`/`writtenRev`; publishing the importer's own draft
  in `finishUnchanged` journals the fields whose live and draft values differ; a second write of the
  same job keeps the first pre-image and adds new fields only; crash repair sets `confirmed: false`;
  `journal_too_large`, `journal_incomplete`; `journal: false` and dry runs write nothing;
  `putLink` sets `jobId`; a non-deduplicated upload writes `journalMedia`, a deduplicated one does
  not.
- **Unit, rollback (fakes):** every row of "Per row" and the revert sequence for each `before`
  shape; ownership by link row, by resumed `writing` row, `rollback_changed` for an editor's change
  and for a later job; the chain (rolling back B then A); created root with translations; an
  unconfirmed create trashed only; a resume between trash and permanent delete; a resume after
  each revert step; hook refusals; a passed schedule; a missing term; the dry run writes nothing and
  plans the same verdicts; `jobs/rollback` refusals; `rolledBackBy` blocks resume and retry;
  cancel refused; retention; `lastImport` cleared on cancel and rollback.
- **Integration on `sites/dev`:** a job that creates 20 entries and updates 10 (with taxonomies,
  a reference field, bylines, an image and a Portable Text field), on a revisioned and a plain
  collection, then a rollback restores every entry's data, slug, links and status exactly as read
  before the job, deletes the created ones, and the same feed then imports again without
  `SLUG_CONFLICT`; `publish: false` then `publish: true` then rollback of the second leaves the
  first's pending draft; a scheduled entry (an editor's schedule is a draft the importer did not
  write, so M5a cannot change it: the test sets the link row's `writtenRev` as an M5b scheduling
  import would leave it); an editor's change before the rollback gives
  `rollback_changed` and the entry is untouched; two jobs rolled back newest first, and oldest first
  (conflicts); a French translation job rolled back before the English one; kill-and-resume of a
  rollback mid-batch and mid-sequence; a dry-run rollback writes nothing; the kept-media and
  kept-terms warnings; a URL source re-imports after a cancelled and after a rolled-back job.
- **Cloudflare parity on `sites/dev-cf`:** a create-and-update job rolled back on D1 (deleted and
  restored entries, the re-import without slug conflicts), resumed after a forced stop mid-batch;
  V6 and V7.

## Plan sizing

About seven tasks: (0) prove V1-V7; (1) types, storage collections, `LinkRow.jobId`, snapshot
fields, `journal` option, `sourceId` and `lastImport` on cancel; (2) journal writes in
`writeRecord`, `finishUnchanged`, crash repair and media, with the size checks; (3) ports and
adapter: delete, permanent delete, get including Trash, unpublish, schedule; (4) `jobs/rollback`,
the rollback job lifecycle, `rolledBackBy`, retention; (5) `rollbackPass`: ownership, created
entries, the revert sequence, links, dry run, warnings, retry; (6) integration and parity tests and
the review note.

## Out of scope for M5a

Deleting media or terms the job created (F13, F14); restoring revision history or `publishedAt`
(F12); rolling back jobs created before M5a, dry runs or `journal: false` jobs; partial rollback
(by record or entry); forcing a rollback over later changes; cancelling a rollback; rolling back a
rollback; the record rules of M5b and the missing-entry actions of M5c.

## Outline of M5b and M5c

Each gets its own spec; these rulings fix the direction and the journal they write.

**M5b, record rules.**

- **Shape.** Record rules live in the template, next to `key` and `slug`, so a saved template (M6)
  carries them: `rules: { mode?: "upsert" | "create" | "update", updateFields?: string[],
  protectEdited?: boolean }`. `mode` defaults to `upsert` (today's behaviour). `create` skips
  records whose entry exists; `update` skips records without one; skipped records get the status
  `unchanged` with a reason code (`exists`, `not_found`), not a new counter. `updateFields` names
  the fields, `slug`, `taxonomies.<name>` and `bylines` an update may write (a create writes all);
  the others are not compared or written.
- **"Edited in the admin".** Revisions cannot tell (F3). The link row gains `fields`: a short
  fingerprint (SHA-256 prefix of the canonical value under the field's comparison, as `planRecord`
  compares) of each mapped field and link as the write's response returned it. With
  `protectEdited`, a field whose current fingerprint differs from the stored one was changed
  outside the importer and is not written (warning `field_edited`); it stays protected until its
  value equals the feed's again or a job without `protectEdited` writes it. A link row without
  fingerprints (written before M5b) falls back to the entry check: `entry.rev === link.writtenRev`
  means nothing was edited, otherwise every field counts as edited. No extra reads.
- **Publish, draft or schedule.** The job option `publish` accepts `true` (publish), `false`
  (draft), and the template gains `publishAt` (a date mapping, M4a rules) for a per-record
  schedule: a future time schedules the written draft (F11), a past or empty one publishes now. A
  status change is journalled as an `update` with `before.status` and `before.scheduledAt`; the
  M5a revert sequence already restores both.

**M5c, missing entries.**

- **Which entries are "this import's".** Only entries an import with the same owner created: the
  template gains `rules.missing: { action: "trash" | "unpublish", owner: string,
  maxPercent?: number }`, and a create stamps `owner` on its link row. Entries created before M5c,
  by another owner, or by an editor, are never touched.
- **Partial runs.** The missing phase runs only after a completed import pass with no job-level
  error, in the same job, not after a cancel or a failure, and only when the pass read at least one
  record and no record failed before its key was read (an unknown key could hide a present entry).
  "Seen" is a record of this job with the entry's source key (the `["jobId", "sourceKey"]` index).
- **Threshold.** When more than `maxPercent` (default 25) of the owner's entries would be affected,
  the phase does nothing and the job gets a warning; a job option overrides it for one run.
- **Delete.** Not offered: a permanent delete cannot be rolled back, which the milestone's
  acceptance requires. `trash` covers deletion (an admin empties Trash).
- **Journal and rollback.** Trash is a new journal kind `trash` with the M5a `before` (status,
  schedule); its rollback restores from Trash (F7, adds `content:restore` to the declared
  capabilities), then publishes or schedules as the M5a revert sequence does. Unpublish is an
  `update` with `before.status`.
- **Dry run.** A dry run plans the missing actions and reports the threshold.

## Open issues carried forward

- **New in this design.**
  - Media and terms the job created are kept (F13, F14); the rollback lists them. The importer's
    media map rows for kept media stay, so a re-import reuses those items.
  - A crash between a media upload and its `journalMedia` put leaves the item off the list.
  - `publishedAt` stays set on an entry the run published for the first time (F12).
  - A staged slug in a pending draft is not in the pre-image (F5): rollback restores the live slug.
  - Likewise, `handleContentGet` returns a pending draft's reference selection, not the live one.
    When a publishing job writes or publishes a published entry with a pending draft and the template maps
    references, the pre-image has `referencesUnknown: true` and holds the draft's selection; the
    rollback reports `references_not_restored` for it instead of a plain `reverted` (Task 6).
  - Rollbacks must go newest first across jobs, and translation jobs before their source job;
    otherwise entries report `rollback_changed`.
  - A step that fails after a partial write on D1 leaves the entry `rollback_changed`.
  - The rollback window is the retention period.
  - `lastImport` is still set at job creation, so a running or paused job from a URL source still
    makes an import of the same content skip; only cancel and rollback clear it. M6's scheduled
    imports rely on this to avoid a second job for content a running job is importing.
- **Settled by this design.** M4c's "M5 rollback needs its own record of job-created media"
  (`journalMedia`); the `lastImport` skip after a cancelled run; M4e's partial creates on D1 can now
  be cleaned up by a rollback (moved to Trash).
- **From M4e** (`2026-11-03-m4e-review.md`), unchanged: the crash repair adoption window (narrowed
  for rollback: adopted entries are never permanently deleted), the ambiguous `flux_source_id`
  in the job's locale, the partial linked create's `translation_exists` loop on re-runs, the dry run
  that cannot predict two rows naming one source, V4's outcome, i18n turned off, jobs created
  before M4e, the fail-closed refusal, the spec-listed issues, the unmeasured D1 query count for
  linked batches, the parity gaps, the minor test gaps, the known flakes (F1, F2, port 4397), and
  the known gaps from the spec and plan.
- **From M4d, M4c and earlier**, as carried in the M4e review, unchanged; the production Cloudflare
  build blocker from M2 still stands.
