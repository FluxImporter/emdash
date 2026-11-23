import { Banner, Checkbox, Collapsible, DatePicker, Input, Radio, Select } from "@cloudflare/kumo";
import { type ChangeEvent, useEffect, useId, useMemo, useState } from "react";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { BATCH_SIZE_MAX, MAX_UPDATE_FIELDS, OWNER_PATTERN } from "../../limits.js";
import { useAllTemplates, useFields, useSite } from "../../queries.js";
import { useWizard } from "../context.js";
import { StepFooter } from "../StepFooter.js";
import {
	fromTemplate,
	isEdited,
	mappingNamesOf,
	type Options,
	optionsBlockers,
	ownerOf,
	saveOffered,
	templateNameRule,
	toTemplate,
} from "../state.js";
import { M } from "./messages.js";
import { ownerClash } from "./owner.js";

/** The stop threshold when none is set (the engine's `MISSING_MAX_PERCENT_DEFAULT`). */
const THRESHOLD_DEFAULT = 25;
/** A fixed publish date's time when none is typed. */
const MIDNIGHT = "00:00";
const TIME = /^\d{2}:\d{2}$/;

/** `text` as a whole number from `min` to `max`, else null. */
function wholeIn(text: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(text)) return null;
	const n = Number(text);
	return n >= min && n <= max ? n : null;
}

/**
 * Whether a typed timezone is one the engine reads: `site`, or a zone the browser's `Intl` knows.
 * The engine checks with Luxon, which also takes forms such as `UTC+2` that `Intl` refuses, so
 * only text the user types is checked: a saved template's own zone is left to the engine.
 */
