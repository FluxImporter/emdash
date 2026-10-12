import { collectPaths } from "./paths.js";
import {
	ByteBuffer,
	type ByteScanner,
	decodeUtf8,
	isJsonSpace,
	MAX_RECORD_BYTES,
	type RecordReader,
	runScanner,
	SourceError,
	type SourceRecord,
	syntaxError,
	takeSample,
} from "./reader.js";
import { parseXmlRecord } from "./xml-record.js";

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const DASH = 0x2d;
const RBRACKET = 0x5d;
const LBRACKET = 0x5b;
const PROLOG_PI_MAX = 1024;
const BANG_FORMS = ["--", "[CDATA[", "DOCTYPE"];

const isSpace = isJsonSpace;
const syntax = syntaxError;

type Mode =
	| "text"
	| "lt"
	| "startName"
	| "inTag"
	| "attrValue"
	| "selfClose"
	| "endName"
	| "endSpace"
	| "bang"
	| "comment"
	| "cdata"
	| "pi"
	| "doctype"
	| "done";

/**
 * Finds record elements (`records` = "root/…/record": every `record` element whose ancestors are
 * exactly the earlier segments) by tracking tags, quoted attribute values, comments, CDATA and
 * processing instructions, and yields each element's bytes parsed. At any record boundary the
 * open elements are the records path's parents, so a reader resumes from the path alone.
 * After the root element closes only whitespace, comments and processing instructions may follow.
 */
class XmlScanner implements ByteScanner {
	private mode: Mode = "text";
	private readonly parents: number;
	private readonly resumed: boolean;
	private stack: string[];
	private matched: number;
	private rootSeen: boolean;
	/** The root element has closed: only whitespace, comments and processing instructions may follow. */
	private closed = false;
	private readonly name = new ByteBuffer();
	private readonly tag = new ByteBuffer();
	private readonly record = new ByteBuffer();
	private readonly pi = new ByteBuffer();
	private markupStart = 0;
	private quote = 0;
	private run = 0;
	private bang = "";
	private doctype = "";
	private inRecord = false;
	private recordStart = 0;
	private seq: number;
	private out: SourceRecord[] = [];
	bodyOffset = -1;

	constructor(
		private readonly path: string[],
		startOffset: number,
		startSeq: number,
		private readonly stopAtBody: boolean,
	) {
		this.parents = path.length - 1;
		this.resumed = startOffset > 0;
		this.stack = this.resumed ? path.slice(0, this.parents) : [];
		this.matched = this.resumed ? this.parents : 0;
		this.rootSeen = this.resumed;
		this.seq = startSeq;
	}

	get done(): boolean {
		return this.mode === "done";
	}

	drain(): SourceRecord[] {
		const out = this.out;
		this.out = [];
		return out;
	}

