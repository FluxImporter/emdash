import { describe, expect, it } from "vitest";
import { parseJsonRecord } from "../../src/sources/json.js";
import { columnName, excelDate, openXlsx, type XlsxOptions } from "../../src/sources/xlsx.js";
import { XlsxError } from "../../src/sources/zip.js";
import {
	excelTranslations,
	productsXlsx,
	row,
	t,
	type WorkbookSpec,
	workbook,
} from "../fixtures/xlsx.js";
import { collect } from "./helpers.js";

async function convert(rows: string, options: XlsxOptions = {}, spec: Partial<WorkbookSpec> = {}) {
	const bytes = await workbook({ sheets: [{ name: "Sheet1", rows }], ...spec });
	const sheet = await openXlsx(bytes, options);
	const lines = await collect(sheet.lines);
	return {
		columns: sheet.columns,
		lines,
		records: lines.map((line) => parseJsonRecord(new TextEncoder().encode(line)).value),
		warnings: sheet.warnings(),
	};
}

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

const HEADER = row(
	1,
	'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c>',
);
const value = async (cell: string, spec: Partial<WorkbookSpec> = {}) => {
	const { records } = await convert(
		HEADER + row(2, `<c r="A2" t="inlineStr"><is><t>k</t></is></c>${cell}`),
		{},
		spec,
	);
	return (records[0] as Record<string, unknown>).Value;
};

describe("excelDate", () => {
	it.each([
		[1, false, "1900-01-01"],
		[59, false, "1900-02-28"],
		[61, false, "1900-03-01"],
		[45_352, false, "2024-03-01"],
		[45_352.5, false, "2024-03-01T12:00:00"],
		[45_352.000_011_574, false, "2024-03-01T00:00:01"],
		[0.75, false, "1899-12-31T18:00:00"],
		[0, true, "1904-01-01"],
		[43_890, true, "2024-03-01"],
		[2_958_465, false, "9999-12-31"],
	])("serial %d (1904: %s) is %s", (serial, date1904, iso) => {
		expect(excelDate(serial, date1904)).toBe(iso);
	});

	it("gives null for the 29 February 1900 that never was, negative serials and years past 9999", () => {
		expect(excelDate(60, false)).toBeNull();
		expect(excelDate(60.5, false)).toBeNull();
		expect(excelDate(60, true)).toBe("1904-03-01");
		expect(excelDate(-1, false)).toBeNull();
		expect(excelDate(2_958_466, false)).toBeNull();
		expect(excelDate(Number.NaN, false)).toBeNull();
		expect(excelDate(1e9, false)).toBeNull();
		expect(excelDate(1e9, true)).toBeNull();
	});
});

describe("columnName", () => {
	it.each([
		[0, "A"],
		[25, "Z"],
		[26, "AA"],
		[701, "ZZ"],
		[702, "AAA"],
		[16_383, "XFD"],
	])("%d is %s", (index, name) => {
		expect(columnName(index)).toBe(name);
	});
});

