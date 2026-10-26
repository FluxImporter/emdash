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
 * Adds the streamed upload route. Plugin routes buffer bodies and cap them at 8 MiB, so the
 * upload is a trusted Astro route under `/_emdash/api/`, where EmDash's auth and CSRF
 * middleware apply (verification report, question 5).
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
