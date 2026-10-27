import { EmDashStorageError } from "emdash";
import type { UploadStorage } from "../../src/emdash/uploads.js";
import {
	type BylineRef,
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type KvCollection,
	type LinkWrites,
	type LookupPort,
	SourceMissingError,
	type SourcePort,
	type TaxonomyDef,
	type TermInfo,
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type { EngineDeps, Job, LinkRow, RecordRow } from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import { streamOf } from "./helpers.js";

function matches(data: Record<string, unknown>, where: Where): boolean {
	return Object.entries(where).every(([k, cond]) => {
		const v = data[k];
		if (cond !== null && typeof cond === "object") {
			const c = cond as Record<string, unknown>;
			if ("in" in c) return (c.in as unknown[]).includes(v);
			// Numbers and ISO timestamps both compare correctly with the relational operators.
			const x = v as number | string;
			if ("gte" in c && !(x >= (c.gte as number | string))) return false;
			if ("gt" in c && !(x > (c.gt as number | string))) return false;
			if ("lte" in c && !(x <= (c.lte as number | string))) return false;
			if ("lt" in c && !(x < (c.lt as number | string))) return false;
			return true;
		}
		return v === cond;
	});
}

export class MemoryKv<T> implements KvCollection<T> {
	readonly rows = new Map<string, { value: T; revision: number }>();
	private rev = 0;

	async get(id: string) {
		const row = this.rows.get(id);
		return row ? structuredClone(row.value) : null;
	}
	private write(id: string, data: T): number {
		const revision = ++this.rev;
		this.rows.set(id, { value: structuredClone(data), revision });
		return revision;
	}
	async put(id: string, data: T) {
		this.write(id, data);
	}
	async delete(id: string) {
		return this.rows.delete(id);
	}
	async deleteMany(ids: string[]) {
		let n = 0;
		for (const id of ids) if (this.rows.delete(id)) n++;
		return n;
	}
	async getVersioned(id: string) {
		const row = this.rows.get(id);
		return row ? { value: structuredClone(row.value), revision: String(row.revision) } : null;
	}
	async compareAndSet(id: string, expected: string | null, data: T) {
		const row = this.rows.get(id);
		const current = row ? String(row.revision) : null;
		if (current !== expected) return { applied: false as const };
		return { applied: true as const, revision: String(this.write(id, data)) };
	}
	async query(opts: {
		where?: Where;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}) {
		let items = [...this.rows.entries()]
			.map(([id, r]) => ({ id, data: structuredClone(r.value) }))
			.filter((i) => matches(i.data as Record<string, unknown>, opts.where ?? {}));
		for (const [field, dir] of Object.entries(opts.orderBy ?? {}).reverse()) {
			items = items.sort((a, b) => {
				const av = (a.data as Record<string, number | string>)[field] as number | string;
				const bv = (b.data as Record<string, number | string>)[field] as number | string;
				const order = av < bv ? -1 : av > bv ? 1 : 0;
				return dir === "asc" ? order : -order;
			});
		}
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? 50;
		const page = items.slice(start, start + limit);
		const hasMore = start + limit < items.length;
		return hasMore
			? { items: page, cursor: String(start + limit), hasMore }
			: { items: page, hasMore };
	}
}

type StoredEntry = {
	id: string;
	locale: string;
	collection: string;
	slug: string | null;
	data: Record<string, unknown>;
	rev: number;
	pendingPublish: boolean;
	/** Term slugs by taxonomy, entry IDs by reference field, byline credits: as written. */
	taxonomies: Record<string, string[]>;
	references: Record<string, string[]>;
	bylines: { bylineId: string; roleLabel: string | null }[];
};

export class FakeContent implements ContentPort {
	readonly entries = new Map<string, StoredEntry>();
	readonly locked = new Set<string>();
	readonly calls: string[] = [];
	sourceFieldEnsured = false;
	/** Called after a successful create or update; throw from it to simulate a crash. */
	afterWrite: (id: string) => void = () => {};
	/** Return a ContentWriteError to make a write with this data fail. */
	failWrite: (data: Record<string, unknown>) => ContentWriteError | null = () => null;
	/** A byline's slug, for read-back; `makeDeps` answers from its `FakeLookups`. */
	bylineSlug: (id: string) => string = (id) => id;
	/** Every write's links, as given. */
	readonly linkWrites: LinkWrites[] = [];
	/** Return a reason to make publishing this entry fail. */
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
	private next = 0;

	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
			rev: String(e.rev),
			slug: e.slug,
			data: structuredClone(e.data),
			group: e.id,
			pendingPublish: e.pendingPublish,
			...(options.references
				? {
						references: Object.fromEntries(
							Object.entries(e.references).map(([f, ids]) => [
								f,
								ids.map((id) => ({ group: id, id })),
							]),
						),
					}
				: {}),
			bylines: e.bylines.map((b) => ({
				group: b.bylineId,
				id: b.bylineId,
				slug: this.bylineSlug(b.bylineId),
				roleLabel: b.roleLabel,
			})),
		};
	}
	async get(collection: string, locale: string, id: string, options?: GetOptions) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale ? this.snap(e, options) : null;
	}
	async findBySourceId(collection: string, locale: string, sourceId: string, options?: GetOptions) {
		this.calls.push(`find:${sourceId}`);
		for (const e of this.entries.values()) {
			if (
				e.collection === collection &&
				e.locale === locale &&
				e.data.flux_source_id === sourceId
			) {
				return this.snap(e, options);
			}
		}
		return null;
	}
	/** Writes the links given; each replaces that link's value. */
	private writeLinks(e: StoredEntry, input: LinkWrites) {
		const links: LinkWrites = {
			...(input.taxonomies ? { taxonomies: input.taxonomies } : {}),
			...(input.references ? { references: input.references } : {}),
			...(input.bylines ? { bylines: input.bylines } : {}),
		};
		this.linkWrites.push(structuredClone(links));
		Object.assign(e.taxonomies, structuredClone(input.taxonomies ?? {}));
		Object.assign(e.references, structuredClone(input.references ?? {}));
		if (input.bylines) e.bylines = structuredClone(input.bylines);
	}
	async isLocked(_c: string, _l: string, id: string) {
		return this.locked.has(id);
	}
	async create(
		input: {
			collection: string;
			locale: string;
			slug?: string;
			data: Record<string, unknown>;
		} & LinkWrites,
	) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const id = `e${++this.next}`;
		const entry: StoredEntry = {
			id,
			collection: input.collection,
			locale: input.locale,
			slug: input.slug ?? null,
			data: structuredClone(input.data),
			rev: 1,
			pendingPublish: true,
			taxonomies: {},
			references: {},
			bylines: [],
		};
		this.writeLinks(entry, input);
		this.entries.set(id, entry);
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: "1" };
	}
	async update(
		input: {
			id: string;
			rev: string;
			slug?: string;
			data?: Record<string, unknown>;
		} & LinkWrites,
	): Promise<WriteResult> {
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		e.data = { ...e.data, ...structuredClone(input.data ?? {}) };
		if (input.slug !== undefined) e.slug = input.slug;
		this.writeLinks(e, input);
		e.rev++;
		// As EmDash on revisioned collections: terms and bylines are live metadata (no draft).
		if (input.data !== undefined || input.slug !== undefined || input.references) {
			e.pendingPublish = true;
		}
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
	}
	async publish(input: { id: string; rev: string }): Promise<WriteResult> {
		this.beforePublish(input.id);
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		const forced = this.failPublish(e.id);
		if (forced) return { ok: false, reason: forced };
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		e.pendingPublish = false;
		e.rev++;
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: String(e.rev) };
	}
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
	}
}

