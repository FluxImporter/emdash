# Flux Import M4c: media from URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 runs first and alone; Tasks 1 and 3, and later Tasks 2 and 6, can run in parallel worktrees (see "Parallel execution").

**Goal:** Import `image` and `file` fields from URLs in the source. The importer downloads each URL through the M3c SSRF guard, checks its size and its type (by the bytes), and stores it in the Media Library through the trusted runtime's `handleMediaUpload`, which dedupes identical bytes. Alt text can be mapped per image field. A site-wide media map in plugin storage remembers which media item each URL became, so a re-run plans `unchanged` without downloading again, and M4d can look Portable Text image URLs up through the same resolver. A dry run downloads nothing: it reports map hits exactly and lists the URLs a real run would download. Templates stay `version: 1`; every addition is optional, and jobs created before M4c behave as before.

**Architecture:** Conversion stays synchronous: `src/engine/media.ts` holds the limits, URL normalization, `mediaMapKey`, the URL and alt converters and the MIME rules, and `applyTemplate` puts a `MediaRequest` per media field on `MappedRecord.media`, keeping media fields out of `data`. `src/sources/media-fetch.ts` downloads one file through `guardedFetch` into one counted `Uint8Array` (header and total timeouts, a caller deadline, `Content-Length` refusal, conditional GET for `refresh`), sniffs magic bytes, and builds the filename. `src/emdash/media.ts` (`EmDashMedia`) is the only code that calls `handleMediaGet` and `handleMediaUpload`. The resolver (`resolveMedia`, `lookupRecordMedia`, `obtainRecordMedia` in `src/engine/media.ts`) checks the host, looks the map up (each item read once per batch through `LookupCache`), and on a real-run miss downloads, checks the type against the mapping kind and the field's `allowedMimeTypes`, uploads and writes the map row. In `processRecord` the order is: links, media lookups, entry read, a provisional plan in which each miss is a change, the pending-draft and lock checks, then the downloads, the final plan and the write. A download that would start less than 5 s before the batch's media deadline throws `MediaDeferred`, which ends the batch without advancing the cursor. `checkTemplate` refuses more than 5 media mappings and fields whose allowed types EmDash's upload never accepts; `createJob` stores `mediaMaxBytes` (the site's `maxUploadSize`, at most 5 MiB on Workers). The plugin declares `media:write` and a `media` storage collection, and on Workers caps media jobs at 10 records per `jobs/next`.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine, `astro/zod` in routes), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-27-flux-import-m4c-media-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 4 split). Previous plan: `docs/superpowers/plans/2026-10-27-flux-import-m4b-taxonomies-references.md`; its review: `docs/superpowers/notes/2026-10-27-m4b-review.md`.

Every code block in Tasks 1 to 9 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite, and the new workerd parity test on its own), then replayed task by task from `5421d60` (the spec commit; it changes only docs) by a script that applies this document's code blocks and replacements; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's Facts F1-F15 are cited as "spec F<n>".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. No new route and no new option. One new capability, `media:write` (spec F14); `definePlugin` adds `media:read` itself (Fact E1). One new storage collection, `media` (indexes `jobId`, `mediaId`).
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine's template schema uses `zod`; plugin route input schemas use `astro/zod`.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code. Media is stored only through `runtime.handleMediaUpload` and read only through `runtime.handleMediaGet`; never `ctx.media`, never `emdash.storage` directly (spec "Upload path"). The importer never deletes media. Media items have no locale; content calls keep passing the template's locale.
- Media is fetched only through `guardedFetch` (`src/sources/net.ts`), without credentials or custom headers, one file at a time.
- Vitest runs from `packages/flux-import` with name filters: `pnpm exec vitest run media-fetch` (from the repo root, `pnpm --filter flux-import exec vitest run tests/unit/x.test.ts` finds no files). Integration: `pnpm exec vitest run --config vitest.integration.config.ts media`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M4c media"`. The workerd harness uses port 4396 and the Node harness 4399 (plus 4394, 4395 and 4398 for the suites that start their own server): never run two copies of the same harness at once.
- Error codes, exactly: the new record codes are `invalid_media_url`, `alt_too_long`, `media_blocked`, `media_fetch_failed`, `media_http_error`, `media_too_large`, `media_type_not_allowed` and `media_upload_failed`, plus the new cases of `not_scalar`, `required` and the `emdash_` read codes; `media_config` is a job error. Template problems at job creation stay `invalid_template` (400) with one problem per field.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 8 also passes its integration file (about 30 s with server start) and `pnpm test:integration` (about 9 minutes), Task 9 the targeted workerd test (about 40 s); Task 10 runs everything, `pnpm test:cf` included (about 20 minutes).

## Review Focus

1. Nothing is downloaded or uploaded for a record that cannot be written: tests in Task 5 ("collects every lookup error and leaves empty fields null", "checks the host in every run, before the map", "refuses types before uploading…", "refuses a hit the field does not accept, without downloading") and Task 7 ("downloads nothing for a record with a lookup error, and reports every error", "downloads nothing for an entry that is locked or has someone else's draft", "plans a dry run without downloading…"), and Task 8 ("plans a dry run without a request…", "fails a record for a 404, a too-large file, HTML as an image, SVG and a refused type").
2. A re-run must plan `unchanged` and must not download: the map is keyed by the normalized URL, a hit is read once per batch, the diff compares only the media ID (a bare string counts) and the alt when mapped: Task 1 ("normalizes host case…", "is u and the SHA-256…"), Task 5 ("uses a hit with a ready item without downloading…"), Task 6 (all four), Task 7 ("…and re-runs unchanged") and Tasks 8 and 9.
3. The bytes decide the type: markup and SVG are refused under any header, `image/*` and PDF must be sniffed, a header is trusted only for unrecognized video and audio, the extension only when the header says nothing; the field's `allowedMimeTypes` and the mapping kind are checked before the upload: Task 3 ("sniffMime", "mediaTypeOf"), Task 5 ("refuses types before uploading…"), Task 8.
4. Size and time stay bounded: `Content-Length` over `mediaMaxBytes` is refused before the body, a longer stream is cut, headers wait 10 s, a download 30 s and never past the caller's deadline; a record whose next download would start within 5 s of the media deadline is deferred without advancing the cursor, but the batch's first download always starts: Task 3 ("refuses a Content-Length over the limit…", "times out…", "never runs past the caller's deadline"), Task 5 ("defers a download…", "charges the batch budget…"), Task 7 ("leaves a record whose next download is too late for the next batch…", "ends a batch after the record that spends the lookup budget"), Task 8 (the slow server) and Task 9 (the Workers cap).
5. EmDash failures map as the spec says: `CONFIGURATION_ERROR` and `NO_STORAGE` fail the job (`media_config`), `PAYLOAD_TOO_LARGE` and `INVALID_TYPE` map to `media_too_large` and `media_type_not_allowed`, anything else is `media_upload_failed` with EmDash's code: Task 4 ("throws EmDash's upload error code"), Task 5 ("maps EmDash's upload errors…"), Task 7 ("fails the job when EmDash cannot store media").
6. Jobs and templates without media must behave exactly as before (no map reads, no `mediaMaxBytes`, the Workers cap of 20 unless links are mapped): Task 1 ("lists alt paths, and leaves templates without media as before"), Task 2 ("stores the media size limit only for templates that map media"), Task 7 ("leaves templates without media as before", `workersBatchCap`).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V5 are the facts the spec left unconfirmed; all five were proven while drafting, and Task 0 re-checks V1-V4 on Node before any code is written.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | `runtime.handleMediaUpload` works from the native plugin route on Node (local storage) and on workerd (R2, so the handler's `node:path` import loads under `nodejs_compat`). A 2,896 × 2,896 JPEG (10,419,849 bytes) was stored `ready` as `image/jpeg` with `width`, `height` and a `blurhash`, and its library alt was the `alt` sent. A second upload of the same bytes under another filename returned `deduplicated: true` with the same item, and `handleMediaGet` read it back `ready`. The item's `id` and the ULID in its `storageKey` are different values. | drafting probe route on `sites/dev` and `sites/dev-cf`; Task 0 re-checks it on Node with a small JPEG; Tasks 8 and 9 use it |
| V2 | `runtime.config.maxUploadSize` is readable from the route on both runtimes and is `undefined` when the site does not set it. With `emdash({ maxUploadSize: 100000 })` it reads `100000`, and EmDash's own refusal names that limit. | drafting probe on Node and workerd; Task 0; Task 8 (the server runs with `FLUX_DEV_MAX_UPLOAD_SIZE=100000`) |
| V3 | A content create with the importer's full image value (with `alt`) reads back from `handleContentGet` as the same object with `alt` kept; a `caption` key is dropped (spec F7). A file value with `size` reads back **without** `size`: a file has no `width`, so EmDash's normalizer asks the provider and rebuilds the value, adding `meta.caption`, `meta.blurhash` and `meta.dominantColor` (all `null`) and the library `alt`. | drafting probe on Node and workerd; Task 0 |
| V4 | A field with `allowedMimeTypes: ["image/png"]` refuses a JPEG item on save with `INVALID_MIME_FOR_FIELD` ("Field 'pngonly' does not accept image/jpeg"), on both runtimes. | drafting probe; Task 0 |
| V5 | Memory. workerd took the 10 MiB JPEG through download, base64 and upload without error (it exposes no memory API). On Node the route's sampled `heapUsed + arrayBuffers` rose about 35 MB; a standalone script measuring peak RSS for the same steps found 398 MiB for the 10 MiB / 8.4-megapixel JPEG: about 53 MiB for the buffers (download, base64, decode: about 5 times the file) and about 370 MiB in EmDash's placeholder decode (`jpeg-js`), which scales with pixels, not bytes (4.1 MB / 4.2 Mpx: 213 MiB; 0.5 MB / 1 Mpx: 40 MiB). That is over the spec's 100 MB threshold, so the Workers cap is **5 MiB** (`WORKERS_MEDIA_MAX_BYTES`). | drafting probe and a peak-RSS script over `emdash/dist/enrich-*.mjs`; Tasks 2 and 9 |
| E1 | `definePlugin` adds `media:read` when `media:write` is declared (implied capabilities, `src/plugins/types.ts:89`), after the `taxonomies:read` it already adds, so the resolved list ends `…, "media:write", "taxonomies:read", "media:read"`. | `definition.test.ts` (Task 7) |
| E2 | Every flux-import route already fails with `NOT_CONFIGURED` (500) "EmDash storage is not configured" when `runtime.storage` is missing (`withServices` in `src/plugin/routes.ts`, since M2), so `jobs/create` needs no new check for the spec's storage rule. | source reading |
| E3 | A field created through `POST /_emdash/api/schema/collections/:c/fields` with `{ type: "file", validation: { allowedMimeTypes: [...] } }` keeps the list on `validation.allowedMimeTypes`, and `GET /_emdash/api/media/file/<storageKey>` serves the stored bytes with the type of the key's extension (spec F11). | drafting runs of Tasks 8 and 9 |
| E4 | EmDash's placeholder decode (`src/media/placeholder.ts`) is bounded by the pixel count (width × height × 4 ≤ 32 MiB), not by the byte limit, and its peak memory is about 3 times that bound (V5). This holds for admin uploads too; the importer cannot lower it, only the file size. | V5 measurements; spec F9 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition. Known since M3c; not caused by this plan. A step back during Task 8's slow download can likewise let the next download start, so "leaves a record whose next download is too late…" reads `seq: 1`; the test keeps 2.5 s of slack (an 18 s download against a 20.5 s media deadline), and a re-run settles it. While drafting, that test failed this way in 2 of 3 full runs with a 16 s download (0.5 s of slack) and never alone. | M3c-M4b plans |

## Rulings this plan makes

- **Where the code lives.** `src/engine/media.ts` holds the pure part (limits, `MediaRequest`, URL normalization, `mediaMapKey`, converters, MIME rules; Task 1) and the resolver (Task 5). `src/sources/media-fetch.ts` holds the download, sniffing and filenames. `src/emdash/media.ts` is the only code that touches the runtime's media handlers. `mediaMapKey` uses `node:crypto`'s synchronous SHA-256, which `nodejs_compat` provides on workerd.
- **Template.** `image` and `file` are `fields` mappings with `from` or `expr`, an optional `refresh` and, for `image` only, `alt` (`{ from }` or `{ expr }`); `alt` on a `file` mapping is a schema error. An empty URL gives `null` (the field is cleared) and its alt is not read; a URL error is reported under the field and an alt error under `<field>.alt`. More than 5 media mappings is a `checkTemplate` problem ("The template maps 6 image and file fields; at most 5 are allowed"), not a schema error, so `jobs/create` lists it with the other problems.
- **Schema checks.** `rulesOf` keeps `allowedMimeTypes` only when it is a non-empty list of strings. A field whose list shares nothing with the upload allowlist (for its kind) is `Field "photo": EmDash's upload refuses every type this field accepts (image/svg+xml)`. `mediaMaxBytes` falls back to EmDash's 50 MiB default for an unset or invalid `maxUploadSize`; EmDash then refuses an invalid setting on the first upload, which fails the job with `media_config`.
- **Field values.** Images: `{ id, provider: "local", filename, mimeType, width?, height?, blurhash?, dominantColor?, alt?, meta: { storageKey } }`. Files: the same without the image keys and **without `size`**, because EmDash drops it on save (Fact V3). The diff compares only `id` (and `alt` when mapped and not empty), so what EmDash adds or drops never makes a re-run change.
- **Resolver contract for M4d.** `resolveMedia(deps, cache, ctx, field, request)` takes a `MediaContext` (`jobId`, `dryRun`, `maxBytes`, the target fields) besides the spec's `(deps, cache, request)`: the type checks need the field and the map row needs the job. It shares `LookupCache` (map hits, items read, downloads this batch, `mediaDeadline`) and the Workers budget.
- **Order inside a record.** Link resolution runs first, then the map lookups for every media field; all errors of both are collected. As in M4b, terms may be created by the link step before a media lookup fails the record. Downloads run one field at a time and stop at the first failure; each successful download is listed in `newMedia` (`photo: <url>`) even when the upload deduplicated, also on a record that then fails. A record deferred after one of its downloads does not list that download when it is processed again (the URL is then a map hit).
- **Provisional plan.** In a real run a miss and a `refresh` hit both count as a change in the provisional plan, so a locked entry or one with someone else's draft reports `locked` or `conflict` before any request, even when a later 304 would have left it `unchanged`. A dry run lists only misses in `newMedia`, never `refresh` hits. The map row of a missing or not-ready item is deleted only in real runs; a dry run just plans the URL as new.
- **Errors.** Type errors name the resolved type and, when it helps, the URL (the URL is in `newMedia` too). `media_config` is added to the job error codes. A `ContentWriteError` from `handleMediaGet` fails the record with its `emdash_` code.
- **Time and budget.** `MEDIA_GRACE_MS` is 20 s, so `mediaDeadline = started + budgetMs + 20 s`, within the 30 s lease grace. Before each download the time left must be at least `MEDIA_MIN_LEFT_MS` (5 s) unless it is the batch's first download, whose deadline is then `max(mediaDeadline, now + 5 s)`. On Workers a download costs `COST_MEDIA` (60), a map lookup `COST_CALL` (a hit one more for `handleMediaGet`), and `workersBatchCap` is 10 for templates that map links or media.
- **Fetcher.** `GuardedRequest` gains an optional `onRequest` hook, which the media fetcher uses to start the header timer per hop; `fetcher.ts` exports `bodyLength` for the `Content-Length` rule. A 304 is a success only for a conditional request. Filenames drop an extension of 1 to 10 alphanumeric characters before the canonical one is added (`.bin` for a type without one).
- **Workers size cap.** 5 MiB (Fact V5), not the spec's 10 MiB. The spec's "32 MiB of decoded pixels" underestimates the placeholder decode by about 3 times (Fact E4); this does not change the design, because the spec already set the 5 MiB branch.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (137 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 48 files / 1,196 tests pass (43 / 1,124 at `5421d60`) |
| Task 0 probe | the Task 0 probe passes on a clean `5421d60` checkout (1 test; vitest reports 7.6 s, plus the shared server's start), and Step 3 leaves the tree clean; the 10 MiB variant used while drafting passed on Node and on workerd |
| Task-by-task replay | Tasks 1-9 applied in numeric order from `5421d60` with no failed replacement; each Step 2 failed and each Step 4 passed with the counts given in the task; typecheck, lint and `pnpm test` passed after every task; the result is identical to the drafting tree |
| `pnpm test:integration` | 12 files / 65 tests pass in 549.5 s on the replayed tree (11 / 59 at `5421d60`); the new `media.test.ts` alone: 6 tests, 30.4 s with server start. With an earlier 16 s slow download, the deferral test failed in 2 of 3 full runs (Fact F1); the 18 s version below passed |
| `vitest run --config vitest.cf.config.ts -t "M4c media"` | the new parity test passes (1 passed, 9 skipped; 11.1 s test, 37.2 s with server start); the rest of `pnpm test:cf` was not re-run |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/media.ts` (new) | Limits, `MediaRequest`, `normalizeMediaUrl`, `mediaMapKey`, `mediaUrlConverter`, `altConverter`, MIME rules (Task 1); `MediaContext`, `MediaDeferred`, `findMedia`, `obtainMedia`, `resolveMedia`, `lookupRecordMedia`, `obtainRecordMedia`, `mediaFieldValue` (Task 5) |
| `src/sources/media-fetch.ts` (new) | `MediaError`, `MEDIA_LIMITS`, `createMediaFetcher` (guarded, counted, timed download; conditional GET), `sniffMime`, `looksLikeMarkup`, `mediaTypeOf`, `mediaFilename` |
| `src/emdash/media.ts` (new) | `EmDashMedia`: `MediaPort` over `handleMediaGet` and `handleMediaUpload` |
| `src/engine/template.ts` | `image` and `file` mappings, `MappedRecord.media`, media checks in `checkTemplate`, `usesMedia` |
| `src/engine/values.ts`, `src/emdash/schema.ts` | `TargetField.allowedMimeTypes` and its snapshot |
| `src/engine/ports.ts`, `src/engine/types.ts` | `MediaPort`, `MediaInfo`, `MediaUploadError`; `MediaMapRow`, `EngineDeps.mediaMap`/`media`/`mediaFetcher`, `Job.mediaMaxBytes`, `RecordRow.newMedia` |
| `src/engine/resolve.ts` | `COST_MEDIA`; `LookupCache.mediaItems`, `mediaDownloads`, `mediaDeadline` |
| `src/engine/diff.ts` | `MediaPlanItem`; media changes in `planRecord` |
| `src/engine/jobs.ts`, `src/engine/batch.ts` | `mediaMaxBytes` at job creation; media lookups, provisional plan, downloads, deferral and `newMedia` per record |
| `src/sources/net.ts`, `src/sources/fetcher.ts` | `GuardedRequest.onRequest`; `bodyLength` exported |
| `src/emdash/storage.ts`, `src/plugin/definition.ts`, `src/plugin/routes.ts`, `src/plugin/service.ts`, `src/plugin/schema-apply.ts` | The `media` collection; `media:write`; `EmDashMedia` and fetcher wiring and `mediaMaxBytes` at job creation; the Workers cap and size cap; `image` and `file` in `schema/apply` |
| `tests/unit/fakes.ts`, `tests/fixtures/media.ts` (new), `tests/integration/{feed-server,server,media.test}.ts`, `tests/integration-cf/parity.test.ts`, `sites/dev/astro.config.mjs` | Fakes; Node and workerd proofs; the dev site's upload limit from `FLUX_DEV_MAX_UPLOAD_SIZE` |

The source readers, `src/engine/links.ts`, `src/emdash/content.ts`, `src/emdash/lookups.ts`, `src/plugin/sources.ts` and `src/plugin/xlsx.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V4 | — | nothing committed (a temporary route and test, reverted) | sonnet |
| 1. Media mappings and conversion | 0 | `src/engine/{media,template}.ts`, `src/plugin/schema-apply.ts`, `tests/unit/{media,schema-apply,definition}.test.ts` | sonnet |
| 3. Download, sniffing and filenames | 0 | `src/sources/{media-fetch,net,fetcher}.ts`, `tests/unit/media-fetch.test.ts` | sonnet |
| 2. Schema checks and the job's size limit | 1 (`MAX_MEDIA_MAPPINGS`, `acceptsUploadable`, `usesMedia`, `DEFAULT_MAX_UPLOAD_SIZE`) | `src/engine/{template,types,values,jobs}.ts`, `src/emdash/schema.ts`, `src/plugin/service.ts`, `tests/unit/{template,schema,jobs,service}.test.ts` | sonnet |
| 6. Media in the record plan | 1 (`JsonValue` export) | `src/engine/diff.ts`, `tests/unit/diff.test.ts` | sonnet |
| 4. Media port and media map | 3 (`MediaFetcher`) | `src/engine/{ports,types}.ts`, `src/emdash/{media,storage}.ts`, `src/plugin/{definition,routes}.ts`, `tests/unit/{media-port,storage,definition}.test.ts`, `tests/unit/fakes.ts` | sonnet |
| 5. Resolver | 1, 2 (`TargetField.allowedMimeTypes`), 3, 4 (`MediaPort`, `MediaMapRow`, fakes) | `src/engine/{media,resolve}.ts`, `tests/unit/media-resolve.test.ts` | opus |
| 7. Batch integration | 2, 5, 6 | `src/engine/{batch,types}.ts`, `src/plugin/{definition,routes,service}.ts`, `tests/unit/{media-import,definition,service}.test.ts` | opus |
| 8. Node integration | 7 | `tests/fixtures/media.ts`, `tests/integration/{feed-server,server,media.test}.ts`, `sites/dev/astro.config.mjs` | sonnet |
| 9. workerd parity | 8 (`tests/fixtures/media.ts`) | `tests/integration-cf/parity.test.ts` | sonnet |
| 10. Review run and note | 1-9 | `docs/superpowers/notes/2026-10-27-m4c-review.md`, the roadmap | opus |

Waves: **0**, then **1 ∥ 3**, then **2 ∥ 6**, then **4**, then **5**, then **7**, then **8**, then **9** (it imports Task 8's fixture), then **10**. No two tasks of one wave touch the same file: `template.ts` is touched by Tasks 1 and 2, `types.ts` by 2, 4 and 7, `definition.ts`, `routes.ts` and `definition.test.ts` by 1, 4 and 7 (the test) or 4 and 7, `service.ts` and `service.test.ts` by 2 and 7, `media.ts` by 1 and 5, always in different waves. Task 4 waits for Task 2 only because both edit `types.ts` (`Job` and `EngineDeps`); it can run beside Task 2 if the implementer merges that file by hand. Pass counts in each task's "Run them to see them pass" step are for the task's own test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the unconfirmed EmDash facts (V1-V4)

**Files:**
- Temporary (never committed): `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/integration/probe.test.ts`

**Interfaces:**
- Consumes: `runtime.handleMediaUpload`, `handleMediaGet`, `handleContentCreate`, `handleContentGet`, `runtime.config.maxUploadSize`; the integration harness and `FeedServer`.
- Produces: a yes or no for V1-V4, recorded in the Task 10 note. No code. V5 is a measurement made while drafting (see Facts); Task 9 checks the resulting 5 MiB cap on workerd.

**Stop rule:** if any check below fails, stop, revert the probe, and report which check failed with its output. Do not start Task 1: the upload path (Tasks 4 and 5), the size limit (Task 2), the stored values and the diff (Tasks 5 and 6) and the type pre-check (Task 5) rely on these facts.

- [ ] **Step 1: Add the probe**

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
		withServices(ctx, ({ runtime }) => applySchema(runtime.schemaRegistry, ctx.input)),
	),
};
```
with:
```ts
		withServices(ctx, ({ runtime }) => applySchema(runtime.schemaRegistry, ctx.input)),
	),

	// Temporary probe for Facts V1-V4; removed in Step 3.
	"probe/m4c": route(
		z.object({ jpeg: z.string(), pdf: z.string(), collection: z.string() }),
		(ctx) =>
			withServices(ctx, async ({ runtime, actor }) => {
				const maxUploadSize = runtime.config.maxUploadSize;
				const load = async (url: string) => {
					const response = await fetch(url);
					return new Uint8Array(await response.arrayBuffer());
				};
				const upload = (bytes: Uint8Array, filename: string, contentType: string) =>
					runtime.handleMediaUpload({
						filename,
						base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
							"base64",
						),
						contentType,
						alt: "Library alt",
						authorId: actor.id,
						maxUploadSize: maxUploadSize ?? 50 * 1024 * 1024,
					});
				const jpeg = await load(ctx.input.jpeg);
				const first = await upload(jpeg, "photo.jpg", "image/jpeg");
				const again = await upload(jpeg, "other.jpg", "image/jpeg");
				const pdf = await upload(await load(ctx.input.pdf), "manual.pdf", "application/pdf");
				if (!first.success || !again.success || !pdf.success) {
					return { error: [first, again, pdf].map((r) => (r.success ? null : r.error)) };
				}
				const image = first.data.item;
				const file = pdf.data.item;
				const got = await runtime.handleMediaGet(image.id);
				const imageValue = {
					id: image.id,
					provider: "local",
					filename: image.filename,
					mimeType: image.mimeType,
					...(image.width === null ? {} : { width: image.width }),
					...(image.height === null ? {} : { height: image.height }),
					...(image.blurhash === null ? {} : { blurhash: image.blurhash }),
					...(image.dominantColor === null ? {} : { dominantColor: image.dominantColor }),
					alt: "Per-use alt",
					caption: "Per-use caption",
					meta: { storageKey: image.storageKey },
				};
				const fileValue = {
					id: file.id,
					provider: "local",
					filename: file.filename,
					mimeType: file.mimeType,
					size: file.size,
					meta: { storageKey: file.storageKey },
				};
				const created = await runtime.handleContentCreate(ctx.input.collection, {
					data: { title: "Probe", photo: imageValue, manual: fileValue },
					locale: "en",
					actor,
				});
				const id = created.success
					? ((created.data as { item: { id: string } }).item.id as string)
					: null;
				const read = id ? await runtime.handleContentGet(ctx.input.collection, id, "en") : null;
				const refused = await runtime.handleContentCreate(ctx.input.collection, {
					data: { title: "Refused", pngonly: imageValue },
					locale: "en",
					actor,
				});
				return {
					v1: {
						item: {
							id: image.id,
							status: image.status,
							mimeType: image.mimeType,
							width: image.width,
							height: image.height,
							blurhash: image.blurhash !== null,
							alt: image.alt,
						},
						deduplicated: first.data.deduplicated ?? false,
						again: { id: again.data.item.id, deduplicated: again.data.deduplicated ?? false },
						get: got.success ? { status: got.data.item.status, id: got.data.item.id } : got.error,
					},
					v2: { maxUploadSize: maxUploadSize ?? null, type: typeof maxUploadSize },
					v3: {
						created: created.success ? true : created.error,
						sent: { photo: imageValue, manual: fileValue },
						read: read?.success
							? (read.data as { item: { data: Record<string, unknown> } }).item.data
							: read?.error,
					},
					v4: refused.success ? { refused: false } : { refused: true, error: refused.error },
				};
			}),
	),
};
```

Create `packages/flux-import/tests/integration/probe.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";
import { FeedServer } from "./feed-server.js";

