import type { Msg, PluralMsg } from "../i18n.js";
import type { StepId } from "./state.js";

/**
 * The wizard's shared messages: each step's Back and Next, Map's blockers (preflight F11) and the
 * line that says how the entries will go live (Preview and Run).
 */
export const M = {
	back: { id: "flux-import.wizard.back", message: "Back" },
	/** Next names where it goes (Copy: "Next: Target"); `{step}` is the next step's name. */
	nextTo: { id: "flux-import.wizard.next-to", message: "Next: {step}" },
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
	publishingNow: { id: "flux-import.wizard.publishing-now", message: "Entries will be published." },
	publishingDraft: {
		id: "flux-import.wizard.publishing-draft",
		message: "Entries will be saved as drafts.",
	},
	publishingFixed: {
		id: "flux-import.wizard.publishing-fixed",
		message: "Entries will be scheduled for {when}, in the site's timezone.",
	},
	publishingFeed: {
		id: "flux-import.wizard.publishing-feed",
		message: "Entries will be scheduled by the date in the source key {key}.",
	},
	publishingKept: {
		id: "flux-import.wizard.publishing-kept",
		message: "Entries will be scheduled as the saved template sets it.",
	},
} satisfies Record<string, Msg>;

/**
 * The wizard shell's messages: the step bar, the step names, the way out of the page and the
 * access probe (preflight F11).
 */
export const SHELL = {
	steps: { id: "flux-import.shell.steps", message: "Steps" },
	checkingAccess: { id: "flux-import.shell.checking-access", message: "Checking access" },
	accessFailed: {
		id: "flux-import.shell.access-failed",
		message: "The import page could not be opened.",
	},
	notAvailable: { id: "flux-import.shell.not-available", message: "(not available yet)" },
	done: { id: "flux-import.shell.done", message: "(done)" },
	/** Leaves the page for the Imports home, before a run exists. */
	cancel: { id: "flux-import.shell.cancel", message: "Cancel" },
	/** Leaves the Run step for the Imports home. */
	seeAll: { id: "flux-import.shell.see-all", message: "See all imports" },
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
	accessFailed: Msg;
	notAvailable: Msg;
	done: Msg;
	cancel: Msg;
	seeAll: Msg;
	step: Record<StepId, Msg>;
};

/** The line under each step's heading: what the step is for, or what it works on. */
export const SUMMARY = {
	source: {
		id: "flux-import.summary.source",
		message: "Choose a file, a URL, pasted text or a saved source.",
	},
	target: {
		id: "flux-import.summary.target",
		message: "Choose the collection and locale the records go to.",
	},
	/** `{source}` is the data's name, `{keys}` its key count ("5 keys"). */
	map: { id: "flux-import.summary.map", message: "{source} · {keys} → {collection} · {locale}" },
	options: {
		id: "flux-import.summary.options",
		message: "Choose how entries are written and published.",
	},
} satisfies Record<string, Msg>;

/** Counts the summaries share. */
export const COUNT = {
	keys: { id: "flux-import.summary.keys", one: "{count} key", other: "{count} keys" },
} satisfies Record<string, PluralMsg>;