describe("openXlsx cell values", () => {
	it("reads shared, rich and inline strings, keeping spaces and decoding escapes", async () => {
		const strings = [
			"sku",
			"Value",
			"k",
			'<si><r><rPr><b/><sz val="11"/></rPr><t>Bold</t></r><r><t xml:space="preserve"> plain</t></r></si>',
			"  padded  ",
			"Line_x000D_\nbreak",
		];
		const header = row(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>');
		const { records } = await convert(
			header +
				row(2, '<c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c>') +
				row(3, '<c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>4</v></c>') +
				row(4, '<c r="A4" t="s"><v>2</v></c><c r="B4" t="s"><v>5</v></c>') +
				row(5, `<c r="A5" t="s"><v>2</v></c><c r="B5" t="inlineStr"><is>${t(" inline ")}</is></c>`),
			{},
			{ sharedStrings: strings },
		);
		expect(records.map((r) => (r as Record<string, unknown>).Value)).toEqual([
			"Bold plain",
			"  padded  ",
			"Line\r\nbreak",
			" inline ",
		]);
	});

	it("reads booleans, errors, ISO date cells and formulas with and without cached values", async () => {
		expect(await value('<c r="B2" t="b"><v>1</v></c>')).toBe(true);
		expect(await value('<c r="B2" t="b"><v>0</v></c>')).toBe(false);
		expect(await value('<c r="B2" t="e"><v>#N/A</v></c>')).toBeNull();
		expect(await value('<c r="B2" t="e"><f>1/0</f><v>#DIV/0!</v></c>')).toBeNull();
		expect(await value('<c r="B2" t="d"><v>2026-03-01T10:30:00</v></c>')).toBe(
			"2026-03-01T10:30:00",
		);
		expect(await value('<c r="B2"><f>SUM(1,2)</f><v>3</v></c>')).toBe(3);
		expect(await value('<c r="B2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>')).toBe("ab");
		expect(await value('<c r="B2"><f>NOW()</f></c>')).toBeNull();
		expect(await value('<c r="B2" t="str"><f>A1</f></c>')).toBeNull();
		expect(await value('<c r="B2" s="0"/>')).toBeNull();
	});

	it("writes numbers as their exact text, so large integers stay exact", async () => {
		const header = row(
			1,
			'<c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>n</t></is></c>',
		);
		const { lines, records } = await convert(
			header +
				row(2, '<c r="A2"><v>12345678901234567890</v></c><c r="B2"><v>0.1</v></c>') +
				row(3, '<c r="A3"><v>-1.5E-3</v></c><c r="B3"><v>1E+21</v></c>'),
		);
		expect(lines[0]).toBe('{"id":12345678901234567890,"n":0.1,"_row":2}');
		expect(records).toEqual([
			{ id: "12345678901234567890", n: 0.1, _row: 2 },
			{ id: -0.0015, n: 1e21, _row: 3 },
		]);
	});

	it("turns dates into ISO text by the cell's number format, in the 1900 or 1904 system", async () => {
		const spec: Partial<WorkbookSpec> = {
			numFmts: { 164: "yyyy\\-mm\\-dd\\ hh:mm;@", 165: "[h]:mm", 166: '0.0 "days"' },
			cellXfs: [0, 14, 164, 165, 166, 22],
		};
		expect(await value('<c r="B2" s="1"><v>45352</v></c>', spec)).toBe("2024-03-01");
		expect(await value('<c r="B2" s="2"><v>45352.75</v></c>', spec)).toBe("2024-03-01T18:00:00");
		expect(await value('<c r="B2" s="5"><v>45352.5</v></c>', spec)).toBe("2024-03-01T12:00:00");
		// Elapsed time and quoted text stay numbers.
		expect(await value('<c r="B2" s="3"><v>1.5</v></c>', spec)).toBe(1.5);
		expect(await value('<c r="B2" s="4"><v>2</v></c>', spec)).toBe(2);
		expect(await value('<c r="B2" s="1"><v>43890</v></c>', { ...spec, date1904: true })).toBe(
			"2024-03-01",
		);
	});

	it("reads serials around Excel's 1900 leap-year bug, and counts 29 February 1900 as unreadable", async () => {
		const header = row(1, '<c r="A1" t="inlineStr"><is><t>d</t></is></c>');
		const { records, warnings } = await convert(
			header +
				row(2, '<c r="A2" s="1"><v>59</v></c>') +
				row(3, '<c r="A3" s="1"><v>60</v></c>') +
				row(4, '<c r="A4" s="1"><v>61</v></c>'),
			{},
			{ cellXfs: [0, 14] },
		);
		expect(records).toEqual([
			{ d: "1900-02-28", _row: 2 },
			{ d: "1900-03-01", _row: 4 },
		]);
		expect(warnings).toEqual(["1 row had only unreadable cells and was skipped (first at row 3)"]);
	});

	it("counts an unreadable cell only in a row that is imported, including a huge date serial", async () => {
		const { records, warnings } = await convert(
			HEADER +
				row(2, '<c r="A2" s="1"><v>1E+9</v></c>') +
				row(3, '<c r="A3" t="inlineStr"><is><t>k</t></is></c><c r="B3" s="1"><v>1E+9</v></c>'),
			{},
			{ cellXfs: [0, 14] },
		);
		expect(records).toEqual([{ sku: "k", Value: null, _row: 3 }]);
		expect(warnings).toEqual([
			"1 row had only unreadable cells and was skipped (first at row 2)",
			"1 cell could not be read and was imported as empty",
		]);
	});

	it("reads a shared-string cell with no value, or an empty one, as an empty cell that is not counted", async () => {
		const { records, warnings } = await convert(
			HEADER +
				row(2, '<c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" t="s"></c>') +
				row(3, '<c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3" t="s"><v/></c>') +
				row(4, '<c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4" t="s"><v></v></c>'),
			{},
			{ sharedStrings: ["zero"] },
		);
		expect(records.map((r) => (r as Record<string, unknown>).Value)).toEqual([null, null, null]);
		expect(warnings).toEqual([]);
	});

	it("imports unreadable cells as empty and counts them in one warning", async () => {
		const { records, warnings } = await convert(
			HEADER +
				row(2, '<c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" t="s"><v>99</v></c>') +
				row(3, '<c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3" t="b"><v>2</v></c>') +
				row(4, '<c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4"><v>.5</v></c>') +
				row(5, '<c r="A5" t="inlineStr"><is><t>d</t></is></c><c r="B5" t="x"><v>1</v></c>'),
		);
		expect(records.map((r) => (r as Record<string, unknown>).Value)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(warnings).toEqual(["4 cells could not be read and were imported as empty"]);
	});
});

describe("openXlsx rows and headers", () => {
	it("places sparse cells by reference and cells without one after the previous cell", async () => {
		const { columns, records } = await convert(
			row(
				1,
				'<c r="A1" t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c><c r="D1" t="inlineStr"><is><t>d</t></is></c>',
			) +
				row(2, '<c r="B2"><v>2</v></c><c><v>3</v></c>') +
				'<row><c><v>1</v></c><c r="D3"><v>4</v></c></row>',
		);
		expect(columns).toEqual(["a", "b", "column_C", "d"]);
		expect(records).toEqual([
			{ a: null, b: 2, column_C: 3, d: null, _row: 2 },
			{ a: 1, b: null, column_C: null, d: 4, _row: 3 },
		]);
	});

	it("names empty headers by column, numbers repeats, and warns about each rename", async () => {
		const { columns, warnings } = await convert(
			row(
				1,
				'<c r="A1" t="inlineStr"><is><t> Price </t></is></c><c r="B1" t="inlineStr"><is><t>   </t></is></c><c r="C1" t="inlineStr"><is><t>Price</t></is></c><c r="D1" t="inlineStr"><is><t>Price_2</t></is></c><c r="E1"><v>2026</v></c><c r="F1" t="inlineStr"><is><t>Price</t></is></c>',
			),
		);
		expect(columns).toEqual(["Price", "column_B", "Price_2", "Price_2_2", "2026", "Price_3"]);
		expect(warnings).toEqual([
			'Column B has no header; it is named "column_B"',
			'The header "Price" in column C repeats; it is named "Price_2"',
			'The header "Price_2" in column D repeats; it is named "Price_2_2"',
			'The header "Price" in column F repeats; it is named "Price_3"',
		]);
	});

	it("adds _row unless a header is named _row", async () => {
		const plain = await convert(HEADER + row(7, '<c r="A7" t="inlineStr"><is><t>k</t></is></c>'));
		expect(plain.records).toEqual([{ sku: "k", Value: null, _row: 7 }]);
		const named = await convert(
			row(1, '<c r="A1" t="inlineStr"><is><t>_row</t></is></c>') +
				row(2, '<c r="A2"><v>42</v></c>'),
		);
		expect(named.lines).toEqual(['{"_row":42}']);
	});

	it("skips rows above the header and rows without values, and ignores cells right of the header", async () => {
		const { records, warnings } = await convert(
			row(1, '<c r="A1" t="inlineStr"><is><t>Report</t></is></c>') +
				row(2, '<c r="A2"><v>1</v></c><c r="B2"><v>1</v></c>') +
				HEADER.replace(/r="1"/, 'r="3"').replace(/A1/, "A3").replace(/B1/, "B3") +
				row(4, '<c r="A4" s="0"/><c r="B4" t="e"><v>#N/A</v></c>') +
				row(5, '<c r="C5"><v>9</v></c>') +
				row(
					6,
					'<c r="A6" t="inlineStr"><is><t>k</t></is></c><c r="C6"><v>1</v></c><c r="D6"><v>2</v></c>',
				),
			{ headerRow: 3 },
		);
		expect(records).toEqual([{ sku: "k", Value: null, _row: 6 }]);
		expect(warnings).toEqual(["3 cells right of the last header column (B) were ignored"]);
	});

	it("keeps a merged cell's value in its top-left cell only", async () => {
		const bytes = await workbook({
			sheets: [
				{
					name: "Merged",
					rows:
						HEADER +
						row(2, '<c r="A2" t="inlineStr"><is><t>span</t></is></c><c r="B2" s="0"/>') +
						row(3, '<c r="A3" s="0"/><c r="B3" t="inlineStr"><is><t>x</t></is></c>'),
					after: '<mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>',
				},
			],
		});
		const sheet = await openXlsx(bytes);
		expect(await collect(sheet.lines)).toEqual([
			'{"sku":"span","Value":null,"_row":2}',
			'{"sku":null,"Value":"x","_row":3}',
		]);
	});

	it("refuses a missing or empty header row, rows out of order and columns past XFD", async () => {
		expect(await failure(convert(HEADER, { headerRow: 3 }))).toBe(
			'The sheet "Sheet1" has no row 3',
		);
		expect(await failure(convert(""))).toBe('The sheet "Sheet1" has no row 1');
		expect(await failure(convert(row(2, '<c r="A2"><v>1</v></c>')))).toBe(
			'Header row 1 of the sheet "Sheet1" is empty',
		);
		expect(await failure(convert(row(1, '<c r="A1" t="e"><v>#REF!</v></c>')))).toBe(
			'Header row 1 of the sheet "Sheet1" is empty',
		);
		expect(await failure(convert(HEADER + row(3, "") + row(2, "")))).toBe(
			"Row 2 comes after row 3; rows must be in order",
		);
		expect(await failure(convert(HEADER + row(2, '<c r="XFE2"><v>1</v></c>')))).toBe(
			"A cell in column XFE is past column XFD, the last column Excel has",
		);
		expect(await failure(convert(HEADER + row(1_048_577, "")))).toBe(
			"Row 1048577 is past row 1,048,576, the last row Excel has",
		);
		expect(await failure(convert(`${HEADER}<row r="2"><c><v>&nbsp;</v></c></row>`))).toBe(
			"The part xl/worksheets/sheet1.xml has a row after row 1 that is not valid XML",
		);
	});

	it("reads an empty <sheetData/>, as Excel writes an empty sheet, as a sheet without rows", async () => {
		const bytes = await workbook({ sheets: [{ name: "Empty", rows: "" }] });
		expect(await failure(openXlsx(bytes))).toBe('The sheet "Empty" has no row 1');
	});

	it("picks a sheet by name or position, and stores parts uncompressed too", async () => {
		const bytes = await workbook({
			sheets: [
				{ name: "First", rows: row(1, '<c r="A1" t="inlineStr"><is><t>one</t></is></c>') },
				{ name: "Second", rows: row(1, '<c r="A1" t="inlineStr"><is><t>two</t></is></c>') },
			],
			method: 0,
		});
		expect((await openXlsx(bytes)).columns).toEqual(["one"]);
		expect((await openXlsx(bytes, { sheet: "second" })).columns).toEqual(["two"]);
		expect((await openXlsx(bytes, { sheet: 2 })).columns).toEqual(["two"]);
		expect(await failure(openXlsx(bytes, { sheet: 3 }))).toBe(
			"The workbook has 2 worksheets; there is no sheet 3",
		);
	});
});

describe("openXlsx on workbooks", () => {
	it("converts the products workbook", async () => {
		const sheet = await openXlsx(await productsXlsx(3));
		expect(sheet.columns).toEqual(["sku", "Name", "Price", "Released", "Active", "Handle"]);
		expect(await collect(sheet.lines)).toEqual([
			'{"sku":"SKU-0","Name":"Product 0, \\"quoted\\" & <tagged> ț","Price":0.5,"Released":"2026-03-01","Active":false,"Handle":"product-0","_row":2}',
			'{"sku":"SKU-1","Name":"Product 1, \\"quoted\\" & <tagged> ț","Price":1.5,"Released":"2026-03-02","Active":true,"Handle":"product-1","_row":3}',
			'{"sku":"SKU-2","Name":"Product 2, \\"quoted\\" & <tagged> ț","Price":2.5,"Released":"2026-03-03","Active":false,"Handle":"product-2","_row":4}',
		]);
		expect(sheet.warnings()).toEqual([]);
	});

	it("reads a workbook saved by Microsoft Excel", async () => {
		const bytes = excelTranslations();
		const first = await openXlsx(bytes);
		expect(first.columns.slice(0, 4)).toEqual(["column_A", "en", "eu", "ca"]);
		expect(first.warnings()).toEqual(['Column A has no header; it is named "column_A"']);
		const functions = await openXlsx(bytes, { sheet: "Excel Functions" });
		expect(functions.columns.slice(0, 4)).toEqual(["CATEGORY:", "en", "pt_br", "pt"]);
		const records = (await collect(functions.lines)).map((line) => JSON.parse(line));
		// 537 <row> elements: the header and 536 rows with values (Excel leaves out empty rows).
		expect(records).toHaveLength(536);
		expect(records[0]).toMatchObject({ "CATEGORY:": null, pt_br: "Português Brasileiro", _row: 2 });
		expect(records[3]).toMatchObject({
			"CATEGORY:": null,
			en: "CUBEKPIMEMBER",
			ru: "КУБЭЛЕМЕНТКИП",
			_row: 5,
		});
		expect(records.at(-1)).toMatchObject({ en: "ZTEST", pl: "TEST.Z", _row: 550 });
		expect(functions.warnings()).toEqual([]);
	});

	it("refuses files that are not workbooks", async () => {
		expect(await failure(openXlsx(new TextEncoder().encode("sku,Name\n")))).toBe(
			"The file is not an .xlsx workbook (it is not a zip archive)",
		);
	});
});
