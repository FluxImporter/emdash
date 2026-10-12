import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { devBypass } from "../integration/client.js";
import { startAstroDev, stopServer } from "../integration/server.js";

export const CF_SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev-cf");
const PORT = 4396;

declare module "vitest" {
	export interface ProvidedContext {
		cfBaseUrl: string;
		cfToken: string;
	}
}

/** Starts `sites/dev-cf` under workerd with fresh local D1 and R2 state (kept in .wrangler/state). */
export default async function setup(project: TestProject) {
	await rm(join(CF_SITE_DIR, ".wrangler", "state"), { recursive: true, force: true });
	const server = await startAstroDev(CF_SITE_DIR, PORT);
	try {
		project.provide("cfBaseUrl", server.baseUrl);
		project.provide("cfToken", await devBypass(server.baseUrl));
	} catch (e) {
		await stopServer(server);
		throw e;
	}
	return async () => {
		await stopServer(server);
	};
}
