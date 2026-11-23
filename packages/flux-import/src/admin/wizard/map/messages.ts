import type { Msg } from "../../i18n.js";

/** The Map step's messages: the keys and fields panes, drag and drop, and the suggestions. */
export const M = {
	keysHeading: { id: "flux-import.map.keys-heading", message: "Source keys · {count}" },
	filterKeys: { id: "flux-import.map.filter-keys", message: "Filter keys" },
	keysShown: { id: "flux-import.map.keys-shown", message: "Showing {shown} of {total} keys" },
	noKeyMatches: { id: "flux-import.map.no-key-matches", message: "No key matches the filter" },
	noSample: { id: "flux-import.map.no-sample", message: "not in the sample" },
	used: { id: "flux-import.map.used", message: "used" },

	fieldsHeading: { id: "flux-import.map.fields-heading", message: "{collection} fields" },
	fieldsLoading: { id: "flux-import.map.fields-loading", message: "Loading the fields" },
	tryAgain: { id: "flux-import.map.try-again", message: "Try again" },
	keyRow: { id: "flux-import.map.key-row", message: "Key" },
	keyHint: { id: "flux-import.map.key-hint", message: "unique import key" },
	slugRow: { id: "flux-import.map.slug-row", message: "Slug" },
	bylinesRow: { id: "flux-import.map.bylines-row", message: "Bylines" },
	translationOfRow: {
		id: "flux-import.map.translation-of-row",
		message: "Translation of ({locale})",
	},
	taxonomyType: { id: "flux-import.map.taxonomy-type", message: "taxonomy" },
	required: { id: "flux-import.map.required", message: "required" },
	dropKey: { id: "flux-import.map.drop-key", message: "Drop a key" },
	expressionChip: { id: "flux-import.map.expression-chip", message: "Expression" },
	remove: { id: "flux-import.map.remove", message: "Remove" },
	removeKey: { id: "flux-import.map.remove-key", message: "Remove {key} from {field}" },
	removeExpression: {
		id: "flux-import.map.remove-expression",
		message: "Remove the expression from {field}",
	},
	unsupported: {
		id: "flux-import.map.unsupported",
		message: "This version of EmDash cannot read this field type",
	},
	notImportable: {
		id: "flux-import.map.not-importable",
		message: "A {type} field cannot be imported",
	},
	unboundReference: {
		id: "flux-import.map.unbound-reference",
		message: "This reference field is not linked to a collection to look entries up in",
	},
	addField: { id: "flux-import.map.add-field", message: "+ Add a new field" },
	addFieldHint: {
		id: "flux-import.map.add-field-hint",
		message: "Drop a key here, or choose it, to propose a new field",
	},

	detailHeading: { id: "flux-import.map.detail-heading", message: "Details" },
	nothingSelected: {
		id: "flux-import.map.nothing-selected",
		message: "Select a field to choose its key and settings.",
	},
	newFieldHeading: { id: "flux-import.map.new-field-heading", message: "Add a new field" },
	newFieldIntro: {
		id: "flux-import.map.new-field-intro",
		message:
			"Choose the key to read. The new field is listed under New fields, and nothing changes until you confirm it.",
	},
	newFieldKey: { id: "flux-import.map.new-field-key", message: "Key for the new field" },
	proposed: {
		id: "flux-import.map.proposed",
		message: "{label} is proposed as a new {type} field",
	},

	instructions: {
		id: "flux-import.map.instructions",
		message:
			"To map a key, press Space to pick it up, move it over a field with the arrow keys, and press Space again to drop it, or Escape to cancel. Selecting a field also lets you choose its key.",
	},
	pickedUp: { id: "flux-import.map.picked-up", message: "Picked up the key {key}." },
	over: { id: "flux-import.map.over", message: "The key {key} is over {field}." },
	notOver: { id: "flux-import.map.not-over", message: "The key {key} is over no field." },
	dropped: { id: "flux-import.map.dropped", message: "The key {key} was dropped on {field}." },
	droppedNowhere: {
		id: "flux-import.map.dropped-nowhere",
		message: "The key {key} was dropped outside the fields; nothing changed.",
	},
	cancelled: {
		id: "flux-import.map.cancelled",
		message: "Moving the key {key} was cancelled; nothing changed.",
	},

	suggestions: { id: "flux-import.map.suggestions", message: "Suggestions" },
	asking: { id: "flux-import.map.asking", message: "Asking for suggestions…" },
	statusAi: {
		id: "flux-import.map.status-ai",
		message: "AI ({provider}) · {filled} filled, {check} to check",
	},
	statusName: { id: "flux-import.map.status-name", message: "Name matching" },
	statusNameUnavailable: {
		id: "flux-import.map.status-name-unavailable",
		message: "Name matching · AI unavailable",
	},
	providers: {
		anthropic: { id: "flux-import.map.provider-anthropic", message: "Anthropic" },
		"openai-compatible": {
			id: "flux-import.map.provider-openai-compatible",
			message: "OpenAI-compatible",
		},
	},
	askAgain: { id: "flux-import.map.ask-again", message: "Ask again" },
	suggestFailed: {
		id: "flux-import.map.suggest-failed",
		message: "No suggestions: map the fields yourself, or try again.",
	},
	warningsTitle: { id: "flux-import.map.warnings-title", message: "About these suggestions" },
	dismiss: { id: "flux-import.map.dismiss", message: "Dismiss" },
	replaceTitle: {
		id: "flux-import.map.replace-title",
		message: "Replace the fields you mapped yourself?",
	},
	replaceDescription: {
		id: "flux-import.map.replace-description",
		message:
			"New suggestions fill the other fields either way. Keep your choices, or let the suggestions replace them too.",
	},
	keepChoices: { id: "flux-import.map.keep-choices", message: "Keep my choices" },
	replaceChoices: { id: "flux-import.map.replace-choices", message: "Replace them" },
	cancel: { id: "flux-import.map.cancel", message: "Cancel" },

	waitSuggestions: {
		id: "flux-import.map.wait-suggestions",
		message: "Wait for the suggestions to finish",
	},
	waitFields: { id: "flux-import.map.wait-fields", message: "Wait for the fields to load" },
} satisfies Record<string, Msg | Record<string, Msg>>;
