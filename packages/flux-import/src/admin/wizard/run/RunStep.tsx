import { Banner, Button, Dialog, LinkButton, Loader, Meter } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Counters, Job } from "../../../engine/types.js";
import { api, downloadLog } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError, describeJobError } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { M as SHARED } from "../../messages.js";
import { RETRY_DELAYS_MS, useJobDriver } from "../../run-driver.js";
import { useWizard } from "../context.js";
import {
	jobInput,
	ownerOf,
	reducer,
	saveOffered,
	toTemplate,
	type WizardAction,
} from "../state.js";
import { writeUrl } from "../url.js";
import { M } from "./messages.js";

/**
 * The Run step: creates the real job (after saving a new template, when asked) or reopens
 * `?job=<id>`, drives it with `jobs/next` while the page is open, and offers pause, resume,
 * cancel, the log and a retry of failed records.
 */

/** The `once` key of the real job's creation (preflight F14). */
const RUN_KEY = "run";
/** The counters every job has, in the order shown; `removed` follows when the job has it. */
const SHOWN: readonly Exclude<keyof Counters, "reverted" | "removed">[] = [
	"created",
	"updated",
	"unchanged",
	"failed",
	"locked",
	"conflict",
	"filtered",
];
/** What the dry run's total counts (Preview's `dryRunFinished`): records read, not removals. */
const processed = (c: Counters) =>
	c.created + c.updated + c.unchanged + c.locked + c.conflict + c.failed + c.filtered;

const isActive = (job: Job) => job.status === "created" || job.status === "running";

/** A failure to show, and how to try the request again when that makes sense. */
interface Problem {
	error: unknown;
	retry?: () => void;
}

