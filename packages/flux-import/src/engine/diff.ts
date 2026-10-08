import type { FieldValue, MappedRecord, Template } from "./template.js";

export type Change = { field: string; before: unknown; after: FieldValue };
export type PlanAction = "create" | "update" | "unchanged";
export type RecordPlan = { action: PlanAction; changes: Change[] };
export type CurrentEntry = { slug: string | null; data: Record<string, unknown> };

function same(before: unknown, after: FieldValue, isDate: boolean): boolean {
	const b = before ?? null;
	if (b === null || after === null) return b === after;
	if (isDate && typeof b === "string" && typeof after === "string") {
		const tb = Date.parse(b);
		return !Number.isNaN(tb) && tb === Date.parse(after);
	}
	return Object.is(b, after);
}

export function planRecord(
	current: CurrentEntry | null,
	next: MappedRecord,
	dateFields: ReadonlySet<string>,
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
		if (!same(before, after, dateFields.has(field)))
			changes.push({ field, before: before ?? null, after });
	}
	return { action: changes.length === 0 ? "unchanged" : "update", changes };
}

export function dateFieldsOf(t: Template): Set<string> {
	return new Set(
		Object.entries(t.fields)
			.filter(([, m]) => m.type === "date")
			.map(([field]) => field),
	);
}
