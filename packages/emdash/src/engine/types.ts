import type { MediaFetcher } from "../sources/media-fetch.js";
import type { TemplateSource } from "../sources/reader.js";
import type { Change, PlanAction } from "./diff.js";
import type { ContentPort, KvCollection, LookupPort, MediaPort, SourcePort } from "./ports.js";
import type { TaxonomySnapshot, Template } from "./template.js";
import type { TargetField } from "./values.js";

export const BATCH_SIZE_DEFAULT = 50;
export const BATCH_SIZE_MAX = 500;
export const BUDGET_MS_DEFAULT = 4000;

export type JobStatus = "created" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface Counters {
	created: number;
	updated: number;
	unchanged: number;
	locked: number;
	conflict: number;
	failed: number;
	/** Records the template's filter skipped. Absent on jobs created before M3b (read as 0). */
	filtered: number;
	/** Rollback jobs: rows reverted, or that a dry run would revert. Absent on imports (read as 0). */
	reverted?: number;
	/**
	 * Import jobs (M5c): entries the missing phase moved to Trash or unpublished, or that a dry run
	 * would. Absent until the first one (read as 0).
	 */
	removed?: number;
}

/** What the missing phase does to an owned entry the feed no longer holds (M5c). */
export type MissingAction = "trash" | "unpublish";

/** The mark the missing phase leaves on a link it acted on (M5c); any import write clears it. */
export type LinkMissing = { jobId: string; action: MissingAction; at: string };

/** M7b: what a rollback job's reverted rows did (plan Ruling 7). */
export interface RollbackUndo {
	/** Entries the import created, deleted or moved to Trash. */
	deleted: number;
	/** Entries the import updated, restored to their earlier revision. */
	restored: number;
	/** Entries the import's missing phase trashed or unpublished, brought back. */
	recovered: number;
}

/** The default `rules.missing.maxPercent` (spec M5c, Ruling 7). */
export const MISSING_MAX_PERCENT_DEFAULT = 25;

/** The missing phase's state on its job (spec M5c "Template and job"). */
export interface MissingState {
	stage: "count" | "act" | "done";
	/** The first seq of the phase's rows: the import's record count. */
	fromSeq: number;
	/** The links query cursor within the stage; absent at a stage's start. */
	cursor?: string;
	/** Count stage: candidate links. */
	owned: number;
	/** Count stage: unseen candidates whose entry exists. */
	found: number;
	/** Act stage: rows written. */
	rows: number;
	/** Act stage: entries trashed or unpublished (or planned); recounted at each act batch. */
	removed: number;
	verdict?: "act" | "refused" | "skipped";
}

/** A term a dry run plans to create, kept on the job so later batches see it. */
export type PlannedTerm = {
	taxonomy: string;
	/** The path from the root: slugs in `slug` mode, labels in `label` mode. */
	path: string[];
	match: "slug" | "label";
};

