import { CsvSyntaxError, readCsvHeader } from "../sources/csv.js";
import { SourceMissingError } from "./ports.js";
import { checkTemplate, type SchemaField, templateSchema } from "./template.js";
import {
	BATCH_SIZE_DEFAULT,
	BATCH_SIZE_MAX,
	BUDGET_MS_DEFAULT,
	type EngineDeps,
	emptyCounters,
	type Job,
	type JobStatus,
} from "./types.js";

export type JobErrorCode =
	| "not_found"
	| "invalid_transition"
	| "invalid_template"
	| "invalid_options"
	| "invalid_source";

export class JobError extends Error {
	constructor(
		readonly code: JobErrorCode,
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
		this.name = "JobError";
	}
}

export type CreateJobInput = {
	uploadId: string;
	template: unknown;
	schemaFields: SchemaField[];
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

const BUDGET_MS_MIN = 500;
const BUDGET_MS_MAX = 25_000;
const CAS_ATTEMPTS = 5;

export async function createJob(deps: EngineDeps, input: CreateJobInput): Promise<Job> {
	const batchSize = input.batchSize ?? BATCH_SIZE_DEFAULT;
	const budgetMs = input.budgetMs ?? BUDGET_MS_DEFAULT;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE_MAX) {
		throw new JobError(
			"invalid_options",
			`batchSize must be an integer from 1 to ${BATCH_SIZE_MAX}`,
		);
	}
	if (!Number.isInteger(budgetMs) || budgetMs < BUDGET_MS_MIN || budgetMs > BUDGET_MS_MAX) {
		throw new JobError(
			"invalid_options",
			`budgetMs must be an integer from ${BUDGET_MS_MIN} to ${BUDGET_MS_MAX}`,
		);
	}

	const parsed = templateSchema.safeParse(input.template);
	if (!parsed.success) {
		throw new JobError(
			"invalid_template",
			"The template is invalid",
			parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`),
		);
	}
	const template = parsed.data;

	let header: { headers: string[]; bodyOffset: number };
	try {
		header = await readCsvHeader(await deps.source.open(input.uploadId, 0));
	} catch (e) {
		if (e instanceof SourceMissingError || e instanceof CsvSyntaxError) {
			throw new JobError("invalid_source", e.message);
		}
		throw e;
	}

	const problems = checkTemplate(template, input.schemaFields, header.headers);
	if (problems.length > 0) {
		throw new JobError(
			"invalid_template",
			"The template does not fit the source or schema",
			problems,
		);
	}

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
		id: deps.newId(),
		status: "created",
		uploadId: input.uploadId,
		template,
		dryRun: input.dryRun ?? false,
		publish: input.publish ?? true,
		batchSize,
		budgetMs,
		headers: header.headers,
		cursor: { offset: header.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		createdAt: now,
		updatedAt: now,
	};
	const result = await deps.jobs.compareAndSet(job.id, null, job);
	if (!result.applied) throw new Error(`Job id ${job.id} already exists`);
	return job;
}

export async function updateJob(
	deps: EngineDeps,
	id: string,
	change: (job: Job) => Job,
): Promise<Job> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.jobs.getVersioned(id);
		if (!current) throw new JobError("not_found", `Job ${id} not found`);
		const next = { ...change(current.value), updatedAt: new Date(deps.now()).toISOString() };
		const result = await deps.jobs.compareAndSet(id, current.revision, next);
		if (result.applied) return next;
	}
	throw new Error(`Job ${id} changed concurrently ${CAS_ATTEMPTS} times; try again`);
}

const ALLOWED: Record<"pause" | "resume" | "cancel" | "retry", JobStatus[]> = {
	pause: ["created", "running"],
	resume: ["paused", "failed"],
	cancel: ["created", "running", "paused", "failed"],
	retry: ["completed"],
};

export function transitionJob(
	deps: EngineDeps,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	return updateJob(deps, id, (job) => {
		if (!ALLOWED[action].includes(job.status) || (action === "retry" && job.dryRun)) {
			throw new JobError(
				"invalid_transition",
				`Cannot ${action} a ${job.status}${job.dryRun ? " dry-run" : ""} job`,
			);
		}
		switch (action) {
			case "pause":
				return { ...job, status: "paused" };
			case "resume":
				return { ...job, status: "running", error: null };
			case "cancel":
				return { ...job, status: "cancelled" };
			case "retry":
				return { ...job, status: "running", phase: "retry", retryFromSeq: 0, error: null };
		}
	});
}
