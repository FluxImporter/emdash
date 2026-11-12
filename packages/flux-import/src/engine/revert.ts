/**
 * The rollback pass (spec M5a "Rollback"): walks an import's journal newest first and, per row,
 * finds the entry, checks that it is as the import (or this rollback) left it and not locked,
 * then deletes a created entry or restores a changed one, step by step so that a resumed batch
 * continues where it stopped. A dry run decides every row the same way and writes nothing.
 */
import type { Change } from "./diff.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type EntryState,
	type LinkWrites,
	type RevertStep,
	type StepResult,
	TRANSLATION_SLOT_TAKEN,
} from "./ports.js";
import {
	bylineIdsOf,
	COST_CALL,
	COST_READ,
	COST_RECORD,
	type LookupCache,
	loadTerms,
	termOfGroup,
} from "./resolve.js";
import { decodeRev } from "./revs.js";
import { restoredData, sameStored } from "./rollback-values.js";
import { holdsScheduled, sameInstant, sweptSince } from "./rules.js";
import { SOURCE_ID_FIELD } from "./template.js";
import {
	bump,
	type Counters,
	capErrors,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	iso,
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	type LinkRow,
	linkKey,
	type RecordError,
	type RecordRow,
	type RollbackAction,
	type RowFields,
	recordKey,
} from "./types.js";

type Outcome = { done: boolean };
type StepFailure = Extract<StepResult, { ok: false }>;

/** Plugin storage query limit. */
const PAGE = 100;

const CHANGED_MESSAGE =
	"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand";
const LOCKED_MESSAGE = "Not rolled back: the entry is being edited (locked)";
const NOTHING_MESSAGE = "Nothing to roll back: the entry was never created, or was deleted since";
const NEVER_WRITTEN_MESSAGE = "Nothing to roll back: the import never wrote this entry";
const TRASHED_MESSAGE =
	"Moved to Trash, not deleted: the import found this entry by crash repair, so it may not have created it";
const TRASHED_ELSEWHERE =
	"Not rolled back: the entry was moved to Trash after the import created it; restore it from Trash or delete it by hand";
const UNCERTAIN_MESSAGE =
	"Not rolled back: the import was recovering from a stop when it wrote this entry, and the entry had changed since its first read, so a later edit cannot be ruled out; revert it by hand";
const TERMS_CHANGED_MESSAGE =
	"Not rolled back: the entry's terms changed after the import wrote them (term edits do not change the revision); revert it by hand";
/** A job warning (final review I5). */
export const REFERENCES_DELETED_WARNING =
	"Deleting an entry also removes references other entries hold to it.";
/**
 * What one revert step costs the batch's lookup budget, from the D1 queries per call (spec M5a
 * V7) at the rate `COST_READ` (5) sets for a read of 10-12: about 2.2 queries per unit. Update
 * 62-80, publish 76, unpublish 25-35, discard 23, schedule 28-29.
 */
const STEP_COST: Readonly<Record<RevertStep, number>> = {
	update: 35,
	publish: 35,
	unpublish: 15,
	discard: 10,
	schedule: 15,
	// M5b step 7, costed as a schedule (spec M5b "Caps").
	unschedule: 15,
	// M5c step 8: 18 D1 queries (plan Fact V8), costed as an unpublish.
	restore: 15,
};
/** Trash and permanent delete, which V7 did not measure: `COST_READ` x 5. */
const COST_DELETE = COST_READ * 5;
const UNLINKED_MESSAGE =
	"Moved to Trash, not deleted: the import never saved its link to this entry, so a later edit cannot be ruled out";
const TRANSLATIONS_MESSAGE =
	"Not rolled back: the entry has translations that are still active; roll back the jobs of its translations first";
const REFERENCES_UNKNOWN_MESSAGE =
	"References staged in a draft before this job could not be restored";
/** M5c: an entry the missing phase trashed that is no longer as the phase left it. */
const TRASH_CHANGED_MESSAGE =
	"Not rolled back: the entry was restored or changed after the import moved it to Trash";
const SLOT_TAKEN_MESSAGE = "Not rolled back: the entry's translation slot is taken";
const REQUIRED_MESSAGE =
	"Not rolled back: the field was empty before the import, and the collection requires it, so EmDash would refuse the restored value";

const ROLLBACK_ACTIONS: ReadonlySet<string> = new Set(["delete", "trash", "revert", "restore"]);

/** The counter a rollback row counts toward: reverted, or planned to be, as `reverted`. */
function counterOf(row: RowFields): keyof Counters | null {
	switch (row.status) {
		case "writing":
			return null;
		case "planned":
			return row.action !== undefined && ROLLBACK_ACTIONS.has(row.action)
				? "reverted"
				: "unchanged";
		case "reverted":
			return "reverted";
		default:
			return row.status;
	}
}

/** The rollback job's original import; job creation always sets it. */
function originalOf(job: Job): string {
	if (job.rollbackOf === undefined) throw new Error(`Job ${job.id} is not a rollback job`);
	return job.rollbackOf;
}

/** The first pass: journal rows below `cursor.seq`, newest first. */
export async function rollbackPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
		const page = await deps.journal.query({
			where: { jobId: originalOf(job), seq: { lt: job.cursor.seq } },
			orderBy: { seq: "desc" },
			limit: Math.min(limit - processed, PAGE),
		});
		if (page.items.length === 0) return { done: true };
		for (const { data } of page.items) {
			// Reserved before each row: a batch always reverts at least one.
			if (processed > 0 && !affordable(cache, data)) return { done: false };
			await revertRow(deps, job, data, { retry: false, cache });
			job.cursor = { offset: 0, seq: data.seq };
			processed++;
			if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
		}
	}
}

