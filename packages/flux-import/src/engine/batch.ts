import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type Change,
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type MediaPlanItem,
	type PlanAction,
	type PortableTextPlanItem,
	planRecord,
	type RecordPlan,
} from "./diff.js";
import { currentForms, fingerprintsOf, recordMappings, sentForms } from "./fingerprints.js";
import {
	JobError,
	jobReader,
	jobTemplate,
	updateJob,
	upgradeJob,
	withoutPlannedTerms,
} from "./jobs.js";
import {
	draftFields,
	journalCreate,
	journalCreated,
	journaling,
	journalUpdate,
	preImage,
} from "./journal.js";
import type { ResolvedLinks } from "./links.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
	lookupRecordMedia,
	type MediaContext,
	MediaDeferred,
	type MediaLookup,
	mediaFieldValue,
	obtainRecordMedia,
	type ResolvedMedia,
} from "./media.js";
import { enterMissing, missingPass } from "./missing.js";
import { foreignStamp, ownerOf, ownership, withoutStamp } from "./owner.js";
import {
	lookupPortableTextImages,
	obtainPortableTextImages,
	portableTextPlan,
	type RecordImages,
} from "./portable-text-images.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type GetOptions,
	type LinkWrites,
	type MediaInfo,
	SourceMissingError,
} from "./ports.js";
import {
	COST_CALL,
	COST_READ,
	COST_RECORD,
	findTranslationSource,
	LookupCache,
	loadTerms,
	resolveLinks,
	sourceNotFoundMessage,
	termPath,
} from "./resolve.js";
import { rollbackPass, rollbackRetryPass } from "./revert.js";
import { originalProblem } from "./rollback.js";
import {
	dataFingerprints,
	editedMappings,
	holdsScheduled,
	holdsWrote,
	journalledNames,
	mappingOf,
	modeSkip,
	narrowRecord,
	ownPending,
	protectedMappings,
	protectPlan,
	publishedSince,
	ruled,
	sameFields,
	sameInstant,
	scheduleLanded,
	schedulePlan,
	sweptSince,
	type Target,
	targetOf,
	unconfirmedOf,
} from "./rules.js";
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	type FieldValue,
	filterRecord,
	isSharedMapping,
	type MappedRecord,
	type MediaRequest,
	SOURCE_ID_FIELD,
} from "./template.js";
import {
	bump,
	type Counters,
	CREATED_LISTED,
	capErrors,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	type Job,
	type JournalEntry,
	journalKey,
	type LinkRow,
	linkKey,
	type RecordError,
	type RecordRow,
	recordKey,
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
/**
 * Media downloads must end this long after the batch's budget (`LookupCache.mediaDeadline`),
 * which leaves 10 s of the lease for the record's write and publish.
 */
export const MEDIA_GRACE_MS = 20_000;
const CAS_ATTEMPTS = 5;
/** Content errors that fail the job rather than the record being written. */
const JOB_LEVEL_WRITE_ERRORS: ReadonlySet<string> = new Set([
	"collection_missing",
	"source_id_field_invalid",
	"media_config",
]);

type Outcome = { done: boolean; error?: { code: string; message: string } };
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

/** The counter a row counts toward; null for a `writing` row. */
export function counterFor(row: RowFields): keyof Counters | null {
	switch (row.status) {
		case "planned":
			// M5c: a dry run's planned trash or unpublish counts as removed (Ruling 29 M10).
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
					: row.action === "trash" || row.action === "unpublish"
						? "removed"
						: "unchanged";
		case "writing":
			return null;
		default:
			return row.status;
	}
}

async function claim(
	deps: EngineDeps,
	jobId: string,
	holder: string,
): Promise<{ ok: boolean; job: Job }> {
	const current = await deps.jobs.getVersioned(jobId);
	if (!current) throw new JobError("not_found", `Job ${jobId} not found`);
	const job = upgradeJob(current.value);
	const now = deps.now();
	if (job.status !== "created" && job.status !== "running") return { ok: false, job };
	// Any live lease blocks the claim, including one held under the same holder name.
	if (job.lease && job.lease.expiresAt > now) return { ok: false, job };
	const next: Job = {
		...job,
		status: "running",
		lease: { holder, expiresAt: now + job.budgetMs + LEASE_GRACE_MS },
		updatedAt: iso(deps),
	};
	const result = await deps.jobs.compareAndSet(jobId, current.revision, next);
	if (!result.applied) {
		const stored = await deps.jobs.get(jobId);
		return { ok: false, job: stored ? upgradeJob(stored) : job };
	}
	return { ok: true, job: next };
}

async function release(deps: EngineDeps, job: Job, holder: string, outcome: Outcome): Promise<Job> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.jobs.getVersioned(job.id);
		if (!current) throw new JobError("not_found", `Job ${job.id} not found`);
		const stored = current.value;
		if (stored.lease?.holder !== holder) return stored;
		let status = stored.status;
		if (status === "running")
			status = outcome.error ? "failed" : outcome.done ? "completed" : "running";
		const finishedRetry = outcome.done && job.phase === "retry";
		const next: Job = {
			...stored,
			status,
			cursor: job.cursor,
			counters: job.counters,
			schemaReady: job.schemaReady,
			phase: finishedRetry ? "import" : job.phase,
			retryFromSeq: job.retryFromSeq,
			...(job.plannedTerms ? { plannedTerms: job.plannedTerms } : {}),
			...(job.deferred ? { deferred: job.deferred } : {}),
			...(job.warnings ? { warnings: job.warnings } : {}),
			...(job.created ? { created: job.created } : {}),
			...(job.unkeyed ? { unkeyed: job.unkeyed } : {}),
			// M5c: the missing phase.
			...(job.missing ? { missing: job.missing } : {}),
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
			error: outcome.error ?? (stored.error?.code === "internal" ? null : stored.error),
			failures: 0,
			lease: null,
			updatedAt: iso(deps),
		};
		// A finished retry pass has no later batch to need the dry run's planned terms.
		if (!job.deferred) delete next.deferred;
		const saved = finishedRetry ? withoutPlannedTerms(next) : next;
		const result = await deps.jobs.compareAndSet(job.id, current.revision, saved);
		if (result.applied) return saved;
	}
	throw new Error(`Could not save job ${job.id} after ${CAS_ATTEMPTS} attempts`);
}

export async function processRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	opts: { retry: boolean; cache?: LookupCache },
): Promise<void> {
	const key = recordKey(job.id, rec.seq);
	const existing = await deps.records.get(key);
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor and counters.
		const counter = counterFor(existing);
		if (counter) bump(job.counters, counter);
		if (unkeyedRow(existing)) job.unkeyed = (job.unkeyed ?? 0) + 1;
		return;
	}

	const base = { jobId: job.id, seq: rec.seq, start: rec.start, end: rec.end };
	// Every row is saved through here, so the caps hold whatever produced its errors and warnings.
	const save = (fields: RowFields) =>
		deps.records.put(key, {
			...base,
			...fields,
			...(fields.errors ? { errors: capErrors(fields.errors) } : {}),
			...(fields.warnings ? { warnings: capWarnings(fields.warnings) } : {}),
			updatedAt: iso(deps),
		});

	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
	if (!opts.retry && unkeyedRow(row)) job.unkeyed = (job.unkeyed ?? 0) + 1;
}

/** M5c: a row whose record had no readable key (a reader, filter or key error). */
function unkeyedRow(row: Pick<RecordRow, "status" | "sourceKey">): boolean {
	return row.status === "failed" && row.sourceKey === null;
}

