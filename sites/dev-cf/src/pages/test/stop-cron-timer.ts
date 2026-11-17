import type { APIRoute } from "astro";
import { withEmDashRuntime } from "emdash/middleware";

export const prerender = false;

/**
 * Dev only (M6b plan Ruling 1): stops EmDash's cron timer for this server's life, so the
 * integration tests drive every scheduler tick themselves through `/test/run-scheduled`. A test
 * site route, never a plugin route: plugin routes ship to every site. A production build answers
 * 403 (`import.meta.env.DEV` is false at build time), and the call changes server state, so it
 * needs `X-EmDash-Request: 1` as `run-scheduled.ts` does.
 */
export const POST: APIRoute = async ({ request }) => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	if (request.headers.get("X-EmDash-Request") !== "1") return new Response(null, { status: 403 });
	await withEmDashRuntime((runtime) => runtime.stopCron());
	return Response.json({ stopped: true });
};
