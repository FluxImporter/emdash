import { LinkButton } from "@cloudflare/kumo";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { JobsTab } from "../../src/admin/home/jobs/JobsTab.js";
import { runUrl, WIZARD_URL } from "../../src/admin/home/links.js";
import { queryKeys } from "../../src/admin/queries.js";
import type { Counters, Job } from "../../src/engine/types.js";
import type { JobListItem } from "../../src/plugin/summaries.js";
import { job, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteCall, type RouteHandler, renderAdmin } from "./harness.js";
import { item, schedule, templateRow } from "./home-fixtures.js";

/** 15:00 local on 24 Nov 2026: a job made at 10:14 local that day reads "today 10:14". */
const NOW = new Date(2026, 10, 24, 15, 0).getTime();
const AT = new Date(2026, 10, 24, 10, 14).toISOString();
const WHEN = "today 10:14";

const counters = (over: Partial<JobListItem["counters"]> = {}): JobListItem["counters"] => ({
	created: 3,
	updated: 2,
	unchanged: 1,
	failed: 0,
	conflict: 0,
	locked: 0,
	filtered: 0,
	reverted: 0,
	removed: 0,
	...over,
});

/** A real import made today at 10:14 local time. */
const row = (over: Partial<JobListItem> = {}): JobListItem =>
	item({ createdAt: AT, counters: counters(), ...over });

/** `row` without a `templateId`: an import from an inline template. */
function inline(r: JobListItem): JobListItem {
	const { templateId: _, ...rest } = r;
	return rest;
}

const pageOf = <T,>(items: T[], cursor?: string) => ({
	items,
	hasMore: cursor !== undefined,
	...(cursor === undefined ? {} : { cursor }),
});

/** Routes for a Jobs tab showing `items` (one page), no dry runs, one template and one schedule. */
function routes(
	items: JobListItem[] | ((body: { dryRun: boolean; cursor?: string }) => unknown),
	extra: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
	return {
		"jobs/summaries": (b) => {
			const body = b as { dryRun: boolean; cursor?: string };
			if (body.dryRun) return pageOf([]);
			return typeof items === "function" ? items(body) : pageOf(items);
		},
		"templates/list": () => pageOf([templateRow()]),
		"schedules/list": () => pageOf([schedule()]),
		...extra,
	};
}

const real = (calls: RouteCall[]) =>
	calls.filter(
		(c) => c.route === "jobs/summaries" && (c.body as { dryRun: boolean }).dryRun === false,
	);

/** The page's live region's text (`HomeProvider`'s one `aria-live`, F4). */
const announced = () =>
	[...document.querySelectorAll("div.sr-only[aria-live='polite']")]
		.map((e) => e.textContent ?? "")
		.join("|");

function show(opts: { fakeTimers?: boolean } = {}) {
	if (!opts.fakeTimers) vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	return renderAdmin(
		<HomeProvider initialTab="jobs">
			<JobsTab />
		</HomeProvider>,
		opts,
	);
}

/** Opens the row's menu and picks `item` (its accessible name names the row). */
async function pick(
	user: { click(e: Element): Promise<void> },
	name: string,
	action: string,
): Promise<void> {
	await user.click(await screen.findByRole("button", { name: `Actions for ${name}, ${WHEN}` }));
	await user.click(await screen.findByRole("menuitem", { name: `${action} ${name}, ${WHEN}` }));
}

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

/** A rollback job of `J1`, as `jobs/*` answer it. */
const rb = (over: Partial<Job>): Job =>
	job({
		kind: "rollback",
		rollbackOf: "J1",
		counters: zero,
		undo: { deleted: 0, restored: 0, recovered: 0 },
		...over,
	});

/** `window.location.assign`, which `openPage` calls for a full page load. */
const spyAssign = () => vi.spyOn(window.location, "assign").mockImplementation(() => {});

