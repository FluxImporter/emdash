import { afterEach, describe, expect, it, vi } from "vitest";
import {
	api,
	callRoute,
	downloadLog,
	PLUGIN_BASE,
	saveJson,
	UPLOAD_URL,
	uploadFile,
} from "../../src/admin/api.js";
import { ApiError } from "../../src/admin/api-error.js";
import type { CreateJobInput } from "../../src/admin/types.js";
import { SOURCE_ID_FIELD } from "../../src/engine/template.js";
import { routes } from "../../src/plugin/routes.js";
import { MANIFEST, UPLOAD_ID } from "../admin/fixtures.js";

/** Requests the stubbed `fetch` saw. */
interface Sent {
	url: string;
	method: string;
	csrf: string | null;
	contentType: string | null;
	body: unknown;
}

/** Stubs `fetch` to answer every request with `status` and `body` (JSON), recording each one. */
function stub(status: number, body: unknown, headers: Record<string, string> = {}): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
		const h = new Headers(init.headers);
		sent.push({
			url: input,
			method: init.method ?? "GET",
			csrf: h.get("X-EmDash-Request"),
			contentType: h.get("content-type"),
			body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
		});
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return new Response(text, {
			status,
			headers: { "content-type": "application/json", ...headers },
		});
	});
	return sent;
}

const ok = (data: unknown) => stub(200, { success: true, data });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const JOB_INPUT: CreateJobInput = {
	uploadId: UPLOAD_ID,
	dryRun: true,
	template: { version: 1, collection: "posts", locale: "en", key: { from: "id" }, fields: {} },
	publish: false,
	journal: true,
	origin: "wizard",
};

/**
 * One sample call per route-backed `api` function, keyed by the route it must reach. Each body is
 * parsed with that route's own input schema.
 */
const ROUTE_INPUTS: Record<string, [method: keyof typeof api, call: () => Promise<unknown>]> = {
	"sources/sample": [
		"sample",
		() => api.sample({ uploadId: UPLOAD_ID, n: 20, source: { format: "json", records: "items" } }),
	],
	"sources/paste": ["paste", () => api.paste({ format: "csv", text: "id,title\n1,A\n" })],
	"credentials/list": ["credentials", () => api.credentials()],
	"sources/create": [
		"createSource",
		() => api.createSource({ name: "Feed", url: "https://example.com/feed.json", credential: "c" }),
	],
	"sources/fetch": ["fetchSource", () => api.fetchSource({ id: "S1", force: true })],
	"sources/list": ["listSources", () => api.listSources({ cursor: "c1" })],
	"templates/list": [
		"listTemplates",
		() => api.listTemplates({ collection: "posts", cursor: "c1" }),
	],
	"templates/get": ["getTemplate", () => api.getTemplate({ id: "T1" })],
	"templates/create": [
		"createTemplate",
		() => api.createTemplate({ name: "Posts feed", template: JOB_INPUT.template }),
	],
	"templates/update": [
		"updateTemplate",
		() => api.updateTemplate({ id: "T1", revision: 2, template: JOB_INPUT.template }),
	],
	"templates/suggest": [
		"suggest",
		() =>
			api.suggest({
				collection: "posts",
				locale: "en",
				uploadId: UPLOAD_ID,
				source: { format: "csv" },
			}),
	],
	"schema/apply": [
		"applySchema",
		() =>
			api.applySchema({
				collection: "posts",
				fields: [{ slug: "price", type: "number", label: "Price", translatable: false }],
				dryRun: true,
			}),
	],
	"jobs/create": ["createJob", () => api.createJob(JOB_INPUT)],
	"jobs/next": ["next", () => api.next({ id: "J1" })],
	"jobs/get": ["getJob", () => api.getJob({ id: "J1" })],
	"jobs/pause": ["pause", () => api.pause({ id: "J1" })],
	"jobs/resume": ["resume", () => api.resume({ id: "J1" })],
	"jobs/cancel": ["cancel", () => api.cancel({ id: "J1" })],
	"jobs/retry": ["retry", () => api.retry({ id: "J1" })],
	"jobs/records": ["records", () => api.records({ id: "J1", status: "failed", cursor: "c1" })],
	"jobs/summaries": ["jobSummaries", () => api.jobSummaries({ dryRun: true, cursor: "c1" })],
	"jobs/clear-dry-runs": ["clearDryRuns", () => api.clearDryRuns({ cursor: "c1" })],
	"jobs/rollback": ["rollback", () => api.rollback({ id: "J1", dryRun: false })],
	"templates/delete": ["deleteTemplate", () => api.deleteTemplate({ id: "T1", revision: 3 })],
	"templates/export": ["exportTemplate", () => api.exportTemplate({ id: "T1" })],
	"templates/import": [
		"importTemplate",
		() => api.importTemplate({ file: { format: "x" }, name: "Copy", owner: "posts-feed" }),
	],
	"sources/update": [
		"updateSource",
		() =>
			api.updateSource({
				id: "S1",
				name: "Feed",
				url: "https://example.com/f.json",
				credential: null,
			}),
	],
	"sources/delete": ["deleteSource", () => api.deleteSource({ id: "S1" })],
	"credentials/set": [
		"setCredential",
		() => api.setCredential({ name: "feed-key", header: "Authorization", value: "Bearer x" }),
	],
	"credentials/delete": ["deleteCredential", () => api.deleteCredential({ name: "feed-key" })],
	"schedules/list": ["listSchedules", () => api.listSchedules({ cursor: "c1" })],
	"schedules/create": [
		"createSchedule",
		() =>
			api.createSchedule({
				name: "Nightly",
				templateId: "T1",
				templateRevision: 2,
				sourceId: "S1",
				cron: "0 3 * * *",
				batchSize: 100,
				missing: { maxPercent: 10 },
			}),
	],
	"schedules/update": [
		"updateSchedule",
		() => api.updateSchedule({ id: "SC1", revision: 2, enabled: true, missing: null }),
	],
	"schedules/delete": ["deleteSchedule", () => api.deleteSchedule({ id: "SC1", revision: 2 })],
	"schedules/run": ["runSchedule", () => api.runSchedule({ id: "SC1", force: true })],
	"schedules/fence": ["fence", () => api.fence()],
};

