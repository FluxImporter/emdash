import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob, JobError, JobExistsError, transitionJob } from "../../src/engine/jobs.js";
import { SourceMissingError } from "../../src/engine/ports.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];

function setup(csv = "sku,Name\nA1,Desk\n") {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", csv);
	return { deps, clock };
}

describe("createJob", () => {
	it("records an agent job's origin and the dry run it ran (M6c)", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			origin: "agent",
			dryRunOf: "D1",
		});
		expect(job).toMatchObject({ origin: "agent", dryRunOf: "D1" });
		expect(await deps.jobs.get(job.id)).toMatchObject({ origin: "agent", dryRunOf: "D1" });
		const plain = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(plain).not.toHaveProperty("origin");
		expect(plain).not.toHaveProperty("dryRunOf");
	});

	it("creates a job positioned after the header with defaults", async () => {
		const { deps } = setup("﻿sku,Name\r\nA1,Desk\r\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(job).toMatchObject({
			status: "created",
			dryRun: false,
			publish: true,
			batchSize: 50,
			budgetMs: 4000,
			source: { format: "csv" },
			columns: ["sku", "Name"],
			warnings: [],
			cursor: { offset: 3 + "sku,Name\r\n".length, seq: 0 },
			phase: "import",
			lease: null,
			schemaReady: false,
			error: null,
			failures: 0,
		});
		expect(await deps.jobs.get(job.id)).toEqual(job);
	});

	it("keeps publish: false when asked", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields, publish: false });
		expect(job.publish).toBe(false);
	});

	it.each([
		["batch size above 500", { batchSize: 501 }],
		["batch size of zero", { batchSize: 0 }],
		["fractional batch size", { batchSize: 1.5 }],
		["budget below 500 ms", { budgetMs: 100 }],
		["budget above 25 s", { budgetMs: 30_000 }],
	])("rejects %s", async (_name, opts) => {
		const { deps } = setup();
		await expect(
			createJob(deps, { uploadId: "u1", template, schemaFields, ...opts }),
		).rejects.toMatchObject({
			code: "invalid_options",
		});
	});

	it("rejects an invalid template with the Zod messages as details", async () => {
		const { deps } = setup();
		const err = await createJob(deps, {
			uploadId: "u1",
			template: { ...template, version: 9 },
			schemaFields,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(JobError);
		expect(err.code).toBe("invalid_template");
		expect(err.details.length).toBeGreaterThan(0);
	});

	it("rejects a template that does not fit the source or schema", async () => {
		const { deps } = setup("code,Name\nA1,Desk\n");
		await expect(createJob(deps, { uploadId: "u1", template, schemaFields })).rejects.toMatchObject(
			{
				code: "invalid_template",
				details: ['Column "sku" not found in the source'],
			},
		);
	});

	it("stores the target field snapshot, and the site timezone only for tz: site", async () => {
		const { deps } = setup("sku,Name,Day\nA1,Desk,2026-03-01\n");
		const fields = [
			{ slug: "title", type: "string", required: true, validation: { maxLength: 40 } },
			{ slug: "day", type: "datetime" },
			{ slug: "body", type: "text" },
		];
		const dated = (tz: string) => ({
			...template,
			fields: { ...template.fields, day: { from: "Day", type: "date", tz } },
		});
		const job = await createJob(deps, {
			uploadId: "u1",
			template: dated("site"),
			schemaFields: fields,
			siteTimezone: "Europe/Chisinau",
		});
		expect(job).toMatchObject({
			targetFields: {
				title: { type: "string", required: true, maxLength: 40 },
				day: { type: "datetime", required: false },
			},
			siteTimezone: "Europe/Chisinau",
		});
		expect(job.targetFields).not.toHaveProperty("body");
		const fixed = await createJob(deps, {
			uploadId: "u1",
			template: dated("Asia/Tokyo"),
			schemaFields: fields,
			siteTimezone: "Europe/Chisinau",
		});
		expect(fixed).not.toHaveProperty("siteTimezone");
		const unset = await createJob(deps, {
			uploadId: "u1",
			template: dated("site"),
			schemaFields: fields,
		});
		expect(unset.siteTimezone).toBe("UTC");
	});

	it("refuses tz: site with an invalid site timezone, and unmapped required fields", async () => {
		const { deps } = setup("sku,Name,Day\nA1,Desk,2026-03-01\n");
		const err = await createJob(deps, {
			uploadId: "u1",
			template: { ...template, fields: { day: { from: "Day", type: "date", tz: "site" } } },
			schemaFields: [
				{ slug: "title", type: "string", required: true },
				{ slug: "day", type: "datetime" },
			],
			siteTimezone: "Moon/Base",
		}).catch((e: unknown) => e);
		expect(err).toMatchObject({
			code: "invalid_template",
			details: [
				'Field "day" reads dates in the site timezone, but "Moon/Base" is not a valid IANA timezone',
				'Field "title" is required and has no default, but the template does not map it',
			],
		});
	});

	it("rejects bad expressions with invalid_template, naming each one", async () => {
		const { deps } = setup();
		const bad = {
			...template,
			source: { format: "csv", filter: "Name = " },
			key: { expr: "$now()" },
		};
		await expect(
			createJob(deps, { uploadId: "u1", template: bad, schemaFields }),
		).rejects.toMatchObject({
			code: "invalid_template",
			message: "The template has invalid expressions",
			details: [
				"source.filter: JSONata S0207 at character 7: Unexpected end of expression",
				"key.expr: $now cannot be used: expressions must give the same result on every run",
			],
		});
		const both = { ...template, key: { from: "sku", expr: "sku" } };
		await expect(
			createJob(deps, { uploadId: "u1", template: both, schemaFields }),
		).rejects.toMatchObject({
			code: "invalid_template",
			details: ['key: Set exactly one of "from" and "expr"'],
		});
	});

	it("checks only from columns against the CSV header", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template: {
				...template,
				source: { format: "csv", filter: "Missing = 'x'" },
				fields: { title: { expr: "Nowhere & Name", type: "text" } },
			},
			schemaFields,
		});
		expect(job).toMatchObject({
			status: "created",
			source: { format: "csv", filter: "Missing = 'x'" },
			counters: { filtered: 0 },
		});
	});

	it("rejects a missing upload or unreadable header", async () => {
		const { deps } = setup('sku,"Name\n');
		await expect(
			createJob(deps, { uploadId: "nope", template, schemaFields }),
		).rejects.toMatchObject({ code: "invalid_source" });
		await expect(createJob(deps, { uploadId: "u1", template, schemaFields })).rejects.toMatchObject(
			{ code: "invalid_source" },
		);
	});
	it("takes a given ID, and refuses a second job under it with JobExistsError (M6c)", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { id: "R1", uploadId: "u1", template, schemaFields });
		expect(job.id).toBe("R1");
		expect(await deps.jobs.get("R1")).toMatchObject({ id: "R1", status: "created" });
		const again = createJob(deps, { id: "R1", uploadId: "u1", template, schemaFields });
		await expect(again).rejects.toBeInstanceOf(JobExistsError);
		await expect(again).rejects.toThrow("Job id R1 already exists");
		expect((await createJob(deps, { uploadId: "u1", template, schemaFields })).id).toBe(
			"id00000001",
		);
	});

	it("keeps a missing upload's SourceMissingError as the cause (M6c)", async () => {
		const { deps } = setup();
		const error = await createJob(deps, { uploadId: "gone", template, schemaFields }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(JobError);
		expect(error).toMatchObject({ code: "invalid_source", message: "Upload gone not found" });
		expect((error as JobError).cause).toBeInstanceOf(SourceMissingError);
	});
});

