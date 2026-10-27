import {
	invalidateCollectionCache,
	invalidateSchemaObjectCache,
	RESERVED_FIELD_SLUGS,
} from "emdash";
import { emdashErrorCode } from "../emdash/errors.js";
import {
	COMPATIBLE,
	type FieldMapping,
	matchesOption,
	SOURCE_ID_FIELD,
	type Template,
	templateSchema,
} from "../engine/template.js";
import { ServiceError } from "./service.js";

/** The field types `schema/apply` creates: every type that holds a plain value. */
export const APPLY_FIELD_TYPES = [
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
] as const;
export type ApplyFieldType = (typeof APPLY_FIELD_TYPES)[number];
/**
 * A template's reference mapping asks for a reference field, which `schema/apply` never creates:
 * it needs a relation, and the handlers that create one are not exported by EmDash.
 */
type RequestType = ApplyFieldType | "reference";

/** EmDash's indexable types (`emdash` src/schema/types.ts:56-66), of those above. */
const INDEXABLE: ReadonlySet<string> = new Set([
	"string",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"slug",
]);
const FIELD_SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_APPLY_FIELDS = 100;
const MAX_OPTIONS = 500;

export interface FieldRequest {
	slug: string;
	type: RequestType;
	label?: string | undefined;
	options?: string[] | undefined;
	indexed?: boolean | undefined;
	searchable?: boolean | undefined;
	translatable?: boolean | undefined;
	/**
	 * Template mode: the existing field types that also satisfy the request (an `unchanged`
	 * rather than a `conflict`). Absent in explicit `fields` mode, which matches the exact type.
	 */
	accepts?: readonly string[] | undefined;
	/** Template mode: how the converters match a mapped value to an option (default true). */
	ignoreCase?: boolean | undefined;
}

export interface ApplyInput {
	collection?: string | undefined;
	fields?: FieldRequest[] | undefined;
	template?: unknown;
	addOptions?: boolean | undefined;
	dryRun?: boolean | undefined;
}

export type ApplyAction = "create" | "add_options" | "unchanged" | "conflict";

export interface FieldChange {
	field: string;
	action: ApplyAction;
	type: string;
	/** `create`: the options created with; `add_options`: the options added. */
	options?: string[];
	/** Why a field is a conflict. */
	message?: string;
}

export interface ApplyResult {
	collection: string;
	dryRun: boolean;
	changes: FieldChange[];
	/** The fields created or given options, in order. */
	applied: string[];
	/** The EmDash error that stopped the run, if one did. */
	error: { code: string; message: string } | null;
}

/** An existing field, as `getCollectionWithFields` returns it (`emdash` src/schema/types.ts:320). */
interface ExistingField {
	slug: string;
	type: string;
	validation?: { options?: string[] | undefined } | null | undefined;
	unsupportedType?: unknown;
}

/**
 * The part of EmDash's `SchemaRegistry` this route uses (`emdash` src/schema/registry.ts:1276,
 * :1417); `EmDashRuntime.schemaRegistry` is assignable to it. `updateField` replaces
 * `validation` as a whole.
 */
export interface ApplyRegistry {
	getCollectionWithFields(slug: string): Promise<{ fields: ExistingField[] } | null>;
	createField(
		collection: string,
		input: {
			slug: string;
			label: string;
			type: ApplyFieldType;
			indexed: boolean;
			searchable: boolean;
			translatable: boolean;
			validation?: { options: string[] };
		},
	): Promise<unknown>;
	updateField(
		collection: string,
		slug: string,
		input: { validation: Record<string, unknown> },
	): Promise<unknown>;
}

/**
 * Clears the caches EmDash's REST field handler clears after a field change (src/api/handlers/
 * schema.ts:102-106); `SchemaRegistry` does not. Its third call, the Zod schema cache, is not
 * exported and the write path does not read it (validateContentData builds the schema afresh,
 * src/api/handlers/validation.ts:149-190).
 */
export function invalidateFieldCaches(collection: string): void {
	invalidateCollectionCache(collection);
	invalidateSchemaObjectCache();
}

/** EmDash's `SchemaError` sets `name` and a string `code` (src/schema/registry.ts:312-320). */
function isSchemaError(e: unknown): boolean {
	return e instanceof Error && e.name === "SchemaError" && emdashErrorCode(e) !== undefined;
}