/** `jobs/retry`: rows left failed, conflict, locked or writing, newest first. */
export async function rollbackRetryPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const { collection, locale } = job.template;
	let processed = 0;
	for (;;) {
		const page = await deps.records.query({
			where: {
				jobId: job.id,
				status: { in: ["failed", "conflict", "locked", "writing"] },
				seq: { lt: job.retryFromSeq },
			},
			orderBy: { seq: "desc" },
			limit: Math.min(limit, PAGE),
		});
		if (page.items.length === 0) {
			job.counters = await tallyRollback(deps, job.id);
			return { done: true };
		}
		for (const { data: row } of page.items) {
			const key = journalKey(originalOf(job), linkKey(collection, locale, row.sourceKey ?? ""));
			const entry = await deps.journal.get(key);
			if (processed > 0 && entry && !affordable(cache, entry)) return { done: false };
			// A journal row is only deleted with its job, which retention keeps meanwhile.
			if (entry) await revertRow(deps, job, entry, { retry: true, cache });
			job.retryFromSeq = row.seq;
			processed++;
			if (processed >= limit || deps.now() - started >= job.budgetMs) return { done: false };
		}
	}
}

/**
 * What a row may spend at most before its references: `COST_RECORD` (25), the longest revert
 * sequence, update, publish, unpublish, update and schedule or unschedule (35 + 35 + 15 + 35 +
 * 15; steps 4 and 5 exclude each other, as steps 6 and 7 do), and a term read (5). The trash and
 * delete (50) never run with the sequence.
 */
const ROW_RESERVE = 165;

/**
 * Whether the batch's budget still covers a row: `ROW_RESERVE` plus a read for each reference ID
 * the pre-image restores. The ones the entry still holds are not looked up, but which those are
 * is only known after its read, so every ID counts here (an upper bound).
 */
function affordable(cache: LookupCache, journal: JournalEntry): boolean {
	const ids = Object.values(journal.before?.links?.references ?? {}).flat().length;
	return cache.spent + ROW_RESERVE + COST_READ * ids <= cache.budget;
}

/** Rebuilds a rollback job's counters from its rows, as an import's retry does. */
async function tallyRollback(deps: EngineDeps, jobId: string): Promise<Counters> {
	const counters: Counters = { ...emptyCounters(), reverted: 0 };
	let cursor: string | undefined;
	for (;;) {
		const page = await deps.records.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			const counter = counterOf(data);
			if (counter) bump(counters, counter);
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
	}
}

