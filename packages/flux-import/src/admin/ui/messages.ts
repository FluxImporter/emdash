import type { Msg, PluralMsg } from "../i18n.js";

/** Messages the admin's screens share: record counts and the five shared states. */
export const M = {
	noChanges: { id: "flux-import.ui.no-changes", message: "No changes" },
	forbiddenTitle: {
		id: "flux-import.ui.forbidden-title",
		message: "Only administrators can import.",
	},
	forbiddenText: {
		id: "flux-import.ui.forbidden-text",
		message: "Ask an administrator of this site for access.",
	},
	failedSafe: { id: "flux-import.ui.failed-safe", message: "Your imports are not affected." },
	siteImportTitle: { id: "flux-import.ui.site-import-title", message: "A site import is running." },
	siteImportText: {
		id: "flux-import.ui.site-import-text",
		message: "Imports, schedules and the wizard wait until it ends. This page updates by itself.",
	},
} satisfies Record<string, Msg>;

/**
 * Record counts, the same words on Jobs, the run log and the Run step (Copy: "2 created ·
 * 10 updated"). Keys follow the job's counters.
 */
export const COUNTS = {
	created: { id: "flux-import.ui.count-created", one: "{count} created", other: "{count} created" },
	updated: { id: "flux-import.ui.count-updated", one: "{count} updated", other: "{count} updated" },
	unchanged: {
		id: "flux-import.ui.count-unchanged",
		one: "{count} unchanged",
		other: "{count} unchanged",
	},
	failed: { id: "flux-import.ui.count-failed", one: "{count} failed", other: "{count} failed" },
	conflict: {
		id: "flux-import.ui.count-conflict",
		one: "{count} conflict",
		other: "{count} conflicts",
	},
	locked: { id: "flux-import.ui.count-locked", one: "{count} locked", other: "{count} locked" },
	filtered: {
		id: "flux-import.ui.count-filtered",
		one: "{count} filtered out",
		other: "{count} filtered out",
	},
	reverted: {
		id: "flux-import.ui.count-reverted",
		one: "{count} restored",
		other: "{count} restored",
	},
	removed: { id: "flux-import.ui.count-removed", one: "{count} deleted", other: "{count} deleted" },
	kept: { id: "flux-import.ui.count-kept", one: "{count} kept", other: "{count} kept" },
} satisfies Record<string, PluralMsg>;

export type CountKey = keyof typeof COUNTS;
