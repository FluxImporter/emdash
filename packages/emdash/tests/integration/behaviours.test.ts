import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import { ApiError, Client } from "./client.js";
import { createUserToken, expireLock, giveLockToSecondUser } from "./db.js";
import { MALFORMED_CSV, productsCsv, template } from "./fixtures.js";
import { TEST_MAX_SOURCE_BYTES } from "./server.js";

const client = new Client(inject("baseUrl"), inject("token"));
const dbPath = inject("dbPath");

async function importCsv(
	collection: string,
	csv: string,
	options: { dryRun?: boolean; publish?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: template(collection),
		dryRun: options.dryRun ?? false,
		...(options.publish === undefined ? {} : { publish: options.publish }),
		batchSize: options.batchSize ?? 50,
	});
	return client.runToEnd(job.id);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

const staged = async () =>
	(await readdir(join(dbPath, "..", "uploads"))).filter((f) => f.startsWith(UPLOAD_PREFIX));

describe("dry run", () => {
	it("plans every row and writes nothing, not even the source-ID field", async () => {
		await client.createProducts("it_dry");
		const done = await importCsv("it_dry", productsCsv(10), { dryRun: true });
		expect(done).toMatchObject({ status: "completed", counters: { created: 10 } });
		const rows = await client.records(done.id);
		expect(rows.every((r) => r.status === "planned" && r.action === "create")).toBe(true);
		expect(rows[0]?.changes).toContainEqual({ field: "price", before: null, after: 0.5 });
		expect(await client.listAll("it_dry")).toEqual([]);
		expect(await client.fieldSlugs("it_dry")).not.toContain("flux_source_id");
	});
});

describe("publish option and re-runs", () => {
	it("leaves drafts with publish: false and publishes its own drafts on a publishing re-run", async () => {
		await client.createProducts("it_publish");
		const drafts = await importCsv("it_publish", productsCsv(5), { publish: false });
		expect(drafts.counters).toMatchObject({ created: 5 });
		for (const e of (await byKey("it_publish")).values()) {
			expect(e).toMatchObject({ status: "draft", liveRevisionId: null });
		}
		const published = await importCsv("it_publish", productsCsv(5));
		expect(published.counters).toMatchObject({ updated: 5, conflict: 0 });
		for (const e of (await byKey("it_publish")).values()) {
			expect(e).toMatchObject({ status: "published", draftRevisionId: null });
		}
	});

	it("reports every row unchanged when the same file is imported again", async () => {
		const before = await byKey("it_publish");
		const revs = new Map(
			await Promise.all(
				[...before.values()].map(
					async (e) => [e.id, (await client.getEntry("it_publish", e.id))._rev] as const,
				),
			),
		);
		const again = await importCsv("it_publish", productsCsv(5));
		expect(again.counters).toMatchObject({ unchanged: 5, updated: 0, created: 0 });
		for (const [id, rev] of revs) expect((await client.getEntry("it_publish", id))._rev).toBe(rev);
	});

	it("updates only the rows whose values changed", async () => {
		const changed = await importCsv(
			"it_publish",
			productsCsv(5, (i) => (i === 2 ? "99" : `${i}.5`)),
		);
		expect(changed.counters).toMatchObject({ updated: 1, unchanged: 4 });
		expect((await byKey("it_publish")).get("SKU-2")?.data.price).toBe(99);
	});
});