/** Decides and carries out one journal row, saving its record row as an import saves its own. */
async function revertRow(
	deps: EngineDeps,
	job: Job,
	journal: JournalEntry,
	opts: { retry: boolean; cache: LookupCache },
): Promise<void> {
	const key = recordKey(job.id, journal.seq);
	const existing = await deps.records.get(key);
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor.
		const counter = counterOf(existing);
		if (counter) bump(job.counters, counter);
		return;
	}
	const save = (fields: RowFields) =>
		deps.records.put(key, {
			jobId: job.id,
			seq: journal.seq,
			start: 0,
			end: 0,
			...fields,
			...(fields.errors ? { errors: capErrors(fields.errors) } : {}),
			...(fields.warnings ? { warnings: capWarnings(fields.warnings) } : {}),
			updatedAt: iso(deps),
		});
	opts.cache.spend(COST_RECORD);
	const ctx: RowCtx = { deps, job, journal, existing, save, cache: opts.cache, warnings: [] };
	let row: RowFields;
	try {
		row = await decideRow(ctx);
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		row = {
			status: "failed",
			sourceKey: journal.sourceKey,
			entryId: ctx.entryId ?? journal.entryId,
			...(ctx.action ? { action: ctx.action } : {}),
			...(ctx.written ? { writtenRev: ctx.written.rev, step: ctx.written.step } : {}),
			errors: [{ code: e.code, message: e.message }],
		};
	}
	if (ctx.warnings.length > 0)
		row = { ...row, warnings: [...(row.warnings ?? []), ...ctx.warnings] };
	await save(row);
	if (existing && opts.retry) {
		const old = counterOf(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterOf(row);
	if (counter) bump(job.counters, counter);
}

type RowCtx = {
	deps: EngineDeps;
	job: Job;
	journal: JournalEntry;
	existing: RecordRow | null;
	save: (fields: RowFields) => Promise<void>;
	cache: LookupCache;
	warnings: RecordError[];
	/** Known so far, so that an unexpected EmDash error still reports them. */
	entryId?: string;
	action?: RollbackAction;
	/** The last step done and the revision it left. */
	written?: { rev: string; step: number };
};

type Found = EntrySnapshot & { trashed: boolean };

/** Step 1 of "Per row": the entry by ID (active first, then in Trash), or a create's by source ID. */
async function findEntry(ctx: RowCtx): Promise<{ entry: Found; adopted: boolean } | null> {
	const { deps, journal, existing } = ctx;
	const { collection, locale } = journal;
	const id = journal.entryId ?? existing?.entryId ?? null;
	if (id !== null) {
		const active = await deps.content.get(collection, locale, id, { references: true });
		if (active) return { entry: { ...active, trashed: false }, adopted: false };
		const trashed = await deps.content.getIncludingTrashed(collection, locale, id);
		return trashed ? { entry: trashed, adopted: false } : null;
	}
	if (journal.kind !== "create" || journal.sourceIdValue === undefined) return null;
	// A crash before the create returned, or a partial create on D1: the entry is taken only when
	// it was created after the write-ahead row and never changed since (spec M5a V3).
	const found = await deps.content.findBySourceId(collection, locale, journal.sourceIdValue);
	if (
		found?.createdAt === undefined ||
		found.createdAt < journal.at ||
		found.updatedAt !== found.createdAt
	) {
		return null;
	}
	return { entry: { ...found, trashed: false }, adopted: true };
}

function rowOf(
	ctx: RowCtx,
	status: RowFields["status"],
	extra: Partial<RowFields> = {},
): RowFields {
	return {
		status,
		sourceKey: ctx.journal.sourceKey,
		entryId: ctx.entryId ?? ctx.journal.entryId,
		...(ctx.action ? { action: ctx.action } : {}),
		...(ctx.written ? { writtenRev: ctx.written.rev, step: ctx.written.step } : {}),
		...extra,
	};
}

const issue = (code: string, message: string, field?: string): RecordError =>
	field === undefined ? { code, message } : { field, code, message };

async function decideRow(ctx: RowCtx): Promise<RowFields> {
	const { deps, job, journal, existing } = ctx;
	if (journal.kind !== "create" && journal.kind !== "update" && journal.kind !== "trash") {
		return rowOf(ctx, "failed", {
			errors: [
				issue(
					"journal_kind_unknown",
					`Not rolled back: the journal row is of a kind this version does not know (${String(journal.kind)})`,
				),
			],
		});
	}
	const found = await findEntry(ctx);
	// M5c: a trash of the missing phase is undone by a restore (spec "Rollback").
	if (journal.kind === "trash") return restoreTrashed(ctx, found?.entry ?? null);
	if (!found) {
		// A crash after the permanent delete, before the row was saved: the delete is done.
		if (existing?.status === "writing" && existing.action === "delete") {
			ctx.action = "delete";
			const id = linkKey(journal.collection, journal.locale, journal.sourceKey);
			const link = await deps.links.get(id);
			if (link?.entryId === existing.entryId) await deps.links.delete(id);
			return rowOf(ctx, "reverted", existing.entryId ? { entryId: existing.entryId } : {});
		}
		return rowOf(ctx, "unchanged", { warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)] });
	}
	const { entry, adopted } = found;
	ctx.entryId = entry.id;
	ctx.action = journal.kind === "create" ? "delete" : "revert";

	// Ownership: as the import left it (its link row), or as this rollback left it (resuming).
	const linkId = linkKey(journal.collection, journal.locale, journal.sourceKey);
	const link = await deps.links.get(linkId);
	const resumed =
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	// M5b: also an entry the import scheduled and EmDash's scheduler published since (spec M5b
	// "Ownership after the scheduler published"),
	// which still holds the values the job scheduled. An editor's unschedule and discard after the
	// time leaves the same revision shape with the values from before the job (Task 5 review, P6).
	const owned =
		link !== null &&
		link.jobId === job.rollbackOf &&
		link.entryId === entry.id &&
		(link.writtenRev === entry.rev ||
			(!entry.trashed &&
				sweptSince(link, entry) &&
				(await holdsScheduled(job, journal.wrote, link.scheduledAt, entry))));
	// A create made after the write-ahead row and never changed since (spec M5a V3): found by
	// source ID after a crash, or one whose link was never saved. A link that names the entry and a
	// revision settles it: EmDash keeps `updated_at` when an edit only stages a draft
	// (repositories/content.ts:2831-2846), so the timestamps cannot tell an edit there.
	const untouched =
		journal.kind === "create" &&
		(link?.entryId !== entry.id || link.writtenRev === undefined) &&
		(adopted ||
			(entry.createdAt !== undefined &&
				entry.createdAt >= journal.at &&
				entry.updatedAt === entry.createdAt));
	if (resumed && existing) ctx.written = { rev: entry.rev, step: existing.step ?? 0 };
	// A step sent to EmDash whose row save was lost: the entry moved past both revisions this
	// rollback and the import know, and is adopted only when it shows that step's result.
	const pending =
		!resumed &&
		!owned &&
		journal.kind === "update" &&
		existing?.status === "writing" &&
		existing.pendingStep !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev !== entry.rev &&
		link?.writtenRev !== entry.rev
			? existing.pendingStep
			: undefined;
	if (!resumed && !owned && !untouched && pending === undefined) {
		const before = journal.before;
		// Only while the link is still the one the pre-image read: a link naming any other job
		// (a later import, or an earlier one this job's write replaced) is a change to report, and
		// reporting it keeps the row for a retry once that job is rolled back.
		const sameLink =
			before !== undefined &&
			(link === null
				? before.link === null
				: before.link !== null &&
					link.jobId === before.link.jobId &&
					link.writtenRev === before.link.writtenRev);
		const neverWritten =
			journal.kind === "update" &&
			sameLink &&
			(entry.rev === before?.link?.writtenRev ||
				(entry.updatedAt !== undefined && entry.updatedAt < journal.at));
		if (neverWritten) {
			return rowOf(ctx, "unchanged", {
				warnings: [issue("nothing_to_roll_back", NEVER_WRITTEN_MESSAGE)],
			});
		}
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
	}
	if (await deps.content.isLocked(journal.collection, journal.locale, entry.id)) {
		return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	return journal.kind === "create"
		? deleteCreated(ctx, entry, adopted, link)
		: restoreChanged(
				ctx,
				entry,
				link,
				pending,
				// The schedule the job's link records: the only one step 7 may remove (review I2).
				link?.entryId === entry.id && link.jobId === job.rollbackOf ? link.scheduledAt : undefined,
			);
}

