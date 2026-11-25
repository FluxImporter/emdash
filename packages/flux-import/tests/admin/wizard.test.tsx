import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCredentials } from "../../src/admin/queries.js";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import { StepBar } from "../../src/admin/wizard/StepBar.js";
import { StepHeader, type StepNext } from "../../src/admin/wizard/StepHeader.js";
import type { StepId, WizardState } from "../../src/admin/wizard/state.js";
import { type StepComponents, Wizard } from "../../src/admin/wizard/Wizard.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";

const CREDENTIALS = [{ name: "feed", header: "Authorization" }];

/** Each step shows its ID; Source can make the draft dirty and ready, start a run, or jump ahead. */
function dummy(id: StepId) {
	return function DummyStep() {
		const { state, dispatch } = useWizard();
		return (
			<div>
				<StepHeader />
				<p>{`${id} body`}</p>
				{state.run === null ? null : <p>{`job ${state.run.jobId}`}</p>}
				{id === "source" ? (
					<>
						<button
							type="button"
							onClick={() =>
								dispatch({
									type: "sourceReady",
									source: { kind: "paste", uploadId: "u1", label: "Pasted" },
									sourceBlock: { format: "csv" },
									columns: [{ key: "id", values: ["1"] }],
								})
							}
						>
							Load sample
						</button>
						<button type="button" onClick={() => dispatch({ type: "runStarted", jobId: "J9" })}>
							Start run
						</button>
						<button
							type="button"
							onClick={() => dispatch({ type: "stepChanged", step: "options" })}
						>
							Jump to Options
						</button>
					</>
				) : null}
			</div>
		);
	};
}

const sourceMounted = vi.fn();
const DummySource = dummy("source");
const DUMMY: StepComponents = {
	source: () => {
		sourceMounted();
		return <DummySource />;
	},
	target: dummy("target"),
	map: dummy("map"),
	options: dummy("options"),
	preview: dummy("preview"),
	run: dummy("run"),
};

/** Shows the probe's status as a step sees it; its observer is told in the same render as the Wizard's. */
function ProbeStatus() {
	return <p>{`probe ${useCredentials().status}`}</p>;
}

/** DUMMY, with the probe's status on Source. */
const WITH_PROBE: StepComponents = {
	...DUMMY,
	source: () => (
		<>
			<DummySource />
			<ProbeStatus />
		</>
	),
};

/** The access probe answers with the credential list. */
const granted = () => mockRoutes({ "credentials/list": () => CREDENTIALS });

const stepHeading = () => screen.findByRole("heading", { level: 2 });