type StoredTerm = TermInfo & { taxonomy: string; locale: string };

/**
 * In-memory `LookupPort`: terms and bylines added by tests (a term's group is its ID), and
 * entries and entry terms from the `FakeContent` (an entry's group is its ID).
 */
export class FakeLookups implements LookupPort {
	readonly defs: TaxonomyDef[] = [];
	readonly storedTerms: StoredTerm[] = [];
	readonly storedBylines: (BylineRef & { locale: string })[] = [];
	readonly calls: string[] = [];
	/** Return an error to make creating this term fail. */
	failCreate: (taxonomy: string, input: { label: string; slug?: string }) => Error | null = () =>
		null;
	private next = 0;

	constructor(private readonly content: FakeContent) {}

	/** Adds a term; `parent` is the parent's slug in the same taxonomy and locale. */
	addTerm(taxonomy: string, slug: string, label: string, parent?: string, locale = "en"): TermInfo {
		const parentTerm =
			parent === undefined
				? null
				: this.storedTerms.find(
						(t) => t.taxonomy === taxonomy && t.locale === locale && t.slug === parent,
					);
		if (parent !== undefined && !parentTerm) throw new Error(`No parent term ${parent}`);
		const id = `t${++this.next}`;
		const term = { id, slug, label, parentId: parentTerm?.group ?? null, group: id };
		this.storedTerms.push({ ...term, taxonomy, locale });
		return term;
	}

