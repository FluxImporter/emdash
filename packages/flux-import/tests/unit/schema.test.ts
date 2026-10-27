import { describe, expect, it } from "vitest";
import {
	ensureSourceIdField,
	listSchemaFields,
	type SchemaRegistryLike,
} from "../../src/emdash/schema.js";
import { ContentWriteError } from "../../src/engine/ports.js";

type Field = { slug: string; type: string; indexed: boolean; translatable: boolean };

class FakeRegistry implements SchemaRegistryLike {
	readonly collections = new Map<string, Field[]>([
		["products", [{ slug: "title", type: "string", indexed: false, translatable: true }]],
	]);
	readonly calls: string[] = [];
	/** Simulates another request creating the field between our read and our create. */
	raceOnCreate = false;

	async getField(collection: string, slug: string) {
		return this.collections.get(collection)?.find((f) => f.slug === slug) ?? null;
	}
	async createField(collection: string, input: Field & { label: string }) {
		this.calls.push(`create:${collection}`);
		const fields = this.collections.get(collection);
		if (!fields)
			throw Object.assign(new Error("not found"), {
				name: "SchemaError",
				code: "COLLECTION_NOT_FOUND",
			});
		if (this.raceOnCreate) {
			fields.push({ slug: input.slug, type: "string", indexed: true, translatable: false });
			throw Object.assign(new Error("exists"), { name: "SchemaError", code: "FIELD_EXISTS" });
		}
		fields.push({
			slug: input.slug,
			type: input.type,
			indexed: input.indexed,
			translatable: input.translatable,
		});
		return {};
	}
	async updateField(collection: string, slug: string, input: { indexed: boolean }) {
		this.calls.push(`update:${collection}:${slug}:${input.indexed}`);
		const field = this.collections.get(collection)!.find((f) => f.slug === slug)!;
		field.indexed = input.indexed;
		return {};
	}
	async getCollectionWithFields(slug: string) {
		const fields = this.collections.get(slug);
		return fields ? { fields } : null;
	}
}

describe("ensureSourceIdField", () => {
	it("creates an indexed, non-translatable string field once", async () => {
		const registry = new FakeRegistry();
		await ensureSourceIdField(registry, "products");
		await ensureSourceIdField(registry, "products");
		expect(registry.calls).toEqual(["create:products"]);
		expect(await registry.getField("products", "flux_source_id")).toEqual({
			slug: "flux_source_id",
			type: "string",
			indexed: true,
			translatable: false,
		});
	});

	it("indexes an existing unindexed field", async () => {
		const registry = new FakeRegistry();
		registry.collections
			.get("products")!
			.push({ slug: "flux_source_id", type: "string", indexed: false, translatable: true });
		await ensureSourceIdField(registry, "products");
		expect(registry.calls).toEqual(["update:products:flux_source_id:true"]);
	});

	it("accepts a field another request created first", async () => {
		const registry = new FakeRegistry();
		registry.raceOnCreate = true;
		await expect(ensureSourceIdField(registry, "products")).resolves.toBeUndefined();
	});

	it("reports a missing collection and a field of the wrong type", async () => {
		const registry = new FakeRegistry();
		await expect(ensureSourceIdField(registry, "nope")).rejects.toMatchObject({
			code: "collection_missing",
		});
		registry.collections
			.get("products")!
			.push({ slug: "flux_source_id", type: "number", indexed: true, translatable: true });
		const error = await ensureSourceIdField(registry, "products").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "source_id_field_invalid" });
	});
});

describe("listSchemaFields", () => {
	it("lists slugs and types, or null for an unknown collection", async () => {
		const registry = new FakeRegistry();
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string", required: false, hasDefault: false, validation: {} },
		]);
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});

	it("lists required, defaults, the enforced validation keys, unusable fields and relations", async () => {
		const registry: SchemaRegistryLike = Object.assign(new FakeRegistry(), {
			getCollectionWithFields: async () => ({
				fields: [
					{
						slug: "sku",
						type: "string",
						required: true,
						defaultValue: "",
						validation: { minLength: 2, maxLength: 9, pattern: "^[A-Z]", options: [] },
					},
					{ slug: "status", type: "select", validation: { options: ["a", "b"] } },
					{ slug: "qty", type: "integer", required: false, validation: { min: 0, max: 5 } },
					{ slug: "weird", type: "string", unsupportedType: { type: "geo", path: "type" } },
					{ slug: "author", type: "reference", validation: { relation: "posts_author" } },
					{
						slug: "related",
						type: "reference",
						validation: {
							relation: "posts_related",
							relationSide: "child",
							targetCollection: "posts",
							multiple: true,
						},
					},
					{ slug: "legacy", type: "reference", validation: null },
					{ slug: "loose", type: "text", validation: { pattern: "", min: "1" as never } },
				],
			}),
		});
		expect(await listSchemaFields(registry, "products")).toEqual([
			{
				slug: "sku",
				type: "string",
				required: true,
				hasDefault: true,
				validation: { options: [], minLength: 2, maxLength: 9, pattern: "^[A-Z]" },
			},
			{
				slug: "status",
				type: "select",
				required: false,
				hasDefault: false,
				validation: { options: ["a", "b"] },
			},
			{
				slug: "qty",
				type: "integer",
				required: false,
				hasDefault: false,
				validation: { min: 0, max: 5 },
			},
			{
				slug: "weird",
				type: "string",
				required: false,
				hasDefault: false,
				validation: {},
				unsupported: true,
			},
			{
				slug: "author",
				type: "reference",
				required: false,
				hasDefault: false,
				validation: {},
				storageless: true,
			},
			{
				slug: "related",
				type: "reference",
				required: false,
				hasDefault: false,
				validation: {},
				storageless: true,
				relationSide: "child",
				targetCollection: "posts",
				multiple: true,
			},
			{ slug: "legacy", type: "reference", required: false, hasDefault: false, validation: {} },
			{ slug: "loose", type: "text", required: false, hasDefault: false, validation: {} },
		]);
	});
});
