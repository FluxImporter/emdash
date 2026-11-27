import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** packages/emdash, from tests/unit. */
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPO_DIR = join(PACKAGE_DIR, "../..");
/** fluximporter and the sites that host it; a site serves the admin its own emdash resolves. */
const SITES = ["packages/emdash", "sites/dev", "sites/dev-cf"];
/** The host libraries the admin and fluximporter's admin code must share (Fact V2). */
const SHARED = [
	"@cloudflare/kumo",
	"@lingui/core",
	"@lingui/react",
	"@tanstack/react-query",
	"@dnd-kit/core",
	"react",
	"react-dom",
];

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
	it("declares the admin export, the host peers and the admin's @dnd-kit/core range", () => {
		expect(pkg.exports["./admin"]).toBe("./src/admin/index.tsx");
		expect(pkg.peerDependencies).toMatchObject({
			"@cloudflare/kumo": "2.19.0",
			"@emdash-cms/admin": "*",
			"@lingui/core": "*",
			"@lingui/react": "*",
			"@tanstack/react-query": "*",
			react: "^18.0.0 || ^19.0.0",
		});
		expect(pkg.dependencies["@dnd-kit/core"]).toBe(adminPkg.dependencies["@dnd-kit/core"]);
		expect(pkg.dependencies["@dnd-kit/core"]).toBe("^6.3.1");
		// Nothing imports it (final review 8).
		expect(pkg.dependencies["@dnd-kit/utilities"]).toBeUndefined();
		expect(pkg.devDependencies["@cloudflare/kumo"]).toBe(adminPkg.dependencies["@cloudflare/kumo"]);
		expect(pkg.devDependencies["@cloudflare/kumo"]).toBe("2.19.0");
		expect(pkg.dependencies["@dnd-kit/sortable"]).toBeUndefined();
	});

	it.each(SITES.flatMap((site) => SHARED.map((name) => [site, name] as const)))(
		"resolves %s's admin's %s to fluximporter's own copy (Fact V2)",
		(site, name) => {
			// The admin a site serves is its emdash's; fluximporter's admin source imports its own
			// node_modules, so both must be one real path or a build bundles two copies.
			const emdash = realpathSync(join(REPO_DIR, site, "node_modules/emdash"));
			const siteAdmin = realpathSync(join(emdash, "../@emdash-cms/admin"));
			expect(siteAdmin).toBe(ADMIN_DIR);
			expect(realpathSync(join(siteAdmin, "../..", name))).toBe(
				realpathSync(join(PACKAGE_DIR, "node_modules", name)),
			);
		},
	);

	it("locks one emdash, one admin and one Kumo for the whole workspace", () => {
		const lock = readFileSync(join(REPO_DIR, "pnpm-lock.yaml"), "utf8");
		const snapshots = lock.slice(lock.indexOf("\nsnapshots:\n"));
		const count = (name: string) =>
			snapshots.split("\n").filter((line) => line.startsWith(`  ${name}@`)).length;
		expect(count("emdash")).toBe(1);
		expect(count("'@emdash-cms/admin")).toBe(1);
		expect(count("'@cloudflare/kumo")).toBe(1);
	});
});
