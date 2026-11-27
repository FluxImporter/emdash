import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A production build of `sites/dev-cf`, run under `wrangler dev`: the M2 blocker. With EmDash
 * 1.2.0, Astro 7 and `@astrojs/cloudflare` 14, the build split kysely into chunks that import
 * each other and the Worker failed at load ("Class extends value undefined"); `fluxImporterRoutes()`
 * now keeps kysely in one chunk.
 */

const SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev-cf");
const DIST = join(SITE_DIR, "dist");
/** Ports other tools on this machine hold, or the other suites use. */
const AVOID = new Set([4392, 4396, 4397, 5432]);

/** The parent environment without Vitest's markers, which make Astro behave as under test. */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "NODE_ENV" || key === "TEST" || key.startsWith("VITEST")) continue;
		env[key] = value;
	}
	return env;
}

async function freePort(): Promise<number> {
	for (;;) {
		const port = await new Promise<number>((done, fail) => {
			const probe = createServer();
			probe.once("error", fail);
			probe.listen(0, "127.0.0.1", () => {
				const address = probe.address();
				probe.close(() => done(typeof address === "object" && address ? address.port : 0));
			});
		});
		if (port > 0 && !AVOID.has(port)) return port;
	}
}

function run(command: string, args: string[], log: string[]): ChildProcess {
	const child = spawn(command, args, {
		cwd: SITE_DIR,
		env: childEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		// Its own process group, so stopping it also stops workerd.
		detached: true,
	});
	child.stdout?.on("data", (d) => log.push(String(d)));
	child.stderr?.on("data", (d) => log.push(String(d)));
	return child;
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((r) => child.once("exit", r));
	process.kill(-(child.pid as number), "SIGTERM");
	await exited;
}

/** The chunk files that hold kysely's own modules, by the source regions Rolldown writes. */
async function kyselyChunks(): Promise<string[]> {
	const dir = join(DIST, "server/chunks");
	const found: string[] = [];
	for (const name of await readdir(dir)) {
		if (!name.endsWith(".mjs")) continue;
		const code = await readFile(join(dir, name), "utf8");
		if (/\/\/#region \S*node_modules\/kysely\//.test(code)) found.push(name);
	}
	return found;
}

let worker: ChildProcess | undefined;
let persist = "";
let baseUrl = "";
const log: string[] = [];

beforeAll(async () => {
	const buildLog: string[] = [];
	const build = run(
		process.execPath,
		[join(SITE_DIR, "node_modules/astro/bin/astro.mjs"), "build"],
		buildLog,
	);
	const code = await new Promise<number | null>((r) => build.once("exit", r));
	if (code !== 0) throw new Error(`astro build failed (${code}):\n${buildLog.join("")}`);

	const port = await freePort();
	persist = await mkdtemp(join(tmpdir(), "fluximporter-cf-build-"));
	baseUrl = `http://127.0.0.1:${port}`;
	worker = run(
		process.execPath,
		[
			join(SITE_DIR, "node_modules/wrangler/bin/wrangler.js"),
			"dev",
			"-c",
			"dist/server/wrangler.json",
			"--port",
			String(port),
			"--ip",
			"127.0.0.1",
			"--persist-to",
			persist,
			"--test-scheduled",
		],
		log,
	);
	const until = Date.now() + 240_000;
	while (!log.join("").includes("Ready on")) {
		if (worker.exitCode !== null) throw new Error(`wrangler dev exited:\n${log.join("")}`);
		if (Date.now() > until) throw new Error(`wrangler dev did not start:\n${log.join("")}`);
		await new Promise((r) => setTimeout(r, 500));
	}
});

afterAll(async () => {
	if (worker) await stop(worker);
	if (persist) await rm(persist, { recursive: true, force: true });
});

describe("the production Cloudflare build of sites/dev-cf", () => {
	it("keeps kysely in one chunk", async () => {
		expect(await kyselyChunks()).toHaveLength(1);
	});

	it("answers EmDash's health check and the home page", async () => {
		expect((await fetch(`${baseUrl}/_emdash/api/health`)).status).toBe(200);
		expect((await fetch(`${baseUrl}/`)).status).toBe(200);
		expect(log.join("")).not.toContain("Class extends value undefined");
	});

	it("loads the plugin: its routes refuse an anonymous caller instead of failing", async () => {
		const res = await fetch(`${baseUrl}/_emdash/api/plugins/fluximporter/jobs/summaries`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: "{}",
		});
		expect([401, 403]).toContain(res.status);
		const upload = await fetch(`${baseUrl}/_emdash/api/fluximporter/uploads?filename=a.csv`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1", "Content-Type": "text/csv" },
			body: "a\n1\n",
		});
		expect([401, 403]).toContain(upload.status);
	});

	it("runs the scheduled handler", async () => {
		const res = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
		expect(res.status).toBe(200);
		// The handler logs and swallows a failure, so the log is the evidence.
		await new Promise((r) => setTimeout(r, 1000));
		expect(log.join("")).not.toContain("runScheduledTasks failed");
	});
});
