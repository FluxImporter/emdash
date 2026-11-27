import { z } from "astro/zod";
import type { ActorInfo, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork } from "../astro/config.js";
import { readFence } from "../emdash/fence.js";
import { resolveSiteLocale, resolveTranslationLocale } from "../emdash/locale.js";
import { listSchemaFields, readSuggestCollection } from "../emdash/schema.js";
import { readSiteTimezone } from "../emdash/timezone.js";
import { isUploadId } from "../emdash/uploads.js";
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import { createRollback } from "../engine/rollback.js";
import { OWNER_PATTERN, OWNER_RULE } from "../engine/template.js";
import type { JobStatus, RecordStatus } from "../engine/types.js";
import { SOURCE_FORMATS, XLSX_MAX_ROWS } from "../sources/reader.js";
import {
	type AgentDeps,
	agentError,
	PLAN_SOURCE_MISSING_MESSAGE,
	planJob,
	readJobStatus,
	startFromDryRun,
	stepAgentJob,
} from "./agent.js";
import { callProvider } from "./ai/provider.js";
import {
	CREDENTIAL_NAME,
	deleteCredential,
	FORBIDDEN_HEADERS,
	HEADER_NAME,
	HEADER_VALUE,
	listCredentials,
	setCredential,
} from "./credentials.js";
import { clearDryRuns } from "./dry-runs.js";
import { resolveJobTemplate } from "./job-templates.js";
import { schedulesOverview, sourcesOverview } from "./overviews.js";
import { withRuntime } from "./runtime.js";
import {
	createSchedule,
	cronOf,
	deleteSchedule,
	inUse,
	listSchedules,
	MAX_SCHEDULES,
	pauseSchedule,
	reconcile,
	reopenScheduled,
	runSchedule,
	type ScheduleDeps,
	type ScheduleRow,
	schedulesCollection,
	schedulesUsing,
	sourcePinOf,
	sourceWarnings,
	templateWarnings,
	updateSchedule,
	withRollback,
} from "./schedules.js";
import { APPLY_FIELD_TYPES, applySchema, MAX_APPLY_FIELDS } from "./schema-apply.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	listJobSummaries,
	listJobs,
	listRecords,
	nextBatch,
	PASTE_MAX_BYTES,
	SAMPLE_MAX,
	ServiceError,
	stagePaste,
	XLSX_PASTE_MESSAGE,
} from "./service.js";
import { buildServices, createJobFrom, type Services } from "./services.js";
import {
	clearLastImport,
	createSource,
	deleteSource,
	fetchSource,
	getSource,
	listSources,
	noteFetchRecords,
	updateSource,
} from "./sources.js";
import { type SuggestDeps, suggestMapping } from "./suggest.js";
import { redact, step, summarize } from "./summaries.js";
import { exportTemplate, importTemplate } from "./template-files.js";
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	siteCheck,
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_NAME_RULE,
	type TemplateDeps,
	templateNameProblem,
	templatesCollection,
	updateTemplate,
} from "./templates.js";
import { sampleImport } from "./xlsx.js";

/** Every route requires Admin (`import:execute` is level 50 in @emdash-cms/auth). */
const PERMISSION = "import:execute";

const JOB_STATUSES = [
	"created",
	"running",
	"paused",
	"completed",
	"cancelled",
	"failed",
] as const satisfies readonly JobStatus[];
const RECORD_STATUSES = [
	"writing",
	"created",
	"updated",
	"unchanged",
	"locked",
	"conflict",
	"failed",
	"planned",
	"filtered",
	"reverted",
	"removed",
] as const satisfies readonly RecordStatus[];

const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
const sourceId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid source ID");
const sourceName = z.string().min(1).max(100);
const sourceUrl = z.string().min(1).max(2048);
const credentialName = z
	.string()
	.regex(CREDENTIAL_NAME, "Credential names are 1-64 characters from a-z, 0-9 and -");
const headerName = z
	.string()
	.regex(HEADER_NAME, "The header must be a valid HTTP header name")
	.refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), "This header cannot hold a credential");
const headerValue = z
	.string()
	.regex(HEADER_VALUE, "Header values are 1-4,096 printable ASCII characters, without CR or LF");
const uploadId = z.string().refine(isUploadId, "Invalid upload ID");
const cursor = z.string().min(1).max(1024).optional();
const byId = z.object({ id: jobId });

/** `jobs/summaries` (M7b): real imports by default, or dry runs, a page at a time. */
export const JOB_SUMMARIES_INPUT = z.object({ dryRun: z.boolean().optional(), cursor }).strict();

const format = z.enum(SOURCE_FORMATS);
const templateId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid template ID");
/** Checked as the service stores it (NFC); the service normalises (spec "Names"). */
const templateName = z
	.string()
	.refine((name) => templateNameProblem(name) === null, TEMPLATE_NAME_RULE);
/** A schedule's name: the rule of a template's name (M6a "Names"), in schedule wording. */
const SCHEDULE_NAME_RULE =
	"A schedule name is 1-100 characters, with no leading or trailing whitespace and no control or format characters";
const scheduleName = z
	.string()
	.refine((name) => templateNameProblem(name) === null, SCHEDULE_NAME_RULE);
