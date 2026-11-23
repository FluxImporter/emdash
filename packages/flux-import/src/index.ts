import type { PluginDescriptor } from "emdash";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
import { createPlugin, type FluxImportOptions } from "./plugin/definition.js";

export { type FluxImportRoutesOptions, fluxImportRoutes } from "./astro/integration.js";
export { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
export { createPlugin, type FluxImportOptions };

export function fluxImport(options: FluxImportOptions = {}): PluginDescriptor<FluxImportOptions> {
	return {
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		format: "native",
		entrypoint: "flux-import",
		// The React admin module Astro bundles; matches the runtime's `admin.entry`.
		adminEntry: "flux-import/admin",
		options,
	};
}

export default createPlugin;
