import type {
	BylineAccess,
	TaxonomyAccess,
	TaxonomyAccessWithWrite,
	TaxonomyTermInfo,
} from "emdash";
import {
	type BylineRef,
	ContentWriteError,
	type LookupPort,
	type TaxonomyDef,
	type TermInfo,
} from "../engine/ports.js";
import { type HandlerResult, writeError } from "./content.js";

/** The runtime's content read (`emdash` src/emdash-runtime.ts:3364); the runtime is assignable. */
export interface EntryReader {
	handleContentGet(collection: string, id: string, locale?: string): Promise<HandlerResult>;
}

/** Bylines per page: the most `ctx.bylines.list` returns (src/plugins/byline-access.ts). */
export const BYLINE_PAGE = 100;

function termOf(t: TaxonomyTermInfo): TermInfo {
	return {
		id: t.id,
		slug: t.slug,
		label: t.label,
		parentId: t.parentId,
		group: t.translationGroup ?? t.id,
	};
}

function itemOf(data: unknown): { id: string; slug: string | null; group: string } | null {
	const item =
		typeof data === "object" && data !== null && "item" in data
			? (data.item as Record<string, unknown> | null)
			: null;
	if (item === null || typeof item !== "object" || typeof item.id !== "string") return null;
	const slug = typeof item.slug === "string" ? item.slug : null;
	const group = typeof item.translationGroup === "string" ? item.translationGroup : item.id;
	return { id: item.id, slug, group };
}

/**
 * `LookupPort` over the plugin context's `ctx.taxonomies` (`taxonomies:write`), `ctx.bylines`
 * (`bylines:read`) and the runtime's content reads. EmDash sets the context objects only for
 * declared capabilities (src/plugins/context.ts:1752-1763); a missing one throws when used.
 */
export class EmDashLookups implements LookupPort {
	constructor(
		private readonly taxonomies: TaxonomyAccess | TaxonomyAccessWithWrite | undefined,
		private readonly bylineAccess: BylineAccess | undefined,
		private readonly runtime: EntryReader,
	) {}

	private tax(): TaxonomyAccess {
		if (!this.taxonomies) {
			throw new Error("flux-import: ctx.taxonomies is missing; declare taxonomies:write");
		}
		return this.taxonomies;
	}

	async taxonomyDefs(): Promise<TaxonomyDef[]> {
		const defs = await this.tax().getAll();
		return defs.map((d) => ({
			name: d.name,
			hierarchical: d.hierarchical,
			collections: d.collections,
			locale: d.locale,
		}));
	}

	async terms(taxonomy: string, locale: string): Promise<TermInfo[]> {
		return (await this.tax().getTerms(taxonomy, { locale })).map(termOf);
	}

	async createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	): Promise<TermInfo> {
		const create = this.tax().createTerm;
		if (!create) throw new Error("flux-import: creating terms needs taxonomies:write");
		return termOf(await create.call(this.taxonomies, taxonomy, input));
	}

	async entryTerms(collection: string, entryId: string): Promise<Record<string, string[]>> {
		// Without a locale every locale's rows come back; assignments are per translation group.
		const terms = await this.tax().getEntryTerms(collection, entryId);
		const groups: Record<string, string[]> = {};
		for (const t of terms) {
			const list = groups[t.taxonomy] ?? [];
			const group = t.translationGroup ?? t.id;
			if (!list.includes(group)) list.push(group);
			groups[t.taxonomy] = list;
		}
		return groups;
	}

	async bylines(locale: string, cursor?: string): Promise<{ items: BylineRef[]; cursor?: string }> {
		if (!this.bylineAccess) {
			throw new Error("flux-import: ctx.bylines is missing; declare bylines:read");
		}
		const page = await this.bylineAccess.list({
			locale,
			limit: BYLINE_PAGE,
			...(cursor === undefined ? {} : { cursor }),
		});
		const items = page.items.map((b) => ({
			id: b.id,
			slug: b.slug,
			displayName: b.displayName,
			group: b.translationGroup,
		}));
		return page.hasMore && page.cursor ? { items, cursor: page.cursor } : { items };
	}

	/**
	 * `handleContentGet` finds an entry by ID or slug (src/database/repositories/content.ts:711-717),
	 * so the answer must match the way asked: the same ID, or the same slug in the locale.
	 */
	async findEntry(
		collection: string,
		by: "id" | "slug",
		value: string,
		locale: string,
	): Promise<{ id: string; group: string } | null> {
		const result =
			by === "id"
				? await this.runtime.handleContentGet(collection, value)
				: await this.runtime.handleContentGet(collection, value, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Looking up a referenced entry", result.error);
		}
		const item = itemOf(result.data);
		if (item === null) {
			throw new ContentWriteError(
				"emdash_bad_response",
				"Looking up a referenced entry: unexpected response from EmDash",
			);
		}
		const matches = by === "id" ? item.id === value : item.slug === value;
		return matches ? { id: item.id, group: item.group } : null;
	}
}
