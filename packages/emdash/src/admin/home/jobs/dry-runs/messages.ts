import type { JobStatus } from "../../../../engine/types.js";
import type { Msg } from "../../../i18n.js";

export const M = {
	count: { id: "fluximporter.home-dry-runs.count", message: "Dry runs: {count}" },
	countMore: {
		id: "fluximporter.home-dry-runs.count-more",
		message: "Dry runs: more than {count}",
	},
	where: { id: "fluximporter.home-dry-runs.where", message: "{collection} · {locale}" },
	notWritten: { id: "fluximporter.home-dry-runs.not-written", message: "Not written to the site." },
	clear: { id: "fluximporter.home-dry-runs.clear", message: "Clear dry runs" },
	confirm: {
		id: "fluximporter.home-dry-runs.confirm",
		message: "Clear the finished and idle dry runs, with their staged files?",
	},
	cleared: { id: "fluximporter.home-dry-runs.cleared", message: "Dry runs cleared: {count}." },
	none: {
		id: "fluximporter.home-dry-runs.none",
		message:
			"No dry runs could be cleared now: running ones, and an agent's from the last 24 hours, are kept.",
	},
} satisfies Record<string, Msg>;

/** A job's status in words, for every list that shows one (kept here, in a messages file, for the boundary test; `status.ts` re-exports it, F11). */
export const STATUS_MESSAGES: Readonly<Record<JobStatus, Msg>> = {
	created: { id: "fluximporter.home-jobs.status-created", message: "Waiting to start" },
	running: { id: "fluximporter.home-jobs.status-running", message: "Running" },
	paused: { id: "fluximporter.home-jobs.status-paused", message: "Paused" },
	completed: { id: "fluximporter.home-jobs.status-completed", message: "Completed" },
	cancelled: { id: "fluximporter.home-jobs.status-cancelled", message: "Cancelled" },
	failed: { id: "fluximporter.home-jobs.status-failed", message: "Failed" },
};
