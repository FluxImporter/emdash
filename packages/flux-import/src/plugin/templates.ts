import type { StorageCollection } from "emdash";
import { kvCollection } from "../emdash/storage.js";
import { utf8Length } from "../engine/portable-text.js";
import type { KvCollection, LookupPort } from "../engine/ports.js";
import { shapeProblems, templateShapeProblems } from "../engine/shape.js";
import {
	checkTemplate,
	linkWarnings,
	type Template,
	TRANSLATION_LOCALE_NOT_SET,
	targetFieldsOf,
	translationWarnings,
	usesSiteTimezone,
} from "../engine/template.js";
import type { LinkRow } from "../engine/types.js";
import type { SourceFormat } from "../sources/reader.js";
import {
	type FieldLookup,
	type LocaleResolver,
	linkSchemaFor,
	type Page,
	page,
	ServiceError,
	type TranslationLocaleResolver,
} from "./service.js";
import { assertRevision, templateNotFound } from "./template-errors.js";

/** The most UTF-8 bytes of `JSON.stringify` of a saved template (spec Rulings 28 and 39). */
export const TEMPLATE_MAX_BYTES = 262_144;
/** The most characters (UTF-16 code units) of a template name, after NFC. */
export const TEMPLATE_NAME_MAX = 100;
/** The most characters of a template description. */
export const TEMPLATE_DESCRIPTION_MAX = 2000;
export const TEMPLATE_NAME_RULE =
	"A template name is 1-100 characters, with no leading or trailing whitespace and no control or format characters";

/** A saved template, as the `templates` storage collection holds it. */
export interface SavedTemplate {
	id: string;
	name: string;
	description?: string;
	template: Template;
	revision: number;
	collection: string;
	locale: string;
	owner?: string;
	format: SourceFormat;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	updatedBy: string;
}

export type TemplateSummary = Omit<SavedTemplate, "template">;

export interface TemplateCheck {
	problems: string[];
	warnings: string[];
}

export interface SavedResult {
	template: SavedTemplate;
	check: TemplateCheck;
}

/**
 * `TEMPLATE_NAME_RULE` when the NFC form of `name` is empty, over `TEMPLATE_NAME_MAX`, starts
 * or ends with whitespace, or holds a control or format character (spec "Names", Ruling 38).
 */
export function templateNameProblem(name: string): string | null {
	const n = name.normalize("NFC");
	if (n.length === 0 || n.length > TEMPLATE_NAME_MAX) return TEMPLATE_NAME_RULE;
	if (/^\s|\s$/u.test(n) || /[\p{Cc}\p{Cf}]/u.test(n)) return TEMPLATE_NAME_RULE;
	return null;
}

/**
 * The template the template routes save (create, update, import), parsed with its defaults:
 * an integer `version` other than 1 is `UNSUPPORTED_TEMPLATE_VERSION`; every shape problem is
 * `INVALID_TEMPLATE` with `details.problems`; then the size cap (spec Ruling 28). Inline
 * `jobs/create` keeps M5c's codes and has no size cap.
 */
export function templateForSave(input: unknown): Template {
	if (typeof input === "object" && input !== null && !Array.isArray(input)) {
		const version = Object.hasOwn(input, "version")
			? (input as { version: unknown }).version
			: undefined;
		if (Number.isInteger(version) && version !== 1) {
			throw new ServiceError(
				"UNSUPPORTED_TEMPLATE_VERSION",
				`This template has format version ${version}; this version of flux-import reads version 1`,
				400,
			);
		}
	}
	const shape = templateShapeProblems(input);
	const problems = shape.ok ? shapeProblems(shape) : shape.problems;
	if (!shape.ok || problems.length > 0) {
		throw new ServiceError("INVALID_TEMPLATE", "The template is invalid", 400, { problems });
	}
	assertTemplateSize(shape.template);
	return shape.template;
}

