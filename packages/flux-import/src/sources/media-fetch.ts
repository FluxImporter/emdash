/**
 * Downloads for image and file fields (M4c): one guarded GET per URL (the M3c SSRF guard), its
 * body counted and buffered into one `Uint8Array`, then the type read from the bytes and a
 * filename built for EmDash's media library.
 */
import { bodyLength } from "./fetcher.js";
import {
	checkHost,
	fetchError,
	guardedFetch,
	type NetOptions,
	parseSourceUrl,
	UrlSourceError,
	whenAborted,
} from "./net.js";

/** Record error codes for media; every one fails the record, never the job. */
export type MediaErrorCode =
	| "invalid_media_url"
	| "media_blocked"
	| "media_fetch_failed"
	| "media_http_error"
	| "media_too_large"
	| "media_type_not_allowed"
	| "media_upload_failed";

/** A media problem for one field of a record. Messages never contain header values. */
export class MediaError extends Error {
	/** A timeout caused by the caller's deadline, not by the download's own limits. */
	deadline = false;
	constructor(
		readonly code: MediaErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MediaError";
	}
}

export interface MediaLimits {
	/** Until the final response's headers arrive, DNS and redirects included. */
	headersMs: number;
	/** For the whole download; the caller's deadline may shorten it. */
	totalMs: number;
}

export const MEDIA_LIMITS = { headersMs: 10_000, totalMs: 30_000 } as const satisfies MediaLimits;

/** `Accept` for each mapping kind. */
const ACCEPT = { image: "image/*,*/*;q=0.8", file: "*/*" } as const;

export type MediaFetchOptions = {
	kind: "image" | "file";
	/** The job's `mediaMaxBytes`. */
	maxBytes: number;
	/** Epoch milliseconds the download must finish by. */
	deadline: number;
	/** Validators of the earlier download, for a conditional GET (`refresh`). */
	etag?: string;
	lastModified?: string;
};

export type MediaFetchResult =
	| {
			status: 200;
			bytes: Uint8Array;
			/** The response's `Content-Type`, as sent. */
			contentType: string | null;
			/** The URL that answered, after redirects. */
			finalUrl: string;
			etag?: string;
			lastModified?: string;
	  }
	| { status: 304 };

export interface MediaFetcher {
	/** The checks that need no network (host names, IP literals); throws `media_blocked`. */
	checkHost(url: string): void;
	/** Throws `MediaError`; a `304` comes back only to a conditional request. */
	fetch(url: string, o: MediaFetchOptions): Promise<MediaFetchResult>;
}

const tooLarge = (limit: number) =>
	new MediaError("media_too_large", `The file is larger than the limit of ${limit} bytes`);

const CODES: Record<UrlSourceError["code"], MediaErrorCode> = {
	URL_BLOCKED: "media_blocked",
	FETCH_FAILED: "media_fetch_failed",
	TOO_MANY_REDIRECTS: "media_fetch_failed",
	HTTP_ERROR: "media_http_error",
	TOO_LARGE: "media_too_large",
	LENGTH_REQUIRED: "media_fetch_failed",
};

function asMediaError(e: unknown, signal: AbortSignal): MediaError {
	if (e instanceof MediaError) return e;
	const failure = fetchError(e, signal, "The download failed");
	return new MediaError(CODES[failure.code], failure.message);
}

/** Reads the body into one array, cut as soon as it passes `maxBytes`. */
async function readBody(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const aborted = whenAborted(signal);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge(maxBytes);
			chunks.push(value);
		}
	} catch (e) {
		reader.cancel().catch(() => {});
		throw e;
	}
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

/**
 * A `MediaFetcher` over `guardedFetch`: 10 s to the response headers, then at most 30 s for the
 * whole download and never past the caller's deadline. A `Content-Length` over the limit is
 * refused before the body is read.
 */
