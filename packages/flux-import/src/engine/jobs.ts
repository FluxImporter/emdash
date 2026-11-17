import {
	CSV_SOURCE,
	type RecordReader,
	SourceError,
	type SourceErrorCode,
} from "../sources/reader.js";
import { readerFor } from "../sources/readers.js";
import { DEFAULT_MAX_UPLOAD_SIZE } from "./media.js";
import { CANCEL_LIVE_WARNING, settleStopped, settles } from "./missing.js";
import { SourceMissingError } from "./ports.js";
import { templateShapeProblems } from "./shape.js";
import {
	checkTemplate,
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
	MISSING_MAX_PERCENT_DEFAULT,
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
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "JobError";
	}
}

/** `createJob`'s create-only write found a job under the same ID (M6c, spec P16). */
export class JobExistsError extends Error {
	constructor(readonly id: string) {
		super(`Job id ${id} already exists`);
		this.name = "JobExistsError";
	}
}

export type CreateJobInput = {
	/** M6c: the job's ID; `deps.newId()` when absent. */
	id?: string;
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
	/** Keep a journal so the job can be rolled back (M5a); a real run only, default true. */
	journal?: boolean;
	/** The URL source the job's file was fetched from (M5a). */
	sourceId?: string;
	/** Whether the collection keeps revisions (M5b), for templates that map `publishAt`; default true. */
	revisions?: boolean;
	/**
	 * M5c: `false` skips the missing phase for this run; `{ maxPercent }` replaces the template's
	 * threshold for this run. Only with `rules.missing`.
	 */
	missing?: false | { maxPercent: number };
	/** M5c, XLSX: rows the converter skipped because their only values were unreadable. */
	skippedRows?: number;
	/** M6a: the saved template `template` was read from; the job records its ID and revision. */
	savedTemplate?: { id: string; revision: number };
	/** M6c: created by the agent routes (`Job.origin`). */
	origin?: "agent";
	/** M6c: a real job from `jobs/start`: the dry run it imports. */
	dryRunOf?: string;
};

/**
 * The job's missing-phase threshold (M5c): absent without `rules.missing`, `false` when the job
 * option turns the phase off, else the option's `maxPercent` or the template's (default 25).
 */
export function missingLimitOf(
	template: Template,
	option: CreateJobInput["missing"],
): Job["missingLimit"] {
	const rule = template.rules?.missing;
	if (rule === undefined) return undefined;
	if (option === false) return false;
	return { maxPercent: option?.maxPercent ?? rule.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT };
}

/** Records read at job creation to warn about JSON and XML paths that none of them has. */
export const WARNING_SAMPLE = 20;
const BUDGET_MS_MIN = 500;
const BUDGET_MS_MAX = 25_000;
const CAS_ATTEMPTS = 5;

/** The batch size and budget, defaulted and checked (`invalid_options`). */
export function batchOptions(input: { batchSize?: number; budgetMs?: number }): {
	batchSize: number;
	budgetMs: number;
} {
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
	return { batchSize, budgetMs };
}

