import { useT } from "../i18n.js";
import { useWizard } from "./context.js";
import { SHELL } from "./messages.js";
import { reachable, STEPS } from "./state.js";

/**
 * The step bar: an ordered list of the six steps. The current step and every reachable one is a
 * link; a click changes the step in place instead of loading `?step=` (preflight F20). An
 * unreachable step is marked `aria-disabled` and is not a link.
 */
export function StepBar() {
	const t = useT();
	const { state, dispatch } = useWizard();
	return (
		<ol aria-label={t(SHELL.steps)} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
			{STEPS.map((step, index) => {
				const current = step === state.step;
				const content = (
					<>
						<span className="tabular-nums">{index + 1}</span> {t(SHELL.step[step])}
					</>
				);
				return (
					<li key={step}>
						{current || reachable(state, step) ? (
							<a
								href={`?step=${step}`}
								aria-current={current ? "step" : undefined}
								className={
									current
										? "flex items-center gap-1 font-semibold text-kumo-default"
										: "flex items-center gap-1 text-kumo-brand underline"
								}
								onClick={(e) => {
									e.preventDefault();
									dispatch({ type: "stepChanged", step });
								}}
							>
								{content}
							</a>
						) : (
							<span aria-disabled="true" className="flex items-center gap-1 text-kumo-subtle">
								{content}
							</span>
						)}
					</li>
				);
			})}
		</ol>
	);
}
