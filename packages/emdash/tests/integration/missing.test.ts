/**
 * M5c on Node (spec "Testing", integration): the missing phase through the plugin routes, against
 * EmDash's own trash, restore and unpublish, and its rollback. Its own server: the kill-and-resume
 * test stops it.
 */
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
import { ApiError, Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

// The M5a rollback suite's port: suites run one at a time, and this one kills its own server.
const PORT = 4391;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

const owned = (collection: string, missing?: object, owner = "shop") => ({
	...template(collection),
	rules: { owner, ...(missing ? { missing } : {}) },
});

async function importCsv(
	body: string,
	jobTemplate: object,
	opts: {
		dryRun?: boolean;
		publish?: boolean;
		missing?: object | false;
		batchSize?: number;
		budgetMs?: number;
	} = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(body);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template: jobTemplate,
		dryRun: opts.dryRun ?? false,
		batchSize: opts.batchSize ?? 50,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		...(opts.missing === undefined ? {} : { missing: opts.missing }),
		...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const missingRows = (job: Job, rows: RecordRow[]) =>
	new Map(
		rows.filter((r) => r.seq >= (job.missing?.fromSeq ?? Infinity)).map((r) => [r.sourceKey, r]),
	);
const codes = (row: RecordRow | undefined) =>
	[...(row?.warnings ?? []), ...(row?.errors ?? [])].map((w) => w.code);

async function byKey(collection: string) {
	return new Map(
		(await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]),
	);
}

/** The IDs of the entries in Trash, as the admin's Trash view lists them (M5a's route). */
async function trashed(collection: string, locale = "en"): Promise<string[]> {
	const { items } = await client.api<{ items: { id: string }[] }>(
		"GET",
		`/_emdash/api/content/${collection}/trash?locale=${locale}&limit=100`,
	);
	return items.map((i) => i.id).sort();
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
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}, 180_000);

afterAll(async () => {
	await stopServer(server);
});

