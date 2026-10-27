import { describe, expect, it } from "vitest";
import {
	type ApplyRegistry,
	applySchema,
	type FieldRequest,
	labelOf,
	planField,
	requestProblems,
} from "../../src/plugin/schema-apply.js";
import { ServiceError } from "../../src/plugin/service.js";

type Stored = {
	slug: string;
	type: string;
	validation?: { options?: string[]; maxLength?: number } | null | undefined;
	unsupportedType?: unknown;
};

const schemaError = (code: string, message: string) =>
	Object.assign(new Error(message), { name: "SchemaError", code });

class FakeApplyRegistry implements ApplyRegistry {
	readonly collections = new Map<string, Stored[]>();
	readonly calls: string[] = [];
	/** Fields another request creates just before our create of the same slug. */
	readonly raced = new Map<string, Stored>();
	/** A create of this slug fails with this error. */
	failOn: { slug: string; error: Error } | null = null;

	constructor(fields: Stored[] = []) {
		this.collections.set("products", fields);
	}

	async getCollectionWithFields(slug: string) {
		const fields = this.collections.get(slug);
		return fields ? { fields: fields.map((f) => ({ ...f })) } : null;
	}

	async createField(collection: string, input: Parameters<ApplyRegistry["createField"]>[1]) {
		this.calls.push(`create:${input.slug}:${JSON.stringify(input)}`);
		const fields = this.collections.get(collection)!;
		if (this.failOn?.slug === input.slug) throw this.failOn.error;
		const raced = this.raced.get(input.slug);
		if (raced) {
			fields.push(raced);
			throw schemaError("FIELD_EXISTS", `Field "${input.slug}" already exists`);
		}
		fields.push({ slug: input.slug, type: input.type, validation: input.validation ?? null });
		return {};
	}

	async updateField(
		collection: string,
		slug: string,
		input: { validation: Record<string, unknown> },
	) {
		this.calls.push(`update:${slug}:${JSON.stringify(input.validation)}`);
		const field = this.collections.get(collection)!.find((f) => f.slug === slug)!;
		field.validation = input.validation as Stored["validation"];
		return {};
	}
}

const invalidations: string[] = [];
const invalidate = (collection: string) => {
	invalidations.push(collection);
};

describe("planField", () => {
	const select: FieldRequest = { slug: "stage", type: "select", options: ["draft", "live"] };

	it("plans every row of the table", () => {
		expect(planField(select, undefined, false).change).toEqual({
			field: "stage",
			action: "create",
			type: "select",
			options: ["draft", "live"],
		});
		const same = {
			slug: "stage",
			type: "select",
			validation: { options: ["live", "draft", "old"] },
		};
		expect(planField(select, same, false).change.action).toBe("unchanged");
		expect(planField({ slug: "stage", type: "select" }, same, false).change.action).toBe(
			"unchanged",
		);
		const free = { slug: "stage", type: "select", validation: null };
		expect(planField(select, free, false).change.action).toBe("unchanged");
		const lacking = {
			slug: "stage",
			type: "select",
			validation: { options: ["draft"], maxLength: 9 },
		};
		expect(planField(select, lacking, true)).toEqual({
			change: { field: "stage", action: "add_options", type: "select", options: ["live"] },
			options: ["draft", "live"],
		});
		expect(planField(select, lacking, false).change).toEqual({
			field: "stage",
			action: "conflict",
			type: "select",
			message: 'Field "stage" lacks the options "live"; set addOptions to add them',
		});
		expect(
			planField({ slug: "sku_code", type: "string" }, { slug: "sku_code", type: "integer" }, true)
				.change,
		).toEqual({
			field: "sku_code",
			action: "conflict",
			type: "string",
			message: 'Field "sku_code" is "integer"; requested "string"',
		});
		const odd = {
			slug: "sku_code",
			type: "string",
			unsupportedType: { type: "geo", path: "type" },
		};
		expect(planField({ slug: "sku_code", type: "string" }, odd, true).change.action).toBe(
			"conflict",
		);
	});
});