describe("createJob for converted XLSX", () => {
	const xlsxT = (fields: object, key: object = { from: "sku" }) => ({
		...template,
		source: { format: "xlsx", sheet: "Products" },
		key,
		fields,
	});
	const LINES = '{"sku":"A1","Name":"Desk","_row":2}\n{"sku":"A2","Name":null,"_row":4}\n';

	it("reads the converted JSON Lines, keeping the header columns, warnings and workbook", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", LINES);
		const job = await createJob(deps, {
			uploadId: "converted",
			sourceUploadId: "workbook",
			columns: ["sku", "Name"],
			warnings: ['Column C has no header; it is named "column_C"'],
			template: xlsxT({ title: { from: "Name", type: "text" } }),
			schemaFields,
		});
		expect(job).toMatchObject({
			uploadId: "converted",
			sourceUploadId: "workbook",
			source: { format: "xlsx", sheet: "Products" },
			columns: ["sku", "Name"],
			warnings: ['Column C has no header; it is named "column_C"'],
			cursor: { offset: 0, seq: 0 },
		});
		await runBatch(deps, job.id, "driver");
		expect(
			[...deps.content.entries.values()].map((e) => [e.data.flux_source_id, e.data.title]),
		).toEqual([
			["A1", "Desk"],
			["A2", null],
		]);
	});

	it("fails a from column missing from the header like CSV, but lets the key read _row", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", LINES);
		const create = (fields: object, key?: object) =>
			createJob(deps, {
				uploadId: "converted",
				columns: ["sku", "Name"],
				template: xlsxT(fields, key),
				schemaFields,
			});
		await expect(create({ title: { from: "Title", type: "text" } })).rejects.toMatchObject({
			code: "invalid_template",
			details: ['Column "Title" not found in the source'],
		});
		const byRow = await create({ title: { from: "Name", type: "text" } }, { from: "_row" });
		expect(byRow.warnings).toEqual([]);
	});

	it("warns when the converted sheet has no records", async () => {
		const { deps } = makeDeps();
		deps.source.add("converted", "");
		const job = await createJob(deps, {
			uploadId: "converted",
			columns: ["sku", "Name"],
			template: xlsxT({ title: { from: "Name", type: "text" } }),
			schemaFields,
		});
		expect(job.warnings).toEqual(["No records found in the file"]);
	});
});

