import type { ActorInfo, ContentFieldFilters } from "emdash";
import { z } from "zod";
import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type RevertStep,
	type StepResult,
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
 * :3649 (update), :4575 (publish), :4776 (translations), :759 (schemaRegistry); for rollbacks
 * (M5a) :3374 (get including Trash), :4093 (delete), :4163 (permanent delete), :4652 (unpublish),
 * :4686 (schedule), :4764 (discard draft).
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
			slug?: string | null;
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
	handleContentGetIncludingTrashed(
		collection: string,
		id: string,
		locale?: string,
	): Promise<HandlerResult>;
	handleContentDelete(collection: string, id: string): Promise<HandlerResult>;
	handleContentPermanentDelete(collection: string, id: string): Promise<HandlerResult>;
	handleContentUnpublish(
		collection: string,
		id: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentDiscardDraft(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
	/** M5b: src/emdash-runtime.ts:4733 (no hook can refuse it, spec M5b F3). */
	handleContentUnschedule(
		collection: string,
		id: string,
		options?: { _rev?: string },
	): Promise<HandlerResult>;
}

/** The codes EmDash's policy hooks refuse a publish, unpublish or schedule with (M5a). */
const HOOK_REFUSALS: ReadonlySet<string> = new Set([
	"PUBLISH_REJECTED",
	"UNPUBLISH_REJECTED",
	"SCHEDULE_REJECTED",
]);

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
		/** The live column values, when `handleContentGet` hydrated a draft (spec M5a F5). */
		liveData: z.record(z.string(), z.unknown()).optional(),
		draftRevisionId: z.string().nullable().optional(),
		scheduledAt: z.string().nullable().optional(),
		/** ContentItem.publishedAt (src/database/repositories/types.ts:311). */
		publishedAt: z.string().nullable().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().nullable().optional(),
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

function snapshotOf(
	data: unknown,
	op: string,
): EntrySnapshot & { locale: string | null; trashed: boolean } {
	const { item, _rev } = parse(itemResult, data, op);
	const hasDraft = (item.draftRevisionId ?? null) !== null;
	return {
		id: item.id,
		rev: _rev,
		// Slug: the live slug. A slug staged in a draft is not returned by handleContentGet
		// (hydrateDraftData without includeStagedSlug, src/emdash-runtime.ts:3389-3442).
		slug: item.slug,
		data: item.data,
		...(item.translationGroup ? { group: item.translationGroup } : {}),
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || hasDraft,
		status: item.status,
		scheduledAt: item.scheduledAt ?? null,
		hasDraft,
		...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
		...(hasDraft && item.liveData !== undefined ? { live: item.liveData } : {}),
		...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
		...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
		trashed: (item.deletedAt ?? null) !== null,
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

/** Whether an entry's locale (null without i18n) is `locale`, ignoring case. */
function sameLocale(entryLocale: string | null, locale: string): boolean {
	return entryLocale === null || entryLocale.toLowerCase() === locale.toLowerCase();
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
		const {
			locale: entryLocale,
			trashed: _trashed,
			...snapshot
		} = snapshotOf(result.data, "Reading the entry");
		// EmDash stores the configured casing of a locale (resolveContentCreateLocale,
		// src/i18n/config.ts:54-76), so compare without case.
		return sameLocale(entryLocale, locale) ? snapshot : null;
	}

	async getIncludingTrashed(
		collection: string,
		locale: string,
		id: string,
	): Promise<(EntrySnapshot & { trashed: boolean }) | null> {
		const result = await this.runtime.handleContentGetIncludingTrashed(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		return sameLocale(entryLocale, locale) ? snapshot : null;
	}

	async trash(
		collection: string,
		id: string,
	): Promise<{ ok: true } | { ok: false; reason: "blocked" | "not_found"; message: string }> {
		const result = await this.runtime.handleContentDelete(collection, id);
		if (result.success) return { ok: true };
		const message = result.error?.message ?? "";
		if (result.error?.code === "DELETE_BLOCKED") return { ok: false, reason: "blocked", message };
		if (result.error?.code === "NOT_FOUND") return { ok: false, reason: "not_found", message };
		throw writeError("Moving the entry to Trash", result.error);
	}

	async permanentDelete(collection: string, id: string): Promise<boolean> {
		const result = await this.runtime.handleContentPermanentDelete(collection, id);
		if (result.success) return true;
		if (result.error?.code === "NOT_FOUND") return false;
		throw writeError("Deleting the entry", result.error);
	}

	async revertStep(
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
	): Promise<StepResult> {
		const { collection, id, rev } = input;
		// As publish: an editor's lease stops every step, not only the publish (spec M5a).
		if (await this.lockReader(collection, id, this.actor.id)) {
			return { ok: false, reason: "locked", message: "The entry is being edited" };
		}
		const options = { _rev: rev, actor: this.actor };
		let result: HandlerResult;
		switch (input.step) {
			case "update":
				result = await this.runtime.handleContentUpdate(collection, id, {
					...(input.data === undefined ? {} : { data: input.data }),
					locale: input.locale,
					_rev: rev,
					actor: this.actor,
					...(input.slug === undefined ? {} : { slug: input.slug }),
					...linksOf(input),
				});
				break;
			case "publish":
				result = await this.runtime.handleContentPublish(collection, id, options);
				break;
			case "unpublish":
				result = await this.runtime.handleContentUnpublish(collection, id, options);
				break;
			case "discard":
				result = await this.runtime.handleContentDiscardDraft(collection, id, { _rev: rev });
				break;
			case "schedule":
				result = await this.runtime.handleContentSchedule(
					collection,
					id,
					input.scheduledAt ?? "",
					options,
				);
				break;
			case "unschedule":
				result = await this.runtime.handleContentUnschedule(collection, id, { _rev: rev });
				break;
		}
		const op = `Rolling back the entry (${input.step})`;
		if (!result.success) {
			const code = result.error?.code ?? "";
			const message = result.error?.message ?? code;
			if (code === "CONFLICT") return { ok: false, reason: "conflict", message };
			if (HOOK_REFUSALS.has(code)) return { ok: false, reason: "blocked", message };
			throw writeError(op, result.error);
		}
		const after = snapshotOf(result.data, op);
		return {
			ok: true,
			state: {
				rev: after.rev,
				status: after.status,
				scheduledAt: after.scheduledAt,
				hasDraft: after.hasDraft,
			},
		};
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

	async schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult> {
		if (await this.lockReader(input.collection, input.id, this.actor.id)) {
			return { ok: false, reason: "locked" };
		}
		const result = await this.runtime.handleContentSchedule(
			input.collection,
			input.id,
			input.scheduledAt,
			{ _rev: input.rev, actor: this.actor },
		);
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Scheduling the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Scheduling the entry").rev };
	}

	ensureSourceIdField(collection: string): Promise<void> {
		return ensureSourceIdField(this.runtime.schemaRegistry, collection);
	}
}
