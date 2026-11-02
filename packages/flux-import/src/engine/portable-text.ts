/**
 * Portable Text from HTML, Markdown or plain text (M4d). HTML is parsed with `parse5` and walked
 * without recursion into the blocks and marks EmDash's editor writes. Markdown is rendered to
 * HTML by `markdown-it` first, so both share one set of rules. Markup the converter does not know
 * keeps its text and is reported; active content is removed and reported. Each image becomes a
 * slot that resolution turns into an image block referencing a Media Library item.
 */
import MarkdownIt from "markdown-it";
import {
	type DefaultTreeAdapterMap,
	type DefaultTreeAdapterTypes,
	defaultTreeAdapter,
	parseFragment,
	type TreeAdapter,
} from "parse5";
import { MAX_ALT_LENGTH, normalizeMediaUrl } from "./media.js";
import type { JsonValue } from "./values.js";

/** `portableText` mappings a template may have, so a record converts at most this many. */
export const MAX_PORTABLE_TEXT_MAPPINGS = 3;
/** The source text of one field, in UTF-8 bytes. */
export const MAX_PORTABLE_TEXT_SOURCE_BYTES = 512 * 1024;
/** The HTML `markdown-it` renders for one field, in UTF-8 bytes. */
export const MAX_RENDERED_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** The open elements `parse5` may hold at once: its work grows with this depth squared. */
export const MAX_PORTABLE_TEXT_NESTING = 256;
/** The Portable Text JSON of one record, over every mapped field, in UTF-8 bytes. */
export const MAX_PORTABLE_TEXT_RECORD_BYTES = 1024 * 1024;
/** Distinct image URLs in one record's Portable Text. */
export const MAX_PORTABLE_TEXT_IMAGES = 50;
export const MAX_LIST_LEVEL = 6;
export const MAX_CAPTION_LENGTH = 1000;
/** The longest `href` kept. */
export const MAX_HREF_LENGTH = 2048;
/** Attributes on one tag: `parse5` checks each new name against all earlier ones. */
export const MAX_TAG_ATTRIBUTES = 1000;

export type PortableTextFormat = "html" | "markdown" | "text";

/** A `portableText` mapping's options, with their defaults filled in. */
export type PortableTextOptions = {
	format: PortableTextFormat;
	/** An absolute http(s) URL that relative `href` and `src` resolve against; null without one. */
	baseUrl: string | null;
	images: "import" | "skip";
	imageErrors: "drop" | "fail";
	unknownMarkup: "warn" | "fail";
};

export type PortableTextCode =
	| "unknown_markup"
	| "removed_markup"
	| "link_dropped"
	| "alt_truncated"
	| "image_dropped"
	| "invalid_media_url"
	| "portable_text_too_large"
	| "portable_text_too_complex"
	| "portable_text_limit"
	| "portable_text_failed";

export type PortableTextIssue = { code: PortableTextCode; message: string };

/** One distinct image URL of a field; slots index into the field's list. */
export type PortableTextImage = {
	/** Normalized (`normalizeMediaUrl`), the media map key's input. */
	url: string;
	/** The alt of the URL's first image, the library default for a new item. */
	alt: string | null;
};

/** A Portable Text block as JSON; an image block holds `slot` until resolution gives it `asset`. */
export type DraftBlock = { [key: string]: JsonValue };

/** One field's converted value before its images are resolved. */
export type PortableTextDraft = {
	blocks: DraftBlock[];
	images: PortableTextImage[];
};

/** A conversion: the draft (null when empty), and what to report. Any error fails the record. */
export type PortableTextConverted = {
	draft: PortableTextDraft | null;
	errors: PortableTextIssue[];
	warnings: PortableTextIssue[];
};

/** The Markdown dialect: CommonMark with tables and strikethrough, raw HTML through our rules. */
const markdown = new MarkdownIt("commonmark", {
	html: true,
	linkify: false,
	typographer: false,
}).enable(["table", "strikethrough"]);

/** Thrown inside `parse5` when the open-element stack grows past the limit. */
class TooComplex extends Error {}

/**
 * The default tree adapter with a count of open elements: the parse stops as soon as more than
 * `MAX_PORTABLE_TEXT_NESTING` are open, which bounds `parse5`'s quadratic scope checks.
 * `onItemPush` and `onItemPop` are part of parse5's `TreeAdapter` interface.
 *
 * `getFirstChild` and `detachNode` make moving all of a node's children linear: `parse5` calls
 * `getFirstChild` only to move every child out, first to last (the fragment's top-level nodes,
 * and the adoption agency's furthest block), and the default `detachNode` splices each one off
 * the front, which is quadratic. Here a parent being emptied keeps its moved-out children until
 * the last one goes, and `getFirstChild` skips them.
 */