/** "Created entries": Trash, then a permanent delete when the import's own create made it. */
async function deleteCreated(
	ctx: RowCtx,
	entry: Found,
	adopted: boolean,
	link: LinkRow | null,
): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection } = journal;
	const linked = link?.entryId === entry.id;
	// In Trash, and not by this rollback (its row records the trash step, done or sent): someone
	// trashed it, and may want it back.
	const ours = (ctx.existing?.step ?? 0) >= 1 || ctx.existing?.pendingStep === 1;
	if (entry.trashed && !ours) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TRASHED_ELSEWHERE)] });
	}
	if (!entry.trashed && (entry.group ?? entry.id) === entry.id) {
		const group = await deps.content.translations(collection, entry.id);
		if (group.some((t) => t.id !== entry.id)) {
			return rowOf(ctx, "conflict", {
				errors: [issue("rollback_has_translations", TRANSLATIONS_MESSAGE)],
			});
		}
	}
	// Deleted for good only when the job's own create returned it and its link records the
	// revision: without one, only timestamps vouch for it, and they miss a draft edit (spec F2).
	const recorded = linked && link?.writtenRev !== undefined;
	const confirmed = journal.confirmed === true && !adopted && recorded;
	ctx.action = confirmed ? "delete" : "trash";
	const warnings = confirmed
		? []
		: [
				issue(
					"rollback_trashed",
					journal.confirmed === true && !adopted ? UNLINKED_MESSAGE : TRASHED_MESSAGE,
				),
			];
	// There is no backlinks API, so the job says once that references to deleted entries go too.
	if (confirmed && !job.warnings?.includes(REFERENCES_DELETED_WARNING)) {
		job.warnings = [...(job.warnings ?? []), REFERENCES_DELETED_WARNING];
	}
	if (job.dryRun)
		return rowOf(ctx, "planned", { changes: [], ...(warnings.length ? { warnings } : {}) });
	ctx.written = { rev: entry.rev, step: ctx.written?.step ?? 0 };
	await ctx.save(rowOf(ctx, "writing", entry.trashed ? {} : { pendingStep: 1 }));
	if (!entry.trashed) {
		ctx.cache.spend(COST_DELETE);
		const trashed = await deps.content.trash(collection, entry.id);
		if (!trashed.ok) {
			if (trashed.reason === "blocked") {
				return rowOf(ctx, "failed", {
					errors: [
						issue(
							"rollback_blocked",
							`Not rolled back: a plugin refused the delete: ${trashed.message}`,
						),
					],
				});
			}
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
		}
		// Trash keeps the revision (spec M5a F6), so a resumed row still passes ownership.
		ctx.written = { rev: entry.rev, step: 1 };
		await ctx.save(rowOf(ctx, "writing"));
	}
	if (confirmed) {
		ctx.cache.spend(COST_DELETE);
		await deps.content.permanentDelete(collection, entry.id);
	}
	if (linked) await deps.links.delete(linkKey(collection, journal.locale, journal.sourceKey));
	return rowOf(ctx, "reverted", warnings.length ? { warnings } : {});
}

/** The links of the pre-image as an update writes them; missing targets are left out and warned. */
async function restoredLinks(
	ctx: RowCtx,
	entry: Found,
	links: NonNullable<JournalBefore["links"]>,
	warnings: RecordError[],
): Promise<LinkWrites> {
	const { deps, job, journal, cache } = ctx;
	const writes: LinkWrites = {};
	const missing = (field: string, what: string) =>
		warnings.push(
			issue(
				"rollback_link_missing",
				`Left out: ${what} no longer exists, so the entry does not get it back`,
				field,
			),
		);
	for (const [taxonomy, groups] of Object.entries(links.taxonomies ?? {})) {
		await loadTerms(deps, cache, taxonomy, journal.locale);
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = groups.flatMap((group) => {
			const term = termOfGroup(cache, taxonomy, group);
			if (term) return [term.slug];
			missing(`taxonomies.${taxonomy}`, `the term ${group}`);
			return [];
		});
	}
	for (const [field, ids] of Object.entries(links.references ?? {})) {
		const target = job.targetFields?.[field]?.targetCollection ?? journal.collection;
		const kept: string[] = [];
		// An ID the entry still holds exists; only the others are looked up.
		const held = new Set((entry.references?.[field] ?? []).map((r) => r.id));
		for (const id of ids) {
			if (held.has(id)) {
				kept.push(id);
				continue;
			}
			cache.spend(COST_READ);
			if (await deps.lookups.findEntry(target, "id", id, journal.locale)) kept.push(id);
			else missing(field, `the entry ${id}`);
		}
		writes.references ??= {};
		writes.references[field] = kept;
	}
	if (links.bylines) {
		const known = await bylineIdsOf(deps, cache, journal.locale);
		writes.bylines = links.bylines.filter((b) => {
			if (known === null || known.has(b.bylineId)) return true;
			missing("bylines", `the byline ${b.bylineId}`);
			return false;
		});
	}
	return writes;
}

