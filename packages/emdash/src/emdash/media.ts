import { Buffer } from "node:buffer";
import { z } from "zod";
import {
	ContentWriteError,
	type MediaInfo,
	type MediaPort,
	MediaUploadError,
} from "../engine/ports.js";
import { type HandlerResult, writeError } from "./content.js";

/**
 * The runtime's media handlers this adapter calls (`emdash` src/emdash-runtime.ts:4795-4824);
 * the runtime is assignable to it.
 */
export interface MediaRuntime {
	handleMediaGet(id: string): Promise<HandlerResult>;
	handleMediaUpload(input: {
		filename: string;
		base64: string;
		contentType: string;
		alt?: string;
		authorId?: string;
		maxUploadSize?: number;
	}): Promise<HandlerResult>;
}

/** The parts of `MediaItem` (src/database/repositories/media.ts:57-76) the importer uses. */
const mediaItem = z.object({
	id: z.string(),
	filename: z.string(),
	mimeType: z.string(),
	size: z.number().nullable(),
	width: z.number().nullable(),
	height: z.number().nullable(),
	alt: z.string().nullable(),
	storageKey: z.string(),
	status: z.string(),
	blurhash: z.string().nullable().optional(),
	dominantColor: z.string().nullable().optional(),
});
const getResult = z.object({ item: mediaItem });
const uploadResult = z.object({ item: mediaItem, deduplicated: z.boolean().optional() });

function infoOf(item: z.infer<typeof mediaItem>): MediaInfo {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		size: item.size,
		width: item.width,
		height: item.height,
		alt: item.alt,
		storageKey: item.storageKey,
		blurhash: item.blurhash ?? null,
		dominantColor: item.dominantColor ?? null,
	};
}

/**
 * `MediaPort` over the trusted runtime. Uploads go through `handleMediaUpload`, which runs
 * EmDash's allowlist, size check, content-hash dedupe, storage write, image enrichment and the
 * media hooks; they are credited to `authorId` (to no one when it is `null`) and limited by the
 * site's `maxUploadSize`.
 */
export class EmDashMedia implements MediaPort {
	constructor(
		private readonly runtime: MediaRuntime,
		/** `null`: an unattended upload, with no author (spec Ruling 4). */
		private readonly authorId: string | null,
		private readonly maxUploadSize: number | undefined,
	) {}

	async get(id: string): Promise<MediaInfo | null> {
		const result = await this.runtime.handleMediaGet(id);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the media item", result.error);
		}
		const parsed = getResult.safeParse(result.data);
		if (!parsed.success) {
			throw new ContentWriteError(
				"emdash_bad_response",
				"Reading the media item: unexpected response from EmDash",
			);
		}
		const { item } = parsed.data;
		// A pending or failed upload has no stored file to point at.
		return item.status === "ready" ? infoOf(item) : null;
	}

	async upload(input: {
		filename: string;
		contentType: string;
		bytes: Uint8Array;
		alt?: string;
	}): Promise<{ item: MediaInfo; deduplicated: boolean }> {
		const { bytes } = input;
		const result = await this.runtime.handleMediaUpload({
			filename: input.filename,
			base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
			contentType: input.contentType,
			...(this.authorId === null ? {} : { authorId: this.authorId }),
			...(input.alt === undefined ? {} : { alt: input.alt }),
			...(this.maxUploadSize === undefined ? {} : { maxUploadSize: this.maxUploadSize }),
		});
		if (!result.success) {
			const code = result.error?.code ?? "UNKNOWN_ERROR";
			throw new MediaUploadError(code, result.error?.message ?? code);
		}
		const parsed = uploadResult.safeParse(result.data);
		if (!parsed.success) {
			throw new MediaUploadError("BAD_RESPONSE", "Unexpected response from EmDash");
		}
		return { item: infoOf(parsed.data.item), deduplicated: parsed.data.deduplicated === true };
	}
}
