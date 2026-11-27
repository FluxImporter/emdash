import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { ApiError, Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

// Unused by the other suites, which run one at a time.
const PORT = 4390;
const COLLECTION = "it_rooms";

let server: DevServer;
let client: Client;
/** The admin's session cookie: joining a room needs a signed-in session, not a token. */
let cookie: string;

beforeAll(async () => {
	// Its own server: co-editing is a build option of the site.
	server = await startServer(PORT, undefined, undefined, false, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	const res = await fetch(`${server.baseUrl}/_emdash/api/setup/dev-bypass?content=0`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	if (!res.ok || cookie === "") throw new Error(`dev-bypass answered ${res.status}`);
	await client.createProducts(COLLECTION);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

/** The admin's own requests, with its session. */
async function asEditor<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${server.baseUrl}${path}`, {
		method,
		headers: {
			Cookie: cookie,
			"X-EmDash-Request": "1",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json = (await res.json()) as
		| { success: true; data: T }
		| { success: false; error: { code: string; message: string } };
	if (!json.success) throw new ApiError(res.status, json.error.code, json.error.message);
	return json.data;
}

/** Joins the entry's room as the admin's editor does: the client fingerprint is the manifest's. */
async function joinRoom(id: string, extra: Record<string, unknown> = {}) {
	const manifest = await asEditor<{ version: string; commit?: string; hash: string }>(
		"GET",
		"/_emdash/api/manifest",
	);
	return asEditor<{ mode: string }>("POST", `/_emdash/api/content/${COLLECTION}/${id}/room`, {
		fingerprint: { version: manifest.version, commit: manifest.commit ?? "", hash: manifest.hash },
		...extra,
	});
}

async function importCsv(csv: string): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: template(COLLECTION),
		dryRun: false,
		batchSize: 50,
	});
	return client.runToEnd(job.id);
}

const byKey = async () =>
	new Map((await client.listAll(COLLECTION)).map((e) => [e.data.flux_source_id as string, e]));

describe("co-editing rooms (EmDash 1.5)", () => {
	it("skips an entry with an open room as locked, and imports it once the room closes", async () => {
		await importCsv(productsCsv(2));
		const entry = (await byKey()).get("SKU-0")!;
		expect(await joinRoom(entry.id)).toMatchObject({ mode: "room" });
		// A room takes no edit lock: only the lock route's `room` field shows it.
		const lock = await asEditor<{ room: boolean }>(
			"GET",
			`/_emdash/api/content/${COLLECTION}/${entry.id}/lock`,
		);
		expect(lock.room).toBe(true);

		const blocked = await importCsv(productsCsv(2, () => "4"));
		expect(blocked.counters).toMatchObject({ locked: 1, updated: 1 });
		const [row] = await client.records(blocked.id, "locked");
		expect(row).toMatchObject({ entryId: entry.id, errors: [{ code: "locked" }] });
		expect((await byKey()).get("SKU-0")?.data.price).toBe(0.5);

		// Single-editor mode forgets the editor's unused join token, which closes the room.
		expect(await joinRoom(entry.id, { singleEditor: true })).toMatchObject({
			mode: "single-editor",
		});
		await client.plugin("jobs/retry", { id: blocked.id });
		const retried = await client.runToEnd(blocked.id);
		expect(retried.counters).toMatchObject({ locked: 0, updated: 2 });
		expect((await byKey()).get("SKU-0")?.data.price).toBe(4);
	});
});
