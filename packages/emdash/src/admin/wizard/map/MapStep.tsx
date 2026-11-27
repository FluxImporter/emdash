import { Badge, Banner, Button, Dialog, Loader } from "@cloudflare/kumo";
import {
	type Announcements,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react";
import { describeError, describeWarning } from "../../errors.js";
import { type Msg, useT, useTn, type Values } from "../../i18n.js";
import { M as SHARED } from "../../messages.js";
import { queryKeys, useFields, useSite } from "../../queries.js";
import type { SampleColumn, SchemaField } from "../../types.js";
import { useNarrow } from "../../ui/use-narrow.js";
import { useWizard } from "../context.js";
import { COUNT as SHELL_COUNT, SUMMARY } from "../messages.js";
import { StepHeader } from "../StepHeader.js";
import {
	type Blocker,
	mapBlockers,
	type RowId,
	type RowMapping,
	reducer,
	type WizardAction,
	type WizardState,
} from "../state.js";
import { compatibleTypes, DetailPanel, type DetailRow } from "./detail/DetailPanel.js";
import { KeyPicker } from "./detail/KeyPicker.js";
import {
	FieldsPane,
	isRequired,
	isUnmappable,
	mapRows,
	NEW_FIELD,
	type Selection,
} from "./FieldsPane.js";
import { KeysPane, keyOfDrag } from "./KeysPane.js";
import { COUNT, M } from "./messages.js";
import { looksLike, proposeField } from "./new-fields/infer.js";
import { NewFields } from "./new-fields/NewFields.js";
import { SchemaDiffDialog } from "./new-fields/SchemaDiffDialog.js";
import { useSuggestions } from "./useSuggestions.js";

type T = (msg: Msg, values?: Values) => string;

const NO_COLUMNS: SampleColumn[] = [];
const NO_FIELDS: SchemaField[] = [];

/**
 * A row's mapping once `key` is dropped on it or picked for it: as the detail panel's pick does,
 * the key replaces the source and keeps the row's settings; a field row starts with the first
 * mapping type that writes its field type.
 */
function withKey(row: DetailRow, mapping: RowMapping | undefined, key: string): RowMapping {
	if (row.kind === "key" || row.kind === "slug" || row.kind === "translationOf") {
		return { from: key };
	}
	if (mapping !== undefined) {
		const { from: _from, expr: _expr, ...settings } = mapping;
		return { ...settings, from: key } as RowMapping;
	}
	const type = row.field === undefined ? undefined : compatibleTypes(row.field.type)[0];
	return (type === undefined ? { from: key } : { type, from: key }) as RowMapping;
}

/**
 * The source keys the draft reads, each with the rows that read it (by label): every row's `from`
 * and every proposed field's key.
 */
function keyUsage(state: WizardState, rows: readonly DetailRow[]): Map<string, string[]> {
	const usage = new Map<string, string[]>();
	const add = (key: string, label: string) => usage.set(key, [...(usage.get(key) ?? []), label]);
	for (const [id, m] of Object.entries(state.rows)) {
		if (typeof m?.from !== "string") continue;
		add(m.from, rows.find((r) => r.id === id)?.label ?? id);
	}
	for (const f of state.newFields) add(f.key, f.label === "" ? f.slug : f.label);
	return usage;
}

/** The summary bar's counts: rows mapped of those that can be, required rows done, and checks. */
function mapCounts(state: WizardState, rows: readonly DetailRow[]) {
	const open = rows.filter((r) => !isUnmappable(r));
	const mapped = open.filter((r) => state.rows[r.id] !== undefined);
	const required = open.filter(isRequired);
	const requiredLeft = required.filter((r) => state.rows[r.id] === undefined).length;
	const check = mapped.filter((r) => state.meta[r.id]?.check === true).length;
	return {
		total: open.length,
		mapped: mapped.length,
		required: required.length,
		requiredLeft,
		check,
	};
}

/** How the suggestions were made (spec "Suggestions"): by AI and its provider, or by name. */
function statusText(t: T, state: WizardState): string | null {
	const reply = state.suggestion.reply;
	if (state.suggestion.status !== "done" || reply === undefined) return null;
	const { provider, available } = reply.ai;
	if (reply.method === "ai" && provider !== undefined) {
		return t(M.statusAi, { provider: t(M.providers[provider]) });
	}
	// A provider that is set but cannot be used; "none" sets no provider and expects none.
	return !available && provider !== undefined ? t(M.statusNameUnavailable) : t(M.statusName);
}

/**
 * Step 3 (spec "3. Map", StepMap.dc.html): a summary bar (fields mapped, what to check, how the
 * suggestions were made), then the source keys, the collection's rows and the selected row's
 * detail panel, side by side on a wide page and stacked on a narrow one. A key is dragged onto a row (pointer or keyboard), or
 * picked in the panel. Next is blocked by `mapBlockers`; with proposed fields it opens the schema
 * diff first (preflight F3), and leaves once they are applied and mapped.
 */
export function MapStep() {
	const t = useT();
	const tn = useTn();
	// Three panes need about 1,000px; below that the keys span the page, and below 700px every
	// pane does (measured on the step, not the viewport).
	const [narrowRef, narrow] = useNarrow<HTMLDivElement>();
	const [mediumRef, medium] = useNarrow<HTMLDivElement>(1000);
	const panesRef = useCallback(
		(node: HTMLDivElement | null) => {
			narrowRef(node);
			mediumRef(node);
		},
		[narrowRef, mediumRef],
	);
	const { state, dispatch } = useWizard();
	const latest = useRef(state);
	latest.current = state;
	const queryClient = useQueryClient();
	const site = useSite();
	const collection = state.target?.collection ?? null;
	const fields = useFields(collection);
	const suggestions = useSuggestions();
	const [selected, setSelected] = useState<Selection | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [applying, setApplying] = useState(false);
	/** The key being dragged, drawn in the overlay. */
	const [dragging, setDragging] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor),
	);

	const columns = state.columns ?? NO_COLUMNS;
	const fieldList = fields.data ?? NO_FIELDS;
	const taxonomies = site.data?.taxonomies;
	const rows = useMemo(
		() => (state.target === null ? [] : mapRows(t, fieldList, taxonomies ?? [], state.target)),
		[t, fieldList, taxonomies, state.target],
	);
	const usage = keyUsage(state, rows);
	const looks = useMemo(
		() => new Map(columns.map((c) => [c.key, looksLike(c.values)] as const)),
		[columns],
	);
	const known = new Set(looks.keys());
	const extraKeys = [...usage.keys()].filter((k) => !known.has(k));
	const blockers: Blocker[] = fields.data === undefined ? [] : mapBlockers(state, fields.data);
	const loading = suggestions.status === "loading";

	const labelOf = (id: string | number) =>
		id === NEW_FIELD ? t(M.newFieldTarget) : (rows.find((r) => r.id === id)?.label ?? String(id));

	const propose = (key: string) => {
		const s = latest.current;
		// One proposal per key: a second drop or pick of the same key adds nothing.
		if (s.newFields.some((f) => f.key === key)) return;
		const column = columns.find((c) => c.key === key) ?? { key, values: [] };
		const taken = [...fieldList.map((f) => f.slug), ...s.newFields.map((f) => f.slug)];
		dispatch({ type: "fieldProposed", field: proposeField(column, taken) });
	};

	const setRow = (id: RowId, mapping: RowMapping | null) =>
		dispatch(
			mapping === null ? { type: "rowCleared", row: id } : { type: "rowSet", row: id, mapping },
		);

	const onDragEnd = ({ active, over }: DragEndEvent) => {
		setDragging(null);
		if (over === null) return;
		const key = keyOfDrag(active.id);
		if (over.id === NEW_FIELD) {
			propose(key);
			return;
		}
		const row = rows.find((r) => r.id === over.id);
		if (row !== undefined) setRow(row.id, withKey(row, latest.current.rows[row.id], key));
	};

	const announcements: Announcements = {
		onDragStart: ({ active }) => t(M.pickedUp, { key: keyOfDrag(active.id) }),
		onDragOver: ({ active, over }) =>
			over === null
				? t(M.notOver, { key: keyOfDrag(active.id) })
				: t(M.over, { key: keyOfDrag(active.id), field: labelOf(over.id) }),
		onDragEnd: ({ active, over }) =>
			over === null
				? t(M.droppedNowhere, { key: keyOfDrag(active.id) })
				: t(M.dropped, { key: keyOfDrag(active.id), field: labelOf(over.id) }),
		onDragCancel: ({ active }) => t(M.cancelled, { key: keyOfDrag(active.id) }),
	};

	const askAgain = () => {
		const handSet = Object.values(state.meta).some((m) => m?.origin === "user");
		if (handSet) setConfirming(true);
		else void suggestions.ask(false);
	};

	/** The schema diff applied `slugs`: map each proposal's key to its new field, then leave. */
	const applied = (slugs: string[]) => {
		const s = latest.current;
		const done = new Set(slugs);
		const actions: WizardAction[] = [];
		for (const f of s.newFields) {
			const type = compatibleTypes(f.type)[0];
			if (!done.has(f.slug) || type === undefined) continue;
			actions.push({ type: "rowSet", row: `field:${f.slug}`, mapping: { type, from: f.key } });
		}
		actions.push({ type: "fieldsApplied", slugs });
		const next = actions.reduce(reducer, s);
		for (const action of actions) dispatch(action);
		// A late conflict leaves its proposal: the dialog stays open and plans it again.
		if (next.newFields.length > 0) return;
		setApplying(false);
		// The dialog has awaited the fields' refetch, so the new fields are read here.
		const fresh =
			collection === null
				? fieldList
				: (queryClient.getQueryData<SchemaField[]>(queryKeys.fields(collection)) ?? fieldList);
		if (mapBlockers(next, fresh).length === 0) dispatch({ type: "stepChanged", step: "options" });
	};

	const onNext = () => {
		if (state.newFields.length > 0) setApplying(true);
		else dispatch({ type: "stepChanged", step: "options" });
	};

	let reason: string | undefined;
	if (fields.data === undefined) reason = fields.isError ? undefined : t(M.waitFields);
	else if (loading) reason = t(M.waitSuggestions);
	else if (blockers[0] !== undefined) reason = t(blockers[0].msg, blockers[0].values);

	const collectionLabel =
		site.data?.collections.find((c) => c.slug === collection)?.label ?? collection ?? "";
	const selectedRow = rows.find((r) => r.id === selected);

	let pending: ReactNode = null;
	if (fields.isError) {
		const { msg, values, detail } = describeError(fields.error);
		pending = (
			<Banner
				variant="error"
				role="alert"
				title={t(msg, values)}
				{...(detail === undefined ? {} : { description: detail })}
				action={
					<Button variant="secondary" onClick={() => void fields.refetch()}>
						{t(SHARED.tryAgain)}
					</Button>
				}
			/>
		);
	} else if (fields.data === undefined) {
		pending = <Loader aria-label={t(M.fieldsLoading)} />;
	}

	const counts = mapCounts(state, rows);
	const sourceName = state.source?.label ?? state.base?.name ?? "";
	const summary =
		state.target === null
			? undefined
			: t(SUMMARY.map, {
					source: sourceName,
					keys: tn(SHELL_COUNT.keys, columns.length),
					collection: state.target.collection,
					locale: state.target.locale,
				});

	return (
		<div className="flex flex-col gap-4">
			<StepHeader
				{...(summary === undefined ? {} : { summary })}
				next={{
					canNext: fields.data !== undefined && !loading && blockers.length === 0,
					...(reason === undefined ? {} : { reason }),
					onNext,
				}}
			/>
			<SuggestionNotices onRetry={askAgain} />
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-kumo-hairline bg-kumo-base px-4 py-2.5">
				{fields.data === undefined ? null : (
					<p className="text-sm">
						<span className="font-semibold">
							{tn(COUNT.mapped, counts.total, { mapped: counts.mapped })}
						</span>{" "}
						<span className="text-kumo-subtle">
							{counts.requiredLeft > 0
								? tn(COUNT.requiredLeft, counts.requiredLeft)
								: tn(COUNT.requiredDone, counts.required)}
						</span>
					</p>
				)}
				{counts.check > 0 ? (
					<Badge variant="orange">{tn(COUNT.toCheck, counts.check)}</Badge>
				) : null}
				<div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
					<span aria-live="polite" className="flex items-center gap-2 text-kumo-subtle">
						{loading ? (
							<>
								<Loader />
								{t(M.asking)}
							</>
						) : (
							statusText(t, state)
						)}
					</span>
					<Button variant="outline" size="sm" disabled={loading} onClick={askAgain}>
						{t(M.askAgain)}
					</Button>
				</div>
			</div>
			<DndContext
				sensors={sensors}
				onDragStart={({ active }) => setDragging(keyOfDrag(active.id))}
				onDragEnd={onDragEnd}
				onDragCancel={() => setDragging(null)}
				accessibility={{
					announcements,
					screenReaderInstructions: { draggable: t(M.instructions) },
				}}
			>
				<div
					ref={panesRef}
					className={
						narrow
							? "flex flex-col gap-3"
							: medium
								? "flex flex-wrap items-start gap-3"
								: "flex items-start gap-3"
					}
				>
					<div className={narrow ? "" : medium ? "w-full" : "w-56 shrink-0"}>
						<KeysPane columns={columns} extraKeys={extraKeys} usage={usage} wide={medium} />
					</div>
					<div className={narrow ? "" : "min-w-0 flex-1"}>
						<FieldsPane
							heading={t(M.fieldsHeading, { collection: collectionLabel })}
							rows={rows}
							mappings={state.rows}
							meta={state.meta}
							blockers={blockers}
							looks={looks}
							selected={selected}
							onSelect={setSelected}
							onClear={(id) => setRow(id, null)}
							pending={pending}
						/>
					</div>
					<aside
						aria-label={t(M.detailHeading)}
						className={
							narrow
								? "flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-hairline bg-kumo-base p-4"
								: "flex w-72 min-w-0 shrink-0 flex-col gap-3 rounded-lg border border-kumo-hairline bg-kumo-base p-4"
						}
					>
						{selected === NEW_FIELD ? (
							<NewFieldPicker columns={columns} onPick={propose} />
						) : selectedRow !== undefined ? (
							<DetailPanel
								row={selectedRow}
								mapping={state.rows[selectedRow.id]}
								meta={state.meta[selectedRow.id]}
								columns={columns}
								onChange={(m) => setRow(selectedRow.id, m)}
								onKeep={() => dispatch({ type: "rowKept", row: selectedRow.id })}
							/>
						) : (
							<p className="text-sm text-kumo-subtle">{t(M.nothingSelected)}</p>
						)}
					</aside>
				</div>
				{/* Drawn above the panes, so the keys list can scroll and clip while a key moves. */}
				<DragOverlay dropAnimation={null}>
					{dragging === null ? null : (
						<div
							aria-hidden="true"
							data-testid="drag-overlay"
							className="max-w-full cursor-grab truncate rounded-md border border-kumo-brand bg-kumo-base px-2 py-1 font-mono text-sm font-medium shadow-sm"
						>
							{dragging}
						</div>
					)}
				</DragOverlay>
			</DndContext>
			<NewFields
				fields={state.newFields}
				onChange={(slug, patch) => dispatch({ type: "fieldChanged", slug, patch })}
				onRemove={(slug) => dispatch({ type: "fieldRemoved", slug })}
			/>
			{blockers.some((b) => b.row === null) ? (
				<ul className="space-y-1 text-sm text-kumo-danger">
					{blockers
						.filter((b) => b.row === null)
						.map((b) => (
							<li key={b.msg.id}>{t(b.msg, b.values)}</li>
						))}
				</ul>
			) : null}
			<AskAgainDialog
				open={confirming}
				onClose={() => setConfirming(false)}
				onAsk={(overwrite) => {
					setConfirming(false);
					void suggestions.ask(overwrite);
				}}
			/>
			{collection === null ? null : (
				<SchemaDiffDialog
					collection={collection}
					fields={state.newFields}
					open={applying && state.newFields.length > 0}
					onApplied={applied}
					onCancel={() => setApplying(false)}
				/>
			)}
		</div>
	);
}

