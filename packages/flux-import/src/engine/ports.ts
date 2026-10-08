import type { FieldValue } from "./template.js";

export type Where = Record<string, unknown>;

export interface KvCollection<T> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
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

export interface EntrySnapshot {
	id: string;
	rev: string;
	slug: string | null;
	data: Record<string, unknown>;
	/** The entry has a draft that is not live, or has never been published. */
	pendingPublish: boolean;
}

export type WriteResult = { ok: true; rev: string } | { ok: false; reason: "conflict" | "locked" };

export interface ContentPort {
	get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null>;
	findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null>;
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
	publish(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
	}): Promise<WriteResult>;
	ensureSourceIdField(collection: string): Promise<void>;
}

export interface SourcePort {
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
