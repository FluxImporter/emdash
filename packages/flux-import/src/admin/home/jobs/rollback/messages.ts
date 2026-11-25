import type { Msg, PluralMsg } from "../../../i18n.js";

/** The rollback dialog's messages (Rollback.dc.html: check, summary, progress). */
export const M = {
	title: { id: "flux-import.home-rollback.title", message: "Roll back {name}?" },
	titleRolling: { id: "flux-import.home-rollback.title-rolling", message: "Rolling back {name}" },
	checking: {
		id: "flux-import.home-rollback.checking",
		message: "Checking what a rollback would change…",
	},
	checkingLabel: {
		id: "flux-import.home-rollback.checking-label",
		message: "What the rollback would change",
	},
	nothing: {
		id: "flux-import.home-rollback.nothing",
		message: "The rollback has no entries to change.",
	},
	schedule: {
		id: "flux-import.home-rollback.schedule",
		message: "Its schedule {name} will be paused.",
	},
	scheduleUnnamed: {
		id: "flux-import.home-rollback.schedule-unnamed",
		message: "Its schedule will be paused.",
	},
	/** The disabled confirm button while the dry rollback runs. */
	rollBack: { id: "flux-import.home-rollback.roll-back", message: "Roll back" },
	keep: { id: "flux-import.home-rollback.keep", message: "Keep the import" },
	cancel: { id: "flux-import.home-rollback.cancel", message: "Cancel" },
	rolling: { id: "flux-import.home-rollback.rolling", message: "Rolling back…" },
	waiting: {
		id: "flux-import.home-rollback.waiting",
		message: "Another tab is running a batch of this rollback; waiting for it.",
	},
	progress: { id: "flux-import.home-rollback.progress", message: "Rollback progress" },
	progressCount: {
		id: "flux-import.home-rollback.progress-count",
		message: "{done} of {total}",
	},
	/** The progress list, beside each kind's "{done} of {total}". */
	doneDeleted: { id: "flux-import.home-rollback.done-deleted", message: "Deleted" },
	doneRestored: { id: "flux-import.home-rollback.done-restored", message: "Restored" },
	doneRecovered: { id: "flux-import.home-rollback.done-recovered", message: "Brought back" },
	doneKept: { id: "flux-import.home-rollback.done-kept", message: "Kept" },
	/**
	 * The dialog drives the rollback (the server runs only scheduled jobs): closing it stops the
	 * rollback where it is, and the job's row offers "Continue the rollback".
	 */
	closeNote: {
		id: "flux-import.home-rollback.close-note",
		message: "You can close this. To finish the rollback later, continue it from its row in Jobs.",
	},
	finished: { id: "flux-import.home-rollback.finished", message: "Rollback finished." },
	raced: {
		id: "flux-import.home-rollback.raced",
		message: "This import is already being rolled back.",
	},
	continue: { id: "flux-import.home-rollback.continue", message: "Continue the rollback" },
	stopped: {
		id: "flux-import.home-rollback.stopped",
		message: "The rollback stopped before it finished.",
	},
	close: { id: "flux-import.home-rollback.close", message: "Close" },
	/** Where each summary count's entries came from. */
	hints: {
		deleted: { id: "flux-import.home-rollback.hint-deleted", message: "Created by this import" },
		restored: { id: "flux-import.home-rollback.hint-restored", message: "Updated by this import" },
		recovered: {
			id: "flux-import.home-rollback.hint-recovered",
			message: "Moved to Trash or unpublished by it",
		},
		total: {
			id: "flux-import.home-rollback.hint-total",
			message: "Created or updated by this import",
		},
		kept: { id: "flux-import.home-rollback.hint-kept", message: "Edited since, locked or failed" },
	},
} satisfies Record<string, Msg | Record<string, Msg>>;

/** The dialog's counts, one form per plural category. */
export const N = {
	found: {
		id: "flux-import.home-rollback.found",
		one: "A dry rollback found {count} entry.",
		other: "A dry rollback found {count} entries.",
	},
	change: {
		id: "flux-import.home-rollback.change",
		one: "{count} will change.",
		other: "{count} will change.",
	},
	gone: {
		id: "flux-import.home-rollback.gone",
		one: "{count} entry is already gone.",
		other: "{count} entries are already gone.",
	},
	deleted: {
		id: "flux-import.home-rollback.deleted",
		one: "{count} to delete",
		other: "{count} to delete",
	},
	restored: {
		id: "flux-import.home-rollback.restored",
		one: "{count} to restore",
		other: "{count} to restore",
	},
	recovered: {
		id: "flux-import.home-rollback.recovered",
		one: "{count} to bring back",
		other: "{count} to bring back",
	},
	total: {
		id: "flux-import.home-rollback.total",
		one: "{count} to roll back",
		other: "{count} to roll back",
	},
	kept: { id: "flux-import.home-rollback.kept", one: "{count} kept", other: "{count} kept" },
	keptWarning: {
		id: "flux-import.home-rollback.kept-warning",
		one: "{count} entry was edited since the import, is locked or failed. It is kept as it is.",
		other:
			"{count} entries were edited since the import, are locked or failed. They are kept as they are.",
	},
	confirm: {
		id: "flux-import.home-rollback.confirm",
		one: "Roll back {count} entry",
		other: "Roll back {count} entries",
	},
	progressOf: {
		id: "flux-import.home-rollback.progress-of",
		one: "{done} of {count} entry",
		other: "{done} of {count} entries",
	},
} satisfies Record<string, PluralMsg>;
