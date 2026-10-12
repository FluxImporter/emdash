import { DateTime } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import { CSV_SOURCE, SOURCE_FORMATS, type SourceFormat } from "../sources/reader.js";

export const SOURCE_ID_FIELD = "flux_source_id";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

const column = z.string().min(1);
const timezone = z
	.string()
	.min(1)
	.refine((tz) => DateTime.now().setZone(tz).isValid, { message: "Unknown timezone" });

const fieldMapping = z.discriminatedUnion("type", [
	z.object({ from: column, type: z.literal("text") }).strict(),
	z.object({ from: column, type: z.literal("number") }).strict(),
	z
		.object({
			from: column,
			type: z.literal("date"),
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
		})
		.strict(),
]);

/**
 * The template's `source` block. Which formats take `records` is checked by `checkSource`
 * (sources/readers.ts), so a misplaced `records` is reported as `invalid_source`.
 */
export const sourceSchema = z
	.object({
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
	})
	.strict();

export const templateSchema = z
	.object({
		version: z.literal(1),
		source: sourceSchema.default(() => ({ ...CSV_SOURCE })),
		collection: z.string().regex(SLUG_RE),
		locale: z.string().min(1),
		key: z.object({ from: column }).strict(),
		slug: z.object({ from: column }).strict().optional(),
		fields: z.record(z.string(), fieldMapping).superRefine((fields, ctx) => {
			const names = Object.keys(fields);
			if (names.length === 0) ctx.addIssue({ code: "custom", message: "Map at least one field" });
			for (const name of names) {
				if (!SLUG_RE.test(name)) {
					ctx.addIssue({ code: "custom", message: `Invalid field name "${name}"`, path: [name] });
				}
				if (name === SOURCE_ID_FIELD) {
					ctx.addIssue({
						code: "custom",
						message: `"${SOURCE_ID_FIELD}" is reserved`,
						path: [name],
					});
				}
			}
		}),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
type FieldMapping = Template["fields"][string];

export type FieldValue = string | number | null;
export type MappedRecord = { key: string; slug?: string; data: Record<string, FieldValue> };
export type ValueErrorCode =
	| "not_scalar"
	| "missing_key"
	| "key_too_long"
	| "invalid_number"
	| "invalid_date"
	| "empty_slug";
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, "");
}

type Converted =
	| { ok: true; value: FieldValue }
	| { ok: false; code: ValueErrorCode; message: string };

const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";

/** A source value as text (numbers and booleans as their string), or null for an object or array. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

function convertText(mapping: FieldMapping, raw: string): Converted {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, value: null };
	switch (mapping.type) {
		case "text":
			return { ok: true, value: raw };
		case "number": {
			if (!NUMBER_RE.test(trimmed)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			const n = Number(trimmed);
			if (!Number.isFinite(n)) {
				return { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
			}
			return { ok: true, value: n };
		}
		case "date": {
			const dt = mapping.format
				? DateTime.fromFormat(trimmed, mapping.format, { zone: mapping.tz })
				: DateTime.fromISO(trimmed, { zone: mapping.tz });
			if (!dt.isValid) {
				const expected = mapping.format ?? "ISO 8601";
				return {
					ok: false,
					code: "invalid_date",
					message: `"${trimmed}" is not a ${expected} date`,
				};
			}
			return { ok: true, value: dt.toUTC().toISO() };
		}
	}
}

/**
 * Converts a typed source value. A JSON number goes into a number field as it is; numbers and
 * booleans become their string for text and date fields; `true`/`false` are not numbers; an
 * object or array fails with `not_scalar`; a missing path or `null` is `null`.
 */
function convert(mapping: FieldMapping, raw: unknown): Converted {
	if (mapping.type === "number" && typeof raw === "number") {
		return Number.isFinite(raw)
			? { ok: true, value: raw }
			: { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	if (mapping.type === "number" && typeof raw === "boolean") {
		return { ok: false, code: "invalid_number", message: `${raw} is not a number` };
	}
	const text = scalarText(raw);
	if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
	return convertText(mapping, text);
}

/** Applies the template to one record value (a CSV row object, a JSON value, an XML object). */
export function applyTemplate(
	t: Template,
	value: unknown,
): { ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] } {
	const errors: ValueError[] = [];
	const read = (path: string) => resolvePath(value, path, t.source.format);

	const keyText = scalarText(read(t.key.from));
	const key = keyText?.trim() ?? "";
	if (keyText === null) {
		errors.push({ field: t.key.from, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
	} else if (key === "") {
		errors.push({ field: t.key.from, code: "missing_key", message: "The key column is empty" });
	} else if (key.length > MAX_KEY_LENGTH) {
		errors.push({
			field: t.key.from,
			code: "key_too_long",
			message: `Keys are limited to ${MAX_KEY_LENGTH} characters`,
		});
	}

	let slug: string | undefined;
	if (t.slug) {
		const slugText = scalarText(read(t.slug.from));
		if (slugText === null) {
			errors.push({ field: "slug", code: "not_scalar", message: NOT_SCALAR_MESSAGE });
		} else {
			slug = slugify(slugText);
			if (slug === "") {
				errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
			}
		}
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const result = convert(mapping, read(mapping.from));
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}

/** Every source path the template reads: key, slug and field `from`s, without duplicates. */
export function templatePaths(t: Template): string[] {
	return [
		...new Set([
			t.key.from,
			...(t.slug ? [t.slug.from] : []),
			...Object.values(t.fields).map((m) => m.from),
		]),
	];
}

/**
 * Warnings for JSON, JSON Lines and XML paths that resolve in none of the sampled record values.
 * An empty sample proves nothing, so it gives none. CSV columns are checked against the header
 * by `checkTemplate` instead.
 */
export function missingPathWarnings(t: Template, sample: unknown[]): string[] {
	if (t.source.format === "csv" || sample.length === 0) return [];
	return templatePaths(t)
		.filter((path) => !sample.some((v) => resolvePath(v, path, t.source.format) !== undefined))
		.map((path) => `Path "${path}" was not found in the first ${sample.length} records`);
}

export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<FieldMapping["type"], string[]> = {
	text: ["string", "text", "url"],
	number: ["number", "integer"],
	date: ["datetime"],
};

/**
 * Problems that stop a job: CSV columns missing from the header (`columns`, CSV only), field
 * paths that are not valid for the source format, and fields the collection lacks or types it
 * cannot take.
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv") {
			if (columns !== null && !columns.includes(path)) {
				errors.push(`Column "${path}" not found in the source`);
			}
			continue;
		}
		const problem = pathProblem(path, format);
		if (problem !== null) errors.push(problem);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f.type]));
	for (const [field, mapping] of Object.entries(t.fields)) {
		const type = byslug.get(field);
		if (type === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else if (!COMPATIBLE[mapping.type].includes(type)) {
			errors.push(
				`Field "${field}" has type "${type}"; a ${mapping.type} mapping needs one of ${COMPATIBLE[mapping.type].join(", ")}`,
			);
		}
	}
	return errors;
}
