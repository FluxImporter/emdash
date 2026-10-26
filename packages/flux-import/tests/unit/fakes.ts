import type { UploadStorage } from "../../src/emdash/uploads.js";
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
	/** Called at the start of publish; throw from it to simulate a crash before publishing. */
	beforePublish: (id: string) => void = () => {};
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
