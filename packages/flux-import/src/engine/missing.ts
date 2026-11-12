/**
 * The missing phase (spec M5c "The missing phase"). After a completed first pass, the owner's
 * entries that no record of the job had are first counted against the threshold, then moved to
 * Trash or unpublished. Each change is journalled before it is made, so `jobs/rollback` undoes
 * it. A dry run plans the same rows and changes nothing.
 */
import { counterFor } from "./counters.js";
import { linkBefore } from "./journal.js";
import { ownerOf } from "./owner.js";
import { ContentWriteError, type EntrySnapshot, JOB_LEVEL_WRITE_ERRORS } from "./ports.js";
import { COST_CALL, COST_READ, LookupCache } from "./resolve.js";
import { decodeRev } from "./revs.js";
import { holdsScheduled, sweptSince } from "./rules.js";
import {
	bump,
	type EngineDeps,
	type Job,
	type JournalEntry,
	journalKey,
	type LinkRow,
	linkKey,
	type MissingAction,
	type MissingState,
	type RecordError,
	type RecordRow,
	recordKey,
} from "./types.js";

type Outcome = { done: boolean };
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

/** Keys per seen query: D1 binds at most 100 parameters a query (spec F13). */
export const MISSING_PAGE = 50;
/** Links per query: the plugin storage maximum (spec F10). */
const LINK_PAGE = 100;
/** A trash and an unpublish cost what a rollback's do (`COST_DELETE`, `STEP_COST.unpublish`). */
const COST_TRASH = COST_READ * 5;
const COST_UNPUBLISH = 15;
/** What one decided entry may cost the act stage: two reads, six storage calls and a trash. */
const ACT_RESERVE = COST_READ * 2 + COST_CALL * 6 + COST_TRASH;

/** The messages of the `unchanged` missing rows (spec "Verdicts", "Act stage"), by code. */
export const MISSING_MESSAGES = {
	missing_gone: "Nothing to do: the entry no longer exists or is in Trash",
	missing_edited:
		"Left alone: the entry changed after the import last wrote it (an editor or another process)",
	missing_pending: "Left alone: the entry has a draft or a schedule that is not live",
	missing_not_live: "Nothing to do: the entry is not published",
	missing_has_translations: "Left alone: the entry has translations that are still active",
	missing_over_count:
		"Left alone: more entries were missing than when the import counted them; run the import again",
} as const;
export type MissingCode = keyof typeof MISSING_MESSAGES;

const LOCKED_MESSAGE = "Not changed: the entry is being edited (locked)";
const CHANGED_MESSAGE = "Not changed: the entry changed since it was read";
export const UNVERIFIED_MESSAGE =
	"Maybe changed: the import stopped while changing this entry and cannot tell whether someone changed it since";
const blockedMessage = (message: string) => `Not changed: a plugin refused: ${message}`;

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

/** The ULID form (`ulidx`): 10 characters of milliseconds, then 16 of randomness. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Whether a link's job was created after this one (spec Ruling 11, plan Ruling 1): its ID sorts
 * after this job's, or both are ULIDs of the same millisecond, which `ulid()` does not order
 * (plan Fact V6). Such a link is not this job's to judge.
 */
export function laterJob(linkJob: string | undefined, jobId: string): boolean {
	if (linkJob === undefined || linkJob === jobId) return false;
	if (linkJob > jobId) return true;
	return ULID.test(linkJob) && ULID.test(jobId) && linkJob.slice(0, 10) === jobId.slice(0, 10);
}

/** A link the phase counts and may act on: not marked, and not written by a later job. */
export function isCandidate(link: LinkRow, job: Job): boolean {
	return link.missing === undefined && !laterJob(link.jobId, job.id);
}

function skip(job: Job, fromSeq: number, warning: string): Outcome {
	job.missing = {
		stage: "done",
		fromSeq,
		owned: 0,
		found: 0,
		rows: 0,
		removed: 0,
		verdict: "skipped",
	};
	job.warnings = [...(job.warnings ?? []), warning];
	return { done: true };
}

