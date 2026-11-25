import { Empty } from "@cloudflare/kumo";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { runUrl } from "../../src/admin/home/links.js";
import { SchedulesTab } from "../../src/admin/home/schedules/SchedulesTab.js";
import { MAX_SCHEDULES } from "../../src/admin/limits.js";
import { queryKeys } from "../../src/admin/queries.js";
import { templateSchema } from "../../src/engine/template.js";
import type { ScheduleView } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedTemplate, TemplateSummary } from "../../src/plugin/templates.js";
import { fail, mockRoutes, type RouteHandler, renderAdmin } from "./harness.js";
import { schedule, sourceRow, templateRow } from "./home-fixtures.js";

const T1 = templateRow({ id: "T1", name: "Products feed", revision: 3 });
const T2 = templateRow({ id: "T2", name: "Prices", revision: 7 });
const SRC1 = sourceRow({ id: "SRC1", name: "Feed" });
const SRC2 = sourceRow({ id: "SRC2", name: "Other feed", url: "https://other.example.com/x.json" });

/** A saved template with its body; `missing` adds `rules.missing` (with an owner, as it needs). */
function saved(row: TemplateSummary, missing?: { maxPercent?: number }): SavedTemplate {
	return {
		...row,
		template: templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: { title: { from: "title", type: "text" } },
			...(missing === undefined
				? {}
				: { rules: { owner: "feed", missing: { action: "trash", ...missing } } }),
		}),
	};
}

interface Data {
	schedules?: readonly ScheduleView[];
	templates?: readonly TemplateSummary[];
	sources?: readonly SourceRow[];
	fence?: string;
	bodies?: Record<string, SavedTemplate>;
}

/** The tab's reads, with `over` for the writes a test makes. `data` may be changed later. */
function routes(data: Data = {}, over: Record<string, RouteHandler> = {}) {
	return mockRoutes({
		"schedules/list": () => ({ items: data.schedules ?? [], hasMore: false }),
		"schedules/fence": () => ({ fence: data.fence ?? "clear" }),
		"templates/list": () => ({ items: data.templates ?? [T1, T2], hasMore: false }),
		"sources/list": () => ({ items: data.sources ?? [SRC1, SRC2], hasMore: false }),
		"templates/get": (body) => {
			const id = (body as { id: string }).id;
			const found = data.bodies?.[id] ?? [T1, T2].find((t) => t.id === id);
			if (!found) return fail("TEMPLATE_NOT_FOUND", "gone", 404);
			return "template" in found ? found : saved(found);
		},
		...over,
	});
}

function renderTab() {
	return renderAdmin(
		<HomeProvider initialTab="schedules">
			<SchedulesTab />
		</HomeProvider>,
	);
}

/** The table row whose name cell reads `name`. */
async function rowOf(name: string): Promise<HTMLElement> {
	const cell = await screen.findByRole("cell", { name });
	const row = cell.closest("tr");
	if (!row) throw new Error(`no row for ${name}`);
	return row;
}

