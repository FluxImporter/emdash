import { describe, expect, it } from "vitest";
import { FLUX_IMPORT_VERSION } from "../../src/meta.js";
import {
	exportTemplate,
	importTemplate,
	TEMPLATE_FILE_FORMAT,
	templateFilename,
} from "../../src/plugin/template-files.js";
import {
	createTemplate,
	TEMPLATE_MAX_BYTES,
	TEMPLATE_NAME_RULE,
} from "../../src/plugin/templates.js";
import { paddedTemplate } from "../fixtures/templates.js";
import { failure, ownedLink, productTemplate, templateSetup } from "./templates-fixture.js";

const missing = (owner = "shop") =>
	productTemplate({ rules: { owner, missing: { action: "unpublish", maxPercent: 10 } } });
const file = (extra: Record<string, unknown> = {}) => ({
	format: TEMPLATE_FILE_FORMAT,
	formatVersion: 1,
	name: "Shop feed",
	template: productTemplate(),
	...extra,
});

describe("templates/export (spec Rulings 8, 9)", () => {
	it("holds exactly the envelope and the stored template, nothing site-specific", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "Shop feed",
			description: "Nightly",
			template: missing(),
		});
		const out = await exportTemplate(deps, row.id);
		expect(out.filename).toBe("flux-import-template-shop-feed.json");
		expect(Object.keys(out.file)).toEqual([
			"format",
			"formatVersion",
			"exportedAt",
			"generator",
			"name",
			"description",
			"template",
		]);
		expect(out.file).toEqual({
			format: "flux-import.template",
			formatVersion: 1,
			exportedAt: "2026-11-16T10:00:00.000Z",
			generator: { plugin: "flux-import", version: FLUX_IMPORT_VERSION },
			name: "Shop feed",
			description: "Nightly",
			template: row.template,
		});
		const text = JSON.stringify(out);
		for (const value of [row.id, "u1", '"revision"', "createdAt", "updatedBy"]) {
			expect(text).not.toContain(value);
		}
		const plain = await createTemplate(deps, "u1", { name: "Plain", template: productTemplate() });
		expect(Object.keys((await exportTemplate(deps, plain.template.id)).file)).not.toContain(
			"description",
		);
	});

	it("exports a media baseUrl as written, query string included (spec Ruling 40)", async () => {
		const { deps } = templateSetup();
		const baseUrl = "https://cdn.example.com/files/?token=abc123";
		const fields = {
			title: { from: "Name", type: "text" },
			body: { from: "Body", type: "portableText", format: "html", baseUrl },
		};
		const { template: row } = await createTemplate(deps, "u1", {
			name: "Body",
			template: productTemplate({ fields }),
		});
		const { file: out } = await exportTemplate(deps, row.id);
		expect((out.template as { fields: { body: { baseUrl: string } } }).fields.body.baseUrl).toBe(
			baseUrl,
		);
	});

	it("names the file after the slugified name, cut to 80 characters", () => {
		expect(templateFilename("Shop feed")).toBe("flux-import-template-shop-feed.json");
		expect(templateFilename("!!!")).toBe("flux-import-template-template.json");
		expect(templateFilename(`${"a".repeat(79)} b`)).toBe(
			`flux-import-template-${"a".repeat(79)}.json`,
		);
	});

	it("exports a stored row that no longer parses, as stored (Review Focus 4, spec Ruling 11)", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "Old",
			template: productTemplate(),
		});
		const future = { ...row.template, futureRule: true } as typeof row.template;
		await templates.put(row.id, { ...row, template: future });
		expect((await exportTemplate(deps, row.id)).file.template).toEqual(future);
		expect(await failure(exportTemplate(deps, "T9999"))).toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("templates/import", () => {
	it("round-trips an export into a new row at revision 1 by the importer", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "Shop feed",
			description: "Nightly product feed",
			template: productTemplate(),
		});
		const { file: exported } = await exportTemplate(deps, row.id);
		expect(exported.description).toBe("Nightly product feed");
		const { template: copy, check } = await importTemplate(deps, "u2", {
			file: exported,
			name: "Copy",
		});
		expect(copy).toMatchObject({
			name: "Copy",
			description: "Nightly product feed",
			revision: 1,
			createdBy: "u2",
			updatedBy: "u2",
		});
		expect(copy.id).not.toBe(row.id);
		expect(copy.template).toEqual(row.template);
		expect(check).toEqual({ problems: [], warnings: [] });
	});

	it("reads a hand-written file without generator, ignores unknown envelope keys and a __proto__ key", async () => {
		const { deps } = templateSetup();
		expect((await importTemplate(deps, "u1", { file: file({ extra: 1 }) })).template.name).toBe(
			"Shop feed",
		);
		const sneaky = JSON.parse(
			`{"format":"flux-import.template","formatVersion":1,"name":"Sneaky","template":${JSON.stringify(productTemplate())},"__proto__":{"template":{"version":2}}}`,
		);
		const imported = await importTemplate(deps, "u1", { file: sneaky });
		expect(imported.template.template.version).toBe(1);
		expect(Object.prototype).not.toHaveProperty("template");
	});

	it("never reads an envelope key from under __proto__ (spec Ruling 36)", async () => {
		const { deps, templates } = templateSetup();
		const proto = JSON.parse(
			`{"format":"flux-import.template","formatVersion":1,"name":"Sneaky","__proto__":{"template":${JSON.stringify(productTemplate())}}}`,
		);
		// JSON.parse keeps "__proto__" as an own key, but a reader that copies the file with
		// Object.assign sets it as the prototype and would find the template there.
		expect(Object.hasOwn(proto, "template")).toBe(false);
		expect(Object.assign({}, proto).template).toEqual(productTemplate());
		expect(await failure(importTemplate(deps, "u1", { file: proto }))).toMatchObject({
			code: "INVALID_FILE",
			status: 400,
			message: "The file has no template",
		});
		// A service caller's object whose template is inherited from a real prototype.
		const inherited = Object.assign(Object.create({ template: productTemplate() }), {
			format: TEMPLATE_FILE_FORMAT,
			formatVersion: 1,
			name: "Inherited",
		});
		expect(await failure(importTemplate(deps, "u1", { file: inherited }))).toMatchObject({
			code: "INVALID_FILE",
			message: "The file has no template",
		});
		expect((await templates.query({ limit: 100 })).items).toEqual([]);
	});

	it("refuses files that are not template files, with INVALID_FILE or UNSUPPORTED_FILE_VERSION", async () => {
		const { deps } = templateSetup();
		const cases: [unknown, string, string][] = [
			[null, "INVALID_FILE", "The file is not a flux-import template file"],
			[[file()], "INVALID_FILE", "The file is not a flux-import template file"],
			["{}", "INVALID_FILE", "The file is not a flux-import template file"],
			[
				file({ format: "other" }),
				"INVALID_FILE",
				'The file\'s format is not "flux-import.template"',
			],
			[file({ formatVersion: "1" }), "INVALID_FILE", "formatVersion must be the integer 1"],
			[
				file({ formatVersion: 2, generator: { plugin: "flux-import", version: "9.9.9" } }),
				"UNSUPPORTED_FILE_VERSION",
				"This file was written by a newer flux-import (file format 2, generator 9.9.9); this site reads file format 1",
			],
			[
				file({ formatVersion: 3 }),
				"UNSUPPORTED_FILE_VERSION",
				"This file was written by a newer flux-import (file format 3, generator unknown); this site reads file format 1",
			],
			[file({ template: undefined }), "INVALID_FILE", "The file has no template"],
			[
				file({ description: "x".repeat(2001) }),
				"INVALID_FILE",
				"The file's description must be text of at most 2,000 characters",
			],
			[
				file({ description: 5 }),
				"INVALID_FILE",
				"The file's description must be text of at most 2,000 characters",
			],
			[file({ name: 5 }), "INVALID_FILE", "The file has no name; give one with name"],
		];
		for (const [input, code, message] of cases) {
			expect(
				await failure(importTemplate(deps, "u1", { file: input })),
				JSON.stringify(input),
			).toMatchObject({
				code,
				status: 400,
				message,
			});
		}
	});

	it("refuses a template version, an unknown template key and a bad shape like the other template routes", async () => {
		const { deps } = templateSetup();
		expect(
			await failure(
				importTemplate(deps, "u1", { file: file({ template: productTemplate({ version: 2 }) }) }),
			),
		).toMatchObject({ code: "UNSUPPORTED_TEMPLATE_VERSION" });
		const unknown = await failure(
			importTemplate(deps, "u1", {
				file: file({ template: productTemplate({ rules: { owner: "o", keepForever: true } }) }),
			}),
		);
		expect(unknown).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(unknown.details?.problems).toContain('rules: Unrecognized key: "keepForever"');
	});

	it("refuses a taken name, and imports under the name override", async () => {
		const { deps } = templateSetup();
		const first = await importTemplate(deps, "u1", { file: file() });
		expect(await failure(importTemplate(deps, "u1", { file: file() }))).toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			details: { id: first.template.id },
		});
		expect(
			(await importTemplate(deps, "u1", { file: file(), name: "Shop feed 2" })).template.name,
		).toBe("Shop feed 2");
	});

	it("refuses a file name that breaks the name rule, and the name override rescues it (Review Focus 5)", async () => {
		const { deps } = templateSetup();
		expect(
			await failure(importTemplate(deps, "u1", { file: file({ name: "Shop feed " }) })),
		).toMatchObject({
			code: "INVALID_FILE",
			message: `The file's name is not a valid template name (${TEMPLATE_NAME_RULE}); give one with name`,
		});
		const rescued = await importTemplate(deps, "u1", {
			file: file({ name: "Shop feed\t" }),
			name: "Shop feed",
		});
		expect(rescued.template.name).toBe("Shop feed");
	});

	it("stores the file's name and the name override in NFC, and keeps a 2,000-character description", async () => {
		const { deps } = templateSetup();
		const fromFile = await importTemplate(deps, "u1", {
			file: file({ name: "Café", description: "x".repeat(2000) }),
		});
		expect(fromFile.template).toMatchObject({ name: "Café", description: "x".repeat(2000) });
		const given = await importTemplate(deps, "u1", { file: file(), name: "Résumé" });
		expect(given.template.name).toBe("Résumé");
	});
});

