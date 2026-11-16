import { describe, expect, it } from "vitest";
import { createJob, JobError } from "../../src/engine/jobs.js";
import { protoKeyProblems, templateShapeProblems } from "../../src/engine/shape.js";
import { checkTemplate, type SchemaField, templateSchema } from "../../src/engine/template.js";
import { ServiceError } from "../../src/plugin/service.js";
import { templateForSave } from "../../src/plugin/templates.js";
import { typesTemplate } from "../fixtures/field-types.js";
import { jsonTemplate, xmlTemplate } from "../fixtures/formats.js";
import { linkNames, peopleTemplate, postsTemplate } from "../fixtures/links.js";
import { mediaTemplate } from "../fixtures/media.js";
import { portableTextTemplate } from "../fixtures/portable-text.js";
import { paddedTemplate } from "../fixtures/templates.js";
import {
	englishTemplate,
	translationNames,
	translationTemplate,
} from "../fixtures/translations.js";
import { xlsxTemplate } from "../fixtures/xlsx.js";
import { template as integrationTemplate } from "../integration/fixtures.js";
import { makeDeps } from "./fakes.js";
import { template as rollbackTemplate } from "./rollback-fixture.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const title: SchemaField[] = [{ slug: "title", type: "string" }];

/** The problems createJob reports for `template`, or [] when it creates the job. */
async function jobProblems(
	template: unknown,
	schemaFields: SchemaField[],
	body: string,
): Promise<string[]> {
	const { deps } = makeDeps();
	deps.source.add("u1", body);
	try {
		await createJob(deps, { uploadId: "u1", template, schemaFields });
	} catch (e) {
		if (e instanceof JobError) return e.details;
		throw e;
	}
	return [];
}

