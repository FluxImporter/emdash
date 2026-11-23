/**
 * The deterministic mapping suggester (M6d spec "The deterministic suggester", Rulings 29-31, 51,
 * 57, 58, 62, 63, 68, 70, 71). Pure: no I/O, no clock, no randomness, so one input always gives
 * one answer. It is the suggestion route's answer without a provider, and what a provider refines.
 */
import { parseSourceUrl } from "../sources/net.js";
import { PATHS_MAX_COUNT } from "../sources/paths.js";
import type { SourceFormat } from "../sources/reader.js";
import { dateConverter } from "./dates.js";
import { type MappingType, matchesOption, type SchemaField, SOURCE_ID_FIELD } from "./template.js";
import { FALSE_TOKENS, type NumberOptions, numberConverter, TRUE_TOKENS } from "./values.js";

export const CANDIDATE_MIN_HUNDREDTHS = 30;
export const WARNING_FIELDS_MAX = 20;
export const DATE_FORMAT_MAX = 50;
export const NO_MATCH = "No column or path matches this field";
const EXACT = "Same name as the field";
const SYNONYM = "A usual name for this field";
const OVERLAP = "Shares words with the field name";
const KEY_NAMED = "A usual name for a record identifier";
const KEY_UNIQUE = "Its sample values are all present and distinct";
const KEY_FIRST = "The first column or path; none looks like a record identifier";
const SLUG_RATIONALE = "A usual name for a URL slug";

/** An eligible collection field, as the suggester and the provider payload see it. */
export interface SuggestField {
	slug: string;
	label: string;
	type: string;
	required: boolean;
	options?: readonly string[] | undefined;
}

/**
 * The records read for a suggestion: the keys in first-seen order and, per record, the value read
 * for each key (CSV: the cell, missing → absent; others: `resolvePath`), at most `SAMPLE_MAX`.
 */
export interface Sample {
	format: SourceFormat;
	keys: readonly string[];
	rows: ReadonlyArray<ReadonlyMap<string, unknown>>;
}

/** A warning: a code, with a count or the site's own field slugs (spec Ruling 26). */
export interface SuggestWarning {
	code: string;
	count?: number;
	fields?: string[];
}

/** A field mapping as the suggester writes it: a type, a key, and the options its values need. */
export type SuggestedMapping = { type: MappingType; from: string } & Record<string, unknown>;

/** Spec Ruling 29: the mapping type of each eligible field type. */
const DEFAULT_MAPPING = new Map<string, MappingType>([
	["string", "text"],
	["text", "text"],
	["url", "text"],
	["slug", "slug"],
	["number", "number"],
	["integer", "number"],
	["boolean", "boolean"],
	["datetime", "date"],
	["select", "select"],
	["multiSelect", "multiSelect"],
	["json", "json"],
	["portableText", "portableText"],
	["image", "image"],
	["file", "file"],
]);

export function mappingTypeOf(fieldType: string): MappingType | null {
	return DEFAULT_MAPPING.get(fieldType) ?? null;
}

/** Field slugs in a warning: the site's own names, the first 20 (spec "Output"). */
export function fieldWarning(code: string, slugs: readonly string[]): SuggestWarning {
	return { code, fields: slugs.slice(0, WARNING_FIELDS_MAX) };
}

// --- 1. Normalisation (spec step 1, Ruling 58) ---

/** A name's tokens: its last segment's, for exact and synonym scores, and the whole path's. */
export interface NameTokens {
	tokens: string[];
	pathTokens: string[];
}

function stem(token: string): string {
	if (token.length < 4 || !/^[a-z]+$/.test(token)) return token;
	if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
	return token;
}

function words(text: string): string[] {
	const spaced = text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
		.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{L})(\p{N})/gu, "$1 $2")
		.replace(/(\p{N})(\p{L})/gu, "$1 $2");
	return spaced
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter((t) => t !== "")
		.map(stem);
}

/** The name a key is matched by: a path's last segment; CSV and XLSX keys whole. */
function lastSegment(path: string, format: SourceFormat): string {
	if (format === "json" || format === "jsonl") return path.slice(path.lastIndexOf(".") + 1);
	if (format !== "xml") return path;
	const parts = path.split("/");
	return (parts.at(-1) ?? "").replace(/^@/, "");
}