const templateDescription = z.string().max(TEMPLATE_DESCRIPTION_MAX);
/** Required on update and delete (spec Rulings 6, 37): the service accepts none at runtime. */
const templateRevision = z.number().int().min(1);
/** The import route's `owner` override: the rule of `rules.owner` (spec "Export file format"). */
const templateOwner = z.string().regex(OWNER_PATTERN, OWNER_RULE);
/**
 * The template's `sourceSchema` (engine/template.ts) rebuilt with astro/zod, a different Zod
 * than the engine's; definition.test.ts checks both accept and reject the same blocks.
 */
const source = z
	.object({
		format: format.default("csv"),
		records: z.string().min(1).optional(),
		sheet: z.union([z.string().min(1).max(100), z.number().int().min(1)]).optional(),
		headerRow: z.number().int().min(1).max(XLSX_MAX_ROWS).optional(),
		filter: z.string().min(1).optional(),
	})
	.strict();

/** A route's services: the caller is always the actor (`withServices` refuses a call without one). */
type RouteServices = Services & { actor: ActorInfo };

/** The saved-template services' dependencies for one request (M6a). */
function templateDeps(ctx: RouteContext<unknown>, { deps, runtime }: RouteServices): TemplateDeps {
	return {
		templates: templatesCollection(ctx.storage),
		links: deps.links,
		lookups: deps.lookups,
		lookupFields: (collection) => listSchemaFields(runtime.schemaRegistry, collection),
		resolveLocale: (locale) => resolveSiteLocale(locale),
		resolveTranslation: (sourceLocale, locale) => resolveTranslationLocale(sourceLocale, locale),
		siteTimezone: () => readSiteTimezone(),
		now: Date.now,
		newId: () => ulid(),
	};
}

/** The suggestion route's dependencies for one request (M6d): no storage port (spec Ruling 32). */
function suggestDeps(ctx: RouteContext<unknown>, services: RouteServices): SuggestDeps {
	return {
		settings: ctx.settings,
		kv: ctx.kv,
		templates: templateDeps(ctx, services),
		readCollection: (collection) =>
			readSuggestCollection(services.runtime.schemaRegistry, collection),
		sampleUpload: (uploadId, source) =>
			sampleImport(services.deps, services.xlsx, uploadId, SAMPLE_MAX, source),
		getSource: async (id) => (await services.sources.sources.get(id)) ?? null,
		fetchSource: (id, force) => fetchSource(services.sources, id, force),
		allowPrivateNetwork: allowPrivateNetwork(),
		net: services.sources.net,
		callProvider,
		log: ctx.log,
		now: Date.now,
	};
}

/** The schedule service's dependencies for one request (M6b). */
function scheduleDeps(ctx: RouteContext<unknown>, services: RouteServices): ScheduleDeps {
	const templates = templateDeps(ctx, services);
	return {
		schedules: schedulesCollection(ctx.storage),
		jobs: services.deps.jobs,
		templates: templates.templates,
		sources: services.sources.sources,
		cron: cronOf(ctx),
		templateProblems: async (template) => (await siteCheck(templates, template)).check.problems,
		now: Date.now,
		newId: () => ulid(),
		warn: (message) => ctx.log.warn(message),
	};
}

/** What a route needs to pause a schedule (spec Ruling 32). */
function scheduleWrites(ctx: RouteContext<unknown>) {
	return { schedules: schedulesCollection(ctx.storage), cron: cronOf(ctx), now: Date.now };
}

/**
 * Runs a side effect that follows a write that already succeeded: whatever it throws, before or
 * after it returns a promise, is dropped (preflight F11) and logged as `what` failed, its message
 * redacted (preflight F12). `fallback` is the answer then.
 */
async function bestEffort<T>(
	ctx: Pick<RouteContext<unknown>, "log">,
	what: string,
	run: () => Promise<T>,
	fallback: T,
): Promise<T> {
	try {
		return await run();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		ctx.log.warn(`fluximporter: ${what} failed: ${redact(message)}`);
		return fallback;
	}
}

/** Maps service and job errors to HTTP errors; a source error's code goes in `details.code`. */
export function toRouteError(e: unknown): unknown {
	// EmDash's plugin storage throws its own InvalidCursorError (Fact V9); matched by name, so a
	// second copy of emdash in a bundle still matches (plan Ruling 1).
	if (e instanceof Error && e.name === "InvalidCursorError") {
		return new PluginRouteError(
			"INVALID_CURSOR",
			"The cursor is not valid; start again without it",
			400,
		);
	}
	if (e instanceof ServiceError) {
		return new PluginRouteError(e.code, e.message, e.status, e.details);
	}
	if (e instanceof JobError) {
		const status = e.code === "not_found" ? 404 : e.code === "invalid_transition" ? 409 : 400;
		const details = {
			...(e.details.length > 0 ? { problems: e.details } : {}),
			...(e.sourceCode === undefined ? {} : { code: e.sourceCode }),
		};
		const hasDetails = Object.keys(details).length > 0;
		return new PluginRouteError(
			e.code.toUpperCase(),
			e.message,
			status,
			hasDetails ? details : undefined,
		);
	}
	return e;
}

/** Builds the engine's dependencies for one request and maps service errors to HTTP errors. */
async function withServices<T>(
	ctx: RouteContext<unknown>,
	run: (services: RouteServices) => Promise<T>,
): Promise<T> {
	if (!ctx.user) throw PluginRouteError.unauthorized("Importing requires a signed-in user");
	const actor: ActorInfo = { id: ctx.user.id, role: ctx.user.role, source: "api" };
	return withRuntime(async (runtime) => {
		const services = buildServices(ctx, runtime, actor);
		try {
			return await run({ ...services, actor });
		} catch (e) {
			throw toRouteError(e);
		}
	});
}