export interface Job {
	id: string;
	status: JobStatus;
	/** `rollback` for a rollback job (M5a); absent for an import job. */
	kind?: "import" | "rollback";
	/** A rollback job: the import job it rolls back. */
	rollbackOf?: string;
	/** An import job: the real rollback job created for it; it can no longer be resumed or retried. */
	rolledBackBy?: string;
	/**
	 * M7b, rollback jobs: the rows counted in `counters.reverted`, by what they did. Absent on
	 * rollback jobs created before 0.7.0 (unknown).
	 */
	undo?: RollbackUndo;
	/** M7b, rollback jobs: the original's `missing.fromSeq`, when its missing phase had started. */
	missingFrom?: number;
	/**
	 * A real import job keeps a journal of what it changes, so it can be rolled back (M5a). Absent
	 * on dry runs and on jobs created before M5a, which have no journal.
	 */
	journal?: boolean;
	/**
	 * The terms a real job created, which a rollback keeps (M5a): names (at most `CREATED_LISTED`)
	 * and the total. Saved with each batch; absent until it creates one. The media warning reads
	 * `journalMedia` instead.
	 */
	created?: { terms: string[]; termCount: number };
	/**
	 * Retention is deleting the job (M5a): set before any of its rows go, so a rollback of it is
	 * refused and a rollback job already created for it fails when it next runs.
	 */
	purging?: boolean;
	/** An import job created from a URL source: the source's ID (M5a). */
	sourceId?: string;
	/**
	 * M6a: the saved template the job was created from, and its revision then; absent for an
	 * inline template. A rollback job copies both.
	 */
	templateId?: string;
	templateRevision?: number;
	/**
	 * M6c: the job was created by the agent routes (`jobs/plan`, `jobs/start`), under their rules:
	 * a saved template, no missing phase, always a journal. M6b: `"schedule"`, created by a
	 * schedule's launch (spec Ruling 22). Never inferred from a job's shape, and never copied by a
	 * rollback (M6c spec Ruling 31).
	 */
	origin?: "agent" | "schedule";
	/** M6b: the schedule that launched the job; not copied by a rollback. */
	scheduleId?: string;
	/** M6b: a scheduled job is `"open"` until the pump finalizes it (spec Ruling 38). */
	scheduled?: "open" | "closed";
	/**
	 * M6b (spec Ruling 33): the URL source whose data the job reads, or that a rollback undoes. Set
	 * on every job `jobFromSource` creates, on a real job started from a URL-source dry run (which
	 * has no `sourceId`, M6c Ruling 9), and on a rollback, copied from its original.
	 */
	feedSourceId?: string;
	/** M6c: a real job from `jobs/start`: the dry run it imports. */
	dryRunOf?: string;
	/** M6c: a dry run from `jobs/plan`: the real job `jobs/start` claimed for it (Ruling 38). */
	startedAs?: string;
	/**
	 * Whether the collection keeps revisions (M5b, read at job creation when the template maps
	 * `publishAt`): without them an update of a published entry is live at once and cannot be
	 * scheduled. Absent when the template maps no `publishAt`.
	 */
	revisions?: boolean;
	/**
	 * `false` when the collection refuses schedules (EmDash 1.5's `no-scheduling`, read at job
	 * creation when the template maps `publishAt`): a record whose time is ahead is saved as a draft
	 * with a `scheduling_disabled` warning instead. Absent otherwise (and on older jobs).
	 */
	scheduling?: false;
	/**
	 * M5c: the missing phase's threshold, resolved at job creation from `rules.missing` and the job
	 * option `missing` (`false`: the option turned the phase off). Absent without `rules.missing`.
	 */
	missingLimit?: { maxPercent: number } | false;
	/**
	 * M5c: first-pass rows without a readable key, the rows the XLSX converter skipped included.
	 * Any skips the missing phase (spec "When it runs"). Absent: 0.
	 */
	unkeyed?: number;
	/** M5c: the missing phase; absent until the job's first pass completes. */
	missing?: MissingState;
	uploadId: string;
	template: Template;
	dryRun: boolean;
	publish: boolean;
	batchSize: number;
	budgetMs: number;
	/** The template's source block. Absent on jobs created before M3a, which are CSV. */
	source?: TemplateSource;
	/** CSV and XLSX header columns; absent for other formats. */
	columns?: string[];
	/** Pre-M3a name of `columns`, still read for jobs created before M3a. */
	headers?: string[];
	/**
	 * Warnings for the job: template paths missing from the sampled records (JSON, JSON Lines,
	 * XML), and header renames and skipped cells from an XLSX conversion.
	 */
	warnings?: string[];
	/** XLSX: the uploaded workbook; `uploadId` is the JSON Lines it was converted to. */
	sourceUploadId?: string;
	/**
	 * The mapped fields as they were at job creation (type, `required`, validation), checked
	 * before every write. Absent on jobs created before M4a, which keep M2 behaviour.
	 */
	targetFields?: Record<string, TargetField>;
	/** The site timezone read at job creation, for `tz: "site"`; absent before M4a (UTC). */
	siteTimezone?: string;
	/**
	 * The collection already had the `flux_source_id` field at job creation, so a dry run may
	 * filter by it. Absent before M4b: such a dry run never does.
	 */
	sourceIdField?: boolean;
	/**
	 * Required fields shared across a translation group that the template leaves unmapped
	 * (`sharedRequiredOf`): a record without a `translationOf` value fails `required` for each.
	 * Absent when there are none (M4e).
	 */
	sharedRequired?: string[];
	/** The mapped taxonomies as they were at job creation; absent when none are mapped. */
	taxonomies?: Record<string, TaxonomySnapshot>;
	/**
	 * A dry run's terms that earlier batches planned to create, so later batches see them as a
	 * real run would; capped at `MAX_PLANNED_TERMS`. Absent outside dry runs.
	 */
	plannedTerms?: PlannedTerm[];
	/**
	 * The largest file an image or file field downloads, read at job creation: the site's
	 * `maxUploadSize`, at most 5 MiB on Workers. Absent when the template maps no media.
	 */
	mediaMaxBytes?: number;
	/**
	 * Terms and media a record created before a batch left it for the next one (a download that
	 * would start too late), merged into its row when it completes. Absent otherwise.
	 */
	deferred?: {
		seq: number;
		newTerms: string[];
		newMedia: string[];
		/** Image downloads that failed for good (media map key and error), so the retry skips them. */
		failed?: { key: string; error: { field: string; code: string; message: string } }[];
	};
	cursor: { offset: number; seq: number };
	counters: Counters;
	lease: { holder: string; expiresAt: number } | null;
	phase: "import" | "retry" | "missing";
	retryFromSeq: number;
	schemaReady: boolean;
	error: { code: string; message: string } | null;
	/** Consecutive batches that ended in an unexpected error; the job fails at three. */
	failures: number;
	createdAt: string;
	updatedAt: string;
}

