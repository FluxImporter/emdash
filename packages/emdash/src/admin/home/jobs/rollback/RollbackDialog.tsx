import { Banner, Button, Dialog, Loader, Meter, SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import type { Job, JobStatus } from "../../../../engine/types.js";
import { api } from "../../../api.js";
import { ApiError, isForbidden } from "../../../api-error.js";
import { describeError, describeJobError } from "../../../errors.js";
import { type Msg, useT, useTn, type Values } from "../../../i18n.js";
import { M as SHARED } from "../../../messages.js";
import { queryKeys } from "../../../queries.js";
import { useJobDriver } from "../../../run-driver.js";
import { WarningIcon } from "../../../ui/icons.js";
import { useHome } from "../../Home.js";
import { M, N } from "./messages.js";
import { foundOf, type PlanTile, planOf, planTiles, type RollbackPlan } from "./plan.js";

/**
 * The rollback dialog (Rollback.dc.html): a dry rollback driven to its end while the dialog says
 * it is checking, a summary of the four counts, then the real rollback driven with progress.
 * `continue` picks up an unfinished rollback job: resumed first when paused or failed, then
 * driven. A real rollback the server drives too (`scheduled: "open"`) keeps running once the
 * dialog closes; while the dialog is open it only goes faster. `schedule` is the schedule a
 * scheduled job's rollback pauses (its name null when it cannot be read), null for any other job.
 */
export type RollbackTarget =
	| {
			kind: "start";
			jobId: string;
			name: string;
			when: string;
			schedule: { name: string | null } | null;
	  }
	| { kind: "continue"; rollbackId: string; status: JobStatus; name: string };

/** A request the dialog makes, which "Try again" makes again. */
type Step =
	| { kind: "dry"; jobId: string }
	| { kind: "real"; jobId: string; total: number; plan: RollbackPlan }
	| { kind: "resume"; id: string; total: number | null; plan: RollbackPlan | null }
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
	/**
	 * `driveId` is the rollback, null while its request is in flight; `total` the dry run's rows
	 * and `plan` its counts, both null for a rollback continued without a dry run. `server` is
	 * whether the server drives it too, as the last reply said; null before one.
	 */
	| {
			phase: "rolling";
			driveId: string | null;
			total: number | null;
			plan: RollbackPlan | null;
			server: boolean | null;
	  }
	| { phase: "done" }
	| { phase: "raced"; rollbackId: string }
	| { phase: "error"; problem: Problem; retry: Step };

type Action =
	| { type: "checking"; jobId: string; driveId: string | null }
	| { type: "checked"; jobId: string; job: Job }
	| {
			type: "rolling";
			driveId: string | null;
			total: number | null;
			plan: RollbackPlan | null;
			server: boolean | null;
	  }
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
			return {
				phase: "rolling",
				driveId: action.driveId,
				total: action.total,
				plan: action.plan,
				server: action.server,
			};
		case "done":
			return { phase: "done" };
		case "raced":
			return { phase: "raced", rollbackId: action.rollbackId };
		case "failed":
			return { phase: "error", problem: action.problem, retry: action.retry };
	}
}

/** Whether the server drives `job` too, so it runs on once the dialog closes. */
const serverDrives = (job: Job) => job.scheduled === "open";

/** A rollback job `jobs/resume` must restart before it is driven again. */
const stopped = (status: JobStatus) => status === "paused" || status === "failed";

/** The request the dialog opens with; none for an unfinished rollback that is not stopped. */
function firstStep(target: RollbackTarget): Step | null {
	if (target.kind === "start") return { kind: "dry", jobId: target.jobId };
	return stopped(target.status)
		? { kind: "resume", id: target.rollbackId, total: null, plan: null }
		: null;
}

/** The state before that request: a rollback that is not stopped is driven at once. */
function initialState(target: RollbackTarget): State {
	if (target.kind === "start") return { phase: "checking", jobId: target.jobId, driveId: null };
	const driveId = stopped(target.status) ? null : target.rollbackId;
	return { phase: "rolling", driveId, total: null, plan: null, server: null };
}

