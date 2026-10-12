import { createHash } from "node:crypto";
import type { Storage } from "emdash";
import { ulid } from "emdash";
import { SourceMissingError, type SourcePort } from "../engine/ports.js";
import { emdashErrorCode } from "./errors.js";
import { fixedLengthStream } from "./workers.js";

/**
 * Staged source files live in `emdash.storage`, which serves every key outside `backups/` and
 * `transfers/` publicly at `/_emdash/api/media/file/<key>` (verification report, question 7).
 * The upload ID is therefore a secret: a ULID plus 128 random bits, returned only to the
 * authenticated uploader and to `import:execute` routes.
 *
 * Keys are flat (no `/`): the local adapter's `list()` splits a prefix into a directory and a file
 * name prefix (src/storage/local.ts:175-200), so a prefix ending in `/` would list the parent.
 */
export const UPLOAD_PREFIX = "flux-import-upload-";
const UPLOAD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}$/;
const PAGE = 100;

export type UploadStorage = Pick<Storage, "upload" | "download" | "delete" | "list">;

export function newUploadId(): string {
	const random = crypto.getRandomValues(new Uint8Array(16));
	return ulid() + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isUploadId(value: string): boolean {
	return UPLOAD_ID_RE.test(value);
}

/** Never builds a key from an unchecked ID, so input cannot reach another storage path. */
export function uploadKey(uploadId: string): string {
	if (!isUploadId(uploadId)) throw new SourceMissingError(uploadId);
	return `${UPLOAD_PREFIX}${uploadId}.csv`;
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

export class UploadTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`The upload exceeds the limit of ${limit} bytes`);
		this.name = "UploadTooLargeError";
	}
}

/** On Workers an upload must declare its length (see `stageUpload`). */
export class LengthRequiredError extends Error {
	constructor() {
		super("Uploads require a Content-Length header");
		this.name = "LengthRequiredError";
	}
}

export class EmDashUploads implements SourcePort {
	constructor(private readonly storage: UploadStorage) {}

	async open(uploadId: string, offset: number): Promise<ReadableStream<Uint8Array>> {
		const key = uploadKey(uploadId);
		let result: Awaited<ReturnType<UploadStorage["download"]>>;
		try {
			result = await this.storage.download(key, offset > 0 ? { range: { offset } } : undefined);
		} catch (e) {
			// The local adapter throws EmDashStorageError("…", "NOT_FOUND") (src/storage/local.ts:118).
			if (emdashErrorCode(e) === "NOT_FOUND") throw new SourceMissingError(uploadId);
			throw e;
		}
		// An offset at or past the end returns the whole file without `range`
		// (src/storage/range.ts:52-53), so check the size before trusting the body.
		if (offset >= result.size) {
			await result.body.cancel();
			return emptyStream();
		}
		if (offset > 0 && result.range?.offset !== offset) {
			await result.body.cancel();
			throw new Error(
				`Storage ignored the byte range starting at ${offset} for upload ${uploadId}`,
			);
		}
		return result.body;
	}

	async delete(uploadId: string): Promise<void> {
		try {
			await this.storage.delete(uploadKey(uploadId));
		} catch (e) {
			if (emdashErrorCode(e) !== "NOT_FOUND") throw e;
		}
	}

	/**
	 * Deletes staged files last modified before `cutoff`, including ones no job references.
	 * Files whose upload ID is in `keep` are left alone.
	 */
	async purgeBefore(cutoff: Date, keep: ReadonlySet<string> = new Set()): Promise<number> {
		const kept = new Set([...keep].map((id) => uploadKey(id)));
		const expired: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.storage.list({
				prefix: UPLOAD_PREFIX,
				limit: PAGE,
				...(cursor ? { cursor } : {}),
			});
			for (const file of page.files) {
				if (file.lastModified.getTime() < cutoff.getTime() && !kept.has(file.key)) {
					expired.push(file.key);
				}
			}
			cursor = page.nextCursor;
		} while (cursor);
		for (const key of expired) await this.storage.delete(key);
		return expired.length;
	}
}

export interface StagedUpload {
	uploadId: string;
	bytes: number;
	sha256: string;
}

/**
 * Streams `body` into storage under a new upload ID, counting and hashing on the way and failing
 * once more than `maxBytes` arrive. The local adapter buffers the stream before writing
 * (src/storage/local.ts:84-94), so an oversized upload writes nothing there; the key is still
 * deleted on failure for adapters that might write partially.
 *
 * On Workers, R2 `put()` (@emdash-cms/cloudflare src/storage/r2.ts:55-83 passes the body
 * straight to the binding) rejects a stream of unknown length, so the counted stream goes through
 * `FixedLengthStream`. Without a declared length it throws `LengthRequiredError` before reading:
 * buffering would hold about twice `maxBytes` in a 128 MB isolate.
 */
export async function stageUpload(
	storage: UploadStorage,
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	declaredLength?: number,
): Promise<StagedUpload> {
	if (declaredLength !== undefined && declaredLength > maxBytes) {
		throw new UploadTooLargeError(maxBytes);
	}
	const FixedLength = fixedLengthStream();
	if (FixedLength && declaredLength === undefined) throw new LengthRequiredError();
	const uploadId = newUploadId();
	const key = uploadKey(uploadId);
	const hash = createHash("sha256");
	let bytes = 0;
	const counted = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > maxBytes) {
					controller.error(new UploadTooLargeError(maxBytes));
					return;
				}
				hash.update(chunk);
				controller.enqueue(chunk);
			},
		}),
	);
	try {
		const upload =
			FixedLength && declaredLength !== undefined
				? counted.pipeThrough(new FixedLength(declaredLength))
				: counted;
		await storage.upload({ key, body: upload, contentType: "text/csv" });
	} catch (e) {
		await storage.delete(key).catch(() => {});
		if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes);
		throw e;
	}
	return { uploadId, bytes, sha256: hash.digest("hex") };
}
