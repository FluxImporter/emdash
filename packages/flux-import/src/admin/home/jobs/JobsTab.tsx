import { Button, Empty, LinkButton, Loader, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { JobListItem } from "../../../plugin/summaries.js";
import { api, downloadLog } from "../../api.js";
import { isForbidden } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M as PAGE } from "../../messages.js";
import { queryKeys, useAllTemplates, useJobPages, useSchedules } from "../../queries.js";
import { useHome } from "../Home.js";
import { openPage, runUrl, WIZARD_URL } from "../links.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { whenLabel } from "../shared/When.js";
import { jobName, templateName } from "./actions.js";
import { DryRuns } from "./dry-runs/DryRuns.js";
import { JobRow, type RowAction } from "./JobRow.js";
import { M } from "./messages.js";
import { RollbackDialog, type RollbackTarget } from "./rollback/RollbackDialog.js";

type StartTarget = Extract<RollbackTarget, { kind: "start" }>;

/**
 * The Jobs tab (spec "Jobs"): real imports newest first, a `jobs/summaries` page at a time with
 * "Load more" (never `jobs/list`, Review Focus 5), each row's actions, and the dry-run line below.
 * `useJobPages` refetches the loaded pages every 5 s while a row is unfinished (plan Ruling 15).
 * The schedules are read only when a scheduled job's rollback dialog opens.
 */
export function JobsTab() {
	const t = useT();
	const { i18n } = useLingui();
	const { announce } = useHome();
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
					target: { kind: "start", jobId: item.id, name, when, scheduleName: null },
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
		}
	};

	// The whole tab fails only without rows to show; a failed poll or Load more keeps the table.
	const failed =
		jobs.isError && jobs.data === undefined
			? jobs.error
			: templates.isError && templates.data === undefined
				? templates.error
				: null;
	const rows = jobs.data?.pages.flatMap((page) => page.items) ?? [];
	const now = Date.now();

	let body: React.ReactNode;
	if (failed !== null) {
		body = (
			<div role="alert" className="flex items-center gap-3 text-kumo-danger">
				<p>{sentence(failed)}</p>
				{isForbidden(failed) ? null : (
					<Button
						variant="secondary"
						onClick={() => {
							if (jobs.isError) void jobs.refetch();
							if (templates.isError) void templates.refetch();
						}}
					>
						{t(PAGE.tryAgain)}
					</Button>
				)}
			</div>
		);
	} else if (jobs.isPending || templates.isPending) {
		body = <Loader aria-label={t(M.loading)} />;
	} else if (rows.length === 0) {
		body = (
			<Empty
				size="sm"
				title={t(M.empty)}
				contents={<LinkButton href={WIZARD_URL}>{t(M.newImport)}</LinkButton>}
			/>
		);
	} else {
		body = (
			<>
				<div className="overflow-x-auto">
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t(M.colName)}</Table.Head>
								<Table.Head>{t(M.colTarget)}</Table.Head>
								<Table.Head>{t(M.colStarted)}</Table.Head>
								<Table.Head>{t(M.colOrigin)}</Table.Head>
								<Table.Head>{t(M.colStatus)}</Table.Head>
								<Table.Head>{t(M.colCounts)}</Table.Head>
								<Table.Head>{t(M.colActions)}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{rows.map((item) => {
								const name = nameOf(item);
								const when = whenLabel(item.createdAt, now, i18n.locale, t);
								return (
									<JobRow
										key={item.id}
										item={item}
										name={name}
										when={when}
										busy={busy === item.id}
										onAction={(action) => onAction(item, name, when, action)}
									/>
								);
							})}
						</Table.Body>
					</Table>
				</div>
				{jobs.isError ? (
					<div role="alert" className="flex items-center gap-3 text-sm text-kumo-danger">
						<p>{sentence(jobs.error)}</p>
						{isForbidden(jobs.error) ? null : (
							<Button
								variant="secondary"
								onClick={() =>
									void (jobs.isFetchNextPageError ? jobs.fetchNextPage() : jobs.refetch())
								}
							>
								{t(PAGE.tryAgain)}
							</Button>
						)}
					</div>
				) : null}
				{jobs.hasNextPage ? (
					<Button
						variant="secondary"
						loading={jobs.isFetchingNextPage}
						// Kumo's spinner is labelled "Loading" in English: the label names the button.
						aria-label={t(M.loadMore)}
						aria-busy={jobs.isFetchingNextPage || undefined}
						disabled={jobs.isFetchingNextPage}
						onClick={() => void jobs.fetchNextPage()}
					>
						{t(M.loadMore)}
					</Button>
				) : null}
			</>
		);
	}

	return (
		<div className="space-y-4">
			{problem === null ? null : (
				<p role="alert" className="text-sm text-kumo-danger">
					{sentence(problem)}
				</p>
			)}
			{body}
			<DryRuns names={nameOf} />
			{cancelling === null ? null : (
				<ConfirmDialog
					open
					title={t(M.cancelTitle, { name: cancelling.name })}
					sentence={t(M.cancelSentence)}
					confirmLabel={t(M.cancelConfirm)}
					cancelLabel={t(M.cancelKeep)}
					danger
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
 * The rollback dialog of a scheduled job, which names the schedule it pauses. The schedules are
 * read only now. Until they are (or when they cannot be read) the line still says the schedule
 * will be paused; a schedule no longer listed was deleted, and nothing is paused.
 */
function ScheduledRollback(props: { target: StartTarget; scheduleId: string; onClose(): void }) {
	const t = useT();
	const schedules = useSchedules();
	const { target, scheduleId } = props;
	const scheduleName =
		schedules.data === undefined
			? t(M.thisSchedule)
			: (schedules.data.find((s) => s.id === scheduleId)?.name ?? null);
	const named = useMemo(() => ({ ...target, scheduleName }), [target, scheduleName]);
	return <RollbackDialog target={named} onClose={props.onClose} />;
}
