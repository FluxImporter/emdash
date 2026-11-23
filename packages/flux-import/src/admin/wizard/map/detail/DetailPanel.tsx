import { Badge } from "@cloudflare/kumo";
import { useId } from "react";
import { type Msg, useT } from "../../../i18n.js";
import { COMPATIBLE, type MappingType } from "../../../limits.js";
import type { SampleColumn, SchemaField, TaxonomyInfo } from "../../../types.js";
import type { RowId, RowMapping, RowMeta, ValueSource } from "../../state.js";
import { M } from "./messages.js";
import {
	BylineSettings,
	ChoiceSetting,
	FieldSettings,
	type Setter,
	SourceInput,
	TaxonomySettings,
} from "./settings.js";

/**
 * A row of the Map step as the detail panel shows it. There is no `publishAt` row: the schedule
 * is set in Options only (preflight F4).
 */
export interface DetailRow {
	id: RowId;
	label: string;
	kind: "key" | "slug" | "field" | "taxonomy" | "bylines" | "translationOf";
	field?: SchemaField;
	taxonomy?: TaxonomyInfo;
}

const MAPPING_TYPES = Object.keys(COMPATIBLE) as MappingType[];

/** The mapping types that can write a field type, in `COMPATIBLE`'s order. */
function compatibleTypes(fieldType: string): MappingType[] {
	return MAPPING_TYPES.filter((type) => COMPATIBLE[type].includes(fieldType));
}

function sourceOf(mapping: RowMapping | undefined): ValueSource | null {
	if (typeof mapping?.from === "string") return { from: mapping.from };
	if (typeof mapping?.expr === "string") return { expr: mapping.expr };
	return null;
}

/** The mapping's settings, without its `from` and `expr`. */
function settingsOf(mapping: RowMapping | undefined): Record<string, unknown> {
	if (mapping === undefined) return {};
	const { from: _from, expr: _expr, ...rest } = mapping;
	return rest;
}

/** The confidence bands (Global Constraints): high ≥ 0.8, medium ≥ 0.5, low below. */
function bandOf(confidence: number): Msg {
	if (confidence >= 0.8) return M.bandHigh;
	if (confidence >= 0.5) return M.bandMedium;
	return M.bandLow;
}

const ORIGINS: Record<Exclude<RowMeta["origin"], "user">, Msg> = {
	ai: M.originAi,
	name: M.originName,
	template: M.originTemplate,
};

