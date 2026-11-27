import { Badge, Button, DropdownMenu, Table } from "@cloudflare/kumo";
import { Fragment, type ReactNode } from "react";
import type { JobListItem } from "../../../plugin/summaries.js";
import { type Msg, useT } from "../../i18n.js";
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	ClockIcon,
	DotsThreeIcon,
	DownloadSimpleIcon,
	PauseIcon,
	PlayIcon,
	RobotIcon,
	XIcon,
} from "../../ui/icons.js";
import { RecordCounts } from "../../ui/RecordCounts.js";
import { When } from "../shared/When.js";
import {
	countsOf,
	type JobAction,
	type JobState,
	jobActions,
	jobState,
	originMsg,
	stateMsg,
} from "./actions.js";
import { ArrowSquareOutIcon } from "./icons.js";
import { M } from "./messages.js";

/** A menu item: a `JobAction`, with the log split into all records and failed only. */
export type RowAction = JobAction | "failedLog";

/** Each menu item's visible text, its accessible name (which names the row) and its icon. */
const ITEMS: Readonly<Record<RowAction, { text: Msg; row: Msg; icon: ReactNode }>> = {
	open: { text: M.open, row: M.openRow, icon: <ArrowSquareOutIcon /> },
	log: { text: M.log, row: M.logRow, icon: <DownloadSimpleIcon /> },
	failedLog: {
		text: M.failedLog,
		row: M.failedLogRow,
		icon: <DownloadSimpleIcon />,
	},
	pause: { text: M.pause, row: M.pauseRow, icon: <PauseIcon /> },
	resume: { text: M.resume, row: M.resumeRow, icon: <PlayIcon /> },
	retry: { text: M.retry, row: M.retryRow, icon: <ArrowClockwiseIcon /> },
	cancel: { text: M.cancel, row: M.cancelRow, icon: <XIcon /> },
	rollback: {
		text: M.rollBack,
		row: M.rollBackRow,
		icon: <ArrowCounterClockwiseIcon />,
	},
	continueRollback: {
		text: M.continueRollback,
		row: M.continueRollbackRow,
		icon: <PlayIcon />,
	},
	retryRollback: {
		text: M.retryRollback,
		row: M.retryRollbackRow,
		icon: <ArrowClockwiseIcon />,
	},
};

/** Actions that cannot be undone, shown in the menu's danger colour. */
const DANGER: ReadonlySet<RowAction> = new Set(["cancel", "rollback"]);

/**
 * The menu's groups, a separator between them (Spec "Row menu"): look (open, logs), change the
 * run, then Roll back on its own, last.
 */
const GROUPS: readonly (readonly RowAction[])[] = [
	["open", "log", "failedLog"],
	["pause", "resume", "retry", "continueRollback", "retryRollback", "cancel"],
	["rollback"],
];

type BadgeVariant = "info" | "success" | "error" | "orange" | "secondary";

/** Spec "Status": completed teal subtle, running info, failed danger, paused orange, else neutral. */
const VARIANTS: Readonly<Record<JobState, BadgeVariant>> = {
	created: "info",
	running: "info",
	paused: "orange",
	completed: "success",
	cancelled: "secondary",
	failed: "error",
	rolling_back: "info",
	rolled_back: "secondary",
	rollback_cancelled: "orange",
};

/** States that move on by themselves: their badge's dot pulses. */
const MOVING: ReadonlySet<JobState> = new Set(["running", "rolling_back"]);

/** The menu's items in groups, in order: "log" brings "failedLog" after it when records failed. */
export function menuGroups(item: JobListItem): RowAction[][] {
	const actions = new Set<RowAction>(jobActions(item));
	if (actions.has("log") && item.counters.failed > 0) actions.add("failedLog");
	return GROUPS.map((group) => group.filter((a) => actions.has(a))).filter((g) => g.length > 0);
}

/** A row's words and handlers, shared by the table row and the stacked row. */
export interface RowProps {
	item: JobListItem;
	name: string;
	when: string;
	busy: boolean;
	onAction(action: RowAction): void;
}

/** The row's status in words, as a badge. */
function StatusBadge(props: { item: JobListItem }) {
	const t = useT();
	const state = jobState(props.item);
	return (
		<Badge variant={VARIANTS[state]} className="gap-1.5">
			{MOVING.has(state) ? (
				<span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />
			) : null}
			{t(stateMsg(state))}
		</Badge>
	);
}

