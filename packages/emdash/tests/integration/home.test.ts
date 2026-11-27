import { readdir, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import type { ClearDryRunsReply, JobListItem } from "../../src/plugin/summaries.js";
import { Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { productsCsv, template } from "./fixtures.js";
import { runScheduled } from "./schedules-client.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4389;
const HOUR_MS = 60 * 60 * 1000;
const COLLECTION = "it_home";
const INDEX = "idx_plugin_fluximporter_jobs_dryRun_createdAt";

let server: DevServer;
let client: Client;

interface Page<T> {
	items: T[];
	cursor?: string;
	hasMore: boolean;
}

beforeAll(async () => {
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts(COLLECTION);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

const summaries = (input: { dryRun?: boolean; cursor?: string } = {}) =>
	client.plugin<Page<JobListItem>>("jobs/summaries", input);

async function createJob(csv: string, dryRun: boolean, extra: object = {}): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	return client.plugin("jobs/create", {
		uploadId,
		template: template(COLLECTION),
		dryRun,
		...extra,
	});
}

const stagedFiles = async () =>
	(await readdir(server.uploadsDir).catch(() => [] as string[])).filter((f) =>
		f.startsWith(UPLOAD_PREFIX),
	);

/** The staged file's upload ID, as the file name carries it (`uploads.ts` keys). */
const hasFile = async (job: Job) => (await stagedFiles()).some((f) => f.includes(job.uploadId));

/** Rewrites `updatedAt` of a job row, as an idle dry run would have. */
function ageJob(id: string, ms: number) {
	withDb(server.dbPath, (db) =>
		db
			.prepare(
				"UPDATE _plugin_storage SET data = json_set(data, '$.updatedAt', ?) WHERE plugin_id = 'fluximporter' AND collection = 'jobs' AND id = ?",
			)
			.run(new Date(Date.now() - ms).toISOString(), id),
	);
}

const jobRow = (id: string) =>
	withDb(
		server.dbPath,
		(db) =>
			db
				.prepare(
					"SELECT id FROM _plugin_storage WHERE plugin_id = 'fluximporter' AND collection = 'jobs' AND id = ?",
				)
				.get(id) as { id: string } | undefined,
	);

async function clearAll(): Promise<number> {
	let cleared = 0;
	let cursor: string | undefined;
	for (let i = 0; i < 50; i++) {
		const reply = await client.plugin<ClearDryRunsReply>(
			"jobs/clear-dry-runs",
			cursor ? { cursor } : {},
		);
		cleared += reply.cleared;
		if (!reply.more) return cleared;
		cursor = reply.cursor;
	}
	throw new Error("jobs/clear-dry-runs never finished");
}

describe("M7b server additions on sites/dev", () => {
	it("lists real imports without dry runs through jobs/summaries, newest first, by cursor", async () => {
		const real: Job[] = [];
		for (let i = 0; i < 9; i++) real.push(await createJob(productsCsv(1), false));
		const dry: Job[] = [];
		for (let i = 0; i < 3; i++) dry.push(await createJob(productsCsv(1), true));

		const first = await summaries();
		expect(first.items).toHaveLength(8);
		expect(first.hasMore).toBe(true);
		expect(first.items.every((j) => !j.dryRun)).toBe(true);
		const newestFirst = [...real].reverse().map((j) => j.id);
		expect(first.items.map((j) => j.id)).toEqual(newestFirst.slice(0, 8));
		expect(first.items[0]).toMatchObject({ kind: "import", collection: COLLECTION });
		expect(first.items[0]).not.toHaveProperty("leased");

		const second = await summaries({ cursor: first.cursor as string });
		expect(second.items.map((j) => j.id)).toEqual(newestFirst.slice(8));
		expect(second.hasMore).toBe(false);

		const dryPage = await summaries({ dryRun: true });
		expect(dryPage.items.map((j) => j.id)).toEqual([...dry].reverse().map((j) => j.id));
		expect(dryPage.items.every((j) => j.dryRun)).toBe(true);
	});

	it("clears finished dry runs with their staged files and keeps a running one", async () => {
		// Start from a site with no dry runs, so the counts below are the test's own.
		await client.plugin("jobs/clear-dry-runs", {});
		for (const item of (await summaries({ dryRun: true })).items) ageJob(item.id, 2 * HOUR_MS);
		await clearAll();

		const aged = [await createJob(productsCsv(3), true), await createJob(productsCsv(3), true)];
		for (const job of aged) await client.runToEnd(job.id);
		const fresh = await createJob(productsCsv(3), true);
		await client.runToEnd(fresh.id);
		const running = await createJob(productsCsv(3), true, { batchSize: 1 });
		expect((await client.plugin<Job>("jobs/next", { id: running.id })).status).toBe("running");
		const real = await createJob(productsCsv(3), false);

		for (const job of [...aged, fresh, running]) expect(await hasFile(job)).toBe(true);
		for (const job of aged) ageJob(job.id, 2 * HOUR_MS);

		expect(await clearAll()).toBe(3);

		for (const job of aged) {
			expect(jobRow(job.id)).toBeUndefined();
			expect(await hasFile(job)).toBe(false);
		}
		// A fresh finished dry run's row goes at once; its file stays for an open Preview.
		expect(jobRow(fresh.id)).toBeUndefined();
		expect(await hasFile(fresh)).toBe(true);
		// A running dry run and a real import are not touched.
		expect(jobRow(running.id)).toBeDefined();
		expect(await hasFile(running)).toBe(true);
		expect(jobRow(real.id)).toBeDefined();
		expect((await summaries({ dryRun: true })).items.map((j) => j.id)).toEqual([running.id]);
		await expect(client.plugin("jobs/get", { id: aged[0]?.id })).rejects.toMatchObject({
			status: 404,
		});
	});

	it("answers schedules/fence clear, then export while an export row runs", async () => {
		expect(await client.plugin("schedules/fence", {})).toEqual({ fence: "clear" });
		// Never an import row: EmDash refuses every plugin POST during an import (F3).
		withDb(server.dbPath, (db) =>
			db
				.prepare(
					"INSERT INTO _emdash_transfer_operations (id, kind, state, staging_secret, created_by) VALUES (?, 'export', 'running', ?, ?)",
				)
				.run("m7b-fence", "probe-secret", "admin"),
		);
		try {
			expect(await client.plugin("schedules/fence", {})).toEqual({ fence: "export" });
		} finally {
			withDb(server.dbPath, (db) =>
				db.prepare("DELETE FROM _emdash_transfer_operations WHERE id = ?").run("m7b-fence"),
			);
		}
		expect(await client.plugin("schedules/fence", {})).toEqual({ fence: "clear" });
	});

	it("splits a rollback's counts on a real site: dry and real alike", async () => {
		const first = await createJob(productsCsv(1), false);
		await client.runToEnd(first.id);
		// One record changed, two new: 2 created, 1 updated.
		const second = await createJob(
			productsCsv(3, (i) => (i === 0 ? "99" : `${i}.5`)),
			false,
		);
		const done = await client.runToEnd(second.id);
		expect(done.counters).toMatchObject({ created: 2, updated: 1, failed: 0 });

		for (const dryRun of [true, false]) {
			const rollback = await client.plugin<Job>("jobs/rollback", { id: second.id, dryRun });
			expect(rollback.undo).toEqual({ deleted: 0, restored: 0, recovered: 0 });
			const ended = await client.runToEnd(rollback.id);
			expect(ended).toMatchObject({
				status: "completed",
				dryRun,
				counters: { reverted: 3, conflict: 0, failed: 0 },
				undo: { deleted: 2, restored: 1, recovered: 0 },
			});
			const listed = await summaries({ dryRun });
			expect(listed.items.find((j) => j.id === rollback.id)).toMatchObject({ kind: "rollback" });
		}
	});

	it("builds the dryRun index at the first scheduler tick (Fact V3)", async () => {
		const indexed = () =>
			withDb(
				server.dbPath,
				(db) =>
					db
						.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
						.get(INDEX) !== undefined,
			);
		for (let i = 0; i < 20 && !indexed(); i++) {
			await runScheduled(server.baseUrl);
			await new Promise((r) => setTimeout(r, 500));
		}
		expect(indexed()).toBe(true);
		// With or without the index the query answers the same.
		const page = await summaries({ dryRun: true });
		expect(page.items.every((j) => j.dryRun)).toBe(true);
	});
});
