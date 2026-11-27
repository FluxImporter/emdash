/** Replaced at build time by `fluxImporterRoutes()` through Vite `define`. */
declare const __FLUX_IMPORTER_MAX_SOURCE_BYTES__: number | undefined;
declare const __FLUX_IMPORTER_ALLOW_PRIVATE_NETWORK__: boolean | undefined;

/**
 * On Node the local storage adapter buffers the whole upload in memory
 * (`emdash` src/storage/local.ts:84-94), so the default stays modest.
 */
export const MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024;

/** XLSX files are read whole into memory to be converted, so they have their own, lower limit. */
export const XLSX_MAX_BYTES = 10 * 1024 * 1024;

export function maxSourceBytes(): number {
	return typeof __FLUX_IMPORTER_MAX_SOURCE_BYTES__ === "number"
		? __FLUX_IMPORTER_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}

/** The XLSX file limit: 10 MiB, or `maxSourceBytes` when that is lower. */
export function maxXlsxBytes(): number {
	return Math.min(XLSX_MAX_BYTES, maxSourceBytes());
}

/**
 * Whether URL sources may reach private and loopback hosts: only when `fluxImporterRoutes()` was
 * given `allowPrivateNetwork: true` and the code runs in development. A production build replaces
 * `import.meta.env.DEV` with `false`, so the option is ignored there.
 */
export function allowPrivateNetwork(
	requested: boolean = typeof __FLUX_IMPORTER_ALLOW_PRIVATE_NETWORK__ === "boolean" &&
		__FLUX_IMPORTER_ALLOW_PRIVATE_NETWORK__,
	dev: boolean = import.meta.env.DEV,
): boolean {
	return requested && dev;
}
