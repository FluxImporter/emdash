import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
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
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

// The M5a rollback suite's port: suites run one at a time, and this one kills its own server.
const PORT = 4391;
const TAG = "it_rr_tag";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;
const terms: Record<string, string> = {};
const bylines: Record<string, string> = {};

const KINDS = [
	["revisioned", "it_rr_rev", true],
	["plain", "it_rr_plain", false],
] as const;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

async function createSchema(collection: string, revisions: boolean): Promise<void> {
	await client.api("POST", "/_emdash/api/schema/collections", {
		slug: collection,
		label: collection,
		supports: revisions ? ["drafts", "revisions"] : ["drafts"],
		editLocking: true,
	});
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "price", label: "Price", type: "number" },
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

function rulesTemplate(collection: string, extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "id" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
		},
		taxonomies: { [TAG]: { from: "Tags", separator: "|" } },
		bylines: { from: "Authors", match: "slug", separator: ";" },
		...extra,
	};
}

type Row = { id: string; name: string; price: number; tags?: string; authors?: string };

function csv(rows: Row[]): string {
	const lines = rows.map((r) =>
		[
			r.id,
			`${r.id}-${r.name}`.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.price,
			r.tags ?? "new",
			r.authors ?? "it-rr-alex",
		].join(","),
	);
	return ["id,Handle,Name,Price,Tags,Authors", ...lines, ""].join("\n");
}

