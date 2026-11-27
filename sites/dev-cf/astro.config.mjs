import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fluxImporter, fluxImporterRoutes } from "@fluximporter/emdash";

// Same plugin and routes as sites/dev, on D1 and R2 under workerd.
export default defineConfig({
	output: "server",
	// Translation imports (M4e) need i18n with more than one locale.
	i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] },
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [fluxImporter()],
		}),
		// The parity tests fetch URL sources from a local HTTP server (development only).
		fluxImporterRoutes({ allowPrivateNetwork: true }),
	],
	devToolbar: { enabled: false },
});
