import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	type CompileContext,
	checkTemplate,
	compileTemplate,
	type Template,
	templatePaths,
	templateSchema,
	usesMedia,
} from "../../src/engine/template.js";

const base = (
	fields: Record<string, unknown>,
	source: Record<string, unknown> = { format: "json" },
) => ({
	version: 1,
	source,
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields,
});

function compiled(fields: Record<string, unknown>, context: CompileContext = {}) {
	const t = templateSchema.parse(base(fields)) as Template;
	const result = compileTemplate(t, context);
	if (!result.ok) throw new Error(result.problems.join("; "));
	return result.compiled;
}

const html = (from = "html", extra: Record<string, unknown> = {}) => ({
	from,
	type: "portableText",
	format: "html",
	...extra,
});

const img = (n: number) => `<img src="https://x.test/${n}.png">`;

describe("portableText mappings", () => {
	it("parses the options and fills in their defaults", () => {
		const c = compiled({
			body: html("html", { baseUrl: "https://old.test/blog/" }),
			summary: {
				expr: "summary",
				type: "portableText",
				format: "markdown",
				images: "skip",
				imageErrors: "fail",
				unknownMarkup: "fail",
			},
		});
		expect(c.portableText).toEqual(
			new Map([
				[
					"body",
					{
						format: "html",
						baseUrl: "https://old.test/blog/",
						images: "import",
						imageErrors: "drop",
						unknownMarkup: "warn",
					},
				],
				[
					"summary",
					{
						format: "markdown",
						baseUrl: null,
						images: "skip",
						imageErrors: "fail",
						unknownMarkup: "fail",
					},
				],
			]),
		);
		expect(templatePaths(c.template)).toEqual(["id", "html"]);
	});

	it("refuses a missing format, unknown options and a baseUrl that is not absolute http(s)", () => {
		const problems = (mapping: Record<string, unknown>) => {
			const parsed = templateSchema.safeParse(base({ body: mapping }));
			return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
		};
		expect(problems({ from: "h", type: "portableText" })).not.toEqual([]);
		expect(problems(html("h", { format: "rtf" }))).not.toEqual([]);
		expect(problems(html("h", { images: "maybe" }))).not.toEqual([]);
		expect(problems(html("h", { extra: true }))).not.toEqual([]);
		for (const baseUrl of ["/blog/", "ftp://old.test/", "https://u:p@old.test/", ""]) {
			expect(problems(html("h", { baseUrl }))).not.toEqual([]);
		}
		expect(problems(html("h", { baseUrl: "/blog/" }))).toContain(
			"baseUrl must be an absolute http or https URL",
		);
		expect(problems(html("h", { baseUrl: "http://old.test" }))).toEqual([]);
	});

	it("converts the text into a draft kept out of data, with the field's warnings", async () => {
		const c = compiled({ title: { from: "title", type: "text" }, body: html() });
		const result = await applyTemplate(c, {
			id: "1",
			title: "T",
			html: '<p>Hi <a href="javascript:x">there</a></p><img src="https://x.test/a.png"><table><tr><td>c</td></tr></table>',
		});
		expect(result).toEqual({
			ok: true,
			value: {
				key: "1",
				data: { title: "T" },
				portableText: {
					body: {
						blocks: [
							{
								_type: "block",
								_key: "b0",
								style: "normal",
								children: [{ _type: "span", _key: "b0s0", text: "Hi there", marks: [] }],
							},
							{ _type: "image", _key: "b1", slot: 0 },
							{
								_type: "block",
								_key: "b2",
								style: "normal",
								children: [{ _type: "span", _key: "b2s0", text: "c", marks: [] }],
							},
						],
						images: [{ url: "https://x.test/a.png", alt: null }],
					},
				},
			},
			warnings: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <table> element" },
				{
					field: "body",
					code: "link_dropped",
					message:
						"Kept the text of 1 link without the address: the scheme javascript: is not allowed",
				},
			],
		});
	});

	it("gives null for a missing, null or blank value and for markup that leaves nothing", async () => {
		const c = compiled({ body: html() });
		for (const value of [undefined, null, "  "]) {
			expect(await applyTemplate(c, { id: "1", html: value })).toEqual({
				ok: true,
				value: { key: "1", data: {}, portableText: { body: null } },
			});
		}
		expect(await applyTemplate(c, { id: "1", html: "<script>x</script>" })).toEqual({
			ok: true,
			value: { key: "1", data: {}, portableText: { body: null } },
			warnings: [{ field: "body", code: "removed_markup", message: "Removed 1 <script> element" }],
		});
	});

	it("fails non-text values, and an empty value in a required field, keeping the warnings", async () => {
		const c = compiled({ body: html() });
		for (const [value, found] of [
			[42, "a number"],
			[true, "a boolean"],
			[{ p: "x" }, "an object"],
			[["x"], "an array"],
		] as const) {
			expect(await applyTemplate(c, { id: "1", html: value })).toEqual({
				ok: false,
				errors: [
					{
						field: "body",
						code: "not_scalar",
						message: `Expected HTML, Markdown or text, found ${found}`,
					},
				],
			});
		}
		const required = compiled(
			{ body: html() },
			{ targets: { body: { type: "portableText", required: true } } },
		);
		expect(await applyTemplate(required, { id: "1", html: "<iframe></iframe>" })).toEqual({
			ok: false,
			errors: [{ field: "body", code: "required", message: "The field is required" }],
			warnings: [{ field: "body", code: "removed_markup", message: "Removed 1 <iframe> element" }],
		});
		expect(await applyTemplate(required, { id: "1" })).toEqual({
			ok: false,
			errors: [{ field: "body", code: "required", message: "The field is required" }],
		});
	});

	it("fails conversion errors under the field", async () => {
		const c = compiled({ body: html("html", { unknownMarkup: "fail", imageErrors: "fail" }) });
		const result = await applyTemplate(c, {
			id: "1",
			html: '<p>a</p><dl><dt>t</dt></dl><img src="/rel.png">',
		});
		expect(result).toEqual({
			ok: false,
			errors: [
				{ field: "body", code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
				{
					field: "body",
					code: "invalid_media_url",
					message: "/rel.png: A relative URL needs the mapping's baseUrl",
				},
			],
		});
	});

	it("keeps at most 50 distinct image URLs per record over all fields", async () => {
		const c = compiled({
			body: html(),
			more: html("more"),
			strict: html("strict", { imageErrors: "fail" }),
		});
		const first = Array.from({ length: 30 }, (_, i) => img(i)).join("");
		// 10 repeat the first field's URLs and 25 are new: 20 fit, 5 are dropped.
		const second = Array.from({ length: 35 }, (_, i) => img(i + 20)).join("");
		const result = await applyTemplate(c, { id: "1", html: first, more: `<p>t</p>${second}` });
		if (!result.ok) throw new Error("expected ok");
		const more = result.value.portableText?.more;
		expect(more?.images.map((i) => i.url)).toEqual(
			Array.from({ length: 30 }, (_, i) => `https://x.test/${i + 20}.png`),
		);
		expect(more?.blocks.length).toBe(31);
		expect(more?.blocks.at(-1)).toEqual({ _type: "image", _key: "b30", slot: 29 });
		expect(result.warnings).toEqual([
			{
				field: "more",
				code: "image_dropped",
				message:
					"Left out 5 images (https://x.test/50.png, …): at most 50 distinct image URLs per record",
			},
		]);
		const failed = await applyTemplate(c, {
			id: "1",
			html: Array.from({ length: 50 }, (_, i) => img(i)).join(""),
			strict: img(50),
		});
		expect(failed).toEqual({
			ok: false,
			errors: [
				{
					field: "strict",
					code: "portable_text_limit",
					message: "The record's Portable Text has more than 50 distinct image URLs",
				},
			],
		});
	});

	it("fails a required field that the image limit empties", async () => {
		const c = compiled(
			{ body: html(), last: html("last") },
			{ targets: { last: { type: "portableText", required: true } } },
		);
		const result = await applyTemplate(c, {
			id: "1",
			html: Array.from({ length: 50 }, (_, i) => img(i)).join(""),
			last: img(50),
		});
		expect(result).toMatchObject({
			ok: false,
			errors: [{ field: "last", code: "required", message: "The field is required" }],
		});
	});

	it("adds required only when the conversion gave no errors", async () => {
		const c = compiled(
			{ body: html("html", { unknownMarkup: "fail" }) },
			{ targets: { body: { type: "portableText", required: true } } },
		);
		const result = await applyTemplate(c, { id: "1", html: "<custom-a></custom-a>" });
		expect(result).toMatchObject({ ok: false });
		if (result.ok) return;
		expect(result.errors.map((e) => e.code)).toEqual(["unknown_markup"]);
	});

	it("bounds the markup issues per field", async () => {
		const tags = Array.from({ length: 300 }, (_, i) => `<x-t${i}>a</x-t${i}>`).join("");
		for (const unknownMarkup of ["warn", "fail"] as const) {
			const c = compiled({ body: html("html", { unknownMarkup }) });
			const result = await applyTemplate(c, { id: "1", html: `<p>${tags}</p>` });
			const issues = result.ok ? (result.warnings ?? []) : result.errors;
			expect(issues.length).toBe(20);
			expect(issues.at(-1)).toEqual({
				field: "body",
				code: "unknown_markup",
				message: "281 more elements",
			});
		}
	});

	it("refuses more than 1 MiB of Portable Text JSON in one record", async () => {
		const text = { type: "portableText", format: "text" };
		const c = compiled({
			a: { from: "a", ...text },
			b: { from: "b", ...text },
			c: { from: "c", ...text },
		});
		const big = "x".repeat(400_000);
		expect((await applyTemplate(c, { id: "1", a: big, b: big })).ok).toBe(true);
		expect(await applyTemplate(c, { id: "1", a: big, b: big, c: big })).toEqual({
			ok: false,
			errors: [
				{
					field: "c",
					code: "portable_text_too_large",
					message: "The record's Portable Text is larger than 1 MiB",
				},
			],
		});
	});
});

