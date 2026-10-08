import { readFile, rm, writeFile } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { devBypass } from "./client.js";
import { ENV_DTS, startServer, stopServer } from "./server.js";

declare module "vitest" {
	export interface ProvidedContext {
		baseUrl: string;
		token: string;
		dbPath: string;
	}
}

export const SHARED_PORT = 4399;

/**
 * One dev server for the suites that can share it. Schema changes make the dev server rewrite
 * `sites/dev/emdash-env.d.ts`, so the tracked file is restored on teardown.
 */
export default async function setup(project: TestProject) {
	const envDts = await readFile(ENV_DTS, "utf8");
	const server = await startServer(SHARED_PORT);
	try {
		project.provide("baseUrl", server.baseUrl);
		project.provide("token", await devBypass(server.baseUrl));
		project.provide("dbPath", server.dbPath);
	} catch (e) {
		await stopServer(server);
		throw e;
	}
	return async () => {
		await stopServer(server);
		await rm(server.dir, { recursive: true, force: true });
		await writeFile(ENV_DTS, envDts);
	};
}
