import { Button, Empty, Pagination, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { JobListItem } from "../../../plugin/summaries.js";
import { api, downloadLog } from "../../api.js";
import { isForbidden } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { useT, useTn } from "../../i18n.js";
import { JOB_PAGE } from "../../limits.js";
import { M as PAGE } from "../../messages.js";
import { queryKeys, useAllTemplates, useJobPages, useSchedules } from "../../queries.js";
import { FileTextIcon } from "../../ui/icons.js";
import { Forbidden, LoadFailed, LoadingRows } from "../../ui/states.js";
import { useNarrow } from "../../ui/use-narrow.js";
import { useHome } from "../Home.js";
import { openPage, runUrl } from "../links.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { TabSummary } from "../shared/TabSummary.js";
import { whenLabel } from "../shared/When.js";
import { jobName, templateName } from "./actions.js";
import { DryRuns } from "./dry-runs/DryRuns.js";
import { JobItem, JobRow, type RowAction, type RowProps } from "./JobRow.js";
import { M, N } from "./messages.js";
import { RollbackDialog, type RollbackTarget } from "./rollback/RollbackDialog.js";

type StartTarget = Extract<RollbackTarget, { kind: "start" }>;

/**
 * The Jobs tab (Jobs.dc.html): the summary line, then real imports newest first in pages of
 * `jobs/summaries` (never `jobs/list`, Review Focus 5), each row's menu of actions, the dry runs
 * as the table's footer, and Previous / Next. Stacked rows below about 700px of content.
 * `useJobPages` refetches the loaded pages every 5 s while a row is unfinished (plan Ruling 15).
 * The schedules are read only when a scheduled job's cancel or rollback dialog opens.
 */
export function JobsTab() {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const number = (n: number) => new Intl.NumberFormat(i18n.locale || "en").format(n);
	const { announce } = useHome();
	const [ref, narrow] = useNarrow<HTMLDivElement>();
	const [page, setPage] = useState(1);
	const client = useQueryClient();
	const jobs = useJobPages();
	const templates = useAllTemplates();
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<unknown>(null);
	const [cancelling, setCancelling] = useState<{ item: JobListItem; name: string } | null>(null);
	const [cancelBusy, setCancelBusy] = useState(false);
	const [cancelError, setCancelError] = useState<unknown>(null);
	/** The open rollback dialog; `scheduleId` when the job's schedule must be named in it. */
	const [rollback, setRollback] = useState<{
		target: RollbackTarget;
		scheduleId: string | null;
	} | null>(null);

	const names = useMemo(
		() => new Map((templates.data ?? []).map((tpl) => [tpl.id, tpl.name])),
		[templates.data],
	);
	const nameOf = (item: JobListItem) => {
		const d = jobName(item, names);
		return t(d.msg, d.values);
	};

	const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.jobs });

	const sentence = (error: unknown) => {
		const d = describeError(error);
		return t(d.msg, d.values);
	};

	/**
	 * A call for one row: its menu is busy meanwhile; a failure shows its sentence above the list.
	 * A call that changes the job refreshes the list after it; a download changes nothing.
	 */
	const call = async (item: JobListItem, work: () => Promise<void>, changes = true) => {
		setBusy(item.id);
		setProblem(null);
		try {
			await work();
		} catch (error) {
			setProblem(error);
		} finally {
			setBusy(null);
			if (changes) refresh();
		}
	};

	/** The dialog's title reads "Roll back {name}?": the original's name, not "Rollback of …". */
	const originalName = (item: JobListItem) => {
		const original = templateName(item, names);
		return t(original.msg, original.values);
	};

	/** Resume and Retry (plan Ruling 11): the Run screen drives the job, unless a schedule does. */
	const restart = async (item: JobListItem, request: () => Promise<unknown>) => {
		await request();
		if (item.origin === "schedule") announce(t(M.scheduled));
		else openPage(runUrl(item.id));
	};

	const onAction = (item: JobListItem, name: string, when: string, action: RowAction) => {
		switch (action) {
			case "open":
				openPage(runUrl(item.id));
				return;
			case "log":
				void call(item, () => downloadLog(item.id), false);
				return;
			case "failedLog":
				void call(item, () => downloadLog(item.id, "failed"), false);
				return;
			case "pause":
				void call(item, async () => {
					await api.pause({ id: item.id });
					announce(t(M.paused, { name }));
				});
				return;
			case "resume":
				void call(item, () => restart(item, () => api.resume({ id: item.id })));
				return;
			case "retry":
				void call(item, () => restart(item, () => api.retry({ id: item.id })));
				return;
			case "cancel":
				setCancelError(null);
				setCancelling({ item, name });
				return;
			case "rollback":
				setRollback({
					target: { kind: "start", jobId: item.id, name, when, schedule: null },
					scheduleId:
						item.origin === "schedule" && item.scheduleId !== undefined ? item.scheduleId : null,
				});
				return;
			case "continueRollback":
				setRollback({
					target: {
						kind: "continue",
						rollbackId: item.id,
						status: item.status,
						name: originalName(item),
					},
					scheduleId: null,
				});
				return;
			case "retryRollback":
				// The Run screen is not taught rollbacks: the dialog drives the retried rollback.
				void call(item, async () => {
					await api.retry({ id: item.id });
					setRollback({
						target: {
							kind: "continue",
							rollbackId: item.id,
							status: "running",
							name: originalName(item),
						},
						scheduleId: null,
					});
				});
				return;
		}
	};

	const closeRollback = () => {
		setRollback(null);
		refresh();
	};

	const confirmCancel = async (item: JobListItem, name: string) => {
		setCancelBusy(true);
		setCancelError(null);
		try {
			await api.cancel({ id: item.id });
			announce(t(M.cancelled, { name }));
			setCancelling(null);
		} catch (error) {
			setCancelError(error);
		} finally {
			setCancelBusy(false);
			refresh();
			// A scheduled job's cancel pauses its schedule.
			void client.invalidateQueries({ queryKey: queryKeys.schedules });
		}
	};

	// The whole tab fails only without rows to show; a failed poll or page keeps the table.
	const failed =
		jobs.isError && jobs.data === undefined
			? jobs.error
			: templates.isError && templates.data === undefined
				? templates.error
				: null;

	// Pages are `jobs/summaries` pages (`JOB_PAGE` rows each). It has no total (TODO: a total
	// count in jobs/summaries), so while more pages exist the last page is the one after those
	// loaded, and going to it loads it. A page answered empty (the list ended on a page boundary)
	// is not a page to show.
	const loaded = (jobs.data?.pages ?? []).filter((p, i) => i === 0 || p.items.length > 0);
	const more = jobs.hasNextPage;
	const maxPage = Math.max(1, loaded.length + (more ? 1 : 0));
	const current = Math.min(page, maxPage);
	const shown = Math.max(0, Math.min(current, loaded.length) - 1);
	const waitingForPage = current > loaded.length;
	const rows = loaded[shown]?.items ?? [];
	const all = loaded.flatMap((p) => p.items);
	const from = loaded.slice(0, shown).reduce((n, p) => n + p.items.length, 0) + 1;
	const { fetchNextPage, isFetching, isFetchNextPageError } = jobs;
	useEffect(() => {
		if (waitingForPage && more && !isFetching && !isFetchNextPageError) void fetchNextPage();
	}, [waitingForPage, more, isFetching, isFetchNextPageError, fetchNextPage]);

	const now = Date.now();
	const rowProps = (item: JobListItem): RowProps => {
		const name = nameOf(item);
		const when = whenLabel(item.createdAt, now, i18n.locale, t);
		return {
			item,
			name,
			when,
			busy: busy === item.id,
			onAction: (action) => onAction(item, name, when, action),
		};
	};

	let body: ReactNode;
	if (failed !== null) {
		body = (
			<>
				{isForbidden(failed) ? (
					<Forbidden />
				) : (
					<LoadFailed
						title={t(M.loadFailed)}
						error={failed}
						retrying={jobs.isFetching || templates.isFetching}
						onRetry={() => {
							if (jobs.isError) void jobs.refetch();
							if (templates.isError) void templates.refetch();
						}}
					/>
				)}
				<DryRuns names={nameOf} standalone />
			</>
		);
	} else if (jobs.isPending || templates.isPending) {
		body = <LoadingRows label={t(M.loading)} columns={4} />;
	} else if (all.length === 0) {
		body = (
			<>
				<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-base">
					<Empty
						size="sm"
						icon={<FileTextIcon aria-hidden="true" size={28} />}
						title={t(M.empty)}
						description={t(M.emptyText)}
					/>
				</div>
				<DryRuns names={nameOf} standalone />
			</>
		);
	} else {
		const running = all.filter((i) => i.status === "running").length;
		const failures = all.filter((i) => i.status === "failed").length;
		body = (
			<>
				<TabSummary
					lead={tn(more ? N.latest : N.imports, all.length)}
					rest={[
						running > 0 ? tn(N.running, running) : "",
						failures > 0 ? tn(N.failed, failures) : "",
					]}
				/>
				{problem === null ? null : (
					<p role="alert" className="text-sm text-kumo-danger">
						{sentence(problem)}
					</p>
				)}
				<div
					className="overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base"
					aria-busy={waitingForPage || undefined}
				>
					{narrow ? (
						<ul className="divide-y divide-kumo-line">
							{rows.map((item) => (
								<JobItem key={item.id} {...rowProps(item)} />
							))}
						</ul>
					) : (
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t(M.colName)}</Table.Head>
									<Table.Head>{t(M.colStarted)}</Table.Head>
									<Table.Head>{t(M.colStatus)}</Table.Head>
									<Table.Head>{t(M.colCounts)}</Table.Head>
									<Table.Head>
										<span className="sr-only">{t(M.colActions)}</span>
									</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{rows.map((item) => (
									<JobRow key={item.id} {...rowProps(item)} />
								))}
							</Table.Body>
						</Table>
					)}
					<DryRuns names={nameOf} />
				</div>
				{jobs.isError ? (
					<div role="alert" className="flex items-center gap-3 text-sm text-kumo-danger">
						<p>{sentence(jobs.error)}</p>
						{isForbidden(jobs.error) ? null : (
							<Button
								variant="secondary"
								onClick={() => void (isFetchNextPageError ? fetchNextPage() : jobs.refetch())}
							>
								{t(PAGE.tryAgain)}
							</Button>
						)}
					</div>
				) : null}
				{maxPage > 1 ? (
					<Pagination
						page={current}
						setPage={setPage}
						perPage={JOB_PAGE}
						// Kumo counts pages from a total: this one gives `maxPage`, never a total shown.
						totalCount={maxPage * JOB_PAGE}
						labels={{
							navigation: t(M.pages),
							previousPage: t(M.previousPage),
							nextPage: t(M.nextPage),
						}}
					>
						<Pagination.Info className="text-kumo-default">
							{() =>
								waitingForPage
									? t(M.loading)
									: t(more ? M.rangeMore : M.range, {
											from: number(from),
											to: number(from + rows.length - 1),
											total: number(all.length),
										})
							}
						</Pagination.Info>
						<Pagination.Controls controls="simple" />
					</Pagination>
				) : null}
			</>
		);
	}

	return (
		<div ref={ref} className="flex flex-col gap-3">
			{body}
			{cancelling === null ? null : (
				<CancelDialog
					name={cancelling.name}
					scheduleId={
						cancelling.item.origin === "schedule" && cancelling.item.scheduleId !== undefined
							? cancelling.item.scheduleId
							: null
					}
					busy={cancelBusy}
					error={
						cancelError === null ? null : (
							<p role="alert" className="text-sm text-kumo-danger">
								{sentence(cancelError)}
							</p>
						)
					}
					onConfirm={() => void confirmCancel(cancelling.item, cancelling.name)}
					onClose={() => setCancelling(null)}
				/>
			)}
			{rollback === null ? null : rollback.target.kind === "start" &&
				rollback.scheduleId !== null ? (
				<ScheduledRollback
					target={rollback.target}
					scheduleId={rollback.scheduleId}
					onClose={closeRollback}
				/>
			) : (
				<RollbackDialog target={rollback.target} onClose={closeRollback} />
			)}
		</div>
	);
}