function isTimezone(tz: string): boolean {
	if (tz === "site") return true;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * A fixed date's day and time for the date picker and the time input. The step writes
 * `yyyy-MM-ddTHH:mm`; a saved template may also hold seconds, or a day alone (midnight).
 */
function fixedParts(at: string): { day: string; time: string } {
	const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(at);
	return { day: m?.[1] ?? "", time: m?.[2] ?? MIDNIGHT };
}

/** A calendar day as `yyyy-MM-dd`, in the browser's own calendar. */
function dayOf(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `yyyy-MM-dd` as that day's local midnight, for the calendar. */
function dateOf(day: string): Date | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

type ScheduleKind = NonNullable<Options["schedule"]>["kind"];
type SaveChoice = Options["save"]["kind"];

/**
 * The Options step (spec "4. Options"): the record rules, the status and its schedule, what
 * happens to entries missing from the feed, saving as a template, and, under Advanced, the owner
 * and the batch size. "Save the changes to <template>" saves on Next (Ruling 13), so the route's
 * warnings show on Preview.
 */
export function OptionsStep() {
	const t = useT();
	const { state, dispatch } = useWizard();
	const { options, base, target } = state;
	const set = (patch: Partial<Options>) => dispatch({ type: "optionsChanged", patch });

	const collection = target?.collection ?? null;
	const fields = useFields(collection);
	const site = useSite();
	// Names are unique across the site; owners clash within the collection (Ruling 15).
	const allTemplates = useAllTemplates();
	const collectionTemplates = useAllTemplates(collection ?? undefined);

	const edited = base !== null && isEdited(state);
	const save = options.save;
	// An unedited saved template runs as it is: a save choice made while it was edited is moot.
	const offered = saveOffered(state);
	const missingAllowed = base !== null || save.kind === "new";

	// --- Records ---
	const names = mappingNamesOf(state.rows);
	const listed = options.updateFields.filter((n) => names.includes(n));
	const fieldLabels = new Map((fields.data ?? []).map((f) => [f.slug, f.label]));
	const taxonomyLabels = new Map((site.data?.taxonomies ?? []).map((x) => [x.name, x.label]));
	const nameLabel = (name: string) => {
		if (name === "slug") return t(M.slugName);
		if (name === "bylines") return t(M.bylinesName);
		if (name.startsWith("taxonomies.")) {
			const taxonomy = name.slice("taxonomies.".length);
			return taxonomyLabels.get(taxonomy) ?? taxonomy;
		}
		return fieldLabels.get(name) ?? name;
	};

	// --- Schedule (preflight F4) ---
	const kept = useMemo(() => {
		const s = base === null ? undefined : fromTemplate(base.template).options.schedule;
		return s?.kind === "kept" ? s : null;
	}, [base]);
	const [scheduleKind, setScheduleKind] = useState<ScheduleKind | null>(
		options.schedule?.kind ?? null,
	);
	const fixedAt = options.schedule?.kind === "fixed" ? options.schedule.at : "";
	const [fixed, setFixed] = useState(() => fixedParts(fixedAt));
	const feedAt = options.schedule?.kind === "feed" ? options.schedule : null;
	const [feed, setFeed] = useState({
		from: feedAt?.from ?? "",
		format: feedAt?.format ?? "",
		tz: feedAt?.tz ?? "",
	});
	const pickedDate = dateOf(fixed.day);
	const fixedSchedule = (f: typeof fixed): Options["schedule"] =>
		f.day !== "" && TIME.test(f.time) ? { kind: "fixed", at: `${f.day}T${f.time}` } : null;
	const feedSchedule = (f: typeof feed): Options["schedule"] =>
		f.from === ""
			? null
			: {
					kind: "feed",
					from: f.from,
					...(f.format.trim() === "" ? {} : { format: f.format.trim() }),
					...(f.tz.trim() === "" ? {} : { tz: f.tz.trim() }),
				};
	const chooseSchedule = (kind: ScheduleKind) => {
		setScheduleKind(kind);
		if (kind === "kept") set({ schedule: kept });
		else if (kind === "fixed") set({ schedule: fixedSchedule(fixed) });
		else set({ schedule: feedSchedule(feed) });
	};
	const changeFixed = (patch: Partial<typeof fixed>) => {
		const next = { ...fixed, ...patch };
		setFixed(next);
		set({ schedule: fixedSchedule(next) });
	};
	const changeFeed = (patch: Partial<typeof feed>) => {
		const next = { ...feed, ...patch };
		setFeed(next);
		set({ schedule: feedSchedule(next) });
	};
	// Only a timezone typed here is checked; a saved template's own one the engine accepted.
	const [tzTyped, setTzTyped] = useState(false);
	const tzShown = options.status === "schedule" && scheduleKind === "feed";
	const tzInvalid = tzShown && tzTyped && feed.tz.trim() !== "" && !isTimezone(feed.tz.trim());
	const keys = state.columns?.map((c) => c.key) ?? [];
	if (feed.from !== "" && !keys.includes(feed.from)) keys.push(feed.from);

	// --- Missing ---
	const [thresholdText, setThresholdText] = useState(
		String(options.missing?.maxPercent ?? THRESHOLD_DEFAULT),
	);
	const threshold = wholeIn(thresholdText, 0, 100);
	const chooseMissing = (value: string) => {
		set({
			missing:
				value === "trash" || value === "unpublish"
					? { action: value, maxPercent: threshold ?? THRESHOLD_DEFAULT }
					: null,
		});
	};
	const changeThreshold = (text: string) => {
		setThresholdText(text);
		const n = wholeIn(text, 0, 100);
		if (n !== null && options.missing !== null)
			set({ missing: { ...options.missing, maxPercent: n } });
	};

	// --- Saving ---
	const name = save.kind === "new" ? save.name : "";
	const naming = save.kind === "new" && offered;
	const nameRule = naming ? templateNameRule(name) : null;
	// Whether the name is taken needs the saved templates, so it is checked here, not in
	// `optionsBlockers`; `templates/create` checks it again on Run.
	const nameTaken =
		naming && (allTemplates.data ?? []).some((x) => x.name === name.normalize("NFC"));
	const chooseSave = (kind: SaveChoice) => {
		if (kind === "new") set({ save: { kind: "new", name: "" } });
		else if (kind === "update") set({ save: { kind: "update" } });
		// A one-off run has nothing to find missing (Coordinator's call 1).
		else set({ save: { kind: "none" }, ...(base === null ? { missing: null } : {}) });
	};

	// --- Advanced ---
	const [ownerText, setOwnerText] = useState<string | null>(null);
	// An unedited saved template with no owner runs as saved, so the import stamps none. (Unedited,
	// `options.owner` is then null too: a typed owner would be an edit.)
	const ownerNone = base !== null && !edited && base.template.rules?.owner === undefined;
	const owner = ownerText ?? (ownerNone ? "" : ownerOf(state));
	const ownerValid = (ownerNone && ownerText === null) || OWNER_PATTERN.test(owner);
	const changeOwner = (text: string) => {
		// On a template that sets no owner, an empty field is no owner again, not an invalid one.
		if (text === "" && base !== null && base.template.rules?.owner === undefined) {
			setOwnerText(null);
			set({ owner: null });
			return;
		}
		setOwnerText(text);
		if (OWNER_PATTERN.test(text)) set({ owner: text });
	};
	// The template this import runs or saves to is no clash with itself.
	const selfId = offered && save.kind === "new" ? null : (base?.id ?? null);
	const clash =
		ownerValid && !ownerNone && target !== null
			? ownerClash(owner, target.locale, collectionTemplates.data ?? [], selfId)
			: null;
	const [batchText, setBatchText] = useState(
		options.batchSize === null ? "" : String(options.batchSize),
	);
	const batchValid = batchText === "" || wholeIn(batchText, 1, BATCH_SIZE_MAX) !== null;
	const changeBatch = (text: string) => {
		setBatchText(text);
		const n = wholeIn(text, 1, BATCH_SIZE_MAX);
		if (text === "") set({ batchSize: null });
		else if (n !== null) set({ batchSize: n });
	};
	const [advancedOpen, setAdvancedOpen] = useState(false);
	// A problem or a clash under Advanced opens it once, so it is seen; its trigger still closes it.
	const advancedNeeded = !ownerValid || !batchValid || clash !== null;
	useEffect(() => {
		if (advancedNeeded) setAdvancedOpen(true);
	}, [advancedNeeded]);

	// --- Next ---
	// Next is what saves the changes to the template, so that choice does not block it here.
	const blockers = optionsBlockers(state).filter((b) => b.msg !== M.saveUnsaved);
	const tooMany = blockers.some((b) => b.msg === M.updateFieldsTooMany);
	const local: ({ msg: Msg; values?: Values } | false)[] = [
		nameTaken && { msg: M.nameTaken },
		tzInvalid && { msg: M.feedTzInvalid },
		options.missing !== null && threshold === null && { msg: M.thresholdInvalid },
		!ownerValid && { msg: M.ownerInvalid },
		!batchValid && { msg: M.batchSizeInvalid, values: { max: BATCH_SIZE_MAX } },
	];
	const blocker = [...blockers, ...local].find((b) => b !== false) ?? null;
	const protectHelpId = useId();
	const saveHelpId = useId();

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const failure = error === null ? null : describeError(error);
	const onNext = async () => {
		setError(null);
		if (base !== null && edited && save.kind === "update") {
			setBusy(true);
			try {
				const reply = await api.updateTemplate({
					id: base.id,
					revision: base.revision,
					template: toTemplate(state, ownerOf(state)),
				});
				dispatch({
					type: "templateSaved",
					id: reply.template.id,
					revision: reply.template.revision,
					name: reply.template.name,
					template: reply.template.template,
					warnings: reply.check.warnings,
				});
			} catch (e) {
				setError(e);
				return;
			} finally {
				setBusy(false);
			}
		}
		if (!offered && save.kind !== "none") set({ save: { kind: "none" } });
		dispatch({ type: "stepChanged", step: "preview" });
	};

	return (
		<div className="space-y-6">
			<Radio.Group<Options["mode"]>
				legend={t(M.records)}
				description={t(M.recordsHelp)}
				value={options.mode}
				onValueChange={(mode: Options["mode"]) => set({ mode })}
			>
				<Radio.Item label={t(M.modeUpsert)} value="upsert" />
				<Radio.Item label={t(M.modeCreate)} value="create" />
				<Radio.Item label={t(M.modeUpdate)} value="update" />
			</Radio.Group>

			{options.mode === "create" ? null : (
				<div className="space-y-4">
					<Checkbox.Group
						legend={t(M.updateFields)}
						description={t(M.updateFieldsHelp, { max: MAX_UPDATE_FIELDS })}
						value={listed}
						onValueChange={(value: string[]) => set({ updateFields: value })}
						{...(tooMany ? { error: t(M.updateFieldsTooMany, { max: MAX_UPDATE_FIELDS }) } : {})}
					>
						<div className="max-h-96 overflow-y-auto">
							{names.map((n) => (
								<Checkbox.Item
									key={n}
									value={n}
									label={nameLabel(n)}
									disabled={listed.length >= MAX_UPDATE_FIELDS && !listed.includes(n)}
								/>
							))}
						</div>
					</Checkbox.Group>
					<div>
						<Checkbox
							label={t(M.protectEdited)}
							checked={options.protectEdited}
							onCheckedChange={(checked: boolean) => set({ protectEdited: checked })}
							aria-describedby={protectHelpId}
						/>
						<p id={protectHelpId} className="text-sm text-kumo-subtle">
							{t(M.protectEditedHelp)}
						</p>
					</div>
				</div>
			)}

			<Radio.Group<Options["status"]>
				legend={t(M.status)}
				description={t(M.statusHelp)}
				value={options.status}
				onValueChange={(status: Options["status"]) => set({ status })}
			>
				<Radio.Item label={t(M.statusPublish)} value="publish" />
				<Radio.Item label={t(M.statusDraft)} value="draft" />
				<Radio.Item label={t(M.statusSchedule)} value="schedule" />
			</Radio.Group>

			{options.status === "schedule" ? (
				<div className="space-y-4">
					<Radio.Group<ScheduleKind | null>
						legend={t(M.schedule)}
						description={t(M.scheduleHelp)}
						value={scheduleKind}
						onValueChange={(kind: ScheduleKind | null) => {
							if (kind !== null) chooseSchedule(kind);
						}}
					>
						{kept === null ? null : <Radio.Item label={t(M.scheduleKept)} value="kept" />}
						<Radio.Item label={t(M.scheduleFixed)} value="fixed" />
						<Radio.Item label={t(M.scheduleFeed)} value="feed" />
					</Radio.Group>
					{scheduleKind === "fixed" ? (
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t(M.fixedDate)}</legend>
							<DatePicker
								mode="single"
								{...(pickedDate === undefined
									? {}
									: { selected: pickedDate, defaultMonth: pickedDate })}
								onChange={(d: Date | undefined) =>
									changeFixed({ day: d === undefined ? "" : dayOf(d) })
								}
							/>
							<Input
								type="time"
								label={t(M.fixedTime)}
								description={t(M.fixedHelp)}
								value={fixed.time}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									changeFixed({ time: e.target.value })
								}
							/>
						</fieldset>
					) : null}
					{scheduleKind === "feed" ? (
						<div className="space-y-4">
							<Select<string>
								label={t(M.feedKey)}
								description={t(M.feedKeyHelp)}
								value={feed.from === "" ? null : feed.from}
								onValueChange={(from: string | null) => changeFeed({ from: from ?? "" })}
							>
								{keys.map((k) => (
									<Select.Option key={k} value={k}>
										{k}
									</Select.Option>
								))}
							</Select>
							<Input
								label={t(M.feedFormat)}
								description={t(M.feedFormatHelp)}
								value={feed.format}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									changeFeed({ format: e.target.value })
								}
							/>
							<Input
								label={t(M.feedTz)}
								description={t(M.feedTzHelp)}
								value={feed.tz}
								onChange={(e: ChangeEvent<HTMLInputElement>) => {
									setTzTyped(true);
									changeFeed({ tz: e.target.value });
								}}
								{...(tzInvalid ? { error: t(M.feedTzInvalid) } : {})}
							/>
						</div>
					) : null}
				</div>
			) : null}

			<div className="space-y-4">
				<Radio.Group
					legend={t(M.missing)}
					description={t(missingAllowed ? M.missingHelp : M.missingOff)}
					value={options.missing?.action ?? "leave"}
					onValueChange={(value: string) => chooseMissing(value)}
					disabled={!missingAllowed}
				>
					<Radio.Item label={t(M.missingLeave)} value="leave" />
					<Radio.Item label={t(M.missingUnpublish)} value="unpublish" />
					<Radio.Item label={t(M.missingTrash)} value="trash" />
				</Radio.Group>
				{options.missing === null ? null : (
					<Input
						inputMode="numeric"
						label={t(M.threshold)}
						description={t(M.thresholdHelp)}
						value={thresholdText}
						onChange={(e: ChangeEvent<HTMLInputElement>) => changeThreshold(e.target.value)}
						{...(threshold === null ? { error: t(M.thresholdInvalid) } : {})}
					/>
				)}
			</div>

			{base === null ? (
				<div>
					<Checkbox
						label={t(M.saveAs)}
						checked={save.kind === "new"}
						onCheckedChange={(checked: boolean) => chooseSave(checked ? "new" : "none")}
						aria-describedby={saveHelpId}
					/>
					<p id={saveHelpId} className="text-sm text-kumo-subtle">
						{t(M.saveAsHelp)}
					</p>
				</div>
			) : null}
			{edited ? (
				<Radio.Group<SaveChoice>
					legend={t(M.edited)}
					description={t(M.editedHelp, { name: base.name })}
					value={save.kind}
					onValueChange={(kind: SaveChoice) => chooseSave(kind)}
				>
					<Radio.Item label={t(M.runUnsaved)} value="none" />
					<Radio.Item label={t(M.saveUpdate, { name: base.name })} value="update" />
					<Radio.Item label={t(M.saveNew)} value="new" />
				</Radio.Group>
			) : null}
			{naming ? (
				<Input
					label={t(M.templateName)}
					value={name}
					onChange={(e: ChangeEvent<HTMLInputElement>) =>
						set({ save: { kind: "new", name: e.target.value } })
					}
					{...(allTemplates.isError ? { description: t(M.nameUnchecked) } : {})}
					{...(nameRule !== null && nameRule.msg !== M.nameNeeded
						? { error: t(nameRule.msg, nameRule.values) }
						: nameTaken
							? { error: t(M.nameTaken) }
							: {})}
				/>
			) : null}

			<Collapsible.Root open={advancedOpen} onOpenChange={(open: boolean) => setAdvancedOpen(open)}>
				<Collapsible.DefaultTrigger>{t(M.advanced)}</Collapsible.DefaultTrigger>
				<Collapsible.DefaultPanel>
					<div className="space-y-4">
						<Input
							label={t(M.owner)}
							description={t(ownerNone ? M.ownerNone : M.ownerHelp)}
							value={owner}
							onChange={(e: ChangeEvent<HTMLInputElement>) => changeOwner(e.target.value)}
							{...(ownerValid ? {} : { error: t(M.ownerInvalid) })}
						/>
						{clash === null ? null : (
							<Banner variant="alert" role="status" text={t(M.ownerClash, { name: clash.name })} />
						)}
						<Input
							inputMode="numeric"
							label={t(M.batchSize)}
							description={t(M.batchSizeHelp)}
							value={batchText}
							onChange={(e: ChangeEvent<HTMLInputElement>) => changeBatch(e.target.value)}
							{...(batchValid ? {} : { error: t(M.batchSizeInvalid, { max: BATCH_SIZE_MAX }) })}
						/>
					</div>
				</Collapsible.DefaultPanel>
			</Collapsible.Root>

			{failure === null ? null : (
				<Banner variant="error" role="alert" title={t(failure.msg, failure.values)}>
					{failure.detail === undefined ? null : <p>{failure.detail}</p>}
					{failure.problems === undefined ? null : (
						<ul>
							{failure.problems.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					)}
				</Banner>
			)}

			<StepFooter
				canNext={blocker === null}
				{...(blocker === null ? {} : { reason: t(blocker.msg, blocker.values) })}
				busy={busy}
				onNext={onNext}
			/>
		</div>
	);
}
