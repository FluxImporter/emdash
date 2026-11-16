/**
 * M6a on Node (spec "Testing", integration): saved templates through the plugin routes on SQLite,
 * jobs and URL sources from them, export and import, and the jobs index. Its own server on the
 * M5a-M5c suites' port (they run one at a time), with private-network feeds allowed.
 */
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { TemplateFile } from "../../src/plugin/template-files.js";
import {
	type SavedResult,
	TEMPLATE_MAX_BYTES,
	type TemplateSummary,
} from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { ApiError, Client, devBypass } from "./client.js";
import { expireLock, giveLockToSecondUser, withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
const PLUGIN = "/_emdash/api/plugins/flux-import";
const feeds = new FeedServer();
let server: DevServer;
let client: Client;

type Skipped = { skipped: "unchanged"; sourceId: string; uploadId: string };
type Envelope = {
	success: boolean;
	error?: { code: string; message: string; details?: Record<string, unknown> };
};
const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);
const owned = (collection: string, missing?: object, owner = "shop") => ({
	...template(collection),
	rules: { owner, ...(missing ? { missing } : {}) },
});

/** A plugin route's status and envelope, for what `Client.plugin`'s ApiError drops. */
async function send(route: string, body: unknown, init: RequestInit = {}) {
	const res = await client.raw("POST", `${PLUGIN}/${route}`, body, init);
	return { status: res.status, body: (await res.json()) as Envelope };
}

async function save(name: string, body: object): Promise<SavedResult> {
	return client.plugin<SavedResult>("templates/create", { name, template: body });
}

async function importById(templateId: string, csv: string, extra: object = {}): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin<Job>("jobs/create", {
		uploadId,
		templateId,
		dryRun: false,
		...extra,
	});
	return client.runToEnd(job.id);
}

beforeAll(async () => {
	await feeds.start();
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}, 180_000);

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

