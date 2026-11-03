import { describe, expect, it } from "vitest";
import {
	I18N_REQUIRED_MESSAGE,
	resolveSiteLocale,
	resolveTranslationLocale,
} from "../../src/emdash/locale.js";
import { listSchemaFields, type SchemaRegistryLike } from "../../src/emdash/schema.js";
import { EmDashUploads, stageUpload } from "../../src/emdash/uploads.js";
import { createJob, JobError } from "../../src/engine/jobs.js";
import {
	checkTemplate,
	type SchemaField,
	sharedRequiredOf,
	type Template,
	targetFieldsOf,
	templatePaths,
	templateSchema,
	translationWarnings,
	usesLinks,
} from "../../src/engine/template.js";
import { startJob, WORKERS_LINKED_BATCH_CAP, workersBatchCap } from "../../src/plugin/service.js";
import { startImport, XLSX_WORKERS_BUFFER, type XlsxStaging } from "../../src/plugin/xlsx.js";
import { productsXlsx, xlsxTemplate } from "../fixtures/xlsx.js";
import { FakeStorage, makeDeps } from "./fakes.js";
import { streamOf } from "./helpers.js";

const i18n = { defaultLocale: "en", locales: ["en", "fr", "de"] };

const raw = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	fields: { title: { from: "Nom", type: "text" } },
	...extra,
});
const parse = (extra: Record<string, unknown> = {}): Template => templateSchema.parse(raw(extra));

const fields: SchemaField[] = [
	{ slug: "title", type: "string", required: true },
	{ slug: "sku", type: "string", required: true, translatable: false },
	{ slug: "price", type: "number", translatable: false },
	{ slug: "weight", type: "number", required: true, hasDefault: true, translatable: false },
	{ slug: "flux_source_id", type: "string", translatable: false },
];

describe("translationOf in the template", () => {
	it("reads one of from and expr, with an optional locale", () => {
		expect(parse().translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(parse({ translationOf: { expr: "en_id" } }).translationOf).toEqual({ expr: "en_id" });
		for (const bad of [
			{},
			{ from: "a", expr: "b" },
			{ from: "a", locale: "" },
			{ from: "a", match: "slug" },
			"en_id",
		]) {
			expect(templateSchema.safeParse(raw({ translationOf: bad })).success).toBe(false);
		}
		expect(templateSchema.parse(raw({ translationOf: undefined })).translationOf).toBeUndefined();
	});

	it("checks its column against the CSV header", () => {
		const t = parse();
		expect(templatePaths(t)).toEqual(["id", "en_id", "Nom"]);
		expect(checkTemplate(t, fields, ["id", "Nom"])).toEqual([
			'Column "en_id" not found in the source',
		]);
	});

	it("needs a source locale other than the job's", () => {
		const own = fields.filter((f) => f.slug === "title");
		expect(checkTemplate(parse(), own, null)).toEqual([]);
		expect(checkTemplate(parse({ translationOf: { from: "en_id" } }), own, null)).toEqual([
			"translationOf.locale is not set",
		]);
		expect(
			checkTemplate(parse({ translationOf: { from: "en_id", locale: "FR" } }), own, null),
		).toEqual(['translationOf.locale must differ from locale ("fr")']);
	});

	it("leaves required non-translatable fields to EmDash, and lists them as shared required", () => {
		const t = parse();
		expect(checkTemplate(t, fields, null)).toEqual([]);
		expect(sharedRequiredOf(t, fields)).toEqual(["sku"]);
		// A translatable required field must still be mapped.
		const untitled = parse({ fields: { sku: { from: "SKU", type: "text" } } });
		expect(checkTemplate(untitled, fields, null)).toEqual([
			'Field "title" is required and has no default, but the template does not map it',
		]);
		expect(sharedRequiredOf(untitled, fields)).toEqual([]);
		// Without translationOf nothing changes.
		const plain = parse({ translationOf: undefined, locale: "en" });
		expect(checkTemplate(plain, fields, null)).toEqual([
			'Field "sku" is required and has no default, but the template does not map it',
		]);
		expect(sharedRequiredOf(plain, fields)).toEqual([]);
	});

	it("records translatable: false in the field snapshot only when it is false", () => {
		const t = parse({
			fields: {
				title: { from: "Nom", type: "text" },
				price: { from: "Prix", type: "number" },
			},
		});
		expect(targetFieldsOf(t, fields)).toEqual({
			title: { type: "string", required: true },
			price: { type: "number", required: false, translatable: false },
		});
	});

	it("warns once about the mappings records with a value leave to EmDash", () => {
		const t = parse({
			fields: {
				title: { from: "Nom", type: "text" },
				sku: { from: "SKU", type: "text" },
				price: { from: "Prix", type: "number" },
				related: { from: "Related", type: "reference", match: "key" },
			},
			taxonomies: { category: { from: "Category" } },
		});
		const targets = targetFieldsOf(t, [
			...fields,
			{ slug: "related", type: "reference", storageless: true, targetCollection: "products" },
		]);
		expect(translationWarnings(t, targets)).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "sku", "price"; reference field "related"; taxonomy "category"',
		]);
		const one = parse({ fields: { price: { from: "Prix", type: "number" } } });
		expect(translationWarnings(one, targetFieldsOf(one, fields))).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: field "price"',
		]);
		const none = parse();
		expect(translationWarnings(none, targetFieldsOf(none, fields))).toEqual([]);
		const plain = parse({
			translationOf: undefined,
			fields: { price: { from: "Prix", type: "number" } },
		});
		expect(translationWarnings(plain, targetFieldsOf(plain, fields))).toEqual([]);
	});

	it("warns about non-translatable image and portableText mappings", () => {
		const schema: SchemaField[] = [
			{ slug: "title", type: "string", required: true },
			{ slug: "hero", type: "image", translatable: false },
			{ slug: "body", type: "portableText", translatable: false },
			{ slug: "notes", type: "portableText" },
		];
		const t = parse({
			fields: {
				title: { from: "Nom", type: "text" },
				hero: { from: "Photo", type: "image" },
				body: { from: "Body", type: "portableText", format: "html" },
				notes: { from: "Notes", type: "portableText", format: "text" },
			},
		});
		expect(translationWarnings(t, targetFieldsOf(t, schema))).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: fields "hero", "body"',
		]);
	});

	it("counts as a template with links", () => {
		const t = parse();
		expect(usesLinks(t)).toBe(true);
		expect(usesLinks({ ...t, translationOf: undefined })).toBe(false);
	});
});

