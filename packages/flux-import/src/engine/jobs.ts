import {
	CSV_SOURCE,
	type RecordReader,
	SourceError,
	type SourceErrorCode,
} from "../sources/reader.js";
import { checkSource, readerFor } from "../sources/readers.js";
import { DEFAULT_MAX_UPLOAD_SIZE } from "./media.js";
import { SourceMissingError } from "./ports.js";
import {
	checkTemplate,
	compileTemplate,
	type LinkSchema,
	linkWarnings,
	missingPathWarnings,
	noRecordsWarning,
	type SchemaField,
	SOURCE_ID_FIELD,
	sharedRequiredOf,
	type Template,
	targetFieldsOf,
	taxonomiesOf,
	templatePaths,
	templateSchema,
	translationWarnings,
	unresolvedPaths,
	usesMedia,
	usesSiteTimezone,
} from "./template.js";
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
		/** The `SourceError` code when an unreadable source caused this error. */
		readonly sourceCode?: SourceErrorCode,
	) {
		super(message);
		this.name = "JobError";
	}
}

export type CreateJobInput = {
	uploadId: string;
	template: unknown;
	schemaFields: SchemaField[];
	/** XLSX: the uploaded workbook that `uploadId` was converted from. */
	sourceUploadId?: string;
	/** XLSX: the converted sheet's header names, checked like CSV columns. */
	columns?: string[];
	/** XLSX: warnings from the conversion, stored before the job's own. */
	warnings?: string[];
	/** The site's timezone setting, for templates with `tz: "site"`; UTC when absent. */
	siteTimezone?: string;
	/** Reference targets' fields and the taxonomy definitions, for the link checks. */
	linkSchema?: LinkSchema;
	/** The largest media download (`mediaMaxBytes`); EmDash's default upload limit when absent. */
	mediaMaxBytes?: number;
	dryRun?: boolean;
	publish?: boolean;
	batchSize?: number;
	budgetMs?: number;
};

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
export const WARNING_SAMPLE = 20;
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
	const compiled = compileTemplate(template);
	if (!compiled.ok) {
		throw new JobError(
			"invalid_template",
			"The template has invalid expressions",
			compiled.problems,
		);
	}

	const sourceProblems = checkSource(template.source);
	if (sourceProblems.length > 0) {
		throw new JobError("invalid_source", "The source block is invalid", sourceProblems);
	}
	const reader = readerFor(template.source);
	const located = await asJobError(async () =>
		reader.locate(await deps.source.open(input.uploadId, 0)),
	);
	const columns = located.columns ?? input.columns ?? null;
	if (template.source.format === "xlsx" && columns === null) {
		// startImport always passes the converted header names; without them checkTemplate would
		// skip the column and path checks.
		throw new Error("An XLSX job was created without the converted columns");
	}

	const siteTimezone = usesSiteTimezone(template) ? (input.siteTimezone ?? "UTC") : undefined;
	const linkSchema = input.linkSchema ?? {};
	const problems = checkTemplate(template, input.schemaFields, columns, siteTimezone, linkSchema);
	if (problems.length > 0) {
		throw new JobError(
			"invalid_template",
			"The template does not fit the source or schema",
			problems,
		);
	}
	const sampled =
		template.source.format === "csv"
			? []
			: await asJobError(() =>
					sampleWarnings(deps, reader, template, input.uploadId, located.bodyOffset),
				);
	const taxonomyDefs = linkSchema.taxonomies ?? [];
	const targetFields = targetFieldsOf(template, input.schemaFields);
	const warnings = [
		...(input.warnings ?? []),
		...sampled,
		...linkWarnings(template, taxonomyDefs),
		...translationWarnings(template, targetFields),
	];
	const sharedRequired = sharedRequiredOf(template, input.schemaFields);

	const now = new Date(deps.now()).toISOString();
	const job: Job = {
		id: deps.newId(),
		status: "created",
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
		dryRun: input.dryRun ?? false,
		publish: input.publish ?? true,
		batchSize,
		budgetMs,
		source: template.source,
		...(columns === null ? {} : { columns }),
		warnings,
		targetFields,
		...(sharedRequired.length > 0 ? { sharedRequired } : {}),
		...(siteTimezone === undefined ? {} : { siteTimezone }),
		...(template.taxonomies === undefined
			? {}
			: { taxonomies: taxonomiesOf(template, taxonomyDefs) }),
		...(usesMedia(template)
			? { mediaMaxBytes: input.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE }
			: {}),
		cursor: { offset: located.bodyOffset, seq: 0 },
		counters: emptyCounters(),
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		sourceIdField: input.schemaFields.some((f) => f.slug === SOURCE_ID_FIELD),
		error: null,
		failures: 0,
		createdAt: now,
		updatedAt: now,
	};
	const result = await deps.jobs.compareAndSet(job.id, null, job);
	if (!result.applied) throw new Error(`Job id ${job.id} already exists`);
	return job;
}

