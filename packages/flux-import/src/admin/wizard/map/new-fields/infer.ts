import { RESERVED_FIELD_SLUGS } from "../../../limits.js";
import type { SampleColumn } from "../../../types.js";
import type { ProposedField } from "../../state.js";

/**
 * A proposed field from a source key (spec "New fields"): a slug and label from the key, and a
 * type inferred from the raw sample values, which the user can change.
 */

/** `SOURCE_ID_FIELD` (`src/engine/template.ts`): `schema/apply` refuses it (preflight F16). */
const SOURCE_ID_FIELD = "flux_source_id";
/** `schema/apply`'s slug and label limits (`src/plugin/schema-apply.ts`). */
const SLUG_MAX = 63;
const LABEL_MAX = 200;
/** A value longer than this suggests a `text` field rather than a `string`. */
const STRING_MAX = 200;

const BOOLEAN_TOKENS: ReadonlySet<string> = new Set(["true", "false", "yes", "no", "1", "0"]);
const INTEGER_RE = /^[+-]?\d+$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const ISO_RE =
	/^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/i;
const DAY_FIRST_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const URL_RE = /^https?:\/\/\S+$/i;

const isEmpty = (v: unknown) =>
	v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** A value as trimmed text: objects and arrays as JSON. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

const isBoolean = (v: unknown) =>
	typeof v === "boolean" ||
	(typeof v === "number" && (v === 0 || v === 1)) ||
	(typeof v === "string" && BOOLEAN_TOKENS.has(v.trim().toLowerCase()));

const isInteger = (v: unknown) =>
	typeof v === "number" ? Number.isInteger(v) : typeof v === "string" && INTEGER_RE.test(v.trim());

const isNumber = (v: unknown) =>
	typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && NUMBER_RE.test(v.trim());

/** A calendar date: month 1-12, and a day that month has (in a leap year, for 29 February). */
function validDay(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= new Date(Date.UTC(year === 0 ? 2000 : year, month, 0)).getUTCDate();
}

function isDate(v: unknown): boolean {
	if (typeof v !== "string") return false;
	const text = v.trim();
	const iso = ISO_RE.exec(text);
	if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
	const dmy = DAY_FIRST_RE.exec(text);
	return dmy !== null && validDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
}

const isUrl = (v: unknown) => typeof v === "string" && URL_RE.test(v.trim());

/**
 * The field type a column's values suggest, from its non-empty values: booleans first (so `1`/`0`
 * columns are flags), then integers, numbers, dates, URLs; `text` when any value is over 200
 * characters; `string` otherwise, and when there are no values.
 */
export function inferFieldType(values: readonly unknown[]): string {
	const present = values.filter((v) => !isEmpty(v));
	if (present.length === 0) return "string";
	const all = (test: (v: unknown) => boolean) => present.every(test);
	if (all(isBoolean)) return "boolean";
	if (all(isInteger)) return "integer";
	if (all(isNumber)) return "number";
	if (all(isDate)) return "datetime";
	if (all(isUrl)) return "url";
	if (present.some((v) => textOf(v).length > STRING_MAX)) return "text";
	return "string";
}

/** `s` cut to `max` UTF-16 units, never inside a surrogate pair. */
function cut(s: string, max: number): string {
	const head = s.slice(0, max);
	return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** A key as a slug base: accents dropped, lower-cased, runs outside a-z0-9 as `_`, trimmed. */
function slugBase(key: string): string {
	const base = key
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (base === "") return "field";
	return /^[a-z]/.test(base) ? base : `f_${base}`;
}

/** `base` with `suffix`, cut so the whole fits `SLUG_MAX`, without a trailing `_` before it. */
const withSuffix = (base: string, suffix: string) =>
	base.slice(0, SLUG_MAX - suffix.length).replace(/_+$/, "") + suffix;

/**
 * A new field for a source key. Its slug avoids `taken`, EmDash's reserved slugs and
 * `flux_source_id` with `_2`, `_3`…; its label is the key, trimmed and cut to 200 characters.
 */
export function proposeField(column: SampleColumn, taken: readonly string[]): ProposedField {
	const unavailable = new Set([...taken, ...RESERVED_FIELD_SLUGS, SOURCE_ID_FIELD]);
	const base = slugBase(column.key);
	let slug = withSuffix(base, "");
	for (let n = 2; unavailable.has(slug); n++) slug = withSuffix(base, `_${n}`);
	const label = cut(column.key.replace(/\s+/g, " ").trim(), LABEL_MAX).trimEnd();
	return {
		key: column.key,
		slug,
		label: label === "" ? slug : label,
		type: inferFieldType(column.values),
		translatable: true,
		searchable: false,
	};
}
