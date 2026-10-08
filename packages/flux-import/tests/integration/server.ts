import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev");
export const ENV_DTS = join(SITE_DIR, "emdash-env.d.ts");

/** Small enough that the size-limit test uploads only a little more than 1 MB. */
export const TEST_MAX_SOURCE_BYTES = 1_000_000;

export interface AstroProcess {
	baseUrl: string;
	child: ChildProcess;
	log: string[];
}

export interface DevServer extends AstroProcess {
	dir: string;
	dbPath: string;
	uploadsDir: string;
}

/**
 * The environment Vitest runs in (`NODE_ENV=test`, `VITEST*`) leaves `astro dev` answering every
 * request with 404, so the child gets the parent environment without them.
 */
function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "NODE_ENV" || key === "TEST" || key.startsWith("VITEST")) continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

async function waitForHealth(server: AstroProcess, timeoutMs: number): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (server.child.exitCode !== null) {
			throw new Error(`astro dev exited with ${server.child.exitCode}:\n${server.log.join("")}`);
		}
		try {
			const res = await fetch(`${server.baseUrl}/_emdash/api/health`);
			if (res.ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`astro dev did not answer /_emdash/api/health (if it answers 404, delete the site's node_modules/.vite and retry):\n${server.log.join("")}`,
	);
}

/**
 * Starts `astro dev` for a site and waits until EmDash answers. `--ignore-lock` keeps it in the
 * foreground: Astro 7 moves `astro dev` to the background when it detects an AI agent, and
 * refuses a second server for the same project without the flag
 * (astro dist/cli/dev/index.js:85-90). `detached` gives it its own process group, so stopping it
 * also stops the processes it spawned.
 */
export async function startAstroDev(
	siteDir: string,
	port: number,
	env: Record<string, string> = {},
): Promise<AstroProcess> {
	const child = spawn(
		process.execPath,
		[
			join(siteDir, "node_modules/astro/bin/astro.mjs"),
			"dev",
			"--ignore-lock",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
		],
		{ cwd: siteDir, env: serverEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: true },
	);
	const log: string[] = [];
	child.stdout?.on("data", (d) => log.push(String(d)));
	child.stderr?.on("data", (d) => log.push(String(d)));
	const server = { baseUrl: `http://127.0.0.1:${port}`, child, log };
	try {
		await waitForHealth(server, 180_000);
	} catch (e) {
		await stopServer(server);
		throw e;
	}
	return server;
}

/** Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted). */
export async function startServer(port: number, dir?: string): Promise<DevServer> {
	const root = dir ?? (await mkdtemp(join(tmpdir(), "flux-import-it-")));
	const dbPath = join(root, "test.db");
	const uploadsDir = join(root, "uploads");
	const server = await startAstroDev(SITE_DIR, port, {
		FLUX_DEV_DB: dbPath,
		FLUX_DEV_UPLOADS: uploadsDir,
		FLUX_DEV_MAX_SOURCE_BYTES: String(TEST_MAX_SOURCE_BYTES),
	});
	return { ...server, dir: root, dbPath, uploadsDir };
}

/** Stops the server and the processes it spawned; `SIGKILL` simulates a crash. */
export async function stopServer(
	server: AstroProcess,
	signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	const exited = new Promise((r) => server.child.once("exit", r));
	process.kill(-(server.child.pid as number), signal);
	await exited;
}
