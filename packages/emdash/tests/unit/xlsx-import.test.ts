import { describe, expect, it } from "vitest";
import { XLSX_MAX_BYTES } from "../../src/astro/config.js";
import { EmDashUploads, newUploadId, stageUpload } from "../../src/emdash/uploads.js";
import { JobError } from "../../src/engine/jobs.js";
import { SourceMissingError } from "../../src/engine/ports.js";
import { nextBatch, ServiceError, startJob } from "../../src/plugin/service.js";
import { createSource, jobFromSource, type SourceRow } from "../../src/plugin/sources.js";
import {
	fetchLimitsFor,
	sampleImport,
	startImport,
	XLSX_WORKERS_BUFFER,
	type XlsxStaging,
	xlsxSource,
} from "../../src/plugin/xlsx.js";
import { FETCH_LIMITS } from "../../src/sources/fetcher.js";
import { productsXlsx, row, workbook, xlsxTemplate } from "../fixtures/xlsx.js";
import { FakeStorage, MemoryKv, MemorySettings, makeDeps } from "./fakes.js";
import { streamOf } from "./helpers.js";

const MIB = 1024 * 1024;
const fields = async (collection: string) =>
	collection === "products"
		? [
				{ slug: "title", type: "string" },
				{ slug: "price", type: "number" },
				{ slug: "released", type: "datetime" },
			]
		: null;

function setup(limits: Partial<XlsxStaging> = {}) {
	const storage = new FakeStorage();
	const uploads = new EmDashUploads(storage);
	const deps = { ...makeDeps().deps, source: uploads };
	const staging: XlsxStaging = {
		storage,
		maxXlsxBytes: XLSX_MAX_BYTES,
		maxSourceBytes: 50 * MIB,
		workers: false,
		bufferBytes: XLSX_WORKERS_BUFFER,
		...limits,
	};
	const stage = async (bytes: Uint8Array) =>
		(await stageUpload(storage, streamOf(bytes), 100 * MIB, bytes.length)).uploadId;
	const text = async (uploadId: string) => new Response(await uploads.open(uploadId, 0)).text();
	return { deps, storage, uploads, staging, stage, text };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
}