	step(b: number, pos: number): void {
		if (this.inRecord) {
			if (pos - this.recordStart >= MAX_RECORD_BYTES) {
				throw syntax(`A record is larger than ${MAX_RECORD_BYTES} bytes`, this.recordStart);
			}
			this.record.push(b);
		}
		switch (this.mode) {
			case "text":
				if (b === LT) {
					this.markupStart = pos;
					this.mode = "lt";
				} else if (!this.rootSeen && !isSpace(b)) {
					throw syntax("Text before the root element; is this an XML file?", pos);
				} else if (this.closed && !isSpace(b)) {
					throw syntax("Content after the root element", pos);
				}
				return;
			case "lt":
				if (b === SLASH) {
					this.name.clear();
					this.mode = "endName";
				} else if (b === BANG) {
					this.bang = "";
					this.mode = "bang";
				} else if (b === QUESTION) {
					this.pi.clear();
					this.run = 0;
					this.mode = "pi";
				} else if (isSpace(b) || b === GT || b === LT) {
					throw syntax("Invalid tag", this.markupStart);
				} else {
					this.name.clear();
					this.name.push(b);
					this.tag.clear();
					this.tag.push(LT);
					this.tag.push(b);
					this.mode = "startName";
				}
				return;
			case "startName":
			case "inTag":
			case "attrValue":
			case "selfClose":
				this.inStartTag(b, pos);
				return;
			case "endName":
				if (isSpace(b)) this.mode = "endSpace";
				else if (b === GT) this.endTag(pos);
				else if (b === LT) throw syntax('"<" inside a tag', pos);
				else this.name.push(b);
				return;
			case "endSpace":
				if (b === GT) this.endTag(pos);
				else if (!isSpace(b)) throw syntax("Invalid end tag", this.markupStart);
				return;
			case "bang": {
				this.bang += String.fromCharCode(b);
				if (this.bang === "--") {
					this.run = 0;
					this.mode = "comment";
				} else if (this.bang === "[CDATA[") {
					this.run = 0;
					this.mode = "cdata";
				} else if (this.bang === "DOCTYPE") {
					if (this.rootSeen) throw syntax("A DOCTYPE inside the document", this.markupStart);
					this.doctype = "";
					this.mode = "doctype";
				} else if (!BANG_FORMS.some((f) => f.startsWith(this.bang))) {
					throw syntax(`Unknown markup "<!${this.bang}"`, this.markupStart);
				}
				return;
			}
			case "comment":
				if (b === GT && this.run >= 2) this.mode = "text";
				else this.run = b === DASH ? this.run + 1 : 0;
				return;
			case "cdata":
				if (b === GT && this.run >= 2) this.mode = "text";
				else this.run = b === RBRACKET ? this.run + 1 : 0;
				return;
			case "pi":
				if (b === GT && this.run === 1) {
					this.mode = "text";
					if (!this.rootSeen) this.checkDeclaration();
					return;
				}
				this.run = b === QUESTION ? 1 : 0;
				if (!this.rootSeen && this.pi.length < PROLOG_PI_MAX) this.pi.push(b);
				return;
			case "doctype":
				if (b === LBRACKET) {
					throw new SourceError(
						"xml_dtd_not_allowed",
						"DOCTYPE with an internal subset is not allowed",
						this.markupStart,
					);
				}
				if (b !== GT) {
					if (this.doctype.length < PROLOG_PI_MAX) this.doctype += String.fromCharCode(b);
					return;
				}
				if (this.doctype.trim().split(/\s+/).length > 1) {
					throw new SourceError(
						"xml_dtd_not_allowed",
						"DOCTYPE with an external DTD is not allowed",
						this.markupStart,
					);
				}
				this.mode = "text";
				return;
			case "done":
				return;
		}
	}

	private inStartTag(b: number, pos: number): void {
		if (!this.inRecord && pos - this.markupStart >= MAX_RECORD_BYTES) {
			throw syntax(`A tag is larger than ${MAX_RECORD_BYTES} bytes`, this.markupStart);
		}
		if (!this.inRecord) this.tag.push(b);
		switch (this.mode) {
			case "startName":
				if (isSpace(b)) this.mode = "inTag";
				else if (b === SLASH) this.mode = "selfClose";
				else if (b === GT) this.startTag(false, pos);
				else if (b === LT) throw syntax('"<" inside a tag', pos);
				else this.name.push(b);
				return;
			case "inTag":
				if (b === DQUOTE || b === SQUOTE) {
					this.quote = b;
					this.mode = "attrValue";
				} else if (b === SLASH) this.mode = "selfClose";
				else if (b === GT) this.startTag(false, pos);
				else if (b === LT) throw syntax('"<" inside a tag', pos);
				return;
			case "attrValue":
				if (b === this.quote) this.mode = "inTag";
				return;
			case "selfClose":
				if (b !== GT) throw syntax('Expected ">" after "/"', pos);
				this.startTag(true, pos);
				return;
		}
	}

	private tagName(): string {
		const name = decodeUtf8(this.name.bytes());
		if (name === null || name === "") throw syntax("Invalid element name", this.markupStart);
		return name;
	}

	private located(offset: number): void {
		if (this.bodyOffset >= 0) return;
		this.bodyOffset = offset;
		if (this.stopAtBody) this.mode = "done";
	}

	private notFound(offset: number): never {
		const parents = this.path.slice(0, this.parents).join("/");
		throw new SourceError("invalid_source", `The document has no <${parents}> element`, offset);
	}

