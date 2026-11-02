/**
 * Resolution of a record's link requests (links.ts) to what EmDash stores: term slugs, entry
 * IDs and byline IDs, each with the translation group the diff compares. Every lookup of the
 * record is tried and every error collected first; terms are created only after that, in a real
 * run, so a record that fails a lookup creates nothing.
 */
import type {
	LinkRequests,
	ResolvedItem,
	ResolvedLinks,
	TaxonomySnapshot,
	TermRequest,
} from "./links.js";
import {
	type BylineRef,
	type ContentPort,
	ContentWriteError,
	type KvCollection,
	type LookupPort,
	type MediaInfo,
	type TermInfo,
} from "./ports.js";
import { slugify, type TargetField, type Template } from "./template.js";
import { type LinkRow, linkKey, type PlannedTerm } from "./types.js";

/** Bylines loaded per batch at most; a lookup this set cannot answer is `byline_lookup_limit`. */
export const MAX_BYLINE_LOOKUP = 5000;
/** The most planned term paths a dry run keeps on its job. */
export const MAX_PLANNED_TERMS = 5000;
/** The serialized size a job's `plannedTerms` may reach, besides the count. */
export const MAX_PLANNED_BYTES = 256 * 1024;

/** What one port call costs a batch's lookup budget (each EmDash call runs several queries). */
export const COST_CALL = 1;
/** A content get or list, or a byline page: a full read with its hydration queries. */
export const COST_READ = 5;
export const COST_CREATE_TERM = 6;
/** Charged for each processed record of a job that maps links or media: its writes and bookkeeping. */
export const COST_RECORD = 25;
/** One media download and its upload (M4c): about ten per Workers batch. */
export const COST_MEDIA = 60;

export type { ResolvedItem, ResolvedLinks };

export type ResolveDeps = {
	lookups: LookupPort;
	content: ContentPort;
	links: KvCollection<LinkRow>;
};

export type ResolveContext = {
	template: Template;
	/** The job's target field snapshot: reference fields' target collections. */
	targets: Readonly<Record<string, TargetField>>;
	/** The job's taxonomy snapshot; a taxonomy missing from it is flat. */
	taxonomies: Readonly<Record<string, TaxonomySnapshot>>;
	dryRun: boolean;
	/**
	 * A dry run's own plans: whether an earlier record of the job would create an entry with
	 * this key in the job's collection and locale, as a real run would have by now.
	 */
	plannedKey?: (key: string) => Promise<boolean>;
	/**
	 * Whether the job's collection has the `flux_source_id` field: a dry run never adds it, so
	 * a lookup by source ID in the job's own collection would fail. Absent counts as ready.
	 */
	sourceIdReady?: boolean;
};

/** A record error from resolution; EmDash read errors keep their `emdash_` code. */
export type LinkError = { field: string; code: string; message: string };

export type Resolution =
	| { ok: true; links: ResolvedLinks; newTerms: string[] }
	| { ok: false; errors: LinkError[]; newTerms: string[] };

/** A taxonomy's terms in the job's locale, indexed by slug, group and parent. */
class TermIndex {
	readonly bySlug = new Map<string, TermInfo>();
	readonly byGroup = new Map<string, TermInfo>();
	private readonly children = new Map<string | null, TermInfo[]>();

	constructor(terms: readonly TermInfo[]) {
		for (const term of terms) this.add(term);
	}

	add(term: TermInfo): void {
		if (!this.bySlug.has(term.slug)) this.bySlug.set(term.slug, term);
		this.byGroup.set(term.group, term);
		const siblings = this.children.get(term.parentId) ?? [];
		siblings.push(term);
		this.children.set(term.parentId, siblings);
	}

	childrenOf(parent: TermInfo | null): TermInfo[] {
		return this.children.get(parent?.group ?? null) ?? [];
	}

	/** Every term, for a flat taxonomy's label lookup. */
	all(): TermInfo[] {
		return [...this.byGroup.values()];
	}

	/** The term and its ancestors, root first. */
	pathOf(term: TermInfo): TermInfo[] {
		const path = [term];
		for (let at = term; at.parentId !== null && path.length <= 100; ) {
			const parent = this.byGroup.get(at.parentId);
			if (!parent) break;
			path.unshift(parent);
			at = parent;
		}
		return path;
	}
}