describe("M5c missing entries on Node", () => {
	it("unpublishes two missing entries, and republishes them when the feed has them again", async () => {
		await client.createProducts("it_m5c_unpub");
		const t = owned("it_m5c_unpub", { action: "unpublish" });
		await importCsv(productsCsv(20), t);
		const { job, rows } = await importCsv(productsCsv(18), t);
		expect(job.missing).toMatchObject({
			stage: "done",
			owned: 20,
			found: 2,
			removed: 2,
			verdict: "act",
		});
		expect(job.counters).toMatchObject({ unchanged: 18, removed: 2 });
		const entries = await byKey("it_m5c_unpub");
		for (const key of ["SKU-18", "SKU-19"]) {
			expect(missingRows(job, rows).get(key)?.status, key).toBe("removed");
			expect(entries.get(key)?.status, key).toBe("draft");
		}
		const back = await importCsv(productsCsv(20), t);
		expect(back.job.counters).toMatchObject({ failed: 0, conflict: 0 });
		const after = await byKey("it_m5c_unpub");
		expect([...after.values()].every((e) => e.status === "published")).toBe(true);
	});

	it("trashes a missing entry, refuses to recreate it, and a rollback restores and republishes it", async () => {
		await client.createProducts("it_m5c_trash");
		const t = owned("it_m5c_trash", { action: "trash" });
		await importCsv(productsCsv(8), t);
		const before = (await byKey("it_m5c_trash")).get("SKU-7");
		const { job } = await importCsv(productsCsv(7), t);
		expect(job.counters.removed).toBe(1);
		expect(await trashed("it_m5c_trash")).toEqual([before?.id]);
		// The feed has it again: the record is refused with missing_trashed, not a SLUG_CONFLICT.
		const again = await importCsv(productsCsv(8), t, { missing: false });
		const row = again.rows.find((r) => r.sourceKey === "SKU-7");
		expect(row).toMatchObject({ status: "conflict" });
		expect(codes(row)).toEqual(["missing_trashed"]);
		const created = await client.plugin("jobs/rollback", { id: job.id, batchSize: 10 });
		const rolled = await client.runToEnd(created.id);
		expect(rolled.counters).toMatchObject({ reverted: 1, conflict: 0, failed: 0 });
		expect(await trashed("it_m5c_trash")).toEqual([]);
		const restored = (await byKey("it_m5c_trash")).get("SKU-7");
		expect(restored).toMatchObject({ status: "published", slug: before?.slug, data: before?.data });
		const rerun = await importCsv(productsCsv(8), t);
		expect(rerun.job.counters).toMatchObject({ unchanged: 8, failed: 0, conflict: 0 });
	});

	it("leaves an edited entry and one with a pending draft alone", async () => {
		await client.createProducts("it_m5c_edit");
		const t = owned("it_m5c_edit", { action: "trash", maxPercent: 50 });
		await importCsv(productsCsv(8), t);
		const entries = await byKey("it_m5c_edit");
		// As record-rules.test.ts edits: a PUT with the current _rev, then a publish of the draft.
		const put = async (key: string, title: string) => {
			const id = entries.get(key)?.id as string;
			const { _rev } = await client.getEntry("it_m5c_edit", id);
			return client.api<{ _rev: string }>(
				"PUT",
				`/_emdash/api/content/it_m5c_edit/${id}?locale=en`,
				{
					data: { title },
					_rev,
				},
			);
		};
		const saved = await put("SKU-6", "Edited");
		await client.api(
			"POST",
			`/_emdash/api/content/it_m5c_edit/${entries.get("SKU-6")?.id}/publish?locale=en`,
			{
				_rev: saved._rev,
			},
		);
		await put("SKU-7", "Draft only");
		const { job, rows } = await importCsv(productsCsv(6), t);
		const m = missingRows(job, rows);
		expect(codes(m.get("SKU-6"))).toEqual(["missing_edited"]);
		expect(codes(m.get("SKU-7"))).toEqual(["missing_edited"]);
		expect(await trashed("it_m5c_edit")).toEqual([]);
	});

	it("leaves the importer's own pending draft alone", async () => {
		await client.createProducts("it_m5c_pending");
		const t = owned("it_m5c_pending", { action: "trash", maxPercent: 50 });
		await importCsv(productsCsv(8), t);
		const sku6 = (await byKey("it_m5c_pending")).get("SKU-6");
		// A publish: false re-run stages the importer's own draft over SKU-7 (rev === writtenRev).
		const staged = await importCsv(
			productsCsv(8, (i) => (i === 7 ? "99.5" : `${i}.5`)),
			t,
			{
				publish: false,
				missing: false,
			},
		);
		expect(staged.job.counters).toMatchObject({ updated: 1, failed: 0, conflict: 0 });
		const { job, rows } = await importCsv(productsCsv(6), t);
		expect(codes(missingRows(job, rows).get("SKU-7"))).toEqual(["missing_pending"]);
		// SKU-6 is plain and goes to Trash; SKU-7, with the importer's pending draft, stays.
		expect(await trashed("it_m5c_pending")).toEqual([sku6?.id]);
	});

	it("refuses 10 of 20 missing, then applies them with the job option", async () => {
		await client.createProducts("it_m5c_limit");
		const t = owned("it_m5c_limit", { action: "unpublish" });
		await importCsv(productsCsv(20), t);
		const refused = await importCsv(productsCsv(10), t);
		expect(refused.job.status).toBe("completed");
		expect(refused.job.missing).toMatchObject({ found: 10, removed: 0, verdict: "refused" });
		expect(refused.job.warnings?.some((w) => w.includes("missing: { maxPercent: 50 }"))).toBe(true);
		expect([...(await byKey("it_m5c_limit")).values()].every((e) => e.status === "published")).toBe(
			true,
		);
		const dry = await importCsv(productsCsv(10), t, { dryRun: true, missing: { maxPercent: 50 } });
		expect(dry.job.counters.removed).toBe(10);
		expect(dry.job.missing).toMatchObject({ found: 10, verdict: "act" });
		// A dry run keeps no journal and saves no removed row: its missing rows are plans.
		expect(dry.job.journal).toBeFalsy();
		const dryRows = [...missingRows(dry.job, dry.rows).values()];
		expect(dryRows).toHaveLength(10);
		expect(dryRows.every((r) => r.status === "planned")).toBe(true);
		expect(dry.rows.filter((r) => r.status === "removed")).toEqual([]);
		expect([...(await byKey("it_m5c_limit")).values()].every((e) => e.status === "published")).toBe(
			true,
		);
		const applied = await importCsv(productsCsv(10), t, { missing: { maxPercent: 50 } });
		expect(applied.job.missing).toMatchObject({ removed: 10, verdict: "act" });
	});

	it("skips the phase when a record has no key, and a second owner takes the stamp off", async () => {
		await client.createProducts("it_m5c_skip");
		const t = owned("it_m5c_skip", { action: "trash", maxPercent: 50 });
		await importCsv(productsCsv(4), t);
		const noKey = productsCsv(3).concat(`,"No key",1,01/03/2026,no-key\r\n`);
		const skipped = await importCsv(noKey, t);
		expect(skipped.job.missing).toMatchObject({ verdict: "skipped" });
		expect(await trashed("it_m5c_skip")).toEqual([]);
		// Another owner's record reaches SKU-3: neither owner counts it from now on (Ruling 21).
		const onlyThree =
			"sku,Name,Price,Released,Handle\r\n" +
			`SKU-3,"Product 3, ""quoted""",3.5,04/03/2026,product-3\r\n`;
		await importCsv(onlyThree, owned("it_m5c_skip", undefined, "other"));
		const after = await importCsv(productsCsv(3), t);
		expect(after.job.missing).toMatchObject({ owned: 3, found: 0 });
		expect(await trashed("it_m5c_skip")).toEqual([]);
	});

	it("trashes a French translation alone, and leaves an English root with an active translation", async () => {
		const n = translationNames("it_m5c_i18n");
		await createTranslationSchema(client, n);
		const english = { ...englishTemplate(n), rules: { owner: "shop-en" } };
		const french = { ...translationTemplate(n, "fr"), rules: { owner: "shop-fr" } };
		const trash = { action: "trash", maxPercent: 50 };
		await importCsv(
			englishCsv([
				["E1", "Desk", "D-1", 10],
				["E2", "Lamp", "L-1", 5],
			]),
			english,
		);
		const frenchRows = [
			{ id: "F1", enId: "E1", name: "Bureau" },
			{ id: "F2", enId: "E2", name: "Lampe" },
		];
		await importCsv(translationCsv(frenchRows), french);
		const lampBefore = (await listLocale(client, n.products, "en")).find(
			(e) => e.data.title === "Lamp",
		);
		const lampe = (await listLocale(client, n.products, "fr")).find(
			(e) => e.data.title === "Lampe",
		);
		expect(lampe).toBeDefined();
		// F2 is missing from the French feed: it goes to Trash, and its English source stays (Fact V7).
		const fr = await importCsv(translationCsv(frenchRows.slice(0, 1)), {
			...french,
			rules: { owner: "shop-fr", missing: trash },
		});
		expect(fr.job.missing).toMatchObject({ verdict: "act", removed: 1 });
		expect(fr.job.counters.removed).toBe(1);
		expect(await trashed(n.products, "fr")).toEqual([lampe?.id]);
		expect((await listLocale(client, n.products, "fr")).map((e) => e.data.title)).toEqual([
			"Bureau",
		]);
		const lamp = (await listLocale(client, n.products, "en")).find((e) => e.data.title === "Lamp");
		expect(lamp).toMatchObject({ status: "published", data: lampBefore?.data });
		// E1 is missing from the English feed, but F1 still translates it.
		const en = await importCsv(englishCsv([["E2", "Lamp", "L-1", 5]]), {
			...english,
			rules: { owner: "shop-en", missing: trash },
		});
		expect(codes(missingRows(en.job, en.rows).get("E1"))).toEqual(["missing_has_translations"]);
		expect(await trashed(n.products)).toEqual([]);
	});

	it("survives a kill mid-act: every missing entry is unpublished once", async () => {
		const TOTAL = 500;
		const FED = 200;
		const MISSING = TOTAL - FED;
		await client.createProducts("it_m5c_crash");
		const t = owned("it_m5c_crash", { action: "unpublish", maxPercent: 70 });
		await importCsv(productsCsv(TOTAL), t, { batchSize: 100 });
		const { uploadId } = await client.upload(productsCsv(FED));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: t,
			dryRun: false,
			batchSize: 100,
			budgetMs: 2_000,
		});
		let job = await client.plugin("jobs/next", { id: created.id });
		while (job.missing?.stage !== "act") job = await client.plugin("jobs/next", { id: created.id });
		// Only a dropped connection counts as the kill's doing; an API error is a real failure.
		const inFlight = client.plugin("jobs/next", { id: created.id }).catch((e: unknown) => {
			if (e instanceof ApiError) throw e;
			return null;
		});
		// Kill once the act stage has a row in flight or some, but not all, entries removed.
		let seen = "";
		for (let i = 0; i < 200 && seen === ""; i++) {
			await sleep(20);
			const writing = (await client.records(created.id, "writing")).length;
			const removed = (await client.records(created.id, "removed")).length;
			if (writing > 0) seen = `writing ${writing}`;
			else if (removed > 0 && removed < MISSING) seen = `removed ${removed}`;
		}
		await stopServer(server, "SIGKILL");
		expect(seen, "the kill must land mid-act").not.toBe("");
		expect(await inFlight, "the kill must cut off the jobs/next call").toBeNull();
		console.info(`killed mid-act with ${seen} of ${MISSING}`);
		await restart();
		await waitForLease(created.id);
		const done = await client.runToEnd(created.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { unchanged: FED, removed: MISSING, failed: 0, conflict: 0 },
			missing: { stage: "done", removed: MISSING },
		});
		expect(await client.records(created.id, "writing")).toEqual([]);
		// Once each: as many missing rows as keys, every one removed, none unverified.
		const rows = [...missingRows(done, await client.records(created.id)).values()];
		const all = (await client.records(created.id)).filter(
			(r) => r.seq >= (done.missing?.fromSeq ?? Infinity),
		);
		expect(all).toHaveLength(MISSING);
		expect(new Set(all.map((r) => r.sourceKey)).size).toBe(MISSING);
		expect(rows.every((r) => r.status === "removed" && codes(r).length === 0)).toBe(true);
		const entries = [...(await byKey("it_m5c_crash")).values()];
		expect(entries.filter((e) => e.status === "draft")).toHaveLength(MISSING);
		expect(entries.filter((e) => e.status === "published")).toHaveLength(FED);
	}, 300_000);
});
