import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sameStored } from "../../src/engine/rollback-values.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { BLUE_PNG, RED_PNG } from "../fixtures/media.js";
import {
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	translationCsv,
	translationNames,
	translationTemplate,
} from "../fixtures/translations.js";
import { Client, devBypass, type Product } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
const TAG = "it_rb_tag";
const ALEX = "it-rb-alex";
const SAM = "it-rb-sam";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

/** A collection with every kind of value a rollback restores, revisioned or plain. */
async function createRollbackSchema(collection: string, revisions: boolean): Promise<void> {
	await client.api("POST", "/_emdash/api/schema/collections", {
		slug: collection,
		label: collection,
		supports: revisions ? ["drafts", "revisions"] : ["drafts"],
		editLocking: true,
	});
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "price", label: "Price", type: "number" },
		{ slug: "featured", label: "Featured", type: "boolean" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "body", label: "Body", type: "portableText" },
		{
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { targetCollection: collection, multiple: true },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

function rollbackTemplate(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "id" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			featured: { from: "Featured", type: "boolean" },
			photo: { from: "Photo", type: "image" },
			body: { from: "Body", type: "portableText", format: "markdown" },
			related: { from: "Related", type: "reference", match: "key", separator: "|" },
		},
		taxonomies: { [TAG]: { from: "Tags", separator: "|", create: true } },
		bylines: { from: "Authors", match: "name", separator: ";" },
	};
}

type Row = { id: string; name: string; price: number; featured: boolean; tags: string };

/** Rows `U1`… as the first job leaves them, or as the second job changes them (`changed`). */
function rows(prefix: string, n: number, changed = false): Row[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `${prefix}${i + 1}`,
		name: `${changed ? "Changed" : "Item"} ${prefix}${i + 1}`,
		price: changed ? i + 100 : i + 1,
		featured: !changed,
		tags: changed ? "sale|fresh" : "new",
	}));
}

function rollbackCsv(list: Row[], changed = false): string {
	const photo = feeds.url(changed ? "/rb-blue.png" : "/rb-red.png");
	const lines = list.map((r, i) =>
		[
			r.id,
			r.name.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.price,
			r.featured,
			photo,
			`"${changed ? "## Changed\n\nNew *body*" : "Body of **item**"}"`,
			// Each row links to the one before it; the changed rows to the first.
			i === 0 ? "" : changed ? list[0]?.id : list[i - 1]?.id,
			r.tags,
			changed ? "Sam Lee" : "Alex Doe",
		].join(","),
	);
	return ["id,Handle,Name,Price,Featured,Photo,Body,Related,Tags,Authors", ...lines, ""].join("\n");
}

async function importCsv(
	csv: string,
	jobTemplate: object,
	opts: { publish?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: opts.batchSize ?? 10,
	});
	return client.runToEnd(created.id);
}