describe("malformed input", () => {
	it("logs bad rows, keeps the good ones, and fails the job at an unreadable tail", async () => {
		await client.createProducts("it_bad");
		const done = await importCsv("it_bad", MALFORMED_CSV);
		expect(done).toMatchObject({
			status: "failed",
			error: { code: "csv_syntax" },
			counters: { created: 3, failed: 2 },
		});
		const failed = await client.records(done.id, "failed");
		expect(failed.map((r) => r.errors?.[0]?.code)).toEqual(["column_count", "invalid_number"]);
		// A reader error has no key, so the record number locates it; a row that fails after its
		// key keeps the key (M5c, Ruling 24).
		expect(failed.map((r) => [r.seq, r.sourceKey])).toEqual([
			[2, null],
			[3, "M-4"],
		]);
		const created = await client.records(done.id, "created");
		expect(created.map((r) => [r.sourceKey, r.action])).toEqual([
			["M-1", "create"],
			["M-2", "create"],
			["M-5", "create"],
		]);
		expect([...(await byKey("it_bad")).keys()].sort()).toEqual(["M-1", "M-2", "M-5"]);
	});

	it("downloads the record log as CSV", async () => {
		const [job] = (await client.plugin<{ items: Job[] }>("jobs/list", { status: "failed" })).items;
		const res = await client.raw(
			"GET",
			`/_emdash/api/plugins/fluximporter/jobs/log.csv?id=${job!.id}&status=failed`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("content-disposition")).toContain(`fluximporter-${job!.id}.csv`);
		const lines = (await res.text()).trimEnd().split("\r\n");
		expect(lines[0]).toBe(
			"record,status,source_key,entry_id,action,error_code,error_field,message,warnings",
		);
		const cells = lines.slice(1).map((l) => l.split(","));
		expect(cells.map((c) => c[1])).toEqual(["failed", "failed"]);
		expect(cells.map((c) => [c[0], c[2]])).toEqual([
			["3", ""],
			["4", "M-4"],
		]);
		expect(cells.map((c) => c[5])).toEqual(["column_count", "invalid_number"]);
		expect(cells[1]?.[6]).toBe("price");
	});
});

describe("uploads", () => {
	it("rejects other file types, oversized bodies and anonymous callers, and stores nothing", async () => {
		const before = (await staged()).length;
		expect((await client.uploadRaw("a,b\n", "data.txt")).status).toBe(415);
		const big = new Uint8Array(TEST_MAX_SOURCE_BYTES + 1).fill(0x61);
		expect((await client.uploadRaw(big)).status).toBe(413);
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(100_000).fill(0x61));
				controller.close();
			},
		});
		const streamed = await fetch(
			`${client.baseUrl}/_emdash/api/fluximporter/uploads?filename=big.csv`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${client.token}` },
				body: chunked,
				duplex: "half",
			} as RequestInit,
		);
		expect(streamed.status).toBe(413);
		const anonymous = await fetch(
			`${client.baseUrl}/_emdash/api/fluximporter/uploads?filename=a.csv`,
			{
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
				body: "a\n",
			},
		);
		expect(anonymous.status).toBe(401);
		expect((await staged()).length).toBe(before);
	});

	it("refuses a user without import:execute and stores nothing", async () => {
		const before = (await staged()).length;
		const editor = new Client(client.baseUrl, createUserToken(dbPath, 40));
		const res = await editor.uploadRaw("a\n1\n");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
		expect((await staged()).length).toBe(before);
	});

	it("rejects an empty body, declared or streamed, and stores nothing", async () => {
		const before = (await staged()).length;
		const declared = await client.uploadRaw("");
		expect(declared.status).toBe(400);
		expect(await declared.json()).toMatchObject({ error: { code: "EMPTY_BODY" } });
		// No Content-Length: the route stages the stream, counts 0 bytes and deletes the file.
		const streamed = await fetch(
			`${client.baseUrl}/_emdash/api/fluximporter/uploads?filename=empty.csv`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${client.token}` },
				body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
				duplex: "half",
			} as RequestInit,
		);
		expect(streamed.status).toBe(400);
		expect(await streamed.json()).toMatchObject({ error: { code: "EMPTY_BODY" } });
		expect((await staged()).length).toBe(before);
	});
});

describe("concurrent drivers", () => {
	it("never processes the same batch twice when jobs/next is called in parallel", async () => {
		await client.createProducts("it_parallel");
		const { uploadId } = await client.upload(productsCsv(40));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_parallel"),
			dryRun: false,
			batchSize: 20,
		});
		const results = await Promise.all([
			client.plugin("jobs/next", { id: job.id }),
			client.plugin("jobs/next", { id: job.id }),
		]);
		expect(results.map((j) => j.cursor.seq).sort()).toEqual([0, 20]);
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 40 });
		expect((await client.listAll("it_parallel")).length).toBe(40);
	});
});

