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
	readonly lookups: Map<string, { field: string; lookup: MediaLookup }>;
	/** The item each URL resolved to: map hits from the lookup, downloads once obtained. */
	readonly items: Map<string, MediaInfo>;
	/** URLs left out of the blocks (`imageErrors: "drop"`). */
	readonly dropped: Set<string>;
};

/** A dropped image's warning: its M4c code, then the URL and the reason. */
function dropWarning(field: string, url: string, error: LinkError): LinkError {
	const message = error.message.startsWith(url)
		? error.message
		: `${shownUrl(url)}: ${error.message}`;
	return { field, code: "image_dropped", message: `${error.code}: ${message}` };
}

const failsOn = (options: ReadonlyMap<string, PortableTextOptions>, field: string) =>
	options.get(field)?.imageErrors === "fail";

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
			if (found.ok) {
				images.lookups.set(image.url, { field, lookup: found.lookup });
				if (found.lookup.item) images.items.set(image.url, found.lookup.item);
			} else if (failsOn(options, field)) errors.push(found.error);
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
 * carries `newMedia`, which the caller starts with the record's field media.
 */
export async function obtainPortableTextImages(
	deps: MediaDeps,
	cache: LookupCache,
	ctx: MediaContext,
	images: RecordImages,
	options: ReadonlyMap<string, PortableTextOptions>,
	newMedia: string[],
): Promise<
	{ ok: true; warnings: LinkError[] } | { ok: false; errors: LinkError[]; warnings: LinkError[] }
> {
	const warnings: LinkError[] = [];
	for (const [url, { field, lookup }] of images.lookups) {
		if (images.items.has(url)) continue;
		let obtained: Awaited<ReturnType<typeof obtainMedia>>;
		try {
			obtained = await obtainMedia(deps, cache, ctx, lookup);
		} catch (e) {
			if (e instanceof MediaDeferred) e.newMedia = newMedia;
			throw e;
		}
		if (obtained.ok) {
			images.items.set(url, obtained.item);
			if (obtained.downloaded) newMedia.push(`${field}: ${url}`);
		} else if (failsOn(options, field)) return { ok: false, errors: [obtained.error], warnings };
		else {
			warnings.push(dropWarning(field, url, obtained.error));
			images.dropped.add(url);
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
