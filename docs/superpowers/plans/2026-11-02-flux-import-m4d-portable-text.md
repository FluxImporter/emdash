# Flux Import M4d: HTML and Markdown to Portable Text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0 was done while this plan was drafted (its results are below, nothing to run). Tasks 1, 2 and 3, and later Tasks 4 and 5, can run in parallel worktrees (see "Parallel execution").

**Goal:** Import `portableText` fields from HTML, Markdown or plain text in the source. The importer converts each value with its own bounded converter: HTML through `parse5`, Markdown through `markdown-it` and then the same HTML rules, plain text into paragraphs. Markup it does not know keeps its text and is reported per record as a warning; active content is removed and reported; links keep only safe schemes. Each image becomes an image block that references a Media Library item obtained through the M4c resolver and media map, so a re-run downloads nothing and a URL shared with an `image` field is stored once. Keys are deterministic and the diff compares a canonical form without keys, so a re-run plans `unchanged`, also after an editor save. A dry run downloads nothing: it converts, reports warnings, resolves map hits and lists the image URLs a real run would download. Templates stay `version: 1`; every addition is optional, and jobs created before M4d behave as before, except that every download now also defers by the Workers budget.

**Architecture:** Conversion stays synchronous inside `applyTemplate`. `src/engine/portable-text.ts` holds the limits, `convertPortableText` (size checks, `markdown-it` rendering, `parseFragment` with a tree adapter that stops at 256 open elements, and an iterative walker that builds draft blocks with marks, link definitions, image slots and counted warnings), and the link and image URL rules. `applyTemplate` puts one `PortableTextDraft` per `portableText` field on `MappedRecord.portableText` (kept out of `data`), applies the per-record limits (50 distinct image URLs, 1 MiB of JSON) and returns the record's `warnings`. `src/engine/portable-text-images.ts` looks every distinct image URL up through M4c's `findMedia`, downloads misses through `obtainMedia` after the field media, drops or fails images by the mapping's `imageErrors`, and assembles EmDash's image block. `planRecord` compares Portable Text by `canonicalPortableText` and shows counts (`3 blocks, 1 image (1 new)`), never the value. `RecordRow` gains `warnings` (at most 20) and the log CSV a `warnings` column. `obtainMedia` now also defers a download, other than the batch's first, that would spend past the Workers lookup budget.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4 (`zod` in the engine), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. New dependencies, pinned exactly: `parse5` 7.3.0 and `markdown-it` 14.3.3, and `@types/markdown-it` 14.2.0 as a dev dependency.

**Spec:** `docs/superpowers/specs/2026-11-02-flux-import-m4d-portable-text-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Milestone 4 split). Previous plan: `docs/superpowers/plans/2026-10-27-flux-import-m4c-media.md`; its review: `docs/superpowers/notes/2026-10-27-m4c-review.md`.

Every code block in Tasks 1 to 8 was written, type-checked, linted and run while this plan was drafted (unit suite, the new Node integration file, and the new workerd parity tests), then replayed task by task from `4d2dfbe` (the spec commit; it changes only docs) in a fresh worktree by a script that applies this document's code blocks and replacements; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0; the spec's Facts F1-F13 are cited as "spec F<n>" and its measurements as "spec M<n>".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`. No new route, option, capability or storage collection: images use M4c's `media:write` and `media` collection.
- Two new runtime dependencies, `parse5` 7.3.0 and `markdown-it` 14.3.3, and one dev dependency, `@types/markdown-it` 14.2.0, all pinned exactly (`--save-exact`) in `packages/flux-import/package.json`. Task 1 adds them; no other task touches `package.json` or `pnpm-lock.yaml`. EmDash's own converters (`markdownToPortableText`, `htmlToPortableText`) are not used (spec "Decisions").
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. The engine's template schema uses `zod`.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code. Portable Text is written only as part of the entry's `data` through the existing content port; media only through M4c's resolver (`findMedia`, `obtainMedia`), never `handleMediaUpload` directly. The importer never emits `htmlBlock`, `iframe`, `video`, `table` or any block or mark type outside spec "What is kept".
- Vitest runs from `packages/flux-import` with file paths: `pnpm exec vitest run tests/unit/portable-text.test.ts`. Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/portable-text.test.ts`; workerd: `pnpm exec vitest run --config vitest.cf.config.ts -t "M4d"`. The workerd harness uses port 4396 and the Node harness 4399 (plus 4393 for the new `portable-text.test.ts`, and 4394, 4395 and 4398 for the other suites that start their own server): never run two copies of the same harness at once.
- Codes, exactly: the new record codes are `unknown_markup`, `removed_markup`, `link_dropped` (warnings, or errors with `unknownMarkup: "fail"`), `alt_truncated` and `image_dropped` (warnings only), `portable_text_too_large`, `portable_text_too_complex`, `portable_text_limit` and `portable_text_failed` (errors), and `warnings_truncated` (the last warning of a capped list). Images that fail with `imageErrors: "fail"` use the M4c codes (`invalid_media_url`, `media_blocked`, `media_fetch_failed`, `media_http_error`, `media_too_large`, `media_type_not_allowed`, `media_upload_failed`). Template problems at job creation stay `invalid_template` (400) with one problem per field.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 7 also passes its integration file (about 18 s with server start) and `pnpm test:integration` (about 9 minutes), Task 8 the targeted workerd tests (about 45 s); Task 9 runs everything, `pnpm test:cf` included (about 20 minutes).

## Review Focus

1. Nothing executable reaches a stored value: removed elements lose their text, attributes other than the kept ones are dropped, links keep only `http:`, `https:`, `mailto:`, `tel:` and `#fragment`, and only the block and mark types EmDash's editor accepts are emitted: Task 1 ("removes active content with everything in it, and reports it", "keeps transparent markup silently, and drops attributes and comments", "emits only the block and mark types EmDash's editor accepts", "keeps only safe schemes and fragments…"), Task 7 (the rendered page has no `alert("x")`).
2. A re-run must plan `unchanged` and download nothing, also after an editor save: keys are deterministic, the canonical form ignores keys, empty `marks` and `markDefs`, a `normal` style, `blank: false` and the editor's list ids, and mark references are compared by their definition's position: Task 1 ("is deterministic…"), Task 2 (all five), Task 5 ("survives an editor round trip unchanged (Fact V2)", "uses map hits without downloading…"), Task 6 ("imports HTML with library images and warnings, and re-runs unchanged without a download"), Tasks 7 and 8.
3. Work stays bounded: 512 KiB of source, 2 MiB of rendered Markdown, at most 256 open elements counted exactly inside `parse5` (not estimated, Ruling 1), 3 mappings per template, 50 distinct image URLs and 1 MiB of JSON per record, 20 warnings per row, no recursion in the walker, and a parser exception fails only the record: Task 1 ("refuses source text over 512 KiB…", "refuses markup that keeps more than 256 elements open, implied ones included", "stays fast at the limits", "stays linear on inputs that are quadratic in other parsers", "fails the record, not the batch, when a parser throws"), Task 3 ("keeps at most 20 warnings…"), Task 4 ("keeps at most 50 distinct image URLs…", "refuses more than 1 MiB…", "needs a portableText field and allows at most three mappings"), Task 8 (almost 1 MiB on D1).
4. Images share M4c's media path: a dry run downloads nothing and lists misses in `newMedia`; nothing is downloaded for a record that fails before its downloads; a URL used by a field and by Portable Text, or twice, is downloaded once; downloads defer by deadline and by budget but never the batch's first; `media_config` still fails the job: Task 5 (all eight), Task 6 ("plans a dry run without downloading…", "downloads a URL shared by an image field and Portable Text once", "defers a record with more new images than one Workers batch allows…"), Task 7 ("plans a dry run without a request…", "downloads an image shared with an image field once"), Task 8 (a record deferred by budget on workerd).
5. Image failures follow `imageErrors`: with `"drop"` the record is kept with an `image_dropped` warning carrying the M4c code and URL, and the URL is tried again on the next run; with `"fail"` the record fails with the M4c code and nothing is written: Task 1 ("drops an image with a bad URL with a warning, or fails it…"), Task 5 ("drops an image that cannot be imported with a warning, or fails the record", "leaves a field with only dropped images empty"), Task 6 ("drops an image that fails…", "fails the record for a failing image with imageErrors: fail, and replaces its warnings on retry"), Task 7 ("drops a 404 image with a warning…").
6. Jobs and templates without Portable Text behave as before, with two deliberate exceptions: the log CSV gains a last `warnings` column (Task 3 updates the expected lines in the unit `log.test.ts` and `selection.test.ts` and the integration `behaviours.test.ts` and `selection.test.ts`), and every download, field media included, now defers by the Workers budget (Task 5 renames and changes the M4c test "ends a batch after the record that spends the lookup budget"). `images: "skip"` needs no media and keeps the plain Workers cap: Task 4 ("uses media when a portableText mapping imports its images"), Task 6 ("skips images with images: skip, without media or the linked Workers cap").

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd; tasks cite them by number. V1-V5 are the facts the spec left unconfirmed; all five were proven while drafting (Task 0), on Node and on workerd.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | A value built by this plan's converter (paragraphs with every decorator and a link, a heading, a two-level list, a blockquote, a code block, a break, and an image block `{ _type: "image", _key, asset: { _ref: <media id>, url: "/_emdash/api/media/file/<storageKey>" }, alt, caption, width, height, link }` for an item stored through `handleMediaUpload`) is written with `handleContentCreate` and reads back from `handleContentGet` deep-equal, keys and key order included. After publishing, an update with `publish: false` (a draft revision) reads back deep-equal too. Held on Node (SQLite, local storage, `pages` collection) and on workerd (D1, R2, a `probe_pt` collection). | drafting probe route `probe/m4d` on `sites/dev` and `sites/dev-cf`; Tasks 6-8 re-prove it through imports |
| V2 | **Holds with an extended canonical form.** `prosemirrorToPortableText(portableTextToProsemirror(value))` does not throw, but it is not "keys kept" (spec F8): the editor regenerates every `_key`, drops empty `marks`, adds `blank: false` to link definitions, and adds `listId` (`legacy:root:<n>:<key>`) and `listStart: 1` to numbered items. With the canonical form of Ruling 2 (keys removed, mark references renamed to their definition's position, `listId` removed, `listStart: 1` and `blank: false` equal to missing) the round trip canonicalizes equal. Rendering on `sites/dev` (`/pages/m4d-probe`, 200): the image's `src` goes through Astro's image endpoint (`/_image?href=<encoded file URL>&w=4…`), the file URL itself serves the item (200, `image/jpeg`), the caption, the link's `href`, `<strong>` and a relative link resolved against `baseUrl` render, and the removed script's `alert(1)` does not. | drafting probe; Task 5 "survives an editor round trip unchanged (Fact V2)"; Task 7 renders a page |
| V3 | `parse5` 7.3.0 and `markdown-it` 14.3.3 bundle into `sites/dev-cf` and convert inside a plugin route on workerd (the probe route ran the converter there with the same warnings as on Node). | drafting probe on workerd; Task 8 |
| V4 | `markdown-it` 14.3.3 stays linear. Standalone Node bundle: `"*a "` at 150 KB 19.8 ms, `"_a "` 20.6 ms, 50,000 `[` 14.3 ms, 5,000 nested `>` 0.1 ms, 1,000 nested list levels 4.1 ms, 50,000 `[a](` 18.8 ms; at 512 KiB `"*a "` 69 ms, `"**a "` 87, backticks 45, `"<a "` 33, `"![a]("` 109, a table 98, `"~~a "` 50, ordinary Markdown 65. `parse5` at the limits (parse only): 256 nested `div` plus stray `</p>` to 512 KiB 243 ms, unclosed `<li>` 241, `<dd>` 242, `<h1>` 242, `<table><tr>` 178, the other cases 14-81 ms; 512 KiB of ordinary HTML 26 ms. **The spec's pre-scan underestimates** list nesting: `<ul><li>` × 256 builds 513 open elements in `parse5` (391-409 ms), `<dl><dd>` × 256 330-353 ms, and `<section><li>` nests too; hence Ruling 1. Full conversion through a plugin route (best of 3, ms, Node dev server / workerd): Markdown emphasis 150 KB 40 / 31; Markdown `**a ` 512 KiB 183 / 126; Markdown images 512 KiB 315 / 265; 255 `div` and stray `</p>` 260 / 146; 127 nested lists and stray `</p>` 226 / 142; 255 `div` and unclosed `<li>` 275 / 150; ordinary Markdown 512 KiB 216 / 196; ordinary HTML 512 KiB 83 / 67. | drafting scripts (esbuild bundle, Node) and the probe route on both runtimes; Task 1 "stays fast at the limits" and "stays linear…" bound the same cases in the unit suite |
| V5 | A record with 1,127,151 bytes of Portable Text JSON is created, published, updated as a draft, published again and read back equal on Node (SQLite, revisions) and workerd (D1, revisions). Through an import, three `portableText` fields of 340,000 characters (about 1,020,000 bytes of JSON, under the 1 MiB cap) are written to D1. The cap stays 1 MiB. | drafting probe on both runtimes; Task 8 "writes a record with almost 1 MiB of M4d Portable Text to D1" |
| E1 | `parse5`'s `TreeAdapter` interface has optional `onItemPush` and `onItemPop` hooks (`dist/tree-adapters/interface.d.ts:248-254`), and every change to the open-element stack calls them (`dist/parser/open-element-stack.js:71`, `:80`, `:98`, `:116`, `:171`). `parseFragment` pushes its own root element first. A hook that throws ends the parse with that exception. | source reading; Task 1 "refuses markup that keeps more than 256 elements open…" (256 nested `div` pass, 257 fail; `<ul><li>` × 128 pass, × 129 fail; 300 nested `<b>` fail) |
| E2 | `markdown-it`'s `"commonmark"` preset has no task-list rule (`- [ ] task` stays the text `[ ] task`), and its `validateLink` refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs, so `[x](javascript:alert(1))` is not a link and stays literal text before our link rules run. | Task 1 "renders CommonMark with tables and strikethrough through the HTML rules" |
| E3 | A collection created through `POST /_emdash/api/schema/collections` in the test clients is routable: publishing an entry without a slug fails `emdash_validation_error` "Publishing the entry failed: Cannot publish routable content without a slug". The parity collections with a `title` field were not affected; the 1 MiB test, which has no `title`, maps `slug`. | drafting run of Task 8 |
| D1 | Dependencies. `markdown-it` 14.3.3 (MIT, released 2026-10-16; depends on `argparse` ^2.0.1, `entities` ^4.5.0, `linkify-it` ^5.0.2, `mdurl` ^2, `punycode.js` ^2.3.1, `uc.micro` ^2.1.0). `parse5` 7.3.0 (MIT; `entities` ^6). `@types/markdown-it` 14.2.0 (MIT; `@types/linkify-it` ^5, `@types/mdurl` ^2). Installed licenses: `entities` 4.5.0 and 6.0.1 BSD-2-Clause; `linkify-it` 5.0.2, `mdurl` 2.1.0, `uc.micro` 2.1.0, `punycode.js` 2.3.1 MIT; `argparse` 2.0.1 Python-2.0, imported only by `markdown-it`'s CLI (`bin/`), never by the library, so it is not bundled. esbuild browser bundles (minified): `markdown-it` 149,653 bytes, 52,965 gzip (inputs `markdown-it`, `mdurl`, `uc.micro`, `entities`, `linkify-it`, `punycode.js`); `parse5` 178,174 bytes, 47,403 gzip (`parse5`, `entities`). `pnpm add` changes `pnpm-lock.yaml` by 63 added lines. | `pnpm add` in a clean worktree; installed `package.json` files; esbuild metafiles |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition, and M4c's slow-download deferral test can read `seq: 1`. Known since M3c; not caused by this plan; a re-run of the file settles it. | M3c-M4c plans |
| F2 | In the first drafting run of the new workerd test, one `jobs/next` call answered `500 INTERNAL_ERROR` "Plugin route error". It did not recur in four later runs of the same tests (two with the workerd server log captured: no `[500]` line) or in the replay. If Task 8 or Task 9 sees it again, capture the server log (`tests/integration-cf/global-setup.ts` keeps it in the temporary site folder) and record it in the review note. | drafting runs of Task 8 |

## Rulings this plan makes

1. **Exact nesting bound instead of the pre-scan.** The spec's linear pre-scan does not count elements whose end tag may be omitted, but `parse5` keeps them open when they nest (`<ul><li>` × 256 is 513 deep, Fact V4). `convertPortableText` instead passes `parseFragment` a tree adapter (the default one plus `onItemPush`/`onItemPop`, Fact E1) that counts open elements and throws as soon as more than 256 are open (257 with the fragment's root): `portable_text_too_complex`, "The markup nests more than 256 elements deep". The bound is exact for every tag, so 128 nested lists (256 elements) pass and 129 fail.
2. **Canonical form (spec "Diff", extended by Fact V2).** `canonicalPortableText` removes `_key` at every depth; on text blocks it removes `listId`, a `normal` style, `listStart: 1` and an empty `markDefs`, and renames each span mark that names a `markDef` to `@<index of the definition>`; at every depth it removes empty `marks`, a link's `blank: false` and `undefined` values. A stored value that is not an array, contains a non-JSON value or nests deeper than 16 levels has no canonical form and always compares as changed. An empty array is equal to nothing stored.
3. **No new comparison kind.** `Comparison` and `BY_TARGET` do not change; Portable Text fields never enter `data` before the plan, so `planRecord` gets them as a sixth argument (`portableText`), like M4c's `media`, and compares them with the canonical form.
4. **`<br>`.** `\n` is appended to the text before it and the text after it starts a new span (the editor's shape), so a round trip stays equal.
5. **`applyTemplate` warnings.** The result gains `warnings?: ValueWarning[]` only when there is one, so existing `toEqual` assertions on `applyTemplate` results are unchanged. Warnings are kept on records that then fail.
6. **No `invalidImages` on the draft.** The converter applies `imageErrors` itself for URLs it can refuse without the network (relative without `baseUrl`, not a URL, a refused scheme): an `image_dropped` warning "invalid_media_url: <url>: <reason>" with `"drop"`, an `invalid_media_url` error with `"fail"`. `PortableTextDraft` is `{ blocks, images }`, `images` holding each distinct normalized URL with the alt of its first use.
7. **Figures.** A `figcaption` becomes the image's `caption` only when its `figure` holds exactly one image and no nested figure; otherwise it is a paragraph. A caption is cut to 1,000 characters silently.
8. **Smaller converter rules.** A protocol-relative `href` or `src` takes `baseUrl`'s scheme or `https:`. An `<a>` without `href` is transparent. `source` is dropped silently. Table parts (`tr`, `td`, `th`, `thead`, `tbody`, `tfoot`, `caption`, `colgroup`, `col`), `dt`, `dd`, `summary` and `legend` are not reported separately: their container (`table`, `dl`, `details`, `fieldset`) is. An unknown element is inline unless it is one of the block containers listed in `UNKNOWN_BLOCKS`. Only HTML whitespace (space, tab, newline, form feed, carriage return) is collapsed and trimmed, so a paragraph of non-breaking spaces is kept.
9. **Markdown task lists.** CommonMark has no task-list rule (Fact E2), so `- [ ] task` stays the list item text `[ ] task`; there is no checkbox element to remove. Raw `<input>` in Markdown is removed markup like any other.
10. **`baseUrl`.** Validated only by the Zod refinement ("baseUrl must be an absolute http or https URL", `parseSourceUrl` rules); `checkTemplate` only sees parsed templates, so it has nothing to add.
11. **Change text.** `N blocks, M images (K new)`; the images part is left out when there are none, `(K new)` when nothing is pending. A stored value that is not an array shows as "a value that is not Portable Text".
12. **Limit messages.** `portable_text_too_large`: "The text is larger than 512 KiB", "The Markdown renders to more than 2 MiB of HTML", "The record's Portable Text is larger than 1 MiB". Over 50 distinct image URLs (counted over the record's fields in template order): each field holding URLs past the 50th fails `portable_text_limit` "The record's Portable Text has more than 50 distinct image URLs" when its `imageErrors` is `"fail"`, and otherwise loses those images with one `image_dropped` warning, "Left out 5 images (<first url>, …): at most 50 distinct image URLs per record". The JSON size is checked after that, over all fields.
13. **Warnings in the log.** `field: code: message`, joined with `; `, in a last `warnings` column. At most 20 per row: 19 kept and a 20th `warnings_truncated` "N more warnings" (`capWarnings`, `MAX_RECORD_WARNINGS`).
14. **Budget deferral.** In `obtainMedia`: `if (!first && (late || cache.spent + COST_MEDIA > cache.budget)) throw new MediaDeferred()`. The M4c test "ends a batch after the record that spends the lookup budget" now ends the first batch at `seq` 6 and the second at 12, and is renamed "ends a batch before a record whose download would spend past the lookup budget". The Node runtime has no lookup budget, so budget deferral is tested in the unit suite and on workerd (Task 8), not in the Node integration suite; the spec's Node test "a record with more new images than one batch allows is deferred" moves to Task 8.
15. **Shared lookups.** `lookupPortableTextImages` looks each distinct URL up once per record across all Portable Text fields and names the first field that uses it (in `newMedia` and messages). A URL shared by an `image` field and Portable Text is looked up by both paths but downloaded once: the second `obtainMedia` finds the URL in the batch's `cache.mediaObtained` (M4c). M4c's `MediaLookup` is not given a `source` (spec "Ports and engine types"): the two paths keep their own bookkeeping.
16. **Record cost.** `COST_RECORD` is charged for a record whose Portable Text has images, as for records with links or field media.
17. **Order and writes.** In `processRecord`: links, field media lookups, Portable Text lookups (all errors collected), entry read, a provisional plan in which each pending image is a change, the draft and lock checks, field media downloads, then Portable Text downloads in document order, the final plan and the write. Each field's assembled blocks are written into `data` with the field media; `null` clears the field. The Portable Text warnings of the conversion and of resolution go on the row whatever its status, and a retried row's warnings are replaced.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (145 files; 1 info, the known `biome migrate` notice) |
| `pnpm test` | 52 files / 1,270 tests pass (48 / 1,208 at `4d2dfbe`) |
| Task 0 (V1-V5) | all five proven on Node and workerd with a temporary probe route and probe tests, reverted afterwards (Facts V1-V5) |
| Task-by-task replay | from `4d2dfbe` in a fresh worktree: Task 1's `pnpm add` commands produced the same `package.json` and `pnpm-lock.yaml` as the drafting tree, then Tasks 1-8 applied in numeric order with no failed replacement; each "see them fail" step failed and each "see them pass" step passed with the counts given in the task; typecheck, lint and `pnpm test` passed after every task; the result is byte-identical to the drafting tree. The integration `selection.test.ts` block was added to Task 3 after the replay (see Node integration below); it was checked to apply to `4d2dfbe` and give the drafting file |
| Node integration | on the replayed tree, `portable-text.test.ts` and `behaviours.test.ts`: 2 files / 19 tests pass in 17.5 s with server start. Full `pnpm test:integration` on the replayed tree: 13 files / 70 tests pass in 557.7 s (12 / 65 at `4d2dfbe`). Its first full run found the integration `selection.test.ts` still expecting the old CSV lines (4 failures, now part of Task 3) and `url-sources.test.ts` refusing to start because port 4395 was briefly in use (passed alone and in the second full run). |
| workerd | on the replayed tree, `-t "M4d"`: 2 passed, 10 skipped, 42.6 s (13.6 s of tests); the same two tests passed in four drafting runs after the fixes noted in Fact E3 and Fact F2. Full `pnpm test:cf` on the replayed tree: 1 file / 12 tests pass in 1,198.9 s, the M4c media and earlier parity tests included (so the budget deferral leaves them passing). |

## File map

| File | Responsibility |
| --- | --- |
| `src/engine/portable-text.ts` (new) | Limits, `PortableTextOptions`, `PortableTextDraft`, `convertPortableText` (size checks, `markdown-it`, `parseFragment` with the nesting guard, the iterative `Walker`), `shownUrl`, `safeHref`, `imageUrl` (Task 1) |
| `src/engine/diff.ts` | `PortableTextPlanItem`, `canonicalPortableText`, `portableTextSummary`; Portable Text changes in `planRecord` (Task 2) |
| `src/engine/types.ts`, `src/engine/log.ts` | `RecordRow.warnings`, `MAX_RECORD_WARNINGS`, `capWarnings`; the log CSV's `warnings` column (Task 3) |
| `src/engine/template.ts`, `src/plugin/schema-apply.ts` | The `portableText` mapping and options, `CompiledTemplate.portableText`, `portableTextOptions`, `ValueWarning`, `MappedRecord.portableText`, the record limits, `COMPATIBLE.portableText`, the 3-mapping check, `usesMedia`; `portableText` in `schema/apply` (Task 4) |
| `src/engine/portable-text-images.ts` (new), `src/engine/media.ts` | `MEDIA_FILE_PATH`, `RecordImages`, `lookupPortableTextImages`, `obtainPortableTextImages`, `portableTextPlan`; budget deferral in `obtainMedia` (Task 5) |
| `src/engine/batch.ts` | Warnings on rows, Portable Text lookups, provisional plan, downloads, writes (Task 6) |
| `tests/fixtures/portable-text.ts` (new), `tests/integration/portable-text.test.ts` (new), `tests/integration-cf/parity.test.ts` | Node and workerd proofs (Tasks 7 and 8) |

The source readers, `src/engine/links.ts`, `src/engine/resolve.ts`, `src/emdash/*`, `src/plugin/definition.ts`, `src/plugin/routes.ts`, `src/plugin/service.ts`, the sites and the test fakes do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify V1-V5 | — | done while drafting; nothing to run | — |
| 1. Dependencies and the converter | 0 | `packages/flux-import/package.json`, `pnpm-lock.yaml`, `src/engine/portable-text.ts`, `tests/unit/portable-text.test.ts` | opus |
| 2. Portable Text in the record plan | 0 | `src/engine/diff.ts`, `tests/unit/diff.test.ts` | sonnet |
| 3. Record warnings and the log column | 0 | `src/engine/{types,log}.ts`, `tests/unit/{log,selection}.test.ts`, `tests/integration/{behaviours,selection}.test.ts` | sonnet |
| 4. Template mappings, limits and checks | 1 (`convertPortableText`, the limits, `PortableTextOptions`, `PortableTextDraft`) | `src/engine/template.ts`, `src/plugin/schema-apply.ts`, `tests/unit/{portable-text-template,schema-apply,definition}.test.ts` | sonnet |
| 5. Image resolution and budget deferral | 1 (`shownUrl`, `PortableTextDraft`, `PortableTextOptions`, `convertPortableText` in tests), 2 (`PortableTextPlanItem`, `portableTextSummary`, `canonicalPortableText` in tests) | `src/engine/{portable-text-images,media}.ts`, `tests/unit/{portable-text-images,media-resolve,media-import}.test.ts` | sonnet |
| 6. Batch integration | 2, 3 (`capWarnings`, `RecordRow.warnings`), 4 (`MappedRecord.portableText`, `CompiledTemplate.portableText`, `warnings`), 5 | `src/engine/batch.ts`, `tests/unit/portable-text-import.test.ts` | opus |
| 7. Node integration | 6 | `tests/fixtures/portable-text.ts`, `tests/integration/portable-text.test.ts` | sonnet |
| 8. workerd parity | 7 (`tests/fixtures/portable-text.ts`) | `tests/integration-cf/parity.test.ts` | sonnet |
| 9. Review run and note | 1-8 | `docs/superpowers/notes/2026-11-02-m4d-review.md`, the roadmap | opus |

Waves: **1 ∥ 2 ∥ 3**, then **4 ∥ 5**, then **6**, then **7**, then **8** (it imports Task 7's fixture), then **9**. Every file is touched by exactly one task, so no two tasks of a wave (or of different waves) edit the same file; only Task 1 changes `package.json` and the lockfile, so worktrees for Tasks 2 and 3 need no `pnpm install` beyond the base one, and Tasks 4 and 5 start from a tree with Task 1 merged. Pass counts in each task's "Run them to see them pass" step are for the task's own test files; the full-suite totals after each task assume the tasks are merged in numeric order.

---

### Task 0: Verify the unconfirmed facts (V1-V5) — done while drafting

**Files:** none (a temporary probe route in `src/plugin/routes.ts` and probe tests in `tests/integration/` and `tests/integration-cf/` were used and reverted).

**Interfaces:**
- Consumed: `runtime.handleMediaUpload`, `handleContentCreate`, `handleContentGet`, `handleContentUpdate`, `handleContentPublish`; `portableTextToProsemirror` and `prosemirrorToPortableText` from `emdash` (spec F12); the page route of `sites/dev`.
- Produced: Facts V1-V5 and E1; Rulings 1 and 2 follow from V4 and V2. The Task 9 note records the results from the Facts table.

- [x] **V1** (Node and workerd): the converter's value with a library image created, read back deep-equal with keys, published, updated as a draft and read back deep-equal. Passed.
- [x] **V2**: the editor round trip canonicalizes equal with Ruling 2's form (not with the spec's form); the page renders the image through Astro's image endpoint, the caption, the links and the marks, without the script. Passed with the extension; the spec's "keys kept" (F8) is wrong for the round trip.
- [x] **V3**: the converter ran in a plugin route on workerd. Passed.
- [x] **V4**: `markdown-it` 14.3.3 linear (all probes under 100 ms at 150 KB); `parse5` worst cases at the limits under 300 ms on Node (243 ms parse, 275 ms full conversion). Passed; the pre-scan finding led to Ruling 1. 14.3.3 is kept.
- [x] **V5**: 1,127,151 bytes of JSON on SQLite and D1 with revisions. Passed; the cap stays 1 MiB.

### Task 1: Dependencies and the converter

**Files:**
- Modify: `packages/flux-import/package.json`, `pnpm-lock.yaml` (through `pnpm add`)
- Create: `packages/flux-import/src/engine/portable-text.ts`
- Test: `packages/flux-import/tests/unit/portable-text.test.ts`

**Interfaces:**
- Consumes: M4c `MAX_ALT_LENGTH` and `normalizeMediaUrl` from `src/engine/media.ts`; `JsonValue` from `src/engine/values.ts`; `parse5` (`parseFragment`, `defaultTreeAdapter`, the `TreeAdapter` hooks, Fact E1) and `markdown-it`.
- Produces: `src/engine/portable-text.ts`: `MAX_PORTABLE_TEXT_MAPPINGS` (3), `MAX_PORTABLE_TEXT_SOURCE_BYTES` (512 KiB), `MAX_RENDERED_MARKDOWN_BYTES` (2 MiB), `MAX_PORTABLE_TEXT_NESTING` (256), `MAX_PORTABLE_TEXT_RECORD_BYTES` (1 MiB), `MAX_PORTABLE_TEXT_IMAGES` (50), `MAX_LIST_LEVEL` (6), `MAX_CAPTION_LENGTH` (1,000), `MAX_HREF_LENGTH` (2,048); `type PortableTextFormat = "html" | "markdown" | "text"`; `type PortableTextOptions = { format; baseUrl: string | null; images: "import" | "skip"; imageErrors: "drop" | "fail"; unknownMarkup: "warn" | "fail" }`; `type PortableTextCode`; `type PortableTextIssue = { code; message }`; `type PortableTextImage = { url: string; alt: string | null }`; `type DraftBlock = { [key: string]: JsonValue }` (an image block holds `slot`, an index into `images`, until resolution); `type PortableTextDraft = { blocks: DraftBlock[]; images: PortableTextImage[] }`; `type PortableTextConverted = { draft: PortableTextDraft | null; errors: PortableTextIssue[]; warnings: PortableTextIssue[] }`; `convertPortableText(text: string, options: PortableTextOptions): PortableTextConverted`; `shownUrl(url)` (at most 200 characters); `safeHref(raw, base: URL | null)`; `imageUrl(raw, base: URL | null)`. Keys: blocks `b<n>`, spans `b<n>s<m>`, link definitions `b<n>l<m>`.

- [ ] **Step 1: Add the dependencies**

Run (from `packages/flux-import`):
```bash
pnpm add --save-exact parse5@7.3.0 markdown-it@14.3.3
pnpm add -D --save-exact @types/markdown-it@14.2.0
```
Expected: `package.json` gains `"markdown-it": "14.3.3"` and `"parse5": "7.3.0"` under `dependencies` and `"@types/markdown-it": "14.2.0"` under `devDependencies`; `pnpm-lock.yaml` gains 63 lines (Fact D1). Check the licenses of what was added: `markdown-it`, `parse5`, `linkify-it`, `mdurl`, `uc.micro`, `punycode.js` MIT, `entities` BSD-2-Clause, `argparse` Python-2.0 (CLI only, Fact D1).

- [ ] **Step 2: Write the failing tests**

Create `packages/flux-import/tests/unit/portable-text.test.ts`:
````ts
import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	convertPortableText,
	type DraftBlock,
	imageUrl,
	type PortableTextConverted,
	type PortableTextOptions,
	safeHref,
} from "../../src/engine/portable-text.js";

const HTML: PortableTextOptions = {
	format: "html",
	baseUrl: null,
	images: "import",
	imageErrors: "drop",
	unknownMarkup: "warn",
};
const convert = (text: string, options: Partial<PortableTextOptions> = {}) =>
	convertPortableText(text, { ...HTML, ...options });
const markdown = (text: string) => convert(text, { format: "markdown" });

/** Each block as one line: `style list level: text`, `image #slot`, `code lang: text`, `break`. */
function outline(converted: PortableTextConverted): string[] {
	return (converted.draft?.blocks ?? []).map((b: DraftBlock) => {
		if (b._type === "image") return `image #${b.slot}`;
		if (b._type === "break") return "break";
		if (b._type === "code") return `code ${b.language ?? "-"}: ${b.code}`;
		const text = (b.children as { text: string }[]).map((s) => s.text).join("");
		const list = b.listItem === undefined ? "" : ` ${b.listItem} ${b.level}`;
		return `${b.style}${list}: ${text}`;
	});
}

const span = (key: string, text: string, marks: string[] = []) => ({
	_type: "span",
	_key: key,
	text,
	marks,
});

describe("convertPortableText: blocks and marks", () => {
	it("builds the blocks and marks EmDash's editor writes", () => {
		const html = `<h2>Title <em>here</em></h2>
<p>Read <strong>this</strong> <a href="https://example.com/a" target="_blank">now</a><br>then</p>
<ul><li>one<ul><li>two</li></ul></li></ul>
<pre><code class="language-ts">const a = 1;</code></pre><hr>`;
		expect(convert(html)).toEqual({
			draft: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "h2",
						children: [span("b0s0", "Title "), span("b0s1", "here", ["em"])],
					},
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						children: [
							span("b1s0", "Read "),
							span("b1s1", "this", ["strong"]),
							span("b1s2", " "),
							// The editor ends a span at a hard break and keeps the `\n` in it.
							span("b1s3", "now\n", ["b1l0"]),
							span("b1s4", "then"),
						],
						markDefs: [{ _type: "link", _key: "b1l0", href: "https://example.com/a", blank: true }],
					},
					{
						_type: "block",
						_key: "b2",
						style: "normal",
						listItem: "bullet",
						level: 1,
						children: [span("b2s0", "one")],
					},
					{
						_type: "block",
						_key: "b3",
						style: "normal",
						listItem: "bullet",
						level: 2,
						children: [span("b3s0", "two")],
					},
					{ _type: "code", _key: "b4", code: "const a = 1;", language: "ts" },
					{ _type: "break", _key: "b5", style: "lineBreak" },
				],
				images: [],
			},
			errors: [],
			warnings: [],
		});
	});

	it("maps every decorator in nesting order and merges equal neighbours", () => {
		const html =
			"<b>a<i>b<u>c</u></i></b><s>s</s><strike>k</strike><del>d</del><code>x</code><sub>1</sub><sup>2</sup><em><strong>e</strong></em>";
		const children = convert(html).draft?.blocks[0]?.children;
		expect(children).toEqual([
			span("b0s0", "a", ["strong"]),
			span("b0s1", "b", ["strong", "em"]),
			span("b0s2", "c", ["strong", "em", "underline"]),
			span("b0s3", "skd", ["strike-through"]),
			span("b0s4", "x", ["code"]),
			span("b0s5", "1", ["subscript"]),
			span("b0s6", "2", ["superscript"]),
			span("b0s7", "e", ["em", "strong"]),
		]);
	});

	it("nests lists up to level 6 and keeps a list item's paragraphs in one block", () => {
		let html = "";
		for (let i = 1; i <= 7; i++) html += `<${i < 3 ? "ol" : "ul"}><li>${i}`;
		expect(outline(convert(html))).toEqual([
			"normal number 1: 1",
			"normal number 2: 2",
			"normal bullet 3: 3",
			"normal bullet 4: 4",
			"normal bullet 5: 5",
			"normal bullet 6: 6",
			"normal bullet 6: 7",
		]);
		expect(
			outline(
				convert("<ul><li><p>one</p><p>two</p>tail</li><li>x<div>y</div></li></ul><li>loose</li>"),
			),
		).toEqual([
			"normal bullet 1: one\ntwo\ntail",
			"normal bullet 1: x\ny",
			"normal bullet 1: loose",
		]);
	});

	it("gives quotes and headings their style", () => {
		expect(
			outline(convert("<blockquote><p>a</p><p>b</p></blockquote><h1>c</h1><h6>d</h6><p>e</p>")),
		).toEqual(["blockquote: a", "blockquote: b", "h1: c", "h6: d", "normal: e"]);
	});

	it("keeps pre text exactly, with the language of a language- or lang- class", () => {
		expect(outline(convert('<pre class="lang-js">\n  x  <b>y</b>\n\n z</pre>'))).toEqual([
			"code js:   x  y\n\n z",
		]);
		expect(outline(convert("<pre><code>\nfirst\n</code></pre><pre> </pre>"))).toEqual([
			"code -: first\n",
		]);
		expect(outline(markdown("```py\nprint(1)\n```\n"))).toEqual(["code py: print(1)\n"]);
	});

	it("collapses HTML whitespace, trims blocks, and drops empty ones", () => {
		const converted = convert(
			"<p>  a \n\t b  <b> c </b>  d<br>  e  </p><p> </p><p><br>f<br></p><p>&nbsp;</p>",
		);
		expect(converted.draft?.blocks.map((b) => b.children)).toEqual([
			[
				span("b0s0", "a b "),
				span("b0s1", "c ", ["strong"]),
				span("b0s2", "d\n"),
				span("b0s3", "e"),
			],
			[span("b1s0", "f")],
			[span("b2s0", " ")],
		]);
	});

	it("keeps transparent markup silently, and drops attributes and comments", () => {
		const html = `<!-- wp:paragraph --><div class="x"><section><p onclick="x()" style="color:red">a <span>b</span> <font>c</font> <mark>d</mark></p></section></div><!-- /wp:paragraph --><!--ec:block {"_type":"htmlBlock","html":"<script>x</script>"}-->e`;
		const converted = convert(html);
		expect(outline(converted)).toEqual(["normal: a b c d", "normal: e"]);
		expect(converted.warnings).toEqual([]);
		expect(JSON.stringify(converted)).not.toMatch(/onclick|color|htmlBlock|script/);
	});
});

