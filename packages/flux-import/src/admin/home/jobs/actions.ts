import type { JobStatus } from "../../../engine/types.js";
import type { JobListItem } from "../../../plugin/summaries.js";
import type { Msg, Values } from "../../i18n.js";
import { M } from "./messages.js";
import { STATUS_MESSAGES } from "./status.js";

/** What a Jobs row can offer; `log` covers both downloads (plan Rulings 3-5, 11). */
export type JobAction =
	| "open"
	| "log"
	| "pause"
	| "resume"
	| "cancel"
	| "retry"
	| "rollback"
	| "continueRollback"
	| "retryRollback";

const unfinished = (s: JobStatus) =>
	s === "created" || s === "running" || s === "paused" || s === "failed";

/**
 * `jobs/retry` takes it (`transitionJob`): completed, not a dry run, with failed, conflict or
 * locked records to try again, and not rolled back.
 */
function retryable(i: JobListItem): boolean {
	const { failed, conflict, locked } = i.counters;
	return (
		i.status === "completed" &&
		!i.dryRun &&
		failed + conflict + locked > 0 &&
		i.rolledBackBy === undefined
	);
}

/**
 * The actions a row's state allows. An import: Open and the log always; Pause while it may run;
 * Resume when stopped, and Cancel until it ends, both only while it is not rolled back; Retry
 * (`retryable`); Roll back when the server says it can (`rollbackable`). A rollback job: the log;
 * Continue the rollback until it ends; Retry the rollback once it finished with rows it could not
 * revert.
 */
export function jobActions(i: JobListItem): JobAction[] {
	const s = i.status;
	if (i.kind === "rollback") {
		if (unfinished(s)) return ["log", "continueRollback"];
		return retryable(i) ? ["log", "retryRollback"] : ["log"];
	}
	const actions: JobAction[] = ["open", "log"];
	const rolledBack = i.rolledBackBy !== undefined;
	if (s === "created" || s === "running") actions.push("pause");
	if ((s === "paused" || s === "failed") && !rolledBack) actions.push("resume");
	if (unfinished(s) && !rolledBack) actions.push("cancel");
	if (retryable(i)) actions.push("retry");
	if (i.rollbackable) actions.push("rollback");
	return actions;
}

/** A row's state: its status, or for a rolled-back import its rollback's (plan Ruling 5). */
export type JobState = JobStatus | "rolling_back" | "rolled_back" | "rollback_cancelled";

export function jobState(i: JobListItem): JobState {
	if (i.kind === "rollback" || i.rolledBackBy === undefined) return i.status;
	if (i.rollbackStatus === "completed") return "rolled_back";
	// Unreachable today: the engine never cancels a rollback job (F20). Kept for robustness.
	if (i.rollbackStatus === "cancelled") return "rollback_cancelled";
	// Running, stopped, or the rollback job gone: the original is still being rolled back.
	return "rolling_back";
}

/** A state in words (the six statuses come from Task 9's `STATUS_MESSAGES`, F11). */
export function stateMsg(state: JobState): Msg {
	switch (state) {
		case "rolling_back":
			return M.stateRollingBack;
		case "rolled_back":
			return M.stateRolledBack;
		case "rollback_cancelled":
			return M.stateRollbackCancelled;
		default:
			return STATUS_MESSAGES[state];
	}
}

/**
 * The template a job ran (plan Ruling 4): its name from the template list, "One-off import"
 * without a `templateId`, "Deleted template" when the ID is no longer listed.
 */
export function templateName(
	i: JobListItem,
	templates: ReadonlyMap<string, string>,
): { msg: Msg; values?: Values } {
	if (i.templateId === undefined) return { msg: M.oneOff };
	const name = templates.get(i.templateId);
	return name === undefined ? { msg: M.deletedTemplate } : { msg: M.named, values: { name } };
}

/** A row's name: the template's, or "Rollback of {name}" for a rollback job (which keeps the original's `templateId`). */
export function jobName(
	i: JobListItem,
	templates: ReadonlyMap<string, string>,
): { msg: Msg; values?: Values } {
	const own = templateName(i, templates);
	if (i.kind !== "rollback") return own;
	if (own.msg === M.oneOff) return { msg: M.rollbackOfOneOff };
	if (own.msg === M.deletedTemplate) return { msg: M.rollbackOfDeleted };
	return { msg: M.rollbackOf, ...(own.values === undefined ? {} : { values: own.values }) };
}

/** Who started a job (plan Ruling 4, Fact D2): only agents and schedules are recorded. */
export function originMsg(i: JobListItem): Msg {
	if (i.origin === "agent") return M.originAgent;
	if (i.origin === "schedule") return M.originSchedule;
	return M.originAdmin;
}

/** A row's counts: an import's four, or a rollback's reverted and kept (as the rollback dialog counts them). */
export function countsOf(i: JobListItem): { msg: Msg; values: Values } {
	const c = i.counters;
	if (i.kind === "rollback") {
		return {
			msg: M.rollbackCounts,
			values: { reverted: c.reverted, kept: c.conflict + c.failed + c.locked },
		};
	}
	return {
		msg: M.counts,
		values: { created: c.created, updated: c.updated, unchanged: c.unchanged, failed: c.failed },
	};
}
