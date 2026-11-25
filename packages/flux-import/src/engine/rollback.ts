import { batchOptions, JobError, settleStoppedJob, upgradeJob } from "./jobs.js";
import { type EngineDeps, emptyCounters, type Job } from "./types.js";

/** Media IDs the rollback job's warning lists; past them it says there are more. */
const MAX_LISTED_MEDIA = 100;

export function isPurging(job: Job): boolean {
	return job.purging === true;
}

/** Why a rollback job cannot run: its original is gone or being deleted; null when it can. */
export async function originalProblem(
	deps: Pick<EngineDeps, "jobs">,
	rollback: Job,
): Promise<string | null> {
	if (rollback.rollbackOf === undefined) return null;
	const original = await deps.jobs.get(rollback.rollbackOf);
	if (!original) {
		return `The original job ${rollback.rollbackOf} no longer exists (retention deleted it), so its journal is gone`;
	}
	if (isPurging(original)) {
		return `The original job ${rollback.rollbackOf} is being deleted by retention, so its journal is incomplete`;
	}
	return null;
}

export type RollbackInput = {
	/** The import job to roll back. */
	id: string;
	dryRun?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

/** Why `job` cannot be rolled back now, or null when it can (spec M5a "Which jobs"). */
export function rollbackRefusal(job: Job, now: number): string | null {
	if (job.kind === "rollback") return "Cannot roll back a rollback job";
	if (isPurging(job)) return "Cannot roll back the job: retention is deleting it";
	if (job.dryRun) return "Cannot roll back a dry-run job: it wrote nothing";
	if (job.journal !== true) {
		return "The job has no journal: it was created before rollback support or with journal: false";
	}
	if (job.rolledBackBy !== undefined) {
		return `The job was already rolled back (rollback job ${job.rolledBackBy})`;
	}
	if (job.status === "created" || job.status === "running" || job.status === "paused") {
		return `Cannot roll back a ${job.status} job: cancel it first`;
	}
	if (job.lease && job.lease.expiresAt > now) {
		return "Cannot roll back the job while one of its batches is running";
	}
	return null;
}

/**
 * The rollback job's warnings: the media items the import created and the terms it created, both
 * kept (spec M5a F13, F14). Media come from the `journalMedia` rows, which are written before the
 * item is used, in one query of at most 100 rows (the index `["jobId", "seq"]` orders it; plugin
 * storage has no count, so a longer list says "more than 100"). Terms come from the summary the
 * import job keeps in `Job.created`. Neither scans records.
 */
async function rollbackWarnings(
	deps: Pick<EngineDeps, "journalMedia">,
	original: Job,
): Promise<string[]> {
	const warnings: string[] = [];
	const page = await deps.journalMedia.query({
		where: { jobId: original.id },
		orderBy: { seq: "asc" },
		limit: MAX_LISTED_MEDIA,
	});
	if (page.items.length > 0) {
		const ids = page.items.map(({ data }) => data.mediaId);
		const count = page.hasMore ? `more than ${ids.length}` : String(ids.length);
		warnings.push(
			`The import created ${count} media items, which are kept (EmDash cannot tell whether other content uses them): ${ids.join(", ")}${page.hasMore ? ", and more" : ""}`,
		);
	}
	const terms = original.created?.termCount ?? 0;
	if (terms > 0) {
		warnings.push(
			`The import created ${terms} terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms`,
		);
	}
	return warnings;
}

/** The job, versioned, or the `JobError` that refuses its rollback now. */
async function refuseRollback(deps: EngineDeps, id: string) {
	const current = await deps.jobs.getVersioned(id);
	if (!current) throw new JobError("not_found", `Job ${id} not found`);
	const original = upgradeJob(current.value);
	const refusal = rollbackRefusal(original, deps.now());
	if (refusal !== null) throw new JobError("invalid_transition", refusal);
	return { current, original };
}

/**
 * Creates the rollback job of an import (`jobs/rollback`), driven by `jobs/next`. A real rollback
 * marks the original `rolledBackBy` with compare-and-set after creating the rollback job, and
 * deletes the new job when it loses the race. Returns both jobs.
 */
export async function createRollback(
	deps: EngineDeps,
	input: RollbackInput,
): Promise<{ rollback: Job; original: Job }> {
	const { batchSize, budgetMs } = batchOptions(input);
	// Refused before anything is settled: a job that cannot be rolled back is left as it is.
	await refuseRollback(deps, input.id);
	// M5c: a missing phase a batch stopped in gets its landed trashes' marked links first, which
	// the rollback's ownership test reads (spec "Crash repair"). No-op for any other job.
	if (input.dryRun !== true) await settleStoppedJob(deps, input.id);
	// Read again after the settle, which may have saved the job, and checked again.
	const { current, original } = await refuseRollback(deps, input.id);
	const dryRun = input.dryRun ?? false;
	const warnings = await rollbackWarnings(deps, original);
	const now = new Date(deps.now()).toISOString();
	const rollback: Job = {
		id: deps.newId(),
		status: "created",
		kind: "rollback",
		rollbackOf: original.id,
		// M6a: so jobs/list { templateId } lists a template's imports with their rollbacks.
		...(original.templateId === undefined ? {} : { templateId: original.templateId }),
		...(original.templateRevision === undefined
			? {}
			: { templateRevision: original.templateRevision }),
		// M6b (spec Ruling 33): a rollback undoes its original's feed, so the schedule stays busy.
		...(original.feedSourceId === undefined ? {} : { feedSourceId: original.feedSourceId }),
		// Shown for the collection and locale; a rollback never reads the original's file.
		uploadId: original.uploadId,
		template: original.template,
		dryRun,
		publish: false,
		batchSize,
		budgetMs,
		...(original.targetFields === undefined ? {} : { targetFields: original.targetFields }),
		warnings,
		// Journal rows are read newest first, below `cursor.seq`.
		cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
		counters: { ...emptyCounters(), reverted: 0 },
		// M7b (plan Ruling 7): the split of `reverted`, and where the original's missing phase began.
		undo: { deleted: 0, restored: 0, recovered: 0 },
		...(original.missing === undefined ? {} : { missingFrom: original.missing.fromSeq }),
		lease: null,
		phase: "import",
		retryFromSeq: Number.MAX_SAFE_INTEGER,
		schemaReady: true,
		error: null,
		failures: 0,
		createdAt: now,
		updatedAt: now,
	};
	const created = await deps.jobs.compareAndSet(rollback.id, null, rollback);
	if (!created.applied) throw new Error(`Job id ${rollback.id} already exists`);
	if (dryRun) return { rollback, original };
	const marked = await deps.jobs.compareAndSet(original.id, current.revision, {
		...current.value,
		rolledBackBy: rollback.id,
		updatedAt: now,
	});
	if (!marked.applied) {
		// A failed clean-up must not hide the conflict.
		await deps.jobs.delete(rollback.id).catch(() => {});
		throw new JobError(
			"invalid_transition",
			"The job changed while its rollback was being created; try again",
		);
	}
	return { rollback, original: { ...original, rolledBackBy: rollback.id } };
}