export function norm(name: string, format: SourceFormat = "csv"): NameTokens {
	// An XML text node names its element: `item/title/#text` reads as `item/title`.
	const path = format === "xml" ? name.replace(/\/#text$/, "") : name;
	return { tokens: words(lastSegment(path, format)), pathTokens: words(path) };
}

export const joined = (tokens: readonly string[]): string => tokens.join("");

// --- 2. Synonyms (spec step 2, Ruling 70) ---

/** The spec's table as natural words, the canonical first; a change to it is a spec change. */
export const SYNONYMS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["title", ["title", "name", "heading", "headline", "subject", "productname", "itemname"]],
	[
		"body",
		[
			"body",
			"content",
			"description",
			"desc",
			"text",
			"html",
			"detail",
			"longdescription",
			"bodyhtml",
		],
	],
	[
		"excerpt",
		["excerpt", "summary", "teaser", "abstract", "intro", "lead", "shortdescription", "blurb"],
	],
	["slug", ["slug", "handle", "permalink", "urlkey", "path"]],
	["price", ["price", "cost", "amount", "regularprice", "saleprice"]],
	["quantity", ["quantity", "qty", "stock", "inventory", "stockquantity"]],
	[
		"date",
		[
			"date",
			"publishdate",
			"publishedat",
			"published",
			"pubdate",
			"releasedate",
			"createdat",
			"created",
		],
	],
	["updated", ["updated", "updatedat", "modified", "lastmodified", "modifiedat"]],
	[
		"image",
		[
			"image",
			"img",
			"photo",
			"picture",
			"thumbnail",
			"featuredimage",
			"cover",
			"imageurl",
			"mainimage",
		],
	],
	["file", ["file", "attachment", "document", "download", "pdf"]],
	["tag", ["tag", "keyword", "label"]],
	["category", ["category", "section", "collection", "type"]],
	["author", ["author", "byline", "writer", "by", "creator"]],
	["url", ["url", "link", "href", "website", "homepage"]],
	["email", ["email", "mail", "emailaddress"]],
	["phone", ["phone", "tel", "telephone", "mobile", "phonenumber"]],
	["status", ["status", "state"]],
	["sku", ["sku", "productcode", "itemcode", "partnumber", "mpn"]],
];

/** Members and canonicals passed through `norm()` at load, so the stemmer's output is looked up. */
const CANONICAL = new Map<string, string>();
for (const [canonical, members] of SYNONYMS) {
	const group = joined(norm(canonical).tokens);
	for (const member of members) CANONICAL.set(joined(norm(member).tokens), group);
}

/** The synonym group's canonical name of a joined name or a token, else the name itself. */
export function canon(name: string): string {
	return CANONICAL.get(name) ?? name;
}

// --- 3. Name score (spec step 3) ---

interface Scored {
	score: number;
	rationale: string;
}

/** A name prepared for scoring: joined, its canonical, and the set of its tokens' canonicals. */
interface PreparedName {
	joined: string;
	canon: string;
	canonTokens: ReadonlySet<string>;
}

function prepare(tokens: readonly string[], overlapTokens: readonly string[]): PreparedName {
	const name = joined(tokens);
	return { joined: name, canon: canon(name), canonTokens: new Set(overlapTokens.map(canon)) };
}

/** A key's name, or null when it is empty and so never scores (Ruling 58). */
function prepareKey(key: NameTokens): PreparedName | null {
	return joined(key.tokens) === "" ? null : prepare(key.tokens, key.pathTokens);
}

/** A field's slug and label, those with an empty name left out, the slug first. */
function prepareField(field: SuggestField): PreparedName[] {
	const out: PreparedName[] = [];
	for (const name of [field.slug, field.label]) {
		const tokens = norm(name).tokens;
		if (joined(tokens) !== "") out.push(prepare(tokens, tokens));
	}
	return out;
}

function scoreAgainst(key: PreparedName, field: PreparedName): Scored | null {
	if (key.joined === field.joined) return { score: 1, rationale: EXACT };
	if (key.canon === field.canon) return { score: 0.8, rationale: SYNONYM };
	let shared = 0;
	for (const t of key.canonTokens) if (field.canonTokens.has(t)) shared++;
	const union = key.canonTokens.size + field.canonTokens.size - shared;
	const j = union === 0 ? 0 : shared / union;
	return j >= 0.5 ? { score: 0.6 * j, rationale: OVERLAP } : null;
}