/** What the write helpers need about the record being processed. */
type RecordCtx = {
	deps: EngineDeps;
	job: Job;
	/** The record's sequence number, which orders its journal row (M5a). */
	seq: number;
	sourceKey: string;
	linkId: string;
	/** The link row as read before any write of this record; null when there is none. */
	link: LinkRow | null;
	/**
	 * M5c: the link row as `entryByLink` read it, before crash repair; null until then. A foreign
	 * owner stamp on it is dropped once the record is decided (`settleOwner`).
	 */
	read: LinkRow | null;
	/** M5c: `entryByLink` read the link row (Ruling 30). */
	linkRead: boolean;
	/** M5c: a link put of this record happened (a save, a refresh or a repair). */
	linkPut: boolean;
	/** M5c: this job created the entry, so its link saves stamp the owner (spec "Owner"). */
	stamp: boolean;
	/**
	 * The link row as stored once the entry is known: `link`, or the one crash repair saved (M5b,
	 * for the fingerprint refresh); null when there is none.
	 */
	stored: LinkRow | null;
	/** The fingerprints every link save of this record carries (M5b); absent in a dry run. */
	fields?: Record<string, string>;
	/** The names of `fields` that the saved revision does not vouch for (M5b, `unconfirmedOf`). */
	unconfirmed?: string[];
	/** The record's protected mappings (M5b), which the entry holds differently from the feed. */
	kept?: ReadonlySet<string>;
	/** A link save of this record carried `fields` (M5b), so no refresh is needed. */
	linkSaved: boolean;
	/** When the record's content goes live (M5b). */
	target: Target;
	/** The schedule the record makes, as its `publishAt` change (M5b); absent when none. */
	schedule?: Change;
	/** The record's `publishAt` time, whatever its target (M5b, for crash repair); null when none. */
	publishAt: string | null;
	/** The `not_scheduled` warning a written update carries (M5b); absent when none. */
	notScheduled?: RecordError;
	/** The job may already have written the entry (see `JournalTarget.mayHaveWritten`). */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing` (see `JournalTarget.resuming`). */
	resuming: boolean;
	/** The entry's current links, as the plan compared them; absent when the template maps none. */
	current?: CurrentLinks;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
	/** The record's media field values, written with the data; absent when it maps none. */
	media?: Record<string, MediaPlanItem | null>;
	/** The record's Portable Text values, written with the data; absent when it maps none. */
	portableText?: Record<string, PortableTextPlanItem | null>;
	/**
	 * A linked create's source (M4e): its entry ID and the record's `translationOf` value;
	 * absent for an entry of its own.
	 */
	translationOf?: { sourceId: string; value: string };
};

const PENDING_DRAFT_MESSAGE =
	"Not imported: the entry has an unpublished draft that this import did not write";
const PENDING_SCHEDULE_MESSAGE =
	"Not imported: the entry is scheduled, and this import did not schedule it";
const REV_CONFLICT_MESSAGE = "Not imported: the entry changed since it was read; retry to re-apply";
const LOCKED_MESSAGE = "Not imported: the entry is being edited (locked)";

function notImported(
	status: "conflict" | "locked",
	sourceKey: string,
	entryId: string,
	action: PlanAction,
	code: string,
	message: string,
): RowFields {
	return { status, sourceKey, entryId, action, errors: [{ code, message }] };
}

function publishFailed(
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: RecordRow["action"],
	writtenRev: string | undefined,
): RowFields {
	return {
		status: reason,
		sourceKey,
		entryId: id,
		...(action ? { action } : {}),
		...(writtenRev === undefined ? {} : { writtenRev }),
		errors: [
			{
				code: `publish_${reason}`,
				message:
					reason === "locked"
						? "Saved as a draft: the entry is locked, so it was not published"
						: "Saved as a draft: the entry changed before it could be published",
			},
		],
	};
}

/**
 * Saves the link with the latest revision this importer produced for the entry, the record's
 * fingerprints, and the schedule the entry has at that revision (M5b).
 */
function putLink(
	ctx: RecordCtx,
	entryId: string,
	writtenRev: string,
	scheduledAt: string | null = null,
): Promise<void> {
	const { collection, locale } = ctx.job.template;
	ctx.linkSaved = true;
	ctx.linkPut = true;
	// M5c: the owner as this job's create stamps it or its own owner keeps it; a write never
	// carries the missing mark (spec Ruling 14).
	const stored = ctx.stored?.entryId === entryId ? ctx.stored : null;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
		jobId: ctx.job.id,
		...(ctx.fields === undefined ? {} : { fields: ctx.fields }),
		...(ctx.unconfirmed?.length ? { unconfirmed: ctx.unconfirmed } : {}),
		...(scheduledAt === null ? {} : { scheduledAt }),
		...ownership(ctx.job, stored, ctx.stamp),
	});
}

/** Schedules the revision the record wrote (M5b) and saves the link with the schedule's. */
async function scheduleRev(ctx: RecordCtx, id: string, rev: string, at: string) {
	const { collection, locale } = ctx.job.template;
	const scheduled = await ctx.deps.content.schedule({
		collection,
		locale,
		id,
		rev,
		scheduledAt: at,
	});
	if (scheduled.ok) await putLink(ctx, id, scheduled.rev, at);
	return scheduled;
}

function scheduleFailed(
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: RecordRow["action"],
	writtenRev: string | undefined,
): RowFields {
	return {
		status: reason,
		sourceKey,
		entryId: id,
		...(action ? { action } : {}),
		...(writtenRev === undefined ? {} : { writtenRev }),
		errors: [
			{
				code: `schedule_${reason}`,
				message:
					reason === "locked"
						? "Saved as a draft: the entry is locked, so it was not scheduled"
						: "Saved as a draft: the entry changed before it could be scheduled",
			},
		],
	};
}

/**
 * Sets the fingerprints the record's link saves carry (spec M5b "When they are recorded"): each
 * mapping the record compared gets the fingerprint of the value it writes, or, when the entry
 * already holds the feed's value, of that value; `kept` mappings and the ones the record does not
 * carry (unlisted, a linked record's shared ones) keep the stored link's, named in `unconfirmed`
 * unless the saved revision still vouches for them (`unconfirmedOf`).
 */
async function setFields(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	record: MappedRecord,
	plan: RecordPlan,
	links: LinkPlan | undefined,
	kept: ReadonlySet<string> = new Set(),
): Promise<void> {
	const comparisons = comparisonsOf(ctx.job.template, ctx.job.targetFields);
	const childSide = links?.childSide ?? new Set<string>();
	const changed = new Set(plan.changes.map((c) => mappingOf(c, record)));
	const sent = sentForms(record, comparisons, ctx.links, ctx.media, ctx.portableText, childSide);
	const held = entry
		? currentForms(entry, record, comparisons, links?.current ?? {}, childSide)
		: {};
	const forms: Record<string, unknown> = {};
	for (const name of recordMappings(record)) {
		if (kept.has(name)) continue;
		forms[name] = entry === null || changed.has(name) ? sent[name] : held[name];
	}
	// A stored link's fingerprints describe its entry: they carry over only to that entry, never to
	// one created because the linked entry is gone.
	const own = entry !== null && ctx.stored?.entryId === entry.id ? ctx.stored : null;
	const carried = Object.keys(own?.fields ?? {}).filter((name) => !Object.hasOwn(forms, name));
	ctx.fields = { ...(own?.fields ?? {}), ...(await fingerprintsOf(forms)) };
	ctx.unconfirmed = unconfirmedOf(carried, kept, own, entry?.rev ?? null);
	ctx.kept = kept;
}

/**
 * What the journal keeps of a write that a publish or a schedule follows (M5b): the record
 * publishes now, makes a schedule, or the entry has one, which an update keeps and a publish that
 * then fails leaves (review M1). Ownership of a revision the job did not see written compares it
 * with the entry (`holdsWrote`, `holdsScheduled`): the scheduler's publish in crash repair and
 * rollback, and a publish whose link save a stop lost in crash repair (final review A-I2). It
 * holds the fingerprints of the data the publish makes live (`data`: the entry's, its pending
 * draft included, with what the write sends), the slug the write sends, and `publishedAt` as
 * read. Undefined when the write stays a draft.
 */
async function liveWrote(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	data: Readonly<Record<string, unknown>>,
	slug: string | undefined,
): Promise<NonNullable<JournalEntry["wrote"]> | undefined> {
	const live =
		ctx.target.kind === "now" ||
		ctx.schedule !== undefined ||
		(entry?.scheduledAt ?? null) !== null;
	if (!live) return undefined;
	const publishedAt = entry === null ? null : entry.publishedAt;
	return {
		fields: await dataFingerprints(ctx.job, data, journalledNames(ctx.job, data)),
		...(slug === undefined ? {} : { slug }),
		...(publishedAt === undefined ? {} : { publishedAt }),
	};
}

/**
 * Whether an update sends data and slug: not when only links changed, which on a collection with
 * revisions would stage a draft identical to the live entry. A media alt change is a data change.
 */
function sendsData(
	plan: RecordPlan,
	data: Readonly<Record<string, FieldValue>>,
	media: Readonly<Record<string, FieldValue>>,
): boolean {
	return plan.changes.some(
		(c) =>
			c.field === "slug" ||
			Object.hasOwn(data, c.field) ||
			(c.field.endsWith(".alt") && Object.hasOwn(media, c.field.slice(0, -4))),
	);
}

/**
 * Saves a record's new fingerprints when it wrote no link (spec M5b "Refresh"): a link from
 * before M5b, or a protection that lifted. Revision, job and schedule stay, since ownership did
 * not change. Not journalled.
 */
async function refreshFields(ctx: RecordCtx, entry: EntrySnapshot): Promise<void> {
	const stored = ctx.stored;
	if (ctx.linkSaved || ctx.fields === undefined || stored === null) return;
	// Someone else's draft may yet be discarded (EmDash `discardDraft` clears `draftRevisionId`
	// and keeps the columns), so its values are not recorded as the entry's.
	if (entry.hasDraft && entry.rev !== stored.writtenRev) return;
	const unconfirmed = ctx.unconfirmed ?? [];
	const was = new Set(stored.unconfirmed);
	const same = was.size === unconfirmed.length && unconfirmed.every((name) => was.has(name));
	const foreign = foreignStamp(ctx.job, stored);
	if (same && sameFields(stored.fields, ctx.fields) && !foreign) return;
	const { unconfirmed: _old, ...rest } = foreign ? withoutStamp(stored) : stored;
	ctx.linkPut = true;
	await ctx.deps.links.put(ctx.linkId, {
		...rest,
		fields: ctx.fields,
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
	});
}

/**
 * M5c (spec Rulings 2, 21): a record that reached a link stamped with another owner, or whose
 * template has none, drops the stamp whatever its outcome. A record whose own link put already
 * applied `ownership` needs nothing more; any other puts the link once, every other field kept.
 * A dry run drops nothing. Not journalled. A record that defers (`MediaDeferred`) or hits a
 * job-level error throws past this, so it skips the drop until it is decided again.
 */
async function settleOwner(ctx: RecordCtx): Promise<void> {
	if (ctx.job.dryRun || ctx.linkPut) return;
	const link = ctx.stored ?? ctx.read;
	if (link === null || !foreignStamp(ctx.job, link)) return;
	await ctx.deps.links.put(ctx.linkId, withoutStamp(link));
}

/**
 * M5c (spec Ruling 30): a record that failed after its key was read but before it read its
 * link (a mapping, link or media error) is still in the feed, so it drops a foreign stamp as
 * `settleOwner` does, at the cost of one link read. A dry run reads and drops nothing.
 */
async function settleUnread(deps: EngineDeps, job: Job, sourceKey: string): Promise<void> {
	if (job.dryRun) return;
	const { collection, locale } = job.template;
	const linkId = linkKey(collection, locale, sourceKey);
	const link = await deps.links.get(linkId);
	if (link !== null && foreignStamp(job, link)) await deps.links.put(linkId, withoutStamp(link));
}

/** The import message of a key whose entry the missing phase moved to Trash (spec Ruling 15). */
export const MISSING_TRASHED_MESSAGE = (jobId: string) =>
	`Not imported: the import moved this entry to Trash because it was missing from an earlier feed (job ${jobId}); restore it from Trash, or roll that job back, then retry`;

/** M5c: the conflict of a record whose link says the import trashed its entry, which is gone. */
function trashedByImport(
	link: LinkRow | null,
	entry: EntrySnapshot | null,
	sourceKey: string,
): RowFields | null {
	if (entry !== null || link?.missing?.action !== "trash") return null;
	return {
		status: "conflict",
		sourceKey,
		entryId: link.entryId,
		errors: [{ code: "missing_trashed", message: MISSING_TRASHED_MESSAGE(link.missing.jobId) }],
	};
}

/**
 * M5c: whether this job created the entry it now resumes (spec "Owner", Ruling 29 M7): its row
 * was `writing` a create of that entry, or its journal row records a create of it that this
 * job's own call returned (`confirmed`). An entry found by source ID alone is not.
 */
async function createdHere(ctx: RecordCtx, existing: RecordRow, entryId: string): Promise<boolean> {
	if (
		existing.status === "writing" &&
		existing.action === "create" &&
		existing.entryId === entryId
	) {
		return true;
	}
	if (!journaling(ctx.job)) return false;
	const row = await ctx.deps.journal.get(journalKey(ctx.job.id, ctx.linkId));
	return row?.kind === "create" && row.confirmed === true && row.entryId === entryId;
}

/**
 * What the job's journal row for the record holds of the data its write makes live
 * (`liveWrote`); undefined for a job without a journal, so crash repair then adopts nothing.
 */
async function journalledWrote(ctx: RecordCtx): Promise<JournalEntry["wrote"]> {
	if (!journaling(ctx.job)) return undefined;
	return (await ctx.deps.journal.get(journalKey(ctx.job.id, ctx.linkId)))?.wrote;
}

async function publishRev(ctx: RecordCtx, id: string, rev: string) {
	const { collection, locale } = ctx.job.template;
	const published = await ctx.deps.content.publish({ collection, locale, id, rev });
	if (published.ok) await putLink(ctx, id, published.rev);
	return published;
}

/** The links a record maps: resolved ones, or (M5b) the requests before resolution. */
type MappedLinks = {
	references?: Readonly<Record<string, unknown>>;
	taxonomies?: Readonly<Record<string, unknown>>;
	bylines?: unknown;
};

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
 */
async function currentLinks(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: MappedLinks,
): Promise<CurrentLinks> {
	const current: CurrentLinks = {};
	if (resolved.references) {
		current.references = {};
		for (const field of Object.keys(resolved.references)) {
			const refs = entry.references?.[field] ?? [];
			current.references[field] = refs.map((r) => ({ group: r.group, text: r.id }));
		}
		if (entry.referencesTruncated) current.referencesTruncated = entry.referencesTruncated;
	}
	if (resolved.taxonomies) {
		cache.spend(COST_CALL);
		const assigned = await deps.lookups.entryTerms(job.template.collection, entry.id);
		current.taxonomies = {};
		for (const taxonomy of Object.keys(resolved.taxonomies)) {
			const groups = assigned[taxonomy] ?? [];
			// A taxonomy given no value was not looked up; load it to show its terms as paths.
			if (groups.length > 0) await loadTerms(deps, cache, taxonomy, job.template.locale);
			current.taxonomies[taxonomy] = groups.map((group) => ({
				group,
				text: termPath(cache, taxonomy, group),
			}));
		}
	}
	if (resolved.bylines !== undefined) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/** The reference fields on the child side of their relation, which keep no order. */
function childSideOf(job: Job, links: MappedLinks | undefined): Set<string> {
	return new Set(
		Object.keys(links?.references ?? {}).filter(
			(field) => job.targetFields?.[field]?.relationSide === "child",
		),
	);
}

/** Two resolutions of one record's links, as one (M5b: its unprotected and protected parts). */
function mergeLinks(a: ResolvedLinks | undefined, b: ResolvedLinks): ResolvedLinks {
	const merged: ResolvedLinks = { ...a };
	if (b.references) merged.references = { ...merged.references, ...b.references };
	if (b.taxonomies) merged.taxonomies = { ...merged.taxonomies, ...b.taxonomies };
	if (b.bylines !== undefined) merged.bylines = b.bylines;
	return merged;
}

/**
 * The record without its protected mappings (M5b), which are neither written nor journalled:
 * also taken out of the media and Portable Text values the write sends.
 */
function unprotected(ctx: RecordCtx, record: MappedRecord, names: ReadonlySet<string>) {
	if (names.size === 0) return record;
	for (const name of names) {
		if (ctx.media) delete ctx.media[name];
		if (ctx.portableText) delete ctx.portableText[name];
	}
	return narrowRecord(record, (name) => !names.has(name));
}

/**
 * Whether the job's collection can be filtered by `flux_source_id`: a dry run does not add the
 * field, so it needs the collection to have it already (`sourceIdField`, read at job creation).
 */
function sourceIdReady(job: Job): boolean {
	return !job.dryRun || job.schemaReady || job.sourceIdField === true;
}

/**
 * Whether an earlier record of this dry run planned to create `key`: one indexed lookup of the
 * job's record rows per distinct key and batch (the batch adds its own plans as it makes them).
 */
async function plannedKey(
	deps: EngineDeps,
	job: Job,
	cache: LookupCache,
	key: string,
	seq: number,
): Promise<boolean> {
	const known = cache.plannedKeys.get(key);
	if (known !== undefined) return known;
	const page = await deps.records.query({
		// In the import pass only an earlier record counts: a row left by a crashed batch may be a
		// later one. A retry pass has every row of the first pass behind it.
		where: {
			jobId: job.id,
			sourceKey: key,
			status: "planned",
			...(job.phase === "import" ? { seq: { lt: seq } } : {}),
		},
		limit: 1,
	});
	const planned = page.items.some(({ data }) => data.action === "create");
	cache.plannedKeys.set(key, planned);
	return planned;
}

/**
 * The link plan for `planRecord`; child-side reference fields compare as sets. `known` is the
 * entry's current links when the record already read them (M5b, protection).
 */
async function linkPlan(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	resolved: ResolvedLinks,
	known?: CurrentLinks,
): Promise<LinkPlan> {
	const childSide = childSideOf(job, resolved);
	const current = entry ? (known ?? (await currentLinks(deps, cache, job, entry, resolved))) : {};
	return { resolved, current, childSide };
}

/** The link row, then the entry it names: the two reads every record makes (M5b: early). */
async function entryByLink(
	ctx: RecordCtx,
	cache: LookupCache,
	read: GetOptions,
	lookingUp: boolean,
): Promise<{ link: LinkRow | null; entry: EntrySnapshot | null }> {
	const { collection, locale } = ctx.job.template;
	const link = await ctx.deps.links.get(ctx.linkId);
	ctx.read = link;
	ctx.linkRead = true;
	if (link && lookingUp) cache.spend(COST_READ);
	const entry = link ? await ctx.deps.content.get(collection, locale, link.entryId, read) : null;
	return { link, entry };
}

/**
 * What a record found to create or download, and the warnings of its conversion and images,
 * listed on its row whatever happens to it.
 */
type Found = {
	newTerms: string[];
	newMedia: string[];
	warnings: RecordError[];
	/** M5c: the record's context once its key was read, for `settleOwner`. */
	ctx?: RecordCtx;
};

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, media it downloads (or would) as `newMedia`, and what its
 * conversion and images reported as `warnings`, whatever happens to the record afterwards. A
 * retried record's warnings replace the earlier ones.
 */
async function decide(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found: Found = { newTerms: [], newMedia: [], warnings: [] };
	const carried = job.deferred?.seq === rec.seq ? job.deferred : undefined;
	let row: RowFields;
	// Failures carried from the record's earlier batch apply to that record only: a later record
	// may take the same file in a field that accepts it.
	for (const { key, error } of carried?.failed ?? []) cache.mediaFailed.set(key, error);
	try {
		row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
		if (found.ctx?.linkRead) await settleOwner(found.ctx);
		else if (row.status === "failed" && row.sourceKey !== null) {
			await settleUnread(deps, job, row.sourceKey);
		}
	} catch (e) {
		if (e instanceof MediaDeferred) {
			// Keep what this attempt created for the record's row in the next batch.
			const newTerms = [...new Set([...(carried?.newTerms ?? []), ...found.newTerms])];
			const newMedia = [
				...new Set([...(carried?.newMedia ?? []), ...found.newMedia, ...e.newMedia]),
			];
			const failed = new Map(
				[...(carried?.failed ?? []), ...e.failed].map((f) => [f.key, f] as const),
			);
			if (newTerms.length > 0 || newMedia.length > 0 || failed.size > 0) {
				job.deferred = {
					seq: rec.seq,
					newTerms,
					newMedia,
					...(failed.size > 0 ? { failed: [...failed.values()].slice(0, 50) } : {}),
				};
			}
		}
		throw e;
	} finally {
		// The identity check keeps a failure this batch recorded for the same URL itself.
		for (const { key, error } of carried?.failed ?? []) {
			if (cache.mediaFailed.get(key) === error) cache.mediaFailed.delete(key);
		}
	}
	// A retried or deferred record keeps the terms and media its earlier attempts created.
	const newTerms = [
		...new Set([...(existing?.newTerms ?? []), ...(carried?.newTerms ?? []), ...found.newTerms]),
	];
	const newMedia = [
		...new Set([...(existing?.newMedia ?? []), ...(carried?.newMedia ?? []), ...found.newMedia]),
	];
	if (carried) delete job.deferred;
	return {
		...row,
		...(newTerms.length > 0 ? { newTerms } : {}),
		...(newMedia.length > 0 ? { newMedia } : {}),
		...(found.warnings.length > 0 ? { warnings: found.warnings } : {}),
	};
}

/**
 * Adds terms a real job created to the job's summary, which the batch's save keeps for the
 * rollback job's warnings (M5a). Names beyond `CREATED_LISTED` are only counted.
 */
export function noteCreated(job: Job, names: readonly string[]): void {
	job.created ??= { terms: [], termCount: 0 };
	const created = job.created;
	for (const name of names) {
		if (created.terms.includes(name)) continue;
		if (created.terms.length < CREATED_LISTED) created.terms.push(name);
		created.termCount++;
	}
}

function mediaContext(job: Job, seq: number): MediaContext {
	return {
		jobId: job.id,
		dryRun: job.dryRun,
		maxBytes: job.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
		targets: job.targetFields ?? {},
		...(journaling(job) ? { journal: { seq } } : {}),
	};
}

function mediaItem(request: MediaRequest, item: MediaInfo | null): MediaPlanItem {
	if (item === null) {
		const text = `new media from ${request.url}`;
		return { mediaId: null, value: null, text, alt: request.alt };
	}
	const value = mediaFieldValue(request.kind, item, request.alt);
	return { mediaId: item.id, value, text: item.id, alt: request.alt };
}

/**
 * The media plan before any download: a hit as its item, and a miss (or, in a real run, a hit
 * to refresh) as a file not stored yet, which is always a change.
 */
function lookedUpMedia(
	lookups: Readonly<Record<string, MediaLookup | null>>,
	dryRun: boolean,
	jobId: string,
): Record<string, MediaPlanItem | null> {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, lookup] of Object.entries(lookups)) {
		const stays =
			lookup?.item && (dryRun || !lookup.request.refresh || lookup.row?.jobId === jobId);
		plan[field] = lookup === null ? null : mediaItem(lookup.request, stays ? lookup.item : null);
	}
	return plan;
}

function obtainedMedia(media: Readonly<Record<string, ResolvedMedia>>) {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, resolved] of Object.entries(media)) {
		plan[field] = resolved === null ? null : mediaItem(resolved.request, resolved.item);
	}
	return plan;
}

async function decideRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: Found,
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
	if ("error" in filter) {
		return { status: "failed", sourceKey: null, entryId: null, errors: [filter.error] };
	}
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	found.warnings.push(...(mapped.warnings ?? []));
	if (!mapped.ok) {
		// M5c (Ruling 24): the key, when it was read, marks the record as in the feed.
		return {
			status: "failed",
			sourceKey: mapped.key ?? null,
			entryId: null,
			errors: mapped.errors,
		};
	}

	const { key: sourceKey } = mapped.value;
	const { collection, locale } = job.template;
	const ctx: RecordCtx = {
		deps,
		job,
		seq: rec.seq,
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		link: null,
		read: null,
		linkRead: false,
		linkPut: false,
		stamp: false,
		stored: null,
		linkSaved: false,
		target: targetOf(job, mapped.value, deps.now()),
		publishAt: mapped.value.publishAt ?? null,
		mayHaveWritten: false,
		resuming: false,
		save,
	};
	found.ctx = ctx;
	// Known so far, so that a ContentWriteError from any content call still reports it.
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		// A template with translationOf looks entries up for every record (M4e).
		const translating = job.template.translationOf !== undefined;
		const lookingUpFor = (r: MappedRecord) => r.links !== undefined || translating;
		// Reference selections are read only when the record maps reference fields.
		const readFor = (r: MappedRecord) => ({ references: r.links?.references !== undefined });
		// M5b: with record rules the entry is looked up first, and the mode and the update scope
		// decided before any link, translation source or media is looked up.
		let early: { link: LinkRow | null; entry: EntrySnapshot | null } | null = null;
		let record = mapped.value;
		// The mappings an update of a found entry is limited to (`updateFields`); null for all.
		let scope: ReadonlySet<string> | null = null;
		if (ruled(job.template)) {
			// An entry found is updated with only the listed mappings, so it is read for those.
			const listed = job.template.rules?.updateFields;
			const names = new Set(listed);
			const narrowed =
				listed === undefined ? record : narrowRecord(record, (name) => names.has(name));
			early = await entryByLink(ctx, cache, readFor(narrowed), lookingUpFor(narrowed));
			const trashed = trashedByImport(early.link, early.entry, sourceKey);
			if (trashed) return trashed;
			const skip = modeSkip(job.template, early.entry, existing);
			if (skip !== null) {
				found.warnings.push(skip);
				const id = early.entry?.id ?? null;
				return job.dryRun
					? { status: "planned", sourceKey, entryId: id, action: "unchanged" }
					: { status: "unchanged", sourceKey, entryId: id };
			}
			if (early.entry !== null) {
				record = narrowed;
				if (listed !== undefined) scope = names;
			}
		}
		// The record's lookups are charged for what it resolves: with `updateFields`, the listed ones.
		const lookingUp = lookingUpFor(record);
		const read = readFor(record);
		const drafted = Object.values(record.portableText ?? {});
		if (lookingUp || record.media || drafted.some((d) => d !== null && d.images.length > 0)) {
			cache.spend(COST_RECORD);
		}
		// M5b: with protectEdited, the mappings edited since the import last wrote them are
		// resolved without side effects, and never written while they differ from the feed.
		let edited = new Set<string>();
		let held: Record<string, string> = {};
		let known: CurrentLinks | undefined;
		if (early?.entry && early.link && job.template.rules?.protectEdited) {
			const { entry, link } = early;
			known = record.links ? await currentLinks(deps, cache, job, entry, record.links) : {};
			const comparisons = comparisonsOf(job.template, job.targetFields);
			const childSide = childSideOf(job, record.links);
			held = await fingerprintsOf(currentForms(entry, record, comparisons, known, childSide));
			// Reference edges set from the other entry or a translation leave `_rev` (F15).
			const references = new Set(Object.keys(record.links?.references ?? {}));
			edited = editedMappings(recordMappings(record), link, entry.rev, held, references);
		}
		const own = edited.size > 0 ? narrowRecord(record, (name) => !edited.has(name)) : record;
		const quiet = edited.size > 0 ? narrowRecord(record, (name) => edited.has(name)) : null;
		const requests = own.links;
		const mediaRequests = own.media;
		const drafts = own.portableText;
		const errors: { field: string; code: string; message: string }[] = [];
		const resolveContext = {
			template: job.template,
			targets: job.targetFields ?? {},
			taxonomies: job.taxonomies ?? {},
			dryRun: job.dryRun,
			plannedKey: (key: string) => plannedKey(deps, job, cache, key, rec.seq),
			sourceIdReady: sourceIdReady(job),
		};
		if (requests) {
			const resolution = await resolveLinks(deps, cache, resolveContext, requests);
			found.newTerms = resolution.newTerms;
			if (journaling(job)) noteCreated(job, resolution.newTerms);
			if (resolution.ok) ctx.links = resolution.links;
			else errors.push(...resolution.errors);
		}
		if (quiet?.links) {
			const context = { ...resolveContext, quiet: true };
			const resolution = await resolveLinks(deps, cache, context, quiet.links);
			if (resolution.ok) ctx.links = mergeLinks(ctx.links, resolution.links);
			else errors.push(...resolution.errors);
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = record.translationOf;
		let source: { id: string; group: string } | null = null;
		if (translates !== undefined) {
			try {
				source = await findTranslationSource(
					deps,
					cache,
					collection,
					sourceLocaleOf(job),
					translates,
					sourceIdReady(job),
				);
			} catch (e) {
				if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
				errors.push({ field: "translationOf", code: e.code, message: e.message });
			}
		}
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
		if (mediaRequests) {
			const looked = await lookupRecordMedia(
				deps,
				cache,
				mediaContext(job, rec.seq),
				mediaRequests,
			);
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
		let images: RecordImages | undefined;
		if (drafts) {
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				drafts,
				template.portableText,
			);
			images = looked.images;
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		// Protected media and images: looked up in the media map, never downloaded; a miss differs.
		let quietMedia: Record<string, MediaPlanItem | null> | undefined;
		if (quiet?.media) {
			const looked = await lookupRecordMedia(deps, cache, mediaContext(job, rec.seq), quiet.media);
			quietMedia = lookedUpMedia(looked.lookups, true, job.id);
			errors.push(...looked.errors);
		}
		let quietText: Record<string, PortableTextPlanItem | null> | undefined;
		if (quiet?.portableText) {
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				quiet.portableText,
				template.portableText,
			);
			quietText = portableTextPlan(quiet.portableText, looked.images);
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		let { link, entry } = early ?? (await entryByLink(ctx, cache, read, lookingUp));
		const trashed = early ? null : trashedByImport(link, entry, sourceKey);
		if (trashed) return trashed;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null && sourceIdReady(job)) {
			if (lookingUp) cache.spend(COST_READ);
			// A translation's source ID is its source's key (spec M4e F1), which an editor's
			// translation carries too: such an entry is taken only for a row this job was writing
			// or that names it, and only in the source's group (an entry of its own whose key
			// equals the value is another record's). A record without a value in such a template
			// is an entry of its own, so it never takes a translation.
			const byValue = await deps.content.findBySourceId(
				collection,
				locale,
				translates ?? sourceKey,
				read,
			);
			const adopt =
				byValue !== null &&
				(translates === undefined
					? !translating || !isTranslation(byValue)
					: (existing.status === "writing" || existing.entryId === byValue.id) &&
						(source === null || (byValue.group ?? byValue.id) === source.group));
			if (byValue && adopt) {
				entry = byValue;
				link = { collection, locale, sourceKey, entryId: byValue.id };
				repaired = true;
			}
		}
		entryId = entry?.id ?? null;
		let translationChange: Change | undefined;
		if (translating) {
			const verdict = await checkTranslation(deps, cache, job, entry, translates, source);
			if ("error" in verdict) {
				return { status: "failed", sourceKey, entryId, errors: [verdict.error] };
			}
			found.warnings.push(...verdict.warnings);
			if (verdict.change && source && translates !== undefined) {
				ctx.translationOf = { sourceId: source.id, value: translates };
				translationChange = verdict.change;
			}
		} else if (entry && isTranslation(entry) && mapsShared(job, scope)) {
			// A template without translationOf would send shared values that EmDash then syncs to
			// the whole group (M4e).
			return { status: "failed", sourceKey, entryId, errors: [sharedOnTranslation()] };
		}
		// M5c (Ruling 29 M7): crash repair stamps only an entry this job is shown to have created,
		// decided before the repaired link's put and its journal row, so the stamp lands whatever
		// the rest of the record decides. Only a repair: a record that found its link (a retry pass
		// included) never stamps again, since another owner may have dropped the stamp since.
		if (repaired && entry && existing && ownerOf(job) !== undefined && !job.dryRun) {
			ctx.stamp = await createdHere(ctx, existing, entry.id);
		}
		// A repaired link is saved only for an entry the record may write.
		if (repaired && link) {
			link = { ...link, ...ownership(job, null, ctx.stamp) };
			ctx.linkPut = true;
			await deps.links.put(ctx.linkId, link);
			// Crash repair may have found an editor's entry: a rollback only moves it to Trash.
			if (entry && journaling(job)) await journalCreated(ctx, entry.id, false);
		}
		// A repaired link is made up from the entry found: the pre-image records that none existed.
		ctx.link = repaired ? null : link;
		ctx.stored = link;
		ctx.mayHaveWritten = ctx.link?.jobId === job.id || existing?.status === "writing";
		ctx.resuming = existing?.status === "writing";
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links, known) : undefined;
		if (links) ctx.current = links.current;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media =
			lookups || quietMedia
				? { ...(lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : {}), ...quietMedia }
				: undefined;
		if (drafts && images) {
			const assembled = portableTextPlan(drafts, images);
			const required = emptiedRequired(assembled, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, errors: required };
			}
			ctx.portableText = { ...assembled, ...quietText };
		} else if (quietText) ctx.portableText = quietText;
		// An edited mapping stays protected unless the feed's value has the entry's fingerprint.
		const guarded =
			edited.size === 0
				? edited
				: await protectedMappings(
						edited,
						held,
						sentForms(
							record,
							comparisons,
							ctx.links,
							media,
							ctx.portableText,
							links?.childSide ?? new Set(),
						),
					);
		const first = protectPlan(
			planRecord(entry, record, comparisons, links, media, ctx.portableText),
			record,
			guarded,
		);
		found.warnings.push(...first.warnings);
		const plan = withChange(first.plan, translationChange);
		action = plan.action;
		// M5b: the schedule this plan makes, or why an update cannot be scheduled.
		const target = ctx.target;
		const scheduled =
			target.kind === "at" ? schedulePlan(job, entry, link, plan, record, target.at) : null;
		if (scheduled !== null && "warning" in scheduled) ctx.notScheduled = scheduled.warning;
		if (scheduled !== null && "change" in scheduled) ctx.schedule = scheduled.change;
		// `not_scheduled` describes a write that went live, so only a written update carries it.
		const write = async (p: RecordPlan) => {
			const row = await writeRecord(ctx, entry, p, unprotected(ctx, record, guarded));
			if (ctx.notScheduled && row.status === "updated") found.warnings.push(ctx.notScheduled);
			return row;
		};
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			for (const [field, item] of Object.entries(media ?? {})) {
				const url = mediaRequests?.[field]?.url;
				if (item?.mediaId === null && url) found.newMedia.push(`${field}: ${url}`);
			}
			// A URL an image field also downloads is listed once, under that field.
			const listed = new Set(Object.values(mediaRequests ?? {}).map((r) => r?.url));
			for (const [url, { field }] of misses) {
				if (!listed.has(url)) found.newMedia.push(`${field}: ${url}`);
			}
			const schedule = ctx.schedule;
			if (ctx.notScheduled) found.warnings.push(ctx.notScheduled);
			return {
				status: "planned",
				sourceKey,
				entryId,
				action: schedule && plan.action === "unchanged" ? "update" : plan.action,
				changes: schedule ? [...plan.changes, schedule] : plan.changes,
			};
		}
		if (entry) {
			if (plan.action === "unchanged") {
				await setFields(ctx, entry, record, plan, links, guarded);
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			}
			// A schedule someone else set is pending too (M5b): a publish would clear it.
			const pending = entry.pendingPublish || entry.scheduledAt !== null;
			if (pending && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
					"conflict",
					sourceKey,
					entry.id,
					plan.action,
					code,
					entry.scheduledAt === null ? PENDING_DRAFT_MESSAGE : PENDING_SCHEDULE_MESSAGE,
				);
			}
			if (await deps.content.isLocked(collection, locale, entry.id)) {
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups && misses.length === 0) {
			await setFields(ctx, entry, record, plan, links, guarded);
			return await write(plan);
		}
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
			const obtained = await obtainRecordMedia(deps, cache, mediaContext(job, rec.seq), lookups);
			found.newMedia = obtained.newMedia;
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			ctx.media = { ...obtainedMedia(obtained.media), ...quietMedia };
		}
		if (drafts && images && misses.length > 0) {
			const obtained = await obtainPortableTextImages(
				deps,
				cache,
				mediaContext(job, rec.seq),
				images,
				found.newMedia,
			);
			found.warnings.push(...obtained.warnings);
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			const assembled = portableTextPlan(drafts, images);
			const required = emptiedRequired(assembled, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, action: plan.action, errors: required };
			}
			ctx.portableText = { ...assembled, ...quietText };
		}
		// Protected values were not downloaded, so the same mappings stay protected.
		const kept = protectPlan(
			planRecord(entry, record, comparisons, links, ctx.media ?? media, ctx.portableText),
			record,
			guarded,
		);
		const final = withChange(kept.plan, translationChange);
		action = final.action;
		if (target.kind === "at") {
			// The downloads may leave only links to update, which go live at once.
			const again = schedulePlan(job, entry, link, final, record, target.at);
			if (again !== null && "change" in again) ctx.schedule = again.change;
			else delete ctx.schedule;
			if (again !== null && "warning" in again) ctx.notScheduled = again.warning;
			else delete ctx.notScheduled;
		}
		await setFields(ctx, entry, record, final, links, guarded);
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await write(final);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
		return {
			status: "failed",
			sourceKey,
			entryId,
			...(action ? { action } : {}),
			errors: [{ code: e.code, message: e.message }],
		};
	}
}

/** The plan with a linked create's `translationOf` change last (M4e). */
function withChange(plan: RecordPlan, change: Change | undefined): RecordPlan {
	return change === undefined ? plan : { ...plan, changes: [...plan.changes, change] };
}

/** The ID of the group's entry in `locale` (EmDash's casing ignored), or null when it has none. */
async function translationIn(
	deps: EngineDeps,
	collection: string,
	sourceId: string,
	locale: string,
): Promise<string | null> {
	const lower = locale.toLowerCase();
	const entries = await deps.content.translations(collection, sourceId);
	return entries.find((t) => t.locale.toLowerCase() === lower)?.id ?? null;
}

function translationExists(locale: string, id: string): RecordError {
	return {
		field: "translationOf",
		code: "translation_exists",
		message: `The source entry already has a translation in ${locale} (entry ${id}), which is not this record's entry`,
	};
}

