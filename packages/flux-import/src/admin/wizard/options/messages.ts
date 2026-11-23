import type { Msg } from "../../i18n.js";

/** The Options step's messages: each control with its one line of help (spec "4. Options"). */
export const M = {
	records: { id: "flux-import.options.records", message: "Records" },
	recordsHelp: {
		id: "flux-import.options.records-help",
		message:
			"Whether records create new entries, update the ones an earlier import created, or both.",
	},
	modeUpsert: { id: "flux-import.options.mode-upsert", message: "Create and update" },
	modeCreate: { id: "flux-import.options.mode-create", message: "Create only" },
	modeUpdate: { id: "flux-import.options.mode-update", message: "Update only" },
	updateFields: { id: "flux-import.options.update-fields", message: "Update only these fields" },
	updateFieldsHelp: {
		id: "flux-import.options.update-fields-help",
		message:
			"An update leaves the other fields as they are. Tick none to update every mapped field.",
	},
	updateFieldsTooMany: {
		id: "flux-import.options.update-fields-too-many",
		message: "Choose at most {max} fields",
	},
	slugName: { id: "flux-import.options.slug-name", message: "Slug" },
	bylinesName: { id: "flux-import.options.bylines-name", message: "Bylines" },
	taxonomyName: { id: "flux-import.options.taxonomy-name", message: "Taxonomy {name}" },
	protectEdited: {
		id: "flux-import.options.protect-edited",
		message: "Never overwrite fields edited in the admin",
	},
	protectEditedHelp: {
		id: "flux-import.options.protect-edited-help",
		message: "A field someone changed in the admin since the last import keeps their change.",
	},

	status: { id: "flux-import.options.status", message: "Status" },
	statusHelp: {
		id: "flux-import.options.status-help",
		message: "Whether the entries are published at once, kept as drafts, or published later.",
	},
	statusPublish: { id: "flux-import.options.status-publish", message: "Publish" },
	statusDraft: { id: "flux-import.options.status-draft", message: "Draft" },
	statusSchedule: { id: "flux-import.options.status-schedule", message: "Schedule" },
	schedule: { id: "flux-import.options.schedule", message: "Publish date" },
	scheduleHelp: {
		id: "flux-import.options.schedule-help",
		message: "Each entry is published at this date; one already past is published at once.",
	},
	scheduleFixed: {
		id: "flux-import.options.schedule-fixed",
		message: "The same date for every record",
	},
	scheduleFeed: { id: "flux-import.options.schedule-feed", message: "A date from the feed" },
	scheduleKept: {
		id: "flux-import.options.schedule-kept",
		message: "As the saved template sets it",
	},
	scheduleUnset: {
		id: "flux-import.options.schedule-unset",
		message: "Choose when the entries are published",
	},
	fixedDate: { id: "flux-import.options.fixed-date", message: "Date" },
	fixedTime: { id: "flux-import.options.fixed-time", message: "Time" },
	fixedHelp: {
		id: "flux-import.options.fixed-help",
		message: "Read in the site's timezone.",
	},
	feedKey: { id: "flux-import.options.feed-key", message: "Source key" },
	feedKeyHelp: {
		id: "flux-import.options.feed-key-help",
		message: "The key that holds each record's publish date.",
	},
	feedFormat: { id: "flux-import.options.feed-format", message: "Date format" },
	feedFormatHelp: {
		id: "flux-import.options.feed-format-help",
		message: "A pattern such as yyyy-MM-dd HH:mm. Leave empty for ISO 8601 dates.",
	},
	feedTz: { id: "flux-import.options.feed-tz", message: "Timezone" },
	feedTzHelp: {
		id: "flux-import.options.feed-tz-help",
		message: "An IANA timezone such as Europe/Paris, or site for the site's. Leave empty for UTC.",
	},

	missing: { id: "flux-import.options.missing", message: "Missing from the feed" },
	missingHelp: {
		id: "flux-import.options.missing-help",
		message:
			"What happens to entries this import created earlier when the feed no longer lists them.",
	},
	missingOff: {
		id: "flux-import.options.missing-off",
		message: "Saved templates only: a one-off run has nothing to find missing",
	},
	missingLeave: { id: "flux-import.options.missing-leave", message: "Leave them" },
	missingUnpublish: { id: "flux-import.options.missing-unpublish", message: "Unpublish them" },
	missingTrash: { id: "flux-import.options.missing-trash", message: "Move them to the trash" },
	threshold: {
		id: "flux-import.options.threshold",
		message: "Stop the run if more than this share is missing (%)",
	},
	thresholdHelp: {
		id: "flux-import.options.threshold-help",
		message: "A feed that comes back short stops the run instead of removing entries.",
	},
	thresholdInvalid: {
		id: "flux-import.options.threshold-invalid",
		message: "Enter a whole number from 0 to 100",
	},

	saveAs: { id: "flux-import.options.save-as", message: "Save as template" },
	saveAsHelp: {
		id: "flux-import.options.save-as-help",
		message: "Saves these settings on Run, so the import can be run again or scheduled.",
	},
	edited: { id: "flux-import.options.edited", message: "Changes to the template" },
	editedHelp: {
		id: "flux-import.options.edited-help",
		message: "These settings differ from the saved template {name}.",
	},
	runUnsaved: {
		id: "flux-import.options.run-unsaved",
		message: "Run with these changes without saving them",
	},
	saveUpdate: { id: "flux-import.options.save-update", message: "Save the changes to {name}" },
	saveNew: { id: "flux-import.options.save-new", message: "Save as a new template" },
	templateName: { id: "flux-import.options.template-name", message: "Template name" },
	nameNeeded: {
		id: "flux-import.options.name-needed",
		message: "Name the template to save it",
	},
	nameTaken: {
		id: "flux-import.options.name-taken",
		message: "A template with this name exists",
	},
	nameInvalid: {
		id: "flux-import.options.name-invalid",
		message: "Use 1 to {max} characters, with no space at either end",
	},

	advanced: { id: "flux-import.options.advanced", message: "Advanced" },
	owner: { id: "flux-import.options.owner", message: "Owner" },
	ownerHelp: {
		id: "flux-import.options.owner-help",
		message:
			"Stamped on the entries this import creates, so a later run can tell which are missing.",
	},
	ownerInvalid: {
		id: "flux-import.options.owner-invalid",
		message: "Use 1 to 100 letters, digits, dots, underscores, colons or hyphens",
	},
	ownerClash: {
		id: "flux-import.options.owner-clash",
		message:
			"The template {name} has the same owner for this collection and locale: the two imports behave as one, and each one's missing entries can include the other's.",
	},
	batchSize: { id: "flux-import.options.batch-size", message: "Batch size" },
	batchSizeHelp: {
		id: "flux-import.options.batch-size-help",
		message: "Records per batch. Leave empty for the default.",
	},
	batchSizeInvalid: {
		id: "flux-import.options.batch-size-invalid",
		message: "Enter a whole number from 1 to {max}",
	},
} satisfies Record<string, Msg>;