function bestScore(key: PreparedName | null, names: readonly PreparedName[]): Scored | null {
	if (key === null) return null;
	let best: Scored | null = null;
	for (const name of names) {
		const scored = scoreAgainst(key, name);
		if (scored !== null && (best === null || scored.score > best.score)) best = scored;
	}
	return best;
}

/**
 * The best score of `key` against the field's slug and its label (the slug's on a tie), or null.
 * An empty name never scores (Ruling 58).
 */
export function nameScore(key: NameTokens, field: SuggestField): Scored | null {
	return bestScore(prepareKey(key), prepareField(field));
}

// --- 4. Values and type checks (spec step 4, Rulings 57, 63, 68) ---

/** A scalar as trimmed text, numbers and booleans as written; objects and arrays have none. */
export function textOf(value: unknown): string | null {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

const isEmpty = (v: unknown) =>
	v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The non-empty values read for `key`, in record order (at most the records read). */
export function nonEmptyValues(sample: Sample, key: string): unknown[] {
	const out: unknown[] = [];
	for (const row of sample.rows) {
		const value = row.get(key);
		if (!isEmpty(value)) out.push(value);
	}
	return out;
}

/** Spec Ruling 57, in this order. */
export const NUMBER_CANDIDATES: readonly NumberOptions[] = [
	{},
	{ thousands: "," },
	{ decimal: "," },
	{ decimal: ",", thousands: "." },
	{ decimal: ",", thousands: " " },
];

/** Spec step 4, in this order; `undefined` is ISO 8601. */
export const DATE_CANDIDATES: readonly (string | undefined)[] = [
	undefined,
	"unix",
	"unixMs",
	"yyyy-MM-dd HH:mm:ss",
	"dd/MM/yyyy",
	"MM/dd/yyyy",
	"dd.MM.yyyy",
	"dd-MM-yyyy",
	"d MMM yyyy",
	"MMM d, yyyy",
];
const UNIX_DIGITS: Record<string, RegExp> = { unix: /^\d{9,10}$/, unixMs: /^\d{12,13}$/ };

export function numberFailures(values: readonly unknown[], options: NumberOptions): number {
	const convert = numberConverter(options);
	return values.filter((v) => !convert(v).ok).length;
}

/** With the engine's own converter (Luxon, `en-US`), read in UTC into a `datetime` field. */
export function dateFailures(values: readonly unknown[], format: string | undefined): number {
	const convert = dateConverter({ format, tz: "UTC" }, "datetime");
	const digits = format === undefined ? undefined : UNIX_DIGITS[format];
	return values.filter((v) => {
		if (digits !== undefined && !digits.test(textOf(v) ?? "")) return true;
		return !convert(v).ok;
	}).length;
}

/** The candidate a column of values reads with, how many values it fails, and a warning flag. */
export interface Best<T> {
	option: T;
	failures: number;
	ambiguous: boolean;
}

/**
 * The first candidate that reads every value; else the one that reads the most, the first on a
 * tie (spec Ruling 63).
 */
function best<T>(
	candidates: readonly T[],
	failures: (c: T) => number,
): { index: number; failures: number[] } {
	const counts = candidates.map(failures);
	const all = counts.indexOf(0);
	if (all >= 0) return { index: all, failures: counts };
	let index = 0;
	for (let i = 1; i < counts.length; i++) if ((counts[i] ?? 0) < (counts[index] ?? 0)) index = i;
	return { index, failures: counts };
}

export function bestNumber(values: readonly unknown[]): Best<NumberOptions> {
	const { index, failures } = best(NUMBER_CANDIDATES, (o) => numberFailures(values, o));
	// Every value reads with `thousands ","` and with `decimal ","` (`1,234`): thousands, warned.
	const ambiguous = index === 1 && failures[2] === 0;
	return { option: NUMBER_CANDIDATES[index] ?? {}, failures: failures[index] ?? 0, ambiguous };
}

export function bestDate(values: readonly unknown[]): Best<string | undefined> {
	const { index, failures } = best(DATE_CANDIDATES, (f) => dateFailures(values, f));
	const option = DATE_CANDIDATES[index];
	// Both day-first and month-first read every value: no format, warned (spec step 4).
	if (option === "dd/MM/yyyy" && failures[index + 1] === 0) {
		return { option: undefined, failures: 0, ambiguous: true };
	}
	return { option, failures: failures[index] ?? 0, ambiguous: false };
}

/** A key's values checked against a mapping type: the mapping, and how many values it refuses. */
export interface MappingCheck {
	mapping: SuggestedMapping;
	failures: number;
	checked: number;
	ambiguous?: "number" | "date";
}

export type Mapper = (field: SuggestField, key: string) => MappingCheck | null;

const HTML_RE = /<[a-z][a-z0-9]*[\s>/]/i;

function isBooleanValue(value: unknown): boolean {
	if (typeof value === "boolean") return true;
	if (typeof value === "number") return value === 0 || value === 1;
	if (typeof value !== "string") return false;
	const token = value.trim().toLowerCase();
	return TRUE_TOKENS.includes(token) || FALSE_TOKENS.includes(token);
}

function isUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		parseSourceUrl(value.trim());
		return true;
	} catch {
		return false;
	}
}

