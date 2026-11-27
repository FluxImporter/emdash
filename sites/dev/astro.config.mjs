import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fluxImporter, fluxImporterRoutes } from "@fluximporter/emdash";

// Integration tests point the site at a throwaway database and upload directory.
const databaseFile = process.env.FLUX_DEV_DB ?? "./data.db";
const uploadsDir = process.env.FLUX_DEV_UPLOADS ?? "./uploads";
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
// URL source tests fetch from a local HTTP server; the option only works under `astro dev`.
const allowPrivateNetwork = process.env.FLUX_DEV_ALLOW_PRIVATE_NETWORK === "1";
// Media tests lower EmDash's upload limit, so a too-large file stays small.
const maxUploadSize = Number(process.env.FLUX_DEV_MAX_UPLOAD_SIZE) || undefined;
// Locale tests use Astro's `{ path, codes }` locales (EmDash 1.3.1 and later).
const paths = process.env.FLUX_DEV_I18N === "paths";
const PATH_LOCALES = [
	{ path: "en", codes: ["en-US"] },
	{ path: "fr", codes: ["fr-FR", "fr-CA"] },
	"de",
];
// The co-editing tests turn on EmDash's co-editing rooms (EmDash 1.5).
const coEditing = process.env.FLUX_DEV_CO_EDITING === "1";

export default defineConfig({
	output: "server",
	// Translation imports (M4e) need i18n with more than one locale.
	i18n: { defaultLocale: "en", locales: paths ? PATH_LOCALES : ["en", "fr", "de"] },
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databaseFile}` }),
			plugins: [fluxImporter()],
			storage: local({
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
			...(maxUploadSize ? { maxUploadSize } : {}),
			...(coEditing ? { coEditing } : {}),
		}),
		fluxImporterRoutes({ ...(maxSourceBytes ? { maxSourceBytes } : {}), allowPrivateNetwork }),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
	// Integration tests fail instead of silently moving to another port.
	vite: process.env.FLUX_DEV_STRICT_PORT ? { server: { strictPort: true } } : {},
});
