import type { PluginStorageConfig } from "emdash";
import { definePlugin } from "emdash";
import { FLUX_IMPORTER_ID, FLUX_IMPORTER_VERSION } from "../meta.js";
import { MCP_TOOLS } from "./mcp.js";
import { RETENTION_DAYS_DEFAULT } from "./retention.js";
import { routes } from "./routes.js";
import { activate, CRON_HOOK_TIMEOUT_MS, cronHook } from "./scheduler.js";

export type FluxImporterOptions = Record<string, never>;

/** The `aiProvider` description: what a suggestion sends (M6d spec "Disclosure text"). */
const AI_DISCLOSURE =
	"When set, Suggest mapping sends to this provider: the target collection's name and label; the names, labels, types, required flags and short option lists of the fields name matching did not settle; the column or path names of the sample; and up to 5 sample records, each value cut to 200 characters, fewer when the data is large. With Anthropic, the SDK also sends its client details (SDK version, OS, runtime). It never sends IDs, source URLs, credentials or user details. The provider's own data policy applies. At most 30 suggestions an hour use the provider; name matching is always available.";
/** The `aiApiKey` description (spec Ruling 67). */
const AI_KEY_DESCRIPTION =
	"The key for the provider above. Stored encrypted; needs EMDASH_ENCRYPTION_KEY. Clear it here to remove it. Use a key you can revoke, with a spending limit: with claude-opus-5-5 one suggestion can cost up to about $0.40, billed even when it times out.";

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
 * (plan Ruling 2). `jobs` `["dryRun", "createdAt"]` serves `jobs/summaries` and
 * `jobs/clear-dry-runs` (M7b), built by EmDash at its first scheduler tick (Fact V3). `records`
 * `["jobId", "facet", "seq"]` serves `jobs/records`' `facet` filter (Preview's "Will change" and
 * "Warnings"): plugin storage filters on indexed fields only, and one combined field keeps it to
 * one more index on `_plugin_storage`, whose indexes cover every plugin's rows.
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
			["dryRun", "createdAt"],
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
			["jobId", "facet", "seq"],
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

export function createPlugin(_options: FluxImporterOptions = {}) {
	return definePlugin({
		id: FLUX_IMPORTER_ID,
		version: FLUX_IMPORTER_VERSION,
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
		// handleMediaUpload, not ctx.media. network:request:unrestricted (M6d) is declared for
		// disclosure: fluximporter fetches Admin-supplied URLs on any public host (URL sources,
		// media, and the AI provider's base URL), all with the runtime's own fetch() behind the
		// plugin's SSRF guard in src/sources/net.ts. ctx.http is not used, so the capability gates
		// nothing here (M6d spec Rulings 42, 48, 49). It also lets plugin admin pages load images
		// from any host. content:restore (M5c) is declared for disclosure
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
			"network:request:unrestricted",
		],
		storage: STORAGE,
		routes,
		// Eight routes as MCP tools: M6c's six and M6d's list_sources and list_schedules. An
		// Administrator enables them once ("Agent access"); tokens need mcp:tools:fluximporter or
		// mcp:tools, and the routes still need Admin.
		mcp: { tools: MCP_TOOLS },
		admin: {
			// M7a: trusted React pages. `entry` equals the descriptor's `adminEntry`, and the
			// module's `pages` export keys the same paths (docs "React admin extensions":
			// https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/). M7b: the
			// Imports home, then the wizard as New import, in one "Imports" sidebar folder; the home
			// comes first, so the plugin's root opens it (Fact V1).
			entry: "@fluximporter/emdash/admin",
			pages: [
				{ path: "/imports", label: "Imports", icon: "clock-counter-clockwise", group: "Imports" },
				{ path: "/import", label: "New import", icon: "upload-simple", group: "Imports" },
			],
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
				// M6d: mapping suggestions (spec "Settings"); the defaults are applied at read.
				aiProvider: {
					type: "select",
					label: "Mapping suggestions",
					description: AI_DISCLOSURE,
					options: [
						{ value: "none", label: "None (name matching only)" },
						{ value: "anthropic", label: "Anthropic (Claude)" },
						{ value: "openai-compatible", label: "OpenAI-compatible endpoint" },
					],
					default: "none",
				},
				aiApiKey: {
					type: "secret",
					label: "Provider API key",
					description: AI_KEY_DESCRIPTION,
				},
				aiModel: {
					type: "string",
					label: "Model",
					description:
						"Leave empty to use claude-opus-5-5 with Anthropic. Required for an OpenAI-compatible endpoint, as that endpoint names it.",
					default: "",
				},
				aiBaseUrl: {
					type: "url",
					label: "OpenAI-compatible base URL",
					description:
						"Only for an OpenAI-compatible endpoint: the URL before /chat/completions. Must be https on a public host. The endpoint must support JSON-schema response formats.",
					placeholder: "https://api.example.com/v1",
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
