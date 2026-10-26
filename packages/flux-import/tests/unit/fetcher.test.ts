import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { uploadKey } from "../../src/emdash/uploads.js";
import {
	type DownloadInput,
	downloadSource,
	type FetcherDeps,
	type FetchLimits,
	type LastFetch,
} from "../../src/sources/fetcher.js";
import { UrlSourceError } from "../../src/sources/net.js";
import { FakeStorage, WrappingStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const URL_A = "https://feeds.example.com/products.csv";
const BODY = "sku,Name\nA,One\nB,Two\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const NOW = Date.parse("2026-10-26T09:00:00Z");

type Handler = (request: { headers: Headers; signal: AbortSignal }) => Response | Promise<Response>;

function setup(
	handler: Handler,
	opts: { workers?: boolean; limits?: Partial<FetchLimits>; storage?: FakeStorage } = {},
) {
	const storage = opts.storage ?? new FakeStorage();
	const requests: Headers[] = [];
	const deps: FetcherDeps = {
		storage,
		net: {
			allowPrivateNetwork: false,
			resolver: async () => ["93.184.215.14"],
			fetch: async (input, init) => {
				expect(String(input)).toBe(URL_A);
				const headers = new Headers(init?.headers);
				requests.push(headers);
				return handler({ headers, signal: init?.signal as AbortSignal });
			},
		},
		limits: {
			maxBytes: 1000,
			headersMs: 15_000,
			totalMs: 120_000,
			bufferBytes: 500,
			...opts.limits,
		},
		workers: opts.workers ?? false,
		now: () => NOW,
	};
	const staged = () =>
		[...storage.files.entries()].map(([key, file]) => [key, new TextDecoder().decode(file.bytes)]);
	return { deps, storage, requests, staged };
}

const csv = (body: string, headers: Record<string, string> = {}, status = 200) =>
	new Response(streamOf(body, 4), { status, headers });

/** Stages `text` as the previous fetch's upload, as an earlier fetch would have. */
async function previousFetch(
	deps: FetcherDeps,
	text: string,
	extra: Partial<LastFetch> = {},
): Promise<LastFetch> {
	const first = await downloadSource(
		{ ...deps, net: { ...deps.net, fetch: async () => new Response(text) } },
		{ url: URL_A, force: false },
	);
	return { ...first.fetch, ...extra };
}

const run = (deps: FetcherDeps, input: Partial<DownloadInput> = {}) =>
	downloadSource(deps, { url: URL_A, force: false, ...input });

async function failure(promise: Promise<unknown>): Promise<UrlSourceError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(UrlSourceError);
	return error as UrlSourceError;
}

