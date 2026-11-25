import { Input } from "@cloudflare/kumo";
import { useDraggable } from "@dnd-kit/core";
import { type ChangeEvent, useId, useMemo, useState } from "react";
import { useT, useTn } from "../../i18n.js";
import { KEYS_SHOWN } from "../../limits.js";
import type { SampleColumn } from "../../types.js";
import { COUNT, M } from "./messages.js";

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
 * The Map step's keys pane (StepMap.dc.html): one draggable row per source key, with where it is
 * used (or "unused") and one sample value. Used keys stay draggable, as one key may feed several
 * fields. A filter finds any key; at most `KEYS_SHOWN` rows are listed (Review Focus 4).
 * `extraKeys` are keys a row uses that the sample lacks (preflight F24), listed without a value.
 * `usage` maps each used key to the rows that read it. `wide` lists the keys side by side, for a
 * pane that spans the page.
 */
export function KeysPane(p: {
	columns: readonly SampleColumn[];
	extraKeys: readonly string[];
	usage: ReadonlyMap<string, readonly string[]>;
	wide?: boolean;
}) {
	const t = useT();
	const tn = useTn();
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
	const unused = keys.filter((k) => !p.usage.has(k)).length;
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-hairline bg-kumo-base p-3"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 id={headingId} className="font-semibold">
					{t(M.keysHeading, { count: count(keys.length) })}
				</h3>
				{unused > 0 ? (
					<span className="text-xs text-kumo-subtle">{tn(COUNT.unused, unused)}</span>
				) : null}
			</div>
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
				<ul
					className={
						p.wide
							? "grid max-h-96 gap-1.5 overflow-y-auto md:grid-cols-2"
							: "flex max-h-96 flex-col gap-1.5 overflow-y-auto"
					}
				>
					{shown.map((key) => (
						<KeyRow
							key={key}
							name={key}
							sample={values.has(key) ? sampleOf(values.get(key)) : null}
							usedBy={p.usage.get(key) ?? null}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function KeyRow(p: { name: string; sample: string | null; usedBy: readonly string[] | null }) {
	const t = useT();
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: dragId(p.name),
	});
	const { usedBy } = p;
	const used = usedBy !== null;
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
						? "flex cursor-grab touch-none flex-col gap-0.5 rounded-md border border-dashed border-kumo-brand bg-kumo-control px-2 py-1.5 text-sm"
						: "flex cursor-grab touch-none flex-col gap-0.5 rounded-md border border-kumo-line bg-kumo-control px-2 py-1.5 text-sm"
				}
			>
				<span className="flex min-w-0 items-baseline justify-between gap-2">
					{/* A used key is dimmed by its colour, not by opacity, so its text keeps AA contrast. */}
					<code
						className={
							used
								? "max-w-full shrink-0 truncate font-mono font-medium text-kumo-subtle"
								: "max-w-full shrink-0 truncate font-mono font-medium"
						}
						title={p.name}
					>
						{p.name}
					</code>
					<span
						className={
							used
								? "min-w-0 truncate text-xs text-kumo-success"
								: "min-w-0 truncate text-xs text-kumo-subtle"
						}
					>
						{usedBy !== null ? (
							<>
								<span className="sr-only">{t(M.used)} </span>
								{usedBy.join(", ")}
							</>
						) : (
							t(M.unused)
						)}
					</span>
				</span>
				<span className="min-w-0 truncate font-mono text-xs text-kumo-subtle">
					{p.sample === null ? t(M.noSample) : p.sample}
				</span>
			</div>
		</li>
	);
}
