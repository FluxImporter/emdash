import { DateTime } from "luxon";
import { z } from "zod";

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

export const templateSchema = z
	.object({
		version: z.literal(1),
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
	| "missing_key"
	| "key_too_long"
	| "invalid_number"
	| "invalid_date"
	| "empty_slug";
export type ValueError = { field: string; code: ValueErrorCode; message: string };

function cell(values: Record<string, string>, column: string): string {
	return Object.hasOwn(values, column) ? (values[column] ?? "") : "";
}

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

function convert(
	mapping: FieldMapping,
	raw: string,
): { ok: true; value: FieldValue } | { ok: false; code: ValueErrorCode; message: string } {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, value: null };
	switch (mapping.type) {
		case "text":
			return { ok: true, value: raw };
		case "number":
			return NUMBER_RE.test(trimmed)
				? { ok: true, value: Number(trimmed) }
				: { ok: false, code: "invalid_number", message: `"${trimmed}" is not a number` };
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

export function applyTemplate(
	t: Template,
	values: Record<string, string>,
): { ok: true; value: MappedRecord } | { ok: false; errors: ValueError[] } {
	const errors: ValueError[] = [];

	const key = cell(values, t.key.from).trim();
	if (key === "") {
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
		slug = slugify(cell(values, t.slug.from));
		if (slug === "") {
			errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
		}
	}

	const data: Record<string, FieldValue> = {};
	for (const [field, mapping] of Object.entries(t.fields)) {
		const result = convert(mapping, cell(values, mapping.from));
		if (result.ok) data[field] = result.value;
		else errors.push({ field, code: result.code, message: result.message });
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: slug === undefined ? { key, data } : { key, slug, data } };
}

export type SchemaField = { slug: string; type: string };

const COMPATIBLE: Record<FieldMapping["type"], string[]> = {
	text: ["string", "text", "url"],
	number: ["number", "integer"],
	date: ["datetime"],
};

export function checkTemplate(t: Template, fields: SchemaField[], headers: string[]): string[] {
	const errors: string[] = [];
	const columns = [
		t.key.from,
		...(t.slug ? [t.slug.from] : []),
		...Object.values(t.fields).map((m) => m.from),
	];
	for (const c of new Set(columns)) {
		if (!headers.includes(c)) errors.push(`Column "${c}" not found in the source`);
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
