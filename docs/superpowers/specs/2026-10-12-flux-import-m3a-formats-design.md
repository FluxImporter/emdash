# Flux Import M3a: JSON, JSON Lines, XML and pasted sources

Status: draft for review. Part of Milestone 3 (Sources) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md). Builds on the merged M2 engine,
adapters and routes (`packages/flux-import`).

## Milestone 3 split

Milestone 3 is delivered in four parts, each with its own spec, plan and review:

| Part | Scope |
| --- | --- |
| **M3a (this spec)** | Format-neutral record reader; JSON (array), JSON Lines, XML; pasted snippets; simple record-location and field paths |
| M3b | Record selection (JSONPath, XPath, row filters) and JSONata field transforms |
| M3c | URL sources: server-side fetch, auth headers as secrets, SSRF guard, ETag/Last-Modified |
| M3d | XLSX, with its own size limit and a row-index cursor |

## Goal

Import JSON, JSON Lines and XML files, and pasted text, with the same guarantees CSV has
today: bounded memory, exact byte-offset resume, idempotent batches, per-record errors that
never fail the job, and no duplicates after a crash.

## Decisions

| Topic | Decision |
| --- | --- |
| Reader strategy | Own byte-level boundary scanners per format. The scanner tracks structure only (JSON brackets, strings, escapes; XML tags, comments, CDATA, processing instructions) to find each record's byte range; the record's bytes are then parsed on their own. Structural characters are ASCII, so byte scanning is UTF-8 safe. No streaming-parser dependencies. |
| Cursor | Unchanged: `{ offset, seq }`, byte offset of the next record. Crash recovery, retry, leases and ranged storage reads work as for CSV. |
| Paths | Simple paths in M3a. JSON: dot paths of object keys (`data.products`, `price.amount`). XML: `/` paths of element names (`feed/item`, `title`), attributes as `@name` (`@sku`, `title/@lang`). Full JSONPath/XPath arrive in M3b. |
| Template | Stays `version: 1`; additive optional `source` block, default `{ "format": "csv" }`, so existing templates stay valid. |
| Value conversion | Takes typed values. JSON numbers map to number fields directly; a number or boolean into a text field becomes its string; an object or array where a scalar is expected fails the record with `not_scalar`; a missing path is `null`. |
| Missing paths at job creation | CSV columns are still checked against the header (error). JSON/XML field paths are checked against the first 20 records; a path found in none is a **warning** stored on the job, not an error. |
| Pasted snippets | Plugin route `sources/paste` with `{ format, text }`, at most 1 MiB, staged like an upload; returns an `uploadId`. |
| Upload filenames | The upload route accepts `.csv`, `.json`, `.jsonl`, `.ndjson`, `.xml`. The template's `source.format` decides parsing; the extension only gates acceptance. |
| Encoding | UTF-8 only; a leading BOM is skipped. An XML declaration naming another encoding fails with `unsupported_encoding`. |
| XML safety | A `<!DOCTYPE …>` with an internal subset or an external ID is rejected (`xml_dtd_not_allowed`). External entities are never resolved. Only the five predefined entities and numeric character references are decoded. |
| XML namespaces | Names match as written (`g:item`); namespace URIs are not resolved in M3a. |
| Record size | The existing 4 MiB per-record cap applies to every format. |

## Template `source` block

```json
"source": { "format": "csv" }
"source": { "format": "json" }
"source": { "format": "json", "records": "data.products" }
"source": { "format": "jsonl" }
"source": { "format": "xml", "records": "feed/item" }
```

- `format`: `csv` | `json` | `jsonl` | `xml`. Default `csv`.
- `records`: required for `xml`; optional for `json` (absent means a top-level array); not
  allowed for `csv` and `jsonl`.
- `key.from`, `slug.from` and each field's `from` are a CSV column name (`csv`), a dot path
  (`json`, `jsonl`) or a `/` path (`xml`).

## Reader interface

`packages/flux-import/src/sources/` gets one reader per format behind a shared interface:

```ts
interface SourceRecord {
	seq: number;
	start: number; // byte offset of the record
	end: number; // byte offset just past it
	value: unknown; // parsed record (CSV: Record<string, string>)
	error?: { code: string; message: string }; // record-level problem, e.g. invalid_record
}

interface RecordReader {
	/** Finds where records begin. CSV also reads the header. */
	locate(stream: ReadableStream<Uint8Array>): Promise<{ bodyOffset: number; columns?: string[] }>;
	read(
		stream: ReadableStream<Uint8Array>,
		opts: { startOffset: number; startSeq: number },
	): AsyncGenerator<SourceRecord>;
	sample(stream: ReadableStream<Uint8Array>, n: number): Promise<{ records: unknown[]; paths: string[] }>;
}

function readerFor(source: TemplateSource): RecordReader;
```

