import { describe, expect, it } from "vitest";
import {
	acceptsUploadable,
	altConverter,
	matchesMime,
	mediaMapKey,
	mediaTypeProblem,
	mediaUrlConverter,
	normalizeMediaUrl,
} from "../../src/engine/media.js";
import {
	applyTemplate,
	type CompileContext,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
	usesMedia,
} from "../../src/engine/template.js";

const err = (code: string) => expect.objectContaining({ ok: false, code });

function compiled(fields: Record<string, unknown>, context: CompileContext = {}) {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields,
	}) as Template;
	const result = compileTemplate(t, context);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

describe("normalizeMediaUrl", () => {
	it("normalizes host case, default ports and percent-encoding, drops the fragment, keeps the query", () => {
		expect(
			normalizeMediaUrl("HTTPS://CDN.Example.com:443/a/../b%7e/Photo.JPG?w=1&W=2#top"),
		).toEqual({ ok: true, url: "https://cdn.example.com/b~/Photo.JPG?w=1&W=2" });
		expect(normalizeMediaUrl("http://example.com:80")).toEqual({
			ok: true,
			url: "http://example.com/",
		});
		expect(normalizeMediaUrl("http://example.com:8080/x y")).toEqual({
			ok: true,
			url: "http://example.com:8080/x%20y",
		});
	});

	it("gives one URL for every spelling of an unreserved character and keeps reserved ones encoded", () => {
		const urls = ["https://e.com/a%7E", "https://e.com/a%7e", "https://e.com/a~"].map((u) =>
			normalizeMediaUrl(u),
		);
		for (const u of urls) expect(u).toEqual({ ok: true, url: "https://e.com/a~" });
		expect(normalizeMediaUrl("https://e.com/a%2fb%3f?q=%2f%41%7e")).toEqual({
			ok: true,
			url: "https://e.com/a%2Fb%3F?q=%2FA~",
		});
	});

	it("drops the fragment before the length check", () => {
		expect(normalizeMediaUrl(`https://e.com/a.png#${"f".repeat(3000)}`)).toEqual({
			ok: true,
			url: "https://e.com/a.png",
		});
	});

	it("refuses relative, data:, userinfo and overlong URLs", () => {
		expect(normalizeMediaUrl("/images/a.png")).toEqual({
			ok: false,
			message: "The URL is not valid",
		});
		expect(normalizeMediaUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
			ok: false,
			message: 'The URL scheme "data:" is not allowed; use http or https',
		});
		expect(normalizeMediaUrl("https://user:pw@example.com/a.png")).toEqual({
			ok: false,
			message: "URLs cannot contain a user name or password; use a credential",
		});
		expect(normalizeMediaUrl(`https://example.com/${"a".repeat(2048)}`)).toEqual({
			ok: false,
			message: "URLs are limited to 2048 characters",
		});
	});
});

describe("mediaMapKey", () => {
	it("is u and the SHA-256 of the normalized URL, stable and distinct", () => {
		const key = mediaMapKey("https://cdn.example.com/a.png");
		expect(key).toBe("u6155f67efa620e76fd5fb2c42f3676aec9cba0ee554f6ad1f33773ff1d26f587");
		expect(mediaMapKey("https://cdn.example.com/a.png")).toBe(key);
		expect(mediaMapKey("https://cdn.example.com/A.png")).not.toBe(key);
	});
});