type BylineIndex = {
	bySlug: Map<string, BylineRef>;
	byName: Map<string, BylineRef[]>;
	/** Every byline of the locale was loaded. */
	complete: boolean;
};

/**
 * Lookups shared by the records of one batch: each mapped taxonomy's terms (with the terms the
 * batch creates), the bylines, and reference hits. Misses are not kept, because a later record
 * of the batch may create what was missing.
 */
export class LookupCache {
	readonly terms = new Map<string, TermIndex>();
	/** Terms a dry run would have created, numbered for their placeholder IDs. */
	planned = 0;
	/** A dry run's lookups of keys planned for creation in the job's collection, by key. */
	readonly plannedKeys = new Map<string, boolean>();
	/** The terms earlier batches of this dry run planned (from the job); replayed on indexing. */
	readonly priorPlanned: readonly PlannedTerm[];
	/** The terms this batch planned, for the job to keep. */
	readonly newPlanned: PlannedTerm[] = [];
	/** Some planned term was not kept because the job already holds `MAX_PLANNED_TERMS`. */
	plannedOverflow = false;
	/** The serialized size of the planned terms kept so far, prior ones included. */
	plannedBytes = 0;
	/** The lookup cost spent so far in this batch, in the units above. */
	spent = 0;
	bylines: BylineIndex | null = null;
	readonly entries = new Map<string, { id: string; group: string }>();
	/** Media items read or stored this batch, by ID; null when missing or not ready. */
	readonly mediaItems = new Map<string, MediaInfo | null>();
	/** Items already obtained or refreshed this batch, by media map key: a URL is fetched once. */
	readonly mediaObtained = new Map<string, MediaInfo>();
	/** Media failures this batch, by media map key: a failing URL is fetched once. */
	readonly mediaFailed = new Map<string, LinkError>();
	/** Media downloads started this batch. */
	mediaDownloads = 0;
	/** When this batch's downloads must be done by (epoch ms); `runBatch` sets it. */
	mediaDeadline = Number.POSITIVE_INFINITY;

	/** `budget`: the batch should end after the record that brings `spent` to this. */
	constructor(
		priorPlanned: readonly PlannedTerm[] = [],
		readonly budget: number = Number.POSITIVE_INFINITY,
	) {
		this.priorPlanned = priorPlanned;
		this.plannedBytes = priorPlanned.length === 0 ? 0 : JSON.stringify(priorPlanned).length;
	}

	spend(units: number): void {
		this.spent += units;
	}

	get exhausted(): boolean {
		return this.spent >= this.budget;
	}
}

/** A matched term, or why there is none; `missing` lists the path's segments still to create. */
type TermMatch =
	| { kind: "found"; term: TermInfo }
	| { kind: "missing"; parent: TermInfo | null; missing: string[] }
	| { kind: "error"; code: string; message: string };

/**
 * The one term among `candidates` whose label is `label`: an exact match first, then the only
 * one equal ignoring case (the M4a select rule). Two matches are ambiguous.
 */
function byLabel(candidates: readonly TermInfo[], label: string): TermInfo | "ambiguous" | null {
	const exact = candidates.filter((t) => t.label.trim() === label);
	if (exact.length === 1) return exact[0] as TermInfo;
	if (exact.length > 1) return "ambiguous";
	const lower = label.toLowerCase();
	const loose = candidates.filter((t) => t.label.trim().toLowerCase() === lower);
	if (loose.length === 1) return loose[0] as TermInfo;
	return loose.length > 1 ? "ambiguous" : null;
}