/** A multiSelect value's parts: an array's items, else the text split on `,`. */
function partsOf(value: unknown): (string | null)[] {
	if (Array.isArray(value)) return value.map(textOf);
	const text = textOf(value);
	if (text === null) return [null];
	return text
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "");
}

function check(type: MappingType, from: string, values: readonly unknown[], field: SuggestField) {
	const checked = values.length;
	const done = (failures: number, extra: Record<string, unknown> = {}): MappingCheck => ({
		mapping: { type, from, ...extra },
		failures,
		checked,
	});
	switch (type) {
		case "number": {
			const { option, failures, ambiguous } = bestNumber(values);
			const out = done(failures, { ...option });
			return ambiguous ? { ...out, ambiguous: "number" as const } : out;
		}
		case "date": {
			const { option, failures, ambiguous } = bestDate(values);
			const out = done(failures, option === undefined ? {} : { format: option });
			return ambiguous ? { ...out, ambiguous: "date" as const } : out;
		}
		case "boolean":
			return done(values.filter((v) => !isBooleanValue(v)).length);
		case "select":
		case "multiSelect": {
			const options = field.options ?? [];
			let ignoreCase = false;
			const matches = (text: string | null) => {
				if (text === null || text === "" || !matchesOption(text, options, true)) return false;
				if (!options.includes(text)) ignoreCase = true;
				return true;
			};
			const failures = values.filter((v) => {
				if (type === "select") return !matches(textOf(v));
				const parts = partsOf(v);
				// Every part is checked, so a value's case-only match is seen even when another fails.
				const results = parts.map(matches);
				return parts.length === 0 || results.includes(false);
			}).length;
			return done(failures, ignoreCase ? { ignoreCase: true } : {});
		}
		case "image":
		case "file":
			return done(values.filter((v) => !isUrl(v)).length);
		case "portableText": {
			const html = values.some((v) => typeof v === "string" && HTML_RE.test(v));
			return done(0, { format: html ? "html" : "text" });
		}
		default:
			return done(0);
	}
}

/**
 * Checks a key's values for a field, memoised per key and mapping type, or per field and key for
 * `select` and `multiSelect`, whose result depends on the field's options (Ruling 68).
 */
export function createMapper(sample: Sample): Mapper {
	const memo = new Map<string, MappingCheck>();
	return (field, key) => {
		const type = mappingTypeOf(field.type);
		if (type === null) return null;
		const id =
			type === "select" || type === "multiSelect"
				? `${type}\u0000${field.slug}\u0000${key}`
				: `${type}\u0000${key}`;
		let out = memo.get(id);
		if (out === undefined) {
			out = check(type, key, nonEmptyValues(sample, key), field);
			memo.set(id, out);
		}
		return out;
	};
}

// --- Eligibility (spec Ruling 31) ---

export type SchemaFieldWithLabel = SchemaField & { label?: string | undefined };

/** The fields the suggester maps, in schema order, and warnings naming the rest. */
export function eligibleFields(fields: readonly SchemaFieldWithLabel[]): {
	eligible: SuggestField[];
	warnings: SuggestWarning[];
} {
	const eligible: SuggestField[] = [];
	const references: string[] = [];
	const other: string[] = [];
	for (const f of fields) {
		if (f.slug === SOURCE_ID_FIELD) continue;
		if (f.type === "reference") {
			references.push(f.slug);
			continue;
		}
		if (f.unsupported === true || mappingTypeOf(f.type) === null) {
			other.push(f.slug);
			continue;
		}
		const out: SuggestField = {
			slug: f.slug,
			label: f.label ?? f.slug,
			type: f.type,
			required: f.required === true,
		};
		const options = f.validation?.options;
		if ((f.type === "select" || f.type === "multiSelect") && options !== undefined) {
			out.options = options;
		}
		eligible.push(out);
	}
	const warnings: SuggestWarning[] = [];
	if (references.length > 0) warnings.push(fieldWarning("reference_not_suggested", references));
	if (other.length > 0) warnings.push(fieldWarning("fields_not_eligible", other));
	return { eligible, warnings };
}