describe("createJob for JSON, JSON Lines and XML", () => {
	const jsonT = (source: object, fields: object = { title: { from: "name", type: "text" } }) => ({
		...template,
		source,
		fields,
	});

	it("positions the cursor on the records array and stores the source without columns", async () => {
		const { deps } = makeDeps();
		const body = '{"skip": [1, "]"], "data": {"items": [{"sku": "A1", "name": "Desk"}]}}';
		deps.source.add("u1", body);
		const source = { format: "json", records: "data.items" };
		const job = await createJob(deps, { uploadId: "u1", template: jsonT(source), schemaFields });
		expect(job).toMatchObject({
			source,
			warnings: [],
			cursor: { offset: body.indexOf("[{") + 1, seq: 0 },
		});
		expect(job).not.toHaveProperty("columns");
		expect(job).not.toHaveProperty("headers");
	});

	it("warns about from paths only, not about paths an expression reads", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", JSON.stringify([{ sku: "S1" }]));
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT(
				{ format: "json", filter: "nowhere = 1" },
				{ title: { expr: "missing.path", type: "text" } },
			),
			schemaFields,
		});
		expect(job.warnings).toEqual([]);
	});

	it("stores a warning for each path none of the first 20 records has", async () => {
		const { deps } = makeDeps();
		const rows = Array.from({ length: 25 }, (_, i) => ({
			sku: `S${i}`,
			...(i === 24 ? { name: "late" } : {}),
		}));
		deps.source.add("u1", JSON.stringify(rows));
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual(['Path "name" was not found in the first 20 records']);
	});

	it("creates the job when the sample hits a structural error; the run fails there", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '[{"sku": "A1", "name": "Desk"}, {"sku": "open');
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual([]);
		let run = job;
		for (let i = 0; i < 10 && (run.status === "created" || run.status === "running"); i++) {
			run = await runBatch(deps, job.id, "driver");
		}
		expect(run).toMatchObject({
			status: "failed",
			counters: { created: 1 },
			error: { code: "source_syntax" },
		});
	});

	it.each([
		["an empty JSON array", "[]", { format: "json" }, "No records found in the file"],
		["an empty JSON Lines file", "\n", { format: "jsonl" }, "No records found in the file"],
		[
			"an empty records path",
			'{"data": []}',
			{ format: "json", records: "data" },
			'No records found at "data"',
		],
		[
			"an Atom feed read as feed/item",
			"<feed><entry><title>Desk</title></entry></feed>",
			{ format: "xml", records: "feed/item" },
			'No records found at "feed/item"',
		],
	])("warns that %s has no records", async (_name, body, source, warning) => {
		const { deps } = makeDeps();
		deps.source.add("u1", body);
		const job = await createJob(deps, { uploadId: "u1", template: jsonT(source), schemaFields });
		expect(job.warnings).toEqual([warning]);
	});

	it("gives a CSV file without rows no warning", async () => {
		const { deps } = setup("sku,Name\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(job.warnings).toEqual([]);
	});

	it("counts only readable records as checked for missing paths", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '[{"sku": "A1"}, {"sku": }, {"sku": "B2"}]');
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual(['Path "name" was not found in the first 2 records']);
	});

	it("gives no warnings when every sampled record fails to parse", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '[{"sku": }, {"sku": tru}]');
		const job = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "json" }),
			schemaFields,
		});
		expect(job.warnings).toEqual([]);
	});

	it("rejects an XML records path with an invalid element name", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "<feed><item/></feed>");
		const err = await createJob(deps, {
			uploadId: "u1",
			template: jsonT({ format: "xml", records: "feed/1item" }),
			schemaFields,
		}).catch((e: unknown) => e);
		expect(err).toMatchObject({ code: "invalid_source" });
		expect((err as JobError).details.join(" ")).toMatch(/invalid element name "1item"/);
	});

	it.each([
		["records on CSV", { format: "csv", records: "x" }, "[]", /not allowed for csv/],
		["records on JSON Lines", { format: "jsonl", records: "x" }, "{}", /not allowed for jsonl/],
		["XML without records", { format: "xml" }, "<feed/>", /required for xml/],
		[
			"a records path that is not an array",
			{ format: "json", records: "data" },
			'{"data": {}}',
			/not an array/,
		],
		["a top-level object without records", { format: "json" }, '{"data": []}', /source\.records/],
		[
			"a DTD",
			{ format: "xml", records: "feed/item" },
			'<!DOCTYPE feed SYSTEM "x.dtd"><feed/>',
			/DOCTYPE/,
		],
	])("rejects %s with invalid_source", async (_name, source, body, message) => {
		const { deps } = makeDeps();
		deps.source.add("u1", body);
		const err = await createJob(deps, {
			uploadId: "u1",
			template: jsonT(source),
			schemaFields,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JobError);
		expect(err).toMatchObject({ code: "invalid_source" });
		expect([(err as JobError).message, ...(err as JobError).details].join(" ")).toMatch(message);
	});

	it("names the source error code in the details", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", '<!DOCTYPE feed [<!ENTITY x "y">]><feed/>');
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: jsonT({ format: "xml", records: "feed/item" }),
				schemaFields,
			}),
		).rejects.toMatchObject({
			code: "invalid_source",
			details: ["xml_dtd_not_allowed at byte 0"],
			sourceCode: "xml_dtd_not_allowed",
		});
	});

	it("rejects a field path that is not valid for the format", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "[]");
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: jsonT({ format: "json" }, { title: { from: "name.", type: "text" } }),
				schemaFields,
			}),
		).rejects.toMatchObject({ code: "invalid_template", details: ['"name." has an empty key'] });
	});
});

