import { defineConfig } from "vitest/config";

/** CPU micro-benchmarks, run by hand: `npx vitest run --config vitest.bench.config.ts`. */
export default defineConfig({
	test: { include: ["tests/bench/**/*.bench.ts"], environment: "node" },
});
