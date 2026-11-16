import { describe, expect, it } from "vitest";
import { templateSchema } from "../../src/engine/template.js";
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	templatesCollection,
	updateTemplate,
} from "../../src/plugin/templates.js";
import {
	failure,
	ownedLink,
	PRODUCTS,
	productTemplate,
	templateSetup,
} from "./templates-fixture.js";

const NOW = "2026-11-16T10:00:00.000Z";
const owned = (extra: Record<string, unknown> = {}) =>
	productTemplate({ rules: { owner: "shop" }, ...extra });

describe("templates/create and templates/get", () => {
	it("saves the parsed template with its copied fields, revision 1 and the caller", async () => {
		const { deps } = templateSetup();
		const result = await createTemplate(deps, "u1", { name: "Shop feed", template: owned() });
		expect(result).toEqual({
			template: {
				id: "T0001",
				name: "Shop feed",
				template: templateSchema.parse(owned()),
				revision: 1,
				collection: "products",
				locale: "en",
				owner: "shop",
				format: "csv",
				createdAt: NOW,
				updatedAt: NOW,
				createdBy: "u1",
				updatedBy: "u1",
			},
			check: { problems: [], warnings: [] },
		});
		expect(await getTemplate(deps, "T0001")).toEqual(result.template);
		expect(await failure(getTemplate(deps, "T9999"))).toMatchObject({
			code: "NOT_FOUND",
			status: 404,
			message: "Template T9999 not found",
		});
	});

	it("keeps a description, stores none for an empty one, and copies no owner when there is none", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", {
			name: "A",
			description: "Nightly",
			template: productTemplate(),
		});
		expect(a.template).toMatchObject({ description: "Nightly" });
		expect(a.template).not.toHaveProperty("owner");
		const b = await createTemplate(deps, "u1", {
			name: "B",
			description: "",
			template: productTemplate(),
		});
		expect(b.template).not.toHaveProperty("description");
	});

	it("refuses an invalid template and writes nothing", async () => {
		const { deps, templates } = templateSetup();
		expect(
			await failure(
				createTemplate(deps, "u1", { name: "A", template: productTemplate({ version: 2 }) }),
			),
		).toMatchObject({ code: "UNSUPPORTED_TEMPLATE_VERSION" });
		expect(
			await failure(
				createTemplate(deps, "u1", {
					name: "A",
					template: productTemplate({ key: { expr: "$now()" } }),
				}),
			),
		).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(templates.rows.size).toBe(0);
	});

	it("saves templates whose collection, field, taxonomy or locale is missing, and reports each", async () => {
		const { deps, lookups } = templateSetup();
		lookups.defs.push({ name: "color", hierarchical: false, collections: ["posts"], locale: "en" });
		const save = (name: string, template: object) => createTemplate(deps, "u1", { name, template });
		expect((await save("A", productTemplate({ collection: "nope" }))).check.problems).toEqual([
			'Collection "nope" does not exist',
		]);
		const stock = {
			title: { from: "Name", type: "text" },
			stock: { from: "Stock", type: "number" },
		};
		expect((await save("B", productTemplate({ fields: stock }))).check.problems).toEqual([
			'Field "stock" does not exist in collection "products"',
		]);
		expect(
			(await save("C", productTemplate({ taxonomies: { color: { from: "Color" } } }))).check
				.problems,
		).toEqual(['Taxonomy "color" is not attached to collection "products"']);
		const locale = await save("D", productTemplate({ locale: "xx" }));
		expect(locale.check.problems).toHaveLength(1);
		expect(locale.check.problems[0]).toMatch(/^locale: /);
		expect((await listTemplates(deps, {})).items).toHaveLength(4);
	});

	it("reports an unfillable translationOf.locale once (plan Ruling 8)", async () => {
		const { deps } = templateSetup();
		const { check } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate({ translationOf: { from: "en_id" } }),
		});
		expect(check.problems).toEqual([
			'translationOf.locale is required: locale is the default locale ("en")',
		]);
	});

	it("stores names as NFC, and a decomposed name takes the precomposed one", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "Café", template: productTemplate() });
		expect(a.template.name).toBe("Café");
		expect(
			await failure(createTemplate(deps, "u1", { name: "Café", template: productTemplate() })),
		).toMatchObject({
			code: "NAME_TAKEN",
			status: 409,
			message: 'A template named "Café" already exists',
			details: { id: a.template.id },
		});
	});
});

