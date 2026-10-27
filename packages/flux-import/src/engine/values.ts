/**
 * Conversions for the M4a field types (number separators, booleans, selects, multi-selects and
 * JSON) and the field rules EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:41-66,
 * :81-210, :240-290). Each converter is built once per mapping, so token sets and option lookups
 * are not rebuilt for every record.
 */

/** A JSON value, as EmDash stores in `json` fields. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ConversionCode =
	| "not_scalar"
	| "invalid_number"
	| "invalid_boolean"
	| "invalid_option"
	| "too_many_items"
	| "invalid_json"
	| "value_too_large";

export type RuleCode =
	| "required"
	| "invalid_integer"
	| "out_of_range"
	| "too_short"
	| "too_long"
	| "pattern_mismatch";

export type Converted =
	| { ok: true; value: JsonValue | string[] }
	| { ok: false; code: ConversionCode; message: string };

/**
 * What the importer knows about a target field: its EmDash type, whether it is required, and the
 * validation keys EmDash enforces. Stored on the job at creation (`Job.targetFields`).
 */
export type TargetField = {
	type: string;
	required: boolean;
	options?: string[];
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	/** Reference fields: the end of the relation this field sits on. */
	relationSide?: "parent" | "child";
	/** Reference fields: the collection the field links to. */
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
};

export interface NumberOptions {
	decimal?: "." | "," | undefined;
	thousands?: "," | "." | " " | "'" | "_" | undefined;
}

export interface BooleanOptions {
	true?: string[] | undefined;
	false?: string[] | undefined;
}

export interface SelectOptions {
	map?: Record<string, string> | undefined;
	ignoreCase?: boolean | undefined;
}

export interface MultiSelectOptions extends SelectOptions {
	separator?: string | undefined;
}

export interface JsonOptions {
	parse?: boolean | undefined;
}

export const TRUE_TOKENS = ["true", "yes", "y", "1", "on"];
export const FALSE_TOKENS = ["false", "no", "n", "0", "off"];
export const MAX_ITEMS = 1000;
export const MAX_JSON_BYTES = 1024 * 1024;
/** Options named in an `invalid_option` message. */
const LISTED_OPTIONS = 20;

export const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NULL: Converted = { ok: true, value: null };

const fail = (code: ConversionCode, message: string): Converted => ({ ok: false, code, message });

/** A scalar as text (numbers and booleans as their string), `""` for null, null for objects. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Numbers: a JSON number as it is; text trimmed, with `thousands` grouping the integer part in
 * threes and `decimal` read as the point, then the M2 number grammar. A space separator also
 * matches U+00A0 and U+202F, which spreadsheets write as thousands separators.
 */
export function numberConverter(o: NumberOptions): (raw: unknown) => Converted {
	const decimal = o.decimal ?? ".";
	const sep =
		o.thousands === undefined
			? null
			: o.thousands === " "
				? "[ \\u00A0\\u202F]"
				: escapeRe(o.thousands);
	const grouped =
		sep === null
			? null
			: new RegExp(`^([+-]?)(\\d{1,3}(?:${sep}\\d{3})+)(?=$|${escapeRe(decimal)}|[eE])`);
	const seps = sep === null ? null : new RegExp(sep, "g");
	return (raw) => {
		if (typeof raw === "number") {
			return Number.isFinite(raw)
				? { ok: true, value: raw }
				: fail("invalid_number", `${raw} is not a number`);
		}
		if (typeof raw === "boolean") return fail("invalid_number", `${raw} is not a number`);
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const trimmed = text.trim();
		if (trimmed === "") return NULL;
		const bad = fail("invalid_number", `"${trimmed}" is not a number`);
		let s = trimmed;
		if (grouped !== null && seps !== null) {
			const m = grouped.exec(s);
			if (m) s = `${m[1]}${(m[2] as string).replace(seps, "")}${s.slice(m[0].length)}`;
			// A separator left over did not group the integer part in threes.
			if (s.replace(seps, "") !== s) return bad;
		}
		if (decimal === ",") {
			if (s.includes(".")) return bad;
			s = s.replace(",", ".");
		}
		if (!NUMBER_RE.test(s)) return bad;
		const n = Number(s);
		return Number.isFinite(n) ? { ok: true, value: n } : bad;
	};
}

const token = (s: string) => s.trim().toLowerCase();

/**
 * Booleans: JSON booleans as they are, JSON 1 and 0, and text looked up (trimmed, lower-cased) in
 * the token lists; a list set on the mapping replaces that default list.
 */
