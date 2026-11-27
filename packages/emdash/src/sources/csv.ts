const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];

/**
 * The largest record (a row with its quoted newlines) the reader accepts. It bounds memory per
 * record, which matters in a 128 MB Workers isolate; a larger record makes the file unreadable.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export class CsvSyntaxError extends Error {
	constructor(
		message: string,
		readonly offset: number,
	) {
		super(message);
		this.name = "CsvSyntaxError";
	}
}

export interface CsvRow {
	fields: string[];
	start: number;
	end: number;
}

class ByteBuffer {
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

	take(decoder: TextDecoder): string {
		const s = decoder.decode(this.buf.subarray(0, this.length));
		this.length = 0;
		return s;
	}
}

type State = "start" | "unquoted" | "quoted" | "quoteInQuoted";

export async function* parseCsvRows(
	stream: ReadableStream<Uint8Array>,
	startOffset = 0,
): AsyncGenerator<CsvRow> {
	const decoder = new TextDecoder("utf-8");
	const field = new ByteBuffer();
	let fields: string[] = [];
	let state: State = "start";
	let rowStart = startOffset;
	let rowHasContent = false;

	const endField = () => {
		fields.push(field.take(decoder));
	};

	const endRow = (end: number): CsvRow | null => {
		endField();
		const row = rowHasContent ? { fields, start: rowStart, end } : null;
		fields = [];
		rowStart = end;
		rowHasContent = false;
		state = "start";
		return row;
	};

	const feed = (b: number, p: number): CsvRow | null => {
		if (state === "quoted") {
			if (b === QUOTE) state = "quoteInQuoted";
			else field.push(b);
			return null;
		}
		if (state === "quoteInQuoted" && b === QUOTE) {
			field.push(QUOTE);
			state = "quoted";
			return null;
		}
		if (state === "start" && b === QUOTE) {
			state = "quoted";
			rowHasContent = true;
			return null;
		}
		if (b === COMMA) {
			endField();
			state = "start";
			rowHasContent = true;
			return null;
		}
		if (b === LF) return endRow(p + 1);
		if (b === CR) return null;
		field.push(b);
		state = "unquoted";
		rowHasContent = true;
		return null;
	};

	const reader = stream.getReader();
	const head: number[] = [];
	let pos = startOffset;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const b of value) {
				const p = pos++;
				if (startOffset === 0 && p < 3) {
					head.push(b);
					if (head.length < 3) continue;
					if (head.every((x, i) => x === BOM[i])) {
						rowStart = 3;
						continue;
					}
					for (let i = 0; i < head.length; i++) {
						const row = feed(head[i] as number, i);
						if (row) yield row;
					}
					continue;
				}
				if (p - rowStart >= MAX_RECORD_BYTES) {
					throw new CsvSyntaxError(`A record is larger than ${MAX_RECORD_BYTES} bytes`, rowStart);
				}
				const row = feed(b, p);
				if (row) yield row;
			}
		}
		if (head.length > 0 && head.length < 3) {
			for (let i = 0; i < head.length; i++) {
				const row = feed(head[i] as number, i);
				if (row) yield row;
			}
		}
		if (state !== "start" && state !== "unquoted" && state !== "quoteInQuoted") {
			throw new CsvSyntaxError("Unterminated quoted field", rowStart);
		}
		const last = endRow(pos);
		if (last) yield last;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export interface CsvHeader {
	headers: string[];
	bodyOffset: number;
}

export function normalizeHeaders(raw: string[]): string[] {
	const seen = new Set<string>();
	return raw.map((h, i) => {
		const trimmed = h.trim();
		const name = trimmed === "" ? `column_${i + 1}` : trimmed;
		if (seen.has(name)) throw new CsvSyntaxError(`Duplicate header "${name}"`, 0);
		seen.add(name);
		return name;
	});
}

export async function readCsvHeader(stream: ReadableStream<Uint8Array>): Promise<CsvHeader> {
	for await (const row of parseCsvRows(stream, 0)) {
		return { headers: normalizeHeaders(row.fields), bodyOffset: row.end };
	}
	throw new CsvSyntaxError("CSV has no header row", 0);
}

export interface CsvSample {
	headers: string[];
	rows: string[][];
}

/** Reads the header and up to `n` rows, without validating column counts. */
export async function readCsvSample(
	stream: ReadableStream<Uint8Array>,
	n: number,
): Promise<CsvSample> {
	let headers: string[] | null = null;
	const rows: string[][] = [];
	for await (const row of parseCsvRows(stream, 0)) {
		if (headers === null) headers = normalizeHeaders(row.fields);
		else rows.push(row.fields);
		if (rows.length >= n) break;
	}
	if (headers === null) throw new CsvSyntaxError("CSV has no header row", 0);
	return { headers, rows };
}

export interface CsvRecord {
	seq: number;
	start: number;
	end: number;
	values: Record<string, string>;
	error?: "column_count";
}

export async function* readCsvRecords(
	stream: ReadableStream<Uint8Array>,
	opts: { headers: string[]; startOffset: number; startSeq: number },
): AsyncGenerator<CsvRecord> {
	let seq = opts.startSeq;
	for await (const row of parseCsvRows(stream, opts.startOffset)) {
		// fromEntries defines own properties, so a "__proto__" header stays plain data.
		const values = Object.fromEntries(opts.headers.map((h, i) => [h, row.fields[i] ?? ""]));
		const record: CsvRecord = { seq, start: row.start, end: row.end, values };
		if (row.fields.length !== opts.headers.length) record.error = "column_count";
		yield record;
		seq++;
	}
}

export function dropBytes(
	stream: ReadableStream<Uint8Array>,
	n: number,
): ReadableStream<Uint8Array> {
	let remaining = n;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (remaining >= chunk.length) {
					remaining -= chunk.length;
					return;
				}
				controller.enqueue(remaining > 0 ? chunk.subarray(remaining) : chunk);
				remaining = 0;
			},
		}),
	);
}