export type RecordStatus =
	| "writing"
	| "created"
	| "updated"
	| "unchanged"
	| "locked"
	| "conflict"
	| "failed"
	| "planned"
	| "filtered"
	| "reverted"
	| "removed";

/** What a rollback row does to its entry (M5a); M5c adds `restore`, for a `trash` journal row. */
export type RollbackAction = "delete" | "trash" | "revert" | "restore";

export interface RecordError {
	field?: string;
	code: string;
	message: string;
}

export interface RecordRow {
	jobId: string;
	seq: number;
	start: number;
	end: number;
	status: RecordStatus;
	sourceKey: string | null;
	entryId: string | null;
	action?: PlanAction | RollbackAction | MissingAction;
	changes?: Change[];
	errors?: RecordError[];
	/** The content revision this job wrote, saved before publishing so crash repair publishes only it. */
	writtenRev?: string;
	/**
	 * Terms created for the record (`taxonomy: Parent > Child`), or that a dry run would create.
	 * Absent when there are none.
	 */
	newTerms?: string[];
	/**
	 * Media downloaded for the record (`field: url`), also when the upload found identical bytes
	 * already stored, or that a dry run would download. Absent when there are none.
	 */
	newMedia?: string[];
	/**
	 * What the record's latest conversion reported without failing it (M4d), at most
	 * `MAX_RECORD_WARNINGS`. Absent when there are none.
	 */
	warnings?: RecordError[];
	/** Rollback rows: the last revert step done (M5a); absent before the first. */
	step?: number;
	/**
	 * Rollback rows: the step sent to EmDash and not yet saved as done (M5a). A resumed row whose
	 * entry moved past `writtenRev` adopts the entry when it shows this step's result.
	 */
	pendingStep?: number;
	updatedAt: string;
}

export interface LinkRow {
	collection: string;
	locale: string;
	sourceKey: string;
	entryId: string;
	/**
	 * The latest revision this importer produced for the entry (the publish's revision when it
	 * published, else the write's). A pending draft at any other revision is not the importer's.
	 */
	writtenRev?: string;
	/** The job that produced `writtenRev` (M5a); absent on links saved before M5a. */
	jobId?: string;
	/**
	 * One fingerprint per mapping name, of the value the importer last wrote or found equal to its
	 * feed (M5b); absent on links saved before M5b.
	 */
	fields?: Record<string, string>;
	/**
	 * The mappings whose fingerprint is not vouched for by `writtenRev` (M5b): an old one a
	 * protected mapping kept, or one carried over after the entry's revision had moved. They are
	 * always compared, as taxonomies are. Absent when none.
	 */
	unconfirmed?: string[];
	/**
	 * The time the entry was scheduled for at `writtenRev`, as far as the importer knows (M5b):
	 * the schedule it set, or one an update kept. Absent when none.
	 */
	scheduledAt?: string;
	/**
	 * M5c: the `rules.owner` of the template whose job created the entry. Kept by link saves of
	 * that owner, dropped by any record of another owner or of none (spec "Owner").
	 */
	owner?: string;
	/** M5c: the URL source of the job that stamped `owner`; absent for uploads and pastes. */
	ownerSource?: string;
	/** M5c: the missing phase moved the entry to Trash or unpublished it. */
	missing?: LinkMissing;
}

