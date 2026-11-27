import { describe, expect, it } from "vitest";
import {
	listSchemaFields,
	publishAtCollection,
	readCollection,
	readPublishAtCollection,
} from "../../src/emdash/schema.js";
import { needsSiteTimezone } from "../../src/emdash/timezone.js";
import { createJob, JobError } from "../../src/engine/jobs.js";
import { preImage } from "../../src/engine/journal.js";
import type { EntrySnapshot } from "../../src/engine/ports.js";
import {
	applyTemplate,
	checkTemplate,
	compileTemplate,
	mappingNames,
	rulesProblems,
	type SchemaField,
	templatePaths,
	templateSchema,
} from "../../src/engine/template.js";
import { makeDeps } from "./fakes.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "handle" },
	fields: {
		title: { from: "Name", type: "text" },
		price: { from: "Price", type: "number" },
	},
	taxonomies: { category: { from: "Category" } },
	bylines: { from: "Authors" },
};
const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];
const parse = (extra: Record<string, unknown>) => templateSchema.parse({ ...base, ...extra });

describe("the rules and publishAt schemas (M5b)", () => {
	it("accepts every rule and a publishAt mapping, all optional", () => {
		const t = parse({
			publishAt: { from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" },
			rules: { mode: "update", updateFields: ["price"], protectEdited: true },
		});
		expect(t.rules).toEqual({ mode: "update", updateFields: ["price"], protectEdited: true });
		expect(t.publishAt).toEqual({ from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" });
		expect(parse({ publishAt: { expr: "'2026-12-01T09:00:00Z'" } }).publishAt?.tz).toBe("UTC");
		expect(parse({ rules: {} }).rules).toEqual({});
	});

	it("is strict and takes exactly one of from and expr", () => {
		const bad = [
			{ rules: { mode: "replace" } },
			{ rules: { extra: true } },
			{ rules: { updateFields: [] } },
			{ rules: { updateFields: Array.from({ length: 201 }, (_, i) => `f${i}`) } },
			{ rules: { protectEdited: "yes" } },
			{ rules: { updateFields: ["x".repeat(201)] } },
			{ publishAt: { from: "a", expr: "b" } },
			{ publishAt: {} },
			{ publishAt: { from: "a", output: "yyyy" } },
			{ publishAt: { from: "a", tz: "Mars/Olympus" } },
		];
		for (const extra of bad) {
			expect(templateSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
				false,
			);
		}
	});

	it("names each mapping as a record's changes do", () => {
		expect(mappingNames(parse({}))).toEqual([
			"title",
			"price",
			"slug",
			"taxonomies.category",
			"bylines",
		]);
	});

	it("refuses updateFields and protectEdited with mode create, unmapped names and repeats", () => {
		expect(rulesProblems(parse({ rules: { mode: "create", protectEdited: false } }))).toEqual([]);
		const createOnly =
			"rules.updateFields and rules.protectEdited apply to updates; mode create never updates";
		expect(rulesProblems(parse({ rules: { mode: "create", updateFields: ["price"] } }))).toEqual([
			createOnly,
		]);
		expect(rulesProblems(parse({ rules: { mode: "create", protectEdited: true } }))).toEqual([
			createOnly,
		]);
		expect(
			rulesProblems(
				parse({ rules: { updateFields: ["price", "stock", "price", "taxonomies.x"] } }),
			),
		).toEqual([
			'rules.updateFields lists "stock", which the template does not map',
			'rules.updateFields lists "price" more than once',
			'rules.updateFields lists "taxonomies.x", which the template does not map',
		]);
		const t = parse({ rules: { updateFields: ["slug", "bylines", "taxonomies.category"] } });
		expect(rulesProblems(t)).toEqual([]);
		expect(
			checkTemplate(parse({ rules: { updateFields: ["stock"] } }), schemaFields, null),
		).toEqual([]);
	});

	it("checks the site timezone for publishAt with tz site, as for date fields", () => {
		const t = parse({ publishAt: { from: "go", tz: "site" } });
		expect(checkTemplate(t, schemaFields, null, "Mars/Olympus")).toEqual([
			'publishAt reads times in the site timezone, but "Mars/Olympus" is not a valid IANA timezone',
		]);
		expect(checkTemplate(t, schemaFields, null, "Europe/Chisinau")).toEqual([]);
		const utc = parse({ publishAt: { from: "go" } });
		expect(checkTemplate(utc, schemaFields, null, "Mars/Olympus")).toEqual([]);
	});

	it("accepts updateFields naming a shared mapping of a translation template", async () => {
		const translated = {
			...base,
			locale: "fr",
			translationOf: { from: "en_id", locale: "en" },
			taxonomies: undefined,
			bylines: undefined,
			rules: { updateFields: ["price"] },
		};
		const fields: SchemaField[] = [
			{ slug: "title", type: "string" },
			{ slug: "price", type: "number", translatable: false },
		];
		expect(checkTemplate(templateSchema.parse(translated), fields, null)).toEqual([]);
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,handle,Name,Price,en_id\nS1,s1,Desk,10,\n");
		const job = await createJob(deps, {
			uploadId: "u1",
			template: translated,
			schemaFields: fields,
		});
		expect((job.warnings ?? []).join("\n")).toContain('field "price"');
	});

	it("checks the publishAt column like the other paths", () => {
		const t = parse({ publishAt: { from: "go_live" } });
		expect(templatePaths(t)).toContain("go_live");
		expect(checkTemplate(t, schemaFields, ["sku", "handle", "Name", "Price"])).toContain(
			'Column "go_live" not found in the source',
		);
	});
});

describe("publishAt conversion (M5b)", () => {
	const convert = async (extra: Record<string, unknown>, value: unknown, siteTimezone?: string) => {
		const compiled = compileTemplate(parse(extra), siteTimezone ? { siteTimezone } : {});
		if (!compiled.ok) throw new Error(compiled.problems.join("; "));
		return applyTemplate(compiled.compiled, { sku: "A1", handle: "a1", Name: "Desk", go: value });
	};

	it("reads the time as a date into a datetime field: UTC ISO, or null when empty", async () => {
		const plain = await convert({ publishAt: { from: "go" } }, "2026-12-01T09:00:00+02:00");
		expect(plain).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T07:00:00.000Z" } });
		const site = await convert(
			{ publishAt: { from: "go", format: "dd/MM/yyyy HH:mm", tz: "site" } },
			"01/12/2026 09:00",
			"Europe/Chisinau",
		);
		expect(site).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T07:00:00.000Z" } });
		expect(await convert({ publishAt: { from: "go" } }, "")).toMatchObject({
			ok: true,
			value: { publishAt: null },
		});
		const constant = await convert({ publishAt: { expr: "'2026-12-01T09:00:00Z'" } }, null);
		expect(constant).toMatchObject({ ok: true, value: { publishAt: "2026-12-01T09:00:00.000Z" } });
	});

	it("reads a unix time in seconds and an expression over a record path", async () => {
		const seconds = Date.UTC(2026, 11, 1, 9) / 1000;
		expect(await convert({ publishAt: { from: "go", format: "unix" } }, seconds)).toMatchObject({
			ok: true,
			value: { publishAt: "2026-12-01T09:00:00.000Z" },
		});
		expect(await convert({ publishAt: { expr: "go" } }, "2026-12-01T09:00:00Z")).toMatchObject({
			ok: true,
			value: { publishAt: "2026-12-01T09:00:00.000Z" },
		});
	});

	it("leaves publishAt out of a record whose template does not map it", async () => {
		const mapped = await convert({}, "2026-12-01");
		expect(mapped.ok).toBe(true);
		if (mapped.ok) expect(mapped.value).not.toHaveProperty("publishAt");
	});

	it("fails the record with invalid_date or not_scalar, field publishAt", async () => {
		expect(await convert({ publishAt: { from: "go" } }, "next tuesday")).toMatchObject({
			ok: false,
			errors: [{ field: "publishAt", code: "invalid_date" }],
		});
		expect(await convert({ publishAt: { from: "go" } }, { at: 1 })).toMatchObject({
			ok: false,
			errors: [{ field: "publishAt", code: "not_scalar" }],
		});
	});
});

describe("jobs with rules and publishAt (M5b)", () => {
	async function create(extra: Record<string, unknown>, opts: Record<string, unknown> = {}) {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,handle,Name,Price,Category,Authors,go\nS1,s1,Desk,10,,,\n");
		return createJob(deps, {
			uploadId: "u1",
			template: { ...base, ...extra },
			schemaFields,
			...opts,
		});
	}

	it("refuses publishAt with publish: false", async () => {
		const job = create({ publishAt: { from: "go" } }, { publish: false });
		await expect(job).rejects.toBeInstanceOf(JobError);
		await expect(job).rejects.toMatchObject({
			code: "invalid_options",
			message: "publishAt needs publish: true",
		});
	});

	it("refuses rules that cannot apply, as an invalid template", async () => {
		await expect(
			create({ rules: { mode: "create", updateFields: ["price"] } }),
		).rejects.toMatchObject({ code: "invalid_template" });
	});

	it("stores whether the collection keeps revisions when the template maps publishAt", async () => {
		expect((await create({ publishAt: { from: "go" } }, { revisions: false })).revisions).toBe(
			false,
		);
		expect((await create({ publishAt: { from: "go" } })).revisions).toBe(true);
		expect(await create({}, { revisions: false })).not.toHaveProperty("revisions");
	});

	it("stores the site time zone for publishAt with tz site", async () => {
		const job = await create(
			{ publishAt: { from: "go", tz: "site" } },
			{ siteTimezone: "Europe/Chisinau" },
		);
		expect(job.siteTimezone).toBe("Europe/Chisinau");
		expect(needsSiteTimezone({ ...base, publishAt: { from: "go", tz: "site" } })).toBe(true);
		expect(needsSiteTimezone({ ...base, publishAt: { from: "go" } })).toBe(false);
	});
});

describe("readCollection and publishAtCollection (M5b)", () => {
	const registry = (supports?: string[]) => ({
		getField: async () => null,
		createField: async () => null,
		updateField: async () => null,
		getCollectionWithFields: async (slug: string) =>
			slug === "missing" ? null : { fields: [], ...(supports ? { supports } : {}) },
	});

	it("reads revisions from the collection's supports", async () => {
		const revisions = async (supports: string[] | undefined, slug = "products") =>
			(await readCollection(registry(supports), slug))?.revisions ?? null;
		expect(await revisions(["drafts", "revisions"])).toBe(true);
		expect(await revisions(["drafts"])).toBe(false);
		expect(await revisions(undefined)).toBe(false);
		expect(await revisions(["revisions"], "missing")).toBeNull();
	});

	it("reads fields and revisions in one registry call, and passes revisions: false on", async () => {
		let calls = 0;
		const counting = {
			...registry(["drafts"]),
			getCollectionWithFields: async () => {
				calls += 1;
				return { fields: [], supports: ["drafts"] };
			},
		};
		const read = await readPublishAtCollection(counting, { ...base, publishAt: { from: "go" } });
		expect(read).toEqual({ collection: "products", fields: [], revisions: false });
		expect(calls).toBe(1);
		expect(await readPublishAtCollection(counting, base)).toBeNull();
		expect(await listSchemaFields(registry(["revisions"]), "products")).toEqual([]);
		expect(
			await readPublishAtCollection(registry(["drafts", "revisions"]), {
				...base,
				publishAt: { from: "go" },
			}),
		).toMatchObject({ revisions: true });
	});

	it("names the collection only for a valid template that maps publishAt", () => {
		expect(publishAtCollection({ ...base, publishAt: { from: "go" } })).toBe("products");
		expect(publishAtCollection(base)).toBeNull();
		expect(publishAtCollection({ ...base, publishAt: { from: "go" }, version: 2 })).toBeNull();
	});
});

describe("the journal's link snapshot (M5b)", () => {
	it("keeps the link row's fingerprints and schedule", () => {
		const entry: EntrySnapshot = {
			id: "e1",
			rev: "r1",
			slug: "desk",
			data: { title: "Desk" },
			pendingPublish: false,
			status: "published",
			scheduledAt: null,
			hasDraft: false,
		};
		const link = {
			collection: "products",
			locale: "en",
			sourceKey: "S1",
			entryId: "e1",
			writtenRev: "r1",
			jobId: "j0",
			fields: { title: "AAAAAAAAAAAAAAAA" },
			scheduledAt: "2026-12-01T07:00:00.000Z",
		};
		const touched = {
			fields: ["title"],
			slug: false,
			taxonomies: [],
			references: [],
			bylines: false,
			referencesUnknown: false,
		};
		expect(preImage(entry, link, touched, undefined)).toMatchObject({
			link: {
				jobId: "j0",
				writtenRev: "r1",
				fields: { title: "AAAAAAAAAAAAAAAA" },
				scheduledAt: "2026-12-01T07:00:00.000Z",
			},
		});
	});
});
