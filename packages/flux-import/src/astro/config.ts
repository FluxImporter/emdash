/** Replaced at build time by `fluxImportRoutes()` through Vite `define`. */
declare const __FLUX_IMPORT_MAX_SOURCE_BYTES__: number | undefined;

/**
 * On Node the local storage adapter buffers the whole upload in memory
 * (`emdash` src/storage/local.ts:84-94), so the default stays modest.
 */
export const MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024;

export function maxSourceBytes(): number {
	return typeof __FLUX_IMPORT_MAX_SOURCE_BYTES__ === "number"
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}
