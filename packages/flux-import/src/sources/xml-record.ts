import { decodeUtf8, type SourceRecord, shortName } from "./reader.js";

const NAME = /[^\s/>=<"'&!?]+/y;
const SPACE = /\s*/y;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** An XML name: starts with a letter, "_" or ":"; then letters, combining marks, digits, ".", "-", "_", ":" or "·". */
export const XML_NAME = /^[\p{L}_:][\p{L}\p{M}\p{N}._:\u00b7-]*$/u;
const NOT_BLANK = /[^ \t\r\n]/;

class XmlRecordError extends Error {}

/**
 * An entity reference, or a bare "&": a name of at most 32 characters without spaces, "&" or "<",
 * then the ";" that a bare "&" lacks. A longer name reads as a bare "&", so messages stay short.
 */
const ENTITY = /&([^;&\s<]{0,32})(;?)/g;

/** Decodes the five predefined entities and numeric character references; others are errors. */
function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	return raw.replace(ENTITY, (_match, name: string, semicolon: string) => {
		if (semicolon === "") throw new XmlRecordError(`"&" must start an entity such as &amp;`);
		const predefined = PREDEFINED[name];
		if (predefined !== undefined) return predefined;
		const hex = /^#x([0-9a-fA-F]{1,6})$/.exec(name);
		const dec = /^#([0-9]{1,7})$/.exec(name);
		const code = hex ? Number.parseInt(hex[1] as string, 16) : dec ? Number(dec[1]) : -1;
		const valid =
			code === 0x9 ||
			code === 0xa ||
			code === 0xd ||
			(code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
		if (code === -1) throw new XmlRecordError(`Unknown entity &${name};`);
		if (!valid) throw new XmlRecordError(`Invalid character reference &${name};`);
		return String.fromCodePoint(code);
	});
}

interface Frame {
	name: string;
	attrs: [string, string][];
	children: Map<string, unknown[]>;
	text: string[];
}

/**
 * An element without attributes or child elements is its text; otherwise an object with
 * `@attributes`, child elements (repeats as arrays) and `#text` when the text is not blank (with
 * `keepBlankText`, when it is not empty). The record element is always an object. Keys are own
 * properties (`Object.fromEntries`).
 */
function finish(frame: Frame, isRecord: boolean, keepBlankText: boolean): unknown {
	const text = frame.text.join("");
	if (!isRecord && frame.attrs.length === 0 && frame.children.size === 0) return text;
	const entries: [string, unknown][] = frame.attrs.map(([k, v]) => [`@${k}`, v]);
	for (const [name, values] of frame.children) {
		entries.push([name, values.length === 1 ? values[0] : values]);
	}
	if (keepBlankText ? text !== "" : NOT_BLANK.test(text)) entries.push(["#text", text]);
	return Object.fromEntries(entries);
}

/**
 * Parses one record element (comments and processing instructions ignored, CDATA as text).
 * `keepBlankText` keeps whitespace-only text, as in `<t xml:space="preserve"> </t>`.
 */
export function parseXmlRecordText(xml: string, keepBlankText = false): unknown {
	const src = xml.replace(/\r\n?/g, "\n");
	const stack: Frame[] = [];
	let i = 0;
	const fail = (message: string): never => {
		throw new XmlRecordError(message);
	};
	const name = (): string => {
		NAME.lastIndex = i;
		const m = NAME.exec(src);
		if (!m) fail(`Expected a name at character ${i}`);
		i = NAME.lastIndex;
		const found = (m as RegExpExecArray)[0];
		if (!XML_NAME.test(found)) fail(`Invalid name "${shortName(found)}"`);
		return found;
	};
	const space = () => {
		SPACE.lastIndex = i;
		SPACE.exec(src);
		i = SPACE.lastIndex;
	};
	const skipPast = (end: string, what: string) => {
		const at = src.indexOf(end, i);
		if (at < 0) fail(`Unterminated ${what}`);
		const body = src.slice(i, at);
		i = at + end.length;
		return body;
	};
	const close = (frame: Frame) => {
		const value = finish(frame, stack.length === 0, keepBlankText);
		const parent = stack.at(-1);
		if (!parent) return value;
		const list = parent.children.get(frame.name);
		if (list) list.push(value);
		else parent.children.set(frame.name, [value]);
		return undefined;
	};

	if (src[i] !== "<") fail("A record must start with an element");
	for (;;) {
		if (i >= src.length) fail("Unexpected end of record");
		if (src.startsWith("<!--", i)) {
			i += 4;
			skipPast("-->", "comment");
		} else if (src.startsWith("<![CDATA[", i)) {
			i += 9;
			const cdata = skipPast("]]>", "CDATA section");
			stack.at(-1)?.text.push(cdata);
		} else if (src.startsWith("<?", i)) {
			i += 2;
			skipPast("?>", "processing instruction");
		} else if (src.startsWith("<!", i)) {
			fail("Declarations are not allowed inside a record");
		} else if (src.startsWith("</", i)) {
			i += 2;
			const closing = name();
			space();
			if (src[i] !== ">") fail(`Expected ">" after </${shortName(closing)}`);
			i++;
			const frame = stack.pop();
			if (!frame || frame.name !== closing) fail(`Unexpected </${shortName(closing)}>`);
			const value = close(frame as Frame);
			if (stack.length === 0) {
				if (NOT_BLANK.test(src.slice(i))) fail("Content after the record element");
				return value;
			}
		} else if (src[i] === "<") {
			i++;
			const frame: Frame = { name: name(), attrs: [], children: new Map(), text: [] };
			const seen = new Set<string>();
			for (;;) {
				const before = i;
				space();
				if (src.startsWith("/>", i) || src[i] === ">") break;
				if (i === before) {
					fail(`Expected a space before attribute in <${shortName(frame.name)}>`);
				}
				const attr = name();
				const quoted = shortName(attr);
				space();
				if (src[i] !== "=") fail(`Expected "=" after attribute ${quoted}`);
				i++;
				space();
				const quote = src[i];
				if (quote !== '"' && quote !== "'") fail(`Attribute ${quoted} must be quoted`);
				i++;
				const raw = skipPast(quote as string, `attribute ${quoted}`);
				if (raw.includes("<")) fail(`"<" is not allowed in attribute ${quoted}`);
				if (seen.has(attr)) fail(`Duplicate attribute ${quoted}`);
				seen.add(attr);
				frame.attrs.push([attr, decodeEntities(raw)]);
			}
			if (src[i] === "/") {
				i += 2;
				if (stack.length === 0) {
					const value = finish(frame, true, keepBlankText);
					if (NOT_BLANK.test(src.slice(i))) fail("Content after the record element");
					return value;
				}
				close(frame);
			} else {
				i++;
				stack.push(frame);
			}
		} else {
			const next = src.indexOf("<", i);
			const raw = src.slice(i, next < 0 ? src.length : next);
			i += raw.length;
			const frame = stack.at(-1);
			if (!frame) fail("Text outside the record element");
			(frame as Frame).text.push(decodeEntities(raw));
		}
	}
}

/** Parses one record's bytes; a parse failure is the record's problem, not the job's. */
export function parseXmlRecord(
	bytes: Uint8Array,
	keepBlankText = false,
): Pick<SourceRecord, "value" | "error"> {
	const text = decodeUtf8(bytes);
	if (text === null) {
		return {
			value: null,
			error: { code: "invalid_record", message: "The record is not valid UTF-8" },
		};
	}
	try {
		return { value: parseXmlRecordText(text, keepBlankText) };
	} catch (e) {
		if (!(e instanceof XmlRecordError)) throw e;
		return { value: null, error: { code: "invalid_record", message: `Invalid XML: ${e.message}` } };
	}
}