/** Finds one term request in the index, without creating anything. */
function matchTerm(
	index: TermIndex,
	taxonomy: string,
	request: TermRequest,
	o: { match: "slug" | "label"; create: boolean; hierarchical: boolean },
): TermMatch {
	const { path } = request;
	const shown = path.join("/");
	const notFound: TermMatch = {
		kind: "error",
		code: "term_not_found",
		message: `No term ${o.match === "label" ? "labelled" : "with the slug"} "${shown}" in "${taxonomy}"`,
	};
	if (o.match === "label") {
		let parent: TermInfo | null = null;
		for (const [i, segment] of path.entries()) {
			const candidates = o.hierarchical ? index.childrenOf(parent) : index.all();
			const found = byLabel(candidates, segment);
			if (found === "ambiguous") {
				const where =
					parent === null
						? ""
						: ` under "${index
								.pathOf(parent)
								.map((t) => t.label)
								.join(" > ")}"`;
				return {
					kind: "error",
					code: "ambiguous_term",
					message: `More than one term in "${taxonomy}" is labelled "${segment}"${where}`,
				};
			}
			if (found === null) {
				return o.create ? { kind: "missing", parent, missing: path.slice(i) } : notFound;
			}
			parent = found;
		}
		return { kind: "found", term: parent as TermInfo };
	}
	// Slugs are unique per taxonomy and locale, so one segment names a term at any depth.
	const last = path[path.length - 1] as string;
	const term = index.bySlug.get(last);
	if (path.length === 1) {
		if (term) return { kind: "found", term };
		return o.create ? { kind: "missing", parent: null, missing: path } : notFound;
	}
	const mismatch = (existing: TermInfo): TermMatch => ({
		kind: "error",
		code: "term_path_mismatch",
		message: `Term "${existing.slug}" in "${taxonomy}" is at "${index
			.pathOf(existing)
			.map((t) => t.slug)
			.join("/")}", not under "${shown}"`,
	});
	if (!o.create) {
		if (!term) return notFound;
		const chain = index.pathOf(term).map((t) => t.slug);
		return chain.join("/") === shown ? { kind: "found", term } : mismatch(term);
	}
	let parent: TermInfo | null = null;
	for (const [i, segment] of path.entries()) {
		const existing = index.bySlug.get(segment);
		if (!existing) {
			// A slug that exists elsewhere cannot be created under a new parent.
			const elsewhere = path.slice(i + 1).find((s) => index.bySlug.has(s));
			if (elsewhere !== undefined) return mismatch(index.bySlug.get(elsewhere) as TermInfo);
			return { kind: "missing", parent, missing: path.slice(i) };
		}
		if (existing.parentId !== (parent?.group ?? null)) return mismatch(existing);
		parent = existing;
	}
	return { kind: "found", term: parent as TermInfo };
}

/** The terms of one taxonomy in the locale, loaded once per batch. */
async function termIndex(
	deps: ResolveDeps,
	cache: LookupCache,
	taxonomy: string,
	locale: string,
): Promise<TermIndex> {
	let index = cache.terms.get(taxonomy);
	if (!index) {
		cache.spend(COST_CALL);
		index = new TermIndex(await deps.lookups.terms(taxonomy, locale));
		cache.terms.set(taxonomy, index);
		replayPlanned(index, cache, taxonomy);
	}
	return index;
}

/** The term at `segment` under `parent`, by slug or by label; null when none or ambiguous. */
function findSegment(
	index: TermIndex,
	match: "slug" | "label",
	parent: TermInfo | null,
	segment: string,
): TermInfo | null {
	if (match === "slug") {
		const bySlug = index.bySlug.get(segment);
		return bySlug && bySlug.parentId === (parent?.group ?? null) ? bySlug : null;
	}
	const found = byLabel(index.childrenOf(parent), segment);
	return found === "ambiguous" ? null : found;
}

/** A dry run's stand-in for a term it would create; never sent to EmDash. */
function addPlaceholder(
	index: TermIndex,
	cache: LookupCache,
	match: "slug" | "label",
	parent: TermInfo | null,
	segment: string,
): TermInfo {
	const id = `${PLANNED}${++cache.planned}`;
	const slug = match === "slug" ? segment : slugify(segment);
	const term = { id, slug, label: segment, parentId: parent?.group ?? null, group: id };
	index.add(term);
	return term;
}

/** Adds the placeholders for the terms earlier batches of this dry run planned. */
function replayPlanned(index: TermIndex, cache: LookupCache, taxonomy: string): void {
	for (const planned of cache.priorPlanned) {
		if (planned.taxonomy !== taxonomy) continue;
		let parent: TermInfo | null = null;
		for (const segment of planned.path) {
			let term = findSegment(index, planned.match, parent, segment);
			if (!term) {
				// A slug that now sits elsewhere is a clash the record itself reports.
				if (planned.match === "slug" && index.bySlug.has(segment)) break;
				term = addPlaceholder(index, cache, planned.match, parent, segment);
			}
			parent = term;
		}
	}
}

