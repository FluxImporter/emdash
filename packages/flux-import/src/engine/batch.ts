import { type CsvRecord, CsvSyntaxError, readCsvRecords } from "../sources/csv.js";
import { dateFieldsOf, type PlanAction, planRecord } from "./diff.js";
import { JobError } from "./jobs.js";
import { ContentWriteError, type EntrySnapshot, SourceMissingError } from "./ports.js";
import { applyTemplate, SOURCE_ID_FIELD } from "./template.js";
import {
	type Counters,
	type EngineDeps,
	type Job,
	linkKey,
	type RecordRow,
	recordKey,
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
const CAS_ATTEMPTS = 5;

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
	const job = current.value;
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
	if (!result.applied) return { ok: false, job: (await deps.jobs.get(jobId)) ?? job };
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
			error: outcome.error ?? stored.error,
			lease: null,
			updatedAt: iso(deps),
		};
		const result = await deps.jobs.compareAndSet(job.id, current.revision, next);
		if (result.applied) return next;
	}
	throw new Error(`Could not save job ${job.id} after ${CAS_ATTEMPTS} attempts`);
}

export async function processRecord(
	deps: EngineDeps,
	job: Job,
	rec: CsvRecord,
	opts: { retry: boolean },
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

	const row = await decide(deps, job, rec, existing, save);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) job.counters[old]--;
	}
	const counter = counterFor(row);
	if (counter) job.counters[counter]++;
}

async function decide(
	deps: EngineDeps,
	job: Job,
	rec: CsvRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
): Promise<RowFields> {
	if (rec.error) {
		return {
			status: "failed",
			sourceKey: null,
			entryId: null,
			errors: [{ code: "column_count", message: `Expected ${job.headers.length} columns` }],
		};
	}
	const mapped = applyTemplate(job.template, rec.values);
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };

	const { key: sourceKey, slug, data } = mapped.value;
	const { collection, locale } = job.template;
	const linkId = linkKey(collection, locale, sourceKey);

	let entry: EntrySnapshot | null = null;
	const link = await deps.links.get(linkId);
	if (link) entry = await deps.content.get(collection, locale, link.entryId);
	const recovering = existing?.status === "writing";
	if (!entry && recovering) {
		entry = await deps.content.findBySourceId(collection, locale, sourceKey);
		if (entry) await deps.links.put(linkId, { collection, locale, sourceKey, entryId: entry.id });
	}

	const plan = planRecord(entry, mapped.value, dateFieldsOf(job.template));
	const entryId = entry?.id ?? null;
	if (job.dryRun)
		return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };

	const publishFailed = (
		reason: "conflict" | "locked",
		id: string,
		action: PlanAction | undefined,
		writtenRev: string | undefined,
	): RowFields => ({
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
	});

	if (entry && plan.action === "unchanged") {
		const unfinished =
			existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some((e) => e.code.startsWith("publish_")));
		if (!unfinished) return { status: "unchanged", sourceKey, entryId };
		const action = existing?.action;
		const writtenRev = existing?.writtenRev;
		if (job.publish && entry.pendingPublish) {
			// Publish only the exact revision this job wrote; anything newer may be an editor's draft.
			if (writtenRev === undefined || entry.rev !== writtenRev) {
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
			const published = await deps.content.publish({
				collection,
				locale,
				id: entry.id,
				rev: entry.rev,
			});
			if (!published.ok) return publishFailed(published.reason, entry.id, action, writtenRev);
		}
		return {
			status: action === "create" ? "created" : "updated",
			sourceKey,
			entryId,
			...(action ? { action } : {}),
		};
	}
	if (entry && (await deps.content.isLocked(collection, locale, entry.id))) {
		return { status: "locked", sourceKey, entryId };
	}

	await save({ status: "writing", sourceKey, entryId, action: plan.action });
	const slugPart = slug === undefined ? {} : { slug };
	try {
		let written: { id: string; rev: string };
		if (!entry) {
			const created = await deps.content.create({
				collection,
				locale,
				...slugPart,
				data: { ...data, [SOURCE_ID_FIELD]: sourceKey },
			});
			await deps.links.put(linkId, { collection, locale, sourceKey, entryId: created.id });
			written = created;
		} else {
			const result = await deps.content.update({
				collection,
				locale,
				id: entry.id,
				rev: entry.rev,
				...slugPart,
				data,
			});
			if (!result.ok) return { status: result.reason, sourceKey, entryId, action: plan.action };
			written = { id: entry.id, rev: result.rev };
		}
		if (job.publish) {
			// Record the revision we wrote, so crash repair publishes only that revision.
			await save({
				status: "writing",
				sourceKey,
				entryId: written.id,
				action: plan.action,
				writtenRev: written.rev,
			});
			const published = await deps.content.publish({
				collection,
				locale,
				id: written.id,
				rev: written.rev,
			});
			if (!published.ok)
				return publishFailed(published.reason, written.id, plan.action, written.rev);
		}
		return {
			status: plan.action === "create" ? "created" : "updated",
			sourceKey,
			entryId: written.id,
			action: plan.action,
			changes: plan.changes,
		};
	} catch (e) {
		if (e instanceof ContentWriteError) {
			return {
				status: "failed",
				sourceKey,
				entryId,
				action: plan.action,
				errors: [{ code: e.code, message: e.message }],
			};
		}
		throw e;
	}
}

