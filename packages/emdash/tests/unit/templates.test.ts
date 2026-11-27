import { describe, expect, it } from "vitest";
import { templateSchema } from "../../src/engine/template.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	siteCheck,
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

	it("reports an unknown locale with translationOf once, as jobs/create does (final review)", async () => {
		const { deps } = templateSetup();
		for (const translationOf of [{ from: "en_id" }, { from: "en_id", locale: "zz" }]) {
			const { check } = await createTemplate(deps, "u1", {
				name: `A ${translationOf.locale ?? "default"}`,
				template: productTemplate({ locale: "xx", translationOf }),
			});
			expect(check.problems).toHaveLength(1);
			expect(check.problems[0]).toMatch(/^locale: /);
		}
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
			"fluximporter: the templates storage collection is missing",
		);
	});
});

describe("a stored row that no longer parses (Review Focus 4)", () => {
	/** Saves a template, then overwrites its stored body as a newer or broken version would. */
	async function corrupt(body: unknown, extra: Record<string, unknown> = {}) {
		const setup = templateSetup();
		const { template: row } = await createTemplate(setup.deps, "u1", {
			name: "A",
			template: owned(),
		});
		await setup.templates.put(row.id, { ...row, ...extra, template: body } as SavedTemplate);
		return { ...setup, row };
	}

	it("refuses a rename or description-only update with the row's code, and changes nothing", async () => {
		const broken = await corrupt({ version: 1, collection: "products" });
		const e = await failure(
			updateTemplate(broken.deps, "u1", { id: broken.row.id, revision: 1, name: "B" }),
		);
		expect(e).toMatchObject({ code: "INVALID_TEMPLATE", status: 400 });
		expect(e.details?.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^key: /)]));
		const newer = await corrupt({ ...owned(), version: 2 });
		expect(
			await failure(
				updateTemplate(newer.deps, "u1", { id: newer.row.id, revision: 1, description: "x" }),
			),
		).toMatchObject({ code: "UNSUPPORTED_TEMPLATE_VERSION", status: 400 });
		expect(await getTemplate(newer.deps, newer.row.id)).toMatchObject({ name: "A", revision: 1 });
	});

	it("is repaired by an update that sends a template", async () => {
		const { deps, row } = await corrupt({ version: 2 });
		const { template: next } = await updateTemplate(deps, "u2", {
			id: row.id,
			revision: 1,
			name: "B",
			template: productTemplate(),
		});
		expect(next).toMatchObject({
			name: "B",
			revision: 2,
			template: templateSchema.parse(productTemplate()),
		});
	});

	it("stays readable, listable and deletable, and never breaks another template's owner check", async () => {
		const { deps, row } = await corrupt("not a template", { locale: undefined, name: 42 });
		expect((await getTemplate(deps, row.id)).template).toBe("not a template");
		const listed = await listTemplates(deps, {});
		expect(listed.items).toEqual([expect.objectContaining({ id: row.id, owner: "shop" })]);
		expect(listed.items[0]).not.toHaveProperty("template");
		const other = await createTemplate(deps, "u1", { name: "B", template: owned() });
		expect(other.check).toEqual({ problems: [], warnings: [] });
		expect(await deleteTemplate(deps, { id: row.id, revision: 1 })).toEqual({ deleted: true });
	});
});

describe("review follow-ups", () => {
	it("checks taxonomies in the site's casing of the locale, as jobs/create does", async () => {
		const { deps, lookups } = templateSetup();
		lookups.defs.push(
			{ name: "color", hierarchical: true, collections: ["products"], locale: "en" },
			{ name: "color", hierarchical: false, collections: ["products"], locale: "fr" },
		);
		const { template, check } = await createTemplate(deps, "u1", {
			name: "A",
			template: productTemplate({
				locale: "FR",
				taxonomies: { color: { from: "Color", hierarchy: ">" } },
			}),
		});
		expect(check.warnings).toEqual([
			'Taxonomy "color" is flat; its "hierarchy" separator is ignored',
		]);
		expect(template).toMatchObject({ locale: "FR", template: { locale: "FR" } });
		const translated = await createTemplate(deps, "u1", {
			name: "B",
			template: productTemplate({
				locale: "FR",
				translationOf: { from: "en_id" },
				taxonomies: { color: { from: "Color", hierarchy: ">" } },
			}),
		});
		expect(translated.check.warnings).toContain(
			'Taxonomy "color" is flat; its "hierarchy" separator is ignored',
		);
	});

	it("does not warn an update about the entries the template already owns", async () => {
		const { deps, links } = templateSetup();
		const queryLinks = links.query.bind(links);
		let linkQueries = 0;
		links.query = async (opts) => {
			linkQueries++;
			return queryLinks(opts);
		};
		await links.put("products:en:K1", ownedLink("shop"));
		const { template: row, check } = await createTemplate(deps, "u1", {
			name: "A",
			template: owned(),
		});
		expect(check.warnings).toHaveLength(1);
		linkQueries = 0;
		const described = await updateTemplate(deps, "u1", {
			id: row.id,
			revision: 1,
			description: "x",
		});
		expect(described.check.warnings).toEqual([]);
		const recased = await updateTemplate(deps, "u1", {
			id: row.id,
			revision: 2,
			template: owned({ locale: "EN" }),
		});
		expect(recased.check.warnings).toEqual([]);
		expect(linkQueries).toBe(0);
	});

	it("still warns an update that moves the owner, collection or locale onto owned entries", async () => {
		const { deps, links } = templateSetup();
		await links.put("products:fr:K1", ownedLink("shop", "fr"));
		await links.put("products:en:K2", ownedLink("other"));
		await links.put("posts:en:K3", ownedLink("shop", "en", "posts"));
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: owned() });
		let revision = 1;
		// Each step changes one of owner, locale and collection from the stored shop/products/en.
		const warnings = async (template: object) => {
			const { check } = await updateTemplate(deps, "u1", { id: row.id, revision, template });
			const back = await updateTemplate(deps, "u1", {
				id: row.id,
				revision: revision + 1,
				template: owned(),
			});
			expect(back.check.warnings).toEqual([]);
			revision += 2;
			return check.warnings;
		};
		const entries = (owner: string, at: string) =>
			`Owner ${owner} already owns entries in ${at}: this template will treat them as its own (and with rules.missing may trash or unpublish the ones its feed lacks)`;
		expect(await warnings(productTemplate({ rules: { owner: "other" } }))).toEqual([
			entries("other", "products/en"),
		]);
		expect(await warnings(owned({ locale: "fr" }))).toEqual([entries("shop", "products/fr")]);
		const posts = {
			...owned({ collection: "posts" }),
			fields: { title: { from: "Name", type: "text" } },
		};
		expect(await warnings(posts)).toEqual([entries("shop", "posts/en")]);
	});

	it("reads a row's locale from its template when the copied one is missing, and names it as text", async () => {
		const { deps, templates } = templateSetup();
		const { template: row } = await createTemplate(deps, "u1", { name: "A", template: owned() });
		await templates.put(row.id, {
			...row,
			locale: undefined,
			name: 42,
		} as unknown as SavedTemplate);
		const { check } = await createTemplate(deps, "u1", { name: "B", template: owned() });
		expect(check.warnings).toEqual([
			`Saved template 42 (${row.id}) uses the same owner shop for products/en: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		]);
		// B is saved by now, so a third check names both.
		const { owner } = await siteCheck(deps, templateSchema.parse(owned()));
		expect(owner?.templates).toEqual([
			{ id: row.id, name: "42" },
			{ id: "T0002", name: "B" },
		]);
	});
});
