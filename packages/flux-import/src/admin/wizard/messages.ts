import type { Msg } from "../i18n.js";
import type { StepId } from "./state.js";

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
	formatUnset: {
		id: "flux-import.wizard.format-unset",
		message: "{field} is Portable Text: choose the format of its source",
	},
	noFieldMapped: { id: "flux-import.wizard.no-field-mapped", message: "Map at least one field" },
	translationOfUnmapped: {
		id: "flux-import.wizard.translation-of-unmapped",
		message: "Choose the source key that names the record each translation belongs to",
	},
} satisfies Record<string, Msg>;

/** The wizard shell's messages: the step bar, the step names and the access probe (preflight F11). */
export const SHELL = {
	steps: { id: "flux-import.shell.steps", message: "Steps" },
	checkingAccess: { id: "flux-import.shell.checking-access", message: "Checking access" },
	tryAgain: { id: "flux-import.shell.try-again", message: "Try again" },
	notAvailable: { id: "flux-import.shell.not-available", message: "(not available yet)" },
	step: {
		source: { id: "flux-import.shell.step-source", message: "Source" },
		target: { id: "flux-import.shell.step-target", message: "Target" },
		map: { id: "flux-import.shell.step-map", message: "Map" },
		options: { id: "flux-import.shell.step-options", message: "Options" },
		preview: { id: "flux-import.shell.step-preview", message: "Preview" },
		run: { id: "flux-import.shell.step-run", message: "Run" },
	},
} satisfies {
	steps: Msg;
	checkingAccess: Msg;
	tryAgain: Msg;
	notAvailable: Msg;
	step: Record<StepId, Msg>;
};
