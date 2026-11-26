import type { AstroIntegration } from "astro";
import { MAX_SOURCE_BYTES_DEFAULT } from "./config.js";

export interface FluxImportRoutesOptions {
	/** Largest accepted upload in bytes. Default 50 MiB. */
	maxSourceBytes?: number;
	/**
	 * Lets URL sources reach private and loopback addresses, for development and tests. Honoured
	 * only when `import.meta.env.DEV` is true; production builds ignore it.
	 */
	allowPrivateNetwork?: boolean;
}

export const UPLOAD_ROUTE = "/_emdash/api/flux-import/uploads";

/**
 * Every module of the `kysely` package (with any package manager's layout, on any OS), but not
 * packages whose names only start with it, such as `kysely-d1`.
 */
const KYSELY_MODULES = /node_modules[\\/]kysely[\\/]/;

/**
 * Adds the streamed upload route. Plugin routes buffer bodies and cap them at 8 MiB, so the
 * upload is a trusted Astro route under `/_emdash/api/`, where EmDash's auth and CSRF
 * middleware apply (verification report, question 5).
 *
 * It also keeps `kysely` in one server chunk. With EmDash 1.2.0, Astro 7 (Vite 8, Rolldown) and
 * `@astrojs/cloudflare` 14, a site's build splits kysely into chunks that import each other, and
 * the built Worker fails at load with "Class extends value undefined is not a constructor or
 * null" (a class there extends `OperationNodeTransformer` before its chunk has run). This happens
 * without the plugin too; the Node build happens to load the chunks in a safe order.
 */
export function fluxImportRoutes(options: FluxImportRoutesOptions = {}): AstroIntegration {
	const max = options.maxSourceBytes ?? MAX_SOURCE_BYTES_DEFAULT;
	if (!Number.isSafeInteger(max) || max < 1) {
		throw new Error("fluxImportRoutes: maxSourceBytes must be a positive integer");
	}
	return {
		name: "flux-import-routes",
		hooks: {
			"astro:config:setup": ({ injectRoute, updateConfig }) => {
				updateConfig({
					vite: {
						define: {
							__FLUX_IMPORT_MAX_SOURCE_BYTES__: JSON.stringify(max),
							__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: JSON.stringify(
								options.allowPrivateNetwork === true,
							),
						},
						build: {
							rolldownOptions: {
								output: { codeSplitting: { groups: [{ name: "kysely", test: KYSELY_MODULES }] } },
							},
						},
					},
				});
				injectRoute({
					pattern: UPLOAD_ROUTE,
					entrypoint: "flux-import/astro/upload",
					prerender: false,
				});
			},
		},
	};
}
