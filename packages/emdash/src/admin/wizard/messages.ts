import type { Msg, PluralMsg } from "../i18n.js";
import type { StepId } from "./state.js";

/**
 * The wizard's shared messages: each step's Back and Next, Map's blockers (preflight F11) and the
 * line that says how the entries will go live (Preview and Run).
 */
export const M = {
	back: { id: "fluximporter.wizard.back", message: "Back" },
	/** Next names where it goes (Copy: "Next: Target"); `{step}` is the next step's name. */
	nextTo: { id: "fluximporter.wizard.next-to", message: "Next: {step}" },
	keyUnmapped: {
		id: "fluximporter.wizard.key-unmapped",
		message: "Choose the source key that identifies each record",
	},
	requiredUnmapped: {
		id: "fluximporter.wizard.required-unmapped",
		message: "{field} is required: map a source key to it",
	},
	requiredUnmappable: {
		id: "fluximporter.wizard.required-unmappable",
		message: "Every record would fail: {field} is required and cannot be imported",
	},
	unsupportedField: {
		id: "fluximporter.wizard.unsupported-field",
		message:
			"{field} has a field type this version of EmDash cannot read, so nothing can be imported into this collection",
	},
	formatUnset: {
		id: "fluximporter.wizard.format-unset",
		message: "{field} is Portable Text: choose the format of its source",
	},
	noFieldMapped: { id: "fluximporter.wizard.no-field-mapped", message: "Map at least one field" },
	translationOfUnmapped: {
		id: "fluximporter.wizard.translation-of-unmapped",
		message: "Choose the source key that names the record each translation belongs to",
	},
	publishingNow: {
		id: "fluximporter.wizard.publishing-now",
		message: "Entries will be published.",
	},
	publishingDraft: {
		id: "fluximporter.wizard.publishing-draft",
		message: "Entries will be saved as drafts.",
	},
	publishingFixed: {
		id: "fluximporter.wizard.publishing-fixed",
		message: "Entries will be scheduled for {when}, in the site's timezone.",
	},
	publishingFeed: {
		id: "fluximporter.wizard.publishing-feed",
		message: "Entries will be scheduled by the date in the source key {key}.",
	},
	publishingKept: {
		id: "fluximporter.wizard.publishing-kept",
		message: "Entries will be scheduled as the saved template sets it.",
	},
} satisfies Record<string, Msg>;

/**
 * The wizard shell's messages: the step bar, the step names, the way out of the page and the
 * access probe (preflight F11).
 */
export const SHELL = {
	steps: { id: "fluximporter.shell.steps", message: "Steps" },
	checkingAccess: { id: "fluximporter.shell.checking-access", message: "Checking access" },
	accessFailed: {
		id: "fluximporter.shell.access-failed",
		message: "The import page could not be opened.",
	},
	notAvailable: { id: "fluximporter.shell.not-available", message: "(not available yet)" },
	done: { id: "fluximporter.shell.done", message: "(done)" },
	/** Leaves the page for the Imports home, before a run exists. */
	cancel: { id: "fluximporter.shell.cancel", message: "Cancel" },
	/** Leaves the Run step for the Imports home. */
	seeAll: { id: "fluximporter.shell.see-all", message: "See all imports" },
	step: {
		source: { id: "fluximporter.shell.step-source", message: "Source" },
		target: { id: "fluximporter.shell.step-target", message: "Target" },
		map: { id: "fluximporter.shell.step-map", message: "Map" },
		options: { id: "fluximporter.shell.step-options", message: "Options" },
		preview: { id: "fluximporter.shell.step-preview", message: "Preview" },
		run: { id: "fluximporter.shell.step-run", message: "Run" },
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
		id: "fluximporter.summary.source",
		message: "Choose a file, a URL, pasted text or a saved source.",
	},
	target: {
		id: "fluximporter.summary.target",
		message: "Choose the collection and locale the records go to.",
	},
	/** `{source}` is the data's name, `{keys}` its key count ("5 keys"). */
	map: { id: "fluximporter.summary.map", message: "{source} · {keys} → {collection} · {locale}" },
	options: {
		id: "fluximporter.summary.options",
		message: "Choose how entries are written and published.",
	},
} satisfies Record<string, Msg>;

/** Counts the summaries share. */
export const COUNT = {
	keys: { id: "fluximporter.summary.keys", one: "{count} key", other: "{count} keys" },
} satisfies Record<string, PluralMsg>;
