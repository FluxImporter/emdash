import { z } from "astro/zod";
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { JobError } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { defaultResolver } from "../sources/net.js";
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
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	listJobs,
	listRecords,
	nextBatch,
	PASTE_MAX_BYTES,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	stagePaste,
	type UploadKeeper,
} from "./service.js";
import {
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
		const sources: SourceDeps = {
			sources: collection,
			jobs: pluginCollections(ctx.storage).jobs,
			settings: ctx.settings,
			storage: runtime.storage,
			net: {
				resolver: defaultResolver(),
				allowPrivateNetwork: allowPrivateNetwork(),
				// A plain call: workerd rejects fetch() called as a method of another object.
				fetch: (input, init) => fetch(input, init),
			},
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
		template: z.unknown(),
		dryRun: z.boolean(),
		publish: z.boolean().optional(),
		batchSize: z.number().int().optional(),
		budgetMs: z.number().int().optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of uploadId and sourceId",
	});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, keep }) =>
			changeJob(deps, uploads, ctx.input.id, action, keep),
		),
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

	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime, sources, xlsx }) => {
			const { input } = ctx;
			const start = (upload: string) => {
				const options: StartJobInput = {
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
				};
				return startImport(
					deps,
					xlsx,
					options,
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
					(locale) => resolveSiteLocale(locale),
				);
			};
			if (input.sourceId !== undefined) {
				const options = { force: input.force ?? false, dryRun: input.dryRun };
				// A workbook is fetched only up to the XLSX file limit.
				const limits = fetchLimitsFor(input.template, sources.limits, xlsx.maxXlsxBytes);
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

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor, keep }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`, keep),
		),
	),

	"jobs/get": route(byId, (ctx) => withServices(ctx, ({ deps }) => getJob(deps, ctx.input.id))),

	"jobs/list": route(z.object({ status: z.enum(JOB_STATUSES).optional(), cursor }), (ctx) =>
		withServices(ctx, ({ deps }) =>
			listJobs(deps, {
				...(ctx.input.status ? { status: ctx.input.status } : {}),
				...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
			}),
		),
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
};