/**
 * After a completed first pass (spec "When it runs"): enters the phase when the job has a
 * threshold, every first-pass record had a readable key, and at least one had a key. Otherwise
 * the job completes now, with a warning when the phase was skipped.
 */
export function enterMissing(job: Job): Outcome {
	if (job.missingLimit === undefined || job.missingLimit === false) return { done: true };
	const fromSeq = job.cursor.seq;
	const unkeyed = job.unkeyed ?? 0;
	if (unkeyed > 0) {
		return skip(
			job,
			fromSeq,
			`Missing entries were not checked: ${unkeyed} records had no readable key (or were skipped by the reader), so their entries may be in the feed`,
		);
	}
	const c = job.counters;
	if (c.created + c.updated + c.unchanged + c.locked + c.conflict + c.failed <= unkeyed) {
		return skip(
			job,
			fromSeq,
			"Missing entries were not checked: the import read no record with a key",
		);
	}
	job.phase = "missing";
	job.missing = { stage: "count", fromSeq, owned: 0, found: 0, rows: 0, removed: 0 };
	return { done: false };
}

/** One batch of the phase: a count batch or an act batch. */
export async function missingPass(
	deps: EngineDeps,
	job: Job,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const m = job.missing;
	if (m === undefined || m.stage === "done") return { done: true };
	return m.stage === "count"
		? countStage(deps, job, m, started, limit, cache)
		: actStage(deps, job, m, started, limit, cache);
}

/** One page of the owner's links in the template's collection and locale (spec "Candidates"). */
function linkPage(
	deps: EngineDeps,
	job: Job,
	cursor: string | undefined,
	limit: number,
	cache: LookupCache,
) {
	const { collection, locale } = job.template;
	cache.spend(COST_CALL);
	return deps.links.query({
		where: { owner: ownerOf(job), collection, locale },
		limit,
		...(cursor === undefined ? {} : { cursor }),
	});
}

/**
 * Whether the batch takes another page of `size` links after its first (spec "Bounded work"):
 * the batch's limit leaves room for one, and the budget covers the page's links query and seen
 * queries plus `each` for every link on it. A batch always takes its first page, whatever it
 * finds, so the phase moves on; a seen candidate costs no read, so without the queries' cost a
 * spent budget would not stop the paging.
 */
function fits(cache: LookupCache, size: number, each: number): boolean {
	if (size <= 0) return false;
	const queries = COST_CALL * (1 + Math.ceil(size / MISSING_PAGE));
	return cache.budget - cache.spent >= queries + each * size;
}

type Seen = {
	/** A first-pass row of the job has the key: the entry is in the feed. */
	imported: boolean;
	/** This phase's latest row for the key (crash repair, Task 5); null when none. */
	own: RecordRow | null;
};

