import type { APIRoute } from "astro";
import { withEmDashRuntime } from "emdash/middleware";
import { stopDevMaintenance } from "../../cron-stop.js";

export const prerender = false;

/**
 * Dev only (M6b plan Ruling 1): stops EmDash's cron timer for this server's life, so the
 * integration tests drive every scheduler tick themselves (Node: `/test/run-scheduled`; workerd:
 * `/cdn-cgi/handler/scheduled`). A test site route, never a plugin route: plugin routes ship to
 * every site. A production build answers 403 (`import.meta.env.DEV` is false at build time), and
 * the call changes server state, so it needs `X-EmDash-Request: 1` as `run-scheduled.ts` does.
 * `runtime.stopCron()` stops the Node timer, and a later `reschedule()` (a hook's
 * `ctx.cron.schedule`/`cancel`) does not restart it (EmDash 1.2.0
 * `dist/emdash-runtime-C4oFeVpN.mjs:1266-1268`, `dist/menus-DL8IPIcm.mjs:3102-3115`). The body is
 * JSON because the tests' helper reads it. It also stops the dev server's maintenance bridge
 * (EmDash 1.3.0 and later; see `src/middleware.ts`).
 */
export const POST: APIRoute = async ({ request }) => {
	if (!import.meta.env.DEV) return new Response(null, { status: 403 });
	if (request.headers.get("X-EmDash-Request") !== "1") return new Response(null, { status: 403 });
	stopDevMaintenance();
	await withEmDashRuntime((runtime) => runtime.stopCron());
	return Response.json({ stopped: true });
};
