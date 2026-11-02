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
	Parser,
	type TreeAdapter,
} from "parse5";
import { MAX_ALT_LENGTH, normalizeMediaUrl } from "./media.js";
import type { JsonValue } from "./values.js";

/** `portableText` mappings a template may have, so a record converts at most this many. */
export const MAX_PORTABLE_TEXT_MAPPINGS = 3;
/** The HTML or plain source text of one field, in UTF-8 bytes. */
export const MAX_PORTABLE_TEXT_SOURCE_BYTES = 512 * 1024;
/**
 * The Markdown source text of one field, in UTF-8 bytes. Smaller than for HTML: `markdown-it`'s
 * tokens and the HTML it renders take many times the source's memory (512 KiB of `"a\n\n"`
 * exhausted a 128 MB heap in `render` alone).
 */
export const MAX_MARKDOWN_SOURCE_BYTES = 128 * 1024;
/**
 * The source text of all of one record's `portableText` fields together, in UTF-8 bytes, checked
 * before any of them is parsed: the parsed trees of three fields at their own limits do not fit
 * in a Worker's memory.
 */
export const MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES = 512 * 1024;
/** The HTML `markdown-it` renders for one field, in UTF-8 bytes. */
export const MAX_RENDERED_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** The open elements `parse5` may hold at once: its work grows with this depth squared. */
export const MAX_PORTABLE_TEXT_NESTING = 256;
/**
 * The Portable Text JSON of one record, over every mapped field, in UTF-8 bytes. The converter
 * stops as soon as its running estimate passes what earlier fields left of it, so no field builds
 * more than this; the exact size is checked again once every field is converted.
 */
export const MAX_PORTABLE_TEXT_RECORD_BYTES = 1024 * 1024;
/**
 * What an image block grows by once resolution replaces its slot with the media item's `asset`,
 * `width` and `height` (about 120 bytes), counted for each image in the JSON size.
 */
export const IMAGE_BLOCK_ALLOWANCE = 160;
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

/**
 * At most this many markup issues per field, and as many invalid image URLs; the rest of each
 * are summed in one more.
 */
const MAX_MARKUP_ISSUES = 19;

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

/** Thrown inside `parse5` when the markup is too complex to parse in bounded time. */
class TooComplex extends Error {}

/** Thrown while building blocks once their estimated JSON passes the record's budget. */
class TooLarge extends Error {}

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

/**
 * The default tree adapter with two bounds on `parse5`'s work. Both rely on `parse5`'s internals
 * as of the exact pinned version, 7.3.0 (`package.json`); re-check them on any upgrade.
 *
 * A count of open elements: the parse stops as soon as more than `MAX_PORTABLE_TEXT_NESTING` are
 * open, which bounds `parse5`'s quadratic scope checks. `onItemPush` and `onItemPop` are part of
 * the `TreeAdapter` interface, and every change to the open-element stack calls them.
 *
 * Linear moves of all of a node's children: `parse5` calls `getFirstChild` only to move every
 * child out, first to last (`getFragment` and `_adoptNodes`: the fragment's top-level nodes, and
 * the adoption agency's furthest block), and the default `detachNode` splices each one off the
 * front, which is quadratic. Here detaching the child that `getFirstChild` just returned only
 * moves a cursor past it; the moved-out prefix is removed when the last child goes, or before
 * any other change to or read of that parent's children.
 */
