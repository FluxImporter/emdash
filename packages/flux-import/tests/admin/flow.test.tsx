import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pages } from "../../src/admin/index.js";
import { SAMPLE_MAX } from "../../src/admin/limits.js";
import { type Template, templateSchema } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import type { SuggestReply } from "../../src/plugin/suggest.js";
import { job, MANIFEST, POSTS, sampleCsv, UPLOAD_ID } from "./fixtures.js";
import {
	fail,
	mockRoutes,
	type RouteCall,
	type RouteHandler,
	renderAdmin,
	takeViolations,
} from "./harness.js";

/**
 * The whole wizard, as EmDash mounts it (`pages["/import"]`), from the first step to a finished
 * run. Every route is mocked beneath the real `apiFetch` and upload (plan Ruling 11), one table
 * per flow; Task 15's own fixtures live here (preflight F21).
 */

const RECORDS = 10;
const KEYS = ["id", "title", "Released"];
const ROWS = Array.from({ length: RECORDS }, (_, i) => [
	String(i + 1),
	`Post ${i + 1}`,
	`2024-03-${String(i + 1).padStart(2, "0")}`,
]);

/** A schema API field row. */
const fieldRow = (slug: string, label: string, type: string, sortOrder: number) => ({
	slug,
	label,
	type,
	required: false,
	sortOrder,
	translatable: true,
});
const postsFields = () => (POSTS as { item: { fields: Record<string, unknown>[] } }).item.fields;
const collectionOf = (slug: string, label: string, fields: unknown[]) => ({
	item: { slug, label, fields },
});
const PAGES = collectionOf("pages", "Pages", [
	{ ...fieldRow("title", "Title", "string", 0), required: true },
	fieldRow("content", "Content", "portableText", 1),
]);

/**
 * `templates/suggest`'s reply by name matching: for posts, the key from `id` and the title from
 * `title`; for pages, nothing.
 */
function suggestReply(collection: string): SuggestReply {
	const none = (field: string, fieldType: string) => ({
		field,
		fieldType,
		required: false,
		from: null,
		confidence: 0,
		origin: "fallback" as const,
		rationale: "No key matched",
	});
	if (collection === "pages") {
		return {
			method: "fallback",
			ai: { available: false },
			template: null,
			key: { from: null, confidence: 0, origin: "fallback", rationale: "No key matched" },
			fields: [{ ...none("title", "string"), required: true }, none("content", "portableText")],
			unmapped: { fields: ["title", "content"], keys: KEYS },
			check: { problems: [], warnings: [] },
			warnings: [],
			sent: null,
		};
	}
	return {
		method: "fallback",
		ai: { available: false },
		template: null,
		key: { from: "id", confidence: 0.9, origin: "fallback", rationale: "Named id" },
		fields: [
			{
				field: "title",
				fieldType: "string",
				required: true,
				from: "title",
				mapping: "text",
				confidence: 0.95,
				origin: "fallback",
				rationale: "Same name",
			},
			none("featured_image", "image"),
			none("content", "portableText"),
			none("excerpt", "text"),
		],
		unmapped: { fields: ["featured_image", "content", "excerpt"], keys: ["Released"] },
		check: { problems: [], warnings: [] },
		warnings: [],
		sent: null,
	};
}

const SAVED_TEMPLATE = {
	id: "01JZ000000000000000000TPL1",
	name: "Posts from CSV",
	template: templateSchema.parse({
		version: 1,
		collection: "posts",
		locale: "en",
		key: { from: "id" },
		fields: { title: { from: "title", type: "text" } },
	}),
	revision: 3,
	collection: "posts",
	locale: "en",
	format: "csv",
	createdAt: "2026-11-23T12:00:00.000Z",
	updatedAt: "2026-11-23T12:00:00.000Z",
	createdBy: "u1",
	updatedBy: "u1",
};

interface JobBody {
	uploadId: string;
	dryRun: boolean;
	publish: boolean;
	journal: boolean;
	template?: unknown;
	templateId?: string;
	templateRevision?: number;
}

/**
 * The routes a flow meets, as a small server: an upload and its CSV sample, the site, the
 * suggestion, `schema/apply` (which adds the planned fields to the collection), and jobs that
 * finish on their first `jobs/next`. A job's template is the saved one, or the inline one as the
 * engine parses it, so a draft the engine would refuse fails the flow.
 */
