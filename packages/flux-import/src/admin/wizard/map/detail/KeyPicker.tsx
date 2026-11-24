import { Combobox } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import { useT } from "../../../i18n.js";
import { KEYS_SHOWN } from "../../../limits.js";
import type { SampleColumn } from "../../../types.js";
import { M } from "./messages.js";

/** A key matches a query that it holds, ignoring case. */
const matches = (key: string, query: string) => key.toLowerCase().includes(query.toLowerCase());

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The source-key picker: the keyboard path for a drop (spec "Accessibility"). It lists at most
 * `KEYS_SHOWN` keys until the user types; a typed query lists every key holding it, so the
 * 1,000th key of a wide source is found by typing (Review Focus 4).
 */
export function KeyPicker(p: {
	columns: readonly SampleColumn[];
	value: string | null;
	onPick(key: string): void;
	label: string;
}) {
	const t = useT();
	const keys = useMemo(() => p.columns.map((c) => c.key), [p.columns]);
	// Whether the input holds a query the user typed, rather than the chosen key or nothing. A pick
	// or a reset writes the input with another reason, so only typing lifts the cap.
	const [typed, setTyped] = useState(false);
	const capped = !typed && keys.length > KEYS_SHOWN;
	return (
		<Combobox<string>
			items={keys}
			value={p.value}
			label={p.label}
			filter={matches}
			limit={capped ? KEYS_SHOWN : -1}
			onInputValueChange={(input: string, details: { reason: string }) => {
				setTyped(details.reason === "input-change" && input.trim() !== "");
			}}
			onValueChange={(key: string | null) => {
				if (typeof key === "string") p.onPick(key);
			}}
		>
			<Combobox.TriggerInput
				placeholder={t(M.keyPlaceholder)}
				showOptionsLabel={t(M.showKeys)}
				clearLabel={t(M.clearKey)}
			/>
			<Combobox.Content>
				<Combobox.List>
					{(key: string) => (
						<Combobox.Item key={key} value={key} className="truncate" title={key}>
							{key}
						</Combobox.Item>
					)}
				</Combobox.List>
				<Combobox.Empty>{t(M.noKeyMatches)}</Combobox.Empty>
				{capped ? (
					<p className="px-2 py-1 text-sm text-kumo-subtle">
						{t(M.keysCapped, { shown: count(KEYS_SHOWN), total: count(keys.length) })}
					</p>
				) : null}
			</Combobox.Content>
		</Combobox>
	);
}