/**
 * The schedule a scheduled job's cancel or rollback pauses, read only once its dialog opens:
 * `{ name: null }` until the schedules are read (or when they cannot be), so the line still says
 * the schedule will be paused; null for a schedule no longer listed, which was deleted.
 */
function useScheduleOf(scheduleId: string): { name: string | null } | null {
	const schedules = useSchedules();
	if (schedules.data === undefined) return { name: null };
	const name = schedules.data.find((s) => s.id === scheduleId)?.name;
	return name === undefined ? null : { name };
}

/** The rollback dialog of a scheduled job, which names the schedule it pauses. */
function ScheduledRollback(props: { target: StartTarget; scheduleId: string; onClose(): void }) {
	const schedule = useScheduleOf(props.scheduleId);
	const { target } = props;
	const name = schedule === null ? undefined : schedule.name;
	const withSchedule = useMemo(
		(): StartTarget => ({ ...target, schedule: name === undefined ? null : { name } }),
		[target, name],
	);
	return <RollbackDialog target={withSchedule} onClose={props.onClose} />;
}

interface CancelProps {
	name: string;
	busy: boolean;
	error: ReactNode;
	onConfirm(): void;
	onClose(): void;
}

/** The cancel's confirmation; a scheduled job's also says its schedule will be paused. */
function CancelDialog(props: CancelProps & { scheduleId: string | null }) {
	const { scheduleId, ...rest } = props;
	return scheduleId === null ? (
		<CancelConfirm {...rest} schedule={null} />
	) : (
		<ScheduledCancel {...rest} scheduleId={scheduleId} />
	);
}

function ScheduledCancel(props: CancelProps & { scheduleId: string }) {
	const { scheduleId, ...rest } = props;
	return <CancelConfirm {...rest} schedule={useScheduleOf(scheduleId)} />;
}

function CancelConfirm(props: CancelProps & { schedule: { name: string | null } | null }) {
	const t = useT();
	const { schedule } = props;
	return (
		<ConfirmDialog
			open
			title={t(M.cancelTitle, { name: props.name })}
			sentence={t(M.cancelSentence)}
			confirmLabel={t(M.cancelConfirm)}
			cancelLabel={t(M.cancelKeep)}
			danger
			busy={props.busy}
			error={props.error}
			onConfirm={props.onConfirm}
			onClose={props.onClose}
		>
			{schedule === null ? null : (
				<p className="text-sm">
					{schedule.name === null
						? t(M.cancelScheduleUnnamed)
						: t(M.cancelSchedule, { name: schedule.name })}
				</p>
			)}
		</ConfirmDialog>
	);
}