export function createMediaFetcher(
	net: NetOptions,
	now: () => number = Date.now,
	limits: MediaLimits = MEDIA_LIMITS,
): MediaFetcher {
	return {
		checkHost(url) {
			try {
				checkHost(parseSourceUrl(url), net.allowPrivateNetwork);
			} catch (e) {
				if (e instanceof UrlSourceError) throw new MediaError("media_blocked", e.message);
				throw e;
			}
		},
		async fetch(url, o) {
			const totalMs = Math.max(0, Math.min(limits.totalMs, o.deadline - now()));
			const conditional = o.etag !== undefined || o.lastModified !== undefined;
			const total = new AbortController();
			const untilHeaders = new AbortController();
			const seconds = (ms: number) => Math.ceil(ms / 1000);
			// The caller's deadline, not the 30 s limit, is what ends this download if it is nearer.
			const deadlineBound = o.deadline - now() < limits.totalMs;
			let totalFired = false;
			const totalTimer = setTimeout(() => {
				totalFired = true;
				total.abort(
					new UrlSourceError(
						"FETCH_FAILED",
						`The download did not finish within ${seconds(totalMs)} s`,
					),
				);
			}, totalMs);
			const headersTimer = setTimeout(
				() =>
					untilHeaders.abort(
						new UrlSourceError("FETCH_FAILED", `No response within ${seconds(limits.headersMs)} s`),
					),
				limits.headersMs,
			);
			const signal = AbortSignal.any([total.signal, untilHeaders.signal]);
			try {
				const headers = new Headers({ accept: ACCEPT[o.kind] });
				if (o.etag !== undefined) headers.set("if-none-match", o.etag);
				if (o.lastModified !== undefined) headers.set("if-modified-since", o.lastModified);
				let finalUrl = url;
				const response = await guardedFetch(
					url,
					{
						headers,
						signal,
						onRequest: (next) => {
							finalUrl = next.href;
						},
					},
					net,
				);
				clearTimeout(headersTimer);
				if (response.status === 304 && conditional) {
					await response.body?.cancel().catch(() => {});
					return { status: 304 };
				}
				if (response.status < 200 || response.status > 299) {
					await response.body?.cancel().catch(() => {});
					throw new MediaError("media_http_error", `The server answered HTTP ${response.status}`);
				}
				const length = bodyLength(response.headers);
				if (length !== undefined && length > o.maxBytes) {
					await response.body?.cancel().catch(() => {});
					throw tooLarge(o.maxBytes);
				}
				const bytes = await readBody(
					response.body ?? new Blob([]).stream(),
					o.maxBytes,
					total.signal,
				);
				if (bytes.length === 0) {
					throw new MediaError("media_fetch_failed", "The server sent an empty file");
				}
				const etag = response.headers.get("etag");
				const lastModified = response.headers.get("last-modified");
				return {
					status: 200,
					bytes,
					contentType: response.headers.get("content-type"),
					finalUrl,
					...(etag === null ? {} : { etag }),
					...(lastModified === null ? {} : { lastModified }),
				};
			} catch (e) {
				const error = asMediaError(e, signal);
				if (totalFired && deadlineBound && error.code === "media_fetch_failed") {
					error.deadline = true;
				}
				throw error;
			} finally {
				clearTimeout(totalTimer);
				clearTimeout(headersTimer);
			}
		},
	};
}

const startsWith = (bytes: Uint8Array, at: number, values: readonly number[]) =>
	values.every((v, i) => bytes[at + i] === v);
const ascii = (bytes: Uint8Array, at: number, text: string) =>
	startsWith(
		bytes,
		at,
		[...text].map((c) => c.charCodeAt(0)),
	);
const textOf = (bytes: Uint8Array, from: number, to: number) =>
	String.fromCharCode(...bytes.subarray(from, to));

/** ISO base media brands of MP4 and 3GPP video; an unknown brand is not guessed at. */
const MP4_BRANDS = new Set([
	"isom",
	"iso2",
	"iso3",
	"iso4",
	"iso5",
	"iso6",
	"mp41",
	"mp42",
	"mp71",
	"avc1",
	"dash",
	"M4V ",
	"M4VH",
	"M4VP",
	"3gp4",
	"3gp5",
	"3gp6",
	"3gp7",
	"3ge6",
	"3ge7",
	"3gg6",
	"3g2a",
	"3g2b",
	"3g2c",
	"f4v ",
]);

/** ISO base media brands that are images (HEIF/AVIF), which `ftyp` alone does not tell apart. */
const IMAGE_BRANDS: Record<string, string> = {
	avif: "image/avif",
	avis: "image/avif",
	heic: "image/heic",
	heix: "image/heic",
	hevc: "image/heic",
	hevx: "image/heic",
	mif1: "image/heif",
	msf1: "image/heif",
};

/**
 * The type the bytes show, or null when they match none of the formats the importer knows: PNG,
 * JPEG, GIF, WebP, AVIF (and HEIF, which EmDash refuses), JPEG XL, PDF, MP4 and QuickTime
 * (`ftyp`), WebM and Matroska, Ogg, WAV and MP3.
 */
