import type { PauseReason } from "../../../plugin/schedules.js";
import type { Msg, PluralMsg } from "../../i18n.js";

/** Why a schedule paused (`pause.reason`), read after "Paused: " (spec "Schedules"). */
export const PAUSE_MESSAGES = {
	template_gone: {
		id: "fluximporter.home-schedules.pause-template-gone",
		message: "its template was deleted",
	},
	template_changed: {
		id: "fluximporter.home-schedules.pause-template-changed",
		message: "its template changed after it was scheduled",
	},
	source_gone: {
		id: "fluximporter.home-schedules.pause-source-gone",
		message: "its source was deleted",
	},
	source_changed: {
		id: "fluximporter.home-schedules.pause-source-changed",
		message: "its source's address or credential changed",
	},
	creator_gone: {
		id: "fluximporter.home-schedules.pause-creator-gone",
		message: "the person who turned it on can no longer import",
	},
	invalid_template: {
		id: "fluximporter.home-schedules.pause-invalid-template",
		message: "its template no longer fits the site",
	},
	credential_missing: {
		id: "fluximporter.home-schedules.pause-credential-missing",
		message: "its source's credential no longer exists",
	},
	url_blocked: {
		id: "fluximporter.home-schedules.pause-url-blocked",
		message: "its source's address cannot be fetched from the site",
	},
	too_large: {
		id: "fluximporter.home-schedules.pause-too-large",
		message: "the feed was larger than the site accepts",
	},
	fetch_failed: {
		id: "fluximporter.home-schedules.pause-fetch-failed",
		message: "the feed could not be fetched several times in a row",
	},
	job_failed: {
		id: "fluximporter.home-schedules.pause-job-failed",
		message: "an import it ran failed",
	},
	cancelled: {
		id: "fluximporter.home-schedules.pause-cancelled",
		message: "an import it ran was cancelled",
	},
	rolled_back: {
		id: "fluximporter.home-schedules.pause-rolled-back",
		message: "an import it ran was rolled back",
	},
	missing_refused: {
		id: "fluximporter.home-schedules.pause-missing-refused",
		message: "too many entries were missing from the feed",
	},
	empty_feed: {
		id: "fluximporter.home-schedules.pause-empty-feed",
		message: "the feed was empty",
	},
} as const satisfies Readonly<Record<PauseReason, Msg>>;

/**
 * The fence banner (plan Ruling 8), titled by the kind of fence. Neither `clear` nor `import`:
 * while a site import runs, the home itself says so and waits.
 */
export const FENCE_MESSAGES = {
	export: {
		id: "fluximporter.home-schedules.fence-export",
		message: "The site is locked for an export.",
	},
	media: {
		id: "fluximporter.home-schedules.fence-media",
		message: "EmDash is turning on media tracking.",
	},
	error: {
		id: "fluximporter.home-schedules.fence-error",
		message: "Flux Importer couldn't check whether the site is busy.",
	},
} satisfies Record<string, Msg>;

/** A day of the week as cron counts it: 0 is Sunday. */
export type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Each weekly schedule's description, Sunday (0) first, as cron counts days. */
export const WEEKLY = {
	0: { id: "fluximporter.home-schedules.weekly-sun", message: "Every Sunday at {time} UTC" },
	1: { id: "fluximporter.home-schedules.weekly-mon", message: "Every Monday at {time} UTC" },
	2: { id: "fluximporter.home-schedules.weekly-tue", message: "Every Tuesday at {time} UTC" },
	3: { id: "fluximporter.home-schedules.weekly-wed", message: "Every Wednesday at {time} UTC" },
	4: { id: "fluximporter.home-schedules.weekly-thu", message: "Every Thursday at {time} UTC" },
	5: { id: "fluximporter.home-schedules.weekly-fri", message: "Every Friday at {time} UTC" },
	6: { id: "fluximporter.home-schedules.weekly-sat", message: "Every Saturday at {time} UTC" },
} as const satisfies Readonly<Record<Day, Msg>>;

