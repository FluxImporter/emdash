import { Input } from "@cloudflare/kumo";
import { useDraggable } from "@dnd-kit/core";
import { type ChangeEvent, useId, useMemo, useState } from "react";
import { useT } from "../../i18n.js";
import { KEYS_SHOWN } from "../../limits.js";
import type { SampleColumn } from "../../types.js";
import { M } from "./messages.js";

/** The draggable ID of a source key; `keyOfDrag` reads it back. */
export const dragId = (key: string) => `key:${key}`;
export const keyOfDrag = (id: string | number) => String(id).slice("key:".length);

const count = (n: number) => n.toLocaleString("en-US");

/** A sample value as one line of text: a string as it is, anything else as JSON. */
function sampleOf(values: readonly unknown[] | undefined): string {
	const value = values?.find((v) => v !== undefined && v !== null && v !== "");
	if (value === undefined) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The Map step's left pane (spec "3. Map"): one draggable row per source key, with one sample
 * value. Used keys are dimmed but stay draggable, as one key may feed several fields. A filter
 * finds any key; at most `KEYS_SHOWN` rows are listed (Review Focus 4). `extraKeys` are keys a row
 * uses that the sample lacks (preflight F24), listed without a value.
 */
export function KeysPane(p: {
	columns: readonly SampleColumn[];
	extraKeys: readonly string[];
	used: ReadonlySet<string>;
}) {
	const t = useT();
	const headingId = useId();
	const [query, setQuery] = useState("");
	const keys = useMemo(
		() => [...p.columns.map((c) => c.key), ...p.extraKeys],
		[p.columns, p.extraKeys],
	);
	const values = useMemo(() => new Map(p.columns.map((c) => [c.key, c.values])), [p.columns]);
	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		return q === "" ? keys : keys.filter((k) => k.toLowerCase().includes(q));
	}, [keys, query]);
	const shown = matches.slice(0, KEYS_SHOWN);
	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 rounded-lg border border-kumo-line p-3"
		>
			<h3 id={headingId} className="text-base font-semibold">
				{t(M.keysHeading, { count: count(keys.length) })}
			</h3>
			<Input
				label={t(M.filterKeys)}
				value={query}
				onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
			/>
			{matches.length > KEYS_SHOWN ? (
				<p className="text-sm text-kumo-subtle">
					{t(M.keysShown, { shown: count(shown.length), total: count(matches.length) })}
				</p>
			) : null}
			{shown.length === 0 ? (
				<p className="text-sm text-kumo-subtle">{t(M.noKeyMatches)}</p>
			) : (
				// Scrolls on its own: the dragged key is drawn in Map's `DragOverlay`, outside it.
				<ul className="max-h-96 space-y-1 overflow-y-auto">
					{shown.map((key) => (
						<KeyRow
							key={key}
							name={key}
							sample={values.has(key) ? sampleOf(values.get(key)) : null}
							used={p.used.has(key)}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function KeyRow(p: { name: string; sample: string | null; used: boolean }) {
	const t = useT();
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: dragId(p.name),
	});
	return (
		<li>
			<div
				ref={setNodeRef}
				data-testid={dragId(p.name)}
				title={p.name}
				{...attributes}
				{...listeners}
				className={
					isDragging
						? "flex cursor-grab touch-none items-center justify-between gap-2 rounded-md border border-dashed border-kumo-brand bg-kumo-base px-2 py-1 text-sm"
						: p.used
							? "flex cursor-grab touch-none items-center justify-between gap-2 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-sm opacity-50"
							: "flex cursor-grab touch-none items-center justify-between gap-2 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-sm"
				}
			>
				<span className="min-w-0 truncate font-medium" title={p.name}>
					{p.name}
				</span>
				<span className="min-w-0 truncate text-xs text-kumo-subtle">
					{p.sample === null ? t(M.noSample) : p.sample}
				</span>
				{p.used ? <span className="sr-only">{t(M.used)}</span> : null}
			</div>
		</li>
	);
}
