import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_UPDATE_FIELDS } from "../../src/admin/limits.js";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import { OptionsStep } from "../../src/admin/wizard/options/OptionsStep.js";
import { ownerClash } from "../../src/admin/wizard/options/owner.js";
import {
	initialState,
	isEdited,
	ownerOf,
	reducer,
	toTemplate,
	type WizardAction,
	type WizardState,
} from "../../src/admin/wizard/state.js";
import { templateSchema } from "../../src/engine/template.js";
import type { TemplateSummary } from "../../src/plugin/templates.js";
import { POSTS, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteHandler, renderAdmin } from "./harness.js";

const COLUMNS = [
	{ key: "id", values: ["1"] },
	{ key: "title", values: ["A"] },
	{ key: "date", values: ["2026-01-02"] },
];

const run = (state: WizardState, actions: WizardAction[]) => actions.reduce(reducer, state);

/** A one-off draft of a posts import, on the Options step. */
function oneOff(): WizardState {
	return run(initialState, [
		{
			type: "sourceReady",
			source: { kind: "upload", uploadId: UPLOAD_ID, label: "feed.csv" },
			sourceBlock: { format: "csv" },
			columns: COLUMNS,
		},
		{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null },
		{ type: "rowSet", row: "key", mapping: { from: "id" } },
		{ type: "rowSet", row: "field:title", mapping: { from: "title", type: "text" } },
		{ type: "stepChanged", step: "options" },
	]);
}

const BASE_TEMPLATE = templateSchema.parse({
	version: 1,
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "title", type: "text" } },
});

/** A saved template loaded and then edited (an excerpt mapped), on the Options step. */
function editedBase(template = BASE_TEMPLATE): WizardState {
	return run(initialState, [
		{
			type: "sourceReady",
			source: { kind: "upload", uploadId: UPLOAD_ID, label: "feed.csv" },
			sourceBlock: { format: "csv" },
			columns: COLUMNS,
		},
		{
			type: "templateLoaded",
			base: { id: "T1", revision: 3, name: "Products feed", template },
		},
		{ type: "rowSet", row: "field:excerpt", mapping: { from: "title", type: "text" } },
		{ type: "stepChanged", step: "options" },
	]);
}

function summary(over: Partial<TemplateSummary>): TemplateSummary {
	const row: TemplateSummary = {
		id: "T9",
		name: "Other",
		revision: 1,
		collection: "posts",
		locale: "en",
		format: "csv",
		createdAt: "2026-11-23T12:00:00.000Z",
		updatedAt: "2026-11-23T12:00:00.000Z",
		createdBy: "U1",
		updatedBy: "U1",
	};
	return Object.assign(row, over);
}

/** Renders the Options step over `initial`; `seen.state` follows the wizard's state. */
function renderOptions(
	initial: WizardState,
	opts: { templates?: TemplateSummary[]; routes?: Record<string, RouteHandler> } = {},
) {
	const seen = { state: initial };
	function Probe() {
		seen.state = useWizard().state;
		return null;
	}
	const { calls } = mockRoutes({
		"templates/list": () => ({ items: opts.templates ?? [], hasMore: false }),
		"GET collection:posts": () => POSTS,
		...opts.routes,
	});
	const result = renderAdmin(
		<WizardProvider initial={initial}>
			<OptionsStep />
			<Probe />
		</WizardProvider>,
	);
	return { ...result, calls, seen };
}

const next = () => screen.getByRole("button", { name: "Next" });

