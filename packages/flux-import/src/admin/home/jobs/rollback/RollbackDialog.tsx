import { Banner, Button, Dialog, Loader, Meter } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import type { Job, JobStatus } from "../../../../engine/types.js";
import { api } from "../../../api.js";
import { ApiError, isForbidden } from "../../../api-error.js";
import { describeError, describeJobError } from "../../../errors.js";
import { type Msg, useT, type Values } from "../../../i18n.js";
import { M as SHARED } from "../../../messages.js";
import { queryKeys } from "../../../queries.js";
import { useJobDriver } from "../../../run-driver.js";
import { useHome } from "../../Home.js";
import { M } from "./messages.js";
import { planLines, planOf, type RollbackPlan } from "./plan.js";

/**
 * The rollback dialog (spec "Roll back"): a dry rollback driven to its end, what it will do in
 * plain words, then the real rollback driven with progress. `continue` picks up an unfinished
 * rollback job: resumed first when paused or failed, then driven.
 */
export type RollbackTarget =
	| { kind: "start"; jobId: string; name: string; when: string; scheduleName: string | null }
	| { kind: "continue"; rollbackId: string; status: JobStatus; name: string };

/** A request the dialog makes, which "Try again" makes again. */
type Step =
	| { kind: "dry"; jobId: string }
	| { kind: "real"; jobId: string; total: number }
	| { kind: "resume"; id: string; total: number | null }
	/** An unfinished rollback whose status is unknown (another tab started it): read it first. */
	| { kind: "find"; id: string };

type Problem =
	| { kind: "request"; error: unknown }
	/** A job that stopped unfinished: its error, or null when it was paused. */
	| { kind: "job"; error: { code: string; message: string } | null };

type State =
	/** `driveId` is `jobId`'s dry rollback, null while `jobs/rollback` is in flight. */
	| { phase: "checking"; jobId: string; driveId: string | null }
	| { phase: "ready"; jobId: string; plan: RollbackPlan; total: number }
	/** `driveId` is the rollback, null while its request is in flight; `total` the dry run's rows. */
	| { phase: "rolling"; driveId: string | null; total: number | null }
	| { phase: "done" }
	| { phase: "raced"; rollbackId: string }
	| { phase: "error"; problem: Problem; retry: Step };

type Action =
	| { type: "checking"; jobId: string; driveId: string | null }
	| { type: "checked"; jobId: string; job: Job }
	| { type: "rolling"; driveId: string | null; total: number | null }
	| { type: "done" }
	| { type: "raced"; rollbackId: string }
	| { type: "failed"; problem: Problem; retry: Step };

/** The rows a rollback job has settled: what its dry run counts as the work to do. */
const rows = (job: Job) => {
	const c = job.counters;
	return (c.reverted ?? 0) + c.unchanged + c.conflict + c.locked + c.failed;
};

function reducer(_state: State, action: Action): State {
	switch (action.type) {
		case "checking":
			return { phase: "checking", jobId: action.jobId, driveId: action.driveId };
		case "checked": {
			const { jobId, job } = action;
			return { phase: "ready", jobId, plan: planOf(job), total: rows(job) };
		}
		case "rolling":
			return { phase: "rolling", driveId: action.driveId, total: action.total };
		case "done":
			return { phase: "done" };
		case "raced":
			return { phase: "raced", rollbackId: action.rollbackId };
		case "failed":
			return { phase: "error", problem: action.problem, retry: action.retry };
	}
}

/** A rollback job `jobs/resume` must restart before it is driven again. */
const stopped = (status: JobStatus) => status === "paused" || status === "failed";

/** The request the dialog opens with; none for an unfinished rollback that is not stopped. */
function firstStep(target: RollbackTarget): Step | null {
	if (target.kind === "start") return { kind: "dry", jobId: target.jobId };
	return stopped(target.status) ? { kind: "resume", id: target.rollbackId, total: null } : null;
}

/** The state before that request: a rollback that is not stopped is driven at once. */
function initialState(target: RollbackTarget): State {
	if (target.kind === "start") return { phase: "checking", jobId: target.jobId, driveId: null };
	const driveId = stopped(target.status) ? null : target.rollbackId;
	return { phase: "rolling", driveId, total: null };
}

/**
 * The rollback another tab created for `jobId`, when `error` is the refusal of a job already
 * rolled back (Review Focus 2); null for any other error, or when the job cannot be read.
 */