describe("templates/list", () => {
	it("pages 8 summaries in creation order without the template, across a delete (spec Ruling 32)", async () => {
		const { deps } = templateSetup();
		for (let i = 1; i <= 17; i++) {
			await createTemplate(deps, "u1", { name: `T${i}`, template: productTemplate() });
		}
		const first = await listTemplates(deps, {});
		expect(first.items.map((s) => s.name)).toEqual([
			"T1",
			"T2",
			"T3",
			"T4",
			"T5",
			"T6",
			"T7",
			"T8",
		]);
		expect(first.items.some((s) => "template" in s)).toBe(false);
		expect(first.hasMore).toBe(true);
		await deleteTemplate(deps, { id: first.items[2]!.id, revision: 1 });
		const second = await listTemplates(deps, { cursor: first.cursor });
		expect(second.items.map((s) => s.name)).toEqual([
			"T9",
			"T10",
			"T11",
			"T12",
			"T13",
			"T14",
			"T15",
			"T16",
		]);
		const third = await listTemplates(deps, { cursor: second.cursor });
		expect(third.items.map((s) => s.name)).toEqual(["T17"]);
		expect(third.hasMore).toBe(false);
	});

	it("filters by collection", async () => {
		const { deps } = templateSetup();
		await createTemplate(deps, "u1", { name: "P", template: productTemplate() });
		await createTemplate(deps, "u1", {
			name: "Q",
			template: {
				...productTemplate({ collection: "posts" }),
				fields: { title: { from: "Name", type: "text" } },
			},
		});
		expect((await listTemplates(deps, { collection: "posts" })).items.map((s) => s.name)).toEqual([
			"Q",
		]);
	});
});