/** A failed suggestion as its sentence, and the reply's warnings as dismissible sentences. */
function SuggestionNotices(p: { onRetry(): void }) {
	const t = useT();
	const { state, dispatch } = useWizard();
	const { status, reply, error, dismissed } = state.suggestion;
	if (status === "error") {
		const { msg, values, detail } = describeError(error);
		return (
			<Banner
				variant="error"
				role="alert"
				title={t(msg, values)}
				description={detail === undefined ? t(M.suggestFailed) : `${detail} ${t(M.suggestFailed)}`}
				action={
					<Button variant="secondary" onClick={p.onRetry}>
						{t(SHARED.tryAgain)}
					</Button>
				}
			/>
		);
	}
	if (status !== "done" || reply === undefined || reply.warnings.length === 0 || dismissed) {
		return null;
	}
	return (
		<Banner
			variant="alert"
			title={t(M.warningsTitle)}
			description={
				<ul className="list-disc pl-4">
					{reply.warnings.map((w) => {
						const { msg, values } = describeWarning(w);
						return <li key={w.code}>{t(msg, values)}</li>;
					})}
				</ul>
			}
			action={
				<Button variant="secondary" onClick={() => dispatch({ type: "warningsDismissed" })}>
					{t(M.dismiss)}
				</Button>
			}
		/>
	);
}

