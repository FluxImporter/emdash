import type { PauseReason } from "../../../plugin/schedules.js";
import type { Msg } from "../../i18n.js";

/** Why a schedule paused (`pause.reason`), read after "Paused: " (spec "Schedules"). */
export const PAUSE_MESSAGES = {
	template_gone: {
		id: "flux-import.home-schedules.pause-template-gone",
		message: "its template was deleted",
	},
	template_changed: {
		id: "flux-import.home-schedules.pause-template-changed",
		message: "its template changed after it was scheduled",
	},
	source_gone: {
		id: "flux-import.home-schedules.pause-source-gone",
		message: "its source was deleted",
	},
	source_changed: {
		id: "flux-import.home-schedules.pause-source-changed",
		message: "its source's address or credential changed",
	},
	creator_gone: {
		id: "flux-import.home-schedules.pause-creator-gone",
		message: "the person who turned it on can no longer import",
	},
	invalid_template: {
		id: "flux-import.home-schedules.pause-invalid-template",
		message: "its template no longer fits the site",
	},
	credential_missing: {
		id: "flux-import.home-schedules.pause-credential-missing",
		message: "its source's credential no longer exists",
	},
	url_blocked: {
		id: "flux-import.home-schedules.pause-url-blocked",
		message: "its source's address cannot be fetched from the site",
	},
	too_large: {
		id: "flux-import.home-schedules.pause-too-large",
		message: "the feed was larger than the site accepts",
	},
	fetch_failed: {
		id: "flux-import.home-schedules.pause-fetch-failed",
		message: "the feed could not be fetched several times in a row",
	},
	job_failed: {
		id: "flux-import.home-schedules.pause-job-failed",
		message: "an import it ran failed",
	},
	cancelled: {
		id: "flux-import.home-schedules.pause-cancelled",
		message: "an import it ran was cancelled",
	},
	rolled_back: {
		id: "flux-import.home-schedules.pause-rolled-back",
		message: "an import it ran was rolled back",
	},
	missing_refused: {
		id: "flux-import.home-schedules.pause-missing-refused",
		message: "too many entries were missing from the feed",
	},
	empty_feed: {
		id: "flux-import.home-schedules.pause-empty-feed",
		message: "the feed was empty",
	},
} as const satisfies Readonly<Record<PauseReason, Msg>>;

/** The fence banner (plan Ruling 8): one sentence per kind but `clear`. */
export const FENCE_MESSAGES = {
	import: {
		id: "flux-import.home-schedules.fence-import",
		message: "An import into this site is running, so scheduled runs wait until it ends.",
	},
	export: {
		id: "flux-import.home-schedules.fence-export",
		message: "An export of this site is running, so scheduled runs wait until it ends.",
	},
	media: {
		id: "flux-import.home-schedules.fence-media",
		message: "EmDash is turning on media tracking, so scheduled runs wait until it ends.",
	},
	error: {
		id: "flux-import.home-schedules.fence-error",
		message: "flux-import couldn't check whether the site is busy, so scheduled runs wait.",
	},
} satisfies Record<string, Msg>;

/** A day of the week as cron counts it: 0 is Sunday. */
export type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Each weekly schedule's description, Sunday (0) first, as cron counts days. */
export const WEEKLY = {
	0: { id: "flux-import.home-schedules.weekly-sun", message: "Every Sunday at {time} UTC" },
	1: { id: "flux-import.home-schedules.weekly-mon", message: "Every Monday at {time} UTC" },
	2: { id: "flux-import.home-schedules.weekly-tue", message: "Every Tuesday at {time} UTC" },
	3: { id: "flux-import.home-schedules.weekly-wed", message: "Every Wednesday at {time} UTC" },
	4: { id: "flux-import.home-schedules.weekly-thu", message: "Every Thursday at {time} UTC" },
	5: { id: "flux-import.home-schedules.weekly-fri", message: "Every Friday at {time} UTC" },
	6: { id: "flux-import.home-schedules.weekly-sat", message: "Every Saturday at {time} UTC" },
} as const satisfies Readonly<Record<Day, Msg>>;

/** The day picker's names, Sunday (0) first. */
export const DAYS = {
	0: { id: "flux-import.home-schedules.day-sun", message: "Sunday" },
	1: { id: "flux-import.home-schedules.day-mon", message: "Monday" },
	2: { id: "flux-import.home-schedules.day-tue", message: "Tuesday" },
	3: { id: "flux-import.home-schedules.day-wed", message: "Wednesday" },
	4: { id: "flux-import.home-schedules.day-thu", message: "Thursday" },
	5: { id: "flux-import.home-schedules.day-fri", message: "Friday" },
	6: { id: "flux-import.home-schedules.day-sat", message: "Saturday" },
} as const satisfies Readonly<Record<Day, Msg>>;

