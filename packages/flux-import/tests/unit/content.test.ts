import { describe, expect, it } from "vitest";
import {
	type ContentRuntime,
	EmDashContent,
	type HandlerResult,
} from "../../src/emdash/content.js";
import type { SchemaRegistryLike } from "../../src/emdash/schema.js";
import { ContentWriteError } from "../../src/engine/ports.js";

type Item = {
	id: string;
	slug: string | null;
	status: string;
	locale: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	version: number;
	scheduledAt?: string | null;
	deletedAt?: string | null;
	liveData?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
};

const ok = (data: unknown): HandlerResult => ({ success: true, data });
const fail = (code: string, message = code): HandlerResult => ({
	success: false,
	error: { code, message },
});

/** Mimics the runtime handlers' envelopes and `_rev` checks (verification report, question 1). */
class FakeRuntime implements ContentRuntime {
	readonly items = new Map<string, Item>();
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	/** What handleContentTranslations answers. */
	translationsResult: HandlerResult = fail("NOT_FOUND", "Content item not found");
	/** When set, what the next rollback handler (delete, unpublish, schedule, discard) answers. */
	stepOverride: HandlerResult | null = null;
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;

	private envelope(item: Item) {
		return ok({ item: { ...item, authorId: null }, _rev: `rev-${item.version}` });
	}
	async handleContentGet(_c: string, id: string) {
		const item = this.items.get(id);
		return item ? this.envelope(item) : fail("NOT_FOUND");
	}
	async handleContentList(collection: string, params: Record<string, unknown>) {
		this.calls.push(["list", collection, params]);
		if (this.listOverride) return this.listOverride;
		const filters = params.fieldFilters as Record<string, unknown>;
		const items = [...this.items.values()].filter(
			(i) => i.locale === params.locale && i.data.flux_source_id === filters.flux_source_id,
		);
		return ok({ items: items.slice(0, params.limit as number) });
	}
	async handleContentCreate(collection: string, body: Record<string, unknown>) {
		this.calls.push(["create", collection, body]);
		const id = `e${++this.next}`;
		const item: Item = {
			id,
			slug: (body.slug as string | undefined) ?? null,
			status: "draft",
			locale: body.locale as string,
			data: body.data as Record<string, unknown>,
			draftRevisionId: null,
			version: 1,
		};
		this.items.set(id, item);
		return this.envelope(item);
	}
	async handleContentUpdate(collection: string, id: string, body: Record<string, unknown>) {
		this.calls.push(["update", collection, id, body]);
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (body._rev !== `rev-${item.version}`) return fail("CONFLICT", "version conflict");
		item.data = { ...item.data, ...(body.data as Record<string, unknown>) };
		item.draftRevisionId = `d${item.version}`;
		item.version++;
		return this.envelope(item);
	}
	async handleContentPublish(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["publish", collection, id, options]);
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (options._rev !== `rev-${item.version}`)
			return fail("CONFLICT", "Revision precondition did not match");
		item.status = "published";
		item.draftRevisionId = null;
		item.version++;
		return this.envelope(item);
	}
	async handleContentTranslations(collection: string, id: string) {
		this.calls.push(["translations", collection, id]);
		return this.translationsResult;
	}
	private override(): HandlerResult | null {
		const result = this.stepOverride;
		this.stepOverride = null;
		return result;
	}
	async handleContentGetIncludingTrashed(collection: string, id: string, locale?: string) {
		this.calls.push(["getTrashed", collection, id, locale]);
		const item = this.items.get(id);
		return item ? this.envelope(item) : fail("NOT_FOUND");
	}
	async handleContentDelete(collection: string, id: string) {
		this.calls.push(["delete", collection, id]);
		const forced = this.override();
		if (forced) return forced;
		const item = this.items.get(id);
		if (!item || item.deletedAt) return fail("NOT_FOUND");
		item.deletedAt = "2026-11-03T10:00:00.000Z";
		return ok({ deleted: true, id });
	}
	async handleContentPermanentDelete(collection: string, id: string) {
		this.calls.push(["permanentDelete", collection, id]);
		const item = this.items.get(id);
		if (!item?.deletedAt) return fail("NOT_FOUND");
		this.items.delete(id);
		return ok({ deleted: true, id });
	}
	private step(id: string, options: Record<string, unknown>, change: (item: Item) => void) {
		const forced = this.override();
		if (forced) return forced;
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (options._rev !== `rev-${item.version}`) return fail("CONFLICT", "stale");
		change(item);
		item.version++;
		return this.envelope(item);
	}
	async handleContentUnpublish(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["unpublish", collection, id, options]);
		return this.step(id, options, (item) => {
			item.status = "draft";
			item.draftRevisionId = "from-live";
		});
	}
	async handleContentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["schedule", collection, id, scheduledAt, options]);
		return this.step(id, options, (item) => {
			item.scheduledAt = scheduledAt;
			if (item.status !== "published") item.status = "scheduled";
		});
	}
	async handleContentDiscardDraft(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["discard", collection, id, options]);
		return this.step(id, options, (item) => {
			item.draftRevisionId = null;
		});
	}
}