/**
 * The most bytes of JSON a route that takes a template reads (EmDash's `request.maxBytes`).
 * Without a `request` declaration EmDash reads a JSON body with no limit of its own (emdash
 * src/plugins/routes.ts:132-143), and Node's adapter allows 1 GiB. 2 MiB covers any
 * serialisation of a template under the 256 KiB `TEMPLATE_MAX_BYTES`, pretty-printed or with
 * `\uXXXX` escapes (about 3x). An inline template a job stores is already held to the 1 MiB
 * conditional-write cap, so no import that worked before is refused. `schema/apply` writes no
 * job, so a body over 2 MiB that it accepted before (a long `fields` list or an inline template)
 * is now 413 `INVALID_PLUGIN_REQUEST`, an accepted change (M6a spec, Amendments).
 */
export const TEMPLATE_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The most bytes of JSON a `schedules/*` route reads (M6b review). Its largest input, an update
 * with every field, is well under 1 KiB; without a cap EmDash reads a body of any size.
 */
export const SCHEDULE_BODY_MAX_BYTES = 16 * 1024;

/** Caps a route's JSON body at `TEMPLATE_BODY_MAX_BYTES`; it stays an MCP-ready JSON POST route. */
function withTemplateBody<T>(r: PluginRoute<T>): PluginRoute<T> {
	return { ...r, request: { body: "json", maxBytes: TEMPLATE_BODY_MAX_BYTES } };
}

/**
 * `jobs/plan`'s body: text of at most 1 MiB (`PASTE_MAX_BYTES`), JSON-escaped, must fit with the
 * other arguments (spec Ruling 42). EmDash re-serializes the tool's arguments into this body. The
 * same 2 MiB as a template body (plan P7).
 */
export const PLAN_BODY_MAX_BYTES = TEMPLATE_BODY_MAX_BYTES;

function route<T>(
	input: z.ZodType<T>,
	handler: (ctx: RouteContext<T>) => Promise<unknown>,
): PluginRoute<T> {
	return { input, permission: PERMISSION, methods: ["POST"], handler };
}

/**
 * The agent routes' pace (spec "Input schemas"), shared by `jobs/plan` and `jobs/start`; each
 * field adds its own description (plan P7).
 */
const pace = {
	batchSize: z.number().int().min(1).max(500),
	budgetMs: z.number().int().min(500).max(25_000),
};

/**
 * The agent routes' inputs (spec "Input schemas"), which M6c's tools share (Task 5). Strict, so
 * a misspelt key is refused instead of ignored; described, because the descriptions are all an
 * agent sees; no transforms or defaults (plan Ruling 14). No `missing` or `journal` input
 * (spec Rulings 10, 29).
 */
export const PLAN_INPUT = z
	.object({
		templateId: templateId.describe("A saved template's id, from list_templates"),
		templateRevision: templateRevision
			.optional()
			.describe("Refuse with TEMPLATE_CHANGED unless the template is at this revision"),
		text: z
			.string()
			.min(1)
			.optional()
			.describe("The data, in the template's source format, at most 1 MiB"),
		sourceId: sourceId
			.optional()
			.describe("A URL source's id, given by the user or an administrator"),
		publish: z
			.boolean()
			.optional()
			.describe("Publish written entries (default true); false keeps them as drafts"),
		batchSize: pace.batchSize
			.optional()
			.describe("Records per next_batch call, 1-500 (default 50); Cloudflare Workers does fewer"),
		budgetMs: pace.budgetMs
			.optional()
			.describe("Time per next_batch call in milliseconds, 500-25000 (default 4000)"),
	})
	.strict()
	.refine((input) => (input.text === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of text and sourceId",
	});

export const START_INPUT = z
	.object({
		dryRunId: jobId.describe("The id of a completed dry run, from dry_run"),
		batchSize: pace.batchSize
			.optional()
			.describe("Records per next_batch call, 1-500 (default: the dry run's)"),
		budgetMs: pace.budgetMs
			.optional()
			.describe("Time per next_batch call in milliseconds, 500-25000 (default: the dry run's)"),
	})
	.strict();

export const STEP_INPUT = z
	.object({ id: jobId.describe("The job's id, from dry_run or start_import") })
	.strict();

export const STATUS_INPUT = z
	.object({
		id: jobId.describe("The job's id"),
		records: z
			.enum(RECORD_STATUSES)
			.optional()
			.describe("Also list up to 10 rows with this outcome"),
		cursor: cursor.describe("From the previous import_status call with the same records value"),
	})
	.strict();

/**
 * `templates/list` and `templates/get`'s inputs, which list_templates and get_template share
 * (M6c). Not strict: the REST routes have always stripped unknown keys, and so does the SDK.
 */
export const TEMPLATE_LIST_INPUT = z.object({
	collection: z
		.string()
		.min(1)
		.max(63)
		.optional()
		.describe("Only the templates that import into this collection (its slug)"),
	cursor: cursor.describe("From the previous list_templates call"),
});

export const TEMPLATE_GET_INPUT = z.object({
	id: templateId.describe("The template's id, from list_templates"),
});

/** `sources/overview`'s input, which list_sources shares (M6d). Strict, every field described. */
export const SOURCES_OVERVIEW_INPUT = z
	.object({ cursor: cursor.describe("From the previous list_sources call") })
	.strict();