/** The day picker's names, Sunday (0) first. */
export const DAYS = {
	0: { id: "fluximporter.home-schedules.day-sun", message: "Sunday" },
	1: { id: "fluximporter.home-schedules.day-mon", message: "Monday" },
	2: { id: "fluximporter.home-schedules.day-tue", message: "Tuesday" },
	3: { id: "fluximporter.home-schedules.day-wed", message: "Wednesday" },
	4: { id: "fluximporter.home-schedules.day-thu", message: "Thursday" },
	5: { id: "fluximporter.home-schedules.day-fri", message: "Friday" },
	6: { id: "fluximporter.home-schedules.day-sat", message: "Saturday" },
} as const satisfies Readonly<Record<Day, Msg>>;

/** A run log entry's outcome (`RunEntry["outcome"]`). */
export const RUN_OUTCOMES = {
	completed: { id: "fluximporter.home-schedules.run-completed", message: "Completed" },
	failed: { id: "fluximporter.home-schedules.run-failed", message: "Failed" },
	cancelled: { id: "fluximporter.home-schedules.run-cancelled", message: "Cancelled" },
	missing_refused: {
		id: "fluximporter.home-schedules.run-missing-refused",
		message: "Stopped: too many entries were missing from the feed",
	},
	empty_feed: {
		id: "fluximporter.home-schedules.run-empty-feed",
		message: "Stopped: the feed was empty",
	},
} satisfies Record<string, Msg>;

