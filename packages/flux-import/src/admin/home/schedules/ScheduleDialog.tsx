import { Banner, Button, Dialog, Input, Loader, Radio, Select } from "@cloudflare/kumo";
import type { UseQueryResult } from "@tanstack/react-query";
import { type ChangeEvent, type ReactNode, useState } from "react";
import type {
	CreateScheduleInput,
	ScheduleMissing,
	ScheduleView,
	UpdateScheduleInput,
} from "../../../plugin/schedules.js";
import type { SourceRow } from "../../../plugin/sources.js";
import type { TemplateSummary } from "../../../plugin/templates.js";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { BATCH_SIZE_MAX, TEMPLATE_NAME_MAX } from "../../limits.js";
import { M as PAGE } from "../../messages.js";
import { useTemplate } from "../../queries.js";
import { useHome } from "../Home.js";
import { M as SHARED } from "../shared/messages.js";
import { clock, fromCron, type Timing, toCron } from "./cron.js";
import { DAYS, type Day, M } from "./messages.js";

/** `rules.missing.maxPercent` when a template leaves it out (the engine's `MISSING_MAX_PERCENT_DEFAULT`). */
const MISSING_MAX_PERCENT_DEFAULT = 25;
const DAY_LIST: readonly Day[] = [0, 1, 2, 3, 4, 5, 6];
const KINDS: readonly Timing["kind"][] = ["hourly", "daily", "weekly", "custom"];
const KIND_LABELS: Readonly<Record<Timing["kind"], Msg>> = {
	hourly: M.kindHourly,
	daily: M.kindDaily,
	weekly: M.kindWeekly,
	custom: M.kindCustom,
};
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

type MissingChoice = "template" | "off" | "lower";

interface Form {
	name: string;
	templateId: string | null;
	sourceId: string | null;
	kind: Timing["kind"];
	/** Hourly's minute. */
	minute: string;
	/** Daily's and weekly's `HH:MM`. */
	time: string;
	day: Day;
	cron: string;
	publish: boolean;
	batchSize: string;
	missing: MissingChoice;
	maxPercent: string;
}

type FieldName = "name" | "template" | "source" | "minute" | "time" | "cron" | "batch" | "percent";
type Said = { msg: Msg; values?: Values; detail?: string };

/** A new schedule runs daily at 06:00 UTC and publishes, as the server's defaults do. */
function initialForm(s: ScheduleView | null): Form {
	const base: Form = {
		name: "",
		templateId: null,
		sourceId: null,
		kind: "daily",
		minute: "0",
		time: "06:00",
		day: 1,
		cron: "",
		publish: true,
		batchSize: "",
		missing: "template",
		maxPercent: "",
	};
	if (s === null) return base;
	const t = fromCron(s.cron);
	return {
		...base,
		name: s.name,
		templateId: s.templateId,
		sourceId: s.sourceId,
		kind: t.kind,
		...(t.kind === "custom"
			? { cron: t.cron }
			: {
					minute: String(t.minute),
					...(t.kind === "hourly" ? {} : { time: clock(t.hour, t.minute) }),
				}),
		...(t.kind === "weekly" ? { day: t.day as Day } : {}),
		publish: s.publish,
		batchSize: String(s.batchSize),
		missing: s.missing === false ? "off" : typeof s.missing === "object" ? "lower" : "template",
		maxPercent: typeof s.missing === "object" ? String(s.missing.maxPercent) : "",
	};
}

/** `text` as a whole number from `min` to `max`, else null. */
function wholeIn(text: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(text.trim())) return null;
	const n = Number(text.trim());
	return n >= min && n <= max ? n : null;
}