describe("callRoute", () => {
	it("posts JSON to /_emdash/api/plugins/fluximporter/<route> with the CSRF header and unwraps data", async () => {
		const sent = ok({ id: "J1", status: "running" });
		await expect(callRoute("jobs/get", { id: "J1" })).resolves.toEqual({
			id: "J1",
			status: "running",
		});
		expect(sent).toEqual([
			{
				url: "/_emdash/api/plugins/fluximporter/jobs/get",
				method: "POST",
				csrf: "1",
				contentType: "application/json",
				body: { id: "J1" },
			},
		]);
	});

	it("throws ApiError with code, status and details from an error envelope", async () => {
		stub(400, {
			success: false,
			error: { code: "INVALID_TEMPLATE", message: "m", details: { problems: ["p"] } },
		});
		const sent = api.createJob(JOB_INPUT);
		await expect(sent).rejects.toBeInstanceOf(ApiError);
		await expect(sent).rejects.toMatchObject({
			code: "INVALID_TEMPLATE",
			status: 400,
			details: { problems: ["p"] },
		});
	});

	it("lets a fetch rejection through as it is (offline is a TypeError)", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(api.getJob({ id: "J1" })).rejects.toBeInstanceOf(TypeError);
	});

	it("passes the abort signal to fetch", async () => {
		let seen: AbortSignal | null | undefined;
		vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
			seen = init.signal;
			return Response.json({ success: true, data: {} });
		});
		const controller = new AbortController();
		await callRoute("jobs/get", { id: "J1" }, controller.signal);
		expect(seen).toBe(controller.signal);
	});
});

