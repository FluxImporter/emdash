import type { PluginStorageConfig } from "emdash";
import { definePlugin } from "emdash";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads } from "../emdash/uploads.js";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "../meta.js";
import { purgeExpired, RETENTION_DAYS_DEFAULT, RETENTION_TASK } from "./retention.js";
import { ensureRetentionScheduled, routes } from "./routes.js";
import { withRuntime } from "./runtime.js";
import { latestSourceUploads, sourcesCollection } from "./sources.js";

export type FluxImportOptions = Record<string, never>;

/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` and `jobs.sourceUploadId` let a
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it. `media` is the site-wide media map; its
 * `jobId` and `mediaId` indexes let a job's own media be listed (M5 rollback, audit).
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId", "sourceUploadId"] },
	records: {
		indexes: [
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
			["jobId", "sourceKey"],
		],
	},
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// The content and schema capabilities are declared for disclosure on the admin plugins
		// page. The importer reads and writes content, adds the flux_source_id field and creates
		// fields for schema/apply through the trusted runtime (withEmDashRuntime), not through
		// ctx.content, so these do not gate any call it makes; plugins have no schema-writing
		// capability to declare. The other two gate calls the importer makes: taxonomies:write
		// gives ctx.taxonomies, which reads taxonomies, terms and entry terms and creates missing
		// terms (createTerm, the only sanctioned way to create one); bylines:read gives
		// ctx.bylines, whose list is the only way to look bylines up. Entries are assigned their
		// terms, references and bylines through the runtime's content writes. media:write is
		// declared for disclosure too: image and file fields are uploaded through the runtime's
		// handleMediaUpload, not ctx.media. URL sources and media are fetched with the runtime's
		// own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through ctx.http,
		// so no network capability is declared.
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			"media:write",
		],
		storage: STORAGE,
		routes,
		admin: {
			settingsSchema: {
				credentials: {
					type: "secret",
					label: "URL source credentials",
					description:
						"Managed through the credentials routes (one encrypted JSON object). Saving other text here removes every credential.",
				},
				retentionDays: {
					type: "number",
					label: "Keep import logs for (days)",
					description:
						"Job records and staged source files older than this are deleted daily. 0 deletes them at the next daily run.",
					default: RETENTION_DAYS_DEFAULT,
					min: 0,
					max: 3650,
				},
			},
		},
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await ensureRetentionScheduled(ctx);
			},
			cron: {
				timeout: 60_000,
				handler: async (event, ctx) => {
					if (event.name !== RETENTION_TASK) return;
					const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
					const result = await withRuntime(async (runtime) => {
						if (!runtime.storage) throw new Error("flux-import: EmDash storage is not configured");
						const { jobs, records } = pluginCollections(ctx.storage);
						return purgeExpired(
							{ jobs, records, now: Date.now },
							new EmDashUploads(runtime.storage),
							days,
							await latestSourceUploads(sourcesCollection(ctx.storage)),
						);
					});
					ctx.log.info("Removed expired import data", result);
				},
			},
		},
	});
}
