import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	createTranslationSchema,
	ENGLISH_HEADER,
	englishCsv,
	englishTemplate,
	listLocale,
	translationCsv,
	translationNames,
	translationsOf,
	translationTemplate,
} from "../fixtures/translations.js";
import { Client, devBypass, type Product } from "./client.js";
import { withDb } from "./db.js";
import { type DevServer, freePort, startServer, stopServer } from "./server.js";

/**
 * Astro locales with a path and codes (EmDash 1.3.1, #4224): `sites/dev` with `FLUX_DEV_I18N=paths`
 * configures `{ path: "en", codes: ["en-US"] }`, `{ path: "fr", codes: ["fr-FR", "fr-CA"] }` and
 * `"de"`. EmDash writes new rows under the path, and reads rows stamped with a code (written
 * before the site moved to this form) as rows of the code's locale, under their own IDs.
 */

const n = translationNames("it_paths");

let server: DevServer;
let client: Client;

beforeAll(async () => {
	server = await startServer(await freePort(), undefined, undefined, false, undefined, {
		FLUX_DEV_I18N: "paths",
	});
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await createTranslationSchema(client, n);
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

async function importCsv(csv: string, template: object): Promise<{ job: Job; rows: RecordRow[] }> {
	const { uploadId } = await client.upload(csv);
	const created = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: false,
		batchSize: 10,
	});
	const job = await client.runToEnd(created.id);
	return { job, rows: await client.records(job.id) };
}

/** Stamps an entry with a locale code, as a row written before the site moved to `{ path, codes }`. */
function stamp(id: string, locale: string): void {
	withDb(server.dbPath, (db) => {
		const moved = db
			.prepare(`UPDATE "ec_${n.products}" SET locale = ? WHERE id = ?`)
			.run(locale, id);
		if (moved.changes !== 1) throw new Error(`No entry ${id} in ec_${n.products}`);
	});
}

function storedLocale(id: string): string {
	return withDb(server.dbPath, (db) => {
		const row = db.prepare(`SELECT locale FROM "ec_${n.products}" WHERE id = ?`).get(id) as
			| { locale: string }
			| undefined;
		if (!row) throw new Error(`No entry ${id} in ec_${n.products}`);
		return row.locale;
	});
}

const ENGLISH = englishCsv([
	["E1", "Desk", "S1", 100],
	["E2", "Lamp", "S2", 20],
]);
const FRENCH = translationCsv([
	{ id: "F1", enId: "E1", name: "Bureau" },
	{ id: "F2", enId: "E2", name: "Lampe" },
]);
const english = { ...englishTemplate(n), locale: "en-US" };
const french = {
	...translationTemplate(n, "fr"),
	locale: "fr-CA",
	translationOf: { from: "en_id", locale: "en-US" },
};
const ids = (entries: Product[]) => entries.map((e) => e.id).sort();
const bySourceId = (entries: Product[]) =>
	new Map(entries.map((e) => [e.data.flux_source_id as string, e]));

describe("locales with a path and codes", () => {
	it("imports into a locale named by a code, under the locale's path", async () => {
		const { job } = await importCsv(ENGLISH, english);
		expect(job.template.locale).toBe("en");
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		const entries = await listLocale(client, n.products, "en");
		expect(entries).toHaveLength(2);
		for (const e of entries) expect(storedLocale(e.id)).toBe("en");
		// The code reads the same rows.
		expect((await listLocale(client, n.products, "en-US")).map((e) => e.id).sort()).toEqual(
			entries.map((e) => e.id).sort(),
		);
	});

	it("links translations whose locales are codes", async () => {
		const { job } = await importCsv(FRENCH, french);
		expect(job.template.locale).toBe("fr");
		expect(job.template.translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(job.counters).toMatchObject({ created: 2, failed: 0 });
		const en = bySourceId(await listLocale(client, n.products, "en"));
		const fr = bySourceId(await listLocale(client, n.products, "fr"));
		const desk = en.get("E1") as Product;
		const bureau = fr.get("E1") as Product;
		expect(storedLocale(bureau.id)).toBe("fr");
		expect(bureau.data).toMatchObject({ title: "Bureau", sku: "S1", price: 100 });
		expect(await translationsOf(client, n.products, desk.id)).toEqual({
			group: desk.id,
			locales: { en: desk.id, fr: bureau.id },
		});
	});

	it("refuses translationOf.locale given as a code of the job's own locale", async () => {
		const { uploadId } = await client.upload(FRENCH);
		const template = { ...french, translationOf: { from: "en_id", locale: "fr-FR" } };
		const res = await client.raw("POST", "/_emdash/api/plugins/fluximporter/jobs/create", {
			uploadId,
			template,
			dryRun: false,
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain(
			'translationOf.locale must differ from locale (\\"fr\\")',
		);
	});

	it("keeps code-stamped rows: re-runs find them by link, under their IDs", async () => {
		const en = await listLocale(client, n.products, "en");
		const fr = await listLocale(client, n.products, "fr");
		for (const e of en) stamp(e.id, "en-US");
		for (const e of fr) stamp(e.id, "fr-CA");
		const enRun = await importCsv(ENGLISH, { ...english, locale: "en" });
		expect(enRun.job.counters).toMatchObject({ unchanged: 2, created: 0, failed: 0 });
		// The French entries are still the translations in their groups (no translation_exists).
		const frRun = await importCsv(FRENCH, { ...french, locale: "fr" });
		expect(frRun.job.counters).toMatchObject({ unchanged: 2, created: 0, failed: 0 });
		expect(ids(await listLocale(client, n.products, "en"))).toEqual(ids(en));
		expect(ids(await listLocale(client, n.products, "fr"))).toEqual(ids(fr));
		for (const e of en) expect(storedLocale(e.id)).toBe("en-US");
	});

	it("finds a code-stamped entry the importer never wrote by its source ID", async () => {
		const made = await client.api<{ item: Product }>("POST", `/_emdash/api/content/${n.products}`, {
			locale: "en",
			data: { title: "Chair", sku: "S3", price: 30, flux_source_id: "E3" },
		});
		const chair = made.item.id;
		stamp(chair, "en-US");

		// A translation source, found by the source ID (no link names it).
		const chaise = translationCsv([{ id: "F3", enId: "E3", name: "Chaise" }]);
		const linked = await importCsv(chaise, french);
		expect(linked.job.counters).toMatchObject({ created: 1, failed: 0 });
		const chaiseEntry = bySourceId(await listLocale(client, n.products, "fr")).get("E3") as Product;
		expect(chaiseEntry.data).toMatchObject({ title: "Chaise", sku: "S3", price: 30 });
		expect(await translationsOf(client, n.products, chair)).toEqual({
			group: chair,
			locales: { "en-US": chair, fr: chaiseEntry.id },
		});
		const again = await importCsv(chaise, french);
		expect(again.job.counters).toMatchObject({ unchanged: 1, failed: 0 });

		// A `match: "key"` reference, found the same way.
		const stool = await importCsv(`${ENGLISH_HEADER}\nE4,stool,Stool,S4,40,,E3,new\n`, english);
		expect(stool.job.counters).toMatchObject({ created: 1, failed: 0 });
		const stoolId = stool.rows[0]?.entryId as string;
		const got = await client.api<{ item: Product }>(
			"GET",
			`/_emdash/api/content/${n.products}/${stoolId}?locale=en`,
		);
		expect(got.item.references?.related?.children.map((c) => c.translationGroup)).toEqual([chair]);
		expect(storedLocale(chair)).toBe("en-US");
	});
});
