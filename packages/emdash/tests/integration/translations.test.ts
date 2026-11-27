import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { BLUE_PNG, RED_PNG } from "../fixtures/media.js";
import {
	createTranslationByline,
	createTranslationSchema,
	englishCsv,
	englishTemplate,
	listLocale,
	type TranslationRow,
	translationCsv,
	translationNames,
	translationsOf,
	translationTemplate,
	withBylines,
} from "../fixtures/translations.js";
import { Client, devBypass, type Product } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4392;
const n = translationNames("it_m4e");

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	feeds.feeds.set("/desk.png", { body: RED_PNG, contentType: "image/png" });
	feeds.feeds.set("/lampe.png", { body: BLUE_PNG, contentType: "image/png" });
	// Its own server: photos are fetched from 127.0.0.1 (allowPrivateNetwork).
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await createTranslationSchema(client, n);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

async function importCsv(
	csv: string,
	template: object,
	opts: { dryRun?: boolean; publish?: boolean } = {},
): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: 10,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

const french = translationTemplate(n, "fr");
const german = translationTemplate(n, "de");
const frCsv = (rows: TranslationRow[]) => translationCsv(rows);

async function get(id: string, locale: string) {
	return client.api<{
		item: Product & { translationGroup: string; locale: string; updatedAt: string };
		_rev: string;
	}>("GET", `/_emdash/api/content/${n.products}/${id}?locale=${locale}`);
}

const bySource = async (locale: string) =>
	new Map((await listLocale(client, n.products, locale)).map((e) => [e.slug, e]));

const english = new Map<string, Product>();
const photoUrl = (path: string) => feeds.url(path);
const requestsFor = (path: string) => feeds.requests.filter((r) => r.path === path).length;

