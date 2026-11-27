import { ContentWriteError } from "../engine/ports.js";
import type { SchemaFieldWithLabel } from "../engine/suggest.js";
import {
	type FieldRules,
	type SchemaField,
	SOURCE_ID_FIELD,
	templateSchema,
} from "../engine/template.js";
import { FLUX_IMPORTER_ID } from "../meta.js";
import { emdashErrorCode } from "./errors.js";

/**
 * The field widget `flux_source_id` is shown with: `"<pluginId>:<name>"`, the admin module's
 * `fields["source-id"]` (`SOURCE_ID_WIDGET` in `src/admin/fields/SourceIdField.tsx`).
 */
export const SOURCE_ID_FIELD_WIDGET = `${FLUX_IMPORTER_ID}:source-id`;

/**
 * The part of EmDash's `SchemaRegistry` this plugin uses (`emdash` src/schema/registry.ts:380,
 * :393, :1259, :1276, :1417). `EmDashRuntime.schemaRegistry` (src/emdash-runtime.ts:759) is
 * assignable to it.
 */
export interface SchemaRegistryLike {
	getField(
		collectionSlug: string,
		fieldSlug: string,
	): Promise<{ type: string; indexed: boolean; widget?: string | null } | null>;
	createField(
		collectionSlug: string,
		input: {
			slug: string;
			label: string;
			type: "string";
			indexed: boolean;
			translatable: boolean;
			widget?: string;
		},
	): Promise<unknown>;
	updateField(
		collectionSlug: string,
		fieldSlug: string,
		input: { indexed?: boolean; widget?: string },
	): Promise<unknown>;
	getCollectionWithFields(slug: string): Promise<{
		label?: string | undefined;
		fields: RegistryField[];
		supports?: readonly string[];
	} | null>;
}

/**
 * The parts of EmDash's `Field` (src/schema/types.ts:320-344) the importer reads; `label` is
 * `Field.label` (:324), as `Collection.label` (:267) is the collection's (M6d).
 */
export interface RegistryField {
	slug: string;
	label?: string | undefined;
	type: string;
	required?: boolean;
	defaultValue?: unknown;
	validation?:
		| (FieldRules & {
				relation?: string | undefined;
				relationSide?: string | undefined;
				targetCollection?: string | undefined;
				multiple?: boolean | undefined;
		  })
		| null
		| undefined;
	unsupportedType?: unknown;
	/** Absent or true: per locale; false: shared across a translation group. */
	translatable?: boolean;
}

/**
 * Adds `flux_source_id` (`string`, indexed, not translatable, shown by the plugin's field widget)
 * to the collection, or makes an existing one indexed and gives it the widget when it has none; a
 * widget someone else set is kept. The registry has no compare-and-set, so a widget set between
 * our `getField` and `updateField` can still be overwritten. Idempotent and safe against a
 * concurrent creator. Throws `ContentWriteError("collection_missing")` when the collection does
 * not exist.
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
				widget: SOURCE_ID_FIELD_WIDGET,
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
	const update = {
		...(field.indexed ? {} : { indexed: true }),
		...(field.widget == null ? { widget: SOURCE_ID_FIELD_WIDGET } : {}),
	};
	if (Object.keys(update).length > 0)
		await registry.updateField(collection, SOURCE_ID_FIELD, update);
}

/**
 * The validation keys the importer checks, as numbers, strings and string arrays only; an empty
 * `allowedMimeTypes` means no constraint, as in EmDash (`parseAllowedMimeTypes`).
 */
function rulesOf(validation: RegistryField["validation"]): FieldRules {
	const v = validation ?? {};
	const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
	const rules: FieldRules = {};
	if (Array.isArray(v.options) && v.options.every((o) => typeof o === "string")) {
		rules.options = [...v.options];
	}
	for (const key of ["min", "max", "minLength", "maxLength"] as const) {
		const n = num(v[key]);
		if (n !== undefined) rules[key] = n;
	}
	if (typeof v.pattern === "string" && v.pattern !== "") rules.pattern = v.pattern;
	const allowed = v.allowedMimeTypes;
	if (Array.isArray(allowed) && allowed.length > 0 && allowed.every((t) => typeof t === "string")) {
		rules.allowedMimeTypes = [...allowed];
	}
	return rules;
}

