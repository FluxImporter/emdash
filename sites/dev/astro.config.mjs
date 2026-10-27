import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fluxImport, fluxImportRoutes } from "flux-import";

// Integration tests point the site at a throwaway database and upload directory.
const databaseFile = process.env.FLUX_DEV_DB ?? "./data.db";
const uploadsDir = process.env.FLUX_DEV_UPLOADS ?? "./uploads";
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
// URL source tests fetch from a local HTTP server; the option only works under `astro dev`.
const allowPrivateNetwork = process.env.FLUX_DEV_ALLOW_PRIVATE_NETWORK === "1";
// Media tests lower EmDash's upload limit, so a too-large file stays small.
const maxUploadSize = Number(process.env.FLUX_DEV_MAX_UPLOAD_SIZE) || undefined;

export default defineConfig({
	output: "server",
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
			plugins: [fluxImport()],
			storage: local({
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
			...(maxUploadSize ? { maxUploadSize } : {}),
		}),
		fluxImportRoutes({ ...(maxSourceBytes ? { maxSourceBytes } : {}), allowPrivateNetwork }),
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