export function RunStep() {
	const t = useT();
	const { i18n } = useLingui();
	const { state, dispatch, once } = useWizard();
	const latest = useRef(state);
	latest.current = state;
	const runId = state.run?.jobId ?? null;
	const total = state.dryRun?.total ?? null;

	/** The job as last seen: from the driver, or from a control's reply (preflight F13). */
	const [job, setJob] = useState<Job | null>(null);
	/** The job the driver drives; set once its job is known. */
	const [driveId, setDriveId] = useState<string | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const progressId = useId();
	const driver = useJobDriver(driveId, api.next);

	useEffect(() => {
		if (driver.job) setJob(driver.job);
	}, [driver.job]);

	const begin = useCallback(() => {
		setProblem(null);
		once(RUN_KEY, async () => {
			let s = latest.current;
			const { save } = s.options;
			// Only a choice Options offers: one left from edits since undone (or from a step bar
			// skip past Options) is moot, and the unedited template runs by ID and revision.
			if (saveOffered(s) && save.kind === "new") {
				// Ruling 13: the template is saved first, and the job runs from its ID and revision.
				const reply = await api.createTemplate({
					name: save.name,
					template: toTemplate(s, ownerOf(s)),
				});
				const saved: WizardAction = {
					type: "templateSaved",
					id: reply.template.id,
					revision: reply.template.revision,
					name: reply.template.name,
					template: reply.template.template,
					warnings: reply.check.warnings,
				};
				dispatch(saved);
				s = reducer(s, saved);
			}
			const created = await api.createJob(jobInput(s, false));
			dispatch({ type: "runStarted", jobId: created.id });
			writeUrl({ job: created.id });
			setJob(created);
			setDriveId(created.id);
		}).catch((error: unknown) => setProblem({ error, retry: begin }));
	}, [once, dispatch]);

	const load = useCallback((id: string) => {
		setProblem(null);
		api.getJob({ id }).then(
			(loaded) => {
				setJob(loaded);
				setDriveId(loaded.id);
			},
			(error: unknown) => setProblem({ error, retry: () => load(id) }),
		);
	}, []);

	const started = runId !== null;
	useEffect(() => {
		if (!started) begin();
	}, [started, begin]);
	// A reopened job, or one another mount of this step created: read it, then drive it.
	useEffect(() => {
		if (runId !== null && driveId === null) load(runId);
	}, [runId, driveId, load]);

	/** Sends a control and shows its reply as the job; then stops or restarts the driver. */
	const control = async (send: (i: { id: string }) => Promise<Job>, then: "stop" | "start") => {
		if (job === null) return;
		setProblem(null);
		setBusy(true);
		try {
			const reply = await send({ id: job.id });
			if (then === "stop") driver.stop();
			setJob(reply);
			if (then === "start") driver.start();
		} catch (error) {
			setProblem({ error });
		} finally {
			setBusy(false);
		}
	};

	const download = async (status?: "failed") => {
		if (job === null) return;
		setProblem(null);
		try {
			await downloadLog(job.id, status);
		} catch (error) {
			setProblem({ error });
		}
	};

	const number = (n: number, digits = 0) =>
		new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: digits }).format(n);

	const status: Status | null =
		job === null
			? problem
				? null
				: { msg: M.starting }
			: statusOf(job, driver.phase, driver.attempt);
	// The live region stays mounted while its text changes (review minor 3).
	const live = (
		<div className="flex items-center gap-3">
			{job === null && status ? (
				// Beside its visible text, the spinner is not announced a second time.
				<span aria-hidden="true">
					<Loader size="sm" />
				</span>
			) : null}
			<p className="text-lg font-medium" aria-live="polite">
				{status ? t(status.msg, status.values) : null}
			</p>
		</div>
	);

	if (job === null) {
		return (
			<div className="space-y-4">
				{live}
				{problem ? <ErrorNotice error={problem.error} onRetry={problem.retry} /> : null}
			</div>
		);
	}

	const done = processed(job.counters);
	const active = isActive(job);
	const rate = driver.recordsPerSecond;
	const showRate = active && rate !== null && rate > 0;
	// Nothing remains once the first pass has read every record: the retry pass and the missing
	// phase show no time left.
	const remaining = total === null ? 0 : total - done;
	const secondsLeft = showRate && remaining > 0 ? Math.ceil(remaining / rate) : null;

	// Only while the job runs: a pause or cancel ends the drive that failed (review 1).
	const driverFailed = active && driver.phase === "error";
	// A 403 leaves nothing to control: every control would answer 403 again (review minor 4).
	const controllable = !(
		(driverFailed && isForbidden(driver.error)) ||
		(problem !== null && isForbidden(problem.error))
	);

	return (
		<div className="space-y-4">
			{live}
			{job.status === "failed" && job.error ? <JobError error={job.error} /> : null}
			{job.dryRun ? <p className="text-sm text-kumo-subtle">{t(M.dryRun)}</p> : null}

			{job.status === "completed" || job.status === "cancelled" ? null : total !== null &&
				total > 0 ? (
				<Meter
					label={t(M.progress)}
					value={Math.min(done, total)}
					max={total}
					customValue={t(M.progressCount, {
						done: number(Math.min(done, total)),
						total: number(total),
					})}
				/>
			) : active ? (
				// A job reopened by URL has no known total (Coordinator's call 5).
				<div className="flex w-full flex-col gap-2">
					<span id={progressId} className="text-xs text-kumo-subtle">
						{t(M.progress)}
					</span>
					<progress className="w-full" aria-labelledby={progressId} />
				</div>
			) : null}

			{showRate || secondsLeft !== null ? (
				<div className="flex flex-wrap gap-4 text-sm text-kumo-subtle">
					{showRate ? <span>{t(M.rate, { rate: number(rate, 1) })}</span> : null}
					{secondsLeft !== null ? (
						<span>{t(M.timeLeft, { time: duration(secondsLeft, i18n.locale) })}</span>
					) : null}
				</div>
			) : null}

			<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				{SHOWN.map((name) => (
					<div key={name}>
						<dt className="text-sm text-kumo-subtle">{t(M.counters[name])}</dt>
						<dd className="text-2xl font-semibold tabular-nums">{number(job.counters[name])}</dd>
					</div>
				))}
				{job.counters.removed === undefined ? null : (
					<div>
						<dt className="text-sm text-kumo-subtle">{t(M.counters.removed)}</dt>
						<dd className="text-2xl font-semibold tabular-nums">{number(job.counters.removed)}</dd>
					</div>
				)}
			</dl>

			{driverFailed ? <ErrorNotice error={driver.error} onRetry={driver.start} /> : null}
			{problem ? <ErrorNotice error={problem.error} onRetry={problem.retry} /> : null}

			<div className="flex flex-wrap items-center gap-3">
				{controllable && active ? (
					<Button
						variant="secondary"
						disabled={busy}
						onClick={() => void control(api.pause, "stop")}
					>
						{t(M.pause)}
					</Button>
				) : null}
				{controllable && (job.status === "paused" || job.status === "failed") ? (
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => void control(api.resume, "start")}
					>
						{t(M.resume)}
					</Button>
				) : null}
				{controllable && job.status === "completed" && !job.dryRun && job.counters.failed > 0 ? (
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => void control(api.retry, "start")}
					>
						{t(M.retryFailed)}
					</Button>
				) : null}
				{job.status === "completed" && !job.dryRun ? (
					<LinkButton
						variant="secondary"
						href={`/_emdash/admin/content/${encodeURIComponent(job.template.collection)}`}
					>
						{t(M.viewEntries)}
					</LinkButton>
				) : null}
				<Button variant="secondary" onClick={() => void download()}>
					{t(M.downloadLog)}
				</Button>
				{job.counters.failed > 0 ? (
					<Button variant="secondary" onClick={() => void download("failed")}>
						{t(M.downloadFailed)}
					</Button>
				) : null}
				{controllable && (active || job.status === "paused" || job.status === "failed") ? (
					<Dialog.Root role="alertdialog" open={confirming} onOpenChange={setConfirming}>
						<Dialog.Trigger
							render={
								<Button variant="secondary" disabled={busy}>
									{t(M.cancel)}
								</Button>
							}
						/>
						<Dialog className="p-6">
							<Dialog.Title className="text-lg font-semibold">{t(M.cancelTitle)}</Dialog.Title>
							<Dialog.Description className="mt-2 text-sm text-kumo-subtle">
								{t(M.cancelBody)}
							</Dialog.Description>
							<div className="mt-4 flex justify-end gap-3">
								<Dialog.Close render={<Button variant="secondary">{t(M.cancelKeep)}</Button>} />
								<Button
									variant="destructive"
									onClick={() => {
										setConfirming(false);
										void control(api.cancel, "stop");
									}}
								>
									{t(M.cancel)}
								</Button>
							</div>
						</Dialog>
					</Dialog.Root>
				) : null}
			</div>

			{job.status === "completed" || job.status === "cancelled" ? null : (
				<p className="text-sm text-kumo-subtle">{t(M.leaving)}</p>
			)}
		</div>
	);
}