describe("templates/update and templates/delete", () => {
	it("moves the revision, keeps createdAt and createdBy, and copies fields from the new template", async () => {
		const { deps, clock } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: owned() });
		clock.t += 60_000;
		const posts = {
			...productTemplate({ collection: "posts", locale: "fr" }),
			fields: { title: { from: "Name", type: "text" } },
		};
		const { template: next, check } = await updateTemplate(deps, "u2", {
			id: row.id,
			revision: 1,
			template: posts,
		});
		expect(next).toMatchObject({
			revision: 2,
			collection: "posts",
			locale: "fr",
			createdAt: NOW,
			createdBy: "u1",
			updatedAt: "2026-11-16T10:01:00.000Z",
			updatedBy: "u2",
		});
		expect(next).not.toHaveProperty("owner");
		expect(check).toEqual({ problems: [], warnings: [] });
		expect(await getTemplate(deps, row.id)).toEqual(next);
	});

	it("renames, keeps its own name, refuses a taken one, and removes the description with null", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", {
			name: "A",
			description: "x",
			template: productTemplate(),
		});
		const b = await createTemplate(deps, "u1", { name: "B", template: productTemplate() });
		expect(
			(await updateTemplate(deps, "u1", { id: a.template.id, revision: 1, name: "A" })).template
				.revision,
		).toBe(2);
		expect(
			await failure(updateTemplate(deps, "u1", { id: a.template.id, revision: 2, name: "B" })),
		).toMatchObject({ code: "NAME_TAKEN", details: { id: b.template.id } });
		const cleared = await updateTemplate(deps, "u1", {
			id: a.template.id,
			revision: 2,
			description: null,
		});
		expect(cleared.template).not.toHaveProperty("description");
		expect(
			(await updateTemplate(deps, "u1", { id: a.template.id, revision: 3, name: "A2" })).template
				.name,
		).toBe("A2");
	});

	it("refuses a stale revision with the current one, and an invalid template, changing nothing", async () => {
		const { deps } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate(),
		});
		await updateTemplate(deps, "u1", { id: row.id, revision: 1, description: "x" });
		expect(
			await failure(updateTemplate(deps, "u1", { id: row.id, revision: 1, name: "B" })),
		).toMatchObject({
			code: "TEMPLATE_CHANGED",
			status: 409,
			message: `Template ${row.id} is at revision 2, not 1; read it again`,
			details: { revision: 2 },
		});
		expect(
			await failure(
				updateTemplate(deps, "u1", { id: row.id, revision: 2, template: { version: 1 } }),
			),
		).toMatchObject({ code: "INVALID_TEMPLATE" });
		expect(
			await failure(updateTemplate(deps, "u1", { id: "T9999", revision: 1, name: "x" })),
		).toMatchObject({
			code: "NOT_FOUND",
		});
		expect((await getTemplate(deps, row.id)).revision).toBe(2);
	});

	it("refuses an update whose compare-and-set loses to a write after the read (spec Ruling 6)", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate(),
		});
		const write = templates.compareAndSet.bind(templates);
		templates.compareAndSet = async (id, expected, data) => {
			const current = await templates.get(id);
			if (current) await templates.put(id, { ...current, revision: 2, name: "Other" });
			return write(id, expected, data);
		};
		expect(
			await failure(updateTemplate(deps, "u2", { id: row.id, revision: 1, description: "x" })),
		).toMatchObject({
			code: "TEMPLATE_CHANGED",
			message: `Template ${row.id} changed while it was being saved; read it again`,
			details: { revision: 2 },
		});
		expect(await getTemplate(deps, row.id)).toMatchObject({ name: "Other" });
	});

	it("deletes at the named revision only, also when a write lands before the delete (spec Ruling 37)", async () => {
		const { deps, templates } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", template: productTemplate() });
		await updateTemplate(deps, "u1", { id: a.template.id, revision: 1, description: "x" });
		expect(await failure(deleteTemplate(deps, { id: a.template.id, revision: 1 }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			details: { revision: 2 },
		});
		const b = await createTemplate(deps, "u1", { name: "B", template: productTemplate() });
		const remove = templates.compareAndDelete.bind(templates);
		templates.compareAndDelete = async (id, expected) => {
			const current = await templates.get(id);
			if (current) await templates.put(id, { ...current, revision: 2 });
			return remove(id, expected);
		};
		expect(await failure(deleteTemplate(deps, { id: b.template.id, revision: 1 }))).toMatchObject({
			code: "TEMPLATE_CHANGED",
			message: `Template ${b.template.id} changed while it was being saved; read it again`,
		});
		templates.compareAndDelete = remove;
		expect(await deleteTemplate(deps, { id: a.template.id, revision: 2 })).toEqual({
			deleted: true,
		});
		expect(await failure(getTemplate(deps, a.template.id))).toMatchObject({ code: "NOT_FOUND" });
		expect(await failure(deleteTemplate(deps, { id: a.template.id, revision: 2 }))).toMatchObject({
			code: "NOT_FOUND",
		});
	});
});

