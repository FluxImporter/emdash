import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { parseSourceUrl } from "../sources/net.js";
import { pathProblem, resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
	SOURCE_FORMATS,
	type SourceFormat,
	XLSX_MAX_ROWS,
	XLSX_ROW_FIELD,
} from "../sources/reader.js";
import { dateConverter } from "./dates.js";
import { type CompiledExpression, compileExpression } from "./expressions.js";
import {
	bylinesConverter,
	DEFAULT_HIERARCHY,
	DEFAULT_SEPARATOR,
	type LinkConverted,
	type LinkErrorCode,
	type LinkRequests,
	referenceConverter,
	type TaxonomySnapshot,
	type TermRequest,
	taxonomyConverter,
} from "./links.js";
import {
	acceptsUploadable,
	altConverter,
	MAX_MEDIA_MAPPINGS,
	type MediaConversionCode,
	type MediaKind,
	type MediaRequest,
	mediaUrlConverter,
} from "./media.js";
import {
	convertPortableText,
	MAX_PORTABLE_TEXT_IMAGES,
	MAX_PORTABLE_TEXT_MAPPINGS,
	MAX_PORTABLE_TEXT_RECORD_BYTES,
	MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES,
	type PortableTextCode,
	type PortableTextDraft,
	type PortableTextOptions,
	portableTextBytes,
	portableTextSourceProblem,
	RECORD_SOURCE_TOO_LARGE_MESSAGE,
	RECORD_TOO_LARGE_MESSAGE,
	shownUrl,
	utf8Length,
} from "./portable-text.js";
import type { TaxonomyDef } from "./ports.js";
import {
	booleanConverter,
	type ConversionCode,
	checkRules,
	FALSE_TOKENS,
	type JsonValue,
	jsonConverter,
	multiSelectConverter,
	NOT_SCALAR_MESSAGE,
	numberConverter,
	type RuleCode,
	selectConverter,
	type TargetField,
	TRUE_TOKENS,
} from "./values.js";

export const SOURCE_ID_FIELD = "flux_source_id";
/** `tz: "site"` reads dates in the site's timezone setting, stored on the job at creation. */
export const SITE_TIMEZONE = "site";

const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** EmDash's taxonomy name rule (`createTaxonomyDefBody`, src/api/schemas/taxonomies.ts:18-31). */
const TAXONOMY_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_TAXONOMIES = 20;
const MAX_KEY_LENGTH = 256;
const MAX_SLUG_LENGTH = 200;

const column = z.string().min(1);
const expression = z.string().min(1);
const timezone = z
	.string()
	.min(1)
	.refine((tz) => tz === SITE_TIMEZONE || DateTime.now().setZone(tz).isValid, {
		message: "Unknown timezone",
	});
const tokens = z
	.array(
		z
			.string()
			.min(1)
			.max(100)
			.refine((t) => t.trim() !== "", { message: "Tokens cannot be blank" }),
	)
	.min(1)
	.max(50);
const separator = z.string().min(1).max(10);
const optionMap = z
	.record(z.string().min(1).max(200), z.string().min(1).max(200))
	.refine((m) => Object.keys(m).length <= 1000, { message: "map takes at most 1,000 entries" });

/** Where a key, slug or field value comes from: a source path (`from`) or a JSONata `expr`. */
const valueSource = { from: column.optional(), expr: expression.optional() };
const ONE_SOURCE = { message: 'Set exactly one of "from" and "expr"' };
const hasOneSource = (m: { from?: string | undefined; expr?: string | undefined }) =>
	(m.from === undefined) !== (m.expr === undefined);

const token = (t: string) => t.trim().toLowerCase();

/** The token both effective boolean lists share, if any (a list not set is the default). */
function sharedToken(m: { true?: string[] | undefined; false?: string[] | undefined }) {
	const trues = new Set((m.true ?? TRUE_TOKENS).map(token));
	return (m.false ?? FALSE_TOKENS).map(token).find((t) => trues.has(t));
}

/** An absolute http(s) URL without a user name or password, as `parseSourceUrl` accepts. */
const baseUrl = z
	.string()
	.min(1)
	.refine(
		(text) => {
			try {
				parseSourceUrl(text);
				return true;
			} catch {
				return false;
			}
		},
		{ message: "baseUrl must be an absolute http or https URL" },
	);

/** An image mapping's alt text: from a source path or an expression. */
const altMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

