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

/** A `source_syntax` error (malformed JSON, JSON Lines or XML) at a byte offset. */
export function syntaxError(message: string, offset: number): SourceError {
	return new SourceError("source_syntax", message, offset);
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

/**
 * The generic `sample()` for readers whose `read` at offset 0 locates first: reads the stream
 * from the start, takes up to `n` records and derives the field paths with `pathsOf`.
 */
export async function sampleByRead(
	reader: Pick<RecordReader, "read">,
	stream: ReadableStream<Uint8Array>,
	n: number,
	pathsOf: (records: unknown[]) => string[],
): Promise<ValueSample> {
	const records = await takeSample(reader.read(stream, { startOffset: 0, startSeq: 0 }), n);
	return { records, paths: pathsOf(records) };
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
