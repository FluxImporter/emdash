/**
 * Schema, sources and templates for the M4b link imports on the Node and workerd sites: a
 * `people` collection imported first (for `match: "key"`), a `posts` collection with a single
 * reference to people and a multiple reference to posts, a hierarchical category taxonomy and a
 * flat tag taxonomy attached to posts, and two bylines.
 */
import type { Client } from "../integration/client.js";

export type LinkNames = {
	people: string;
	posts: string;
	category: string;
	tag: string;
	/** Byline slugs. */
	alex: string;
	sam: string;
};

export function linkNames(prefix: string): LinkNames {
	return {
		people: `${prefix}_people`,
		posts: `${prefix}_posts`,
		category: `${prefix}_category`,
		tag: `${prefix}_tag`,
		alex: `${prefix}-alex`,
		sam: `${prefix}-sam`,
	};
}

/**
 * Creates both collections (with revisions), the reference fields, both taxonomies (the tags
 * `new` and `sale` exist) and the bylines "Alex Doe" and "Sam Lee", through the admin API.
 */
export async function createLinkSchema(client: Client, n: LinkNames): Promise<void> {
	for (const collection of [n.people, n.posts]) {
		await client.createCollection(collection);
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
		});
	}
	await client.api("POST", `/_emdash/api/schema/collections/${n.posts}/fields`, {
		slug: "author",
		label: "Author",
		type: "reference",
		validation: { targetCollection: n.people },
	});
	await client.api("POST", `/_emdash/api/schema/collections/${n.posts}/fields`, {
		slug: "related",
		label: "Related",
		type: "reference",
		validation: { targetCollection: n.posts, multiple: true },
	});
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.category,
		label: "Categories",
		hierarchical: true,
		collections: [n.posts],
	});
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.tag,
		label: "Tags",
		collections: [n.posts],
	});
	for (const [slug, label] of [
		["new", "New"],
		["sale", "Sale"],
	]) {
		await client.api("POST", `/_emdash/api/taxonomies/${n.tag}/terms`, {
			slug,
			label,
			locale: "en",
		});
	}
	for (const [slug, displayName] of [
		[n.alex, "Alex Doe"],
		[n.sam, "Sam Lee"],
	]) {
		await client.api("POST", "/_emdash/api/admin/bylines", { slug, displayName, locale: "en" });
	}
}

export const PEOPLE_CSV = "id,Name\nA1,Alex\nA2,Sam\n";

export function peopleTemplate(n: LinkNames) {
	return {
		version: 1,
		collection: n.people,
		locale: "en",
		key: { from: "id" },
		fields: { title: { from: "Name", type: "text" } },
	};
}

/** Posts: `author` by import key, `related` by slug, categories by label path, tags by slug. */
export function postsTemplate(n: LinkNames, format: "csv" | "json" = "csv") {
	return {
		version: 1,
		collection: n.posts,
		locale: "en",
		source: { format },
		key: { from: "id" },
		fields: {
			title: { from: "Title", type: "text" },
			author: { from: "Author", type: "reference", match: "key" },
			related: { from: "Related", type: "reference", match: "slug", separator: "|" },
		},
		taxonomies: {
			[n.category]: {
				from: "Categories",
				match: "label",
				separator: ";",
				hierarchy: ">",
				create: true,
			},
			[n.tag]: { from: "Tags", separator: "|" },
		},
		bylines: { from: "Authors", match: "name", separator: ";" },
	};
}

/** P2 links to P1 by its slug, and P3 to both; P1 and P3 share a new category path. */
export const POSTS_CSV = [
	"id,Title,Author,Related,Categories,Tags,Authors",
	"P1,Desk review,A1,,Electronics > Phones,new|sale,Alex Doe",
	"P2,Lamp review,A2,desk-review,Garden,new,Sam Lee;Alex Doe",
	"P3,Chair review,A1,desk-review|lamp-review,Electronics > Phones;Electronics > Laptops,,",
	"",
].join("\n");

/** What `POSTS_CSV` stores, per key: term slugs, byline slugs, and link targets by key. */
export function postsStored(n: LinkNames) {
	return {
		P1: {
			category: ["phones"],
			tag: ["new", "sale"],
			bylines: [n.alex],
			author: "A1",
			related: [],
		},
		P2: {
			category: ["garden"],
			tag: ["new"],
			bylines: [n.sam, n.alex],
			author: "A2",
			related: ["P1"],
		},
		P3: {
			category: ["phones", "laptops"],
			tag: [],
			bylines: [],
			author: "A1",
			related: ["P1", "P2"],
		},
	};
}

/** The same posts as JSON records with arrays, under other keys. */
export const POSTS_JSON = JSON.stringify([
	{
		id: "J1",
		Title: "Desk guide",
		Author: "A2",
		Related: ["desk-review", "lamp-review"],
		Categories: ["Electronics > Phones", "Garden"],
		Tags: ["sale"],
		Authors: ["Sam Lee"],
	},
]);
