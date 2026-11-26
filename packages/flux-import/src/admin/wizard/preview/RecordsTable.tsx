import { Badge, Banner, Button, Loader, Pagination, Table, Tabs } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, type ReactNode, useState } from "react";
import type { Counters, RecordError, RecordRow, RecordStatus } from "../../../engine/types.js";
import { api } from "../../api.js";
import { isRetryable, redact } from "../../api-error.js";
import { describeError, describeRecordWarning } from "../../errors.js";
import { type Msg, useT, type Values } from "../../i18n.js";
import { M as SHARED } from "../../messages.js";
import { WarningIcon } from "../../ui/icons.js";
import { M } from "./messages.js";

/** The longest value a change shows; longer ones are cut, with "…" as the last character. */
const VALUE_MAX = 120;

/**
 * `jobs/records` filters by status. A dry run's missing-phase rows are `planned` (with action
 * `trash` or `unpublish`) or `unchanged`, so no status selects them: the counts show them instead.
 */
type Filter =
	| "all"
	| Extract<RecordStatus, "planned" | "failed" | "conflict" | "locked" | "filtered">;

/**
 * The filters, each with the counter that counts its rows exactly. "All" and "Will change" have
 * none: the `unchanged` counter mixes planned and unchanged rows, and the missing phase's rows
 * are planned too.
 */
const FILTERS: readonly { value: Filter; msg: Msg; counter?: keyof Counters }[] = [
	{ value: "all", msg: M.filterAll },
	{ value: "planned", msg: M.filterPlanned },
	{ value: "failed", msg: M.filterFailed, counter: "failed" },
	{ value: "conflict", msg: M.filterConflict, counter: "conflict" },
	{ value: "locked", msg: M.filterLocked, counter: "locked" },
	{ value: "filtered", msg: M.filterFiltered, counter: "filtered" },
];

const isFilter = (value: string): value is Filter => FILTERS.some((f) => f.value === value);

/** As `queries.ts`: an offline error, a 429 or a 5xx is retried once; anything else is final. */
const retry = (failureCount: number, error: Error) => isRetryable(error) && failureCount < 1;

/**
 * The action a dry-run row names (Fact D5; engine `missing.ts`): what it would do, or why it
 * would not. A missing-phase row is `planned` with `trash` or `unpublish`, or `unchanged`.
 */
function actionOf(row: Pick<RecordRow, "status" | "action">): Msg {
	switch (row.status) {
		case "planned":
			switch (row.action) {
				case "create":
					return M.create;
				case "update":
					return M.update;
				case "unchanged":
					return M.unchanged;
				case "trash":
					return M.missingTrash;
				case "unpublish":
					return M.missingUnpublish;
				default:
					return M.otherAction;
			}
		case "unchanged":
			return M.unchanged;
		case "failed":
			return M.failed;
		case "conflict":
			return M.conflict;
		case "locked":
			return M.locked;
		case "filtered":
			return M.filtered;
		default:
			return M.otherAction;
	}
}

type BadgeVariant = "teal" | "blue" | "neutral" | "red" | "orange";

/** The action badge's colour: what it would write, or why it would not (words say the same). */
function variantOf(row: Pick<RecordRow, "status" | "action">): BadgeVariant {
	switch (row.status) {
		case "planned":
			switch (row.action) {
				case "create":
					return "teal";
				case "update":
					return "blue";
				case "trash":
					return "red";
				case "unpublish":
					return "orange";
				default:
					return "neutral";
			}
		case "failed":
			return "red";
		case "conflict":
			return "orange";
		default:
			return "neutral";
	}
}

/** A row warning as text: its field, its sentence, and the engine's specifics when it has them. */
function warningText(t: (msg: Msg, values?: Values) => string, w: RecordError): string {
	const { msg, detail } = describeRecordWarning(w);
	const sentence = detail === undefined ? t(msg) : `${t(msg)} ${detail}`;
	return w.field === undefined ? sentence : t(M.fieldError, { field: w.field, message: sentence });
}

