# Flux Import M3d: XLSX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 1, 2 and 3 can run in parallel worktrees (see "Parallel execution").

**Goal:** Import one sheet of an Excel workbook (`.xlsx`), from an upload or a saved URL source, with every guarantee the other formats have: bounded memory, exact resume, idempotent batches, per-record errors that never fail the job, and no duplicates after a crash.

**Architecture:** Convert once, then import. `src/sources/zip.ts` reads a zip archive held in memory (at most 10 MiB): the end-of-central-directory record, the central directory, and each entry inflated on demand through `DecompressionStream("deflate-raw")` under a cap enforced while inflating (100 MiB per part, the declared size, and 200× the compressed size). `src/sources/xlsx-workbook.ts` reads `xl/workbook.xml` and its relationships (worksheets in order, the 1904 date system, where the shared strings and styles are), the shared strings (rich text joined) and which cell styles are dates, all through the M3a XML scanner, which gains one option (`keepBlankText`) so whitespace-only strings survive. `src/sources/xlsx.ts` scans the chosen worksheet as a stream of `<row>` elements with the same scanner, names the header row's columns, and yields one JSON Lines record per data row: header name to typed value (strings, exact number text, booleans, ISO dates by number format) plus `_row`. `src/plugin/xlsx.ts` runs that conversion when `jobs/create` gets an XLSX template (from an upload or a URL source's fetch), buffers the lines (at most `maxSourceBytes`, 32 MiB on Workers), stages them as a new upload with their length, and creates the job on the copy: `uploadId` is the JSON Lines, `sourceUploadId` the workbook, and `readerFor({ format: "xlsx" })` is the JSON Lines reader, so the byte offset in the copy is the row cursor and the engine, batches, resume, retry and crash repair do not change. `sources/sample` converts only until the sample is full. A finished job releases its copy and, once no other job needs it and no source names it, the workbook.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, `astro/zod` (routes), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependency (no SheetJS or similar): our own zip directory reader, `DecompressionStream` and the M3a XML scanner.

**Spec:** `docs/superpowers/specs/2026-10-27-flux-import-m3d-xlsx-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. Previous plan: `docs/superpowers/plans/2026-10-26-flux-import-m3c-url-sources.md`; its review: `docs/superpowers/notes/2026-10-26-m3c-review.md`.

Every code block in Tasks 1 to 7 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite and the new workerd parity test on its own), then replayed task by task from the design commit `675f06d`; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0.

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`; no new route and no new option (`maxXlsxBytes()` is derived, not configurable).
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. Plugin route input schemas import `z` from `"astro/zod"`; the engine's template schema uses `zod` (definition.test.ts checks both accept and reject the same source blocks).
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code; staged files go through `emdash.storage` (`EmDashUploads`, `stageUpload`).
- No spreadsheet library. Inflate only with `DecompressionStream("deflate-raw")`; parse XML only with the M3a scanner (`xmlReader`, `parseXmlRecordText`). Nothing reads a zip entry without a size cap.
- Error codes, exactly: conversion problems are `INVALID_SOURCE` (job creation: `JobError("invalid_source", message)`, 400; sample: `ServiceError("INVALID_SOURCE", message, 400)`); a workbook over the file limit or converted lines over their limit are `TOO_LARGE` (413); pasting XLSX is `INVALID_FORMAT` (400); other spreadsheet files at the upload route are `UNSUPPORTED_SOURCE` (415).
- Limits are fixed in code: XLSX file `min(10 MiB, maxSourceBytes)`, 100 MiB per uncompressed part, 200× compression ratio, 1,000,000 shared strings and 50 MiB of them, 1,048,576 rows, 16,384 columns, converted JSON Lines `maxSourceBytes` (32 MiB on Workers).
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 6 also passes `pnpm test:integration` (about 9 minutes) and Task 7 the targeted workerd test (about 40 s); Task 8 runs everything, `pnpm test:cf` included (about 18 minutes).

## Review Focus

1. A zip bomb must stop at the cap while inflating, and an entry declaring a size beyond 200× its compressed size, or beyond its part cap, must be refused before a byte is inflated — test in Task 1 ("stops a zip bomb at the declared size while inflating, and refuses a high ratio up front").
2. The job must read the converted copy, never the workbook, so that a byte offset in the copy is an exact row cursor across kills — tests in Task 5 ("converts the sheet, imports the copy, and keeps the workbook as sourceUploadId") and Task 6 (kill and resume (XLSX): no duplicates on a 10,000-row sheet).
3. Cell values must be exact: date cells by their number format (with Excel's 1900 leap-year bug, `[h]:mm` staying a number) and number cells as their own text, so integers beyond 2^53 survive — tests in Task 4 ("turns dates into ISO text by the cell's number format, in the 1900 or 1904 system", "reads serials around Excel's 1900 leap-year bug, and counts 29 February 1900 as unreadable", "writes numbers as their exact text, so large integers stay exact").
4. Neither file may leak or vanish early: the converted copy goes with its job, the workbook stays while another job (a dry run awaiting its real run) or a URL source still needs it, and retention never purges a surviving job's workbook — tests in Task 3 ("releases an XLSX job's workbook with its converted file, unless another job needs it", "keeps the workbook a surviving XLSX job was converted from") and Task 6 ("imports an XLSX feed through a converted copy, keeping the fetched workbook").
5. On Workers the converted lines must reach R2 with a declared length and a hard 32 MiB cap, never as a stream of unknown length — tests in Task 5 ("stages the converted lines with their length, as R2 needs on Workers", "refuses converted lines over maxSourceBytes, and over the buffer on Workers") and Task 7 (the workerd import).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd (Wrangler 4, `compatibility_date` 2026-02-24, `nodejs_compat`); tasks cite them by number.

| # | Fact | Evidence |
| --- | --- | --- |
| Z1 | Node 22.23.1 has `CompressionStream("deflate-raw")` and `DecompressionStream("deflate-raw")`. Inflated chunks are 16 KiB. Truncated data rejects the read with `TypeError` (`Z_BUF_ERROR`), garbage with `TypeError` (`Z_DATA_ERROR`); bytes after the end of the deflate data are ignored. 100,011 bytes of one repeated character deflate to 126 bytes (about 800×). | `node -e` probe while drafting |
| Z2 | Local workerd has both too. Inflated chunks are 4 KiB. Truncated data rejects with `TypeError: Called close() on a decompression stream with incomplete data`, garbage with `TypeError: Decompression failed.`, and, unlike Node, trailing bytes with `TypeError: Trailing bytes after end of compressed data` (the zip reader passes exactly `compressedSize` bytes, so this never arises). Cancelling a reader mid-stream works. | temporary `probe/deflate` plugin route on `sites/dev-cf`, removed; Task 7 run |
| Z3 | TypeScript 5.9's DOM lib types `DecompressionStream.writable` as `WritableStream<BufferSource>`; piping a `ReadableStream<Uint8Array>` into it fails with TS2345, so the zip reader types its raw stream `ReadableStream<Uint8Array<ArrayBuffer>>` and widens it to `ReadableStream<BufferSource>` for `pipeThrough`. | `tsc` while drafting |
| X1 | The M3a scanner works as a streaming element scanner as it is: `xmlReader("worksheet/sheetData/row").read(stream, …)` yields one parsed `<row>` at a time (cells as `c`, repeated cells as an array, `<v>` as its text, attributes as `@r`, `@t`, `@s`), holding one row in memory, and namespaced attributes (`x14ac:dyDescent`, `xr:uid`) and `mc:AlternateContent` pass through. One gap: `parseXmlRecordText` drops whitespace-only text beside attributes, so `<t xml:space="preserve"> </t>` (a cell holding a space) loses its text. The minimal addition is a `keepBlankText` flag threaded through `xmlReader` → `XmlScanner` → `parseXmlRecord` → `parseXmlRecordText` (default off, so M3a XML is unchanged). | `xml.test.ts`, `xlsx-workbook.test.ts` |
| X2 | Excel writes an empty worksheet as `<sheetData/>`; the scanner then reports `invalid_source` "The document has no <worksheet/sheetData> element" when the root closes (`src/sources/xml.ts`, `notFound`). The same happens for `styleSheet/numFmts` and `styleSheet/cellXfs`, which are optional. `partElements(…, { optional: true })` treats exactly that message as "no elements". | `xlsx.test.ts` ("reads an empty <sheetData/> …"), `xlsx-workbook.test.ts` |
| X3 | The scanner compares element names exactly. Excel, LibreOffice, Google Sheets and openpyxl write SpreadsheetML unprefixed (default namespace); a prefixed root such as `<x:workbook>` is reported as "The root element is <x:workbook>, not <workbook>". | `xlsx-workbook.test.ts` |
| X4 | A workbook saved by Microsoft Excel is available under a permissive licence: `Translations.xlsx` in PhpSpreadsheet 1.30.1 (MIT), `src/PhpSpreadsheet/Calculation/locale/Translations.xlsx`, 108,747 bytes, SHA-256 `f89b2a3a…3d625`; its `docProps/app.xml` names `Microsoft Excel` (`coauthVersionLast="47"`). It has two worksheets (sheet IDs 4 and 3, so workbook order differs from ID order), 6,565 shared strings, styles without custom formats, comments, VML drawings, web extensions and printer settings; relationships are listed out of ID order; the "Excel Functions" sheet has 537 `<row>`s up to row 550. The same file is at `raw.githubusercontent.com/PHPOffice/PhpSpreadsheet/1.30.1/…` (byte-identical). No spreadsheet application is installed here (no LibreOffice, no openpyxl). | `unzip` listing and `sha256sum` while drafting |
| X5 | Realistic compression ratios are far below 200×: the Excel file's parts are at most 6.2×; the 10,000-row products workbook built by the fixtures (373,690 bytes) has its sheet at 8.5× and its shared strings at 16.6×. It converts to 1,559,458 bytes of JSON Lines in about 0.4 s on Node. | Python `zipfile` listing, Vitest probe while drafting |
| X6 | ECMA-376 Part 1, 18.8.30 lists built-in number format 46 as `[h]:mm:ss`, an elapsed time; 45 is `mm:ss` and 47 `mmss.0`. The spec lists 45-47 as date or time IDs but also says elapsed time stays a number. | ECMA-376 Part 1 §18.8.30 |
| E1 | Plugin storage checks a query's `where` fields against the indexes the plugin declares (`plugins/storage-query.ts:113-127`), so `jobs.query({ where: { sourceUploadId } })` needs `sourceUploadId` in `STORAGE.jobs.indexes`. The physical index is created by `syncDeclaredStorageIndexes` (`CREATE INDEX IF NOT EXISTS`, `plugins/storage-indexes.ts:258-292`) once per process from the scheduler path (`emdash-runtime.ts:1024-1041`), so an existing install gains it without a migration; until then the query is only slower. | source reading |
| E2 | `jobs/create { sourceId }` creates the job through the callback it is given (`jobFromSource(deps, id, options, create)`, `src/plugin/sources.ts`), and `lastImport` records the fetched file's ID and hash. Wrapping that callback converts a fetched workbook with no change to `sources.ts`; the fetch limit comes from `SourceDeps.limits`, so the route passes a copy with `maxBytes` lowered for XLSX templates. | `src/plugin/sources.ts`, `src/plugin/routes.ts` |
| E3 | A job's staged file is released by `releaseUploadIfUnused` (after `jobs/next` and on cancel) when `uploadNeeded(job)` is false, no other job needs the file (`uploadInUse`, a query on `uploadId`) and no source keeps it; the daily purge keeps every surviving job's `uploadId` (`src/plugin/retention.ts`). Neither knew about a second file per job. | `src/plugin/service.ts`, `src/plugin/retention.ts` |
| E4 | The upload route decides acceptance from the `filename` query parameter alone and enforces the limit twice: against `Content-Length` before reading, and in `stageUpload` while streaming (`UploadTooLargeError`). Choosing the limit by extension before either check is enough for `.xlsx`. | `src/astro/upload-route.ts`, `upload-route.test.ts` |
| E5 | JSONata reads a field named `_row` as a path and a boolean field as a filter (`Active` keeps `true` records). | Vitest probe of `compileExpression` while drafting; Task 6 |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart; `crash.test.ts` can then fail its precondition ("Only 1 of 2 kills cut off a jobs/next call in flight"). Known since M3c (its Fact F1); it is not caused by this plan. | M3c plan, Fact F1 |

## Rulings this plan makes

- **Facts that differ from the spec.** (1) Built-in format 46 is `[h]:mm:ss` (X6), an elapsed time, so it stays a number like every elapsed format; the built-in date IDs are 14-22, 45 and 47. (2) The spec's "one workbook saved by a real spreadsheet application" is met with a real file (X4), not replaced: `tests/fixtures/phpspreadsheet/Translations.xlsx`, downloaded from PhpSpreadsheet's 1.30.1 tag, with PhpSpreadsheet's MIT `LICENSE` beside it and its provenance (version, path, SHA-256, saving application) in the doc comment of `excelTranslations()` in `tests/fixtures/xlsx.ts`. The other workbooks are built by the tests from parts that mirror Excel's output. (3) The M3a scanner needs one small addition (X1, `keepBlankText`) and an "optional parent" reading (X2); the spec's "with the M3a XML scanner" holds.
- **Errors.** `XlsxError` (declared in `src/sources/zip.ts`, the first task that needs it) carries every conversion problem. At job creation it, and any `SourceError` from a part's XML, becomes `JobError("invalid_source", message)` without details (no byte offsets: they would be offsets into an inflated part); in `sources/sample` it is `INVALID_SOURCE` (400). Messages, exactly: "The file is not an .xlsx workbook (it is not a zip archive)", "The zip archive is truncated or corrupt" (a file that starts with a local file header but has no end record, a directory or entry past the end), "The file is an encrypted workbook or an old .xls file; save it as an unencrypted .xlsx workbook" (an OLE compound file: Excel's encrypted workbooks and `.xls` both are one), "The workbook is encrypted" (an encrypted zip entry), "ZIP64 archives are not supported", "Zip archives split across several disks are not supported", "The part … uses compression method N; only stored and deflate are supported", "The part … is larger than N bytes", "The part … expands more than 200 times; the file may be a zip bomb", "The part … is larger than it declares", "The part … is corrupt", "The workbook has no part …", "The file is not an Excel workbook (it has no xl/workbook.xml)", "The workbook has no worksheets", "The part … is not valid: <scanner message>", "The workbook has no sheet named "…"; its sheets are "…", …" (at most ten names, then "…"), "The workbook has N worksheets; there is no sheet K", "The workbook has more than 1,000,000 shared strings", "The sheet "…" has no row N", "Header row N of the sheet "…" is empty", "Row N comes after row M; rows must be in order", "A cell in column XFE is past column XFD, the last column Excel has", "Row N is past row 1,048,576, the last row Excel has", "The part … has a row after row N that is not valid XML".
- **Zip details.** Encryption and the compression method are checked when a part is read, so a part nobody reads (printer settings, media) cannot fail a conversion. The first of two entries with one name wins. A part's cap is the smaller of its own (50 MiB for shared strings) and 100 MiB; it is checked against the declared size before reading and the declared size is enforced while inflating (more is "larger than it declares", fewer is "corrupt"). The ratio check divides by `max(compressedSize, 1)`. CRC-32 is not checked (deflate's own framing and the size check catch truncation).
- **Workbook details.** The shared strings and styles parts are found through the workbook relationships by type (`…/sharedStrings`, `…/styles`), falling back to `xl/sharedStrings.xml` and `xl/styles.xml`. Relationship targets resolve against `xl/` (or from the root when they start with `/`); one that climbs out of the archive or is `TargetMode="External"` is ignored. Only worksheets count: chart sheets and dialog sheets are neither listed nor numbered. `sheet` names compare ignoring case (Excel's sheet names are unique ignoring case). `date1904` is on for `1` or `true`. `_xHHHH_` escapes (`_x000D_` for a carriage return; `_x005F_` escapes an underscore) are decoded in shared, inline and formula strings. A shared string item that does not parse is `null`, so cells that use it are unreadable.
- **Cell values.** As in the spec's table, plus: a number cell's text is written as JSON only when it matches JSON's number grammar; otherwise the cell is unreadable. A boolean is `1`/`0` or `true`/`false`. Unreadable (imported as `null` and counted in one warning, "N cells could not be read and were imported as empty"): a shared string index out of range or unparseable, any other boolean text, non-JSON number text, a date serial that is negative, 60 in the 1900 system (29 February 1900, which never existed) or past 9999-12-31, and an unknown `t`. Error cells (`t="e"`) are `null` and not counted. Dates round to the second; a time without a date (serial below 1) carries the epoch day (`1899-12-31T12:00:00` in the 1900 system). `t="d"` text is passed through as written.
- **Rows and headers.** A row's number is its `r`, or the previous row's plus one; rows must increase. A cell's column is its `r`'s letters, or the previous cell's plus one (an unparseable `r` counts as missing). A `<row>` that does not parse fails the conversion (it is malformed XML, not a cell problem). The header ends at its last named column (an unreadable header cell counts as empty); header text is the cell's value as text (a number as written, a date as ISO, a boolean as `true`/`false`), trimmed. Repeats are numbered with the first free `_2`, `_3`, … (so `Price, Price, Price_2` gives `Price, Price_2, Price_2_2`). Rename warnings, exactly: "Column B has no header; it is named "column_B"" and "The header "Price" in column C repeats; it is named "Price_2"". Cells right of the header: "N cells right of the last header column (C) were ignored", counting cells with a value (in rows that are otherwise empty too). Unreadable cells are counted only in the header row and data rows, not in the rows above the header. `_row` comes last in each record and is left out when a header is named `_row`. Sample `paths` are the header names (without `_row`).
- **Limits.** `maxXlsxBytes()` is `min(10 MiB, maxSourceBytes())`, used by the upload route for `.xlsx` (case-insensitive) and at conversion; `.xls`, `.xlsm`, `.xlsb` and `.ods` are refused by extension (415). The converted lines are always buffered in memory and staged with their length (one code path; the local adapter buffers uploads anyway): at most `maxSourceBytes`, and on Workers at most `min(maxSourceBytes, 32 MiB)`, past which the message is "The sheet converts to more than N bytes of JSON Lines, too large to convert on Workers". The workbook is read whole first: "XLSX files are limited to N bytes" (413).
- **URL sources.** `sources/fetch` knows no template, so it fetches up to `maxSourceBytes` as before; `jobs/create { sourceId }` with an XLSX template fetches up to `maxXlsxBytes` (`fetchLimitsFor`). A larger file from an earlier `sources/fetch` that the fetch reuses as unchanged is refused when it is read (`TOO_LARGE`). `lastImport` keeps naming the fetched workbook, so an unchanged feed is still skipped.
- **Job creation.** Only a template whose source block parses and passes `checkSource` with `format: "xlsx"` is converted; anything else goes to `startJob` unchanged, which reports the problem as before. Conversion runs before the rest of the template is checked against the collection, and the converted copy is deleted when creation then fails. Conversion warnings come before the job's own sampling warnings; an XLSX job gets path warnings like JSON Lines (every record has every header key, so in practice only "No records found in the file").
- **File lifecycle.** `uploadInUse` checks `uploadId` and `sourceUploadId`, so a dry run's workbook stays while the dry run may be followed by a real run (as a CSV dry run keeps its file). `releaseUploadIfUnused` releases the job's file and then its workbook, each under the same three conditions, and still returns whether the job's own file was deleted. The daily purge keeps every surviving job's `sourceUploadId` too. `STORAGE.jobs.indexes` gains `sourceUploadId` (E1).
- **Paste.** `sources/paste` with `format: "xlsx"` answers `INVALID_FORMAT` (400, "An XLSX workbook is a binary file and cannot be pasted; upload it instead") in the route handler, before any runtime or storage access.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (108 files; the one Biome info about `recommended` is unchanged) |
| `pnpm test` | 35 files / 899 tests pass (31 files / 781 tests at `675f06d`) |
| Task-by-task replay | A clean worktree at `675f06d`, with each task's steps applied in order by a script that copies these code blocks and applies these replacements (each must match exactly once): every "Run them to see them fail" step failed exactly as written, and after each task `pnpm typecheck`, `pnpm lint` and `pnpm test` passed with the counts in its passing-run step; the result was byte-identical to the prototype |
| Parallel branches | Task 3 replayed alone on `675f06d`, and Tasks 1-2 replayed alone on `675f06d`: the same failing and passing runs, and `pnpm typecheck && pnpm lint && pnpm test` pass on each branch (31 files / 806 tests; 33 files / 829 tests) |
| `pnpm test:integration` | 9 files / 48 tests passed in 503 s (was 8 files / 43 tests); `crash.test.ts -t XLSX` was re-run on its own after its final edit: passed in 122 s |
| `vitest run --config vitest.cf.config.ts -t XLSX` | the new parity test passes (11.7 s test, 38 s with server start); the rest of `pnpm test:cf` was not re-run |
| Probes (Facts Z1, Z2, X4, X5, E5) | `node -e` and Vitest probes; a temporary `probe/deflate` route on `sites/dev-cf`; removed |

## File map

| File | Responsibility |
| --- | --- |
| `src/sources/zip.ts` (new) | `XlsxError`; `ZipArchive`: end record, central directory, capped inflating of stored and deflate entries |
| `src/sources/xml-record.ts`, `src/sources/xml.ts` | `keepBlankText` option (default off) |
| `src/sources/xlsx-workbook.ts` (new) | `WorkbookParts`; `partElements`; workbook, relationships, sheet choice, shared strings, rich text and escapes, date formats and date styles |
| `src/sources/xlsx.ts` (new) | `openXlsx`: rows, cells, values, dates (`excelDate`), header names, JSON Lines records, warnings, row and column limits |
| `src/sources/reader.ts`, `src/sources/readers.ts`, `src/sources/paths.ts`, `src/engine/template.ts` | `xlsx` format, `sheet`/`headerRow`, flat header paths, `_row`, CSV-style column checks; `readerFor` gives the JSON Lines reader |
| `src/engine/types.ts`, `src/engine/jobs.ts` | `Job.sourceUploadId`; `createJob` takes `columns`, `warnings`, `sourceUploadId` |
| `src/astro/config.ts`, `src/astro/upload-route.ts` | `XLSX_MAX_BYTES`, `maxXlsxBytes()`; `.xlsx` uploads with their limit |
| `src/plugin/service.ts`, `src/plugin/retention.ts`, `src/plugin/definition.ts` | Release and keep the workbook with the job; `jobs.sourceUploadId` index |
| `src/plugin/xlsx.ts` (new) | `startImport`, `sampleImport`, `convertXlsx` (read, convert, buffer, stage), `xlsxSource`, `fetchLimitsFor` |
| `src/plugin/routes.ts` | Source block fields, paste refusal, sampling and job creation through `src/plugin/xlsx.ts` |
| `tests/fixtures/zip.ts`, `tests/fixtures/xlsx.ts`, `tests/fixtures/phpspreadsheet/` (new) | Zip writer; Excel-like workbook builder, `productsXlsx`, `xlsxTemplate`; the Excel-saved workbook and its licence |
| `tests/integration/xlsx.test.ts` (new), `tests/integration/crash.test.ts`, `tests/integration/url-sources.test.ts`, `tests/integration/feed-server.ts`, `tests/integration-cf/parity.test.ts` | Node and workerd proofs |

`src/engine/batch.ts`, the CSV, JSON and JSON Lines readers, `src/sources/fetcher.ts`, `src/sources/net.ts` and `src/plugin/sources.ts` do not change.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 1. Zip reader | — | `src/sources/zip.ts`, `tests/fixtures/zip.ts`, `tests/unit/zip.test.ts` | sonnet |
| 2. Workbook model | 1 (`XlsxError`) | `src/sources/xml-record.ts`, `src/sources/xml.ts`, `src/sources/xlsx-workbook.ts`, `tests/unit/xml.test.ts`, `tests/unit/xlsx-workbook.test.ts` | sonnet |
| 3. Template, routes and job plumbing | — | `src/sources/{reader,readers,paths}.ts`, `src/engine/{template,types,jobs}.ts`, `src/astro/{config,upload-route}.ts`, `src/plugin/{service,retention,definition,routes}.ts`, `tests/unit/{readers,paths,template,upload-route,definition,jobs,service,retention}.test.ts` | sonnet |
| 4. Sheet converter | 1 (`ZipArchive`, `XlsxError`, `zip()`), 2 (`readWorkbook`, `chooseSheet`, `readSharedStrings`, `readDateStyles`, `partElements`, `attr`, `richText`, `unescapeText`), 3 (`XLSX_MAX_ROWS`, `XLSX_ROW_FIELD`) | `src/sources/xlsx.ts`, `tests/fixtures/xlsx.ts`, `tests/fixtures/phpspreadsheet/*`, `tests/unit/xlsx.test.ts` | sonnet |
| 5. Conversion at job creation | 3 (`CreateJobInput` fields, `sourceSchema`, `checkSource`, `XLSX_MAX_BYTES`, `maxXlsxBytes`, routes after Task 3), 4 (`openXlsx`, fixtures) | `src/plugin/xlsx.ts`, `src/plugin/routes.ts`, `tests/unit/xlsx-import.test.ts` | sonnet |
| 6. Node integration | 5 (routes), 4 (fixtures) | `tests/integration/{xlsx.test,crash.test,url-sources.test,feed-server}.ts` | sonnet |
| 7. workerd parity | 5 (routes), 4 (fixtures) | `tests/integration-cf/parity.test.ts` | sonnet |
| 8. Review run and note | 1-7 | `docs/superpowers/notes/2026-10-27-m3d-review.md` | opus |

Waves: **1 ∥ 3**, then **2** (needs 1; 3 may still be running), then **4**, then **5**, then **6 ∥ 7** (6 runs dev servers on ports 4395, 4398 and 4399, 7 on 4396, so they do not collide; run them on one machine only if it has the CPU for both, since `crash.test.ts` is timing-sensitive), then **8**. No two tasks of one wave touch the same file. Task 3 adds `XLSX_MAX_ROWS` and `XLSX_ROW_FIELD` to `src/sources/reader.ts` because it is the first task that needs them (the template schema), and Task 4 imports them from there; `XlsxError` lives in Task 1's `zip.ts` for the same reason. Pass counts in each task's "Run them to see them pass" step are for the task's own test files and do not depend on the order; the full-suite totals after each task assume the tasks are merged in numeric order (a task run alone on its dependencies sees fewer files).

---

### Task 1: Zip reader with caps

**Files:**
- Create: `packages/flux-import/src/sources/zip.ts`, `packages/flux-import/tests/fixtures/zip.ts`
- Test: `packages/flux-import/tests/unit/zip.test.ts` (new)

**Interfaces:**
- Consumes: `DecompressionStream("deflate-raw")` (Z1, Z2, Z3); tests: `CompressionStream("deflate-raw")` (Z1).
- Produces (`src/sources/zip.ts`):
  - `class XlsxError extends Error` (`constructor(message: string)`, `name = "XlsxError"`)
  - `interface ZipLimits { maxEntryBytes: number; maxRatio: number }`; `const ZIP_LIMITS: ZipLimits` (100 MiB, 200)
  - `class ZipArchive { static open(bytes: Uint8Array, limits?: ZipLimits): ZipArchive; has(name: string): boolean; open(name: string, maxBytes?: number): ReadableStream<Uint8Array> }`
- Produces (`tests/fixtures/zip.ts`): `interface ZipFile { name: string; data: string | Uint8Array; method?: 0 | 8; declaredMethod?: number; flags?: number; declaredSize?: number }`; `crc32(bytes: Uint8Array): number`; `deflateRaw(bytes: Uint8Array): Promise<Uint8Array>`; `zip(files: ZipFile[]): Promise<Uint8Array<ArrayBuffer>>`; `patchEnd(archive: Uint8Array, field: number, value: number, bytes: 2 | 4): Uint8Array`.

Why first: every later read of a workbook goes through `ZipArchive.open`, and Review Focus 1 lives here.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/fixtures/zip.ts`:
```ts
/**
 * A small zip writer for test fixtures: stored and deflate entries (deflate through
 * `CompressionStream("deflate-raw")`), with fields that tests may falsify to build broken archives.
 */
export interface ZipFile {
	name: string;
	data: string | Uint8Array;
	/** 8 (deflate, the default) or 0 (stored). */
	method?: 0 | 8;
	/** Written as the method instead of `method`, which still decides how the data is stored. */
	declaredMethod?: number;
	/** General purpose flags; bit 0 marks the entry encrypted. */
	flags?: number;
	/** Written as the uncompressed size instead of the real one. */
	declaredSize?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([new Uint8Array(bytes)])
		.stream()
		.pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Builds a zip archive: local headers and data, then the central directory and its end record. */
export async function zip(files: ZipFile[]): Promise<Uint8Array<ArrayBuffer>> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = encoder.encode(file.name);
		const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
		const method = file.method ?? 8;
		const stored = method === 8 ? await deflateRaw(data) : data;
		const fields = {
			flags: file.flags ?? 0,
			method: file.declaredMethod ?? method,
			crc: crc32(data),
			compressed: stored.length,
			size: file.declaredSize ?? data.length,
		};
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, fields.flags, true);
		local.setUint16(8, fields.method, true);
		local.setUint32(14, fields.crc, true);
		local.setUint32(18, fields.compressed, true);
		local.setUint32(22, fields.size, true);
		local.setUint16(26, name.length, true);
		locals.push(new Uint8Array(local.buffer), name, stored);
		const central = new DataView(new ArrayBuffer(46));
		central.setUint32(0, 0x02014b50, true);
		central.setUint16(4, 20, true);
		central.setUint16(6, 20, true);
		central.setUint16(8, fields.flags, true);
		central.setUint16(10, fields.method, true);
		central.setUint32(16, fields.crc, true);
		central.setUint32(20, fields.compressed, true);
		central.setUint32(24, fields.size, true);
		central.setUint16(28, name.length, true);
		central.setUint32(42, offset, true);
		centrals.push(new Uint8Array(central.buffer), name);
		offset += 30 + name.length + stored.length;
	}
	const directory = concat(centrals);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, directory.length, true);
	end.setUint32(16, offset, true);
	return concat([...locals, directory, new Uint8Array(end.buffer)]);
}

