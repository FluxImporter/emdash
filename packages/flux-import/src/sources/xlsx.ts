import { shortName, XLSX_MAX_ROWS, XLSX_ROW_FIELD } from "./reader.js";
import {
	attr,
	chooseSheet,
	partElements,
	readDateStyles,
	readSharedStrings,
	readWorkbook,
	richText,
	unescapeText,
	type XmlElement,
} from "./xlsx-workbook.js";
import { XlsxError, ZipArchive } from "./zip.js";

/** Excel's last column, XFD. */
export const XLSX_MAX_COLUMNS = 16_384;

export interface XlsxOptions {
	/** A sheet name or 1-based position; the first worksheet by default. */
	sheet?: string | number | undefined;
	/** The 1-based header row; 1 by default. */
	headerRow?: number | undefined;
}

/** One sheet being converted to JSON Lines. */
export interface XlsxSheet {
	/** The header names, after naming empty headers and numbering repeated ones. */
	columns: string[];
	/** One JSON Lines record per data row with a value, without the line break. */
	lines: AsyncGenerator<string>;
	/** Header renames, then cells ignored or unreadable so far: all of them once `lines` is done. */
	warnings(): string[];
}

/** A cell's value as JSON text, and as text for a header. */
interface Cell {
	json: string;
	text: string;
}

const UNREADABLE = Symbol("unreadable");

interface Row {
	number: number;
	/** Cells with a value, by 0-based column; `UNREADABLE` for a value that cannot be read. */
	cells: Map<number, Cell | typeof UNREADABLE>;
}
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const CELL_REF = /^([A-Z]{1,3})(\d+)$/;
const DAY_SECONDS = 86_400;
/** Serial 0 of the 1900 system is 1899-12-31 ("1900-01-00"); of the 1904 system, 1904-01-01. */
const EPOCH_1900 = Date.UTC(1899, 11, 31);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const YEAR_MAX = 9999;

/** "A" for 0, "Z" for 25, "AA" for 26. */
export function columnName(index: number): string {
	let name = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	}
	return name;
}

function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/**
 * A serial date as ISO 8601 text without a zone: the date alone at midnight, else with the time
 * to the second. The 1900 system repeats Excel's leap-year bug: serial 60 is 29 February 1900,
 * which did not exist, so it gives null and later serials are a day behind. Null too for
 * negative serials and years after 9999.
 */
export function excelDate(serial: number, date1904: boolean): string | null {
	if (!Number.isFinite(serial) || serial < 0) return null;
	let days = serial;
	if (!date1904) {
		if (serial >= 60 && serial < 61) return null;
		if (serial >= 61) days -= 1;
	}
	const ms = (date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(days * DAY_SECONDS) * 1000;
	const date = new Date(ms);
	if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > YEAR_MAX) return null;
	const iso = date.toISOString();
	return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19);
}

function textOf(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (typeof v === "object" && v !== null && !Array.isArray(v)) {
		const text = (v as XmlElement)["#text"];
		return typeof text === "string" ? text : "";
	}
	return undefined;
}

const text = (value: string): Cell => ({ json: JSON.stringify(value), text: value });

function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

class SheetConverter {
	unreadable = 0;
	ignored = 0;
	skipped = 0;
	firstSkipped = 0;

	constructor(
		private readonly part: string,
		private readonly strings: (string | null)[],
		private readonly dateStyles: boolean[],
		private readonly date1904: boolean,
	) {}

