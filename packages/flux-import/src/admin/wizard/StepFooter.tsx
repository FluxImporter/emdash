import { Button } from "@cloudflare/kumo";
import { useId } from "react";
import { useT } from "../i18n.js";
import { useWizard } from "./context.js";
import { M } from "./messages.js";
import { reachable, STEPS } from "./state.js";

/**
 * A step's Back and Next. Back goes to the step before, when there is one and it can be shown;
 * a disabled Next shows why beside it.
 */
export function StepFooter(props: {
	canNext: boolean;
	reason?: string;
	nextLabel?: string;
	onNext(): void | Promise<void>;
	busy?: boolean;
}) {
	const t = useT();
	const { state, dispatch } = useWizard();
	const reasonId = useId();
	const previous = STEPS[STEPS.indexOf(state.step) - 1];
	const showBack = previous !== undefined && reachable(state, previous);
	const busy = props.busy === true;
	const blocked = !props.canNext && props.reason !== undefined && props.reason !== "";
	return (
		<div className="mt-6 flex items-center justify-between gap-3 border-t border-kumo-line pt-4">
			<div>
				{showBack ? (
					<Button
						variant="secondary"
						onClick={() => dispatch({ type: "stepChanged", step: previous })}
					>
						{t(M.back)}
					</Button>
				) : null}
			</div>
			<div className="flex items-center gap-3">
				{blocked ? (
					<span id={reasonId} className="text-sm text-kumo-subtle">
						{props.reason}
					</span>
				) : null}
				<Button
					variant="primary"
					disabled={!props.canNext || busy}
					loading={busy}
					aria-describedby={blocked ? reasonId : undefined}
					onClick={() => {
						void props.onNext();
					}}
				>
					{props.nextLabel ?? t(M.next)}
				</Button>
			</div>
		</div>
	);
}