describe("the route adapters", () => {
	it("cover every route-backed api function", () => {
		const covered = Object.values(ROUTE_INPUTS).map(([method]) => method);
		const routeBacked = Object.keys(api).filter(
			(k) => !["site", "collection", "uploadFile"].includes(k),
		);
		expect(covered.sort()).toEqual(routeBacked.sort());
	});

	it.each(Object.keys(ROUTE_INPUTS))(
		"sends %s an input its route schema accepts",
		async (route) => {
			const sent = ok({});
			const [, call] = ROUTE_INPUTS[route]!;
			await call();
			expect(sent).toHaveLength(1);
			const [request] = sent;
			expect(request).toMatchObject({ url: `${PLUGIN_BASE}/${route}`, method: "POST", csrf: "1" });
			const schema = routes[route]?.input;
			expect(schema, `routes["${route}"].input`).toBeDefined();
			const parsed = schema!.safeParse(request!.body);
			expect(parsed.error?.issues ?? []).toEqual([]);
			expect(parsed.success).toBe(true);
		},
	);

	it("sends a widened templates/update with only what changed", async () => {
		const sent = ok({});
		await api.updateTemplate({ id: "T1", revision: 2, name: "New", description: null });
		expect(sent[0]!.body).toEqual({ id: "T1", revision: 2, name: "New", description: null });
		expect(routes["templates/update"]!.input!.safeParse(sent[0]!.body).success).toBe(true);
	});

	it("sends jobs/summaries and jobs/rollback exactly what the route takes", async () => {
		const sent = ok({});
		await api.jobSummaries({ dryRun: false });
		await api.rollback({ id: "J1", dryRun: true });
		expect(sent.map((r) => r.body)).toEqual([{ dryRun: false }, { id: "J1", dryRun: true }]);
	});

	it("passes the signal of a list read on", async () => {
		let seen: AbortSignal | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
			seen = init.signal ?? undefined;
			return new Response(JSON.stringify({ success: true, data: { items: [], hasMore: false } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const controller = new AbortController();
		await api.jobSummaries({ dryRun: false }, controller.signal);
		expect(seen).toBe(controller.signal);
		await api.listSchedules({}, controller.signal);
		expect(seen).toBe(controller.signal);
	});

	it("never sends `ai` to templates/suggest", async () => {
		const sent = ok({});
		const input = { collection: "posts", locale: "en", uploadId: UPLOAD_ID, ai: true };
		await api.suggest(input as Parameters<typeof api.suggest>[0]);
		expect(sent[0]!.body).toEqual({ collection: "posts", locale: "en", uploadId: UPLOAD_ID });
		await api.suggest({ collection: "posts", locale: "en", uploadId: UPLOAD_ID });
		expect(sent[1]!.body).not.toHaveProperty("ai");
		const source = { format: "json" as const, records: "items" };
		await api.suggest({ collection: "posts", locale: "en", uploadId: UPLOAD_ID, source });
		expect(sent[2]!.body).toEqual({
			collection: "posts",
			locale: "en",
			uploadId: UPLOAD_ID,
			source,
		});
	});

	it("exposes uploadFile on api", () => {
		expect(api.uploadFile).toBe(uploadFile);
	});
});

describe("api.site (plan Ruling 5)", () => {
	it("maps the manifest to SiteInfo: locales from i18n", async () => {
		const sent = ok(MANIFEST);
		await expect(api.site()).resolves.toEqual({
			collections: [
				{ slug: "pages", label: "Pages", hidden: false },
				{ slug: "posts", label: "Posts", hidden: false },
			],
			locales: ["en", "fr", "de"],
			defaultLocale: "en",
			taxonomies: [
				{ name: "category", label: "Categories", hierarchical: true, collections: ["posts"] },
				{ name: "tag", label: "Tags", hierarchical: false, collections: ["posts"] },
			],
		});
		expect(sent).toEqual([
			{
				url: "/_emdash/api/manifest",
				method: "GET",
				csrf: "1",
				contentType: null,
				body: undefined,
			},
		]);
	});

	it("falls back to [contentLocale.defaultLocale] without i18n, and marks hidden collections", async () => {
		ok({
			collections: { notes: { label: "Notes", hidden: true, fields: {} } },
			taxonomies: [],
			contentLocale: { defaultLocale: "fr", implicit: false },
		});
		await expect(api.site()).resolves.toEqual({
			collections: [{ slug: "notes", label: "Notes", hidden: true }],
			locales: ["fr"],
			defaultLocale: "fr",
			taxonomies: [],
		});
	});

	it("falls back to EmDash's default locale, en, when the manifest names none", async () => {
		ok({ collections: {}, taxonomies: [] });
		await expect(api.site()).resolves.toMatchObject({ locales: ["en"], defaultLocale: "en" });
	});

	it("collapses a taxonomy's per-locale rows by name (preflight F17)", async () => {
		const row = (locale: string, label: string, collections: string[]) => ({
			id: `taxdef_tag_${locale}`,
			name: "tag",
			label,
			hierarchical: false,
			collections,
			locale,
			translationGroup: "taxdef_tag",
		});
		ok({
			collections: {},
			taxonomies: [row("fr", "Étiquettes", ["pages", "posts"]), row("en", "Tags", ["posts"])],
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
			contentLocale: { defaultLocale: "en", implicit: false },
		});
		const site = await api.site();
		expect(site.taxonomies).toEqual([
			{ name: "tag", label: "Tags", hierarchical: false, collections: ["pages", "posts"] },
		]);
	});

	it("takes the first row's label when no row is in the default locale", async () => {
		const row = (locale: string, label: string, collections: string[]) => ({
			name: "tag",
			label,
			hierarchical: false,
			collections,
			locale,
		});
		ok({
			collections: {},
			taxonomies: [row("fr", "Étiquettes", ["posts"]), row("de", "Schlagwörter", ["notes"])],
			i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] },
		});
		const site = await api.site();
		expect(site.taxonomies).toEqual([
			{ name: "tag", label: "Étiquettes", hierarchical: false, collections: ["notes", "posts"] },
		]);
	});

	it("throws ApiError when the manifest read fails", async () => {
		stub(500, { success: false, error: { code: "MANIFEST_BUILD_ERROR", message: "x" } });
		await expect(api.site()).rejects.toMatchObject({ code: "MANIFEST_BUILD_ERROR", status: 500 });
	});
});

/** A schema API field row, as `GET …/schema/collections/<slug>?includeFields=true` returns it. */
function fieldRow(slug: string, type: string, sortOrder: number, over: object = {}) {
	return {
		id: `f_${slug}`,
		collectionId: "c_posts",
		slug,
		label: slug.toUpperCase(),
		type,
		columnType: "TEXT",
		required: false,
		unique: false,
		sortOrder,
		searchable: false,
		indexed: false,
		translatable: true,
		createdAt: "2026-11-23 15:33:09",
		...over,
	};
}

describe("api.collection (preflight F6)", () => {
	it("reads fields in sortOrder without flux_source_id, options from validation.options", async () => {
		const sent = ok({
			item: {
				slug: "posts",
				label: "Posts",
				fields: [
					fieldRow("status_label", "select", 3, {
						validation: { options: ["draft", "live"] },
						required: true,
						defaultValue: "draft",
					}),
					fieldRow(SOURCE_ID_FIELD, "string", 4, { translatable: false, indexed: true }),
					fieldRow("title", "string", 0, { required: true }),
					fieldRow("author", "reference", 2, {
						validation: { relation: "post_author", targetCollection: "people" },
					}),
					fieldRow("related", "reference", 5, { validation: { relation: "" } }),
					fieldRow("sku", "string", 1, { translatable: false, defaultValue: null }),
					fieldRow("layout", "string", 6, {
						unsupportedType: { type: "hologram", path: "type" },
					}),
				],
			},
		});
		const fields = await api.collection("posts");
		expect(sent).toEqual([
			{
				url: "/_emdash/api/schema/collections/posts?includeFields=true",
				method: "GET",
				csrf: "1",
				contentType: null,
				body: undefined,
			},
		]);
		expect(fields).toEqual([
			{
				slug: "title",
				label: "TITLE",
				type: "string",
				required: true,
				hasDefault: false,
				translatable: true,
				unsupported: false,
			},
			{
				slug: "sku",
				label: "SKU",
				type: "string",
				required: false,
				hasDefault: true,
				translatable: false,
				unsupported: false,
			},
			{
				slug: "author",
				label: "AUTHOR",
				type: "reference",
				required: false,
				hasDefault: false,
				translatable: true,
				unsupported: false,
				reference: { target: "people", bound: true },
			},
			{
				slug: "status_label",
				label: "STATUS_LABEL",
				type: "select",
				required: true,
				options: ["draft", "live"],
				hasDefault: true,
				translatable: true,
				unsupported: false,
			},
			{
				slug: "related",
				label: "RELATED",
				type: "reference",
				required: false,
				hasDefault: false,
				translatable: true,
				unsupported: false,
				reference: { target: null, bound: false },
			},
			{
				slug: "layout",
				label: "LAYOUT",
				type: "string",
				required: false,
				hasDefault: false,
				translatable: true,
				unsupported: true,
			},
		]);
	});

	it("maps an empty targetCollection to no target", async () => {
		ok({
			item: {
				fields: [
					fieldRow("editor", "reference", 0, {
						validation: { relation: "post_editor", targetCollection: "" },
					}),
				],
			},
		});
		const [editor] = await api.collection("posts");
		expect(editor?.reference).toEqual({ target: null, bound: true });
	});

	it("encodes the collection slug and throws ApiError when the read fails", async () => {
		const sent = stub(404, {
			success: false,
			error: { code: "NOT_FOUND", message: "Collection not found: a/b" },
		});
		await expect(api.collection("a/b")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(sent[0]!.url).toBe("/_emdash/api/schema/collections/a%2Fb?includeFields=true");
	});
});

/** A fake `XMLHttpRequest` the test drives: `progress`, `respond`, `fail`. */
class FakeXhr {
	static last: FakeXhr | null = null;
	readonly upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
	readonly headers = new Map<string, string>();
	method = "";
	url = "";
	body: unknown = undefined;
	status = 0;
	statusText = "";
	responseText = "";
	aborted = false;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	onloadend: (() => void) | null = null;

	constructor() {
		FakeXhr.last = this;
	}

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name, value);
	}

	send(body: unknown) {
		this.body = body;
	}

	abort() {
		this.aborted = true;
		this.onabort?.();
		this.onloadend?.();
	}

	progress(loaded: number, total: number, lengthComputable = true) {
		this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
	}

	respond(status: number, body: unknown) {
		this.status = status;
		this.responseText = JSON.stringify(body);
		this.onload?.();
		this.onloadend?.();
	}

	fail() {
		this.onerror?.();
		this.onloadend?.();
	}
}