describe("downloadSource", () => {
	it("stages the body with its hash, validators and status, sending the credential", async () => {
		const { deps, requests, staged } = setup(() =>
			csv(BODY, { etag: '"v1"', "last-modified": "Mon, 26 Oct 2026 08:00:00 GMT" }),
		);
		const result = await run(deps, {
			credential: { header: "Authorization", value: "Bearer t0k" },
		});
		expect(result).toEqual({
			changed: true,
			fetch: {
				at: "2026-10-26T09:00:00.000Z",
				status: 200,
				etag: '"v1"',
				lastModified: "Mon, 26 Oct 2026 08:00:00 GMT",
				sha256: sha(BODY),
				bytes: BODY.length,
				uploadId: expect.any(String),
			},
		});
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), BODY]]);
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({ authorization: "Bearer t0k" });
	});

	it("fails with FETCH_FAILED, without the value, when the credential header cannot be set", async () => {
		const { deps, requests } = setup(() => csv(BODY));
		const error = await failure(
			run(deps, { credential: { header: "Authorization", value: "Bearer s3cret\nX: 1" } }),
		);
		expect(error).toEqual(
			new UrlSourceError("FETCH_FAILED", "The credential header could not be sent"),
		);
		expect(String(error.cause ?? "")).not.toContain("s3cret");
		expect(requests).toEqual([]);
	});

	it("sends the validators of the last fetch and reports a 304 as unchanged", async () => {
		const { deps, requests, staged } = setup(() => new Response(null, { status: 304 }));
		const previous = await previousFetch(deps, BODY, {
			etag: 'W/"v1"',
			lastModified: "Mon, 26 Oct 2026 08:00:00 GMT",
		});
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({
			"if-none-match": 'W/"v1"',
			"if-modified-since": "Mon, 26 Oct 2026 08:00:00 GMT",
		});
		expect(result).toEqual({ changed: false, fetch: { ...previous, status: 304 } });
		expect(staged()).toHaveLength(1);
	});

	it("keeps a new validator that comes with a 304", async () => {
		const { deps } = setup(() => new Response(null, { status: 304, headers: { etag: '"v2"' } }));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		expect((await run(deps, { previous })).fetch.etag).toBe('"v2"');
	});

	it("reports the same body as unchanged and deletes the new copy", async () => {
		const { deps, requests, staged } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY);
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result).toEqual({ changed: false, fetch: { ...previous, status: 200 } });
		expect(staged()).toEqual([[uploadKey(previous.uploadId), BODY]]);
	});

	it("reports a different body as changed and keeps both files", async () => {
		const { deps, staged } = setup(() => csv(`${BODY}C,Three\n`));
		const previous = await previousFetch(deps, BODY);
		const result = await run(deps, { previous });
		expect(result.changed).toBe(true);
		expect(result.fetch.uploadId).not.toBe(previous.uploadId);
		expect(staged()).toHaveLength(2);
	});

	it("with force sends no validators and reports the same body as changed", async () => {
		const { deps, requests, staged } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		const result = await run(deps, { previous, force: true });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result.changed).toBe(true);
		expect(staged()).toHaveLength(2);
	});

	it("fetches in full when the previous upload is gone, even if the body is the same", async () => {
		const { deps, storage, requests } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		await storage.delete(uploadKey(previous.uploadId));
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result.changed).toBe(true);
		expect(result.fetch.uploadId).not.toBe(previous.uploadId);
	});

	it("treats a 304 as an HTTP error when the previous fetch had no validators to send", async () => {
		const { deps, requests } = setup(() => new Response(null, { status: 304 }));
		const previous = await previousFetch(deps, BODY);
		expect(await failure(run(deps, { previous }))).toEqual(
			new UrlSourceError("HTTP_ERROR", "The server answered HTTP 304"),
		);
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
	});

	it("treats a 304 to an unconditional request as an HTTP error", async () => {
		const { deps } = setup(() => new Response(null, { status: 304 }));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("HTTP_ERROR", "The server answered HTTP 304"),
		);
	});

	it.each([404, 401, 500])("fails with HTTP_ERROR on %i and stages nothing", async (status) => {
		let cancelled = false;
		const body = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		const { deps, staged } = setup(() => new Response(body, { status }));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("HTTP_ERROR", `The server answered HTTP ${status}`),
		);
		expect(cancelled).toBe(true);
		expect(staged()).toEqual([]);
	});

	it("refuses a Content-Length over the limit before reading the body", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(10));
			},
		});
		const { deps, staged } = setup(
			() => new Response(body, { headers: { "content-length": "1001" } }),
		);
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("TOO_LARGE", "The response is larger than the limit of 1000 bytes"),
		);
		expect(pulls).toBeLessThanOrEqual(1);
		expect(staged()).toEqual([]);
	});

	it("cuts a body without a length at the limit and deletes the partial upload", async () => {
		const { deps, staged } = setup(() => csv("x".repeat(1001)));
		expect((await failure(run(deps))).code).toBe("TOO_LARGE");
		expect(staged()).toEqual([]);
	});

	it("ignores a Content-Length that comes with a Content-Encoding", async () => {
		// fetch() has already decoded the body, so the header gives the compressed size.
		const body = "y".repeat(900);
		const { deps, staged } = setup(() =>
			csv(body, { "content-encoding": "gzip", "content-length": "40" }),
		);
		const result = await run(deps);
		expect(result.fetch.bytes).toBe(900);
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), body]]);
	});

	it("fails with FETCH_FAILED when no response arrives in time", async () => {
		const { deps, staged } = setup(
			({ signal }) =>
				new Promise<Response>((_, reject) =>
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
				),
			{ limits: { headersMs: 30 } },
		);
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "No response within 0.03 s"),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with FETCH_FAILED when the download takes too long, and deletes the partial upload", async () => {
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("sku,Name\n"));
			},
			pull: () => new Promise(() => {}),
		});
		const { deps, staged } = setup(() => new Response(stalled), {
			limits: { headersMs: 20, totalMs: 60 },
		});
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download did not finish within 0.06 s"),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with FETCH_FAILED when the connection breaks mid-body", async () => {
		let sent = false;
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new TypeError("terminated"));
				else controller.enqueue(new TextEncoder().encode("sku,Name\n"));
				sent = true;
			},
		});
		const { deps, staged } = setup(() => new Response(broken));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download failed: terminated"),
		);
		expect(staged()).toEqual([]);
	});
});

