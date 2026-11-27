import type { Msg } from "../../i18n.js";

/** The Options step's messages: each control with its one line of help (spec "4. Options"). */
export const M = {
	records: { id: "fluximporter.options.records", message: "Records" },
	recordsHelp: {
		id: "fluximporter.options.records-help",
		message:
			"Whether records create new entries, update the ones an earlier import created, or both.",
	},
	modeUpsert: { id: "fluximporter.options.mode-upsert", message: "Create and update" },
	modeCreate: { id: "fluximporter.options.mode-create", message: "Create only" },
	modeUpdate: { id: "fluximporter.options.mode-update", message: "Update only" },
	updateFields: { id: "fluximporter.options.update-fields", message: "Update only these fields" },
	updateFieldsHelp: {
		id: "fluximporter.options.update-fields-help",
		message:
			"An update leaves the other fields as they are. Tick none to update every mapped field, or at most {max}.",
	},
	updateFieldsTooMany: {
		id: "fluximporter.options.update-fields-too-many",
		message: "Choose at most {max} fields",
	},
	slugName: { id: "fluximporter.options.slug-name", message: "Slug" },
	bylinesName: { id: "fluximporter.options.bylines-name", message: "Bylines" },
	protectEdited: {
		id: "fluximporter.options.protect-edited",
		message: "Never overwrite fields edited in the admin",
	},
	protectEditedHelp: {
		id: "fluximporter.options.protect-edited-help",
		message: "A field someone changed in the admin since the last import keeps their change.",
	},

	status: { id: "fluximporter.options.status", message: "Status" },
	statusHelp: {
		id: "fluximporter.options.status-help",
		message: "Whether the entries are published at once, kept as drafts, or published later.",
	},
	statusPublish: { id: "fluximporter.options.status-publish", message: "Publish" },
	statusDraft: { id: "fluximporter.options.status-draft", message: "Draft" },
	statusSchedule: { id: "fluximporter.options.status-schedule", message: "Schedule" },
	schedule: { id: "fluximporter.options.schedule", message: "Publish date" },
	scheduleHelp: {
		id: "fluximporter.options.schedule-help",
		message: "Each entry is published at this date; one already past is published at once.",
	},
	scheduleFixed: {
		id: "fluximporter.options.schedule-fixed",
		message: "The same date for every record",
	},
	scheduleFeed: { id: "fluximporter.options.schedule-feed", message: "A date from the feed" },
	scheduleKept: {
		id: "fluximporter.options.schedule-kept",
		message: "As the saved template sets it",
	},
	scheduleUnset: {
		id: "fluximporter.options.schedule-unset",
		message: "Choose when the entries are published",
	},
	fixedDate: { id: "fluximporter.options.fixed-date", message: "Date" },
	fixedTime: { id: "fluximporter.options.fixed-time", message: "Time" },
	fixedHelp: {
		id: "fluximporter.options.fixed-help",
		message: "Read in the site's timezone.",
	},
	feedKey: { id: "fluximporter.options.feed-key", message: "Source key" },
	feedKeyHelp: {
		id: "fluximporter.options.feed-key-help",
		message: "The key that holds each record's publish date.",
	},
	feedFormat: { id: "fluximporter.options.feed-format", message: "Date format" },
	feedFormatHelp: {
		id: "fluximporter.options.feed-format-help",
		message: "A pattern such as yyyy-MM-dd HH:mm. Leave empty for ISO 8601 dates.",
	},
	feedTz: { id: "fluximporter.options.feed-tz", message: "Timezone" },
	feedTzHelp: {
		id: "fluximporter.options.feed-tz-help",
		message: "An IANA timezone such as Europe/Paris, or site for the site's. Leave empty for UTC.",
	},
	feedTzInvalid: {
		id: "fluximporter.options.feed-tz-invalid",
		message: "Use an IANA timezone such as Europe/Paris, or site",
	},

	missing: { id: "fluximporter.options.missing", message: "Missing from the feed" },
	missingHelp: {
		id: "fluximporter.options.missing-help",
		message:
			"What happens to entries this import created earlier when the feed no longer lists them.",
	},
	missingOff: {
		id: "fluximporter.options.missing-off",
		message: "Saved templates only: a one-off run has nothing to find missing",
	},
	missingLeave: { id: "fluximporter.options.missing-leave", message: "Leave them" },
	missingUnpublish: { id: "fluximporter.options.missing-unpublish", message: "Unpublish them" },
	missingTrash: { id: "fluximporter.options.missing-trash", message: "Move them to the trash" },
	threshold: {
		id: "fluximporter.options.threshold",
		message: "Stop the run if more than this share is missing (%)",
	},
	thresholdHelp: {
		id: "fluximporter.options.threshold-help",
		message: "A feed that comes back short stops the run instead of removing entries.",
	},
	thresholdInvalid: {
		id: "fluximporter.options.threshold-invalid",
		message: "Enter a whole number from 0 to 100",
	},

	saveAs: { id: "fluximporter.options.save-as", message: "Save as template" },
	saveAsHelp: {
		id: "fluximporter.options.save-as-help",
		message: "Saves these settings on Run, so the import can be run again or scheduled.",
	},
	edited: { id: "fluximporter.options.edited", message: "Changes to the template" },
	editedHelp: {
		id: "fluximporter.options.edited-help",
		message: "These settings differ from the saved template {name}.",
	},
	runUnsaved: {
		id: "fluximporter.options.run-unsaved",
		message: "Run with these changes without saving them",
	},
	saveUpdate: { id: "fluximporter.options.save-update", message: "Save the changes to {name}" },
	saveNew: { id: "fluximporter.options.save-new", message: "Save as a new template" },
	templateName: { id: "fluximporter.options.template-name", message: "Template name" },
	inputInvalid: {
		id: "fluximporter.options.input-invalid",
		message: "Correct the options marked as not valid",
	},
	nameNeeded: {
		id: "fluximporter.options.name-needed",
		message: "Name the template to save it",
	},
	nameTaken: {
		id: "fluximporter.options.name-taken",
		message: "A template with this name exists",
	},
	nameInvalid: {
		id: "fluximporter.options.name-invalid",
		message: "Use 1 to {max} characters, with no space at either end",
	},
	nameUnchecked: {
		id: "fluximporter.options.name-unchecked",
		message:
			"The saved templates could not be listed, so the name is checked when the import runs.",
	},
	saveUnsaved: {
		id: "fluximporter.options.save-unsaved",
		message:
			"Save the changes to {name} with Next on Options, or choose to run them without saving",
	},

	advanced: { id: "fluximporter.options.advanced", message: "Advanced" },
	owner: { id: "fluximporter.options.owner", message: "Owner" },
	ownerNone: {
		id: "fluximporter.options.owner-none",
		message:
			"The saved template sets no owner, so this import stamps none. Type one to set it: the import then runs with your changes.",
	},
	ownerHelp: {
		id: "fluximporter.options.owner-help",
		message:
			"Stamped on the entries this import creates, so a later run can tell which are missing.",
	},
	ownerInvalid: {
		id: "fluximporter.options.owner-invalid",
		message: "Use 1 to 100 letters, digits, dots, underscores, colons or hyphens",
	},
	ownerClash: {
		id: "fluximporter.options.owner-clash",
		message:
			"The template {name} has the same owner for this collection and locale: the two imports behave as one, and each one's missing entries can include the other's.",
	},
	batchSize: { id: "fluximporter.options.batch-size", message: "Batch size" },
	batchSizeHelp: {
		id: "fluximporter.options.batch-size-help",
		message: "Records per batch. Leave empty for the default.",
	},
	batchSizeInvalid: {
		id: "fluximporter.options.batch-size-invalid",
		message: "Enter a whole number from 1 to {max}",
	},
} satisfies Record<string, Msg>;
