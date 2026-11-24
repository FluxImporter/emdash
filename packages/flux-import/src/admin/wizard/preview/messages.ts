import type { Msg } from "../../i18n.js";

/** The Preview step's messages: the dry run, its counts and its records. */
export const M = {
	checking: {
		id: "flux-import.preview.checking",
		message: "Checking every record. Nothing is imported yet.",
	},
	counts: { id: "flux-import.preview.counts", message: "What the import would do" },
	create: { id: "flux-import.preview.create", message: "Create" },
	update: { id: "flux-import.preview.update", message: "Update" },
	unchanged: { id: "flux-import.preview.unchanged", message: "Unchanged" },
	failed: { id: "flux-import.preview.failed", message: "Failed" },
	conflict: { id: "flux-import.preview.conflict", message: "Conflict" },
	locked: { id: "flux-import.preview.locked", message: "Locked" },
	filtered: { id: "flux-import.preview.filtered", message: "Filtered" },
	missingTrash: { id: "flux-import.preview.missing-trash", message: "Missing → Trash" },
	missingUnpublish: {
		id: "flux-import.preview.missing-unpublish",
		message: "Missing → Unpublish",
	},
	noRecords: { id: "flux-import.preview.no-records", message: "No records to import" },
	noRecordsHint: {
		id: "flux-import.preview.no-records-hint",
		message: "The source has no records the import can read. Check the file or the records path.",
	},
	nothingToRun: { id: "flux-import.preview.nothing-to-run", message: "Nothing to import" },
	runWaiting: { id: "flux-import.preview.run-waiting", message: "Wait for the dry run to finish" },
	runBlocked: { id: "flux-import.preview.run-blocked", message: "The dry run did not finish" },
	finished: {
		id: "flux-import.preview.finished",
		message: "Dry run finished. Records checked: {total}",
	},
	notApplied: { id: "flux-import.preview.not-applied", message: "Not applied" },
	missingOverLimit: {
		id: "flux-import.preview.missing-over-limit",
		message:
			"A real run would leave these entries alone: {found} of {owned} ({percent}%) are missing from the source, more than the limit of {max}%. Raise the limit in Options to apply it.",
	},
	missingForeign: {
		id: "flux-import.preview.missing-foreign",
		message: "Missing entries are left alone: this owner also has entries from another URL source.",
	},
	missingUnkeyed: {
		id: "flux-import.preview.missing-unkeyed",
		message:
			"Missing entries would not be checked: {count} records have no readable key, so their entries may still be in the source.",
	},
	missingNoKey: {
		id: "flux-import.preview.missing-no-key",
		message: "Missing entries would not be checked: no record has a readable key.",
	},
	paused: { id: "flux-import.preview.paused", message: "The dry run is paused." },
	cancelled: { id: "flux-import.preview.cancelled", message: "The dry run was cancelled." },
	templateWarnings: {
		id: "flux-import.preview.template-warnings",
		message: "Saving the template reported:",
	},
	backToMap: { id: "flux-import.preview.back-to-map", message: "Back to Map" },
	runImport: { id: "flux-import.preview.run-import", message: "Run import" },
	changeInOptions: { id: "flux-import.preview.change-in-options", message: "Change in Options" },
	filterAll: { id: "flux-import.preview.filter-all", message: "All" },
	filterPlanned: { id: "flux-import.preview.filter-planned", message: "Would change" },
	filterFailed: { id: "flux-import.preview.filter-failed", message: "Failed" },
	filterConflict: { id: "flux-import.preview.filter-conflict", message: "Conflicts" },
	filterLocked: { id: "flux-import.preview.filter-locked", message: "Locked" },
	filterFiltered: { id: "flux-import.preview.filter-filtered", message: "Filtered" },
	filters: { id: "flux-import.preview.filters", message: "Show records" },
	colRecord: { id: "flux-import.preview.col-record", message: "Record" },
	colAction: { id: "flux-import.preview.col-action", message: "Action" },
	colChanges: { id: "flux-import.preview.col-changes", message: "Changes" },
	colErrors: { id: "flux-import.preview.col-errors", message: "Errors and warnings" },
	otherAction: { id: "flux-import.preview.other-action", message: "Other" },
	change: { id: "flux-import.preview.change", message: "{field}: {before} → {after}" },
	fieldError: { id: "flux-import.preview.field-error", message: "{field}: {message}" },
	empty: { id: "flux-import.preview.empty", message: "(empty)" },
	noKey: { id: "flux-import.preview.no-key", message: "(no key)" },
	noMatch: { id: "flux-import.preview.no-match", message: "No records match this filter." },
	loadingRecords: { id: "flux-import.preview.loading-records", message: "Loading records" },
	pages: { id: "flux-import.preview.pages", message: "Record pages" },
	previousPage: { id: "flux-import.preview.previous-page", message: "Previous page" },
	nextPage: { id: "flux-import.preview.next-page", message: "Next page" },
} satisfies Record<string, Msg>;
