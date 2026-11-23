import type { Msg } from "../i18n.js";

/** The wizard's shared messages: the step footer and Map's blockers (preflight F11). */
export const M = {
	back: { id: "flux-import.wizard.back", message: "Back" },
	next: { id: "flux-import.wizard.next", message: "Next" },
	keyUnmapped: {
		id: "flux-import.wizard.key-unmapped",
		message: "Choose the source key that identifies each record",
	},
	requiredUnmapped: {
		id: "flux-import.wizard.required-unmapped",
		message: "{field} is required: map a source key to it",
	},
	requiredUnmappable: {
		id: "flux-import.wizard.required-unmappable",
		message: "Every record would fail: {field} is required and cannot be imported",
	},
	unsupportedField: {
		id: "flux-import.wizard.unsupported-field",
		message:
			"{field} has a field type this version of EmDash cannot read, so nothing can be imported into this collection",
	},
	noFieldMapped: { id: "flux-import.wizard.no-field-mapped", message: "Map at least one field" },
	translationOfUnmapped: {
		id: "flux-import.wizard.translation-of-unmapped",
		message: "Choose the source key that names the record each translation belongs to",
	},
} satisfies Record<string, Msg>;