/** `schedules/overview`'s input, which list_schedules shares (M6d). */
export const SCHEDULES_OVERVIEW_INPUT = z
	.object({ cursor: cursor.describe("From the previous list_schedules call") })
	.strict();

/** `templates/suggest`'s input (M6d spec "Input"). REST only: no tool shares it (spec Ruling 2). */
export const SUGGEST_INPUT = z
	.object({
		collection: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
		locale: z.string().min(1).max(35).optional(),
		source: source.optional(),
		text: z.string().min(1).optional(),
		uploadId: uploadId.optional(),
		sourceId: sourceId.optional(),
		templateId: templateId.optional(),
		templateRevision: templateRevision.optional(),
		template: z.unknown().optional(),
		ai: z.boolean().optional(),
	})
	.strict()
	.refine((i) => [i.text, i.uploadId, i.sourceId].filter((v) => v !== undefined).length === 1, {
		message: "Set exactly one of text, uploadId and sourceId",
	})
	.refine((i) => i.templateId === undefined || i.template === undefined, {
		message: "Set at most one of templateId and template",
	})
	.refine((i) => i.templateRevision === undefined || i.templateId !== undefined, {
		message: "templateRevision needs templateId",
	})
	.refine(
		(i) => (i.templateId === undefined && i.template === undefined) || i.source === undefined,
		{
			message: "A base template brings its own source block",
		},
	)
	.refine((i) => i.templateId !== undefined || i.template !== undefined || i.locale !== undefined, {
		message: "Set locale, or pass a base template",
	});

const createInput = z
	.object({
		uploadId: uploadId.optional(),
		sourceId: sourceId.optional(),
		/** With `sourceId`: fetch without validators and create the job even if nothing changed. */
		force: z.boolean().optional(),
		template: z.unknown().optional(),
		/** M6a: a saved template, read once here; the job keeps a snapshot of it. */
		templateId: templateId.optional(),
		/** With `templateId`: refuse `TEMPLATE_CHANGED` unless the template is at this revision. */
		templateRevision: templateRevision.optional(),
		dryRun: z.boolean(),
		publish: z.boolean().optional(),
		batchSize: z.number().int().optional(),
		budgetMs: z.number().int().optional(),
		/** Keep a journal so the job can be rolled back (M5a); default true. */
		journal: z.boolean().optional(),
		/** M5c: skip the missing phase for this run, or replace its threshold. */
		missing: z
			.union([
				z.literal(false),
				z.object({ maxPercent: z.number().int().min(0).max(100) }).strict(),
			])
			.optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of uploadId and sourceId",
	})
	.refine((input) => (input.template === undefined) !== (input.templateId === undefined), {
		message: "Set exactly one of template and templateId",
	})
	.refine((input) => input.templateRevision === undefined || input.templateId !== undefined, {
		message: "templateRevision needs templateId",
	});

/** Slugs, label lengths, options and indexing are checked by `applySchema` (one message each). */
const applyField = z
	.object({
		slug: z.string(),
		type: z.enum(APPLY_FIELD_TYPES),
		label: z.string().optional(),
		options: z.array(z.string()).optional(),
		indexed: z.boolean().optional(),
		searchable: z.boolean().optional(),
		translatable: z.boolean().optional(),
	})
	.strict();

const applyInput = z
	.object({
		collection: z.string().min(1).max(63).optional(),
		fields: z.array(applyField).min(1).max(MAX_APPLY_FIELDS).optional(),
		template: z.unknown().optional(),
		/** M6a: plan from a saved template (spec Ruling 19). */
		templateId: templateId.optional(),
		addOptions: z.boolean().optional(),
		dryRun: z.boolean().optional(),
	})
	.strict()
	.refine(
		(input) =>
			[input.fields, input.template, input.templateId].filter((v) => v !== undefined).length === 1,
		{ message: "Set exactly one of fields, template and templateId" },
	);

const templateUpdateInput = z
	.object({
		id: templateId,
		revision: templateRevision,
		name: templateName.optional(),
		/** `null` (or "") removes the description. */
		description: templateDescription.nullable().optional(),
		template: z.unknown().optional(),
	})
	.refine(
		(input) =>
			input.name !== undefined || input.description !== undefined || input.template !== undefined,
		{ message: "Change at least one of name, description and template" },
	);

const scheduleId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid schedule ID");
const scheduleRevision = z.number().int().min(1);
/** Spec Ruling 12: `false`, `"template"` or a lower threshold; the service checks it against the template. */
const scheduleMissing = z.union([
	z.literal(false),
	z.literal("template"),
	z.object({ maxPercent: z.number().int().min(0).max(100) }).strict(),
]);
/** The schedule options and their bounds (spec "Bounded work"). */
const scheduleOptions = {
	publish: z.boolean().optional(),
	batchSize: z.number().int().min(1).max(500).optional(),
	budgetMs: z.number().int().min(500).max(20_000).optional(),
	enabled: z.boolean().optional(),
};

/**
 * `schedules/create` (spec "Routes"). Strict (plan Ruling 15). The name follows M6a "Names"; the
 * expression is checked by the service, so its refusal is `INVALID_CRON`, not a schema error.
 */
export const SCHEDULE_CREATE_INPUT = z
	.object({
		name: scheduleName,
		templateId,
		templateRevision,
		sourceId,
		cron: z.string(),
		...scheduleOptions,
		missing: scheduleMissing.optional(),
	})
	.strict();

