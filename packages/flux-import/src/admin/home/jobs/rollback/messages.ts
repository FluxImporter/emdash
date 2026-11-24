import type { Msg } from "../../../i18n.js";

/** The rollback dialog's messages (spec "Roll back"). */
export const M = {
	title: { id: "flux-import.home-rollback.title", message: "Roll back {name}?" },
	checking: {
		id: "flux-import.home-rollback.checking",
		message: "Checking what the rollback will do…",
	},
	deleted: {
		id: "flux-import.home-rollback.deleted",
		message: "Entries the import created, to delete: {count}",
	},
	restored: {
		id: "flux-import.home-rollback.restored",
		message: "Entries it updated, to restore to their earlier version: {count}",
	},
	recovered: {
		id: "flux-import.home-rollback.recovered",
		message: "Entries it moved to Trash or unpublished, to bring back: {count}",
	},
	kept: {
		id: "flux-import.home-rollback.kept",
		message: "Entries edited since, which stay as they are: {count}",
	},
	gone: { id: "flux-import.home-rollback.gone", message: "Entries already gone: {count}" },
	total: { id: "flux-import.home-rollback.total", message: "Entries to roll back: {count}" },
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
	rollBack: { id: "flux-import.home-rollback.roll-back", message: "Roll back" },
	keep: { id: "flux-import.home-rollback.keep", message: "Keep the import" },
	rolling: { id: "flux-import.home-rollback.rolling", message: "Rolling back…" },
	waiting: {
		id: "flux-import.home-rollback.waiting",
		message: "Another tab is running a batch of this rollback; waiting for it.",
	},
	progress: { id: "flux-import.home-rollback.progress", message: "Entries rolled back" },
	progressCount: {
		id: "flux-import.home-rollback.progress-count",
		message: "{done} of {total}",
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
} satisfies Record<string, Msg>;