describe("convertPortableText: unknown and removed markup", () => {
	it("keeps the text of unknown markup, with one counted warning per tag", () => {
		const html =
			"<table><thead><tr><th>A</th><th>B</th></tr></thead><tr><td>1</td><td></td><td>3</td></tr></table><table><tr><td>x</td></tr></table><dl><dt>T</dt><dd>D</dd></dl><p>a <my-widget>w</my-widget></p>";
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"normal: A | B",
			"normal: 1 | 3",
			"normal: x",
			"normal: T",
			"normal: D",
			"normal: a w",
		]);
		expect(converted.warnings).toEqual([
			{ code: "unknown_markup", message: "Kept the text of 2 <table> elements" },
			{ code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
			{ code: "unknown_markup", message: "Kept the text of 1 <my-widget> element" },
		]);
	});

	it("removes active content with everything in it, and reports it", () => {
		const html =
			'<p>a<script>alert("s")</script><style>p{}</style>b</p><iframe src="x"></iframe><iframe></iframe><svg onload="x()"><text>svg</text></svg><form><input value="i">form</form><noscript>ns</noscript><pre>c<script>alert(2)</script></pre>';
		const converted = convert(html);
		expect(outline(converted)).toEqual(["normal: ab", "code -: c"]);
		expect(converted.warnings).toEqual([
			{ code: "removed_markup", message: "Removed 2 <script> elements" },
			{ code: "removed_markup", message: "Removed 1 <style> element" },
			{ code: "removed_markup", message: "Removed 2 <iframe> elements" },
			{ code: "removed_markup", message: "Removed 1 <svg> element" },
			{ code: "removed_markup", message: "Removed 1 <form> element" },
			{ code: "removed_markup", message: "Removed 1 <noscript> element" },
		]);
		expect(JSON.stringify(converted.draft)).not.toMatch(/alert|svg|form|ns/);
		// Only removed markup: nothing is left, so the value is empty.
		expect(convert("<script>x</script><!-- c -->")).toEqual({
			draft: null,
			errors: [],
			warnings: [{ code: "removed_markup", message: "Removed 1 <script> element" }],
		});
	});

	it("fails unknown and removed markup and dropped links with unknownMarkup: fail", () => {
		const converted = convert(
			'<table><tr><td>t</td></tr></table><script>x</script><a href="javascript:x">j</a>',
			{
				unknownMarkup: "fail",
			},
		);
		expect(converted.errors.map((e) => e.code)).toEqual([
			"unknown_markup",
			"removed_markup",
			"link_dropped",
		]);
		expect(converted.warnings).toEqual([]);
	});

	it("emits only the block and mark types EmDash's editor accepts", () => {
		const html =
			'<h1>a</h1><p><b>b</b><a href="https://x.test">l</a></p><ul><li>c</li></ul><pre>d</pre><hr><img src="https://x.test/a.png"><table><tr><td>e</td></tr></table><video src="v.mp4"></video><!--ec:block {"_type":"iframe"}-->';
		const blocks = convert(html).draft?.blocks ?? [];
		expect(new Set(blocks.map((b) => b._type))).toEqual(
			new Set(["block", "code", "break", "image"]),
		);
		const marks = blocks.flatMap((b) =>
			((b.children ?? []) as { marks: string[] }[]).flatMap((s) => s.marks),
		);
		expect(marks.every((m) => ["strong", "b1l0"].includes(m))).toBe(true);
	});
});

describe("convertPortableText: links", () => {
	it("keeps only safe schemes and fragments, and shares a definition per href and target", () => {
		const html =
			'<a href="javascript:alert(1)">j</a> <a href="&#106;avascript:x">e</a> <a href="data:text/html,x">d</a> <a href="vbscript:x">v</a> <a href="java\tscript:x">t</a> <a href="ftp://x">f</a> <a href="/rel">r</a> <a href="#top">h</a> <a href="mailto:a@b.c">m</a> <a href="tel:+1">p</a> <a href="https://x.test/a">1</a><a href="https://x.test/a">2</a><a href="https://x.test/a" target="_blank">3</a> <a name="n">n</a>';
		const converted = convert(html);
		const block = converted.draft?.blocks[0];
		expect(block?.markDefs).toEqual([
			{ _type: "link", _key: "b0l0", href: "#top" },
			{ _type: "link", _key: "b0l1", href: "mailto:a@b.c" },
			{ _type: "link", _key: "b0l2", href: "tel:+1" },
			{ _type: "link", _key: "b0l3", href: "https://x.test/a" },
			{ _type: "link", _key: "b0l4", href: "https://x.test/a", blank: true },
		]);
		expect(block?.children).toContainEqual(span("b0s7", "12", ["b0l3"]));
		expect(converted.warnings).toEqual([
			{
				code: "link_dropped",
				message:
					"Kept the text of 2 links without the address: the scheme javascript: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme data: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme vbscript: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: it contains control characters",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme ftp: is not allowed",
			},
			{
				code: "link_dropped",
				message:
					"Kept the text of 1 link without the address: a relative address needs the mapping's baseUrl",
			},
		]);
	});

	it("resolves relative and protocol-relative links, and refuses long ones", () => {
		const base = new URL("https://old.test/blog/post/");
		expect(safeHref("../a b", base)).toEqual({ ok: true, href: "https://old.test/blog/a%20b" });
		expect(safeHref("//cdn.test/x", base)).toEqual({ ok: true, href: "https://cdn.test/x" });
		expect(safeHref("//cdn.test/x", new URL("http://old.test/"))).toEqual({
			ok: true,
			href: "http://cdn.test/x",
		});
		expect(safeHref("//cdn.test/x", null)).toEqual({ ok: true, href: "https://cdn.test/x" });
		expect(safeHref(" HTTPS://X.test ", null)).toEqual({ ok: true, href: "https://x.test/" });
		expect(safeHref(`https://x.test/${"a".repeat(2048)}`, null)).toEqual({
			ok: false,
			reason: "it is longer than 2048 characters",
		});
		expect(safeHref("https://x y", null)).toEqual({ ok: false, reason: "it is not a valid URL" });
	});
});

describe("convertPortableText: images", () => {
	it("ends the block at an image and continues with the same style and list position", () => {
		const html =
			'<p>before <img src="https://x.test/a.png" alt=" A "> after</p><ul><li>a<img src="https://x.test/b.png">b</li></ul><h3>c<img src="https://x.test/a.png">d</h3>';
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"normal: before",
			"image #0",
			"normal: after",
			"normal bullet 1: a",
			"image #1",
			"normal bullet 1: b",
			"h3: c",
			"image #0",
			"h3: d",
		]);
		expect(converted.draft?.images).toEqual([
			{ url: "https://x.test/a.png", alt: "A" },
			{ url: "https://x.test/b.png", alt: null },
		]);
		expect(converted.draft?.blocks[1]).toEqual({ _type: "image", _key: "b1", slot: 0, alt: "A" });
	});

	it("takes data-src for lazy images, resolves against baseUrl, and normalizes the URL", () => {
		const converted = convert(
			'<img src="data:image/gif;base64,R0lGOD" data-src="/a.png"><img data-src="b.png"><img src="//CDN.test/c.png#x"><img src="https://x.test:443/a/../d.png">',
			{ baseUrl: "https://old.test/blog/" },
		);
		expect(converted.draft?.images.map((i) => i.url)).toEqual([
			"https://old.test/a.png",
			"https://old.test/blog/b.png",
			"https://cdn.test/c.png",
			"https://x.test/d.png",
		]);
		expect(imageUrl("//cdn.test/c.png", null)).toEqual({ ok: true, url: "https://cdn.test/c.png" });
	});

	it("drops an image with a bad URL with a warning, or fails it with imageErrors: fail", () => {
		const html =
			'<p>a<img src="/rel.png">b</p><img src="data:image/png;base64,iVBOR"><img src="https://u:p@x.test/a.png"><img>';
		const dropped = convert(html);
		expect(outline(dropped)).toEqual(["normal: ab"]);
		expect(dropped.warnings).toEqual([
			{
				code: "image_dropped",
				message: "invalid_media_url: /rel.png: A relative URL needs the mapping's baseUrl",
			},
			{
				code: "image_dropped",
				message:
					'invalid_media_url: data:image/png;base64,iVBOR: The URL scheme "data:" is not allowed; use http or https',
			},
			{
				code: "image_dropped",
				message:
					"invalid_media_url: https://u:p@x.test/a.png: URLs cannot contain a user name or password; use a credential",
			},
		]);
		const failed = convert(html, { imageErrors: "fail" });
		expect(failed.errors.map((e) => [e.code, e.message.split(":")[0]])).toEqual([
			["invalid_media_url", "/rel.png"],
			["invalid_media_url", "data"],
			["invalid_media_url", "https"],
		]);
		expect(failed.warnings).toEqual([]);
	});

	it("gives a figure's caption to its one image, and keeps it as a paragraph otherwise", () => {
		const html =
			'<figure><img src="https://x.test/a.png"><figcaption> Cap <b>tion</b> <script>x</script></figcaption></figure><figure><img src="https://x.test/b.png"><img src="https://x.test/c.png"><figcaption>Two</figcaption></figure><figure><blockquote>q</blockquote><figcaption>said</figcaption></figure>';
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"image #0",
			"image #1",
			"image #2",
			"normal: Two",
			"blockquote: q",
			"normal: said",
		]);
		expect(converted.draft?.blocks[0]).toEqual({
			_type: "image",
			_key: "b0",
			slot: 0,
			caption: "Cap tion",
		});
		expect(converted.warnings).toEqual([
			{ code: "removed_markup", message: "Removed 1 <script> element" },
		]);
		const long = convert(
			`<figure><img src="https://x.test/a.png"><figcaption>${"c".repeat(1001)}</figcaption></figure>`,
		);
		expect(long.draft?.blocks[0]?.caption).toHaveLength(1000);
	});

	it("links an image inside a link, and keeps the alt, cut at 1,000 characters", () => {
		const html = `<a href="https://x.test/big" target="_blank">see <img src="https://x.test/a.png" alt="${"a".repeat(1001)}"></a><a href="javascript:x"><img src="https://x.test/b.png"></a>`;
		const converted = convert(html);
		expect(converted.draft?.blocks[1]).toEqual({
			_type: "image",
			_key: "b1",
			slot: 0,
			alt: "a".repeat(1000),
			link: { href: "https://x.test/big", blank: true },
		});
		expect(converted.draft?.blocks[2]).toEqual({ _type: "image", _key: "b2", slot: 1 });
		expect(converted.warnings).toContainEqual({
			code: "alt_truncated",
			message: "Cut the alt text of 1 image to 1000 characters",
		});
	});

	it("lists each URL once, keeps each image's alt, and skips images with images: skip", () => {
		const html =
			'<picture><source srcset="a.webp"><img src="https://x.test/a.png" alt="one"></picture><p>t</p><img src="https://X.test/a.png#f" alt="two">';
		const converted = convert(html);
		expect(converted.draft?.images).toEqual([{ url: "https://x.test/a.png", alt: "one" }]);
		expect(converted.draft?.blocks.filter((b) => b._type === "image")).toEqual([
			{ _type: "image", _key: "b0", slot: 0, alt: "one" },
			{ _type: "image", _key: "b2", slot: 0, alt: "two" },
		]);
		expect(converted.warnings).toEqual([]);
		const skipped = convert(`${html}<img src="/relative.png">`, { images: "skip" });
		expect(outline(skipped)).toEqual(["normal: t"]);
		expect(skipped.draft?.images).toEqual([]);
		expect(skipped.warnings).toEqual([]);
	});
});

