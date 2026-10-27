import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type PlanAction,
	planRecord,
	type RecordPlan,
} from "./diff.js";
import {
	JobError,
	jobReader,
	jobTemplate,
	updateJob,
	upgradeJob,
	withoutPlannedTerms,
} from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	SourceMissingError,
} from "./ports.js";
import { COST_CALL, COST_READ, LookupCache, loadTerms, resolveLinks, termPath } from "./resolve.js";
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	filterRecord,
	type MappedRecord,
	SOURCE_ID_FIELD,
} from "./template.js";
import {
	type Counters,
	type EngineDeps,
	emptyCounters,
	type Job,
	type LinkRow,
	linkKey,
	type RecordRow,
	recordKey,
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
const CAS_ATTEMPTS = 5;
/** Content errors that fail the job rather than the record being written. */
const JOB_LEVEL_WRITE_ERRORS: ReadonlySet<string> = new Set([
	"collection_missing",
	"source_id_field_invalid",
]);

type Outcome = { done: boolean; error?: { code: string; message: string } };
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

function counterFor(row: RowFields): keyof Counters | null {
	switch (row.status) {
		case "planned":
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
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
			...(job.warnings ? { warnings: job.warnings } : {}),
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
			error: outcome.error ?? (stored.error?.code === "internal" ? null : stored.error),
			failures: 0,
			lease: null,
			updatedAt: iso(deps),
		};
		// A finished dry run has no later batch to need its planned terms.
		const saved = status === "completed" ? withoutPlannedTerms(next) : next;
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
		if (counter) job.counters[counter]++;
		return;
	}

	const base = { jobId: job.id, seq: rec.seq, start: rec.start, end: rec.end };
	const save = (fields: RowFields) =>
		deps.records.put(key, { ...base, ...fields, updatedAt: iso(deps) });

	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) job.counters[old]--;
	}
	const counter = counterFor(row);
	if (counter) job.counters[counter]++;
}

/** What the write helpers need about the record being processed. */
type RecordCtx = {
	deps: EngineDeps;
	job: Job;
	sourceKey: string;
	linkId: string;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
};

const PENDING_DRAFT_MESSAGE =
	"Not imported: the entry has an unpublished draft that this import did not write";
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
	action: PlanAction | undefined,
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

/** Saves the link with the latest revision this importer produced for the entry. */
function putLink(ctx: RecordCtx, entryId: string, writtenRev: string): Promise<void> {
	const { collection, locale } = ctx.job.template;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
	});
}

async function publishRev(ctx: RecordCtx, id: string, rev: string) {
	const { collection, locale } = ctx.job.template;
	const published = await ctx.deps.content.publish({ collection, locale, id, rev });
	if (published.ok) await putLink(ctx, id, published.rev);
	return published;
}

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
 */
async function currentLinks(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: ResolvedLinks,
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
	if (resolved.bylines) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/**
 * Whether an earlier record of this dry run planned to create `key`: one indexed lookup of the
 * job's record rows per distinct key and batch (the batch adds its own plans as it makes them).
 */
/** Whether the job's collection can be filtered by `flux_source_id`: a dry run never adds it. */
function sourceIdReady(job: Job): boolean {
	return !job.dryRun || job.schemaReady;
}

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
		// Only an earlier record counts: a row left by a crashed batch may be a later one.
		where: { jobId: job.id, sourceKey: key, status: "planned", seq: { lt: seq } },
		limit: 1,
	});
	const planned = page.items.some(({ data }) => data.action === "create");
	cache.plannedKeys.set(key, planned);
	return planned;
}

/** The link plan for `planRecord`; child-side reference fields compare as sets. */
async function linkPlan(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	resolved: ResolvedLinks,
): Promise<LinkPlan> {
	const childSide = new Set(
		Object.keys(resolved.references ?? {}).filter(
			(field) => job.targetFields?.[field]?.relationSide === "child",
		),
	);
	const current = entry ? await currentLinks(deps, cache, job, entry, resolved) : {};
	return { resolved, current, childSide };
}

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, whatever happens to the record afterwards.
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
	const found = { newTerms: [] as string[] };
	const row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	// A retried record keeps the terms its earlier attempts created.
	const newTerms = [...new Set([...(existing?.newTerms ?? []), ...found.newTerms])];
	return newTerms.length > 0 ? { ...row, newTerms } : row;
}

