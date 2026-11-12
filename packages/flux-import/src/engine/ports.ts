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

/** `rev` and `data` reflect the latest revision, draft included; `slug` is the live slug. */
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
	/** EmDash's status: `draft`, `scheduled` or `published` (M5a). */
	status: string;
	/** When a scheduled entry or draft is due to publish; null when none is set (M5a). */
	scheduledAt: string | null;
	/** The entry has a draft revision (`draftRevisionId`, M5a). */
	hasDraft: boolean;
	/**
	 * EmDash's `publishedAt` (M5b): set at the first publication (the scheduler's sets it to the
	 * scheduled time), then kept; null when never published, absent when EmDash gives none.
	 */
	publishedAt?: string | null;
	/** The live column values while the entry has a draft (EmDash `liveData`, M5a). */
	live?: Record<string, unknown>;
	/** ISO timestamps of the entry's row (M5a); absent when EmDash gives none. */
	createdAt?: string;
	updatedAt?: string;
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

/** The state a rollback step left the entry in (M5a). */
export type EntryState = {
	rev: string;
	status: string;
	scheduledAt: string | null;
	hasDraft: boolean;
};

/**
 * A rollback step's outcome (M5a): a stale `rev` is `conflict`; a plugin hook's refusal
 * (`PUBLISH_REJECTED`, `UNPUBLISH_REJECTED`, `SCHEDULE_REJECTED`) is `blocked` with its message;
 * an editor's lease on the entry is `locked`.
 */
export type StepResult =
	| { ok: true; state: EntryState }
	| { ok: false; reason: "conflict" | "blocked" | "locked"; message: string };

/**
 * The rollback's writes to a changed entry (spec M5a "Revert sequence"); M5b adds `unschedule`
 * (step 7), which no hook can refuse (spec M5b F3).
 */
export type RevertStep = "update" | "publish" | "unpublish" | "discard" | "schedule" | "unschedule";

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
	/**
	 * `translationOf`: the ID of an entry of the same collection; the new entry joins its
	 * translation group, and EmDash replaces every non-translatable field in `data` with the
	 * source's value and copies its byline credits when `bylines` is not given (spec M4e F1, F5).
	 * A source that does not exist is `emdash_not_found`; a group that already has an entry in the
	 * locale is `emdash_conflict`.
	 */
	create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, FieldValue>;
			translationOf?: string;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }>;
	/**
	 * The active entries of the entry's translation group, the entry included (EmDash
	 * `handleContentTranslations`); empty when the entry does not exist.
	 */
	translations(collection: string, id: string): Promise<{ id: string; locale: string }[]>;
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
	 * Schedules the entry's content for `scheduledAt` (UTC ISO) at the given revision (M5b, spec
	 * F2): a draft becomes `scheduled`, a published entry stays `published` with its draft due.
	 * `version` is kept and `updated_at` moves, so the returned revision differs only there. Lock
	 * checked like `publish`; a hook's refusal (`emdash_schedule_rejected`), a time not in the
	 * future (`emdash_validation_error`) and other EmDash errors throw `ContentWriteError`.
	 */
	schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult>;
	/**
	 * Idempotent. Creates `flux_source_id` as `string`, `indexed: true`, `translatable: false`; an
	 * existing field must be verified to be indexed.
	 */
	ensureSourceIdField(collection: string): Promise<void>;
	/**
	 * The entry, also when it is in Trash (`trashed`); a trashed entry keeps the `rev` it had
	 * (spec M5a F6, V2). Null when there is none in the locale.
	 */
	getIncludingTrashed(
		collection: string,
		locale: string,
		id: string,
	): Promise<(EntrySnapshot & { trashed: boolean }) | null>;
	/**
	 * Moves an active entry to Trash (spec M5a F6). `blocked`: a `content:beforeDelete` hook
	 * refused; `not_found`: no active entry has the ID.
	 */
	trash(
		collection: string,
		id: string,
	): Promise<{ ok: true } | { ok: false; reason: "blocked" | "not_found"; message: string }>;
	/** Deletes a trashed entry for good (spec M5a F8); false when no trashed entry has the ID. */
	permanentDelete(collection: string, id: string): Promise<boolean>;
	/**
	 * One rollback write with the entry's current `rev` (M5a): `update` (data, slug and links as
	 * in `update`), `publish`, `unpublish`, `discard` (the draft), `schedule` (at `scheduledAt`)
	 * or `unschedule` (M5b: clears the schedule; a no-op on an entry without one).
	 */
	revertStep(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			step: RevertStep;
			slug?: string | null;
			data?: Record<string, unknown>;
			scheduledAt?: string;
		} & LinkWrites,
	): Promise<StepResult>;
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
