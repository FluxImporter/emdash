import { Badge, Banner, Button, Empty, Loader, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ScheduleView, UpdateScheduleInput } from "../../../plugin/schedules.js";
import { api } from "../../api.js";
import { ApiError, isForbidden } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { MAX_SCHEDULES } from "../../limits.js";
import { M as PAGE } from "../../messages.js";
import {
	queryKeys,
	useAllSources,
	useAllTemplates,
	useFence,
	useSchedules,
} from "../../queries.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { describeTiming, fromCron, launchMessage, pauseMessage, utcLabel } from "./cron.js";
import { FenceBanner } from "./FenceBanner.js";
import { M } from "./messages.js";
import { RunLog } from "./RunLog.js";
import { ScheduleDialog } from "./ScheduleDialog.js";

type Action = "pause" | "resume" | "run";

/** A row's state in words (spec "Schedules"): queued while due, else running or paused. */
function stateOf(
	s: ScheduleView,
	t: (m: Msg, v?: Values) => string,
): { text: string; variant: "info" | "success" | "warning" | "neutral" } {
	if (s.due !== undefined) return { text: t(M.stateQueued), variant: "info" };
	if (s.enabled) return { text: t(M.stateRunning), variant: "success" };
	if (s.pause !== undefined) {
		const reason = t(pauseMessage(s.pause.reason));
		return { text: t(M.statePausedFor, { reason }), variant: "warning" };
	}
	// Disabled without a reason: what Pause leaves.
	return { text: t(M.statePaused), variant: "neutral" };
}

/** Writes the route's answer for one schedule into the list, as the next read would. */
function useReplaceRow() {
	const client = useQueryClient();
	return (view: ScheduleView) =>
		client.setQueryData<ScheduleView[]>(queryKeys.schedules, (rows) =>
			rows === undefined
				? [view]
				: rows.some((r) => r.id === view.id)
					? rows.map((r) => (r.id === view.id ? view : r))
					: [...rows, view],
		);
}

/**
 * The Schedules tab: the fence, the schedules with their timing (UTC), next run, last launch and
 * state, and their actions. `useSchedules` and `useFence` are read here together, so the fence
 * follows the list's interval as soon as a schedule is due (Task 6 review).
 */