async function raceOf(jobId: string, error: unknown): Promise<string | null> {
	if (!(error instanceof ApiError) || error.code !== "INVALID_TRANSITION") return null;
	const original = await api.getJob({ id: jobId }).catch(() => null);
	return original?.rolledBackBy ?? null;
}

export function RollbackDialog(props: { target: RollbackTarget; onClose(): void }) {
	const t = useT();
	const { i18n } = useLingui();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const { target, onClose } = props;
	const [state, dispatch] = useReducer(reducer, target, initialState);
	const progressId = useId();

	const driveId = state.phase === "checking" || state.phase === "rolling" ? state.driveId : null;
	const driver = useJobDriver(driveId, api.next);

	/**
	 * `jobs/rollback`, or null once the dialog shows the race: a second tab is refused, on its dry
	 * call as on its real one, when the first tab's rollback already exists (Review Focus 2).
	 */
	const rollbackOrRace = useCallback(async (jobId: string, dryRun: boolean) => {
		try {
			return await api.rollback({ id: jobId, dryRun });
		} catch (error) {
			const rollbackId = await raceOf(jobId, error);
			if (rollbackId === null) throw error;
			dispatch({ type: "raced", rollbackId });
			return null;
		}
	}, []);

	const run = useCallback(
		async (step: Step) => {
			try {
				switch (step.kind) {
					case "dry": {
						dispatch({ type: "checking", jobId: step.jobId, driveId: null });
						const dry = await rollbackOrRace(step.jobId, true);
						if (dry !== null) dispatch({ type: "checking", jobId: step.jobId, driveId: dry.id });
						return;
					}
					case "real": {
						dispatch({ type: "rolling", driveId: null, total: step.total });
						const real = await rollbackOrRace(step.jobId, false);
						if (real !== null) dispatch({ type: "rolling", driveId: real.id, total: step.total });
						return;
					}
					case "resume": {
						dispatch({ type: "rolling", driveId: null, total: step.total });
						await api.resume({ id: step.id });
						dispatch({ type: "rolling", driveId: step.id, total: step.total });
						return;
					}
					case "find": {
						dispatch({ type: "rolling", driveId: null, total: null });
						const found = await api.getJob({ id: step.id });
						if (stopped(found.status)) await api.resume({ id: step.id });
						dispatch({ type: "rolling", driveId: step.id, total: null });
						return;
					}
				}
			} catch (error) {
				dispatch({ type: "failed", problem: { kind: "request", error }, retry: step });
			}
		},
		[rollbackOrRace],
	);

	// Once per dialog, also when an effect runs twice (React's strict mode).
	const opened = useRef(false);
	useEffect(() => {
		if (opened.current) return;
		opened.current = true;
		const step = firstStep(target);
		if (step !== null) void run(step);
	}, [target, run]);

	// The driver's end, for the job driven now: the driver keeps its last job until it restarts.
	const { phase: drivePhase, job: driven } = driver;
	useEffect(() => {
		if (drivePhase !== "stopped" || driveId === null || driven?.id !== driveId) return;
		if (state.phase === "checking") {
			if (driven.status === "completed") {
				dispatch({ type: "checked", jobId: state.jobId, job: driven });
				void queryClient.invalidateQueries({ queryKey: queryKeys.dryRuns });
			} else {
				const retry: Step = { kind: "dry", jobId: state.jobId };
				dispatch({ type: "failed", problem: { kind: "job", error: driven.error }, retry });
			}
			return;
		}
		if (state.phase !== "rolling") return;
		if (driven.status === "completed") {
			dispatch({ type: "done" });
			announce(t(M.finished));
			void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
			void queryClient.invalidateQueries({ queryKey: queryKeys.dryRuns });
			return;
		}
		const retry: Step = { kind: "resume", id: driven.id, total: state.total };
		dispatch({ type: "failed", problem: { kind: "job", error: driven.error }, retry });
	}, [drivePhase, driven, driveId, state, announce, t, queryClient]);

	const driverFailed = driveId !== null && driver.phase === "error";
	// A rollback in flight cannot be left from here (spec Accessibility): Escape and Close wait.
	const closable = state.phase !== "rolling" || driverFailed;
	const close = () => {
		if (closable) onClose();
	};

	const number = (n: number) => new Intl.NumberFormat(i18n.locale).format(n);
	const name = target.name;

	return (
		<Dialog.Root
			open
			onOpenChange={(open: boolean) => {
				if (!open) close();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{t(M.title, { name })}</Dialog.Title>

				{state.phase === "checking" ? (
					<Busy text={t(M.checking)} />
				) : state.phase === "ready" ? (
					<Plan
						plan={state.plan}
						scheduleName={target.kind === "start" ? target.scheduleName : null}
					/>
				) : state.phase === "rolling" ? (
					<div className="space-y-3">
						<Busy text={t(driver.phase === "waiting" ? M.waiting : M.rolling)} />
						{driver.job !== null &&
						driver.job.id === driveId &&
						state.total !== null &&
						state.total > 0 ? (
							<Meter
								label={t(M.progress)}
								value={Math.min(rows(driver.job), state.total)}
								max={state.total}
								customValue={t(M.progressCount, {
									done: number(Math.min(rows(driver.job), state.total)),
									total: number(state.total),
								})}
							/>
						) : (
							// A continued rollback has no dry run to measure it by.
							<div className="flex w-full flex-col gap-2">
								<span id={progressId} className="text-xs text-kumo-subtle">
									{t(M.progress)}
								</span>
								<progress className="w-full" aria-labelledby={progressId} />
							</div>
						)}
					</div>
				) : state.phase === "done" ? (
					<p className="text-sm">{t(M.finished)}</p>
				) : state.phase === "raced" ? (
					<p className="text-sm">{t(M.raced)}</p>
				) : (
					<ProblemNotice problem={state.problem} onRetry={() => void run(state.retry)} />
				)}

				{driverFailed ? (
					<ProblemNotice
						problem={{ kind: "request", error: driver.error }}
						onRetry={driver.start}
					/>
				) : null}

				<div className="flex justify-end gap-3">
					{state.phase === "ready" ? (
						<>
							<Button variant="secondary" onClick={onClose}>
								{t(M.keep)}
							</Button>
							<Button
								variant="destructive"
								onClick={() => void run({ kind: "real", jobId: state.jobId, total: state.total })}
							>
								{t(M.rollBack)}
							</Button>
						</>
					) : (
						<Button variant="secondary" disabled={!closable} onClick={close}>
							{t(M.close)}
						</Button>
					)}
					{state.phase === "raced" ? (
						<Button
							variant="primary"
							onClick={() => void run({ kind: "find", id: state.rollbackId })}
						>
							{t(M.continue)}
						</Button>
					) : null}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** A sentence beside a spinner, which is not announced a second time. */
function Busy(props: { text: string }) {
	return (
		<div className="flex items-center gap-3">
			<span aria-hidden="true">
				<Loader size="sm" />
			</span>
			<p className="text-sm">{props.text}</p>
		</div>
	);
}

/** What the rollback will do, line by line, and the schedule it pauses. */
function Plan(props: { plan: RollbackPlan; scheduleName: string | null }) {
	const t = useT();
	const lines = planLines(props.plan);
	return (
		<div className="space-y-3">
			{lines.length === 0 ? (
				<p className="text-sm">{t(M.nothing)}</p>
			) : (
				<ul className="space-y-1 text-sm">
					{lines.map((line) => (
						<li key={line.msg.id}>{t(line.msg, line.values)}</li>
					))}
				</ul>
			)}
			{props.scheduleName === null ? null : (
				<p className="text-sm">{t(M.schedule, { name: props.scheduleName })}</p>
			)}
		</div>
	);
}

/** A failure's sentence, with "Try again" unless it is a 403 (no retry changes a role). */
function ProblemNotice(props: { problem: Problem; onRetry(): void }) {
	const t = useT();
	const { problem } = props;
	const d: { msg: Msg; values?: Values; detail?: string } =
		problem.kind === "request"
			? describeError(problem.error)
			: problem.error === null
				? { msg: M.stopped }
				: describeJobError(problem.error);
	const forbidden = problem.kind === "request" && isForbidden(problem.error);
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(d.msg, d.values)}
			{...(d.detail === undefined ? {} : { description: d.detail })}
			{...(forbidden
				? {}
				: {
						action: (
							<Button variant="secondary" onClick={props.onRetry}>
								{t(SHARED.tryAgain)}
							</Button>
						),
					})}
		/>
	);
}
