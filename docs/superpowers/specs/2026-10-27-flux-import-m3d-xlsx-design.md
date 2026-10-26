# Flux Import M3d: XLSX

Status: approved 2026-10-27 (the user approved all remaining milestones up front; the design
decisions below are the implementer's rulings). Last part of Milestone 3 (Sources) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md). Builds on M3a (formats), M3b (filters
and expressions) and M3c (URL sources), merged at `5f56b84`.

## Goal

Import one sheet of an Excel workbook (`.xlsx`), from an upload or a saved URL source, with the same
guarantees as the other formats: bounded memory, exact resume, idempotent batches, per-record errors
that never fail the job, and no duplicates after a crash.

## Decisions

| Topic | Decision |
| --- | --- |
| Approach | Convert once, then import. When a job is created from an XLSX source, the chosen sheet is converted to JSON Lines and staged as a new upload; the job reads that copy with the existing JSON Lines reader. The byte offset in the converted file is the row cursor. Engine, batches, resume, retry and crash repair are unchanged. |
| Dependencies | None. Our own zip directory reader, `DecompressionStream("deflate-raw")` (Node 22 and Workers), and the M3a XML scanner. No SheetJS or similar. |
| Template | `source: { format: "xlsx", sheet?, headerRow? }`. `sheet` is a sheet name or a 1-based index (default: the first sheet in workbook order). `headerRow` is 1-based (default 1). `records` is not allowed. `filter` works as in M3b. |
| Field paths | Header names, like CSV columns (`from: "Unit Price"`; expressions use backticks). |
| File types | `.xlsx` only (Office Open XML spreadsheet). `.xls`, `.xlsb`, `.ods` and macro-enabled `.xlsm` are refused. Pasted XLSX is refused (binary). |
| Size | XLSX files at most 10 MiB (enforced by the upload route for `.xlsx`, by `jobs/create { sourceId }` for XLSX templates through the fetch cap, and before every conversion). `sources/fetch` has no template and keeps the general limit. Converted JSON Lines at most `maxSourceBytes` (50 MiB). |

## Conversion

1. **Zip.** Read the end-of-central-directory record and the central directory from the in-memory
   file (at most 10 MiB). Supported: stored (0) and deflate (8) entries, no encryption, no ZIP64, one
   disk. Entry names are matched exactly after normalising `\` to `/`; names with `..` segments or a
   leading `/` are ignored. Each entry is inflated on demand with a hard cap on its uncompressed size
   (see Limits); the cap is enforced while inflating, so a zip bomb stops at the cap.
2. **Workbook.** `xl/workbook.xml` lists sheets in order with `r:id`; `xl/_rels/workbook.xml.rels`
   maps them to sheet parts (targets resolved relative to `xl/`). `workbookPr/@date1904` selects the
   1904 date system.
3. **Shared strings.** `xl/sharedStrings.xml` (optional) is read into an array of strings (rich text
   runs concatenated; phonetic runs ignored).
4. **Styles.** `xl/styles.xml` (optional): `cellXfs` gives each style index a number format ID;
   custom `numFmts` give format codes. A format is a date format when its ID is a built-in date or
   time ID (14-22, 45 and 47; 46 is elapsed time `[h]:mm:ss`) or its code contains `d`, `m`, `y`, `h` or `s` outside quotes, brackets
   and escapes (and is not purely elapsed time like `[h]:mm`, which stays a number).
5. **Sheet.** The sheet part is inflated and scanned as a stream of `<row>` / `<c>` elements with the
   M3a XML scanner; only the current row is held in memory.

### Cell values

| Cell | JSON value |
| --- | --- |
| `t="s"` | the shared string |
| `t="inlineStr"` | the inline string (`<is>` text runs) |
| `t="str"` (formula string) | the cached string |
| `t="b"` | `true` / `false` |
| `t="e"` (error, e.g. `#N/A`) | `null` |
| `t="n"` or no `t`, date format | ISO 8601 text: `YYYY-MM-DD` when the time part is zero, otherwise `YYYY-MM-DDTHH:mm:ss` (no zone; the template's date `tz` applies). Serial dates use the 1900 system (with Excel's 1900 leap-year bug: serial 60 is skipped) or the 1904 system. |
| `t="n"` or no `t`, other format | the number, written as the cell's exact text so large integers stay exact (the M3a JSON rules then apply) |
| `t="d"` (ISO date cell) | the text as written |
| formula without a cached value, or no `<v>` | `null` |

Cell references (`r="C7"`) place cells; cells without `r` follow the previous cell. Merged cells keep
their value in the top-left cell only.