function server(opts: { templates?: (typeof SAVED_TEMPLATE)[] } = {}) {
	const templates = opts.templates ?? [];
	let posts = postsFields();
	const jobs = new Map<string, Job>();
	const templateOf = (body: JobBody): Template => {
		if (body.templateId === undefined) return templateSchema.parse(body.template);
		const saved = templates.find((t) => t.id === body.templateId);
		if (saved === undefined || saved.revision !== body.templateRevision) {
			throw new Error(`No template ${body.templateId} at ${body.templateRevision}`);
		}
		return saved.template;
	};
	const table: Record<string, RouteHandler> = {
		"credentials/list": () => [],
		"sources/list": () => ({ items: [], hasMore: false }),
		"templates/list": () => ({ items: templates.map(({ template, ...s }) => s), hasMore: false }),
		"templates/get": (body) => templates.find((t) => t.id === (body as { id: string }).id),
		"templates/create": (body) => {
			const { name, template } = body as { name: string; template: unknown };
			const parsed = templateSchema.parse(template);
			const saved = {
				...SAVED_TEMPLATE,
				id: `01JZ000000000000000000TPL${templates.length + 2}`,
				name,
				template: parsed,
				revision: 1,
			};
			templates.push(saved);
			return {
				template: { ...saved, owner: parsed.rules?.owner },
				check: { problems: [], warnings: [] },
			};
		},
		upload: (body) => ({ uploadId: UPLOAD_ID, bytes: (body as File).size, sha256: "0".repeat(64) }),
		"sources/sample": () => sampleCsv(KEYS, ROWS),
		"GET manifest": () => MANIFEST,
		"GET collection:posts": () => collectionOf("posts", "Posts", posts),
		"GET collection:pages": () => PAGES,
		"templates/suggest": (body) => suggestReply((body as { collection: string }).collection),
		"schema/apply": (body) => {
			const { fields, dryRun } = body as {
				fields: { slug: string; label?: string; type: string }[];
				dryRun: boolean;
			};
			const changes = fields.map((f) => ({ field: f.slug, action: "create", type: f.type }));
			if (!dryRun) {
				posts = [
					...posts,
					...fields.map((f, i) => fieldRow(f.slug, f.label ?? f.slug, f.type, posts.length + i)),
				];
			}
			return {
				collection: "posts",
				dryRun,
				changes,
				applied: dryRun ? [] : fields.map((f) => f.slug),
				error: null,
			};
		},
		"jobs/create": (raw) => {
			const body = raw as JobBody;
			const id = `01JZ00000000000000000JOB${String(jobs.size + 1).padStart(2, "0")}`;
			const created = job({
				id,
				dryRun: body.dryRun,
				publish: body.publish,
				uploadId: body.uploadId,
				template: templateOf(body),
				columns: KEYS,
			});
			jobs.set(id, created);
			return created;
		},
		"jobs/next": (body) => {
			const stored = jobs.get((body as { id: string }).id);
			if (stored === undefined) throw new Error("No such job");
			const done: Job = {
				...stored,
				status: "completed",
				cursor: { offset: 999, seq: RECORDS },
				counters: { ...stored.counters, created: RECORDS },
			};
			jobs.set(stored.id, done);
			return done;
		},
		"jobs/records": (body) => ({
			items: [1, 2].map(
				(seq): RecordRow => ({
					jobId: (body as { id: string }).id,
					seq,
					start: 0,
					end: 0,
					status: "planned",
					sourceKey: String(seq),
					entryId: null,
					action: "create",
					changes: [{ field: "title", before: null, after: `Post ${seq}` }],
					updatedAt: "2026-11-23T12:00:00.000Z",
				}),
			),
			hasMore: false,
		}),
	};
	return table;
}

/** The routes that read a list or the site: React Query refetches them as it likes. */
const READS = new Set([
	"credentials/list",
	"sources/list",
	"templates/list",
	"GET manifest",
	"GET collection:posts",
	"GET collection:pages",
]);
/** The calls that act, in order, each with its dry-run flag where it has one. */
const actions = (calls: RouteCall[]) =>
	calls
		.filter((c) => !READS.has(c.route))
		.map((c) => {
			const body = c.body as { dryRun?: unknown };
			return typeof body?.dryRun === "boolean" ? `${c.route} dryRun:${body.dryRun}` : c.route;
		});
