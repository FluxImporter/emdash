import { readFileSync } from "node:fs";
import { product } from "./formats.js";
import { type ZipFile, zip } from "./zip.js";

/**
 * Workbooks for tests, built from parts that mirror what Microsoft Excel writes: an XML
 * declaration with CRLF, markup compatibility (`mc:Ignorable`) with `x14ac`/`xr` attributes,
 * shared strings with `count`/`uniqueCount`, styles with custom `numFmts`, rows with `spans` and
 * `x14ac:dyDescent`, and `xml:space="preserve"` on strings with outer spaces.
 */
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const X14AC = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac";
const XR = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";

export function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** A `<t>` element as Excel writes it: `xml:space="preserve"` only around outer whitespace. */
export function t(text: string): string {
	const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
	return `<t${preserve}>${xmlEscape(text)}</t>`;
}

export interface SheetSpec {
	name: string;
	/** The `<sheetData>` content: `<row>` elements. */
	rows: string;
	/** Extra worksheet content after `<sheetData>`, such as `<mergeCells>`. */
	after?: string;
}

export interface WorkbookSpec {
	sheets: SheetSpec[];
	/** `<si>` items, or plain strings written as `<si><t>…</t></si>`. */
	sharedStrings?: string[];
	/** Custom number formats by ID (164 and up). */
	numFmts?: Record<number, string>;
	/** The `numFmtId` of each cell style (`s`); style 0 is General. */
	cellXfs?: number[];
	date1904?: boolean;
	/** 8 (deflate, Excel's choice) or 0 (stored) for every part. */
	method?: 0 | 8;
}

function sheetXml(sheet: SheetSpec, index: number): string {
	return (
		`${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="${X14AC}" xmlns:xr="${XR}" xr:uid="{00000000-0001-0000-000${index}-000000000000}">` +
		'<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
		'<sheetFormatPr defaultRowHeight="14.4" x14ac:dyDescent="0.3"/>' +
		'<cols><col min="1" max="1" width="12.77734375" bestFit="1" customWidth="1"/></cols>' +
		(sheet.rows === "" ? "<sheetData/>" : `<sheetData>${sheet.rows}</sheetData>`) +
		(sheet.after ?? "") +
		'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
	);
}

function stylesXml(numFmts: Record<number, string>, cellXfs: number[]): string {
	const fmts = Object.entries(numFmts);
	return (
		`${DECL}<styleSheet xmlns="${MAIN}" xmlns:mc="${MC}" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="${X14AC}" xmlns:xr="${XR}">` +
		(fmts.length > 0
			? `<numFmts count="${fmts.length}">${fmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`).join("")}</numFmts>`
			: "") +
		'<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
		'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
		'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
		'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
		`<cellXfs count="${cellXfs.length}">${cellXfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id === 0 ? "" : ' applyNumberFormat="1"'}/>`).join("")}</cellXfs>` +
		'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/>' +
		'<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'
	);
}

