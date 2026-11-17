import { describe, expect, it } from "vitest";
import type { HandlerResult } from "../../src/emdash/content.js";
import { EmDashMedia, type MediaRuntime } from "../../src/emdash/media.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import { FakeMedia } from "./fakes.js";

const item = (over: Record<string, unknown> = {}) => ({
	id: "M1",
	filename: "chair.png",
	mimeType: "image/png",
	size: 12,
	width: 4,
	height: 3,
	alt: "Library alt",
	caption: null,
	storageKey: "01ABC.png",
	status: "ready",
	contentHash: "sha1:x",
	blurhash: "LEHV6n",
	dominantColor: "rgb(1,2,3)",
	createdAt: "2026-10-27T00:00:00Z",
	authorId: "u1",
	...over,
});
const info = {
	id: "M1",
	filename: "chair.png",
	mimeType: "image/png",
	size: 12,
	width: 4,
	height: 3,
	alt: "Library alt",
	storageKey: "01ABC.png",
	blurhash: "LEHV6n",
	dominantColor: "rgb(1,2,3)",
};

class FakeRuntime implements MediaRuntime {
	readonly uploads: Parameters<MediaRuntime["handleMediaUpload"]>[0][] = [];
	get: (id: string) => HandlerResult = () => ({ success: true, data: { item: item() } });
	upload: () => HandlerResult = () => ({ success: true, data: { item: { ...item(), url: "/x" } } });

	async handleMediaGet(id: string) {
		return this.get(id);
	}
	async handleMediaUpload(input: Parameters<MediaRuntime["handleMediaUpload"]>[0]) {
		this.uploads.push(input);
		return this.upload();
	}
}

describe("EmDashMedia", () => {
	it("uploads without an author when the job has none (spec Ruling 4)", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, null, undefined);
		const bytes = new Uint8Array([1, 2, 3]);
		await media.upload({ filename: "a.png", contentType: "image/png", bytes });
		expect(runtime.uploads).toHaveLength(1);
		expect(runtime.uploads[0]).not.toHaveProperty("authorId");
	});

	it("gets a ready item, and null for a missing or unfinished one", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		expect(await media.get("M1")).toEqual(info);
		runtime.get = () => ({ success: true, data: { item: item({ status: "pending" }) } });
		expect(await media.get("M1")).toBeNull();
		runtime.get = () => ({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
		expect(await media.get("M1")).toBeNull();
	});

	it("turns read errors and odd responses into record errors", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		runtime.get = () => ({ success: false, error: { code: "MEDIA_GET_ERROR", message: "db" } });
		await expect(media.get("M1")).rejects.toMatchObject({
			name: "ContentWriteError",
			code: "emdash_media_get_error",
			message: "Reading the media item failed: db",
		});
		runtime.get = () => ({ success: true, data: { item: { id: "M1" } } });
		await expect(media.get("M1")).rejects.toMatchObject({ code: "emdash_bad_response" });
	});

	it("uploads base64 as the author, with the site's limit and the alt when given", async () => {
		const runtime = new FakeRuntime();
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]).subarray(1, 5);
		const limited = new EmDashMedia(runtime, "u1", 1234);
		expect(
			await limited.upload({ filename: "a.png", contentType: "image/png", bytes, alt: "A" }),
		).toEqual({ item: info, deduplicated: false });
		const plain = new EmDashMedia(runtime, "u2", undefined);
		runtime.upload = () => ({
			success: true,
			data: { item: { ...item(), url: "/x" }, deduplicated: true },
		});
		expect(
			await plain.upload({ filename: "b.pdf", contentType: "application/pdf", bytes }),
		).toEqual({ item: info, deduplicated: true });
		expect(runtime.uploads).toEqual([
			{
				filename: "a.png",
				base64: Buffer.from([1, 2, 250, 251]).toString("base64"),
				contentType: "image/png",
				authorId: "u1",
				alt: "A",
				maxUploadSize: 1234,
			},
			{
				filename: "b.pdf",
				base64: "AQL6+w==",
				contentType: "application/pdf",
				authorId: "u2",
			},
		]);
	});

	it("throws EmDash's upload error code", async () => {
		const runtime = new FakeRuntime();
		const media = new EmDashMedia(runtime, "u1", undefined);
		runtime.upload = () => ({
			success: false,
			error: { code: "PAYLOAD_TOO_LARGE", message: "File exceeds maximum size of 50MB" },
		});
		const upload = media.upload({
			filename: "a.png",
			contentType: "image/png",
			bytes: new Uint8Array(1),
		});
		await expect(upload).rejects.toBeInstanceOf(MediaUploadError);
		await expect(upload).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
			message: "File exceeds maximum size of 50MB",
		});
		runtime.upload = () => ({ success: true, data: {} });
		await expect(
			media.upload({ filename: "a.png", contentType: "image/png", bytes: new Uint8Array(1) }),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	});
});

describe("FakeMedia", () => {
	it("dedupes identical bytes to the ready item, keeping its alt", async () => {
		const media = new FakeMedia();
		const bytes = new Uint8Array([1, 2, 3]);
		const first = await media.upload({
			filename: "a.png",
			contentType: "image/png",
			bytes,
			alt: "A",
		});
		const again = await media.upload({
			filename: "b.png",
			contentType: "image/png",
			bytes,
			alt: "B",
		});
		expect(first).toMatchObject({ item: { id: "m1", alt: "A", width: 4 }, deduplicated: false });
		expect(again).toMatchObject({ item: { id: "m1", alt: "A" }, deduplicated: true });
		media.items.get("m1")!.status = "pending";
		expect(await media.get("m1")).toBeNull();
	});
});
