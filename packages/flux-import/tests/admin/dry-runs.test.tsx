import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { DryRuns } from "../../src/admin/home/jobs/dry-runs/DryRuns.js";
import { STATUS_MESSAGES } from "../../src/admin/home/jobs/status.js";
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
			<DryRuns names={names} />
			<p>sentinel</p>
		</HomeProvider>,
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