// --- 5-7. Assignment, the key column and the entry slug ---

/** The key column or the entry slug: a key, a confidence in hundredths and why. */
export interface KeyPick {
	from: string;
	hundredths: number;
	rationale: string;
}

/** A field's suggestion; `settled` is a pick at 100 hundredths (spec Ruling 51). */
export interface FieldPick {
	from: string | null;
	hundredths: number;
	rationale: string;
	mapping?: SuggestedMapping;
	settled: boolean;
}

export interface Candidate {
	field: string;
	key: string;
	hundredths: number;
	rationale: string;
	mapping: SuggestedMapping;
	ambiguous?: "number" | "date";
	required: boolean;
	fieldPosition: number;
	keyPosition: number;
}

/** Spec step 5 (Ruling 62): hundredths, then required fields, schema order, key order. */
export function compareCandidates(a: Candidate, b: Candidate): number {
	return (
		b.hundredths - a.hundredths ||
		Number(b.required) - Number(a.required) ||
		a.fieldPosition - b.fieldPosition ||
		a.keyPosition - b.keyPosition
	);
}

export interface SuggestOptions {
	mapper?: Mapper;
	/** Keys the base template's kept mappings use: never offered (spec Ruling 59). */
	excludedKeys?: ReadonlySet<string>;
	/** With a base template its key is kept, and its slug when it has one (plan Ruling 9). */
	base?: { hasSlug: boolean };
}

export interface NameSuggestion {
	key: KeyPick | null;
	slug: KeyPick | null;
	fields: Map<string, FieldPick>;
	candidates: readonly Candidate[];
	warnings: SuggestWarning[];
}

/** The key column's priority names, as `joined(norm(key).tokens)` (spec step 6, rule 1). */
const KEY_NAMES = [
	"id",
	"sku",
	"uuid",
	"guid",
	"externalid",
	"key",
	"code",
	"productid",
	"itemid",
	"ref",
	"reference",
];
const SLUG_GROUP = canon(joined(norm("slug").tokens));

/**
 * Whether a key's values are all present and distinct (trimmed, case-sensitive), or null with no
 * record read (Ruling 71).
 */
function distinct(sample: Sample, key: string): boolean | null {
	if (sample.rows.length === 0) return null;
	const seen = new Set<string>();
	for (const row of sample.rows) {
		const value = row.get(key);
		if (isEmpty(value)) return false;
		const id = typeof value === "string" ? value.trim() : JSON.stringify(value);
		if (seen.has(id)) return false;
		seen.add(id);
	}
	return true;
}

/** A sample key with its position and its name, normalised once per call. */
interface SampleKey {
	name: string;
	position: number;
	tokens: NameTokens;
	prepared: PreparedName | null;
}

function keyColumn(
	sample: Sample,
	keys: readonly SampleKey[],
	warnings: SuggestWarning[],
): KeyPick {
	const first = keys[0];
	if (first === undefined) throw new Error("suggestByName needs at least one key");
	const names = keys.map((k) => joined(k.tokens.tokens));
	for (const name of KEY_NAMES) {
		const index = names.indexOf(name);
		const from = keys[index]?.name;
		if (index < 0 || from === undefined) continue;
		const unique = distinct(sample, from);
		if (unique === false) warnings.push({ code: "key_not_unique_in_sample" });
		return { from, hundredths: unique === true ? 90 : 60, rationale: KEY_NAMED };
	}
	if (sample.rows.length > 0) {
		const from = keys.find((k) => distinct(sample, k.name) === true)?.name;
		if (from !== undefined) {
			warnings.push({ code: "key_guessed" });
			return { from, hundredths: 40, rationale: KEY_UNIQUE };
		}
	}
	warnings.push({ code: "key_guessed" });
	return { from: first.name, hundredths: 10, rationale: KEY_FIRST };
}