function timingOf(form: Form, errors: Partial<Record<FieldName, Said>>): Timing | null {
	if (form.kind === "custom") {
		const cron = form.cron.trim();
		if (cron === "") errors.cron = { msg: M.cronRequired };
		return cron === "" ? null : { kind: "custom", cron };
	}
	if (form.kind === "hourly") {
		const minute = wholeIn(form.minute, 0, 59);
		if (minute === null) errors.minute = { msg: M.minuteInvalid };
		return minute === null ? null : { kind: "hourly", minute };
	}
	const match = TIME.exec(form.time.trim());
	if (!match) {
		errors.time = { msg: M.timeInvalid };
		return null;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return form.kind === "daily"
		? { kind: "daily", hour, minute }
		: { kind: "weekly", day: form.day, hour, minute };
}

/**
 * Whether two missing choices run the same: none stored is the template's own, as the engine reads
 * it (`missingOption` in `src/plugin/launch.ts`). `strict` tells them apart, for a move to another
 * template, which the server checks against the stored value as it is.
 */
function sameMissing(
	a: ScheduleMissing | undefined,
	b: ScheduleMissing | undefined,
	strict: boolean,
): boolean {
	const read = (m: ScheduleMissing | undefined) => (strict ? m : (m ?? "template"));
	return JSON.stringify(read(a)) === JSON.stringify(read(b));
}

/**
 * Create or edit a schedule (spec "Create and edit", plan Ruling 13). Create sends every field;
 * edit only the changed ones, with `templateRevision` whenever `templateId` changes. A template
 * with `rules.missing` asks what to do with missing entries. Without a template or a URL source,
 * it says what to create first and goes to that tab.
 */
export function ScheduleDialog(props: {
	open: boolean;
	/** Changes on each opening, so the form starts afresh. */
	opening: number;
	/** The schedule to edit; null creates one. */
	schedule: ScheduleView | null;
	templates: UseQueryResult<TemplateSummary[]>;
	sources: UseQueryResult<SourceRow[]>;
	onClose(): void;
	onSaved(view: ScheduleView, created: boolean): void;
	/** Reads the list again: the schedule as it is now, or undefined once it is gone. */
	onReload(): Promise<ScheduleView | undefined>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const editing = props.schedule;
	const close = () => {
		if (!busy) props.onClose();
	};
	const templates = props.templates.data;
	const sources = props.sources.data;
	let body: ReactNode;
	if (templates === undefined || sources === undefined) {
		const failed = props.templates.error ?? props.sources.error;
		body = failed ? (
			<LoadError
				error={failed}
				retrying={props.templates.isFetching || props.sources.isFetching}
				onRetry={() => {
					if (props.templates.isError) void props.templates.refetch();
					if (props.sources.isError) void props.sources.refetch();
				}}
			/>
		) : (
			<Loader aria-label={t(M.loadingChoices)} />
		);
	} else if (editing === null && (templates.length === 0 || sources.length === 0)) {
		body = <NothingToSchedule onClose={props.onClose} />;
	} else {
		body = (
			<ScheduleForm
				key={props.opening}
				initial={editing}
				templates={templates}
				sources={sources}
				busy={busy}
				setBusy={setBusy}
				onCancel={close}
				onSaved={props.onSaved}
				onReload={props.onReload}
			/>
		);
	}
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={(open: boolean) => {
				if (!open) close();
			}}
		>
			<Dialog size="lg" className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
				<Dialog.Title className="text-lg font-semibold">
					{editing === null ? t(M.createTitle) : t(M.editTitle, { name: editing.name })}
				</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{t(M.dialogSentence)}
				</Dialog.Description>
				{body}
			</Dialog>
		</Dialog.Root>
	);
}

function LoadError(props: { error: unknown; retrying: boolean; onRetry(): void }) {
	const t = useT();
	const { msg, values } = describeError(props.error);
	return (
		<Banner
			variant="error"
			title={t(msg, values)}
			action={
				<Button
					variant="secondary"
					loading={props.retrying}
					aria-label={t(PAGE.tryAgain)}
					aria-busy={props.retrying || undefined}
					onClick={props.onRetry}
				>
					{t(PAGE.tryAgain)}
				</Button>
			}
		/>
	);
}

/** No template or no URL source: what to create first, with the tab that makes it. */
function NothingToSchedule(props: { onClose(): void }) {
	const t = useT();
	const { goTo } = useHome();
	return (
		<div className="space-y-4">
			<p>{t(M.nothingToSchedule)}</p>
			<div className="flex flex-wrap justify-end gap-3">
				<Button variant="secondary" onClick={props.onClose}>
					{t(SHARED.cancel)}
				</Button>
				<Button
					variant="secondary"
					onClick={() => {
						props.onClose();
						goTo("templates");
					}}
				>
					{t(M.goTemplates)}
				</Button>
				<Button
					variant="primary"
					onClick={() => {
						props.onClose();
						goTo("sources");
					}}
				>
					{t(M.goSources)}
				</Button>
			</div>
		</div>
	);
}

function ScheduleForm(props: {
	initial: ScheduleView | null;
	templates: readonly TemplateSummary[];
	sources: readonly SourceRow[];
	busy: boolean;
	setBusy(busy: boolean): void;
	onCancel(): void;
	onSaved(view: ScheduleView, created: boolean): void;
	onReload(): Promise<ScheduleView | undefined>;
}) {
	const t = useT();
	// The row the edit is measured against: the one opened, or the one Reload read.
	const [base, setBase] = useState(props.initial);
	const [form, setForm] = useState(() => initialForm(props.initial));
	const [errors, setErrors] = useState<Partial<Record<FieldName, Said>>>({});
	const [failure, setFailure] = useState<{ error: unknown } | null>(null);
	const [changed, setChanged] = useState(false);
	const [reloading, setReloading] = useState(false);
	const detail = useTemplate(form.templateId);
	const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
	const say = (s: Said | undefined) =>
		s === undefined ? undefined : [t(s.msg, s.values), s.detail].filter(Boolean).join(" ");

	// The query is keyed by the chosen ID: its data is always that template's.
	const loaded = detail.data !== undefined;
	const rule = loaded ? detail.data.template.rules?.missing : undefined;
	const templateMax = rule?.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT;
	const loadingTemplate = form.templateId !== null && detail.isPending;

	const templateItems = props.templates.map((tpl) => ({ value: tpl.id, label: tpl.name }));
	if (base !== null && !props.templates.some((tpl) => tpl.id === base.templateId)) {
		templateItems.push({ value: base.templateId, label: t(M.deletedTemplate) });
	}
	const sourceItems = props.sources.map((s) => ({ value: s.id, label: s.name }));
	if (base !== null && !props.sources.some((s) => s.id === base.sourceId)) {
		sourceItems.push({ value: base.sourceId, label: t(M.deletedSource) });
	}

	const reload = async () => {
		setReloading(true);
		try {
			const newest = await props.onReload();
			if (newest === undefined) {
				setFailure({ error: new ApiError("NOT_FOUND", "The schedule is gone", 404) });
			} else {
				setBase(newest);
				setForm(initialForm(newest));
				setFailure(null);
			}
			setChanged(false);
			setErrors({});
		} catch (e) {
			setFailure({ error: e });
		} finally {
			setReloading(false);
		}
	};

	const submit = async () => {
		const found: Partial<Record<FieldName, Said>> = {};
		const name = form.name.trim();
		if (name === "") found.name = { msg: M.nameRequired };
		else if (name.length > TEMPLATE_NAME_MAX) {
			found.name = { msg: M.nameTooLong, values: { max: TEMPLATE_NAME_MAX } };
		}
		const listed = props.templates.find((tpl) => tpl.id === form.templateId);
		if (form.templateId === null) found.template = { msg: M.templateRequired };
		if (form.sourceId === null) found.source = { msg: M.sourceRequired };
		const timing = timingOf(form, found);
		let batchSize: number | undefined;
		if (form.batchSize.trim() !== "") {
			const n = wholeIn(form.batchSize, 1, BATCH_SIZE_MAX);
			if (n === null) {
				found.batch = { msg: M.wholeNumber, values: { min: 1, max: BATCH_SIZE_MAX } };
			} else batchSize = n;
		}
		let missing: ScheduleMissing | undefined;
		if (rule !== undefined) {
			if (form.missing === "template") missing = "template";
			else if (form.missing === "off") missing = false;
			else {
				const n = wholeIn(form.maxPercent, 0, templateMax);
				if (n === null)
					found.percent = { msg: M.wholeNumber, values: { min: 0, max: templateMax } };
				else missing = { maxPercent: n };
			}
		}
		setErrors(found);
		setFailure(null);
		setChanged(false);
		if (Object.keys(found).length > 0 || timing === null) return;
		const templateId = form.templateId!;
		const sourceId = form.sourceId!;
		const cron = toCron(timing);
		let send: () => Promise<{ schedule: ScheduleView }>;
		if (base === null) {
			// The select offers listed templates only.
			const input: CreateScheduleInput = {
				name,
				templateId,
				templateRevision: listed!.revision,
				sourceId,
				cron,
				publish: form.publish,
				...(batchSize === undefined ? {} : { batchSize }),
				...(missing === undefined ? {} : { missing }),
			};
			send = () => api.createSchedule(input);
		} else {
			const patch: Omit<UpdateScheduleInput, "id" | "revision"> = {};
			if (name !== base.name) patch.name = name;
			if (templateId !== base.templateId && listed !== undefined) {
				patch.templateId = templateId;
				patch.templateRevision = listed.revision;
			}
			if (sourceId !== base.sourceId) patch.sourceId = sourceId;
			if (cron !== base.cron) patch.cron = cron;
			if (form.publish !== base.publish) patch.publish = form.publish;
			if (batchSize !== undefined && batchSize !== base.batchSize) patch.batchSize = batchSize;
			// Only once the template is read: before, what it asks of `missing` is unknown. A rename
			// sends none, so it never moves the schedule (assertNotBusy) or re-arms it.
			const moving = patch.templateId !== undefined;
			if (loaded && !sameMissing(missing, base.missing, moving)) patch.missing = missing ?? null;
			// Nothing changed: nothing to send (the route refuses an empty change).
			if (Object.keys(patch).length === 0) {
				props.onCancel();
				return;
			}
			const input: UpdateScheduleInput = { id: base.id, revision: base.revision, ...patch };
			send = () => api.updateSchedule(input);
		}
		props.setBusy(true);
		try {
			const { schedule } = await send();
			props.onSaved(schedule, base === null);
		} catch (e) {
			const code = e instanceof ApiError ? e.code : null;
			if (code === "SCHEDULE_CHANGED" && base !== null) setChanged(true);
			else if (code === "INVALID_CRON" && form.kind === "custom") {
				setErrors({ cron: describeError(e) });
			} else if (code === "NAME_TAKEN") setErrors({ name: describeError(e) });
			else setFailure({ error: e });
		} finally {
			props.setBusy(false);
		}
	};

	const failed = failure === null ? null : describeError(failure.error);
	const field = (k: FieldName) => {
		const text = say(errors[k]);
		return text === undefined ? {} : { error: text };
	};

	return (
		<form
			className="space-y-4"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<Input
				label={t(M.name)}
				value={form.name}
				disabled={props.busy}
				{...field("name")}
				onChange={(e: ChangeEvent<HTMLInputElement>) => set({ name: e.target.value })}
			/>
			<div className="grid gap-4 md:grid-cols-2">
				<Select
					label={t(M.template)}
					value={form.templateId}
					disabled={props.busy}
					{...field("template")}
					onValueChange={(v: unknown) => set({ templateId: typeof v === "string" ? v : null })}
					items={templateItems}
				>
					{templateItems.map((item) => (
						<Select.Option key={item.value} value={item.value}>
							{item.label}
						</Select.Option>
					))}
				</Select>
				<Select
					label={t(M.source)}
					value={form.sourceId}
					disabled={props.busy}
					{...field("source")}
					onValueChange={(v: unknown) => set({ sourceId: typeof v === "string" ? v : null })}
					items={sourceItems}
				>
					{sourceItems.map((item) => (
						<Select.Option key={item.value} value={item.value}>
							{item.label}
						</Select.Option>
					))}
				</Select>
			</div>
			<Radio.Group<Timing["kind"]>
				legend={t(M.when)}
				orientation="horizontal"
				value={form.kind}
				description={t(M.utcNote)}
				onValueChange={(kind: Timing["kind"]) => set({ kind })}
			>
				{KINDS.map((kind) => (
					<Radio.Item key={kind} label={t(KIND_LABELS[kind])} value={kind} disabled={props.busy} />
				))}
			</Radio.Group>
			{form.kind === "hourly" ? (
				<Input
					type="number"
					inputMode="numeric"
					min={0}
					max={59}
					label={t(M.minute)}
					value={form.minute}
					disabled={props.busy}
					{...field("minute")}
					onChange={(e: ChangeEvent<HTMLInputElement>) => set({ minute: e.target.value })}
				/>
			) : form.kind === "custom" ? (
				<Input
					label={t(M.cron)}
					description={t(M.cronHint)}
					value={form.cron}
					spellCheck={false}
					autoComplete="off"
					disabled={props.busy}
					{...field("cron")}
					onChange={(e: ChangeEvent<HTMLInputElement>) => set({ cron: e.target.value })}
				/>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{form.kind === "weekly" ? (
						<Select
							label={t(M.day)}
							value={String(form.day)}
							disabled={props.busy}
							onValueChange={(v: unknown) => {
								const day = DAY_LIST.find((d) => String(d) === v);
								if (day !== undefined) set({ day });
							}}
							items={DAY_LIST.map((d) => ({ value: String(d), label: t(DAYS[d]) }))}
						>
							{DAY_LIST.map((d) => (
								<Select.Option key={d} value={String(d)}>
									{t(DAYS[d])}
								</Select.Option>
							))}
						</Select>
					) : null}
					<Input
						type="time"
						label={t(M.time)}
						value={form.time}
						disabled={props.busy}
						{...field("time")}
						onChange={(e: ChangeEvent<HTMLInputElement>) => set({ time: e.target.value })}
					/>
				</div>
			)}
			<Radio.Group<"publish" | "draft">
				legend={t(M.entries)}
				orientation="horizontal"
				value={form.publish ? "publish" : "draft"}
				onValueChange={(v: "publish" | "draft") => set({ publish: v === "publish" })}
			>
				<Radio.Item label={t(M.publish)} value="publish" disabled={props.busy} />
				<Radio.Item label={t(M.draft)} value="draft" disabled={props.busy} />
			</Radio.Group>
			<Input
				type="number"
				inputMode="numeric"
				min={1}
				max={BATCH_SIZE_MAX}
				label={t(M.batchSize)}
				description={t(M.batchSizeHint, { max: BATCH_SIZE_MAX })}
				value={form.batchSize}
				disabled={props.busy}
				{...field("batch")}
				onChange={(e: ChangeEvent<HTMLInputElement>) => set({ batchSize: e.target.value })}
			/>
			{loadingTemplate ? <Loader aria-label={t(M.loadingTemplate)} /> : null}
			{detail.isError && form.templateId !== null ? (
				<p className="text-sm text-kumo-danger">{say(describeError(detail.error))}</p>
			) : null}
			{rule === undefined ? null : (
				<div className="space-y-2">
					<Radio.Group<MissingChoice>
						legend={t(M.missing)}
						value={form.missing}
						onValueChange={(missing: MissingChoice) => set({ missing })}
					>
						<Radio.Item label={t(M.missingTemplate)} value="template" disabled={props.busy} />
						<Radio.Item label={t(M.missingOff)} value="off" disabled={props.busy} />
						<Radio.Item label={t(M.missingLower)} value="lower" disabled={props.busy} />
					</Radio.Group>
					{form.missing === "lower" ? (
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							max={templateMax}
							label={t(M.maxPercent)}
							description={t(M.maxPercentHint, { max: templateMax })}
							value={form.maxPercent}
							disabled={props.busy}
							{...field("percent")}
							onChange={(e: ChangeEvent<HTMLInputElement>) => set({ maxPercent: e.target.value })}
						/>
					) : null}
				</div>
			)}
			{changed ? (
				<Banner
					variant="error"
					title={t(M.changedElsewhere)}
					action={
						<Button
							variant="secondary"
							loading={reloading}
							aria-label={t(M.reload)}
							aria-busy={reloading || undefined}
							disabled={reloading}
							onClick={() => void reload()}
						>
							{t(M.reload)}
						</Button>
					}
				/>
			) : null}
			{failed === null ? null : (
				<div role="alert" className="space-y-2">
					<Banner
						variant="error"
						title={t(failed.msg, failed.values)}
						{...(failed.detail === undefined ? {} : { description: failed.detail })}
					/>
					{failed.problems === undefined ? null : (
						<ul className="list-disc space-y-1 ps-6 text-sm">
							{failed.problems.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					)}
				</div>
			)}
			<div className="flex justify-end gap-3">
				<Button variant="secondary" disabled={props.busy} onClick={props.onCancel}>
					{t(SHARED.cancel)}
				</Button>
				<Button
					type="submit"
					variant="primary"
					loading={props.busy}
					aria-label={t(base === null ? M.create : M.save)}
					aria-busy={props.busy || undefined}
					disabled={props.busy || loadingTemplate}
				>
					{t(base === null ? M.create : M.save)}
				</Button>
			</div>
		</form>
	);
}
