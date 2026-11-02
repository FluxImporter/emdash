/**
 * Schema, sources and templates for the M4d Portable Text imports on the Node and workerd sites.
 * Image URLs point at a `FeedServer`; the bodies carry a link, a table and a script, so every
 * import reports warnings.
 */
import type { Client } from "../integration/client.js";

/** Creates a collection (with revisions) with `title`, an image field `photo`, and `body`. */
export async function createPortableTextSchema(client: Client, collection: string): Promise<void> {
	await client.createCollection(collection);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "body", label: "Body", type: "portableText" },
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

export type Post = {
	id: string;
	title: string;
	slug?: string;
	html?: string;
	md?: string;
	photo?: string;
};

/** A JSON source: `{ "posts": [...] }`. */
export const postsJson = (posts: Post[]) => JSON.stringify({ posts });

/**
 * `body` from `html` (or `md` with `format: "markdown"`), `title`, and `photo` when asked. Extra
 * mapping options go on `body`.
 */
export function portableTextTemplate(
	collection: string,
	opts: {
		format?: "html" | "markdown";
		body?: Record<string, unknown>;
		photo?: boolean;
		field?: string;
		slug?: boolean;
	} = {},
) {
	const format = opts.format ?? "html";
	return {
		version: 1,
		source: { format: "json", records: "posts" },
		collection,
		locale: "en",
		key: { from: "id" },
		...(opts.slug ? { slug: { from: "slug" } } : {}),
		fields: {
			title: { from: "title", type: "text" },
			[opts.field ?? "body"]: {
				from: format === "html" ? "html" : "md",
				type: "portableText",
				format,
				...opts.body,
			},
			...(opts.photo ? { photo: { from: "photo", type: "image" } } : {}),
		},
	};
}

/** An article body: a heading, marks, a link, a captioned linked image, a table and a script. */
export function articleHtml(image: string): string {
	return `<h2>Intro <em>here</em></h2>
<p>Read <strong>this</strong> and <a href="https://example.com/more" target="_blank">more</a>.</p>
<figure><a href="https://example.com/big"><img src="${image}" alt="A red square"></a><figcaption>A caption</figcaption></figure>
<table><tr><td>cell</td></tr></table><script>alert("x")</script>`;
}