async function choose(user: UserEvent, name: string, option: string) {
	await user.click(screen.getByRole("combobox", { name }));
	const listbox = await screen.findByRole("listbox");
	await user.click(within(listbox).getByRole("option", { name: option }));
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

const live = () => document.querySelector('[aria-live="polite"]');

const bodyOf = (calls: { route: string; body: unknown }[], route: string) =>
	calls.filter((c) => c.route === route).map((c) => c.body);

describe("the Schedules tab", () => {
	it("lists names, timing in words with UTC, next run, last launch and the state with its pause reason in words", async () => {
		const at = "2026-11-24T06:00:00.000Z";
		routes({
			schedules: [
				schedule({
					id: "SC1",
					name: "Nightly",
					sourceId: "SRC1",
					cron: "0 3 * * *",
					nextRunAt: "2026-11-25T03:00:00.000Z",
					lastLaunch: { at, outcome: "started", jobId: "J1" },
				}),
				schedule({
					id: "SC2",
					name: "Prices hourly",
					templateId: "GONE",
					sourceId: "GONE",
					cron: "5 * * * *",
					enabled: false,
					pause: { reason: "empty_feed", at },
					nextRunAt: null,
					lastLaunch: { at, outcome: "failed", errorCode: "FETCH_FAILED" },
				}),
				schedule({
					id: "SC3",
					name: "Weekdays",
					templateId: "T2",
					sourceId: "SRC2",
					cron: "0 6 * * 1-5",
					enabled: false,
					nextRunAt: null,
				}),
				schedule({
					id: "SC4",
					name: "Mondays",
					sourceId: "SRC1",
					cron: "30 6 * * 1",
					due: { at },
					lastLaunch: { at, outcome: "unchanged" },
				}),
				schedule({
					id: "SC5",
					name: "Future",
					sourceId: "SRC1",
					enabled: false,
					pause: { reason: "from_the_future" as never, at },
					lastLaunch: { at, outcome: "busy" },
				}),
			],
		});
		renderTab();
		const nightly = within(await rowOf("Nightly"));
		for (const head of [
			"Name",
			"Template",
			"Source",
			"When it runs",
			"Next run",
			"Last launch",
			"State",
		]) {
			expect(screen.getByRole("columnheader", { name: head })).toBeVisible();
		}
		expect(nightly.getByText("Products feed")).toBeVisible();
		expect(nightly.getByText("Feed")).toBeVisible();
		expect(nightly.getByText("Every day at 03:00 UTC")).toBeVisible();
		expect(nightly.getByText("Nov 25, 2026 03:00 UTC")).toBeVisible();
		// Every time in the tab is UTC (plan Ruling 13), the last launch's too.
		expect(nightly.getByText("Nov 24, 2026 06:00 UTC")).toBeVisible();
		expect(nightly.getByText("Started an import.")).toBeVisible();
		expect(nightly.getByText("Active")).toBeVisible();

		const prices = within(await rowOf("Prices hourly"));
		expect(prices.getByText("Deleted template")).toBeVisible();
		expect(prices.getByText("Deleted source")).toBeVisible();
		expect(prices.getByText("Every hour at minute 5")).toBeVisible();
		expect(prices.getByText("Not scheduled")).toBeVisible();
		expect(prices.getByText("Couldn't start: The address could not be reached.")).toBeVisible();
		expect(prices.getByText("Paused: the feed was empty")).toBeVisible();

		const weekdays = within(await rowOf("Weekdays"));
		expect(weekdays.getByText("Prices")).toBeVisible();
		expect(weekdays.getByText("Other feed")).toBeVisible();
		expect(weekdays.getByText("Custom: 0 6 * * 1-5 (UTC)")).toBeVisible();
		expect(weekdays.getByText("Never launched")).toBeVisible();
		expect(weekdays.getByText("Paused")).toBeVisible();

		const mondays = within(await rowOf("Mondays"));
		expect(mondays.getByText("Every Monday at 06:30 UTC")).toBeVisible();
		expect(mondays.getByText("Queued")).toBeVisible();
		expect(mondays.getByText("The feed had not changed, so nothing was imported.")).toBeVisible();

		const future = within(await rowOf("Future"));
		expect(future.getByText("Paused: for a reason this version does not know")).toBeVisible();
		expect(
			future.getByText("Skipped: an import from this source was still running."),
		).toBeVisible();
		// Paused rows offer Resume, running ones Pause; every action names its row.
		expect(screen.getByRole("button", { name: "Pause Nightly" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Resume Prices hourly" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Run now Nightly" })).toBeVisible();
		// A paused or disabled schedule is never run (SCHEDULE_DISABLED): Resume comes first.
		for (const name of ["Prices hourly", "Weekdays", "Future"]) {
			expect(screen.queryByRole("button", { name: `Run now ${name}` })).toBeNull();
		}
		expect(screen.getByRole("button", { name: "Run now Mondays" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Edit Nightly" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Delete Nightly" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Run log of Nightly" })).toBeVisible();
	});

	it("says when there are no schedules", async () => {
		routes();
		renderTab();
		const title = await screen.findByText("No schedules yet.");
		expect(title).toBeVisible();
		expect(screen.queryByRole("table")).toBeNull();
		// The small empty state, as Jobs and Templates show theirs (Task 16).
		const { container } = render(<Empty size="sm" title="x" />);
		const root = container.firstElementChild as HTMLElement;
		let mine: HTMLElement = title;
		while (mine.parentElement && !mine.parentElement.classList.contains("space-y-4")) {
			mine = mine.parentElement;
		}
		expect(mine.className).toBe(root.className);
	});

	it.each([
		["import", "An import into this site is running, so scheduled runs wait until it ends."],
		["export", "An export of this site is running, so scheduled runs wait until it ends."],
		["media", "EmDash is turning on media tracking, so scheduled runs wait until it ends."],
		["error", "flux-import couldn't check whether the site is busy, so scheduled runs wait."],
	])("shows the fence banner with its kind in words (%s)", async (fence, sentence) => {
		routes({ fence, schedules: [schedule({ sourceId: "SRC1" })] });
		renderTab();
		expect(await screen.findByText(sentence)).toBeVisible();
	});

	it("shows the failed-check banner when the fence cannot be read", async () => {
		routes(
			{ schedules: [schedule({ sourceId: "SRC1" })] },
			// Not a 5xx, which the query itself retries once after a delay.
			{ "schedules/fence": () => fail("INVALID_PLUGIN_REQUEST", "refused", 400) },
		);
		renderTab();
		expect(
			await screen.findByText(
				"flux-import couldn't check whether the site is busy, so scheduled runs wait.",
			),
		).toBeVisible();
	});

	it("shows the fence banner with its kind in words, and none when clear", async () => {
		const { calls } = routes({ fence: "clear", schedules: [schedule({ sourceId: "SRC1" })] });
		renderTab();
		await rowOf("Nightly");
		await waitFor(() => expect(calls.some((c) => c.route === "schedules/fence")).toBe(true));
		expect(screen.queryByText(/scheduled runs wait/)).toBeNull();
	});

	it("creates a daily schedule from a template at its listed revision and a URL source", async () => {
		const data: Data = { schedules: [] };
		const created = schedule({
			id: "SC9",
			name: "Nightly products",
			templateId: "T1",
			templateRevision: 3,
			sourceId: "SRC1",
			cron: "0 6 * * *",
		});
		const { calls } = routes(data, { "schedules/create": () => ({ schedule: created }) });
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		expect(within(dialog).getByText("Times are in UTC, as EmDash runs schedules.")).toBeVisible();
		// Nothing chosen yet: each select says what to choose, never an empty box (Task 16).
		expect(within(dialog).getByRole("combobox", { name: "Template" })).toHaveTextContent(
			"Choose a template",
		);
		expect(within(dialog).getByRole("combobox", { name: "URL source" })).toHaveTextContent(
			"Choose a URL source",
		);
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nightly products");
		await choose(user, "Template", "Products feed");
		await choose(user, "URL source", "Feed");
		expect(within(dialog).getByRole("radio", { name: "Daily" })).toBeChecked();
		expect(within(dialog).getByLabelText("Time (UTC)")).toHaveValue("06:00");
		expect(within(dialog).getByRole("radio", { name: "Publish them" })).toBeChecked();
		// A template without rules.missing asks nothing about missing entries.
		expect(
			within(dialog).queryByRole("radiogroup", { name: "Entries missing from the feed" }),
		).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/create")).toEqual([
			{
				name: "Nightly products",
				templateId: "T1",
				templateRevision: 3,
				sourceId: "SRC1",
				cron: "0 6 * * *",
				publish: true,
			},
		]);
		expect(await rowOf("Nightly products")).toBeVisible();
		expect(live()).toHaveTextContent("Created Nightly products.");
	});

	it("closes the dialog with Escape and gives focus back to New schedule", async () => {
		routes({ schedules: [] });
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		const button = screen.getByRole("button", { name: "New schedule" });
		// At the right, as the other tabs place their action (Task 16).
		expect(button.parentElement).toHaveClass("justify-end");
		await user.click(button);
		await screen.findByRole("dialog", { name: "New schedule" });
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(button).toHaveFocus());
	});

	it("builds hourly and weekly times, a draft and a batch size, and checks them first", async () => {
		const { calls } = routes(
			{ schedules: [] },
			{ "schedules/create": (b) => ({ schedule: schedule({ ...(b as object), id: "SC9" }) }) },
		);
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(within(dialog).getByText("Enter a name.")).toBeVisible();
		expect(within(dialog).getByText("Choose a template.")).toBeVisible();
		expect(within(dialog).getByText("Choose a URL source.")).toBeVisible();
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Weekly prices");
		await choose(user, "Template", "Prices");
		await choose(user, "URL source", "Other feed");
		await user.click(within(dialog).getByRole("radio", { name: "Hourly" }));
		const minute = within(dialog).getByRole("spinbutton", { name: "Minute past the hour" });
		await user.clear(minute);
		await user.type(minute, "60");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(within(dialog).getByText("Enter a minute from 0 to 59.")).toBeVisible();
		await user.click(within(dialog).getByRole("radio", { name: "Weekly" }));
		await choose(user, "Day", "Friday");
		const time = within(dialog).getByLabelText("Time (UTC)");
		await user.clear(time);
		await user.type(time, "18:45");
		await user.click(within(dialog).getByRole("radio", { name: "Save them as drafts" }));
		const batch = within(dialog).getByRole("spinbutton", { name: "Batch size (optional)" });
		await user.type(batch, "501");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(within(dialog).getByText("Enter a whole number from 1 to 500.")).toBeVisible();
		expect(bodyOf(calls, "schedules/create")).toEqual([]);
		await user.clear(batch);
		await user.type(batch, "20");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/create")).toEqual([
			{
				name: "Weekly prices",
				templateId: "T2",
				templateRevision: 7,
				sourceId: "SRC2",
				cron: "45 18 * * 5",
				publish: false,
				batchSize: 20,
			},
		]);
	});

	it("asks for missing entries only when the template has rules.missing, sending template by default", async () => {
		const { calls } = routes(
			{ schedules: [], bodies: { T1: saved(T1, { maxPercent: 20 }) } },
			{ "schedules/create": (b) => ({ schedule: schedule({ ...(b as object), id: "SC9" }) }) },
		);
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nightly");
		await choose(user, "Template", "Prices");
		await choose(user, "URL source", "Feed");
		await waitFor(() => expect(bodyOf(calls, "templates/get")).toEqual([{ id: "T2" }]));
		expect(within(dialog).queryByRole("radio", { name: "As the template sets" })).toBeNull();
		await choose(user, "Template", "Products feed");
		const asTemplate = await within(dialog).findByRole("radio", { name: "As the template sets" });
		expect(asTemplate).toBeChecked();
		expect(within(dialog).getByRole("radio", { name: "Off" })).not.toBeChecked();
		// A lower threshold is at most the template's.
		await user.click(within(dialog).getByRole("radio", { name: "A lower threshold" }));
		const percent = within(dialog).getByRole("spinbutton", {
			name: "Stop when more than this percent is missing",
		});
		await user.clear(percent);
		await user.type(percent, "30");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(within(dialog).getByText("Enter a whole number from 0 to 20.")).toBeVisible();
		expect(bodyOf(calls, "schedules/create")).toEqual([]);
		await user.click(asTemplate);
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/create")).toEqual([
			{
				name: "Nightly",
				templateId: "T1",
				templateRevision: 3,
				sourceId: "SRC1",
				cron: "0 6 * * *",
				publish: true,
				missing: "template",
			},
		]);
	});

	it("sends Off as false and a lower threshold as maxPercent", async () => {
		const { calls } = routes(
			{ schedules: [], bodies: { T1: saved(T1, {}) } },
			{ "schedules/create": (b) => ({ schedule: schedule({ ...(b as object), id: "SC9" }) }) },
		);
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		for (const [choice, percent, expected] of [
			["Off", null, false],
			["A lower threshold", "10", { maxPercent: 10 }],
		] as const) {
			await user.click(screen.getByRole("button", { name: "New schedule" }));
			const dialog = await screen.findByRole("dialog", { name: "New schedule" });
			await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nightly");
			await choose(user, "Template", "Products feed");
			await choose(user, "URL source", "Feed");
			await user.click(await within(dialog).findByRole("radio", { name: choice }));
			if (percent !== null) {
				// The template sets no threshold: EmDash's default, 25, is the most.
				expect(within(dialog).getByText("At most 25, the template's own threshold.")).toBeVisible();
				await user.type(
					within(dialog).getByRole("spinbutton", {
						name: "Stop when more than this percent is missing",
					}),
					percent,
				);
			}
			await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			expect(bodyOf(calls, "schedules/create").at(-1)).toMatchObject({ missing: expected });
		}
	});

	it("shows INVALID_CRON in words under a custom expression", async () => {
		const { calls } = routes(
			{ schedules: [] },
			{
				"schedules/create": () =>
					fail("INVALID_CRON", "Invalid minute: 61. Use five cron fields; times are UTC", 400),
			},
		);
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Odd");
		await choose(user, "Template", "Products feed");
		await choose(user, "URL source", "Feed");
		await user.click(within(dialog).getByRole("radio", { name: "Custom" }));
		const cron = within(dialog).getByRole("textbox", { name: "Cron expression (UTC)" });
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(within(dialog).getByText("Enter a cron expression.")).toBeVisible();
		await user.type(cron, " 61 * * * * ");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		const sentence = await within(dialog).findByText(/^That schedule time is not valid\./);
		expect(sentence).toHaveTextContent("Invalid minute: 61.");
		// Under the field: the smallest element holding both is the expression's own field.
		let field = cron.parentElement;
		while (field && !field.contains(sentence)) field = field.parentElement;
		expect(field).not.toBeNull();
		expect(field).not.toBe(dialog);
		expect(within(field!).queryByRole("textbox", { name: "Name" })).toBeNull();
		expect(within(field!).queryByRole("radio")).toBeNull();
		expect(cron.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(bodyOf(calls, "schedules/create")).toMatchObject([{ cron: "61 * * * *" }]);
		expect(screen.getByRole("dialog", { name: "New schedule" })).toBeVisible();
	});

	it("lists a template's problems", async () => {
		routes(
			{ schedules: [] },
			{
				"schedules/create": () =>
					fail("TEMPLATE_PROBLEMS", "does not fit", 409, {
						problems: ["Field price does not exist"],
					}),
			},
		);
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nightly");
		await choose(user, "Template", "Products feed");
		await choose(user, "URL source", "Feed");
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		expect(
			await within(dialog).findByText(
				"The template does not fit the site, so it cannot be scheduled.",
			),
		).toBeVisible();
		expect(within(dialog).getByRole("listitem")).toHaveTextContent("Field price does not exist");
	});

	it("says what to create first, with buttons to Templates and Sources", async () => {
		for (const [data, button, tab] of [
			[{ templates: [] }, "Go to Templates", "templates"],
			[{ sources: [] }, "Go to Sources", "sources"],
		] as const) {
			window.history.replaceState(null, "", "/?tab=schedules");
			routes({ schedules: [], ...data });
			const { user, unmount } = renderTab();
			await screen.findByText("No schedules yet.");
			await user.click(screen.getByRole("button", { name: "New schedule" }));
			const dialog = await screen.findByRole("dialog", { name: "New schedule" });
			expect(within(dialog).getByText("Save a template and add a URL source first.")).toBeVisible();
			expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
			expect(within(dialog).getByRole("button", { name: "Go to Templates" })).toBeVisible();
			await user.click(within(dialog).getByRole("button", { name: button }));
			expect(new URLSearchParams(window.location.search).get("tab")).toBe(tab);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			unmount();
		}
	});

	it("disables New schedule at the limit, saying why", async () => {
		routes({
			schedules: Array.from({ length: MAX_SCHEDULES }, (_, i) =>
				schedule({ id: `SC${i}`, name: `Schedule ${i}` }),
			),
		});
		renderTab();
		await rowOf("Schedule 0");
		const button = screen.getByRole("button", { name: "New schedule" });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription(
			`The site holds at most ${MAX_SCHEDULES} schedules. Delete one to add another.`,
		);
	});

	it("runs now and shows Queued until the launch; SCHEDULE_BUSY and SCHEDULE_DISABLED in words", async () => {
		const at = "2026-11-24T06:00:00.000Z";
		const nightly = schedule({ id: "SC1", name: "Nightly", sourceId: "SRC1", revision: 4 });
		const data: Data = {
			schedules: [
				nightly,
				schedule({ id: "SC2", name: "Busy one", sourceId: "SRC1" }),
				schedule({ id: "SC3", name: "Off one", sourceId: "SRC1" }),
			],
		};
		const { calls } = routes(data, {
			"schedules/run": (body) => {
				const { id } = body as { id: string };
				if (id === "SC2") return fail("SCHEDULE_BUSY", "busy with job J7", 409, { jobId: "J7" });
				if (id === "SC3") return fail("SCHEDULE_DISABLED", "disabled", 409);
				return { queued: true, schedule: { ...nightly, due: { at, force: true } } };
			},
		});
		const { user, queryClient } = renderTab();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const row = within(await rowOf("Nightly"));
		expect(row.getByText("Active")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Run now Nightly" }));
		expect(await row.findByText("Queued")).toBeVisible();
		expect(live()).toHaveTextContent("Queued a run of Nightly.");
		expect(bodyOf(calls, "schedules/run")).toEqual([{ id: "SC1" }]);
		// Its job is listed in Jobs.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.jobs });
		// The launch takes the mark: the next read shows the row running, with its launch.
		data.schedules = [
			{ ...nightly, lastLaunch: { at, outcome: "started", jobId: "J9" } },
			...data.schedules!.slice(1),
		];
		await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
		expect(await row.findByText("Active")).toBeVisible();
		expect(row.getByText("Started an import.")).toBeVisible();

		await user.click(screen.getByRole("button", { name: "Run now Busy one" }));
		expect(
			await screen.findByText(
				"Busy one: This schedule is importing right now. Wait for the import to finish or cancel it.",
			),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Run now Off one" }));
		expect(
			await screen.findByText("Off one: This schedule is paused. Resume it first."),
		).toBeVisible();
		expect(screen.queryByText(/^Busy one:/)).toBeNull();
	});

	it("pauses and resumes with enabled at the row's revision", async () => {
		const nightly = schedule({ id: "SC1", name: "Nightly", sourceId: "SRC1", revision: 4 });
		const { calls } = routes(
			{ schedules: [nightly] },
			{
				"schedules/update": (body) => {
					const b = body as { revision: number; enabled: boolean };
					return { schedule: { ...nightly, enabled: b.enabled, revision: b.revision + 1 } };
				},
			},
		);
		const { user } = renderTab();
		const row = within(await rowOf("Nightly"));
		await user.click(screen.getByRole("button", { name: "Pause Nightly" }));
		expect(await row.findByText("Paused")).toBeVisible();
		expect(live()).toHaveTextContent("Paused Nightly.");
		await user.click(screen.getByRole("button", { name: "Resume Nightly" }));
		expect(await row.findByText("Active")).toBeVisible();
		expect(live()).toHaveTextContent("Resumed Nightly.");
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, enabled: false },
			{ id: "SC1", revision: 5, enabled: true },
		]);
	});

	it("shows SCHEDULE_CHANGED as changed elsewhere, and Reload reads the list again", async () => {
		const data: Data = { schedules: [schedule({ id: "SC1", name: "Nightly", revision: 4 })] };
		const { calls } = routes(data, {
			"schedules/update": () => fail("SCHEDULE_CHANGED", "at revision 5, not 4", 409),
		});
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Pause Nightly" }));
		expect(await screen.findByText("This schedule changed elsewhere.")).toBeVisible();
		const lists = bodyOf(calls, "schedules/list").length;
		data.schedules = [schedule({ id: "SC1", name: "Nightly", revision: 5, enabled: false })];
		await user.click(screen.getByRole("button", { name: "Reload" }));
		await waitFor(() => expect(bodyOf(calls, "schedules/list").length).toBe(lists + 1));
		expect(await screen.findByRole("button", { name: "Resume Nightly" })).toBeVisible();
		expect(screen.queryByText("This schedule changed elsewhere.")).toBeNull();
	});

	it("deletes after confirming", async () => {
		const { calls } = routes(
			{ schedules: [schedule({ id: "SC1", name: "Nightly", revision: 4 })] },
			{ "schedules/delete": () => ({ deleted: true }) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Delete Nightly" }));
		let dialog = await screen.findByRole("dialog", { name: "Delete Nightly?" });
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/delete")).toEqual([]);
		await user.click(screen.getByRole("button", { name: "Delete Nightly" }));
		dialog = await screen.findByRole("dialog", { name: "Delete Nightly?" });
		expect(
			within(dialog).getByText(
				"Nightly stops running and its run log is deleted. The imports it ran stay.",
			),
		).toBeVisible();
		await user.click(within(dialog).getByRole("button", { name: "Delete schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/delete")).toEqual([{ id: "SC1", revision: 4 }]);
		expect(await screen.findByText("No schedules yet.")).toBeVisible();
		expect(live()).toHaveTextContent("Deleted Nightly.");
	});

	it("keeps the delete dialog open with the refusal in words", async () => {
		routes(
			{ schedules: [schedule({ id: "SC1", name: "Nightly", revision: 4 })] },
			{ "schedules/delete": () => fail("SCHEDULE_BUSY", "busy", 409, { jobId: "J1" }) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Delete Nightly" }));
		const dialog = await screen.findByRole("dialog", { name: "Delete Nightly?" });
		await user.click(within(dialog).getByRole("button", { name: "Delete schedule" }));
		expect(
			await within(dialog).findByText(
				"This schedule is importing right now. Wait for the import to finish or cancel it.",
			),
		).toBeVisible();
	});

	it("shows the run log with each job linked to its Run screen", async () => {
		routes({
			schedules: [
				schedule({
					id: "SC1",
					name: "Nightly",
					runs: [
						{
							jobId: "J2",
							at: "2026-11-23T06:05:00.000Z",
							outcome: "completed",
							counters: {
								created: 3,
								updated: 2,
								unchanged: 1,
								failed: 0,
								conflict: 0,
								locked: 0,
								removed: 4,
							},
						},
						{
							jobId: "J1",
							at: "2026-11-22T06:05:00.000Z",
							outcome: "empty_feed",
							counters: {
								created: 0,
								updated: 0,
								unchanged: 0,
								failed: 0,
								conflict: 0,
								locked: 0,
								removed: 0,
							},
							rolledBack: { by: "J5", at: "2026-11-22T07:00:00.000Z" },
						},
						{
							jobId: "J0",
							at: "2026-11-21T06:05:00.000Z",
							outcome: "from_the_future" as never,
							counters: {
								created: 0,
								updated: 0,
								unchanged: 0,
								failed: 0,
								conflict: 0,
								locked: 0,
								removed: 0,
							},
						},
					],
				}),
				schedule({ id: "SC2", name: "Fresh" }),
			],
		});
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Run log of Nightly" }));
		const dialog = await screen.findByRole("dialog", { name: "Run log of Nightly" });
		const rows = within(dialog).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent("Completed");
		expect(rows[0]).toHaveTextContent("Nov 23, 2026 06:05 UTC");
		expect(rows[2]).toHaveTextContent("Unknown outcome");
		// The outcome cell says only that: never "Failed" for an outcome it does not know.
		expect(within(rows[2]!).getAllByRole("cell")[1]).toHaveTextContent(/^Unknown outcome$/);
		expect(rows[0]).toHaveTextContent(
			"Created: 3. Updated: 2. Unchanged: 1. Failed: 0. Removed: 4.",
		);
		// Counts that are zero beyond the four every run has are left out.
		expect(rows[0]).not.toHaveTextContent("Conflicts");
		expect(rows[0]).not.toHaveTextContent("Locked");
		expect(rows[1]).not.toHaveTextContent("Removed");
		expect(
			within(rows[0]!).getByRole("link", {
				name: "Open the import that finished Nov 23, 2026 06:05 UTC",
			}),
		).toHaveAttribute("href", runUrl("J2"));
		expect(rows[1]).toHaveTextContent("Stopped: the feed was empty");
		expect(rows[1]).toHaveTextContent("Rolled back");
		expect(within(rows[1]!).getByRole("link")).toHaveAttribute("href", runUrl("J1"));
		await user.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await user.click(screen.getByRole("button", { name: "Run log of Fresh" }));
		expect(
			within(await screen.findByRole("dialog", { name: "Run log of Fresh" })).getByText(
				"No runs yet.",
			),
		).toBeVisible();
	});

	it("resumes a schedule paused for template_changed on the template's current revision", async () => {
		const at = "2026-11-24T06:00:00.000Z";
		const changed = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "SRC1",
			enabled: false,
			pause: { reason: "template_changed", at },
			revision: 4,
		});
		const dropped = schedule({
			id: "SC2",
			name: "Dropped",
			templateId: "T2",
			templateRevision: 2,
			sourceId: "SRC1",
			missing: { maxPercent: 10 },
			enabled: false,
			pause: { reason: "template_changed", at },
			revision: 6,
		});
		const { calls } = routes(
			{ schedules: [changed, dropped] },
			{
				"schedules/update": (body) => {
					const b = body as { id: string };
					const row = b.id === "SC1" ? changed : dropped;
					const { pause: _, ...rest } = row;
					return { schedule: { ...rest, enabled: true, revision: row.revision + 1 } };
				},
			},
		);
		const { user } = renderTab();
		const row = within(await rowOf("Nightly"));
		expect(row.getByText("Resume runs the template's current version.")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Resume Nightly" }));
		expect(await row.findByText("Active")).toBeVisible();
		// T2's current revision has no rules.missing: the stored threshold is cleared with it.
		await user.click(screen.getByRole("button", { name: "Resume Dropped" }));
		expect(await within(await rowOf("Dropped")).findByText("Active")).toBeVisible();
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, enabled: true, templateId: "T1", templateRevision: 3 },
			{
				id: "SC2",
				revision: 6,
				enabled: true,
				templateId: "T2",
				templateRevision: 7,
				missing: null,
			},
		]);
	});

	it("re-pins on Resume to the template's revision as read now, not a cached one", async () => {
		const changed = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "SRC1",
			enabled: false,
			pause: { reason: "template_changed", at: "2026-11-24T06:00:00.000Z" },
			revision: 4,
		});
		const { calls } = routes(
			{ schedules: [changed] },
			{
				"schedules/update": () => {
					const { pause: _, ...rest } = changed;
					return { schedule: { ...rest, enabled: true, revision: 5 } };
				},
			},
		);
		const { user, queryClient } = renderTab();
		// The host keeps data fresh for 60 s; a dialog read revision 2 a moment ago.
		queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
		queryClient.setQueryData(queryKeys.template("T1"), saved({ ...T1, revision: 2 }));
		await user.click(await screen.findByRole("button", { name: "Resume Nightly" }));
		await waitFor(() => expect(bodyOf(calls, "schedules/update")).toHaveLength(1));
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, enabled: true, templateId: "T1", templateRevision: 3 },
		]);
	});

	it("notes an enabled schedule pinned to an older template revision, and re-pins it to the current one", async () => {
		const note = "Will pause at its next run: its template changed.";
		const outdated = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "SRC1",
			revision: 4,
		});
		const { calls } = routes(
			{
				schedules: [
					outdated,
					schedule({ id: "SC2", name: "Current", templateId: "T2", templateRevision: 7 }),
					schedule({ id: "SC3", name: "Off", templateRevision: 1, enabled: false }),
					schedule({ id: "SC4", name: "Orphan", templateId: "GONE", templateRevision: 1 }),
				],
			},
			{
				"schedules/update": (body) => {
					const b = body as { templateRevision: number };
					return {
						schedule: { ...outdated, templateRevision: b.templateRevision, revision: 5 },
					};
				},
			},
		);
		const { user, queryClient } = renderTab();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const row = within(await rowOf("Nightly"));
		expect(row.getByText(note)).toBeVisible();
		// The accessible name holds the visible text (WCAG 2.5.3), as Run now's does.
		expect(
			screen.getByRole("button", { name: "Use the current version for Nightly" }),
		).toHaveTextContent("Use the current version");
		expect(screen.getByRole("button", { name: "Run now Nightly" })).toHaveTextContent("Run now");
		for (const name of ["Current", "Off", "Orphan"]) {
			expect(within(await rowOf(name)).queryByText(note)).toBeNull();
		}
		expect(
			screen.queryByRole("button", { name: "Use the current version for Current" }),
		).toBeNull();
		await user.click(screen.getByRole("button", { name: "Use the current version for Nightly" }));
		await waitFor(() => expect(row.queryByText(note)).toBeNull());
		expect(live()).toHaveTextContent("Updated Nightly to its template's current version.");
		// The listed revisions are read again, so a stale list cannot keep the note.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.allTemplates });
		// Only the pin changes: the schedule stays enabled.
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, templateId: "T1", templateRevision: 3 },
		]);
	});

	it("says a template_changed schedule whose template is gone needs an edit, and sends nothing", async () => {
		const { calls } = routes({
			schedules: [
				schedule({
					id: "SC1",
					name: "Nightly",
					templateId: "GONE",
					sourceId: "SRC1",
					enabled: false,
					pause: { reason: "template_changed", at: "2026-11-24T06:00:00.000Z" },
				}),
			],
		});
		const { user } = renderTab();
		const row = within(await rowOf("Nightly"));
		const note = "Its template is no longer saved. Edit the schedule to choose one.";
		expect(row.getByText(note)).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Resume Nightly" }));
		expect(await screen.findByText(`Nightly: ${note}`)).toBeVisible();
		expect(bodyOf(calls, "schedules/update")).toEqual([]);
	});

	it("shows the server's sentence when the template's current revision needs a missing choice", async () => {
		routes(
			{
				schedules: [
					schedule({
						id: "SC1",
						name: "Nightly",
						templateId: "T1",
						sourceId: "SRC1",
						enabled: false,
						pause: { reason: "template_changed", at: "2026-11-24T06:00:00.000Z" },
					}),
				],
				bodies: { T1: saved(T1, { maxPercent: 20 }) },
			},
			{ "schedules/update": () => fail("MISSING_REQUIRED", "set missing", 400) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Resume Nightly" }));
		expect(
			await screen.findByText(
				"Nightly: This template tracks missing entries, so the schedule has to say what to do about them.",
			),
		).toBeVisible();
	});

	it("renames a schedule without a stored missing choice on a rules.missing template without sending missing", async () => {
		const nightly = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			sourceId: "SRC1",
			revision: 4,
		});
		const { calls } = routes(
			{ schedules: [nightly], bodies: { T1: saved(T1, { maxPercent: 20 }) } },
			{ "schedules/update": () => ({ schedule: { ...nightly, name: "Nightly 2" } }) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		// No stored choice is the template's own, as the engine reads it.
		expect(
			await within(dialog).findByRole("radio", { name: "As the template sets" }),
		).toBeChecked();
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " 2");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, name: "Nightly 2" },
		]);
	});

	it("sends the template's missing choice when moving a schedule without one onto a rules.missing template", async () => {
		const nightly = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T2",
			sourceId: "SRC1",
			revision: 4,
		});
		const { calls } = routes(
			{ schedules: [nightly], bodies: { T1: saved(T1, { maxPercent: 20 }) } },
			{ "schedules/update": () => ({ schedule: nightly }) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		await choose(user, "Template", "Products feed");
		await within(dialog).findByRole("radio", { name: "As the template sets" });
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, templateId: "T1", templateRevision: 3, missing: "template" },
		]);
	});

	it("edits only what changed, with templateRevision whenever templateId changes", async () => {
		const nightly = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "SRC1",
			cron: "0 3 * * *",
			revision: 4,
		});
		const data: Data = { schedules: [nightly] };
		const { calls } = routes(data, {
			"schedules/update": (body) => {
				const b = body as Partial<ScheduleView> & { revision: number };
				const row = data.schedules!.find((s) => s.id === "SC1")!;
				const next = { ...row, ...b, revision: b.revision + 1 };
				data.schedules = [next];
				return { schedule: next };
			},
		});
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		let dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		const name = within(dialog).getByRole("textbox", { name: "Name" });
		expect(name).toHaveValue("Nightly");
		expect(within(dialog).getByRole("radio", { name: "Daily" })).toBeChecked();
		expect(within(dialog).getByLabelText("Time (UTC)")).toHaveValue("03:00");
		expect(within(dialog).getByRole("spinbutton", { name: "Batch size (optional)" })).toHaveValue(
			50,
		);
		await user.clear(name);
		await user.type(name, "Nightly 2");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(await rowOf("Nightly 2")).toBeVisible();
		expect(live()).toHaveTextContent("Saved Nightly 2.");

		await user.click(screen.getByRole("button", { name: "Edit Nightly 2" }));
		dialog = await screen.findByRole("dialog", { name: "Edit Nightly 2" });
		await choose(user, "Template", "Prices");
		await user.click(within(dialog).getByRole("radio", { name: "Hourly" }));
		const minute = within(dialog).getByRole("spinbutton", { name: "Minute past the hour" });
		await user.clear(minute);
		await user.type(minute, "5");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		// Nothing changed: no request.
		await user.click(screen.getByRole("button", { name: "Edit Nightly 2" }));
		dialog = await screen.findByRole("dialog", { name: "Edit Nightly 2" });
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, name: "Nightly 2" },
			{ id: "SC1", revision: 5, templateId: "T2", templateRevision: 7, cron: "5 * * * *" },
		]);
	});

	it("clears missing when the new template has no rules.missing, and asks for it when it does", async () => {
		const nightly = schedule({
			id: "SC1",
			name: "Nightly",
			templateId: "T1",
			sourceId: "SRC1",
			missing: { maxPercent: 10 },
			revision: 4,
		});
		const { calls } = routes(
			{ schedules: [nightly], bodies: { T1: saved(T1, { maxPercent: 20 }) } },
			{ "schedules/update": () => ({ schedule: nightly }) },
		);
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		let dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		expect(await within(dialog).findByRole("radio", { name: "A lower threshold" })).toBeChecked();
		expect(
			within(dialog).getByRole("spinbutton", {
				name: "Stop when more than this percent is missing",
			}),
		).toHaveValue(10);
		await choose(user, "Template", "Prices");
		await waitFor(() =>
			expect(within(dialog).queryByRole("radio", { name: "A lower threshold" })).toBeNull(),
		);
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		await user.click(await within(dialog).findByRole("radio", { name: "Off" }));
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, templateId: "T2", templateRevision: 7, missing: null },
			{ id: "SC1", revision: 4, missing: false },
		]);
	});

	it("leaves missing alone when the schedule's template can no longer be read", async () => {
		const gone = schedule({
			id: "SC1",
			name: "Orphan",
			templateId: "GONE",
			sourceId: "SRC1",
			missing: { maxPercent: 10 },
			revision: 4,
		});
		const { calls } = routes(
			{ schedules: [gone] },
			{ "schedules/update": () => ({ schedule: { ...gone, name: "Orphan 2" } }) },
		);
		const { user } = renderTab();
		await rowOf("Orphan");
		await user.click(screen.getByRole("button", { name: "Edit Orphan" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit Orphan" });
		expect(await within(dialog).findByText("This template no longer exists.")).toBeVisible();
		expect(within(dialog).getByRole("combobox", { name: "Template" })).toHaveTextContent(
			"Deleted template",
		);
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " 2");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, name: "Orphan 2" },
		]);
	});

	it("shows SCHEDULE_CHANGED in the dialog with Reload, which reads the schedule again", async () => {
		const data: Data = { schedules: [schedule({ id: "SC1", name: "Nightly", revision: 4 })] };
		const { calls } = routes(data, {
			"schedules/update": (body) =>
				(body as { revision: number }).revision === 4
					? fail("SCHEDULE_CHANGED", "at revision 5, not 4", 409)
					: { schedule: data.schedules![0] },
		});
		const { user } = renderTab();
		await rowOf("Nightly");
		await user.click(screen.getByRole("button", { name: "Edit Nightly" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit Nightly" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " A");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		expect(await within(dialog).findByText("This schedule changed elsewhere.")).toBeVisible();
		data.schedules = [schedule({ id: "SC1", name: "Nightly B", revision: 5 })];
		await user.click(within(dialog).getByRole("button", { name: "Reload" }));
		await waitFor(() =>
			expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Nightly B"),
		);
		expect(within(dialog).queryByText("This schedule changed elsewhere.")).toBeNull();
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "!");
		await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodyOf(calls, "schedules/update")).toEqual([
			{ id: "SC1", revision: 4, name: "Nightly A" },
			{ id: "SC1", revision: 5, name: "Nightly B!" },
		]);
	});

	it("offers no Try again in the dialog after a 403 on its templates", async () => {
		routes({}, { "templates/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
		const { user } = renderTab();
		await screen.findByText("No schedules yet.");
		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		expect(await within(dialog).findByText("Only administrators can import.")).toBeVisible();
		expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("shows a failed list with Try again", async () => {
		let failing = true;
		routes(
			{},
			{
				"schedules/list": () =>
					// Not a 5xx, which the query itself retries once after a delay.
					failing ? fail("INVALID_CURSOR", "stale cursor", 400) : { items: [], hasMore: false },
			},
		);
		const { user } = renderTab();
		expect(
			await screen.findByText("The list changed while it was being read. Reload it."),
		).toBeVisible();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("No schedules yet.")).toBeVisible();
	});
});
