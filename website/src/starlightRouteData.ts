import { defineRouteMiddleware, type StarlightRouteData } from "@astrojs/starlight/route-data";

type Entry = StarlightRouteData["sidebar"][number];
type Link = Extract<Entry, { type: "link" }>;

function links(entries: Entry[]): Link[] {
	return entries.flatMap((e) => (e.type === "link" ? [e] : links(e.entries)));
}

// Pages outside the sidebar (an API route such as jobs/create) mark their parent's link current,
// the longest sidebar link their path starts with, so the sidebar and breadcrumb show where
// they sit (ApiPage.dc.html: "jobs" is current on jobs/create).
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const all = links(route.sidebar);
	if (all.some((l) => l.isCurrent)) return;
	const path = context.url.pathname;
	const parent = all
		.filter((l) => l.href !== "/" && path.startsWith(l.href))
		.sort((a, b) => b.href.length - a.href.length)[0];
	if (parent) parent.isCurrent = true;
});
