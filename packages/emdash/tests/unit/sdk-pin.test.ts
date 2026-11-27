import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** The repository root, from packages/emdash/tests/unit. */
const ROOT = new URL("../../../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, ROOT), "utf8");

describe("the pinned Anthropic SDK (spec Ruling 54)", () => {
	it("depends on @anthropic-ai/sdk at exactly 1.5.0 and installs that version", async () => {
		const pkg = JSON.parse(await read("packages/emdash/package.json")) as {
			dependencies: Record<string, string>;
		};
		expect(pkg.dependencies["@anthropic-ai/sdk"]).toBe("1.5.0");
		const { VERSION } = await import("@anthropic-ai/sdk/version");
		expect(VERSION).toBe("1.5.0");
	});

	it("holds every release for 14 days, so standardwebhooks stays at 1.1.1 (Fact V9)", async () => {
		expect(await read("pnpm-workspace.yaml")).toMatch(/^minimumReleaseAge: 20160$/m);
		const lock = await read("pnpm-lock.yaml");
		expect(lock).toContain("\n  standardwebhooks@1.1.1:\n");
		expect(lock).not.toMatch(/standardwebhooks@1\.[23]\./);
		expect(lock).toContain("'@anthropic-ai/sdk@1.5.0(zod@4.5.4)':");
	});
});
