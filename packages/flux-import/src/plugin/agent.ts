/**
 * The agent routes' rules (M6c): `jobs/plan`, `jobs/start`, `jobs/step` and `jobs/status`. Every
 * limit an agent works under is checked here, by the server, never by the client (spec Ruling
 * 35): saved templates only, no missing phase, a completed agent dry run before any write, one
 * real job per dry run, agent jobs only for `next_batch`, and always a journal.
 */
import { JobError, JobExistsError } from "../engine/jobs.js";
import { type KvCollection, SourceMissingError } from "../engine/ports.js";
import { isPurging } from "../engine/rollback.js";
import type { EngineDeps, Job, RecordStatus } from "../engine/types.js";
import { type JobRequest, type ResolvedTemplate, resolveJobTemplate } from "./job-templates.js";
import { recordPage, ServiceError } from "./service.js";
import {
	type JobSummary,
	RECORD_PAGE,
	type RecordSummary,
	redact,
	summarize,
	summarizeRecord,
} from "./summaries.js";
import type { SavedTemplate } from "./templates.js";

/** Rounds of `startFromDryRun`'s claim before it answers `CONFLICT` (plan Ruling 11). */
export const CLAIM_ATTEMPTS = 5;
export const SOURCE_FILE_MISSING_MESSAGE =
	"The dry run's data is no longer stored; run dry_run again";
export const XLSX_TEXT_MESSAGE =
	"An XLSX workbook is a binary file and cannot be sent as text; use a URL source instead";

/** What the agent rules need from a request (plan Ruling 7); `routes.ts` builds it. */
export interface AgentDeps {
	jobs: KvCollection<Job>;
	templates: Pick<KvCollection<SavedTemplate>, "get">;
	/** `createJobFrom`: a job under `request.id` (when set), or `JobExistsError`. */
	create(request: JobRequest, resolved: ResolvedTemplate): Promise<Job>;
	/** Stages pasted text as `sources/paste` does; resolves the upload ID. */
	stage(text: string): Promise<string>;
	/** Deletes a staged file. */
	unstage(uploadId: string): Promise<void>;
	newId(): string;
}

export interface PlanInput {
	templateId: string;
	templateRevision?: number | undefined;
	text?: string | undefined;
	sourceId?: string | undefined;
	publish?: boolean | undefined;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
}

export interface StartInput {
	dryRunId: string;
	batchSize?: number | undefined;
	budgetMs?: number | undefined;
}

export interface StatusInput {
	id: string;
	records?: RecordStatus | undefined;
	cursor?: string | undefined;
}

export interface StatusReply {
	job: JobSummary;
	records?: { items: RecordSummary[]; cursor?: string; hasMore: boolean };
}

/** Whether the template has `rules.missing`; `createJob` validates the rule itself. */
export function hasMissingRule(template: unknown): boolean {
	const rules = (template as { rules?: { missing?: unknown } } | null)?.rules;
	return typeof rules === "object" && rules !== null && rules.missing !== undefined;
}

function sourceFormat(template: unknown): unknown {
	return (template as { source?: { format?: unknown } } | null)?.source?.format;
}

/**
 * What every agent job carries (spec Rulings 10, 29, 31): the marker, and `missing: false`
 * exactly when the template has the rule, since `createJob` refuses the option without it. No
 * `journal` option: a real run keeps its default journal.
 */
function agentOptions(resolved: ResolvedTemplate): Pick<JobRequest, "origin" | "missing"> {
	return {
		origin: "agent",
		...(hasMissingRule(resolved.template) ? { missing: false as const } : {}),
	};
}