describe("translatable in the schema snapshot", () => {
	it("reads Field.translatable, recording only false", async () => {
		const registry = {
			getCollectionWithFields: async () => ({
				fields: [
					{ slug: "title", type: "string" },
					{ slug: "body", type: "text", translatable: true },
					{ slug: "sku", type: "string", translatable: false },
				],
			}),
		} as unknown as SchemaRegistryLike;
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string", required: false, hasDefault: false, validation: {} },
			{ slug: "body", type: "text", required: false, hasDefault: false, validation: {} },
			{
				slug: "sku",
				type: "string",
				required: false,
				hasDefault: false,
				validation: {},
				translatable: false,
			},
		]);
	});
});

describe("resolveTranslationLocale", () => {
	it("needs i18n with at least two locales", () => {
		const refused = { ok: false, message: I18N_REQUIRED_MESSAGE };
		expect(resolveTranslationLocale("en", "fr", null)).toEqual(refused);
		expect(resolveTranslationLocale("en", "fr", { defaultLocale: "en", locales: ["en"] })).toEqual(
			refused,
		);
		expect(I18N_REQUIRED_MESSAGE).toBe("translationOf needs i18n with at least two locales");
	});

	it("resolves a given locale like the job's, and defaults to the site's default locale", () => {
		expect(resolveTranslationLocale("EN", "fr", i18n)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale("de", "fr", i18n)).toEqual({ ok: true, locale: "de" });
		expect(resolveTranslationLocale(undefined, "fr", i18n)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale("es", "fr", i18n)).toEqual({
			ok: false,
			message: 'translationOf.locale: Locale "es" is not configured for this site',
		});
		expect(resolveTranslationLocale(undefined, "en", i18n)).toEqual({
			ok: false,
			message: 'translationOf.locale is required: locale is the default locale ("en")',
		});
	});
});