/** Starts an upload against a fresh fake XHR; returns the promise and the request. */
function startUpload(file: File, opts?: Parameters<typeof uploadFile>[1]) {
	FakeXhr.last = null;
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
	const result = uploadFile(file, opts);
	return { result, xhr: FakeXhr.last as FakeXhr | null };
}

describe("uploadFile", () => {
	it("uploads with XMLHttpRequest: filename query, CSRF header, progress, 201 data", async () => {
		const file = new File(["id,title\n1,A\n"], "my posts.csv", { type: "text/csv" });
		const onProgress = vi.fn();
		const { result, xhr } = startUpload(file, { onProgress });
		expect(xhr).not.toBeNull();
		expect(xhr!.method).toBe("POST");
		expect(xhr!.url).toBe(`${UPLOAD_URL}?filename=my%20posts.csv`);
		expect(UPLOAD_URL).toBe("/_emdash/api/fluximporter/uploads");
		expect(xhr!.headers.get("X-EmDash-Request")).toBe("1");
		expect(xhr!.body).toBe(file);
		xhr!.progress(6, 13);
		xhr!.progress(13, 13);
		expect(onProgress.mock.calls).toEqual([
			[6, 13],
			[13, 13],
		]);
		const data = { uploadId: UPLOAD_ID, bytes: 13, sha256: "a".repeat(64) };
		xhr!.respond(201, { success: true, data });
		await expect(result).resolves.toEqual(data);
	});

	it("rejects an upload with ApiError from the error envelope (UNSUPPORTED_SOURCE 415)", async () => {
		const { result, xhr } = startUpload(new File(["x"], "notes.txt"));
		xhr!.respond(415, {
			success: false,
			error: { code: "UNSUPPORTED_SOURCE", message: "filename must name a .csv … file" },
		});
		await expect(result).rejects.toBeInstanceOf(ApiError);
		await expect(result).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE", status: 415 });
	});

	it("reports the file's size as the total when the progress length is not computable", () => {
		const file = new File(["id,title\n1,A\n"], "posts.csv");
		const onProgress = vi.fn();
		const { xhr } = startUpload(file, { onProgress });
		xhr!.progress(4, 0, false);
		expect(onProgress.mock.calls).toEqual([[4, file.size]]);
	});

	it.each([
		[204, "a null-body status with a body"],
		[600, "a status outside 200-599"],
	])("rejects with ApiError HTTP_%i on %s, without throwing from onload", async (status) => {
		const { result, xhr } = startUpload(new File(["x"], "posts.csv"));
		expect(() => xhr!.respond(status, { success: true, data: {} })).not.toThrow();
		await expect(result).rejects.toBeInstanceOf(ApiError);
		await expect(result).rejects.toMatchObject({ code: `HTTP_${status}`, status });
	});

	it("rejects with a TypeError on a network error", async () => {
		const { result, xhr } = startUpload(new File(["x"], "posts.csv"));
		xhr!.fail();
		await expect(result).rejects.toBeInstanceOf(TypeError);
	});

	it("aborts the request when the signal aborts, rejecting with an AbortError", async () => {
		const controller = new AbortController();
		const { result, xhr } = startUpload(new File(["x"], "posts.csv"), {
			signal: controller.signal,
		});
		controller.abort();
		expect(xhr!.aborted).toBe(true);
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
	});

	it("sends nothing when the signal has already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { result, xhr } = startUpload(new File(["x"], "posts.csv"), {
			signal: controller.signal,
		});
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(xhr?.body).toBeUndefined();
	});
});