/** A reference field's relation keys (`emdash` src/schema/types.ts:107-125), as given. */
function relationOf(
	f: RegistryField,
): Pick<SchemaField, "relationSide" | "targetCollection" | "multiple"> {
	const v = f.validation ?? {};
	return {
		...(v.relationSide === "parent" || v.relationSide === "child"
			? { relationSide: v.relationSide }
			: {}),
		...(typeof v.targetCollection === "string" && v.targetCollection !== ""
			? { targetCollection: v.targetCollection }
			: {}),
		...(typeof v.multiple === "boolean" ? { multiple: v.multiple } : {}),
	};
}

/**
 * The collection a request's template maps `publishAt` into, read once: its fields, whether it
 * keeps revisions (M5b) and whether it refuses schedules. Null when the template maps no
 * `publishAt` or the collection is missing.
 */
export async function readPublishAtCollection(
	registry: SchemaRegistryLike,
	template: unknown,
): Promise<(CollectionRead & { collection: string }) | null> {
	const collection = publishAtCollection(template);
	if (collection === null) return null;
	const read = await readCollection(registry, collection);
	return read === null ? null : { ...read, collection };
}

/**
 * The collection of a template from a request that maps `publishAt` (M5b), whose revisions job
 * creation reads; null otherwise. An invalid template has none: job creation reports it.
 */
export function publishAtCollection(template: unknown): string | null {
	const parsed = templateSchema.safeParse(template);
	return parsed.success && parsed.data.publishAt !== undefined ? parsed.data.collection : null;
}

/**
 * The collection's fields for `checkTemplate` and the job's target snapshot, or `null` when the
 * collection does not exist: type, `required`, whether it has a default, the validation keys
 * EmDash enforces, whether EmDash cannot read its type or keeps its values elsewhere (a
 * reference bound to a relation, `isStoragelessField` in src/schema/types.ts:120-125), a
 * reference field's relation side, target collection and `multiple`, and `translatable: false`
 * (src/schema/types.ts:341-342).
 */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<SchemaField[] | null> {
	return (await readCollection(registry, collection))?.fields ?? null;
}

/**
 * A collection's schema fields, whether it keeps revisions (M5b) and, as `scheduling: false`,
 * that it refuses schedules, from one registry read.
 */
export type CollectionRead = { fields: SchemaField[]; revisions: boolean; scheduling?: false };

/**
 * A collection's fields (`listSchemaFields`) and whether it keeps revisions (M5b): its `supports`
 * lists `"revisions"` (`emdash` src/schema/types.ts:264-272, spec M5b F12, V6). EmDash 1.5 added
 * `"no-scheduling"`, which refuses creating or changing a schedule (`handleContentSchedule`'s
 * `VALIDATION_ERROR`, src/api/handlers/content.ts:262-276 and :2324-2327); the legacy
 * `"scheduling"` value has no effect. Null when the collection does not exist, which job creation
 * then refuses.
 */
export async function readCollection(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<CollectionRead | null> {
	const found = await registry.getCollectionWithFields(collection);
	if (!found) return null;
	const revisions = found.supports?.includes("revisions") ?? false;
	const noScheduling = found.supports?.includes("no-scheduling") ?? false;
	return {
		fields: found.fields.map(schemaFieldOf),
		revisions,
		...(noScheduling ? { scheduling: false as const } : {}),
	};
}

/** One registry field as `checkTemplate` reads it. */
function schemaFieldOf(f: RegistryField): SchemaField {
	const relation = f.validation?.relation;
	return {
		slug: f.slug,
		type: f.type,
		required: f.required === true,
		hasDefault: f.defaultValue !== undefined,
		validation: rulesOf(f.validation),
		...(f.unsupportedType === undefined ? {} : { unsupported: true }),
		...(f.type === "reference" && typeof relation === "string" && relation !== ""
			? { storageless: true }
			: {}),
		...(f.type === "reference" ? relationOf(f) : {}),
		...(f.translatable === false ? { translatable: false as const } : {}),
	};
}

/** M6d: the collection's fields as `readCollection` gives them, with its label and theirs. */
export interface SuggestCollection {
	label: string;
	fields: SchemaFieldWithLabel[];
}

/** The suggestion route's collection read (M6d spec step 3): one registry read, labels kept. */
export async function readSuggestCollection(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<SuggestCollection | null> {
	const found = await registry.getCollectionWithFields(collection);
	if (!found) return null;
	return {
		label: found.label ?? collection,
		fields: found.fields.map((f) => ({ ...schemaFieldOf(f), label: f.label ?? f.slug })),
	};
}
