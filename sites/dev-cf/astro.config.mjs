import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fluxImport, fluxImportRoutes } from "flux-import";

// Same plugin and routes as sites/dev, on D1 and R2 under workerd.
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [fluxImport()],
		}),
		fluxImportRoutes(),
	],
	devToolbar: { enabled: false },
});
