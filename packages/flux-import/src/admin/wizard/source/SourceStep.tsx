import { Banner, Link, Tabs } from "@cloudflare/kumo";
import { type ComponentProps, useCallback, useRef, useState } from "react";
import type { SourceFormat } from "../../../sources/reader.js";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { type Msg, useT } from "../../i18n.js";
import { SAMPLE_MAX } from "../../limits.js";
import type { SourceBlock } from "../../types.js";
import { useWizard } from "../context.js";
import { StepFooter } from "../StepFooter.js";
import { sampleColumns } from "../sample.js";
import { reachable, type SourceChoice } from "../state.js";
import { M } from "./messages.js";
import { type Paste, PasteTab, pasteFits } from "./PasteTab.js";
import { SamplePreview } from "./SamplePreview.js";
import { SavedSourceTab } from "./SavedSourceTab.js";
import { SourceSettings } from "./SourceSettings.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { UploadTab } from "./UploadTab.js";
import { UrlTab } from "./UrlTab.js";

/** An error as the step shows it: `describeError`'s sentence, specifics and problems. */
export type Described = ReturnType<typeof describeError>;

/** What every tab gets from the step. */
export interface TabProps {
	busy: boolean;
	/**
	 * Runs `work` while the step shows busy. A rejection is shown inline, through `describe`
	 * (`describeError` by default); `run` itself never rejects.
	 */
	run(work: () => Promise<void>, describe?: (e: unknown) => Described): void;
	/**
	 * Samples the chosen data as `format` (CSV, said to be assumed, when null), and makes it the
	 * wizard's source when that works.
	 */
	pick(choice: SourceChoice, format: SourceFormat | null): Promise<void>;
	/** Shows an error that no request produced. */
	fail(error: Described): void;
}

type TabId = SourceChoice["kind"];
const TABS: readonly TabId[] = ["upload", "url", "paste", "saved"];
const TAB_LABELS: Readonly<Record<TabId, Msg>> = {
	upload: M.tabUpload,
	url: M.tabUrl,
	paste: M.tabPaste,
	saved: M.tabSaved,
};

const WORDPRESS_IMPORTER = "/_emdash/admin/import/wordpress";

function ErrorNote({ error }: { error: Described }) {
	const t = useT();
	const hasMore = error.detail !== undefined || (error.problems?.length ?? 0) > 0;
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(error.msg, error.values)}
			description={
				hasMore ? (
					<div className="space-y-2">
						{error.detail === undefined ? null : <p className="break-all">{error.detail}</p>}
						{error.problems?.length ? (
							<ul className="list-disc ps-5">
								{error.problems.map((p) => (
									<li key={p}>{p}</li>
								))}
							</ul>
						) : null}
					</div>
				) : undefined
			}
		/>
	);
}

/**
 * The wizard's first step: the data to import (an uploaded file, a URL, pasted text or a saved
 * source), how it is read, and its sample (plan Ruling 7: every choice becomes an upload ID). A
 * saved template can be loaded from here once the data is sampled (preflight F10).
 */
