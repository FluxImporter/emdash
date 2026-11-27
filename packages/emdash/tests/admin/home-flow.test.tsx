import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { type UserEvent, userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pages } from "../../src/admin/index.js";
import { queryKeys } from "../../src/admin/queries.js";
import type { Counters, Job } from "../../src/engine/types.js";
import type { ScheduleView } from "../../src/plugin/schedules.js";
import type { JobListItem } from "../../src/plugin/summaries.js";
import type { TemplateFile } from "../../src/plugin/template-files.js";
import type { TemplateSummary } from "../../src/plugin/templates.js";
import { job } from "./fixtures.js";
import {
	fail,
	HOME_ROUTES,
	mockRoutes,
	type RouteCall,
	type RouteHandler,
	renderAdmin,
} from "./harness.js";
import { item, schedule, sourceRow, templateRow } from "./home-fixtures.js";

/**
 * Whole-home flows (M7b Task 15): the assembled `/imports` page, as the admin renders it, with
 * every tab real and every request answered by `mockRoutes` beneath the real `apiFetch`.
 */

/** 15:00 UTC on 24 Nov 2026: a job made at 10:14 UTC that day reads "Today 10:14 UTC". */
const NOW = Date.UTC(2026, 10, 24, 15, 0);
const AT = new Date(Date.UTC(2026, 10, 24, 10, 14)).toISOString();
const WHEN = "Today 10:14 UTC";

const PRODUCTS = templateRow({ id: "T1", name: "Products feed", revision: 3 });

const pageOf = <T,>(items: readonly T[]) => ({ items, hasMore: false });

/** The plugin's routes the page reads on any tab, then `over`. */
function site(over: Record<string, RouteHandler>): Record<string, RouteHandler> {
	return {
		...HOME_ROUTES,
		"credentials/list": () => [],
		"jobs/summaries": () => pageOf([]),
		"templates/list": () => pageOf([PRODUCTS]),
		...over,
	};
}

/** Renders the `/imports` page export on `tab`, the clock at `NOW` (only `Date` is faked). */
function openHome(tab = "jobs") {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	window.history.replaceState(null, "", tab === "jobs" ? "/" : `/?tab=${tab}`);
	const ImportsPage = pages?.["/imports"];
	if (!ImportsPage) throw new Error("no /imports page");
	return renderAdmin(<ImportsPage />);
}

/**
 * `openHome` with the host's own `QueryClient` defaults: `staleTime: 60_000` (@emdash-cms/admin),
 * where the harness keeps 0. Built here, as the harness takes no client.
 */
function openHostHome(tab = "jobs") {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	window.history.replaceState(null, "", tab === "jobs" ? "/" : `/?tab=${tab}`);
	const ImportsPage = pages?.["/imports"];
	if (!ImportsPage) throw new Error("no /imports page");
	const i18n = setupI18n({ locale: "en", messages: { en: {} } });
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<ImportsPage />
			</QueryClientProvider>
		</I18nProvider>,
	);
	return { user: userEvent.setup() };
}

/** The page's one live region's text. */
const announced = () => document.querySelector('[aria-live="polite"]')?.textContent ?? "";

/** The routes that change something, in the order they were called. */
const writes = (calls: RouteCall[], routes: readonly string[]) =>
	calls.filter((c) => routes.includes(c.route)).map((c) => [c.route, c.body]);

const zero: Counters = {
	created: 0,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
	reverted: 0,
};

/** A rollback job of `J1`, as `jobs/rollback` and `jobs/next` answer it. */
const rb = (over: Partial<Job>): Job =>
	job({
		kind: "rollback",
		rollbackOf: "J1",
		counters: zero,
		undo: { deleted: 0, restored: 0, recovered: 0 },
		...over,
	});

/** A real import of Products feed made today at 10:14 that created 10 entries. */
const imported = (over: Partial<JobListItem> = {}): JobListItem =>
	item({
		id: "J1",
		createdAt: AT,
		counters: { ...item().counters, created: 10, updated: 0, unchanged: 0 },
		...over,
	});

