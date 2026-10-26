import {
	EmDashUploads,
	type StagedUpload,
	stageUpload,
	type UploadStorage,
	UploadTooLargeError,
} from "../emdash/uploads.js";
import { fetchError, guardedFetch, type NetOptions, UrlSourceError, whenAborted } from "./net.js";

export const MIB = 1024 * 1024;

export interface FetchLimits {
	/** `maxSourceBytes`, the upload limit. */
	maxBytes: number;
	/** Until the final response's headers arrive, DNS and redirects included. */
	headersMs: number;
	/** For the whole download. */
	totalMs: number;
	/** Workers only: the most a body of unknown length may be buffered to learn its length. */
	bufferBytes: number;
}

export const FETCH_LIMITS = {
	headersMs: 15_000,
	totalMs: 120_000,
	bufferBytes: 32 * MIB,
} as const satisfies Omit<FetchLimits, "maxBytes">;

/** What a successful fetch saves on the source. */
export interface LastFetch {
	at: string;
	/** HTTP status of the final response. */
	status: number;
	etag?: string;
	lastModified?: string;
	sha256: string;
	bytes: number;
	uploadId: string;
}

export interface Credential {
	header: string;
	value: string;
}

export interface DownloadInput {
	url: string;
	credential?: Credential;
	/** The source's last successful fetch. */
	previous?: LastFetch;
	/** Skip the conditional headers and the hash comparison. */
	force: boolean;
}

export interface DownloadResult {
	changed: boolean;
	fetch: LastFetch;
}

export interface FetcherDeps {
	storage: UploadStorage;
	net: NetOptions;
	limits: FetchLimits;
	/** Workers: storage needs the body's length up front (R2 through `FixedLengthStream`). */
	workers: boolean;
	now: () => number;
}

/** The declared length, or `undefined` when there is none or it does not describe the body. */
function bodyLength(headers: Headers): number | undefined {
	const encoding = headers.get("content-encoding");
	// fetch() decodes a compressed body, so its Content-Length no longer matches (Fact W1).
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
	const text = headers.get("content-length");
	if (text === null || !/^\d+$/.test(text.trim())) return undefined;
	const length = Number(text.trim());
	return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Passes `body` through until `signal` aborts. Any failure while reading becomes a
 * `UrlSourceError` (`FETCH_FAILED`, or the timeout that aborted the signal), recorded in
 * `failure.error` because storage adapters wrap stream errors in their own
 * (`EmDashStorageError` "UPLOAD_FAILED" from LocalStorage and R2), so the caller can still tell
 * a broken download from a storage error.
 */
function guardBody(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	failure: { error?: UrlSourceError },
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const aborted = whenAborted(signal);
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await Promise.race([reader.read(), aborted]);
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (e) {
					reader.cancel().catch(() => {});
					failure.error = fetchError(e, signal, "The download failed");
					controller.error(failure.error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

const tooLarge = (limit: number) =>
	new UrlSourceError("TOO_LARGE", `The response is larger than the limit of ${limit} bytes`);

/**
 * Workers, unknown length: reads the body into memory (at most `bufferBytes`), then stages it
 * with its length. Larger bodies fail with `LENGTH_REQUIRED`, or `TOO_LARGE` past `maxBytes`.
 * Chunks are handed to storage as they are, and dropped as storage reads them, so the body is
 * held once.
 */
async function stageBuffered(
	storage: UploadStorage,
	body: ReadableStream<Uint8Array>,
	limits: FetchLimits,
): Promise<StagedUpload> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limits.maxBytes || total > limits.bufferBytes) {
			await reader.cancel().catch(() => {});
			if (total > limits.maxBytes) throw tooLarge(limits.maxBytes);
			throw new UrlSourceError(
				"LENGTH_REQUIRED",
				`The response has no usable Content-Length and is larger than ${limits.bufferBytes} bytes, the most Workers can buffer`,
			);
		}
		chunks.push(value);
	}
	const buffered = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
			cancel() {
				chunks.length = 0;
			},
		},
		{ highWaterMark: 0 },
	);
	return stageUpload(storage, buffered, limits.maxBytes, total);
}

