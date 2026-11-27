import type { Msg } from "../i18n.js";
import type { TabId } from "./url.js";

/** The Imports home's own messages: the page, its tabs and the link to the wizard. */
export const M = {
	title: { id: "fluximporter.home.title", message: "Imports" },
	newImport: { id: "fluximporter.home.new-import", message: "New import" },
	checkingAccess: { id: "fluximporter.home.checking-access", message: "Checking access" },
	loadFailed: { id: "fluximporter.home.load-failed", message: "Imports could not be loaded." },
	tabs: {
		jobs: { id: "fluximporter.home.tab-jobs", message: "Jobs" },
		templates: { id: "fluximporter.home.tab-templates", message: "Templates" },
		sources: { id: "fluximporter.home.tab-sources", message: "Sources" },
		schedules: { id: "fluximporter.home.tab-schedules", message: "Schedules" },
	},
} satisfies {
	title: Msg;
	newImport: Msg;
	checkingAccess: Msg;
	loadFailed: Msg;
	tabs: Record<TabId, Msg>;
};