export async function createJob(deps: EngineDeps, input: CreateJobInput): Promise<Job> {
	const { batchSize, budgetMs } = batchOptions(input);

	// The site-independent checks run first (spec "Validation"), refused in M5c's groups and
	// messages (plan Ruling 6): the schema, then the options, expressions and the source block.
	const shape = templateShapeProblems(input.template);
	if (!shape.ok) {
		throw new JobError("invalid_template", "The template is invalid", shape.problems);
	}
	const template = shape.template;
	if (template.publishAt !== undefined && input.publish === false) {
		throw new JobError("invalid_options", "publishAt needs publish: true");
	}
	// M5c (spec "Template and job"): the refusals of the job option missing. The template schema
	// refuses rules.missing without rules.owner (spec Ruling 34).
	if (input.missing !== undefined && template.rules?.missing === undefined) {
		throw new JobError(
			"invalid_options",
			"The job option missing needs rules.missing in the template",
		);
	}
	const percent =
		input.missing === undefined || input.missing === false ? 0 : input.missing.maxPercent;
	if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
		throw new JobError(
			"invalid_options",
			"The job option missing.maxPercent must be an integer from 0 to 100",
		);
	}
	// The job option missing: false turns the phase off, so nothing needs undoing (spec Ruling 35).
	if (
		template.rules?.missing !== undefined &&
		input.missing !== false &&
		!input.dryRun &&
		input.journal === false
	) {
		throw new JobError(
			"invalid_options",
			"rules.missing needs the journal, so its changes can be rolled back",
		);
	}
	if (shape.expressions.length > 0) {
		throw new JobError(
			"invalid_template",
			"The template has invalid expressions",
			shape.expressions,
		);
	}
	if (shape.source.length > 0) {
		throw new JobError("invalid_source", "The source block is invalid", shape.source);
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
	const problems = [
		...shape.fit,
		...checkTemplate(template, input.schemaFields, columns, siteTimezone, linkSchema),
	];
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
	const dryRun = input.dryRun ?? false;
	const missingLimit = missingLimitOf(template, input.missing);
	const job: Job = {
		id: input.id ?? deps.newId(),
		status: "created",
		// A dry run writes nothing, so it keeps no journal.
		...(dryRun ? {} : { journal: input.journal ?? true }),
		...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
		...(input.savedTemplate === undefined
			? {}
			: {
					templateId: input.savedTemplate.id,
					templateRevision: input.savedTemplate.revision,
				}),
		...(input.origin === undefined ? {} : { origin: input.origin }),
		...(input.dryRunOf === undefined ? {} : { dryRunOf: input.dryRunOf }),
		...(template.publishAt === undefined ? {} : { revisions: input.revisions ?? true }),
		...(missingLimit === undefined ? {} : { missingLimit }),
		...(input.skippedRows ? { unkeyed: input.skippedRows } : {}),
		uploadId: input.uploadId,
		...(input.sourceUploadId === undefined ? {} : { sourceUploadId: input.sourceUploadId }),
		template,
		dryRun,
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
	if (!result.applied) throw new JobExistsError(job.id);
	return job;
}

/** A missing upload or an unreadable source fails job creation with `invalid_source`. */
async function asJobError<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof SourceMissingError) {
			throw new JobError("invalid_source", e.message, [], undefined, { cause: e });
		}
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

/**
 * M5c: settles a stopped job's missing phase before it ends or is rolled back (spec "Crash
 * repair"), so a trash that landed carries its marked link. Skipped while a batch holds a live
 * lease: that batch finishes its own calls. The counts are saved only when no batch ran since.
 */
export async function settleStoppedJob(deps: EngineDeps, id: string): Promise<"live" | "done"> {
	const stored = await deps.jobs.get(id);
	if (!stored) return "done";
	if (stored.lease && stored.lease.expiresAt > deps.now()) {
		return settles(upgradeJob(stored)) ? "live" : "done";
	}
	const job = structuredClone(upgradeJob(stored));
	if (!(await settleStopped(deps, job)) || job.missing === undefined) return "done";
	const missing = job.missing;
	const progress = (j: Job) => JSON.stringify([j.missing, j.counters, j.lease]);
	const was = progress(upgradeJob(stored));
	await updateJob(deps, id, (current) =>
		progress(current) === was ? { ...current, counters: job.counters, missing } : current,
	);
	return "done";
}

export async function transitionJob(
	deps: EngineDeps,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	// M5c: a cancel ends the job, so a stopped batch's landed trash is finished first. A batch
	// that still holds its lease finishes its own calls; the job says so, not silently.
	const live = action === "cancel" && (await settleStoppedJob(deps, id)) === "live";
	return updateJob(deps, id, (job) => {
		if (!ALLOWED[action].includes(job.status) || (action === "retry" && job.dryRun)) {
			throw new JobError(
				"invalid_transition",
				`Cannot ${action} a ${job.status}${job.dryRun ? " dry-run" : ""} job`,
			);
		}
		const rollback = job.kind === "rollback";
		if (action === "cancel" && rollback) {
			// Rows it reverted no longer match the original's links, so it could not start over.
			throw new JobError(
				"invalid_transition",
				"Cannot cancel a rollback job: pause it, or resume it to finish",
			);
		}
		if ((action === "resume" || action === "retry") && job.rolledBackBy !== undefined) {
			throw new JobError(
				"invalid_transition",
				`Cannot ${action} a job that was rolled back (rollback job ${job.rolledBackBy})`,
			);
		}
		switch (action) {
			case "pause":
				return { ...job, status: "paused" };
			case "resume":
				return { ...job, status: "running", error: null, failures: 0 };
			case "cancel":
				return {
					...withoutPlannedTerms(job),
					status: "cancelled",
					...(live && !job.warnings?.includes(CANCEL_LIVE_WARNING)
						? { warnings: [...(job.warnings ?? []), CANCEL_LIVE_WARNING] }
						: {}),
				};
			case "retry":
				// A rollback retries its rows newest first, like its first pass.
				return {
					...job,
					status: "running",
					phase: "retry",
					retryFromSeq: rollback ? Number.MAX_SAFE_INTEGER : 0,
					error: null,
				};
		}
	});
}
