import { describe, expect, it } from "vitest";
import { MAX_SOURCE_BYTES_DEFAULT, maxSourceBytes } from "../../src/astro/config.js";
import { fluxImportRoutes, UPLOAD_ROUTE } from "../../src/astro/integration.js";

interface ViteConfig {
	define: Record<string, string>;
	build: {
		rolldownOptions: {
			output: { codeSplitting: { groups: { name: string; test: RegExp }[] } };
		};
	};
}

type SetupArgs = {
	injectRoute: (route: { pattern: string; entrypoint: string; prerender?: boolean }) => void;
	updateConfig: (config: { vite: ViteConfig }) => void;
};

function runSetup(options?: Parameters<typeof fluxImportRoutes>[0]) {
	const routes: unknown[] = [];
	const configs: { vite: ViteConfig }[] = [];
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
		expect(configs.map((c) => c.vite.define)).toEqual([
			{
				__FLUX_IMPORT_MAX_SOURCE_BYTES__: "1234",
				__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "false",
			},
		]);
	});

	it("passes allowPrivateNetwork to the build", () => {
		expect(runSetup({ allowPrivateNetwork: true }).configs.map((c) => c.vite.define)).toEqual([
			{
				__FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT),
				__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "true",
			},
		]);
	});

	it("defaults to 50 MiB and rejects a bad limit", () => {
		expect(runSetup().configs.map((c) => c.vite.define)).toEqual([
			{
				__FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT),
				__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "false",
			},
		]);
		expect(() => fluxImportRoutes({ maxSourceBytes: 0 })).toThrow("positive integer");
		expect(() => fluxImportRoutes({ maxSourceBytes: 1.5 })).toThrow("positive integer");
	});

	it("bundles kysely into one chunk, so a Cloudflare build does not split its class cycle", () => {
		const [config] = runSetup().configs;
		const groups = config?.vite.build.rolldownOptions.output.codeSplitting.groups ?? [];
		expect(groups.map((g) => g.name)).toEqual(["kysely"]);
		const test = groups[0]?.test ?? /$^/;
		for (const id of [
			"/site/node_modules/.pnpm/kysely@0.29.6/node_modules/kysely/dist/esm/index.js",
			"C:\\site\\node_modules\\kysely\\dist\\esm\\query-builder.js",
		]) {
			expect(test.test(id), id).toBe(true);
		}
		for (const id of [
			"/site/node_modules/kysely-d1/dist/index.js",
			"/site/node_modules/emdash/dist/kysely.js",
			"/site/src/kysely/x.ts",
		]) {
			expect(test.test(id), id).toBe(false);
		}
	});

	it("falls back to the default limit outside the build", () => {
		expect(maxSourceBytes()).toBe(MAX_SOURCE_BYTES_DEFAULT);
	});
});
