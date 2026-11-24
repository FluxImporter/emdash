import type { Msg } from "../../i18n.js";

/** The Sources tab's messages: URL sources and the credentials below them. */
export const M = {
	loading: { id: "flux-import.home-sources.loading", message: "Loading sources" },
	sourcesTitle: { id: "flux-import.home-sources.sources-title", message: "URL sources" },
	add: { id: "flux-import.home-sources.add", message: "Add a source" },
	empty: { id: "flux-import.home-sources.empty", message: "No URL sources yet." },
	colName: { id: "flux-import.home-sources.col-name", message: "Name" },
	colAddress: { id: "flux-import.home-sources.col-address", message: "Address" },
	colCredential: { id: "flux-import.home-sources.col-credential", message: "Credential" },
	colLastFetch: { id: "flux-import.home-sources.col-last-fetch", message: "Last fetch" },
	colActions: { id: "flux-import.home-sources.col-actions", message: "Actions" },
	noCredential: { id: "flux-import.home-sources.no-credential", message: "No credential" },
	fetched: { id: "flux-import.home-sources.fetched", message: "Fetched {when}" },
	failed: { id: "flux-import.home-sources.failed", message: "Failed {when}: {reason}" },
	never: { id: "flux-import.home-sources.never", message: "Never fetched" },
	fetchNow: { id: "flux-import.home-sources.fetch-now", message: "Fetch now" },
	fetchNowRow: { id: "flux-import.home-sources.fetch-now-row", message: "Fetch now {name}" },
	editRow: { id: "flux-import.home-sources.edit-row", message: "Edit {name}" },
	deleteRow: { id: "flux-import.home-sources.delete-row", message: "Delete {name}" },
	fetchedNew: { id: "flux-import.home-sources.fetched-new", message: "New content fetched." },
	fetchedSame: {
		id: "flux-import.home-sources.fetched-same",
		message: "No change since the last fetch.",
	},
	fetchFailed: {
		id: "flux-import.home-sources.fetch-failed",
		message: "Couldn't fetch {name}: {reason}",
	},
	// The dialog
	addTitle: { id: "flux-import.home-sources.add-title", message: "Add a source" },
	editTitle: { id: "flux-import.home-sources.edit-title", message: "Edit {name}" },
	dialogSentence: {
		id: "flux-import.home-sources.dialog-sentence",
		message: "A source is an address the site fetches the data from.",
	},
	fieldName: { id: "flux-import.home-sources.field-name", message: "Name" },
	fieldUrl: { id: "flux-import.home-sources.field-url", message: "Address" },
	fieldCredential: { id: "flux-import.home-sources.field-credential", message: "Credential" },
	save: { id: "flux-import.home-sources.save", message: "Save" },
	close: { id: "flux-import.home-sources.close", message: "Close" },
	nameTaken: {
		id: "flux-import.home-sources.name-taken",
		message: "A source with this name already exists.",
	},
	saved: { id: "flux-import.home-sources.saved", message: "Saved {name}." },
	savedUpdated: {
		id: "flux-import.home-sources.saved-updated",
		message: "Saved {name}. Schedules updated: {count}.",
	},
	savedPartly: {
		id: "flux-import.home-sources.saved-partly",
		message: "Saved {name}. Schedules updated: {count}. Not updated: {names}.",
	},
	savedFailures: {
		id: "flux-import.home-sources.saved-failures",
		message: "Saved {name}, but some schedules could not be updated.",
	},
	// Delete
	deleteTitle: { id: "flux-import.home-sources.delete-title", message: "Delete {name}" },
	deleteSentence: {
		id: "flux-import.home-sources.delete-sentence",
		message: "This removes the saved source. Imports already made from it stay.",
	},
	delete: { id: "flux-import.home-sources.delete", message: "Delete" },
	inUse: {
		id: "flux-import.home-sources.in-use",
		message: "Schedules that read this source: {names}.",
	},
	deleted: { id: "flux-import.home-sources.deleted", message: "Deleted {name}." },
	// Credentials
	checkingSchedules: {
		id: "flux-import.home-sources.checking-schedules",
		message: "Checking the schedules that read this source",
	},
	schedulesUnchecked: {
		id: "flux-import.home-sources.schedules-unchecked",
		message: "Couldn't check which schedules read this source: {reason}",
	},
	credentialsTitle: { id: "flux-import.home-sources.credentials-title", message: "Credentials" },
	credentialsEmpty: {
		id: "flux-import.home-sources.credentials-empty",
		message: "No credentials yet.",
	},
	credName: { id: "flux-import.home-sources.cred-name", message: "Name" },
	credHeader: { id: "flux-import.home-sources.cred-header", message: "Header" },
	credValue: { id: "flux-import.home-sources.cred-value", message: "Value" },
	credNameHint: {
		id: "flux-import.home-sources.cred-name-hint",
		message: "Lowercase letters, digits and hyphens, up to 64.",
	},
	credHeaderHint: {
		id: "flux-import.home-sources.cred-header-hint",
		message: "The header the value is sent in, such as Authorization.",
	},
	credValueHint: {
		id: "flux-import.home-sources.cred-value-hint",
		message: "Stored on the site and never shown again.",
	},
	credFormTitle: {
		id: "flux-import.home-sources.cred-form-title",
		message: "Add or replace a credential",
	},
	credSave: { id: "flux-import.home-sources.cred-save", message: "Save credential" },
	credSaved: { id: "flux-import.home-sources.cred-saved", message: "Saved the credential {name}." },
	credReplace: {
		id: "flux-import.home-sources.cred-replace",
		message: "Replace the credential {name}",
	},
	credDeleteRow: {
		id: "flux-import.home-sources.cred-delete-row",
		message: "Delete the credential {name}",
	},
	credDeleteTitle: {
		id: "flux-import.home-sources.cred-delete-title",
		message: "Delete the credential {name}",
	},
	credDeleteSentence: {
		id: "flux-import.home-sources.cred-delete-sentence",
		message: "The credential is removed from the site. This cannot be undone.",
	},
	credUsedBy: {
		id: "flux-import.home-sources.cred-used-by",
		message:
			"Sources that use it: {names}. Their fetches will fail until the credential is set again.",
	},
	credUnused: {
		id: "flux-import.home-sources.cred-unused",
		message: "No source uses it.",
	},
	credDeleted: {
		id: "flux-import.home-sources.cred-deleted",
		message: "Deleted the credential {name}.",
	},
} satisfies Record<string, Msg>;