The CSV reader wraps today's `sources/csv.ts` without changing its behaviour. The engine
(`engine/batch.ts`, `engine/jobs.ts`) and the service (`plugin/service.ts`) call
`readerFor(job.template.source)` instead of the CSV functions. The job stores the template's
`source` (and, for CSV, the header columns) instead of a CSV-only `headers` field; existing
CSV jobs keep working.

Field values are read with `resolvePath(value, path, format)`: a CSV column lookup, a JSON
dot-path walk, or an XML path walk over the record object.

## JSON

- No `records`: the document must be a top-level array; each element is a record.
- `records: "a.b"`: the scanner walks object keys `a` then `b`, skipping the values of other
  keys without parsing them, and reads the array it reaches. A missing key, or a value that is
  not an array, fails job creation with `invalid_source` and a message naming what was found.
- A top-level object without `records`, or a top-level scalar, fails job creation with
  `invalid_source`.
- Each array element's bytes go to `JSON.parse`. Elements may be any JSON value; for a
  non-object element every path resolves to `null` (so the record normally fails with
  `missing_key`).

## JSON Lines

- One record per non-blank line (LF or CRLF); blank lines are skipped. A leading BOM is
  skipped.
- `records` is not allowed.

## XML

- `records: "feed/item"` selects every `item` element that is a direct child of the root
  element `feed`. Deeper paths (`rss/channel/item`) are supported; each segment is an element
  name.
- A record element becomes a plain object:
  - attributes as `"@name": "value"`;
  - text content as `"#text"`; an element with only text (and no attributes) collapses to the
    string;
  - child elements as properties; a child that repeats becomes an array;
  - CDATA is text; comments and processing instructions are ignored.
- Field paths walk this object: `title` → child `title`'s text, `@sku` → attribute,
  `title/@lang` → attribute of a child, `images/image` → string or array.
- Safety rules from the Decisions table apply before any record is read.

## Errors

| Level | Code | When |
| --- | --- | --- |
| Record | `invalid_record` | The scanner found the record's bytes but they do not parse (JSON) or are not a well-formed element (XML) |
| Record | `not_scalar` | A mapped path resolves to an object or array for a text, number or date field |
| Record | existing value codes | `missing_key`, `invalid_number`, `invalid_date`, … as today |
| Job | `source_syntax` | A structural error the scanner cannot get past (unterminated string, array or tag), with the byte offset; also a record over the 4 MiB cap |
| Job | `unsupported_encoding`, `xml_dtd_not_allowed` | As in Decisions |
| Job creation | `invalid_source` | Records path not found or not an array, wrong top-level shape, `records` given where not allowed |

CSV keeps its `csv_syntax` job code for compatibility.

## Routes

- `POST /_emdash/api/flux-import/uploads?filename=` accepts the extensions above.
- New plugin route `sources/paste`: input `{ format: "csv" | "json" | "jsonl" | "xml", text: string }`,
  `permission: "import:execute"`, request body at most 1 MiB; stages the UTF-8 bytes like an
  upload and returns `{ uploadId, bytes, sha256 }`. Empty text is rejected (`EMPTY_BODY`).
- `sources/sample` takes the template's `source` (default CSV) and returns
  `{ records, paths }` for JSON/XML (`paths` are the distinct field paths found in the
  sampled records, for the M7 mapper) and the existing `{ headers, rows }` shape for CSV.
- `jobs/create` returns the job with a `warnings` array (missing JSON/XML paths); the job
  stores it.

## Testing

- Unit, per scanner: identical output whether the input arrives in one chunk or one byte at a
  time; resume from every record boundary gives the remaining records; BOM; multibyte text;
  JSON escapes and deep nesting; records-path navigation that skips unrelated keys and values
  containing brackets inside strings; the record-level versus job-level error split; the
  4 MiB cap; XML DTD rejection, predefined and numeric entities, CDATA, comments, attributes
  containing `>` inside quotes, self-closing elements, repeated children.
- Unit, engine: path resolution and typed conversion (`not_scalar`, numbers into text);
  templates without `source` still behave exactly as CSV; warnings for paths missing from the
  sample.
- Fixtures per format: 10 records, 10,000 records, malformed.
- Integration on `sites/dev`: one end-to-end import each for JSON, JSON Lines, XML and a
  pasted snippet; kill-and-resume on a 10,000-record JSON file (no duplicates).
- Cloudflare parity on `sites/dev-cf`: one JSON import.

## Out of scope for M3a

JSONPath/XPath queries, row filters and JSONata (M3b); URL sources (M3c); XLSX (M3d); XML
namespace URIs; encodings other than UTF-8.