describe("startJob and createJob with translationOf", () => {
	const csv = "id,en_id,Nom,Prix\nF1,E1,Bureau,10\n";
	const resolveLocale = (locale: string) => resolveSiteLocale(locale, i18n);
	const resolveTranslation = (source: string | undefined, locale: string) =>
		resolveTranslationLocale(source, locale, i18n);
	const lookup = async () => fields;

	it("stores the resolved source locale, the shared required fields and the warning", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const template = raw({
			locale: "FR",
			translationOf: { from: "en_id" },
			fields: { title: { from: "Nom", type: "text" }, price: { from: "Prix", type: "number" } },
		});
		const job = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false },
			lookup,
			resolveLocale,
			resolveTranslation,
		);
		expect(job.template.locale).toBe("fr");
		expect(job.template.translationOf).toEqual({ from: "en_id", locale: "en" });
		expect(job.sharedRequired).toEqual(["sku"]);
		expect(job.targetFields?.price).toEqual({
			type: "number",
			required: false,
			translatable: false,
		});
		expect(job.warnings).toEqual([
			'Records with a translationOf value leave these to EmDash, which shares them across the translation group: field "price"',
		]);
		expect(workersBatchCap(job)).toBe(WORKERS_LINKED_BATCH_CAP);
	});

	it("refuses translationOf without i18n, or with a locale the site cannot use", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const input = { uploadId: "u1", template: raw(), dryRun: false };
		await expect(startJob(deps, input, lookup)).rejects.toMatchObject({
			code: "invalid_template",
			details: [I18N_REQUIRED_MESSAGE],
		});
		const own = { ...input, template: raw({ locale: "en", translationOf: { from: "en_id" } }) };
		await expect(
			startJob(deps, own, lookup, resolveLocale, resolveTranslation),
		).rejects.toMatchObject({
			details: ['translationOf.locale is required: locale is the default locale ("en")'],
		});
		const same = { ...input, template: raw({ translationOf: { from: "en_id", locale: "Fr" } }) };
		await expect(
			startJob(deps, same, lookup, resolveLocale, resolveTranslation),
		).rejects.toMatchObject({
			details: ['translationOf.locale must differ from locale ("fr")'],
		});
		expect(deps.jobs.rows.size).toBe(0);
	});

	it("leaves a malformed translationOf to the template schema", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const template = raw({ translationOf: { from: "en_id", locale: 7 } });
		const error = await startJob(
			deps,
			{ uploadId: "u1", template, dryRun: false },
			lookup,
			resolveLocale,
			resolveTranslation,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JobError);
		expect((error as JobError).details).toEqual([
			"translationOf.locale: Invalid input: expected string, received number",
		]);
	});

	it("stores no shared required fields when every one is mapped or has a default", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", "id,en_id,Nom,SKU\nF1,E1,Bureau,S\n");
		const template = raw({
			fields: { title: { from: "Nom", type: "text" }, sku: { from: "SKU", type: "text" } },
		});
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields: fields });
		expect(job.sharedRequired).toBeUndefined();
	});

	it("leaves an array translationOf to the template schema", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv);
		const error = await startJob(
			deps,
			{ uploadId: "u1", template: raw({ translationOf: [] }), dryRun: false },
			lookup,
			resolveLocale,
			resolveTranslation,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JobError);
		expect((error as JobError).details).toEqual([
			"translationOf: Invalid input: expected object, received array",
		]);
	});

	describe("through startImport", () => {
		const calls: Array<[string | undefined, string]> = [];
		const spy = (source: string | undefined, locale: string) => {
			calls.push([source, locale]);
			return resolveTranslationLocale(source, locale, i18n);
		};

		it("passes the resolver on for an XLSX template and for a plain one", async () => {
			const storage = new FakeStorage();
			const uploads = new EmDashUploads(storage);
			const deps = { ...makeDeps().deps, source: uploads };
			const staging: XlsxStaging = {
				storage,
				maxXlsxBytes: 10 * 1024 * 1024,
				maxSourceBytes: 50 * 1024 * 1024,
				workers: false,
				bufferBytes: XLSX_WORKERS_BUFFER,
			};
			const bytes = await productsXlsx(2);
			const book = (await stageUpload(storage, streamOf(bytes), 100 * 1024 * 1024, bytes.length))
				.uploadId;
			const schema = async () => [
				{ slug: "title", type: "string" },
				{ slug: "price", type: "number" },
				{ slug: "released", type: "datetime" },
			];
			const xlsx = await startImport(
				deps,
				staging,
				{
					uploadId: book,
					template: {
						...xlsxTemplate("products"),
						locale: "FR",
						translationOf: { from: "Handle" },
					},
					dryRun: false,
				},
				schema,
				resolveLocale,
				spy,
			);
			expect(xlsx.template.translationOf).toEqual({ from: "Handle", locale: "en" });
			expect(calls).toEqual([[undefined, "fr"]]);

			const fake = makeDeps().deps;
			fake.source.add("u1", csv);
			const plain = await startImport(
				fake,
				staging,
				{ uploadId: "u1", template: raw({ translationOf: { from: "en_id" } }), dryRun: false },
				lookup,
				resolveLocale,
				spy,
			);
			expect(plain.template.translationOf).toEqual({ from: "en_id", locale: "en" });
			expect(calls).toHaveLength(2);
		});
	});
});
