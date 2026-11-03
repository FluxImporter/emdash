import { createHash } from "node:crypto";
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
	type MediaInfo,
	type MediaPort,
	type MediaUploadError,
	type RevertStep,
	SourceMissingError,
	type SourcePort,
	type StepResult,
	type TaxonomyDef,
	type TermInfo,
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import { encodeRev } from "../../src/engine/revs.js";
import type {
	EngineDeps,
	Job,
	JournalEntry,
	JournalMedia,
	LinkRow,
	MediaMapRow,
	RecordRow,
} from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
import { dropBytes } from "../../src/sources/csv.js";
import {
	MediaError,
	type MediaFetcher,
	type MediaFetchOptions,
	type MediaFetchResult,
} from "../../src/sources/media-fetch.js";
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

/** SQL's binary text order, which `ORDER BY` uses on SQLite and D1. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * EmDash's `normalizeDatetime` for a site in UTC (`datetimes.normalizeValue`,
 * database/content-datetime.ts:176-186; datetime-normalization.ts:209-250), as `schedule` applies
 * it (repositories/content.ts:2106): a naive time is read in the site's zone, here UTC; an
 * explicit offset is converted to UTC with milliseconds; anything else is a validation error. The
 * fake's check of the explicit form approximates EmDash's zod `iso.datetime` schema.
 */
function normalizeScheduledAt(value: string, op: string): string {
	const naive =
		/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
	let ms = Number.NaN;
	if (naive) {
		const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0"] = naive;
		const parts = [y, mo, d, h, mi, s].map(Number) as [
			number,
			number,
			number,
			number,
			number,
			number,
		];
		const t = Date.UTC(
			parts[0],
			parts[1] - 1,
			parts[2],
			parts[3],
			parts[4],
			parts[5],
			Number(frac.padEnd(3, "0")),
		);
		// As parseNaiveDatetime: a date that rolls over (Feb 30, 24:00) is not valid.
		const back = new Date(t);
		if (
			back.getUTCFullYear() === parts[0] &&
			back.getUTCMonth() + 1 === parts[1] &&
			back.getUTCDate() === parts[2] &&
			back.getUTCHours() === parts[3] &&
			back.getUTCMinutes() === parts[4] &&
			back.getUTCSeconds() === parts[5]
		) {
			ms = t;
		}
	} else if (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
	) {
		ms = Date.parse(value);
	}
	if (Number.isNaN(ms)) {
		throw new ContentWriteError(
			"emdash_validation_error",
			`${op} failed: Datetime ${JSON.stringify(value)} is not a valid ISO 8601 datetime`,
		);
	}
	return new Date(ms).toISOString();
}

type StoredEntry = {
	id: string;
	locale: string;
	collection: string;
	slug: string | null;
	data: Record<string, unknown>;
	/** The translation group: the entry's own ID, or its source's group (EmDash, spec M4e F3). */
	group: string;
	/** EmDash's `version`; the entry's `_rev` encodes it with `updatedAt` (`revOf`, spec M5b F1). */
	rev: number;
	pendingPublish: boolean;
	/** Term slugs by taxonomy, entry IDs by reference field, byline credits: as written. */
	taxonomies: Record<string, string[]>;
	references: Record<string, string[]>;
	bylines: { bylineId: string; roleLabel: string | null }[];
	/** M5a: `draft`, `scheduled` or `published`, and the schedule. */
	status: string;
	scheduledAt: string | null;
	/**
	 * M5b: EmDash's `published_at`. Set at the first publish (the sweep's first publication sets
	 * it to the scheduled time), kept by later publishes and by an unpublish (spec M5a F12).
	 */
	publishedAt: string | null;
	/**
	 * M5a: the live data and slug while a draft revision is pending (on a collection with
	 * revisions, a write staged after the entry's columns); null without one. `data` and `slug`
	 * always hold the latest values, the draft's included.
	 */
	live: { data: Record<string, unknown>; slug: string | null } | null;
	/**
	 * M5a: the live revision saved at the last publish (as EmDash's `live_revision_id`); an
	 * unpublish creates a draft from it (spec F18).
	 */
	published: { data: Record<string, unknown> } | null;
	/**
	 * M5a: on a collection without revisions, the draft an unpublish created: its stale values
	 * hide the columns in `get` until a discard, while later updates still write the columns.
	 */
	stale: { data: Record<string, unknown> } | null;
	trashed: boolean;
	createdAt: string;
	updatedAt: string;
};