describe("M6a saved templates on Node", () => {
	it("creates, reads, lists, updates and deletes a template with revisions", async () => {
		await client.createProducts("it_m6a_crud");
		const created = await save("Nightly feed", template("it_m6a_crud"));
		expect(created.check).toEqual({ problems: [], warnings: [] });
		expect(created.template).toMatchObject({
			revision: 1,
			collection: "it_m6a_crud",
			locale: "en",
			format: "csv",
		});
		const { id } = created.template;
		expect(await client.plugin("templates/get", { id })).toEqual(created.template);
		const listed = await client.plugin<{ items: TemplateSummary[] }>("templates/list", {
			collection: "it_m6a_crud",
		});
		expect(listed.items.map((i) => i.id)).toEqual([id]);
		expect(listed.items[0]).not.toHaveProperty("template");
		const updated = await client.plugin<SavedResult>("templates/update", {
			id,
			revision: 1,
			description: "Every night",
		});
		expect(updated.template).toMatchObject({ revision: 2, description: "Every night" });
		const stale = await failure(
			client.plugin("templates/update", { id, revision: 1, name: "Other" }),
		);
		expect(stale).toBeInstanceOf(ApiError);
		expect(stale).toMatchObject({ status: 409, code: "TEMPLATE_CHANGED" });
		expect(await failure(save("Nightly feed", template("it_m6a_crud")))).toMatchObject({
			status: 409,
			code: "NAME_TAKEN",
		});
		expect(await client.plugin("templates/delete", { id, revision: 2 })).toEqual({
			deleted: true,
		});
		expect(await failure(client.plugin("templates/get", { id }))).toMatchObject({
			status: 404,
			code: "NOT_FOUND",
		});
	});

	it("saves a template for a collection that does not exist yet, and reports it", async () => {
		const { check } = await save("Later", template("it_m6a_later"));
		expect(check.problems).toEqual(['Collection "it_m6a_later" does not exist']);
		await client.createProducts("it_m6a_later");
		const { items } = await client.plugin<{ items: TemplateSummary[] }>("templates/list", {
			collection: "it_m6a_later",
		});
		const again = await client.plugin<SavedResult>("templates/update", {
			id: items[0]!.id,
			revision: 1,
			description: "now",
		});
		expect(again.check.problems).toEqual([]);
	});

	it("follows a template from save through schema/apply, a paused job, export, import, delete, retry and rollback (spec Testing)", async () => {
		const C = "it_m6a_flow";
		await client.createCollection(C);
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "released", label: "Released", type: "datetime" },
		]) {
			await client.api("POST", `/_emdash/api/schema/collections/${C}/fields`, field);
		}
		const t = owned(C, { action: "unpublish" }, "flow");
		const created = await save("Flow feed", t);
		expect(created.check.problems).toEqual([`Field "price" does not exist in collection "${C}"`]);
		const { id } = created.template;
		const applied = await client.plugin<ApplyResult>("schema/apply", { templateId: id });
		expect(applied).toMatchObject({ error: null, applied: ["price"] });
		const updated = await client.plugin<SavedResult>("templates/update", {
			id,
			revision: 1,
			description: "Nightly",
		});
		expect(updated).toMatchObject({ template: { revision: 2 }, check: { problems: [] } });

		// SKU-5 already exists, from an inline job, and a second user holds its edit lock: the
		// template's job records it locked, so the retry below has a row to write.
		const side = await client.upload(
			"sku,Name,Price,Released,Handle\r\nSKU-5,Side,1,01/03/2026,product-5\r\n",
		);
		const sideJob = await client.plugin<Job>("jobs/create", {
			uploadId: side.uploadId,
			template: template(C),
			dryRun: false,
		});
		expect(await client.runToEnd(sideJob.id)).toMatchObject({ counters: { created: 1 } });
		const held = (await client.listAll(C)).find((e) => e.slug === "product-5")!;
		await client.api("POST", `/_emdash/api/content/${C}/${held.id}/lock`, {});
		giveLockToSecondUser(server.dbPath, C, held.id);

		// 10 rows in batches of 5: one batch, pause, a new revision that maps the title elsewhere, resume.
		const { uploadId } = await client.upload(productsCsv(10));
		const job = await client.plugin<Job>("jobs/create", {
			uploadId,
			templateId: id,
			dryRun: false,
			batchSize: 5,
		});
		expect(job).toMatchObject({ templateId: id, templateRevision: 2 });
		await client.plugin("jobs/next", { id: job.id });
		await client.plugin("jobs/pause", { id: job.id });
		const remapped = { ...t, fields: { ...t.fields, title: { from: "Handle", type: "text" } } };
		await client.plugin("templates/update", { id, revision: 2, template: remapped });
		await client.plugin("jobs/resume", { id: job.id });
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			templateRevision: 2,
			counters: { created: 9, locked: 1, failed: 0 },
		});
		const byKey = async () =>
			new Map((await client.listAll(C)).map((e) => [String(e.slug), String(e.data.title)]));
		const resumed = await byKey();
		expect(resumed.size).toBe(10);
		expect(resumed.get("product-5")).toBe("Side");
		for (const [slug, title] of resumed) {
			if (slug !== "product-5") expect(title, slug).toMatch(/^Product \d/);
		}
		expect(await failure(importById(id, productsCsv(10), { templateRevision: 2 }))).toMatchObject({
			status: 409,
			code: "TEMPLATE_CHANGED",
		});

		// Export, then import under another name: the original's job owns entries, so rules.missing
		// is refused until the copy gets its own owner.
		const out = await client.plugin<{ filename: string; file: TemplateFile }>("templates/export", {
			id,
		});
		expect(out.filename).toBe("flux-import-template-flow-feed.json");
		expect(JSON.stringify(out.file)).not.toContain(id);
		// The saved-template case: the original still uses owner "flow".
		expect(await send("templates/import", { file: out.file, name: "Flow copy" })).toMatchObject({
			status: 409,
			body: { error: { code: "OWNER_IN_USE", details: { owner: "flow", templates: [id] } } },
		});
		const copy = await client.plugin<SavedResult>("templates/import", {
			file: out.file,
			name: "Flow copy",
			owner: "flow-copy",
		});
		expect(copy.template).toMatchObject({ owner: "flow-copy", revision: 1 });
		const dryUpload = await client.upload(productsCsv(10));
		const dry = await client.plugin<Job>("jobs/create", {
			uploadId: dryUpload.uploadId,
			templateId: copy.template.id,
			dryRun: true,
		});
		expect(await client.runToEnd(dry.id)).toMatchObject({ status: "completed", dryRun: true });

		// Delete the original: its jobs keep its ID, a new job is refused, and the job still
		// retries and rolls back from its snapshot of revision 2.
		expect(await client.plugin("templates/delete", { id, revision: 3 })).toEqual({
			deleted: true,
		});
		expect(await failure(importById(id, productsCsv(10)))).toMatchObject({
			status: 404,
			code: "TEMPLATE_NOT_FOUND",
		});
		// The links case on its own: no saved template uses "flow" now, but the job's entries do.
		const linksOnly = await send("templates/import", { file: out.file, name: "Flow again" });
		expect(linksOnly).toMatchObject({
			status: 409,
			body: {
				error: {
					code: "OWNER_IN_USE",
					details: { owner: "flow", templates: [], links: true },
				},
			},
		});
		expect(linksOnly.body.error?.message).toContain(`${C}/en (existing entries)`);
		expireLock(server.dbPath, C, held.id);
		await client.plugin("jobs/retry", { id: job.id });
		const retried = await client.runToEnd(job.id);
		expect(retried).toMatchObject({
			status: "completed",
			templateId: id,
			templateRevision: 2,
			counters: { created: 9, updated: 1, locked: 0, failed: 0 },
		});
		// Revision 2 maps Name to the title; revision 3 would have written the handle.
		expect((await byKey()).get("product-5")).toBe('Product 5, "quoted"');
		const rollback = await client.plugin<Job>("jobs/rollback", { id: job.id });
		expect(await client.runToEnd(rollback.id)).toMatchObject({
			status: "completed",
			templateId: id,
			templateRevision: 2,
			counters: { reverted: 10 },
		});
		const left = await byKey();
		expect([...left.keys()]).toEqual(["product-5"]);
		expect(left.get("product-5")).toBe("Side");
		const listed = await client.plugin<{ items: Job[] }>("jobs/list", { templateId: id });
		expect(listed.items.map((j) => j.id)).toEqual([rollback.id, job.id]);
	});

	it("applies the schema from a saved template, and imports a near-cap template on SQLite (V1)", async () => {
		await client.createCollection("it_m6a_big");
		const big = paddedTemplate("it_m6a_big", TEMPLATE_MAX_BYTES);
		const { template: row } = await save("Big", big);
		const applied = await client.plugin<ApplyResult>("schema/apply", { templateId: row.id });
		expect(applied.error).toBeNull();
		expect(applied.applied).toEqual(["title", "stage_a", "stage_b"]);
		const job = await importById(row.id, "sku,Name,Stage\nA1,Desk,live\nA2,Chair,live\n");
		expect(job).toMatchObject({ status: "completed", counters: { created: 2, failed: 0 } });
		expect(
			await failure(save("Bigger", paddedTemplate("it_m6a_big", TEMPLATE_MAX_BYTES + 1))),
		).toMatchObject({ status: 413, code: "TEMPLATE_TOO_LARGE" });
	});

	it("skips unchanged URL content only for the same template and revision (spec Ruling 29)", async () => {
		await client.createProducts("it_m6a_url");
		feeds.feeds.set("/m6a.csv", { body: productsCsv(4), etag: true });
		const source = await client.plugin<SourceRow>("sources/create", {
			name: "M6a feed",
			url: feeds.url("/m6a.csv"),
		});
		const a = await save("Feed A", template("it_m6a_url"));
		const b = await save("Feed B", {
			...template("it_m6a_url"),
			fields: { title: { from: "Name", type: "text" } },
		});
		const run = (body: object) =>
			client.plugin<Job | Skipped>("jobs/create", { sourceId: source.id, dryRun: false, ...body });
		const ran = async (body: object) => {
			const job = await run(body);
			expect(job).not.toHaveProperty("skipped");
			if (!("skipped" in job)) await client.runToEnd(job.id);
		};
		const skipped = async (body: object) =>
			expect(await run(body)).toMatchObject({ skipped: "unchanged" });
		await ran({ templateId: a.template.id });
		await skipped({ templateId: a.template.id });
		// A dry run is never skipped, and does not move lastImport: the real run is still skipped.
		await ran({ templateId: a.template.id, dryRun: true });
		await skipped({ templateId: a.template.id });
		// Another template on the same unchanged content is not skipped; then it is.
		await ran({ templateId: b.template.id });
		await skipped({ templateId: b.template.id });
		// A again is not skipped, since lastImport now names B.
		await ran({ templateId: a.template.id });
		// The same template, edited (revision 2): not skipped once, then skipped again.
		await client.plugin("templates/update", {
			id: b.template.id,
			revision: 1,
			description: "edited",
		});
		await ran({ templateId: b.template.id });
		await skipped({ templateId: b.template.id });
		// An inline template's fingerprint is not a saved template's reference; the same object
		// again is skipped.
		await ran({ template: template("it_m6a_url") });
		await skipped({ template: template("it_m6a_url") });
	});

	it("answers 400 to templates/delete without a revision, 413 over 2 MiB and 400 to bad JSON, over HTTP", async () => {
		const { template: row } = await save("Http", template("it_m6a_http"));
		expect(await send("templates/delete", { id: row.id })).toMatchObject({
			status: 400,
			body: { success: false, error: { code: "VALIDATION_ERROR" } },
		});
		expect(await client.plugin("templates/get", { id: row.id })).toMatchObject({ revision: 1 });
		const huge = { name: "Huge", template: { pad: "x".repeat(2 * 1024 * 1024) } };
		expect(await send("templates/create", huge)).toMatchObject({
			status: 413,
			body: { success: false, error: { code: "INVALID_PLUGIN_REQUEST" } },
		});
		const malformed = { body: "{not json", headers: { "Content-Type": "application/json" } };
		expect(await send("templates/create", undefined, malformed)).toMatchObject({
			status: 400,
			body: { success: false, error: { code: "INVALID_PLUGIN_REQUEST" } },
		});
	});

	it("creates the jobs templateId index at the next scheduler tick (V2)", async () => {
		const res = await fetch(`${server.baseUrl}/test/run-scheduled`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		expect(res.status).toBe(200);
		const names = withDb(server.dbPath, (db) =>
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ? ORDER BY name",
				)
				.all("idx_plugin_flux-import_%")
				.map((r) => (r as { name: string }).name),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"idx_plugin_flux-import_jobs_templateId_createdAt",
				"idx_plugin_flux-import_templates_name",
				"idx_plugin_flux-import_templates_collection",
				"idx_plugin_flux-import_templates_owner",
			]),
		);
	});
});
