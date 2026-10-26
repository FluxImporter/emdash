import { SourceError, shortName } from "./reader.js";
import { xmlReader } from "./xml.js";
import { XlsxError } from "./zip.js";

const MIB = 1024 * 1024;
export const SHARED_STRINGS_MAX = 1_000_000;
export const SHARED_STRINGS_MAX_BYTES = 50 * MIB;
/**
 * Built-in number formats that are dates or times (ECMA-376 Part 1, 18.8.30): 14-22, 45 and 47,
 * plus the East Asian ones that Japanese, Chinese and Korean Excel save without a `<numFmt>`,
 * 27-36 and 50-58. 46 is `[h]:mm:ss`, an elapsed time, which stays a number like any other
 * elapsed-time format.
 */
const DATE_FORMAT_IDS = new Set([
	14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 47, 50, 51, 52,
	53, 54, 55, 56, 57, 58,
]);
const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHEETS_LISTED = 10;

/** The parts of a workbook archive; `ZipArchive` implements it. */
export interface WorkbookParts {
	has(name: string): boolean;
	open(name: string, maxBytes?: number): ReadableStream<Uint8Array>;
}

export interface SheetRef {
	name: string;
	/** The worksheet's part name, as in "xl/worksheets/sheet1.xml". */
	part: string;
}

export interface Workbook {
	/** Worksheets in workbook order (chart and dialog sheets are left out). */
	sheets: SheetRef[];
	date1904: boolean;
	/** The shared strings part, when the workbook has one. */
	sharedStrings?: string;
	/** The styles part, when the workbook has one. */
	styles?: string;
}

export type XmlElement = Record<string, unknown>;

function isElement(value: unknown): value is XmlElement {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attr(element: XmlElement, name: string): string | undefined {
	const value = element[`@${name}`];
	return typeof value === "string" ? value : undefined;
}

/**
 * The elements at `path` in a part, parsed with whitespace kept; `null` for one that does not
 * parse. A part that is not well-formed fails the conversion. With `optional`, a part whose
 * parent elements are missing has no elements instead.
 */
export async function* partElements(
	parts: WorkbookParts,
	part: string,
	path: string,
	options: { optional?: boolean; maxBytes?: number } = {},
): AsyncGenerator<XmlElement | null> {
	const parents = path.split("/").slice(0, -1).join("/");
	try {
		const stream = parts.open(part, options.maxBytes);
		for await (const rec of xmlReader(path, true).read(stream, { startOffset: 0, startSeq: 0 })) {
			yield rec.error || !isElement(rec.value) ? null : rec.value;
		}
	} catch (e) {
		if (!(e instanceof SourceError)) throw e;
		if (options.optional && e.message === `The document has no <${parents}> element`) return;
		throw new XlsxError(`The part ${part} is not valid: ${e.message}`);
	}
}

/**
 * Decodes the `_xHHHH_` escapes Excel writes for characters XML cannot hold (`_x000D_` is a
 * carriage return; `_x005F_` escapes a literal underscore).
 */
export function unescapeText(text: string): string {
	if (!text.includes("_x")) return text;
	return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function textOf(t: unknown): string {
	if (typeof t === "string") return t;
	if (Array.isArray(t)) return t.map(textOf).join("");
	if (isElement(t) && typeof t["#text"] === "string") return t["#text"];
	return "";
}

/**
 * The text of a string item (`<si>`, `<is>`): its `<t>`, or its rich text runs' `<t>`s joined.
 * Phonetic runs (`<rPh>`) are left out.
 */
export function richText(item: unknown): string {
	if (!isElement(item)) return typeof item === "string" ? unescapeText(item) : "";
	if ("t" in item) return unescapeText(textOf(item.t));
	const runs = item.r === undefined ? [] : Array.isArray(item.r) ? item.r : [item.r];
	return unescapeText(runs.map((run) => (isElement(run) ? textOf(run.t) : "")).join(""));
}

/** A relationship target as a part name, or null for one outside the archive. */
function partName(target: string): string | null {
	const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "..") {
			if (out.pop() === undefined) return null;
		} else if (segment !== "." && segment !== "") {
			out.push(segment);
		}
	}
	return out.join("/");
}

