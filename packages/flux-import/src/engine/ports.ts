import type { FieldValue } from "./template.js";

export type Where = Record<string, unknown>;

export interface KvCollection<T> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	/** Resolves `true` when a row was deleted. */
	delete(id: string): Promise<boolean>;
	/** Resolves the number of rows deleted. */
	deleteMany(ids: string[]): Promise<number>;
	getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: T,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	query(opts: {
		where?: Where;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: { id: string; data: T }[]; cursor?: string; hasMore: boolean }>;
}

/** A linked entry as read back: its translation group and the ID of the variant read. */
export type LinkedEntry = { group: string; id: string };

/** An explicit byline credit as read back, in credit order. */
export type BylineCredit = { group: string; id: string; slug: string; roleLabel: string | null };

/** Links a write assigns; each one given replaces that link's current value. */
export type LinkWrites = {
	/** Term slugs in the entry's locale, by taxonomy. */
	taxonomies?: Record<string, string[]>;
	/** Target entry IDs, by reference field. */
	references?: Record<string, string[]>;
	bylines?: { bylineId: string; roleLabel: string | null }[];
};

/** `rev`, `slug` and `data` reflect the latest revision, draft included. */
export interface EntrySnapshot {
	id: string;
	rev: string;
	slug: string | null;
	data: Record<string, unknown>;
	/** The entry's translation group, shared by its locales; absent when EmDash gives none. */
	group?: string;
	/**
	 * The entry has a draft that is not live, or is not published (EmDash: `status` is not
	 * `"published"` or `draftRevisionId` is set). On collections without revisions writes are
	 * live immediately, so only an unpublished status counts there.
	 */
	pendingPublish: boolean;
	/**
	 * Each reference field's selection (the first 50), a staged draft selection first; only when
	 * read with `references`.
	 */
	references?: Record<string, LinkedEntry[]>;
	/** Reference fields holding more than the first page read; absent when none does. */
	referencesTruncated?: string[];
	/** The entry's explicit byline credits in its locale (not the author fallback). */
	bylines?: BylineCredit[];
}

/** `references`: also read every reference field's selection, drafts included. */
export type GetOptions = { references?: boolean };

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(
		collection: string,
		locale: string,
		id: string,
		options?: GetOptions,
	): Promise<EntrySnapshot | null>;
	/** Throws `ContentWriteError("ambiguous_source_id", …)` when more than one entry matches. */
	findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
		options?: GetOptions,
	): Promise<EntrySnapshot | null>;
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }>;
	/**
	 * On revisioned collections `data`, `slug` and `references` are staged as a draft, which
	 * `publish` makes live; `taxonomies` and `bylines` are written live at once (EmDash).
	 * Without `data` no data field is written.
	 */
	update(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<WriteResult>;
	/**
	 * Makes the given revision live. On collections without revisions this succeeds as a no-op
	 * returning the current revision.
	 */
	publish(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
	}): Promise<WriteResult>;
	/**
	 * Idempotent. Creates `flux_source_id` as `string`, `indexed: true`, `translatable: false`; an
	 * existing field must be verified to be indexed.
	 */
	ensureSourceIdField(collection: string): Promise<void>;
}

/** A taxonomy definition (`TaxonomyDefInfo`, one per locale). */
export interface TaxonomyDef {
	name: string;
	hierarchical: boolean;
	/** The collections the taxonomy is attached to. */
	collections: string[];
	locale: string;
}

/** A taxonomy term in one locale. `parentId` is the parent's translation group, null for a root. */
export interface TermInfo {
	/** The term's row ID in its locale, which `createTerm` takes as `parentId`. */
	id: string;
	slug: string;
	label: string;
	parentId: string | null;
	group: string;
}

/** A byline in one locale. */
export interface BylineRef {
	id: string;
	slug: string;
	displayName: string;
	group: string;
}

/**
 * Lookups for links (taxonomy terms, bylines, reference targets). Every method reads EmDash as
 * it is now; `createTerm` is the only write.
 */
export interface LookupPort {
	taxonomyDefs(): Promise<TaxonomyDef[]>;
	/** Every term of the taxonomy in the locale. */
	terms(taxonomy: string, locale: string): Promise<TermInfo[]>;
	/** Throws EmDash's error (with its `code`, e.g. `CONFLICT`) when the term cannot be created. */
	createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	): Promise<TermInfo>;
	/** The term translation groups assigned to the entry, by taxonomy (every locale's rows). */
	entryTerms(collection: string, entryId: string): Promise<Record<string, string[]>>;
	/** One page of the locale's bylines (at most 100), newest first; `cursor` when more follow. */
	bylines(locale: string, cursor?: string): Promise<{ items: BylineRef[]; cursor?: string }>;
	/**
	 * An entry of the collection by exact ID (any locale) or by exact slug in the locale, with its
	 * translation group; null when there is none.
	 */
	findEntry(
		collection: string,
		by: "id" | "slug",
		value: string,
		locale: string,
	): Promise<{ id: string; group: string } | null>;
}

/** A media library item (`MediaItem`, `emdash` src/database/repositories/media.ts:57-76). */
export interface MediaInfo {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	width: number | null;
	height: number | null;
	/** The library's default alt text. */
	alt: string | null;
	storageKey: string;
	blurhash: string | null;
	dominantColor: string | null;
}

/** The media library, through the trusted runtime. */
export interface MediaPort {
	/** The item when it exists and is ready, else null; throws `ContentWriteError` on read errors. */
	get(id: string): Promise<MediaInfo | null>;
	/**
	 * Stores the bytes, or finds identical bytes already stored (`deduplicated`, whose alt is
	 * left as it was). Throws `MediaUploadError` with EmDash's code.
	 */
	upload(input: {
		filename: string;
		contentType: string;
		bytes: Uint8Array;
		alt?: string;
	}): Promise<{ item: MediaInfo; deduplicated: boolean }>;
}

export interface SourcePort {
	/**
	 * An offset at or past the source size yields an empty stream. EmDash's ranged download returns
	 * the whole file for such offsets, so adapters must check `offset >= size` first.
	 */
	open(uploadId: string, offset: number): Promise<ReadableStream<Uint8Array>>;
}

export class ContentWriteError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ContentWriteError";
	}
}

/** EmDash refused an upload; `code` is EmDash's (`PAYLOAD_TOO_LARGE`, `INVALID_TYPE`, …). */
export class MediaUploadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "MediaUploadError";
	}
}

export class SourceMissingError extends Error {
	constructor(uploadId: string) {
		super(`Upload ${uploadId} not found`);
		this.name = "SourceMissingError";
	}
}