/** Overwrites a little-endian field of the end-of-central-directory record (the last 22 bytes). */
export function patchEnd(archive: Uint8Array, field: number, value: number, bytes: 2 | 4) {
	const out = new Uint8Array(archive);
	const view = new DataView(out.buffer);
	const at = out.length - 22 + field;
	if (bytes === 2) view.setUint16(at, value, true);
	else view.setUint32(at, value, true);
	return out;
}
```

Create `packages/flux-import/tests/unit/zip.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { XlsxError, ZipArchive } from "../../src/sources/zip.js";
import { patchEnd, zip } from "../fixtures/zip.js";

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

async function failure(run: () => unknown): Promise<XlsxError> {
	const error = await (async () => run())().then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(XlsxError);
	return error as XlsxError;
}

describe("ZipArchive", () => {
	it("reads stored and deflate entries by exact name", async () => {
		// Over 64 KiB, so it arrives in several chunks; distinct rows keep the ratio realistic.
		const big = Array.from({ length: 10_000 }, (_, i) => `<row r="${i + 1}"/>`).join("");
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{ name: "xl/stored.xml", data: "stored ț", method: 0 },
				{ name: "xl/big.xml", data: big },
			]),
		);
		expect(await text(archive.open("xl/workbook.xml"))).toBe("<workbook/>");
		expect(await text(archive.open("xl/stored.xml"))).toBe("stored ț");
		expect(await text(archive.open("xl/big.xml"))).toBe(big);
		expect(archive.has("xl/workbook.xml")).toBe(true);
		expect(archive.has("XL/workbook.xml")).toBe(false);
		expect((await failure(() => archive.open("xl/missing.xml"))).message).toBe(
			"The workbook has no part xl/missing.xml",
		);
	});

	it("matches names after turning backslashes into slashes and ignores escaping names", async () => {
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl\\worksheets\\sheet1.xml", data: "one" },
				{ name: "../xl/evil.xml", data: "evil" },
				{ name: "xl/../../evil.xml", data: "evil" },
				{ name: "/xl/abs.xml", data: "abs" },
				{ name: "xl/dup.xml", data: "first" },
				{ name: "xl/dup.xml", data: "second" },
			]),
		);
		expect(await text(archive.open("xl/worksheets/sheet1.xml"))).toBe("one");
		for (const name of ["../xl/evil.xml", "xl/../../evil.xml", "/xl/abs.xml", "xl/abs.xml"]) {
			expect(archive.has(name)).toBe(false);
		}
		expect(await text(archive.open("xl/dup.xml"))).toBe("first");
	});

	it("refuses files that are not zip archives, or are encrypted workbooks or .xls files", async () => {
		expect(
			(await failure(() => ZipArchive.open(new TextEncoder().encode("a,b\n1,2\n")))).message,
		).toBe("The file is not an .xlsx workbook (it is not a zip archive)");
		expect((await failure(() => ZipArchive.open(new Uint8Array(0)))).message).toBe(
			"The file is not an .xlsx workbook (it is not a zip archive)",
		);
		const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
		expect((await failure(() => ZipArchive.open(cfb))).message).toBe(
			"The file is an encrypted workbook or an old .xls file; save it as an unencrypted .xlsx workbook",
		);
	});

	it("refuses truncated archives", async () => {
		const whole = await zip([{ name: "xl/workbook.xml", data: "<workbook/>".repeat(100) }]);
		for (const cut of [whole.length - 1, whole.length - 30, 40]) {
			expect((await failure(() => ZipArchive.open(whole.subarray(0, cut)))).message).toBe(
				"The zip archive is truncated or corrupt",
			);
		}
	});

	it("refuses encrypted entries and unsupported compression methods when they are read", async () => {
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl/workbook.xml", data: "<workbook/>", flags: 1 },
				{ name: "xl/lzma.xml", data: "x", method: 0, declaredMethod: 14 },
				{ name: "xl/other.xml", data: "fine" },
			]),
		);
		expect((await failure(() => archive.open("xl/workbook.xml"))).message).toBe(
			"The workbook is encrypted",
		);
		expect((await failure(() => archive.open("xl/lzma.xml"))).message).toBe(
			"The part xl/lzma.xml uses compression method 14; only stored and deflate are supported",
		);
		expect(await text(archive.open("xl/other.xml"))).toBe("fine");
	});

	it("refuses ZIP64 and multi-disk archives", async () => {
		const archive = await zip([{ name: "xl/workbook.xml", data: "<workbook/>" }]);
		for (const zip64 of [
			patchEnd(patchEnd(archive, 8, 0xffff, 2), 10, 0xffff, 2),
			patchEnd(archive, 16, 0xffffffff, 4),
		]) {
			expect((await failure(() => ZipArchive.open(zip64))).message).toBe(
				"ZIP64 archives are not supported",
			);
		}
		// A ZIP64 end-of-directory locator right before the end record.
		const locator = new Uint8Array(20);
		new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
		const withLocator = new Uint8Array(archive.length + 20);
		withLocator.set(archive.subarray(0, archive.length - 22));
		withLocator.set(locator, archive.length - 22);
		withLocator.set(archive.subarray(archive.length - 22), archive.length - 2);
		expect((await failure(() => ZipArchive.open(withLocator))).message).toBe(
			"ZIP64 archives are not supported",
		);
		for (const split of [patchEnd(archive, 4, 1, 2), patchEnd(archive, 6, 1, 2)]) {
			expect((await failure(() => ZipArchive.open(split))).message).toBe(
				"Zip archives split across several disks are not supported",
			);
		}
	});

	it("stops a zip bomb at the declared size while inflating, and refuses a high ratio up front", async () => {
		const bomb = "a".repeat(1_000_000);
		// Declares 1,000 bytes but inflates to a million: reading stops after the first chunk.
		const lying = ZipArchive.open(
			await zip([{ name: "xl/worksheets/sheet1.xml", data: bomb, declaredSize: 1000 }]),
		);
		expect((await failure(() => text(lying.open("xl/worksheets/sheet1.xml")))).message).toBe(
			"The part xl/worksheets/sheet1.xml is larger than it declares",
		);
		// Declares its real size, 1,000,000 bytes from about 1 KB: over 200 times.
		const honest = ZipArchive.open(await zip([{ name: "xl/sharedStrings.xml", data: bomb }]));
		expect((await failure(() => honest.open("xl/sharedStrings.xml"))).message).toBe(
			"The part xl/sharedStrings.xml expands more than 200 times; the file may be a zip bomb",
		);
	});

	it("refuses an entry over its cap before reading it", async () => {
		const archive = ZipArchive.open(
			await zip([{ name: "xl/a.xml", data: "x".repeat(100), method: 0 }]),
			{
				maxEntryBytes: 99,
				maxRatio: 200,
			},
		);
		expect((await failure(() => archive.open("xl/a.xml"))).message).toBe(
			"The part xl/a.xml is larger than 99 bytes",
		);
		const capped = ZipArchive.open(
			await zip([{ name: "xl/a.xml", data: "x".repeat(100), method: 0 }]),
		);
		expect((await failure(() => capped.open("xl/a.xml", 50))).message).toBe(
			"The part xl/a.xml is larger than 50 bytes",
		);
		expect(await text(capped.open("xl/a.xml", 100))).toBe("x".repeat(100));
	});

	it("reports corrupt deflate data while reading", async () => {
		const archive = await zip([{ name: "xl/workbook.xml", data: "<workbook>".repeat(50) }]);
		// The deflate data starts after the 30-byte local header and the 15-byte name.
		const broken = new Uint8Array(archive);
		broken.fill(0xff, 45, 55);
		const opened = ZipArchive.open(broken);
		expect((await failure(() => text(opened.open("xl/workbook.xml")))).message).toBe(
			"The part xl/workbook.xml is corrupt",
		);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/zip.test.ts`
Expected: FAIL — `zip.test.ts` cannot load `../../src/sources/zip.js` ("Cannot find module"; no tests run).

- [ ] **Step 3: Implement the reader**

Create `packages/flux-import/src/sources/zip.ts`:
```ts
const MIB = 1024 * 1024;

/** A workbook that cannot be converted: it fails job creation with `invalid_source`. */
export class XlsxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "XlsxError";
	}
}

export interface ZipLimits {
	/** Largest uncompressed size of any entry. */
	maxEntryBytes: number;
	/** Largest uncompressed size as a multiple of the compressed size. */
	maxRatio: number;
}

export const ZIP_LIMITS: ZipLimits = { maxEntryBytes: 100 * MIB, maxRatio: 200 };

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const COMMENT_MAX = 0xffff;
const STORED = 0;
const DEFLATED = 8;
/** Traditional (bit 0) and strong (bit 6) encryption. */
const ENCRYPTED = 0x41;
/** An OLE compound file: an encrypted workbook or an old .xls file. */
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const CHUNK = 64 * 1024;

interface Entry {
	method: number;
	flags: number;
	compressedSize: number;
	size: number;
	localOffset: number;
}

const names = new TextDecoder("utf-8");

/** An entry name as used for lookups, or null for names that could escape the archive. */
function normalName(raw: string): string | null {
	const name = raw.replace(/\\/g, "/");
	if (name.startsWith("/") || name.split("/").includes("..")) return null;
	return name;
}

/**
 * The directory of a zip archive held in memory, with entries inflated on demand. Supported:
 * stored and deflate entries, no encryption, no ZIP64, one disk. Every entry is read under a cap
 * on its uncompressed size that is enforced while inflating.
 */
export class ZipArchive {
	private constructor(
		private readonly bytes: Uint8Array,
		private readonly entries: Map<string, Entry>,
		private readonly limits: ZipLimits,
	) {}

	static open(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ZipArchive {
		if (CFB.every((b, i) => bytes[i] === b)) {
			throw new XlsxError(
				"The file is an encrypted workbook or an old .xls file; save it as an unencrypted .xlsx workbook",
			);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const eocd = findEndOfDirectory(view);
		if (eocd < 0) {
			// A zip that lost its end still starts with a local file header.
			throw new XlsxError(
				bytes.length >= 4 && view.getUint32(0, true) === LOCAL
					? "The zip archive is truncated or corrupt"
					: "The file is not an .xlsx workbook (it is not a zip archive)",
			);
		}
		const disk = view.getUint16(eocd + 4, true);
		const directoryDisk = view.getUint16(eocd + 6, true);
		const entriesHere = view.getUint16(eocd + 8, true);
		const count = view.getUint16(eocd + 10, true);
		const directorySize = view.getUint32(eocd + 12, true);
		const directoryOffset = view.getUint32(eocd + 16, true);
		if (
			(eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) ||
			count === 0xffff ||
			directorySize === 0xffffffff ||
			directoryOffset === 0xffffffff
		) {
			throw new XlsxError("ZIP64 archives are not supported");
		}
		if (disk !== 0 || directoryDisk !== 0 || entriesHere !== count) {
			throw new XlsxError("Zip archives split across several disks are not supported");
		}
		if (directoryOffset + directorySize > eocd) {
			throw new XlsxError("The zip archive is truncated or corrupt");
		}
		const entries = new Map<string, Entry>();
		let at = directoryOffset;
		for (let i = 0; i < count; i++) {
			if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL) {
				throw new XlsxError("The zip archive is truncated or corrupt");
			}
			const nameLength = view.getUint16(at + 28, true);
			const extraLength = view.getUint16(at + 30, true);
			const commentLength = view.getUint16(at + 32, true);
			const entry: Entry = {
				flags: view.getUint16(at + 8, true),
				method: view.getUint16(at + 10, true),
				compressedSize: view.getUint32(at + 20, true),
				size: view.getUint32(at + 24, true),
				localOffset: view.getUint32(at + 42, true),
			};
			if (
				entry.compressedSize === 0xffffffff ||
				entry.size === 0xffffffff ||
				entry.localOffset === 0xffffffff
			) {
				throw new XlsxError("ZIP64 archives are not supported");
			}
			if (at + 46 + nameLength > eocd) {
				throw new XlsxError("The zip archive is truncated or corrupt");
			}
			const name = normalName(names.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
			if (name !== null && !entries.has(name)) entries.set(name, entry);
			at += 46 + nameLength + extraLength + commentLength;
		}
		return new ZipArchive(bytes, entries, limits);
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	/**
	 * The entry's uncompressed bytes as a stream. Fails before reading when the entry is
	 * encrypted, uses another compression method, or declares more than `maxBytes` (at most the
	 * archive's entry limit) or more than the ratio limit allows; fails while reading once more
	 * bytes arrive than it declared.
	 */
	open(name: string, maxBytes = this.limits.maxEntryBytes): ReadableStream<Uint8Array> {
		const entry = this.entries.get(name);
		if (!entry) throw new XlsxError(`The workbook has no part ${name}`);
		if (entry.flags & ENCRYPTED) throw new XlsxError("The workbook is encrypted");
		if (entry.method !== STORED && entry.method !== DEFLATED) {
			throw new XlsxError(
				`The part ${name} uses compression method ${entry.method}; only stored and deflate are supported`,
			);
		}
		const cap = Math.min(maxBytes, this.limits.maxEntryBytes);
		if (entry.size > cap) throw new XlsxError(`The part ${name} is larger than ${cap} bytes`);
		if (entry.size > this.limits.maxRatio * Math.max(entry.compressedSize, 1)) {
			throw new XlsxError(
				`The part ${name} expands more than ${this.limits.maxRatio} times; the file may be a zip bomb`,
			);
		}
		const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
		const local = entry.localOffset;
		if (local + 30 > this.bytes.length || view.getUint32(local, true) !== LOCAL) {
			throw new XlsxError("The zip archive is truncated or corrupt");
		}
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const end = start + entry.compressedSize;
		if (end > this.bytes.length) throw new XlsxError("The zip archive is truncated or corrupt");
		const data = this.bytes.subarray(start, end);
		let sent = 0;
		const raw = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull(controller) {
				if (sent >= data.length) {
					controller.close();
					return;
				}
				controller.enqueue(data.slice(sent, sent + CHUNK));
				sent += CHUNK;
			},
		});
		const reader = (
			entry.method === DEFLATED
				? (raw as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream("deflate-raw"))
				: raw
		).getReader();
		let count = 0;
		return new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					let chunk: ReadableStreamReadResult<Uint8Array>;
					try {
						chunk = await reader.read();
					} catch {
						throw new XlsxError(`The part ${name} is corrupt`);
					}
					if (chunk.done) {
						if (count !== entry.size) throw new XlsxError(`The part ${name} is corrupt`);
						controller.close();
						return;
					}
					count += chunk.value.length;
					if (count > entry.size) {
						await reader.cancel().catch(() => {});
						throw new XlsxError(`The part ${name} is larger than it declares`);
					}
					controller.enqueue(chunk.value);
				},
				async cancel(reason) {
					await reader.cancel(reason).catch(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
	}
}

/** The offset of the end-of-central-directory record, searched backwards past any comment. */
function findEndOfDirectory(view: DataView): number {
	const last = view.byteLength - EOCD_SIZE;
	for (let at = last; at >= 0 && at >= last - COMMENT_MAX; at--) {
		if (view.getUint32(at, true) !== EOCD) continue;
		if (at + EOCD_SIZE + view.getUint16(at + 20, true) === view.byteLength) return at;
	}
	return -1;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/zip.test.ts`
Expected: PASS (9 tests in `zip.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 32 files / 790 tests, from 31 / 781 at `675f06d`).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/zip.ts packages/flux-import/tests/fixtures/zip.ts packages/flux-import/tests/unit/zip.test.ts
git commit -m "Read zip archives in memory with stored and deflate entries, refusing ZIP64, encryption and zip bombs"
```

### Task 2: Workbook model: workbook, relationships, shared strings, styles and date formats

**Files:**
- Create: `packages/flux-import/src/sources/xlsx-workbook.ts`
- Modify: `packages/flux-import/src/sources/xml-record.ts`, `packages/flux-import/src/sources/xml.ts`
- Test: `packages/flux-import/tests/unit/xlsx-workbook.test.ts` (new), `packages/flux-import/tests/unit/xml.test.ts`

**Interfaces:**
- Consumes: Task 1 (`XlsxError`); `xmlReader`, `parseXmlRecordText`, `SourceError`, `shortName` (M3a, X1, X2, X3); tests: `streamOf` (`tests/unit/helpers.ts`).
- Produces (`src/sources/xml-record.ts`, `src/sources/xml.ts`): `parseXmlRecordText(xml: string, keepBlankText = false): unknown`; `parseXmlRecord(bytes: Uint8Array, keepBlankText = false)`; `xmlReader(records: string, keepBlankText = false): RecordReader`.
- Produces (`src/sources/xlsx-workbook.ts`):
  - `const SHARED_STRINGS_MAX = 1_000_000`; `const SHARED_STRINGS_MAX_BYTES = 50 * MIB`
  - `interface WorkbookParts { has(name: string): boolean; open(name: string, maxBytes?: number): ReadableStream<Uint8Array> }` (`ZipArchive` satisfies it)
  - `interface SheetRef { name: string; part: string }`; `interface Workbook { sheets: SheetRef[]; date1904: boolean; sharedStrings?: string; styles?: string }`; `type XmlElement = Record<string, unknown>`
  - `attr(element: XmlElement, name: string): string | undefined`
  - `partElements(parts: WorkbookParts, part: string, path: string, options?: { optional?: boolean; maxBytes?: number }): AsyncGenerator<XmlElement | null>`
  - `unescapeText(text: string): string`; `richText(item: unknown): string`
  - `readWorkbook(parts: WorkbookParts): Promise<Workbook>`; `chooseSheet(workbook: Workbook, sheet?: string | number): SheetRef`
  - `readSharedStrings(parts: WorkbookParts, part: string, maxStrings?: number): Promise<(string | null)[]>`
  - `isDateFormat(code: string): boolean`; `readDateStyles(parts: WorkbookParts, part: string): Promise<boolean[]>`

The tests feed parts as text through a small `WorkbookParts` fake, so this task needs no zip archive; the parts copy Excel's real output (X4): CRLF after the declaration, `mc:Ignorable`, `mc:AlternateContent`, sheet IDs out of order, relationships out of ID order, `x14ac:knownFonts`, `xml:space="preserve"`, rich text runs with `rPr`, phonetic runs.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/xml.test.ts`, replace
```ts
		expect(parseXmlRecordText("<item>a\r\n<b>x</b>c</item>")).toEqual({ b: "x", "#text": "a\nc" });
	});
});
```
with:
```ts
		expect(parseXmlRecordText("<item>a\r\n<b>x</b>c</item>")).toEqual({ b: "x", "#text": "a\nc" });
	});
	it("keeps whitespace-only text beside attributes only when asked", async () => {
		const xml = '<row r="1"><t xml:space="preserve"> </t><v> </v></row>';
		expect(parseXmlRecordText(xml)).toEqual({ "@r": "1", t: { "@xml:space": "preserve" }, v: " " });
		expect(parseXmlRecordText(xml, true)).toEqual({
			"@r": "1",
			t: { "@xml:space": "preserve", "#text": " " },
			v: " ",
		});
		const doc = `<sheetData>${xml}</sheetData>`;
		expect(values(await readAll(xmlReader("sheetData/row"), doc))).toEqual([
			{ "@r": "1", t: { "@xml:space": "preserve" }, v: " " },
		]);
		expect(values(await readAll(xmlReader("sheetData/row", true), doc))).toEqual([
			{ "@r": "1", t: { "@xml:space": "preserve", "#text": " " }, v: " " },
		]);
	});
});
```

Create `packages/flux-import/tests/unit/xlsx-workbook.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	chooseSheet,
	isDateFormat,
	readDateStyles,
	readSharedStrings,
	readWorkbook,
	richText,
	type Workbook,
	type WorkbookParts,
} from "../../src/sources/xlsx-workbook.js";
import { parseXmlRecordText } from "../../src/sources/xml-record.js";
import { XlsxError } from "../../src/sources/zip.js";
import { streamOf } from "./helpers.js";

/** Parts held as text, read in 7-byte chunks. */
class Parts implements WorkbookParts {
	constructor(private readonly files: Record<string, string>) {}
	has(name: string) {
		return Object.hasOwn(this.files, name);
	}
	open(name: string) {
		const text = this.files[name];
		if (text === undefined) throw new XlsxError(`The workbook has no part ${name}`);
		return streamOf(text, 7);
	}
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** As Excel writes it: markup compatibility, an absolute path, and sheet IDs out of order. */
function workbookXml(sheets: string, workbookPr = '<workbookPr defaultThemeVersion="166925"/>') {
	return (
		`${DECL}<workbook ${NS} ${R_NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">` +
		'<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="25929"/>' +
		workbookPr +
		'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Data\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent>' +
		'<bookViews><workbookView xWindow="672" yWindow="780" windowWidth="22368" windowHeight="13620"/></bookViews>' +
		`<sheets>${sheets}</sheets><calcPr calcId="191029"/></workbook>`
	);
}

/** Relationships in Excel's order (not by ID). */
const RELS =
	`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
	`<Relationship Id="rId3" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
	`<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
	`<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
	`<Relationship Id="rId6" Type="${REL}/chartsheet" Target="chartsheets/sheet1.xml"/>` +
	`<Relationship Id="rId7" Type="${REL}/worksheet" Target="/xl/worksheets/sheet3.xml"/>` +
	`<Relationship Id="rId8" Type="${REL}/worksheet" Target="../../outside.xml"/>` +
	`<Relationship Id="rId9" Type="${REL}/worksheet" Target="https://example.com/x.xml" TargetMode="External"/>` +
	`<Relationship Id="rId5" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
	`<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/>` +
	"</Relationships>";

const SHEETS =
	'<sheet name="Products" sheetId="4" r:id="rId1"/>' +
	'<sheet name="Prices 2026" sheetId="3" r:id="rId2"/>' +
	'<sheet name="Chart" sheetId="5" r:id="rId6"/>' +
	'<sheet name="Absolute" sheetId="6" r:id="rId7"/>' +
	'<sheet name="Outside" sheetId="7" r:id="rId8"/>' +
	'<sheet name="External" sheetId="8" r:id="rId9"/>';

async function failure(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(XlsxError);
	return (error as XlsxError).message;
}

describe("readWorkbook", () => {
	it("lists worksheets in workbook order through the relationships", async () => {
		const workbook = await readWorkbook(
			new Parts({
				"xl/workbook.xml": workbookXml(SHEETS),
				"xl/_rels/workbook.xml.rels": RELS,
			}),
		);
		expect(workbook).toEqual({
			sheets: [
				{ name: "Products", part: "xl/worksheets/sheet1.xml" },
				{ name: "Prices 2026", part: "xl/worksheets/sheet2.xml" },
				{ name: "Absolute", part: "xl/worksheets/sheet3.xml" },
			],
			date1904: false,
			sharedStrings: "xl/sharedStrings.xml",
			styles: "xl/styles.xml",
		});
	});

	it("reads the 1904 date system", async () => {
		const read = (pr: string) =>
			readWorkbook(
				new Parts({
					"xl/workbook.xml": workbookXml(SHEETS, pr),
					"xl/_rels/workbook.xml.rels": RELS,
				}),
			);
		expect((await read('<workbookPr date1904="1"/>')).date1904).toBe(true);
		expect((await read('<workbookPr date1904="true"/>')).date1904).toBe(true);
		expect((await read('<workbookPr date1904="0"/>')).date1904).toBe(false);
		expect((await read("")).date1904).toBe(false);
	});

	it("falls back to the usual part names without a relationship for them", async () => {
		const rels = `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
		const parts = (extra: Record<string, string>) =>
			new Parts({
				"xl/workbook.xml": workbookXml('<sheet name="Only" sheetId="1" r:id="rId1"/>'),
				"xl/_rels/workbook.xml.rels": rels,
				...extra,
			});
		expect(await readWorkbook(parts({}))).toEqual({
			sheets: [{ name: "Only", part: "xl/worksheets/sheet1.xml" }],
			date1904: false,
		});
		expect(
			await readWorkbook(parts({ "xl/sharedStrings.xml": "<sst/>", "xl/styles.xml": "<x/>" })),
		).toMatchObject({ sharedStrings: "xl/sharedStrings.xml", styles: "xl/styles.xml" });
	});

	it("refuses an archive that is not a workbook or has no worksheets", async () => {
		expect(await failure(readWorkbook(new Parts({ "word/document.xml": "<w/>" })))).toBe(
			"The file is not an Excel workbook (it has no xl/workbook.xml)",
		);
		expect(
			await failure(
				readWorkbook(
					new Parts({
						"xl/workbook.xml": workbookXml('<sheet name="Chart" sheetId="1" r:id="rId6"/>'),
						"xl/_rels/workbook.xml.rels": RELS,
					}),
				),
			),
		).toBe("The workbook has no worksheets");
		expect(
			await failure(
				readWorkbook(new Parts({ "xl/workbook.xml": `${DECL}<x:workbook xmlns:x="ns"/>` })),
			),
		).toBe(
			"The part xl/workbook.xml is not valid: The root element is <x:workbook>, not <workbook>",
		);
		expect(
			await failure(readWorkbook(new Parts({ "xl/workbook.xml": "<workbook><sheets>" }))),
		).toBe("The part xl/workbook.xml is not valid: Unterminated element <sheets>");
	});
});

