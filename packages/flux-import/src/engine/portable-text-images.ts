/**
 * Portable Text images (M4d): each distinct image URL of a record is looked up in the media map
 * and, in a real run, obtained through the M4c resolver with the batch's cache, budget and
 * deadline. Then each field's image slots become image blocks that reference the items.
 */
import { type PortableTextPlanItem, portableTextSummary } from "./diff.js";
import {
	findMedia,
	type MediaContext,
	MediaDeferred,
	type MediaDeps,
	type MediaLookup,
	obtainMedia,
} from "./media.js";
import type { PortableTextDraft, PortableTextOptions } from "./portable-text.js";
import { shownUrl } from "./portable-text.js";
import type { MediaInfo } from "./ports.js";
import type { LinkError, LookupCache } from "./resolve.js";
import type { JsonValue } from "./values.js";

/** EmDash's internal path for a local media file (`buildRenderMediaUrl` maps it; spec F7). */
export const MEDIA_FILE_PATH = "/_emdash/api/media/file/";

/** A record's Portable Text images, by normalized URL. */
export type RecordImages = {
	/** Each URL looked up, in document order, with the first field that uses it. */
	readonly lookups: Map<string, { field: string; failField: string | null; lookup: MediaLookup }>;
	/** The item each URL resolved to: map hits from the lookup, downloads once obtained. */
	readonly items: Map<string, MediaInfo>;
	/** URLs left out of the blocks (`imageErrors: "drop"`). */
	readonly dropped: Set<string>;
};

/** A dropped image's warning: its M4c code, then the URL and the reason. */
function dropWarning(field: string, url: string, error: LinkError): LinkError {
	return { field, code: "image_dropped", message: `${error.code}: ${namedMessage(url, error)}` };
}

/** An error's message with the image URL in front, unless it already starts with it. */
function namedMessage(url: string, error: LinkError): string {
	return error.message.startsWith(url) ? error.message : `${shownUrl(url)}: ${error.message}`;
}

/** A failure that fails the record: its code, the field that asked for it, the URL and reason. */
const failError = (field: string, url: string, error: LinkError): LinkError => ({
	field,
	code: error.code,
	message: namedMessage(url, error),
});

/** The first field using the URL whose `imageErrors` is `"fail"`, if any. */
function failFieldOf(
	drafts: Readonly<Record<string, PortableTextDraft | null>>,
	options: ReadonlyMap<string, PortableTextOptions>,
	url: string,
): string | null {
	for (const [field, draft] of Object.entries(drafts)) {
		if (options.get(field)?.imageErrors === "fail" && draft?.images.some((i) => i.url === url)) {
			return field;
		}
	}
	return null;
}

/** The most failed URLs a deferral carries to the next batch. */
const MAX_CARRIED_FAILURES = 50;

/**
 * Looks every distinct image URL of the record's Portable Text up, without the network, as an
 * image request with the image's alt and no refresh. A lookup error fails the record when the
 * field's `imageErrors` is `"fail"`; otherwise the image is dropped with an `image_dropped`
 * warning.
 */
export async function lookupPortableTextImages(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	drafts: Readonly<Record<string, PortableTextDraft | null>>,
	options: ReadonlyMap<string, PortableTextOptions>,
): Promise<{ images: RecordImages; errors: LinkError[]; warnings: LinkError[] }> {
	const images: RecordImages = { lookups: new Map(), items: new Map(), dropped: new Set() };
	const errors: LinkError[] = [];
	const warnings: LinkError[] = [];
	const seen = new Set<string>();
	for (const [field, draft] of Object.entries(drafts)) {
		for (const image of draft?.images ?? []) {
			if (seen.has(image.url)) continue;
			seen.add(image.url);
			const request = { kind: "image" as const, url: image.url, alt: image.alt, refresh: false };
			const found = await findMedia(deps, cache, ctx, field, request);
			const failField = failFieldOf(drafts, options, image.url);
			if (found.ok) {
				images.lookups.set(image.url, { field, failField, lookup: found.lookup });
				if (found.lookup.item) images.items.set(image.url, found.lookup.item);
			} else if (failField !== null) errors.push(failError(failField, image.url, found.error));
			else {
				warnings.push(dropWarning(field, image.url, found.error));
				images.dropped.add(image.url);
			}
		}
	}
	return { images, errors, warnings };
}