// A 4 x 3 JPEG and a minimal PDF.
const JPEG = new Uint8Array(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCeiiivkD8qP//Z",
		"base64",
	),
);
const PDF = new TextEncoder().encode(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

type Probe = {
	v1: {
		item: Record<string, unknown>;
		deduplicated: boolean;
		again: { id: string; deduplicated: boolean };
		get: { status: string; id: string };
	};
	v2: { maxUploadSize: number | null; type: string };
	v3: {
		created: unknown;
		sent: Record<string, Record<string, unknown>>;
		read: Record<string, Record<string, unknown>>;
	};
	v4: { refused: boolean; error?: { code: string; message: string } };
};

describe("M4c probe (temporary)", () => {
	it("uploads through handleMediaUpload, dedupes, and reads image and file values back", async () => {
		const client = new Client(inject("baseUrl"), inject("token"));
		const feeds = new FeedServer();
		await feeds.start();
		try {
			feeds.feeds.set("/photo.jpg", { body: JPEG });
			feeds.feeds.set("/manual.pdf", { body: PDF });
			await client.createCollection("probe_media");
			for (const field of [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "photo", label: "Photo", type: "image" },
				{ slug: "manual", label: "Manual", type: "file" },
				{
					slug: "pngonly",
					label: "PNG only",
					type: "image",
					validation: { allowedMimeTypes: ["image/png"] },
				},
			]) {
				await client.api("POST", "/_emdash/api/schema/collections/probe_media/fields", field);
			}
			const probe = await client.plugin<Probe>("probe/m4c", {
				jpeg: feeds.url("/photo.jpg"),
				pdf: feeds.url("/manual.pdf"),
				collection: "probe_media",
			});
			console.log(JSON.stringify(probe, null, 2));
			// V1: stored, enriched, deduplicated on the second upload, and readable.
			expect(probe.v1.item).toMatchObject({
				status: "ready",
				mimeType: "image/jpeg",
				width: 4,
				height: 3,
				blurhash: true,
				alt: "Library alt",
			});
			expect(probe.v1.deduplicated).toBe(false);
			expect(probe.v1.again).toEqual({ id: probe.v1.item.id, deduplicated: true });
			expect(probe.v1.get).toEqual({ status: "ready", id: probe.v1.item.id });
			// V2: readable, unset on the shared dev server.
			expect(probe.v2).toEqual({ maxUploadSize: null, type: "undefined" });
			// V3: the image value reads back as sent without caption; the file value without size.
			expect(probe.v3.created).toBe(true);
			const { caption, ...photo } = probe.v3.sent.photo ?? {};
			expect(caption).toBe("Per-use caption");
			expect(probe.v3.read.photo).toEqual(photo);
			const { size, ...manual } = probe.v3.sent.manual ?? {};
			expect(size).toEqual(expect.any(Number));
			expect(probe.v3.read.manual).toMatchObject(manual);
			expect(probe.v3.read.manual).not.toHaveProperty("size");
			// V4: the field's allowed types are enforced on save.
			expect(probe.v4).toMatchObject({
				refused: true,
				error: { code: "INVALID_MIME_FOR_FIELD" },
			});
		} finally {
			await feeds.stop();
		}
	});
});
```

- [ ] **Step 2: Run the probe**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts probe`
Expected: PASS (1 test, a few seconds after the shared server starts). It shows that `handleMediaUpload` stores, enriches and dedupes from a native route (V1), that `runtime.config.maxUploadSize` is readable and unset (V2), that an image value reads back as sent minus `caption` and a file value minus `size` (V3), and that `allowedMimeTypes` is enforced on save with `INVALID_MIME_FOR_FIELD` (V4).

- [ ] **Step 3: Remove the probe**

Run: `git checkout packages/flux-import/src/plugin/routes.ts && rm packages/flux-import/tests/integration/probe.test.ts && git status --short`
Expected: a clean tree (the integration harness restores `sites/dev/emdash-env.d.ts` itself). Record the result of Step 2 for the Task 10 note.

### Task 1: Media mappings and conversion

**Files:**
- Create: `packages/flux-import/src/engine/media.ts`
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/plugin/schema-apply.ts`
- Test: `packages/flux-import/tests/unit/media.test.ts` (new), `packages/flux-import/tests/unit/schema-apply.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: M3c `parseSourceUrl` (`src/sources/net.ts`); M4a `values.ts` (`NOT_SCALAR_MESSAGE`, `checkRules`); `template.ts` (`compileTemplate`, `applyTemplate`, `fieldConverter`, `COMPATIBLE`); `schema-apply.ts` (`APPLY_FIELD_TYPES`).
- Produces:
  - `src/engine/media.ts`: `MAX_MEDIA_MAPPINGS` (5), `MAX_ALT_LENGTH` (1,000), `DEFAULT_MAX_UPLOAD_SIZE` (50 MiB), `UPLOAD_ALLOWLIST`; `type MediaKind = "image" | "file"`; `type MediaConversionCode`; `type MediaRequest = { kind; url; alt: string | null; refresh: boolean }`; `normalizeMime`, `matchesMime(mime, list)`, `acceptsUploadable(allowed, kind)`, `mediaTypeProblem(mime, kind, allowed)`, `normalizeMediaUrl(raw)`, `mediaMapKey(url)` (`u` + SHA-256 hex), `mediaUrlConverter(raw)`, `altConverter(raw)`.
  - `src/engine/template.ts`: the `image` and `file` field mappings (`alt` on images, `refresh`); `MappedRecord.media?: Record<string, MediaRequest | null>`; `CompiledTemplate.media`; `templatePaths` lists `alt.from`; `COMPATIBLE.image = ["image"]`, `COMPATIBLE.file = ["file"]`; `usesMedia(t)`; `JsonValue` and `MediaRequest` re-exported.
  - `src/plugin/schema-apply.ts`: `image` and `file` in `APPLY_FIELD_TYPES`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/media.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	acceptsUploadable,
	altConverter,
	matchesMime,
	mediaMapKey,
	mediaTypeProblem,
	mediaUrlConverter,
	normalizeMediaUrl,
} from "../../src/engine/media.js";
import {
	applyTemplate,
	type CompileContext,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
	usesMedia,
} from "../../src/engine/template.js";

const err = (code: string) => expect.objectContaining({ ok: false, code });

function compiled(fields: Record<string, unknown>, context: CompileContext = {}) {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields,
	}) as Template;
	const result = compileTemplate(t, context);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

describe("normalizeMediaUrl", () => {
	it("normalizes host case, default ports and percent-encoding, drops the fragment, keeps the query", () => {
		expect(
			normalizeMediaUrl("HTTPS://CDN.Example.com:443/a/../b%7e/Photo.JPG?w=1&W=2#top"),
		).toEqual({ ok: true, url: "https://cdn.example.com/b%7e/Photo.JPG?w=1&W=2" });
		expect(normalizeMediaUrl("http://example.com:80")).toEqual({
			ok: true,
			url: "http://example.com/",
		});
		expect(normalizeMediaUrl("http://example.com:8080/x y")).toEqual({
			ok: true,
			url: "http://example.com:8080/x%20y",
		});
	});

	it("refuses relative, data:, userinfo and overlong URLs", () => {
		expect(normalizeMediaUrl("/images/a.png")).toEqual({
			ok: false,
			message: "The URL is not valid",
		});
		expect(normalizeMediaUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
			ok: false,
			message: 'The URL scheme "data:" is not allowed; use http or https',
		});
		expect(normalizeMediaUrl("https://user:pw@example.com/a.png")).toEqual({
			ok: false,
			message: "URLs cannot contain a user name or password; use a credential",
		});
		expect(normalizeMediaUrl(`https://example.com/${"a".repeat(2048)}`)).toEqual({
			ok: false,
			message: "URLs are limited to 2048 characters",
		});
	});
});

describe("mediaMapKey", () => {
	it("is u and the SHA-256 of the normalized URL, stable and distinct", () => {
		const key = mediaMapKey("https://cdn.example.com/a.png");
		expect(key).toBe("u6155f67efa620e76fd5fb2c42f3676aec9cba0ee554f6ad1f33773ff1d26f587");
		expect(mediaMapKey("https://cdn.example.com/a.png")).toBe(key);
		expect(mediaMapKey("https://cdn.example.com/A.png")).not.toBe(key);
	});
});

describe("mediaUrlConverter and altConverter", () => {
	it("gives null for a missing, null or blank URL, and trims", () => {
		expect(mediaUrlConverter(undefined)).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter(null)).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter("  ")).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter(" https://x.test/a.png ")).toEqual({
			ok: true,
			value: "https://x.test/a.png",
		});
	});

	it("refuses numbers, booleans, objects and arrays as URLs", () => {
		expect(mediaUrlConverter(42)).toEqual({
			ok: false,
			code: "not_scalar",
			message: "Expected a URL as text, found a number",
		});
		expect(mediaUrlConverter(true)).toEqual(err("not_scalar"));
		expect(mediaUrlConverter({ url: "x" })).toEqual(err("not_scalar"));
		expect(mediaUrlConverter(["https://x.test/a.png"])).toEqual({
			ok: false,
			code: "not_scalar",
			message: "Expected a URL as text, found an array",
		});
		expect(mediaUrlConverter("ftp://x.test/a.png")).toEqual(err("invalid_media_url"));
	});

	it("reads alt text from scalars, trimmed, with empty as none and a 1,000-character limit", () => {
		expect(altConverter(" A red chair ")).toEqual({ ok: true, value: "A red chair" });
		expect(altConverter(7)).toEqual({ ok: true, value: "7" });
		expect(altConverter("   ")).toEqual({ ok: true, value: null });
		expect(altConverter(null)).toEqual({ ok: true, value: null });
		expect(altConverter("a".repeat(1000))).toEqual({ ok: true, value: "a".repeat(1000) });
		expect(altConverter("a".repeat(1001))).toEqual({
			ok: false,
			code: "alt_too_long",
			message: "The alt text has 1001 characters; at most 1000 are allowed",
		});
		expect(altConverter({ a: 1 })).toEqual(err("not_scalar"));
	});
});

describe("media type rules", () => {
	it("matches MIME types and prefixes as EmDash does", () => {
		expect(matchesMime("image/PNG; charset=x", ["image/png"])).toBe(true);
		expect(matchesMime("video/mp4", ["video/"])).toBe(true);
		expect(matchesMime("image/png", [".png", "image/"])).toBe(true);
		expect(matchesMime("image/png", [".png"])).toBe(false);
	});

	it("knows whether a field accepts anything EmDash's upload allows", () => {
		expect(acceptsUploadable(["image/svg+xml"], "image")).toBe(false);
		expect(acceptsUploadable([".png"], "image")).toBe(false);
		expect(acceptsUploadable(["image/svg+xml", "image/png"], "image")).toBe(true);
		expect(acceptsUploadable(["image/"], "image")).toBe(true);
		expect(acceptsUploadable(["video/mp4"], "file")).toBe(true);
		expect(acceptsUploadable(["application/pdf"], "image")).toBe(false);
		expect(acceptsUploadable(["application/zip"], "file")).toBe(false);
	});

	it("explains why a type cannot go into a field", () => {
		expect(mediaTypeProblem("image/png", "image", undefined)).toBeNull();
		expect(mediaTypeProblem("image/svg+xml", "image", ["image/svg+xml"])).toBe(
			"EmDash does not accept image/svg+xml uploads",
		);
		expect(mediaTypeProblem("application/pdf", "image", undefined)).toBe(
			"An image field cannot take application/pdf",
		);
		expect(mediaTypeProblem("application/pdf", "file", ["image/png"])).toBe(
			"The field accepts only image/png, not application/pdf",
		);
		expect(mediaTypeProblem("video/mp4", "file", [])).toBeNull();
	});
});

describe("image and file mappings", () => {
	it("parses image and file mappings with alt and refresh, and refuses alt on a file", () => {
		const fields = {
			photo: { from: "Img", type: "image", alt: { from: "Alt" }, refresh: true },
			manual: { expr: "'https://x.test/' & sku & '.pdf'", type: "file" },
		};
		expect(compiled(fields).media).toEqual(
			new Map([
				["photo", { kind: "image", refresh: true, alt: { from: "Alt", expr: null } }],
				["manual", { kind: "file", refresh: false, alt: null }],
			]),
		);
		const parse = (f: Record<string, unknown>) =>
			templateSchema.safeParse({
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { f },
			}).success;
		expect(parse({ from: "U", type: "file", alt: { from: "A" } })).toBe(false);
		expect(parse({ from: "U", type: "image", alt: { from: "A", expr: "x" } })).toBe(false);
		expect(parse({ from: "U", type: "image", alt: {} })).toBe(false);
		expect(parse({ from: "U", type: "image", refresh: "yes" })).toBe(false);
	});

	it("reports an alt expression that does not compile under its field", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { photo: { from: "Img", type: "image", alt: { expr: "(" } } },
		});
		const result = compileTemplate(t);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems[0]).toMatch(/^fields\.photo\.alt\.expr: /);
	});

	it("maps URLs and alt text into media requests, kept out of data", async () => {
		const c = compiled({
			title: { from: "Name", type: "text" },
			photo: { from: "Img", type: "image", alt: { expr: "'Photo of ' & Name" } },
			manual: { from: "Pdf", type: "file", refresh: true },
		});
		const result = await applyTemplate(c, {
			sku: "A1",
			Name: "Chair",
			Img: " https://CDN.test/chair.png#x ",
			Pdf: "https://cdn.test/a1.pdf",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: { title: "Chair" },
				media: {
					photo: {
						kind: "image",
						url: "https://cdn.test/chair.png",
						alt: "Photo of Chair",
						refresh: false,
					},
					manual: { kind: "file", url: "https://cdn.test/a1.pdf", alt: null, refresh: true },
				},
			},
		});
	});

	it("gives null for an empty URL without reading its alt, and fails a required one", async () => {
		const c = compiled(
			{
				photo: { from: "Img", type: "image", alt: { expr: "$number('not a number')" } },
				manual: { from: "Pdf", type: "file" },
			},
			{
				targets: {
					photo: { type: "image", required: false },
					manual: { type: "file", required: true },
				},
			},
		);
		expect(await applyTemplate(c, { sku: "A1", Img: "", Pdf: "https://x.test/a.pdf" })).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: {},
				media: {
					photo: null,
					manual: { kind: "file", url: "https://x.test/a.pdf", alt: null, refresh: false },
				},
			},
		});
		expect(await applyTemplate(c, { sku: "A1", Img: "", Pdf: " " })).toEqual({
			ok: false,
			errors: [{ field: "manual", code: "required", message: "The field is required" }],
		});
	});

	it("reports URL and alt errors under the field and its alt", async () => {
		const c = compiled({
			photo: { from: "Img", type: "image", alt: { from: "Alt" } },
			icon: { from: "Icon", type: "image" },
		});
		expect(
			await applyTemplate(c, {
				sku: "A1",
				Img: "https://x.test/a.png",
				Alt: "a".repeat(1001),
				Icon: "icons/a.png",
			}),
		).toEqual({
			ok: false,
			errors: [
				{
					field: "photo.alt",
					code: "alt_too_long",
					message: "The alt text has 1001 characters; at most 1000 are allowed",
				},
				{ field: "icon", code: "invalid_media_url", message: "The URL is not valid" },
			],
		});
	});

	it("lists alt paths, and leaves templates without media as before", async () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "Name", type: "text" },
				photo: { from: "Img", type: "image", alt: { from: "Name" } },
				thumb: { from: "Thumb", type: "image", alt: { from: "ThumbAlt" } },
			},
		});
		expect(templatePaths(t)).toEqual(["sku", "Name", "Img", "Thumb", "ThumbAlt"]);
		expect(usesMedia(t)).toBe(true);
		const plain = compiled({ title: { from: "Name", type: "text" } });
		expect(plain.media.size).toBe(0);
		expect(await applyTemplate(plain, { sku: "A1", Name: "x" })).toEqual({
			ok: true,
			value: { key: "A1", data: { title: "x" } },
		});
		expect(usesMedia(plain.template)).toBe(false);
	});
});
```

In `packages/flux-import/tests/unit/schema-apply.test.ts`, replace
```ts
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
```
with:
```ts
	});
});

describe("template media", () => {
	it("creates image and file fields without allowed types, and keeps existing ones", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "photo", type: "image" },
			{ slug: "cover", type: "string" },
		]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				photo: { from: "P", type: "image", alt: { from: "A" } },
				cover: { from: "C", type: "image" },
				manual: { from: "M", type: "file" },
				thumb: { from: "T", type: "image" },
			},
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{ field: "photo", action: "unchanged", type: "image" },
			{
				field: "cover",
				action: "conflict",
				type: "image",
				message: 'Field "cover" is "string"; requested "image"',
			},
			{ field: "manual", action: "create", type: "file" },
			{ field: "thumb", action: "create", type: "image" },
		]);
		expect(registry.calls).toEqual([
			'create:manual:{"slug":"manual","label":"Manual","type":"file","indexed":false,"searchable":false,"translatable":true}',
			'create:thumb:{"slug":"thumb","label":"Thumb","type":"image","indexed":false,"searchable":false,"translatable":true}',
		]);
	});

	it("refuses to index image and file fields", () => {
		expect(requestProblems([{ slug: "photo", type: "image", indexed: true }])).toEqual([
			'Field "photo": image fields cannot be indexed',
		]);
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
				apply.safeParse({ collection: "products", fields: [{ ...field, ...extra }] }).success,
			).toBe(false);
		}
		for (const type of ["portableText", "image", "file", "reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
		}
		expect(apply.safeParse({ collection: "products", fields: [field], extra: 1 }).success).toBe(
			false,
```
with:
```ts
				apply.safeParse({ collection: "products", fields: [{ ...field, ...extra }] }).success,
			).toBe(false);
		}
		for (const type of ["portableText", "reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
		}
		for (const type of ["image", "file"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(true);
		}
		expect(apply.safeParse({ collection: "products", fields: [field], extra: 1 }).success).toBe(
			false,
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/media.test.ts schema-apply definition`
Expected: FAIL: `media.test.ts` does not load (`Cannot find module '../../src/engine/media.js'`); `schema-apply.test.ts` fails 1 of 23 ("creates image and file fields without allowed types, and keeps existing ones": the template refuses `type: "image"`) and `definition.test.ts` 1 of 14 ("validates schema/apply input…")

- [ ] **Step 3: Add the media mappings and converters**

Create `packages/flux-import/src/engine/media.ts`:
```ts
/**
 * Media from URL (M4c): conversion of `image` and `file` mappings to media requests, the URL
 * normalization the media map is keyed by, and EmDash's upload type rules.
 */
import { createHash } from "node:crypto";
import { parseSourceUrl } from "../sources/net.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
export const MAX_MEDIA_MAPPINGS = 5;
export const MAX_ALT_LENGTH = 1000;
/** EmDash's default `maxUploadSize` (`DEFAULT_MAX_UPLOAD_SIZE`, src/api/schemas/media.ts:103). */
export const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

/**
 * EmDash's default upload allowlist (`GLOBAL_UPLOAD_ALLOWLIST`,
 * src/api/handlers/media-allowlist.ts:20-30): entries ending in `/` match as prefixes. SVG is
 * left out on purpose.
 */
export const UPLOAD_ALLOWLIST: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/jxl",
	"video/",
	"audio/",
	"application/pdf",
];

export type MediaKind = "image" | "file";

/** Errors from media conversion; resolution adds its own (`MediaErrorCode`). */
export type MediaConversionCode = "invalid_media_url" | "alt_too_long";

/** One media field of a record: the normalized URL to store and the alt text for this use. */
export type MediaRequest = {
	kind: MediaKind;
	/** Normalized (`normalizeMediaUrl`), the media map key's input. */
	url: string;
	/** Trimmed; null when empty. Images only. */
	alt: string | null;
	refresh: boolean;
};

/** EmDash's MIME normalization (`normalizeMime`, src/media/mime.ts:3-5). */
export function normalizeMime(mime: string): string {
	return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether `mime` is in `list`, as EmDash matches (`matchesMimeAllowlist`, src/media/mime.ts:7-19). */
export function matchesMime(mime: string, list: readonly string[]): boolean {
	const normalized = normalizeMime(mime);
	return list.some((entry) => {
		if (!entry.includes("/")) return false;
		const e = normalizeMime(entry);
		return e.endsWith("/") ? normalized.startsWith(e) : normalized === e;
	});
}

/**
 * Whether a field that accepts `allowed` can take anything EmDash's upload allows: some upload
 * type (an image type for an image mapping) is one of `allowed`, or an `allowed` prefix covers
 * one. Entries without a `/` match nothing, as in EmDash.
 */
export function acceptsUploadable(allowed: readonly string[], kind: MediaKind): boolean {
	const fits = (type: string) => kind === "file" || type.startsWith("image/");
	return allowed.some((entry) => {
		if (!entry.includes("/")) return false;
		const e = normalizeMime(entry);
		return UPLOAD_ALLOWLIST.some((u) => {
			if (!fits(u)) return false;
			if (e.endsWith("/")) return u.startsWith(e) || e.startsWith(u);
			return u.endsWith("/") ? e.startsWith(u) : e === u;
		});
	});
}

/**
 * Why a stored type cannot go into the field, or null when it can: EmDash's upload allowlist, an
 * image type for an image mapping, and the field's `allowedMimeTypes` (enforced again on save).
 */
export function mediaTypeProblem(
	mime: string,
	kind: MediaKind,
	allowed: readonly string[] | undefined,
): string | null {
	if (!matchesMime(mime, UPLOAD_ALLOWLIST)) return `EmDash does not accept ${mime} uploads`;
	if (kind === "image" && !mime.startsWith("image/")) {
		return `An image field cannot take ${mime}`;
	}
	if (allowed !== undefined && allowed.length > 0 && !matchesMime(mime, allowed)) {
		return `The field accepts only ${allowed.join(", ")}, not ${mime}`;
	}
	return null;
}

/**
 * The media map's form of a URL: `parseSourceUrl` (http or https, no user name or password, at
 * most 2,048 characters), then the WHATWG serialization without the fragment. `URL` lower-cases
 * the host, drops a default port and normalizes percent-encoding; the query stays as given.
 */
export function normalizeMediaUrl(
	text: string,
): { ok: true; url: string } | { ok: false; message: string } {
	try {
		const url = parseSourceUrl(text);
		url.hash = "";
		return { ok: true, url: url.href };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}

/** The media map key of a normalized URL: `u` and the SHA-256 of the URL, in hex. */
export function mediaMapKey(url: string): string {
	return `u${createHash("sha256").update(url).digest("hex")}`;
}

type MediaConverted =
	| { ok: true; value: string | null }
	| { ok: false; code: "not_scalar" | MediaConversionCode; message: string };

function kindOf(raw: unknown): string {
	if (Array.isArray(raw)) return "an array";
	return typeof raw === "object" ? "an object" : `a ${typeof raw}`;
}

/**
 * A media URL: a missing path, `null` or blank text is empty (null). Anything but text fails
 * `not_scalar`, numbers and booleans included. Text is trimmed and normalized.
 */
export function mediaUrlConverter(raw: unknown): MediaConverted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw !== "string") {
		return {
			ok: false,
			code: "not_scalar",
			message: `Expected a URL as text, found ${kindOf(raw)}`,
		};
	}
	const text = raw.trim();
	if (text === "") return { ok: true, value: null };
	const normalized = normalizeMediaUrl(text);
	if (!normalized.ok) {
		return { ok: false, code: "invalid_media_url", message: normalized.message };
	}
	return { ok: true, value: normalized.url };
}

/**
 * Alt text: a scalar as text (numbers and booleans as their string), trimmed; empty is no alt.
 * Objects and arrays fail `not_scalar`, more than 1,000 characters `alt_too_long`.
 */
export function altConverter(raw: unknown): MediaConverted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw === "object") {
		return { ok: false, code: "not_scalar", message: `Expected alt text, found ${kindOf(raw)}` };
	}
	const text = String(raw).trim();
	if (text.length > MAX_ALT_LENGTH) {
		return {
			ok: false,
			code: "alt_too_long",
			message: `The alt text has ${text.length} characters; at most ${MAX_ALT_LENGTH} are allowed`,
		};
	}
	return { ok: true, value: text === "" ? null : text };
}
```

In `packages/flux-import/src/engine/template.ts`, replace
```ts
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
```
with:
```ts
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import {
	altConverter,
	type MediaConversionCode,
	type MediaKind,
	type MediaRequest,
	mediaUrlConverter,
} from "./media.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
```

then replace
```ts
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

const fieldMapping = z.discriminatedUnion("type", [
	z
```
with:
```ts
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

/** An image mapping's alt text: from a source path or an expression. */
const altMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

const fieldMapping = z.discriminatedUnion("type", [
	z
```

then replace
```ts
			match: z.enum(["id", "slug", "key"]).optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
```
with:
```ts
			match: z.enum(["id", "slug", "key"]).optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("image"),
			alt: altMapping.optional(),
			refresh: z.boolean().optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("file"), refresh: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
```

then replace
```ts
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
export type BylinesMapping = NonNullable<Template["bylines"]>;

export type { JsonValue, LinkRequests, TargetField, TaxonomySnapshot, TermRequest };
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
/**
 * One record after the template: the key, the slug, the field values, and the link requests
 * (reference fields, taxonomies, bylines) when the template maps any. Reference fields are kept
 * out of `data`.
 */
export type MappedRecord = {
	key: string;
	slug?: string;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
};
export type ValueErrorCode =
	| "filter_error"
```
with:
```ts
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
export type BylinesMapping = NonNullable<Template["bylines"]>;

export type { JsonValue, LinkRequests, MediaRequest, TargetField, TaxonomySnapshot, TermRequest };
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
/**
 * One record after the template: the key, the slug, the field values, the link requests
 * (reference fields, taxonomies, bylines) when the template maps any, and the media requests
 * when it maps image or file fields (null for an empty value). Reference and media fields are
 * kept out of `data`.
 */
export type MappedRecord = {
	key: string;
	slug?: string;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
};
export type ValueErrorCode =
	| "filter_error"
```

then replace
```ts
	| "empty_slug"
	| ConversionCode
	| RuleCode
	| LinkErrorCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
```
with:
```ts
	| "empty_slug"
	| ConversionCode
	| RuleCode
	| LinkErrorCode
	| MediaConversionCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
```

then replace
```ts
		}
		case "reference":
			return referenceConverter(mapping, target);
	}
}

```
with:
```ts
		}
		case "reference":
			return referenceConverter(mapping, target);
		case "image":
		case "file":
			return mediaUrlConverter;
	}
}

```

then replace
```ts
	readonly from: string | undefined;
	readonly expr: CompiledExpression | null;
	readonly convert: (raw: unknown) => LinkConverted<T>;
}

/** A template with its expressions parsed once, for every record of a batch. */
```
with:
```ts
	readonly from: string | undefined;
	readonly expr: CompiledExpression | null;
	readonly convert: (raw: unknown) => LinkConverted<T>;
}

/** An image or file mapping as each record reads it; `alt` is null for files and images without it. */
export interface MediaReader {
	readonly kind: MediaKind;
	readonly refresh: boolean;
	readonly alt: {
		readonly from: string | undefined;
		readonly expr: CompiledExpression | null;
	} | null;
}

/** A template with its expressions parsed once, for every record of a batch. */
```

then replace
```ts
	readonly taxonomies: ReadonlyMap<string, LinkReader<TermRequest>>;
	/** The bylines reader, or null when the template maps no bylines. */
	readonly bylines: LinkReader<string> | null;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
```
with:
```ts
	readonly taxonomies: ReadonlyMap<string, LinkReader<TermRequest>>;
	/** The bylines reader, or null when the template maps no bylines. */
	readonly bylines: LinkReader<string> | null;
	/** Each image and file field's reader, by field name. */
	readonly media: ReadonlyMap<string, MediaReader>;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
