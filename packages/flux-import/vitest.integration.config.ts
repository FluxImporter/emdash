import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/integration/**/*.test.ts"],
		globalSetup: ["tests/integration/global-setup.ts"],
		// Suites share one dev server and some start their own; run them one at a time.
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 240_000,
	},
});