/** A `beforeunload` the page may cancel; true when the page asked to stay. */
function unloadPrevented(): boolean {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe("Wizard", () => {
	it("shows the administrators-only state when the access probe answers 403 (Review Focus 2)", async () => {
		const { calls } = mockRoutes({
			"credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403),
		});
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await screen.findByText("Only administrators can import.")).toBeVisible();
		expect(screen.queryByRole("list", { name: /steps/i })).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByText(/Insufficient permissions/)).toBeNull();
		expect(screen.getByRole("heading", { level: 1, name: "New import" })).toBeInTheDocument();
		expect(calls.map((c) => c.route)).toEqual(["credentials/list"]);
	});

	it("shows a loader while the access probe runs", async () => {
		let answer!: (value: unknown) => void;
		mockRoutes({
			"credentials/list": () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		});
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(screen.getByRole("status", { name: "Checking access" })).toBeInTheDocument();
		expect(screen.queryByRole("list", { name: /steps/i })).toBeNull();
		await waitFor(() => expect(answer).toBeTypeOf("function"));
		answer(CREDENTIALS);
		expect(await screen.findByRole("list", { name: /steps/i })).toBeInTheDocument();
		expect(screen.queryByRole("status", { name: "Checking access" })).toBeNull();
	});

	it("shows another probe failure with Try again, which probes again", async () => {
		let failing = true;
		const { calls } = mockRoutes({
			"credentials/list": () =>
				failing ? fail("UNAUTHORIZED", "Session expired", 401) : CREDENTIALS,
		});
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(screen.getByText(/Your session/)).toBeVisible();
		expect(screen.queryByRole("list", { name: /steps/i })).toBeNull();
		expect(retry).not.toHaveAttribute("aria-busy");
		failing = false;
		await user.click(retry);
		expect(await screen.findByRole("list", { name: /steps/i })).toBeInTheDocument();
		expect(calls).toHaveLength(2);
	});

	it("shows the probe's loader, not the error, while Try again probes again", async () => {
		let probes = 0;
		let answer: (value: unknown) => void = () => {};
		mockRoutes({
			"credentials/list": () => {
				probes += 1;
				if (probes === 1) return fail("UNAUTHORIZED", "Session expired", 401);
				return new Promise((resolve) => {
					answer = resolve;
				});
			},
		});
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		// React Query resets an errored query with no data to pending, so the banner and its
		// button give way to the loader: Try again's busy state is never on screen.
		expect(await screen.findByRole("status", { name: "Checking access" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		answer(CREDENTIALS);
		expect(await screen.findByRole("list", { name: /steps/i })).toBeInTheDocument();
	});

	it("keeps the draft when a later probe fails", async () => {
		let failing = false;
		mockRoutes({
			"credentials/list": () =>
				failing ? fail("FORBIDDEN", "Insufficient permissions", 403) : CREDENTIALS,
		});
		const { user, queryClient } = renderAdmin(<Wizard steps={WITH_PROBE} />);
		await user.click(await screen.findByRole("button", { name: "Load sample" }));
		failing = true;
		await queryClient.refetchQueries();
		expect(await screen.findByText("probe error")).toBeInTheDocument();
		expect(screen.getByRole("list", { name: /steps/i })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /Target/ })).toBeInTheDocument();
		expect(screen.queryByText("Only administrators can import.")).toBeNull();
	});

	it("puts the product mark beside the page title, and Cancel back to the Imports home", async () => {
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		const title = screen.getByRole("heading", { level: 1, name: "New import" });
		const mark = title.parentElement?.querySelector("svg");
		expect(mark).toHaveAttribute("aria-hidden", "true");
		await stepHeading();
		expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
			"href",
			"/_emdash/admin/plugins/flux-import/imports",
		);
		expect(screen.queryByRole("link", { name: "See all imports" })).toBeNull();
	});

	it("offers See all imports instead of Cancel on the Run step", async () => {
		window.history.replaceState(null, "", "/import?job=J1");
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Run");
		expect(screen.getByRole("link", { name: "See all imports" })).toHaveAttribute(
			"href",
			"/_emdash/admin/plugins/flux-import/imports",
		);
		expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();
	});

	it("marks steps done (a check), current (filled, aria-current) or upcoming (Critique 4)", async () => {
		granted();
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Load sample" }));
		const list = screen.getByRole("list", { name: /steps/i });
		await user.click(within(list).getByRole("link", { name: /Target/ }));
		await stepHeading();
		// Source is done: a check, its number for screen readers, and still a link back.
		const source = within(list).getByRole("link", { name: "1 Source (done)" });
		expect(source).not.toHaveAttribute("aria-current");
		expect(source.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		expect(within(source).getByText("1")).toHaveClass("sr-only");
		expect(within(source).getByText("(done)")).toHaveClass("sr-only");
		// Target is current: its number in the filled circle.
		const target = within(list).getByRole("link", { name: "2 Target" });
		expect(target).toHaveAttribute("aria-current", "step");
		expect(within(target).getByText("2")).toHaveClass("bg-kumo-badge-inverted");
		// Map is upcoming and not available: an outlined number, no link.
		const map = within(list).getByText("Map").closest("[aria-disabled]") as HTMLElement;
		expect(map).toHaveAttribute("aria-disabled", "true");
		expect(within(map).getByText("3")).toHaveClass("border", "border-kumo-line");
		expect(within(list).getAllByRole("link")).toHaveLength(2);
		// Every step is reached by keyboard while it is a link.
		await user.click(source);
		expect(await stepHeading()).toHaveTextContent("Source");
	});

	it("renders six steps as a list of links with aria-current=step on the current one", async () => {
		granted();
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		const list = await screen.findByRole("list", { name: /steps/i });
		expect(list.tagName).toBe("OL");
		const items = within(list).getAllByRole("listitem");
		expect(items.map((li) => li.textContent)).toEqual([
			"1 Source",
			"2 Target (not available yet)",
			"3 Map (not available yet)",
			"4 Options (not available yet)",
			"5 Preview (not available yet)",
			"6 Run (not available yet)",
		]);
		const source = within(list).getByRole("link", { name: /Source/ });
		expect(source).toHaveAttribute("href", "?step=source");
		expect(source).toHaveAttribute("aria-current", "step");
		// Unreachable steps are marked, and are not links.
		expect(within(list).getAllByRole("link")).toHaveLength(1);
		for (const name of ["Target", "Map", "Options", "Preview", "Run"]) {
			const step = within(list).getByText(name).closest("[aria-disabled]");
			expect(step).toHaveAttribute("aria-disabled", "true");
			// Screen readers hear why; the note is visually hidden.
			expect(within(step as HTMLElement).getByText("(not available yet)")).toHaveClass("sr-only");
		}
		await user.click(screen.getByRole("button", { name: "Load sample" }));
		const target = within(list).getByRole("link", { name: /Target/ });
		expect(target).toHaveAttribute("href", "?step=target");
		expect(target).not.toHaveAttribute("aria-current");
		expect(target).toHaveTextContent(/^2 Target$/);
		// Steps are pills, not underlined links (Critique 4); text on the page canvas keeps AA.
		expect(target).toHaveClass("no-underline", "text-kumo-default");
		expect(target).not.toHaveClass("underline");
		expect(within(list).getAllByRole("link")).toHaveLength(2);
	});

	it("moves focus to the step heading on a step change and mirrors ?step= in the URL", async () => {
		const routerState = { key: "router" };
		window.history.replaceState(routerState, "", "/import");
		const replace = vi.spyOn(window.history, "replaceState");
		granted();
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Source");
		expect(window.location.search).toBe("?step=source");
		// No focus is taken on the first render.
		expect(document.activeElement).toBe(document.body);
		await user.click(screen.getByRole("button", { name: "Load sample" }));
		const link = screen.getByRole("link", { name: /Target/ });
		// The link does not navigate: it changes the step in place (preflight F20).
		expect(fireEvent.click(link)).toBe(false);
		const heading = await stepHeading();
		expect(heading).toHaveTextContent("Target");
		expect(heading).toHaveAttribute("tabindex", "-1");
		await waitFor(() => expect(heading).toHaveFocus());
		expect(screen.getByText("target body")).toBeInTheDocument();
		expect(window.location.search).toBe("?step=target");
		expect(window.history.state).toEqual(routerState);
		expect(replace).toHaveBeenLastCalledWith(
			routerState,
			"",
			expect.stringMatching(/\?step=target$/),
		);
		await user.click(screen.getByRole("link", { name: /Source/ }));
		await waitFor(() =>
			expect(screen.getByRole("heading", { level: 2, name: "Source" })).toHaveFocus(),
		);
		expect(window.location.search).toBe("?step=source");
		replace.mockRestore();
	});

	it("reopens ?job=<id> on the Run step", async () => {
		window.history.replaceState(null, "", "/import?job=J1");
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Run");
		expect(screen.getByText("job J1")).toBeInTheDocument();
		const steps = screen.getByRole("list", { name: /steps/i });
		const run = within(steps).getByRole("link", { name: /Run/ });
		expect(run).toHaveAttribute("aria-current", "step");
		// Once a run exists, every earlier step is unreachable, though done.
		expect(within(steps).getAllByRole("link")).toHaveLength(1);
		const source = within(steps).getByText("Source").closest("[aria-disabled]") as HTMLElement;
		expect(source).toHaveTextContent("1 Source (done)");
		expect(within(source).queryByText("(not available yet)")).toBeNull();
		const params = new URLSearchParams(window.location.search);
		expect(params.get("step")).toBe("run");
		expect(params.get("job")).toBe("J1");
	});

	it("reopens ?step=run&job=<id> on the Run step, never Source", async () => {
		sourceMounted.mockClear();
		window.history.replaceState(null, "", "/import?step=run&job=J1");
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Run");
		expect(screen.getByText("job J1")).toBeInTheDocument();
		expect(sourceMounted).not.toHaveBeenCalled();
		expect(window.location.search).toBe("?step=run&job=J1");
	});

	it("drops ?template= from the URL at page load, even when Source is not mounted first", async () => {
		window.history.replaceState(null, "", "/import?template=T1&job=J1");
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Run");
		expect(new URLSearchParams(window.location.search).has("template")).toBe(false);
	});

	it("hands ?template= to Source once, and not again after Start a new import", async () => {
		window.history.replaceState(null, "", "/import?template=T1");
		granted();
		const Probe = () => {
			const { state, template, restart } = useWizard();
			return (
				<div>
					<p>{`preselect ${template ?? "none"}`}</p>
					{state.step === "source" ? (
						<button type="button" onClick={() => restart?.()}>
							Restart
						</button>
					) : null}
				</div>
			);
		};
		const { user } = renderAdmin(<Wizard steps={{ ...DUMMY, source: Probe }} />);
		expect(await screen.findByText("preselect T1")).toBeVisible();
		expect(new URLSearchParams(window.location.search).has("template")).toBe(false);
		await user.click(screen.getByRole("button", { name: "Restart" }));
		expect(await screen.findByText("preselect none")).toBeVisible();
	});

	it("falls back to Source for an unreachable ?step=", async () => {
		window.history.replaceState(null, "", "/import?step=map");
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		expect(await stepHeading()).toHaveTextContent("Source");
		expect(screen.getByText("source body")).toBeInTheDocument();
		expect(window.location.search).toBe("?step=source");
	});

	it("warns before unload while a draft is dirty and not after Run starts", async () => {
		granted();
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Load sample" }));
		expect(unloadPrevented()).toBe(true);
		await user.click(screen.getByRole("button", { name: "Start run" }));
		expect(unloadPrevented()).toBe(false);
	});

	it("stops warning before unload once the page unmounts", async () => {
		granted();
		const { user, unmount } = renderAdmin(<Wizard steps={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Load sample" }));
		expect(unloadPrevented()).toBe(true);
		unmount();
		expect(unloadPrevented()).toBe(false);
	});

	it("does not warn before unload while the draft is clean", async () => {
		granted();
		renderAdmin(<Wizard steps={DUMMY} />);
		await stepHeading();
		expect(unloadPrevented()).toBe(false);
	});

	it("ignores a jump to a step the draft cannot show (final review 5)", async () => {
		granted();
		const { user } = renderAdmin(<Wizard steps={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Jump to Options" }));
		expect(await stepHeading()).toHaveTextContent("Source");
		expect(screen.getByText("source body")).toBeInTheDocument();
		expect(window.location.search).toBe("?step=source");
	});

	it("keeps the current step a link with aria-current even when it is not reachable", () => {
		renderAdmin(
			<WizardProvider initial={{ step: "options" }}>
				<StepBar />
			</WizardProvider>,
		);
		const options = screen.getByRole("link", { name: /Options/ });
		expect(options).toHaveAttribute("aria-current", "step");
	});
});

/** Renders a step's header in a draft on `step`, with `next` as its Next. */
function header(initial: Partial<WizardState> | undefined, next?: StepNext) {
	return renderAdmin(
		<WizardProvider {...(initial === undefined ? {} : { initial })}>
			<StepHeader summary="What this step is for." {...(next === undefined ? {} : { next })} />
		</WizardProvider>,
	);
}

const READY: Partial<WizardState> = {
	source: { kind: "paste", uploadId: "u1", label: "Pasted" },
	columns: [{ key: "id", values: ["1"] }],
	target: { collection: "posts", locale: "en", translationLocale: null },
	rows: { key: { from: "id" } },
};

describe("StepHeader", () => {
	it("puts the step's heading, its summary, Back and Next: {step} at the top (Critique 4)", async () => {
		const { user } = header({ ...READY, step: "map" }, { canNext: true, onNext: () => undefined });
		const heading = screen.getByRole("heading", { level: 2, name: "Map" });
		expect(heading).toHaveAttribute("tabindex", "-1");
		expect(screen.getByText("What this step is for.")).toBeVisible();
		const back = screen.getByRole("button", { name: "Back" });
		const next = screen.getByRole("button", { name: "Next: Options" });
		// Heading, Back, then Next: the order a keyboard reaches them in.
		expect(heading.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(back.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await user.click(back);
		expect(await screen.findByRole("heading", { level: 2, name: "Target" })).toBeVisible();
	});

	it("names the next step through the translation, and takes a step's own label", () => {
		header({ step: "source" }, { canNext: false, onNext: () => undefined });
		expect(screen.getByRole("button", { name: "Next: Target" })).toBeDisabled();
		// No step before Source: no Back.
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
	});

	it("names Next from each step to the one after it", () => {
		const cases = [
			["target", "Next: Map"],
			["map", "Next: Options"],
			["options", "Next: Preview"],
		] as const;
		for (const [step, name] of cases) {
			const { unmount } = header({ ...READY, step }, { canNext: true, onNext: () => undefined });
			expect(screen.getByRole("button", { name })).toBeEnabled();
			unmount();
		}
	});

	it("shows why Next is disabled beside it, and describes Next with it", () => {
		header(
			{ ...READY, step: "map" },
			{ canNext: false, reason: "Map at least one field", onNext: () => undefined },
		);
		const next = screen.getByRole("button", { name: "Next: Options" });
		expect(next).toBeDisabled();
		const reason = screen.getByText("Map at least one field");
		expect(next).toHaveAttribute("aria-describedby", reason.id);
		// On the page canvas, not a card: the default text colour keeps AA contrast.
		expect(reason).toHaveClass("text-kumo-default");
	});

	it("has no Back or Next without `next`, as on Run", () => {
		header({ ...READY, step: "run", run: { jobId: "R" } });
		expect(screen.getByRole("heading", { level: 2, name: "Run" })).toBeVisible();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("keeps Next's accessible name while busy: the spinner adds no English 'Loading'", () => {
		renderAdmin(
			<WizardProvider>
				<StepHeader next={{ canNext: true, busy: true, onNext: () => undefined }} />
				<StepHeader
					next={{ canNext: true, busy: true, nextLabel: "Run the import", onNext: () => undefined }}
				/>
			</WizardProvider>,
		);
		expect(screen.getByRole("button", { name: "Next: Target" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next: Target" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByRole("button", { name: "Run the import" })).toBeDisabled();
	});

	it("is not marked busy when idle", () => {
		header(undefined, { canNext: true, onNext: () => undefined });
		expect(screen.getByRole("button", { name: "Next: Target" })).not.toHaveAttribute("aria-busy");
	});
});