function nestingGuard(): TreeAdapter<DefaultTreeAdapterMap> {
	let open = 0;
	/** Parents being emptied: the children moved out so far, and the one returned last. */
	const moving = new Map<ParentNode, { head: number; returned: ChildNode }>();
	const compact = (parent: ParentNode) => {
		const state = moving.get(parent);
		if (state === undefined) return;
		moving.delete(parent);
		parent.childNodes.splice(0, state.head);
	};
	return {
		...defaultTreeAdapter,
		onItemPush() {
			// The fragment parser's own root element is the first push.
			open++;
			if (open > MAX_PORTABLE_TEXT_NESTING + 1) {
				throw new TooComplex(
					`The markup nests more than ${MAX_PORTABLE_TEXT_NESTING} elements deep`,
				);
			}
		},
		onItemPop() {
			open--;
		},
		getFirstChild(node) {
			const head = moving.get(node)?.head ?? 0;
			const child = node.childNodes[head];
			if (child === undefined) {
				compact(node);
				return null;
			}
			moving.set(node, { head, returned: child });
			return child;
		},
		detachNode(node) {
			const parent = node.parentNode;
			if (parent === null) return;
			const state = moving.get(parent);
			if (
				state !== undefined &&
				state.returned === node &&
				parent.childNodes[state.head] === node
			) {
				state.head++;
				node.parentNode = null;
				return;
			}
			compact(parent);
			defaultTreeAdapter.detachNode(node);
		},
		appendChild(parent, node) {
			compact(parent);
			defaultTreeAdapter.appendChild(parent, node);
		},
		insertBefore(parent, node, reference) {
			compact(parent);
			defaultTreeAdapter.insertBefore(parent, node, reference);
		},
		insertText(parent, text) {
			compact(parent);
			defaultTreeAdapter.insertText(parent, text);
		},
		insertTextBefore(parent, text, reference) {
			compact(parent);
			defaultTreeAdapter.insertTextBefore(parent, text, reference);
		},
		getChildNodes(node) {
			compact(node);
			return defaultTreeAdapter.getChildNodes(node);
		},
	};
}

/** The tokenizer members the attribute count wraps (protected in `parse5`'s types). */
type CountedTokenizer = { currentToken: unknown; _leaveAttrName(): void };

/**
 * Parses an HTML fragment like `parseFragment`, within the limits: at most
 * `MAX_PORTABLE_TEXT_NESTING` open elements (`nestingGuard`) and at most `MAX_TAG_ATTRIBUTES`
 * attribute names per tag. `parse5`'s tokenizer checks each new attribute name against all the
 * earlier ones of its tag, so the count wraps `_leaveAttrName`, which runs once per name: like
 * `nestingGuard`, this relies on `parse5` 7.3.0's internals (`dist/tokenizer/index.js`). Throws
 * `TooComplex` past a limit. Exported for the tests, which compare it with `parseFragment`.
 */
export function parseHtml(html: string): DefaultTreeAdapterTypes.DocumentFragment {
	const parser = Parser.getFragmentParser<DefaultTreeAdapterMap>(null, {
		treeAdapter: nestingGuard(),
	});
	const tokenizer = parser.tokenizer as unknown as CountedTokenizer;
	const leaveAttrName = tokenizer._leaveAttrName;
	let token: unknown = null;
	let names = 0;
	tokenizer._leaveAttrName = function (this: CountedTokenizer) {
		if (this.currentToken !== token) {
			token = this.currentToken;
			names = 0;
		}
		names++;
		if (names > MAX_TAG_ATTRIBUTES) {
			throw new TooComplex(`The markup has a tag with more than ${MAX_TAG_ATTRIBUTES} attributes`);
		}
		leaveAttrName.call(this);
	};
	parser.tokenizer.write(html, true);
	return parser.getFragment();
}

/** The UTF-8 length of `text`, without encoding it. A lone surrogate counts 3, as it encodes. */
export function utf8Length(text: string): number {
	let bytes = text.length;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) continue;
		if (code < 0x800) {
			bytes += 1;
			continue;
		}
		bytes += 2;
		// A surrogate pair is 4 bytes for its 2 units.
		const next = text.charCodeAt(i + 1);
		if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++;
	}
	return bytes;
}

/** Whether `text` is over `limit` UTF-8 bytes; every UTF-16 unit is at least one byte. */
function overBytes(text: string, limit: number): boolean {
	return text.length > limit || utf8Length(text) > limit;
}

const KIB = 1024;

/** The UTF-8 size of `blocks` as JSON, each image block counted with `IMAGE_BLOCK_ALLOWANCE`. */
export function portableTextBytes(blocks: readonly DraftBlock[]): number {
	let images = 0;
	for (const block of blocks) if (block._type === "image") images++;
	return utf8Length(JSON.stringify(blocks)) + images * IMAGE_BLOCK_ALLOWANCE;
}

