import { describe, expect, it } from "vitest";
import {
	findMedia,
	lookupRecordMedia,
	MEDIA_MIN_LEFT_MS,
	type MediaContext,
	MediaDeferred,
	type MediaRequest,
	mediaFieldValue,
	mediaMapKey,
	obtainRecordMedia,
	resolveMedia,
} from "../../src/engine/media.js";
import { ContentWriteError, MediaUploadError } from "../../src/engine/ports.js";
import { COST_CALL, COST_MEDIA, LookupCache } from "../../src/engine/resolve.js";
import { MediaError } from "../../src/sources/media-fetch.js";
import { makeDeps } from "./fakes.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const A = "https://cdn.test/a.png";
const B = "https://cdn.test/b.png";

const image = (url: string, over: Partial<MediaRequest> = {}): MediaRequest => ({
	kind: "image",
	url,
	alt: null,
	refresh: false,
	...over,
});

function setup(ctx: Partial<MediaContext> = {}) {
	const { deps, clock } = makeDeps();
	deps.mediaFetcher.files.set(A, { body: PNG, contentType: "image/png", etag: '"a1"' });
	deps.mediaFetcher.files.set(B, { body: PNG2, contentType: "image/png" });
	const context: MediaContext = { jobId: "j1", dryRun: false, maxBytes: 1000, targets: {}, ...ctx };
	return { deps, clock, ctx: context, cache: new LookupCache() };
}

describe("resolveMedia", () => {
	it("downloads a miss, uploads it with its alt and filename, and writes the map row", async () => {
		const { deps, ctx, cache } = setup();
		const resolved = await resolveMedia(deps, cache, ctx, "photo", image(A, { alt: "A chair" }));
		expect(resolved).toMatchObject({
			ok: true,
			downloaded: true,
			item: { id: "m1", alt: "A chair" },
		});
		expect(deps.media.calls).toEqual(["upload:a.png"]);
		expect(await deps.mediaMap.get(mediaMapKey(A))).toEqual({
			url: A,
			mediaId: "m1",
			storageKey: "K1.png",
			mimeType: "image/png",
			bytes: PNG.byteLength,
			etag: '"a1"',
			fetchedAt: "2026-10-07T10:00:00.000Z",
			jobId: "j1",
			created: true,
		});
		expect(deps.mediaFetcher.calls[0]?.options).toMatchObject({ kind: "image", maxBytes: 1000 });
	});

	it("uses a hit with a ready item without downloading, reading each item once per batch", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const next = new LookupCache();
		for (const field of ["photo", "thumb"]) {
			expect(await resolveMedia(deps, next, ctx, field, image(A))).toMatchObject({
				ok: true,
				downloaded: false,
				item: { id: "m1" },
			});
		}
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		expect(deps.media.calls).toEqual(["upload:a.png", "get:m1"]);
		expect(next.spent).toBe(COST_CALL * 3);
	});

	it("drops a row whose item is gone and downloads again; a dry run only plans it", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		deps.media.items.delete("m1");
		const dry = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, dryRun: true },
			"photo",
			image(A),
		);
		expect(dry).toEqual({ ok: true, item: null, downloaded: false });
		expect(await deps.mediaMap.get(mediaMapKey(A))).not.toBeNull();
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		const again = await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A));
		expect(again).toMatchObject({ ok: true, downloaded: true, item: { id: "m2" } });
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.mediaId).toBe("m2");
	});

	it("maps identical bytes from another URL to the existing item, keeping its alt", async () => {
		const { deps, ctx, cache } = setup();
		deps.mediaFetcher.files.set("https://mirror.test/a.png", { body: PNG, contentType: null });
		await resolveMedia(deps, cache, ctx, "photo", image(A, { alt: "First" }));
		const copy = await resolveMedia(
			deps,
			cache,
			ctx,
			"photo",
			image("https://mirror.test/a.png", { alt: "Second" }),
		);
		expect(copy).toMatchObject({ ok: true, downloaded: true, item: { id: "m1", alt: "First" } });
		expect(await deps.mediaMap.get(mediaMapKey("https://mirror.test/a.png"))).toMatchObject({
			mediaId: "m1",
			created: false,
		});
	});

	it("refreshes with the stored validators: 304 keeps the item, new bytes make a new one", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const kept = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, jobId: "j2" },
			"photo",
			image(A, { refresh: true }),
		);
		expect(kept).toMatchObject({ ok: true, downloaded: false, item: { id: "m1" } });
		// The 304 marks the row as refreshed by this job.
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.jobId).toBe("j2");
		expect(deps.mediaFetcher.calls[1]?.options.etag).toBe('"a1"');
		deps.mediaFetcher.files.set(A, { body: PNG2, contentType: "image/png", etag: '"a2"' });
		const changed = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, jobId: "j3" },
			"photo",
			image(A, { refresh: true }),
		);
		expect(changed).toMatchObject({ ok: true, downloaded: true, item: { id: "m2" } });
		expect(await deps.mediaMap.get(mediaMapKey(A))).toMatchObject({ mediaId: "m2", etag: '"a2"' });
		const dry = await resolveMedia(
			deps,
			new LookupCache(),
			{ ...ctx, dryRun: true },
			"photo",
			image(A, { refresh: true }),
		);
		expect(dry).toMatchObject({ ok: true, item: { id: "m2" } });
		expect(deps.mediaFetcher.calls).toHaveLength(3);
	});
});

