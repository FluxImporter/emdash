# Flux Import M4c: media from URL

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Third part of Milestone 4 (Field types and schema) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-4-split). Builds on M4b
([spec](./2026-10-27-flux-import-m4b-taxonomies-references-design.md),
[review](../notes/2026-10-27-m4b-review.md)), merged at `8ed3709`, and on the M3c fetcher and SSRF
guard ([spec](./2026-10-26-flux-import-m3c-url-sources-design.md)).

## Goal

Import `image` and `file` fields from URLs in the source:

- The importer downloads each URL through the M3c SSRF guard, checks its size and type, and stores
  it in the Media Library through the trusted runtime's `handleMediaUpload`. EmDash dedupes
  identical bytes by content hash.
- Alt text can be mapped per field. It is written into the field value (alt for this use) and
  given to a newly created library item as its default.
- A site-wide **media map** (plugin storage) remembers which media item each URL became. A re-run
  plans `unchanged` without downloading again, and M4d will look Portable Text image URLs up in
  the same map through the same resolver.

A dry run downloads nothing. It reports map hits exactly and lists the URLs a real run would
download. The template stays `version: 1` and every addition is optional.

## Decisions

| Topic | Decision |
| --- | --- |
| Template shape | Two new field mapping types, `image` and `file`, in `fields`. Each takes one URL (`from` or `expr`) and an optional `alt` (`{ from }` or `{ expr }`, images only). Image and file fields hold one media item each (F1), so a mapping takes one URL, not a list. |
| Upload path | `runtime.handleMediaUpload` (F2), called with the actor's user ID as `authorId` and the site's `maxUploadSize` (F4). It runs EmDash's allowlist, size check, content-hash dedupe, storage write with cleanup, image enrichment and the `media:beforeUpload` / `media:afterUpload` hooks. `ctx.media.upload()` is not used: it has no dedupe, no alt and no hooks (F12). The plugin never writes media to `emdash.storage` itself. |
| Field value | Built by the importer from the media item it holds: `{ id, provider: "local", filename, mimeType, width?, height?, blurhash?, dominantColor?, alt?, meta: { storageKey } }` for images, and `{ id, provider: "local", filename, mimeType, size, meta: { storageKey } }` for files. This is the documented stored shape (F1). EmDash's own normalization (F6) would fill the same keys, but it swallows failures, so the importer does not rely on it. `src` is never sent (EmDash strips it for local media). |
| Alt text | Mapped alt goes into the field value. When the upload creates a new item, the alt is also sent as the library default. A deduplicated item keeps its library alt (F3). An empty mapped alt writes no alt, so EmDash falls back to the library alt (F6); the diff then ignores alt for that record. Captions are not mapped: EmDash 1.2.0 drops a per-use `caption` on save (F7), although the current docs describe one. |
| When to download | Per record, inside the batch, after every lookup of the record succeeded and after the entry's pending-draft and lock checks (see Batch integration). There is no pre-pass: it would read the source twice and need its own resumable state, and the per-record path already has crash repair. Downloads are sequential, one file in memory at a time. |
| Media map | Plugin storage collection `media`, site-wide, keyed by `u` + SHA-256 (hex) of the normalized URL. A row holds the media ID, storage key, MIME type, size, validators and the job that last fetched it. It is written as soon as an upload succeeds, before the content write. A map hit is checked once per batch with `handleMediaGet`. A missing or not-ready item drops the row and the URL is downloaded again. Rows are never purged by retention. They are the importer's memory of what it already stored. |
| Why site-wide | Every run is a new job, so a map scoped to one job would not stop a re-run from downloading again. Rows carry `jobId` (indexed) and `created` (the upload made a new item rather than deduplicating), so a job's own media can still be listed, for M5 rollback and for audit. |
| M4d contract | `mediaMapKey(url)` and `resolveMedia(deps, cache, request)` are exported from `src/engine/media.ts`. M4d calls the resolver for each Portable Text image URL. It shares the per-batch cache, the Workers budget and the batch deadline, and it gets back the media item, including `storageKey` for the `/_emdash/api/media/file/<key>` URL. |
| URL normalization | `parseSourceUrl` (http/https, no userinfo, at most 2,048 characters), then the WHATWG `URL` serialization. The fragment is dropped before the length check. Host case and default ports are normalized by `URL`. Percent-encoding in the path and query is normalized: every `%xx` gets upper-case hex digits, and one that encodes an unreserved character (letters, digits, `-`, `.`, `_`, `~`) is decoded, so `%7e`, `%7E` and `~` give one key; reserved characters stay encoded. The query is otherwise kept as given. Relative URLs and `data:` URLs fail with `invalid_media_url`. A template can build an absolute URL with `expr`. |
| Refresh | Default: a URL in the map is never downloaded again. Mapping option `refresh: true` sends a conditional GET with the stored `ETag` / `Last-Modified`. A `304` keeps the item. A `200` uploads again: identical bytes dedupe to the same item, changed bytes make a new item, and the row is updated. |
| Dry run | No network, no uploads. A dry run applies the checks that need no network (URL syntax, scheme, blocked host names, IP literals; `checkHost`) and the map lookup, including the `handleMediaGet` check. A miss plans a change and lists the URL in the row's `newMedia`. Documented gaps: a dry run cannot report HTTP errors, DNS answers, size, type, or whether a download would deduplicate to the media the entry already has (which would make the record `unchanged`). HEAD requests are not used: many servers answer HEAD differently from GET or leave out `Content-Length`, so a HEAD would not prove what the GET returns, and each one costs a subrequest. |
| Size limit | `min(maxUploadSize ?? 50 MiB, 5 MiB on Workers)`, rounded down to a multiple of 3 (EmDash prechecks the padded base64 size), read at job creation and stored on the job (`mediaMaxBytes`); a refusal quotes this rounded limit, the exact size that is accepted. A larger `Content-Length` is refused before the body is read. The stream is counted and cut once it passes the limit. The Workers cap exists because `handleMediaUpload` takes base64: one file is held as downloaded bytes, a base64 string and decoded bytes (about 3.4 times its size), plus the placeholder decode (F9), inside a 128 MB isolate (F15). The cap was 10 MiB in the approved design; V5 measured about 398 MiB peak on Node for a 10 MiB, 8.4-megapixel JPEG (about 370 MiB of it in the placeholder decode, which scales with pixels, not bytes), over the 100 MB threshold, so it is 5 MiB. |
| Type rules | The bytes decide. The importer sniffs magic bytes for every type it can (PNG, JPEG, GIF, WebP, AVIF, JPEG XL, PDF, MP4/QuickTime `ftyp`, WebM/Matroska, Ogg, WAV, MP3). An `image/*` or `application/pdf` result must come from the bytes. For `video/*` and `audio/*` the response's `Content-Type` is accepted when the bytes are not recognized and do not look like markup. The URL's extension is used only when both of those say nothing (`application/octet-stream` or no header). The resolved type must be in EmDash's default upload allowlist (F5), be `image/*` for an `image` mapping, and satisfy the field's `allowedMimeTypes`, which EmDash enforces again on save (F8). These checks come before the upload, so a file the write would refuse is never stored. EmDash itself trusts the type it is given (F5), which is why the importer sniffs. |
| SVG and HTML | Always refused (`media_type_not_allowed`). EmDash's upload allowlist excludes SVG even when the field allows it (F5), and bytes that start with markup (`<`, after a BOM and whitespace) are refused whatever the header says. Served media is also hardened by EmDash (`nosniff`, sandbox CSP, `attachment` for unsafe types; F11). |
| Filename | The last path segment of the final URL, percent-decoded, reduced to `[A-Za-z0-9._-]`, at most 100 characters, `media` when empty. Its extension is replaced with the canonical one for the resolved MIME type, because EmDash keeps the extension on the storage key and the local adapter serves files by extension (F11). |
| Failures | Each media problem is a record error on the field, and the record fails without a content write. Codes are listed under Resolution. There are no automatic retries inside a run: `jobs/retry` re-processes failed records, and media that was already stored is found in the map. |
| Timeouts | 10 s to response headers, then at most 30 s for the whole download, and never past the batch's media deadline (see Batch integration). A record whose next download would not fit in the time left is **deferred**: the batch ends before it and the cursor is not advanced, so the next batch processes it again and reuses the media already stored. The first download of a batch is always started, so every batch makes progress. |
| Limits per record and batch | At most 5 media mappings per template, so at most 5 downloads per record. On Workers each download costs 60 units of the existing lookup budget (600 per `jobs/next`), so a batch does at most about 10 downloads and ends after the record that spends the budget. On Node only the batch time and record count bound a batch. |
| Orphans | Media is never deleted by the importer. An item stored for a record that then fails, conflicts or is locked stays in the library and in the map, and the next run reuses it. Deleting it could remove an item another entry uses: dedupe can return an existing item, and other records may share the URL. M5 rollback can find the job's own new items through the map's `jobId` / `created`. |
| Locale | Media items have no locale (F13). The map is locale-free. Alt text lives in the field value, which is per locale row like every other field. |
| Capabilities | Add `media:write` for disclosure (consent dialog: "Upload, replace, and delete media"; implies `media:read`, F14). As with `content:*`, the calls go through the trusted runtime and are not gated by it. The M3c ruling on network capabilities is unchanged. |
| `schema/apply` | `image` and `file` join `APPLY_FIELD_TYPES`. They are plain TEXT columns created through `SchemaRegistry` like the M4a types, with no `allowedMimeTypes`. |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`) and the docs on 2026-10-27.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | `image` and `file` fields are TEXT columns holding one JSON object. Image: `{ id, src?, alt?, width?, height?, filename?, mimeType?, blurhash?, dominantColor?, focalX?, focalY?, provider?, previewUrl?, meta?, darkVariant? }`. File: `{ id, url?, src?, filename?, mimeType?, size?, provider?, meta? }`. `provider` defaults to `"local"`, and local media keeps `meta.storageKey`. Content reads return the stored value as is | `src/schema/zod-generator.ts:162-201`; `src/schema/types.ts` (`image: "TEXT"`, `file: "TEXT"`); [field types: image, file](https://docs.emdashcms.com/reference/field-types/#image) |
| F2 | `runtime.handleMediaUpload({ filename, base64, contentType, alt?, caption?, authorId?, maxUploadSize? })` is a public method of `EmDashRuntime`. It returns `{ success, data: { item: MediaItem & { url }, deduplicated? } }` or `{ success: false, error: { code, message } }` (`NO_STORAGE` without storage). It runs `media:beforeUpload`, and `media:afterUpload` for new items | `src/emdash-runtime.ts:4799-4824`; `src/api/handlers/media-upload.ts:25-44`; `dist/config-C4-UxIk7.d.mts:3520` |
| F3 | The handler's checks, in order: base64 and content type are present (`VALIDATION_ERROR`); `maxUploadSize` is finite and positive (`CONFIGURATION_ERROR`); the encoded size precheck and the decoded size (`PAYLOAD_TOO_LARGE`); the content type matches `CONTENT_TYPE_RE`; the global allowlist (`INVALID_TYPE`); hooks. Then a SHA-1 content hash (`sha1:<hex>`) is matched against **ready** media. A match returns the existing item with `deduplicated: true` and does not apply `alt` or `caption`. Otherwise it stores under `<ulid><ext of filename>`, enriches, and creates the row, deleting the object if the row fails. Any thrown error becomes `UPLOAD_ERROR` "Upload failed", with no detail | `src/api/handlers/media-upload.ts:96-189`; `src/utils/hash.ts:28-47`; `src/database/repositories/media.ts:466-475`; [REST: identical bytes return the existing item; alt and caption not applied](https://docs.emdashcms.com/reference/rest-api/#direct-multipart-upload) |
| F4 | `maxUploadSize` is an `emdash({ … })` integration option (default 50 MB, `DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024`). It is not read by `handleMediaUpload`: callers pass `emdash.config.maxUploadSize`, as the REST route and the MCP tool do. `runtime.config` is public | `src/astro/integration/runtime.ts:425-436`; `src/api/schemas/media.ts:103`; `src/astro/routes/api/media.ts:129`; `src/mcp/server.ts:2684-2692`; `src/emdash-runtime.ts:763`; [configuration: maxUploadSize](https://docs.emdashcms.com/reference/configuration/#maxuploadsize) |
| F5 | The default upload allowlist is PNG, JPEG, GIF, WebP, AVIF, JPEG XL, `video/`, `audio/` and `application/pdf`. SVG is excluded on purpose. `handleMediaUpload` checks only this list, never a field's list. `resolveUploadMimeType` trusts the given type and falls back to the extension only for an empty type or `application/octet-stream`. Nothing inspects the bytes | `src/api/handlers/media-allowlist.ts:6-29`; `src/media/mime.ts:21-37`; `src/api/handlers/media-upload.ts:114-127`; [media library: accepted files](https://docs.emdashcms.com/guides/media-library/#accepted-files-and-size-limit) |
| F6 | On create and update, EmDash normalizes image and file values. A bare local ID or internal URL is resolved. A local object loses `src` and gets missing `width`, `height`, `filename`, `mimeType`, `blurhash`, `dominantColor` and `meta` from the local provider. A caller `alt` wins, and an empty one falls back to the library alt. Failures are swallowed and the value is kept as given | `src/emdash-runtime.ts:3595`, `:3762`, `:5953-6011`, `:6470-6496`; `src/media/normalize.ts:37-99`, `:206-233` |
| F7 | The 1.2.0 normalizer rebuilds the value from known keys (`recordToMediaValue`), and the `MediaValue` type has no `caption`, so a per-use caption is dropped on save. The current docs describe a top-level `caption`, which is newer than 1.2.0 | `src/media/normalize.ts:242-264`; `src/media/types.ts:254-283`; [media library: image and file fields](https://docs.emdashcms.com/guides/media-library/#image-and-file-fields) |
| F8 | A field's `validation.allowedMimeTypes` is enforced on content create and update. Local media is checked by its stored `mime_type`, and a failure gives `INVALID_MIME_FOR_FIELD` | `src/api/handlers/validate-media-fields.ts:155-236`; `src/api/handlers/content.ts:1241`, `:1520` |
| F9 | Enrichment reads dimensions from headers (`image-size`) and decodes JPEG or PNG for the blurhash only when width × height × 4 is at most 32 MiB. It is described as Workers-safe. The handler decodes base64 with `Uint8Array.fromBase64` or `atob` | `src/media/enrich.ts:1-80`; `src/media/placeholder.ts:26-29`, `:141`; `src/utils/base64.ts:44-50` |
| F10 | `runtime.handleMediaGet(id)` returns `{ item: MediaItem }` for a row of any status (`NOT_FOUND` otherwise). `MediaItem` has `id`, `filename`, `mimeType`, `size`, `width`, `height`, `alt`, `caption`, `storageKey`, `status`, `contentHash`, `blurhash`, `dominantColor`, `createdAt` and `authorId` | `src/api/handlers/media.ts:104-125`; `src/database/repositories/media.ts:57-76` |
| F11 | `/_emdash/api/media/file/<key>` serves every type with `X-Content-Type-Options: nosniff` and a sandbox CSP, inline only for safe raster, video and audio types, and as `attachment` otherwise. The local adapter derives the served `Content-Type` from the key's extension | `src/astro/routes/api/media/file/[...key].ts:46-61`, `:121-139`; `src/storage/local.ts:138`, `:247` |
| F12 | `ctx.media.upload(filename, contentType, bytes)` (`media:write`) enforces the default allowlist and stores and enriches the file, but it has no dedupe, no alt and no hooks | `src/plugins/context.ts:1018-1105`, `:1773-1795`; [capabilities: uploading media](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/#uploading-media) |
| F13 | The `media` table has no locale column, and no media migration adds one | `src/database/migrations/001_initial.ts:75-96`; migrations `002`, `072`, `073` |
| F14 | Capability strings: `media:read`, `media:write` (implies `media:read`), `media:bytes:read`, `media:metadata:write` | [capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/) |
| F15 | Workers: 128 MB memory per isolate; CPU 10 ms (Free) or 30 s by default (Paid) per HTTP request; subrequests 50 (Free, external) or 10,000 by default (Paid), and R2 and D1 calls count; 6 simultaneous open connections; no wall-time limit while the client is connected | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-10-27 |

The M4b service note cites "1,000 D1 queries per invocation" (`src/plugin/service.ts`). The limits
page now gives 10,000 subrequests by default on Paid. The lookup budget (600 units) is left
unchanged, because it was never measured (M4b review). It is now conservative.

### Unconfirmed, proven by Task 0

- **V1.** `runtime.handleMediaUpload` works from a native plugin route on Node (local storage) and on
  workerd (R2): it creates an item, a second call with the same bytes returns `deduplicated: true`,
  and a JPEG gets `width`, `height` and `blurhash` on workerd. This also covers the handler's
  `node:path` import under `nodejs_compat`.
- **V2.** `runtime.config.maxUploadSize` is readable from the route on both runtimes. It is
  `undefined` when unset.
- **V3.** A content create with the importer's full image value (with `alt`) and file value reads
  back from `handleContentGet` as the same object, with `alt` kept. A `caption` key is dropped
  (F7).
- **V4.** A field with `allowedMimeTypes: ["image/png"]` refuses a JPEG item on save with
  `INVALID_MIME_FOR_FIELD` (F8), so the importer's pre-check matches EmDash.
- **V5.** Memory: a 10 MiB JPEG goes through download, base64 and upload on workerd. The probe
  records the heap high-water mark on Node with the same path. Local workerd may not enforce
  128 MB, so this is a measurement, not a proof.

If V1-V4 fail, the plan stops and the spec is amended before Task 1. If V5 shows more than 100 MB
for 10 MiB, the Workers cap drops to 5 MiB.

## Template additions

```json
{
	"version": 1,
	"collection": "products",
	"locale": "en",
	"key": { "from": "sku" },
	"fields": {
		"title": { "from": "Name", "type": "text" },
		"photo": { "from": "ImageUrl", "type": "image", "alt": { "from": "ImageAlt" } },
		"manual": { "expr": "'https://cdn.example.com/manuals/' & sku & '.pdf'", "type": "file", "refresh": true }
	}
}
```

| Mapping | Option | Value |
| --- | --- | --- |
| `image` | `alt` | `{ from }` or `{ expr }` (exactly one); text, trimmed, at most 1,000 characters |
| `image`, `file` | `refresh` | boolean, default `false` |

A template takes at most 5 `image` and `file` mappings together. `COMPATIBLE.image = ["image"]`
and `COMPATIBLE.file = ["file"]`. `templatePaths` includes `alt.from`.

## Conversion rules

The M3a/M4a rules apply first. A missing path, `null` or blank text is empty. A number or boolean
fails `not_scalar`, and so do objects and arrays. The text is trimmed and checked as a URL
(`invalid_media_url`). Alt: a scalar becomes text and is trimmed. Empty alt is no alt. More than
1,000 characters fails `alt_too_long`. An empty URL into a `required` field fails `required`.

Conversion is synchronous and gives a `MediaRequest`, not a value:

```ts
type MediaRequest = { kind: "image" | "file"; url: string /* normalized */; alt: string | null; refresh: boolean };
// MappedRecord gains: media?: Record<string, MediaRequest | null>; media fields are kept out of `data`
```

### Resolution

`resolveMedia` runs after `resolveLinks`, per mapped field:

| Step | Rule | Errors |
| --- | --- | --- |
| Host check | `checkHost` (no DNS), in every run | `media_blocked` |
| Map lookup | `media.get(mediaMapKey(url))`, then `handleMediaGet(row.mediaId)` once per batch and URL (cached). An item that is missing or not `ready` drops the row | none (a drop is a miss) |
| Hit | Its MIME type is checked against the mapping kind and the field's `allowedMimeTypes`. With `refresh`, a real run sends a conditional GET first | `media_type_not_allowed` |
| Miss, dry run | Planned as new: the change shows `new media from <url>`, and the URL goes into `newMedia` | none |
| Miss, real run | Download (guarded, limits, timeouts), sniff, filename, upload through `handleMediaUpload`, write the map row | below |

| Code | When |
| --- | --- |
| `invalid_media_url` | Not an absolute http(s) URL, userinfo, or more than 2,048 characters |
| `media_blocked` | `URL_BLOCKED` from the guard: blocked host or address, including after redirects |
| `media_fetch_failed` | Network or DNS failure, timeout, more than 5 redirects |
| `media_http_error` | A final status other than 2xx (or 304 on refresh); the message has the status |
| `media_too_large` | Over `mediaMaxBytes` (header or stream), or EmDash's `PAYLOAD_TOO_LARGE` |
| `media_type_not_allowed` | Markup, SVG, a type outside the allowlist, a non-image into an `image` field, outside the field's `allowedMimeTypes`, an `image/*`/PDF header the bytes do not confirm, or EmDash's `INVALID_TYPE` |
| `media_upload_failed` | Any other `handleMediaUpload` error, with EmDash's code in the message (`UPLOAD_ERROR` has no detail, F3) |
| `alt_too_long`, `required`, `not_scalar` | Conversion, as above |

`CONFIGURATION_ERROR` and `NO_STORAGE` fail the job (`media_config`), not the record. As in M4b,
every lookup of the record runs and all errors are collected. Downloads start only when there are
none, and they stop at the first failed download (the remaining fields are not attempted).

## Schema checks at job creation

`checkTemplate` gains these problems:

- An `image` or `file` mapping into a field of another type.
- A field whose `allowedMimeTypes` shares no type with the upload allowlist (for example
  `["image/svg+xml"]`): "EmDash's upload refuses every type this field accepts".
- More than 5 media mappings.

`TargetField` gains `allowedMimeTypes?: string[]`, and `listSchemaFields` / `rulesOf` carry it.
`Job` gains `mediaMaxBytes?: number`, set when the template maps media. The route fails job
creation with `NOT_CONFIGURED` when storage is missing, as uploads already do.

## Diff and writes

- `planRecord` gets the resolved media per field: `{ mediaId: string | null /* null: new */,
  value: MediaFieldValue | null, text: string, alt: string | null }`.
- Comparison kind `media`: the stored value's `id` (a bare string counts as an ID) equals
  `mediaId`. When the mapped alt is not empty, the stored `alt` must equal it too. Other keys are
  ignored, because EmDash may fill them (F6). `null` equals a missing or `null` stored value. A
  new item (dry run) is always a change.
- Changes: `{ field: "photo", before: "<old id>" | null, after: "<new id>" | "new media from <url>" }`,
  plus `{ field: "photo.alt", … }` when only the alt differs.
- Writes: the value is put into `data` under the field. An empty value writes `null` (clears the
  field). Media fields count as data fields for the M4b "only links changed" rule, and so does a
  `<field>.alt` change (`writeRecord`'s `dataChanged` test must match both).
- `RecordRow` gains `newMedia?: string[]` (`"photo: https://…"`). It lists URLs downloaded for the
  record (also when the upload deduplicated) or, in a dry run, URLs a real run would download. A
  retried row keeps its earlier entries, as with `newTerms`.
- Documented behaviour (rewrite): when any data field of an existing entry changes, every mapped
  media field is rewritten from the library item, so per-use keys an editor added to the stored
  value (a focal point, or a per-use alt when the template maps no alt) are dropped.
- Documented behaviour (dry run): a URL repeated across records is listed in each row's
  `newMedia`, although a real run downloads it once per batch and reuses the item.

## Batch integration

Real run, per record: filter → `applyTemplate` → `resolveLinks` → media **map lookups** → entry
read → a provisional `planRecord` in which each miss counts as a change → if that plan is not
`unchanged`, the pending-draft and lock checks (M2) → **downloads and uploads** for the misses →
the final `planRecord` with the real media IDs → write. So a record whose entry is locked or has
someone else's draft downloads nothing. A dry run stops after the provisional plan.

Ports:

```ts
interface MediaPort {            // EmDashMedia over the runtime
	get(id: string): Promise<MediaInfo | null>;                 // handleMediaGet, ready only
	upload(input: { filename: string; contentType: string; bytes: Uint8Array; alt?: string }):
		Promise<{ item: MediaInfo; deduplicated: boolean }>;    // handleMediaUpload, base64 via Buffer
}
interface MediaFetcher {         // src/sources/media-fetch.ts over guardedFetch
	fetch(url: string, o: { maxBytes: number; deadline: number; etag?: string; lastModified?: string }):
		Promise<{ status: 200; bytes: Uint8Array; contentType: string | null; finalUrl: string; etag?: string; lastModified?: string } | { status: 304 }>;
}
// EngineDeps gains: media: MediaPort; mediaFetcher: MediaFetcher; mediaMap: KvCollection<MediaMapRow>
interface MediaMapRow {
	url: string; mediaId: string; storageKey: string; mimeType: string; bytes: number;
	etag?: string; lastModified?: string; fetchedAt: string; jobId: string; created: boolean;
}
```

`media-fetch.ts` reuses `guardedFetch`, `fetchError` and the `Content-Length` rule from `fetcher.ts`
(exported for it), with `Accept` set for the mapping kind. It buffers the counted body into one
`Uint8Array`. The plugin storage collection `media` has the indexes `jobId` and `mediaId`.

**Deadline and deferral.** `LookupCache` gains `mediaDeadline = started + budgetMs + 20 s`. The
lease lasts `budgetMs + 30 s` (`LEASE_GRACE_MS`), which leaves 10 s for the write and publish.
Before each download, the time left must be at least 5 s, unless this is the batch's first
download. Otherwise resolution throws `MediaDeferred`. `processRecord` lets it through without
saving a row, and `importPass` / `retryPass` end the batch with `{ done: false }` **without**
advancing `cursor` or `retryFromSeq`. Nothing of the record was written. Media already stored is
in the map.

**Workers.** A download costs `COST_MEDIA = 60` of the batch budget, a map hit `COST_CALL` plus
`COST_CALL` for its `handleMediaGet`, and an upload is included in `COST_MEDIA`.
`workersBatchCap` returns `WORKERS_LINKED_BATCH_CAP` (10) when the template maps media.
Downloads are sequential, so memory is one file at a time (F15, V5).

## Testing

- **Unit, conversion:** URL normalization (case, default port, fragment, query kept), relative,
  `data:` and userinfo URLs refused, non-scalars, alt from `from` and `expr`, alt too long, required
  empty, the 5-mapping limit, map key stability.
- **Unit, fetch and sniffing:** every magic-byte type; markup refused under an `image/png` header;
  an unrecognized `video/*` accepted from its header; extension fallback only for
  `application/octet-stream`; `Content-Length` over the limit refused before reading; a stream cut
  at the limit; header and total timeouts; the deadline shortens the total timeout; 304 on refresh;
  filename sanitizing and extension replacement.
- **Unit, resolution:** hit with a ready item (no download); hit whose item was deleted (row dropped,
  download); dry-run miss (no fetch, `newMedia`, change text); `allowedMimeTypes` and `image`-kind
  refusals before upload; EmDash error codes mapped; `CONFIGURATION_ERROR` fails the job; a
  deduplicated upload maps to the existing item and is still listed in `newMedia`; a lookup error
  elsewhere in the record means no download; the per-batch `handleMediaGet` cache; deferral when the
  deadline is near, but never for the batch's first download; the Workers budget.
- **Unit, diff and writes:** `id` comparison, a bare string ID, alt compared only when mapped and
  not empty, `null` against a missing value, the full value written, a media-only change sends
  `data`.
- **Unit, schema checks:** type compatibility, an SVG-only `allowedMimeTypes`, the mapping limit,
  `schema/apply` creating `image` and `file`.
- **Integration on `sites/dev`** (local HTTP server, `allowPrivateNetwork`), with fixture images
  and a PDF:
  - a CSV import with an image (with alt) and a file creates the media items and fields, and the
    file URLs serve the right content type;
  - a re-run is `unchanged` and the server sees no second request;
  - two rows with different URLs serving identical bytes share one media item;
  - a dry run makes no request and lists `newMedia`;
  - a 404, a too-large file, HTML served as `image/png`, and an SVG each fail their record with the
    right code;
  - `refresh: true` with a changed file updates the entry, and a 304 keeps it `unchanged`;
  - a deleted media item is downloaded again on the next run;
  - a field with `allowedMimeTypes` refuses a PDF before upload;
  - a slow server defers a record to the next batch with no duplicate download.
- **Cloudflare parity on `sites/dev-cf`:** one import with an image and a file into R2, a re-run
  `unchanged`, and a file over the Workers cap refused with `media_too_large`.

## Plan sizing

About nine tasks: (0) prove V1-V5; (1) template schema, conversion, URL normalization and map key;
(2) schema checks, `allowedMimeTypes` snapshot, `mediaMaxBytes`, `schema/apply` types; (3)
`media-fetch.ts`: guarded buffered download, sniffing and filenames; (4) `MediaPort` /
`EmDashMedia` and the `media` storage collection; (5) the resolver: map hits, dry run, downloads
and uploads, per-batch cache and budget; (6) diff, value building, writes and `newMedia`; (7) batch
ordering (provisional plan before downloads), deadline and deferral, Workers cap, capabilities and
route wiring; (8) integration and parity tests, and the review note. If it runs long, `refresh`
(in tasks 1, 3 and 5) can move to a follow-up without affecting the rest.

## Out of scope for M4c

Image URLs inside Portable Text (M4d, through `resolveMedia`); repeater, gallery and block image
sub-fields; `darkVariant`; per-use captions (EmDash 1.2.0 drops them, F7) and library captions;
focal points; credentials or custom headers for media URLs (media is fetched without
credentials); relative URLs resolved against a base; external media providers (`provider` other
than `local`); deleting or replacing library items; more than one media item per field; parallel
downloads; HEAD probing in dry runs; the Workers Free plan (10 ms CPU per request is too little for
image enrichment, F15). The production Cloudflare build blocker from M2 still stands.
