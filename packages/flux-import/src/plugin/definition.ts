import type { PluginStorageConfig } from "emdash";
import { definePlugin } from "emdash";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads } from "../emdash/uploads.js";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "../meta.js";
import { purgeExpired, RETENTION_DAYS_DEFAULT, RETENTION_TASK } from "./retention.js";
import { ensureRetentionScheduled, routes } from "./routes.js";
import { withRuntime } from "./runtime.js";

export type FluxImportOptions = Record<string, never>;

/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` lets a finished job check
 * whether another job still needs its staged file before deleting it.
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId"] },
	records: {
		indexes: ["jobId", ["jobId", "status"], ["jobId", "seq"], ["jobId", "status", "seq"]],
	},
	links: { indexes: ["entryId"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// Declared for disclosure on the admin plugins page. The importer reads and writes content
		// and adds the flux_source_id field through the trusted runtime (withEmDashRuntime), not
		// through ctx.content, so these do not gate any call it makes.
		capabilities: ["content:read", "content:write", "content:publish", "schema:read"],
		storage: STORAGE,
		routes,
		admin: {
			settingsSchema: {
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
						);
					});
					ctx.log.info("Removed expired import data", result);
				},
			},
		},
	});
}
