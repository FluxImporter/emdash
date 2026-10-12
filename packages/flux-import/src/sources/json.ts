import { collectPaths } from "./paths.js";
import {
	ByteBuffer,
	type ByteScanner,
	decodeUtf8,
	drainRecords,
	isJsonSpace,
	MAX_NESTING,
	MAX_RECORD_BYTES,
	type RecordReader,
	runScanner,
	SourceError,
	type SourceRecord,
	sampleByRead,
	syntaxError,
} from "./reader.js";

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

function describe(b: number): string {
	if (b === OPEN_OBJECT) return "an object";
	if (b === OPEN_ARRAY) return "an array";
	if (b === QUOTE) return "a string";
	if (b === 0x74 || b === 0x66) return "a boolean";
	if (b === 0x6e) return "null";
	return "a number";
}

/** 16 digits in a row: the text may hold an integer beyond 2^53 that `JSON.parse` would round. */
const LONG_DIGITS = /\d{16}/;

class UnsafeIntegerError extends Error {}

/**
 * A `JSON.parse` reviver that keeps an integer beyond 2^53 as its source text, so distinct IDs
 * stay distinct. Without the reviver's source text (older runtimes) the record fails instead.
 */
function keepUnsafeIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
	if (typeof value !== "number" || !Number.isInteger(value) || Number.isSafeInteger(value)) {
		return value;
	}
	if (context?.source === undefined) {
		throw new UnsafeIntegerError("Integer too large to import exactly");
	}
	return context.source;
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
		return {
			value: LONG_DIGITS.test(text) ? JSON.parse(text, keepUnsafeIntegers) : JSON.parse(text),
		};
	} catch (e) {
		if (e instanceof UnsafeIntegerError) {
			return { value: null, error: { code: "invalid_record", message: e.message } };
		}
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

	/** Opens a container; nesting deeper than `MAX_NESTING` fails the job at the opener. */
	private open(closer: number, pos: number): void {
		if (this.closers.length >= MAX_NESTING) {
			throw syntaxError(`Nesting is deeper than ${MAX_NESTING} levels`, pos);
		}
		this.closers.push(closer);
	}

	/** "more": `b` belongs to the value; "done": `b` ends it; "before": it ended before `b`. */
	step(b: number, pos: number): "more" | "done" | "before" {
		if (!this.started) {
			this.started = true;
			if (b === QUOTE) this.inString = true;
			else if (b === OPEN_OBJECT) this.open(CLOSE_OBJECT, pos);
			else if (b === OPEN_ARRAY) this.open(CLOSE_ARRAY, pos);
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
			// Quotes, openers and colons cannot continue a scalar; ending it here lets the next
			// state reject them instead of losing track of strings and brackets.
			const ends =
				isJsonSpace(b) ||
				b === COMMA ||
				b === COLON ||
				b === QUOTE ||
				b === OPEN_ARRAY ||
				b === OPEN_OBJECT ||
				b === CLOSE_ARRAY ||
				b === CLOSE_OBJECT;
			return ends ? "before" : "more";
		}
		if (b === QUOTE) this.inString = true;
		else if (b === OPEN_OBJECT) this.open(CLOSE_OBJECT, pos);
		else if (b === OPEN_ARRAY) this.open(CLOSE_ARRAY, pos);
		else if (b === CLOSE_OBJECT || b === CLOSE_ARRAY) {
			if (this.closers.pop() !== b) {
				throw syntaxError(`Unexpected "${String.fromCharCode(b)}"`, pos);
			}
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
	private readonly out: SourceRecord[] = [];
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
		return drainRecords(this.out);
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
			throw syntaxError(`Unexpected "${String.fromCharCode(b)}"`, pos);
		}
		this.extent.reset();
		this.start = pos;
		this.mode = "inValue";
		this.inValue(b, pos);
	}

	private inValue(b: number, pos: number): void {
		if (pos - this.start >= MAX_RECORD_BYTES) {
			throw syntaxError(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.start);
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
				throw syntaxError("Expected a key", pos);
			case "inKey":
				if (pos - this.keyStart >= MAX_RECORD_BYTES) {
					throw syntaxError("A key is too long", this.keyStart);
				}
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
				if (b !== COLON) throw syntaxError('Expected ":"', pos);
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
					throw syntaxError(`Unexpected "${String.fromCharCode(b)}"`, pos);
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
				else throw syntaxError('Expected "," or "}"', pos);
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
				else throw syntaxError('Expected "," or "]" after a record', pos);
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
		throw syntaxError("Invalid key", this.keyStart);
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
				throw syntaxError("Unterminated record", this.start);
			case "resume":
			case "expectValue":
			case "afterValue":
				throw syntaxError("Unterminated array", end);
			default:
				throw syntaxError("Unexpected end of input", end);
		}
	}
}

/** JSON: the top-level array, or the array at the dot path `records`. */
export function jsonReader(records?: string): RecordReader {
	const path = records === undefined ? [] : records.split(".");
	const reader: RecordReader = {
		async locate(stream) {
			const scanner = new JsonScanner(path, 0, 0, true);
			for await (const _ of runScanner(stream, 0, scanner)) {
				// locating emits no records
			}
			return { bodyOffset: scanner.bodyOffset };
		},
		read: (stream, { startOffset, startSeq }) =>
			runScanner(stream, startOffset, new JsonScanner(path, startOffset, startSeq, false)),
		sample: (stream, n) => sampleByRead(reader, stream, n, (r) => collectPaths(r, "json")),
	};
	return reader;
}

/** Splits lines (LF; a CR before it is JSON whitespace) and parses each non-blank one. */
class LineScanner implements ByteScanner {
	private readonly buf = new ByteBuffer();
	private start = -1;
	private blank = true;
	private seq: number;
	private readonly out: SourceRecord[] = [];
	readonly done = false;

	constructor(startSeq: number) {
		this.seq = startSeq;
	}

	drain(): SourceRecord[] {
		return drainRecords(this.out);
	}

	step(b: number, pos: number): void {
		if (this.start < 0) this.start = pos;
		if (b === 0x0a) {
			this.endLine(pos + 1);
			return;
		}
		if (pos - this.start >= MAX_RECORD_BYTES) {
			throw syntaxError(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.start);
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
	const reader: RecordReader = {
		async locate(stream) {
			// Only the BOM (skipped by `positioned`) can come before the first line.
			for await (const rec of runScanner(stream, 0, new LineScanner(0))) {
				return { bodyOffset: rec.start };
			}
			return { bodyOffset: 0 };
		},
		read: (stream, { startOffset, startSeq }) =>
			runScanner(stream, startOffset, new LineScanner(startSeq)),
		sample: (stream, n) => sampleByRead(reader, stream, n, (r) => collectPaths(r, "json")),
	};
	return reader;
}