/** What a dry run plans for a changed entry: each value it would get back. */
async function plannedChanges(
	ctx: RowCtx,
	entry: Found,
	before: JournalBefore,
	links: LinkWrites,
): Promise<Change[]> {
	const changes: Change[] = [];
	const add = (field: string, now: unknown, back: unknown) => {
		if (!sameStored(now, back))
			changes.push({ field, before: now ?? null, after: (back ?? null) as never });
	};
	if (before.slug !== undefined) add("slug", entry.slug, before.slug);
	for (const [field, value] of Object.entries(before.live)) {
		add(field, (entry.live ?? entry.data)[field], value);
	}
	for (const [field, value] of Object.entries(before.draft ?? {})) {
		add(`draft.${field}`, entry.data[field], value);
	}
	if (links.taxonomies) {
		ctx.cache.spend(COST_CALL);
		const assigned = await ctx.deps.lookups.entryTerms(ctx.journal.collection, entry.id);
		for (const [taxonomy, slugs] of Object.entries(links.taxonomies)) {
			const now = (assigned[taxonomy] ?? []).map(
				(g) => termOfGroup(ctx.cache, taxonomy, g)?.slug ?? g,
			);
			add(`taxonomies.${taxonomy}`, now.length ? now : null, slugs.length ? slugs : null);
		}
	}
	for (const [field, ids] of Object.entries(links.references ?? {})) {
		const now = (entry.references?.[field] ?? []).map((r) => r.id);
		add(field, now.length ? now : null, ids.length ? ids : null);
	}
	if (links.bylines) {
		const now = (entry.bylines ?? []).map((b) => b.id);
		const back = links.bylines.map((b) => b.bylineId);
		add("bylines", now.length ? now : null, back.length ? back : null);
	}
	add("status", entry.status, before.status);
	add("scheduledAt", entry.scheduledAt, before.scheduledAt);
	return changes;
}

/**
 * Whether the entry shows what revert steps 1 to `step` would have left it with (spec M5a "Per
 * row", resuming). Cumulative, so an editor's change made after the stop is never adopted: every
 * step needs step 1's result (the restored live values, the slug the read shows, the references,
 * bylines and terms), steps 5 to 7 also the restored draft values, and each step its own
 * result: 2 published without a draft, 3 not published, 4 no draft, 6 the schedule, 7 (M5b) no
 * schedule.
 */
async function reached(
	ctx: RowCtx,
	step: number,
	entry: Found,
	before: JournalBefore,
	links: LinkWrites,
): Promise<boolean> {
	const same = (a: readonly string[], b: readonly string[]) =>
		JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
	const ids = (list: readonly { id: string }[] | undefined) => (list ?? []).map((r) => r.id);
	// Step 1 stages the live values in a draft on a revisioned collection; once a later step has
	// published them they are the live ones, under any draft steps 3 and 5 leave.
	const live = step === 1 ? entry.data : (entry.live ?? entry.data);
	const fieldsMatch = (values: Readonly<Record<string, unknown>>, from: Record<string, unknown>) =>
		Object.entries(values).every(([field, value]) => sameStored(from[field], value));
	if (!fieldsMatch(before.live, live)) return false;
	// A staged slug is in the draft, which the read does not show (spec F5).
	if (before.slug !== undefined && !entry.hasDraft && entry.slug !== before.slug) return false;
	for (const [field, want] of Object.entries(links.references ?? {})) {
		if (JSON.stringify(ids(entry.references?.[field])) !== JSON.stringify(want)) return false;
	}
	if (
		links.bylines !== undefined &&
		JSON.stringify(ids(entry.bylines)) !== JSON.stringify(links.bylines.map((b) => b.bylineId))
	) {
		return false;
	}
	if (links.taxonomies !== undefined) {
		ctx.cache.spend(COST_READ);
		const assigned = await ctx.deps.lookups.entryTerms(ctx.journal.collection, entry.id);
		for (const [taxonomy, slugs] of Object.entries(links.taxonomies)) {
			const now = (assigned[taxonomy] ?? []).map(
				(g) => termOfGroup(ctx.cache, taxonomy, g)?.slug ?? g,
			);
			if (!same(now, slugs)) return false;
		}
	}
	if (step >= 5 && !fieldsMatch(before.draft ?? {}, entry.data)) return false;
	// Nothing of the import's or this rollback's is in a draft but what the journal holds: any
	// other field whose draft and live values differ is someone else's edit (final review I1).
	if (before.draft === undefined && entry.live !== undefined) {
		const current = entry.live;
		const fields = new Set([...Object.keys(entry.data), ...Object.keys(current)]);
		fields.delete(SOURCE_ID_FIELD);
		for (const field of fields) {
			if (Object.hasOwn(before.live, field)) continue;
			if (!sameStored(entry.data[field], current[field])) return false;
		}
	}
	switch (step) {
		case 1:
		case 5:
			return true;
		case 2:
			return entry.status === "published" && !entry.hasDraft;
		case 3:
			return entry.status !== "published";
		case 4:
			return !entry.hasDraft;
		case 6:
			return (
				before.scheduledAt !== null &&
				entry.scheduledAt !== null &&
				Date.parse(entry.scheduledAt) === Date.parse(before.scheduledAt)
			);
		case 7:
			return entry.scheduledAt === null;
		default:
			return false;
	}
}

