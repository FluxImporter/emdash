import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmDashUploads, uploadKey } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import { setCredential } from "../../src/plugin/credentials.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	createSource,
	deleteSource,
	fetchSource,
	getSource,
	jobFromSource,
	latestSourceUploads,
	listSources,
	type SourceDeps,
	type SourceRow,
	updateSource,
} from "../../src/plugin/sources.js";
import { FakeStorage, MemoryKv, MemorySettings } from "./fakes.js";

const FEED = "https://feeds.example.com/products.csv";
const BODY = "sku,Name\nA,One\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Handler = (headers: Headers) => Response;

function setup(opts: { allowPrivateNetwork?: boolean } = {}) {
	const clock = { t: Date.parse("2026-10-26T09:00:00Z") };
	let next = 0;
	const routes = new Map<string, Handler>();
	const sent: Array<{ url: string; headers: Record<string, string> }> = [];
	const storage = new FakeStorage();
	const deps: SourceDeps = {
		sources: new MemoryKv<SourceRow>(),
		jobs: new MemoryKv<Job>(),
		settings: new MemorySettings(),
		storage,
		net: {
			allowPrivateNetwork: opts.allowPrivateNetwork ?? false,
			resolver: async () => ["93.184.215.14"],
			fetch: async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				sent.push({ url, headers: Object.fromEntries(headers.entries()) });
				const handler = routes.get(url);
				return handler ? handler(headers) : new Response("missing", { status: 404 });
			},
		},
		limits: { maxBytes: 10_000, headersMs: 15_000, totalMs: 120_000, bufferBytes: 5_000 },
		workers: false,
		now: () => clock.t,
		newId: () => `S${++next}`,
	};
	const files = () => [...storage.files.keys()].sort();
	return { deps, routes, sent, clock, storage, files };
}

/** Serves `body` with an ETag and answers a matching If-None-Match with 304. */
function etagged(body: () => string): Handler {
	return (headers) => {
		const tag = `"${sha(body()).slice(0, 8)}"`;
		if (headers.get("if-none-match") === tag) return new Response(null, { status: 304 });
		return new Response(body(), { headers: { etag: tag } });
	};
}

function jobUsing(uploadId: string, status: Job["status"] = "running"): Job {
	return { id: `J-${uploadId.slice(0, 4)}`, uploadId, status, dryRun: false } as unknown as Job;
}

