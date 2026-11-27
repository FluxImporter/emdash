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

const BOOLEAN_WORDS: ReadonlySet<string> = new Set(["true", "false", "yes", "no"]);
/** No `+` and no leading zero but `0` and `0.x`: such values are identifiers, phone numbers… */
const INTEGER_RE = /^-?(0|[1-9]\d*)$/;
const NUMBER_RE = /^-?((0|[1-9]\d*)(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
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

/** A boolean as written: a JSON boolean, a word, or `1`/`0` (as a number or text). */
function booleanToken(v: unknown): "word" | "1" | "0" | null {
	if (typeof v === "boolean") return "word";
	const text = typeof v === "number" || typeof v === "string" ? String(v).trim().toLowerCase() : "";
	if (BOOLEAN_WORDS.has(text)) return "word";
	return text === "1" || text === "0" ? text : null;
}

/**
 * Every value is a boolean token, and they read as flags: a word or JSON boolean among them, or
 * both `1` and `0`. A column of only `1`s (or only `0`s) is a number column.
 */
function areBooleans(values: readonly unknown[]): boolean {
	const tokens = new Set(values.map(booleanToken));
	if (tokens.has(null)) return false;
	return tokens.has("word") || (tokens.has("1") && tokens.has("0"));
}

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
 * The field type a column's values suggest, from its non-empty values: booleans first (so a column
 * of `1`s and `0`s is a flag), then integers, numbers, dates, URLs; `text` when any value is over 200
 * characters; `string` otherwise, and when there are no values.
 */
export function inferFieldType(values: readonly unknown[]): string {
	const present = values.filter((v) => !isEmpty(v));
	if (present.length === 0) return "string";
	const all = (test: (v: unknown) => boolean) => present.every(test);
	if (areBooleans(present)) return "boolean";
	if (all(isInteger)) return "integer";
	if (all(isNumber)) return "number";
	if (all(isDate)) return "datetime";
	if (all(isUrl)) return "url";
	if (present.some((v) => textOf(v).length > STRING_MAX)) return "text";
	return "string";
}

/** What a key's values look like (StepSource.dc.html's "Looks like": Text, Number, Date). */
export type LooksLike = "text" | "number" | "date";

/**
 * What a column's non-empty values look like, read as `inferFieldType` reads them: numbers (an
 * integer or number field), dates (a datetime field), or text for everything else, booleans and
 * URLs too. Null when the column has no values.
 */
export function looksLike(values: readonly unknown[]): LooksLike | null {
	const present = values.filter((v) => !isEmpty(v));
	if (present.length === 0) return null;
	const type = inferFieldType(present);
	if (type === "integer" || type === "number") return "number";
	return type === "datetime" ? "date" : "text";
}

/** `unit_price` → `Unit price`: `schema/apply`'s label for a field requested without one. */
export function labelOf(slug: string): string {
	const words = slug.replace(/_+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
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
