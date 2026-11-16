import { z } from "astro/zod";
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale, resolveTranslationLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { listSchemaFields, readPublishAtCollection } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { JobError, withoutPlannedTerms } from "../engine/jobs.js";
import { createRollback } from "../engine/rollback.js";
import { OWNER_PATTERN, OWNER_RULE } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
import { defaultResolver, type NetOptions } from "../sources/net.js";
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
import {
	CREDENTIAL_NAME,
	deleteCredential,
	FORBIDDEN_HEADERS,
	HEADER_NAME,
	HEADER_VALUE,
	listCredentials,
	setCredential,
} from "./credentials.js";
import {
	type JobRequest,
	jobTemplateRef,
	type ResolvedTemplate,
	resolveJobTemplate,
} from "./job-templates.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import { APPLY_FIELD_TYPES, applySchema, MAX_APPLY_FIELDS } from "./schema-apply.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	listJobs,
	listRecords,
	mediaMaxBytes,
	nextBatch,
	PASTE_MAX_BYTES,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	stagePaste,
	type UploadKeeper,
} from "./service.js";
import {
	clearLastImport,
	createSource,
	deleteSource,
	fetchSource,
	getSource,
	jobFromSource,
	latestSourceUploads,
	listSources,
	type SkippedJob,
	type SourceDeps,
	sourcesCollection,
	updateSource,
} from "./sources.js";
import { step, summarize } from "./summaries.js";
import { exportTemplate, importTemplate } from "./template-files.js";
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_NAME_RULE,
	type TemplateDeps,
	templateNameProblem,
	templatesCollection,
	updateTemplate,
} from "./templates.js";
import {
	fetchLimitsFor,
	sampleImport,
	startImport,
	XLSX_WORKERS_BUFFER,
	type XlsxStaging,
} from "./xlsx.js";

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
const format = z.enum(SOURCE_FORMATS);
const templateId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid template ID");
/** Checked as the service stores it (NFC); the service normalises (spec "Names"). */
const templateName = z
	.string()
	.refine((name) => templateNameProblem(name) === null, TEMPLATE_NAME_RULE);
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

export async function ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">): Promise<void> {
	if (!ctx.cron) return;
	const tasks = await ctx.cron.list();
	if (!tasks.some((t) => t.name === RETENTION_TASK)) {
		await ctx.cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
	}
}

interface Services {
	deps: EngineDeps;
	uploads: EmDashUploads;
	storage: UploadStorage;
	runtime: EmDashRuntime;
	actor: ActorInfo;
	sources: SourceDeps;
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
	/** Where an XLSX sheet is staged once converted, and its limits. */
	xlsx: XlsxStaging;
}

/** The saved-template services' dependencies for one request (M6a). */
function templateDeps(ctx: RouteContext<unknown>, { deps, runtime }: Services): TemplateDeps {
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
	run: (services: Services) => Promise<T>,
): Promise<T> {
	if (!ctx.user) throw PluginRouteError.unauthorized("Importing requires a signed-in user");
	const actor: ActorInfo = { id: ctx.user.id, role: ctx.user.role, source: "api" };
	return withRuntime(async (runtime) => {
		if (!runtime.storage) {
			throw new PluginRouteError("NOT_CONFIGURED", "EmDash storage is not configured", 500);
		}
		const uploads = new EmDashUploads(runtime.storage);
		const collection = sourcesCollection(ctx.storage);
		const net: NetOptions = {
			resolver: defaultResolver(),
			allowPrivateNetwork: allowPrivateNetwork(),
			// A plain call: workerd rejects fetch() called as a method of another object.
			fetch: (input, init) => fetch(input, init),
		};
		const sources: SourceDeps = {
			sources: collection,
			jobs: pluginCollections(ctx.storage).jobs,
			settings: ctx.settings,
			storage: runtime.storage,
			net,
			limits: { ...FETCH_LIMITS, maxBytes: maxSourceBytes() },
			workers: onWorkers(),
			now: Date.now,
			newId: () => ulid(),
		};
		const keep: UploadKeeper = async (uploadId) =>
			(await latestSourceUploads(collection)).has(uploadId);
		const deps: EngineDeps = {
			...pluginCollections(ctx.storage),
			content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			lookups: new EmDashLookups(ctx.taxonomies, ctx.bylines, runtime),
			// Media is fetched without credentials, behind the same SSRF guard as URL sources.
			media: new EmDashMedia(runtime, actor.id, runtime.config.maxUploadSize),
			mediaFetcher: createMediaFetcher(net),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
		};
		const xlsx: XlsxStaging = {
			storage: runtime.storage,
			maxXlsxBytes: maxXlsxBytes(),
			maxSourceBytes: maxSourceBytes(),
			workers: onWorkers(),
			bufferBytes: XLSX_WORKERS_BUFFER,
		};
		try {
			return await run({
				deps,
				uploads,
				storage: runtime.storage,
				runtime,
				actor,
				sources,
				keep,
				xlsx,
			});
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

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, async ({ deps, uploads, keep, sources }) => {
			const job = await changeJob(deps, uploads, ctx.input.id, action, keep);
			// A cancelled job no longer makes its source skip the next import of the same content.
			if (action === "cancel" && job.sourceId !== undefined) {
				await clearLastImport(sources, job.sourceId, job.id).catch(() => {});
			}
			return withoutPlannedTerms(job);
		}),
	);
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
					"content-disposition": `attachment; filename="flux-import-${ctx.input.id}.csv"`,
				},
				body: { kind: "text", value: csv },
			});
		}),
};

/**
 * Creates a job as `jobs/create` always has (M6c: shared with `jobs/plan` and `jobs/start`,
 * which pass the template they resolved themselves, plan Ruling 8). A saved template is read
 * once, here or by the caller; everything below uses it as an inline template, and the job
 * stores a snapshot of it.
 */