export function SchedulesTab() {
	const t = useT();
	const { i18n } = useLingui();
	const { announce } = useHome();
	const client = useQueryClient();
	const replaceRow = useReplaceRow();
	const schedules = useSchedules();
	const fence = useFence();
	const templates = useAllTemplates();
	const sources = useAllSources();
	const limitId = useId();

	const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null);
	const [failed, setFailed] = useState<{ name: string; error?: unknown; said?: Msg } | null>(null);
	const [reloading, setReloading] = useState(false);
	const [editor, setEditor] = useState<{ id: string | null; opening: number; open: boolean }>({
		id: null,
		opening: 0,
		open: false,
	});
	const [runLog, setRunLog] = useState<{ id: string | null; open: boolean }>({
		id: null,
		open: false,
	});
	const [deleting, setDeleting] = useState<{ id: string | null; open: boolean }>({
		id: null,
		open: false,
	});
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [deleteError, setDeleteError] = useState<unknown>(null);

	const rows = schedules.data;
	const find = (id: string | null) =>
		id === null ? null : (rows?.find((s) => s.id === id) ?? null);

	const reloadList = async (): Promise<ScheduleView[] | undefined> => {
		setReloading(true);
		try {
			return (await schedules.refetch()).data;
		} finally {
			setReloading(false);
		}
	};

	const act = async (s: ScheduleView, action: Action) => {
		setBusy({ id: s.id, action });
		setFailed(null);
		try {
			if (action === "run") {
				const reply = await api.runSchedule({ id: s.id });
				replaceRow(reply.schedule);
				// The run's job is listed in Jobs.
				void client.invalidateQueries({ queryKey: queryKeys.jobs });
				announce(t(M.queued, { name: s.name }));
			} else {
				const enabled = action === "resume";
				let input: UpdateScheduleInput = { id: s.id, revision: s.revision, enabled };
				if (enabled && s.pause?.reason === "template_changed") {
					// Enabling re-pins only the source: the template is re-pinned here, to its
					// current revision (coordinator ruling b). A template no longer saved cannot be.
					if (templates.data !== undefined && !templates.data.some((x) => x.id === s.templateId)) {
						setFailed({ name: s.name, said: M.resumeTemplateGone });
						return;
					}
					const current = await client.fetchQuery({
						queryKey: queryKeys.template(s.templateId),
						queryFn: () => api.getTemplate({ id: s.templateId }),
					});
					// A threshold the current version no longer allows goes with it; a missing
					// choice it newly asks for is the server's sentence (MISSING_REQUIRED).
					const dropped = current.template.rules?.missing === undefined && s.missing !== undefined;
					input = {
						...input,
						templateId: s.templateId,
						templateRevision: current.revision,
						...(dropped ? { missing: null } : {}),
					};
				}
				const reply = await api.updateSchedule(input);
				replaceRow(reply.schedule);
				announce(t(enabled ? M.resumed : M.paused, { name: reply.schedule.name }));
			}
		} catch (e) {
			setFailed({ name: s.name, error: e });
		} finally {
			setBusy(null);
		}
	};

	const remove = async (s: ScheduleView) => {
		setDeleteBusy(true);
		setDeleteError(null);
		try {
			await api.deleteSchedule({ id: s.id, revision: s.revision });
			client.setQueryData<ScheduleView[]>(queryKeys.schedules, (list) =>
				list?.filter((r) => r.id !== s.id),
			);
			setDeleting((d) => ({ ...d, open: false }));
			announce(t(M.deleted, { name: s.name }));
		} catch (e) {
			setDeleteError(e);
		} finally {
			setDeleteBusy(false);
		}
	};

	if (rows === undefined) {
		return schedules.isError ? (
			<ListError
				error={schedules.error}
				retrying={schedules.isFetching}
				onRetry={() => void schedules.refetch()}
			/>
		) : (
			<Loader aria-label={t(M.loading)} />
		);
	}

	const templateName = (id: string) =>
		templates.data === undefined
			? null
			: (templates.data.find((x) => x.id === id)?.name ?? t(M.deletedTemplate));
	const sourceName = (id: string) =>
		sources.data === undefined
			? null
			: (sources.data.find((x) => x.id === id)?.name ?? t(M.deletedSource));
	const full = rows.length >= MAX_SCHEDULES;
	const editing = find(editor.id);
	const logged = find(runLog.id);
	const doomed = find(deleting.id);

	return (
		<div className="space-y-4">
			{fence.isError ? (
				// Unread, the fence may hold scheduled runs back: said as the failed check.
				<FenceBanner fence="error" />
			) : fence.data === undefined ? null : (
				<FenceBanner fence={fence.data} />
			)}
			{/* The tab's action at the right, as in Templates and Sources; why it is off, before it. */}
			<div className="flex flex-wrap items-center justify-end gap-3">
				{full ? (
					<p id={limitId} className="text-sm text-kumo-subtle">
						{t(M.atLimit, { max: MAX_SCHEDULES })}
					</p>
				) : null}
				<Button
					variant="primary"
					disabled={full}
					{...(full ? { "aria-describedby": limitId } : {})}
					onClick={() => setEditor((e) => ({ id: null, opening: e.opening + 1, open: true }))}
				>
					{t(M.newSchedule)}
				</Button>
			</div>
			{failed === null ? null : (
				<ActionError
					name={failed.name}
					error={failed.error}
					{...(failed.said === undefined ? {} : { said: failed.said })}
					reloading={reloading}
					onReload={() => {
						void reloadList().then(() => setFailed(null));
					}}
				/>
			)}
			{rows.length === 0 ? (
				<Empty size="sm" title={t(M.empty)} description={t(M.emptyHint)} />
			) : (
				<div className="overflow-x-auto">
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t(M.colName)}</Table.Head>
								<Table.Head>{t(M.colTemplate)}</Table.Head>
								<Table.Head>{t(M.colSource)}</Table.Head>
								<Table.Head>{t(M.colTiming)}</Table.Head>
								<Table.Head>{t(M.colNext)}</Table.Head>
								<Table.Head>{t(M.colLast)}</Table.Head>
								<Table.Head>{t(M.colState)}</Table.Head>
								<Table.Head>{t(M.colActions)}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{rows.map((s) => {
								const timing = describeTiming(fromCron(s.cron));
								const state = stateOf(s, t);
								const mine = busy?.id === s.id;
								const toggle: Action = s.enabled ? "pause" : "resume";
								const launch = s.lastLaunch;
								return (
									<Table.Row key={s.id}>
										<Table.Cell className="font-medium">{s.name}</Table.Cell>
										<Table.Cell>{templateName(s.templateId)}</Table.Cell>
										<Table.Cell>{sourceName(s.sourceId)}</Table.Cell>
										<Table.Cell>{t(timing.msg, timing.values)}</Table.Cell>
										<Table.Cell>
											{s.nextRunAt === null
												? t(M.notScheduled)
												: t(M.utcTime, { time: utcLabel(s.nextRunAt, i18n.locale) })}
										</Table.Cell>
										<Table.Cell>
											{launch === undefined ? (
												t(M.neverLaunched)
											) : (
												<div className="space-y-1">
													<time dateTime={launch.at}>
														{t(M.utcTime, { time: utcLabel(launch.at, i18n.locale) })}
													</time>
													<p className="text-sm">
														{launch.outcome === "failed"
															? t(M.launchFailed, { reason: t(launchMessage(launch)) })
															: t(launchMessage(launch))}
													</p>
												</div>
											)}
										</Table.Cell>
										<Table.Cell>
											<Badge variant={state.variant}>{state.text}</Badge>
											{s.pause?.reason === "template_changed" && !s.enabled ? (
												<p className="mt-1 text-sm text-kumo-subtle">
													{t(
														templates.data !== undefined &&
															!templates.data.some((x) => x.id === s.templateId)
															? M.resumeTemplateGone
															: M.resumeRepins,
													)}
												</p>
											) : null}
										</Table.Cell>
										<Table.Cell>
											<div className="flex flex-wrap gap-2">
												<RowButton
													label={t(s.enabled ? M.pause : M.resume)}
													name={t(s.enabled ? M.pauseRow : M.resumeRow, { name: s.name })}
													busy={mine && busy?.action === toggle}
													disabled={mine}
													onClick={() => void act(s, toggle)}
												/>
												<RowButton
													label={t(M.runNow)}
													name={t(M.runNowRow, { name: s.name })}
													busy={mine && busy?.action === "run"}
													disabled={mine}
													onClick={() => void act(s, "run")}
												/>
												<RowButton
													label={t(M.edit)}
													name={t(M.editRow, { name: s.name })}
													busy={false}
													disabled={mine}
													onClick={() =>
														setEditor((e) => ({ id: s.id, opening: e.opening + 1, open: true }))
													}
												/>
												<RowButton
													label={t(M.runLog)}
													name={t(M.runLogRow, { name: s.name })}
													busy={false}
													disabled={false}
													onClick={() => setRunLog({ id: s.id, open: true })}
												/>
												<RowButton
													label={t(M.delete)}
													name={t(M.deleteRow, { name: s.name })}
													busy={false}
													disabled={mine}
													onClick={() => {
														setDeleteError(null);
														setDeleting({ id: s.id, open: true });
													}}
												/>
											</div>
										</Table.Cell>
									</Table.Row>
								);
							})}
						</Table.Body>
					</Table>
				</div>
			)}
			<ScheduleDialog
				// A schedule deleted elsewhere while its edit was open closes the dialog.
				open={editor.open && (editor.id === null || editing !== null)}
				opening={editor.opening}
				schedule={editor.id === null ? null : editing}
				templates={templates}
				sources={sources}
				onClose={() => setEditor((e) => ({ ...e, open: false }))}
				onSaved={(view, created) => {
					replaceRow(view);
					setEditor((e) => ({ ...e, open: false }));
					announce(t(created ? M.created : M.saved, { name: view.name }));
				}}
				onReload={async () => (await reloadList())?.find((s) => s.id === editor.id)}
			/>
			<RunLog
				schedule={runLog.open ? logged : null}
				onClose={() => setRunLog((r) => ({ ...r, open: false }))}
			/>
			<ConfirmDialog
				open={deleting.open && doomed !== null}
				title={doomed === null ? "" : t(M.deleteTitle, { name: doomed.name })}
				sentence={doomed === null ? "" : t(M.deleteSentence, { name: doomed.name })}
				confirmLabel={t(M.deleteConfirm)}
				danger
				busy={deleteBusy}
				error={
					deleteError === null ? undefined : (
						<ActionError
							error={deleteError}
							reloading={reloading}
							onReload={() => {
								void reloadList().then(() => setDeleteError(null));
							}}
						/>
					)
				}
				onConfirm={() => {
					if (doomed !== null) void remove(doomed);
				}}
				onClose={() => setDeleting((d) => ({ ...d, open: false }))}
			/>
		</div>
	);
}