/** `jobs/plan` (spec "jobs/plan"): a dry run of the agent's text or of a URL source. */
export async function planJob(deps: AgentDeps, input: PlanInput): Promise<Job> {
	// Documented invariant (plan P7): the route's schema refuses this first; kept for other callers.
	if ((input.text === undefined) === (input.sourceId === undefined)) {
		throw new ServiceError("VALIDATION_ERROR", "Set exactly one of text and sourceId", 400);
	}
	const resolved = await resolveJobTemplate(
		deps.templates,
		input.templateId,
		input.templateRevision,
	);
	const request: JobRequest = {
		templateId: input.templateId,
		dryRun: true,
		...agentOptions(resolved),
		...(input.publish === undefined ? {} : { publish: input.publish }),
		...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
		...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
	};
	if (input.text === undefined) {
		return deps.create({ ...request, sourceId: input.sourceId }, resolved);
	}
	// A schema-valid template's format; an unparseable one is refused by createJob.
	if (sourceFormat(resolved.template) === "xlsx") {
		throw new ServiceError("INVALID_FORMAT", XLSX_TEXT_MESSAGE, 400);
	}
	const uploadId = await deps.stage(input.text);
	try {
		return await deps.create({ ...request, uploadId }, resolved);
	} catch (e) {
		// Spec Ruling 28: refused data does not wait in public storage for retention.
		await deps.unstage(uploadId).catch(() => {});
		throw e;
	}
}

function isAgentDryRun(job: Job): job is Job & { templateId: string } {
	return (
		job.dryRun && job.origin === "agent" && job.kind !== "rollback" && job.templateId !== undefined
	);
}

/** The real run of a dry run (spec "jobs/start" step 5): nothing that changes the outcome. */
function realRequest(
	dryRun: Job & { templateId: string },
	id: string,
	input: StartInput,
	resolved: ResolvedTemplate,
): JobRequest {
	return {
		id,
		// The workbook for XLSX: startImport converts it again (spec P7).
		uploadId: dryRun.sourceUploadId ?? dryRun.uploadId,
		templateId: dryRun.templateId,
		dryRun: false,
		...agentOptions(resolved),
		dryRunOf: dryRun.id,
		publish: dryRun.publish,
		batchSize: input.batchSize ?? dryRun.batchSize,
		budgetMs: input.budgetMs ?? dryRun.budgetMs,
	};
}

/**
 * `jobs/start` (spec "jobs/start", Ruling 38): claims the dry run with `startedAs`, then creates
 * the job under that ID. A repeated call returns the job; a crash between the two writes is
 * repaired under the same ID; a lost claim re-reads the dry run.
 */
export async function startFromDryRun(deps: AgentDeps, input: StartInput): Promise<Job> {
	const { dryRunId } = input;
	for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
		const read = await deps.jobs.getVersioned(dryRunId);
		if (!read) throw new JobError("not_found", `Job ${dryRunId} not found`);
		const dryRun = read.value;
		if (!isAgentDryRun(dryRun)) {
			throw new ServiceError(
				"NOT_A_DRY_RUN",
				`Job ${dryRunId} is not a dry run made with dry_run`,
				400,
			);
		}
		// A dry run that retention is deleting is refused too (plan P5): its real job may already be
		// purged, and the repair below would then re-create it under `startedAs`.
		if (dryRun.status !== "completed" || isPurging(dryRun)) {
			throw new ServiceError(
				"DRY_RUN_INCOMPLETE",
				`Dry run ${dryRunId} is ${dryRun.status}; only a completed dry run can be started`,
				409,
				{ status: dryRun.status },
			);
		}
		if (dryRun.startedAs !== undefined) {
			const started = await deps.jobs.get(dryRun.startedAs);
			if (started?.rolledBackBy !== undefined) {
				throw new ServiceError(
					"DRY_RUN_USED",
					`The import started from dry run ${dryRunId} was rolled back; run dry_run again`,
					409,
					{ jobId: started.id },
				);
			}
			// Any other state is still this plan's job (plan Ruling 13).
			if (started) return started;
		}
		// Before any write: an edit or delete since the dry run is refused (spec Ruling 7).
		const resolved = await resolveJobTemplate(
			deps.templates,
			dryRun.templateId,
			dryRun.templateRevision,
		);
		let id = dryRun.startedAs;
		if (id === undefined) {
			id = deps.newId();
			const claimed = { ...dryRun, startedAs: id };
			const claim = await deps.jobs.compareAndSet(dryRunId, read.revision, claimed);
			// Another call claimed the dry run first, or the row changed: read it again.
			if (!claim.applied) continue;
		}
		try {
			return await deps.create(realRequest(dryRun, id, input, resolved), resolved);
		} catch (e) {
			if (!(e instanceof JobExistsError)) throw e;
			// Another call created the claimed job between our read and our write.
			const existing = await deps.jobs.get(id);
			if (existing) return existing;
			throw e;
		}
	}
	throw new ServiceError("CONFLICT", `Dry run ${dryRunId} kept changing; try again`, 409);
}