export class FakeContent implements ContentPort {
	readonly entries = new Map<string, StoredEntry>();
	readonly locked = new Set<string>();
	readonly calls: string[] = [];
	sourceFieldEnsured = false;
	/** The collection has no `flux_source_id` field yet: EmDash then refuses to filter by it. */
	sourceIdFieldMissing = false;
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
	/** M5b: called at the start of schedule; throw from it to simulate a crash before it. */
	beforeSchedule: (id: string) => void = () => {};
	/** M5b: called after a schedule landed; throw from it to simulate a crash before its save. */
	afterSchedule: (id: string) => void = () => {};
	/**
	 * The non-translatable fields: a create with `translationOf` takes their values from the
	 * source, as EmDash does (spec M4e F1).
	 */
	readonly sharedFields = new Set<string>(["flux_source_id"]);
	/** M5a: collections without revisions, whose writes go straight to the live columns. */
	readonly plainCollections = new Set<string>();
	/** M5a: return a message to make a `content:beforeDelete` hook refuse the trash. */
	blockDelete: (id: string) => string | null = () => null;
	/** M5a: return a message to make a policy hook refuse a publish, unpublish or schedule. */
	blockStep: (step: RevertStep, id: string) => string | null = () => null;
	/** M5a: called at the start of every rollback step; throw from it to simulate a crash. */
	beforeStep: (step: RevertStep | "trash" | "delete", id: string) => void = () => {};
	/** M5a: called after a rollback step changed the entry; throw from it to simulate a crash. */
	afterStep: (step: RevertStep, id: string) => void = () => {};
	/** The clock for timestamps and schedules; `makeDeps` gives it the test clock. */
	now: () => number = () => Date.parse("2026-10-07T10:00:00Z");
	private next = 0;

	private stamp(): string {
		return new Date(this.now()).toISOString();
	}

	/** A write that changes the row: a new version and `updatedAt`. */
	private touch(e: StoredEntry): void {
		e.rev++;
		e.updatedAt = this.stamp();
	}

	/** The entry's `_rev`, as EmDash encodes it: `base64("<version>:<updatedAt>")` (M5b F1). */
	private encoded(e: StoredEntry): string {
		return encodeRev(e.rev, e.updatedAt);
	}

	/** The current `_rev` of an entry, for tests that write as an editor would. */
	revOf(id: string): string {
		const e = this.entries.get(id);
		if (!e) throw new Error(`No entry ${id}`);
		return this.encoded(e);
	}

	/** As EmDash: a slug is unique per collection and locale, and Trash still holds it. */
	private checkSlug(
		collection: string,
		locale: string,
		slug: string | null | undefined,
		id?: string,
	) {
		if (slug === undefined || slug === null) return;
		const taken = [...this.entries.values()].some(
			(o) => o.id !== id && o.collection === collection && o.locale === locale && o.slug === slug,
		);
		if (taken) {
			throw new ContentWriteError(
				"emdash_slug_conflict",
				`Writing the entry failed: Slug "${slug}" already exists in this collection`,
			);
		}
	}

	private hasDraft(e: StoredEntry): boolean {
		return e.live !== null || e.stale !== null;
	}

