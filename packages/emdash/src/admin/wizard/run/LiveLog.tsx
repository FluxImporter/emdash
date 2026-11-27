import { useLingui } from "@lingui/react";
import { useId } from "react";
import { useT, useTn } from "../../i18n.js";
import { WarningIcon } from "../../ui/icons.js";
import type { LogEntry, LogText } from "./log.js";
import { LOG } from "./messages.js";

/** `at` as the time of day in UTC, as the admin shows every time ("18:42:31"). */
function timeOf(at: string, locale: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat(locale || "en", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	}).format(date);
}

/**
 * Run's log (StepRun.dc.html): the newest lines first, each with its time. Not a live region:
 * the status line above already announces the import's progress, and a line per batch would
 * talk over it. It keeps the last `LOG_MAX` lines, so it needs no scrolling of its own.
 */
export function LiveLog(props: { entries: readonly LogEntry[] }) {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const titleId = useId();
	const text = (p: LogText) => ("plural" in p ? tn(p.plural, p.count) : t(p.msg, p.values));
	return (
		<section aria-labelledby={titleId} className="flex flex-col gap-2">
			<h3 id={titleId} className="text-sm font-semibold text-kumo-default">
				{t(LOG.title)}
			</h3>
			<ol
				aria-labelledby={titleId}
				className="flex list-none flex-col rounded-lg border border-kumo-hairline bg-kumo-base px-4 py-2 font-mono text-xs leading-5"
			>
				{props.entries.map((e) => (
					<li
						key={e.id}
						className={
							e.tone === "subtle"
								? "flex min-w-0 gap-3 text-kumo-subtle"
								: e.tone === "danger"
									? "flex min-w-0 gap-3 text-kumo-danger"
									: "flex min-w-0 gap-3 text-kumo-default"
						}
					>
						<time dateTime={e.at} className="shrink-0 tabular-nums text-kumo-subtle">
							{timeOf(e.at, i18n.locale)}
						</time>
						<span className="flex min-w-0 items-start gap-1.5 break-words">
							{e.tone === "warning" ? (
								<WarningIcon aria-hidden="true" className="mt-0.5 shrink-0 text-kumo-warning" />
							) : null}
							<span className="min-w-0">
								{e.parts.map(text).join(" · ")}
								{e.detail === undefined ? null : ` ${e.detail}`}
							</span>
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}
