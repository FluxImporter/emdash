import type { Msg, PluralMsg } from "../i18n.js";

/** Messages the admin's screens share: record counts and the five shared states. */
export const M = {
	noChanges: { id: "fluximporter.ui.no-changes", message: "No changes" },
	forbiddenTitle: {
		id: "fluximporter.ui.forbidden-title",
		message: "Only administrators can import.",
	},
	forbiddenText: {
		id: "fluximporter.ui.forbidden-text",
		message: "Ask an administrator of this site for access.",
	},
	failedSafe: { id: "fluximporter.ui.failed-safe", message: "Your imports are not affected." },
	siteImportTitle: {
		id: "fluximporter.ui.site-import-title",
		message: "A site import is running.",
	},
	siteImportText: {
		id: "fluximporter.ui.site-import-text",
		message: "Imports, schedules and the wizard wait until it ends. This page updates by itself.",
	},
} satisfies Record<string, Msg>;

/**
 * Record counts, the same words on Jobs, the run log and the Run step (Copy: "2 created ·
 * 10 updated"). Keys follow the job's counters.
 */
export const COUNTS = {
	created: {
		id: "fluximporter.ui.count-created",
		one: "{count} created",
		other: "{count} created",
	},
	updated: {
		id: "fluximporter.ui.count-updated",
		one: "{count} updated",
		other: "{count} updated",
	},
	unchanged: {
		id: "fluximporter.ui.count-unchanged",
		one: "{count} unchanged",
		other: "{count} unchanged",
	},
	failed: { id: "fluximporter.ui.count-failed", one: "{count} failed", other: "{count} failed" },
	conflict: {
		id: "fluximporter.ui.count-conflict",
		one: "{count} conflict",
		other: "{count} conflicts",
	},
	locked: { id: "fluximporter.ui.count-locked", one: "{count} locked", other: "{count} locked" },
	filtered: {
		id: "fluximporter.ui.count-filtered",
		one: "{count} filtered out",
		other: "{count} filtered out",
	},
	reverted: {
		id: "fluximporter.ui.count-reverted",
		one: "{count} restored",
		other: "{count} restored",
	},
	removed: {
		id: "fluximporter.ui.count-removed",
		one: "{count} deleted",
		other: "{count} deleted",
	},
	kept: { id: "fluximporter.ui.count-kept", one: "{count} kept", other: "{count} kept" },
} satisfies Record<string, PluralMsg>;

export type CountKey = keyof typeof COUNTS;