```

then replace
```ts
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
```
with:
```ts
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	const media = new Map<string, MediaReader>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
```

then replace
```ts
			name,
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
```
with:
```ts
			name,
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
		if (mapping.type === "image" || mapping.type === "file") {
			const alt = mapping.type === "image" ? mapping.alt : undefined;
			media.set(name, {
				kind: mapping.type,
				refresh: mapping.refresh ?? false,
				alt:
					alt === undefined
						? null
						: { from: alt.from, expr: compile(`fields.${name}.alt.expr`, alt.expr) },
			});
		}
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
```

then replace
```ts
			targets,
			taxonomies,
			bylines,
		},
	};
}
```
with:
```ts
			targets,
			taxonomies,
			bylines,
			media,
		},
	};
}
```

then replace
```ts

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
```
with:
```ts

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
```

then replace
```ts
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else data[field] = result.value;
	}
	for (const [name, reader] of c.taxonomies) {
```
with:
```ts
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		const reader = c.media.get(field);
		if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else if (reader !== undefined) {
			const url = result.value as string | null;
			if (url === null) {
				media[field] = null;
				continue;
			}
			let alt: string | null = null;
			if (reader.alt !== null) {
				const altField = `${field}.alt`;
				const altRaw = await read(altField, reader.alt.from, reader.alt.expr);
				if (altRaw === FAILED) continue;
				const converted = altConverter(altRaw);
				if (!converted.ok) {
					errors.push({ field: altField, code: converted.code, message: converted.message });
					continue;
				}
				alt = converted.value;
			}
			media[field] = { kind: reader.kind, url, alt, refresh: reader.refresh };
		} else data[field] = result.value;
	}
	for (const [name, reader] of c.taxonomies) {
```

then replace
```ts
	if (errors.length > 0) return { ok: false, errors };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	return { ok: true, value: mapped };
}

/**
 * Every source path the template reads: key, slug, field, taxonomy and bylines `from`s, without
 * duplicates. Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [
		t.key.from,
		t.slug?.from,
		...Object.values(t.fields).map((m) => m.from),
		...Object.values(t.taxonomies ?? {}).map((m) => m.from),
		t.bylines?.from,
	];
```
with:
```ts
	if (errors.length > 0) return { ok: false, errors };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	return { ok: true, value: mapped };
}

/**
 * Every source path the template reads: key, slug, field, image alt, taxonomy and bylines
 * `from`s, without duplicates. Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [
		t.key.from,
		t.slug?.from,
		...Object.values(t.fields).flatMap((m) =>
			m.type === "image" ? [m.from, m.alt?.from] : [m.from],
		),
		...Object.values(t.taxonomies ?? {}).map((m) => m.from),
		t.bylines?.from,
	];
```

then replace
```ts
	json: ["json"],
	slug: ["slug", "string"],
	reference: ["reference"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
```
with:
```ts
	json: ["json"],
	slug: ["slug", "string"],
	reference: ["reference"],
	image: ["image"],
	file: ["file"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
```

then replace
```ts
	);
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
```
with:
```ts
	);
}

/** Whether the template maps image or file fields. */
export function usesMedia(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "image" || m.type === "file");
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE);
```

In `packages/flux-import/src/plugin/schema-apply.ts`, replace
```ts
} from "../engine/template.js";
import { ServiceError } from "./service.js";

/** The field types `schema/apply` creates: every type that holds a plain value. */
export const APPLY_FIELD_TYPES = [
	"string",
	"text",
```
with:
```ts
} from "../engine/template.js";
import { ServiceError } from "./service.js";

/**
 * The field types `schema/apply` creates: every type that holds a plain value, and `image` and
 * `file` (a TEXT column holding one media value), created without `allowedMimeTypes`.
 */
export const APPLY_FIELD_TYPES = [
	"string",
	"text",
```

then replace
```ts
	"multiSelect",
	"json",
	"slug",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
```
with:
```ts
	"multiSelect",
	"json",
	"slug",
	"image",
	"file",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/media.test.ts schema-apply definition`
Expected: PASS (3 files, 52 tests). Full suite after this task: 44 files / 1,141 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/media.ts packages/flux-import/src/engine/template.ts packages/flux-import/src/plugin/schema-apply.ts packages/flux-import/tests/unit/media.test.ts packages/flux-import/tests/unit/schema-apply.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Convert image and file mappings into media requests"
```

### Task 2: Schema checks and the job's size limit

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/values.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/template.test.ts`, `packages/flux-import/tests/unit/schema.test.ts`, `packages/flux-import/tests/unit/jobs.test.ts`, `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MAX_MEDIA_MAPPINGS`, `acceptsUploadable`, `UPLOAD_ALLOWLIST`, `usesMedia`, `DEFAULT_MAX_UPLOAD_SIZE`); `checkTemplate`, `createJob`, `rulesOf`, `targetFieldsOf`; V2, V5.
- Produces:
  - `src/engine/values.ts`: `TargetField.allowedMimeTypes?: string[]`.
  - `src/emdash/schema.ts`: `FieldRules.allowedMimeTypes`, kept by `rulesOf` when it is a non-empty list of strings.
  - `src/engine/template.ts`: `checkTemplate` problems for more than 5 media mappings and for a field whose allowed types the upload never accepts; `targetFieldsOf` copies `allowedMimeTypes`.
  - `src/engine/types.ts`: `Job.mediaMaxBytes?: number`; `src/engine/jobs.ts`: `CreateJobInput.mediaMaxBytes`, stored only when the template maps media (default 50 MiB).
  - `src/plugin/service.ts`: `WORKERS_MEDIA_MAX_BYTES` (5 MiB), `mediaMaxBytes(maxUploadSize, workers)`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, replace
```ts
	});
});

describe("checkTemplate for links", () => {
	const linked = templateSchema.parse({
		version: 1,
```
with:
```ts
	});
});

describe("checkTemplate for media", () => {
	const t = (fields: Record<string, unknown>) =>
		templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields,
		});
	const media = t({
		photo: { from: "Img", type: "image", alt: { from: "Alt" } },
		manual: { from: "Pdf", type: "file" },
	});

	it("needs image and file fields for image and file mappings", () => {
		expect(
			checkTemplate(
				media,
				[
					{ slug: "photo", type: "image" },
					{ slug: "manual", type: "file" },
				],
				null,
			),
		).toEqual([]);
		expect(
			checkTemplate(
				media,
				[
					{ slug: "photo", type: "string" },
					{ slug: "manual", type: "image" },
				],
				null,
			),
		).toEqual([
			'Field "photo" has type "string"; an image mapping needs one of image',
			'Field "manual" has type "image"; a file mapping needs one of file',
		]);
	});

	it("refuses a field whose allowed types EmDash's upload never accepts", () => {
		const fields: SchemaField[] = [
			{ slug: "photo", type: "image", validation: { allowedMimeTypes: ["image/svg+xml"] } },
			{ slug: "manual", type: "file", validation: { allowedMimeTypes: ["application/pdf"] } },
		];
		expect(checkTemplate(media, fields, null)).toEqual([
			`Field "photo": EmDash's upload refuses every type this field accepts (image/svg+xml)`,
		]);
		const photo = { slug: "photo", type: "image", validation: { allowedMimeTypes: ["image/"] } };
		expect(checkTemplate(media, [photo, fields[1]!], null)).toEqual([]);
	});

	it("allows at most five image and file mappings", () => {
		const six = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`m${i}`, { from: `U${i}`, type: "file" }]),
		);
		const fields = Object.keys(six).map((slug) => ({ slug, type: "file" }));
		expect(checkTemplate(t(six), fields, null)).toEqual([
			"The template maps 6 image and file fields; at most 5 are allowed",
		]);
		const five = Object.fromEntries(Object.entries(six).slice(0, 5));
		expect(checkTemplate(t(five), fields.slice(0, 5), null)).toEqual([]);
	});

	it("snapshots allowed types", () => {
		expect(
			targetFieldsOf(media, [
				{ slug: "photo", type: "image", validation: { allowedMimeTypes: ["image/png"] } },
				{ slug: "manual", type: "file", required: true, validation: {} },
			]),
		).toEqual({
			photo: { type: "image", required: false, allowedMimeTypes: ["image/png"] },
			manual: { type: "file", required: true },
		});
	});
});

describe("checkTemplate for links", () => {
	const linked = templateSchema.parse({
		version: 1,
```

In `packages/flux-import/tests/unit/schema.test.ts`, replace
```ts
		]);
	});
});

```
with:
```ts
		]);
	});
});

describe("listSchemaFields for media", () => {
	it("keeps a non-empty allowedMimeTypes list of strings", async () => {
		const registry: SchemaRegistryLike = Object.assign(new FakeRegistry(), {
			getCollectionWithFields: async () => ({
				fields: [
					{
						slug: "logo",
						type: "image",
						validation: { allowedMimeTypes: ["image/png", "image/"] },
					},
					{ slug: "any", type: "file", validation: { allowedMimeTypes: [] } },
					{ slug: "odd", type: "file", validation: { allowedMimeTypes: ["a/b", 7 as never] } },
					{ slug: "plain", type: "image", validation: null },
				],
			}),
		});
		const rules = (await listSchemaFields(registry, "products"))?.map((f) => f.validation);
		expect(rules).toEqual([{ allowedMimeTypes: ["image/png", "image/"] }, {}, {}, {}]);
	});
});

```

In `packages/flux-import/tests/unit/jobs.test.ts`, replace
```ts
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
```
with:
```ts
	});
});

describe("createJob with media", () => {
	const media = {
		...template,
		fields: { title: { from: "Name", type: "text" }, photo: { from: "Name", type: "image" } },
	};
	const mediaFields = [
		{ slug: "title", type: "string" },
		{ slug: "photo", type: "image" },
	];

	it("stores the media size limit only for templates that map media", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template: media,
			schemaFields: mediaFields,
			mediaMaxBytes: 1234,
		});
		expect(job.mediaMaxBytes).toBe(1234);
		const unset = await createJob(deps, {
			uploadId: "u1",
			template: media,
			schemaFields: mediaFields,
		});
		expect(unset.mediaMaxBytes).toBe(50 * 1024 * 1024);
		const plain = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			mediaMaxBytes: 1,
		});
		expect(plain).not.toHaveProperty("mediaMaxBytes");
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
	LOG_MAX_BYTES,
	listJobs,
	listRecords,
	nextBatch,
	PASTE_MAX_BYTES,
	releaseUploadIfUnused,
```
with:
```ts
	LOG_MAX_BYTES,
	listJobs,
	listRecords,
	mediaMaxBytes,
	nextBatch,
	PASTE_MAX_BYTES,
	releaseUploadIfUnused,
```

then replace
```ts
	uploadNeeded,
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { FakeStorage, makeDeps } from "./fakes.js";
```
with:
```ts
	uploadNeeded,
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	WORKERS_MEDIA_MAX_BYTES,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { FakeStorage, makeDeps } from "./fakes.js";
```

then replace
```ts
	});
});

describe("nextBatch on Workers", () => {
	it(`processes at most ${WORKERS_BATCH_CAP} records per call, keeping the job's batch size`, async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
```
with:
```ts
	});
});

describe("mediaMaxBytes", () => {
	it("is the site's upload limit, at most 5 MiB on Workers", () => {
		const MiB = 1024 * 1024;
		expect(WORKERS_MEDIA_MAX_BYTES).toBe(5 * MiB);
		expect(mediaMaxBytes(undefined, false)).toBe(50 * MiB);
		expect(mediaMaxBytes(undefined, true)).toBe(5 * MiB);
		expect(mediaMaxBytes(2 * MiB, true)).toBe(2 * MiB);
		expect(mediaMaxBytes(80 * MiB, false)).toBe(80 * MiB);
		expect(mediaMaxBytes(Number.NaN, false)).toBe(50 * MiB);
		expect(mediaMaxBytes(-1, true)).toBe(5 * MiB);
	});
});

describe("nextBatch on Workers", () => {
	it(`processes at most ${WORKERS_BATCH_CAP} records per call, keeping the job's batch size`, async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run template schema jobs service`
Expected: FAIL: 7 of 224 tests in the 5 matched files: the four `checkTemplate for media` tests in `template.test.ts`, "keeps a non-empty allowedMimeTypes list of strings" in `schema.test.ts`, "stores the media size limit only for templates that map media" in `jobs.test.ts` and the `mediaMaxBytes` test in `service.test.ts`

- [ ] **Step 3: Check media fields and store the size limit**

In `packages/flux-import/src/engine/values.ts`, replace
```ts
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
};

export interface NumberOptions {
```
with:
```ts
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
	/** Image and file fields: the types the field accepts (EmDash checks them on save). */
	allowedMimeTypes?: string[];
};

export interface NumberOptions {
```

In `packages/flux-import/src/emdash/schema.ts`, replace
```ts
	if (!field.indexed) await registry.updateField(collection, SOURCE_ID_FIELD, { indexed: true });
}

/** The validation keys the importer checks, as numbers, strings and string arrays only. */
function rulesOf(validation: RegistryField["validation"]): FieldRules {
	const v = validation ?? {};
	const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
```
with:
```ts
	if (!field.indexed) await registry.updateField(collection, SOURCE_ID_FIELD, { indexed: true });
}

/**
 * The validation keys the importer checks, as numbers, strings and string arrays only; an empty
 * `allowedMimeTypes` means no constraint, as in EmDash (`parseAllowedMimeTypes`).
 */
function rulesOf(validation: RegistryField["validation"]): FieldRules {
	const v = validation ?? {};
	const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
```

then replace
```ts
		if (n !== undefined) rules[key] = n;
	}
	if (typeof v.pattern === "string" && v.pattern !== "") rules.pattern = v.pattern;
	return rules;
}

```
with:
```ts
		if (n !== undefined) rules[key] = n;
	}
	if (typeof v.pattern === "string" && v.pattern !== "") rules.pattern = v.pattern;
	const allowed = v.allowedMimeTypes;
	if (Array.isArray(allowed) && allowed.length > 0 && allowed.every((t) => typeof t === "string")) {
		rules.allowedMimeTypes = [...allowed];
	}
	return rules;
}

```

In `packages/flux-import/src/engine/template.ts`, replace
```ts
	taxonomyConverter,
} from "./links.js";
import {
	altConverter,
	type MediaConversionCode,
	type MediaKind,
	type MediaRequest,
```
with:
```ts
	taxonomyConverter,
} from "./links.js";
import {
	acceptsUploadable,
	altConverter,
	MAX_MEDIA_MAPPINGS,
	type MediaConversionCode,
	type MediaKind,
	type MediaRequest,
```

then replace
```ts
		: `No records found at "${source.records}"`;
}

/** The validation keys EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:240-290). */
export type FieldRules = Pick<
	TargetField,
	"options" | "min" | "max" | "minLength" | "maxLength" | "pattern"
>;

/**
```
with:
```ts
		: `No records found at "${source.records}"`;
}

/**
 * The validation keys EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:240-290),
 * and the media types an image or file field accepts (src/api/handlers/validate-media-fields.ts).
 */
export type FieldRules = Pick<
	TargetField,
	"options" | "min" | "max" | "minLength" | "maxLength" | "pattern" | "allowedMimeTypes"
>;

/**
```

then replace
```ts
	}
	const compatible = COMPATIBLE[mapping.type];
	if (!compatible.includes(target.type)) {
		return [
			`Field "${field}" has type "${target.type}"; a ${mapping.type} mapping needs one of ${compatible.join(", ")}`,
		];
	}
	const problems: string[] = [];
	if (mapping.type === "date") {
		if (mapping.output !== undefined && target.type === "datetime") {
			problems.push(`Field "${field}" is a datetime field; "output" only formats text fields`);
```
with:
```ts
	}
	const compatible = COMPATIBLE[mapping.type];
	if (!compatible.includes(target.type)) {
		const article = mapping.type === "image" ? "an" : "a";
		return [
			`Field "${field}" has type "${target.type}"; ${article} ${mapping.type} mapping needs one of ${compatible.join(", ")}`,
		];
	}
	const problems: string[] = [];
	const allowed = target.validation?.allowedMimeTypes ?? [];
	if (
		(mapping.type === "image" || mapping.type === "file") &&
		allowed.length > 0 &&
		!acceptsUploadable(allowed, mapping.type)
	) {
		problems.push(
			`Field "${field}": EmDash's upload refuses every type this field accepts (${allowed.join(", ")})`,
		);
	}
	if (mapping.type === "date") {
		if (mapping.output !== undefined && target.type === "datetime") {
			problems.push(`Field "${field}" is a datetime field; "output" only formats text fields`);
```

then replace
```ts
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, and taxonomies that do not exist or are not attached
 * to the collection. The link checks run only on what `links` carries.
 */
export function checkTemplate(
	t: Template,
```
with:
```ts
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, taxonomies that do not exist or are not attached
 * to the collection, more than five image and file mappings, and image or file fields whose
 * `allowedMimeTypes` EmDash's upload can never satisfy. The link checks run only on what `links`
 * carries.
 */
export function checkTemplate(
	t: Template,
```

then replace
```ts
		}
		const problem = pathProblem(path, format);
		if (problem !== null) errors.push(problem);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	for (const [field, mapping] of Object.entries(t.fields)) {
```
with:
```ts
		}
		const problem = pathProblem(path, format);
		if (problem !== null) errors.push(problem);
	}
	const media = Object.values(t.fields).filter((m) => m.type === "image" || m.type === "file");
	if (media.length > MAX_MEDIA_MAPPINGS) {
		errors.push(
			`The template maps ${media.length} image and file fields; at most ${MAX_MEDIA_MAPPINGS} are allowed`,
		);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	for (const [field, mapping] of Object.entries(t.fields)) {
```

then replace
```ts
			...(f.relationSide === undefined ? {} : { relationSide: f.relationSide }),
			...(f.targetCollection === undefined ? {} : { targetCollection: f.targetCollection }),
			...(f.multiple === undefined ? {} : { multiple: f.multiple }),
		};
	}
	return targets;
```
with:
```ts
			...(f.relationSide === undefined ? {} : { relationSide: f.relationSide }),
			...(f.targetCollection === undefined ? {} : { targetCollection: f.targetCollection }),
			...(f.multiple === undefined ? {} : { multiple: f.multiple }),
			...(v.allowedMimeTypes && v.allowedMimeTypes.length > 0
				? { allowedMimeTypes: v.allowedMimeTypes }
				: {}),
		};
	}
	return targets;
```

In `packages/flux-import/src/engine/types.ts`, replace
```ts
	 * real run would; capped at `MAX_PLANNED_TERMS`. Absent outside dry runs.
	 */
	plannedTerms?: PlannedTerm[];
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
```
with:
```ts
	 * real run would; capped at `MAX_PLANNED_TERMS`. Absent outside dry runs.
	 */
	plannedTerms?: PlannedTerm[];
	/**
	 * The largest file an image or file field downloads, read at job creation: the site's
	 * `maxUploadSize`, at most 5 MiB on Workers. Absent when the template maps no media.
	 */
	mediaMaxBytes?: number;
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
```

In `packages/flux-import/src/engine/jobs.ts`, replace
```ts
	type SourceErrorCode,
} from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
import { SourceMissingError } from "./ports.js";
import {
	checkTemplate,
```
with:
```ts
	type SourceErrorCode,
} from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
import { DEFAULT_MAX_UPLOAD_SIZE } from "./media.js";
import { SourceMissingError } from "./ports.js";
import {
	checkTemplate,
```

then replace
```ts
	templatePaths,
	templateSchema,
	unresolvedPaths,
	usesSiteTimezone,
} from "./template.js";
import {
```
with:
```ts
	templatePaths,
	templateSchema,
	unresolvedPaths,
	usesMedia,
	usesSiteTimezone,
} from "./template.js";
import {
```

then replace
```ts
	siteTimezone?: string;
	/** Reference targets' fields and the taxonomy definitions, for the link checks. */
	linkSchema?: LinkSchema;
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
```
with:
```ts
	siteTimezone?: string;
	/** Reference targets' fields and the taxonomy definitions, for the link checks. */
	linkSchema?: LinkSchema;
	/** The largest media download (`mediaMaxBytes`); EmDash's default upload limit when absent. */
	mediaMaxBytes?: number;
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
```

then replace
```ts
		...(template.taxonomies === undefined
			? {}
			: { taxonomies: taxonomiesOf(template, taxonomyDefs) }),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
```
with:
```ts
		...(template.taxonomies === undefined
			? {}
			: { taxonomies: taxonomiesOf(template, taxonomyDefs) }),
		...(usesMedia(template)
			? { mediaMaxBytes: input.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE }
			: {}),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
```

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
	upgradeJob,
} from "../engine/jobs.js";
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks } from "../engine/template.js";
```
with:
```ts
	upgradeJob,
} from "../engine/jobs.js";
import { buildLogCsv, LogTooLargeError } from "../engine/log.js";
import { DEFAULT_MAX_UPLOAD_SIZE } from "../engine/media.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks } from "../engine/template.js";
```

then replace
```ts
 * queries per invocation, and EmDash's lookups run several queries per call.
 */
export const WORKERS_LOOKUP_BUDGET = 600;

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
```
with:
```ts
 * queries per invocation, and EmDash's lookups run several queries per call.
 */
export const WORKERS_LOOKUP_BUDGET = 600;

/**
 * The largest media file a job downloads on Workers. `handleMediaUpload` takes base64, so one
 * file is held about five times over, and EmDash's placeholder decode of a JPEG or PNG adds
 * memory by pixel count, inside a 128 MB isolate (Fact V5).
 */
export const WORKERS_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A job's `mediaMaxBytes`: the site's `maxUploadSize`, and at most `WORKERS_MEDIA_MAX_BYTES` on
 * Workers. EmDash's default stands in for a setting that is unset or not a positive number;
 * EmDash refuses such a setting itself, so the job's first upload fails it with `media_config`.
 */
export function mediaMaxBytes(maxUploadSize: number | undefined, workers: boolean): number {
	const valid = maxUploadSize !== undefined && Number.isFinite(maxUploadSize) && maxUploadSize > 0;
	const site = valid ? maxUploadSize : DEFAULT_MAX_UPLOAD_SIZE;
	return workers ? Math.min(site, WORKERS_MEDIA_MAX_BYTES) : site;
}

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run template schema jobs service`
Expected: PASS (5 files, 224 tests). Full suite after this task: 44 files / 1,148 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/engine/values.ts packages/flux-import/src/engine/jobs.ts packages/flux-import/src/emdash/schema.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/schema.test.ts packages/flux-import/tests/unit/jobs.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Check media fields at job creation and store the job's media size limit"
```

### Task 3: Download, sniffing and filenames

**Files:**
- Create: `packages/flux-import/src/sources/media-fetch.ts`
- Modify: `packages/flux-import/src/sources/net.ts`, `packages/flux-import/src/sources/fetcher.ts`
- Test: `packages/flux-import/tests/unit/media-fetch.test.ts` (new)

**Interfaces:**
- Consumes: M3c `guardedFetch`, `checkHost`, `NetOptions`, `UrlError` (`src/sources/net.ts`), `fetcher.ts`'s `Content-Length` rule; Task 1 is not needed.
- Produces:
  - `src/sources/net.ts`: `GuardedRequest.onRequest?: () => void`, called before each hop's request.
  - `src/sources/fetcher.ts`: `bodyLength(headers)` exported.
  - `src/sources/media-fetch.ts`: `type MediaErrorCode` (`media_blocked`, `media_fetch_failed`, `media_http_error`, `media_too_large`, `media_type_not_allowed`), `class MediaError`, `MEDIA_LIMITS` (`headersMs` 10 s, `totalMs` 30 s), `type MediaFetchOptions = { kind; maxBytes; deadline; etag?; lastModified? }`, `type MediaFetchResult` (200 with `bytes`, `contentType`, `finalUrl`, validators; or 304), `interface MediaFetcher { checkHost(url): void; fetch(url, o) }`, `createMediaFetcher(net, now?, limits?)`, `sniffMime(bytes)`, `looksLikeMarkup(bytes)`, `mediaTypeOf(bytes, contentType, url)`, `MAX_FILENAME_LENGTH` (100), `mediaFilename(url, mimeType)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/media-fetch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	createMediaFetcher,
	looksLikeMarkup,
	type MediaError,
	type MediaFetchOptions,
	mediaFilename,
	mediaTypeOf,
	sniffMime,
} from "../../src/sources/media-fetch.js";
import type { NetOptions } from "../../src/sources/net.js";
import { streamOf } from "./helpers.js";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
	);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0]);