/** Whether EmDash created the entry as a translation: its group is another entry's (spec M4e F3). */
function isTranslation(entry: EntrySnapshot): boolean {
	return (entry.group ?? entry.id) !== entry.id;
}

/**
 * Whether the template maps a value EmDash shares across a translation group: a field that is
 * not translatable (per the job's snapshot), a reference field or a taxonomy; with a `scope`, only
 * among the mappings it names.
 */
function mapsShared(job: Job, scope: ReadonlySet<string> | null): boolean {
	const t = job.template;
	// With `updateFields`, an update sends only the listed mappings (M5b).
	const sent = (name: string) => scope === null || scope.has(name);
	if (Object.keys(t.taxonomies ?? {}).some((name) => sent(`taxonomies.${name}`))) return true;
	return Object.entries(t.fields).some(
		([name, m]) => sent(name) && isSharedMapping(m, job.targetFields?.[name]),
	);
}

function sharedOnTranslation(): RecordError {
	return {
		field: "translationOf",
		code: "translation_of_missing",
		message:
			"The entry is a translation of another entry: to update it, the template must map translationOf or drop its shared mappings, which would otherwise overwrite its translation group's values",
	};
}

/** The source locale of a template that maps `translationOf`; job creation always stores it. */
function sourceLocaleOf(job: Job): string {
	const locale = job.template.translationOf?.locale;
	if (locale === undefined) {
		throw new Error("Internal error: the job's template has no translationOf locale");
	}
	return locale;
}

