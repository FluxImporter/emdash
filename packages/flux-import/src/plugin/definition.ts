import type { PluginStorageConfig } from "emdash";
import { definePlugin } from "emdash";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "../meta.js";
import { MCP_TOOLS } from "./mcp.js";
import { RETENTION_DAYS_DEFAULT } from "./retention.js";
import { routes } from "./routes.js";
import { activate, CRON_HOOK_TIMEOUT_MS, cronHook } from "./scheduler.js";

export type FluxImportOptions = Record<string, never>;

/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` and `jobs.sourceUploadId` let a
 * finished job check whether another job still needs its staged file (or the workbook an XLSX
 * job was converted from) before deleting it. `media` is the site-wide media map; its
 * `jobId` and `mediaId` indexes let a job's own media be listed (M5 rollback, audit).
 * `journal` holds what each real job changed, one row per (job, entry), read newest first by a
 * rollback (`["jobId", "seq"]`); `journalMedia` the media items each job's uploads created (M5a).
 * `templates` holds saved templates (M6a): `name` serves the uniqueness check, `collection` the
 * listing filter, `owner` with `collection` the shared-owner warning; `jobs`
 * `["templateId", "createdAt"]` lists a template's jobs newest first. `schedules` holds the
 * schedules (M6b): `name` serves the uniqueness check, `templateId` and `sourceId` the in-use
 * checks of `templates/delete` and `sources/delete`; `jobs` `["scheduled", "status", "createdAt"]`
 * serves the pump's finalization and batch queries, `["feedSourceId", "status"]` the busy check
 * (plan Ruling 2).
 */
export const STORAGE = {
	jobs: {
		indexes: [
			"status",
			"createdAt",
			"uploadId",
			"sourceUploadId",
			["templateId", "createdAt"],
			["scheduled", "status", "createdAt"],
			["feedSourceId", "status"],
		],
	},
	templates: { indexes: ["name", "collection", "owner"] },
	records: {
		indexes: [
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
			["jobId", "sourceKey"],
		],
	},
	// M5c: the missing phase pages an owner's links in the template's collection and locale.
	links: { indexes: ["entryId", ["owner", "collection", "locale"]] },
	sources: { indexes: ["name", "createdAt"] },
	media: { indexes: ["jobId", "mediaId"] },
	journal: { indexes: ["jobId", ["jobId", "seq"]] },
	journalMedia: { indexes: ["jobId", ["jobId", "seq"]] },
	schedules: { indexes: ["name", "templateId", "sourceId"] },
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
		// so no network capability is declared. content:restore (M5c) is declared for disclosure
		// too: a rollback of the missing phase restores trashed entries through the runtime's
		// handleContentRestore, not ctx.content (emdash src/plugins/manifest-schema.ts:37).
		// users:read (M6b) gates ctx.users, used for one check only: before each scheduled launch,
		// the user who armed the schedule must still exist and hold import:execute (spec Ruling
		// 43). It cannot see whether a user is disabled (spec F13).
		capabilities: [
			"content:read",
			"content:write",
			"content:publish",
			"content:restore",
			"schema:read",
			"taxonomies:write",
			"bylines:read",
			"media:write",
			"users:read",
		],
		storage: STORAGE,
		routes,
		// M6c: six routes as MCP tools. An Administrator enables them once ("Agent access");
		// tokens need mcp:tools:flux-import or mcp:tools, and the routes still need Admin.
		mcp: { tools: MCP_TOOLS },
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
						"Job records and staged source files older than this are deleted hourly. 0 deletes them at the next hourly run.",
					default: RETENTION_DAYS_DEFAULT,
					min: 0,
					max: 3650,
				},
			},
		},
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await activate(ctx);
			},
			cron: {
				timeout: CRON_HOOK_TIMEOUT_MS,
				handler: (event, ctx) => cronHook(event, ctx),
			},
		},
	});
}