describe("source records", () => {
	it("creates a source with a normalised URL and timestamps", async () => {
		const { deps } = setup();
		const row = await createSource(deps, {
			name: "Supplier",
			url: "HTTPS://Feeds.Example.com/p.csv",
		});
		expect(row).toEqual({
			id: "S1",
			name: "Supplier",
			url: "https://feeds.example.com/p.csv",
			createdAt: "2026-10-26T09:00:00.000Z",
			updatedAt: "2026-10-26T09:00:00.000Z",
		});
		expect(await getSource(deps, "S1")).toEqual(row);
	});

	it("refuses a duplicate name, an unknown credential and a blocked URL", async () => {
		const { deps } = setup();
		await createSource(deps, { name: "Supplier", url: FEED });
		await expect(createSource(deps, { name: "Supplier", url: FEED })).rejects.toEqual(
			new ServiceError("CONFLICT", 'A source named "Supplier" already exists', 409),
		);
		await expect(createSource(deps, { name: "B", url: FEED, credential: "nope" })).rejects.toEqual(
			new ServiceError("NOT_FOUND", 'Credential "nope" not found', 404),
		);
		for (const url of ["http://localhost:8080/feed", "http://10.1.2.3/x", "ftp://example.com/x"]) {
			await expect(createSource(deps, { name: url, url })).rejects.toMatchObject({
				code: "URL_BLOCKED",
				status: 400,
			});
		}
		await expect(
			createSource(deps, { name: "u", url: "https://user:pw@example.com/" }),
		).rejects.toMatchObject({ code: "URL_BLOCKED" });
	});

	it("accepts private hosts when private networks are allowed, but not other schemes", async () => {
		const { deps } = setup({ allowPrivateNetwork: true });
		expect((await createSource(deps, { name: "local", url: "http://127.0.0.1:4500/f" })).url).toBe(
			"http://127.0.0.1:4500/f",
		);
		await expect(
			createSource(deps, { name: "f", url: "file:///etc/passwd" }),
		).rejects.toMatchObject({ code: "URL_BLOCKED" });
	});

	it("updates the name, URL and credential, clearing lastFetch only when URL or credential change", async () => {
		const { deps, routes, clock } = setup();
		routes.set(FEED, () => new Response(BODY));
		await setCredential(deps.settings, "supplier", { header: "X-Key", value: "k" });
		await createSource(deps, { name: "A", url: FEED });
		await createSource(deps, { name: "B", url: "https://b.example.com/" });
		await fetchSource(deps, "S1");
		clock.t += 1000;

		const renamed = await updateSource(deps, { id: "S1", name: "A2" });
		expect(renamed).toMatchObject({ name: "A2", url: FEED, updatedAt: "2026-10-26T09:00:01.000Z" });
		expect(renamed.lastFetch).toBeDefined();
		expect((await updateSource(deps, { id: "S1", url: FEED })).lastFetch).toBeDefined();
		await expect(updateSource(deps, { id: "S1", name: "B" })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(updateSource(deps, { id: "S1", credential: "nope" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const withCredential = await updateSource(deps, { id: "S1", credential: "supplier" });
		expect(withCredential.credential).toBe("supplier");
		expect(withCredential.lastFetch).toBeUndefined();

		await fetchSource(deps, "S1");
		const moved = await updateSource(deps, { id: "S1", url: "https://feeds.example.com/v2.csv" });
		expect(moved.lastFetch).toBeUndefined();
		const cleared = await updateSource(deps, { id: "S1", credential: null });
		expect(cleared).not.toHaveProperty("credential");
		await expect(updateSource(deps, { id: "nope" })).rejects.toMatchObject({
			code: "NOT_FOUND",
			status: 404,
		});
	});

	it("lists sources newest first, a page at a time", async () => {
		const { deps, clock } = setup();
		for (let i = 0; i < 52; i++) {
			clock.t += 1000;
			await createSource(deps, { name: `S${i}`, url: FEED });
		}
		const first = await listSources(deps);
		expect(first.items).toHaveLength(50);
		expect(first.items[0]?.name).toBe("S51");
		expect(first.hasMore).toBe(true);
		const second = await listSources(deps, first.cursor);
		expect(second.items.map((s) => s.name)).toEqual(["S1", "S0"]);
	});

	it("deletes a source with its latest staged file unless a job still reads it", async () => {
		const { deps, routes, files } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		await createSource(deps, { name: "B", url: FEED });
		const a = await fetchSource(deps, "S1");
		const b = await fetchSource(deps, "S2");
		await deps.jobs.put("J1", jobUsing(b.uploadId));

		expect(await deleteSource(deps, "S1")).toEqual({ deleted: true });
		expect(await deleteSource(deps, "S2")).toEqual({ deleted: true });
		expect(files()).toEqual([uploadKey(b.uploadId)]);
		expect(a.uploadId).not.toBe(b.uploadId);
		await expect(getSource(deps, "S1")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(deleteSource(deps, "S1")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("fetchSource", () => {
	it("stages the feed with the credential and saves lastFetch", async () => {
		const { deps, routes, sent, files } = setup();
		routes.set(FEED, () => new Response(BODY, { headers: { etag: '"1"' } }));
		await setCredential(deps.settings, "supplier", { header: "Authorization", value: "Bearer t" });
		await createSource(deps, { name: "A", url: FEED, credential: "supplier" });
		const result = await fetchSource(deps, "S1");
		expect(result).toEqual({
			changed: true,
			uploadId: expect.any(String),
			bytes: BODY.length,
			sha256: sha(BODY),
		});
		expect(sent[0]?.headers).toEqual({ authorization: "Bearer t" });
		expect((await getSource(deps, "S1")).lastFetch).toEqual({
			at: "2026-10-26T09:00:00.000Z",
			status: 200,
			etag: '"1"',
			sha256: sha(BODY),
			bytes: BODY.length,
			uploadId: result.uploadId,
		});
		expect(files()).toEqual([uploadKey(result.uploadId)]);
	});

	it("reports unchanged through a 304 and through the hash, reusing the staged file", async () => {
		const { deps, routes, sent, files } = setup();
		let body = BODY;
		routes.set(
			FEED,
			etagged(() => body),
		);
		routes.set("https://plain.example.com/f.csv", () => new Response(body));
		await createSource(deps, { name: "etag", url: FEED });
		await createSource(deps, { name: "plain", url: "https://plain.example.com/f.csv" });

		const first = await fetchSource(deps, "S1");
		const again = await fetchSource(deps, "S1");
		expect(again).toEqual({ ...first, changed: false });
		expect(sent[1]?.headers["if-none-match"]).toBeDefined();
		expect((await getSource(deps, "S1")).lastFetch?.status).toBe(304);

		const plain = await fetchSource(deps, "S2");
		expect(await fetchSource(deps, "S2")).toEqual({ ...plain, changed: false });
		expect(files()).toEqual([uploadKey(first.uploadId), uploadKey(plain.uploadId)].sort());

		body = `${BODY}B,Two\n`;
		const changed = await fetchSource(deps, "S1");
		expect(changed.changed).toBe(true);
		// The replaced file is deleted: no job reads it.
		expect(await new EmDashUploads(deps.storage).exists(first.uploadId)).toBe(false);
	});

	it("keeps the replaced file while a job still reads it", async () => {
		const { deps, routes } = setup();
		let body = BODY;
		routes.set(FEED, () => new Response(body));
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		await deps.jobs.put("J1", jobUsing(first.uploadId, "paused"));
		body = `${BODY}B,Two\n`;
		await fetchSource(deps, "S1");
		expect(await new EmDashUploads(deps.storage).exists(first.uploadId)).toBe(true);
	});

	it("with force fetches again and reports changed", async () => {
		const { deps, routes, sent } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		const forced = await fetchSource(deps, "S1", true);
		expect(sent[1]?.headers).toEqual({});
		expect(forced.changed).toBe(true);
		expect(forced.uploadId).not.toBe(first.uploadId);
	});

	it("saves a failure as lastError, keeps lastFetch, and clears the error on the next success", async () => {
		const { deps, routes, clock } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		routes.set(FEED, () => new Response("gone", { status: 404 }));
		clock.t += 60_000;
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("HTTP_ERROR", "The server answered HTTP 404", 502),
		);
		const failed = await getSource(deps, "S1");
		expect(failed.lastError).toEqual({
			at: "2026-10-26T09:01:00.000Z",
			code: "HTTP_ERROR",
			message: "The server answered HTTP 404",
		});
		expect(failed.lastFetch?.uploadId).toBe(first.uploadId);

		routes.set(FEED, () => new Response(BODY));
		await fetchSource(deps, "S1");
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastError");
	});

	it("fails with CREDENTIAL_MISSING once the named credential is deleted", async () => {
		const { deps, routes, sent } = setup();
		routes.set(FEED, () => new Response(BODY));
		await setCredential(deps.settings, "supplier", { header: "X-Key", value: "k" });
		await createSource(deps, { name: "A", url: FEED, credential: "supplier" });
		deps.settings = new MemorySettings();
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("CREDENTIAL_MISSING", 'Credential "supplier" does not exist', 409),
		);
		expect((await getSource(deps, "S1")).lastError?.code).toBe("CREDENTIAL_MISSING");
		expect(sent).toEqual([]);
	});

	it("maps each fetch failure to its code and status", async () => {
		const { deps, routes } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => new Response("x".repeat(10_001)));
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({ code: "TOO_LARGE", status: 413 });
		deps.net.resolver = async () => ["192.168.0.10"];
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({
			code: "URL_BLOCKED",
			status: 400,
		});
		deps.net.resolver = async () => {
			throw new Error("ENOTFOUND");
		};
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({
			code: "FETCH_FAILED",
			status: 502,
		});
		await expect(fetchSource(deps, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("does not resurrect a source deleted during the fetch, and drops the new file", async () => {
		const { deps, routes, files } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => {
			void deps.sources.delete("S1");
			return new Response(BODY);
		});
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("CONFLICT", "The source was deleted or reconfigured during the fetch", 409),
		);
		expect(await deps.sources.get("S1")).toBeNull();
		expect(files()).toEqual([]);
	});

	it("keeps a concurrent rename made during the fetch", async () => {
		const { deps, routes } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => {
			void updateSource(deps, { id: "S1", name: "Renamed" });
			return new Response(BODY);
		});
		await fetchSource(deps, "S1");
		expect(await getSource(deps, "S1")).toMatchObject({
			name: "Renamed",
			lastFetch: { sha256: sha(BODY) },
		});
	});
});

describe("jobFromSource", () => {
	const REAL = { force: false, dryRun: false };
	const DRY = { force: false, dryRun: true };

	function creator() {
		const created: string[] = [];
		let failNext = false;
		const create = async (uploadId: string) => {
			if (failNext) {
				failNext = false;
				throw new Error("invalid template");
			}
			created.push(uploadId);
			return { ...jobUsing(uploadId, "created"), id: `J${created.length}` };
		};
		return { created, create, failOnce: () => (failNext = true) };
	}

	it("skips a real run of content already imported, and forces one", async () => {
		const { deps, routes } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const { created, create } = creator();

		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J1" });
		expect((await getSource(deps, "S1")).lastImport).toEqual({
			sha256: sha(BODY),
			uploadId: created[0],
			jobId: "J1",
			at: "2026-10-26T09:00:00.000Z",
		});
		expect(await jobFromSource(deps, "S1", REAL, create)).toEqual({
			skipped: "unchanged",
			sourceId: "S1",
			uploadId: created[0],
		});
		const forced = await jobFromSource(deps, "S1", { force: true, dryRun: false }, create);
		expect(forced).toMatchObject({ id: "J2" });
		expect(created[1]).not.toBe(created[0]);
		expect((await getSource(deps, "S1")).lastImport?.jobId).toBe("J2");
	});

	it("never skips a dry run, and a dry run does not count as an import", async () => {
		const { deps, routes } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const { created, create } = creator();

		expect(await jobFromSource(deps, "S1", DRY, create)).toMatchObject({ id: "J1" });
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastImport");
		// The fetch answers 304 now, yet the first real run is created without force.
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J2" });
		expect(await jobFromSource(deps, "S1", DRY, create)).toMatchObject({ id: "J3" });
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ skipped: "unchanged" });
		expect(created).toHaveLength(3);
	});

	it("records nothing when job creation fails, so the retry creates the job", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { create, failOnce } = creator();
		failOnce();
		await expect(jobFromSource(deps, "S1", REAL, create)).rejects.toThrow("invalid template");
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastImport");
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J1" });
	});

	it("forgets the last import when the URL changes", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		routes.set("https://mirror.example.com/p.csv", () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { create } = creator();
		await jobFromSource(deps, "S1", REAL, create);
		expect((await updateSource(deps, { id: "S1", name: "B" })).lastImport).toBeDefined();
		const moved = await updateSource(deps, { id: "S1", url: "https://mirror.example.com/p.csv" });
		expect(moved).not.toHaveProperty("lastImport");
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J2" });
	});
});

describe("latestSourceUploads", () => {
	it("lists the latest staged file of every source that has one", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		for (let i = 0; i < 3; i++) await createSource(deps, { name: `S${i}`, url: FEED });
		const a = await fetchSource(deps, "S1");
		const b = await fetchSource(deps, "S3");
		expect(await latestSourceUploads(deps.sources)).toEqual(new Set([a.uploadId, b.uploadId]));
	});
});