/**
 * The decision table of spec M4e ("Resolution, diff and writes") for a template that maps
 * `translationOf`: an error fails the record; warnings go on its row; `change` marks a linked
 * create. `value` is the record's `translationOf` value, `source` what it found.
 */
async function checkTranslation(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	value: string | undefined,
	source: { id: string; group: string } | null,
): Promise<{ error: RecordError } | { warnings: RecordError[]; change?: Change }> {
	const { collection, locale } = job.template;
	const sourceLocale = sourceLocaleOf(job);
	const field = "translationOf";
	if (value === undefined) {
		// EmDash sets a translation's group to its source's (spec M4e F3).
		if (entry !== null && isTranslation(entry)) {
			return {
				error: {
					field,
					code: "translation_of_missing",
					message:
						"The entry is a translation, so the record needs a translationOf value: without one its shared values would overwrite its translation group's",
				},
			};
		}
		return { warnings: [] };
	}
	const missing = sourceNotFoundMessage(collection, sourceLocale, value);
	if (entry === null) {
		if (source === null) {
			return { error: { field, code: "translation_source_not_found", message: missing } };
		}
		cache.spend(COST_READ);
		const taken = await translationIn(deps, collection, source.id, locale);
		if (taken !== null) return { error: translationExists(locale, taken) };
		return { warnings: [], change: { field, before: null, after: `${sourceLocale}: ${value}` } };
	}
	if (source === null) {
		const message = `${missing}; the entry is updated without its source`;
		return { warnings: [{ field, code: "translation_source_not_found", message }] };
	}
	if ((entry.group ?? entry.id) !== source.group) {
		const message = `The entry is not a translation of ${sourceLocale}: ${value}, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation`;
		return { warnings: [{ field, code: "translation_not_linked", message }] };
	}
	return { warnings: [] };
}