/** `schedules/update`: at least one change; a new `templateId` names its revision. */
export const SCHEDULE_UPDATE_INPUT = z
	.object({
		id: scheduleId,
		revision: scheduleRevision,
		name: scheduleName.optional(),
		templateId: templateId.optional(),
		templateRevision: templateRevision.optional(),
		sourceId: sourceId.optional(),
		cron: z.string().optional(),
		...scheduleOptions,
		missing: scheduleMissing.nullable().optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).some((key) => key !== "id" && key !== "revision"), {
		message: "Change at least one field",
	})
	.refine((input) => input.templateId === undefined || input.templateRevision !== undefined, {
		message: "templateId needs templateRevision",
	});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, async ({ deps, uploads, keep, sources }) => {
			let job = await changeJob(deps, uploads, ctx.input.id, action, keep);
			// A cancelled job no longer makes its source skip the next import of the same content.
			if (action === "cancel" && job.sourceId !== undefined) {
				await clearLastImport(sources, job.sourceId, job.id).catch(() => {});
			}
			// M6b (spec Ruling 32): cancelling a scheduled job pauses its schedule; best effort, as
			// the pump's finalization repeats it.
			const scheduleId = job.scheduleId;
			if (action === "cancel" && scheduleId !== undefined) {
				await bestEffort(
					ctx,
					"pausing the schedule of a cancelled job",
					() => pauseSchedule(scheduleWrites(ctx), scheduleId, "cancelled", job.id),
					false,
				);
			}
			// Plan Ruling 11: a finalized scheduled job that runs again is the pump's again; the
			// answer is the reopened row (preflight F19).
			if ((action === "resume" || action === "retry") && job.origin === "schedule") {
				const id = job.id;
				const reopen = () => reopenScheduled(deps.jobs, cronOf(ctx), id);
				job = (await bestEffort(ctx, "reopening a scheduled job", reopen, null)) ?? job;
			}
			return withoutPlannedTerms(job);
		}),
	);
}

/**
 * A `schedules/*` route: the call, then a reconciliation of the cron tasks, whatever the call
 * answered (spec "Reconciliation"). A reconciliation that fails is left to the next one.
 */
function scheduleRoute<T>(
	input: z.ZodType<T>,
	run: (ctx: RouteContext<T>, deps: ScheduleDeps, actor: ActorInfo) => Promise<unknown>,
): PluginRoute<T> {
	const r = route(input, (ctx) =>
		withServices(ctx, async (services) => {
			const deps = scheduleDeps(ctx, services);
			try {
				return await run(ctx, deps, services.actor);
			} finally {
				await bestEffort(ctx, "reconciling the schedule tasks", () => reconcile(deps), null);
			}
		}),
	);
	return { ...r, request: { body: "json", maxBytes: SCHEDULE_BODY_MAX_BYTES } };
}

