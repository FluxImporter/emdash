import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/integration-cf/**/*.test.ts"],
		globalSetup: ["tests/integration-cf/global-setup.ts"],
		fileParallelism: false,
		// The 10,000-row import takes about 870 s under local workerd (57 s on Node).
		testTimeout: 1_800_000,
		hookTimeout: 300_000,
	},
});
