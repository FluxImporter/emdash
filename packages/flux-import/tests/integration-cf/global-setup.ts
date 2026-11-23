import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { devBypass } from "../integration/client.js";
import { startAstroDev, stopServer, TEST_ENCRYPTION_KEY } from "../integration/server.js";

export const CF_SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev-cf");
const PORT = 4396;
/** EmDash reads EMDASH_ENCRYPTION_KEY from the Worker's vars on workerd (Fact D7). */
const DEV_VARS = join(CF_SITE_DIR, ".dev.vars");
/** The first line of the file this harness writes; such a file is never kept as a backup. */
const DEV_VARS_MARKER = "# flux-import parity harness (generated; safe to delete)";

declare module "vitest" {
	export interface ProvidedContext {
		cfBaseUrl: string;
		cfToken: string;
	}
}

/**
 * Plan Ruling 13 (pre-flight F5): writes `.dev.vars` with this run's key and returns its undo. A
 * developer's own file is restored with its mode; a marked file left by a killed run is deleted.
 * The key is never printed.
 */
async function writeDevVars(): Promise<() => Promise<void>> {
	const text = await readFile(DEV_VARS, "utf8").catch(() => null);
	const previous =
		text === null || text.split("\n", 1)[0] === DEV_VARS_MARKER
			? null
			: { text, mode: (await stat(DEV_VARS)).mode & 0o7777 };
	// A new file, so the key is written under 0600 whatever mode the old one had.
	await rm(DEV_VARS, { force: true });
	await writeFile(DEV_VARS, `${DEV_VARS_MARKER}\nEMDASH_ENCRYPTION_KEY=${TEST_ENCRYPTION_KEY}\n`, {
		mode: 0o600,
	});
	return async () => {
		if (previous === null) return rm(DEV_VARS, { force: true });
		await writeFile(DEV_VARS, previous.text);
		// writeFile's mode applies only to a new file; this one exists.
		await chmod(DEV_VARS, previous.mode);
	};
}

/** Starts `sites/dev-cf` under workerd with fresh local D1 and R2 state (kept in .wrangler/state). */
export default async function setup(project: TestProject) {
	await rm(join(CF_SITE_DIR, ".wrangler", "state"), { recursive: true, force: true });
	const restore = await writeDevVars();
	let server: Awaited<ReturnType<typeof startAstroDev>>;
	try {
		server = await startAstroDev(CF_SITE_DIR, PORT);
	} catch (e) {
		await restore();
		throw e;
	}
	try {
		project.provide("cfBaseUrl", server.baseUrl);
		project.provide("cfToken", await devBypass(server.baseUrl));
	} catch (e) {
		await stopServer(server);
		await restore();
		throw e;
	}
	return async () => {
		try {
			await stopServer(server);
		} finally {
			await restore();
		}
	};
}