const logCsv: PluginRoute<{ id: string; status?: RecordStatus | undefined }> = {
	input: z.object({ id: jobId, status: z.enum(RECORD_STATUSES).optional() }),
	permission: PERMISSION,
	methods: ["GET"],
	response: "raw",
	handler: (ctx) =>
		withServices(ctx, async ({ deps }) => {
			const csv = await jobLogCsv(deps, ctx.input.id, ctx.input.status);
			return pluginResponse({
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="fluximporter-${ctx.input.id}.csv"`,
				},
				body: { kind: "text", value: csv },
			});
		}),
};

/** The agent rules' dependencies for one request (plan Ruling 7). */
function agentDeps(ctx: RouteContext<unknown>, services: Services): AgentDeps {
	const { deps, storage, uploads } = services;
	return {
		jobs: deps.jobs,
		templates: templatesCollection(ctx.storage),
		// The rule's resolved template is passed on, so the job keeps the revision the rule checked
		// and the template is read once per call (plan Ruling 8).
		create: async (request, resolved) => {
			const job = await createJobFrom(ctx, services, request, resolved);
			// Documented invariant (plan P7): only a real URL-source job can be skipped (spec P2);
			// an agent URL job is a dry run, and jobs/start passes an upload, never a source.
			if ("skipped" in job) throw new Error("An agent job was skipped as unchanged");
			return job;
		},
		// stagePaste refuses empty text and text over PASTE_MAX_BYTES; planJob checks no size.
		stage: async (text) => (await stagePaste(storage, text)).uploadId,
		unstage: (uploadId) => uploads.delete(uploadId),
		newId: () => ulid(),
	};
}

/**
 * An agent route: every error the rule throws is redacted, and a missing file is
 * `SOURCE_FILE_MISSING` with `missing` as its message (spec Ruling 33), before `withServices`
 * maps it with `toRouteError`.
 */
function agentRoute<T>(
	input: z.ZodType<T>,
	run: (ctx: RouteContext<T>, services: RouteServices) => Promise<unknown>,
	missing?: string,
): PluginRoute<T> {
	// try/await rather than .catch, so a run that throws before returning a promise is redacted too.
	return route(input, (ctx) =>
		withServices(ctx, async (services) => {
			try {
				return await run(ctx, services);
			} catch (e) {
				throw agentError(e, missing);
			}
		}),
	);
}

export const routes: Record<string, PluginRoute> = {
	"sources/sample": route(
		z.object({
			uploadId,
			n: z.number().int().min(1).max(SAMPLE_MAX).default(5),
			source: source.optional(),
		}),
		(ctx) =>
			withServices(ctx, ({ deps, xlsx }) =>
				sampleImport(deps, xlsx, ctx.input.uploadId, ctx.input.n, ctx.input.source),
			),
	),

	// The text is staged like an upload; the template's source block decides how it is parsed.
	// A workbook is binary, so it can only be uploaded.
	"sources/paste": {
		...route(z.object({ format, text: z.string() }), async (ctx) => {
			if (ctx.input.format === "xlsx") {
				throw new PluginRouteError("INVALID_FORMAT", XLSX_PASTE_MESSAGE, 400);
			}
			return withServices(ctx, ({ storage }) => stagePaste(storage, ctx.input.text));
		}),
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},

	"credentials/set": route(
		z.object({ name: credentialName, header: headerName, value: headerValue }),
		(ctx) =>
			withServices(ctx, () =>
				setCredential(ctx.settings, ctx.input.name, {
					header: ctx.input.header,
					value: ctx.input.value,
				}),
			),
	),

	"credentials/delete": route(z.object({ name: credentialName }), (ctx) =>
		withServices(ctx, () => deleteCredential(ctx.settings, ctx.input.name)),
	),

	"credentials/list": route(z.object({}), (ctx) =>
		withServices(ctx, () => listCredentials(ctx.settings)),
	),

	"sources/create": route(
		z.object({ name: sourceName, url: sourceUrl, credential: credentialName.optional() }),
		(ctx) => withServices(ctx, ({ sources }) => createSource(sources, ctx.input)),
	),

	"sources/update": route(
		z.object({
			id: sourceId,
			name: sourceName.optional(),
			url: sourceUrl.optional(),
			credential: credentialName.nullable().optional(),
		}),
		(ctx) =>
			withServices(ctx, async ({ sources }) => {
				const row = await updateSource(sources, ctx.input);
				// M6b (spec Ruling 40, plan Ruling 14): `warnings` only when a schedule pins another
				// URL or credential, so the response is unchanged otherwise. Best effort: the source is
				// already saved (preflight F11).
				const warnings = await bestEffort(
					ctx,
					"reading the schedules of a source",
					async () => {
						const using = await schedulesUsing(
							schedulesCollection(ctx.storage),
							{ sourceId: row.id },
							MAX_SCHEDULES,
						);
						return sourceWarnings(using, await sourcePinOf(row));
					},
					[],
				);
				return warnings.length === 0 ? row : { ...row, warnings };
			}),
	),

	"sources/delete": route(z.object({ id: sourceId }), (ctx) =>
		withServices(ctx, async ({ sources }) => {
			// M6b (spec Ruling 10): never delete a source a schedule reads.
			const using = await schedulesUsing(schedulesCollection(ctx.storage), {
				sourceId: ctx.input.id,
			});
			if (using.length > 0) throw inUse("Source", ctx.input.id, using);
			return deleteSource(sources, ctx.input.id);
		}),
	),

	"sources/get": route(z.object({ id: sourceId }), (ctx) =>
		withServices(ctx, ({ sources }) => getSource(sources, ctx.input.id)),
	),

	"sources/list": route(z.object({ cursor }), (ctx) =>
		withServices(ctx, ({ sources }) => listSources(sources, ctx.input.cursor)),
	),

	"sources/fetch": route(z.object({ id: sourceId, force: z.boolean().optional() }), (ctx) =>
		withServices(ctx, ({ sources }) =>
			fetchSource(sources, ctx.input.id, ctx.input.force ?? false),
		),
	),

	// M6d: the agent's view of URL sources: hosts and codes only (spec Ruling 38).
	"sources/overview": {
		...route(SOURCES_OVERVIEW_INPUT, (ctx) =>
			withServices(ctx, ({ sources }) => sourcesOverview(sources, ctx.input.cursor)),
		),
		request: { body: "json", maxBytes: SCHEDULE_BODY_MAX_BYTES },
	},

	"jobs/create": withTemplateBody(
		route(createInput, (ctx) =>
			withServices(ctx, (services) => createJobFrom(ctx, services, ctx.input)),
		),
	),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, async (services) => {
			// Spec Ruling 5: a scheduled job's writes carry no user, whoever drives its batch.
			const job = await getJob(services.deps, ctx.input.id);
			const { deps, uploads, keep } =
				job.origin === "schedule" ? buildServices(ctx, services.runtime, null) : services;
			// A unique holder per call: two concurrent calls never share a lease.
			const holder = `${services.actor.id}:${ulid()}`;
			const next = await nextBatch(deps, uploads, ctx.input.id, holder, keep);
			// Best effort: the batch is done whether or not its source's record count is saved.
			await noteFetchRecords(services.sources, next).catch(() => {});
			return withoutPlannedTerms(next);
		}),
	),

	"jobs/get": route(byId, (ctx) =>
		withServices(ctx, ({ deps }) => getJob(deps, ctx.input.id).then(withoutPlannedTerms)),
	),

	"jobs/list": route(
		z.object({
			status: z.enum(JOB_STATUSES).optional(),
			templateId: templateId.optional(),
			cursor,
		}),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				listJobs(deps, {
					...(ctx.input.status ? { status: ctx.input.status } : {}),
					...(ctx.input.templateId ? { templateId: ctx.input.templateId } : {}),
					...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
				}).then((jobs) => ({ ...jobs, items: jobs.items.map(withoutPlannedTerms) })),
			),
	),

	// M7b: the admin's Jobs table: list items, not job rows, of real imports or of dry runs.
	"jobs/summaries": route(JOB_SUMMARIES_INPUT, (ctx) =>
		withServices(ctx, ({ deps }) =>
			listJobSummaries(deps, {
				dryRun: ctx.input.dryRun ?? false,
				...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
			}),
		),
	),

	// M7b (plan Ruling 6): clears finished and abandoned dry runs a page at a time; `cursor` is
	// the last scanned dry run's createdAt from the previous answer.
	"jobs/clear-dry-runs": route(z.object({ cursor }).strict(), (ctx) =>
		withServices(ctx, ({ deps, uploads, sources }) =>
			clearDryRuns(deps, uploads, sources.sources, ctx.input.cursor),
		),
	),

	// A real rollback marks the original rolled back and frees its URL source for a re-import.
	"jobs/rollback": route(
		z.object({
			id: jobId,
			dryRun: z.boolean().optional(),
			batchSize: z.number().int().optional(),
			budgetMs: z.number().int().optional(),
		}),
		(ctx) =>
			withServices(ctx, async ({ deps, sources }) => {
				const { id, dryRun, batchSize, budgetMs } = ctx.input;
				const { rollback, original } = await createRollback(deps, {
					id,
					...(dryRun === undefined ? {} : { dryRun }),
					...(batchSize === undefined ? {} : { batchSize }),
					...(budgetMs === undefined ? {} : { budgetMs }),
				});
				if (!rollback.dryRun && original.sourceId !== undefined) {
					await clearLastImport(sources, original.sourceId, original.id).catch(() => {});
				}
				// M6b (spec Ruling 32, plan Ruling 12): a real rollback of a scheduled job pauses its
				// schedule and marks its run; the pump's finalization repeats both. Best effort, as
				// the rollback is already created (preflight F11).
				const scheduleId = original.scheduleId;
				if (!rollback.dryRun && scheduleId !== undefined) {
					const mark = (row: ScheduleRow) =>
						withRollback(row, original.id, rollback.id, rollback.createdAt);
					await bestEffort(
						ctx,
						"pausing the schedule of a rolled back job",
						() => pauseSchedule(scheduleWrites(ctx), scheduleId, "rolled_back", original.id, mark),
						false,
					);
				}
				return rollback;
			}),
	),

	"jobs/pause": transition("pause"),
	"jobs/resume": transition("resume"),
	"jobs/cancel": transition("cancel"),
	"jobs/retry": transition("retry"),

	// `facet`: only the rows that change an entry, or that have warnings (Preview's filters).
	"jobs/records": route(
		z.object({
			id: jobId,
			status: z.enum(RECORD_STATUSES).optional(),
			facet: z.enum(["change", "warning"]).optional(),
			cursor,
		}),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				listRecords(deps, {
					id: ctx.input.id,
					...(ctx.input.status ? { status: ctx.input.status } : {}),
					...(ctx.input.facet ? { facet: ctx.input.facet } : {}),
					...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
				}),
			),
	),

	"jobs/log.csv": logCsv,

	// M6c: the agent routes behind the MCP tools (spec "Routes"). They return summaries, never
	// job rows, and enforce the agent's limits server-side (spec Ruling 35).
	"jobs/plan": {
		...agentRoute(
			PLAN_INPUT,
			async (ctx, services) => ({
				job: summarize(await planJob(agentDeps(ctx, services), ctx.input), services.deps.now()),
			}),
			PLAN_SOURCE_MISSING_MESSAGE,
		),
		request: { body: "json", maxBytes: PLAN_BODY_MAX_BYTES },
	},

	"jobs/start": agentRoute(START_INPUT, async (ctx, services) => {
		const job = await startFromDryRun(agentDeps(ctx, services), ctx.input);
		return { job: summarize(job, services.deps.now()) };
	}),

	"jobs/step": agentRoute(STEP_INPUT, async (ctx, { deps, uploads, actor, keep, sources }) => {
		const { id } = ctx.input;
		// As jobs/next: a unique holder per call, so two calls never share a lease.
		const job = await stepAgentJob(deps.jobs, id, () =>
			nextBatch(deps, uploads, id, `${actor.id}:${ulid()}`, keep),
		);
		await noteFetchRecords(sources, job).catch(() => {});
		return step(job, deps.now());
	}),

	"jobs/status": agentRoute(STATUS_INPUT, (ctx, { deps }) =>
		readJobStatus(deps, ctx.input, deps.now()),
	),

	// Additive only: creates missing fields and adds missing select options. With a templateId,
	// plans from the saved template as from an inline one; a given collection must still match.
	"schema/apply": withTemplateBody(
		route(applyInput, (ctx) =>
			withServices(ctx, async ({ runtime }) => {
				const { templateId: id, ...rest } = ctx.input;
				if (id === undefined) return applySchema(runtime.schemaRegistry, rest);
				const { template } = await resolveJobTemplate(templatesCollection(ctx.storage), id);
				return applySchema(runtime.schemaRegistry, { ...rest, template });
			}),
		),
	),

	// Saved templates (M6a). Every route is a JSON POST with a permission, so M6c can expose it
	// as an MCP tool unchanged (spec Ruling 17). The author is always the caller.
	"templates/list": route(TEMPLATE_LIST_INPUT, (ctx) =>
		withServices(ctx, (services) =>
			listTemplates(templateDeps(ctx, services), {
				...(ctx.input.collection ? { collection: ctx.input.collection } : {}),
				...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
			}),
		),
	),

	"templates/get": route(TEMPLATE_GET_INPUT, (ctx) =>
		withServices(ctx, (services) => getTemplate(templateDeps(ctx, services), ctx.input.id)),
	),

	"templates/create": withTemplateBody(
		route(
			z.object({
				name: templateName,
				description: templateDescription.optional(),
				template: z.unknown(),
			}),
			(ctx) =>
				withServices(ctx, (services) => {
					const { name, description, template } = ctx.input;
					return createTemplate(templateDeps(ctx, services), services.actor.id, {
						name,
						...(description === undefined ? {} : { description }),
						template,
					});
				}),
		),
	),

	"templates/update": withTemplateBody(
		route(templateUpdateInput, (ctx) =>
			withServices(ctx, async (services) => {
				const { id, revision, name, description, template } = ctx.input;
				const saved = await updateTemplate(templateDeps(ctx, services), services.actor.id, {
					id,
					revision,
					...(name === undefined ? {} : { name }),
					...(description === undefined ? {} : { description }),
					...(template === undefined ? {} : { template }),
				});
				// M6b (spec Ruling 11): the schedules still pinned to another revision. Best effort:
				// the template is already saved (preflight F11).
				const pinned = await bestEffort(
					ctx,
					"reading the schedules of a template",
					async () => {
						const using = await schedulesUsing(
							schedulesCollection(ctx.storage),
							{ templateId: id },
							MAX_SCHEDULES,
						);
						return templateWarnings(using, saved.template.revision);
					},
					[],
				);
				if (pinned.length === 0) return saved;
				return {
					...saved,
					check: { ...saved.check, warnings: [...saved.check.warnings, ...pinned] },
				};
			}),
		),
	),

	"templates/delete": route(z.object({ id: templateId, revision: templateRevision }), (ctx) =>
		withServices(ctx, async (services) => {
			// M6b (spec Ruling 10): never delete a template a schedule runs.
			const using = await schedulesUsing(schedulesCollection(ctx.storage), {
				templateId: ctx.input.id,
			});
			if (using.length > 0) throw inUse("Template", ctx.input.id, using);
			return deleteTemplate(templateDeps(ctx, services), ctx.input);
		}),
	),

	"templates/export": route(z.object({ id: templateId }), (ctx) =>
		withServices(ctx, (services) => exportTemplate(templateDeps(ctx, services), ctx.input.id)),
	),

	// The name and owner overrides are validated here only, as the source routes validate their
	// input (preflight F11); the service trusts them.
	"templates/import": withTemplateBody(
		route(
			z.object({
				file: z.unknown(),
				name: templateName.optional(),
				owner: templateOwner.optional(),
			}),
			(ctx) =>
				withServices(ctx, (services) => {
					const { file, name, owner } = ctx.input;
					return importTemplate(templateDeps(ctx, services), services.actor.id, {
						file,
						...(name === undefined ? {} : { name }),
						...(owner === undefined ? {} : { owner }),
					});
				}),
		),
	),

	// M6d: a draft template from a sample, by name matching and optionally a model (spec Ruling 1).
	"templates/suggest": {
		...route(SUGGEST_INPUT, (ctx) =>
			withServices(ctx, (services) => suggestMapping(suggestDeps(ctx, services), ctx.input)),
		),
		request: { body: "json", maxBytes: PLAN_BODY_MAX_BYTES },
	},

	// Schedules (M6b). Admin routes only: no schedule route is an MCP tool (spec Ruling 50), but
	// for M6d's read-only schedules/overview.
	"schedules/create": scheduleRoute(SCHEDULE_CREATE_INPUT, async (ctx, deps, actor) => ({
		schedule: await createSchedule(deps, actor.id, ctx.input),
	})),

	"schedules/list": scheduleRoute(z.object({ cursor }).strict(), (ctx, deps) =>
		listSchedules(deps, ctx.input.cursor),
	),

	"schedules/update": scheduleRoute(SCHEDULE_UPDATE_INPUT, async (ctx, deps, actor) => ({
		schedule: await updateSchedule(deps, actor.id, ctx.input),
	})),

	"schedules/delete": scheduleRoute(
		z.object({ id: scheduleId, revision: scheduleRevision }).strict(),
		(ctx, deps) => deleteSchedule(deps, ctx.input),
	),

	// Spec Ruling 51: queues a due mark; the pump launches at its next tick.
	"schedules/run": scheduleRoute(
		z.object({ id: scheduleId, force: z.boolean().optional() }).strict(),
		async (ctx, deps) => ({ queued: true, schedule: await runSchedule(deps, ctx.input) }),
	),

	// M6d: the agent's view of schedules: codes only, no reconciliation (spec Ruling 39).
	"schedules/overview": {
		...route(SCHEDULES_OVERVIEW_INPUT, (ctx) =>
			withServices(ctx, () =>
				schedulesOverview(
					{ schedules: schedulesCollection(ctx.storage), cron: cronOf(ctx) },
					ctx.input.cursor,
				),
			),
		),
		request: { body: "json", maxBytes: SCHEDULE_BODY_MAX_BYTES },
	},

	// M7b (plan Ruling 8): the site fence for the Schedules tab, read-only. A plain route, so no
	// reconciliation; capped as every schedules/* route is.
	"schedules/fence": {
		...route(z.object({}).strict(), (ctx) =>
			withServices(ctx, async ({ runtime }) => ({ fence: await readFence(runtime.db) })),
		),
		request: { body: "json", maxBytes: SCHEDULE_BODY_MAX_BYTES },
	},
};
