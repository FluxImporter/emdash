import type { PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

export const FLUX_IMPORT_ID = "flux-import";
export const FLUX_IMPORT_VERSION = "0.1.0";

export type FluxImportOptions = Record<string, never>;

export function fluxImport(options: FluxImportOptions = {}): PluginDescriptor<FluxImportOptions> {
	return {
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		format: "native",
		entrypoint: "flux-import",
		options,
	};
}

export function createPlugin(_options: FluxImportOptions = {}) {
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		capabilities: [],
	});
}

export default createPlugin;
