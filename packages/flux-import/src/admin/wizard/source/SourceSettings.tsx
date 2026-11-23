import { Input, Select } from "@cloudflare/kumo";
import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from "react";
import type { SourceFormat } from "../../../sources/reader.js";
import { type Msg, useT } from "../../i18n.js";
import { SOURCE_FORMATS } from "../../limits.js";
import type { SourceBlock } from "../../types.js";
import type { SourceChoice } from "../state.js";
import { M } from "./messages.js";

/** Each format's name in the format selects. */
export const FORMAT_LABELS: Readonly<Record<SourceFormat, Msg>> = {
	csv: M.formatCsv,
	json: M.formatJson,
	jsonl: M.formatJsonl,
	xml: M.formatXml,
	xlsx: M.formatXlsx,
};

/** The formats `sources/paste` reads: a workbook is binary, so it can only be uploaded. */
export const PASTE_FORMATS = SOURCE_FORMATS.filter(
	(f): f is Exclude<SourceFormat, "xlsx"> => f !== "xlsx",
);

const EXTENSIONS: Readonly<Record<string, SourceFormat>> = {
	csv: "csv",
	json: "json",
	jsonl: "jsonl",
	ndjson: "jsonl",
	xml: "xml",
	xlsx: "xlsx",
};

/** The upload input's `accept`: every extension a format is detected from. */
export const ACCEPT = Object.keys(EXTENSIONS)
	.map((ext) => `.${ext}`)
	.join(",");

/** The format a file name or URL path's extension names (`.ndjson` and `.jsonl` → `jsonl`). */
export function formatOf(path: string): SourceFormat | null {
	const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
	return ext !== undefined && Object.hasOwn(EXTENSIONS, ext) ? (EXTENSIONS[ext] ?? null) : null;
}

/** A URL source's format, from its path's extension; null when the path names none. */
export function formatOfUrl(url: string): SourceFormat | null {
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		// Not a URL: read the text as a path.
	}
	return formatOf(path);
}

interface Settings {
	format: SourceFormat;
	records?: string | undefined;
	sheet?: string | number | undefined;
	headerRow?: number | undefined;
	filter?: string | undefined;
}

/**
 * A source block with only the settings its format takes (`checkSource`): `records` for JSON and
 * XML, `sheet` and `headerRow` for XLSX, `filter` for every format. Empty settings are left out.
 */
export function blockOf(s: Settings): SourceBlock {
	const block: SourceBlock = { format: s.format };
	if ((s.format === "json" || s.format === "xml") && s.records) block.records = s.records;
	if (s.format === "xlsx") {
		if (s.sheet !== undefined && s.sheet !== "") block.sheet = s.sheet;
		if (s.headerRow !== undefined) block.headerRow = s.headerRow;
	}
	if (s.filter) block.filter = s.filter;
	return block;
}

/** A sheet number when the text is one, else the sheet's name. */
function sheetOf(text: string): string | number {
	return /^[1-9]\d*$/.test(text) ? Number(text) : text;
}

function headerRowOf(text: string): number | undefined {
	return /^\d+$/.test(text) ? Number(text) : undefined;
}

/** A text setting, committed on blur or Enter (each commit re-samples). */
function TextSetting(props: {
	label: string;
	description: string;
	value: string;
	type?: "text" | "number";
	onCommit(value: string): void;
}) {
	const [draft, setDraft] = useState(props.value);
	useEffect(() => setDraft(props.value), [props.value]);
	const commit = () => {
		const value = draft.trim();
		if (value !== props.value) props.onCommit(value);
	};
	return (
		<Input
			label={props.label}
			description={props.description}
			type={props.type ?? "text"}
			{...(props.type === "number" ? { min: 1 } : {})}
			value={draft}
			onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
				if (e.key === "Enter") commit();
			}}
		/>
	);
}

/**
 * How the chosen data is read: its format (detected, and overridable) and the template's
 * `source` settings. Every change re-samples.
 */
export function SourceSettings(props: {
	choice: SourceChoice;
	block: SourceBlock;
	/** The address named no format, so CSV was assumed. */
	assumed: boolean;
	onChange(block: SourceBlock): void;
}) {
	const t = useT();
	const { block, onChange } = props;
	const formats = props.choice.kind === "paste" ? PASTE_FORMATS : SOURCE_FORMATS;
	const set = (patch: Partial<Settings>) => onChange(blockOf({ ...block, ...patch }));
	return (
		<section className="space-y-4">
			<h3 className="font-semibold">{t(M.settings, { name: props.choice.label })}</h3>
			<div className="grid gap-4 md:grid-cols-2">
				<Select
					label={t(M.format)}
					{...(props.assumed ? { description: t(M.formatAssumed) } : {})}
					value={block.format}
					onValueChange={(v: unknown) => {
						const format = formats.find((f) => f === v);
						if (format !== undefined && format !== block.format) set({ format });
					}}
					items={formats.map((f) => ({ value: f, label: t(FORMAT_LABELS[f]) }))}
				>
					{formats.map((f) => (
						<Select.Option key={f} value={f}>
							{t(FORMAT_LABELS[f])}
						</Select.Option>
					))}
				</Select>
				{block.format === "json" || block.format === "xml" ? (
					<TextSetting
						label={t(M.records)}
						description={t(block.format === "json" ? M.recordsJsonHint : M.recordsXmlHint)}
						value={block.records ?? ""}
						onCommit={(records) => set({ records })}
					/>
				) : null}
				{block.format === "xlsx" ? (
					<>
						<TextSetting
							label={t(M.sheet)}
							description={t(M.sheetHint)}
							value={block.sheet === undefined ? "" : String(block.sheet)}
							onCommit={(text) => set({ sheet: text === "" ? undefined : sheetOf(text) })}
						/>
						<TextSetting
							label={t(M.headerRow)}
							description={t(M.headerRowHint)}
							type="number"
							value={block.headerRow === undefined ? "" : String(block.headerRow)}
							onCommit={(text) => set({ headerRow: headerRowOf(text) })}
						/>
					</>
				) : null}
				<TextSetting
					label={t(M.filter)}
					description={t(M.filterHint)}
					value={block.filter ?? ""}
					onCommit={(filter) => set({ filter })}
				/>
			</div>
		</section>
	);
}
