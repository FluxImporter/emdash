import { Banner, Button, Loader } from "@cloudflare/kumo";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { describeError, ERROR_MESSAGES } from "../errors.js";
import { useT } from "../i18n.js";
import { M as PAGE } from "../messages.js";
import { useCredentials } from "../queries.js";
import { useWizard, WizardProvider } from "./context.js";
import { SHELL } from "./messages.js";
import { StepBar } from "./StepBar.js";
import { initialState, reducer, type StepId, type WizardState } from "./state.js";
import { readUrl, writeUrl } from "./url.js";

/** The component each step renders below its heading; it renders no `<h2>` (preflight F20). */
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
 * The import page: the access probe (Ruling 17), then the wizard. A 403 shows only the
 * administrators-only sentence; any other failure its sentence and "Try again".
 */
export function Wizard(props: { steps: StepComponents }) {
	const t = useT();
	const access = useCredentials();
	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">{t(PAGE.pageTitle)}</h1>
			{access.data !== undefined ? (
				// Once granted, the wizard stays: a later failed probe must not drop the draft.
				<OpenedWizard steps={props.steps} />
			) : access.isError ? (
				<AccessError
					error={access.error}
					retrying={access.isFetching}
					onRetry={() => void access.refetch()}
				/>
			) : (
				<Loader aria-label={t(SHELL.checkingAccess)} />
			)}
		</div>
	);
}

function AccessError(props: { error: unknown; retrying: boolean; onRetry(): void }) {
	const t = useT();
	const { msg, values, detail } = describeError(props.error);
	if (msg.id === ERROR_MESSAGES.FORBIDDEN?.id) {
		return <Banner variant="alert" title={t(msg)} />;
	}
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(msg, values)}
			{...(detail === undefined ? {} : { description: detail })}
			action={
				<Button variant="secondary" loading={props.retrying} onClick={props.onRetry}>
					{t(PAGE.tryAgain)}
				</Button>
			}
		/>
	);
}

function OpenedWizard(props: { steps: StepComponents }) {
	const [initial] = useState(() => openingState(window.location.search));
	return (
		<WizardProvider initial={initial}>
			<Shell steps={props.steps} />
		</WizardProvider>
	);
}

/** The step bar, the current step's heading and the step itself. */
function Shell(props: { steps: StepComponents }) {
	const t = useT();
	const { state } = useWizard();
	const heading = useRef<HTMLHeadingElement>(null);
	const shown = useRef(state.step);

	useUnloadGuard(state.dirty && state.run === null);

	// The URL names the current step (Ruling 12); on the first render this also rewrites an
	// unreachable `?step=` and adds `step=run` to a reopened job's URL. The URL is read once, at
	// mount; after that it only follows step changes. A host navigation to this route that does not
	// remount the page (a changed `?step=` or `?job=`) is not read back.
	useEffect(() => {
		writeUrl({ step: state.step });
		if (shown.current === state.step) return;
		shown.current = state.step;
		heading.current?.focus();
	}, [state.step]);

	const Step = props.steps[state.step];
	return (
		<div className="space-y-6">
			<StepBar />
			<h2 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
				{t(SHELL.step[state.step])}
			</h2>
			<Step />
		</div>
	);
}
