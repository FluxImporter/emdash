# Flux Import M3a: JSON, JSON Lines, XML and pasted sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import JSON (top-level array or a records path), JSON Lines and XML files, and pasted text, with the guarantees CSV has today: bounded memory, exact byte-offset resume, idempotent batches, per-record errors that never fail the job, and no duplicates after a crash.

**Architecture:** `src/sources/` gets a format-neutral `RecordReader` (`locate`, `read`, `sample`) with one implementation per format. JSON, JSON Lines and XML readers are byte-level boundary scanners (state machines fed one byte at a time by a shared driver) that track structure only, cut each record's bytes, and parse those bytes on their own (`JSON.parse`, a small XML element parser). The CSV reader wraps `sources/csv.ts` unchanged. The engine (`engine/jobs.ts`, `engine/batch.ts`) and the service call `readerFor(source)` instead of the CSV functions; the job stores the template's `source` block (and the CSV columns) instead of a CSV-only `headers` field, and still runs jobs created before M3a. Templates read typed values through `resolvePath`; the routes gain `sources/paste`, a `source`-aware `sources/sample`, and the upload route accepts the new extensions.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4.5.4 (engine) and `astro/zod` (routes), Luxon 3, Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-flux-import-m3a-formats-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. Previous plans: `docs/superpowers/plans/2026-10-07-flux-import-m2a-engine-core.md`, `docs/superpowers/plans/2026-10-08-flux-import-m2b-adapters-routes.md`. Open issues carried from M2: `docs/superpowers/notes/2026-10-08-m2-review.md`.

Paths written `src/…` without a package name in the Facts table are relative to `sites/dev/node_modules/emdash/` (EmDash ships its sources). Every code block in Tasks 1 to 10 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite, and the new workerd parity test on its own), then removed; results are in "Verification while drafting".

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`.
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- Never `eval` or `new Function`.
- No new dependencies, and in particular no streaming-parser dependencies: JSON, JSON Lines and XML use the plugin's own boundary scanners (spec, Decisions: Reader strategy).
- Plugin route input schemas import `z` from `"astro/zod"` (EmDash types route input against Astro's zod); the engine keeps `zod` 4.5.4 (`engine/template.ts`).
- Template stays `version: 1`; the `source` block is additive and defaults to `{ "format": "csv" }`, so every existing template stays valid.
- Cursor stays `{ offset, seq }`: the byte offset of the next record. Every reader resumes from a `locate` body offset, from a record's `end`, or from a record's `start` (retry).
- The 4 MiB per-record cap (`MAX_RECORD_BYTES`) applies to every format; one record over it fails the job with `source_syntax` (CSV: `csv_syntax`).
- UTF-8 only; a leading UTF-8 BOM is skipped.
- XML: a `<!DOCTYPE …>` with an internal subset or an external ID fails with `xml_dtd_not_allowed`; only the five predefined entities and numeric character references are decoded; external entities are never resolved; names match as written (no namespace URIs).
- Error codes, exactly: record level `invalid_record`, `not_scalar`, plus the existing value codes (`missing_key`, `invalid_number`, `invalid_date`, `empty_slug`, `key_too_long`, `column_count`); job level `source_syntax`, `unsupported_encoding`, `xml_dtd_not_allowed` (CSV keeps `csv_syntax`); job creation `invalid_source`.
- `sources/paste`: input `{ format: "csv" | "json" | "jsonl" | "xml", text: string }`, `permission: "import:execute"`, request body at most 1 MiB, returns `{ uploadId, bytes, sha256 }`; empty text is `EMPTY_BODY`.
- The upload route accepts `.csv`, `.json`, `.jsonl`, `.ndjson`, `.xml`; the template's `source.format` decides parsing.
- All plugin routes declare `permission: "import:execute"`. State-changing requests from session callers need `X-EmDash-Request: 1`; Bearer PATs skip CSRF but need the `admin` scope.
- Storage only through `emdash.storage`; staged files keep unguessable keys that never appear in unauthenticated responses.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; tasks that touch integration also pass `pnpm test:integration` (about 7 minutes after this plan) and, for Task 10, `pnpm test:cf` (about 15 minutes).

## Review Focus

1. A UTF-16 file (Excel's "Unicode text", PowerShell's default JSON export) must fail with `unsupported_encoding`, not import mojibake or report every record broken — tests in Task 2 ("rejects UTF-16"), Task 4 and Task 5.
2. Strings inside skipped JSON values and inside records that contain `]`, `}`, `[`, `{` or escaped quotes, and a decoy key with the records path's name nested elsewhere, must not move record boundaries — test in Task 4 ("walks the records path, skipping other keys").
3. Re-importing the same JSON or XML file must report every record `unchanged` (JSON numbers and XML `"12.50"` text must survive EmDash's round trip as numbers) — tests in Task 7 ("reports every record unchanged") and Task 9 (end-to-end re-import).
4. A job created before M3a (stored with `headers` and no `source`) must still run after the upgrade — test in Task 7 ("jobs created before M3a").
5. A sample of a few huge records must not build a response of many megabytes (`SAMPLE_MAX_BYTES`), and pasted text over 1 MiB must answer 413, not 500 — tests in Task 2 (`takeSample`), Task 8 (`stagePaste`) and Task 9 ("rejects empty text and a request over 1 MiB").

## Facts this plan relies on

Found while writing this plan, against the installed packages; tasks cite them by number.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | A plugin route may declare `request: { body: "json", maxBytes }`. EmDash then reads the body with that limit and answers a larger one with 413 and code `INVALID_PLUGIN_REQUEST` before the handler runs; Zod `input` validation still applies. The default limit is 1 MiB, the maximum 8 MiB. | `src/plugins/types.ts:1926-1927`, `src/plugins/routes.ts:91-105,132-136`, `src/plugins/route-wire.ts:76-92,177-195`, `src/emdash-runtime.ts:5626-5638`, `@emdash-cms/plugin-types@0.6.0` `dist/index.js:4-5` |
| F2 | Route input that fails its Zod schema answers 400 `VALIDATION_ERROR` without calling the handler; so an empty `text` must pass Zod (`z.string()`) for the service to answer `EMPTY_BODY`. | `src/plugins/routes.ts:245-260` |
| F3 | `JSON.parse` in Node 22 parses a 10,000-level nested array, and `JSON.parse("1e999")` is `Infinity` (number fields must check `Number.isFinite`). | prototype test "parses deep nesting inside a record"; Node REPL |
| F4 | `new Blob([bytes]).stream()` works on Node and workerd; piping it through `FixedLengthStream` into R2 works (paste on `sites/dev-cf`). | Task 10 test, run while drafting |
| F5 | The 10,000-record JSON fixture is 1,585,562 bytes, over the shared integration server's `TEST_MAX_SOURCE_BYTES` (1,000,000), so the kill-and-resume server starts with a 4,000,000-byte limit. | measured while drafting |
| F6 | Staged keys end in `.csv` (`uploadKey`, `src/emdash/uploads.ts` in this package) and are private; the stored content type is irrelevant to reading. Renaming the suffix would orphan files staged before M3a. | `packages/flux-import/src/emdash/uploads.ts:34-37,165` |
| F7 | Plugin-route raw responses are capped at 8 MiB but JSON responses are not checked; a `sources/sample` of 20 records of up to 4 MiB each could build an 80 MB response, so sampling stops at 1 MiB of record bytes. | `src/plugins/route-wire.ts:284-290` |
| F8 | On Node 22.23, cancelling a `Readable.toWeb(createReadStream(…))` stream (the local storage adapter's download body) in the same microtask run as a `read()` that resumed the paused file stream crashes the whole process: Node enqueues into the closed controller from `process.nextTick` (`ERR_INVALID_STATE: Controller is already closed`, uncaught). The new readers cancel exactly then when a batch, sample or header read stops right after a chunk; it killed the dev server in 3 of 4 JSON kill-and-resume runs while drafting. Delaying the cancel by one macrotask avoids it (reproduced and fixed in a standalone script and in the Task 1 test). | `src/storage/local.ts:113-134`; Task 1 test "survives cancelling a Node file stream" fails with unhandled `ERR_INVALID_STATE` without the delay |

## Rulings this plan makes

- **Staged-file streams cancel one macrotask late** (`deferCancel` in `EmDashUploads.open`, F8). It is a workaround for a Node bug that every reader (CSV included) can trigger; it costs one timer per opened stream.
- **One error type for sources.** `SourceError(code, message, offset)` with codes `csv_syntax`, `source_syntax`, `unsupported_encoding`, `xml_dtd_not_allowed`, `invalid_source`. The CSV reader converts `CsvSyntaxError` to `SourceError("csv_syntax")`, so `csv.ts` stays unchanged and `runBatch` stores `e.code` as the job error. At job creation every `SourceError` becomes `JobError("invalid_source")` (HTTP 400 `INVALID_SOURCE`) with the source code and offset in `details` (`"xml_dtd_not_allowed at byte 0"`).
- **`readerFor(source, columns = [])`.** The spec's `readerFor(source)` cannot read CSV records without the header, so CSV columns are a second argument.
- **`records` misuse is `invalid_source`, not `invalid_template`.** The Zod `source` schema accepts `records` for every format; `checkSource` reports it where not allowed (csv, jsonl), missing (xml) or malformed. XML records paths need at least two segments (root and record element).
- **Job shape.** New jobs store `source`, `columns` (CSV only) and `warnings`; `headers` stays as an optional legacy field. `jobReader(job)` and `jobTemplate(job)` treat a job without `source` (and a stored template without `source`) as CSV with `headers` as its columns.
- **Reading stops at the end of the records.** JSON stops at the records array's `]`, XML when the root element closes; bytes after that are neither read nor validated.
- **JSON specifics.** The first of duplicate keys wins while walking `records`. A cursor at the array start (`seq` 0) rejects a leading comma; a cursor after a record accepts one. A trailing comma, a missing comma or a mismatched bracket is `source_syntax`. A record that is not valid UTF-8 or does not parse is `invalid_record`.
- **XML specifics.** Every element whose ancestors are exactly the earlier path segments is a record, so repeated parents (`rss/channel`) are all read; elements at other depths are ignored. At a record boundary the open elements are always the path's parents, which is what lets a reader resume from an offset. A self-closing root is `invalid_source`. An element without attributes or child elements becomes its text (`""` when empty); the record element is always an object; `#text` (concatenated text and CDATA) is kept only when not blank; line endings in a record become `\n`; attribute values are not whitespace-normalised. Comments, processing instructions and CDATA are tracked by the scanner; a DOCTYPE after the root starts is `source_syntax`.
- **Encodings.** A UTF-16 byte-order mark fails JSON, JSON Lines and XML with `unsupported_encoding` (the spec names only XML declarations); an XML declaration must name `UTF-8` (also `utf8`, any case). CSV keeps its lenient decoding.
- **Paths.** `resolvePath` returns `undefined` for a missing path (`null` stays `null`). Walking stops at an array, which is the result (M3a has no indexes), so a scalar field reading an array fails `not_scalar`. In XML a path ending at an element without child elements reads its `#text` (or `""`).
- **Typed conversion.** JSON numbers go into number fields as they are (non-finite is `invalid_number`); numbers and booleans become their string for text and date fields and for the key and slug; booleans into number fields are `invalid_number`; objects and arrays are `not_scalar` for every mapping, key and slug included.
- **Warnings.** Computed at creation from the first 20 records read (records with an error count toward the 20 but add no values). A structural error inside those 20 ends the sample; the job is still created and fails at that offset when it runs, as CSV does with a broken row. CSV never gets warnings (its columns are checked against the header).
- **Sample.** `sources/sample` takes the template's `source` (default CSV). CSV answers `{ headers, rows }` as before; other formats `{ records, paths }`, where records that fail to parse are left out and sampling stops once the records hold 1 MiB (one record at least, F7). `paths` lists leaf paths in first-seen order; JSON keys containing `.` are left out (a dot path cannot address them).
- **Paste.** `request.maxBytes` = 1 MiB bounds the JSON request (F1, 413 `INVALID_PLUGIN_REQUEST`); the service also caps the text's UTF-8 bytes at 1 MiB (413 `TOO_LARGE`). Whitespace-only text counts as empty (`EMPTY_BODY`). `format` is validated but, like an upload's extension, does not change staging.
- **Staged keys** keep the `.csv` suffix for every format (F6).
- **JSON Lines** has no structure to break: its malformed fixture fails records only and the job completes.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (83 files) |
| `pnpm test` | 25 files / 342 tests pass (199 tests before this plan); the four 10,000-record unit tests take 3–4 s each |
| Task-by-task replay | Applying each task's files in order on a clean tree, every intermediate state passed `pnpm typecheck`, `pnpm lint` and `pnpm test` with the per-file counts given in each task's Step 4 |
| `pnpm test:integration` | 6 files / 29 tests pass in 391 s (was 5 files / 18 tests). Kill-and-resume: CSV 1–2 records left `writing`, JSON 2, no duplicates, none unpublished. Before Task 1's fix the JSON case crashed the server in 3 of 4 runs (F8) |
| `vitest run --config vitest.cf.config.ts -t JSON` | the new parity test passes (12 s); the rest of `pnpm test:cf` was not re-run |

## File map

| File | Responsibility |
| --- | --- |
| `src/emdash/uploads.ts` | `deferCancel` for staged-file streams (F8) |
| `src/sources/reader.ts` (new) | Reader contract (`RecordReader`, `SourceRecord`, `TemplateSource`), `SourceError`, byte helpers, the scanner driver `runScanner`, `takeSample` |
| `src/sources/csv-reader.ts` (new) | `csvReader(columns)`: `sources/csv.ts` behind the contract |
| `src/sources/paths.ts` (new) | `resolvePath`, `collectPaths`, path syntax checks |
| `src/sources/json.ts` (new) | JSON (array or records path) and JSON Lines scanners and readers |
| `src/sources/xml.ts`, `src/sources/xml-record.ts` (new) | XML boundary scanner and reader; record element parser |
| `src/sources/readers.ts` (new) | `checkSource`, `readerFor` |
| `src/engine/template.ts` | `source` block, typed conversion, `not_scalar`, path checks, warnings |
| `src/engine/types.ts`, `src/engine/jobs.ts`, `src/engine/batch.ts` | Job stores `source`/`columns`/`warnings`; creation and batches go through readers |
| `src/plugin/service.ts`, `src/plugin/routes.ts` | `sources/sample` with `source`, `sources/paste` |
| `src/astro/upload-route.ts` | New extensions |
| `tests/fixtures/formats.ts` (new) | JSON, JSON Lines and XML fixtures (10, 10,000, malformed) shared by unit and integration tests |

`src/sources/csv.ts` does not change.

---

### Task 1: Cancel staged-file streams safely

**Files:**
- Modify: `packages/flux-import/src/emdash/uploads.ts` (new `deferCancel`, used by `EmDashUploads.open`)
- Test: `packages/flux-import/tests/unit/uploads.test.ts`

**Interfaces:**
- Consumes: `EmDashUploads.open(uploadId, offset)` (M2), `streamOf` (`tests/unit/helpers.ts`).
- Produces: `deferCancel(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>` — same bytes, `highWaterMark: 0`, and `cancel()` waits one `setTimeout(0)` before cancelling `body`. `EmDashUploads.open` returns `deferCancel(result.body)` on its normal path; its other behaviour is unchanged.

Why first: F8. Without it the Task 9 kill-and-resume test on JSON crashes the dev server (the bug can hit CSV too; it is timing-dependent).

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/uploads.test.ts`, replace the first two import lines
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
```
with:
```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
```
add `deferCancel,` as the first name in the `../../src/emdash/uploads.js` import, and append:
```ts
describe("deferCancel", () => {
	it("passes the bytes through and cancels the source", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("ab"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const reader = deferCancel(source).getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("ab");
		await reader.cancel();
		expect(cancelled).toBe(true);
		expect(await text(deferCancel(streamOf("xyz", 1)))).toBe("xyz");
	});

	it("survives cancelling a Node file stream right after a read (local storage adapter)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "flux-import-cancel-"));
		const file = join(dir, "big.bin");
		await writeFile(file, Buffer.alloc(1_600_000, 0x61));
		try {
			for (let n = 0; n < 30; n++) {
				const body = Readable.toWeb(createReadStream(file, { start: 1000 * n }));
				const reader = deferCancel(body as ReadableStream<Uint8Array>).getReader();
				await reader.read();
				// Let the file stream fill its buffer and pause, then read and cancel at once.
				await new Promise((r) => setTimeout(r, 5));
				await reader.read();
				await reader.cancel();
			}
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/uploads.test.ts`
Expected: FAIL — `deferCancel` is not exported. (With a `deferCancel` that cancels immediately, the second test fails with unhandled `ERR_INVALID_STATE: Controller is already closed`; this was checked while drafting.)

- [ ] **Step 3: Implement**

In `packages/flux-import/src/emdash/uploads.ts`, insert before `export class UploadTooLargeError extends Error {`:
```ts
/**
 * Passes `body` through and delays cancelling it by one macrotask. The local adapter's body is
 * `Readable.toWeb(createReadStream(…))` (`emdash` src/storage/local.ts:123-134); on Node 22.23
 * cancelling that stream in the same microtask run as a `read()` that resumed the paused file
 * stream makes Node enqueue into the closed controller from `process.nextTick` and crash the
 * process (ERR_INVALID_STATE "Controller is already closed"). Readers cancel exactly like that
 * when a batch, a sample or a header read stops early.
 */
export function deferCancel(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			async cancel(reason) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				await reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}
```
and in `EmDashUploads.open` replace the final `return result.body;` with `return deferCancel(result.body);`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/uploads.test.ts`
Expected: PASS (15 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/emdash/uploads.ts packages/flux-import/tests/unit/uploads.test.ts
git commit -m "Delay cancelling staged-file streams to avoid a Node crash on early stops"
```

### Task 2: Reader contract, byte helpers and the CSV reader

**Files:**
- Create: `packages/flux-import/src/sources/reader.ts`, `packages/flux-import/src/sources/csv-reader.ts`
- Modify: `packages/flux-import/tests/unit/helpers.ts` (replace the whole file)
- Test: `packages/flux-import/tests/unit/reader.test.ts`

**Interfaces:**
- Consumes: `sources/csv.ts` (unchanged): `MAX_RECORD_BYTES`, `CsvSyntaxError(message, offset)`, `readCsvHeader(stream): Promise<{ headers: string[]; bodyOffset: number }>`, `readCsvRecords(stream, { headers, startOffset, startSeq }): AsyncGenerator<CsvRecord>` (`CsvRecord.error?: "column_count"`), `readCsvSample(stream, n): Promise<{ headers: string[]; rows: string[][] }>`, `dropBytes(stream, n)`.
- Produces (`src/sources/reader.ts`):
  - `type SourceFormat = "csv" | "json" | "jsonl" | "xml"`; `const SOURCE_FORMATS: readonly ["csv", "json", "jsonl", "xml"]`
  - `interface TemplateSource { format: SourceFormat; records?: string | undefined }`; `const CSV_SOURCE: TemplateSource`
  - `MAX_RECORD_BYTES` (re-exported from `csv.ts`, 4 MiB)
  - `interface SourceRecord { seq: number; start: number; end: number; value: unknown; error?: { code: string; message: string } }`
  - `interface ValueSample { records: unknown[]; paths: string[] }`
  - `interface RecordReader { locate(stream): Promise<{ bodyOffset: number; columns?: string[] }>; read(stream, { startOffset, startSeq }): AsyncGenerator<SourceRecord>; sample(stream, n): Promise<ValueSample> }`
  - `type SourceErrorCode = "csv_syntax" | "source_syntax" | "unsupported_encoding" | "xml_dtd_not_allowed" | "invalid_source"`; `class SourceError extends Error { readonly code: SourceErrorCode; readonly offset: number }` (constructor `(code, message, offset)`)
  - `const SAMPLE_MAX_BYTES = 1024 * 1024`; `takeSample(records: AsyncGenerator<SourceRecord>, n: number): Promise<unknown[]>`
  - `chunksOf(stream)`, `class ByteBuffer { length; push(b); pushAll(bytes); bytes(); clear() }`, `decodeUtf8(bytes): string | null` (strict), `isJsonSpace(b): boolean`, `bomLength(head): number`
  - `positioned(stream, startOffset): AsyncGenerator<{ bytes: Uint8Array; offset: number }>` (offset 0 skips a UTF-8 BOM and rejects UTF-16)
  - `interface ByteScanner { readonly done: boolean; step(b, pos): void; finish(end): void; drain(): SourceRecord[] }`; `runScanner(stream, startOffset, scanner): AsyncGenerator<SourceRecord>`
- Produces (`src/sources/csv-reader.ts`): `csvReader(columns: readonly string[]): RecordReader` (record errors `{ code: "column_count", message: "Expected N columns" }`; failures are `SourceError("csv_syntax")`).
- Produces (`tests/unit/helpers.ts`, for Tasks 4 to 6): `readAll(reader, input, chunkSize = 65536): Promise<SourceRecord[]>` (locate, then read from the body offset), `readFrom(reader, input, offset, seq, chunkSize = 3)`, `expectReaderInvariants(reader, input): Promise<SourceRecord[]>` (same records at chunk sizes 65536, 1 and 5; resuming after every record gives the rest; reading from every record's start gives that record first). `streamOf` and `collect` are unchanged.

- [ ] **Step 1: Write the failing tests**

Replace `packages/flux-import/tests/unit/helpers.ts` with:
```ts
import { expect } from "vitest";
import { dropBytes } from "../../src/sources/csv.js";
import type { RecordReader, SourceRecord } from "../../src/sources/reader.js";

export function streamOf(
	input: string | Uint8Array,
	chunkSize = 1 << 16,
): ReadableStream<Uint8Array> {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(i, i + chunkSize));
			i += chunkSize;
		},
	});
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}

/** Locates, then reads every record, delivering the input in `chunkSize`-byte chunks. */
export async function readAll(
	reader: RecordReader,
	input: string | Uint8Array,
	chunkSize = 1 << 16,
): Promise<SourceRecord[]> {
	const { bodyOffset } = await reader.locate(streamOf(input, chunkSize));
	const stream = dropBytes(streamOf(input, chunkSize), bodyOffset);
	return collect(reader.read(stream, { startOffset: bodyOffset, startSeq: 0 }));
}

/** Reads from `offset` as a job resumes: the stream starts at that byte. */
export function readFrom(
	reader: RecordReader,
	input: string | Uint8Array,
	offset: number,
	seq: number,
	chunkSize = 3,
): Promise<SourceRecord[]> {
	const stream = dropBytes(streamOf(input, chunkSize), offset);
	return collect(reader.read(stream, { startOffset: offset, startSeq: seq }));
}

/**
 * The scanner invariants every reader must keep: the same records whatever the chunk size (one
 * byte at a time included), resuming after any record gives the rest, and reading from a
 * record's start (as a retry does) gives that record first. Returns the records.
 */
export async function expectReaderInvariants(
	reader: RecordReader,
	input: string | Uint8Array,
): Promise<SourceRecord[]> {
	const whole = await readAll(reader, input);
	expect(await readAll(reader, input, 1)).toEqual(whole);
	expect(await readAll(reader, input, 5)).toEqual(whole);
	for (let i = 0; i < whole.length; i++) {
		const rec = whole[i]!;
		expect(await readFrom(reader, input, rec.end, rec.seq + 1)).toEqual(whole.slice(i + 1));
		expect((await readFrom(reader, input, rec.start, rec.seq))[0]).toEqual(rec);
	}
	return whole;
}
```

Create `packages/flux-import/tests/unit/reader.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { csvReader } from "../../src/sources/csv-reader.js";
import {
	positioned,
	SAMPLE_MAX_BYTES,
	SourceError,
	type SourceRecord,
	takeSample,
} from "../../src/sources/reader.js";
import { collect, expectReaderInvariants, readAll, streamOf } from "./helpers.js";

async function* records(list: SourceRecord[]): AsyncGenerator<SourceRecord> {
	yield* list;
}

describe("positioned", () => {
	it("skips a UTF-8 BOM split across one-byte chunks and keeps absolute offsets", async () => {
		const chunks = await collect(positioned(streamOf("﻿ab", 1), 0));
		expect(chunks.map((c) => [c.offset, [...c.bytes]])).toEqual([
			[3, []],
			[3, [0x61]],
			[4, [0x62]],
		]);
	});

	it("starts at the given offset without looking for a BOM", async () => {
		const chunks = await collect(positioned(streamOf("xy"), 10));
		expect(chunks.map((c) => c.offset)).toEqual([10]);
	});

	it("passes inputs shorter than a BOM through", async () => {
		const chunks = await collect(positioned(streamOf("a"), 0));
		expect(chunks.map((c) => [c.offset, c.bytes.length])).toEqual([[0, 1]]);
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		for (const bom of [
			[0xff, 0xfe],
			[0xfe, 0xff],
		]) {
			const error = await collect(positioned(streamOf(new Uint8Array([...bom, 0x41, 0])), 0)).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(SourceError);
			expect(error).toMatchObject({ code: "unsupported_encoding", offset: 0 });
		}
	});
});

describe("takeSample", () => {
	const rec = (seq: number, size: number, error = false): SourceRecord => ({
		seq,
		start: seq * size,
		end: (seq + 1) * size,
		value: seq,
		...(error ? { error: { code: "invalid_record", message: "bad" } } : {}),
	});

	it("skips records with errors and stops at n", async () => {
		const list = [rec(0, 1), rec(1, 1, true), rec(2, 1), rec(3, 1)];
		expect(await takeSample(records(list), 2)).toEqual([0, 2]);
	});

	it("stops once the sampled records reach SAMPLE_MAX_BYTES, keeping at least one", async () => {
		const big = SAMPLE_MAX_BYTES / 2;
		expect(await takeSample(records([rec(0, big), rec(1, big), rec(2, big)]), 20)).toEqual([0, 1]);
		expect(await takeSample(records([rec(0, SAMPLE_MAX_BYTES * 2)]), 20)).toEqual([0]);
	});
});

const TRICKY =
	"﻿sku,name,notes\r\n" +
	'A1,"Ș, ț and ""quotes""","line one\r\nline two"\r\n' +
	"\r\n" +
	"B2,日本 🚀\n" +
	"C3,last,no newline";

describe("csvReader", () => {
	it("locates the body after the header and returns the columns", async () => {
		expect(await csvReader([]).locate(streamOf(TRICKY))).toEqual({
			bodyOffset: 3 + "sku,name,notes\r\n".length,
			columns: ["sku", "name", "notes"],
		});
	});

	it("keeps every invariant and reports column_count with the expected count", async () => {
		const reader = csvReader(["sku", "name", "notes"]);
		const recs = await expectReaderInvariants(reader, TRICKY);
		expect(recs.map((r) => [r.seq, r.value, r.error])).toEqual([
			[0, { sku: "A1", name: 'Ș, ț and "quotes"', notes: "line one\r\nline two" }, undefined],
			[
				1,
				{ sku: "B2", name: "日本 🚀", notes: "" },
				{ code: "column_count", message: "Expected 3 columns" },
			],
			[2, { sku: "C3", name: "last", notes: "no newline" }, undefined],
		]);
	});

	it("turns CSV syntax errors into SourceError csv_syntax with the offset", async () => {
		const error = await readAll(csvReader(["a", "b"]), 'a,b\n1,"open\n').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "csv_syntax", offset: 4 });
		await expect(csvReader([]).locate(streamOf(""))).rejects.toMatchObject({ code: "csv_syntax" });
	});

	it("samples rows as objects with the header as paths", async () => {
		expect(await csvReader([]).sample(streamOf("sku,name\nA,1\nB\n"), 5)).toEqual({
			records: [
				{ sku: "A", name: "1" },
				{ sku: "B", name: "" },
			],
			paths: ["sku", "name"],
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/reader.test.ts`
Expected: FAIL — `src/sources/reader.js` and `src/sources/csv-reader.js` do not exist.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/sources/reader.ts`:
```ts
export type SourceFormat = "csv" | "json" | "jsonl" | "xml";

export const SOURCE_FORMATS = [
	"csv",
	"json",
	"jsonl",
	"xml",
] as const satisfies readonly SourceFormat[];

/** The template's `source` block. `records` is a dot path (json) or a `/` path (xml). */
export interface TemplateSource {
	format: SourceFormat;
	records?: string | undefined;
}

export const CSV_SOURCE: TemplateSource = { format: "csv" };

/** The 4 MiB per-record cap (sources/csv.ts) applies to every format. */
export { MAX_RECORD_BYTES } from "./csv.js";

export interface SourceRecord {
	seq: number;
	/** Byte offset of the record's first byte. */
	start: number;
	/** Byte offset just past the record; the next read resumes here. */
	end: number;
	/** The parsed record: `Record<string, string>` for CSV, any JSON value, an object for XML. */
	value: unknown;
	/** A record-level problem (`column_count`, `invalid_record`); `value` is then `null` or partial. */
	error?: { code: string; message: string };
}

export interface ValueSample {
	records: unknown[];
	paths: string[];
}

export interface RecordReader {
	/** Finds where records begin. CSV also reads the header. */
	locate(stream: ReadableStream<Uint8Array>): Promise<{ bodyOffset: number; columns?: string[] }>;
	/**
	 * Reads records from `startOffset`: the `bodyOffset` from `locate`, a record's `end`, or a
	 * record's `start`. Offset 0 locates first. `startSeq` numbers the first record read.
	 */
	read(
		stream: ReadableStream<Uint8Array>,
		opts: { startOffset: number; startSeq: number },
	): AsyncGenerator<SourceRecord>;
	/** Locates and reads up to `n` records (skipping record-level errors) and their field paths. */
	sample(stream: ReadableStream<Uint8Array>, n: number): Promise<ValueSample>;
}

export type SourceErrorCode =
	| "csv_syntax"
	| "source_syntax"
	| "unsupported_encoding"
	| "xml_dtd_not_allowed"
	| "invalid_source";

/** A problem with the whole source: it fails job creation, or the job at `offset`. */
export class SourceError extends Error {
	constructor(
		readonly code: SourceErrorCode,
		message: string,
		readonly offset: number,
	) {
		super(message);
		this.name = "SourceError";
	}
}

/** Sampled responses stop adding records once they hold this many source bytes (one at least). */
export const SAMPLE_MAX_BYTES = 1024 * 1024;

/** Collects up to `n` error-free record values, stopping early at `SAMPLE_MAX_BYTES`. */
export async function takeSample(
	records: AsyncGenerator<SourceRecord>,
	n: number,
): Promise<unknown[]> {
	const values: unknown[] = [];
	let bytes = 0;
	for await (const rec of records) {
		if (rec.error) continue;
		values.push(rec.value);
		bytes += rec.end - rec.start;
		if (values.length >= n || bytes >= SAMPLE_MAX_BYTES) break;
	}
	return values;
}

/** Bytes as the reader sees them: one chunk at a time, cancelling the stream when done. */
export async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** A growable byte buffer for one record. */
export class ByteBuffer {
	private buf = new Uint8Array(256);
	length = 0;

	push(b: number): void {
		if (this.length === this.buf.length) {
			const next = new Uint8Array(this.buf.length * 2);
			next.set(this.buf);
			this.buf = next;
		}
		this.buf[this.length++] = b;
	}

	pushAll(bytes: Uint8Array): void {
		for (const b of bytes) this.push(b);
	}

	bytes(): Uint8Array {
		return this.buf.subarray(0, this.length);
	}

	clear(): void {
		this.length = 0;
		if (this.buf.length > 1 << 16) this.buf = new Uint8Array(256);
	}
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8, or returns null for invalid bytes. */
export function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		return null;
	}
}

export const isJsonSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/** Throws `unsupported_encoding` for a UTF-16 byte-order mark; returns the UTF-8 BOM's length. */
export function bomLength(head: Uint8Array): number {
	if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 3;
	if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
		throw new SourceError("unsupported_encoding", "The file is UTF-16; save it as UTF-8", 0);
	}
	return 0;
}

