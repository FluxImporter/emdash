import MarkdownIt from "markdown-it";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	convertPortableText,
	type DraftBlock,
	imageUrl,
	type PortableTextConverted,
	type PortableTextFormat,
	type PortableTextOptions,
	parseHtml,
	safeHref,
} from "../../src/engine/portable-text.js";

const HTML: PortableTextOptions = {
	format: "html",
	baseUrl: null,
	images: "import",
	imageErrors: "drop",
	unknownMarkup: "warn",
};
const convert = (text: string, options: Partial<PortableTextOptions> = {}) =>
	convertPortableText(text, { ...HTML, ...options });
const markdown = (text: string) => convert(text, { format: "markdown" });

/** Each block as one line: `style list level: text`, `image #slot`, `code lang: text`, `break`. */
function outline(converted: PortableTextConverted): string[] {
	return (converted.draft?.blocks ?? []).map((b: DraftBlock) => {
		if (b._type === "image") return `image #${b.slot}`;
		if (b._type === "break") return "break";
		if (b._type === "code") return `code ${b.language ?? "-"}: ${b.code}`;
		const text = (b.children as { text: string }[]).map((s) => s.text).join("");
		const list = b.listItem === undefined ? "" : ` ${b.listItem} ${b.level}`;
		return `${b.style}${list}: ${text}`;
	});
}

const span = (key: string, text: string, marks: string[] = []) => ({
	_type: "span",
	_key: key,
	text,
	marks,
});

const LIMIT = 512 * 1024;
/** Input of about `bytes` characters: `prefix`, then `unit` repeated. */
const sized =
	(unit: string, prefix = "") =>
	(bytes: number) =>
		prefix + unit.repeat(Math.floor((bytes - prefix.length) / unit.length));
/** Input of about `bytes` characters made of distinct units. */
const distinct = (unit: (i: number) => string) => (bytes: number) => {
	let text = "";
	for (let i = 0; text.length < bytes - 40; i++) text += unit(i);
	return text;
};