describe("downloadSource with a storage adapter that wraps stream errors", () => {
	it("reports a download that times out mid-body as FETCH_FAILED and deletes the partial upload", async () => {
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("sku,Name\n"));
			},
			pull: () => new Promise(() => {}),
		});
		const { deps, staged } = setup(() => new Response(stalled), {
			storage: new WrappingStorage(),
			limits: { headersMs: 20, totalMs: 60 },
		});
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download did not finish within 0.06 s"),
		);
		expect(staged()).toEqual([]);
	});

	it("reports a connection reset mid-body as FETCH_FAILED and deletes the partial upload", async () => {
		let sent = false;
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new TypeError("terminated"));
				else controller.enqueue(new TextEncoder().encode("sku,Name\n"));
				sent = true;
			},
		});
		const { deps, staged } = setup(() => new Response(broken), { storage: new WrappingStorage() });
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download failed: terminated"),
		);
		expect(staged()).toEqual([]);
	});

	it("still reports a body over the limit as TOO_LARGE", async () => {
		const { deps, staged } = setup(() => csv("x".repeat(1001)), { storage: new WrappingStorage() });
		expect((await failure(run(deps))).code).toBe("TOO_LARGE");
		expect(staged()).toEqual([]);
	});
});

describe("downloadSource on Workers", () => {
	/** Records how much of the body had been read when storage received it. */
	function counted(text: string, headers: Record<string, string> = {}) {
		const state = {
			pulls: 0,
			done: false,
			atUpload: [] as Array<{ pulls: number; done: boolean }>,
		};
		const bytes = new TextEncoder().encode(text);
		const response = () => {
			let at = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						state.pulls++;
						if (at >= bytes.length) {
							state.done = true;
							controller.close();
							return;
						}
						controller.enqueue(bytes.slice(at, at + 50));
						at += 50;
					},
				}),
				{ headers },
			);
		};
		return { state, response };
	}

	function watch(
		storage: FakeStorage,
		state: { pulls: number; done: boolean; atUpload: Array<{ pulls: number; done: boolean }> },
	) {
		const upload = storage.upload.bind(storage);
		storage.upload = (options) => {
			state.atUpload.push({ pulls: state.pulls, done: state.done });
			return upload(options);
		};
	}

	it("buffers a body without a length, then stores it", async () => {
		const text = "z".repeat(420);
		const { state, response } = counted(text);
		const { deps, storage, staged } = setup(response, { workers: true });
		watch(storage, state);
		const result = await run(deps);
		expect(state.atUpload).toEqual([{ pulls: 10, done: true }]);
		expect(result.fetch.bytes).toBe(420);
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), text]]);
	});

	it("buffers a compressed body, whose Content-Length is not its length", async () => {
		const { state, response } = counted("z".repeat(120), {
			"content-encoding": "gzip",
			"content-length": "30",
		});
		const { deps, storage } = setup(response, { workers: true });
		watch(storage, state);
		expect((await run(deps)).fetch.bytes).toBe(120);
		expect(state.atUpload[0]?.done).toBe(true);
	});

	it("streams a body with a usable Content-Length", async () => {
		const text = "z".repeat(420);
		const { state, response } = counted(text, { "content-length": "420" });
		const { deps, storage } = setup(response, { workers: true });
		watch(storage, state);
		expect((await run(deps)).fetch.bytes).toBe(420);
		// Storage got the stream before the body was read (Response pre-reads one chunk).
		expect(state.atUpload).toEqual([{ pulls: 1, done: false }]);
	});

	it("fails with LENGTH_REQUIRED past the buffer limit and stages nothing", async () => {
		const { response } = counted("z".repeat(501));
		const { deps, staged } = setup(response, { workers: true });
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError(
				"LENGTH_REQUIRED",
				"The response has no usable Content-Length and is larger than 500 bytes, the most Workers can buffer",
			),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with TOO_LARGE when the limit is below the buffer limit", async () => {
		const { response } = counted("z".repeat(301));
		const { deps } = setup(response, { workers: true, limits: { maxBytes: 300 } });
		expect((await failure(run(deps))).code).toBe("TOO_LARGE");
	});
});
