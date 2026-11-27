import { act, screen, waitFor, within } from "@testing-library/react";
import type { Dispatch } from "react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../src/admin/api.js";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import { PreviewStep } from "../../src/admin/wizard/preview/PreviewStep.js";
import {
	DEFAULT_OPTIONS,
	initialState,
	reducer,
	type WizardAction,
	type WizardState,
} from "../../src/admin/wizard/state.js";
import { templateSchema } from "../../src/engine/template.js";
import type { Counters, Job, MissingState, RecordRow } from "../../src/engine/types.js";
import { job, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteCall, type RouteHandler, renderAdmin } from "./harness.js";

const JOB_ID = "01JZ00000000000000000JOB01";
const ZERO: Counters = {
	created: 0,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
};

/** A draft on Preview: a CSV upload mapped to posts/en, `id` as the key and `title` mapped. */
const DRAFT: Partial<WizardState> = {
	step: "preview",
	source: { kind: "upload", uploadId: UPLOAD_ID, label: "posts.csv" },
	sourceBlock: { format: "csv" },
	columns: [
		{ key: "id", values: ["a1", "a2"] },
		{ key: "title", values: ["Hello", ""] },
	],
	target: { collection: "posts", locale: "en", translationLocale: null },
	rows: { key: { from: "id" }, "field:title": { from: "title", type: "text" } },
	meta: { key: { origin: "user", check: false }, "field:title": { origin: "user", check: false } },
	dirty: true,
};

/** The draft's template, as `jobs/create` must receive it. */
const DRAFT_TEMPLATE = {
	version: 1,
	source: { format: "csv" },
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "title", type: "text" } },
	rules: { owner: "wizard-posts-en" },
};

/** A dry-run record row (Fact D5). */
function row(over: Partial<RecordRow>): RecordRow {
	return {
		jobId: JOB_ID,
		seq: 1,
		start: 0,
		end: 0,
		status: "planned",
		sourceKey: "a1",
		entryId: null,
		updatedAt: "2026-11-23T12:00:00.000Z",
		...over,
	};
}

const completed = (counters: Partial<Counters>, over: Partial<Job> = {}) =>
	job({ status: "completed", counters: { ...ZERO, ...counters }, ...over });

/** A promise and the function that settles it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** What the test reads of the wizard, and how it acts on it outside the step. */
const probe: { state: WizardState; dispatch: Dispatch<WizardAction> } = {
	state: initialState,
	dispatch: () => undefined,
};

/** The wizard as far as Preview needs it: Preview on its step, the step's name otherwise. */
function Shell() {
	const { state, dispatch } = useWizard();
	probe.state = state;
	probe.dispatch = dispatch;
	return state.step === "preview" ? <PreviewStep /> : <p>{`step: ${state.step}`}</p>;
}

function renderPreview(initial: Partial<WizardState> = DRAFT) {
	return renderAdmin(
		<WizardProvider initial={initial}>
			<Shell />
		</WizardProvider>,
	);
}

/** The counts' value for `label`. */
function count(label: string): string | null {
	const counts = screen.getByRole("region", { name: "What the import would do" });
	return within(counts).getByText(label).nextElementSibling?.textContent ?? null;
}

const created = (calls: RouteCall[]) => calls.filter((c) => c.route === "jobs/create");

