import { STEPS, type StepId } from "./state.js";

/** The step and job named in the page's query string (Ruling 12); anything else is null. */
export function readUrl(search: string): { step: StepId | null; job: string | null } {
	const params = new URLSearchParams(search);
	const step = params.get("step");
	const job = params.get("job");
	return {
		step: STEPS.find((s) => s === step) ?? null,
		job: job === null || job === "" ? null : job,
	};
}

/**
 * Merges `step` and `job` into the page's URL (Ruling 12): `job: null` removes it. The URL is
 * replaced, keeping the router's `history.state`; nothing is pushed.
 */
export function writeUrl(patch: { step?: StepId; job?: string | null }): void {
	const url = new URL(window.location.href);
	if (patch.step !== undefined) url.searchParams.set("step", patch.step);
	if (patch.job === null) url.searchParams.delete("job");
	else if (patch.job !== undefined) url.searchParams.set("job", patch.job);
	window.history.replaceState(window.history.state, "", url.href);
}
