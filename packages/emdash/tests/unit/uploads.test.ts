import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	deferCancel,
	EmDashUploads,
	isUploadId,
	LengthRequiredError,
	newUploadId,
	stageUpload,
	UPLOAD_PREFIX,
	UploadTooLargeError,
	uploadKey,
} from "../../src/emdash/uploads.js";
import { SourceMissingError } from "../../src/engine/ports.js";
import { FakeStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const text = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("upload IDs", () => {
	it("are a ULID plus 32 hex characters and unique", () => {
		const a = newUploadId();
		const b = newUploadId();
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
		expect(uploadKey(a)).toBe(`${UPLOAD_PREFIX}${a}.csv`);
	});

	it("reject anything that could reach another storage path", () => {
		for (const bad of [
			"",
			"../backups/x",
			`${newUploadId()}/x`,
			"01ARZ3NDEKTSV4RRFFQ69G5FAV",
			"a".repeat(58),
		]) {
			expect(isUploadId(bad)).toBe(false);
			expect(() => uploadKey(bad)).toThrow(SourceMissingError);
		}
	});
});

describe("stageUpload", () => {
	it("stores the body under the upload key and reports size and SHA-256", async () => {
		const storage = new FakeStorage();
		const body = "sku,name\nA,1\n";
		const staged = await stageUpload(storage, streamOf(body, 3), 1024);
		expect(staged.bytes).toBe(body.length);
		expect(staged.sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(new TextDecoder().decode(storage.files.get(uploadKey(staged.uploadId))!.bytes)).toBe(
			body,
		);
	});

	it("fails past the limit and leaves nothing in storage", async () => {
		const storage = new FakeStorage();
		await expect(stageUpload(storage, streamOf("x".repeat(100), 10), 99)).rejects.toBeInstanceOf(
			UploadTooLargeError,
		);
		expect(storage.files.size).toBe(0);
	});

	it("rejects a declared length over the limit before reading", async () => {
		const storage = new FakeStorage();
		await expect(stageUpload(storage, streamOf("x"), 99, 100)).rejects.toBeInstanceOf(
			UploadTooLargeError,
		);
		expect(storage.bodies).toEqual([]);
	});

	it("gives Workers storage a known-length stream and refuses an unknown length", async () => {
		const lengths: number[] = [];
		class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		}
		const global = globalThis as { FixedLengthStream?: unknown };
		global.FixedLengthStream = FakeFixedLengthStream;
		try {
			const storage = new FakeStorage();
			await stageUpload(storage, streamOf("a,b\n", 2), 100, 4);
			await expect(stageUpload(storage, streamOf("a,b\n", 2), 100)).rejects.toBeInstanceOf(
				LengthRequiredError,
			);
			expect(lengths).toEqual([4]);
			expect(storage.bodies).toEqual(["stream"]);
			expect([...storage.files.values()].map((f) => new TextDecoder().decode(f.bytes))).toEqual([
				"a,b\n",
			]);
		} finally {
			delete global.FixedLengthStream;
		}
	});

	it("accepts a body of exactly the limit", async () => {
		const storage = new FakeStorage();
		const staged = await stageUpload(storage, streamOf("x".repeat(99), 10), 99);
		expect(staged.bytes).toBe(99);
	});
});

describe("EmDashUploads", () => {
	async function staged(body: string) {
		const storage = new FakeStorage();
		const { uploadId } = await stageUpload(storage, streamOf(body), 1 << 20);
		return { storage, uploads: new EmDashUploads(storage), uploadId };
	}

	it("opens at an offset with a ranged read", async () => {
		const { uploads, uploadId } = await staged("0123456789");
		expect(await text(await uploads.open(uploadId, 0))).toBe("0123456789");
		expect(await text(await uploads.open(uploadId, 4))).toBe("456789");
	});

	it("returns an empty stream at or past the end instead of the whole file", async () => {
		const { uploads, uploadId } = await staged("0123456789");
		expect(await text(await uploads.open(uploadId, 10))).toBe("");
		expect(await text(await uploads.open(uploadId, 25))).toBe("");
	});

	it("fails loudly when storage ignores the range", async () => {
		const { storage, uploads, uploadId } = await staged("0123456789");
		const real = storage.download.bind(storage);
		storage.download = (key) => real(key);
		await expect(uploads.open(uploadId, 4)).rejects.toThrow("ignored the byte range");
	});

	it("tells whether a staged file still exists", async () => {
		const { uploads, uploadId } = await staged("x");
		expect(await uploads.exists(uploadId)).toBe(true);
		await uploads.delete(uploadId);
		expect(await uploads.exists(uploadId)).toBe(false);
		expect(() => uploads.exists("../x")).toThrow(SourceMissingError);
	});

	it("maps a missing file or a malformed ID to SourceMissingError", async () => {
		const { uploads } = await staged("x");
		await expect(uploads.open(newUploadId(), 0)).rejects.toBeInstanceOf(SourceMissingError);
		await expect(uploads.open("../../etc/passwd", 0)).rejects.toBeInstanceOf(SourceMissingError);
	});

	it("keeps old files whose upload ID is in the keep set", async () => {
		const { storage, uploads, uploadId } = await staged("old");
		const { uploadId: other } = await stageUpload(storage, streamOf("old2"), 100);
		storage.now = () => new Date("2026-10-09T00:00:00Z");
		const removed = await uploads.purgeBefore(
			new Date("2026-10-08T00:00:00Z"),
			new Set([uploadId]),
		);
		expect(removed).toBe(1);
		expect(storage.files.has(uploadKey(uploadId))).toBe(true);
		expect(storage.files.has(uploadKey(other))).toBe(false);
	});

	it("deletes one upload and purges files older than a cutoff", async () => {
		const { storage, uploads, uploadId } = await staged("old");
		storage.now = () => new Date("2026-10-09T00:00:00Z");
		const { uploadId: fresh } = await stageUpload(storage, streamOf("new"), 100);
		const removed = await uploads.purgeBefore(new Date("2026-10-08T00:00:00Z"));
		expect(removed).toBe(1);
		expect(storage.files.has(uploadKey(uploadId))).toBe(false);
		expect(storage.files.has(uploadKey(fresh))).toBe(true);
		await uploads.delete(fresh);
		await uploads.delete(fresh);
		expect(storage.files.size).toBe(0);
	});
});

describe("deferCancel", () => {
	it("passes the bytes through and cancels the source", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("ab"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const reader = deferCancel(source).getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("ab");
		await reader.cancel();
		expect(cancelled).toBe(true);
		expect(await text(deferCancel(streamOf("xyz", 1)))).toBe("xyz");
	});

	it("survives cancelling a Node file stream right after a read (local storage adapter)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fluximporter-cancel-"));
		const file = join(dir, "big.bin");
		await writeFile(file, Buffer.alloc(1_600_000, 0x61));
		const errors: unknown[] = [];
		const record = (e: unknown) => {
			errors.push(e);
		};
		process.on("unhandledRejection", record);
		process.on("uncaughtException", record);
		try {
			for (let n = 0; n < 30; n++) {
				const body = Readable.toWeb(createReadStream(file, { start: 1000 * n }));
				const reader = deferCancel(body as ReadableStream<Uint8Array>).getReader();
				const first = await reader.read();
				expect(first.done).toBe(false);
				expect(first.value?.byteLength ?? 0).toBeGreaterThan(0);
				// Let the file stream fill its buffer and pause, then read and cancel at once.
				await new Promise((r) => setTimeout(r, 5));
				const second = await reader.read();
				expect(second.done).toBe(false);
				expect(second.value?.byteLength ?? 0).toBeGreaterThan(0);
				await expect(reader.cancel()).resolves.toBeUndefined();
			}
			await new Promise((r) => setTimeout(r, 20));
			expect(errors).toEqual([]);
		} finally {
			process.off("unhandledRejection", record);
			process.off("uncaughtException", record);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