function nestingGuard(): TreeAdapter<DefaultTreeAdapterMap> {
	let open = 0;
	/** Parents being emptied by `getFirstChild` and `detachNode`, with the children moved out. */
	const moved = new Map<DefaultTreeAdapterTypes.ParentNode, number>();
	return {
		...defaultTreeAdapter,
		onItemPush() {
			// The fragment parser's own root element is the first push.
			open++;
			if (open > MAX_PORTABLE_TEXT_NESTING + 1) throw new TooComplex();
		},
		onItemPop() {
			open--;
		},
		getFirstChild(node) {
			const head = moved.get(node) ?? 0;
			const child = node.childNodes[head];
			if (child === undefined) {
				if (head > 0) node.childNodes.length = 0;
				moved.delete(node);
				return null;
			}
			moved.set(node, head);
			return child;
		},
		detachNode(node) {
			const parent = node.parentNode;
			const head = parent === null ? undefined : moved.get(parent);
			if (parent === null || head === undefined) {
				defaultTreeAdapter.detachNode(node);
				return;
			}
			if (parent.childNodes[head] === node) {
				moved.set(parent, head + 1);
				node.parentNode = null;
				return;
			}
			// Not a move from the front: drop the moved-out children for real first.
			parent.childNodes.splice(0, head);
			moved.delete(parent);
			defaultTreeAdapter.detachNode(node);
		},
	};
}

const isTagSpace = (code: number) =>
	code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
const isAsciiLetter = (code: number) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;

/**
 * Whether some tag has more than `MAX_TAG_ATTRIBUTES` attributes, by a linear scan that follows
 * the HTML tokenizer's tag states closely enough to count attribute names outside quoted values.
 * Comments are skipped; text inside raw-text elements may be counted, which can only refuse more.
 */
function tooManyAttributes(html: string): boolean {
	const n = html.length;
	let i = 0;
	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt === -1) return false;
		i = lt + 1;
		if (html.startsWith("!--", i)) {
			const close = html.indexOf("-->", i + 3);
			if (close === -1) return false;
			i = close + 3;
			continue;
		}
		if (html.charCodeAt(i) === 0x2f) i++; // end tags are tokenized with attributes too
		if (!isAsciiLetter(html.charCodeAt(i))) continue;
		// The tag name.
		while (i < n && !isTagSpace(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">") i++;
		let count = 0;
		while (i < n && html[i] !== ">") {
			const c = html[i] as string;
			if (isTagSpace(html.charCodeAt(i)) || c === "/") {
				i++;
				continue;
			}
			// An attribute name: its first character may be "=", the rest stops at "=".
			count++;
			if (count > MAX_TAG_ATTRIBUTES) return true;
			i++;
			while (i < n && !isTagSpace(html.charCodeAt(i)) && !"/>=".includes(html[i] as string)) i++;
			while (i < n && isTagSpace(html.charCodeAt(i))) i++;
			if (html[i] !== "=") continue;
			i++;
			while (i < n && isTagSpace(html.charCodeAt(i))) i++;
			const quote = html[i];
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, i + 1);
				if (close === -1) return false;
				i = close + 1;
			} else {
				while (i < n && !isTagSpace(html.charCodeAt(i)) && html[i] !== ">") i++;
			}
		}
	}
	return false;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** Whether `text` is over `limit` UTF-8 bytes; every UTF-16 unit is at least one byte. */
function overBytes(text: string, limit: number): boolean {
	return text.length > limit || utf8Bytes(text) > limit;
}

const KIB = 1024;

/**
 * Converts one source value. A missing value, `null`, blank text, or markup that leaves no block
 * is empty (`draft: null`). Anything but text fails `not_scalar` in `applyTemplate` before this
 * runs. Errors from the parsers (a `RangeError` among them) fail `portable_text_failed`.
 */