/**
 * The row of a revert step EmDash refused: a conflict is `rollback_changed` with `changed` (or the
 * translation-slot message), a lock `locked`, anything else `rollback_blocked` naming the step.
 */
function stepFailure(ctx: RowCtx, failed: StepFailure, name: string, changed: string): RowFields {
	switch (failed.reason) {
		case "conflict":
			return rowOf(ctx, "conflict", {
				errors: [
					issue(
						"rollback_changed",
						failed.message === TRANSLATION_SLOT_TAKEN ? SLOT_TAKEN_MESSAGE : changed,
					),
				],
			});
		// An editor opened the entry between two steps: left, with the step reached, for a retry.
		case "locked":
			return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
		default:
			return rowOf(ctx, "failed", {
				errors: [
					issue(
						"rollback_blocked",
						`Not rolled back: a plugin refused the ${name}: ${failed.message}`,
					),
				],
			});
	}
}

/**
 * "Revert sequence": 1 restore the live values, slug and links; 2 publish; 3 unpublish; 4 discard
 * the draft the entry did not have; 5 restore the draft; 6 schedule; 7 unschedule (M5b: a
 * schedule the entry did not have, or one that has passed). Each step is chosen from the entry's
 * state after the previous one and saved with the revision it returned, so a resumed row skips
 * the steps done and re-derives the rest.
 */
async function restoreChanged(
	ctx: RowCtx,
	entry: Found,
	link: LinkRow | null,
	pending: number | undefined,
	jobSchedule: string | undefined,
): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection, locale } = journal;
	const before = journal.before;
	ctx.action = "revert";
	if (before === undefined || entry.trashed) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
	}
	if (before.uncertain) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", UNCERTAIN_MESSAGE)] });
	}
	const resumedAt = ctx.written?.step ?? 0;
	// Term edits leave `_rev` alone, so ownership cannot see them: the terms must still be those the
	// job wrote. Not once step 1 was sent, which changed them itself.
	const wrote = journal.wrote?.taxonomies;
	if (wrote && resumedAt === 0 && pending === undefined) {
		ctx.cache.spend(COST_READ);
		const assigned = await deps.lookups.entryTerms(collection, entry.id);
		const sorted = (groups: readonly string[]) => JSON.stringify([...groups].sort());
		const moved = Object.entries(wrote).some(
			([taxonomy, groups]) => sorted(assigned[taxonomy] ?? []) !== sorted(groups),
		);
		if (moved) {
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TERMS_CHANGED_MESSAGE)] });
		}
	}
	// EmDash refuses an empty required field, so the restore would stop half way: refuse it first.
	const emptied = [
		...(resumedAt < 1 ? Object.entries(before.live) : []),
		...(resumedAt < 5 ? Object.entries(before.draft ?? {}) : []),
	]
		.filter(
			([field, value]) => (value ?? null) === null && job.targetFields?.[field]?.required === true,
		)
		.map(([field]) => field);
	if (emptied.length > 0) {
		return rowOf(ctx, "failed", {
			errors: [...new Set(emptied)].map((field) => issue("required", REQUIRED_MESSAGE, field)),
		});
	}
	// Once step 1 was sent, its links and their warnings are the row's: they are not derived again
	// (a target may have come back since), except to check a lost step 1 below.
	const sentLinks = resumedAt >= 1 || (pending ?? 0) >= 1;
	let links: LinkWrites = {};
	if (sentLinks) {
		ctx.warnings.push(
			...(ctx.existing?.warnings ?? []).filter((w) => w.code === "rollback_link_missing"),
		);
		// Only to check a lost step (`reached`); the warnings are the saved ones.
		if (pending !== undefined && before.links) {
			links = await restoredLinks(ctx, entry, before.links, []);
		}
	} else if (before.links) {
		links = await restoredLinks(ctx, entry, before.links, ctx.warnings);
	}
	const passed =
		before.scheduledAt !== null && !(Date.parse(before.scheduledAt) > deps.now())
			? [
					issue(
						"rollback_schedule_passed",
						`The entry was scheduled for ${before.scheduledAt}, which has passed; it is left as a draft`,
					),
				]
			: [];
	ctx.warnings.push(...passed);
	// The import published a pending draft over live references it could not read (spec "Open
	// issues"). An entry never published had no live selection, so the read one is all it had.
	if (before.referencesUnknown && before.status === "published") {
		ctx.warnings.push(issue("references_not_restored", REFERENCES_UNKNOWN_MESSAGE));
	}
	if (job.dryRun) {
		return rowOf(ctx, "planned", { changes: await plannedChanges(ctx, entry, before, links) });
	}
	if (pending !== undefined) {
		if (!(await reached(ctx, pending, entry, before, links))) {
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
		}
		ctx.written = { rev: entry.rev, step: pending };
	}
	let state: EntryState = {
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		hasDraft: entry.hasDraft,
	};
	let done = ctx.written?.step ?? 0;
	ctx.written = { rev: state.rev, step: done };
	const writing = (extra: Partial<RowFields> = {}) =>
		ctx.save(
			rowOf(ctx, "writing", {
				...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
				...extra,
			}),
		);
	const run = async (
		step: number,
		input: { step: RevertStep } & Partial<Parameters<EngineDeps["content"]["revertStep"]>[0]>,
	): Promise<StepFailure | null> => {
		if (done >= step) return null;
		// One save per step, before it: the step done last and its revision, and this step as sent.
		// A crash after EmDash applied it leaves the entry past `writtenRev`, and the resumed row
		// tells this step's result from someone else's change (`reached`). Nothing runs between a
		// step's return and the next save, so a save after each step would add nothing.
		await writing({ pendingStep: step });
		ctx.cache.spend(STEP_COST[input.step]);
		const result = await deps.content.revertStep({
			...input,
			collection,
			locale,
			id: entry.id,
			rev: state.rev,
		});
		if (!result.ok) return result;
		state = result.state;
		done = step;
		ctx.written = { rev: state.rev, step };
		return null;
	};
	const hasLive = Object.keys(before.live).length > 0;
	const steps: (() => Promise<StepFailure | null>)[] = [
		async () =>
			hasLive || before.slug !== undefined || before.links !== undefined
				? run(1, {
						step: "update",
						...(hasLive ? { data: restoredData(before.live, job.targetFields) } : {}),
						...(before.slug === undefined ? {} : { slug: before.slug }),
						...links,
					})
				: null,
		async () => {
			const publish =
				before.status === "published"
					? state.status !== "published" || state.hasDraft
					: state.status === "published" && state.hasDraft;
			return publish ? run(2, { step: "publish" }) : null;
		},
		async () =>
			before.status !== "published" && state.status === "published"
				? run(3, { step: "unpublish" })
				: null,
		async () => (before.draft === undefined && state.hasDraft ? run(4, { step: "discard" }) : null),
		async () =>
			before.draft !== undefined && Object.keys(before.draft).length > 0
				? run(5, { step: "update", data: restoredData(before.draft, job.targetFields) })
				: null,
		async () => {
			const at = before.scheduledAt;
			if (at === null || passed.length > 0) return null;
			const same = state.scheduledAt !== null && Date.parse(state.scheduledAt) === Date.parse(at);
			return same ? null : run(6, { step: "schedule", scheduledAt: at });
		},
		// Step 2's publish already cleared a schedule (F4); step 6 excludes this one. Only a
		// schedule the import set is removed: the job's, or the pre-image's that has passed. Any
		// other is someone else's, set after a stop (review I2).
		async (): Promise<StepFailure | null> => {
			if (state.scheduledAt === null || (before.scheduledAt !== null && passed.length === 0)) {
				return null;
			}
			const ours =
				(jobSchedule !== undefined && sameInstant(state.scheduledAt, jobSchedule)) ||
				(passed.length > 0 && sameInstant(state.scheduledAt, before.scheduledAt));
			if (!ours) return { ok: false, reason: "conflict", message: "not the import's schedule" };
			return run(7, { step: "unschedule" });
		},
	];
	const names = ["update", "publish", "unpublish", "discard", "update", "schedule", "unschedule"];
	for (const [i, next] of steps.entries()) {
		const failed = await next();
		if (failed === null) continue;
		// Steps 1-7 never restore from Trash, so their conflicts are never the translation slot.
		return stepFailure(ctx, failed, names[i] ?? "step", CHANGED_MESSAGE);
	}
	// Saved before the link moves, so a stop after the link put still resumes this row: its entry
	// is at `writtenRev`, which the link no longer names for the original job.
	await writing();
	await handBack(ctx, entry.id, before, state, link);
	return rowOf(ctx, "reverted");
}