/** The reason shown beside a disabled Next, which describes it. */
function reason(): string | null {
	const id = next().getAttribute("aria-describedby");
	return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

/** Kumo's radios and checkboxes say disabled with `aria-disabled`. */
const isDisabled = (radio: HTMLElement) => radio.getAttribute("aria-disabled") === "true";

const described = (text: string) => expect.stringContaining(text);

async function openAdvanced(user: { click(e: Element): Promise<void> }) {
	await user.click(screen.getByRole("button", { name: "Advanced" }));
	return screen.getByRole("textbox", { name: "Owner" });
}

describe("ownerClash", () => {
	const others = [
		summary({ id: "A", owner: "feed", locale: "fr" }),
		summary({ id: "B", owner: "other", locale: "en" }),
		summary({ id: "C", owner: "feed", locale: "en" }),
		summary({ id: "D", locale: "en" }),
	];

	it("finds another template with the same owner and locale", () => {
		expect(ownerClash("feed", "en", others, null)?.id).toBe("C");
		expect(ownerClash("feed", "fr", others, null)?.id).toBe("A");
		expect(ownerClash("feed", "de", others, null)).toBeNull();
		expect(ownerClash("none", "en", others, null)).toBeNull();
	});

	it("skips the template itself", () => {
		expect(ownerClash("feed", "en", others, "C")).toBeNull();
		expect(ownerClash("feed", "fr", others, "C")?.id).toBe("A");
	});
});

describe("the Options step", () => {
	it("shows the derived owner under Advanced and follows the template name as it is typed", async () => {
		const { user, seen } = renderOptions(oneOff());
		const owner = await openAdvanced(user);
		expect(owner).toHaveValue("wizard-posts-en");
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Products Feed!");
		expect(owner).toHaveValue("products-feed");
		expect(seen.state.options.owner).toBeNull();
		expect(seen.state.options.save).toEqual({ kind: "new", name: "Products Feed!" });
		expect(toTemplate(seen.state, ownerOf(seen.state))).toMatchObject({
			rules: { owner: "products-feed" },
		});
	});

	it("warns when another template of the collection and locale has the same owner", async () => {
		const { user, calls } = renderOptions(oneOff(), {
			templates: [summary({ name: "Old posts", owner: "wizard-posts-en" })],
		});
		await openAdvanced(user);
		expect(
			await screen.findByText(/The template Old posts has the same owner/),
		).toBeInTheDocument();
		expect(calls.filter((c) => c.route === "templates/list").map((c) => c.body)).toContainEqual({
			collection: "posts",
		});
	});

	it("opens Advanced by itself to show a clash", async () => {
		renderOptions(oneOff(), {
			templates: [summary({ name: "Old posts", owner: "wizard-posts-en" })],
		});
		expect(await screen.findByText(/The template Old posts has the same owner/)).toBeVisible();
		expect(screen.getByRole("textbox", { name: "Owner" })).toBeVisible();
	});

	it("warns of the base template's owner only for a new template saved from it", async () => {
		const owned = templateSchema.parse({ ...BASE_TEMPLATE, rules: { owner: "feed" } });
		const base = summary({ id: "T1", name: "Products feed", owner: "feed" });
		const { user, seen } = renderOptions(editedBase(owned), { templates: [base] });
		expect(seen.state.options.owner).toBe("feed");
		await user.click(screen.getByRole("radio", { name: "Save as a new template" }));
		expect(await screen.findByText(/The template Products feed has the same owner/)).toBeVisible();
		// Run unsaved, or saved to it: the base template is no clash with itself.
		await user.click(
			screen.getByRole("radio", { name: "Run with these changes without saving them" }),
		);
		expect(screen.queryByText(/has the same owner/)).not.toBeInTheDocument();
		await user.click(screen.getByRole("radio", { name: "Save the changes to Products feed" }));
		expect(screen.queryByText(/has the same owner/)).not.toBeInTheDocument();
	});

	it("does not warn about a template of another locale", async () => {
		const { user, calls } = renderOptions(oneOff(), {
			templates: [summary({ name: "Old posts", owner: "wizard-posts-en", locale: "fr" })],
		});
		await openAdvanced(user);
		await waitFor(() => expect(calls.filter((c) => c.route === "templates/list")).toHaveLength(2));
		expect(screen.queryByText(/has the same owner/)).not.toBeInTheDocument();
	});

	it("offers Missing only with Save as template", async () => {
		const { user, seen } = renderOptions(oneOff());
		const trash = screen.getByRole("radio", { name: "Move them to the trash" });
		expect(isDisabled(trash)).toBe(true);
		expect(
			screen.getByText("Saved templates only: a one-off run has nothing to find missing"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		await user.type(screen.getByRole("textbox", { name: "Template name" }), "Feed");
		expect(isDisabled(trash)).toBe(false);
		expect(screen.queryByText(/a one-off run has nothing/)).not.toBeInTheDocument();
		await user.click(trash);
		expect(seen.state.options.missing).toEqual({ action: "trash", maxPercent: 25 });
		const threshold = screen.getByRole("textbox", { name: /Stop the run/ });
		await user.clear(threshold);
		await user.type(threshold, "10");
		expect(seen.state.options.missing).toEqual({ action: "trash", maxPercent: 10 });
		await user.clear(threshold);
		await user.type(threshold, "101");
		expect(threshold).toHaveAccessibleDescription(described("Enter a whole number from 0 to 100"));
		expect(next()).toBeDisabled();
		expect(reason()).toBe("Enter a whole number from 0 to 100");
		expect(seen.state.options.missing).toEqual({ action: "trash", maxPercent: 10 });
		// Without a template to save, nothing can be found missing: the choice is dropped.
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		expect(seen.state.options.missing).toBeNull();
		expect(isDisabled(trash)).toBe(true);
	});

	it("offers Missing with a base template", () => {
		renderOptions(editedBase());
		expect(isDisabled(screen.getByRole("radio", { name: "Unpublish them" }))).toBe(false);
	});

	it("writes rules.mode, updateFields and protectEdited into the draft", async () => {
		const { user, seen } = renderOptions(oneOff());
		await user.click(screen.getByRole("radio", { name: "Update only" }));
		await user.click(await screen.findByRole("checkbox", { name: "Title" }));
		await user.click(
			screen.getByRole("checkbox", { name: "Never overwrite fields edited in the admin" }),
		);
		expect(toTemplate(seen.state, ownerOf(seen.state))).toMatchObject({
			rules: {
				owner: "wizard-posts-en",
				mode: "update",
				updateFields: ["title"],
				protectEdited: true,
			},
		});
		// Create only updates nothing, so it offers neither choice.
		await user.click(screen.getByRole("radio", { name: "Create only" }));
		expect(screen.queryByRole("checkbox", { name: "Title" })).not.toBeInTheDocument();
		expect((toTemplate(seen.state, ownerOf(seen.state)) as { rules: object }).rules).toEqual({
			owner: "wizard-posts-en",
			mode: "create",
		});
	});

	it("lists every mapping name for Update only these fields", async () => {
		const state = run(oneOff(), [
			{ type: "rowSet", row: "slug", mapping: { from: "id" } },
			{ type: "rowSet", row: "taxonomy:tag", mapping: { from: "title" } },
		]);
		const { user, seen } = renderOptions(state);
		await user.click(await screen.findByRole("checkbox", { name: "Slug" }));
		await user.click(screen.getByRole("checkbox", { name: "Taxonomy tag" }));
		expect(seen.state.options.updateFields).toEqual(["slug", "taxonomies.tag"]);
	});

	it("lets Update only these fields hold at most MAX_UPDATE_FIELDS", async () => {
		const slugs = Array.from({ length: MAX_UPDATE_FIELDS + 1 }, (_, i) => `f${i}`);
		const state = run(oneOff(), [
			...slugs.map(
				(slug): WizardAction => ({
					type: "rowSet",
					row: `field:${slug}`,
					mapping: { from: "title", type: "text" },
				}),
			),
			// A name no longer mapped is not listed and does not count.
			{
				type: "optionsChanged",
				patch: { updateFields: ["gone", ...slugs.slice(1, MAX_UPDATE_FIELDS)] },
			},
		]);
		const { user } = renderOptions(state);
		const first = screen.getByRole("checkbox", { name: "f0" });
		const last = screen.getByRole("checkbox", { name: `f${MAX_UPDATE_FIELDS}` });
		expect(isDisabled(last)).toBe(false);
		expect(screen.queryByText("Choose at most 200 fields")).not.toBeInTheDocument();
		await user.click(first);
		expect(screen.getByText("Choose at most 200 fields")).toBeInTheDocument();
		expect(isDisabled(last)).toBe(true);
		expect(isDisabled(first)).toBe(false);
	});

	it("writes Schedule as a fixed expr with tz site, or as a feed key with format", async () => {
		const { user, seen } = renderOptions(oneOff());
		await user.click(screen.getByRole("radio", { name: "Schedule" }));
		expect(next()).toBeDisabled();
		expect(reason()).toBe("Choose when the entries are published");

		await user.click(screen.getByRole("radio", { name: "The same date for every record" }));
		const day = screen
			.getAllByRole("button")
			.find((b) => b.textContent === "15" && b.closest("[role=grid]") !== null);
		if (day === undefined) throw new Error("no day 15 in the calendar");
		await user.click(day);
		const time = screen.getByLabelText("Time");
		await user.clear(time);
		await user.clear(time);
		expect(next()).toBeDisabled();
		await user.type(time, "09:30");
		const now = new Date();
		const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		expect(toTemplate(seen.state, ownerOf(seen.state))).toMatchObject({
			publishAt: { expr: JSON.stringify(`${month}-15T09:30`), tz: "site" },
		});
		expect(next()).toBeEnabled();

		await user.click(screen.getByRole("radio", { name: "A date from the feed" }));
		expect(next()).toBeDisabled();
		await user.click(screen.getByRole("combobox", { name: "Source key" }));
		await user.click(await screen.findByRole("option", { name: "date" }));
		await user.type(screen.getByRole("textbox", { name: "Date format" }), "yyyy-MM-dd");
		const t = toTemplate(seen.state, ownerOf(seen.state)) as { publishAt: unknown };
		expect(t.publishAt).toEqual({ from: "date", format: "yyyy-MM-dd" });
		expect(next()).toBeEnabled();

		await user.click(screen.getByRole("radio", { name: "Draft" }));
		expect(toTemplate(seen.state, ownerOf(seen.state))).not.toHaveProperty("publishAt");
	});

	it("keeps a saved template's own publish date as it is", async () => {
		const template = templateSchema.parse({
			...BASE_TEMPLATE,
			publishAt: { expr: "$now()", tz: "site" },
		});
		const state = run(initialState, [
			{
				type: "sourceReady",
				source: { kind: "upload", uploadId: UPLOAD_ID, label: "feed.csv" },
				sourceBlock: { format: "csv" },
				columns: COLUMNS,
			},
			{ type: "templateLoaded", base: { id: "T1", revision: 1, name: "Feed", template } },
			{ type: "stepChanged", step: "options" },
		]);
		const { user, seen } = renderOptions(state);
		const kept = screen.getByRole("radio", { name: "As the saved template sets it" });
		expect(kept).toBeChecked();
		expect(next()).toBeEnabled();
		await user.click(screen.getByRole("radio", { name: "The same date for every record" }));
		expect(next()).toBeDisabled();
		await user.click(kept);
		expect(next()).toBeEnabled();
		expect(toTemplate(seen.state, ownerOf(seen.state))).toMatchObject({
			publishAt: { expr: "$now()", tz: "site" },
		});
	});

	it("checks the template name against the saved ones as it is typed", async () => {
		const { user, calls } = renderOptions(oneOff(), {
			templates: [summary({ name: "Products", collection: "pages" })],
		});
		await user.click(screen.getByRole("checkbox", { name: "Save as template" }));
		expect(next()).toBeDisabled();
		expect(reason()).toBe("Name the template to save it");
		const name = screen.getByRole("textbox", { name: "Template name" });
		await user.type(name, "Products");
		await waitFor(() =>
			expect(name).toHaveAccessibleDescription(described("A template with this name exists")),
		);
		expect(next()).toBeDisabled();
		expect(reason()).toBe("A template with this name exists");
		// Every collection's templates: names are unique across the site.
		expect(calls.filter((c) => c.route === "templates/list").map((c) => c.body)).toContainEqual({});
		await user.type(name, " 2");
		expect(screen.queryByText("A template with this name exists")).not.toBeInTheDocument();
		expect(next()).toBeEnabled();
		await user.type(name, " ");
		expect(name).toHaveAccessibleDescription(described("no space at either end"));
		expect(next()).toBeDisabled();
		await user.clear(name);
		await user.type(name, "x".repeat(100));
		expect(next()).toBeEnabled();
		await user.type(name, "x");
		expect(reason()).toBe("Use 1 to 100 characters, with no space at either end");
	});

	it("goes on to Preview on Next without a request for a one-off run", async () => {
		const { user, seen, calls } = renderOptions(oneOff());
		await user.click(next());
		expect(seen.state.step).toBe("preview");
		expect(calls.some((c) => c.route === "templates/update")).toBe(false);
	});

	it("defaults an edited base template to running without saving", async () => {
		const state = editedBase();
		expect(isEdited(state)).toBe(true);
		const { user, seen, calls } = renderOptions(state);
		expect(
			screen.getByRole("radio", { name: "Run with these changes without saving them" }),
		).toBeChecked();
		expect(screen.getByRole("radio", { name: "Save the changes to Products feed" })).toBeVisible();
		expect(screen.getByRole("radio", { name: "Save as a new template" })).toBeVisible();
		await user.click(next());
		expect(seen.state.step).toBe("preview");
		expect(seen.state.options.save).toEqual({ kind: "none" });
		expect(calls.some((c) => c.route === "templates/update")).toBe(false);
	});

	it("names a new template saved from an edited base", async () => {
		const { user, seen } = renderOptions(editedBase(), {
			templates: [summary({ name: "Products feed", id: "T1" })],
		});
		await user.click(screen.getByRole("radio", { name: "Save as a new template" }));
		const name = screen.getByRole("textbox", { name: "Template name" });
		await user.type(name, "Products feed");
		await waitFor(() => expect(reason()).toBe("A template with this name exists"));
		await user.type(name, " v2");
		expect(seen.state.options.save).toEqual({ kind: "new", name: "Products feed v2" });
		expect(next()).toBeEnabled();
	});

	it("offers no save choice for an unedited base template", () => {
		const state = run(editedBase(), [{ type: "rowCleared", row: "field:excerpt" }]);
		expect(isEdited(state)).toBe(false);
		renderOptions(state);
		expect(screen.queryByRole("radio", { name: /Save the changes/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("checkbox", { name: "Save as template" })).not.toBeInTheDocument();
	});

	it.each([{ kind: "new", name: "" }, { kind: "update" }] as const)(
		"drops a save choice once the edits that offered it are undone (%o)",
		async (choice) => {
			const state = run(editedBase(), [
				{ type: "optionsChanged", patch: { save: choice } },
				{ type: "rowCleared", row: "field:excerpt" },
			]);
			expect(isEdited(state)).toBe(false);
			const { user, seen, calls } = renderOptions(state);
			expect(next()).toBeEnabled();
			await user.click(next());
			expect(seen.state.step).toBe("preview");
			expect(seen.state.options.save).toEqual({ kind: "none" });
			expect(calls.some((c) => c.route === "templates/update")).toBe(false);
		},
	);

	it("saves the changes to the template on Next and keeps its warnings", async () => {
		const { user, seen, calls } = renderOptions(editedBase(), {
			routes: {
				"templates/update": (body) => {
					const b = body as { id: string; revision: number; template: unknown };
					return {
						template: {
							...summary({ id: b.id, name: "Products feed", revision: b.revision + 1 }),
							template: templateSchema.parse(b.template),
						},
						check: { problems: [], warnings: ["The schedule pins revision 3"] },
					};
				},
			},
		});
		await user.click(screen.getByRole("radio", { name: "Save the changes to Products feed" }));
		await user.click(next());
		await waitFor(() => expect(seen.state.step).toBe("preview"));
		const update = calls.filter((c) => c.route === "templates/update");
		expect(update).toHaveLength(1);
		expect(update[0]?.body).toEqual({
			id: "T1",
			revision: 3,
			template: toTemplate(editedBase(), ownerOf(editedBase())),
		});
		expect(seen.state.base).toMatchObject({ id: "T1", revision: 4, name: "Products feed" });
		expect(seen.state.saved).toEqual({ warnings: ["The schedule pins revision 3"] });
		expect(seen.state.options.save).toEqual({ kind: "none" });
		expect(isEdited(seen.state)).toBe(false);
	});

	it("stays on Options with the sentence when the template changed meanwhile", async () => {
		const { user, seen } = renderOptions(editedBase(), {
			routes: {
				"templates/update": () => fail("TEMPLATE_CHANGED", "Revision 3 is stale", 409),
			},
		});
		await user.click(screen.getByRole("radio", { name: "Save the changes to Products feed" }));
		await user.click(next());
		const alert = await screen.findByRole("alert");
		expect(
			within(alert).getByText(
				"Someone else changed this template. Open it again to see their changes.",
			),
		).toBeInTheDocument();
		expect(seen.state.step).toBe("options");
		expect(seen.state.base?.revision).toBe(3);
		expect(next()).toBeEnabled();
	});

	it("refuses an owner outside OWNER_PATTERN", async () => {
		const { user, seen } = renderOptions(oneOff());
		const owner = await openAdvanced(user);
		await user.clear(owner);
		// Pasted whole: only an owner OWNER_PATTERN accepts reaches the draft.
		await user.paste("my owner");
		expect(owner).toHaveAccessibleDescription(described("Use 1 to 100 letters, digits"));
		expect(next()).toBeDisabled();
		expect(seen.state.options.owner).toBeNull();
		await user.clear(owner);
		await user.type(owner, "my-owner");
		expect(owner).not.toHaveAccessibleDescription(described("Use 1 to 100 letters"));
		expect(seen.state.options.owner).toBe("my-owner");
		expect(next()).toBeEnabled();
	});

	it("takes a batch size from 1 to BATCH_SIZE_MAX, empty for the engine's", async () => {
		const { user, seen } = renderOptions(oneOff());
		await openAdvanced(user);
		const batch = screen.getByRole("textbox", { name: "Batch size" });
		await user.type(batch, "501");
		expect(batch).toHaveAccessibleDescription(described("Enter a whole number from 1 to 500"));
		expect(next()).toBeDisabled();
		expect(reason()).toBe("Enter a whole number from 1 to 500");
		await user.clear(batch);
		await user.type(batch, "0");
		expect(next()).toBeDisabled();
		await user.clear(batch);
		await user.type(batch, "2.5");
		expect(next()).toBeDisabled();
		await user.clear(batch);
		await user.type(batch, "500");
		expect(seen.state.options.batchSize).toBe(500);
		expect(next()).toBeEnabled();
		await user.clear(batch);
		expect(seen.state.options.batchSize).toBeNull();
		expect(next()).toBeEnabled();
	});
});