describe("convertPortableText: formats, keys and limits", () => {
	it("is deterministic: the same input gives the same keys and value", () => {
		const html =
			'<p>a <b>b</b> <a href="https://x.test">c</a></p><img src="https://x.test/a.png"><ul><li>d</li></ul>';
		expect(convert(html)).toEqual(convert(html));
		const keys = JSON.stringify(convert(html)).match(/"_key":"[^"]+"/g);
		expect(keys).toEqual([
			'"_key":"b0"',
			'"_key":"b0s0"',
			'"_key":"b0s1"',
			'"_key":"b0s2"',
			'"_key":"b0s3"',
			'"_key":"b0l0"',
			'"_key":"b1"',
			'"_key":"b2"',
			'"_key":"b2s0"',
		]);
	});

	it("splits plain text into paragraphs on blank lines and keeps single line breaks", () => {
		expect(convert("  one\r\nline <b>two</b>\n\n\n three  \n \n", { format: "text" })).toEqual({
			draft: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "normal",
						children: [span("b0s0", "one\nline <b>two</b>")],
					},
					{ _type: "block", _key: "b1", style: "normal", children: [span("b1s0", "three")] },
				],
				images: [],
			},
			errors: [],
			warnings: [],
		});
	});

	it("refuses source text over 512 KiB and rendered Markdown over 2 MiB", () => {
		const tooLarge = {
			draft: null,
			errors: [{ code: "portable_text_too_large", message: "The text is larger than 512 KiB" }],
			warnings: [],
		};
		expect(convert(`<p>${"a".repeat(512 * 1024)}</p>`)).toEqual(tooLarge);
		// 2 bytes in UTF-8 each: over the limit with half as many characters.
		expect(convert("é".repeat(256 * 1024 + 1), { format: "text" })).toEqual(tooLarge);
		expect(convert("é".repeat(256 * 1024), { format: "text" }).errors).toEqual([]);
		// Each "<" renders as "&lt;": 512 KiB of them is more than 2 MiB of HTML.
		expect(convert("<".repeat(512 * 1024), { format: "markdown" }).errors).toEqual([
			{
				code: "portable_text_too_large",
				message: "The Markdown renders to more than 2 MiB of HTML",
			},
		]);
	});

	it("refuses markup that keeps more than 256 elements open, implied ones included", () => {
		const tooComplex = [
			{
				code: "portable_text_too_complex",
				message: "The markup nests more than 256 elements deep",
			},
		];
		expect(convert(`${"<div>".repeat(256)}x`).errors).toEqual([]);
		expect(convert(`${"<div>".repeat(257)}x`).errors).toEqual(tooComplex);
		// Each list item opens an element without being counted in the source's end tags.
		expect(convert(`${"<ul><li>".repeat(128)}x`).errors).toEqual([]);
		expect(convert(`${"<ul><li>".repeat(129)}x`).errors).toEqual(tooComplex);
		expect(convert(`${"<b>".repeat(300)}x`).errors).toEqual(tooComplex);
	});

	it("stays fast at the limits", () => {
		const fill = (unit: string, prefix: string) =>
			prefix + unit.repeat(Math.floor((512 * 1024 - prefix.length) / unit.length));
		for (const html of [
			fill("</p>", "<div>".repeat(255)),
			fill("<li>", "<div>".repeat(255)),
			fill("</p>", "<ul><li>".repeat(127)),
			fill("<p>Some <b>bold</b> and <a href='/x'>a link</a>.</p>", ""),
		]) {
			const started = performance.now();
			expect(convert(html).errors).toEqual([]);
			expect(performance.now() - started).toBeLessThan(2000);
		}
	});
});

describe("convertPortableText: Markdown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders CommonMark with tables and strikethrough through the HTML rules", () => {
		const converted = markdown(
			"# H1\n\nSome *em* **strong** ~~del~~ `code` [link](https://x.test) ![alt](https://x.test/i.png)\n\n- a\n  - b\n\n1. n\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>raw <script>x</script></div>\n\n- [ ] task\n",
		);
		expect(outline(converted)).toEqual([
			"h1: H1",
			"normal: Some em strong del code link",
			"image #0",
			"normal bullet 1: a",
			"normal bullet 2: b",
			"normal number 1: n",
			"blockquote: q",
			"normal: a | b",
			"normal: 1 | 2",
			"normal: raw",
			"normal bullet 1: [ ] task",
		]);
		expect(converted.draft?.blocks[1]?.children).toEqual([
			span("b1s0", "Some "),
			span("b1s1", "em", ["em"]),
			span("b1s2", " "),
			span("b1s3", "strong", ["strong"]),
			span("b1s4", " "),
			span("b1s5", "del", ["strike-through"]),
			span("b1s6", " "),
			span("b1s7", "code", ["code"]),
			span("b1s8", " "),
			span("b1s9", "link", ["b1l0"]),
		]);
		expect(converted.draft?.images).toEqual([{ url: "https://x.test/i.png", alt: "alt" }]);
		expect(converted.warnings).toEqual([
			{ code: "unknown_markup", message: "Kept the text of 1 <table> element" },
			{ code: "removed_markup", message: "Removed 1 <script> element" },
		]);
	});

	it("stays linear on inputs that are quadratic in other parsers", () => {
		const cases = [
			"*a ".repeat(50_000),
			"_a ".repeat(50_000),
			"[".repeat(50_000),
			`${">".repeat(5000)} a`,
			// 700 nested list levels: about 490 KB.
			Array.from({ length: 700 }, (_, i) => `${"  ".repeat(i)}- item`).join("\n"),
			"[a](".repeat(50_000),
			"**a ".repeat(100_000),
		];
		for (const text of cases) {
			const started = performance.now();
			const converted = markdown(text);
			expect(converted.errors).toEqual([]);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});

	it("fails the record, not the batch, when a parser throws", () => {
		vi.spyOn(MarkdownIt.prototype, "render").mockImplementation(() => {
			throw new RangeError("Maximum call stack size exceeded");
		});
		expect(markdown("# a")).toEqual({
			draft: null,
			errors: [
				{
					code: "portable_text_failed",
					message: "The Markdown could not be converted: Maximum call stack size exceeded",
				},
			],
			warnings: [],
		});
	});
});
````

- [ ] **Step 3: Run them to see them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/portable-text.test.ts`
Expected: FAIL: the file does not load (`Cannot find module '../../src/engine/portable-text.js'`), no tests run.

- [ ] **Step 4: Implement**

Create `packages/flux-import/src/engine/portable-text.ts`:
````ts
/**
 * Portable Text from HTML, Markdown or plain text (M4d). HTML is parsed with `parse5` and walked
 * without recursion into the blocks and marks EmDash's editor writes. Markdown is rendered to
 * HTML by `markdown-it` first, so both share one set of rules. Markup the converter does not know
 * keeps its text and is reported; active content is removed and reported. Each image becomes a
 * slot that resolution turns into an image block referencing a Media Library item.
 */
import MarkdownIt from "markdown-it";
import {
	type DefaultTreeAdapterMap,
	type DefaultTreeAdapterTypes,
	defaultTreeAdapter,
	parseFragment,
	type TreeAdapter,
} from "parse5";
import { MAX_ALT_LENGTH, normalizeMediaUrl } from "./media.js";
import type { JsonValue } from "./values.js";

/** `portableText` mappings a template may have, so a record converts at most this many. */
export const MAX_PORTABLE_TEXT_MAPPINGS = 3;
/** The source text of one field, in UTF-8 bytes. */
export const MAX_PORTABLE_TEXT_SOURCE_BYTES = 512 * 1024;
/** The HTML `markdown-it` renders for one field, in UTF-8 bytes. */
export const MAX_RENDERED_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** The open elements `parse5` may hold at once: its work grows with this depth squared. */
export const MAX_PORTABLE_TEXT_NESTING = 256;
/** The Portable Text JSON of one record, over every mapped field, in UTF-8 bytes. */
export const MAX_PORTABLE_TEXT_RECORD_BYTES = 1024 * 1024;
/** Distinct image URLs in one record's Portable Text. */
export const MAX_PORTABLE_TEXT_IMAGES = 50;
export const MAX_LIST_LEVEL = 6;
export const MAX_CAPTION_LENGTH = 1000;
/** The longest `href` kept. */
export const MAX_HREF_LENGTH = 2048;

export type PortableTextFormat = "html" | "markdown" | "text";

/** A `portableText` mapping's options, with their defaults filled in. */
export type PortableTextOptions = {
	format: PortableTextFormat;
	/** An absolute http(s) URL that relative `href` and `src` resolve against; null without one. */
	baseUrl: string | null;
	images: "import" | "skip";
	imageErrors: "drop" | "fail";
	unknownMarkup: "warn" | "fail";
};

export type PortableTextCode =
	| "unknown_markup"
	| "removed_markup"
	| "link_dropped"
	| "alt_truncated"
	| "image_dropped"
	| "invalid_media_url"
	| "portable_text_too_large"
	| "portable_text_too_complex"
	| "portable_text_limit"
	| "portable_text_failed";

export type PortableTextIssue = { code: PortableTextCode; message: string };

/** One distinct image URL of a field; slots index into the field's list. */
export type PortableTextImage = {
	/** Normalized (`normalizeMediaUrl`), the media map key's input. */
	url: string;
	/** The alt of the URL's first image, the library default for a new item. */
	alt: string | null;
};

/** A Portable Text block as JSON; an image block holds `slot` until resolution gives it `asset`. */
export type DraftBlock = { [key: string]: JsonValue };

/** One field's converted value before its images are resolved. */
export type PortableTextDraft = {
	blocks: DraftBlock[];
	images: PortableTextImage[];
};

/** A conversion: the draft (null when empty), and what to report. Any error fails the record. */
export type PortableTextConverted = {
	draft: PortableTextDraft | null;
	errors: PortableTextIssue[];
	warnings: PortableTextIssue[];
};

/** The Markdown dialect: CommonMark with tables and strikethrough, raw HTML through our rules. */
const markdown = new MarkdownIt("commonmark", {
	html: true,
	linkify: false,
	typographer: false,
}).enable(["table", "strikethrough"]);

/** Thrown inside `parse5` when the open-element stack grows past the limit. */
class TooComplex extends Error {}

/**
 * The default tree adapter with a count of open elements: the parse stops as soon as more than
 * `MAX_PORTABLE_TEXT_NESTING` are open, which bounds `parse5`'s quadratic scope checks.
 * `onItemPush` and `onItemPop` are part of parse5's `TreeAdapter` interface.
 */
function nestingGuard(): TreeAdapter<DefaultTreeAdapterMap> {
	let open = 0;
	return {
		...defaultTreeAdapter,
		onItemPush() {
			// The fragment parser's own root element is the first push.
			open++;
			if (open > MAX_PORTABLE_TEXT_NESTING + 1) throw new TooComplex();
		},
		onItemPop() {
			open--;
		},
	};
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** Whether `text` is over `limit` UTF-8 bytes; every UTF-16 unit is at least one byte. */
function overBytes(text: string, limit: number): boolean {
	return text.length > limit || utf8Bytes(text) > limit;
}

const KIB = 1024;

/**
 * Converts one source value. A missing value, `null`, blank text, or markup that leaves no block
 * is empty (`draft: null`). Anything but text fails `not_scalar` in `applyTemplate` before this
 * runs. Errors from the parsers (a `RangeError` among them) fail `portable_text_failed`.
 */
export function convertPortableText(
	text: string,
	options: PortableTextOptions,
): PortableTextConverted {
	const fail = (code: PortableTextCode, message: string): PortableTextConverted => ({
		draft: null,
		errors: [{ code, message }],
		warnings: [],
	});
	if (overBytes(text, MAX_PORTABLE_TEXT_SOURCE_BYTES)) {
		return fail(
			"portable_text_too_large",
			`The text is larger than ${MAX_PORTABLE_TEXT_SOURCE_BYTES / KIB} KiB`,
		);
	}
	if (options.format === "text") return { draft: textDraft(text), errors: [], warnings: [] };
	let html = text;
	try {
		if (options.format === "markdown") html = markdown.render(text);
	} catch (e) {
		return fail("portable_text_failed", `The Markdown could not be converted: ${errorText(e)}`);
	}
	if (overBytes(html, MAX_RENDERED_MARKDOWN_BYTES)) {
		return fail(
			"portable_text_too_large",
			`The Markdown renders to more than ${MAX_RENDERED_MARKDOWN_BYTES / KIB / KIB} MiB of HTML`,
		);
	}
	let fragment: DefaultTreeAdapterTypes.DocumentFragment;
	try {
		fragment = parseFragment(html, { treeAdapter: nestingGuard() });
	} catch (e) {
		if (e instanceof TooComplex) {
			return fail(
				"portable_text_too_complex",
				`The markup nests more than ${MAX_PORTABLE_TEXT_NESTING} elements deep`,
			);
		}
		return fail("portable_text_failed", `The HTML could not be parsed: ${errorText(e)}`);
	}
	try {
		return new Walker(options).run(fragment);
	} catch (e) {
		return fail("portable_text_failed", `The HTML could not be converted: ${errorText(e)}`);
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Plain text: paragraphs split on blank lines, single line breaks kept as `\n`. */
function textDraft(text: string): PortableTextDraft | null {
	const paragraphs = text
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	if (paragraphs.length === 0) return null;
	const blocks = paragraphs.map((p, i): DraftBlock => {
		const key = `b${i}`;
		return {
			_type: "block",
			_key: key,
			style: "normal",
			children: [{ _type: "span", _key: `${key}s0`, text: p, marks: [] }],
		};
	});
	return { blocks, images: [] };
}

/** Inline elements whose decorator EmDash's editor accepts (spec F9). */
const DECORATORS: Readonly<Record<string, string>> = {
	strong: "strong",
	b: "strong",
	em: "em",
	i: "em",
	u: "underline",
	s: "strike-through",
	strike: "strike-through",
	del: "strike-through",
	code: "code",
	sub: "subscript",
	sup: "superscript",
};
const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Kept as text without a warning; block containers end the current paragraph. */
const TRANSPARENT_BLOCK: ReadonlySet<string> = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"footer",
	"aside",
	"nav",
	"address",
	"figure",
	"figcaption",
	"center",
	"html",
	"body",
]);
const TRANSPARENT_INLINE: ReadonlySet<string> = new Set([
	"span",
	"font",
	"small",
	"mark",
	"ins",
	"abbr",
	"cite",
	"q",
	"dfn",
	"kbd",
	"samp",
	"var",
	"time",
	"data",
	"bdi",
	"bdo",
	"wbr",
	"picture",
]);
/** Active content: removed with everything inside it. */
const REMOVED: ReadonlySet<string> = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"frame",
	"object",
	"embed",
	"video",
	"audio",
	"canvas",
	"svg",
	"math",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"link",
	"meta",
	"base",
]);
/** Unknown elements that hold lines of text: each becomes a paragraph. */
const UNKNOWN_LINES: ReadonlySet<string> = new Set([
	"tr",
	"dt",
	"dd",
	"caption",
	"summary",
	"legend",
]);
/** Unknown elements that end the current paragraph. */
const UNKNOWN_BLOCKS: ReadonlySet<string> = new Set([
	"table",
	"thead",
	"tbody",
	"tfoot",
	"colgroup",
	"dl",
	"details",
	"fieldset",
	"hgroup",
	"menu",
	"dialog",
	"search",
]);
/** Parts of a reported element (a table's rows, a list's terms): not reported themselves. */
const PARTS: ReadonlySet<string> = new Set([
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"caption",
	"colgroup",
	"col",
	"dt",
	"dd",
	"summary",
	"legend",
	"source",
]);

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type LinkTarget = { href: string; blank: boolean };

/** What a new text block starts as, where text arrives. */
type BlockContext = {
	style: string;
	listItem?: "bullet" | "number";
	level?: number;
	/** A list item, row or term: inner paragraphs join with `\n` instead of ending the block. */
	line?: boolean;
	/** Table rows: the cells seen so far. */
	cells?: number;
};

type SpanDraft = { text: string; decorators: readonly string[]; link: number | null };
type TextDraft = { context: BlockContext; spans: SpanDraft[]; links: LinkTarget[] };
type Out =
	| { kind: "text"; block: TextDraft }
	| { kind: "code"; code: string; language: string | null }
	| { kind: "break" }
	| {
			kind: "image";
			slot: number;
			alt: string | null;
			caption: string | null;
			link: LinkTarget | null;
	  };

/** What an element's exit restores and finishes. */
type Exit = {
	element: Element;
	contexts: number;
	lists: number;
	decorators: number;
	links: number;
	/** The element ended the current block when it started, and ends it again. */
	block: boolean;
	/** The element is a paragraph inside a line: the next text starts on a new line. */
	join: boolean;
	figure: boolean;
};

type Frame = { node: ChildNode } | { exit: Exit };

const WHITESPACE = /[\t\n\f\r ]+/g;
const LANGUAGE = /(?:^|\s)lang(?:uage)?-([A-Za-z0-9_+#.-]{1,40})(?=\s|$)/;

function attr(element: Element, name: string): string | null {
	return element.attrs.find((a) => a.name === name)?.value ?? null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** A URL as messages show it: at most 200 characters. */
export function shownUrl(url: string): string {
	return url.length > 200 ? `${url.slice(0, 199)}…` : url;
}
/** A tag name as messages show it. */
const shownTag = (tag: string) => (tag.length > 40 ? `${tag.slice(0, 39)}…` : tag);

/** One field's HTML, walked into blocks with an explicit stack. */
class Walker {
	private readonly out: Out[] = [];
	private open: TextDraft | null = null;
	/** Text to put before the next text of the open block: `\n` or a cell separator. */
	private pending: string | null = null;
	private readonly contexts: BlockContext[] = [{ style: "normal" }];
	private readonly lists: ("bullet" | "number")[] = [];
	private readonly decorators: string[] = [];
	private readonly links: (LinkTarget | null)[] = [];
	private readonly figures: { images: number[]; caption: string }[] = [];
	private readonly images: PortableTextImage[] = [];
	private readonly slots = new Map<string, number>();
	private readonly base: URL | null;
	private readonly unknown = new Map<string, number>();
	private readonly removed = new Map<string, number>();
	private readonly dropped = new Map<string, number>();
	private altCut = 0;
	private readonly imageIssues: PortableTextIssue[] = [];

	constructor(private readonly options: PortableTextOptions) {
		this.base = options.baseUrl === null ? null : new URL(options.baseUrl);
	}

	run(fragment: DefaultTreeAdapterTypes.DocumentFragment): PortableTextConverted {
		const stack: Frame[] = fragment.childNodes.map((node) => ({ node })).reverse();
		for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
			if ("exit" in frame) this.leave(frame.exit);
			else this.enter(frame.node, stack);
		}
		this.flush();
		return this.result();
	}

	private get context(): BlockContext {
		return this.contexts[this.contexts.length - 1] as BlockContext;
	}

	private enter(node: ChildNode, stack: Frame[]): void {
		if (node.nodeName === "#text") {
			this.text((node as DefaultTreeAdapterTypes.TextNode).value);
			return;
		}
		if (!("tagName" in node)) return; // comments and doctypes
		const element = node as Element;
		const tag = element.tagName;
		if (REMOVED.has(tag)) {
			this.count(this.removed, tag);
			return;
		}
		if (this.leaf(element)) return;
		const exit: Exit = {
			element,
			contexts: this.contexts.length,
			lists: this.lists.length,
			decorators: this.decorators.length,
			links: this.links.length,
			block: false,
			join: false,
			figure: false,
		};
		const decorator = DECORATORS[tag];
		if (decorator !== undefined) this.decorators.push(decorator);
		else if (tag === "a") this.links.push(this.link(element));
		else if (HEADINGS.has(tag)) {
			this.flush();
			exit.block = true;
			this.contexts.push({ style: tag });
		} else if (tag === "blockquote") {
			this.flush();
			exit.block = true;
			this.contexts.push({ style: "blockquote" });
		} else if (tag === "ul" || tag === "ol") {
			this.flush();
			exit.block = true;
			this.lists.push(tag === "ul" ? "bullet" : "number");
		} else if (tag === "li") {
			this.flush();
			exit.block = true;
			this.contexts.push({
				style: "normal",
				listItem: this.lists[this.lists.length - 1] ?? "bullet",
				level: Math.min(Math.max(this.lists.length, 1), MAX_LIST_LEVEL),
				line: true,
			});
		} else if (TRANSPARENT_BLOCK.has(tag)) {
			if (tag === "figure") {
				this.figures.push({ images: [], caption: "" });
				exit.figure = true;
			}
			if (this.context.line) {
				exit.join = true;
				if (this.open !== null) this.pending = "\n";
			} else {
				this.flush();
				exit.block = true;
			}
		} else if (TRANSPARENT_INLINE.has(tag)) {
			// Kept as text, silently: `picture`'s `source` elements are dropped below as parts.
		} else {
			if (!PARTS.has(tag)) this.count(this.unknown, tag);
			if (UNKNOWN_LINES.has(tag)) {
				this.flush();
				exit.block = true;
				this.contexts.push({ style: "normal", line: true, cells: 0 });
			} else if (tag === "td" || tag === "th") {
				const row = this.context;
				if (row.cells !== undefined) {
					if (row.cells > 0 && this.open !== null) this.pending = " | ";
					row.cells++;
				}
			} else if (UNKNOWN_BLOCKS.has(tag)) {
				this.flush();
				exit.block = true;
			}
		}
		stack.push({ exit });
		for (let i = element.childNodes.length - 1; i >= 0; i--) {
			stack.push({ node: element.childNodes[i] as ChildNode });
		}
	}

	/** Elements converted without walking their children; true when `element` is one. */
	private leaf(element: Element): boolean {
		switch (element.tagName) {
			case "br":
				this.lineBreak();
				return true;
			case "hr":
				this.flush();
				this.out.push({ kind: "break" });
				return true;
			case "img":
				this.image(element);
				return true;
			case "pre":
				this.pre(element);
				return true;
			case "figcaption":
				if (this.figures.length === 0) return false;
				this.caption(element);
				return true;
			default:
				return false;
		}
	}

	private leave(exit: Exit): void {
		if (exit.block) this.flush();
		if (exit.join && this.open !== null) this.pending = "\n";
		this.contexts.length = exit.contexts;
		this.lists.length = exit.lists;
		this.decorators.length = exit.decorators;
		this.links.length = exit.links;
		if (exit.figure) this.endFigure();
	}

	private count(counts: Map<string, number>, key: string): void {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	/** Appends text with the current marks, collapsing HTML whitespace. */
	private text(value: string): void {
		let text = value.replace(WHITESPACE, " ");
		if (this.open === null) {
			text = text.replace(/^ /, "");
			if (text === "") return;
			this.open = { context: this.context, spans: [], links: [] };
		}
		const block = this.open;
		if (this.pending !== null && this.hasText(block)) {
			this.trimEnd(block);
			this.append(block, this.pending, [], null);
			text = text.replace(/^ /, "");
		}
		this.pending = null;
		const last = block.spans[block.spans.length - 1]?.text ?? "";
		if (last === "" || last.endsWith(" ") || last.endsWith("\n")) text = text.replace(/^ /, "");
		if (text === "") return;
		const link = this.links[this.links.length - 1] ?? null;
		this.append(block, text, this.decorators, link === null ? null : this.linkIndex(block, link));
	}

	/** Whether the block has text besides HTML whitespace and line breaks. */
	private hasText(block: TextDraft): boolean {
		return block.spans.some((s) => /[^ \n]/.test(s.text));
	}

	private append(
		block: TextDraft,
		text: string,
		decorators: readonly string[],
		link: number | null,
	): void {
		const marks = [...new Set(decorators)];
		const last = block.spans[block.spans.length - 1];
		// The editor ends a span at each hard break, so text after one starts a new span.
		const joins = last && !last.text.endsWith("\n") && last.link === link;
		if (joins && sameList(last.decorators, marks)) last.text += text;
		else block.spans.push({ text, decorators: marks, link });
	}

	private trimEnd(block: TextDraft): void {
		const last = block.spans[block.spans.length - 1];
		if (last) last.text = last.text.replace(/ +$/, "");
	}

	private linkIndex(block: TextDraft, link: LinkTarget): number {
		const i = block.links.findIndex((l) => l.href === link.href && l.blank === link.blank);
		if (i !== -1) return i;
		block.links.push(link);
		return block.links.length - 1;
	}

	/** A `br`: `\n` at the end of the previous span, where EmDash's editor puts a hard break. */
	private lineBreak(): void {
		const last = this.open?.spans[this.open.spans.length - 1];
		if (last === undefined) return;
		this.pending = null;
		last.text = `${last.text.replace(/ +$/, "")}\n`;
	}

	/** Ends the open text block, keeping it when it has text. */
	private flush(): void {
		const block = this.open;
		this.open = null;
		this.pending = null;
		if (block === null) return;
		const spans = trimSpans(block.spans);
		if (spans.length > 0) this.out.push({ kind: "text", block: { ...block, spans } });
	}

	/** The link of an `a` element with `href`, or null: no `href`, or one that is dropped. */
	private link(element: Element): LinkTarget | null {
		const raw = attr(element, "href");
		if (raw === null) return null;
		const href = safeHref(raw, this.base);
		if (!href.ok) {
			this.count(this.dropped, href.reason);
			return null;
		}
		return { href: href.href, blank: attr(element, "target")?.trim().toLowerCase() === "_blank" };
	}

	private pre(element: Element): void {
		this.flush();
		let code = textOf(element, true, this.removed);
		if (code.startsWith("\n")) code = code.slice(1);
		if (code.trim() === "") return;
		const inner = element.childNodes.find(
			(n): n is Element => "tagName" in n && n.tagName === "code",
		);
		const classes = `${attr(element, "class") ?? ""} ${inner ? (attr(inner, "class") ?? "") : ""}`;
		const language = LANGUAGE.exec(classes)?.[1] ?? null;
		this.out.push({ kind: "code", code, language });
	}

	private caption(element: Element): void {
		const figure = this.figures[this.figures.length - 1];
		const text = textOf(element, false, this.removed);
		if (figure) figure.caption = figure.caption === "" ? text : `${figure.caption} ${text}`;
	}

	/** A figure's caption goes to its one image; with none or several, it is a paragraph. */
	private endFigure(): void {
		const figure = this.figures.pop();
		if (!figure || figure.caption === "") return;
		const caption = figure.caption.slice(0, MAX_CAPTION_LENGTH);
		const only = figure.images.length === 1 ? this.out[figure.images[0] as number] : undefined;
		if (only?.kind === "image" && only.caption === null) {
			only.caption = caption;
			return;
		}
		this.flush();
		this.text(figure.caption);
		this.flush();
	}

	private image(element: Element): void {
		if (this.options.images === "skip") return;
		const src = attr(element, "src")?.trim() ?? "";
		const lazy = attr(element, "data-src")?.trim() ?? "";
		const raw = (src === "" || /^data:/i.test(src)) && lazy !== "" ? lazy : src;
		if (raw === "") return;
		const resolved = imageUrl(raw, this.base);
		if (!resolved.ok) {
			const message = `${shownUrl(raw)}: ${resolved.message}`;
			this.imageIssues.push(
				this.options.imageErrors === "fail"
					? { code: "invalid_media_url", message }
					: { code: "image_dropped", message: `invalid_media_url: ${message}` },
			);
			return;
		}
		this.flush();
		let alt = attr(element, "alt")?.trim() ?? "";
		if (alt.length > MAX_ALT_LENGTH) {
			alt = alt.slice(0, MAX_ALT_LENGTH);
			this.altCut++;
		}
		let slot = this.slots.get(resolved.url);
		if (slot === undefined) {
			slot = this.images.length;
			this.slots.set(resolved.url, slot);
			this.images.push({ url: resolved.url, alt: alt === "" ? null : alt });
		}
		const link = this.links[this.links.length - 1] ?? null;
		this.figures[this.figures.length - 1]?.images.push(this.out.length);
		this.out.push({ kind: "image", slot, alt: alt === "" ? null : alt, caption: null, link });
	}

	private result(): PortableTextConverted {
		const errors: PortableTextIssue[] = [];
		const warnings: PortableTextIssue[] = [];
		const markup = this.options.unknownMarkup === "fail" ? errors : warnings;
		for (const [tag, n] of this.unknown) {
			markup.push({
				code: "unknown_markup",
				message: `Kept the text of ${plural(n, `<${shownTag(tag)}> element`)}`,
			});
		}
		for (const [tag, n] of this.removed) {
			markup.push({
				code: "removed_markup",
				message: `Removed ${plural(n, `<${shownTag(tag)}> element`)}`,
			});
		}
		for (const [reason, n] of this.dropped) {
			markup.push({
				code: "link_dropped",
				message: `Kept the text of ${plural(n, "link")} without the address: ${reason}`,
			});
		}
		if (this.altCut > 0) {
			warnings.push({
				code: "alt_truncated",
				message: `Cut the alt text of ${plural(this.altCut, "image")} to ${MAX_ALT_LENGTH} characters`,
			});
		}
		for (const issue of this.imageIssues) {
			(issue.code === "image_dropped" ? warnings : errors).push(issue);
		}
		const blocks = this.blocks();
		return {
			draft: blocks.length === 0 ? null : { blocks, images: this.images },
			errors,
			warnings,
		};
	}

	/** The blocks as JSON, with deterministic keys: `b<n>`, `b<n>s<m>`, `b<n>l<m>`. */
	private blocks(): DraftBlock[] {
		return this.out.map((out, i): DraftBlock => {
			const key = `b${i}`;
			if (out.kind === "text") return textBlock(out.block, key);
			if (out.kind === "break") return { _type: "break", _key: key, style: "lineBreak" };
			if (out.kind === "code") {
				return {
					_type: "code",
					_key: key,
					code: out.code,
					...(out.language === null ? {} : { language: out.language }),
				};
			}
			return {
				_type: "image",
				_key: key,
				slot: out.slot,
				...(out.alt === null ? {} : { alt: out.alt }),
				...(out.caption === null ? {} : { caption: out.caption }),
				...(out.link === null ? {} : { link: linkValue(out.link) }),
			};
		});
	}
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Drops leading and trailing whitespace of the block, then empty spans. */
function trimSpans(spans: readonly SpanDraft[]): SpanDraft[] {
	const out = spans.map((s) => ({ ...s }));
	while (out.length > 0) {
		const first = out[0] as SpanDraft;
		first.text = first.text.replace(/^[ \n]+/, "");
		if (first.text !== "") break;
		out.shift();
	}
	while (out.length > 0) {
		const last = out[out.length - 1] as SpanDraft;
		last.text = last.text.replace(/[ \n]+$/, "");
		if (last.text !== "") break;
		out.pop();
	}
	return out.filter((s) => s.text !== "");
}

function linkValue(link: LinkTarget): { [key: string]: JsonValue } {
	return link.blank ? { href: link.href, blank: true } : { href: link.href };
}

/** A text block in the shape EmDash's editor writes: no empty `markDefs`, spans with `marks`. */
function textBlock(block: TextDraft, key: string): DraftBlock {
	// Only links that a kept span uses get a definition, numbered in order of first use.
	const used = new Map<number, string>();
	const markDefs: { [key: string]: JsonValue }[] = [];
	const children = block.spans.map((span, i): { [key: string]: JsonValue } => {
		const marks: string[] = [...span.decorators];
		if (span.link !== null) {
			let def = used.get(span.link);
			if (def === undefined) {
				def = `${key}l${used.size}`;
				used.set(span.link, def);
				markDefs.push({
					_type: "link",
					_key: def,
					...linkValue(block.links[span.link] as LinkTarget),
				});
			}
			marks.push(def);
		}
		return { _type: "span", _key: `${key}s${i}`, text: span.text, marks };
	});
	const { style, listItem, level } = block.context;
	return {
		_type: "block",
		_key: key,
		style,
		...(listItem === undefined ? {} : { listItem, level: level ?? 1 }),
		children,
		...(markDefs.length > 0 ? { markDefs } : {}),
	};
}

/** The text of an element's subtree: `br` as a line break, removed elements counted and skipped. */
function textOf(element: Element, preserve: boolean, removed: Map<string, number>): string {
	let text = "";
	const stack: ChildNode[] = [...element.childNodes].reverse();
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.nodeName === "#text") text += (node as DefaultTreeAdapterTypes.TextNode).value;
		else if ("tagName" in node) {
			if (REMOVED.has(node.tagName))
				removed.set(node.tagName, (removed.get(node.tagName) ?? 0) + 1);
			else if (node.tagName === "br") text += "\n";
			else
				for (let i = node.childNodes.length - 1; i >= 0; i--)
					stack.push(node.childNodes[i] as ChildNode);
		}
	}
	return preserve ? text : text.replace(WHITESPACE, " ").replace(/^ | $/g, "");
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A link's `href`, kept when it is a bare `#fragment`, an absolute `http:`, `https:`, `mailto:` or
 * `tel:` URL, or a relative URL resolved against `base`. A protocol-relative URL takes `base`'s
 * scheme, or `https:` without one.
 */
