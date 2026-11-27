import { Badge, Banner, Button, DropdownMenu, Empty, Link, Switch, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ScheduleView, UpdateScheduleInput } from "../../../plugin/schedules.js";
import { api } from "../../api.js";
import { ApiError, isForbidden } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { type Msg, useT, useTn } from "../../i18n.js";
import { MAX_SCHEDULES } from "../../limits.js";
import {
	queryKeys,
	useAllSources,
	useAllTemplates,
	useFence,
	useSchedules,
} from "../../queries.js";
import { CheckIcon, ClockIcon, DotsThreeIcon, PlusIcon } from "../../ui/icons.js";
import { Forbidden, LoadFailed, LoadingRows } from "../../ui/states.js";
import { useNarrow } from "../../ui/use-narrow.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { TabSummary } from "../shared/TabSummary.js";
import { When, whenLabel } from "../shared/When.js";
import { urlLabel } from "../sources/display.js";
import { SourceDialog } from "../sources/SourceDialog.js";
import { describeTiming, fromCron, launchMessage, pauseMessage } from "./cron.js";
import { FenceBanner } from "./FenceBanner.js";
import { CircleIcon } from "./icons.js";
import { M, N } from "./messages.js";
import { RunLog, RunOutcome } from "./RunLog.js";
import { ScheduleDialog } from "./ScheduleDialog.js";

type Action = "pause" | "resume" | "run" | "repin";

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

/** One row's parts, laid out as table cells when wide and as a stacked row when narrow. */
interface RowParts {
	id: string;
	schedule: ReactNode;
	source: ReactNode;
	when: ReactNode;
	last: ReactNode;
	active: ReactNode;
	actions: ReactNode;
}

/**
 * The Schedules tab (Schedules.dc.html): the fence, the summary line with New schedule, and each
 * schedule with its template, source, timing and next run (UTC), last launch, the run log, an
 * Active switch (Pause and Resume), Run now and a menu. `useSchedules` and `useFence` are read
 * here together, so the fence follows the list's interval as soon as a schedule is due (Task 6
 * review).
 */