describe("sniffMime", () => {
	it("recognizes every format the importer knows by its magic bytes", () => {
		const cases: [Uint8Array, string | null][] = [
			[PNG, "image/png"],
			[bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
			[bytes("GIF89a"), "image/gif"],
			[bytes("GIF87a"), "image/gif"],
			[bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "), "image/webp"],
			[bytes("RIFF", [1, 2, 3, 4], "WAVEfmt "), "audio/wav"],
			[ftyp("avif"), "image/avif"],
			[ftyp("heic"), "image/heic"],
			[ftyp("mif1"), "image/heif"],
			[ftyp("isom"), "video/mp4"],
			[ftyp("qt  "), "video/quicktime"],
			[ftyp("M4A "), "audio/mp4"],
			[bytes([0xff, 0x0a, 0xfa]), "image/jxl"],
			[bytes([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), "image/jxl"],
			[bytes("%PDF-1.7\n"), "application/pdf"],
			[bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"), "video/webm"],
			[bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], "matroska"), "video/x-matroska"],
			[bytes("OggS", [0]), "audio/ogg"],
			[bytes("ID3", [4, 0]), "audio/mpeg"],
			[bytes([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
			[bytes("hello"), null],
			[bytes(), null],
		];
		for (const [input, type] of cases) expect(sniffMime(input), type ?? "none").toBe(type);
	});

	it("finds markup after a byte order mark and whitespace, also in UTF-16", () => {
		expect(looksLikeMarkup(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(true);
		expect(looksLikeMarkup(bytes([0xef, 0xbb, 0xbf], " \r\n\t<!doctype html>"))).toBe(true);
		expect(looksLikeMarkup(bytes([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]))).toBe(true);
		expect(looksLikeMarkup(bytes("not < markup"))).toBe(false);
		expect(looksLikeMarkup(PNG)).toBe(false);
	});
});

describe("mediaTypeOf", () => {
	const url = "https://cdn.test/media/file.bin";

	it("lets the bytes decide, and refuses markup whatever the header says", () => {
		expect(mediaTypeOf(PNG, "image/jpeg", url)).toEqual({ ok: true, mimeType: "image/png" });
		expect(mediaTypeOf(bytes("<html><body>x"), "image/png", url)).toEqual({
			ok: false,
			message: "The file is markup (HTML, SVG or XML), which is never imported",
		});
		expect(mediaTypeOf(bytes("<svg/>"), "image/svg+xml", url).ok).toBe(false);
	});

	it("takes an unrecognized video or audio type from the header, never an image or PDF", () => {
		expect(mediaTypeOf(bytes("FLV\x01"), "video/x-flv; charset=binary", url)).toEqual({
			ok: true,
			mimeType: "video/x-flv",
		});
		expect(mediaTypeOf(bytes("fLaC"), "audio/flac", url)).toEqual({
			ok: true,
			mimeType: "audio/flac",
		});
		expect(mediaTypeOf(bytes("garbage"), "image/png", url)).toEqual({
			ok: false,
			message: "The server says image/png, but the file is not one",
		});
		expect(mediaTypeOf(bytes("garbage"), "application/pdf", url).ok).toBe(false);
		expect(mediaTypeOf(bytes("garbage"), "text/plain", url)).toEqual({
			ok: false,
			message: "EmDash does not accept text/plain uploads",
		});
	});

	it("uses the URL's extension only when the header says nothing, and only for audio and video", () => {
		const data = bytes("unknown");
		expect(mediaTypeOf(data, null, "https://cdn.test/clip.MOV?x=1")).toEqual({
			ok: true,
			mimeType: "video/quicktime",
		});
		expect(mediaTypeOf(data, "application/octet-stream", "https://cdn.test/a.mp3")).toEqual({
			ok: true,
			mimeType: "audio/mpeg",
		});
		expect(mediaTypeOf(data, "application/octet-stream", "https://cdn.test/a.png")).toEqual({
			ok: false,
			message: "The file's type could not be recognized",
		});
		expect(mediaTypeOf(data, "text/plain", "https://cdn.test/a.mp3").ok).toBe(false);
	});
});

describe("mediaFilename", () => {
	it("keeps a decoded, reduced last segment with the canonical extension", () => {
		expect(mediaFilename("https://cdn.test/a/Red%20Chair%20(2).JPEG?x=1", "image/jpeg")).toBe(
			"Red-Chair-2.jpg",
		);
		expect(mediaFilename("https://cdn.test/a/photo.png", "image/webp")).toBe("photo.webp");
		expect(mediaFilename("https://cdn.test/files/", "application/pdf")).toBe("media.pdf");
		expect(mediaFilename("https://cdn.test/%E2%82%AC.pdf", "application/pdf")).toBe("media.pdf");
		expect(mediaFilename("https://cdn.test/..%2F..%2Fetc%2Fpasswd", "image/png")).toBe(
			"etc-passwd.png",
		);
		expect(mediaFilename("https://cdn.test/bad%zz.gif", "image/gif")).toBe("bad-zz.gif");
		expect(mediaFilename("https://cdn.test/clip", "video/x-flv")).toBe("clip.bin");
		const long = mediaFilename(`https://cdn.test/${"a".repeat(300)}.png`, "image/png");
		expect(long).toBe(`${"a".repeat(96)}.png`);
	});
});

type Handler = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

function fetcher(handler: Handler, limits = { headersMs: 1000, totalMs: 2000 }, now = Date.now) {
	const seen: { url: string; headers: Headers }[] = [];
	const net: NetOptions = {
		allowPrivateNetwork: false,
		resolver: async () => ["93.184.215.14"],
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			seen.push({ url: String(input), headers });
			return handler(String(input), { headers, signal: init?.signal as AbortSignal });
		},
	};
	return { media: createMediaFetcher(net, now, limits), seen };
}

const options = (o: Partial<MediaFetchOptions> = {}): MediaFetchOptions => ({
	kind: "image",
	maxBytes: 1000,
	deadline: Date.now() + 60_000,
	...o,
});
const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: MediaError) => ({ code: e.code, message: e.message }),
	);
const never = (signal: AbortSignal) =>
	new Promise<Response>((_, reject) =>
		signal.addEventListener("abort", () => reject(signal.reason)),
	);

describe("createMediaFetcher", () => {
	it("downloads the body with Accept for the kind, and reports the URL after redirects", async () => {
		const { media, seen } = fetcher(async (url) =>
			url.endsWith("/old.png")
				? new Response(null, { status: 302, headers: { location: "/new/photo.png" } })
				: new Response(streamOf(PNG, 3), {
						headers: { "content-type": "image/png", etag: '"v1"', "last-modified": "Mon" },
					}),
		);
		expect(await media.fetch("https://cdn.test/old.png", options())).toEqual({
			status: 200,
			bytes: PNG,
			contentType: "image/png",
			finalUrl: "https://cdn.test/new/photo.png",
			etag: '"v1"',
			lastModified: "Mon",
		});
		expect(seen.map((s) => s.headers.get("accept"))).toEqual([
			"image/*,*/*;q=0.8",
			"image/*,*/*;q=0.8",
		]);
		await media.fetch("https://cdn.test/new/photo.png", options({ kind: "file" }));
		expect(seen[2]?.headers.get("accept")).toBe("*/*");
	});

	it("sends the validators on refresh and gives 304 back", async () => {
		const { media, seen } = fetcher(async () => new Response(null, { status: 304 }));
		expect(
			await media.fetch("https://cdn.test/a.png", options({ etag: '"v1"', lastModified: "Mon" })),
		).toEqual({ status: 304 });
		expect(seen[0]?.headers.get("if-none-match")).toBe('"v1"');
		expect(seen[0]?.headers.get("if-modified-since")).toBe("Mon");
		expect(await failure(media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_http_error",
			message: "The server answered HTTP 304",
		});
	});

	it("fails other statuses, network errors and blocked redirects with their codes", async () => {
		const { media } = fetcher(async (url) => {
			if (url.endsWith("/missing.png")) return new Response("no", { status: 404 });
			if (url.endsWith("/hop.png")) {
				return new Response(null, { status: 301, headers: { location: "http://10.0.0.1/x.png" } });
			}
			throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
		});
		expect(await failure(media.fetch("https://cdn.test/missing.png", options()))).toEqual({
			code: "media_http_error",
			message: "The server answered HTTP 404",
		});
		expect(await failure(media.fetch("https://cdn.test/hop.png", options()))).toEqual({
			code: "media_blocked",
			message: "The address 10.0.0.1 is not public",
		});
		expect(await failure(media.fetch("https://cdn.test/down.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "Could not fetch from cdn.test: fetch failed: ECONNRESET",
		});
	});

	it("checks host names and IP literals without the network", () => {
		const { media, seen } = fetcher(async () => new Response(""));
		expect(() => media.checkHost("https://cdn.test/a.png")).not.toThrow();
		for (const url of ["http://localhost/a.png", "http://192.168.1.4/a.png", "http://[::1]/a"]) {
			expect(() => media.checkHost(url), url).toThrow(
				expect.objectContaining({ code: "media_blocked" }),
			);
		}
		expect(seen).toEqual([]);
	});

	it("refuses a Content-Length over the limit before reading, and cuts a longer body", async () => {
		let pulled = 0;
		const body = () =>
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled++;
					controller.enqueue(new Uint8Array(400));
				},
			});
		const { media } = fetcher(async (url) =>
			url.endsWith("/declared.png")
				? new Response(body(), { headers: { "content-length": "1001" } })
				: new Response(body()),
		);
		expect(await failure(media.fetch("https://cdn.test/declared.png", options()))).toEqual({
			code: "media_too_large",
			message: "The file is larger than the limit of 1000 bytes",
		});
		expect(pulled).toBeLessThanOrEqual(1);
		pulled = 0;
		expect(await failure(media.fetch("https://cdn.test/endless.png", options()))).toEqual({
			code: "media_too_large",
			message: "The file is larger than the limit of 1000 bytes",
		});
		expect(pulled).toBeLessThanOrEqual(4);
	});

	it("times out waiting for headers, and for the whole download", async () => {
		const slowHeaders = fetcher(async (_url, { signal }) => never(signal), {
			headersMs: 50,
			totalMs: 2000,
		});
		expect(await failure(slowHeaders.media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "No response within 1 s",
		});
		const stalled = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(10));
					},
				}),
			);
		const slowBody = fetcher(async () => stalled(), { headersMs: 1000, totalMs: 60 });
		expect(await failure(slowBody.media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "The download did not finish within 1 s",
		});
	});

	it("never runs past the caller's deadline", async () => {
		const now = Date.now();
		const { media } = fetcher(async (_url, { signal }) => never(signal), {
			headersMs: 10_000,
			totalMs: 30_000,
		});
		const started = Date.now();
		expect(
			await failure(media.fetch("https://cdn.test/a.png", options({ deadline: now + 80 }))),
		).toEqual({ code: "media_fetch_failed", message: "The download did not finish within 1 s" });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run media-fetch`
Expected: FAIL: `media-fetch.test.ts` does not load (`Cannot find module '../../src/sources/media-fetch.js'`)

- [ ] **Step 3: Add the media fetcher**

In `packages/flux-import/src/sources/net.ts`, replace
```ts
	/** Removed from the request once a redirect leaves the original origin. */
	credentialHeader?: string;
	signal: AbortSignal;
}

/**
```
with:
```ts
	/** Removed from the request once a redirect leaves the original origin. */
	credentialHeader?: string;
	signal: AbortSignal;
	/** Told each URL before it is fetched, so the caller knows the URL that answered. */
	onRequest?: (url: URL) => void;
}

/**
```

then replace
```ts
			throw fetchError(e, request.signal, `Could not resolve ${host}`);
		}
		let response: Response;
		try {
			response = await net.fetch(url.href, {
				method: "GET",
```
with:
```ts
			throw fetchError(e, request.signal, `Could not resolve ${host}`);
		}
		let response: Response;
		request.onRequest?.(url);
		try {
			response = await net.fetch(url.href, {
				method: "GET",
```

In `packages/flux-import/src/sources/fetcher.ts`, replace
```ts
}

/** The declared length, or `undefined` when there is none or it does not describe the body. */
function bodyLength(headers: Headers): number | undefined {
	const encoding = headers.get("content-encoding");
	// fetch() decodes a compressed body, so its Content-Length no longer matches (Fact W1).
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
```
with:
```ts
}

/** The declared length, or `undefined` when there is none or it does not describe the body. */
export function bodyLength(headers: Headers): number | undefined {
	const encoding = headers.get("content-encoding");
	// fetch() decodes a compressed body, so its Content-Length no longer matches (Fact W1).
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
```

Create `packages/flux-import/src/sources/media-fetch.ts`:
```ts
/**
 * Downloads for image and file fields (M4c): one guarded GET per URL (the M3c SSRF guard), its
 * body counted and buffered into one `Uint8Array`, then the type read from the bytes and a
 * filename built for EmDash's media library.
 */
import { bodyLength } from "./fetcher.js";
import {
	checkHost,
	fetchError,
	guardedFetch,
	type NetOptions,
	parseSourceUrl,
	UrlSourceError,
	whenAborted,
} from "./net.js";

/** Record error codes for media; every one fails the record, never the job. */
export type MediaErrorCode =
	| "invalid_media_url"
	| "media_blocked"
	| "media_fetch_failed"
	| "media_http_error"
	| "media_too_large"
	| "media_type_not_allowed"
	| "media_upload_failed";

/** A media problem for one field of a record. Messages never contain header values. */
export class MediaError extends Error {
	constructor(
		readonly code: MediaErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MediaError";
	}
}

export interface MediaLimits {
	/** Until the final response's headers arrive, DNS and redirects included. */
	headersMs: number;
	/** For the whole download; the caller's deadline may shorten it. */
	totalMs: number;
}

export const MEDIA_LIMITS = { headersMs: 10_000, totalMs: 30_000 } as const satisfies MediaLimits;

/** `Accept` for each mapping kind. */
const ACCEPT = { image: "image/*,*/*;q=0.8", file: "*/*" } as const;

export type MediaFetchOptions = {
	kind: "image" | "file";
	/** The job's `mediaMaxBytes`. */
	maxBytes: number;
	/** Epoch milliseconds the download must finish by. */
	deadline: number;
	/** Validators of the earlier download, for a conditional GET (`refresh`). */
	etag?: string;
	lastModified?: string;
};

export type MediaFetchResult =
	| {
			status: 200;
			bytes: Uint8Array;
			/** The response's `Content-Type`, as sent. */
			contentType: string | null;
			/** The URL that answered, after redirects. */
			finalUrl: string;
			etag?: string;
			lastModified?: string;
	  }
	| { status: 304 };

export interface MediaFetcher {
	/** The checks that need no network (host names, IP literals); throws `media_blocked`. */
	checkHost(url: string): void;
	/** Throws `MediaError`; a `304` comes back only to a conditional request. */
	fetch(url: string, o: MediaFetchOptions): Promise<MediaFetchResult>;
}

const tooLarge = (limit: number) =>
	new MediaError("media_too_large", `The file is larger than the limit of ${limit} bytes`);

const CODES: Record<UrlSourceError["code"], MediaErrorCode> = {
	URL_BLOCKED: "media_blocked",
	FETCH_FAILED: "media_fetch_failed",
	TOO_MANY_REDIRECTS: "media_fetch_failed",
	HTTP_ERROR: "media_http_error",
	TOO_LARGE: "media_too_large",
	LENGTH_REQUIRED: "media_fetch_failed",
};

function asMediaError(e: unknown, signal: AbortSignal): MediaError {
	if (e instanceof MediaError) return e;
	const failure = fetchError(e, signal, "The download failed");
	return new MediaError(CODES[failure.code], failure.message);
}

/** Reads the body into one array, cut as soon as it passes `maxBytes`. */
async function readBody(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const aborted = whenAborted(signal);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge(maxBytes);
			chunks.push(value);
		}
	} catch (e) {
		reader.cancel().catch(() => {});
		throw e;
	}
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

/**
 * A `MediaFetcher` over `guardedFetch`: 10 s to the response headers, then at most 30 s for the
 * whole download and never past the caller's deadline. A `Content-Length` over the limit is
 * refused before the body is read.
 */
export function createMediaFetcher(
	net: NetOptions,
	now: () => number = Date.now,
	limits: MediaLimits = MEDIA_LIMITS,
): MediaFetcher {
	return {
		checkHost(url) {
			try {
				checkHost(parseSourceUrl(url), net.allowPrivateNetwork);
			} catch (e) {
				if (e instanceof UrlSourceError) throw new MediaError("media_blocked", e.message);
				throw e;
			}
		},
		async fetch(url, o) {
			const totalMs = Math.max(0, Math.min(limits.totalMs, o.deadline - now()));
			const headers = new Headers({ accept: ACCEPT[o.kind] });
			if (o.etag !== undefined) headers.set("if-none-match", o.etag);
			if (o.lastModified !== undefined) headers.set("if-modified-since", o.lastModified);
			const conditional = o.etag !== undefined || o.lastModified !== undefined;
			const total = new AbortController();
			const untilHeaders = new AbortController();
			const seconds = (ms: number) => Math.ceil(ms / 1000);
			const totalTimer = setTimeout(
				() =>
					total.abort(
						new UrlSourceError(
							"FETCH_FAILED",
							`The download did not finish within ${seconds(totalMs)} s`,
						),
					),
				totalMs,
			);
			const headersTimer = setTimeout(
				() =>
					untilHeaders.abort(
						new UrlSourceError("FETCH_FAILED", `No response within ${seconds(limits.headersMs)} s`),
					),
				limits.headersMs,
			);
			const signal = AbortSignal.any([total.signal, untilHeaders.signal]);
			try {
				let finalUrl = url;
				const response = await guardedFetch(
					url,
					{
						headers,
						signal,
						onRequest: (next) => {
							finalUrl = next.href;
						},
					},
					net,
				);
				clearTimeout(headersTimer);
				if (response.status === 304 && conditional) {
					await response.body?.cancel().catch(() => {});
					return { status: 304 };
				}
				if (response.status < 200 || response.status > 299) {
					await response.body?.cancel().catch(() => {});
					throw new MediaError("media_http_error", `The server answered HTTP ${response.status}`);
				}
				const length = bodyLength(response.headers);
				if (length !== undefined && length > o.maxBytes) {
					await response.body?.cancel().catch(() => {});
					throw tooLarge(o.maxBytes);
				}
				const bytes = await readBody(
					response.body ?? new Blob([]).stream(),
					o.maxBytes,
					total.signal,
				);
				const etag = response.headers.get("etag");
				const lastModified = response.headers.get("last-modified");
				return {
					status: 200,
					bytes,
					contentType: response.headers.get("content-type"),
					finalUrl,
					...(etag === null ? {} : { etag }),
					...(lastModified === null ? {} : { lastModified }),
				};
			} catch (e) {
				throw asMediaError(e, signal);
			} finally {
				clearTimeout(totalTimer);
				clearTimeout(headersTimer);
			}
		},
	};
}

const startsWith = (bytes: Uint8Array, at: number, values: readonly number[]) =>
	values.every((v, i) => bytes[at + i] === v);
const ascii = (bytes: Uint8Array, at: number, text: string) =>
	startsWith(
		bytes,
		at,
		[...text].map((c) => c.charCodeAt(0)),
	);
const textOf = (bytes: Uint8Array, from: number, to: number) =>
	String.fromCharCode(...bytes.subarray(from, to));

/** ISO base media brands that are images (HEIF/AVIF), which `ftyp` alone does not tell apart. */
const IMAGE_BRANDS: Record<string, string> = {
	avif: "image/avif",
	avis: "image/avif",
	heic: "image/heic",
	heix: "image/heic",
	hevc: "image/heic",
	hevx: "image/heic",
	mif1: "image/heif",
	msf1: "image/heif",
};

/**
 * The type the bytes show, or null when they match none of the formats the importer knows: PNG,
 * JPEG, GIF, WebP, AVIF (and HEIF, which EmDash refuses), JPEG XL, PDF, MP4 and QuickTime
 * (`ftyp`), WebM and Matroska, Ogg, WAV and MP3.
 */
export function sniffMime(bytes: Uint8Array): string | null {
	if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
	if (ascii(bytes, 4, "ftyp")) {
		const brand = textOf(bytes, 8, 12);
		if (IMAGE_BRANDS[brand]) return IMAGE_BRANDS[brand];
		if (brand === "qt  ") return "video/quicktime";
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		return "video/mp4";
	}
	if (startsWith(bytes, 0, [0xff, 0x0a])) return "image/jxl";
	if (startsWith(bytes, 0, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
		return "image/jxl";
	}
	if (ascii(bytes, 0, "%PDF-")) return "application/pdf";
	if (startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
		return textOf(bytes, 4, 64).includes("webm") ? "video/webm" : "video/x-matroska";
	}
	if (ascii(bytes, 0, "OggS")) return "audio/ogg";
	if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
	// An MPEG audio frame: 11 sync bits, then layer III.
	if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2) return "audio/mpeg";
	return null;
}

/** Whether the bytes start with `<` after a byte order mark and whitespace (HTML, SVG, XML). */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
	let at = 0;
	if (startsWith(bytes, 0, [0xef, 0xbb, 0xbf])) at = 3;
	else if (startsWith(bytes, 0, [0xfe, 0xff]) || startsWith(bytes, 0, [0xff, 0xfe])) at = 2;
	// UTF-16 text has a zero byte beside each ASCII character.
	const skip = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
	const end = Math.min(bytes.length, 1024);
	while (at < end && skip.has(bytes[at] as number)) at++;
	return bytes[at] === 0x3c;
}

/** Audio and video types by URL extension, for a response that names no type. */
const EXTENSION_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	ogv: "video/ogg",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
};

function extensionOf(url: string): string {
	const path = new URL(url).pathname;
	const last = path.slice(path.lastIndexOf("/") + 1);
	const dot = last.lastIndexOf(".");
	return dot < 0 ? "" : last.slice(dot + 1).toLowerCase();
}

/**
 * The file's type, decided by its bytes. Markup is refused whatever the header says. A type the
 * bytes show wins. Otherwise a `video/*` or `audio/*` `Content-Type` is taken, an image or PDF
 * header the bytes do not confirm is refused, and only a missing or `application/octet-stream`
 * header falls back to the URL's extension (audio and video only).
 */
export function mediaTypeOf(
	bytes: Uint8Array,
	contentType: string | null,
	url: string,
): { ok: true; mimeType: string } | { ok: false; message: string } {
	if (looksLikeMarkup(bytes)) {
		return { ok: false, message: "The file is markup (HTML, SVG or XML), which is never imported" };
	}
	const sniffed = sniffMime(bytes);
	if (sniffed !== null) return { ok: true, mimeType: sniffed };
	const header = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (header.startsWith("video/") || header.startsWith("audio/")) {
		return { ok: true, mimeType: header };
	}
	if (header.startsWith("image/") || header === "application/pdf") {
		return { ok: false, message: `The server says ${header}, but the file is not one` };
	}
	if (header === "" || header === "application/octet-stream") {
		const byExtension = EXTENSION_TYPES[extensionOf(url)];
		if (byExtension !== undefined) return { ok: true, mimeType: byExtension };
		return { ok: false, message: "The file's type could not be recognized" };
	}
	return { ok: false, message: `EmDash does not accept ${header} uploads` };
}

/**
 * The extension EmDash stores the file under; the local storage adapter serves a file with the
 * type of its extension.
 */
const EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/jxl": ".jxl",
	"application/pdf": ".pdf",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
	"video/x-matroska": ".mkv",
	"video/ogg": ".ogv",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/mp4": ".m4a",
};

export const MAX_FILENAME_LENGTH = 100;

/**
 * The library filename: the URL's last path segment, percent-decoded and reduced to
 * `[A-Za-z0-9._-]`, at most 100 characters, `media` when nothing is left, with its extension
 * replaced by the canonical one for `mimeType` (`.bin` for a type without one).
 */
export function mediaFilename(url: string, mimeType: string): string {
	const path = new URL(url).pathname;
	let last = path.slice(path.lastIndexOf("/") + 1);
	try {
		last = decodeURIComponent(last);
	} catch {
		// Keep a segment that is not valid percent-encoding as it is.
	}
	const extension = EXTENSIONS[mimeType] ?? ".bin";
	const stem = last
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.[A-Za-z0-9]{1,10}$/, "")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, MAX_FILENAME_LENGTH - extension.length)
		.replace(/[.-]+$/, "");
	return `${stem === "" ? "media" : stem}${extension}`;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run media-fetch`
Expected: PASS (1 file, 13 tests). Full suite after this task: 45 files / 1,161 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/media-fetch.ts packages/flux-import/src/sources/net.ts packages/flux-import/src/sources/fetcher.ts packages/flux-import/tests/unit/media-fetch.test.ts
git commit -m "Download media through the SSRF guard with size and time limits, and sniff its type"
```

### Task 4: Media port and media map

**Files:**
- Create: `packages/flux-import/src/emdash/media.ts`
- Modify: `packages/flux-import/src/engine/ports.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/emdash/storage.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/media-port.test.ts` (new), `packages/flux-import/tests/unit/storage.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 3 (`MediaFetcher`, `createMediaFetcher`); `ContentWriteError` (`src/engine/ports.ts`); `runtime.handleMediaGet`, `runtime.handleMediaUpload`, `runtime.config.maxUploadSize` (V1, V2).
- Produces:
  - `src/engine/ports.ts`: `interface MediaInfo { id; filename; mimeType; size; width; height; alt; blurhash; dominantColor; storageKey }`, `interface MediaPort { get(id); upload({ filename, contentType, bytes, alt? }) }`, `class MediaUploadError` (EmDash's `code`).
  - `src/engine/types.ts`: `interface MediaMapRow`; `EngineDeps.mediaMap`, `media`, `mediaFetcher`.
  - `src/emdash/media.ts`: `interface MediaRuntime`, `class EmDashMedia(runtime, authorId, maxUploadSize)`: `get` returns ready items only, read errors become `ContentWriteError` with `emdash_` codes; `upload` sends base64 (`node:buffer`) and throws `MediaUploadError`.
  - `src/emdash/storage.ts`: `pluginCollections` requires `media` and returns `mediaMap`; `src/plugin/definition.ts`: storage `media` with indexes `jobId`, `mediaId`; `src/plugin/routes.ts`: one shared `NetOptions`, `EmDashMedia` and `createMediaFetcher` in the engine deps.
  - `tests/unit/fakes.ts`: `FakeMedia` (SHA-1 dedupe to ready items, `items`, `calls`, `failUpload`), `FakeMediaFetcher(clock)` (`files`, `blocked`, `calls`, `urls()`), `makeDeps` wiring both and the `media` collection.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/media-port.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { HandlerResult } from "../../src/emdash/content.js";
import { EmDashMedia, type MediaRuntime } from "../../src/emdash/media.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import { FakeMedia } from "./fakes.js";

const item = (over: Record<string, unknown> = {}) => ({
	id: "M1",
	filename: "chair.png",
	mimeType: "image/png",
	size: 12,
	width: 4,
	height: 3,
	alt: "Library alt",
	caption: null,
	storageKey: "01ABC.png",
	status: "ready",
	contentHash: "sha1:x",
	blurhash: "LEHV6n",
	dominantColor: "rgb(1,2,3)",
	createdAt: "2026-10-27T00:00:00Z",
	authorId: "u1",
	...over,
});
const info = {
	id: "M1",
	filename: "chair.png",
	mimeType: "image/png",
	size: 12,
	width: 4,
	height: 3,
	alt: "Library alt",
	storageKey: "01ABC.png",
	blurhash: "LEHV6n",
	dominantColor: "rgb(1,2,3)",
};

class FakeRuntime implements MediaRuntime {
	readonly uploads: Parameters<MediaRuntime["handleMediaUpload"]>[0][] = [];
	get: (id: string) => HandlerResult = () => ({ success: true, data: { item: item() } });
	upload: () => HandlerResult = () => ({ success: true, data: { item: { ...item(), url: "/x" } } });

	async handleMediaGet(id: string) {
		return this.get(id);
	}
	async handleMediaUpload(input: Parameters<MediaRuntime["handleMediaUpload"]>[0]) {
		this.uploads.push(input);
		return this.upload();
	}
}

describe("EmDashMedia", () => {
	it("gets a ready item, and null for a missing or unfinished one", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		expect(await media.get("M1")).toEqual(info);
		runtime.get = () => ({ success: true, data: { item: item({ status: "pending" }) } });
		expect(await media.get("M1")).toBeNull();
		runtime.get = () => ({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
		expect(await media.get("M1")).toBeNull();
	});

	it("turns read errors and odd responses into record errors", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		runtime.get = () => ({ success: false, error: { code: "MEDIA_GET_ERROR", message: "db" } });
		await expect(media.get("M1")).rejects.toMatchObject({
			name: "ContentWriteError",
			code: "emdash_media_get_error",
			message: "Reading the media item failed: db",
		});
		runtime.get = () => ({ success: true, data: { item: { id: "M1" } } });
		await expect(media.get("M1")).rejects.toMatchObject({ code: "emdash_bad_response" });
	});

	it("uploads base64 as the author, with the site's limit and the alt when given", async () => {
		const runtime = new FakeRuntime();
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]).subarray(1, 5);
		const limited = new EmDashMedia(runtime, "u1", 1234);
		expect(
			await limited.upload({ filename: "a.png", contentType: "image/png", bytes, alt: "A" }),
		).toEqual({ item: info, deduplicated: false });
		const plain = new EmDashMedia(runtime, "u2", undefined);
		runtime.upload = () => ({
			success: true,
			data: { item: { ...item(), url: "/x" }, deduplicated: true },
		});
		expect(
			await plain.upload({ filename: "b.pdf", contentType: "application/pdf", bytes }),
		).toEqual({ item: info, deduplicated: true });
		expect(runtime.uploads).toEqual([
			{
				filename: "a.png",
				base64: Buffer.from([1, 2, 250, 251]).toString("base64"),
				contentType: "image/png",
				authorId: "u1",
				alt: "A",
				maxUploadSize: 1234,
			},
			{
				filename: "b.pdf",
				base64: "AQL6+w==",
				contentType: "application/pdf",
				authorId: "u2",
			},
		]);
	});

	it("throws EmDash's upload error code", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		runtime.upload = () => ({
			success: false,
			error: { code: "PAYLOAD_TOO_LARGE", message: "File exceeds maximum size of 50MB" },
		});
		const upload = media.upload({
			filename: "a.png",
			contentType: "image/png",
			bytes: new Uint8Array(1),
		});
		await expect(upload).rejects.toBeInstanceOf(MediaUploadError);
		await expect(upload).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
			message: "File exceeds maximum size of 50MB",
		});
		runtime.upload = () => ({ success: true, data: {} });
		await expect(
			media.upload({ filename: "a.png", contentType: "image/png", bytes: new Uint8Array(1) }),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	});
});

describe("FakeMedia", () => {
	it("dedupes identical bytes to the ready item, keeping its alt", async () => {
		const media = new FakeMedia();
		const bytes = new Uint8Array([1, 2, 3]);
		const first = await media.upload({
			filename: "a.png",
			contentType: "image/png",
			bytes,
			alt: "A",
		});
		const again = await media.upload({
			filename: "b.png",
			contentType: "image/png",
			bytes,
			alt: "B",
		});
		expect(first).toMatchObject({ item: { id: "m1", alt: "A", width: 4 }, deduplicated: false });
		expect(again).toMatchObject({ item: { id: "m1", alt: "A" }, deduplicated: true });
		media.items.get("m1")!.status = "pending";
		expect(await media.get("m1")).toBeNull();
	});
});
```

