import { utf8Length } from "../engine/portable-text.js";
import { shapeProblems, templateShapeProblems } from "../engine/shape.js";
import type { Template } from "../engine/template.js";
import type { SourceFormat } from "../sources/reader.js";
import { ServiceError } from "./service.js";

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
