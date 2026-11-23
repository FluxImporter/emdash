import { Checkbox, Input, Radio, Select } from "@cloudflare/kumo";
import { type ChangeEvent, useEffect, useState } from "react";
import { useT } from "../../../i18n.js";
import type { MappingType } from "../../../limits.js";
import type { SampleColumn, SchemaField, TaxonomyInfo } from "../../../types.js";
import type { RowMapping, ValueSource } from "../../state.js";
import { KeyPicker } from "./KeyPicker.js";
import { M } from "./messages.js";

/**
 * The detail panel's controls: the source switch, and each mapping type's settings, exactly as the
 * template grammar has them (`engine/template.ts`). A setting the user has not set stays out of the
 * mapping; an emptied text setting is removed, never written as `""` or `undefined`.
 */

/** Sets one setting of the mapping; `undefined` removes it. */
export type Setter = (key: string, value: unknown) => void;

// --- Primitives ---

/**
 * A text setting, written when the input loses focus. With `required`, an emptied input goes
 * back to the saved value instead of removing it.
 */
function TextSetting(p: {
	label: string;
	value: string | undefined;
	onCommit(value: string | undefined): void;
	description?: string;
	error?: string;
	maxLength?: number;
	required?: boolean;
}) {
	const [draft, setDraft] = useState(p.value ?? "");
	useEffect(() => setDraft(p.value ?? ""), [p.value]);
	return (
		<Input
			label={p.label}
			value={draft}
			maxLength={p.maxLength}
			{...(p.description === undefined ? {} : { description: p.description })}
			{...(p.error === undefined ? {} : { error: p.error })}
			onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
			onBlur={() => {
				if (draft.trim() === "" && p.required) {
					setDraft(p.value ?? "");
					return;
				}
				const next = draft === "" ? undefined : draft;
				if (next !== p.value) p.onCommit(next);
			}}
		/>
	);
}

interface Choice<V extends string> {
	value: V;
	label: string;
}

export function ChoiceSetting<V extends string>(p: {
	label: string;
	value: V | null;
	options: readonly Choice<V>[];
	onChange(value: V): void;
	error?: string;
	placeholder?: string;
	required?: boolean;
}) {
	return (
		<Select<V>
			label={p.label}
			value={p.value}
			items={p.options}
			required={p.required}
			{...(p.placeholder === undefined ? {} : { placeholder: p.placeholder })}
			{...(p.error === undefined ? {} : { error: p.error })}
			onValueChange={(value: V | null) => {
				if (value !== null) p.onChange(value);
			}}
		>
			{p.options.map((o) => (
				<Select.Option key={o.value} value={o.value}>
					{o.label}
				</Select.Option>
			))}
		</Select>
	);
}

