import type { APIRoute } from "astro";
import { runScheduledTasks } from "emdash/middleware";

export const prerender = false;

/**
 * Dev only: runs EmDash's scheduled maintenance now (`emdash/middleware` `runScheduledTasks`), so
 * the integration tests publish due entries without waiting up to a minute for the Node timer. It
 * publishes content, so it needs the `X-EmDash-Request: 1` header, as EmDash's own routes do.
 * The published docs do not list `runScheduledTasks`; its source is the package's typings,
 * `emdash/dist/astro/middleware.d.mts:30-35` (EmDash 1.2.0).
 */
export const POST: APIRoute = async ({ request }) => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	if (request.headers.get("X-EmDash-Request") !== "1") return new Response(null, { status: 403 });
	const { published } = await runScheduledTasks();
	return Response.json({ published });
};