async function createJobFrom(
	ctx: RouteContext<unknown>,
	{ deps, runtime, sources, xlsx }: Services,
	request: JobRequest,
	given?: ResolvedTemplate,
): Promise<Job | SkippedJob> {
	await ensureRetentionScheduled(ctx);
	const resolved =
		given ??
		(request.templateId === undefined
			? { template: request.template }
			: await resolveJobTemplate(
					templatesCollection(ctx.storage),
					request.templateId,
					request.templateRevision,
				));
	const { template } = resolved;
	// Read once here and stored on the job, so a resumed or retried job converts the same way.
	const siteTimezone = needsSiteTimezone(template) ? await readSiteTimezone() : undefined;
	// Read once here: whether a published entry's update can be scheduled (M5b). The same read
	// serves the job's schema lookup for that collection.
	const own = await readPublishAtCollection(runtime.schemaRegistry, template);
	const revisions = own === null ? undefined : own.revisions;
	const start = (upload: string, fromSource?: string) => {
		const options: StartJobInput = {
			uploadId: upload,
			template,
			dryRun: request.dryRun,
			...(request.id === undefined ? {} : { id: request.id }),
			...(request.origin === undefined ? {} : { origin: request.origin }),
			...(request.dryRunOf === undefined ? {} : { dryRunOf: request.dryRunOf }),
			...(resolved.saved === undefined ? {} : { savedTemplate: resolved.saved }),
			...(fromSource === undefined ? {} : { sourceId: fromSource }),
			...(request.journal === undefined ? {} : { journal: request.journal }),
			...(request.missing === undefined ? {} : { missing: request.missing }),
			mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
			...(siteTimezone === undefined ? {} : { siteTimezone }),
			...(revisions === undefined ? {} : { revisions }),
			...(request.publish === undefined ? {} : { publish: request.publish }),
			...(request.batchSize === undefined ? {} : { batchSize: request.batchSize }),
			...(request.budgetMs === undefined ? {} : { budgetMs: request.budgetMs }),
		};
		return startImport(
			deps,
			xlsx,
			options,
			(collection) =>
				own !== null && collection === own.collection
					? Promise.resolve(own.fields)
					: listSchemaFields(runtime.schemaRegistry, collection),
			(locale) => resolveSiteLocale(locale),
			(sourceLocale, locale) => resolveTranslationLocale(sourceLocale, locale),
		);
	};
	if (request.sourceId !== undefined) {
		const options = {
			force: request.force ?? false,
			dryRun: request.dryRun,
			// The unchanged-content skip also compares the template (spec Ruling 29).
			template: await jobTemplateRef(resolved),
		};
		// A workbook is fetched only up to the XLSX file limit.
		const limits = fetchLimitsFor(template, sources.limits, xlsx.maxXlsxBytes);
		return jobFromSource({ ...sources, limits }, request.sourceId, options, start);
	}
	if (request.uploadId === undefined) {
		throw new PluginRouteError("VALIDATION_ERROR", "Set exactly one of uploadId and sourceId", 400);
	}
	return start(request.uploadId);
}

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
	run: (ctx: RouteContext<T>, services: Services) => Promise<unknown>,
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
				throw new PluginRouteError(
					"INVALID_FORMAT",
					"An XLSX workbook is a binary file and cannot be pasted; upload it instead",
					400,
				);
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
		(ctx) => withServices(ctx, ({ sources }) => updateSource(sources, ctx.input)),
	),

	"sources/delete": route(z.object({ id: sourceId }), (ctx) =>
		withServices(ctx, ({ sources }) => deleteSource(sources, ctx.input.id)),
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

	"jobs/create": withTemplateBody(
		route(createInput, (ctx) =>
			withServices(ctx, (services) => createJobFrom(ctx, services, ctx.input)),
		),
	),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor, keep }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`, keep).then(
				withoutPlannedTerms,
			),
		),
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
				return rollback;
			}),
	),

	"jobs/pause": transition("pause"),
	"jobs/resume": transition("resume"),
	"jobs/cancel": transition("cancel"),
	"jobs/retry": transition("retry"),

	"jobs/records": route(
		z.object({ id: jobId, status: z.enum(RECORD_STATUSES).optional(), cursor }),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				listRecords(deps, {
					id: ctx.input.id,
					...(ctx.input.status ? { status: ctx.input.status } : {}),
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

	"jobs/step": agentRoute(STEP_INPUT, async (ctx, { deps, uploads, actor, keep }) => {
		const { id } = ctx.input;
		// As jobs/next: a unique holder per call, so two calls never share a lease.
		const job = await stepAgentJob(deps.jobs, id, () =>
			nextBatch(deps, uploads, id, `${actor.id}:${ulid()}`, keep),
		);
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
	"templates/list": route(
		z.object({ collection: z.string().min(1).max(63).optional(), cursor }),
		(ctx) =>
			withServices(ctx, (services) =>
				listTemplates(templateDeps(ctx, services), {
					...(ctx.input.collection ? { collection: ctx.input.collection } : {}),
					...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
				}),
			),
	),

	"templates/get": route(z.object({ id: templateId }), (ctx) =>
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
			withServices(ctx, (services) => {
				const { id, revision, name, description, template } = ctx.input;
				return updateTemplate(templateDeps(ctx, services), services.actor.id, {
					id,
					revision,
					...(name === undefined ? {} : { name }),
					...(description === undefined ? {} : { description }),
					...(template === undefined ? {} : { template }),
				});
			}),
		),
	),

	"templates/delete": route(z.object({ id: templateId, revision: templateRevision }), (ctx) =>
		withServices(ctx, (services) => deleteTemplate(templateDeps(ctx, services), ctx.input)),
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
};
