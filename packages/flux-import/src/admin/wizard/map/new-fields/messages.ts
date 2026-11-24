import type { Msg } from "../../../i18n.js";

/** The New fields section and the schema-diff dialog. */
export const M = {
	heading: { id: "flux-import.new-fields.heading", message: "New fields" },
	intro: {
		id: "flux-import.new-fields.intro",
		message: "These fields are added to the collection when you continue, after you confirm them.",
	},
	source: { id: "flux-import.new-fields.source", message: "From {key} · slug {slug}" },
	label: { id: "flux-import.new-fields.label", message: "Label" },
	type: { id: "flux-import.new-fields.type", message: "Type" },
	translatable: { id: "flux-import.new-fields.translatable", message: "Translatable" },
	searchable: { id: "flux-import.new-fields.searchable", message: "Searchable" },
	remove: { id: "flux-import.new-fields.remove", message: "Remove" },
	removeNamed: { id: "flux-import.new-fields.remove-named", message: "Remove {label}" },
	dialogTitle: {
		id: "flux-import.new-fields.dialog-title",
		message: "Add these fields to the collection?",
	},
	dialogDescription: {
		id: "flux-import.new-fields.dialog-description",
		message: "This changes the schema of {collection}. Existing fields are never changed.",
	},
	planning: { id: "flux-import.new-fields.planning", message: "Checking the collection…" },
	create: {
		id: "flux-import.new-fields.create",
		message: "{label} ({slug}): a new {type} field",
	},
	addOptions: {
		id: "flux-import.new-fields.add-options",
		message: "{label} ({slug}): options are added",
	},
	unchanged: {
		id: "flux-import.new-fields.unchanged",
		message: "{label} ({slug}) already exists as a {type} field; nothing changes",
	},
	conflict: { id: "flux-import.new-fields.conflict", message: "{label} ({slug}) cannot be added" },
	flags: {
		id: "flux-import.new-fields.flags",
		message: "Translatable: {translatable} · Searchable: {searchable}",
	},
	yes: { id: "flux-import.new-fields.yes", message: "yes" },
	no: { id: "flux-import.new-fields.no", message: "no" },
	conflictsBlock: {
		id: "flux-import.new-fields.conflicts-block",
		message: "Remove or change the fields that cannot be added to continue.",
	},
	tooMany: {
		id: "flux-import.new-fields.too-many",
		message: "At most {max} fields can be added at once. Remove {extra} to continue.",
	},
	cancel: { id: "flux-import.new-fields.cancel", message: "Cancel" },
	confirm: { id: "flux-import.new-fields.confirm", message: "Add the fields" },
} satisfies Record<string, Msg>;
