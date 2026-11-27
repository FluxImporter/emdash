import { defineMiddleware } from "astro:middleware";
import { devMaintenanceStopped } from "./cron-stop.js";

/**
 * Since EmDash 1.3.0 (#2768), Cloudflare `astro dev` runs EmDash's scheduled maintenance (plugin
 * cron included) every 60 s: the dev server POSTs `/_emdash/api/dev/scheduled-tasks` from Node
 * (`emdash` src/astro/integration/dev-scheduler-bridge.ts), and `runtime.stopCron()` does not stop
 * it. Once a test has stopped the cron, that request does nothing, so the tests drive every
 * scheduler tick themselves (`/cdn-cgi/handler/scheduled`).
 */
export const onRequest = defineMiddleware((context, next) => {
	if (
		import.meta.env.DEV &&
		context.url.pathname === "/_emdash/api/dev/scheduled-tasks" &&
		devMaintenanceStopped()
	) {
		return new Response(null, { status: 204, headers: { "X-Flux-Maintenance": "skipped" } });
	}
	return next();
});
