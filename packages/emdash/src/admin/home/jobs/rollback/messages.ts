import type { Msg, PluralMsg } from "../../../i18n.js";

/** The rollback dialog's messages (Rollback.dc.html: check, summary, progress). */
export const M = {
	title: { id: "fluximporter.home-rollback.title", message: "Roll back {name}?" },
	titleRolling: { id: "fluximporter.home-rollback.title-rolling", message: "Rolling back {name}" },
	checking: {
		id: "fluximporter.home-rollback.checking",
		message: "Checking what a rollback would change…",
	},
	checkingLabel: {
		id: "fluximporter.home-rollback.checking-label",
		message: "What the rollback would change",
	},
	nothing: {
		id: "fluximporter.home-rollback.nothing",
		message: "The rollback has no entries to change.",
	},
	schedule: {
		id: "fluximporter.home-rollback.schedule",
		message: "Its schedule {name} will be paused.",
	},
	scheduleUnnamed: {
		id: "fluximporter.home-rollback.schedule-unnamed",
		message: "Its schedule will be paused.",
	},
	/** The disabled confirm button while the dry rollback runs. */
	rollBack: { id: "fluximporter.home-rollback.roll-back", message: "Roll back" },
	keep: { id: "fluximporter.home-rollback.keep", message: "Keep the import" },
	cancel: { id: "fluximporter.home-rollback.cancel", message: "Cancel" },
	rolling: { id: "fluximporter.home-rollback.rolling", message: "Rolling back…" },
	/** Another holder's lease: a second tab, or the server's scheduled tasks. */
	waiting: {
		id: "fluximporter.home-rollback.waiting",
		message: "Another tab or the server is running a batch of this rollback; waiting for it.",
	},
	progress: { id: "fluximporter.home-rollback.progress", message: "Rollback progress" },
	progressCount: {
		id: "fluximporter.home-rollback.progress-count",
		message: "{done} of {total}",
	},
	/** The progress list, beside each kind's "{done} of {total}". */
	doneDeleted: { id: "fluximporter.home-rollback.done-deleted", message: "Deleted" },
	doneRestored: { id: "fluximporter.home-rollback.done-restored", message: "Restored" },
	doneRecovered: { id: "fluximporter.home-rollback.done-recovered", message: "Brought back" },
	doneKept: { id: "fluximporter.home-rollback.done-kept", message: "Kept" },
	/**
	 * The server drives the rollback too (`scheduled: "open"`), so closing the dialog leaves it
	 * running (Rollback.dc.html).
	 */
	closeNoteRunning: {
		id: "fluximporter.home-rollback.close-note-running",
		message: "You can close this. The rollback keeps running and shows in Jobs.",
	},
	/**
	 * Only the dialog drives the rollback (one stored before the server drove rollbacks): closing
	 * it stops the rollback where it is, and the job's row offers "Continue the rollback".
	 */
	closeNote: {
		id: "fluximporter.home-rollback.close-note",
		message: "You can close this. To finish the rollback later, continue it from its row in Jobs.",
	},
	finished: { id: "fluximporter.home-rollback.finished", message: "Rollback finished." },
	raced: {
		id: "fluximporter.home-rollback.raced",
		message: "This import is already being rolled back.",
	},
	continue: { id: "fluximporter.home-rollback.continue", message: "Continue the rollback" },
	stopped: {
		id: "fluximporter.home-rollback.stopped",
		message: "The rollback stopped before it finished.",
	},
	close: { id: "fluximporter.home-rollback.close", message: "Close" },
	/** Where each summary count's entries came from. */
	hints: {
		deleted: { id: "fluximporter.home-rollback.hint-deleted", message: "Created by this import" },
		restored: { id: "fluximporter.home-rollback.hint-restored", message: "Updated by this import" },
		recovered: {
			id: "fluximporter.home-rollback.hint-recovered",
			message: "Moved to Trash or unpublished by it",
		},
		total: {
			id: "fluximporter.home-rollback.hint-total",
			message: "Created or updated by this import",
		},
		kept: { id: "fluximporter.home-rollback.hint-kept", message: "Edited since, locked or failed" },
	},
} satisfies Record<string, Msg | Record<string, Msg>>;

/** The dialog's counts, one form per plural category. */
export const N = {
	found: {
		id: "fluximporter.home-rollback.found",
		one: "A dry rollback found {count} entry.",
		other: "A dry rollback found {count} entries.",
	},
	change: {
		id: "fluximporter.home-rollback.change",
		one: "{count} will change.",
		other: "{count} will change.",
	},
	gone: {
		id: "fluximporter.home-rollback.gone",
		one: "{count} entry is already gone.",
		other: "{count} entries are already gone.",
	},
	deleted: {
		id: "fluximporter.home-rollback.deleted",
		one: "{count} to delete",
		other: "{count} to delete",
	},
	restored: {
		id: "fluximporter.home-rollback.restored",
		one: "{count} to restore",
		other: "{count} to restore",
	},
	recovered: {
		id: "fluximporter.home-rollback.recovered",
		one: "{count} to bring back",
		other: "{count} to bring back",
	},
	total: {
		id: "fluximporter.home-rollback.total",
		one: "{count} to roll back",
		other: "{count} to roll back",
	},
	kept: { id: "fluximporter.home-rollback.kept", one: "{count} kept", other: "{count} kept" },
	keptWarning: {
		id: "fluximporter.home-rollback.kept-warning",
		one: "{count} entry was edited since the import, is locked or failed. It is kept as it is.",
		other:
			"{count} entries were edited since the import, are locked or failed. They are kept as they are.",
	},
	confirm: {
		id: "fluximporter.home-rollback.confirm",
		one: "Roll back {count} entry",
		other: "Roll back {count} entries",
	},
	progressOf: {
		id: "fluximporter.home-rollback.progress-of",
		one: "{done} of {count} entry",
		other: "{done} of {count} entries",
	},
} satisfies Record<string, PluralMsg>;