	addByline(slug: string, displayName: string, locale = "en"): BylineRef {
		const id = `b${++this.next}`;
		const byline = { id, slug, displayName, group: id };
		this.storedBylines.push({ ...byline, locale });
		return byline;
	}

	async taxonomyDefs() {
		this.calls.push("defs");
		return structuredClone(this.defs);
	}

	async terms(taxonomy: string, locale: string) {
		this.calls.push(`terms:${taxonomy}:${locale}`);
		return this.storedTerms
			.filter((t) => t.taxonomy === taxonomy && t.locale === locale)
			.map(({ taxonomy: _t, locale: _l, ...term }) => term);
	}

	async createTerm(
		taxonomy: string,
		input: { label: string; slug?: string; parentId?: string; locale: string },
	) {
		this.calls.push(`create:${taxonomy}:${input.slug ?? input.label}`);
		const failure = this.failCreate(taxonomy, input);
		if (failure) throw failure;
		const inLocale = this.storedTerms.filter(
			(t) => t.taxonomy === taxonomy && t.locale === input.locale,
		);
		if (input.slug !== undefined && inLocale.some((t) => t.slug === input.slug)) {
			throw Object.assign(new Error(`Term '${input.slug}' already exists`), { code: "CONFLICT" });
		}
		const parent =
			input.parentId === undefined ? null : this.storedTerms.find((t) => t.id === input.parentId);
		if (input.parentId !== undefined && !parent) {
			throw Object.assign(new Error("Parent term not found"), { code: "VALIDATION_ERROR" });
		}
		// EmDash generates a unique slug from the label when none is given.
		let slug = input.slug ?? input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		for (let n = 1; input.slug === undefined && inLocale.some((t) => t.slug === slug); n++) {
			slug = `${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${n}`;
		}
		const parentSlug = parent?.slug;
		return this.addTerm(taxonomy, slug, input.label, parentSlug, input.locale);
	}

	/** The groups of the term slugs the `FakeContent` entry was given, by taxonomy. */
	async entryTerms(_collection: string, entryId: string) {
		this.calls.push(`entryTerms:${entryId}`);
		const e = this.content.entries.get(entryId);
		const groups: Record<string, string[]> = {};
		for (const [taxonomy, slugs] of Object.entries(e?.taxonomies ?? {})) {
			if (slugs.length === 0) continue;
			groups[taxonomy] = slugs.map((slug) => {
				const term = this.storedTerms.find(
					(t) => t.taxonomy === taxonomy && t.locale === e?.locale && t.slug === slug,
				);
				return term?.group ?? `unknown:${slug}`;
			});
		}
		return groups;
	}

	/** Pages of two, so tests see the cursor. */
	async bylines(locale: string, cursor?: string) {
		this.calls.push(`bylines:${locale}:${cursor ?? ""}`);
		const all = this.storedBylines
			.filter((b) => b.locale === locale)
			.map(({ locale: _l, ...b }) => b);
		const start = cursor === undefined ? 0 : Number(cursor);
		const items = all.slice(start, start + 2);
		return start + 2 < all.length ? { items, cursor: String(start + 2) } : { items };
	}

	async findEntry(collection: string, by: "id" | "slug", value: string, locale: string) {
		this.calls.push(`find:${collection}:${by}:${value}`);
		for (const e of this.content.entries.values()) {
			if (e.collection !== collection) continue;
			if (by === "id" ? e.id === value : e.locale === locale && e.slug === value) {
				return { id: e.id, group: e.id };
			}
		}
		return null;
	}
}

export class FakeSource implements SourcePort {
	readonly uploads = new Map<string, Uint8Array>();
	opens = 0;
	add(id: string, csv: string) {
		this.uploads.set(id, new TextEncoder().encode(csv));
	}
	async open(uploadId: string, offset: number) {
		const bytes = this.uploads.get(uploadId);
		if (!bytes) throw new SourceMissingError(uploadId);
		this.opens++;
		return dropBytes(streamOf(bytes, 7), offset);
	}
}

