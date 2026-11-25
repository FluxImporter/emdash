import type { Field } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import type { Fence } from "../emdash/fence.js";
import type { Job, RecordRow, RecordStatus } from "../engine/types.js";
import type { CredentialInfo } from "../plugin/credentials.js";
import type {
	CreateScheduleInput,
	ScheduleView,
	UpdateScheduleInput,
} from "../plugin/schedules.js";
import type { ApplyResult, FieldRequest } from "../plugin/schema-apply.js";
import type { Page } from "../plugin/service.js";
import type { FetchOutcome, SourceRow } from "../plugin/sources.js";
import type { SuggestReply } from "../plugin/suggest.js";
import type { ClearDryRunsReply, JobListItem } from "../plugin/summaries.js";
import type { TemplateFile } from "../plugin/template-files.js";
import type { SavedResult, SavedTemplate, TemplateSummary } from "../plugin/templates.js";
import type { CsvSample } from "../sources/csv.js";
import type { SourceFormat, ValueSample } from "../sources/reader.js";
import { ApiError, readError } from "./api-error.js";
import type { CreateJobInput, SchemaField, SiteInfo, SourceBlock, TaxonomyInfo } from "./types.js";

/**
 * The admin's calls: one typed function per route the wizard uses, over `apiFetch` (which sets
 * `X-EmDash-Request: 1` on every request, GETs included, Fact D2). Failures are read with
 * `readError`, so the code survives (plan Ruling 3); successes are unwrapped by `parseApiResponse`.
 */

export const PLUGIN_BASE = "/_emdash/api/plugins/flux-import";
export const UPLOAD_URL = "/_emdash/api/flux-import/uploads";

const MANIFEST_URL = "/_emdash/api/manifest";
const SCHEMA_URL = "/_emdash/api/schema/collections";
/** `SOURCE_ID_FIELD` (`src/engine/template.ts`): never offered as a target (plan Ruling 5). */
const SOURCE_ID_FIELD = "flux_source_id";
/** EmDash's own default when the manifest names no locale (`getManifest`'s `contentLocale`). */
const EMDASH_DEFAULT_LOCALE = "en";

/** The response's data, or the `ApiError` its envelope describes. */
async function unwrap<T>(res: Response): Promise<T> {
	if (!res.ok) throw await readError(res);
	return parseApiResponse<T>(res);
}

