import { describe, expect, it } from "vitest";
import { templateSchema } from "../../src/engine/template.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	assertRevision,
	staleTemplate,
	templateNotFound,
} from "../../src/plugin/template-errors.js";
import {
	TEMPLATE_MAX_BYTES,
	TEMPLATE_NAME_RULE,
	templateForSave,
	templateNameProblem,
} from "../../src/plugin/templates.js";
import { paddedTemplate, utf8Bytes } from "../fixtures/templates.js";

const base = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};

function thrown(run: () => unknown): ServiceError {
	try {
		run();
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not throw");
}

describe("templateForSave (the template routes, spec Ruling 28)", () => {
	it("returns the parsed template, defaults applied", () => {
		expect(templateForSave(base)).toEqual(templateSchema.parse(base));
		expect(templateForSave(base).source).toEqual({ format: "csv" });
	});

	it("refuses an integer version other than 1 with its own code", () => {
		expect(thrown(() => templateForSave({ ...base, version: 2 }))).toMatchObject({
			code: "UNSUPPORTED_TEMPLATE_VERSION",
			status: 400,
			message: "This template has format version 2; this version of flux-import reads version 1",
		});
	});

	it("leaves every other bad version or shape to the schema, with its path", () => {
		const { version: _v, ...noVersion } = base;
		for (const [input, prefix] of [
			[{ ...base, version: "1" }, "version: "],
			[noVersion, "version: "],
			[{ ...base, version: 1.5 }, "version: "],
			[[base], "template: "],
			["template", "template: "],
			[null, "template: "],
		] as const) {
			const e = thrown(() => templateForSave(input));
			expect(e, JSON.stringify(input)).toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
			const problems = (e.details?.problems ?? []) as string[];
			expect(
				problems.some((p) => p.startsWith(prefix)),
				JSON.stringify(problems),
			).toBe(true);
		}
	});

	it("refuses every shape problem, fit, expressions and source alike", () => {
		const e = thrown(() =>
			templateForSave({
				...base,
				key: { expr: "$now()" },
				rules: { mode: "create", protectEdited: true },
			}),
		);
		expect(e).toMatchObject({ code: "INVALID_TEMPLATE", message: "The template is invalid" });
		expect(e.details?.problems).toHaveLength(2);
		const source = thrown(() => templateForSave({ ...base, source: { format: "json", sheet: 1 } }));
		expect(source).toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
		expect(source.details?.problems).toEqual(["source.sheet is only allowed for xlsx"]);
	});

	it("accepts a template exactly at TEMPLATE_MAX_BYTES and refuses one byte more", () => {
		expect(TEMPLATE_MAX_BYTES).toBe(262_144);
		const at = templateForSave(paddedTemplate("products", TEMPLATE_MAX_BYTES));
		expect(utf8Bytes(at)).toBe(TEMPLATE_MAX_BYTES);
		expect(
			thrown(() => templateForSave(paddedTemplate("products", TEMPLATE_MAX_BYTES + 1))),
		).toMatchObject({
			code: "TEMPLATE_TOO_LARGE",
			status: 413,
			message: "The template is 262145 bytes of JSON; at most 262144 are allowed",
		});
	});

	it("counts UTF-8 bytes, not string length (Review Focus 2)", () => {
		const t = paddedTemplate("products", TEMPLATE_MAX_BYTES - 1000) as {
			fields: { title: { from: string } };
		};
		t.fields.title.from = "é".repeat(600);
		expect(JSON.stringify(t).length).toBeLessThan(TEMPLATE_MAX_BYTES);
		expect(utf8Bytes(t)).toBeGreaterThan(TEMPLATE_MAX_BYTES);
		expect(thrown(() => templateForSave(t))).toMatchObject({ code: "TEMPLATE_TOO_LARGE" });
	});
});

describe("templateNameProblem (spec Names, Ruling 38)", () => {
	it("accepts 1 and 100 characters and refuses 0 and 101", () => {
		expect(templateNameProblem("a")).toBeNull();
		expect(templateNameProblem("x".repeat(100))).toBeNull();
		expect(templateNameProblem("")).toBe(TEMPLATE_NAME_RULE);
		expect(templateNameProblem("x".repeat(101))).toBe(TEMPLATE_NAME_RULE);
	});

	it("refuses leading or trailing whitespace, control and format characters", () => {
		// A zero-width joiner, a right-to-left override and a leading no-break space.
		// biome-ignore format: the formatter would write the escapes as invisible characters.
		const names = [" Feed", "Feed ", "Feed\t", "Fe\u0007ed", "Fe\u200ded", "Fe\u202eed", "\u00a0Feed"];
		for (const name of names) {
			expect(templateNameProblem(name), JSON.stringify(name)).toBe(TEMPLATE_NAME_RULE);
		}
		expect(templateNameProblem("Shop feed (nightly) — été")).toBeNull();
	});

	it("checks the NFC form", () => {
		// 100 precomposed characters written with combining marks are 200 code units before NFC.
		// biome-ignore format: the formatter would write the escape as an invisible combining mark.
		const decomposed = "e\u0301";
		expect(templateNameProblem(decomposed.repeat(100))).toBeNull();
	});
});

describe("the shared template errors (Tasks 3 and 5)", () => {
	it("builds NOT_FOUND, TEMPLATE_NOT_FOUND and TEMPLATE_CHANGED", () => {
		expect(templateNotFound("NOT_FOUND", "T1")).toMatchObject({
			code: "NOT_FOUND",
			status: 404,
			message: "Template T1 not found",
		});
		expect(templateNotFound("TEMPLATE_NOT_FOUND", "T1")).toMatchObject({
			code: "TEMPLATE_NOT_FOUND",
			status: 404,
		});
		const stale = staleTemplate("T1", 3, 2);
		expect(stale).toBeInstanceOf(ServiceError);
		expect(stale).toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: "Template T1 is at revision 3, not 2; read it again",
			details: { revision: 3 },
		});
	});

	it("refuses only a named revision other than the current one", () => {
		expect(() => assertRevision("T1", 3, 3)).not.toThrow();
		expect(() => assertRevision("T1", 3, undefined)).not.toThrow();
		expect(thrown(() => assertRevision("T1", 3, 2))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			details: { revision: 3 },
		});
	});
});