/** `unit_price` → `Unit price`. */
export function labelOf(slug: string): string {
	const words = slug.replace(/_+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The field a template mapping asks for (`date` with `output` is text, so `string`). */
function requestFor(field: string, mapping: FieldMapping): FieldRequest {
	const request = baseRequestFor(field, mapping);
	const accepts =
		mapping.type === "date" && mapping.output !== undefined
			? ["string", "text"]
			: COMPATIBLE[mapping.type];
	const ignoreCase =
		mapping.type === "select" || mapping.type === "multiSelect"
			? { ignoreCase: mapping.ignoreCase ?? true }
			: {};
	return { ...request, accepts, ...ignoreCase };
}

function baseRequestFor(field: string, mapping: FieldMapping): FieldRequest {
	switch (mapping.type) {
		case "text":
			return { slug: field, type: "string" };
		case "date":
			return { slug: field, type: mapping.output === undefined ? "datetime" : "string" };
		case "select":
		case "multiSelect": {
			const options = [...new Set(Object.values(mapping.map ?? {}))];
			return { slug: field, type: mapping.type, ...(options.length > 0 ? { options } : {}) };
		}
		default:
			return { slug: field, type: mapping.type };
	}
}

/** The fields a template maps, in template order. */
export function requestsFromTemplate(t: Template): FieldRequest[] {
	return Object.entries(t.fields).map(([field, mapping]) => requestFor(field, mapping));
}

/** What is wrong with a request's options, if anything. */
function optionProblem(r: FieldRequest): string | undefined {
	if (r.options === undefined) return undefined;
	if (r.type !== "select" && r.type !== "multiSelect") {
		return "only select and multiSelect fields take options";
	}
	if (r.options.length < 1 || r.options.length > MAX_OPTIONS) {
		return `give 1-${MAX_OPTIONS} options`;
	}
	if (r.options.some((o) => o.length < 1 || o.length > 200 || o.trim() !== o)) {
		return "options are 1-200 characters, without leading or trailing spaces";
	}
	if (new Set(r.options).size !== r.options.length) return "options must be distinct";
	return undefined;
}

/** Problems with the requested fields, each naming its field. */
export function requestProblems(requests: readonly FieldRequest[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const r of requests) {
		const name = `Field "${r.slug}"`;
		if (!FIELD_SLUG_RE.test(r.slug)) {
			problems.push(
				`${name}: slugs start with a-z and use only a-z, 0-9 and _, at most 63 characters`,
			);
		} else if (RESERVED_FIELD_SLUGS.includes(r.slug) || r.slug === SOURCE_ID_FIELD) {
			problems.push(`${name}: the slug is reserved`);
		}
		if (seen.has(r.slug)) problems.push(`${name} is requested twice`);
		seen.add(r.slug);
		if (
			r.label !== undefined &&
			(r.label.length < 1 || r.label.length > 200 || r.label.trim() !== r.label)
		) {
			problems.push(`${name}: labels are 1-200 characters, without leading or trailing spaces`);
		}
		const optionIssue = optionProblem(r);
		if (optionIssue !== undefined) problems.push(`${name}: ${optionIssue}`);
		if (r.indexed && !INDEXABLE.has(r.type)) {
			problems.push(`${name}: ${r.type} fields cannot be indexed`);
		}
	}
	return problems;
}

/** The plan for one requested field, and for `add_options` the full option list to store. */
export function planField(
	request: FieldRequest,
	existing: ExistingField | undefined,
	addOptions: boolean,
): { change: FieldChange; options?: string[] } {
	const field = request.slug;
	const type = request.type;
	if (existing === undefined) {
		if (type === "reference") {
			const message = `Field "${field}" does not exist; create reference fields in the admin`;
			return { change: { field, action: "conflict", type, message } };
		}
		const options = request.options === undefined ? {} : { options: request.options };
		return { change: { field, action: "create", type, ...options } };
	}
	if (existing.unsupportedType !== undefined) {
		const message = `Field "${field}" has a field type this EmDash version cannot read`;
		return { change: { field, action: "conflict", type, message } };
	}
	if (existing.type !== type && !request.accepts?.includes(existing.type)) {
		const message = `Field "${field}" is "${existing.type}"; requested "${type}"`;
		return { change: { field, action: "conflict", type, message } };
	}
	if (existing.type !== type) return { change: { field, action: "unchanged", type } };
	const current = existing.validation?.options ?? [];
	// Template mode matches as the converters do; explicit fields match exactly.
	const present = (o: string) =>
		request.ignoreCase === undefined
			? current.includes(o)
			: matchesOption(o, current, request.ignoreCase);
	const missing = (request.options ?? []).filter((o) => !present(o));
	// A field without options accepts any string, so nothing is missing.
	if (missing.length === 0 || current.length === 0) {
		return { change: { field, action: "unchanged", type } };
	}
	if (!addOptions) {
		const names = missing.map((o) => `"${o}"`).join(", ");
		const message = `Field "${field}" lacks the options ${names}; set addOptions to add them`;
		return { change: { field, action: "conflict", type, message } };
	}
	return {
		change: { field, action: "add_options", type, options: missing },
		options: [...current, ...missing],
	};
}

/**
 * `schema/apply`: plans the requested fields (or a template's) against the collection and, unless
 * `dryRun`, creates missing fields and adds missing select options, in request order. Additive
 * only: conflicts are reported and never applied. A field another request creates first is
 * re-planned; an EmDash error stops the run and is returned with what was applied so far, and a
 * rerun is safe because applied fields plan as `unchanged`.
 */
export async function applySchema(
	registry: ApplyRegistry,
	input: ApplyInput,
	invalidate: (collection: string) => void = invalidateFieldCaches,
): Promise<ApplyResult> {
	const { collection, requests, fromTemplate } = resolveRequests(input);
	// A template's map values are not the caller's to correct here: a field whose options EmDash
	// would refuse is reported as a conflict and the others are still planned.
	const blocked = requests.map((r) => (fromTemplate ? optionProblem(r) : undefined));
	const problems = requestProblems(
		requests.map((r, i) => (blocked[i] === undefined ? r : { ...r, options: undefined })),
	);
	if (problems.length > 0) throw new ServiceError("VALIDATION_ERROR", problems.join("; "), 400);
	const read = async () => {
		const found = await registry.getCollectionWithFields(collection);
		if (!found) {
			throw new ServiceError(
				"COLLECTION_NOT_FOUND",
				`Collection "${collection}" does not exist`,
				404,
			);
		}
		return new Map(found.fields.map((f) => [f.slug, f]));
	};
	const addOptions = input.addOptions ?? false;
	const dryRun = input.dryRun ?? false;
	let existing = await read();
	const plans = requests.map((r, i): ReturnType<typeof planField> => {
		const issue = blocked[i];
		if (issue === undefined) return planField(r, existing.get(r.slug), addOptions);
		const message = `Field "${r.slug}": ${issue}`;
		return { change: { field: r.slug, action: "conflict", type: r.type, message } };
	});
	const result: ApplyResult = {
		collection,
		dryRun,
		changes: plans.map((p) => p.change),
		applied: [],
		error: null,
	};
	if (dryRun) return result;
	try {
		for (const [i, request] of requests.entries()) {
			let plan = plans[i] as (typeof plans)[number];
			// A reference request never plans `create` (planField); the type check narrows it.
			if (plan.change.action === "create" && request.type !== "reference") {
				try {
					await registry.createField(collection, {
						slug: request.slug,
						label: request.label ?? labelOf(request.slug),
						type: request.type,
						indexed: request.indexed ?? false,
						searchable: request.searchable ?? false,
						translatable: request.translatable ?? true,
						...(request.options === undefined ? {} : { validation: { options: request.options } }),
					});
					result.applied.push(request.slug);
					continue;
				} catch (e) {
					if (emdashErrorCode(e) !== "FIELD_EXISTS") throw e;
					existing = await read();
					plan = planField(request, existing.get(request.slug), addOptions);
					result.changes[i] = plan.change;
					if (plan.change.action === "create") {
						result.error = {
							code: "FIELD_EXISTS",
							message: `Field "${request.slug}" already exists but could not be read back`,
						};
						break;
					}
				}
			}
			if (plan.change.action === "add_options") {
				// The registry may have changed since the plan (a re-read after FIELD_EXISTS).
				plan = planField(request, existing.get(request.slug), addOptions);
				result.changes[i] = plan.change;
			}
			if (plan.change.action === "add_options" && plan.options !== undefined) {
				const field = existing.get(request.slug);
				await registry.updateField(collection, request.slug, {
					validation: { ...(field?.validation ?? {}), options: plan.options },
				});
				result.applied.push(request.slug);
			}
		}
	} catch (e) {
		if (e instanceof ServiceError) throw e;
		const message = e instanceof Error ? e.message : String(e);
		if (isSchemaError(e)) {
			result.error = { code: emdashErrorCode(e) as string, message };
		} else if (result.applied.length > 0) {
			// Report what was applied rather than hiding it behind a 500.
			result.error = { code: "INTERNAL_ERROR", message };
		} else {
			throw e;
		}
	} finally {
		if (result.applied.length > 0) invalidate(collection);
	}
	return result;
}

/** The collection and field requests: from `fields`, or from a template's mappings. */
function resolveRequests(input: ApplyInput): {
	collection: string;
	requests: FieldRequest[];
	fromTemplate: boolean;
} {
	if ((input.fields === undefined) === (input.template === undefined)) {
		throw new ServiceError("VALIDATION_ERROR", "Set exactly one of fields and template", 400);
	}
	if (input.fields !== undefined) {
		if (input.collection === undefined) {
			throw new ServiceError("VALIDATION_ERROR", "collection is required with fields", 400);
		}
		return { collection: input.collection, requests: input.fields, fromTemplate: false };
	}
	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
		const problems = parsed.error.issues.map(
			(i) => `${i.path.join(".") || "template"}: ${i.message}`,
		);
		throw new ServiceError(
			"VALIDATION_ERROR",
			`The template is invalid: ${problems.join("; ")}`,
			400,
		);
	}
	const t = parsed.data;
	if (input.collection !== undefined && input.collection !== t.collection) {
		throw new ServiceError(
			"VALIDATION_ERROR",
			`collection "${input.collection}" does not match the template's "${t.collection}"`,
			400,
		);
	}
	return { collection: t.collection, requests: requestsFromTemplate(t), fromTemplate: true };
}