describe("chooseSheet", () => {
	const workbook: Workbook = {
		sheets: [
			{ name: "Products", part: "xl/worksheets/sheet1.xml" },
			{ name: "Prices 2026", part: "xl/worksheets/sheet2.xml" },
		],
		date1904: false,
	};

	it("picks the first sheet, a sheet by name ignoring case, or by its 1-based position", () => {
		expect(chooseSheet(workbook).name).toBe("Products");
		expect(chooseSheet(workbook, "prices 2026").part).toBe("xl/worksheets/sheet2.xml");
		expect(chooseSheet(workbook, 2).name).toBe("Prices 2026");
	});

	it("names the sheets when the one asked for does not exist", () => {
		expect(() => chooseSheet(workbook, "Stock")).toThrow(
			new XlsxError(
				'The workbook has no sheet named "Stock"; its sheets are "Products", "Prices 2026"',
			),
		);
		expect(() => chooseSheet(workbook, 3)).toThrow(
			new XlsxError("The workbook has 2 worksheets; there is no sheet 3"),
		);
	});
});

describe("readSharedStrings", () => {
	const sst = (items: string) =>
		new Parts({
			"xl/sharedStrings.xml": `${DECL}<sst ${NS} count="9" uniqueCount="9">${items}</sst>`,
		});

	it("reads plain, rich, phonetic, whitespace and escaped strings in order", async () => {
		const strings = await readSharedStrings(
			sst(
				"<si><t>Unit Price</t></si>" +
					'<si><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t>Bold</t></r><r><rPr><sz val="11"/></rPr><t xml:space="preserve"> and plain</t></r></si>' +
					'<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>' +
					'<si><t xml:space="preserve">  </t></si>' +
					"<si><t/></si>" +
					"<si><t>Line one_x000D_\nline two</t></si>" +
					"<si><t>_x005F_x0041_ stays</t></si>" +
					"<si><t>Fish &amp; chips &lt;3</t></si>",
			),
			"xl/sharedStrings.xml",
		);
		expect(strings).toEqual([
			"Unit Price",
			"Bold and plain",
			"東京",
			"  ",
			"",
			"Line one\r\nline two",
			"_x0041_ stays",
			"Fish & chips <3",
		]);
	});

	it("gives null for a string item that does not parse", async () => {
		expect(
			await readSharedStrings(
				sst("<si><t>ok</t></si><si><t>&nbsp;</t></si>"),
				"xl/sharedStrings.xml",
			),
		).toEqual(["ok", null]);
	});

	it("refuses more strings than the limit", async () => {
		expect(
			await failure(
				readSharedStrings(
					sst("<si><t>a</t></si><si><t>b</t></si><si><t>c</t></si>"),
					"xl/sharedStrings.xml",
					2,
				),
			),
		).toBe("The workbook has more than 2 shared strings");
	});
});

describe("richText", () => {
	it("reads inline strings as the XML reader parses them", () => {
		const cell = parseXmlRecordText(
			'<c r="A1" t="inlineStr"><is><r><t>In</t></r><r><t xml:space="preserve">line </t></r></is></c>',
			true,
		) as Record<string, unknown>;
		expect(richText(cell.is)).toBe("Inline ");
		expect(richText("plain")).toBe("plain");
		expect(richText(undefined)).toBe("");
	});
});

describe("isDateFormat", () => {
	it.each([
		"yyyy-mm-dd",
		"yyyy\\-mm\\-dd;@",
		"d/m/yyyy",
		"[$-409]mmmm d, yyyy;@",
		"[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy",
		"h:mm AM/PM",
		"hh:mm:ss",
		"[Red]dd/mm/yy",
		"DD.MM.YYYY",
		'yyyy "year"',
	])("%s is a date", (code) => {
		expect(isDateFormat(code)).toBe(true);
	});

	it.each([
		"General",
		"0.00",
		"#,##0",
		"0%",
		"0.00E+00",
		'#,##0.00\\ "€"',
		'_-* #,##0.00\\ [$€-1]_-;\\-* #,##0.00\\ [$€-1]_-;_-* "-"??\\ [$€-1]_-;_-@_-',
		'0 "days"',
		'"Due: "0',
		"0.0\\m",
		"[h]:mm",
		"[hh]:mm:ss",
		"[mm]:ss",
		"[ss].0",
		"[Red]0.00;[Blue]-0.00",
		"@",
	])("%s is not a date", (code) => {
		expect(isDateFormat(code)).toBe(false);
	});
});

