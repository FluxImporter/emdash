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
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
import { defaultResolver, type NetOptions } from "../sources/net.js";
import { SOURCE_FORMATS, XLSX_MAX_ROWS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
	deleteCredential,
	FORBIDDEN_HEADERS,
	HEADER_NAME,
	HEADER_VALUE,
	listCredentials,
	setCredential,
} from "./credentials.js";
import { jobTemplateRef, resolveJobTemplate } from "./job-templates.js";
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
	type SourceDeps,
	sourcesCollection,
	updateSource,
} from "./sources.js";
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

function route<T>(
	input: z.ZodType<T>,
	handler: (ctx: RouteContext<T>) => Promise<unknown>,
): PluginRoute<T> {
	return { input, permission: PERMISSION, methods: ["POST"], handler };
}

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
		route(createInput, async (ctx) => {
			await ensureRetentionScheduled(ctx);
			return withServices(ctx, async ({ deps, runtime, sources, xlsx }) => {
				const { input } = ctx;
				// A saved template is read once, here (spec "Jobs from saved templates"); everything
				// below uses it as an inline template, and the job stores a snapshot of it.
				const resolved =
					input.templateId === undefined
						? { template: input.template }
						: await resolveJobTemplate(
								templatesCollection(ctx.storage),
								input.templateId,
								input.templateRevision,
							);
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
						dryRun: input.dryRun,
						...(resolved.saved === undefined ? {} : { savedTemplate: resolved.saved }),
						...(fromSource === undefined ? {} : { sourceId: fromSource }),
						...(input.journal === undefined ? {} : { journal: input.journal }),
						...(input.missing === undefined ? {} : { missing: input.missing }),
						mediaMaxBytes: mediaMaxBytes(runtime.config.maxUploadSize, onWorkers()),
						...(siteTimezone === undefined ? {} : { siteTimezone }),
						...(revisions === undefined ? {} : { revisions }),
						...(input.publish === undefined ? {} : { publish: input.publish }),
						...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
						...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
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
				if (input.sourceId !== undefined) {
					const options = {
						force: input.force ?? false,
						dryRun: input.dryRun,
						// The unchanged-content skip also compares the template (spec Ruling 29).
						template: await jobTemplateRef(resolved),
					};
					// A workbook is fetched only up to the XLSX file limit.
					const limits = fetchLimitsFor(template, sources.limits, xlsx.maxXlsxBytes);
					return jobFromSource({ ...sources, limits }, input.sourceId, options, start);
				}
				if (input.uploadId === undefined) {
					throw new PluginRouteError(
						"VALIDATION_ERROR",
						"Set exactly one of uploadId and sourceId",
						400,
					);
				}
				return start(input.uploadId);
			});
		}),
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