/** Refuses `TEMPLATE_TOO_LARGE` when the template's JSON is over `TEMPLATE_MAX_BYTES` UTF-8 bytes. */
export function assertTemplateSize(t: Template): void {
	const bytes = utf8Length(JSON.stringify(t));
	if (bytes > TEMPLATE_MAX_BYTES) {
		throw new ServiceError(
			"TEMPLATE_TOO_LARGE",
			`The template is ${bytes} bytes of JSON; at most ${TEMPLATE_MAX_BYTES} are allowed`,
			413,
		);
	}
}

/**
 * The one place a stored template is read for use (`jobs/create`, `schema/apply`), which
 * re-validate it. A future template `version` 2 upgrades version 1 rows here (spec
 * "Versioning"); M6a has nothing to upgrade.
 */
export function readSavedTemplate(row: Pick<SavedTemplate, "template">): unknown {
	return row.template;
}

/** Summaries per `templates/list` page: a query returns whole rows (spec Ruling 32). */
export const TEMPLATE_PAGE = 8;
/** Rows the shared-owner query reads, one storage page (spec Ruling 31). */
export const OWNER_QUERY_LIMIT = 100;

export interface TemplateDeps {
	templates: KvCollection<SavedTemplate>;
	links: KvCollection<LinkRow>;
	lookups: Pick<LookupPort, "taxonomyDefs">;
	lookupFields: FieldLookup;
	resolveLocale: LocaleResolver;
	resolveTranslation: TranslationLocaleResolver;
	/** The site timezone setting; read only for templates with tz: "site". */
	siteTimezone: () => Promise<string>;
	now: () => number;
	newId: () => string;
}

/** Who already uses a template's owner in its collection and locale (spec Ruling 30). */
export interface OwnerUse {
	owner: string;
	locale: string;
	templates: { id: string; name: string }[];
	links: boolean;
}

export interface CreateTemplateInput {
	name: string;
	description?: string | undefined;
	template: unknown;
}

export interface UpdateTemplateInput {
	id: string;
	revision: number;
	name?: string | undefined;
	description?: string | null | undefined;
	template?: unknown;
}

/** The `templates` storage collection declared in the plugin definition. */
export function templatesCollection(
	storage: Record<string, StorageCollection | undefined>,
): KvCollection<SavedTemplate> {
	if (!storage.templates) {
		throw new Error("flux-import: the templates storage collection is missing");
	}
	return kvCollection<SavedTemplate>(storage.templates);
}

type CopiedFields = Pick<SavedTemplate, "collection" | "locale" | "owner" | "format">;

/** The fields copied out of the template on every write, for queries and listings. */
function copied(t: Template): CopiedFields {
	return {
		collection: t.collection,
		locale: t.locale,
		...(t.rules?.owner === undefined ? {} : { owner: t.rules.owner }),
		format: t.source.format,
	};
}

/** A row without its copied fields, so a field the new template lacks (`owner`) is not kept. */
function withoutCopied(row: SavedTemplate): Omit<SavedTemplate, keyof CopiedFields> {
	const { collection: _c, locale: _l, owner: _o, format: _f, ...rest } = row;
	return rest;
}

/** A write lost its compare-and-set or compare-and-delete (spec Rulings 6, 37). */
function changedWhileSaving(id: string, current: SavedTemplate | null): ServiceError {
	return new ServiceError(
		"TEMPLATE_CHANGED",
		`Template ${id} changed while it was being saved; read it again`,
		409,
		current ? { revision: current.revision } : undefined,
	);
}

/**
 * The site checks of a template that passed the shape checks (spec "Site checks", plan Ruling 8):
 * the locales as `jobs/create` resolves them, the collection, what remains of `checkTemplate`
 * without source columns, the link and translation warnings, and the owner warnings. `selfId` is
 * the template being updated, which never warns about itself.
 */
