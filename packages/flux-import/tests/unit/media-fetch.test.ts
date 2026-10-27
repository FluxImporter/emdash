import { describe, expect, it } from "vitest";
import {
	createMediaFetcher,
	looksLikeMarkup,
	type MediaError,
	type MediaFetchOptions,
	mediaFilename,
	mediaTypeOf,
	sniffMime,
} from "../../src/sources/media-fetch.js";
import type { NetOptions } from "../../src/sources/net.js";
import { streamOf } from "./helpers.js";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
	);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0]);

describe("sniffMime", () => {
	it("recognizes every format the importer knows by its magic bytes", () => {
		const cases: [Uint8Array, string | null][] = [
			[PNG, "image/png"],
			[bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
			[bytes("GIF89a"), "image/gif"],
			[bytes("GIF87a"), "image/gif"],
			[bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "), "image/webp"],
			[bytes("RIFF", [1, 2, 3, 4], "WAVEfmt "), "audio/wav"],
			[ftyp("avif"), "image/avif"],
			[ftyp("heic"), "image/heic"],
			[ftyp("mif1"), "image/heif"],
			[ftyp("isom"), "video/mp4"],
			[ftyp("qt  "), "video/quicktime"],
			[ftyp("M4A "), "audio/mp4"],
			[bytes([0xff, 0x0a, 0xfa]), "image/jxl"],
			[bytes([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), "image/jxl"],
			[bytes("%PDF-1.7\n"), "application/pdf"],
			[bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"), "video/webm"],
			[bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], "matroska"), "video/x-matroska"],
			[bytes("OggS", [0]), "audio/ogg"],
			[bytes("OggS", [0, 2], "\x80theora"), "video/ogg"],
			[bytes([0, 0, 0, 0x1c], "ftyp", "isom", [0, 0, 0, 0], "isom", "avif", "mif1"), "image/avif"],
			[bytes("ID3", [4, 0]), "audio/mpeg"],
			[bytes([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
			[bytes("hello"), null],
			[bytes(), null],
		];
		for (const [input, type] of cases) expect(sniffMime(input), type ?? "none").toBe(type);
	});

	it("finds markup after a byte order mark and whitespace, also in UTF-16", () => {
		expect(looksLikeMarkup(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(true);
		expect(looksLikeMarkup(bytes([0xef, 0xbb, 0xbf], " \r\n\t<!doctype html>"))).toBe(true);
		expect(looksLikeMarkup(bytes([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]))).toBe(true);
		expect(looksLikeMarkup(bytes("not < markup"))).toBe(false);
		expect(looksLikeMarkup(PNG)).toBe(false);
		for (const tag of ["<svg onload=alert(1)>", "<html>"]) {
			expect(looksLikeMarkup(bytes(" ".repeat(2000), tag)), tag).toBe(true);
		}
		expect(looksLikeMarkup(bytes(" ".repeat(2000)))).toBe(true);
		expect(looksLikeMarkup(bytes())).toBe(false);
	});
});

describe("mediaTypeOf", () => {
	const url = "https://cdn.test/media/file.bin";

	it("lets the bytes decide, and refuses markup whatever the header says", () => {
		expect(mediaTypeOf(PNG, "image/jpeg", url)).toEqual({ ok: true, mimeType: "image/png" });
		expect(mediaTypeOf(bytes("<html><body>x"), "image/png", url)).toEqual({
			ok: false,
			message: "The file is markup (HTML, SVG or XML), which is never imported",
		});
		expect(mediaTypeOf(bytes("<svg/>"), "image/svg+xml", url).ok).toBe(false);
	});

	it("takes an unrecognized video or audio type from the header, never an image or PDF", () => {
		expect(mediaTypeOf(bytes("FLV\x01"), "video/x-flv; charset=binary", url)).toEqual({
			ok: true,
			mimeType: "video/x-flv",
		});
		expect(mediaTypeOf(bytes("fLaC"), "audio/flac", url)).toEqual({
			ok: true,
			mimeType: "audio/flac",
		});
		expect(mediaTypeOf(bytes("garbage"), "image/png", url)).toEqual({
			ok: false,
			message: "The type the server declared does not match the file",
		});
		expect(mediaTypeOf(bytes("garbage"), "application/pdf", url).ok).toBe(false);
		expect(mediaTypeOf(bytes("garbage"), "text/plain", url)).toEqual({
			ok: false,
			message: "EmDash does not accept the type the server declared",
		});
	});

	it("refuses a content type that is not a plain type/subtype, without echoing it", () => {
		for (const header of ["audio/mp3 evil", "video/<x>", "bogus", "audio/"]) {
			expect(mediaTypeOf(bytes("unknown"), header, url), header).toEqual({
				ok: false,
				message: "The server sent a content type that is not valid",
			});
		}
	});

	it("uses the URL's extension only when the header says nothing, and only for audio and video", () => {
		const data = bytes("unknown");
		expect(mediaTypeOf(data, null, "https://cdn.test/clip.MOV?x=1")).toEqual({
			ok: true,
			mimeType: "video/quicktime",
		});
		expect(mediaTypeOf(data, "application/octet-stream", "https://cdn.test/a.mp3")).toEqual({
			ok: true,
			mimeType: "audio/mpeg",
		});
		expect(mediaTypeOf(data, "application/octet-stream", "https://cdn.test/a.png")).toEqual({
			ok: false,
			message: "The file's type could not be recognized",
		});
		expect(mediaTypeOf(data, "text/plain", "https://cdn.test/a.mp3").ok).toBe(false);
	});
});

describe("mediaFilename", () => {
	it("keeps a decoded, reduced last segment with the canonical extension", () => {
		expect(mediaFilename("https://cdn.test/a/Red%20Chair%20(2).JPEG?x=1", "image/jpeg")).toBe(
			"Red-Chair-2.jpg",
		);
		expect(mediaFilename("https://cdn.test/a/photo.png", "image/webp")).toBe("photo.webp");
		expect(mediaFilename("https://cdn.test/files/", "application/pdf")).toBe("media.pdf");
		expect(mediaFilename("https://cdn.test/%E2%82%AC.pdf", "application/pdf")).toBe("media.pdf");
		expect(mediaFilename("https://cdn.test/..%2F..%2Fetc%2Fpasswd", "image/png")).toBe(
			"etc-passwd.png",
		);
		expect(mediaFilename("https://cdn.test/bad%zz.gif", "image/gif")).toBe("bad-zz.gif");
		expect(mediaFilename("https://cdn.test/clip", "video/x-flv")).toBe("clip.bin");
		const long = mediaFilename(`https://cdn.test/${"a".repeat(300)}.png`, "image/png");
		expect(long).toBe(`${"a".repeat(96)}.png`);
	});
});

type Handler = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

function fetcher(handler: Handler, limits = { headersMs: 1000, totalMs: 2000 }, now = Date.now) {
	const seen: { url: string; headers: Headers }[] = [];
	const net: NetOptions = {
		allowPrivateNetwork: false,
		resolver: async () => ["93.184.215.14"],
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			seen.push({ url: String(input), headers });
			return handler(String(input), { headers, signal: init?.signal as AbortSignal });
		},
	};
	return { media: createMediaFetcher(net, now, limits), seen };
}

const options = (o: Partial<MediaFetchOptions> = {}): MediaFetchOptions => ({
	kind: "image",
	maxBytes: 1000,
	deadline: Date.now() + 60_000,
	...o,
});
const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: MediaError) => ({ code: e.code, message: e.message }),
	);
const never = (signal: AbortSignal) =>
	new Promise<Response>((_, reject) =>
		signal.addEventListener("abort", () => reject(signal.reason)),
	);

describe("createMediaFetcher", () => {
	it("downloads the body with Accept for the kind, and reports the URL after redirects", async () => {
		const { media, seen } = fetcher(async (url) =>
			url.endsWith("/old.png")
				? new Response(null, { status: 302, headers: { location: "/new/photo.png" } })
				: new Response(streamOf(PNG, 3), {
						headers: { "content-type": "image/png", etag: '"v1"', "last-modified": "Mon" },
					}),
		);
		expect(await media.fetch("https://cdn.test/old.png", options())).toEqual({
			status: 200,
			bytes: PNG,
			contentType: "image/png",
			finalUrl: "https://cdn.test/new/photo.png",
			etag: '"v1"',
			lastModified: "Mon",
		});
		expect(seen.map((s) => s.headers.get("accept"))).toEqual([
			"image/*,*/*;q=0.8",
			"image/*,*/*;q=0.8",
		]);
		await media.fetch("https://cdn.test/new/photo.png", options({ kind: "file" }));
		expect(seen[2]?.headers.get("accept")).toBe("*/*");
	});

	it("sends the validators on refresh and gives 304 back", async () => {
		const { media, seen } = fetcher(async () => new Response(null, { status: 304 }));
		expect(
			await media.fetch("https://cdn.test/a.png", options({ etag: '"v1"', lastModified: "Mon" })),
		).toEqual({ status: 304 });
		expect(seen[0]?.headers.get("if-none-match")).toBe('"v1"');
		expect(seen[0]?.headers.get("if-modified-since")).toBe("Mon");
		expect(await failure(media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_http_error",
			message: "The server answered HTTP 304",
		});
	});

	it("fails other statuses, network errors and blocked redirects with their codes", async () => {
		const { media } = fetcher(async (url) => {
			if (url.endsWith("/missing.png")) return new Response("no", { status: 404 });
			if (url.endsWith("/hop.png")) {
				return new Response(null, { status: 301, headers: { location: "http://10.0.0.1/x.png" } });
			}
			throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
		});
		expect(await failure(media.fetch("https://cdn.test/missing.png", options()))).toEqual({
			code: "media_http_error",
			message: "The server answered HTTP 404",
		});
		expect(await failure(media.fetch("https://cdn.test/hop.png", options()))).toEqual({
			code: "media_blocked",
			message: "The address 10.0.0.1 is not public",
		});
		expect(await failure(media.fetch("https://cdn.test/down.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "Could not fetch from cdn.test: fetch failed: ECONNRESET",
		});
	});

	it("refuses an empty body, and a stored validator that is not a valid header value", async () => {
		const { media } = fetcher(async () => new Response(new Uint8Array(0)));
		expect(await failure(media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "The server sent an empty file",
		});
		const bad = await failure(media.fetch("https://cdn.test/a.png", options({ etag: "a\nb" })));
		expect(bad.code).toBe("media_fetch_failed");
	});

	it("checks host names and IP literals without the network", () => {
		const { media, seen } = fetcher(async () => new Response(""));
		expect(() => media.checkHost("https://cdn.test/a.png")).not.toThrow();
		for (const url of ["http://localhost/a.png", "http://192.168.1.4/a.png", "http://[::1]/a"]) {
			expect(() => media.checkHost(url), url).toThrow(
				expect.objectContaining({ code: "media_blocked" }),
			);
		}
		expect(seen).toEqual([]);
	});

	it("refuses a Content-Length over the limit before reading, and cuts a longer body", async () => {
		let pulled = 0;
		const body = () =>
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled++;
					controller.enqueue(new Uint8Array(400));
				},
			});
		const { media } = fetcher(async (url) =>
			url.endsWith("/declared.png")
				? new Response(body(), { headers: { "content-length": "1001" } })
				: new Response(body()),
		);
		expect(await failure(media.fetch("https://cdn.test/declared.png", options()))).toEqual({
			code: "media_too_large",
			message: "The file is larger than the limit of 1000 bytes",
		});
		expect(pulled).toBeLessThanOrEqual(1);
		pulled = 0;
		expect(await failure(media.fetch("https://cdn.test/endless.png", options()))).toEqual({
			code: "media_too_large",
			message: "The file is larger than the limit of 1000 bytes",
		});
		expect(pulled).toBeLessThanOrEqual(4);
	});

	it("times out waiting for headers, and for the whole download", async () => {
		const slowHeaders = fetcher(async (_url, { signal }) => never(signal), {
			headersMs: 50,
			totalMs: 2000,
		});
		expect(await failure(slowHeaders.media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "No response within 1 s",
		});
		const stalled = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(10));
					},
				}),
			);
		const slowBody = fetcher(async () => stalled(), { headersMs: 1000, totalMs: 60 });
		expect(await failure(slowBody.media.fetch("https://cdn.test/a.png", options()))).toEqual({
			code: "media_fetch_failed",
			message: "The download did not finish within 1 s",
		});
	});

	it("never runs past the caller's deadline", async () => {
		const now = Date.now();
		const { media } = fetcher(async (_url, { signal }) => never(signal), {
			headersMs: 10_000,
			totalMs: 30_000,
		});
		const started = Date.now();
		expect(
			await failure(media.fetch("https://cdn.test/a.png", options({ deadline: now + 80 }))),
		).toEqual({ code: "media_fetch_failed", message: "The download did not finish within 1 s" });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