const actor = { id: "u1", role: 50 };

function setup(locked: (c: string, id: string, user: string) => boolean = () => false) {
	const runtime = new FakeRuntime();
	const lockCalls: string[] = [];
	const content = new EmDashContent(runtime, actor, async (c, id, user) => {
		lockCalls.push(`${c}/${id}/${user}`);
		return locked(c, id, user);
	});
	return { runtime, content, lockCalls };
}

describe("EmDashContent", () => {
	it("creates, updates and publishes with the returned revisions and the actor", async () => {
		const { runtime, content } = setup();
		const created = await content.create({
			collection: "products",
			locale: "en",
			slug: "a",
			data: { title: "A", flux_source_id: "S1" },
		});
		expect(created).toEqual({ id: "e1", rev: "rev-1" });
		expect(runtime.calls[0]).toEqual([
			"create",
			"products",
			{
				data: { title: "A", flux_source_id: "S1" },
				locale: "en",
				authorId: "u1",
				actor,
				slug: "a",
			},
		]);
		expect(await content.get("products", "en", "e1")).toMatchObject({ pendingPublish: true });

		const published = await content.publish({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-1",
		});
		expect(published).toEqual({ ok: true, rev: "rev-2" });
		expect(await content.get("products", "en", "e1")).toMatchObject({
			rev: "rev-2",
			pendingPublish: false,
		});

		const updated = await content.update({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-2",
			data: { title: "B" },
		});
		expect(updated).toEqual({ ok: true, rev: "rev-3" });
		expect(runtime.calls[2]).toEqual([
			"update",
			"products",
			"e1",
			{ data: { title: "B" }, locale: "en", _rev: "rev-2", actor },
		]);
		expect(await content.get("products", "en", "e1")).toMatchObject({
			data: { title: "B" },
			pendingPublish: true,
		});
	});

	it("sets the importing user as author on create and never sends authorId on update", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		await content.update({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-1",
			data: { title: "B" },
		});
		const [, , createBody] = runtime.calls[0] as [string, string, Record<string, unknown>];
		const [, , , updateBody] = runtime.calls[1] as [
			string,
			string,
			string,
			Record<string, unknown>,
		];
		expect(createBody.authorId).toBe("u1");
		expect(updateBody).not.toHaveProperty("authorId");
	});

	it("maps CONFLICT to a conflict result on update and publish", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(
			await content.update({
				collection: "products",
				locale: "en",
				id: "e1",
				rev: "stale",
				data: {},
			}),
		).toEqual({ ok: false, reason: "conflict" });
		expect(
			await content.publish({ collection: "products", locale: "en", id: "e1", rev: "stale" }),
		).toEqual({
			ok: false,
			reason: "conflict",
		});
	});

	it("refuses to publish an entry someone else has locked", async () => {
		const { runtime, content, lockCalls } = setup(() => true);
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(
			await content.publish({ collection: "products", locale: "en", id: "e1", rev: "rev-1" }),
		).toEqual({
			ok: false,
			reason: "locked",
		});
		expect(lockCalls).toEqual(["products/e1/u1"]);
		expect(runtime.calls.some((c) => (c as string[])[0] === "publish")).toBe(false);
		expect(await content.isLocked("products", "en", "e1")).toBe(true);
	});

	it("turns other EmDash errors into ContentWriteError with an emdash_ code", async () => {
		const { content } = setup();
		const error = await content
			.update({ collection: "products", locale: "en", id: "missing", rev: "r", data: {} })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "emdash_not_found" });
	});

	it("returns null for a missing entry or an entry in another locale", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "fr", data: { title: "A" } });
		expect(await content.get("products", "en", "nope")).toBeNull();
		expect(await content.get("products", "en", "e1")).toBeNull();
		expect(await content.get("products", "fr", "e1")).toMatchObject({ id: "e1" });
	});

	it("matches the entry's locale case-insensitively", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "pt-BR", data: { title: "A" } });
		expect(await content.get("products", "pt-br", "e1")).toMatchObject({ id: "e1" });
		expect(await content.get("products", "PT-BR", "e1")).toMatchObject({ id: "e1" });
		expect(await content.get("products", "pt", "e1")).toBeNull();
	});

	it("maps a deleted collection to collection_missing", async () => {
		const { runtime, content } = setup();
		runtime.handleContentCreate = async () =>
			fail("COLLECTION_NOT_FOUND", "Collection 'products' not found");
		await expect(
			content.create({ collection: "products", locale: "en", data: { title: "A" } }),
		).rejects.toMatchObject({ code: "collection_missing" });
	});

	it("finds by source ID with the locale and an indexed field filter", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		expect(await content.findBySourceId("products", "en", "S1")).toMatchObject({ id: "e1" });
		expect(await content.findBySourceId("products", "en", "S2")).toBeNull();
		expect(runtime.calls).toContainEqual([
			"list",
			"products",
			{ locale: "en", limit: 2, fieldFilters: { flux_source_id: "S1" } },
		]);
	});

	it("never picks one of several entries with the same source ID", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		await expect(content.findBySourceId("products", "en", "S1")).rejects.toMatchObject({
			code: "ambiguous_source_id",
		});
	});

	it("reports a list error, such as an unindexed field, as a ContentWriteError", async () => {
		const { runtime, content } = setup();
		runtime.listOverride = fail("VALIDATION_ERROR", 'Cannot filter by field "flux_source_id"');
		await expect(content.findBySourceId("products", "en", "S1")).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
	});

	it("rejects a response without an item or revision", async () => {
		const { runtime, content } = setup();
		runtime.handleContentGet = async () => ok({ item: { id: "e1" } });
		await expect(content.get("products", "en", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});

describe("EmDashContent links", () => {
	const credit = (id: string, slug: string, source: string, roleLabel: string | null = null) => ({
		byline: { id, slug, displayName: slug, translationGroup: `g-${id}` },
		sortOrder: 0,
		roleLabel,
		source,
	});

	it("reads reference selections with drafts only when asked, and explicit bylines always", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "posts", locale: "en", data: { title: "A" } });
		const gets: unknown[][] = [];
		const base = runtime.handleContentGet.bind(runtime);
		runtime.handleContentGet = async (c: string, id: string, ...rest: unknown[]) => {
			gets.push([c, id, ...rest]);
			const result = await base(c, id);
			const item = (result.data as { item: Record<string, unknown> }).item;
			item.bylines = [credit("b1", "alex", "explicit", "Editor"), credit("b2", "sam", "explicit")];
			if (rest[1]) {
				item.references = {
					related: {
						children: [
							{ id: "p2", slug: "two", translationGroup: "g2" },
							{ id: "p3", slug: "three", translationGroup: null },
						],
						nextCursor: "c",
					},
				};
			}
			return result;
		};
		const plain = await content.get("posts", "en", "e1");
		expect(plain).not.toHaveProperty("references");
		expect(plain?.bylines).toEqual([
			{ group: "g-b1", id: "b1", slug: "alex", roleLabel: "Editor" },
			{ group: "g-b2", id: "b2", slug: "sam", roleLabel: null },
		]);
		const linked = await content.get("posts", "en", "e1", { references: true });
		expect(linked?.references).toEqual({
			related: [
				{ group: "g2", id: "p2" },
				{ group: "p3", id: "p3" },
			],
		});
		expect(gets).toEqual([
			["posts", "e1", "en"],
			["posts", "e1", "en", { includeDrafts: true }],
		]);
		await content.create({ collection: "posts", locale: "en", data: { flux_source_id: "S1" } });
		const found = await content.findBySourceId("posts", "en", "S1", { references: true });
		expect(found?.references).toEqual(linked?.references);
	});

	it("marks reference fields with more selections than the page read", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "posts", locale: "en", data: { title: "A" } });
		const base = runtime.handleContentGet.bind(runtime);
		runtime.handleContentGet = async (c: string, id: string) => {
			const result = await base(c, id);
			(result.data as { item: Record<string, unknown> }).item.references = {
				related: { children: [{ id: "p2" }], nextCursor: "c" },
				other: { children: [{ id: "p3" }] },
			};
			return result;
		};
		const got = await content.get("posts", "en", "e1", { references: true });
		expect(got?.referencesTruncated).toEqual(["related"]);
	});

	it("leaves out an inferred byline, which the entry was not given", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "posts", locale: "en", data: { title: "A" } });
		const base = runtime.handleContentGet.bind(runtime);
		runtime.handleContentGet = async (c: string, id: string) => {
			const result = await base(c, id);
			(result.data as { item: Record<string, unknown> }).item.bylines = [
				credit("b9", "owner", "inferred"),
			];
			return result;
		};
		expect((await content.get("posts", "en", "e1"))?.bylines).toEqual([]);
	});

	it("sends links on create and update, and leaves data out of an update without it", async () => {
		const { runtime, content } = setup();
		await content.create({
			collection: "posts",
			locale: "en",
			data: { title: "A" },
			taxonomies: { category: ["news"] },
			references: { related: ["p2"] },
			bylines: [{ bylineId: "b1", roleLabel: null }],
		});
		expect(runtime.calls[0]).toEqual([
			"create",
			"posts",
			{
				data: { title: "A" },
				locale: "en",
				authorId: "u1",
				actor,
				taxonomies: { category: ["news"] },
				references: { related: ["p2"] },
				bylines: [{ bylineId: "b1", roleLabel: null }],
			},
		]);
		await content.update({
			collection: "posts",
			locale: "en",
			id: "e1",
			rev: "rev-1",
			taxonomies: { category: [] },
		});
		expect(runtime.calls[1]).toEqual([
			"update",
			"posts",
			"e1",
			{ locale: "en", _rev: "rev-1", actor, taxonomies: { category: [] } },
		]);
	});
});

