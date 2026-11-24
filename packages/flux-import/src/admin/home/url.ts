export const TABS = ["jobs", "templates", "sources", "schedules"] as const;
export type TabId = (typeof TABS)[number];

/** The tab named by `?tab=`; an unknown or absent one is Jobs (plan Ruling 10). */
export function readTab(search: string): TabId {
	const tab = new URLSearchParams(search).get("tab");
	return TABS.find((id) => id === tab) ?? "jobs";
}

/** Sets `?tab=`, keeping the other parameters; the URL is replaced, keeping `history.state`. */
export function writeTab(tab: TabId): void {
	const url = new URL(window.location.href);
	url.searchParams.set("tab", tab);
	window.history.replaceState(window.history.state, "", url.href);
}
