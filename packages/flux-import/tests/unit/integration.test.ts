import { describe, expect, it } from "vitest";
import { MAX_SOURCE_BYTES_DEFAULT, maxSourceBytes } from "../../src/astro/config.js";
import { fluxImportRoutes, UPLOAD_ROUTE } from "../../src/astro/integration.js";

type SetupArgs = {
	injectRoute: (route: { pattern: string; entrypoint: string; prerender?: boolean }) => void;
	updateConfig: (config: { vite: { define: Record<string, string> } }) => void;
};

function runSetup(options?: Parameters<typeof fluxImportRoutes>[0]) {
	const routes: unknown[] = [];
	const configs: unknown[] = [];
	const integration = fluxImportRoutes(options);
	const setup = integration.hooks["astro:config:setup"] as unknown as (args: SetupArgs) => void;
	setup({ injectRoute: (r) => routes.push(r), updateConfig: (c) => configs.push(c) });
	return { integration, routes, configs };
}

describe("fluxImportRoutes", () => {
	it("injects the upload route and passes the size limit to the build", () => {
		const { integration, routes, configs } = runSetup({ maxSourceBytes: 1234 });
		expect(integration.name).toBe("flux-import-routes");
		expect(routes).toEqual([
			{ pattern: UPLOAD_ROUTE, entrypoint: "flux-import/astro/upload", prerender: false },
		]);
		expect(UPLOAD_ROUTE).toBe("/_emdash/api/flux-import/uploads");
		expect(configs).toEqual([{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: "1234" } } }]);
	});

	it("defaults to 50 MiB and rejects a bad limit", () => {
		expect(runSetup().configs).toEqual([
			{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT) } } },
		]);
		expect(() => fluxImportRoutes({ maxSourceBytes: 0 })).toThrow("positive integer");
		expect(() => fluxImportRoutes({ maxSourceBytes: 1.5 })).toThrow("positive integer");
	});

	it("falls back to the default limit outside the build", () => {
		expect(maxSourceBytes()).toBe(MAX_SOURCE_BYTES_DEFAULT);
	});
});