function FlagSetting(p: { label: string; checked: boolean; onChange(checked: boolean): void }) {
	return (
		<Checkbox label={p.label} checked={p.checked} onCheckedChange={(c: boolean) => p.onChange(c)} />
	);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** A separator setting (1-10 characters, `separator` in the grammar). */
function SeparatorSetting(p: { label: string; mapping: RowMapping; name: string; set: Setter }) {
	const t = useT();
	return (
		<TextSetting
			label={p.label}
			value={str(p.mapping[p.name])}
			maxLength={10}
			description={p.name === "hierarchy" ? t(M.pathSeparatorHint) : t(M.separatorHint)}
			onCommit={(v) => p.set(p.name, v)}
		/>
	);
}

// --- The source switch ---

type Mode = "none" | "key" | "expr";

function modeOf(value: ValueSource | null, optional: boolean): Mode {
	if (value !== null && "expr" in value) return "expr";
	if (value !== null) return "key";
	return optional ? "none" : "key";
}

/**
 * "Source key" or "Expression" (and "None" when `optional`): a mapping takes one, never both
 * (`template.ts:101-104`). Switching only changes the control; the value changes when a key is
 * picked or an expression is written, which then replaces the other.
 */
export function SourceInput(p: {
	legend: string;
	keyLabel: string;
	exprLabel: string;
	value: ValueSource | null;
	columns: readonly SampleColumn[];
	onChange(value: ValueSource | null): void;
	optional?: boolean;
}) {
	const t = useT();
	const optional = p.optional === true;
	const shown = JSON.stringify(p.value);
	// The user's choice holds only while the value is the one it was made for.
	const [chosen, setChosen] = useState<{ mode: Mode; for: string } | null>(null);
	const mode = chosen?.for === shown ? chosen.mode : modeOf(p.value, optional);
	const from = p.value !== null && "from" in p.value ? p.value.from : null;
	const expr = p.value !== null && "expr" in p.value ? p.value.expr : undefined;
	return (
		<div className="space-y-3">
			<Radio
				legend={p.legend}
				orientation="horizontal"
				value={mode}
				onValueChange={(next: Mode) => {
					setChosen({ mode: next, for: shown });
					if (next === "none" && p.value !== null) p.onChange(null);
				}}
			>
				{optional ? <Radio.Item label={t(M.none)} value="none" /> : null}
				<Radio.Item label={t(M.sourceKey)} value="key" />
				<Radio.Item label={t(M.expression)} value="expr" />
			</Radio>
			{mode === "key" ? (
				<KeyPicker
					columns={p.columns}
					value={from}
					label={p.keyLabel}
					onPick={(key) => p.onChange({ from: key })}
				/>
			) : null}
			{mode === "expr" ? (
				<TextSetting
					label={p.exprLabel}
					value={expr}
					required
					onCommit={(v) => {
						if (v !== undefined) p.onChange({ expr: v });
					}}
				/>
			) : null}
		</div>
	);
}

// --- Field settings ---

function NumberSettings(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	const [refused, setRefused] = useState(false);
	const chars = {
		".": t(M.separatorChars.point),
		",": t(M.separatorChars.comma),
		" ": t(M.separatorChars.space),
		"'": t(M.separatorChars.apostrophe),
		_: t(M.separatorChars.underscore),
	};
	const decimal = str(p.mapping.decimal) ?? ".";
	const thousands = str(p.mapping.thousands);
	// The grammar refuses a thousands separator equal to the decimal one (`template.ts:144`).
	const write = (key: "decimal" | "thousands", value: string | undefined) => {
		const next = { decimal, thousands, [key]: value };
		if (next.thousands !== undefined && next.thousands === next.decimal) {
			setRefused(true);
			return;
		}
		setRefused(false);
		p.set(key, value);
	};
	const error = refused ? t(M.thousandsSameAsDecimal) : undefined;
	return (
		<>
			<ChoiceSetting
				label={t(M.decimal)}
				value={decimal}
				options={[".", ","].map((c) => ({ value: c, label: chars[c as "." | ","] }))}
				onChange={(v) => write("decimal", v)}
			/>
			<ChoiceSetting
				label={t(M.thousands)}
				value={thousands ?? NONE}
				options={[
					{ value: NONE, label: t(M.none) },
					...([",", ".", " ", "'", "_"] as const).map((c) => ({ value: c, label: chars[c] })),
				]}
				{...(error === undefined ? {} : { error })}
				onChange={(v) => write("thousands", v === NONE ? undefined : v)}
			/>
		</>
	);
}

/** A choice standing for "not set". */
const NONE = "\u0000none";

function TimezoneSetting(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	const tz = str(p.mapping.tz) ?? "UTC";
	const options: Choice<string>[] = [
		{ value: "UTC", label: t(M.tzUtc) },
		{ value: "site", label: t(M.tzSite) },
	];
	// A saved template's other IANA zone stays a choice, so showing it loses nothing.
	if (!options.some((o) => o.value === tz)) options.push({ value: tz, label: tz });
	return (
		<ChoiceSetting
			label={t(M.timezone)}
			value={tz}
			options={options}
			onChange={(v) => p.set("tz", v)}
		/>
	);
}

function DateSettings(p: { mapping: RowMapping; set: Setter; output: boolean }) {
	const t = useT();
	return (
		<>
			<TextSetting
				label={t(M.dateFormat)}
				value={str(p.mapping.format)}
				description={t(M.dateFormatHint)}
				onCommit={(v) => p.set("format", v)}
			/>
			<TimezoneSetting mapping={p.mapping} set={p.set} />
			{p.output ? (
				<TextSetting
					label={t(M.outputFormat)}
					value={str(p.mapping.output)}
					description={t(M.outputFormatHint)}
					maxLength={100}
					onCommit={(v) => p.set("output", v)}
				/>
			) : null}
		</>
	);
}

const tokensOf = (v: unknown): string | undefined =>
	Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : undefined;

/** Comma-separated tokens; blank ones are dropped, and none at all removes the list. */
function parseTokens(text: string | undefined): string[] | undefined {
	const tokens = (text ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return tokens.length === 0 ? undefined : tokens;
}

function BooleanSettings(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	return (
		<>
			<TextSetting
				label={t(M.trueTokens)}
				value={tokensOf(p.mapping.true)}
				description={t(M.tokensHint)}
				onCommit={(v) => p.set("true", parseTokens(v))}
			/>
			<TextSetting
				label={t(M.falseTokens)}
				value={tokensOf(p.mapping.false)}
				description={t(M.tokensHint)}
				onCommit={(v) => p.set("false", parseTokens(v))}
			/>
		</>
	);
}

/** A sampled value's text, as a select reads it; null for an empty or non-scalar value. */
function textOf(v: unknown): string | null {
	if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
	const text = String(v).trim();
	return text === "" ? null : text;
}

/** The longest source value a `map` entry takes (`optionMap` in the grammar). */
const MAP_KEY_MAX = 200;

/** The distinct values of the chosen key's samples, split by `separator` when given. */
function sampleTexts(column: SampleColumn | undefined, separator: string | null): string[] {
	const texts = new Set<string>();
	for (const value of column?.values ?? []) {
		const parts = Array.isArray(value)
			? value
			: separator === null || typeof value !== "string"
				? [value]
				: value.split(separator);
		for (const part of parts) {
			const text = textOf(part);
			if (text !== null && text.length <= MAP_KEY_MAX) texts.add(text);
		}
	}
	return [...texts];
}

const AS_IS = "\u0000as-is";

function isStringRecord(v: unknown): v is Record<string, string> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `map`: each sampled value (and each saved entry) onto one of the field's options. */
function ValueMap(p: {
	mapping: RowMapping;
	options: readonly string[];
	values: readonly string[];
	set: Setter;
}) {
	const t = useT();
	const map = isStringRecord(p.mapping.map) ? p.mapping.map : {};
	const rows = [...new Set([...p.values, ...Object.keys(map)])];
	const choices = [
		{ value: AS_IS, label: t(M.asIs) },
		...p.options.map((o) => ({ value: o, label: o })),
	];
	const write = (value: string, option: string) => {
		const next = { ...map };
		if (option === AS_IS) delete next[value];
		else next[value] = option;
		p.set("map", Object.keys(next).length === 0 ? undefined : next);
	};
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium">{t(M.sourceValues)}</legend>
			{rows.map((value) => (
				<ChoiceSetting
					key={value}
					label={value}
					value={Object.hasOwn(map, value) ? (map[value] ?? AS_IS) : AS_IS}
					options={choices}
					onChange={(option) => write(value, option)}
				/>
			))}
		</fieldset>
	);
}

function SelectSettings(p: {
	mapping: RowMapping;
	field: SchemaField;
	column: SampleColumn | undefined;
	multiple: boolean;
	set: Setter;
}) {
	const t = useT();
	// The engine's default separator for a multi-select (`values.ts`).
	const separator = p.multiple ? (str(p.mapping.separator) ?? ",") : null;
	return (
		<>
			<ValueMap
				mapping={p.mapping}
				options={p.field.options ?? []}
				values={sampleTexts(p.column, separator)}
				set={p.set}
			/>
			<FlagSetting
				label={t(M.ignoreCase)}
				checked={bool(p.mapping.ignoreCase, true)}
				onChange={(c) => p.set("ignoreCase", c)}
			/>
			{p.multiple ? (
				<SeparatorSetting label={t(M.separator)} mapping={p.mapping} name="separator" set={p.set} />
			) : null}
		</>
	);
}

function RefreshSetting(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	return (
		<FlagSetting
			label={t(M.refresh)}
			checked={bool(p.mapping.refresh, false)}
			onChange={(c) => p.set("refresh", c)}
		/>
	);
}

function valueSourceOf(v: unknown): ValueSource | null {
	if (!isStringRecord(v)) return null;
	if (typeof v.from === "string") return { from: v.from };
	if (typeof v.expr === "string") return { expr: v.expr };
	return null;
}

function ImageSettings(p: { mapping: RowMapping; columns: readonly SampleColumn[]; set: Setter }) {
	const t = useT();
	return (
		<>
			<SourceInput
				legend={t(M.altText)}
				keyLabel={t(M.altKey)}
				exprLabel={t(M.altExpression)}
				value={valueSourceOf(p.mapping.alt)}
				columns={p.columns}
				optional
				onChange={(v) => p.set("alt", v ?? undefined)}
			/>
			<RefreshSetting mapping={p.mapping} set={p.set} />
		</>
	);
}

/** What `baseUrl` accepts: an absolute http(s) URL without a user name or password. */
function isBaseUrl(text: string): boolean {
	try {
		const url = new URL(text);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

type PtFormat = "html" | "markdown" | "text";

function PortableTextSettings(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	const [badUrl, setBadUrl] = useState(false);
	const format = str(p.mapping.format) as PtFormat | undefined;
	return (
		<>
			<ChoiceSetting<PtFormat>
				label={t(M.ptFormat)}
				value={format ?? null}
				placeholder={t(M.ptChoose)}
				required
				options={[
					{ value: "html", label: t(M.ptHtml) },
					{ value: "markdown", label: t(M.ptMarkdown) },
					{ value: "text", label: t(M.ptText) },
				]}
				{...(format === undefined ? { error: t(M.ptFormatRequired) } : {})}
				onChange={(v) => p.set("format", v)}
			/>
			<TextSetting
				label={t(M.baseUrl)}
				value={str(p.mapping.baseUrl)}
				{...(badUrl ? { error: t(M.baseUrlInvalid) } : {})}
				onCommit={(v) => {
					const bad = v !== undefined && !isBaseUrl(v);
					setBadUrl(bad);
					if (!bad) p.set("baseUrl", v);
				}}
			/>
			<ChoiceSetting
				label={t(M.images)}
				value={str(p.mapping.images) ?? "import"}
				options={[
					{ value: "import", label: t(M.imagesImport) },
					{ value: "skip", label: t(M.imagesSkip) },
				]}
				onChange={(v) => p.set("images", v)}
			/>
			<ChoiceSetting
				label={t(M.imageErrors)}
				value={str(p.mapping.imageErrors) ?? "drop"}
				options={[
					{ value: "drop", label: t(M.imageErrorsDrop) },
					{ value: "fail", label: t(M.failRecord) },
				]}
				onChange={(v) => p.set("imageErrors", v)}
			/>
			<ChoiceSetting
				label={t(M.unknownMarkup)}
				value={str(p.mapping.unknownMarkup) ?? "warn"}
				options={[
					{ value: "warn", label: t(M.unknownMarkupWarn) },
					{ value: "fail", label: t(M.failRecord) },
				]}
				onChange={(v) => p.set("unknownMarkup", v)}
			/>
		</>
	);
}

/** A field mapping's settings for its type; none for `text` and `slug`. */
export function FieldSettings(p: {
	type: MappingType;
	field: SchemaField;
	mapping: RowMapping;
	columns: readonly SampleColumn[];
	column: SampleColumn | undefined;
	set: Setter;
}) {
	const t = useT();
	const { mapping, set } = p;
	switch (p.type) {
		case "number":
			return <NumberSettings mapping={mapping} set={set} />;
		case "date":
			// Preflight F27: `output` only for text targets (a datetime field refuses it).
			return (
				<DateSettings
					mapping={mapping}
					set={set}
					output={p.field.type === "string" || p.field.type === "text"}
				/>
			);
		case "boolean":
			return <BooleanSettings mapping={mapping} set={set} />;
		case "select":
		case "multiSelect":
			return (
				<SelectSettings
					mapping={mapping}
					field={p.field}
					column={p.column}
					multiple={p.type === "multiSelect"}
					set={set}
				/>
			);
		case "json":
			return (
				<FlagSetting
					label={t(M.parseJson)}
					checked={bool(mapping.parse, true)}
					onChange={(c) => set("parse", c)}
				/>
			);
		case "reference":
			return (
				<>
					<ChoiceSetting
						label={t(M.matchBy)}
						value={str(mapping.match) ?? "id"}
						options={[
							{ value: "id", label: t(M.matchId) },
							{ value: "slug", label: t(M.matchSlug) },
							{ value: "key", label: t(M.matchKey) },
						]}
						onChange={(v) => set("match", v)}
					/>
					<SeparatorSetting label={t(M.separator)} mapping={mapping} name="separator" set={set} />
				</>
			);
		case "image":
			return <ImageSettings mapping={mapping} columns={p.columns} set={set} />;
		case "file":
			return <RefreshSetting mapping={mapping} set={set} />;
		case "portableText":
			return <PortableTextSettings mapping={mapping} set={set} />;
		case "text":
		case "slug":
			return null;
	}
}

// --- Taxonomy and byline settings ---

export function TaxonomySettings(p: { taxonomy: TaxonomyInfo; mapping: RowMapping; set: Setter }) {
	const t = useT();
	const { mapping, set } = p;
	return (
		<>
			<ChoiceSetting
				label={t(M.matchTermsBy)}
				value={str(mapping.match) ?? "slug"}
				options={[
					{ value: "slug", label: t(M.matchSlug) },
					{ value: "label", label: t(M.matchLabel) },
				]}
				onChange={(v) => set("match", v)}
			/>
			<SeparatorSetting label={t(M.termSeparator)} mapping={mapping} name="separator" set={set} />
			{p.taxonomy.hierarchical ? (
				<SeparatorSetting label={t(M.pathSeparator)} mapping={mapping} name="hierarchy" set={set} />
			) : null}
			<FlagSetting
				label={t(M.createTerms)}
				checked={bool(mapping.create, false)}
				onChange={(c) => set("create", c)}
			/>
		</>
	);
}

export function BylineSettings(p: { mapping: RowMapping; set: Setter }) {
	const t = useT();
	return (
		<>
			<ChoiceSetting
				label={t(M.matchBylinesBy)}
				value={str(p.mapping.match) ?? "slug"}
				options={[
					{ value: "slug", label: t(M.matchSlug) },
					{ value: "name", label: t(M.matchName) },
				]}
				onChange={(v) => p.set("match", v)}
			/>
			<SeparatorSetting label={t(M.separator)} mapping={p.mapping} name="separator" set={p.set} />
		</>
	);
}