const fieldMapping = z.discriminatedUnion("type", [
	z
		.object({ ...valueSource, type: z.literal("text") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("number"),
			decimal: z.enum([".", ","]).optional(),
			thousands: z.enum([",", ".", " ", "'", "_"]).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE)
		.refine((m) => m.thousands === undefined || m.thousands !== (m.decimal ?? "."), {
			message: "thousands must differ from decimal",
		}),
	z
		.object({
			...valueSource,
			type: z.literal("date"),
			format: z.string().min(1).optional(),
			tz: timezone.default("UTC"),
			output: z.string().min(1).max(100).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("boolean"),
			true: tokens.optional(),
			false: tokens.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE)
		.superRefine((m, ctx) => {
			const shared = sharedToken(m);
			if (shared !== undefined) {
				ctx.addIssue({ code: "custom", message: `"${shared}" is both a true and a false token` });
			}
		}),
	z
		.object({
			...valueSource,
			type: z.literal("select"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("multiSelect"),
			map: optionMap.optional(),
			ignoreCase: z.boolean().optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("json"), parse: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("slug") })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("reference"),
			match: z.enum(["id", "slug", "key"]).optional(),
			separator: separator.optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("image"),
			alt: altMapping.optional(),
			refresh: z.boolean().optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({ ...valueSource, type: z.literal("file"), refresh: z.boolean().optional() })
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
	z
		.object({
			...valueSource,
			type: z.literal("portableText"),
			format: z.enum(["html", "markdown", "text"]),
			baseUrl: baseUrl.optional(),
			images: z.enum(["import", "skip"]).optional(),
			imageErrors: z.enum(["drop", "fail"]).optional(),
			unknownMarkup: z.enum(["warn", "fail"]).optional(),
		})
		.strict()
		.refine(hasOneSource, ONE_SOURCE),
]);
const valueMapping = z.object(valueSource).strict().refine(hasOneSource, ONE_SOURCE);

const taxonomyMapping = z
	.object({
		...valueSource,
		match: z.enum(["slug", "label"]).optional(),
		separator: separator.optional(),
		hierarchy: separator.optional(),
		create: z.boolean().optional(),
	})
	.strict()
	.refine(hasOneSource, ONE_SOURCE)
	.refine((m) => (m.hierarchy ?? DEFAULT_HIERARCHY) !== (m.separator ?? DEFAULT_SEPARATOR), {
		message: "hierarchy must differ from separator",
	});

const bylinesMapping = z
	.object({
		...valueSource,
		match: z.enum(["slug", "name"]).optional(),
		separator: separator.optional(),
	})
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/**
 * When the record's content goes live (M5b): a time read like a `date` mapping into a `datetime`
 * field. A future time schedules the written content; a past or empty one publishes it now.
 */
const publishAtMapping = z
	.object({ ...valueSource, format: z.string().min(1).optional(), tz: timezone.default("UTC") })
	.strict()
	.refine(hasOneSource, ONE_SOURCE);

/** The most names `rules.updateFields` lists (M5b). */
export const MAX_UPDATE_FIELDS = 200;

/** A `rules.owner` name (M5c): it is stored on every owned link row and used as a query value. */
export const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * How each record treats the entry it matches (M5b), and the entries a later feed no longer
 * holds (M5c); every rule is optional.
 *
 * `owner` (M5c) names the entries this template's jobs create; `missing` needs it. One owner
 * name, one feed: two templates with the same owner, collection and locale act as one import,
 * each one's missing phase treating the other's entries as its own. The phase refuses when it
 * can tell that two URL sources share the owner; it cannot tell for uploads and pastes. With the
 * default `maxPercent` of 25, an owner with fewer than four entries refuses as soon as one is
 * missing (1 of 3 is 34%), and one with four accepts one. Feeds whose items come back should use
 * `unpublish`: a trashed entry whose key returns stays a `missing_trashed` conflict until it is
 * restored. A refused run is re-run with the job option `missing: { maxPercent }`, for an
 * unchanged URL source also with `force: true`.
 */
const rulesSchema = z
	.object({
		mode: z.enum(["upsert", "create", "update"]).optional(),
		updateFields: z.array(z.string().min(1).max(200)).min(1).max(MAX_UPDATE_FIELDS).optional(),
		protectEdited: z.boolean().optional(),
		owner: z
			.string()
			.regex(OWNER_PATTERN, "An owner is 1-100 characters of A-Z, a-z, 0-9, '.', '_', ':' and '-'")
			.optional(),
		missing: z
			.object({
				action: z.enum(["trash", "unpublish"]),
				maxPercent: z.number().int().min(0).max(100).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

/**
 * The template's `source` block. Which formats take `records`, `sheet` and `headerRow` is checked
 * by `checkSource` (sources/readers.ts), so a misplaced one is reported as `invalid_source`.
 * `filter` is a JSONata expression evaluated per record, for every format.
 */
export const sourceSchema = z
	.object({
		format: z.enum(SOURCE_FORMATS).default("csv"),
		records: z.string().min(1).optional(),
		sheet: z.union([z.string().min(1).max(100), z.number().int().min(1)]).optional(),
		headerRow: z.number().int().min(1).max(XLSX_MAX_ROWS).optional(),
		filter: expression.optional(),
	})
	.strict();

export const templateSchema = z
	.object({
		version: z.literal(1),
		source: sourceSchema.default(() => ({ ...CSV_SOURCE })),
		collection: z.string().regex(SLUG_RE),
		locale: z.string().min(1),
		key: valueMapping,
		slug: valueMapping.optional(),
		/**
		 * The source key of the entry this record translates, in `locale` (the site's default
		 * locale when left out; job creation always stores it). M4e.
		 */
		translationOf: z
			.object({ ...valueSource, locale: z.string().min(1).optional() })
			.strict()
			.refine(hasOneSource, ONE_SOURCE)
			.optional(),
		fields: z.record(z.string(), fieldMapping).superRefine((fields, ctx) => {
			const names = Object.keys(fields);
			if (names.length === 0) ctx.addIssue({ code: "custom", message: "Map at least one field" });
			for (const name of names) {
				if (!SLUG_RE.test(name)) {
					ctx.addIssue({ code: "custom", message: `Invalid field name "${name}"`, path: [name] });
				}
				if (name === SOURCE_ID_FIELD) {
					ctx.addIssue({
						code: "custom",
						message: `"${SOURCE_ID_FIELD}" is reserved`,
						path: [name],
					});
				}
			}
		}),
		/** Terms to assign, by taxonomy name; each replaces the entry's terms of that taxonomy. */
		taxonomies: z
			.record(z.string(), taxonomyMapping)
			.superRefine((taxonomies, ctx) => {
				const names = Object.keys(taxonomies);
				if (names.length > MAX_TAXONOMIES) {
					ctx.addIssue({
						code: "custom",
						message: `Map at most ${MAX_TAXONOMIES} taxonomies`,
					});
				}
				for (const name of names) {
					if (!TAXONOMY_NAME_RE.test(name)) {
						ctx.addIssue({
							code: "custom",
							message: `Invalid taxonomy name "${name}"`,
							path: [name],
						});
					}
				}
			})
			.optional(),
		/** Existing bylines to credit, in order; replaces the entry's bylines. */
		bylines: bylinesMapping.optional(),
		/** The record's publication time (M5b); only with the job option `publish: true`. */
		publishAt: publishAtMapping.optional(),
		/** Write mode, update scope and edit protection (M5b). */
		rules: rulesSchema.optional(),
	})
	.strict();

export type Template = z.infer<typeof templateSchema>;
export type TemplateRules = NonNullable<Template["rules"]>;
export type FieldMapping = Template["fields"][string];
export type MappingType = FieldMapping["type"];
export type TaxonomyMapping = NonNullable<Template["taxonomies"]>[string];
export type BylinesMapping = NonNullable<Template["bylines"]>;

export type {
	JsonValue,
	LinkRequests,
	MediaRequest,
	PortableTextDraft,
	TargetField,
	TaxonomySnapshot,
	TermRequest,
};
export type FieldValue = string | number | boolean | string[] | JsonValue | null;
/**
 * One record after the template: the key, the slug, the field values, the link requests
 * (reference fields, taxonomies, bylines) when the template maps any, and the media requests
 * when it maps image or file fields (null for an empty value), and the Portable Text drafts when
 * it maps `portableText` fields (null for an empty value). Reference, media and Portable Text
 * fields are kept out of `data`. `translationOf` is the trimmed source key of the entry the
 * record translates (M4e), absent when the template maps none or the value is blank.
 */
export type MappedRecord = {
	key: string;
	translationOf?: string;
	slug?: string;
	/** The publication time as UTC ISO (M5b); null when empty, absent when not mapped. */
	publishAt?: string | null;
	data: Record<string, FieldValue>;
	links?: LinkRequests;
	media?: Record<string, MediaRequest | null>;
	portableText?: Record<string, PortableTextDraft | null>;
};
export type ValueErrorCode =
	| "filter_error"
	| "filter_not_boolean"
	| "expr_error"
	| "expr_limit"
	| "missing_key"
	| "key_too_long"
	| "invalid_date"
	| "empty_slug"
	| ConversionCode
	| RuleCode
	| LinkErrorCode
	| MediaConversionCode
	| PortableTextCode;
export type ValueError = { field: string; code: ValueErrorCode; message: string };

export function slugify(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, "");
}

type Converted =
	| { ok: true; value: FieldValue }
	| { ok: false; code: ValueErrorCode; message: string };
export type FieldConverter = (raw: unknown) => Converted;

/** A source value as text (numbers and booleans as their string), or null for an object or array. */
function scalarText(raw: unknown): string | null {
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

/** Text as given (untrimmed); `slug` through `slugify`, failing `empty_slug` if nothing is left. */
function textConverter(slug: boolean): FieldConverter {
	return (raw) => {
		const text = scalarText(raw);
		if (text === null) return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		if (text.trim() === "") return { ok: true, value: null };
		if (!slug) return { ok: true, value: text };
		const value = slugify(text);
		if (value === "") return { ok: false, code: "empty_slug", message: "The slug would be empty" };
		return { ok: true, value };
	};
}

/**
 * The conversion for one mapping (values.ts, dates.ts): a missing path or `null` is empty, an
 * object or array fails `not_scalar` except for `multiSelect` and `json`, and empty text is
 * `null`. `target` is the field from the job's snapshot (null for jobs created before M4a): it
 * gives select options and whether a date goes into a text field. `tz: "site"` reads
 * `siteTimezone`.
 */
export function fieldConverter(
	mapping: FieldMapping,
	target: TargetField | null,
	siteTimezone: string,
): FieldConverter {
	switch (mapping.type) {
		case "text":
			return textConverter(false);
		case "slug":
			return textConverter(true);
		case "number":
			return numberConverter(mapping);
		case "boolean":
			return booleanConverter(mapping);
		case "select":
			return selectConverter(mapping, target?.options);
		case "multiSelect":
			return multiSelectConverter(mapping, target?.options);
		case "json":
			return jsonConverter(mapping);
		case "date": {
			const tz = mapping.tz === SITE_TIMEZONE ? siteTimezone : mapping.tz;
			return dateConverter(
				{ format: mapping.format, tz, output: mapping.output },
				target?.type ?? null,
			);
		}
		case "reference":
			return referenceConverter(mapping, target);
		case "image":
		case "file":
			return mediaUrlConverter;
		case "portableText":
			return portableTextSource;
	}
}

/**
 * A `portableText` source value: a missing path, `null` or blank text is empty (null), and
 * anything but text fails `not_scalar`, numbers and booleans included. `applyTemplate` converts
 * the text.
 */
function portableTextSource(raw: unknown): Converted {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (typeof raw !== "string") {
		const message = `Expected HTML, Markdown or text, found ${kindOf(raw)}`;
		return { ok: false, code: "not_scalar", message };
	}
	return { ok: true, value: raw.trim() === "" ? null : raw };
}

/** A link mapping read from `from` or `expr` and converted to lookup requests. */
export interface LinkReader<T> {
	readonly from: string | undefined;
	readonly expr: CompiledExpression | null;
	readonly convert: (raw: unknown) => LinkConverted<T>;
}

/** An image or file mapping as each record reads it; `alt` is null for files and images without it. */
export interface MediaReader {
	readonly kind: MediaKind;
	readonly refresh: boolean;
	readonly alt: {
		readonly from: string | undefined;
		readonly expr: CompiledExpression | null;
	} | null;
}

/** A template with its expressions parsed once, for every record of a batch. */
export interface CompiledTemplate {
	readonly template: Template;
	readonly filter: CompiledExpression | null;
	/** The key's `expr`, or null when it reads `from`. */
	readonly key: CompiledExpression | null;
	/** The slug's `expr`, or null when there is no slug or it reads `from`. */
	readonly slug: CompiledExpression | null;
	/** The `translationOf` `expr`, or null when there is none or it reads `from`. */
	readonly translationOf: CompiledExpression | null;
	/** The `publishAt` `expr` and conversion (M5b), or null when the template maps none. */
	readonly publishAt: { expr: CompiledExpression | null; convert: FieldConverter } | null;
	/**
	 * The fields a record with a `translationOf` value does not read (`isSharedMapping`): EmDash
	 * shares their values across the translation group. Empty without `translationOf`.
	 */
	readonly shared: ReadonlySet<string>;
	/** `Job.sharedRequired`: fields a record without a `translationOf` value fails `required` for. */
	readonly sharedRequired: readonly string[];
	/** Each field's `expr`, by field name; fields that read `from` are absent. */
	readonly fields: ReadonlyMap<string, CompiledExpression>;
	/** Each field's conversion, by field name. */
	readonly converters: ReadonlyMap<string, FieldConverter>;
	/** The job's target field snapshot; null for jobs created before M4a (no field rules). */
	readonly targets: Readonly<Record<string, TargetField>> | null;
	/** Each mapped taxonomy's reader, by taxonomy name. */
	readonly taxonomies: ReadonlyMap<string, LinkReader<TermRequest>>;
	/** The bylines reader, or null when the template maps no bylines. */
	readonly bylines: LinkReader<string> | null;
	/** Each image and file field's reader, by field name. */
	readonly media: ReadonlyMap<string, MediaReader>;
	/** Each `portableText` field's options, by field name, with their defaults. */
	readonly portableText: ReadonlyMap<string, PortableTextOptions>;
}

/** What a job knows about its target fields; absent on jobs created before M4a. */
export interface CompileContext {
	targets?: Readonly<Record<string, TargetField>> | undefined;
	/** The site timezone stored on the job; `UTC` when absent. */
	siteTimezone?: string | undefined;
	/** The mapped taxonomies as they were at job creation (M4b); flat when absent. */
	taxonomies?: Readonly<Record<string, TaxonomySnapshot>> | undefined;
	/** `Job.sharedRequired` (M4e); none when absent. */
	sharedRequired?: readonly string[] | undefined;
}

/**
 * Parses every expression of the template (filter, key, slug, fields) once. Problems name the
 * template location: `source.filter: JSONata S0207 at character 7: Unexpected end of expression`.
 */
export function compileTemplate(
	t: Template,
	context: CompileContext = {},
): { ok: true; compiled: CompiledTemplate } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const compile = (label: string, text: string | undefined): CompiledExpression | null => {
		if (text === undefined) return null;
		const result = compileExpression(text);
		if (result.ok) return result.expression;
		problems.push(`${label}: ${result.problem}`);
		return null;
	};
	const filter = compile("source.filter", t.source.filter);
	const key = compile("key.expr", t.key.expr);
	const slug = compile("slug.expr", t.slug?.expr);
	const translationOf = compile("translationOf.expr", t.translationOf?.expr);
	const publishAtExpr = compile("publishAt.expr", t.publishAt?.expr);
	const fields = new Map<string, CompiledExpression>();
	const converters = new Map<string, FieldConverter>();
	const targets = context.targets ?? null;
	const media = new Map<string, MediaReader>();
	const portableText = new Map<string, PortableTextOptions>();
	for (const [name, mapping] of Object.entries(t.fields)) {
		const expr = compile(`fields.${name}.expr`, mapping.expr);
		if (expr !== null) fields.set(name, expr);
		converters.set(
			name,
			fieldConverter(mapping, targets?.[name] ?? null, context.siteTimezone ?? "UTC"),
		);
		if (mapping.type === "image" || mapping.type === "file") {
			const alt = mapping.type === "image" ? mapping.alt : undefined;
			media.set(name, {
				kind: mapping.type,
				refresh: mapping.refresh ?? false,
				alt:
					alt === undefined
						? null
						: { from: alt.from, expr: compile(`fields.${name}.alt.expr`, alt.expr) },
			});
		}
		if (mapping.type === "portableText") portableText.set(name, portableTextOptions(mapping));
	}
	const shared = new Set(
		t.translationOf === undefined
			? []
			: Object.keys(t.fields).filter((name) =>
					isSharedMapping(t.fields[name] as FieldMapping, targets?.[name]),
				),
	);
	const taxonomies = new Map<string, LinkReader<TermRequest>>();
	for (const [name, mapping] of Object.entries(t.taxonomies ?? {})) {
		taxonomies.set(name, {
			from: mapping.from,
			expr: compile(`taxonomies.${name}.expr`, mapping.expr),
			convert: taxonomyConverter(mapping, context.taxonomies?.[name] ?? null),
		});
	}
	const bylines =
		t.bylines === undefined
			? null
			: {
					from: t.bylines.from,
					expr: compile("bylines.expr", t.bylines.expr),
					convert: bylinesConverter(t.bylines),
				};
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		compiled: {
			template: t,
			filter,
			key,
			slug,
			translationOf,
			publishAt:
				t.publishAt === undefined
					? null
					: {
							expr: publishAtExpr,
							convert: publishAtConverter(t.publishAt, context.siteTimezone ?? "UTC"),
						},
			shared,
			sharedRequired: context.sharedRequired ?? [],
			fields,
			converters,
			targets,
			taxonomies,
			bylines,
			media,
			portableText,
		},
	};
}

/**
 * The `publishAt` conversion (M5b): a `date` mapping into a `datetime` field, so the value is UTC
 * ISO; `tz: "site"` reads `siteTimezone`.
 */
function publishAtConverter(
	mapping: NonNullable<Template["publishAt"]>,
	siteTimezone: string,
): FieldConverter {
	const tz = mapping.tz === SITE_TIMEZONE ? siteTimezone : mapping.tz;
	return dateConverter({ format: mapping.format, tz }, "datetime");
}

/** A `portableText` mapping's options with their defaults filled in. */
export function portableTextOptions(
	mapping: Extract<FieldMapping, { type: "portableText" }>,
): PortableTextOptions {
	return {
		format: mapping.format,
		baseUrl: mapping.baseUrl ?? null,
		images: mapping.images ?? "import",
		imageErrors: mapping.imageErrors ?? "drop",
		unknownMarkup: mapping.unknownMarkup ?? "warn",
	};
}

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	return `a ${typeof value}`;
}

/**
 * Runs the template's `source.filter` on one record value. `true` (or no filter) keeps the record;
 * `false`, an empty result or `undefined` skips it (`filtered`); anything else, or a failure,
 * fails it with `filter_not_boolean`, `filter_error` or `expr_limit`.
 */
export async function filterRecord(
	c: CompiledTemplate,
	value: unknown,
): Promise<{ keep: boolean } | { error: ValueError }> {
	if (c.filter === null) return { keep: true };
	const result = await c.filter.evaluate(value);
	if (!result.ok) {
		const code = result.limit ? "expr_limit" : "filter_error";
		return { error: { field: "filter", code, message: result.message } };
	}
	if (result.value === true) return { keep: true };
	if (result.value === false || result.value === undefined) return { keep: false };
	const message = `The filter must give true or false; it gave ${kindOf(result.value)}`;
	return { error: { field: "filter", code: "filter_not_boolean", message } };
}

/** Marks a value whose expression failed; the failure is already in the record's errors. */
const FAILED = Symbol("failed");

/** What `applyTemplate` reports without failing the record: Portable Text conversion warnings. */
export type ValueWarning = { field: string; code: PortableTextCode; message: string };

/**
 * Applies the template to one record value (a CSV row object, a JSON value, an XML object): reads
 * the key, the slug, each field, each taxonomy and the bylines from `from` or `expr` and converts
 * them, collecting every error. An expression result goes through the same conversion as a path
 * value, and `undefined` reads as a missing path. Reference fields and the other links go into
 * `links`, as lookup requests, and Portable Text into `portableText`, as drafts. `warnings` is
 * present when a Portable Text conversion reported something, also for a record that fails.
 * After the key it reads `translationOf` (M4e): a record with a value does not read the shared
 * mappings (`CompiledTemplate.shared`, every taxonomy), so they can neither fail it nor be
 * written; a record without one fails `required` for each of `sharedRequired`. Run
 * `filterRecord` first.
 */
export async function applyTemplate(
	c: CompiledTemplate,
	value: unknown,
): Promise<
	| { ok: true; value: MappedRecord; warnings?: ValueWarning[] }
	| { ok: false; errors: ValueError[]; warnings?: ValueWarning[]; key?: string }
> {
	const t = c.template;
	const errors: ValueError[] = [];
	const warnings: ValueWarning[] = [];
	const read = async (
		field: string,
		from: string | undefined,
		expr: CompiledExpression | null | undefined,
	): Promise<unknown> => {
		if (expr === null || expr === undefined) {
			return resolvePath(value, from ?? "", t.source.format);
		}
		const result = await expr.evaluate(value);
		if (result.ok) return result.value;
		errors.push({
			field,
			code: result.limit ? "expr_limit" : "expr_error",
			message: result.message,
		});
		return FAILED;
	};

	const keyField = t.key.from ?? "key";
	const keyRaw = await read(keyField, t.key.from, c.key);
	let key = "";
	if (keyRaw !== FAILED) {
		const keyText = scalarText(keyRaw);
		key = keyText?.trim() ?? "";
		if (keyText === null) {
			errors.push({ field: keyField, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
		} else if (key === "") {
			errors.push({ field: keyField, code: "missing_key", message: "The key column is empty" });
		} else if (key.length > MAX_KEY_LENGTH) {
			errors.push({
				field: keyField,
				code: "key_too_long",
				message: `Keys are limited to ${MAX_KEY_LENGTH} characters`,
			});
		}
	}

	// M5c (Ruling 24): the key is the first mapping read, so it was read and is valid exactly when
	// no error was pushed so far; a record with such a key is in the feed whatever else fails.
	const keyRead = keyRaw !== FAILED && errors.length === 0;
	let translationOf: string | undefined;
	// A value that cannot be read still names a source: the record fails, without reading the
	// shared mappings.
	let linked = false;
	if (t.translationOf) {
		const field = "translationOf";
		const sourceRaw = await read(field, t.translationOf.from, c.translationOf);
		linked = sourceRaw === FAILED;
		if (sourceRaw !== FAILED) {
			const sourceText = scalarText(sourceRaw);
			const sourceKey = sourceText?.trim() ?? "";
			if (sourceText === null) {
				linked = true;
				errors.push({ field, code: "not_scalar", message: NOT_SCALAR_MESSAGE });
			} else if (sourceKey !== "") {
				linked = true;
				if (sourceKey.length > MAX_KEY_LENGTH) {
					const message = `Keys are limited to ${MAX_KEY_LENGTH} characters`;
					errors.push({ field, code: "key_too_long", message });
				} else translationOf = sourceKey;
			}
		}
	}

	let slug: string | undefined;
	if (t.slug) {
		const slugRaw = await read("slug", t.slug.from, c.slug);
		if (slugRaw !== FAILED) {
			const slugText = scalarText(slugRaw);
			if (slugText === null) {
				errors.push({ field: "slug", code: "not_scalar", message: NOT_SCALAR_MESSAGE });
			} else {
				slug = slugify(slugText);
				if (slug === "") {
					errors.push({ field: "slug", code: "empty_slug", message: "The slug would be empty" });
				}
			}
		}
	}

	let publishAt: string | null | undefined;
	if (c.publishAt !== null && t.publishAt !== undefined) {
		const raw = await read("publishAt", t.publishAt.from, c.publishAt.expr);
		if (raw !== FAILED) {
			const result = c.publishAt.convert(raw);
			if (result.ok) publishAt = result.value as string | null;
			else errors.push({ field: "publishAt", code: result.code, message: result.message });
		}
	}

	const data: Record<string, FieldValue> = {};
	const links: LinkRequests = {};
	const media: Record<string, MediaRequest | null> = {};
	const portableText: Record<string, PortableTextDraft | null> = {};
	const sources: PortableTextSource[] = [];
	for (const [field, mapping] of Object.entries(t.fields)) {
		if (linked && c.shared.has(field)) continue;
		const raw = await read(field, mapping.from, c.fields.get(field));
		if (raw === FAILED) continue;
		const result = (c.converters.get(field) as FieldConverter)(raw);
		if (!result.ok) {
			errors.push({ field, code: result.code, message: result.message });
			continue;
		}
		const target = c.targets?.[field];
		const broken = target === undefined ? [] : checkRules(result.value, target);
		for (const e of broken) errors.push({ field, ...e });
		if (broken.length > 0) continue;
		const reader = c.media.get(field);
		const options = c.portableText.get(field);
		if (options !== undefined) {
			// Converted once every field is read, so their sizes are known before any is parsed.
			const text = result.value as string | null;
			sources.push({ field, text, options, target, at: errors.length });
		} else if (mapping.type === "reference") {
			links.references ??= {};
			links.references[field] = result.value as string[] | null;
		} else if (reader !== undefined) {
			const url = result.value as string | null;
			if (url === null) {
				media[field] = null;
				continue;
			}
			let alt: string | null = null;
			if (reader.alt !== null) {
				const altField = `${field}.alt`;
				const altRaw = await read(altField, reader.alt.from, reader.alt.expr);
				if (altRaw === FAILED) continue;
				const converted = altConverter(altRaw);
				if (!converted.ok) {
					errors.push({ field: altField, code: converted.code, message: converted.message });
					continue;
				}
				alt = converted.value;
			}
			media[field] = { kind: reader.kind, url, alt, refresh: reader.refresh };
		} else data[field] = result.value;
	}
	if (sources.length > 0) convertSources(sources, portableText, errors, warnings);
	// Assignments are keyed by translation group: a translation shares its source's terms.
	for (const [name, reader] of linked ? [] : c.taxonomies) {
		const field = `taxonomies.${name}`;
		const raw = await read(field, reader.from, reader.expr);
		if (raw === FAILED) continue;
		const result = reader.convert(raw);
		if (!result.ok) errors.push({ field, code: result.code, message: result.message });
		else {
			links.taxonomies ??= {};
			links.taxonomies[name] = result.value;
		}
	}
	if (c.bylines !== null) {
		const raw = await read("bylines", c.bylines.from, c.bylines.expr);
		if (raw !== FAILED) {
			const result = c.bylines.convert(raw);
			if (!result.ok) errors.push({ field: "bylines", code: result.code, message: result.message });
			else links.bylines = result.value;
		}
	}

	if (c.portableText.size > 0) limitPortableText(c, portableText, errors, warnings);
	if (!linked) {
		for (const field of c.sharedRequired) {
			errors.push({ field, code: "required", message: "The field is required" });
		}
	}

	const reported = warnings.length > 0 ? { warnings } : {};
	if (errors.length > 0) return { ok: false, errors, ...reported, ...(keyRead ? { key } : {}) };
	const mapped: MappedRecord = slug === undefined ? { key, data } : { key, slug, data };
	if (translationOf !== undefined) mapped.translationOf = translationOf;
	if (publishAt !== undefined) mapped.publishAt = publishAt;
	if (Object.keys(links).length > 0) mapped.links = links;
	if (c.media.size > 0) mapped.media = media;
	if (c.portableText.size > 0) mapped.portableText = portableText;
	return { ok: true, value: mapped, ...reported };
}

/** A `portableText` field's source value, and where its errors go in the record's list. */
type PortableTextSource = {
	field: string;
	text: string | null;
	options: PortableTextOptions;
	target: TargetField | undefined;
	/** The length of the record's errors when the field was read. */
	at: number;
};

/**
 * Converts each `portableText` field in template order, each with what the fields before it left
 * of `MAX_PORTABLE_TEXT_RECORD_BYTES`. Nothing is parsed when a field's source text is over its
 * own limit, which fails that field, or when the fields' source text is over
 * `MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES` together, which fails the field that goes over. Each
 * field's errors are inserted where it was read, so they stay in template order with the other
 * fields' errors.
 */
function convertSources(
	sources: readonly PortableTextSource[],
	drafts: Record<string, PortableTextDraft | null>,
	errors: ValueError[],
	warnings: ValueWarning[],
): void {
	let inserted = 0;
	const report = (source: PortableTextSource, found: readonly ValueError[]) => {
		errors.splice(source.at + inserted, 0, ...found);
		inserted += found.length;
	};
	for (const { field } of sources) drafts[field] = null;
	let total = 0;
	let tooLarge = false;
	for (const source of sources) {
		if (source.text === null) continue;
		const own = portableTextSourceProblem(source.text, source.options.format);
		if (own !== null) {
			report(source, [{ field: source.field, ...own }]);
			tooLarge = true;
			continue;
		}
		total += utf8Length(source.text);
		if (total > MAX_PORTABLE_TEXT_RECORD_SOURCE_BYTES) {
			const message = RECORD_SOURCE_TOO_LARGE_MESSAGE;
			report(source, [{ field: source.field, code: "portable_text_too_large", message }]);
			tooLarge = true;
			break;
		}
	}
	if (tooLarge) return;
	let used = 0;
	for (const source of sources) {
		const { field, text, options, target } = source;
		if (text === null) continue;
		const converted = convertPortableText(text, options, MAX_PORTABLE_TEXT_RECORD_BYTES - used);
		const found: ValueError[] = converted.errors.map((e) => ({ field, ...e }));
		for (const w of converted.warnings) warnings.push({ field, ...w });
		const draft = converted.draft;
		// Markup that leaves no block is empty, as a missing value is.
		if (draft === null && target !== undefined && found.length === 0) {
			for (const e of checkRules(null, target)) found.push({ field, ...e });
		}
		report(source, found);
		drafts[field] = draft;
		if (draft !== null) used += portableTextBytes(draft.blocks);
		// Past the budget, the later fields could only fail too.
		if (converted.errors.some((e) => e.message === RECORD_TOO_LARGE_MESSAGE)) return;
	}
}

/**
 * The per-record limits over every Portable Text field, in template order: at most
 * `MAX_PORTABLE_TEXT_IMAGES` distinct image URLs (the rest are dropped with one `image_dropped`
 * warning per field, or fail `portable_text_limit` with `imageErrors: "fail"`), then at most
 * `MAX_PORTABLE_TEXT_RECORD_BYTES` of JSON, each image block counted with
 * `IMAGE_BLOCK_ALLOWANCE` (`portable_text_too_large`).
 */
function limitPortableText(
	c: CompiledTemplate,
	drafts: Record<string, PortableTextDraft | null>,
	errors: ValueError[],
	warnings: ValueWarning[],
): void {
	const seen = new Set<string>();
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null || draft.images.length === 0) continue;
		const over = draft.images.filter((image) => {
			if (seen.has(image.url)) return false;
			if (seen.size < MAX_PORTABLE_TEXT_IMAGES) {
				seen.add(image.url);
				return false;
			}
			return true;
		});
		if (over.length === 0) continue;
		if (c.portableText.get(field)?.imageErrors === "fail") {
			errors.push({
				field,
				code: "portable_text_limit",
				message: `The record's Portable Text has more than ${MAX_PORTABLE_TEXT_IMAGES} distinct image URLs`,
			});
			continue;
		}
		const first = over[0] as { url: string };
		const which =
			over.length === 1
				? `1 image (${shownUrl(first.url)})`
				: `${over.length} images (${shownUrl(first.url)}, …)`;
		warnings.push({
			field,
			code: "image_dropped",
			message: `Left out ${which}: at most ${MAX_PORTABLE_TEXT_IMAGES} distinct image URLs per record`,
		});
		const kept = withoutImages(draft, new Set(over.map((image) => image.url)));
		drafts[field] = kept;
		if (kept === null && c.targets?.[field]?.required === true) {
			errors.push({ field, code: "required", message: "The field is required" });
		}
	}
	// The exact size, as a backstop to the converter's running estimate.
	let bytes = 0;
	for (const [field, draft] of Object.entries(drafts)) {
		if (draft === null) continue;
		bytes += portableTextBytes(draft.blocks);
		if (bytes > MAX_PORTABLE_TEXT_RECORD_BYTES) {
			errors.push({ field, code: "portable_text_too_large", message: RECORD_TOO_LARGE_MESSAGE });
			return;
		}
	}
}

/** A draft without the images whose URL is in `urls`; slots are renumbered, keys kept. */
function withoutImages(
	draft: PortableTextDraft,
	urls: ReadonlySet<string>,
): PortableTextDraft | null {
	const slots = new Map<number, number>();
	const images = draft.images.filter((image, i) => {
		if (urls.has(image.url)) return false;
		slots.set(i, slots.size);
		return true;
	});
	const blocks = draft.blocks.flatMap((block) => {
		if (block._type !== "image") return [block];
		const slot = slots.get(block.slot as number);
		return slot === undefined ? [] : [{ ...block, slot }];
	});
	return blocks.length === 0 ? null : { blocks, images };
}

/**
 * Every source path the template reads: key, slug, field, image alt, taxonomy and bylines
 * `from`s, without duplicates. Expressions are not analysed for the paths they read.
 */
export function templatePaths(t: Template): string[] {
	const froms = [
		t.key.from,
		t.translationOf?.from,
		t.slug?.from,
		t.publishAt?.from,
		...Object.values(t.fields).flatMap((m) =>
			m.type === "image" ? [m.from, m.alt?.from] : [m.from],
		),
		...Object.values(t.taxonomies ?? {}).map((m) => m.from),
		t.bylines?.from,
	];
	return [...new Set(froms.filter((path): path is string => path !== undefined))];
}

/** The paths of `paths` that do not resolve in one record value. */
export function unresolvedPaths(t: Template, paths: readonly string[], value: unknown): string[] {
	return paths.filter((path) => resolvePath(value, path, t.source.format) === undefined);
}

/**
 * Warnings for JSON, JSON Lines and XML template paths that resolved in none of `checked`
 * record values. Nothing checked proves nothing, so it gives none. CSV columns are checked
 * against the header by `checkTemplate` instead.
 */
export function missingPathWarnings(unresolved: readonly string[], checked: number): string[] {
	if (checked === 0) return [];
	return unresolved.map((path) => `Path "${path}" was not found in the first ${checked} records`);
}

/** The warning for a source whose records array or element holds no records. */
export function noRecordsWarning(source: { records?: string | undefined }): string {
	return source.records === undefined
		? "No records found in the file"
		: `No records found at "${source.records}"`;
}

/**
 * The validation keys EmDash enforces on writes (`emdash` src/schema/zod-generator.ts:240-290),
 * and the media types an image or file field accepts (src/api/handlers/validate-media-fields.ts).
 */
export type FieldRules = Pick<
	TargetField,
	"options" | "min" | "max" | "minLength" | "maxLength" | "pattern" | "allowedMimeTypes"
>;

/**
 * A collection field as `checkTemplate` sees it. Only `slug` and `type` are always known; the
 * rest comes from `listSchemaFields` and is absent in callers that only check types.
 */
export type SchemaField = {
	slug: string;
	type: string;
	required?: boolean;
	/** The field has a `defaultValue`, which EmDash fills in when a create leaves it out. */
	hasDefault?: boolean;
	validation?: FieldRules;
	/** The stored type is one this EmDash cannot interpret (`Field.unsupportedType`). */
	unsupported?: boolean;
	/** The field keeps its values outside the content table (a bound reference). */
	storageless?: boolean;
	/** Reference fields: the end of the relation the field sits on. */
	relationSide?: "parent" | "child";
	/** Reference fields: the collection the field links to. */
	targetCollection?: string;
	/** Reference fields: the parent side takes more than one entry. */
	multiple?: boolean;
	/** EmDash shares the field's value across a translation group (`Field.translatable: false`). */
	translatable?: false;
};

/** What job creation reads besides the collection's fields, for links (M4b). */
export type LinkSchema = {
	/** The fields of each reference field's target collection; null when it does not exist. */
	targets?: Readonly<Record<string, SchemaField[] | null>>;
	/** Every taxonomy definition, in every locale. */
	taxonomies?: readonly TaxonomyDef[];
};

/** EmDash's guide to binding a reference field that predates relations. */
export const BIND_REFERENCE_DOCS =
	"https://docs.emdashcms.com/guides/relations/#bind-a-field-that-has-no-relation";

export const COMPATIBLE: Record<MappingType, string[]> = {
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

/** Whether `value` names one of `options`, as the select matching would find it. */
export function matchesOption(
	value: string,
	options: readonly string[],
	ignoreCase: boolean,
): boolean {
	if (options.includes(value)) return true;
	if (!ignoreCase) return false;
	// As the converters match: ignoring case needs exactly one distinct option, else it is ambiguous.
	const lower = value.toLowerCase();
	return new Set(options.filter((o) => o.toLowerCase() === lower)).size === 1;
}

/**
 * Problems with a reference mapping: the field must be a reference bound to a relation, its
 * target collection must exist, and `match: "key"` needs entries imported into the target.
 */
function referenceProblems(
	field: string,
	mapping: Extract<FieldMapping, { type: "reference" }>,
	target: SchemaField,
	links: LinkSchema,
	own: string,
): string[] {
	if (target.type !== "reference") {
		return [
			`Field "${field}" has type "${target.type}"; a reference mapping needs one of reference`,
		];
	}
	const collection = target.targetCollection;
	if (!target.storageless || collection === undefined) {
		return [
			`Field "${field}" is a reference field without a relation; bind it first (${BIND_REFERENCE_DOCS})`,
		];
	}
	const targetFields = links.targets?.[collection];
	if (targetFields === null) {
		return [`Field "${field}" links to collection "${collection}", which does not exist`];
	}
	if (
		mapping.match === "key" &&
		// The job adds the import key to its own collection, so it needs no entries yet.
		collection !== own &&
		targetFields !== undefined &&
		!targetFields.some((f) => f.slug === SOURCE_ID_FIELD)
	) {
		return [
			`Field "${field}" finds entries by import key, but no entries were imported into "${collection}"`,
		];
	}
	return [];
}

/** Problems with one mapping against its existing collection field. */
function fieldProblems(
	field: string,
	mapping: FieldMapping,
	target: SchemaField,
	siteTimezone: string,
	links: LinkSchema,
	collection: string,
): string[] {
	if (target.unsupported) {
		return [`Field "${field}" has a field type this EmDash version cannot read`];
	}
	if (mapping.type === "reference")
		return referenceProblems(field, mapping, target, links, collection);
	if (target.storageless) {
		return [`Field "${field}" keeps its values outside the content table and cannot be imported`];
	}
	const compatible = COMPATIBLE[mapping.type];
	if (!compatible.includes(target.type)) {
		const article = mapping.type === "image" ? "an" : "a";
		return [
			`Field "${field}" has type "${target.type}"; ${article} ${mapping.type} mapping needs one of ${compatible.join(", ")}`,
		];
	}
	const problems: string[] = [];
	const allowed = target.validation?.allowedMimeTypes ?? [];
	if (
		(mapping.type === "image" || mapping.type === "file") &&
		allowed.length > 0 &&
		!acceptsUploadable(allowed, mapping.type)
	) {
		problems.push(
			`Field "${field}": EmDash's upload refuses every type this field accepts (${allowed.join(", ")})`,
		);
	}
	if (mapping.type === "date") {
		if (mapping.output !== undefined && target.type === "datetime") {
			problems.push(`Field "${field}" is a datetime field; "output" only formats text fields`);
		}
		if (mapping.tz === SITE_TIMEZONE && !IANAZone.isValidZone(siteTimezone)) {
			problems.push(
				`Field "${field}" reads dates in the site timezone, but "${siteTimezone}" is not a valid IANA timezone`,
			);
		}
	}
	if ((mapping.type === "select" || mapping.type === "multiSelect") && mapping.map) {
		const options = target.validation?.options ?? [];
		if (options.length > 0) {
			const ignoreCase = mapping.ignoreCase ?? true;
			const bad = [...new Set(Object.values(mapping.map))].filter(
				(v) => !matchesOption(v, options, ignoreCase),
			);
			for (const value of bad) {
				problems.push(
					`Field "${field}" maps to "${value}", which is not one of its options (${options.join(", ")})`,
				);
			}
		}
	}
	return problems;
}

/**
 * Problems that stop a job: CSV and XLSX columns missing from the header (`columns`; an XLSX
 * template may also read `_row`), field paths that are not valid for the source format, fields
 * the collection lacks or types it cannot take, `output` into a datetime field, `map` values
 * that are not options, `tz: "site"` without a valid site timezone, required fields with no
 * default that the template does not map (every create would fail), reference fields that are
 * unbound or link to a missing collection, and taxonomies that do not exist or are not attached
 * to the collection, more than five image and file mappings, more than three `portableText`
 * mappings, and image or file fields whose `allowedMimeTypes` EmDash's upload can never
 * satisfy. A template that maps `translationOf` needs its source locale set and different from
 * `locale`, and leaves required non-translatable fields to EmDash (`sharedRequiredOf`). The link
 * checks run only on what `links` carries.
 */
export function checkTemplate(
	t: Template,
	fields: SchemaField[],
	columns: readonly string[] | null,
	siteTimezone = "UTC",
	links: LinkSchema = {},
): string[] {
	const errors: string[] = [];
	const format: SourceFormat = t.source.format;
	for (const path of templatePaths(t)) {
		if (format === "csv" || format === "xlsx") {
			const implicit = format === "xlsx" && path === XLSX_ROW_FIELD;
			if (columns !== null && !columns.includes(path) && !implicit) {
				errors.push(`Column "${path}" not found in the source`);
			}
			continue;
		}
		const problem = pathProblem(path, format);
		if (problem !== null) errors.push(problem);
	}
	const media = Object.values(t.fields).filter((m) => m.type === "image" || m.type === "file");
	if (media.length > MAX_MEDIA_MAPPINGS) {
		errors.push(
			`The template maps ${media.length} image and file fields; at most ${MAX_MEDIA_MAPPINGS} are allowed`,
		);
	}
	const rich = Object.values(t.fields).filter((m) => m.type === "portableText");
	if (rich.length > MAX_PORTABLE_TEXT_MAPPINGS) {
		errors.push(
			`The template maps ${rich.length} portableText fields; at most ${MAX_PORTABLE_TEXT_MAPPINGS} are allowed`,
		);
	}
	if (t.publishAt?.tz === SITE_TIMEZONE && !IANAZone.isValidZone(siteTimezone)) {
		errors.push(
			`publishAt reads times in the site timezone, but "${siteTimezone}" is not a valid IANA timezone`,
		);
	}
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	for (const [field, mapping] of Object.entries(t.fields)) {
		const target = byslug.get(field);
		if (target === undefined) {
			errors.push(`Field "${field}" does not exist in collection "${t.collection}"`);
		} else {
			errors.push(...fieldProblems(field, mapping, target, siteTimezone, links, t.collection));
		}
	}
	if (links.taxonomies !== undefined) {
		for (const name of Object.keys(t.taxonomies ?? {})) {
			// EmDash does not check attachment when it assigns terms, so the importer does.
			const defs = links.taxonomies.filter((d) => d.name === name);
			if (defs.length === 0) errors.push(`Taxonomy "${name}" does not exist`);
			else if (!defs.some((d) => d.collections.includes(t.collection))) {
				errors.push(`Taxonomy "${name}" is not attached to collection "${t.collection}"`);
			}
		}
	}
	for (const f of fields) {
		// EmDash refuses every write to a collection with a field it cannot read, mapped or not.
		if (f.unsupported && !Object.hasOwn(t.fields, f.slug)) {
			errors.push(`Field "${f.slug}" has a field type this EmDash version cannot read`);
		}
		if (
			f.required &&
			!f.hasDefault &&
			!Object.hasOwn(t.fields, f.slug) &&
			f.slug !== SOURCE_ID_FIELD &&
			// A translation takes the value from its source (spec M4e F1).
			!(t.translationOf !== undefined && f.translatable === false)
		) {
			errors.push(
				`Field "${f.slug}" is required and has no default, but the template does not map it`,
			);
		}
	}
	const source = t.translationOf;
	if (source !== undefined) {
		if (source.locale === undefined) errors.push("translationOf.locale is not set");
		else if (source.locale.toLowerCase() === t.locale.toLowerCase()) {
			errors.push(`translationOf.locale must differ from locale ("${t.locale}")`);
		}
	}
	errors.push(...rulesProblems(t));
	return errors;
}

/**
 * The template's mapping names (M5b), as a record's `changes` name them: each field, `slug`,
 * `taxonomies.<name>` for each taxonomy and `bylines`. `rules.updateFields` lists these, and the
 * link row keeps one fingerprint per name.
 */
export function mappingNames(t: Template): string[] {
	return [
		...Object.keys(t.fields),
		...(t.slug === undefined ? [] : ["slug"]),
		...Object.keys(t.taxonomies ?? {}).map((name) => `taxonomies.${name}`),
		...(t.bylines === undefined ? [] : ["bylines"]),
	];
}

/**
 * What `rules` cannot ask (M5b): `updateFields` or `protectEdited` with `mode: "create"`, which
 * never updates, and an `updateFields` name the template does not map or lists twice.
 */
export function rulesProblems(t: Template): string[] {
	const rules = t.rules;
	if (rules === undefined) return [];
	const errors: string[] = [];
	if (
		rules.mode === "create" &&
		(rules.updateFields !== undefined || rules.protectEdited === true)
	) {
		errors.push(
			"rules.updateFields and rules.protectEdited apply to updates; mode create never updates",
		);
	}
	const mapped = new Set(mappingNames(t));
	const seen = new Set<string>();
	for (const name of rules.updateFields ?? []) {
		if (seen.has(name)) errors.push(`rules.updateFields lists "${name}" more than once`);
		else if (!mapped.has(name)) {
			errors.push(`rules.updateFields lists "${name}", which the template does not map`);
		}
		seen.add(name);
	}
	return errors;
}

/**
 * The snapshot of each mapped field stored on the job (`Job.targetFields`): its type, `required`,
 * the validation keys EmDash enforces, and `translatable: false`. Run `checkTemplate` first;
 * unknown fields are skipped.
 */
export function targetFieldsOf(t: Template, fields: SchemaField[]): Record<string, TargetField> {
	const byslug = new Map(fields.map((f) => [f.slug, f]));
	const targets: Record<string, TargetField> = {};
	for (const field of Object.keys(t.fields)) {
		const f = byslug.get(field);
		if (f === undefined) continue;
		const v = f.validation ?? {};
		targets[field] = {
			type: f.type,
			required: f.required ?? false,
			...(v.options && v.options.length > 0 ? { options: v.options } : {}),
			...(v.min === undefined ? {} : { min: v.min }),
			...(v.max === undefined ? {} : { max: v.max }),
			...(v.minLength === undefined ? {} : { minLength: v.minLength }),
			...(v.maxLength === undefined ? {} : { maxLength: v.maxLength }),
			...(v.pattern ? { pattern: v.pattern } : {}),
			...(f.relationSide === undefined ? {} : { relationSide: f.relationSide }),
			...(f.targetCollection === undefined ? {} : { targetCollection: f.targetCollection }),
			...(f.multiple === undefined ? {} : { multiple: f.multiple }),
			...(v.allowedMimeTypes && v.allowedMimeTypes.length > 0
				? { allowedMimeTypes: v.allowedMimeTypes }
				: {}),
			...(f.translatable === false ? { translatable: false as const } : {}),
		};
	}
	return targets;
}

/**
 * The definition of each mapped taxonomy that applies to the template: the one in its locale,
 * else the first. Run `checkTemplate` first; unknown taxonomies are skipped.
 */
function taxonomyDefsOf(t: Template, defs: readonly TaxonomyDef[]): Map<string, TaxonomyDef> {
	const found = new Map<string, TaxonomyDef>();
	for (const name of Object.keys(t.taxonomies ?? {})) {
		const named = defs.filter((d) => d.name === name);
		const def = named.find((d) => d.locale === t.locale) ?? named[0];
		if (def !== undefined) found.set(name, def);
	}
	return found;
}

/** The snapshot of each mapped taxonomy stored on the job (`Job.taxonomies`). */
export function taxonomiesOf(
	t: Template,
	defs: readonly TaxonomyDef[],
): Record<string, TaxonomySnapshot> {
	const snapshot: Record<string, TaxonomySnapshot> = {};
	for (const [name, def] of taxonomyDefsOf(t, defs)) {
		snapshot[name] = { hierarchical: def.hierarchical };
	}
	return snapshot;
}

/** Warnings for link mappings that work but do less than they say: `hierarchy` on a flat taxonomy. */
export function linkWarnings(t: Template, defs: readonly TaxonomyDef[]): string[] {
	const warnings: string[] = [];
	for (const [name, def] of taxonomyDefsOf(t, defs)) {
		if (!def.hierarchical && t.taxonomies?.[name]?.hierarchy !== undefined) {
			warnings.push(`Taxonomy "${name}" is flat; its "hierarchy" separator is ignored`);
		}
	}
	return warnings;
}

/**
 * The required fields EmDash shares across a translation group (`translatable: false`) that have
 * no default and that a template mapping `translationOf` leaves unmapped: a linked record takes
 * them from its source, and a record without a value fails `required` for them
 * (`Job.sharedRequired`). Empty for other templates.
 */
export function sharedRequiredOf(t: Template, fields: readonly SchemaField[]): string[] {
	if (t.translationOf === undefined) return [];
	return fields
		.filter(
			(f) =>
				f.required === true &&
				!f.hasDefault &&
				f.translatable === false &&
				!Object.hasOwn(t.fields, f.slug) &&
				f.slug !== SOURCE_ID_FIELD,
		)
		.map((f) => f.slug);
}

/**
 * Whether a mapping holds a value EmDash shares across a translation group: a field that is not
 * translatable, or any reference field (edges are keyed by translation group, spec M4e F4).
 */
export function isSharedMapping(mapping: FieldMapping, target: TargetField | undefined): boolean {
	return mapping.type === "reference" || target?.translatable === false;
}

/**
 * The job warning for a template that maps `translationOf` and shared mappings (fields that are
 * not translatable, reference fields, taxonomies), which records with a value leave to EmDash.
 */
export function translationWarnings(
	t: Template,
	targets: Readonly<Record<string, TargetField>>,
): string[] {
	if (t.translationOf === undefined) return [];
	const fields: string[] = [];
	const references: string[] = [];
	for (const [field, mapping] of Object.entries(t.fields)) {
		if (mapping.type === "reference") references.push(field);
		else if (isSharedMapping(mapping, targets[field])) fields.push(field);
	}
	const taxonomies = Object.keys(t.taxonomies ?? {});
	const part = (one: string, many: string, names: readonly string[]) =>
		names.length === 0
			? []
			: [`${names.length === 1 ? one : many} ${names.map((n) => `"${n}"`).join(", ")}`];
	const parts = [
		...part("field", "fields", fields),
		...part("reference field", "reference fields", references),
		...part("taxonomy", "taxonomies", taxonomies),
	];
	if (parts.length === 0) return [];
	return [
		`Records with a translationOf value leave these to EmDash, which shares them across the translation group: ${parts.join("; ")}`,
	];
}

/**
 * Whether the template maps reference fields, taxonomies or bylines, or finds a translation
 * source (`translationOf`, M4e): each record then looks entries up.
 */
export function usesLinks(t: Template): boolean {
	return (
		t.translationOf !== undefined ||
		t.taxonomies !== undefined ||
		t.bylines !== undefined ||
		Object.values(t.fields).some((m) => m.type === "reference")
	);
}

/**
 * Whether the template downloads media: it maps image or file fields, or `portableText` fields
 * that import their images.
 */
export function usesMedia(t: Template): boolean {
	return Object.values(t.fields).some(
		(m) =>
			m.type === "image" ||
			m.type === "file" ||
			(m.type === "portableText" && (m.images ?? "import") === "import"),
	);
}

/** Whether any date mapping reads `tz: "site"`; such a job stores the site timezone. */
export function usesSiteTimezone(t: Template): boolean {
	return (
		t.publishAt?.tz === SITE_TIMEZONE ||
		Object.values(t.fields).some((m) => m.type === "date" && m.tz === SITE_TIMEZONE)
	);
}
