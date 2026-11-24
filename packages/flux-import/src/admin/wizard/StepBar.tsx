import { useT } from "../i18n.js";
import { useCachedFields } from "../queries.js";
import type { SchemaField } from "../types.js";
import { useWizard } from "./context.js";
import { SHELL } from "./messages.js";
import { mapBlockers, reachable, STEPS, type StepId, type WizardState } from "./state.js";

/** The steps after Map: each needs a mapping Map would let through. */
const AFTER_MAP: ReadonlySet<StepId> = new Set(["options", "preview", "run"]);

/**
 * Whether the step bar links `step`: it is reachable, and, for a step after Map, no proposed field
 * waits (it goes through Map's Next and the schema diff) and Map has no blockers. Map's blockers
 * need the collection's fields, so they are checked only once a step has read them. Neither holds
 * once a run exists, which only Run shows.
 */
function linked(
	state: WizardState,
	step: StepId,
	fields: readonly SchemaField[] | undefined,
): boolean {
	if (!reachable(state, step)) return false;
	if (state.run !== null || !AFTER_MAP.has(step)) return true;
	if (state.newFields.length > 0) return false;
	return fields === undefined || mapBlockers(state, fields).length === 0;
}

/**
 * The step bar: an ordered list of the six steps. The current step and every one `linked` allows
 * is a link; a click changes the step in place instead of loading `?step=` (preflight F20). An
 * unreachable step is marked `aria-disabled`, tells screen readers it is not available yet, and is
 * not a link.
 */
export function StepBar() {
	const t = useT();
	const { state, dispatch } = useWizard();
	const fields = useCachedFields(state.target?.collection ?? null);
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
						{current || linked(state, step, fields) ? (
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
								{content} <span className="sr-only">{t(SHELL.notAvailable)}</span>
							</span>
						)}
					</li>
				);
			})}
		</ol>
	);
}
