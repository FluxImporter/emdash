import { describe, expect, it } from "vitest";
import {
	chooseSheet,
	isDateFormat,
	readDateStyles,
	readSharedStrings,
	readWorkbook,
	richText,
	type Workbook,
	type WorkbookParts,
} from "../../src/sources/xlsx-workbook.js";
import { parseXmlRecordText } from "../../src/sources/xml-record.js";
import { XlsxError } from "../../src/sources/zip.js";
import { streamOf } from "./helpers.js";

/** Parts held as text, read in 7-byte chunks. */
class Parts implements WorkbookParts {
	constructor(private readonly files: Record<string, string>) {}
	has(name: string) {
		return Object.hasOwn(this.files, name);
	}
	open(name: string) {
		const text = this.files[name];
		if (text === undefined) throw new XlsxError(`The workbook has no part ${name}`);
		return streamOf(text, 7);
	}
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** As Excel writes it: markup compatibility, an absolute path, and sheet IDs out of order. */
function workbookXml(sheets: string, workbookPr = '<workbookPr defaultThemeVersion="166925"/>') {
	return (
		`${DECL}<workbook ${NS} ${R_NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">` +
		'<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="25929"/>' +
		workbookPr +
		'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Data\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent>' +
		'<bookViews><workbookView xWindow="672" yWindow="780" windowWidth="22368" windowHeight="13620"/></bookViews>' +
		`<sheets>${sheets}</sheets><calcPr calcId="191029"/></workbook>`
	);
}

/** Relationships in Excel's order (not by ID). */
const RELS =
	`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
	`<Relationship Id="rId3" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
	`<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
	`<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
	`<Relationship Id="rId6" Type="${REL}/chartsheet" Target="chartsheets/sheet1.xml"/>` +
	`<Relationship Id="rId7" Type="${REL}/worksheet" Target="/xl/worksheets/sheet3.xml"/>` +
	`<Relationship Id="rId8" Type="${REL}/worksheet" Target="../../outside.xml"/>` +
	`<Relationship Id="rId9" Type="${REL}/worksheet" Target="https://example.com/x.xml" TargetMode="External"/>` +
	`<Relationship Id="rId5" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
	`<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/>` +
	"</Relationships>";

const SHEETS =
	'<sheet name="Products" sheetId="4" r:id="rId1"/>' +
	'<sheet name="Prices 2026" sheetId="3" r:id="rId2"/>' +
	'<sheet name="Chart" sheetId="5" r:id="rId6"/>' +
	'<sheet name="Absolute" sheetId="6" r:id="rId7"/>' +
	'<sheet name="Outside" sheetId="7" r:id="rId8"/>' +
	'<sheet name="External" sheetId="8" r:id="rId9"/>';

async function failure(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(XlsxError);
	return (error as XlsxError).message;
}

describe("readWorkbook", () => {
	it("lists worksheets in workbook order through the relationships", async () => {
		const workbook = await readWorkbook(
			new Parts({
				"xl/workbook.xml": workbookXml(SHEETS),
				"xl/_rels/workbook.xml.rels": RELS,
			}),
		);
		expect(workbook).toEqual({
			sheets: [
				{ name: "Products", part: "xl/worksheets/sheet1.xml" },
				{ name: "Prices 2026", part: "xl/worksheets/sheet2.xml" },
				{ name: "Absolute", part: "xl/worksheets/sheet3.xml" },
			],
			date1904: false,
			sharedStrings: "xl/sharedStrings.xml",
			styles: "xl/styles.xml",
		});
	});

	it("reads the 1904 date system", async () => {
		const read = (pr: string) =>
			readWorkbook(
				new Parts({
					"xl/workbook.xml": workbookXml(SHEETS, pr),
					"xl/_rels/workbook.xml.rels": RELS,
				}),
			);
		expect((await read('<workbookPr date1904="1"/>')).date1904).toBe(true);
		expect((await read('<workbookPr date1904="true"/>')).date1904).toBe(true);
		expect((await read('<workbookPr date1904="0"/>')).date1904).toBe(false);
		expect((await read("")).date1904).toBe(false);
	});

	it("falls back to the usual part names without a relationship for them", async () => {
		const rels = `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
		const parts = (extra: Record<string, string>) =>
			new Parts({
				"xl/workbook.xml": workbookXml('<sheet name="Only" sheetId="1" r:id="rId1"/>'),
				"xl/_rels/workbook.xml.rels": rels,
				...extra,
			});
		expect(await readWorkbook(parts({}))).toEqual({
			sheets: [{ name: "Only", part: "xl/worksheets/sheet1.xml" }],
			date1904: false,
		});
		expect(
			await readWorkbook(parts({ "xl/sharedStrings.xml": "<sst/>", "xl/styles.xml": "<x/>" })),
		).toMatchObject({ sharedStrings: "xl/sharedStrings.xml", styles: "xl/styles.xml" });
	});

	it("refuses an archive that is not a workbook or has no worksheets", async () => {
		expect(await failure(readWorkbook(new Parts({ "word/document.xml": "<w/>" })))).toBe(
			"The file is not an Excel workbook (it has no xl/workbook.xml)",
		);
		expect(
			await failure(
				readWorkbook(
					new Parts({
						"xl/workbook.xml": workbookXml('<sheet name="Chart" sheetId="1" r:id="rId6"/>'),
						"xl/_rels/workbook.xml.rels": RELS,
					}),
				),
			),
		).toBe("The workbook has no worksheets");
		expect(
			await failure(
				readWorkbook(new Parts({ "xl/workbook.xml": `${DECL}<x:workbook xmlns:x="ns"/>` })),
			),
		).toBe(
			"The part xl/workbook.xml is not valid: The root element is <x:workbook>, not <workbook>",
		);
		expect(
			await failure(readWorkbook(new Parts({ "xl/workbook.xml": "<workbook><sheets>" }))),
		).toBe("The part xl/workbook.xml is not valid: Unterminated element <sheets>");
	});
});

