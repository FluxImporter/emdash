import { Badge, Button, DropdownMenu, Table } from "@cloudflare/kumo";
import type { JobListItem } from "../../../plugin/summaries.js";
import { type Msg, useT } from "../../i18n.js";
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
import { M } from "./messages.js";

/** A menu item: a `JobAction`, with the log split into all records and failed only. */
export type RowAction = JobAction | "failedLog";

/** Each menu item's visible text and its accessible name, which names the row. */
const ITEMS: Readonly<Record<RowAction, { text: Msg; row: Msg }>> = {
	open: { text: M.open, row: M.openRow },
	log: { text: M.log, row: M.logRow },
	failedLog: { text: M.failedLog, row: M.failedLogRow },
	pause: { text: M.pause, row: M.pauseRow },
	resume: { text: M.resume, row: M.resumeRow },
	retry: { text: M.retry, row: M.retryRow },
	cancel: { text: M.cancel, row: M.cancelRow },
	rollback: { text: M.rollBack, row: M.rollBackRow },
	continueRollback: { text: M.continueRollback, row: M.continueRollbackRow },
	retryRollback: { text: M.retryRollback, row: M.retryRollbackRow },
};

/** Actions that cannot be undone, shown in the menu's danger colour. */
const DANGER: ReadonlySet<RowAction> = new Set(["cancel", "rollback"]);

type BadgeVariant = "info" | "success" | "warning" | "error" | "neutral" | "secondary";

const VARIANTS: Readonly<Record<JobState, BadgeVariant>> = {
	created: "info",
	running: "info",
	paused: "warning",
	completed: "success",
	cancelled: "neutral",
	failed: "error",
	rolling_back: "info",
	rolled_back: "secondary",
	rollback_cancelled: "warning",
};

/** The menu's items in order: "log" brings "failedLog" after it when records failed. */
function menuItems(item: JobListItem): RowAction[] {
	return jobActions(item).flatMap((a): RowAction[] =>
		a === "log" && item.counters.failed > 0 ? ["log", "failedLog"] : [a],
	);
}

/**
 * One Jobs row: name, collection and locale, start time, origin, state as a badge, counts, and a
 * menu of the actions its state allows. `name` and `when` are the row's words, in every item's
 * accessible name ("Roll back Products feed, today 10:14").
 */
export function JobRow(props: {
	item: JobListItem;
	name: string;
	when: string;
	busy: boolean;
	onAction(action: RowAction): void;
}) {
	const t = useT();
	const { item, name, when } = props;
	const state = jobState(item);
	const counts = countsOf(item);
	return (
		<Table.Row>
			<Table.Cell className="break-words font-medium">{name}</Table.Cell>
			<Table.Cell className="whitespace-nowrap">
				{t(M.target, { collection: item.collection, locale: item.locale })}
			</Table.Cell>
			<Table.Cell className="whitespace-nowrap">
				<When iso={item.createdAt} />
			</Table.Cell>
			<Table.Cell>{t(originMsg(item))}</Table.Cell>
			<Table.Cell>
				<Badge variant={VARIANTS[state]}>{t(stateMsg(state))}</Badge>
			</Table.Cell>
			<Table.Cell>{t(counts.msg, counts.values)}</Table.Cell>
			<Table.Cell>
				<DropdownMenu>
					<DropdownMenu.Trigger>
						<Button
							variant="secondary"
							disabled={props.busy}
							aria-busy={props.busy || undefined}
							aria-label={t(M.actionsRow, { name, when })}
						>
							{t(M.actions)}
						</Button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						{menuItems(item).map((action) => (
							<DropdownMenu.Item
								key={action}
								{...(DANGER.has(action) ? { variant: "danger" as const } : {})}
								aria-label={t(ITEMS[action].row, { name, when })}
								onClick={() => props.onAction(action)}
							>
								{t(ITEMS[action].text)}
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu>
			</Table.Cell>
		</Table.Row>
	);
}
