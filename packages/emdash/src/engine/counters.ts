/**
 * The job counter each record row counts toward, shared by the import pass, the retry tally and
 * the missing phase (M5c), and what the records filters select it by.
 */
import {
	type Counters,
	capErrors,
	capWarnings,
	type EngineDeps,
	iso,
	type RecordFacet,
	type RecordRow,
	type RowFields,
} from "./types.js";

/** The counter a row counts toward; null for a `writing` row. */
export function counterFor(row: Pick<RecordRow, "status" | "action">): keyof Counters | null {
	switch (row.status) {
		case "planned":
			// M5c: a dry run's planned trash or unpublish counts as removed (Ruling 29 M10).
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
					: row.action === "trash" || row.action === "unpublish"
						? "removed"
						: "unchanged";
		case "writing":
			return null;
		default:
			return row.status;
	}
}

/** Whether a row counts toward `Job.warned`: a decided row with warnings. */
export function warnedRow(row: Pick<RecordRow, "status" | "warnings">): boolean {
	return row.status !== "writing" && (row.warnings?.length ?? 0) > 0;
}

/**
 * The row's `facet`: whether it changes an entry (its counter is `created`, `updated` or
 * `removed`, so the "change" rows of a job number exactly those counters' sum), has warnings
 * (`warnedRow`), or both. Undefined when neither, and for a `writing` row.
 */
export function facetOf(
	row: Pick<RecordRow, "status" | "action" | "warnings">,
): RecordFacet | undefined {
	const counter = counterFor(row);
	const change = counter === "created" || counter === "updated" || counter === "removed";
	const warning = warnedRow(row);
	if (change && warning) return "change+warning";
	if (change) return "change";
	return warning ? "warning" : undefined;
}

/** The facets each records filter selects. */
export const FACETS: Record<"change" | "warning", RecordFacet[]> = {
	change: ["change", "change+warning"],
	warning: ["warning", "change+warning"],
};

/**
 * A record row's fields as stored: errors and warnings capped, its `facet` and `updatedAt`. The
 * import pass and the missing phase save every row through here.
 */
export function storedRow(
	fields: RowFields,
	deps: Pick<EngineDeps, "now">,
): Omit<RecordRow, "jobId" | "seq" | "start" | "end"> {
	const { facet: _facet, ...rest } = fields;
	const row = {
		...rest,
		...(fields.errors ? { errors: capErrors(fields.errors) } : {}),
		...(fields.warnings ? { warnings: capWarnings(fields.warnings) } : {}),
	};
	const facet = facetOf(row);
	return { ...row, ...(facet === undefined ? {} : { facet }), updatedAt: iso(deps) };
}