describe("convertPortableText: blocks and marks", () => {
	it("builds the blocks and marks EmDash's editor writes", () => {
		const html = `<h2>Title <em>here</em></h2>
<p>Read <strong>this</strong> <a href="https://example.com/a" target="_blank">now</a><br>then</p>
<ul><li>one<ul><li>two</li></ul></li></ul>
<pre><code class="language-ts">const a = 1;</code></pre><hr>`;
		expect(convert(html)).toEqual({
			draft: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "h2",
						children: [span("b0s0", "Title "), span("b0s1", "here", ["em"])],
					},
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						children: [
							span("b1s0", "Read "),
							span("b1s1", "this", ["strong"]),
							span("b1s2", " "),
							// The editor ends a span at a hard break and keeps the `\n` in it.
							span("b1s3", "now\n", ["b1l0"]),
							span("b1s4", "then"),
						],
						markDefs: [{ _type: "link", _key: "b1l0", href: "https://example.com/a", blank: true }],
					},
					{
						_type: "block",
						_key: "b2",
						style: "normal",
						listItem: "bullet",
						level: 1,
						children: [span("b2s0", "one")],
					},
					{
						_type: "block",
						_key: "b3",
						style: "normal",
						listItem: "bullet",
						level: 2,
						children: [span("b3s0", "two")],
					},
					{ _type: "code", _key: "b4", code: "const a = 1;", language: "ts" },
					{ _type: "break", _key: "b5", style: "lineBreak" },
				],
				images: [],
			},
			errors: [],
			warnings: [],
		});
	});

	it("maps every decorator in nesting order and merges equal neighbours", () => {
		const html =
			"<b>a<i>b<u>c</u></i></b><s>s</s><strike>k</strike><del>d</del><code>x</code><sub>1</sub><sup>2</sup><em><strong>e</strong></em>";
		const children = convert(html).draft?.blocks[0]?.children;
		expect(children).toEqual([
			span("b0s0", "a", ["strong"]),
			span("b0s1", "b", ["strong", "em"]),
			span("b0s2", "c", ["strong", "em", "underline"]),
			span("b0s3", "skd", ["strike-through"]),
			span("b0s4", "x", ["code"]),
			span("b0s5", "1", ["subscript"]),
			span("b0s6", "2", ["superscript"]),
			span("b0s7", "e", ["em", "strong"]),
		]);
	});

	it("nests lists up to level 6 and keeps a list item's paragraphs in one block", () => {
		let html = "";
		for (let i = 1; i <= 7; i++) html += `<${i < 3 ? "ol" : "ul"}><li>${i}`;
		expect(outline(convert(html))).toEqual([
			"normal number 1: 1",
			"normal number 2: 2",
			"normal bullet 3: 3",
			"normal bullet 4: 4",
			"normal bullet 5: 5",
			"normal bullet 6: 6",
			"normal bullet 6: 7",
		]);
		expect(
			outline(
				convert("<ul><li><p>one</p><p>two</p>tail</li><li>x<div>y</div></li></ul><li>loose</li>"),
			),
		).toEqual([
			"normal bullet 1: one\ntwo\ntail",
			"normal bullet 1: x\ny",
			"normal bullet 1: loose",
		]);
	});

	it("gives quotes and headings their style", () => {
		expect(
			outline(convert("<blockquote><p>a</p><p>b</p></blockquote><h1>c</h1><h6>d</h6><p>e</p>")),
		).toEqual(["blockquote: a", "blockquote: b", "h1: c", "h6: d", "normal: e"]);
	});

	it("keeps pre text exactly, with the language of a language- or lang- class", () => {
		expect(outline(convert('<pre class="lang-js">\n  x  <b>y</b>\n\n z</pre>'))).toEqual([
			"code js:   x  y\n\n z",
		]);
		expect(outline(convert("<pre><code>\nfirst\n</code></pre><pre> </pre>"))).toEqual([
			"code -: first\n",
		]);
		expect(outline(markdown("```py\nprint(1)\n```\n"))).toEqual(["code py: print(1)\n"]);
	});

	it("collapses HTML whitespace, trims blocks, and drops empty ones", () => {
		const converted = convert(
			"<p>  a \n\t b  <b> c </b>  d<br>  e  </p><p> </p><p><br>f<br></p><p>&nbsp;</p>",
		);
		expect(converted.draft?.blocks.map((b) => b.children)).toEqual([
			[
				span("b0s0", "a b "),
				span("b0s1", "c ", ["strong"]),
				span("b0s2", "d\n"),
				span("b0s3", "e"),
			],
			[span("b1s0", "f")],
			[span("b2s0", " ")],
		]);
	});

	it("keeps transparent markup silently, and drops attributes and comments", () => {
		const html = `<!-- wp:paragraph --><div class="x"><section><p onclick="x()" style="color:red">a <span>b</span> <font>c</font> <mark>d</mark></p></section></div><!-- /wp:paragraph --><!--ec:block {"_type":"htmlBlock","html":"<script>x</script>"}-->e`;
		const converted = convert(html);
		expect(outline(converted)).toEqual(["normal: a b c d", "normal: e"]);
		expect(converted.warnings).toEqual([]);
		expect(JSON.stringify(converted)).not.toMatch(/onclick|color|htmlBlock|script/);
	});
});