describe("EmDashContent translations (M4e)", () => {
	it("sends translationOf on create", async () => {
		const { runtime, content } = setup();
		await content.create({
			collection: "products",
			locale: "fr",
			data: { title: "Bureau", flux_source_id: "E1" },
			translationOf: "e0",
			bylines: [],
		});
		expect(runtime.calls[0]).toEqual([
			"create",
			"products",
			{
				data: { title: "Bureau", flux_source_id: "E1" },
				locale: "fr",
				authorId: "u1",
				actor,
				translationOf: "e0",
				bylines: [],
			},
		]);
	});

	it("lists the group's entries and locales, and nothing for a missing entry", async () => {
		const { runtime, content } = setup();
		expect(await content.translations("products", "nope")).toEqual([]);
		runtime.translationsResult = ok({
			translationGroup: "e1",
			translations: [
				{ id: "e1", locale: "en", slug: "desk", status: "published", updatedAt: "t" },
				{ id: "e2", locale: "fr", slug: "bureau", status: "draft", updatedAt: "t" },
				{ id: "e3", locale: null, slug: null, status: "draft", updatedAt: "t" },
			],
		});
		expect(await content.translations("products", "e2")).toEqual([
			{ id: "e1", locale: "en" },
			{ id: "e2", locale: "fr" },
		]);
		expect(runtime.calls.at(-1)).toEqual(["translations", "products", "e2"]);
	});

	it("reports other translation read errors and bad responses as ContentWriteError (M4e)", async () => {
		const { runtime, content } = setup();
		runtime.translationsResult = fail("INTERNAL_ERROR", "boom");
		const failed = await content.translations("products", "e1").catch((e: unknown) => e);
		expect(failed).toBeInstanceOf(ContentWriteError);
		expect(failed).toMatchObject({
			code: "emdash_internal_error",
			message: "Reading the translations failed: boom",
		});
		runtime.translationsResult = ok({ translations: [{ locale: "en" }] });
		await expect(content.translations("products", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});

describe("EmDashContent for rollbacks (M5a)", () => {
	it("reads status, schedule, draft, live data and timestamps into the snapshot", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const item = runtime.items.get("e1") as Item;
		Object.assign(item, {
			status: "published",
			draftRevisionId: "d1",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			liveData: { title: "Live" },
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-02T00:00:00.000Z",
		});
		expect(await content.get("products", "en", "e1")).toMatchObject({
			status: "published",
			scheduledAt: "2026-12-01T00:00:00.000Z",
			hasDraft: true,
			pendingPublish: true,
			live: { title: "Live" },
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-02T00:00:00.000Z",
		});
		item.draftRevisionId = null;
		const plain = await content.get("products", "en", "e1");
		expect(plain).toMatchObject({ hasDraft: false, pendingPublish: false });
		expect(plain).not.toHaveProperty("live");
		expect(plain).not.toHaveProperty("trashed");
	});

	it("reads a trashed entry, moves entries to Trash and deletes trashed ones", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(await content.trash("products", "e1")).toEqual({ ok: true });
		expect(await content.getIncludingTrashed("products", "en", "e1")).toMatchObject({
			id: "e1",
			rev: "rev-1",
			trashed: true,
		});
		expect(await content.getIncludingTrashed("products", "fr", "e1")).toBeNull();
		expect(await content.getIncludingTrashed("products", "en", "nope")).toBeNull();
		expect(await content.trash("products", "e1")).toEqual({
			ok: false,
			reason: "not_found",
			message: "NOT_FOUND",
		});
		runtime.stepOverride = fail("DELETE_BLOCKED", "Delete blocked by plugin hook");
		expect(await content.trash("products", "e1")).toEqual({
			ok: false,
			reason: "blocked",
			message: "Delete blocked by plugin hook",
		});
		expect(await content.permanentDelete("products", "e1")).toBe(true);
		expect(await content.permanentDelete("products", "e1")).toBe(false);
		runtime.stepOverride = fail("CONTENT_DELETE_ERROR", "boom");
		await expect(content.trash("products", "e2")).rejects.toMatchObject({
			code: "emdash_content_delete_error",
		});
	});

	it("runs each revert step with the revision and reports the entry's state", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const base = { collection: "products", locale: "en", id: "e1" };
		const updated = await content.revertStep({
			...base,
			rev: "rev-1",
			step: "update",
			data: { title: "B" },
			slug: "b",
			taxonomies: { tag: ["new"] },
		});
		expect(updated).toEqual({
			ok: true,
			state: { rev: "rev-2", status: "draft", scheduledAt: null, hasDraft: true },
		});
		expect(runtime.calls.at(-1)).toEqual([
			"update",
			"products",
			"e1",
			{
				data: { title: "B" },
				locale: "en",
				_rev: "rev-1",
				actor,
				slug: "b",
				taxonomies: { tag: ["new"] },
			},
		]);
		const published = await content.revertStep({ ...base, rev: "rev-2", step: "publish" });
		expect(published).toMatchObject({ ok: true, state: { status: "published", hasDraft: false } });
		expect(runtime.calls.at(-1)).toEqual(["publish", "products", "e1", { _rev: "rev-2", actor }]);
		const unpublished = await content.revertStep({ ...base, rev: "rev-3", step: "unpublish" });
		expect(unpublished).toMatchObject({ ok: true, state: { status: "draft", hasDraft: true } });
		const discarded = await content.revertStep({ ...base, rev: "rev-4", step: "discard" });
		expect(discarded).toMatchObject({ ok: true, state: { rev: "rev-5", hasDraft: false } });
		expect(runtime.calls.at(-1)).toEqual(["discard", "products", "e1", { _rev: "rev-4" }]);
		const at = "2026-12-01T00:00:00.000Z";
		const scheduled = await content.revertStep({
			...base,
			rev: "rev-5",
			step: "schedule",
			scheduledAt: at,
		});
		expect(scheduled).toMatchObject({
			ok: true,
			state: { status: "scheduled", scheduledAt: at },
		});
		expect(runtime.calls.at(-1)).toEqual([
			"schedule",
			"products",
			"e1",
			at,
			{ _rev: "rev-5", actor },
		]);
	});

	it("checks the lock before every step and writes a null slug through", async () => {
		const locked = new Set<string>();
		const { runtime, content, lockCalls } = setup((_c, id) => locked.has(id));
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const base = { collection: "products", locale: "en", id: "e1" };
		const steps = ["update", "publish", "unpublish", "discard", "schedule"] as const;
		locked.add("e1");
		const before = runtime.calls.length;
		for (const step of steps) {
			expect(await content.revertStep({ ...base, rev: "rev-1", step })).toEqual({
				ok: false,
				reason: "locked",
				message: "The entry is being edited",
			});
		}
		expect(lockCalls).toHaveLength(steps.length);
		expect(runtime.calls).toHaveLength(before);
		locked.clear();
		await content.revertStep({ ...base, rev: "rev-1", step: "update", slug: null });
		expect(runtime.calls.at(-1)).toMatchObject(["update", "products", "e1", { slug: null }]);
	});

	it("maps a stale revision to conflict and hook refusals to blocked", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		const base = { collection: "products", locale: "en", id: "e1" };
		expect(await content.revertStep({ ...base, rev: "stale", step: "update", data: {} })).toEqual({
			ok: false,
			reason: "conflict",
			message: "version conflict",
		});
		for (const code of ["PUBLISH_REJECTED", "UNPUBLISH_REJECTED", "SCHEDULE_REJECTED"]) {
			runtime.stepOverride = fail(code, "Not on Fridays");
			expect(await content.revertStep({ ...base, rev: "rev-1", step: "unpublish" })).toEqual({
				ok: false,
				reason: "blocked",
				message: "Not on Fridays",
			});
		}
		runtime.stepOverride = fail("VALIDATION_ERROR", "Scheduled date must be in the future");
		await expect(
			content.revertStep({ ...base, rev: "rev-1", step: "schedule", scheduledAt: "x" }),
		).rejects.toMatchObject({ code: "emdash_validation_error" });
	});
});
