import { useLingui } from "@lingui/react";
import type { Msg, Values } from "../../i18n.js";
import { useT } from "../../i18n.js";
import { M } from "./messages.js";

/** One clock for every label, in UTC, so a column of times never mixes zones or 12 and 24 hours. */
const CLOCK: Intl.DateTimeFormatOptions = {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
};

const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * A time as people say it, always in UTC as schedules are (Critique 11): "Today 10:14 UTC",
 * "Yesterday 10:14 UTC", or the day and month ("24 Nov 10:14 UTC"), with the year when it is
 * not this year. Text that is not a time stays as it is. `iso` is an ISO 8601 string, as every
 * timestamp the plugin returns is.
 */
export function whenLabel(
	iso: string,
	now: number,
	locale: string,
	t: (m: Msg, v?: Values) => string,
): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const time = new Intl.DateTimeFormat(locale, CLOCK).format(at);
	const today = new Date(now);
	const days = Math.round((dayOf(today) - dayOf(at)) / 86_400_000);
	if (days === 0) return t(M.today, { time });
	if (days === 1) return t(M.yesterday, { time });
	const date = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
		...(at.getUTCFullYear() === today.getUTCFullYear() ? {} : { year: "numeric" }),
		timeZone: "UTC",
	}).format(at);
	return t(M.dated, { date, time });
}

/** A time with its exact value as the tooltip and as text for screen readers. */
export function When(props: { iso: string }) {
	const t = useT();
	const { i18n } = useLingui();
	const at = new Date(props.iso);
	const exact = Number.isNaN(at.getTime())
		? props.iso
		: // The label's own 24-hour clock, so the tooltip never reads 2:05 PM beside 14:05.
			t(M.dated, {
				date: new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeZone: "UTC" }).format(
					at,
				),
				time: new Intl.DateTimeFormat(i18n.locale, {
					timeStyle: "medium",
					hourCycle: "h23",
					timeZone: "UTC",
				}).format(at),
			});
	return (
		<time dateTime={props.iso} title={exact}>
			{whenLabel(props.iso, Date.now(), i18n.locale, t)}
			<span className="sr-only">{exact}</span>
		</time>
	);
}
