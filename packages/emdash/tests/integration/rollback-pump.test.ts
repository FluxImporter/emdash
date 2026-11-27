import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { stopCronTimer, tick } from "./schedules-client.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
const COLL = "it_rb_pump";
const BROWSER = "it_rb_browser";

let server: DevServer;
let client: Client;

beforeAll(async () => {
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts(COLL);
	await client.createProducts(BROWSER);
	// Every pump tick from here is the test's (M6b plan Ruling 18).
	await stopCronTimer(server.baseUrl);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

async function importRows(count: number, collection = COLL): Promise<Job> {
	const { uploadId } = await client.upload(productsCsv(count));
	const created = await client.plugin<Job>("jobs/create", {
		uploadId,
		template: template(collection),
		dryRun: false,
		batchSize: 10,
	});
	return client.runToEnd(created.id);
}

const getJob = (id: string) => client.plugin<Job>("jobs/get", { id });

describe("a rollback keeps running once its dialog closes", { timeout: 600_000 }, () => {
	it("finishes, through the pump alone, a rollback the client started and left after one batch", async () => {
		const original = await importRows(30);
		expect(original.counters).toMatchObject({ created: 30, failed: 0 });
		const rollback = await client.plugin<Job>("jobs/rollback", { id: original.id, batchSize: 5 });
		expect(rollback).toMatchObject({ kind: "rollback", status: "created", scheduled: "open" });
		// The dialog's one batch, then it closes: nobody calls jobs/next again.
		const left = await client.plugin<Job>("jobs/next", { id: rollback.id });
		expect(left).toMatchObject({ status: "running", counters: { reverted: 5 } });
		expect(await client.listAll(COLL)).toHaveLength(25);

		// Only cron ticks move it now: each runs one pump batch of the rollback's own batch size.
		let job = await getJob(rollback.id);
		let ticks = 0;
		while (job.scheduled === "open" && ticks < 20) {
			await tick(server, ["pump"]);
			ticks++;
			job = await getJob(rollback.id);
		}
		expect(job).toMatchObject({
			status: "completed",
			scheduled: "closed",
			lease: null,
			counters: { reverted: 30, failed: 0, conflict: 0, locked: 0 },
		});
		// Five batches of 5 rows, one that finds the journal's end, one that closes the job.
		expect(ticks).toBe(7);
		expect(await client.listAll(COLL)).toEqual([]);
		expect(await client.records(rollback.id, "writing")).toEqual([]);
		// The import is rolled back for good: it can be imported again from scratch.
		const again = await importRows(30);
		expect(again.counters).toMatchObject({ created: 30, failed: 0 });
	});

	it("still finishes from the browser alone when no tick runs, as on a site whose cron never runs", async () => {
		const original = await importRows(12, BROWSER);
		const rollback = await client.plugin<Job>("jobs/rollback", { id: original.id, batchSize: 5 });
		expect(rollback.scheduled).toBe("open");
		// "Continue the rollback" from its row: the browser drives it to the end by jobs/next.
		const done = await client.runToEnd(rollback.id);
		expect(done).toMatchObject({ status: "completed", counters: { reverted: 12 } });
		expect(await client.listAll(BROWSER)).toEqual([]);
		// The next tick that does run only closes it.
		await tick(server, ["pump"]);
		expect(await getJob(rollback.id)).toMatchObject({ status: "completed", scheduled: "closed" });
	});
});