describe("editor drafts", () => {
	it("gives an editor's draft a new _rev and never overwrites or publishes it (pending_draft)", async () => {
		await client.createProducts("it_drafts");
		await importCsv("it_drafts", productsCsv(2));
		const entry = (await byKey("it_drafts")).get("SKU-0")!;
		const before = await client.getEntry("it_drafts", entry.id);
		await client.api("PUT", `/_emdash/api/content/it_drafts/${entry.id}`, {
			data: { title: "Editor title" },
			_rev: before._rev,
		});
		const drafted = await client.getEntry("it_drafts", entry.id);
		// The engine's pending_draft rule depends on this: an editor's draft is a new revision.
		expect(drafted._rev).not.toBe(before._rev);
		expect(drafted.item.draftRevisionId).not.toBeNull();

		const done = await importCsv(
			"it_drafts",
			productsCsv(2, () => "7"),
		);
		expect(done.counters).toMatchObject({ conflict: 1, updated: 1 });
		const [row] = (await client.records(done.id, "conflict")) ?? [];
		expect(row).toMatchObject({ sourceKey: "SKU-0", errors: [{ code: "pending_draft" }] });
		const after = await client.getEntry("it_drafts", entry.id);
		expect(after._rev).toBe(drafted._rev);
		expect(after.item.data).toMatchObject({ title: "Editor title", price: 0.5 });
	});
});

describe("edit locks", () => {
	it("skips an entry another user is editing and imports it once the lock expires", async () => {
		await client.createProducts("it_locks");
		await importCsv("it_locks", productsCsv(2));
		const entry = (await byKey("it_locks")).get("SKU-0")!;
		await client.api("POST", `/_emdash/api/content/it_locks/${entry.id}/lock`, {});

		// The importing user's own lock does not block the import.
		const own = await importCsv(
			"it_locks",
			productsCsv(2, () => "3"),
		);
		expect(own.counters).toMatchObject({ updated: 2, locked: 0 });

		giveLockToSecondUser(dbPath, "it_locks", entry.id);
		const blocked = await importCsv(
			"it_locks",
			productsCsv(2, () => "4"),
		);
		expect(blocked.counters).toMatchObject({ locked: 1, updated: 1 });
		const [row] = await client.records(blocked.id, "locked");
		expect(row).toMatchObject({ entryId: entry.id, errors: [{ code: "locked" }] });
		expect((await byKey("it_locks")).get("SKU-0")?.data.price).toBe(3);

		expireLock(dbPath, "it_locks", entry.id);
		await client.plugin("jobs/retry", { id: blocked.id });
		const retried = await client.runToEnd(blocked.id);
		expect(retried.counters).toMatchObject({ locked: 0, updated: 2 });
		expect((await byKey("it_locks")).get("SKU-0")?.data.price).toBe(4);
	});

	it("ignores another user's live lock once the collection turns edit locking off", async () => {
		const entry = (await byKey("it_locks")).get("SKU-0")!;
		// The previous test left an expired lease, so the importing user can take the lock again.
		await client.api("POST", `/_emdash/api/content/it_locks/${entry.id}/lock`, {});
		giveLockToSecondUser(dbPath, "it_locks", entry.id);
		await client.api("PUT", "/_emdash/api/schema/collections/it_locks", { editLocking: false });

		const done = await importCsv(
			"it_locks",
			productsCsv(2, () => "5"),
		);
		expect(done.counters).toMatchObject({ updated: 2, locked: 0 });
		expect((await byKey("it_locks")).get("SKU-0")?.data.price).toBe(5);
	});
});

describe("errors", () => {
	it("returns 404 for an unknown job and 409 for an invalid transition", async () => {
		await expect(client.plugin("jobs/get", { id: "NOPE" })).rejects.toMatchObject({
			status: 404,
			code: "NOT_FOUND",
		});
		const [job] = (await client.plugin<{ items: Job[] }>("jobs/list", { status: "completed" }))
			.items;
		await expect(client.plugin("jobs/pause", { id: job!.id })).rejects.toBeInstanceOf(ApiError);
		await expect(client.plugin("jobs/pause", { id: job!.id })).rejects.toMatchObject({
			status: 409,
		});
	});
});
