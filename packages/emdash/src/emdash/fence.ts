import { sql } from "kysely";
import type { EmDashDb } from "./locks.js";

/**
 * Whether the site takes writes now (M6b spec "Site fence", Rulings 19, 31): `"clear"`, or what
 * fences it. fluximporter stands down for a running export too, which EmDash itself does not.
 */
export type Fence = "clear" | "import" | "export" | "media" | "error";

interface FenceRow {
	media_state: string | null;
	import_id: string | null;
	export_id: string | null;
}

/**
 * EmDash's `readSiteWriteFence` query (emdash 1.2.0 `src/transfer/fence.ts:80-98`, Fact V4), word for
 * word: EmDash exports no fence API, so the internal tables are read as the lock reader reads
 * `_emdash_entry_locks`. A static query: no value is interpolated. Task 8 pins it against a site.
 */
const FENCE_QUERY = sql<FenceRow>`
	SELECT
		(
			SELECT state FROM _emdash_media_usage_activation
			WHERE task_key = 'incremental_capture'
		) AS media_state,
		(
			SELECT id FROM _emdash_transfer_operations
			WHERE kind = 'import'
				AND (
					state IN ('running', 'verifying')
					OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL)
				)
			LIMIT 1
		) AS import_id,
		(
			SELECT id FROM _emdash_transfer_operations
			WHERE kind = 'export' AND state = 'running'
			LIMIT 1
		) AS export_id
`;

const MEDIA_QUERY = sql<{ state: string }>`
	SELECT state FROM _emdash_media_usage_activation WHERE task_key = 'incremental_capture'
`;

/**
 * EmDash's `isMissingTableError` (emdash 1.2.0 `src/utils/db-errors.ts:58-72`): SQLite, D1 and
 * PostgreSQL wording, compared in lower case.
 */
function isMissingTable(e: unknown): boolean {
	const message = (e instanceof Error ? e.message : typeof e === "string" ? e : "").toLowerCase();
	if (message.includes("no such table")) return true;
	if (message.includes("does not exist") || message.includes("doesn't exist")) {
		return message.includes("relation") || message.includes("table");
	}
	return false;
}

/** Before the transfer tables exist, the media fence alone (as EmDash's fallback). */
async function mediaFence(db: EmDashDb): Promise<Fence> {
	try {
		const row = (await MEDIA_QUERY.execute(db)).rows[0];
		return row?.state === "activating" ? "media" : "clear";
	} catch (e) {
		return isMissingTable(e) ? "clear" : "error";
	}
}

/** One read of the site fence; a read error counts as fenced (EmDash's `TRANSFER_FENCE_CHECK_FAILED`). */
export async function readFence(db: EmDashDb): Promise<Fence> {
	let row: FenceRow | undefined;
	try {
		row = (await FENCE_QUERY.execute(db)).rows[0];
	} catch (e) {
		return isMissingTable(e) ? mediaFence(db) : "error";
	}
	if (row?.import_id) return "import";
	if (row?.export_id) return "export";
	if (row?.media_state === "activating") return "media";
	return "clear";
}