export function safeHref(
	raw: string,
	base: URL | null,
): { ok: true; href: string } | { ok: false; reason: string } {
	const text = raw.trim();
	if (CONTROL.test(text)) return { ok: false, reason: "it contains control characters" };
	if (text.length > MAX_HREF_LENGTH) {
		return { ok: false, reason: `it is longer than ${MAX_HREF_LENGTH} characters` };
	}
	if (text.startsWith("#")) return { ok: true, href: text };
	const scheme = SCHEME.exec(text)?.[1];
	let url: URL;
	try {
		if (scheme !== undefined) url = new URL(text);
		else if (text.startsWith("//")) url = new URL(`${base?.protocol ?? "https:"}${text}`);
		else if (base !== null) url = new URL(text, base);
		else return { ok: false, reason: "a relative address needs the mapping's baseUrl" };
	} catch {
		return { ok: false, reason: "it is not a valid URL" };
	}
	if (!LINK_SCHEMES.has(url.protocol)) {
		return { ok: false, reason: `the scheme ${url.protocol} is not allowed` };
	}
	if (url.href.length > MAX_HREF_LENGTH) {
		return { ok: false, reason: `it is longer than ${MAX_HREF_LENGTH} characters` };
	}
	return { ok: true, href: url.href };
}

/**
 * An image's URL, normalized for the media map: a relative URL resolved against `base`, a
 * protocol-relative one with `base`'s scheme or `https:`, then `normalizeMediaUrl`.
 */
export function imageUrl(
	raw: string,
	base: URL | null,
): { ok: true; url: string } | { ok: false; message: string } {
	let absolute = raw;
	if (raw.startsWith("//")) absolute = `${base?.protocol ?? "https:"}${raw}`;
	else if (!SCHEME.test(raw)) {
		if (base === null) return { ok: false, message: "A relative URL needs the mapping's baseUrl" };
		try {
			absolute = new URL(raw, base).href;
		} catch {
			return { ok: false, message: "The URL is not valid" };
		}
	}
	return normalizeMediaUrl(absolute);
}
````

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/portable-text.test.ts`
Expected: PASS (1 file, 27 tests; "stays fast at the limits" takes about 1-2 s). Full suite after this task: 49 files / 1,235 tests

- [ ] **Step 6: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/package.json pnpm-lock.yaml packages/flux-import/src/engine/portable-text.ts packages/flux-import/tests/unit/portable-text.test.ts
git commit -m "Add the Portable Text converter for HTML, Markdown and plain text"
```

### Task 2: Portable Text in the record plan

**Files:**
- Modify: `packages/flux-import/src/engine/diff.ts`
- Test: `packages/flux-import/tests/unit/diff.test.ts`

**Interfaces:**
- Consumes: M4c `planRecord`, `deepEqual`, `Change`; `JsonValue` from `template.ts`.
- Produces: `src/engine/diff.ts`: `type PortableTextPlanItem = { blocks: JsonValue[]; pending: number; text: string }`; `canonicalPortableText(value: unknown): JsonValue[] | undefined` (Ruling 2; `undefined` when the value has no canonical form); `portableTextSummary(blocks: readonly unknown[], pending = 0): string` (Ruling 11); `planRecord(template, mapped, current, links?, media?, portableText?: Readonly<Record<string, PortableTextPlanItem | null>>)` adds Portable Text changes after the media changes and before the links: a field with pending images, or whose canonical form differs from the stored one, is a change `{ field, before: <summary> | null, after: item.text }`; a `null` item clears a stored value.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/diff.test.ts`, replace
````ts
import { describe, expect, it } from "vitest";
import {
	type Comparison,
	type CurrentLinks,
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	type MediaPlanItem,
	planRecord,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
const next = {
	key: "A1",
	slug: "desk",
````
with:
````ts
import { describe, expect, it } from "vitest";
import {
	type Comparison,
	type CurrentLinks,
	canonicalPortableText,
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	type MediaPlanItem,
	type PortableTextPlanItem,
	planRecord,
	portableTextSummary,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
const next = {
	key: "A1",
	slug: "desk",
````

then replace
````ts
				{ field: "title", before: null, after: "Chair" },
				{ field: "photo", before: null, after: "m1" },
				{ field: "icon", before: null, after: "new media from https://cdn.test/a.png" },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});
````
with:
````ts
				{ field: "title", before: null, after: "Chair" },
				{ field: "photo", before: null, after: "m1" },
				{ field: "icon", before: null, after: "new media from https://cdn.test/a.png" },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});

describe("Portable Text in the plan", () => {
	const block = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}s0`, text, marks: [] }],
		...extra,
	});
	const linked = (key: string, def: string, blank?: boolean) => ({
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}s0`, text: "x", marks: ["em", def] }],
		markDefs: [
			{
				_type: "link",
				_key: def,
				href: "https://x.test/",
				...(blank === undefined ? {} : { blank }),
			},
		],
	});
	const image = (key: string, id: string) => ({
		_type: "image",
		_key: key,
		asset: { _ref: id, url: `/_emdash/api/media/file/${id}.png` },
		width: 4,
		height: 3,
	});
	const value = [block("b0", "Hello"), linked("b1", "b1l0"), image("b2", "m1")];
	const item = (blocks: unknown[], pending = 0): PortableTextPlanItem => ({
		blocks: blocks as PortableTextPlanItem["blocks"],
		pending,
		text: portableTextSummary(blocks, pending),
	});
	const record = { key: "P1", data: { title: "Post" } };
	const plan = (stored: unknown, body: PortableTextPlanItem | null) =>
		planRecord(
			{ slug: null, data: { title: "Post", body: stored } },
			record,
			new Map(),
			undefined,
			undefined,
			{
				body,
			},
		);

	it("ignores keys, empty marks and markDefs, a normal style, blank: false and list ids", () => {
		// What EmDash's editor writes back for the same value (Fact V2).
		const edited = [
			{ _type: "block", _key: "k1", children: [{ _type: "span", _key: "k2", text: "Hello" }] },
			{
				_type: "block",
				_key: "k3",
				style: "normal",
				children: [{ _type: "span", _key: "k4", text: "x", marks: ["em", "zz9"] }],
				markDefs: [{ _type: "link", _key: "zz9", href: "https://x.test/", blank: false }],
				listId: "legacy:root:1:k3",
			},
			{ ...image("k5", "m1"), _key: "k5" },
		];
		expect(canonicalPortableText(edited)).toEqual(canonicalPortableText(value));
		expect(plan(edited, item(value))).toEqual({ action: "unchanged", changes: [] });
		expect(
			canonicalPortableText([block("b0", "a", { listItem: "number", level: 1, listStart: 1 })]),
		).toEqual(canonicalPortableText([block("x", "a", { listItem: "number", level: 1 })]));
	});

	it("compares text, marks, link targets, images and block order", () => {
		const changed = (blocks: unknown[]) => plan(blocks, item(value)).action;
		expect(changed([block("b0", "Hello!"), linked("b1", "b1l0"), image("b2", "m1")])).toBe(
			"update",
		);
		expect(changed([block("b0", "Hello"), linked("b1", "b1l0", true), image("b2", "m1")])).toBe(
			"update",
		);
		expect(changed([block("b0", "Hello"), linked("b1", "b1l0"), image("b2", "m2")])).toBe("update");
		expect(changed([linked("b1", "b1l0"), block("b0", "Hello"), image("b2", "m1")])).toBe("update");
		expect(
			changed([block("b0", "Hello", { style: "h2" }), linked("b1", "b1l0"), image("b2", "m1")]),
		).toBe("update");
	});

	it("treats a stored value that is not an array, or nests too deep, as a change", () => {
		let deep: unknown = "x";
		for (let i = 0; i < 40; i++) deep = { a: deep };
		expect(canonicalPortableText("text")).toBeUndefined();
		expect(canonicalPortableText([{ _type: "block", children: [deep] }])).toBeUndefined();
		expect(plan("<p>Hello</p>", item(value)).changes).toEqual([
			{ field: "body", before: "a value that is not Portable Text", after: "3 blocks, 1 image" },
		]);
	});

	it("shows counts instead of Portable Text, and pending images as new", () => {
		expect(portableTextSummary([block("b0", "a")])).toBe("1 block");
		expect(portableTextSummary(value, 2)).toBe("5 blocks, 3 images (2 new)");
		expect(plan(value, item(value, 1))).toEqual({
			action: "update",
			changes: [
				{ field: "body", before: "3 blocks, 1 image", after: "4 blocks, 2 images (1 new)" },
			],
		});
		expect(
			planRecord(null, record, new Map(), undefined, undefined, { body: item(value) }),
		).toEqual({
			action: "create",
			changes: [
				{ field: "title", before: null, after: "Post" },
				{ field: "body", before: null, after: "3 blocks, 1 image" },
			],
		});
	});

	it("treats an empty value as nothing stored, an empty array included", () => {
		expect(plan(null, null)).toEqual({ action: "unchanged", changes: [] });
		expect(plan([], null)).toEqual({ action: "unchanged", changes: [] });
		expect(plan(undefined, null)).toEqual({ action: "unchanged", changes: [] });
		expect(plan(value, null).changes).toEqual([
			{ field: "body", before: "3 blocks, 1 image", after: null },
		]);
		expect(plan([], item(value)).changes).toEqual([
			{ field: "body", before: null, after: "3 blocks, 1 image" },
		]);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/diff.test.ts`
Expected: FAIL (5 failed, 20 passed): `canonicalPortableText is not a function`, `portableTextSummary is not a function`, and `planRecord` ignores its sixth argument (`expected [] to deeply equal [ { field: 'body', … } ]`).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/diff.ts`, replace
````ts
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field, a media field or a link differs, else `unchanged`. `links` is given when the template
 * maps links, `media` when it maps image or file fields.
 */
export function planRecord(
	current: CurrentEntry | null,
````
with:
````ts
	return changes;
}

/** A Portable Text field's assembled value, for `planRecord`; null for an empty value. */
export type PortableTextPlanItem = {
	/** The assembled blocks. */
	blocks: JsonValue[];
	/** Images not stored yet: the field is a change while this is above 0. */
	pending: number;
	/** How the record shows it: `14 blocks, 3 images (1 new)`. */
	text: string;
};

/** Canonical forms nest at most this deep; a deeper stored value always compares as changed. */
const MAX_CANONICAL_DEPTH = 16;

/**
 * The comparable form of one Portable Text value, or undefined when it is not an array (or nests
 * too deep), which always compares as changed. Every `_key` is dropped, and marks that name a
 * block's link definitions name its position instead (`@0`). An empty `marks` or `markDefs`, a
 * text block's `style: "normal"`, a link's `blank: false` and a list's `listStart: 1` equal a
 * missing one, and `listId` is dropped: EmDash's editor writes and drops these on save (Fact V2).
 */
export function canonicalPortableText(value: unknown): JsonValue[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: JsonValue[] = [];
	for (const block of value) {
		const canonical = canonicalBlock(block);
		if (canonical === undefined) return undefined;
		blocks.push(canonical);
	}
	return blocks;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalBlock(block: unknown): JsonValue | undefined {
	if (!isObject(block) || block._type !== "block") return canonicalJson(block, 0);
	const ids = new Map<unknown, string>();
	if (Array.isArray(block.markDefs)) {
		block.markDefs.forEach((def, i) => {
			if (isObject(def) && def._key !== undefined) ids.set(def._key, `@${i}`);
		});
	}
	const out: { [key: string]: JsonValue } = {};
	for (const [key, raw] of Object.entries(block)) {
		if (key === "_key" || key === "listId" || raw === undefined) continue;
		if (key === "style" && raw === "normal") continue;
		if (key === "listStart" && raw === 1) continue;
		let value: unknown = raw;
		if (key === "children" && Array.isArray(raw)) {
			value = raw.map((span) =>
				isObject(span) && Array.isArray(span.marks)
					? { ...span, marks: span.marks.map((m) => ids.get(m) ?? m) }
					: span,
			);
		}
		const canonical = canonicalJson(value, 1);
		if (canonical === undefined) return undefined;
		if (Array.isArray(canonical) && canonical.length === 0 && key === "markDefs") continue;
		out[key] = canonical;
	}
	return out;
}

/** JSON without `_key`, empty `marks` and a link's `blank: false`, at most `MAX_CANONICAL_DEPTH` deep. */
function canonicalJson(value: unknown, depth: number): JsonValue | undefined {
	if (depth > MAX_CANONICAL_DEPTH) return undefined;
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const canonical = canonicalJson(item, depth + 1);
			if (canonical === undefined) return undefined;
			items.push(canonical);
		}
		return items;
	}
	if (!isObject(value)) {
		return typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
			? value
			: undefined;
	}
	const out: { [key: string]: JsonValue } = {};
	for (const [key, raw] of Object.entries(value)) {
		if (key === "_key" || raw === undefined) continue;
		if (key === "marks" && Array.isArray(raw) && raw.length === 0) continue;
		if (key === "blank" && raw === false && value._type === "link") continue;
		const canonical = canonicalJson(raw, depth + 1);
		if (canonical === undefined) return undefined;
		out[key] = canonical;
	}
	return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a record shows a Portable Text value: `12 blocks, 2 images`, plus `(1 new)` for pending ones. */
export function portableTextSummary(blocks: readonly unknown[], pending = 0): string {
	const images = blocks.filter((b) => isObject(b) && b._type === "image").length + pending;
	const parts = [plural(blocks.length + pending, "block")];
	if (images > 0) parts.push(plural(images, "image") + (pending > 0 ? ` (${pending} new)` : ""));
	return parts.join(", ");
}

/**
 * The Portable Text changes: a field whose canonical stored value differs, or that has images
 * not stored yet. An empty value equals nothing stored and an empty array.
 */
function portableTextChanges(
	items: Readonly<Record<string, PortableTextPlanItem | null>>,
	data: Readonly<Record<string, unknown>> | null,
): Change[] {
	const changes: Change[] = [];
	for (const [field, item] of Object.entries(items)) {
		const stored = data !== null && Object.hasOwn(data, field) ? data[field] : null;
		const empty =
			stored === null || stored === undefined || (Array.isArray(stored) && stored.length === 0);
		const before = empty
			? null
			: Array.isArray(stored)
				? portableTextSummary(stored)
				: "a value that is not Portable Text";
		if (item === null) {
			if (!empty) changes.push({ field, before, after: null });
			continue;
		}
		const same =
			item.pending === 0 &&
			!empty &&
			deepEqual(canonicalPortableText(stored) ?? null, canonicalPortableText(item.blocks));
		if (!same) changes.push({ field, before, after: item.text });
	}
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field, a media field, a Portable Text field or a link differs, else `unchanged`. `links` is
 * given when the template maps links, `media` when it maps image or file fields, `portableText`
 * when it maps `portableText` fields.
 */
export function planRecord(
	current: CurrentEntry | null,
````

then replace
````ts
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
	media?: Readonly<Record<string, MediaPlanItem | null>>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
````
with:
````ts
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
	media?: Readonly<Record<string, MediaPlanItem | null>>,
	portableText?: Readonly<Record<string, PortableTextPlanItem | null>>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
````

then replace
````ts
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (media) changes.push(...mediaChanges(media, null));
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
````
with:
````ts
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (media) changes.push(...mediaChanges(media, null));
		if (portableText) changes.push(...portableTextChanges(portableText, null));
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
````

then replace
````ts
			changes.push({ field, before: before ?? null, after });
	}
	if (media) changes.push(...mediaChanges(media, current.data));
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}
````
with:
````ts
			changes.push({ field, before: before ?? null, after });
	}
	if (media) changes.push(...mediaChanges(media, current.data));
	if (portableText) changes.push(...portableTextChanges(portableText, current.data));
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/diff.test.ts`
Expected: PASS (1 file, 25 tests). Full suite after this task: 49 files / 1,240 tests

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/diff.ts packages/flux-import/tests/unit/diff.test.ts
git commit -m "Compare Portable Text by its canonical form in the record plan"
```

### Task 3: Record warnings and the log column

**Files:**
- Modify: `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/log.ts`
- Test: `packages/flux-import/tests/unit/log.test.ts`, `packages/flux-import/tests/unit/selection.test.ts`, `packages/flux-import/tests/integration/behaviours.test.ts`, `packages/flux-import/tests/integration/selection.test.ts`

**Interfaces:**
- Consumes: `RecordError`, `RecordRow`, `recordsToCsvLines`, `buildLogCsv`.
- Produces: `src/engine/types.ts`: `RecordRow.warnings?: RecordError[]`; `MAX_RECORD_WARNINGS = 20`; `capWarnings(warnings: readonly RecordError[]): RecordError[]` (Ruling 13). `src/engine/log.ts`: a last CSV column `warnings`, `field: code: message` (a part left out when missing) joined with `; `.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/log.test.ts`, replace
````ts
	LogTooLargeError,
	recordsToCsvLines,
} from "../../src/engine/log.js";
import { type RecordRow, recordKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

const row = (seq: number, patch: Partial<RecordRow> = {}): RecordRow => ({
````
with:
````ts
	LogTooLargeError,
	recordsToCsvLines,
} from "../../src/engine/log.js";
import { capWarnings, type RecordRow, recordKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

const row = (seq: number, patch: Partial<RecordRow> = {}): RecordRow => ({
````

then replace
````ts
			row(2, { status: "planned", action: "update" }),
		]);
		expect(lines).toBe(
			"1,created,S0,e0,,,,\r\n" +
				'2,failed,S1,,,invalid_number,price,"""x"" is not a number; The slug would be empty"\r\n' +
				"3,planned,S2,e2,update,,,\r\n",
		);
	});
});
````
with:
````ts
			row(2, { status: "planned", action: "update" }),
		]);
		expect(lines).toBe(
			"1,created,S0,e0,,,,,\r\n" +
				'2,failed,S1,,,invalid_number,price,"""x"" is not a number; The slug would be empty",\r\n' +
				"3,planned,S2,e2,update,,,,\r\n",
		);
	});

	it("ends each line with the record's warnings", () => {
		const lines = recordsToCsvLines([
			row(0, {
				warnings: [
					{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
					{ code: "warnings_truncated", message: "3 more warnings" },
				],
			}),
		]);
		expect(lines).toBe(
			"1,created,S0,e0,,,,,body: unknown_markup: Kept the text of 1 <table> element; warnings_truncated: 3 more warnings\r\n",
		);
	});
});