/** A run log entry's outcome (`RunEntry["outcome"]`). */
export const RUN_OUTCOMES = {
	completed: { id: "flux-import.home-schedules.run-completed", message: "Completed" },
	failed: { id: "flux-import.home-schedules.run-failed", message: "Failed" },
	cancelled: { id: "flux-import.home-schedules.run-cancelled", message: "Cancelled" },
	missing_refused: {
		id: "flux-import.home-schedules.run-missing-refused",
		message: "Stopped: too many entries were missing from the feed",
	},
	empty_feed: {
		id: "flux-import.home-schedules.run-empty-feed",
		message: "Stopped: the feed was empty",
	},
} satisfies Record<string, Msg>;

/** The Schedules tab, its dialogs and its run log. */
export const M = {
	// Timing (plan Ruling 13)
	hourly: { id: "flux-import.home-schedules.hourly", message: "Every hour at minute {minute}" },
	daily: { id: "flux-import.home-schedules.daily", message: "Every day at {time} UTC" },
	custom: { id: "flux-import.home-schedules.custom", message: "Custom: {cron} (UTC)" },
	pauseUnknown: {
		id: "flux-import.home-schedules.pause-unknown",
		message: "for a reason this version does not know",
	},
	// Last launch
	launchStarted: { id: "flux-import.home-schedules.launch-started", message: "Started an import." },
	launchUnchanged: {
		id: "flux-import.home-schedules.launch-unchanged",
		message: "The feed had not changed, so nothing was imported.",
	},
	launchBusy: {
		id: "flux-import.home-schedules.launch-busy",
		message: "Skipped: an import from this source was still running.",
	},
	launchFailed: {
		id: "flux-import.home-schedules.launch-failed",
		message: "Couldn't start: {reason}",
	},
	neverLaunched: { id: "flux-import.home-schedules.never-launched", message: "Never launched" },
	// The table
	loading: { id: "flux-import.home-schedules.loading", message: "Loading schedules" },
	newSchedule: { id: "flux-import.home-schedules.new", message: "New schedule" },
	atLimit: {
		id: "flux-import.home-schedules.at-limit",
		message: "The site holds at most {max} schedules. Delete one to add another.",
	},
	empty: { id: "flux-import.home-schedules.empty", message: "No schedules yet." },
	emptyHint: {
		id: "flux-import.home-schedules.empty-hint",
		message: "A schedule imports from a saved URL source with a saved template, on a timer.",
	},
	colName: { id: "flux-import.home-schedules.col-name", message: "Name" },
	colTemplate: { id: "flux-import.home-schedules.col-template", message: "Template" },
	colSource: { id: "flux-import.home-schedules.col-source", message: "Source" },
	colTiming: { id: "flux-import.home-schedules.col-timing", message: "When it runs" },
	colNext: { id: "flux-import.home-schedules.col-next", message: "Next run" },
	colLast: { id: "flux-import.home-schedules.col-last", message: "Last launch" },
	colState: { id: "flux-import.home-schedules.col-state", message: "State" },
	colActions: { id: "flux-import.home-schedules.col-actions", message: "Actions" },
	deletedTemplate: {
		id: "flux-import.home-schedules.deleted-template",
		message: "Deleted template",
	},
	deletedSource: { id: "flux-import.home-schedules.deleted-source", message: "Deleted source" },
	utcTime: { id: "flux-import.home-schedules.utc-time", message: "{time} UTC" },
	notScheduled: { id: "flux-import.home-schedules.not-scheduled", message: "Not scheduled" },
	stateQueued: { id: "flux-import.home-schedules.state-queued", message: "Queued" },
	stateRunning: { id: "flux-import.home-schedules.state-running", message: "Running" },
	statePausedFor: {
		id: "flux-import.home-schedules.state-paused-for",
		message: "Paused: {reason}",
	},
	statePaused: { id: "flux-import.home-schedules.state-paused", message: "Paused" },
	resumeRepins: {
		id: "flux-import.home-schedules.resume-repins",
		message: "Resume runs the template's current version.",
	},
	resumeTemplateGone: {
		id: "flux-import.home-schedules.resume-template-gone",
		message: "Its template is no longer saved. Edit the schedule to choose one.",
	},
	// Row actions: the visible label, and the accessible name that names the row
	pause: { id: "flux-import.home-schedules.pause", message: "Pause" },
	pauseRow: { id: "flux-import.home-schedules.pause-row", message: "Pause {name}" },
	resume: { id: "flux-import.home-schedules.resume", message: "Resume" },
	resumeRow: { id: "flux-import.home-schedules.resume-row", message: "Resume {name}" },
	runNow: { id: "flux-import.home-schedules.run-now", message: "Run now" },
	runNowRow: { id: "flux-import.home-schedules.run-now-row", message: "Run {name} now" },
	edit: { id: "flux-import.home-schedules.edit", message: "Edit" },
	editRow: { id: "flux-import.home-schedules.edit-row", message: "Edit {name}" },
	delete: { id: "flux-import.home-schedules.delete", message: "Delete" },
	deleteRow: { id: "flux-import.home-schedules.delete-row", message: "Delete {name}" },
	runLog: { id: "flux-import.home-schedules.run-log", message: "Run log" },
	runLogRow: { id: "flux-import.home-schedules.run-log-row", message: "Run log of {name}" },
	// Announcements and failures
	paused: { id: "flux-import.home-schedules.paused", message: "Paused {name}." },
	resumed: { id: "flux-import.home-schedules.resumed", message: "Resumed {name}." },
	queued: { id: "flux-import.home-schedules.queued", message: "Queued a run of {name}." },
	deleted: { id: "flux-import.home-schedules.deleted", message: "Deleted {name}." },
	created: { id: "flux-import.home-schedules.created", message: "Created {name}." },
	saved: { id: "flux-import.home-schedules.saved", message: "Saved {name}." },
	actionFailed: { id: "flux-import.home-schedules.action-failed", message: "{name}: {reason}" },
	changedElsewhere: {
		id: "flux-import.home-schedules.changed-elsewhere",
		message: "This schedule changed elsewhere.",
	},
	reload: { id: "flux-import.home-schedules.reload", message: "Reload" },
	// Delete
	deleteTitle: { id: "flux-import.home-schedules.delete-title", message: "Delete {name}?" },
	deleteSentence: {
		id: "flux-import.home-schedules.delete-sentence",
		message: "{name} stops running and its run log is deleted. The imports it ran stay.",
	},
	deleteConfirm: { id: "flux-import.home-schedules.delete-confirm", message: "Delete schedule" },
	// The run log
	runLogTitle: { id: "flux-import.home-schedules.run-log-title", message: "Run log of {name}" },
	runLogSentence: {
		id: "flux-import.home-schedules.run-log-sentence",
		message: "The schedule's latest runs, newest first.",
	},
	noRuns: { id: "flux-import.home-schedules.no-runs", message: "No runs yet." },
	colFinished: { id: "flux-import.home-schedules.col-finished", message: "Finished" },
	colOutcome: { id: "flux-import.home-schedules.col-outcome", message: "Outcome" },
	colCounts: { id: "flux-import.home-schedules.col-counts", message: "Counts" },
	colImport: { id: "flux-import.home-schedules.col-import", message: "Import" },
	counts: {
		id: "flux-import.home-schedules.counts",
		message: "Created: {created}. Updated: {updated}. Unchanged: {unchanged}. Failed: {failed}.",
	},
	countRemoved: { id: "flux-import.home-schedules.count-removed", message: "Removed: {count}." },
	countConflict: {
		id: "flux-import.home-schedules.count-conflict",
		message: "Conflicts: {count}.",
	},
	countLocked: { id: "flux-import.home-schedules.count-locked", message: "Locked: {count}." },
	runUnknown: { id: "flux-import.home-schedules.run-unknown", message: "Unknown outcome" },
	rolledBack: { id: "flux-import.home-schedules.rolled-back", message: "Rolled back" },
	openRun: { id: "flux-import.home-schedules.open-run", message: "Open" },
	openRunRow: {
		id: "flux-import.home-schedules.open-run-row",
		message: "Open the import that finished {when}",
	},
	close: { id: "flux-import.home-schedules.close", message: "Close" },
	// The create and edit dialog
	createTitle: { id: "flux-import.home-schedules.create-title", message: "New schedule" },
	editTitle: { id: "flux-import.home-schedules.edit-title", message: "Edit {name}" },
	dialogSentence: {
		id: "flux-import.home-schedules.dialog-sentence",
		message: "A schedule fetches a URL source and imports it with a saved template.",
	},
	nothingToSchedule: {
		id: "flux-import.home-schedules.nothing-to-schedule",
		message: "Save a template and add a URL source first.",
	},
	goTemplates: { id: "flux-import.home-schedules.go-templates", message: "Go to Templates" },
	goSources: { id: "flux-import.home-schedules.go-sources", message: "Go to Sources" },
	loadingChoices: {
		id: "flux-import.home-schedules.loading-choices",
		message: "Loading templates and sources",
	},
	loadingTemplate: {
		id: "flux-import.home-schedules.loading-template",
		message: "Loading the template",
	},
	name: { id: "flux-import.home-schedules.name", message: "Name" },
	template: { id: "flux-import.home-schedules.template", message: "Template" },
	source: { id: "flux-import.home-schedules.source", message: "URL source" },
	when: { id: "flux-import.home-schedules.when", message: "When it runs" },
	kindHourly: { id: "flux-import.home-schedules.kind-hourly", message: "Hourly" },
	kindDaily: { id: "flux-import.home-schedules.kind-daily", message: "Daily" },
	kindWeekly: { id: "flux-import.home-schedules.kind-weekly", message: "Weekly" },
	kindCustom: { id: "flux-import.home-schedules.kind-custom", message: "Custom" },
	utcNote: {
		id: "flux-import.home-schedules.utc-note",
		message: "Times are in UTC, as EmDash runs schedules.",
	},
	minute: { id: "flux-import.home-schedules.minute", message: "Minute past the hour" },
	time: { id: "flux-import.home-schedules.time", message: "Time (UTC)" },
	day: { id: "flux-import.home-schedules.day", message: "Day" },
	cron: { id: "flux-import.home-schedules.cron", message: "Cron expression (UTC)" },
	cronHint: {
		id: "flux-import.home-schedules.cron-hint",
		message:
			"Five fields: minute, hour, day of month, month and day of week; or @hourly, @daily, @weekly, @monthly or @yearly.",
	},
	entries: { id: "flux-import.home-schedules.entries", message: "Imported entries" },
	publish: { id: "flux-import.home-schedules.publish", message: "Publish them" },
	draft: { id: "flux-import.home-schedules.draft", message: "Save them as drafts" },
	batchSize: { id: "flux-import.home-schedules.batch-size", message: "Batch size (optional)" },
	batchSizeHint: {
		id: "flux-import.home-schedules.batch-size-hint",
		message: "Entries per batch, from 1 to {max}. Leave it empty for the default.",
	},
	missing: { id: "flux-import.home-schedules.missing", message: "Entries missing from the feed" },
	missingTemplate: {
		id: "flux-import.home-schedules.missing-template",
		message: "As the template sets",
	},
	missingOff: { id: "flux-import.home-schedules.missing-off", message: "Off" },
	missingLower: { id: "flux-import.home-schedules.missing-lower", message: "A lower threshold" },
	maxPercent: {
		id: "flux-import.home-schedules.max-percent",
		message: "Stop when more than this percent is missing",
	},
	maxPercentHint: {
		id: "flux-import.home-schedules.max-percent-hint",
		message: "At most {max}, the template's own threshold.",
	},
	create: { id: "flux-import.home-schedules.create", message: "Create schedule" },
	save: { id: "flux-import.home-schedules.save", message: "Save changes" },
	// The dialog's own checks
	nameRequired: { id: "flux-import.home-schedules.name-required", message: "Enter a name." },
	nameTooLong: {
		id: "flux-import.home-schedules.name-too-long",
		message: "Use at most {max} characters.",
	},
	templateRequired: {
		id: "flux-import.home-schedules.template-required",
		message: "Choose a template.",
	},
	sourceRequired: {
		id: "flux-import.home-schedules.source-required",
		message: "Choose a URL source.",
	},
	minuteInvalid: {
		id: "flux-import.home-schedules.minute-invalid",
		message: "Enter a minute from 0 to 59.",
	},
	timeInvalid: {
		id: "flux-import.home-schedules.time-invalid",
		message: "Enter a time such as 06:00.",
	},
	cronRequired: {
		id: "flux-import.home-schedules.cron-required",
		message: "Enter a cron expression.",
	},
	wholeNumber: {
		id: "flux-import.home-schedules.whole-number",
		message: "Enter a whole number from {min} to {max}.",
	},
} satisfies Record<string, Msg>;