describe("media errors", () => {
	const failed = (code: string, message?: string) => ({
		ok: false,
		error: { field: "photo", code, ...(message === undefined ? {} : { message }) },
	});

	it("checks the host in every run, before the map", async () => {
		const { deps, ctx } = setup({ dryRun: true });
		deps.mediaFetcher.blocked.add("cdn.test");
		expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("media_blocked", "The host cdn.test is not allowed"),
		);
	});

	it("refuses types before uploading: by the bytes, the kind and the field's allowed types", async () => {
		const { deps, ctx } = setup({
			targets: { logo: { type: "image", required: false, allowedMimeTypes: ["image/jpeg"] } },
		});
		deps.mediaFetcher.files.set("https://cdn.test/page.png", {
			body: "<!doctype html><p>hi",
			contentType: "image/png",
		});
		deps.mediaFetcher.files.set("https://cdn.test/a.pdf", {
			body: PDF,
			contentType: "application/pdf",
		});
		const resolve = (field: string, url: string) =>
			resolveMedia(deps, new LookupCache(), ctx, field, image(url));
		expect(await resolve("photo", "https://cdn.test/page.png")).toEqual(
			failed(
				"media_type_not_allowed",
				"https://cdn.test/page.png: The file is markup (HTML, SVG or XML), which is never imported",
			),
		);
		expect(await resolve("photo", "https://cdn.test/a.pdf")).toEqual(
			failed(
				"media_type_not_allowed",
				"https://cdn.test/a.pdf: An image field cannot take application/pdf",
			),
		);
		expect(await resolve("logo", A)).toMatchObject({
			ok: false,
			error: {
				field: "logo",
				code: "media_type_not_allowed",
				message: `${A}: The field accepts only image/jpeg, not image/png`,
			},
		});
		expect(deps.media.calls).toEqual([]);
	});

	it("refuses a hit the field does not accept, without downloading", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		const strict = {
			...ctx,
			targets: { photo: { type: "image", required: false, allowedMimeTypes: ["image/gif"] } },
		};
		expect(await resolveMedia(deps, new LookupCache(), strict, "photo", image(A))).toEqual(
			failed("media_type_not_allowed", `${A}: The field accepts only image/gif, not image/png`),
		);
		expect(deps.mediaFetcher.calls).toHaveLength(1);
	});

	it("passes download failures through with their codes", async () => {
		const { deps, ctx } = setup();
		deps.mediaFetcher.files.set(A, {
			body: "",
			error: new MediaError("media_fetch_failed", "No response within 10 s"),
		});
		expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("media_fetch_failed", "No response within 10 s"),
		);
		expect(
			await resolveMedia(deps, new LookupCache(), ctx, "photo", image("https://cdn.test/x.png")),
		).toEqual(failed("media_http_error", "The server answered HTTP 404"));
		expect(
			await resolveMedia(deps, new LookupCache(), { ...ctx, maxBytes: 5 }, "photo", image(B)),
		).toEqual(failed("media_too_large", "The file is larger than the limit of 5 bytes"));
	});

	it("maps EmDash's upload errors, and fails the job when EmDash cannot store media", async () => {
		const { deps, ctx } = setup();
		const cases: [string, string, string][] = [
			["PAYLOAD_TOO_LARGE", "media_too_large", "EmDash refused the upload: big"],
			["INVALID_TYPE", "media_type_not_allowed", "EmDash refused the upload: big"],
			["UPLOAD_ERROR", "media_upload_failed", "EmDash refused the upload (UPLOAD_ERROR): big"],
		];
		for (const [emdash, code, message] of cases) {
			deps.media.failUpload = () => new MediaUploadError(emdash, "big");
			expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
				failed(code, message),
			);
		}
		for (const emdash of ["CONFIGURATION_ERROR", "NO_STORAGE"]) {
			deps.media.failUpload = () => new MediaUploadError(emdash, "Storage not configured");
			await expect(
				resolveMedia(deps, new LookupCache(), ctx, "photo", image(A)),
			).rejects.toMatchObject({
				name: "ContentWriteError",
				code: "media_config",
				message: "EmDash cannot store media: Storage not configured",
			});
		}
		expect(await deps.mediaMap.get(mediaMapKey(A))).toBeNull();
	});

	it("reports an item EmDash fails to read as a record error", async () => {
		const { deps, ctx, cache } = setup();
		await resolveMedia(deps, cache, ctx, "photo", image(A));
		deps.media.get = async () => {
			throw new ContentWriteError("emdash_media_get_error", "Reading the media item failed: db");
		};
		expect(await findMedia(deps, new LookupCache(), ctx, "photo", image(A))).toEqual(
			failed("emdash_media_get_error", "Reading the media item failed: db"),
		);
	});
});