/** The pre-image of an entry a job updated (M5a): what the entry held before its first write. */
export interface JournalBefore {
	/**
	 * The link row before the job, its fingerprints (unconfirmed ones named) and schedule included
	 * (M5b); null when none.
	 */
	link: {
		jobId?: string;
		writtenRev?: string;
		fields?: Record<string, string>;
		unconfirmed?: string[];
		scheduledAt?: string;
		/** M5c: the owner stamp and missing mark, restored with the rest of the link. */
		owner?: string;
		ownerSource?: string;
		missing?: LinkMissing;
	} | null;
	/**
	 * The entry's `_rev` when the pre-image was read. When it is not `link.writtenRev`, someone
	 * changed the entry after the earlier job, and a rollback hands the link back unchanged.
	 */
	rev?: string;
	status: string;
	scheduledAt: string | null;
	/** The live slug, when the job changed the slug. */
	slug?: string | null;
	/** Live values of the fields the job changed or published. */
	live: Record<string, unknown>;
	/** The pending draft's values of the same fields, when the entry had a draft. */
	draft?: Record<string, unknown>;
	links?: {
		/** Term translation groups, by taxonomy. */
		taxonomies?: Record<string, string[]>;
		/** Target entry IDs, by reference field. */
		references?: Record<string, string[]>;
		bylines?: { bylineId: string; roleLabel: string | null }[];
	};
	/**
	 * The write published a pending draft of an entry whose template maps references: the read
	 * returns the draft's selection only, so the live one is not in the pre-image and a rollback
	 * leaves the references as the draft had them (spec "Open issues").
	 */
	referencesUnknown?: true;
	/**
	 * Final review I2: the import resumed a stopped write and found the entry at another `_rev`
	 * than this pre-image's, so an edit made between the stop and the resume cannot be ruled out.
	 * The rollback leaves such an entry (`rollback_changed`).
	 */
	uncertain?: true;
}

/**
 * One entry a real job wrote (plugin storage `journal`, keyed `journalKey(jobId, linkKey)`),
 * written before the job's first write to it.
 */
export interface JournalEntry {
	jobId: string;
	/** The record that first touched the entry; rollback order. */
	seq: number;
	collection: string;
	locale: string;
	sourceKey: string;
	/** `trash` (M5c): the missing phase moved the entry to Trash; `entryId` and `before` are set. */
	kind: "create" | "update" | "trash";
	/** null until a create returns. */
	entryId: string | null;
	/** create: this job's create call returned `entryId` (not found by crash repair). */
	confirmed?: boolean;
	/** create: the `flux_source_id` the create sends (the translationOf value for a linked create). */
	sourceIdValue?: string;
	/** update only. */
	before?: JournalBefore;
	/** ISO time of the write-ahead put. */
	at: string;
	/**
	 * What the job wrote. `taxonomies` (final review I3, update only): the term translation groups
	 * the job wrote, by taxonomy (the after state of each taxonomy in `before.links.taxonomies`).
	 * Term edits do not move `_rev`, so the rollback compares them with the entry's terms before
	 * restoring.
	 */
	wrote?: {
		taxonomies?: Record<string, string[]>;
		/**
		 * M5b, a write that a publish or a schedule follows (the record publishes now, makes a
		 * schedule or keeps one, also when its publish then fails): what that publish makes live.
		 * `fields` holds the fingerprint of every field of the data published (`dataFingerprints`):
		 * the entry's data, its own pending draft's included, with the values the write sends.
		 * `slug` is the slug the write sends, when it sends one. `publishedAt` is the entry's when
		 * the record read it (null: never published), which the scheduler keeps, or, when null,
		 * sets to the scheduled time. A rollback owns an entry the scheduler published only when it
		 * shows all three: an editor's unschedule and discard after the time leaves the same `_rev`
		 * shape with the values from before the job, and an editor's reschedule or publish of a
		 * never published entry another `publishedAt`. Crash repair adopts the scheduler's publish
		 * on the same test, and a publish whose link save a stop lost on `fields` and `slug`
		 * (final review A-I1, A-I2).
		 */
		fields?: Record<string, string>;
		slug?: string;
		publishedAt?: string | null;
	};
}

/** A media item a job's upload created (plugin storage `journalMedia`, `journalMediaKey`). */
export interface JournalMedia {
	jobId: string;
	mediaId: string;
	url: string;
	seq: number;
}

