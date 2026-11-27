import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
			},
			{
				// M7a: the admin's React components, in a DOM (Fact V9).
				extends: true,
				test: {
					name: "admin",
					include: ["tests/admin/**/*.test.{ts,tsx}"],
					environment: "happy-dom",
					setupFiles: ["tests/admin/setup.ts"],
				},
			},
		],
	},
});