describe("startImport", () => {
	it("converts the sheet, imports the copy, and keeps the workbook as sourceUploadId", async () => {
		const { deps, storage, uploads, staging, stage, text } = setup();
		const book = await stage(await productsXlsx(3));
		const job = await startImport(
			deps,
			staging,
			{ uploadId: book, template: xlsxTemplate("products"), dryRun: false },
			fields,
		);
		expect(job).toMatchObject({
			sourceUploadId: book,
			source: { format: "xlsx" },
			columns: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			warnings: [],
			cursor: { offset: 0, seq: 0 },
			// The conversion counted the rows: the job knows its total from the start.
			recordTotal: 3,
		});
		expect(job.uploadId).not.toBe(book);
		expect((await text(job.uploadId)).split("\n")[0]).toBe(
			'{"sku":"SKU-0","Name":"Product 0, \\"quoted\\" & <tagged> ț","Price":0.5,"Released":"2026-03-01","Active":false,"Handle":"product-0","_row":2}',
		);
		const done = await nextBatch(deps, uploads, job.id, "h");
		expect(done).toMatchObject({ status: "completed", counters: { created: 3, failed: 0 } });
		const entry = [...deps.content.entries.values()][0];
		expect(entry?.data).toMatchObject({
			flux_source_id: "SKU-0",
			title: 'Product 0, "quoted" & <tagged> ț',
			price: 0.5,
			released: "2026-02-28T22:00:00.000Z",
		});
		// The finished job released the converted copy and the uploaded workbook.
		expect(storage.files.size).toBe(0);
	});

	it("stores the conversion's warnings before the job's own", async () => {
		const { deps, staging, stage } = setup();
		const book = await stage(
			await workbook({
				sheets: [
					{
						name: "Sheet1",
						rows:
							row(
								1,
								'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="C1" t="inlineStr"><is><t>Name</t></is></c>',
							) + row(2, '<c r="A2" t="inlineStr"><is><t>A1</t></is></c><c r="D2"><v>1</v></c>'),
					},
				],
			}),
		);
		const template = {
			...xlsxTemplate("products"),
			slug: undefined,
			fields: { title: { from: "Name", type: "text" } },
		};
		const job = await startImport(
			deps,
			staging,
			{ uploadId: book, template, dryRun: true },
			fields,
		);
		expect(job.warnings).toEqual([
			'Column B has no header; it is named "column_B"',
			"1 cell right of the last header column (C) was ignored",
		]);
	});

	it("fails job creation with invalid_source for a conversion problem, staging nothing", async () => {
		const { deps, storage, staging, stage } = setup();
		const csv = await stage(new TextEncoder().encode("sku,Name\nA1,Desk\n"));
		const notXlsx = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: csv, template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(notXlsx).toBeInstanceOf(JobError);
		expect(notXlsx).toMatchObject({
			code: "invalid_source",
			message: "The file is not an .xlsx workbook (it is not a zip archive)",
		});
		const book = await stage(await productsXlsx(1));
		const noSheet = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products", { sheet: "Stock" }), dryRun: false },
				fields,
			),
		);
		expect(noSheet).toMatchObject({
			code: "invalid_source",
			message: 'The workbook has no sheet named "Stock"; its sheets are "Products"',
		});
		expect(storage.files.size).toBe(2);
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("deletes the converted copy when the job cannot be created", async () => {
		const { deps, storage, staging, stage } = setup();
		const book = await stage(await productsXlsx(1));
		const template = xlsxTemplate("products");
		template.fields.title.from = "Title";
		const error = await failure(
			startImport(deps, staging, { uploadId: book, template, dryRun: false }, fields),
		);
		expect(error).toMatchObject({
			code: "invalid_template",
			details: ['Column "Title" not found in the source'],
		});
		expect(storage.files.size).toBe(1);
	});

	it("leaves templates of other formats, and invalid XLSX blocks, to startJob", async () => {
		const { deps, staging, stage } = setup();
		const book = await stage(await productsXlsx(1));
		const error = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products", { records: "x" }), dryRun: false },
				fields,
			),
		);
		expect(error).toMatchObject({
			code: "invalid_source",
			details: ["source.records is not allowed for xlsx"],
		});
	});

	it("refuses a workbook over the XLSX file limit with TOO_LARGE", async () => {
		const { deps, staging, stage } = setup({ maxXlsxBytes: 1000 });
		const book = await stage(await productsXlsx(5));
		const error = await failure(
			startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(error).toBeInstanceOf(ServiceError);
		expect(error).toMatchObject({
			code: "TOO_LARGE",
			status: 413,
			message: "XLSX files are limited to 1000 bytes",
		});
	});

	it("refuses converted lines over maxSourceBytes, and over the buffer on Workers", async () => {
		const bytes = await productsXlsx(50);
		const node = setup({ maxSourceBytes: 2000 });
		const tooLarge = await failure(
			startImport(
				node.deps,
				node.staging,
				{ uploadId: await node.stage(bytes), template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(tooLarge).toMatchObject({
			code: "TOO_LARGE",
			message: "The converted sheet exceeds the limit of 2000 bytes",
		});
		const workers = setup({ workers: true, bufferBytes: 2000 });
		const tooLargeHere = await failure(
			startImport(
				workers.deps,
				workers.staging,
				{ uploadId: await workers.stage(bytes), template: xlsxTemplate("products"), dryRun: false },
				fields,
			),
		);
		expect(tooLargeHere).toMatchObject({
			code: "TOO_LARGE",
			message:
				"The sheet converts to more than 2000 bytes of JSON Lines, too large to convert on Workers",
		});
		expect(workers.storage.files.size).toBe(1);
	});

	it("stages the converted lines with their length, as R2 needs on Workers", async () => {
		const global = globalThis as { FixedLengthStream?: unknown };
		const lengths: number[] = [];
		global.FixedLengthStream = class extends TransformStream {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		};
		try {
			const { deps, staging, stage, text } = setup({ workers: true });
			const book = await stage(await productsXlsx(2));
			const job = await startImport(
				deps,
				staging,
				{ uploadId: book, template: xlsxTemplate("products"), dryRun: true },
				fields,
			);
			const converted = await text(job.uploadId);
			expect(converted.trim().split("\n")).toHaveLength(2);
			expect(lengths.at(-1)).toBe(Buffer.byteLength(converted));
		} finally {
			delete global.FixedLengthStream;
		}
	});

	it("passes the rows the converter skipped to the job as unkeyed (M5c)", async () => {
		const { deps, staging, stage } = setup();
		const header = row(
			1,
			'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c>',
		);
		const rows =
			header +
			row(
				2,
				'<c r="A2" t="inlineStr"><is><t>K1</t></is></c><c r="B2" t="inlineStr"><is><t>One</t></is></c>',
			) +
			// 29 February 1900 with a date style: unreadable, and the row's only value.
			row(3, '<c r="A3" s="1"><v>60</v></c>');
		const book = await stage(
			await workbook({ sheets: [{ name: "Sheet1", rows }], cellXfs: [0, 14] }),
		);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			source: { format: "xlsx" },
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
			rules: { owner: "o", missing: { action: "trash" } },
		};
		const job = await startImport(
			deps,
			staging,
			{ uploadId: book, template, dryRun: false },
			fields,
		);
		expect(job.unkeyed).toBe(1);
		expect(job.warnings).toContain(
			"1 row had only unreadable cells and was skipped (first at row 3)",
		);
	});
	it("keeps a missing workbook's SourceMissingError as the cause (M6c)", async () => {
		const { deps, staging } = setup();
		const input = { uploadId: newUploadId(), template: xlsxTemplate("products"), dryRun: false };
		const error = await failure(startImport(deps, staging, input, fields));
		expect(error).toBeInstanceOf(JobError);
		expect(error).toMatchObject({ code: "invalid_source" });
		expect((error as JobError).cause).toBeInstanceOf(SourceMissingError);
	});
});

describe("a missing column header", () => {
	const missing = () => {
		const template = xlsxTemplate("products");
		template.fields.title.from = "Title";
		return template;
	};
	const details = ['Column "Title" not found in the source'];

	it("fails job creation for an uploaded workbook, dry run or real", async () => {
		const { deps, staging, stage } = setup();
		const book = await stage(await productsXlsx(1));
		for (const dryRun of [true, false]) {
			const error = await failure(
				startImport(deps, staging, { uploadId: book, template: missing(), dryRun }, fields),
			);
			expect(error).toMatchObject({ code: "invalid_template", details });
		}
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("fails job creation for a fetched workbook, dry run or real", async () => {
		const { deps, storage, staging } = setup();
		const bytes = await productsXlsx(1);
		const sources = {
			sources: new MemoryKv<SourceRow>(),
			jobs: deps.jobs,
			settings: new MemorySettings(),
			storage,
			net: {
				allowPrivateNetwork: false,
				resolver: async () => ["93.184.215.14"],
				fetch: async () => new Response(bytes),
			},
			limits: { ...FETCH_LIMITS, maxBytes: 10 * MIB },
			workers: false,
			now: () => Date.parse("2026-10-26T09:00:00Z"),
			newId: () => "S1",
		};
		await createSource(sources, { name: "A", url: "https://feeds.example.com/products.xlsx" });
		for (const dryRun of [true, false]) {
			const template = missing();
			const limits = fetchLimitsFor(template, sources.limits, staging.maxXlsxBytes);
			const error = await failure(
				jobFromSource(
					{ ...sources, limits },
					"S1",
					{ force: true, dryRun, template: null },
					(uploadId) => startImport(deps, staging, { uploadId, template, dryRun }, fields),
				),
			);
			expect(error).toMatchObject({ code: "invalid_template", details });
		}
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("refuses an XLSX job given no columns, which must never happen", async () => {
		const { deps, stage } = setup();
		const book = await stage(await productsXlsx(1));
		await expect(
			startJob(deps, { uploadId: book, template: xlsxTemplate("products"), dryRun: true }, fields),
		).rejects.toThrow("An XLSX job was created without the converted columns");
	});
});

describe("sampleImport", () => {
	it("samples an XLSX sheet with its header names as paths, converting only what it needs", async () => {
		const { deps, staging, stage } = setup();
		// Row 4 does not parse: a job would fail on it, but a sample of two rows stops before it.
		const book = await stage(
			await workbook({
				sheets: [
					{
						name: "Sheet1",
						rows:
							row(
								1,
								'<c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>Unit Price</t></is></c>',
							) +
							row(2, '<c r="A2" t="inlineStr"><is><t>A1</t></is></c><c r="B2"><v>1.5</v></c>') +
							row(3, '<c r="A3" t="inlineStr"><is><t>A2</t></is></c>') +
							'<row r="4"><c><v>&nbsp;</v></c></row>',
					},
				],
			}),
		);
		expect(await sampleImport(deps, staging, book, 2, { format: "xlsx" })).toEqual({
			records: [
				{ sku: "A1", "Unit Price": 1.5, _row: 2 },
				{ sku: "A2", "Unit Price": null, _row: 3 },
			],
			paths: ["sku", "Unit Price"],
		});
		const error = await failure(sampleImport(deps, staging, book, 3, { format: "xlsx" }));
		expect(error).toMatchObject({
			code: "INVALID_SOURCE",
			status: 400,
			message: "The part xl/worksheets/sheet1.xml has a row after row 3 that is not valid XML",
		});
	});

	it("reports a bad block, a missing upload and a file that is not a workbook", async () => {
		const { deps, staging, stage } = setup();
		const csv = await stage(new TextEncoder().encode("sku\nA1\n"));
		await expect(
			sampleImport(deps, staging, csv, 2, { format: "xlsx", records: "x" }),
		).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: "source.records is not allowed for xlsx",
		});
		await expect(sampleImport(deps, staging, csv, 2, { format: "xlsx" })).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			message: "The file is not an .xlsx workbook (it is not a zip archive)",
		});
		const missing = `01JZ0000000000000000000000${"0".repeat(32)}`;
		await expect(sampleImport(deps, staging, missing, 2, { format: "xlsx" })).rejects.toMatchObject(
			{
				code: "UPLOAD_NOT_FOUND",
				status: 404,
			},
		);
		// Other formats sample as before.
		expect(await sampleImport(deps, staging, csv, 2)).toEqual({ headers: ["sku"], rows: [["A1"]] });
	});
});

describe("xlsxSource and fetchLimitsFor", () => {
	it("finds a valid XLSX block and caps an XLSX source's fetch at the XLSX file limit", () => {
		expect(xlsxSource(xlsxTemplate("p", { sheet: 2 }))).toEqual({ format: "xlsx", sheet: 2 });
		expect(xlsxSource({ source: { format: "csv" } })).toBeNull();
		expect(xlsxSource({ source: { format: "xlsx", headerRow: 0 } })).toBeNull();
		expect(xlsxSource({ source: { format: "xlsx", records: "x" } })).toBeNull();
		expect(xlsxSource(null)).toBeNull();
		const limits = { ...FETCH_LIMITS, maxBytes: 50 * MIB };
		expect(fetchLimitsFor(xlsxTemplate("p"), limits, XLSX_MAX_BYTES)).toEqual({
			...limits,
			maxBytes: XLSX_MAX_BYTES,
		});
		expect(fetchLimitsFor({ source: { format: "csv" } }, limits, XLSX_MAX_BYTES)).toBe(limits);
	});
});