/** A value as text, cut to `VALUE_MAX` characters; null when it is empty. */
function shown(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/**
 * A dry run's records from `jobs/records`, one status or all, paged by cursor: page `n` is read
 * from the cursor page `n - 1` returned, so Next is offered only while a page says `hasMore`.
 */
export function RecordsTable(p: { jobId: string; counters: Counters | null }) {
	const t = useT();
	const { i18n } = useLingui();
	const format = (n: number) => new Intl.NumberFormat(i18n.locale || "en").format(n);
	const [filter, setFilter] = useState<Filter>("all");
	/** `starts[n - 1]` is the cursor page `n` is read from. */
	const [starts, setStarts] = useState<(string | undefined)[]>([undefined]);
	const [page, setPage] = useState(1);
	const cursor = starts[page - 1];
	const query = useQuery({
		queryKey: ["flux-import", "records", p.jobId, filter, cursor ?? null],
		queryFn: () =>
			api.records({
				id: p.jobId,
				...(filter === "all" ? {} : { status: filter }),
				...(cursor === undefined ? {} : { cursor }),
			}),
		retry,
		// A finished dry run's records never change.
		staleTime: Number.POSITIVE_INFINITY,
	});
	const more = query.data?.hasMore === true && query.data.cursor !== undefined;
	const pages = Math.max(starts.length, page + (more ? 1 : 0));

	const goTo = (n: number) => {
		const next = query.data?.cursor;
		if (n > starts.length && next !== undefined) setStarts([...starts, next]);
		setPage(n);
	};
	const choose = (value: string) => {
		if (!isFilter(value) || value === filter) return;
		setFilter(value);
		setStarts([undefined]);
		setPage(1);
	};
	const empty = (v: unknown) => shown(v) ?? t(M.empty);

	let body: ReactNode;
	if (query.isPending) {
		body = <Loader aria-label={t(M.loadingRecords)} />;
	} else if (query.isError) {
		const e = describeError(query.error);
		body = (
			<Banner
				variant="error"
				title={t(e.msg, e.values)}
				{...(e.detail === undefined ? {} : { description: e.detail })}
				action={
					<Button variant="secondary" onClick={() => void query.refetch()}>
						{t(SHARED.tryAgain)}
					</Button>
				}
			/>
		);
	} else if (query.data.items.length === 0) {
		body = <p className="text-sm text-kumo-default">{t(M.noMatch)}</p>;
	} else {
		body = (
			<div className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-base">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.colRecord)}</Table.Head>
							<Table.Head>{t(M.colAction)}</Table.Head>
							<Table.Head>{t(M.colChanges)}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{query.data.items.map((row) => (
							<Table.Row key={row.seq}>
								<Table.Cell className="align-top">
									<code className="font-mono text-sm font-medium break-all">
										{row.sourceKey ?? t(M.noKey)}
									</code>
								</Table.Cell>
								<Table.Cell className="align-top whitespace-nowrap">
									<Badge variant={variantOf(row)}>{t(actionOf(row))}</Badge>
								</Table.Cell>
								<Table.Cell className="align-top">
									<div className="flex min-w-0 flex-col gap-0.5">
										{(row.changes ?? []).map((c) => (
											<div key={c.field} className="flex min-w-0 gap-2 text-sm">
												<span className="w-24 shrink-0 truncate text-kumo-subtle" title={c.field}>
													{c.field}
												</span>
												<code className="min-w-0 font-mono text-xs break-words">
													{t(M.change, { before: empty(c.before), after: empty(c.after) })}
												</code>
											</div>
										))}
										{(row.errors ?? []).map((e, i) => {
											const message = redact(e.message);
											return (
												// biome-ignore lint/suspicious/noArrayIndexKey: a row's errors never reorder.
												<div key={`e${i}`} className="text-sm text-kumo-danger break-words">
													{e.field === undefined
														? message
														: t(M.fieldError, { field: e.field, message })}
												</div>
											);
										})}
										{(row.warnings ?? []).map((w, i) => (
											<div
												// biome-ignore lint/suspicious/noArrayIndexKey: a row's warnings never reorder.
												key={`w${i}`}
												className="mt-1 flex items-start gap-1.5 text-xs break-words"
											>
												<WarningIcon
													aria-hidden="true"
													className="mt-0.5 shrink-0 text-kumo-warning"
												/>
												<span>{warningText(t, w)}</span>
											</div>
										))}
									</div>
								</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{/* Kumo's Tabs take no label of their own: the fieldset's legend names the filter. */}
			<fieldset>
				<legend className="sr-only">{t(M.filters)}</legend>
				<Tabs
					variant="segmented"
					size="sm"
					tabs={FILTERS.map((f) => {
						const n = f.counter === undefined ? null : (p.counters?.[f.counter] ?? null);
						// A filter no row matches is disabled (Kumo's tabs take no `disabled` of their own).
						const none = n === 0 && f.value !== filter;
						return {
							value: f.value,
							label:
								n === null ? (
									t(f.msg)
								) : (
									<span className="flex items-center gap-1.5">
										{t(f.msg)}
										<span className="tabular-nums">{format(n)}</span>
									</span>
								),
							...(none
								? {
										render: (own: ComponentProps<"button">) => (
											<button {...own} type="button" disabled aria-disabled />
										),
									}
								: {}),
						};
					})}
					value={filter}
					onValueChange={choose}
				/>
			</fieldset>
			{body}
			<Pagination
				page={page}
				setPage={goTo}
				perPage={1}
				totalCount={pages}
				labels={{
					navigation: t(M.pages),
					previousPage: t(M.previousPage),
					nextPage: t(M.nextPage),
				}}
			>
				<Pagination.Controls controls="simple" />
			</Pagination>
		</div>
	);
}