	/** A cell's value: null when it has none, `UNREADABLE` when it has one that cannot be read. */
	value(cell: XmlElement): Cell | null | typeof UNREADABLE {
		const v = textOf(cell.v);
		switch (attr(cell, "t") ?? "n") {
			case "s": {
				if (v === undefined || v === "") return null;
				const s = this.strings[Number(v)];
				return typeof s === "string" ? text(s) : UNREADABLE;
			}
			case "inlineStr":
				return cell.is === undefined ? null : text(richText(cell.is));
			case "str":
				return v === undefined ? null : text(unescapeText(v));
			case "b":
				if (v === undefined) return null;
				if (v === "1" || v === "true") return { json: "true", text: "true" };
				if (v === "0" || v === "false") return { json: "false", text: "false" };
				return UNREADABLE;
			case "e":
				return null;
			case "d":
				return v === undefined || v === "" ? null : text(v);
			case "n": {
				if (v === undefined || v === "") return null;
				if (!JSON_NUMBER.test(v)) return UNREADABLE;
				if (!this.dateStyles[Number(attr(cell, "s") ?? 0)]) return { json: v, text: v };
				const iso = excelDate(Number(v), this.date1904);
				return iso === null ? UNREADABLE : text(iso);
			}
			default:
				return UNREADABLE;
		}
	}

	/** The cells of one `<row>`: placed by their reference, or after the previous cell without one. */
	cells(row: XmlElement): Map<number, Cell | typeof UNREADABLE> {
		const cells = new Map<number, Cell | typeof UNREADABLE>();
		const list = row.c === undefined ? [] : Array.isArray(row.c) ? row.c : [row.c];
		let column = -1;
		for (const item of list) {
			const cell: XmlElement =
				typeof item === "object" && item !== null ? (item as XmlElement) : {};
			const ref = CELL_REF.exec(attr(cell, "r") ?? "");
			column = ref ? columnIndex(ref[1] as string) : column + 1;
			if (column >= XLSX_MAX_COLUMNS) {
				throw new XlsxError(
					`A cell in column ${columnName(column)} is past column XFD, the last column Excel has`,
				);
			}
			const value = this.value(cell);
			if (value !== null) cells.set(column, value);
		}
		return cells;
	}

	/** The sheet's rows in order, each numbered by its `r` or as the row after the previous one. */
	async *rows(parts: ZipArchive): AsyncGenerator<Row> {
		let previous = 0;
		for await (const row of partElements(parts, this.part, "worksheet/sheetData/row", {
			optional: true,
		})) {
			if (row === null) {
				throw new XlsxError(
					`The part ${this.part} has a row after row ${previous} that is not valid XML`,
				);
			}
			const r = Number(attr(row, "r") ?? Number.NaN);
			const number = Number.isInteger(r) && r > 0 ? r : previous + 1;
			if (number > XLSX_MAX_ROWS) {
				throw new XlsxError(`Row ${number} is past row 1,048,576, the last row Excel has`);
			}
			if (number <= previous) {
				throw new XlsxError(`Row ${number} comes after row ${previous}; rows must be in order`);
			}
			previous = number;
			yield { number, cells: this.cells(row) };
		}
	}
}

/**
 * Names the header row's columns: trimmed text, `column_<letter>` for an empty one, `_2`, `_3`, …
 * added to a repeated one. Returns the names and a warning for each rename.
 */
function headerNames(
	cells: Map<number, Cell | typeof UNREADABLE>,
	width: number,
): { names: string[]; renames: string[] } {
	const names: string[] = [];
	const renames: string[] = [];
	const used = new Set<string>();
	for (let i = 0; i < width; i++) {
		const letter = columnName(i);
		const cell = cells.get(i);
		let name = cell === undefined || cell === UNREADABLE ? "" : cell.text.trim();
		if (name === "") {
			name = `column_${letter}`;
			renames.push(`Column ${letter} has no header; it is named "${name}"`);
		}
		if (used.has(name)) {
			let n = 2;
			while (used.has(`${name}_${n}`)) n++;
			const renamed = `${name}_${n}`;
			renames.push(
				`The header "${shortName(name)}" in column ${letter} repeats; it is named "${shortName(renamed)}"`,
			);
			name = renamed;
		}
		used.add(name);
		names.push(name);
	}
	return { names, renames };
}

