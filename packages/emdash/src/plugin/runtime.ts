import type { EmDashRuntime } from "emdash/middleware";

export type { EmDashRuntime };

/**
 * Runs `run` against the EmDash runtime (`withEmDashRuntime`, `emdash` dist/astro/middleware.d.mts:37-71).
 * `emdash/middleware` imports `virtual:emdash/*` modules that exist only inside the Astro build,
 * so it is loaded on first use: `astro.config.mjs` and unit tests can import the plugin without it.
 */
export async function withRuntime<T>(run: (runtime: EmDashRuntime) => Promise<T>): Promise<T> {
	const { withEmDashRuntime } = await import("emdash/middleware");
	return withEmDashRuntime(run);
}
