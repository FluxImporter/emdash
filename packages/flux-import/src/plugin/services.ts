import type { ActorInfo, PluginContext } from "emdash";
import { PluginRouteError, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes, maxXlsxBytes } from "../astro/config.js";
import { EmDashContent } from "../emdash/content.js";
import { resolveSiteLocale, resolveTranslationLocale } from "../emdash/locale.js";
import { isEntryLocked } from "../emdash/locks.js";
import { EmDashLookups } from "../emdash/lookups.js";
import { EmDashMedia } from "../emdash/media.js";
import { listSchemaFields, readPublishAtCollection } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { needsSiteTimezone, readSiteTimezone } from "../emdash/timezone.js";
import { EmDashUploads, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import type { EngineDeps, Job } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { createMediaFetcher } from "../sources/media-fetch.js";
import { defaultResolver, type NetOptions } from "../sources/net.js";
import {
	type JobRequest,
	jobTemplateRef,
	type ResolvedTemplate,
	resolveJobTemplate,
} from "./job-templates.js";
import { ensureRetentionScheduled } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import { mediaMaxBytes, type StartJobInput, type UploadKeeper } from "./service.js";
import {
	jobFromSource,
	latestSourceUploads,
	type SkippedJob,
	type SourceDeps,
	sourcesCollection,
} from "./sources.js";
import { templatesCollection } from "./templates.js";
import { fetchLimitsFor, startImport, XLSX_WORKERS_BUFFER, type XlsxStaging } from "./xlsx.js";

export interface Services {
	deps: EngineDeps;
	uploads: EmDashUploads;
	storage: UploadStorage;
	runtime: EmDashRuntime;
	/**
	 * Who the writes are made as: the calling user on a route, nobody in a cron task or for a
	 * scheduled job (spec Rulings 4, 5).
	 */
	actor: ActorInfo | null;
	sources: SourceDeps;
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
	/** Where an XLSX sheet is staged once converted, and its limits. */
	xlsx: XlsxStaging;
}

/**
 * The engine's dependencies over the trusted runtime, for one route call or one cron task (spec
 * "Cron tasks and the hook"). With `actor` null the content and media writes carry no user and
 * the lock reader treats every live lease as foreign (`NO_USER`).
 */
export function buildServices(
	ctx: PluginContext,
	runtime: EmDashRuntime,
	actor: ActorInfo | null,
): Services {
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
		media: new EmDashMedia(runtime, actor?.id ?? null, runtime.config.maxUploadSize),
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
	return { deps, uploads, storage: runtime.storage, runtime, actor, sources, keep, xlsx };
}

/** A cron task's services: the route services' builder with no actor (spec Ruling 4). */
export function withScheduledServices<T>(
	ctx: PluginContext,
	run: (services: Services) => Promise<T>,
): Promise<T> {
	return withRuntime((runtime) => run(buildServices(ctx, runtime, null)));
}

/**
 * Creates a job as `jobs/create` always has (M6c: shared with `jobs/plan` and `jobs/start`,
 * which pass the template they resolved themselves, plan Ruling 8). A saved template is read
 * once, here or by the caller; everything below uses it as an inline template, and the job
 * stores a snapshot of it.
 */
export async function createJobFrom(
	ctx: PluginContext,
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
		const feed = fromSource ?? request.feedSourceId;
		const options: StartJobInput = {
			uploadId: upload,
			template,
			dryRun: request.dryRun,
			...(request.id === undefined ? {} : { id: request.id }),
			...(request.origin === undefined ? {} : { origin: request.origin }),
			...(request.dryRunOf === undefined ? {} : { dryRunOf: request.dryRunOf }),
			...(resolved.saved === undefined ? {} : { savedTemplate: resolved.saved }),
			...(request.scheduleId === undefined ? {} : { scheduleId: request.scheduleId }),
			...(request.scheduled === undefined ? {} : { scheduled: request.scheduled }),
			...(fromSource === undefined ? {} : { sourceId: fromSource }),
			// M6b (spec Ruling 33): the URL source whose data the job reads.
			...(feed === undefined ? {} : { feedSourceId: feed }),
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
