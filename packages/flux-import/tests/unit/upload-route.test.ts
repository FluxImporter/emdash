import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { POST } from "../../src/astro/upload-route.js";
import { FakeStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const URL_ = "http://site.test/_emdash/api/flux-import/uploads?filename=data.csv";

async function post(init: RequestInit & { duplex?: "half" }) {
	const storage = new FakeStorage();
	const request = new Request(URL_, { method: "POST", ...init });
	const context = {
		request,
		url: new URL(URL_),
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
});
