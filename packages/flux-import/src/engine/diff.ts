import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { FieldValue, JsonValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
export type PlanAction = "create" | "update" | "unchanged";
export type RecordPlan = { action: PlanAction; changes: Change[] };
export type CurrentEntry = { slug: string | null; data: Record<string, unknown> };

/**
 * How a field's stored value is compared with the mapped one: `instant` for datetimes, `boolean`
 * against EmDash's stored 0/1, `deep` for multiSelect and json values, `plain` for the rest.
 */
export type Comparison = "instant" | "boolean" | "deep" | "plain";

/** Object keys in any order, arrays in order, `-0` equal to `0`. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	const bo = b as Record<string, unknown>;
	const ao = a as Record<string, unknown>;
	return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

function same(before: unknown, after: FieldValue, how: Comparison): boolean {
	const b = before ?? null;
	if (b === null || after === null) return b === after;
	// EmDash stores a boolean as 0 or 1 and reads it back as that number, in boolean fields and
	// as the whole value of a json field.
	if ((how === "boolean" || how === "deep") && typeof after === "boolean") {
		return b === after || b === (after ? 1 : 0);
	}
	switch (how) {
		case "instant":
			if (typeof b === "string" && typeof after === "string") {
				const tb = Date.parse(b);
				return !Number.isNaN(tb) && tb === Date.parse(after);
			}
			return Object.is(b, after);
		case "deep":
			return deepEqual(b, after);
		default:
			// EmDash reads stored text that starts with { or [ and parses as JSON back parsed: such
			// text is unchanged when it is exactly the parsed value's canonical JSON.
			if (typeof after === "string" && typeof b === "object") return JSON.stringify(b) === after;
			// -0 and 0 are the same number: EmDash reads a stored -0 back as 0.
			if (typeof b === "number" && typeof after === "number") return b === after;
			return Object.is(b, after);
	}
}

/** One link the entry holds now: its translation group and how the record shows it. */
export type CurrentItem = { group: string; text: string };

/** What the entry holds now for the links the template maps; a link not given is empty. */
export type CurrentLinks = {
	taxonomies?: Record<string, CurrentItem[]>;
	references?: Record<string, CurrentItem[]>;
	/** Reference fields with more selections than were read: they always compare as changed. */
	referencesTruncated?: readonly string[];
	bylines?: CurrentItem[];
};

/** A record's resolved links and the entry's current ones, for `planRecord`. */
export type LinkPlan = {
	resolved: ResolvedLinks;
	current: CurrentLinks;
	/** Reference fields on the child side of their relation, which keep no order. */
	childSide: ReadonlySet<string>;
};

/**
 * Whether the entry already holds the resolved items: the same translation groups, in order or
 * as a set. A term not created yet (a dry run) is always a change.
 */
function sameLinks(
	current: readonly CurrentItem[],
	next: readonly ResolvedItem[],
	ordered: boolean,
) {
	if (next.some((item) => item.group === null) || current.length !== next.length) return false;
	if (ordered) return current.every((item, i) => item.group === next[i]?.group);
	const groups = new Set(current.map((item) => item.group));
	return groups.size === next.length && next.every((item) => groups.has(item.group as string));
}

const texts = (items: readonly { text: string }[]) =>
	items.length === 0 ? null : items.map((item) => item.text);

/**
 * The link changes, in order: reference fields, taxonomies (`taxonomies.<name>`), bylines.
 * Taxonomies and child-side references compare as sets, the rest in order; an empty value equals
 * an empty current link. Without a current entry, every non-empty link is a change.
 */
function linkChanges(links: LinkPlan, exists: boolean): Change[] {
	const { resolved, current } = links;
	const changes: Change[] = [];
	const compare = (
		field: string,
		before: readonly CurrentItem[],
		after: readonly ResolvedItem[],
		ordered: boolean,
		truncated = false,
	) => {
		if (!exists) {
			if (after.length > 0) changes.push({ field, before: null, after: texts(after) });
		} else if (truncated || !sameLinks(before, after, ordered)) {
			changes.push({ field, before: texts(before), after: texts(after) });
		}
	};
	for (const [field, after] of Object.entries(resolved.references ?? {})) {
		compare(
			field,
			current.references?.[field] ?? [],
			after,
			!links.childSide.has(field),
			current.referencesTruncated?.includes(field),
		);
	}
	for (const [taxonomy, after] of Object.entries(resolved.taxonomies ?? {})) {
		compare(`taxonomies.${taxonomy}`, current.taxonomies?.[taxonomy] ?? [], after, false);
	}
	if (resolved.bylines !== undefined) {
		compare("bylines", current.bylines ?? [], resolved.bylines, true);
	}
	return changes;
}

/** A media field's resolved value, for `planRecord`; null for an empty value. */
export type MediaPlanItem = {
	/** The media item's ID; null for a file not stored yet, which is always a change. */
	mediaId: string | null;
	/** What the field is written with; null when `mediaId` is. */
	value: JsonValue | null;
	/** How the record shows it: the ID, or `new media from <url>`. */
	text: string;
	/** The mapped alt text; null when the mapping gives none, so the stored alt is not compared. */
	alt: string | null;
};

/** A stored image or file value's media ID: its `id`, or the value itself when it is a string. */
function storedMediaId(stored: unknown): string | null {
	if (typeof stored === "string") return stored;
	if (typeof stored === "object" && stored !== null && "id" in stored) {
		return typeof stored.id === "string" ? stored.id : null;
	}
	return null;
}

function storedAlt(stored: unknown): string | null {
	if (typeof stored !== "object" || stored === null || !("alt" in stored)) return null;
	return typeof stored.alt === "string" ? stored.alt : null;
}

/**
 * The media changes: a field whose stored media ID differs (a new file always does), or, with
 * the same ID, `<field>.alt` when the mapped alt is given and differs. Other keys of the stored
 * value are not compared: EmDash fills them on save. An empty value equals nothing stored.
 */
function mediaChanges(
	media: Readonly<Record<string, MediaPlanItem | null>>,
	data: Readonly<Record<string, unknown>> | null,
): Change[] {
	const changes: Change[] = [];
	for (const [field, item] of Object.entries(media)) {
		const stored = data !== null && Object.hasOwn(data, field) ? data[field] : null;
		const before = storedMediaId(stored);
		if (item === null) {
			if (stored !== null && stored !== undefined) changes.push({ field, before, after: null });
		} else if (item.mediaId === null || item.mediaId !== before) {
			changes.push({ field, before, after: item.text });
		} else if (item.alt !== null && storedAlt(stored) !== item.alt) {
			changes.push({ field: `${field}.alt`, before: storedAlt(stored), after: item.alt });
		}
	}
	return changes;
}

/** A Portable Text field's assembled value, for `planRecord`; null for an empty value. */
export type PortableTextPlanItem = {
	/** The assembled blocks. */
	blocks: JsonValue[];
	/** Images not stored yet: the field is a change while this is above 0. */
	pending: number;
	/** How the record shows it: `14 blocks, 3 images (1 new)`. */
	text: string;
};

/** Canonical forms nest at most this deep; a deeper stored value always compares as changed. */
const MAX_CANONICAL_DEPTH = 16;

/**
 * The comparable form of one Portable Text value, or undefined when it is not an array (or nests
 * too deep), which always compares as changed. Every `_key` is dropped, and marks that name a
 * block's link definitions name its position instead (`@0`); marks are a set, so they are sorted. An empty `marks` or `markDefs`, a
 * text block's `style: "normal"`, a link's `blank: false` and a list's `listStart: 1` equal a
 * missing one, and `listId` is dropped: EmDash's editor writes and drops these on save (Fact V2).
 */
export function canonicalPortableText(value: unknown): JsonValue[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: JsonValue[] = [];
	for (const block of value) {
		const canonical = canonicalBlock(block);
		if (canonical === undefined) return undefined;
		blocks.push(canonical);
	}
	return blocks;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalBlock(block: unknown): JsonValue | undefined {
	if (!isObject(block) || block._type !== "block") return canonicalJson(block, 0);
	const ids = new Map<unknown, string>();
	if (Array.isArray(block.markDefs)) {
		block.markDefs.forEach((def, i) => {
			if (isObject(def) && def._key !== undefined) ids.set(def._key, `@${i}`);
		});
	}
	const out: { [key: string]: JsonValue } = {};
	for (const [key, raw] of Object.entries(block)) {
		if (key === "_key" || key === "listId" || raw === undefined) continue;
		if (key === "style" && raw === "normal") continue;
		if (key === "listStart" && raw === 1) continue;
		let value: unknown = raw;
		if (key === "children" && Array.isArray(raw)) {
			value = raw.map((span) =>
				isObject(span) && Array.isArray(span.marks)
					? { ...span, marks: span.marks.map((m) => ids.get(m) ?? m).sort() }
					: span,
			);
		}
		const canonical = canonicalJson(value, 1);
		if (canonical === undefined) return undefined;
		if (Array.isArray(canonical) && canonical.length === 0 && key === "markDefs") continue;
		out[key] = canonical;
	}
	return out;
}

/** JSON without `_key`, empty `marks` and a link's `blank: false`, at most `MAX_CANONICAL_DEPTH` deep. */
function canonicalJson(value: unknown, depth: number): JsonValue | undefined {
	if (depth > MAX_CANONICAL_DEPTH) return undefined;
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const canonical = canonicalJson(item, depth + 1);
			if (canonical === undefined) return undefined;
			items.push(canonical);
		}
		return items;
	}
	if (!isObject(value)) {
		return typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
			? value
			: undefined;
	}
	const out: { [key: string]: JsonValue } = {};
	for (const [key, raw] of Object.entries(value)) {
		if (key === "_key" || raw === undefined) continue;
		if (key === "marks" && Array.isArray(raw) && raw.length === 0) continue;
		if (key === "blank" && raw === false && value._type === "link") continue;
		const canonical = canonicalJson(raw, depth + 1);
		if (canonical === undefined) return undefined;
		out[key] = canonical;
	}
	return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a record shows a Portable Text value: `12 blocks, 2 images`, plus `(1 new)` for pending ones. */
export function portableTextSummary(blocks: readonly unknown[], pending = 0): string {
	const images = blocks.filter((b) => isObject(b) && b._type === "image").length + pending;
	const parts = [plural(blocks.length + pending, "block")];
	if (images > 0) parts.push(plural(images, "image") + (pending > 0 ? ` (${pending} new)` : ""));
	return parts.join(", ");
}

/**
 * The Portable Text changes: a field whose canonical stored value differs, or that has images
 * not stored yet. An empty value equals nothing stored and an empty array.
 */
function portableTextChanges(
	items: Readonly<Record<string, PortableTextPlanItem | null>>,
	data: Readonly<Record<string, unknown>> | null,
): Change[] {
	const changes: Change[] = [];
	for (const [field, item] of Object.entries(items)) {
		const stored = data !== null && Object.hasOwn(data, field) ? data[field] : null;
		const empty =
			stored === null || stored === undefined || (Array.isArray(stored) && stored.length === 0);
		const before = empty
			? null
			: Array.isArray(stored)
				? portableTextSummary(stored)
				: "a value that is not Portable Text";
		if (item === null) {
			if (!empty) changes.push({ field, before, after: null });
			continue;
		}
		const same =
			item.pending === 0 &&
			!empty &&
			deepEqual(canonicalPortableText(stored) ?? null, canonicalPortableText(item.blocks));
		if (!same) changes.push({ field, before, after: item.text });
	}
	return changes;
}

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field, a media field, a Portable Text field or a link differs, else `unchanged`. `links` is
 * given when the template maps links, `media` when it maps image or file fields, `portableText`
 * when it maps `portableText` fields.
 */
export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
	media?: Readonly<Record<string, MediaPlanItem | null>>,
	portableText?: Readonly<Record<string, PortableTextPlanItem | null>>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
		if (next.slug !== undefined) changes.push({ field: "slug", before: null, after: next.slug });
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (media) changes.push(...mediaChanges(media, null));
		if (portableText) changes.push(...portableTextChanges(portableText, null));
		if (links) changes.push(...linkChanges(links, false));
		return { action: "create", changes };
	}
	if (next.slug !== undefined && current.slug !== next.slug) {
		changes.push({ field: "slug", before: current.slug, after: next.slug });
	}
	for (const [field, after] of Object.entries(next.data)) {
		const before = Object.hasOwn(current.data, field) ? current.data[field] : null;
		if (!same(before, after, comparisons.get(field) ?? "plain"))
			changes.push({ field, before: before ?? null, after });
	}
	if (media) changes.push(...mediaChanges(media, current.data));
	if (portableText) changes.push(...portableTextChanges(portableText, current.data));
	if (links) changes.push(...linkChanges(links, true));
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}

const BY_TARGET: Record<string, Comparison> = {
	datetime: "instant",
	boolean: "boolean",
	multiSelect: "deep",
	json: "deep",
};

/**
 * How each mapped field compares: by the target field's type from the job's snapshot, or, for
 * jobs created before M4a, `instant` for date mappings (all of which went into datetime fields).
 */
export function comparisonsOf(
	t: Template,
	targets?: Readonly<Record<string, { type: string }>>,
): Map<string, Comparison> {
	return new Map(
		Object.entries(t.fields).map(([field, mapping]): [string, Comparison] => {
			const target = targets?.[field];
			if (target === undefined) return [field, mapping.type === "date" ? "instant" : "plain"];
			return [field, BY_TARGET[target.type] ?? "plain"];
		}),
	);
}