	private snap(e: StoredEntry, options: GetOptions = {}): EntrySnapshot {
		return {
			id: e.id,
			rev: this.encoded(e),
			// As hydrateDraftData: a pending draft changes the data, never the live slug.
			slug: e.live?.slug ?? e.slug,
			data: structuredClone(e.stale ? { ...e.data, ...e.stale.data } : e.data),
			group: e.group,
			pendingPublish: e.pendingPublish,
			status: e.status,
			scheduledAt: e.scheduledAt,
			hasDraft: this.hasDraft(e),
			...(e.live
				? { live: structuredClone(e.live.data) }
				: e.stale
					? { live: structuredClone(e.data) }
					: {}),
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
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
		return e && !e.trashed && e.collection === collection && e.locale === locale
			? this.snap(e, options)
			: null;
	}
	async getIncludingTrashed(collection: string, locale: string, id: string) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale
			? { ...this.snap(e), trashed: e.trashed }
			: null;
	}
	async trash(collection: string, id: string) {
		this.beforeStep("trash", id);
		const e = this.entries.get(id);
		// As EmDash: the beforeDelete hook runs before the entry is looked up.
		const blocked = this.blockDelete(id);
		if (blocked !== null)
			return { ok: false as const, reason: "blocked" as const, message: blocked };
		if (!e || e.trashed || e.collection !== collection) {
			return { ok: false as const, reason: "not_found" as const, message: "" };
		}
		// As EmDash: only deleted_at is set, so the revision stays (spec M5a F6).
		e.trashed = true;
		this.calls.push(`trash:${id}`);
		return { ok: true as const };
	}
	async permanentDelete(collection: string, id: string) {
		this.beforeStep("delete", id);
		const e = this.entries.get(id);
		if (!e?.trashed || e.collection !== collection) return false;
		this.entries.delete(id);
		this.calls.push(`delete:${id}`);
		return true;
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
		this.beforeStep(input.step, input.id);
		const e = this.entries.get(input.id);
		if (!e || e.trashed || e.collection !== input.collection || e.locale !== input.locale) {
			throw new ContentWriteError("emdash_not_found", "Entry not found");
		}
		if (this.locked.has(e.id)) return { ok: false, reason: "locked", message: "locked" };
		if (this.encoded(e) !== input.rev) {
			return { ok: false, reason: "conflict", message: "Revision precondition did not match" };
		}
		// Only publish, unpublish and schedule run policy hooks; a discard, an update and an
		// unschedule (no beforeUnschedule hook, spec M5b F3) cannot be refused.
		const unhooked = ["update", "discard", "unschedule"];
		const blocked = unhooked.includes(input.step) ? null : this.blockStep(input.step, e.id);
		if (blocked !== null) return { ok: false, reason: "blocked", message: blocked };
		switch (input.step) {
			case "update": {
				const written = await this.update(input);
				if (!written.ok) return { ok: false, reason: "conflict", message: written.reason };
				break;
			}
			case "publish": {
				const published = await this.publish({ id: e.id, rev: input.rev });
				if (!published.ok) return { ok: false, reason: "conflict", message: published.reason };
				break;
			}
			case "unpublish":
				if (e.status !== "draft" || e.scheduledAt !== null) {
					// As EmDash, also without revisions: a draft is created from the live revision, and
					// only when one exists (F18). Without revisions its stale values hide the columns.
					if (e.published !== null || e.status === "published") {
						const liveData = structuredClone(e.published?.data ?? e.data);
						if (this.plainCollections.has(e.collection)) e.stale ??= { data: liveData };
						else e.live ??= { data: liveData, slug: e.slug };
					}
					// As EmDash: an unpublish clears the live revision (repositories/content.ts:2763).
					e.published = null;
					e.status = "draft";
					e.scheduledAt = null;
					e.pendingPublish = true;
					this.touch(e);
				}
				break;
			case "discard":
				if (e.live || e.stale) {
					if (e.live) {
						e.data = e.live.data;
						e.slug = e.live.slug;
					}
					e.live = null;
					e.stale = null;
					e.pendingPublish = e.status !== "published";
					e.rev++;
				}
				break;
			case "schedule":
				this.setSchedule(e, input.scheduledAt ?? "", "Rolling back the entry (schedule)");
				break;
			case "unschedule":
				// As EmDash: a no-op without a schedule; else the status goes back to draft unless
				// published, and only `updated_at` moves (repositories/content.ts:2155-2198).
				if (e.scheduledAt !== null) {
					e.scheduledAt = null;
					if (e.status !== "published") e.status = "draft";
					e.updatedAt = this.stamp();
				}
				break;
		}
		if (input.step !== "update" && input.step !== "publish") {
			this.calls.push(`${input.step}:${e.id}`);
		}
		this.afterStep(input.step, e.id);
		return {
			ok: true,
			state: {
				rev: this.encoded(e),
				status: e.status,
				scheduledAt: e.scheduledAt,
				hasDraft: this.hasDraft(e),
			},
		};
	}
	async findBySourceId(collection: string, locale: string, sourceId: string, options?: GetOptions) {
		this.calls.push(`find:${sourceId}`);
		if (this.sourceIdFieldMissing) {
			throw new ContentWriteError(
				"emdash_validation_error",
				"Cannot filter by field flux_source_id: it is not a field of the collection",
			);
		}
		for (const e of this.entries.values()) {
			if (
				!e.trashed &&
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
			translationOf?: string;
		} & LinkWrites,
	) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const source =
			input.translationOf === undefined ? undefined : this.entries.get(input.translationOf);
		if (input.translationOf !== undefined) {
			if (!source || source.collection !== input.collection) {
				throw new ContentWriteError(
					"emdash_not_found",
					"Creating the entry failed: Translation source content not found",
				);
			}
			const taken = [...this.entries.values()].some(
				(e) =>
					!e.trashed &&
					e.group === source.group &&
					e.locale.toLowerCase() === input.locale.toLowerCase(),
			);
			if (taken) {
				throw new ContentWriteError(
					"emdash_conflict",
					`Creating the entry failed: Translation already exists in locale "${input.locale}" for this content item`,
				);
			}
		}
		this.checkSlug(input.collection, input.locale, input.slug);
		const id = `e${++this.next}`;
		const data = structuredClone(input.data);
		const created = this.stamp();
		for (const field of source ? this.sharedFields : []) {
			if (source && Object.hasOwn(source.data, field)) data[field] = source.data[field];
			else delete data[field];
		}
		const entry: StoredEntry = {
			id,
			collection: input.collection,
			locale: input.locale,
			slug: input.slug ?? null,
			data,
			group: source?.group ?? id,
			rev: 1,
			pendingPublish: true,
			// As EmDash: terms and references are the group's; credits are copied unless given.
			taxonomies: structuredClone(source?.taxonomies ?? {}),
			references: structuredClone(source?.references ?? {}),
			bylines: input.bylines === undefined ? structuredClone(source?.bylines ?? []) : [],
			status: "draft",
			scheduledAt: null,
			publishedAt: null,
			live: null,
			published: null,
			stale: null,
			trashed: false,
			createdAt: created,
			updatedAt: created,
		};
		this.writeLinks(entry, input);
		this.entries.set(id, entry);
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: this.encoded(entry) };
	}
	async update(
		input: {
			id: string;
			rev: string;
			slug?: string | null;
			data?: Record<string, unknown>;
		} & LinkWrites,
	): Promise<WriteResult> {
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data ?? {});
		if (failure) throw failure;
		this.checkSlug(e.collection, e.locale, input.slug, e.id);
		const staged = input.data !== undefined || input.slug !== undefined || input.references;
		const plain = this.plainCollections.has(e.collection);
		// On revisioned collections data, slug and references are staged in a draft (spec M5a F17).
		if (staged && !plain) e.live ??= { data: structuredClone(e.data), slug: e.slug };
		e.data = { ...e.data, ...structuredClone(input.data ?? {}) };
		if (input.slug !== undefined) e.slug = input.slug;
		this.writeLinks(e, input);
		// As EmDash: `updated_at` moves only when a column of the row changes
		// (repositories/content.ts:1072-1075). With revisions data, slug and references go to the
		// draft revision, which leaves it alone unless the slug is cleared (:1405-1432, and :2831-2846
		// for the runtime's draft staging); terms and bylines live in other tables. Publish,
		// unpublish and schedule set it (:2514, :2633, :2767, :2127); a discard keeps it (:2883).
		const columns = plain
			? input.data !== undefined || input.slug !== undefined
			: input.slug === null;
		e.rev++;
		if (columns) e.updatedAt = this.stamp();
		// As EmDash on revisioned collections: terms and bylines are live metadata (no draft).
		if (staged && !plain) e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: this.encoded(e) };
	}
	async publish(input: { id: string; rev: string }): Promise<WriteResult> {
		this.beforePublish(input.id);
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		const forced = this.failPublish(e.id);
		if (forced) return { ok: false, reason: forced };
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		this.makeLive(e);
		this.calls.push(`publish:${e.id}`);
		return { ok: true, rev: this.encoded(e) };
	}

	/**
	 * EmDash's publish (F4): status, draft and schedule cleared, a new version and `updated_at`.
	 * `published_at` is the requested time, else the current one, else now
	 * (repositories/content.ts:2608).
	 */
	private makeLive(e: StoredEntry, publishedAt?: string): void {
		e.publishedAt = publishedAt ?? e.publishedAt ?? this.stamp();
		e.pendingPublish = false;
		e.status = "published";
		e.scheduledAt = null;
		e.live = null;
		e.stale = null;
		// As EmDash without revisions: the live revision is created at the first publish after an
		// unpublish and then kept (repositories/content.ts:2489-2499); with revisions each publish
		// makes the draft the live revision.
		if (this.plainCollections.has(e.collection)) e.published ??= { data: structuredClone(e.data) };
		else e.published = { data: structuredClone(e.data) };
		this.touch(e);
	}

	/**
	 * EmDash's schedule (spec M5b F2): a time not after now is refused; a draft becomes
	 * `scheduled` and a published entry stays published; `version` is kept and only `updated_at`
	 * moves, so at a clock that has not moved the `_rev` stays the same, as in EmDash.
	 */
	private setSchedule(e: StoredEntry, value: string, op: string): void {
		const at = normalizeScheduledAt(value, op);
		if (!(Date.parse(at) > this.now())) {
			throw new ContentWriteError(
				"emdash_validation_error",
				`${op} failed: Scheduled date must be in the future`,
			);
		}
		e.scheduledAt = at;
		if (e.status !== "published") e.status = "scheduled";
		e.updatedAt = this.stamp();
	}

	async schedule(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		scheduledAt: string;
	}): Promise<WriteResult> {
		this.beforeSchedule(input.id);
		const e = this.entries.get(input.id);
		if (!e || e.trashed) throw new ContentWriteError("emdash_not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (this.encoded(e) !== input.rev) return { ok: false, reason: "conflict" };
		const blocked = this.blockStep("schedule", e.id);
		if (blocked !== null) {
			throw new ContentWriteError(
				"emdash_schedule_rejected",
				`Scheduling the entry failed: ${blocked}`,
			);
		}
		this.setSchedule(e, input.scheduledAt, "Scheduling the entry");
		this.calls.push(`schedule:${e.id}`);
		this.afterSchedule(e.id);
		return { ok: true, rev: this.encoded(e) };
	}

	/**
	 * An editor's term change through the admin terms route (spec M5b F8): only the entry's term
	 * assignments change, so its `_rev` stays as it was.
	 */
	setTerms(id: string, taxonomy: string, slugs: string[]): void {
		const e = this.entries.get(id);
		if (!e) throw new Error(`No entry ${id}`);
		e.taxonomies[taxonomy] = [...slugs];
	}

	/**
	 * One pass of EmDash's scheduler (`publishDueContent`, spec M5b F5): every active entry due by
	 * now is published without a revision check; a publish hook's refusal unschedules it instead.
	 * As EmDash, collection by collection in slug order (`listCollections`, schema/registry.ts:366,
	 * which puts its own collection order first; the fake has none), and within one by
	 * `scheduled_at`, then `id` (`findReadyToPublish`, repositories/content.ts:2212). A first
	 * publication gets the scheduled time as `published_at` (scheduled-publish.ts). Returns the
	 * IDs published, in that order.
	 */
	runScheduled(): string[] {
		const published: string[] = [];
		const now = this.now();
		const due = [...this.entries.values()]
			.filter((e) => !e.trashed && e.scheduledAt !== null && Date.parse(e.scheduledAt) <= now)
			.sort(
				(a, b) =>
					compareText(a.collection, b.collection) ||
					compareText(a.scheduledAt ?? "", b.scheduledAt ?? "") ||
					compareText(a.id, b.id),
			);
		for (const e of due) {
			const firstAt = e.publishedAt === null ? (e.scheduledAt ?? undefined) : undefined;
			if (this.blockStep("publish", e.id) !== null) {
				e.scheduledAt = null;
				if (e.status !== "published") e.status = "draft";
				e.updatedAt = this.stamp();
				continue;
			}
			this.makeLive(e, firstAt);
			this.calls.push(`scheduled:${e.id}`);
			published.push(e.id);
		}
		return published;
	}
	async ensureSourceIdField() {
		this.sourceFieldEnsured = true;
	}
	async translations(collection: string, id: string) {
		this.calls.push(`translations:${id}`);
		const e = this.entries.get(id);
		if (!e || e.trashed || e.collection !== collection) return [];
		return [...this.entries.values()]
			.filter((t) => !t.trashed && t.collection === collection && t.group === e.group)
			.map((t) => ({ id: t.id, locale: t.locale }));
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

	/**
	 * The groups of the term slugs the `FakeContent` entry was given, by taxonomy. Resolves the slugs
	 * in the entry's own locale, whereas EmDash reads the source's terms for a translation (V1/E2);
	 * tests must not rely on it for linked records.
	 */
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

type StoredMedia = MediaInfo & { status: string; hash: string };

/**
 * In-memory media library: identical bytes (by SHA-1, as EmDash) give the ready item already
 * stored, whose alt is left as it was. Images are 4 x 3 with a blurhash.
 */
export class FakeMedia implements MediaPort {
	readonly items = new Map<string, StoredMedia>();
	readonly calls: string[] = [];
	/** Return an error to make this upload fail. */
	failUpload: (input: { filename: string; contentType: string }) => MediaUploadError | null = () =>
		null;
	private next = 0;

	async get(id: string) {
		this.calls.push(`get:${id}`);
		return this.info(id);
	}

	private info(id: string): MediaInfo | null {
		const item = this.items.get(id);
		if (item?.status !== "ready") return null;
		const { status: _s, hash: _h, ...info } = item;
		return structuredClone(info);
	}

	async upload(input: { filename: string; contentType: string; bytes: Uint8Array; alt?: string }) {
		this.calls.push(`upload:${input.filename}`);
		const failure = this.failUpload(input);
		if (failure) throw failure;
		const hash = createHash("sha1").update(input.bytes).digest("hex");
		for (const item of this.items.values()) {
			if (item.hash === hash && item.status === "ready") {
				return { item: this.info(item.id) as MediaInfo, deduplicated: true };
			}
		}
		const n = ++this.next;
		const image = input.contentType.startsWith("image/");
		const dot = input.filename.lastIndexOf(".");
		const extension = dot > 0 ? input.filename.slice(dot) : "";
		this.items.set(`m${n}`, {
			id: `m${n}`,
			filename: input.filename,
			mimeType: input.contentType,
			size: input.bytes.byteLength,
			width: image ? 4 : null,
			height: image ? 3 : null,
			alt: input.alt ?? null,
			storageKey: `K${n}${extension}`,
			blurhash: image ? `bh${n}` : null,
			dominantColor: image ? "rgb(1,2,3)" : null,
			status: "ready",
			hash,
		});
		return { item: this.info(`m${n}`) as MediaInfo, deduplicated: false };
	}
}

/** What the fake server answers for a URL. */
export type FakeFile = {
	body: string | Uint8Array;
	contentType?: string | null;
	etag?: string;
	/** How long the download takes on the test clock. */
	ms?: number;
	/** Fail the download with this error instead. */
	error?: MediaError;
	/** The URL that answered, after redirects. */
	finalUrl?: string;
};

/**
 * `MediaFetcher` over a map of URLs. A URL not in it answers 404; a matching `etag` answers
 * 304; `ms` advances the test clock. Hosts in `blocked` fail the host check.
 */
export class FakeMediaFetcher implements MediaFetcher {
	readonly files = new Map<string, FakeFile>();
	readonly blocked = new Set<string>();
	readonly calls: { url: string; options: MediaFetchOptions }[] = [];

	constructor(private readonly clock: { t: number }) {}

	checkHost(url: string) {
		const host = new URL(url).hostname;
		if (this.blocked.has(host))
			throw new MediaError("media_blocked", `The host ${host} is not allowed`);
	}

	async fetch(url: string, options: MediaFetchOptions): Promise<MediaFetchResult> {
		this.calls.push({ url, options });
		this.checkHost(url);
		const file = this.files.get(url);
		if (!file) throw new MediaError("media_http_error", "The server answered HTTP 404");
		this.clock.t += file.ms ?? 0;
		if (file.error) throw file.error;
		if (options.etag !== undefined && options.etag === file.etag) return { status: 304 };
		const bytes = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
		if (bytes.byteLength > options.maxBytes) {
			throw new MediaError(
				"media_too_large",
				`The file is larger than the limit of ${options.maxBytes} bytes`,
			);
		}
		return {
			status: 200,
			bytes,
			contentType: file.contentType === undefined ? "application/octet-stream" : file.contentType,
			finalUrl: file.finalUrl ?? url,
			...(file.etag === undefined ? {} : { etag: file.etag }),
		};
	}

	/** The URLs downloaded, in order. */
	urls(): string[] {
		return this.calls.map((c) => c.url);
	}
}

export function makeDeps(opts: { clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: Date.parse("2026-10-07T10:00:00Z") };
	let id = 0;
	const content = new FakeContent();
	content.now = () => clock.t;
	const lookups = new FakeLookups(content);
	content.bylineSlug = (id) => lookups.storedBylines.find((b) => b.id === id)?.slug ?? id;
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		mediaMap: new MemoryKv<MediaMapRow>(),
		journal: new MemoryKv<JournalEntry>(),
		journalMedia: new MemoryKv<JournalMedia>(),
		content,
		lookups,
		media: new FakeMedia(),
		mediaFetcher: new FakeMediaFetcher(clock),
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