export function SourceStep() {
	const t = useT();
	const { state, dispatch } = useWizard();
	const latest = useRef(state);
	latest.current = state;
	const [tab, setTab] = useState<TabId>(state.source?.kind ?? "upload");
	// The data being read: the wizard's source, or a new choice whose sample has not worked yet.
	const [choice, setChoice] = useState<SourceChoice | null>(state.source);
	const [block, setBlock] = useState<SourceBlock>(state.sourceBlock);
	const [assumed, setAssumed] = useState(false);
	const [pending, setPending] = useState(0);
	const [error, setError] = useState<Described | null>(null);
	const [paste, setPaste] = useState<Paste>({ format: "csv", text: "" });
	const busy = pending > 0;

	/**
	 * Samples `c` read as `b`. One at a time: every control that starts a request is disabled
	 * while one runs, so no reply can answer after a later one.
	 */
	const sample = useCallback(
		async (c: SourceChoice, b: SourceBlock) => {
			const isSource = () => latest.current.source?.uploadId === c.uploadId;
			let reply: Awaited<ReturnType<typeof api.sample>>;
			try {
				reply = await api.sample({ uploadId: c.uploadId, n: SAMPLE_MAX, source: b });
			} catch (e) {
				// The wizard's source no longer has a sample that fits its settings.
				if (isSource()) dispatch({ type: "sourceBlockChanged", sourceBlock: b, columns: null });
				throw e;
			}
			const columns = sampleColumns(reply, b.format);
			dispatch(
				isSource()
					? { type: "sourceBlockChanged", sourceBlock: b, columns }
					: { type: "sourceReady", source: c, sourceBlock: b, columns },
			);
		},
		[dispatch],
	);

	const run = useCallback((work: () => Promise<void>, describe = describeError) => {
		setPending((n) => n + 1);
		setError(null);
		work()
			.catch((e: unknown) => setError(describe(e)))
			.finally(() => setPending((n) => n - 1));
	}, []);

	const pick = useCallback(
		async (c: SourceChoice, format: SourceFormat | null) => {
			const b: SourceBlock = { format: format ?? "csv" };
			setChoice(c);
			setBlock(b);
			setAssumed(format === null);
			await sample(c, b);
		},
		[sample],
	);

	const fail = useCallback((e: Described) => setError(e), []);

	const changeBlock = (b: SourceBlock) => {
		if (choice === null) return;
		if (b.format !== block.format) setAssumed(false);
		setBlock(b);
		run(() => sample(choice, b));
	};

	const tabProps: TabProps = { busy, run, pick, fail };
	// The sample shown is the wizard's, and only while it is of the data chosen here.
	const sampled =
		choice !== null && state.source?.uploadId === choice.uploadId ? state.columns : null;
	const usable = sampled !== null && reachable(state, "target");
	const pasteTooLarge = tab === "paste" && !pasteFits(paste);
	// StepFooter also disables Next while `busy`.
	const canNext = usable && !pasteTooLarge;
	let reason: string | undefined;
	if (pasteTooLarge) reason = t(M.pasteTooLarge);
	else if (!busy && sampled !== null && !usable) reason = t(M.noRecordsReason);
	else if (!busy && !usable) reason = t(M.chooseData);

	return (
		<div className="space-y-6">
			<Tabs
				tabs={TABS.map((id) => ({
					value: id,
					label: t(TAB_LABELS[id]),
					// Kumo's tabs take no `disabled`: while a request runs the tab stays put, so an
					// upload's progress is never unmounted.
					render: (own: ComponentProps<"button">) => (
						<button {...own} type="button" disabled={busy} aria-disabled={busy} />
					),
				}))}
				value={tab}
				onValueChange={(v: string) => setTab(TABS.find((id) => id === v) ?? "upload")}
			/>
			<div role="tabpanel" aria-label={t(TAB_LABELS[tab])}>
				{tab === "upload" ? <UploadTab {...tabProps} /> : null}
				{tab === "url" ? <UrlTab {...tabProps} /> : null}
				{tab === "paste" ? <PasteTab {...tabProps} paste={paste} onPaste={setPaste} /> : null}
				{tab === "saved" ? <SavedSourceTab {...tabProps} /> : null}
			</div>
			{error === null ? null : <ErrorNote error={error} />}
			{choice === null ? null : (
				<SourceSettings
					choice={choice}
					block={block}
					assumed={assumed}
					busy={busy}
					onChange={changeBlock}
				/>
			)}
			{sampled === null ? null : <SamplePreview columns={sampled} format={block.format} />}
			<TemplatePicker enabled={usable} busy={busy} run={run} />
			<p className="text-sm text-kumo-subtle">
				{t(M.wordpress)} <Link href={WORDPRESS_IMPORTER}>{t(M.wordpressLink)}</Link>
			</p>
			<StepFooter
				canNext={canNext}
				{...(reason === undefined ? {} : { reason })}
				busy={busy}
				onNext={() => dispatch({ type: "stepChanged", step: "target" })}
			/>
		</div>
	);
}
