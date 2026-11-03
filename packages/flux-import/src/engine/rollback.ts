import { batchOptions, JobError, upgradeJob } from "./jobs.js";
import { type EngineDeps, emptyCounters, type Job } from "./types.js";

/** Media IDs the rollback job's warning lists; past them it gives a count. */
export const MAX_LISTED_MEDIA = 100;
const PAGE = 100; // plugin storage query limit

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
 * The rollback job's warnings: the media items the import created and the terms it created,
 * both kept (spec M5a F13, F14).
 */
export async function rollbackWarnings(deps: EngineDeps, jobId: string): Promise<string[]> {
	const warnings: string[] = [];
	const media: string[] = [];
	let count = 0;
	let cursor: string | undefined;
	do {
		const page = await deps.journalMedia.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			count++;
			if (media.length < MAX_LISTED_MEDIA) media.push(data.mediaId);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	if (count > 0) {
		const more = count > media.length ? `, and ${count - media.length} more` : "";
		warnings.push(
			`The import created ${count} media items, which are kept (EmDash cannot tell whether other content uses them): ${media.join(", ")}${more}`,
		);
	}
	const terms = new Set<string>();
	cursor = undefined;
	do {
		const page = await deps.records.query({
			where: { jobId },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) for (const term of data.newTerms ?? []) terms.add(term);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	if (terms.size > 0) {
		warnings.push(
			`The import created ${terms.size} terms, which are kept (EmDash 1.2.0 has no term deletion for plugins); the import's records list them under newTerms`,
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
	const warnings = await rollbackWarnings(deps, original.id);
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
		await deps.jobs.delete(rollback.id);
		throw new JobError(
			"invalid_transition",
			"The job changed while its rollback was being created; try again",
		);
	}
	return { rollback, original: { ...original, rolledBackBy: rollback.id } };
}
