import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { jsonTemplate, productsJson } from "../fixtures/formats.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4398;
const ROWS = 10_000;
/** The 10,000-record JSON fixture is about 1.6 MB, over the shared server's 1 MB limit. */
const MAX_SOURCE_BYTES = 4_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir, MAX_SOURCE_BYTES);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	server = await startServer(PORT, undefined, MAX_SOURCE_BYTES);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_crash");
	await client.createProducts("it_crash_json");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

describe.each([
	["CSV", "it_crash", "products.csv", productsCsv(ROWS), template("it_crash")],
	["JSON", "it_crash_json", "products.json", productsJson(ROWS), jsonTemplate("it_crash_json")],
])("kill and resume (%s)", (_format, collection, filename, body, jobTemplate) => {
	it("leaves no duplicates and reports any entry a crash left unpublished", async () => {
		const sourceBytes = Buffer.byteLength(body);
		const { uploadId } = await client.upload(body, filename);
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: jobTemplate,
			dryRun: false,
			batchSize: 500,
			budgetMs: 2_000,
		});
		let writing = 0;
		let interrupted = 0;
		let killed: Job | undefined;
		for (const delay of [300, 700]) {
			await client.plugin("jobs/next", { id: created.id });
			const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
			await sleep(delay);
			await stopServer(server, "SIGKILL");
			// null: the kill cut the request off before it answered.
			if ((await inFlight) === null) interrupted++;
			await restart();
			writing += (await client.records(created.id, "writing")).length;
			killed = await waitForLease(created.id);
		}
		// Diagnostic only: SIGKILL timing decides whether a write was caught mid-record.
		console.info(`records left writing by the kills: ${writing}`);

		// The kills must have landed mid-batch and mid-job, or this test proves nothing about resuming.
		if (interrupted !== 2) {
			throw new Error(`Only ${interrupted} of 2 kills cut off a jobs/next call in flight`);
		}
		const cursor = (killed as Job).cursor;
		console.info(
			`cursor after the kills: offset ${cursor.offset} of ${sourceBytes} bytes, seq ${cursor.seq} of ${ROWS} rows`,
		);
		if (
			!(cursor.offset > 0 && cursor.offset < sourceBytes && cursor.seq > 0 && cursor.seq < ROWS)
		) {
			throw new Error(
				`The kills did not land mid-job: cursor ${JSON.stringify(cursor)} for ${sourceBytes} bytes and ${ROWS} rows`,
			);
		}
		expect((killed as Job).status).toBe("running");

		const done = await client.runToEnd(created.id);
		expect(done.status).toBe("completed");
		const total = Object.values(done.counters).reduce((a, b) => a + b, 0);
		expect(total).toBe(ROWS);
		expect(done.counters.failed).toBe(0);
		expect(await client.records(created.id, "writing")).toEqual([]);

		const entries = await client.listAll(collection);
		expect(entries).toHaveLength(ROWS);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(ROWS);

		// Relaxed criterion: an entry a crash left unpublished is reported, never silently dropped.
		// Conflicts here can only be crash leftovers, so each one must be publish_unverified, and
		// they must be exactly the entries still waiting to be published.
		const conflicts = await client.records(created.id, "conflict");
		expect(conflicts.every((r) => r.errors?.[0]?.code === "publish_unverified")).toBe(true);
		const unverified = new Set(conflicts.map((r) => r.entryId));
		expect(unverified.size).toBe(conflicts.length);
		expect(done.counters.conflict).toBe(unverified.size);
		const unpublished = new Set(entries.filter((e) => e.status !== "published").map((e) => e.id));
		expect(unpublished).toEqual(unverified);
		console.info(`entries left unpublished and reported publish_unverified: ${unverified.size}`);
	});
});