describe("requestProblems", () => {
	it("refuses bad, reserved and duplicate slugs, misplaced options and unindexable types", () => {
		expect(
			requestProblems([
				{ slug: "Bad", type: "string" },
				{ slug: "status", type: "select" },
				{ slug: "flux_source_id", type: "string" },
				{ slug: "a".repeat(64), type: "string" },
				{ slug: "ok", type: "string", options: ["a"] },
				{ slug: "ok", type: "json", indexed: true },
				{ slug: "tags", type: "multiSelect", options: [] },
				{ slug: "tags2", type: "multiSelect", options: ["a", "a"] },
				{ slug: "tags3", type: "select", options: ["x".repeat(201)] },
				{ slug: "named", type: "text", label: "" },
				{ slug: "fine", type: "datetime", indexed: true, searchable: true, translatable: false },
			]),
		).toEqual([
			'Field "Bad": slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters',
			'Field "status": the slug is reserved',
			'Field "flux_source_id": the slug is reserved',
			`Field "${"a".repeat(64)}": slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters`,
			'Field "ok": only select and multiSelect fields take options',
			'Field "ok" is requested twice',
			'Field "ok": json fields cannot be indexed',
			'Field "tags": give 1-500 options',
			'Field "tags2": options must be distinct',
			'Field "tags3": options are 1-200 characters, without leading or trailing spaces',
			'Field "named": labels are 1-200 characters, without leading or trailing spaces',
		]);
	});
});