/** The record's message for Portable Text JSON over `MAX_PORTABLE_TEXT_RECORD_BYTES`. */
export const RECORD_TOO_LARGE_MESSAGE = `The record's Portable Text is larger than ${MAX_PORTABLE_TEXT_RECORD_BYTES / KIB / KIB} MiB`;

/** The record's message for source text over `MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES`. */
export const RECORD_SOURCE_TOO_LARGE_MESSAGE = `The record's Portable Text sources are larger than ${MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES / KIB} KiB together`;

/** Why one field's source text is too large to convert, or null when it is not. */
export function portableTextSourceProblem(
	text: string,
	format: PortableTextFormat,
): PortableTextIssue | null {
	if (format === "markdown") {
		return overBytes(text, MAX_MARKDOWN_SOURCE_BYTES)
			? {
					code: "portable_text_too_large",
					message: `The Markdown is larger than ${MAX_MARKDOWN_SOURCE_BYTES / KIB} KiB`,
				}
			: null;
	}
	return overBytes(text, MAX_PORTABLE_TEXT_SOURCE_BYTES)
		? {
				code: "portable_text_too_large",
				message: `The text is larger than ${MAX_PORTABLE_TEXT_SOURCE_BYTES / KIB} KiB`,
			}
		: null;
}

/**
 * Converts one source value. A missing value, `null`, blank text, or markup that leaves no block
 * is empty (`draft: null`). Anything but text fails `not_scalar` in `applyTemplate` before this
 * runs. Errors from the parsers (a `RangeError` among them) fail `portable_text_failed`.
 *
 * `budget` is what the record's earlier Portable Text fields left of
 * `MAX_PORTABLE_TEXT_RECORD_BYTES`: building stops with `portable_text_too_large` as soon as the
 * blocks' estimated JSON passes it.
 */
export function convertPortableText(
	text: string,
	options: PortableTextOptions,
	budget: number = MAX_PORTABLE_TEXT_RECORD_BYTES,
): PortableTextConverted {
	const fail = (code: PortableTextCode, message: string): PortableTextConverted => ({
		draft: null,
		errors: [{ code, message }],
		warnings: [],
	});
	const source = portableTextSourceProblem(text, options.format);
	if (source !== null) return fail(source.code, source.message);
	if (options.format === "text") {
		try {
			return { draft: textDraft(text, budget), errors: [], warnings: [] };
		} catch (e) {
			if (e instanceof TooLarge) return fail("portable_text_too_large", RECORD_TOO_LARGE_MESSAGE);
			throw e;
		}
	}
	let html: string | null = text;
	try {
		if (options.format === "markdown") html = renderMarkdown(text);
	} catch (e) {
		return fail("portable_text_failed", `The Markdown could not be converted: ${errorText(e)}`);
	}
	if (html === null || overBytes(html, MAX_RENDERED_MARKDOWN_BYTES)) {
		return fail(
			"portable_text_too_large",
			`The Markdown renders to more than ${MAX_RENDERED_MARKDOWN_BYTES / KIB / KIB} MiB of HTML`,
		);
	}
	let fragment: DefaultTreeAdapterTypes.DocumentFragment;
	try {
		fragment = parseHtml(html);
	} catch (e) {
		if (e instanceof TooComplex) return fail("portable_text_too_complex", e.message);
		return fail("portable_text_failed", `The HTML could not be parsed: ${errorText(e)}`);
	}
	try {
		return new Walker(options, budget).run(fragment);
	} catch (e) {
		if (e instanceof TooLarge) return fail("portable_text_too_large", RECORD_TOO_LARGE_MESSAGE);
		return fail("portable_text_failed", `The HTML could not be converted: ${errorText(e)}`);
	}
}

/**
 * The running estimate of a value's JSON size against the record's budget, exact as each block is
 * finished: the block and one comma or bracket each, and the closing bracket. While a text block
 * is open, its text and a part of each span's JSON count too, so one long block cannot grow far
 * past the budget before it ends; the exact size replaces that when it does.
 */