/**
 * Opens one sheet of an `.xlsx` workbook held in memory and reads up to its header row. The
 * returned `lines` convert the rows below it, one at a time: an object of header name to cell
 * value (`null` for an empty cell) plus `_row`, the sheet's row number, unless a header is named
 * `_row`. Rows without values are skipped; cells right of the last header are ignored.
 */
export async function openXlsx(bytes: Uint8Array, options: XlsxOptions = {}): Promise<XlsxSheet> {
	const zip = ZipArchive.open(bytes);
	const workbook = await readWorkbook(zip);
	const sheet = chooseSheet(workbook, options.sheet);
	const strings = workbook.sharedStrings
		? await readSharedStrings(zip, workbook.sharedStrings)
		: [];
	const dateStyles = workbook.styles ? await readDateStyles(zip, workbook.styles) : [];
	const converter = new SheetConverter(sheet.part, strings, dateStyles, workbook.date1904);
	const headerRow = options.headerRow ?? 1;
	const rows = converter.rows(zip);

	let header: Row | undefined;
	for (;;) {
		const next = await rows.next();
		if (next.done) {
			await rows.return(undefined);
			throw new XlsxError(`The sheet "${shortName(sheet.name)}" has no row ${headerRow}`);
		}
		if (next.value.number < headerRow) continue;
		if (next.value.number === headerRow) header = next.value;
		break;
	}
	const named = header
		? [...header.cells].filter(([, c]) => c !== UNREADABLE && c.text.trim() !== "")
		: [];
	if (!header || named.length === 0) {
		await rows.return(undefined);
		throw new XlsxError(`Header row ${headerRow} of the sheet "${shortName(sheet.name)}" is empty`);
	}
	// The header ends at its last named column; an unreadable header cell counts as empty.
	const width = Math.max(...named.map(([column]) => column)) + 1;
	for (const [column, cell] of header.cells) {
		if (cell === UNREADABLE && column < width) converter.unreadable++;
	}
	const { names, renames } = headerNames(header.cells, width);
	const keys = names.map((name) => `${JSON.stringify(name)}:`);
	const rowField = names.includes(XLSX_ROW_FIELD) ? "" : `,${JSON.stringify(XLSX_ROW_FIELD)}:`;

	async function* lines(): AsyncGenerator<string> {
		try {
			for await (const row of rows) {
				const values: string[] = new Array(width).fill("null");
				let any = false;
				let unreadable = 0;
				for (const [column, cell] of row.cells) {
					if (column >= width) {
						converter.ignored++;
					} else if (cell === UNREADABLE) {
						unreadable++;
					} else {
						values[column] = cell.json;
						// An empty string (a formula returning "") is written, but alone keeps a row empty.
						if (cell.text !== "") any = true;
					}
				}
				if (!any) {
					if (unreadable > 0) {
						if (converter.skipped === 0) converter.firstSkipped = row.number;
						converter.skipped++;
					}
					continue;
				}
				converter.unreadable += unreadable;
				const fields = keys.map((key, i) => key + values[i]).join(",");
				yield `{${fields}${rowField === "" ? "" : rowField + row.number}}`;
			}
		} finally {
			await rows.return(undefined);
		}
	}

	return {
		columns: names,
		lines: lines(),
		warnings: () => [
			...renames,
			...(converter.ignored > 0
				? [
						`${plural(converter.ignored, "cell", "cells")} right of the last header column (${columnName(width - 1)}) ${converter.ignored === 1 ? "was" : "were"} ignored`,
					]
				: []),
			...(converter.skipped > 0
				? [
						`${plural(converter.skipped, "row", "rows")} had only unreadable cells and ${converter.skipped === 1 ? "was" : "were"} skipped (first at row ${converter.firstSkipped})`,
					]
				: []),
			...(converter.unreadable > 0
				? [
						`${plural(converter.unreadable, "cell", "cells")} could not be read and ${converter.unreadable === 1 ? "was" : "were"} imported as empty`,
					]
				: []),
		],
	};
}