/**
 * The link goes back to the job before, at the rollback's revision, so that job's rollback and
 * the next import see the entry as that job left it. M5c: with the mark it had (none, for a link
 * the missing phase acted on), and with its owner stamp only while `current`, the link it
 * replaces, still carries that owner (spec Ruling 31): a stamp another owner's record dropped
 * since stays dropped, so the owner's next run never removes an entry that feed holds.
 */
async function handBack(
	ctx: RowCtx,
	entryId: string,
	before: JournalBefore,
	state: EntryState,
	current: LinkRow | null,
): Promise<void> {
	const { deps, journal } = ctx;
	const { collection, locale } = journal;
	const id = linkKey(collection, locale, journal.sourceKey);
	const linked = current?.entryId === entryId;
	if (before.link === null) {
		if (linked) await deps.links.delete(id);
		return;
	}
	// Only when the entry was as that job left it: an editor's change in between stays one.
	const moved =
		before.link.writtenRev !== undefined &&
		before.rev !== undefined &&
		before.rev === before.link.writtenRev;
	// At the rollback's revision the link records the schedule the entry is left with: the
	// earlier job's only while the entry is still scheduled for that time (review I1). A
	// schedule step 7 removed, or one that passed, would let the earlier job's rollback take
	// an editor's later publish for the scheduler's.
	const scheduledAt = moved
		? sameInstant(state.scheduledAt, before.link.scheduledAt ?? null)
			? before.link.scheduledAt
			: undefined
		: before.link.scheduledAt;
	// M5b: the fingerprints describe the entry at that job's revision, not at the rollback's, so
	// a link moved to the rollback's revision vouches for none of them (Task 5 review, P5).
	const unconfirmed = moved
		? [...new Set([...(before.link.unconfirmed ?? []), ...Object.keys(before.link.fields ?? {})])]
		: (before.link.unconfirmed ?? []);
	const kept = linked && current?.owner === before.link.owner;
	await deps.links.put(id, {
		collection,
		locale,
		sourceKey: journal.sourceKey,
		entryId,
		...(before.link.writtenRev === undefined
			? {}
			: { writtenRev: moved ? state.rev : before.link.writtenRev }),
		...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
		// M5b: the fingerprints and schedule the link had before the job.
		...(before.link.fields === undefined ? {} : { fields: before.link.fields }),
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
		...(scheduledAt === undefined ? {} : { scheduledAt }),
		// M5c: the owner the link had, while the link still carries it, and its mark.
		...(kept && before.link.owner !== undefined ? { owner: before.link.owner } : {}),
		...(kept && before.link.ownerSource !== undefined
			? { ownerSource: before.link.ownerSource }
			: {}),
		...(before.link.missing === undefined ? {} : { missing: before.link.missing }),
	});
}