describe("templates/import owner checks (spec Ruling 30)", () => {
	it("refuses rules.missing whose owner already owns entries, and imports with an owner override", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		expect(
			await failure(importTemplate(deps, "u1", { file: file({ template: missing() }) })),
		).toMatchObject({
			code: "OWNER_IN_USE",
			status: 409,
			message:
				'Owner shop is already used in products/en (existing entries); this template has rules.missing, so its missing phase would treat those entries as its own. Import it with owner set to a new owner name, or to "shop" to keep this one',
			details: { owner: "shop", templates: [], links: true },
		});
		const moved = await importTemplate(deps, "u1", {
			file: file({ template: missing() }),
			owner: "shop-2",
		});
		expect(moved.template).toMatchObject({
			owner: "shop-2",
			template: { rules: { owner: "shop-2" } },
		});
		expect(moved.check.warnings).toEqual([]);
	});

	it("refuses rules.missing whose owner another saved template uses, and keeps it when the override names it", async () => {
		const { deps } = templateSetup();
		const saved = await createTemplate(deps, "u1", { name: "Original", template: missing() });
		expect(
			await failure(importTemplate(deps, "u1", { file: file({ template: missing() }) })),
		).toMatchObject({
			code: "OWNER_IN_USE",
			details: { owner: "shop", templates: [saved.template.id], links: false },
		});
		const kept = await importTemplate(deps, "u1", {
			file: file({ template: missing() }),
			owner: "shop",
		});
		expect(kept.template.owner).toBe("shop");
		expect(kept.check.warnings).toHaveLength(1);
	});

	it("only warns without rules.missing, and an override adds an owner the template lacked", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		await createTemplate(deps, "u1", {
			name: "Original",
			template: productTemplate({ rules: { owner: "shop" } }),
		});
		const warned = await importTemplate(deps, "u1", {
			file: file({ template: productTemplate({ rules: { owner: "shop" } }) }),
		});
		expect(warned.check.warnings).toHaveLength(2);
		const added = await importTemplate(deps, "u1", {
			file: file(),
			name: "No owner",
			owner: "fresh",
		});
		expect(added.template).toMatchObject({
			owner: "fresh",
			template: { rules: { owner: "fresh" } },
		});
	});

	it("checks the size again after the owner override (plan Ruling 10)", async () => {
		const { deps } = templateSetup();
		const full = paddedTemplate("products", TEMPLATE_MAX_BYTES);
		expect(
			(await importTemplate(deps, "u1", { file: file({ template: full }) })).template.revision,
		).toBe(1);
		expect(
			await failure(
				importTemplate(deps, "u1", { file: file({ template: full }), name: "Bigger", owner: "o" }),
			),
		).toMatchObject({ code: "TEMPLATE_TOO_LARGE" });
	});
});