	private startTag(selfClosing: boolean, pos: number): void {
		this.mode = "text";
		const name = this.tagName();
		const depth = this.stack.length;
		if (this.inRecord) {
			if (!selfClosing) this.stack.push(name);
			return;
		}
		if (depth === 0) {
			if (this.closed) throw syntax("More than one root element", this.markupStart);
			this.rootSeen = true;
			if (name !== this.path[0]) {
				throw new SourceError(
					"invalid_source",
					`The root element is <${name}>, not <${this.path[0]}>`,
					this.markupStart,
				);
			}
			if (selfClosing) {
				throw new SourceError("invalid_source", `The root element <${name}/> is empty`, pos);
			}
			this.stack.push(name);
			this.matched = 1;
			if (this.parents === 1) this.located(pos + 1);
			return;
		}
		if (depth < this.parents && this.matched === depth && name === this.path[depth]) {
			if (selfClosing) return;
			this.stack.push(name);
			this.matched = depth + 1;
			if (this.matched === this.parents) this.located(pos + 1);
			return;
		}
		if (depth === this.parents && this.matched === depth && name === this.path[depth]) {
			this.recordStart = this.markupStart;
			this.record.clear();
			this.record.pushAll(this.tag.bytes());
			if (selfClosing) {
				this.emit(pos + 1);
				return;
			}
			this.stack.push(name);
			this.inRecord = true;
			return;
		}
		if (!selfClosing) this.stack.push(name);
	}

	private endTag(pos: number): void {
		this.mode = "text";
		const name = this.tagName();
		const open = this.stack.at(-1);
		if (open === undefined) throw syntax(`</${name}> has no start tag`, this.markupStart);
		if (name !== open) throw syntax(`Expected </${open}>, found </${name}>`, this.markupStart);
		this.stack.pop();
		const depth = this.stack.length;
		if (this.inRecord && depth === this.parents) {
			this.inRecord = false;
			this.emit(pos + 1);
		}
		if (depth < this.matched) this.matched = depth;
		if (depth === 0) {
			this.closed = true;
			if (this.bodyOffset < 0 && !this.resumed) this.notFound(pos);
		}
	}

	private emit(end: number): void {
		const parsed = parseXmlRecord(this.record.bytes());
		this.record.clear();
		this.out.push({ seq: this.seq++, start: this.recordStart, end, ...parsed });
	}

	private checkDeclaration(): void {
		const text = decodeUtf8(this.pi.bytes()) ?? "";
		if (!/^xml\s/.test(text)) return;
		const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(text)?.[1];
		if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
			throw new SourceError(
				"unsupported_encoding",
				`The XML declaration names encoding "${encoding}"; only UTF-8 is supported`,
				0,
			);
		}
	}

	finish(end: number): void {
		if (this.mode === "done") return;
		if (!this.rootSeen)
			throw new SourceError("invalid_source", "The document has no root element", end);
		if (this.mode !== "text") throw syntax("Unterminated markup", this.markupStart);
		if (this.closed) return;
		const open = this.stack.at(-1);
		throw syntax(`Unterminated element <${open}>`, this.inRecord ? this.recordStart : end);
	}
}

/** XML: the elements at the `/` path `records` ("feed/item"). */
export function xmlReader(records: string): RecordReader {
	const path = records.split("/");
	const scan = (stream: ReadableStream<Uint8Array>, startOffset: number, startSeq: number) =>
		runScanner(stream, startOffset, new XmlScanner(path, startOffset, startSeq, false));
	return {
		async locate(stream) {
			const scanner = new XmlScanner(path, 0, 0, true);
			for await (const _ of runScanner(stream, 0, scanner)) {
				// locating emits no records
			}
			return { bodyOffset: scanner.bodyOffset };
		},
		read: (stream, { startOffset, startSeq }) => scan(stream, startOffset, startSeq),
		async sample(stream, n) {
			const values = await takeSample(scan(stream, 0, 0), n);
			return { records: values, paths: collectPaths(values, "xml") };
		},
	};
}
