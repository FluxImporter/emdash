import { Badge, Button } from "@cloudflare/kumo";
import { useDroppable } from "@dnd-kit/core";
import { type ReactNode, useId } from "react";
import { type Msg, useT, type Values } from "../../i18n.js";
import type { SchemaField, TaxonomyInfo } from "../../types.js";
import { WarningIcon, XIcon } from "../../ui/icons.js";
import {
	type Blocker,
	mappable,
	type RowMapping,
	type RowMeta,
	type WizardState,
} from "../state.js";
import { badgeText, type DetailRow } from "./detail/DetailPanel.js";
import { M } from "./messages.js";
import type { LooksLike } from "./new-fields/infer.js";

/** The drop target and selection of "+ Add a new field" (preflight F25). */
export const NEW_FIELD = "new-field";
export type Selection = DetailRow["id"] | typeof NEW_FIELD;

type T = (msg: Msg, values?: Values) => string;

/**
 * The middle pane's rows, in order (spec "3. Map"; preflight F4, F17): Key and Slug, the
 * collection's fields, its taxonomies, Bylines, and `translationOf` with a translation locale.
 * There is no `publishAt` row: the schedule is set in Options.
 */
export function mapRows(
	t: T,
	fields: readonly SchemaField[],
	taxonomies: readonly TaxonomyInfo[],
	target: NonNullable<WizardState["target"]>,
): DetailRow[] {
	return [
		{ id: "key", label: t(M.keyRow), kind: "key" },
		{ id: "slug", label: t(M.slugRow), kind: "slug" },
		...fields.map(
			(field): DetailRow => ({
				id: `field:${field.slug}`,
				label: field.label,
				kind: "field",
				field,
			}),
		),
		...taxonomies
			.filter((taxonomy) => taxonomy.collections.includes(target.collection))
			.map(
				(taxonomy): DetailRow => ({
					id: `taxonomy:${taxonomy.name}`,
					label: taxonomy.label,
					kind: "taxonomy",
					taxonomy,
				}),
			),
		{ id: "bylines", label: t(M.bylinesRow), kind: "bylines" },
		...(target.translationLocale === null
			? []
			: [
					{
						id: "translationOf",
						label: t(M.translationOfRow, { locale: target.translationLocale }),
						kind: "translationOf",
					} satisfies DetailRow,
				]),
	];
}

/** Why no mapping can write a field (Review Focus 5), or null when one can. */
function unmappableReason(t: T, field: SchemaField | undefined): string | null {
	if (field === undefined || mappable(field)) return null;
	if (field.unsupported) return t(M.unsupported);
	if (field.type === "reference") return t(M.unboundReference);
	return t(M.notImportable, { type: field.type });
}

/**
 * The Map step's fields pane (StepMap.dc.html): one drop target per row, each also a button that
 * selects it for the detail panel. `pending` replaces the rows while the fields load or fail.
 * `looks` says what each sample key's values look like, for the sentence that says what to check.
 */
export function FieldsPane(p: {
	heading: string;
	rows: readonly DetailRow[];
	mappings: WizardState["rows"];
	meta: WizardState["meta"];
	blockers: readonly Blocker[];
	looks: ReadonlyMap<string, LooksLike | null>;
	selected: Selection | null;
	onSelect(id: Selection): void;
	onClear(id: DetailRow["id"]): void;
	pending: ReactNode;
}) {
	const t = useT();
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 pt-3 pb-2">
				<h3 id={headingId} className="truncate font-semibold" title={p.heading}>
					{p.heading}
				</h3>
				<span className="text-xs text-kumo-subtle">{t(M.fieldsHint)}</span>
			</div>
			{p.pending === null ? (
				<ul className="divide-y divide-kumo-line border-t border-kumo-hairline">
					{p.rows.map((row) => (
						<FieldRow
							key={row.id}
							row={row}
							mapping={p.mappings[row.id]}
							meta={p.meta[row.id]}
							blockers={p.blockers.filter((b) => b.row === row.id)}
							looks={p.looks}
							selected={p.selected === row.id}
							onSelect={() => p.onSelect(row.id)}
							onClear={() => p.onClear(row.id)}
						/>
					))}
					<AddFieldRow selected={p.selected === NEW_FIELD} onSelect={() => p.onSelect(NEW_FIELD)} />
				</ul>
			) : (
				<div className="p-3">{p.pending}</div>
			)}
		</section>
	);
}