describe("mediaUrlConverter and altConverter", () => {
	it("gives null for a missing, null or blank URL, and trims", () => {
		expect(mediaUrlConverter(undefined)).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter(null)).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter("  ")).toEqual({ ok: true, value: null });
		expect(mediaUrlConverter(" https://x.test/a.png ")).toEqual({
			ok: true,
			value: "https://x.test/a.png",
		});
	});

	it("refuses numbers, booleans, objects and arrays as URLs", () => {
		expect(mediaUrlConverter(42)).toEqual({
			ok: false,
			code: "not_scalar",
			message: "Expected a URL as text, found a number",
		});
		expect(mediaUrlConverter(true)).toEqual(err("not_scalar"));
		expect(mediaUrlConverter({ url: "x" })).toEqual(err("not_scalar"));
		expect(mediaUrlConverter(["https://x.test/a.png"])).toEqual({
			ok: false,
			code: "not_scalar",
			message: "Expected a URL as text, found an array",
		});
		expect(mediaUrlConverter("ftp://x.test/a.png")).toEqual(err("invalid_media_url"));
	});

	it("reads alt text from scalars, trimmed, with empty as none and a 1,000-character limit", () => {
		expect(altConverter(" A red chair ")).toEqual({ ok: true, value: "A red chair" });
		expect(altConverter(7)).toEqual({ ok: true, value: "7" });
		expect(altConverter("   ")).toEqual({ ok: true, value: null });
		expect(altConverter(null)).toEqual({ ok: true, value: null });
		expect(altConverter("a".repeat(1000))).toEqual({ ok: true, value: "a".repeat(1000) });
		expect(altConverter("a".repeat(1001))).toEqual({
			ok: false,
			code: "alt_too_long",
			message: "The alt text has 1001 characters; at most 1000 are allowed",
		});
		expect(altConverter({ a: 1 })).toEqual(err("not_scalar"));
	});
});

describe("media type rules", () => {
	it("matches MIME types and prefixes as EmDash does", () => {
		expect(matchesMime("image/PNG; charset=x", ["image/png"])).toBe(true);
		expect(matchesMime("video/mp4", ["video/"])).toBe(true);
		expect(matchesMime("image/png", [".png", "image/"])).toBe(true);
		expect(matchesMime("image/png", [".png"])).toBe(false);
	});

	it("knows whether a field accepts anything EmDash's upload allows", () => {
		expect(acceptsUploadable(["image/svg+xml"], "image")).toBe(false);
		expect(acceptsUploadable([".png"], "image")).toBe(false);
		expect(acceptsUploadable(["image/svg+xml", "image/png"], "image")).toBe(true);
		expect(acceptsUploadable(["image/"], "image")).toBe(true);
		expect(acceptsUploadable(["video/mp4"], "file")).toBe(true);
		expect(acceptsUploadable(["application/pdf"], "image")).toBe(false);
		expect(acceptsUploadable(["application/zip"], "file")).toBe(false);
	});

	it("explains why a type cannot go into a field", () => {
		expect(mediaTypeProblem("image/png", "image", undefined)).toBeNull();
		expect(mediaTypeProblem("image/svg+xml", "image", ["image/svg+xml"])).toBe(
			"EmDash does not accept image/svg+xml uploads",
		);
		expect(mediaTypeProblem("application/pdf", "image", undefined)).toBe(
			"An image field cannot take application/pdf",
		);
		expect(mediaTypeProblem("application/pdf", "file", ["image/png"])).toBe(
			"The field accepts only image/png, not application/pdf",
		);
		expect(mediaTypeProblem("video/mp4", "file", [])).toBeNull();
		expect(mediaTypeProblem("Image/PNG; charset=x", "image", ["image/png"])).toBeNull();
	});
});