/** POSTs `input` as JSON to a plugin route and returns its data. */
export async function callRoute<T>(
	route: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const res = await apiFetch(`${PLUGIN_BASE}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
		signal: signal ?? null,
	});
	return unwrap<T>(res);
}

/** GETs one of EmDash's own reads and returns its data. */
async function getJson<T>(url: string): Promise<T> {
	return unwrap<T>(await apiFetch(url));
}

/** What `fetch` rejects with on an abort: the signal's reason, an `AbortError` by default. */
const abortReason = (signal: AbortSignal): unknown =>
	signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/**
 * Uploads a file to the trusted upload route with `XMLHttpRequest`, for its upload progress
 * (Fact V6). A network error rejects with a `TypeError`, as `fetch` does; an abort with the
 * signal's reason.
 */
export function uploadFile(
	file: File,
	opts: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ uploadId: string; bytes: number }> {
	const { onProgress, signal } = opts;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		const xhr = new XMLHttpRequest();
		const onAbort = () => xhr.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const done = () => signal?.removeEventListener("abort", onAbort);
		xhr.open("POST", `${UPLOAD_URL}?filename=${encodeURIComponent(file.name)}`);
		xhr.setRequestHeader("X-EmDash-Request", "1");
		if (onProgress) {
			xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
		}
		xhr.onload = () => {
			done();
			let res: Response;
			try {
				res = new Response(xhr.responseText, {
					status: xhr.status,
					statusText: xhr.statusText,
				});
			} catch {
				// A status `Response` refuses (outside 200-599, or a null-body status with a body).
				const message = xhr.statusText || `HTTP ${xhr.status}`;
				reject(new ApiError(`HTTP_${xhr.status}`, message, xhr.status));
				return;
			}
			unwrap<{ uploadId: string; bytes: number }>(res).then(resolve, reject);
		};
		xhr.onerror = () => {
			done();
			reject(new TypeError("The upload failed: network error"));
		};
		xhr.onabort = () => {
			done();
			reject(signal ? abortReason(signal) : new DOMException("Aborted", "AbortError"));
		};
		xhr.send(file);
	});
}

/** The manifest's parts the wizard reads (Fact V1; emdash `EmDashManifest`). */
interface Manifest {
	collections: Record<string, { label: string; hidden?: boolean }>;
	i18n?: { defaultLocale: string; locales: string[] };
	contentLocale?: { defaultLocale: string };
	taxonomies: {
		name: string;
		label: string;
		hierarchical: boolean;
		collections: string[];
		locale: string;
	}[];
}

/**
 * One taxonomy per name (preflight F17): the manifest lists a definition per locale. The label
 * and `hierarchical` come from the default locale's row, else the first; collections are unioned.
 */
function taxonomies(rows: Manifest["taxonomies"], defaultLocale: string): TaxonomyInfo[] {
	const byName = new Map<string, Manifest["taxonomies"]>();
	for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
	return [...byName.entries()].map(([name, group]) => {
		const main = group.find((r) => r.locale === defaultLocale) ?? group[0]!;
		const collections = [...new Set(group.flatMap((r) => r.collections))].sort();
		return { name, label: main.label, hierarchical: main.hierarchical, collections };
	});
}

/** The site's collections, locales and taxonomies, from the manifest (plan Ruling 5). */
function toSiteInfo(m: Manifest): SiteInfo {
	const defaultLocale =
		m.i18n?.defaultLocale ?? m.contentLocale?.defaultLocale ?? EMDASH_DEFAULT_LOCALE;
	return {
		collections: Object.entries(m.collections).map(([slug, c]) => ({
			slug,
			label: c.label,
			hidden: c.hidden === true,
		})),
		locales: m.i18n?.locales ?? [defaultLocale],
		defaultLocale,
		taxonomies: taxonomies(m.taxonomies, defaultLocale),
	};
}

type FieldRow = Pick<
	Field,
	| "slug"
	| "label"
	| "type"
	| "required"
	| "defaultValue"
	| "validation"
	| "sortOrder"
	| "translatable"
	| "unsupportedType"
>;

/** A schema API field row as the wizard sees it (preflight F6). */
function toSchemaField(f: FieldRow): SchemaField {
	const options = f.validation?.options;
	const relation = f.validation?.relation;
	const target = f.validation?.targetCollection;
	return {
		slug: f.slug,
		label: f.label,
		type: f.type,
		required: f.required,
		...(Array.isArray(options) ? { options } : {}),
		hasDefault: f.defaultValue !== undefined,
		translatable: f.translatable !== false,
		unsupported: f.unsupportedType !== undefined,
		...(f.type === "reference"
			? {
					reference: {
						// The engine finds no target collection in "" either.
						target: typeof target === "string" && target.length > 0 ? target : null,
						bound: typeof relation === "string" && relation.length > 0,
					},
				}
			: {}),
	};
}

/** A `schema/apply` field: the route's strict schema refuses the template-mode keys. */
export type ApplyField = Omit<FieldRequest, "accepts" | "ignoreCase">;

type ById = { id: string };

export const api = {
	sample: (i: { uploadId: string; n?: number; source?: SourceBlock }) =>
		callRoute<CsvSample | ValueSample>("sources/sample", i),
	paste: (i: { format: Exclude<SourceFormat, "xlsx">; text: string }) =>
		callRoute<{ uploadId: string; bytes: number }>("sources/paste", i),
	uploadFile,
	credentials: () => callRoute<CredentialInfo[]>("credentials/list", {}),
	createSource: (i: { name: string; url: string; credential?: string }) =>
		callRoute<SourceRow>("sources/create", i),
	fetchSource: (i: { id: string; force?: boolean }) => callRoute<FetchOutcome>("sources/fetch", i),
	listSources: (i: { cursor?: string }, signal?: AbortSignal) =>
		callRoute<Page<SourceRow>>("sources/list", i, signal),
	listTemplates: (i: { collection?: string; cursor?: string }, signal?: AbortSignal) =>
		callRoute<Page<TemplateSummary>>("templates/list", i, signal),
	getTemplate: (i: ById) => callRoute<SavedTemplate>("templates/get", i),
	createTemplate: (i: { name: string; template: unknown }) =>
		callRoute<SavedResult>("templates/create", i),
	/** The wizard sends `template`; the Templates tab renames and describes (`null` clears). */
	updateTemplate: (i: {
		id: string;
		revision: number;
		name?: string;
		description?: string | null;
		template?: unknown;
	}) => callRoute<SavedResult>("templates/update", i),
	deleteTemplate: (i: { id: string; revision: number }) =>
		callRoute<{ deleted: true }>("templates/delete", i),
	exportTemplate: (i: ById) =>
		callRoute<{ filename: string; file: TemplateFile }>("templates/export", i),
	importTemplate: (i: { file: unknown; name?: string; owner?: string }) =>
		callRoute<SavedResult>("templates/import", i),
	updateSource: (i: { id: string; name?: string; url?: string; credential?: string | null }) =>
		callRoute<SourceRow>("sources/update", i),
	deleteSource: (i: ById) => callRoute<{ deleted: true }>("sources/delete", i),
	setCredential: (i: { name: string; header: string; value: string }) =>
		callRoute<CredentialInfo>("credentials/set", i),
	deleteCredential: (i: { name: string }) => callRoute<{ deleted: true }>("credentials/delete", i),
	listSchedules: (i: { cursor?: string }, signal?: AbortSignal) =>
		callRoute<Page<ScheduleView>>("schedules/list", i, signal),
	createSchedule: (i: CreateScheduleInput) =>
		callRoute<{ schedule: ScheduleView }>("schedules/create", i),
	updateSchedule: (i: UpdateScheduleInput) =>
		callRoute<{ schedule: ScheduleView }>("schedules/update", i),
	deleteSchedule: (i: { id: string; revision: number }) =>
		callRoute<{ deleted: true }>("schedules/delete", i),
	runSchedule: (i: { id: string; force?: boolean }) =>
		callRoute<{ queued: true; schedule: ScheduleView }>("schedules/run", i),
	fence: () => callRoute<{ fence: Fence }>("schedules/fence", {}),
	/**
	 * Never sends `ai`: the route then uses the configured provider, if any, and warns of nothing
	 * when the setting is "none" (spec "Suggestions"). The body is built field by field.
	 */
	suggest: (i: { collection: string; locale: string; uploadId: string; source?: SourceBlock }) =>
		callRoute<SuggestReply>("templates/suggest", {
			collection: i.collection,
			locale: i.locale,
			uploadId: i.uploadId,
			...(i.source === undefined ? {} : { source: i.source }),
		}),
	applySchema: (i: { collection: string; fields: ApplyField[]; dryRun: boolean }) =>
		callRoute<ApplyResult>("schema/apply", i),
	createJob: (i: CreateJobInput) => callRoute<Job>("jobs/create", i),
	next: (i: ById) => callRoute<Job>("jobs/next", i),
	getJob: (i: ById) => callRoute<Job>("jobs/get", i),
	pause: (i: ById) => callRoute<Job>("jobs/pause", i),
	resume: (i: ById) => callRoute<Job>("jobs/resume", i),
	cancel: (i: ById) => callRoute<Job>("jobs/cancel", i),
	retry: (i: ById) => callRoute<Job>("jobs/retry", i),
	records: (i: { id: string; status?: RecordStatus; cursor?: string }) =>
		callRoute<Page<RecordRow>>("jobs/records", i),
	/** One page of the Jobs table: real imports, or the dry runs (`jobs/summaries`, never `jobs/list`). */
	jobSummaries: (i: { dryRun: boolean; cursor?: string }, signal?: AbortSignal) =>
		callRoute<Page<JobListItem>>("jobs/summaries", i, signal),
	/** One bounded step of clearing the dry runs; the caller repeats it while `more`. */
	clearDryRuns: (i: { cursor?: string }) =>
		callRoute<ClearDryRunsReply>(
			"jobs/clear-dry-runs",
			i.cursor === undefined ? {} : { cursor: i.cursor },
		),
	rollback: (i: { id: string; dryRun: boolean }) => callRoute<Job>("jobs/rollback", i),
	/** `GET /_emdash/api/manifest` (any signed-in user), mapped (plan Ruling 5). */
	site: async (): Promise<SiteInfo> => toSiteInfo(await getJson<Manifest>(MANIFEST_URL)),
	/**
	 * A collection's fields from the schema API (`schema:read`), in `sortOrder`, without
	 * `flux_source_id`.
	 */
	collection: async (slug: string): Promise<SchemaField[]> => {
		const url = `${SCHEMA_URL}/${encodeURIComponent(slug)}?includeFields=true`;
		const { item } = await getJson<{ item: { fields: FieldRow[] } }>(url);
		return item.fields
			.filter((f) => f.slug !== SOURCE_ID_FIELD)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map(toSchemaField);
	},
};

/** The file name in a `content-disposition` header, if it names one. */
function dispositionName(header: string | null): string | null {
	const match = header === null ? null : /filename="([^"]+)"|filename=([^;\s]+)/i.exec(header);
	return match?.[1] ?? match?.[2] ?? null;
}

/**
 * Downloads a job's log CSV (plan Ruling 4). The route needs the CSRF header on its GET (Fact
 * D2), so a plain link cannot fetch it: it is read through `apiFetch` and saved from a `Blob`.
 */
export async function downloadLog(id: string, status?: "failed"): Promise<void> {
	const query = new URLSearchParams({ id, ...(status === undefined ? {} : { status }) });
	const res = await apiFetch(`${PLUGIN_BASE}/jobs/log.csv?${query}`);
	if (!res.ok) throw await readError(res);
	const name = dispositionName(res.headers.get("content-disposition")) ?? `flux-import-${id}.csv`;
	saveBlob(await res.blob(), name);
}

/** Saves `blob` as a download named `name`, through a temporary link. */
function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = name;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		// After the click has been handled: some browsers lose a download revoked at once.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

/** Saves `value` as pretty JSON under `filename` (plan Ruling 17), as `downloadLog` saves a log. */
export function saveJson(value: unknown, filename: string): void {
	saveBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), filename);
}