/**
 * A row's type, as the mockup shows it beside the label. A selected row keeps the pane's base
 * colour, with the brand bar on its left: the quiet text keeps AA contrast only on the base.
 */
function typeOf(t: T, row: DetailRow): string | null {
	if (row.kind === "field") return row.field?.type ?? null;
	if (row.kind === "taxonomy") return t(M.taxonomyType);
	if (row.kind === "key") return t(M.keyHint);
	return null;
}

/** Whether a row must be mapped: the key, `translationOf`, and a required field. */
export function isRequired(row: DetailRow): boolean {
	if (row.kind === "key" || row.kind === "translationOf") return true;
	return row.field?.required === true;
}

/** Whether no mapping can write the row's field (it is then disabled). */
export function isUnmappable(row: DetailRow): boolean {
	return row.field !== undefined && !mappable(row.field);
}

/**
 * The suggestion's badge colour (Spec "Suggestion"): AI with high or medium confidence in info,
 * a name match in teal, anything with low confidence in orange, a template's in neutral. The
 * words say the same, so colour is never the only sign.
 */
function badgeVariant(meta: RowMeta): "info" | "teal" | "orange" | "neutral" {
	if (meta.origin === "template") return "neutral";
	if (meta.confidence !== undefined && meta.confidence < 0.5) return "orange";
	return meta.origin === "ai" ? "info" : "teal";
}

/** What values a mapping type reads: text, numbers or dates; null for the other types. */
const READS: Readonly<Record<string, LooksLike>> = {
	text: "text",
	slug: "text",
	number: "number",
	date: "date",
};

/**
 * Whether the key's values look like numbers or dates that the mapping type does not read as such
 * (Copy: "a number into a text field"). Numbers into a date are not: they may be Unix times.
 */
function mismatchOf(looks: LooksLike | null, mappingType: unknown): "number" | "date" | null {
	if (looks === null || looks === "text" || typeof mappingType !== "string") return null;
	const reads = Object.hasOwn(READS, mappingType) ? READS[mappingType] : undefined;
	if (reads === undefined || reads === looks) return null;
	return looks === "number" && reads === "date" ? null : looks;
}

/**
 * What a "check" asks the user to look at (Copy: "Check: a number into a text field. AI was not
 * sure."): a key the sample lacks; values that look like numbers or dates going into another
 * type, and why the row is checked; else a suggestion that was not sure, or (the suggestion
 * flagged its format) the values' format.
 */
function checkText(
	t: T,
	meta: RowMeta,
	mapping: RowMapping,
	from: string | null,
	fieldType: string | null,
	looks: ReadonlyMap<string, LooksLike | null>,
): string {
	if (from !== null && !looks.has(from)) return t(M.checkMissing, { key: from });
	const unsure = meta.confidence !== undefined && meta.confidence < 0.5;
	const into =
		from === null || fieldType === null ? null : mismatchOf(looks.get(from) ?? null, mapping.type);
	if (into === null || fieldType === null) return t(unsure ? M.checkUnsure : M.checkFormat);
	const why = !unsure ? M.whyFormat : meta.origin === "ai" ? M.whyUnsureAi : M.whyUnsure;
	const what = t(into === "number" ? M.checkNumberInto : M.checkDateInto, { type: fieldType });
	return `${what} ${t(why)}`;
}

