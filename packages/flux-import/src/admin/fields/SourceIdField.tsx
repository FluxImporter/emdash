import { Collapsible } from "@cloudflare/kumo";
import type { JSX } from "react";
import { useT } from "../i18n.js";
import { M } from "./messages.js";

/**
 * The widget's name in the admin module's `fields`; the server sets `flux_source_id`'s widget to
 * `"flux-import:source-id"` (`SOURCE_ID_FIELD_WIDGET` in `src/emdash/schema.ts`, plan Ruling 1).
 */
export const SOURCE_ID_WIDGET = "source-id";

/**
 * `flux_source_id` in the content editor: the label, and a collapsed "Import ID" disclosure that
 * shows the value as text. The importer matches entries by this value, so it is never editable
 * here and `onChange` is never called.
 */
export function SourceIdField(p: {
	value: unknown;
	onChange(v: unknown): void;
	label: string;
	id: string;
}): JSX.Element {
	const t = useT();
	const value = typeof p.value === "string" && p.value !== "" ? p.value : null;
	return (
		<fieldset id={p.id} className="grid gap-1">
			<legend className="text-base font-medium">{p.label}</legend>
			<Collapsible.Root>
				<Collapsible.DefaultTrigger>{t(M.importId)}</Collapsible.DefaultTrigger>
				<Collapsible.DefaultPanel>
					{value === null ? (
						<p className="text-sm text-kumo-subtle">{t(M.noImportId)}</p>
					) : (
						<p className="font-mono text-sm break-all">{value}</p>
					)}
				</Collapsible.DefaultPanel>
			</Collapsible.Root>
		</fieldset>
	);
}