/** A raw sample value as text: a string as it is, anything else as JSON. */
function shown(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** How many sample values the panel lists. */
const SAMPLES_SHOWN = 5;

/**
 * The Map step's detail panel for one row (spec "3. Map"): the source key or expression, the
 * field's mapping type and its settings, the raw sample values, and the suggestion's reasons.
 * Every change is written through `onChange` as the row's whole mapping.
 */
export function DetailPanel(p: {
	row: DetailRow;
	mapping: RowMapping | undefined;
	meta: RowMeta | undefined;
	columns: readonly SampleColumn[];
	onChange(m: RowMapping | null): void;
}) {
	// A new row starts with fresh controls (the source switch, drafts and refusals).
	return <Panel key={p.row.id} {...p} />;
}

function Panel({ row, mapping, meta, columns, onChange }: Parameters<typeof DetailPanel>[0]) {
	const t = useT();
	const headingId = useId();
	const field = row.kind === "field" ? row.field : undefined;
	const types = field === undefined ? [] : compatibleTypes(field.type);
	const source = sourceOf(mapping);
	const type =
		typeof mapping?.type === "string" && types.includes(mapping.type as MappingType)
			? (mapping.type as MappingType)
			: types[0];
	const column =
		source !== null && "from" in source ? columns.find((c) => c.key === source.from) : undefined;

	// A pick or an expression replaces the other and keeps the settings (a field's type too).
	const setSource = (next: ValueSource | null) => {
		if (next === null) return;
		const settings = mapping === undefined && type !== undefined ? { type } : settingsOf(mapping);
		onChange({ ...settings, ...next } as RowMapping);
	};
	const set: Setter = (key, value) => {
		if (mapping === undefined) return;
		const next: Record<string, unknown> = { ...mapping };
		if (value === undefined) delete next[key];
		else next[key] = value;
		onChange(next as RowMapping);
	};

	return (
		<section aria-labelledby={headingId} className="space-y-4">
			<h3 id={headingId} className="truncate text-base font-medium" title={row.label}>
				{row.label}
			</h3>
			{/* A field no mapping can write takes no source; the Map row says why (Review Focus 5). */}
			{field !== undefined && type === undefined ? null : (
				<SourceInput
					legend={t(M.valueFrom)}
					keyLabel={t(M.sourceKey)}
					exprLabel={t(M.expressionInput)}
					value={source}
					columns={columns}
					onChange={setSource}
				/>
			)}
			{mapping !== undefined && source !== null ? (
				<div className="space-y-3">
					{field !== undefined && type !== undefined ? (
						<>
							<ChoiceSetting
								label={t(M.mappingType)}
								value={type}
								options={types.map((value) => ({ value, label: t(M.types[value]) }))}
								// A new type keeps only the source: the old settings may not apply.
								onChange={(next) => {
									if (next !== type) onChange({ ...source, type: next } as RowMapping);
								}}
							/>
							<FieldSettings
								type={type}
								field={field}
								mapping={mapping}
								columns={columns}
								column={column}
								set={set}
							/>
						</>
					) : null}
					{row.kind === "taxonomy" && row.taxonomy !== undefined ? (
						<TaxonomySettings taxonomy={row.taxonomy} mapping={mapping} set={set} />
					) : null}
					{row.kind === "bylines" ? <BylineSettings mapping={mapping} set={set} /> : null}
				</div>
			) : null}
			{source !== null ? <Samples column={column} /> : null}
			{meta !== undefined ? <Suggestion meta={meta} /> : null}
		</section>
	);
}

/** The chosen key's raw values; Preview shows them converted (plan Ruling 6). */
function Samples(p: { column: SampleColumn | undefined }) {
	const t = useT();
	const headingId = useId();
	const values = (p.column?.values ?? []).filter((v) => v !== undefined).slice(0, SAMPLES_SHOWN);
	return (
		<div className="space-y-2">
			{p.column !== undefined ? (
				<>
					<h4 id={headingId} className="text-sm font-medium">
						{t(M.sampleValues)}
					</h4>
					{values.length === 0 ? (
						<p className="text-sm text-kumo-subtle">{t(M.noSampleValues)}</p>
					) : (
						<ul aria-labelledby={headingId} className="space-y-1 text-sm">
							{values.map((value, i) => {
								const text = shown(value);
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: samples are fixed and may repeat.
									<li key={i} className="truncate" title={text}>
										{text === "" ? t(M.emptyValue) : text}
									</li>
								);
							})}
						</ul>
					)}
				</>
			) : null}
			<p className="text-sm text-kumo-subtle">{t(M.previewNote)}</p>
		</div>
	);
}

/** The suggestion's origin and confidence as text, "check", and its rationale (F28). */
function Suggestion(p: { meta: RowMeta }) {
	const t = useT();
	const { origin, confidence, rationale, check } = p.meta;
	const label =
		origin === "user"
			? null
			: confidence === undefined || origin === "template"
				? t(ORIGINS[origin])
				: t(M.badge, { origin: t(ORIGINS[origin]), band: t(bandOf(confidence)) });
	if (label === null && !check && rationale === undefined) return null;
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				{label === null ? null : <Badge variant="secondary">{label}</Badge>}
				{check ? <Badge variant="warning">{t(M.check)}</Badge> : null}
			</div>
			{rationale === undefined || rationale === "" ? null : (
				<p className="text-sm text-kumo-subtle">{rationale}</p>
			)}
		</div>
	);
}
