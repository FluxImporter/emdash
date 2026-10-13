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