describe("capWarnings", () => {
	it("keeps at most 20 warnings, the last saying how many more there were", () => {
		const warnings = Array.from({ length: 25 }, (_, i) => ({
			field: "body",
			code: "image_dropped",
			message: `w${i}`,
		}));
		expect(capWarnings(warnings.slice(0, 20))).toEqual(warnings.slice(0, 20));
		expect(capWarnings(warnings)).toEqual([
			...warnings.slice(0, 19),
			{ code: "warnings_truncated", message: "6 more warnings" },
		]);
	});
});
````

then replace
````ts
		await deps.records.put(recordKey("j1", 0), row(0));
		await deps.records.put(recordKey("j1", 1), row(1, { status: "failed" }));
		const csv = await buildLogCsv(deps, "j1", { status: "failed" });
		expect(csv.trimEnd().split("\r\n").slice(1)).toEqual(["2,failed,S1,e1,,,,"]);
	});
});
````
with:
````ts
		await deps.records.put(recordKey("j1", 0), row(0));
		await deps.records.put(recordKey("j1", 1), row(1, { status: "failed" }));
		const csv = await buildLogCsv(deps, "j1", { status: "failed" });
		expect(csv.trimEnd().split("\r\n").slice(1)).toEqual(["2,failed,S1,e1,,,,,"]);
	});
});
````

In `packages/flux-import/tests/unit/selection.test.ts`, replace
````ts
		await runToEnd(deps, job.id);
		const lines = (await buildLogCsv(deps, job.id)).trimEnd().split("\r\n");
		expect(lines.slice(1, 6)).toEqual([
			"1,filtered,,,,,,",
			"2,filtered,,,,,,",
			"3,filtered,,,,,,",
			"4,filtered,,,,,,",
			"5,created,SKU-4,e1,create,,,",
		]);
		const only = (await buildLogCsv(deps, job.id, { status: "filtered" })).trimEnd().split("\r\n");
		expect(only).toHaveLength(5);
````
with:
````ts
		await runToEnd(deps, job.id);
		const lines = (await buildLogCsv(deps, job.id)).trimEnd().split("\r\n");
		expect(lines.slice(1, 6)).toEqual([
			"1,filtered,,,,,,,",
			"2,filtered,,,,,,,",
			"3,filtered,,,,,,,",
			"4,filtered,,,,,,,",
			"5,created,SKU-4,e1,create,,,,",
		]);
		const only = (await buildLogCsv(deps, job.id, { status: "filtered" })).trimEnd().split("\r\n");
		expect(only).toHaveLength(5);
````

In `packages/flux-import/tests/integration/behaviours.test.ts`, replace
````ts
		expect(res.headers.get("content-disposition")).toContain(`flux-import-${job!.id}.csv`);
		const lines = (await res.text()).trimEnd().split("\r\n");
		expect(lines[0]).toBe(
			"record,status,source_key,entry_id,action,error_code,error_field,message",
		);
		const cells = lines.slice(1).map((l) => l.split(","));
		expect(cells.map((c) => c[1])).toEqual(["failed", "failed"]);
````
with:
````ts
		expect(res.headers.get("content-disposition")).toContain(`flux-import-${job!.id}.csv`);
		const lines = (await res.text()).trimEnd().split("\r\n");
		expect(lines[0]).toBe(
			"record,status,source_key,entry_id,action,error_code,error_field,message,warnings",
		);
		const cells = lines.slice(1).map((l) => l.split(","));
		expect(cells.map((c) => c[1])).toEqual(["failed", "failed"]);
````

In `packages/flux-import/tests/integration/selection.test.ts`, replace
````ts
		);
		expect(res.status).toBe(200);
		expect((await res.text()).trimEnd().split("\r\n").slice(1)).toEqual([
			"1,filtered,,,,,,",
			"2,filtered,,,,,,",
			"3,filtered,,,,,,",
			"4,filtered,,,,,,",
		]);

		// The same file again: expressions are deterministic, so nothing changes.
````
with:
````ts
		);
		expect(res.status).toBe(200);
		expect((await res.text()).trimEnd().split("\r\n").slice(1)).toEqual([
			"1,filtered,,,,,,,",
			"2,filtered,,,,,,,",
			"3,filtered,,,,,,,",
			"4,filtered,,,,,,,",
		]);

		// The same file again: expressions are deterministic, so nothing changes.
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/log.test.ts tests/unit/selection.test.ts`
Expected: FAIL (5 failed, 29 passed): `capWarnings is not a function`, and each CSV line lacks the trailing `warnings` column (`expected [ '2,failed,S1,e1,,,,' ] to deeply equal [ '2,failed,S1,e1,,,,,' ]`).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/types.ts`, replace
````ts
	 * already stored, or that a dry run would download. Absent when there are none.
	 */
	newMedia?: string[];
	updatedAt: string;
}
````
with:
````ts
	 * already stored, or that a dry run would download. Absent when there are none.
	 */
	newMedia?: string[];
	/**
	 * What the record's latest conversion reported without failing it (M4d), at most
	 * `MAX_RECORD_WARNINGS`. Absent when there are none.
	 */
	warnings?: RecordError[];
	updatedAt: string;
}
````

then replace
````ts
	return `${collection}:${locale}:${sourceKey}`;
}

export function emptyCounters(): Counters {
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
}
````
with:
````ts
	return `${collection}:${locale}:${sourceKey}`;
}

/** Warnings kept on one record row. */
export const MAX_RECORD_WARNINGS = 20;

/**
 * At most `MAX_RECORD_WARNINGS` warnings: when there are more, the last one kept says how many
 * were left out (`warnings_truncated`).
 */
export function capWarnings(warnings: readonly RecordError[]): RecordError[] {
	if (warnings.length <= MAX_RECORD_WARNINGS) return [...warnings];
	const kept = warnings.slice(0, MAX_RECORD_WARNINGS - 1);
	const more = warnings.length - kept.length;
	return [...kept, { code: "warnings_truncated", message: `${more} more warnings` }];
}

export function emptyCounters(): Counters {
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
}
````

In `packages/flux-import/src/engine/log.ts`, replace
````ts
	"error_code",
	"error_field",
	"message",
] as const;

const PAGE = 100;
````
with:
````ts
	"error_code",
	"error_field",
	"message",
	"warnings",
] as const;

const PAGE = 100;
````

then replace
````ts
				first?.code,
				first?.field,
				r.errors?.map((e) => e.message).join("; "),
			]
				.map(csvCell)
				.join(",");
````
with:
````ts
				first?.code,
				first?.field,
				r.errors?.map((e) => e.message).join("; "),
				r.warnings
					?.map((w) => [w.field, w.code, w.message].filter((part) => part !== undefined).join(": "))
					.join("; "),
			]
				.map(csvCell)
				.join(",");
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/log.test.ts tests/unit/selection.test.ts`
Expected: PASS (2 files, 34 tests). Full suite after this task: 49 files / 1,242 tests. The two integration files' new CSV lines are checked by `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/behaviours.test.ts tests/integration/selection.test.ts` (2 files, 19 tests, about 10 s with the shared server's start); Task 7 runs the whole integration suite.

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/types.ts packages/flux-import/src/engine/log.ts packages/flux-import/tests/unit/log.test.ts packages/flux-import/tests/unit/selection.test.ts packages/flux-import/tests/integration/behaviours.test.ts packages/flux-import/tests/integration/selection.test.ts
git commit -m "Save record warnings on rows and in the log CSV"
```

### Task 4: Template mappings, limits and checks

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/plugin/schema-apply.ts`
- Test: `packages/flux-import/tests/unit/portable-text-template.test.ts` (new), `packages/flux-import/tests/unit/schema-apply.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 1 (`convertPortableText`, the limits, `PortableTextOptions`, `PortableTextDraft`, `PortableTextCode`, `shownUrl`); M3c `parseSourceUrl`; M4c `usesMedia`, `MappedRecord.media`.
- Produces: `src/engine/template.ts`: the `portableText` field mapping (`from` or `expr`, `required?`, `format` required, `baseUrl?`, `images?`, `imageErrors?`, `unknownMarkup?`; Ruling 10); `COMPATIBLE.portableText = ["portableText"]`; `CompiledTemplate.portableText: ReadonlyMap<string, PortableTextOptions>`; `portableTextOptions(mapping): PortableTextOptions` (defaults filled in); `type ValueWarning = { field: string; code: PortableTextCode; message: string }`; `MappedRecord.portableText?: Record<string, PortableTextDraft | null>`; `applyTemplate`'s result gains `warnings?: ValueWarning[]` (Ruling 5), also on failed records; the per-record limits (Ruling 12); `checkTemplate` refuses more than 3 `portableText` mappings; `usesMedia` is true for a `portableText` mapping with `images: "import"`. `src/plugin/schema-apply.ts`: `portableText` in `APPLY_FIELD_TYPES`, never indexed.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/portable-text-template.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	type CompileContext,
	checkTemplate,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
	usesMedia,
} from "../../src/engine/template.js";

const base = (
	fields: Record<string, unknown>,
	source: Record<string, unknown> = { format: "json" },
) => ({
	version: 1,
	source,
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields,
});

function compiled(fields: Record<string, unknown>, context: CompileContext = {}) {
	const t = templateSchema.parse(base(fields)) as Template;
	const result = compileTemplate(t, context);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

const html = (from = "html", extra: Record<string, unknown> = {}) => ({
	from,
	type: "portableText",
	format: "html",
	...extra,
});

const img = (n: number) => `<img src="https://x.test/${n}.png">`;

describe("portableText mappings", () => {
	it("parses the options and fills in their defaults", () => {
		const c = compiled({
			body: html("html", { baseUrl: "https://old.test/blog/" }),
			summary: {
				expr: "summary",
				type: "portableText",
				format: "markdown",
				images: "skip",
				imageErrors: "fail",
				unknownMarkup: "fail",
			},
		});
		expect(c.portableText).toEqual(
			new Map([
				[
					"body",
					{
						format: "html",
						baseUrl: "https://old.test/blog/",
						images: "import",
						imageErrors: "drop",
						unknownMarkup: "warn",
					},
				],
				[
					"summary",
					{
						format: "markdown",
						baseUrl: null,
						images: "skip",
						imageErrors: "fail",
						unknownMarkup: "fail",
					},
				],
			]),
		);
		expect(templatePaths(c.template)).toEqual(["id", "html"]);
	});

	it("refuses a missing format, unknown options and a baseUrl that is not absolute http(s)", () => {
		const problems = (mapping: Record<string, unknown>) => {
			const parsed = templateSchema.safeParse(base({ body: mapping }));
			return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
		};
		expect(problems({ from: "h", type: "portableText" })).not.toEqual([]);
		expect(problems(html("h", { format: "rtf" }))).not.toEqual([]);
		expect(problems(html("h", { images: "maybe" }))).not.toEqual([]);
		expect(problems(html("h", { extra: true }))).not.toEqual([]);
		for (const baseUrl of ["/blog/", "ftp://old.test/", "https://u:p@old.test/", ""]) {
			expect(problems(html("h", { baseUrl }))).not.toEqual([]);
		}
		expect(problems(html("h", { baseUrl: "/blog/" }))).toContain(
			"baseUrl must be an absolute http or https URL",
		);
		expect(problems(html("h", { baseUrl: "http://old.test" }))).toEqual([]);
	});

	it("converts the text into a draft kept out of data, with the field's warnings", async () => {
		const c = compiled({ title: { from: "title", type: "text" }, body: html() });
		const result = await applyTemplate(c, {
			id: "1",
			title: "T",
			html: '<p>Hi <a href="javascript:x">there</a></p><img src="https://x.test/a.png"><table><tr><td>c</td></tr></table>',
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "1",
				data: { title: "T" },
				portableText: {
					body: {
						blocks: [
							{
								_type: "block",
								_key: "b0",
								style: "normal",
								children: [{ _type: "span", _key: "b0s0", text: "Hi there", marks: [] }],
							},
							{ _type: "image", _key: "b1", slot: 0 },
							{
								_type: "block",
								_key: "b2",
								style: "normal",
								children: [{ _type: "span", _key: "b2s0", text: "c", marks: [] }],
							},
						],
						images: [{ url: "https://x.test/a.png", alt: null }],
					},
				},
			},
			warnings: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
				{
					field: "body",
					code: "link_dropped",
					message:
						"Kept the text of 1 link without the address: the scheme javascript: is not allowed",
				},
			],
		});
	});

	it("gives null for a missing, null or blank value and for markup that leaves nothing", async () => {
		const c = compiled({ body: html() });
		for (const value of [undefined, null, "  "]) {
			expect(await applyTemplate(c, { id: "1", html: value })).toEqual({
				ok: true,
				value: { key: "1", data: {}, portableText: { body: null } },
			});
		}
		expect(await applyTemplate(c, { id: "1", html: "<script>x</script>" })).toEqual({
			ok: true,
			value: { key: "1", data: {}, portableText: { body: null } },
			warnings: [{ field: "body", code: "removed_markup", message: "Removed 1 <script> element" }],
		});
	});

	it("fails non-text values, and an empty value in a required field, keeping the warnings", async () => {
		const c = compiled({ body: html() });
		for (const [value, found] of [
			[42, "a number"],
			[true, "a boolean"],
			[{ p: "x" }, "an object"],
			[["x"], "an array"],
		] as const) {
			expect(await applyTemplate(c, { id: "1", html: value })).toEqual({
				ok: false,
				errors: [
					{
						field: "body",
						code: "not_scalar",
						message: `Expected HTML, Markdown or text, found ${found}`,
					},
				],
			});
		}
		const required = compiled(
			{ body: html() },
			{ targets: { body: { type: "portableText", required: true } } },
		);
		expect(await applyTemplate(required, { id: "1", html: "<iframe></iframe>" })).toEqual({
			ok: false,
			errors: [{ field: "body", code: "required", message: "The field is required" }],
			warnings: [{ field: "body", code: "removed_markup", message: "Removed 1 <iframe> element" }],
		});
		expect(await applyTemplate(required, { id: "1" })).toEqual({
			ok: false,
			errors: [{ field: "body", code: "required", message: "The field is required" }],
		});
	});

	it("fails conversion errors under the field", async () => {
		const c = compiled({ body: html("html", { unknownMarkup: "fail", imageErrors: "fail" }) });
		const result = await applyTemplate(c, {
			id: "1",
			html: '<p>a</p><dl><dt>t</dt></dl><img src="/rel.png">',
		});
		expect(result).toEqual({
			ok: false,
			errors: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
				{
					field: "body",
					code: "invalid_media_url",
					message: "/rel.png: A relative URL needs the mapping's baseUrl",
				},
			],
		});
	});

	it("keeps at most 50 distinct image URLs per record over all fields", async () => {
		const c = compiled({
			body: html(),
			more: html("more"),
			strict: html("strict", { imageErrors: "fail" }),
		});
		const first = Array.from({ length: 30 }, (_, i) => img(i)).join("");
		// 10 repeat the first field's URLs and 25 are new: 20 fit, 5 are dropped.
		const second = Array.from({ length: 35 }, (_, i) => img(i + 20)).join("");
		const result = await applyTemplate(c, { id: "1", html: first, more: `<p>t</p>${second}` });
		if (!result.ok) throw new Error("expected ok");
		const more = result.value.portableText?.more;
		expect(more?.images.map((i) => i.url)).toEqual(
			Array.from({ length: 30 }, (_, i) => `https://x.test/${i + 20}.png`),
		);
		expect(more?.blocks.length).toBe(31);
		expect(more?.blocks.at(-1)).toEqual({ _type: "image", _key: "b30", slot: 29 });
		expect(result.warnings).toEqual([
			{
				field: "more",
				code: "image_dropped",
				message:
					"Left out 5 images (https://x.test/50.png, …): at most 50 distinct image URLs per record",
			},
		]);
		const failed = await applyTemplate(c, {
			id: "1",
			html: Array.from({ length: 50 }, (_, i) => img(i)).join(""),
			strict: img(50),
		});
		expect(failed).toEqual({
			ok: false,
			errors: [
				{
					field: "strict",
					code: "portable_text_limit",
					message: "The record's Portable Text has more than 50 distinct image URLs",
				},
			],
		});
	});

	it("refuses more than 1 MiB of Portable Text JSON in one record", async () => {
		const text = { type: "portableText", format: "text" };
		const c = compiled({
			a: { from: "a", ...text },
			b: { from: "b", ...text },
			c: { from: "c", ...text },
		});
		const big = "x".repeat(400_000);
		expect((await applyTemplate(c, { id: "1", a: big, b: big })).ok).toBe(true);
		expect(await applyTemplate(c, { id: "1", a: big, b: big, c: big })).toEqual({
			ok: false,
			errors: [
				{
					field: "c",
					code: "portable_text_too_large",
					message: "The record's Portable Text is larger than 1 MiB",
				},
			],
		});
	});
});

describe("portableText schema checks", () => {
	it("needs a portableText field and allows at most three mappings", () => {
		const t = (fields: Record<string, unknown>) => templateSchema.parse(base(fields)) as Template;
		expect(
			checkTemplate(t({ body: html() }), [{ slug: "body", type: "portableText" }], null),
		).toEqual([]);
		expect(checkTemplate(t({ body: html() }), [{ slug: "body", type: "text" }], null)).toEqual([
			'Field "body" has type "text"; a portableText mapping needs one of portableText',
		]);
		const four = Object.fromEntries(["a", "b", "c", "d"].map((f) => [f, html(f)]));
		const fields = Object.keys(four).map((slug) => ({ slug, type: "portableText" }));
		expect(checkTemplate(t(four), fields, null)).toEqual([
			"The template maps 4 portableText fields; at most 3 are allowed",
		]);
	});

	it("uses media when a portableText mapping imports its images", () => {
		const t = (fields: Record<string, unknown>) => templateSchema.parse(base(fields)) as Template;
		expect(usesMedia(t({ body: html() }))).toBe(true);
		expect(usesMedia(t({ body: html("html", { images: "import" }) }))).toBe(true);
		expect(usesMedia(t({ body: html("html", { images: "skip" }) }))).toBe(false);
		expect(usesMedia(t({ body: { from: "t", type: "text" } }))).toBe(false);
	});
});
````

In `packages/flux-import/tests/unit/schema-apply.test.ts`, replace
````ts
			'Field "photo": image fields cannot be indexed',
		]);
	});
});

describe("labelOf", () => {
````
with:
````ts
			'Field "photo": image fields cannot be indexed',
		]);
	});

	it("creates portableText fields for portableText mappings, never indexed", async () => {
		const registry = new FakeApplyRegistry([{ slug: "body", type: "portableText" }]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "id" },
			fields: {
				body: { from: "html", type: "portableText", format: "html" },
				summary: { from: "md", type: "portableText", format: "markdown", images: "skip" },
			},
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{ field: "body", action: "unchanged", type: "portableText" },
			{ field: "summary", action: "create", type: "portableText" },
		]);
		expect(registry.calls).toEqual([
			'create:summary:{"slug":"summary","label":"Summary","type":"portableText","indexed":false,"searchable":false,"translatable":true}',
		]);
		expect(requestProblems([{ slug: "body", type: "portableText", indexed: true }])).toEqual([
			'Field "body": portableText fields cannot be indexed',
		]);
	});
});

describe("labelOf", () => {
````

In `packages/flux-import/tests/unit/definition.test.ts`, replace
````ts
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
````
with:
````ts
				apply.safeParse({ collection: "products", fields: [{ ...field, ...extra }] }).success,
			).toBe(false);
		}
		for (const type of ["reference", "repeater", "blocks"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(false);
		}
		for (const type of ["image", "file", "portableText"]) {
			expect(
				apply.safeParse({ collection: "products", fields: [{ slug: "x", type }] }).success,
			).toBe(true);
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/portable-text-template.test.ts tests/unit/schema-apply.test.ts tests/unit/definition.test.ts`
Expected: FAIL (12 failed, 3 files): the template schema refuses `type: "portableText"` (`ZodError`, "Invalid discriminator value"), the definition test's `jobs/create` answers "The template is invalid: fields.body.type: Invalid discriminator value…", and `schema/apply` does not create `portableText` fields.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/template.ts`, replace
````ts
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
````
with:
````ts
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { parseSourceUrl } from "../sources/net.js";
import { pathProblem, resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
````

then replace
````ts
	type MediaRequest,
	mediaUrlConverter,
} from "./media.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
````
with:
````ts
	type MediaRequest,
	mediaUrlConverter,
} from "./media.js";
import {
	convertPortableText,
	MAX_PORTABLE_TEXT_IMAGES,
	MAX_PORTABLE_TEXT_MAPPINGS,
	MAX_PORTABLE_TEXT_RECORD_BYTES,
	type PortableTextCode,
	type PortableTextDraft,
	type PortableTextOptions,
	shownUrl,
} from "./portable-text.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
````

then replace
````ts
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

/** An image mapping's alt text: from a source path or an expression. */
const altMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);
````
with:
````ts
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

/** An absolute http(s) URL without a user name or password, as `parseSourceUrl` accepts. */
const baseUrl = z
	.string()
	.min(1)
	.refine(
		(text) => {
			try {
				parseSourceUrl(text);
				return true;
			} catch {
				return false;
			}
		},
		{ message: "baseUrl must be an absolute http or https URL" },
	);

/** An image mapping's alt text: from a source path or an expression. */
const altMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);
````

then replace
````ts
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("file"), refresh: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
````
with:
````ts
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("file"), refresh: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("portableText"),
			format: z.enum(["html", "markdown", "text"]),
			baseUrl: baseUrl.optional(),
			images: z.enum(["import", "skip"]).optional(),
			imageErrors: z.enum(["drop", "fail"]).optional(),
			unknownMarkup: z.enum(["warn", "fail"]).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
````

then replace
````ts
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
````
with:
````ts
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
export type BylinesMapping = NonNullable<Template["bylines"]>;

export type {
	JsonValue,
	LinkRequests,
	MediaRequest,
	PortableTextDraft,
	TargetField,
	TaxonomySnapshot,
	TermRequest,
};
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
/**
 * One record after the template: the key, the slug, the field values, the link requests
 * (reference fields, taxonomies, bylines) when the template maps any, and the media requests
 * when it maps image or file fields (null for an empty value), and the Portable Text drafts when
 * it maps `portableText` fields (null for an empty value). Reference, media and Portable Text
 * fields are kept out of `data`.
 */
export type MappedRecord = {
	key: string;
````

then replace
````ts
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
};
export type ValueErrorCode =
	| "filter_error"
````
with:
````ts
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
	portableText?: Record<string, PortableTextDraft | null>;
};
export type ValueErrorCode =
	| "filter_error"
````

then replace
````ts
	| ConversionCode
	| RuleCode
	| LinkErrorCode
	| MediaConversionCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
````
with:
````ts
	| ConversionCode
	| RuleCode
	| LinkErrorCode
	| MediaConversionCode
	| PortableTextCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
````

then replace
````ts
		case "image":
		case "file":
			return mediaUrlConverter;
	}
}

/** A link mapping read from `from` or `expr` and converted to lookup requests. */
````
with:
````ts
		case "image":
		case "file":
			return mediaUrlConverter;
		case "portableText":
			return portableTextSource;
	}
}

/**
 * A `portableText` source value: a missing path, `null` or blank text is empty (null), and
 * anything but text fails `not_scalar`, numbers and booleans included. `applyTemplate` converts
 * the text.
 */
