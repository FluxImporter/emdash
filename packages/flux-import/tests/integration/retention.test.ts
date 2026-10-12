import { readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4397;
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

beforeAll(async () => {
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_retention");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

const stagedFiles = async () =>
	(await readdir(server.uploadsDir).catch(() => [] as string[])).filter((f) =>
		f.startsWith(UPLOAD_PREFIX),
	);

const stagedFile = async (uploadId: string) => {
	const file = (await stagedFiles()).find((f) => f.includes(uploadId));
	if (!file) throw new Error(`No staged file for upload ${uploadId}`);
	return file;
};

const recordCount = (jobId: string) =>
	withDb(server.dbPath, (db) => {
		const row = db
			.prepare(
				"SELECT COUNT(*) AS n FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'records' AND json_extract(data, '$.jobId') = ?",
			)
			.get(jobId) as { n: number };
		return row.n;
	});

const RETENTION_TASK_SQL = "plugin_id = 'flux-import' AND task_name = 'retention'";

describe("retention cleanup", () => {
	it("deletes expired jobs, their records and unreferenced staged files, and keeps links", async () => {
		const csv = productsCsv(3);
		const { uploadId } = await client.upload(csv);
		const expired = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_retention"),
			dryRun: false,
		});
		await client.runToEnd(expired.id);
		expect(recordCount(expired.id)).toBe(3);

		// The completed import deleted its own staged file. A job that has not run yet keeps
		// referencing its file; the other file is never used by a job.
		const { uploadId: referencedId } = await client.upload(csv);
		const surviving = await client.plugin("jobs/create", {
			uploadId: referencedId,
			template: template("it_retention"),
			dryRun: false,
		});
		const { uploadId: orphanId } = await client.upload(csv);
		const referenced = await stagedFile(referencedId);
		const orphan = await stagedFile(orphanId);
		expect((await stagedFiles()).sort()).toEqual([referenced, orphan].sort());

		// Age the finished job and both files past a one-day retention; the new job stays recent.
		const old = new Date(Date.now() - 2 * DAY_MS);
		for (const file of [referenced, orphan]) await utimes(join(server.uploadsDir, file), old, old);
		await client.api("PUT", "/_emdash/api/admin/plugins/flux-import/settings", {
			values: { retentionDays: 1 },
		});
		withDb(server.dbPath, (db) => {
			const aged = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_set(data, '$.createdAt', ?) WHERE plugin_id = 'flux-import' AND collection = 'jobs' AND id = ?",
				)
				.run(old.toISOString(), expired.id);
			expect(aged.changes).toBe(1);
			// plugin:activate scheduled the task on this fresh database; make it due now.
			const task = db
				.prepare(`SELECT schedule FROM _emdash_cron_tasks WHERE ${RETENTION_TASK_SQL}`)
				.get() as { schedule: string } | undefined;
			expect(task?.schedule).toBe("0 3 * * *");
			db.prepare(`UPDATE _emdash_cron_tasks SET next_run_at = ? WHERE ${RETENTION_TASK_SQL}`).run(
				new Date(Date.now() - 60_000).toISOString(),
			);
		});

		// The Node scheduler re-reads due times at least every 60 s (src/plugins/scheduler/node.ts:26).
		let gone = false;
		for (let i = 0; i < 90 && !gone; i++) {
			await sleep(1000);
			gone = await client.plugin("jobs/get", { id: expired.id }).then(
				() => false,
				(e: unknown) => e instanceof ApiError && e.status === 404,
			);
		}
		expect(gone).toBe(true);
		// The real cron ran the task and moved it to its next daily run.
		const nextRun = withDb(server.dbPath, (db) => {
			const row = db
				.prepare(`SELECT next_run_at FROM _emdash_cron_tasks WHERE ${RETENTION_TASK_SQL}`)
				.get() as { next_run_at: string };
			return row.next_run_at;
		});
		expect(new Date(nextRun).getTime()).toBeGreaterThan(Date.now());
		expect(recordCount(expired.id)).toBe(0);
		expect((await client.plugin("jobs/get", { id: surviving.id })).status).toBe("created");
		// A surviving job's file is kept however old it is; the unreferenced old file is deleted.
		expect(await stagedFiles()).toEqual([referenced]);

		// Links survive: the same rows match their entries again instead of creating new ones.
		expect((await client.runToEnd(surviving.id)).counters).toMatchObject({
			unchanged: 3,
			created: 0,
		});
	});
});
