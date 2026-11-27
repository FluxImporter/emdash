import type { Msg, PluralMsg } from "../../i18n.js";

/** The Run step's messages. */
export const M = {
	starting: { id: "fluximporter.run.starting", message: "Starting the import" },
	importing: { id: "fluximporter.run.importing", message: "Importing" },
	waiting: {
		id: "fluximporter.run.waiting",
		message: "Waiting for the previous batch to finish",
	},
	retrying: {
		id: "fluximporter.run.retrying",
		message: "Connection lost; retrying ({attempt} of {max})",
	},
	retryPass: { id: "fluximporter.run.retry-pass", message: "Retrying failed records" },
	paused: { id: "fluximporter.run.paused", message: "The import is paused." },
	completed: { id: "fluximporter.run.completed", message: "Import complete." },
	cancelled: { id: "fluximporter.run.cancelled", message: "The import was cancelled." },
	dryRun: { id: "fluximporter.run.dry-run", message: "This was a dry run: nothing was written." },
	leaving: {
		id: "fluximporter.run.leaving",
		message:
			"Leaving this page pauses nothing: the import stays open and you can come back to it at this address.",
	},
	progress: { id: "fluximporter.run.progress", message: "Import progress" },
	progressCount: { id: "fluximporter.run.progress-count", message: "{done} of {total} records" },
	timeLeft: { id: "fluximporter.run.time-left", message: "About {time} left" },
	pause: { id: "fluximporter.run.pause", message: "Pause" },
	resume: { id: "fluximporter.run.resume", message: "Resume" },
	cancel: { id: "fluximporter.run.cancel", message: "Cancel import" },
	cancelTitle: { id: "fluximporter.run.cancel-title", message: "Cancel this import?" },
	cancelBody: {
		id: "fluximporter.run.cancel-body",
		message: "Records already imported stay. A cancelled import cannot be resumed.",
	},
	cancelKeep: { id: "fluximporter.run.cancel-keep", message: "Keep importing" },
	downloadLog: { id: "fluximporter.run.download-log", message: "Download log" },
	downloadFailed: { id: "fluximporter.run.download-failed", message: "Download failed records" },
	retryFailed: { id: "fluximporter.run.retry-failed", message: "Retry failed records" },
	viewEntries: { id: "fluximporter.run.view-entries", message: "View the entries" },
	startNew: { id: "fluximporter.run.start-new", message: "New import" },
	counts: { id: "fluximporter.run.counts", message: "Records so far" },
	/** The line under Run's heading (Wizard.dc.html); `{when}` is the job's start, in UTC. */
	summary: {
		id: "fluximporter.run.summary",
		message: "{source} → {collection} · {locale} · started {when}",
	},
	summaryNoSource: {
		id: "fluximporter.run.summary-no-source",
		message: "{collection} · {locale} · started {when}",
	},
} satisfies Record<string, Msg>;

/** The Run step's counts. */
export const COUNT = {
	/** `{count}` is the records a second, to one decimal place. */
	rate: {
		id: "fluximporter.run.rate",
		one: "{count} record a second",
		other: "{count} records a second",
	},
	/** A log line's records: the first part, before what they did. */
	logRecords: {
		id: "fluximporter.run.log-records",
		one: "{count} record",
		other: "{count} records",
	},
	logWarned: {
		id: "fluximporter.run.log-warned",
		one: "{count} record with a warning",
		other: "{count} records with warnings",
	},
} satisfies Record<string, PluralMsg>;

/** Run's live log (StepRun.dc.html): one line per change the driver's replies show. */
export const LOG = {
	title: { id: "fluximporter.run.log-title", message: "Log" },
	started: { id: "fluximporter.run.log-started", message: "Started" },
	resumed: { id: "fluximporter.run.log-resumed", message: "Resumed" },
	paused: { id: "fluximporter.run.log-paused", message: "Paused" },
	completed: { id: "fluximporter.run.log-completed", message: "Finished" },
	cancelled: { id: "fluximporter.run.log-cancelled", message: "Cancelled" },
	retry: { id: "fluximporter.run.log-retry", message: "Retry of the failed records started" },
	missing: {
		id: "fluximporter.run.log-missing",
		message: "Checking for entries missing from the source",
	},
	jobWarning: { id: "fluximporter.run.log-job-warning", message: "Warning:" },
	failed: { id: "fluximporter.run.log-failed", message: "The import stopped with an error." },
} satisfies Record<string, Msg>;