function portableTextSource(raw: unknown): Converted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw !== "string") {
		const message = `Expected HTML, Markdown or text, found ${kindOf(raw)}`;
		return { ok: false, code: "not_scalar", message };
	}
	return { ok: true, value: raw.trim() === "" ? null : raw };
}

/** A link mapping read from `from` or `expr` and converted to lookup requests. */
````

then replace
````ts
	readonly bylines: LinkReader<string> | null;
	/** Each image and file field's reader, by field name. */
	readonly media: ReadonlyMap<string, MediaReader>;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
````
with:
````ts
	readonly bylines: LinkReader<string> | null;
	/** Each image and file field's reader, by field name. */
	readonly media: ReadonlyMap<string, MediaReader>;
	/** Each `portableText` field's options, by field name, with their defaults. */
	readonly portableText: ReadonlyMap<string, PortableTextOptions>;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
````

then replace
````ts
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	const media = new Map<string, MediaReader>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
````
with:
````ts
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	const media = new Map<string, MediaReader>();
	const portableText = new Map<string, PortableTextOptions>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
````

then replace
````ts
						: { from: alt.from, expr: compile(`fields.${name}.alt.expr`, alt.expr) },
			});
		}
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
````
with:
````ts
						: { from: alt.from, expr: compile(`fields.${name}.alt.expr`, alt.expr) },
			});
		}
		if (mapping.type === "portableText") portableText.set(name, portableTextOptions(mapping));
	}
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
````

then replace
````ts
			taxonomies,
			bylines,
			media,
		},
	};
}
````
with:
````ts
			taxonomies,
			bylines,
			media,
			portableText,
		},
	};
}

/** A `portableText` mapping's options with their defaults filled in. */
export function portableTextOptions(
	mapping: Extract<FieldMapping, { type: "portableText" }>,
): PortableTextOptions {
	return {
		format: mapping.format,
		baseUrl: mapping.baseUrl ?? null,
		images: mapping.images ?? "import",
		imageErrors: mapping.imageErrors ?? "drop",
		unknownMarkup: mapping.unknownMarkup ?? "warn",
	};
}
````

then replace
````ts
/** Marks a value whose expression failed; the failure is already in the record's errors. */
const FAILED = Symbol("failed");

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug, each field, each taxonomy and the bylines from `from` or `expr` and converts
 * them, collecting every error. An expression result goes through the same conversion as a path
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests. Run `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] }> {
	const t = c.template;
	const errors: ValueError[] = [];
	const read = async (
		field: string,
		from: string | undefined,
````
with:
````ts
/** Marks a value whose expression failed; the failure is already in the record's errors. */
const FAILED = Symbol("failed");

/** What `applyTemplate` reports without failing the record: Portable Text conversion warnings. */
export type ValueWarning = { field: string; code: PortableTextCode; message: string };

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug, each field, each taxonomy and the bylines from `from` or `expr` and converts
 * them, collecting every error. An expression result goes through the same conversion as a path
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests, and Portable Text into `portableText`, as drafts. `warnings` is
 * present when a Portable Text conversion reported something, also for a record that fails. Run
 * `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
	value: unknown,
): Promise<
	| { ok: true; value: MappedRecord; warnings?: ValueWarning[] }
	| { ok: false; errors: ValueError[]; warnings?: ValueWarning[] }
> {
	const t = c.template;
	const errors: ValueError[] = [];
	const warnings: ValueWarning[] = [];
	const read = async (
		field: string,
		from: string | undefined,
````

then replace
````ts
	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
````
with:
````ts
	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
	const portableText: Record<string, PortableTextDraft | null> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
````

then replace
````ts
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		const reader = c.media.get(field);
		if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else if (reader !== undefined) {
````
with:
````ts
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		const reader = c.media.get(field);
		const options = c.portableText.get(field);
		if (options !== undefined) {
			const text = result.value as string | null;
			const converted = text === null ? null : convertPortableText(text, options);
			for (const e of converted?.errors ?? []) errors.push({ field, ...e });
			for (const w of converted?.warnings ?? []) warnings.push({ field, ...w });
			const draft = converted?.draft ?? null;
			// Markup that leaves no block is empty, as a missing value is.
			if (draft === null && text !== null && target !== undefined) {
				for (const e of checkRules(null, target)) errors.push({ field, ...e });
			}
			portableText[field] = draft;
		} else if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else if (reader !== undefined) {
````

then replace
````ts
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	return { ok: true, value: mapped };
}

/**
````
with:
````ts
		}
	}

	if (c.portableText.size > 0) limitPortableText(c, portableText, errors, warnings);

	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	if (c.portableText.size > 0) mapped.portableText = portableText;
	return { ok: true, value: mapped, ...reported };
}

/**
 * The per-record limits over every Portable Text field, in template order: at most
 * `MAX_PORTABLE_TEXT_IMAGES` distinct image URLs (the rest are dropped with one `image_dropped`
 * warning per field, or fail `portable_text_limit` with `imageErrors: "fail"`), then at most
 * `MAX_PORTABLE_TEXT_RECORD_BYTES` of JSON (`portable_text_too_large`).
 */
function limitPortableText(
	c: CompiledTemplate,
	drafts: Record<string, PortableTextDraft | null>,
	errors: ValueError[],
	warnings: ValueWarning[],
): void {
	const seen = new Set<string>();
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null || draft.images.length === 0) continue;
		const over = draft.images.filter((image) => {
			if (seen.has(image.url)) return false;
			if (seen.size < MAX_PORTABLE_TEXT_IMAGES) {
				seen.add(image.url);
				return false;
			}
			return true;
		});
		if (over.length === 0) continue;
		if (c.portableText.get(field)?.imageErrors === "fail") {
			errors.push({
				field,
				code: "portable_text_limit",
				message: `The record's Portable Text has more than ${MAX_PORTABLE_TEXT_IMAGES} distinct image URLs`,
			});
			continue;
		}
		const first = over[0] as { url: string };
		const which =
			over.length === 1
				? `1 image (${shownUrl(first.url)})`
				: `${over.length} images (${shownUrl(first.url)}, …)`;
		warnings.push({
			field,
			code: "image_dropped",
			message: `Left out ${which}: at most ${MAX_PORTABLE_TEXT_IMAGES} distinct image URLs per record`,
		});
		drafts[field] = withoutImages(draft, new Set(over.map((image) => image.url)));
	}
	let bytes = 0;
	const encoder = new TextEncoder();
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null) continue;
		bytes += encoder.encode(JSON.stringify(draft.blocks)).byteLength;
		if (bytes > MAX_PORTABLE_TEXT_RECORD_BYTES) {
			errors.push({
				field,
				code: "portable_text_too_large",
				message: `The record's Portable Text is larger than ${MAX_PORTABLE_TEXT_RECORD_BYTES / 1024 / 1024} MiB`,
			});
			return;
		}
	}
}

/** A draft without the images whose URL is in `urls`; slots are renumbered, keys kept. */
function withoutImages(
	draft: PortableTextDraft,
	urls: ReadonlySet<string>,
): PortableTextDraft | null {
	const slots = new Map<number, number>();
	const images = draft.images.filter((image, i) => {
		if (urls.has(image.url)) return false;
		slots.set(i, slots.size);
		return true;
	});
	const blocks = draft.blocks.flatMap((block) => {
		if (block._type !== "image") return [block];
		const slot = slots.get(block.slot as number);
		return slot === undefined ? [] : [{ ...block, slot }];
	});
	return blocks.length === 0 ? null : { blocks, images };
}

/**
````

then replace
````ts
	reference: ["reference"],
	image: ["image"],
	file: ["file"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
````
with:
````ts
	reference: ["reference"],
	image: ["image"],
	file: ["file"],
	portableText: ["portableText"],
};

/** Whether `value` names one of `options`, as the select matching would find it. */
````

then replace
````ts
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, and taxonomies that do not exist or are not attached
 * to the collection, more than five image and file mappings, and image or file fields whose
 * `allowedMimeTypes` EmDash's upload can never satisfy. The link checks run only on what `links`
 * carries.
 */