describe("readDateStyles", () => {
	it("maps cell styles to built-in and custom date formats", async () => {
		const styles =
			`${DECL}<styleSheet ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
			'<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd;@"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="166" formatCode="[h]:mm"/><numFmt numFmtId="14" formatCode="0.00"/></numFmts>' +
			'<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
			'<cellStyleXfs count="1"><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
			'<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="46" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="left"/></xf></cellXfs>' +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
		expect(await readDateStyles(new Parts({ "xl/styles.xml": styles }), "xl/styles.xml")).toEqual([
			false,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("has no date styles when the styles part has no cellXfs", async () => {
		const parts = new Parts({ "xl/styles.xml": `${DECL}<styleSheet ${NS}><fonts/></styleSheet>` });
		expect(await readDateStyles(parts, "xl/styles.xml")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xml.test.ts tests/unit/xlsx-workbook.test.ts`
Expected: FAIL — `xlsx-workbook.test.ts` cannot load `../../src/sources/xlsx-workbook.js`, and in `xml.test.ts` "keeps whitespace-only text beside attributes only when asked" fails (1 failed, 62 passed): without the flag `parseXmlRecordText` takes no second argument and drops the `#text`.

- [ ] **Step 3: Implement the workbook model**

In `packages/flux-import/src/sources/xml-record.ts`, replace
```ts
/**
 * An element without attributes or child elements is its text; otherwise an object with
 * `@attributes`, child elements (repeats as arrays) and `#text` when the text is not blank.
 * The record element is always an object. Keys are own properties (`Object.fromEntries`).
 */
function finish(frame: Frame, isRecord: boolean): unknown {
	const text = frame.text.join("");
	if (!isRecord && frame.attrs.length === 0 && frame.children.size === 0) return text;
```
with:
```ts
/**
 * An element without attributes or child elements is its text; otherwise an object with
 * `@attributes`, child elements (repeats as arrays) and `#text` when the text is not blank (with
 * `keepBlankText`, when it is not empty). The record element is always an object. Keys are own
 * properties (`Object.fromEntries`).
 */
function finish(frame: Frame, isRecord: boolean, keepBlankText: boolean): unknown {
	const text = frame.text.join("");
	if (!isRecord && frame.attrs.length === 0 && frame.children.size === 0) return text;
```

then replace
```ts
		entries.push([name, values.length === 1 ? values[0] : values]);
	}
	if (NOT_BLANK.test(text)) entries.push(["#text", text]);
	return Object.fromEntries(entries);
}

/** Parses one record element (comments and processing instructions ignored, CDATA as text). */
export function parseXmlRecordText(xml: string): unknown {
	const src = xml.replace(/\r\n?/g, "\n");
	const stack: Frame[] = [];
```
with:
```ts
		entries.push([name, values.length === 1 ? values[0] : values]);
	}
	if (keepBlankText ? text !== "" : NOT_BLANK.test(text)) entries.push(["#text", text]);
	return Object.fromEntries(entries);
}

/**
 * Parses one record element (comments and processing instructions ignored, CDATA as text).
 * `keepBlankText` keeps whitespace-only text, as in `<t xml:space="preserve"> </t>`.
 */
export function parseXmlRecordText(xml: string, keepBlankText = false): unknown {
	const src = xml.replace(/\r\n?/g, "\n");
	const stack: Frame[] = [];
```

then replace
```ts
	};
	const close = (frame: Frame) => {
		const value = finish(frame, stack.length === 0);
		const parent = stack.at(-1);
		if (!parent) return value;
```
with:
```ts
	};
	const close = (frame: Frame) => {
		const value = finish(frame, stack.length === 0, keepBlankText);
		const parent = stack.at(-1);
		if (!parent) return value;
```

then replace
```ts
				i += 2;
				if (stack.length === 0) {
					const value = finish(frame, true);
					if (NOT_BLANK.test(src.slice(i))) fail("Content after the record element");
					return value;
```
with:
```ts
				i += 2;
				if (stack.length === 0) {
					const value = finish(frame, true, keepBlankText);
					if (NOT_BLANK.test(src.slice(i))) fail("Content after the record element");
					return value;
```

then replace
```ts

/** Parses one record's bytes; a parse failure is the record's problem, not the job's. */
export function parseXmlRecord(bytes: Uint8Array): Pick<SourceRecord, "value" | "error"> {
	const text = decodeUtf8(bytes);
	if (text === null) {
```
with:
```ts

/** Parses one record's bytes; a parse failure is the record's problem, not the job's. */
export function parseXmlRecord(
	bytes: Uint8Array,
	keepBlankText = false,
): Pick<SourceRecord, "value" | "error"> {
	const text = decodeUtf8(bytes);
	if (text === null) {
```

then replace
```ts
	}
	try {
		return { value: parseXmlRecordText(text) };
	} catch (e) {
		if (!(e instanceof XmlRecordError)) throw e;
```
with:
```ts
	}
	try {
		return { value: parseXmlRecordText(text, keepBlankText) };
	} catch (e) {
		if (!(e instanceof XmlRecordError)) throw e;
```

In `packages/flux-import/src/sources/xml.ts`, replace
```ts
		startSeq: number,
		private readonly stopAtBody: boolean,
	) {
		this.parents = path.length - 1;
```
with:
```ts
		startSeq: number,
		private readonly stopAtBody: boolean,
		private readonly keepBlankText = false,
	) {
		this.parents = path.length - 1;
```

then replace
```ts

	private emit(end: number): void {
		const parsed = parseXmlRecord(this.record.bytes());
		this.record.clear();
		this.out.push({ seq: this.seq++, start: this.recordStart, end, ...parsed });
```
with:
```ts

	private emit(end: number): void {
		const parsed = parseXmlRecord(this.record.bytes(), this.keepBlankText);
		this.record.clear();
		this.out.push({ seq: this.seq++, start: this.recordStart, end, ...parsed });
```

then replace
```ts
}

/** XML: the elements at the `/` path `records` ("feed/item"). */
export function xmlReader(records: string): RecordReader {
	const path = records.split("/");
	const reader: RecordReader = {
```
with:
```ts
}

/**
 * XML: the elements at the `/` path `records` ("feed/item"). `keepBlankText` keeps
 * whitespace-only text in elements that have attributes (XLSX cells and strings).
 */
export function xmlReader(records: string, keepBlankText = false): RecordReader {
	const path = records.split("/");
	const reader: RecordReader = {
```

then replace
```ts
		},
		read: (stream, { startOffset, startSeq }) =>
			runScanner(stream, startOffset, new XmlScanner(path, startOffset, startSeq, false)),
		sample: (stream, n) => sampleByRead(reader, stream, n, (r) => collectPaths(r, "xml")),
	};
```
with:
```ts
		},
		read: (stream, { startOffset, startSeq }) =>
			runScanner(
				stream,
				startOffset,
				new XmlScanner(path, startOffset, startSeq, false, keepBlankText),
			),
		sample: (stream, n) => sampleByRead(reader, stream, n, (r) => collectPaths(r, "xml")),
	};
```

Create `packages/flux-import/src/sources/xlsx-workbook.ts`:
```ts
import { SourceError, shortName } from "./reader.js";
import { xmlReader } from "./xml.js";
import { XlsxError } from "./zip.js";

const MIB = 1024 * 1024;
export const SHARED_STRINGS_MAX = 1_000_000;
export const SHARED_STRINGS_MAX_BYTES = 50 * MIB;
/**
 * Built-in number formats that are dates or times (ECMA-376 Part 1, 18.8.30). 46 is `[h]:mm:ss`,
 * an elapsed time, which stays a number like any other elapsed-time format.
 */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 47]);
const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHEETS_LISTED = 10;

/** The parts of a workbook archive; `ZipArchive` implements it. */
export interface WorkbookParts {
	has(name: string): boolean;
	open(name: string, maxBytes?: number): ReadableStream<Uint8Array>;
}

export interface SheetRef {
	name: string;
	/** The worksheet's part name, as in "xl/worksheets/sheet1.xml". */
	part: string;
}

export interface Workbook {
	/** Worksheets in workbook order (chart and dialog sheets are left out). */
	sheets: SheetRef[];
	date1904: boolean;
	/** The shared strings part, when the workbook has one. */
	sharedStrings?: string;
	/** The styles part, when the workbook has one. */
	styles?: string;
}

export type XmlElement = Record<string, unknown>;

function isElement(value: unknown): value is XmlElement {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attr(element: XmlElement, name: string): string | undefined {
	const value = element[`@${name}`];
	return typeof value === "string" ? value : undefined;
}

/**
 * The elements at `path` in a part, parsed with whitespace kept; `null` for one that does not
 * parse. A part that is not well-formed fails the conversion. With `optional`, a part whose
 * parent elements are missing has no elements instead.
 */
export async function* partElements(
	parts: WorkbookParts,
	part: string,
	path: string,
	options: { optional?: boolean; maxBytes?: number } = {},
): AsyncGenerator<XmlElement | null> {
	const parents = path.split("/").slice(0, -1).join("/");
	try {
		const stream = parts.open(part, options.maxBytes);
		for await (const rec of xmlReader(path, true).read(stream, { startOffset: 0, startSeq: 0 })) {
			yield rec.error || !isElement(rec.value) ? null : rec.value;
		}
	} catch (e) {
		if (!(e instanceof SourceError)) throw e;
		if (options.optional && e.message === `The document has no <${parents}> element`) return;
		throw new XlsxError(`The part ${part} is not valid: ${e.message}`);
	}
}

/**
 * Decodes the `_xHHHH_` escapes Excel writes for characters XML cannot hold (`_x000D_` is a
 * carriage return; `_x005F_` escapes a literal underscore).
 */
export function unescapeText(text: string): string {
	if (!text.includes("_x")) return text;
	return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function textOf(t: unknown): string {
	if (typeof t === "string") return t;
	if (Array.isArray(t)) return t.map(textOf).join("");
	if (isElement(t) && typeof t["#text"] === "string") return t["#text"];
	return "";
}

/**
 * The text of a string item (`<si>`, `<is>`): its `<t>`, or its rich text runs' `<t>`s joined.
 * Phonetic runs (`<rPh>`) are left out.
 */
export function richText(item: unknown): string {
	if (!isElement(item)) return typeof item === "string" ? unescapeText(item) : "";
	if ("t" in item) return unescapeText(textOf(item.t));
	const runs = item.r === undefined ? [] : Array.isArray(item.r) ? item.r : [item.r];
	return unescapeText(runs.map((run) => (isElement(run) ? textOf(run.t) : "")).join(""));
}

/** A relationship target as a part name, or null for one outside the archive. */
function partName(target: string): string | null {
	const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "..") {
			if (out.pop() === undefined) return null;
		} else if (segment !== "." && segment !== "") {
			out.push(segment);
		}
	}
	return out.join("/");
}

/** A sheet's relationship ID: its namespaced `id` attribute (`r:id`). */
function relationshipId(sheet: XmlElement): string | undefined {
	for (const [key, value] of Object.entries(sheet)) {
		if (/^@[^:]+:id$/.test(key) && typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Reads the workbook's worksheets in order, its date system, and where its shared strings and
 * styles are, from `xl/workbook.xml` and its relationships (targets resolved against `xl/`).
 */
export async function readWorkbook(parts: WorkbookParts): Promise<Workbook> {
	if (!parts.has(WORKBOOK)) {
		throw new XlsxError(`The file is not an Excel workbook (it has no ${WORKBOOK})`);
	}
	const targets = new Map<string, { type: string; part: string }>();
	if (parts.has(WORKBOOK_RELS)) {
		for await (const rel of partElements(parts, WORKBOOK_RELS, "Relationships/Relationship")) {
			if (!rel || attr(rel, "TargetMode") === "External") continue;
			const id = attr(rel, "Id");
			const target = attr(rel, "Target");
			const part = target === undefined ? null : partName(target);
			if (id !== undefined && part !== null) {
				targets.set(id, { type: attr(rel, "Type") ?? "", part });
			}
		}
	}
	const sheets: SheetRef[] = [];
	for await (const sheet of partElements(parts, WORKBOOK, "workbook/sheets/sheet")) {
		const name = sheet ? attr(sheet, "name") : undefined;
		const id = sheet ? relationshipId(sheet) : undefined;
		const rel = id === undefined ? undefined : targets.get(id);
		if (name !== undefined && rel?.type.endsWith("/worksheet"))
			sheets.push({ name, part: rel.part });
	}
	if (sheets.length === 0) throw new XlsxError("The workbook has no worksheets");
	let date1904 = false;
	for await (const pr of partElements(parts, WORKBOOK, "workbook/workbookPr", { optional: true })) {
		const value = pr ? attr(pr, "date1904") : undefined;
		date1904 = value === "1" || value === "true";
	}
	const byType = (suffix: string, fallback: string): string | undefined => {
		for (const { type, part } of targets.values()) if (type.endsWith(suffix)) return part;
		return parts.has(fallback) ? fallback : undefined;
	};
	const sharedStrings = byType("/sharedStrings", "xl/sharedStrings.xml");
	const styles = byType("/styles", "xl/styles.xml");
	return {
		sheets,
		date1904,
		...(sharedStrings === undefined ? {} : { sharedStrings }),
		...(styles === undefined ? {} : { styles }),
	};
}

/** The sheet named (compared ignoring case, as Excel does) or numbered (from 1); the first by default. */
export function chooseSheet(workbook: Workbook, sheet?: string | number): SheetRef {
	const { sheets } = workbook;
	if (sheet === undefined) return sheets[0] as SheetRef;
	if (typeof sheet === "number") {
		const found = sheets[sheet - 1];
		if (found) return found;
		const count = sheets.length === 1 ? "1 worksheet" : `${sheets.length} worksheets`;
		throw new XlsxError(`The workbook has ${count}; there is no sheet ${sheet}`);
	}
	const wanted = sheet.toLowerCase();
	const found = sheets.find((s) => s.name.toLowerCase() === wanted);
	if (found) return found;
	const listed = sheets.slice(0, SHEETS_LISTED).map((s) => `"${s.name}"`);
	if (sheets.length > SHEETS_LISTED) listed.push("…");
	throw new XlsxError(
		`The workbook has no sheet named "${shortName(sheet)}"; its sheets are ${listed.join(", ")}`,
	);
}

/**
 * Reads the shared strings in order (rich text runs joined); `null` for an item that does not
 * parse. At most `maxStrings` strings and `SHARED_STRINGS_MAX_BYTES` uncompressed.
 */
export async function readSharedStrings(
	parts: WorkbookParts,
	part: string,
	maxStrings = SHARED_STRINGS_MAX,
): Promise<(string | null)[]> {
	const strings: (string | null)[] = [];
	for await (const item of partElements(parts, part, "sst/si", {
		maxBytes: SHARED_STRINGS_MAX_BYTES,
	})) {
		if (strings.length >= maxStrings) {
			throw new XlsxError(
				`The workbook has more than ${maxStrings.toLocaleString("en-US")} shared strings`,
			);
		}
		strings.push(item === null ? null : richText(item));
	}
	return strings;
}

/**
 * Whether a number format code shows a date or time: it has `d`, `m`, `y`, `h` or `s` outside
 * quoted text, `[…]` sections and escaped characters (`\x`, and the `_x` and `*x` spacing and
 * fill characters). A code with an elapsed-time section (`[h]`, `[mm]`, `[ss]`) is a duration and
 * stays a number.
 */
export function isDateFormat(code: string): boolean {
	let plain = "";
	for (let i = 0; i < code.length; i++) {
		const ch = code[i] as string;
		if (ch === '"') {
			const end = code.indexOf('"', i + 1);
			i = end < 0 ? code.length : end;
		} else if (ch === "\\" || ch === "_" || ch === "*") {
			i++;
		} else if (ch === "[") {
			const end = code.indexOf("]", i + 1);
			const section = code.slice(i + 1, end < 0 ? code.length : end);
			if (/^(h+|m+|s+)$/i.test(section)) return false;
			i = end < 0 ? code.length : end;
		} else {
			plain += ch;
		}
	}
	return /[dmyhs]/i.test(plain);
}

/**
 * Which cell styles (`s`, an index into `cellXfs`) show dates: a style whose number format is a
 * built-in date or time format, or a custom format (`numFmts`) whose code `isDateFormat`.
 */
export async function readDateStyles(parts: WorkbookParts, part: string): Promise<boolean[]> {
	const codes = new Map<number, string>();
	for await (const fmt of partElements(parts, part, "styleSheet/numFmts/numFmt", {
		optional: true,
	})) {
		const id = fmt ? Number(attr(fmt, "numFmtId")) : Number.NaN;
		const code = fmt ? attr(fmt, "formatCode") : undefined;
		if (Number.isInteger(id) && code !== undefined) codes.set(id, code);
	}
	const dates: boolean[] = [];
	for await (const xf of partElements(parts, part, "styleSheet/cellXfs/xf", { optional: true })) {
		const id = Number((xf && attr(xf, "numFmtId")) ?? 0);
		const code = codes.get(id);
		dates.push(code === undefined ? DATE_FORMAT_IDS.has(id) : isDateFormat(code));
	}
	return dates;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xml.test.ts tests/unit/xlsx-workbook.test.ts`
Expected: PASS (101 tests: 63 in `xml.test.ts`, 38 in `xlsx-workbook.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 33 files / 829 tests after Tasks 1-2).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources packages/flux-import/tests/unit/xml.test.ts packages/flux-import/tests/unit/xlsx-workbook.test.ts
git commit -m "Read the workbook, its shared strings and date styles with the XML scanner, keeping whitespace-only text"
```

### Task 3: Template, routes and job plumbing

**Files:**
- Modify: `packages/flux-import/src/sources/reader.ts`, `packages/flux-import/src/sources/readers.ts`, `packages/flux-import/src/sources/paths.ts`, `packages/flux-import/src/engine/template.ts`, `packages/flux-import/src/engine/types.ts`, `packages/flux-import/src/engine/jobs.ts`, `packages/flux-import/src/astro/config.ts`, `packages/flux-import/src/astro/upload-route.ts`, `packages/flux-import/src/plugin/service.ts`, `packages/flux-import/src/plugin/retention.ts`, `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/readers.test.ts`, `paths.test.ts`, `template.test.ts`, `upload-route.test.ts`, `definition.test.ts`, `jobs.test.ts`, `service.test.ts`, `retention.test.ts`

**Interfaces:**
- Consumes: M3a-M3c only (`jsonlReader`, `checkSource`, `releaseUploadIfUnused`, `uploadInUse`, `purgeExpired`, `STORAGE`; E1, E3, E4).
- Produces (`src/sources/reader.ts`): `type SourceFormat = "csv" | "json" | "jsonl" | "xml" | "xlsx"` and `SOURCE_FORMATS` with `"xlsx"`; `const XLSX_MAX_ROWS = 1_048_576`; `const XLSX_ROW_FIELD = "_row"`; `TemplateSource` gains `sheet?: string | number | undefined` and `headerRow?: number | undefined`.
- Produces (`src/sources/readers.ts`): `checkSource` adds "source.sheet is only allowed for xlsx", "source.headerRow is only allowed for xlsx", "source.records is not allowed for xlsx"; `readerFor({ format: "xlsx" })` returns `jsonlReader()`.
- Produces (`src/sources/paths.ts`, `src/engine/template.ts`): XLSX paths are flat header names (`pathProblem`, `resolvePath`); `sourceSchema` gains `sheet: string(1-100) | int ≥ 1` and `headerRow: int 1-1,048,576`; `checkTemplate` checks XLSX `from`s against `columns` like CSV and always allows `_row`.
- Produces (`src/astro/config.ts`): `const XLSX_MAX_BYTES = 10 * 1024 * 1024`; `maxXlsxBytes(): number` (`min(XLSX_MAX_BYTES, maxSourceBytes())`). (`src/astro/upload-route.ts`) `.xlsx` accepted with that limit.
- Produces (`src/engine/types.ts`, `src/engine/jobs.ts`): `Job.sourceUploadId?: string`; `CreateJobInput` gains `sourceUploadId?: string`, `columns?: string[]`, `warnings?: string[]` (so `StartJobInput` does too).
- Produces (`src/plugin/service.ts`, `retention.ts`, `definition.ts`): `uploadInUse(jobs, uploadId, exceptJobId?)` checks `uploadId` and `sourceUploadId`; `releaseUploadIfUnused` releases both files; `purgeExpired` keeps `sourceUploadId`; `STORAGE.jobs.indexes` is `["status", "createdAt", "uploadId", "sourceUploadId"]`.
- Produces (`src/plugin/routes.ts`): the route `source` schema gains `sheet` and `headerRow`; `sources/paste` refuses `xlsx` with `INVALID_FORMAT`.

This task needs no workbook: XLSX jobs are tested on JSON Lines "converted" by hand, which is exactly what Task 5 will stage. Between this task and Task 5 an XLSX template would read the workbook itself as JSON Lines; nothing is released in between, so that intermediate state is never shipped.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/readers.test.ts`, replace
```ts
		[{ format: "jsonl" }, []],
		[{ format: "xml", records: "feed/item" }, []],
		[{ format: "csv", records: "x" }, ["source.records is not allowed for csv"]],
		[{ format: "jsonl", records: "x" }, ["source.records is not allowed for jsonl"]],
```
with:
```ts
		[{ format: "jsonl" }, []],
		[{ format: "xml", records: "feed/item" }, []],
		[{ format: "xlsx" }, []],
		[{ format: "xlsx", sheet: "Products", headerRow: 3 }, []],
		[{ format: "xlsx", sheet: 2 }, []],
		[{ format: "xlsx", records: "x" }, ["source.records is not allowed for xlsx"]],
		[{ format: "csv", sheet: "Products" }, ["source.sheet is only allowed for xlsx"]],
		[
			{ format: "xml", records: "feed/item", sheet: 1, headerRow: 2 },
			["source.sheet is only allowed for xlsx", "source.headerRow is only allowed for xlsx"],
		],
		[
			{ format: "json", headerRow: 2, records: "a..b" },
			["source.headerRow is only allowed for xlsx", 'source.records: "a..b" has an empty key'],
		],
		[{ format: "csv", records: "x" }, ["source.records is not allowed for csv"]],
		[{ format: "jsonl", records: "x" }, ["source.records is not allowed for jsonl"]],
```

then replace
```ts
			{ "#text": "4" },
		]);
	});
});
```
with:
```ts
			{ "#text": "4" },
		]);
		// An XLSX job reads the JSON Lines its sheet was converted to.
		expect(await read({ format: "xlsx" }, '{"Name":"Desk","_row":2}\n', ["Name"])).toEqual([
			{ Name: "Desk", _row: 2 },
		]);
	});
});
```

In `packages/flux-import/tests/unit/paths.test.ts`, replace
```ts
		expect(resolvePath({ sku: "A1" }, "name", "csv")).toBeUndefined();
		expect(resolvePath({}, "__proto__", "csv")).toBeUndefined();
	});

```
with:
```ts
		expect(resolvePath({ sku: "A1" }, "name", "csv")).toBeUndefined();
		expect(resolvePath({}, "__proto__", "csv")).toBeUndefined();
	});

	it("reads XLSX cells by header name, dots and all, keeping typed values", () => {
		const row = { "Unit Price": 12.5, "v1.2": "x", Active: true, Empty: null, _row: 7 };
		expect(resolvePath(row, "Unit Price", "xlsx")).toBe(12.5);
		expect(resolvePath(row, "v1.2", "xlsx")).toBe("x");
		expect(resolvePath(row, "Active", "xlsx")).toBe(true);
		expect(resolvePath(row, "Empty", "xlsx")).toBeNull();
		expect(resolvePath(row, "_row", "xlsx")).toBe(7);
		expect(resolvePath(row, "Missing", "xlsx")).toBeUndefined();
	});

```

then replace
```ts
		["xml", "title/@1lang", /invalid/],
		["csv", "Any Column!", null],
	] as const)("%s path %s", (format, path, problem) => {
		const result = pathProblem(path, format);
```
with:
```ts
		["xml", "title/@1lang", /invalid/],
		["csv", "Any Column!", null],
		["xlsx", "Unit Price (EUR.)", null],
		["xlsx", "", /empty/],
	] as const)("%s path %s", (format, path, problem) => {
		const result = pathProblem(path, format);
```

In `packages/flux-import/tests/unit/template.test.ts`, replace
```ts
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		expect(templateSchema.safeParse({ ...base, source: { format: "yaml" }, fields }).success).toBe(
```
with:
```ts
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		for (const source of [
			{ format: "xlsx" },
			{ format: "xlsx", sheet: "Prices 2026", headerRow: 3 },
			{ format: "xlsx", sheet: 2, headerRow: 1_048_576 },
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		for (const source of [
			{ format: "xlsx", sheet: "" },
			{ format: "xlsx", sheet: "x".repeat(101) },
			{ format: "xlsx", sheet: 0 },
			{ format: "xlsx", sheet: 1.5 },
			{ format: "xlsx", headerRow: 0 },
			{ format: "xlsx", headerRow: 1_048_577 },
			{ format: "xlsx", headerRow: "1" },
		]) {
			expect(templateSchema.safeParse({ ...base, source, fields }).success).toBe(false);
		}
		expect(templateSchema.safeParse({ ...base, source: { format: "yaml" }, fields }).success).toBe(
```

then replace
```ts
			'Field "title" has type "number"; a text mapping needs one of string, text, url',
			'Field "price" does not exist in collection "products"',
		]);
	});
```
with:
```ts
			'Field "title" has type "number"; a text mapping needs one of string, text, url',
			'Field "price" does not exist in collection "products"',
		]);
	});

	it("checks XLSX columns against the header, and lets a template read _row", () => {
		const xlsx = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xlsx" },
			key: { from: "_row" },
			fields: {
				title: { from: "Product name", type: "text" },
				price: { from: "Unit Price", type: "number" },
			},
		});
		expect(checkTemplate(xlsx, fields, ["Product name", "Unit Price"])).toEqual([]);
		expect(checkTemplate(xlsx, fields, ["Product name"])).toEqual([
			'Column "Unit Price" not found in the source',
		]);
	});
```

In `packages/flux-import/tests/unit/upload-route.test.ts`, replace
```ts
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/astro/upload-route.js";
import { FakeStorage } from "./fakes.js";
```
with:
```ts
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { XLSX_MAX_BYTES } from "../../src/astro/config.js";
import { POST } from "../../src/astro/upload-route.js";
import { FakeStorage } from "./fakes.js";
```

then replace
```ts
		"feed.ndjson",
		"feed.xml",
		"a.b.csv",
		`${"n".repeat(251)}.csv`,
```
with:
```ts
		"feed.ndjson",
		"feed.xml",
		"Products 2026.xlsx",
		"BOOK.XLSX",
		"a.b.csv",
		`${"n".repeat(251)}.csv`,
```

then replace
```ts
		"feed.txt",
		"feed.json.gz",
		"../feed.json",
		"feed",
```
with:
```ts
		"feed.txt",
		"feed.json.gz",
		"book.xls",
		"book.xlsm",
		"book.xlsb",
		"book.ods",
		"../feed.json",
		"feed",
```

then replace
```ts
		expect(storage.files.size).toBe(0);
	});
});
```
with:
```ts
		expect(storage.files.size).toBe(0);
	});

	it("limits .xlsx files to 10 MiB, by Content-Length and while streaming", async () => {
		const declared = await post(
			{
				body: streamOf("x"),
				duplex: "half",
				headers: { "Content-Length": String(XLSX_MAX_BYTES + 1) },
			},
			`${BASE}book.xlsx`,
		);
		expect(declared.res.status).toBe(413);
		expect(declared.body).toMatchObject({
			error: {
				code: "TOO_LARGE",
				message: `The upload exceeds the limit of ${XLSX_MAX_BYTES} bytes`,
			},
		});
		const streamed = await post(
			{ body: streamOf(new Uint8Array(XLSX_MAX_BYTES + 1)), duplex: "half" },
			`${BASE}book.xlsx`,
		);
		expect(streamed.res.status).toBe(413);
		expect(streamed.storage.files.size).toBe(0);
		// The same size is fine for other formats, whose limit is maxSourceBytes (50 MiB).
		const csv = await post({ body: streamOf(new Uint8Array(XLSX_MAX_BYTES + 1)), duplex: "half" });
		expect(csv.res.status).toBe(201);
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
			["jobId", "status", "seq"],
		]);
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
```
with:
```ts
			["jobId", "status", "seq"],
		]);
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId", "sourceUploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
```

then replace
```ts
			false,
		);
		const paste = plugin.routes["sources/paste"]!.input!;
		expect(paste.safeParse({ format: "json", text: "[]" }).success).toBe(true);
		expect(paste.safeParse({ format: "xlsx", text: "x" }).success).toBe(false);
		expect(paste.safeParse({ format: "csv" }).success).toBe(false);
		expect(plugin.routes["jobs/get"]!.input!.safeParse({ id: "a/b" }).success).toBe(false);
```
with:
```ts
			false,
		);
		expect(
			sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "xlsx", sheet: 2, headerRow: 3 } })
				.success,
		).toBe(true);
		const paste = plugin.routes["sources/paste"]!.input!;
		expect(paste.safeParse({ format: "json", text: "[]" }).success).toBe(true);
		expect(paste.safeParse({ format: "yaml", text: "x" }).success).toBe(false);
		expect(paste.safeParse({ format: "csv" }).success).toBe(false);
		expect(plugin.routes["jobs/get"]!.input!.safeParse({ id: "a/b" }).success).toBe(false);
```

then replace
```ts
			{ format: "csv", filter: "Price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != ''" },
			{ format: "json", filter: "" },
			{ format: "json", filter: 5 },
```
with:
```ts
			{ format: "csv", filter: "Price > 0" },
			{ format: "xml", records: "feed/item", filter: "`@sku` != ''" },
			{ format: "xlsx" },
			{ format: "xlsx", sheet: "Products", headerRow: 2, filter: "Price > 0" },
			{ format: "xlsx", sheet: 3 },
			{ format: "xlsx", sheet: "" },
			{ format: "xlsx", sheet: "x".repeat(101) },
			{ format: "xlsx", sheet: 0 },
			{ format: "xlsx", sheet: 2.5 },
			{ format: "xlsx", headerRow: 0 },
			{ format: "xlsx", headerRow: 1_048_577 },
			{ format: "xlsx", headerRow: "2" },
			{ format: "json", filter: "" },
			{ format: "json", filter: 5 },
```

then replace
```ts
	});

	it("refuses a call without a user before touching the runtime", async () => {
		const ctx = { input: { id: "J1" }, user: undefined } as unknown as RouteContext;
```
with:
```ts
	});

	it("refuses to stage pasted XLSX before touching the runtime", async () => {
		const ctx = {
			input: { format: "xlsx", text: "PK" },
			user: { id: "u1", role: 50 },
		} as unknown as RouteContext;
		await expect(plugin.routes["sources/paste"]!.handler(ctx)).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "INVALID_FORMAT",
			status: 400,
			message: "An XLSX workbook is a binary file and cannot be pasted; upload it instead",
		});
	});

	it("refuses a call without a user before touching the runtime", async () => {
		const ctx = { input: { id: "J1" }, user: undefined } as unknown as RouteContext;
```

In `packages/flux-import/tests/unit/jobs.test.ts`, replace
```ts
			{ code: "invalid_source" },
		);
	});
});
```
with:
```ts
			{ code: "invalid_source" },
		);
	});
});

describe("createJob for converted XLSX", () => {
	const xlsxT = (fields: object, key: object = { from: "sku" }) => ({
		...template,
		source: { format: "xlsx", sheet: "Products" },
		key,
		fields,
	});
	const LINES = '{"sku":"A1","Name":"Desk","_row":2}\n{"sku":"A2","Name":null,"_row":4}\n';

	it("reads the converted JSON Lines, keeping the header columns, warnings and workbook", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", LINES);
		const job = await createJob(deps, {
			uploadId: "converted",
			sourceUploadId: "workbook",
			columns: ["sku", "Name"],
			warnings: ['Column C has no header; it is named "column_C"'],
			template: xlsxT({ title: { from: "Name", type: "text" } }),
			schemaFields,
		});
		expect(job).toMatchObject({
			uploadId: "converted",
			sourceUploadId: "workbook",
			source: { format: "xlsx", sheet: "Products" },
			columns: ["sku", "Name"],
			warnings: ['Column C has no header; it is named "column_C"'],
			cursor: { offset: 0, seq: 0 },
		});
		await runBatch(deps, job.id, "driver");
		expect(
			[...deps.content.entries.values()].map((e) => [e.data.flux_source_id, e.data.title]),
		).toEqual([
			["A1", "Desk"],
			["A2", null],
		]);
	});

	it("fails a from column missing from the header like CSV, but lets the key read _row", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", LINES);
		const create = (fields: object, key?: object) =>
			createJob(deps, {
				uploadId: "converted",
				columns: ["sku", "Name"],
				template: xlsxT(fields, key),
				schemaFields,
			});
		await expect(create({ title: { from: "Title", type: "text" } })).rejects.toMatchObject({
			code: "invalid_template",
			details: ['Column "Title" not found in the source'],
		});
		const byRow = await create({ title: { from: "Name", type: "text" } }, { from: "_row" });
		expect(byRow.warnings).toEqual([]);
	});

	it("warns when the converted sheet has no records", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", "");
		const job = await createJob(deps, {
			uploadId: "converted",
			columns: ["sku", "Name"],
			template: xlsxT({ title: { from: "Name", type: "text" } }),
			schemaFields,
		});
		expect(job.warnings).toEqual(["No records found in the file"]);
	});
});
```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
	});

	it("knows which states still need the file", () => {
		const base = {
```
with:
```ts
	});

	it("releases an XLSX job's workbook with its converted file, unless another job needs it", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		const xlsx = { ...template, source: { format: "xlsx" } };
		const lines = '{"sku":"S1","Name":"Item 1","Price":1,"_row":2}\n';
		const start = (converted: string, dryRun: boolean) => {
			deps.source.add(converted, lines);
			return startJob(
				deps,
				{
					uploadId: converted,
					sourceUploadId: "book",
					columns: ["sku", "Name", "Price"],
					template: xlsx,
					dryRun,
				},
				fields,
			);
		};
		// A finished dry run keeps its files: the real run converts the workbook again.
		const dry = await start("c1", true);
		await drive(deps, uploads, dry.id);
		expect(uploads.deleted).toEqual([]);
		const real = await start("c2", false);
		await drive(deps, uploads, real.id);
		expect(uploads.deleted).toEqual(["c2"]);
		// Once nothing needs it, cancelling the dry run releases its copy and the workbook.
		await deps.jobs.put(dry.id, { ...(await getJob(deps, dry.id)), status: "running" });
		await changeJob(deps, uploads, dry.id, "cancel");
		expect(uploads.deleted).toEqual(["c2", "c1", "book"]);
	});

	it("keeps an XLSX workbook that a URL source still names as its latest fetch", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("c1", '{"sku":"S1","Name":"Item 1","Price":1,"_row":2}\n');
		const job = await startJob(
			deps,
			{
				uploadId: "c1",
				sourceUploadId: "fetched",
				columns: ["sku", "Name", "Price"],
				template: { ...template, source: { format: "xlsx" } },
				dryRun: false,
			},
			fields,
		);
		const keep = async (uploadId: string) => uploadId === "fetched";
		expect((await nextBatch(deps, uploads, job.id, "h", keep)).status).toBe("completed");
		expect(uploads.deleted).toEqual(["c1"]);
	});

	it("knows which states still need the file", () => {
		const base = {
```

In `packages/flux-import/tests/unit/retention.test.ts`, replace
```ts
		expect(purger.cutoffs[0]!.getTime()).toBe(clock.t - 30 * DAY);
		expect(purger.keeps[0]!.has("u1")).toBe(true);
	});

```
with:
```ts
		expect(purger.cutoffs[0]!.getTime()).toBe(clock.t - 30 * DAY);
		expect(purger.keeps[0]!.has("u1")).toBe(true);
	});

	it("keeps the workbook a surviving XLSX job was converted from", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", '{"sku":"A","Name":"1","_row":2}\n');
		await createJob(deps, {
			uploadId: "converted",
			sourceUploadId: "book",
			columns: ["sku", "Name"],
			template: { ...template, source: { format: "xlsx" } },
			schemaFields,
		});
		const purger = new Purger();
		await purgeExpired(deps, purger, 30);
		expect(purger.keeps[0]).toEqual(new Set(["converted", "book"]));
	});

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/readers.test.ts tests/unit/paths.test.ts tests/unit/template.test.ts tests/unit/upload-route.test.ts tests/unit/definition.test.ts tests/unit/jobs.test.ts tests/unit/service.test.ts tests/unit/retention.test.ts`
Expected: FAIL — 20 of 212 tests in the 8 files: the XLSX path cases (`Unit Price (EUR.)` is still read as a dotted path with an empty key, and `v1.2` is not found), the new `checkSource` cases and `readerFor`, the template schema and `checkTemplate` XLSX cases, the `.xlsx` upload cases (415 instead of 201/413), the three "createJob for converted XLSX" tests (no `sourceUploadId`/`columns` yet, and `xlsx` is not a format), the two XLSX lifecycle tests in `service.test.ts`, the retention test, the storage index test, the paste schema test (`xlsx` is not yet a format) and "refuses to stage pasted XLSX before touching the runtime" (it reaches the runtime instead).

- [ ] **Step 3: Add the format, its source block and its paths**

In `packages/flux-import/src/sources/reader.ts`, replace
```ts
export type SourceFormat = "csv" | "json" | "jsonl" | "xml";

export const SOURCE_FORMATS = [
```
with:
```ts
export type SourceFormat = "csv" | "json" | "jsonl" | "xml" | "xlsx";

export const SOURCE_FORMATS = [
```

then replace
```ts
	"jsonl",
	"xml",
] as const satisfies readonly SourceFormat[];

/** The template's `source` block. `records` is a dot path (json) or a `/` path (xml). */
export interface TemplateSource {
	format: SourceFormat;
	records?: string | undefined;
}

```
with:
```ts
	"jsonl",
	"xml",
	"xlsx",
] as const satisfies readonly SourceFormat[];

/** Excel's last row; `headerRow` and sheet rows are at most this. */
export const XLSX_MAX_ROWS = 1_048_576;
/** The field every converted XLSX record carries: the sheet's 1-based row number. */
export const XLSX_ROW_FIELD = "_row";

/**
 * The template's `source` block. `records` is a dot path (json) or a `/` path (xml). `sheet` (a
 * name or a 1-based position) and `headerRow` (1-based) choose what an XLSX import reads.
 */
export interface TemplateSource {
	format: SourceFormat;
	records?: string | undefined;
	sheet?: string | number | undefined;
	headerRow?: number | undefined;
}

```

In `packages/flux-import/src/sources/readers.ts`, replace
```ts
/**
 * Problems with a source block that no reader can fix: `records` where it is not allowed,
 * missing where it is required, or not a valid path.
 */
export function checkSource(source: TemplateSource): string[] {
	const { format, records } = source;
	if (format === "csv" || format === "jsonl") {
		return records === undefined ? [] : [`source.records is not allowed for ${format}`];
	}
	if (records === undefined) {
		return format === "xml" ? ['source.records is required for xml, as in "feed/item"'] : [];
	}
	const problem = recordsPathProblem(records, format);
	return problem === null ? [] : [`source.records: ${problem}`];
}

/** The reader for a source block that passed `checkSource`. */
export function readerFor(source: TemplateSource, columns: readonly string[] = []): RecordReader {
	switch (source.format) {
```
with:
```ts
/**
 * Problems with a source block that no reader can fix: `records` where it is not allowed,
 * missing where it is required, or not a valid path; `sheet` or `headerRow` outside xlsx.
 */
export function checkSource(source: TemplateSource): string[] {
	const { format, records } = source;
	const problems: string[] = [];
	if (format !== "xlsx") {
		for (const key of ["sheet", "headerRow"] as const) {
			if (source[key] !== undefined) problems.push(`source.${key} is only allowed for xlsx`);
		}
	}
	if (format === "csv" || format === "jsonl" || format === "xlsx") {
		if (records !== undefined) problems.push(`source.records is not allowed for ${format}`);
		return problems;
	}
	if (records === undefined) {
		if (format === "xml") problems.push('source.records is required for xml, as in "feed/item"');
		return problems;
	}
	const problem = recordsPathProblem(records, format);
	if (problem !== null) problems.push(`source.records: ${problem}`);
	return problems;
}

/**
 * The reader for a source block that passed `checkSource`. An XLSX job reads the JSON Lines its
 * sheet was converted to at job creation.
 */
export function readerFor(source: TemplateSource, columns: readonly string[] = []): RecordReader {
	switch (source.format) {
```

then replace
```ts
		case "xml":
			return xmlReader(source.records ?? "");
	}
}
```
with:
```ts
		case "xml":
			return xmlReader(source.records ?? "");
		case "xlsx":
			return jsonlReader();
	}
}
```

In `packages/flux-import/src/sources/paths.ts`, replace
```ts
}

/**
 * Why `path` is not a valid field path for `format`, or null. JSON: dot-separated keys, none
 * empty. XML: `/`-separated element names, optionally ending in `@attribute` or `#text`.
 */
export function pathProblem(path: string, format: SourceFormat): string | null {
	if (format === "csv") return path === "" ? "The column name is empty" : null;
	const parts = segments(path, format);
	if (format !== "xml") {
```
with:
```ts
}

/** CSV and XLSX records are flat: a path is a column (header) name, dots and all. */
function isFlat(format: SourceFormat): boolean {
	return format === "csv" || format === "xlsx";
}

/**
 * Why `path` is not a valid field path for `format`, or null. CSV and XLSX: a column name.
 * JSON: dot-separated keys, none empty. XML: `/`-separated element names, optionally ending in
 * `@attribute` or `#text`.
 */
export function pathProblem(path: string, format: SourceFormat): string | null {
	if (isFlat(format)) return path === "" ? "The column name is empty" : null;
	const parts = segments(path, format);
	if (format !== "xml") {
```

then replace
```ts

/**
 * Reads a field value from a record. CSV: the column's cell. JSON: walks own object keys. XML:
 * walks child elements and `@attributes`; an element without child elements reads as its text.
 * Walking stops at an array, which is the result (M3a has no array indexes). Returns
```
with:
```ts

/**
 * Reads a field value from a record. CSV and XLSX: the column's cell. JSON: walks own object keys. XML:
 * walks child elements and `@attributes`; an element without child elements reads as its text.
 * Walking stops at an array, which is the result (M3a has no array indexes). Returns
```

then replace
```ts
 */
export function resolvePath(value: unknown, path: string, format: SourceFormat): unknown {
	if (format === "csv") {
		return isPlainObject(value) && Object.hasOwn(value, path) ? value[path] : undefined;
	}
```
with:
```ts
 */
export function resolvePath(value: unknown, path: string, format: SourceFormat): unknown {
	if (isFlat(format)) {
		return isPlainObject(value) && Object.hasOwn(value, path) ? value[path] : undefined;
	}
```

In `packages/flux-import/src/engine/template.ts`, replace
```ts
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import { CSV_SOURCE, SOURCE_FORMATS, type SourceFormat } from "../sources/reader.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";

```
with:
```ts
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
	SOURCE_FORMATS,
	type SourceFormat,
	XLSX_MAX_ROWS,
	XLSX_ROW_FIELD,
} from "../sources/reader.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";

```

then replace
```ts

/**
 * The template's `source` block. Which formats take `records` is checked by `checkSource`
 * (sources/readers.ts), so a misplaced `records` is reported as `invalid_source`. `filter` is a
 * JSONata expression evaluated per record, for every format.
 */
export const sourceSchema = z
```
with:
```ts

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
 * by `checkSource` (sources/readers.ts), so a misplaced one is reported as `invalid_source`.
 * `filter` is a JSONata expression evaluated per record, for every format.
 */
export const sourceSchema = z
```

then replace
```ts
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
		filter: expression.optional(),
	})
```
with:
```ts
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
		sheet: z.union([z.string().min(1).max(100), z.number().int().min(1)]).optional(),
		headerRow: z.number().int().min(1).max(XLSX_MAX_ROWS).optional(),
		filter: expression.optional(),
	})
```

then replace
```ts

/**
 * Problems that stop a job: CSV columns missing from the header (`columns`, CSV only), field
 * paths that are not valid for the source format, and fields the collection lacks or types it
 * cannot take.
 */
export function checkTemplate(
```
with:
```ts

/**
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, and
 * fields the collection lacks or types it cannot take.
 */
export function checkTemplate(
```

then replace
```ts
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv") {
			if (columns !== null && !columns.includes(path)) {
				errors.push(`Column "${path}" not found in the source`);
			}
```
with:
```ts
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv" || format === "xlsx") {
			const implicit = format === "xlsx" && path === XLSX_ROW_FIELD;
			if (columns !== null && !columns.includes(path) && !implicit) {
				errors.push(`Column "${path}" not found in the source`);
			}
```

- [ ] **Step 4: Accept .xlsx uploads up to 10 MiB and refuse pasted workbooks**

In `packages/flux-import/src/astro/config.ts`, replace
```ts
export const MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024;

export function maxSourceBytes(): number {
	return typeof __FLUX_IMPORT_MAX_SOURCE_BYTES__ === "number"
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}

```
with:
```ts
export const MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024;

/** XLSX files are read whole into memory to be converted, so they have their own, lower limit. */
export const XLSX_MAX_BYTES = 10 * 1024 * 1024;

export function maxSourceBytes(): number {
	return typeof __FLUX_IMPORT_MAX_SOURCE_BYTES__ === "number"
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}

/** The XLSX file limit: 10 MiB, or `maxSourceBytes` when that is lower. */
export function maxXlsxBytes(): number {
	return Math.min(XLSX_MAX_BYTES, maxSourceBytes());
}

```

In `packages/flux-import/src/astro/upload-route.ts`, replace
```ts
import { EmDashUploads, stageUpload, UploadTooLargeError } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { maxSourceBytes } from "./config.js";

export const prerender = false;

/** The extension only gates acceptance; the template's `source.format` decides parsing. */
const SOURCE_FILENAME = /^(?=.{1,255}$)[^/\\\0]+\.(?:csv|json|jsonl|ndjson|xml)$/i;

/** Same envelope as EmDash's own API errors (`emdash` src/api/error.ts:31-43). */
```
with:
```ts
import { EmDashUploads, stageUpload, UploadTooLargeError } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { maxSourceBytes, maxXlsxBytes } from "./config.js";

export const prerender = false;

/**
 * The extension only gates acceptance and the size limit; the template's `source.format` decides
 * parsing. Other spreadsheet files (.xls, .xlsb, .xlsm, .ods) are refused.
 */
const SOURCE_FILENAME = /^(?=.{1,255}$)[^/\\\0]+\.(?:csv|json|jsonl|ndjson|xml|xlsx)$/i;
const XLSX_FILENAME = /\.xlsx$/i;

/** Same envelope as EmDash's own API errors (`emdash` src/api/error.ts:31-43). */
```

then replace
```ts

/**
 * POST /_emdash/api/flux-import/uploads?filename=<name>.csv|.json|.jsonl|.ndjson|.xml
 *
 * EmDash's middleware authenticates this path and applies CSRF (`X-EmDash-Request: 1` for
 * session callers; PATs need the `admin` scope), verification report question 5. The route adds
 * the `import:execute` check and the size limit, enforced while the body streams.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
```
with:
```ts

/**
 * POST /_emdash/api/flux-import/uploads?filename=<name>.csv|.json|.jsonl|.ndjson|.xml|.xlsx
 *
 * EmDash's middleware authenticates this path and applies CSRF (`X-EmDash-Request: 1` for
 * session callers; PATs need the `admin` scope), verification report question 5. The route adds
 * the `import:execute` check and the size limit (`maxXlsxBytes` for .xlsx, else `maxSourceBytes`),
 * enforced while the body streams.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
```

then replace
```ts
		return apiError(
			"UNSUPPORTED_SOURCE",
			"filename must name a .csv, .json, .jsonl, .ndjson or .xml file",
			415,
		);
	}
	const limit = maxSourceBytes();
	const header = request.headers.get("content-length");
	const declared = header === null ? undefined : Number(header);
```
with:
```ts
		return apiError(
			"UNSUPPORTED_SOURCE",
			"filename must name a .csv, .json, .jsonl, .ndjson, .xml or .xlsx file",
			415,
		);
	}
	const limit = XLSX_FILENAME.test(filename) ? maxXlsxBytes() : maxSourceBytes();
	const header = request.headers.get("content-length");
	const declared = header === null ? undefined : Number(header);
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { defaultResolver } from "../sources/net.js";
import { SOURCE_FORMATS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
```
with:
```ts
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { defaultResolver } from "../sources/net.js";
import { SOURCE_FORMATS, XLSX_MAX_ROWS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
```

then replace
```ts
		format: format.default("csv"),
		records: z.string().min(1).optional(),
		filter: z.string().min(1).optional(),
	})
```
with:
```ts
		format: format.default("csv"),
		records: z.string().min(1).optional(),
		sheet: z.union([z.string().min(1).max(100), z.number().int().min(1)]).optional(),
		headerRow: z.number().int().min(1).max(XLSX_MAX_ROWS).optional(),
		filter: z.string().min(1).optional(),
	})
```

then replace
```ts

	// The text is staged like an upload; the template's source block decides how it is parsed.
	"sources/paste": {
		...route(z.object({ format, text: z.string() }), (ctx) =>
			withServices(ctx, ({ storage }) => stagePaste(storage, ctx.input.text)),
		),
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},
```
with:
```ts

	// The text is staged like an upload; the template's source block decides how it is parsed.
	// A workbook is binary, so it can only be uploaded.
	"sources/paste": {
		...route(z.object({ format, text: z.string() }), async (ctx) => {
			if (ctx.input.format === "xlsx") {
				throw new PluginRouteError(
					"INVALID_FORMAT",
					"An XLSX workbook is a binary file and cannot be pasted; upload it instead",
					400,
				);
			}
			return withServices(ctx, ({ storage }) => stagePaste(storage, ctx.input.text));
		}),
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},
```

- [ ] **Step 5: Record the workbook on the job and release it with the job's file**

In `packages/flux-import/src/engine/types.ts`, replace
```ts
	/** The template's source block. Absent on jobs created before M3a, which are CSV. */
	source?: TemplateSource;
	/** CSV header columns; absent for other formats. */
	columns?: string[];
	/** Pre-M3a name of `columns`, still read for jobs created before M3a. */
	headers?: string[];
	/** Template paths missing from the sampled records (JSON, JSON Lines, XML). */
	warnings?: string[];
	cursor: { offset: number; seq: number };
	counters: Counters;
```
with:
```ts
	/** The template's source block. Absent on jobs created before M3a, which are CSV. */
	source?: TemplateSource;
	/** CSV and XLSX header columns; absent for other formats. */
	columns?: string[];
	/** Pre-M3a name of `columns`, still read for jobs created before M3a. */
	headers?: string[];
	/**
	 * Warnings for the job: template paths missing from the sampled records (JSON, JSON Lines,
	 * XML), and header renames and skipped cells from an XLSX conversion.
	 */
	warnings?: string[];
	/** XLSX: the uploaded workbook; `uploadId` is the JSON Lines it was converted to. */
	sourceUploadId?: string;
	cursor: { offset: number; seq: number };
	counters: Counters;
```

In `packages/flux-import/src/engine/jobs.ts`, replace
```ts
	template: unknown;
	schemaFields: SchemaField[];
	dryRun?: boolean;
	publish?: boolean;
```
with:
```ts
	template: unknown;
	schemaFields: SchemaField[];
	/** XLSX: the uploaded workbook that `uploadId` was converted from. */
	sourceUploadId?: string;
	/** XLSX: the converted sheet's header names, checked like CSV columns. */
	columns?: string[];
	/** XLSX: warnings from the conversion, stored before the job's own. */
	warnings?: string[];
	dryRun?: boolean;
	publish?: boolean;
```

then replace
```ts
		reader.locate(await deps.source.open(input.uploadId, 0)),
	);
	const columns = located.columns ?? null;

	const problems = checkTemplate(template, input.schemaFields, columns);
```
with:
```ts
		reader.locate(await deps.source.open(input.uploadId, 0)),
	);
	const columns = located.columns ?? input.columns ?? null;

	const problems = checkTemplate(template, input.schemaFields, columns);
```

then replace
```ts
		);
	}
	const warnings =
		template.source.format === "csv"
			? []
```
with:
```ts
		);
	}
	const sampled =
		template.source.format === "csv"
			? []
```

then replace
```ts
					sampleWarnings(deps, reader, template, input.uploadId, located.bodyOffset),
				);

	const now = new Date(deps.now()).toISOString();
