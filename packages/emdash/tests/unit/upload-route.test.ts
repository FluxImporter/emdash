import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { XLSX_MAX_BYTES } from "../../src/astro/config.js";
import { POST } from "../../src/astro/upload-route.js";
import { FakeStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const BASE = "http://site.test/_emdash/api/fluximporter/uploads?filename=";
const URL_ = `${BASE}data.csv`;

async function post(init: RequestInit & { duplex?: "half" }, url = URL_) {
	const storage = new FakeStorage();
	const request = new Request(url, { method: "POST", ...init });
	const context = {
		request,
		url: new URL(url),
		locals: { user: { id: "admin", role: 50 }, emdash: { storage } },
	} as unknown as APIContext;
	const res = await POST(context);
	return { res, body: await res.json(), storage };
}

describe("upload route", () => {
	it("rejects a declared empty body with EMPTY_BODY and stores nothing", async () => {
		const { res, body, storage } = await post({ body: "", headers: { "Content-Length": "0" } });
		expect(res.status).toBe(400);
		expect(body).toMatchObject({ success: false, error: { code: "EMPTY_BODY" } });
		expect(storage.bodies).toEqual([]);
		expect(storage.files.size).toBe(0);
	});

	it("rejects a streamed body that turns out empty and deletes what it staged", async () => {
		const { res, body, storage } = await post({ body: streamOf(""), duplex: "half" });
		expect(res.status).toBe(400);
		expect(body).toMatchObject({ success: false, error: { code: "EMPTY_BODY" } });
		expect(storage.bodies).toEqual(["stream"]);
		expect(storage.files.size).toBe(0);
	});

	it("on Workers requires a Content-Length and reads nothing without one", async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		global.FixedLengthStream = class extends TransformStream {};
		try {
			let pulled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulled = true;
						controller.enqueue(new TextEncoder().encode("a\n1\n"));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			const { res, body: json, storage } = await post({ body, duplex: "half" });
			expect(res.status).toBe(411);
			expect(json).toMatchObject({ success: false, error: { code: "LENGTH_REQUIRED" } });
			expect(storage.bodies).toEqual([]);
			expect(pulled).toBe(false);
		} finally {
			delete global.FixedLengthStream;
		}
	});

	it("stages a non-empty body", async () => {
		const { res, body, storage } = await post({ body: streamOf("a\n1\n"), duplex: "half" });
		expect(res.status).toBe(201);
		expect(body).toMatchObject({ success: true, data: { bytes: 4 } });
		expect(storage.files.size).toBe(1);
	});

	it.each([
		"feed.json",
		"feed.JSONL",
		"feed.ndjson",
		"feed.xml",
		"Products 2026.xlsx",
		"BOOK.XLSX",
		"a.b.csv",
		`${"n".repeat(251)}.csv`,
	])("accepts %s", async (name) => {
		const { res } = await post(
			{ body: streamOf("x"), duplex: "half" },
			BASE + encodeURIComponent(name),
		);
		expect(res.status).toBe(201);
	});

	it.each([
		"feed.txt",
		"feed.json.gz",
		"book.xls",
		"book.xlsm",
		"book.xlsb",
		"book.ods",
		"../feed.json",
		"feed",
		".json",
		`${"n".repeat(250)}.ndjson`,
	])("rejects %s with 415 and stores nothing", async (name) => {
		const { res, body, storage } = await post(
			{ body: streamOf("x"), duplex: "half" },
			BASE + encodeURIComponent(name),
		);
		expect(res.status).toBe(415);
		expect(body).toMatchObject({ error: { code: "UNSUPPORTED_SOURCE" } });
		expect(storage.files.size).toBe(0);
	});

	it("limits .xlsx files to 10 MiB, by Content-Length and while streaming", async () => {
		const declared = await post(
			{
				body: streamOf("x"),
				duplex: "half",
				headers: { "Content-Length": String(XLSX_MAX_BYTES + 1) },
			},
			`${BASE}book.xlsx`,
		);
		expect(declared.res.status).toBe(413);
		expect(declared.body).toMatchObject({
			error: {
				code: "TOO_LARGE",
				message: `The upload exceeds the limit of ${XLSX_MAX_BYTES} bytes`,
			},
		});
		const streamed = await post(
			{ body: streamOf(new Uint8Array(XLSX_MAX_BYTES + 1)), duplex: "half" },
			`${BASE}book.xlsx`,
		);
		expect(streamed.res.status).toBe(413);
		expect(streamed.storage.files.size).toBe(0);
		// The same size is fine for other formats, whose limit is maxSourceBytes (50 MiB).
		const csv = await post({ body: streamOf(new Uint8Array(XLSX_MAX_BYTES + 1)), duplex: "half" });
		expect(csv.res.status).toBe(201);
	});
});
