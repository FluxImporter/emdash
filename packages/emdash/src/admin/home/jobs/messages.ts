import type { Msg, PluralMsg } from "../../i18n.js";

/**
 * The Jobs tab's messages. The six job statuses' words are `STATUS_MESSAGES` in `status.ts`
 * (Task 9, F11); only the three rollback states are here.
 */
export const M = {
	loading: { id: "fluximporter.home-jobs.loading", message: "Loading the imports" },
	loadFailed: { id: "fluximporter.home-jobs.load-failed", message: "Imports could not be loaded." },
	empty: { id: "fluximporter.home-jobs.empty", message: "No imports yet" },
	emptyText: {
		id: "fluximporter.home-jobs.empty-text",
		message: "Bring in a CSV, JSON, XML or Excel file, or a URL feed. Every run shows up here.",
	},
	howImportsWork: { id: "fluximporter.home-jobs.how-imports-work", message: "How imports work" },

	colName: { id: "fluximporter.home-jobs.col-name", message: "Import" },
	colStarted: { id: "fluximporter.home-jobs.col-started", message: "Started" },
	colStatus: { id: "fluximporter.home-jobs.col-status", message: "Status" },
	colCounts: { id: "fluximporter.home-jobs.col-counts", message: "Records" },
	colActions: { id: "fluximporter.home-jobs.col-actions", message: "Actions" },

	/** A row's name (plan Ruling 4). */
	named: { id: "fluximporter.home-jobs.named", message: "{name}" },
	oneOff: { id: "fluximporter.home-jobs.one-off", message: "One-off import" },
	deletedTemplate: { id: "fluximporter.home-jobs.deleted-template", message: "Deleted template" },
	rollbackOf: { id: "fluximporter.home-jobs.rollback-of", message: "Rollback of {name}" },
	rollbackOfOneOff: {
		id: "fluximporter.home-jobs.rollback-of-one-off",
		message: "Rollback of a one-off import",
	},
	rollbackOfDeleted: {
		id: "fluximporter.home-jobs.rollback-of-deleted",
		message: "Rollback of an import from a deleted template",
	},

	target: { id: "fluximporter.home-jobs.target", message: "{collection} · {locale}" },

	/** Origins (plan Ruling 4): only agents and schedules are recorded; wizard and API jobs carry none. */
	originAgent: { id: "fluximporter.home-jobs.origin-agent", message: "Agent" },
	originSchedule: { id: "fluximporter.home-jobs.origin-schedule", message: "Schedule" },

	/** The original import's states while and after it is rolled back (plan Ruling 5). */
	stateRollingBack: { id: "fluximporter.home-jobs.state-rolling-back", message: "Rolling back" },
	stateRolledBack: { id: "fluximporter.home-jobs.state-rolled-back", message: "Rolled back" },
	stateRollbackCancelled: {
		id: "fluximporter.home-jobs.state-rollback-cancelled",
		message: "Rollback cancelled",
	},

	/** The row's menu: the trigger's and each item's accessible name names the row. */
	actionsRow: { id: "fluximporter.home-jobs.actions-row", message: "Actions for {name}, {when}" },
	open: { id: "fluximporter.home-jobs.open", message: "Open" },
	openRow: { id: "fluximporter.home-jobs.open-row", message: "Open {name}, {when}" },
	log: { id: "fluximporter.home-jobs.log", message: "Download log" },
	logRow: { id: "fluximporter.home-jobs.log-row", message: "Download log {name}, {when}" },
	failedLog: { id: "fluximporter.home-jobs.failed-log", message: "Download failed records" },
	failedLogRow: {
		id: "fluximporter.home-jobs.failed-log-row",
		message: "Download failed records {name}, {when}",
	},
	pause: { id: "fluximporter.home-jobs.pause", message: "Pause" },
	pauseRow: { id: "fluximporter.home-jobs.pause-row", message: "Pause {name}, {when}" },
	resume: { id: "fluximporter.home-jobs.resume", message: "Resume" },
	resumeRow: { id: "fluximporter.home-jobs.resume-row", message: "Resume {name}, {when}" },
	retry: { id: "fluximporter.home-jobs.retry", message: "Retry failed records" },
	retryRow: {
		id: "fluximporter.home-jobs.retry-row",
		message: "Retry failed records {name}, {when}",
	},
	cancel: { id: "fluximporter.home-jobs.cancel", message: "Cancel" },
	cancelRow: { id: "fluximporter.home-jobs.cancel-row", message: "Cancel {name}, {when}" },
	rollBack: { id: "fluximporter.home-jobs.roll-back", message: "Roll back" },
	rollBackRow: { id: "fluximporter.home-jobs.roll-back-row", message: "Roll back {name}, {when}" },
	continueRollback: {
		id: "fluximporter.home-jobs.continue-rollback",
		message: "Continue the rollback",
	},
	retryRollback: { id: "fluximporter.home-jobs.retry-rollback", message: "Retry the rollback" },
	retryRollbackRow: {
		id: "fluximporter.home-jobs.retry-rollback-row",
		message: "Retry the rollback {name}, {when}",
	},
	continueRollbackRow: {
		id: "fluximporter.home-jobs.continue-rollback-row",
		message: "Continue the rollback {name}, {when}",
	},

	cancelTitle: { id: "fluximporter.home-jobs.cancel-title", message: "Cancel the import {name}?" },
	cancelSentence: {
		id: "fluximporter.home-jobs.cancel-sentence",
		message: "Records already written stay.",
	},
	cancelSchedule: {
		id: "fluximporter.home-jobs.cancel-schedule",
		message: "Its schedule {name} will be paused.",
	},
	cancelScheduleUnnamed: {
		id: "fluximporter.home-jobs.cancel-schedule-unnamed",
		message: "Its schedule will be paused.",
	},
	cancelConfirm: { id: "fluximporter.home-jobs.cancel-confirm", message: "Cancel the import" },
	cancelKeep: { id: "fluximporter.home-jobs.cancel-keep", message: "Keep the import" },

	/** Pages: `jobs/summaries` has no total, so the range says "+" while more pages exist. */
	pages: { id: "fluximporter.home-jobs.pages", message: "Pages" },
	previousPage: { id: "fluximporter.home-jobs.previous-page", message: "Previous page" },
	nextPage: { id: "fluximporter.home-jobs.next-page", message: "Next page" },
	range: { id: "fluximporter.home-jobs.range", message: "{from}–{to} of {total}" },
	rangeMore: { id: "fluximporter.home-jobs.range-more", message: "{from}–{to} of {total}+" },

	/** Announcements (the page's one live region). */
	paused: { id: "fluximporter.home-jobs.paused", message: "Paused {name}." },
	cancelled: { id: "fluximporter.home-jobs.cancelled", message: "Cancelled {name}." },
	scheduled: {
		id: "fluximporter.home-jobs.scheduled",
		message: "The schedule runs this job; its status updates here.",
	},
} satisfies Record<string, Msg>;

/** The summary line's counts (Jobs.dc.html: "23 imports · 1 running · 1 failed"). */
export const N = {
	imports: {
		id: "fluximporter.home-jobs.summary-imports",
		one: "{count} import",
		other: "{count} imports",
	},
	/** While more pages exist: the counts are of the loaded rows, newest first. */
	latest: {
		id: "fluximporter.home-jobs.summary-latest",
		one: "Latest {count} import",
		other: "Latest {count} imports",
	},
	running: {
		id: "fluximporter.home-jobs.summary-running",
		one: "{count} running",
		other: "{count} running",
	},
	failed: {
		id: "fluximporter.home-jobs.summary-failed",
		one: "{count} failed",
		other: "{count} failed",
	},
} satisfies Record<string, PluralMsg>;