describe("image and file mappings", () => {
	it("parses image and file mappings with alt and refresh, and refuses alt on a file", () => {
		const fields = {
			photo: { from: "Img", type: "image", alt: { from: "Alt" }, refresh: true },
			manual: { expr: "'https://x.test/' & sku & '.pdf'", type: "file" },
		};
		expect(compiled(fields).media).toEqual(
			new Map([
				["photo", { kind: "image", refresh: true, alt: { from: "Alt", expr: null } }],
				["manual", { kind: "file", refresh: false, alt: null }],
			]),
		);
		const parse = (f: Record<string, unknown>) =>
			templateSchema.safeParse({
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { f },
			}).success;
		expect(parse({ from: "U", type: "file", alt: { from: "A" } })).toBe(false);
		expect(parse({ from: "U", type: "image", alt: { from: "A", expr: "x" } })).toBe(false);
		expect(parse({ from: "U", type: "image", alt: {} })).toBe(false);
		expect(parse({ from: "U", type: "image", refresh: "yes" })).toBe(false);
	});

	it("reports an alt expression that does not compile under its field", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { photo: { from: "Img", type: "image", alt: { expr: "(" } } },
		});
		const result = compileTemplate(t);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems[0]).toMatch(/^fields\.photo\.alt\.expr: /);
	});

	it("maps URLs and alt text into media requests, kept out of data", async () => {
		const c = compiled({
			title: { from: "Name", type: "text" },
			photo: { from: "Img", type: "image", alt: { expr: "'Photo of ' & Name" } },
			manual: { from: "Pdf", type: "file", refresh: true },
		});
		const result = await applyTemplate(c, {
			sku: "A1",
			Name: "Chair",
			Img: " https://CDN.test/chair.png#x ",
			Pdf: "https://cdn.test/a1.pdf",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: { title: "Chair" },
				media: {
					photo: {
						kind: "image",
						url: "https://cdn.test/chair.png",
						alt: "Photo of Chair",
						refresh: false,
					},
					manual: { kind: "file", url: "https://cdn.test/a1.pdf", alt: null, refresh: true },
				},
			},
		});
	});

	it("gives null for an empty URL without reading its alt, and fails a required one", async () => {
		const c = compiled(
			{
				photo: { from: "Img", type: "image", alt: { expr: "$number('not a number')" } },
				manual: { from: "Pdf", type: "file" },
			},
			{
				targets: {
					photo: { type: "image", required: false },
					manual: { type: "file", required: true },
				},
			},
		);
		expect(await applyTemplate(c, { sku: "A1", Img: "", Pdf: "https://x.test/a.pdf" })).toEqual({
			ok: true,
			value: {
				key: "A1",
				data: {},
				media: {
					photo: null,
					manual: { kind: "file", url: "https://x.test/a.pdf", alt: null, refresh: false },
				},
			},
		});
		expect(await applyTemplate(c, { sku: "A1", Img: "", Pdf: " " })).toEqual({
			ok: false,
			errors: [{ field: "manual", code: "required", message: "The field is required" }],
		});
	});

	it("reports URL and alt errors under the field and its alt", async () => {
		const c = compiled({
			photo: { from: "Img", type: "image", alt: { from: "Alt" } },
			icon: { from: "Icon", type: "image" },
		});
		expect(
			await applyTemplate(c, {
				sku: "A1",
				Img: "https://x.test/a.png",
				Alt: "a".repeat(1001),
				Icon: "icons/a.png",
			}),
		).toEqual({
			ok: false,
			errors: [
				{
					field: "photo.alt",
					code: "alt_too_long",
					message: "The alt text has 1001 characters; at most 1000 are allowed",
				},
				{ field: "icon", code: "invalid_media_url", message: "The URL is not valid" },
			],
		});
	});

	it("lists alt paths, and leaves templates without media as before", async () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "Name", type: "text" },
				photo: { from: "Img", type: "image", alt: { from: "Name" } },
				thumb: { from: "Thumb", type: "image", alt: { from: "ThumbAlt" } },
			},
		});
		expect(templatePaths(t)).toEqual(["sku", "Name", "Img", "Thumb", "ThumbAlt"]);
		expect(usesMedia(t)).toBe(true);
		const plain = compiled({ title: { from: "Name", type: "text" } });
		expect(plain.media.size).toBe(0);
		expect(await applyTemplate(plain, { sku: "A1", Name: "x" })).toEqual({
			ok: true,
			value: { key: "A1", data: { title: "x" } },
		});
		expect(usesMedia(plain.template)).toBe(false);
	});
});
