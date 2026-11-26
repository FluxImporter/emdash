import type { Msg, PluralMsg } from "../../i18n.js";

/** The Run step's messages. */
export const M = {
	starting: { id: "flux-import.run.starting", message: "Starting the import" },
	importing: { id: "flux-import.run.importing", message: "Importing" },
	waiting: {
		id: "flux-import.run.waiting",
		message: "Waiting for the previous batch to finish",
	},
	retrying: {
		id: "flux-import.run.retrying",
		message: "Connection lost; retrying ({attempt} of {max})",
	},
	retryPass: { id: "flux-import.run.retry-pass", message: "Retrying failed records" },
	paused: { id: "flux-import.run.paused", message: "The import is paused." },
	completed: { id: "flux-import.run.completed", message: "Import complete." },
	cancelled: { id: "flux-import.run.cancelled", message: "The import was cancelled." },
	dryRun: { id: "flux-import.run.dry-run", message: "This was a dry run: nothing was written." },
	leaving: {
		id: "flux-import.run.leaving",
		message:
			"Leaving this page pauses nothing: the import stays open and you can come back to it at this address.",
	},
	progress: { id: "flux-import.run.progress", message: "Import progress" },
	progressCount: { id: "flux-import.run.progress-count", message: "{done} of {total} records" },
	timeLeft: { id: "flux-import.run.time-left", message: "About {time} left" },
	pause: { id: "flux-import.run.pause", message: "Pause" },
	resume: { id: "flux-import.run.resume", message: "Resume" },
	cancel: { id: "flux-import.run.cancel", message: "Cancel import" },
	cancelTitle: { id: "flux-import.run.cancel-title", message: "Cancel this import?" },
	cancelBody: {
		id: "flux-import.run.cancel-body",
		message: "Records already imported stay. A cancelled import cannot be resumed.",
	},
	cancelKeep: { id: "flux-import.run.cancel-keep", message: "Keep importing" },
	downloadLog: { id: "flux-import.run.download-log", message: "Download log" },
	downloadFailed: { id: "flux-import.run.download-failed", message: "Download failed records" },
	retryFailed: { id: "flux-import.run.retry-failed", message: "Retry failed records" },
	viewEntries: { id: "flux-import.run.view-entries", message: "View the entries" },
	startNew: { id: "flux-import.run.start-new", message: "New import" },
	counts: { id: "flux-import.run.counts", message: "Records so far" },
	/** The line under Run's heading (Wizard.dc.html); `{when}` is the job's start, in UTC. */
	summary: {
		id: "flux-import.run.summary",
		message: "{source} → {collection} · {locale} · started {when}",
	},
	summaryNoSource: {
		id: "flux-import.run.summary-no-source",
		message: "{collection} · {locale} · started {when}",
	},
} satisfies Record<string, Msg>;

/** The Run step's counts. */
export const COUNT = {
	/** `{count}` is the records a second, to one decimal place. */
	rate: {
		id: "flux-import.run.rate",
		one: "{count} record a second",
		other: "{count} records a second",
	},
} satisfies Record<string, PluralMsg>;