/**
 * `jobs/step` (spec Ruling 30): only jobs the agent routes created advance, and a job that is
 * neither created nor running is answered as it is, without a batch (plan Ruling 6).
 */
export async function stepAgentJob(
	jobs: Pick<KvCollection<Job>, "get">,
	id: string,
	run: () => Promise<Job>,
): Promise<Job> {
	const job = await jobs.get(id);
	if (!job) throw new JobError("not_found", `Job ${id} not found`);
	// A rollback job never carries `origin` (`createRollback` builds it field by field).
	if (job.origin !== "agent") {
		throw new ServiceError(
			"JOB_NOT_AGENT",
			`Job ${id} was not created by dry_run or start_import`,
			403,
		);
	}
	if (job.status !== "created" && job.status !== "running") return job;
	return run();
}

/** `jobs/status`: any job's summary, and one page of one outcome on request (plan Ruling 5). */
export async function readJobStatus(
	deps: Pick<EngineDeps, "jobs" | "records">,
	input: StatusInput,
	now: number,
): Promise<StatusReply> {
	const job = await deps.jobs.get(input.id);
	if (!job) throw new JobError("not_found", `Job ${input.id} not found`);
	const summary = summarize(job, now);
	if (input.records === undefined) return { job: summary };
	const rows = await recordPage(deps, {
		id: input.id,
		status: input.records,
		limit: RECORD_PAGE,
		...(input.cursor ? { cursor: input.cursor } : {}),
	});
	return {
		job: summary,
		records: {
			items: rows.items.map((row) => summarizeRecord(row, job.kind)),
			...(rows.cursor === undefined ? {} : { cursor: rows.cursor }),
			hasMore: rows.hasMore,
		},
	};
}

/** A missing staged file, however it surfaced (plan Ruling 9). */
export function isSourceMissing(e: unknown): boolean {
	if (e instanceof SourceMissingError) return true;
	// Documented invariant (plan P7): only sampleSource throws it, which the agent routes never call.
	if (e instanceof ServiceError) return e.code === "UPLOAD_NOT_FOUND";
	return e instanceof JobError && e.cause instanceof SourceMissingError;
}

/** Every string in a `ServiceError`'s details, redacted, at any depth (plan P3a). */
function redactDetail(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(redactDetail);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDetail(v)]));
	}
	return value;
}

/** Every error an agent route throws: no upload ID and no raw message (spec Ruling 33). */
export function agentError(e: unknown): unknown {
	if (isSourceMissing(e)) {
		return new ServiceError("SOURCE_FILE_MISSING", SOURCE_FILE_MISSING_MESSAGE, 404);
	}
	if (e instanceof ServiceError) {
		const details =
			e.details === undefined
				? undefined
				: (redactDetail(e.details) as Readonly<Record<string, unknown>>);
		return new ServiceError(e.code, redact(e.message), e.status, details);
	}
	if (e instanceof JobError) {
		return new JobError(e.code, redact(e.message), e.details.map(redact), e.sourceCode);
	}
	return e;
}
