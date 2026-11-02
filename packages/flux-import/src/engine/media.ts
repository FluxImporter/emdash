/**
 * Media from URL (M4c): conversion of `image` and `file` mappings to media requests, the URL
 * normalization the media map is keyed by, EmDash's upload type rules, and the resolver that
 * turns a request into a media item: a media map hit, or a download and upload.
 */
import { createHash } from "node:crypto";
import { MediaError, mediaFilename, mediaTypeOf } from "../sources/media-fetch.js";
import { parseSourceUrl } from "../sources/net.js";
import { ContentWriteError, type MediaInfo, MediaUploadError } from "./ports.js";
import { COST_CALL, COST_MEDIA, type LinkError, type LookupCache } from "./resolve.js";
import type { EngineDeps, MediaMapRow } from "./types.js";
import type { JsonValue, TargetField } from "./values.js";

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

/** The least time a download other than the batch's first may start with. */
export const MEDIA_MIN_LEFT_MS = 5000;

export type MediaDeps = Pick<EngineDeps, "media" | "mediaFetcher" | "mediaMap" | "now">;

/** What the resolver needs from the job. */
export type MediaContext = {
	jobId: string;
	dryRun: boolean;
	/** The job's `mediaMaxBytes`. */
	maxBytes: number;
	/** The job's target field snapshot: each media field's `allowedMimeTypes`. */
	targets: Readonly<Record<string, TargetField>>;
};

/** One media field after the map lookup. */
export type MediaLookup = {
	field: string;
	request: MediaRequest;
	/** `mediaMapKey(request.url)`. */
	key: string;
	/** The ready item the URL became, or null when the map has none (a miss). */
	item: MediaInfo | null;
	/** The map row of a hit. */
	row: MediaMapRow | null;
};

/**
 * Thrown when the batch has no time left for the record's next download: the batch ends
 * before the record, which the next batch processes again. Media already stored is in the map.
 */
export class MediaDeferred extends Error {
	/** The record's media (`field: url`) downloaded before the deferral. */
	newMedia: string[] = [];
	/** The record's downloads that failed for good (media map key and error), kept for the retry. */
	failed: { key: string; error: LinkError }[] = [];
	constructor() {
		super("No time left in this batch for the next download");
		this.name = "MediaDeferred";
	}
}

const fieldError = (field: string, code: string, message: string): LinkError => ({
	field,
	code,
	message,
});

/** A media item by ID, read once per batch; null when it is missing or not ready. */
async function mediaItem(
	deps: MediaDeps,
	cache: LookupCache,
	id: string,
): Promise<MediaInfo | null> {
	if (cache.mediaItems.has(id)) return cache.mediaItems.get(id) ?? null;
	cache.spend(COST_CALL);
	const item = await deps.media.get(id);
	cache.mediaItems.set(id, item);
	return item;
}

/**
 * Looks one request up, without the network: the host check (`media_blocked`), then the media
 * map and the item it names. A map row whose item is missing or not ready is a miss, and a real
 * run drops it. A hit must still fit the field (`media_type_not_allowed`).
 */
export async function findMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	field: string,
	request: MediaRequest,
): Promise<{ ok: true; lookup: MediaLookup } | { ok: false; error: LinkError }> {
	try {
		deps.mediaFetcher.checkHost(request.url);
		const key = mediaMapKey(request.url);
		cache.spend(COST_CALL);
		const row = await deps.mediaMap.get(key);
		const item = row ? await mediaItem(deps, cache, row.mediaId) : null;
		if (row && !item && !ctx.dryRun) await deps.mediaMap.delete(key);
		if (item) {
			const problem = mediaTypeProblem(
				item.mimeType,
				request.kind,
				ctx.targets[field]?.allowedMimeTypes,
			);
			if (problem !== null) {
				return {
					ok: false,
					error: fieldError(field, "media_type_not_allowed", `${request.url}: ${problem}`),
				};
			}
		}
		return { ok: true, lookup: { field, request, key, item, row: item ? row : null } };
	} catch (e) {
		// A blocked host, or EmDash failing to read the item, fails the record, not the job.
		if (e instanceof MediaError || e instanceof ContentWriteError) {
			return { ok: false, error: fieldError(field, e.code, e.message) };
		}
		throw e;
	}
}

/**
 * EmDash's upload errors as record errors. A missing storage or an invalid `maxUploadSize`
 * would fail every upload, so it fails the job (`media_config`).
 */