/**
 * The stream's chunks with the absolute offset of each one's first byte. Reading from offset 0
 * skips a UTF-8 BOM and rejects a UTF-16 one, whatever the chunk sizes.
 */
export async function* positioned(
	stream: ReadableStream<Uint8Array>,
	startOffset: number,
): AsyncGenerator<{ bytes: Uint8Array; offset: number }> {
	let head: Uint8Array | null = startOffset === 0 ? new Uint8Array(0) : null;
	let offset = startOffset;
	for await (const chunk of chunksOf(stream)) {
		if (head === null) {
			yield { bytes: chunk, offset };
			offset += chunk.length;
			continue;
		}
		const joined = new Uint8Array(head.length + chunk.length);
		joined.set(head);
		joined.set(chunk, head.length);
		if (joined.length < 3) {
			head = joined;
			continue;
		}
		head = null;
		const skip = bomLength(joined);
		yield { bytes: joined.subarray(skip), offset: skip };
		offset = joined.length;
	}
	if (head !== null && head.length > 0) yield { bytes: head, offset: bomLength(head) };
}

/** A byte-at-a-time boundary scanner; `runScanner` feeds it. */
export interface ByteScanner {
	/** Set once the scanner needs no more input (end of the records, or the body was located). */
	readonly done: boolean;
	step(b: number, pos: number): void;
	/** Called at end of input with the offset just past the last byte; throws if input is cut short. */
	finish(end: number): void;
	/** Takes the records completed so far. */
	drain(): SourceRecord[];
}

/**
 * Feeds the stream to `scanner` from `startOffset` and yields records as chunks complete them.
 * Records completed before an error are yielded before it is thrown.
 */
export async function* runScanner(
	stream: ReadableStream<Uint8Array>,
	startOffset: number,
	scanner: ByteScanner,
): AsyncGenerator<SourceRecord> {
	let end = startOffset;
	for await (const { bytes, offset } of positioned(stream, startOffset)) {
		try {
			for (let i = 0; i < bytes.length && !scanner.done; i++) {
				scanner.step(bytes[i] as number, offset + i);
			}
		} catch (e) {
			yield* scanner.drain();
			throw e;
		}
		yield* scanner.drain();
		if (scanner.done) return;
		end = offset + bytes.length;
	}
	scanner.finish(end);
	yield* scanner.drain();
}
```

Create `packages/flux-import/src/sources/csv-reader.ts`:
```ts
import { CsvSyntaxError, readCsvHeader, readCsvRecords, readCsvSample } from "./csv.js";
import { type RecordReader, SourceError } from "./reader.js";

function asSourceError(e: unknown): unknown {
	return e instanceof CsvSyntaxError ? new SourceError("csv_syntax", e.message, e.offset) : e;
}

/** Today's CSV reader behind the shared interface; `columns` are the job's header columns. */
export function csvReader(columns: readonly string[]): RecordReader {
	return {
		async locate(stream) {
			try {
				const header = await readCsvHeader(stream);
				return { bodyOffset: header.bodyOffset, columns: header.headers };
			} catch (e) {
				throw asSourceError(e);
			}
		},
		async *read(stream, opts) {
			try {
				for await (const r of readCsvRecords(stream, { headers: [...columns], ...opts })) {
					yield {
						seq: r.seq,
						start: r.start,
						end: r.end,
						value: r.values,
						...(r.error
							? { error: { code: r.error, message: `Expected ${columns.length} columns` } }
							: {}),
					};
				}
			} catch (e) {
				throw asSourceError(e);
			}
		},
		async sample(stream, n) {
			try {
				const { headers, rows } = await readCsvSample(stream, n);
				const records = rows.map((row) =>
					Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])),
				);
				return { records, paths: headers };
			} catch (e) {
				throw asSourceError(e);
			}
		},
	};
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/reader.test.ts`
Expected: PASS (10 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/reader.ts packages/flux-import/src/sources/csv-reader.ts packages/flux-import/tests/unit/helpers.ts packages/flux-import/tests/unit/reader.test.ts
git commit -m "Add the format-neutral record reader contract and wrap the CSV reader in it"
```

### Task 3: Field paths

**Files:**
- Create: `packages/flux-import/src/sources/paths.ts`
- Test: `packages/flux-import/tests/unit/paths.test.ts`

**Interfaces:**
- Consumes: `SourceFormat` (Task 2).
- Produces:
  - `pathProblem(path: string, format: SourceFormat): string | null` — JSON: no empty dot segment; XML: `/` segments of element names, optionally ending in `@attr` or `#text`; CSV: non-empty.
  - `recordsPathProblem(records: string, format: "json" | "xml"): string | null` — XML needs at least two segments, all element names.
  - `resolvePath(value: unknown, path: string, format: SourceFormat): unknown` — `undefined` when missing; stops at arrays; XML text elements read as `#text` or `""`; own properties only.
  - `collectPaths(records: unknown[], format: "json" | "xml"): string[]` — leaf paths in first-seen order.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/paths.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	collectPaths,
	pathProblem,
	recordsPathProblem,
	resolvePath,
} from "../../src/sources/paths.js";

const json = {
	sku: "A1",
	price: { amount: 12.5, tax: null },
	tags: ["x", "y"],
	"a.b": "dotted",
	nested: { list: [{ id: 1 }] },
};
const xml = {
	"@sku": "A1",
	title: { "@lang": "en", "#text": "Desk" },
	flag: { "@on": "yes" },
	price: "12.50",
	images: { image: ["a.jpg", "b.jpg"] },
	body: { p: "x", "#text": "mixed" },
};

describe("resolvePath", () => {
	it("reads CSV cells by column name", () => {
		expect(resolvePath({ sku: "A1" }, "sku", "csv")).toBe("A1");
		expect(resolvePath({ sku: "A1" }, "name", "csv")).toBeUndefined();
		expect(resolvePath({}, "__proto__", "csv")).toBeUndefined();
	});

	it("walks JSON dot paths, keeping null and stopping at arrays", () => {
		expect(resolvePath(json, "price.amount", "json")).toBe(12.5);
		expect(resolvePath(json, "price.tax", "json")).toBeNull();
		expect(resolvePath(json, "price.missing", "json")).toBeUndefined();
		expect(resolvePath(json, "sku.length", "json")).toBeUndefined();
		expect(resolvePath(json, "tags", "json")).toEqual(["x", "y"]);
		expect(resolvePath(json, "nested.list.id", "json")).toEqual([{ id: 1 }]);
		expect(resolvePath("scalar", "sku", "json")).toBeUndefined();
		expect(resolvePath(json, "toString", "json")).toBeUndefined();
	});

	it("walks XML paths: attributes, text elements, repeated children", () => {
		expect(resolvePath(xml, "@sku", "xml")).toBe("A1");
		expect(resolvePath(xml, "title", "xml")).toBe("Desk");
		expect(resolvePath(xml, "title/@lang", "xml")).toBe("en");
		expect(resolvePath(xml, "flag", "xml")).toBe("");
		expect(resolvePath(xml, "price", "xml")).toBe("12.50");
		expect(resolvePath(xml, "price/@currency", "xml")).toBeUndefined();
		expect(resolvePath(xml, "images/image", "xml")).toEqual(["a.jpg", "b.jpg"]);
		expect(resolvePath(xml, "body", "xml")).toEqual({ p: "x", "#text": "mixed" });
		expect(resolvePath(xml, "body/#text", "xml")).toBe("mixed");
	});
});

describe("collectPaths", () => {
	it("lists JSON leaf paths in first-seen order, skipping keys with dots", () => {
		expect(collectPaths([json, { sku: "B2", extra: true }, 42], "json")).toEqual([
			"sku",
			"price.amount",
			"price.tax",
			"tags",
			"nested.list",
			"extra",
		]);
	});

	it("lists XML attributes, text elements and their attributes", () => {
		expect(collectPaths([xml], "xml")).toEqual([
			"@sku",
			"title",
			"title/@lang",
			"flag",
			"flag/@on",
			"price",
			"images/image",
			"body/p",
		]);
	});
});