async function decideRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: { newTerms: string[] },
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
	if ("error" in filter) {
		return { status: "failed", sourceKey: null, entryId: null, errors: [filter.error] };
	}
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };

	const { key: sourceKey } = mapped.value;
	const { collection, locale } = job.template;
	const ctx: RecordCtx = {
		deps,
		job,
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		save,
	};
	// Known so far, so that a ContentWriteError from any content call still reports it.
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		if (requests) {
			const resolution = await resolveLinks(
				deps,
				cache,
				{
					template: job.template,
					targets: job.targetFields ?? {},
					taxonomies: job.taxonomies ?? {},
					dryRun: job.dryRun,
					plannedKey: (key) => plannedKey(deps, job, cache, key, rec.seq),
					sourceIdReady: sourceIdReady(job),
				},
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (!resolution.ok) {
				return { status: "failed", sourceKey, entryId: null, errors: resolution.errors };
			}
			ctx.links = resolution.links;
		}
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		if (link && requests) cache.spend(COST_READ);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null && sourceIdReady(job)) {
			if (requests) cache.spend(COST_READ);
			entry = await deps.content.findBySourceId(collection, locale, sourceKey, read);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
				repaired = true;
			}
		}
		entryId = entry?.id ?? null;
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		const plan = planRecord(entry, mapped.value, comparisons, links);
		action = plan.action;
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (!entry) return await writeRecord(ctx, null, plan, mapped.value);
		if (plan.action === "unchanged")
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
			const code = "pending_draft";
			return notImported("conflict", sourceKey, entry.id, plan.action, code, PENDING_DRAFT_MESSAGE);
		}
		if (await deps.content.isLocked(collection, locale, entry.id)) {
			return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
		}
		return await writeRecord(ctx, entry, plan, mapped.value);
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

/** The entry already holds the mapped data: finish an unfinished write or publish our own draft. */
async function finishUnchanged(
	ctx: RecordCtx,
	entry: EntrySnapshot,
	link: LinkRow | null,
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some((e) => e.code.startsWith("publish_"))));
	if (!unfinished) {
		// A pending draft at the revision this importer last produced is its own (an earlier
		// `publish: false` run or a failed publish), so publishing it puts no one else's work live.
		if (job.publish && entry.pendingPublish && link?.writtenRev === entry.rev) {
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
			return { status: "updated", sourceKey, entryId, action: "update" };
		}
		return { status: "unchanged", sourceKey, entryId };
	}
	const action = existing?.action;
	const writtenRev = existing?.writtenRev;
	// The recorded revision proves ownership only for the entry it was recorded for: revisions are
	// version-derived, so a different entry (an editor's copy) can carry the same string.
	const proven =
		writtenRev !== undefined && existing?.entryId === entry.id && entry.rev === writtenRev;
	if (job.publish && entry.pendingPublish) {
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
		await putLink(ctx, entryId, writtenRev);
	}
	return {
		status: action === "create" ? "created" : "updated",
		sourceKey,
		entryId,
		...(action ? { action } : {}),
	};
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

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	plan: RecordPlan,
	mapped: MappedRecord,
): Promise<RowFields> {
	const { deps, job, sourceKey, save } = ctx;
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	let written: { id: string; rev: string };
	if (!entry) {
		written = await deps.content.create({
			collection,
			locale,
			...slugPart,
			data: { ...mapped.data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out: on a collection with revisions that
		// would stage a draft identical to the live entry.
		const dataChanged = plan.changes.some(
			(c) => c.field === "slug" || Object.hasOwn(mapped.data, c.field),
		);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data: mapped.data } : {}),
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
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
		status: "writing",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		writtenRev: written.rev,
	});
	await putLink(ctx, written.id, written.rev);
	if (job.publish) {
		const published = await publishRev(ctx, written.id, written.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, written.id, plan.action, written.rev);
	}
	return {
		status: plan.action === "create" ? "created" : "updated",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		changes: plan.changes,
	};
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
		await processRecord(deps, job, template, rec, { retry: false, cache });
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
			if (counter) counters[counter]++;
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
			await processRecord(deps, job, template, rec, { retry: true, cache });
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link lookups are cached for the batch, and the batch ends
 * after the record that brings their cost to `lookupBudget` (that record always completes).
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
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
			await deps.content.ensureSourceIdField(job.template.collection);
			job.schemaReady = true;
		}
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
		});
		if (!compiled.ok) {
			outcome = {
				done: false,
				error: { code: "invalid_template", message: compiled.problems.join("; ") },
			};
		} else {
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit, cache)
					: await importPass(deps, job, template, started, limit, cache);
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
