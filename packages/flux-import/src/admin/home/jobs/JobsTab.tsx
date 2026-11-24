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

/**
 * The Jobs tab (spec "Jobs"): real imports newest first, a `jobs/summaries` page at a time with
 * "Load more" (never `jobs/list`, Review Focus 5), each row's actions, and the dry-run line below.
 * `useJobPages` refetches the loaded pages every 5 s while a row is unfinished (plan Ruling 15).
 */
export function JobsTab() {
	const t = useT();
	const { i18n } = useLingui();
	const { announce } = useHome();
	const client = useQueryClient();
	const jobs = useJobPages();
	const templates = useAllTemplates();
	const schedules = useSchedules();
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<unknown>(null);
	const [cancelling, setCancelling] = useState<{ item: JobListItem; name: string } | null>(null);
	const [cancelBusy, setCancelBusy] = useState(false);
	const [cancelError, setCancelError] = useState<unknown>(null);
	const [rollback, setRollback] = useState<RollbackTarget | null>(null);

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

	/** A call for one row: its menu is busy meanwhile; a failure shows its sentence above the list. */
	const call = async (item: JobListItem, work: () => Promise<void>) => {
		setBusy(item.id);
		setProblem(null);
		try {
			await work();
		} catch (error) {
			setProblem(error);
		} finally {
			setBusy(null);
			refresh();
		}
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
				void call(item, () => downloadLog(item.id));
				return;
			case "failedLog":
				void call(item, () => downloadLog(item.id, "failed"));
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
			case "rollback": {
				const scheduled =
					item.origin === "schedule" && item.scheduleId !== undefined
						? (schedules.data?.find((s) => s.id === item.scheduleId)?.name ?? null)
						: null;
				setRollback({ kind: "start", jobId: item.id, name, when, scheduleName: scheduled });
				return;
			}
			case "continueRollback": {
				// The dialog's title reads "Roll back {name}?": the original's name, not "Rollback of …".
				const original = templateName(item, names);
				setRollback({
					kind: "continue",
					rollbackId: item.id,
					status: item.status,
					name: t(original.msg, original.values),
				});
				return;
			}
		}
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

	const failed = jobs.isError ? jobs.error : templates.isError ? templates.error : null;
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
				{jobs.isFetchNextPageError ? (
					<p role="alert" className="text-sm text-kumo-danger">
						{sentence(jobs.error)}
					</p>
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
			{rollback === null ? null : (
				<RollbackDialog
					target={rollback}
					onClose={() => {
						setRollback(null);
						refresh();
					}}
				/>
			)}
		</div>
	);
}
