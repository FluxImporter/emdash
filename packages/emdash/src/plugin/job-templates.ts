/** Jobs from saved templates (M6a, spec "Jobs from saved templates"). */
import { fingerprint } from "../engine/fingerprints.js";
import type { KvCollection } from "../engine/ports.js";
import { templateSchema } from "../engine/template.js";
import type { ImportTemplate } from "./sources.js";
import { assertRevision, templateNotFound } from "./template-errors.js";
import { readSavedTemplate, type SavedTemplate } from "./templates.js";

/** The template a job is created from, and the saved template it was read from, if any. */
export interface ResolvedTemplate {
	template: unknown;
	saved?: { id: string; revision: number };
}

/**
 * What a job is created from (M6c, plan Ruling 8): `jobs/create`'s input, which `jobs/plan` and
 * `jobs/start` also build. Exactly one of `uploadId` and `sourceId`; `template` or `templateId`
 * unless the caller passes the resolved template.
 */
export interface JobRequest {
	/** M6c, `jobs/start`: the ID the dry run claimed (`createJob`'s `id`). */
	id?: string | undefined;
	/**
	 * M6c: the agent routes' marker (spec Ruling 31); M6b: a schedule's launch; `jobs/create` sets
	 * only `"wizard"`, the admin wizard's.
	 */
	origin?: "agent" | "schedule" | "wizard" | undefined;
	/** M6b, a launch: the schedule. */
	scheduleId?: string | undefined;
	/** M6b, a launch: the job starts open for the pump. */
	scheduled?: "open" | undefined;
	/** M6b, `jobs/start`: the URL source of the dry run the job imports (no `sourceId`). */
	feedSourceId?: string | undefined;
	/** M6c, `jobs/start`: the dry run the job imports. */
	dryRunOf?: string | undefined;
	uploadId?: string | undefined;
	sourceId?: string | undefined;
	force?: boolean | undefined;
	template?: unknown;
	templateId?: string | undefined;
	templateRevision?: number | undefined;
	dryRun: boolean;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
	journal?: boolean | undefined;
	missing?: false | { maxPercent: number } | undefined;
}

/**
 * `jobs/create` and `schema/apply` with a `templateId`: the stored template, through
 * `readSavedTemplate`. A missing row is `TEMPLATE_NOT_FOUND`; a `revision` other than the row's
 * is `TEMPLATE_CHANGED`. The template is not validated here: `createJob` re-validates it.
 */
export async function resolveJobTemplate(
	templates: Pick<KvCollection<SavedTemplate>, "get">,
	id: string,
	revision?: number,
): Promise<ResolvedTemplate> {
	const row = await templates.get(id);
	if (!row) throw templateNotFound("TEMPLATE_NOT_FOUND", id);
	assertRevision(id, row.revision, revision);
	return { template: readSavedTemplate(row), saved: { id, revision: row.revision } };
}

/**
 * The template a URL-source job records in `lastImport` (spec Ruling 29): a saved template's ID
 * and revision, else the fingerprint of the parsed inline template, which ignores key order and
 * counts the schema's defaults; null when it does not parse.
 */
export async function jobTemplateRef(resolved: ResolvedTemplate): Promise<ImportTemplate | null> {
	if (resolved.saved) return { id: resolved.saved.id, revision: resolved.saved.revision };
	const parsed = templateSchema.safeParse(resolved.template);
	return parsed.success ? { fingerprint: await fingerprint(parsed.data) } : null;
}