describe("path syntax", () => {
	it.each([
		["json", "price.amount", null],
		["json", "price..amount", /empty key/],
		["xml", "title/@lang", null],
		["xml", "@sku", null],
		["xml", "body/#text", null],
		["xml", "@sku/title", /invalid/],
		["xml", "a b", /invalid/],
		["csv", "Any Column!", null],
	] as const)("%s path %s", (format, path, problem) => {
		const result = pathProblem(path, format);
		if (problem === null) expect(result).toBeNull();
		else expect(result).toMatch(problem);
	});

	it("checks records paths", () => {
		expect(recordsPathProblem("data.products", "json")).toBeNull();
		expect(recordsPathProblem("data.", "json")).toMatch(/empty key/);
		expect(recordsPathProblem("feed/item", "xml")).toBeNull();
		expect(recordsPathProblem("item", "xml")).toMatch(/root element and the record element/);
		expect(recordsPathProblem("feed/@sku", "xml")).toMatch(/invalid element name/);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/paths.test.ts`
Expected: FAIL — `src/sources/paths.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/sources/paths.ts`:
```ts
import type { SourceFormat } from "./reader.js";

const XML_NAME = /^[^\s/@#<>&"'=]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function segments(path: string, format: SourceFormat): string[] {
	return format === "xml" ? path.split("/") : path.split(".");
}

/**
 * Why `path` is not a valid field path for `format`, or null. JSON: dot-separated keys, none
 * empty. XML: `/`-separated element names, optionally ending in `@attribute` or `#text`.
 */
export function pathProblem(path: string, format: SourceFormat): string | null {
	if (format === "csv") return path === "" ? "The column name is empty" : null;
	const parts = segments(path, format);
	if (format !== "xml") {
		return parts.some((p) => p === "") ? `"${path}" has an empty key` : null;
	}
	for (const [i, part] of parts.entries()) {
		const last = i === parts.length - 1;
		const name = last && part.startsWith("@") ? part.slice(1) : part;
		if (last && part === "#text") continue;
		if (!XML_NAME.test(name)) return `"${path}" has an invalid element or attribute name "${part}"`;
	}
	return null;
}

/** Why `records` is not a valid records path for `format`, or null. */
export function recordsPathProblem(records: string, format: "json" | "xml"): string | null {
	const parts = segments(records, format);
	if (format === "json") {
		return parts.some((p) => p === "") ? `"${records}" has an empty key` : null;
	}
	if (parts.length < 2) {
		return `"${records}" must name the root element and the record element, as in "feed/item"`;
	}
	const bad = parts.find((p) => !XML_NAME.test(p));
	return bad === undefined ? null : `"${records}" has an invalid element name "${bad}"`;
}

/** An XML element object without child elements: only `@attributes` and `#text`. */
function isTextElement(v: Record<string, unknown>): boolean {
	return Object.keys(v).every((k) => k === "#text" || k.startsWith("@"));
}

/**
 * Reads a field value from a record. CSV: the column's cell. JSON: walks own object keys. XML:
 * walks child elements and `@attributes`; an element without child elements reads as its text.
 * Walking stops at an array, which is the result (M3a has no array indexes). Returns
 * `undefined` when the path does not exist; JSON `null` stays `null`.
 */
export function resolvePath(value: unknown, path: string, format: SourceFormat): unknown {
	if (format === "csv") {
		return isPlainObject(value) && Object.hasOwn(value, path) ? value[path] : undefined;
	}
	let current: unknown = value;
	for (const part of segments(path, format)) {
		if (Array.isArray(current)) return current;
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined;
		current = current[part];
	}
	if (format === "xml" && isPlainObject(current) && isTextElement(current)) {
		return current["#text"] ?? "";
	}
	return current;
}

/**
 * The distinct field paths in sampled records, in first-seen order, for the mapper. Nested
 * objects are walked; arrays and scalars are leaves. JSON keys containing "." cannot be
 * addressed and are left out. XML lists `@attributes`, text elements, and `#text` is implied.
 */
export function collectPaths(records: unknown[], format: "json" | "xml"): string[] {
	const found = new Set<string>();
	const sep = format === "xml" ? "/" : ".";
	const walk = (obj: Record<string, unknown>, prefix: string) => {
		for (const [key, v] of Object.entries(obj)) {
			if (key === "#text" || (format === "json" && key.includes("."))) continue;
			const path = prefix === "" ? key : `${prefix}${sep}${key}`;
			if (!isPlainObject(v)) {
				found.add(path);
				continue;
			}
			if (format === "xml" && isTextElement(v)) found.add(path);
			walk(v, path);
		}
	};
	for (const record of records) if (isPlainObject(record)) walk(record, "");
	return [...found];
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/paths.test.ts`
Expected: PASS (14 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/paths.ts packages/flux-import/tests/unit/paths.test.ts
git commit -m "Resolve JSON dot paths and XML element paths in records"
```

### Task 4: JSON and JSON Lines readers

**Files:**
- Create: `packages/flux-import/src/sources/json.ts`
- Test: `packages/flux-import/tests/unit/json.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ByteBuffer`, `ByteScanner`, `decodeUtf8`, `isJsonSpace`, `MAX_RECORD_BYTES`, `RecordReader`, `runScanner`, `SourceError`, `SourceRecord`, `takeSample`; test helpers `readAll`, `expectReaderInvariants`, `streamOf`, `collect`); Task 3 (`collectPaths`); `dropBytes` from `sources/csv.ts`.
- Produces:
  - `jsonReader(records?: string): RecordReader` — no `records`: the top-level array; with `records` (`"data.products"`): walks object keys, skipping other values unparsed. `locate` throws `SourceError("invalid_source")` for a wrong top-level shape, a missing key, or a value that is not an object/array; `read` throws `source_syntax` for structural errors and records over the cap, and yields `invalid_record` records for elements that do not parse.
  - `jsonlReader(): RecordReader` — one record per non-blank line (LF or CRLF); `locate` returns the first line's offset (after a BOM).
  - `parseJsonRecord(bytes: Uint8Array): Pick<SourceRecord, "value" | "error">`.

The scanner is a state machine: navigation modes (`top`, `keyOrEnd`, `key`, `inKey`, `colon`, `memberValue`, `skip`, `afterMember`) walk to the records array; record modes (`resume`, `expectValue`, `inValue`, `afterValue`) cut elements. `ValueExtent` tracks one value's brackets, strings and escapes so skipping and cutting never parse. Reading from offset 0 navigates first; any other offset starts in `resume`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/json.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dropBytes } from "../../src/sources/csv.js";
import { jsonlReader, jsonReader } from "../../src/sources/json.js";
import { MAX_RECORD_BYTES, SourceError } from "../../src/sources/reader.js";
import { collect, expectReaderInvariants, readAll, streamOf } from "./helpers.js";

/** Decoys before the records: a "data.products" path inside another key, brackets in strings. */
const WRAPPED =
	"﻿{\n" +
	'  "meta": { "data": { "products": "decoy" }, "note": "a ] } [ { \\" tricky", "list": [1, [2, {"x": "]"}]] },\n' +
	'  "count": -1.5e3, "ok": true, "none": null,\n' +
	'  "data": { "skip": "products", "products": [\n' +
	'    {"sku": "A1", "name": "Ș, ț and \\"quotes\\" 日本 🚀", "price": {"amount": 12.5}},\n' +
	'    {"sku": "B2", "nested": {"deep": [[[{"a": "}"}]]]}, "esc": "\\u00e9\\n\\\\"} ,\n' +
	'    "just a string", 42 ,null,\n' +
	'    {"sku": "C3"}\n' +
	"  ] },\n" +
	'  "after": [1, 2]\n' +
	"}";

const values = (recs: { value: unknown }[]) => recs.map((r) => r.value);

describe("jsonReader", () => {
	it("walks the records path, skipping other keys, and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(jsonReader("data.products"), WRAPPED);
		expect(values(recs)).toEqual([
			{ sku: "A1", name: 'Ș, ț and "quotes" 日本 🚀', price: { amount: 12.5 } },
			{ sku: "B2", nested: { deep: [[[{ a: "}" }]]] }, esc: "é\n\\" },
			"just a string",
			42,
			null,
			{ sku: "C3" },
		]);
		expect(recs.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
		const bytes = new TextEncoder().encode(WRAPPED);
		expect(new TextDecoder().decode(bytes.subarray(recs[3]!.start, recs[3]!.end))).toBe("42");
	});

	it("reads a top-level array and skips a BOM", async () => {
		const input = '﻿ [ {"a": 1}, {"a": 2} ]  ';
		const recs = await expectReaderInvariants(jsonReader(), input);
		expect(values(recs)).toEqual([{ a: 1 }, { a: 2 }]);
		expect(await jsonReader().locate(streamOf(input))).toEqual({ bodyOffset: 3 + 2 });
	});

	it("reads an empty array as no records", async () => {
		expect(await readAll(jsonReader(), "[ ]")).toEqual([]);
		expect(await readAll(jsonReader("a"), '{"a": []}', 1)).toEqual([]);
	});

	it("parses deep nesting inside a record", async () => {
		const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
		const recs = await readAll(jsonReader(), `[${deep}, {"b": 1}]`, 1000);
		expect(recs).toHaveLength(2);
		expect(recs[0]!.error).toBeUndefined();
	});

	it("fails only the record whose bytes do not parse", async () => {
		const input = '[{"a": 1}, {"a": }, {"a": tru}, {"a": 3}]';
		const recs = await expectReaderInvariants(jsonReader(), input);
		expect(recs.map((r) => [r.value, r.error?.code])).toEqual([
			[{ a: 1 }, undefined],
			[null, "invalid_record"],
			[null, "invalid_record"],
			[{ a: 3 }, undefined],
		]);
	});

	it("fails a record that is not valid UTF-8", async () => {
		const bytes = new Uint8Array([0x5b, 0x22, 0xc3, 0x28, 0x22, 0x5d]); // ["\xC3("]
		const [rec] = await readAll(jsonReader(), bytes);
		expect(rec!.error).toMatchObject({ code: "invalid_record" });
	});

	it.each([
		["an unterminated string", '[{"a": 1}, {"a": "open]', 11],
		["an unterminated array", '[{"a": 1}, {"a": 2}', 19],
		["mismatched brackets", '[{"a": 1}, {"a": [1}]', 19],
		["two values without a comma", "[1 2]", 3],
		["a trailing comma", "[1, ]", 4],
		["a leading comma", "[, 1]", 1],
	])("fails the job with source_syntax and its offset for %s", async (_name, input, offset) => {
		const reader = jsonReader();
		const error = await readAll(reader, input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax", offset });
	});

	it("yields the records before a structural error, then throws", async () => {
		const input = '[{"a": 1}, {"a": 2}, {"a": "open';
		const seen: unknown[] = [];
		const read = jsonReader().read(dropBytes(streamOf(input), 1), { startOffset: 1, startSeq: 0 });
		const error = await (async () => {
			for await (const rec of read) seen.push(rec.value);
		})().catch((e: unknown) => e);
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
		expect(error).toMatchObject({ code: "source_syntax", offset: 21 });
	});

	it.each([
		["a top-level object without records", undefined, '{"a": []}', /source\.records/],
		["a top-level scalar", undefined, '"text"', /a string, not an array/],
		["an empty document", undefined, "  ", /empty/],
		[
			"a missing key",
			"data.items",
			'{"data": {"products": []}}',
			/Key "items" in "data" not found/,
		],
		[
			"a value that is not an array",
			"data",
			'{"data": {"x": 1}}',
			/"data" is an object, not an array/,
		],
		["a path through a scalar", "data.items", '{"data": 5}', /"data" is a number, not an object/],
		["a records path on an array", "data", "[1]", /needs an object/],
	])("fails locate with invalid_source for %s", async (_name, records, input, message) => {
		const error = await jsonReader(records)
			.locate(streamOf(input, 2))
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "invalid_source",
			message: expect.stringMatching(message),
		});
	});

	it("finds the first of duplicate keys", async () => {
		const recs = await readAll(jsonReader("a"), '{"a": [1], "a": [2]}');
		expect(values(recs)).toEqual([1]);
	});

	it("fails a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const input = `[1, "${"x".repeat(MAX_RECORD_BYTES)}"]`;
		const error = await readAll(jsonReader(), input).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "source_syntax", offset: 4 });
	});

	it("accepts a record just under the cap", async () => {
		const input = `["${"x".repeat(MAX_RECORD_BYTES - 10)}"]`;
		expect(await readAll(jsonReader(), input)).toHaveLength(1);
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		const utf16 = new Uint8Array([0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]);
		await expect(jsonReader().locate(streamOf(utf16, 1))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("samples records and their field paths", async () => {
		const sample = await jsonReader("data.products").sample(streamOf(WRAPPED), 2);
		expect(sample).toEqual({
			records: values((await readAll(jsonReader("data.products"), WRAPPED)).slice(0, 2)),
			paths: ["sku", "name", "price.amount", "nested.deep", "esc"],
		});
	});
});

describe("jsonlReader", () => {
	const LINES =
		'﻿{"sku": "A1", "name": "日本 🚀"}\r\n' +
		"\r\n" +
		"   \n" +
		'{"sku": "B2", "tags": ["x", "y"]}\n' +
		"{broken\n" +
		"[1, 2]\n" +
		'{"sku": "C3"}';

	it("reads one record per non-blank line and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(jsonlReader(), LINES);
		expect(recs.map((r) => [r.seq, r.value, r.error?.code])).toEqual([
			[0, { sku: "A1", name: "日本 🚀" }, undefined],
			[1, { sku: "B2", tags: ["x", "y"] }, undefined],
			[2, null, "invalid_record"],
			[3, [1, 2], undefined],
			[4, { sku: "C3" }, undefined],
		]);
		expect(recs[0]!.start).toBe(3);
		expect(recs.at(-1)!.end).toBe(new TextEncoder().encode(LINES).length);
	});

	it("locates after the BOM", async () => {
		expect(await jsonlReader().locate(streamOf(LINES))).toEqual({ bodyOffset: 3 });
		expect(await jsonlReader().locate(streamOf(""))).toEqual({ bodyOffset: 0 });
	});

	it("fails the job for a line larger than MAX_RECORD_BYTES", async () => {
		const input = `{"a": 1}\n"${"x".repeat(MAX_RECORD_BYTES)}"\n`;
		await expect(readAll(jsonlReader(), input)).rejects.toMatchObject({
			code: "source_syntax",
			offset: 9,
		});
	});

	it("rejects UTF-16 with unsupported_encoding", async () => {
		const utf16 = new Uint8Array([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
		await expect(
			collect(jsonlReader().read(streamOf(utf16), { startOffset: 0, startSeq: 0 })),
		).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("samples records and paths", async () => {
		expect(await jsonlReader().sample(streamOf(LINES), 20)).toEqual({
			records: [
				{ sku: "A1", name: "日本 🚀" },
				{ sku: "B2", tags: ["x", "y"] },
				[1, 2],
				{ sku: "C3" },
			],
			paths: ["sku", "name", "tags"],
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/json.test.ts`
Expected: FAIL — `src/sources/json.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/sources/json.ts`:
```ts
import { collectPaths } from "./paths.js";
import {
	ByteBuffer,
	type ByteScanner,
	decodeUtf8,
	isJsonSpace,
	MAX_RECORD_BYTES,
	type RecordReader,
	runScanner,
	SourceError,
	type SourceRecord,
	takeSample,
} from "./reader.js";

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

const syntax = (message: string, offset: number) =>
	new SourceError("source_syntax", message, offset);

function describe(b: number): string {
	if (b === OPEN_OBJECT) return "an object";
	if (b === OPEN_ARRAY) return "an array";
	if (b === QUOTE) return "a string";
	if (b === 0x74 || b === 0x66) return "a boolean";
	if (b === 0x6e) return "null";
	return "a number";
}

/** Parses one record's bytes; a parse failure is the record's problem, not the job's. */
export function parseJsonRecord(bytes: Uint8Array): Pick<SourceRecord, "value" | "error"> {
	const text = decodeUtf8(bytes);
	if (text === null) {
		return {
			value: null,
			error: { code: "invalid_record", message: "The record is not valid UTF-8" },
		};
	}
	try {
		return { value: JSON.parse(text) };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return { value: null, error: { code: "invalid_record", message: `Invalid JSON: ${reason}` } };
	}
}

/**
 * Tracks where one JSON value ends: brackets, strings and escapes, without parsing it. A scalar
 * ends at the first space, comma or closing bracket after it.
 */
class ValueExtent {
	private closers: number[] = [];
	private inString = false;
	private escaped = false;
	private scalar = false;
	private started = false;

	reset(): void {
		this.closers.length = 0;
		this.inString = false;
		this.escaped = false;
		this.scalar = false;
		this.started = false;
	}

	/** At end of input, a scalar is complete; strings and containers are not. */
	get endsAtEof(): boolean {
		return this.scalar;
	}

	/** "more": `b` belongs to the value; "done": `b` ends it; "before": it ended before `b`. */
	step(b: number, pos: number): "more" | "done" | "before" {
		if (!this.started) {
			this.started = true;
			if (b === QUOTE) this.inString = true;
			else if (b === OPEN_OBJECT) this.closers.push(CLOSE_OBJECT);
			else if (b === OPEN_ARRAY) this.closers.push(CLOSE_ARRAY);
			else this.scalar = true;
			return "more";
		}
		if (this.inString) {
			if (this.escaped) this.escaped = false;
			else if (b === BACKSLASH) this.escaped = true;
			else if (b === QUOTE) {
				this.inString = false;
				if (this.closers.length === 0) return "done";
			}
			return "more";
		}
		if (this.scalar) {
			const ends = isJsonSpace(b) || b === COMMA || b === CLOSE_ARRAY || b === CLOSE_OBJECT;
			return ends ? "before" : "more";
		}
		if (b === QUOTE) this.inString = true;
		else if (b === OPEN_OBJECT) this.closers.push(CLOSE_OBJECT);
		else if (b === OPEN_ARRAY) this.closers.push(CLOSE_ARRAY);
		else if (b === CLOSE_OBJECT || b === CLOSE_ARRAY) {
			if (this.closers.pop() !== b) throw syntax(`Unexpected "${String.fromCharCode(b)}"`, pos);
			if (this.closers.length === 0) return "done";
		}
		return "more";
	}
}

type Mode =
	| "top"
	| "keyOrEnd"
	| "key"
	| "inKey"
	| "colon"
	| "memberValue"
	| "skip"
	| "afterMember"
	| "resume"
	| "expectValue"
	| "inValue"
	| "afterValue"
	| "done";

/**
 * Finds the records array (the top-level array, or the array at the records path, skipping the
 * values of other keys unparsed) and yields each element's bytes parsed. Reading stops at the
 * array's closing bracket; what follows it is not read.
 */
class JsonScanner implements ByteScanner {
	private mode: Mode;
	private depth = 0;
	private readonly key = new ByteBuffer();
	private keyStart = 0;
	private keyEscaped = false;
	private currentKey = "";
	private readonly extent = new ValueExtent();
	private readonly buf = new ByteBuffer();
	private start = 0;
	private seq: number;
	private out: SourceRecord[] = [];
	bodyOffset = -1;

	constructor(
		private readonly path: string[],
		startOffset: number,
		private readonly startSeq: number,
		private readonly stopAtBody: boolean,
	) {
		this.mode = startOffset === 0 ? "top" : "resume";
		this.seq = startSeq;
	}

	get done(): boolean {
		return this.mode === "done";
	}

	drain(): SourceRecord[] {
		const out = this.out;
		this.out = [];
		return out;
	}

	private enterBody(offset: number): void {
		this.bodyOffset = offset;
		this.mode = this.stopAtBody ? "done" : "resume";
	}

	private notFound(pos: number): never {
		const where = this.depth === 0 ? "" : ` in "${this.path.slice(0, this.depth).join(".")}"`;
		throw new SourceError(
			"invalid_source",
			`Key "${this.path[this.depth]}"${where} not found`,
			pos,
		);
	}

	private startValue(b: number, pos: number): void {
		if (b === COMMA || b === COLON || b === CLOSE_ARRAY || b === CLOSE_OBJECT) {
			throw syntax(`Unexpected "${String.fromCharCode(b)}"`, pos);
		}
		this.extent.reset();
		this.start = pos;
		this.mode = "inValue";
		this.inValue(b, pos);
	}

	private inValue(b: number, pos: number): void {
		if (pos - this.start >= MAX_RECORD_BYTES) {
			throw syntax(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.start);
		}
		const r = this.extent.step(b, pos);
		if (r === "before") {
			this.emit(pos);
			this.mode = "afterValue";
			this.step(b, pos);
			return;
		}
		this.buf.push(b);
		if (r === "done") {
			this.emit(pos + 1);
			this.mode = "afterValue";
		}
	}

	private emit(end: number): void {
		const parsed = parseJsonRecord(this.buf.bytes());
		this.buf.clear();
		this.out.push({ seq: this.seq++, start: this.start, end, ...parsed });
	}

	step(b: number, pos: number): void {
		switch (this.mode) {
			case "top":
				if (isJsonSpace(b)) return;
				if (this.path.length === 0) {
					if (b === OPEN_ARRAY) {
						this.enterBody(pos + 1);
						return;
					}
					throw new SourceError(
						"invalid_source",
						b === OPEN_OBJECT
							? "The document is an object; set source.records to the path of its records array"
							: `The document is ${describe(b)}, not an array of records`,
						pos,
					);
				}
				if (b === OPEN_OBJECT) {
					this.mode = "keyOrEnd";
					return;
				}
				throw new SourceError(
					"invalid_source",
					`The document is ${describe(b)}; source.records "${this.path.join(".")}" needs an object`,
					pos,
				);
			case "keyOrEnd":
			case "key":
				if (isJsonSpace(b)) return;
				if (b === QUOTE) {
					this.key.clear();
					this.keyStart = pos;
					this.mode = "inKey";
					return;
				}
				if (b === CLOSE_OBJECT && this.mode === "keyOrEnd") this.notFound(pos);
				throw syntax("Expected a key", pos);
			case "inKey":
				if (pos - this.keyStart >= MAX_RECORD_BYTES)
					throw syntax("A key is too long", this.keyStart);
				if (this.keyEscaped) this.keyEscaped = false;
				else if (b === BACKSLASH) this.keyEscaped = true;
				else if (b === QUOTE) {
					this.currentKey = this.decodeKey();
					this.mode = "colon";
					return;
				}
				this.key.push(b);
				return;
			case "colon":
				if (isJsonSpace(b)) return;
				if (b !== COLON) throw syntax('Expected ":"', pos);
				this.mode = "memberValue";
				return;
			case "memberValue":
				if (isJsonSpace(b)) return;
				if (this.currentKey === this.path[this.depth]) {
					const here = this.path.slice(0, this.depth + 1).join(".");
					if (this.depth === this.path.length - 1) {
						if (b === OPEN_ARRAY) {
							this.enterBody(pos + 1);
							return;
						}
						throw new SourceError(
							"invalid_source",
							`"${here}" is ${describe(b)}, not an array`,
							pos,
						);
					}
					if (b !== OPEN_OBJECT) {
						throw new SourceError(
							"invalid_source",
							`"${here}" is ${describe(b)}, not an object`,
							pos,
						);
					}
					this.depth++;
					this.mode = "keyOrEnd";
					return;
				}
				if (b === COMMA || b === CLOSE_OBJECT || b === CLOSE_ARRAY || b === COLON) {
					throw syntax(`Unexpected "${String.fromCharCode(b)}"`, pos);
				}
				this.extent.reset();
				this.mode = "skip";
				this.extent.step(b, pos);
				return;
			case "skip": {
				const r = this.extent.step(b, pos);
				if (r === "done") this.mode = "afterMember";
				else if (r === "before") {
					this.mode = "afterMember";
					this.step(b, pos);
				}
				return;
			}
			case "afterMember":
				if (isJsonSpace(b)) return;
				if (b === COMMA) this.mode = "key";
				else if (b === CLOSE_OBJECT) this.notFound(pos);
				else throw syntax('Expected "," or "}"', pos);
				return;
			case "resume":
				if (isJsonSpace(b)) return;
				if (b === CLOSE_ARRAY) {
					this.mode = "done";
					return;
				}
				// A cursor sits after a record, where a comma follows; the array start has none.
				if (b === COMMA && this.seq > 0 && this.seq === this.startSeq) {
					this.mode = "expectValue";
					return;
				}
				this.startValue(b, pos);
				return;
			case "expectValue":
				if (isJsonSpace(b)) return;
				this.startValue(b, pos);
				return;
			case "inValue":
				this.inValue(b, pos);
				return;
			case "afterValue":
				if (isJsonSpace(b)) return;
				if (b === COMMA) this.mode = "expectValue";
				else if (b === CLOSE_ARRAY) this.mode = "done";
				else throw syntax('Expected "," or "]" after a record', pos);
				return;
			case "done":
				return;
		}
	}

	private decodeKey(): string {
		const text = decodeUtf8(this.key.bytes());
		try {
			if (text !== null) return JSON.parse(`"${text}"`) as string;
		} catch {
			// reported below
		}
		throw syntax("Invalid key", this.keyStart);
	}

	finish(end: number): void {
		if (this.mode === "inValue" && this.extent.endsAtEof) {
			this.emit(end);
			this.mode = "afterValue";
		}
		switch (this.mode) {
			case "done":
				return;
			case "top":
				throw new SourceError("invalid_source", "The document is empty", end);
			case "inValue":
				throw syntax("Unterminated record", this.start);
			case "resume":
			case "expectValue":
			case "afterValue":
				throw syntax("Unterminated array", end);
			default:
				throw syntax("Unexpected end of input", end);
		}
	}
}

/** JSON: the top-level array, or the array at the dot path `records`. */
export function jsonReader(records?: string): RecordReader {
	const path = records === undefined ? [] : records.split(".");
	const scan = (stream: ReadableStream<Uint8Array>, startOffset: number, startSeq: number) =>
		runScanner(stream, startOffset, new JsonScanner(path, startOffset, startSeq, false));
	return {
		async locate(stream) {
			const scanner = new JsonScanner(path, 0, 0, true);
			for await (const _ of runScanner(stream, 0, scanner)) {
				// locating emits no records
			}
			return { bodyOffset: scanner.bodyOffset };
		},
		read: (stream, { startOffset, startSeq }) => scan(stream, startOffset, startSeq),
		async sample(stream, n) {
			const values = await takeSample(scan(stream, 0, 0), n);
			return { records: values, paths: collectPaths(values, "json") };
		},
	};
}

/** Splits lines (LF; a CR before it is JSON whitespace) and parses each non-blank one. */
class LineScanner implements ByteScanner {
	private readonly buf = new ByteBuffer();
	private start = -1;
	private blank = true;
	private seq: number;
	private out: SourceRecord[] = [];
	readonly done = false;

	constructor(startSeq: number) {
		this.seq = startSeq;
	}

	drain(): SourceRecord[] {
		const out = this.out;
		this.out = [];
		return out;
	}

	step(b: number, pos: number): void {
		if (this.start < 0) this.start = pos;
		if (b === 0x0a) {
			this.endLine(pos + 1);
			return;
		}
		if (pos - this.start >= MAX_RECORD_BYTES) {
			throw syntax(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.start);
		}
		this.buf.push(b);
		if (!isJsonSpace(b)) this.blank = false;
	}

	private endLine(end: number): void {
		if (!this.blank) {
			this.out.push({
				seq: this.seq++,
				start: this.start,
				end,
				...parseJsonRecord(this.buf.bytes()),
			});
		}
		this.buf.clear();
		this.blank = true;
		this.start = -1;
	}

	finish(end: number): void {
		if (this.start >= 0) this.endLine(end);
	}
}

/** JSON Lines: one record per non-blank line. */
export function jsonlReader(): RecordReader {
	const scan = (stream: ReadableStream<Uint8Array>, startOffset: number, startSeq: number) =>
		runScanner(stream, startOffset, new LineScanner(startSeq));
	return {
		async locate(stream) {
			// Only the BOM (skipped by `positioned`) can come before the first line.
			for await (const rec of scan(stream, 0, 0)) return { bodyOffset: rec.start };
			return { bodyOffset: 0 };
		},
		read: (stream, { startOffset, startSeq }) => scan(stream, startOffset, startSeq),
		async sample(stream, n) {
			const values = await takeSample(scan(stream, 0, 0), n);
			return { records: values, paths: collectPaths(values, "json") };
		},
	};
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/json.test.ts`
Expected: PASS (30 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/json.ts packages/flux-import/tests/unit/json.test.ts
git commit -m "Read JSON arrays, records paths and JSON Lines with a byte-level boundary scanner"
```

### Task 5: XML reader

**Files:**
- Create: `packages/flux-import/src/sources/xml-record.ts`, `packages/flux-import/src/sources/xml.ts`
- Test: `packages/flux-import/tests/unit/xml.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ByteBuffer`, `ByteScanner`, `decodeUtf8`, `MAX_RECORD_BYTES`, `RecordReader`, `runScanner`, `SourceError`, `SourceRecord`, `takeSample`; test helpers `readAll`, `expectReaderInvariants`, `streamOf`); Task 3 (`collectPaths`).
- Produces:
  - `xmlReader(records: string): RecordReader` — `records` is `"root/…/record"` (checked by Task 6's `checkSource`). `locate` returns the offset just after the start tag of the record elements' parent, and throws `invalid_source` (wrong root, missing parent, no root, empty root), `xml_dtd_not_allowed`, `unsupported_encoding` or `source_syntax`. `read` throws `source_syntax` for mismatched or unterminated tags and records over the cap, and yields `invalid_record` records for elements the record parser rejects.
  - `parseXmlRecordText(xml: string): unknown` (throws on malformed input) and `parseXmlRecord(bytes: Uint8Array): Pick<SourceRecord, "value" | "error">`.

The scanner tracks tags (names, quoted attribute values that may contain `>`), comments, CDATA and processing instructions, and keeps the stack of open element names; the record parser (`xml-record.ts`) is iterative, so deep nesting cannot overflow the call stack.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/xml.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, SourceError } from "../../src/sources/reader.js";
import { xmlReader } from "../../src/sources/xml.js";
import { parseXmlRecordText } from "../../src/sources/xml-record.js";
import { expectReaderInvariants, readAll, streamOf } from "./helpers.js";

const FEED =
	"﻿<?xml version='1.0' encoding=\"UTF-8\"?>\r\n" +
	"<!DOCTYPE feed>\n" +
	'<!-- <item sku="commented">no</item> -->\n' +
	"<?app note?>\n" +
	'<feed version="2">\n' +
	'  <meta note="a > b /> c"/>\n' +
	'  <item sku="A1" note=\'say "hi" > bye\'>\n' +
	'    <title lang="ro">Ș, ț &amp; &lt;b&gt; &#233;&#x1F680; 日本</title>\n' +
	"    <price>12.50</price>\n" +
	"    <!-- a comment with </item> inside -->\n" +
	"    <body><![CDATA[<p>raw </item> & text</p>]]></body>\n" +
	"    <images><image>a.jpg</image><image>b.jpg</image></images>\n" +
	"    <?pi ignored?>\n" +
	"  </item>\n" +
	'  <item sku="B2"/>\n' +
	"  <other><item>not a record: wrong depth</item></other>\n" +
	"  <item>Plain text</item>\n" +
	"  <item sku='C3'><empty/><flag on=\"yes\"/></item>\n" +
	"</feed>\n" +
	"<!-- after the root -->\n";

const values = (recs: { value: unknown }[]) => recs.map((r) => r.value);

describe("xmlReader", () => {
	it("finds record elements and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(xmlReader("feed/item"), FEED);
		expect(values(recs)).toEqual([
			{
				"@sku": "A1",
				"@note": 'say "hi" > bye',
				title: { "@lang": "ro", "#text": "Ș, ț & <b> é🚀 日本" },
				price: "12.50",
				body: "<p>raw </item> & text</p>",
				images: { image: ["a.jpg", "b.jpg"] },
			},
			{ "@sku": "B2" },
			{ "#text": "Plain text" },
			{ "@sku": "C3", empty: "", flag: { "@on": "yes" } },
		]);
		expect(recs.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("locates just after the records' parent start tag", async () => {
		const { bodyOffset } = await xmlReader("feed/item").locate(streamOf(FEED, 1));
		const bytes = new TextEncoder().encode(FEED);
		expect(
			new TextDecoder().decode(bytes.subarray(0, bodyOffset)).endsWith('<feed version="2">'),
		).toBe(true);
	});

	it("follows deeper paths across repeated parents", async () => {
		const rss =
			"<rss><channel><title>One</title><item><t>1</t></item><item><t>2</t></item></channel>" +
			"<junk><channel><item><t>no</t></item></channel></junk>" +
			"<channel><item><t>3</t></item></channel></rss>";
		const recs = await expectReaderInvariants(xmlReader("rss/channel/item"), rss);
		expect(values(recs)).toEqual([{ t: "1" }, { t: "2" }, { t: "3" }]);
	});

	it("reads no records from an empty parent", async () => {
		expect(await readAll(xmlReader("feed/item"), "<feed></feed>")).toEqual([]);
	});

	it.each([
		["an internal subset", '<!DOCTYPE feed [<!ENTITY lol "lol">]><feed/>'],
		["a SYSTEM id", '<!DOCTYPE feed SYSTEM "http://example.test/feed.dtd"><feed/>'],
		["a PUBLIC id", '<!DOCTYPE feed PUBLIC "-//X//EN" "feed.dtd"><feed/>'],
	])("rejects a DOCTYPE with %s before reading records", async (_name, input) => {
		await expect(xmlReader("feed/item").locate(streamOf(input, 1))).rejects.toMatchObject({
			code: "xml_dtd_not_allowed",
		});
	});

	it("rejects another declared encoding and UTF-16", async () => {
		const latin = '<?xml version="1.0" encoding="ISO-8859-1"?><feed></feed>';
		await expect(xmlReader("feed/item").locate(streamOf(latin))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
		const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00]);
		await expect(xmlReader("feed/item").locate(streamOf(utf16))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("fails only the record that is not well-formed", async () => {
		const input =
			"<feed>" +
			'<item sku="1"><t>ok</t></item>' +
			"<item sku=2><t>unquoted</t></item>" +
			'<item a="1" a="2"/>' +
			"<item><t>&nbsp;</t></item>" +
			"<item><t>a & b</t></item>" +
			'<item sku="5"/>' +
			"</feed>";
		const recs = await expectReaderInvariants(xmlReader("feed/item"), input);
		expect(recs.map((r) => r.error?.code ?? r.value)).toEqual([
			{ "@sku": "1", t: "ok" },
			"invalid_record",
			"invalid_record",
			"invalid_record",
			"invalid_record",
			{ "@sku": "5" },
		]);
		expect(recs[3]!.error?.message).toMatch(/Unknown entity &nbsp;/);
	});

	it.each([
		["a mismatched end tag", '<feed><item sku="1"/><item><a></b></item></feed>', 30],
		["an unterminated record", '<feed><item sku="1"/><item><a>open', 21],
		["an unterminated comment", "<feed><!-- open", 6],
		["a DOCTYPE inside the document", "<feed><!DOCTYPE x></feed>", 6],
	])("fails the job with source_syntax for %s", async (_name, input, offset) => {
		const error = await readAll(xmlReader("feed/item"), input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax", offset });
	});

	it.each([
		["another root element", "rss/item", "<feed></feed>", /root element is <feed>, not <rss>/],
		["a missing parent", "rss/channel/item", "<rss><item/></rss>", /no <rss\/channel> element/],
		["text instead of XML", "feed/item", '[{"a": 1}]', /Text before the root/],
		["an empty root", "feed/item", "<feed/>", /empty/],
	])("fails locate for %s", async (_name, records, input, message) => {
		const error = await xmlReader(records)
			.locate(streamOf(input))
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect((error as SourceError).message).toMatch(message);
	});

	it("fails a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const input = `<feed><item/><item>${"x".repeat(MAX_RECORD_BYTES)}</item></feed>`;
		await expect(readAll(xmlReader("feed/item"), input)).rejects.toMatchObject({
			code: "source_syntax",
			offset: 13,
		});
	});

	it("samples records and their field paths", async () => {
		const sample = await xmlReader("feed/item").sample(streamOf(FEED), 20);
		expect(sample.records).toHaveLength(4);
		expect(sample.paths).toEqual([
			"@sku",
			"@note",
			"title",
			"title/@lang",
			"price",
			"body",
			"images/image",
			"empty",
			"flag",
			"flag/@on",
		]);
	});
});

describe("parseXmlRecordText", () => {
	it("keeps keys as own properties", () => {
		const value = parseXmlRecordText("<item><__proto__>x</__proto__></item>") as object;
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.keys(value)).toEqual(["__proto__"]);
	});

	it("keeps mixed text and normalises line endings", () => {
		expect(parseXmlRecordText("<item>a\r\n<b>x</b>c</item>")).toEqual({ b: "x", "#text": "a\nc" });
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xml.test.ts`
Expected: FAIL — `src/sources/xml.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/flux-import/src/sources/xml-record.ts`:
```ts
import { decodeUtf8, type SourceRecord } from "./reader.js";

const NAME = /[^\s/>=<"'&!?]+/y;
const SPACE = /\s*/y;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

class XmlRecordError extends Error {}

/** Decodes the five predefined entities and numeric character references; others are errors. */
function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	return raw.replace(/&([^;]*);?/g, (match, name: string) => {
		if (!match.endsWith(";")) throw new XmlRecordError(`"&" must start an entity such as &amp;`);
		const predefined = PREDEFINED[name];
		if (predefined !== undefined) return predefined;
		const hex = /^#x([0-9a-fA-F]{1,6})$/.exec(name);
		const dec = /^#([0-9]{1,7})$/.exec(name);
		const code = hex ? Number.parseInt(hex[1] as string, 16) : dec ? Number(dec[1]) : -1;
		const valid =
			code === 0x9 ||
			code === 0xa ||
			code === 0xd ||
			(code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
		if (code === -1) throw new XmlRecordError(`Unknown entity &${name};`);
		if (!valid) throw new XmlRecordError(`Invalid character reference &${name};`);
		return String.fromCodePoint(code);
	});
}

interface Frame {
	name: string;
	attrs: [string, string][];
	children: Map<string, unknown[]>;
	text: string[];
}

/**
 * An element without attributes or child elements is its text; otherwise an object with
 * `@attributes`, child elements (repeats as arrays) and `#text` when the text is not blank.
 * The record element is always an object. Keys are own properties (`Object.fromEntries`).
 */
function finish(frame: Frame, isRecord: boolean): unknown {
	const text = frame.text.join("");
	if (!isRecord && frame.attrs.length === 0 && frame.children.size === 0) return text;
	const entries: [string, unknown][] = frame.attrs.map(([k, v]) => [`@${k}`, v]);
	for (const [name, values] of frame.children) {
		entries.push([name, values.length === 1 ? values[0] : values]);
	}
	if (text.trim() !== "") entries.push(["#text", text]);
	return Object.fromEntries(entries);
}

/** Parses one record element (comments and processing instructions ignored, CDATA as text). */
export function parseXmlRecordText(xml: string): unknown {
	const src = xml.replace(/\r\n?/g, "\n");
	const stack: Frame[] = [];
	let i = 0;
	const fail = (message: string): never => {
		throw new XmlRecordError(message);
	};
	const name = (): string => {
		NAME.lastIndex = i;
		const m = NAME.exec(src);
		if (!m) fail(`Expected a name at character ${i}`);
		i = NAME.lastIndex;
		return (m as RegExpExecArray)[0];
	};
	const space = () => {
		SPACE.lastIndex = i;
		SPACE.exec(src);
		i = SPACE.lastIndex;
	};
	const skipPast = (end: string, what: string) => {
		const at = src.indexOf(end, i);
		if (at < 0) fail(`Unterminated ${what}`);
		const body = src.slice(i, at);
		i = at + end.length;
		return body;
	};
	const close = (frame: Frame) => {
		const value = finish(frame, stack.length === 0);
		const parent = stack.at(-1);
		if (!parent) return value;
		const list = parent.children.get(frame.name);
		if (list) list.push(value);
		else parent.children.set(frame.name, [value]);
		return undefined;
	};

	if (src[i] !== "<") fail("A record must start with an element");
	for (;;) {
		if (i >= src.length) fail("Unexpected end of record");
		if (src.startsWith("<!--", i)) {
			i += 4;
			skipPast("-->", "comment");
		} else if (src.startsWith("<![CDATA[", i)) {
			i += 9;
			const cdata = skipPast("]]>", "CDATA section");
			stack.at(-1)?.text.push(cdata);
		} else if (src.startsWith("<?", i)) {
			i += 2;
			skipPast("?>", "processing instruction");
		} else if (src.startsWith("<!", i)) {
			fail("Declarations are not allowed inside a record");
		} else if (src.startsWith("</", i)) {
			i += 2;
			const closing = name();
			space();
			if (src[i] !== ">") fail(`Expected ">" after </${closing}`);
			i++;
			const frame = stack.pop();
			if (!frame || frame.name !== closing) fail(`Unexpected </${closing}>`);
			const value = close(frame as Frame);
			if (stack.length === 0) {
				if (src.slice(i).trim() !== "") fail("Content after the record element");
				return value;
			}
		} else if (src[i] === "<") {
			i++;
			const frame: Frame = { name: name(), attrs: [], children: new Map(), text: [] };
			for (;;) {
				const before = i;
				space();
				if (src.startsWith("/>", i) || src[i] === ">") break;
				if (i === before) fail(`Expected a space before attribute in <${frame.name}>`);
				const attr = name();
				space();
				if (src[i] !== "=") fail(`Expected "=" after attribute ${attr}`);
				i++;
				space();
				const quote = src[i];
				if (quote !== '"' && quote !== "'") fail(`Attribute ${attr} must be quoted`);
				i++;
				const raw = skipPast(quote as string, `attribute ${attr}`);
				if (raw.includes("<")) fail(`"<" is not allowed in attribute ${attr}`);
				if (frame.attrs.some(([k]) => k === attr)) fail(`Duplicate attribute ${attr}`);
				frame.attrs.push([attr, decodeEntities(raw)]);
			}
			if (src[i] === "/") {
				i += 2;
				if (stack.length === 0) {
					const value = finish(frame, true);
					if (src.slice(i).trim() !== "") fail("Content after the record element");
					return value;
				}
				close(frame);
			} else {
				i++;
				stack.push(frame);
			}
		} else {
			const next = src.indexOf("<", i);
			const raw = src.slice(i, next < 0 ? src.length : next);
			i += raw.length;
			const frame = stack.at(-1);
			if (!frame) fail("Text outside the record element");
			(frame as Frame).text.push(decodeEntities(raw));
		}
	}
}

/** Parses one record's bytes; a parse failure is the record's problem, not the job's. */
export function parseXmlRecord(bytes: Uint8Array): Pick<SourceRecord, "value" | "error"> {
	const text = decodeUtf8(bytes);
	if (text === null) {
		return {
			value: null,
			error: { code: "invalid_record", message: "The record is not valid UTF-8" },
		};
	}
	try {
		return { value: parseXmlRecordText(text) };
	} catch (e) {
		if (!(e instanceof XmlRecordError)) throw e;
		return { value: null, error: { code: "invalid_record", message: `Invalid XML: ${e.message}` } };
	}
}
```

Create `packages/flux-import/src/sources/xml.ts`:
```ts
import { collectPaths } from "./paths.js";
import {
	ByteBuffer,
	type ByteScanner,
	decodeUtf8,
	MAX_RECORD_BYTES,
	type RecordReader,
	runScanner,
	SourceError,
	type SourceRecord,
	takeSample,
} from "./reader.js";
import { parseXmlRecord } from "./xml-record.js";

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const DASH = 0x2d;
const RBRACKET = 0x5d;
const LBRACKET = 0x5b;
const PROLOG_PI_MAX = 1024;
const BANG_FORMS = ["--", "[CDATA[", "DOCTYPE"];

const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const syntax = (message: string, offset: number) =>
	new SourceError("source_syntax", message, offset);

type Mode =
	| "text"
	| "lt"
	| "startName"
	| "inTag"
	| "attrValue"
	| "selfClose"
	| "endName"
	| "endSpace"
	| "bang"
	| "comment"
	| "cdata"
	| "pi"
	| "doctype"
	| "done";

/**
 * Finds record elements (`records` = "root/…/record": every `record` element whose ancestors are
 * exactly the earlier segments) by tracking tags, quoted attribute values, comments, CDATA and
 * processing instructions, and yields each element's bytes parsed. At any record boundary the
 * open elements are the records path's parents, so a reader resumes from the path alone.
 * Reading stops when the root element closes.
 */
class XmlScanner implements ByteScanner {
	private mode: Mode = "text";
	private readonly parents: number;
	private readonly resumed: boolean;
	private stack: string[];
	private matched: number;
	private rootSeen: boolean;
	private readonly name = new ByteBuffer();
	private readonly tag = new ByteBuffer();
	private readonly record = new ByteBuffer();
	private readonly pi = new ByteBuffer();
	private markupStart = 0;
	private quote = 0;
	private run = 0;
	private bang = "";
	private doctype = "";
	private inRecord = false;
	private recordStart = 0;
	private seq: number;
	private out: SourceRecord[] = [];
	bodyOffset = -1;

	constructor(
		private readonly path: string[],
		startOffset: number,
		startSeq: number,
		private readonly stopAtBody: boolean,
	) {
		this.parents = path.length - 1;
		this.resumed = startOffset > 0;
		this.stack = this.resumed ? path.slice(0, this.parents) : [];
		this.matched = this.resumed ? this.parents : 0;
		this.rootSeen = this.resumed;
		this.seq = startSeq;
	}

	get done(): boolean {
		return this.mode === "done";
	}

	drain(): SourceRecord[] {
		const out = this.out;
		this.out = [];
		return out;
	}

	step(b: number, pos: number): void {
		if (this.inRecord) {
			if (pos - this.recordStart >= MAX_RECORD_BYTES) {
				throw syntax(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.recordStart);
			}
			this.record.push(b);
		}
		switch (this.mode) {
			case "text":
				if (b === LT) {
					this.markupStart = pos;
					this.mode = "lt";
				} else if (!this.rootSeen && !isSpace(b)) {
					throw syntax("Text before the root element; is this an XML file?", pos);
				}
				return;
			case "lt":
				if (b === SLASH) {
					this.name.clear();
					this.mode = "endName";
				} else if (b === BANG) {
					this.bang = "";
					this.mode = "bang";
				} else if (b === QUESTION) {
					this.pi.clear();
					this.run = 0;
					this.mode = "pi";
				} else if (isSpace(b) || b === GT || b === LT) {
					throw syntax("Invalid tag", this.markupStart);
				} else {
					this.name.clear();
					this.name.push(b);
					this.tag.clear();
					this.tag.push(LT);
					this.tag.push(b);
					this.mode = "startName";
				}
				return;
			case "startName":
			case "inTag":
			case "attrValue":
			case "selfClose":
				this.inStartTag(b, pos);
				return;
			case "endName":
				if (isSpace(b)) this.mode = "endSpace";
				else if (b === GT) this.endTag(pos);
				else this.name.push(b);
				return;
			case "endSpace":
				if (b === GT) this.endTag(pos);
				else if (!isSpace(b)) throw syntax("Invalid end tag", this.markupStart);
				return;
			case "bang": {
				this.bang += String.fromCharCode(b);
				if (this.bang === "--") {
					this.run = 0;
					this.mode = "comment";
				} else if (this.bang === "[CDATA[") {
					this.run = 0;
					this.mode = "cdata";
				} else if (this.bang === "DOCTYPE") {
					if (this.rootSeen) throw syntax("A DOCTYPE inside the document", this.markupStart);
					this.doctype = "";
					this.mode = "doctype";
				} else if (!BANG_FORMS.some((f) => f.startsWith(this.bang))) {
					throw syntax(`Unknown markup "<!${this.bang}"`, this.markupStart);
				}
				return;
			}
			case "comment":
				if (b === GT && this.run >= 2) this.mode = "text";
				else this.run = b === DASH ? this.run + 1 : 0;
				return;
			case "cdata":
				if (b === GT && this.run >= 2) this.mode = "text";
				else this.run = b === RBRACKET ? this.run + 1 : 0;
				return;
			case "pi":
				if (b === GT && this.run === 1) {
					this.mode = "text";
					if (!this.rootSeen) this.checkDeclaration();
					return;
				}
				this.run = b === QUESTION ? 1 : 0;
				if (!this.rootSeen && this.pi.length < PROLOG_PI_MAX) this.pi.push(b);
				return;
			case "doctype":
				if (b === LBRACKET) {
					throw new SourceError(
						"xml_dtd_not_allowed",
						"DOCTYPE with an internal subset is not allowed",
						this.markupStart,
					);
				}
				if (b !== GT) {
					if (this.doctype.length < PROLOG_PI_MAX) this.doctype += String.fromCharCode(b);
					return;
				}
				if (this.doctype.trim().split(/\s+/).length > 1) {
					throw new SourceError(
						"xml_dtd_not_allowed",
						"DOCTYPE with an external DTD is not allowed",
						this.markupStart,
					);
				}
				this.mode = "text";
				return;
			case "done":
				return;
		}
	}

	private inStartTag(b: number, pos: number): void {
		if (!this.inRecord && pos - this.markupStart >= MAX_RECORD_BYTES) {
			throw syntax(`A tag is larger than ${MAX_RECORD_BYTES} bytes`, this.markupStart);
		}
		if (!this.inRecord) this.tag.push(b);
		switch (this.mode) {
			case "startName":
				if (isSpace(b)) this.mode = "inTag";
				else if (b === SLASH) this.mode = "selfClose";
				else if (b === GT) this.startTag(false, pos);
				else this.name.push(b);
				return;
			case "inTag":
				if (b === DQUOTE || b === SQUOTE) {
					this.quote = b;
					this.mode = "attrValue";
				} else if (b === SLASH) this.mode = "selfClose";
				else if (b === GT) this.startTag(false, pos);
				else if (b === LT) throw syntax('"<" inside a tag', pos);
				return;
			case "attrValue":
				if (b === this.quote) this.mode = "inTag";
				return;
			case "selfClose":
				if (b !== GT) throw syntax('Expected ">" after "/"', pos);
				this.startTag(true, pos);
				return;
		}
	}

	private tagName(): string {
		const name = decodeUtf8(this.name.bytes());
		if (name === null || name === "") throw syntax("Invalid element name", this.markupStart);
		return name;
	}

	private located(offset: number): void {
		if (this.bodyOffset >= 0) return;
		this.bodyOffset = offset;
		if (this.stopAtBody) this.mode = "done";
	}

	private notFound(offset: number): never {
		const parents = this.path.slice(0, this.parents).join("/");
		throw new SourceError("invalid_source", `The document has no <${parents}> element`, offset);
	}

	private startTag(selfClosing: boolean, pos: number): void {
		this.mode = "text";
		const name = this.tagName();
		const depth = this.stack.length;
		if (this.inRecord) {
			if (!selfClosing) this.stack.push(name);
			return;
		}
		if (depth === 0) {
			this.rootSeen = true;
			if (name !== this.path[0]) {
				throw new SourceError(
					"invalid_source",
					`The root element is <${name}>, not <${this.path[0]}>`,
					this.markupStart,
				);
			}
			if (selfClosing) {
				throw new SourceError("invalid_source", `The root element <${name}/> is empty`, pos);
			}
			this.stack.push(name);
			this.matched = 1;
			if (this.parents === 1) this.located(pos + 1);
			return;
		}
		if (depth < this.parents && this.matched === depth && name === this.path[depth]) {
			if (selfClosing) return;
			this.stack.push(name);
			this.matched = depth + 1;
			if (this.matched === this.parents) this.located(pos + 1);
			return;
		}
		if (depth === this.parents && this.matched === depth && name === this.path[depth]) {
			this.recordStart = this.markupStart;
			this.record.clear();
			this.record.pushAll(this.tag.bytes());
			if (selfClosing) {
				this.emit(pos + 1);
				return;
			}
			this.stack.push(name);
			this.inRecord = true;
			return;
		}
		if (!selfClosing) this.stack.push(name);
	}

	private endTag(pos: number): void {
		this.mode = "text";
		const name = this.tagName();
		const open = this.stack.at(-1);
		if (open === undefined) throw syntax(`</${name}> has no start tag`, this.markupStart);
		if (name !== open) throw syntax(`Expected </${open}>, found </${name}>`, this.markupStart);
		this.stack.pop();
		const depth = this.stack.length;
		if (this.inRecord && depth === this.parents) {
			this.inRecord = false;
			this.emit(pos + 1);
		}
		if (depth < this.matched) this.matched = depth;
		if (depth === 0) {
			this.mode = "done";
			if (this.bodyOffset < 0 && !this.resumed) this.notFound(pos);
		}
	}

	private emit(end: number): void {
		const parsed = parseXmlRecord(this.record.bytes());
		this.record.clear();
		this.out.push({ seq: this.seq++, start: this.recordStart, end, ...parsed });
	}

	private checkDeclaration(): void {
		const text = decodeUtf8(this.pi.bytes()) ?? "";
		if (!/^xml\s/.test(text)) return;
		const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(text)?.[1];
		if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
			throw new SourceError(
				"unsupported_encoding",
				`The XML declaration names encoding "${encoding}"; only UTF-8 is supported`,
				0,
			);
		}
	}

	finish(end: number): void {
		if (this.mode === "done") return;
		if (!this.rootSeen)
			throw new SourceError("invalid_source", "The document has no root element", end);
		if (this.mode !== "text") throw syntax("Unterminated markup", this.markupStart);
		const open = this.stack.at(-1);
		throw syntax(`Unterminated element <${open}>`, this.inRecord ? this.recordStart : end);
	}
}

/** XML: the elements at the `/` path `records` ("feed/item"). */
export function xmlReader(records: string): RecordReader {
	const path = records.split("/");
	const scan = (stream: ReadableStream<Uint8Array>, startOffset: number, startSeq: number) =>
		runScanner(stream, startOffset, new XmlScanner(path, startOffset, startSeq, false));
	return {
		async locate(stream) {
			const scanner = new XmlScanner(path, 0, 0, true);
			for await (const _ of runScanner(stream, 0, scanner)) {
				// locating emits no records
			}
			return { bodyOffset: scanner.bodyOffset };
		},
		read: (stream, { startOffset, startSeq }) => scan(stream, startOffset, startSeq),
		async sample(stream, n) {
			const values = await takeSample(scan(stream, 0, 0), n);
			return { records: values, paths: collectPaths(values, "xml") };
		},
	};
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/xml.test.ts`
Expected: PASS (21 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/xml.ts packages/flux-import/src/sources/xml-record.ts packages/flux-import/tests/unit/xml.test.ts
git commit -m "Read XML record elements with a boundary scanner, rejecting DTDs and other encodings"
```

### Task 6: Template source block, typed values and `readerFor`

**Files:**
- Modify: `packages/flux-import/src/engine/template.ts` (replace the whole file)
- Create: `packages/flux-import/src/sources/readers.ts`
- Test: `packages/flux-import/tests/unit/template.test.ts`, `packages/flux-import/tests/unit/readers.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CSV_SOURCE`, `SOURCE_FORMATS`, `SourceFormat`, `RecordReader`, `TemplateSource`, `csvReader`), Task 3 (`pathProblem`, `recordsPathProblem`, `resolvePath`), Task 4 (`jsonReader`, `jsonlReader`), Task 5 (`xmlReader`).
- Produces (`engine/template.ts`):
  - `sourceSchema` (Zod: `{ format: enum, default "csv"; records?: string }`, strict) and `templateSchema` with `source: sourceSchema.default(() => ({ ...CSV_SOURCE }))`, so `Template["source"]` is always set after parsing.
  - `ValueErrorCode` gains `"not_scalar"`.
  - `applyTemplate(t: Template, value: unknown)` (was `values: Record<string, string>`), same result type.
  - `templatePaths(t: Template): string[]`; `missingPathWarnings(t: Template, sample: unknown[]): string[]` (message `Path "<path>" was not found in the first <n> records`; `[]` for CSV).
  - `checkTemplate(t, fields, columns: readonly string[] | null): string[]` — CSV columns are checked when `columns` is not null; other formats get path-syntax problems.
  - Unchanged: `SOURCE_ID_FIELD`, `FieldValue`, `MappedRecord`, `ValueError`, `SchemaField`, `slugify`.
- Produces (`sources/readers.ts`): `checkSource(source: TemplateSource): string[]`; `readerFor(source: TemplateSource, columns: readonly string[] = []): RecordReader`.

`engine/jobs.ts` and `engine/batch.ts` keep compiling: `checkTemplate(…, header.headers)` and `applyTemplate(job.template, rec.values)` still type-check against the wider parameters; Task 7 switches them over.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/template.test.ts`, add `missingPathWarnings,` to the import list after `checkTemplate,`; insert as the first test of `describe("templateSchema", …)`:
```ts
	it("defaults the source to CSV and accepts the other formats", () => {
		expect(template.source).toEqual({ format: "csv" });
		const base = { version: 1, collection: "p", locale: "en", key: { from: "sku" } };
		const fields = { title: { from: "name", type: "text" } };
		for (const source of [
			{ format: "json" },
			{ format: "json", records: "data.products" },
			{ format: "jsonl" },
			{ format: "xml", records: "feed/item" },
		]) {
			expect(templateSchema.parse({ ...base, source, fields }).source).toEqual(source);
		}
		expect(templateSchema.safeParse({ ...base, source: { format: "yaml" }, fields }).success).toBe(
			false,
		);
		expect(
			templateSchema.safeParse({ ...base, source: { format: "json", extra: 1 }, fields }).success,
		).toBe(false);
	});
```
and append at the end of the file:
```ts
const jsonT = templateSchema.parse({
	version: 1,
	collection: "products",
	locale: "en",
	source: { format: "json" },
	key: { from: "sku" },
	slug: { from: "name" },
	fields: {
		title: { from: "name", type: "text" },
		price: { from: "price.amount", type: "number" },
		released: { from: "released", type: "date" },
	},
});

describe("applyTemplate with typed values", () => {
	it("takes JSON numbers as numbers and turns numbers and booleans into text", () => {
		const result = applyTemplate(jsonT, {
			sku: 1001,
			name: true,
			price: { amount: 12.5 },
			released: "2026-03-01",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "1001",
				slug: "true",
				data: { title: "true", price: 12.5, released: "2026-03-01T00:00:00.000Z" },
			},
		});
	});

	it("reads numeric strings, null and missing paths as before", () => {
		const result = applyTemplate(jsonT, { sku: "A1", name: "Desk", price: { amount: "7" } });
		expect(result.ok && result.value.data).toEqual({ title: "Desk", price: 7, released: null });
		const nulls = applyTemplate(jsonT, { sku: "A1", name: "Desk", price: null, released: null });
		expect(nulls.ok && nulls.value.data).toEqual({ title: "Desk", price: null, released: null });
	});

	it("fails not_scalar for an object or array where a single value is expected", () => {
		const result = applyTemplate(jsonT, {
			sku: ["A1"],
			name: { first: "D" },
			price: { amount: [1] },
			released: { at: "x" },
		});
		expect(!result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
			["sku", "not_scalar"],
			["slug", "not_scalar"],
			["title", "not_scalar"],
			["price", "not_scalar"],
			["released", "not_scalar"],
		]);
	});

	it("rejects booleans and non-finite numbers in number fields", () => {
		const t = applyTemplate(jsonT, { sku: "A", name: "n", price: { amount: false } });
		expect(t).toMatchObject({ ok: false, errors: [{ field: "price", code: "invalid_number" }] });
	});

	it("fails a non-object record with missing_key", () => {
		const result = applyTemplate(jsonT, "just a string");
		expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["missing_key", "empty_slug"]);
	});

	it("reads XML text elements and attributes", () => {
		const xmlT = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xml", records: "feed/item" },
			key: { from: "@sku" },
			fields: {
				title: { from: "title", type: "text" },
				lang: { from: "title/@lang", type: "text" },
				price: { from: "price", type: "number" },
			},
		});
		const result = applyTemplate(xmlT, {
			"@sku": "A1",
			title: { "@lang": "ro", "#text": "Masă" },
			price: "12.50",
		});
		expect(result).toEqual({
			ok: true,
			value: { key: "A1", data: { title: "Masă", lang: "ro", price: 12.5 } },
		});
	});
});

describe("checkTemplate for structured sources", () => {
	const fields = [
		{ slug: "title", type: "string" },
		{ slug: "price", type: "number" },
		{ slug: "released", type: "datetime" },
	];

	it("checks path syntax instead of columns", () => {
		expect(checkTemplate(jsonT, fields, null)).toEqual([]);
		const bad = templateSchema.parse({
			...jsonT,
			fields: { title: { from: "name..first", type: "text" } },
		});
		expect(checkTemplate(bad, fields, null)).toEqual(['"name..first" has an empty key']);
	});
});

describe("missingPathWarnings", () => {
	it("warns about each path no sampled record has, and never for CSV", () => {
		const sample = [{ sku: "A1", name: "Desk", price: null }, { sku: "B2" }];
		expect(missingPathWarnings(jsonT, sample)).toEqual([
			'Path "price.amount" was not found in the first 2 records',
			'Path "released" was not found in the first 2 records',
		]);
		expect(missingPathWarnings(template, [])).toEqual([]);
	});
});
```

Create `packages/flux-import/tests/unit/readers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkSource, readerFor } from "../../src/sources/readers.js";
import { readAll } from "./helpers.js";

describe("checkSource", () => {
	it.each([
		[{ format: "csv" }, []],
		[{ format: "json" }, []],
		[{ format: "json", records: "data.products" }, []],
		[{ format: "jsonl" }, []],
		[{ format: "xml", records: "feed/item" }, []],
		[{ format: "csv", records: "x" }, ["source.records is not allowed for csv"]],
		[{ format: "jsonl", records: "x" }, ["source.records is not allowed for jsonl"]],
		[{ format: "xml" }, ['source.records is required for xml, as in "feed/item"']],
		[{ format: "json", records: "a..b" }, ['source.records: "a..b" has an empty key']],
		[
			{ format: "xml", records: "item" },
			[
				'source.records: "item" must name the root element and the record element, as in "feed/item"',
			],
		],
	] as const)("%j", (source, problems) => {
		expect(checkSource(source)).toEqual(problems);
	});
});

describe("readerFor", () => {
	it("returns the reader for each format", async () => {
		const read = async (
			source: Parameters<typeof readerFor>[0],
			body: string,
			columns?: string[],
		) => (await readAll(readerFor(source, columns), body)).map((r) => r.value);
		expect(await read({ format: "csv" }, "a\n1\n", ["a"])).toEqual([{ a: "1" }]);
		expect(await read({ format: "json" }, "[1]")).toEqual([1]);
		expect(await read({ format: "json", records: "x" }, '{"x": [2]}')).toEqual([2]);
		expect(await read({ format: "jsonl" }, "3\n")).toEqual([3]);
		expect(await read({ format: "xml", records: "r/i" }, "<r><i>4</i></r>")).toEqual([
			{ "#text": "4" },
		]);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/template.test.ts tests/unit/readers.test.ts`
Expected: FAIL — `missingPathWarnings` is not exported, `template.source` is undefined, `src/sources/readers.js` does not exist.

- [ ] **Step 3: Implement**

Replace `packages/flux-import/src/engine/template.ts` with:
```ts
import { DateTime } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import { CSV_SOURCE, SOURCE_FORMATS, type SourceFormat } from "../sources/reader.js";

export const SOURCE_ID_FIELD = "flux_source_id";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

const column = z.string().min(1);
const timezone = z
	.string()
	.min(1)
	.refine((tz) => DateTime.now().setZone(tz).isValid, { message: "Unknown timezone" });

const fieldMapping = z.discriminatedUnion("type", [
	z.object({ from: column, type: z.literal("text") }).strict(),
	z.object({ from: column, type: z.literal("number") }).strict(),
	z
		.object({
			from: column,
			type: z.literal("date"),
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
		})
		.strict(),
]);

/**
 * The template's `source` block. Which formats take `records` is checked by `checkSource`
 * (sources/readers.ts), so a misplaced `records` is reported as `invalid_source`.
 */
export const sourceSchema = z
	.object({
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
	})
	.strict();

export const templateSchema = z
	.object({
		version: z.literal(1),
		source: sourceSchema.default(() => ({ ...CSV_SOURCE })),
		collection: z.string().regex(SLUG_RE),
		locale: z.string().min(1),
		key: z.object({ from: column }).strict(),
		slug: z.object({ from: column }).strict().optional(),
		fields: z.record(z.string(), fieldMapping).superRefine((fields, ctx) => {
			const names = Object.keys(fields);
			if (names.length === 0) ctx.addIssue({ code: "custom", message: "Map at least one field" });
			for (const name of names) {
				if (!SLUG_RE.test(name)) {
					ctx.addIssue({ code: "custom", message: `Invalid field name "${name}"`, path: [name] });
				}
				if (name === SOURCE_ID_FIELD) {
					ctx.addIssue({
						code: "custom",
						message: `"${SOURCE_ID_FIELD}" is reserved`,
						path: [name],
					});
				}
			}
		}),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
type FieldMapping = Template["fields"][string];

export type FieldValue = string | number | null;
export type MappedRecord = { key: string; slug?: string; data: Record<string, FieldValue> };
export type ValueErrorCode =
	| "not_scalar"
	| "missing_key"
	| "key_too_long"
	| "invalid_number"
	| "invalid_date"
	| "empty_slug";
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, "");
}

type Converted =
	| { ok: true; value: FieldValue }
	| { ok: false; code: ValueErrorCode; message: string };

const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";

/** A source value as text (numbers and booleans as their string), or null for an object or array. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

function convertText(mapping: FieldMapping, raw: string): Converted {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, value: null };
	switch (mapping.type) {
		case "text":
			return { ok: true, value: raw };
		case "number": {
			if (!NUMBER_RE.test(trimmed)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			const n = Number(trimmed);
			if (!Number.isFinite(n)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			return { ok: true, value: n };
		}
		case "date": {
			const dt = mapping.format
				? DateTime.fromFormat(trimmed, mapping.format, { zone: mapping.tz })
				: DateTime.fromISO(trimmed, { zone: mapping.tz });
			if (!dt.isValid) {
				const expected = mapping.format ?? "ISO 8601";
				return {
					ok: false,
					code: "invalid_date",
					message: `"${trimmed}" is not a ${expected} date`,
				};
			}
			return { ok: true, value: dt.toUTC().toISO() };
		}
	}
}

/**
 * Converts a typed source value. A JSON number goes into a number field as it is; numbers and
 * booleans become their string for text and date fields; `true`/`false` are not numbers; an
 * object or array fails with `not_scalar`; a missing path or `null` is `null`.
 */
function convert(mapping: FieldMapping, raw: unknown): Converted {
	if (mapping.type === "number" && typeof raw === "number") {
		return Number.isFinite(raw)
			? { ok: true, value: raw }
			: { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	if (mapping.type === "number" && typeof raw === "boolean") {
		return { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	const text = scalarText(raw);
	if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
	return convertText(mapping, text);
}

/** Applies the template to one record value (a CSV row object, a JSON value, an XML object). */
export function applyTemplate(
	t: Template,
	value: unknown,
): { ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] } {
	const errors: ValueError[] = [];
	const read = (path: string) => resolvePath(value, path, t.source.format);

	const keyText = scalarText(read(t.key.from));
	const key = keyText?.trim() ?? "";
	if (keyText === null) {
		errors.push({ field: t.key.from, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
	} else if (key === "") {
		errors.push({ field: t.key.from, code: "missing_key", message: "The key column is empty" });
	} else if (key.length > MAX_KEY_LENGTH) {
		errors.push({
			field: t.key.from,
			code: "key_too_long",
			message: `Keys are limited to ${MAX_KEY_LENGTH} characters`,
		});
	}

	let slug: string | undefined;
	if (t.slug) {
		const slugText = scalarText(read(t.slug.from));
		if (slugText === null) {
			errors.push({ field: "slug", code: "not_scalar", message: NOT_SCALAR_MESSAGE });
		} else {
			slug = slugify(slugText);
			if (slug === "") {
				errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
			}
		}
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const result = convert(mapping, read(mapping.from));
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}

/** Every source path the template reads: key, slug and field `from`s, without duplicates. */
export function templatePaths(t: Template): string[] {
	return [
		...new Set([
			t.key.from,
			...(t.slug ? [t.slug.from] : []),
			...Object.values(t.fields).map((m) => m.from),
		]),
	];
}

/**
 * Warnings for JSON, JSON Lines and XML paths that resolve in none of the sampled record values.
 * CSV columns are checked against the header by `checkTemplate` instead.
 */
export function missingPathWarnings(t: Template, sample: unknown[]): string[] {
	if (t.source.format === "csv") return [];
	return templatePaths(t)
		.filter((path) => !sample.some((v) => resolvePath(v, path, t.source.format) !== undefined))
		.map((path) => `Path "${path}" was not found in the first ${sample.length} records`);
}

export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<FieldMapping["type"], string[]> = {
	text: ["string", "text", "url"],
	number: ["number", "integer"],
	date: ["datetime"],
};

/**
 * Problems that stop a job: CSV columns missing from the header (`columns`, CSV only), field
 * paths that are not valid for the source format, and fields the collection lacks or types it
 * cannot take.
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv") {
			if (columns !== null && !columns.includes(path)) {
				errors.push(`Column "${path}" not found in the source`);
			}
			continue;
		}
		const problem = pathProblem(path, format);
		if (problem !== null) errors.push(problem);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f.type]));
	for (const [field, mapping] of Object.entries(t.fields)) {
		const type = byslug.get(field);
		if (type === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else if (!COMPATIBLE[mapping.type].includes(type)) {
			errors.push(
				`Field "${field}" has type "${type}"; a ${mapping.type} mapping needs one of ${COMPATIBLE[mapping.type].join(", ")}`,
			);
		}
	}
	return errors;
}
```

Create `packages/flux-import/src/sources/readers.ts`:
```ts
import { csvReader } from "./csv-reader.js";
import { jsonlReader, jsonReader } from "./json.js";
import { recordsPathProblem } from "./paths.js";
import type { RecordReader, TemplateSource } from "./reader.js";
import { xmlReader } from "./xml.js";

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
		case "csv":
			return csvReader(columns);
		case "json":
			return jsonReader(source.records);
		case "jsonl":
			return jsonlReader();
		case "xml":
			return xmlReader(source.records ?? "");
	}
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/template.test.ts tests/unit/readers.test.ts`
Expected: PASS (`template.test.ts` 39, `readers.test.ts` 11). Then `pnpm typecheck && pnpm lint && pnpm test` (the CSV engine tests are unchanged and still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/template.ts packages/flux-import/src/sources/readers.ts packages/flux-import/tests/unit/template.test.ts packages/flux-import/tests/unit/readers.test.ts
git commit -m "Add the template source block and convert typed source values"
```

### Task 7: Engine on readers: job source, warnings, batches

**Files:**
- Modify: `packages/flux-import/src/engine/types.ts` (`Job`), `packages/flux-import/src/engine/jobs.ts` (replace the whole file), `packages/flux-import/src/engine/batch.ts` (imports, `processRecord`, `decide`, `importPass`, `readOneRecord`, `runBatch`)
- Create: `packages/flux-import/tests/fixtures/formats.ts`
- Test: `packages/flux-import/tests/unit/jobs.test.ts`, `packages/flux-import/tests/unit/formats.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CSV_SOURCE`, `RecordReader`, `SourceError`, `SourceRecord`, `TemplateSource`), Task 6 (`checkSource`, `readerFor`, `checkTemplate(t, fields, columns | null)`, `missingPathWarnings`, `applyTemplate(t, value: unknown)`, `Template`); fakes `makeDeps()` (`deps.source.add(id, text)`, `deps.content.failWrite`), `runBatch`, `transitionJob`, `ContentWriteError`.
- Produces:
  - `Job` gains `source?: TemplateSource`, `columns?: string[]`, `warnings?: string[]`; `headers` becomes `headers?: string[]` (legacy, read only). `createJob` always sets `source` and `warnings`, and `columns` for CSV.
  - `engine/jobs.ts`: `WARNING_SAMPLE = 20`; `jobReader(job: Job): RecordReader`; `jobTemplate(job: Job): Template`; `createJob` errors: `JobError("invalid_source", message, details)` for a bad source block (`details` = `checkSource` problems), a missing upload, or any `SourceError` while locating (`details` = `["<code> at byte <offset>"]`).
  - `engine/batch.ts`: `processRecord(deps, job, rec: SourceRecord, opts)`; a record's `error` becomes the failed row's single error; a `SourceError` fails the job with `error.code` = its code and message `"<message> at byte <offset>"`.
  - `tests/fixtures/formats.ts` (Tasks 9 and 10 use it): `product(i)`, `productsJson(n, { wrapped? })` (wrapped puts the array at `data.products`), `productsJsonl(n)`, `productsXml(n)` (records `feed/item`), `jsonTemplate(collection, source = { format: "json" })` (key `sku`, slug `handle`, `title` ← `name`, `price` ← `price.amount`, `released` ← `released` as a date in Europe/Chisinau), `xmlTemplate(collection)` (key `@sku`, `title` ← `title`, `price` ← `price`), `MALFORMED` (`json`, `jsonl`, `xml`), `MALFORMED_OUTCOMES`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/fixtures/formats.ts`:
```ts
/**
 * JSON, JSON Lines and XML fixtures for unit and integration tests. Every format carries the same
 * products as `productsCsv` (tests/integration/fixtures.ts) and maps them to the same fields:
 * `title` (text), `price` (number) and `released` (date).
 */
export interface Product {
	sku: string;
	name: string;
	price: number;
	released: string;
	handle: string;
}

export function product(i: number): Product {
	const day = String((i % 28) + 1).padStart(2, "0");
	return {
		sku: `SKU-${i}`,
		name: `Product ${i}, "quoted" & <tagged> ț`,
		price: i + 0.5,
		released: `2026-03-${day}`,
		handle: `product-${i}`,
	};
}

function jsonProduct(p: Product): string {
	return JSON.stringify({
		sku: p.sku,
		name: p.name,
		price: { amount: p.price, currency: "EUR" },
		released: p.released,
		handle: p.handle,
	});
}

const products = (n: number) => Array.from({ length: n }, (_, i) => product(i));

/**
 * A JSON array of products. `wrapped` puts it at `data.products` after keys whose values hold
 * brackets inside strings and a decoy `data.products` path.
 */
export function productsJson(n: number, opts: { wrapped?: boolean } = {}): string {
	const array = `[\n${products(n).map(jsonProduct).join(",\n")}\n]`;
	if (!opts.wrapped) return array;
	return `{"meta": {"note": "brackets ] } [ { in a string", "data": {"products": "decoy"}},\n"data": {"products": ${array}}}\n`;
}

export function productsJsonl(n: number): string {
	return `${products(n).map(jsonProduct).join("\r\n")}\r\n`;
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function xmlProduct(p: Product): string {
	return (
		`  <item sku="${p.sku}">` +
		`<title lang="en">${xmlText(p.name)}</title>` +
		`<price currency="EUR">${p.price}</price>` +
		`<released>${p.released}</released>` +
		`<handle><![CDATA[${p.handle}]]></handle>` +
		"</item>\n"
	);
}

export function productsXml(n: number): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<feed>\n${products(n).map(xmlProduct).join("")}</feed>\n`;
}

const DATE = { type: "date", tz: "Europe/Chisinau" } as const;

export function jsonTemplate(
	collection: string,
	source: Record<string, string> = { format: "json" },
) {
	return {
		version: 1,
		collection,
		locale: "en",
		source,
		key: { from: "sku" },
		slug: { from: "handle" },
		fields: {
			title: { from: "name", type: "text" },
			price: { from: "price.amount", type: "number" },
			released: { from: "released", ...DATE },
		},
	};
}

export function xmlTemplate(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format: "xml", records: "feed/item" },
		key: { from: "@sku" },
		slug: { from: "handle" },
		fields: {
			title: { from: "title", type: "text" },
			price: { from: "price", type: "number" },
			released: { from: "released", ...DATE },
		},
	};
}

/**
 * Per format: M-1, M-2 and M-6 import; M-3 has a bad number, M-4 does not parse
 * (`invalid_record`), M-5 maps an object to a text field (`not_scalar`). JSON and XML then
 * break off (`source_syntax`); JSON Lines has no structure to break, so its job completes.
 */
export const MALFORMED = {
	json:
		"[\n" +
		'{"sku": "M-1", "name": "One", "price": {"amount": 1}, "released": "2026-03-01", "handle": "m-1"},\n' +
		'{"sku": "M-2", "name": "Two", "price": {"amount": 2}, "released": "2026-03-02", "handle": "m-2"},\n' +
		'{"sku": "M-3", "name": "Three", "price": {"amount": "n/a"}, "released": "2026-03-03", "handle": "m-3"},\n' +
		'{"sku": "M-4", "name": "Four", "price": {"amount": 4}, broken},\n' +
		'{"sku": "M-5", "name": {"first": "Fi", "last": "ve"}, "price": {"amount": 5}, "released": "2026-03-05", "handle": "m-5"},\n' +
		'{"sku": "M-6", "name": "Six", "price": {"amount": 6}, "released": "2026-03-06", "handle": "m-6"},\n' +
		'{"sku": "M-7", "name": "Seven never closes',
	jsonl:
		'{"sku": "M-1", "name": "One", "price": {"amount": 1}, "released": "2026-03-01", "handle": "m-1"}\n' +
		'{"sku": "M-2", "name": "Two", "price": {"amount": 2}, "released": "2026-03-02", "handle": "m-2"}\n' +
		'{"sku": "M-3", "name": "Three", "price": {"amount": "n/a"}, "released": "2026-03-03", "handle": "m-3"}\n' +
		'{"sku": "M-4", "name": "Four", broken\n' +
		'{"sku": "M-5", "name": {"first": "Fi", "last": "ve"}, "price": {"amount": 5}, "released": "2026-03-05", "handle": "m-5"}\n' +
		'{"sku": "M-6", "name": "Six", "price": {"amount": 6}, "released": "2026-03-06", "handle": "m-6"}\n',
	xml:
		"<feed>\n" +
		'<item sku="M-1"><title>One</title><price>1</price><released>2026-03-01</released><handle>m-1</handle></item>\n' +
		'<item sku="M-2"><title>Two</title><price>2</price><released>2026-03-02</released><handle>m-2</handle></item>\n' +
		'<item sku="M-3"><title>Three</title><price>n/a</price><released>2026-03-03</released><handle>m-3</handle></item>\n' +
		'<item sku="M-4"><title>Four&nbsp;</title><price>4</price></item>\n' +
		'<item sku="M-5"><title><b>Fi</b>ve</title><price>5</price><released>2026-03-05</released><handle>m-5</handle></item>\n' +
		'<item sku="M-6"><title>Six</title><price>6</price><released>2026-03-06</released><handle>m-6</handle></item>\n' +
		'<item sku="M-7"><title>Seven never closes</feed>\n',
} as const;

/** The record outcomes the malformed fixtures give, in order. */
export const MALFORMED_OUTCOMES = [
	["created", undefined],
	["created", undefined],
	["failed", "invalid_number"],
	["failed", "invalid_record"],
	["failed", "not_scalar"],
	["created", undefined],
] as const;
```

In `packages/flux-import/tests/unit/jobs.test.ts`, in "creates a job positioned after the header with defaults", replace
```ts
			headers: ["sku", "Name"],
```
with:
```ts
			source: { format: "csv" },
			columns: ["sku", "Name"],
			warnings: [],
```
and insert before `describe("transitionJob", () => {`:
```ts
describe("createJob for JSON, JSON Lines and XML", () => {
	const jsonT = (source: object, fields: object = { title: { from: "name", type: "text" } }) => ({
		...template,
		source,
		fields,
	});

	it("positions the cursor on the records array and stores the source without columns", async () => {
		const { deps } = makeDeps();
		const body = '{"skip": [1, "]"], "data": {"items": [{"sku": "A1", "name": "Desk"}]}}';
		deps.source.add("u1", body);
		const source = { format: "json", records: "data.items" };
		const job = await createJob(deps, { uploadId: "u1", template: jsonT(source), schemaFields });
		expect(job).toMatchObject({
			source,
			warnings: [],
			cursor: { offset: body.indexOf("[{") + 1, seq: 0 },
		});
		expect(job).not.toHaveProperty("columns");
		expect(job).not.toHaveProperty("headers");
	});

	it("stores a warning for each path none of the first 20 records has", async () => {
		const { deps } = makeDeps();
		const rows = Array.from({ length: 25 }, (_, i) => ({
			sku: `S${i}`,
			...(i === 24 ? { name: "late" } : {}),
		}));
		deps.source.add("u1", JSON.stringify(rows));
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual(['Path "name" was not found in the first 20 records']);
	});

	it("creates the job when the sample hits a structural error; the run fails there", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '[{"sku": "A1", "name": "Desk"}, {"sku": "open');
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual([]);
	});

	it.each([
		["records on CSV", { format: "csv", records: "x" }, "[]", /not allowed for csv/],
		["records on JSON Lines", { format: "jsonl", records: "x" }, "{}", /not allowed for jsonl/],
		["XML without records", { format: "xml" }, "<feed/>", /required for xml/],
		[
			"a records path that is not an array",
			{ format: "json", records: "data" },
			'{"data": {}}',
			/not an array/,
		],
		["a top-level object without records", { format: "json" }, '{"data": []}', /source\.records/],
		[
			"a DTD",
			{ format: "xml", records: "feed/item" },
			'<!DOCTYPE feed SYSTEM "x.dtd"><feed/>',
			/DOCTYPE/,
		],
	])("rejects %s with invalid_source", async (_name, source, body, message) => {
		const { deps } = makeDeps();
		deps.source.add("u1", body);
		const err = await createJob(deps, {
			uploadId: "u1",
			template: jsonT(source),
			schemaFields,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JobError);
		expect(err).toMatchObject({ code: "invalid_source" });
		expect([(err as JobError).message, ...(err as JobError).details].join(" ")).toMatch(message);
	});

	it("names the source error code in the details", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '<!DOCTYPE feed [<!ENTITY x "y">]><feed/>');
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: jsonT({ format: "xml", records: "feed/item" }),
				schemaFields,
			}),
		).rejects.toMatchObject({ code: "invalid_source", details: ["xml_dtd_not_allowed at byte 0"] });
	});

	it("rejects a field path that is not valid for the format", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "[]");
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: jsonT({ format: "json" }, { title: { from: "name.", type: "text" } }),
				schemaFields,
			}),
		).rejects.toMatchObject({ code: "invalid_template", details: ['"name." has an empty key'] });
	});
});
```

Create `packages/flux-import/tests/unit/formats.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { Job } from "../../src/engine/types.js";
import {
	jsonTemplate,
	MALFORMED,
	MALFORMED_OUTCOMES,
	productsJson,
	productsJsonl,
	productsXml,
	xmlTemplate,
} from "../fixtures/formats.js";
import { makeDeps } from "./fakes.js";

const schemaFields = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "released", type: "datetime" },
];

const FORMATS = [
	["JSON", (n: number) => productsJson(n), jsonTemplate("products")],
	[
		"JSON at a records path",
		(n: number) => productsJson(n, { wrapped: true }),
		jsonTemplate("products", { format: "json", records: "data.products" }),
	],
	["JSON Lines", productsJsonl, jsonTemplate("products", { format: "jsonl" })],
	["XML", productsXml, xmlTemplate("products")],
] as const;

async function setup(body: string, template: unknown, batchSize = 50) {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", body);
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, batchSize });
	return { deps, clock, job };
}

async function runToEnd(deps: Parameters<typeof runBatch>[0], id: string): Promise<Job> {
	for (let i = 0; i < 100_000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

async function outcomes(deps: Parameters<typeof runBatch>[0], jobId: string) {
	const page = await deps.records.query({ where: { jobId }, orderBy: { seq: "asc" }, limit: 100 });
	return page.items.map((r) => [r.data.status, r.data.errors?.[0]?.code]);
}

describe.each(FORMATS)("%s import", (_name, body, template) => {
	it("imports every record in resumable batches with typed values", async () => {
		const { deps, job } = await setup(body(10), template, 3);
		expect(job.warnings).toEqual([]);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = [...deps.content.entries.values()];
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10);
		expect(entries.find((e) => e.data.flux_source_id === "SKU-1")).toMatchObject({
			slug: "product-1",
			data: {
				title: 'Product 1, "quoted" & <tagged> ț',
				price: 1.5,
				released: "2026-03-01T22:00:00.000Z",
			},
		});
	});

	it("reports every record unchanged when the same file is imported again", async () => {
		const { deps, job } = await setup(body(5), template);
		await runToEnd(deps, job.id);
		const again = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect((await runToEnd(deps, again.id)).counters).toMatchObject({ unchanged: 5, created: 0 });
	});

	it("imports 10,000 records", async () => {
		const { deps, job } = await setup(body(10_000), template, 500);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 10_000, failed: 0 });
		expect(deps.content.entries.size).toBe(10_000);
	}, 60_000);
});

describe.each([
	["JSON", MALFORMED.json, jsonTemplate("products"), "source_syntax"],
	["JSON Lines", MALFORMED.jsonl, jsonTemplate("products", { format: "jsonl" }), null],
	["XML", MALFORMED.xml, xmlTemplate("products"), "source_syntax"],
] as const)("malformed %s", (_name, body, template, jobError) => {
	it("logs bad records, imports the good ones and fails the job only at a structural break", async () => {
		const { deps, job } = await setup(body, template, 2);
		const done = await runToEnd(deps, job.id);
		expect(await outcomes(deps, job.id)).toEqual(MALFORMED_OUTCOMES);
		expect(done.counters).toMatchObject({ created: 3, failed: 3 });
		if (jobError === null) expect(done).toMatchObject({ status: "completed", error: null });
		else expect(done).toMatchObject({ status: "failed", error: { code: jobError } });
	});
});

describe("retry on structured sources", () => {
	it("re-reads a failed JSON record by its start offset", async () => {
		const { deps, job } = await setup(productsJson(4, { wrapped: true }), FORMATS[1][2]);
		deps.content.failWrite = (data) =>
			data.flux_source_id === "SKU-2" ? new ContentWriteError("validation", "Too long") : null;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({ created: 3, failed: 1 });
		deps.content.failWrite = () => null;
		await transitionJob(deps, job.id, "retry");
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 4, failed: 0 });
	});
});

describe("jobs created before M3a", () => {
	it("still run as CSV from their stored headers", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name\nA1,Desk\nB2,Chair\n");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { title: { from: "Name", type: "text" } },
			},
			schemaFields,
		});
		const { source: _s, columns, warnings: _w, template, ...rest } = job;
		const { source: _ts, ...oldTemplate } = template;
		const legacy = { ...rest, template: oldTemplate, headers: columns } as unknown as Job;
		await deps.jobs.put(job.id, legacy);
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 2 } });
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/jobs.test.ts tests/unit/formats.test.ts`
Expected: FAIL — jobs have no `source`/`columns`/`warnings`; a JSON template fails creation (`CSV has no header row` or `Column "sku" not found`).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/types.ts`, add the import
```ts
import type { TemplateSource } from "../sources/reader.js";
```
as the first line, and in `interface Job` replace
```ts
	headers: string[];
```
with:
```ts
	/** The template's source block. Absent on jobs created before M3a, which are CSV. */
	source?: TemplateSource;
	/** CSV header columns; absent for other formats. */
	columns?: string[];
	/** Pre-M3a name of `columns`, still read for jobs created before M3a. */
	headers?: string[];
	/** Template paths missing from the sampled records (JSON, JSON Lines, XML). */
	warnings?: string[];
```

Replace `packages/flux-import/src/engine/jobs.ts` with:
```ts
import { CSV_SOURCE, type RecordReader, SourceError } from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
import { SourceMissingError } from "./ports.js";
import {
	checkTemplate,
	missingPathWarnings,
	type SchemaField,
	type Template,
	templateSchema,
} from "./template.js";
import {
	BATCH_SIZE_DEFAULT,
	BATCH_SIZE_MAX,
	BUDGET_MS_DEFAULT,
	type EngineDeps,
	emptyCounters,
	type Job,
	type JobStatus,
} from "./types.js";

export type JobErrorCode =
	| "not_found"
	| "invalid_transition"
	| "invalid_template"
	| "invalid_options"
	| "invalid_source";

export class JobError extends Error {
	constructor(
		readonly code: JobErrorCode,
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
		this.name = "JobError";
	}
}

export type CreateJobInput = {
	uploadId: string;
	template: unknown;
	schemaFields: SchemaField[];
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
export const WARNING_SAMPLE = 20;
const BUDGET_MS_MIN = 500;
const BUDGET_MS_MAX = 25_000;
const CAS_ATTEMPTS = 5;

export async function createJob(deps: EngineDeps, input: CreateJobInput): Promise<Job> {
	const batchSize = input.batchSize ?? BATCH_SIZE_DEFAULT;
	const budgetMs = input.budgetMs ?? BUDGET_MS_DEFAULT;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE_MAX) {
		throw new JobError(
			"invalid_options",
			`batchSize must be an integer from 1 to ${BATCH_SIZE_MAX}`,
		);
	}
	if (!Number.isInteger(budgetMs) || budgetMs < BUDGET_MS_MIN || budgetMs > BUDGET_MS_MAX) {
		throw new JobError(
			"invalid_options",
			`budgetMs must be an integer from ${BUDGET_MS_MIN} to ${BUDGET_MS_MAX}`,
		);
	}

	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
		throw new JobError(
			"invalid_template",
			"The template is invalid",
			parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`),
		);
	}
	const template = parsed.data;

	const sourceProblems = checkSource(template.source);
	if (sourceProblems.length > 0) {
		throw new JobError("invalid_source", "The source block is invalid", sourceProblems);
	}
	const reader = readerFor(template.source);
	const located = await asJobError(async () =>
		reader.locate(await deps.source.open(input.uploadId, 0)),
	);
	const columns = located.columns ?? null;

	const problems = checkTemplate(template, input.schemaFields, columns);
	if (problems.length > 0) {
		throw new JobError(
			"invalid_template",
			"The template does not fit the source or schema",
			problems,
		);
	}
	const warnings =
		template.source.format === "csv"
			? []
			: missingPathWarnings(
					template,
					await asJobError(() => sampleValues(deps, reader, input.uploadId, located.bodyOffset)),
				);

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
		id: deps.newId(),
		status: "created",
		uploadId: input.uploadId,
		template,
		dryRun: input.dryRun ?? false,
		publish: input.publish ?? true,
		batchSize,
		budgetMs,
		source: template.source,
		...(columns === null ? {} : { columns }),
		warnings,
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		failures: 0,
		createdAt: now,
		updatedAt: now,
	};
	const result = await deps.jobs.compareAndSet(job.id, null, job);
	if (!result.applied) throw new Error(`Job id ${job.id} already exists`);
	return job;
}

/** A missing upload or an unreadable source fails job creation with `invalid_source`. */
async function asJobError<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof SourceMissingError) throw new JobError("invalid_source", e.message);
		if (e instanceof SourceError) {
			throw new JobError("invalid_source", e.message, [`${e.code} at byte ${e.offset}`]);
		}
		throw e;
	}
}

/**
 * Up to `WARNING_SAMPLE` record values for the missing-path check. A structural error ends the
 * sample early: the job is still created and fails at that offset when it runs, as CSV does.
 */
async function sampleValues(
	deps: EngineDeps,
	reader: RecordReader,
	uploadId: string,
	bodyOffset: number,
): Promise<unknown[]> {
	const values: unknown[] = [];
	let seen = 0;
	try {
		const stream = await deps.source.open(uploadId, bodyOffset);
		for await (const rec of reader.read(stream, { startOffset: bodyOffset, startSeq: 0 })) {
			if (!rec.error) values.push(rec.value);
			if (++seen >= WARNING_SAMPLE) break;
		}
	} catch (e) {
		if (!(e instanceof SourceError)) throw e;
	}
	return values;
}

/** The reader for a stored job; jobs created before M3a are CSV with `headers`. */
export function jobReader(job: Job): RecordReader {
	return readerFor(job.source ?? CSV_SOURCE, job.columns ?? job.headers ?? []);
}

/** A stored job's template; templates stored before M3a have no source block and are CSV. */
export function jobTemplate(job: Job): Template {
	return job.template.source ? job.template : { ...job.template, source: CSV_SOURCE };
}

export async function updateJob(
	deps: EngineDeps,
	id: string,
	change: (job: Job) => Job,
): Promise<Job> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.jobs.getVersioned(id);
		if (!current) throw new JobError("not_found", `Job ${id} not found`);
		const next = { ...change(current.value), updatedAt: new Date(deps.now()).toISOString() };
		const result = await deps.jobs.compareAndSet(id, current.revision, next);
		if (result.applied) return next;
	}
	throw new Error(`Job ${id} changed concurrently ${CAS_ATTEMPTS} times; try again`);
}

const ALLOWED: Record<"pause" | "resume" | "cancel" | "retry", JobStatus[]> = {
	pause: ["created", "running"],
	resume: ["paused", "failed"],
	cancel: ["created", "running", "paused", "failed"],
	retry: ["completed"],
};

export function transitionJob(
	deps: EngineDeps,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	return updateJob(deps, id, (job) => {
		if (!ALLOWED[action].includes(job.status) || (action === "retry" && job.dryRun)) {
			throw new JobError(
				"invalid_transition",
				`Cannot ${action} a ${job.status}${job.dryRun ? " dry-run" : ""} job`,
			);
		}
		switch (action) {
			case "pause":
				return { ...job, status: "paused" };
			case "resume":
				return { ...job, status: "running", error: null, failures: 0 };
			case "cancel":
				return { ...job, status: "cancelled" };
			case "retry":
				return { ...job, status: "running", phase: "retry", retryFromSeq: 0, error: null };
		}
	});
}
```

In `packages/flux-import/src/engine/batch.ts`:

Replace the first three import lines
```ts
import { type CsvRecord, CsvSyntaxError, readCsvRecords } from "../sources/csv.js";
import { dateFieldsOf, type PlanAction, planRecord, type RecordPlan } from "./diff.js";
import { JobError, updateJob } from "./jobs.js";
```
with:
```ts
import { SourceError, type SourceRecord } from "../sources/reader.js";
import { dateFieldsOf, type PlanAction, planRecord, type RecordPlan } from "./diff.js";
import { JobError, jobReader, jobTemplate, updateJob } from "./jobs.js";
```

In `processRecord` and `decide`, change the parameter `rec: CsvRecord,` to `rec: SourceRecord,` (two places).

In `decide`, replace
```ts
	if (rec.error) {
		return {
			status: "failed",
			sourceKey: null,
			entryId: null,
			errors: [{ code: "column_count", message: `Expected ${job.headers.length} columns` }],
		};
	}
	const mapped = applyTemplate(job.template, rec.values);
```
with:
```ts
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const mapped = applyTemplate(jobTemplate(job), rec.value);
```

In `importPass`, replace
```ts
	for await (const rec of readCsvRecords(stream, {
		headers: job.headers,
		startOffset: job.cursor.offset,
```
with:
```ts
	for await (const rec of jobReader(job).read(stream, {
		startOffset: job.cursor.offset,
```

Replace `readOneRecord` with:
```ts
async function readOneRecord(deps: EngineDeps, job: Job, row: RecordRow): Promise<SourceRecord> {
	const stream = await deps.source.open(job.uploadId, row.start);
	for await (const rec of jobReader(job).read(stream, {
		startOffset: row.start,
		startSeq: row.seq,
	})) {
		return rec;
	}
	throw new SourceError("source_syntax", "No record at the saved offset", row.start);
}
```

In `runBatch`, replace
```ts
		} else if (e instanceof CsvSyntaxError) {
			outcome = {
				done: false,
				error: { code: "csv_syntax", message: `${e.message} at byte ${e.offset}` },
			};
```
with:
```ts
		} else if (e instanceof SourceError) {
			outcome = {
				done: false,
				error: { code: e.code, message: `${e.message} at byte ${e.offset}` },
			};
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/jobs.test.ts tests/unit/formats.test.ts tests/unit/batch.test.ts`
Expected: PASS (`jobs.test.ts` 26, `formats.test.ts` 17, `batch.test.ts` unchanged and passing; `formats.test.ts` takes about 14 s for its four 10,000-record imports). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine packages/flux-import/tests/fixtures/formats.ts packages/flux-import/tests/unit/jobs.test.ts packages/flux-import/tests/unit/formats.test.ts
git commit -m "Run jobs through format readers and store the source block and path warnings"
```

### Task 8: Routes: sample by source, paste, upload extensions

**Files:**
- Modify: `packages/flux-import/src/plugin/service.ts` (imports, constants, `sampleSource`, new `stagePaste`), `packages/flux-import/src/plugin/routes.ts` (imports, schemas, `Services`, `withServices`, `sources/sample`, new `sources/paste`), `packages/flux-import/src/astro/upload-route.ts` (filename check)
- Test: `packages/flux-import/tests/unit/service.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`, `packages/flux-import/tests/unit/upload-route.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CSV_SOURCE`, `SOURCE_FORMATS`, `SourceError`, `TemplateSource`, `ValueSample`), Task 6 (`checkSource`, `readerFor`), `stageUpload(storage, body, maxBytes, declaredLength?): Promise<StagedUpload>` and `type UploadStorage` (`emdash/uploads.ts`), `readCsvSample`, `CsvSample`, `CsvSyntaxError`, `ServiceError(code, message, status)`; fakes `FakeStorage`.
- Produces:
  - `service.ts`: `PASTE_MAX_BYTES = 1024 * 1024`; `sampleSource(deps, uploadId, n, source: TemplateSource = CSV_SOURCE): Promise<CsvSample | ValueSample>` (`INVALID_SOURCE` 400 for a bad source block or an unreadable document, `UPLOAD_NOT_FOUND` 404); `stagePaste(storage: UploadStorage, text: string): Promise<StagedUpload>` (`EMPTY_BODY` 400, `TOO_LARGE` 413).
  - Routes: `sources/sample` input `{ uploadId, n = 5, source?: { format, records? } }`; `sources/paste` input `{ format, text }` with `request: { body: "json", maxBytes: PASTE_MAX_BYTES }` (F1), answering `{ uploadId, bytes, sha256 }`. `jobs/create` is unchanged: it returns the stored job, which now carries `source` and `warnings`.
  - Upload route: `?filename=` must end in `.csv`, `.json`, `.jsonl`, `.ndjson` or `.xml` (any case, at most 255 characters, no `/`, `\` or NUL); otherwise 415 `UNSUPPORTED_SOURCE`.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/service.test.ts`:
- add `import { EmDashUploads } from "../../src/emdash/uploads.js";` after the `resolveSiteLocale` import;
- add `PASTE_MAX_BYTES,` after `nextBatch,` and `stagePaste,` after `sampleSource,` in the service import;
- change `import { makeDeps } from "./fakes.js";` to `import { FakeStorage, makeDeps } from "./fakes.js";`;
- in "returns headers and at most 20 rows", replace
```ts
		expect(sample.headers).toEqual(["sku", "Name", "Price"]);
		expect(sample.rows).toHaveLength(20);
```
with:
```ts
		expect(sample).toMatchObject({ headers: ["sku", "Name", "Price"] });
		expect("rows" in sample && sample.rows).toHaveLength(20);
```
- insert after that test (inside `describe("sampleSource", …)`):
```ts
	it("returns records and paths for JSON and XML", async () => {
		const { deps } = makeDeps();
		deps.source.add(
			"j",
			'{"data": [{"sku": "A1", "price": {"amount": 1}}, {"sku": "B2", "tags": []}]}',
		);
		expect(await sampleSource(deps, "j", 5, { format: "json", records: "data" })).toEqual({
			records: [
				{ sku: "A1", price: { amount: 1 } },
				{ sku: "B2", tags: [] },
			],
			paths: ["sku", "price.amount", "tags"],
		});
		deps.source.add("x", '<feed><item sku="A1"><t>x</t></item></feed>');
		expect(await sampleSource(deps, "x", 5, { format: "xml", records: "feed/item" })).toEqual({
			records: [{ "@sku": "A1", t: "x" }],
			paths: ["@sku", "t"],
		});
	});

	it("reports a bad source block or an unreadable document as INVALID_SOURCE", async () => {
		const { deps } = makeDeps();
		deps.source.add("x", '<!DOCTYPE feed [<!ENTITY a "b">]><feed/>');
		await expect(sampleSource(deps, "x", 5, { format: "xml" })).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: expect.stringMatching(/required for xml/),
		});
		await expect(
			sampleSource(deps, "x", 5, { format: "xml", records: "feed/item" }),
		).rejects.toMatchObject({ code: "INVALID_SOURCE", status: 400 });
	});
```
- insert before `describe("startJob", () => {`:
```ts
describe("stagePaste", () => {
	it("stages the text's UTF-8 bytes like an upload", async () => {
		const storage = new FakeStorage();
		const text = '[{"sku": "Ș1"}]';
		const staged = await stagePaste(storage, text);
		expect(staged.bytes).toBe(new TextEncoder().encode(text).byteLength);
		expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
		const stream = await new EmDashUploads(storage).open(staged.uploadId, 0);
		expect(await new Response(stream).text()).toBe(text);
	});

	it("rejects empty or blank text with EMPTY_BODY and stores nothing", async () => {
		const storage = new FakeStorage();
		for (const text of ["", " \n\t"]) {
			await expect(stagePaste(storage, text)).rejects.toMatchObject({
				code: "EMPTY_BODY",
				status: 400,
			});
		}
		expect(storage.files.size).toBe(0);
	});

	it("rejects text over 1 MiB with TOO_LARGE", async () => {
		const storage = new FakeStorage();
		await expect(stagePaste(storage, "é".repeat(PASTE_MAX_BYTES / 2 + 1))).rejects.toMatchObject({
			code: "TOO_LARGE",
			status: 413,
		});
		expect(storage.files.size).toBe(0);
	});

	it("passes the length on Workers, where R2 needs it", async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		const lengths: number[] = [];
		global.FixedLengthStream = class extends TransformStream {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		};
		try {
			const staged = await stagePaste(new FakeStorage(), "a,b\n1,2\n");
			expect(staged.bytes).toBe(8);
			expect(lengths).toEqual([8]);
		} finally {
			delete global.FixedLengthStream;
		}
	});
});
```

In `packages/flux-import/tests/unit/definition.test.ts`, add `"sources/paste",` after `"sources/sample",` in `ROUTES`; in "declares every API route with import:execute", after the `jobs/next` assertion add:
```ts
		expect(plugin.routes["sources/paste"]).toMatchObject({
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 * 1024 },
		});
```
and in "validates route input with Zod", after the `sample.parse(…)` assertion add:
```ts
		expect(
			sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "xml", records: "feed/item" } })
				.success,
		).toBe(true);
		expect(sample.safeParse({ uploadId: UPLOAD_ID, source: { format: "yaml" } }).success).toBe(
			false,
		);
		const paste = plugin.routes["sources/paste"]!.input!;
		expect(paste.safeParse({ format: "json", text: "[]" }).success).toBe(true);
		expect(paste.safeParse({ format: "xlsx", text: "x" }).success).toBe(false);
		expect(paste.safeParse({ format: "csv" }).success).toBe(false);
```

In `packages/flux-import/tests/unit/upload-route.test.ts`, replace
```ts
const URL_ = "http://site.test/_emdash/api/flux-import/uploads?filename=data.csv";

async function post(init: RequestInit & { duplex?: "half" }) {
	const storage = new FakeStorage();
	const request = new Request(URL_, { method: "POST", ...init });
	const context = {
		request,
		url: new URL(URL_),
```
with:
```ts
const BASE = "http://site.test/_emdash/api/flux-import/uploads?filename=";
const URL_ = `${BASE}data.csv`;

async function post(init: RequestInit & { duplex?: "half" }, url = URL_) {
	const storage = new FakeStorage();
	const request = new Request(url, { method: "POST", ...init });
	const context = {
		request,
		url: new URL(url),
```
and append inside `describe("upload route", …)`, after "stages a non-empty body":
```ts
	it.each([
		"feed.json",
		"feed.JSONL",
		"feed.ndjson",
		"feed.xml",
		"a.b.csv",
		`${"n".repeat(251)}.csv`,
	])("accepts %s", async (name) => {
		const { res } = await post(
			{ body: streamOf("x"), duplex: "half" },
			BASE + encodeURIComponent(name),
		);
		expect(res.status).toBe(201);
	});

	it.each([
		"feed.txt",
		"feed.json.gz",
		"../feed.json",
		"feed",
		".json",
		`${"n".repeat(250)}.ndjson`,
	])("rejects %s with 415 and stores nothing", async (name) => {
		const { res, body, storage } = await post(
			{ body: streamOf("x"), duplex: "half" },
			BASE + encodeURIComponent(name),
		);
		expect(res.status).toBe(415);
		expect(body).toMatchObject({ error: { code: "UNSUPPORTED_SOURCE" } });
		expect(storage.files.size).toBe(0);
	});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/service.test.ts tests/unit/definition.test.ts tests/unit/upload-route.test.ts`
Expected: FAIL — `stagePaste` and `PASTE_MAX_BYTES` are not exported, `sources/paste` is missing, `.json` uploads answer 415.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/plugin/service.ts`, add after the `LocaleResolution` import:
```ts
import { type StagedUpload, stageUpload, type UploadStorage } from "../emdash/uploads.js";
```
after the `../sources/csv.js` import:
```ts
import {
	CSV_SOURCE,
	SourceError,
	type TemplateSource,
	type ValueSample,
} from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
```
after `export const SAMPLE_MAX = 20;`:
```ts
/** Pasted text is staged like an upload, up to this many UTF-8 bytes. */
export const PASTE_MAX_BYTES = 1024 * 1024;
```
and replace the whole `sampleSource` function with these two functions:
```ts
/**
 * Samples a staged source: CSV keeps its `{ headers, rows }` shape; JSON, JSON Lines and XML
 * return `{ records, paths }` (records that fail to parse are left out).
 */
export async function sampleSource(
	deps: EngineDeps,
	uploadId: string,
	n: number,
	source: TemplateSource = CSV_SOURCE,
): Promise<CsvSample | ValueSample> {
	const problems = checkSource(source);
	if (problems.length > 0) throw new ServiceError("INVALID_SOURCE", problems.join("; "), 400);
	const count = Math.min(n, SAMPLE_MAX);
	try {
		const stream = await deps.source.open(uploadId, 0);
		if (source.format === "csv") return await readCsvSample(stream, count);
		return await readerFor(source).sample(stream, count);
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof CsvSyntaxError || e instanceof SourceError) {
			throw new ServiceError("INVALID_SOURCE", `${e.message} at byte ${e.offset}`, 400);
		}
		throw e;
	}
}

/** Stages pasted text like an upload. Empty or whitespace-only text is `EMPTY_BODY`. */
export async function stagePaste(storage: UploadStorage, text: string): Promise<StagedUpload> {
	if (text.trim() === "") throw new ServiceError("EMPTY_BODY", "The pasted text is empty", 400);
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength > PASTE_MAX_BYTES) {
		throw new ServiceError("TOO_LARGE", `Pasted text is limited to ${PASTE_MAX_BYTES} bytes`, 413);
	}
	return stageUpload(storage, new Blob([bytes]).stream(), PASTE_MAX_BYTES, bytes.byteLength);
}
```

In `packages/flux-import/src/plugin/routes.ts`:
- replace `import { EmDashUploads, isUploadId } from "../emdash/uploads.js";` with `import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";`
- after the `../engine/types.js` import add `import { SOURCE_FORMATS } from "../sources/reader.js";`
- add `PASTE_MAX_BYTES,` after `nextBatch,` and `stagePaste,` after `sampleSource,` in the `./service.js` import;
- after `const byId = z.object({ id: jobId });` add:
```ts
const format = z.enum(SOURCE_FORMATS);
const source = z.object({ format, records: z.string().min(1).optional() }).strict();
```
- in `interface Services`, add `storage: UploadStorage;` after `uploads: EmDashUploads;`, and in `withServices` replace `return await run({ deps, uploads, runtime, actor });` with `return await run({ deps, uploads, storage: runtime.storage, runtime, actor });`
- replace the `"sources/sample"` entry with these two entries:
```ts
	"sources/sample": route(
		z.object({
			uploadId,
			n: z.number().int().min(1).max(SAMPLE_MAX).default(5),
			source: source.optional(),
		}),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				sampleSource(deps, ctx.input.uploadId, ctx.input.n, ctx.input.source),
			),
	),

	// The text is staged like an upload; the template's source block decides how it is parsed.
	"sources/paste": {
		...route(z.object({ format, text: z.string() }), (ctx) =>
			withServices(ctx, ({ storage }) => stagePaste(storage, ctx.input.text)),
		),
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},
```

In `packages/flux-import/src/astro/upload-route.ts`, replace
```ts
const CSV_FILENAME = /^[^/\\\0]{1,251}\.csv$/i;
```
with:
```ts
/** The extension only gates acceptance; the template's `source.format` decides parsing. */
const SOURCE_FILENAME = /^(?=.{1,255}$)[^/\\\0]+\.(?:csv|json|jsonl|ndjson|xml)$/i;
```
replace ` * POST /_emdash/api/flux-import/uploads?filename=<name>.csv` with ` * POST /_emdash/api/flux-import/uploads?filename=<name>.csv|.json|.jsonl|.ndjson|.xml`, and replace
```ts
	if (!CSV_FILENAME.test(filename)) {
		return apiError("UNSUPPORTED_SOURCE", "filename must name a .csv file", 415);
	}
```
with:
```ts
	if (!SOURCE_FILENAME.test(filename)) {
		return apiError(
			"UNSUPPORTED_SOURCE",
			"filename must name a .csv, .json, .jsonl, .ndjson or .xml file",
			415,
		);
	}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/service.test.ts tests/unit/definition.test.ts tests/unit/upload-route.test.ts`
Expected: PASS (`service.test.ts` 22, `definition.test.ts` 6, `upload-route.test.ts` 16). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin packages/flux-import/src/astro/upload-route.ts packages/flux-import/tests/unit/service.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/upload-route.test.ts
git commit -m "Sample JSON and XML sources, stage pasted text, and accept JSON and XML uploads"
```

### Task 9: Node integration: each format, paste, warnings, kill-and-resume on JSON

**Files:**
- Modify: `packages/flux-import/tests/integration/client.ts` (new `paste`), `packages/flux-import/tests/integration/server.ts` (`startServer` limit), `packages/flux-import/tests/integration/crash.test.ts` (replace the whole file)
- Create: `packages/flux-import/tests/integration/formats.test.ts`

**Interfaces:**
- Consumes: Task 7 fixtures (`productsJson`, `productsJsonl`, `productsXml`, `jsonTemplate`, `xmlTemplate`, `MALFORMED`, `MALFORMED_OUTCOMES`), Task 8 routes; harness `Client` (`upload(body, filename)`, `plugin(route, input)`, `createProducts(slug)`, `listAll`, `runToEnd`, `records`), `ApiError(status, code, message)`, `startServer`, `stopServer`, `devBypass`, `TEST_MAX_SOURCE_BYTES`; `inject("baseUrl")`, `inject("token")`.
- Produces: `Client.paste(format, text): Promise<{ uploadId: string; bytes: number; sha256: string }>`; `startServer(port, dir?, maxSourceBytes = TEST_MAX_SOURCE_BYTES)`.

- [ ] **Step 1: Write the tests and harness changes**

In `packages/flux-import/tests/integration/client.ts`, insert before `async uploadRaw(`:
```ts
	/** Stages pasted text through the `sources/paste` route. */
	paste(format: "csv" | "json" | "jsonl" | "xml", text: string) {
		return this.plugin<{ uploadId: string; bytes: number; sha256: string }>("sources/paste", {
			format,
			text,
		});
	}

```

In `packages/flux-import/tests/integration/server.ts`, replace
```ts
/** Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted). */
export async function startServer(port: number, dir?: string): Promise<DevServer> {
```
with:
```ts
/**
 * Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted), with
 * an upload limit of `maxSourceBytes`.
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
): Promise<DevServer> {
```
and `FLUX_DEV_MAX_SOURCE_BYTES: String(TEST_MAX_SOURCE_BYTES),` with `FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),`.

Create `packages/flux-import/tests/integration/formats.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import {
	jsonTemplate,
	MALFORMED,
	MALFORMED_OUTCOMES,
	productsJson,
	productsJsonl,
	productsXml,
	xmlTemplate,
} from "../fixtures/formats.js";
import { ApiError, Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));

const JSON_PATHS = ["sku", "name", "price.amount", "price.currency", "released", "handle"];
const CASES = [
	{
		name: "JSON at a records path",
		collection: "it_json",
		filename: "feed.json",
		body: productsJson(10, { wrapped: true }),
		template: (c: string) => jsonTemplate(c, { format: "json", records: "data.products" }),
		paths: JSON_PATHS,
	},
	{
		name: "JSON Lines",
		collection: "it_jsonl",
		filename: "feed.ndjson",
		body: productsJsonl(10),
		template: (c: string) => jsonTemplate(c, { format: "jsonl" }),
		paths: JSON_PATHS,
	},
	{
		name: "XML",
		collection: "it_xml",
		filename: "feed.xml",
		body: productsXml(10),
		template: xmlTemplate,
		paths: ["@sku", "title", "title/@lang", "price", "price/@currency", "released", "handle"],
	},
];

describe.each(CASES)("$name end to end (10 records)", (c) => {
	it("uploads, samples, imports and publishes every record", async () => {
		await client.createProducts(c.collection);
		const upload = await client.upload(c.body, c.filename);
		expect(upload.bytes).toBe(Buffer.byteLength(c.body));
		const template = c.template(c.collection);

		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 3,
			source: template.source,
		});
		expect(sample.records).toHaveLength(3);
		expect(sample.paths).toEqual(c.paths);

		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		expect(job).toMatchObject({ status: "created", source: template.source, warnings: [] });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 10, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(c.collection);
		expect(entries).toHaveLength(10);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first).toMatchObject({ slug: "product-0", status: "published", draftRevisionId: null });
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted" & <tagged> ț', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));

		// Typed values survive EmDash's round trip: the same file again changes nothing. The
		// finished job released its staged file, so the file is uploaded again.
		const again = await client.plugin("jobs/create", {
			uploadId: (await client.upload(c.body, c.filename)).uploadId,
			template,
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({ unchanged: 10, updated: 0 });
	});
});

describe.each([
	["JSON", "bad.json", MALFORMED.json, jsonTemplate, "source_syntax"],
	[
		"JSON Lines",
		"bad.jsonl",
		MALFORMED.jsonl,
		(c: string) => jsonTemplate(c, { format: "jsonl" }),
		null,
	],
	["XML", "bad.xml", MALFORMED.xml, xmlTemplate, "source_syntax"],
] as const)("malformed %s", (name, filename, body, template, jobError) => {
	it("logs bad records, keeps the good ones and fails the job only at a structural break", async () => {
		const collection = `it_bad_${name.replace(/\W/g, "").toLowerCase()}`;
		await client.createProducts(collection);
		const { uploadId } = await client.upload(body, filename);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template(collection),
			dryRun: false,
			batchSize: 2,
		});
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 3, failed: 3 });
		expect(done.status).toBe(jobError === null ? "completed" : "failed");
		if (jobError !== null) expect(done.error?.code).toBe(jobError);
		const rows = await client.records(job.id);
		expect(rows.map((r) => [r.status, r.errors?.[0]?.code])).toEqual(MALFORMED_OUTCOMES);
		const keys = (await client.listAll(collection)).map((e) => e.data.flux_source_id).sort();
		expect(keys).toEqual(["M-1", "M-2", "M-6"]);
	});
});

describe("job warnings", () => {
	it("returns and stores a warning for a path no sampled record has", async () => {
		await client.createProducts("it_warn");
		const { uploadId } = await client.upload(productsJson(3), "warn.json");
		const template = jsonTemplate("it_warn");
		template.fields.price.from = "price.value";
		const job = await client.plugin("jobs/create", { uploadId, template, dryRun: true });
		const warning = 'Path "price.value" was not found in the first 3 records';
		expect(job.warnings).toEqual([warning]);
		expect((await client.plugin<Job>("jobs/get", { id: job.id })).warnings).toEqual([warning]);
	});

	it("rejects a records path that is not in the document with INVALID_SOURCE", async () => {
		const { uploadId } = await client.upload(productsJson(1, { wrapped: true }), "x.json");
		const error = await client
			.plugin("jobs/create", {
				uploadId,
				template: jsonTemplate("it_warn", { format: "json", records: "data.items" }),
				dryRun: true,
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 400, code: "INVALID_SOURCE" });
	});
});

describe("pasted snippets", () => {
	it("stages pasted JSON like an upload and imports it", async () => {
		await client.createProducts("it_paste");
		const text = productsJson(3);
		const staged = await client.paste("json", text);
		expect(staged.bytes).toBe(Buffer.byteLength(text));
		expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
		const job = await client.plugin("jobs/create", {
			uploadId: staged.uploadId,
			template: jsonTemplate("it_paste"),
			dryRun: false,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		expect(await client.listAll("it_paste")).toHaveLength(3);
	});

	it("rejects empty text and a request over 1 MiB", async () => {
		await expect(client.paste("csv", "")).rejects.toMatchObject({
			status: 400,
			code: "EMPTY_BODY",
		});
		await expect(client.paste("csv", "a".repeat(1024 * 1024))).rejects.toMatchObject({
			status: 413,
		});
	});
});
```

Replace `packages/flux-import/tests/integration/crash.test.ts` with (the CSV test is unchanged apart from being one case of `describe.each`; the JSON case needs the larger upload limit, F5):
```ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { jsonTemplate, productsJson } from "../fixtures/formats.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4398;
const ROWS = 10_000;
/** The 10,000-record JSON fixture is about 1.6 MB, over the shared server's 1 MB limit. */
const MAX_SOURCE_BYTES = 4_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir, MAX_SOURCE_BYTES);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	server = await startServer(PORT, undefined, MAX_SOURCE_BYTES);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_crash");
	await client.createProducts("it_crash_json");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

describe.each([
	["CSV", "it_crash", "products.csv", productsCsv(ROWS), template("it_crash")],
	["JSON", "it_crash_json", "products.json", productsJson(ROWS), jsonTemplate("it_crash_json")],
])("kill and resume (%s)", (_format, collection, filename, body, jobTemplate) => {
	it("leaves no duplicates and reports any entry a crash left unpublished", async () => {
		const sourceBytes = Buffer.byteLength(body);
		const { uploadId } = await client.upload(body, filename);
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: jobTemplate,
			dryRun: false,
			batchSize: 500,
			budgetMs: 2_000,
		});
		let writing = 0;
		let interrupted = 0;
		let killed: Job | undefined;
		for (const delay of [300, 700]) {
			await client.plugin("jobs/next", { id: created.id });
			const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
			await sleep(delay);
			await stopServer(server, "SIGKILL");
			// null: the kill cut the request off before it answered.
			if ((await inFlight) === null) interrupted++;
			await restart();
			writing += (await client.records(created.id, "writing")).length;
			killed = await waitForLease(created.id);
		}
		// Diagnostic only: SIGKILL timing decides whether a write was caught mid-record.
		console.info(`records left writing by the kills: ${writing}`);

		// The kills must have landed mid-batch and mid-job, or this test proves nothing about resuming.
		if (interrupted !== 2) {
			throw new Error(`Only ${interrupted} of 2 kills cut off a jobs/next call in flight`);
		}
		const cursor = (killed as Job).cursor;
		console.info(
			`cursor after the kills: offset ${cursor.offset} of ${sourceBytes} bytes, seq ${cursor.seq} of ${ROWS} rows`,
		);
		if (
			!(cursor.offset > 0 && cursor.offset < sourceBytes && cursor.seq > 0 && cursor.seq < ROWS)
		) {
			throw new Error(
				`The kills did not land mid-job: cursor ${JSON.stringify(cursor)} for ${sourceBytes} bytes and ${ROWS} rows`,
			);
		}
		expect((killed as Job).status).toBe("running");

		const done = await client.runToEnd(created.id);
		expect(done.status).toBe("completed");
		const total = Object.values(done.counters).reduce((a, b) => a + b, 0);
		expect(total).toBe(ROWS);
		expect(done.counters.failed).toBe(0);
		expect(await client.records(created.id, "writing")).toEqual([]);

		const entries = await client.listAll(collection);
		expect(entries).toHaveLength(ROWS);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(ROWS);

		// Relaxed criterion: an entry a crash left unpublished is reported, never silently dropped.
		// Conflicts here can only be crash leftovers, so each one must be publish_unverified, and
		// they must be exactly the entries still waiting to be published.
		const conflicts = await client.records(created.id, "conflict");
		expect(conflicts.every((r) => r.errors?.[0]?.code === "publish_unverified")).toBe(true);
		const unverified = new Set(conflicts.map((r) => r.entryId));
		expect(unverified.size).toBe(conflicts.length);
		expect(done.counters.conflict).toBe(unverified.size);
		const unpublished = new Set(entries.filter((e) => e.status !== "published").map((e) => e.id));
		expect(unpublished).toEqual(unverified);
		console.info(`entries left unpublished and reported publish_unverified: ${unverified.size}`);
	});
});
```

- [ ] **Step 2: Run the new and changed suites**

Run: `pnpm --filter flux-import exec vitest run --config vitest.integration.config.ts tests/integration/formats.test.ts tests/integration/crash.test.ts --silent=false --reporter=verbose`
Expected: PASS — `formats.test.ts` 10 tests (about 30 s plus server start), `crash.test.ts` 2 tests (about 115 s for CSV and 125 s for JSON). The diagnostics print records left `writing` by the kills and the cursor after them for each format; the JSON cursor must sit mid-file (the test throws otherwise). If a kill misses its in-flight batch on a fast machine, re-run once before investigating (the test is timing-based, M2 review open issue 3).

- [ ] **Step 3: Run the whole integration suite**

Run: `pnpm test:integration`
Expected: PASS (6 files / 29 tests, about 7 minutes). Then `pnpm typecheck && pnpm lint && pnpm test`. `git status` must show only this task's files: the global setup restores `sites/dev/emdash-env.d.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/flux-import/tests/integration
git commit -m "Prove JSON, JSON Lines, XML and pasted imports end to end, and JSON kill-and-resume"
```

### Task 10: workerd parity: one JSON import and a paste on `sites/dev-cf`

**Files:**
- Modify: `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: Task 7 fixtures (`productsJson`, `jsonTemplate`), Task 9 `Client.paste`; parity harness (`client`, `inject("cfBaseUrl")`).
- Produces: one parity test; no code.

- [ ] **Step 1: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, add `import { jsonTemplate, productsJson } from "../fixtures/formats.js";` before the `../integration/client.js` import, and insert before `it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", …)`:
```ts
	it("imports 10 JSON records at a records path, and a pasted snippet staged to R2", async () => {
		await client.createProducts("cf_json");
		const { uploadId } = await client.upload(productsJson(10, { wrapped: true }), "feed.json");
		const template = jsonTemplate("cf_json", { format: "json", records: "data.products" });
		const sample = await client.plugin<{ records: unknown[] }>("sources/sample", {
			uploadId,
			n: 2,
			source: template.source,
		});
		expect(sample.records).toHaveLength(2);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template,
			dryRun: false,
			batchSize: 4,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });

		// Paste stages through FixedLengthStream into R2 (workerd only); same keys update nothing.
		const pasted = await client.paste("json", productsJson(3));
		const again = await client.plugin("jobs/create", {
			uploadId: pasted.uploadId,
			template: jsonTemplate("cf_json"),
			dryRun: false,
		});
		expect((await client.runToEnd(again.id)).counters).toMatchObject({ unchanged: 3, failed: 0 });
		const entries = await client.listAll("cf_json");
		expect(entries).toHaveLength(10);
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});
```

- [ ] **Step 2: Run the new test on workerd**

Run: `pnpm --filter flux-import exec vitest run --config vitest.cf.config.ts -t JSON --reporter=verbose`
Expected: PASS (1 test, about 12 s plus server start; the other three are skipped). This proves the JSON reader on R2 ranged reads and `stagePaste` through `FixedLengthStream` into R2 (F4).

- [ ] **Step 3: Run the whole Cloudflare suite**

Run: `pnpm test:cf`
Expected: PASS (4 tests, about 15 minutes). Then `pnpm typecheck && pnpm lint && pnpm test`; `git status` shows only the test file (`.wrangler/state` is ignored).

- [ ] **Step 4: Commit**

```bash
git add packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove a JSON import and a pasted snippet on workerd with D1 and R2"
```

### Task 11: M3a review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-12-m3a-review.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass. Copy the summary lines (files, tests, durations) and the kill-and-resume diagnostics for both formats into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`), with a PAT, record each result:
1. Upload `feed.json` (5 products wrapped under `data.products`), call `sources/sample` with `source: { format: "json", records: "data.products" }`: `records` and `paths` match the file.
2. `jobs/create` into `posts` with a template whose `excerpt` maps a path the file lacks: the job's `warnings` names it; a dry run plans 5 creates.
3. `sources/paste` with a 3-item XML snippet and `records: "feed/item"`: a real run creates 3 posts.
4. Upload an XML file with `<!DOCTYPE feed SYSTEM "x.dtd">`: `jobs/create` answers 400 `INVALID_SOURCE` with `xml_dtd_not_allowed` in `details`.
5. Restore `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-12-m3a-review.md` from this template and fill in every `…`:
````markdown
# Milestone 3a review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Automated checks

| Command | Result | Summary (files / tests / duration) |
| --- | --- | --- |
| `pnpm typecheck` | … | … |
| `pnpm lint` | … | … |
| `pnpm test` | … | … |
| `pnpm test:integration` | … | … |
| `pnpm test:cf` | … | … |

Diagnostics: kill-and-resume CSV: … records left `writing`, cursor …; JSON: … records left `writing`, cursor ….

## Spec "Testing" coverage

| Item | Evidence | Result |
| --- | --- | --- |
| Scanner invariants (chunking, resume, BOM, multibyte, escapes, nesting, skipping keys, error split, cap, XML specifics) | `reader`, `json`, `xml` unit tests | … |
| Path resolution, typed conversion, CSV unchanged, warnings | `paths`, `template`, `jobs`, `formats` unit tests | … |
| Fixtures 10 / 10,000 / malformed per format | `formats` unit tests, `formats` integration tests | … |
| End to end per format and paste; kill-and-resume on 10,000 JSON records | `formats.test.ts`, `crash.test.ts` | … |
| One JSON import on workerd | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | JSON sample at a records path | … | … |
| 2 | Warning for a missing path | … | … |
| 3 | Pasted XML import | … | … |
| 4 | DTD rejected at creation | … | … |
| 5 | Working tree clean | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-12-m3a-review.md
git commit -m "Add the Milestone 3a review results"
```

---

## After this plan

M3a ends here with the review stop. M3b builds on `resolvePath` and `RecordReader` (JSONPath/XPath selection, row filters, JSONata transforms); M3c adds URL sources behind the same `SourcePort`; M3d adds XLSX with a row-index cursor. The M2 open issues (`docs/superpowers/notes/2026-10-08-m2-review.md`) are unchanged by this plan: workerd throughput and the D1 query budget (`WORKERS_BATCH_CAP`) apply to every format alike, and `stagePaste` reuses `stageUpload`, whose early-failure clean-up gap (open issue 3) does not arise for an in-memory body.