describe("record media", () => {
	it("collects every lookup error and leaves empty fields null", async () => {
		const { deps, ctx, cache } = setup();
		deps.mediaFetcher.blocked.add("evil.test");
		const result = await lookupRecordMedia(deps, cache, ctx, {
			photo: image("https://evil.test/a.png"),
			thumb: null,
			icon: image("https://evil.test/b.png"),
			hero: image(A),
		});
		expect(result.errors.map((e) => `${e.field}:${e.code}`)).toEqual([
			"photo:media_blocked",
			"icon:media_blocked",
		]);
		expect(result.lookups).toMatchObject({ thumb: null, hero: { item: null } });
		expect(deps.mediaFetcher.calls).toEqual([]);
	});

	it("downloads one field at a time, stops at the first failure, and lists downloads", async () => {
		const { deps, ctx, cache } = setup();
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			icon: image("https://cdn.test/missing.png"),
			hero: image(B),
		});
		expect(await obtainRecordMedia(deps, cache, ctx, lookups)).toEqual({
			ok: false,
			errors: [
				{ field: "icon", code: "media_http_error", message: "The server answered HTTP 404" },
			],
			newMedia: [`photo: ${A}`],
		});
		expect(deps.mediaFetcher.urls()).toEqual([A, "https://cdn.test/missing.png"]);
		const second = new LookupCache();
		const again = await lookupRecordMedia(deps, second, ctx, {
			photo: image(A),
			hero: image(B),
			none: null,
		});
		expect(await obtainRecordMedia(deps, second, ctx, again.lookups)).toMatchObject({
			ok: true,
			media: { photo: { item: { id: "m1" } }, hero: { item: { id: "m2" } }, none: null },
			newMedia: [`hero: ${B}`],
		});
	});

	it("defers a download that would start too close to the deadline, never the batch's first", async () => {
		const { deps, clock, ctx } = setup();
		deps.mediaFetcher.files.set(A, { body: PNG, contentType: "image/png", ms: 20_000 });
		const cache = new LookupCache();
		cache.mediaDeadline = clock.t + 1000;
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			hero: image(B),
		});
		await expect(obtainRecordMedia(deps, cache, ctx, lookups)).rejects.toBeInstanceOf(
			MediaDeferred,
		);
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		expect(deps.mediaFetcher.calls[0]?.options.deadline).toBe(clock.t - 20_000 + MEDIA_MIN_LEFT_MS);
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.mediaId).toBe("m1");
		const next = new LookupCache();
		next.mediaDeadline = clock.t + MEDIA_MIN_LEFT_MS;
		const retried = await lookupRecordMedia(deps, next, ctx, { photo: image(A), hero: image(B) });
		expect(await obtainRecordMedia(deps, next, ctx, retried.lookups)).toMatchObject({ ok: true });
		expect(deps.mediaFetcher.urls()).toEqual([A, B]);
		expect(deps.mediaFetcher.calls[1]?.options.deadline).toBe(clock.t + MEDIA_MIN_LEFT_MS);
	});

	it("charges the batch budget for lookups and downloads", async () => {
		const { deps, ctx } = setup();
		const cache = new LookupCache([], 600);
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			hero: image(B),
		});
		expect(cache.spent).toBe(2 * COST_CALL);
		await obtainRecordMedia(deps, cache, ctx, lookups);
		expect(cache.spent).toBe(2 * COST_CALL + 2 * COST_MEDIA);
	});
});

