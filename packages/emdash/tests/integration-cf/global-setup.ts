import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { devBypass } from "../integration/client.js";
import { startAstroDev, stopServer, TEST_ENCRYPTION_KEY } from "../integration/server.js";

export const CF_SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev-cf");
const PORT = 4396;
/** EmDash reads EMDASH_ENCRYPTION_KEY from the Worker's vars on workerd (Fact D7). */
const DEV_VARS = join(CF_SITE_DIR, ".dev.vars");
/**
 * Where a developer's own `.dev.vars` waits during a run. It is renamed, so its bytes, its mode and
 * a symlink survive as they are, and it stays on disk, so a run killed before its teardown (vitest
 * skips global teardown on SIGINT) loses nothing. `.wrangler` is git-ignored, and setup deletes
 * only `.wrangler/state`.
 */
const DEV_VARS_BACKUP = join(CF_SITE_DIR, ".wrangler", "fluximporter-dev-vars.backup");
/** The first line of the file this harness writes; such a file is never backed up. */
const DEV_VARS_MARKER = "# fluximporter parity harness (generated; safe to delete)";

declare module "vitest" {
	export interface ProvidedContext {
		cfBaseUrl: string;
		cfToken: string;
	}
}

const present = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
/** The harness's own file, read as the site reads it (through a symlink). */
const marked = async (path: string) =>
	(await readFile(path, "utf8").catch(() => "")).split("\n", 1)[0] === DEV_VARS_MARKER;

/**
 * Puts a developer's backed-up file back, or else deletes the harness's own file. Refuses when a
 * backup and another unmarked file both exist, rather than choose one.
 */
async function restoreDevVars(): Promise<void> {
	if (await present(DEV_VARS_BACKUP)) {
		if ((await present(DEV_VARS)) && !(await marked(DEV_VARS))) {
			throw new Error(
				`Both ${DEV_VARS} and an earlier run's backup ${DEV_VARS_BACKUP} exist: keep one and delete the other`,
			);
		}
		// Replaces the harness's file, if any, in one step.
		await rename(DEV_VARS_BACKUP, DEV_VARS);
	} else if (await marked(DEV_VARS)) {
		await rm(DEV_VARS, { force: true });
	}
}

/**
 * Plan Ruling 13 (pre-flight F5): writes `.dev.vars` with this run's key, never printed, under
 * 0600. A developer's own file is renamed to the backup first.
 */
async function writeDevVars(): Promise<void> {
	// A backup here means an earlier run was killed before its teardown: put it back first.
	await restoreDevVars();
	if (await present(DEV_VARS)) {
		await mkdir(dirname(DEV_VARS_BACKUP), { recursive: true });
		await rename(DEV_VARS, DEV_VARS_BACKUP);
	}
	const text = `${DEV_VARS_MARKER}\nEMDASH_ENCRYPTION_KEY=${TEST_ENCRYPTION_KEY}\n`;
	try {
		// A new file ("wx"), so it is created under 0600.
		await writeFile(DEV_VARS, text, { mode: 0o600, flag: "wx" });
	} catch (e) {
		await restoreDevVars();
		throw e;
	}
}

/** Starts `sites/dev-cf` under workerd with fresh local D1 and R2 state (kept in .wrangler/state). */
export default async function setup(project: TestProject) {
	await rm(join(CF_SITE_DIR, ".wrangler", "state"), { recursive: true, force: true });
	await writeDevVars();
	let server: Awaited<ReturnType<typeof startAstroDev>>;
	try {
		server = await startAstroDev(CF_SITE_DIR, PORT);
	} catch (e) {
		await restoreDevVars();
		throw e;
	}
	try {
		project.provide("cfBaseUrl", server.baseUrl);
		project.provide("cfToken", await devBypass(server.baseUrl));
	} catch (e) {
		try {
			await stopServer(server);
		} finally {
			await restoreDevVars();
		}
		throw e;
	}
	return async () => {
		try {
			await stopServer(server);
		} finally {
			await restoreDevVars();
		}
	};
}
