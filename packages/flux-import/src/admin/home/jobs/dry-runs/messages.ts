import type { JobStatus } from "../../../../engine/types.js";
import type { Msg } from "../../../i18n.js";

export const M = {
	count: { id: "flux-import.home-dry-runs.count", message: "Dry runs: {count}" },
	countMore: { id: "flux-import.home-dry-runs.count-more", message: "Dry runs: more than {count}" },
	where: { id: "flux-import.home-dry-runs.where", message: "{collection} · {locale}" },
	clear: { id: "flux-import.home-dry-runs.clear", message: "Clear dry runs" },
	confirm: {
		id: "flux-import.home-dry-runs.confirm",
		message: "Clear the finished and idle dry runs, with their staged files?",
	},
	cleared: { id: "flux-import.home-dry-runs.cleared", message: "Dry runs cleared: {count}." },
	none: {
		id: "flux-import.home-dry-runs.none",
		message:
			"No dry runs could be cleared now: running ones, and an agent's from the last 24 hours, are kept.",
	},
} satisfies Record<string, Msg>;

/** A job's status in words, for every list that shows one (kept here, in a messages file, for the boundary test; `status.ts` re-exports it, F11). */
export const STATUS_MESSAGES: Readonly<Record<JobStatus, Msg>> = {
	created: { id: "flux-import.home-jobs.status-created", message: "Waiting to start" },
	running: { id: "flux-import.home-jobs.status-running", message: "Running" },
	paused: { id: "flux-import.home-jobs.status-paused", message: "Paused" },
	completed: { id: "flux-import.home-jobs.status-completed", message: "Completed" },
	cancelled: { id: "flux-import.home-jobs.status-cancelled", message: "Cancelled" },
	failed: { id: "flux-import.home-jobs.status-failed", message: "Failed" },
};