export function checkTemplate(
````
with:
````ts
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, and taxonomies that do not exist or are not attached
 * to the collection, more than five image and file mappings, more than three `portableText`
 * mappings, and image or file fields whose `allowedMimeTypes` EmDash's upload can never satisfy. The link checks run only on what `links`
 * carries.
 */
export function checkTemplate(
````

then replace
````ts
	if (media.length > MAX_MEDIA_MAPPINGS) {
		errors.push(
			`The template maps ${media.length} image and file fields; at most ${MAX_MEDIA_MAPPINGS} are allowed`,
		);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
````
with:
````ts
	if (media.length > MAX_MEDIA_MAPPINGS) {
		errors.push(
			`The template maps ${media.length} image and file fields; at most ${MAX_MEDIA_MAPPINGS} are allowed`,
		);
	}
	const rich = Object.values(t.fields).filter((m) => m.type === "portableText");
	if (rich.length > MAX_PORTABLE_TEXT_MAPPINGS) {
		errors.push(
			`The template maps ${rich.length} portableText fields; at most ${MAX_PORTABLE_TEXT_MAPPINGS} are allowed`,
		);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
````

then replace
````ts
	);
}

/** Whether the template maps image or file fields. */
export function usesMedia(t: Template): boolean {
	return Object.values(t.fields).some((m) => m.type === "image" || m.type === "file");
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
````
with:
````ts
	);
}

/**
 * Whether the template downloads media: it maps image or file fields, or `portableText` fields
 * that import their images.
 */
export function usesMedia(t: Template): boolean {
	return Object.values(t.fields).some(
		(m) =>
			m.type === "image" ||
			m.type === "file" ||
			(m.type === "portableText" && (m.images ?? "import") === "import"),
	);
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
````

In `packages/flux-import/src/plugin/schema-apply.ts`, replace
````ts
import { ServiceError } from "./service.js";

/**
 * The field types `schema/apply` creates: every type that holds a plain value, and `image` and
 * `file` (a TEXT column holding one media value), created without `allowedMimeTypes`.
 */
export const APPLY_FIELD_TYPES = [
	"string",
````
with:
````ts
import { ServiceError } from "./service.js";

/**
 * The field types `schema/apply` creates: every type that holds a plain value, `image` and `file`
 * (a TEXT column holding one media value), created without `allowedMimeTypes`, and
 * `portableText` (a JSON column).
 */
export const APPLY_FIELD_TYPES = [
	"string",
````

then replace
````ts
	"slug",
	"image",
	"file",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
````
with:
````ts
	"slug",
	"image",
	"file",
	"portableText",
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/portable-text-template.test.ts tests/unit/schema-apply.test.ts tests/unit/definition.test.ts`
Expected: PASS (3 files, 48 tests). Full suite after this task: 50 files / 1,253 tests

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/plugin/schema-apply.ts packages/flux-import/tests/unit/portable-text-template.test.ts packages/flux-import/tests/unit/schema-apply.test.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Map portableText fields from HTML, Markdown and text in templates"
```

### Task 5: Image resolution and budget deferral

**Files:**
- Create: `packages/flux-import/src/engine/portable-text-images.ts`
- Modify: `packages/flux-import/src/engine/media.ts`
- Test: `packages/flux-import/tests/unit/portable-text-images.test.ts` (new), `packages/flux-import/tests/unit/media-resolve.test.ts`, `packages/flux-import/tests/unit/media-import.test.ts`

**Interfaces:**
- Consumes: Task 1 (`PortableTextDraft`, `PortableTextOptions`, `shownUrl`; `convertPortableText` in the tests), Task 2 (`PortableTextPlanItem`, `portableTextSummary`; `canonicalPortableText` in the tests); M4c `findMedia`, `obtainMedia`, `MediaContext`, `MediaDeps`, `MediaDeferred`, `MediaLookup`, `LookupCache` (with `mediaObtained`), `COST_MEDIA`; `portableTextToProsemirror` and `prosemirrorToPortableText` from `emdash` in the tests (spec F12).
- Produces: `src/engine/portable-text-images.ts`: `MEDIA_FILE_PATH = "/_emdash/api/media/file/"`; `type RecordImages = { lookups: Map<url, { field; lookup }>; items: Map<url, MediaInfo>; dropped: Set<url> }`; `lookupPortableTextImages(deps, cache, ctx, drafts, options): Promise<{ images; errors; warnings }>` (Ruling 15); `obtainPortableTextImages(deps, cache, ctx, images, options, newMedia: string[])`: `{ ok: true; warnings } | { ok: false; errors; warnings }`, pushing each download onto `newMedia` and attaching `newMedia` to a `MediaDeferred`; `portableTextPlan(drafts, images): Record<string, PortableTextPlanItem | null>` (image slots become EmDash's image block, dropped ones are left out, missing items count as pending, a field left with no block is `null`). `src/engine/media.ts`: `obtainMedia` defers by budget (Ruling 14).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/portable-text-images.test.ts`:
````ts
import { portableTextToProsemirror, prosemirrorToPortableText } from "emdash";
import { describe, expect, it } from "vitest";
import { canonicalPortableText } from "../../src/engine/diff.js";
import { type MediaContext, MediaDeferred, resolveMedia } from "../../src/engine/media.js";
import {
	convertPortableText,
	type PortableTextDraft,
	type PortableTextOptions,
} from "../../src/engine/portable-text.js";
import {
	lookupPortableTextImages,
	obtainPortableTextImages,
	portableTextPlan,
} from "../../src/engine/portable-text-images.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import { COST_CALL, COST_MEDIA, LookupCache } from "../../src/engine/resolve.js";
import { makeDeps } from "./fakes.js";

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const url = (name: string) => `https://cdn.test/${name}`;
const HTML: PortableTextOptions = {
	format: "html",
	baseUrl: null,
	images: "import",
	imageErrors: "drop",
	unknownMarkup: "warn",
};

function draft(html: string): PortableTextDraft {
	const converted = convertPortableText(html, HTML);
	if (converted.draft === null) throw new Error("empty");
	return converted.draft;
}

function setup(ctx: Partial<MediaContext> = {}) {
	const { deps, clock } = makeDeps();
	for (const [i, name] of ["a.png", "b.png", "c.png"].entries()) {
		deps.mediaFetcher.files.set(url(name), { body: png(i), contentType: "image/png" });
	}
	const context: MediaContext = { jobId: "j1", dryRun: false, maxBytes: 1000, targets: {}, ...ctx };
	return { deps, clock, ctx: context };
}

const options = (fail: string[] = []) =>
	new Map(
		["body", "summary"].map((f) => [
			f,
			{ ...HTML, imageErrors: fail.includes(f) ? ("fail" as const) : ("drop" as const) },
		]),
	);

describe("Portable Text images", () => {
	it("uses map hits without downloading and assembles EmDash's image block", async () => {
		const { deps, ctx } = setup();
		await resolveMedia(deps, new LookupCache(), ctx, "photo", {
			kind: "image",
			url: url("a.png"),
			alt: null,
			refresh: false,
		});
		const drafts = {
			body: draft(
				`<p>Hi</p><figure><a href="https://x.test/" target="_blank"><img src="${url("a.png")}" alt="A"></a><figcaption>Cap</figcaption></figure>`,
			),
		};
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		expect(looked.errors).toEqual([]);
		expect(cache.spent).toBe(2 * COST_CALL);
		expect(portableTextPlan(drafts, looked.images)).toEqual({
			body: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "normal",
						children: [{ _type: "span", _key: "b0s0", text: "Hi", marks: [] }],
					},
					{
						_type: "image",
						_key: "b1",
						asset: { _ref: "m1", url: "/_emdash/api/media/file/K1.png" },
						alt: "A",
						caption: "Cap",
						width: 4,
						height: 3,
						link: { href: "https://x.test/", blank: true },
					},
				],
				pending: 0,
				text: "2 blocks, 1 image",
			},
		});
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("plans a miss as pending without downloading in a dry run", async () => {
		const { deps, ctx } = setup({ dryRun: true });
		const drafts = { body: draft(`<p>t</p><img src="${url("a.png")}">`), summary: null };
		const looked = await lookupPortableTextImages(deps, new LookupCache(), ctx, drafts, options());
		expect([...looked.images.lookups.keys()]).toEqual([url("a.png")]);
		expect(portableTextPlan(drafts, looked.images)).toEqual({
			body: {
				blocks: [drafts.body.blocks[0]],
				pending: 1,
				text: "2 blocks, 1 image (1 new)",
			},
			summary: null,
		});
		expect(deps.mediaFetcher.urls()).toEqual([]);
	});

	it("downloads each URL once in document order, across fields, and lists it under its first field", async () => {
		const { deps, ctx } = setup();
		const drafts = {
			body: draft(
				`<img src="${url("b.png")}"><img src="${url("a.png")}" alt="first"><img src="${url("b.png")}">`,
			),
			summary: draft(`<img src="${url("a.png")}" alt="second"><img src="${url("c.png")}">`),
		};
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		const newMedia = ["photo: https://cdn.test/photo.png"];
		const obtained = await obtainPortableTextImages(
			deps,
			cache,
			ctx,
			looked.images,
			options(),
			newMedia,
		);
		expect(obtained).toEqual({ ok: true, warnings: [] });
		expect(deps.mediaFetcher.urls()).toEqual([url("b.png"), url("a.png"), url("c.png")]);
		expect(newMedia).toEqual([
			"photo: https://cdn.test/photo.png",
			`body: ${url("b.png")}`,
			`body: ${url("a.png")}`,
			`summary: ${url("c.png")}`,
		]);
		// A new item takes the alt of the URL's first image as its library alt.
		expect(deps.media.items.get("m2")?.alt).toBe("first");
		const plan = portableTextPlan(drafts, looked.images);
		expect(plan.summary?.blocks).toEqual([
			{
				_type: "image",
				_key: "b0",
				asset: { _ref: "m2", url: "/_emdash/api/media/file/K2.png" },
				alt: "second",
				width: 4,
				height: 3,
			},
			{
				_type: "image",
				_key: "b1",
				asset: { _ref: "m3", url: "/_emdash/api/media/file/K3.png" },
				width: 4,
				height: 3,
			},
		]);
		expect(cache.spent).toBe(3 * COST_CALL + 3 * COST_MEDIA);
	});

	it("drops an image that cannot be imported with a warning, or fails the record", async () => {
		const { deps, ctx } = setup();
		deps.mediaFetcher.blocked.add("blocked.test");
		const html = `<p>t</p><img src="https://blocked.test/x.png"><img src="${url("missing.png")}"><img src="${url("a.png")}">`;
		const drafts = { body: draft(html) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		expect(looked.errors).toEqual([]);
		expect(looked.warnings).toEqual([
			{
				field: "body",
				code: "image_dropped",
				message: "media_blocked: https://blocked.test/x.png: The host blocked.test is not allowed",
			},
		]);
		const obtained = await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		expect(obtained).toEqual({
			ok: true,
			warnings: [
				{
					field: "body",
					code: "image_dropped",
					message: `media_http_error: ${url("missing.png")}: The server answered HTTP 404`,
				},
			],
		});
		expect(portableTextPlan(drafts, looked.images).body?.text).toBe("2 blocks, 1 image");

		const strict = await lookupPortableTextImages(
			deps,
			new LookupCache(),
			ctx,
			drafts,
			options(["body"]),
		);
		expect(strict.errors).toEqual([
			{ field: "body", code: "media_blocked", message: "The host blocked.test is not allowed" },
		]);
		const failing = { body: draft(`<img src="${url("missing.png")}"><img src="${url("c.png")}">`) };
		const next = new LookupCache();
		const found = await lookupPortableTextImages(deps, next, ctx, failing, options(["body"]));
		expect(
			await obtainPortableTextImages(deps, next, ctx, found.images, options(["body"]), []),
		).toEqual({
			ok: false,
			errors: [
				{ field: "body", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			warnings: [],
		});
		// It stopped at the first failure.
		expect(deps.mediaFetcher.urls().filter((u) => u === url("c.png"))).toEqual([]);
	});

	it("leaves a field with only dropped images empty", async () => {
		const { deps, ctx } = setup();
		const drafts = { body: draft(`<img src="${url("missing.png")}">`) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		expect(portableTextPlan(drafts, looked.images)).toEqual({ body: null });
	});

	it("defers by deadline and by budget, never the batch's first download, carrying newMedia", async () => {
		const { deps, ctx, clock } = setup();
		const drafts = { body: draft(`<img src="${url("a.png")}"><img src="${url("b.png")}">`) };
		const byBudget = new LookupCache([], 100);
		const looked = await lookupPortableTextImages(deps, byBudget, ctx, drafts, options());
		const newMedia = ["photo: x"];
		const deferred = await obtainPortableTextImages(
			deps,
			byBudget,
			ctx,
			looked.images,
			options(),
			newMedia,
		).catch((e: unknown) => e);
		expect(deferred).toBeInstanceOf(MediaDeferred);
		expect((deferred as MediaDeferred).newMedia).toEqual(["photo: x", `body: ${url("a.png")}`]);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);

		const byDeadline = new LookupCache();
		byDeadline.mediaDeadline = clock.t + 1000;
		byDeadline.mediaDownloads = 1;
		const again = await lookupPortableTextImages(deps, byDeadline, ctx, drafts, options());
		await expect(
			obtainPortableTextImages(deps, byDeadline, ctx, again.images, options(), []),
		).rejects.toBeInstanceOf(MediaDeferred);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("fails the job when EmDash cannot store media, whatever imageErrors says", async () => {
		const { deps, ctx } = setup();
		deps.media.failUpload = () => new MediaUploadError("NO_STORAGE", "Storage not configured");
		const drafts = { body: draft(`<img src="${url("a.png")}">`) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await expect(
			obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []),
		).rejects.toMatchObject({ name: "ContentWriteError", code: "media_config" });
	});

	it("survives an editor round trip unchanged (Fact V2)", async () => {
		const { deps, ctx } = setup();
		const html = `<h2>T <em>i</em></h2><p>a <strong>b</strong> <a href="https://x.test/" target="_blank">l</a> <a href="https://x.test/2">m</a><br>c</p><ul><li>1<ul><li>2</li></ul></li></ul><ol><li>n</li></ol><blockquote>q</blockquote><pre class="language-js">x\n</pre><hr><figure><a href="https://x.test/big"><img src="${url("a.png")}" alt="A"></a><figcaption>C</figcaption></figure>`;
		const drafts = { body: draft(html) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		const value = portableTextPlan(drafts, looked.images).body?.blocks ?? [];
		const edited = JSON.parse(
			JSON.stringify(prosemirrorToPortableText(portableTextToProsemirror(value as never))),
		);
		expect(edited).not.toEqual(value);
		expect(canonicalPortableText(edited)).toEqual(canonicalPortableText(value));
	});
});
````

In `packages/flux-import/tests/unit/media-resolve.test.ts`, replace
````ts
		await obtainRecordMedia(deps, cache, ctx, lookups);
		expect(cache.spent).toBe(2 * COST_CALL + 2 * COST_MEDIA);
	});
});

describe("one fetch per URL and batch", () => {
````
with:
````ts
		await obtainRecordMedia(deps, cache, ctx, lookups);
		expect(cache.spent).toBe(2 * COST_CALL + 2 * COST_MEDIA);
	});

	it("defers a download that would bring the batch past its budget, never the batch's first", async () => {
		const { deps, ctx } = setup();
		// Two lookups and the first download make 62; a second download would make 122.
		const cache = new LookupCache([], 100);
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			hero: image(B),
		});
		const deferred = await obtainRecordMedia(deps, cache, ctx, lookups).catch((e: unknown) => e);
		expect(deferred).toBeInstanceOf(MediaDeferred);
		expect((deferred as MediaDeferred).newMedia).toEqual([`photo: ${A}`]);
		expect(cache.spent).toBe(2 * COST_CALL + COST_MEDIA);
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		// The next batch finds A in the map and downloads B first, whatever it spent before.
		const next = new LookupCache([], 100);
		next.spend(99);
		const retried = await lookupRecordMedia(deps, next, ctx, { photo: image(A), hero: image(B) });
		expect(await obtainRecordMedia(deps, next, ctx, retried.lookups)).toMatchObject({ ok: true });
		expect(deps.mediaFetcher.urls()).toEqual([A, B]);
	});
});

describe("one fetch per URL and batch", () => {
````

In `packages/flux-import/tests/unit/media-import.test.ts`, replace
````ts
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
	});

	it("ends a batch after the record that spends the lookup budget", async () => {
		const { deps } = makeDeps();
		let csv = HEADER;
		for (let i = 0; i < 12; i++) {
````
with:
````ts
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png"), url("a.pdf"), url("b.png")]);
	});

	it("ends a batch before a record whose download would spend past the lookup budget", async () => {
		const { deps } = makeDeps();
		let csv = HEADER;
		for (let i = 0; i < 12; i++) {
````

then replace
````ts
			csv += `S${i},Item,${url(`${i}.png`)},,\n`;
		}
		const created = await start(deps, csv);
		// Each record: 25, a map lookup 1, a download 60.
		const job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		expect(job.cursor.seq).toBe(7);
	});

	it("leaves templates without media as before", async () => {
````
with:
````ts
			csv += `S${i},Item,${url(`${i}.png`)},,\n`;
		}
		const created = await start(deps, csv);
		// Each record: 25, a map lookup 1, a download 60. The seventh record's download would bring
		// the batch to 602, past the budget, so that record waits for the next batch.
		const job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		expect(job.cursor.seq).toBe(6);
		expect(deps.mediaFetcher.urls()).toHaveLength(6);
		const next = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		expect(next.cursor.seq).toBe(12);
		expect(deps.mediaFetcher.urls()).toHaveLength(12);
	});

	it("leaves templates without media as before", async () => {
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/portable-text-images.test.ts tests/unit/media-resolve.test.ts tests/unit/media-import.test.ts`
Expected: FAIL (3 files; 2 failed, 32 passed): `portable-text-images.test.ts` does not load (`Cannot find module '../../src/engine/portable-text-images.js'`), "defers a download that would bring the batch past its budget…" gets `{ ok: true, … }` instead of a `MediaDeferred`, and "ends a batch before a record whose download would spend past the lookup budget" reads `seq` 7 instead of 6.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/media.ts`, replace
````ts
 * The item for a looked-up request in a real run: a hit as it is, or a download (a conditional
 * one for a hit with `refresh`), whose type comes from its bytes, uploaded through EmDash and
 * written to the media map before anything else. Throws `MediaDeferred` when a download other
 * than the batch's first would start with less than `MEDIA_MIN_LEFT_MS` left.
 */
export async function obtainMedia(
	deps: MediaDeps,
````
with:
````ts
 * The item for a looked-up request in a real run: a hit as it is, or a download (a conditional
 * one for a hit with `refresh`), whose type comes from its bytes, uploaded through EmDash and
 * written to the media map before anything else. Throws `MediaDeferred` when a download other
 * than the batch's first would start with less than `MEDIA_MIN_LEFT_MS` left, or would bring
 * the batch's lookup cost past its budget (M4d).
 */
export async function obtainMedia(
	deps: MediaDeps,
````

then replace
````ts
	}
	const now = deps.now();
	const first = cache.mediaDownloads === 0;
	if (!first && cache.mediaDeadline - now < MEDIA_MIN_LEFT_MS) throw new MediaDeferred();
	cache.mediaDownloads++;
	cache.spend(COST_MEDIA);
	try {
````
with:
````ts
	}
	const now = deps.now();
	const first = cache.mediaDownloads === 0;
	const late = cache.mediaDeadline - now < MEDIA_MIN_LEFT_MS;
	if (!first && (late || cache.spent + COST_MEDIA > cache.budget)) throw new MediaDeferred();
	cache.mediaDownloads++;
	cache.spend(COST_MEDIA);
	try {
````

Create `packages/flux-import/src/engine/portable-text-images.ts`:
````ts
/**
 * Portable Text images (M4d): each distinct image URL of a record is looked up in the media map
 * and, in a real run, obtained through the M4c resolver with the batch's cache, budget and
 * deadline. Then each field's image slots become image blocks that reference the items.
 */
import { type PortableTextPlanItem, portableTextSummary } from "./diff.js";
import {
	findMedia,
	type MediaContext,
	MediaDeferred,
	type MediaDeps,
	type MediaLookup,
	obtainMedia,
} from "./media.js";
import type { PortableTextDraft, PortableTextOptions } from "./portable-text.js";
import { shownUrl } from "./portable-text.js";
import type { MediaInfo } from "./ports.js";
import type { LinkError, LookupCache } from "./resolve.js";
import type { JsonValue } from "./values.js";

/** EmDash's internal path for a local media file (`buildRenderMediaUrl` maps it; spec F7). */
export const MEDIA_FILE_PATH = "/_emdash/api/media/file/";

/** A record's Portable Text images, by normalized URL. */
export type RecordImages = {
	/** Each URL looked up, in document order, with the first field that uses it. */
	readonly lookups: Map<string, { field: string; lookup: MediaLookup }>;
	/** The item each URL resolved to: map hits from the lookup, downloads once obtained. */
	readonly items: Map<string, MediaInfo>;
	/** URLs left out of the blocks (`imageErrors: "drop"`). */
	readonly dropped: Set<string>;
};

/** A dropped image's warning: its M4c code, then the URL and the reason. */
function dropWarning(field: string, url: string, error: LinkError): LinkError {
	const message = error.message.startsWith(url)
		? error.message
		: `${shownUrl(url)}: ${error.message}`;
	return { field, code: "image_dropped", message: `${error.code}: ${message}` };
}

const failsOn = (options: ReadonlyMap<string, PortableTextOptions>, field: string) =>
	options.get(field)?.imageErrors === "fail";

/**
 * Looks every distinct image URL of the record's Portable Text up, without the network, as an
 * image request with the image's alt and no refresh. A lookup error fails the record when the
 * field's `imageErrors` is `"fail"`; otherwise the image is dropped with an `image_dropped`
 * warning.
 */
export async function lookupPortableTextImages(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	drafts: Readonly<Record<string, PortableTextDraft | null>>,
	options: ReadonlyMap<string, PortableTextOptions>,
): Promise<{ images: RecordImages; errors: LinkError[]; warnings: LinkError[] }> {
	const images: RecordImages = { lookups: new Map(), items: new Map(), dropped: new Set() };
	const errors: LinkError[] = [];
	const warnings: LinkError[] = [];
	const seen = new Set<string>();
	for (const [field, draft] of Object.entries(drafts)) {
		for (const image of draft?.images ?? []) {
			if (seen.has(image.url)) continue;
			seen.add(image.url);
			const request = { kind: "image" as const, url: image.url, alt: image.alt, refresh: false };
			const found = await findMedia(deps, cache, ctx, field, request);
			if (found.ok) {
				images.lookups.set(image.url, { field, lookup: found.lookup });
				if (found.lookup.item) images.items.set(image.url, found.lookup.item);
			} else if (failsOn(options, field)) errors.push(found.error);
			else {
				warnings.push(dropWarning(field, image.url, found.error));
				images.dropped.add(image.url);
			}
		}
	}
	return { images, errors, warnings };
}

/**
 * Obtains every image not stored yet, in document order, one download at a time: a failure
 * stops the record when its field's `imageErrors` is `"fail"`, and is dropped with a warning
 * otherwise. Each download is added to `newMedia` (`content: https://…`). A `MediaDeferred`
 * carries `newMedia`, which the caller starts with the record's field media.
 */
export async function obtainPortableTextImages(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	images: RecordImages,
	options: ReadonlyMap<string, PortableTextOptions>,
	newMedia: string[],
): Promise<
	{ ok: true; warnings: LinkError[] } | { ok: false; errors: LinkError[]; warnings: LinkError[] }
> {
	const warnings: LinkError[] = [];
	for (const [url, { field, lookup }] of images.lookups) {
		if (images.items.has(url)) continue;
		let obtained: Awaited<ReturnType<typeof obtainMedia>>;
		try {
			obtained = await obtainMedia(deps, cache, ctx, lookup);
		} catch (e) {
			if (e instanceof MediaDeferred) e.newMedia = newMedia;
			throw e;
		}
		if (obtained.ok) {
			images.items.set(url, obtained.item);
			if (obtained.downloaded) newMedia.push(`${field}: ${url}`);
		} else if (failsOn(options, field)) return { ok: false, errors: [obtained.error], warnings };
		else {
			warnings.push(dropWarning(field, url, obtained.error));
			images.dropped.add(url);
		}
	}
	return { ok: true, warnings };
}

/** The image block EmDash's editor writes for a library image (spec F8), from a draft block. */
function imageBlock(
	draft: { [key: string]: JsonValue },
	item: MediaInfo,
): { [key: string]: JsonValue } {
	const { slot: _slot, alt, caption, link, ...rest } = draft;
	return {
		...rest,
		asset: { _ref: item.id, url: `${MEDIA_FILE_PATH}${item.storageKey}` },
		...(alt === undefined ? {} : { alt }),
		...(caption === undefined ? {} : { caption }),
		...(item.width === null ? {} : { width: item.width }),
		...(item.height === null ? {} : { height: item.height }),
		...(link === undefined ? {} : { link }),
	};
}

/**
 * Each field's assembled value: an image slot becomes its image block, a dropped one is left
 * out, and one whose item is not stored yet counts as pending (the field is then a change). A
 * field left with no block is empty (null).
 */
export function portableTextPlan(
	drafts: Readonly<Record<string, PortableTextDraft | null>>,
	images: RecordImages,
): Record<string, PortableTextPlanItem | null> {
	const plan: Record<string, PortableTextPlanItem | null> = {};
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null) {
			plan[field] = null;
			continue;
		}
		const blocks: JsonValue[] = [];
		let pending = 0;
		for (const block of draft.blocks) {
			if (block._type !== "image") {
				blocks.push(block);
				continue;
			}
			const url = draft.images[block.slot as number]?.url ?? "";
			if (images.dropped.has(url)) continue;
			const item = images.items.get(url);
			if (item === undefined) pending++;
			else blocks.push(imageBlock(block, item));
		}
		plan[field] =
			blocks.length === 0 && pending === 0
				? null
				: { blocks, pending, text: portableTextSummary(blocks, pending) };
	}
	return plan;
}
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/portable-text-images.test.ts tests/unit/media-resolve.test.ts tests/unit/media-import.test.ts`
Expected: PASS (3 files, 42 tests). Full suite after this task: 51 files / 1,262 tests

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/portable-text-images.ts packages/flux-import/src/engine/media.ts packages/flux-import/tests/unit/portable-text-images.test.ts packages/flux-import/tests/unit/media-resolve.test.ts packages/flux-import/tests/unit/media-import.test.ts
git commit -m "Resolve Portable Text images through the media map, and defer downloads by budget"
```

### Task 6: Batch integration

**Files:**
- Modify: `packages/flux-import/src/engine/batch.ts`
- Test: `packages/flux-import/tests/unit/portable-text-import.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 (`PortableTextPlanItem`, `planRecord`'s sixth argument), Task 3 (`capWarnings`, `RecordRow.warnings`), Task 4 (`MappedRecord.portableText`, `CompiledTemplate.portableText`, `applyTemplate`'s `warnings`), Task 5 (`lookupPortableTextImages`, `obtainPortableTextImages`, `portableTextPlan`, `RecordImages`); M4c `processRecord`, `obtainRecordMedia`, `MediaDeferred` handling, `workersBatchCap`.
- Produces: `processRecord` in the order of Ruling 17; rows carry `warnings` (capped) whatever their status; a dry run lists each pending image in `newMedia` as `<field>: <url>`; `writeRecord` writes the assembled blocks into `data`. No exported signature changes.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/portable-text-import.test.ts`:
````ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	WORKERS_BATCH_CAP,
	WORKERS_LINKED_BATCH_CAP,
	workersBatchCap,
} from "../../src/plugin/service.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const url = (name: string) => `https://cdn.test/${name}`;

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "photo", type: "image" },
	{ slug: "body", type: "portableText" },
	{ slug: "flux_source_id", type: "string" },
];
const template = (body: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({
	version: 1,
	source: { format: "json", records: "posts" },
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: {
		title: { from: "title", type: "text" },
		body: { from: "html", type: "portableText", format: "html", ...body },
		...fields,
	},
});
type Post = { id: string; title: string; html?: string; photo?: string };
const json = (posts: Post[]) => JSON.stringify({ posts });

function serve(deps: Deps, ...names: string[]) {
	for (const [i, name] of names.entries()) {
		deps.mediaFetcher.files.set(url(name), { body: png(i), contentType: "image/png" });
	}
}

async function start(
	deps: Deps,
	posts: Post[],
	opts: { dryRun?: boolean; tpl?: Record<string, unknown> } = {},
): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, json(posts));
	return createJob(deps, {
		uploadId: upload,
		template: opts.tpl ?? template(),
		schemaFields,
		mediaMaxBytes: 1000,
		...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
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

const body = (deps: Deps, n = 0) => [...deps.content.entries.values()][n]?.data.body;

const POST: Post = {
	id: "p1",
	title: "Hello",
	html: `<p>Hi <a href="javascript:x">there</a></p><img src="${url("a.png")}" alt="A"><table><tr><td>t</td></tr></table>`,
};

describe("importing Portable Text", () => {
	it("imports HTML with library images and warnings, and re-runs unchanged without a download", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const job = await runToEnd(deps, (await start(deps, [POST])).id);
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(job.mediaMaxBytes).toBe(1000);
		expect(body(deps)).toEqual([
			{
				_type: "block",
				_key: "b0",
				style: "normal",
				children: [{ _type: "span", _key: "b0s0", text: "Hi there", marks: [] }],
			},
			{
				_type: "image",
				_key: "b1",
				asset: { _ref: "m1", url: "/_emdash/api/media/file/K1.png" },
				alt: "A",
				width: 4,
				height: 3,
			},
			{
				_type: "block",
				_key: "b2",
				style: "normal",
				children: [{ _type: "span", _key: "b2s0", text: "t", marks: [] }],
			},
		]);
		const warnings = [
			{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
			{
				field: "body",
				code: "link_dropped",
				message:
					"Kept the text of 1 link without the address: the scheme javascript: is not allowed",
			},
		];
		const [first] = await rows(deps, job.id);
		expect(first).toMatchObject({
			status: "created",
			newMedia: [`body: ${url("a.png")}`],
			warnings,
			changes: [
				{ field: "title", before: null, after: "Hello" },
				{ field: "body", before: null, after: "3 blocks, 1 image" },
			],
		});
		const again = await runToEnd(deps, (await start(deps, [POST])).id);
		expect(again.counters).toMatchObject({ unchanged: 1 });
		const [second] = await rows(deps, again.id);
		// Warnings are saved on unchanged rows too.
		expect(second).toMatchObject({ status: "unchanged", warnings });
		expect(second).not.toHaveProperty("newMedia");
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		expect(deps.content.calls.filter((c) => c.startsWith("update"))).toEqual([]);
	});

	it("plans a dry run without downloading, listing new images and the warnings", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const job = await runToEnd(deps, (await start(deps, [POST], { dryRun: true })).id);
		expect(job.counters).toMatchObject({ created: 1 });
		const [row] = await rows(deps, job.id);
		expect(row).toMatchObject({
			status: "planned",
			action: "create",
			newMedia: [`body: ${url("a.png")}`],
			changes: [
				{ field: "title", before: null, after: "Hello" },
				{ field: "body", before: null, after: "3 blocks, 1 image (1 new)" },
			],
		});
		expect(row?.warnings).toHaveLength(2);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.media.calls).toEqual([]);
	});

	it("downloads a URL shared by an image field and Portable Text once", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const tpl = template({}, { photo: { from: "photo", type: "image" } });
		const post = { id: "p1", title: "T", photo: url("a.png"), html: `<img src="${url("a.png")}">` };
		const job = await runToEnd(deps, (await start(deps, [post], { tpl })).id);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
		const [row] = await rows(deps, job.id);
		expect(row?.newMedia).toEqual([`photo: ${url("a.png")}`]);
		expect((body(deps) as { asset: { _ref: string } }[])[0]?.asset._ref).toBe("m1");
	});

	it("drops an image that fails, keeps the record, and plans unchanged while it still fails", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		const post = {
			id: "p1",
			title: "T",
			html: `<p>t</p><img src="${url("gone.png")}"><img src="${url("a.png")}">`,
		};
		const job = await runToEnd(deps, (await start(deps, [post])).id);
		expect(job.counters).toMatchObject({ created: 1 });
		const [row] = await rows(deps, job.id);
		expect(row?.warnings).toEqual([
			{
				field: "body",
				code: "image_dropped",
				message: `media_http_error: ${url("gone.png")}: The server answered HTTP 404`,
			},
		]);
		expect(row?.newMedia).toEqual([`body: ${url("a.png")}`]);
		expect((body(deps) as unknown[]).length).toBe(2);
		const again = await runToEnd(deps, (await start(deps, [post])).id);
		expect(again.counters).toMatchObject({ unchanged: 1 });
		// The dropped URL is tried again; the stored one is a map hit.
		expect(deps.mediaFetcher.urls()).toEqual([url("gone.png"), url("a.png"), url("gone.png")]);
	});

	it("fails the record for a failing image with imageErrors: fail, and replaces its warnings on retry", async () => {
		const { deps } = makeDeps();
		const tpl = template({ imageErrors: "fail" });
		const post = { id: "p1", title: "T", html: `<dl><dt>d</dt></dl><img src="${url("a.png")}">` };
		const created = await start(deps, [post], { tpl });
		const job = await runToEnd(deps, created.id);
		expect(job.counters).toMatchObject({ failed: 1 });
		const [failed] = await rows(deps, job.id);
		expect(failed).toMatchObject({
			status: "failed",
			errors: [
				{ field: "body", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			warnings: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
			],
		});
		expect(deps.content.entries.size).toBe(0);
		serve(deps, "a.png");
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const [row] = await rows(deps, job.id);
		expect(row?.warnings).toEqual(failed?.warnings);
		expect(row).not.toHaveProperty("errors");
	});

	it("defers a record with more new images than one Workers batch allows, downloading each URL once", async () => {
		const { deps } = makeDeps();
		const names = Array.from({ length: 12 }, (_, i) => `${i}.png`);
		serve(deps, ...names);
		const html = names.map((n) => `<img src="${url(n)}">`).join("");
		const created = await start(deps, [{ id: "p1", title: "T", html }]);
		let job = await runBatch(deps, created.id, "driver", Number.POSITIVE_INFINITY, 600);
		// 25 for the record and 12 lookups, then 9 downloads of 60 before the next would pass 600.
		expect(job.cursor.seq).toBe(0);
		expect(deps.mediaFetcher.urls()).toHaveLength(9);
		expect(job.deferred).toEqual({
			seq: 0,
			newTerms: [],
			newMedia: names.slice(0, 9).map((n) => `body: ${url(n)}`),
		});
		job = await runToEnd(deps, created.id, 600);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(deps.mediaFetcher.urls()).toEqual(names.map(url));
		const [row] = await rows(deps, job.id);
		expect(row?.newMedia).toEqual(names.map((n) => `body: ${url(n)}`));
		expect((body(deps) as unknown[]).length).toBe(12);
	});

	it("updates only a changed Portable Text field, sending data, and clears an emptied one", async () => {
		const { deps } = makeDeps();
		serve(deps, "a.png");
		await runToEnd(deps, (await start(deps, [POST])).id);
		const edited = { ...POST, html: `${POST.html}<p>More</p>` };
		const job = await runToEnd(deps, (await start(deps, [edited])).id);
		expect(job.counters).toMatchObject({ updated: 1 });
		const [row] = await rows(deps, job.id);
		expect(row?.changes).toEqual([
			{ field: "body", before: "3 blocks, 1 image", after: "4 blocks, 1 image" },
		]);
		expect((body(deps) as unknown[]).length).toBe(4);
		const emptied = await runToEnd(
			deps,
			(await start(deps, [{ ...POST, html: "<script>x</script>" }])).id,
		);
		expect(emptied.counters).toMatchObject({ updated: 1 });
		expect(body(deps)).toBeNull();
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("skips images with images: skip, without media or the linked Workers cap", async () => {
		const { deps } = makeDeps();
		const tpl = template({ images: "skip" });
		const job = await runToEnd(deps, (await start(deps, [POST], { tpl })).id);
		expect(job).not.toHaveProperty("mediaMaxBytes");
		expect(workersBatchCap(job)).toBe(WORKERS_BATCH_CAP);
		expect(workersBatchCap({ ...job, template: template() as Job["template"] })).toBe(
			WORKERS_LINKED_BATCH_CAP,
		);
		expect((body(deps) as unknown[]).length).toBe(2);
		expect(deps.mediaFetcher.urls()).toEqual([]);
		expect(deps.mediaMap.rows.size).toBe(0);
	});
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/unit/portable-text-import.test.ts`
Expected: FAIL (8 failed): nothing is written into `body` (`expected undefined to deeply equal [ { _type: 'block', … }, … ]`), rows have no `warnings`, the dry run is not `planned` with `newMedia`, and the failing image does not fail the record.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, replace
````ts
	type LinkPlan,
	type MediaPlanItem,
	type PlanAction,
	planRecord,
	type RecordPlan,
} from "./diff.js";
````
with:
````ts
	type LinkPlan,
	type MediaPlanItem,
	type PlanAction,
	type PortableTextPlanItem,
	planRecord,
	type RecordPlan,
} from "./diff.js";
````

then replace
````ts
	obtainRecordMedia,
	type ResolvedMedia,
} from "./media.js";
import {
	ContentWriteError,
	type EntrySnapshot,
````
with:
````ts
	obtainRecordMedia,
	type ResolvedMedia,
} from "./media.js";
import {
	lookupPortableTextImages,
	obtainPortableTextImages,
	portableTextPlan,
	type RecordImages,
} from "./portable-text-images.js";
import {
	ContentWriteError,
	type EntrySnapshot,
````

then replace
````ts
} from "./template.js";
import {
	type Counters,
	type EngineDeps,
	emptyCounters,
	type Job,
	type LinkRow,
	linkKey,
	type RecordRow,
	recordKey,
} from "./types.js";
````
with:
````ts
} from "./template.js";
import {
	type Counters,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	type Job,
	type LinkRow,
	linkKey,
	type RecordError,
	type RecordRow,
	recordKey,
} from "./types.js";
````

then replace
````ts
	links?: ResolvedLinks;
	/** The record's media field values, written with the data; absent when it maps none. */
	media?: Record<string, MediaPlanItem | null>;
};

const PENDING_DRAFT_MESSAGE =
````
with:
````ts
	links?: ResolvedLinks;
	/** The record's media field values, written with the data; absent when it maps none. */
	media?: Record<string, MediaPlanItem | null>;
	/** The record's Portable Text values, written with the data; absent when it maps none. */
	portableText?: Record<string, PortableTextPlanItem | null>;
};

const PENDING_DRAFT_MESSAGE =
````

then replace
````ts
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
````
with:
````ts
	return { resolved, current, childSide };
}

/**
 * What a record found to create or download, and the warnings of its conversion and images,
 * listed on its row whatever happens to it.
 */
type Found = { newTerms: string[]; newMedia: string[]; warnings: RecordError[] };

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, media it downloads (or would) as `newMedia`, and what its
 * conversion and images reported as `warnings`, whatever happens to the record afterwards. A
 * retried record's warnings replace the earlier ones.
 */
async function decide(
	deps: EngineDeps,
````

then replace
````ts
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found: Found = { newTerms: [], newMedia: [] };
	const carried = job.deferred?.seq === rec.seq ? job.deferred : undefined;
	let row: RowFields;
	try {
````
with:
````ts
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found: Found = { newTerms: [], newMedia: [], warnings: [] };
	const carried = job.deferred?.seq === rec.seq ? job.deferred : undefined;
	let row: RowFields;
	try {
````

then replace
````ts
		...row,
		...(newTerms.length > 0 ? { newTerms } : {}),
		...(newMedia.length > 0 ? { newMedia } : {}),
	};
}
````
with:
````ts
		...row,
		...(newTerms.length > 0 ? { newTerms } : {}),
		...(newMedia.length > 0 ? { newMedia } : {}),
		...(found.warnings.length > 0 ? { warnings: capWarnings(found.warnings) } : {}),
	};
}
````

then replace
````ts
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };
````
with:
````ts
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	found.warnings.push(...(mapped.warnings ?? []));
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };
````

then replace
````ts
	try {
		const requests = mapped.value.links;
		const mediaRequests = mapped.value.media;
		if (requests || mediaRequests) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
````
with:
````ts
	try {
		const requests = mapped.value.links;
		const mediaRequests = mapped.value.media;
		const drafts = mapped.value.portableText;
		const hasImages = Object.values(drafts ?? {}).some((d) => d !== null && d.images.length > 0);
		if (requests || mediaRequests || hasImages) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
````

then replace
````ts
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
````
with:
````ts
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
		let images: RecordImages | undefined;
		if (drafts) {
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				drafts,
				template.portableText,
			);
			images = looked.images;
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
````

then replace
````ts
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
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
````
with:
````ts
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
		if (drafts && images) ctx.portableText = portableTextPlan(drafts, images);
		const plan = planRecord(entry, mapped.value, comparisons, links, media, ctx.portableText);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			for (const [field, item] of Object.entries(media ?? {})) {
				const url = mediaRequests?.[field]?.url;
				if (item?.mediaId === null && url) found.newMedia.push(`${field}: ${url}`);
			}
			for (const [url, { field }] of misses) found.newMedia.push(`${field}: ${url}`);
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
````

then replace
````ts
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
````
with:
````ts
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups && misses.length === 0) return await writeRecord(ctx, entry, plan, mapped.value);
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
			const obtained = await obtainRecordMedia(deps, cache, mediaContext(job), lookups);
			found.newMedia = obtained.newMedia;
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			ctx.media = obtainedMedia(obtained.media);
		}
		if (drafts && images && misses.length > 0) {
			const obtained = await obtainPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				images,
				template.portableText,
				found.newMedia,
			);
			found.warnings.push(...obtained.warnings);
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			ctx.portableText = portableTextPlan(drafts, images);
		}
		const final = planRecord(entry, mapped.value, comparisons, links, ctx.media, ctx.portableText);
		action = final.action;
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
````

then replace
````ts
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media fields are data fields: their values (null clears one) are written with the rest.
	const media: Record<string, FieldValue> = {};
	for (const [field, item] of Object.entries(ctx.media ?? {})) media[field] = item?.value ?? null;
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry) {
````
with:
````ts
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media and Portable Text fields are data fields: their values (null clears one) are written
	// with the rest.
	const media: Record<string, FieldValue> = {};
	for (const [field, item] of Object.entries(ctx.media ?? {})) media[field] = item?.value ?? null;
	for (const [field, item] of Object.entries(ctx.portableText ?? {})) {
		media[field] = item?.blocks ?? null;
	}
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry) {
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/unit/portable-text-import.test.ts`
Expected: PASS (1 file, 8 tests). Full suite after this task: 52 files / 1,270 tests

- [ ] **Step 5: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/portable-text-import.test.ts
git commit -m "Import Portable Text with its images in the batch runner"
```

### Task 7: Node integration on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/fixtures/portable-text.ts`, `packages/flux-import/tests/integration/portable-text.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6; the integration harness (`startServer(port, …, allowPrivateNetwork = true)`, `Client`, `devBypass`, `FeedServer`) and M4c's `tests/fixtures/media.ts` (`RED_PNG`, `BLUE_PNG`, `GREEN_JPEG`).
- Produces: `tests/fixtures/portable-text.ts`: `createPortableTextSchema(client, collection)` (fields `title`, `photo` image, `body` portableText), `type Post`, `postsJson(posts)`, `portableTextTemplate(collection, opts?)`, `articleHtml(imageUrl)` (a heading, marks, links, a captioned linked image, a table and a script). The new test file starts its own server on port 4393 with `allowPrivateNetwork`.

- [ ] **Step 1: Write the tests**

Create `packages/flux-import/tests/fixtures/portable-text.ts`:
````ts
/**
 * Schema, sources and templates for the M4d Portable Text imports on the Node and workerd sites.
 * Image URLs point at a `FeedServer`; the bodies carry a link, a table and a script, so every
 * import reports warnings.
 */
import type { Client } from "../integration/client.js";

/** Creates a collection (with revisions) with `title`, an image field `photo`, and `body`. */
export async function createPortableTextSchema(client: Client, collection: string): Promise<void> {
	await client.createCollection(collection);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "body", label: "Body", type: "portableText" },
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

export type Post = {
	id: string;
	title: string;
	slug?: string;
	html?: string;
	md?: string;
	photo?: string;
};

/** A JSON source: `{ "posts": [...] }`. */
export const postsJson = (posts: Post[]) => JSON.stringify({ posts });

/**
 * `body` from `html` (or `md` with `format: "markdown"`), `title`, and `photo` when asked. Extra
 * mapping options go on `body`.
 */
export function portableTextTemplate(
	collection: string,
	opts: {
		format?: "html" | "markdown";
		body?: Record<string, unknown>;
		photo?: boolean;
		field?: string;
		slug?: boolean;
	} = {},
) {
	const format = opts.format ?? "html";
	return {
		version: 1,
		source: { format: "json", records: "posts" },
		collection,
		locale: "en",
		key: { from: "id" },
		...(opts.slug ? { slug: { from: "slug" } } : {}),
		fields: {
			title: { from: "title", type: "text" },
			[opts.field ?? "body"]: {
				from: format === "html" ? "html" : "md",
				type: "portableText",
				format,
				...opts.body,
			},
			...(opts.photo ? { photo: { from: "photo", type: "image" } } : {}),
		},
	};
}

/** An article body: a heading, marks, a link, a captioned linked image, a table and a script. */
export function articleHtml(image: string): string {
	return `<h2>Intro <em>here</em></h2>
<p>Read <strong>this</strong> and <a href="https://example.com/more" target="_blank">more</a>.</p>
<figure><a href="https://example.com/big"><img src="${image}" alt="A red square"></a><figcaption>A caption</figcaption></figure>
<table><tr><td>cell</td></tr></table><script>alert("x")</script>`;
}
````

Create `packages/flux-import/tests/integration/portable-text.test.ts`:
````ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { BLUE_PNG, GREEN_JPEG, RED_PNG } from "../fixtures/media.js";
import {
	articleHtml,
	createPortableTextSchema,
	type Post,
	portableTextTemplate,
	postsJson,
} from "../fixtures/portable-text.js";
import { Client, devBypass } from "./client.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4393;

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: images are fetched from 127.0.0.1 (allowPrivateNetwork).
	server = await startServer(PORT, undefined, undefined, true);
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

async function importPosts(
	posts: Post[],
	template: Record<string, unknown>,
	opts: { dryRun?: boolean } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(postsJson(posts), "posts.json");
	const created = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function stored(collection: string): Promise<Map<string, Record<string, unknown>>> {
	return new Map(
		(await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e.data]),
	);
}

type Block = { _type: string; style?: string; asset?: { _ref: string; url: string } };
const imagesOf = (value: unknown) => (value as Block[]).filter((b) => b._type === "image");

describe("Portable Text on Node", () => {
	it("imports HTML with an image into a page that renders it, and re-runs unchanged without a request", async () => {
		feeds.feeds.set("/t1/red.png", { body: tagged(RED_PNG, "t1"), contentType: "image/png" });
		const post = {
			id: "it-m4d-1",
			slug: "it-m4d-1",
			title: "Imported page",
			html: articleHtml(feeds.url("/t1/red.png")),
		};
		const template = portableTextTemplate("pages", { field: "content", slug: true });
		const first = await importPosts([post], template);
		expect(first.job.counters).toMatchObject({ created: 1, failed: 0 });
		expect(first.rows[0]).toMatchObject({
			status: "created",
			newMedia: [`content: ${feeds.url("/t1/red.png")}`],
			warnings: [
				{ field: "content", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
				{ field: "content", code: "removed_markup", message: "Removed 1 <script> element" },
			],
		});
		const content = (await stored("pages")).get("it-m4d-1")?.content;
		const [image] = imagesOf(content);
		const item = await client.api<{
			item: { id: string; mimeType: string; storageKey: string; alt: string };
		}>("GET", `/_emdash/api/media/${image?.asset?._ref}`);
		expect(item.item).toMatchObject({ mimeType: "image/png", alt: "A red square" });
		expect(image?.asset?.url).toBe(`/_emdash/api/media/file/${item.item.storageKey}`);

		const page = await client.raw("GET", "/pages/it-m4d-1");
		const html = await page.text();
		expect(page.status).toBe(200);
		// The image component serves the file through Astro's image endpoint.
		expect(html).toContain(encodeURIComponent(image?.asset?.url ?? "?"));
		expect(html).toContain("<figcaption");
		expect(html).toContain("A caption");
		expect(html).toContain('href="https://example.com/big"');
		expect(html).toContain('href="https://example.com/more" target="_blank"');
		expect(html).toContain("<strong>this</strong>");
		expect(html).toContain("<em>here</em>");
		expect(html).not.toContain('alert("x")');
		const file = await client.raw("GET", image?.asset?.url ?? "?");
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/png");

		const requests = feeds.requests.length;
		const again = await importPosts([post], template);
		expect(again.job.counters).toMatchObject({ unchanged: 1 });
		expect(again.rows[0]?.warnings).toHaveLength(2);
		expect(feeds.requests.length).toBe(requests);
	});

	it("imports Markdown with an image", async () => {
		await createPortableTextSchema(client, "it_pt_md");
		feeds.feeds.set("/t2/blue.png", { body: tagged(BLUE_PNG, "t2"), contentType: "image/png" });
		const md = `## Notes\n\n- one\n  - two\n\n![Blue](${feeds.url("/t2/blue.png")})\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
		const { job, rows } = await importPosts(
			[{ id: "M1", title: "Markdown", md }],
			portableTextTemplate("it_pt_md", { format: "markdown" }),
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).not.toHaveProperty("warnings");
		const body = (await stored("it_pt_md")).get("M1")?.body as Record<string, unknown>[];
		expect(
			body.map((b) =>
				b._type === "block" ? `${b.style}${b.listItem ? ` ${b.level}` : ""}` : b._type,
			),
		).toEqual(["h2", "normal 1", "normal 2", "image", "code"]);
		expect(body[3]).toMatchObject({ alt: "Blue", width: 4, height: 3 });
		expect(body[4]).toMatchObject({ code: "const a = 1;\n", language: "ts" });
	});

	it("plans a dry run without a request, listing the images a real run would download", async () => {
		await createPortableTextSchema(client, "it_pt_dry");
		feeds.feeds.set("/t3/red.png", { body: tagged(RED_PNG, "t3"), contentType: "image/png" });
		const requests = feeds.requests.length;
		const { job, rows } = await importPosts(
			[{ id: "D1", title: "Dry", html: articleHtml(feeds.url("/t3/red.png")) }],
			portableTextTemplate("it_pt_dry"),
			{ dryRun: true },
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).toMatchObject({
			status: "planned",
			newMedia: [`body: ${feeds.url("/t3/red.png")}`],
			changes: [
				{ field: "title", before: null, after: "Dry" },
				{ field: "body", before: null, after: "4 blocks, 1 image (1 new)" },
			],
		});
		expect(rows[0]?.warnings).toHaveLength(2);
		expect(feeds.requests.length).toBe(requests);
		expect(await client.listAll("it_pt_dry")).toEqual([]);
	});

	it("drops a 404 image with a warning, and fails the record with imageErrors: fail", async () => {
		await createPortableTextSchema(client, "it_pt_404");
		const html = `<p>Text</p><img src="${feeds.url("/t4/missing.png")}">`;
		const dropped = await importPosts(
			[{ id: "N1", title: "Dropped", html }],
			portableTextTemplate("it_pt_404"),
		);
		expect(dropped.job.counters).toMatchObject({ created: 1 });
		expect(dropped.rows[0]?.warnings).toEqual([
			{
				field: "body",
				code: "image_dropped",
				message: `media_http_error: ${feeds.url("/t4/missing.png")}: The server answered HTTP 404`,
			},
		]);
		expect(imagesOf((await stored("it_pt_404")).get("N1")?.body)).toEqual([]);
		const failed = await importPosts(
			[{ id: "N2", title: "Failed", html }],
			portableTextTemplate("it_pt_404", { body: { imageErrors: "fail" } }),
		);
		expect(failed.job.counters).toMatchObject({ failed: 1 });
		expect(failed.rows[0]?.errors).toEqual([
			{ field: "body", code: "media_http_error", message: "The server answered HTTP 404" },
		]);
		expect((await stored("it_pt_404")).has("N2")).toBe(false);
	});

	it("downloads an image shared with an image field once", async () => {
		await createPortableTextSchema(client, "it_pt_shared");
		feeds.feeds.set("/t5/green.jpg", { body: tagged(GREEN_JPEG, "t5"), contentType: "image/jpeg" });
		const image = feeds.url("/t5/green.jpg");
		const { job, rows } = await importPosts(
			[{ id: "S1", title: "Shared", photo: image, html: `<p>t</p><img src="${image}">` }],
			portableTextTemplate("it_pt_shared", { photo: true }),
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]?.newMedia).toEqual([`photo: ${image}`]);
		expect(feeds.requests.filter((r) => r.path === "/t5/green.jpg")).toHaveLength(1);
		const data = (await stored("it_pt_shared")).get("S1");
		expect(imagesOf(data?.body)[0]?.asset?._ref).toBe(
			(data?.photo as { id: string } | undefined)?.id,
		);
	});
});
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/portable-text.test.ts tests/integration/behaviours.test.ts`
Expected: PASS (2 files, 19 tests; about 18 s with server start). This proves on Node that an HTML import renders on the page through `PortableText` (the image through Astro's image endpoint, Fact V2), with library items and warnings on the rows; that a re-run is `unchanged` without a request; a Markdown import; a dry run without a request listing `newMedia`; a 404 image dropped with a warning and failing the record with `imageErrors: "fail"`; and an image shared with an `image` field downloaded once. Then run `pnpm test:integration` (about 9 minutes; Fact F1).

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/fixtures/portable-text.ts packages/flux-import/tests/integration/portable-text.test.ts
git commit -m "Prove M4d Portable Text imports on the Node dev site"
```

