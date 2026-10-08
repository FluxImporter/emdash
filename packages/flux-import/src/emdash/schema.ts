import { ContentWriteError } from "../engine/ports.js";
import { type SchemaField, SOURCE_ID_FIELD } from "../engine/template.js";
import { emdashErrorCode } from "./errors.js";

/**
 * The part of EmDash's `SchemaRegistry` this plugin uses (`emdash` src/schema/registry.ts:380,
 * :393, :1259, :1276, :1417). `EmDashRuntime.schemaRegistry` (src/emdash-runtime.ts:759) is
 * assignable to it.
 */
export interface SchemaRegistryLike {
	getField(
		collectionSlug: string,
		fieldSlug: string,
	): Promise<{ type: string; indexed: boolean } | null>;
	createField(
		collectionSlug: string,
		input: { slug: string; label: string; type: "string"; indexed: boolean; translatable: boolean },
	): Promise<unknown>;
	updateField(
		collectionSlug: string,
		fieldSlug: string,
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(
		slug: string,
	): Promise<{ fields: Array<{ slug: string; type: string }> } | null>;
}

/**
 * Adds `flux_source_id` (`string`, indexed, not translatable) to the collection, or makes an
 * existing one indexed. Idempotent and safe against a concurrent creator. Throws
 * `ContentWriteError("collection_missing")` when the collection does not exist.
 * `SchemaError` is matched by its `code`: the plugin may load a second copy of `emdash`.
 */
export async function ensureSourceIdField(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<void> {
	let field = await registry.getField(collection, SOURCE_ID_FIELD);
	if (!field) {
		try {
			await registry.createField(collection, {
				slug: SOURCE_ID_FIELD,
				label: "Flux source ID",
				type: "string",
				indexed: true,
				translatable: false,
			});
			return;
		} catch (e) {
			const code = emdashErrorCode(e);
			if (code === "COLLECTION_NOT_FOUND") {
				throw new ContentWriteError(
					"collection_missing",
					`Collection "${collection}" does not exist`,
				);
			}
			if (code !== "FIELD_EXISTS") throw e;
			field = await registry.getField(collection, SOURCE_ID_FIELD);
			if (!field) throw e;
		}
	}
	if (field.type !== "string" && field.type !== "text") {
		throw new ContentWriteError(
			"source_id_field_invalid",
			`Field "${SOURCE_ID_FIELD}" in "${collection}" has type "${field.type}"; it must be "string" or "text"`,
		);
	}
	if (!field.indexed) await registry.updateField(collection, SOURCE_ID_FIELD, { indexed: true });
}

/** The collection's fields for `checkTemplate`, or `null` when the collection does not exist. */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<SchemaField[] | null> {
	const found = await registry.getCollectionWithFields(collection);
	return found ? found.fields.map((f) => ({ slug: f.slug, type: f.type })) : null;
}