describe("convertPortableText: unknown and removed markup", () => {
	it("keeps the text of unknown markup, with one counted warning per tag", () => {
		const html =
			"<table><thead><tr><th>A</th><th>B</th></tr></thead><tr><td>1</td><td></td><td>3</td></tr></table><table><tr><td>x</td></tr></table><dl><dt>T</dt><dd>D</dd></dl><p>a <my-widget>w</my-widget></p>";
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"normal: A | B",
			"normal: 1 | 3",
			"normal: x",
			"normal: T",
			"normal: D",
			"normal: a w",
		]);
		expect(converted.warnings).toEqual([
			{ code: "unknown_markup", message: "Kept the text of 2 <table> elements" },
			{ code: "unknown_markup", message: "Kept the text of 1 <dl> element" },
			{ code: "unknown_markup", message: "Kept the text of 1 <my-widget> element" },
		]);
	});

	it("removes active content with everything in it, and reports it", () => {
		const html =
			'<p>a<script>alert("s")</script><style>p{}</style>b</p><iframe src="x"></iframe><iframe></iframe><svg onload="x()"><text>svg</text></svg><form><input value="i">form</form><noscript>ns</noscript><pre>c<script>alert(2)</script></pre>';
		const converted = convert(html);
		expect(outline(converted)).toEqual(["normal: ab", "code -: c"]);
		expect(converted.warnings).toEqual([
			{ code: "removed_markup", message: "Removed 2 <script> elements" },
			{ code: "removed_markup", message: "Removed 1 <style> element" },
			{ code: "removed_markup", message: "Removed 2 <iframe> elements" },
			{ code: "removed_markup", message: "Removed 1 <svg> element" },
			{ code: "removed_markup", message: "Removed 1 <form> element" },
			{ code: "removed_markup", message: "Removed 1 <noscript> element" },
		]);
		expect(JSON.stringify(converted.draft)).not.toMatch(/alert|svg|form|ns/);
		// Only removed markup: nothing is left, so the value is empty.
		expect(convert("<script>x</script><!-- c -->")).toEqual({
			draft: null,
			errors: [],
			warnings: [{ code: "removed_markup", message: "Removed 1 <script> element" }],
		});
	});

	it("removes elements whose raw text would show as markup source", () => {
		const converted = convert(
			"<title>t</title><noembed><b>n</b></noembed><noframes><i>f</i></noframes><xmp><b>x</b></xmp><p>kept</p><plaintext><p>rest</p>",
		);
		expect(outline(converted)).toEqual(["normal: kept"]);
		expect(converted.warnings).toEqual([
			{ code: "removed_markup", message: "Removed 1 <title> element" },
			{ code: "removed_markup", message: "Removed 1 <noembed> element" },
			{ code: "removed_markup", message: "Removed 1 <noframes> element" },
			{ code: "removed_markup", message: "Removed 1 <xmp> element" },
			{ code: "removed_markup", message: "Removed 1 <plaintext> element" },
		]);
	});

	it("fails unknown and removed markup and dropped links with unknownMarkup: fail", () => {
		const converted = convert(
			'<table><tr><td>t</td></tr></table><script>x</script><a href="javascript:x">j</a>',
			{
				unknownMarkup: "fail",
			},
		);
		expect(converted.errors.map((e) => e.code)).toEqual([
			"unknown_markup",
			"removed_markup",
			"link_dropped",
		]);
		expect(converted.warnings).toEqual([]);
	});

	it("emits only the block and mark types EmDash's editor accepts", () => {
		const html =
			'<h1>a</h1><p><b>b</b><a href="https://x.test">l</a></p><ul><li>c</li></ul><pre>d</pre><hr><img src="https://x.test/a.png"><table><tr><td>e</td></tr></table><video src="v.mp4"></video><!--ec:block {"_type":"iframe"}-->';
		const blocks = convert(html).draft?.blocks ?? [];
		expect(new Set(blocks.map((b) => b._type))).toEqual(
			new Set(["block", "code", "break", "image"]),
		);
		const marks = blocks.flatMap((b) =>
			((b.children ?? []) as { marks: string[] }[]).flatMap((s) => s.marks),
		);
		expect(marks.every((m) => ["strong", "b1l0"].includes(m))).toBe(true);
	});
});

describe("convertPortableText: links", () => {
	it("keeps only safe schemes and fragments, and shares a definition per href and target", () => {
		const html =
			'<a href="javascript:alert(1)">j</a> <a href="&#106;avascript:x">e</a> <a href="data:text/html,x">d</a> <a href="vbscript:x">v</a> <a href="java\tscript:x">t</a> <a href="ftp://x">f</a> <a href="/rel">r</a> <a href="#top">h</a> <a href="mailto:a@b.c">m</a> <a href="tel:+1">p</a> <a href="https://x.test/a">1</a><a href="https://x.test/a">2</a><a href="https://x.test/a" target="_blank">3</a> <a name="n">n</a>';
		const converted = convert(html);
		const block = converted.draft?.blocks[0];
		expect(block?.markDefs).toEqual([
			{ _type: "link", _key: "b0l0", href: "#top" },
			{ _type: "link", _key: "b0l1", href: "mailto:a@b.c" },
			{ _type: "link", _key: "b0l2", href: "tel:+1" },
			{ _type: "link", _key: "b0l3", href: "https://x.test/a" },
			{ _type: "link", _key: "b0l4", href: "https://x.test/a", blank: true },
		]);
		expect(block?.children).toContainEqual(span("b0s7", "12", ["b0l3"]));
		expect(converted.warnings).toEqual([
			{
				code: "link_dropped",
				message:
					"Kept the text of 2 links without the address: the scheme javascript: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme data: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme vbscript: is not allowed",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: it contains control characters",
			},
			{
				code: "link_dropped",
				message: "Kept the text of 1 link without the address: the scheme ftp: is not allowed",
			},
			{
				code: "link_dropped",
				message:
					"Kept the text of 1 link without the address: a relative address needs the mapping's baseUrl",
			},
		]);
	});

	it("resolves relative and protocol-relative links, and refuses long ones", () => {
		const base = new URL("https://old.test/blog/post/");
		expect(safeHref("../a b", base)).toEqual({ ok: true, href: "https://old.test/blog/a%20b" });
		expect(safeHref("//cdn.test/x", base)).toEqual({ ok: true, href: "https://cdn.test/x" });
		expect(safeHref("//cdn.test/x", new URL("http://old.test/"))).toEqual({
			ok: true,
			href: "http://cdn.test/x",
		});
		expect(safeHref("//cdn.test/x", null)).toEqual({ ok: true, href: "https://cdn.test/x" });
		expect(safeHref(" HTTPS://X.test ", null)).toEqual({ ok: true, href: "https://x.test/" });
		expect(safeHref(`https://x.test/${"a".repeat(2048)}`, null)).toEqual({
			ok: false,
			reason: "it is longer than 2048 characters",
		});
		expect(safeHref("https://x y", null)).toEqual({ ok: false, reason: "it is not a valid URL" });
	});
});

