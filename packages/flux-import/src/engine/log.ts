import type { EngineDeps, RecordRow, RecordStatus } from "./types.js";

/**
 * The log's columns. `record` is the source record's number (seq + 1): on a rollback job's rows
 * the number of the import record it reverts. M5c: a row of the missing phase reads no record,
 * so its `record` cell is empty (spec Ruling 36).
 */
export const LOG_COLUMNS = [
	"record",
	"status",
	"source_key",
	"entry_id",
	"action",
	"error_code",
	"error_field",
	"message",
	"warnings",
] as const;

const PAGE = 100;

export function csvCell(value: unknown): string {
	let s = value === null || value === undefined ? "" : String(value);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
	return s;
}

/** `missingFrom`: the job's `missing.fromSeq`; rows from it on are the missing phase's. */
export function recordsToCsvLines(rows: RecordRow[], missingFrom?: number): string {
	return rows
		.map((r) => {
			const first = r.errors?.[0];
			return [
				missingFrom !== undefined && r.seq >= missingFrom ? null : r.seq + 1,
				r.status,
				r.sourceKey,
				r.entryId,
				r.action,
				first?.code,
				first?.field,
				r.errors?.map((e) => e.message).join("; "),
				r.warnings
					?.map((w) => [w.field, w.code, w.message].filter((part) => part !== undefined).join(": "))
					.join("; "),
			]
				.map(csvCell)
				.join(",");
		})
		.map((line) => `${line}\r\n`)
		.join("");
}

export class LogTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(`The log is larger than ${maxBytes} bytes`);
		this.name = "LogTooLargeError";
	}
}

/**
 * Builds the job's log CSV. With `maxBytes`, counts UTF-8 bytes as each page is appended and
 * throws `LogTooLargeError` as soon as the log exceeds it, without reading further pages.
 */
export async function buildLogCsv(
	deps: EngineDeps,
	jobId: string,
	opts: { status?: RecordStatus; maxBytes?: number; missingFrom?: number } = {},
): Promise<string> {
	const encoder = new TextEncoder();
	const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
	let out = `${LOG_COLUMNS.join(",")}\r\n`;
	let bytes = encoder.encode(out).byteLength;
	const where = opts.status ? { jobId, status: opts.status } : { jobId };
	let cursor: string | undefined;
	do {
		const page = await deps.records.query({
			where,
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		const lines = recordsToCsvLines(
			page.items.map((i) => i.data),
			opts.missingFrom,
		);
		bytes += encoder.encode(lines).byteLength;
		if (bytes > max) throw new LogTooLargeError(max);
		out += lines;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return out;
}