export function SchedulesTab() {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const { announce, goTo, focusHeading } = useHome();
	const client = useQueryClient();
	const replaceRow = useReplaceRow();
	const schedules = useSchedules();
	const fence = useFence();
	const templates = useAllTemplates();
	const sources = useAllSources();
	const limitId = useId();
	const [narrowRef, narrow] = useNarrow<HTMLDivElement>();
	const newRef = useRef<HTMLButtonElement>(null);

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
	const [addingSource, setAddingSource] = useState(false);

	// The empty state's "Add a source" goes once a source is saved: focus moves on to New schedule
	// rather than to the page.
	const sourceCount = sources.data?.length;
	const lastSourceCount = useRef(sourceCount);
	useEffect(() => {
		const before = lastSourceCount.current;
		lastSourceCount.current = sourceCount;
		if (before === 0 && sourceCount !== undefined && sourceCount > 0) {
			if (document.activeElement === null || document.activeElement === document.body) {
				newRef.current?.focus();
			}
		}
	}, [sourceCount]);

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

	/**
	 * The pin to the template's current version, read now (a cached body may be older); null, with
	 * the reason shown, when the template is no longer saved (coordinator ruling b).
	 */
	const currentPin = async (s: ScheduleView): Promise<Partial<UpdateScheduleInput> | null> => {
		if (templates.data !== undefined && !templates.data.some((x) => x.id === s.templateId)) {
			setFailed({ name: s.name, said: M.resumeTemplateGone });
			return null;
		}
		const current = await client.fetchQuery({
			queryKey: queryKeys.template(s.templateId),
			queryFn: () => api.getTemplate({ id: s.templateId }),
			staleTime: 0,
		});
		// A threshold the current version no longer allows goes with it; a missing choice it newly
		// asks for is the server's sentence (MISSING_REQUIRED).
		const dropped = current.template.rules?.missing === undefined && s.missing !== undefined;
		return {
			templateId: s.templateId,
			templateRevision: current.revision,
			...(dropped ? { missing: null } : {}),
		};
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
			} else if (action === "repin") {
				// An enabled schedule on an older revision pauses at its next run: re-pinned, it
				// stays enabled.
				const pin = await currentPin(s);
				if (pin === null) return;
				const reply = await api.updateSchedule({ id: s.id, revision: s.revision, ...pin });
				replaceRow(reply.schedule);
				// The note compares with the listed revision: a stale list must not keep it.
				void client.invalidateQueries({ queryKey: queryKeys.allTemplates });
				announce(t(M.repinned, { name: reply.schedule.name }));
			} else {
				const enabled = action === "resume";
				let input: UpdateScheduleInput = { id: s.id, revision: s.revision, enabled };
				if (enabled && s.pause?.reason === "template_changed") {
					// Enabling re-pins only the source: the template is re-pinned here, to its
					// current revision (coordinator ruling b).
					const pin = await currentPin(s);
					if (pin === null) return;
					input = { ...input, ...pin };
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
		if (!schedules.isError) {
			return <LoadingRows label={t(M.loading)} columns={5} />;
		}
		return isForbidden(schedules.error) ? (
			// No retry changes a role.
			<Forbidden />
		) : (
			<LoadFailed
				title={t(M.loadFailed)}
				error={schedules.error}
				retrying={schedules.isFetching}
				onRetry={() => void schedules.refetch()}
			/>
		);
	}

	const full = rows.length >= MAX_SCHEDULES;
	const editing = find(editor.id);
	const logged = find(runLog.id);
	const doomed = find(deleting.id);
	const openNew = () => setEditor((e) => ({ id: null, opening: e.opening + 1, open: true }));
	const newButton = (
		<Button
			ref={newRef}
			variant="secondary"
			icon={<PlusIcon aria-hidden="true" />}
			disabled={full}
			{...(full ? { "aria-describedby": limitId } : {})}
			onClick={openNew}
		>
			{t(M.newSchedule)}
		</Button>
	);

	const templateLine = (s: ScheduleView): string | null => {
		if (templates.data === undefined) return null;
		const listed = templates.data.find((x) => x.id === s.templateId);
		if (listed === undefined) return t(M.deletedTemplate);
		return t(M.templateTarget, {
			template: listed.name,
			collection: listed.collection,
			locale: listed.locale,
		});
	};

	const partsOf = (s: ScheduleView): RowParts => {
		const timing = describeTiming(fromCron(s.cron));
		const mine = busy?.id === s.id;
		const launch = s.lastLaunch;
		const lastRun = s.runs[0];
		const listed = templates.data?.find((x) => x.id === s.templateId);
		const templateGone =
			templates.data !== undefined && !templates.data.some((x) => x.id === s.templateId);
		// Enabled on an older revision: it pauses at its next launch.
		const outdated = s.enabled && listed !== undefined && listed.revision !== s.templateRevision;
		const source = sources.data?.find((x) => x.id === s.sourceId);
		const template = templateLine(s);
		const toggling = mine && (busy?.action === "pause" || busy?.action === "resume");
		return {
			id: s.id,
			schedule: (
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="break-words font-semibold text-kumo-default">{s.name}</span>
					{template === null ? null : <span className="text-sm text-kumo-subtle">{template}</span>}
				</div>
			),
			source:
				sources.data === undefined ? null : (
					<div className="flex min-w-0 flex-col gap-0.5 text-sm">
						<span className="break-words font-medium">{source?.name ?? t(M.deletedSource)}</span>
						{source === undefined ? null : (
							<span className="truncate font-mono text-xs text-kumo-subtle">
								{urlLabel(source.url)}
							</span>
						)}
					</div>
				),
			when: (
				<div className="flex flex-col items-start gap-1 text-sm">
					<span>{t(timing.msg, timing.values)}</span>
					{s.due !== undefined ? (
						<Badge variant="info">{t(M.stateQueued)}</Badge>
					) : s.enabled ? (
						s.nextRunAt === null ? (
							<span className="text-kumo-subtle">{t(M.notScheduled)}</span>
						) : (
							<time dateTime={s.nextRunAt} className="text-kumo-subtle">
								{t(M.next, { when: whenLabel(s.nextRunAt, Date.now(), i18n.locale, t) })}
							</time>
						)
					) : (
						<>
							<Badge variant="orange">{t(M.statePaused)}</Badge>
							{s.pause === undefined ? null : (
								<span className="text-kumo-subtle">
									{pauseMessage(s.pause.reason) === M.pauseUnknown
										? t(M.pausedUnknown)
										: t(M.pausedBecause, { reason: t(pauseMessage(s.pause.reason)) })}
								</span>
							)}
						</>
					)}
					{s.pause?.reason === "template_changed" && !s.enabled ? (
						<span className="text-kumo-subtle">
							{t(templateGone ? M.resumeTemplateGone : M.resumeRepins)}
						</span>
					) : null}
					{outdated ? (
						<>
							<span className="text-kumo-subtle">{t(M.willPause)}</span>
							<Button
								variant="outline"
								size="sm"
								loading={mine && busy?.action === "repin"}
								aria-label={t(M.repinRow, { name: s.name })}
								aria-busy={(mine && busy?.action === "repin") || undefined}
								disabled={mine}
								onClick={() => void act(s, "repin")}
							>
								{t(M.repin)}
							</Button>
						</>
					) : null}
				</div>
			),
			last: (
				<div className="flex flex-col items-start gap-1 text-sm">
					{launch === undefined ? (
						<span>{t(M.neverLaunched)}</span>
					) : (
						<>
							<When iso={launch.at} />
							<span className={launch.outcome === "failed" ? "text-kumo-danger" : ""}>
								{launch.outcome === "failed"
									? t(M.launchFailed, { reason: t(launchMessage(launch)) })
									: t(launchMessage(launch))}
							</span>
						</>
					)}
					<div className="flex flex-wrap items-center gap-2">
						{lastRun === undefined ? null : <RunOutcome outcome={lastRun.outcome} />}
						<Button
							variant="ghost"
							size="sm"
							aria-label={t(M.runLogRow, { name: s.name })}
							onClick={() => setRunLog({ id: s.id, open: true })}
						>
							{t(M.runLog)}
						</Button>
					</div>
				</div>
			),
			active: (
				<Switch
					size="sm"
					checked={s.enabled}
					disabled={mine}
					transitioning={toggling}
					aria-label={t(M.activeRow, { name: s.name })}
					onCheckedChange={(on: boolean) => void act(s, on ? "resume" : "pause")}
				/>
			),
			actions: (
				<div className="flex items-center justify-end gap-1">
					{/* A paused or disabled schedule cannot run (SCHEDULE_DISABLED): switch it on first. */}
					{s.enabled ? (
						<Button
							variant="ghost"
							size="sm"
							loading={mine && busy?.action === "run"}
							aria-label={t(M.runNowRow, { name: s.name })}
							aria-busy={(mine && busy?.action === "run") || undefined}
							disabled={mine}
							onClick={() => void act(s, "run")}
						>
							{t(M.runNow)}
						</Button>
					) : null}
					<DropdownMenu>
						<DropdownMenu.Trigger>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<DotsThreeIcon aria-hidden="true" size={16} />}
								aria-label={t(M.actionsRow, { name: s.name })}
								disabled={mine}
							/>
						</DropdownMenu.Trigger>
						<DropdownMenu.Content>
							<DropdownMenu.Item
								aria-label={t(M.editRow, { name: s.name })}
								onClick={() => setEditor((e) => ({ id: s.id, opening: e.opening + 1, open: true }))}
							>
								{t(M.edit)}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								variant="danger"
								aria-label={t(M.deleteRow, { name: s.name })}
								onClick={() => {
									setDeleteError(null);
									setDeleting({ id: s.id, open: true });
								}}
							>
								{t(M.delete)}
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu>
				</div>
			),
		};
	};

	const paused = rows.filter((s) => !s.enabled).length;
	const active = rows.length - paused;
	const parts = rows.map(partsOf);

	return (
		<div ref={narrowRef} className="flex flex-col gap-4">
			{fence.isError ? (
				// Unread, the fence may hold scheduled runs back: said as the failed check.
				<FenceBanner fence="error" />
			) : fence.data === undefined ? null : (
				<FenceBanner fence={fence.data} />
			)}
			<TabSummary
				lead={tn(N.schedules, rows.length)}
				rest={
					rows.length === 0
						? []
						: [active > 0 ? tn(N.active, active) : "", paused > 0 ? tn(N.paused, paused) : ""]
				}
				// Empty, New schedule sits in the empty state, under what is still missing.
				action={
					rows.length === 0 ? undefined : (
						<div className="flex flex-wrap items-center justify-end gap-3">
							{/* Why it is off, before it. */}
							{full ? (
								<p id={limitId} className="text-sm text-kumo-default">
									{t(M.atLimit, { max: MAX_SCHEDULES })}
								</p>
							) : null}
							{newButton}
						</div>
					)
				}
			/>
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
				<Empty
					size="sm"
					icon={<ClockIcon aria-hidden="true" size={28} />}
					title={t(M.empty)}
					description={t(M.emptyHint)}
					contents={
						<div className="flex flex-col items-center gap-4">
							<ul className="flex flex-col gap-1.5 text-sm">
								{templates.data === undefined ? null : (
									<Check done={templates.data.length > 0}>
										{templates.data.length > 0 ? (
											tn(N.templatesSaved, templates.data.length)
										) : (
											<>
												{t(M.noTemplate)}
												{" · "}
												<Link
													render={<button type="button" />}
													onClick={() => {
														goTo("templates");
														focusHeading();
													}}
												>
													{t(M.goTemplates)}
												</Link>
											</>
										)}
									</Check>
								)}
								{sources.data === undefined ? null : (
									<Check done={sources.data.length > 0}>
										{sources.data.length > 0 ? (
											tn(N.sourcesSaved, sources.data.length)
										) : (
											<>
												{t(M.noSource)}
												{" · "}
												<Link
													render={<button type="button" />}
													onClick={() => setAddingSource(true)}
												>
													{t(M.addSource)}
												</Link>
											</>
										)}
									</Check>
								)}
							</ul>
							{newButton}
						</div>
					}
				/>
			) : narrow ? (
				<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-hairline bg-kumo-base">
					{parts.map((p) => (
						<li key={p.id} className="flex flex-col gap-2 px-4 py-3">
							<div className="flex items-start justify-between gap-3">
								{p.schedule}
								{p.active}
							</div>
							{p.source}
							{p.when}
							{p.last}
							{p.actions}
						</li>
					))}
				</ul>
			) : (
				// A long name or address widens the table, never the page.
				<div className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-base">
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t(M.colSchedule)}</Table.Head>
								<Table.Head>{t(M.colSource)}</Table.Head>
								<Table.Head>{t(M.colWhen)}</Table.Head>
								<Table.Head>{t(M.colLast)}</Table.Head>
								<Table.Head>{t(M.colActive)}</Table.Head>
								<Table.Head>
									<span className="sr-only">{t(M.colActions)}</span>
								</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{parts.map((p) => (
								<Table.Row key={p.id}>
									<Table.Cell className="align-top">{p.schedule}</Table.Cell>
									<Table.Cell className="align-top">{p.source}</Table.Cell>
									<Table.Cell className="align-top">{p.when}</Table.Cell>
									<Table.Cell className="align-top">{p.last}</Table.Cell>
									<Table.Cell className="align-top">{p.active}</Table.Cell>
									<Table.Cell className="align-top">{p.actions}</Table.Cell>
								</Table.Row>
							))}
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
			{addingSource ? <SourceDialog onClose={() => setAddingSource(false)} /> : null}
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

/** One line of the empty state's checklist: what exists (a check), or what is missing. */
function Check(props: { done: boolean; children: ReactNode }) {
	return (
		<li className="flex items-center gap-2">
			{props.done ? (
				<CheckIcon aria-hidden="true" size={16} className="shrink-0 text-kumo-success" />
			) : (
				<CircleIcon aria-hidden="true" size={16} className="shrink-0 text-kumo-subtle" />
			)}
			<span>{props.children}</span>
		</li>
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
