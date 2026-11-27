import type { Msg } from "../../i18n.js";

/** The edit dialogs' note on the schedules pinned to a template or source (plan Ruling 14). */
export const M = {
	templateRows: {
		id: "fluximporter.home-pinned.template-rows",
		message: "These schedules run this template: {names}.",
	},
	sourceRows: {
		id: "fluximporter.home-pinned.source-rows",
		message: "These schedules read this source: {names}.",
	},
	alsoUpdate: {
		id: "fluximporter.home-pinned.also-update",
		message: "Also update these schedules",
	},
	willPause: {
		id: "fluximporter.home-pinned.will-pause",
		message: "They will pause at their next run until they are updated.",
	},
	sourceRearm: {
		id: "fluximporter.home-pinned.source-rearm",
		message: "Updating them also clears their failed launches and arms them as you.",
	},
	failed: {
		id: "fluximporter.home-pinned.failed",
		message: "Couldn't update {name}: {reason} It will pause at its next run.",
	},
} satisfies Record<string, Msg>;