export function convertPortableText(
	text: string,
	options: PortableTextOptions,
): PortableTextConverted {
	const fail = (code: PortableTextCode, message: string): PortableTextConverted => ({
		draft: null,
		errors: [{ code, message }],
		warnings: [],
	});
	if (overBytes(text, MAX_PORTABLE_TEXT_SOURCE_BYTES)) {
		return fail(
			"portable_text_too_large",
			`The text is larger than ${MAX_PORTABLE_TEXT_SOURCE_BYTES / KIB} KiB`,
		);
	}
	if (options.format === "text") return { draft: textDraft(text), errors: [], warnings: [] };
	let html = text;
	try {
		if (options.format === "markdown") html = markdown.render(text);
	} catch (e) {
		return fail("portable_text_failed", `The Markdown could not be converted: ${errorText(e)}`);
	}
	if (overBytes(html, MAX_RENDERED_MARKDOWN_BYTES)) {
		return fail(
			"portable_text_too_large",
			`The Markdown renders to more than ${MAX_RENDERED_MARKDOWN_BYTES / KIB / KIB} MiB of HTML`,
		);
	}
	if (tooManyAttributes(html)) {
		return fail(
			"portable_text_too_complex",
			`The markup has a tag with more than ${MAX_TAG_ATTRIBUTES} attributes`,
		);
	}
	let fragment: DefaultTreeAdapterTypes.DocumentFragment;
	try {
		fragment = parseFragment(html, { treeAdapter: nestingGuard() });
	} catch (e) {
		if (e instanceof TooComplex) {
			return fail(
				"portable_text_too_complex",
				`The markup nests more than ${MAX_PORTABLE_TEXT_NESTING} elements deep`,
			);
		}
		return fail("portable_text_failed", `The HTML could not be parsed: ${errorText(e)}`);
	}
	try {
		return new Walker(options).run(fragment);
	} catch (e) {
		return fail("portable_text_failed", `The HTML could not be converted: ${errorText(e)}`);
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Plain text: paragraphs split on blank lines, single line breaks kept as `\n`. */
function textDraft(text: string): PortableTextDraft | null {
	const paragraphs = text
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	if (paragraphs.length === 0) return null;
	const blocks = paragraphs.map((p, i): DraftBlock => {
		const key = `b${i}`;
		return {
			_type: "block",
			_key: key,
			style: "normal",
			children: [{ _type: "span", _key: `${key}s0`, text: p, marks: [] }],
		};
	});
	return { blocks, images: [] };
}

/** Inline elements whose decorator EmDash's editor accepts (spec F9). */
const DECORATORS: Readonly<Record<string, string>> = {
	strong: "strong",
	b: "strong",
	em: "em",
	i: "em",
	u: "underline",
	s: "strike-through",
	strike: "strike-through",
	del: "strike-through",
	code: "code",
	sub: "subscript",
	sup: "superscript",
};
const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Kept as text without a warning; block containers end the current paragraph. */
const TRANSPARENT_BLOCK: ReadonlySet<string> = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"footer",
	"aside",
	"nav",
	"address",
	"figure",
	"figcaption",
	"center",
	"html",
	"body",
]);
const TRANSPARENT_INLINE: ReadonlySet<string> = new Set([
	"span",
	"font",
	"small",
	"mark",
	"ins",
	"abbr",
	"cite",
	"q",
	"dfn",
	"kbd",
	"samp",
	"var",
	"time",
	"data",
	"bdi",
	"bdo",
	"wbr",
	"picture",
]);
/** Active content: removed with everything inside it. */
const REMOVED: ReadonlySet<string> = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"frame",
	"object",
	"embed",
	"video",
	"audio",
	"canvas",
	"svg",
	"math",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"link",
	"meta",
	"base",
	// Their content is raw text that would otherwise show as markup source.
	"noembed",
	"noframes",
	"xmp",
	"plaintext",
	"title",
]);
/** Unknown elements that hold lines of text: each becomes a paragraph. */
const UNKNOWN_LINES: ReadonlySet<string> = new Set([
	"tr",
	"dt",
	"dd",
	"caption",
	"summary",
	"legend",
]);
/** Unknown elements that end the current paragraph. */
const UNKNOWN_BLOCKS: ReadonlySet<string> = new Set([
	"table",
	"thead",
	"tbody",
	"tfoot",
	"colgroup",
	"dl",
	"details",
	"fieldset",
	"hgroup",
	"menu",
	"dialog",
	"search",
]);
/** Parts of a reported element (a table's rows, a list's terms): not reported themselves. */
const PARTS: ReadonlySet<string> = new Set([
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"caption",
	"colgroup",
	"col",
	"dt",
	"dd",
	"summary",
	"legend",
	"source",
]);

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type LinkTarget = { href: string; blank: boolean };

/** What a new text block starts as, where text arrives. */
type BlockContext = {
	style: string;
	listItem?: "bullet" | "number";
	level?: number;
	/** A list item, row or term: inner paragraphs join with `\n` instead of ending the block. */
	line?: boolean;
	/** Table rows: the cells seen so far. */
	cells?: number;
};