describe("createJob with links", () => {
	const linked = {
		...template,
		fields: { title: { from: "Name", type: "text" }, maker: { from: "Maker", type: "reference" } },
		taxonomies: { category: { from: "Cat" }, tag: { from: "Tag", hierarchy: ">" } },
	};
	const linkedFields = [
		{ slug: "title", type: "string" },
		{
			slug: "maker",
			type: "reference",
			storageless: true,
			relationSide: "parent" as const,
			targetCollection: "makers",
		},
	];
	const taxonomies = [
		{ name: "category", hierarchical: true, collections: ["products"], locale: "en" },
		{ name: "tag", hierarchical: false, collections: ["products"], locale: "en" },
	];

	it("stores the taxonomy snapshot, the reference snapshot and the link warnings", async () => {
		const { deps } = setup("sku,Name,Maker,Cat,Tag\n");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: linked,
			schemaFields: linkedFields,
			linkSchema: { targets: { makers: [] }, taxonomies },
		});
		expect(job.taxonomies).toEqual({
			category: { hierarchical: true },
			tag: { hierarchical: false },
		});
		expect(job.targetFields?.maker).toEqual({
			type: "reference",
			required: false,
			relationSide: "parent",
			targetCollection: "makers",
		});
		expect(job.warnings).toEqual(['Taxonomy "tag" is flat; its "hierarchy" separator is ignored']);
		const plain = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect(plain).not.toHaveProperty("taxonomies");
	});

	it("refuses a missing target collection and an unattached taxonomy", async () => {
		const { deps } = setup("sku,Name,Maker,Cat,Tag\n");
		await expect(
			createJob(deps, {
				uploadId: "u1",
				template: linked,
				schemaFields: linkedFields,
				linkSchema: { targets: { makers: null }, taxonomies: taxonomies.slice(1) },
			}),
		).rejects.toMatchObject({
			code: "invalid_template",
			details: [
				'Field "maker" links to collection "makers", which does not exist',
				'Taxonomy "category" does not exist',
			],
		});
	});
});

