import { screen, waitFor } from "@testing-library/react";
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
	when: "today 10:14",
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

describe("RollbackDialog", () => {
	it("runs a dry rollback first and says exactly what it will delete, restore and bring back", async () => {
		const { calls } = mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": nextScript,
		});
		renderDialog(START);
		expect(await screen.findByText("Entries the import created, to delete: 2")).toBeVisible();
		expect(
			screen.getByText("Entries it updated, to restore to their earlier version: 1"),
		).toBeVisible();
		expect(screen.getByText("Entries edited since, which stay as they are: 1")).toBeVisible();
		expect(screen.queryByText(/to bring back/)).toBeNull();
		expect(screen.getByRole("dialog", { name: "Roll back Products feed?" })).toBeVisible();
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
		expect(calls.filter((c) => c.route === "jobs/next").map((c) => c.body)).toEqual([{ id: "D1" }]);
	});

	it("reads the jobs, the dry runs and the schedules again when the rollback finishes", async () => {
		mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": nextScript,
		});
		const { user, queryClient } = renderDialog(START);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
		await waitFor(() => expect(announced()).toContain("Rollback finished."));
		// A scheduled import's rollback pauses its schedule.
		for (const queryKey of [queryKeys.jobs, queryKeys.dryRuns, queryKeys.schedules]) {
			expect(invalidate).toHaveBeenCalledWith({ queryKey });
		}
	});
	it("says what it is doing while the dry rollback runs", async () => {
		const held = gate<Job>();
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": () => held.promise });
		renderDialog(START);
		expect(await screen.findByText("Checking what the rollback will do…")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
		held.open(DRY_DONE);
		expect(await screen.findByRole("button", { name: "Roll back" })).toBeEnabled();
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
		expect(await screen.findByText("Entries to roll back: 3")).toBeVisible();
		expect(screen.queryByText(/to delete/)).toBeNull();
		expect(screen.queryByText(/to restore/)).toBeNull();
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
		const rollBack = await screen.findByRole("button", { name: "Roll back" });
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
		await user.click(rollBack);
		const meter = await screen.findByRole("meter");
		await waitFor(() => expect(meter).toHaveAttribute("aria-valuenow", "2"));
		expect(meter).toHaveAttribute("aria-valuemax", "4");
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
		await user.click(await screen.findByRole("button", { name: "Keep the import" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(rollbackBodies(calls)).toEqual([{ id: "J1", dryRun: true }]);
	});

	it("does not close on Escape while the rollback runs", async () => {
		const held = gate<Job>();
		mockRoutes({
			"jobs/rollback": (b) => ((b as { dryRun: boolean }).dryRun ? DRY : REAL),
			"jobs/next": (b) => ((b as { id: string }).id === "D1" ? DRY_DONE : held.promise),
		});
		const { user, onClose } = renderDialog(START);
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
		expect(await screen.findByText("Rolling back…")).toBeVisible();
		expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Roll back Products feed?" })).toBeVisible();
	});

	it("closes on Escape before the rollback starts", async () => {
		mockRoutes({ "jobs/rollback": () => DRY, "jobs/next": nextScript });
		const { user, onClose } = renderDialog(START);
		await screen.findByRole("button", { name: "Roll back" });
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
		await screen.findByRole("button", { name: "Roll back" });
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
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
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
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
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
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
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
		expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Entries the import created, to delete: 2")).toBeVisible();
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
		await user.click(await screen.findByRole("button", { name: "Roll back" }));
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