describe("convertPortableText: images", () => {
	it("ends the block at an image and continues with the same style and list position", () => {
		const html =
			'<p>before <img src="https://x.test/a.png" alt=" A "> after</p><ul><li>a<img src="https://x.test/b.png">b</li></ul><h3>c<img src="https://x.test/a.png">d</h3>';
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"normal: before",
			"image #0",
			"normal: after",
			"normal bullet 1: a",
			"image #1",
			"normal bullet 1: b",
			"h3: c",
			"image #0",
			"h3: d",
		]);
		expect(converted.draft?.images).toEqual([
			{ url: "https://x.test/a.png", alt: "A" },
			{ url: "https://x.test/b.png", alt: null },
		]);
		expect(converted.draft?.blocks[1]).toEqual({ _type: "image", _key: "b1", slot: 0, alt: "A" });
	});

	it("takes data-src for lazy images, resolves against baseUrl, and normalizes the URL", () => {
		const converted = convert(
			'<img src="data:image/gif;base64,R0lGOD" data-src="/a.png"><img data-src="b.png"><img src="//CDN.test/c.png#x"><img src="https://x.test:443/a/../d.png">',
			{ baseUrl: "https://old.test/blog/" },
		);
		expect(converted.draft?.images.map((i) => i.url)).toEqual([
			"https://old.test/a.png",
			"https://old.test/blog/b.png",
			"https://cdn.test/c.png",
			"https://x.test/d.png",
		]);
		expect(imageUrl("//cdn.test/c.png", null)).toEqual({ ok: true, url: "https://cdn.test/c.png" });
	});

	it("drops an image with a bad URL with a warning, or fails it with imageErrors: fail", () => {
		const html =
			'<p>a<img src="/rel.png">b</p><img src="data:image/png;base64,iVBOR"><img src="https://u:p@x.test/a.png"><img>';
		const dropped = convert(html);
		expect(outline(dropped)).toEqual(["normal: ab"]);
		expect(dropped.warnings).toEqual([
			{
				code: "image_dropped",
				message: "invalid_media_url: /rel.png: A relative URL needs the mapping's baseUrl",
			},
			{
				code: "image_dropped",
				message:
					'invalid_media_url: data:image/png;base64,iVBOR: The URL scheme "data:" is not allowed; use http or https',
			},
			{
				code: "image_dropped",
				message:
					"invalid_media_url: https://u:p@x.test/a.png: URLs cannot contain a user name or password; use a credential",
			},
		]);
		const failed = convert(html, { imageErrors: "fail" });
		expect(failed.errors.map((e) => [e.code, e.message.split(":")[0]])).toEqual([
			["invalid_media_url", "/rel.png"],
			["invalid_media_url", "data"],
			["invalid_media_url", "https"],
		]);
		expect(failed.warnings).toEqual([]);
	});

	it("gives a figure's caption to its one image, and keeps it as a paragraph otherwise", () => {
		const html =
			'<figure><img src="https://x.test/a.png"><figcaption> Cap <b>tion</b> <script>x</script></figcaption></figure><figure><img src="https://x.test/b.png"><img src="https://x.test/c.png"><figcaption>Two</figcaption></figure><figure><blockquote>q</blockquote><figcaption>said</figcaption></figure>';
		const converted = convert(html);
		expect(outline(converted)).toEqual([
			"image #0",
			"image #1",
			"image #2",
			"normal: Two",
			"blockquote: q",
			"normal: said",
		]);
		expect(converted.draft?.blocks[0]).toEqual({
			_type: "image",
			_key: "b0",
			slot: 0,
			caption: "Cap tion",
		});
		expect(converted.warnings).toEqual([
			{ code: "removed_markup", message: "Removed 1 <script> element" },
		]);
		// A figure that holds another figure keeps its caption as a paragraph.
		const nested = convert(
			'<figure><img src="https://x.test/a.png"><figure><img src="https://x.test/b.png"><figcaption>inner</figcaption></figure><figcaption>outer</figcaption></figure>',
		);
		expect(outline(nested)).toEqual(["image #0", "image #1", "normal: outer"]);
		expect(nested.draft?.blocks[1]?.caption).toBe("inner");
		expect(nested.draft?.blocks[0]?.caption).toBeUndefined();
		const long = convert(
			`<figure><img src="https://x.test/a.png"><figcaption>${"c".repeat(1001)}</figcaption></figure>`,
		);
		expect(long.draft?.blocks[0]?.caption).toHaveLength(1000);
	});

	it("reports images inside code or a caption, which hold only text", () => {
		const html =
			'<pre>a<img src="https://x.test/a.png">b</pre><figure><img src="https://x.test/c.png"><figcaption>c<img src="https://x.test/d.png"></figcaption></figure>';
		const converted = convert(html);
		expect(outline(converted)).toEqual(["code -: ab", "image #0"]);
		expect(converted.draft?.images).toEqual([{ url: "https://x.test/c.png", alt: null }]);
		expect(converted.warnings).toEqual([
			{
				code: "image_dropped",
				message: "Left out 2 images inside <pre> or <figcaption>, which hold only text",
			},
		]);
		expect(convert(html, { images: "skip" }).warnings).toEqual([]);
	});

	it("links an image inside a link, and keeps the alt, cut at 1,000 characters", () => {
		const html = `<a href="https://x.test/big" target="_blank">see <img src="https://x.test/a.png" alt="${"a".repeat(1001)}"></a><a href="javascript:x"><img src="https://x.test/b.png"></a>`;
		const converted = convert(html);
		expect(converted.draft?.blocks[1]).toEqual({
			_type: "image",
			_key: "b1",
			slot: 0,
			alt: "a".repeat(1000),
			link: { href: "https://x.test/big", blank: true },
		});
		expect(converted.draft?.blocks[2]).toEqual({ _type: "image", _key: "b2", slot: 1 });
		expect(converted.warnings).toContainEqual({
			code: "alt_truncated",
			message: "Cut the alt text of 1 image to 1000 characters",
		});
	});

	it("lists each URL once, keeps each image's alt, and skips images with images: skip", () => {
		const html =
			'<picture><source srcset="a.webp"><img src="https://x.test/a.png" alt="one"></picture><p>t</p><img src="https://X.test/a.png#f" alt="two">';
		const converted = convert(html);
		expect(converted.draft?.images).toEqual([{ url: "https://x.test/a.png", alt: "one" }]);
		expect(converted.draft?.blocks.filter((b) => b._type === "image")).toEqual([
			{ _type: "image", _key: "b0", slot: 0, alt: "one" },
			{ _type: "image", _key: "b2", slot: 0, alt: "two" },
		]);
		expect(converted.warnings).toEqual([]);
		const skipped = convert(`${html}<img src="/relative.png">`, { images: "skip" });
		expect(outline(skipped)).toEqual(["normal: t"]);
		expect(skipped.draft?.images).toEqual([]);
		expect(skipped.warnings).toEqual([]);
	});
});

