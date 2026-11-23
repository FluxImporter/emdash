import { Banner, Button, Dialog, Loader } from "@cloudflare/kumo";
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
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { describeError, describeWarning } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { queryKeys, useFields, useSite } from "../../queries.js";
import type { SampleColumn, SchemaField } from "../../types.js";
import { useWizard } from "../context.js";
import { StepFooter } from "../StepFooter.js";
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
import { FieldsPane, mapRows, NEW_FIELD, type Selection } from "./FieldsPane.js";
import { KeysPane, keyOfDrag } from "./KeysPane.js";
import { M } from "./messages.js";
import { proposeField } from "./new-fields/infer.js";
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

/** The source keys the draft reads: every row's `from` and every proposed field's key. */
function usedKeys(state: WizardState): Set<string> {
	const used = new Set<string>();
	for (const m of Object.values(state.rows)) {
		if (typeof m?.from === "string") used.add(m.from);
	}
	for (const f of state.newFields) used.add(f.key);
	return used;
}

/** The suggestion's rows as they stand: filled, and those still to check. */
function suggestedCounts(state: WizardState): { filled: number; check: number } {
	let filled = 0;
	let check = 0;
	for (const [row, meta] of Object.entries(state.meta)) {
		if (meta === undefined || (meta.origin !== "ai" && meta.origin !== "name")) continue;
		if (state.rows[row as RowId] === undefined) continue;
		if (meta.check) check += 1;
		else filled += 1;
	}
	return { filled, check };
}

/** The status line (spec "Suggestions"): the method and counts, or name matching. */
function statusText(t: T, state: WizardState): string | null {
	const reply = state.suggestion.reply;
	if (state.suggestion.status !== "done" || reply === undefined) return null;
	const { provider, available } = reply.ai;
	if (reply.method === "ai" && provider !== undefined) {
		return t(M.statusAi, { provider: t(M.providers[provider]), ...suggestedCounts(state) });
	}
	// A provider that is set but cannot be used; "none" sets no provider and expects none.
	return !available && provider !== undefined ? t(M.statusNameUnavailable) : t(M.statusName);
}

/**
 * Step 3 (spec "3. Map"): source keys on the left, the collection's rows in the middle, and the
 * selected row's detail panel on the right. A key is dragged onto a row (pointer or keyboard), or
 * picked in the panel. Next is blocked by `mapBlockers`; with proposed fields it opens the schema
 * diff first (preflight F3), and leaves once they are applied and mapped.
 */
export function MapStep() {
	const t = useT();
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
	const used = usedKeys(state);
	const known = new Set(columns.map((c) => c.key));
	const extraKeys = [...used].filter((k) => !known.has(k));
	const blockers: Blocker[] = fields.data === undefined ? [] : mapBlockers(state, fields.data);
	const loading = suggestions.status === "loading";

	const labelOf = (id: string | number) =>
		id === NEW_FIELD ? t(M.addField) : (rows.find((r) => r.id === id)?.label ?? String(id));

	const propose = (key: string) => {
		const s = latest.current;
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
						{t(M.tryAgain)}
					</Button>
				}
			/>
		);
	} else if (fields.data === undefined) {
		pending = <Loader aria-label={t(M.fieldsLoading)} />;
	}

	return (
		<div className="space-y-4">
			<SuggestionNotices onRetry={askAgain} />
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
				<div className="grid gap-4 md:grid-cols-3">
					<KeysPane columns={columns} extraKeys={extraKeys} used={used} />
					<FieldsPane
						heading={t(M.fieldsHeading, { collection: collectionLabel })}
						rows={rows}
						mappings={state.rows}
						meta={state.meta}
						blockers={blockers}
						selected={selected}
						onSelect={setSelected}
						onClear={(id) => setRow(id, null)}
						pending={pending}
					/>
					<aside
						aria-label={t(M.detailHeading)}
						className="space-y-4 rounded-lg border border-kumo-line p-3"
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
							data-testid="drag-overlay"
							className="max-w-full cursor-grab truncate rounded-md border border-kumo-brand bg-kumo-base px-2 py-1 text-sm font-medium shadow-sm"
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
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<span className="font-medium">{t(M.suggestions)}</span>
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
				<Button variant="secondary" size="sm" disabled={loading} onClick={askAgain}>
					{t(M.askAgain)}
				</Button>
			</div>
			{blockers.some((b) => b.row === null) ? (
				<ul className="space-y-1 text-sm text-kumo-danger">
					{blockers
						.filter((b) => b.row === null)
						.map((b) => (
							<li key={b.msg.id}>{t(b.msg, b.values)}</li>
						))}
				</ul>
			) : null}
			<StepFooter
				canNext={fields.data !== undefined && !loading && blockers.length === 0}
				{...(reason === undefined ? {} : { reason })}
				onNext={onNext}
			/>
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
						{t(M.tryAgain)}
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
				<Dialog.Title>{t(M.replaceTitle)}</Dialog.Title>
				<Dialog.Description>{t(M.replaceDescription)}</Dialog.Description>
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