export function sniffMime(bytes: Uint8Array): string | null {
	if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
	if (ascii(bytes, 4, "ftyp")) {
		const brand = textOf(bytes, 8, 12);
		// Compatible brands follow the minor version (byte 12); `avif` among them makes an AVIF.
		const size = Math.min(
			((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
			64,
			bytes.length,
		);
		for (let at = 16; at + 4 <= size; at += 4) {
			const compatible = textOf(bytes, at, at + 4);
			if (compatible === "avif" || compatible === "avis") return "image/avif";
		}
		if (IMAGE_BRANDS[brand]) return IMAGE_BRANDS[brand];
		if (brand === "qt  ") return "video/quicktime";
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		return MP4_BRANDS.has(brand) ? "video/mp4" : null;
	}
	if (startsWith(bytes, 0, [0xff, 0x0a])) return "image/jxl";
	if (startsWith(bytes, 0, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
		return "image/jxl";
	}
	if (ascii(bytes, 0, "%PDF-")) return "application/pdf";
	if (startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
		return textOf(bytes, 4, 64).includes("webm") ? "video/webm" : "video/x-matroska";
	}
	if (ascii(bytes, 0, "OggS")) {
		// Only a first page that carries a Theora header is video.
		return textOf(bytes, 0, 128).includes("\x80theora") ? "video/ogg" : "audio/ogg";
	}
	if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
	// An MPEG audio frame: 11 sync bits, then layer III.
	if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2) return "audio/mpeg";
	return null;
}

/**
 * Whether the bytes start with `<` after a byte order mark and whitespace (HTML, SVG, XML), or
 * hold nothing but whitespace.
 */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
	let at = 0;
	if (startsWith(bytes, 0, [0xef, 0xbb, 0xbf])) at = 3;
	else if (startsWith(bytes, 0, [0xfe, 0xff]) || startsWith(bytes, 0, [0xff, 0xfe])) at = 2;
	// UTF-16 text has a zero byte beside each ASCII character.
	const skip = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
	// The whole buffer (already capped by the size limit): padding must not hide markup.
	while (at < bytes.length && skip.has(bytes[at] as number)) at++;
	// A file of nothing but whitespace is refused as well.
	return at >= bytes.length ? bytes.length > 0 : bytes[at] === 0x3c;
}

/** Audio and video types by URL extension, for a response that names no type. */
const EXTENSION_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	ogv: "video/ogg",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
};

function extensionOf(url: string): string {
	const path = new URL(url).pathname;
	const last = path.slice(path.lastIndexOf("/") + 1);
	const dot = last.lastIndexOf(".");
	return dot < 0 ? "" : last.slice(dot + 1).toLowerCase();
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/**
 * The file's type, decided by its bytes. Markup is refused whatever the header says. A type the
 * bytes show wins. Otherwise a `video/*` or `audio/*` `Content-Type` is taken, an image or PDF
 * header the bytes do not confirm is refused, and only a missing or `application/octet-stream`
 * header falls back to the URL's extension (audio and video only).
 */
export function mediaTypeOf(
	bytes: Uint8Array,
	contentType: string | null,
	url: string,
): { ok: true; mimeType: string } | { ok: false; message: string } {
	if (looksLikeMarkup(bytes)) {
		return { ok: false, message: "The file is markup (HTML, SVG or XML), which is never imported" };
	}
	const sniffed = sniffMime(bytes);
	if (sniffed !== null) return { ok: true, mimeType: sniffed };
	const header = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (header !== "" && !MEDIA_TYPE.test(header)) {
		return { ok: false, message: "The server sent a content type that is not valid" };
	}
	if (header.startsWith("video/") || header.startsWith("audio/")) {
		return { ok: true, mimeType: header };
	}
	if (header.startsWith("image/") || header === "application/pdf") {
		return { ok: false, message: "The type the server declared does not match the file" };
	}
	if (header === "" || header === "application/octet-stream") {
		const byExtension = EXTENSION_TYPES[extensionOf(url)];
		if (byExtension !== undefined) return { ok: true, mimeType: byExtension };
		return { ok: false, message: "The file's type could not be recognized" };
	}
	return { ok: false, message: "EmDash does not accept the type the server declared" };
}

/**
 * The extension EmDash stores the file under; the local storage adapter serves a file with the
 * type of its extension.
 */
const EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/jxl": ".jxl",
	"application/pdf": ".pdf",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
	"video/x-matroska": ".mkv",
	"video/ogg": ".ogv",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/mp4": ".m4a",
};

export const MAX_FILENAME_LENGTH = 100;

/**
 * The library filename: the URL's last path segment, percent-decoded and reduced to
 * `[A-Za-z0-9._-]`, at most 100 characters, `media` when nothing is left, with its extension
 * replaced by the canonical one for `mimeType` (`.bin` for a type without one).
 */
export function mediaFilename(url: string, mimeType: string): string {
	const path = new URL(url).pathname;
	let last = path.slice(path.lastIndexOf("/") + 1);
	try {
		last = decodeURIComponent(last);
	} catch {
		// Keep a segment that is not valid percent-encoding as it is.
	}
	const extension = EXTENSIONS[mimeType] ?? ".bin";
	const stem = last
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.[A-Za-z0-9]{1,10}$/, "")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, MAX_FILENAME_LENGTH - extension.length)
		.replace(/[.-]+$/, "");
	return `${stem === "" ? "media" : stem}${extension}`;
}
