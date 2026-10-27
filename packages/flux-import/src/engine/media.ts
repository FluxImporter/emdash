/**
 * Media from URL (M4c): conversion of `image` and `file` mappings to media requests, the URL
 * normalization the media map is keyed by, and EmDash's upload type rules.
 */
import { createHash } from "node:crypto";
import { parseSourceUrl } from "../sources/net.js";

/** Image and file mappings a template may have, so a record downloads at most this many files. */
export const MAX_MEDIA_MAPPINGS = 5;
export const MAX_ALT_LENGTH = 1000;
/** EmDash's default `maxUploadSize` (`DEFAULT_MAX_UPLOAD_SIZE`, src/api/schemas/media.ts:103). */
export const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

/**
 * EmDash's default upload allowlist (`GLOBAL_UPLOAD_ALLOWLIST`,
 * src/api/handlers/media-allowlist.ts:20-30): entries ending in `/` match as prefixes. SVG is
 * left out on purpose.
 */
export const UPLOAD_ALLOWLIST: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/jxl",
	"video/",
	"audio/",
	"application/pdf",
];

export type MediaKind = "image" | "file";

/** Errors from media conversion; resolution adds its own (`MediaErrorCode`). */
export type MediaConversionCode = "invalid_media_url" | "alt_too_long";

/** One media field of a record: the normalized URL to store and the alt text for this use. */
export type MediaRequest = {
	kind: MediaKind;
	/** Normalized (`normalizeMediaUrl`), the media map key's input. */
	url: string;
	/** Trimmed; null when empty. Images only. */
	alt: string | null;
	refresh: boolean;
};

/** EmDash's MIME normalization (`normalizeMime`, src/media/mime.ts:3-5). */
export function normalizeMime(mime: string): string {
	return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether `mime` is in `list`, as EmDash matches (`matchesMimeAllowlist`, src/media/mime.ts:7-19). */
export function matchesMime(mime: string, list: readonly string[]): boolean {
	const normalized = normalizeMime(mime);
	return list.some((entry) => {
		if (!entry.includes("/")) return false;
		const e = normalizeMime(entry);
		return e.endsWith("/") ? normalized.startsWith(e) : normalized === e;
	});
}

/**
 * Whether a field that accepts `allowed` can take anything EmDash's upload allows: some upload
 * type (an image type for an image mapping) is one of `allowed`, or an `allowed` prefix covers
 * one. Entries without a `/` match nothing, as in EmDash.
 */
export function acceptsUploadable(allowed: readonly string[], kind: MediaKind): boolean {
	const fits = (type: string) => kind === "file" || type.startsWith("image/");
	return allowed.some((entry) => {
		if (!entry.includes("/")) return false;
		const e = normalizeMime(entry);
		return UPLOAD_ALLOWLIST.some((u) => {
			if (!fits(u)) return false;
			if (e.endsWith("/")) return u.startsWith(e) || e.startsWith(u);
			return u.endsWith("/") ? e.startsWith(u) : e === u;
		});
	});
}

/**
 * Why a stored type cannot go into the field, or null when it can: EmDash's upload allowlist, an
 * image type for an image mapping, and the field's `allowedMimeTypes` (enforced again on save).
 */
export function mediaTypeProblem(
	mime: string,
	kind: MediaKind,
	allowed: readonly string[] | undefined,
): string | null {
	const type = normalizeMime(mime);
	if (!matchesMime(type, UPLOAD_ALLOWLIST)) return `EmDash does not accept ${type} uploads`;
	if (kind === "image" && !type.startsWith("image/")) {
		return `An image field cannot take ${type}`;
	}
	if (allowed !== undefined && allowed.length > 0 && !matchesMime(type, allowed)) {
		return `The field accepts only ${allowed.join(", ")}, not ${type}`;
	}
	return null;
}

/** `%xx` for an unreserved character (RFC 3986: ALPHA, DIGIT, `-`, `.`, `_`, `~`) becomes the character. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * The media map's form of a URL: the fragment is dropped first (so it never counts toward the
 * length), then `parseSourceUrl` (http or https, no user name or password, at most 2,048
 * characters), then the WHATWG serialization. `URL` lower-cases the host and drops a default port;
 * percent-encoding in the path and query is normalized here: every `%xx` has upper-case hex digits
 * and one for an unreserved character is decoded, so `%7e`, `%7E` and `~` give one URL. Reserved
 * characters stay encoded and the query stays as given otherwise.
 */
export function normalizeMediaUrl(
	text: string,
): { ok: true; url: string } | { ok: false; message: string } {
	try {
		const hash = text.indexOf("#");
		const url = parseSourceUrl(hash === -1 ? text : text.slice(0, hash));
		url.hash = "";
		const href = url.href.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
			const char = String.fromCharCode(Number.parseInt(hex, 16));
			return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
		});
		return { ok: true, url: href };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}

/** The media map key of a normalized URL: `u` and the SHA-256 of the URL, in hex. */
export function mediaMapKey(url: string): string {
	return `u${createHash("sha256").update(url).digest("hex")}`;
}

type MediaConverted =
	| { ok: true; value: string | null }
	| { ok: false; code: "not_scalar" | MediaConversionCode; message: string };

function kindOf(raw: unknown): string {
	if (Array.isArray(raw)) return "an array";
	return typeof raw === "object" ? "an object" : `a ${typeof raw}`;
}

/**
 * A media URL: a missing path, `null` or blank text is empty (null). Anything but text fails
 * `not_scalar`, numbers and booleans included. Text is trimmed and normalized.
 */
export function mediaUrlConverter(raw: unknown): MediaConverted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw !== "string") {
		return {
			ok: false,
			code: "not_scalar",
			message: `Expected a URL as text, found ${kindOf(raw)}`,
		};
	}
	const text = raw.trim();
	if (text === "") return { ok: true, value: null };
	const normalized = normalizeMediaUrl(text);
	if (!normalized.ok) {
		return { ok: false, code: "invalid_media_url", message: normalized.message };
	}
	return { ok: true, value: normalized.url };
}

/**
 * Alt text: a scalar as text (numbers and booleans as their string), trimmed; empty is no alt.
 * Objects and arrays fail `not_scalar`, more than 1,000 characters `alt_too_long`.
 */
export function altConverter(raw: unknown): MediaConverted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw === "object") {
		return { ok: false, code: "not_scalar", message: `Expected alt text, found ${kindOf(raw)}` };
	}
	const text = String(raw).trim();
	if (text.length > MAX_ALT_LENGTH) {
		return {
			ok: false,
			code: "alt_too_long",
			message: `The alt text has ${text.length} characters; at most ${MAX_ALT_LENGTH} are allowed`,
		};
	}
	return { ok: true, value: text === "" ? null : text };
}