function uploadError(field: string, e: MediaUploadError): LinkError {
	switch (e.code) {
		case "CONFIGURATION_ERROR":
		case "NO_STORAGE":
			throw new ContentWriteError("media_config", `EmDash cannot store media: ${e.message}`);
		case "PAYLOAD_TOO_LARGE":
			return fieldError(field, "media_too_large", `EmDash refused the upload: ${e.message}`);
		case "INVALID_TYPE":
			return fieldError(field, "media_type_not_allowed", `EmDash refused the upload: ${e.message}`);
		default:
			return fieldError(
				field,
				"media_upload_failed",
				`EmDash refused the upload (${e.code}): ${e.message}`,
			);
	}
}

/**
 * The item for a looked-up request in a real run: a hit as it is, or a download (a conditional
 * one for a hit with `refresh`), whose type comes from its bytes, uploaded through EmDash and
 * written to the media map before anything else. Throws `MediaDeferred` when a download other
 * than the batch's first would start with less than `MEDIA_MIN_LEFT_MS` left, or would bring
 * the batch's lookup cost past its budget (M4d).
 */
export async function obtainMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	lookup: MediaLookup,
): Promise<{ ok: true; item: MediaInfo; downloaded: boolean } | { ok: false; error: LinkError }> {
	const { field, request, item: hit, row } = lookup;
	// An item reused for another field must still fit that field.
	const reuse = (
		item: MediaInfo,
	): { ok: true; item: MediaInfo; downloaded: false } | { ok: false; error: LinkError } => {
		const problem = mediaTypeProblem(
			item.mimeType,
			request.kind,
			ctx.targets[field]?.allowedMimeTypes,
		);
		return problem === null
			? { ok: true, item, downloaded: false }
			: {
					ok: false,
					error: fieldError(field, "media_type_not_allowed", `${request.url}: ${problem}`),
				};
	};
	const obtained = cache.mediaObtained.get(lookup.key);
	if (obtained) return reuse(obtained);
	const failedBefore = cache.mediaFailed.get(lookup.key);
	if (failedBefore) return { ok: false, error: { ...failedBefore, field } };
	// A file is refreshed at most once per job: a batch that defers the record's next download
	// would otherwise download it again, and never get past it.
	if (hit && (!request.refresh || row?.jobId === ctx.jobId)) {
		return { ok: true, item: hit, downloaded: false };
	}
	const now = deps.now();
	const first = cache.mediaDownloads === 0;
	const late = cache.mediaDeadline - now < MEDIA_MIN_LEFT_MS;
	if (!first && (late || cache.spent + COST_MEDIA > cache.budget)) throw new MediaDeferred();
	cache.mediaDownloads++;
	cache.spend(COST_MEDIA);
	try {
		const fetched = await deps.mediaFetcher.fetch(request.url, {
			kind: request.kind,
			maxBytes: ctx.maxBytes,
			// The batch's first download always gets its chance, so every batch makes progress.
			deadline: first
				? Math.max(cache.mediaDeadline, now + MEDIA_MIN_LEFT_MS)
				: cache.mediaDeadline,
			...(hit && row?.etag !== undefined ? { etag: row.etag } : {}),
			...(hit && row?.lastModified !== undefined ? { lastModified: row.lastModified } : {}),
		});
		if (fetched.status === 304) {
			if (hit) {
				if (row) {
					await deps.mediaMap.put(lookup.key, {
						...row,
						fetchedAt: new Date(deps.now()).toISOString(),
						jobId: ctx.jobId,
					});
				}
				cache.mediaObtained.set(lookup.key, hit);
				return reuse(hit);
			}
			return {
				ok: false,
				error: fieldError(field, "media_http_error", "The server answered HTTP 304"),
			};
		}
		const type = mediaTypeOf(fetched.bytes, fetched.contentType, fetched.finalUrl);
		const problem = type.ok
			? mediaTypeProblem(type.mimeType, request.kind, ctx.targets[field]?.allowedMimeTypes)
			: type.message;
		if (!type.ok || problem !== null) {
			return {
				ok: false,
				error: fieldError(field, "media_type_not_allowed", `${request.url}: ${problem}`),
			};
		}
		const { item, deduplicated } = await deps.media.upload({
			filename: mediaFilename(fetched.finalUrl, type.mimeType),
			contentType: type.mimeType,
			bytes: fetched.bytes,
			...(request.alt === null ? {} : { alt: request.alt }),
		});
		cache.mediaItems.set(item.id, item);
		await deps.mediaMap.put(lookup.key, {
			url: request.url,
			mediaId: item.id,
			storageKey: item.storageKey,
			mimeType: item.mimeType,
			bytes: fetched.bytes.byteLength,
			...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
			...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
			fetchedAt: new Date(deps.now()).toISOString(),
			jobId: ctx.jobId,
			// Sticky: a refresh that stores the same bytes again must not forget that the file was ours.
			created: !deduplicated || (row?.mediaId === item.id && row.created === true),
		});
		cache.mediaObtained.set(lookup.key, item);
		// A dedupe can return an item stored with another type than the one just checked.
		const stored = mediaTypeProblem(
			item.mimeType,
			request.kind,
			ctx.targets[field]?.allowedMimeTypes,
		);
		if (stored !== null) {
			return {
				ok: false,
				error: fieldError(field, "media_type_not_allowed", `${request.url}: ${stored}`),
			};
		}
		return { ok: true, item, downloaded: true };
	} catch (e) {
		// A download cut short by the batch's deadline is not the file's fault: the next batch retries.
		if (e instanceof MediaError && e.deadline && !first) throw new MediaDeferred();
		let error: LinkError;
		if (e instanceof MediaError) error = fieldError(field, e.code, e.message);
		else if (e instanceof MediaUploadError) error = uploadError(field, e);
		else throw e;
		// A failing URL shared by many records is fetched once per batch.
		cache.mediaFailed.set(lookup.key, error);
		return { ok: false, error };
	}
}