class SizeBudget {
	private bytes = 1;
	/** The open text block's share, an estimate below its exact size. */
	private open = 0;
	constructor(private readonly budget: number) {}
	add(bytes: number): void {
		this.bytes += bytes;
		this.check();
	}
	block(block: DraftBlock): void {
		this.open = 0;
		this.add(utf8Length(JSON.stringify(block)) + 1);
	}
	/** Text or a new span (`OPEN_SPAN_BYTES`) appended to the open block. */
	grow(bytes: number): void {
		this.open += bytes;
		this.check();
	}
	/** The open block ended without a block. */
	drop(): void {
		this.open = 0;
	}
	private check(): void {
		if (this.bytes + this.open > this.budget) throw new TooLarge();
	}
}

/**
 * What a span counts in the open block's estimate besides its text: less than the 50 bytes of
 * `{"_type":"span","_key":"b0s0","text":"","marks":[]},`, so that trimmed spaces and dropped
 * blank spans never make the estimate pass the exact size.
 */
const OPEN_SPAN_BYTES = 40;

/**
 * `markdown.render`, stopping with null as soon as the HTML is longer than
 * `MAX_RENDERED_MARKDOWN_BYTES` characters: one reference definition can be used thousands of
 * times, so 128 KiB of Markdown can render to tens of megabytes. The loops are `markdown-it`'s
 * own `Renderer.render` and `renderInline` (`lib/renderer.mjs`), with the check after each token.
 * Exported for the tests, which compare it with `render`.
 */
