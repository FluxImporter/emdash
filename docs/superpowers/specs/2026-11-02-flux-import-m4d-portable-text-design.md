# Flux Import M4d: HTML and Markdown to Portable Text

Status: approved 2026-10-27 (the user approved all remaining milestones up front; design decisions
are the implementer's rulings). Fourth part of Milestone 4 (Field types and schema) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md#milestone-4-split). Builds on M4c
([spec](./2026-10-27-flux-import-m4c-media-design.md),
[review](../notes/2026-10-27-m4c-review.md)), merged at `09c9867`.

## Goal

Import `portableText` fields from HTML, Markdown or plain text in the source:

- The importer converts each value to Portable Text with its own bounded converter. HTML is parsed
  with `parse5`. Markdown is rendered to HTML with `markdown-it`, and that HTML goes through the
  same converter. Plain text becomes paragraphs.
- Markup the converter does not know is **reported per record** as a warning, and its text is
  kept. Scripts, styles, iframes and other active content are removed and reported. Event
  handlers, `style` and other attributes are dropped. Links keep only safe schemes.
- Each image (`<img>`, `![]()`) becomes an image block that references a Media Library item. The
  importer obtains the item through the M4c resolver and media map, so a re-run downloads nothing
  and a URL shared with an `image` field is stored once.
- Block and span keys are deterministic, and the diff compares Portable Text without keys, so a
  re-run plans `unchanged`.

A dry run downloads nothing. It converts, reports warnings, resolves map hits, and lists the image
URLs a real run would download. The template stays `version: 1` and every addition is optional.

## Decisions

| Topic | Decision |
| --- | --- |
| Converter | Our own, in `src/engine/portable-text.ts`, on `parse5`'s `parseFragment` (spec-compliant HTML parsing, no DOM, pure JS). EmDash's two converters are not used. `markdownToPortableText` (F5) treats each line as a paragraph, keeps a module-wide key counter (keys depend on the process's history), splices `<!--ec:block {json}-->` lines in as raw blocks (a source could inject any block, including an `htmlBlock` with script), stores image URLs instead of media references, and reports nothing. `htmlToPortableText` (F6) scans blocks with regular expressions, makes random keys by default, leaks `<script>` and `<style>` text into spans, flattens nested lists to level 1, stores the image URL as `_ref`, reports nothing, and its package imports a GPL-2.0-or-later parser at module load. |
| Markdown | `markdown-it` renders Markdown to HTML (`html: true`, `linkify: false`, `typographer: false`, CommonMark plus tables and strikethrough), then the HTML converter runs. One converter means one set of rules, warnings and sanitizing, also for raw HTML inside Markdown. `marked` (already in the tree through `@emdash-cms/admin`) was measured and refused: unmatched emphasis is quadratic, 12 KB took 1.0 s and 30 KB did not finish in 100 s, and 5,000 nested quotes overflowed the stack (M3). `markdown-it` 14.1.0 stayed linear on the same probes (150 KB in 39 ms, M4). |
| New dependencies | `parse5` 7.3.0 (MIT; depends on `entities` ^6, BSD-2-Clause; already in the lockfile through `@emdash-cms/gutenberg-to-portable-text`), and `markdown-it` 14.3.3 (MIT; the maintained 14.x line, released 2026-10-16, same dependency ranges as 14.1.0) with `@types/markdown-it` as a dev dependency. Both are pinned exactly. Bundled and minified: about 178 KB (47 KB gzip) and 147 KB (52 KB gzip). `markdown-it` installs `argparse` 2.0.1 (Python-2.0 license) for its CLI only; the library never imports it, so it is not bundled. Task 0 re-runs the probes on 14.3.3 (V4). |
| What is kept | Blocks: paragraphs, `h1`-`h6`, `blockquote`, bullet and numbered lists with nesting (`level`, at most 6), `pre` as a `code` block (`language` from a `language-*` or `lang-*` class), `hr` as a `break` block, `img` as an `image` block. Inline: `strong`/`b`, `em`/`i`, `u`, `s`/`strike`/`del`, `code`, `sub`, `sup` as decorators (`strong`, `em`, `underline`, `strike-through`, `code`, `subscript`, `superscript`, the set EmDash's editor accepts, F9), `a` as a `link` annotation, `br` as `\n` in the text. Shapes match what EmDash's editor writes (F8). |
| Transparent markup | Kept as text, without a warning: `div`, `span`, `section`, `article`, `main`, `header`, `footer`, `aside`, `nav`, `address`, `figure`, `picture`, `font`, `center`, `small`, `mark`, `ins`, `abbr`, `cite`, `q`, `dfn`, `kbd`, `samp`, `var`, `time`, `data`, `bdi`, `bdo`, `wbr`, `html`, `body`, `p` inside `li` (joined with `\n`). Block containers end the current paragraph. Comments, including WordPress block comments, are dropped silently. All attributes are dropped silently except `href`, `target="_blank"`, `src`, `data-src`, `alt` and the code-language class. |
| Unknown markup | Any other element, for example `table`, `dl`, `details`, custom elements (`my-widget`): its text is kept (each table row becomes a paragraph, cells joined by ` \| `; `dt`/`dd` become paragraphs), and the record gets one warning per tag name with a count: `unknown_markup`, "Kept the text of 3 <table> elements". Tables are not converted to EmDash's table block: its shape lives in `@emdash-cms/admin` and is not documented (out of scope). |
| Removed markup | `script`, `style`, `noscript`, `template`, `iframe`, `frame`, `object`, `embed`, `video`, `audio`, `canvas`, `svg`, `math`, `form`, `input`, `button`, `select`, `textarea`, `link`, `meta`, `base`, and the raw-text elements `noembed`, `noframes`, `xmp`, `plaintext` and `title`: removed with their content, one warning per tag name (`removed_markup`, "Removed 2 <iframe> elements"). Nothing executable reaches the stored value: the converter emits only the block and mark types above, and EmDash's renderer escapes text and re-checks hrefs (F10). |
| Unknown markup policy | Mapping option `unknownMarkup: "warn"` (default) or `"fail"`. With `"fail"`, `unknown_markup`, `removed_markup` and `link_dropped` are record errors instead of warnings. |
| Links | `href` is resolved against `baseUrl` when it is relative. Kept: `http:`, `https:`, `mailto:`, `tel:` (the absolute schemes EmDash's `sanitizeHref` renders, F10) and a bare `#fragment`. Anything else (`javascript:`, `data:`, `vbscript:`, `ftp:`, a relative URL without `baseUrl`, more than 2,048 characters, control characters) drops the link and keeps its text, with a `link_dropped` warning. `target="_blank"` sets `blank: true`. A block shares one `markDef` per distinct `href` and `blank`. |
| Images | `src` (or `data-src` when `src` is missing or a `data:` URL, as lazy-loading markup writes) is resolved against `baseUrl`, a protocol-relative URL takes `baseUrl`'s scheme or `https`, then `normalizeMediaUrl` (M4c review, open issue 1). An image inside a paragraph, heading or list item ends that block, emits the image block, and continues a new block with the same style and list position. `alt` is kept (trimmed; more than 1,000 characters is cut with an `alt_truncated` warning). A `figure`'s `figcaption` becomes `caption` (plain text, at most 1,000 characters). An image wrapped in a link gets `link: { href, blank? }` under the link rules. |
| Image block | `{ _type: "image", _key, asset: { _ref: <media id>, url: "/_emdash/api/media/file/<storageKey>" }, alt?, caption?, width?, height?, link? }`. This is the shape EmDash's editor writes for a library image (F8), which the renderer serves through `buildRenderMediaUrl` (F7) and the media usage index counts as `portable_text_image` by its bare `_ref` ID (F11). `width` and `height` come from the media item. `blurhash` and `dominantColor` are not written, because the 1.2.0 editor drops them on save (F8) and every editor save would then look like a change. |
| Image option | Mapping option `images: "import"` (default) or `"skip"`. `"skip"` drops every image without a warning and downloads nothing; such a template needs no storage. |
| Image failures | Mapping option `imageErrors: "drop"` (default) or `"fail"`. With `"drop"`, an image that cannot be imported (invalid or relative URL without `baseUrl`, blocked host, HTTP error, too large, wrong type, upload error) is left out of the blocks and the record gets an `image_dropped` warning that carries the M4c code and message. With `"fail"`, it is a record error with the M4c code, as for an `image` field. Default `"drop"`, because one broken image in a long article should not keep the article out; a dropped URL is tried again on the next run, where it plans `unchanged` if it still fails. `CONFIGURATION_ERROR` and `NO_STORAGE` still fail the job (`media_config`), and deferral still defers. |
| Keys | Deterministic per field: blocks `b0`, `b1`, …; spans `<block key>s0`, …; link definitions `<block key>l0`, …. Keys are unique within their array, which is all EmDash needs; it accepts missing keys (F1) and its editor regenerates them only for duplicates (F8). |
| Diff | No new comparison kind (plan Ruling 3): `planRecord` takes the Portable Text fields as a separate argument, canonicalizes both values and compares them with `deepEqual`. Canonical form (plan Ruling 2): every `_key` removed at every depth, an empty `markDefs` or `marks` array equal to a missing one, `style: "normal"` equal to a missing style on text blocks, the editor's additions (`listId`, `listStart: 1`, a link's `blank: false`) equal to missing, each span mark that names a `markDef` renamed to the definition's position, and a span's marks sorted (the editor reorders them on save). A stored value that is not an array is a change. A record whose images include a miss (dry run, or before downloads) is always a change, as in M4c. Task 0 proves that an editor round trip of the importer's value canonicalizes equal (V2). |
| Change text | Portable Text is never put into a row's `changes`. A change reads `{ field: "body", before: "12 blocks, 2 images" \| null, after: "14 blocks, 3 images (1 new)" }`. |
| Warnings on the row | `RecordRow` gains `warnings?: RecordError[]` (`field`, `code`, `message`), at most 20 per record; the 20th is replaced by `{ code: "warnings_truncated", message: "N more warnings" }`. A row's errors are capped the same way at 50 (the 50th an `errors_truncated` "N more errors"), and every kept message is cut to 1,000 characters, so no producer can make a row too large for D1. Warnings are saved whatever the record's status, `unchanged` and `planned` included. A retried row's warnings are replaced, not merged: they describe the latest conversion. The log CSV gains a last column `warnings` (`field: code: message`, joined with `; `). |
| Size and work limits | Per field: the source text is at most 128 KiB (UTF-8) for Markdown and 512 KiB for HTML and text, the HTML that `markdown-it` renders at most 2 MiB (checked while rendering), `markdown-it` creates at most 100,000 tokens and `parse5` at most 150,000 nodes (each element counted with its attributes), and at most 256 elements are open at once, counted exactly inside `parse5` through its tree adapter's `onItemPush`/`onItemPop`, implied elements included (plan Ruling 1). Over a size or token or node limit the record fails `portable_text_too_large`. No tag may carry more than 1,000 attributes (counted exactly in `parse5`'s tokenizer, which checks each new attribute name against the earlier ones); that and the nesting bound fail the record `portable_text_too_complex`. Per record: the Portable Text sources are at most 512 KiB together (checked before any field is parsed), at most 1 MiB of Portable Text JSON over all mapped fields, enforced while converting (see Conversion), and at most 50 distinct image URLs (with `imageErrors: "drop"` the rest are dropped with one `image_dropped` warning; with `"fail"` the record fails `portable_text_limit`). Per template: at most 3 `portableText` mappings. Per field, markup issues are capped at 19 plus one `unknown_markup` summary ("N more markup issues"), and invalid image URLs the same way. The limits keep the stored row well under D1's 2 MB (F13) and a record's memory within a Worker; dense Markdown at the 128 KiB limit was measured at about 0.5-0.6 s of CPU per field. |
| Shared media path | Images go through `findMedia` / `obtainMedia` from `src/engine/media.ts` with the batch's `LookupCache`: the per-batch item cache, obtained and failed URLs, the media deadline and deferral, and the Workers budget (M4c review, open issue 2). A URL used by an `image` field and in Portable Text, or twice in one record, is downloaded once. New items get the image's alt as their library default, as in M4c. A type refusal that does not depend on the field (a file no field could take) is cached in the batch's failed URLs, for M4c fields too; one that only this field refuses is not. When a record is deferred, the failures of the downloads it actually tried are carried in `job.deferred` and seeded into the next batch's failed URLs for that record only, so a dropped image is not fetched again in every batch (which would never finish on Workers) and a later record's field is not failed by it. |
| Budget deferral | New rule for every download, field media included: a download other than the batch's first throws `MediaDeferred` when `cache.spent + COST_MEDIA` would exceed the budget. Without it, a record with 50 new images would spend 3,000 units on Workers in one batch. With it, such a record is deferred and the next batch finds its earlier images in the map (2 units each) and downloads the next ones, so every batch makes progress. M4c records (at most 5 downloads, 300 units) could exceed the budget before; now they defer instead. |
| Empty values | A missing path, `null`, blank text, or a conversion with no blocks left (only removed markup) is empty: `null`, which clears the field. An empty value into a `required` field fails `required`, also when the field is left empty only after its dropped images are left out (by the image limit, or after downloads), before anything is written. Non-text values fail `not_scalar`. |
| `schema/apply` | `portableText` joins `APPLY_FIELD_TYPES` (a JSON column created through `SchemaRegistry` like the others, F2), and it cannot be indexed. |
| Locale | Portable Text is per locale row like every other field. The media map stays locale-free (M4c). |
| Capabilities | Unchanged. `media:write` was added in M4c. |

## EmDash facts this design relies on

Checked against `emdash@1.2.0` (package `src/`), `@emdash-cms/gutenberg-to-portable-text@1.2.0`
(`dist/`), `astro-portabletext@0.11.4`, and the docs on 2026-11-02.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | A `portableText` value is validated only as an array of objects with a string `_type`; `_key` is optional and every other key passes (`.loose()`). Nothing checks block types, marks or styles | `src/schema/zod-generator.ts:144-160`; [field types: portableText](https://docs.emdashcms.com/reference/field-types/#portabletext) |
| F2 | `portableText` is a `JSON` column. On create and update, the runtime only turns a blank string in it into `null`; it does not normalize Portable Text (image fields are normalized, F6 of M4c, but not Portable Text image blocks) | `src/schema/types.ts:89`; `src/emdash-runtime.ts:311`, `:5953-5976` |
| F3 | EmDash's renderer (`PortableText` from `emdash/ui`) maps `image`, `code`, `break`, `table`, `htmlBlock`, `iframe`, `video` and other types to components; text styles `normal`, `h1`-`h6`, `blockquote`; marks `link`, `underline`, `strike-through`, `superscript`, `subscript`, plus `strong`, `em`, `code` from `astro-portabletext`. Consecutive `blockquote` blocks render as one quote | `src/components/index.ts:100-125`; `src/components/marks.ts`; `src/components/Block.astro:26-62`; `src/components/PortableText.astro:55-64`; `astro-portabletext` `components/Mark.astro:17-28` |
| F4 | An unknown block type renders as a hidden `<div data-portabletext-unknown="type">` with a warning, an unknown mark as a plain `<span>`, an unknown style as `<p>`; the renderer logs a warning | `astro-portabletext` `components/UnknownType.astro`, `UnknownMark.astro`, `UnknownBlock.astro`; `components/PortableText.astro:48`, `:282`, `:306` |
| F5 | `markdownToPortableText(markdown): PortableTextBlock[]` is exported from `emdash/client`. It is line-based (each line is a block), uses a module-wide key counter (`k0`, `k1`, … across calls), parses `<!--ec:block {json} -->` lines into raw blocks, writes images as `{ _type: "image", alt, asset: { url } }`, does not check link schemes, and reports nothing | `src/client/index.ts:1676`; `src/client/portable-text.ts:167-276`, `:187-196`, `:257-268`, `:327-330`, `:358-362` |
| F6 | `htmlToPortableText(html, options?)` in `@emdash-cms/gutenberg-to-portable-text` 1.2.0 (MIT, 50 KB `index.mjs`): regex block scan (`BLOCK_ELEMENT_PATTERN`), inline parsing with `parse5` that descends into every element (so `<script>` text becomes span text), keys `key-<n>-<random>` unless `keyGenerator` is passed, image blocks with `asset: { _type: "reference", _ref: <url>, url }`, all list items at `level: 1`, no unknown-markup report. Its dependencies are `parse5` ^7.2.1 (MIT) and `@wordpress/block-serialization-default-parser` ^5.13.0 (GPL-2.0-or-later, 5.57.0 installed), imported at module top. It is a dependency of `emdash`, not of this plugin | `dist/index.mjs:1-3`, `:13-24`, `:86-104`, `:1254`, `:1285-1291`, `:1333-1395`; `package.json` |
| F7 | The image component reads `asset._ref` (media ID) and `asset.url`; for local media it renders `asset.url` (or `/_emdash/api/media/file/<id>` from the ID) through `buildRenderMediaUrl`, which maps the internal prefix to the storage's public URL when there is one. It uses `alt`, `caption`, `width`, `height`, `link` (sanitized), `alignment`, `blurhash`, `dominantColor`. A block without `asset` renders nothing | `src/components/Image.astro:17-55`, `:78-83`, `:166-174`, `:253`; `src/content/converters/gallery.ts:22-48`; `src/media/url.ts:76-93` |
| F8 | The editor writes image blocks as `{ _type: "image", _key, asset: { _ref: mediaId \|\| src, url: src, provider? }, alt?, caption?, title?, width?, height?, displayWidth?, displayHeight?, alignment?, link? }` and reads them back from the same keys (no `blurhash`, `dominantColor`). Breaks are `{ _type: "break", style: "lineBreak" }`, code blocks `{ _type: "code", code, language? }`, text blocks omit an empty `markDefs` and spans always carry `marks`. Keys are kept, and regenerated only when duplicated | `src/content/converters/prosemirror-to-portable-text.ts:62-77`, `:147-152`, `:169-185`, `:350-356`, `:409-470`, `:537-542`; `src/content/converters/portable-text-to-prosemirror.ts:268-318`, `:696-719` |
| F9 | The editor accepts the decorators `strong`, `em`, `underline`, `strike-through`, `subscript`, `superscript`, `code`, and `link` annotations; other marks make the editor refuse the value (`UnsupportedPortableTextMarksError`) | `src/content/converters/mark-safety.ts:3-11`, `:58-60`; `src/content/converters/portable-text-to-prosemirror.ts:69`, `:621-668` |
| F10 | Links render through `sanitizeHref`: `http:`, `https:`, `mailto:`, `tel:` (that also parse as URLs), site-relative paths and `#` fragments; anything else becomes `#`. `htmlBlock` content is sanitized (`sanitizeContent`) unless `isolated`, which renders in a sandboxed iframe | `src/utils/url.ts:19-69`; `src/components/marks/Link.astro`; `src/components/HtmlBlock.astro:1-30` |
| F11 | The media usage index records a Portable Text image's `asset._ref` (or `asset.id`) when it is a bare ID: a URL or a `/_emdash/api/media/file/` path is not counted | `src/media/usage/extractor.ts:126-178`, `:244-269`, `:364-396`; [REST: media usage covers Portable Text image blocks](https://docs.emdashcms.com/reference/rest-api/#list-and-inspect-media) |
| F12 | `portableTextToProsemirror` and `prosemirrorToPortableText` are exported from `emdash` | `src/index.ts:122-123`; [API: content converters](https://docs.emdashcms.com/reference/api/#content-converters) |
| F13 | D1: 2,000,000 bytes per string, BLOB or row; 100 KB per SQL statement; 100 bound parameters; 1,000 queries per invocation on Paid. Workers limits are as in M4c F15 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), read 2026-11-02 |

The docs do not describe the stored image-block shape, which mark and block types are accepted, or
key rules beyond "give every block and span a stable `_key`" in seed files
([sections](https://docs.emdashcms.com/guides/sections/#provide-sections-in-a-seed-file)). The
shapes above come from the 1.2.0 source and are proven at runtime by V1 and V2. The current docs say
Markdown images written through MCP or the CLI refer to media by URL, which is newer than 1.2.0 and
not used here.

### Measurements while drafting

Node 22.23.1, bundled with esbuild, on the WSL development machine.

- **M1, parse5 7.3.0.** 256 KiB of ordinary HTML in 38 ms, 4 MiB in 341 ms. Nesting is quadratic:
  1,000 nested `<div>` 4 ms, 5,000 82 ms, 10,000 331 ms, 100,000 29.9 s. Unclosed `<p>`, `<font>`
  and formatting tags are cheap (10,000 in 8-10 ms).
- **M2, parse5 at the limits.** 256 nested `<div>` plus about 512 KiB of the worst tags found
  (stray `</p>`, unclosed `<li>`) took 234-246 ms; the other cases 17-51 ms. At 1,000 nested and
  1 MiB the same cases took 1.7 s, which is why the limits are 256 and 512 KiB.
- **M3, marked 17.0.6.** `"*a "` repeated: 1.5 KB 21 ms, 3 KB 67 ms, 6 KB 250 ms, 12 KB 1,001 ms;
  30 KB did not finish within 100 s. `"_a "` the same. 5,000 nested `>` threw `RangeError`.
- **M4, markdown-it 14.1.0.** `"*a "` and `"_a "` at 150 KB 39 ms, 50,000 `[` 50 ms, 5,000 nested
  `>` 1 ms, 1,000 nested list levels (1 MB) 7 ms, 50,000 `[a](` 39 ms, 1 MiB of ordinary Markdown
  230 ms.

### Unconfirmed, proven by Task 0

- **V1.** A `portableText` value built by the converter (paragraphs with every decorator and a
  link, a heading, a two-level list, a blockquote, a code block, a break, and an image block that
  references a library item, with `alt`, `caption`, `width`, `height` and `link`) is written with
  `handleContentCreate` and reads back from `handleContentGet` deep-equal, keys included, on Node
  and on workerd (D1). The same holds for an update with `publish: false` (draft revision).
- **V2.** The same value survives an editor round trip: `prosemirrorToPortableText(
  portableTextToProsemirror(value))` (F12) does not throw and canonicalizes equal to the value.
  The page renders it with `PortableText` from `emdash/ui`: the image's `src` is the file URL and
  serves the item, the caption and link render, and the text renders with its marks.
- **V3.** `parse5` 7.3.0 and `markdown-it` 14.3.3 bundle into `sites/dev-cf` and convert inside a
  plugin route on workerd.
- **V4.** The M3/M4 probes on `markdown-it` 14.3.3 stay linear (each under 100 ms at 150 KB), and the
  M2 worst cases at the limits stay under 300 ms on Node; workerd timings are recorded.
- **V5.** A record with 1 MiB of Portable Text JSON writes and reads back on workerd (D1) and on
  SQLite, also with revisions.

If V1, V2 or V3 fail, the plan stops and the spec is amended before Task 1. If V4 fails for
14.3.3, the plan pins 14.1.0 and records why. If V5 fails, the per-record cap drops to 512 KiB.

## Template additions

```json
{
	"version": 1,
	"source": { "format": "json", "records": "posts" },
	"collection": "posts",
	"locale": "en",
	"key": { "from": "id" },
	"fields": {
		"title": { "from": "title", "type": "text" },
		"content": {
			"from": "content_html",
			"type": "portableText",
			"format": "html",
			"baseUrl": "https://old.example.com/blog/",
			"imageErrors": "fail"
		},
		"summary": { "from": "summary_md", "type": "portableText", "format": "markdown", "images": "skip" }
	}
}
```

| Option | Value |
| --- | --- |
| `format` | Required: `"html"`, `"markdown"` or `"text"` (paragraphs split on blank lines; single newlines kept as `\n`) |
| `baseUrl` | An absolute http(s) URL (`parseSourceUrl` rules), for relative `src` and `href` |
| `images` | `"import"` (default) or `"skip"` |
| `imageErrors` | `"drop"` (default) or `"fail"` |
| `unknownMarkup` | `"warn"` (default) or `"fail"` |

`COMPATIBLE.portableText = ["portableText"]`. `usesMedia` is also true for a `portableText`
mapping with `images: "import"`, which sets `mediaMaxBytes`, the Workers linked batch cap and the
storage check at job creation. `checkTemplate` adds: a `portableText` mapping into another field
type, more than 3 `portableText` mappings, and a `baseUrl` that is not absolute http(s) (also a
Zod refinement).

## Conversion

`portableTextConverter(mapping)` runs inside `applyTemplate`, synchronously, after the M3a/M4a
empty and `not_scalar` rules:

1. Size check (`portable_text_too_large`): each field's source, then the record's sources together;
   if any is over, no field is converted. For Markdown, render with `markdown-it` (at most 100,000
   tokens) and stop as soon as the HTML passes 2 MiB. For text, build the blocks directly (no
   HTML).
2. `parseFragment` with a tree adapter that counts open elements (more than 256 fails
   `portable_text_too_complex`) and created nodes (more than 150,000 fails
   `portable_text_too_large`), and a tokenizer that counts each tag's attributes (more than 1,000
   fails `portable_text_too_complex`). The counts are exact, so nothing can bypass them (plan
   Ruling 1 replaced the spec's linear pre-scan, which under-counted nested lists).
3. An iterative walk (an explicit stack, no recursion) that builds draft blocks
   with marks, link definitions and image slots, and collects warnings with counts per tag.
4. Whitespace: outside `pre`, runs of HTML whitespace become one space, and leading and trailing
   spaces of a block are trimmed; empty text blocks are dropped. `pre` keeps its text exactly, minus
   one leading newline.
5. The JSON size budget, enforced while building: a running estimate (each finished block exactly,
   plus the open text block's text and spans, and 160 bytes per image block for what resolution
   adds) stops the field with `portable_text_too_large` as soon as it passes what the record's
   earlier fields left of 1 MiB. The record's later fields are then not converted.
6. Keys, the per-record image limit, and the exact JSON size check once every field is converted.

Any exception from `parse5` or `markdown-it` (for example a `RangeError`) fails the record with
`portable_text_failed`, never the batch.

```ts
type PortableTextImage = { url: string /* normalized */; alt: string | null };
type PortableTextDraft = {
	/** Blocks; an image block holds `{ _type: "image", _key, slot }` until resolution. */
	blocks: DraftBlock[];
	/** One entry per distinct normalized URL, with the alt of its first use; slots index into it. */
	images: PortableTextImage[];
};
// No invalidImages (plan Ruling 6): the converter applies imageErrors itself to URLs it can refuse
// without the network (an image_dropped warning or an invalid_media_url error).
// MappedRecord gains: portableText?: Record<string, PortableTextDraft | null>; kept out of `data`.
// applyTemplate's result gains warnings: RecordError[] (also for records that then fail).
```

| Code | Kind | When |
| --- | --- | --- |
| `unknown_markup` | warning (error with `unknownMarkup: "fail"`) | An element outside the known, transparent and removed lists |
| `removed_markup` | warning (error with `"fail"`) | Active content removed |
| `link_dropped` | warning (error with `"fail"`) | An unsafe or unresolvable `href` |
| `alt_truncated` | warning | An image `alt` over 1,000 characters |
| `image_dropped` | warning (`imageErrors: "drop"`) | An image left out; the message has the M4c code and the URL |
| `portable_text_too_large` | error | Over 128 KiB of Markdown or 512 KiB of HTML or text in a field, 512 KiB of sources per record, 2 MiB rendered Markdown, 100,000 Markdown tokens or 150,000 HTML nodes in a field, or 1 MiB of JSON per record |
| `portable_text_too_complex` | error | More than 256 open elements (counted exactly in `parse5`), or a tag with more than 1,000 attributes |
| `portable_text_limit` | error (`imageErrors: "fail"`) | More than 50 distinct image URLs in the record |
| `portable_text_failed` | error | The parser threw |
| `invalid_media_url` and the M4c resolution codes | error (`imageErrors: "fail"`) | As in M4c, with field `<field>` and the URL in the message |
| `required`, `not_scalar` | error | As in M4a |

## Resolution, diff and writes

- **Lookups.** `lookupPortableTextImages` looks up the Portable Text images next to M4c's
  `lookupRecordMedia`: one `findMedia` per distinct URL over the record's Portable Text fields,
  naming the first field that uses it (plan Ruling 15; a URL shared with an `image` field is looked
  up by both paths and downloaded once, through the batch's obtained URLs), with
  `kind: "image"`, the image's alt and `refresh: false`. With `imageErrors: "fail"` every lookup
  error is collected, as for fields; with `"drop"` a lookup error becomes a warning and the slot
  is dropped.
- **Provisional plan.** A miss leaves its slot unresolved, and a field with an unresolved slot is a
  change (`after` says how many are new). A dry run stops here and lists each miss in `newMedia`
  as `<field>: <url>`.
- **Downloads.** After the pending-draft and lock checks, field media first, then Portable Text
  images in document order, through `obtainMedia`, one at a time. `"fail"` stops at the first
  failure; `"drop"` records the warning and continues. `MediaDeferred` carries the `newMedia` so far,
  and `processRecord`, `importPass` and `retryPass` handle it as in M4c.
- **Assembly.** Each slot becomes the image block (Decisions), from the item and the image's alt,
  caption and link. A dropped slot is removed. A field left with no blocks is `null`.
- **Diff.** The final plan compares each field with the `portableText` comparison (Decisions).
  Portable Text fields are data fields for `writeRecord`'s `dataChanged` test.
- **Writes.** The assembled array is put into `data` under the field. Documented behaviour, as for
  M4c media: when any data field of an existing entry changes, every mapped Portable Text field is
  rewritten from the source, so an editor's changes to it are replaced (M5 adds "never overwrite
  fields edited in the admin").

Ports and engine types:

```ts
// MediaLookup is unchanged (no source; plan Ruling 15): the two lookup paths keep their own bookkeeping.
// RecordRow gains: warnings?: RecordError[]
// Comparison and BY_TARGET are unchanged (plan Ruling 3): Portable Text fields are not in data
// before the plan, and planRecord compares them with the canonical form.
type PortableTextPlanItem = {
	/** The assembled blocks; null for an empty value. */
	blocks: JsonValue[] | null;
	/** Images not stored yet: the field is a change while this is above 0. */
	pending: number;
	/** How the record shows it: "14 blocks, 3 images (1 new)". */
	text: string;
};
// planRecord gains a portableText?: Record<string, PortableTextPlanItem | null> argument.
```

## Bounded work

| Bound | Value | Why |
| --- | --- | --- |
| Source per field | 128 KiB of Markdown; 512 KiB of HTML or text | With nesting at most 256, the worst HTML parse measured about 0.25 s (M2); `markdown-it`'s tokens and HTML take many times the source's memory (512 KiB of `"a\n\n"` exhausted a 128 MB heap) |
| Sources per record | 512 KiB together | Three fields' parsed trees at their own limits do not fit in a Worker's memory |
| Rendered Markdown | 2 MiB, checked while rendering | `markdown-it` output can be larger than its input; one reference definition used thousands of times renders tens of megabytes |
| Markdown tokens | 100,000 per field | Memory grows with tokens, not source: a 100-column table header makes each short row after it 100 cells (1.7 KB made 200,000 tokens); 128 KiB of prose is about 11,000 |
| HTML nodes | 150,000 per field (elements with their attributes, text and comments) | Each new paragraph reopens every active formatting element: 16 KiB of HTML made 164,000 nodes |
| Open elements | 256, counted exactly in `parse5` | parse5's cost grows with depth squared (M1) |
| Attributes per tag | 1,000, counted in `parse5`'s tokenizer | parse5 checks each new name against the earlier ones |
| `portableText` mappings | 3 per template | Dense Markdown at the 128 KiB limit measured about 0.5-0.6 s of CPU per field |
| JSON per record | 1 MiB, enforced while converting; each image block counted with 160 bytes | D1 rows hold 2 MB, and a revision stores the data again (F13); no field builds far past it |
| Image URLs | 50 per record | With the budget deferral, 50 new images take about five Workers batches |
| Markup issues | 19 per field plus a summary; invalid image URLs the same | Bounded under `unknownMarkup: "fail"` and `imageErrors: "fail"` too |
| Warnings | 20 per record | Record rows stay small |
| Errors | 50 per record (`errors_truncated`), each message at most 1,000 characters | No producer can make a row too large for D1 |
| Workers batch | `WORKERS_LINKED_BATCH_CAP` (10) when images are imported, else `WORKERS_BATCH_CAP` (20) | Conversion is CPU, not D1, so a template without images keeps the plain cap |

A batch still ends by its time budget, which includes conversion time.

## Testing

- **Unit, converter:** each kept block and mark; nested lists and level clamping; `p` inside `li`;
  blockquote runs; `pre` with a language class and whitespace kept; `br`; images inside a
  paragraph, list item and link splitting the block; `figure` with `figcaption`; `data-src`;
  transparent tags without warnings; unknown tags (table rows and cells, `dl`, a custom element)
  with counted warnings; removed tags (`script` text never reaches a span, `iframe`, `svg`); event
  handlers and `style` dropped; links (`javascript:`, `data:`, relative with and without `baseUrl`,
  `#fragment`, `mailto:`, `tel:`, `_blank`, shared `markDefs`); whitespace collapsing; deterministic
  keys (two conversions are identical); `text` format; the size, nesting and image limits;
  `unknownMarkup: "fail"`; a parser exception as `portable_text_failed`.
- **Unit, Markdown:** headings, emphasis, links, images, lists, code fences, tables (reported as
  unknown), raw HTML through the same rules, and the M3/M4 pathological inputs each under a time
  bound.
- **Unit, resolution:** a map hit becomes a block with no download; a miss in a dry run lists
  `newMedia` and plans a change; a URL in a field and in Portable Text downloads once; `"drop"`
  keeps the record and warns, `"fail"` fails it with the M4c code; `images: "skip"`; deferral by
  deadline and by budget, never for the batch's first download; `media_config` fails the job.
- **Unit, diff and writes:** canonical comparison ignores keys, empty `markDefs` and `marks`, and a
  missing `normal` style; a stored non-array is a change; the change text; warnings saved on
  `unchanged` rows; the log CSV `warnings` column; a Portable Text-only change sends `data`.
- **Unit, schema checks:** type compatibility, the mapping limit, `baseUrl`, `schema/apply`
  creating `portableText`.
- **Integration on `sites/dev`** (local HTTP server, `allowPrivateNetwork`): a JSON import with HTML
  bodies containing images, a link, a table and a script creates entries whose `content` renders on
  the page (V2), with library items for the images and warnings on the rows; a re-run is
  `unchanged` with no request; a Markdown import; a dry run with no request and `newMedia`; a 404
  image dropped with a warning, and failing the record with `imageErrors: "fail"`; an image shared
  with an `image` field downloaded once. The Node runtime has no lookup budget, so budget deferral
  is tested in the unit suite and on workerd (plan Ruling 14).
- **Cloudflare parity on `sites/dev-cf`:** one HTML and one Markdown import with images into R2,
  and a re-run `unchanged`; a record with more new images than one batch allows is deferred and
  completes in the next batches without a second download of the same URL.

## Plan sizing

About nine tasks: (0) prove V1-V5 and add the two dependencies; (1) template schema, options,
`COMPATIBLE`, `checkTemplate`, `usesMedia`, `schema/apply`; (2) the HTML converter: pre-scan, walk,
blocks, marks, links, whitespace, keys, warnings, limits, and the `text` format; (3) Markdown through
`markdown-it`, with the pathological tests; (4) image extraction (`src`, `data-src`, `baseUrl`,
normalization, the per-record limit) and `applyTemplate` integration with record warnings; (5)
resolution: shared lookups, downloads, drop and fail, assembly, the budget deferral rule; (6) the
`portableText` comparison, change text, writes, `RecordRow.warnings` and the log column; (7) batch
ordering, Workers caps and route wiring; (8) integration and parity tests, and the review note.

## Out of scope for M4d

Tables as EmDash table blocks; `iframe`, `video` and `audio` as EmDash embed, iframe or video
blocks; galleries; `htmlBlock` passthrough for unknown markup; `blocks` fields and Portable Text
inside repeaters; image `srcset` (the largest candidate) and `alignment` from classes; per-use
`displayWidth` / `displayHeight`; `blurhash` and `dominantColor` on image blocks; text alignment;
Gutenberg block comments (dropped; their HTML is converted); links rewritten to entries of the same
import; images from `data:` URLs; refresh for Portable Text images; Markdown extensions beyond
tables and strikethrough (footnotes, task lists: CommonMark has no task-list rule, so `- [ ] task`
stays the item text `[ ] task`, plan Ruling 9; a raw `<input>` is removed markup). The
production Cloudflare build blocker from M2 still stands.
