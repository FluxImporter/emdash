import type { ActorInfo, ContentFieldFilters } from "emdash";
import { z } from "zod";
import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
import { ensureSourceIdField, type SchemaRegistryLike } from "./schema.js";

/** The envelope every runtime content handler returns (`emdash` src/api/types.ts:105). */
export type HandlerResult = {
	success: boolean;
	data?: unknown;
	error?: { code: string; message: string };
};

/**
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :759 (schemaRegistry).
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
	handleContentGet(collection: string, id: string, locale?: string): Promise<HandlerResult>;
	handleContentList(
		collection: string,
		params: { locale?: string; limit?: number; fieldFilters?: ContentFieldFilters },
	): Promise<HandlerResult>;
	handleContentCreate(
		collection: string,
		body: {
			data: Record<string, unknown>;
			slug?: string;
			locale?: string;
			authorId?: string;
			actor?: ActorInfo;
		},
	): Promise<HandlerResult>;
	handleContentUpdate(
		collection: string,
		id: string,
		body: {
			data?: Record<string, unknown>;
			slug?: string;
			locale?: string;
			_rev?: string;
			actor?: ActorInfo;
		},
	): Promise<HandlerResult>;
	handleContentPublish(
		collection: string,
		id: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
}

/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;

/** `{ item, _rev }` from get, create, update and publish (src/api/handlers/content.ts:1135). */
const itemResult = z.object({
	item: z.object({
		id: z.string(),
		slug: z.string().nullable(),
		status: z.string(),
		locale: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
	}),
	_rev: z.string(),
});

/** `{ items, nextCursor? }` from list (src/api/types.ts:10). */
const listResult = z.object({ items: z.array(z.object({ id: z.string() })) });

function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		throw new ContentWriteError("emdash_bad_response", `${op}: unexpected response from EmDash`);
	}
	return parsed.data;
}

/**
 * EmDash error codes become `emdash_<code>` record codes, so none can collide with the engine's
 * own codes (`publish_*` codes steer crash repair).
 */
function writeError(op: string, error: HandlerResult["error"]): ContentWriteError {
	const code = error?.code ?? "UNKNOWN_ERROR";
	return new ContentWriteError(
		`emdash_${code.toLowerCase()}`,
		`${op} failed: ${error?.message ?? code}`,
	);
}

function snapshotOf(data: unknown, op: string): EntrySnapshot & { locale: string | null } {
	const { item, _rev } = parse(itemResult, data, op);
	return {
		id: item.id,
		rev: _rev,
		// Slug: the live slug. A slug staged in a draft is not returned by handleContentGet
		// (hydrateDraftData without includeStagedSlug, src/emdash-runtime.ts:3389-3442).
		slug: item.slug,
		data: item.data,
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
	};
}

/**
 * `ContentPort` over the EmDash runtime. Writes run as `actor` (revision attribution and hooks
 * only; the author is not changed). Lock enforcement is not part of the trusted write path
 * (verification report, question 3), so `isLocked` and `publish` read the lock table.
 */
export class EmDashContent implements ContentPort {
	constructor(
		private readonly runtime: ContentRuntime,
		private readonly actor: ActorInfo,
		private readonly lockReader: LockReader,
	) {}

	async get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentGet(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		return entryLocale === null || entryLocale === locale ? snapshot : null;
	}

	async findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentList(collection, {
			locale,
			limit: 2,
			fieldFilters: { [SOURCE_ID_FIELD]: sourceId },
		});
		if (!result.success) throw writeError("Looking up the source ID", result.error);
		const { items } = parse(listResult, result.data, "Looking up the source ID");
		if (items.length > 1) {
			throw new ContentWriteError(
				"ambiguous_source_id",
				`More than one entry in "${collection}" (${locale}) has ${SOURCE_ID_FIELD} "${sourceId}"`,
			);
		}
		const [only] = items;
		return only ? this.get(collection, locale, only.id) : null;
	}

	isLocked(collection: string, _locale: string, id: string): Promise<boolean> {
		return this.lockReader(collection, id, this.actor.id);
	}

	async create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<{ id: string; rev: string }> {
		const result = await this.runtime.handleContentCreate(input.collection, {
			data: input.data,
			locale: input.locale,
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
		const { id, rev } = snapshotOf(result.data, "Creating the entry");
		return { id, rev };
	}

	async update(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<WriteResult> {
		const result = await this.runtime.handleContentUpdate(input.collection, input.id, {
			data: input.data,
			locale: input.locale,
			_rev: input.rev,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Updating the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Updating the entry").rev };
	}

	async publish(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
	}): Promise<WriteResult> {
		if (await this.lockReader(input.collection, input.id, this.actor.id)) {
			return { ok: false, reason: "locked" };
		}
		const result = await this.runtime.handleContentPublish(input.collection, input.id, {
			_rev: input.rev,
			actor: this.actor,
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Publishing the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Publishing the entry").rev };
	}

	ensureSourceIdField(collection: string): Promise<void> {
		return ensureSourceIdField(this.runtime.schemaRegistry, collection);
	}
}