In `packages/flux-import/tests/unit/storage.test.ts`, replace
```ts
});

describe("pluginCollections", () => {
	it("requires the jobs, records and links collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s })).toThrow("storage collections");
		expect(Object.keys(pluginCollections({ jobs: s, records: s, links: s }))).toEqual([
			"jobs",
			"records",
			"links",
		]);
	});
});
```
with:
```ts
});

describe("pluginCollections", () => {
	it("requires the jobs, records, links and media collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s, links: s })).toThrow(
			"storage collections",
		);
		expect(Object.keys(pluginCollections({ jobs: s, records: s, links: s, media: s }))).toEqual([
			"jobs",
			"records",
			"links",
			"mediaMap",
		]);
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId", "sourceUploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
```
with:
```ts
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId", "sourceUploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
		expect(STORAGE.media.indexes).toEqual(["jobId", "mediaId"]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
```

In `packages/flux-import/tests/unit/fakes.ts`, replace
```ts
import { EmDashStorageError } from "emdash";
import type { UploadStorage } from "../../src/emdash/uploads.js";
import {
```
with:
```ts
import { createHash } from "node:crypto";
import { EmDashStorageError } from "emdash";
import type { UploadStorage } from "../../src/emdash/uploads.js";
import {
```

then replace
```ts
	type KvCollection,
	type LinkWrites,
	type LookupPort,
	SourceMissingError,
	type SourcePort,
	type TaxonomyDef,
```
with:
```ts
	type KvCollection,
	type LinkWrites,
	type LookupPort,
	type MediaInfo,
	type MediaPort,
	type MediaUploadError,
	SourceMissingError,
	type SourcePort,
	type TaxonomyDef,
```

then replace
```ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type { EngineDeps, Job, LinkRow, RecordRow } from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import { streamOf } from "./helpers.js";

function matches(data: Record<string, unknown>, where: Where): boolean {
```
with:
```ts
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type { EngineDeps, Job, LinkRow, MediaMapRow, RecordRow } from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import {
	MediaError,
	type MediaFetcher,
	type MediaFetchOptions,
	type MediaFetchResult,
} from "../../src/sources/media-fetch.js";
import { streamOf } from "./helpers.js";

function matches(data: Record<string, unknown>, where: Where): boolean {
```

then replace
```ts
	}
}

export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
```
with:
```ts
	}
}

type StoredMedia = MediaInfo & { status: string; hash: string };

/**
 * In-memory media library: identical bytes (by SHA-1, as EmDash) give the ready item already
 * stored, whose alt is left as it was. Images are 4 x 3 with a blurhash.
 */
export class FakeMedia implements MediaPort {
	readonly items = new Map<string, StoredMedia>();
	readonly calls: string[] = [];
	/** Return an error to make this upload fail. */
	failUpload: (input: { filename: string; contentType: string }) => MediaUploadError | null = () =>
		null;
	private next = 0;

	async get(id: string) {
		this.calls.push(`get:${id}`);
		return this.info(id);
	}

	private info(id: string): MediaInfo | null {
		const item = this.items.get(id);
		if (!item || item.status !== "ready") return null;
		const { status: _s, hash: _h, ...info } = item;
		return structuredClone(info);
	}

	async upload(input: { filename: string; contentType: string; bytes: Uint8Array; alt?: string }) {
		this.calls.push(`upload:${input.filename}`);
		const failure = this.failUpload(input);
		if (failure) throw failure;
		const hash = createHash("sha1").update(input.bytes).digest("hex");
		for (const item of this.items.values()) {
			if (item.hash === hash && item.status === "ready") {
				return { item: this.info(item.id) as MediaInfo, deduplicated: true };
			}
		}
		const n = ++this.next;
		const image = input.contentType.startsWith("image/");
		const extension = input.filename.slice(input.filename.lastIndexOf("."));
		this.items.set(`m${n}`, {
			id: `m${n}`,
			filename: input.filename,
			mimeType: input.contentType,
			size: input.bytes.byteLength,
			width: image ? 4 : null,
			height: image ? 3 : null,
			alt: input.alt ?? null,
			storageKey: `K${n}${extension}`,
			blurhash: image ? `bh${n}` : null,
			dominantColor: image ? "rgb(1,2,3)" : null,
			status: "ready",
			hash,
		});
		return { item: this.info(`m${n}`) as MediaInfo, deduplicated: false };
	}
}

/** What the fake server answers for a URL. */
export type FakeFile = {
	body: string | Uint8Array;
	contentType?: string | null;
	etag?: string;
	/** How long the download takes on the test clock. */
	ms?: number;
	/** Fail the download with this error instead. */
	error?: MediaError;
	/** The URL that answered, after redirects. */
	finalUrl?: string;
};

/**
 * `MediaFetcher` over a map of URLs. A URL not in it answers 404; a matching `etag` answers
 * 304; `ms` advances the test clock. Hosts in `blocked` fail the host check.
 */
export class FakeMediaFetcher implements MediaFetcher {
	readonly files = new Map<string, FakeFile>();
	readonly blocked = new Set<string>();
	readonly calls: { url: string; options: MediaFetchOptions }[] = [];

	constructor(private readonly clock: { t: number }) {}

	checkHost(url: string) {
		const host = new URL(url).hostname;
		if (this.blocked.has(host))
			throw new MediaError("media_blocked", `The host ${host} is not allowed`);
	}

	async fetch(url: string, options: MediaFetchOptions): Promise<MediaFetchResult> {
		this.calls.push({ url, options });
		this.checkHost(url);
		const file = this.files.get(url);
		if (!file) throw new MediaError("media_http_error", "The server answered HTTP 404");
		this.clock.t += file.ms ?? 0;
		if (file.error) throw file.error;
		if (options.etag !== undefined && options.etag === file.etag) return { status: 304 };
		const bytes = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
		if (bytes.byteLength > options.maxBytes) {
			throw new MediaError(
				"media_too_large",
				`The file is larger than the limit of ${options.maxBytes} bytes`,
			);
		}
		return {
			status: 200,
			bytes,
			contentType: file.contentType === undefined ? "application/octet-stream" : file.contentType,
			finalUrl: file.finalUrl ?? url,
			...(file.etag === undefined ? {} : { etag: file.etag }),
		};
	}

	/** The URLs downloaded, in order. */
	urls(): string[] {
		return this.calls.map((c) => c.url);
	}
}

export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
```

then replace
```ts
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content,
		lookups,
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```
with:
```ts
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		mediaMap: new MemoryKv<MediaMapRow>(),
		content,
		lookups,
		media: new FakeMedia(),
		mediaFetcher: new FakeMediaFetcher(clock),
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run media-port storage definition`
Expected: FAIL: `media-port.test.ts` does not load (`Cannot find module '../../src/emdash/media.js'`); `storage.test.ts` fails 1 of 2 ("requires the jobs, records, links and media collections") and `definition.test.ts` 1 of 14 ("declares the storage indexes the queries use")

- [ ] **Step 3: Add the port, the EmDash adapter and the media map collection**

In `packages/flux-import/src/engine/ports.ts`, replace
```ts
	): Promise<{ id: string; group: string } | null>;
}

export interface SourcePort {
	/**
	 * An offset at or past the source size yields an empty stream. EmDash's ranged download returns
```
with:
```ts
	): Promise<{ id: string; group: string } | null>;
}

/** A media library item (`MediaItem`, `emdash` src/database/repositories/media.ts:57-76). */
export interface MediaInfo {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	width: number | null;
	height: number | null;
	/** The library's default alt text. */
	alt: string | null;
	storageKey: string;
	blurhash: string | null;
	dominantColor: string | null;
}

/** The media library, through the trusted runtime. */
export interface MediaPort {
	/** The item when it exists and is ready, else null; throws `ContentWriteError` on read errors. */
	get(id: string): Promise<MediaInfo | null>;
	/**
	 * Stores the bytes, or finds identical bytes already stored (`deduplicated`, whose alt is
	 * left as it was). Throws `MediaUploadError` with EmDash's code.
	 */
	upload(input: {
		filename: string;
		contentType: string;
		bytes: Uint8Array;
		alt?: string;
	}): Promise<{ item: MediaInfo; deduplicated: boolean }>;
}

export interface SourcePort {
	/**
	 * An offset at or past the source size yields an empty stream. EmDash's ranged download returns
```

then replace
```ts
	}
}

export class SourceMissingError extends Error {
	constructor(uploadId: string) {
		super(`Upload ${uploadId} not found`);
```
with:
```ts
	}
}

/** EmDash refused an upload; `code` is EmDash's (`PAYLOAD_TOO_LARGE`, `INVALID_TYPE`, …). */
export class MediaUploadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "MediaUploadError";
	}
}

export class SourceMissingError extends Error {
	constructor(uploadId: string) {
		super(`Upload ${uploadId} not found`);
```

In `packages/flux-import/src/engine/types.ts`, replace
```ts
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, SourcePort } from "./ports.js";
import type { TaxonomySnapshot, Template } from "./template.js";
import type { TargetField } from "./values.js";

```
with:
```ts
import type { MediaFetcher } from "../sources/media-fetch.js";
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, MediaPort, SourcePort } from "./ports.js";
import type { TaxonomySnapshot, Template } from "./template.js";
import type { TargetField } from "./values.js";

```

then replace
```ts
	writtenRev?: string;
}

export interface EngineDeps {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	content: ContentPort;
	lookups: LookupPort;
	source: SourcePort;
	now: () => number;
	newId: () => string;
```
with:
```ts
	writtenRev?: string;
}

/**
 * What a media URL became, in the site-wide media map (plugin storage `media`, keyed by
 * `mediaMapKey`). Written as soon as an upload succeeds; never purged by retention.
 */
export interface MediaMapRow {
	/** The normalized URL. */
	url: string;
	mediaId: string;
	storageKey: string;
	mimeType: string;
	bytes: number;
	/** Validators of the download, for `refresh`. */
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
	/** The job that last downloaded it. */
	jobId: string;
	/** The upload made a new item rather than finding identical bytes already stored. */
	created: boolean;
}

export interface EngineDeps {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	content: ContentPort;
	lookups: LookupPort;
	media: MediaPort;
	mediaFetcher: MediaFetcher;
	source: SourcePort;
	now: () => number;
	newId: () => string;
```

Create `packages/flux-import/src/emdash/media.ts`:
```ts
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
	ContentWriteError,
	type MediaInfo,
	type MediaPort,
	MediaUploadError,
} from "../engine/ports.js";
import { type HandlerResult, writeError } from "./content.js";

/**
 * The runtime's media handlers this adapter calls (`emdash` src/emdash-runtime.ts:4795-4824);
 * the runtime is assignable to it.
 */
export interface MediaRuntime {
	handleMediaGet(id: string): Promise<HandlerResult>;
	handleMediaUpload(input: {
		filename: string;
		base64: string;
		contentType: string;
		alt?: string;
		authorId?: string;
		maxUploadSize?: number;
	}): Promise<HandlerResult>;
}

/** The parts of `MediaItem` (src/database/repositories/media.ts:57-76) the importer uses. */
const mediaItem = z.object({
	id: z.string(),
	filename: z.string(),
	mimeType: z.string(),
	size: z.number().nullable(),
	width: z.number().nullable(),
	height: z.number().nullable(),
	alt: z.string().nullable(),
	storageKey: z.string(),
	status: z.string(),
	blurhash: z.string().nullable().optional(),
	dominantColor: z.string().nullable().optional(),
});
const getResult = z.object({ item: mediaItem });
const uploadResult = z.object({ item: mediaItem, deduplicated: z.boolean().optional() });

function infoOf(item: z.infer<typeof mediaItem>): MediaInfo {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		size: item.size,
		width: item.width,
		height: item.height,
		alt: item.alt,
		storageKey: item.storageKey,
		blurhash: item.blurhash ?? null,
		dominantColor: item.dominantColor ?? null,
	};
}

/**
 * `MediaPort` over the trusted runtime. Uploads go through `handleMediaUpload`, which runs
 * EmDash's allowlist, size check, content-hash dedupe, storage write, image enrichment and the
 * media hooks; they are credited to `authorId` and limited by the site's `maxUploadSize`.
 */
export class EmDashMedia implements MediaPort {
	constructor(
		private readonly runtime: MediaRuntime,
		private readonly authorId: string,
		private readonly maxUploadSize: number | undefined,
	) {}

	async get(id: string): Promise<MediaInfo | null> {
		const result = await this.runtime.handleMediaGet(id);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the media item", result.error);
		}
		const parsed = getResult.safeParse(result.data);
		if (!parsed.success) {
			throw new ContentWriteError(
				"emdash_bad_response",
				"Reading the media item: unexpected response from EmDash",
			);
		}
		const { item } = parsed.data;
		// A pending or failed upload has no stored file to point at.
		return item.status === "ready" ? infoOf(item) : null;
	}

	async upload(input: {
		filename: string;
		contentType: string;
		bytes: Uint8Array;
		alt?: string;
	}): Promise<{ item: MediaInfo; deduplicated: boolean }> {
		const { bytes } = input;
		const result = await this.runtime.handleMediaUpload({
			filename: input.filename,
			base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
			contentType: input.contentType,
			authorId: this.authorId,
			...(input.alt === undefined ? {} : { alt: input.alt }),
			...(this.maxUploadSize === undefined ? {} : { maxUploadSize: this.maxUploadSize }),
		});
		if (!result.success) {
			const code = result.error?.code ?? "UNKNOWN_ERROR";
			throw new MediaUploadError(code, result.error?.message ?? code);
		}
		const parsed = uploadResult.safeParse(result.data);
		if (!parsed.success) {
			throw new MediaUploadError("BAD_RESPONSE", "Unexpected response from EmDash");
		}
		return { item: infoOf(parsed.data.item), deduplicated: parsed.data.deduplicated === true };
	}
}
```

In `packages/flux-import/src/emdash/storage.ts`, replace
```ts
import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type { Job, LinkRow, RecordRow } from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;

```
with:
```ts
import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type { Job, LinkRow, MediaMapRow, RecordRow } from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;

```

