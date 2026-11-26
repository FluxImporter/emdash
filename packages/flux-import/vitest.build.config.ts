import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/build/**/*.test.ts"],
		fileParallelism: false,
		// A production build of sites/dev-cf takes about 10 s; workerd's first start is slower.
		testTimeout: 300_000,
		hookTimeout: 300_000,
	},
});