async function rollBack(
	id: string,
	opts: { dryRun?: boolean; batchSize?: number; budgetMs?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const created = await client.plugin("jobs/rollback", { id, batchSize: 10, ...opts });
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

/** What a rollback restores, as the content API reads it back. */
async function stateOf(collection: string, id: string) {
	const { item } = await client.api<{ item: Product & { scheduledAt?: string | null } }>(
		"GET",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
	);
	return {
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		slug: item.slug,
		hasDraft: item.draftRevisionId !== null,
		data: item.data,
		tags: (await client.entryTerms(collection, id, TAG).catch(() => [])).sort(),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
		related: (item.references?.related?.children ?? []).map((c) => c.id),
	};
}

type State = Awaited<ReturnType<typeof stateOf>>;

function expectSame(after: State, before: State) {
	const { data: a, ...restA } = after;
	const { data: b, ...restB } = before;
	expect(restA).toEqual(restB);
	if (!sameStored(a, b)) expect(a).toEqual(b);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function statesOf(collection: string): Promise<Map<string, State>> {
	const out = new Map<string, State>();
	for (const [key, e] of await byKey(collection)) out.set(key, await stateOf(collection, e.id));
	return out;
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
	await feeds.start();
	feeds.feeds.set("/rb-red.png", { body: RED_PNG, contentType: "image/png" });
	feeds.feeds.set("/rb-blue.png", { body: BLUE_PNG, contentType: "image/png" });
	// Its own server: photos are fetched from 127.0.0.1 (allowPrivateNetwork), and one test kills it.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await createRollbackSchema("it_rb_rev", true);
	await createRollbackSchema("it_rb_plain", false);
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: TAG,
		label: "Tags",
		collections: ["it_rb_rev", "it_rb_plain"],
	});
	for (const slug of ["new", "sale"]) {
		await client.api("POST", `/_emdash/api/taxonomies/${TAG}/terms`, {
			slug,
			label: slug,
			locale: "en",
		});
	}
	for (const [slug, displayName] of [
		[ALEX, "Alex Doe"],
		[SAM, "Sam Lee"],
	]) {
		await client.api("POST", "/_emdash/api/admin/bylines", { slug, displayName, locale: "en" });
	}
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

describe.each([
	["revisioned", "it_rb_rev", true],
	["plain", "it_rb_plain", false],
])("M5a rollback of a create-and-update job (%s collection)", (_kind, collection, firstRun) => {
	const first = rows("U", 10);
	const second = [...rows("U", 10, true), ...rows("N", 20, true)];
	let before: Map<string, State>;
	let job: Job;
	let reimport: Job;

	beforeAll(async () => {
		const seeded = await importCsv(rollbackCsv(first), rollbackTemplate(collection));
		expect(seeded.counters).toMatchObject({ created: 10, failed: 0 });
		before = await statesOf(collection);
		job = await importCsv(rollbackCsv(second, true), rollbackTemplate(collection));
		expect(job.counters).toMatchObject({ created: 20, updated: 10, failed: 0, conflict: 0 });
	});

	it("plans the rollback in a dry run, writing nothing, with the kept media and terms", async () => {
		const after = await statesOf(collection);
		const dry = await rollBack(job.id, { dryRun: true });
		expect(dry.job.counters).toMatchObject({ reverted: 30, conflict: 0, failed: 0 });
		expect(dry.rows.every((r) => r.status === "planned")).toBe(true);
		// The second collection's job reuses the photo and the term the first one created.
		expect(dry.job.warnings).toEqual(
			firstRun
				? [
						expect.stringMatching(/^The import created 1 media items, which are kept .*: \S+$/),
						expect.stringMatching(/^The import created 1 terms, which are kept/),
					]
				: [],
		);
		expect(await statesOf(collection)).toEqual(after);
		expect(await client.plugin("jobs/get", { id: job.id })).not.toHaveProperty("rolledBackBy");
	});

	it("deletes the created entries and restores the changed ones exactly", async () => {
		const done = await rollBack(job.id);
		expect(done.job).toMatchObject({
			status: "completed",
			counters: { reverted: 30, conflict: 0, failed: 0 },
		});
		const now = await statesOf(collection);
		expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [key, state] of before) expectSame(now.get(key) as State, state);
		// The created entries are gone, not in Trash.
		const trash = await client.api<{ items: unknown[] }>(
			"GET",
			`/_emdash/api/content/${collection}/trash?locale=en`,
		);
		expect(trash.items).toEqual([]);
	});

	it("imports the same feed again without slug conflicts", async () => {
		reimport = await importCsv(rollbackCsv(second, true), rollbackTemplate(collection));
		expect(reimport.counters).toMatchObject({ created: 20, updated: 10, failed: 0, conflict: 0 });
	});

	it("leaves an entry an editor changed after the job, and reports it", async () => {
		const u1 = (await byKey(collection)).get("U1") as Product;
		const { _rev } = await client.getEntry(collection, u1.id);
		await client.api("PUT", `/_emdash/api/content/${collection}/${u1.id}`, {
			data: { title: "Editor title" },
			_rev,
		});
		const edited = await stateOf(collection, u1.id);
		const done = await rollBack(reimport.id);
		expect(done.job.counters).toMatchObject({ reverted: 29, conflict: 1 });
		expect(done.rows.find((r) => r.sourceKey === "U1")).toMatchObject({
			status: "conflict",
			errors: [{ code: "rollback_changed" }],
		});
		expect(await stateOf(collection, u1.id)).toEqual(edited);
	});
});

describe("M5a rollback order and drafts", () => {
	it("rolls back later jobs first; oldest first conflicts", async () => {
		await client.createProducts("it_rb_chain");
		const t = template("it_rb_chain");
		await importCsv(productsCsv(3), t);
		const initial = await statesOf("it_rb_chain");
		const b = await importCsv(
			productsCsv(3, (i) => `${i + 10}`),
			t,
		);
		const afterB = await statesOf("it_rb_chain");
		const c = await importCsv(
			productsCsv(3, (i) => `${i + 20}`),
			t,
		);
		const early = await rollBack(b.id, { dryRun: true });
		expect(early.job.counters).toMatchObject({ conflict: 3, reverted: 0 });
		expect(early.rows.every((r) => r.errors?.[0]?.code === "rollback_changed")).toBe(true);
		await rollBack(c.id);
		for (const [key, state] of afterB) {
			expectSame((await statesOf("it_rb_chain")).get(key) as State, state);
		}
		expect((await rollBack(b.id)).job.counters).toMatchObject({ reverted: 3 });
		const now = await statesOf("it_rb_chain");
		for (const [key, state] of initial) expectSame(now.get(key) as State, state);
	});

	it("leaves the pending draft of a publish: false job when the publishing job after it is rolled back", async () => {
		await client.createProducts("it_rb_drafts");
		const t = template("it_rb_drafts");
		await importCsv(productsCsv(2), t);
		const staged = await importCsv(
			productsCsv(2, (i) => `${i + 50}`),
			t,
			{ publish: false },
		);
		expect(staged.counters).toMatchObject({ updated: 2 });
		const pending = await statesOf("it_rb_drafts");
		expect([...pending.values()].every((s) => s.hasDraft)).toBe(true);
		const published = await importCsv(
			productsCsv(2, (i) => `${i + 70}`),
			t,
		);
		expect(published.counters).toMatchObject({ updated: 2, conflict: 0 });
		expect((await rollBack(published.id)).job.counters).toMatchObject({ reverted: 2 });
		const now = await statesOf("it_rb_drafts");
		for (const [key, state] of pending) expectSame(now.get(key) as State, state);
		// The draft is the importer's again: publishing the same values goes through.
		const again = await importCsv(
			productsCsv(2, (i) => `${i + 50}`),
			t,
		);
		expect(again.counters).toMatchObject({ conflict: 0, failed: 0 });
	});

	it("schedules a scheduled entry again", async () => {
		await client.createProducts("it_rb_sched");
		const t = template("it_rb_sched");
		await importCsv(productsCsv(1), t, { publish: false });
		const entry = (await byKey("it_rb_sched")).get("SKU-0") as Product;
		const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		await client.api("POST", `/_emdash/api/content/it_rb_sched/${entry.id}/schedule`, {
			scheduledAt: at,
		});
		const scheduled = await stateOf("it_rb_sched", entry.id);
		expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: at });
		// As a scheduling import (M5b) would leave it: the link holds the scheduled revision, so the
		// next import owns the draft. No API writes a link row, so the test sets it in the database.
		const { _rev } = await client.getEntry("it_rb_sched", entry.id);
		withDb(server.dbPath, (db) => {
			const moved = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_set(data, '$.writtenRev', ?) WHERE plugin_id = 'flux-import' AND collection = 'links' AND json_extract(data, '$.entryId') = ?",
				)
				.run(_rev, entry.id);
			if (moved.changes !== 1) throw new Error(`No link row for ${entry.id}`);
		});
		const job = await importCsv(
			productsCsv(1, () => "9"),
			t,
		);
		expect(job.counters).toMatchObject({ updated: 1, conflict: 0 });
		expect((await rollBack(job.id)).job.counters).toMatchObject({ reverted: 1 });
		expectSame(await stateOf("it_rb_sched", entry.id), scheduled);
	});

	it("rolls back a French translation job before the English one", async () => {
		const n = translationNames("it_rbt");
		await createTranslationSchema(client, n);
		const en = await importCsv(
			englishCsv([
				["E1", "Desk", "S1", 100],
				["E2", "Lamp", "S2", 20],
			]),
			englishTemplate(n),
		);
		expect(en.counters).toMatchObject({ created: 2, failed: 0 });
		const fr = await importCsv(
			translationCsv([
				{ id: "F1", enId: "E1", name: "Bureau" },
				{ id: "F2", enId: "E2", name: "Lampe" },
			]),
			translationTemplate(n, "fr"),
		);
		expect(fr.counters).toMatchObject({ created: 2, failed: 0 });
		const blocked = await rollBack(en.id);
		expect(blocked.job.counters).toMatchObject({ conflict: 2, reverted: 0 });
		expect(blocked.rows.every((r) => r.errors?.[0]?.code === "rollback_has_translations")).toBe(
			true,
		);
		expect((await rollBack(fr.id)).job.counters).toMatchObject({ reverted: 2 });
		expect(await listLocale(client, n.products, "fr")).toEqual([]);
		await client.plugin("jobs/retry", { id: blocked.job.id });
		const retried = await client.runToEnd(blocked.job.id);
		expect(retried.counters).toMatchObject({ reverted: 2, conflict: 0 });
		expect(await listLocale(client, n.products, "en")).toEqual([]);
	});

	it("re-imports a URL source after a rolled-back and after a cancelled job", async () => {
		await client.createProducts("it_rb_url");
		feeds.feeds.set("/rb.csv", { body: productsCsv(3), etag: true });
		const source = await client.plugin<SourceRow>("sources/create", {
			name: "Rollback feed",
			url: feeds.url("/rb.csv"),
		});
		const create = () =>
			client.plugin<Job | { skipped: string }>("jobs/create", {
				sourceId: source.id,
				template: template("it_rb_url"),
				dryRun: false,
			});
		const first = (await create()) as Job;
		await client.runToEnd(first.id);
		expect(await create()).toMatchObject({ skipped: "unchanged" });
		await rollBack(first.id);
		const second = await create();
		expect(second).not.toHaveProperty("skipped");
		expect((await client.runToEnd((second as Job).id)).counters).toMatchObject({ created: 3 });

		feeds.feeds.set("/rb.csv", { body: productsCsv(4), etag: true });
		const third = (await create()) as Job;
		await client.plugin("jobs/cancel", { id: third.id });
		const fourth = await create();
		expect(fourth).not.toHaveProperty("skipped");
		expect((await client.runToEnd((fourth as Job).id)).counters).toMatchObject({
			created: 1,
			unchanged: 3,
		});
	});
});

