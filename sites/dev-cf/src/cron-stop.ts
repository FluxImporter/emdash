/**
 * Set by `/test/stop-cron-timer`: from then on the dev server's maintenance bridge does nothing.
 * Kept on `globalThis` so the route and the middleware share it in the dev isolate.
 */
const KEY = Symbol.for("fluximporter:dev-cf:cron-stopped");

type Store = Record<symbol, boolean | undefined>;

export function stopDevMaintenance(): void {
	(globalThis as unknown as Store)[KEY] = true;
}

export function devMaintenanceStopped(): boolean {
	return (globalThis as unknown as Store)[KEY] === true;
}