/**
 * A `required` error for each required Portable Text field that holds a value in the source but
 * is left empty once its dropped images are left out, which EmDash would refuse to write.
 */
function emptiedRequired(
	plan: Readonly<Record<string, PortableTextPlanItem | null>>,
	job: Job,
): RecordError[] {
	return Object.entries(plan)
		.filter(([field, item]) => item === null && job.targetFields?.[field]?.required === true)
		.map(([field]) => ({ field, code: "required", message: "The field is required" }));
}

/**
 * The entry already holds the mapped data: finish an unfinished write, or publish or schedule
 * the importer's own pending state (M5b: schedule it when the record's target is a time).
 */
async function finishUnchanged(
	ctx: RecordCtx,
	entry: EntrySnapshot,
	link: LinkRow | null,
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey, target } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some(
					(e) => e.code.startsWith("publish_") || e.code.startsWith("schedule_"),
				)));
	if (!unfinished) {
		// A pending state at the revision this importer last produced is its own (an earlier
		// `publish: false` run, a failed publish, or a schedule), so publishing or scheduling it puts
		// no one else's work live.
		if (job.publish && ownPending(entry, link)) {
			if (target.kind === "at" && ctx.schedule === undefined) {
				await refreshFields(ctx, entry);
				return { status: "unchanged", sourceKey, entryId };
			}
			// Publishing makes the draft's values live: the journal keeps the live ones first.
			const failure = journaling(job) ? await journalPublish(ctx, entry, link) : null;
			if (failure) return { status: "failed", sourceKey, entryId, errors: [failure] };
			if (target.kind === "at" && ctx.schedule !== undefined) {
				// The revision scheduled, saved first: a stop before the link put is then repaired as a
				// write's is, by `scheduleLanded`.
				await ctx.save({
					status: "writing",
					sourceKey,
					entryId,
					action: "update",
					writtenRev: entry.rev,
				});
				const scheduled = await scheduleRev(ctx, entryId, entry.rev, target.at);
				if (!scheduled.ok)
					return scheduleFailed(scheduled.reason, sourceKey, entryId, "update", entry.rev);
				return {
					status: "updated",
					sourceKey,
					entryId,
					action: "update",
					changes: [ctx.schedule],
				};
			}
			// The revision published, saved first: a stop before the link put is then repaired by
			// `publishedSince` (final review A-I2).
			await ctx.save({
				status: "writing",
				sourceKey,
				entryId,
				action: "update",
				writtenRev: entry.rev,
			});
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
			return { status: "updated", sourceKey, entryId, action: "update" };
		}
		await refreshFields(ctx, entry);
		return { status: "unchanged", sourceKey, entryId };
	}
	const action = existing?.action;
	const writtenRev = existing?.writtenRev;
	// The recorded revision proves ownership only for the entry it was recorded for: revisions are
	// version-derived, so a different entry (an editor's copy) can carry the same string.
	const proven =
		writtenRev !== undefined && existing?.entryId === entry.id && entry.rev === writtenRev;
	// A schedule this record sent may have landed before the stop, whatever the record's target is
	// now (spec M5b "Crash repair"): the same version as the write's, a later updated_at, and the
	// record's time; or the scheduler has since published it (`sweptSince`).
	const { publishAt } = ctx;
	const ours = writtenRev !== undefined && existing?.entryId === entry.id;
	const landed =
		ours &&
		publishAt !== null &&
		writtenRev !== undefined &&
		scheduleLanded(entry, writtenRev, publishAt);
	// The sweep's shape is also what an editor's unschedule and discard after the time leave, so it
	// is adopted only when the entry holds the record's values for every mapping (none protected)
	// and its whole live data is what the job journalled for the scheduled write (final review
	// A-I1): `updateFields` and the importer's own draft leave fields the plan does not compare.
	const swept =
		ours &&
		publishAt !== null &&
		(ctx.kept?.size ?? 0) === 0 &&
		writtenRev !== undefined &&
		sweptSince(
			{
				collection: job.template.collection,
				locale: job.template.locale,
				sourceKey,
				entryId,
				writtenRev,
				scheduledAt: publishAt,
			},
			entry,
		) &&
		(await holdsScheduled(job, await journalledWrote(ctx), publishAt, entry));
	// A publish this record sent may have landed before the stop lost its link save (final review
	// A-I2): one version past the revision saved before it, published, no draft, and the job's
	// journalled values live. An editor's save without revisions, or discard of the importer's
	// draft, leaves the same shape with other values.
	const publishedOurs =
		!swept &&
		ours &&
		target.kind === "now" &&
		(ctx.kept?.size ?? 0) === 0 &&
		writtenRev !== undefined &&
		publishedSince(entry, writtenRev) &&
		(await holdsWrote(job, await journalledWrote(ctx), entry));
	if (swept && publishAt !== null) {
		// The scheduler's publish is the importer's: the link takes its revision, so rollback owns it.
		await putLink(ctx, entryId, entry.rev, publishAt);
	} else if (publishedOurs) {
		await putLink(ctx, entryId, entry.rev);
	} else if (landed && publishAt !== null && target.kind !== "at") {
		// The time is now within the lead (or past): adopt the schedule, then publish it now.
		await putLink(ctx, entryId, entry.rev, publishAt);
		if (target.kind === "now") {
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, action, writtenRev);
		}
	} else if (job.publish && entry.pendingPublish && target.kind === "at") {
		const at = target.at;
		if (landed || (proven && sameInstant(entry.scheduledAt, at))) {
			await putLink(ctx, entryId, entry.rev, at);
		} else if (proven) {
			const scheduled = await scheduleRev(ctx, entryId, entry.rev, at);
			if (!scheduled.ok)
				return scheduleFailed(scheduled.reason, sourceKey, entryId, action, writtenRev);
		} else {
			return {
				status: "conflict",
				sourceKey,
				entryId,
				...(action ? { action } : {}),
				...(writtenRev === undefined ? {} : { writtenRev }),
				errors: [
					{
						code: "schedule_unverified",
						message:
							"Saved as a draft and maybe scheduled: the entry may have changed after the import wrote it, so it was not verified",
					},
				],
			};
		}
	} else if (job.publish && entry.pendingPublish) {
		// Publish only the exact revision this job wrote; anything newer may be an editor's draft.
		if (!proven) {
			return {
				status: "conflict",
				sourceKey,
				entryId,
				...(action ? { action } : {}),
				...(writtenRev === undefined ? {} : { writtenRev }),
				errors: [
					{
						code: "publish_unverified",
						message:
							"Saved as a draft: the entry may have changed after the import wrote it, so it was not published",
					},
				],
			};
		}
		const published = await publishRev(ctx, entryId, entry.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, entryId, action, writtenRev);
	} else if (!job.publish && proven && link?.writtenRev !== writtenRev) {
		// The crash came between saving the written revision and saving the link: the draft is
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev, entry.scheduledAt);
	}
	await refreshFields(ctx, entry);
	return {
		status: action === "create" ? "created" : "updated",
		sourceKey,
		entryId,
		...(action ? { action } : {}),
	};
}