### Task 8: workerd parity on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Task 7's fixture; the parity harness (`client`, `byKey`, `FeedServer`); `WORKERS_LOOKUP_BUDGET` (600) and `COST_MEDIA` (60) through the running plugin.
- Produces: two parity tests, "imports M4d Portable Text from HTML and Markdown into R2, defers a record by budget, and re-runs unchanged" and "writes a record with almost 1 MiB of M4d Portable Text to D1".

- [ ] **Step 1: Write the tests**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
````ts
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
````
with:
````ts
	postsTemplate,
} from "../fixtures/links.js";
import {
	BLUE_PNG,
	createMediaSchema,
	GREEN_JPEG,
	largePng,
	MANUAL_PDF,
	mediaCsv,
	mediaTemplate,
	RED_PNG,
	type StoredMedia,
} from "../fixtures/media.js";
import {
	articleHtml,
	createPortableTextSchema,
	type Post,
	portableTextTemplate,
	postsJson,
} from "../fixtures/portable-text.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, type Product } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
````

then replace
````ts
		}
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
````
with:
````ts
		}
	});

	it("imports M4d Portable Text from HTML and Markdown into R2, defers a record by budget, and re-runs unchanged", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			await createPortableTextSchema(client, "cf_pt");
			const names = Array.from({ length: 12 }, (_, i) => `/pt/${i}.png`);
			for (const [i, name] of names.entries()) {
				const body = new Uint8Array([...RED_PNG, ...new TextEncoder().encode(`cf-pt-${i}`)]);
				feeds.feeds.set(name, { body, contentType: "image/png" });
			}
			feeds.feeds.set("/pt/blue.png", { body: BLUE_PNG, contentType: "image/png" });
			const run = async (posts: Post[], template: Record<string, unknown>) => {
				const { uploadId } = await client.upload(postsJson(posts), "posts.json");
				const job = await client.plugin("jobs/create", { uploadId, template, dryRun: false });
				const done = await client.runToEnd(job.id);
				return { done, rows: await client.records(done.id) };
			};
			const html: Post[] = [
				{ id: "H1", title: "Article", html: articleHtml(feeds.url(names[0] as string)) },
				// More new images than one Workers batch downloads (WORKERS_LOOKUP_BUDGET).
				{
					id: "H2",
					title: "Gallery",
					html: names.map((n) => `<img src="${feeds.url(n)}">`).join(""),
				},
			];
			const first = await run(html, portableTextTemplate("cf_pt"));
			expect(first.done.counters).toMatchObject({ created: 2, failed: 0 });
			expect(first.rows[0]?.warnings).toHaveLength(2);
			expect(first.rows[1]?.newMedia).toEqual(names.slice(1).map((n) => `body: ${feeds.url(n)}`));
			// Each URL was downloaded once, across the batches that deferred H2.
			for (const name of names) {
				expect(feeds.requests.filter((r) => r.path === name)).toHaveLength(1);
			}
			const entries = await byKey("cf_pt");
			const gallery = entries.get("H2")?.data.body as { asset: { url: string } }[];
			expect(gallery).toHaveLength(12);
			const file = await client.raw("GET", gallery[0]?.asset.url ?? "?");
			expect(file.status).toBe(200);
			expect(file.headers.get("content-type")).toBe("image/png");

			const md = `# Title\n\n![Blue](${feeds.url("/pt/blue.png")})\n\n- *one*\n`;
			const markdown = await run(
				[{ id: "M1", title: "Markdown", md }],
				portableTextTemplate("cf_pt", { format: "markdown" }),
			);
			expect(markdown.done.counters).toMatchObject({ created: 1 });
			const body = (await byKey("cf_pt")).get("M1")?.data.body as { _type: string }[];
			expect(body.map((b) => b._type)).toEqual(["block", "image", "block"]);

			const requests = feeds.requests.length;
			const again = await run(html, portableTextTemplate("cf_pt"));
			expect(again.done.counters).toMatchObject({ unchanged: 2 });
			expect(feeds.requests.length).toBe(requests);
		} finally {
			await feeds.stop();
		}
	});

	it("writes a record with almost 1 MiB of M4d Portable Text to D1", async () => {
		await client.createCollection("cf_pt_big");
		for (const slug of ["a", "b", "c"]) {
			await client.api("POST", "/_emdash/api/schema/collections/cf_pt_big/fields", {
				slug,
				label: slug,
				type: "portableText",
			});
		}
		// Three fields of 340,000 characters: about 1,020,000 bytes of JSON, under the 1 MiB cap.
		const text = (tag: string) => `${tag} ${"lorem ipsum ".repeat(28_333)}`.trim();
		const record = { id: "B1", a: text("a"), b: text("b"), c: text("c") };
		const field = (from: string) => ({ from, type: "portableText", format: "text" });
		const { uploadId } = await client.upload(JSON.stringify({ posts: [record] }), "big.json");
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: {
				version: 1,
				source: { format: "json", records: "posts" },
				collection: "cf_pt_big",
				locale: "en",
				key: { from: "id" },
				slug: { from: "id" },
				fields: { a: field("a"), b: field("b"), c: field("c") },
			},
			dryRun: false,
		});
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		const stored = (await byKey("cf_pt_big")).get("B1")?.data;
		const bytes = new TextEncoder().encode(
			JSON.stringify([stored?.a, stored?.b, stored?.c]),
		).byteLength;
		expect(bytes).toBeGreaterThan(1_000_000);
		expect(
			(stored?.c as { children: { text: string }[] }[] | undefined)?.[0]?.children[0]?.text,
		).toBe(record.c);
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
````

- [ ] **Step 2: Run them**

Run (from `packages/flux-import`): `pnpm exec vitest run --config vitest.cf.config.ts -t "M4d"`
Expected: PASS (2 passed, 10 skipped; about 14 s of tests plus about 29 s of server start). This proves on workerd that HTML and Markdown convert and their images are stored in R2 and served with their type, that a record with 12 new images is deferred by the lookup budget and completes in later batches with each URL downloaded once (Ruling 14), that a re-run is `unchanged` without a request, and that about 1,020,000 bytes of Portable Text JSON are written to D1 (Fact V5). The full `pnpm test:cf` runs in Task 9.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove M4d Portable Text imports on workerd, D1 and R2"
```

### Task 9: M4d review run

**Files:**
- Create: `docs/superpowers/notes/2026-11-02-m4d-review.md`
- Modify: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`

**Interfaces:**
- Consumes: everything above, and the Task 0 results in "Facts this plan relies on".
- Produces: the filled-in review note and the roadmap status; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 20 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Fact F1 describes a known WSL clock flake, which a re-run of the file settles; Fact F2 the one-off workerd 500 to watch for). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` and `sites/dev/uploads` first; an agent runs `FLUX_DEV_ALLOW_PRIVATE_NETWORK=1 node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass` and a local file server holding two PNGs (for example `python3 -m http.server` in a scratch folder), record each result:
1. Create the schema with `createPortableTextSchema(client, "m4d_posts")` from `tests/fixtures/portable-text.ts` (or the same REST calls by hand) and run `jobs/create` with `portableTextTemplate("m4d_posts")` and a JSON file of three posts (one from `articleHtml(<png url>)`, one with a `<p>` holding a `javascript:` link and an `<iframe>`, one with only `<script>`) as a dry run: rows are `planned`, `newMedia` lists the image URL as `body: <url>`, the warnings name the table, script, iframe and link, the file server logged no request, and the third post's row has no `body` change (its body is empty).
2. Run it for real and open each entry in the admin editor: the heading, marks, link (opening in a new tab), image with its caption and alt and the table's text show as imported; the Media Library has the image with its alt; `jobs/log.csv` has the `warnings` column filled.
3. Save the first entry in the editor without changing anything, then re-run the import: `unchanged: 3` (the editor regenerated the keys, Fact V2), and the file server logged no new request.
4. Change a word of the first post's HTML and re-run: that row is `updated`, its change reads `body: 4 blocks, 1 image → 4 blocks, 1 image`, and the editor shows the new word.
5. Import a Markdown post (`portableTextTemplate("m4d_posts", { format: "markdown" })`) with a heading, a nested list, a code fence and an image, and open it in the admin editor: the heading, nested list, code block and image show as written. Restore `sites/dev/data.db*` and `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-11-02-m4d-review.md` from this template and fill in every `…`:
````markdown
# Milestone 4d review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0  ·  parse5 7.3.0  ·  markdown-it 14.3.3

## Unconfirmed facts (Task 0)

| Fact | Check | Result |
| --- | --- | --- |
| V1: the converter's value with a library image writes and reads back deep-equal, keys included, also as a draft, on Node and workerd | drafting probe (plan Facts); Tasks 6-8 | … |
| V2: an editor round trip canonicalizes equal; the page renders image, caption, links and marks | drafting probe; Task 5 round-trip test; Task 7 page; manual check 3 | … |
| V3: `parse5` and `markdown-it` convert in a plugin route on workerd | drafting probe; Task 8 | … |
| V4: `markdown-it` 14.3.3 linear; `parse5` worst cases at the limits under 300 ms on Node | drafting measurements (plan Facts); Task 1 time-bound tests | … |
| V5: 1 MiB of Portable Text JSON on SQLite and D1, with revisions | drafting probe; Task 8 | … |

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
| Converter: kept blocks and marks, nested lists and level clamping, `p` in `li`, blockquotes, `pre` with language, `br`, images splitting blocks, `figure`/`figcaption`, `data-src`, transparent tags, unknown and removed tags with counts, attributes dropped, link rules, whitespace, deterministic keys, `text` format, size, nesting and image limits, `unknownMarkup: "fail"`, parser exceptions | `portable-text.test.ts`, `portable-text-template.test.ts` | … |
| Markdown: headings, emphasis, links, images, lists, code fences, tables reported as unknown, raw HTML through the same rules, the M3/M4 pathological inputs under a time bound | `portable-text.test.ts` | … |
| Resolution: map hit without download, dry-run miss in `newMedia`, a URL in a field and in Portable Text downloaded once, `"drop"` and `"fail"`, `images: "skip"`, deferral by deadline and by budget but never the first download, `media_config` | `portable-text-images.test.ts`, `media-resolve.test.ts`, `media-import.test.ts`, `portable-text-import.test.ts` | … |
| Diff and writes: canonical comparison (keys, empty `marks`/`markDefs`, `normal` style, editor additions), non-array stored value, change text, warnings on `unchanged` rows, the log `warnings` column, a Portable Text-only change sends `data` | `diff.test.ts`, `log.test.ts`, `portable-text-import.test.ts` | … |
| Schema checks: type compatibility, the mapping limit, `baseUrl`, `schema/apply` creating `portableText` | `portable-text-template.test.ts`, `schema-apply.test.ts`, `definition.test.ts` | … |
| Integration on `sites/dev`: HTML with images, link, table and script renders; library items; warnings; re-run `unchanged` without a request; Markdown; dry run; 404 dropped and failing with `"fail"`; shared image downloaded once | `portable-text.test.ts` (integration) | … |
| Deferral of a record with more new images than one batch allows (moved to workerd, plan Ruling 14) | `parity.test.ts` | … |
| workerd: HTML and Markdown with images into R2, re-run `unchanged`; almost 1 MiB on D1 | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Dry run: `planned`, `newMedia`, warnings, no request, empty body planned `null` | … | … |
| 2 | Real run: editor shows the imported content; library item with alt; log `warnings` column | … | … |
| 3 | Editor save, then re-run `unchanged` without a request | … | … |
| 4 | Changed source updates only that row, with the change text | … | … |
| 5 | Markdown post renders | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Mark M4d done in the roadmap**

In `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`, replace
```markdown
| M4d | HTML and Markdown to Portable Text, with unknown markup reported per record, and image URLs in Portable Text rewritten to media from M4c | Planned |
```
with:
```markdown
| **M4d** ([spec](./2026-11-02-flux-import-m4d-portable-text-design.md)) | HTML and Markdown to Portable Text, with unknown markup reported per record, and image URLs in Portable Text rewritten to media from M4c | Done ([review](../notes/2026-11-02-m4d-review.md)) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-11-02-m4d-review.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 4d review results and mark M4d done in the roadmap"
```

---

## After this plan

M4d is the last part of Milestone 4. Known gaps carried forward, all documented in the spec or in the rulings above: tables, embeds, galleries, `htmlBlock` passthrough, `srcset`, alignment, `blurhash` and `dominantColor` on image blocks, links rewritten to entries of the same import, `data:` images and refresh for Portable Text images are out of scope; a dry run cannot report HTTP errors, sizes or types of new images; a Portable Text field is rewritten from the source whenever any data field of the entry changes, replacing an editor's changes (M5 adds "never overwrite fields edited in the admin"); the editor regenerates keys on save, which the diff ignores but which makes stored keys differ from the importer's; every download now defers by the Workers budget, which changes how M4c media jobs split into batches (they make the same progress, in more batches); the one-off workerd 500 of Fact F2 is unexplained. The M2-M4c open issues (`docs/superpowers/notes/2026-10-08-m2-review.md` through `docs/superpowers/notes/2026-10-27-m4c-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands.
