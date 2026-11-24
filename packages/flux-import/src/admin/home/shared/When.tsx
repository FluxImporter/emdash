import { useLingui } from "@lingui/react";
import type { Msg, Values } from "../../i18n.js";
import { useT } from "../../i18n.js";
import { M } from "./messages.js";

const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A time as people say it (plan Ruling 20): "today 10:14", "yesterday 10:14", or an older one as a
 * medium date and short time. Days are the viewer's own. Text that is not a time stays as it is.
 */
export function whenLabel(
	iso: string,
	now: number,
	locale: string,
	t: (m: Msg, v?: Values) => string,
): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const clock = (): string =>
		new Intl.DateTimeFormat(locale, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(at);
	const days = Math.round((dayOf(new Date(now)) - dayOf(at)) / 86_400_000);
	if (days === 0) return t(M.today, { time: clock() });
	if (days === 1) return t(M.yesterday, { time: clock() });
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** A time with its exact value as the tooltip and as text for screen readers. */
export function When(props: { iso: string }) {
	const t = useT();
	const { i18n } = useLingui();
	const at = new Date(props.iso);
	const exact = Number.isNaN(at.getTime())
		? props.iso
		: new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "medium" }).format(at);
	return (
		<time dateTime={props.iso} title={exact}>
			{whenLabel(props.iso, Date.now(), i18n.locale, t)}
			<span className="sr-only">{exact}</span>
		</time>
	);
}
