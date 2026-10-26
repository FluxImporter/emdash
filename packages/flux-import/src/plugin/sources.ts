import type { StorageCollection } from "emdash";
import { kvCollection } from "../emdash/storage.js";
import { EmDashUploads, type UploadStorage } from "../emdash/uploads.js";
import type { KvCollection } from "../engine/ports.js";
import type { Job } from "../engine/types.js";
import {
	type DownloadResult,
	downloadSource,
	type FetchLimits,
	type LastFetch,
} from "../sources/fetcher.js";
import {
	checkHost,
	type NetOptions,
	parseSourceUrl,
	UrlSourceError,
	type UrlSourceErrorCode,
} from "../sources/net.js";
import { type CredentialSettings, getCredential } from "./credentials.js";
import { PAGE_SIZE, type Page, page, ServiceError, uploadInUse } from "./service.js";

export interface SourceRow {
	id: string;
	/** 1-100 characters, unique. */
	name: string;
	/** http(s), no userinfo, at most 2,048 characters, stored as `URL.href`. */
	url: string;
	/** A credential name. */
	credential?: string;
	lastFetch?: LastFetch;
	lastError?: { at: string; code: string; message: string };
	/** The content of the last job created (not a dry run) from a fetch of this source. */
	lastImport?: LastImport;
	createdAt: string;
	updatedAt: string;
}

export interface LastImport {
	sha256: string;
	uploadId: string;
	jobId: string;
	at: string;
}

export interface SourceDeps {
	sources: KvCollection<SourceRow>;
	jobs: KvCollection<Job>;
	settings: CredentialSettings;
	storage: UploadStorage;
	net: NetOptions;
	limits: FetchLimits;
	workers: boolean;
	now: () => number;
	newId: () => string;
}

export interface CreateSourceInput {
	name: string;
	url: string;
	credential?: string | undefined;
}

export interface UpdateSourceInput {
	id: string;
	name?: string | undefined;
	url?: string | undefined;
	/** `null` removes the credential. */
	credential?: string | null | undefined;
}

export interface FetchOutcome {
	changed: boolean;
	uploadId: string;
	bytes: number;
	sha256: string;
}

export interface SkippedJob {
	skipped: "unchanged";
	sourceId: string;
	uploadId: string;
}

const PAGE = 100;
const CAS_ATTEMPTS = 5;

const STATUS: Record<UrlSourceErrorCode, number> = {
	URL_BLOCKED: 400,
	FETCH_FAILED: 502,
	HTTP_ERROR: 502,
	TOO_MANY_REDIRECTS: 502,
	TOO_LARGE: 413,
	LENGTH_REQUIRED: 502,
};

/** The `sources` storage collection declared in the plugin definition. */
export function sourcesCollection(
	storage: Record<string, StorageCollection | undefined>,
): KvCollection<SourceRow> {
	if (!storage.sources) throw new Error("flux-import: the sources storage collection is missing");
	return kvCollection<SourceRow>(storage.sources);
}

function toServiceError(e: unknown): unknown {
	return e instanceof UrlSourceError ? new ServiceError(e.code, e.message, STATUS[e.code]) : e;
}

/** Normalises and checks a URL without DNS; the fetch checks the addresses. */
function checkedUrl(text: string, allowPrivateNetwork: boolean): string {
	try {
		const url = parseSourceUrl(text);
		checkHost(url, allowPrivateNetwork);
		return url.href;
	} catch (e) {
		throw toServiceError(e);
	}
}

async function assertNameFree(deps: SourceDeps, name: string, self?: string): Promise<void> {
	const found = await deps.sources.query({ where: { name }, limit: 2 });
	if (found.items.some((item) => item.id !== self)) {
		throw new ServiceError("CONFLICT", `A source named "${name}" already exists`, 409);
	}
}