/**
 * A span being built: its text as pieces (never empty strings) joined when the block ends, so
 * appending and trimming the end never rescan or copy the whole text.
 */
type SpanDraft = { parts: string[]; decorators: readonly string[]; link: number | null };
type TextDraft = {
	context: BlockContext;
	spans: SpanDraft[];
	links: LinkTarget[];
	/** Each link's index in `links`, by `blank` flag and `href`. */
	linkIndexes: Map<string, number>;
	/** Whether the block has text besides HTML whitespace and line breaks. */
	hasText: boolean;
};
type SpanText = { text: string; decorators: readonly string[]; link: number | null };
type TextOut = { context: BlockContext; spans: SpanText[]; links: LinkTarget[] };
type Out =
	| { kind: "text"; block: TextOut }
	| { kind: "code"; code: string; language: string | null }
	| { kind: "break" }
	| {
			kind: "image";
			slot: number;
			alt: string | null;
			caption: string | null;
			link: LinkTarget | null;
	  };

/** What an element's exit restores and finishes. */
type Exit = {
	element: Element;
	contexts: number;
	lists: number;
	decorators: number;
	links: number;
	/** The element ended the current block when it started, and ends it again. */
	block: boolean;
	/** The element is a paragraph inside a line: the next text starts on a new line. */
	join: boolean;
	figure: boolean;
};

type Frame = { node: ChildNode } | { exit: Exit };

