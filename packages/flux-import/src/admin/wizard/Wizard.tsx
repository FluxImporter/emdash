import { LinkButton } from "@cloudflare/kumo";
import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { isForbidden } from "../api-error.js";
import { HOME_URL } from "../home/links.js";
import { useT } from "../i18n.js";
import { M as PAGE } from "../messages.js";
import { useCredentials } from "../queries.js";
import { Mark } from "../ui/Mark.js";
import { Forbidden, LoadFailed, LoadingRows } from "../ui/states.js";
import { useNarrow } from "../ui/use-narrow.js";
import { useWizard, WizardProvider } from "./context.js";
import { SHELL } from "./messages.js";
import { StepBar } from "./StepBar.js";
import { initialState, reducer, type StepId, type WizardState } from "./state.js";
import { readUrl, writeUrl } from "./url.js";

/**
 * The component each step renders below the step bar. Each starts with its `StepHeader`: the
 * step's `<h2>`, its summary line, and its Back and Next (preflight F20, Critique 4).
 */
export type StepComponents = Readonly<Record<StepId, ComponentType>>;

/** Asks the browser to confirm leaving the page while `active`. */
export function useUnloadGuard(active: boolean): void {
	useEffect(() => {
		if (!active) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [active]);
}

/**
 * The state the page opens on (preflight F2), read from the URL once: `?job=` reopens that job on
 * Run, whatever `?step=` says. Otherwise the page opens on Source: `?step=` is shown only when
 * reachable, and a fresh draft reaches no other step, so the URL mirror rewrites it. Applied before
 * the first render, so no other step mounts on the way.
 */
function openingState(search: string): WizardState {
	const { job } = readUrl(search);
	return job === null ? initialState : reducer(initialState, { type: "jobReopened", jobId: job });
}

/**
 * The import page: the access probe (Ruling 17), then the wizard, under the title with the
 * product mark (Wizard.dc.html). A 403 shows only the administrators-only state; any other failure
 * its sentence and "Try again" (States.dc.html).
 */
export function Wizard(props: { steps: StepComponents }) {
	const t = useT();
	const access = useCredentials();
	if (access.data !== undefined) {
		// Once granted, the wizard stays: a later failed probe must not drop the draft.
		return <OpenedWizard steps={props.steps} />;
	}
	return (
		<div className="flex flex-col gap-4">
			<Title />
			{access.isError && isForbidden(access.error) ? (
				<Forbidden />
			) : access.isError ? (
				<LoadFailed
					title={t(SHELL.accessFailed)}
					error={access.error}
					retrying={access.isFetching}
					onRetry={() => void access.refetch()}
				/>
			) : (
				<LoadingRows label={t(SHELL.checkingAccess)} rows={3} />
			)}
		</div>
	);
}

/** The page's title with the product mark, and the way back to the Imports home. */
function Title(props: { exit?: "cancel" | "seeAll" }) {
	const t = useT();
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex items-center gap-2.5">
				<Mark />
				<h1 className="text-2xl font-bold text-kumo-default">{t(PAGE.pageTitle)}</h1>
			</div>
			{props.exit === undefined ? null : (
				<LinkButton variant="ghost" href={HOME_URL}>
					{t(props.exit === "seeAll" ? SHELL.seeAll : SHELL.cancel)}
				</LinkButton>
			)}
		</div>
	);
}

/**
 * The wizard, opened from the URL. "Start a new import" (a finished run) remounts it with an empty
 * draft: a new reducer and a new `once`, so nothing of the last import carries over. The host's own
 * link to this page does not remount it (see Shell), so without this a finished run was a dead end.
 */
function OpenedWizard(props: { steps: StepComponents }) {
	const [initial] = useState(() => openingState(window.location.search));
	// `?template=` is read at page load, handed to the first Source once and dropped from the URL,
	// wherever the page opens: a restart or a later return to Source does not preselect it (F13).
	const [template] = useState(() => readUrl(window.location.search).template);
	useEffect(() => {
		if (template !== null) writeUrl({ template: null });
	}, [template]);
	const [round, setRound] = useState(0);
	const restart = useCallback(() => {
		writeUrl({ step: "source", job: null });
		setRound((n) => n + 1);
	}, []);
	return (
		<WizardProvider key={round} {...(round === 0 ? { initial, template } : {})} restart={restart}>
			<Shell steps={props.steps} focusHeading={round > 0} />
		</WizardProvider>
	);
}

/**
 * The title, the step bar and the step (which renders its own heading). Focus moves to the step's
 * heading when the step changes.
 */
function Shell(props: { steps: StepComponents; focusHeading?: boolean }) {
	const { state, heading } = useWizard();
	const shown = useRef(state.step);
	const [ref, narrow] = useNarrow<HTMLDivElement>();

	useUnloadGuard(state.dirty && state.run === null);

	// A restarted wizard starts on Source with focus on its heading: the button that restarted it
	// is gone.
	const focusHeading = props.focusHeading === true;
	useEffect(() => {
		if (focusHeading) heading.current?.focus();
	}, [focusHeading, heading]);

	// The URL names the current step (Ruling 12); on the first render this also rewrites an
	// unreachable `?step=` and adds `step=run` to a reopened job's URL. The URL is read once, at
	// mount; after that it only follows step changes. A host navigation to this route that does not
	// remount the page (a changed `?step=` or `?job=`) is not read back.
	useEffect(() => {
		writeUrl({ step: state.step });
		if (shown.current === state.step) return;
		shown.current = state.step;
		heading.current?.focus();
	}, [state.step, heading]);

	const Step = props.steps[state.step];
	return (
		<div ref={ref} className="flex flex-col gap-4">
			<Title exit={state.step === "run" ? "seeAll" : "cancel"} />
			<StepBar narrow={narrow} />
			<Step />
		</div>
	);
}
