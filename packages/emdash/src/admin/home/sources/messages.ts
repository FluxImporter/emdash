import type { Msg, PluralMsg } from "../../i18n.js";

/** The Sources tab's messages: URL sources and the credentials below them. */
export const M = {
	loading: { id: "fluximporter.home-sources.loading", message: "Loading sources" },
	loadFailed: {
		id: "fluximporter.home-sources.load-failed",
		message: "Sources could not be loaded.",
	},
	sourcesTitle: { id: "fluximporter.home-sources.sources-title", message: "URL sources" },
	sourcesHint: {
		id: "fluximporter.home-sources.sources-hint",
		message: "Feeds that imports and schedules fetch.",
	},
	add: { id: "fluximporter.home-sources.add", message: "Add a source" },
	empty: { id: "fluximporter.home-sources.empty", message: "No URL sources yet" },
	colSource: { id: "fluximporter.home-sources.col-source", message: "Source" },
	colCredential: { id: "fluximporter.home-sources.col-credential", message: "Credential" },
	colLastFetch: { id: "fluximporter.home-sources.col-last-fetch", message: "Last fetch" },
	colActions: { id: "fluximporter.home-sources.col-actions", message: "Actions" },
	noCredential: { id: "fluximporter.home-sources.no-credential", message: "No credential" },
	credentialMissing: {
		id: "fluximporter.home-sources.credential-missing",
		message: "{name} (missing)",
	},
	fetched: { id: "fluximporter.home-sources.fetched", message: "Fetched {when}" },
	failed: { id: "fluximporter.home-sources.failed", message: "Failed {when}" },
	never: { id: "fluximporter.home-sources.never", message: "Never fetched" },
	/** Under a failed fetch the server answered with an error status (Copy.dc.html). */
	httpStatus: {
		id: "fluximporter.home-sources.http-status",
		message: "HTTP {status} from the server",
	},
	/** Under a fetch: `{records}` is the record count's own message (`N.records`). */
	recordsAndSize: {
		id: "fluximporter.home-sources.records-and-size",
		message: "{records} · {size}",
	},
	fetchNow: { id: "fluximporter.home-sources.fetch-now", message: "Fetch now" },
	fetchNowRow: { id: "fluximporter.home-sources.fetch-now-row", message: "Fetch now {name}" },
	actionsRow: { id: "fluximporter.home-sources.actions-row", message: "Actions for {name}" },
	edit: { id: "fluximporter.home-sources.edit", message: "Edit" },
	editRow: { id: "fluximporter.home-sources.edit-row", message: "Edit {name}" },
	deleteRow: { id: "fluximporter.home-sources.delete-row", message: "Delete {name}" },
	fetchedNew: { id: "fluximporter.home-sources.fetched-new", message: "New content fetched." },
	fetchedSame: {
		id: "fluximporter.home-sources.fetched-same",
		message: "No change since the last fetch.",
	},
	fetchFailed: {
		id: "fluximporter.home-sources.fetch-failed",
		message: "Couldn't fetch {name}: {reason}",
	},
	// The dialog
	addTitle: { id: "fluximporter.home-sources.add-title", message: "Add a source" },
	editTitle: { id: "fluximporter.home-sources.edit-title", message: "Edit {name}" },
	dialogSentence: {
		id: "fluximporter.home-sources.dialog-sentence",
		message: "A source is an address the site fetches the data from.",
	},
	fieldName: { id: "fluximporter.home-sources.field-name", message: "Name" },
	fieldUrl: { id: "fluximporter.home-sources.field-url", message: "Address" },
	fieldCredential: { id: "fluximporter.home-sources.field-credential", message: "Credential" },
	save: { id: "fluximporter.home-sources.save", message: "Save" },
	close: { id: "fluximporter.home-sources.close", message: "Close" },
	nameTaken: {
		id: "fluximporter.home-sources.name-taken",
		message: "A source with this name already exists.",
	},
	saved: { id: "fluximporter.home-sources.saved", message: "Saved {name}." },
	savedUpdated: {
		id: "fluximporter.home-sources.saved-updated",
		message: "Saved {name}. Schedules updated: {count}.",
	},
	savedPartly: {
		id: "fluximporter.home-sources.saved-partly",
		message: "Saved {name}. Schedules updated: {count}. Not updated: {names}.",
	},
	savedFailures: {
		id: "fluximporter.home-sources.saved-failures",
		message: "Saved {name}, but some schedules could not be updated.",
	},
	// Delete
	deleteTitle: { id: "fluximporter.home-sources.delete-title", message: "Delete {name}" },
	deleteSentence: {
		id: "fluximporter.home-sources.delete-sentence",
		message: "This removes the saved source. Imports already made from it stay.",
	},
	delete: { id: "fluximporter.home-sources.delete", message: "Delete" },
	inUse: {
		id: "fluximporter.home-sources.in-use",
		message: "Schedules that read this source: {names}.",
	},
	deleted: { id: "fluximporter.home-sources.deleted", message: "Deleted {name}." },
	// Credentials
	checkingSchedules: {
		id: "fluximporter.home-sources.checking-schedules",
		message: "Checking the schedules that read this source",
	},
	schedulesUnchecked: {
		id: "fluximporter.home-sources.schedules-unchecked",
		message: "Couldn't check which schedules read this source: {reason}",
	},
	credentialsTitle: { id: "fluximporter.home-sources.credentials-title", message: "Credentials" },
	credentialsHint: {
		id: "fluximporter.home-sources.credentials-hint",
		message: "Write-only. Values are stored on the site and never shown again.",
	},
	credentialsEmpty: {
		id: "fluximporter.home-sources.credentials-empty",
		message: "No credentials yet",
	},
	credAdd: { id: "fluximporter.home-sources.cred-add", message: "Add a credential" },
	credSentIn: {
		id: "fluximporter.home-sources.cred-sent-in",
		message: "Sent in the {header} header",
	},
	credNotUsed: { id: "fluximporter.home-sources.cred-not-used", message: "not used yet" },
	valueHidden: { id: "fluximporter.home-sources.value-hidden", message: "Value hidden" },
	credName: { id: "fluximporter.home-sources.cred-name", message: "Name" },
	credHeader: { id: "fluximporter.home-sources.cred-header", message: "Header" },
	credValue: { id: "fluximporter.home-sources.cred-value", message: "Value" },
	credNameHint: {
		id: "fluximporter.home-sources.cred-name-hint",
		message: "Lowercase letters, digits and hyphens, up to 64.",
	},
	credHeaderHint: {
		id: "fluximporter.home-sources.cred-header-hint",
		message: "The header the value is sent in, such as Authorization.",
	},
	credValueHint: {
		id: "fluximporter.home-sources.cred-value-hint",
		message: "Stored on the site and never shown again.",
	},
	credSave: { id: "fluximporter.home-sources.cred-save", message: "Save credential" },
	credSaved: {
		id: "fluximporter.home-sources.cred-saved",
		message: "Saved the credential {name}.",
	},
	credReplaceShort: { id: "fluximporter.home-sources.cred-replace-short", message: "Replace" },
	credReplace: {
		id: "fluximporter.home-sources.cred-replace",
		message: "Replace the credential {name}",
	},
	credDeleteRow: {
		id: "fluximporter.home-sources.cred-delete-row",
		message: "Delete the credential {name}",
	},
	credDeleteTitle: {
		id: "fluximporter.home-sources.cred-delete-title",
		message: "Delete the credential {name}",
	},
	credDeleteSentence: {
		id: "fluximporter.home-sources.cred-delete-sentence",
		message: "The credential is removed from the site. This cannot be undone.",
	},
	credUsedBy: {
		id: "fluximporter.home-sources.cred-used-by",
		message:
			"Sources that use it: {names}. Their fetches will fail until the credential is set again, and schedules that read them will pause.",
	},
	credUnused: {
		id: "fluximporter.home-sources.cred-unused",
		message: "No source uses it.",
	},
	credDeleted: {
		id: "fluximporter.home-sources.cred-deleted",
		message: "Deleted the credential {name}.",
	},
} satisfies Record<string, Msg>;

/** Counts in words, with plural forms. */
export const N = {
	sources: {
		id: "fluximporter.home-sources.count-sources",
		one: "{count} URL source",
		other: "{count} URL sources",
	},
	credentials: {
		id: "fluximporter.home-sources.count-credentials",
		one: "{count} credential",
		other: "{count} credentials",
	},
	usedBy: {
		id: "fluximporter.home-sources.used-by",
		one: "used by {count} source",
		other: "used by {count} sources",
	},
	/** The records the last fetch held, once a completed import or dry run has read it. */
	records: {
		id: "fluximporter.home-sources.count-records",
		one: "{count} record",
		other: "{count} records",
	},
} satisfies Record<string, PluralMsg>;
