import { Button, InputArea, Select } from "@cloudflare/kumo";
import { type ChangeEvent, useId } from "react";
import type { SourceFormat } from "../../../sources/reader.js";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { PASTE_MAX_BYTES } from "../../limits.js";
import { M } from "./messages.js";
import { FORMAT_LABELS, PASTE_FORMATS } from "./SourceSettings.js";
import type { Described, TabProps } from "./SourceStep.js";

export interface Paste {
	format: Exclude<SourceFormat, "xlsx">;
	text: string;
}

const encoder = new TextEncoder();

/** The `sources/paste` body's size in UTF-8 bytes: the route caps the body, not the text (F18). */
export function pasteBytes(paste: Paste): number {
	return encoder.encode(JSON.stringify({ format: paste.format, text: paste.text })).length;
}

export function pasteFits(paste: Paste): boolean {
	return pasteBytes(paste) <= PASTE_MAX_BYTES;
}

const KIB = 1024;

/** A 413 is the route's body cap (preflight F18): the same sentence as the counter's. */
function describePaste(e: unknown): Described {
	return e instanceof ApiError && e.status === 413 ? { msg: M.pasteTooLarge } : describeError(e);
}

/** Paste: text staged by `sources/paste`, in any format but XLSX. */
export function PasteTab(props: TabProps & { paste: Paste; onPaste(paste: Paste): void }) {
	const { busy, run, pick, paste, onPaste } = props;
	const t = useT();
	const sizeId = useId();
	const bytes = pasteBytes(paste);
	const fits = bytes <= PASTE_MAX_BYTES;
	const send = () =>
		run(async () => {
			const staged = await api.paste(paste);
			await pick(
				{ kind: "paste", uploadId: staged.uploadId, label: t(M.pastedLabel), bytes: staged.bytes },
				paste.format,
			);
		}, describePaste);
	return (
		<div className="space-y-4">
			<Select
				label={t(M.format)}
				value={paste.format}
				onValueChange={(v: unknown) => {
					const format = PASTE_FORMATS.find((f) => f === v);
					if (format !== undefined) onPaste({ ...paste, format });
				}}
				items={PASTE_FORMATS.map((f) => ({ value: f, label: t(FORMAT_LABELS[f]) }))}
			>
				{PASTE_FORMATS.map((f) => (
					<Select.Option key={f} value={f}>
						{t(FORMAT_LABELS[f])}
					</Select.Option>
				))}
			</Select>
			<InputArea
				label={t(M.text)}
				rows={10}
				className="font-mono"
				value={paste.text}
				aria-describedby={sizeId}
				onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
					onPaste({ ...paste, text: e.target.value })
				}
			/>
			<div id={sizeId} aria-live="polite" className="text-sm">
				{paste.text === "" ? null : (
					<p className="tabular-nums">
						{t(M.pasteSize, {
							used: Math.ceil(bytes / KIB).toLocaleString("en"),
							max: (PASTE_MAX_BYTES / KIB).toLocaleString("en"),
						})}
					</p>
				)}
				{fits ? null : <p className="text-kumo-danger">{t(M.pasteTooLarge)}</p>}
			</div>
			<Button variant="secondary" disabled={busy || !fits || paste.text === ""} onClick={send}>
				{t(M.useText)}
			</Button>
		</div>
	);
}