const WHITESPACE = /[\t\n\f\r ]+/g;
const LANGUAGE = /(?:^|\s)lang(?:uage)?-([A-Za-z0-9_+#.-]{1,40})(?=\s|$)/;

function attr(element: Element, name: string): string | null {
	return element.attrs.find((a) => a.name === name)?.value ?? null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** A URL as messages show it: at most 200 characters. */
export function shownUrl(url: string): string {
	return url.length > 200 ? `${url.slice(0, 199)}…` : url;
}
/** A tag name as messages show it. */
const shownTag = (tag: string) => (tag.length > 40 ? `${tag.slice(0, 39)}…` : tag);

/** One field's HTML, walked into blocks with an explicit stack. */
class Walker {
	private readonly out: Out[] = [];
	private open: TextDraft | null = null;
	/** Text to put before the next text of the open block: `\n` or a cell separator. */
	private pending: string | null = null;
	private readonly contexts: BlockContext[] = [{ style: "normal" }];
	private readonly lists: ("bullet" | "number")[] = [];
	private readonly decorators: string[] = [];
	private readonly links: (LinkTarget | null)[] = [];
	/** Open figures; `nested` when one holds another figure, so its caption stays a paragraph. */
	private readonly figures: { images: number[]; caption: string; nested: boolean }[] = [];
	private readonly images: PortableTextImage[] = [];
	private readonly slots = new Map<string, number>();
	private readonly base: URL | null;
	private readonly unknown = new Map<string, number>();
	readonly removed = new Map<string, number>();
	private readonly dropped = new Map<string, number>();
	private altCut = 0;
	/** Images inside `pre` or `figcaption`, which hold only text. */
	imagesInText = 0;
	private readonly imageIssues: PortableTextIssue[] = [];

	constructor(private readonly options: PortableTextOptions) {
		this.base = options.baseUrl === null ? null : new URL(options.baseUrl);
	}

	run(fragment: DefaultTreeAdapterTypes.DocumentFragment): PortableTextConverted {
		const stack: Frame[] = fragment.childNodes.map((node) => ({ node })).reverse();
		for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
			if ("exit" in frame) this.leave(frame.exit);
			else this.enter(frame.node, stack);
		}
		this.flush();
		return this.result();
	}

	private get context(): BlockContext {
		return this.contexts[this.contexts.length - 1] as BlockContext;
	}

	private enter(node: ChildNode, stack: Frame[]): void {
		if (node.nodeName === "#text") {
			this.text((node as DefaultTreeAdapterTypes.TextNode).value);
			return;
		}
		if (!("tagName" in node)) return; // comments and doctypes
		const element = node as Element;
		const tag = element.tagName;
		if (REMOVED.has(tag)) {
			this.count(this.removed, tag);
			return;
		}
		if (this.leaf(element)) return;
		const exit: Exit = {
			element,
			contexts: this.contexts.length,
			lists: this.lists.length,
			decorators: this.decorators.length,
			links: this.links.length,
			block: false,
			join: false,
			figure: false,
		};
		const decorator = DECORATORS[tag];
		if (decorator !== undefined) this.decorators.push(decorator);
		else if (tag === "a") this.links.push(this.link(element));
		else if (HEADINGS.has(tag)) {
			this.flush();
			exit.block = true;
			this.contexts.push({ style: tag });
		} else if (tag === "blockquote") {
			this.flush();
			exit.block = true;
			this.contexts.push({ style: "blockquote" });
		} else if (tag === "ul" || tag === "ol") {
			this.flush();
			exit.block = true;
			this.lists.push(tag === "ul" ? "bullet" : "number");
		} else if (tag === "li") {
			this.flush();
			exit.block = true;
			this.contexts.push({
				style: "normal",
				listItem: this.lists[this.lists.length - 1] ?? "bullet",
				level: Math.min(Math.max(this.lists.length, 1), MAX_LIST_LEVEL),
				line: true,
			});
		} else if (TRANSPARENT_BLOCK.has(tag)) {
			if (tag === "figure") {
				const parent = this.figures[this.figures.length - 1];
				if (parent) parent.nested = true;
				this.figures.push({ images: [], caption: "", nested: false });
				exit.figure = true;
			}
			if (this.context.line) {
				exit.join = true;
				if (this.open !== null) this.pending = "\n";
			} else {
				this.flush();
				exit.block = true;
			}
		} else if (TRANSPARENT_INLINE.has(tag)) {
			// Kept as text, silently: `picture`'s `source` elements are dropped below as parts.
		} else {
			if (!PARTS.has(tag)) this.count(this.unknown, tag);
			if (UNKNOWN_LINES.has(tag)) {
				this.flush();
				exit.block = true;
				this.contexts.push({ style: "normal", line: true, cells: 0 });
			} else if (tag === "td" || tag === "th") {
				const row = this.context;
				if (row.cells !== undefined) {
					if (row.cells > 0 && this.open !== null) this.pending = " | ";
					row.cells++;
				}
			} else if (UNKNOWN_BLOCKS.has(tag)) {
				this.flush();
				exit.block = true;
			}
		}
		stack.push({ exit });
		for (let i = element.childNodes.length - 1; i >= 0; i--) {
			stack.push({ node: element.childNodes[i] as ChildNode });
		}
	}

	/** Elements converted without walking their children; true when `element` is one. */
	private leaf(element: Element): boolean {
		switch (element.tagName) {
			case "br":
				this.lineBreak();
				return true;
			case "hr":
				this.flush();
				this.out.push({ kind: "break" });
				return true;
			case "img":
				this.image(element);
				return true;
			case "pre":
				this.pre(element);
				return true;
			case "figcaption":
				if (this.figures.length === 0) return false;
				this.caption(element);
				return true;
			default:
				return false;
		}
	}

	private leave(exit: Exit): void {
		if (exit.block) this.flush();
		if (exit.join && this.open !== null) this.pending = "\n";
		this.contexts.length = exit.contexts;
		this.lists.length = exit.lists;
		this.decorators.length = exit.decorators;
		this.links.length = exit.links;
		if (exit.figure) this.endFigure();
	}

	private count(counts: Map<string, number>, key: string): void {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	/** Appends text with the current marks, collapsing HTML whitespace. */
	private text(value: string): void {
		let text = value.replace(WHITESPACE, " ");
		if (this.open === null) {
			text = text.replace(/^ /, "");
			if (text === "") return;
			this.open = {
				context: this.context,
				spans: [],
				links: [],
				linkIndexes: new Map(),
				hasText: false,
			};
		}
		const block = this.open;
		if (this.pending !== null && block.hasText) {
			this.trimEnd(block);
			this.append(block, this.pending, [], null);
			text = text.replace(/^ /, "");
		}
		this.pending = null;
		const last = lastChar(block.spans[block.spans.length - 1]);
		if (last === "" || last === " " || last === "\n") text = text.replace(/^ /, "");
		if (text === "") return;
		const link = this.links[this.links.length - 1] ?? null;
		this.append(block, text, this.decorators, link === null ? null : this.linkIndex(block, link));
	}

	private append(
		block: TextDraft,
		text: string,
		decorators: readonly string[],
		link: number | null,
	): void {
		if (!block.hasText && /[^ \n]/.test(text)) block.hasText = true;
		const marks = [...new Set(decorators)];
		const last = block.spans[block.spans.length - 1];
		// The editor ends a span at each hard break, so text after one starts a new span.
		const joins = last && lastChar(last) !== "\n" && last.link === link;
		if (joins && sameList(last.decorators, marks)) last.parts.push(text);
		else block.spans.push({ parts: [text], decorators: marks, link });
	}

	private trimEnd(block: TextDraft): void {
		const last = block.spans[block.spans.length - 1];
		if (last) trimSpaces(last);
	}

	private linkIndex(block: TextDraft, link: LinkTarget): number {
		const id = `${link.blank ? 1 : 0}${link.href}`;
		const known = block.linkIndexes.get(id);
		if (known !== undefined) return known;
		block.links.push(link);
		block.linkIndexes.set(id, block.links.length - 1);
		return block.links.length - 1;
	}

	/** A `br`: `\n` at the end of the previous span, where EmDash's editor puts a hard break. */
	private lineBreak(): void {
		const last = this.open?.spans[this.open.spans.length - 1];
		if (last === undefined) return;
		this.pending = null;
		trimSpaces(last);
		last.parts.push("\n");
	}

	/** Ends the open text block, keeping it when it has text. */
	private flush(): void {
		const block = this.open;
		this.open = null;
		this.pending = null;
		if (block === null) return;
		const spans = trimSpans(block.spans);
		if (spans.length > 0) {
			this.out.push({ kind: "text", block: { context: block.context, spans, links: block.links } });
		}
	}

	/** The link of an `a` element with `href`, or null: no `href`, or one that is dropped. */
	private link(element: Element): LinkTarget | null {
		const raw = attr(element, "href");
		if (raw === null) return null;
		const href = safeHref(raw, this.base);
		if (!href.ok) {
			this.count(this.dropped, href.reason);
			return null;
		}
		return { href: href.href, blank: attr(element, "target")?.trim().toLowerCase() === "_blank" };
	}

	private pre(element: Element): void {
		this.flush();
		let code = textOf(element, true, this);
		if (code.startsWith("\n")) code = code.slice(1);
		if (code.trim() === "") return;
		const inner = element.childNodes.find(
			(n): n is Element => "tagName" in n && n.tagName === "code",
		);
		const classes = `${attr(element, "class") ?? ""} ${inner ? (attr(inner, "class") ?? "") : ""}`;
		const language = LANGUAGE.exec(classes)?.[1] ?? null;
		this.out.push({ kind: "code", code, language });
	}

	private caption(element: Element): void {
		const figure = this.figures[this.figures.length - 1];
		const text = textOf(element, false, this);
		if (figure) figure.caption = figure.caption === "" ? text : `${figure.caption} ${text}`;
	}

	/** A figure's caption goes to its one image; with none or several, it is a paragraph. */
	private endFigure(): void {
		const figure = this.figures.pop();
		if (!figure || figure.caption === "") return;
		const caption = figure.caption.slice(0, MAX_CAPTION_LENGTH);
		const one = figure.images.length === 1 && !figure.nested;
		const only = one ? this.out[figure.images[0] as number] : undefined;
		if (only?.kind === "image" && only.caption === null) {
			only.caption = caption;
			return;
		}
		this.flush();
		this.text(figure.caption);
		this.flush();
	}

	private image(element: Element): void {
		if (this.options.images === "skip") return;
		const src = attr(element, "src")?.trim() ?? "";
		const lazy = attr(element, "data-src")?.trim() ?? "";
		const raw = (src === "" || /^data:/i.test(src)) && lazy !== "" ? lazy : src;
		if (raw === "") return;
		const resolved = imageUrl(raw, this.base);
		if (!resolved.ok) {
			const message = `${shownUrl(raw)}: ${resolved.message}`;
			this.imageIssues.push(
				this.options.imageErrors === "fail"
					? { code: "invalid_media_url", message }
					: { code: "image_dropped", message: `invalid_media_url: ${message}` },
			);
			return;
		}
		this.flush();
		let alt = attr(element, "alt")?.trim() ?? "";
		if (alt.length > MAX_ALT_LENGTH) {
			alt = alt.slice(0, MAX_ALT_LENGTH);
			this.altCut++;
		}
		let slot = this.slots.get(resolved.url);
		if (slot === undefined) {
			slot = this.images.length;
			this.slots.set(resolved.url, slot);
			this.images.push({ url: resolved.url, alt: alt === "" ? null : alt });
		}
		const link = this.links[this.links.length - 1] ?? null;
		this.figures[this.figures.length - 1]?.images.push(this.out.length);
		this.out.push({ kind: "image", slot, alt: alt === "" ? null : alt, caption: null, link });
	}

	private result(): PortableTextConverted {
		const errors: PortableTextIssue[] = [];
		const warnings: PortableTextIssue[] = [];
		const markup = this.options.unknownMarkup === "fail" ? errors : warnings;
		for (const [tag, n] of this.unknown) {
			markup.push({
				code: "unknown_markup",
				message: `Kept the text of ${plural(n, `<${shownTag(tag)}> element`)}`,
			});
		}
		for (const [tag, n] of this.removed) {
			markup.push({
				code: "removed_markup",
				message: `Removed ${plural(n, `<${shownTag(tag)}> element`)}`,
			});
		}
		for (const [reason, n] of this.dropped) {
			markup.push({
				code: "link_dropped",
				message: `Kept the text of ${plural(n, "link")} without the address: ${reason}`,
			});
		}
		if (this.altCut > 0) {
			warnings.push({
				code: "alt_truncated",
				message: `Cut the alt text of ${plural(this.altCut, "image")} to ${MAX_ALT_LENGTH} characters`,
			});
		}
		if (this.imagesInText > 0 && this.options.images === "import") {
			warnings.push({
				code: "image_dropped",
				message: `Left out ${plural(this.imagesInText, "image")} inside <pre> or <figcaption>, which hold only text`,
			});
		}
		for (const issue of this.imageIssues) {
			(issue.code === "image_dropped" ? warnings : errors).push(issue);
		}
		const blocks = this.blocks();
		return {
			draft: blocks.length === 0 ? null : { blocks, images: this.images },
			errors,
			warnings,
		};
	}

	/** The blocks as JSON, with deterministic keys: `b<n>`, `b<n>s<m>`, `b<n>l<m>`. */
	private blocks(): DraftBlock[] {
		return this.out.map((out, i): DraftBlock => {
			const key = `b${i}`;
			if (out.kind === "text") return textBlock(out.block, key);
			if (out.kind === "break") return { _type: "break", _key: key, style: "lineBreak" };
			if (out.kind === "code") {
				return {
					_type: "code",
					_key: key,
					code: out.code,
					...(out.language === null ? {} : { language: out.language }),
				};
			}
			return {
				_type: "image",
				_key: key,
				slot: out.slot,
				...(out.alt === null ? {} : { alt: out.alt }),
				...(out.caption === null ? {} : { caption: out.caption }),
				...(out.link === null ? {} : { link: linkValue(out.link) }),
			};
		});
	}
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The last character of a span, or "" for none. */
function lastChar(span: SpanDraft | undefined): string {
	const part = span?.parts[span.parts.length - 1];
	return part === undefined ? "" : part.charAt(part.length - 1);
}

/** The end of `text` without trailing characters that `strip` accepts. */
function endWithout(text: string, strip: (code: number) => boolean): number {
	let end = text.length;
	while (end > 0 && strip(text.charCodeAt(end - 1))) end--;
	return end;
}

const isSpace = (code: number) => code === 0x20;
const isSpaceOrNewline = (code: number) => code === 0x20 || code === 0x0a;

/** Removes the span's trailing spaces, looking only at its last pieces. */
function trimSpaces(span: SpanDraft): void {
	for (let part = span.parts.pop(); part !== undefined; part = span.parts.pop()) {
		const end = endWithout(part, isSpace);
		if (end > 0) {
			span.parts.push(end === part.length ? part : part.slice(0, end));
			return;
		}
	}
}

/** Joins each span's pieces, drops the block's leading and trailing whitespace, then empty spans. */
function trimSpans(spans: readonly SpanDraft[]): SpanText[] {
	const out: SpanText[] = spans.map((s) => ({
		text: s.parts.join(""),
		decorators: s.decorators,
		link: s.link,
	}));
	let from = 0;
	while (from < out.length) {
		const first = out[from] as SpanText;
		let start = 0;
		while (start < first.text.length && isSpaceOrNewline(first.text.charCodeAt(start))) start++;
		first.text = first.text.slice(start);
		if (first.text !== "") break;
		from++;
	}
	let to = out.length;
	while (to > from) {
		const last = out[to - 1] as SpanText;
		last.text = last.text.slice(0, endWithout(last.text, isSpaceOrNewline));
		if (last.text !== "") break;
		to--;
	}
	return out.slice(from, to).filter((s) => s.text !== "");
}

function linkValue(link: LinkTarget): { [key: string]: JsonValue } {
	return link.blank ? { href: link.href, blank: true } : { href: link.href };
}

/** A text block in the shape EmDash's editor writes: no empty `markDefs`, spans with `marks`. */
function textBlock(block: TextOut, key: string): DraftBlock {
	// Only links that a kept span uses get a definition, numbered in order of first use.
	const used = new Map<number, string>();
	const markDefs: { [key: string]: JsonValue }[] = [];
	const children = block.spans.map((span, i): { [key: string]: JsonValue } => {
		const marks: string[] = [...span.decorators];
		if (span.link !== null) {
			let def = used.get(span.link);
			if (def === undefined) {
				def = `${key}l${used.size}`;
				used.set(span.link, def);
				markDefs.push({
					_type: "link",
					_key: def,
					...linkValue(block.links[span.link] as LinkTarget),
				});
			}
			marks.push(def);
		}
		return { _type: "span", _key: `${key}s${i}`, text: span.text, marks };
	});
	const { style, listItem, level } = block.context;
	return {
		_type: "block",
		_key: key,
		style,
		...(listItem === undefined ? {} : { listItem, level: level ?? 1 }),
		children,
		...(markDefs.length > 0 ? { markDefs } : {}),
	};
}

/** Where `textOf` reports what it leaves out. */
type TextSink = { removed: Map<string, number>; imagesInText: number };

/**
 * The text of an element's subtree: `br` as a line break, removed elements counted and skipped,
 * images counted and left out.
 */
function textOf(element: Element, preserve: boolean, sink: TextSink): string {
	let text = "";
	const stack: ChildNode[] = [...element.childNodes].reverse();
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.nodeName === "#text") text += (node as DefaultTreeAdapterTypes.TextNode).value;
		else if ("tagName" in node) {
			if (REMOVED.has(node.tagName)) {
				sink.removed.set(node.tagName, (sink.removed.get(node.tagName) ?? 0) + 1);
			} else if (node.tagName === "br") text += "\n";
			else if (node.tagName === "img") sink.imagesInText++;
			else
				for (let i = node.childNodes.length - 1; i >= 0; i--)
					stack.push(node.childNodes[i] as ChildNode);
		}
	}
	return preserve ? text : text.replace(WHITESPACE, " ").replace(/^ | $/g, "");
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A link's `href`, kept when it is a bare `#fragment`, an absolute `http:`, `https:`, `mailto:` or
 * `tel:` URL, or a relative URL resolved against `base`. A protocol-relative URL takes `base`'s
 * scheme, or `https:` without one.
 */
export function safeHref(
	raw: string,
	base: URL | null,
): { ok: true; href: string } | { ok: false; reason: string } {
	const text = raw.trim();
	if (CONTROL.test(text)) return { ok: false, reason: "it contains control characters" };
	if (text.length > MAX_HREF_LENGTH) {
		return { ok: false, reason: `it is longer than ${MAX_HREF_LENGTH} characters` };
	}
	if (text.startsWith("#")) return { ok: true, href: text };
	const scheme = SCHEME.exec(text)?.[1];
	let url: URL;
	try {
		if (scheme !== undefined) url = new URL(text);
		else if (text.startsWith("//")) url = new URL(`${base?.protocol ?? "https:"}${text}`);
		else if (base !== null) url = new URL(text, base);
		else return { ok: false, reason: "a relative address needs the mapping's baseUrl" };
	} catch {
		return { ok: false, reason: "it is not a valid URL" };
	}
	if (!LINK_SCHEMES.has(url.protocol)) {
		return { ok: false, reason: `the scheme ${url.protocol} is not allowed` };
	}
	if (url.href.length > MAX_HREF_LENGTH) {
		return { ok: false, reason: `it is longer than ${MAX_HREF_LENGTH} characters` };
	}
	return { ok: true, href: url.href };
}

/**
 * An image's URL, normalized for the media map: a relative URL resolved against `base`, a
 * protocol-relative one with `base`'s scheme or `https:`, then `normalizeMediaUrl`.
 */
export function imageUrl(
	raw: string,
	base: URL | null,
): { ok: true; url: string } | { ok: false; message: string } {
	let absolute = raw;
	if (raw.startsWith("//")) absolute = `${base?.protocol ?? "https:"}${raw}`;
	else if (!SCHEME.test(raw)) {
		if (base === null) return { ok: false, message: "A relative URL needs the mapping's baseUrl" };
		try {
			absolute = new URL(raw, base).href;
		} catch {
			return { ok: false, message: "The URL is not valid" };
		}
	}
	return normalizeMediaUrl(absolute);
}