describe("convertPortableText: formats, keys and limits", () => {
	it("is deterministic: the same input gives the same keys and value", () => {
		const html =
			'<p>a <b>b</b> <a href="https://x.test">c</a></p><img src="https://x.test/a.png"><ul><li>d</li></ul>';
		expect(convert(html)).toEqual(convert(html));
		const keys = JSON.stringify(convert(html)).match(/"_key":"[^"]+"/g);
		expect(keys).toEqual([
			'"_key":"b0"',
			'"_key":"b0s0"',
			'"_key":"b0s1"',
			'"_key":"b0s2"',
			'"_key":"b0s3"',
			'"_key":"b0l0"',
			'"_key":"b1"',
			'"_key":"b2"',
			'"_key":"b2s0"',
		]);
	});

	it("splits plain text into paragraphs on blank lines and keeps single line breaks", () => {
		expect(convert("  one\r\nline <b>two</b>\n\n\n three  \n \n", { format: "text" })).toEqual({
			draft: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "normal",
						children: [span("b0s0", "one\nline <b>two</b>")],
					},
					{ _type: "block", _key: "b1", style: "normal", children: [span("b1s0", "three")] },
				],
				images: [],
			},
			errors: [],
			warnings: [],
		});
	});

	it("refuses source text over 512 KiB and rendered Markdown over 2 MiB", () => {
		const tooLarge = {
			draft: null,
			errors: [{ code: "portable_text_too_large", message: "The text is larger than 512 KiB" }],
			warnings: [],
		};
		expect(convert(`<p>${"a".repeat(512 * 1024)}</p>`)).toEqual(tooLarge);
		// 2 bytes in UTF-8 each: over the limit with half as many characters.
		expect(convert("é".repeat(256 * 1024 + 1), { format: "text" })).toEqual(tooLarge);
		expect(convert("é".repeat(256 * 1024), { format: "text" }).errors).toEqual([]);
		// Each "<" renders as "&lt;": 512 KiB of them is more than 2 MiB of HTML.
		expect(convert("<".repeat(512 * 1024), { format: "markdown" }).errors).toEqual([
			{
				code: "portable_text_too_large",
				message: "The Markdown renders to more than 2 MiB of HTML",
			},
		]);
	});

	it("refuses markup that keeps more than 256 elements open, implied ones included", () => {
		const tooComplex = [
			{
				code: "portable_text_too_complex",
				message: "The markup nests more than 256 elements deep",
			},
		];
		expect(convert(`${"<div>".repeat(256)}x`).errors).toEqual([]);
		expect(convert(`${"<div>".repeat(257)}x`).errors).toEqual(tooComplex);
		// Each list item opens an element without being counted in the source's end tags.
		expect(convert(`${"<ul><li>".repeat(128)}x`).errors).toEqual([]);
		expect(convert(`${"<ul><li>".repeat(129)}x`).errors).toEqual(tooComplex);
		expect(convert(`${"<b>".repeat(300)}x`).errors).toEqual(tooComplex);
	});

	it("refuses a tag with more than 1,000 attributes, quickly", () => {
		const tag = (n: number) =>
			`<p ${Array.from({ length: n }, (_, i) => `a${i}="v ${i}>"`).join(" ")}>x</p>`;
		expect(convert(tag(1000)).errors).toEqual([]);
		const tooMany = [
			{
				code: "portable_text_too_complex",
				message: "The markup has a tag with more than 1000 attributes",
			},
		];
		expect(convert(tag(1001)).errors).toEqual(tooMany);
		expect(convert(`</p ${"b ".repeat(1001)}>`).errors).toEqual(tooMany);
		// Attributes in a comment, raw text or CDATA are not counted.
		const names = "b ".repeat(1001);
		expect(convert(`<!-- <p ${names}> -->x`).errors).toEqual([]);
		expect(convert(`<script><p ${names}></script>x`).errors).toEqual([]);
		expect(convert(`<svg><![CDATA[<p ${names}>]]></svg>x`).errors).toEqual([]);
		// About 95,000 distinct names on one tag, also after markup that hides a tag from a scan.
		let attributes = "";
		for (let i = 0; attributes.length < 480 * 1024; i++) attributes += ` ${i.toString(36)}`;
		const many = `<p${attributes}>x</p>`;
		const inputs: [string, PortableTextFormat][] = [
			[many, "html"],
			[many, "markdown"],
			...[
				`<!-->${many}<!---->`,
				`<!--->${many}<!---->`,
				`<!-- a --!>${many}<!---->`,
				`<script><x a="</script>${many}`,
				`<style><x a='</style>${many}`,
				`<textarea><x a="</textarea>${many}`,
				`<title><x a="</title>${many}`,
				`<svg><![CDATA[<x a="]]></svg>${many}`,
				`<?x a="?>${many}`,
				`</ x a=">${many}`,
				`<p a=<b${attributes}>x`,
				`<p${attributes.replace(/ /g, "/")}>x`,
			].map((html): [string, PortableTextFormat] => [html, "html"]),
			[`<script><x a="</script>\n\n${many}\n`, "markdown"],
			[`<!-->\n${many}\n<!---->\n`, "markdown"],
		];
		for (const [text, format] of inputs) {
			const started = performance.now();
			expect(convert(text, { format }).errors, text.slice(0, 40)).toEqual(tooMany);
			expect(performance.now() - started).toBeLessThan(5000);
		}
	});

	it("stays fast at the limits", () => {
		const cases: [string, PortableTextFormat][] = [
			[sized("</p>", "<div>".repeat(255))(LIMIT), "html"],
			[sized("<li>", "<div>".repeat(255))(LIMIT), "html"],
			[sized("</p>", "<ul><li>".repeat(127))(LIMIT), "html"],
			[sized("<p>Some <b>bold</b> and <a href='/x'>a link</a>.</p>")(LIMIT), "html"],
			[`${">".repeat(5000)} a`, "markdown"],
			// 700 nested list levels: about 490 KB.
			[Array.from({ length: 700 }, (_, i) => `${"  ".repeat(i)}- item`).join("\n"), "markdown"],
		];
		for (const [text, format] of cases) {
			const started = performance.now();
			expect(convert(text, { format }).errors).toEqual([]);
			expect(performance.now() - started).toBeLessThan(5000);
		}
	});

	it("stays linear: four times the input takes less than eight times as long", () => {
		const cases: [string, (bytes: number) => string, PortableTextFormat][] = [
			["one row of cells", sized("<td>a", "<table><tr>"), "html"],
			["line breaks", sized("<br>", "x"), "html"],
			["words and line breaks", sized("a <br>"), "html"],
			["distinct links in one block", distinct((i) => `<a href="#${i}">x</a>`), "html"],
			["paragraphs", sized("<p>x</p>"), "html"],
			["formatting and paragraphs", sized("<b><p>x</b>"), "html"],
			["emphasis openers", sized("*a "), "markdown"],
			["underscore openers", sized("_a "), "markdown"],
			["brackets", sized("["), "markdown"],
			["link openers", sized("[a]("), "markdown"],
			["strong openers", sized("**a "), "markdown"],
			["thematic breaks", sized("***\n"), "markdown"],
			[
				"a table row",
				(bytes) => {
					const cells = Math.floor(bytes / 4) - 2;
					return `|${"a|".repeat(cells)}\n|${"-|".repeat(cells)}\n`;
				},
				"markdown",
			],
		];
		for (const [name, make, format] of cases) {
			const time = (bytes: number) => {
				const text = make(bytes);
				let best = Number.POSITIVE_INFINITY;
				for (let run = 0; run < 3; run++) {
					const started = performance.now();
					expect(convert(text, { format }).errors, name).toEqual([]);
					best = Math.min(best, performance.now() - started);
				}
				expect(best, name).toBeLessThan(5000);
				return best;
			};
			const small = time(LIMIT / 4);
			const large = time(LIMIT);
			// Below 10 ms, timer noise dominates the ratio.
			expect(large / Math.max(small, 10), name).toBeLessThan(8);
		}
	}, 120_000);
});