then replace
```ts
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
}

/** The three collections declared in the plugin definition, typed for the engine. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links } = storage;
	if (!jobs || !records || !links) {
		throw new Error("flux-import: the jobs, records and links storage collections are missing");
	}
	return {
		jobs: kvCollection<Job>(jobs),
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
	};
}

```
with:
```ts
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
}

/** The engine's collections declared in the plugin definition (`media` is the media map), typed. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links, media } = storage;
	if (!jobs || !records || !links || !media) {
		throw new Error(
			"flux-import: the jobs, records, links and media storage collections are missing",
		);
	}
	return {
		jobs: kvCollection<Job>(jobs),
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
		mediaMap: kvCollection<MediaMapRow>(media),
	};
}

```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` and `jobs.sourceUploadId` let a
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it.
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
```
with:
```ts
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` and `jobs.sourceUploadId` let a
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it. `media` is the site-wide media map; its
 * `jobId` and `mediaId` indexes let a job's own media be listed (M5 rollback, audit).
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
```

then replace
```ts
	},
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
```
with:
```ts
	},
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
```
with:
```ts
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
```

then replace
```ts
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { defaultResolver } from "../sources/net.js";
import { SOURCE_FORMATS, XLSX_MAX_ROWS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
```
with:
```ts
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
import { defaultResolver, type NetOptions } from "../sources/net.js";
import { SOURCE_FORMATS, XLSX_MAX_ROWS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
```

then replace
```ts
		}
		const uploads = new EmDashUploads(runtime.storage);
		const collection = sourcesCollection(ctx.storage);
		const sources: SourceDeps = {
			sources: collection,
			jobs: pluginCollections(ctx.storage).jobs,
			settings: ctx.settings,
			storage: runtime.storage,
			net: {
				resolver: defaultResolver(),
				allowPrivateNetwork: allowPrivateNetwork(),
				// A plain call: workerd rejects fetch() called as a method of another object.
				fetch: (input, init) => fetch(input, init),
			},
			limits: { ...FETCH_LIMITS, maxBytes: maxSourceBytes() },
			workers: onWorkers(),
			now: Date.now,
```
with:
```ts
		}
		const uploads = new EmDashUploads(runtime.storage);
		const collection = sourcesCollection(ctx.storage);
		const net: NetOptions = {
			resolver: defaultResolver(),
			allowPrivateNetwork: allowPrivateNetwork(),
			// A plain call: workerd rejects fetch() called as a method of another object.
			fetch: (input, init) => fetch(input, init),
		};
		const sources: SourceDeps = {
			sources: collection,
			jobs: pluginCollections(ctx.storage).jobs,
			settings: ctx.settings,
			storage: runtime.storage,
			net,
			limits: { ...FETCH_LIMITS, maxBytes: maxSourceBytes() },
			workers: onWorkers(),
			now: Date.now,
```

then replace
```ts
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
```
with:
```ts
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime),
			// Media is fetched without credentials, behind the same SSRF guard as URL sources.
			media: new EmDashMedia(runtime, actor.id, runtime.config.maxUploadSize),
			mediaFetcher: createMediaFetcher(net),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run media-port storage definition`
Expected: PASS (3 files, 21 tests). Full suite after this task: 46 files / 1,166 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/emdash/media.ts packages/flux-import/src/engine/ports.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/emdash/storage.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/media-port.test.ts packages/flux-import/tests/unit/storage.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Add the media port over the runtime's media handlers and the site-wide media map"
```

### Task 5: Resolver

**Files:**
- Modify: `packages/flux-import/src/engine/media.ts`, `packages/flux-import/src/engine/resolve.ts`
- Test: `packages/flux-import/tests/unit/media-resolve.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`MediaRequest`, `mediaMapKey`, `mediaTypeProblem`), Task 2 (`TargetField.allowedMimeTypes`), Task 3 (`MediaFetcher`, `MediaError`, `mediaTypeOf`, `mediaFilename`), Task 4 (`MediaPort`, `MediaInfo`, `MediaUploadError`, `MediaMapRow`, fakes); M4b `LookupCache`, `COST_CALL`, `ContentWriteError`.
- Produces:
  - `src/engine/resolve.ts`: `COST_MEDIA` (60); `LookupCache.mediaItems`, `mediaDownloads`, `mediaDeadline`.
  - `src/engine/media.ts`: `MEDIA_MIN_LEFT_MS` (5,000); `type MediaDeps`; `type MediaContext = { jobId; dryRun; maxBytes; targets }`; `type MediaLookup`; `class MediaDeferred`; `findMedia(deps, cache, ctx, url)`; `obtainMedia(...)`; `resolveMedia(deps, cache, ctx, field, request)` (the M4d entry point); `lookupRecordMedia(deps, cache, ctx, media)` (errors collected, `null` for empty fields); `type ResolvedMedia`; `obtainRecordMedia(deps, cache, ctx, lookups)` (sequential, stops at the first failure, returns `newMedia`); `mediaFieldValue(request, item)`. `CONFIGURATION_ERROR` and `NO_STORAGE` throw `ContentWriteError("media_config")`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/media-resolve.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	findMedia,
	lookupRecordMedia,
	MEDIA_MIN_LEFT_MS,
	type MediaContext,
	MediaDeferred,
	type MediaRequest,
	mediaFieldValue,
	mediaMapKey,
	obtainRecordMedia,
	resolveMedia,
} from "../../src/engine/media.js";
import { ContentWriteError, MediaUploadError } from "../../src/engine/ports.js";
import { COST_CALL, COST_MEDIA, LookupCache } from "../../src/engine/resolve.js";
import { MediaError } from "../../src/sources/media-fetch.js";
import { makeDeps } from "./fakes.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const A = "https://cdn.test/a.png";
const B = "https://cdn.test/b.png";

const image = (url: string, over: Partial<MediaRequest> = {}): MediaRequest => ({
	kind: "image",
	url,
	alt: null,
	refresh: false,
	...over,
});

function setup(ctx: Partial<MediaContext> = {}) {
	const { deps, clock } = makeDeps();
	deps.mediaFetcher.files.set(A, { body: PNG, contentType: "image/png", etag: '"a1"' });
	deps.mediaFetcher.files.set(B, { body: PNG2, contentType: "image/png" });
	const context: MediaContext = { jobId: "j1", dryRun: false, maxBytes: 1000, targets: {}, ...ctx };
	return { deps, clock, ctx: context, cache: new LookupCache() };
}

describe("resolveMedia", () => {
	it("downloads a miss, uploads it with its alt and filename, and writes the map row", async () => {
		const { deps, ctx, cache } = setup();
		const resolved = await resolveMedia(deps, cache, ctx, "photo", image(A, { alt: "A chair" }));
		expect(resolved).toMatchObject({
			ok: true,
			downloaded: true,
			item: { id: "m1", alt: "A chair" },
		});
		expect(deps.media.calls).toEqual(["upload:a.png"]);
		expect(await deps.mediaMap.get(mediaMapKey(A))).toEqual({
			url: A,
			mediaId: "m1",
			storageKey: "K1.png",
			mimeType: "image/png",
			bytes: PNG.byteLength,
			etag: '"a1"',
			fetchedAt: "2026-10-07T10:00:00.000Z",
			jobId: "j1",
			created: true,
		});
		expect(deps.mediaFetcher.calls[0]?.options).toMatchObject({ kind: "image", maxBytes: 1000 });
	});

	it("uses a hit with a ready item without downloading, reading each item once per batch", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const next = new LookupCache();
		for (const field of ["photo", "thumb"]) {
			expect(await resolveMedia(deps, next, ctx, field, image(A))).toMatchObject({
				ok: true,
				downloaded: false,
				item: { id: "m1" },
			});
		}
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		expect(deps.media.calls).toEqual(["upload:a.png", "get:m1"]);
		expect(next.spent).toBe(COST_CALL * 3);
	});

	it("drops a row whose item is gone and downloads again; a dry run only plans it", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		deps.media.items.delete("m1");
		const dry = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, dryRun: true },
			"photo",
			image(A),
		);
		expect(dry).toEqual({ ok: true, item: null, downloaded: false });
		expect(await deps.mediaMap.get(mediaMapKey(A))).not.toBeNull();
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		const again = await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A));
		expect(again).toMatchObject({ ok: true, downloaded: true, item: { id: "m2" } });
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.mediaId).toBe("m2");
	});

	it("maps identical bytes from another URL to the existing item, keeping its alt", async () => {
		const { deps, ctx, cache } = setup();
		deps.mediaFetcher.files.set("https://mirror.test/a.png", { body: PNG, contentType: null });
		await resolveMedia(deps, cache, ctx, "photo", image(A, { alt: "First" }));
		const copy = await resolveMedia(
			deps,
			cache,
			ctx,
			"photo",
			image("https://mirror.test/a.png", { alt: "Second" }),
		);
		expect(copy).toMatchObject({ ok: true, downloaded: true, item: { id: "m1", alt: "First" } });
		expect(await deps.mediaMap.get(mediaMapKey("https://mirror.test/a.png"))).toMatchObject({
			mediaId: "m1",
			created: false,
		});
	});

	it("refreshes with the stored validators: 304 keeps the item, new bytes make a new one", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const kept = await resolveMedia(
			deps,
			new LookupCache(),
			ctx,
			"photo",
			image(A, { refresh: true }),
		);
		expect(kept).toMatchObject({ ok: true, downloaded: false, item: { id: "m1" } });
		expect(deps.mediaFetcher.calls[1]?.options.etag).toBe('"a1"');
		deps.mediaFetcher.files.set(A, { body: PNG2, contentType: "image/png", etag: '"a2"' });
		const changed = await resolveMedia(
			deps,
			new LookupCache(),
			ctx,
			"photo",
			image(A, { refresh: true }),
		);
		expect(changed).toMatchObject({ ok: true, downloaded: true, item: { id: "m2" } });
		expect(await deps.mediaMap.get(mediaMapKey(A))).toMatchObject({ mediaId: "m2", etag: '"a2"' });
		const dry = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, dryRun: true },
			"photo",
			image(A, { refresh: true }),
		);
		expect(dry).toMatchObject({ ok: true, item: { id: "m2" } });
		expect(deps.mediaFetcher.calls).toHaveLength(3);
	});
});

describe("media errors", () => {
	const failed = (code: string, message?: string) => ({
		ok: false,
		error: { field: "photo", code, ...(message === undefined ? {} : { message }) },
	});

	it("checks the host in every run, before the map", async () => {
		const { deps, ctx } = setup({ dryRun: true });
		deps.mediaFetcher.blocked.add("cdn.test");
		expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("media_blocked", "The host cdn.test is not allowed"),
		);
	});

	it("refuses types before uploading: by the bytes, the kind and the field's allowed types", async () => {
		const { deps, ctx } = setup({
			targets: { logo: { type: "image", required: false, allowedMimeTypes: ["image/jpeg"] } },
		});
		deps.mediaFetcher.files.set("https://cdn.test/page.png", {
			body: "<!doctype html><p>hi",
			contentType: "image/png",
		});
		deps.mediaFetcher.files.set("https://cdn.test/a.pdf", {
			body: PDF,
			contentType: "application/pdf",
		});
		const resolve = (field: string, url: string) =>
			resolveMedia(deps, new LookupCache(), ctx, field, image(url));
		expect(await resolve("photo", "https://cdn.test/page.png")).toEqual(
			failed(
				"media_type_not_allowed",
				"https://cdn.test/page.png: The file is markup (HTML, SVG or XML), which is never imported",
			),
		);
		expect(await resolve("photo", "https://cdn.test/a.pdf")).toEqual(
			failed(
				"media_type_not_allowed",
				"https://cdn.test/a.pdf: An image field cannot take application/pdf",
			),
		);
		expect(await resolve("logo", A)).toMatchObject({
			ok: false,
			error: {
				field: "logo",
				code: "media_type_not_allowed",
				message: `${A}: The field accepts only image/jpeg, not image/png`,
			},
		});
		expect(deps.media.calls).toEqual([]);
	});

	it("refuses a hit the field does not accept, without downloading", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const strict = {
			...ctx,
			targets: { photo: { type: "image", required: false, allowedMimeTypes: ["image/gif"] } },
		};
		expect(await resolveMedia(deps, new LookupCache(), strict, "photo", image(A))).toEqual(
			failed("media_type_not_allowed", `${A}: The field accepts only image/gif, not image/png`),
		);
		expect(deps.mediaFetcher.calls).toHaveLength(1);
	});

	it("passes download failures through with their codes", async () => {
		const { deps, ctx } = setup();
		deps.mediaFetcher.files.set(A, {
			body: "",
			error: new MediaError("media_fetch_failed", "No response within 10 s"),
		});
		expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("media_fetch_failed", "No response within 10 s"),
		);
		expect(
			await resolveMedia(deps, new LookupCache(), ctx, "photo", image("https://cdn.test/x.png")),
		).toEqual(failed("media_http_error", "The server answered HTTP 404"));
		expect(
			await resolveMedia(deps, new LookupCache(), { ...ctx, maxBytes: 5 }, "photo", image(B)),
		).toEqual(failed("media_too_large", "The file is larger than the limit of 5 bytes"));
	});

	it("maps EmDash's upload errors, and fails the job when EmDash cannot store media", async () => {
		const { deps, ctx } = setup();
		const cases: [string, string, string][] = [
			["PAYLOAD_TOO_LARGE", "media_too_large", "EmDash refused the upload: big"],
			["INVALID_TYPE", "media_type_not_allowed", "EmDash refused the upload: big"],
			["UPLOAD_ERROR", "media_upload_failed", "EmDash refused the upload (UPLOAD_ERROR): big"],
		];
		for (const [emdash, code, message] of cases) {
			deps.media.failUpload = () => new MediaUploadError(emdash, "big");
			expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
				failed(code, message),
			);
		}
		for (const emdash of ["CONFIGURATION_ERROR", "NO_STORAGE"]) {
			deps.media.failUpload = () => new MediaUploadError(emdash, "Storage not configured");
			await expect(
				resolveMedia(deps, new LookupCache(), ctx, "photo", image(A)),
			).rejects.toMatchObject({
				name: "ContentWriteError",
				code: "media_config",
				message: "EmDash cannot store media: Storage not configured",
			});
		}
		expect(await deps.mediaMap.get(mediaMapKey(A))).toBeNull();
	});

	it("reports an item EmDash fails to read as a record error", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		deps.media.get = async () => {
			throw new ContentWriteError("emdash_media_get_error", "Reading the media item failed: db");
		};
		expect(await findMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("emdash_media_get_error", "Reading the media item failed: db"),
		);
	});
});

describe("record media", () => {
	it("collects every lookup error and leaves empty fields null", async () => {
		const { deps, ctx, cache } = setup();
		deps.mediaFetcher.blocked.add("evil.test");
		const result = await lookupRecordMedia(deps, cache, ctx, {
			photo: image("https://evil.test/a.png"),
			thumb: null,
			icon: image("https://evil.test/b.png"),
			hero: image(A),
		});
		expect(result.errors.map((e) => `${e.field}:${e.code}`)).toEqual([
			"photo:media_blocked",
			"icon:media_blocked",
		]);
		expect(result.lookups).toMatchObject({ thumb: null, hero: { item: null } });
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("downloads one field at a time, stops at the first failure, and lists downloads", async () => {
		const { deps, ctx, cache } = setup();
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			icon: image("https://cdn.test/missing.png"),
			hero: image(B),
		});
		expect(await obtainRecordMedia(deps, cache, ctx, lookups)).toEqual({
			ok: false,
			errors: [
				{ field: "icon", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			newMedia: [`photo: ${A}`],
		});
		expect(deps.mediaFetcher.urls()).toEqual([A, "https://cdn.test/missing.png"]);
		const second = new LookupCache();
		const again = await lookupRecordMedia(deps, second, ctx, {
			photo: image(A),
			hero: image(B),
			none: null,
		});
		expect(await obtainRecordMedia(deps, second, ctx, again.lookups)).toMatchObject({
			ok: true,
			media: { photo: { item: { id: "m1" } }, hero: { item: { id: "m2" } }, none: null },
			newMedia: [`hero: ${B}`],
		});
	});

	it("defers a download that would start too close to the deadline, never the batch's first", async () => {
		const { deps, clock, ctx } = setup();
		deps.mediaFetcher.files.set(A, { body: PNG, contentType: "image/png", ms: 20_000 });
		const cache = new LookupCache();
		cache.mediaDeadline = clock.t + 1000;
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			hero: image(B),
		});
		await expect(obtainRecordMedia(deps, cache, ctx, lookups)).rejects.toBeInstanceOf(
			MediaDeferred,
		);
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		expect(deps.mediaFetcher.calls[0]?.options.deadline).toBe(clock.t - 20_000 + MEDIA_MIN_LEFT_MS);
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.mediaId).toBe("m1");
		const next = new LookupCache();
		next.mediaDeadline = clock.t + MEDIA_MIN_LEFT_MS;
		const retried = await lookupRecordMedia(deps, next, ctx, { photo: image(A), hero: image(B) });
		expect(await obtainRecordMedia(deps, next, ctx, retried.lookups)).toMatchObject({ ok: true });
		expect(deps.mediaFetcher.urls()).toEqual([A, B]);
		expect(deps.mediaFetcher.calls[1]?.options.deadline).toBe(clock.t + MEDIA_MIN_LEFT_MS);
	});

	it("charges the batch budget for lookups and downloads", async () => {
		const { deps, ctx } = setup();
		const cache = new LookupCache([], 600);
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			hero: image(B),
		});
		expect(cache.spent).toBe(2 * COST_CALL);
		await obtainRecordMedia(deps, cache, ctx, lookups);
		expect(cache.spent).toBe(2 * COST_CALL + 2 * COST_MEDIA);
	});
});

describe("mediaFieldValue", () => {
	const item = {
		id: "m1",
		filename: "a.png",
		mimeType: "image/png",
		size: 11,
		width: 4,
		height: 3,
		alt: "Library",
		storageKey: "K1.png",
		blurhash: "bh",
		dominantColor: "rgb(1,2,3)",
	};

	it("builds EmDash's stored shape for images and files", () => {
		expect(mediaFieldValue("image", item, "Per use")).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "image/png",
			width: 4,
			height: 3,
			blurhash: "bh",
			dominantColor: "rgb(1,2,3)",
			alt: "Per use",
			meta: { storageKey: "K1.png" },
		});
		const gif = { ...item, width: null, height: null, blurhash: null, dominantColor: null };
		expect(mediaFieldValue("image", gif, null)).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "image/png",
			meta: { storageKey: "K1.png" },
		});
		expect(mediaFieldValue("file", { ...item, mimeType: "application/pdf" }, "x")).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "application/pdf",
			meta: { storageKey: "K1.png" },
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run media-resolve`
Expected: FAIL: 16 of 16 (`resolveMedia`, `lookupRecordMedia` and `mediaFieldValue` are not functions yet)

- [ ] **Step 3: Implement the resolver**

In `packages/flux-import/src/engine/resolve.ts`, replace
```ts
	ContentWriteError,
	type KvCollection,
	type LookupPort,
	type TermInfo,
} from "./ports.js";
import { slugify, type TargetField, type Template } from "./template.js";
```
with:
```ts
	ContentWriteError,
	type KvCollection,
	type LookupPort,
	type MediaInfo,
	type TermInfo,
} from "./ports.js";
import { slugify, type TargetField, type Template } from "./template.js";
```

then replace
```ts
/** A content get or list, or a byline page: a full read with its hydration queries. */
export const COST_READ = 5;
export const COST_CREATE_TERM = 6;
/** Charged for each processed record of a job that maps links: its writes and bookkeeping. */
export const COST_RECORD = 25;

export type { ResolvedItem, ResolvedLinks };

```
with:
```ts
/** A content get or list, or a byline page: a full read with its hydration queries. */
export const COST_READ = 5;
export const COST_CREATE_TERM = 6;
/** Charged for each processed record of a job that maps links or media: its writes and bookkeeping. */
export const COST_RECORD = 25;
/** One media download and its upload (M4c): about ten per Workers batch. */
export const COST_MEDIA = 60;

export type { ResolvedItem, ResolvedLinks };

```

then replace
```ts
	spent = 0;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();

	/** `budget`: the batch should end after the record that brings `spent` to this. */
	constructor(
```
with:
```ts
	spent = 0;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();
	/** Media items read or stored this batch, by ID; null when missing or not ready. */
	readonly mediaItems = new Map<string, MediaInfo | null>();
	/** Media downloads started this batch. */
	mediaDownloads = 0;
	/** When this batch's downloads must be done by (epoch ms); `runBatch` sets it. */
	mediaDeadline = Number.POSITIVE_INFINITY;

	/** `budget`: the batch should end after the record that brings `spent` to this. */
	constructor(
```

In `packages/flux-import/src/engine/media.ts`, replace
```ts
/**
 * Media from URL (M4c): conversion of `image` and `file` mappings to media requests, the URL
 * normalization the media map is keyed by, and EmDash's upload type rules.
 */
import { createHash } from "node:crypto";
import { parseSourceUrl } from "../sources/net.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
export const MAX_MEDIA_MAPPINGS = 5;
```
with:
```ts
/**
 * Media from URL (M4c): conversion of `image` and `file` mappings to media requests, the URL
 * normalization the media map is keyed by, EmDash's upload type rules, and the resolver that
 * turns a request into a media item: a media map hit, or a download and upload.
 */
import { createHash } from "node:crypto";
import { MediaError, mediaFilename, mediaTypeOf } from "../sources/media-fetch.js";
import { parseSourceUrl } from "../sources/net.js";
import { ContentWriteError, type MediaInfo, MediaUploadError } from "./ports.js";
import { COST_CALL, COST_MEDIA, type LinkError, type LookupCache } from "./resolve.js";
import type { EngineDeps, MediaMapRow } from "./types.js";
import type { JsonValue, TargetField } from "./values.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
export const MAX_MEDIA_MAPPINGS = 5;
```

then replace
```ts
	return { ok: true, value: text === "" ? null : text };
}

```
with:
```ts
	return { ok: true, value: text === "" ? null : text };
}

/** The least time a download other than the batch's first may start with. */
export const MEDIA_MIN_LEFT_MS = 5000;

export type MediaDeps = Pick<EngineDeps, "media" | "mediaFetcher" | "mediaMap" | "now">;

/** What the resolver needs from the job. */
export type MediaContext = {
	jobId: string;
	dryRun: boolean;
	/** The job's `mediaMaxBytes`. */
	maxBytes: number;
	/** The job's target field snapshot: each media field's `allowedMimeTypes`. */
	targets: Readonly<Record<string, TargetField>>;
};

/** One media field after the map lookup. */
export type MediaLookup = {
	field: string;
	request: MediaRequest;
	/** `mediaMapKey(request.url)`. */
	key: string;
	/** The ready item the URL became, or null when the map has none (a miss). */
	item: MediaInfo | null;
	/** The map row of a hit. */
	row: MediaMapRow | null;
};

/**
 * Thrown when the batch has no time left for the record's next download: the batch ends
 * before the record, which the next batch processes again. Media already stored is in the map.
 */
export class MediaDeferred extends Error {
	constructor() {
		super("No time left in this batch for the next download");
		this.name = "MediaDeferred";
	}
}

const fieldError = (field: string, code: string, message: string): LinkError => ({
	field,
	code,
	message,
});

/** A media item by ID, read once per batch; null when it is missing or not ready. */
async function mediaItem(
	deps: MediaDeps,
	cache: LookupCache,
	id: string,
): Promise<MediaInfo | null> {
	if (cache.mediaItems.has(id)) return cache.mediaItems.get(id) ?? null;
	cache.spend(COST_CALL);
	const item = await deps.media.get(id);
	cache.mediaItems.set(id, item);
	return item;
}

/**
 * Looks one request up, without the network: the host check (`media_blocked`), then the media
 * map and the item it names. A map row whose item is missing or not ready is a miss, and a real
 * run drops it. A hit must still fit the field (`media_type_not_allowed`).
 */
export async function findMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	field: string,
	request: MediaRequest,
): Promise<{ ok: true; lookup: MediaLookup } | { ok: false; error: LinkError }> {
	try {
		deps.mediaFetcher.checkHost(request.url);
		const key = mediaMapKey(request.url);
		cache.spend(COST_CALL);
		const row = await deps.mediaMap.get(key);
		const item = row ? await mediaItem(deps, cache, row.mediaId) : null;
		if (row && !item && !ctx.dryRun) await deps.mediaMap.delete(key);
		if (item) {
			const problem = mediaTypeProblem(
				item.mimeType,
				request.kind,
				ctx.targets[field]?.allowedMimeTypes,
			);
			if (problem !== null) {
				return {
					ok: false,
					error: fieldError(field, "media_type_not_allowed", `${request.url}: ${problem}`),
				};
			}
		}
		return { ok: true, lookup: { field, request, key, item, row: item ? row : null } };
	} catch (e) {
		// A blocked host, or EmDash failing to read the item, fails the record, not the job.
		if (e instanceof MediaError || e instanceof ContentWriteError) {
			return { ok: false, error: fieldError(field, e.code, e.message) };
		}
		throw e;
	}
}

/**
 * EmDash's upload errors as record errors. A missing storage or an invalid `maxUploadSize`
 * would fail every upload, so it fails the job (`media_config`).
 */
function uploadError(field: string, e: MediaUploadError): LinkError {
	switch (e.code) {
		case "CONFIGURATION_ERROR":
		case "NO_STORAGE":
			throw new ContentWriteError("media_config", `EmDash cannot store media: ${e.message}`);
		case "PAYLOAD_TOO_LARGE":
			return fieldError(field, "media_too_large", `EmDash refused the upload: ${e.message}`);
		case "INVALID_TYPE":
			return fieldError(field, "media_type_not_allowed", `EmDash refused the upload: ${e.message}`);
		default:
			return fieldError(
				field,
				"media_upload_failed",
				`EmDash refused the upload (${e.code}): ${e.message}`,
			);
	}
}

/**
 * The item for a looked-up request in a real run: a hit as it is, or a download (a conditional
 * one for a hit with `refresh`), whose type comes from its bytes, uploaded through EmDash and
 * written to the media map before anything else. Throws `MediaDeferred` when a download other
 * than the batch's first would start with less than `MEDIA_MIN_LEFT_MS` left.
 */
export async function obtainMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	lookup: MediaLookup,
): Promise<{ ok: true; item: MediaInfo; downloaded: boolean } | { ok: false; error: LinkError }> {
	const { field, request, item: hit, row } = lookup;
	if (hit && !request.refresh) return { ok: true, item: hit, downloaded: false };
	const now = deps.now();
	const first = cache.mediaDownloads === 0;
	if (!first && cache.mediaDeadline - now < MEDIA_MIN_LEFT_MS) throw new MediaDeferred();
	cache.mediaDownloads++;
	cache.spend(COST_MEDIA);
	try {
		const fetched = await deps.mediaFetcher.fetch(request.url, {
			kind: request.kind,
			maxBytes: ctx.maxBytes,
			// The batch's first download always gets its chance, so every batch makes progress.
			deadline: first
				? Math.max(cache.mediaDeadline, now + MEDIA_MIN_LEFT_MS)
				: cache.mediaDeadline,
			...(hit && row?.etag !== undefined ? { etag: row.etag } : {}),
			...(hit && row?.lastModified !== undefined ? { lastModified: row.lastModified } : {}),
		});
		if (fetched.status === 304) {
			if (hit) return { ok: true, item: hit, downloaded: false };
			return {
				ok: false,
				error: fieldError(field, "media_http_error", "The server answered HTTP 304"),
			};
		}
		const type = mediaTypeOf(fetched.bytes, fetched.contentType, fetched.finalUrl);
		const problem = type.ok
			? mediaTypeProblem(type.mimeType, request.kind, ctx.targets[field]?.allowedMimeTypes)
			: type.message;
		if (!type.ok || problem !== null) {
			return {
				ok: false,
				error: fieldError(field, "media_type_not_allowed", `${request.url}: ${problem}`),
			};
		}
		const { item, deduplicated } = await deps.media.upload({
			filename: mediaFilename(fetched.finalUrl, type.mimeType),
			contentType: type.mimeType,
			bytes: fetched.bytes,
			...(request.alt === null ? {} : { alt: request.alt }),
		});
		cache.mediaItems.set(item.id, item);
		await deps.mediaMap.put(lookup.key, {
			url: request.url,
			mediaId: item.id,
			storageKey: item.storageKey,
			mimeType: item.mimeType,
			bytes: fetched.bytes.byteLength,
			...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
			...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
			fetchedAt: new Date(deps.now()).toISOString(),
			jobId: ctx.jobId,
			created: !deduplicated,
		});
		return { ok: true, item, downloaded: true };
	} catch (e) {
		if (e instanceof MediaError) return { ok: false, error: fieldError(field, e.code, e.message) };
		if (e instanceof MediaUploadError) return { ok: false, error: uploadError(field, e) };
		throw e;
	}
}

/**
 * Resolves one media request: the map lookup, then in a real run the download and upload when
 * it is a miss (or a hit with `refresh`). A dry run gives `item: null` for a miss. This is the
 * resolver M4d calls for each Portable Text image URL; it shares the batch's cache, budget and
 * deadline.
 */
export async function resolveMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	field: string,
	request: MediaRequest,
): Promise<
	{ ok: true; item: MediaInfo | null; downloaded: boolean } | { ok: false; error: LinkError }
> {
	const found = await findMedia(deps, cache, ctx, field, request);
	if (!found.ok) return found;
	if (ctx.dryRun) return { ok: true, item: found.lookup.item, downloaded: false };
	return obtainMedia(deps, cache, ctx, found.lookup);
}

/** Every media field of a record looked up; all errors are collected. */
export async function lookupRecordMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	requests: Readonly<Record<string, MediaRequest | null>>,
): Promise<{ lookups: Record<string, MediaLookup | null>; errors: LinkError[] }> {
	const lookups: Record<string, MediaLookup | null> = {};
	const errors: LinkError[] = [];
	for (const [field, request] of Object.entries(requests)) {
		if (request === null) {
			lookups[field] = null;
			continue;
		}
		const found = await findMedia(deps, cache, ctx, field, request);
		if (found.ok) lookups[field] = found.lookup;
		else errors.push(found.error);
	}
	return { lookups, errors };
}

/** A media field resolved in a real run; null for an empty value. */
export type ResolvedMedia = { request: MediaRequest; item: MediaInfo } | null;

/**
 * Obtains every looked-up field's item in a real run, one download at a time, stopping at the
 * first failure. `newMedia` lists each field and URL downloaded (`photo: https://…`), also when
 * the upload found identical bytes already stored.
 */
export async function obtainRecordMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	lookups: Readonly<Record<string, MediaLookup | null>>,
): Promise<
	| { ok: true; media: Record<string, ResolvedMedia>; newMedia: string[] }
	| { ok: false; errors: LinkError[]; newMedia: string[] }
> {
	const media: Record<string, ResolvedMedia> = {};
	const newMedia: string[] = [];
	for (const [field, lookup] of Object.entries(lookups)) {
		if (lookup === null) {
			media[field] = null;
			continue;
		}
		const obtained = await obtainMedia(deps, cache, ctx, lookup);
		if (!obtained.ok) return { ok: false, errors: [obtained.error], newMedia };
		if (obtained.downloaded) newMedia.push(`${field}: ${lookup.request.url}`);
		media[field] = { request: lookup.request, item: obtained.item };
	}
	return { ok: true, media, newMedia };
}

/**
 * The value an image or file field stores for a media item (EmDash's documented shape, F1).
 * Local media keeps its storage key in `meta`; `src` is never sent. A file value has no `size`,
 * which EmDash 1.2.0 drops on save (Fact V3).
 */
export function mediaFieldValue(
	kind: MediaKind,
	item: MediaInfo,
	alt: string | null,
): { [key: string]: JsonValue } {
	const base = {
		id: item.id,
		provider: "local",
		filename: item.filename,
		mimeType: item.mimeType,
	};
	const meta = { storageKey: item.storageKey };
	if (kind === "file") return { ...base, meta };
	return {
		...base,
		...(item.width === null ? {} : { width: item.width }),
		...(item.height === null ? {} : { height: item.height }),
		...(item.blurhash === null ? {} : { blurhash: item.blurhash }),
		...(item.dominantColor === null ? {} : { dominantColor: item.dominantColor }),
		...(alt === null ? {} : { alt }),
		meta,
	};
}

```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run media-resolve`
Expected: PASS (1 file, 16 tests). Full suite after this task: 47 files / 1,182 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/media.ts packages/flux-import/src/engine/resolve.ts packages/flux-import/tests/unit/media-resolve.test.ts
git commit -m "Resolve media through the map, downloading and uploading misses one at a time"
```

### Task 6: Media in the record plan

**Files:**
- Modify: `packages/flux-import/src/engine/diff.ts`
- Test: `packages/flux-import/tests/unit/diff.test.ts`

**Interfaces:**
- Consumes: Task 1 (`JsonValue` from `template.ts`); M4b `planRecord`.
- Produces: `src/engine/diff.ts`: `type MediaPlanItem = { mediaId: string | null; value: JsonValue | null; text: string; alt: string | null }`; `planRecord(template, mapped, current, links?, media?)` adds media changes after the data changes and before the links: the stored `id` (or a bare string) against `mediaId`, then `<field>.alt` when the mapped alt is given; an empty value equals nothing stored.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/diff.test.ts`, replace
```ts
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	planRecord,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
```
with:
```ts
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	type MediaPlanItem,
	planRecord,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
```

then replace
```ts
			],
		});
	});
});

```
with:
```ts
			],
		});
	});
});

describe("planRecord with media", () => {
	const record = { key: "P1", data: { title: "Chair" } };
	const item = (mediaId: string | null, alt: string | null = null): MediaPlanItem => ({
		mediaId,
		value: mediaId === null ? null : { id: mediaId, provider: "local" },
		text: mediaId ?? "new media from https://cdn.test/a.png",
		alt,
	});
	const stored = (data: Record<string, unknown>) => ({
		slug: null,
		data: { title: "Chair", ...data },
	});
	const plan = (data: Record<string, unknown>, media: Record<string, MediaPlanItem | null>) =>
		planRecord(stored(data), record, new Map(), undefined, media);

	it("compares the stored media ID, also when the value is a bare ID", () => {
		const photo = { id: "m1", provider: "local", width: 4, meta: { storageKey: "K1.png" } };
		expect(plan({ photo, manual: "m2" }, { photo: item("m1"), manual: item("m2") })).toEqual({
			action: "unchanged",
			changes: [],
		});
		expect(plan({ photo, manual: "m2" }, { photo: item("m3"), manual: item(null) })).toEqual({
			action: "update",
			changes: [
				{ field: "photo", before: "m1", after: "m3" },
				{ field: "manual", before: "m2", after: "new media from https://cdn.test/a.png" },
			],
		});
	});

	it("compares the alt only when the mapping gives one", () => {
		const photo = { id: "m1", alt: "Library alt" };
		expect(plan({ photo }, { photo: item("m1") }).action).toBe("unchanged");
		expect(plan({ photo }, { photo: item("m1", "Library alt") }).action).toBe("unchanged");
		expect(plan({ photo }, { photo: item("m1", "A red chair") })).toEqual({
			action: "update",
			changes: [{ field: "photo.alt", before: "Library alt", after: "A red chair" }],
		});
		expect(plan({ photo: { id: "m1" } }, { photo: item("m1", "A red chair") }).changes).toEqual([
			{ field: "photo.alt", before: null, after: "A red chair" },
		]);
	});

	it("treats an empty value as equal to nothing stored, and clears a stored one", () => {
		expect(plan({ photo: null }, { photo: null, manual: null }).action).toBe("unchanged");
		expect(plan({ photo: { id: "m1" } }, { photo: null })).toEqual({
			action: "update",
			changes: [{ field: "photo", before: "m1", after: null }],
		});
		expect(plan({ photo: { id: "m1" } }, { photo: item(null) }).changes).toEqual([
			{ field: "photo", before: "m1", after: "new media from https://cdn.test/a.png" },
		]);
	});

	it("lists a new entry's media after its fields", () => {
		expect(
			planRecord(
				null,
				record,
				new Map(),
				{
					resolved: { bylines: [{ group: "b1", value: "b1", text: "alex" }] },
					current: {},
					childSide: new Set(),
				},
				{ photo: item("m1", "Alt"), manual: null, icon: item(null) },
			),
		).toEqual({
			action: "create",
			changes: [
				{ field: "title", before: null, after: "Chair" },
				{ field: "photo", before: null, after: "m1" },
				{ field: "icon", before: null, after: "new media from https://cdn.test/a.png" },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run diff`
Expected: FAIL: the 4 new tests of 20 (`planRecord` ignores the media argument, so every case plans without media changes)

- [ ] **Step 3: Compare media**

In `packages/flux-import/src/engine/diff.ts`, replace
```ts
import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { FieldValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
export type PlanAction = "create" | "update" | "unchanged";
```
with:
```ts
import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { FieldValue, JsonValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
export type PlanAction = "create" | "update" | "unchanged";
```

then replace
```ts
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field or a link differs, else `unchanged`. `links` is given when the template maps links.
 */
export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
```
with:
```ts
	return changes;
}

/** A media field's resolved value, for `planRecord`; null for an empty value. */
export type MediaPlanItem = {
	/** The media item's ID; null for a file not stored yet, which is always a change. */
	mediaId: string | null;
	/** What the field is written with; null when `mediaId` is. */
	value: JsonValue | null;
	/** How the record shows it: the ID, or `new media from <url>`. */
	text: string;
	/** The mapped alt text; null when the mapping gives none, so the stored alt is not compared. */
	alt: string | null;
};

/** A stored image or file value's media ID: its `id`, or the value itself when it is a string. */
function storedMediaId(stored: unknown): string | null {
	if (typeof stored === "string") return stored;
	if (typeof stored === "object" && stored !== null && "id" in stored) {
		return typeof stored.id === "string" ? stored.id : null;
	}
	return null;
}

function storedAlt(stored: unknown): string | null {
	if (typeof stored !== "object" || stored === null || !("alt" in stored)) return null;
	return typeof stored.alt === "string" ? stored.alt : null;
}

/**
 * The media changes: a field whose stored media ID differs (a new file always does), or, with
 * the same ID, `<field>.alt` when the mapped alt is given and differs. Other keys of the stored
 * value are not compared: EmDash fills them on save. An empty value equals nothing stored.
 */
function mediaChanges(
	media: Readonly<Record<string, MediaPlanItem | null>>,
	data: Readonly<Record<string, unknown>> | null,
): Change[] {
	const changes: Change[] = [];
	for (const [field, item] of Object.entries(media)) {
		const stored = data !== null && Object.hasOwn(data, field) ? data[field] : null;
		const before = storedMediaId(stored);
		if (item === null) {
			if (stored !== null && stored !== undefined) changes.push({ field, before, after: null });
		} else if (item.mediaId === null || item.mediaId !== before) {
			changes.push({ field, before, after: item.text });
		} else if (item.alt !== null && storedAlt(stored) !== item.alt) {
			changes.push({ field: `${field}.alt`, before: storedAlt(stored), after: item.alt });
		}
	}
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field, a media field or a link differs, else `unchanged`. `links` is given when the template
 * maps links, `media` when it maps image or file fields.
 */
export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
	media?: Readonly<Record<string, MediaPlanItem | null>>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
```

then replace
```ts
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
```
with:
```ts
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (media) changes.push(...mediaChanges(media, null));
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
```

then replace
```ts
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}
```
with:
```ts
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	if (media) changes.push(...mediaChanges(media, current.data));
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run diff`
Expected: PASS (1 file, 20 tests). Full suite after this task: 47 files / 1,186 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/diff.ts packages/flux-import/tests/unit/diff.test.ts
git commit -m "Compare media fields by media ID and mapped alt in the record plan"
```

### Task 7: Batch integration, deferral and the Workers cap

**Files:**
- Modify: `packages/flux-import/src/engine/batch.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/media-import.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`, `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Job.mediaMaxBytes`, `mediaMaxBytes`), Task 5 (`lookupRecordMedia`, `obtainRecordMedia`, `mediaFieldValue`, `MediaDeferred`, `LookupCache.mediaDeadline`), Task 6 (`MediaPlanItem`, `planRecord`); M4b `processRecord`, `importPass`, `retryPass`, `runBatch`; E1, E2.
- Produces:
  - `src/engine/batch.ts`: `MEDIA_GRACE_MS` (20 s); `media_config` as a job error; per record: media lookups after the links, a provisional plan (misses and refresh hits as changes), draft and lock checks, downloads, the final plan and the write with media values in `data`; `newMedia` on the row; `importPass`/`retryPass` end the batch on `MediaDeferred` without advancing; `runBatch` sets `cache.mediaDeadline`.
  - `src/engine/types.ts`: `RecordRow.newMedia?: string[]`.
  - `src/plugin/service.ts`: `workersBatchCap` gives 10 when the template maps links or media; `src/plugin/routes.ts`: `jobs/create` passes `mediaMaxBytes(runtime.config.maxUploadSize, onWorkers())`; `src/plugin/definition.ts`: `media:write`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/media-import.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MEDIA_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import { mediaMapKey } from "../../src/engine/media.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const url = (name: string) => `https://cdn.test/${name}`;

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "photo", type: "image" },
	{ slug: "manual", type: "file" },
];
const template = (fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "Name", type: "text" },
		photo: { from: "Img", type: "image", alt: { from: "Alt" } },
		manual: { from: "Pdf", type: "file" },
		...fields,
	},
	...extra,
});
const HEADER = "sku,Name,Img,Alt,Pdf\n";

