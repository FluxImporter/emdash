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
} from "./ports.js";
import {
	bylineIdsOf,
	COST_CALL,
	COST_RECORD,
	type LookupCache,
	loadTerms,
	termOfGroup,
} from "./resolve.js";
import { restoredData, sameStored } from "./rollback-values.js";
import {
	bump,
	type Counters,
	capErrors,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	linkKey,
	type RecordError,
	type RecordRow,
	type RollbackAction,
	recordKey,
} from "./types.js";

type Outcome = { done: boolean };
type StepFailure = Extract<StepResult, { ok: false }>;
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

/** Plugin storage query limit. */
const PAGE = 100;

export const CHANGED_MESSAGE =
	"Not rolled back: the entry changed after the import wrote it (an editor or a later import); roll back later imports first or revert it by hand";
const LOCKED_MESSAGE = "Not rolled back: the entry is being edited (locked)";
const NOTHING_MESSAGE = "Nothing to roll back: the entry was never created, or was deleted since";
const NEVER_WRITTEN_MESSAGE = "Nothing to roll back: the import never wrote this entry";
const TRASHED_MESSAGE =
	"Moved to Trash, not deleted: the import found this entry by crash repair, so it may not have created it";
const TRANSLATIONS_MESSAGE =
	"Not rolled back: the entry has translations that are still active; roll back the jobs of its translations first";
const REFERENCES_UNKNOWN_MESSAGE =
	"References staged in a draft before this job could not be restored";
const REQUIRED_MESSAGE =
	"Not rolled back: the field was empty before the import, and the collection requires it, so EmDash would refuse the restored value";

const ROLLBACK_ACTIONS: ReadonlySet<string> = new Set(["delete", "trash", "revert"]);

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

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

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
			await revertRow(deps, job, data, { retry: false, cache });
			job.cursor = { offset: 0, seq: data.seq };
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
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
			// A journal row is only deleted with its job, which retention keeps meanwhile.
			if (entry) await revertRow(deps, job, entry, { retry: true, cache });
			job.retryFromSeq = row.seq;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
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
	if (journal.kind !== "create" && journal.kind !== "update") {
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
	const owned =
		link !== null &&
		link.jobId === job.rollbackOf &&
		link.entryId === entry.id &&
		link.writtenRev === entry.rev;
	// A create made after the write-ahead row and never changed since (spec M5a V3): found by
	// source ID after a crash, or one whose link was never saved or names no job.
	const untouched =
		journal.kind === "create" &&
		(adopted ||
			(entry.createdAt !== undefined &&
				entry.createdAt >= journal.at &&
				entry.updatedAt === entry.createdAt));
	if (resumed && existing) ctx.written = { rev: entry.rev, step: existing.step ?? 0 };
	if (!resumed && !owned && !untouched) {
		const before = journal.before;
		const neverWritten =
			journal.kind === "update" &&
			link?.jobId !== job.rollbackOf &&
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
		? deleteCreated(ctx, entry, adopted, link?.entryId === entry.id)
		: restoreChanged(ctx, entry, link?.entryId === entry.id);
}

/** "Created entries": Trash, then a permanent delete when the import's own create made it. */
async function deleteCreated(
	ctx: RowCtx,
	entry: Found,
	adopted: boolean,
	linked: boolean,
): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection } = journal;
	if (!entry.trashed && (entry.group ?? entry.id) === entry.id) {
		const group = await deps.content.translations(collection, entry.id);
		if (group.some((t) => t.id !== entry.id)) {
			return rowOf(ctx, "conflict", {
				errors: [issue("rollback_has_translations", TRANSLATIONS_MESSAGE)],
			});
		}
	}
	const confirmed = journal.confirmed === true && !adopted;
	ctx.action = confirmed ? "delete" : "trash";
	const warnings = confirmed ? [] : [issue("rollback_trashed", TRASHED_MESSAGE)];
	if (job.dryRun)
		return rowOf(ctx, "planned", { changes: [], ...(warnings.length ? { warnings } : {}) });
	ctx.written = { rev: entry.rev, step: ctx.written?.step ?? 0 };
	await ctx.save(rowOf(ctx, "writing"));
	if (!entry.trashed) {
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
	if (confirmed) await deps.content.permanentDelete(collection, entry.id);
	if (linked) await deps.links.delete(linkKey(collection, journal.locale, journal.sourceKey));
	return rowOf(ctx, "reverted", warnings.length ? { warnings } : {});
}

