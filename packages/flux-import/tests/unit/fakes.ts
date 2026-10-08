import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type KvCollection,
	SourceMissingError,
	type SourcePort,
	type Where,
	type WriteResult,
} from "../../src/engine/ports.js";
import type { EngineDeps, Job, LinkRow, RecordRow } from "../../src/engine/types.js";
import { dropBytes } from "../../src/sources/csv.js";
import { streamOf } from "./helpers.js";

function matches(data: Record<string, unknown>, where: Where): boolean {
	return Object.entries(where).every(([k, cond]) => {
		const v = data[k];
		if (cond !== null && typeof cond === "object") {
			const c = cond as Record<string, unknown>;
			if ("in" in c) return (c.in as unknown[]).includes(v);
			if ("gte" in c && !((v as number) >= (c.gte as number))) return false;
			if ("gt" in c && !((v as number) > (c.gt as number))) return false;
			if ("lte" in c && !((v as number) <= (c.lte as number))) return false;
			if ("lt" in c && !((v as number) < (c.lt as number))) return false;
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
				const av = (a.data as Record<string, number>)[field] as number;
				const bv = (b.data as Record<string, number>)[field] as number;
				return dir === "asc" ? av - bv : bv - av;
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
	/** Return a reason to make publishing this entry fail. */
	failPublish: (id: string) => "conflict" | "locked" | null = () => null;
	private next = 0;

	private snap(e: StoredEntry): EntrySnapshot {
		return {
			id: e.id,
			rev: String(e.rev),
			slug: e.slug,
			data: structuredClone(e.data),
			pendingPublish: e.pendingPublish,
		};
	}
	async get(collection: string, locale: string, id: string) {
		const e = this.entries.get(id);
		return e && e.collection === collection && e.locale === locale ? this.snap(e) : null;
	}
	async findBySourceId(collection: string, locale: string, sourceId: string) {
		this.calls.push(`find:${sourceId}`);
		for (const e of this.entries.values()) {
			if (
				e.collection === collection &&
				e.locale === locale &&
				e.data.flux_source_id === sourceId
			) {
				return this.snap(e);
			}
		}
		return null;
	}
	async isLocked(_c: string, _l: string, id: string) {
		return this.locked.has(id);
	}
	async create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, unknown>;
	}) {
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		const id = `e${++this.next}`;
		this.entries.set(id, {
			id,
			collection: input.collection,
			locale: input.locale,
			slug: input.slug ?? null,
			data: structuredClone(input.data),
			rev: 1,
			pendingPublish: true,
		});
		this.calls.push(`create:${id}`);
		this.afterWrite(id);
		return { id, rev: "1" };
	}
	async update(input: {
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, unknown>;
	}): Promise<WriteResult> {
		const e = this.entries.get(input.id);
		if (!e) throw new ContentWriteError("not_found", "Entry not found");
		if (this.locked.has(e.id)) return { ok: false, reason: "locked" };
		if (String(e.rev) !== input.rev) return { ok: false, reason: "conflict" };
		const failure = this.failWrite(input.data);
		if (failure) throw failure;
		e.data = { ...e.data, ...structuredClone(input.data) };
		if (input.slug !== undefined) e.slug = input.slug;
		e.rev++;
		e.pendingPublish = true;
		this.calls.push(`update:${e.id}`);
		this.afterWrite(e.id);
		return { ok: true, rev: String(e.rev) };
	}
	async publish(input: { id: string; rev: string }): Promise<WriteResult> {
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
	const deps = {
		jobs: new MemoryKv<Job>(),
		records: new MemoryKv<RecordRow>(),
		links: new MemoryKv<LinkRow>(),
		content: new FakeContent(),
		source: new FakeSource(),
		now: () => clock.t,
		newId: () => `id${++id}`,
	} satisfies EngineDeps;
	return { deps, clock };
}