/** The Schedules tab, its dialogs and its run log. */
export const M = {
	// The fence banner's second sentence
	fenceWait: {
		id: "fluximporter.home-schedules.fence-wait",
		message: "Scheduled runs wait until it ends.",
	},
	fenceCheckWait: {
		id: "fluximporter.home-schedules.fence-check-wait",
		message: "Scheduled runs wait until the check succeeds.",
	},
	// Timing (plan Ruling 13)
	hourly: { id: "fluximporter.home-schedules.hourly", message: "Every hour at minute {minute}" },
	daily: { id: "fluximporter.home-schedules.daily", message: "Every day at {time} UTC" },
	custom: { id: "fluximporter.home-schedules.custom", message: "Custom: {cron} (UTC)" },
	pauseUnknown: {
		id: "fluximporter.home-schedules.pause-unknown",
		message: "for a reason this version does not know",
	},
	// Last launch
	launchStarted: {
		id: "fluximporter.home-schedules.launch-started",
		message: "Started an import.",
	},
	launchUnchanged: {
		id: "fluximporter.home-schedules.launch-unchanged",
		message: "The feed had not changed, so nothing was imported.",
	},
	launchBusy: {
		id: "fluximporter.home-schedules.launch-busy",
		message: "Skipped: an import from this source was still running.",
	},
	launchFailed: {
		id: "fluximporter.home-schedules.launch-failed",
		message: "Couldn't start: {reason}",
	},
	neverLaunched: { id: "fluximporter.home-schedules.never-launched", message: "Never launched" },
	// The list
	loading: { id: "fluximporter.home-schedules.loading", message: "Loading schedules" },
	loadFailed: {
		id: "fluximporter.home-schedules.load-failed",
		message: "Schedules could not be loaded.",
	},
	newSchedule: { id: "fluximporter.home-schedules.new", message: "New schedule" },
	atLimit: {
		id: "fluximporter.home-schedules.at-limit",
		message: "The site holds at most {max} schedules. Delete one to add another.",
	},
	empty: { id: "fluximporter.home-schedules.empty", message: "No schedules yet" },
	emptyHint: {
		id: "fluximporter.home-schedules.empty-hint",
		message: "A schedule runs a saved template on a saved URL source, on a timer.",
	},
	noTemplate: { id: "fluximporter.home-schedules.no-template", message: "No template saved yet" },
	noSource: { id: "fluximporter.home-schedules.no-source", message: "No URL source yet" },
	addSource: { id: "fluximporter.home-schedules.add-source", message: "Add a source" },
	colSchedule: { id: "fluximporter.home-schedules.col-schedule", message: "Schedule" },
	colSource: { id: "fluximporter.home-schedules.col-source", message: "Source" },
	colWhen: { id: "fluximporter.home-schedules.col-when", message: "When" },
	colLast: { id: "fluximporter.home-schedules.col-last", message: "Last run" },
	colActive: { id: "fluximporter.home-schedules.col-active", message: "Active" },
	colActions: { id: "fluximporter.home-schedules.col-actions", message: "Actions" },
	templateTarget: {
		id: "fluximporter.home-schedules.template-target",
		message: "{template} → {collection} · {locale}",
	},
	deletedTemplate: {
		id: "fluximporter.home-schedules.deleted-template",
		message: "Deleted template",
	},
	deletedSource: { id: "fluximporter.home-schedules.deleted-source", message: "Deleted source" },
	next: { id: "fluximporter.home-schedules.next", message: "Next: {when}" },
	notScheduled: { id: "fluximporter.home-schedules.not-scheduled", message: "Not scheduled" },
	stateQueued: { id: "fluximporter.home-schedules.state-queued", message: "Queued" },
	statePaused: { id: "fluximporter.home-schedules.state-paused", message: "Paused" },
	pausedBecause: {
		id: "fluximporter.home-schedules.paused-because",
		message: "Because {reason}.",
	},
	pausedUnknown: {
		id: "fluximporter.home-schedules.paused-unknown",
		message: "For a reason this version does not know.",
	},
	resumeRepins: {
		id: "fluximporter.home-schedules.resume-repins",
		message: "Switched on, it runs the template's current version.",
	},
	resumeTemplateGone: {
		id: "fluximporter.home-schedules.resume-template-gone",
		message: "Its template is no longer saved. Edit the schedule to choose one.",
	},
	willPause: {
		id: "fluximporter.home-schedules.will-pause",
		message: "Will pause at its next run: its template changed.",
	},
	repin: { id: "fluximporter.home-schedules.repin", message: "Use the current version" },
	repinRow: {
		id: "fluximporter.home-schedules.repin-row",
		message: "Use the current version for {name}",
	},
	// Row actions: the visible label, and the accessible name that names the row
	activeRow: { id: "fluximporter.home-schedules.active-row", message: "Active: {name}" },
	actionsRow: { id: "fluximporter.home-schedules.actions-row", message: "Actions for {name}" },
	runNow: { id: "fluximporter.home-schedules.run-now", message: "Run now" },
	runNowRow: { id: "fluximporter.home-schedules.run-now-row", message: "Run now {name}" },
	edit: { id: "fluximporter.home-schedules.edit", message: "Edit" },
	editRow: { id: "fluximporter.home-schedules.edit-row", message: "Edit {name}" },
	delete: { id: "fluximporter.home-schedules.delete", message: "Delete" },
	deleteRow: { id: "fluximporter.home-schedules.delete-row", message: "Delete {name}" },
	runLog: { id: "fluximporter.home-schedules.run-log", message: "Run log" },
	runLogRow: { id: "fluximporter.home-schedules.run-log-row", message: "Run log of {name}" },
	// Announcements and failures
	paused: { id: "fluximporter.home-schedules.paused", message: "Paused {name}." },
	resumed: { id: "fluximporter.home-schedules.resumed", message: "Resumed {name}." },
	repinned: {
		id: "fluximporter.home-schedules.repinned",
		message: "Updated {name} to its template's current version.",
	},
	queued: { id: "fluximporter.home-schedules.queued", message: "Queued a run of {name}." },
	deleted: { id: "fluximporter.home-schedules.deleted", message: "Deleted {name}." },
	created: { id: "fluximporter.home-schedules.created", message: "Created {name}." },
	saved: { id: "fluximporter.home-schedules.saved", message: "Saved {name}." },
	actionFailed: { id: "fluximporter.home-schedules.action-failed", message: "{name}: {reason}" },
	changedElsewhere: {
		id: "fluximporter.home-schedules.changed-elsewhere",
		message: "This schedule changed elsewhere.",
	},
	reload: { id: "fluximporter.home-schedules.reload", message: "Reload" },
	// Delete
	deleteTitle: { id: "fluximporter.home-schedules.delete-title", message: "Delete {name}?" },
	deleteSentence: {
		id: "fluximporter.home-schedules.delete-sentence",
		message: "{name} stops running and its run log is deleted. The imports it ran stay.",
	},
	deleteConfirm: { id: "fluximporter.home-schedules.delete-confirm", message: "Delete schedule" },
	// The run log
	runLogTitle: { id: "fluximporter.home-schedules.run-log-title", message: "{name}: run log" },
	noRuns: { id: "fluximporter.home-schedules.no-runs", message: "No runs yet." },
	colFinished: { id: "fluximporter.home-schedules.col-finished", message: "Finished" },
	colOutcome: { id: "fluximporter.home-schedules.col-outcome", message: "Outcome" },
	colCounts: { id: "fluximporter.home-schedules.col-counts", message: "Records" },
	colImport: { id: "fluximporter.home-schedules.col-import", message: "Import" },
	runUnknown: { id: "fluximporter.home-schedules.run-unknown", message: "Unknown outcome" },
	rolledBack: { id: "fluximporter.home-schedules.rolled-back", message: "Rolled back" },
	openRun: { id: "fluximporter.home-schedules.open-run", message: "Open" },
	openRunRow: {
		id: "fluximporter.home-schedules.open-run-row",
		message: "Open the import that finished {when}",
	},
	close: { id: "fluximporter.home-schedules.close", message: "Close" },
	// The create and edit dialog
	createTitle: { id: "fluximporter.home-schedules.create-title", message: "New schedule" },
	editTitle: { id: "fluximporter.home-schedules.edit-title", message: "Edit {name}" },
	dialogSentence: {
		id: "fluximporter.home-schedules.dialog-sentence",
		message: "A schedule fetches a URL source and imports it with a saved template.",
	},
	nothingToSchedule: {
		id: "fluximporter.home-schedules.nothing-to-schedule",
		message: "Save a template and add a URL source first.",
	},
	goTemplates: { id: "fluximporter.home-schedules.go-templates", message: "Go to Templates" },
	goSources: { id: "fluximporter.home-schedules.go-sources", message: "Go to Sources" },
	loadingChoices: {
		id: "fluximporter.home-schedules.loading-choices",
		message: "Loading templates and sources",
	},
	loadingTemplate: {
		id: "fluximporter.home-schedules.loading-template",
		message: "Loading the template",
	},
	name: { id: "fluximporter.home-schedules.name", message: "Name" },
	template: { id: "fluximporter.home-schedules.template", message: "Template" },
	source: { id: "fluximporter.home-schedules.source", message: "URL source" },
	templatePlaceholder: {
		id: "fluximporter.home-schedules.template-placeholder",
		message: "Choose a template",
	},
	sourcePlaceholder: {
		id: "fluximporter.home-schedules.source-placeholder",
		message: "Choose a URL source",
	},
	when: { id: "fluximporter.home-schedules.when", message: "When it runs" },
	kindHourly: { id: "fluximporter.home-schedules.kind-hourly", message: "Hourly" },
	kindDaily: { id: "fluximporter.home-schedules.kind-daily", message: "Daily" },
	kindWeekly: { id: "fluximporter.home-schedules.kind-weekly", message: "Weekly" },
	kindCustom: { id: "fluximporter.home-schedules.kind-custom", message: "Custom" },
	utcNote: {
		id: "fluximporter.home-schedules.utc-note",
		message: "Times are in UTC, as EmDash runs schedules.",
	},
	minute: { id: "fluximporter.home-schedules.minute", message: "Minute past the hour" },
	time: { id: "fluximporter.home-schedules.time", message: "Time (UTC)" },
	day: { id: "fluximporter.home-schedules.day", message: "Day" },
	cron: { id: "fluximporter.home-schedules.cron", message: "Cron expression (UTC)" },
	cronHint: {
		id: "fluximporter.home-schedules.cron-hint",
		message:
			"Five fields: minute, hour, day of month, month and day of week; or @hourly, @daily, @weekly, @monthly or @yearly.",
	},
	entries: { id: "fluximporter.home-schedules.entries", message: "Imported entries" },
	publish: { id: "fluximporter.home-schedules.publish", message: "Publish them" },
	draft: { id: "fluximporter.home-schedules.draft", message: "Save them as drafts" },
	batchSize: { id: "fluximporter.home-schedules.batch-size", message: "Batch size (optional)" },
	batchSizeHint: {
		id: "fluximporter.home-schedules.batch-size-hint",
		message: "Entries per batch, from 1 to {max}. Leave it empty for the default.",
	},
	missing: { id: "fluximporter.home-schedules.missing", message: "Entries missing from the feed" },
	missingTemplate: {
		id: "fluximporter.home-schedules.missing-template",
		message: "As the template sets",
	},
	missingOff: { id: "fluximporter.home-schedules.missing-off", message: "Off" },
	missingLower: { id: "fluximporter.home-schedules.missing-lower", message: "A lower threshold" },
	maxPercent: {
		id: "fluximporter.home-schedules.max-percent",
		message: "Stop when more than this percent is missing",
	},
	maxPercentHint: {
		id: "fluximporter.home-schedules.max-percent-hint",
		message: "At most {max}, the template's own threshold.",
	},
	create: { id: "fluximporter.home-schedules.create", message: "Create schedule" },
	save: { id: "fluximporter.home-schedules.save", message: "Save changes" },
	// The dialog's own checks
	nameRequired: { id: "fluximporter.home-schedules.name-required", message: "Enter a name." },
	nameTooLong: {
		id: "fluximporter.home-schedules.name-too-long",
		message: "Use at most {max} characters.",
	},
	templateRequired: {
		id: "fluximporter.home-schedules.template-required",
		message: "Choose a template.",
	},
	sourceRequired: {
		id: "fluximporter.home-schedules.source-required",
		message: "Choose a URL source.",
	},
	minuteInvalid: {
		id: "fluximporter.home-schedules.minute-invalid",
		message: "Enter a minute from 0 to 59.",
	},
	timeInvalid: {
		id: "fluximporter.home-schedules.time-invalid",
		message: "Enter a time such as 06:00.",
	},
	cronRequired: {
		id: "fluximporter.home-schedules.cron-required",
		message: "Enter a cron expression.",
	},
	wholeNumber: {
		id: "fluximporter.home-schedules.whole-number",
		message: "Enter a whole number from {min} to {max}.",
	},
} satisfies Record<string, Msg>;

/** Counts in words, with plural forms. */
export const N = {
	schedules: {
		id: "fluximporter.home-schedules.count-schedules",
		one: "{count} schedule",
		other: "{count} schedules",
	},
	active: {
		id: "fluximporter.home-schedules.count-active",
		one: "{count} active",
		other: "{count} active",
	},
	paused: {
		id: "fluximporter.home-schedules.count-paused",
		one: "{count} paused",
		other: "{count} paused",
	},
	templatesSaved: {
		id: "fluximporter.home-schedules.templates-saved",
		one: "{count} template saved",
		other: "{count} templates saved",
	},
	sourcesSaved: {
		id: "fluximporter.home-schedules.sources-saved",
		one: "{count} URL source saved",
		other: "{count} URL sources saved",
	},
	runLogSentence: {
		id: "fluximporter.home-schedules.run-log-sentence",
		one: "{timing} \u00b7 {count} run",
		other: "{timing} \u00b7 last {count} runs, newest first",
	},
} satisfies Record<string, PluralMsg>;