export async function siteCheck(
	deps: TemplateDeps,
	t: Template,
	selfId?: string,
): Promise<{ check: TemplateCheck; owner: OwnerUse | null }> {
	const problems: string[] = [];
	const warnings: string[] = [];
	const resolved = deps.resolveLocale(t.locale);
	if (!resolved.ok) problems.push(`locale: ${resolved.message}`);
	const locale = resolved.ok ? resolved.locale : t.locale;
	let effective = t;
	let translationFailed = false;
	if (t.translationOf !== undefined) {
		const translation = deps.resolveTranslation(t.translationOf.locale, locale);
		if (translation.ok) {
			effective = { ...t, translationOf: { ...t.translationOf, locale: translation.locale } };
		} else {
			problems.push(translation.message);
			translationFailed = true;
		}
	}
	const fields = await deps.lookupFields(t.collection);
	if (fields === null) {
		problems.push(`Collection "${t.collection}" does not exist`);
	} else {
		const links = await linkSchemaFor(deps, effective, fields, deps.lookupFields, t.collection);
		const tz = usesSiteTimezone(t) ? await deps.siteTimezone() : "UTC";
		const site = checkTemplate(effective, fields, null, tz, links);
		problems.push(
			...(translationFailed ? site.filter((p) => p !== TRANSLATION_LOCALE_NOT_SET) : site),
		);
		warnings.push(
			...linkWarnings(effective, links.taxonomies ?? []),
			...translationWarnings(effective, targetFieldsOf(effective, fields)),
		);
	}
	const owner = t.rules?.owner;
	if (owner === undefined) return { check: { problems, warnings }, owner: null };
	const use: OwnerUse = { owner, locale, templates: [], links: false };
	const sameOwner = await deps.templates.query({
		where: { owner, collection: t.collection },
		limit: OWNER_QUERY_LIMIT,
	});
	for (const { id, data } of sameOwner.items) {
		// A row without its copied locale (written elsewhere) cannot be compared: EmDash would
		// read a missing locale as the default one.
		if (id === selfId || typeof data.locale !== "string") continue;
		const other = deps.resolveLocale(data.locale);
		if ((other.ok ? other.locale : data.locale) !== locale) continue;
		use.templates.push({ id, name: data.name });
		warnings.push(
			`Saved template ${data.name} (${id}) uses the same owner ${owner} for ${t.collection}/${locale}: the two act as one import, and each one's missing phase treats the other's entries as its own; give each feed its own owner`,
		);
	}
	if (resolved.ok) {
		const owned = await deps.links.query({
			where: { owner, collection: t.collection, locale },
			limit: 1,
		});
		if (owned.items.length > 0) {
			use.links = true;
			warnings.push(
				`Owner ${owner} already owns entries in ${t.collection}/${locale}: this template will treat them as its own (and with rules.missing may trash or unpublish the ones its feed lacks)`,
			);
		}
	}
	return { check: { problems, warnings }, owner: use };
}

/** Refuses `NAME_TAKEN` when a template other than `self` has the (NFC) name (spec "Names"). */
export async function assertNameFree(
	deps: Pick<TemplateDeps, "templates">,
	name: string,
	self?: string,
): Promise<void> {
	const { items } = await deps.templates.query({ where: { name }, limit: 2 });
	const other = items.find((i) => i.id !== self);
	if (other) {
		throw new ServiceError("NAME_TAKEN", `A template named "${name}" already exists`, 409, {
			id: other.id,
		});
	}
}

/**
 * Writes a new row at revision 1 (create, import); `name` is already NFC and free. An empty
 * description is no description (plan Ruling 13).
 */
export async function insertTemplate(
	deps: TemplateDeps,
	user: string,
	fields: { name: string; description?: string | undefined; template: Template },
	check: TemplateCheck,
): Promise<SavedResult> {
	const id = deps.newId();
	const at = new Date(deps.now()).toISOString();
	const row: SavedTemplate = {
		id,
		name: fields.name,
		...(fields.description ? { description: fields.description } : {}),
		template: fields.template,
		revision: 1,
		...copied(fields.template),
		createdAt: at,
		updatedAt: at,
		createdBy: user,
		updatedBy: user,
	};
	const written = await deps.templates.compareAndSet(id, null, row);
	if (!written.applied) throw new Error(`Template id ${id} already exists`);
	return { template: row, check };
}

