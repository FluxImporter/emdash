import type { EngineDeps, RecordRow, RecordStatus } from "./types.js";

export const LOG_COLUMNS = [
	"record",
	"status",
	"source_key",
	"entry_id",
	"action",
	"error_code",
	"error_field",
	"message",
] as const;

const PAGE = 100;

export function csvCell(value: unknown): string {
	let s = value === null || value === undefined ? "" : String(value);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
	return s;
}

export function recordsToCsvLines(rows: RecordRow[]): string {
	return rows
		.map((r) => {
			const first = r.errors?.[0];
			return [
				r.seq + 1,
				r.status,
				r.sourceKey,
				r.entryId,
				r.action,
				first?.code,
				first?.field,
				r.errors?.map((e) => e.message).join("; "),
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
	opts: { status?: RecordStatus; maxBytes?: number } = {},
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
		const lines = recordsToCsvLines(page.items.map((i) => i.data));
		bytes += encoder.encode(lines).byteLength;
		if (bytes > max) throw new LogTooLargeError(max);
		out += lines;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return out;
}