describe("chooseSheet", () => {
	const workbook: Workbook = {
		sheets: [
			{ name: "Products", part: "xl/worksheets/sheet1.xml" },
			{ name: "Prices 2026", part: "xl/worksheets/sheet2.xml" },
		],
		date1904: false,
	};

	it("picks the first sheet, a sheet by name ignoring case, or by its 1-based position", () => {
		expect(chooseSheet(workbook).name).toBe("Products");
		expect(chooseSheet(workbook, "prices 2026").part).toBe("xl/worksheets/sheet2.xml");
		expect(chooseSheet(workbook, 2).name).toBe("Prices 2026");
	});

	it("names the sheets when the one asked for does not exist", () => {
		expect(() => chooseSheet(workbook, "Stock")).toThrow(
			new XlsxError(
				'The workbook has no sheet named "Stock"; its sheets are "Products", "Prices 2026"',
			),
		);
		expect(() => chooseSheet(workbook, 3)).toThrow(
			new XlsxError("The workbook has 2 worksheets; there is no sheet 3"),
		);
	});
});

describe("readSharedStrings", () => {
	const sst = (items: string) =>
		new Parts({
			"xl/sharedStrings.xml": `${DECL}<sst ${NS} count="9" uniqueCount="9">${items}</sst>`,
		});

	it("reads plain, rich, phonetic, whitespace and escaped strings in order", async () => {
		const strings = await readSharedStrings(
			sst(
				"<si><t>Unit Price</t></si>" +
					'<si><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t>Bold</t></r><r><rPr><sz val="11"/></rPr><t xml:space="preserve"> and plain</t></r></si>' +
					'<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>' +
					'<si><t xml:space="preserve">  </t></si>' +
					"<si><t/></si>" +
					"<si><t>Line one_x000D_\nline two</t></si>" +
					"<si><t>_x005F_x0041_ stays</t></si>" +
					"<si><t>Fish &amp; chips &lt;3</t></si>",
			),
			"xl/sharedStrings.xml",
		);
		expect(strings).toEqual([
			"Unit Price",
			"Bold and plain",
			"東京",
			"  ",
			"",
			"Line one\r\nline two",
			"_x0041_ stays",
			"Fish & chips <3",
		]);
	});

	it("gives null for a string item that does not parse", async () => {
		expect(
			await readSharedStrings(
				sst("<si><t>ok</t></si><si><t>&nbsp;</t></si>"),
				"xl/sharedStrings.xml",
			),
		).toEqual(["ok", null]);
	});

	it("refuses more strings than the limit", async () => {
		expect(
			await failure(
				readSharedStrings(
					sst("<si><t>a</t></si><si><t>b</t></si><si><t>c</t></si>"),
					"xl/sharedStrings.xml",
					2,
				),
			),
		).toBe("The workbook has more than 2 shared strings");
	});
});

describe("richText", () => {
	it("reads inline strings as the XML reader parses them", () => {
		const cell = parseXmlRecordText(
			'<c r="A1" t="inlineStr"><is><r><t>In</t></r><r><t xml:space="preserve">line </t></r></is></c>',
			true,
		) as Record<string, unknown>;
		expect(richText(cell.is)).toBe("Inline ");
		expect(richText("plain")).toBe("plain");
		expect(richText(undefined)).toBe("");
	});
});

describe("isDateFormat", () => {
	it.each([
		"yyyy-mm-dd",
		"yyyy\\-mm\\-dd;@",
		"d/m/yyyy",
		"[$-409]mmmm d, yyyy;@",
		"[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy",
		"h:mm AM/PM",
		"hh:mm:ss",
		"[Red]dd/mm/yy",
		"DD.MM.YYYY",
		'yyyy "year"',
	])("%s is a date", (code) => {
		expect(isDateFormat(code)).toBe(true);
	});

	it.each([
		"General",
		"0.00",
		"#,##0",
		"0%",
		"0.00E+00",
		'#,##0.00\\ "€"',
		'_-* #,##0.00\\ [$€-1]_-;\\-* #,##0.00\\ [$€-1]_-;_-* "-"??\\ [$€-1]_-;_-@_-',
		'0 "days"',
		'"Due: "0',
		"0.0\\m",
		"[h]:mm",
		"[hh]:mm:ss",
		"[mm]:ss",
		"[ss].0",
		"[Red]0.00;[Blue]-0.00",
		"@",
	])("%s is not a date", (code) => {
		expect(isDateFormat(code)).toBe(false);
	});
});

describe("readDateStyles", () => {
	it("maps cell styles to built-in and custom date formats", async () => {
		const styles =
			`${DECL}<styleSheet ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
			'<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd;@"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="166" formatCode="[h]:mm"/><numFmt numFmtId="14" formatCode="0.00"/></numFmts>' +
			'<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
			'<cellStyleXfs count="1"><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
			'<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="46" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
			'<xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="left"/></xf></cellXfs>' +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
		expect(await readDateStyles(new Parts({ "xl/styles.xml": styles }), "xl/styles.xml")).toEqual([
			false,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("has no date styles when the styles part has no cellXfs", async () => {
		const parts = new Parts({ "xl/styles.xml": `${DECL}<styleSheet ${NS}><fonts/></styleSheet>` });
		expect(await readDateStyles(parts, "xl/styles.xml")).toEqual([]);
	});
});
