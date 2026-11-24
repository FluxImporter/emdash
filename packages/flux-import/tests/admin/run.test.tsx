import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { WizardProvider } from "../../src/admin/wizard/context.js";
import { RunStep } from "../../src/admin/wizard/run/RunStep.js";
import { DEFAULT_OPTIONS, type WizardState } from "../../src/admin/wizard/state.js";
import { templateSchema } from "../../src/engine/template.js";
import type { Counters, Job } from "../../src/engine/types.js";
import { job, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteCall, renderAdmin } from "./harness.js";

/** The file the Source step chose; the run must not read it again (Coordinator's call 2). */
const SOURCE_UPLOAD = `01JZ0000000000000000000001${"a".repeat(32)}`;
/** The dry run's staged copy, which the run imports. */
const DRY_UPLOAD = UPLOAD_ID;
const JOB_ID = "01JZ00000000000000000RUN01";
const CONTENT_LINK = "/_emdash/admin/content/posts";
const LEAVING =
	"Leaving this page pauses nothing: the import stays open and you can come back to it at this address.";

/** A draft that has finished its dry run of four records. */
function draft(over: Partial<WizardState> = {}): Partial<WizardState> {
	return {
		step: "run",
		source: { kind: "upload", uploadId: SOURCE_UPLOAD, label: "posts.csv" },
		sourceBlock: { format: "csv" },
		columns: [
			{ key: "id", values: ["1"] },
			{ key: "title", values: ["A"] },
		],
		target: { collection: "posts", locale: "en", translationLocale: null },
		rows: { key: { from: "id" }, "field:title": { from: "title", type: "text" } },
		meta: {},
		dryRun: { jobId: "01JZ00000000000000000DRY01", uploadId: DRY_UPLOAD, total: 4 },
		...over,
	};
}

/** The state the shell leaves after `jobReopened` for `?job=<id>`. */
const reopened: Partial<WizardState> = { step: "run", run: { jobId: JOB_ID } };

const counters = (created: number, over: Partial<Counters> = {}): Counters => ({
	created,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
	...over,
});

/** The real job of `draft()`, running. */
const real = (over: Partial<Job> = {}): Job =>
	job({ id: JOB_ID, dryRun: false, publish: true, status: "running", ...over });

/** Each call answers the next reply; the last one repeats. */
function replies(...list: unknown[]): () => unknown {
	let i = 0;
	return () => list[Math.min(i++, list.length - 1)];
}

/** A reply held until `open` is called. */
function gate<T = unknown>() {
	let open!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const named = (calls: RouteCall[], route: string) => calls.filter((c) => c.route === route);

function renderRun(initial: Partial<WizardState>, opts: { fakeTimers?: boolean } = {}) {
	return renderAdmin(
		<WizardProvider initial={initial}>
			<RunStep />
		</WizardProvider>,
		opts,
	);
}

/** The value shown beside a counter's label. */
function counter(label: string): string | null {
	const term = screen.getByText(label, { selector: "dt" });
	return term.nextElementSibling?.textContent ?? null;
}

/** Lets fake timers run `ms` and the promises they release settle. */
async function tick(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}
}

