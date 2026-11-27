import { useT } from "../i18n.js";
import { useCachedFields } from "../queries.js";
import type { SchemaField } from "../types.js";
import { CheckIcon } from "../ui/icons.js";
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

/** Whether the step bar links a step; also what Preview's "Change in Options" follows. */
export function useStepLinked(): (step: StepId) => boolean {
	const { state } = useWizard();
	const fields = useCachedFields(state.target?.collection ?? null);
	return (step) => linked(state, step, fields);
}

/**
 * The stepper (Critique 4, Wizard.dc.html): an ordered list of the six steps, each done (a check),
 * current (filled, `aria-current="step"`) or upcoming (an outlined number). The current step and
 * every one `linked` allows is a link; a click changes the step in place instead of loading
 * `?step=` (preflight F20). A step that cannot be shown is marked `aria-disabled`, tells screen
 * readers it is not available yet (or that it is done), and is not a link. When `narrow`, only the
 * current step's name shows; the others keep theirs for screen readers.
 */
export function StepBar(props: { narrow?: boolean }) {
	const t = useT();
	const { state, dispatch } = useWizard();
	const isLinked = useStepLinked();
	const at = STEPS.indexOf(state.step);
	const narrow = props.narrow === true;
	return (
		<ol aria-label={t(SHELL.steps)} className="flex flex-wrap items-center gap-y-2 text-sm">
			{STEPS.map((step, index) => {
				const current = index === at;
				const done = index < at;
				const content = (
					<>
						{done ? (
							<>
								<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-badge-teal/15 text-kumo-badge-teal-subtle">
									<CheckIcon aria-hidden="true" size={14} />
								</span>
								<span className="sr-only">{index + 1}</span>
							</>
						) : (
							<span
								className={
									current
										? "flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-badge-inverted text-xs font-bold text-kumo-badge-inverted tabular-nums"
										: "flex size-6 shrink-0 items-center justify-center rounded-full border border-kumo-line text-xs font-bold tabular-nums"
								}
							>
								{index + 1}
							</span>
						)}{" "}
						<span className={narrow && !current ? "sr-only" : ""}>{t(SHELL.step[step])}</span>
						{done ? <span className="sr-only"> {t(SHELL.done)}</span> : null}
					</>
				);
				return (
					<li key={step} className="flex items-center">
						{current || isLinked(step) ? (
							<a
								href={`?step=${step}`}
								aria-current={current ? "step" : undefined}
								className={
									current
										? "flex h-8 items-center gap-2 rounded-full bg-kumo-tint ps-1.5 pe-3 font-semibold text-kumo-default no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus"
										: "flex h-8 items-center gap-2 rounded-full ps-1.5 pe-3 font-medium text-kumo-default no-underline hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus"
								}
								onClick={(e) => {
									e.preventDefault();
									dispatch({ type: "stepChanged", step });
								}}
							>
								{content}
							</a>
						) : (
							<span
								aria-disabled="true"
								className="flex h-8 items-center gap-2 ps-1.5 pe-3 font-medium text-kumo-default"
							>
								{content}
								{done ? null : <span className="sr-only"> {t(SHELL.notAvailable)}</span>}
							</span>
						)}
						{index < STEPS.length - 1 ? (
							<span
								aria-hidden="true"
								className={narrow ? "h-px w-1.5 bg-kumo-line" : "mx-1 h-px w-5 bg-kumo-line"}
							/>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}