/** Keeps a planned path for the job's later batches, up to the cap. */
function keepPlanned(cache: LookupCache, planned: PlannedTerm): void {
	const size = JSON.stringify(planned).length + 1;
	if (
		cache.priorPlanned.length + cache.newPlanned.length >= MAX_PLANNED_TERMS ||
		cache.plannedBytes + size > MAX_PLANNED_BYTES
	) {
		cache.plannedOverflow = true;
		return;
	}
	cache.plannedBytes += size;
	cache.newPlanned.push(planned);
}

const labelPath = (terms: readonly { label: string }[]) => terms.map((t) => t.label).join(" > ");

/** A dry run's stand-in for a term it would create; never sent to EmDash. */
const PLANNED = "planned:";

/** The identity of a dry run's planned item, which has no group to compare. */
const plannedIds = new WeakMap<ResolvedItem, string>();

function termItem(index: TermIndex, term: TermInfo): ResolvedItem {
	const planned = term.id.startsWith(PLANNED);
	const item: ResolvedItem = {
		group: planned ? null : term.group,
		value: planned ? "" : term.slug,
		text: index
			.pathOf(term)
			.map((t) => t.slug)
			.join("/"),
	};
	if (planned) plannedIds.set(item, term.id);
	return item;
}

/**
 * In slug mode a slug is unique per taxonomy, not per parent: a record that would create one
 * slug under two parents (or under itself) would fail halfway through creating. Checked against
 * the index alone, before anything is created, so a dry run and a real run agree.
 */
function checkSlugClashes(
	index: TermIndex,
	taxonomy: string,
	pending: readonly PendingTerm[],
	errors: LinkError[],
): void {
	const parents = new Map<string, { key: string; shown: string }>();
	const field = `taxonomies.${taxonomy}`;
	for (const p of pending) {
		let parentKey = p.parent?.group ?? "";
		let chain = p.parent ? index.pathOf(p.parent).map((t) => t.slug) : [];
		for (const segment of p.missing) {
			const existing = index.bySlug.get(segment);
			const seen = parents.get(segment);
			const here = chain.join("/") || "(top level)";
			if (existing) {
				const at = index
					.pathOf(existing)
					.map((t) => t.slug)
					.join("/");
				errors.push({
					field,
					code: "term_path_mismatch",
					message: `Term "${segment}" in "${taxonomy}" is at "${at}", not under "${here}"`,
				});
				break;
			}
			if (seen !== undefined && seen.key !== parentKey) {
				errors.push({
					field,
					code: "term_path_mismatch",
					message: `Term "${segment}" in "${taxonomy}" would be created under both "${seen.shown}" and "${here}"`,
				});
				break;
			}
			parents.set(segment, { key: parentKey, shown: here });
			parentKey = `new:${[...chain, segment].join("/")}`;
			chain = [...chain, segment];
		}
	}
}

/**
 * Creates the missing segments of one path under `parent`, in order, reusing a term the batch
 * created meanwhile. A failed create (a concurrent creator's `CONFLICT`, or anything else) reloads
 * the terms and looks the segment up again before giving up. A dry run adds a placeholder
 * instead, so later records of the batch find the term as they would in a real run.
 */