/** Who started the job, with its icon; nothing for a job started from the wizard or the API. */
function Origin(props: { item: JobListItem }) {
	const t = useT();
	const msg = originMsg(props.item);
	if (msg === null) return null;
	return (
		<span className="inline-flex items-center gap-1 text-kumo-subtle">
			{props.item.origin === "agent" ? (
				<RobotIcon aria-hidden="true" />
			) : (
				<ClockIcon aria-hidden="true" />
			)}
			{t(msg)}
		</span>
	);
}

/** The row's name: a rollback's starts with the undo icon (Critique 12). */
function Name(props: { item: JobListItem; name: string }) {
	return (
		<span className="flex items-center gap-1.5 break-words font-semibold text-kumo-default">
			{props.item.kind === "rollback" ? (
				<ArrowCounterClockwiseIcon aria-hidden="true" className="shrink-0" />
			) : null}
			{props.name}
		</span>
	);
}

/** The row's counts: zeros hidden, unchanged only when nothing else changed. */
function Counts(props: { item: JobListItem }) {
	return <RecordCounts counts={countsOf(props.item)} quiet={["unchanged"]} small />;
}

/**
 * The row's actions: a ghost "…" button (named "Actions for {name}, {when}") opening a menu of
 * what its state allows, each item named with the row ("Roll back Products feed, Today 10:14
 * UTC"), destructive ones in the danger colour.
 */
export function JobMenu(props: RowProps) {
	const t = useT();
	const { name, when } = props;
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button
					variant="ghost"
					shape="square"
					icon={<DotsThreeIcon aria-hidden="true" />}
					disabled={props.busy}
					aria-busy={props.busy || undefined}
					aria-label={t(M.actionsRow, { name, when })}
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{menuGroups(props.item).map((group, n) => (
					<Fragment key={group[0]}>
						{n === 0 ? null : <DropdownMenu.Separator />}
						{group.map((action) => (
							<DropdownMenu.Item
								key={action}
								icon={ITEMS[action].icon}
								{...(DANGER.has(action) ? { variant: "danger" as const } : {})}
								aria-label={t(ITEMS[action].row, { name, when })}
								onClick={() => props.onAction(action)}
							>
								{t(ITEMS[action].text)}
							</DropdownMenu.Item>
						))}
					</Fragment>
				))}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/**
 * One Jobs row in the table (Jobs.dc.html): the name over its collection and locale, the start
 * time over its origin, the state as a badge, the counts, and the menu.
 */
export function JobRow(props: RowProps) {
	const t = useT();
	const { item } = props;
	return (
		<Table.Row>
			<Table.Cell>
				<div className="flex min-w-0 flex-col">
					<Name item={item} name={props.name} />
					<span className="text-sm text-kumo-subtle">
						{t(M.target, { collection: item.collection, locale: item.locale })}
					</span>
				</div>
			</Table.Cell>
			<Table.Cell>
				<div className="flex flex-col text-sm">
					<span className="whitespace-nowrap tabular-nums">
						<When iso={item.createdAt} />
					</span>
					<Origin item={item} />
				</div>
			</Table.Cell>
			<Table.Cell>
				<StatusBadge item={item} />
			</Table.Cell>
			<Table.Cell>
				<Counts item={item} />
			</Table.Cell>
			<Table.Cell className="text-right">
				<JobMenu {...props} />
			</Table.Cell>
		</Table.Row>
	);
}

/**
 * One Jobs row as a stacked row, below about 700px of content (Critique 1): name and menu on
 * top, then collection, locale, time and origin, then the badge and the counts.
 */
export function JobItem(props: RowProps) {
	const t = useT();
	const { item } = props;
	return (
		<li className="flex items-start gap-3 px-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<Name item={item} name={props.name} />
				<span className="flex flex-wrap items-center gap-x-2 text-sm text-kumo-subtle">
					<span>{t(M.target, { collection: item.collection, locale: item.locale })}</span>
					<When iso={item.createdAt} />
					<Origin item={item} />
				</span>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<StatusBadge item={item} />
					<Counts item={item} />
				</div>
			</div>
			<JobMenu {...props} />
		</li>
	);
}
