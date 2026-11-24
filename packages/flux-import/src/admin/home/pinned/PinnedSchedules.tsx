import { Checkbox } from "@cloudflare/kumo";
import { useId } from "react";
import type { ScheduleView } from "../../../plugin/schedules.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M } from "./messages.js";
import type { PinChange } from "./pinned.js";

/**
 * Names the schedules a template's or source's save re-pins, with "Also update these schedules"
 * (checked by default, the caller's state). Unchecked, it says they will pause; for a source,
 * checked, it says what the update also does. Nothing without rows.
 */
export function PinnedSchedules(props: {
	rows: readonly ScheduleView[];
	kind: PinChange["kind"];
	checked: boolean;
	onCheckedChange(checked: boolean): void;
}) {
	const t = useT();
	const noteId = useId();
	if (props.rows.length === 0) return null;
	const names = props.rows.map((s) => s.name).join(", ");
	const note = !props.checked ? t(M.willPause) : props.kind === "source" ? t(M.sourceRearm) : null;
	return (
		<div className="space-y-2">
			<p className="text-sm">
				{t(props.kind === "template" ? M.templateRows : M.sourceRows, { names })}
			</p>
			<Checkbox
				label={t(M.alsoUpdate)}
				checked={props.checked}
				onCheckedChange={(checked: boolean) => props.onCheckedChange(checked)}
				{...(note === null ? {} : { "aria-describedby": noteId })}
			/>
			{note === null ? null : (
				<p id={noteId} className="text-sm text-kumo-subtle">
					{note}
				</p>
			)}
		</div>
	);
}

/** Each schedule whose update failed after the save, by name, with the reason as a sentence. */
export function PinnedFailures(props: { failed: { name: string; error: unknown }[] }) {
	const t = useT();
	if (props.failed.length === 0) return null;
	return (
		<ul className="space-y-1 text-sm text-kumo-danger">
			{props.failed.map((f) => {
				const { msg, values } = describeError(f.error);
				// Schedule names are unique (`schedules/create` refuses a taken one).
				return <li key={f.name}>{t(M.failed, { name: f.name, reason: t(msg, values) })}</li>;
			})}
		</ul>
	);
}
