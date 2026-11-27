/** Saved templates as versioned JSON files: export and import (spec "Export file format"). */
import { slugify, type Template } from "../engine/template.js";
import { FLUX_IMPORTER_ID, FLUX_IMPORTER_VERSION } from "../meta.js";
import { ServiceError } from "./service.js";
import {
	assertNameFree,
	assertTemplateSize,
	getTemplate,
	insertTemplate,
	type OwnerUse,
	type SavedResult,
	siteCheck,
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_NAME_RULE,
	type TemplateDeps,
	templateForSave,
	templateNameProblem,
} from "./templates.js";

export const TEMPLATE_FILE_FORMAT = "fluximporter.template";
export const TEMPLATE_FILE_VERSION = 1;

/** The file `templates/export` returns and `templates/import` reads (spec Rulings 8, 9). */
export interface TemplateFile {
	format: typeof TEMPLATE_FILE_FORMAT;
	formatVersion: typeof TEMPLATE_FILE_VERSION;
	exportedAt: string;
	generator: { plugin: string; version: string };
	name: string;
	description?: string;
	template: unknown;
}

/** `fluximporter-template-<slug>.json`, the slug at most 80 characters, "template" when empty. */
export function templateFilename(name: string): string {
	const slug = slugify(name).slice(0, 80).replace(/-+$/, "");
	return `fluximporter-template-${slug || "template"}.json`;
}

/**
 * The stored row as a file, without its ID, revision, timestamps or users (spec Ruling 9). The
 * template is exported as stored, not re-validated, so a row that no longer parses can still be
 * exported (Ruling 11).
 */
export async function exportTemplate(
	deps: Pick<TemplateDeps, "templates" | "now">,
	id: string,
): Promise<{ filename: string; file: TemplateFile }> {
	const row = await getTemplate(deps, id);
	const file: TemplateFile = {
		format: TEMPLATE_FILE_FORMAT,
		formatVersion: TEMPLATE_FILE_VERSION,
		exportedAt: new Date(deps.now()).toISOString(),
		generator: { plugin: FLUX_IMPORTER_ID, version: FLUX_IMPORTER_VERSION },
		name: row.name,
		...(row.description === undefined ? {} : { description: row.description }),
		template: row.template,
	};
	return { filename: templateFilename(row.name), file };
}

export interface ImportTemplateInput {
	file: unknown;
	name?: string | undefined;
	owner?: string | undefined;
}

/** An own key of `value` when it is an object, else undefined: never inherited (spec Ruling 36). */
function own(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function invalidFile(message: string): ServiceError {
	return new ServiceError("INVALID_FILE", message, 400);
}

/**
 * The `OWNER_IN_USE` refusal of a template with `rules.missing` whose owner is already used in
 * its collection and locale (spec Ruling 30).
 */
function ownerInUse(collection: string, use: OwnerUse): ServiceError {
	const uses = [
		...(use.templates.length > 0
			? [`saved templates ${use.templates.map((t) => t.id).join(", ")}`]
			: []),
		...(use.links ? ["existing entries"] : []),
	].join(" and ");
	return new ServiceError(
		"OWNER_IN_USE",
		`Owner ${use.owner} is already used in ${collection}/${use.locale} (${uses}); this template has rules.missing, so its missing phase would treat those entries as its own. Import it with owner set to a new owner name, or to "${use.owner}" to keep this one`,
		409,
		{ owner: use.owner, templates: use.templates.map((t) => t.id), links: use.links },
	);
}

/**
 * Creates a new template from a file (spec Ruling 10: import always creates). The envelope is
 * read by its known keys only, never spread (Ruling 36). `name` replaces the file's name;
 * `owner` replaces `rules.owner` and is then only warned about, while without it a template with
 * `rules.missing` whose owner is in use is refused `OWNER_IN_USE` (Ruling 30).
 */
export async function importTemplate(
	deps: TemplateDeps,
	user: string,
	input: ImportTemplateInput,
): Promise<SavedResult> {
	const { file } = input;
	if (typeof file !== "object" || file === null || Array.isArray(file)) {
		throw invalidFile("The file is not a Flux Importer template file");
	}
	if (own(file, "format") !== TEMPLATE_FILE_FORMAT) {
		throw invalidFile(`The file's format is not "${TEMPLATE_FILE_FORMAT}"`);
	}
	const formatVersion = own(file, "formatVersion");
	if (Number.isInteger(formatVersion) && formatVersion !== TEMPLATE_FILE_VERSION) {
		const generator = own(own(file, "generator"), "version");
		throw new ServiceError(
			"UNSUPPORTED_FILE_VERSION",
			`This file was written by a newer fluximporter (file format ${formatVersion}, generator ${typeof generator === "string" ? generator : "unknown"}); this site reads file format ${TEMPLATE_FILE_VERSION}`,
			400,
		);
	}
	if (formatVersion !== TEMPLATE_FILE_VERSION) {
		throw invalidFile(`formatVersion must be the integer ${TEMPLATE_FILE_VERSION}`);
	}
	const body = own(file, "template");
	if (body === undefined) throw invalidFile("The file has no template");
	const description = own(file, "description");
	if (
		description !== undefined &&
		(typeof description !== "string" || description.length > TEMPLATE_DESCRIPTION_MAX)
	) {
		throw invalidFile("The file's description must be text of at most 2,000 characters");
	}
	let name: string;
	if (input.name !== undefined) {
		name = input.name;
	} else {
		const named = own(file, "name");
		if (typeof named !== "string") throw invalidFile("The file has no name; give one with name");
		if (templateNameProblem(named) !== null) {
			throw invalidFile(
				`The file's name is not a valid template name (${TEMPLATE_NAME_RULE}); give one with name`,
			);
		}
		name = named;
	}
	name = name.normalize("NFC");

	let template: Template = templateForSave(body);
	if (input.owner !== undefined) {
		template = { ...template, rules: { ...template.rules, owner: input.owner } };
		assertTemplateSize(template);
	}
	const { check, owner } = await siteCheck(deps, template);
	if (
		input.owner === undefined &&
		template.rules?.missing !== undefined &&
		owner !== null &&
		(owner.templates.length > 0 || owner.links)
	) {
		throw ownerInUse(template.collection, owner);
	}
	await assertNameFree(deps, name);
	return insertTemplate(deps, user, { name, description, template }, check);
}
