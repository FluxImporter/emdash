import type { Msg } from "../../i18n.js";

/**
 * The Jobs tab's messages. The six job statuses' words are `STATUS_MESSAGES` in `status.ts`
 * (Task 9, F11); only the three rollback states are here.
 */
export const M = {
	loading: { id: "flux-import.home-jobs.loading", message: "Loading the imports" },
	empty: { id: "flux-import.home-jobs.empty", message: "No imports yet." },
	newImport: { id: "flux-import.home-jobs.new-import", message: "New import" },
	loadMore: { id: "flux-import.home-jobs.load-more", message: "Load more" },

	colName: { id: "flux-import.home-jobs.col-name", message: "Import" },
	colTarget: { id: "flux-import.home-jobs.col-target", message: "Collection" },
	colStarted: { id: "flux-import.home-jobs.col-started", message: "Started" },
	colOrigin: { id: "flux-import.home-jobs.col-origin", message: "Started by" },
	colStatus: { id: "flux-import.home-jobs.col-status", message: "Status" },
	colCounts: { id: "flux-import.home-jobs.col-counts", message: "Records" },
	colActions: { id: "flux-import.home-jobs.col-actions", message: "Actions" },

	/** A row's name (plan Ruling 4). */
	named: { id: "flux-import.home-jobs.named", message: "{name}" },
	oneOff: { id: "flux-import.home-jobs.one-off", message: "One-off import" },
	deletedTemplate: { id: "flux-import.home-jobs.deleted-template", message: "Deleted template" },
	rollbackOf: { id: "flux-import.home-jobs.rollback-of", message: "Rollback of {name}" },
	rollbackOfOneOff: {
		id: "flux-import.home-jobs.rollback-of-one-off",
		message: "Rollback of a one-off import",
	},
	rollbackOfDeleted: {
		id: "flux-import.home-jobs.rollback-of-deleted",
		message: "Rollback of an import from a deleted template",
	},

	target: { id: "flux-import.home-jobs.target", message: "{collection} · {locale}" },

	/** Origins (plan Ruling 4): wizard and API jobs cannot be told apart. */
	originAgent: { id: "flux-import.home-jobs.origin-agent", message: "Agent" },
	originSchedule: { id: "flux-import.home-jobs.origin-schedule", message: "Schedule" },
	originAdmin: { id: "flux-import.home-jobs.origin-admin", message: "Admin or API" },

	/** The original import's states while and after it is rolled back (plan Ruling 5). */
	stateRollingBack: { id: "flux-import.home-jobs.state-rolling-back", message: "Rolling back" },
	stateRolledBack: { id: "flux-import.home-jobs.state-rolled-back", message: "Rolled back" },
	stateRollbackCancelled: {
		id: "flux-import.home-jobs.state-rollback-cancelled",
		message: "Rollback cancelled",
	},

	counts: {
		id: "flux-import.home-jobs.counts",
		message: "Created {created} · Updated {updated} · Unchanged {unchanged} · Failed {failed}",
	},
	rollbackCounts: {
		id: "flux-import.home-jobs.rollback-counts",
		message: "Rolled back {reverted} · Kept {kept}",
	},

	/** The row's menu: visible text, and the accessible name that names the row. */
	actions: { id: "flux-import.home-jobs.actions", message: "Actions" },
	actionsRow: { id: "flux-import.home-jobs.actions-row", message: "Actions for {name}, {when}" },
	open: { id: "flux-import.home-jobs.open", message: "Open" },
	openRow: { id: "flux-import.home-jobs.open-row", message: "Open {name}, {when}" },
	log: { id: "flux-import.home-jobs.log", message: "Download log" },
	logRow: { id: "flux-import.home-jobs.log-row", message: "Download log {name}, {when}" },
	failedLog: { id: "flux-import.home-jobs.failed-log", message: "Download failed records" },
	failedLogRow: {
		id: "flux-import.home-jobs.failed-log-row",
		message: "Download failed records {name}, {when}",
	},
	pause: { id: "flux-import.home-jobs.pause", message: "Pause" },
	pauseRow: { id: "flux-import.home-jobs.pause-row", message: "Pause {name}, {when}" },
	resume: { id: "flux-import.home-jobs.resume", message: "Resume" },
	resumeRow: { id: "flux-import.home-jobs.resume-row", message: "Resume {name}, {when}" },
	retry: { id: "flux-import.home-jobs.retry", message: "Retry failed records" },
	retryRow: {
		id: "flux-import.home-jobs.retry-row",
		message: "Retry failed records {name}, {when}",
	},
	cancel: { id: "flux-import.home-jobs.cancel", message: "Cancel" },
	cancelRow: { id: "flux-import.home-jobs.cancel-row", message: "Cancel {name}, {when}" },
	rollBack: { id: "flux-import.home-jobs.roll-back", message: "Roll back" },
	rollBackRow: { id: "flux-import.home-jobs.roll-back-row", message: "Roll back {name}, {when}" },
	continueRollback: {
		id: "flux-import.home-jobs.continue-rollback",
		message: "Continue the rollback",
	},
	continueRollbackRow: {
		id: "flux-import.home-jobs.continue-rollback-row",
		message: "Continue the rollback {name}, {when}",
	},

	cancelTitle: { id: "flux-import.home-jobs.cancel-title", message: "Cancel the import {name}?" },
	cancelSentence: {
		id: "flux-import.home-jobs.cancel-sentence",
		message: "Records already written stay.",
	},
	cancelConfirm: { id: "flux-import.home-jobs.cancel-confirm", message: "Cancel the import" },

	/** Announcements (the page's one live region). */
	paused: { id: "flux-import.home-jobs.paused", message: "Paused {name}." },
	cancelled: { id: "flux-import.home-jobs.cancelled", message: "Cancelled {name}." },
	scheduled: {
		id: "flux-import.home-jobs.scheduled",
		message: "The schedule runs this job; its status updates here.",
	},
} satisfies Record<string, Msg>;
