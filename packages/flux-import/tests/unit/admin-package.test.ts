import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** packages/flux-import, from tests/unit. */
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));

interface PackageJson {
	exports: Record<string, string>;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
const pkg = readJson(join(PACKAGE_DIR, "package.json"));
/** The admin this package's admin code runs inside (`@emdash-cms/admin`, a dev dependency). */
const ADMIN_DIR = realpathSync(join(PACKAGE_DIR, "node_modules/@emdash-cms/admin"));
const adminPkg = readJson(join(ADMIN_DIR, "package.json"));

describe("the admin package wiring (M7a Task 1)", () => {
	it("declares the admin export, the host peers and the admin's @dnd-kit ranges", () => {
		expect(pkg.exports["./admin"]).toBe("./src/admin/index.tsx");
		expect(pkg.peerDependencies).toMatchObject({
			"@cloudflare/kumo": "2.6.0",
			"@emdash-cms/admin": "*",
			"@lingui/core": "*",
			"@lingui/react": "*",
			"@tanstack/react-query": "*",
			react: "^18.0.0 || ^19.0.0",
		});
		expect(pkg.dependencies["@dnd-kit/core"]).toBe(adminPkg.dependencies["@dnd-kit/core"]);
		expect(pkg.dependencies["@dnd-kit/core"]).toBe("^6.3.1");
		expect(pkg.dependencies["@dnd-kit/utilities"]).toBe(
			adminPkg.dependencies["@dnd-kit/utilities"],
		);
		expect(pkg.devDependencies["@cloudflare/kumo"]).toBe(adminPkg.dependencies["@cloudflare/kumo"]);
		expect(pkg.devDependencies["@cloudflare/kumo"]).toBe("2.6.0");
		expect(pkg.dependencies["@dnd-kit/sortable"]).toBeUndefined();
	});

	it.each([
		"@cloudflare/kumo",
		"@lingui/core",
		"@lingui/react",
		"@tanstack/react-query",
		"@dnd-kit/core",
		"@dnd-kit/utilities",
		"react",
		"react-dom",
	])("resolves %s to the admin's own copy (Fact V2)", (name) => {
		const ours = realpathSync(join(PACKAGE_DIR, "node_modules", name));
		// The admin's dependencies sit beside it in its pnpm store node_modules.
		const admins = realpathSync(join(ADMIN_DIR, "../..", name));
		expect(ours).toBe(admins);
	});
});