function serve(deps: Deps) {
	deps.mediaFetcher.files.set(url("a.png"), { body: PNG(1), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("b.png"), { body: PNG(2), contentType: "image/png" });
	deps.mediaFetcher.files.set(url("a.pdf"), { body: PDF, contentType: "application/pdf" });
}

async function start(
	deps: Deps,
	csv: string,
	opts: { dryRun?: boolean; tpl?: Record<string, unknown>; budgetMs?: number } = {},
) {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	return createJob(deps, {
		uploadId: upload,
		template: opts.tpl ?? template(),
		schemaFields: [...schemaFields, { slug: "flux_source_id", type: "string" }],
		mediaMaxBytes: 1000,
		...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
	});
}

async function runToEnd(deps: Deps, id: string, budget?: number): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver", Number.POSITIVE_INFINITY, budget);
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function rows(deps: Deps, jobId: string): Promise<RecordRow[]> {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((i) => i.data);
}

const entryData = (deps: Deps) =>
	[...deps.content.entries.values()].map((e) => ({ id: e.id, ...e.data }));

const CSV = `${HEADER}A1,Chair,${url("a.png")},A red chair,${url("a.pdf")}\nA2,Lamp,${url("b.png")},,\n`;

describe("importing media", () => {
	it("downloads, uploads and writes image and file values, and re-runs unchanged", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(entryData(deps)).toEqual([
			{
				id: "e1",
				title: "Chair",
				photo: {
					id: "m1",
					provider: "local",
					filename: "a.png",
					mimeType: "image/png",
					width: 4,
					height: 3,
					blurhash: "bh1",
					dominantColor: "rgb(1,2,3)",
					alt: "A red chair",
					meta: { storageKey: "K1.png" },
				},
				manual: {
					id: "m2",
					provider: "local",
					filename: "a.pdf",
					mimeType: "application/pdf",
					meta: { storageKey: "K2.pdf" },
				},
				flux_source_id: "A1",
			},
			expect.objectContaining({
				id: "e2",
				photo: expect.objectContaining({ id: "m3" }),
				manual: null,
			}),
		]);
		const first = await rows(deps, job.id);
		expect(first.map((r) => [r.status, r.newMedia])).toEqual([
			["created", [`photo: ${url("a.png")}`, `manual: ${url("a.pdf")}`]],
			["created", [`photo: ${url("b.png")}`]],
		]);
		expect(first[0]?.changes).toEqual([
			{ field: "title", before: null, after: "Chair" },
			{ field: "photo", before: null, after: "m1" },
			{ field: "manual", before: null, after: "m2" },
		]);
		expect(deps.media.items.get("m1")?.alt).toBe("A red chair");

		const again = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(again.counters).toMatchObject({ unchanged: 2 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
		expect((await rows(deps, again.id)).every((r) => r.newMedia === undefined)).toBe(true);
	});

	it("plans a dry run without downloading, listing what a real run would download", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const dry = await runToEnd(deps, (await start(deps, CSV, { dryRun: true })).id);
		expect(deps.mediaFetcher.calls).toEqual([]);
		const planned = await rows(deps, dry.id);
		expect(planned.map((r) => [r.status, r.action, r.newMedia])).toEqual([
			["planned", "create", [`photo: ${url("a.png")}`, `manual: ${url("a.pdf")}`]],
			["planned", "create", [`photo: ${url("b.png")}`]],
		]);
		expect(planned[0]?.changes).toContainEqual({
			field: "photo",
			before: null,
			after: `new media from ${url("a.png")}`,
		});
		await runToEnd(deps, (await start(deps, CSV)).id);
		const after = await runToEnd(deps, (await start(deps, CSV, { dryRun: true })).id);
		expect(after.counters).toMatchObject({ unchanged: 2 });
		expect(deps.mediaFetcher.calls).toHaveLength(3);
	});

	it("updates only what changed: a new file, an alt, a cleared field", async () => {
		const { deps } = makeDeps();
		serve(deps);
		await runToEnd(deps, (await start(deps, CSV)).id);
		const changed = `${HEADER}A1,Chair,${url("b.png")},A red chair,\nA2,Lamp,${url("b.png")},A lamp,\n`;
		const job = await runToEnd(deps, (await start(deps, changed)).id);
		expect(job.counters).toMatchObject({ updated: 2 });
		const [a1, a2] = await rows(deps, job.id);
		expect(a1?.changes).toEqual([
			{ field: "photo", before: "m1", after: "m3" },
			{ field: "manual", before: "m2", after: null },
		]);
		expect(a2?.changes).toEqual([{ field: "photo.alt", before: null, after: "A lamp" }]);
		expect(entryData(deps)[1]).toMatchObject({ photo: { id: "m3", alt: "A lamp" } });
		expect(entryData(deps)[0]).toMatchObject({
			photo: { id: "m3", alt: "A red chair" },
			manual: null,
		});
	});

	it("downloads nothing for a record with a lookup error, and reports every error", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.mediaFetcher.blocked.add("evil.test");
		deps.lookups.defs.push({
			name: "tag",
			hierarchical: false,
			collections: ["products"],
			locale: "en",
		});
		const tpl = template({}, { taxonomies: { tag: { from: "Name" } } });
		const csv = `${HEADER}A1,missing,${url("a.png")},,https://evil.test/a.pdf\n`;
		const upload = `u${deps.source.uploads.size + 1}`;
		deps.source.add(upload, csv);
		const created = await createJob(deps, {
			uploadId: upload,
			template: tpl,
			schemaFields,
			linkSchema: { taxonomies: deps.lookups.defs },
		});
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ failed: 1 });
		expect((await rows(deps, job.id))[0]?.errors?.map((e) => `${e.field}:${e.code}`)).toEqual([
			"taxonomies.tag:term_not_found",
			"manual:media_blocked",
		]);
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("downloads nothing for an entry that is locked or has someone else's draft", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const plain = `${HEADER}A1,Chair,,,\nA2,Lamp,,,\n`;
		await runToEnd(deps, (await start(deps, plain)).id);
		deps.content.locked.add("e1");
		const e2 = deps.content.entries.get("e2")!;
		e2.pendingPublish = true;
		e2.rev++;
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job.counters).toMatchObject({ locked: 1, conflict: 1 });
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("fails a record whose download fails, listing what it stored, and keeps it for the next run", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.mediaFetcher.files.delete(url("a.pdf"));
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		const [a1] = await rows(deps, job.id);
		expect(a1).toMatchObject({
			status: "failed",
			action: "create",
			errors: [
				{ field: "manual", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			newMedia: [`photo: ${url("a.png")}`],
		});
		expect(deps.content.entries.size).toBe(1);
		serve(deps);
		const retried = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(retried.counters).toMatchObject({ created: 1, unchanged: 1 });
		expect(deps.mediaFetcher.urls().filter((u) => u === url("a.png"))).toHaveLength(1);
	});

	it("fails the job when EmDash cannot store media", async () => {
		const { deps } = makeDeps();
		serve(deps);
		deps.media.failUpload = () => new MediaUploadError("NO_STORAGE", "Storage not configured");
		const job = await runToEnd(deps, (await start(deps, CSV)).id);
		expect(job).toMatchObject({
			status: "failed",
			error: { code: "media_config", message: "EmDash cannot store media: Storage not configured" },
		});
	});

	it("leaves a record whose next download is too late for the next batch, without downloading twice", async () => {
		const { deps, clock } = makeDeps();
		serve(deps);
		deps.mediaFetcher.files.set(url("a.png"), {
			body: PNG(1),
			contentType: "image/png",
			ms: 1000 + MEDIA_GRACE_MS,
		});
		const created = await start(deps, CSV, { budgetMs: 1000 });
		const first = await runBatch(deps, created.id, "driver");
		expect(first.cursor.seq).toBe(0);
		expect(await rows(deps, created.id)).toEqual([]);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		expect(await deps.mediaMap.get(mediaMapKey(url("a.png")))).not.toBeNull();
		clock.t += 60_000;
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ created: 2 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
	});

	it("ends a batch after the record that spends the lookup budget", async () => {
		const { deps } = makeDeps();
		let csv = HEADER;
		for (let i = 0; i < 12; i++) {
			deps.mediaFetcher.files.set(url(`${i}.png`), { body: PNG(i), contentType: "image/png" });
			csv += `S${i},Item,${url(`${i}.png`)},,\n`;
		}
		const created = await start(deps, csv);
		// Each record: 25, a map lookup 1, a download 60.
		const job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		expect(job.cursor.seq).toBe(7);
	});

	it("leaves templates without media as before", async () => {
		const { deps } = makeDeps();
		serve(deps);
		const tpl = { ...template(), fields: { title: { from: "Name", type: "text" } } };
		const job = await runToEnd(deps, (await start(deps, CSV, { tpl })).id);
		expect(job).not.toHaveProperty("mediaMaxBytes");
		expect(job.counters).toMatchObject({ created: 2 });
		expect(deps.mediaMap.rows.size).toBe(0);
		expect(deps.media.calls).toEqual([]);
		expect((await rows(deps, job.id)).every((r) => r.newMedia === undefined)).toBe(true);
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			// definePlugin adds the read capability that taxonomies:write implies.
			"taxonomies:read",
		]);
	});

```
with:
```ts
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			"media:write",
			// definePlugin adds the read capabilities that taxonomies:write and media:write imply.
			"taxonomies:read",
			"media:read",
		]);
	});

```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
			fields: { ...job.template.fields, maker: { from: "Name", type: "reference" as const } },
		};
		expect(workersBatchCap({ ...job, template: referenced })).toBe(WORKERS_LINKED_BATCH_CAP);
	});
});

```
with:
```ts
			fields: { ...job.template.fields, maker: { from: "Name", type: "reference" as const } },
		};
		expect(workersBatchCap({ ...job, template: referenced })).toBe(WORKERS_LINKED_BATCH_CAP);
		const pictured = {
			...job.template,
			fields: { ...job.template.fields, photo: { from: "Name", type: "image" as const } },
		};
		expect(workersBatchCap({ ...job, template: pictured })).toBe(WORKERS_LINKED_BATCH_CAP);
	});
});

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run media-import definition service`
Expected: FAIL: 11 of 54: in `media-import.test.ts` 9 of 10 (all but "leaves templates without media as before"), in `service.test.ts` "caps jobs that map links at 10 records" (a media template still gets 20) and in `definition.test.ts` "has the retention setting, the activate hook and the cron hook" (no `media:write` yet)

- [ ] **Step 3: Look up, download and write media in batches**

In `packages/flux-import/src/engine/types.ts`, replace
```ts
	 * Absent when there are none.
	 */
	newTerms?: string[];
	updatedAt: string;
}

```
with:
```ts
	 * Absent when there are none.
	 */
	newTerms?: string[];
	/**
	 * Media downloaded for the record (`field: url`), also when the upload found identical bytes
	 * already stored, or that a dry run would download. Absent when there are none.
	 */
	newMedia?: string[];
	updatedAt: string;
}

```

In `packages/flux-import/src/engine/batch.ts`, replace
```ts
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type PlanAction,
	planRecord,
	type RecordPlan,
```
with:
```ts
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type MediaPlanItem,
	type PlanAction,
	planRecord,
	type RecordPlan,
```

then replace
```ts
} from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	SourceMissingError,
} from "./ports.js";
import {
```
with:
```ts
} from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
	lookupRecordMedia,
	type MediaContext,
	MediaDeferred,
	type MediaLookup,
	mediaFieldValue,
	obtainRecordMedia,
	type ResolvedMedia,
} from "./media.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	type MediaInfo,
	SourceMissingError,
} from "./ports.js";
import {
```

then replace
```ts
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	filterRecord,
	type MappedRecord,
	SOURCE_ID_FIELD,
} from "./template.js";
import {
```
with:
```ts
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	type FieldValue,
	filterRecord,
	type MappedRecord,
	type MediaRequest,
	SOURCE_ID_FIELD,
} from "./template.js";
import {
```

then replace
```ts
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
const CAS_ATTEMPTS = 5;
/** Content errors that fail the job rather than the record being written. */
const JOB_LEVEL_WRITE_ERRORS: ReadonlySet<string> = new Set([
	"collection_missing",
	"source_id_field_invalid",
]);

type Outcome = { done: boolean; error?: { code: string; message: string } };
```
with:
```ts
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
/**
 * Media downloads must end this long after the batch's budget (`LookupCache.mediaDeadline`),
 * which leaves 10 s of the lease for the record's write and publish.
 */
export const MEDIA_GRACE_MS = 20_000;
const CAS_ATTEMPTS = 5;
/** Content errors that fail the job rather than the record being written. */
const JOB_LEVEL_WRITE_ERRORS: ReadonlySet<string> = new Set([
	"collection_missing",
	"source_id_field_invalid",
	"media_config",
]);

type Outcome = { done: boolean; error?: { code: string; message: string } };
```

then replace
```ts
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
};

const PENDING_DRAFT_MESSAGE =
```
with:
```ts
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
	/** The record's media field values, written with the data; absent when it maps none. */
	media?: Record<string, MediaPlanItem | null>;
};

const PENDING_DRAFT_MESSAGE =
```

then replace
```ts
	return { resolved, current, childSide };
}

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, whatever happens to the record afterwards.
 */
async function decide(
	deps: EngineDeps,
```
with:
```ts
	return { resolved, current, childSide };
}

/** What a record found to create or download, listed on its row whatever happens to it. */
type Found = { newTerms: string[]; newMedia: string[] };

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, and media it downloads (or would) as `newMedia`, whatever
 * happens to the record afterwards.
 */
async function decide(
	deps: EngineDeps,
```

then replace
```ts
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found = { newTerms: [] as string[] };
	const row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	// A retried record keeps the terms its earlier attempts created.
	const newTerms = [...new Set([...(existing?.newTerms ?? []), ...found.newTerms])];
	return newTerms.length > 0 ? { ...row, newTerms } : row;
}

async function decideRecord(
```
with:
```ts
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found: Found = { newTerms: [], newMedia: [] };
	const row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	// A retried record keeps the terms and media its earlier attempts created.
	const newTerms = [...new Set([...(existing?.newTerms ?? []), ...found.newTerms])];
	const newMedia = [...new Set([...(existing?.newMedia ?? []), ...found.newMedia])];
	return {
		...row,
		...(newTerms.length > 0 ? { newTerms } : {}),
		...(newMedia.length > 0 ? { newMedia } : {}),
	};
}

function mediaContext(job: Job): MediaContext {
	return {
		jobId: job.id,
		dryRun: job.dryRun,
		maxBytes: job.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
		targets: job.targetFields ?? {},
	};
}

function mediaItem(request: MediaRequest, item: MediaInfo | null): MediaPlanItem {
	if (item === null) {
		const text = `new media from ${request.url}`;
		return { mediaId: null, value: null, text, alt: request.alt };
	}
	const value = mediaFieldValue(request.kind, item, request.alt);
	return { mediaId: item.id, value, text: item.id, alt: request.alt };
}

/**
 * The media plan before any download: a hit as its item, and a miss (or, in a real run, a hit
 * to refresh) as a file not stored yet, which is always a change.
 */
function lookedUpMedia(
	lookups: Readonly<Record<string, MediaLookup | null>>,
	dryRun: boolean,
): Record<string, MediaPlanItem | null> {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, lookup] of Object.entries(lookups)) {
		const stays = lookup?.item && (dryRun || !lookup.request.refresh);
		plan[field] = lookup === null ? null : mediaItem(lookup.request, stays ? lookup.item : null);
	}
	return plan;
}

function obtainedMedia(media: Readonly<Record<string, ResolvedMedia>>) {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, resolved] of Object.entries(media)) {
		plan[field] = resolved === null ? null : mediaItem(resolved.request, resolved.item);
	}
	return plan;
}

async function decideRecord(
```

then replace
```ts
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: { newTerms: string[] },
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
```
with:
```ts
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: Found,
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
```

then replace
```ts
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		if (requests) cache.spend(COST_RECORD);
		if (requests) {
			const resolution = await resolveLinks(
				deps,
```
with:
```ts
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		const mediaRequests = mapped.value.media;
		if (requests || mediaRequests) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
				deps,
```

then replace
```ts
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (!resolution.ok) {
				return { status: "failed", sourceKey, entryId: null, errors: resolution.errors };
			}
			ctx.links = resolution.links;
		}
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
```
with:
```ts
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (resolution.ok) ctx.links = resolution.links;
			else errors.push(...resolution.errors);
		}
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
		if (mediaRequests) {
			const looked = await lookupRecordMedia(deps, cache, mediaContext(job), mediaRequests);
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
```

then replace
```ts
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		const plan = planRecord(entry, mapped.value, comparisons, links);
		action = plan.action;
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (!entry) return await writeRecord(ctx, null, plan, mapped.value);
		if (plan.action === "unchanged")
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
			const code = "pending_draft";
			return notImported("conflict", sourceKey, entry.id, plan.action, code, PENDING_DRAFT_MESSAGE);
		}
		if (await deps.content.isLocked(collection, locale, entry.id)) {
			return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
		}
		return await writeRecord(ctx, entry, plan, mapped.value);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
```
with:
```ts
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun) : undefined;
		const plan = planRecord(entry, mapped.value, comparisons, links, media);
		action = plan.action;
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			for (const [field, item] of Object.entries(media ?? {})) {
				const url = mediaRequests?.[field]?.url;
				if (item?.mediaId === null && url) found.newMedia.push(`${field}: ${url}`);
			}
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
			if (plan.action === "unchanged")
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
					"conflict",
					sourceKey,
					entry.id,
					plan.action,
					code,
					PENDING_DRAFT_MESSAGE,
				);
			}
			if (await deps.content.isLocked(collection, locale, entry.id)) {
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups) return await writeRecord(ctx, entry, plan, mapped.value);
		// Downloads only for a record that will be written, after the draft and lock checks.
		const obtained = await obtainRecordMedia(deps, cache, mediaContext(job), lookups);
		found.newMedia = obtained.newMedia;
		if (!obtained.ok) {
			return { status: "failed", sourceKey, entryId, action: plan.action, errors: obtained.errors };
		}
		ctx.media = obtainedMedia(obtained.media);
		const final = planRecord(entry, mapped.value, comparisons, links, ctx.media);
		action = final.action;
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, mapped.value);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
```

then replace
```ts
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	let written: { id: string; rev: string };
	if (!entry) {
		written = await deps.content.create({
			collection,
			locale,
			...slugPart,
			data: { ...mapped.data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out: on a collection with revisions that
		// would stage a draft identical to the live entry.
		const dataChanged = plan.changes.some(
			(c) => c.field === "slug" || Object.hasOwn(mapped.data, c.field),
		);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data: mapped.data } : {}),
			...updateLinks(ctx.links, plan, entry),
		});
		if (!result.ok) {
```
with:
```ts
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media fields are data fields: their values (null clears one) are written with the rest.
	const media: Record<string, FieldValue> = {};
	for (const [field, item] of Object.entries(ctx.media ?? {})) media[field] = item?.value ?? null;
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry) {
		written = await deps.content.create({
			collection,
			locale,
			...slugPart,
			data: { ...data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out: on a collection with revisions that
		// would stage a draft identical to the live entry. A media alt change is a data change.
		const dataChanged = plan.changes.some(
			(c) =>
				c.field === "slug" ||
				Object.hasOwn(data, c.field) ||
				(c.field.endsWith(".alt") && Object.hasOwn(media, c.field.slice(0, -4))),
		);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data } : {}),
			...updateLinks(ctx.links, plan, entry),
		});
		if (!result.ok) {
```

then replace
```ts
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		await processRecord(deps, job, template, rec, { retry: false, cache });
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
```
with:
```ts
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		try {
			await processRecord(deps, job, template, rec, { retry: false, cache });
		} catch (e) {
			// Not saved and not counted: the next batch processes the record again.
			if (e instanceof MediaDeferred) return { done: false };
			throw e;
		}
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
```

then replace
```ts
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			await processRecord(deps, job, template, rec, { retry: true, cache });
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
```
with:
```ts
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			try {
				await processRecord(deps, job, template, rec, { retry: true, cache });
			} catch (e) {
				if (e instanceof MediaDeferred) return { done: false };
				throw e;
			}
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
```

then replace
```ts
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link lookups are cached for the batch, and the batch ends
 * after the record that brings their cost to `lookupBudget` (that record always completes).
 */
export async function runBatch(
	deps: EngineDeps,
```
with:
```ts
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link and media lookups are cached for the batch, and the
 * batch ends after the record that brings their cost to `lookupBudget` (that record always
 * completes). Media downloads end by the budget plus `MEDIA_GRACE_MS`; a record whose next
 * download would start later is left for the next batch.
 */
export async function runBatch(
	deps: EngineDeps,
```

then replace
```ts
	const cap = typeof maxRecords === "number" ? maxRecords : maxRecords(job);
	const limit = Math.min(job.batchSize, cap);
	const cache = new LookupCache(job.dryRun ? (job.plannedTerms ?? []) : [], lookupBudget);
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
```
with:
```ts
	const cap = typeof maxRecords === "number" ? maxRecords : maxRecords(job);
	const limit = Math.min(job.batchSize, cap);
	const cache = new LookupCache(job.dryRun ? (job.plannedTerms ?? []) : [], lookupBudget);
	cache.mediaDeadline = started + job.budgetMs + MEDIA_GRACE_MS;
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
```

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
import { DEFAULT_MAX_UPLOAD_SIZE } from "../engine/media.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```
with:
```ts
import { DEFAULT_MAX_UPLOAD_SIZE } from "../engine/media.js";
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
import { type LinkSchema, type SchemaField, usesLinks, usesMedia } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";
import {
```

then replace
```ts
 */
export const WORKERS_BATCH_CAP = 20;
/**
 * `WORKERS_BATCH_CAP` for jobs whose template maps reference fields, taxonomies or bylines: each
 * record also looks its links up and reads them back.
 */
export const WORKERS_LINKED_BATCH_CAP = 10;

```
with:
```ts
 */
export const WORKERS_BATCH_CAP = 20;
/**
 * `WORKERS_BATCH_CAP` for jobs whose template maps reference fields, taxonomies, bylines or
 * media: each record also looks its links and media up, and may download files.
 */
export const WORKERS_LINKED_BATCH_CAP = 10;

```

then replace
```ts

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	return usesLinks(job.template) ? WORKERS_LINKED_BATCH_CAP : WORKERS_BATCH_CAP;
}

/** A failure the route layer turns into an HTTP error with this code and status. */
```
with:
```ts

/** The records one jobs/next call processes on Workers for this job. */
export function workersBatchCap(job: Job): number {
	return usesLinks(job.template) || usesMedia(job.template)
		? WORKERS_LINKED_BATCH_CAP
		: WORKERS_BATCH_CAP;
}

/** A failure the route layer turns into an HTTP error with this code and status. */
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
	jobLogCsv,
	listJobs,
	listRecords,
	nextBatch,
	PASTE_MAX_BYTES,
	SAMPLE_MAX,
```
with:
```ts
	jobLogCsv,
	listJobs,
	listRecords,
	mediaMaxBytes,
	nextBatch,
	PASTE_MAX_BYTES,
	SAMPLE_MAX,
```

then replace
```ts
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
```
with:
```ts
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
					...(siteTimezone === undefined ? {} : { siteTimezone }),
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
		// gives ctx.taxonomies, which reads taxonomies, terms and entry terms and creates missing
		// terms (createTerm, the only sanctioned way to create one); bylines:read gives
		// ctx.bylines, whose list is the only way to look bylines up. Entries are assigned their
		// terms, references and bylines through the runtime's content writes. URL sources are
		// fetched with the runtime's own fetch() behind the plugin's SSRF guard
		// (src/sources/net.ts), not through ctx.http, so no network capability is declared.
		capabilities: [
			"content:read",
			"content:write",
```
with:
```ts
		// gives ctx.taxonomies, which reads taxonomies, terms and entry terms and creates missing
		// terms (createTerm, the only sanctioned way to create one); bylines:read gives
		// ctx.bylines, whose list is the only way to look bylines up. Entries are assigned their
		// terms, references and bylines through the runtime's content writes. media:write is
		// declared for disclosure too: image and file fields are uploaded through the runtime's
		// handleMediaUpload, not ctx.media. URL sources and media are fetched with the runtime's
		// own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through ctx.http,
		// so no network capability is declared.
		capabilities: [
			"content:read",
			"content:write",
```

then replace
```ts
			"schema:read",
			"taxonomies:write",
			"bylines:read",
		],
		storage: STORAGE,
		routes,
```
with:
```ts
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			"media:write",
		],
		storage: STORAGE,
		routes,
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run media-import definition service`
Expected: PASS (3 files, 54 tests). Full suite after this task: 48 files / 1,196 tests

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/batch.ts packages/flux-import/src/engine/types.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/media-import.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Download media only for records that can be written, defer late downloads, and declare media:write"
```

### Task 8: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/fixtures/media.ts`, `packages/flux-import/tests/integration/media.test.ts`
- Modify: `packages/flux-import/tests/integration/feed-server.ts`, `packages/flux-import/tests/integration/server.ts`, `sites/dev/astro.config.mjs`

**Interfaces:**
- Consumes: Tasks 1-7 through HTTP; the integration harness (`Client`, `runToEnd`, `records`, `listAll`, `raw`, `startServer`, `FeedServer`); E3; V1-V4.
- Produces: `tests/fixtures/media.ts` (`RED_PNG`, `BLUE_PNG`, `GREEN_JPEG`, `MANUAL_PDF`, `SVG`, `HTML`, `largePng(n)`, `createMediaSchema(client, collection)`, `mediaTemplate(collection, { refresh? })`, `mediaCsv(rows)`, `type StoredMedia`); `Feed.contentType` (`null` sends none) and `Feed.delayMs`; `startServer(…, maxUploadSize?)` passing `FLUX_DEV_MAX_UPLOAD_SIZE`, which `sites/dev/astro.config.mjs` gives to `emdash({ maxUploadSize })`; six integration tests on their own server (port 4394, `allowPrivateNetwork`, upload limit 100,000 bytes).

- [ ] **Step 1: Add the fixture, the harness options and the tests**

Create `packages/flux-import/tests/fixtures/media.ts`:
```ts
/**
 * Files, schema and templates for the M4c media imports on the Node and workerd sites: two
 * 4 x 3 PNGs and a JPEG (real images, so EmDash reads their size and makes a placeholder), a
 * small PDF, and markup that must never be imported.
 */
import type { Client } from "../integration/client.js";

const base64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export const RED_PNG = base64(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR42mM8ISfHAANMDEgAhQMAJtoBCpDU3DQAAAAASUVORK5CYII=",
);
export const BLUE_PNG = base64(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR42mOUqzjBAANMDEgAhQMAMogBZLjEXE0AAAAASUVORK5CYII=",
);
export const GREEN_JPEG = base64(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCeiiivkD8qP//Z",
);
export const MANUAL_PDF = new TextEncoder().encode(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
export const HTML = "<!doctype html><title>Not found</title><p>Sorry</p>";

/** `n` bytes that start like a PNG: too large to import wherever `n` is over the limit. */
export function largePng(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	bytes.set(RED_PNG.subarray(0, 8));
	return bytes;
}

/**
 * Creates a collection (with revisions) with `title`, an image field `photo`, a file field
 * `manual`, and a file field `scan` that accepts only PNG and JPEG.
 */
export async function createMediaSchema(client: Client, collection: string): Promise<void> {
	await client.createCollection(collection);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "manual", label: "Manual", type: "file" },
		{
			slug: "scan",
			label: "Scan",
			type: "file",
			validation: { allowedMimeTypes: ["image/png", "image/jpeg"] },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

/** Photo with alt, manual, and scan; `refresh` on the photo when asked. */
export function mediaTemplate(collection: string, opts: { refresh?: boolean } = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			photo: {
				from: "Photo",
				type: "image",
				alt: { from: "Alt" },
				...(opts.refresh ? { refresh: true } : {}),
			},
			manual: { from: "Manual", type: "file" },
			scan: { from: "Scan", type: "file" },
		},
	};
}

/** One CSV row per record: `[sku, name, photo URL, alt, manual URL, scan URL]`. */
export function mediaCsv(rows: string[][]): string {
	return ["sku,Name,Photo,Alt,Manual,Scan", ...rows.map((r) => r.join(","))].join("\n");
}

/** A stored image or file value, as the content API reads it back. */
export type StoredMedia = {
	id: string;
	provider: string;
	filename: string;
	mimeType: string;
	alt?: string;
	width?: number;
	height?: number;
	blurhash?: string;
	meta: { storageKey: string };
};
```

