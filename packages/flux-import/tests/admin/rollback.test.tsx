import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import {
	RollbackDialog,
	type RollbackTarget,
} from "../../src/admin/home/jobs/rollback/RollbackDialog.js";
import { queryKeys } from "../../src/admin/queries.js";
import type { Counters, Job } from "../../src/engine/types.js";
import { job } from "./fixtures.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";

const START: RollbackTarget = {
	kind: "start",
	jobId: "J1",
	name: "Products feed",
	when: "Today 10:14 UTC",
	schedule: null,
};

const counters = (over: Partial<Counters> = {}): Counters => ({
	created: 0,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
	reverted: 0,
	...over,
});

/** A rollback job of `J1`. */
const rollbackJob = (over: Partial<Job>): Job =>
	job({
		kind: "rollback",
		rollbackOf: "J1",
		dryRun: false,
		counters: counters(),
		undo: { deleted: 0, restored: 0, recovered: 0 },
		...over,
	});

/** What `jobs/rollback { dryRun: true }` answers: a new dry rollback. */
const DRY = rollbackJob({ id: "D1", dryRun: true });
/** The dry rollback at its end: 2 to delete, 1 to restore, 1 edited since (4 rows). */
const DRY_DONE = rollbackJob({
	id: "D1",
	dryRun: true,
	status: "completed",
	counters: counters({ reverted: 3, conflict: 1 }),
	undo: { deleted: 2, restored: 1, recovered: 0 },
});
/** What `jobs/rollback { dryRun: false }` answers: the real rollback. */
const REAL = rollbackJob({ id: "R1" });
const REAL_HALF = rollbackJob({
	id: "R1",
	status: "running",
	counters: counters({ reverted: 2 }),
	undo: { deleted: 2, restored: 0, recovered: 0 },
});
const REAL_DONE = rollbackJob({
	id: "R1",
	status: "completed",
	counters: counters({ reverted: 3, conflict: 1 }),
	undo: { deleted: 2, restored: 1, recovered: 0 },
});

/** `jobs/next` for the dry rollback: it ends at once. */
const nextScript = (body: unknown): Job => {
	const { id } = body as { id: string };
	if (id === "D1") return DRY_DONE;
	if (id === "R1") return REAL_DONE;
	throw new Error(`no job ${id}`);
};

