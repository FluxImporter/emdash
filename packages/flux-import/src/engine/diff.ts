import type { FieldValue, MappedRecord, Template } from "./template.js";

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
			return Object.is(b, after);
	}
}

export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
): RecordPlan {
	const changes: Change[] = [];
	if (current === null) {
		if (next.slug !== undefined) changes.push({ field: "slug", before: null, after: next.slug });
		for (const [field, after] of Object.entries(next.data)) {
			if (after !== null) changes.push({ field, before: null, after });
		}
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