async function assertCredential(deps: SourceDeps, name: string): Promise<void> {
	if (!(await getCredential(deps.settings, name))) {
		throw new ServiceError("NOT_FOUND", `Credential "${name}" not found`, 404);
	}
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function getSource(deps: Pick<SourceDeps, "sources">, id: string): Promise<SourceRow> {
	const row = await deps.sources.get(id);
	if (!row) throw new ServiceError("NOT_FOUND", `Source ${id} not found`, 404);
	return row;
}

export async function listSources(
	deps: Pick<SourceDeps, "sources">,
	cursor?: string,
): Promise<Page<SourceRow>> {
	return page(
		await deps.sources.query({
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		}),
	);
}

export async function createSource(deps: SourceDeps, input: CreateSourceInput): Promise<SourceRow> {
	const url = checkedUrl(input.url, deps.net.allowPrivateNetwork);
	await assertNameFree(deps, input.name);
	if (input.credential !== undefined) await assertCredential(deps, input.credential);
	const at = iso(deps.now());
	const row: SourceRow = {
		id: deps.newId(),
		name: input.name,
		url,
		...(input.credential === undefined ? {} : { credential: input.credential }),
		createdAt: at,
		updatedAt: at,
	};
	await deps.sources.put(row.id, row);
	return row;
}

/**
 * Changing the URL or the credential clears `lastFetch`, `lastError` and `lastImport`: the next
 * fetch is full and its content counts as new.
 */
export async function updateSource(deps: SourceDeps, input: UpdateSourceInput): Promise<SourceRow> {
	const current = await getSource(deps, input.id);
	const { credential: _credential, lastFetch, lastError, lastImport, ...base } = current;
	if (input.name !== undefined && input.name !== current.name) {
		await assertNameFree(deps, input.name, current.id);
	}
	const url =
		input.url === undefined ? current.url : checkedUrl(input.url, deps.net.allowPrivateNetwork);
	if (typeof input.credential === "string" && input.credential !== current.credential) {
		await assertCredential(deps, input.credential);
	}
	const credential = input.credential === undefined ? current.credential : input.credential;
	const reconfigured = url !== current.url || (credential ?? undefined) !== current.credential;
	const next: SourceRow = {
		...base,
		name: input.name ?? current.name,
		url,
		...(credential === null || credential === undefined ? {} : { credential }),
		...(reconfigured || !lastFetch ? {} : { lastFetch }),
		...(reconfigured || !lastError ? {} : { lastError }),
		...(reconfigured || !lastImport ? {} : { lastImport }),
		updatedAt: iso(deps.now()),
	};
	await deps.sources.put(next.id, next);
	return next;
}

/** Deletes the staged file unless a job may still read it. */
async function deleteUploadIfUnused(deps: SourceDeps, uploadId: string): Promise<void> {
	if (await uploadInUse(deps.jobs, uploadId)) return;
	await new EmDashUploads(deps.storage).delete(uploadId);
}

/** Deletes the source and its latest staged file, unless a job still reads that file. */
export async function deleteSource(deps: SourceDeps, id: string): Promise<{ deleted: true }> {
	const row = await getSource(deps, id);
	await deps.sources.delete(id);
	if (row.lastFetch) await deleteUploadIfUnused(deps, row.lastFetch.uploadId);
	return { deleted: true };
}

/** Each source's latest staged file: kept while the source exists. */
export async function latestSourceUploads(sources: KvCollection<SourceRow>): Promise<Set<string>> {
	const latest = new Set<string>();
	let cursor: string | undefined;
	do {
		const result = await sources.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of result.items) {
			if (data.lastFetch) latest.add(data.lastFetch.uploadId);
		}
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return latest;
}

type Versioned = { value: SourceRow; revision: string };

/**
 * Writes a fetch result onto the row read before the fetch. A concurrent fetch only moves the
 * revision, so the write is retried on the newer row; a row that was deleted or given another
 * URL or credential meanwhile is left alone (`null`).
 */
async function saveFetchResult(
	deps: SourceDeps,
	read: Versioned,
	change: (row: SourceRow) => SourceRow,
): Promise<SourceRow | null> {
	let current = read;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const result = await deps.sources.compareAndSet(
			read.value.id,
			current.revision,
			change(current.value),
		);
		if (result.applied) return current.value;
		const again = await deps.sources.getVersioned(read.value.id);
		if (
			!again ||
			again.value.url !== read.value.url ||
			again.value.credential !== read.value.credential
		) {
			return null;
		}
		current = again;
	}
	throw new ServiceError("CONFLICT", "The source kept changing during the fetch; try again", 409);
}