describe("PreviewStep", () => {
	it("creates a dry run from the draft with journal true and drives it to completion", async () => {
		let nexts = 0;
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => {
				nexts += 1;
				return nexts === 1
					? job({
							status: "running",
							counters: { ...ZERO, created: 1 },
							cursor: { offset: 1, seq: 1 },
						})
					: completed({ created: 2 });
			},
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		expect(await screen.findByText("Checking every record. Nothing is written yet.")).toBeVisible();
		await waitFor(() =>
			expect(probe.state.dryRun).toEqual({ jobId: JOB_ID, uploadId: UPLOAD_ID, total: 2 }),
		);
		expect(created(calls).map((c) => c.body)).toEqual([
			{
				uploadId: UPLOAD_ID,
				dryRun: true,
				template: DRAFT_TEMPLATE,
				publish: true,
				journal: true,
				origin: "wizard",
			},
		]);
		expect(calls.filter((c) => c.route === "jobs/next").map((c) => c.body)).toEqual([
			{ id: JOB_ID },
			{ id: JOB_ID },
		]);
		expect(count("to create")).toBe("2");
		const counts = screen.getByRole("region", { name: "What the import would do" });
		expect(within(counts).queryByText(/Missing/)).toBeNull();
		expect(screen.queryByText("Checking every record. Nothing is written yet.")).toBeNull();
		expect(screen.getByRole("button", { name: "Run import" })).toBeEnabled();
	});

	it("creates the dry run from the saved template by id and revision when unedited", async () => {
		const template = templateSchema.parse(DRAFT_TEMPLATE);
		const ready = reducer(
			{ ...initialState, ...DRAFT, step: "source", dirty: false },
			{
				type: "templateLoaded",
				base: { id: "T1", revision: 3, name: "Posts feed", template },
			},
		);
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ unchanged: 2 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview(ready);
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(2));
		expect(created(calls).map((c) => c.body)).toEqual([
			{
				uploadId: UPLOAD_ID,
				dryRun: true,
				templateId: "T1",
				templateRevision: 3,
				publish: true,
				journal: true,
				origin: "wizard",
			},
		]);
	});

	it("shows counts and a records table with changes and errors in plain words", async () => {
		const long = "x".repeat(300);
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () =>
				completed(
					{ created: 1, updated: 1, failed: 1, conflict: 2, locked: 3, filtered: 4, removed: 5 },
					{
						template: templateSchema.parse({
							...DRAFT_TEMPLATE,
							rules: { owner: "wizard-posts-en", missing: { action: "unpublish" } },
						}),
					},
				),
			"jobs/records": () => ({
				items: [
					row({
						seq: 1,
						sourceKey: "a1",
						action: "create",
						changes: [
							{ field: "title", before: null, after: "Hello" },
							{ field: "excerpt", before: "", after: "Short" },
						],
					}),
					row({
						seq: 2,
						sourceKey: "a2",
						action: "update",
						changes: [{ field: "excerpt", before: "Old", after: long }],
						warnings: [
							{ field: "title", code: "field_edited", message: "Not updated: …" },
							{
								field: "content",
								code: "image_dropped",
								message: "Left out 1 image inside <pre> or <figcaption>, which hold only text",
							},
						],
					}),
					row({
						seq: 3,
						status: "failed",
						sourceKey: "a3",
						errors: [
							{ field: "title", code: "required", message: "The field is required" },
							{ code: "source_missing", message: `Upload ${UPLOAD_ID} not found` },
						],
					}),
					// The missing phase's rows (engine missing.ts): planned removals, and one left alone,
					// which says why.
					row({
						seq: 4,
						sourceKey: "gone",
						action: "unpublish",
						changes: [{ field: "status", before: "published", after: "draft" }],
					}),
					row({
						seq: 5,
						sourceKey: "old",
						action: "trash",
						changes: [{ field: "status", before: "published", after: "trashed" }],
					}),
					row({
						seq: 6,
						status: "unchanged",
						sourceKey: "kept",
						warnings: [{ code: "missing_edited", message: "Left alone: the entry changed" }],
					}),
					row({ seq: 7, status: "conflict", sourceKey: null }),
					row({ seq: 8, status: "reverted", sourceKey: "odd" }),
				],
				hasMore: false,
			}),
		});
		renderPreview();
		const table = await screen.findByRole("table");
		expect(count("to create")).toBe("1");
		expect(count("to update")).toBe("1");
		expect(count("unchanged")).toBe("0");
		expect(count("failed")).toBe("1");
		expect(count("conflicts")).toBe("2");
		expect(count("locked")).toBe("3");
		expect(count("filtered out")).toBe("4");
		expect(count("missing → unpublish")).toBe("5");
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(12));

		const rows = within(table).getAllByRole("row").slice(1);
		const cells = rows.map((r) =>
			within(r)
				.getAllByRole("cell")
				.map((c) => c.textContent),
		);
		// Each change: the field, then its value before and after ("—" when empty); errors and
		// warnings under the changes they belong to (StepPreview.dc.html).
		expect(cells[0]).toEqual(["a1", "Create", "title— → Helloexcerpt— → Short"]);
		expect(cells[1]).toEqual([
			"a2",
			"Update",
			`excerptOld → ${"x".repeat(119)}…` +
				"title: Not updated: the value was changed outside the import since it last wrote it." +
				"content: Some images were left out. Left out 1 image inside <pre> or <figcaption>, which hold only text",
		]);
		expect(cells[2]).toEqual([
			"a3",
			"Failed",
			"title: The field is requiredUpload the uploaded file not found",
		]);
		expect(cells[3]).toEqual(["gone", "Missing → Unpublish", "statuspublished → draft"]);
		expect(cells[4]).toEqual(["old", "Missing → Trash", "statuspublished → trashed"]);
		expect(cells[5]).toEqual([
			"kept",
			"Unchanged",
			"Left alone: the entry changed after the import last wrote it.",
		]);
		expect(cells[6]).toEqual(["(no key)", "Conflict", ""]);
		expect(cells[7]).toEqual(["odd", "Other", ""]);
		// The action is a badge; its words carry the meaning, not only its colour.
		expect(within(rows[0] as HTMLElement).getByText("Create")).toHaveClass("bg-kumo-badge-teal");
		expect(within(rows[2] as HTMLElement).getByText("Failed")).toHaveClass("bg-kumo-badge-red");
		expect(screen.queryByText("Not applied")).toBeNull();
		expect(document.body.textContent).not.toContain(UPLOAD_ID);
	});

	it("filters records by status and pages with the cursor", async () => {
		const pages: Record<string, unknown> = {
			"": {
				items: [row({ seq: 1, sourceKey: "a1", action: "create" })],
				cursor: "c2",
				hasMore: true,
			},
			c2: { items: [row({ seq: 2, sourceKey: "a2", action: "update" })], hasMore: false },
		};
		const records: RouteHandler = (body) => {
			const { status, cursor } = body as { status?: string; cursor?: string };
			if (status === "failed") {
				return { items: [row({ seq: 3, status: "failed", sourceKey: "a3" })], hasMore: false };
			}
			return pages[cursor ?? ""];
		};
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ created: 1, updated: 1, failed: 1 }),
			"jobs/records": records,
		});
		const { user } = renderPreview();
		expect(await screen.findByRole("cell", { name: "a1" })).toBeVisible();
		const filters = screen.getByRole("group", { name: "Show records" });
		expect(
			within(filters)
				.getAllByRole("tab")
				.map((tab) => tab.textContent),
		).toEqual([
			"All3",
			"Will change2",
			"Warnings0",
			"Failed1",
			"Conflicts0",
			"Locked0",
			"Filtered out0",
		]);
		// A filter no record matches is disabled, so it never shows an empty table.
		expect(within(filters).getByRole("tab", { name: "Conflicts 0" })).toBeDisabled();
		expect(within(filters).getByRole("tab", { name: "Warnings 0" })).toBeDisabled();
		expect(within(filters).getByRole("tab", { name: "Failed 1" })).toBeEnabled();
		const previous = screen.getByRole("button", { name: "Previous page" });
		const next = screen.getByRole("button", { name: "Next page" });
		expect(previous).toBeDisabled();
		await user.click(next);
		expect(await screen.findByRole("cell", { name: "a2" })).toBeVisible();
		expect(screen.queryByRole("cell", { name: "a1" })).toBeNull();
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Previous page" }));
		expect(await screen.findByRole("cell", { name: "a1" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Next page" }));
		expect(await screen.findByRole("cell", { name: "a2" })).toBeVisible();

		// A new filter starts again at its first page.
		await user.click(screen.getByRole("tab", { name: "Failed 1" }));
		expect(await screen.findByRole("cell", { name: "a3" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
		expect(calls.filter((c) => c.route === "jobs/records").map((c) => c.body)).toEqual([
			{ id: JOB_ID },
			{ id: JOB_ID, cursor: "c2" },
			{ id: JOB_ID, status: "failed" },
		]);
	});

	it("counts every filter exactly, and lists the rows that change and those with warnings", async () => {
		const records: RouteHandler = (body) => {
			const { facet } = body as { facet?: string };
			if (facet === "warning") {
				return {
					items: [
						row({
							seq: 2,
							sourceKey: "w1",
							action: "unchanged",
							warnings: [{ field: "body", code: "unknown_markup", message: "Kept 1 <table>" }],
						}),
					],
					hasMore: false,
				};
			}
			if (facet === "change") {
				return { items: [row({ seq: 1, sourceKey: "c1", action: "create" })], hasMore: false };
			}
			return { items: [row({ seq: 1, sourceKey: "c1", action: "create" })], hasMore: false };
		};
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			// The missing phase's planned removals count as changes; its unchanged rows do not.
			"jobs/next": () =>
				completed({ created: 2, updated: 1, unchanged: 4, removed: 1 }, { warned: 1 }),
			"jobs/records": records,
		});
		const { user } = renderPreview();
		expect(await screen.findByRole("cell", { name: "c1" })).toBeVisible();
		const filters = screen.getByRole("group", { name: "Show records" });
		expect(within(filters).getByRole("tab", { name: "All 8" })).toBeEnabled();
		await user.click(within(filters).getByRole("tab", { name: "Will change 4" }));
		await user.click(within(filters).getByRole("tab", { name: "Warnings 1" }));
		expect(await screen.findByRole("cell", { name: "w1" })).toBeVisible();
		expect(calls.filter((c) => c.route === "jobs/records").map((c) => c.body)).toEqual([
			{ id: JOB_ID },
			{ id: JOB_ID, facet: "change" },
			{ id: JOB_ID, facet: "warning" },
		]);
		// The publishing note says how many records have warnings.
		expect(screen.getByText("1 record has a warning.")).toBeVisible();
	});

	it.each<[string, Partial<MissingState>, Partial<Job>, string]>([
		[
			"refused over the limit",
			// The phase went on to plan its rows, as a dry run's over-limit refusal does.
			{ verdict: "refused", owned: 3, found: 1, removed: 1, rows: 1 },
			{},
			"A real run would leave these entries alone: 1 of 3 (34%) are missing from the source, more than the limit of 20%. Raise the limit in Options to apply it.",
		],
		[
			"refused for another source's entries",
			// Stopped by the count stage with no rows; its partial numbers are over the limit.
			{ verdict: "refused", owned: 3, found: 1, rows: 0 },
			{},
			"Missing entries are left alone: this owner also has entries from another URL source.",
		],
		[
			"skipped for unkeyed records",
			{ verdict: "skipped" },
			{ unkeyed: 3 },
			"Missing entries would not be checked: 3 records have no readable key, so their entries may still be in the source.",
		],
		[
			"skipped for no keyed record",
			{ verdict: "skipped" },
			{},
			"Missing entries would not be checked: no record has a readable key.",
		],
	])(
		"explains a missing phase %s and marks it not applied",
		async (_name, missing, over, sentence) => {
			const template = templateSchema.parse({
				...DRAFT_TEMPLATE,
				rules: { owner: "wizard-posts-en", missing: { action: "trash" } },
			});
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () =>
					completed(
						{ created: 2, removed: missing.removed ?? 0 },
						{
							template,
							missingLimit: { maxPercent: 20 },
							missing: {
								stage: "done",
								fromSeq: 2,
								owned: 0,
								found: 0,
								rows: 0,
								removed: 0,
								...missing,
							},
							...over,
						},
					),
				"jobs/records": () => ({ items: [], hasMore: false }),
			});
			renderPreview();
			const counts = await screen.findByRole("region", { name: "What the import would do" });
			expect(within(counts).getByText(sentence)).toBeVisible();
			const card = within(counts).getByText("missing → trash").parentElement;
			expect(card).toHaveTextContent("Not applied");
			expect(within(counts).getAllByText("Not applied")).toHaveLength(1);
			expect(count("missing → trash")).toBe(String(missing.removed ?? 0));
		},
	);

	it("says nothing more when the missing phase applies", async () => {
		const template = templateSchema.parse({
			...DRAFT_TEMPLATE,
			rules: { owner: "wizard-posts-en", missing: { action: "trash" } },
		});
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () =>
				completed(
					{ created: 2, removed: 1 },
					{
						template,
						missingLimit: { maxPercent: 25 },
						missing: {
							stage: "done",
							fromSeq: 2,
							owned: 10,
							found: 1,
							rows: 1,
							removed: 1,
							verdict: "act",
						},
					},
				),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		await waitFor(() => expect(count("missing → trash")).toBe("1"));
		expect(screen.queryByText("Not applied")).toBeNull();
		expect(screen.queryByText(/Missing entries|would leave these entries/)).toBeNull();
	});

	it("shows No records and disables Run for a dry run with zero records (Review Focus 3)", async () => {
		// A missing phase to trash, which a source without records never reaches.
		const template = templateSchema.parse({
			...DRAFT_TEMPLATE,
			rules: { owner: "wizard-posts-en", missing: { action: "trash" } },
		});
		mockRoutes({ "jobs/create": () => job(), "jobs/next": () => completed({}, { template }) });
		renderPreview();
		expect(await screen.findByText("No records to import")).toBeVisible();
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(0));
		expect(count("missing → trash")).toBe("0");
		expect(screen.getByRole("button", { name: "Run import" })).toBeDisabled();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("disables Run while the dry run is driving", async () => {
		const reply = deferred<Job>();
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => reply.promise,
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		expect(await screen.findByText("Checking every record. Nothing is written yet.")).toBeVisible();
		const run = screen.getByRole("button", { name: "Run import" });
		expect(run).toBeDisabled();
		expect(run).toHaveAccessibleDescription("Wait for the dry run to finish");
		const status = screen.getByRole("status");
		reply.resolve(completed({ created: 1 }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Run import" })).toBeEnabled());
		// The same live region announces the end.
		expect(status).toBeInTheDocument();
		expect(status).toHaveTextContent("Dry run of 1 record. Nothing is written yet.");
	});

	it("goes to Run on Run import", async () => {
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		await waitFor(() => expect(screen.getByRole("button", { name: "Run import" })).toBeEnabled());
		await user.click(screen.getByRole("button", { name: "Run import" }));
		expect(probe.state.step).toBe("run");
	});

	it("puts Back and Run import at the top, above the counts, and Back returns to Options", async () => {
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		const counts = await screen.findByRole("region", { name: "What the import would do" });
		const run = screen.getByRole("button", { name: "Run import" });
		expect(run.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// The count strip: zero counts are quiet, the others stand out.
		const toCreate = within(counts).getByText("to create").nextElementSibling;
		expect(toCreate).toHaveClass("text-kumo-default");
		expect(within(counts).getByText("failed").nextElementSibling).toHaveClass("text-kumo-subtle");
		await user.click(screen.getByRole("button", { name: "Back" }));
		expect(probe.state.step).toBe("options");
	});

	it("shows template warnings from Options above the counts", async () => {
		const warning = "Owner feed already owns entries in posts/en";
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview({ ...DRAFT, saved: { warnings: [`${warning} (${UPLOAD_ID})`] } });
		const shown = await screen.findByText(`${warning} (the uploaded file)`);
		const counts = await screen.findByRole("region", { name: "What the import would do" });
		expect(screen.getByText("Saving the template reported:")).toBeVisible();
		expect(shown.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows INVALID_TEMPLATE problems with Back to Map", async () => {
		const problem =
			'Field "excerpt" has type "text"; a number mapping needs one of number, integer';
		const { calls } = mockRoutes({
			"jobs/create": () =>
				fail("INVALID_TEMPLATE", "The template does not fit the source or schema", 400, {
					problems: [problem],
				}),
		});
		const { user } = renderPreview();
		expect(await screen.findByText("The import settings do not fit the collection.")).toBeVisible();
		expect(screen.getByText(problem)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.getByRole("button", { name: "Run import" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Back to Map" }));
		expect(probe.state.step).toBe("map");
		expect(probe.state.rows).toEqual(DRAFT.rows);
		expect(created(calls)).toHaveLength(1);
	});

	it("shows another create error with Try again, which creates the dry run again", async () => {
		let creates = 0;
		mockRoutes({
			"jobs/create": () => {
				creates += 1;
				return creates === 1 ? fail("INTERNAL_ERROR", "boom", 500) : job();
			},
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		expect(await screen.findByText("Something went wrong on the server. Try again.")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		expect(creates).toBe(2);
	});

	it("shows a failed jobs/next with Try again, which drives on", async () => {
		let nexts = 0;
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => {
				nexts += 1;
				return nexts === 1
					? fail("INVALID_TRANSITION", "Cannot do that", 409)
					: completed({ created: 1 });
			},
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		expect(
			await screen.findByText("The import cannot do that in its current state."),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Run import" })).toHaveAccessibleDescription(
			"The dry run did not finish",
		);
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
	});

	it.each([
		["source_missing", "The file for this import is no longer available; start a new import."],
		["invalid_template", "The import settings no longer fit the collection."],
	])(
		"shows a failed dry run's %s in plain words, without the upload ID or Try again",
		async (code, sentence) => {
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () =>
					job({ status: "failed", error: { code, message: `Upload ${UPLOAD_ID} not found` } }),
			});
			renderPreview();
			expect(await screen.findByText(sentence)).toBeVisible();
			expect(screen.getByRole("button", { name: "Run import" })).toBeDisabled();
			expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
			expect(probe.state.dryRun?.total).toBeNull();
			expect(document.body.textContent).not.toContain(UPLOAD_ID);
		},
	);

	it.each<[string, Partial<Job>, string]>([
		[
			"failed",
			{ status: "failed", error: { code: "internal", message: "boom" } },
			"The import stopped after repeated unexpected errors. Resume it to try again.",
		],
		["failed without an error", { status: "failed", error: null }, "Something went wrong."],
		["paused", { status: "paused" }, "The dry run is paused."],
	])("resumes a %s dry run with Try again, then drives on", async (_name, stopped, sentence) => {
		let nexts = 0;
		const resumed = deferred<Job>();
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => {
				nexts += 1;
				return nexts === 1 ? job(stopped) : resumed.promise;
			},
			"jobs/resume": () => job({ status: "running" }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		expect(await screen.findByText(sentence)).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		// Driving again: the stopped job's notice goes before the next reply lands.
		await waitFor(() => expect(nexts).toBe(2));
		expect(screen.queryByText(sentence)).toBeNull();
		expect(screen.getByText("Checking every record. Nothing is written yet.")).toBeVisible();
		resumed.resolve(completed({ created: 1 }));
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		expect(calls.filter((c) => c.route === "jobs/resume").map((c) => c.body)).toEqual([
			{ id: JOB_ID },
		]);
		expect(created(calls)).toHaveLength(1);
	});

	it("sends one resume while it is in flight, and shows a failed resume in plain words", async () => {
		const reply = deferred<Response>();
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => job({ status: "paused" }),
			"jobs/resume": () => reply.promise,
		});
		const { user } = renderPreview();
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
		reply.resolve(fail("INVALID_TRANSITION", "Cannot resume a completed job", 409));
		expect(
			await screen.findByText("The import cannot do that in its current state."),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
		expect(calls.filter((c) => c.route === "jobs/resume")).toHaveLength(1);
	});

	it("a remount while the new dry run for a cancelled one is being created sends one jobs/create", async () => {
		const again = deferred<Job>();
		const { calls } = mockRoutes({
			"jobs/create": () => (created(calls).length === 1 ? job() : again.promise),
			"jobs/next": (body) => {
				const { id } = body as { id: string };
				return id === JOB_ID ? job({ status: "cancelled" }) : completed({ created: 1 }, { id });
			},
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		await waitFor(() => expect(created(calls)).toHaveLength(2));
		act(() => probe.dispatch({ type: "stepChanged", step: "options" }));
		act(() => probe.dispatch({ type: "stepChanged", step: "preview" }));
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		again.resolve(job({ id: "JOB-AGAIN" }));
		await waitFor(() => expect(probe.state.dryRun).toMatchObject({ jobId: "JOB-AGAIN", total: 1 }));
		expect(created(calls)).toHaveLength(2);
	});

	it("shows a failed records read in plain words, with its detail, and reads it again", async () => {
		let reads = 0;
		mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => {
				reads += 1;
				return reads === 1
					? fail("ODD_FAILURE", "The odd detail", 400)
					: { items: [row({ sourceKey: "a1", action: "create" })], hasMore: false };
			},
		});
		const { user } = renderPreview();
		expect(await screen.findByText("Something went wrong.")).toBeVisible();
		expect(screen.getByText("The odd detail")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("cell", { name: "a1" })).toBeVisible();
	});

	it("starts a new dry run when Try again is pressed on a cancelled one", async () => {
		const { calls } = mockRoutes({
			"jobs/create": () => job({ id: created(calls).length === 1 ? JOB_ID : "JOB-AGAIN" }),
			"jobs/next": (body) => {
				const { id } = body as { id: string };
				return id === JOB_ID ? job({ status: "cancelled" }) : completed({ created: 1 }, { id });
			},
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		expect(await screen.findByText("The dry run was cancelled.")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(probe.state.dryRun).toMatchObject({ jobId: "JOB-AGAIN", total: 1 }));
		expect(created(calls)).toHaveLength(2);
		expect(created(calls)[1]?.body).toEqual(created(calls)[0]?.body);
		expect(screen.queryByText("The dry run was cancelled.")).toBeNull();
	});

	it("discards the dry run when the user goes back and changes the mapping", async () => {
		const { calls } = mockRoutes({
			"jobs/create": () => job({ id: `JOB${created(calls).length}` }),
			"jobs/next": (body) => completed({ created: 1 }, { id: (body as { id: string }).id }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		await user.click(screen.getByRole("button", { name: "Back to Map" }));
		expect(probe.state.step).toBe("map");
		expect(probe.state.dryRun?.jobId).toBe("JOB1");

		act(() => probe.dispatch({ type: "rowSet", row: "slug", mapping: { from: "id" } }));
		expect(probe.state.dryRun).toBeNull();
		act(() => probe.dispatch({ type: "stepChanged", step: "preview" }));
		await waitFor(() => expect(probe.state.dryRun).toMatchObject({ jobId: "JOB2", total: 1 }));
		const bodies = created(calls).map((c) => c.body as { template: { slug?: unknown } });
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.template.slug).toBeUndefined();
		expect(bodies[1]?.template.slug).toEqual({ from: "id" });
	});

	it("reopens a finished dry run without creating another, Run disabled while it reads it", async () => {
		const again = deferred<Job>();
		let nexts = 0;
		const { calls } = mockRoutes({
			"jobs/create": () => job(),
			"jobs/next": () => {
				nexts += 1;
				return nexts === 1 ? completed({ created: 1 }) : again.promise;
			},
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		act(() => probe.dispatch({ type: "stepChanged", step: "options" }));
		act(() => probe.dispatch({ type: "stepChanged", step: "preview" }));
		await waitFor(() => expect(nexts).toBe(2));
		expect(screen.getByRole("button", { name: "Run import" })).toBeDisabled();
		again.resolve(completed({ created: 1 }));
		await waitFor(() => expect(count("to create")).toBe("1"));
		expect(screen.getByRole("button", { name: "Run import" })).toBeEnabled();
		expect(created(calls)).toHaveLength(1);
	});

	it("a remount while jobs/create is in flight sends one jobs/create (F14)", async () => {
		const reply = deferred<Job>();
		const { calls } = mockRoutes({
			"jobs/create": () => reply.promise,
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		await waitFor(() => expect(created(calls)).toHaveLength(1));
		act(() => probe.dispatch({ type: "stepChanged", step: "options" }));
		act(() => probe.dispatch({ type: "stepChanged", step: "preview" }));
		reply.resolve(job());
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		expect(created(calls)).toHaveLength(1);
	});

	describe("announces its errors, and offers no Try again on a 403 (final review 7)", () => {
		it("announces a failed jobs/create", async () => {
			mockRoutes({ "jobs/create": () => fail("INTERNAL_ERROR", "boom", 500) });
			renderPreview();
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Something went wrong on the server. Try again.",
			);
		});

		it("announces a failed jobs/next", async () => {
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () => fail("INVALID_TRANSITION", "Cannot do that", 409),
			});
			renderPreview();
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"The import cannot do that in its current state.",
			);
		});

		it("announces a stopped dry run", async () => {
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () => job({ status: "paused" }),
			});
			renderPreview();
			expect(await screen.findByRole("alert")).toHaveTextContent("The dry run is paused.");
		});

		it("announces a failed resume", async () => {
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () => job({ status: "paused" }),
				"jobs/resume": () => fail("INTERNAL_ERROR", "boom", 500),
			});
			const { user } = renderPreview();
			await user.click(await screen.findByRole("button", { name: "Try again" }));
			const alerts = await screen.findAllByRole("alert");
			expect(alerts.map((a) => a.textContent)).toContainEqual(
				expect.stringContaining("Something went wrong on the server. Try again."),
			);
		});

		it.each<[string, Record<string, RouteHandler>]>([
			["jobs/create", { "jobs/create": () => fail("FORBIDDEN", "Insufficient permissions", 403) }],
			[
				"jobs/next",
				{
					"jobs/create": () => job(),
					"jobs/next": () => fail("FORBIDDEN", "Insufficient permissions", 403),
				},
			],
			[
				"jobs/resume",
				{
					"jobs/create": () => job(),
					"jobs/next": () => job({ status: "paused" }),
					"jobs/resume": () => fail("FORBIDDEN", "Insufficient permissions", 403),
				},
			],
		])("shows a 403 from %s with no Try again", async (route, routes) => {
			mockRoutes(routes);
			const { user } = renderPreview();
			if (route === "jobs/resume") {
				await user.click(await screen.findByRole("button", { name: "Try again" }));
			}
			expect(await screen.findByText("Only administrators can import.")).toBeVisible();
			// Trying again cannot change the user's role (Review Focus 2).
			expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
			expect(screen.queryByText("Insufficient permissions")).toBeNull();
		});
	});

	it("keeps Try again for a CSRF refusal, which a reload can cure", async () => {
		let creates = 0;
		mockRoutes({
			"jobs/create": () => {
				creates += 1;
				return creates === 1 ? fail("CSRF_REJECTED", "Missing header", 403) : job();
			},
			"jobs/next": () => completed({ created: 1 }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderPreview();
		expect(
			await screen.findByText("The request was refused as unsafe. Reload the page and try again."),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
	});

	describe("says how the entries will go live (final review 1)", () => {
		const routes = () =>
			mockRoutes({
				"jobs/create": () => job(),
				"jobs/next": () => completed({ created: 2 }),
				"jobs/records": () => ({ items: [], hasMore: false }),
			});

		it("says a loaded template's draft publishes, with Change in Options", async () => {
			routes();
			const template = templateSchema.parse(DRAFT_TEMPLATE);
			const ready = reducer(
				{ ...initialState, ...DRAFT, step: "source", dirty: false },
				{ type: "templateLoaded", base: { id: "T1", revision: 3, name: "Posts feed", template } },
			);
			expect(ready.step).toBe("preview");
			const { user } = renderPreview(ready);
			expect(await screen.findByText("Entries will be published.")).toBeVisible();
			await waitFor(() => expect(probe.state.dryRun?.total).toBe(2));
			await user.click(screen.getByRole("button", { name: "Change in Options" }));
			expect(probe.state.step).toBe("options");
		});

		it.each<[string, Partial<WizardState["options"]>, string]>([
			["Draft", { status: "draft" }, "Entries will be saved as drafts."],
			[
				"Publish after a schedule was chosen",
				{ status: "publish", schedule: { kind: "fixed", at: "2026-12-01T09:30" } },
				"Entries will be published.",
			],
			[
				"one date",
				{ status: "schedule", schedule: { kind: "fixed", at: "2026-12-01T09:30" } },
				"Entries will be scheduled for 2026-12-01 09:30, in the site's timezone.",
			],
			[
				"a feed key",
				{ status: "schedule", schedule: { kind: "feed", from: "go_live" } },
				"Entries will be scheduled by the date in the source key go_live.",
			],
			[
				"a kept schedule",
				{ status: "schedule", schedule: { kind: "kept", mapping: { expr: "$now()" } } },
				"Entries will be scheduled as the saved template sets it.",
			],
		])("says what %s does", async (_name, options, sentence) => {
			routes();
			renderPreview({ ...DRAFT, options: { ...DEFAULT_OPTIONS, ...options } });
			expect(await screen.findByText(sentence)).toBeVisible();
			expect(screen.getAllByText(/^Entries will/)).toHaveLength(1);
		});

		it("offers no Change in Options while Options cannot be shown", async () => {
			routes();
			const proposed = {
				key: "title",
				slug: "headline",
				label: "Headline",
				type: "string",
				translatable: true,
				searchable: false,
			};
			renderPreview({ ...DRAFT, newFields: [proposed] });
			expect(await screen.findByText("Entries will be published.")).toBeVisible();
			expect(screen.queryByRole("button", { name: "Change in Options" })).toBeNull();
		});
	});

	it("drops a dry run created for an older draft and creates one for the new draft", async () => {
		const first = deferred<Job>();
		const createJob = vi.spyOn(api, "createJob");
		const { calls } = mockRoutes({
			"jobs/create": () => (created(calls).length === 1 ? first.promise : job({ id: "JOB-NEW" })),
			"jobs/next": (body) => completed({ created: 1 }, { id: (body as { id: string }).id }),
			"jobs/records": () => ({ items: [], hasMore: false }),
		});
		renderPreview();
		await waitFor(() => expect(created(calls)).toHaveLength(1));
		act(() => probe.dispatch({ type: "rowSet", row: "slug", mapping: { from: "id" } }));
		await waitFor(() => expect(probe.state.dryRun?.jobId).toBe("JOB-NEW"));
		first.resolve(job({ id: "JOB-OLD" }));
		await waitFor(() => expect(probe.state.dryRun?.total).toBe(1));
		// The older reply has been handled (and dropped).
		await waitFor(() =>
			expect(createJob.mock.settledResults.filter((r) => r.type === "fulfilled")).toHaveLength(2),
		);
		expect(probe.state.dryRun?.jobId).toBe("JOB-NEW");
		expect(calls.filter((c) => c.route === "jobs/next").map((c) => c.body)).not.toContainEqual({
			id: "JOB-OLD",
		});
	});
});