describe("applySchema", () => {
	it("creates missing fields with defaults, in request order, and clears caches once", async () => {
		const registry = new FakeApplyRegistry([{ slug: "title", type: "string" }]);
		invalidations.length = 0;
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "featured", type: "boolean" },
					{ slug: "title", type: "string" },
					{ slug: "unit_price", type: "number", indexed: true, label: "Price" },
					{ slug: "stage", type: "select", options: ["draft", "live"], translatable: false },
				],
			},
			invalidate,
		);
		expect(result).toEqual({
			collection: "products",
			dryRun: false,
			changes: [
				{ field: "featured", action: "create", type: "boolean" },
				{ field: "title", action: "unchanged", type: "string" },
				{ field: "unit_price", action: "create", type: "number" },
				{ field: "stage", action: "create", type: "select", options: ["draft", "live"] },
			],
			applied: ["featured", "unit_price", "stage"],
			error: null,
		});
		expect(registry.calls).toEqual([
			'create:featured:{"slug":"featured","label":"Featured","type":"boolean","indexed":false,"searchable":false,"translatable":true}',
			'create:unit_price:{"slug":"unit_price","label":"Price","type":"number","indexed":true,"searchable":false,"translatable":true}',
			'create:stage:{"slug":"stage","label":"Stage","type":"select","indexed":false,"searchable":false,"translatable":false,"validation":{"options":["draft","live"]}}',
		]);
		expect(invalidations).toEqual(["products"]);
	});

	it("adds missing options after the existing ones, keeping the rest of the validation", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "stage", type: "select", validation: { options: ["draft"], maxLength: 9 } },
		]);
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [{ slug: "stage", type: "select", options: ["live", "draft", "gone"] }],
				addOptions: true,
			},
			invalidate,
		);
		expect(result.changes).toEqual([
			{ field: "stage", action: "add_options", type: "select", options: ["live", "gone"] },
		]);
		expect(registry.calls).toEqual([
			'update:stage:{"options":["draft","live","gone"],"maxLength":9}',
		]);
	});

	it("reports conflicts and applies the other fields", async () => {
		const registry = new FakeApplyRegistry([{ slug: "sku_code", type: "integer" }]);
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "sku_code", type: "string" },
					{ slug: "specs", type: "json" },
				],
			},
			invalidate,
		);
		expect(result.changes.map((c) => c.action)).toEqual(["conflict", "create"]);
		expect(result.applied).toEqual(["specs"]);
		expect(registry.collections.get("products")![0]).toEqual({ slug: "sku_code", type: "integer" });
	});

	it("plans a dry run without calling the registry's writers or clearing caches", async () => {
		const registry = new FakeApplyRegistry();
		invalidations.length = 0;
		const result = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "featured", type: "boolean" }], dryRun: true },
			invalidate,
		);
		expect(result).toMatchObject({ dryRun: true, applied: [], changes: [{ action: "create" }] });
		expect(registry.calls).toEqual([]);
		expect(invalidations).toEqual([]);
	});

	it("re-plans a field another request created first", async () => {
		const registry = new FakeApplyRegistry();
		registry.raced.set("stage", {
			slug: "stage",
			type: "select",
			validation: { options: ["draft"] },
		});
		registry.raced.set("specs", { slug: "specs", type: "text" });
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "stage", type: "select", options: ["draft", "live"] },
					{ slug: "specs", type: "json" },
				],
				addOptions: true,
			},
			invalidate,
		);
		expect(result.changes).toEqual([
			{ field: "stage", action: "add_options", type: "select", options: ["live"] },
			{
				field: "specs",
				action: "conflict",
				type: "json",
				message: 'Field "specs" is "text"; requested "json"',
			},
		]);
		expect(result.applied).toEqual(["stage"]);
	});

	it("stops at an EmDash error, returning what was applied, and a rerun is safe", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = {
			slug: "b",
			error: schemaError("RESERVED_SLUG", 'Field slug "b" is reserved'),
		};
		invalidations.length = 0;
		const input = {
			collection: "products",
			fields: [
				{ slug: "a", type: "boolean" as const },
				{ slug: "b", type: "boolean" as const },
				{ slug: "c", type: "boolean" as const },
			],
		};
		const result = await applySchema(registry, input, invalidate);
		expect(result).toMatchObject({
			applied: ["a"],
			error: { code: "RESERVED_SLUG", message: 'Field slug "b" is reserved' },
		});
		expect(invalidations).toEqual(["products"]);
		registry.failOn = null;
		const again = await applySchema(registry, input, invalidate);
		expect(again.changes.map((c) => c.action)).toEqual(["unchanged", "create", "create"]);
		expect(again.applied).toEqual(["b", "c"]);
	});

	it("rethrows errors that are not EmDash's", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = { slug: "a", error: new TypeError("boom") };
		await expect(
			applySchema(
				registry,
				{ collection: "products", fields: [{ slug: "a", type: "json" }] },
				invalidate,
			),
		).rejects.toThrow("boom");
	});

	it("takes the fields from a template", async () => {
		const registry = new FakeApplyRegistry();
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "Name", type: "text" },
				price: { from: "Price", type: "number" },
				released: { from: "Date", type: "date" },
				launch_day: { from: "Launch", type: "date", output: "yyyy-MM-dd" },
				featured: { from: "F", type: "boolean" },
				stage: { from: "S", type: "select", map: { Live: "live", Up: "live", Hidden: "draft" } },
				colours: { from: "C", type: "multiSelect" },
				specs: { from: "J", type: "json" },
				handle: { from: "H", type: "slug" },
			},
		};
		const result = await applySchema(registry, { template, dryRun: true }, invalidate);
		expect(result.collection).toBe("products");
		expect(result.changes).toEqual([
			{ field: "title", action: "create", type: "string" },
			{ field: "price", action: "create", type: "number" },
			{ field: "released", action: "create", type: "datetime" },
			{ field: "launch_day", action: "create", type: "string" },
			{ field: "featured", action: "create", type: "boolean" },
			{ field: "stage", action: "create", type: "select", options: ["live", "draft"] },
			{ field: "colours", action: "create", type: "multiSelect" },
			{ field: "specs", action: "create", type: "json" },
			{ field: "handle", action: "create", type: "slug" },
		]);
		const mismatch = await applySchema(
			registry,
			{ collection: "other", template },
			invalidate,
		).catch((e: unknown) => e);
		expect(mismatch).toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
		const invalid = await applySchema(
			registry,
			{ template: { ...template, version: 2 } },
			invalidate,
		).catch((e: unknown) => e);
		expect(invalid).toMatchObject({
			code: "VALIDATION_ERROR",
			message: expect.stringMatching(/^The template is invalid: version/),
		});
	});

	it("refuses an unknown collection and invalid requests before planning", async () => {
		const registry = new FakeApplyRegistry();
		const missing = await applySchema(
			registry,
			{ collection: "nope", fields: [{ slug: "a", type: "json" }] },
			invalidate,
		).catch((e: unknown) => e);
		expect(missing).toBeInstanceOf(ServiceError);
		expect(missing).toMatchObject({ code: "COLLECTION_NOT_FOUND", status: 404 });
		const bad = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "specs", type: "json", indexed: true }] },
			invalidate,
		).catch((e: unknown) => e);
		expect(bad).toMatchObject({
			code: "VALIDATION_ERROR",
			status: 400,
			message: 'Field "specs": json fields cannot be indexed',
		});
		expect(registry.calls).toEqual([]);
	});
});

