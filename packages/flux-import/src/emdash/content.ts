import type { ActorInfo, ContentFieldFilters } from "emdash";
import { z } from "zod";
import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
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
 * :3649 (update), :4575 (publish), :4776 (translations), :759 (schemaRegistry).
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
	handleContentGet(
		collection: string,
		id: string,
		locale?: string,
		referenceOptions?: { includeDrafts: boolean },
	): Promise<HandlerResult>;
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
			translationOf?: string;
			actor?: ActorInfo;
		} & LinkWrites,
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
		} & LinkWrites,
	): Promise<HandlerResult>;
	handleContentPublish(
		collection: string,
		id: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentTranslations(collection: string, id: string): Promise<HandlerResult>;
}

/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;

/** One reference field's first page (src/api/handlers/content.ts:382-480). */
const referencePage = z.object({
	children: z.array(
		z.object({ id: z.string(), translationGroup: z.string().nullable().optional() }),
	),
	/** Set when more references exist than the page holds. */
	nextCursor: z.string().nullable().optional(),
});

/** A byline credit as `hydrateBylines` gives it (src/api/handlers/content.ts:312-353). */
const bylineCredit = z.object({
	byline: z.object({
		id: z.string(),
		slug: z.string(),
		translationGroup: z.string().nullable().optional(),
	}),
	roleLabel: z.string().nullable().optional(),
	source: z.string().optional(),
});

/** `{ item, _rev }` from get, create, update and publish (src/api/handlers/content.ts:1135). */
const itemResult = z.object({
	item: z.object({
		id: z.string(),
		slug: z.string().nullable(),
		status: z.string(),
		locale: z.string().nullable().optional(),
		translationGroup: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
		references: z.record(z.string(), referencePage).optional(),
		bylines: z.array(bylineCredit).optional(),
	}),
	_rev: z.string(),
});

/** `{ items, nextCursor? }` from list (src/api/types.ts:10). */
const listResult = z.object({ items: z.array(z.object({ id: z.string() })) });

/** `{ translationGroup, translations }` from translations (src/api/handlers/content.ts:2777-2840). */
const translationsResult = z.object({
	translations: z.array(z.object({ id: z.string(), locale: z.string().nullable() })),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		throw new ContentWriteError("emdash_bad_response", `${op}: unexpected response from EmDash`);
	}
	return parsed.data;
}

/**
 * EmDash error codes become `emdash_<code>` record codes, so none can collide with the engine's
 * own codes (`publish_*` codes steer crash repair). COLLECTION_NOT_FOUND (list, create and update
 * handlers, src/api/handlers/content.ts:1006, :1413, :1709) becomes `collection_missing`, which
 * fails the job rather than each record.
 */
export function writeError(op: string, error: HandlerResult["error"]): ContentWriteError {
	const code = error?.code ?? "UNKNOWN_ERROR";
	if (code === "COLLECTION_NOT_FOUND") {
		return new ContentWriteError("collection_missing", `${op} failed: ${error?.message ?? code}`);
	}
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
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
		...(item.references === undefined
			? {}
			: {
					references: Object.fromEntries(
						Object.entries(item.references).map(([field, page]) => [
							field,
							page.children.map((c) => ({ group: c.translationGroup ?? c.id, id: c.id })),
						]),
					),
				}),
		...(item.references !== undefined &&
		Object.values(item.references).some((page) => page.nextCursor)
			? {
					referencesTruncated: Object.entries(item.references)
						.filter(([, page]) => page.nextCursor)
						.map(([field]) => field),
				}
			: {}),
		...(item.bylines === undefined
			? {}
			: {
					// An inferred credit (the author's byline) is not one the entry was given.
					bylines: item.bylines
						.filter((c) => c.source !== "inferred")
						.map((c) => ({
							group: c.byline.translationGroup ?? c.byline.id,
							id: c.byline.id,
							slug: c.byline.slug,
							roleLabel: c.roleLabel ?? null,
						})),
				}),
	};
}

/** The links of a write, without the ones not given. */
function linksOf(input: LinkWrites): LinkWrites {
	return {
		...(input.taxonomies === undefined ? {} : { taxonomies: input.taxonomies }),
		...(input.references === undefined ? {} : { references: input.references }),
		...(input.bylines === undefined ? {} : { bylines: input.bylines }),
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

	/**
	 * With `references`, every reference field's selection is read as an editor sees it: a
	 * selection staged in a draft first (`includeDrafts`, src/api/handlers/content.ts:360-480).
	 */
	async get(
		collection: string,
		locale: string,
		id: string,
		options: GetOptions = {},
	): Promise<EntrySnapshot | null> {
		const result = options.references
			? await this.runtime.handleContentGet(collection, id, locale, { includeDrafts: true })
			: await this.runtime.handleContentGet(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		// EmDash stores the configured casing of a locale (resolveContentCreateLocale,
		// src/i18n/config.ts:54-76), so compare without case.
		return entryLocale === null || entryLocale.toLowerCase() === locale.toLowerCase()
			? snapshot
			: null;
	}

	async findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
		options: GetOptions = {},
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
		return only ? this.get(collection, locale, only.id, options) : null;
	}

	isLocked(collection: string, _locale: string, id: string): Promise<boolean> {
		return this.lockReader(collection, id, this.actor.id);
	}

	async create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, FieldValue>;
			translationOf?: string;
		} & LinkWrites,
	): Promise<{ id: string; rev: string }> {
		const result = await this.runtime.handleContentCreate(input.collection, {
			data: input.data,
			locale: input.locale,
			authorId: this.actor.id,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...(input.translationOf === undefined ? {} : { translationOf: input.translationOf }),
			...linksOf(input),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
		const { id, rev } = snapshotOf(result.data, "Creating the entry");
		return { id, rev };
	}

	/** Rows without a locale (never written by EmDash with i18n) are left out. */
	async translations(collection: string, id: string): Promise<{ id: string; locale: string }[]> {
		const result = await this.runtime.handleContentTranslations(collection, id);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return [];
			throw writeError("Reading the translations", result.error);
		}
		const { translations } = parse(translationsResult, result.data, "Reading the translations");
		return translations.flatMap((t) => (t.locale === null ? [] : [{ id: t.id, locale: t.locale }]));
	}

	async update(
		input: {
			collection: string;
			locale: string;
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, FieldValue>;
		} & LinkWrites,
	): Promise<WriteResult> {
		const result = await this.runtime.handleContentUpdate(input.collection, input.id, {
			...(input.data === undefined ? {} : { data: input.data }),
			locale: input.locale,
			_rev: input.rev,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
			...linksOf(input),
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