/** The job's rows with the candidates' keys, `MISSING_PAGE` keys a query (spec "Candidates"). */
async function seenOf(
	deps: EngineDeps,
	job: Job,
	fromSeq: number,
	keys: readonly string[],
	cache: LookupCache,
): Promise<Map<string, Seen>> {
	const out = new Map<string, Seen>();
	for (let i = 0; i < keys.length; i += MISSING_PAGE) {
		const chunk = keys.slice(i, i + MISSING_PAGE);
		let cursor: string | undefined;
		do {
			cache.spend(COST_CALL);
			const page = await deps.records.query({
				where: { jobId: job.id, sourceKey: { in: chunk } },
				limit: LINK_PAGE,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const { data } of page.items) {
				if (data.sourceKey === null) continue;
				const seen = out.get(data.sourceKey) ?? { imported: false, own: null };
				if (data.seq < fromSeq) seen.imported = true;
				else if (seen.own === null || data.seq > seen.own.seq) seen.own = data;
				out.set(data.sourceKey, seen);
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
	}
	return out;
}

/**
 * The count stage (spec "Count stage"): pages the owner's links, tallies the candidates
 * (`owned`) and the unseen ones whose entry exists (`found`), one `content.get` each (plan
 * Ruling 3), whole pages only (plan Ruling 4). Refuses as a whole on a candidate from another
 * URL source (Ruling 27); at the end, applies the threshold.
 */
async function countStage(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const { collection, locale } = job.template;
	let reads = 0;
	let paged = false;
	for (;;) {
		const size = Math.min(LINK_PAGE, limit - reads);
		if (paged && !fits(cache, size, COST_READ)) return { done: false };
		const page = await linkPage(deps, job, m.cursor, Math.max(1, size), cache);
		paged = true;
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		const foreign = candidates.find(
			(link) => link.ownerSource !== undefined && link.ownerSource !== job.sourceId,
		);
		if (foreign?.ownerSource !== undefined) {
			delete m.cursor;
			m.stage = "done";
			m.verdict = "refused";
			job.warnings = [
				...(job.warnings ?? []),
				`Missing entries were left alone: owner ${ownerOf(job)} also has entries created from another URL source (${foreign.ownerSource}); give each feed its own owner`,
			];
			return { done: true };
		}
		const seen = await seenOf(
			deps,
			job,
			m.fromSeq,
			candidates.map((l) => l.sourceKey),
			cache,
		);
		// The page's tallies reach the job only with its cursor (spec "Crash repair"): an error
		// part way saves neither, so the page is counted again, once.
		let found = 0;
		for (const link of candidates) {
			if (seen.get(link.sourceKey)?.imported) continue;
			cache.spend(COST_READ);
			reads++;
			if ((await deps.content.get(collection, locale, link.entryId)) !== null) found++;
		}
		m.owned += candidates.length;
		m.found += found;
		if (!page.hasMore || page.cursor === undefined) return { done: finishCount(job, m) };
		m.cursor = page.cursor;
		if (deps.now() - started >= job.budgetMs) return { done: false };
	}
}

/**
 * The threshold (spec "Count stage", Rulings 22, 23, 29 M4): refused when `found × 100 >
 * maxPercent × base`, `base` the candidates less this job's creates (a dry run's creates made no
 * links). A real refusal ends the phase; a dry run still plans the rows (Ruling 16). Returns
 * whether the job is done.
 */
function finishCount(job: Job, m: MissingState): boolean {
	delete m.cursor;
	if (m.found === 0) {
		m.stage = "done";
		m.verdict = "act";
		return true;
	}
	const maxPercent =
		job.missingLimit === false || job.missingLimit === undefined ? 0 : job.missingLimit.maxPercent;
	const base = job.dryRun ? m.owned : m.owned - job.counters.created;
	if (m.found * 100 > maxPercent * base) {
		const p = base > 0 ? Math.ceil((m.found * 100) / base) : 100;
		const owner = ownerOf(job);
		const what = `${m.found} of the ${base} entries owner ${owner} created before this import are not in the feed (${p}%), more than the limit of ${maxPercent}%`;
		const how = `Check the feed, then import it again with the job option missing: { maxPercent: ${p} } to apply it (with force: true for an unchanged URL source).`;
		job.warnings = [
			...(job.warnings ?? []),
			job.dryRun
				? `Missing entries: ${what}, so a real run would leave them alone. ${how}`
				: `Missing entries were left alone: ${what}. ${how}`,
		];
		m.verdict = "refused";
		if (!job.dryRun) {
			m.stage = "done";
			return true;
		}
	} else {
		m.verdict = "act";
	}
	m.stage = "act";
	return false;
}

/** What the act stage needs about the job and the link it decides. */
type ActCtx = {
	deps: EngineDeps;
	job: Job;
	m: MissingState;
	link: LinkRow;
	action: MissingAction;
	cache: LookupCache;
};

/**
 * The act stage (spec "Act stage"): pages the candidates again and decides each unseen one
 * again, one row each after the import's rows, at most `limit` a batch, whole pages only.
 */
async function actStage(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const action = actionOf(job);
	let decided = await repair(deps, job, m, cache, true);
	let seq = m.fromSeq + m.rows;
	let paged = false;
	for (;;) {
		const size = Math.min(LINK_PAGE, limit - decided);
		if (paged && !fits(cache, size, ACT_RESERVE)) return { done: false };
		const page = await linkPage(deps, job, m.cursor, Math.max(1, size), cache);
		paged = true;
		const candidates = page.items.map((i) => i.data).filter((link) => isCandidate(link, job));
		const seen = await seenOf(
			deps,
			job,
			m.fromSeq,
			candidates.map((l) => l.sourceKey),
			cache,
		);
		for (const link of candidates) {
			const s = seen.get(link.sourceKey);
			if (s?.imported) continue;
			// A row this phase already decided; `repair` settled a `writing` one.
			if (s?.own) continue;
			await decideNew({ deps, job, m, link, action, cache }, seq);
			seq++;
			m.rows++;
			decided++;
		}
		if (!page.hasMore || page.cursor === undefined) {
			delete m.cursor;
			m.stage = "done";
			return { done: true };
		}
		m.cursor = page.cursor;
		if (deps.now() - started >= job.budgetMs) return { done: false };
	}
}

function actionOf(job: Job): MissingAction {
	const action = job.template.rules?.missing?.action;
	if (action === undefined) throw new Error(`Job ${job.id} has no rules.missing`);
	return action;
}

/**
 * The rows a stopped batch saved past the saved `rows` (spec "Crash repair", Ruling 29 M1): its
 * release was lost, so they are counted here, on the job's counters and on `removed`, and the
 * next seq follows the last of them, so none is overwritten. A `writing` row among them is
 * settled (`settleWriting`); with `restart`, one whose call did not land is decided again at its
 * seq. Returns how many `writing` rows it settled.
 */
async function repair(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	cache: LookupCache,
	restart: boolean,
): Promise<number> {
	let settled = 0;
	let cursor: string | undefined;
	do {
		cache.spend(COST_CALL);
		const page = await deps.records.query({
			where: { jobId: job.id, seq: { gte: m.fromSeq + m.rows } },
			orderBy: { seq: "asc" },
			limit: LINK_PAGE,
			...(cursor === undefined ? {} : { cursor }),
		});
		for (const { data: row } of page.items) {
			if (row.status === "writing") {
				// Without `restart`, a row left `writing` stays past `rows`, for a resume to settle.
				if (!(await settleWriting(deps, job, m, row, cache, restart)) && !restart) return settled;
				settled++;
			} else tally(job, m, row);
			m.rows = Math.max(m.rows, row.seq + 1 - m.fromSeq);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return settled;
}

/**
 * A `writing` row a stopped batch left (spec "Crash repair"). Its link already carries this job's
 * mark: the row becomes `removed`. Its call landed: finished at step 5, once. The entry moved and
 * the call may have landed: `missing_unverified`, and its journal row stays. The call did not
 * land: with `restart`, its journal row is deleted and the entry decided again at the same seq
 * (plan Ruling 14); without, the row is left for a resume. Returns whether the row was settled.
 */
async function settleWriting(
	deps: EngineDeps,
	job: Job,
	m: MissingState,
	row: RecordRow,
	cache: LookupCache,
	restart: boolean,
): Promise<boolean> {
	const { collection, locale } = job.template;
	if (row.sourceKey === null) return false;
	const key = linkKey(collection, locale, row.sourceKey);
	cache.spend(COST_CALL);
	const link = await deps.links.get(key);
	if (link === null) return false;
	const ctx: ActCtx = { deps, job, m, link, action: actionOf(job), cache };
	const save = saver(ctx, row.seq);
	let fields: RowFields | null;
	if (link.missing?.jobId === job.id) {
		// A stop after step 5's link put, before the row save.
		fields = rowOf(
			ctx,
			"removed",
			row.entryId,
			link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev },
		);
	} else {
		try {
			fields =
				row.entryId === null || row.writtenRev === undefined
					? null
					: await landed(ctx, row.entryId, row.writtenRev);
		} catch (e) {
			if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
			fields = unverified(ctx, row.entryId);
		}
	}
	if (fields !== null) {
		await save(fields);
		count(ctx, fields);
		return true;
	}
	if (!restart || !isCandidate(link, job)) return false;
	cache.spend(COST_CALL);
	await deps.journal.delete(journalKey(job.id, key));
	await decideNew(ctx, row.seq);
	return true;
}

/**
 * Whether a stopped call landed (spec "Crash repair"): its finished row, null when it did not
 * (the entry is active at the row's `writtenRev`, or active at all for a trash, plan Ruling 14),
 * or a `missing_unverified` row for any other state.
 */
async function landed(ctx: ActCtx, id: string, rev: string): Promise<RowFields | null> {
	const { deps, job, action, cache } = ctx;
	const { collection, locale } = job.template;
	cache.spend(COST_READ);
	const active = await deps.content.get(collection, locale, id);
	if (action === "trash") {
		if (active !== null) return null;
		// Plan Ruling 3: only here does the act stage look in Trash. Trash keeps `_rev` (spec F1).
		cache.spend(COST_READ);
		const trashed = await deps.content.getIncludingTrashed(collection, locale, id);
		return trashed?.trashed === true && trashed.rev === rev
			? finish(ctx, id, rev)
			: unverified(ctx, id);
	}
	if (active === null) return unverified(ctx, id);
	if (active.rev === rev) return null;
	// An unpublish moves the version on by one and leaves a draft without a schedule (spec V2, F7).
	const now = decodeRev(active.rev);
	const was = decodeRev(rev);
	const unpublished =
		now !== null &&
		was !== null &&
		now.version === was.version + 1 &&
		active.status !== "published" &&
		active.scheduledAt === null;
	return unpublished ? finish(ctx, id, active.rev) : unverified(ctx, id);
}

function unverified(ctx: ActCtx, id: string | null): RowFields {
	return rowOf(ctx, "conflict", id, {
		errors: [issue("missing_unverified", UNVERIFIED_MESSAGE)],
	});
}

/**
 * Before a stopped job ends, cancelled or failed, or is rolled back (spec "Crash repair",
 * Ruling 29 M3): counts the rows a lost release left out and settles their `writing` rows, so a
 * trash that landed always carries its marked link (the rollback's ownership test needs the
 * mark). Nothing is decided anew. Returns whether the job's counters or phase moved.
 */
export async function settleStopped(deps: EngineDeps, job: Job): Promise<boolean> {
	const m = job.missing;
	if (job.kind === "rollback" || job.dryRun || job.phase !== "missing" || m?.stage !== "act") {
		return false;
	}
	const rows = m.rows;
	await repair(deps, job, m, new LookupCache(), false);
	return m.rows !== rows;
}

/** Saves a missing row at `seq` (start and end 0: it reads no record). */
function saver(ctx: ActCtx, seq: number) {
	const { deps, job } = ctx;
	return (fields: RowFields) =>
		deps.records.put(recordKey(job.id, seq), {
			jobId: job.id,
			seq,
			start: 0,
			end: 0,
			...fields,
			updatedAt: iso(deps),
		});
}

function rowOf(
	ctx: ActCtx,
	status: RowFields["status"],
	entryId: string | null,
	extra: Partial<RowFields> = {},
): RowFields {
	return { status, sourceKey: ctx.link.sourceKey, entryId, action: ctx.action, ...extra };
}

function unchanged(ctx: ActCtx, entryId: string | null, code: MissingCode): RowFields {
	const { action: _action, ...row } = rowOf(ctx, "unchanged", entryId);
	return { ...row, warnings: [{ code, message: MISSING_MESSAGES[code] }] };
}

const issue = (code: string, message: string): RecordError => ({ code, message });

/** Counts a decided row on the job, and `removed` on the phase. */
function count(ctx: ActCtx, row: RowFields): void {
	tally(ctx.job, ctx.m, row);
}

function tally(job: Job, m: MissingState, row: Pick<RecordRow, "status" | "action">): void {
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
	if (counter === "removed") m.removed++;
}

/**
 * Whether the entry is as the importer left it (spec "Editor safety", Ruling 8): at the link's
 * `writtenRev`, or published by EmDash's scheduler from the importer's schedule since (M5b),
 * which the scheduling job's journal row must still show (spec F16).
 */
async function importerLeft(ctx: ActCtx, entry: EntrySnapshot): Promise<boolean> {
	const { deps, job, link, cache } = ctx;
	if (entry.rev === link.writtenRev) return true;
	if (link.scheduledAt === undefined || link.jobId === undefined || !sweptSince(link, entry)) {
		return false;
	}
	cache.spend(COST_READ);
	const { collection, locale } = job.template;
	const journal = await deps.journal.get(
		journalKey(link.jobId, linkKey(collection, locale, link.sourceKey)),
	);
	return holdsScheduled(job, journal?.wrote, link.scheduledAt, entry);
}

/** The verdict table of spec "Verdicts", in its order; `null` acts. */
async function verdictOf(ctx: ActCtx, entry: EntrySnapshot | null): Promise<MissingCode | null> {
	const { deps, job, action, cache } = ctx;
	if (entry === null) return "missing_gone";
	if (!(await importerLeft(ctx, entry))) return "missing_edited";
	if (entry.hasDraft || entry.scheduledAt !== null) return "missing_pending";
	if (action === "unpublish" && entry.status !== "published") return "missing_not_live";
	if (action === "trash" && (entry.group ?? entry.id) === entry.id) {
		cache.spend(COST_CALL);
		const group = await deps.content.translations(job.template.collection, entry.id);
		if (group.some((t) => t.id !== entry.id)) return "missing_has_translations";
	}
	return null;
}

/**
 * Decides a candidate the phase has no row for yet (or a stopped one starts over), and saves its
 * row at `seq`. A left-alone row of a real run deletes the journal row under its key (plan
 * Ruling 14): a batch that stopped between the journal put and the `writing` row left one, and
 * sent no call.
 */
async function decideNew(ctx: ActCtx, seq: number): Promise<void> {
	const { deps, job, m, link, action, cache } = ctx;
	const { collection, locale } = job.template;
	const save = saver(ctx, seq);
	let row: RowFields;
	try {
		cache.spend(COST_READ);
		const entry = await deps.content.get(collection, locale, link.entryId);
		const code = await verdictOf(ctx, entry);
		let left: RowFields | null = null;
		if (entry === null || code !== null) {
			left = unchanged(ctx, entry?.id ?? null, code ?? "missing_gone");
		} else if (m.removed >= m.found) left = unchanged(ctx, entry.id, "missing_over_count");
		if (left !== null) {
			if (!job.dryRun) await dropJournal(ctx);
			row = left;
		} else if (entry === null) {
			throw new Error("unreachable: an act verdict without an entry");
		} else if (job.dryRun) {
			row = rowOf(ctx, "planned", entry.id, {
				changes: [
					{
						field: "status",
						before: entry.status,
						after: action === "trash" ? "trashed" : "draft",
					},
				],
			});
		} else row = await act(ctx, entry, seq, save);
	} catch (e) {
		// A read or lock check failed (a failed call is `send`'s): EmDash's code, as an import row.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
		row = rowOf(ctx, "failed", link.entryId, { errors: [issue(e.code, e.message)] });
	}
	await save(row);
	count(ctx, row);
}

/**
 * A real run's act (spec "Act stage", steps 1-6): the lock, the journal row put if absent, the
 * `writing` row, the call, then the link with its mark.
 */
async function act(
	ctx: ActCtx,
	entry: EntrySnapshot,
	seq: number,
	save: (fields: RowFields) => Promise<void>,
): Promise<RowFields> {
	const { deps, job, link, action, cache } = ctx;
	const { collection, locale } = job.template;
	cache.spend(COST_CALL);
	if (await deps.content.isLocked(collection, locale, entry.id)) {
		await dropJournal(ctx);
		return rowOf(ctx, "locked", entry.id, { errors: [issue("locked", LOCKED_MESSAGE)] });
	}
	const key = journalKey(job.id, linkKey(collection, locale, link.sourceKey));
	const journal: JournalEntry = {
		jobId: job.id,
		seq,
		collection,
		locale,
		sourceKey: link.sourceKey,
		kind: action === "trash" ? "trash" : "update",
		entryId: entry.id,
		before: {
			link: linkBefore(link),
			rev: entry.rev,
			status: entry.status,
			scheduledAt: null,
			live: {},
		},
		at: iso(deps),
	};
	cache.spend(COST_CALL * 2);
	// A row an earlier, stopped attempt stored is this phase's own and is kept.
	await deps.journal.compareAndSet(key, null, journal);
	await save(rowOf(ctx, "writing", entry.id, { writtenRev: entry.rev }));
	return send(ctx, entry.id, entry.rev, key);
}

/** Deletes the journal row under the link's key: no call of this job's went out for it. */
async function dropJournal(ctx: ActCtx): Promise<void> {
	const { collection, locale } = ctx.job.template;
	ctx.cache.spend(COST_CALL);
	await ctx.deps.journal.delete(
		journalKey(ctx.job.id, linkKey(collection, locale, ctx.link.sourceKey)),
	);
}

/**
 * The call (step 4) and, when it landed, the link (step 5). A call that did not land deletes the
 * write-ahead journal row (Ruling 29 M2). A call that threw may have landed: `missing_unverified`,
 * and the journal row stays for a rollback; a job-level error fails the job, the row `writing`.
 */
async function send(ctx: ActCtx, id: string, rev: string, key: string): Promise<RowFields> {
	try {
		return await call(ctx, id, rev, key);
	} catch (e) {
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
		return unverified(ctx, id);
	}
}

async function call(ctx: ActCtx, id: string, rev: string, key: string): Promise<RowFields> {
	const { deps, job, action, cache } = ctx;
	const { collection, locale } = job.template;
	if (action === "trash") {
		cache.spend(COST_TRASH);
		const trashed = await deps.content.trash(collection, id);
		if (trashed.ok) return finish(ctx, id, rev);
		await deps.journal.delete(key);
		return trashed.reason === "blocked"
			? rowOf(ctx, "failed", id, {
					errors: [issue("missing_blocked", blockedMessage(trashed.message))],
				})
			: unchanged(ctx, id, "missing_gone");
	}
	cache.spend(COST_UNPUBLISH);
	const result = await deps.content.revertStep({ collection, locale, id, rev, step: "unpublish" });
	if (result.ok) return finish(ctx, id, result.state.rev);
	await deps.journal.delete(key);
	switch (result.reason) {
		case "blocked":
			return rowOf(ctx, "failed", id, {
				errors: [issue("missing_blocked", blockedMessage(result.message))],
			});
		case "locked":
			return rowOf(ctx, "locked", id, { errors: [issue("locked", LOCKED_MESSAGE)] });
		case "conflict":
			return rowOf(ctx, "conflict", id, { errors: [issue("missing_changed", CHANGED_MESSAGE)] });
	}
}

/**
 * Step 5: the link at the revision the entry now has (Trash keeps it, spec F1), naming this job,
 * with the mark; owner, fields, unconfirmed names and schedule as they were.
 */
async function finish(ctx: ActCtx, id: string, rev: string): Promise<RowFields> {
	const { deps, job, link, action } = ctx;
	const { collection, locale } = job.template;
	ctx.cache.spend(COST_CALL);
	await deps.links.put(linkKey(collection, locale, link.sourceKey), {
		...link,
		writtenRev: rev,
		jobId: job.id,
		missing: { jobId: job.id, action, at: iso(deps) },
	});
	return rowOf(ctx, "removed", id, { writtenRev: rev });
}