/** Builds an `.xlsx` workbook from sheets, shared strings and styles. */
export async function workbook(spec: WorkbookSpec): Promise<Uint8Array<ArrayBuffer>> {
	const strings = spec.sharedStrings ?? [];
	const cellXfs = spec.cellXfs ?? [0];
	const sheetRels = spec.sheets.map(
		(_, i) =>
			`<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
	);
	const n = spec.sheets.length;
	const files: ZipFile[] = [
		{
			name: "[Content_Types].xml",
			data:
				`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				spec.sheets
					.map(
						(_, i) =>
							`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
					)
					.join("") +
				"</Types>",
		},
		{
			name: "_rels/.rels",
			data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		},
		{
			name: "xl/workbook.xml",
			data:
				`${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="${MC}" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">` +
				'<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>' +
				`<workbookPr${spec.date1904 ? ' date1904="1"' : ""} defaultThemeVersion="166925"/>` +
				'<bookViews><workbookView xWindow="-108" yWindow="-108" windowWidth="23256" windowHeight="12456"/></bookViews>' +
				`<sheets>${spec.sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${n - i}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
				'<calcPr calcId="191029"/></workbook>',
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data:
				`${DECL}<Relationships xmlns="${PKG_REL}">` +
				`<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/>` +
				[...sheetRels].reverse().join("") +
				(strings.length > 0
					? `<Relationship Id="rId${n + 3}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`
					: "") +
				"</Relationships>",
		},
		...spec.sheets.map((sheet, i) => ({
			name: `xl/worksheets/sheet${i + 1}.xml`,
			data: sheetXml(sheet, i),
		})),
		{ name: "xl/styles.xml", data: stylesXml(spec.numFmts ?? {}, cellXfs) },
		...(strings.length > 0
			? [
					{
						name: "xl/sharedStrings.xml",
						data:
							`${DECL}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">` +
							strings.map((s) => (s.startsWith("<si>") ? s : `<si>${t(s)}</si>`)).join("") +
							"</sst>",
					},
				]
			: []),
		{
			name: "docProps/app.xml",
			data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`,
		},
	];
	const method = spec.method;
	return zip(method === undefined ? files : files.map((f) => ({ ...f, method })));
}

/** A row as Excel writes it, with `spans` and `x14ac:dyDescent`. */
export function row(r: number, cells: string, spans = "1:6"): string {
	return `<row r="${r}" spans="${spans}" x14ac:dyDescent="0.3">${cells}</row>`;
}

/** Days from Excel's 1900 epoch to an ISO date (after February 1900). */
export function serial(isoDate: string): number {
	return (Date.parse(`${isoDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/**
 * The products of `productsCsv` and `product()` as a workbook: sku, Name, Price (a number),
 * Released (a date cell, style 1 = built-in format 14), Active (a boolean) and Handle. Text goes
 * through shared strings, as Excel stores it.
 */
export async function productsXlsx(n: number): Promise<Uint8Array<ArrayBuffer>> {
	const strings = ["sku", "Name", "Price", "Released", "Active", "Handle"];
	const index = (s: string) => {
		strings.push(s);
		return strings.length - 1;
	};
	let rows = row(1, strings.map((_, i) => `<c r="${"ABCDEF"[i]}1" t="s"><v>${i}</v></c>`).join(""));
	for (let i = 0; i < n; i++) {
		const p = product(i);
		const r = i + 2;
		rows += row(
			r,
			`<c r="A${r}" t="s"><v>${index(p.sku)}</v></c>` +
				`<c r="B${r}" t="s"><v>${index(p.name)}</v></c>` +
				`<c r="C${r}"><v>${p.price}</v></c>` +
				`<c r="D${r}" s="1"><v>${serial(p.released)}</v></c>` +
				`<c r="E${r}" t="b"><v>${i % 2}</v></c>` +
				`<c r="F${r}" t="s"><v>${index(p.handle)}</v></c>`,
		);
	}
	return workbook({
		sheets: [{ name: "Products", rows }],
		sharedStrings: strings,
		cellXfs: [0, 14],
	});
}

/** Maps `productsXlsx` columns like the other formats' templates do. */
export function xlsxTemplate(collection: string, source: Record<string, unknown> = {}) {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format: "xlsx", ...source },
		key: { from: "sku" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			released: { from: "Released", type: "date", tz: "Europe/Chisinau" },
		},
	};
}

/**
 * A workbook saved by Microsoft Excel (its docProps/app.xml says so): `Translations.xlsx` from
 * PhpSpreadsheet 1.30.1 (https://github.com/PHPOffice/PhpSpreadsheet, file
 * src/PhpSpreadsheet/Calculation/locale/Translations.xlsx at tag 1.30.1), SHA-256
 * f89b2a3a4d24097d89f9d7eae93f957cd041664287e2f6a9cebaa01168b3d625, MIT licensed (the license
 * is next to it). Two sheets of shared strings, with comments, VML drawings, web extensions and
 * printer settings in the archive.
 */
export function excelTranslations(): Uint8Array {
	return new Uint8Array(
		readFileSync(new URL("./phpspreadsheet/Translations.xlsx", import.meta.url)),
	);
}