describe("JobsTab", () => {
	it("reads jobs/summaries with dryRun false and never jobs/list (Review Focus 5)", async () => {
		const { calls } = mockRoutes(routes([row()]));
		show();
		await screen.findByRole("table");
		// F12: DryRuns (a child) asks for `dryRun: true` too, possibly first.
		const bodies = calls.filter((c) => c.route === "jobs/summaries").map((c) => c.body);
		expect(bodies).toContainEqual({ dryRun: false });
		for (const body of bodies) expect([{ dryRun: false }, { dryRun: true }]).toContainEqual(body);
		expect(calls.some((c) => c.route === "jobs/list")).toBe(false);
	});

	it("loads the next page with the cursor on Load more (Review Focus 5)", async () => {
		const { calls } = mockRoutes(
			routes((b) =>
				b.cursor === "c1"
					? pageOf([row({ id: "J2", templateId: "T9" })])
					: pageOf([row({ id: "J1" })], "c1"),
			),
		);
		const { user } = show();
		await screen.findByText("Products feed");
		expect(screen.queryByText("Deleted template")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Deleted template")).toBeVisible();
		expect(screen.getByText("Products feed")).toBeVisible();
		expect(real(calls).map((c) => c.body)).toEqual([
			{ dryRun: false },
			{ dryRun: false, cursor: "c1" },
		]);
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("names rows from the template list: One-off import, Deleted template, Rollback of Products feed (Review Focus 5)", async () => {
		mockRoutes(
			routes([
				row({ id: "J1", rolledBackBy: "R1", rollbackStatus: "running", rollbackable: false }),
				inline(row({ id: "J2" })),
				row({ id: "J3", templateId: "T9" }),
				row({
					id: "R1",
					kind: "rollback",
					rollbackOf: "J1",
					status: "running",
					rollbackable: false,
				}),
			]),
		);
		show();
		const table = await screen.findByRole("table");
		const names = within(table)
			.getAllByRole("row")
			.slice(1)
			.map((r) => within(r).getAllByRole("cell")[0]!.textContent);
		expect(names).toEqual([
			"Products feed",
			"One-off import",
			"Deleted template",
			"Rollback of Products feed",
		]);
	});

	it("shows collection and locale, the exact start time as accessible text, origin, status in words and counts", async () => {
		mockRoutes(
			routes([
				row({ id: "J1" }),
				row({ id: "J2", origin: "agent", status: "running", locale: "fr", collection: "pages" }),
				row({ id: "J3", origin: "schedule", scheduleId: "SC1", status: "failed" }),
				row({
					id: "R1",
					kind: "rollback",
					rollbackOf: "J9",
					rollbackable: false,
					counters: counters({ reverted: 4, conflict: 1, locked: 1 }),
				}),
			]),
		);
		show();
		const table = await screen.findByRole("table");
		expect(within(table).getAllByRole("columnheader").length).toBe(7);
		const cells = (n: number) =>
			within(within(table).getAllByRole("row")[n]!)
				.getAllByRole("cell")
				.map((c) => c.textContent);
		const first = cells(1);
		expect(first[1]).toBe("posts · en");
		const time = within(table).getAllByRole("row")[1]!.querySelector("time")!;
		expect(time).toHaveAttribute("datetime", AT);
		expect(time.textContent).toContain(WHEN);
		expect(time.querySelector(".sr-only")?.textContent).toContain("Nov 24, 2026");
		expect(first[3]).toBe("Admin or API");
		expect(first[4]).toBe("Completed");
		expect(first[5]).toBe("Created 3 · Updated 2 · Unchanged 1 · Failed 0");
		expect(cells(2).slice(3, 5)).toEqual(["Agent", "Running"]);
		expect(cells(2)[1]).toBe("pages · fr");
		expect(cells(3).slice(3, 5)).toEqual(["Schedule", "Failed"]);
		expect(cells(4)[5]).toBe("Rolled back 4 · Kept 2");
	});

	it("reads Rolling back while the rollback runs and Rolled back once it is done", async () => {
		vi.useFakeTimers({ now: NOW });
		let done = false;
		const { calls } = mockRoutes(
			routes(() =>
				pageOf([
					row({
						id: "R1",
						kind: "rollback",
						rollbackOf: "J1",
						status: done ? "completed" : "running",
						rollbackable: false,
					}),
					row({
						id: "J1",
						rolledBackBy: "R1",
						rollbackStatus: done ? "completed" : "running",
						rollbackable: false,
					}),
				]),
			),
		);
		show({ fakeTimers: true });
		expect(await screen.findByText("Rolling back")).toBeVisible();
		expect(screen.queryByText("Rolled back")).toBeNull();
		// Plan Ruling 15: a running row refetches the loaded pages every 5 s.
		done = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(await screen.findByText("Rolled back")).toBeVisible();
		expect(screen.queryByText("Rolling back")).toBeNull();
		const after = real(calls).length;
		// Nothing runs now: no more polling.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(real(calls).length).toBe(after);
	});

	it("names each row action with the row: Roll back Products feed, today 10:14", async () => {
		mockRoutes(routes([row({ id: "J1", counters: counters({ failed: 2 }) })]));
		const { user } = show();
		await user.click(
			await screen.findByRole("button", { name: `Actions for Products feed, ${WHEN}` }),
		);
		const items = (await screen.findAllByRole("menuitem")).map((e) => e.getAttribute("aria-label"));
		expect(items).toEqual([
			`Open Products feed, ${WHEN}`,
			`Download log Products feed, ${WHEN}`,
			`Download failed records Products feed, ${WHEN}`,
			`Retry failed records Products feed, ${WHEN}`,
			`Roll back Products feed, ${WHEN}`,
		]);
		expect(
			screen.getByRole("menuitem", { name: `Roll back Products feed, ${WHEN}` }),
		).toHaveTextContent("Roll back");
	});

	it("opens a job's Run screen", async () => {
		const assign = spyAssign();
		mockRoutes(routes([row({ id: "J1" })]));
		const { user } = show();
		await pick(user, "Products feed", "Open");
		expect(assign).toHaveBeenCalledWith(runUrl("J1"));
	});

	it("resumes and retries, then opens the Run screen; a scheduled job's only refreshes and says so", async () => {
		const assign = spyAssign();
		const { calls } = mockRoutes(
			routes(
				[
					row({ id: "J1", status: "paused", rollbackable: false }),
					inline(row({ id: "J2", counters: counters({ failed: 1 }), rollbackable: false })),
					row({
						id: "J3",
						templateId: "T9",
						status: "paused",
						origin: "schedule",
						scheduleId: "SC1",
					}),
				],
				{
					"jobs/resume": (b) => job({ id: (b as { id: string }).id, status: "running" }),
					"jobs/retry": (b) => job({ id: (b as { id: string }).id, status: "running" }),
				},
			),
		);
		const { user } = show();
		await pick(user, "Products feed", "Resume");
		await waitFor(() => expect(assign).toHaveBeenCalledWith(runUrl("J1")));
		await pick(user, "One-off import", "Retry failed records");
		await waitFor(() => expect(assign).toHaveBeenCalledWith(runUrl("J2")));
		expect(calls.filter((c) => c.route === "jobs/resume").map((c) => c.body)).toEqual([
			{ id: "J1" },
		]);
		expect(calls.filter((c) => c.route === "jobs/retry").map((c) => c.body)).toEqual([
			{ id: "J2" },
		]);

		const before = real(calls).length;
		await pick(user, "Deleted template", "Resume");
		await waitFor(() =>
			expect(announced()).toContain("The schedule runs this job; its status updates here."),
		);
		expect(calls.filter((c) => c.route === "jobs/resume").map((c) => c.body)).toEqual([
			{ id: "J1" },
			{ id: "J3" },
		]);
		expect(assign).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(real(calls).length).toBeGreaterThan(before));
	});

	it("pauses a running import and refreshes", async () => {
		const { calls } = mockRoutes(
			routes([row({ id: "J1", status: "running", rollbackable: false })], {
				"jobs/pause": () => job({ id: "J1", status: "paused" }),
			}),
		);
		const { user } = show();
		await screen.findByRole("table");
		const before = real(calls).length;
		await pick(user, "Products feed", "Pause");
		await waitFor(() => expect(announced()).toContain("Paused Products feed."));
		expect(calls.filter((c) => c.route === "jobs/pause").map((c) => c.body)).toEqual([
			{ id: "J1" },
		]);
		await waitFor(() => expect(real(calls).length).toBeGreaterThan(before));
	});

	it("cancels after confirming", async () => {
		const { calls } = mockRoutes(
			routes([row({ id: "J1", status: "running", rollbackable: false })], {
				"jobs/cancel": () => job({ id: "J1", status: "cancelled" }),
			}),
		);
		const { user } = show();
		await pick(user, "Products feed", "Cancel");
		const dialog = await screen.findByRole("dialog", { name: "Cancel the import Products feed?" });
		expect(dialog).toHaveTextContent("Records already written stay.");
		expect(dialog).not.toHaveTextContent(/will be paused/);
		expect(calls.some((c) => c.route === "jobs/cancel")).toBe(false);
		const before = real(calls).length;
		await user.click(within(dialog).getByRole("button", { name: "Cancel the import" }));
		await waitFor(() => expect(announced()).toContain("Cancelled Products feed."));
		expect(calls.filter((c) => c.route === "jobs/cancel").map((c) => c.body)).toEqual([
			{ id: "J1" },
		]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(real(calls).length).toBeGreaterThan(before));
	});

	it("says a scheduled job's cancel pauses its schedule, then reads the schedules again", async () => {
		const { calls } = mockRoutes(
			routes([row({ id: "J1", status: "running", origin: "schedule", scheduleId: "SC1" })], {
				"jobs/cancel": () => job({ id: "J1", status: "cancelled" }),
			}),
		);
		const { user, queryClient } = show();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await pick(user, "Products feed", "Cancel");
		const dialog = await screen.findByRole("dialog", { name: "Cancel the import Products feed?" });
		expect(await within(dialog).findByText("Its schedule Nightly will be paused.")).toBeVisible();
		expect(calls.filter((c) => c.route === "schedules/list")).toHaveLength(1);
		await user.click(within(dialog).getByRole("button", { name: "Cancel the import" }));
		await waitFor(() => expect(announced()).toContain("Cancelled Products feed."));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules });
	});

	it("still says a scheduled job's cancel pauses its schedule when its name cannot be read", async () => {
		mockRoutes(
			routes([row({ id: "J1", status: "running", origin: "schedule", scheduleId: "SC1" })], {
				"schedules/list": () => fail("INTERNAL_ERROR", "boom", 500),
			}),
		);
		const { user, queryClient } = show();
		await pick(user, "Products feed", "Cancel");
		const dialog = await screen.findByRole("dialog", { name: "Cancel the import Products feed?" });
		await waitFor(() =>
			expect(queryClient.getQueryState(queryKeys.schedules)?.status).toBe("error"),
		);
		expect(within(dialog).getByText("Its schedule will be paused.")).toBeVisible();
	});

	it("keeps the import when the cancel is dismissed", async () => {
		const { calls } = mockRoutes(routes([row({ id: "J1", status: "running" })]));
		const { user } = show();
		await pick(user, "Products feed", "Cancel");
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Keep the import" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(calls.some((c) => c.route === "jobs/cancel")).toBe(false);
	});

	it("downloads the log, all and failed only", async () => {
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:log");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { calls } = mockRoutes(
			routes([row({ id: "J1", counters: counters({ failed: 1 }) })], {
				"GET log.csv": () =>
					new Response("id\n", {
						headers: { "content-disposition": 'attachment; filename="log.csv"' },
					}),
			}),
		);
		const { user } = show();
		await screen.findByRole("table");
		await waitFor(() => expect(real(calls)).toHaveLength(1));
		await pick(user, "Products feed", "Download log");
		await waitFor(() => expect(calls.filter((c) => c.route === "GET log.csv")).toHaveLength(1));
		await pick(user, "Products feed", "Download failed records");
		await waitFor(() => expect(calls.filter((c) => c.route === "GET log.csv")).toHaveLength(2));
		// A download changes nothing: the list is not read again.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(real(calls)).toHaveLength(1);
		expect(calls.filter((c) => c.route === "GET log.csv").map((c) => c.path)).toEqual([
			"/_emdash/api/plugins/flux-import/jobs/log.csv?id=J1",
			"/_emdash/api/plugins/flux-import/jobs/log.csv?id=J1&status=failed",
		]);
	});

	it("offers Download failed records only when records failed", async () => {
		mockRoutes(routes([row({ id: "J1" })]));
		const { user } = show();
		await user.click(
			await screen.findByRole("button", { name: `Actions for Products feed, ${WHEN}` }),
		);
		await screen.findAllByRole("menuitem");
		expect(screen.queryByRole("menuitem", { name: /Download failed records/ })).toBeNull();
	});

	it("opens the rollback dialog, and continues an unfinished rollback from its row (Review Focus 2)", async () => {
		const { calls } = mockRoutes(
			routes(
				[
					row({ id: "J1", origin: "schedule", scheduleId: "SC1" }),
					row({
						id: "R1",
						kind: "rollback",
						rollbackOf: "J0",
						status: "paused",
						rollbackable: false,
					}),
				],
				{
					"jobs/rollback": () => rb({ id: "D1", dryRun: true }),
					"jobs/resume": () => rb({ id: "R1", dryRun: false, status: "running" }),
					"jobs/next": (b) =>
						(b as { id: string }).id === "D1"
							? rb({
									id: "D1",
									dryRun: true,
									status: "completed",
									counters: { ...zero, reverted: 2 },
									undo: { deleted: 2, restored: 0, recovered: 0 },
								})
							: rb({ id: "R1", dryRun: false, status: "completed" }),
				},
			),
		);
		const { user } = show();
		await pick(user, "Products feed", "Roll back");
		const dialog = await screen.findByRole("dialog", { name: "Roll back Products feed?" });
		expect(
			await within(dialog).findByText("Entries the import created, to delete: 2"),
		).toBeVisible();
		expect(await within(dialog).findByText("Its schedule Nightly will be paused.")).toBeVisible();
		expect(calls.filter((c) => c.route === "jobs/rollback").map((c) => c.body)).toEqual([
			{ id: "J1", dryRun: true },
		]);
		await user.click(within(dialog).getByRole("button", { name: "Keep the import" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		const before = real(calls).length;
		await pick(user, "Rollback of Products feed", "Continue the rollback");
		await screen.findByRole("dialog", { name: "Roll back Products feed?" });
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(
			calls
				.filter((c) => c.route === "jobs/resume" || c.route === "jobs/next")
				.map((c) => [c.route, c.body]),
		).toEqual([
			["jobs/next", { id: "D1" }],
			["jobs/resume", { id: "R1" }],
			["jobs/next", { id: "R1" }],
		]);
		await waitFor(() => expect(real(calls).length).toBeGreaterThan(before));
	});

	it("retries a finished rollback's conflicts, then drives it in the rollback dialog", async () => {
		const { calls } = mockRoutes(
			routes(
				[
					row({
						id: "R1",
						kind: "rollback",
						rollbackOf: "J1",
						rollbackable: false,
						counters: counters({ reverted: 3, conflict: 1 }),
					}),
				],
				{
					"jobs/retry": () => rb({ id: "R1", status: "running" }),
					"jobs/next": () => rb({ id: "R1", status: "completed" }),
				},
			),
		);
		const { user } = show();
		await pick(user, "Rollback of Products feed", "Retry the rollback");
		await screen.findByRole("dialog", { name: "Roll back Products feed?" });
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(
			calls
				.filter((c) => c.route === "jobs/retry" || c.route === "jobs/next")
				.map((c) => [c.route, c.body]),
		).toEqual([
			["jobs/retry", { id: "R1" }],
			["jobs/next", { id: "R1" }],
		]);
	});

	it("reads the schedules only once a scheduled job's rollback opens", async () => {
		const { calls } = mockRoutes(
			routes(
				[
					row({ id: "J1" }),
					row({ id: "J2", templateId: "T9", origin: "schedule", scheduleId: "SC1" }),
				],
				{
					"jobs/rollback": () => rb({ id: "D1", dryRun: true }),
					"jobs/next": () =>
						rb({
							id: "D1",
							dryRun: true,
							status: "completed",
							counters: { ...zero, reverted: 1 },
							undo: { deleted: 1, restored: 0, recovered: 0 },
						}),
				},
			),
		);
		const { user } = show();
		await screen.findByRole("table");
		await screen.findByText("Deleted template");
		expect(calls.some((c) => c.route === "schedules/list")).toBe(false);
		await pick(user, "Products feed", "Roll back");
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Entries the import created, to delete: 1");
		expect(within(dialog).queryByText(/will be paused/)).toBeNull();
		expect(calls.some((c) => c.route === "schedules/list")).toBe(false);
	});

	it("still says a scheduled job's schedule will be paused when its name cannot be read", async () => {
		mockRoutes(
			routes([row({ id: "J1", origin: "schedule", scheduleId: "SC1" })], {
				"schedules/list": () => fail("INTERNAL_ERROR", "boom", 500),
				"jobs/rollback": () => rb({ id: "D1", dryRun: true }),
				"jobs/next": () =>
					rb({
						id: "D1",
						dryRun: true,
						status: "completed",
						counters: { ...zero, reverted: 1 },
						undo: { deleted: 1, restored: 0, recovered: 0 },
					}),
			}),
		);
		const { user } = show();
		await pick(user, "Products feed", "Roll back");
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Entries the import created, to delete: 1");
		expect(within(dialog).getByText("Its schedule will be paused.")).toBeVisible();
	});

	it("says nothing of a schedule that was deleted since the job ran", async () => {
		mockRoutes(
			routes([row({ id: "J1", origin: "schedule", scheduleId: "SC9" })], {
				"jobs/rollback": () => rb({ id: "D1", dryRun: true }),
				"jobs/next": () =>
					rb({
						id: "D1",
						dryRun: true,
						status: "completed",
						counters: { ...zero, reverted: 1 },
						undo: { deleted: 1, restored: 0, recovered: 0 },
					}),
			}),
		);
		const { user, queryClient } = show();
		await pick(user, "Products feed", "Roll back");
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Entries the import created, to delete: 1");
		await waitFor(() => expect(queryClient.getQueryData(queryKeys.schedules)).toBeDefined());
		expect(within(dialog).queryByText(/will be paused/)).toBeNull();
	});

	it("keeps the rows when Load more fails, and tries the page again", async () => {
		let failing = true;
		mockRoutes(
			routes((b) =>
				b.cursor === "c1"
					? failing
						? fail("INTERNAL_ERROR", "boom", 500)
						: pageOf([row({ id: "J2", templateId: "T9" })])
					: pageOf([row({ id: "J1" })], "c1"),
			),
		);
		const { user } = show();
		await screen.findByText("Products feed");
		await user.click(screen.getByRole("button", { name: "Load more" }));
		expect(
			await screen.findByText(
				"Something went wrong on the server. Try again.",
				{},
				{ timeout: 4000 },
			),
		).toBeVisible();
		expect(screen.getByRole("table")).toBeVisible();
		expect(screen.getByText("Products feed")).toBeVisible();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Deleted template")).toBeVisible();
		expect(screen.queryByText("Something went wrong on the server. Try again.")).toBeNull();
	});

	it("keeps the rows when a poll fails", async () => {
		vi.useFakeTimers({ now: NOW });
		let n = 0;
		mockRoutes(
			routes(() =>
				n++ === 0
					? pageOf([row({ id: "J1", status: "running" })])
					: fail("INTERNAL_ERROR", "boom", 500),
			),
		);
		show({ fakeTimers: true });
		await screen.findByText("Products feed");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		// The retry of a 5xx, a second later.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(await screen.findByText("Something went wrong on the server. Try again.")).toBeVisible();
		expect(screen.getByRole("table")).toBeVisible();
		expect(screen.getByText("Products feed")).toBeVisible();
	});

	it("never shows a job's error message or an upload ID (Review Focus 3)", async () => {
		const secret = `Upload ${UPLOAD_ID} could not be read: token=s3cret`;
		// A server that leaked more than `JobListItem` holds: the row still shows only its own fields.
		const leaky = {
			...row({ id: "J1", status: "failed", errorCode: "internal", rollbackable: false }),
			error: { code: "internal", message: secret },
			uploadId: UPLOAD_ID,
		} as JobListItem;
		mockRoutes(
			routes([leaky], {
				"jobs/resume": () => fail("INTERNAL_ERROR", secret, 500),
			}),
		);
		const { user } = show();
		expect(await screen.findByText("Failed")).toBeVisible();
		await pick(user, "Products feed", "Resume");
		expect(await screen.findByRole("alert")).toBeVisible();
		const text = document.body.textContent ?? "";
		expect(text).not.toContain(UPLOAD_ID);
		expect(text).not.toContain("s3cret");
		expect(text).not.toContain("could not be read");
		expect(document.body.innerHTML).not.toContain(UPLOAD_ID);
	});

	it("names a failure with Try again, and loads again", async () => {
		let failing = true;
		mockRoutes(routes(() => (failing ? fail("INTERNAL_ERROR", "boom", 500) : pageOf([row()]))));
		const { user } = show();
		// A 5xx is retried once (`queries.ts`), about a second later, before it shows.
		expect(
			await screen.findByText(
				"Something went wrong on the server. Try again.",
				{},
				{ timeout: 4000 },
			),
		).toBeVisible();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("table")).toBeVisible();
	});

	it("offers no Try again after a 403", async () => {
		mockRoutes(routes(() => fail("FORBIDDEN", "No", 403)));
		show();
		expect(await screen.findByText("Only administrators can import.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("shows the empty state with New import", async () => {
		mockRoutes(routes([]));
		show();
		expect(await screen.findByText("No imports yet.")).toBeVisible();
		const link = screen.getByRole("link", { name: "New import" });
		expect(link).toHaveAttribute("href", WIZARD_URL);
		// The empty page's one action looks like a button (Task 16: the default variant read as text).
		const { container } = render(
			<LinkButton variant="primary" href="/x">
				x
			</LinkButton>,
		);
		expect(link.className).toBe((container.firstElementChild as HTMLElement).className);
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("shows a loader with a name while the list loads", async () => {
		mockRoutes(routes(() => new Promise(() => {})));
		show();
		expect(await screen.findByLabelText("Loading the imports")).toBeInTheDocument();
	});
});