describe("template mode and error handling", () => {
	it("treats compatible existing types as unchanged and incompatible ones as conflicts", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "excerpt", type: "text" },
			{ slug: "qty", type: "integer" },
			{ slug: "day", type: "string" },
			{ slug: "handle", type: "string" },
			{ slug: "released", type: "string" },
			{ slug: "flag", type: "boolean" },
		]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				excerpt: { from: "E", type: "text" },
				qty: { from: "Q", type: "number" },
				day: { from: "D", type: "date", output: "yyyy-MM-dd" },
				handle: { from: "H", type: "slug" },
				released: { from: "R", type: "date" },
				flag: { from: "F", type: "number" },
			},
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes.map((c) => c.action)).toEqual([
			"unchanged",
			"unchanged",
			"unchanged",
			"unchanged",
			"unchanged",
			"conflict",
		]);
		expect(registry.calls).toEqual([]);
		const exact = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "qty", type: "number" }] },
			invalidate,
		);
		expect(exact.changes[0]?.action).toBe("conflict");
	});

	it("returns what was applied after a non-EmDash error, and rethrows when nothing was", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = { slug: "b", error: new TypeError("boom") };
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "a", type: "json" },
					{ slug: "b", type: "json" },
				],
			},
			invalidate,
		);
		expect(result.applied).toEqual(["a"]);
		expect(result.error).toEqual({ code: "INTERNAL_ERROR", message: "boom" });
	});

	it("treats an error with a code but not named SchemaError as not EmDash's", async () => {
		const registry = new FakeApplyRegistry();
		registry.failOn = { slug: "a", error: Object.assign(new Error("x"), { code: "ENOENT" }) };
		await expect(
			applySchema(
				registry,
				{ collection: "products", fields: [{ slug: "a", type: "json" }] },
				invalidate,
			),
		).rejects.toThrow("x");
	});

	it("refuses blank or untrimmed labels and options", () => {
		expect(
			requestProblems([
				{ slug: "a", type: "text", label: " Name" },
				{ slug: "b", type: "select", options: ["ok", " x"] },
				{ slug: "c", type: "select", options: ["  "] },
			]),
		).toHaveLength(3);
	});

	it("stops when a re-plan after FIELD_EXISTS still says create", async () => {
		const registry = new FakeApplyRegistry();
		registry.createField = async () => {
			throw schemaError("FIELD_EXISTS", "exists");
		};
		const result = await applySchema(
			registry,
			{ collection: "products", fields: [{ slug: "a", type: "json" }] },
			invalidate,
		);
		expect(result.applied).toEqual([]);
		expect(result.error?.code).toBe("FIELD_EXISTS");
	});
});

