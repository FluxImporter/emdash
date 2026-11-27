import type { PluginDescriptor } from "emdash";
import { FLUX_IMPORTER_ID, FLUX_IMPORTER_VERSION } from "./meta.js";
import { createPlugin, type FluxImporterOptions } from "./plugin/definition.js";

export { type FluxImporterRoutesOptions, fluxImporterRoutes } from "./astro/integration.js";
export { FLUX_IMPORTER_ID, FLUX_IMPORTER_VERSION } from "./meta.js";
export { createPlugin, type FluxImporterOptions };

export function fluxImporter(
	options: FluxImporterOptions = {},
): PluginDescriptor<FluxImporterOptions> {
	return {
		id: FLUX_IMPORTER_ID,
		version: FLUX_IMPORTER_VERSION,
		format: "native",
		entrypoint: "@fluximporter/emdash",
		// The React admin module Astro bundles; matches the runtime's `admin.entry`.
		adminEntry: "@fluximporter/emdash/admin",
		options,
	};
}

/** The default export is the descriptor factory too: `import fluxImporter from "@fluximporter/emdash"`. */
export default fluxImporter;