describe("parseHtml", () => {
	/** A node as text: names, namespaces, attributes, children, template content and parents. */
	function dump(node: DefaultTreeAdapterTypes.Node, parent: unknown, out: string[]): void {
		if (parent !== undefined && "parentNode" in node && node.parentNode !== parent) {
			out.push(`parent mismatch at ${node.nodeName}`);
		}
		if (node.nodeName === "#text") {
			out.push(`T${JSON.stringify((node as DefaultTreeAdapterTypes.TextNode).value)}`);
			return;
		}
		if (node.nodeName === "#comment") {
			out.push(`C${JSON.stringify((node as DefaultTreeAdapterTypes.CommentNode).data)}`);
			return;
		}
		const element = node as DefaultTreeAdapterTypes.Element;
		out.push(
			`<${node.nodeName} ${element.namespaceURI ?? ""} ${JSON.stringify(element.attrs ?? [])}`,
		);
		for (const child of (node as DefaultTreeAdapterTypes.ParentNode).childNodes) {
			dump(child, node, out);
		}
		const content = (node as DefaultTreeAdapterTypes.Template).content;
		if (content !== undefined) {
			out.push("[content");
			for (const child of content.childNodes) dump(child, content, out);
			out.push("]");
		}
		out.push(">");
	}
	const tree = (fragment: DefaultTreeAdapterTypes.DocumentFragment) => {
		const out: string[] = [];
		dump(fragment, undefined, out);
		return out.join("|");
	};

	it("builds the same tree as parseFragment", () => {
		const corpus = [
			"",
			"x",
			"<p>a<p>b",
			"<table><tr><td>a<td>b</table>",
			"<table><b>x</b><tr><td>y</table>z",
			"<table>text<tr>",
			"<p>1<table><tr><td>2</p>3</table>",
			"<b><table><td></b><i></table>X",
			"<b><i>a<p>b</i>c</b>d",
			"<a href=1>x<div>y</a>z</div>",
			"<a><p><a>x</a></p></a>",
			"<p><b><i><u>a</p><p>b</p>",
			"<b>x<div><i>y<div>z</b>w</i>v</div></div>",
			"<a>1<a>2<a>3",
			"<nobr>a<nobr>b",
			"<em><div><em>x</div></em>y",
			"<template><tr><td>x</td></tr></template><p>y",
			"<template><template><b>z</template></template>",
			"<svg><foreignObject><p>a</p></foreignObject><desc><b>x</b></desc></svg><math><mi>x</mi><mtext><b>y</b></mtext></math>",
			"<svg><![CDATA[<b>x</b>]]></svg>t",
			"<select><option>a<option>b</select><input>",
			"<ul><li>a<li>b<ul><li>c</ul></ul>",
			"<dl><dt>a<dd>b<dt>c</dl>",
			"<pre>\nx</pre><textarea>\ny</textarea>",
			"<!-- c --><p>a<!-- d -->b",
			"<ruby>a<rb>b<rt>c<rp>d</ruby>",
			"<p a=1 a=2 b>dup</p>",
			"<hr>".repeat(300),
			"<b><p>x</b>".repeat(300),
			"<a><p>".repeat(100),
			"<td>a".repeat(300),
		];
		// Random tag soup, from a fixed seed.
		const tags = ["b", "i", "a", "p", "div", "table", "tr", "td", "li", "ul", "font", "nobr"];
		const more = ["template", "svg", "math", "select", "option", "pre", "h1", "form", "caption"];
		const all = [...tags, ...more];
		let seed = 7;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let k = 0; k < 500; k++) {
			let html = "";
			for (let j = 3 + random(25); j > 0; j--) {
				const r = random(6);
				const tag = all[random(all.length)];
				html += r < 3 ? `<${tag}>` : r < 5 ? `</${tag}>` : "x";
			}
			corpus.push(html);
		}
		for (const html of corpus) {
			expect(tree(parseHtml(html)), html).toBe(tree(parseFragment(html)));
		}
	});
});