describe("createJob with media", () => {
	const media = {
		...template,
		fields: { title: { from: "Name", type: "text" }, photo: { from: "Name", type: "image" } },
	};
	const mediaFields = [
		{ slug: "title", type: "string" },
		{ slug: "photo", type: "image" },
	];

	it("stores the media size limit only for templates that map media", async () => {
		const { deps } = setup();
		const job = await createJob(deps, {
			uploadId: "u1",
			template: media,
			schemaFields: mediaFields,
			mediaMaxBytes: 1234,
		});
		expect(job.mediaMaxBytes).toBe(1234);
		const unset = await createJob(deps, {
			uploadId: "u1",
			template: media,
			schemaFields: mediaFields,
		});
		expect(unset.mediaMaxBytes).toBe(50 * 1024 * 1024);
		const plain = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			mediaMaxBytes: 1,
		});
		expect(plain).not.toHaveProperty("mediaMaxBytes");
	});
});

describe("transitionJob", () => {
	it("pauses, resumes and cancels", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		expect((await transitionJob(deps, job.id, "pause")).status).toBe("paused");
		expect((await transitionJob(deps, job.id, "resume")).status).toBe("running");
		expect((await transitionJob(deps, job.id, "cancel")).status).toBe("cancelled");
	});

	it("rejects transitions that are not allowed", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await expect(transitionJob(deps, job.id, "resume")).rejects.toMatchObject({
			code: "invalid_transition",
		});
		await expect(transitionJob(deps, job.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
		});
		await transitionJob(deps, job.id, "cancel");
		await expect(transitionJob(deps, job.id, "pause")).rejects.toMatchObject({
			code: "invalid_transition",
		});
	});

	it("clears the error when a failed job resumes", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, {
			...job,
			status: "failed",
			error: { code: "source_missing", message: "gone" },
			failures: 3,
		});
		const resumed = await transitionJob(deps, job.id, "resume");
		expect(resumed).toMatchObject({ status: "running", error: null, failures: 0 });
	});

	it("starts a retry pass only on a completed, non-dry-run job", async () => {
		const { deps } = setup();
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, { ...job, status: "completed" });
		expect(await transitionJob(deps, job.id, "retry")).toMatchObject({
			status: "running",
			phase: "retry",
			retryFromSeq: 0,
		});
		const dry = await createJob(deps, { uploadId: "u1", template, schemaFields, dryRun: true });
		await deps.jobs.put(dry.id, { ...dry, status: "completed" });
		await expect(transitionJob(deps, dry.id, "retry")).rejects.toMatchObject({
			code: "invalid_transition",
		});
	});

	it("reports an unknown job", async () => {
		const { deps } = setup();
		await expect(transitionJob(deps, "missing", "pause")).rejects.toMatchObject({
			code: "not_found",
		});
	});
});
