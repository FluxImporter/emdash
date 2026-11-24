import { Badge, Button } from "@cloudflare/kumo";
import { useDroppable } from "@dnd-kit/core";
import { type ReactNode, useId } from "react";
import { type Msg, useT, type Values } from "../../i18n.js";
import type { SchemaField, TaxonomyInfo } from "../../types.js";
import {
	type Blocker,
	mappable,
	type RowMapping,
	type RowMeta,
	type WizardState,
} from "../state.js";
import { badgeText, type DetailRow } from "./detail/DetailPanel.js";
import { M as DETAIL } from "./detail/messages.js";
import { M } from "./messages.js";

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
 * The Map step's middle pane: one drop target per row, each also a button that selects it for
 * the detail panel. `pending` replaces the rows while the fields load or fail.
 */
export function FieldsPane(p: {
	heading: string;
	rows: readonly DetailRow[];
	mappings: WizardState["rows"];
	meta: WizardState["meta"];
	blockers: readonly Blocker[];
	selected: Selection | null;
	onSelect(id: Selection): void;
	onClear(id: DetailRow["id"]): void;
	pending: ReactNode;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="min-w-0 space-y-3 rounded-lg border border-kumo-line p-3 xl:col-span-4"
		>
			<h3 id={headingId} className="truncate text-base font-semibold" title={p.heading}>
				{p.heading}
			</h3>
			{p.pending ?? (
				<ul>
					{p.rows.map((row) => (
						<FieldRow
							key={row.id}
							row={row}
							mapping={p.mappings[row.id]}
							meta={p.meta[row.id]}
							blockers={p.blockers.filter((b) => b.row === row.id)}
							selected={p.selected === row.id}
							onSelect={() => p.onSelect(row.id)}
							onClear={() => p.onClear(row.id)}
						/>
					))}
					<AddFieldRow selected={p.selected === NEW_FIELD} onSelect={() => p.onSelect(NEW_FIELD)} />
				</ul>
			)}
		</section>
	);
}

/** A row's type, as the mockup shows it beside the label. */
function typeOf(t: T, row: DetailRow): string | null {
	if (row.kind === "field") return row.field?.type ?? null;
	if (row.kind === "taxonomy") return t(M.taxonomyType);
	if (row.kind === "key") return t(M.keyHint);
	return null;
}

function isRequired(row: DetailRow): boolean {
	if (row.kind === "key" || row.kind === "translationOf") return true;
	return row.field?.required === true;
}

function FieldRow(p: {
	row: DetailRow;
	mapping: RowMapping | undefined;
	meta: RowMeta | undefined;
	blockers: readonly Blocker[];
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
					? "space-y-1 rounded-md border border-kumo-brand bg-kumo-tint px-2 py-2"
					: p.selected
						? "space-y-1 rounded-md border border-kumo-line bg-kumo-tint px-2 py-2"
						: "space-y-1 rounded-md border border-transparent px-2 py-2"
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
							? "flex max-w-full shrink-0 grow items-baseline gap-2 rounded-sm text-left text-sm focus-visible:outline-2 focus-visible:outline-kumo-focus"
							: "flex max-w-full shrink-0 grow cursor-not-allowed items-baseline gap-2 text-left text-sm text-kumo-subtle"
					}
				>
					<span className="max-w-48 shrink-0 truncate font-medium" title={row.label}>
						{row.label}
					</span>
					{isRequired(row) ? (
						<>
							<span aria-hidden="true" className="text-kumo-danger">
								*
							</span>
							<span className="sr-only">{t(M.required)}</span>
						</>
					) : null}
					{type === null ? null : <span className="shrink-0 text-xs text-kumo-subtle">{type}</span>}
				</button>
				{chip !== null ? (
					<span className="flex min-w-0 items-center gap-1 rounded-full border border-kumo-line bg-kumo-base pl-2 text-xs">
						<span className="min-w-0 truncate" title={chip}>
							{chip}
						</span>
						<Button
							variant="ghost"
							size="xs"
							aria-label={
								from === null
									? t(M.removeExpression, { field: row.label })
									: t(M.removeKey, { key: from, field: row.label })
							}
							onClick={p.onClear}
						>
							{t(M.remove)}
						</Button>
					</span>
				) : reason === null ? (
					<span className="rounded-full border border-dashed border-kumo-line px-2 text-xs text-kumo-subtle">
						{t(M.dropKey)}
					</span>
				) : null}
				{chip !== null && badge !== null ? <Badge variant="secondary">{badge}</Badge> : null}
				{chip !== null && meta?.check === true ? (
					<Badge variant="warning">{t(DETAIL.check)}</Badge>
				) : null}
			</div>
			{reason === null ? null : <p className="text-xs text-kumo-subtle">{reason}</p>}
			{p.blockers.map((b) => (
				<p key={b.msg.id} className="text-xs text-kumo-danger">
					{t(b.msg, b.values)}
				</p>
			))}
		</li>
	);
}

/** "+ Add a new field": a drop target, and a button that opens the key picker (preflight F25). */
function AddFieldRow(p: { selected: boolean; onSelect(): void }) {
	const t = useT();
	const { setNodeRef, isOver } = useDroppable({ id: NEW_FIELD });
	return (
		<li
			ref={setNodeRef}
			data-testid={NEW_FIELD}
			className={
				isOver
					? "mt-2 space-y-1 rounded-md border border-dashed border-kumo-brand bg-kumo-tint px-2 py-2"
					: p.selected
						? "mt-2 space-y-1 rounded-md border border-dashed border-kumo-line bg-kumo-tint px-2 py-2"
						: "mt-2 space-y-1 rounded-md border border-dashed border-kumo-line px-2 py-2"
			}
		>
			<button
				type="button"
				aria-pressed={p.selected}
				onClick={p.onSelect}
				className="rounded-sm text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-kumo-focus"
			>
				{t(M.addField)}
			</button>
			<p className="text-xs text-kumo-subtle">{t(M.addFieldHint)}</p>
		</li>
	);
}