```
with:
```ts
					sampleWarnings(deps, reader, template, input.uploadId, located.bodyOffset),
				);
	const warnings = [...(input.warnings ?? []), ...sampled];

	const now = new Date(deps.now()).toISOString();
```

then replace
```ts
		status: "created",
		uploadId: input.uploadId,
		template,
		dryRun: input.dryRun ?? false,
```
with:
```ts
		status: "created",
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
		dryRun: input.dryRun ?? false,
```

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
}

/** Whether a job other than `exceptJobId` may still read the staged file. */
export async function uploadInUse(
	jobs: KvCollection<Job>,
```
with:
```ts
}

/**
 * Whether a job other than `exceptJobId` may still read the staged file: as its own file, or as
 * the workbook its file was converted from (a real run after an XLSX dry run converts it again).
 */
export async function uploadInUse(
	jobs: KvCollection<Job>,
```

then replace
```ts
	exceptJobId?: string,
): Promise<boolean> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { uploadId },
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		if (result.items.some(({ id, data }) => id !== exceptJobId && uploadNeeded(data))) return true;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return false;
}
```
with:
```ts
	exceptJobId?: string,
): Promise<boolean> {
	for (const field of ["uploadId", "sourceUploadId"] as const) {
		let cursor: string | undefined;
		do {
			const result = await jobs.query({
				where: { [field]: uploadId },
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			if (result.items.some(({ id, data }) => id !== exceptJobId && uploadNeeded(data))) {
				return true;
			}
			cursor = result.hasMore ? result.cursor : undefined;
		} while (cursor);
	}
	return false;
}
```

then replace
```ts
const keepNone: UploadKeeper = async () => false;

/** Deletes the job's staged file once neither it nor any other job can still read it. */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
```
with:
```ts
const keepNone: UploadKeeper = async () => false;

/**
 * Deletes the job's staged file, and the workbook an XLSX job's file was converted from, once
 * neither it nor any other job can still read them. Returns whether the job's file was deleted.
 */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
```

then replace
```ts
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	if (await uploadInUse(deps.jobs, job.uploadId, job.id)) return false;
	if (await keep(job.uploadId)) return false;
	await uploads.delete(job.uploadId);
	return true;
}

```
with:
```ts
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	let released = false;
	for (const uploadId of [job.uploadId, job.sourceUploadId]) {
		if (uploadId === undefined) continue;
		if (await uploadInUse(deps.jobs, uploadId, job.id)) continue;
		if (await keep(uploadId)) continue;
		await uploads.delete(uploadId);
		if (uploadId === job.uploadId) released = true;
	}
	return released;
}

```

In `packages/flux-import/src/plugin/retention.ts`, replace
```ts
	}

	// Surviving jobs still read their source file, however old it is.
	const keep = new Set<string>(keepUploads);
	cursor = undefined;
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of page.items) keep.add(data.uploadId);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
```
with:
```ts
	}

	// Surviving jobs still read their source file (and an XLSX job's workbook), however old it is.
	const keep = new Set<string>(keepUploads);
	cursor = undefined;
	do {
		const page = await deps.jobs.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of page.items) {
			keep.add(data.uploadId);
			if (data.sourceUploadId !== undefined) keep.add(data.sourceUploadId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` lets a finished job check
 * whether another job still needs its staged file before deleting it.
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId"] },
	records: {
		indexes: ["jobId", ["jobId", "status"], ["jobId", "seq"], ["jobId", "status", "seq"]],
```
with:
```ts
/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` and `jobs.sourceUploadId` let a
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it.
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
	records: {
		indexes: ["jobId", ["jobId", "status"], ["jobId", "seq"], ["jobId", "status", "seq"]],
```

- [ ] **Step 6: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/readers.test.ts tests/unit/paths.test.ts tests/unit/template.test.ts tests/unit/upload-route.test.ts tests/unit/definition.test.ts tests/unit/jobs.test.ts tests/unit/service.test.ts tests/unit/retention.test.ts`
Expected: PASS (212 tests in the 8 files). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 33 files / 854 tests after Tasks 1-3, or 31 files / 806 tests when Task 3 runs alone on `675f06d`).

- [ ] **Step 7: Commit**

```bash
git add packages/flux-import/src packages/flux-import/tests/unit
git commit -m "Accept XLSX in templates, uploads and job records, refuse pasted workbooks, and release a job's workbook with its file"
```

### Task 4: Sheet converter: rows, cells, dates and headers to JSON Lines

**Files:**
- Create: `packages/flux-import/src/sources/xlsx.ts`, `packages/flux-import/tests/fixtures/xlsx.ts`, `packages/flux-import/tests/fixtures/phpspreadsheet/Translations.xlsx` (binary), `packages/flux-import/tests/fixtures/phpspreadsheet/LICENSE`
- Test: `packages/flux-import/tests/unit/xlsx.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`ZipArchive`, `XlsxError`; tests: `zip`, `ZipFile`); Task 2 (`readWorkbook`, `chooseSheet`, `readSharedStrings`, `readDateStyles`, `partElements`, `attr`, `richText`, `unescapeText`, `XmlElement`); Task 3 (`XLSX_MAX_ROWS`, `XLSX_ROW_FIELD`); `shortName` (M3a); tests: `product()` (`tests/fixtures/formats.ts`), `parseJsonRecord` (`src/sources/json.ts`), `collect` (`tests/unit/helpers.ts`); X4, X5.
- Produces (`src/sources/xlsx.ts`):
  - `const XLSX_MAX_COLUMNS = 16_384`
  - `interface XlsxOptions { sheet?: string | number | undefined; headerRow?: number | undefined }`
  - `interface XlsxSheet { columns: string[]; lines: AsyncGenerator<string>; warnings(): string[] }`
  - `columnName(index: number): string`; `excelDate(serial: number, date1904: boolean): string | null`
  - `openXlsx(bytes: Uint8Array, options?: XlsxOptions): Promise<XlsxSheet>`
- Produces (`tests/fixtures/xlsx.ts`): `xmlEscape(s)`, `t(text)`, `interface SheetSpec { name; rows; after? }`, `interface WorkbookSpec { sheets; sharedStrings?; numFmts?; cellXfs?; date1904?; method? }`, `workbook(spec): Promise<Uint8Array<ArrayBuffer>>`, `row(r, cells, spans?)`, `serial(isoDate): number`, `productsXlsx(n): Promise<Uint8Array<ArrayBuffer>>`, `xlsxTemplate(collection, source?)`, `excelTranslations(): Uint8Array`.

`productsXlsx(n)` holds the products of `productsCsv`/`product()` (the same keys, names, prices and dates as every other format) with text in shared strings, a date cell in built-in format 14 and a boolean `Active` (true for odd rows), as Excel stores them.

- [ ] **Step 1: Add the Excel workbook fixture**

Download `packages/flux-import/tests/fixtures/phpspreadsheet/Translations.xlsx` from https://raw.githubusercontent.com/PHPOffice/PhpSpreadsheet/1.30.1/src/PhpSpreadsheet/Calculation/locale/Translations.xlsx (`curl -sSfL --create-dirs -o packages/flux-import/tests/fixtures/phpspreadsheet/Translations.xlsx https://raw.githubusercontent.com/PHPOffice/PhpSpreadsheet/1.30.1/src/PhpSpreadsheet/Calculation/locale/Translations.xlsx`); `sha256sum packages/flux-import/tests/fixtures/phpspreadsheet/Translations.xlsx` must print `f89b2a3a4d24097d89f9d7eae93f957cd041664287e2f6a9cebaa01168b3d625`.

Download `packages/flux-import/tests/fixtures/phpspreadsheet/LICENSE` from https://raw.githubusercontent.com/PHPOffice/PhpSpreadsheet/1.30.1/LICENSE (`curl -sSfL --create-dirs -o packages/flux-import/tests/fixtures/phpspreadsheet/LICENSE https://raw.githubusercontent.com/PHPOffice/PhpSpreadsheet/1.30.1/LICENSE`); `sha256sum packages/flux-import/tests/fixtures/phpspreadsheet/LICENSE` must print `45ccc0b978c7b53f075fc3d90988ea1fcd5695ef622b2aaffa82ace8852ee342`.

The file is the one X4 describes; `tests/fixtures/xlsx.ts` (next step) records its provenance. Biome ignores both files (`biome.json` only checks code and JSON).

- [ ] **Step 2: Write the failing tests**

Create `packages/flux-import/tests/fixtures/xlsx.ts`:
```ts
import { readFileSync } from "node:fs";
import { product } from "./formats.js";
import { type ZipFile, zip } from "./zip.js";

/**
 * Workbooks for tests, built from parts that mirror what Microsoft Excel writes: an XML
 * declaration with CRLF, markup compatibility (`mc:Ignorable`) with `x14ac`/`xr` attributes,
 * shared strings with `count`/`uniqueCount`, styles with custom `numFmts`, rows with `spans` and
 * `x14ac:dyDescent`, and `xml:space="preserve"` on strings with outer spaces.
 */
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const X14AC = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac";
const XR = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";

export function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** A `<t>` element as Excel writes it: `xml:space="preserve"` only around outer whitespace. */
export function t(text: string): string {
	const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
	return `<t${preserve}>${xmlEscape(text)}</t>`;
}

export interface SheetSpec {
	name: string;
	/** The `<sheetData>` content: `<row>` elements. */
	rows: string;
	/** Extra worksheet content after `<sheetData>`, such as `<mergeCells>`. */
	after?: string;
}

export interface WorkbookSpec {
	sheets: SheetSpec[];
	/** `<si>` items, or plain strings written as `<si><t>…</t></si>`. */
	sharedStrings?: string[];
	/** Custom number formats by ID (164 and up). */
	numFmts?: Record<number, string>;
	/** The `numFmtId` of each cell style (`s`); style 0 is General. */
	cellXfs?: number[];
	date1904?: boolean;
	/** 8 (deflate, Excel's choice) or 0 (stored) for every part. */
	method?: 0 | 8;
}

function sheetXml(sheet: SheetSpec, index: number): string {
	return (
		`${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="${X14AC}" xmlns:xr="${XR}" xr:uid="{00000000-0001-0000-000${index}-000000000000}">` +
		'<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
		'<sheetFormatPr defaultRowHeight="14.4" x14ac:dyDescent="0.3"/>' +
		'<cols><col min="1" max="1" width="12.77734375" bestFit="1" customWidth="1"/></cols>' +
		(sheet.rows === "" ? "<sheetData/>" : `<sheetData>${sheet.rows}</sheetData>`) +
		(sheet.after ?? "") +
		'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
	);
}

function stylesXml(numFmts: Record<number, string>, cellXfs: number[]): string {
	const fmts = Object.entries(numFmts);
	return (
		`${DECL}<styleSheet xmlns="${MAIN}" xmlns:mc="${MC}" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="${X14AC}" xmlns:xr="${XR}">` +
		(fmts.length > 0
			? `<numFmts count="${fmts.length}">${fmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`).join("")}</numFmts>`
			: "") +
		'<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
		'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
		'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
		'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
		`<cellXfs count="${cellXfs.length}">${cellXfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id === 0 ? "" : ' applyNumberFormat="1"'}/>`).join("")}</cellXfs>` +
		'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/>' +
		'<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'
	);
}

/** Builds an `.xlsx` workbook from sheets, shared strings and styles. */
export async function workbook(spec: WorkbookSpec): Promise<Uint8Array<ArrayBuffer>> {
	const strings = spec.sharedStrings ?? [];
	const cellXfs = spec.cellXfs ?? [0];
	const sheetRels = spec.sheets.map(
		(_, i) =>
			`<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
	);
	const n = spec.sheets.length;
	const files: ZipFile[] = [
		{
			name: "[Content_Types].xml",
			data:
				`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				spec.sheets
					.map(
						(_, i) =>
							`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
					)
					.join("") +
				"</Types>",
		},
		{
			name: "_rels/.rels",
			data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		},
		{
			name: "xl/workbook.xml",
			data:
				`${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">` +
				'<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>' +
				`<workbookPr${spec.date1904 ? ' date1904="1"' : ""} defaultThemeVersion="166925"/>` +
				'<bookViews><workbookView xWindow="-108" yWindow="-108" windowWidth="23256" windowHeight="12456"/></bookViews>' +
				`<sheets>${spec.sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${n - i}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
				'<calcPr calcId="191029"/></workbook>',
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data:
				`${DECL}<Relationships xmlns="${PKG_REL}">` +
				`<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/>` +
				[...sheetRels].reverse().join("") +
				(strings.length > 0
					? `<Relationship Id="rId${n + 3}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`
					: "") +
				"</Relationships>",
		},
		...spec.sheets.map((sheet, i) => ({
			name: `xl/worksheets/sheet${i + 1}.xml`,
			data: sheetXml(sheet, i),
		})),
		{ name: "xl/styles.xml", data: stylesXml(spec.numFmts ?? {}, cellXfs) },
		...(strings.length > 0
			? [
					{
						name: "xl/sharedStrings.xml",
						data:
							`${DECL}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">` +
							strings.map((s) => (s.startsWith("<si>") ? s : `<si>${t(s)}</si>`)).join("") +
							"</sst>",
					},
				]
			: []),
		{
			name: "docProps/app.xml",
			data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`,
		},
	];
	const method = spec.method;
	return zip(method === undefined ? files : files.map((f) => ({ ...f, method })));
}

/** A row as Excel writes it, with `spans` and `x14ac:dyDescent`. */
export function row(r: number, cells: string, spans = "1:6"): string {
	return `<row r="${r}" spans="${spans}" x14ac:dyDescent="0.3">${cells}</row>`;
}

/** Days from Excel's 1900 epoch to an ISO date (after February 1900). */
export function serial(isoDate: string): number {
	return (Date.parse(`${isoDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/**
 * The products of `productsCsv` and `product()` as a workbook: sku, Name, Price (a number),
 * Released (a date cell, style 1 = built-in format 14), Active (a boolean) and Handle. Text goes
 * through shared strings, as Excel stores it.
 */
export async function productsXlsx(n: number): Promise<Uint8Array<ArrayBuffer>> {
	const strings = ["sku", "Name", "Price", "Released", "Active", "Handle"];
	const index = (s: string) => {
		strings.push(s);
		return strings.length - 1;
	};
	let rows = row(1, strings.map((_, i) => `<c r="${"ABCDEF"[i]}1" t="s"><v>${i}</v></c>`).join(""));
	for (let i = 0; i < n; i++) {
		const p = product(i);
		const r = i + 2;
		rows += row(
			r,
			`<c r="A${r}" t="s"><v>${index(p.sku)}</v></c>` +
				`<c r="B${r}" t="s"><v>${index(p.name)}</v></c>` +
				`<c r="C${r}"><v>${p.price}</v></c>` +
				`<c r="D${r}" s="1"><v>${serial(p.released)}</v></c>` +
				`<c r="E${r}" t="b"><v>${i % 2}</v></c>` +
				`<c r="F${r}" t="s"><v>${index(p.handle)}</v></c>`,
		);
	}
	return workbook({
		sheets: [{ name: "Products", rows }],
		sharedStrings: strings,
		cellXfs: [0, 14],
	});
}

/** Maps `productsXlsx` columns like the other formats' templates do. */
export function xlsxTemplate(collection: string, source: Record<string, unknown> = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format: "xlsx", ...source },
		key: { from: "sku" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			released: { from: "Released", type: "date", tz: "Europe/Chisinau" },
		},
	};
}