/** The keyboard path for "+ Add a new field" (preflight F25): pick the key to propose. */
function NewFieldPicker(p: { columns: readonly SampleColumn[]; onPick(key: string): void }) {
	const t = useT();
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h3 id={headingId} className="text-base font-medium">
				{t(M.newFieldHeading)}
			</h3>
			<p className="text-sm text-kumo-subtle">{t(M.newFieldIntro)}</p>
			<KeyPicker columns={p.columns} value={null} label={t(M.newFieldKey)} onPick={p.onPick} />
		</section>
	);
}

/** "Ask again" with rows the user set: keep them, or let the suggestion replace them. */
function AskAgainDialog(p: { open: boolean; onClose(): void; onAsk(overwrite: boolean): void }) {
	const t = useT();
	return (
		<Dialog.Root
			open={p.open}
			onOpenChange={(open: boolean) => {
				if (!open) p.onClose();
			}}
		>
			<Dialog className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{t(M.replaceTitle)}</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{t(M.replaceDescription)}
				</Dialog.Description>
				<div className="flex justify-end gap-3">
					<Button variant="secondary" onClick={p.onClose}>
						{t(M.cancel)}
					</Button>
					<Button variant="secondary" onClick={() => p.onAsk(false)}>
						{t(M.keepChoices)}
					</Button>
					<Button variant="primary" onClick={() => p.onAsk(true)}>
						{t(M.replaceChoices)}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
