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

export async function buildLogCsv(
	deps: EngineDeps,
	jobId: string,
	opts: { status?: RecordStatus } = {},
): Promise<string> {
	let out = `${LOG_COLUMNS.join(",")}\r\n`;
	const where = opts.status ? { jobId, status: opts.status } : { jobId };
	let cursor: string | undefined;
	do {
		const page = await deps.records.query({
			where,
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		out += recordsToCsvLines(page.items.map((i) => i.data));
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return out;
}