/**
 * A linked create's links (M4e): only the bylines, always when mapped, an empty list included,
 * since EmDash copies the source's credits when none are given (spec M4e F5). Terms and
 * references are the translation group's.
 */
function translationLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	if (resolved?.bylines === undefined) return {};
	return { bylines: resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null })) };
}

/** A create's links: every non-empty one. New byline credits have no role label. */
function createLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (items.length === 0) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (items.length === 0) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && resolved.bylines.length > 0) {
		writes.bylines = resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null }));
	}
	return writes;
}

/**
 * An update's links: only the changed ones, each replacing the entry's (an empty list clears
 * it). A byline the entry is already credited with keeps its role label.
 */
function updateLinks(
	resolved: ResolvedLinks | undefined,
	plan: RecordPlan,
	entry: EntrySnapshot,
): LinkWrites {
	const changed = new Set(plan.changes.map((c) => c.field));
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (!changed.has(`taxonomies.${taxonomy}`)) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (!changed.has(field)) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && changed.has("bylines")) {
		const roles = new Map((entry.bylines ?? []).map((b) => [b.group, b.roleLabel]));
		writes.bylines = resolved.bylines.map((b) => ({
			bylineId: b.value,
			roleLabel: roles.get(b.group as string) ?? null,
		}));
	}
	return writes;
}

