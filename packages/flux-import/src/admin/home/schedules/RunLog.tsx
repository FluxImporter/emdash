import { Badge, Button, Dialog, LinkButton, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import type { RunEntry, ScheduleView } from "../../../plugin/schedules.js";
import { type Msg, useT, useTn } from "../../i18n.js";
import { RecordCounts } from "../../ui/RecordCounts.js";
import { runUrl } from "../links.js";
import { When, whenLabel } from "../shared/When.js";
import { describeTiming, fromCron } from "./cron.js";
import { M, N, RUN_OUTCOMES } from "./messages.js";

/** A run's outcome in words; one a newer version added reads as unknown. */
function outcomeOf(outcome: string): Msg {
	return Object.hasOwn(RUN_OUTCOMES, outcome)
		? RUN_OUTCOMES[outcome as keyof typeof RUN_OUTCOMES]
		: M.runUnknown;
}

/**
 * A run's outcome as a coloured dot and its words. Not a Badge: Kumo's badge never wraps, and
 * "Stopped: too many entries were missing from the feed" must. The words carry the meaning.
 */
export function RunOutcome(props: { outcome: string }) {
	const t = useT();
	const { outcome } = props;
	return (
		<span className="inline-flex items-baseline gap-1.5">
			<span
				aria-hidden="true"
				className={
					outcome === "completed"
						? "size-2 shrink-0 rounded-full bg-kumo-success"
						: outcome === "failed"
							? "size-2 shrink-0 rounded-full bg-kumo-danger"
							: outcome === "missing_refused" || outcome === "empty_feed"
								? "size-2 shrink-0 rounded-full bg-kumo-warning"
								: "size-2 shrink-0 rounded-full bg-kumo-fill"
				}
			/>
			<span>{t(outcomeOf(outcome))}</span>
		</span>
	);
}

/** A run's counters as the Jobs rows show them: zero counts hidden, unchanged only when alone. */
function Counts(props: { counters: RunEntry["counters"] }) {
	return <RecordCounts counts={props.counters} quiet={["unchanged"]} small />;
}

/**
 * A schedule's run log (RunLog.dc.html; `runs`, newest first): when each run finished (UTC), its
 * outcome and counts, and its job linked to the wizard's Run screen (a full page load, plan
 * Ruling 11).
 */
export function RunLog(props: { schedule: ScheduleView | null; onClose(): void }) {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const s = props.schedule;
	const timing = s === null ? null : describeTiming(fromCron(s.cron));
	return (
		<Dialog.Root
			open={s !== null}
			onOpenChange={(open: boolean) => {
				if (!open) props.onClose();
			}}
		>
			<Dialog size="xl" className="flex flex-col gap-4 p-6">
				<div className="flex flex-col gap-1">
					<Dialog.Title className="text-lg font-semibold text-kumo-default">
						{s === null ? null : t(M.runLogTitle, { name: s.name })}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-kumo-subtle">
						{s === null || timing === null
							? null
							: s.runs.length === 0
								? t(timing.msg, timing.values)
								: tn(N.runLogSentence, s.runs.length, {
										timing: t(timing.msg, timing.values),
									})}
					</Dialog.Description>
				</div>
				{s === null ? null : s.runs.length === 0 ? (
					<p className="text-sm">{t(M.noRuns)}</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-kumo-hairline">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t(M.colFinished)}</Table.Head>
									<Table.Head>{t(M.colOutcome)}</Table.Head>
									<Table.Head>{t(M.colCounts)}</Table.Head>
									<Table.Head>
										<span className="sr-only">{t(M.colImport)}</span>
									</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{s.runs.map((run) => {
									const when = whenLabel(run.at, Date.now(), i18n.locale, t);
									return (
										<Table.Row key={run.jobId}>
											<Table.Cell className="whitespace-nowrap text-sm tabular-nums">
												<When iso={run.at} />
											</Table.Cell>
											<Table.Cell className="text-sm">
												<div className="flex flex-wrap items-center gap-2">
													<RunOutcome outcome={run.outcome} />
													{run.rolledBack === undefined ? null : (
														<Badge variant="neutral">{t(M.rolledBack)}</Badge>
													)}
												</div>
											</Table.Cell>
											<Table.Cell>
												<Counts counters={run.counters} />
											</Table.Cell>
											<Table.Cell className="text-right">
												<LinkButton
													variant="ghost"
													size="sm"
													href={runUrl(run.jobId)}
													aria-label={t(M.openRunRow, { when })}
												>
													{t(M.openRun)}
												</LinkButton>
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