const bodies = (calls: RouteCall[], route: string) =>
	calls.filter((c) => c.route === route).map((c) => c.body as JobBody);

function renderPage() {
	const ImportPage = pages?.["/import"];
	if (ImportPage === undefined) throw new Error("No Import page");
	return renderAdmin(<ImportPage />);
}

const heading = (name: string) => screen.findByRole("heading", { level: 2, name });

/** A `beforeunload` the page may cancel; true when the page asked to stay. */
function unloadPrevented(): boolean {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}
const next = () => screen.getByRole("button", { name: "Next" });
const stepLink = (n: number, name: string) => screen.getByRole("link", { name: `${n} ${name}` });

/** Opens the select named `name` and picks `option`. */
async function choose(user: UserEvent, name: string | RegExp, option: string | RegExp) {
	await user.click(screen.getByRole("combobox", { name }));
	const listbox = await screen.findByRole("listbox");
	await user.click(within(listbox).getByRole("option", { name: option }));
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** Source: uploads a CSV through the file input (the harness's XHR answers) and waits for its sample. */
async function upload(user: UserEvent) {
	await heading("Source");
	const file = new File([["id,title,Released", ...ROWS].join("\n")], "posts.csv", {
		type: "text/csv",
	});
	await user.upload(screen.getByLabelText("Choose a file", { selector: "input" }), file);
	await screen.findByRole("table");
	await waitFor(() => expect(next()).toBeEnabled());
}

/** Target: posts in English. */
async function target(user: UserEvent, collection = "Posts") {
	await heading("Target");
	await choose(user, "Collection", collection);
	await waitFor(() => expect(next()).toBeEnabled());
	await user.click(next());
}

/** Map: waits until the suggestion has filled the rows and Next is free. */
async function mapped() {
	await heading("Map");
	await screen.findByText("Name matching");
	await waitFor(() => expect(next()).toBeEnabled());
}

/** Preview: waits for the dry run to finish. */
async function previewed() {
	await heading("Preview");
	await screen.findByText(`Dry run finished. Records checked: ${RECORDS}`);
	await screen.findByRole("table");
	await waitFor(() => expect(screen.getByRole("button", { name: "Run import" })).toBeEnabled());
}

/** Run: starts the import from Preview and waits for it to finish. */
async function run(user: UserEvent) {
	await user.click(screen.getByRole("button", { name: "Run import" }));
	await heading("Run");
	await screen.findByText("The import is complete.");
}

/** Source: loads the saved template, which opens Preview. */
async function loadTemplate(user: UserEvent) {
	const picker = await screen.findByRole("combobox", { name: "Saved template" });
	await waitFor(() => expect(picker).toBeEnabled());
	await choose(user, "Saved template", /Posts from CSV/);
	await user.click(screen.getByRole("button", { name: "Load template" }));
}

/** The CSV flow from upload to a finished run, with one new field (`released`). */
async function csvFlow(user: UserEvent) {
	await upload(user);
	await user.click(next());
	await target(user);
	await mapped();
	await user.click(screen.getByRole("button", { name: "+ Add a new field" }));
	const details = screen.getByRole("complementary", { name: "Details" });
	await user.click(within(details).getByRole("combobox", { name: "Key for the new field" }));
	await user.click(await screen.findByRole("option", { name: "Released" }));
	await screen.findByText("From Released · slug released");
	await user.click(next());
	const dialog = await screen.findByRole("dialog", { name: "Add these fields to the collection?" });
	await within(dialog).findByText("Released (released): a new datetime field");
	await user.click(within(dialog).getByRole("button", { name: "Add the fields" }));
	await heading("Options");
	await user.click(next());
	await previewed();
	await run(user);
}

describe("the import wizard, end to end", () => {
	it("imports a CSV from upload to a completed run with one new field", async () => {
		const { calls } = mockRoutes(server());
		const { user } = renderPage();
		await csvFlow(user);

		expect(actions(calls)).toEqual([
			"upload",
			"sources/sample",
			"templates/suggest",
			"schema/apply dryRun:true",
			"schema/apply dryRun:false",
			"jobs/create dryRun:true",
			"jobs/next",
			"jobs/records",
			"jobs/create dryRun:false",
			"jobs/next",
		]);
		// The collection's fields were read again after the apply, before Map was left.
		const order = calls.map((c) => c.route);
		expect(order.lastIndexOf("GET collection:posts")).toBeGreaterThan(
			order.lastIndexOf("schema/apply"),
		);
		expect(order.lastIndexOf("GET collection:posts")).toBeLessThan(order.indexOf("jobs/create"));

		const [sample] = calls.filter((c) => c.route === "sources/sample");
		expect(sample?.body).toEqual({ uploadId: UPLOAD_ID, n: SAMPLE_MAX, source: { format: "csv" } });
		const [suggest] = calls.filter((c) => c.route === "templates/suggest");
		expect(suggest?.body).toEqual({
			collection: "posts",
			locale: "en",
			uploadId: UPLOAD_ID,
			source: { format: "csv" },
		});
		const applied = calls.filter((c) => c.route === "schema/apply").map((c) => c.body);
		expect(applied).toEqual([
			{
				collection: "posts",
				fields: [
					{
						slug: "released",
						type: "datetime",
						label: "Released",
						translatable: true,
						searchable: false,
					},
				],
				dryRun: true,
			},
			expect.objectContaining({ dryRun: false }),
		]);

		const [dry, real] = bodies(calls, "jobs/create");
		const template = {
			version: 1,
			source: { format: "csv" },
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: {
				title: { from: "title", type: "text" },
				released: { type: "date", from: "Released" },
			},
			rules: { owner: "wizard-posts-en" },
		};
		expect(dry).toEqual({
			uploadId: UPLOAD_ID,
			dryRun: true,
			template,
			publish: true,
			journal: true,
		});
		// The run imports exactly what Preview checked: the dry run's upload and the same draft.
		expect(real).toEqual({ ...dry, dryRun: false });
		expect(
			calls.filter((c) => c.route === "jobs/next").map((c) => (c.body as { id: string }).id),
		).toEqual(["01JZ00000000000000000JOB01", "01JZ00000000000000000JOB02"]);
		expect(new URLSearchParams(window.location.search).get("job")).toBe(
			"01JZ00000000000000000JOB02",
		);
		expect(screen.getByRole("link", { name: "View the entries" })).toHaveAttribute(
			"href",
			"/_emdash/admin/content/posts",
		);
	});

	it("starts a new import from a finished run, with an empty draft and a URL without the job", async () => {
		const { calls } = mockRoutes(server());
		const { user } = renderPage();
		await csvFlow(user);
		expect(new URLSearchParams(window.location.search).get("job")).toBe(
			"01JZ00000000000000000JOB02",
		);

		expect(unloadPrevented()).toBe(false);
		await user.click(screen.getByRole("button", { name: "Start a new import" }));
		// Source, focused, with nothing of the last import: no sample, no later step linked.
		const source = await heading("Source");
		await waitFor(() => expect(source).toHaveFocus());
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getAllByRole("link", { name: /^\d / })).toEqual([stepLink(1, "Source")]);
		expect(next()).toBeDisabled();
		const params = new URLSearchParams(window.location.search);
		expect(params.get("job")).toBeNull();
		expect(params.get("step")).toBe("source");
		// The empty draft has nothing to lose, so leaving the page asks nothing until it changes.
		expect(unloadPrevented()).toBe(false);

		// A second import runs as a new job, from its own dry run.
		const before = calls.length;
		await upload(user);
		expect(unloadPrevented()).toBe(true);
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		await user.click(next());
		await previewed();
		await run(user);
		expect(actions(calls.slice(before))).toEqual([
			"upload",
			"sources/sample",
			"templates/suggest",
			"jobs/create dryRun:true",
			"jobs/next",
			"jobs/records",
			"jobs/create dryRun:false",
			"jobs/next",
		]);
		expect(new URLSearchParams(window.location.search).get("job")).toBe(
			"01JZ00000000000000000JOB04",
		);
	});

	it("starts a new import from a ?job= the server no longer has (final review 2)", async () => {
		window.history.replaceState(null, "", "/import?job=01JZ00000000000000000GONE1");
		mockRoutes({
			...server(),
			"jobs/get": () => fail("NOT_FOUND", "Job not found", 404),
		});
		const { user } = renderPage();
		await heading("Run");
		expect(await screen.findByText("This item no longer exists.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Start a new import" }));
		const source = await heading("Source");
		await waitFor(() => expect(source).toHaveFocus());
		const params = new URLSearchParams(window.location.search);
		expect(params.get("job")).toBeNull();
		expect(params.get("step")).toBe("source");
		await upload(user);
		await user.click(next());
		await heading("Target");
	});

	it("lists a template saved on Run in the picker of the next import (final review 3)", async () => {
		mockRoutes(server());
		const { user, queryClient } = renderPage();
		// The host's QueryClient keeps reads fresh for a minute, so only an invalidation refetches.
		queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
		await upload(user);
		// Read before the save: there is none yet.
		expect(await screen.findByText("No saved templates")).toBeVisible();
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Weekly posts");
		await user.click(next());
		await previewed();
		await run(user);
		await user.click(screen.getByRole("button", { name: "Start a new import" }));
		await upload(user);
		const picker = await screen.findByRole("combobox", { name: "Saved template" });
		await waitFor(() => expect(picker).toBeEnabled());
		await user.click(picker);
		const listbox = await screen.findByRole("listbox");
		expect(await within(listbox).findByRole("option", { name: /Weekly posts/ })).toBeVisible();
	});

	it("starts from a saved template, runs it unedited by id and revision", async () => {
		const { calls } = mockRoutes(server({ templates: [SAVED_TEMPLATE] }));
		const { user } = renderPage();
		await upload(user);
		await loadTemplate(user);
		await previewed();
		await run(user);

		expect(actions(calls)).toEqual([
			"upload",
			"sources/sample",
			"templates/get",
			"sources/sample",
			"jobs/create dryRun:true",
			"jobs/next",
			"jobs/records",
			"jobs/create dryRun:false",
			"jobs/next",
		]);
		const byId = { templateId: SAVED_TEMPLATE.id, templateRevision: 3 };
		const [dry, real] = bodies(calls, "jobs/create");
		expect(dry).toEqual({
			uploadId: UPLOAD_ID,
			dryRun: true,
			...byId,
			publish: true,
			journal: true,
		});
		expect(real).toEqual({ ...dry, dryRun: false });
	});

	it("runs an edited saved template inline by default", async () => {
		const { calls } = mockRoutes(server({ templates: [SAVED_TEMPLATE] }));
		const { user } = renderPage();
		await upload(user);
		await loadTemplate(user);
		await previewed();
		await user.click(stepLink(4, "Options"));
		await heading("Options");
		await user.click(screen.getByRole("radio", { name: "Create only" }));
		// Unsaved changes run as they are unless asked otherwise.
		expect(
			screen.getByRole("radio", { name: "Run with these changes without saving them" }),
		).toBeChecked();
		await user.click(next());
		await previewed();
		await run(user);

		expect(actions(calls)).not.toContain("templates/create");
		expect(actions(calls)).not.toContain("templates/update");
		const [first, dry, real] = bodies(calls, "jobs/create");
		expect(first).toMatchObject({ templateId: SAVED_TEMPLATE.id, templateRevision: 3 });
		expect(dry).toEqual({
			uploadId: UPLOAD_ID,
			dryRun: true,
			template: {
				version: 1,
				source: { format: "csv" },
				collection: "posts",
				locale: "en",
				key: { from: "id" },
				fields: { title: { from: "title", type: "text" } },
				// The saved template has no owner, so the edit runs under one derived from its name.
				rules: { owner: "posts-from-csv", mode: "create" },
			},
			publish: true,
			journal: true,
		});
		expect(real).toEqual({ ...dry, dryRun: false });
	});

	it("runs an unedited template by id after its edits are undone, without saving the choice left over", async () => {
		const { calls } = mockRoutes(server({ templates: [SAVED_TEMPLATE] }));
		const { user } = renderPage();
		await upload(user);
		await loadTemplate(user);
		await previewed();
		await user.click(stepLink(4, "Options"));
		await heading("Options");
		await user.click(screen.getByRole("radio", { name: "Create only" }));
		await user.click(screen.getByRole("radio", { name: "Save as a new template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Posts copy");
		// The edit is undone: the save choice is no longer offered, but stays in the draft.
		await user.click(screen.getByRole("radio", { name: "Create and update" }));
		expect(screen.queryByRole("textbox", { name: "Template name" })).toBeNull();
		// The step bar skips Options' Next, which would have dropped the choice.
		await user.click(stepLink(5, "Preview"));
		await previewed();
		await run(user);

		expect(actions(calls)).not.toContain("templates/create");
		const byId = { templateId: SAVED_TEMPLATE.id, templateRevision: 3 };
		const [, dry, real] = bodies(calls, "jobs/create");
		expect(dry).toEqual({
			uploadId: UPLOAD_ID,
			dryRun: true,
			...byId,
			publish: true,
			journal: true,
		});
		expect(real).toEqual({ ...dry, dryRun: false });
	});

	it("clears the mapping when the collection changes, and the dry run when an option changes", async () => {
		const { calls } = mockRoutes(server());
		const { user } = renderPage();
		await upload(user);
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		await user.click(next());
		await previewed();
		expect(bodies(calls, "jobs/create")).toHaveLength(1);

		// An option changed: the dry run is stale, so Preview checks the draft again.
		await user.click(stepLink(4, "Options"));
		await heading("Options");
		await user.click(screen.getByRole("radio", { name: "Draft" }));
		await user.click(next());
		await previewed();
		const dryRuns = bodies(calls, "jobs/create");
		expect(dryRuns.map((b) => [b.dryRun, b.publish])).toEqual([
			[true, true],
			[true, false],
		]);
		expect(stepLink(6, "Run")).toBeVisible();

		// A new collection: the mapping, the dry run and the way to Run are gone.
		await user.click(stepLink(2, "Target"));
		await heading("Target");
		await choose(user, "Collection", "Pages");
		expect(screen.getByText("Changing the collection clears the mapping.")).toBeVisible();
		await user.click(next());
		await heading("Map");
		await waitFor(() =>
			expect(calls.filter((c) => c.route === "templates/suggest").map((c) => c.body)).toEqual([
				expect.objectContaining({ collection: "posts" }),
				expect.objectContaining({ collection: "pages" }),
			]),
		);
		await screen.findByTestId("field:content");
		// Nothing of the posts mapping is left: the key and the title wait for a key again.
		expect(within(screen.getByTestId("key")).getByText("Drop a key")).toBeVisible();
		expect(within(screen.getByTestId("field:title")).getByText("Drop a key")).toBeVisible();
		expect(next()).toBeDisabled();
		for (const [n, step] of [
			[4, "Options"],
			[5, "Preview"],
			[6, "Run"],
		] as const) {
			expect(screen.queryByRole("link", { name: `${n} ${step}` }), step).toBeNull();
		}
		expect(bodies(calls, "jobs/create")).toHaveLength(2);
	});

	it("links Options, Preview and Run in the step bar only while Map has no blockers", async () => {
		mockRoutes(server());
		const { user } = renderPage();
		await upload(user);
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		await user.click(next());
		await previewed();
		expect(stepLink(6, "Run")).toBeVisible();

		// The required Title left unmapped: every later step would fail, so none is linked.
		await user.click(stepLink(3, "Map"));
		await heading("Map");
		await user.click(screen.getByRole("button", { name: "Remove title from Title" }));
		expect(next()).toBeDisabled();
		for (const [n, step] of [
			[4, "Options"],
			[5, "Preview"],
			[6, "Run"],
		] as const) {
			expect(screen.queryByRole("link", { name: `${n} ${step}` }), step).toBeNull();
		}
		// The steps before Map stay open: they cannot fail on the mapping.
		expect(stepLink(1, "Source")).toBeVisible();
		expect(stepLink(2, "Target")).toBeVisible();

		// Mapped again: Options and Preview are back; Run waits for a new dry run.
		await user.click(
			within(screen.getByTestId("field:title")).getByRole("button", { name: /^Title/ }),
		);
		const details = screen.getByRole("complementary", { name: "Details" });
		await user.click(within(details).getByRole("combobox", { name: "Source key" }));
		await user.click(await screen.findByRole("option", { name: "title" }));
		expect(stepLink(4, "Options")).toBeVisible();
		expect(stepLink(5, "Preview")).toBeVisible();
		expect(screen.queryByRole("link", { name: "6 Run" })).toBeNull();
	});

	it("links no Preview in the step bar while an Options input is refused (final review 4)", async () => {
		mockRoutes(server());
		const { user } = renderPage();
		await upload(user);
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		expect(stepLink(5, "Preview")).toBeVisible();
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Weekly posts");
		await user.click(screen.getByRole("radio", { name: "Unpublish them" }));
		const threshold = screen.getByRole("textbox", { name: /Stop the run/ });
		await user.clear(threshold);
		await user.type(threshold, "250");
		expect(next()).toBeDisabled();
		expect(screen.queryByRole("link", { name: "5 Preview" })).toBeNull();
		await user.clear(threshold);
		await user.type(threshold, "30");
		expect(stepLink(5, "Preview")).toBeVisible();

		// Leaving Options drops the text it refused: the draft keeps its last valid value.
		await user.clear(threshold);
		expect(screen.queryByRole("link", { name: "5 Preview" })).toBeNull();
		await user.click(stepLink(3, "Map"));
		await heading("Map");
		expect(stepLink(5, "Preview")).toBeVisible();
		await user.click(stepLink(4, "Options"));
		await heading("Options");
		expect(screen.getByRole("textbox", { name: /Stop the run/ })).toHaveValue("30");
	});

	it("keeps Preview unlinked after leaving Options with a template name already taken", async () => {
		mockRoutes(server({ templates: [SAVED_TEMPLATE] }));
		const { user } = renderPage();
		await upload(user);
		await user.click(next());
		await target(user);
		await mapped();
		await user.click(next());
		await heading("Options");
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Posts from CSV");
		await waitFor(() => expect(screen.queryByRole("link", { name: "5 Preview" })).toBeNull());
		// The name is the draft's own, so the check holds away from Options too.
		await user.click(stepLink(3, "Map"));
		await heading("Map");
		expect(screen.queryByRole("link", { name: "5 Preview" })).toBeNull();
		await user.click(stepLink(4, "Options"));
		await heading("Options");
		const name = screen.getByRole("textbox", { name: "Template name" });
		await user.type(name, " 2");
		expect(stepLink(5, "Preview")).toBeVisible();
	});

	it("links no step after Map while a proposed field waits for the schema diff", async () => {
		mockRoutes(server());
		const { user } = renderPage();
		await upload(user);
		await user.click(next());
		await target(user);
		await mapped();
		expect(stepLink(4, "Options")).toBeVisible();

		// A proposal goes through Map's Next and the schema diff, never around them.
		await user.click(screen.getByRole("button", { name: "+ Add a new field" }));
		const details = screen.getByRole("complementary", { name: "Details" });
		await user.click(within(details).getByRole("combobox", { name: "Key for the new field" }));
		await user.click(await screen.findByRole("option", { name: "Released" }));
		await screen.findByText("From Released · slug released");
		for (const [n, step] of [
			[4, "Options"],
			[5, "Preview"],
			[6, "Run"],
		] as const) {
			expect(screen.queryByRole("link", { name: `${n} ${step}` }), step).toBeNull();
		}
		expect(next()).toBeEnabled();
		expect(stepLink(1, "Source")).toBeVisible();
		expect(stepLink(2, "Target")).toBeVisible();

		// Removed again, Options is a link once more.
		await user.click(screen.getByRole("button", { name: "Remove Released" }));
		expect(stepLink(4, "Options")).toBeVisible();
	});

	it("never sends a request without X-EmDash-Request", async () => {
		const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:log");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { calls } = mockRoutes({
			...server(),
			"GET log.csv": () =>
				new Response("record,status\n1,created\n", {
					headers: { "content-type": "text/csv; charset=utf-8" },
				}),
		});
		const { user } = renderPage();
		await csvFlow(user);
		await user.click(screen.getByRole("button", { name: "Download log" }));
		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(create).toHaveBeenCalledOnce();

		// The harness refuses, and records, any request without the header: none was refused,
		// and every kind of request the wizard sends was seen (the upload's XHR and GETs too).
		expect(takeViolations()).toEqual([]);
		const routes = new Set(calls.map((c) => c.route));
		for (const route of [
			"credentials/list",
			"templates/list",
			"upload",
			"sources/sample",
			"GET manifest",
			"GET collection:posts",
			"templates/suggest",
			"schema/apply",
			"jobs/create",
			"jobs/next",
			"jobs/records",
			"GET log.csv",
		]) {
			expect(routes, route).toContain(route);
		}
	});
});