/** Whether the person has not confirmed yet: the title is still a question (Spec "Rollback"). */
function asking(state: State, target: RollbackTarget): boolean {
	if (target.kind === "continue") return false;
	if (state.phase === "checking" || state.phase === "ready" || state.phase === "raced") return true;
	return state.phase === "error" && state.retry.kind === "dry";
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
	const tn = useTn();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const { target, onClose } = props;
	const [state, dispatch] = useReducer(reducer, target, initialState);

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
						const { total, plan } = step;
						dispatch({ type: "rolling", driveId: null, total, plan, server: null });
						const real = await rollbackOrRace(step.jobId, false);
						if (real === null) return;
						const server = serverDrives(real);
						dispatch({ type: "rolling", driveId: real.id, total, plan, server });
						return;
					}
					case "resume": {
						const { total, plan } = step;
						dispatch({ type: "rolling", driveId: null, total, plan, server: null });
						const server = serverDrives(await api.resume({ id: step.id }));
						dispatch({ type: "rolling", driveId: step.id, total, plan, server });
						return;
					}
					case "find": {
						const none = { total: null, plan: null };
						dispatch({ type: "rolling", driveId: null, ...none, server: null });
						let found = await api.getJob({ id: step.id });
						if (stopped(found.status)) found = await api.resume({ id: step.id });
						const server = serverDrives(found);
						dispatch({ type: "rolling", driveId: step.id, ...none, server });
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
			// A scheduled import's rollback pauses its schedule.
			void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
			return;
		}
		const retry: Step = { kind: "resume", id: driven.id, total: state.total, plan: state.plan };
		dispatch({ type: "failed", problem: { kind: "job", error: driven.error }, retry });
	}, [drivePhase, driven, driveId, state, announce, t, queryClient]);

	const driverFailed = driveId !== null && driver.phase === "error";
	const name = target.name;
	// Close stays enabled (Spec "Rollback"). A rollback the server drives keeps running once the
	// dialog closes; one it does not drive stops where it is, and its row offers "Continue the
	// rollback".
	const close = onClose;
	const drivenNow = driver.job !== null && driver.job.id === driveId ? driver.job : null;
	const server =
		drivenNow !== null ? serverDrives(drivenNow) : state.phase === "rolling" ? state.server : null;

	return (
		<Dialog.Root
			open
			onOpenChange={(open: boolean) => {
				if (!open) close();
			}}
		>
			<Dialog size="lg" className="flex flex-col gap-4 p-6">
				<Dialog.Title className="text-lg font-semibold text-kumo-default">
					{t(asking(state, target) ? M.title : M.titleRolling, { name })}
				</Dialog.Title>

				{state.phase === "checking" ? (
					<Checking />
				) : state.phase === "ready" ? (
					<Summary plan={state.plan} schedule={target.kind === "start" ? target.schedule : null} />
				) : state.phase === "rolling" ? (
					<Progress
						text={t(driver.phase === "waiting" ? M.waiting : M.rolling)}
						job={drivenNow}
						total={state.total}
						plan={state.plan}
						note={server === null ? null : server ? M.closeNoteRunning : M.closeNote}
					/>
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

				<div className="flex flex-wrap justify-end gap-2 pt-1">
					{state.phase === "checking" ? (
						<>
							<Button variant="secondary" onClick={close}>
								{t(M.cancel)}
							</Button>
							<Button variant="secondary-destructive" disabled>
								{t(M.rollBack)}
							</Button>
						</>
					) : state.phase === "ready" ? (
						<>
							<Button variant="secondary" onClick={close}>
								{t(M.keep)}
							</Button>
							<Button
								variant="secondary-destructive"
								onClick={() =>
									void run({
										kind: "real",
										jobId: state.jobId,
										total: state.total,
										plan: state.plan,
									})
								}
							>
								{tn(N.confirm, state.plan.total)}
							</Button>
						</>
					) : (
						<Button variant="secondary" onClick={close}>
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

/** Stage 1: the dry rollback runs; the four counts' places wait as skeletons. */
function Checking() {
	const t = useT();
	return (
		<div className="flex flex-col gap-4">
			<div role="status" className="flex items-center gap-3">
				<span aria-hidden="true">
					<Loader size="sm" />
				</span>
				<p className="text-sm">{t(M.checking)}</p>
			</div>
			<div aria-hidden="true" className="grid grid-cols-2 gap-2">
				{[0, 1, 2, 3].map((n) => (
					<div
						key={n}
						className="flex h-16 flex-col justify-center gap-2 rounded-lg border border-kumo-hairline p-3"
					>
						<SkeletonLine minWidth={20} maxWidth={30} />
						<SkeletonLine minWidth={50} maxWidth={80} />
					</div>
				))}
			</div>
		</div>
	);
}

/** "2 to delete" as its number and its words, so the number can stand out (as `RecordCounts`). */
function splitCount(text: string, number: string): { number: string; words: string } {
	const at = text.indexOf(number);
	if (at < 0) return { number: "", words: text };
	return { number, words: `${text.slice(0, at)}${text.slice(at + number.length)}`.trim() };
}

/** One of the summary's counts. */
function Tile(props: { tile: PlanTile }) {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const { tile } = props;
	const formatted = new Intl.NumberFormat(i18n.locale || "en").format(tile.count);
	const { number, words } = splitCount(tn(tile.label, tile.count), formatted);
	const kept = tile.kind === "kept" && tile.count > 0;
	return (
		<li
			className={
				kept
					? "flex flex-col gap-0.5 rounded-lg border border-kumo-warning p-3"
					: "flex flex-col gap-0.5 rounded-lg border border-kumo-hairline p-3"
			}
		>
			<span
				className={
					tile.kind === "deleted" && tile.count > 0
						? "text-2xl font-bold tabular-nums text-kumo-danger"
						: "text-2xl font-bold tabular-nums text-kumo-default"
				}
			>
				{number}
			</span>
			<span className="text-sm font-semibold">{words}</span>
			<span className="text-sm text-kumo-subtle">{t(tile.hint)}</span>
		</li>
	);
}

/**
 * Stage 2: what the dry rollback found and what will change, the four counts, a warning when
 * entries are kept, and the schedule it pauses.
 */
function Summary(props: { plan: RollbackPlan; schedule: { name: string | null } | null }) {
	const t = useT();
	const tn = useTn();
	const { plan } = props;
	const found = foundOf(plan);
	return (
		<div className="flex flex-col gap-4">
			{found === 0 ? (
				<p className="text-sm">{t(M.nothing)}</p>
			) : (
				<>
					<p className="text-sm">
						{tn(N.found, found)} {tn(N.change, plan.total)}
					</p>
					<ul className="grid grid-cols-2 gap-2">
						{planTiles(plan).map((tile) => (
							<Tile key={tile.kind} tile={tile} />
						))}
					</ul>
				</>
			)}
			{plan.gone > 0 ? <p className="text-sm">{tn(N.gone, plan.gone)}</p> : null}
			{plan.kept > 0 ? (
				<Banner
					variant="alert"
					icon={<WarningIcon aria-hidden="true" />}
					description={tn(N.keptWarning, plan.kept)}
				/>
			) : null}
			{props.schedule === null ? null : (
				<p className="text-sm">
					{props.schedule.name === null
						? t(M.scheduleUnnamed)
						: t(M.schedule, { name: props.schedule.name })}
				</p>
			)}
		</div>
	);
}

/**
 * Stage 3: the rollback driven, measured against its dry run ("8 of 14 entries"), each kind's
 * progress when the dry run split them, and why Close is safe (`note`, once a reply told).
 */
function Progress(props: {
	text: string;
	job: Job | null;
	total: number | null;
	plan: RollbackPlan | null;
	note: Msg | null;
}) {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const progressId = useId();
	const number = (n: number) => new Intl.NumberFormat(i18n.locale || "en").format(n);
	const { job, total, plan } = props;
	const done = job === null || total === null ? 0 : Math.min(rows(job), total);
	const kinds: [Msg, number, number][] =
		plan === null || job === null || plan.deleted === undefined
			? []
			: [
					[M.doneDeleted, job.undo?.deleted ?? 0, plan.deleted],
					[M.doneRestored, job.undo?.restored ?? 0, plan.restored ?? 0],
					[M.doneRecovered, job.undo?.recovered ?? 0, plan.recovered ?? 0],
				];
	const lines = kinds
		.filter(([, , planned]) => planned > 0)
		.map(([msg, now, planned]) => ({
			msg,
			value: t(M.progressCount, { done: number(Math.min(now, planned)), total: number(planned) }),
		}));
	if (plan !== null && job !== null && plan.kept > 0) {
		const c = job.counters;
		lines.push({ msg: M.doneKept, value: number(c.conflict + c.failed + c.locked) });
	}
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<span aria-hidden="true">
					<Loader size="sm" />
				</span>
				<p className="text-sm">{props.text}</p>
			</div>
			{job !== null && total !== null && total > 0 ? (
				<Meter
					label={t(M.progress)}
					value={done}
					max={total}
					customValue={tn(N.progressOf, total, { done: number(done) })}
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
			{lines.length === 0 ? null : (
				<ul className="flex flex-col gap-1 text-sm">
					{lines.map((line) => (
						<li key={line.msg.id} className="flex justify-between gap-3">
							<span>{t(line.msg)}</span>
							<span className="tabular-nums">{line.value}</span>
						</li>
					))}
				</ul>
			)}
			{props.note === null ? null : <p className="text-sm text-kumo-subtle">{t(props.note)}</p>}
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