/**
 * Obtains every image not stored yet, in document order, one download at a time: a failure
 * stops the record when its field's `imageErrors` is `"fail"`, and is dropped with a warning
 * otherwise. Each download is added to `newMedia` (`content: https://…`). A `MediaDeferred`
 * carries `newMedia`, which the caller starts with the record's field media, and every URL this
 * call downloaded and dropped (at most 50), so the next batch drops them again without a download.
 */
export async function obtainPortableTextImages(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	images: RecordImages,
	newMedia: string[],
): Promise<
	{ ok: true; warnings: LinkError[] } | { ok: false; errors: LinkError[]; warnings: LinkError[] }
> {
	const warnings: LinkError[] = [];
	// Every download this call tried and dropped, whatever its cause (a type refusal is not always
	// kept in `cache.mediaFailed`), carried to the next batch on a deferral. A refusal without a
	// download (a file another field obtained, or a failure an earlier record cached) is not: the
	// next batch must not hold it against a field that can take the file.
	const dropped: { key: string; error: LinkError }[] = [];
	for (const [url, { field, failField, lookup }] of images.lookups) {
		if (images.items.has(url)) continue;
		const downloads = cache.mediaDownloads;
		let obtained: Awaited<ReturnType<typeof obtainMedia>>;
		try {
			obtained = await obtainMedia(deps, cache, ctx, lookup);
		} catch (e) {
			if (e instanceof MediaDeferred) {
				e.newMedia = newMedia;
				// What failed for good stays failed in the next batch, which would defer at the same
				// point again otherwise.
				e.failed = dropped.slice(0, MAX_CARRIED_FAILURES);
			}
			throw e;
		}
		if (obtained.ok) {
			images.items.set(url, obtained.item);
			if (obtained.downloaded) newMedia.push(`${field}: ${url}`);
		} else if (failField !== null) {
			return { ok: false, errors: [failError(failField, url, obtained.error)], warnings };
		} else {
			warnings.push(dropWarning(field, url, obtained.error));
			images.dropped.add(url);
			if (cache.mediaDownloads > downloads)
				dropped.push({ key: lookup.key, error: obtained.error });
		}
	}
	return { ok: true, warnings };
}

/** The image block EmDash's editor writes for a library image (spec F8), from a draft block. */
function imageBlock(
	draft: { [key: string]: JsonValue },
	item: MediaInfo,
): { [key: string]: JsonValue } {
	const { slot: _slot, alt, caption, link, ...rest } = draft;
	return {
		...rest,
		asset: { _ref: item.id, url: `${MEDIA_FILE_PATH}${item.storageKey}` },
		...(alt === undefined ? {} : { alt }),
		...(caption === undefined ? {} : { caption }),
		...(item.width === null ? {} : { width: item.width }),
		...(item.height === null ? {} : { height: item.height }),
		...(link === undefined ? {} : { link }),
	};
}

/**
 * Each field's assembled value: an image slot becomes its image block, a dropped one is left
 * out, and one whose item is not stored yet counts as pending (the field is then a change). A
 * field left with no block is empty (null).
 */
export function portableTextPlan(
	drafts: Readonly<Record<string, PortableTextDraft | null>>,
	images: RecordImages,
): Record<string, PortableTextPlanItem | null> {
	const plan: Record<string, PortableTextPlanItem | null> = {};
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null) {
			plan[field] = null;
			continue;
		}
		const blocks: JsonValue[] = [];
		let pending = 0;
		for (const block of draft.blocks) {
			if (block._type !== "image") {
				blocks.push(block);
				continue;
			}
			const url = draft.images[block.slot as number]?.url ?? "";
			if (images.dropped.has(url)) continue;
			const item = images.items.get(url);
			if (item === undefined) pending++;
			else blocks.push(imageBlock(block, item));
		}
		plan[field] =
			blocks.length === 0 && pending === 0
				? null
				: { blocks, pending, text: portableTextSummary(blocks, pending) };
	}
	return plan;
}