/**
 * Whether a restore step sent before a stop shows its result (spec M5c "Rollback", V1): step 8
 * an active draft without a schedule one version past the revision it was sent at; step 9 a
 * published entry without a draft, one version on again.
 */
function reachedTrash(step: number, entry: Found, sentAt: string): boolean {
	const now = decodeRev(entry.rev);
	const was = decodeRev(sentAt);
	if (now === null || was === null || entry.trashed || now.version !== was.version + 1) {
		return false;
	}
	if (step === 8) return entry.status === "draft" && entry.scheduledAt === null;
	return step === 9 && entry.status === "published" && !entry.hasDraft;
}

/**
 * Steps 8 and 9 (spec M5c "Rollback"): the entry the missing phase moved to Trash is restored,
 * then published when it was published before. Owned while it is in Trash at the revision the
 * phase left (Trash keeps `_rev`, spec F1) and its link carries this job's mark, or while the row
 * is this rollback's own.
 */
async function restoreTrashed(ctx: RowCtx, entry: Found | null): Promise<RowFields> {
	const { deps, job, journal, existing } = ctx;
	const { collection, locale } = journal;
	const before = journal.before;
	ctx.action = "restore";
	if (entry === null) {
		// Emptied from Trash or deleted for good: there is nothing left to restore.
		return rowOf(ctx, "unchanged", { warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)] });
	}
	ctx.entryId = entry.id;
	if (before === undefined) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TRASH_CHANGED_MESSAGE)] });
	}
	const linkId = linkKey(collection, locale, journal.sourceKey);
	const link = await deps.links.get(linkId);
	const marked =
		link !== null &&
		link.entryId === entry.id &&
		link.jobId === job.rollbackOf &&
		link.missing?.jobId === job.rollbackOf;
	const resumed =
		existing?.step !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev === entry.rev;
	// A step sent before a stop whose row save was lost: adopted only when it shows its result.
	const pending =
		!resumed &&
		existing?.status === "writing" &&
		existing.pendingStep !== undefined &&
		existing.entryId === entry.id &&
		existing.writtenRev !== undefined &&
		reachedTrash(existing.pendingStep, entry, existing.writtenRev)
			? existing.pendingStep
			: undefined;
	const ownTrash =
		entry.trashed &&
		link !== null &&
		marked &&
		link.writtenRev === entry.rev &&
		entry.rev === before.rev;
	if (!resumed && pending === undefined && !ownTrash) {
		// Spec step 2: active and as the pre-image read it, so the trash never ran (a stop before
		// the journal row's deletion).
		const sameLink =
			link === null
				? before.link === null
				: before.link !== null &&
					link.jobId === before.link.jobId &&
					link.writtenRev === before.link.writtenRev;
		if (!entry.trashed && entry.rev === before.rev && sameLink) {
			return rowOf(ctx, "unchanged", {
				warnings: [issue("nothing_to_roll_back", NOTHING_MESSAGE)],
			});
		}
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", TRASH_CHANGED_MESSAGE)] });
	}
	if (await deps.content.isLocked(collection, locale, entry.id)) {
		return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	if (job.dryRun) {
		return rowOf(ctx, "planned", {
			changes: [{ field: "status", before: "trashed", after: before.status }],
		});
	}
	let state: EntryState = {
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		hasDraft: entry.hasDraft,
	};
	let done = pending ?? (resumed ? (existing?.step ?? 0) : 0);
	ctx.written = { rev: state.rev, step: done };
	const run = async (step: 8 | 9, revert: "restore" | "publish"): Promise<RowFields | null> => {
		if (done >= step) return null;
		// Saved before the call, as the M5a steps: a stop after EmDash applied it resumes by
		// `reachedTrash`.
		await ctx.save(rowOf(ctx, "writing", { pendingStep: step }));
		ctx.cache.spend(STEP_COST[revert]);
		const result = await deps.content.revertStep({
			collection,
			locale,
			id: entry.id,
			rev: state.rev,
			step: revert,
		});
		if (result.ok) {
			state = result.state;
			done = step;
			ctx.written = { rev: state.rev, step };
			return null;
		}
		return stepFailure(ctx, result, revert, TRASH_CHANGED_MESSAGE);
	};
	const restored = await run(8, "restore");
	if (restored) return restored;
	if (before.status === "published") {
		const published = await run(9, "publish");
		if (published) return published;
	}
	// Saved before the link moves, as `restoreChanged` does.
	await ctx.save(rowOf(ctx, "writing"));
	await handBack(ctx, entry.id, before, state, link);
	return rowOf(ctx, "reverted");
}