describe("M5a kill and resume of a rollback", () => {
	it("finishes a rollback a crash cut off mid-batch, deleting every entry once", async () => {
		await client.createProducts("it_rb_crash");
		const rowsCount = 300;
		const job = await importCsv(productsCsv(rowsCount), template("it_rb_crash"), {
			batchSize: 100,
		});
		expect(job.counters).toMatchObject({ created: rowsCount });
		const created = await client.plugin("jobs/rollback", {
			id: job.id,
			batchSize: 100,
			budgetMs: 2_000,
		});
		await client.plugin("jobs/next", { id: created.id });
		const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
		await sleep(400);
		await stopServer(server, "SIGKILL");
		const interrupted = (await inFlight) === null;
		await restart();
		const killed = await waitForLease(created.id);
		if (!interrupted) throw new Error("The kill did not cut off a jobs/next call in flight");
		expect(killed.status).toBe("running");
		expect(killed.cursor.seq).toBeLessThan(rowsCount);
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { reverted: rowsCount, failed: 0, conflict: 0 },
		});
		expect(await client.records(created.id, "writing")).toEqual([]);
		expect(await client.listAll("it_rb_crash")).toEqual([]);
		const again = await importCsv(productsCsv(rowsCount), template("it_rb_crash"), {
			batchSize: 100,
		});
		expect(again.counters).toMatchObject({ created: rowsCount, failed: 0 });
	});
});