/**
 * What a media URL became, in the site-wide media map (plugin storage `media`, keyed by
 * `mediaMapKey`). Written as soon as an upload succeeds; never purged by retention.
 */
export interface MediaMapRow {
	/** The normalized URL. */
	url: string;
	mediaId: string;
	storageKey: string;
	mimeType: string;
	bytes: number;
	/** Validators of the download, for `refresh`. */
	etag?: string;
	lastModified?: string;
	fetchedAt: string;
	/** The job that last downloaded it. */
	jobId: string;
	/** The upload made a new item rather than finding identical bytes already stored. */
	created: boolean;
}

export interface EngineDeps {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
	mediaMap: KvCollection<MediaMapRow>;
	journal: KvCollection<JournalEntry>;
	journalMedia: KvCollection<JournalMedia>;
	content: ContentPort;
	lookups: LookupPort;
	media: MediaPort;
	mediaFetcher: MediaFetcher;
	source: SourcePort;
	now: () => number;
	newId: () => string;
}

/** A record row's own fields: what a decision fills in, the key fields and `updatedAt` left out. */
export type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

/** The engine's clock as an ISO timestamp, for `updatedAt` and `at` fields. */
export const iso = (deps: Pick<EngineDeps, "now">): string => new Date(deps.now()).toISOString();

export function recordKey(jobId: string, seq: number): string {
	return `${jobId}:${String(seq).padStart(10, "0")}`;
}

export function linkKey(collection: string, locale: string, sourceKey: string): string {
	return `${collection}:${locale}:${sourceKey}`;
}

/** The journal row of the entry a link names, for one job (M5a). */
export function journalKey(jobId: string, linkId: string): string {
	return `${jobId}:${linkId}`;
}

export function journalMediaKey(jobId: string, mediaId: string): string {
	return `${jobId}:${mediaId}`;
}

/** Names and IDs `Job.created` lists of each kind; past them it counts only. */
export const CREATED_LISTED = 100;

/** The largest journal row, in bytes of JSON (M5a); D1 stores more (spec V6). */
export const MAX_JOURNAL_BYTES = 1024 * 1024;

/** Adds `by` to a counter; `reverted` is absent on import jobs. */
export function bump(counters: Counters, key: keyof Counters, by = 1): void {
	counters[key] = (counters[key] ?? 0) + by;
}

/** Warnings kept on one record row. */
export const MAX_RECORD_WARNINGS = 20;
/** Errors kept on one record row, so that no producer can make a row too large to store. */
export const MAX_RECORD_ERRORS = 50;
/** The longest message kept in a row's error or warning, in characters. */
export const MAX_RECORD_MESSAGE_LENGTH = 1000;

/** `issue` with its message cut to `MAX_RECORD_MESSAGE_LENGTH` characters. */
function bounded(issue: RecordError): RecordError {
	if (issue.message.length <= MAX_RECORD_MESSAGE_LENGTH) return issue;
	return { ...issue, message: `${issue.message.slice(0, MAX_RECORD_MESSAGE_LENGTH - 1)}…` };
}

/** At most `max` issues, each message bounded: past it, the last one kept says how many more. */
function capIssues(
	issues: readonly RecordError[],
	max: number,
	summary: (more: number) => RecordError,
): RecordError[] {
	if (issues.length <= max) return issues.map(bounded);
	const kept = issues.slice(0, max - 1).map(bounded);
	return [...kept, summary(issues.length - kept.length)];
}

/**
 * At most `MAX_RECORD_WARNINGS` warnings: when there are more, the last one kept says how many
 * were left out (`warnings_truncated`). Each message is at most `MAX_RECORD_MESSAGE_LENGTH`.
 */
export function capWarnings(warnings: readonly RecordError[]): RecordError[] {
	return capIssues(warnings, MAX_RECORD_WARNINGS, (more) => ({
		code: "warnings_truncated",
		message: `${more} more warnings`,
	}));
}

/**
 * At most `MAX_RECORD_ERRORS` errors: when there are more, the last one kept says how many were
 * left out (`errors_truncated`). Each message is at most `MAX_RECORD_MESSAGE_LENGTH`.
 */
export function capErrors(errors: readonly RecordError[]): RecordError[] {
	return capIssues(errors, MAX_RECORD_ERRORS, (more) => ({
		code: "errors_truncated",
		message: `${more} more errors`,
	}));
}

export function emptyCounters(): Counters {
	return { created: 0, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0, filtered: 0 };
}
