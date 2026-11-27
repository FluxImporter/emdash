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
