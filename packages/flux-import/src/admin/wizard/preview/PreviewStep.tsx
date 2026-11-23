import { Banner, Button, Empty, Loader } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { Counters, Job } from "../../../engine/types.js";
import { api } from "../../api.js";
import { ApiError, redact } from "../../api-error.js";
import { describeError, describeJobError, ERROR_MESSAGES } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { useJobDriver } from "../../run-driver.js";
import { DRY_RUN_KEY, useWizard } from "../context.js";
import { StepFooter } from "../StepFooter.js";
import { jobInput } from "../state.js";
import { M } from "./messages.js";
import { RecordsTable } from "./RecordsTable.js";

/** Job errors a resume cannot cure: the file is gone, or the template no longer fits. */
const FINAL_JOB_ERRORS: ReadonlySet<string> = new Set(["source_missing", "invalid_template"]);

/** The records a dry run read: every outcome but the missing phase's `removed`. */
function totalOf(c: Counters): number {
	return c.created + c.updated + c.unchanged + c.locked + c.conflict + c.failed + c.filtered;
}

/**
 * Why the missing phase would change nothing (engine `missing.ts`), or null when it applies. It
 * is refused for another URL source's entries under the same owner, which ends the count stage
 * at once, with partial counts and no rows; or over the limit (`found × 100 > maxPercent ×
 * owned`, a dry run's base), after which a dry run still plans its rows. It is skipped when not
 * every record had a readable key.
 */
function missingNote(job: Job): { msg: Msg; values?: Values } | null {
	const m = job.missing;
	if (m?.verdict === "skipped") {
		const unkeyed = job.unkeyed ?? 0;
		return unkeyed > 0
			? { msg: M.missingUnkeyed, values: { count: unkeyed } }
			: { msg: M.missingNoKey };
	}
	if (m?.verdict !== "refused") return null;
	if (m.rows === 0) return { msg: M.missingForeign };
	const limit = job.missingLimit;
	const max = limit === undefined || limit === false ? 0 : limit.maxPercent;
	const percent = Math.ceil((m.found * 100) / m.owned);
	return { msg: M.missingOverLimit, values: { found: m.found, owned: m.owned, percent, max } };
}

/**
 * The counts per action; "Missing → <action>" only when the template has a missing phase, marked
 * "Not applied", with the reason under the counts, when it was refused or skipped.
 */
function Counts(p: { job: Job }) {
	const t = useT();
	const c = p.job.counters;
	const missing = p.job.template.rules?.missing?.action;
	const note = missing === undefined ? null : missingNote(p.job);
	const items: [Msg, number][] = [
		[M.create, c.created],
		[M.update, c.updated],
		[M.unchanged, c.unchanged],
		[M.failed, c.failed],
		[M.conflict, c.conflict],
		[M.locked, c.locked],
		[M.filtered, c.filtered],
	];
	const missingMsg = missing === "trash" ? M.missingTrash : M.missingUnpublish;
	if (missing !== undefined) items.push([missingMsg, c.removed ?? 0]);
	return (
		<section aria-label={t(M.counts)} className="space-y-2">
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{items.map(([msg, n]) => (
					<div key={msg.id} className="rounded-lg border border-kumo-line p-3">
						<dt className="text-sm text-kumo-subtle">{t(msg)}</dt>
						<dd className="text-2xl font-semibold tabular-nums">{n}</dd>
						{note !== null && msg === missingMsg ? (
							<dd className="text-sm text-kumo-subtle">{t(M.notApplied)}</dd>
						) : null}
					</div>
				))}
			</dl>
			{note === null ? null : <p className="text-sm">{t(note.msg, note.values)}</p>}
		</section>
	);
}

/** A failed request in plain words, with its problems, and "Try again" when it may help. */
function ErrorNotice(p: { error: unknown; onRetry?: () => void }) {
	const t = useT();
	const e = describeError(p.error);
	const hasBody = e.detail !== undefined || e.problems !== undefined;
	return (
		<Banner
			variant="error"
			title={t(e.msg, e.values)}
			description={
				hasBody ? (
					<div className="space-y-2">
						{e.detail === undefined ? null : <p>{e.detail}</p>}
						{e.problems === undefined ? null : (
							<ul className="list-disc space-y-1 pl-4">
								{e.problems.map((problem) => (
									<li key={problem}>{problem}</li>
								))}
							</ul>
						)}
					</div>
				) : undefined
			}
			action={
				p.onRetry === undefined ? undefined : (
					<Button variant="secondary" onClick={p.onRetry}>
						{t(M.tryAgain)}
					</Button>
				)
			}
		/>
	);
}

/**
 * Preview: a dry run of the draft (or of the unedited saved template), driven to its end, then
 * its counts and records. Run is offered once it has finished with at least one record.
 */