describe("template option handling", () => {
	const base = {
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
	};

	it("matches mapped values to existing options as the converters do", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "stage", type: "select", validation: { options: ["draft", "published"] } },
		]);
		const template = {
			...base,
			fields: { stage: { from: "S", type: "select", map: { Live: "PUBLISHED" } } },
		};
		for (const addOptions of [false, true]) {
			const result = await applySchema(registry, { template, addOptions }, invalidate);
			expect(result.changes[0]?.action).toBe("unchanged");
		}
		expect(registry.calls).toEqual([]);
		const exact = await applySchema(
			registry,
			{
				collection: "products",
				fields: [{ slug: "stage", type: "select", options: ["PUBLISHED"] }],
			},
			invalidate,
		);
		expect(exact.changes[0]?.action).toBe("conflict");
	});

	it("reports a field whose map values EmDash would refuse and plans the others", async () => {
		const registry = new FakeApplyRegistry();
		const template = {
			...base,
			fields: {
				stage: { from: "S", type: "select", map: { A: " live" } },
				featured: { from: "F", type: "boolean" },
			},
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{
				field: "stage",
				action: "conflict",
				type: "select",
				message: 'Field "stage": options are 1-200 characters, without leading or trailing spaces',
			},
			{ field: "featured", action: "create", type: "boolean" },
		]);
		expect(result.applied).toEqual(["featured"]);
	});

	it("re-plans add_options against the registry after a re-read", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "stage", type: "select", validation: { options: ["draft"] } },
		]);
		registry.raced.set("specs", { slug: "specs", type: "json" });
		const original = registry.createField.bind(registry);
		registry.createField = async (collection, input) => {
			// Another request adds "live" while we create specs.
			registry.collections.get(collection)![0]!.validation = { options: ["draft", "live"] };
			return original(collection, input);
		};
		const result = await applySchema(
			registry,
			{
				collection: "products",
				fields: [
					{ slug: "specs", type: "json" },
					{ slug: "stage", type: "select", options: ["draft", "live"] },
				],
				addOptions: true,
			},
			invalidate,
		);
		expect(result.changes[1]?.action).toBe("unchanged");
		expect(registry.calls.filter((c) => c.startsWith("update"))).toEqual([]);
	});
});

describe("template links", () => {
	it("never creates reference fields, and ignores taxonomies and bylines", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "author", type: "reference", validation: null },
			{ slug: "editor", type: "string" },
		]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				title: { from: "T", type: "text" },
				author: { from: "A", type: "reference" },
				editor: { from: "E", type: "reference", match: "slug" },
				related: { from: "R", type: "reference", match: "key" },
			},
			taxonomies: { category: { from: "C", create: true } },
			bylines: { from: "B" },
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{ field: "title", action: "create", type: "string" },
			{ field: "author", action: "unchanged", type: "reference" },
			{
				field: "editor",
				action: "conflict",
				type: "reference",
				message: 'Field "editor" is "string"; requested "reference"',
			},
			{
				field: "related",
				action: "conflict",
				type: "reference",
				message: 'Field "related" does not exist; create reference fields in the admin',
			},
		]);
		expect(result.applied).toEqual(["title"]);
		expect(registry.calls).toHaveLength(1);
	});
});

describe("template media", () => {
	it("creates image and file fields without allowed types, and keeps existing ones", async () => {
		const registry = new FakeApplyRegistry([
			{ slug: "photo", type: "image" },
			{ slug: "cover", type: "string" },
		]);
		const template = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: {
				photo: { from: "P", type: "image", alt: { from: "A" } },
				cover: { from: "C", type: "image" },
				manual: { from: "M", type: "file" },
				thumb: { from: "T", type: "image" },
			},
		};
		const result = await applySchema(registry, { template }, invalidate);
		expect(result.changes).toEqual([
			{ field: "photo", action: "unchanged", type: "image" },
			{
				field: "cover",
				action: "conflict",
				type: "image",
				message: 'Field "cover" is "string"; requested "image"',
			},
			{ field: "manual", action: "create", type: "file" },
			{ field: "thumb", action: "create", type: "image" },
		]);
		expect(registry.calls).toEqual([
			'create:manual:{"slug":"manual","label":"Manual","type":"file","indexed":false,"searchable":false,"translatable":true}',
			'create:thumb:{"slug":"thumb","label":"Thumb","type":"image","indexed":false,"searchable":false,"translatable":true}',
		]);
	});

	it("refuses to index image and file fields", () => {
		expect(requestProblems([{ slug: "photo", type: "image", indexed: true }])).toEqual([
			'Field "photo": image fields cannot be indexed',
		]);
	});
});

describe("labelOf", () => {
	it("turns a slug into a label", () => {
		expect(labelOf("unit_price")).toBe("Unit price");
		expect(labelOf("sku")).toBe("Sku");
		expect(labelOf("a__b_")).toBe("A b");
	});
});
