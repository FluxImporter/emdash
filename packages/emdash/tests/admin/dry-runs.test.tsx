import { screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { HomeProvider, useHome } from "../../src/admin/home/Home.js";
import { DryRuns } from "../../src/admin/home/jobs/dry-runs/DryRuns.js";
import { STATUS_MESSAGES } from "../../src/admin/home/jobs/status.js";
import { queryKeys } from "../../src/admin/queries.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";
import { item } from "./home-fixtures.js";

const names = (i: { id: string }) => `Name of ${i.id}`;
const dry = (id: string, over = {}) => item({ id, dryRun: true, rollbackable: false, ...over });
const THREE = {
	items: [
		dry("D1"),
		dry("D2", { status: "failed" }),
		dry("D3", { collection: "pages", locale: "fr" }),
	],
};
const page = (n: number, more = false) => ({
	items: Array.from({ length: n }, (_, i) => dry(`D${i}`)),
	...(more ? { cursor: "p2" } : {}),
});

function show() {
	return renderAdmin(
		<HomeProvider>
			<Panel>
				<DryRuns names={names} />
				<p>sentinel</p>
			</Panel>
		</HomeProvider>,
	);
}

/** The open tab's panel as `Home` renders it: `focusHeading` focuses it. */
function Panel(props: { children: ReactNode }) {
	const { headingRef } = useHome();
	return (
		<div ref={headingRef} tabIndex={-1} role="tabpanel" aria-label="Jobs">
			{props.children}
		</div>
	);
}

describe("DryRuns", () => {
	it("shows one collapsed line, 3 dry runs, and nothing without dry runs", async () => {
		mockRoutes({ "jobs/summaries": () => THREE });
		const first = show();
		expect(await screen.findByText("Dry runs: 3")).toBeVisible();
		expect(screen.queryByText("Name of D1")).toBeNull();
		first.unmount();
		mockRoutes({ "jobs/summaries": () => ({ items: [] }) });
		const { container } = show();
		await screen.findByText("sentinel");
		await waitFor(() => expect(container.textContent).not.toContain("Dry runs"));
	});
	it("says they are not written to the site, offers Clear dry runs closed, and opens as a disclosure", async () => {
		mockRoutes({ "jobs/summaries": () => THREE });
		const { user } = show();
		const trigger = await screen.findByRole("button", { name: "Dry runs: 3" });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByText("Not written to the site.")).toBeVisible();
		expect(screen.getByRole("button", { name: "Clear dry runs" })).toBeVisible();
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(await screen.findByText("Name of D1")).toBeVisible();
	});
	it("says more than 8 when the first page has more", async () => {
		mockRoutes({ "jobs/summaries": () => page(8, true) });
		show();
		expect(await screen.findByText("Dry runs: more than 8")).toBeVisible();
	});
	it("expands to a short list with name, collection and locale, when and status", async () => {
		mockRoutes({ "jobs/summaries": () => THREE });
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		expect(await screen.findByText("Name of D1")).toBeVisible();
		// Written as the Jobs table writes it (Task 16), not "pages (fr)".
		expect(screen.getByText("pages \u00b7 fr")).toBeVisible();
		expect(screen.getAllByText("posts \u00b7 en").length).toBeGreaterThan(0);
		expect(screen.getByText("Failed")).toBeVisible();
		expect(screen.getAllByText("Completed").length).toBe(2);
		expect(document.querySelectorAll("time").length).toBe(3);
		expect(STATUS_MESSAGES.completed.message).toBe("Completed");
	});
	it("clears after confirming, following the cursor while more, and announces the count", async () => {
		const { calls } = mockRoutes({
			"jobs/summaries": () => THREE,
			"jobs/clear-dry-runs": (b) =>
				(b as { cursor?: string }).cursor
					? { cleared: 4, more: false }
					: { cleared: 8, more: true, cursor: "c1" },
		});
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent(
			"Clear the finished and idle dry runs, with their staged files?",
		);
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		expect(await screen.findByText("Dry runs cleared: 12.")).toBeInTheDocument();
		expect(calls.filter((c) => c.route === "jobs/clear-dry-runs").map((c) => c.body)).toEqual([
			{},
			{ cursor: "c1" },
		]);
		await waitFor(() =>
			expect(calls.filter((c) => c.route === "jobs/summaries").length).toBeGreaterThan(1),
		);
	});
	it("moves focus to the tab's panel, not the page, when clearing by keyboard empties the line", async () => {
		let items = THREE.items;
		mockRoutes({
			"jobs/summaries": () => ({ items }),
			"jobs/clear-dry-runs": () => {
				items = [];
				return { cleared: 3, more: false };
			},
		});
		const { user } = show();
		const clear = await screen.findByRole("button", { name: "Clear dry runs" });
		clear.focus();
		await user.keyboard("{Enter}");
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		buttons[buttons.length - 1]!.focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(screen.queryByText("Dry runs: 3")).toBeNull());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tabpanel")));
	});
	it("sends no cursor when a call was cut short", async () => {
		let n = 0;
		const { calls } = mockRoutes({
			"jobs/summaries": () => THREE,
			"jobs/clear-dry-runs": () =>
				[
					{ cleared: 1, more: true, cursor: "c1" },
					{ cleared: 1, more: true },
					{ cleared: 1, more: false },
				][n++],
		});
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		expect(await screen.findByText("Dry runs cleared: 3.")).toBeInTheDocument();
		expect(calls.filter((c) => c.route === "jobs/clear-dry-runs").map((c) => c.body)).toEqual([
			{},
			{ cursor: "c1" },
			{},
		]);
	});
	it("says why nothing was cleared", async () => {
		mockRoutes({
			"jobs/summaries": () => THREE,
			"jobs/clear-dry-runs": () => ({ cleared: 0, more: false }),
		});
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		expect(
			await screen.findByText(
				"No dry runs could be cleared now: running ones, and an agent's from the last 24 hours, are kept.",
			),
		).toBeInTheDocument();
	});
	it("stops after 50 calls", async () => {
		const { calls } = mockRoutes({
			"jobs/summaries": () => THREE,
			"jobs/clear-dry-runs": () => ({ cleared: 1, more: true, cursor: "again" }),
		});
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		expect(await screen.findByText("Dry runs cleared: 50.")).toBeInTheDocument();
		expect(calls.filter((c) => c.route === "jobs/clear-dry-runs")).toHaveLength(50);
	});
	it("keeps the dialog and its failure when a partial clear empties the list", async () => {
		let items = THREE.items;
		let n = 0;
		mockRoutes({
			"jobs/summaries": () => ({ items }),
			"jobs/clear-dry-runs": () => {
				if (n++ > 0) return fail("VALIDATION_ERROR", "bad", 400);
				items = [];
				return { cleared: 3, more: true, cursor: "c1" };
			},
		});
		const { user, queryClient } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		// The cleared ones are read again: none are left, so the line goes, not the dialog.
		await waitFor(() =>
			expect(queryClient.getQueryData<{ items: unknown[] }>(queryKeys.dryRuns)?.items).toEqual([]),
		);
		await waitFor(() => expect(screen.queryByText("Dry runs: 3")).toBeNull());
		const alert = within(screen.getByRole("dialog")).getByRole("alert");
		expect(alert).toHaveTextContent("The request was not valid.");
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
	it("names a failure in the dialog and keeps it open", async () => {
		mockRoutes({
			"jobs/summaries": () => THREE,
			"jobs/clear-dry-runs": () => fail("INTERNAL", "boom", 500),
		});
		const { user } = show();
		await user.click(await screen.findByText("Dry runs: 3"));
		await user.click(screen.getByRole("button", { name: "Clear dry runs" }));
		const dialog = await screen.findByRole("dialog");
		const buttons = dialog.querySelectorAll("button");
		await user.click(buttons[buttons.length - 1]!);
		await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent(/\w/u));
		expect(screen.getByRole("dialog").querySelector('[role="alert"]')).not.toBeNull();
	});
});