/**
 * The keys name matching reads: the first `PATHS_MAX_COUNT` (1,000), in sample order, so a wide
 * CSV costs bounded CPU (final review). Keys past them are never matched nor sent to a provider,
 * and are counted in `keys_not_matched`.
 */
export function matchedKeys(sample: Sample): readonly string[] {
	return sample.keys.slice(0, PATHS_MAX_COUNT);
}

/**
 * Suggests a key column, an entry slug and one key per field by name and sample values alone
 * (spec "The deterministic suggester" steps 1-8).
 */
export function suggestByName(
	fields: readonly SuggestField[],
	sample: Sample,
	options: SuggestOptions = {},
): NameSuggestion {
	const matched = matchedKeys(sample);
	const keys = matched.map((name, position): SampleKey => {
		const tokens = norm(name, sample.format);
		return { name, position, tokens, prepared: prepareKey(tokens) };
	});
	const excluded = options.excludedKeys ?? new Set<string>();
	const mapper = options.mapper ?? createMapper(sample);
	const warnings: SuggestWarning[] = [];
	if (sample.rows.length === 0 && sample.keys.length > 0) warnings.push({ code: "sample_empty" });
	const notMatched = sample.keys.length - matched.length;
	if (notMatched > 0) warnings.push({ code: "keys_not_matched", count: notMatched });

	const key = options.base === undefined ? keyColumn(sample, keys, warnings) : null;

	let slug: KeyPick | null = null;
	if (options.base?.hasSlug !== true) {
		const found = keys.find(
			(k) =>
				k.name !== key?.from &&
				!excluded.has(k.name) &&
				canon(joined(k.tokens.tokens)) === SLUG_GROUP,
		);
		if (found !== undefined) slug = { from: found.name, hundredths: 80, rationale: SLUG_RATIONALE };
	}

	// Each name is normalised once per call, not once per (field, key) pair.
	const offered = keys.filter((k) => !excluded.has(k.name) && k.name !== slug?.from);
	const candidates: Candidate[] = [];
	fields.forEach((field, fieldPosition) => {
		const names = prepareField(field);
		for (const { name: k, position: keyPosition, prepared } of offered) {
			const named = bestScore(prepared, names);
			if (named === null) continue;
			const checked = mapper(field, k);
			if (checked === null) continue;
			let { score, rationale } = named;
			if (checked.failures * 2 > checked.checked) {
				score /= 2;
				rationale = `${rationale}; the sample values do not look like ${checked.mapping.type}`;
			}
			const hundredths = Math.round(score * 100);
			if (hundredths < CANDIDATE_MIN_HUNDREDTHS) continue;
			candidates.push({
				field: field.slug,
				key: k,
				hundredths,
				rationale,
				// A copy: the memoised check is shared by every field mapped from the same key.
				mapping: { ...checked.mapping },
				...(checked.ambiguous === undefined ? {} : { ambiguous: checked.ambiguous }),
				required: field.required,
				fieldPosition,
				keyPosition,
			});
		}
	});
	candidates.sort(compareCandidates);

	const taken = new Map<string, Candidate>();
	const usedKeys = new Set<string>();
	for (const c of candidates) {
		if (taken.has(c.field) || usedKeys.has(c.key)) continue;
		taken.set(c.field, c);
		usedKeys.add(c.key);
	}

	const picks = new Map<string, FieldPick>();
	const ambiguousNumbers: string[] = [];
	const ambiguousDates: string[] = [];
	for (const field of fields) {
		const c = taken.get(field.slug);
		if (c === undefined) {
			picks.set(field.slug, { from: null, hundredths: 0, rationale: NO_MATCH, settled: false });
			continue;
		}
		picks.set(field.slug, {
			from: c.key,
			hundredths: c.hundredths,
			rationale: c.rationale,
			mapping: c.mapping,
			settled: c.hundredths === 100,
		});
		if (c.ambiguous === "number") ambiguousNumbers.push(field.slug);
		if (c.ambiguous === "date") ambiguousDates.push(field.slug);
	}
	if (ambiguousNumbers.length > 0) {
		warnings.push(fieldWarning("number_format_ambiguous", ambiguousNumbers));
	}
	if (ambiguousDates.length > 0)
		warnings.push(fieldWarning("date_format_ambiguous", ambiguousDates));

	return { key, slug, fields: picks, candidates, warnings };
}
