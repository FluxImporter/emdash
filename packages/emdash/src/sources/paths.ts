import type { SourceFormat } from "./reader.js";
import { XML_NAME } from "./xml-record.js";

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

/**
 * Why `path` is not a valid field path for `format`, or null. CSV and XLSX: a column name.
 * JSON: dot-separated keys, none empty. XML: `/`-separated element names, optionally ending in
 * `@attribute` or `#text`.
 */
export function pathProblem(path: string, format: SourceFormat): string | null {
	if (isFlat(format)) return path === "" ? "The column name is empty" : null;
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
 * Reads a field value from a record. CSV and XLSX: the column's cell. JSON: walks own object keys. XML:
 * walks child elements and `@attributes`; an element without child elements reads as its text.
 * Walking stops at an array, which is the result (M3a has no array indexes). Returns
 * `undefined` when the path does not exist; JSON `null` stays `null`.
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

/** Deepest segment count `collectPaths` descends to; a path at this depth is a leaf. */
export const PATHS_MAX_DEPTH = 32;
/** Most distinct paths `collectPaths` returns. */
export const PATHS_MAX_COUNT = 1000;

/**
 * The distinct field paths in sampled records, in first-seen order, for the mapper. Nested
 * objects are walked; arrays and scalars are leaves. JSON keys containing "." cannot be
 * addressed and are left out. XML lists `@attributes`, text elements, and `#text` is implied.
 * The walk stops descending at `PATHS_MAX_DEPTH` segments and stops at `PATHS_MAX_COUNT` paths.
 */
export function collectPaths(records: unknown[], format: "json" | "xml"): string[] {
	const found = new Set<string>();
	const sep = format === "xml" ? "/" : ".";
	const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
		for (const [key, v] of Object.entries(obj)) {
			if (found.size >= PATHS_MAX_COUNT) return;
			if (key === "#text" || (format === "json" && key.includes("."))) continue;
			const path = prefix === "" ? key : `${prefix}${sep}${key}`;
			if (!isPlainObject(v) || depth + 1 >= PATHS_MAX_DEPTH) {
				found.add(path);
				continue;
			}
			if (format === "xml" && isTextElement(v)) found.add(path);
			walk(v, path, depth + 1);
		}
	};
	for (const record of records) {
		if (found.size >= PATHS_MAX_COUNT) break;
		if (isPlainObject(record)) walk(record, "", 0);
	}
	return [...found];
}
