import { useLingui } from "@lingui/react";
import { useT, useTn } from "../i18n.js";
import { COUNTS, type CountKey, M } from "./messages.js";

/** The order counts are read in, wherever they appear. */
const ORDER: readonly CountKey[] = [
	"created",
	"updated",
	"reverted",
	"removed",
	"kept",
	"unchanged",
	"filtered",
	"conflict",
	"locked",
	"failed",
];

/** Keys whose count, when not zero, is a problem: shown in the danger colour. */
const DANGER: ReadonlySet<CountKey> = new Set(["failed", "conflict"]);

/**
 * Record counts as one line (Critique 2): zero counts hidden, numbers bold, failures in danger,
 * "No changes" when every count is zero. `quiet` keys (e.g. unchanged) are left out unless they
 * are the only non-zero count. The same format on Jobs, the run log and the Run step.
 */
export function RecordCounts(props: {
	counts: Partial<Record<CountKey, number>>;
	quiet?: readonly CountKey[];
	/** Smaller text, for table cells and stacked rows. */
	small?: boolean;
}) {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const format = (n: number) => new Intl.NumberFormat(i18n.locale || "en").format(n);
	const nonZero = ORDER.filter((k) => (props.counts[k] ?? 0) > 0);
	const loud = nonZero.filter((k) => !props.quiet?.includes(k));
	const shown = loud.length > 0 ? loud : nonZero;
	if (shown.length === 0) {
		return <p className={props.small ? "text-xs" : "text-sm"}>{t(M.noChanges)}</p>;
	}
	return (
		<p
			className={
				props.small
					? "flex flex-wrap gap-x-3 gap-y-1 text-xs"
					: "flex flex-wrap gap-x-3 gap-y-1 text-sm"
			}
		>
			{shown.map((k) => {
				const n = props.counts[k] ?? 0;
				const text = tn(COUNTS[k], n);
				const number = format(n);
				const at = text.indexOf(number);
				return (
					<span key={k} className={DANGER.has(k) ? "text-kumo-danger" : ""}>
						{at < 0 ? (
							text
						) : (
							<>
								{text.slice(0, at)}
								<span className="font-semibold tabular-nums">{number}</span>
								{text.slice(at + number.length)}
							</>
						)}
					</span>
				);
			})}
		</p>
	);
}