describe("portableText schema checks", () => {
	it("needs a portableText field and allows at most three mappings", () => {
		const t = (fields: Record<string, unknown>) => templateSchema.parse(base(fields)) as Template;
		expect(
			checkTemplate(t({ body: html() }), [{ slug: "body", type: "portableText" }], null),
		).toEqual([]);
		expect(checkTemplate(t({ body: html() }), [{ slug: "body", type: "text" }], null)).toEqual([
			'Field "body" has type "text"; a portableText mapping needs one of portableText',
		]);
		const four = Object.fromEntries(["a", "b", "c", "d"].map((f) => [f, html(f)]));
		const fields = Object.keys(four).map((slug) => ({ slug, type: "portableText" }));
		expect(checkTemplate(t(four), fields, null)).toEqual([
			"The template maps 4 portableText fields; at most 3 are allowed",
		]);
	});

	it("uses media when a portableText mapping imports its images", () => {
		const t = (fields: Record<string, unknown>) => templateSchema.parse(base(fields)) as Template;
		expect(usesMedia(t({ body: html() }))).toBe(true);
		expect(usesMedia(t({ body: html("html", { images: "import" }) }))).toBe(true);
		expect(usesMedia(t({ body: html("html", { images: "skip" }) }))).toBe(false);
		expect(usesMedia(t({ body: { from: "t", type: "text" } }))).toBe(false);
	});
});