/** The table row whose first cell reads `name`, or starts with it as its own line. */
async function rowOf(name: string): Promise<HTMLElement> {
	return waitFor(() => {
		const rows = screen.getAllByRole("row").filter((row) => {
			const first = row.querySelector("td");
			if (!first) return false;
			if (first.textContent === name) return true;
			const line = first.firstElementChild;
			return line?.textContent === name || line?.firstElementChild?.textContent?.trim() === name;
		});
		if (rows.length !== 1) throw new Error(`${rows.length} rows for ${name}`);
		return rows[0] as HTMLElement;
	});
}

async function choose(user: UserEvent, name: string, option: string) {
	await user.click(screen.getByRole("combobox", { name }));
	const listbox = await screen.findByRole("listbox");
	await user.click(within(listbox).getByRole("option", { name: option }));
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("the Imports home, assembled", () => {
	it("rolls back an import after its dry-run summary", async () => {
		let rolledBack = false;
		const nexts: Record<string, Job[]> = {
			D1: [
				rb({ id: "D1", dryRun: true, status: "running", counters: { ...zero, reverted: 4 } }),
				rb({
					id: "D1",
					dryRun: true,
					status: "completed",
					counters: { ...zero, reverted: 10 },
					undo: { deleted: 10, restored: 0, recovered: 0 },
				}),
			],
			R1: [
				rb({ id: "R1", dryRun: false, status: "running", counters: { ...zero, reverted: 6 } }),
				rb({
					id: "R1",
					dryRun: false,
					status: "completed",
					counters: { ...zero, reverted: 10 },
					undo: { deleted: 10, restored: 0, recovered: 0 },
				}),
			],
		};
		const { calls } = mockRoutes(
			site({
				"jobs/summaries": (b) => {
					if ((b as { dryRun: boolean }).dryRun) return pageOf([]);
					if (!rolledBack) return pageOf([imported()]);
					return pageOf([
						item({
							id: "R1",
							kind: "rollback",
							rollbackOf: "J1",
							rollbackable: false,
							createdAt: AT,
							counters: { ...item().counters, created: 0, updated: 0, unchanged: 0, reverted: 10 },
						}),
						imported({ rolledBackBy: "R1", rollbackStatus: "completed", rollbackable: false }),
					]);
				},
				"jobs/rollback": (b) =>
					(b as { dryRun: boolean }).dryRun
						? rb({ id: "D1", dryRun: true })
						: rb({ id: "R1", dryRun: false }),
				"jobs/next": (b) => {
					const id = (b as { id: string }).id;
					const reply = nexts[id]?.shift();
					if (!reply) throw new Error(`no next for ${id}`);
					if (id === "R1" && reply.status === "completed") rolledBack = true;
					return reply;
				},
			}),
		);
		const { user } = openHome();
		const row = within(await rowOf("Products feed"));
		expect(row.getByText("Completed")).toBeVisible();
		const table = screen.getByRole("table");

		await user.click(screen.getByRole("button", { name: `Actions for Products feed, ${WHEN}` }));
		await user.click(
			await screen.findByRole("menuitem", { name: `Roll back Products feed, ${WHEN}` }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Roll back Products feed?" });
		expect(
			await within(dialog).findByRole("button", { name: "Roll back 10 entries" }),
		).toBeVisible();
		expect(writes(calls, ["jobs/rollback"])).toEqual([
			["jobs/rollback", { id: "J1", dryRun: true }],
		]);

		await user.click(within(dialog).getByRole("button", { name: "Roll back 10 entries" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		const lastNext = calls.findLastIndex((c) => c.route === "jobs/next");
		expect(writes(calls, ["jobs/rollback", "jobs/next"])).toEqual([
			["jobs/rollback", { id: "J1", dryRun: true }],
			["jobs/next", { id: "D1" }],
			["jobs/next", { id: "D1" }],
			["jobs/rollback", { id: "J1", dryRun: false }],
			["jobs/next", { id: "R1" }],
			["jobs/next", { id: "R1" }],
		]);
		// The list behind the open dialog is read again as the rollback finishes, not on Close.
		expect(await within(table).findByText("Rolled back")).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(within(await rowOf("Products feed")).getByText("Rolled back")).toBeVisible();
		expect(await rowOf("Rollback of Products feed")).toBeVisible();
		expect(
			calls
				.slice(lastNext + 1)
				.some(
					(c) => c.route === "jobs/summaries" && (c.body as { dryRun: boolean }).dryRun === false,
				),
		).toBe(true);
	});

	it("exports a template, then imports it under another name", async () => {
		let saved: Blob | null = null;
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		// Spied, so the real `URL` is restored after the test (setup.ts).
		vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
			saved = blob as Blob;
			return "blob:template";
		});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const exported: TemplateFile = {
			format: "fluximporter.template",
			formatVersion: 1,
			exportedAt: "2026-11-24T13:00:00.000Z",
			generator: { plugin: "fluximporter", version: "0.7.0" },
			name: "Products feed",
			template: { version: 1, collection: "posts", locale: "en", key: { from: "id" } },
		};
		const templates: TemplateSummary[] = [PRODUCTS];
		const { calls } = mockRoutes(
			site({
				"templates/list": () => pageOf(templates),
				"schedules/list": () => pageOf([]),
				"templates/export": () => ({
					filename: "fluximporter-template-products-feed.json",
					file: exported,
				}),
				"templates/import": (b) => {
					const { name } = b as { name: string };
					const row = templateRow({ id: "T2", name });
					templates.push(row);
					return { template: { ...row, template: {} }, check: { problems: [], warnings: [] } };
				},
			}),
		);
		const { user } = openHome();
		await user.click(await screen.findByRole("tab", { name: "Templates" }));
		await user.click(await screen.findByRole("button", { name: "Actions for Products feed" }));
		await user.click(await screen.findByRole("menuitem", { name: "Export Products feed" }));
		await waitFor(() => expect(announced()).toBe("Exported Products feed."));
		expect(saved).not.toBeNull();

		// The file just saved is the file imported.
		const file = new File([await (saved as unknown as Blob).text()], "products-feed.json", {
			type: "application/json",
		});
		await user.click(screen.getByRole("button", { name: "Import a template" }));
		const dialog = await screen.findByRole("dialog", { name: "Import a template" });
		await user.upload(
			within(dialog).getByLabelText("Template file (.json)", { selector: "input" }),
			file,
		);
		await user.type(within(dialog).getByLabelText("New name (optional)"), "Products feed copy");
		const go = within(dialog).getByRole("button", { name: "Import" });
		await waitFor(() => expect(go).toBeEnabled());
		await user.click(go);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		expect(writes(calls, ["templates/export", "templates/import"])).toEqual([
			["templates/export", { id: "T1" }],
			["templates/import", { file: exported, name: "Products feed copy" }],
		]);
		expect(await rowOf("Products feed copy")).toBeVisible();
		expect(await rowOf("Products feed")).toBeVisible();
		expect(announced()).toBe("Imported Products feed copy.");
	});

	it("creates a daily schedule, runs it now, pauses it and deletes it", async () => {
		const T1 = templateRow({ id: "T1", name: "Products feed", revision: 3 });
		const SRC1 = sourceRow({ id: "SRC1", name: "Feed" });
		let schedules: ScheduleView[] = [];
		const { calls } = mockRoutes(
			site({
				"templates/list": () => pageOf([T1]),
				"sources/list": () => pageOf([SRC1]),
				"schedules/list": () => pageOf(schedules),
				"schedules/fence": () => ({ fence: "clear" }),
				"templates/get": () => ({
					...T1,
					template: {
						version: 1,
						collection: "posts",
						locale: "en",
						key: { from: "id" },
						fields: { title: { from: "title", type: "text" } },
					},
				}),
				"schedules/create": (b) => {
					const input = b as Partial<ScheduleView>;
					const created = schedule({ ...input, id: "SC9", revision: 1, nextRunAt: null });
					schedules = [created];
					return { schedule: created };
				},
				"schedules/run": () => {
					const queued: ScheduleView = { ...schedules[0]!, due: { at: AT, force: true } };
					schedules = [queued];
					return { queued: true, schedule: queued };
				},
				"schedules/update": (b) => {
					const { enabled, revision } = b as { enabled: boolean; revision: number };
					// A disabled schedule is never due (plan Ruling 6): pausing drops the queued run.
					const { due: _due, ...rest } = schedules[0]!;
					const paused = { ...rest, enabled, revision: revision + 1 };
					schedules = [paused];
					return { schedule: paused };
				},
				"schedules/delete": () => {
					schedules = [];
					return { deleted: true };
				},
			}),
		);
		const { user } = openHome();
		await user.click(await screen.findByRole("tab", { name: "Schedules" }));
		await screen.findByText("No schedules yet");

		await user.click(screen.getByRole("button", { name: "New schedule" }));
		const dialog = await screen.findByRole("dialog", { name: "New schedule" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nightly products");
		await choose(user, "Template", "Products feed");
		await choose(user, "URL source", "Feed");
		expect(within(dialog).getByRole("radio", { name: "Daily" })).toBeChecked();
		await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const row = within(await rowOf("Nightly products"));
		expect(announced()).toBe("Created Nightly products.");

		await user.click(screen.getByRole("button", { name: "Run now Nightly products" }));
		expect(await row.findByText("Queued")).toBeVisible();
		expect(announced()).toBe("Queued a run of Nightly products.");

		await user.click(screen.getByRole("switch", { name: "Active: Nightly products" }));
		expect(await row.findByText("Paused")).toBeVisible();
		expect(announced()).toBe("Paused Nightly products.");

		await user.click(screen.getByRole("button", { name: "Actions for Nightly products" }));
		await user.click(await screen.findByRole("menuitem", { name: "Delete Nightly products" }));
		const confirm = await screen.findByRole("dialog", { name: "Delete Nightly products?" });
		await user.click(within(confirm).getByRole("button", { name: "Delete schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(await screen.findByText("No schedules yet")).toBeVisible();
		expect(announced()).toBe("Deleted Nightly products.");

		expect(
			writes(calls, ["schedules/create", "schedules/run", "schedules/update", "schedules/delete"]),
		).toEqual([
			[
				"schedules/create",
				{
					name: "Nightly products",
					templateId: "T1",
					templateRevision: 3,
					sourceId: "SRC1",
					cron: "0 6 * * *",
					publish: true,
				},
			],
			["schedules/run", { id: "SC9" }],
			["schedules/update", { id: "SC9", revision: 1, enabled: false }],
			["schedules/delete", { id: "SC9", revision: 2 }],
		]);
	});

	it("clears the dry runs Preview left behind", async () => {
		const dry = (id: string) => item({ id, dryRun: true, rollbackable: false, createdAt: AT });
		let dryRuns = [dry("D1"), dry("D2"), dry("D3")];
		const { calls } = mockRoutes(
			site({
				"jobs/summaries": (b) =>
					(b as { dryRun: boolean }).dryRun ? pageOf(dryRuns) : pageOf([imported()]),
				"jobs/clear-dry-runs": () => {
					const cleared = dryRuns.length;
					dryRuns = [];
					return { cleared, more: false };
				},
			}),
		);
		const { user } = openHome();
		await rowOf("Products feed");
		await user.click(await screen.findByText("Dry runs: 3"));
		expect(await screen.findAllByText("Products feed")).toHaveLength(4);

		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog", { name: "Clear dry runs" });
		await user.click(within(dialog).getByRole("button", { name: "Clear dry runs" }));
		await waitFor(() => expect(announced()).toBe("Dry runs cleared: 3."));
		// The line goes with them (the live region's "Dry runs cleared" is not the line), and focus,
		// which was on its button, goes to the tab's panel.
		await waitFor(() => expect(screen.queryByText(/^Dry runs: /)).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("tabpanel", { name: "Jobs" }));
		expect(writes(calls, ["jobs/clear-dry-runs"])).toEqual([["jobs/clear-dry-runs", {}]]);
		// The real import stays.
		expect(await rowOf("Products feed")).toBeVisible();
	});

	it("shows each tab's changes from another tab under the host's 60 s staleTime", async () => {
		const LATER = new Date(Date.UTC(2026, 10, 24, 14, 30)).toISOString();
		const scheduled = imported({ origin: "schedule", scheduleId: "SC1" });
		let jobs: JobListItem[] = [scheduled];
		let schedules: ScheduleView[] = [schedule({ templateId: "T1", sourceId: "S1" })];
		const nexts: Record<string, Job[]> = {
			D1: [
				rb({
					id: "D1",
					dryRun: true,
					status: "completed",
					counters: { ...zero, reverted: 10 },
					undo: { deleted: 10, restored: 0, recovered: 0 },
				}),
			],
			R1: [
				rb({
					id: "R1",
					dryRun: false,
					status: "completed",
					counters: { ...zero, reverted: 10 },
					undo: { deleted: 10, restored: 0, recovered: 0 },
				}),
			],
		};
		mockRoutes(
			site({
				"jobs/summaries": (b) => pageOf((b as { dryRun: boolean }).dryRun ? [] : jobs),
				"sources/list": () => pageOf([sourceRow()]),
				"schedules/list": () => pageOf(schedules),
				"schedules/fence": () => ({ fence: "clear" }),
				"schedules/run": () => {
					// The queued run starts at once here: its job is listed from now on.
					jobs = [imported({ id: "J2", createdAt: LATER, status: "running" }), ...jobs];
					return { queued: true, schedule: { ...schedules[0]!, due: { at: LATER, force: true } } };
				},
				"jobs/rollback": (b) =>
					(b as { dryRun: boolean }).dryRun
						? rb({ id: "D1", dryRun: true })
						: rb({ id: "R1", dryRun: false }),
				"jobs/next": (b) => {
					const id = (b as { id: string }).id;
					const reply = nexts[id]?.shift();
					if (!reply) throw new Error(`no next for ${id}`);
					if (id === "R1") {
						// The rollback of a scheduled import pauses its schedule.
						const { due: _due, ...rest } = schedules[0]!;
						schedules = [{ ...rest, enabled: false, pause: { reason: "rolled_back", at: LATER } }];
					}
					return reply;
				},
			}),
		);
		const { user } = openHostHome();
		await rowOf("Products feed");

		await user.click(screen.getByRole("tab", { name: "Schedules" }));
		await user.click(await screen.findByRole("button", { name: "Run now Nightly" }));
		await waitFor(() => expect(announced()).toBe("Queued a run of Nightly."));

		await user.click(screen.getByRole("tab", { name: "Jobs" }));
		expect(
			await screen.findByRole("button", { name: "Actions for Products feed, Today 14:30 UTC" }),
		).toBeVisible();

		await user.click(screen.getByRole("button", { name: `Actions for Products feed, ${WHEN}` }));
		await user.click(
			await screen.findByRole("menuitem", { name: `Roll back Products feed, ${WHEN}` }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Roll back Products feed?" });
		await user.click(await within(dialog).findByRole("button", { name: /^Roll back \d+ entr/ }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		await user.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		await user.click(screen.getByRole("tab", { name: "Schedules" }));
		const row = within(await rowOf("Nightly"));
		expect(await row.findByText("Because an import it ran was rolled back.")).toBeVisible();
	});

	it("moves focus to the Jobs panel when a failed clear's dialog closes over an empty list", async () => {
		const dry = (id: string) => item({ id, dryRun: true, rollbackable: false, createdAt: AT });
		let dryRuns = [dry("D1"), dry("D2")];
		let n = 0;
		mockRoutes(
			site({
				"jobs/summaries": (b) =>
					(b as { dryRun: boolean }).dryRun ? pageOf(dryRuns) : pageOf([imported()]),
				"jobs/clear-dry-runs": () => {
					if (n++ > 0) return fail("VALIDATION_ERROR", "bad", 400);
					dryRuns = [];
					return { cleared: 2, more: true, cursor: "c1" };
				},
			}),
		);
		const { user } = openHome();
		await rowOf("Products feed");
		await user.click(await screen.findByText("Dry runs: 2"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog", { name: "Clear dry runs" });
		await user.click(within(dialog).getByRole("button", { name: "Clear dry runs" }));
		expect(await within(dialog).findByRole("alert")).toBeVisible();
		// The line and its button are gone: focus cannot go back to them.
		await waitFor(() => expect(screen.queryByText(/^Dry runs: /)).toBeNull());
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const panel = screen.getByRole("tabpanel", { name: "Jobs" });
		await waitFor(() => expect(document.activeElement).toBe(panel));
		// Focusable from script only, never a Tab stop.
		expect(panel).toHaveAttribute("tabindex", "-1");
	});

	it("takes no focus on opening a page without dry runs", async () => {
		mockRoutes(
			site({
				"jobs/summaries": (b) => pageOf((b as { dryRun: boolean }).dryRun ? [] : [imported()]),
			}),
		);
		openHome();
		await rowOf("Products feed");
		await waitFor(() =>
			expect(document.querySelectorAll('[aria-label^="Loading"]')).toHaveLength(0),
		);
		expect(document.activeElement).toBe(document.body);
	});

	it("leaves focus where it is when the dry runs go while it is elsewhere", async () => {
		let dryRuns = [item({ id: "D1", dryRun: true, rollbackable: false, createdAt: AT })];
		mockRoutes(
			site({
				"jobs/summaries": (b) =>
					(b as { dryRun: boolean }).dryRun ? pageOf(dryRuns) : pageOf([imported()]),
			}),
		);
		const { queryClient } = openHome();
		await screen.findByText("Dry runs: 1");
		const tab = screen.getByRole("tab", { name: "Jobs" });
		tab.focus();
		// Another tab, or an agent, cleared them.
		dryRuns = [];
		await queryClient.invalidateQueries({ queryKey: queryKeys.dryRuns });
		await waitFor(() => expect(screen.queryByText(/^Dry runs: /)).toBeNull());
		expect(document.activeElement).toBe(tab);
	});

	it("never sends a request without X-EmDash-Request", async () => {
		const { calls } = mockRoutes(
			site({
				"jobs/summaries": (b) => pageOf((b as { dryRun: boolean }).dryRun ? [] : [imported()]),
				"schedules/list": () => pageOf([schedule({ sourceId: "S1" })]),
				"schedules/fence": () => ({ fence: "clear" }),
				"sources/list": () => pageOf([sourceRow()]),
			}),
		);
		// Beneath the harness's own check: every request's header, as the page sent it.
		const answer = globalThis.fetch;
		const headers: (string | null)[] = [];
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : undefined;
			headers.push(new Headers(init?.headers ?? request?.headers).get("X-EmDash-Request"));
			return answer(input, init);
		});
		const { user } = openHome();
		await rowOf("Products feed");
		// Each tab's own list, once it has loaded.
		const shows: [string, string][] = [
			["Templates", "Products feed"],
			["Sources", "Feed"],
			["Schedules", "Nightly"],
			["Jobs", "Products feed"],
		];
		for (const [tab, name] of shows) {
			await user.click(screen.getByRole("tab", { name: tab }));
			await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveAccessibleName(tab));
			await rowOf(name);
		}
		const routes = new Set(calls.map((c) => c.route));
		for (const route of [
			"credentials/list",
			"jobs/summaries",
			"templates/list",
			"sources/list",
			"schedules/list",
			"schedules/fence",
		]) {
			expect(routes).toContain(route);
		}
		expect(headers.length).toBe(calls.length);
		expect(headers.every((h) => h === "1")).toBe(true);
	});
});
