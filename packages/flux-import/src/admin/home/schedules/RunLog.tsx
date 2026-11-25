import { Badge, Button, Dialog, Link, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import type { RunEntry, ScheduleView } from "../../../plugin/schedules.js";
import { type Msg, useT } from "../../i18n.js";
import { runUrl } from "../links.js";
import { utcLabel } from "./cron.js";
import { M, RUN_OUTCOMES } from "./messages.js";

/** A run's counts in words: the four every run has, then any other that is not zero. */
function Counts(props: { counters: RunEntry["counters"] }) {
	const t = useT();
	const c = props.counters;
	const extra = [
		[M.countRemoved, c.removed],
		[M.countConflict, c.conflict],
		[M.countLocked, c.locked],
	] as const;
	const parts = [
		t(M.counts, {
			created: c.created,
			updated: c.updated,
			unchanged: c.unchanged,
			failed: c.failed,
		}),
		...extra.filter(([, n]) => n > 0).map(([msg, n]) => t(msg, { count: n })),
	];
	return <>{parts.join(" ")}</>;
}

/** A run's outcome in words; one a newer version added reads as unknown. */
function outcomeOf(outcome: string): Msg {
	return Object.hasOwn(RUN_OUTCOMES, outcome)
		? RUN_OUTCOMES[outcome as keyof typeof RUN_OUTCOMES]
		: M.runUnknown;
}

/**
 * A schedule's run log (`runs`, newest first): when each run finished, its outcome and counts in
 * words, and its job linked to the wizard's Run screen (a full page load, plan Ruling 11).
 */
export function RunLog(props: { schedule: ScheduleView | null; onClose(): void }) {
	const t = useT();
	const { i18n } = useLingui();
	const s = props.schedule;
	return (
		<Dialog.Root
			open={s !== null}
			onOpenChange={(open: boolean) => {
				if (!open) props.onClose();
			}}
		>
			<Dialog size="xl" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">
					{s === null ? null : t(M.runLogTitle, { name: s.name })}
				</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{t(M.runLogSentence)}
				</Dialog.Description>
				{s === null ? null : s.runs.length === 0 ? (
					<p className="text-sm">{t(M.noRuns)}</p>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t(M.colFinished)}</Table.Head>
									<Table.Head>{t(M.colOutcome)}</Table.Head>
									<Table.Head>{t(M.colCounts)}</Table.Head>
									<Table.Head>{t(M.colImport)}</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{s.runs.map((run) => {
									const when = t(M.utcTime, { time: utcLabel(run.at, i18n.locale) });
									return (
										<Table.Row key={run.jobId}>
											<Table.Cell>
												<time dateTime={run.at}>{when}</time>
											</Table.Cell>
											<Table.Cell>
												<div className="flex flex-wrap items-center gap-2">
													<span>{t(outcomeOf(run.outcome))}</span>
													{run.rolledBack === undefined ? null : (
														<Badge variant="secondary">{t(M.rolledBack)}</Badge>
													)}
												</div>
											</Table.Cell>
											<Table.Cell>
												<Counts counters={run.counters} />
											</Table.Cell>
											<Table.Cell>
												<Link href={runUrl(run.jobId)} aria-label={t(M.openRunRow, { when })}>
													{t(M.openRun)}
												</Link>
											</Table.Cell>
										</Table.Row>
									);
								})}
							</Table.Body>
						</Table>
					</div>
				)}
				<div className="flex justify-end">
					<Button variant="secondary" onClick={props.onClose}>
						{t(M.close)}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
