import { readdir, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4395;
const TOKEN = "Bearer feed-token-7f3a";

type Skipped = { skipped: "unchanged"; sourceId: string; uploadId: string };

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: URL sources here fetch from 127.0.0.1, which needs allowPrivateNetwork.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_url");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

const createJob = (sourceId: string, extra: Record<string, unknown> = {}) =>
	client.plugin<Job | Skipped>("jobs/create", {
		sourceId,
		template: template("it_url"),
		dryRun: false,
		...extra,
	});

async function runJob(sourceId: string): Promise<Job> {
	const job = await createJob(sourceId);
	if ("skipped" in job) throw new Error(`Expected a job, got ${JSON.stringify(job)}`);
	return client.runToEnd(job.id);
}

const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

const stagedFilesFor = async (uploadId: string) =>
	(await readdir(server.uploadsDir).catch(() => [] as string[])).filter(
		(f) => f.startsWith(UPLOAD_PREFIX) && f.includes(uploadId),
	);

describe("URL sources on Node", () => {
	let bearer: SourceRow;
	let plain: SourceRow;

	it("imports a feed through a bearer credential that no route returns", async () => {
		feeds.feeds.set("/bearer.csv", { body: productsCsv(5), etag: true, authorization: TOKEN });
		expect(
			await client.plugin("credentials/set", {
				name: "feed-token",
				header: "Authorization",
				value: TOKEN,
			}),
		).toEqual({ name: "feed-token", header: "Authorization" });
		const listed = await client.plugin("credentials/list", {});
		expect(listed).toEqual([{ name: "feed-token", header: "Authorization" }]);
		// EmDash stored the setting as an AES-GCM envelope, not as the JSON text.
		const raw = withDb(server.dbPath, (db) =>
			db
				.prepare("SELECT value FROM options WHERE name = ?")
				.get("plugin:flux-import:settings:credentials"),
		) as { value: string };
		expect(JSON.parse(raw.value)).toMatchObject({ $emdash: "plugin-setting", v: 1 });
		expect(raw.value).not.toContain("feed-token-7f3a");

		bearer = await client.plugin<SourceRow>("sources/create", {
			name: "Bearer feed",
			url: feeds.url("/bearer.csv"),
			credential: "feed-token",
		});
		expect(JSON.stringify(bearer)).not.toContain("feed-token-7f3a");
		const done = await runJob(bearer.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 5, failed: 0 } });
		expect(feeds.log("/bearer.csv").map((r) => [r.status, r.headers.authorization])).toEqual([
			[200, TOKEN],
		]);
		const stored = await client.plugin<SourceRow>("sources/get", { id: bearer.id });
		expect(stored.lastFetch).toMatchObject({ status: 200, uploadId: done.uploadId });
		expect(JSON.stringify(stored)).not.toContain("feed-token-7f3a");
	});

	it("skips a re-run when the server answers 304, keeping the staged file", async () => {
		const first = await client.plugin<SourceRow>("sources/get", { id: bearer.id });
		expect(await createJob(bearer.id)).toEqual({
			skipped: "unchanged",
			sourceId: bearer.id,
			uploadId: first.lastFetch?.uploadId,
		});
		const second = feeds.log("/bearer.csv")[1];
		expect(second?.status).toBe(304);
		expect(second?.headers["if-none-match"]).toMatch(/^"[0-9a-f]{16}"$/);
		expect(
			(await client.plugin<SourceRow>("sources/get", { id: bearer.id })).lastFetch,
		).toMatchObject({ status: 304, uploadId: first.lastFetch?.uploadId });
	});

	it("skips a re-run when a server without validators sends the same body", async () => {
		feeds.feeds.set("/plain.csv", { body: productsCsv(5) });
		plain = await client.plugin<SourceRow>("sources/create", {
			name: "Plain feed",
			url: feeds.url("/plain.csv"),
		});
		expect((await runJob(plain.id)).counters).toMatchObject({ unchanged: 5, created: 0 });
		const skipped = await createJob(plain.id);
		expect(skipped).toMatchObject({ skipped: "unchanged", sourceId: plain.id });
		expect(feeds.log("/plain.csv").map((r) => [r.status, r.headers["if-none-match"]])).toEqual([
			[200, undefined],
			[200, undefined],
		]);
	});

	it("creates a new job when the body changes, and with force when it does not", async () => {
		feeds.feeds.set("/plain.csv", { body: productsCsv(6) });
		expect((await runJob(plain.id)).counters).toMatchObject({ created: 1, unchanged: 5 });
		const forced = await createJob(plain.id, { force: true });
		expect(forced).toMatchObject({ status: "created" });
		// Finish it, so no job may still read the source's file when the source is deleted.
		await client.runToEnd((forced as Job).id);
	});

	it("never skips a dry run, and runs the real import after it without force", async () => {
		feeds.feeds.set("/dry.csv", { body: productsCsv(3), etag: true });
		const dry = await client.plugin<SourceRow>("sources/create", {
			name: "Dry-run feed",
			url: feeds.url("/dry.csv"),
		});
		const preview = await createJob(dry.id, { dryRun: true });
		expect(preview).toMatchObject({ status: "created", dryRun: true });
		await client.runToEnd((preview as Job).id);
		// The second fetch is a 304, but nothing from this feed has been imported yet.
		const real = await createJob(dry.id);
		expect(real).toMatchObject({ status: "created", dryRun: false });
		await client.runToEnd((real as Job).id);
		expect(await createJob(dry.id)).toMatchObject({ skipped: "unchanged", sourceId: dry.id });
		expect(feeds.log("/dry.csv").map((r) => r.status)).toEqual([200, 304, 304]);
	});

	it("fails with HTTP_ERROR for a 404 and saves it as the source's lastError", async () => {
		const missing = await client.plugin<SourceRow>("sources/create", {
			name: "Missing feed",
			url: feeds.url("/missing.csv"),
		});
		const error = await failure(client.plugin("sources/fetch", { id: missing.id }));
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 502, code: "HTTP_ERROR" });
		expect(
			(await client.plugin<SourceRow>("sources/get", { id: missing.id })).lastError,
		).toMatchObject({ code: "HTTP_ERROR", message: "The server answered HTTP 404" });
	});

	it("fails with CREDENTIAL_MISSING after the credential is deleted", async () => {
		expect(await client.plugin("credentials/delete", { name: "feed-token" })).toEqual({
			deleted: true,
		});
		const error = await failure(client.plugin("sources/fetch", { id: bearer.id }));
		expect(error).toMatchObject({ status: 409, code: "CREDENTIAL_MISSING" });
	});

	it("deletes a source and its latest staged file", async () => {
		const { lastFetch } = await client.plugin<SourceRow>("sources/get", { id: plain.id });
		const uploadId = lastFetch?.uploadId ?? "";
		expect(uploadId).not.toBe("");
		expect(await stagedFilesFor(uploadId)).toHaveLength(1);

		expect(await client.plugin("sources/delete", { id: plain.id })).toEqual({ deleted: true });
		const error = await failure(client.plugin("sources/get", { id: plain.id }));
		expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(await stagedFilesFor(uploadId)).toEqual([]);
	});
});

describe("URL sources without allowPrivateNetwork", () => {
	it("refuses a loopback URL with URL_BLOCKED", async () => {
		const shared = new Client(inject("baseUrl"), inject("token"));
		for (const url of [feeds.url("/plain.csv"), "http://localhost/feed.csv"]) {
			const error = await failure(shared.plugin("sources/create", { name: url, url }));
			expect(error).toMatchObject({ status: 400, code: "URL_BLOCKED" });
		}
	});
});