/**
 * Resolves one media request: the map lookup, then in a real run the download and upload when
 * it is a miss (or a hit with `refresh`). A dry run gives `item: null` for a miss. This is the
 * resolver M4d calls for each Portable Text image URL; it shares the batch's cache, budget and
 * deadline.
 */
export async function resolveMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	field: string,
	request: MediaRequest,
): Promise<
	{ ok: true; item: MediaInfo | null; downloaded: boolean } | { ok: false; error: LinkError }
> {
	const found = await findMedia(deps, cache, ctx, field, request);
	if (!found.ok) return found;
	if (ctx.dryRun) return { ok: true, item: found.lookup.item, downloaded: false };
	return obtainMedia(deps, cache, ctx, found.lookup);
}

/** Every media field of a record looked up; all errors are collected. */
export async function lookupRecordMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	requests: Readonly<Record<string, MediaRequest | null>>,
): Promise<{ lookups: Record<string, MediaLookup | null>; errors: LinkError[] }> {
	const lookups: Record<string, MediaLookup | null> = {};
	const errors: LinkError[] = [];
	for (const [field, request] of Object.entries(requests)) {
		if (request === null) {
			lookups[field] = null;
			continue;
		}
		const found = await findMedia(deps, cache, ctx, field, request);
		if (found.ok) lookups[field] = found.lookup;
		else errors.push(found.error);
	}
	return { lookups, errors };
}

/** A media field resolved in a real run; null for an empty value. */
export type ResolvedMedia = { request: MediaRequest; item: MediaInfo } | null;

/**
 * Obtains every looked-up field's item in a real run, one download at a time, stopping at the
 * first failure. `newMedia` lists each field and URL downloaded (`photo: https://…`), also when
 * the upload found identical bytes already stored.
 */
export async function obtainRecordMedia(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	lookups: Readonly<Record<string, MediaLookup | null>>,
): Promise<
	| { ok: true; media: Record<string, ResolvedMedia>; newMedia: string[] }
	| { ok: false; errors: LinkError[]; newMedia: string[] }
> {
	const media: Record<string, ResolvedMedia> = {};
	const newMedia: string[] = [];
	for (const [field, lookup] of Object.entries(lookups)) {
		if (lookup === null) {
			media[field] = null;
			continue;
		}
		let obtained: Awaited<ReturnType<typeof obtainMedia>>;
		try {
			obtained = await obtainMedia(deps, cache, ctx, lookup);
		} catch (e) {
			if (e instanceof MediaDeferred) e.newMedia = newMedia;
			throw e;
		}
		if (!obtained.ok) return { ok: false, errors: [obtained.error], newMedia };
		if (obtained.downloaded) newMedia.push(`${field}: ${lookup.request.url}`);
		media[field] = { request: lookup.request, item: obtained.item };
	}
	return { ok: true, media, newMedia };
}

/**
 * The value an image or file field stores for a media item (EmDash's documented shape, F1).
 * Local media keeps its storage key in `meta`; `src` is never sent. A file value has no `size`,
 * which EmDash 1.2.0 drops on save (Fact V3).
 */
export function mediaFieldValue(
	kind: MediaKind,
	item: MediaInfo,
	alt: string | null,
): { [key: string]: JsonValue } {
	const base = {
		id: item.id,
		provider: "local",
		filename: item.filename,
		mimeType: item.mimeType,
	};
	const meta = { storageKey: item.storageKey };
	if (kind === "file") return { ...base, meta };
	return {
		...base,
		...(item.width === null ? {} : { width: item.width }),
		...(item.height === null ? {} : { height: item.height }),
		...(item.blurhash === null ? {} : { blurhash: item.blurhash }),
		...(item.dominantColor === null ? {} : { dominantColor: item.dominantColor }),
		...(alt === null ? {} : { alt }),
		meta,
	};
}