describe("owner warnings (spec Rulings 7, 30, 31)", () => {
	it("warns about another saved template with the same owner, collection and locale", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", template: owned() });
		expect(a.check.warnings).toEqual([]);
		const b = await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "EN" }) });
		expect(b.check.warnings).toEqual([
			`Saved template A (${a.template.id}) uses the same owner shop for products/en: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		]);
		expect(
			(await createTemplate(deps, "u1", { name: "C", template: owned({ locale: "fr" }) })).check
				.warnings,
		).toEqual([]);
		// Updating B names A, never B itself.
		const updated = await updateTemplate(deps, "u1", {
			id: b.template.id,
			revision: 1,
			description: "x",
		});
		expect(updated.check.warnings).toHaveLength(1);
		expect(updated.check.warnings[0]).toContain(`(${a.template.id})`);
	});

	it("queries saved templates by { owner, collection } only, and links in the resolved locale", async () => {
		const { deps, templates, links } = templateSetup();
		const templateWheres: unknown[] = [];
		const linkWheres: unknown[] = [];
		const queryTemplates = templates.query.bind(templates);
		templates.query = async (opts) => {
			templateWheres.push({ where: opts.where, limit: opts.limit });
			return queryTemplates(opts);
		};
		const queryLinks = links.query.bind(links);
		links.query = async (opts) => {
			linkWheres.push({ where: opts.where, limit: opts.limit });
			return queryLinks(opts);
		};
		await createTemplate(deps, "u1", { name: "A", template: owned({ locale: "EN" }) });
		expect(templateWheres).toContainEqual({
			where: { owner: "shop", collection: "products" },
			limit: 100,
		});
		expect(linkWheres).toEqual([
			{ where: { owner: "shop", collection: "products", locale: "en" }, limit: 1 },
		]);
		linkWheres.length = 0;
		await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "xx" }) });
		expect(linkWheres).toEqual([]);
	});

	it("warns when the owner already owns entries in the resolved locale, and not in another", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:en:K1", ownedLink("shop"));
		const en = await createTemplate(deps, "u1", { name: "A", template: owned({ locale: "EN" }) });
		expect(en.check.warnings).toEqual([
			"Owner shop already owns entries in products/en: this template will treat them as its own (and with rules.missing may trash or unpublish the ones its feed lacks)",
		]);
		const fr = await createTemplate(deps, "u1", { name: "B", template: owned({ locale: "fr" }) });
		expect(fr.check.warnings).toEqual([]);
	});
});

describe("site checks and storage edges", () => {
	it("fills translationOf.locale for the checks only, and warns about shared fields", async () => {
		const shared = [PRODUCTS[0]!, { slug: "price", type: "number", translatable: false as const }];
		const { deps } = templateSetup({ collections: { products: shared } });
		const result = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate({ locale: "fr", translationOf: { from: "en_id" } }),
		});
		expect(result.check).toEqual({
			problems: [],
			warnings: [
				'Records with a translationOf value leave these to EmDash, which shares them across the translation group: field "price"',
			],
		});
		expect(result.template.template.translationOf).toEqual({ from: "en_id" });
	});

	it("reads the site timezone for tz: site, and warns about a flat taxonomy's hierarchy", async () => {
		const { deps, lookups } = templateSetup();
		deps.siteTimezone = async () => "Nowhere/Bogus";
		lookups.defs.push({
			name: "color",
			hierarchical: false,
			collections: ["products"],
			locale: "en",
		});
		const { check } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate({
				publishAt: { from: "go_live", format: "dd/MM/yyyy HH:mm", tz: "site" },
				taxonomies: { color: { from: "Color", hierarchy: ">" } },
			}),
		});
		expect(check).toEqual({
			problems: [
				'publishAt reads times in the site timezone, but "Nowhere/Bogus" is not a valid IANA timezone',
			],
			warnings: ['Taxonomy "color" is flat; its "hierarchy" separator is ignored'],
		});
	});

	it("compares the other templates' locales resolved, or as written when they do not resolve", async () => {
		const { deps } = templateSetup();
		const a = await createTemplate(deps, "u1", { name: "A", template: owned({ locale: "EN" }) });
		const b = await createTemplate(deps, "u1", { name: "B", template: owned() });
		expect(b.check.warnings).toEqual([
			`Saved template A (${a.template.id}) uses the same owner shop for products/en: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		]);
		const x = await createTemplate(deps, "u1", { name: "X", template: owned({ locale: "xx" }) });
		const y = await createTemplate(deps, "u1", { name: "Y", template: owned({ locale: "xx" }) });
		expect(y.check.warnings).toEqual([
			`Saved template X (${x.template.id}) uses the same owner shop for products/xx: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		]);
	});

	it("refuses to overwrite a row whose id is taken", async () => {
		const { deps, templates } = templateSetup();
		await createTemplate(deps, "u1", { name: "A", template: productTemplate() });
		deps.newId = () => "T0001";
		await expect(
			createTemplate(deps, "u1", { name: "B", template: productTemplate() }),
		).rejects.toThrow("Template id T0001 already exists");
		expect((await templates.get("T0001"))?.name).toBe("A");
	});

	it("names no revision when the row is gone before the compare-and-set", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate(),
		});
		const write = templates.compareAndSet.bind(templates);
		templates.compareAndSet = async (id, expected, data) => {
			await templates.delete(id);
			return write(id, expected, data);
		};
		const e = await failure(
			updateTemplate(deps, "u1", { id: row.id, revision: 1, description: "x" }),
		);
		expect(e).toMatchObject({
			code: "TEMPLATE_CHANGED",
			message: `Template ${row.id} changed while it was being saved; read it again`,
		});
		expect(e.details).toBeUndefined();
	});

	it("throws when the templates collection is not declared", () => {
		expect(() => templatesCollection({})).toThrow(
			"flux-import: the templates storage collection is missing",
		);
	});
});
