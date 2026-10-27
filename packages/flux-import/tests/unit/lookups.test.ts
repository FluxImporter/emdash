import type { BylineAccess, TaxonomyAccessWithWrite, TaxonomyTermInfo } from "emdash";
import { describe, expect, it } from "vitest";
import type { HandlerResult } from "../../src/emdash/content.js";
import { EmDashLookups, type EntryReader } from "../../src/emdash/lookups.js";
import { ContentWriteError } from "../../src/engine/ports.js";

const term = (over: Partial<TaxonomyTermInfo>): TaxonomyTermInfo => ({
	id: "t1",
	taxonomy: "category",
	slug: "news",
	label: "News",
	parentId: null,
	data: null,
	locale: "en",
	translationGroup: "g1",
	...over,
});

function taxonomies(calls: unknown[][]): TaxonomyAccessWithWrite {
	return {
		getAll: async () => [
			{
				name: "category",
				label: "Categories",
				labelSingular: null,
				hierarchical: true,
				collections: ["posts"],
				locale: "en",
			},
		],
		getTerms: async (taxonomy, options) => {
			calls.push(["getTerms", taxonomy, options]);
			return [term({}), term({ id: "t2", slug: "tech", parentId: "g1", translationGroup: null })];
		},
		getEntryTerms: async (collection, entryId, options) => {
			calls.push(["getEntryTerms", collection, entryId, options]);
			return [
				term({}),
				term({ id: "t1-fr", locale: "fr", slug: "actualites" }),
				term({ id: "t9", taxonomy: "tag", slug: "x", translationGroup: "g9" }),
			];
		},
		createTerm: async (taxonomy, input) => {
			calls.push(["createTerm", taxonomy, input]);
			if (input.slug === "taken") {
				throw Object.assign(new Error("Term 'taken' already exists"), { code: "CONFLICT" });
			}
			return term({ id: "t3", slug: input.slug ?? "phones", label: input.label, parentId: "g1" });
		},
		addEntryTerms: async () => [],
		removeEntryTerms: async () => [],
	};
}

function bylines(calls: unknown[][]): BylineAccess {
	return {
		get: async () => null,
		getEntriesBylines: async () => [],
		list: async (options) => {
			calls.push(["list", options]);
			const byline = {
				id: "b1",
				slug: "alex",
				displayName: "Alex",
				bio: null,
				websiteUrl: null,
				avatarMediaId: null,
				locale: "en",
				translationGroup: "bg1",
			};
			return options?.cursor
				? { items: [byline], hasMore: false }
				: { items: [byline], hasMore: true, cursor: "c2" };
		},
	};
}

class Reader implements EntryReader {
	readonly calls: unknown[][] = [];
	constructor(private readonly answer: (id: string, locale?: string) => HandlerResult) {}
	async handleContentGet(collection: string, id: string, locale?: string) {
		this.calls.push([collection, id, locale]);
		return this.answer(id, locale);
	}
}

const found = (id: string, slug: string, translationGroup?: string): HandlerResult => ({
	success: true,
	data: { item: { id, slug, translationGroup }, _rev: "r" },
});