export function booleanConverter(o: BooleanOptions): (raw: unknown) => Converted {
	const trues = o.true ?? TRUE_TOKENS;
	const falses = o.false ?? FALSE_TOKENS;
	const lookup = new Map<string, boolean>([
		...trues.map((t) => [token(t), true] as const),
		...falses.map((t) => [token(t), false] as const),
	]);
	const accepted = `expected one of ${[...trues, ...falses].join(", ")}`;
	return (raw) => {
		if (typeof raw === "boolean") return { ok: true, value: raw };
		if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const key = token(text);
		if (key === "") return NULL;
		const value = lookup.get(key);
		if (value === undefined)
			return fail("invalid_boolean", `"${text.trim()}" is not a boolean; ${accepted}`);
		return { ok: true, value };
	};
}

const lower = (s: string) => s.toLowerCase();

/**
 * Matches one trimmed, non-empty text against `map` (exact key, then the first key equal ignoring
 * case) and then against the field's options (exact, then the one option equal ignoring case).
 * Returns the option as defined, or null. Without options any non-empty text is accepted.
 */
function optionMatcher(o: SelectOptions, options: readonly string[] | undefined) {
	const ignoreCase = o.ignoreCase ?? true;
	const map = new Map(Object.entries(o.map ?? {}));
	const mapLower = new Map<string, string>();
	for (const [k, v] of map) if (!mapLower.has(lower(k))) mapLower.set(lower(k), v);
	const exact = new Set(options ?? []);
	const byLower = new Map<string, string | null>();
	for (const option of options ?? []) {
		const key = lower(option);
		// Two options equal ignoring case make that spelling ambiguous.
		byLower.set(key, byLower.has(key) && byLower.get(key) !== option ? null : option);
	}
	const free = exact.size === 0;
	return (text: string): string | null => {
		const mapped = map.get(text) ?? (ignoreCase ? mapLower.get(lower(text)) : undefined) ?? text;
		if (free || exact.has(mapped)) return mapped;
		return ignoreCase ? (byLower.get(lower(mapped)) ?? null) : null;
	};
}

function optionsMessage(bad: string[], options: readonly string[]): string {
	const listed = options.slice(0, LISTED_OPTIONS).join(", ");
	const more = options.length > LISTED_OPTIONS ? `, … (${options.length} in all)` : "";
	const names = bad.map((b) => `"${b}"`).join(", ");
	return `${names} ${bad.length === 1 ? "is not an option" : "are not options"}; the options are ${listed}${more}`;
}

/** A select value: one option, matched as `optionMatcher` describes; fails `invalid_option`. */
export function selectConverter(
	o: SelectOptions,
	options: readonly string[] | undefined,
): (raw: unknown) => Converted {
	const match = optionMatcher(o, options);
	return (raw) => {
		const text = scalarText(raw);
		if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
		const trimmed = text.trim();
		if (trimmed === "") return NULL;
		const value = match(trimmed);
		if (value === null) return fail("invalid_option", optionsMessage([trimmed], options ?? []));
		return { ok: true, value };
	};
}

/**
 * A multiSelect value: an array of scalars, or text split on `separator` (default ","). Items are
 * trimmed, empty items dropped, each matched as for a select, and duplicates dropped (first kept).
 * An empty result is null.
 */
export function multiSelectConverter(
	o: MultiSelectOptions,
	options: readonly string[] | undefined,
): (raw: unknown) => Converted {
	const match = optionMatcher(o, options);
	const separator = o.separator ?? ",";
	return (raw) => {
		let items: unknown[];
		if (Array.isArray(raw)) items = raw;
		else {
			const text = scalarText(raw);
			if (text === null) return fail("not_scalar", NOT_SCALAR_MESSAGE);
			items = text.split(separator);
		}
		const texts: string[] = [];
		for (const item of items) {
			const text = scalarText(item);
			if (text === null)
				return fail(
					"not_scalar",
					"Expected a list of single values, found an object or array in it",
				);
			const trimmed = text.trim();
			if (trimmed !== "") texts.push(trimmed);
		}
		if (texts.length > MAX_ITEMS) {
			return fail("too_many_items", `${texts.length} items; at most ${MAX_ITEMS} are allowed`);
		}
		const values: string[] = [];
		const bad: string[] = [];
		for (const text of texts) {
			const value = match(text);
			if (value === null) {
				if (!bad.includes(text)) bad.push(text);
			} else if (!values.includes(value)) values.push(value);
		}
		if (bad.length > 0) return fail("invalid_option", optionsMessage(bad, options ?? []));
		return values.length === 0 ? NULL : { ok: true, value: values };
	};
}

