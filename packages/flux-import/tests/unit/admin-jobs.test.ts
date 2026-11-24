import { describe, expect, it } from "vitest";
import {
	countsOf,
	type JobAction,
	jobActions,
	jobName,
	jobState,
	originMsg,
	stateMsg,
} from "../../src/admin/home/jobs/actions.js";
import { interpolate } from "../../src/admin/i18n.js";
import type { JobStatus } from "../../src/engine/types.js";
import type { JobListItem } from "../../src/plugin/summaries.js";
import { item } from "../admin/home-fixtures.js";

const counters = (over: Partial<JobListItem["counters"]> = {}): JobListItem["counters"] => ({
	created: 0,
	updated: 0,
	unchanged: 0,
	failed: 0,
	conflict: 0,
	locked: 0,
	filtered: 0,
	reverted: 0,
	removed: 0,
	...over,
});

/** `row` without a `templateId`: a job whose template was inline. */
function inline(row: JobListItem): JobListItem {
	const { templateId: _, ...rest } = row;
	return rest;
}

const text = (d: { msg: { message: string }; values?: Record<string, string | number> }) =>
	interpolate(d.msg.message, d.values);

/** An import of `status`, not rollbackable unless `over` says so. */
const imp = (status: JobStatus, over: Partial<JobListItem> = {}) =>
	item({ status, rollbackable: false, counters: counters(), ...over });
const rb = (status: JobStatus, over: Partial<JobListItem> = {}) =>
	item({
		kind: "rollback",
		status,
		rollbackable: false,
		rollbackOf: "J0",
		counters: counters(),
		...over,
	});

describe("jobActions (plan Rulings 3-5, 11)", () => {
	const rows: [string, JobListItem, JobAction[]][] = [
		["import created", imp("created"), ["open", "log", "pause", "cancel"]],
		["import running", imp("running"), ["open", "log", "pause", "cancel"]],
		["import paused", imp("paused"), ["open", "log", "resume", "cancel"]],
		["import failed", imp("failed"), ["open", "log", "resume", "cancel"]],
		["import completed, nothing to retry", imp("completed"), ["open", "log"]],
		[
			"import completed and rollbackable",
			imp("completed", { rollbackable: true }),
			["open", "log", "rollback"],
		],
		[
			"import completed with failed records",
			imp("completed", { counters: counters({ failed: 1 }) }),
			["open", "log", "retry"],
		],
		[
			"import completed with a conflict",
			imp("completed", { counters: counters({ conflict: 1 }) }),
			["open", "log", "retry"],
		],
		[
			"import completed with a locked record",
			imp("completed", { counters: counters({ locked: 2 }), rollbackable: true }),
			["open", "log", "retry", "rollback"],
		],
		["import cancelled", imp("cancelled"), ["open", "log"]],
		[
			"import rolled back: no retry, no second rollback",
			imp("completed", {
				rolledBackBy: "R1",
				rollbackStatus: "completed",
				counters: counters({ failed: 1 }),
			}),
			["open", "log"],
		],
		[
			"import failed and rolled back: no resume",
			imp("failed", { rolledBackBy: "R1", rollbackStatus: "running" }),
			["open", "log", "cancel"],
		],
		["dry run (completed)", imp("completed", { dryRun: true }), ["open", "log"]],
		[
			"scheduled import, paused",
			imp("paused", { origin: "schedule", scheduleId: "SC1" }),
			["open", "log", "resume", "cancel"],
		],
		["rollback created", rb("created"), ["log", "continueRollback"]],
		["rollback running", rb("running"), ["log", "continueRollback"]],
		["rollback paused", rb("paused"), ["log", "continueRollback"]],
		["rollback failed", rb("failed"), ["log", "continueRollback"]],
		["rollback completed", rb("completed"), ["log"]],
		["rollback cancelled", rb("cancelled"), ["log"]],
	];
	it.each(rows)("%s", (_, row, expected) => {
		expect(jobActions(row)).toEqual(expected);
	});
});

describe("jobState (plan Ruling 5)", () => {
	it.each([
		["no rollback", imp("completed"), "completed"],
		["failed, no rollback", imp("failed"), "failed"],
		[
			"rollback completed",
			imp("completed", { rolledBackBy: "R1", rollbackStatus: "completed" }),
			"rolled_back",
		],
		[
			"rollback running",
			imp("completed", { rolledBackBy: "R1", rollbackStatus: "running" }),
			"rolling_back",
		],
		[
			"rollback paused",
			imp("completed", { rolledBackBy: "R1", rollbackStatus: "paused" }),
			"rolling_back",
		],
		// Synthetic (F20): the engine never cancels a rollback job; the state is kept for robustness.
		[
			"rollback cancelled",
			imp("completed", { rolledBackBy: "R1", rollbackStatus: "cancelled" }),
			"rollback_cancelled",
		],
		["rollback job gone", imp("completed", { rolledBackBy: "R1" }), "rolling_back"],
		["a rollback job reads its own status", rb("running"), "running"],
	] as const)("%s", (_, row, expected) => {
		expect(jobState(row)).toBe(expected);
	});

	it("words every state", () => {
		expect(stateMsg("running").message).toBe("Running");
		expect(stateMsg("rolling_back").message).toBe("Rolling back");
		expect(stateMsg("rolled_back").message).toBe("Rolled back");
		expect(stateMsg("rollback_cancelled").message).toBe("Rollback cancelled");
	});
});

describe("jobName (plan Ruling 4)", () => {
	const templates = new Map([["T1", "Products feed"]]);
	it.each([
		["template listed", imp("completed", { templateId: "T1" }), "Products feed"],
		["inline template", inline(imp("completed")), "One-off import"],
		["deleted template", imp("completed", { templateId: "T9" }), "Deleted template"],
		[
			"rollback of a listed template",
			rb("completed", { templateId: "T1" }),
			"Rollback of Products feed",
		],
		["rollback of an inline template", inline(rb("completed")), "Rollback of a one-off import"],
		[
			"rollback of a deleted template",
			rb("completed", { templateId: "T9" }),
			"Rollback of an import from a deleted template",
		],
	])("%s", (_, row, expected) => {
		expect(text(jobName(row, templates))).toBe(expected);
	});
});

describe("originMsg and countsOf", () => {
	it("names the origin: Agent, Schedule, else Admin or API", () => {
		expect(originMsg(imp("completed", { origin: "agent" })).message).toBe("Agent");
		expect(originMsg(imp("completed", { origin: "schedule" })).message).toBe("Schedule");
		expect(originMsg(imp("completed")).message).toBe("Admin or API");
	});

	it("counts an import's four and a rollback's reverted and kept", () => {
		const c = counters({ created: 3, updated: 2, unchanged: 1, failed: 4, conflict: 5 });
		expect(text(countsOf(imp("completed", { counters: c })))).toBe(
			"Created 3 · Updated 2 · Unchanged 1 · Failed 4",
		);
		const r = counters({ reverted: 7, conflict: 1, failed: 1, locked: 1, unchanged: 9 });
		expect(text(countsOf(rb("completed", { counters: r })))).toBe("Rolled back 7 · Kept 3");
	});
});