describe("EmDashLookups", () => {
	it("maps taxonomy definitions and terms, with the translation group as the group", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			bylines(calls),
			new Reader(() => found("x", "x")),
		);
		expect(await lookups.taxonomyDefs()).toEqual([
			{ name: "category", hierarchical: true, collections: ["posts"], locale: "en" },
		]);
		expect(await lookups.terms("category", "en")).toEqual([
			{ id: "t1", slug: "news", label: "News", parentId: null, group: "g1" },
			{ id: "t2", slug: "tech", label: "News", parentId: "g1", group: "t2" },
		]);
		expect(calls).toEqual([["getTerms", "category", { locale: "en" }]]);
	});

	it("creates terms through createTerm and passes EmDash's errors on", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			undefined,
			new Reader(() => found("x", "x")),
		);
		const input = { label: "Phones", parentId: "t1", locale: "en" };
		expect(await lookups.createTerm("category", input)).toEqual({
			id: "t3",
			slug: "phones",
			label: "Phones",
			parentId: "g1",
			group: "g1",
		});
		expect(calls).toEqual([["createTerm", "category", input]]);
		await expect(
			lookups.createTerm("category", { label: "T", slug: "taken", locale: "en" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("groups an entry's terms by taxonomy, once per translation group, across locales", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(
			taxonomies(calls),
			undefined,
			new Reader(() => found("x", "x")),
		);
		expect(await lookups.entryTerms("posts", "e1")).toEqual({ category: ["g1"], tag: ["g9"] });
		expect(calls).toEqual([["getEntryTerms", "posts", "e1", undefined]]);
	});

	it("pages bylines 100 at a time in the locale", async () => {
		const calls: unknown[][] = [];
		const lookups = new EmDashLookups(undefined, bylines(calls), new Reader(() => found("x", "x")));
		const first = await lookups.bylines("en");
		expect(first).toEqual({
			items: [{ id: "b1", slug: "alex", displayName: "Alex", group: "bg1" }],
			cursor: "c2",
		});
		expect(await lookups.bylines("en", "c2")).not.toHaveProperty("cursor");
		expect(calls).toEqual([
			["list", { locale: "en", limit: 100 }],
			["list", { locale: "en", limit: 100, cursor: "c2" }],
		]);
	});

	it("finds an entry by exact ID in any locale, and by exact slug in the locale", async () => {
		const reader = new Reader((id) =>
			id === "missing"
				? { success: false, error: { code: "NOT_FOUND", message: "nope" } }
				: id === "01A" || id === "desk"
					? found("01A", "desk", "G1")
					: found("01B", "01A-slug"),
		);
		const lookups = new EmDashLookups(undefined, undefined, reader);
		expect(await lookups.findEntry("products", "id", "01A", "en")).toEqual({
			id: "01A",
			group: "G1",
		});
		// The handler also answers slugs: a slug asked as an ID is not found, and the reverse.
		expect(await lookups.findEntry("products", "id", "desk", "en")).toBeNull();
		expect(await lookups.findEntry("products", "slug", "desk", "en")).toEqual({
			id: "01A",
			group: "G1",
		});
		expect(await lookups.findEntry("products", "slug", "01A", "en")).toBeNull();
		expect(await lookups.findEntry("products", "slug", "other", "en")).toBeNull();
		expect(await lookups.findEntry("products", "id", "missing", "en")).toBeNull();
		expect(reader.calls).toEqual([
			["products", "01A", undefined],
			["products", "desk", undefined],
			["products", "desk", "en"],
			["products", "01A", "en"],
			["products", "other", "en"],
			["products", "missing", undefined],
		]);
		const group = await lookups.findEntry("products", "slug", "01A-slug", "en");
		expect(group).toEqual({ id: "01B", group: "01B" });
	});

	it("turns other read errors into emdash_ codes", async () => {
		const reader = new Reader(() => ({
			success: false,
			error: { code: "CONTENT_GET_ERROR", message: "Failed" },
		}));
		const lookups = new EmDashLookups(undefined, undefined, reader);
		const error = await lookups.findEntry("products", "id", "x", "en").catch((e) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "emdash_content_get_error" });
	});

	it("fails on a success response without an item rather than finding nothing", async () => {
		const lookups = new EmDashLookups(
			undefined,
			undefined,
			new Reader(() => ({ success: true, data: {} })),
		);
		const error = await lookups.findEntry("products", "id", "x", "en").catch((e) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "emdash_bad_response" });
	});

	it("says which capability is missing", async () => {
		const lookups = new EmDashLookups(undefined, undefined, new Reader(() => found("x", "x")));
		await expect(lookups.terms("tag", "en")).rejects.toThrow("declare taxonomies:write");
		await expect(lookups.bylines("en")).rejects.toThrow("declare bylines:read");
	});
});