async function importCsv(
	body: string,
	jobTemplate: object,
	opts: { publish?: boolean; dryRun?: boolean; batchSize?: number } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(body);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: opts.batchSize ?? 10,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

async function rollBack(id: string): Promise<{ job: Job; rows: RecordRow[] }> {
	const created = await client.plugin("jobs/rollback", { id, batchSize: 10 });
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function entryId(collection: string, key: string): Promise<string> {
	const entry = (await byKey(collection)).get(key);
	if (!entry) throw new Error(`No entry for ${collection}/${key}`);
	return entry.id;
}

/** The entry as EmDash reads it back: status, schedule, draft, data, terms and bylines. */
async function stateOf(collection: string, id: string) {
	const { item } = await client.api<{ item: Product & { scheduledAt?: string | null } }>(
		"GET",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
	);
	return {
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		hasDraft: item.draftRevisionId !== null,
		title: item.data.title,
		price: item.data.price,
		tags: (await client.entryTerms(collection, id, TAG)).sort(),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
	};
}

/**
 * An editor's change through the content API, published as the admin publishes it: a
 * revisioned collection stages a draft that the publish makes live; a plain one writes at once.
 */
async function edit(collection: string, id: string, change: object): Promise<void> {
	const { _rev } = await client.getEntry(collection, id);
	const saved = await client.api<{ _rev: string }>(
		"PUT",
		`/_emdash/api/content/${collection}/${id}?locale=en`,
		{ ...change, _rev },
	);
	const { item } = await client.getEntry(collection, id);
	if (item.draftRevisionId === null) return;
	await client.api("POST", `/_emdash/api/content/${collection}/${id}/publish?locale=en`, {
		_rev: saved._rev,
	});
}

/** Sets the entry's terms through the terms route, which leaves its revision (V2). */
async function setTerms(collection: string, id: string, slugs: string[]): Promise<void> {
	await client.api("POST", `/_emdash/api/content/${collection}/${id}/terms/${TAG}`, {
		termIds: slugs.map((s) => terms[s]),
	});
}

/** Runs EmDash's scheduled maintenance now, through the dev site's test route. */
async function sweep(): Promise<string[]> {
	const res = await fetch(`${server.baseUrl}/test/run-scheduled`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	if (!res.ok) throw new Error(`run-scheduled answered ${res.status}`);
	const body = (await res.json()) as { published: { id: string }[] };
	return body.published.map((p) => p.id);
}

/**
 * Sweeps until every entry in `due` (collection, ID) is published, by this route or by the Node
 * timer. Polled rather than timed once: under WSL a long timer can fire before the wall clock
 * reaches the time it waited for.
 */
async function sweepUntil(at: string, due: [string, string][]): Promise<void> {
	const until = Date.parse(at) + 60_000;
	await sleep(Math.max(0, Date.parse(at) - Date.now()));
	for (;;) {
		await sweep();
		const states = await Promise.all(due.map(([c, id]) => stateOf(c, id)));
		if (states.every((s) => s.status === "published" && s.scheduledAt === null)) return;
		if (Date.now() > until) throw new Error("The scheduler did not publish the due entries");
		await sleep(1_000);
	}
}

const codes = (row: RecordRow | undefined) => (row?.warnings ?? []).map((w) => w.code);
const fieldsOf = (row: RecordRow | undefined) => (row?.changes ?? []).map((c) => c.field);
const edited = (row: RecordRow | undefined) =>
	(row?.warnings ?? [])
		.filter((w) => w.code === "field_edited")
		.map((w) => w.field)
		.sort();

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	// Its own server: the kill-and-resume test stops it.
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	for (const [, collection, revisions] of KINDS) await createSchema(collection, revisions);
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: TAG,
		label: "Tags",
		collections: KINDS.map(([, c]) => c),
	});
	for (const slug of ["new", "sale"]) {
		const made = await client.api<{ term: { id: string } }>(
			"POST",
			`/_emdash/api/taxonomies/${TAG}/terms`,
			{ slug, label: slug, locale: "en" },
		);
		terms[slug] = made.term.id;
	}
	for (const [slug, displayName] of [
		["it-rr-alex", "Alex Doe"],
		["it-rr-sam", "Sam Lee"],
	] as const) {
		const made = await client.api<{ id: string }>("POST", "/_emdash/api/admin/bylines", {
			slug,
			displayName,
			locale: "en",
		});
		bylines[slug] = made.id;
	}
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

describe.each(KINDS)("M5b write modes and protection (%s collection)", (_kind, collection) => {
	const t = (extra: Record<string, unknown> = {}) => rulesTemplate(collection, extra);

	it("creates only new keys in create mode and updates only existing keys in update mode", async () => {
		await importCsv(csv([{ id: "M1", name: "Desk", price: 10 }]), t());
		const create = await importCsv(
			csv([
				{ id: "M1", name: "Desk changed", price: 11 },
				{ id: "M2", name: "Lamp", price: 5 },
			]),
			t({ rules: { mode: "create" } }),
		);
		expect(create.job.counters).toMatchObject({ created: 1, unchanged: 1, failed: 0 });
		expect(create.rows.map((r) => [r.status, codes(r)])).toEqual([
			["unchanged", ["exists"]],
			["created", []],
		]);
		const update = await importCsv(
			csv([
				{ id: "M1", name: "Desk changed", price: 11 },
				{ id: "M3", name: "Chair", price: 7 },
			]),
			t({ rules: { mode: "update" } }),
		);
		expect(update.rows.map((r) => [r.status, codes(r)])).toEqual([
			["updated", []],
			["unchanged", ["not_found"]],
		]);
		const keys = await byKey(collection);
		expect([...keys.keys()].filter((k) => k.startsWith("M")).sort()).toEqual(["M1", "M2"]);
		expect(keys.get("M1")?.data).toMatchObject({ title: "Desk changed", price: 11 });
	});

	it("updates only the listed fields, leaving an unlisted field an editor changed", async () => {
		await importCsv(csv([{ id: "F1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "F1");
		await edit(collection, id, { data: { title: "Editor's desk" } });
		const { rows } = await importCsv(
			csv([{ id: "F1", name: "Feed desk", price: 12, tags: "sale" }]),
			t({ rules: { updateFields: ["price"] } }),
		);
		expect(rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(rows[0])).toEqual(["price"]);
		expect(await stateOf(collection, id)).toMatchObject({
			title: "Editor's desk",
			price: 12,
			tags: ["new"],
		});
	});

	it("keeps an editor's field, term and byline changes, updates the rest, then lifts them", async () => {
		await importCsv(csv([{ id: "P1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "P1");
		await edit(collection, id, { data: { title: "Editor's desk" } });
		await setTerms(collection, id, ["sale"]);
		await edit(collection, id, {
			bylines: [{ bylineId: bylines["it-rr-sam"], roleLabel: null }],
		});
		const protectedRun = await importCsv(
			csv([{ id: "P1", name: "Desk", price: 12 }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(protectedRun.rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(protectedRun.rows[0])).toEqual(["price"]);
		expect(edited(protectedRun.rows[0])).toEqual(["bylines", "taxonomies.it_rr_tag", "title"]);
		expect(await stateOf(collection, id)).toMatchObject({
			status: "published",
			hasDraft: false,
			title: "Editor's desk",
			price: 12,
			tags: ["sale"],
			bylines: ["it-rr-sam"],
		});
		// A job without protectEdited writes the feed's values, and protection lifts.
		await importCsv(csv([{ id: "P1", name: "Desk", price: 12 }]), t());
		expect(await stateOf(collection, id)).toMatchObject({
			title: "Desk",
			tags: ["new"],
			bylines: ["it-rr-alex"],
		});
		const again = await importCsv(
			csv([{ id: "P1", name: "Desk", price: 13 }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(again.rows[0]).toMatchObject({ status: "updated" });
		expect(codes(again.rows[0])).toEqual([]);
	});

	it("falls back on the revision for a link saved before M5b, counting terms as edited", async () => {
		await importCsv(csv([{ id: "L1", name: "Desk", price: 10 }]), t());
		const id = await entryId(collection, "L1");
		withDb(server.dbPath, (db) => {
			const stripped = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_remove(data, '$.fields') WHERE plugin_id = ? AND collection = ? AND id = ?",
				)
				.run("fluximporter", "links", `${collection}:en:L1`);
			expect(stripped.changes).toBe(1);
		});
		const { rows } = await importCsv(
			csv([{ id: "L1", name: "Desk", price: 12, tags: "sale" }]),
			t({ rules: { protectEdited: true } }),
		);
		expect(rows[0]).toMatchObject({ status: "updated" });
		expect(fieldsOf(rows[0])).toEqual(["price"]);
		expect(edited(rows[0])).toEqual(["taxonomies.it_rr_tag"]);
		expect(await stateOf(collection, id)).toMatchObject({ price: 12, tags: ["new"] });
	});
});

describe("M5b publish, draft or schedule, and the scheduler", () => {
	// Past the 60-second lead, with time for the imports below to run first.
	let at: string;
	const later = () => new Date(Date.parse(at) + 3_600_000).toISOString();
	const scheduled = (collection: string, publishAt: string) =>
		rulesTemplate(collection, { publishAt: { expr: `'${publishAt}'` } });
	const jobs: Record<string, Job> = {};

	beforeAll(async () => {
		at = new Date(Date.now() + 90_000).toISOString();
		for (const [kind, collection] of KINDS) {
			// Seeded and published now: S2 (re-run after the sweep), R2 (rolled back after it),
			// B2 (rolled back before it).
			await importCsv(
				csv([
					{ id: "S2", name: "Seeded", price: 1 },
					{ id: "R2", name: "Seeded", price: 1 },
					{ id: "B2", name: "Seeded", price: 1 },
				]),
				rulesTemplate(collection),
			);
			for (const prefix of ["S", "R", "B"]) {
				jobs[`${kind}:${prefix}`] = (
					await importCsv(
						csv([
							{ id: `${prefix}1`, name: "Created", price: 2 },
							{ id: `${prefix}2`, name: "Updated", price: 2 },
						]),
						scheduled(collection, at),
					)
				).job;
			}
		}
	});

	it("refuses the sweep route without the CSRF header", async () => {
		const res = await fetch(`${server.baseUrl}/test/run-scheduled`, { method: "POST" });
		expect(res.status).toBe(403);
	});

	it("schedules created entries, and updates a revisioned collection keeps live until the time", async () => {
		for (const [kind, collection, revisions] of KINDS) {
			const job = jobs[`${kind}:S`] as Job;
			const rows = await client.records(job.id);
			expect(
				rows.map((r) => r.status),
				kind,
			).toEqual(["created", "updated"]);
			expect(
				rows[0]?.changes?.find((c) => c.field === "publishAt"),
				kind,
			).toMatchObject({
				after: at,
			});
			expect(await stateOf(collection, await entryId(collection, "S1")), kind).toMatchObject({
				status: "scheduled",
				scheduledAt: at,
			});
			const updated = await stateOf(collection, await entryId(collection, "S2"));
			if (revisions) {
				expect(updated, kind).toMatchObject({
					status: "published",
					scheduledAt: at,
					hasDraft: true,
				});
				expect(codes(rows[1]), kind).toEqual([]);
			} else {
				// A plain collection has no draft to hold the update: it goes live at once.
				expect(updated, kind).toMatchObject({ status: "published", scheduledAt: null });
				expect(updated.title, kind).toBe("Updated");
				expect(codes(rows[1]), kind).toEqual(["not_scheduled"]);
			}
		}
	});

	it("reschedules to a new time, and publishes at once for a time already passed", async () => {
		for (const [kind, collection] of KINDS) {
			await importCsv(csv([{ id: "T1", name: "Timed", price: 1 }]), scheduled(collection, at));
			const moved = await importCsv(
				csv([{ id: "T1", name: "Timed", price: 1 }]),
				scheduled(collection, later()),
			);
			expect(moved.rows[0], kind).toMatchObject({ status: "updated" });
			expect(fieldsOf(moved.rows[0]), kind).toEqual(["publishAt"]);
			const id = await entryId(collection, "T1");
			expect(await stateOf(collection, id), kind).toMatchObject({
				status: "scheduled",
				scheduledAt: later(),
			});
			const past = await importCsv(
				csv([{ id: "T2", name: "Past", price: 1 }]),
				scheduled(collection, "2020-01-01T00:00:00.000Z"),
			);
			expect(past.rows[0], kind).toMatchObject({ status: "created" });
			expect(await stateOf(collection, await entryId(collection, "T2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
			});
		}
	});

	it("rolls back scheduled entries before the time: deleted, or restored without the schedule", async () => {
		for (const [kind, collection] of KINDS) {
			const created = await entryId(collection, "B1");
			const done = await rollBack((jobs[`${kind}:B`] as Job).id);
			expect(done.job.counters, kind).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
			expect((await byKey(collection)).has("B1"), kind).toBe(false);
			expect(await sweep()).not.toContain(created);
			expect(await stateOf(collection, await entryId(collection, "B2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
				hasDraft: false,
				title: "Seeded",
				price: 1,
			});
		}
	});

	it("publishes them through the scheduler; a re-run is unchanged; a rollback still owns them", async () => {
		const due: [string, string][] = [];
		for (const [, collection] of KINDS) {
			for (const key of ["S1", "R1"]) due.push([collection, await entryId(collection, key)]);
		}
		await sweepUntil(at, due);
		for (const [kind, collection] of KINDS) {
			for (const key of ["S1", "S2", "R1", "R2"]) {
				expect(
					await stateOf(collection, await entryId(collection, key)),
					`${kind} ${key}`,
				).toMatchObject({ status: "published", scheduledAt: null, hasDraft: false, price: 2 });
			}
			const rerun = await importCsv(
				csv([
					{ id: "S1", name: "Created", price: 2 },
					{ id: "S2", name: "Updated", price: 2 },
				]),
				scheduled(collection, at),
			);
			expect(
				rerun.rows.map((r) => r.status),
				kind,
			).toEqual(["unchanged", "unchanged"]);
			const done = await rollBack((jobs[`${kind}:R`] as Job).id);
			expect(done.job.counters, kind).toMatchObject({ reverted: 2, conflict: 0, failed: 0 });
			expect((await byKey(collection)).has("R1"), kind).toBe(false);
			expect(await stateOf(collection, await entryId(collection, "R2")), kind).toMatchObject({
				status: "published",
				scheduledAt: null,
				hasDraft: false,
				title: "Seeded",
				price: 1,
			});
		}
	});
});

describe("M5b write modes on a translation job", () => {
	it("updates existing French translations and skips the keys without one", async () => {
		const n = translationNames("it_rr_i18n");
		await createTranslationSchema(client, n);
		await importCsv(
			englishCsv([
				["E1", "Desk", "D-1", 10],
				["E2", "Lamp", "L-1", 5],
			]),
			englishTemplate(n),
		);
		const french = translationTemplate(n, "fr");
		await importCsv(translationCsv([{ id: "F1", enId: "E1", name: "Bureau" }]), french);
		const { rows } = await importCsv(
			translationCsv([
				{ id: "F1", enId: "E1", name: "Grand bureau" },
				{ id: "F2", enId: "E2", name: "Lampe" },
			]),
			{ ...french, rules: { mode: "update" } },
		);
		expect(rows.map((r) => [r.status, codes(r)])).toEqual([
			["updated", []],
			["unchanged", ["not_found"]],
		]);
		expect((await listLocale(client, n.products, "fr")).map((e) => e.data.title)).toEqual([
			"Grand bureau",
		]);
	});
});

describe("M5b kill and resume of a scheduling job", () => {
	it("schedules each entry once, and reports any it left unscheduled, when a crash cuts the job off mid-batch", async () => {
		await client.createProducts("it_rr_crash");
		const rowsCount = 300;
		const publishAt = new Date(Date.now() + 3_600_000).toISOString();
		const { uploadId } = await client.upload(productsCsv(rowsCount));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: { ...template("it_rr_crash"), publishAt: { expr: `'${publishAt}'` } },
			dryRun: false,
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
		const done = await client.runToEnd(created.id);
		expect(done.status).toBe("completed");
		expect(await client.records(created.id, "writing")).toEqual([]);
		const entries = await client.listAll("it_rr_crash");
		expect(entries).toHaveLength(rowsCount);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(rowsCount);
		// A kill between the create and the save of its revision leaves a draft the repair cannot
		// prove is the job's: it is reported schedule_unverified and left unscheduled (spec M5b
		// "Crash repair", as publish_unverified in crash.test.ts). Every other entry is scheduled
		// once, at the job's time.
		const conflicts = await client.records(created.id, "conflict");
		expect(conflicts.every((r) => r.errors?.[0]?.code === "schedule_unverified")).toBe(true);
		const unverified = new Set(conflicts.map((r) => r.entryId));
		expect(unverified.size).toBe(conflicts.length);
		expect(done.counters).toMatchObject({
			created: rowsCount - unverified.size,
			conflict: unverified.size,
			failed: 0,
		});
		const unscheduled = entries.filter(
			(e) => e.status !== "scheduled" || (e as { scheduledAt?: string }).scheduledAt !== publishAt,
		);
		expect(unscheduled.every((e) => e.status === "draft")).toBe(true);
		expect(new Set(unscheduled.map((e) => e.id))).toEqual(unverified);
		console.info(`entries left unscheduled and reported schedule_unverified: ${unverified.size}`);
	});
});