In `packages/flux-import/tests/integration/feed-server.ts`, replace
```ts
	authorization?: string;
	/** Sends the body in two chunks without a Content-Length (Transfer-Encoding: chunked). */
	chunked?: boolean;
}

/**
```
with:
```ts
	authorization?: string;
	/** Sends the body in two chunks without a Content-Length (Transfer-Encoding: chunked). */
	chunked?: boolean;
	/** The `Content-Type` sent; `text/csv` when absent, none when null. */
	contentType?: string | null;
	/** Sends the headers and half the body, then the rest after this many milliseconds. */
	delayMs?: number;
}

/**
```

then replace
```ts
				body?: string | Uint8Array,
			) => {
				this.requests.push({ path, headers: req.headers, status });
				if (feed?.chunked && status === 200 && body !== undefined) {
					res.writeHead(status, headers);
					const half = Math.floor(body.length / 2);
					res.write(body.slice(0, half));
					setTimeout(() => res.end(body.slice(half)), 20);
					return;
				}
				res.writeHead(status, {
					...headers,
					...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
				});
				res.end(body);
			};
			if (!feed) return send(404, {}, "not found");
```
with:
```ts
				body?: string | Uint8Array,
			) => {
				this.requests.push({ path, headers: req.headers, status });
				const length =
					body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) };
				if ((feed?.chunked || feed?.delayMs) && status === 200 && body !== undefined) {
					res.writeHead(status, feed.chunked ? headers : { ...headers, ...length });
					const half = Math.floor(body.length / 2);
					res.write(body.slice(0, half));
					setTimeout(() => res.end(body.slice(half)), feed.delayMs ?? 20);
					return;
				}
				res.writeHead(status, { ...headers, ...length });
				res.end(body);
			};
			if (!feed) return send(404, {}, "not found");
```

then replace
```ts
			}
			const tag = `"${createHash("sha256").update(feed.body).digest("hex").slice(0, 16)}"`;
			if (feed.etag && req.headers["if-none-match"] === tag) return send(304, { etag: tag });
			send(200, { "content-type": "text/csv", ...(feed.etag ? { etag: tag } : {}) }, feed.body);
		});
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
```
with:
```ts
			}
			const tag = `"${createHash("sha256").update(feed.body).digest("hex").slice(0, 16)}"`;
			if (feed.etag && req.headers["if-none-match"] === tag) return send(304, { etag: tag });
			const type = feed.contentType === undefined ? "text/csv" : feed.contentType;
			send(
				200,
				{ ...(type === null ? {} : { "content-type": type }), ...(feed.etag ? { etag: tag } : {}) },
				feed.body,
			);
		});
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
```

In `packages/flux-import/tests/integration/server.ts`, replace
```ts

/**
 * Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted), with
 * an upload limit of `maxSourceBytes`. `allowPrivateNetwork` lets URL sources reach this machine.
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
	allowPrivateNetwork = false,
): Promise<DevServer> {
	const root = dir ?? (await mkdtemp(join(tmpdir(), "flux-import-it-")));
	const dbPath = join(root, "test.db");
```
with:
```ts

/**
 * Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted), with
 * an upload limit of `maxSourceBytes`. `allowPrivateNetwork` lets URL sources and media reach
 * this machine; `maxUploadSize` sets EmDash's media upload limit.
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
	allowPrivateNetwork = false,
	maxUploadSize?: number,
): Promise<DevServer> {
	const root = dir ?? (await mkdtemp(join(tmpdir(), "flux-import-it-")));
	const dbPath = join(root, "test.db");
```

then replace
```ts
			FLUX_DEV_UPLOADS: uploadsDir,
			FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),
			FLUX_DEV_ALLOW_PRIVATE_NETWORK: allowPrivateNetwork ? "1" : "0",
			EMDASH_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
		});
	} catch (e) {
```
with:
```ts
			FLUX_DEV_UPLOADS: uploadsDir,
			FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),
			FLUX_DEV_ALLOW_PRIVATE_NETWORK: allowPrivateNetwork ? "1" : "0",
			...(maxUploadSize === undefined ? {} : { FLUX_DEV_MAX_UPLOAD_SIZE: String(maxUploadSize) }),
			EMDASH_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
		});
	} catch (e) {
```

In `sites/dev/astro.config.mjs`, replace
```js
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
// URL source tests fetch from a local HTTP server; the option only works under `astro dev`.
const allowPrivateNetwork = process.env.FLUX_DEV_ALLOW_PRIVATE_NETWORK === "1";

export default defineConfig({
	output: "server",
```
with:
```js
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
// URL source tests fetch from a local HTTP server; the option only works under `astro dev`.
const allowPrivateNetwork = process.env.FLUX_DEV_ALLOW_PRIVATE_NETWORK === "1";
// Media tests lower EmDash's upload limit, so a too-large file stays small.
const maxUploadSize = Number(process.env.FLUX_DEV_MAX_UPLOAD_SIZE) || undefined;

export default defineConfig({
	output: "server",
```

then replace
```js
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
		fluxImportRoutes({ ...(maxSourceBytes ? { maxSourceBytes } : {}), allowPrivateNetwork }),
	],
```
with:
```js
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
			...(maxUploadSize ? { maxUploadSize } : {}),
		}),
		fluxImportRoutes({ ...(maxSourceBytes ? { maxSourceBytes } : {}), allowPrivateNetwork }),
	],
```

Create `packages/flux-import/tests/integration/media.test.ts`:
```ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	BLUE_PNG,
	createMediaSchema,
	GREEN_JPEG,
	HTML,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	RED_PNG,
	type StoredMedia,
	SVG,
} from "../fixtures/media.js";
import { Client, devBypass } from "./client.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4394;
/** EmDash's upload limit on this server, so a too-large file stays small. */
const MAX_UPLOAD = 100_000;

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: media is fetched from 127.0.0.1 (allowPrivateNetwork), with a lower limit.
	server = await startServer(PORT, undefined, undefined, true, MAX_UPLOAD);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

/** The bytes with a tag after them, so each test's files are distinct to EmDash's dedupe. */
const tagged = (bytes: Uint8Array, tag: string) =>
	new Uint8Array([...bytes, ...new TextEncoder().encode(tag)]);

async function importCsv(
	collection: string,
	csv: string,
	opts: { dryRun?: boolean; refresh?: boolean; budgetMs?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: mediaTemplate(collection, { refresh: opts.refresh ?? false }),
		dryRun: opts.dryRun ?? false,
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function stored(collection: string): Promise<Map<string, Record<string, unknown>>> {
	return new Map(
		(await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e.data]),
	);
}

const media = (data: Record<string, unknown> | undefined, field: string) =>
	data?.[field] as StoredMedia | null | undefined;

describe("media from URL on Node", () => {
	it("imports an image with alt and a file, serves them with their types, and re-runs unchanged", async () => {
		await createMediaSchema(client, "it_media");
		feeds.feeds.set("/t1/chair.png", { body: tagged(RED_PNG, "t1"), contentType: "image/png" });
		feeds.feeds.set("/t1/lamp", { body: tagged(GREEN_JPEG, "t1"), contentType: null });
		feeds.feeds.set("/t1/manual.pdf", { body: MANUAL_PDF, contentType: "application/pdf" });
		const csv = mediaCsv([
			["P1", "Chair", feeds.url("/t1/chair.png"), "A red chair", feeds.url("/t1/manual.pdf"), ""],
			["P2", "Lamp", feeds.url("/t1/lamp"), "", "", ""],
		]);
		const { job, rows } = await importCsv("it_media", csv);
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(rows.map((r) => r.newMedia)).toEqual([
			[`photo: ${feeds.url("/t1/chair.png")}`, `manual: ${feeds.url("/t1/manual.pdf")}`],
			[`photo: ${feeds.url("/t1/lamp")}`],
		]);
		const entries = await stored("it_media");
		const chair = media(entries.get("P1"), "photo");
		expect(chair).toMatchObject({
			provider: "local",
			filename: "chair.png",
			mimeType: "image/png",
			width: 4,
			height: 3,
			alt: "A red chair",
		});
		expect(chair?.blurhash).toEqual(expect.any(String));
		expect(media(entries.get("P1"), "manual")).toMatchObject({
			filename: "manual.pdf",
			mimeType: "application/pdf",
		});
		expect(media(entries.get("P2"), "photo")).toMatchObject({
			filename: "lamp.jpg",
			mimeType: "image/jpeg",
		});
		expect(media(entries.get("P2"), "photo")).not.toHaveProperty("alt");
		const item = await client.api<{ item: { alt: string | null } }>(
			"GET",
			`/_emdash/api/media/${chair?.id}`,
		);
		expect(item.item.alt).toBe("A red chair");
		for (const [field, key, type] of [
			["photo", "P1", "image/png"],
			["manual", "P1", "application/pdf"],
		] as const) {
			const value = media(entries.get(key), field);
			const res = await client.raw("GET", `/_emdash/api/media/file/${value?.meta.storageKey}`);
			expect(res.status, field).toBe(200);
			expect(res.headers.get("content-type"), field).toBe(type);
			expect(res.headers.get("x-content-type-options"), field).toBe("nosniff");
			await res.arrayBuffer();
		}

		const before = feeds.requests.length;
		const again = await importCsv("it_media", csv);
		expect(again.job.counters).toMatchObject({ unchanged: 2 });
		expect(feeds.requests).toHaveLength(before);
	});

	it("shares one media item for identical bytes at two URLs", async () => {
		await createMediaSchema(client, "it_media_dedupe");
		const bytes = tagged(BLUE_PNG, "t2");
		feeds.feeds.set("/t2/a.png", { body: bytes, contentType: "image/png" });
		feeds.feeds.set("/t2/b.png", { body: bytes, contentType: "image/png" });
		const csv = mediaCsv([
			["D1", "A", feeds.url("/t2/a.png"), "", "", ""],
			["D2", "B", feeds.url("/t2/b.png"), "", "", ""],
		]);
		const { job, rows } = await importCsv("it_media_dedupe", csv);
		expect(job.counters).toMatchObject({ created: 2 });
		expect(rows.map((r) => r.newMedia)).toEqual([
			[`photo: ${feeds.url("/t2/a.png")}`],
			[`photo: ${feeds.url("/t2/b.png")}`],
		]);
		const entries = await stored("it_media_dedupe");
		expect(media(entries.get("D1"), "photo")?.id).toBe(media(entries.get("D2"), "photo")?.id);
	});

	it("plans a dry run without a request, listing what a real run would download", async () => {
		await createMediaSchema(client, "it_media_dry");
		feeds.feeds.set("/t3/a.png", { body: tagged(RED_PNG, "t3"), contentType: "image/png" });
		const csv = mediaCsv([["Y1", "A", feeds.url("/t3/a.png"), "Alt", "", ""]]);
		const { job, rows } = await importCsv("it_media_dry", csv, { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).toMatchObject({
			status: "planned",
			newMedia: [`photo: ${feeds.url("/t3/a.png")}`],
		});
		expect(rows[0]?.changes).toContainEqual({
			field: "photo",
			before: null,
			after: `new media from ${feeds.url("/t3/a.png")}`,
		});
		expect(feeds.log("/t3/a.png")).toEqual([]);
		expect(await client.listAll("it_media_dry")).toEqual([]);
	});

	it("fails a record for a 404, a too-large file, HTML as an image, SVG and a refused type", async () => {
		await createMediaSchema(client, "it_media_bad");
		feeds.feeds.set("/t4/big.png", { body: largePng(MAX_UPLOAD + 1), contentType: "image/png" });
		feeds.feeds.set("/t4/page.png", { body: HTML, contentType: "image/png" });
		feeds.feeds.set("/t4/logo.svg", { body: SVG, contentType: "image/svg+xml" });
		feeds.feeds.set("/t4/scan.pdf", {
			body: tagged(MANUAL_PDF, "t4"),
			contentType: "application/pdf",
		});
		const csv = mediaCsv([
			["B1", "Missing", feeds.url("/t4/missing.png"), "", "", ""],
			["B2", "Big", feeds.url("/t4/big.png"), "", "", ""],
			["B3", "Page", feeds.url("/t4/page.png"), "", "", ""],
			["B4", "Logo", feeds.url("/t4/logo.svg"), "", "", ""],
			["B5", "Scan", "", "", "", feeds.url("/t4/scan.pdf")],
		]);
		const { job, rows } = await importCsv("it_media_bad", csv);
		expect(job.counters).toMatchObject({ failed: 5 });
		expect(rows.map((r) => r.errors?.map((e) => `${e.field}:${e.code}`))).toEqual([
			["photo:media_http_error"],
			["photo:media_too_large"],
			["photo:media_type_not_allowed"],
			["photo:media_type_not_allowed"],
			["scan:media_type_not_allowed"],
		]);
		expect(rows[1]?.errors?.[0]?.message).toBe(
			`The file is larger than the limit of ${MAX_UPLOAD} bytes`,
		);
		expect(rows[4]?.errors?.[0]?.message).toBe(
			`${feeds.url("/t4/scan.pdf")}: The field accepts only image/png, image/jpeg, not application/pdf`,
		);
		const library = await client.api<{ items: { filename: string }[] }>(
			"GET",
			"/_emdash/api/media?limit=100",
		);
		expect(library.items.map((i) => i.filename)).not.toContain("scan.pdf");
		expect(await client.listAll("it_media_bad")).toEqual([]);
	});

	it("refreshes a changed file, keeps a 304 unchanged, and downloads a deleted item again", async () => {
		await createMediaSchema(client, "it_media_refresh");
		feeds.feeds.set("/t5/p.png", {
			body: tagged(RED_PNG, "t5a"),
			contentType: "image/png",
			etag: true,
		});
		const csv = mediaCsv([["R1", "P", feeds.url("/t5/p.png"), "", "", ""]]);
		await importCsv("it_media_refresh", csv, { refresh: true });
		const first = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;

		const unchanged = await importCsv("it_media_refresh", csv, { refresh: true });
		expect(unchanged.job.counters).toMatchObject({ unchanged: 1 });
		expect(feeds.log("/t5/p.png").map((r) => r.status)).toEqual([200, 304]);

		feeds.feeds.set("/t5/p.png", {
			body: tagged(BLUE_PNG, "t5b"),
			contentType: "image/png",
			etag: true,
		});
		const changed = await importCsv("it_media_refresh", csv, { refresh: true });
		expect(changed.job.counters).toMatchObject({ updated: 1 });
		const second = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;
		expect(second).not.toBe(first);
		expect(changed.rows[0]?.changes).toEqual([{ field: "photo", before: first, after: second }]);

		await client.api("DELETE", `/_emdash/api/media/${second}`);
		const redownloaded = await importCsv("it_media_refresh", csv);
		expect(redownloaded.job.counters).toMatchObject({ updated: 1 });
		expect(feeds.log("/t5/p.png").map((r) => r.status)).toEqual([200, 304, 200, 200]);
		const third = media((await stored("it_media_refresh")).get("R1"), "photo")?.id;
		expect(third).not.toBe(second);
	});

	it("leaves a record whose next download is too late for the next batch, without downloading twice", async () => {
		await createMediaSchema(client, "it_media_slow");
		// The batch's media deadline is budgetMs + 20 s = 20.5 s after it starts. The slow
		// download ends about 18 s in, so the next one would start with under 5 s left and is
		// deferred; 2.5 s of slack on both sides absorbs the wall clock stepping back on WSL
		// (Fact F1) and a slow first batch.
		feeds.feeds.set("/t6/slow.png", {
			body: tagged(RED_PNG, "t6"),
			contentType: "image/png",
			delayMs: 18_000,
		});
		feeds.feeds.set("/t6/manual.pdf", {
			body: tagged(MANUAL_PDF, "t6"),
			contentType: "application/pdf",
		});
		const csv = mediaCsv([
			["S1", "Slow", feeds.url("/t6/slow.png"), "", feeds.url("/t6/manual.pdf"), ""],
		]);
		const { uploadId } = await client.upload(csv);
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: mediaTemplate("it_media_slow"),
			dryRun: false,
			budgetMs: 500,
		});
		const first = await client.plugin("jobs/next", { id: created.id });
		expect(first).toMatchObject({ status: "running", cursor: { seq: 0 } });
		expect(await client.records(created.id)).toEqual([]);
		const job = await client.runToEnd(created.id);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(feeds.log("/t6/slow.png")).toHaveLength(1);
		expect(feeds.log("/t6/manual.pdf")).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the new file**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts media`
Expected: PASS (6 tests, about 30 s including its own server's start on port 4394)

- [ ] **Step 3: Run the whole Node suite**

Run: `pnpm test:integration`
Expected: PASS (12 files, 65 tests, about 9 minutes) (Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles).

- [ ] **Step 4: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/fixtures/media.ts packages/flux-import/tests/integration/feed-server.ts packages/flux-import/tests/integration/server.ts packages/flux-import/tests/integration/media.test.ts sites/dev/astro.config.mjs
git commit -m "Prove media from URL end to end on the Node dev site"
```

### Task 9: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7 through HTTP; Task 8's fixture (`createMediaSchema`, `GREEN_JPEG`, `MANUAL_PDF`, `largePng`, `mediaCsv`, `mediaTemplate`, `StoredMedia`) and `FeedServer`; the parity harness; V1, V5 on workerd and R2.
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
```
with:
```ts
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import {
	createMediaSchema,
	GREEN_JPEG,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	type StoredMedia,
} from "../fixtures/media.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
```

then replace
```ts
		});
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
```
with:
```ts
		});
	});

	it("imports M4c media into R2, re-runs unchanged, and refuses a file over the Workers cap", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			await createMediaSchema(client, "cf_media");
			feeds.feeds.set("/photo.jpg", { body: GREEN_JPEG, contentType: "image/jpeg" });
			feeds.feeds.set("/manual.pdf", { body: MANUAL_PDF, contentType: "application/pdf" });
			// One byte over WORKERS_MEDIA_MAX_BYTES (5 MiB), refused by its Content-Length.
			feeds.feeds.set("/huge.png", {
				body: largePng(5 * 1024 * 1024 + 1),
				contentType: "image/png",
			});
			const csv = mediaCsv([
				["C1", "Chair", feeds.url("/photo.jpg"), "A chair", feeds.url("/manual.pdf"), ""],
				["C2", "Huge", feeds.url("/huge.png"), "", "", ""],
			]);
			const importMedia = async () => {
				const { uploadId } = await client.upload(csv);
				const job = await client.plugin("jobs/create", {
					uploadId,
					template: mediaTemplate("cf_media"),
					dryRun: false,
				});
				const done = await client.runToEnd(job.id);
				return { done, rows: await client.records(done.id) };
			};
			const first = await importMedia();
			expect(first.done.counters).toMatchObject({ created: 1, failed: 1 });
			expect(first.rows[1]?.errors).toEqual([
				{
					field: "photo",
					code: "media_too_large",
					message: `The file is larger than the limit of ${5 * 1024 * 1024} bytes`,
				},
			]);
			const entry = (await byKey("cf_media")).get("C1")!;
			const photo = entry.data.photo as StoredMedia;
			expect(photo).toMatchObject({
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				width: 4,
				height: 3,
				alt: "A chair",
			});
			expect(photo.blurhash).toEqual(expect.any(String));
			const manual = entry.data.manual as StoredMedia;
			const file = await client.raw("GET", `/_emdash/api/media/file/${manual.meta.storageKey}`);
			expect(file.headers.get("content-type")).toBe("application/pdf");
			expect(new Uint8Array(await file.arrayBuffer())).toEqual(MANUAL_PDF);
			const requests = feeds.requests.length;
			const again = await importMedia();
			expect(again.done.counters).toMatchObject({ unchanged: 1, failed: 1 });
			// Only the refused file is requested again.
			expect(feeds.requests.slice(requests).map((r) => r.path)).toEqual(["/huge.png"]);
		} finally {
			await feeds.stop();
		}
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
```

- [ ] **Step 2: Run the new test on workerd**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M4c media"`
Expected: PASS (1 test, about 11 s plus 26 s of server start; the other nine are skipped). This proves on workerd and R2 that `handleMediaUpload` stores and enriches an image (with a blurhash) and a PDF, that the stored file serves with its type, that a re-run is `unchanged` and requests only the refused file again, and that a file one byte over 5 MiB fails `media_too_large` by its `Content-Length`. The full `pnpm test:cf` runs in Task 10.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove an M4c media import on workerd and R2"
```

### Task 10: M4c review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-m4c-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`

**Interfaces:**
- Consumes: everything above, and the Task 0 results.
- Produces: the filled-in review note and the roadmap status; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 20 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` and `sites/dev/uploads` first; an agent runs `FLUX_DEV_ALLOW_PRIVATE_NETWORK=1 node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`, the variable the integration harness sets for `allowPrivateNetwork`), with an Admin PAT from `setup/dev-bypass` and a local file server (for example `FeedServer` from a script, or `python3 -m http.server` in a folder holding a PNG, a JPEG, a PDF and an SVG), record each result:
1. Create the schema with `createMediaSchema(client, "m4c_products")` from `tests/fixtures/media.ts` (or the same REST calls by hand) and run `jobs/create` with `mediaTemplate("m4c_products")` and a three-row CSV (photo with alt and manual; a JPEG with no alt; a PDF into `scan`) as a dry run: every row is `planned`, `newMedia` lists each URL as `photo: <url>` (or `manual:`, `scan:`), the file server logged no request, and the Media Library has no new item.
2. Run it for real: the Media Library shows the new items (the JPEG and PNG with dimensions and a placeholder, the library alt from the CSV), each entry's editor shows its image with the mapped alt and its file, and the file URLs open with the right type.
3. Run it again: `unchanged: 3`, and the file server logged no new request.
4. Point one row's photo at the SVG and another's `scan` at the PDF, and run a dry run, then a real run: the dry run plans both (it cannot see types); the real run fails them with `media_type_not_allowed`, `jobs/log.csv` carries the code, and no new library item was made for either.
5. Delete one imported image in the Media Library and re-run: that row downloads its URL again (`newMedia` lists it) and the entry points at the new item. Restore `sites/dev/data.db*` and `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-27-m4c-review.md` from this template and fill in every `…`:
````markdown
# Milestone 4c review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Unconfirmed facts (Task 0)

| Fact | Check | Result |
| --- | --- | --- |
| V1: `handleMediaUpload` from a native route stores, enriches and dedupes, on Node and workerd | probe route; Tasks 8 and 9 | … |
| V2: `runtime.config.maxUploadSize` readable, `undefined` when unset | probe route; Task 8 (limit 100,000) | … |
| V3: image value reads back as sent without `caption`; file value without `size` | probe route; Tasks 8 and 9 re-runs `unchanged` | … |
| V4: `allowedMimeTypes` enforced on save with `INVALID_MIME_FOR_FIELD` | probe route | … |
| V5: memory for a 10 MiB JPEG; Workers cap 5 MiB | drafting measurement (plan Facts); Task 9 | … |

## Automated checks

| Command | Result | Summary (files / tests / duration) |
| --- | --- | --- |
| `pnpm typecheck` | … | … |
| `pnpm lint` | … | … |
| `pnpm test` | … | … |
| `pnpm test:integration` | … | … |
| `pnpm test:cf` | … | … |

## Spec "Testing" coverage

| Item | Evidence | Result |
| --- | --- | --- |
| Conversion: URL normalization (case, default port, fragment, query kept), relative, `data:` and userinfo URLs refused, non-scalars, alt from `from` and `expr`, alt too long, required empty, the 5-mapping limit, map key stability | `media.test.ts`, `template.test.ts` | … |
| Fetch and sniffing: every magic-byte type, markup under an `image/png` header, unrecognized `video/*` from its header, extension fallback only without a useful header, `Content-Length` refusal, stream cut, header and total timeouts, the deadline, 304 on refresh, filenames | `media-fetch.test.ts` | … |
| Resolution: ready hit without download, deleted item downloaded again, dry-run miss, `allowedMimeTypes` and kind refusals before upload, EmDash codes mapped, `CONFIGURATION_ERROR` fails the job, dedupe listed in `newMedia`, no download after a lookup error, per-batch `handleMediaGet` cache, deferral but never the first download, the Workers budget | `media-resolve.test.ts`, `media-import.test.ts` | … |
| Diff and writes: `id` comparison, bare string ID, alt only when mapped, `null` against missing, full value written, media-only change sends `data` | `diff.test.ts`, `media-import.test.ts` | … |
| Schema checks: type compatibility, SVG-only `allowedMimeTypes`, the mapping limit, `schema/apply` creating `image` and `file` | `template.test.ts`, `schema.test.ts`, `schema-apply.test.ts` | … |
| Integration on `sites/dev`: CSV import with image, alt and file, served types; re-run without a request; identical bytes shared; dry run without a request; 404, too large, HTML as PNG, SVG; refresh 200 and 304; deleted item downloaded again; `allowedMimeTypes` refusing a PDF; slow server deferral | `media.test.ts` | … |
| workerd: image and file into R2, re-run `unchanged`, a file over the Workers cap refused | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Dry run lists `newMedia`, no request, no library item | … | … |
| 2 | Real run: library items, entry values, served types | … | … |
| 3 | Re-run unchanged without requests | … | … |
| 4 | SVG and refused PDF: planned in a dry run, refused in a real run, nothing stored | … | … |
| 5 | Deleted library item downloaded again | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Mark M4c done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| M4c | Media from URL into image and file fields: fetch through the M3c fetcher and SSRF guard, `maxUploadSize`, content-hash dedupe via `handleMediaUpload`, alt text, per-job URL-to-media map | Planned |
```
with:
```markdown
| **M4c** ([spec](./2026-10-27-flux-import-m4c-media-design.md)) | Media from URL into image and file fields: fetch through the M3c fetcher and SSRF guard, `maxUploadSize`, content-hash dedupe via `handleMediaUpload`, alt text, site-wide URL-to-media map | Done ([review](../notes/2026-10-27-m4c-review.md)) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-10-27-m4c-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 4c review results and mark M4c done in the roadmap"
```

---

## After this plan

M4c is the third part of Milestone 4. Known gaps carried forward, all documented in the spec: a dry run cannot report HTTP errors, DNS answers, sizes, types or whether a download would deduplicate to the media the entry already has; media is never deleted, so an item stored for a record that then fails stays in the library and the map (M5 rollback can find a job's own new items through the map's `jobId` and `created`); captions, focal points, `darkVariant`, external providers, relative URLs, credentials for media URLs and more than one item per field are out of scope; downloads are sequential; the Workers cap is 5 MiB (Fact V5), and EmDash's placeholder decode stays bounded by pixels, not bytes (Fact E4); the Workers Free plan is not supported. M4d (Portable Text) calls `resolveMedia` for image URLs in rich text, sharing the map, the per-batch cache and the deadline. The M2-M4b open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-10-27-m4b-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands.
