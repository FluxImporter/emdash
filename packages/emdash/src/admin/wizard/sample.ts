import type { SourceFormat } from "../../sources/reader.js";
import type { SampleColumn } from "../types.js";

/*
 * `resolvePath` and its helpers, copied from `src/sources/paths.ts` (plan Ruling 8, preflight
 * F23): the admin module cannot import server code at runtime. `tests/unit/admin-sample.test.ts`
 * checks that both agree.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function segments(path: string, format: SourceFormat): string[] {
	return format === "xml" ? path.split("/") : path.split(".");
}

/** CSV and XLSX records are flat: a path is a column (header) name, dots and all. */
function isFlat(format: SourceFormat): boolean {
	return format === "csv" || format === "xlsx";
}

/** An XML element object without child elements: only `@attributes` and `#text`. */
function isTextElement(v: Record<string, unknown>): boolean {
	return Object.keys(v).every((k) => k === "#text" || k.startsWith("@"));
}

/**
 * Reads a field value from a record. CSV and XLSX: the column's cell. JSON: walks own object keys. XML:
 * walks child elements and `@attributes`; an element without child elements reads as its text.
 * Walking stops at an array, which is the result. Returns `undefined` when the path does not
 * exist; JSON `null` stays `null`.
 */
export function resolvePath(value: unknown, path: string, format: SourceFormat): unknown {
	if (isFlat(format)) {
		return isPlainObject(value) && Object.hasOwn(value, path) ? value[path] : undefined;
	}
	let current: unknown = value;
	const parts = segments(path, format);
	for (const [i, part] of parts.entries()) {
		if (Array.isArray(current)) return current;
		// An element with only text collapses to a string; its `#text` is that string.
		if (format === "xml" && typeof current === "string" && part === "#text") {
			return i === parts.length - 1 ? current : undefined;
		}
		if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined;
		current = current[part];
	}
	if (format === "xml" && isPlainObject(current) && isTextElement(current)) {
		return current["#text"] ?? "";
	}
	return current;
}

/** What `sources/sample` answers: CSV and XLSX headers and rows, or records and their paths. */
export type SampleReply =
	| { headers: string[]; rows: string[][] }
	| { records: unknown[]; paths: string[] };

/**
 * One column per sampled key, each holding one value per sampled record (`undefined` where a CSV
 * row is short or a path does not resolve).
 */
export function sampleColumns(sample: SampleReply, format: SourceFormat): SampleColumn[] {
	if ("headers" in sample) {
		return sample.headers.map((key, i) => ({
			key,
			values: sample.rows.map((row) => (i < row.length ? row[i] : undefined)),
		}));
	}
	return sample.paths.map((key) => ({
		key,
		values: sample.records.map((record) => resolvePath(record, key, format)),
	}));
}