function RowButton(props: {
	label: string;
	name: string;
	busy: boolean;
	disabled: boolean;
	onClick(): void;
}) {
	return (
		<Button
			variant="secondary"
			size="sm"
			loading={props.busy}
			aria-label={props.name}
			aria-busy={props.busy || undefined}
			disabled={props.disabled}
			onClick={props.onClick}
		>
			{props.label}
		</Button>
	);
}

/**
 * A row action's refusal in words, named by the row when `name` is given. A stale revision reads
 * as changed elsewhere, with Reload (coordinator note F17).
 */
function ActionError(props: {
	name?: string;
	error: unknown;
	/** A refusal made here, before any request. */
	said?: Msg;
	reloading: boolean;
	onReload(): void;
}) {
	const t = useT();
	if (props.error instanceof ApiError && props.error.code === "SCHEDULE_CHANGED") {
		return (
			<Banner
				variant="error"
				role="alert"
				title={t(M.changedElsewhere)}
				action={
					<Button
						variant="secondary"
						loading={props.reloading}
						aria-label={t(M.reload)}
						aria-busy={props.reloading || undefined}
						disabled={props.reloading}
						onClick={props.onReload}
					>
						{t(M.reload)}
					</Button>
				}
			/>
		);
	}
	const { msg, values, detail } =
		props.said === undefined ? describeError(props.error) : { msg: props.said };
	const reason = t(msg, values);
	return (
		<Banner
			variant="error"
			role="alert"
			title={props.name === undefined ? reason : t(M.actionFailed, { name: props.name, reason })}
			{...(detail === undefined ? {} : { description: detail })}
		/>
	);
}

function ListError(props: { error: unknown; retrying: boolean; onRetry(): void }) {
	const t = useT();
	const { msg, values, detail } = describeError(props.error);
	const forbidden = isForbidden(props.error);
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(msg, values)}
			{...(detail === undefined ? {} : { description: detail })}
			{...(forbidden
				? {}
				: {
						action: (
							<Button
								variant="secondary"
								loading={props.retrying}
								aria-label={t(PAGE.tryAgain)}
								aria-busy={props.retrying || undefined}
								onClick={props.onRetry}
							>
								{t(PAGE.tryAgain)}
							</Button>
						),
					})}
		/>
	);
}