export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	const lookups = new FakeLookups(content);
	content.bylineSlug = (id) => lookups.storedBylines.find((b) => b.id === id)?.slug ?? id;
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content,
		lookups,
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
	} satisfies EngineDeps;
	return { deps, clock };
}

type StoredFile = { bytes: Uint8Array; lastModified: Date };

/** In-memory `emdash.storage` with the local adapter's range and NOT_FOUND behaviour. */
export class FakeStorage implements UploadStorage {
	readonly files = new Map<string, StoredFile>();
	/** What each upload() call received: a stream or bytes. */
	readonly bodies: Array<"stream" | "bytes"> = [];
	now = () => new Date("2026-10-07T10:00:00Z");

	async upload(options: { key: string; body: Buffer | Uint8Array | ReadableStream<Uint8Array> }) {
		const { body } = options;
		let bytes: Uint8Array;
		this.bodies.push(body instanceof ReadableStream ? "stream" : "bytes");
		if (body instanceof ReadableStream) {
			const chunks: Uint8Array[] = [];
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
			bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
			let at = 0;
			for (const c of chunks) {
				bytes.set(c, at);
				at += c.length;
			}
		} else {
			bytes = new Uint8Array(body);
		}
		this.files.set(options.key, { bytes, lastModified: this.now() });
		return { key: options.key, url: `/media/${options.key}`, size: bytes.length };
	}

	async download(
		key: string,
		options?: { range?: { offset: number; length?: number } | { suffix: number } },
	) {
		const file = this.files.get(key);
		if (!file) throw Object.assign(new Error(`File not found: ${key}`), { code: "NOT_FOUND" });
		const size = file.bytes.length;
		const range = options?.range;
		if (range && "offset" in range && range.offset >= 0 && range.offset < size) {
			const length = Math.min(range.length ?? size, size - range.offset);
			return {
				body: streamOf(file.bytes.slice(range.offset, range.offset + length), 7),
				contentType: "text/csv",
				size,
				range: { offset: range.offset, length },
			};
		}
		return { body: streamOf(file.bytes, 7), contentType: "text/csv", size };
	}

	async delete(key: string) {
		this.files.delete(key);
	}

	async exists(key: string) {
		return this.files.has(key);
	}

	async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
		const keys = [...this.files.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
		const start = options?.cursor ? Number(options.cursor) : 0;
		const limit = options?.limit ?? 100;
		const files = keys.slice(start, start + limit).map((key) => {
			const file = this.files.get(key)!;
			return { key, size: file.bytes.length, lastModified: file.lastModified };
		});
		return start + limit < keys.length ? { files, nextCursor: String(start + limit) } : { files };
	}
}

/** Wraps stream errors the way EmDash's LocalStorage and R2 adapters do. */
export class WrappingStorage extends FakeStorage {
	override async upload(options: Parameters<FakeStorage["upload"]>[0]) {
		try {
			return await super.upload(options);
		} catch (error) {
			throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED", error);
		}
	}
}

/**
 * `ctx.settings` for the credential functions: versioned values with compare-and-set, like
 * EmDash's options table. EmDash encrypts `secret` fields inside `set`/`compareAndSet`; this fake
 * stores what it is given.
 */
export class MemorySettings implements CredentialSettings {
	readonly values = new Map<string, { value: unknown; revision: number }>();
	private rev = 0;
	/** Called before each compareAndSet; use it to simulate a concurrent writer or a failure. */
	beforeWrite: () => void = () => {};

	async getVersioned<T>(key: string) {
		const row = this.values.get(key);
		return row ? { value: structuredClone(row.value) as T, revision: String(row.revision) } : null;
	}

	async compareAndSet(key: string, expected: string | null, value: unknown) {
		this.beforeWrite();
		const row = this.values.get(key);
		if ((row ? String(row.revision) : null) !== expected) return { applied: false as const };
		this.values.set(key, { value: structuredClone(value), revision: ++this.rev });
		return { applied: true as const, revision: String(this.rev) };
	}

	/** Writes a value directly, as the admin settings page would. */
	put(key: string, value: unknown) {
		this.values.set(key, { value, revision: ++this.rev });
	}
}
