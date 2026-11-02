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

/**
 * The record's plan: `create` without a current entry, else `update` when the slug, a data
 * field, a media field or a link differs, else `unchanged`. `links` is given when the template
 * maps links, `media` when it maps image or file fields.
 */
export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links?: LinkPlan,
	media?: Readonly<Record<string, MediaPlanItem | null>>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
		if (next.slug !== undefined) changes.push({ field: "slug", before: null, after: next.slug });
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
		if (media) changes.push(...mediaChanges(media, null));
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
