import { z } from "astro/zod";
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads, isUploadId } from "../emdash/uploads.js";
import { JobError } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	listJobs,
	listRecords,
	nextBatch,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	sampleSource,
	startJob,
} from "./service.js";

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
] as const satisfies readonly RecordStatus[];

const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
const uploadId = z.string().refine(isUploadId, "Invalid upload ID");
const cursor = z.string().min(1).max(1024).optional();
const byId = z.object({ id: jobId });

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
	runtime: EmDashRuntime;
	actor: ActorInfo;
}

function toRouteError(e: unknown): unknown {
	if (e instanceof ServiceError) return new PluginRouteError(e.code, e.message, e.status);
	if (e instanceof JobError) {
		const status = e.code === "not_found" ? 404 : e.code === "invalid_transition" ? 409 : 400;
		const details = e.details.length > 0 ? { problems: e.details } : undefined;
		return new PluginRouteError(e.code.toUpperCase(), e.message, status, details);
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
		const deps: EngineDeps = {
			...pluginCollections(ctx.storage),
			content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
		};
		try {
			return await run({ deps, uploads, runtime, actor });
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

const createInput = z.object({
	uploadId,
	template: z.unknown(),
	dryRun: z.boolean(),
	publish: z.boolean().optional(),
	batchSize: z.number().int().optional(),
	budgetMs: z.number().int().optional(),
});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads }) => changeJob(deps, uploads, ctx.input.id, action)),
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
		z.object({ uploadId, n: z.number().int().min(1).max(SAMPLE_MAX).default(5) }),
		(ctx) => withServices(ctx, ({ deps }) => sampleSource(deps, ctx.input.uploadId, ctx.input.n)),
	),

	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime }) => {
			const { input } = ctx;
			const options: StartJobInput = {
				uploadId: input.uploadId,
				template: input.template,
				dryRun: input.dryRun,
				...(input.publish === undefined ? {} : { publish: input.publish }),
				...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
				...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
			};
			return startJob(
				deps,
				options,
				(collection) => listSchemaFields(runtime.schemaRegistry, collection),
				(locale) => resolveSiteLocale(locale),
			);
		});
	}),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`),
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