/** A promise and the function that settles it. */
function gate<T>() {
	let open!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** The page's live region's text (`HomeProvider`'s one `aria-live`, F4). */
const announced = () =>
	[...document.querySelectorAll("div.sr-only[aria-live='polite']")]
		.map((e) => e.textContent ?? "")
		.join("|");

function renderDialog(target: RollbackTarget, onClose = vi.fn()) {
	const result = renderAdmin(
		<HomeProvider initialTab="jobs">
			<RollbackDialog target={target} onClose={onClose} />
		</HomeProvider>,
	);
	return { ...result, onClose };
}

const rollbackBodies = (calls: { route: string; body: unknown }[]) =>
	calls.filter((c) => c.route === "jobs/rollback").map((c) => c.body);

/** The summary's counts, each as "2 to delete Created by this import". */
const tiles = () =>
	within(screen.getByRole("dialog"))
		.getAllByRole("listitem")
		.map((li) => [...li.children].map((c) => c.textContent).join(" "));

/** The summary's confirm button, named with what will change. */
const confirm = (n: number) =>
	screen.findByRole("button", { name: `Roll back ${n} ${n === 1 ? "entry" : "entries"}` });

describe("RollbackDialog", () => {
	it("runs a dry rollback first, then shows its four counts and what will change", async () => {
		const { calls } = mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": nextScript,
		});
		renderDialog(START);
		const roll = await confirm(3);
		expect(roll).toBeEnabled();
		expect(screen.getByText("A dry rollback found 4 entries. 3 will change.")).toBeVisible();
		expect(tiles()).toEqual([
			"2 to delete Created by this import",
			"1 to restore Updated by this import",
			"0 to bring back Moved to Trash or unpublished by it",
			"1 kept Edited since, locked or failed",
		]);
		expect(screen.getByRole("dialog", { name: "Roll back Products feed?" })).toBeVisible();
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
		expect(calls.filter((c) => c.route === "jobs/next").map((c) => c.body)).toEqual([{ id: "D1" }]);
	});

	it("warns when entries are kept, and only then", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		const first = renderDialog(START);
		await confirm(3);
		expect(
			screen.getByText(
				"1 entry was edited since the import, is locked or failed. It is kept as it is.",
			),
		).toBeVisible();
		first.unmount();
		mockRoutes({
			"jobs/rollback": () => DRY,
			"jobs/next": () => ({ ...DRY_DONE, counters: counters({ reverted: 3 }) }),
		});
		renderDialog(START);
		await confirm(3);
		expect(screen.queryByText(/is kept as it is|are kept as they are/)).toBeNull();
	});

	it("names the confirm button with the count in its plural form", async () => {
		mockRoutes({
			"jobs/rollback": () => DRY,
			"jobs/next": () => ({
				...DRY_DONE,
				counters: counters({ reverted: 1 }),
				undo: { deleted: 1, restored: 0, recovered: 0 },
			}),
		});
		renderDialog(START);
		expect(await screen.findByRole("button", { name: "Roll back 1 entry" })).toBeVisible();
		expect(screen.getByText("A dry rollback found 1 entry. 1 will change.")).toBeVisible();
	});

	it("says what is already gone, and that nothing will change when nothing will", async () => {
		mockRoutes({
			"jobs/rollback": () => DRY,
			"jobs/next": () => ({ ...DRY_DONE, counters: counters({ reverted: 3, unchanged: 2 }) }),
		});
		const first = renderDialog(START);
		await confirm(3);
		expect(screen.getByText("2 entries are already gone.")).toBeVisible();
		first.unmount();
		mockRoutes({
			"jobs/rollback": () => DRY,
			"jobs/next": () => ({
				...DRY_DONE,
				counters: counters(),
				undo: { deleted: 0, restored: 0, recovered: 0 },
			}),
		});
		renderDialog(START);
		expect(await screen.findByText("The rollback has no entries to change.")).toBeVisible();
		expect(screen.queryByRole("listitem")).toBeNull();
	});

	it("reads the jobs, the dry runs and the schedules again when the rollback finishes", async () => {
		mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": nextScript,
		});
		const { user, queryClient } = renderDialog(START);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await user.click(await confirm(3));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		// A scheduled import's rollback pauses its schedule.
		for (const queryKey of [queryKeys.jobs, queryKeys.dryRuns, queryKeys.schedules]) {
			expect(invalidate).toHaveBeenCalledWith({ queryKey });
		}
	});
	it("says what it is doing while the dry rollback runs, Roll back waiting disabled", async () => {
		const held = gate<Job>();
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": () => held.promise });
		const { onClose } = renderDialog(START);
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Checking what a rollback would change…",
		);
		expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
		held.open(DRY_DONE);
		expect(await confirm(3)).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes with Cancel while it checks", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": () => new Promise(() => {}) });
		const { user, onClose } = renderDialog(START);
		await screen.findByRole("status");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("falls back to the total for a rollback made before 0.7.0 (Review Focus 2)", async () => {
		const { undo: _undo, ...old } = rollbackJob({
			id: "D1",
			dryRun: true,
			status: "completed",
			counters: counters({ reverted: 3 }),
		});
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": () => old });
		renderDialog(START);
		await confirm(3);
		expect(tiles()).toEqual([
			"3 to roll back Created or updated by this import",
			"0 kept Edited since, locked or failed",
		]);
	});

	it("rolls back only on Roll back, drives it with progress and announces Rollback finished.", async () => {
		const held = gate<Job>();
		let realNexts = 0;
		const { calls } = mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": (b) => {
				if ((b as { id: string }).id === "D1") return DRY_DONE;
				realNexts += 1;
				return realNexts === 1 ? REAL_HALF : held.promise;
			},
		});
		const { user, queryClient, onClose } = renderDialog(START);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const rollBack = await confirm(3);
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
		await user.click(rollBack);
		expect(await screen.findByRole("dialog", { name: "Rolling back Products feed" })).toBeVisible();
		const meter = await screen.findByRole("meter", { name: "Rollback progress" });
		await waitFor(() => expect(meter).toHaveAttribute("aria-valuenow", "2"));
		expect(meter).toHaveAttribute("aria-valuemax", "4");
		expect(screen.getByText("2 of 4 entries")).toBeVisible();
		// Each kind against the dry run's plan: 2 of 2 deleted, 0 of 1 restored.
		expect(
			within(screen.getByRole("dialog"))
				.getAllByRole("listitem")
				.map((li) => [...li.children].map((c) => c.textContent).join(" ")),
		).toEqual(["Deleted 2 of 2", "Restored 0 of 1", "Kept 0"]);
		expect(rollbackBodies(calls)).toEqual([
			{ id: "J1", dryRun: true },
			{ id: "J1", dryRun: false },
		]);
		held.open(REAL_DONE);
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(screen.queryByRole("meter")).toBeNull();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.jobs });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.dryRuns });
		expect(onClose).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("closes with Keep the import after the dry run and sends no real rollback", async () => {
		const { calls } = mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": nextScript,
		});
		const { user, onClose } = renderDialog(START);
		await confirm(3);
		await user.click(screen.getByRole("button", { name: "Keep the import" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
	});

	it("can be closed while the rollback runs, and says how to finish it later", async () => {
		const held = gate<Job>();
		mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": (b) => ((b as { id: string }).id === "D1" ? DRY_DONE : held.promise),
		});
		const { user, onClose } = renderDialog(START);
		await user.click(await confirm(3));
		expect(await screen.findByText("Rolling back…")).toBeVisible();
		// The dialog drives the rollback: closing stops it where it is; its row continues it.
		expect(
			screen.getByText(
				"You can close this. To finish the rollback later, continue it from its row in Jobs.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledOnce();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("closes on Escape before the rollback starts", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		const { user, onClose } = renderDialog(START);
		await confirm(3);
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("says a scheduled job's schedule will be paused", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		renderDialog({ ...START, schedule: { name: "Nightly" } });
		expect(await screen.findByText("Its schedule Nightly will be paused.")).toBeVisible();
	});

	it("still says the schedule will be paused when its name is unknown", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		renderDialog({ ...START, schedule: { name: null } });
		expect(await screen.findByText("Its schedule will be paused.")).toBeVisible();
		expect(screen.queryByText(/Its schedule .+ will be paused/)).toBeNull();
	});

	it("says nothing of a schedule for a job no schedule ran", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		renderDialog(START);
		await confirm(3);
		expect(screen.queryByText(/schedule/)).toBeNull();
	});

	it("offers Continue the rollback when another tab started it first (Review Focus 2)", async () => {
		const R9_DONE = rollbackJob({
			id: "R9",
			status: "completed",
			counters: counters({ reverted: 4 }),
		});
		const { calls } = mockRoutes({
			"jobs/rollback": (b) =>
				(b as { dryRun: boolean }).dryRun
					? DRY
					: fail("INVALID_TRANSITION", "The job was already rolled back (rollback job R9)", 409),
			"jobs/get": (b) =>
				(b as { id: string }).id === "J1"
					? job({ id: "J1", dryRun: false, status: "completed", rolledBackBy: "R9" })
					: rollbackJob({ id: "R9", status: "running" }),
			"jobs/next": (b) => ((b as { id: string }).id === "D1" ? DRY_DONE : R9_DONE),
		});
		const { user } = renderDialog(START);
		await user.click(await confirm(3));
		expect(await screen.findByText("This import is already being rolled back.")).toBeVisible();
		expect(calls.find((c) => c.route === "jobs/get")?.body).toEqual({ id: "J1" });
		await user.click(screen.getByRole("button", { name: "Continue the rollback" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.filter((c) => c.route === "jobs/next").map((c) => c.body)).toEqual([
			{ id: "D1" },
			{ id: "R9" },
		]);
		expect(calls.some((c) => c.route === "jobs/resume")).toBe(false);
	});

	it("offers Continue the rollback when the dry rollback is refused because another tab started it (Review Focus 2)", async () => {
		const { calls } = mockRoutes({
			"jobs/rollback": () =>
				fail("INVALID_TRANSITION", "The job was already rolled back (rollback job R9)", 409),
			"jobs/get": (b) =>
				(b as { id: string }).id === "J1"
					? job({ id: "J1", dryRun: false, status: "completed", rolledBackBy: "R9" })
					: rollbackJob({ id: "R9", status: "running" }),
			"jobs/next": () =>
				rollbackJob({ id: "R9", status: "completed", counters: counters({ reverted: 4 }) }),
		});
		const { user } = renderDialog(START);
		expect(await screen.findByText("This import is already being rolled back.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Continue the rollback" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.map((c) => [c.route, c.body])).toEqual([
			["jobs/rollback", { id: "J1", dryRun: true }],
			["jobs/get", { id: "J1" }],
			["jobs/get", { id: "R9" }],
			["jobs/next", { id: "R9" }],
		]);
	});

	it("resumes the other tab's rollback first when it was paused", async () => {
		const { calls } = mockRoutes({
			"jobs/rollback": (b) =>
				(b as { dryRun: boolean }).dryRun
					? DRY
					: fail("INVALID_TRANSITION", "The job was already rolled back (rollback job R9)", 409),
			"jobs/get": (b) =>
				(b as { id: string }).id === "J1"
					? job({ id: "J1", dryRun: false, status: "completed", rolledBackBy: "R9" })
					: rollbackJob({ id: "R9", status: "paused" }),
			"jobs/resume": () => rollbackJob({ id: "R9", status: "running" }),
			"jobs/next": (b) =>
				(b as { id: string }).id === "D1"
					? DRY_DONE
					: rollbackJob({ id: "R9", status: "completed", counters: counters({ reverted: 4 }) }),
		});
		const { user } = renderDialog(START);
		await user.click(await confirm(3));
		await user.click(await screen.findByRole("button", { name: "Continue the rollback" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.filter((c) => c.route !== "jobs/rollback").map((c) => [c.route, c.body])).toEqual([
			["jobs/next", { id: "D1" }],
			["jobs/get", { id: "J1" }],
			["jobs/get", { id: "R9" }],
			["jobs/resume", { id: "R9" }],
			["jobs/next", { id: "R9" }],
		]);
	});

	it("shows the sentence of a refusal that is not the race, with Try again", async () => {
		mockRoutes({
			"jobs/rollback": (b) =>
				(b as { dryRun: boolean }).dryRun
					? DRY
					: fail(
							"INVALID_TRANSITION",
							"Cannot roll back the job while one of its batches is running",
							409,
						),
			"jobs/get": () => job({ id: "J1", dryRun: false, status: "completed" }),
			"jobs/next": nextScript,
		});
		const { user } = renderDialog(START);
		await user.click(await confirm(3));
		expect(
			await screen.findByText("The import cannot do that in its current state."),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Continue the rollback" })).toBeNull();
	});

	it("continues a paused rollback: resumes it, then drives it", async () => {
		const { calls } = mockRoutes({
			"jobs/resume": () => rollbackJob({ id: "R1", status: "running" }),
			"jobs/next": nextScript,
		});
		renderDialog({ kind: "continue", rollbackId: "R1", status: "paused", name: "Products feed" });
		expect(screen.getByRole("dialog", { name: "Rolling back Products feed" })).toBeVisible();
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.map((c) => [c.route, c.body])).toEqual([
			["jobs/resume", { id: "R1" }],
			["jobs/next", { id: "R1" }],
		]);
	});

	it("continues a running rollback without resuming it", async () => {
		const { calls } = mockRoutes({ "jobs/next": nextScript });
		renderDialog({ kind: "continue", rollbackId: "R1", status: "running", name: "Products feed" });
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.map((c) => c.route)).toEqual(["jobs/next"]);
	});

	it("shows the sentence and Try again when the dry rollback fails", async () => {
		let failing = true;
		const { calls } = mockRoutes({
			"jobs/rollback": () => (failing ? fail("INTERNAL_ERROR", "boom", 500) : DRY),
			"jobs/next": nextScript,
		});
		const { user } = renderDialog(START);
		expect(await screen.findByText("Something went wrong on the server. Try again.")).toBeVisible();
		expect(screen.queryByRole("button", { name: /^Roll back/ })).toBeNull();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await confirm(3)).toBeVisible();
		expect(tiles()[0]).toBe("2 to delete Created by this import");
		expect(rollbackBodies(calls)).toEqual([
			{ id: "J1", dryRun: true },
			{ id: "J1", dryRun: true },
		]);
	});

	it("shows only the sentence after a 403", async () => {
		mockRoutes({ "jobs/rollback": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
		renderDialog(START);
		expect(await screen.findByText("Only administrators can import.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("shows a failed rollback's error and resumes it on Try again", async () => {
		let resumed = false;
		const { calls } = mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/resume": () => {
				resumed = true;
				return rollbackJob({ id: "R1", status: "running" });
			},
			"jobs/next": (b) =>
				(b as { id: string }).id === "D1"
					? DRY_DONE
					: resumed
						? REAL_DONE
						: rollbackJob({
								id: "R1",
								status: "failed",
								error: { code: "internal", message: "kaput" },
							}),
		});
		const { user } = renderDialog(START);
		await user.click(await confirm(3));
		expect(
			await screen.findByText(
				"The import stopped after repeated unexpected errors. Resume it to try again.",
			),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		expect(calls.filter((c) => c.route === "jobs/resume").map((c) => c.body)).toEqual([
			{ id: "R1" },
		]);
	});
});
