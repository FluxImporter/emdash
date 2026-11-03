import { batchOptions, JobError, upgradeJob } from "./jobs.js";
import { CREATED_LISTED, type EngineDeps, emptyCounters, type Job } from "./types.js";

/** Media IDs the rollback job's warning lists; past them it gives a count. */
export const MAX_LISTED_MEDIA = CREATED_LISTED;

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
 * kept (spec M5a F13, F14). Read from the summary the import job kept while it ran, so the call
 * costs no row scan. A job with a journal always has one once it has created anything.
 */
export function rollbackWarnings(original: Job): string[] {
	const warnings: string[] = [];
	const created = original.created;
	if (!created) return warnings;
	if (created.mediaCount > 0) {
		const listed = created.media.slice(0, MAX_LISTED_MEDIA);
		const more =
			created.mediaCount > listed.length ? `, and ${created.mediaCount - listed.length} more` : "";
		warnings.push(
			`The import created ${created.mediaCount} media items, which are kept (EmDash cannot tell whether other content uses them): ${listed.join(", ")}${more}`,
		);
	}
	if (created.termCount > 0) {
		warnings.push(
			`The import created ${created.termCount} terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms`,
		);
	}
	return warnings;
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
	const current = await deps.jobs.getVersioned(input.id);
	if (!current) throw new JobError("not_found", `Job ${input.id} not found`);
	const original = upgradeJob(current.value);
	const refusal = rollbackRefusal(original, deps.now());
	if (refusal !== null) throw new JobError("invalid_transition", refusal);
	const dryRun = input.dryRun ?? false;
	const warnings = rollbackWarnings(original);
	const now = new Date(deps.now()).toISOString();
	const rollback: Job = {
		id: deps.newId(),
		status: "created",
		kind: "rollback",
		rollbackOf: original.id,
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
