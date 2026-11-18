import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedResult } from "../../src/plugin/templates.js";
import { Client, devBypass } from "./client.js";
import { createUserToken, withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { MALFORMED_CSV, productsCsv, template } from "./fixtures.js";
import { type ScheduleView, stopCronTimer, taskNames, tick, waitFor } from "./schedules-client.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4390;
const COLL = "m6b_products";
const OWNED = "m6b_owned";
/** After the acceptance, schedules never come due by the clock; the test marks them (plan Ruling 18). */
const YEARLY = "0 0 1 1 *";

let server: DevServer;
let client: Client;
const feeds = new FeedServer();
/** The first schedule, its source and template, shared by steps 1-3 and 5-8. */
const a = { id: "", sourceId: "", templateId: "" };

beforeAll(async () => {
	await feeds.start();
	// URL sources here fetch from 127.0.0.1, which needs allowPrivateNetwork.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts(COLL);
	await client.createProducts(OWNED);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

async function schedule(id: string, as: Client = client): Promise<ScheduleView> {
	const page = await as.plugin<{ items: ScheduleView[] }>("schedules/list", {});
	const found = page.items.find((s) => s.id === id);
	if (!found) throw new Error(`No schedule ${id}`);
	return found;
}

async function create(input: Record<string, unknown>, as: Client = client): Promise<ScheduleView> {
	const body = { cron: YEARLY, ...input };
	return (await as.plugin<{ schedule: ScheduleView }>("schedules/create", body)).schedule;
}

async function update(id: string, change: Record<string, unknown>): Promise<ScheduleView> {
	const { revision } = await schedule(id);
	const body = { id, revision, ...change };
	return (await client.plugin<{ schedule: ScheduleView }>("schedules/update", body)).schedule;
}

/** One due mark of the schedule, then pump ticks until `done` holds (Fact V9: one tick per call). */
async function run(
	id: string,
	done: (s: ScheduleView) => boolean,
	maxTicks = 40,
): Promise<ScheduleView> {
	await tick(server, taskNames(id));
	for (let i = 0; i < maxTicks; i++) {
		const s = await schedule(id);
		if (done(s)) return s;
		await tick(server, ["pump"]);
	}
	throw new Error(`Schedule ${id} did not settle: ${JSON.stringify(await schedule(id))}`);
}

const ranAgain = (before: ScheduleView) => (s: ScheduleView) =>
	s.runs.length > 0 && s.runs[0]?.jobId !== before.runs[0]?.jobId;
const pausedFor = (reason: string) => (s: ScheduleView) => s.pause?.reason === reason;

async function source(name: string, path: string, body: string): Promise<SourceRow> {
	feeds.feeds.set(path, { body, etag: true });
	return client.plugin<SourceRow>("sources/create", { name, url: `${feeds.baseUrl}${path}` });
}

async function saved(name: string, t: object): Promise<string> {
	return (await client.plugin<SavedResult>("templates/create", { name, template: t })).template.id;
}

/** The stored row, read from SQLite: no route call while the site is fenced (step 6). */
function stored(id: string): unknown {
	return withDb(server.dbPath, (db) => {
		const row = db
			.prepare(
				"SELECT data FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'schedules' AND id = ?",
			)
			.get(id) as { data: string };
		return JSON.parse(row.data);
	});
}

/** SQLite's own clock, in the `datetime('now')` form EmDash writes into `revisions.created_at`. */
function sqliteNow(): string {
	return withDb(server.dbPath, (db) => {
		const row = db.prepare("SELECT datetime('now') AS now").get() as { now: string };
		return row.now;
	});
}

/**
 * Entries with an author among `slugs` (all of them when omitted), and revisions of `COLL` with
 * an author created after `since` (all of them when omitted). Preflight F4: the Admin's own
 * rollback and import write authored revisions, so step 7 counts only what came after its mark.
 */
function authoredRows(slugs?: ReadonlySet<string>, since?: string): number[] {
	return withDb(server.dbPath, (db) => {
		const entries = db
			.prepare("SELECT slug FROM ec_m6b_products WHERE locale = 'en' AND author_id IS NOT NULL")
			.all() as { slug: string | null }[];
		const revisions = db
			.prepare(
				"SELECT COUNT(*) AS n FROM revisions WHERE collection = ? AND author_id IS NOT NULL AND created_at > ?",
			)
			.get(COLL, since ?? "") as { n: number };
		const counted = entries.filter((e) => !slugs || (e.slug !== null && slugs.has(e.slug)));
		return [counted.length, revisions.n];
	});
}

describe("scheduled URL imports (M6b)", { timeout: 600_000 }, () => {
	it("1. launches and completes a scheduled import with no further call (the acceptance)", async () => {
		const src = await source("M6b feed", "/m6b.csv", productsCsv(20));
		a.sourceId = src.id;
		a.templateId = await saved("M6b", template(COLL));
		const created = await create({
			name: "Every minute",
			templateId: a.templateId,
			templateRevision: 1,
			sourceId: a.sourceId,
			cron: "* * * * *",
		});
		a.id = created.id;
		const done = await waitFor(
			() => schedule(a.id),
			(s) => s.runs.length >= 1,
			{ timeoutMs: 150_000, label: "the first scheduled run" },
		);
		expect(done.runs).toHaveLength(1);
		expect(done.runs[0]).toMatchObject({
			outcome: "completed",
			counters: { created: 20, updated: 0, failed: 0, removed: 0 },
		});
		const entries = await client.listAll(COLL);
		expect(entries).toHaveLength(20);
		expect(entries.every((e) => e.status === "published")).toBe(true);
		// Spec Rulings 4, 5: no author on the entries, none on their revisions.
		expect(authoredRows()).toEqual([0, 0]);
		// The stop route refuses a call without the CSRF header (plan Ruling 1).
		const refused = await fetch(`${server.baseUrl}/test/stop-cron-timer`, { method: "POST" });
		expect(refused.status).toBe(403);
		// From here every tick is the test's (plan Ruling 18).
		await stopCronTimer(server.baseUrl);
		await update(a.id, { cron: YEARLY });
	});

	it("2. records unchanged content, then updates the two changed rows", async () => {
		const unchanged = await run(a.id, (s) => s.lastLaunch?.outcome === "unchanged" && !s.due);
		feeds.feeds.set("/m6b.csv", {
			body: productsCsv(20, (i) => (i < 2 ? `${i}.75` : `${i}.5`)),
			etag: true,
		});
		const changed = await run(a.id, ranAgain(unchanged));
		expect(changed.runs[0]).toMatchObject({
			outcome: "completed",
			counters: { created: 0, updated: 2, unchanged: 18 },
		});
	});

	it("3. pauses on a rollback and on a cancel, and is busy while the rollback runs", async () => {
		const second = (await schedule(a.id)).runs[0]?.jobId as string;
		const rollback = await client.plugin<Job>("jobs/rollback", { id: second });
		let s = await schedule(a.id);
		expect(s).toMatchObject({ enabled: false, pause: { reason: "rolled_back", jobId: second } });
		expect(s.runs[0]?.rolledBack).toEqual({ by: rollback.id, at: rollback.createdAt });
		await update(a.id, { enabled: true });
		const busy = client.plugin("schedules/run", { id: a.id });
		await expect(busy).rejects.toMatchObject({ code: "SCHEDULE_BUSY" });
		await client.runToEnd(rollback.id);
		// The rollback cleared lastImport, so the same feed runs again and re-applies the two rows.
		s = await run(a.id, ranAgain(s));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { updated: 2 } });
		// A cancel: launch on a changed feed, then cancel before the pump's first batch.
		feeds.feeds.set("/m6b.csv", { body: productsCsv(20, (i) => `${i}.25`), etag: true });
		const before = s;
		s = await run(
			a.id,
			(x) => x.lastLaunch?.outcome === "started" && x.lastLaunch.at !== before.lastLaunch?.at,
		);
		const job = s.lastLaunch?.jobId as string;
		await client.plugin("jobs/cancel", { id: job });
		expect(await schedule(a.id)).toMatchObject({
			enabled: false,
			pause: { reason: "cancelled", jobId: job },
		});
		const finalized = await run(a.id, (x) => x.runs[0]?.jobId === job);
		expect(finalized.runs[0]?.outcome).toBe("cancelled");
	});

	it("4. removes one missing entry, refuses five, and removes nothing on an empty feed", async () => {
		const owned = {
			...template(OWNED),
			rules: { owner: "m6b", missing: { action: "trash", maxPercent: 10 } },
		};
		const src = await source("Owned feed", "/owned.csv", productsCsv(20));
		const b = await create({
			name: "Owned",
			templateId: await saved("M6b owned", owned),
			templateRevision: 1,
			sourceId: src.id,
			missing: "template",
		});
		let s = await run(b.id, (x) => x.runs.length === 1);
		feeds.feeds.set("/owned.csv", { body: productsCsv(19), etag: true });
		s = await run(b.id, ranAgain(s));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { removed: 1 } });
		feeds.feeds.set("/owned.csv", { body: productsCsv(14), etag: true });
		s = await run(b.id, pausedFor("missing_refused"));
		expect(s.runs[0]).toMatchObject({ outcome: "missing_refused", counters: { removed: 0 } });
		await update(b.id, { enabled: true });
		feeds.feeds.set("/owned.csv", { body: productsCsv(0), etag: true });
		s = await run(b.id, pausedFor("empty_feed"));
		expect(s.runs[0]).toMatchObject({ outcome: "empty_feed", counters: { removed: 0 } });
		expect(await client.listAll(OWNED)).toHaveLength(19);
		await client.plugin("schedules/delete", { id: b.id, revision: s.revision });
	});

	it("5. pauses for a changed template or source, a deleted template, a demoted creator, failed fetches and a failed job", async () => {
		await update(a.id, { enabled: true });
		// template_changed, then resumed at revision 2.
		await client.plugin("templates/update", { id: a.templateId, revision: 1, description: "v2" });
		let s = await run(a.id, pausedFor("template_changed"));
		s = await update(a.id, { templateRevision: 2, enabled: true });
		expect(s.pause).toBeUndefined();
		// source_changed, then re-armed on the new URL.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20), etag: true });
		await client.plugin("sources/update", {
			id: a.sourceId,
			url: `${feeds.baseUrl}/m6b-moved.csv`,
		});
		s = await run(a.id, pausedFor("source_changed"));
		await update(a.id, { enabled: true });
		// template_gone: the in-use refusal blocks the route, so the row goes through withDb.
		const doomed = await saved("M6b doomed", template(COLL));
		const d = await create({
			name: "Doomed",
			templateId: doomed,
			templateRevision: 1,
			sourceId: a.sourceId,
		});
		withDb(server.dbPath, (db) =>
			db
				.prepare(
					"DELETE FROM _plugin_storage WHERE plugin_id = 'flux-import' AND collection = 'templates' AND id = ?",
				)
				.run(doomed),
		);
		s = await run(d.id, pausedFor("template_gone"));
		await client.plugin("schedules/delete", { id: d.id, revision: s.revision });
		// creator_gone: a second Admin arms a schedule and is demoted to Editor (Fact E7).
		const second = new Client(server.baseUrl, createUserToken(server.dbPath, 50));
		const e = await create(
			{ name: "Second Admin", templateId: a.templateId, templateRevision: 2, sourceId: a.sourceId },
			second,
		);
		withDb(server.dbPath, (db) =>
			db.prepare("UPDATE users SET role = 40 WHERE id = ?").run(e.armedBy),
		);
		s = await run(e.id, pausedFor("creator_gone"));
		await client.plugin("schedules/delete", { id: e.id, revision: s.revision });
		// fetch_failed: three transient failures (an unknown path answers 404, HTTP_ERROR).
		feeds.feeds.delete("/m6b-moved.csv");
		for (const failures of [1, 2]) {
			s = await run(a.id, (x) => x.launchFailures === failures);
			expect(s.lastLaunch).toMatchObject({ outcome: "failed", errorCode: "HTTP_ERROR" });
		}
		s = await run(a.id, pausedFor("fetch_failed"));
		expect(s.launchFailures).toBe(3);
		// job_failed, and the re-enabled schedule imports the same content again (spec Ruling 15).
		feeds.feeds.set("/m6b-moved.csv", { body: MALFORMED_CSV, etag: true });
		await update(a.id, { enabled: true });
		s = await run(a.id, pausedFor("job_failed"));
		const failed = s.runs[0]?.jobId;
		expect(s.runs[0]?.outcome).toBe("failed");
		await update(a.id, { enabled: true });
		s = await run(a.id, (x) => pausedFor("job_failed")(x) && x.runs[0]?.jobId !== failed);
		expect(s.lastLaunch?.outcome).toBe("started");
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20), etag: true });
		await update(a.id, { enabled: true });
	});

	it("6. stands down while a site import or export runs, and resumes after (Fact V4)", async () => {
		const insert = (id: string, kind: string, state: string, started: string | null) =>
			withDb(server.dbPath, (db) =>
				db
					.prepare(
						"INSERT INTO _emdash_transfer_operations (id, kind, state, staging_secret, created_by, mutation_started_at) VALUES (?, ?, ?, 'x', 'test', ?)",
					)
					.run(id, kind, state, started),
			);
		const remove = (id: string) =>
			withDb(server.dbPath, (db) =>
				db.prepare("DELETE FROM _emdash_transfer_operations WHERE id = ?").run(id),
			);
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20, (i) => `${i}.95`), etag: true });
		for (const [id, kind] of [
			["m6b-import", "import"],
			["m6b-export", "export"],
		] as const) {
			insert(id, kind, "running", kind === "import" ? new Date().toISOString() : null);
			try {
				// Due marks still run while fenced; they write only plugin storage (spec "Site fence").
				await tick(server, taskNames(a.id));
				const fenced = stored(a.id) as ScheduleView;
				expect(fenced.due).toBeDefined();
				for (let i = 0; i < 3; i++) await tick(server, ["pump"]);
				// The pump wrote nothing: the row is as the due mark left it.
				expect(stored(a.id)).toEqual(fenced);
			} finally {
				// A failure here must not leave the fence up for steps 7 and 8.
				remove(id);
			}
		}
		const before = await schedule(a.id);
		const s = await run(a.id, ranAgain(before));
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { updated: 20 } });
	});

	it("7. is busy while another import reads the source, and shares a scheduled job with jobs/next", async () => {
		// An Admin's real import on the same source.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(20, (i) => `${i}.15`), etag: true });
		const admin = await client.plugin<Job>("jobs/create", {
			sourceId: a.sourceId,
			templateId: a.templateId,
			dryRun: false,
		});
		let s = await run(a.id, (x) => x.lastLaunch?.outcome === "busy");
		expect(s.lastLaunch?.jobId).toBe(admin.id);
		await client.runToEnd(admin.id);
		// A scheduled job an Admin pauses is not batched and keeps the next launch busy.
		feeds.feeds.set("/m6b-moved.csv", { body: productsCsv(120, (i) => `${i}.35`), etag: true });
		const before = s;
		s = await run(
			a.id,
			(x) => x.lastLaunch?.outcome === "started" && x.lastLaunch.at !== before.lastLaunch?.at,
		);
		const job = s.lastLaunch?.jobId as string;
		await client.plugin("jobs/pause", { id: job });
		const pausedJob = await client.plugin<Job>("jobs/get", { id: job });
		await tick(server, ["pump"]);
		expect((await client.plugin<Job>("jobs/get", { id: job })).counters).toEqual(
			pausedJob.counters,
		);
		s = await run(a.id, (x) => x.lastLaunch?.outcome === "busy" && x.lastLaunch.jobId === job);
		// Preflight F4: the Admin's rollback (step 3) and import (above) wrote authored revisions.
		// Mark SQLite's clock (whole seconds) and wait past it, so every revision the scheduled
		// job writes from here is strictly after the mark and every earlier one is not.
		const since = sqliteNow();
		await waitFor(
			async () => sqliteNow(),
			(now) => now > since,
			{ timeoutMs: 5_000, label: "the next second" },
		);
		// Resumed: one batch through jobs/next, the rest by the pump, sharing the lease.
		await client.plugin("jobs/resume", { id: job });
		await client.plugin<Job>("jobs/next", { id: job });
		s = await run(a.id, (x) => x.runs[0]?.jobId === job);
		const done = await client.plugin<Job>("jobs/get", { id: job });
		const { created, updated, unchanged, failed } = done.counters;
		// SKU-0..19 exist with other prices; SKU-20..119 are new.
		expect([created, updated, unchanged, failed]).toEqual([100, 20, 0, 0]);
		expect(s.runs[0]).toMatchObject({
			outcome: "completed",
			counters: { created, updated, unchanged },
		});
		// The entries this job created (SKU-20..119) have no author; no revision since has one.
		const createdHere = new Set(Array.from({ length: 100 }, (_, i) => `product-${i + 20}`));
		expect(authoredRows(createdHere, since)).toEqual([0, 0]);
		expect(created).toBe(100);
	});

	it("8. runs now with force on unchanged content", async () => {
		const before = await schedule(a.id);
		const queued = await client.plugin<{ queued: true; schedule: ScheduleView }>("schedules/run", {
			id: a.id,
			force: true,
		});
		expect(queued.schedule.due).toMatchObject({ force: true });
		let s = queued.schedule;
		for (let i = 0; i < 40 && !ranAgain(before)(s); i++) {
			await tick(server, ["pump"]);
			s = await schedule(a.id);
		}
		expect(s.runs[0]).toMatchObject({ outcome: "completed", counters: { unchanged: 120 } });
		expect(s.lastLaunch?.outcome).toBe("started");
	});
});