/** A sheet's relationship ID: its namespaced `id` attribute (`r:id`). */
function relationshipId(sheet: XmlElement): string | undefined {
	for (const [key, value] of Object.entries(sheet)) {
		if (/^@[^:]+:id$/.test(key) && typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Reads the workbook's worksheets in order, its date system, and where its shared strings and
 * styles are, from `xl/workbook.xml` and its relationships (targets resolved against `xl/`).
 */
export async function readWorkbook(parts: WorkbookParts): Promise<Workbook> {
	if (!parts.has(WORKBOOK)) {
		throw new XlsxError(`The file is not an Excel workbook (it has no ${WORKBOOK})`);
	}
	const targets = new Map<string, { type: string; part: string }>();
	if (parts.has(WORKBOOK_RELS)) {
		for await (const rel of partElements(parts, WORKBOOK_RELS, "Relationships/Relationship")) {
			if (!rel || attr(rel, "TargetMode") === "External") continue;
			const id = attr(rel, "Id");
			const target = attr(rel, "Target");
			const part = target === undefined ? null : partName(target);
			if (id !== undefined && part !== null) {
				targets.set(id, { type: attr(rel, "Type") ?? "", part });
			}
		}
	}
	const sheets: SheetRef[] = [];
	for await (const sheet of partElements(parts, WORKBOOK, "workbook/sheets/sheet")) {
		const name = sheet ? attr(sheet, "name") : undefined;
		const id = sheet ? relationshipId(sheet) : undefined;
		const rel = id === undefined ? undefined : targets.get(id);
		if (name !== undefined && rel?.type.endsWith("/worksheet"))
			sheets.push({ name, part: rel.part });
	}
	if (sheets.length === 0) throw new XlsxError("The workbook has no worksheets");
	let date1904 = false;
	for await (const pr of partElements(parts, WORKBOOK, "workbook/workbookPr", { optional: true })) {
		const value = pr ? attr(pr, "date1904") : undefined;
		date1904 = value === "1" || value === "true";
	}
	const byType = (suffix: string, fallback: string): string | undefined => {
		for (const { type, part } of targets.values()) if (type.endsWith(suffix)) return part;
		return parts.has(fallback) ? fallback : undefined;
	};
	const sharedStrings = byType("/sharedStrings", "xl/sharedStrings.xml");
	const styles = byType("/styles", "xl/styles.xml");
	return {
		sheets,
		date1904,
		...(sharedStrings === undefined ? {} : { sharedStrings }),
		...(styles === undefined ? {} : { styles }),
	};
}

/** The sheet named (compared ignoring case, as Excel does) or numbered (from 1); the first by default. */
export function chooseSheet(workbook: Workbook, sheet?: string | number): SheetRef {
	const { sheets } = workbook;
	if (sheet === undefined) return sheets[0] as SheetRef;
	if (typeof sheet === "number") {
		const found = sheets[sheet - 1];
		if (found) return found;
		const count = sheets.length === 1 ? "1 worksheet" : `${sheets.length} worksheets`;
		throw new XlsxError(`The workbook has ${count}; there is no sheet ${sheet}`);
	}
	const wanted = sheet.toLowerCase();
	const found = sheets.find((s) => s.name.toLowerCase() === wanted);
	if (found) return found;
	const listed = sheets.slice(0, SHEETS_LISTED).map((s) => `"${s.name}"`);
	if (sheets.length > SHEETS_LISTED) listed.push("…");
	throw new XlsxError(
		`The workbook has no sheet named "${shortName(sheet)}"; its sheets are ${listed.join(", ")}`,
	);
}

/**
 * Reads the shared strings in order (rich text runs joined); `null` for an item that does not
 * parse. At most `maxStrings` strings and `SHARED_STRINGS_MAX_BYTES` uncompressed.
 */
export async function readSharedStrings(
	parts: WorkbookParts,
	part: string,
	maxStrings = SHARED_STRINGS_MAX,
): Promise<(string | null)[]> {
	const strings: (string | null)[] = [];
	for await (const item of partElements(parts, part, "sst/si", {
		maxBytes: SHARED_STRINGS_MAX_BYTES,
	})) {
		if (strings.length >= maxStrings) {
			throw new XlsxError(
				`The workbook has more than ${maxStrings.toLocaleString("en-US")} shared strings`,
			);
		}
		strings.push(item === null ? null : richText(item));
	}
	return strings;
}

/**
 * Whether a number format code shows a date or time: it has `d`, `m`, `y`, `h` or `s` outside
 * quoted text, `[…]` sections and escaped characters (`\x`, and the `_x` and `*x` spacing and
 * fill characters). A code with an elapsed-time section (`[h]`, `[mm]`, `[ss]`) is a duration and
 * stays a number.
 */
export function isDateFormat(code: string): boolean {
	let plain = "";
	for (let i = 0; i < code.length; i++) {
		const ch = code[i] as string;
		if (ch === '"') {
			const end = code.indexOf('"', i + 1);
			i = end < 0 ? code.length : end;
		} else if (ch === "\\" || ch === "_" || ch === "*") {
			i++;
		} else if (ch === "[") {
			const end = code.indexOf("]", i + 1);
			const section = code.slice(i + 1, end < 0 ? code.length : end);
			if (/^(h+|m+|s+)$/i.test(section)) return false;
			i = end < 0 ? code.length : end;
		} else {
			plain += ch;
		}
	}
	return /[dmyhs]/i.test(plain);
}

/**
 * Which cell styles (`s`, an index into `cellXfs`) show dates: a style whose number format is a
 * built-in date or time format, or a custom format (`numFmts`) whose code `isDateFormat`.
 */
export async function readDateStyles(parts: WorkbookParts, part: string): Promise<boolean[]> {
	const codes = new Map<number, string>();
	for await (const fmt of partElements(parts, part, "styleSheet/numFmts/numFmt", {
		optional: true,
	})) {
		const id = fmt ? Number(attr(fmt, "numFmtId")) : Number.NaN;
		const code = fmt ? attr(fmt, "formatCode") : undefined;
		if (Number.isInteger(id) && code !== undefined) codes.set(id, code);
	}
	const dates: boolean[] = [];
	for await (const xf of partElements(parts, part, "styleSheet/cellXfs/xf", { optional: true })) {
		const id = Number((xf && attr(xf, "numFmtId")) ?? 0);
		const code = codes.get(id);
		dates.push(code === undefined ? DATE_FORMAT_IDS.has(id) : isDateFormat(code));
	}
	return dates;
}
