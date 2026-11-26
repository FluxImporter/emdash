import type { Msg } from "../i18n.js";
import type { TabId } from "./url.js";

/** The Imports home's own messages: the page, its tabs and the link to the wizard. */
export const M = {
	title: { id: "flux-import.home.title", message: "Imports" },
	newImport: { id: "flux-import.home.new-import", message: "New import" },
	checkingAccess: { id: "flux-import.home.checking-access", message: "Checking access" },
	loadFailed: { id: "flux-import.home.load-failed", message: "Imports could not be loaded." },
	tabs: {
		jobs: { id: "flux-import.home.tab-jobs", message: "Jobs" },
		templates: { id: "flux-import.home.tab-templates", message: "Templates" },
		sources: { id: "flux-import.home.tab-sources", message: "Sources" },
		schedules: { id: "flux-import.home.tab-schedules", message: "Schedules" },
	},
} satisfies {
	title: Msg;
	newImport: Msg;
	checkingAccess: Msg;
	loadFailed: Msg;
	tabs: Record<TabId, Msg>;
};