function validators(
	headers: Headers,
	previous?: LastFetch,
): Pick<LastFetch, "etag" | "lastModified"> {
	const etag = headers.get("etag") ?? previous?.etag;
	const lastModified = headers.get("last-modified") ?? previous?.lastModified;
	return {
		...(etag === null || etag === undefined ? {} : { etag }),
		...(lastModified === null || lastModified === undefined ? {} : { lastModified }),
	};
}

/**
 * Downloads `input.url` into a new staged upload, or reports it unchanged: a `304` to the
 * conditional request, or a body with the previous SHA-256. Either needs the previous staged
 * upload to still exist; without it (or with `force`) the fetch is unconditional and always
 * changed.
 */
export async function downloadSource(
	deps: FetcherDeps,
	input: DownloadInput,
): Promise<DownloadResult> {
	const { limits } = deps;
	const uploads = new EmDashUploads(deps.storage);
	const previous =
		input.previous && !input.force && (await uploads.exists(input.previous.uploadId))
			? input.previous
			: undefined;

	const headers = new Headers();
	if (previous?.etag !== undefined) headers.set("if-none-match", previous.etag);
	if (previous?.lastModified !== undefined) headers.set("if-modified-since", previous.lastModified);
	const conditional = headers.has("if-none-match") || headers.has("if-modified-since");
	if (input.credential) {
		try {
			headers.set(input.credential.header, input.credential.value);
		} catch {
			// The runtime's message may quote the value.
			throw new UrlSourceError("FETCH_FAILED", "The credential header could not be sent");
		}
	}

	const total = new AbortController();
	const untilHeaders = new AbortController();
	const totalTimer = setTimeout(
		() =>
			total.abort(
				new UrlSourceError(
					"FETCH_FAILED",
					`The download did not finish within ${limits.totalMs / 1000} s`,
				),
			),
		limits.totalMs,
	);
	const headersTimer = setTimeout(
		() =>
			untilHeaders.abort(
				new UrlSourceError("FETCH_FAILED", `No response within ${limits.headersMs / 1000} s`),
			),
		limits.headersMs,
	);
	try {
		const response = await guardedFetch(
			input.url,
			{
				headers,
				signal: AbortSignal.any([total.signal, untilHeaders.signal]),
				...(input.credential ? { credentialHeader: input.credential.header } : {}),
			},
			deps.net,
		);
		clearTimeout(headersTimer);
		const at = new Date(deps.now()).toISOString();

		if (response.status === 304 && previous && conditional) {
			await response.body?.cancel().catch(() => {});
			return {
				changed: false,
				fetch: { ...previous, at, status: 304, ...validators(response.headers, previous) },
			};
		}
		if (response.status < 200 || response.status > 299) {
			await response.body?.cancel().catch(() => {});
			throw new UrlSourceError("HTTP_ERROR", `The server answered HTTP ${response.status}`);
		}

		const length = bodyLength(response.headers);
		if (length !== undefined && length > limits.maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw tooLarge(limits.maxBytes);
		}
		const failure: { error?: UrlSourceError } = {};
		const body = guardBody(response.body ?? new Blob([]).stream(), total.signal, failure);
		let staged: StagedUpload;
		try {
			staged =
				deps.workers && length === undefined
					? await stageBuffered(deps.storage, body, limits)
					: await stageUpload(deps.storage, body, limits.maxBytes, length);
		} catch (e) {
			if (failure.error) throw failure.error;
			if (e instanceof Error && e.cause instanceof UrlSourceError) throw e.cause;
			if (e instanceof UploadTooLargeError) throw tooLarge(limits.maxBytes);
			throw e;
		}

		const fetched: LastFetch = {
			at,
			status: response.status,
			...validators(response.headers),
			sha256: staged.sha256,
			bytes: staged.bytes,
			uploadId: staged.uploadId,
		};
		if (
			previous &&
			staged.sha256 === previous.sha256 &&
			(await uploads.exists(previous.uploadId))
		) {
			await uploads.delete(staged.uploadId);
			return { changed: false, fetch: { ...fetched, uploadId: previous.uploadId } };
		}
		return { changed: true, fetch: fetched };
	} finally {
		clearTimeout(totalTimer);
		clearTimeout(headersTimer);
	}
}