export function renderMarkdown(text: string): string | null {
	const env = {};
	const tokens = markdown.parse(text, env);
	const renderer = markdown.renderer;
	const { rules } = renderer;
	const options = markdown.options;
	let html = "";
	const add = (piece: string): boolean => {
		html += piece;
		return html.length <= MAX_RENDERED_MARKDOWN_BYTES;
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as (typeof tokens)[number];
		if (token.type === "inline") {
			const children = token.children ?? [];
			for (let j = 0; j < children.length; j++) {
				const rule = rules[(children[j] as (typeof children)[number]).type];
				const piece =
					rule === undefined
						? renderer.renderToken(children, j, options)
						: rule(children, j, options, env, renderer);
				if (!add(piece)) return null;
			}
			continue;
		}
		const rule = rules[token.type];
		const piece =
			rule === undefined
				? renderer.renderToken(tokens, i, options)
				: rule(tokens, i, options, env, renderer);
		if (!add(piece)) return null;
	}
	return html;
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Plain text: paragraphs split on blank lines, single line breaks kept as `\n`. Throws
 * `TooLarge` as soon as the blocks' estimated JSON passes `budget`.
 */
function textDraft(text: string, budget: number): PortableTextDraft | null {
	const size = new SizeBudget(budget);
	const normalized = text.replace(/\r\n?/g, "\n");
	const blocks: DraftBlock[] = [];
	const separator = /\n[ \t]*\n/g;
	let from = 0;
	for (;;) {
		const match = separator.exec(normalized);
		const end = match === null ? normalized.length : match.index;
		const paragraph = normalized.slice(from, end).trim();
		if (paragraph !== "") {
			const key = `b${blocks.length}`;
			const block: DraftBlock = {
				_type: "block",
				_key: key,
				style: "normal",
				children: [{ _type: "span", _key: `${key}s0`, text: paragraph, marks: [] }],
			};
			size.block(block);
			blocks.push(block);
		}
		if (match === null) break;
		from = separator.lastIndex;
	}
	return blocks.length === 0 ? null : { blocks, images: [] };
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
	/** A finished text, code or break block. */
	{ kind: "block"; block: DraftBlock } | ImageOut;
type ImageOut = {
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
/** `text` cut to at most `max` characters, the last one an ellipsis when it is cut. */
function shortened(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** A URL as messages show it: at most 200 characters. */
export function shownUrl(url: string): string {
	return shortened(url, 200);
}
/** A tag name or URL scheme as messages show it. */
const shownTag = (tag: string) => shortened(tag, 40);

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
	/** The first `MAX_MARKUP_ISSUES` images with a URL that cannot be imported, and their count. */
	private readonly imageIssues: PortableTextIssue[] = [];
	private invalidImages = 0;
	private readonly size: SizeBudget;

	constructor(
		private readonly options: PortableTextOptions,
		budget: number,
	) {
		this.base = options.baseUrl === null ? null : new URL(options.baseUrl);
		this.size = new SizeBudget(budget);
	}

	/** The key of the next block. */
	private key(): string {
		return `b${this.out.length}`;
	}

	/** Adds a finished block, counted against the budget first. */
	private push(block: DraftBlock): void {
		this.size.block(block);
		this.out.push({ kind: "block", block });
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
				this.push({ _type: "break", _key: this.key(), style: "lineBreak" });
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
		if (joins && sameList(last.decorators, marks)) {
			this.size.grow(utf8Length(text));
			last.parts.push(text);
		} else {
			this.size.grow(utf8Length(text) + OPEN_SPAN_BYTES);
			block.spans.push({ parts: [text], decorators: marks, link });
		}
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
		// `\n` is 2 bytes in JSON.
		this.size.grow(2);
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
			this.push(textBlock({ context: block.context, spans, links: block.links }, this.key()));
		} else this.size.drop();
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
		this.push({
			_type: "code",
			_key: this.key(),
			code,
			...(language === null ? {} : { language }),
		});
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
			this.size.add(utf8Length(`,"caption":${JSON.stringify(caption)}`));
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
			this.invalidImages++;
			if (this.imageIssues.length === MAX_MARKUP_ISSUES) return;
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
		const out: ImageOut = {
			kind: "image",
			slot,
			alt: alt === "" ? null : alt,
			caption: null,
			link,
		};
		// A caption is counted when its figure ends; the item's fields once resolved, here.
		const draft = JSON.stringify(imageDraft(out, this.key()));
		this.size.add(utf8Length(draft) + 1 + IMAGE_BLOCK_ALLOWANCE);
		this.figures[this.figures.length - 1]?.images.push(this.out.length);
		this.out.push(out);
	}

	private result(): PortableTextConverted {
		const errors: PortableTextIssue[] = [];
		const warnings: PortableTextIssue[] = [];
		const markup = this.options.unknownMarkup === "fail" ? errors : warnings;
		const found: { code: PortableTextCode; message: string; n: number }[] = [];
		for (const [tag, n] of this.unknown) {
			const message = `Kept the text of ${plural(n, `<${shownTag(tag)}> element`)}`;
			found.push({ code: "unknown_markup", message, n });
		}
		for (const [tag, n] of this.removed) {
			const message = `Removed ${plural(n, `<${shownTag(tag)}> element`)}`;
			found.push({ code: "removed_markup", message, n });
		}
		for (const [reason, n] of this.dropped) {
			const message = `Kept the text of ${plural(n, "link")} without the address: ${reason}`;
			found.push({ code: "link_dropped", message, n });
		}
		for (const { code, message } of found.slice(0, MAX_MARKUP_ISSUES)) {
			markup.push({ code, message });
		}
		const rest = found.length - MAX_MARKUP_ISSUES;
		// The hidden issues may be of any kind, so the summary has one fixed code.
		if (rest > 0) markup.push({ code: "unknown_markup", message: `${rest} more markup issues` });
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
		const images = this.options.imageErrors === "fail" ? errors : warnings;
		images.push(...this.imageIssues);
		const more = this.invalidImages - this.imageIssues.length;
		if (more > 0) {
			images.push(
				this.options.imageErrors === "fail"
					? {
							code: "invalid_media_url",
							message: `${plural(more, "more image")} with an invalid URL`,
						}
					: {
							code: "image_dropped",
							message: `invalid_media_url: ${plural(more, "more image")} with an invalid URL`,
						},
			);
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
		return this.out.map((out, i) => (out.kind === "block" ? out.block : imageDraft(out, `b${i}`)));
	}
}

/** An image slot as a draft block; resolution replaces `slot` with the item. */
function imageDraft(out: ImageOut, key: string): DraftBlock {
	return {
		_type: "image",
		_key: key,
		slot: out.slot,
		...(out.alt === null ? {} : { alt: out.alt }),
		...(out.caption === null ? {} : { caption: out.caption }),
		...(out.link === null ? {} : { link: linkValue(out.link) }),
	};
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
		return { ok: false, reason: `the scheme ${shownTag(url.protocol)} is not allowed` };
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