describe("the Run step", () => {
	it("runs exactly the previewed upload: jobs/create with the dry run's uploadId, not a sourceId", async () => {
		const { calls } = mockRoutes({
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": () => real({ status: "completed", counters: counters(4) }),
		});
		renderRun(draft());
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(named(calls, "templates/create")).toEqual([]);
		const [create, ...more] = named(calls, "jobs/create");
		expect(more).toEqual([]);
		const body = create!.body as Record<string, unknown>;
		expect(body.uploadId).toBe(DRY_UPLOAD);
		expect(body).not.toHaveProperty("sourceId");
		expect(body).toMatchObject({ dryRun: false, publish: true, journal: true });
		expect(body.template).toMatchObject({ rules: { owner: "wizard-posts-en" } });
		expect(named(calls, "jobs/next").map((c) => c.body)).toEqual([{ id: JOB_ID }]);
	});

	it("saves a new template first and runs from its id and revision", async () => {
		const { calls } = mockRoutes({
			"templates/create": (body) => {
				const { name, template } = body as { name: string; template: unknown };
				// The server stores the template as the engine parsed it, defaults filled in (F9).
				const parsed = templateSchema.parse(template);
				return {
					template: {
						id: "tpl-1",
						name,
						template: parsed,
						revision: 3,
						collection: "posts",
						locale: "en",
						owner: parsed.rules?.owner,
						format: "csv",
						createdAt: "2026-11-23T12:00:00.000Z",
						updatedAt: "2026-11-23T12:00:00.000Z",
						createdBy: "u",
						updatedBy: "u",
					},
					check: { problems: [], warnings: [] },
				};
			},
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": () => real({ status: "completed", counters: counters(4) }),
		});
		renderRun(
			draft({
				options: {
					...DEFAULT_OPTIONS,
					save: { kind: "new", name: "Posts feed" },
				},
			}),
		);
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(calls.map((c) => c.route).slice(0, 2)).toEqual(["templates/create", "jobs/create"]);
		const saved = named(calls, "templates/create")[0]!.body as {
			name: string;
			template: { rules: { owner: string } };
		};
		expect(saved.name).toBe("Posts feed");
		expect(saved.template.rules.owner).toBe("posts-feed");
		const body = named(calls, "jobs/create")[0]!.body as Record<string, unknown>;
		expect(body).toMatchObject({ templateId: "tpl-1", templateRevision: 3, uploadId: DRY_UPLOAD });
		expect(body).not.toHaveProperty("template");
	});

	it("never saves a template choice that is no longer on offer: an unedited base runs by id", async () => {
		const { calls } = mockRoutes({
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": () => real({ status: "completed", counters: counters(4) }),
		});
		const template = templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: { title: { from: "title", type: "text" } },
		});
		renderRun(
			draft({
				base: { id: "tpl-9", revision: 2, name: "Posts", template },
				// Left over from while the template was edited; the edits were undone since.
				options: { ...DEFAULT_OPTIONS, save: { kind: "new", name: "Posts copy" } },
			}),
		);
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(named(calls, "templates/create")).toEqual([]);
		const body = named(calls, "jobs/create")[0]!.body as Record<string, unknown>;
		expect(body).toMatchObject({ templateId: "tpl-9", templateRevision: 2, uploadId: DRY_UPLOAD });
	});

	it("puts ?job=<id> in the URL and shows a determinate bar from the dry run's total", async () => {
		const held = gate();
		mockRoutes({
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": replies(real({ counters: counters(2) }), held.promise),
		});
		window.history.replaceState({ router: 1 }, "", "/import?step=run");
		renderRun(draft());
		const meter = await screen.findByRole("meter");
		await waitFor(() => expect(meter).toHaveAttribute("aria-valuenow", "2"));
		expect(meter).toHaveAttribute("aria-valuemax", "4");
		expect(screen.getByText("2 of 4 records")).toBeVisible();
		expect(screen.queryByRole("progressbar")).toBeNull();
		const params = new URLSearchParams(window.location.search);
		expect(params.get("job")).toBe(JOB_ID);
		expect(params.get("step")).toBe("run");
		expect(window.history.state).toEqual({ router: 1 });
		expect(screen.getByText(LEAVING)).toBeVisible();
		expect(counter("Created")).toBe("2");
		held.open(real({ status: "completed", counters: counters(4) }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(screen.queryByText(LEAVING)).toBeNull();
	});

	it("shows records per second and the time left from the dry run's total", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		const third = gate();
		const held = gate();
		let n = 0;
		mockRoutes({
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": () => {
				n += 1;
				if (n === 3) return third.promise;
				if (n > 3) return held.promise;
				// One record a second.
				vi.setSystemTime(start + n * 1000);
				return real({ counters: counters(n), cursor: { offset: n, seq: n } });
			},
		});
		renderRun(draft({ dryRun: { jobId: "D", uploadId: DRY_UPLOAD, total: 62 } }));
		expect(await screen.findByText("Records per second: 1")).toBeVisible();
		expect(screen.getByText("About 1 minute left")).toBeVisible();
		// Every record read, the missing phase still to come: a rate, but no time left.
		vi.setSystemTime(start + 3000);
		third.open(real({ counters: counters(62), cursor: { offset: 62, seq: 62 } }));
		expect(await screen.findByText("62 of 62 records")).toBeVisible();
		expect(screen.getByText(/^Records per second/)).toBeVisible();
		expect(screen.queryByText(/left$/)).toBeNull();
		held.open(real({ status: "completed", counters: counters(62) }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
	});

	it("reopens ?job= with a live lease: waits, then counts (Review Focus 1)", async () => {
		vi.useFakeTimers();
		const lease = { holder: "other-tab", expiresAt: Date.now() + 30_000 };
		const held = real({ counters: counters(1), cursor: { offset: 1, seq: 1 }, lease });
		const { calls } = mockRoutes({
			"jobs/get": () => held,
			"jobs/next": replies(
				held,
				held,
				real({ counters: counters(3), cursor: { offset: 3, seq: 3 } }),
				real({ status: "completed", counters: counters(4) }),
			),
		});
		renderRun(reopened, { fakeTimers: true });
		// One live region from the first render on, whose text changes (review minor 3).
		const live = screen.getByText("Starting the import");
		expect(live).toHaveAttribute("aria-live", "polite");
		// The spinner beside it is not announced a second time (review minor 5).
		expect(screen.queryByRole("status")).toBeNull();
		await tick();
		expect(live).toHaveTextContent("Waiting for the previous batch to finish");
		expect(named(calls, "jobs/next")).toHaveLength(1);
		await tick(2000);
		expect(screen.getByText("Waiting for the previous batch to finish")).toBeVisible();
		expect(named(calls, "jobs/next")).toHaveLength(2);
		await tick(2000);
		expect(screen.getByText("The import is complete.")).toBeVisible();
		expect(screen.queryByText("Waiting for the previous batch to finish")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText(/went wrong/)).toBeNull();
		expect(named(calls, "jobs/next")).toHaveLength(4);
		expect(named(calls, "jobs/get").map((c) => c.body)).toEqual([{ id: JOB_ID }]);
		expect(counter("Created")).toBe("4");
		expect(live).toBeInTheDocument();
		expect(live).toHaveTextContent("The import is complete.");
	});

	it("shows an indeterminate bar for a reopened job", async () => {
		const held = gate();
		mockRoutes({
			"jobs/get": () => real({ counters: counters(5) }),
			"jobs/next": replies(real({ counters: counters(6) }), held.promise),
		});
		renderRun(reopened);
		const bar = await screen.findByRole("progressbar", { name: "Import progress" });
		expect(screen.getByText("Import progress")).toBeVisible();
		expect(bar).not.toHaveAttribute("value");
		expect(bar).not.toHaveAttribute("aria-valuenow");
		expect(screen.queryByRole("meter")).toBeNull();
		await waitFor(() => expect(counter("Created")).toBe("6"));
		expect(screen.queryByText(/left$/)).toBeNull();
		held.open(real({ status: "completed", counters: counters(6) }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(screen.queryByRole("progressbar")).toBeNull();
	});

	it("shows no progress bar for a reopened paused job without a total", async () => {
		const paused = real({ status: "paused", counters: counters(5) });
		mockRoutes({ "jobs/get": () => paused, "jobs/next": () => paused });
		renderRun(reopened);
		expect(await screen.findByText("The import is paused.")).toBeVisible();
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.queryByText("Import progress")).toBeNull();
	});

	it("pauses, resumes and cancels with confirmation", async () => {
		const { calls } = mockRoutes({
			"jobs/get": () => real({ counters: counters(1) }),
			"jobs/next": () => real({ counters: counters(1) }),
			"jobs/pause": () => real({ status: "paused", counters: counters(1) }),
			"jobs/resume": () => real({ status: "running", counters: counters(1) }),
			"jobs/cancel": () => real({ status: "cancelled", counters: counters(1) }),
		});
		const { user } = renderRun(reopened);
		await user.click(await screen.findByRole("button", { name: "Pause" }));
		expect(await screen.findByText("The import is paused.")).toBeVisible();
		expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		const nextsWhilePaused = named(calls, "jobs/next").length;

		await user.click(screen.getByRole("button", { name: "Resume" }));
		await waitFor(() => expect(named(calls, "jobs/next").length).toBeGreaterThan(nextsWhilePaused));
		expect(screen.queryByText("The import is paused.")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Cancel import" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(named(calls, "jobs/cancel")).toEqual([]);
		await user.click(within(dialog).getByRole("button", { name: "Keep importing" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(named(calls, "jobs/cancel")).toEqual([]);

		await user.click(screen.getByRole("button", { name: "Cancel import" }));
		const again = await screen.findByRole("alertdialog");
		await user.click(within(again).getByRole("button", { name: "Cancel import" }));
		expect(await screen.findByText("The import was cancelled.")).toBeVisible();
		const controls = calls
			.map((c) => c.route)
			.filter((r) => r === "jobs/pause" || r === "jobs/resume" || r === "jobs/cancel");
		expect(controls).toEqual(["jobs/pause", "jobs/resume", "jobs/cancel"]);
		for (const route of controls) expect(named(calls, route)[0]!.body).toEqual({ id: JOB_ID });
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
	});

	it("downloads the failed-records log through apiFetch", async () => {
		const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:log");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { calls } = mockRoutes({
			"jobs/get": () => real({ status: "completed", counters: counters(3, { failed: 1 }) }),
			"jobs/next": () => real({ status: "completed", counters: counters(3, { failed: 1 }) }),
			"GET log.csv": () =>
				new Response("record,status\n4,failed\n", {
					headers: {
						"content-type": "text/csv; charset=utf-8",
						"content-disposition": `attachment; filename="flux-import-${JOB_ID}.csv"`,
					},
				}),
		});
		const { user } = renderRun(reopened);
		await user.click(await screen.findByRole("button", { name: "Download failed records" }));
		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(named(calls, "GET log.csv").map((c) => c.path)).toEqual([
			`/_emdash/api/plugins/flux-import/jobs/log.csv?id=${JOB_ID}&status=failed`,
		]);
		expect(await (create.mock.calls[0]![0] as Blob).text()).toBe("record,status\n4,failed\n");

		await user.click(screen.getByRole("button", { name: "Download log" }));
		await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
		expect(named(calls, "GET log.csv")[1]!.path).toBe(
			`/_emdash/api/plugins/flux-import/jobs/log.csv?id=${JOB_ID}`,
		);
	});

	it("shows a log the server refuses as a sentence", async () => {
		mockRoutes({
			"jobs/get": () => real({ status: "completed", counters: counters(3) }),
			"jobs/next": () => real({ status: "completed", counters: counters(3) }),
			"GET log.csv": () => fail("LOG_TOO_LARGE", "The log has more than 100000 rows", 413),
		});
		const { user } = renderRun(reopened);
		await user.click(await screen.findByRole("button", { name: "Download log" }));
		expect(
			await screen.findByText(
				"The log is too large to download at once. Download the failed records only.",
			),
		).toBeVisible();
	});

	it("offers Retry failed records after completion with failures", async () => {
		const done = real({ status: "completed", counters: counters(3, { failed: 1 }) });
		const retrying = real({ phase: "retry", counters: counters(3, { failed: 1 }) });
		const held = gate();
		// Each reply a second after the one before, so the driver measures a rate (of 0).
		vi.useFakeTimers({ toFake: ["Date"] });
		const answer = replies(done, retrying, retrying, held.promise);
		const { calls } = mockRoutes({
			"jobs/create": () => real({ status: "created" }),
			"jobs/next": () => {
				vi.setSystemTime(Date.now() + 1000);
				return answer();
			},
			"jobs/retry": () => retrying,
		});
		const { user } = renderRun(draft());
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(counter("Failed")).toBe("1");
		expect(screen.getByRole("link", { name: "View the entries" })).toHaveAttribute(
			"href",
			CONTENT_LINK,
		);
		expect(screen.getByRole("button", { name: "Download log" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Retry failed records" }));
		expect(await screen.findByText("Retrying failed records")).toBeVisible();
		await waitFor(() => expect(named(calls, "jobs/next")).toHaveLength(4));
		// The retry pass recounts, so the counters' sum stands still: no rate of 0 is shown.
		expect(screen.queryByText(/^Records per second/)).toBeNull();
		expect(named(calls, "jobs/retry").map((c) => c.body)).toEqual([{ id: JOB_ID }]);
		const order = calls.map((c) => c.route);
		expect(order.indexOf("jobs/retry")).toBeLessThan(order.lastIndexOf("jobs/next"));
		held.open(real({ status: "completed", counters: counters(4) }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Retry failed records" })).toBeNull();
	});

	it("shows a reopened dry run's counts, and no Retry", async () => {
		const dry = job({ id: JOB_ID, status: "completed", counters: counters(2, { failed: 1 }) });
		mockRoutes({ "jobs/get": () => dry, "jobs/next": () => dry });
		renderRun(reopened);
		expect(await screen.findByText("This was a dry run: nothing was written.")).toBeVisible();
		expect(counter("Created")).toBe("2");
		expect(counter("Failed")).toBe("1");
		expect(screen.queryByRole("button", { name: "Retry failed records" })).toBeNull();
		expect(screen.queryByRole("link", { name: "View the entries" })).toBeNull();
	});

	it("shows the error and Try again after the driver gives up", async () => {
		vi.useFakeTimers();
		let failures = 0;
		const { calls } = mockRoutes({
			"jobs/get": () => real({ counters: counters(1) }),
			"jobs/next": () => {
				if (failures < 4) {
					failures += 1;
					return fail("INTERNAL_ERROR", "Worker overloaded", 503);
				}
				return real({ status: "completed", counters: counters(4) });
			},
		});
		const { user } = renderRun(reopened, { fakeTimers: true });
		await tick();
		expect(screen.getByText("Connection lost; retrying (1 of 3)")).toBeVisible();
		await tick(1000);
		expect(screen.getByText("Connection lost; retrying (2 of 3)")).toBeVisible();
		await tick(3000);
		expect(screen.getByText("Connection lost; retrying (3 of 3)")).toBeVisible();
		await tick(9000);
		expect(named(calls, "jobs/next")).toHaveLength(4);
		expect(screen.getByText("Something went wrong on the server. Try again.")).toBeVisible();
		expect(screen.queryByText(/retrying/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await tick();
		expect(screen.getByText("The import is complete.")).toBeVisible();
		expect(named(calls, "jobs/next")).toHaveLength(5);
	});

	it("stops driving and shows the administrators-only sentence on a 403", async () => {
		vi.useFakeTimers();
		const { calls } = mockRoutes({
			"jobs/get": () => real({ counters: counters(1) }),
			"jobs/next": () => fail("FORBIDDEN", "Insufficient permissions", 403),
		});
		renderRun(reopened, { fakeTimers: true });
		await tick();
		expect(screen.getByText("Only administrators can import.")).toBeVisible();
		await tick(20_000);
		expect(named(calls, "jobs/next")).toHaveLength(1);
		expect(screen.queryByText("Insufficient permissions")).toBeNull();
		expect(screen.queryByText(/retrying/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		// Pause and Cancel could only answer 403 again (review minor 4).
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
	});

	it("hides the controls when a control answers 403", async () => {
		mockRoutes({
			"jobs/get": () => real({ status: "paused", counters: counters(1) }),
			"jobs/next": () => real({ status: "paused", counters: counters(1) }),
			"jobs/resume": () => fail("FORBIDDEN", "Insufficient permissions", 403),
		});
		const { user } = renderRun(reopened);
		await user.click(await screen.findByRole("button", { name: "Resume" }));
		expect(await screen.findByText("Only administrators can import.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
	});

	it("a failed job's source_missing message never shows the upload ID", async () => {
		const failed = real({
			status: "failed",
			counters: counters(2),
			error: { code: "source_missing", message: `Upload ${DRY_UPLOAD} not found` },
		});
		mockRoutes({ "jobs/get": () => failed, "jobs/next": () => failed });
		renderRun(reopened);
		expect(
			await screen.findByText(
				"The file for this import is no longer available; start a new import.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
		expect(document.body.textContent).not.toContain(DRY_UPLOAD);
	});

	it("shows a failed job's error and resumes it", async () => {
		const failed = real({
			status: "failed",
			counters: counters(2),
			error: { code: "internal", message: "D1 timed out" },
		});
		const { calls } = mockRoutes({
			"jobs/get": () => failed,
			"jobs/next": replies(failed, real({ status: "completed", counters: counters(4) })),
			"jobs/resume": () => real({ counters: counters(2) }),
		});
		const { user } = renderRun(reopened);
		expect(
			await screen.findByText(
				"The import stopped after repeated unexpected errors. Resume it to try again.",
			),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Resume" }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(named(calls, "jobs/resume").map((c) => c.body)).toEqual([{ id: JOB_ID }]);
	});

	it("shows a refused jobs/create with Try again, which creates the job", async () => {
		let refused = false;
		const { calls } = mockRoutes({
			"jobs/create": () => {
				if (refused) return real({ status: "created" });
				refused = true;
				return fail("INVALID_TEMPLATE", "The template does not fit", 400, {
					problems: ['Field "title" has type "text"'],
				});
			},
			"jobs/next": () => real({ status: "completed", counters: counters(4) }),
		});
		const { user } = renderRun(draft());
		expect(await screen.findByText("The import settings do not fit the collection.")).toBeVisible();
		expect(screen.getByText('Field "title" has type "text"')).toBeVisible();
		expect(window.location.search).not.toContain("job=");
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(named(calls, "jobs/create")).toHaveLength(2);
	});

	it("a remount while jobs/create is in flight sends one jobs/create", async () => {
		const held = gate();
		const { calls } = mockRoutes({
			"jobs/create": () => held.promise,
			"jobs/get": () => real({ counters: counters(0) }),
			"jobs/next": () => real({ status: "completed", counters: counters(4) }),
		});
		function Remount() {
			const [key, setKey] = useState(0);
			return (
				<>
					<button type="button" onClick={() => setKey((k) => k + 1)}>
						remount
					</button>
					<RunStep key={key} />
				</>
			);
		}
		const { user } = renderAdmin(
			<WizardProvider initial={draft()}>
				<Remount />
			</WizardProvider>,
		);
		await waitFor(() => expect(named(calls, "jobs/create")).toHaveLength(1));
		await user.click(screen.getByRole("button", { name: "remount" }));
		await user.click(screen.getByRole("button", { name: "remount" }));
		held.open(real({ status: "created" }));
		expect(await screen.findByText("The import is complete.")).toBeVisible();
		expect(named(calls, "jobs/create")).toHaveLength(1);
		expect(new URLSearchParams(window.location.search).get("job")).toBe(JOB_ID);
	});
	/** Pauses, or cancels and confirms, with fake timers. */
	async function stopBy(user: UserEvent, how: "pause" | "cancel") {
		if (how === "pause") {
			await user.click(screen.getByRole("button", { name: "Pause" }));
			await tick();
			expect(screen.getByText("The import is paused.")).toBeVisible();
			return;
		}
		await user.click(screen.getByRole("button", { name: "Cancel import" }));
		await tick();
		const dialog = screen.getByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel import" }));
		await tick();
		expect(screen.getByText("The import was cancelled.")).toBeVisible();
	}

	const stopped = (status: "paused" | "cancelled") => real({ status, counters: counters(1) });

	it.each(["pause", "cancel"] as const)(
		"drops the driver's error once a %s stops the job (review 1)",
		async (how) => {
			vi.useFakeTimers();
			mockRoutes({
				"jobs/get": () => real({ counters: counters(1) }),
				"jobs/next": () => fail("INTERNAL_ERROR", "Worker overloaded", 503),
				"jobs/pause": () => stopped("paused"),
				"jobs/cancel": () => stopped("cancelled"),
			});
			const { user } = renderRun(reopened, { fakeTimers: true });
			await tick();
			await tick(1000);
			await tick(3000);
			await tick(9000);
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Something went wrong on the server. Try again.",
			);
			await stopBy(user, how);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		},
	);

	it.each([
		["pause", "a lease wait"],
		["cancel", "a lease wait"],
		["pause", "a retry"],
		["cancel", "a retry"],
	] as const)("can %s during %s, and the driver stops at once", async (how, during) => {
		vi.useFakeTimers();
		const lease = { holder: "other-tab", expiresAt: Date.now() + 30_000 };
		const { calls } = mockRoutes({
			"jobs/get": () => real({ counters: counters(1) }),
			"jobs/next": () =>
				during === "a retry"
					? fail("INTERNAL_ERROR", "Worker overloaded", 503)
					: real({ counters: counters(1), lease }),
			"jobs/pause": () => stopped("paused"),
			"jobs/cancel": () => stopped("cancelled"),
		});
		const { user } = renderRun(reopened, { fakeTimers: true });
		await tick();
		expect(
			screen.getByText(
				during === "a retry"
					? "Connection lost; retrying (1 of 3)"
					: "Waiting for the previous batch to finish",
			),
		).toBeVisible();
		await stopBy(user, how);
		const sent = named(calls, "jobs/next").length;
		await tick(60_000);
		expect(named(calls, "jobs/next")).toHaveLength(sent);
		expect(screen.queryByText(/retrying|Waiting/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
