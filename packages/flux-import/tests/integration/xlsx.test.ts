import { describe, expect, inject, it } from "vitest";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { ApiError, Client } from "./client.js";
import { TEST_MAX_SOURCE_BYTES } from "./server.js";

const client = new Client(inject("baseUrl"), inject("token"));
const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

describe("XLSX end to end (10 rows)", () => {
	it("uploads, samples and imports a workbook with dates, numbers, booleans, a filter and an expression", async () => {
		await client.createProducts("it_xlsx");
		const bytes = await productsXlsx(10);
		const upload = await client.upload(bytes, "Products 2026.xlsx");
		expect(upload.bytes).toBe(bytes.length);

		const sample = await client.plugin<{ records: unknown[]; paths: string[] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 2,
			source: { format: "xlsx", sheet: "Products" },
		});
		expect(sample).toEqual({
			paths: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			records: [
				{
					sku: "SKU-0",
					Name: 'Product 0, "quoted" & <tagged> ț',
					Price: 0.5,
					Released: "2026-03-01",
					Active: false,
					Handle: "product-0",
					_row: 2,
				},
				{
					sku: "SKU-1",
					Name: 'Product 1, "quoted" & <tagged> ț',
					Price: 1.5,
					Released: "2026-03-02",
					Active: true,
					Handle: "product-1",
					_row: 3,
				},
			],
		});

		const base = xlsxTemplate("it_xlsx", { sheet: 1, filter: "Active" });
		const template = {
			...base,
			fields: { ...base.fields, title: { expr: "sku & ' / row ' & _row", type: "text" } },
		};
		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template,
			dryRun: false,
			batchSize: 3,
		});
		expect(job).toMatchObject({
			status: "created",
			sourceUploadId: upload.uploadId,
			columns: ["sku", "Name", "Price", "Released", "Active", "Handle"],
			warnings: [],
		});
		expect(job.uploadId).not.toBe(upload.uploadId);
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 5, filtered: 5, failed: 0 },
		});

		const entries = await client.listAll("it_xlsx");
		expect(entries.map((e) => e.data.flux_source_id).sort()).toEqual([
			"SKU-1",
			"SKU-3",
			"SKU-5",
			"SKU-7",
			"SKU-9",
		]);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-1")!;
		expect(first).toMatchObject({ slug: "product-1", status: "published" });
		expect(first.data).toMatchObject({ title: "SKU-1 / row 3", price: 1.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-03-01T22:00:00.000Z"));
	});

	it("fails job creation with INVALID_SOURCE when the sheet does not exist", async () => {
		const { uploadId } = await client.upload(await productsXlsx(1), "book.xlsx");
		const error = await failure(
			client.plugin("jobs/create", {
				uploadId,
				template: xlsxTemplate("it_xlsx", { sheet: "Stock" }),
				dryRun: true,
			}),
		);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 400,
			code: "INVALID_SOURCE",
			message:
				'400 INVALID_SOURCE: The workbook has no sheet named "Stock"; its sheets are "Products"',
		});
	});

	it("refuses a pasted workbook, other spreadsheet files and a workbook over the limit", async () => {
		const pasted = await failure(client.plugin("sources/paste", { format: "xlsx", text: "PK" }));
		expect(pasted).toMatchObject({ status: 400, code: "INVALID_FORMAT" });
		const xls = await client.uploadRaw(await productsXlsx(1), "book.xls");
		expect(xls.status).toBe(415);
		// The shared server's maxSourceBytes is below 10 MiB, so it is the XLSX limit too.
		const big = await client.uploadRaw(new Uint8Array(TEST_MAX_SOURCE_BYTES + 1), "big.xlsx");
		expect(big.status).toBe(413);
		expect((await big.json()) as unknown).toMatchObject({ error: { code: "TOO_LARGE" } });
	});
});