describe("one fetch per URL and batch", () => {
	it("downloads a URL used by two fields of a record once", async () => {
		const { deps, ctx, cache } = setup();
		const { lookups } = await lookupRecordMedia(deps, cache, ctx, {
			photo: image(A),
			thumb: image(A),
		});
		expect(await obtainRecordMedia(deps, cache, ctx, lookups)).toMatchObject({
			ok: true,
			media: { photo: { item: { id: "m1" } }, thumb: { item: { id: "m1" } } },
			newMedia: [`photo: ${A}`],
		});
		expect(deps.mediaFetcher.urls()).toEqual([A]);
		expect(deps.media.calls).toEqual(["upload:a.png"]);
		expect(cache.spent).toBe(2 * COST_CALL + COST_MEDIA);
		expect((await deps.mediaMap.get(mediaMapKey(A)))?.created).toBe(true);
	});

	it("keeps created when a refresh stores the same bytes again, fetching once per batch", async () => {
		const { deps, ctx } = setup();
		deps.mediaFetcher.files.set(B, { body: PNG2, contentType: "image/png" });
		await resolveMedia(deps, new LookupCache(), ctx, "photo", image(B));
		const cache = new LookupCache();
		for (let i = 0; i < 3; i++) {
			expect(
				await resolveMedia(
					deps,
					cache,
					{ ...ctx, jobId: "j2" },
					"photo",
					image(B, { refresh: true }),
				),
			).toMatchObject({ ok: true, item: { id: "m1" } });
		}
		expect(deps.mediaFetcher.urls()).toEqual([B, B]);
		expect((await deps.mediaMap.get(mediaMapKey(B)))?.created).toBe(true);
	});

	it("checks the stored type of the item an upload returns, after writing the map row", async () => {
		const { deps, ctx } = setup({
			targets: { photo: { type: "image", required: false, allowedMimeTypes: ["image/png"] } },
		});
		await resolveMedia(deps, new LookupCache(), ctx, "other", image(A));
		const stored = deps.media.items.get("m1");
		if (stored) stored.mimeType = "image/webp";
		deps.mediaFetcher.files.set("https://mirror.test/a.png", { body: PNG, contentType: null });
		const url = "https://mirror.test/a.png";
		expect(await resolveMedia(deps, new LookupCache(), ctx, "photo", image(url))).toEqual({
			ok: false,
			error: {
				field: "photo",
				code: "media_type_not_allowed",
				message: `${url}: The field accepts only image/png, not image/webp`,
			},
		});
		expect((await deps.mediaMap.get(mediaMapKey(url)))?.mediaId).toBe("m1");
	});
});

describe("mediaFieldValue", () => {
	const item = {
		id: "m1",
		filename: "a.png",
		mimeType: "image/png",
		size: 11,
		width: 4,
		height: 3,
		alt: "Library",
		storageKey: "K1.png",
		blurhash: "bh",
		dominantColor: "rgb(1,2,3)",
	};

	it("builds EmDash's stored shape for images and files", () => {
		expect(mediaFieldValue("image", item, "Per use")).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "image/png",
			width: 4,
			height: 3,
			blurhash: "bh",
			dominantColor: "rgb(1,2,3)",
			alt: "Per use",
			meta: { storageKey: "K1.png" },
		});
		const gif = { ...item, width: null, height: null, blurhash: null, dominantColor: null };
		expect(mediaFieldValue("image", gif, null)).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "image/png",
			meta: { storageKey: "K1.png" },
		});
		expect(mediaFieldValue("file", { ...item, mimeType: "application/pdf" }, "x")).toEqual({
			id: "m1",
			provider: "local",
			filename: "a.png",
			mimeType: "application/pdf",
			meta: { storageKey: "K1.png" },
		});
	});
});