describe("downloadLog (plan Ruling 4)", () => {
	/** Stubs the DOM pieces `downloadLog` uses; returns the anchor it creates. */
	function fakeDocument() {
		const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
		const append = vi.fn();
		vi.stubGlobal("document", {
			createElement: (tag: string) => {
				expect(tag).toBe("a");
				return anchor;
			},
			body: { append },
		});
		const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:log");
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		return { anchor, append, create, revoke };
	}

	function stubCsv(disposition: string | null) {
		const sent: { url: string; method: string; csrf: string | null }[] = [];
		vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
			sent.push({
				url: input,
				method: init.method ?? "GET",
				csrf: new Headers(init.headers).get("X-EmDash-Request"),
			});
			const headers: Record<string, string> = { "content-type": "text/csv; charset=utf-8" };
			if (disposition !== null) headers["content-disposition"] = disposition;
			return new Response("record,status\n1,failed\n", { status: 200, headers });
		});
		return sent;
	}

	it("downloads the log through apiFetch as a blob, named from content-disposition", async () => {
		const sent = stubCsv('attachment; filename="fluximporter-J.csv"');
		const { anchor, append, create, revoke } = fakeDocument();
		await downloadLog("J", "failed");
		expect(sent).toEqual([
			{ url: `${PLUGIN_BASE}/jobs/log.csv?id=J&status=failed`, method: "GET", csrf: "1" },
		]);
		const blob = create.mock.calls[0]![0] as Blob;
		expect(await blob.text()).toBe("record,status\n1,failed\n");
		expect(anchor.href).toBe("blob:log");
		expect(anchor.download).toBe("fluximporter-J.csv");
		expect(append).toHaveBeenCalledWith(anchor);
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(anchor.remove).toHaveBeenCalledOnce();
		// Revoked only after the click has been handled, on the next task.
		expect(revoke).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 0));
		expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:log");
	});

	it("takes the server's file name, and falls back to fluximporter-<id>.csv", async () => {
		stubCsv('attachment; filename="server-name.csv"');
		const first = fakeDocument();
		await downloadLog("J");
		expect(first.anchor.download).toBe("server-name.csv");

		vi.restoreAllMocks();
		const sent = stubCsv(null);
		const second = fakeDocument();
		await downloadLog("K");
		expect(sent[0]!.url).toBe(`${PLUGIN_BASE}/jobs/log.csv?id=K`);
		expect(second.anchor.download).toBe("fluximporter-K.csv");
	});

	it("throws ApiError when the log cannot be read, creating no link", async () => {
		stub(404, { success: false, error: { code: "NOT_FOUND", message: "No such job" } });
		const { create } = fakeDocument();
		await expect(downloadLog("J")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(create).not.toHaveBeenCalled();
	});

	it("saves a template file as pretty JSON under its filename", async () => {
		// Let the revocations an earlier test scheduled run before this test spies on them.
		await new Promise((r) => setTimeout(r, 0));
		const { anchor, append, create, revoke } = fakeDocument();
		const file = { format: "fluximporter.template", name: "Posts feed", template: { a: 1 } };
		saveJson(file, "fluximporter-template-posts-feed.json");
		const blob = create.mock.calls[0]![0] as Blob;
		expect(blob.type).toBe("application/json");
		expect(await blob.text()).toBe(JSON.stringify(file, null, 2));
		expect(anchor.href).toBe("blob:log");
		expect(anchor.download).toBe("fluximporter-template-posts-feed.json");
		expect(append).toHaveBeenCalledWith(anchor);
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(anchor.remove).toHaveBeenCalledOnce();
		expect(revoke).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 0));
		expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:log");
	});
});