/** Journals the publish of the importer's own pending draft: every field it makes live (M5a). */
async function journalPublish(
	ctx: RecordCtx,
	entry: EntrySnapshot,
	link: LinkRow | null,
): Promise<RecordError | null> {
	const touched = {
		fields: draftFields(entry),
		slug: false,
		taxonomies: [],
		references: [],
		bylines: false,
		// Only a published entry with a pending draft: the read gave the draft's selection.
		referencesUnknown:
			entry.status === "published" && entry.hasDraft && ctx.links?.references !== undefined,
	};
	const before = preImage(entry, link, touched, undefined);
	if ("code" in before) return before;
	return journalUpdate(ctx, entry.id, before, await liveWrote(ctx, entry, entry.data, undefined));
}

/**
 * The write-ahead journal row of a write (M5a): a create's source ID, or the pre-image of every
 * field and link an update changes and, when it publishes, of every field its publish makes live.
 */
async function journalWrite(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	plan: RecordPlan,
	data: Readonly<Record<string, FieldValue>>,
	media: Readonly<Record<string, FieldValue>>,
	slug: string | undefined,
): Promise<RecordError | null> {
	if (!entry) {
		const wrote = await liveWrote(ctx, null, data, slug);
		await journalCreate(ctx, ctx.translationOf?.value ?? ctx.sourceKey, wrote);
		return null;
	}
	const changed = new Set(plan.changes.map((c) => c.field));
	const fields = new Set<string>();
	for (const field of changed) {
		if (Object.hasOwn(data, field)) fields.add(field);
		else if (field.endsWith(".alt") && Object.hasOwn(media, field.slice(0, -4))) {
			fields.add(field.slice(0, -4));
		}
	}
	// Every field of a pending draft, also when the job does not publish: the rollback publishes
	// the restored live values (revert step 2), which must not make the rest of the draft live.
	for (const field of draftFields(entry)) fields.add(field);
	fields.delete(SOURCE_ID_FIELD);
	const resolved = ctx.links;
	const touched = {
		fields: [...fields],
		slug: changed.has("slug"),
		taxonomies: Object.keys(resolved?.taxonomies ?? {}).filter((t) =>
			changed.has(`taxonomies.${t}`),
		),
		references: Object.keys(resolved?.references ?? {}).filter((f) => changed.has(f)),
		bylines: resolved?.bylines !== undefined && changed.has("bylines"),
		// The read gives the draft's selection only, and the publish makes it live.
		referencesUnknown:
			ctx.job.publish &&
			entry.status === "published" &&
			entry.hasDraft &&
			resolved?.references !== undefined,
	};
	const before = preImage(entry, ctx.link, touched, ctx.current);
	if ("code" in before) return before;
	// The groups this write gives each changed taxonomy, for the rollback's term check (I3).
	const terms = Object.fromEntries(
		touched.taxonomies.map((t) => [
			t,
			(resolved?.taxonomies?.[t] ?? []).flatMap((i) => (i.group === null ? [] : [i.group])),
		]),
	);
	const sent = sendsData(plan, data, media);
	const scheduled = await liveWrote(
		ctx,
		entry,
		sent ? { ...entry.data, ...data } : entry.data,
		sent ? slug : undefined,
	);
	return journalUpdate(ctx, entry.id, before, {
		...(touched.taxonomies.length > 0 ? { taxonomies: terms } : {}),
		...scheduled,
	});
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	plan: RecordPlan,
	mapped: MappedRecord,
): Promise<RowFields> {
	const { deps, job, sourceKey, save } = ctx;
	const { collection, locale } = job.template;
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media and Portable Text fields are data fields: their values (null clears one) are written
	// with the rest.
	const media: Record<string, FieldValue> = {};
	for (const [field, item] of Object.entries(ctx.media ?? {})) media[field] = item?.value ?? null;
	for (const [field, item] of Object.entries(ctx.portableText ?? {})) {
		media[field] = item?.blocks ?? null;
	}
	const data = { ...mapped.data, ...media };
	// The journal row comes before the first write, so a crash leaves nothing it does not know of.
	if (journaling(job)) {
		const failure = await journalWrite(ctx, entry, plan, data, media, mapped.slug);
		if (failure) {
			return {
				status: "failed",
				sourceKey,
				entryId: entry?.id ?? null,
				action: plan.action,
				errors: [failure],
			};
		}
	}
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	let written: { id: string; rev: string };
	if (!entry && ctx.translationOf !== undefined) {
		const { sourceId, value } = ctx.translationOf;
		const created = await createTranslation(ctx, sourceId, value, plan, {
			collection,
			locale,
			...slugPart,
			// EmDash copies the source's source ID; sent so it is the same where the field is
			// translatable (spec M4e "Writes").
			data: { ...data, [SOURCE_ID_FIELD]: value },
			...translationLinks(ctx.links),
		});
		if ("status" in created) return created;
		written = created;
	} else if (!entry) {
		written = await deps.content.create({
			collection,
			locale,
			...slugPart,
			data: { ...data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out (`sendsData`).
		const dataChanged = sendsData(plan, data, media);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data } : {}),
			...updateLinks(ctx.links, plan, entry),
		});
		if (!result.ok) {
			return result.reason === "conflict"
				? notImported(
						"conflict",
						sourceKey,
						entry.id,
						plan.action,
						"rev_conflict",
						REV_CONFLICT_MESSAGE,
					)
				: notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
		}
		written = { id: entry.id, rev: result.rev };
	}
	if (!entry && journaling(job)) await journalCreated(ctx, written.id, true);
	// M5c: the job's own create (a linked one included) stamps the owner on the link.
	if (!entry) ctx.stamp = true;
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
		status: "writing",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		writtenRev: written.rev,
	});
	// An update keeps the entry's schedule (spec M5b F7), which the link records with the revision.
	await putLink(ctx, written.id, written.rev, entry?.scheduledAt ?? null);
	if (ctx.target.kind === "now") {
		const published = await publishRev(ctx, written.id, written.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, written.id, plan.action, written.rev);
	} else if (ctx.target.kind === "at" && ctx.schedule !== undefined) {
		const scheduled = await scheduleRev(ctx, written.id, written.rev, ctx.target.at);
		if (!scheduled.ok)
			return scheduleFailed(scheduled.reason, sourceKey, written.id, plan.action, written.rev);
	}
	return {
		status: plan.action === "create" ? "created" : "updated",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		changes: ctx.schedule ? [...plan.changes, ctx.schedule] : plan.changes,
	};
}