async function createPath(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	taxonomy: string,
	match: "slug" | "label",
	start: TermInfo | null,
	missing: readonly string[],
	created: string[],
): Promise<{ ok: true; term: TermInfo } | { ok: false; message: string }> {
	const locale = ctx.template.locale;
	let parent = start;
	let plannedAny = false;
	for (const segment of missing) {
		let index = await termIndex(deps, cache, taxonomy, locale);
		const under = parent;
		const find = (ix: TermIndex) => findSegment(ix, match, under, segment);
		let term = find(index);
		if (!term && ctx.dryRun) {
			term = addPlaceholder(index, cache, match, parent, segment);
			plannedAny = true;
			created.push(`${taxonomy}: ${labelPath(index.pathOf(term))}`);
		}
		if (!term) {
			try {
				cache.spend(COST_CREATE_TERM);
				term = await deps.lookups.createTerm(taxonomy, {
					label: segment,
					...(match === "slug" ? { slug: segment } : {}),
					...(parent === null ? {} : { parentId: parent.id }),
					locale,
				});
				index.add(term);
				created.push(`${taxonomy}: ${labelPath(index.pathOf(term))}`);
			} catch (e) {
				cache.spend(COST_CALL);
				index = new TermIndex(await deps.lookups.terms(taxonomy, locale));
				cache.terms.set(taxonomy, index);
				term = find(index);
				if (!term) {
					const reason = e instanceof Error ? e.message : String(e);
					return {
						ok: false,
						message: `Could not create "${segment}" in "${taxonomy}": ${reason}`,
					};
				}
			}
		}
		parent = term;
	}
	if (plannedAny && parent) {
		const index = cache.terms.get(taxonomy) as TermIndex;
		const path = index.pathOf(parent).map((t) => (match === "slug" ? t.slug : t.label));
		keepPlanned(cache, { taxonomy, path, match });
	}
	return { ok: true, term: parent as TermInfo };
}

/** Resolves one taxonomy's terms; creation is planned in `pending`, not done. */
type PendingTerm = {
	taxonomy: string;
	match: "slug" | "label";
	position: number;
	parent: TermInfo | null;
	missing: string[];
	path: string[];
};

async function resolveTerms(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	taxonomy: string,
	requests: readonly TermRequest[],
	errors: LinkError[],
	pending: PendingTerm[],
): Promise<ResolvedItem[]> {
	const mapping = ctx.template.taxonomies?.[taxonomy];
	const match = mapping?.match ?? "slug";
	const create = mapping?.create ?? false;
	const hierarchical = ctx.taxonomies[taxonomy]?.hierarchical ?? false;
	const field = `taxonomies.${taxonomy}`;
	const items: ResolvedItem[] = [];
	if (requests.length === 0) return items;
	const index = await termIndex(deps, cache, taxonomy, ctx.template.locale);
	for (const request of requests) {
		const found = matchTerm(index, taxonomy, request, { match, create, hierarchical });
		if (found.kind === "error") {
			errors.push({ field, code: found.code, message: found.message });
			continue;
		}
		if (found.kind === "found") {
			items.push(termItem(index, found.term));
			continue;
		}
		const bad = match === "slug" ? found.missing.find((s) => slugify(s) !== s) : undefined;
		if (bad !== undefined) {
			errors.push({
				field,
				code: "invalid_term_slug",
				message: `"${bad}" is not a slug, so no term can be created with it (use lowercase letters, digits and hyphens, or match: "label")`,
			});
			continue;
		}
		pending.push({
			taxonomy,
			match,
			position: items.length,
			parent: found.parent,
			missing: found.missing,
			path: request.path,
		});
		items.push({ group: null, value: "", text: request.path.join("/") });
	}
	return items;
}

const referenceKey = (target: string, match: string, value: string) =>
	`${target}\u0000${match}\u0000${value}`;

/** One reference item: the hit from the batch cache, or a lookup; null when nothing matches. */
async function findReference(
	deps: ResolveDeps,
	cache: LookupCache,
	target: string,
	match: "id" | "slug" | "key",
	value: string,
	locale: string,
	sourceIdReady: boolean,
): Promise<{ id: string; group: string } | null> {
	const key = referenceKey(target, match, value);
	const hit = cache.entries.get(key);
	if (hit) return hit;
	let found: { id: string; group: string } | null = null;
	if (match === "key") {
		// The importer's own link first, verified; then the source ID it wrote into the entry.
		cache.spend(COST_CALL);
		const link = await deps.links.get(linkKey(target, locale, value));
		if (link) cache.spend(COST_READ);
		const linked = link ? await deps.content.get(target, locale, link.entryId) : null;
		// A dry run's first batch has not added the source ID field yet; filtering on it fails.
		let entry = linked;
		if (!entry && sourceIdReady) {
			cache.spend(COST_READ);
			entry = await deps.content.findBySourceId(target, locale, value);
		}
		found = entry ? { id: entry.id, group: entry.group ?? entry.id } : null;
	} else {
		cache.spend(COST_READ);
		found = await deps.lookups.findEntry(target, match, value, locale);
	}
	if (found) cache.entries.set(key, found);
	return found;
}

