/**
 * The job counter each record row counts toward, shared by the import pass, the retry tally and
 * the missing phase (M5c).
 */
import type { Counters, RecordRow } from "./types.js";

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
