import { describe, expect, it } from "vitest";
import { createJob, missingLimitOf } from "../../src/engine/jobs.js";
import { ruled } from "../../src/engine/rules.js";
import { type SchemaField, templateSchema } from "../../src/engine/template.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { makeDeps } from "./fakes.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields: SchemaField[] = [{ slug: "title", type: "string" }];
const withRules = (rules?: unknown) => ({ ...base, ...(rules === undefined ? {} : { rules }) });
const parse = (rules: unknown) => templateSchema.safeParse(withRules(rules));

describe("rules.owner and rules.missing (M5c)", () => {
	it("accepts an owner and a missing rule, each optional", () => {
		expect(
			parse({ owner: "shop-feed", missing: { action: "unpublish", maxPercent: 10 } }).success,
		).toBe(true);
		expect(parse({ owner: "a.b:c_d-1" }).success).toBe(true);
		expect(parse({ owner: "x".repeat(100), missing: { action: "trash" } }).success).toBe(true);
		expect(parse({ owner: "o", missing: { action: "trash", maxPercent: 0 } }).success).toBe(true);
		expect(parse({ owner: "o", missing: { action: "trash", maxPercent: 100 } }).success).toBe(true);
	});

	it("is strict and bounded", () => {
		for (const rules of [
			{ owner: "" },
			{ owner: "x".repeat(101) },
			{ owner: "shop feed" },
			{ owner: "ünï" },
			{ owner: 5 },
			{ missing: { action: "delete" } },
			{ missing: {} },
			{ missing: { action: "trash", maxPercent: 101 } },
			{ missing: { action: "trash", maxPercent: -1 } },
			{ missing: { action: "trash", maxPercent: 2.5 } },
			{ missing: { action: "trash", maxCount: 3 } },
			{ missing: { owner: "o", action: "trash" } },
		]) {
			expect(parse(rules).success, JSON.stringify(rules)).toBe(false);
		}
	});

	it("keeps the M5b record order for rules that hold only owner and missing", () => {
		const t = (rules?: unknown) => templateSchema.parse(withRules(rules));
		expect(ruled(t())).toBe(false);
		expect(ruled(t({}))).toBe(true);
		expect(ruled(t({ owner: "o" }))).toBe(false);
		expect(ruled(t({ owner: "o", missing: { action: "trash" } }))).toBe(false);
		expect(ruled(t({ owner: "o", mode: "update" }))).toBe(true);
		expect(ruled(t({ owner: "o", protectEdited: true }))).toBe(true);
	});

	it("declares the links index the phase queries by", () => {
		expect(STORAGE.links.indexes).toContainEqual(["owner", "collection", "locale"]);
	});
});

describe("jobs with rules.missing (M5c)", () => {
	async function create(rules: unknown, opts: Record<string, unknown> = {}) {
		const { deps } = makeDeps();
		deps.source.add("u1", "sku,Name\nA1,Desk\n");
		return createJob(deps, { uploadId: "u1", template: withRules(rules), schemaFields, ...opts });
	}

	it("refuses rules.missing without rules.owner, with its path, in the template schema", async () => {
		await expect(create({ missing: { action: "trash" } })).rejects.toMatchObject({
			code: "invalid_template",
			details: ["rules.missing: rules.missing needs rules.owner"],
		});
		const parsed = parse({ missing: { action: "trash" } });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues).toEqual([
			expect.objectContaining({
				path: ["rules", "missing"],
				message: "rules.missing needs rules.owner",
			}),
		]);
	});

	it("refuses the job option without rules.missing, and rules.missing without the journal", async () => {
		await expect(create({ owner: "o" }, { missing: false })).rejects.toMatchObject({
			code: "invalid_options",
			message: "The job option missing needs rules.missing in the template",
		});
		await expect(create(undefined, { missing: { maxPercent: 5 } })).rejects.toMatchObject({
			code: "invalid_options",
		});
		await expect(
			create({ owner: "o", missing: { action: "trash" } }, { journal: false }),
		).rejects.toMatchObject({
			code: "invalid_options",
			message: "rules.missing needs the journal, so its changes can be rolled back",
		});
		// The job option missing: false turns the phase off, so the journal is not needed.
		const off = await create(
			{ owner: "o", missing: { action: "trash" } },
			{ journal: false, missing: false },
		);
		expect(off).toMatchObject({ missingLimit: false, journal: false });
		await expect(
			create(
				{ owner: "o", missing: { action: "trash" } },
				{ journal: false, missing: { maxPercent: 5 } },
			),
		).rejects.toMatchObject({ code: "invalid_options" });
		// A dry run keeps no journal, so journal: false does not matter to it.
		const dry = await create(
			{ owner: "o", missing: { action: "trash" } },
			{ journal: false, dryRun: true },
		);
		expect(dry.missingLimit).toEqual({ maxPercent: 25 });
		for (const maxPercent of [-1, 101, 2.5]) {
			await expect(
				create({ owner: "o", missing: { action: "trash" } }, { missing: { maxPercent } }),
			).rejects.toMatchObject({
				code: "invalid_options",
				message: "The job option missing.maxPercent must be an integer from 0 to 100",
			});
		}
	});

	it("resolves missingLimit from the template and the job option", async () => {
		expect(await create({ owner: "o" })).not.toHaveProperty("missingLimit");
		expect((await create({ owner: "o", missing: { action: "trash" } })).missingLimit).toEqual({
			maxPercent: 25,
		});
		expect(
			(await create({ owner: "o", missing: { action: "unpublish", maxPercent: 10 } })).missingLimit,
		).toEqual({ maxPercent: 10 });
		expect(
			(
				await create(
					{ owner: "o", missing: { action: "trash", maxPercent: 10 } },
					{ missing: { maxPercent: 50 } },
				)
			).missingLimit,
		).toEqual({ maxPercent: 50 });
		expect(
			(await create({ owner: "o", missing: { action: "trash" } }, { missing: false })).missingLimit,
		).toBe(false);
	});

	it("stores the reader's skipped rows as unkeyed", async () => {
		expect(
			(await create({ owner: "o", missing: { action: "trash" } }, { skippedRows: 2 })).unkeyed,
		).toBe(2);
		expect(await create({ owner: "o" }, { skippedRows: 0 })).not.toHaveProperty("unkeyed");
	});

	it("is pure for missingLimitOf", () => {
		const t = templateSchema.parse(withRules({ owner: "o", missing: { action: "trash" } }));
		expect(missingLimitOf(t, undefined)).toEqual({ maxPercent: 25 });
		expect(missingLimitOf(t, false)).toBe(false);
		expect(missingLimitOf(templateSchema.parse(base), undefined)).toBeUndefined();
	});
});