/**
 * A workbook saved by Microsoft Excel (its docProps/app.xml says so): `Translations.xlsx` from
 * PhpSpreadsheet 1.30.1 (https://github.com/PHPOffice/PhpSpreadsheet, file
 * src/PhpSpreadsheet/Calculation/locale/Translations.xlsx at tag 1.30.1), SHA-256
 * f89b2a3a4d24097d89f9d7eae93f957cd041664287e2f6a9cebaa01168b3d625, MIT licensed (the license
 * is next to it). Two sheets of shared strings, with comments, VML drawings, web extensions and
 * printer settings in the archive.
 */
export function excelTranslations(): Uint8Array {
	return new Uint8Array(
		readFileSync(new URL("./phpspreadsheet/Translations.xlsx", import.meta.url)),
	);
}
```

Create `packages/flux-import/tests/unit/xlsx.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseJsonRecord } from "../../src/sources/json.js";
import { columnName, excelDate, openXlsx, type XlsxOptions } from "../../src/sources/xlsx.js";
import { XlsxError } from "../../src/sources/zip.js";
import {
	excelTranslations,
	productsXlsx,
	row,
	t,
	type WorkbookSpec,
	workbook,
} from "../fixtures/xlsx.js";
import { collect } from "./helpers.js";

async function convert(rows: string, options: XlsxOptions = {}, spec: Partial<WorkbookSpec> = {}) {
	const bytes = await workbook({ sheets: [{ name: "Sheet1", rows }], ...spec });
	const sheet = await openXlsx(bytes, options);
	const lines = await collect(sheet.lines);
	return {
		columns: sheet.columns,
		lines,
		records: lines.map((line) => parseJsonRecord(new TextEncoder().encode(line)).value),
		warnings: sheet.warnings(),
	};
}

async function failure(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(XlsxError);
	return (error as XlsxError).message;
}

const HEADER = row(
	1,
	'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c>',
);
const value = async (cell: string, spec: Partial<WorkbookSpec> = {}) => {
	const { records } = await convert(
		HEADER + row(2, `<c r="A2" t="inlineStr"><is><t>k</t></is></c>${cell}`),
		{},
		spec,
	);
	return (records[0] as Record<string, unknown>).Value;
};

describe("excelDate", () => {
	it.each([
		[1, false, "1900-01-01"],
		[59, false, "1900-02-28"],
		[61, false, "1900-03-01"],
		[45_352, false, "2024-03-01"],
		[45_352.5, false, "2024-03-01T12:00:00"],
		[45_352.000_011_574, false, "2024-03-01T00:00:01"],
		[0.75, false, "1899-12-31T18:00:00"],
		[0, true, "1904-01-01"],
		[43_890, true, "2024-03-01"],
		[2_958_465, false, "9999-12-31"],
	])("serial %d (1904: %s) is %s", (serial, date1904, iso) => {
		expect(excelDate(serial, date1904)).toBe(iso);
	});

	it("gives null for the 29 February 1900 that never was, negative serials and years past 9999", () => {
		expect(excelDate(60, false)).toBeNull();
		expect(excelDate(60.5, false)).toBeNull();
		expect(excelDate(60, true)).toBe("1904-03-01");
		expect(excelDate(-1, false)).toBeNull();
		expect(excelDate(2_958_466, false)).toBeNull();
		expect(excelDate(Number.NaN, false)).toBeNull();
	});
});

describe("columnName", () => {
	it.each([
		[0, "A"],
		[25, "Z"],
		[26, "AA"],
		[701, "ZZ"],
		[702, "AAA"],
		[16_383, "XFD"],
	])("%d is %s", (index, name) => {
		expect(columnName(index)).toBe(name);
	});
});

