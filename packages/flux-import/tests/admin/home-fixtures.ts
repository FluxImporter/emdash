import type { ScheduleView } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { JobListItem } from "../../src/plugin/summaries.js";
import type { TemplateSummary } from "../../src/plugin/templates.js";

/**
 * Fixtures for the Imports home's component tests (M7b): one valid row of each kind the home
 * lists, with `over` laid on top. Dates are fixed so the rows read the same on every run.
 */

/** A finished real import of `posts`; `over` changes any field. */
export function item(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "J1",
		kind: "import",
		status: "completed",
		dryRun: false,
		collection: "posts",
		locale: "en",
		templateId: "T1",
		rollbackable: true,
		counters: {
			created: 3,
			updated: 2,
			unchanged: 1,
			failed: 0,
			conflict: 0,
			locked: 0,
			filtered: 0,
			reverted: 0,
			removed: 0,
		},
		createdAt: "2026-11-24T10:14:00.000Z",
		updatedAt: "2026-11-24T10:20:00.000Z",
		...over,
	};
}

/** An enabled, idle schedule that runs a saved template from a saved source every night. */
export function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
	return {
		id: "SC1",
		name: "Nightly",
		templateId: "T1",
		templateRevision: 1,
		sourceId: "S1",
		sourcePin: "pin-1",
		cron: "0 3 * * *",
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		enabled: true,
		runs: [],
		launchFailures: 0,
		armedBy: "U1",
		revision: 1,
		createdAt: "2026-11-20T09:00:00.000Z",
		updatedAt: "2026-11-20T09:00:00.000Z",
		createdBy: "U1",
		updatedBy: "U1",
		nextRunAt: "2026-11-25T03:00:00.000Z",
		...over,
	};
}

/** A saved template of `posts`, without its body (what `templates/list` answers). */
export function templateRow(over: Partial<TemplateSummary> = {}): TemplateSummary {
	return {
		id: "T1",
		name: "Products feed",
		revision: 1,
		collection: "posts",
		locale: "en",
		format: "json",
		createdAt: "2026-11-20T09:00:00.000Z",
		updatedAt: "2026-11-20T09:00:00.000Z",
		createdBy: "U1",
		updatedBy: "U1",
		...over,
	};
}

/** A saved URL source without a credential or a fetch yet. */
export function sourceRow(over: Partial<SourceRow> = {}): SourceRow {
	return {
		id: "S1",
		name: "Feed",
		url: "https://feed.example.com/a/b.json",
		createdAt: "2026-11-20T09:00:00.000Z",
		updatedAt: "2026-11-20T09:00:00.000Z",
		...over,
	};
}
