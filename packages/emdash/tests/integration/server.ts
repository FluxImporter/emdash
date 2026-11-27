import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `sites/dev`, or `FLUX_TEST_SITE` (a copy of it with the packed tarball installed, to run the
 * suite against the package as npm ships it).
 */
export const SITE_DIR = process.env.FLUX_TEST_SITE
	? resolve(process.env.FLUX_TEST_SITE)
	: resolve(import.meta.dirname, "../../../../sites/dev");
export const ENV_DTS = join(SITE_DIR, "emdash-env.d.ts");

/** Small enough that the size-limit test uploads only a little more than 1 MB. */
export const TEST_MAX_SOURCE_BYTES = 1_000_000;

/**
 * A throwaway `EMDASH_ENCRYPTION_KEY` for this test process, so credentials (a `secret` plugin
 * setting) can be stored without the site's own `.env`. Set in the environment, it wins over
 * `.env` (`emdash` src/astro/integration/dev-env.ts never overwrites a set variable).
 */
export const TEST_ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;

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
		if (server.log.some((line) => /\bin use\b/.test(line))) {
			throw new Error(`Port in use for ${server.baseUrl}:\n${server.log.join("")}`);
		}
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

/** Ports other tools on this machine hold; `freePort` never returns one. */
export const AVOID_PORTS = new Set([4392, 4396, 4397, 5432]);

/** A port the system reports free, other than `AVOID_PORTS`. */
export async function freePort(): Promise<number> {
	for (;;) {
		const port = await new Promise<number>((done, fail) => {
			const probe = createServer();
			probe.once("error", fail);
			probe.listen(0, "127.0.0.1", () => {
				const address = probe.address();
				probe.close(() => done(typeof address === "object" && address ? address.port : 0));
			});
		});
		if (port > 0 && !AVOID_PORTS.has(port)) return port;
	}
}

/** The port in the environment variable `name`, else a free one. */
export async function portFromEnv(name: string): Promise<number> {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return freePort();
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`);
	}
	return port;
}

async function assertPortFree(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", () =>
			reject(
				new Error(
					`Port ${port} is in use; stop the process using it before running the integration tests`,
				),
			),
		);
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
	});
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
	await assertPortFree(port);
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
		{
			cwd: siteDir,
			env: serverEnv({ ...env, FLUX_DEV_STRICT_PORT: "1" }),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		},
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

/**
 * Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted), with
 * an upload limit of `maxSourceBytes`. `allowPrivateNetwork` lets URL sources and media reach
 * this machine; `maxUploadSize` sets EmDash's media upload limit; `env` adds to the site's
 * environment (such as `FLUX_DEV_I18N`).
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
	allowPrivateNetwork = false,
	maxUploadSize?: number,
	env: Record<string, string> = {},
): Promise<DevServer> {
	const root = dir ?? (await mkdtemp(join(tmpdir(), "fluximporter-it-")));
	const dbPath = join(root, "test.db");
	const uploadsDir = join(root, "uploads");
	let server: AstroProcess;
	try {
		server = await startAstroDev(SITE_DIR, port, {
			FLUX_DEV_DB: dbPath,
			FLUX_DEV_UPLOADS: uploadsDir,
			FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),
			FLUX_DEV_ALLOW_PRIVATE_NETWORK: allowPrivateNetwork ? "1" : "0",
			...(maxUploadSize === undefined ? {} : { FLUX_DEV_MAX_UPLOAD_SIZE: String(maxUploadSize) }),
			EMDASH_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			...env,
		});
	} catch (e) {
		if (!dir) await rm(root, { recursive: true, force: true });
		throw e;
	}
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
