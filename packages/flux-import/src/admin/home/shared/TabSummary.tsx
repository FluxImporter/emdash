import type { ReactNode } from "react";

/**
 * The one line each tab opens with (Critique 10): what is here, lead in bold ("23 imports"),
 * then the rest ("1 running · 1 failed this week"), and the tab's action on the right.
 * On the page canvas, so the text is text-kumo-default (text-kumo-subtle passes AA only on
 * bg-kumo-base).
 */
export function TabSummary(props: { lead: string; rest?: readonly string[]; action?: ReactNode }) {
	const rest = props.rest?.filter((s) => s !== "") ?? [];
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<p className="text-sm text-kumo-default">
				<span className="font-semibold">{props.lead}</span>
				{rest.map((s) => (
					<span key={s}> · {s}</span>
				))}
			</p>
			{props.action ?? null}
		</div>
	);
}
