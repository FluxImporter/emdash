import type { Msg } from "../../i18n.js";

/** The Templates tab's own messages. */
export const M = {
	title: { id: "flux-import.home-templates.title", message: "Templates" },
	loading: { id: "flux-import.home-templates.loading", message: "Loading templates" },
	empty: { id: "flux-import.home-templates.empty", message: "No saved templates yet." },
	emptyHint: {
		id: "flux-import.home-templates.empty-hint",
		message: "Save one from the wizard: Options, Save as template.",
	},
	openWizard: { id: "flux-import.home-templates.open-wizard", message: "Open the wizard" },
	colName: { id: "flux-import.home-templates.col-name", message: "Name" },
	colTarget: { id: "flux-import.home-templates.col-target", message: "Collection and locale" },
	colDescription: { id: "flux-import.home-templates.col-description", message: "Description" },
	colRevision: { id: "flux-import.home-templates.col-revision", message: "Revision" },
	colChanged: { id: "flux-import.home-templates.col-changed", message: "Last change" },
	colActions: { id: "flux-import.home-templates.col-actions", message: "Actions" },
	target: { id: "flux-import.home-templates.target", message: "{collection} \u00b7 {locale}" },
	revision: { id: "flux-import.home-templates.revision", message: "Revision {revision}" },
	use: { id: "flux-import.home-templates.use", message: "Use" },
	useRow: { id: "flux-import.home-templates.use-row", message: "Use {name}" },
	exportRow: { id: "flux-import.home-templates.export-row", message: "Export {name}" },
	export: { id: "flux-import.home-templates.export", message: "Export" },
	editRow: { id: "flux-import.home-templates.edit-row", message: "Rename and describe {name}" },
	edit: { id: "flux-import.home-templates.edit", message: "Rename and describe" },
	deleteRow: { id: "flux-import.home-templates.delete-row", message: "Delete {name}" },
	delete: { id: "flux-import.home-templates.delete", message: "Delete" },
	importButton: { id: "flux-import.home-templates.import-button", message: "Import a template" },
	exported: { id: "flux-import.home-templates.exported", message: "Exported {name}." },
	editTitle: { id: "flux-import.home-templates.edit-title", message: "Rename and describe {name}" },
	editSentence: {
		id: "flux-import.home-templates.edit-sentence",
		message: "The import settings stay as they are.",
	},
	nameLabel: { id: "flux-import.home-templates.name-label", message: "Name" },
	nameInvalid: {
		id: "flux-import.home-templates.name-invalid",
		message: "A name is 1-100 characters, with no space at either end.",
	},
	descriptionLabel: { id: "flux-import.home-templates.description-label", message: "Description" },
	descriptionHint: {
		id: "flux-import.home-templates.description-hint",
		message: "Up to 2,000 characters. Leave it empty for none.",
	},
	save: { id: "flux-import.home-templates.save", message: "Save" },
	close: { id: "flux-import.home-templates.close", message: "Close" },
	saved: { id: "flux-import.home-templates.saved", message: "Saved {name}." },
	savedSchedules: {
		id: "flux-import.home-templates.saved-schedules",
		message: "Saved {name}. Schedules updated: {count}.",
	},
	savedPartly: {
		id: "flux-import.home-templates.saved-partly",
		message: "Saved {name}. Schedules updated: {count}. Some schedules could not be updated.",
	},
	runAsYou: {
		id: "flux-import.home-templates.run-as-you",
		message: "Enabled schedules will run as you from now on.",
	},
	schedulesLoading: {
		id: "flux-import.home-templates.schedules-loading",
		message: "Checking the schedules",
	},
	schedulesFailed: {
		id: "flux-import.home-templates.schedules-failed",
		message: "Couldn't check which schedules run this template.",
	},
	missingRequired: {
		id: "flux-import.home-templates.missing-required",
		message:
			"Couldn't update {name}: this revision tracks missing entries, so edit that schedule and say what to do about them. It will pause at its next run.",
	},
	changedElsewhere: {
		id: "flux-import.home-templates.changed-elsewhere",
		message: "This template changed elsewhere.",
	},
	reload: { id: "flux-import.home-templates.reload", message: "Reload" },
	deleteTitle: { id: "flux-import.home-templates.delete-title", message: "Delete {name}" },
	deleteSentence: {
		id: "flux-import.home-templates.delete-sentence",
		message: "Delete the template {name}? Jobs made from it keep their copy.",
	},
	inUse: {
		id: "flux-import.home-templates.in-use",
		message: "{names} run this template. Delete or change those schedules first.",
	},
	deleted: { id: "flux-import.home-templates.deleted", message: "Deleted {name}." },
	importTitle: { id: "flux-import.home-templates.import-title", message: "Import a template" },
	importSentence: {
		id: "flux-import.home-templates.import-sentence",
		message: "Choose a template file that was exported from flux-import.",
	},
	fileLabel: { id: "flux-import.home-templates.file-label", message: "Template file (.json)" },
	newNameLabel: { id: "flux-import.home-templates.new-name-label", message: "New name (optional)" },
	ownerLabel: { id: "flux-import.home-templates.owner-label", message: "Owner (optional)" },
	ownerHint: {
		id: "flux-import.home-templates.owner-hint",
		message: "Letters, digits and . _ : - only, up to 100.",
	},
	ownerInvalid: {
		id: "flux-import.home-templates.owner-invalid",
		message: "An owner is letters, digits and . _ : - only, up to 100.",
	},
	fileTooLarge: {
		id: "flux-import.home-templates.file-too-large",
		message: "This file is over 2 MiB, too large for a template.",
	},
	fileNotJson: {
		id: "flux-import.home-templates.file-not-json",
		message: "This file is not JSON.",
	},
	import: { id: "flux-import.home-templates.import", message: "Import" },
	imported: { id: "flux-import.home-templates.imported", message: "Imported {name}." },
} satisfies Record<string, Msg>;
