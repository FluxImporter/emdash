/**
 * Server constants the browser needs, copied (plan Ruling 8): the admin module cannot import
 * server code at runtime. `tests/unit/admin-limits.test.ts` pins every value to the server's.
 */

/** `src/plugin/service.ts`: the largest pasted text, in UTF-8 bytes. */
export const PASTE_MAX_BYTES = 1_048_576;
/** `src/plugin/service.ts`: the most records `sources/sample` returns. */
export const SAMPLE_MAX = 20;
/** `src/plugin/schema-apply.ts`: the most fields one `schema/apply` request holds. */
export const MAX_APPLY_FIELDS = 100;
/** `src/plugin/templates.ts`: the longest template name. */
export const TEMPLATE_NAME_MAX = 100;
/** `src/engine/template.ts`: the most fields `rules.update.fields` lists. */
export const MAX_UPDATE_FIELDS = 200;
/** `src/engine/types.ts`: the largest job batch size. */
export const BATCH_SIZE_MAX = 500;

/** `src/engine/template.ts`: a template's `owner`. */
export const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** `src/emdash/uploads.ts`: an upload ID, which the wizard never shows (preflight F15). */
export const UPLOAD_ID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}";

/** `src/sources/reader.ts`: the source formats. */
export const SOURCE_FORMATS = ["csv", "json", "jsonl", "xml", "xlsx"] as const;

/** `src/plugin/schema-apply.ts`: the field types `schema/apply` creates, in its order. */
export const APPLY_FIELD_TYPES: readonly string[] = [
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"json",
	"slug",
	"image",
	"file",
	"portableText",
];

/** A template mapping's `type` (`src/engine/template.ts`). */
export type MappingType =
	| "text"
	| "number"
	| "date"
	| "boolean"
	| "select"
	| "multiSelect"
	| "json"
	| "slug"
	| "reference"
	| "image"
	| "file"
	| "portableText";

/** `src/engine/template.ts`: the field types each mapping type can write. */
export const COMPATIBLE: Readonly<Record<MappingType, readonly string[]>> = {
	text: ["string", "text", "url", "slug"],
	number: ["number", "integer"],
	date: ["datetime", "string", "text"],
	boolean: ["boolean"],
	select: ["select"],
	multiSelect: ["multiSelect"],
	json: ["json"],
	slug: ["slug", "string"],
	reference: ["reference"],
	image: ["image"],
	file: ["file"],
	portableText: ["portableText"],
};

/**
 * EmDash's `RESERVED_FIELD_SLUGS` (emdash `src/schema/types.ts`): `schema/apply` refuses them, so
 * a proposed field never takes one (preflight F16).
 */
export const RESERVED_FIELD_SLUGS: readonly string[] = [
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"terms",
	"bylines",
	"byline",
];

/** `src/engine/values.ts`: the tokens a boolean mapping reads as true when its list is unset. */
export const TRUE_TOKENS: readonly string[] = ["true", "yes", "y", "1", "on"];
/** `src/engine/values.ts`: the tokens a boolean mapping reads as false when its list is unset. */
export const FALSE_TOKENS: readonly string[] = ["false", "no", "n", "0", "off"];
/** `src/engine/links.ts`: the separator between a field's terms, references or bylines. */
export const DEFAULT_SEPARATOR = ",";
/** `src/engine/links.ts`: the separator between a hierarchical term's path segments. */
export const DEFAULT_HIERARCHY = "/";

/**
 * `src/engine/template.ts`, inline in its `tokens` and `optionMap` schemas: a boolean list holds
 * at most 50 tokens of 1-100 characters; a select map's keys are 1-200 characters.
 */
export const TOKENS_MAX = 50;
export const TOKEN_LENGTH_MAX = 100;
export const MAP_KEY_MAX = 200;

/** The most source keys the Keys pane renders at once (Review Focus 4). */
export const KEYS_SHOWN = 200;
