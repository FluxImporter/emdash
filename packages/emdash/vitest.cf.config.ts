import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/integration-cf/**/*.test.ts"],
		globalSetup: ["tests/integration-cf/global-setup.ts"],
		fileParallelism: false,
		// The 10,000-row import has its own, longer timeout (parity.test.ts `SCALE_TIMEOUT_MS`).
		testTimeout: 1_800_000,
		hookTimeout: 300_000,
	},
});
