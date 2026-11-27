import type { Msg, PluralMsg } from "../../i18n.js";

/** The Preview step's messages: the dry run, its counts and its records. */
export const M = {
	checking: {
		id: "fluximporter.preview.checking",
		message: "Checking every record. Nothing is written yet.",
	},
	counts: { id: "fluximporter.preview.counts", message: "What the import would do" },
	create: { id: "fluximporter.preview.create", message: "Create" },
	update: { id: "fluximporter.preview.update", message: "Update" },
	unchanged: { id: "fluximporter.preview.unchanged", message: "Unchanged" },
	failed: { id: "fluximporter.preview.failed", message: "Failed" },
	conflict: { id: "fluximporter.preview.conflict", message: "Conflict" },
	locked: { id: "fluximporter.preview.locked", message: "Locked" },
	filtered: { id: "fluximporter.preview.filtered", message: "Filtered" },
	missingTrash: { id: "fluximporter.preview.missing-trash", message: "Missing → Trash" },
	missingUnpublish: {
		id: "fluximporter.preview.missing-unpublish",
		message: "Missing → Unpublish",
	},
	noRecords: { id: "fluximporter.preview.no-records", message: "No records to import" },
	noRecordsHint: {
		id: "fluximporter.preview.no-records-hint",
		message: "The source has no records the import can read. Check the file or the records path.",
	},
	nothingToRun: { id: "fluximporter.preview.nothing-to-run", message: "Nothing to import" },
	runWaiting: { id: "fluximporter.preview.run-waiting", message: "Wait for the dry run to finish" },
	runBlocked: { id: "fluximporter.preview.run-blocked", message: "The dry run did not finish" },
	notApplied: { id: "fluximporter.preview.not-applied", message: "Not applied" },
	missingOverLimit: {
		id: "fluximporter.preview.missing-over-limit",
		message:
			"A real run would leave these entries alone: {found} of {owned} ({percent}%) are missing from the source, more than the limit of {max}%. Raise the limit in Options to apply it.",
	},
	missingForeign: {
		id: "fluximporter.preview.missing-foreign",
		message: "Missing entries are left alone: this owner also has entries from another URL source.",
	},
	missingUnkeyed: {
		id: "fluximporter.preview.missing-unkeyed",
		message:
			"Missing entries would not be checked: {count} records have no readable key, so their entries may still be in the source.",
	},
	missingNoKey: {
		id: "fluximporter.preview.missing-no-key",
		message: "Missing entries would not be checked: no record has a readable key.",
	},
	paused: { id: "fluximporter.preview.paused", message: "The dry run is paused." },
	cancelled: { id: "fluximporter.preview.cancelled", message: "The dry run was cancelled." },
	templateWarnings: {
		id: "fluximporter.preview.template-warnings",
		message: "Saving the template reported:",
	},
	backToMap: { id: "fluximporter.preview.back-to-map", message: "Back to Map" },
	runImport: { id: "fluximporter.preview.run-import", message: "Run import" },
	changeInOptions: { id: "fluximporter.preview.change-in-options", message: "Change in Options" },
	filterAll: { id: "fluximporter.preview.filter-all", message: "All" },
	filterPlanned: { id: "fluximporter.preview.filter-planned", message: "Will change" },
	filterFailed: { id: "fluximporter.preview.filter-failed", message: "Failed" },
	filterConflict: { id: "fluximporter.preview.filter-conflict", message: "Conflicts" },
	filterLocked: { id: "fluximporter.preview.filter-locked", message: "Locked" },
	filterFiltered: { id: "fluximporter.preview.filter-filtered", message: "Filtered out" },
	filters: { id: "fluximporter.preview.filters", message: "Show records" },
	colRecord: { id: "fluximporter.preview.col-record", message: "Record" },
	colAction: { id: "fluximporter.preview.col-action", message: "Action" },
	colChanges: { id: "fluximporter.preview.col-changes", message: "Changes" },
	otherAction: { id: "fluximporter.preview.other-action", message: "Other" },
	change: { id: "fluximporter.preview.change", message: "{before} → {after}" },
	fieldError: { id: "fluximporter.preview.field-error", message: "{field}: {message}" },
	empty: { id: "fluximporter.preview.empty", message: "—" },
	emptyValue: { id: "fluximporter.preview.empty-value", message: "empty" },
	noKey: { id: "fluximporter.preview.no-key", message: "(no key)" },
	noMatch: { id: "fluximporter.preview.no-match", message: "No records match this filter." },
	loadingRecords: { id: "fluximporter.preview.loading-records", message: "Loading records" },
	pages: { id: "fluximporter.preview.pages", message: "Record pages" },
	previousPage: { id: "fluximporter.preview.previous-page", message: "Previous page" },
	nextPage: { id: "fluximporter.preview.next-page", message: "Next page" },
} satisfies Record<string, Msg>;

/** The dry run's counts: the summary line and the count strip's labels (the number is beside). */
export const COUNT = {
	finished: {
		id: "fluximporter.preview.count-finished",
		one: "Dry run of {count} record. Nothing is written yet.",
		other: "Dry run of {count} records. Nothing is written yet.",
	},
	create: { id: "fluximporter.preview.count-create", one: "to create", other: "to create" },
	update: { id: "fluximporter.preview.count-update", one: "to update", other: "to update" },
	unchanged: { id: "fluximporter.preview.count-unchanged", one: "unchanged", other: "unchanged" },
	failed: { id: "fluximporter.preview.count-failed", one: "failed", other: "failed" },
	conflict: { id: "fluximporter.preview.count-conflict", one: "conflict", other: "conflicts" },
	locked: { id: "fluximporter.preview.count-locked", one: "locked", other: "locked" },
	filtered: {
		id: "fluximporter.preview.count-filtered",
		one: "filtered out",
		other: "filtered out",
	},
	missingTrash: {
		id: "fluximporter.preview.count-missing-trash",
		one: "missing → trash",
		other: "missing → trash",
	},
	missingUnpublish: {
		id: "fluximporter.preview.count-missing-unpublish",
		one: "missing → unpublish",
		other: "missing → unpublish",
	},
} satisfies Record<string, PluralMsg>;
