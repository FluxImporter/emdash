import type { Msg, PluralMsg } from "../../i18n.js";

/** The Map step's messages: the keys and fields panes, drag and drop, and the suggestions. */
export const M = {
	keysHeading: { id: "fluximporter.map.keys-heading", message: "Source keys · {count}" },
	unused: { id: "fluximporter.map.unused", message: "unused" },
	filterKeys: { id: "fluximporter.map.filter-keys", message: "Filter keys" },
	keysShown: { id: "fluximporter.map.keys-shown", message: "Showing {shown} of {total} keys" },
	noKeyMatches: { id: "fluximporter.map.no-key-matches", message: "No key matches the filter" },
	noSample: { id: "fluximporter.map.no-sample", message: "not in the sample" },
	used: { id: "fluximporter.map.used", message: "used" },

	fieldsHeading: { id: "fluximporter.map.fields-heading", message: "{collection} fields" },
	fieldsHint: {
		id: "fluximporter.map.fields-hint",
		message: "Drop a key on a field, or select a field and press Enter",
	},
	fieldsLoading: { id: "fluximporter.map.fields-loading", message: "Loading the fields" },
	keyRow: { id: "fluximporter.map.key-row", message: "Key" },
	keyHint: { id: "fluximporter.map.key-hint", message: "unique import key" },
	slugRow: { id: "fluximporter.map.slug-row", message: "Slug" },
	bylinesRow: { id: "fluximporter.map.bylines-row", message: "Bylines" },
	translationOfRow: {
		id: "fluximporter.map.translation-of-row",
		message: "Translation of ({locale})",
	},
	taxonomyType: { id: "fluximporter.map.taxonomy-type", message: "taxonomy" },
	required: { id: "fluximporter.map.required", message: "required" },
	dropKey: { id: "fluximporter.map.drop-key", message: "No key" },
	expressionChip: { id: "fluximporter.map.expression-chip", message: "Expression" },
	remove: { id: "fluximporter.map.remove", message: "Remove" },
	removeKey: { id: "fluximporter.map.remove-key", message: "Remove {key} from {field}" },
	removeExpression: {
		id: "fluximporter.map.remove-expression",
		message: "Remove the expression from {field}",
	},
	unsupported: {
		id: "fluximporter.map.unsupported",
		message: "This version of EmDash cannot read this field type",
	},
	notImportable: {
		id: "fluximporter.map.not-importable",
		message: "A {type} field cannot be imported",
	},
	unboundReference: {
		id: "fluximporter.map.unbound-reference",
		message: "This reference field is not linked to a collection to look entries up in",
	},
	addField: {
		id: "fluximporter.map.add-field",
		message: "+ Drop a key here to propose a new field",
	},
	/** What a key is over or dropped on, in the drag announcements. */
	newFieldTarget: { id: "fluximporter.map.new-field-target", message: "a new field" },

	detailHeading: { id: "fluximporter.map.detail-heading", message: "Details" },
	nothingSelected: {
		id: "fluximporter.map.nothing-selected",
		message: "Select a field to choose its key and settings.",
	},
	newFieldHeading: { id: "fluximporter.map.new-field-heading", message: "Add a new field" },
	newFieldIntro: {
		id: "fluximporter.map.new-field-intro",
		message:
			"Choose the key to read. The new field is listed under New fields, and nothing changes until you confirm it.",
	},
	newFieldKey: { id: "fluximporter.map.new-field-key", message: "Key for the new field" },
	proposed: {
		id: "fluximporter.map.proposed",
		message: "{label} is proposed as a new {type} field",
	},

	instructions: {
		id: "fluximporter.map.instructions",
		message:
			"To map a key, select a field, then choose its key in the details panel. You can also drag a key: press Space to pick it up, move it over a field with the arrow keys, and press Space to drop it or Escape to cancel.",
	},
	pickedUp: { id: "fluximporter.map.picked-up", message: "Picked up the key {key}." },
	over: { id: "fluximporter.map.over", message: "The key {key} is over {field}." },
	notOver: { id: "fluximporter.map.not-over", message: "The key {key} is over no field." },
	dropped: { id: "fluximporter.map.dropped", message: "The key {key} was dropped on {field}." },
	droppedNowhere: {
		id: "fluximporter.map.dropped-nowhere",
		message: "The key {key} was dropped outside the fields; nothing changed.",
	},
	cancelled: {
		id: "fluximporter.map.cancelled",
		message: "Moving the key {key} was cancelled; nothing changed.",
	},

	asking: { id: "fluximporter.map.asking", message: "Asking for suggestions…" },
	statusAi: { id: "fluximporter.map.status-ai", message: "Suggestions by AI ({provider})" },
	statusName: { id: "fluximporter.map.status-name", message: "Suggestions by name matching" },
	statusNameUnavailable: {
		id: "fluximporter.map.status-name-unavailable",
		message: "Suggestions by name matching · AI unavailable",
	},
	checkMissing: {
		id: "fluximporter.map.check-missing",
		message: "Check: the sample has no key {key}.",
	},
	checkUnsure: {
		id: "fluximporter.map.check-unsure",
		message: "Check: the suggestion was not sure.",
	},
	checkFormat: {
		id: "fluximporter.map.check-format",
		message: "Check: the format of its values is unclear.",
	},
	providers: {
		anthropic: { id: "fluximporter.map.provider-anthropic", message: "Anthropic" },
		"openai-compatible": {
			id: "fluximporter.map.provider-openai-compatible",
			message: "OpenAI-compatible",
		},
	},
	askAgain: { id: "fluximporter.map.ask-again", message: "Ask again" },
	suggestFailed: {
		id: "fluximporter.map.suggest-failed",
		message: "No suggestions: map the fields yourself, or try again.",
	},
	warningsTitle: { id: "fluximporter.map.warnings-title", message: "About these suggestions" },
	dismiss: { id: "fluximporter.map.dismiss", message: "Dismiss" },
	replaceTitle: {
		id: "fluximporter.map.replace-title",
		message: "Replace the fields you mapped yourself?",
	},
	replaceDescription: {
		id: "fluximporter.map.replace-description",
		message:
			"New suggestions fill the other fields either way. Keep your choices, or let the suggestions replace them too.",
	},
	keepChoices: { id: "fluximporter.map.keep-choices", message: "Keep my choices" },
	replaceChoices: { id: "fluximporter.map.replace-choices", message: "Replace them" },
	cancel: { id: "fluximporter.map.cancel", message: "Cancel" },

	waitSuggestions: {
		id: "fluximporter.map.wait-suggestions",
		message: "Wait for the suggestions to finish",
	},
	waitFields: { id: "fluximporter.map.wait-fields", message: "Wait for the fields to load" },
} satisfies Record<string, Msg | Record<string, Msg>>;

/** The Map step's counts: the summary bar's mapped fields and checks. */
export const COUNT = {
	mapped: {
		id: "fluximporter.map.count-mapped",
		one: "{mapped} of {count} field mapped.",
		other: "{mapped} of {count} fields mapped.",
	},
	requiredDone: {
		id: "fluximporter.map.count-required-done",
		one: "The required field is done.",
		other: "All {count} required fields are done.",
	},
	requiredLeft: {
		id: "fluximporter.map.count-required-left",
		one: "{count} required field still needs a key.",
		other: "{count} required fields still need a key.",
	},
	unused: { id: "fluximporter.map.count-unused", one: "{count} unused", other: "{count} unused" },
	toCheck: {
		id: "fluximporter.map.count-to-check",
		one: "{count} to check",
		other: "{count} to check",
	},
} satisfies Record<string, PluralMsg>;
