/**
 * Files, schema and templates for the M4c media imports on the Node and workerd sites: two
 * 4 x 3 PNGs and a JPEG (real images, so EmDash reads their size and makes a placeholder), a
 * small PDF, and markup that must never be imported.
 */
import type { Client } from "../integration/client.js";

const base64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export const RED_PNG = base64(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR42mM8ISfHAANMDEgAhQMAJtoBCpDU3DQAAAAASUVORK5CYII=",
);
export const BLUE_PNG = base64(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR42mOUqzjBAANMDEgAhQMAMogBZLjEXE0AAAAASUVORK5CYII=",
);
export const GREEN_JPEG = base64(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCeiiivkD8qP//Z",
);
export const MANUAL_PDF = new TextEncoder().encode(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
export const HTML = "<!doctype html><title>Not found</title><p>Sorry</p>";

/** `n` bytes that start like a PNG: too large to import wherever `n` is over the limit. */
export function largePng(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	bytes.set(RED_PNG.subarray(0, 8));
	return bytes;
}

/**
 * Creates a collection (with revisions) with `title`, an image field `photo`, a file field
 * `manual`, and a file field `scan` that accepts only PNG and JPEG.
 */
export async function createMediaSchema(client: Client, collection: string): Promise<void> {
	await client.createCollection(collection);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "manual", label: "Manual", type: "file" },
		{
			slug: "scan",
			label: "Scan",
			type: "file",
			validation: { allowedMimeTypes: ["image/png", "image/jpeg"] },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${collection}/fields`, field);
	}
}

/** Photo with alt, manual, and scan; `refresh` on the photo when asked. */
export function mediaTemplate(collection: string, opts: { refresh?: boolean } = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			photo: {
				from: "Photo",
				type: "image",
				alt: { from: "Alt" },
				...(opts.refresh ? { refresh: true } : {}),
			},
			manual: { from: "Manual", type: "file" },
			scan: { from: "Scan", type: "file" },
		},
	};
}

/** One CSV row per record: `[sku, name, photo URL, alt, manual URL, scan URL]`. */
export function mediaCsv(rows: string[][]): string {
	return ["sku,Name,Photo,Alt,Manual,Scan", ...rows.map((r) => r.join(","))].join("\n");
}

/** A stored image or file value, as the content API reads it back. */
export type StoredMedia = {
	id: string;
	provider: string;
	filename: string;
	mimeType: string;
	alt?: string;
	width?: number;
	height?: number;
	blurhash?: string;
	meta: { storageKey: string };
};