function withoutError(row: SourceRow): SourceRow {
	const { lastError: _lastError, ...rest } = row;
	return rest;
}

/**
 * Fetches a source into a staged upload (see `downloadSource`), saves the result as `lastFetch`
 * or the failure as `lastError`, and deletes the previous staged file when a changed fetch
 * replaced it and no job reads it.
 */
export async function fetchSource(
	deps: SourceDeps,
	id: string,
	force = false,
): Promise<FetchOutcome> {
	const read = await deps.sources.getVersioned(id);
	if (!read) throw new ServiceError("NOT_FOUND", `Source ${id} not found`, 404);
	const source = read.value;
	let result: DownloadResult;
	try {
		let credential: { header: string; value: string } | undefined;
		if (source.credential !== undefined) {
			credential = (await getCredential(deps.settings, source.credential)) ?? undefined;
			if (!credential) {
				throw new ServiceError(
					"CREDENTIAL_MISSING",
					`Credential "${source.credential}" does not exist`,
					409,
				);
			}
		}
		result = await downloadSource(
			{
				storage: deps.storage,
				net: deps.net,
				limits: deps.limits,
				workers: deps.workers,
				now: deps.now,
			},
			{
				url: source.url,
				force,
				...(credential ? { credential } : {}),
				...(source.lastFetch ? { previous: source.lastFetch } : {}),
			},
		);
	} catch (e) {
		const error = toServiceError(e);
		if (error instanceof ServiceError) {
			const lastError = { at: iso(deps.now()), code: error.code, message: error.message };
			await saveFetchResult(deps, read, (row) => ({ ...row, lastError })).catch(() => null);
		}
		throw error;
	}

	const replaced = await saveFetchResult(deps, read, (row) => ({
		...withoutError(row),
		lastFetch: result.fetch,
	}));
	if (!replaced) {
		if (result.changed) await deleteUploadIfUnused(deps, result.fetch.uploadId);
		throw new ServiceError(
			"CONFLICT",
			"The source was deleted or reconfigured during the fetch",
			409,
		);
	}
	const previous = replaced.lastFetch?.uploadId;
	if (result.changed && previous !== undefined && previous !== result.fetch.uploadId) {
		await deleteUploadIfUnused(deps, previous).catch(() => {});
	}
	const { uploadId, bytes, sha256 } = result.fetch;
	return { changed: result.changed, uploadId, bytes, sha256 };
}

/**
 * Saves the content a real job was created from. Best effort: the job exists either way, and a
 * source deleted or reconfigured meanwhile is left alone. A lost race is retried on the newer row.
 */
async function recordImport(
	deps: SourceDeps,
	read: SourceRow,
	lastImport: LastImport,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.sources.getVersioned(read.id);
		if (
			!current ||
			current.value.url !== read.url ||
			current.value.credential !== read.credential
		) {
			return;
		}
		const result = await deps.sources.compareAndSet(read.id, current.revision, {
			...current.value,
			lastImport,
		});
		if (result.applied) return;
	}
}

/**
 * `jobs/create` with a `sourceId`: fetches first (conditional GET and hash decide whether a new
 * copy is staged), then skips the job only for a real run without `force` whose content equals
 * `lastImport`. Dry runs are never skipped and never recorded; a failed creation records nothing.
 */
export async function jobFromSource(
	deps: SourceDeps,
	sourceId: string,
	options: { force: boolean; dryRun: boolean },
	create: (uploadId: string) => Promise<Job>,
): Promise<Job | SkippedJob> {
	const fetched = await fetchSource(deps, sourceId, options.force);
	const source = await getSource(deps, sourceId);
	if (!options.force && !options.dryRun && source.lastImport?.sha256 === fetched.sha256) {
		return { skipped: "unchanged", sourceId, uploadId: fetched.uploadId };
	}
	const job = await create(fetched.uploadId);
	if (!options.dryRun) {
		await recordImport(deps, source, {
			sha256: fetched.sha256,
			uploadId: fetched.uploadId,
			jobId: job.id,
			at: iso(deps.now()),
		});
	}
	return job;
}
