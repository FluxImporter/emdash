import type { Msg, PluralMsg } from "../../i18n.js";

/** The Templates tab's own messages. */
export const M = {
	loading: { id: "fluximporter.home-templates.loading", message: "Loading templates" },
	loadFailed: {
		id: "fluximporter.home-templates.load-failed",
		message: "Templates could not be loaded.",
	},
	summary: {
		id: "fluximporter.home-templates.summary",
		message: "saved mappings you can reuse or share",
	},
	empty: { id: "fluximporter.home-templates.empty", message: "No templates yet" },
	emptyHint: {
		id: "fluximporter.home-templates.empty-hint",
		message: "Save one from the wizard: Options, Save as template.",
	},
	openWizard: { id: "fluximporter.home-templates.open-wizard", message: "Open the wizard" },
	colTemplate: { id: "fluximporter.home-templates.col-template", message: "Template" },
	colTarget: { id: "fluximporter.home-templates.col-target", message: "Collection" },
	colRevision: { id: "fluximporter.home-templates.col-revision", message: "Revision" },
	colChanged: { id: "fluximporter.home-templates.col-changed", message: "Last change" },
	colActions: { id: "fluximporter.home-templates.col-actions", message: "Actions" },
	target: { id: "fluximporter.home-templates.target", message: "{collection} \u00b7 {locale}" },
	revisionShort: {
		id: "fluximporter.home-templates.revision-short",
		message: "Rev. {revision}",
	},
	noDescription: { id: "fluximporter.home-templates.no-description", message: "No description" },
	actionsRow: { id: "fluximporter.home-templates.actions-row", message: "Actions for {name}" },
	use: { id: "fluximporter.home-templates.use", message: "Use" },
	useRow: { id: "fluximporter.home-templates.use-row", message: "Use {name}" },
	exportRow: { id: "fluximporter.home-templates.export-row", message: "Export {name}" },
	export: { id: "fluximporter.home-templates.export", message: "Export" },
	editRow: { id: "fluximporter.home-templates.edit-row", message: "Rename and describe {name}" },
	edit: { id: "fluximporter.home-templates.edit", message: "Rename and describe" },
	deleteRow: { id: "fluximporter.home-templates.delete-row", message: "Delete {name}" },
	delete: { id: "fluximporter.home-templates.delete", message: "Delete" },
	importButton: { id: "fluximporter.home-templates.import-button", message: "Import a template" },
	exported: { id: "fluximporter.home-templates.exported", message: "Exported {name}." },
	editTitle: {
		id: "fluximporter.home-templates.edit-title",
		message: "Rename and describe {name}",
	},
	editSentence: {
		id: "fluximporter.home-templates.edit-sentence",
		message: "The import settings stay as they are.",
	},
	nameLabel: { id: "fluximporter.home-templates.name-label", message: "Name" },
	nameInvalid: {
		id: "fluximporter.home-templates.name-invalid",
		message: "A name is 1-100 characters, with no space at either end.",
	},
	descriptionLabel: { id: "fluximporter.home-templates.description-label", message: "Description" },
	descriptionHint: {
		id: "fluximporter.home-templates.description-hint",
		message: "Up to 2,000 characters. Leave it empty for none.",
	},
	save: { id: "fluximporter.home-templates.save", message: "Save" },
	close: { id: "fluximporter.home-templates.close", message: "Close" },
	saved: { id: "fluximporter.home-templates.saved", message: "Saved {name}." },
	savedSchedules: {
		id: "fluximporter.home-templates.saved-schedules",
		message: "Saved {name}. Schedules updated: {count}.",
	},
	savedPartly: {
		id: "fluximporter.home-templates.saved-partly",
		message: "Saved {name}. Schedules updated: {count}. Some schedules could not be updated.",
	},
	runAsYou: {
		id: "fluximporter.home-templates.run-as-you",
		message: "Enabled schedules will run as you from now on.",
	},
	schedulesLoading: {
		id: "fluximporter.home-templates.schedules-loading",
		message: "Checking the schedules",
	},
	schedulesFailed: {
		id: "fluximporter.home-templates.schedules-failed",
		message: "Couldn't check which schedules run this template.",
	},
	missingRequired: {
		id: "fluximporter.home-templates.missing-required",
		message:
			"Couldn't update {name}: this revision tracks missing entries, so edit that schedule and say what to do about them. It will pause at its next run.",
	},
	changedElsewhere: {
		id: "fluximporter.home-templates.changed-elsewhere",
		message: "This template changed elsewhere.",
	},
	reload: { id: "fluximporter.home-templates.reload", message: "Reload" },
	deleteTitle: { id: "fluximporter.home-templates.delete-title", message: "Delete {name}" },
	deleteSentence: {
		id: "fluximporter.home-templates.delete-sentence",
		message: "Delete the template {name}? Jobs made from it keep their copy.",
	},
	inUse: {
		id: "fluximporter.home-templates.in-use",
		message: "{names} run this template. Delete or change those schedules first.",
	},
	deleted: { id: "fluximporter.home-templates.deleted", message: "Deleted {name}." },
	importTitle: { id: "fluximporter.home-templates.import-title", message: "Import a template" },
	importSentence: {
		id: "fluximporter.home-templates.import-sentence",
		message: "Choose a template file that was exported from Flux Importer.",
	},
	fileLabel: { id: "fluximporter.home-templates.file-label", message: "Template file (.json)" },
	chosenFile: { id: "fluximporter.home-templates.chosen-file", message: "Chosen file: {name}" },
	newNameLabel: {
		id: "fluximporter.home-templates.new-name-label",
		message: "New name (optional)",
	},
	ownerLabel: { id: "fluximporter.home-templates.owner-label", message: "Owner (optional)" },
	ownerHint: {
		id: "fluximporter.home-templates.owner-hint",
		message: "Letters, digits and . _ : - only, up to 100.",
	},
	ownerInvalid: {
		id: "fluximporter.home-templates.owner-invalid",
		message: "An owner is letters, digits and . _ : - only, up to 100.",
	},
	fileTooLarge: {
		id: "fluximporter.home-templates.file-too-large",
		message: "This file is over 2 MiB, too large for a template.",
	},
	fileNotJson: {
		id: "fluximporter.home-templates.file-not-json",
		message: "This file is not JSON.",
	},
	import: { id: "fluximporter.home-templates.import", message: "Import" },
	imported: { id: "fluximporter.home-templates.imported", message: "Imported {name}." },
} satisfies Record<string, Msg>;

/** Counts in words, with plural forms. */
export const N = {
	templates: {
		id: "fluximporter.home-templates.count",
		one: "{count} template",
		other: "{count} templates",
	},
} satisfies Record<string, PluralMsg>;
