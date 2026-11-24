import type { Job } from "../../../../engine/types.js";
import type { Msg, Values } from "../../../i18n.js";
import { M } from "./messages.js";

/**
 * What a (dry) rollback job does, from its counters: `total` rows it reverts, split by kind when
 * the job keeps `undo` (made by 0.7.0 or later); `kept` it cannot undo (edited since, locked or
 * refused); `gone` with nothing left to undo.
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

/**
 * The plan in plain words, non-zero lines only: what will be deleted, restored and brought back
 * (or, for a rollback made before 0.7.0, the total), then what stays and what is already gone.
 */
export function planLines(plan: RollbackPlan): { msg: Msg; values: Values }[] {
	const counts: [Msg, number][] =
		plan.deleted === undefined && plan.restored === undefined && plan.recovered === undefined
			? [[M.total, plan.total]]
			: [
					[M.deleted, plan.deleted ?? 0],
					[M.restored, plan.restored ?? 0],
					[M.recovered, plan.recovered ?? 0],
				];
	counts.push([M.kept, plan.kept], [M.gone, plan.gone]);
	return counts
		.filter(([, count]) => count > 0)
		.map(([msg, count]) => ({ msg, values: { count } }));
}