type Status = { msg: Msg; values?: Values };

/** The line that says what the job is doing; null while a driver error is shown instead. */
function statusOf(
	job: Job,
	phase: ReturnType<typeof useJobDriver>["phase"],
	attempt: number,
): Status | null {
	switch (job.status) {
		case "completed":
			return { msg: M.completed };
		case "cancelled":
			return { msg: M.cancelled };
		case "paused":
			return { msg: M.paused };
		case "failed":
			return null;
	}
	if (phase === "error") return null;
	if (phase === "waiting") return { msg: M.waiting };
	if (phase === "retrying") {
		return { msg: M.retrying, values: { attempt, max: RETRY_DELAYS_MS.length } };
	}
	// The retry pass recounts its records, so it has its own label (Task 4 review).
	return { msg: job.phase === "retry" ? M.retryPass : M.importing };
}

/** `seconds` as a rounded, localised duration: seconds under a minute, else minutes. */
function duration(seconds: number, locale: string): string {
	const [value, unit] = seconds < 60 ? [seconds, "second"] : [Math.round(seconds / 60), "minute"];
	return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/** A 403 that is not a CSRF refusal: the user may not import (preflight F29). */
function isForbidden(error: unknown): boolean {
	return error instanceof ApiError && error.status === 403 && error.code !== "CSRF_REJECTED";
}

/** A failed job's error, never with an upload ID in it (preflight F15). */
function JobError(props: { error: { code: string; message: string } }) {
	const t = useT();
	const d = describeJobError(props.error);
	return <Banner variant="error" title={t(d.msg)} description={d.detail} />;
}

/**
 * A failed request's sentence, its specifics, and "Try again" when given. A 403 has no retry: the
 * user's role does not change by trying again (Review Focus 2).
 */
function ErrorNotice(props: { error: unknown; onRetry?: (() => void) | undefined }) {
	const t = useT();
	const d = describeError(props.error);
	const { error, onRetry } = props;
	const forbidden = isForbidden(error);
	const description =
		d.detail === undefined && d.problems === undefined ? undefined : (
			<>
				{d.detail === undefined ? null : <p>{d.detail}</p>}
				{d.problems === undefined ? null : (
					<ul>
						{d.problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				)}
			</>
		);
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(d.msg, d.values)}
			description={description}
			action={
				onRetry && !forbidden ? (
					<Button variant="secondary" onClick={onRetry}>
						{t(SHARED.tryAgain)}
					</Button>
				) : undefined
			}
		/>
	);
}