async function importPass(deps: EngineDeps, job: Job, started: number): Promise<Outcome> {
	const stream = await deps.source.open(job.uploadId, job.cursor.offset);
	let processed = 0;
	for await (const rec of readCsvRecords(stream, {
		headers: job.headers,
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		await processRecord(deps, job, rec, { retry: false });
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= job.batchSize || deps.now() - started >= job.budgetMs) return { done: false };
	}
	return { done: true };
}

const RETRY_PAGE = 100; // plugin storage query limit

async function readOneRecord(deps: EngineDeps, job: Job, row: RecordRow): Promise<CsvRecord> {
	const stream = await deps.source.open(job.uploadId, row.start);
	for await (const rec of readCsvRecords(stream, {
		headers: job.headers,
		startOffset: row.start,
		startSeq: row.seq,
	})) {
		return rec;
	}
	throw new CsvSyntaxError("No record at the saved offset", row.start);
}

async function retryPass(deps: EngineDeps, job: Job, started: number): Promise<Outcome> {
	let processed = 0;
	for (;;) {
		const page = await deps.records.query({
			where: {
				jobId: job.id,
				status: { in: ["failed", "conflict"] },
				seq: { gte: job.retryFromSeq },
			},
			orderBy: { seq: "asc" },
			limit: Math.min(job.batchSize, RETRY_PAGE),
		});
		if (page.items.length === 0) return { done: true };
		for (const { data: row } of page.items) {
			await processRecord(deps, job, await readOneRecord(deps, job, row), { retry: true });
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= job.batchSize || deps.now() - started >= job.budgetMs)
				return { done: false };
		}
	}
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included).
 */
export async function runBatch(deps: EngineDeps, jobId: string, holder: string): Promise<Job> {
	const claimed = await claim(deps, jobId, holder);
	if (!claimed.ok) return claimed.job;
	const job = claimed.job;
	const started = deps.now();
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
			await deps.content.ensureSourceIdField(job.template.collection);
			job.schemaReady = true;
		}
		outcome =
			job.phase === "retry"
				? await retryPass(deps, job, started)
				: await importPass(deps, job, started);
	} catch (e) {
		if (e instanceof SourceMissingError) {
			outcome = { done: false, error: { code: "source_missing", message: e.message } };
		} else if (e instanceof CsvSyntaxError) {
			outcome = {
				done: false,
				error: { code: "csv_syntax", message: `${e.message} at byte ${e.offset}` },
			};
		} else {
			throw e;
		}
	}
	return release(deps, job, holder, outcome);
}