const NOT_FOUND_BY = {
	id: (target: string, value: string) => `No entry in "${target}" has the ID "${value}"`,
	slug: (target: string, value: string, locale: string) =>
		`No entry in "${target}" (${locale}) has the slug "${value}"`,
	key: (target: string, value: string, locale: string) =>
		`No entry in "${target}" (${locale}) was imported with the key "${value}"`,
};

async function resolveReferences(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	field: string,
	values: readonly string[],
	errors: LinkError[],
): Promise<ResolvedItem[]> {
	const mapping = ctx.template.fields[field];
	const match = mapping?.type === "reference" ? (mapping.match ?? "id") : "id";
	const target = ctx.targets[field]?.targetCollection;
	const locale = ctx.template.locale;
	if (target === undefined) {
		errors.push({
			field,
			code: "reference_not_found",
			message: "The job does not know which collection this field links to",
		});
		return [];
	}
	const items: ResolvedItem[] = [];
	for (const value of values) {
		try {
			const found = await findReference(
				deps,
				cache,
				target,
				match,
				value,
				locale,
				ctx.sourceIdReady !== false || target !== ctx.template.collection,
			);
			const own = match === "key" && target === ctx.template.collection;
			if (found) items.push({ group: found.group, value: found.id, text: found.id });
			else if (own && ctx.dryRun && ctx.plannedKey && (await ctx.plannedKey(value))) {
				items.push({ group: null, value: "", text: value });
			} else {
				const message = NOT_FOUND_BY[match](target, value, locale);
				errors.push({ field, code: "reference_not_found", message });
			}
		} catch (e) {
			// A lookup that fails on this value (an ambiguous source ID, an EmDash read error)
			// fails the record, not the job.
			if (!(e instanceof ContentWriteError)) throw e;
			errors.push({ field, code: e.code, message: e.message });
		}
	}
	return items;
}

/** The locale's bylines, loaded once per batch, at most `MAX_BYLINE_LOOKUP`. */
async function bylineIndex(
	deps: ResolveDeps,
	cache: LookupCache,
	locale: string,
): Promise<BylineIndex> {
	if (cache.bylines) return cache.bylines;
	const index: BylineIndex = { bySlug: new Map(), byName: new Map(), complete: true };
	let cursor: string | undefined;
	let loaded = 0;
	do {
		cache.spend(COST_READ);
		const page = await deps.lookups.bylines(locale, cursor);
		for (const byline of page.items) {
			if (!index.bySlug.has(byline.slug)) index.bySlug.set(byline.slug, byline);
			const name = byline.displayName.trim();
			index.byName.set(name, [...(index.byName.get(name) ?? []), byline]);
		}
		loaded += page.items.length;
		cursor = page.cursor;
		if (cursor !== undefined && loaded >= MAX_BYLINE_LOOKUP) {
			index.complete = false;
			break;
		}
	} while (cursor !== undefined);
	cache.bylines = index;
	return index;
}

async function resolveBylines(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	values: readonly string[],
	errors: LinkError[],
): Promise<ResolvedItem[]> {
	const match = ctx.template.bylines?.match ?? "slug";
	const locale = ctx.template.locale;
	if (values.length === 0) return [];
	const index = await bylineIndex(deps, cache, locale);
	const items: ResolvedItem[] = [];
	for (const value of values) {
		const found =
			match === "slug"
				? [index.bySlug.get(value)].filter((b) => b !== undefined)
				: (index.byName.get(value) ?? []);
		if (found.length > 1) {
			errors.push({
				field: "bylines",
				code: "ambiguous_byline",
				message: `More than one byline (${locale}) is named "${value}"`,
			});
		} else if (found.length === 1) {
			const byline = found[0] as BylineRef;
			items.push({ group: byline.group, value: byline.id, text: byline.slug });
		} else if (index.complete) {
			errors.push({
				field: "bylines",
				code: "byline_not_found",
				message: `No byline (${locale}) has the ${match} "${value}"`,
			});
		} else {
			errors.push({
				field: "bylines",
				code: "byline_lookup_limit",
				message: `No byline (${locale}) with the ${match} "${value}" among the first ${MAX_BYLINE_LOOKUP}; the site has more`,
			});
		}
	}
	return items;
}

