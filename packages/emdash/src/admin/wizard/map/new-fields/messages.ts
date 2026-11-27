import type { Msg } from "../../../i18n.js";

/** The New fields section and the schema-diff dialog. */
export const M = {
	heading: { id: "fluximporter.new-fields.heading", message: "New fields" },
	intro: {
		id: "fluximporter.new-fields.intro",
		message: "These fields are added to the collection when you continue, after you confirm them.",
	},
	source: { id: "fluximporter.new-fields.source", message: "From {key} · slug {slug}" },
	label: { id: "fluximporter.new-fields.label", message: "Label" },
	type: { id: "fluximporter.new-fields.type", message: "Type" },
	translatable: { id: "fluximporter.new-fields.translatable", message: "Translatable" },
	searchable: { id: "fluximporter.new-fields.searchable", message: "Searchable" },
	remove: { id: "fluximporter.new-fields.remove", message: "Remove" },
	removeNamed: { id: "fluximporter.new-fields.remove-named", message: "Remove {label}" },
	dialogTitle: {
		id: "fluximporter.new-fields.dialog-title",
		message: "Add these fields to the collection?",
	},
	dialogDescription: {
		id: "fluximporter.new-fields.dialog-description",
		message: "This changes the schema of {collection}. Existing fields are never changed.",
	},
	planning: { id: "fluximporter.new-fields.planning", message: "Checking the collection…" },
	create: {
		id: "fluximporter.new-fields.create",
		message: "{label} ({slug}): a new {type} field",
	},
	addOptions: {
		id: "fluximporter.new-fields.add-options",
		message: "{label} ({slug}): options are added",
	},
	unchanged: {
		id: "fluximporter.new-fields.unchanged",
		message: "{label} ({slug}) already exists as a {type} field; nothing changes",
	},
	conflict: { id: "fluximporter.new-fields.conflict", message: "{label} ({slug}) cannot be added" },
	flags: {
		id: "fluximporter.new-fields.flags",
		message: "Translatable: {translatable} · Searchable: {searchable}",
	},
	yes: { id: "fluximporter.new-fields.yes", message: "yes" },
	no: { id: "fluximporter.new-fields.no", message: "no" },
	conflictsBlock: {
		id: "fluximporter.new-fields.conflicts-block",
		message: "Remove or change the fields that cannot be added to continue.",
	},
	tooMany: {
		id: "fluximporter.new-fields.too-many",
		message: "At most {max} fields can be added at once. Remove {extra} to continue.",
	},
	cancel: { id: "fluximporter.new-fields.cancel", message: "Cancel" },
	confirm: { id: "fluximporter.new-fields.confirm", message: "Add the fields" },
} satisfies Record<string, Msg>;
