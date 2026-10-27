import { beforeAll, describe, expect, inject, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	createLinkSchema,
	linkNames,
	PEOPLE_CSV,
	POSTS_CSV,
	POSTS_JSON,
	peopleTemplate,
	postsStored,
	postsTemplate,
} from "../fixtures/links.js";
import { Client, type Product } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));
const n = linkNames("it");

async function importText(
	body: string,
	template: object,
	opts: { filename?: string; dryRun?: boolean; publish?: boolean } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(body, opts.filename ?? "data.csv");
	const job = await client.plugin("jobs/create", {
		uploadId,
		template,
		dryRun: opts.dryRun ?? false,
		...(opts.publish === undefined ? {} : { publish: opts.publish }),
		batchSize: 10,
	});
	return client.runToEnd(job.id);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

const entry = async (collection: string, id: string) =>
	(await client.api<{ item: Product }>("GET", `/_emdash/api/content/${collection}/${id}?locale=en`))
		.item;

/** An entry's links as keys and slugs: terms, bylines, and reference targets by import key. */
async function linksOf(id: string, keysById: Map<string, string>) {
	const item = await entry(n.posts, id);
	const keys = (field: string) =>
		(item.references?.[field]?.children ?? []).map((c) => keysById.get(c.id) ?? c.id);
	return {
		category: await client.entryTerms(n.posts, id, n.category),
		tag: await client.entryTerms(n.posts, id, n.tag),
		bylines: (item.bylines ?? []).filter((b) => b.source === "explicit").map((b) => b.byline.slug),
		author: keys("author")[0],
		related: keys("related"),
	};
}

async function keysById(): Promise<Map<string, string>> {
	const all = [...(await client.listAll(n.people)), ...(await client.listAll(n.posts))];
	return new Map(all.map((e) => [e.id, e.data.flux_source_id as string]));
}

describe("M4b links end to end", () => {
	beforeAll(async () => {
		await createLinkSchema(client, n);
		const people = await importText(PEOPLE_CSV, peopleTemplate(n));
		expect(people.counters).toMatchObject({ created: 2, failed: 0 });
	});

	it("reports missing terms, entries and bylines in a dry run, and the terms it would create", async () => {
		const csv = [
			"id,Title,Author,Related,Categories,Tags,Authors",
			"D1,Dry one,A1,,Electronics > Phones,new,Alex Doe",
			"D2,Dry two,A9,no-such-post,Garden,old,Nobody",
			"",
		].join("\n");
		const job = await importText(csv, postsTemplate(n), { dryRun: true });
		expect(job.counters).toMatchObject({ created: 1, failed: 1 });
		const rows = await client.records(job.id);
		expect(rows[0]).toMatchObject({
			status: "planned",
			newTerms: [`${n.category}: Electronics`, `${n.category}: Electronics > Phones`],
		});
		expect(rows[1]?.errors?.map((e) => [e.field, e.code])).toEqual([
			["author", "reference_not_found"],
			["related", "reference_not_found"],
			[`taxonomies.${n.tag}`, "term_not_found"],
			["bylines", "byline_not_found"],
		]);
		expect(await client.listAll(n.posts)).toEqual([]);
		const terms = await client.api<{ terms: unknown[] }>(
			"GET",
			`/_emdash/api/taxonomies/${n.category}/terms?locale=en`,
		);
		expect(terms.terms).toEqual([]);
	});

	it("builds the category tree, links every post, and re-runs as unchanged", async () => {
		const job = await importText(POSTS_CSV, postsTemplate(n));
		expect(job.counters).toMatchObject({ created: 3, failed: 0 });
		const rows: RecordRow[] = await client.records(job.id);
		expect(rows.map((r) => r.newTerms)).toEqual([
			[`${n.category}: Electronics`, `${n.category}: Electronics > Phones`],
			[`${n.category}: Garden`],
			[`${n.category}: Electronics > Laptops`],
		]);
		const keys = await keysById();
		const posts = await byKey(n.posts);
		for (const [key, expected] of Object.entries(postsStored(n))) {
			const post = posts.get(key);
			expect(post?.status, key).toBe("published");
			expect(await linksOf(post!.id, keys), key).toEqual(expected);
		}
		const again = await importText(POSTS_CSV, postsTemplate(n));
		expect(again.counters).toMatchObject({ unchanged: 3, created: 0, updated: 0, failed: 0 });
	});

	it("imports JSON arrays and re-runs them as unchanged", async () => {
		const template = postsTemplate(n, "json");
		const job = await importText(POSTS_JSON, template, { filename: "posts.json" });
		expect(job.counters).toMatchObject({ created: 1, failed: 0 });
		const j1 = (await byKey(n.posts)).get("J1")!;
		expect(await linksOf(j1.id, await keysById())).toEqual({
			category: ["phones", "garden"],
			tag: ["sale"],
			bylines: [n.sam],
			author: "A2",
			related: ["P1", "P2"],
		});
		const again = await importText(POSTS_JSON, template, { filename: "posts.json" });
		expect(again.counters).toMatchObject({ unchanged: 1 });
	});

	it("fails a key reference to an entry not imported yet, and imports it on retry", async () => {
		const csv = "id,Title,Author,Related,Categories,Tags,Authors\nF1,Forward,A3,,,,\n";
		const job = await importText(csv, postsTemplate(n));
		expect(job.counters).toMatchObject({ failed: 1 });
		expect((await client.records(job.id))[0]?.errors?.[0]).toMatchObject({
			field: "author",
			code: "reference_not_found",
		});
		await importText("id,Name\nA3,Ari\n", peopleTemplate(n));
		await client.plugin("jobs/retry", { id: job.id });
		const retried = await client.runToEnd(job.id);
		expect(retried.counters).toMatchObject({ created: 1, failed: 0 });
		const f1 = (await byKey(n.posts)).get("F1")!;
		expect((await linksOf(f1.id, await keysById())).author).toBe("A3");
	});

	it("with publish: false writes terms and bylines live and stages references", async () => {
		const changed = POSTS_CSV.replace(
			"P1,Desk review,A1,,Electronics > Phones,new|sale,Alex Doe",
			"P1,Desk review,A2,lamp-review,Electronics > Phones,sale,Sam Lee",
		);
		const job = await importText(changed, postsTemplate(n), { publish: false });
		expect(job.counters).toMatchObject({ updated: 1, unchanged: 2 });
		const [row] = (await client.records(job.id)).filter((r) => r.status === "updated");
		expect(row?.changes?.map((c) => c.field)).toEqual([
			"author",
			"related",
			`taxonomies.${n.tag}`,
			"bylines",
		]);
		const p1 = (await byKey(n.posts)).get("P1")!;
		const item = await entry(n.posts, p1.id);
		// References are staged in a draft; terms and bylines are live metadata in EmDash.
		expect(item.draftRevisionId).not.toBeNull();
		expect(await linksOf(p1.id, await keysById())).toMatchObject({
			tag: ["sale"],
			bylines: [n.sam],
			author: "A2",
			related: ["P2"],
		});
		const rerun = await importText(changed, postsTemplate(n), { publish: false });
		expect(rerun.counters).toMatchObject({ unchanged: 3 });
		// A publishing run publishes the draft this importer staged.
		const publish = await importText(changed, postsTemplate(n));
		expect(publish.counters).toMatchObject({ updated: 1, unchanged: 2 });
		expect((await entry(n.posts, p1.id)).draftRevisionId).toBeNull();
	});

	it("clears a taxonomy given no value, sending only that link", async () => {
		const cleared = POSTS_CSV.replace(
			"P2,Lamp review,A2,desk-review,Garden,new,Sam Lee;Alex Doe",
			"P2,Lamp review,A2,desk-review,Garden,,Sam Lee;Alex Doe",
		);
		const job = await importText(cleared, postsTemplate(n));
		// P1 goes back to its first values; P2 loses its tags.
		const row = (await client.records(job.id)).find((r) => r.sourceKey === "P2");
		expect(row).toMatchObject({ status: "updated" });
		expect(row?.changes).toEqual([{ field: `taxonomies.${n.tag}`, before: ["new"], after: null }]);
		const p2 = (await byKey(n.posts)).get("P2")!;
		expect(await client.entryTerms(n.posts, p2.id, n.tag)).toEqual([]);
		expect(p2.status).toBe("published");
		const again = await importText(cleared, postsTemplate(n));
		expect(again.counters).toMatchObject({ unchanged: 3, updated: 0 });
	});
});