/** The links of the pre-image as an update writes them; missing targets are left out and warned. */
async function restoredLinks(
	ctx: RowCtx,
	links: NonNullable<JournalBefore["links"]>,
): Promise<LinkWrites> {
	const { deps, job, journal, cache } = ctx;
	const writes: LinkWrites = {};
	const missing = (field: string, what: string) =>
		ctx.warnings.push(
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
		for (const id of ids) {
			cache.spend(COST_CALL);
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
 * "Revert sequence": 1 restore the live values, slug and links; 2 publish; 3 unpublish; 4 discard
 * the draft the entry did not have; 5 restore the draft; 6 schedule. Each step is chosen from the
 * entry's state after the previous one and saved with the revision it returned, so a resumed row
 * skips the steps done and re-derives the rest.
 */
async function restoreChanged(ctx: RowCtx, entry: Found, linked: boolean): Promise<RowFields> {
	const { deps, job, journal } = ctx;
	const { collection, locale } = journal;
	const before = journal.before;
	ctx.action = "revert";
	if (before === undefined || entry.trashed) {
		return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
	}
	const links = before.links ? await restoredLinks(ctx, before.links) : {};
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
	// EmDash refuses an empty required field, so the restore would stop half way: refuse it first.
	const resumedAt = ctx.written?.step ?? 0;
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
	if (job.dryRun) {
		return rowOf(ctx, "planned", { changes: await plannedChanges(ctx, entry, before, links) });
	}
	let state: EntryState = {
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		hasDraft: entry.hasDraft,
	};
	let done = ctx.written?.step ?? 0;
	ctx.written = { rev: state.rev, step: done };
	await ctx.save(rowOf(ctx, "writing"));
	const run = async (
		step: number,
		input: { step: RevertStep } & Partial<Parameters<EngineDeps["content"]["revertStep"]>[0]>,
	): Promise<StepFailure | null> => {
		if (done >= step) return null;
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
		await ctx.save(rowOf(ctx, "writing"));
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
	];
	for (const [i, next] of steps.entries()) {
		const failed = await next();
		if (failed === null) continue;
		if (failed.reason === "conflict") {
			return rowOf(ctx, "conflict", { errors: [issue("rollback_changed", CHANGED_MESSAGE)] });
		}
		// An editor opened the entry between two steps: left, with the step reached, for a retry.
		if (failed.reason === "locked") {
			return rowOf(ctx, "locked", { errors: [issue("locked", LOCKED_MESSAGE)] });
		}
		const name = ["update", "publish", "unpublish", "discard", "update", "schedule"][i];
		return rowOf(ctx, "failed", {
			errors: [
				issue(
					"rollback_blocked",
					`Not rolled back: a plugin refused the ${name}: ${failed.message}`,
				),
			],
		});
	}
	// The link goes back to the job before, at the rollback's revision, so that job's rollback
	// and the next import see the entry as that job left it.
	const id = linkKey(collection, locale, journal.sourceKey);
	if (before.link === null) {
		if (linked) await deps.links.delete(id);
	} else {
		await deps.links.put(id, {
			collection,
			locale,
			sourceKey: journal.sourceKey,
			entryId: entry.id,
			...(before.link.writtenRev === undefined ? {} : { writtenRev: state.rev }),
			...(before.link.jobId === undefined ? {} : { jobId: before.link.jobId }),
		});
	}
	return rowOf(ctx, "reverted");
}