### Rows and headers

- The header row is `headerRow`; rows above it are skipped. Header names are the cells' values as
  text, trimmed. An empty header becomes `column_<letter>` (`column_D`); a repeated header gets
  `_2`, `_3`, … appended, and each rename is a job warning.
- Each later row becomes one JSON Lines record: an object of header name to cell value, including
  `null` for empty cells within the header width. Cells beyond the last header column are ignored
  (counted in one warning).
- Rows with no values are skipped. Record numbers in logs are converted-record numbers; each record
  also carries `_row` (the sheet's 1-based row number), which templates may read with `from: "_row"`
  and which a header named `_row` overrides.

## Where conversion runs

- `jobs/create` with an `uploadId` or `sourceId` whose template has `format: "xlsx"`: the original
  file is read (at most 10 MiB, else `TOO_LARGE`), converted and staged as a new upload; the job's
  `uploadId` is the converted file and `sourceUploadId` the original. The converted file is deleted
  with the job like any staged upload; the original follows the existing rules (upload retention,
  or the source's latest file).
- `sources/sample` with `format: "xlsx"` converts only until the sample is full.
- A conversion problem fails job creation with `invalid_source` and a message (not a zip, not a
  workbook, sheet not found, encrypted, unsupported compression, ZIP64, part over its cap, header
  row empty or missing, or a structural sheet problem: a cell past column XFD, a row past 1,048,576,
  rows out of order, or a `<row>` that is not well-formed XML). Cell value problems never fail the
  job: an unreadable value becomes `null` and is counted in a warning.
- On Workers, staging needs a known length: the converted JSON Lines are buffered up to 32 MiB (the
  M3c buffered path); larger fails with `TOO_LARGE` and a message saying the sheet is too large to
  convert on Workers.

## Limits

| Limit | Value |
| --- | --- |
| XLSX file | 10 MiB |
| Uncompressed zip entry (any part) | 100 MiB |
| Shared strings | 1,000,000 strings and 50 MiB uncompressed |
| Rows | 1,048,576 (Excel's maximum) |
| Columns | 16,384 (Excel's maximum, `XFD`) |
| Converted JSON Lines | `maxSourceBytes` (50 MiB); 32 MiB on Workers |
| Sheet scan | bounded by the 100 MiB part cap; a sheet of many empty cells converts slowly but finishes (known limit) |
| Compression ratio | an entry whose uncompressed size exceeds 200× its compressed size is refused (`invalid_source`) |

## Routes and template

- `TemplateSource.format` gains `xlsx`, with `sheet` (string 1-100 chars, or integer ≥ 1) and
  `headerRow` (integer 1-1,048,576). Both are refused for other formats; `records` is refused for
  `xlsx`.
- The upload route accepts `.xlsx` (10 MiB). `sources/paste` refuses `xlsx` with `INVALID_FORMAT`.
- Jobs gain an optional `sourceUploadId`; existing jobs are unaffected.
- CSV header checks apply to XLSX header names (missing `from` columns fail job creation, as for CSV).

## Testing

- Unit, zip: stored and deflate entries; directory parsing; encrypted, ZIP64, multi-disk and
  unsupported-method archives refused; a zip bomb stops at the cap; path traversal names ignored;
  truncated archives refused.
- Unit, workbook: sheet by name, by index, default first; 1904 dates; shared strings with rich text;
  inline strings; booleans; errors; formulas with and without cached values; date detection for
  built-in and custom formats (including `[h]:mm` staying a number and quoted text in a format code);
  serial 60 and dates around it; large integers exact; sparse rows and cells without `r`; header
  naming (empty, duplicate, `_row`); empty rows skipped; cells beyond the header ignored.
- Fixtures are built in the tests by a small zip writer (stored and deflate via
  `CompressionStream`) from XML parts that mirror Excel's output, plus one workbook saved by a real
  spreadsheet application, committed as a binary fixture with its provenance noted.
- Unit, engine and routes: template validation; conversion at job creation; `sourceUploadId` and
  cleanup; sample; paste refused; upload extension and limit.
- Integration on `sites/dev`: an upload import of a workbook with dates, numbers, booleans and a
  filter and expression; kill-and-resume on a 10,000-row sheet (no duplicates); an XLSX URL source.
- Cloudflare parity on `sites/dev-cf`: one XLSX import.

## Out of scope for M3d

Multiple sheets per job, formula evaluation, `.xls`/`.xlsb`/`.ods`, streaming conversion without
loading the zip into memory, cell styles beyond date detection, hyperlinks and comments.
