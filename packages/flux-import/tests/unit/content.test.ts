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