/** A missing upload or an unreadable source fails job creation with `invalid_source`. */
async function asJobError<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof SourceMissingError) throw new JobError("invalid_source", e.message);
		if (e instanceof SourceError) {
			throw new JobError("invalid_source", e.message, [`${e.code} at byte ${e.offset}`], e.code);
		}
		throw e;
	}
}

/**
 * Warnings from the first `WARNING_SAMPLE` records: template paths none of them has, or that the
 * source has no records. Each record is checked against the paths still unresolved and then
 * dropped, so no record values are kept. Every record read counts toward `WARNING_SAMPLE`, but
 * only one whose value was readable (no record error) counts as checked: a record that failed to
 * parse says nothing about paths. A structural error ends the sample early without a no-records
 * warning: the job is still created and fails at that offset when it runs, as CSV does.
 */
async function sampleWarnings(
	deps: EngineDeps,
	reader: RecordReader,
	template: Template,
	uploadId: string,
	bodyOffset: number,
): Promise<string[]> {
	let unresolved = templatePaths(template);
	let seen = 0;
	let checked = 0;
	try {
		const stream = await deps.source.open(uploadId, bodyOffset);
		for await (const rec of reader.read(stream, { startOffset: bodyOffset, startSeq: 0 })) {
			seen++;
			if (!rec.error) {
				checked++;
				unresolved = unresolvedPaths(template, unresolved, rec.value);
			}
			if (seen >= WARNING_SAMPLE) break;
		}
	} catch (e) {
		if (!(e instanceof SourceError)) throw e;
		return missingPathWarnings(unresolved, checked);
	}
	if (seen === 0) return [noRecordsWarning(template.source)];
	return missingPathWarnings(unresolved, checked);
}

/** The reader for a stored job; jobs created before M3a are CSV with `headers`. */
export function jobReader(job: Job): RecordReader {
	return readerFor(job.source ?? CSV_SOURCE, job.columns ?? job.headers ?? []);
}

/** A stored job with every counter; jobs created before M3b have no `filtered` counter. */
export function upgradeJob(job: Job): Job {
	return { ...job, counters: { ...emptyCounters(), ...job.counters } };
}

/** A stored job's template; templates stored before M3a have no source block and are CSV. */
export function jobTemplate(job: Job): Template {
	return job.template.source ? job.template : { ...job.template, source: CSV_SOURCE };
}

export async function updateJob(
	deps: EngineDeps,
	id: string,
	change: (job: Job) => Job,
): Promise<Job> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.jobs.getVersioned(id);
		if (!current) throw new JobError("not_found", `Job ${id} not found`);
		const next = {
			...change(upgradeJob(current.value)),
			updatedAt: new Date(deps.now()).toISOString(),
		};
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

/** The job without the dry run's planned terms, which only its running batches need. */
export function withoutPlannedTerms(job: Job): Job {
	const { plannedTerms: _planned, ...rest } = job;
	return rest;
}

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
				return { ...job, status: "running", error: null, failures: 0 };
			case "cancel":
				return { ...withoutPlannedTerms(job), status: "cancelled" };
			case "retry":
				return { ...job, status: "running", phase: "retry", retryFromSeq: 0, error: null };
		}
	});
}