/** The ServiceError `templateForSave` throws for `template` (the template routes). */
function saveError(template: unknown): ServiceError {
	try {
		templateForSave(template);
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not throw");
}

const files = Object.fromEntries(
	Array.from({ length: 6 }, (_, i) => [`m${i}`, { from: `U${i}`, type: "file" }]),
);
const rich = Object.fromEntries(
	["a", "b", "c", "d"].map((f) => [
		f,
		{ from: f.toUpperCase(), type: "portableText", format: "html" },
	]),
);

/** Steps 3-6: each refused alone, by the shape function and once by createJob (spec Ruling 27). */
const FIT: {
	name: string;
	template: Record<string, unknown>;
	fields: SchemaField[];
	body: string;
	problem: string;
}[] = [
	{
		name: "six image and file fields",
		template: { ...base, fields: files },
		fields: Object.keys(files).map((slug) => ({ slug, type: "file" })),
		body: "sku,U0,U1,U2,U3,U4,U5\nA1,,,,,,\n",
		problem: "The template maps 6 image and file fields; at most 5 are allowed",
	},
	{
		name: "four portableText fields",
		template: { ...base, fields: rich },
		fields: Object.keys(rich).map((slug) => ({ slug, type: "portableText" })),
		body: "sku,A,B,C,D\nA1,,,,\n",
		problem: "The template maps 4 portableText fields; at most 3 are allowed",
	},
	{
		name: "a JSON path with an empty key",
		template: {
			...base,
			source: { format: "json" },
			fields: { title: { from: "name..first", type: "text" } },
		},
		fields: title,
		body: '[{"sku":"A1","name":{"first":"x"}}]',
		problem: '"name..first" has an empty key',
	},
	{
		name: "an XML path with an invalid name",
		template: {
			...base,
			source: { format: "xml", records: "feed/item" },
			key: { from: "@sku" },
			fields: { title: { from: "1bad", type: "text" } },
		},
		fields: title,
		body: '<feed><item sku="A1"><title>x</title></item></feed>',
		problem: '"1bad" has an invalid element or attribute name "1bad"',
	},
	{
		name: "translationOf.locale equal to locale in another case",
		template: { ...base, locale: "fr", translationOf: { from: "en_id", locale: "FR" } },
		fields: title,
		body: "sku,en_id,Name\nA1,E1,Desk\n",
		problem: 'translationOf.locale must differ from locale ("fr")',
	},
	{
		name: "a rules conflict",
		template: { ...base, rules: { mode: "create", protectEdited: true } },
		fields: title,
		body: "sku,Name\nA1,Desk\n",
		problem:
			"rules.updateFields and rules.protectEdited apply to updates; mode create never updates",
	},
];

describe("templateShapeProblems (spec Validation, Ruling 27)", () => {
	it.each(FIT)(
		"refuses $name, reports it once in createJob, and checkTemplate no longer does",
		async (c) => {
			const shape = templateShapeProblems(c.template);
			expect(shape).toMatchObject({ ok: true, fit: [c.problem], expressions: [], source: [] });
			const problems = await jobProblems(c.template, c.fields, c.body);
			expect(problems.filter((p) => p === c.problem)).toHaveLength(1);
			expect(checkTemplate(templateSchema.parse(c.template), c.fields, null)).not.toContain(
				c.problem,
			);
			const saved = saveError(c.template);
			expect(saved).toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
			expect(saved.details?.problems).toContain(c.problem);
		},
	);

	it("accepts five image and file fields and three portableText fields", () => {
		const five = Object.fromEntries(Object.entries(files).slice(0, 5));
		const three = Object.fromEntries(Object.entries(rich).slice(0, 3));
		expect(templateShapeProblems({ ...base, fields: five })).toMatchObject({ ok: true, fit: [] });
		expect(templateShapeProblems({ ...base, fields: three })).toMatchObject({ ok: true, fit: [] });
	});

	it("refuses the schema (step 1), expressions (step 7) and the source block (step 8) on their own", () => {
		const schema = templateShapeProblems({ ...base, version: "1" });
		expect(schema.ok).toBe(false);
		expect(!schema.ok && schema.problems.some((p) => p.startsWith("version: "))).toBe(true);
		const expr = templateShapeProblems({ ...base, key: { expr: "$now()" } });
		expect(expr).toMatchObject({ ok: true, fit: [], source: [] });
		expect(
			expr.ok && expr.expressions.length === 1 && expr.expressions[0]?.startsWith("key.expr: "),
		).toBe(true);
		expect(templateShapeProblems({ ...base, source: { format: "json", sheet: 1 } })).toMatchObject({
			ok: true,
			fit: [],
			expressions: [],
			source: ["source.sheet is only allowed for xlsx"],
		});
	});

	it("refuses a __proto__ key in a select map, which the schema alone would drop (Fact E1)", () => {
		const input = JSON.parse(
			'{"version":1,"collection":"products","locale":"en","key":{"from":"sku"},"fields":{"stage":{"from":"S","type":"select","map":{"__proto__":"live","a":"b"}}}}',
		);
		expect(templateSchema.safeParse(input).success).toBe(true);
		expect(templateShapeProblems(input)).toEqual({
			ok: false,
			problems: ['fields.stage.map: "__proto__" is not allowed as a key'],
		});
	});

	it("reports every __proto__ key depth-first, keys in order", () => {
		const input = JSON.parse(
			'{"a":{"__proto__":1,"b":{"__proto__":2}},"__proto__":3,"c":[{"__proto__":4}]}',
		);
		expect(protoKeyProblems(input)).toEqual([
			'template: "__proto__" is not allowed as a key',
			'a: "__proto__" is not allowed as a key',
			'a.b: "__proto__" is not allowed as a key',
			'c.0: "__proto__" is not allowed as a key',
		]);
	});

	it("refuses a __proto__ key at another depth and at the root", () => {
		const nested = JSON.parse(
			'{"version":1,"collection":"products","locale":"en","key":{"from":"sku"},"fields":{"title":{"from":"Name","type":"text"}},"rules":{"__proto__":{"mode":"create"}}}',
		);
		const shape = templateShapeProblems(nested);
		expect(shape.ok).toBe(false);
		expect(!shape.ok && shape.problems).toContain('rules: "__proto__" is not allowed as a key');
		expect(protoKeyProblems(JSON.parse('{"__proto__":1}'))).toEqual([
			'template: "__proto__" is not allowed as a key',
		]);
		expect(protoKeyProblems(JSON.parse('[{"a":[{"__proto__":1}]}]'))).toEqual([
			'0.a.0: "__proto__" is not allowed as a key',
		]);
	});

	it("does not overflow the stack on a deeply nested input (Review Focus 1)", () => {
		let deep: unknown = "x";
		for (let i = 0; i < 100_000; i++) deep = [deep];
		const run = () => templateShapeProblems({ ...base, extra: deep });
		expect(run).not.toThrow();
		const shape = run();
		expect(shape.ok).toBe(false);
		expect(!shape.ok && shape.problems).toContain('template: Unrecognized key: "extra"');
	});
});

describe("V3: parsing the stored form changes nothing (spec Ruling 3)", () => {
	const links = linkNames("v3");
	const tr = translationNames("v3");
	const fixtures: [string, unknown][] = [
		["integration template", integrationTemplate("v3")],
		["typesTemplate csv", typesTemplate("v3")],
		["typesTemplate json", typesTemplate("v3", "json")],
		["xlsxTemplate", xlsxTemplate("v3", { sheet: "Products", headerRow: 2 })],
		["jsonTemplate", jsonTemplate("v3")],
		["xmlTemplate", xmlTemplate("v3")],
		["peopleTemplate", peopleTemplate(links)],
		["postsTemplate csv", postsTemplate(links)],
		["postsTemplate json", postsTemplate(links, "json")],
		["mediaTemplate", mediaTemplate("v3", { refresh: true })],
		["portableTextTemplate", portableTextTemplate("v3")],
		[
			"portableTextTemplate markdown",
			portableTextTemplate("v3", { format: "markdown", photo: true }),
		],
		["englishTemplate", englishTemplate(tr)],
		["translationTemplate", translationTemplate(tr, "fr")],
		[
			"rollback fixture with rules",
			rollbackTemplate({
				rules: { owner: "o", missing: { action: "trash", maxPercent: 10 }, protectEdited: true },
				publishAt: { from: "Go", tz: "site" },
			}),
		],
		["padded", paddedTemplate("v3", 20_000)],
	];

	it.each(fixtures)("%s", (_name, t) => {
		const once = templateSchema.parse(t);
		const stored = JSON.parse(JSON.stringify(once));
		expect(templateSchema.parse(stored)).toEqual(once);
		expect(JSON.stringify(templateSchema.parse(stored))).toBe(JSON.stringify(once));
	});
});