describe("openXlsx cell values", () => {
	it("reads shared, rich and inline strings, keeping spaces and decoding escapes", async () => {
		const strings = [
			"sku",
			"Value",
			"k",
			'<si><r><rPr><b/><sz val="11"/></rPr><t>Bold</t></r><r><t xml:space="preserve"> plain</t></r></si>',
			"  padded  ",
			"Line_x000D_\nbreak",
		];
		const header = row(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>');
		const { records } = await convert(
			header +
				row(2, '<c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c>') +
				row(3, '<c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>4</v></c>') +
				row(4, '<c r="A4" t="s"><v>2</v></c><c r="B4" t="s"><v>5</v></c>') +
				row(5, `<c r="A5" t="s"><v>2</v></c><c r="B5" t="inlineStr"><is>${t(" inline ")}</is></c>`),
			{},
			{ sharedStrings: strings },
		);
		expect(records.map((r) => (r as Record<string, unknown>).Value)).toEqual([
			"Bold plain",
			"  padded  ",
			"Line\r\nbreak",
			" inline ",
		]);
	});

	it("reads booleans, errors, ISO date cells and formulas with and without cached values", async () => {
		expect(await value('<c r="B2" t="b"><v>1</v></c>')).toBe(true);
		expect(await value('<c r="B2" t="b"><v>0</v></c>')).toBe(false);
		expect(await value('<c r="B2" t="e"><v>#N/A</v></c>')).toBeNull();
		expect(await value('<c r="B2" t="e"><f>1/0</f><v>#DIV/0!</v></c>')).toBeNull();
		expect(await value('<c r="B2" t="d"><v>2026-03-01T10:30:00</v></c>')).toBe(
			"2026-03-01T10:30:00",
		);
		expect(await value('<c r="B2"><f>SUM(1,2)</f><v>3</v></c>')).toBe(3);
		expect(await value('<c r="B2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>')).toBe("ab");
		expect(await value('<c r="B2"><f>NOW()</f></c>')).toBeNull();
		expect(await value('<c r="B2" t="str"><f>A1</f></c>')).toBeNull();
		expect(await value('<c r="B2" s="0"/>')).toBeNull();
	});

	it("writes numbers as their exact text, so large integers stay exact", async () => {
		const header = row(
			1,
			'<c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>n</t></is></c>',
		);
		const { lines, records } = await convert(
			header +
				row(2, '<c r="A2"><v>12345678901234567890</v></c><c r="B2"><v>0.1</v></c>') +
				row(3, '<c r="A3"><v>-1.5E-3</v></c><c r="B3"><v>1E+21</v></c>'),
		);
		expect(lines[0]).toBe('{"id":12345678901234567890,"n":0.1,"_row":2}');
		expect(records).toEqual([
			{ id: "12345678901234567890", n: 0.1, _row: 2 },
			{ id: -0.0015, n: 1e21, _row: 3 },
		]);
	});

	it("turns dates into ISO text by the cell's number format, in the 1900 or 1904 system", async () => {
		const spec: Partial<WorkbookSpec> = {
			numFmts: { 164: "yyyy\\-mm\\-dd\\ hh:mm;@", 165: "[h]:mm", 166: '0.0 "days"' },
			cellXfs: [0, 14, 164, 165, 166, 22],
		};
		expect(await value('<c r="B2" s="1"><v>45352</v></c>', spec)).toBe("2024-03-01");
		expect(await value('<c r="B2" s="2"><v>45352.75</v></c>', spec)).toBe("2024-03-01T18:00:00");
		expect(await value('<c r="B2" s="5"><v>45352.5</v></c>', spec)).toBe("2024-03-01T12:00:00");
		// Elapsed time and quoted text stay numbers.
		expect(await value('<c r="B2" s="3"><v>1.5</v></c>', spec)).toBe(1.5);
		expect(await value('<c r="B2" s="4"><v>2</v></c>', spec)).toBe(2);
		expect(await value('<c r="B2" s="1"><v>43890</v></c>', { ...spec, date1904: true })).toBe(
			"2024-03-01",
		);
	});

	it("reads serials around Excel's 1900 leap-year bug, and counts 29 February 1900 as unreadable", async () => {
		const header = row(1, '<c r="A1" t="inlineStr"><is><t>d</t></is></c>');
		const { records, warnings } = await convert(
			header +
				row(2, '<c r="A2" s="1"><v>59</v></c>') +
				row(3, '<c r="A3" s="1"><v>60</v></c>') +
				row(4, '<c r="A4" s="1"><v>61</v></c>'),
			{},
			{ cellXfs: [0, 14] },
		);
		expect(records).toEqual([
			{ d: "1900-02-28", _row: 2 },
			{ d: "1900-03-01", _row: 4 },
		]);
		expect(warnings).toEqual(["1 cell could not be read and was imported as empty"]);
	});

	it("imports unreadable cells as empty and counts them in one warning", async () => {
		const { records, warnings } = await convert(
			HEADER +
				row(2, '<c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" t="s"><v>99</v></c>') +
				row(3, '<c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3" t="b"><v>2</v></c>') +
				row(4, '<c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4"><v>.5</v></c>') +
				row(5, '<c r="A5" t="inlineStr"><is><t>d</t></is></c><c r="B5" t="x"><v>1</v></c>'),
		);
		expect(records.map((r) => (r as Record<string, unknown>).Value)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(warnings).toEqual(["4 cells could not be read and were imported as empty"]);
	});
});

describe("openXlsx rows and headers", () => {
	it("places sparse cells by reference and cells without one after the previous cell", async () => {
		const { columns, records } = await convert(
			row(
				1,
				'<c r="A1" t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c><c r="D1" t="inlineStr"><is><t>d</t></is></c>',
			) +
				row(2, '<c r="B2"><v>2</v></c><c><v>3</v></c>') +
				'<row><c><v>1</v></c><c r="D3"><v>4</v></c></row>',
		);
		expect(columns).toEqual(["a", "b", "column_C", "d"]);
		expect(records).toEqual([
			{ a: null, b: 2, column_C: 3, d: null, _row: 2 },
			{ a: 1, b: null, column_C: null, d: 4, _row: 3 },
		]);
	});

	it("names empty headers by column, numbers repeats, and warns about each rename", async () => {
		const { columns, warnings } = await convert(
			row(
				1,
				'<c r="A1" t="inlineStr"><is><t> Price </t></is></c><c r="B1" t="inlineStr"><is><t>   </t></is></c><c r="C1" t="inlineStr"><is><t>Price</t></is></c><c r="D1" t="inlineStr"><is><t>Price_2</t></is></c><c r="E1"><v>2026</v></c><c r="F1" t="inlineStr"><is><t>Price</t></is></c>',
			),
		);
		expect(columns).toEqual(["Price", "column_B", "Price_2", "Price_2_2", "2026", "Price_3"]);
		expect(warnings).toEqual([
			'Column B has no header; it is named "column_B"',
			'The header "Price" in column C repeats; it is named "Price_2"',
			'The header "Price_2" in column D repeats; it is named "Price_2_2"',
			'The header "Price" in column F repeats; it is named "Price_3"',
		]);
	});

	it("adds _row unless a header is named _row", async () => {
		const plain = await convert(HEADER + row(7, '<c r="A7" t="inlineStr"><is><t>k</t></is></c>'));
		expect(plain.records).toEqual([{ sku: "k", Value: null, _row: 7 }]);
		const named = await convert(
			row(1, '<c r="A1" t="inlineStr"><is><t>_row</t></is></c>') +
				row(2, '<c r="A2"><v>42</v></c>'),
		);
		expect(named.lines).toEqual(['{"_row":42}']);
	});

	it("skips rows above the header and rows without values, and ignores cells right of the header", async () => {
		const { records, warnings } = await convert(
			row(1, '<c r="A1" t="inlineStr"><is><t>Report</t></is></c>') +
				row(2, '<c r="A2"><v>1</v></c><c r="B2"><v>1</v></c>') +
				HEADER.replace(/r="1"/, 'r="3"').replace(/A1/, "A3").replace(/B1/, "B3") +
				row(4, '<c r="A4" s="0"/><c r="B4" t="e"><v>#N/A</v></c>') +
				row(5, '<c r="C5"><v>9</v></c>') +
				row(
					6,
					'<c r="A6" t="inlineStr"><is><t>k</t></is></c><c r="C6"><v>1</v></c><c r="D6"><v>2</v></c>',
				),
			{ headerRow: 3 },
		);
		expect(records).toEqual([{ sku: "k", Value: null, _row: 6 }]);
		expect(warnings).toEqual(["3 cells right of the last header column (B) were ignored"]);
	});

	it("keeps a merged cell's value in its top-left cell only", async () => {
		const bytes = await workbook({
			sheets: [
				{
					name: "Merged",
					rows:
						HEADER +
						row(2, '<c r="A2" t="inlineStr"><is><t>span</t></is></c><c r="B2" s="0"/>') +
						row(3, '<c r="A3" s="0"/><c r="B3" t="inlineStr"><is><t>x</t></is></c>'),
					after: '<mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>',
				},
			],
		});
		const sheet = await openXlsx(bytes);
		expect(await collect(sheet.lines)).toEqual([
			'{"sku":"span","Value":null,"_row":2}',
			'{"sku":null,"Value":"x","_row":3}',
		]);
	});

	it("refuses a missing or empty header row, rows out of order and columns past XFD", async () => {
		expect(await failure(convert(HEADER, { headerRow: 3 }))).toBe(
			'The sheet "Sheet1" has no row 3',
		);
		expect(await failure(convert(""))).toBe('The sheet "Sheet1" has no row 1');
		expect(await failure(convert(row(2, '<c r="A2"><v>1</v></c>')))).toBe(
			'Header row 1 of the sheet "Sheet1" is empty',
		);
		expect(await failure(convert(row(1, '<c r="A1" t="e"><v>#REF!</v></c>')))).toBe(
			'Header row 1 of the sheet "Sheet1" is empty',
		);
		expect(await failure(convert(HEADER + row(3, "") + row(2, "")))).toBe(
			"Row 2 comes after row 3; rows must be in order",
		);
		expect(await failure(convert(HEADER + row(2, '<c r="XFE2"><v>1</v></c>')))).toBe(
			"A cell in column XFE is past column XFD, the last column Excel has",
		);
		expect(await failure(convert(HEADER + row(1_048_577, "")))).toBe(
			"Row 1048577 is past row 1,048,576, the last row Excel has",
		);
		expect(await failure(convert(`${HEADER}<row r="2"><c><v>&nbsp;</v></c></row>`))).toBe(
			"The part xl/worksheets/sheet1.xml has a row after row 1 that is not valid XML",
		);
	});

	it("reads an empty <sheetData/>, as Excel writes an empty sheet, as a sheet without rows", async () => {
		const bytes = await workbook({ sheets: [{ name: "Empty", rows: "" }] });
		expect(await failure(openXlsx(bytes))).toBe('The sheet "Empty" has no row 1');
	});

	it("picks a sheet by name or position, and stores parts uncompressed too", async () => {
		const bytes = await workbook({
			sheets: [
				{ name: "First", rows: row(1, '<c r="A1" t="inlineStr"><is><t>one</t></is></c>') },
				{ name: "Second", rows: row(1, '<c r="A1" t="inlineStr"><is><t>two</t></is></c>') },
			],
			method: 0,
		});
		expect((await openXlsx(bytes)).columns).toEqual(["one"]);
		expect((await openXlsx(bytes, { sheet: "second" })).columns).toEqual(["two"]);
		expect((await openXlsx(bytes, { sheet: 2 })).columns).toEqual(["two"]);
		expect(await failure(openXlsx(bytes, { sheet: 3 }))).toBe(
			"The workbook has 2 worksheets; there is no sheet 3",
		);
	});
});

describe("openXlsx on workbooks", () => {
	it("converts the products workbook", async () => {
		const sheet = await openXlsx(await productsXlsx(3));
		expect(sheet.columns).toEqual(["sku", "Name", "Price", "Released", "Active", "Handle"]);
		expect(await collect(sheet.lines)).toEqual([
			'{"sku":"SKU-0","Name":"Product 0, \\"quoted\\" & <tagged> ț","Price":0.5,"Released":"2026-03-01","Active":false,"Handle":"product-0","_row":2}',
			'{"sku":"SKU-1","Name":"Product 1, \\"quoted\\" & <tagged> ț","Price":1.5,"Released":"2026-03-02","Active":true,"Handle":"product-1","_row":3}',
			'{"sku":"SKU-2","Name":"Product 2, \\"quoted\\" & <tagged> ț","Price":2.5,"Released":"2026-03-03","Active":false,"Handle":"product-2","_row":4}',
		]);
		expect(sheet.warnings()).toEqual([]);
	});

	it("reads a workbook saved by Microsoft Excel", async () => {
		const bytes = excelTranslations();
		const first = await openXlsx(bytes);
		expect(first.columns.slice(0, 4)).toEqual(["column_A", "en", "eu", "ca"]);
		expect(first.warnings()).toEqual(['Column A has no header; it is named "column_A"']);
		const functions = await openXlsx(bytes, { sheet: "Excel Functions" });
		expect(functions.columns.slice(0, 4)).toEqual(["CATEGORY:", "en", "pt_br", "pt"]);
		const records = (await collect(functions.lines)).map((line) => JSON.parse(line));
		// 537 <row> elements: the header and 536 rows with values (Excel leaves out empty rows).
		expect(records).toHaveLength(536);
		expect(records[0]).toMatchObject({ "CATEGORY:": null, pt_br: "Português Brasileiro", _row: 2 });
		expect(records[3]).toMatchObject({
			"CATEGORY:": null,
			en: "CUBEKPIMEMBER",
			ru: "КУБЭЛЕМЕНТКИП",
			_row: 5,
		});
		expect(records.at(-1)).toMatchObject({ en: "ZTEST", pl: "TEST.Z", _row: 550 });
		expect(functions.warnings()).toEqual([]);
	});

	it("refuses files that are not workbooks", async () => {
		expect(await failure(openXlsx(new TextEncoder().encode("sku,Name\n")))).toBe(
			"The file is not an .xlsx workbook (it is not a zip archive)",
		);
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xlsx.test.ts`
Expected: FAIL — `xlsx.test.ts` cannot load `../../src/sources/xlsx.js` (no tests run).

- [ ] **Step 4: Implement the converter**

Create `packages/flux-import/src/sources/xlsx.ts`:
```ts
import { shortName, XLSX_MAX_ROWS, XLSX_ROW_FIELD } from "./reader.js";
import {
	attr,
	chooseSheet,
	partElements,
	readDateStyles,
	readSharedStrings,
	readWorkbook,
	richText,
	unescapeText,
	type XmlElement,
} from "./xlsx-workbook.js";
import { XlsxError, ZipArchive } from "./zip.js";

/** Excel's last column, XFD. */
export const XLSX_MAX_COLUMNS = 16_384;

export interface XlsxOptions {
	/** A sheet name or 1-based position; the first worksheet by default. */
	sheet?: string | number | undefined;
	/** The 1-based header row; 1 by default. */
	headerRow?: number | undefined;
}

/** One sheet being converted to JSON Lines. */
export interface XlsxSheet {
	/** The header names, after naming empty headers and numbering repeated ones. */
	columns: string[];
	/** One JSON Lines record per data row with a value, without the line break. */
	lines: AsyncGenerator<string>;
	/** Header renames, then cells ignored or unreadable so far: all of them once `lines` is done. */
	warnings(): string[];
}

/** A cell's value as JSON text, and as text for a header. */
interface Cell {
	json: string;
	text: string;
}

const UNREADABLE = Symbol("unreadable");

interface Row {
	number: number;
	/** Cells with a value, by 0-based column; `UNREADABLE` for a value that cannot be read. */
	cells: Map<number, Cell | typeof UNREADABLE>;
}
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const CELL_REF = /^([A-Z]{1,3})(\d+)$/;
const DAY_SECONDS = 86_400;
/** Serial 0 of the 1900 system is 1899-12-31 ("1900-01-00"); of the 1904 system, 1904-01-01. */
const EPOCH_1900 = Date.UTC(1899, 11, 31);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const YEAR_MAX = 9999;

/** "A" for 0, "Z" for 25, "AA" for 26. */
export function columnName(index: number): string {
	let name = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	}
	return name;
}

function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/**
 * A serial date as ISO 8601 text without a zone: the date alone at midnight, else with the time
 * to the second. The 1900 system repeats Excel's leap-year bug: serial 60 is 29 February 1900,
 * which did not exist, so it gives null and later serials are a day behind. Null too for
 * negative serials and years after 9999.
 */
export function excelDate(serial: number, date1904: boolean): string | null {
	if (!Number.isFinite(serial) || serial < 0) return null;
	let days = serial;
	if (!date1904) {
		if (serial >= 60 && serial < 61) return null;
		if (serial >= 61) days -= 1;
	}
	const ms = (date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(days * DAY_SECONDS) * 1000;
	const date = new Date(ms);
	if (date.getUTCFullYear() > YEAR_MAX) return null;
	const iso = date.toISOString();
	return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19);
}

function textOf(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (typeof v === "object" && v !== null && !Array.isArray(v)) {
		const text = (v as XmlElement)["#text"];
		return typeof text === "string" ? text : "";
	}
	return undefined;
}

const text = (value: string): Cell => ({ json: JSON.stringify(value), text: value });

function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

class SheetConverter {
	unreadable = 0;
	ignored = 0;

	constructor(
		private readonly part: string,
		private readonly strings: (string | null)[],
		private readonly dateStyles: boolean[],
		private readonly date1904: boolean,
	) {}

	/** A cell's value: null when it has none, `UNREADABLE` when it has one that cannot be read. */
	value(cell: XmlElement): Cell | null | typeof UNREADABLE {
		const v = textOf(cell.v);
		switch (attr(cell, "t") ?? "n") {
			case "s": {
				const s = v === undefined ? undefined : this.strings[Number(v)];
				return typeof s === "string" ? text(s) : UNREADABLE;
			}
			case "inlineStr":
				return cell.is === undefined ? null : text(richText(cell.is));
			case "str":
				return v === undefined ? null : text(unescapeText(v));
			case "b":
				if (v === undefined) return null;
				if (v === "1" || v === "true") return { json: "true", text: "true" };
				if (v === "0" || v === "false") return { json: "false", text: "false" };
				return UNREADABLE;
			case "e":
				return null;
			case "d":
				return v === undefined || v === "" ? null : text(v);
			case "n": {
				if (v === undefined || v === "") return null;
				if (!JSON_NUMBER.test(v)) return UNREADABLE;
				if (!this.dateStyles[Number(attr(cell, "s") ?? 0)]) return { json: v, text: v };
				const iso = excelDate(Number(v), this.date1904);
				return iso === null ? UNREADABLE : text(iso);
			}
			default:
				return UNREADABLE;
		}
	}

	/** The cells of one `<row>`: placed by their reference, or after the previous cell without one. */
	cells(row: XmlElement): Map<number, Cell | typeof UNREADABLE> {
		const cells = new Map<number, Cell | typeof UNREADABLE>();
		const list = row.c === undefined ? [] : Array.isArray(row.c) ? row.c : [row.c];
		let column = -1;
		for (const item of list) {
			const cell: XmlElement =
				typeof item === "object" && item !== null ? (item as XmlElement) : {};
			const ref = CELL_REF.exec(attr(cell, "r") ?? "");
			column = ref ? columnIndex(ref[1] as string) : column + 1;
			if (column >= XLSX_MAX_COLUMNS) {
				throw new XlsxError(
					`A cell in column ${columnName(column)} is past column XFD, the last column Excel has`,
				);
			}
			const value = this.value(cell);
			if (value !== null) cells.set(column, value);
		}
		return cells;
	}

	/** The sheet's rows in order, each numbered by its `r` or as the row after the previous one. */
	async *rows(parts: ZipArchive): AsyncGenerator<Row> {
		let previous = 0;
		for await (const row of partElements(parts, this.part, "worksheet/sheetData/row", {
			optional: true,
		})) {
			if (row === null) {
				throw new XlsxError(
					`The part ${this.part} has a row after row ${previous} that is not valid XML`,
				);
			}
			const r = Number(attr(row, "r") ?? Number.NaN);
			const number = Number.isInteger(r) && r > 0 ? r : previous + 1;
			if (number > XLSX_MAX_ROWS) {
				throw new XlsxError(`Row ${number} is past row 1,048,576, the last row Excel has`);
			}
			if (number <= previous) {
				throw new XlsxError(`Row ${number} comes after row ${previous}; rows must be in order`);
			}
			previous = number;
			yield { number, cells: this.cells(row) };
		}
	}
}

/**
 * Names the header row's columns: trimmed text, `column_<letter>` for an empty one, `_2`, `_3`, …
 * added to a repeated one. Returns the names and a warning for each rename.
 */
function headerNames(
	cells: Map<number, Cell | typeof UNREADABLE>,
	width: number,
): { names: string[]; renames: string[] } {
	const names: string[] = [];
	const renames: string[] = [];
	const used = new Set<string>();
	for (let i = 0; i < width; i++) {
		const letter = columnName(i);
		const cell = cells.get(i);
		let name = cell === undefined || cell === UNREADABLE ? "" : cell.text.trim();
		if (name === "") {
			name = `column_${letter}`;
			renames.push(`Column ${letter} has no header; it is named "${name}"`);
		}
		if (used.has(name)) {
			let n = 2;
			while (used.has(`${name}_${n}`)) n++;
			const renamed = `${name}_${n}`;
			renames.push(
				`The header "${shortName(name)}" in column ${letter} repeats; it is named "${shortName(renamed)}"`,
			);
			name = renamed;
		}
		used.add(name);
		names.push(name);
	}
	return { names, renames };
}

/**
 * Opens one sheet of an `.xlsx` workbook held in memory and reads up to its header row. The
 * returned `lines` convert the rows below it, one at a time: an object of header name to cell
 * value (`null` for an empty cell) plus `_row`, the sheet's row number, unless a header is named
 * `_row`. Rows without values are skipped; cells right of the last header are ignored.
 */
export async function openXlsx(bytes: Uint8Array, options: XlsxOptions = {}): Promise<XlsxSheet> {
	const zip = ZipArchive.open(bytes);
	const workbook = await readWorkbook(zip);
	const sheet = chooseSheet(workbook, options.sheet);
	const strings = workbook.sharedStrings
		? await readSharedStrings(zip, workbook.sharedStrings)
		: [];
	const dateStyles = workbook.styles ? await readDateStyles(zip, workbook.styles) : [];
	const converter = new SheetConverter(sheet.part, strings, dateStyles, workbook.date1904);
	const headerRow = options.headerRow ?? 1;
	const rows = converter.rows(zip);

	let header: Row | undefined;
	for (;;) {
		const next = await rows.next();
		if (next.done) {
			await rows.return(undefined);
			throw new XlsxError(`The sheet "${shortName(sheet.name)}" has no row ${headerRow}`);
		}
		if (next.value.number < headerRow) continue;
		if (next.value.number === headerRow) header = next.value;
		break;
	}
	const named = header
		? [...header.cells].filter(([, c]) => c !== UNREADABLE && c.text.trim() !== "")
		: [];
	if (!header || named.length === 0) {
		await rows.return(undefined);
		throw new XlsxError(`Header row ${headerRow} of the sheet "${shortName(sheet.name)}" is empty`);
	}
	// The header ends at its last named column; an unreadable header cell counts as empty.
	const width = Math.max(...named.map(([column]) => column)) + 1;
	for (const [column, cell] of header.cells) {
		if (cell === UNREADABLE && column < width) converter.unreadable++;
	}
	const { names, renames } = headerNames(header.cells, width);
	const keys = names.map((name) => `${JSON.stringify(name)}:`);
	const rowField = names.includes(XLSX_ROW_FIELD) ? "" : `,${JSON.stringify(XLSX_ROW_FIELD)}:`;

	async function* lines(): AsyncGenerator<string> {
		try {
			for await (const row of rows) {
				const values: string[] = new Array(width).fill("null");
				let any = false;
				for (const [column, cell] of row.cells) {
					if (column >= width) {
						converter.ignored++;
					} else if (cell === UNREADABLE) {
						converter.unreadable++;
					} else {
						values[column] = cell.json;
						any = true;
					}
				}
				if (!any) continue;
				const fields = keys.map((key, i) => key + values[i]).join(",");
				yield `{${fields}${rowField === "" ? "" : rowField + row.number}}`;
			}
		} finally {
			await rows.return(undefined);
		}
	}

	return {
		columns: names,
		lines: lines(),
		warnings: () => [
			...renames,
			...(converter.ignored > 0
				? [
						`${plural(converter.ignored, "cell", "cells")} right of the last header column (${columnName(width - 1)}) ${converter.ignored === 1 ? "was" : "were"} ignored`,
					]
				: []),
			...(converter.unreadable > 0
				? [
						`${plural(converter.unreadable, "cell", "cells")} could not be read and ${converter.unreadable === 1 ? "was" : "were"} imported as empty`,
					]
				: []),
		],
	};
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xlsx.test.ts`
Expected: PASS (34 tests, about 0.3 s). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 34 files / 888 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/sources/xlsx.ts packages/flux-import/tests/fixtures packages/flux-import/tests/unit/xlsx.test.ts
git commit -m "Convert one sheet of a workbook to JSON Lines with typed cells, dates and named headers"
```

### Task 5: Conversion at job creation and sampling

**Files:**
- Create: `packages/flux-import/src/plugin/xlsx.ts`
- Modify: `packages/flux-import/src/plugin/routes.ts`
- Test: `packages/flux-import/tests/unit/xlsx-import.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 (`StartJobInput` with `sourceUploadId`/`columns`/`warnings`, `sourceSchema`, `checkSource`, `XLSX_MAX_BYTES`, `maxXlsxBytes`, `Job.sourceUploadId`, `releaseUploadIfUnused`); Task 4 (`openXlsx`, `XlsxSheet`; tests: `productsXlsx`, `workbook`, `row`, `xlsxTemplate`); Task 1 (`XlsxError`); M3c `FetchLimits`/`FETCH_LIMITS`, `stageUpload`, `EmDashUploads`, `chunksOf`, `parseJsonRecord`, `ServiceError`, `sampleSource`, `startJob`, `SAMPLE_MAX`, `onWorkers`; E2.
- Produces (`src/plugin/xlsx.ts`):
  - `const XLSX_WORKERS_BUFFER = 32 * 1024 * 1024`
  - `interface XlsxLimits { maxXlsxBytes: number; maxSourceBytes: number; workers: boolean; bufferBytes: number }`; `interface XlsxStaging extends XlsxLimits { storage: UploadStorage }`
  - `xlsxSource(template: unknown): TemplateSource | null`; `fetchLimitsFor(template: unknown, limits: FetchLimits, maxXlsxBytes: number): FetchLimits`
  - `readWorkbookFile(source: SourcePort, uploadId: string, maxBytes: number): Promise<Uint8Array>`
  - `interface ConvertedSheet { uploadId: string; columns: string[]; warnings: string[] }`; `convertXlsx(deps: Pick<EngineDeps, "source">, staging: XlsxStaging, uploadId: string, source: TemplateSource): Promise<ConvertedSheet>`
  - `startImport(deps: EngineDeps, staging: XlsxStaging, input: StartJobInput, lookupFields: FieldLookup, resolveLocale?: LocaleResolver): Promise<Job>`
  - `sampleImport(deps: EngineDeps, limits: XlsxLimits, uploadId: string, n: number, source?: TemplateSource): Promise<CsvSample | ValueSample>`
- Produces (`src/plugin/routes.ts`): `Services.xlsx: XlsxStaging`; `sources/sample` calls `sampleImport`; `jobs/create` calls `startImport`, and with `sourceId` passes `fetchLimitsFor(...)`.

The tests stage workbooks into a `FakeStorage` through `stageUpload` and read them back through `EmDashUploads`, as the routes do.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/xlsx-import.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { XLSX_MAX_BYTES } from "../../src/astro/config.js";
import { EmDashUploads, stageUpload } from "../../src/emdash/uploads.js";
import { JobError } from "../../src/engine/jobs.js";
import { nextBatch, ServiceError } from "../../src/plugin/service.js";
import {
	fetchLimitsFor,
	sampleImport,
	startImport,
	XLSX_WORKERS_BUFFER,
	type XlsxStaging,
	xlsxSource,
} from "../../src/plugin/xlsx.js";
import { FETCH_LIMITS } from "../../src/sources/fetcher.js";
import { productsXlsx, row, workbook, xlsxTemplate } from "../fixtures/xlsx.js";
import { FakeStorage, makeDeps } from "./fakes.js";
import { streamOf } from "./helpers.js";

const MIB = 1024 * 1024;
const fields = async (collection: string) =>
	collection === "products"
		? [
				{ slug: "title", type: "string" },
				{ slug: "price", type: "number" },
				{ slug: "released", type: "datetime" },
			]
		: null;

function setup(limits: Partial<XlsxStaging> = {}) {
	const storage = new FakeStorage();
	const uploads = new EmDashUploads(storage);
	const deps = { ...makeDeps().deps, source: uploads };
	const staging: XlsxStaging = {
		storage,
		maxXlsxBytes: XLSX_MAX_BYTES,
		maxSourceBytes: 50 * MIB,
		workers: false,
		bufferBytes: XLSX_WORKERS_BUFFER,
		...limits,
	};
	const stage = async (bytes: Uint8Array) =>
		(await stageUpload(storage, streamOf(bytes), 100 * MIB, bytes.length)).uploadId;
	const text = async (uploadId: string) => new Response(await uploads.open(uploadId, 0)).text();
	return { deps, storage, uploads, staging, stage, text };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
}

describe("startImport", () => {
	it("converts the sheet, imports the copy, and keeps the workbook as sourceUploadId", async () => {
		const { deps, storage, uploads, staging, stage, text } = setup();
		const book = await stage(await productsXlsx(3));
		const job = await startImport(
			deps,
			staging,
			{ uploadId: book, template: xlsxTemplate("products"), dryRun: false },
			fields,
		);
		expect(job).toMatchObject({
			sourceUploadId: book,
			source: { format: "xlsx" },
			columns: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			warnings: [],
			cursor: { offset: 0, seq: 0 },
		});
		expect(job.uploadId).not.toBe(book);
		expect((await text(job.uploadId)).split("\n")[0]).toBe(
			'{"sku":"SKU-0","Name":"Product 0, \\"quoted\\" & <tagged> ț","Price":0.5,"Released":"2026-03-01","Active":false,"Handle":"product-0","_row":2}',
		);
		const done = await nextBatch(deps, uploads, job.id, "h");
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		const entry = [...deps.content.entries.values()][0];
		expect(entry?.data).toMatchObject({
			flux_source_id: "SKU-0",
			title: 'Product 0, "quoted" & <tagged> ț',
			price: 0.5,
			released: "2026-02-28T22:00:00.000Z",
		});
		// The finished job released the converted copy and the uploaded workbook.
		expect(storage.files.size).toBe(0);
	});

	it("stores the conversion's warnings before the job's own", async () => {
		const { deps, staging, stage } = setup();
		const book = await stage(
			await workbook({
				sheets: [
					{
						name: "Sheet1",
						rows:
							row(
								1,
								'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="C1" t="inlineStr"><is><t>Name</t></is></c>',
							) + row(2, '<c r="A2" t="inlineStr"><is><t>A1</t></is></c><c r="D2"><v>1</v></c>'),
					},
				],
			}),
		);
		const template = {
			...xlsxTemplate("products"),
			slug: undefined,
			fields: { title: { from: "Name", type: "text" } },
		};
		const job = await startImport(
			deps,
			staging,
			{ uploadId: book, template, dryRun: true },
			fields,
		);
		expect(job.warnings).toEqual([
			'Column B has no header; it is named "column_B"',
			"1 cell right of the last header column (C) was ignored",
		]);
	});

	it("fails job creation with invalid_source for a conversion problem, staging nothing", async () => {
		const { deps, storage, staging, stage } = setup();
		const csv = await stage(new TextEncoder().encode("sku,Name\nA1,Desk\n"));
		const notXlsx = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: csv, template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(notXlsx).toBeInstanceOf(JobError);
		expect(notXlsx).toMatchObject({
			code: "invalid_source",
			message: "The file is not an .xlsx workbook (it is not a zip archive)",
		});
		const book = await stage(await productsXlsx(1));
		const noSheet = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products", { sheet: "Stock" }), dryRun: false },
				fields,
			),
		);
		expect(noSheet).toMatchObject({
			code: "invalid_source",
			message: 'The workbook has no sheet named "Stock"; its sheets are "Products"',
		});
		expect(storage.files.size).toBe(2);
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("deletes the converted copy when the job cannot be created", async () => {
		const { deps, storage, staging, stage } = setup();
		const book = await stage(await productsXlsx(1));
		const template = xlsxTemplate("products");
		template.fields.title.from = "Title";
		const error = await failure(
			startImport(deps, staging, { uploadId: book, template, dryRun: false }, fields),
		);
		expect(error).toMatchObject({
			code: "invalid_template",
			details: ['Column "Title" not found in the source'],
		});
		expect(storage.files.size).toBe(1);
	});

	it("leaves templates of other formats, and invalid XLSX blocks, to startJob", async () => {
		const { deps, staging, stage } = setup();
		const book = await stage(await productsXlsx(1));
		const error = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products", { records: "x" }), dryRun: false },
				fields,
			),
		);
		expect(error).toMatchObject({
			code: "invalid_source",
			details: ["source.records is not allowed for xlsx"],
		});
	});

	it("refuses a workbook over the XLSX file limit with TOO_LARGE", async () => {
		const { deps, staging, stage } = setup({ maxXlsxBytes: 1000 });
		const book = await stage(await productsXlsx(5));
		const error = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(error).toBeInstanceOf(ServiceError);
		expect(error).toMatchObject({
			code: "TOO_LARGE",
			status: 413,
			message: "XLSX files are limited to 1000 bytes",
		});
	});

	it("refuses converted lines over maxSourceBytes, and over the buffer on Workers", async () => {
		const bytes = await productsXlsx(50);
		const node = setup({ maxSourceBytes: 2000 });
		const tooLarge = await failure(
			startImport(
				node.deps,
				node.staging,
				{ uploadId: await node.stage(bytes), template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(tooLarge).toMatchObject({
			code: "TOO_LARGE",
			message: "The converted sheet exceeds the limit of 2000 bytes",
		});
		const workers = setup({ workers: true, bufferBytes: 2000 });
		const tooLargeHere = await failure(
			startImport(
				workers.deps,
				workers.staging,
				{ uploadId: await workers.stage(bytes), template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(tooLargeHere).toMatchObject({
			code: "TOO_LARGE",
			message:
				"The sheet converts to more than 2000 bytes of JSON Lines, too large to convert on Workers",
		});
		expect(workers.storage.files.size).toBe(1);
	});

	it("stages the converted lines with their length, as R2 needs on Workers", async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		const lengths: number[] = [];
		global.FixedLengthStream = class extends TransformStream {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		};
		try {
			const { deps, staging, stage, text } = setup({ workers: true });
			const book = await stage(await productsXlsx(2));
			const job = await startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products"), dryRun: true },
				fields,
			);
			const converted = await text(job.uploadId);
			expect(converted.trim().split("\n")).toHaveLength(2);
			expect(lengths.at(-1)).toBe(Buffer.byteLength(converted));
		} finally {
			delete global.FixedLengthStream;
		}
	});
});

describe("sampleImport", () => {
	it("samples an XLSX sheet with its header names as paths, converting only what it needs", async () => {
		const { deps, staging, stage } = setup();
		// Row 4 does not parse: a job would fail on it, but a sample of two rows stops before it.
		const book = await stage(
			await workbook({
				sheets: [
					{
						name: "Sheet1",
						rows:
							row(
								1,
								'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Unit Price</t></is></c>',
							) +
							row(2, '<c r="A2" t="inlineStr"><is><t>A1</t></is></c><c r="B2"><v>1.5</v></c>') +
							row(3, '<c r="A3" t="inlineStr"><is><t>A2</t></is></c>') +
							'<row r="4"><c><v>&nbsp;</v></c></row>',
					},
				],
			}),
		);
		expect(await sampleImport(deps, staging, book, 2, { format: "xlsx" })).toEqual({
			records: [
				{ sku: "A1", "Unit Price": 1.5, _row: 2 },
				{ sku: "A2", "Unit Price": null, _row: 3 },
			],
			paths: ["sku", "Unit Price"],
		});
		const error = await failure(sampleImport(deps, staging, book, 3, { format: "xlsx" }));
		expect(error).toMatchObject({
			code: "INVALID_SOURCE",
			status: 400,
			message: "The part xl/worksheets/sheet1.xml has a row after row 3 that is not valid XML",
		});
	});

	it("reports a bad block, a missing upload and a file that is not a workbook", async () => {
		const { deps, staging, stage } = setup();
		const csv = await stage(new TextEncoder().encode("sku\nA1\n"));
		await expect(
			sampleImport(deps, staging, csv, 2, { format: "xlsx", records: "x" }),
		).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: "source.records is not allowed for xlsx",
		});
		await expect(sampleImport(deps, staging, csv, 2, { format: "xlsx" })).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: "The file is not an .xlsx workbook (it is not a zip archive)",
		});
		const missing = `01JZ0000000000000000000000${"0".repeat(32)}`;
		await expect(sampleImport(deps, staging, missing, 2, { format: "xlsx" })).rejects.toMatchObject(
			{
				code: "UPLOAD_NOT_FOUND",
				status: 404,
			},
		);
		// Other formats sample as before.
		expect(await sampleImport(deps, staging, csv, 2)).toEqual({ headers: ["sku"], rows: [["A1"]] });
	});
});

describe("xlsxSource and fetchLimitsFor", () => {
	it("finds a valid XLSX block and caps an XLSX source's fetch at the XLSX file limit", () => {
		expect(xlsxSource(xlsxTemplate("p", { sheet: 2 }))).toEqual({ format: "xlsx", sheet: 2 });
		expect(xlsxSource({ source: { format: "csv" } })).toBeNull();
		expect(xlsxSource({ source: { format: "xlsx", headerRow: 0 } })).toBeNull();
		expect(xlsxSource({ source: { format: "xlsx", records: "x" } })).toBeNull();
		expect(xlsxSource(null)).toBeNull();
		const limits = { ...FETCH_LIMITS, maxBytes: 50 * MIB };
		expect(fetchLimitsFor(xlsxTemplate("p"), limits, XLSX_MAX_BYTES)).toEqual({
			...limits,
			maxBytes: XLSX_MAX_BYTES,
		});
		expect(fetchLimitsFor({ source: { format: "csv" } }, limits, XLSX_MAX_BYTES)).toBe(limits);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xlsx-import.test.ts tests/unit/definition.test.ts`
Expected: FAIL — `xlsx-import.test.ts` cannot load `../../src/plugin/xlsx.js`; `definition.test.ts` passes (13 tests).

- [ ] **Step 3: Implement conversion at job creation and sampling**

Create `packages/flux-import/src/plugin/xlsx.ts`:
```ts
import { EmDashUploads, stageUpload, type UploadStorage } from "../emdash/uploads.js";
import { JobError } from "../engine/jobs.js";
import { SourceMissingError, type SourcePort } from "../engine/ports.js";
import { sourceSchema } from "../engine/template.js";
import type { EngineDeps, Job } from "../engine/types.js";
import type { FetchLimits } from "../sources/fetcher.js";
import { parseJsonRecord } from "../sources/json.js";
import { chunksOf, SourceError, type TemplateSource, type ValueSample } from "../sources/reader.js";
import { checkSource } from "../sources/readers.js";
import { openXlsx, type XlsxSheet } from "../sources/xlsx.js";
import { XlsxError } from "../sources/zip.js";
import {
	type FieldLookup,
	type LocaleResolver,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	sampleSource,
	startJob,
} from "./service.js";

/** On Workers the converted JSON Lines are held in memory to give R2 their length. */
export const XLSX_WORKERS_BUFFER = 32 * 1024 * 1024;
/** Converted lines are encoded and counted in pieces of about this many characters. */
const PIECE = 64 * 1024;

export interface XlsxLimits {
	/** The workbook file limit (`maxXlsxBytes`). */
	maxXlsxBytes: number;
	/** The converted JSON Lines limit (`maxSourceBytes`). */
	maxSourceBytes: number;
	/** Whether the code runs on Workers, where the converted lines are buffered. */
	workers: boolean;
	/** The Workers buffer for converted lines (`XLSX_WORKERS_BUFFER`). */
	bufferBytes: number;
}

/** Staging for converted sheets: where they go and how large they may be. */
export interface XlsxStaging extends XlsxLimits {
	storage: UploadStorage;
}

/**
 * The template's source block when it is a valid XLSX block, else null (a template that is
 * invalid, or reads another format, goes to `startJob` as it is, which reports any problem).
 */
export function xlsxSource(template: unknown): TemplateSource | null {
	if (typeof template !== "object" || template === null || !("source" in template)) return null;
	const parsed = sourceSchema.safeParse(template.source);
	if (!parsed.success || parsed.data.format !== "xlsx") return null;
	return checkSource(parsed.data).length === 0 ? parsed.data : null;
}

/** The fetch limits for a URL source job: an XLSX template may fetch at most `maxXlsxBytes`. */
export function fetchLimitsFor(template: unknown, limits: FetchLimits, maxXlsxBytes: number) {
	if (xlsxSource(template) === null) return limits;
	return { ...limits, maxBytes: Math.min(limits.maxBytes, maxXlsxBytes) };
}

/** Reads a staged workbook into memory; one over `maxBytes` is `TOO_LARGE`. */
export async function readWorkbookFile(
	source: SourcePort,
	uploadId: string,
	maxBytes: number,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of chunksOf(await source.open(uploadId, 0))) {
		size += chunk.length;
		if (size > maxBytes) {
			throw new ServiceError("TOO_LARGE", `XLSX files are limited to ${maxBytes} bytes`, 413);
		}
		parts.push(chunk);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** A conversion problem, from the workbook or its XML, as `invalid_source`. */
function asJobError(e: unknown): unknown {
	if (e instanceof XlsxError || e instanceof SourceError) {
		return new JobError("invalid_source", e.message);
	}
	if (e instanceof SourceMissingError) return new JobError("invalid_source", e.message);
	return e;
}

async function openSheet(
	deps: Pick<EngineDeps, "source">,
	limits: XlsxLimits,
	uploadId: string,
	source: TemplateSource,
): Promise<XlsxSheet> {
	const bytes = await readWorkbookFile(deps.source, uploadId, limits.maxXlsxBytes);
	return openXlsx(bytes, { sheet: source.sheet, headerRow: source.headerRow });
}

export interface ConvertedSheet {
	uploadId: string;
	columns: string[];
	warnings: string[];
}

/**
 * Converts the template's sheet of a staged workbook to JSON Lines and stages them as a new
 * upload. The lines are held in memory (at most `maxSourceBytes`; on Workers at most 32 MiB,
 * because R2 needs the length up front) and staged with their length.
 */
export async function convertXlsx(
	deps: Pick<EngineDeps, "source">,
	staging: XlsxStaging,
	uploadId: string,
	source: TemplateSource,
): Promise<ConvertedSheet> {
	const limit = staging.workers
		? Math.min(staging.maxSourceBytes, staging.bufferBytes)
		: staging.maxSourceBytes;
	const encoder = new TextEncoder();
	const pieces: Uint8Array[] = [];
	let size = 0;
	let pending = "";
	const flush = () => {
		const bytes = encoder.encode(pending);
		pending = "";
		size += bytes.length;
		if (size > limit) {
			const workers = staging.workers && limit < staging.maxSourceBytes;
			throw new ServiceError(
				"TOO_LARGE",
				workers
					? `The sheet converts to more than ${limit} bytes of JSON Lines, too large to convert on Workers`
					: `The converted sheet exceeds the limit of ${limit} bytes`,
				413,
			);
		}
		pieces.push(bytes);
	};
	let sheet: XlsxSheet;
	try {
		sheet = await openSheet(deps, staging, uploadId, source);
		for await (const line of sheet.lines) {
			pending += `${line}\n`;
			if (pending.length >= PIECE) flush();
		}
	} catch (e) {
		throw asJobError(e);
	}
	if (pending !== "") flush();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const piece = pieces[i++];
			if (piece) controller.enqueue(piece);
			else controller.close();
		},
	});
	const staged = await stageUpload(staging.storage, body, limit, size);
	return { uploadId: staged.uploadId, columns: sheet.columns, warnings: sheet.warnings() };
}

/**
 * `startJob`, converting an XLSX template's sheet first: the job reads the converted copy
 * (`uploadId`) and records the workbook as `sourceUploadId`. The copy is deleted again if the
 * job cannot be created.
 */
export async function startImport(
	deps: EngineDeps,
	staging: XlsxStaging,
	input: StartJobInput,
	lookupFields: FieldLookup,
	resolveLocale?: LocaleResolver,
): Promise<Job> {
	const source = xlsxSource(input.template);
	if (source === null) return startJob(deps, input, lookupFields, resolveLocale);
	const converted = await convertXlsx(deps, staging, input.uploadId, source);
	try {
		return await startJob(
			deps,
			{
				...input,
				uploadId: converted.uploadId,
				sourceUploadId: input.uploadId,
				columns: converted.columns,
				warnings: converted.warnings,
			},
			lookupFields,
			resolveLocale,
		);
	} catch (e) {
		await new EmDashUploads(staging.storage).delete(converted.uploadId).catch(() => {});
		throw e;
	}
}

/**
 * `sampleSource`, converting an XLSX sheet only until the sample is full: `{ records, paths }`
 * with the header names as paths.
 */
export async function sampleImport(
	deps: EngineDeps,
	limits: XlsxLimits,
	uploadId: string,
	n: number,
	source?: TemplateSource,
): Promise<Awaited<ReturnType<typeof sampleSource>>> {
	if (source?.format !== "xlsx") return sampleSource(deps, uploadId, n, source);
	const problems = checkSource(source);
	if (problems.length > 0) throw new ServiceError("INVALID_SOURCE", problems.join("; "), 400);
	const count = Math.min(n, SAMPLE_MAX);
	const encoder = new TextEncoder();
	try {
		const sheet = await openSheet(deps, limits, uploadId, source);
		const records: unknown[] = [];
		for await (const line of sheet.lines) {
			records.push(parseJsonRecord(encoder.encode(line)).value);
			if (records.length >= count) break;
		}
		return { records, paths: sheet.columns } satisfies ValueSample;
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof XlsxError || e instanceof SourceError) {
			throw new ServiceError("INVALID_SOURCE", e.message, 400);
		}
		throw e;
	}
}
```

- [ ] **Step 4: Route sampling and job creation through it**

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
```
with:
```ts
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
```

then replace
```ts
	ServiceError,
	type StartJobInput,
	sampleSource,
	stagePaste,
	startJob,
	type UploadKeeper,
} from "./service.js";
```
with:
```ts
	ServiceError,
	type StartJobInput,
	stagePaste,
	type UploadKeeper,
} from "./service.js";
```

then replace
```ts
	updateSource,
} from "./sources.js";

/** Every route requires Admin (`import:execute` is level 50 in @emdash-cms/auth). */
```
with:
```ts
	updateSource,
} from "./sources.js";
import {
	fetchLimitsFor,
	sampleImport,
	startImport,
	XLSX_WORKERS_BUFFER,
	type XlsxStaging,
} from "./xlsx.js";

/** Every route requires Admin (`import:execute` is level 50 in @emdash-cms/auth). */
```

then replace
```ts
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
}

```
with:
```ts
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
	/** Where an XLSX sheet is staged once converted, and its limits. */
	xlsx: XlsxStaging;
}

