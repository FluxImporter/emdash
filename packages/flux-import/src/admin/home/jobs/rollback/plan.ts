import type { Job } from "../../../../engine/types.js";
import type { Msg, PluralMsg } from "../../../i18n.js";
import { M, N } from "./messages.js";

/**
 * What a (dry) rollback job does, from its counters: `total` rows it reverts, split by kind when
 * the job keeps `undo` (made by 0.7.0 or later); `kept` it cannot roll back (edited since,
 * locked or failed); `gone` with nothing left to undo.
 */
export interface RollbackPlan {
	total: number;
	deleted?: number;
	restored?: number;
	recovered?: number;
	kept: number;
	gone: number;
}

export function planOf(job: Job): RollbackPlan {
	const { counters, undo } = job;
	return {
		total: counters.reverted ?? 0,
		...(undo === undefined
			? {}
			: { deleted: undo.deleted, restored: undo.restored, recovered: undo.recovered }),
		kept: counters.conflict + counters.failed + counters.locked,
		gone: counters.unchanged,
	};
}

/** What a rollback does with a kind of entry; `kept` is the one it leaves as it is. */
export type TileKind = "deleted" | "restored" | "recovered" | "total" | "kept";

/** One count of the rollback's summary: the count, its words and where those entries came from. */
export interface PlanTile {
	kind: TileKind;
	count: number;
	label: PluralMsg;
	hint: Msg;
}

const tile = (kind: TileKind, count: number): PlanTile => ({
	kind,
	count,
	label: N[kind],
	hint: M.hints[kind],
});

/**
 * The summary's four counts (Rollback.dc.html): to delete, to restore, to bring back and kept,
 * zeros included so the four always read in the same place. A rollback made before 0.7.0 does not
 * split its total: "to roll back" and kept.
 */
export function planTiles(plan: RollbackPlan): PlanTile[] {
	if (plan.deleted === undefined && plan.restored === undefined && plan.recovered === undefined) {
		return [tile("total", plan.total), tile("kept", plan.kept)];
	}
	return [
		tile("deleted", plan.deleted ?? 0),
		tile("restored", plan.restored ?? 0),
		tile("recovered", plan.recovered ?? 0),
		tile("kept", plan.kept),
	];
}

/** The entries a dry rollback looked at: those it reverts, keeps, and finds already gone. */
export const foundOf = (plan: RollbackPlan) => plan.total + plan.kept + plan.gone;
