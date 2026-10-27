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
}

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null>;
	/** Throws `ContentWriteError("ambiguous_source_id", …)` when more than one entry matches. */
	findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null>;
	/** A lock held by the importing user counts as unlocked. */
	isLocked(collection: string, locale: string, id: string): Promise<boolean>;
	create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<{ id: string; rev: string }>;
	/** On revisioned collections this stages a draft; `publish` makes it live. */
	update(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<WriteResult>;
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

export class SourceMissingError extends Error {
	constructor(uploadId: string) {
		super(`Upload ${uploadId} not found`);
		this.name = "SourceMissingError";
	}
}
