import { Button } from "@cloudflare/kumo";
import { type ReactNode, useId } from "react";
import { useT } from "../i18n.js";
import { ArrowRightIcon } from "../ui/icons.js";
import { useWizard } from "./context.js";
import { M, SHELL } from "./messages.js";
import { reachable, STEPS } from "./state.js";

/** A step's Next: whether it can go on, why not, and what it does. */
export interface StepNext {
	canNext: boolean;
	reason?: string;
	/** The button's text; "Next: {the next step}" by default. */
	nextLabel?: string;
	/**
	 * Must not reject: its promise is not awaited, so a step reports its own errors (through
	 * `describeError`) instead of throwing them here (review ruling 7).
	 */
	onNext(): void | Promise<void>;
	busy?: boolean;
}

/**
 * The top of every step (Critique 4, Wizard.dc.html): its heading and one line about it, with Back
 * and Next on the right, so Next is never below the fold. Back goes to the step before, when there
 * is one and it can be shown; a disabled Next says why beside it. The heading takes the page's
 * focus when the step changes (`useWizard().heading`).
 */
export function StepHeader(props: { summary?: ReactNode; next?: StepNext }) {
	const t = useT();
	const { state, heading } = useWizard();
	return (
		<div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-hairline pb-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<h2
					ref={heading}
					tabIndex={-1}
					className="text-lg font-semibold text-kumo-default outline-none"
				>
					{t(SHELL.step[state.step])}
				</h2>
				{props.summary === undefined ? null : (
					<div className="text-sm text-kumo-default">{props.summary}</div>
				)}
			</div>
			{props.next === undefined ? null : <StepActions {...props.next} />}
		</div>
	);
}

function StepActions(props: StepNext) {
	const t = useT();
	const { state, dispatch } = useWizard();
	const reasonId = useId();
	const index = STEPS.indexOf(state.step);
	const previous = STEPS[index - 1];
	const following = STEPS[index + 1];
	const showBack = previous !== undefined && reachable(state, previous);
	const busy = props.busy === true;
	const blocked = !props.canNext && props.reason !== undefined && props.reason !== "";
	const label =
		props.nextLabel ??
		(following === undefined ? "" : t(M.nextTo, { step: t(SHELL.step[following]) }));
	return (
		<div className="flex max-w-md flex-col items-end gap-1">
			<div className="flex flex-wrap items-center justify-end gap-2">
				{showBack ? (
					<Button
						variant="secondary"
						onClick={() => dispatch({ type: "stepChanged", step: previous })}
					>
						{t(M.back)}
					</Button>
				) : null}
				<Button
					variant="primary"
					disabled={!props.canNext || busy}
					loading={busy}
					// Kumo's spinner is labelled "Loading" in English; the label alone names the button,
					// and aria-busy says it is working.
					aria-label={label}
					aria-busy={busy || undefined}
					aria-describedby={blocked ? reasonId : undefined}
					onClick={() => {
						void props.onNext();
					}}
				>
					{label}
					{props.nextLabel === undefined ? <ArrowRightIcon aria-hidden="true" /> : null}
				</Button>
			</div>
			{blocked ? (
				<p id={reasonId} className="text-right text-sm text-kumo-default">
					{props.reason}
				</p>
			) : null}
		</div>
	);
}