/**
 * Creates the entry as a translation of `sourceId`, found by the source key `value`. A source
 * trashed since it was found fails `translation_source_not_found`; an entry another writer added
 * in the locale meanwhile (a `CONFLICT`) fails `translation_exists`.
 */
async function createTranslation(
	ctx: RecordCtx,
	sourceId: string,
	value: string,
	plan: RecordPlan,
	input: Omit<Parameters<EngineDeps["content"]["create"]>[0], "translationOf">,
): Promise<{ id: string; rev: string } | RowFields> {
	const { deps, sourceKey } = ctx;
	try {
		return await deps.content.create({ ...input, translationOf: sourceId });
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		const failed = (error: RecordError): RowFields => ({
			status: "failed",
			sourceKey,
			entryId: null,
			action: plan.action,
			errors: [error],
		});
		if (e.code === "emdash_not_found") {
			const sourceLocale = sourceLocaleOf(ctx.job);
			const message = `The source entry ${sourceId} (${sourceLocale}: ${value}) no longer exists`;
			return failed({ field: "translationOf", code: "translation_source_not_found", message });
		}
		if (e.code === "emdash_conflict") {
			const taken = await translationIn(deps, input.collection, sourceId, input.locale);
			if (taken !== null) return failed(translationExists(input.locale, taken));
		}
		throw e;
	}
}

async function importPass(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const stream = await deps.source.open(job.uploadId, job.cursor.offset);
	let processed = 0;
	for await (const rec of jobReader(job).read(stream, {
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		try {
			await processRecord(deps, job, template, rec, { retry: false, cache });
		} catch (e) {
			// Not saved and not counted: the next batch processes the record again.
			if (e instanceof MediaDeferred) return { done: false };
			throw e;
		}
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
			return { done: false };
		}
	}
	return { done: true };
}

const RETRY_PAGE = 100; // plugin storage query limit

async function readOneRecord(deps: EngineDeps, job: Job, row: RecordRow): Promise<SourceRecord> {
	const stream = await deps.source.open(job.uploadId, row.start);
	for await (const rec of jobReader(job).read(stream, {
		startOffset: row.start,
		startSeq: row.seq,
	})) {
		return rec;
	}
	// CSV jobs keep the code they failed with before other formats existed.
	const code = (job.source?.format ?? "csv") === "csv" ? "csv_syntax" : "source_syntax";
	throw new SourceError(code, "No record at the saved offset", row.start);
}

/** Rebuilds counters from the record rows, so a crashed retry batch cannot leave them skewed. */
async function tallyCounters(deps: EngineDeps, jobId: string): Promise<Counters> {
	const counters = emptyCounters();
	let cursor: string | undefined;
	for (;;) {
		const page = await deps.records.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: RETRY_PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			const counter = counterFor(data);
			if (counter) bump(counters, counter);
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
	}
}

async function retryPass(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
		const page = await deps.records.query({
			where: {
				jobId: job.id,
				status: { in: ["failed", "conflict", "locked", "writing"] },
				seq: { gte: job.retryFromSeq },
			},
			orderBy: { seq: "asc" },
			limit: Math.min(limit, RETRY_PAGE),
		});
		if (page.items.length === 0) {
			job.counters = await tallyCounters(deps, job.id);
			return { done: true };
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			try {
				await processRecord(deps, job, template, rec, { retry: true, cache });
			} catch (e) {
				if (e instanceof MediaDeferred) return { done: false };
				throw e;
			}
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
}

/** An import job's batch: the source-ID field, the compiled template, then a pass. */
async function importBatch(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	// M5c: the missing phase reads links and entries, not the source.
	if (job.phase === "missing") return missingPass(deps, job, started, limit, cache);
	if (!job.dryRun && !job.schemaReady) {
		await deps.content.ensureSourceIdField(job.template.collection);
		job.schemaReady = true;
	}
	// Parsed once per batch and reused for every record; job creation already checked them.
	const compiled = compileTemplate(jobTemplate(job), {
		targets: job.targetFields,
		siteTimezone: job.siteTimezone,
		taxonomies: job.taxonomies,
		sharedRequired: job.sharedRequired,
	});
	if (!compiled.ok) {
		return {
			done: false,
			error: { code: "invalid_template", message: compiled.problems.join("; ") },
		};
	}
	const template = compiled.compiled;
	if (job.phase === "retry") return retryPass(deps, job, template, started, limit, cache);
	const outcome = await importPass(deps, job, template, started, limit, cache);
	// M5c: a completed first pass enters the missing phase, or completes when it is skipped.
	return outcome.done ? enterMissing(job) : outcome;
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link and media lookups are cached for the batch, and the
 * batch ends after the record that brings their cost to `lookupBudget` (that record always
 * completes). Media downloads end by the budget plus `MEDIA_GRACE_MS`; a record whose next
 * download would start later is left for the next batch.
 */
export async function runBatch(
	deps: EngineDeps,
	jobId: string,
	holder: string,
	maxRecords: number | ((job: Job) => number) = Number.POSITIVE_INFINITY,
	lookupBudget = Number.POSITIVE_INFINITY,
): Promise<Job> {
	const claimed = await claim(deps, jobId, holder);
	if (!claimed.ok) return claimed.job;
	const job = claimed.job;
	const started = deps.now();
	const cap = typeof maxRecords === "number" ? maxRecords : maxRecords(job);
	const limit = Math.min(job.batchSize, cap);
	const cache = new LookupCache(job.dryRun ? (job.plannedTerms ?? []) : [], lookupBudget);
	cache.mediaDeadline = started + job.budgetMs + MEDIA_GRACE_MS;
	let outcome: Outcome;
	try {
		// A rollback reads its original's journal, not a source file (M5a).
		if (job.kind === "rollback") {
			// An original gone or being deleted leaves an empty or partial journal: the rollback fails
			// with that reason rather than completing with no rows (spec M5a "Retention").
			const problem = await originalProblem(deps, job);
			if (problem !== null) {
				outcome = { done: false, error: { code: "rollback_original_gone", message: problem } };
			} else {
				outcome =
					job.phase === "retry"
						? await rollbackRetryPass(deps, job, started, limit, cache)
						: await rollbackPass(deps, job, started, limit, cache);
			}
		} else {
			outcome = await importBatch(deps, job, started, limit, cache);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
			outcome = { done: false, error: { code: "source_missing", message: e.message } };
		} else if (e instanceof ContentWriteError && JOB_LEVEL_WRITE_ERRORS.has(e.code)) {
			outcome = { done: false, error: { code: e.code, message: e.message } };
		} else if (e instanceof SourceError) {
			outcome = {
				done: false,
				error: { code: e.code, message: `${e.message} at byte ${e.offset}` },
			};
		} else {
			await noteFailure(deps, job.id, holder, e).catch(() => {
				// Keep the original error; the next driver retries as after a process death.
			});
			throw e;
		}
	}
	keepPlannedTerms(job, cache);
	return release(deps, job, holder, outcome);
}

const PLANNED_OVERFLOW_WARNING =
	"The dry run no longer tracks planned terms across batches: it would create more than 5,000";

/** Adds the terms this dry-run batch planned to the job, which the release saves. */
function keepPlannedTerms(job: Job, cache: LookupCache): void {
	if (!job.dryRun) return;
	if (cache.newPlanned.length > 0) {
		job.plannedTerms = [...(job.plannedTerms ?? []), ...cache.newPlanned];
	}
	if (cache.plannedOverflow && !job.warnings?.includes(PLANNED_OVERFLOW_WARNING)) {
		job.warnings = [...(job.warnings ?? []), PLANNED_OVERFLOW_WARNING];
	}
}

const MAX_FAILURES = 3;

/**
 * Records an unexpected error on the stored job. Cursor, counters and lease stay as they were, so
 * the next driver recovers exactly as after a process death; the third failure in a row fails
 * the job and drops the lease.
 */
async function noteFailure(deps: EngineDeps, jobId: string, holder: string, e: unknown) {
	const message = e instanceof Error ? e.message : String(e);
	await updateJob(deps, jobId, (stored) => {
		if (stored.lease?.holder !== holder) return stored;
		const failures = stored.failures + 1;
		const next: Job = { ...stored, error: { code: "internal", message }, failures };
		if (failures < MAX_FAILURES) return next;
		return { ...next, status: stored.status === "running" ? "failed" : stored.status, lease: null };
	});
}