describe("convertPortableText: Markdown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders CommonMark with tables and strikethrough through the HTML rules", () => {
		const converted = markdown(
			"# H1\n\nSome *em* **strong** ~~del~~ `code` [link](https://x.test) ![alt](https://x.test/i.png)\n\n- a\n  - b\n\n1. n\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>raw <script>x</script></div>\n\n- [ ] task\n",
		);
		expect(outline(converted)).toEqual([
			"h1: H1",
			"normal: Some em strong del code link",
			"image #0",
			"normal bullet 1: a",
			"normal bullet 2: b",
			"normal number 1: n",
			"blockquote: q",
			"normal: a | b",
			"normal: 1 | 2",
			"normal: raw",
			"normal bullet 1: [ ] task",
		]);
		expect(converted.draft?.blocks[1]?.children).toEqual([
			span("b1s0", "Some "),
			span("b1s1", "em", ["em"]),
			span("b1s2", " "),
			span("b1s3", "strong", ["strong"]),
			span("b1s4", " "),
			span("b1s5", "del", ["strike-through"]),
			span("b1s6", " "),
			span("b1s7", "code", ["code"]),
			span("b1s8", " "),
			span("b1s9", "link", ["b1l0"]),
		]);
		expect(converted.draft?.images).toEqual([{ url: "https://x.test/i.png", alt: "alt" }]);
		expect(converted.warnings).toEqual([
			{ code: "unknown_markup", message: "Kept the text of 1 <table> element" },
			{ code: "removed_markup", message: "Removed 1 <script> element" },
		]);
	});

	it("fails the record, not the batch, when a parser throws", () => {
		vi.spyOn(MarkdownIt.prototype, "render").mockImplementation(() => {
			throw new RangeError("Maximum call stack size exceeded");
		});
		expect(markdown("# a")).toEqual({
			draft: null,
			errors: [
				{
					code: "portable_text_failed",
					message: "The Markdown could not be converted: Maximum call stack size exceeded",
				},
			],
			warnings: [],
		});
	});
});