function FieldRow(p: {
	row: DetailRow;
	mapping: RowMapping | undefined;
	meta: RowMeta | undefined;
	blockers: readonly Blocker[];
	looks: ReadonlyMap<string, LooksLike | null>;
	selected: boolean;
	onSelect(): void;
	onClear(): void;
}) {
	const t = useT();
	const { row, mapping, meta } = p;
	const reason = unmappableReason(t, row.field);
	const { setNodeRef, isOver } = useDroppable({ id: row.id, disabled: reason !== null });
	const type = typeOf(t, row);
	const badge = meta === undefined ? null : badgeText(t, meta);
	const from = typeof mapping?.from === "string" ? mapping.from : null;
	const chip = mapping === undefined ? null : (from ?? t(M.expressionChip));
	return (
		<li
			ref={setNodeRef}
			data-testid={row.id}
			className={
				isOver
					? "flex flex-col gap-1 border-l-2 border-kumo-brand bg-kumo-tint px-3 py-2"
					: p.selected
						? "flex flex-col gap-1 border-l-2 border-kumo-brand px-3 py-2"
						: "flex flex-col gap-1 border-l-2 border-transparent px-3 py-2"
			}
		>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					aria-pressed={p.selected}
					disabled={reason !== null}
					onClick={p.onSelect}
					className={
						reason === null
							? "flex max-w-full shrink-0 grow flex-wrap items-baseline gap-x-2 rounded-sm text-left text-sm focus-visible:outline-2 focus-visible:outline-kumo-focus"
							: "flex max-w-full shrink-0 grow cursor-not-allowed flex-wrap items-baseline gap-x-2 text-left text-sm text-kumo-subtle"
					}
				>
					<span
						className={
							reason === null
								? "max-w-48 shrink-0 truncate font-semibold text-kumo-default"
								: "max-w-48 shrink-0 truncate font-semibold"
						}
						title={row.label}
					>
						{row.label}
					</span>
					{type === null ? null : <span className="shrink-0 text-xs text-kumo-subtle">{type}</span>}
					{isRequired(row) ? <Badge variant="neutral">{t(M.required)}</Badge> : null}
				</button>
				<span className="flex flex-wrap items-center justify-end gap-1.5">
					{chip !== null ? (
						<span className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-kumo-line bg-kumo-recessed ps-2">
							<code className="min-w-0 truncate font-mono text-xs font-medium" title={chip}>
								{chip}
							</code>
							<Button
								variant="ghost"
								shape="square"
								size="xs"
								icon={<XIcon aria-hidden="true" />}
								aria-label={
									from === null
										? t(M.removeExpression, { field: row.label })
										: t(M.removeKey, { key: from, field: row.label })
								}
								onClick={p.onClear}
							/>
						</span>
					) : reason === null ? (
						<span className="flex h-7 items-center rounded-md border border-dashed border-kumo-line px-2 text-xs text-kumo-subtle">
							{t(M.dropKey)}
						</span>
					) : null}
					{chip !== null && meta !== undefined && badge !== null ? (
						<Badge variant={badgeVariant(meta)}>{badge}</Badge>
					) : null}
				</span>
			</div>
			{mapping !== undefined && meta?.check === true ? (
				<p className="flex items-center gap-1.5 text-xs">
					<WarningIcon aria-hidden="true" className="shrink-0 text-kumo-warning" />
					{checkText(t, meta, mapping, from, row.field?.type ?? null, p.looks)}
				</p>
			) : null}
			{reason === null ? null : <p className="text-xs text-kumo-subtle">{reason}</p>}
			{p.blockers.map((b) => (
				<p key={b.msg.id} className="text-xs text-kumo-danger">
					{t(b.msg, b.values)}
				</p>
			))}
		</li>
	);
}

/**
 * "+ Drop a key here to propose a new field": a drop target, and a button that opens the key
 * picker, the keyboard path (preflight F25).
 */
function AddFieldRow(p: { selected: boolean; onSelect(): void }) {
	const t = useT();
	const { setNodeRef, isOver } = useDroppable({ id: NEW_FIELD });
	return (
		<li
			ref={setNodeRef}
			data-testid={NEW_FIELD}
			className={
				isOver
					? "border-t border-dashed border-kumo-brand bg-kumo-tint px-3 py-2"
					: p.selected
						? "border-t border-dashed border-kumo-brand px-3 py-2 font-semibold"
						: "border-t border-dashed border-kumo-line px-3 py-2"
			}
		>
			<button
				type="button"
				aria-pressed={p.selected}
				onClick={p.onSelect}
				className="rounded-sm text-left text-sm focus-visible:outline-2 focus-visible:outline-kumo-focus"
			>
				{t(M.addField)}
			</button>
		</li>
	);
}