export function PreviewStep() {
	const t = useT();
	const { state, dispatch, once } = useWizard();
	const [createError, setCreateError] = useState<unknown>(null);
	const [resuming, setResuming] = useState(false);
	const [resumeError, setResumeError] = useState<unknown>(null);
	const { dryRun } = state;

	// Created once per draft (F14): a remount while `jobs/create` is in flight sends no second
	// one, and a reply for a draft edited meanwhile is dropped by the reducer (its generation).
	useEffect(() => {
		if (dryRun !== null || createError !== null) return;
		let live = true;
		const draft = state;
		once(DRY_RUN_KEY, async () => {
			const input = jobInput(draft, true);
			const created = await api.createJob(input);
			dispatch({
				type: "dryRunStarted",
				jobId: created.id,
				uploadId: input.uploadId,
				generation: draft.generation,
			});
		}).catch((error: unknown) => {
			if (live) setCreateError(error);
		});
		return () => {
			live = false;
		};
	}, [state, dryRun, createError, once, dispatch]);

	const jobId = dryRun?.jobId ?? null;
	const driver = useJobDriver(jobId, api.next);
	const job = driver.job;
	const finished = job?.status === "completed" ? totalOf(job.counters) : null;
	// The reducer ignores it once the draft has changed (`dryRun` is then null).
	useEffect(() => {
		if (finished !== null) dispatch({ type: "dryRunFinished", total: finished });
	}, [finished, dispatch]);

	const creating = dryRun === null && createError === null;
	const driving =
		jobId !== null &&
		(driver.phase === "idle" ||
			driver.phase === "driving" ||
			driver.phase === "waiting" ||
			driver.phase === "retrying");
	const checking = creating || driving;
	const total = dryRun?.total ?? null;
	const canRun = !checking && total !== null && total > 0;
	const stopped =
		!driving &&
		job !== null &&
		(job.status === "failed" || job.status === "paused" || job.status === "cancelled")
			? job
			: null;
	const invalid = createError instanceof ApiError && createError.code === "INVALID_TEMPLATE";
	const warnings = state.saved?.warnings ?? [];

	let reason: Msg | null = null;
	if (!canRun) {
		if (checking) reason = M.runWaiting;
		else if (total === 0) reason = M.nothingToRun;
		else reason = M.runBlocked;
	}

	let stoppedMsg: { msg: Msg; detail?: string } | null = null;
	let retryable = false;
	if (stopped?.status === "failed") {
		stoppedMsg =
			stopped.error === null ? { msg: ERROR_MESSAGES.unknown! } : describeJobError(stopped.error);
		retryable = stopped.error === null || !FINAL_JOB_ERRORS.has(stopped.error.code);
	} else if (stopped !== null) {
		stoppedMsg = { msg: stopped.status === "paused" ? M.paused : M.cancelled };
		retryable = true;
	}

	/**
	 * A failed or paused dry run is resumed (`jobs/resume` allows both), then driven again; a
	 * cancelled one cannot be, so a new one is created, once for this job.
	 */
	const tryAgain = async () => {
		if (stopped === null || jobId === null) return;
		setResumeError(null);
		setResuming(true);
		try {
			if (stopped.status === "cancelled") {
				const draft = state;
				await once(`${DRY_RUN_KEY}:again:${jobId}`, async () => {
					const input = jobInput(draft, true);
					const created = await api.createJob(input);
					dispatch({
						type: "dryRunStarted",
						jobId: created.id,
						uploadId: input.uploadId,
						generation: draft.generation,
					});
				});
			} else {
				await api.resume({ id: jobId });
				driver.start();
			}
		} catch (error) {
			setResumeError(error);
		} finally {
			setResuming(false);
		}
	};

	return (
		<div className="space-y-4">
			{warnings.length === 0 ? null : (
				<Banner
					variant="alert"
					title={t(M.templateWarnings)}
					description={
						<ul className="list-disc space-y-1 pl-4">
							{warnings.map((w) => (
								<li key={w}>{redact(w)}</li>
							))}
						</ul>
					}
				/>
			)}
			{createError === null ? null : (
				<ErrorNotice
					error={createError}
					{...(invalid ? {} : { onRetry: () => setCreateError(null) })}
				/>
			)}
			{driver.phase === "error" ? (
				<ErrorNotice error={driver.error} onRetry={driver.start} />
			) : null}
			{stoppedMsg === null ? null : (
				<Banner
					variant="error"
					title={t(stoppedMsg.msg)}
					{...(stoppedMsg.detail === undefined ? {} : { description: stoppedMsg.detail })}
					action={
						retryable ? (
							<Button variant="secondary" disabled={resuming} onClick={() => void tryAgain()}>
								{t(M.tryAgain)}
							</Button>
						) : undefined
					}
				/>
			)}
			{resumeError === null || stopped === null ? null : <ErrorNotice error={resumeError} />}
			{/* One live region throughout, so the end of the dry run is announced. */}
			<div role="status" className="flex items-center gap-2 text-sm text-kumo-subtle">
				{checking ? (
					<>
						<span aria-hidden="true">
							<Loader size="sm" />
						</span>
						<span>{t(M.checking)}</span>
					</>
				) : total === null ? null : (
					<span>{t(M.finished, { total })}</span>
				)}
			</div>
			{job === null ? null : <Counts job={job} />}
			{total === 0 ? <Empty title={t(M.noRecords)} description={t(M.noRecordsHint)} /> : null}
			{total !== null && total > 0 && jobId !== null ? (
				<RecordsTable key={jobId} jobId={jobId} />
			) : null}
			<div>
				<Button variant="secondary" onClick={() => dispatch({ type: "stepChanged", step: "map" })}>
					{t(M.backToMap)}
				</Button>
			</div>
			<StepFooter
				canNext={canRun}
				{...(reason === null ? {} : { reason: t(reason) })}
				nextLabel={t(M.runImport)}
				onNext={() => dispatch({ type: "stepChanged", step: "run" })}
			/>
		</div>
	);
}