/** Drops later items with the same identity: the same group, or the same text for new terms. */
function distinct(items: readonly ResolvedItem[]): ResolvedItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const id = item.group ?? `new:${plannedIds.get(item) ?? item.text}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

/**
 * Resolves a record's link requests. An empty value (null) resolves to an empty list. Without
 * errors, a real run then creates the missing terms of `create: true` taxonomies; a dry run
 * creates nothing and lists them in `newTerms` (as a real run lists the ones it created), with
 * placeholders that later records of the batch find.
 */
export async function resolveLinks(
	deps: ResolveDeps,
	cache: LookupCache,
	ctx: ResolveContext,
	links: LinkRequests,
): Promise<Resolution> {
	const errors: LinkError[] = [];
	const pending: PendingTerm[] = [];
	const resolved: ResolvedLinks = {};
	for (const [field, values] of Object.entries(links.references ?? {})) {
		const items = await resolveReferences(deps, cache, ctx, field, values ?? [], errors);
		resolved.references ??= {};
		resolved.references[field] = items;
	}
	for (const [taxonomy, requests] of Object.entries(links.taxonomies ?? {})) {
		const items = await resolveTerms(deps, cache, ctx, taxonomy, requests ?? [], errors, pending);
		resolved.taxonomies ??= {};
		resolved.taxonomies[taxonomy] = items;
	}
	if (links.bylines !== undefined) {
		resolved.bylines = await resolveBylines(deps, cache, ctx, links.bylines ?? [], errors);
	}
	for (const taxonomy of Object.keys(resolved.taxonomies ?? {})) {
		const own = pending.filter((p) => p.taxonomy === taxonomy);
		if (own.length === 0 || own[0]?.match !== "slug") continue;
		checkSlugClashes(cache.terms.get(taxonomy) as TermIndex, taxonomy, own, errors);
	}
	if (errors.length > 0) return { ok: false, errors, newTerms: [] };

	const newTerms: string[] = [];
	for (const p of pending) {
		const items = resolved.taxonomies?.[p.taxonomy] as ResolvedItem[];
		const created = await createPath(
			deps,
			cache,
			ctx,
			p.taxonomy,
			p.match,
			p.parent,
			p.missing,
			newTerms,
		);
		if (!created.ok) {
			errors.push({
				field: `taxonomies.${p.taxonomy}`,
				code: "term_create_failed",
				message: created.message,
			});
			break;
		}
		const index = cache.terms.get(p.taxonomy) as TermIndex;
		items[p.position] = termItem(index, created.term);
	}
	if (errors.length > 0) return { ok: false, errors, newTerms };
	for (const field of Object.keys(resolved.references ?? {})) {
		const refs = resolved.references as Record<string, ResolvedItem[]>;
		refs[field] = distinct(refs[field] ?? []);
	}
	for (const taxonomy of Object.keys(resolved.taxonomies ?? {})) {
		const terms = resolved.taxonomies as Record<string, ResolvedItem[]>;
		terms[taxonomy] = distinct(terms[taxonomy] ?? []);
	}
	if (resolved.bylines) resolved.bylines = distinct(resolved.bylines);
	return { ok: true, links: resolved, newTerms };
}

/** Loads a taxonomy's terms into the batch cache when no lookup of the batch has yet. */
export async function loadTerms(
	deps: ResolveDeps,
	cache: LookupCache,
	taxonomy: string,
	locale: string,
): Promise<void> {
	await termIndex(deps, cache, taxonomy, locale);
}

/**
 * How the record log shows an assigned term: its slug path when the batch loaded it (the
 * template's locale), else its translation group.
 */
export function termPath(cache: LookupCache, taxonomy: string, group: string): string {
	const index = cache.terms.get(taxonomy);
	const term = index?.byGroup.get(group);
	if (!index || !term) return group;
	return index
		.pathOf(term)
		.map((t) => t.slug)
		.join("/");
}
