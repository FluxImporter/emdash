import { DateTime } from "luxon";
import { z } from "zod";
import { pathProblem, resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
	SOURCE_FORMATS,
	type SourceFormat,
	XLSX_MAX_ROWS,
	XLSX_ROW_FIELD,
} from "../sources/reader.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";

export const SOURCE_ID_FIELD = "flux_source_id";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

const column = z.string().min(1);
const expression = z.string().min(1);
const timezone = z
	.string()
	.min(1)
	.refine((tz) => DateTime.now().setZone(tz).isValid, { message: "Unknown timezone" });

/** Where a key, slug or field value comes from: a source path (`from`) or a JSONata `expr`. */
const valueSource = { from: column.optional(), expr: expression.optional() };
const ONE_SOURCE = { message: 'Set exactly one of "from" and "expr"' };
const hasOneSource = (m: { from?: string | undefined; expr?: string | undefined }) =>
	(m.from === undefined) !== (m.expr === undefined);

const fieldMapping = z.discriminatedUnion("type", [
	z
		.object({ ...valueSource, type: z.literal("text") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("number") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("date"),
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
const valueMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
 * by `checkSource` (sources/readers.ts), so a misplaced one is reported as `invalid_source`.
 * `filter` is a JSONata expression evaluated per record, for every format.
 */
export const sourceSchema = z
	.object({
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
		sheet: z.union([z.string().min(1).max(100), z.number().int().min(1)]).optional(),
		headerRow: z.number().int().min(1).max(XLSX_MAX_ROWS).optional(),
		filter: expression.optional(),
	})
	.strict();

export const templateSchema = z
	.object({
		version: z.literal(1),
		source: sourceSchema.default(() => ({ ...CSV_SOURCE })),
		collection: z.string().regex(SLUG_RE),
		locale: z.string().min(1),
		key: valueMapping,
		slug: valueMapping.optional(),
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
	| "filter_error"
	| "filter_not_boolean"
	| "expr_error"
	| "expr_limit"
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

/** A template with its expressions parsed once, for every record of a batch. */
export interface CompiledTemplate {
	readonly template: Template;
	readonly filter: CompiledExpression | null;
	/** The key's `expr`, or null when it reads `from`. */
	readonly key: CompiledExpression | null;
	/** The slug's `expr`, or null when there is no slug or it reads `from`. */
	readonly slug: CompiledExpression | null;
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
}

/**
 * Parses every expression of the template (filter, key, slug, fields) once. Problems name the
 * template location: `source.filter: JSONata S0207 at character 7: Unexpected end of expression`.
 */
export function compileTemplate(
	t: Template,
): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const compile = (label: string, text: string | undefined): CompiledExpression | null => {
		if (text === undefined) return null;
		const result = compileExpression(text);
		if (result.ok) return result.expression;
		problems.push(`${label}: ${result.problem}`);
		return null;
	};
	const filter = compile("source.filter", t.source.filter);
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const fields = new Map<string, CompiledExpression>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, compiled: { template: t, filter, key, slug, fields } };
}

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	return `a ${typeof value}`;
}

/**
 * Runs the template's `source.filter` on one record value. `true` (or no filter) keeps the record;
 * `false`, an empty result or `undefined` skips it (`filtered`); anything else, or a failure,
 * fails it with `filter_not_boolean`, `filter_error` or `expr_limit`.
 */
export async function filterRecord(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ keep: boolean } | { error: ValueError }> {
	if (c.filter === null) return { keep: true };
	const result = await c.filter.evaluate(value);
	if (!result.ok) {
		const code = result.limit ? "expr_limit" : "filter_error";
		return { error: { field: "filter", code, message: result.message } };
	}
	if (result.value === true) return { keep: true };
	if (result.value === false || result.value === undefined) return { keep: false };
	const message = `The filter must give true or false; it gave ${kindOf(result.value)}`;
	return { error: { field: "filter", code: "filter_not_boolean", message } };
}

/** Marks a value whose expression failed; the failure is already in the record's errors. */
const FAILED = Symbol("failed");

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug and each field from `from` or `expr` and converts them, collecting every
 * error. An expression result goes through the same conversion as a path value, and `undefined`
 * reads as a missing path. Run `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] }> {
	const t = c.template;
	const errors: ValueError[] = [];
	const read = async (
		field: string,
		from: string | undefined,
		expr: CompiledExpression | null | undefined,
	): Promise<unknown> => {
		if (expr === null || expr === undefined) {
			return resolvePath(value, from ?? "", t.source.format);
		}
		const result = await expr.evaluate(value);
		if (result.ok) return result.value;
		errors.push({
			field,
			code: result.limit ? "expr_limit" : "expr_error",
			message: result.message,
		});
		return FAILED;
	};

	const keyField = t.key.from ?? "key";
	const keyRaw = await read(keyField, t.key.from, c.key);
	let key = "";
	if (keyRaw !== FAILED) {
		const keyText = scalarText(keyRaw);
		key = keyText?.trim() ?? "";
		if (keyText === null) {
			errors.push({ field: keyField, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
		} else if (key === "") {
			errors.push({ field: keyField, code: "missing_key", message: "The key column is empty" });
		} else if (key.length > MAX_KEY_LENGTH) {
			errors.push({
				field: keyField,
				code: "key_too_long",
				message: `Keys are limited to ${MAX_KEY_LENGTH} characters`,
			});
		}
	}

	let slug: string | undefined;
	if (t.slug) {
		const slugRaw = await read("slug", t.slug.from, c.slug);
		if (slugRaw !== FAILED) {
			const slugText = scalarText(slugRaw);
			if (slugText === null) {
				errors.push({ field: "slug", code: "not_scalar", message: NOT_SCALAR_MESSAGE });
			} else {
				slug = slugify(slugText);
				if (slug === "") {
					errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
				}
			}
		}
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
		const result = convert(mapping, raw);
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}

/**
 * Every source path the template reads: key, slug and field `from`s, without duplicates.
 * Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [t.key.from, t.slug?.from, ...Object.values(t.fields).map((m) => m.from)];
	return [...new Set(froms.filter((path): path is string => path !== undefined))];
}

/** The paths of `paths` that do not resolve in one record value. */
export function unresolvedPaths(t: Template, paths: readonly string[], value: unknown): string[] {
	return paths.filter((path) => resolvePath(value, path, t.source.format) === undefined);
}

/**
 * Warnings for JSON, JSON Lines and XML template paths that resolved in none of `checked`
 * record values. Nothing checked proves nothing, so it gives none. CSV columns are checked
 * against the header by `checkTemplate` instead.
 */
export function missingPathWarnings(unresolved: readonly string[], checked: number): string[] {
	if (checked === 0) return [];
	return unresolved.map((path) => `Path "${path}" was not found in the first ${checked} records`);
}

/** The warning for a source whose records array or element holds no records. */
export function noRecordsWarning(source: { records?: string | undefined }): string {
	return source.records === undefined
		? "No records found in the file"
		: `No records found at "${source.records}"`;
}

export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<FieldMapping["type"], string[]> = {
	text: ["string", "text", "url"],
	number: ["number", "integer"],
	date: ["datetime"],
};

/**
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, and
 * fields the collection lacks or types it cannot take.
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv" || format === "xlsx") {
			const implicit = format === "xlsx" && path === XLSX_ROW_FIELD;
			if (columns !== null && !columns.includes(path) && !implicit) {
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