describe("M4e translations end to end", () => {
	it("imports French translations into the English groups, with the English shared values", async () => {
		const en = await importCsv(
			englishCsv(
				[
					["E1", "Desk", "S1", 100],
					["E2", "Lamp", "S2", 20],
				],
				photoUrl("/desk.png"),
			),
			englishTemplate(n),
		);
		expect(en.job.counters).toMatchObject({ created: 2, failed: 0 });
		for (const e of await listLocale(client, n.products, "en")) {
			english.set(e.data.flux_source_id as string, e);
		}
		const csv = frCsv([
			{ id: "F1", enId: "E1", name: "Bureau", photo: photoUrl("/desk.png") },
			{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
		]);
		const fr = await importCsv(csv, french);
		expect(fr.job.template.translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(fr.job.warnings).toEqual([
			`Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price"; reference field "related"; taxonomy "${n.tag}"`,
		]);
		expect(fr.job.counters).toMatchObject({ created: 2, failed: 0 });
		expect(fr.rows[0]?.changes).toContainEqual({
			field: "translationOf",
			before: null,
			after: "en: E1",
		});
		const desk = english.get("E1") as Product;
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect(bureau.data).toMatchObject({
			title: "Bureau",
			sku: "S1",
			price: 100,
			flux_source_id: "E1",
		});
		expect(await translationsOf(client, n.products, desk.id)).toEqual({
			group: desk.id,
			locales: { en: desk.id, fr: bureau.id },
		});
		expect(await client.entryTerms(n.products, bureau.id, n.tag)).toEqual(["new"]);
		// The photo is translatable: the French entry has its own value, the same library item for
		// the shared URL, downloaded once.
		expect((bureau.data.photo as { id: string }).id).toBe((desk.data.photo as { id: string }).id);
		expect(requestsFor("/desk.png")).toBe(1);
		expect(requestsFor("/lampe.png")).toBe(1);
		const lampe = (await bySource("fr")).get("lampe") as Product;
		// The selection is the group's, read in the entry's locale (spec M4e F4).
		const related = (await get(lampe.id, "fr")).item.references?.related?.children ?? [];
		expect(related.map((c) => c.translationGroup)).toEqual([desk.id]);

		const again = await importCsv(csv, french);
		expect(again.job.counters).toMatchObject({ unchanged: 2 });
		expect(requestsFor("/desk.png") + requestsFor("/lampe.png")).toBe(2);
	});

	it("syncs a new English price into the French entry, which then re-runs unchanged", async () => {
		const frRevBefore = (await get(((await bySource("fr")).get("bureau") as Product).id, "fr"))
			._rev;
		const en = await importCsv(
			englishCsv(
				[
					["E1", "Desk", "S1", 120],
					["E2", "Lamp", "S2", 20],
				],
				photoUrl("/desk.png"),
			),
			englishTemplate(n),
		);
		expect(en.job.counters).toMatchObject({ updated: 1, unchanged: 1 });
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect(bureau.data.price).toBe(120);
		// Fact V4: the source's update moves the translation's revision.
		expect((await get(bureau.id, "fr"))._rev).not.toBe(frRevBefore);
		const fr = await importCsv(
			frCsv([
				{ id: "F1", enId: "E1", name: "Bureau", photo: photoUrl("/desk.png") },
				{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
			]),
			french,
		);
		expect(fr.job.counters).toMatchObject({ unchanged: 2 });
	});

	it("fails rows whose source does not exist, and creates them on retry after the English job", async () => {
		const csv = frCsv([{ id: "F3", enId: "E3", name: "Chaise" }]);
		const first = await importCsv(csv, french);
		expect(first.rows[0]).toMatchObject({
			status: "failed",
			errors: [
				{
					field: "translationOf",
					code: "translation_source_not_found",
					message: `No entry in "${n.products}" (en) was imported with the key "E3"`,
				},
			],
		});
		await importCsv(englishCsv([["E3", "Chair", "S3", 30]]), englishTemplate(n));
		await client.plugin("jobs/retry", { id: first.job.id });
		const retried = await client.runToEnd(first.job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const chaise = (await bySource("fr")).get("chaise") as Product;
		expect(chaise.data).toMatchObject({ sku: "S3", price: 30 });
		const chair = (await bySource("en")).get("chair") as Product;
		expect(await translationsOf(client, n.products, chaise.id)).toEqual({
			group: chair.id,
			locales: { en: chair.id, fr: chaise.id },
		});
	});

	it("plans a German dry run with the translationOf change and writes nothing", async () => {
		const { job, rows } = await importCsv(
			frCsv([{ id: "D1", enId: "E1", name: "Schreibtisch" }]),
			german,
			{ dryRun: true },
		);
		expect(job.counters).toMatchObject({ created: 1 });
		expect(rows[0]).toMatchObject({ status: "planned", action: "create" });
		expect(rows[0]?.changes).toContainEqual({
			field: "translationOf",
			before: null,
			after: "en: E1",
		});
		expect(await listLocale(client, n.products, "de")).toEqual([]);
	});

	it("links German entries to the same groups, and refuses a group an editor already translated", async () => {
		const lamp = english.get("E2") as Product;
		const editor = await client.api<{ item: { id: string } }>(
			"POST",
			`/_emdash/api/content/${n.products}`,
			{
				data: { title: "Lampe (Redaktion)" },
				locale: "de",
				translationOf: lamp.id,
			},
		);
		const { job, rows } = await importCsv(
			frCsv([
				{ id: "D1", enId: "E1", name: "Schreibtisch" },
				{ id: "D2", enId: "E2", name: "Lampe" },
			]),
			german,
		);
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		expect(rows[1]).toMatchObject({
			status: "failed",
			errors: [
				{
					code: "translation_exists",
					message: `The source entry already has a translation in de (entry ${editor.item.id}), which is not this record's entry`,
				},
			],
		});
		const desk = english.get("E1") as Product;
		const { locales } = await translationsOf(client, n.products, desk.id);
		expect(Object.keys(locales).sort()).toEqual(["de", "en", "fr"]);
	});

	it("imports a row without a value as an entry of its own, and refuses to unlink a translation", async () => {
		const own = await importCsv(
			frCsv([
				{ id: "F4", enId: "", name: "Tabouret", sku: "S4", price: "40", related: "", tags: "" },
			]),
			french,
		);
		expect(own.job.counters).toMatchObject({ created: 1, failed: 0 });
		const tabouret = (await bySource("fr")).get("tabouret") as Product;
		expect(tabouret.data).toMatchObject({ sku: "S4", price: 40, flux_source_id: "F4" });
		expect((await translationsOf(client, n.products, tabouret.id)).group).toBe(tabouret.id);

		const unlinked = await importCsv(
			frCsv([{ id: "F1", enId: "", name: "Bureau", sku: "S9", price: "9", related: "", tags: "" }]),
			french,
		);
		expect(unlinked.rows[0]).toMatchObject({
			status: "failed",
			errors: [{ code: "translation_of_missing" }],
		});
		expect(((await bySource("fr")).get("bureau") as Product).data.price).toBe(120);
	});

	it("stages a French draft with publish: false and publishes it later, leaving the English entry alone", async () => {
		const desk = english.get("E1") as Product;
		const before = await get(desk.id, "en");
		const csv = frCsv([
			{ id: "F1", enId: "E1", name: "Grand bureau", photo: photoUrl("/desk.png") },
		]);
		const draft = await importCsv(csv, french, { publish: false });
		expect(draft.rows[0]).toMatchObject({ status: "updated" });
		const bureau = (await bySource("fr")).get("bureau") as Product;
		expect((await get(bureau.id, "fr")).item.draftRevisionId).not.toBeNull();
		const published = await importCsv(csv, french);
		expect(published.rows[0]).toMatchObject({ status: "updated" });
		const after = await get(desk.id, "en");
		expect(after._rev).toBe(before._rev);
		expect(after.item.updatedAt).toBe(before.item.updatedAt);
		expect(after.item.draftRevisionId).toBeNull();
		expect((await get(bureau.id, "fr")).item).toMatchObject({
			status: "published",
			draftRevisionId: null,
			data: { title: "Grand bureau", price: 120 },
		});
	});

	it("repairs a linked create whose link was never saved, and creates no second entry", async () => {
		// The failing second row keeps the job's file for jobs/retry.
		const first = await importCsv(
			frCsv([
				{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") },
				{ id: "F9", enId: "E9", name: "Rien" },
			]),
			french,
		);
		expect(first.rows.map((r) => r.status)).toEqual(["unchanged", "failed"]);
		// As a crash would leave it: the row still writing, the link not saved.
		const lampe = (await bySource("fr")).get("lampe") as Product;
		withDb(server.dbPath, (db) => {
			db.prepare(
				"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
			).run("fluximporter", "links", `${n.products}:fr:F2`);
			const moved = db
				.prepare(
					"UPDATE _plugin_storage SET data = json_set(data, '$.status', 'writing', '$.entryId', null, '$.action', 'create') WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.jobId') = ? AND json_extract(data, '$.sourceKey') = ?",
				)
				.run("fluximporter", "records", first.job.id, "F2");
			expect(moved.changes).toBe(1);
		});
		await client.plugin("jobs/retry", { id: first.job.id });
		const repaired = await client.runToEnd(first.job.id);
		expect(repaired.counters).toMatchObject({ created: 1, failed: 1, conflict: 0 });
		const rows = await client.records(first.job.id);
		expect(rows[0]).toMatchObject({ status: "created", entryId: lampe.id });
		// The link row was written again, naming the entry the create made.
		const link = withDb(server.dbPath, (db) =>
			db
				.prepare(
					"SELECT json_extract(data, '$.entryId') AS entryId FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
				)
				.get("fluximporter", "links", `${n.products}:fr:F2`),
		);
		expect(link).toMatchObject({ entryId: lampe.id });
		const rerun = await importCsv(
			frCsv([{ id: "F2", enId: "E2", name: "Lampe", photo: photoUrl("/lampe.png") }]),
			french,
		);
		expect(rerun.job.counters).toMatchObject({ unchanged: 1 });
		const lamp = english.get("E2") as Product;
		expect((await translationsOf(client, n.products, lamp.id)).locales.fr).toBe(lampe.id);
		expect(
			(await listLocale(client, n.products, "fr")).filter((e) => e.data.flux_source_id === "E2"),
		).toHaveLength(1);
	});

	it("sends the bylines of a translation, so an empty value leaves it without credits", async () => {
		await createTranslationByline(client, "it-m4e-kim");
		const en = await importCsv(
			englishCsv([["B1", "Kettle", "SB", 15]], "", "it-m4e-kim"),
			withBylines(englishTemplate(n)),
		);
		expect(en.job.counters).toMatchObject({ created: 1, failed: 0 });
		const kettle = (await bySource("en")).get("kettle") as Product;
		const credits = async (id: string, locale: string) =>
			((await get(id, locale)).item.bylines ?? []).map((b) => b.byline.slug);
		expect(await credits(kettle.id, "en")).toEqual(["it-m4e-kim"]);

		const csv = translationCsv([{ id: "FB1", enId: "B1", name: "Bouilloire", authors: "" }], {
			bylines: true,
		});
		const fr = await importCsv(csv, withBylines(french));
		expect(fr.job.counters).toMatchObject({ created: 1, failed: 0 });
		const bouilloire = (await bySource("fr")).get("bouilloire") as Product;
		// Not the source's credit: the empty value is sent as no bylines.
		expect(await credits(bouilloire.id, "fr")).toEqual([]);
		expect(await credits(kettle.id, "en")).toEqual(["it-m4e-kim"]);

		const again = await importCsv(csv, withBylines(french));
		expect(again.job.counters).toMatchObject({ unchanged: 1 });
	});
});