```

then replace
```ts
			newId: () => ulid(),
		};
		try {
			return await run({
```
with:
```ts
			newId: () => ulid(),
		};
		const xlsx: XlsxStaging = {
			storage: runtime.storage,
			maxXlsxBytes: maxXlsxBytes(),
			maxSourceBytes: maxSourceBytes(),
			workers: onWorkers(),
			bufferBytes: XLSX_WORKERS_BUFFER,
		};
		try {
			return await run({
```

then replace
```ts
				sources,
				keep,
			});
		} catch (e) {
```
with:
```ts
				sources,
				keep,
				xlsx,
			});
		} catch (e) {
```

then replace
```ts
		}),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				sampleSource(deps, ctx.input.uploadId, ctx.input.n, ctx.input.source),
			),
	),
```
with:
```ts
		}),
		(ctx) =>
			withServices(ctx, ({ deps, xlsx }) =>
				sampleImport(deps, xlsx, ctx.input.uploadId, ctx.input.n, ctx.input.source),
			),
	),
```

then replace
```ts
	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime, sources }) => {
			const { input } = ctx;
			const start = (upload: string) => {
```
with:
```ts
	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime, sources, xlsx }) => {
			const { input } = ctx;
			const start = (upload: string) => {
```

then replace
```ts
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
				};
				return startJob(
					deps,
					options,
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
```
with:
```ts
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
				};
				return startImport(
					deps,
					xlsx,
					options,
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
```

then replace
```ts
			if (input.sourceId !== undefined) {
				const options = { force: input.force ?? false, dryRun: input.dryRun };
				return jobFromSource(sources, input.sourceId, options, start);
			}
			if (input.uploadId === undefined) {
```
with:
```ts
			if (input.sourceId !== undefined) {
				const options = { force: input.force ?? false, dryRun: input.dryRun };
				// A workbook is fetched only up to the XLSX file limit.
				const limits = fetchLimitsFor(input.template, sources.limits, xlsx.maxXlsxBytes);
				return jobFromSource({ ...sources, limits }, input.sourceId, options, start);
			}
			if (input.uploadId === undefined) {
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xlsx-import.test.ts tests/unit/definition.test.ts`
Expected: PASS (24 tests: 11 in `xlsx-import.test.ts`, 13 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 35 files / 899 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/plugin packages/flux-import/tests/unit/xlsx-import.test.ts
git commit -m "Convert XLSX at job creation and sampling, staging the JSON Lines with their length"
```

### Task 6: Node integration on `sites/dev`: upload, kill and resume, URL source

**Files:**
- Create: `packages/flux-import/tests/integration/xlsx.test.ts`
- Modify: `packages/flux-import/tests/integration/feed-server.ts`, `packages/flux-import/tests/integration/crash.test.ts`, `packages/flux-import/tests/integration/url-sources.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 through HTTP; Task 4 fixtures (`productsXlsx`, `xlsxTemplate`) and `openXlsx` (to size the converted file in the kill test); harness `Client` (`plugin`, `upload`, `uploadRaw`, `createProducts`, `runToEnd`, `listAll`), `ApiError`, `startServer`/`stopServer`, `TEST_MAX_SOURCE_BYTES`, `FeedServer`; `inject("baseUrl")`, `inject("token")`; E5, F1.
- Produces: `Feed.body: string | Uint8Array` in `FeedServer`; tests only.

- [ ] **Step 1: Let the feed server send binary bodies**

In `packages/flux-import/tests/integration/feed-server.ts`, replace
```ts

export interface Feed {
	body: string;
	/** Sends an ETag and answers a matching If-None-Match with 304. */
	etag?: boolean;
```
with:
```ts

export interface Feed {
	/** Text, or the bytes of a binary file such as a workbook. */
	body: string | Uint8Array;
	/** Sends an ETag and answers a matching If-None-Match with 304. */
	etag?: boolean;
```

then replace
```ts
			const path = new URL(req.url ?? "/", "http://feed").pathname;
			const feed = this.feeds.get(path);
			const send = (status: number, headers: Record<string, string> = {}, body?: string) => {
				this.requests.push({ path, headers: req.headers, status });
				if (feed?.chunked && status === 200 && body !== undefined) {
```
with:
```ts
			const path = new URL(req.url ?? "/", "http://feed").pathname;
			const feed = this.feeds.get(path);
			const send = (
				status: number,
				headers: Record<string, string> = {},
				body?: string | Uint8Array,
			) => {
				this.requests.push({ path, headers: req.headers, status });
				if (feed?.chunked && status === 200 && body !== undefined) {
```

- [ ] **Step 2: Add the end-to-end test on the shared server**

Create `packages/flux-import/tests/integration/xlsx.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { ApiError, Client } from "./client.js";
import { TEST_MAX_SOURCE_BYTES } from "./server.js";

const client = new Client(inject("baseUrl"), inject("token"));
const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

describe("XLSX end to end (10 rows)", () => {
	it("uploads, samples and imports a workbook with dates, numbers, booleans, a filter and an expression", async () => {
		await client.createProducts("it_xlsx");
		const bytes = await productsXlsx(10);
		const upload = await client.upload(bytes, "Products 2026.xlsx");
		expect(upload.bytes).toBe(bytes.length);

		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 2,
			source: { format: "xlsx", sheet: "Products" },
		});
		expect(sample).toEqual({
			paths: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			records: [
				{
					sku: "SKU-0",
					Name: 'Product 0, "quoted" & <tagged> ț',
					Price: 0.5,
					Released: "2026-03-01",
					Active: false,
					Handle: "product-0",
					_row: 2,
				},
				{
					sku: "SKU-1",
					Name: 'Product 1, "quoted" & <tagged> ț',
					Price: 1.5,
					Released: "2026-03-02",
					Active: true,
					Handle: "product-1",
					_row: 3,
				},
			],
		});

		const base = xlsxTemplate("it_xlsx", { sheet: 1, filter: "Active" });
		const template = {
			...base,
			fields: { ...base.fields, title: { expr: "sku & ' / row ' & _row", type: "text" } },
		};
		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template,
			dryRun: false,
			batchSize: 3,
		});
		expect(job).toMatchObject({
			status: "created",
			sourceUploadId: upload.uploadId,
			columns: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			warnings: [],
		});
		expect(job.uploadId).not.toBe(upload.uploadId);
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 5, filtered: 5, failed: 0 },
		});

		const entries = await client.listAll("it_xlsx");
		expect(entries.map((e) => e.data.flux_source_id).sort()).toEqual([
			"SKU-1",
			"SKU-3",
			"SKU-5",
			"SKU-7",
			"SKU-9",
		]);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-1")!;
		expect(first).toMatchObject({ slug: "product-1", status: "published" });
		expect(first.data).toMatchObject({ title: "SKU-1 / row 3", price: 1.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-03-01T22:00:00.000Z"));
	});

	it("fails job creation with INVALID_SOURCE when the sheet does not exist", async () => {
		const { uploadId } = await client.upload(await productsXlsx(1), "book.xlsx");
		const error = await failure(
			client.plugin("jobs/create", {
				uploadId,
				template: xlsxTemplate("it_xlsx", { sheet: "Stock" }),
				dryRun: true,
			}),
		);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 400,
			code: "INVALID_SOURCE",
			message:
				'400 INVALID_SOURCE: The workbook has no sheet named "Stock"; its sheets are "Products"',
		});
	});

	it("refuses a pasted workbook, other spreadsheet files and a workbook over the limit", async () => {
		const pasted = await failure(client.plugin("sources/paste", { format: "xlsx", text: "PK" }));
		expect(pasted).toMatchObject({ status: 400, code: "INVALID_FORMAT" });
		const xls = await client.uploadRaw(await productsXlsx(1), "book.xls");
		expect(xls.status).toBe(415);
		// The shared server's maxSourceBytes is below 10 MiB, so it is the XLSX limit too.
		const big = await client.uploadRaw(new Uint8Array(TEST_MAX_SOURCE_BYTES + 1), "big.xlsx");
		expect(big.status).toBe(413);
		expect((await big.json()) as unknown).toMatchObject({ error: { code: "TOO_LARGE" } });
	});
});
```

- [ ] **Step 3: Add an XLSX case to kill and resume**

In `packages/flux-import/tests/integration/crash.test.ts`, replace
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { jsonTemplate, productsJson } from "../fixtures/formats.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
```
with:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { openXlsx } from "../../src/sources/xlsx.js";
import { jsonTemplate, productsJson } from "../fixtures/formats.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
```

then replace
```ts
const MAX_SOURCE_BYTES = 4_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
```
with:
```ts
const MAX_SOURCE_BYTES = 4_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An XLSX job reads the JSON Lines its workbook converts to, so its cursor moves through those. */
async function sourceSize(body: string | Uint8Array): Promise<number> {
	if (typeof body === "string") return Buffer.byteLength(body);
	let bytes = 0;
	for await (const line of (await openXlsx(body)).lines) bytes += Buffer.byteLength(line) + 1;
	return bytes;
}

let server: DevServer;
```

then replace
```ts
	await client.createProducts("it_crash");
	await client.createProducts("it_crash_json");
});

```
with:
```ts
	await client.createProducts("it_crash");
	await client.createProducts("it_crash_json");
	await client.createProducts("it_crash_xlsx");
});

```

then replace
```ts
	["CSV", "it_crash", "products.csv", productsCsv(ROWS), template("it_crash")],
	["JSON", "it_crash_json", "products.json", productsJson(ROWS), jsonTemplate("it_crash_json")],
])("kill and resume (%s)", (_format, collection, filename, body, jobTemplate) => {
	it("leaves no duplicates and reports any entry a crash left unpublished", async () => {
		const sourceBytes = Buffer.byteLength(body);
		const { uploadId } = await client.upload(body, filename);
		const created = await client.plugin("jobs/create", {
```
with:
```ts
	["CSV", "it_crash", "products.csv", productsCsv(ROWS), template("it_crash")],
	["JSON", "it_crash_json", "products.json", productsJson(ROWS), jsonTemplate("it_crash_json")],
	[
		"XLSX",
		"it_crash_xlsx",
		"products.xlsx",
		await productsXlsx(ROWS),
		xlsxTemplate("it_crash_xlsx"),
	],
])("kill and resume (%s)", (_format, collection, filename, body, jobTemplate) => {
	it("leaves no duplicates and reports any entry a crash left unpublished", async () => {
		const sourceBytes = await sourceSize(body);
		const { uploadId } = await client.upload(body, filename);
		const created = await client.plugin("jobs/create", {
```

- [ ] **Step 4: Add an XLSX URL source**

In `packages/flux-import/tests/integration/url-sources.test.ts`, replace
```ts
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
```
with:
```ts
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
```

then replace
```ts
	});

	it("fails with HTTP_ERROR for a 404 and saves it as the source's lastError", async () => {
		const missing = await client.plugin<SourceRow>("sources/create", {
```
with:
```ts
	});

	it("imports an XLSX feed through a converted copy, keeping the fetched workbook", async () => {
		await client.createProducts("it_url_xlsx");
		feeds.feeds.set("/products.xlsx", { body: await productsXlsx(4), etag: true });
		const source = await client.plugin<SourceRow>("sources/create", {
			name: "XLSX feed",
			url: feeds.url("/products.xlsx"),
		});
		const create = () =>
			client.plugin<Job | Skipped>("jobs/create", {
				sourceId: source.id,
				template: xlsxTemplate("it_url_xlsx"),
				dryRun: false,
			});
		const job = await create();
		if ("skipped" in job) throw new Error(`Expected a job, got ${JSON.stringify(job)}`);
		const { lastFetch } = await client.plugin<SourceRow>("sources/get", { id: source.id });
		expect(job.sourceUploadId).toBe(lastFetch?.uploadId);
		expect(job.uploadId).not.toBe(job.sourceUploadId);
		expect(await client.runToEnd(job.id)).toMatchObject({
			status: "completed",
			counters: { created: 4, failed: 0 },
		});
		// The finished job deleted its converted copy; the workbook stays as the source's latest file.
		expect(await stagedFilesFor(job.uploadId)).toEqual([]);
		expect(await stagedFilesFor(job.sourceUploadId ?? "")).toHaveLength(1);
		expect(await create()).toEqual({
			skipped: "unchanged",
			sourceId: source.id,
			uploadId: job.sourceUploadId,
		});
		expect(feeds.log("/products.xlsx").map((r) => r.status)).toEqual([200, 304]);
	});

	it("fails with HTTP_ERROR for a 404 and saves it as the source's lastError", async () => {
		const missing = await client.plugin<SourceRow>("sources/create", {
```

- [ ] **Step 5: Run the new tests**

Run: `pnpm --filter flux-import exec vitest run --config vitest.integration.config.ts tests/integration/xlsx.test.ts tests/integration/url-sources.test.ts`
Expected: PASS (2 files, 13 tests: 3 in `xlsx.test.ts` on the shared server, 10 in `url-sources.test.ts` with its own server; about 14 s with server starts).

Then: `pnpm --filter flux-import exec vitest run --config vitest.integration.config.ts tests/integration/crash.test.ts -t XLSX`
Expected: PASS (1 test, the CSV and JSON cases skipped; about 2 minutes). Its log shows the kills landing mid-job, e.g. `cursor after the kills: offset 130199 of 1559458 bytes, seq 863 of 10000 rows`: the cursor is an offset into the converted JSON Lines (Review Focus 2).

- [ ] **Step 6: Run the whole integration suite**

Run: `pnpm test:integration`
Expected: PASS (9 files / 48 tests, about 8.5 minutes; was 8 files / 43 tests; Fact F1 describes a known `crash.test.ts` flake on WSL). Then `pnpm typecheck && pnpm lint && pnpm test`. `git status` must show only this task's files: the global setup restores `sites/dev/emdash-env.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/flux-import/tests/integration
git commit -m "Prove XLSX imports end to end on Node: an upload, kill and resume, and a URL source"
```

### Task 7: workerd parity: one XLSX import on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 through HTTP; Task 4 fixtures (`productsXlsx`, `xlsxTemplate`); parity harness (`client`, `inject("cfBaseUrl")`, `inject("cfToken")`); Z2.
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
import type { SourceRow } from "../../src/plugin/sources.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { Client } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
```
with:
```ts
import type { SourceRow } from "../../src/plugin/sources.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { Client } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
```

then replace
```ts
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
```
with:
```ts
	});

	it("converts an XLSX workbook with DecompressionStream and imports the copy staged in R2", async () => {
		await client.createProducts("cf_xlsx");
		const { uploadId } = await client.upload(await productsXlsx(10), "products.xlsx");
		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId,
			n: 2,
			source: { format: "xlsx" },
		});
		expect(sample.paths).toEqual(["sku", "Name", "Price", "Released", "Active", "Handle"]);
		expect(sample.records[1]).toEqual({
			sku: "SKU-1",
			Name: 'Product 1, "quoted" & <tagged> ț',
			Price: 1.5,
			Released: "2026-03-02",
			Active: true,
			Handle: "product-1",
			_row: 3,
		});
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: xlsxTemplate("cf_xlsx"),
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ sourceUploadId: uploadId, warnings: [] });
		expect(job.uploadId).not.toBe(uploadId);
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = await client.listAll("cf_xlsx");
		expect(entries.every((e) => e.status === "published")).toBe(true);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted" & <tagged> ț', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
```

- [ ] **Step 2: Run the new test on workerd**

Run: `pnpm --filter flux-import exec vitest run --config vitest.cf.config.ts -t XLSX --reporter=verbose`
Expected: PASS (1 test, about 12 s plus 25 s of server start; the other six are skipped). This proves on workerd that `DecompressionStream("deflate-raw")` inflates the parts (Z2), that the workbook upload and the converted copy both reach R2 with their lengths (the copy through `FixedLengthStream`, Review Focus 5), and that sampling and the job read them back. The full `pnpm test:cf` runs in Task 8.

- [ ] **Step 3: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove an XLSX import on workerd"
```

### Task 8: M3d review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-m3d-review.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 18 minutes, almost all of it the unchanged 10,000-row case; `pnpm test:integration` about 9 minutes; Fact F1 describes a known `crash.test.ts` flake on WSL, which a re-run of that file settles). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with an Admin PAT from `setup/dev-bypass` and a `posts`-like collection with `title` (string), `price` (number) and `released` (datetime) fields, record each result:
1. Build a workbook by hand: in a scratch script, `await productsXlsx(10)` from `tests/fixtures/xlsx.ts` written to a file (or any real `.xlsx` with a header row). Upload it: `POST /_emdash/api/flux-import/uploads?filename=products.xlsx` → 201 with its `uploadId`. Upload the same bytes as `products.xls` → 415.
2. `sources/sample { uploadId, n: 3, source: { format: "xlsx" } }` → three records with typed values (`Price` a number, `Released` an ISO date, `Active` a boolean, `_row`) and `paths` = the header names.
3. `jobs/create` with the XLSX template (as `xlsxTemplate`, into the collection, `dryRun: false`), then drive it with `jobs/next`: completed with 10 created. `jobs/get` shows `sourceUploadId` = the upload and an `uploadId` of its own; after completion both files are gone from `sites/dev/uploads`.
4. `jobs/create` with `source.sheet: "Missing"` → 400 `INVALID_SOURCE` naming the sheets; `sources/paste { format: "xlsx", text: "x" }` → 400 `INVALID_FORMAT`.
5. Open the Excel-saved fixture: upload `tests/fixtures/phpspreadsheet/Translations.xlsx` and sample `{ format: "xlsx", sheet: "Excel Functions", n: 2 }` → records keyed `CATEGORY:`, `en`, `pt_br`, …; a dry-run job on it with a template mapping `en` to `title` and `_row` as the key completes with 536 records. Restore `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-27-m3d-review.md` from this template and fill in every `…`:
````markdown
# Milestone 3d review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

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
| Zip: stored and deflate entries; directory parsing; encrypted, ZIP64, multi-disk and unsupported-method archives refused; a zip bomb stops at the cap; path traversal names ignored; truncated archives refused | `zip.test.ts` | … |
| Workbook: sheet by name, by index, default first; 1904 dates; shared strings with rich text; date detection for built-in and custom formats (`[h]:mm`, quoted text) | `xlsx-workbook.test.ts`, `xlsx.test.ts` | … |
| Cells: inline strings; booleans; errors; formulas with and without cached values; serial 60 and dates around it; large integers exact | `xlsx.test.ts` | … |
| Rows and headers: sparse rows and cells without `r`; header naming (empty, duplicate, `_row`); empty rows skipped; cells beyond the header ignored | `xlsx.test.ts` | … |
| Fixtures: zip writer (stored and deflate via `CompressionStream`), Excel-like parts, one workbook saved by Microsoft Excel (provenance in `tests/fixtures/xlsx.ts`) | `tests/fixtures/zip.ts`, `tests/fixtures/xlsx.ts` | … |
| Engine and routes: template validation; conversion at job creation; `sourceUploadId` and cleanup; sample; paste refused; upload extension and limit | `readers.test.ts`, `template.test.ts`, `jobs.test.ts`, `service.test.ts`, `retention.test.ts`, `definition.test.ts`, `upload-route.test.ts`, `xlsx-import.test.ts` | … |
| Integration on `sites/dev`: upload import with dates, numbers, booleans, a filter and an expression; kill and resume on 10,000 rows; an XLSX URL source | `xlsx.test.ts`, `crash.test.ts`, `url-sources.test.ts` | … |
| workerd: one XLSX import | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | `.xlsx` upload accepted, `.xls` refused | … | … |
| 2 | Sample with typed values and header paths | … | … |
| 3 | Import, `sourceUploadId`, both files released | … | … |
| 4 | Missing sheet and pasted XLSX refused | … | … |
| 5 | The Excel-saved workbook samples and imports | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-27-m3d-review.md
git commit -m "Add the Milestone 3d review results"
```


---

## After this plan

M3d ends Milestone 3 (Sources) with the review stop. Known gaps carried forward: a workbook is read whole into memory (at most 10 MiB) and its shared strings are held as one array (up to 50 MiB of text, about twice that as JavaScript strings), which on Workers' 128 MB isolates leaves little room for the very largest workbooks the limits allow; formulas are not evaluated (a formula without a cached value is `null`); only one sheet per job; `.xls`, `.xlsb`, `.ods` and `.xlsm` stay refused. The M2, M3a, M3b and M3c open issues (`docs/superpowers/notes/2026-10-08-m2-review.md`, `docs/superpowers/notes/2026-10-12-m3a-review.md`, `docs/superpowers/notes/2026-10-14-m3b-review.md`, `docs/superpowers/notes/2026-10-26-m3c-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands, so XLSX on a deployed Worker stays unverified beyond local workerd.