/** One page of summaries in creation order, optionally of one collection (spec Rulings 15, 32). */
export async function listTemplates(
	deps: Pick<TemplateDeps, "templates">,
	opts: { collection?: string | undefined; cursor?: string | undefined },
): Promise<Page<TemplateSummary>> {
	const result = await deps.templates.query({
		...(opts.collection ? { where: { collection: opts.collection } } : {}),
		limit: TEMPLATE_PAGE,
		...(opts.cursor ? { cursor: opts.cursor } : {}),
	});
	const rows = page(result);
	return { ...rows, items: rows.items.map(({ template: _, ...summary }) => summary) };
}

/** The row as stored, without checks; `NOT_FOUND` when there is none. */
export async function getTemplate(
	deps: Pick<TemplateDeps, "templates">,
	id: string,
): Promise<SavedTemplate> {
	const row = await deps.templates.get(id);
	if (!row) throw templateNotFound("NOT_FOUND", id);
	return row;
}

export async function createTemplate(
	deps: TemplateDeps,
	user: string,
	input: CreateTemplateInput,
): Promise<SavedResult> {
	const template = templateForSave(input.template);
	const name = input.name.normalize("NFC");
	await assertNameFree(deps, name);
	const { check } = await siteCheck(deps, template);
	return insertTemplate(deps, user, { name, description: input.description, template }, check);
}

/**
 * Changes a template at the revision the caller read (spec Ruling 6): a stale revision, or a
 * write that lands between the read and the compare-and-set, is `TEMPLATE_CHANGED`, with no
 * retry. The site checks run on every update (plan Ruling 12); `null` or `""` removes the
 * description (plan Ruling 13). Without a new template, the stored one must still pass
 * `templateForSave`.
 */
export async function updateTemplate(
	deps: TemplateDeps,
	user: string,
	input: UpdateTemplateInput,
): Promise<SavedResult> {
	const given = input.template === undefined ? undefined : templateForSave(input.template);
	const stored = await deps.templates.getVersioned(input.id);
	if (!stored) throw templateNotFound("NOT_FOUND", input.id);
	const row = stored.value;
	assertRevision(input.id, row.revision, input.revision);
	const name = input.name === undefined ? row.name : input.name.normalize("NFC");
	if (name !== row.name) await assertNameFree(deps, name, input.id);
	// A stored row is re-checked like a new template, so one that no longer parses is refused
	// with its code; sending a template in the same update repairs it.
	const template = given ?? templateForSave(readSavedTemplate(row));
	const { check } = await siteCheck(deps, template, input.id);
	const { description: _, ...rest } = withoutCopied(row);
	const description = input.description === undefined ? row.description : input.description;
	const next: SavedTemplate = {
		...rest,
		name,
		...(description ? { description } : {}),
		template,
		...copied(template),
		revision: row.revision + 1,
		updatedAt: new Date(deps.now()).toISOString(),
		updatedBy: user,
	};
	const written = await deps.templates.compareAndSet(input.id, stored.revision, next);
	if (!written.applied) throw changedWhileSaving(input.id, await deps.templates.get(input.id));
	return { template: next, check };
}

/** Deletes a template at the revision the caller read (spec Ruling 37). */
export async function deleteTemplate(
	deps: Pick<TemplateDeps, "templates">,
	input: { id: string; revision: number },
): Promise<{ deleted: true }> {
	const stored = await deps.templates.getVersioned(input.id);
	if (!stored) throw templateNotFound("NOT_FOUND", input.id);
	assertRevision(input.id, stored.value.revision, input.revision);
	const removed = await deps.templates.compareAndDelete(input.id, stored.revision);
	if (!removed.applied) throw changedWhileSaving(input.id, await deps.templates.get(input.id));
	return { deleted: true };
}