/** Text EmDash would read back as JSON (src/database/repositories/content.ts:342-356). */
const looksLikeJson = (s: string) => s.startsWith("{") || s.startsWith("[");
/**
 * Text SQLite stores as a number in EmDash's `JSON` columns, whose type name gives them NUMERIC
 * affinity: `"007"` reads back as 7 (on SQLite and D1).
 */
const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/**
 * JSON: objects, arrays, numbers and booleans as they are. Text is parsed as JSON (`parse`, the
 * default) or kept as a string. A string value that starts with `{` or `[`, or looks like a
 * number, is refused either way, because EmDash would read it back as parsed JSON or as a
 * number. At most 1 MiB serialised.
 */
export function jsonConverter(o: JsonOptions): (raw: unknown) => Converted {
	const parse = o.parse ?? true;
	return (raw) => {
		let value: unknown = raw;
		if (raw === undefined || raw === null) return NULL;
		if (typeof raw === "string") {
			if (raw.trim() === "") return NULL;
			if (parse) {
				try {
					value = JSON.parse(raw, (_key, v) => {
						// An overflowing literal such as 1e999 parses to Infinity, which is not JSON.
						if (typeof v === "number" && !Number.isFinite(v)) throw new RangeError("not finite");
						return v;
					});
				} catch {
					return fail("invalid_json", "The text is not valid JSON");
				}
			}
			if (typeof value === "string" && looksLikeJson(value)) {
				return fail(
					"invalid_json",
					"A JSON string that starts with { or [ would be read back as JSON; store it parsed",
				);
			}
			if (typeof value === "string" && NUMERIC_TEXT.test(value)) {
				return fail(
					"invalid_json",
					"A JSON string that looks like a number would be stored as a number; store a number",
				);
			}
		} else if (typeof raw === "number" && !Number.isFinite(raw)) {
			return fail("invalid_json", `${raw} is not a JSON number`);
		}
		try {
			const text = JSON.stringify(value);
			if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) {
				return fail("value_too_large", `The JSON value is larger than ${MAX_JSON_BYTES} bytes`);
			}
		} catch {
			return fail("invalid_json", "The JSON value is nested too deeply");
		}
		return { ok: true, value: value as JsonValue };
	};
}

const TEXT_TYPES = new Set(["string", "text", "url", "slug"]);
const NUMBER_TYPES = new Set(["number", "integer"]);

/**
 * The field rules EmDash checks on writes, applied to a converted value: `required`, whole
 * numbers for `integer`, `min`/`max`, `minLength`/`maxLength` (UTF-16 code units, as Zod counts)
 * and `pattern` (compiled without flags, as EmDash does; a pattern that does not compile is
 * ignored). Every failing rule gives one error.
 */
export function checkRules(
	value: unknown,
	target: TargetField,
): { code: RuleCode; message: string }[] {
	if (value === null || value === undefined) {
		return target.required ? [{ code: "required", message: "The field is required" }] : [];
	}
	const errors: { code: RuleCode; message: string }[] = [];
	if (NUMBER_TYPES.has(target.type) && typeof value === "number") {
		if (target.type === "integer" && !Number.isSafeInteger(value)) {
			errors.push({
				code: "invalid_integer",
				message: Number.isInteger(value)
					? `${value} is beyond ±${Number.MAX_SAFE_INTEGER}`
					: `${value} is not a whole number`,
			});
		}
		if (target.min !== undefined && value < target.min) {
			errors.push({
				code: "out_of_range",
				message: `${value} is less than the minimum ${target.min}`,
			});
		}
		if (target.max !== undefined && value > target.max) {
			errors.push({
				code: "out_of_range",
				message: `${value} is more than the maximum ${target.max}`,
			});
		}
	}
	// A select without options is a plain string to EmDash, with the text rules.
	const textRules =
		TEXT_TYPES.has(target.type) ||
		(target.type === "select" && (target.options === undefined || target.options.length === 0));
	if (textRules && typeof value === "string") {
		if (target.minLength !== undefined && value.length < target.minLength) {
			errors.push({
				code: "too_short",
				message: `The text has ${value.length} characters; the minimum is ${target.minLength}`,
			});
		}
		if (target.maxLength !== undefined && value.length > target.maxLength) {
			errors.push({
				code: "too_long",
				message: `The text has ${value.length} characters; the maximum is ${target.maxLength}`,
			});
		}
		const pattern = target.pattern === undefined ? null : compilePattern(target.pattern);
		if (pattern !== null && !pattern.test(value)) {
			errors.push({
				code: "pattern_mismatch",
				message: `The text does not match the pattern ${target.pattern}`,
			});
		}
	}
	return errors;
}

/** The pattern as EmDash compiles it, or null when it does not compile. */
function compilePattern(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}
