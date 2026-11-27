/**
 * Conversion of the M4b link mappings: reference fields, `taxonomies` and `bylines`. A converter
 * turns one source value into lookup requests (texts and term paths), not IDs; the resolver
 * (resolve.ts) looks them up before the record is planned.
 */
import { NOT_SCALAR_MESSAGE, type TargetField } from "./values.js";

/** References per field: EmDash's first page of read-back (`REFERENCE_PAGE_LIMIT`). */
export const MAX_REFERENCES = 50;
export const MAX_TERMS = 100;
export const MAX_TERM_SEGMENTS = 10;
export const MAX_BYLINES = 50;
/** The longest reference, term segment or flat term the importer looks up. */
export const MAX_ITEM_LENGTH = 200;
/** `match: "key"` items are source keys, which may be as long as a record key. */
export const MAX_KEY_ITEM_LENGTH = 256;
export const DEFAULT_SEPARATOR = ",";
export const DEFAULT_HIERARCHY = "/";

/** Errors from link conversion and resolution; all are record errors. */
export type LinkErrorCode =
	| "invalid_term_path"
	| "term_not_found"
	| "term_path_mismatch"
	| "ambiguous_term"
	| "invalid_term_slug"
	| "term_create_failed"
	| "reference_not_found"
	| "ambiguous_source_id"
	| "byline_not_found"
	| "ambiguous_byline"
	| "byline_lookup_limit";

/** One term the source names: its path from a root (one segment in a flat taxonomy). */
export type TermRequest = { path: string[] };

/** What a job knows about a mapped taxonomy (`Job.taxonomies`). */
export type TaxonomySnapshot = { hierarchical: boolean };

/** A record's converted links; `null` is an empty value, which clears the link on update. */
export type LinkRequests = {
	taxonomies?: Record<string, TermRequest[] | null>;
	references?: Record<string, string[] | null>;
	bylines?: string[] | null;
};

/** One resolved link item (resolve.ts). */
export type ResolvedItem = {
	/**
	 * What the diff compares: the translation group of the term, entry or byline; null for a
	 * term a dry run would create.
	 */
	group: string | null;
	/** What EmDash is sent: a term slug, an entry ID or a byline ID ("" for a term not created). */
	value: string;
	/** How the record shows it: a term's slug path, an entry ID or a byline slug. */
	text: string;
};

/** A record's links, resolved; an empty list clears the link. */
export type ResolvedLinks = {
	taxonomies?: Record<string, ResolvedItem[]>;
	references?: Record<string, ResolvedItem[]>;
	bylines?: ResolvedItem[];
};

export type LinkConverted<T> =
	| { ok: true; value: T[] | null }
	| {
			ok: false;
			code: "not_scalar" | "too_many_items" | "too_long" | LinkErrorCode;
			message: string;
	  };

/** A scalar as text (numbers and booleans as their string), `""` for null, null for objects. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

/**
 * The items of a link value: an array of scalars, or a scalar split on `separator` as text. Items
 * are trimmed, and empty items and exact duplicates are dropped (the first is kept).
 */
export function linkItems(
	raw: unknown,
	separator: string,
): { ok: true; items: string[] } | { ok: false; code: "not_scalar"; message: string } {
	let parts: unknown[];
	if (Array.isArray(raw)) parts = raw;
	else {
		const text = scalarText(raw);
		if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		parts = text.split(separator);
	}
	const items: string[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		const text = scalarText(part);
		if (text === null) {
			return {
				ok: false,
				code: "not_scalar",
				message: "Expected a list of single values, found an object or array in it",
			};
		}
		const trimmed = text.trim();
		if (trimmed !== "" && !seen.has(trimmed)) {
			seen.add(trimmed);
			items.push(trimmed);
		}
	}
	return { ok: true, items };
}

const tooMany = (count: number, max: number) => ({
	ok: false as const,
	code: "too_many_items" as const,
	message: `${count} items; at most ${max} ${max === 1 ? "is" : "are"} allowed`,
});

/** Whether a reference field takes one entry: the parent side of a relation not marked multiple. */
export function isSingleReference(target: TargetField | null): boolean {
	return target !== null && target.relationSide === "parent" && target.multiple !== true;
}

/**
 * A reference value: at most 50 items, or 1 for a single field, each 1-200 characters (256 for
 * `match: "key"`). `required` is checked by `checkRules`, as for other fields.
 */
export function referenceConverter(
	o: { separator?: string | undefined; match?: "id" | "slug" | "key" | undefined },
	target: TargetField | null,
): (raw: unknown) => LinkConverted<string> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	const max = isSingleReference(target) ? 1 : MAX_REFERENCES;
	const longest = o.match === "key" ? MAX_KEY_ITEM_LENGTH : MAX_ITEM_LENGTH;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > max) return tooMany(items.length, max);
		const long = items.find((item) => item.length > longest);
		if (long !== undefined) {
			return {
				ok: false,
				code: "too_long",
				message: `"${long.slice(0, 40)}…" is longer than ${longest} characters`,
			};
		}
		return { ok: true, value: items.length === 0 ? null : items };
	};
}

/**
 * A taxonomy value: at most 100 terms. In a hierarchical taxonomy each item is a path split on
 * `hierarchy` into at most 10 trimmed segments of 1-200 characters; a flat taxonomy never splits,
 * so a tag such as `AC/DC` stays one term.
 */
export function taxonomyConverter(
	o: { separator?: string | undefined; hierarchy?: string | undefined },
	taxonomy: TaxonomySnapshot | null,
): (raw: unknown) => LinkConverted<TermRequest> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	const hierarchy = o.hierarchy ?? DEFAULT_HIERARCHY;
	const hierarchical = taxonomy?.hierarchical ?? false;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > MAX_TERMS) return tooMany(items.length, MAX_TERMS);
		const terms: TermRequest[] = [];
		for (const item of items) {
			const path = hierarchical ? item.split(hierarchy).map((s) => s.trim()) : [item];
			const problem =
				path.length > MAX_TERM_SEGMENTS
					? `has ${path.length} levels; at most ${MAX_TERM_SEGMENTS} are allowed`
					: path.some((s) => s === "")
						? "has an empty level"
						: path.some((s) => s.length > MAX_ITEM_LENGTH)
							? `${hierarchical ? "has a level" : "is"} longer than ${MAX_ITEM_LENGTH} characters`
							: null;
			if (problem !== null) {
				return {
					ok: false,
					code: "invalid_term_path",
					message: `"${item.slice(0, 80)}" ${problem}`,
				};
			}
			terms.push({ path });
		}
		return { ok: true, value: terms.length === 0 ? null : terms };
	};
}

/** A bylines value: at most 50 slugs or names. */
export function bylinesConverter(o: {
	separator?: string | undefined;
}): (raw: unknown) => LinkConverted<string> {
	const separator = o.separator ?? DEFAULT_SEPARATOR;
	return (raw) => {
		const split = linkItems(raw, separator);
		if (!split.ok) return split;
		const { items } = split;
		if (items.length > MAX_BYLINES) return tooMany(items.length, MAX_BYLINES);
		return { ok: true, value: items.length === 0 ? null : items };
	};
}
