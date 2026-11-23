import { Banner, Button, Loader, Pagination, Table, Tabs } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { RecordRow, RecordStatus } from "../../../engine/types.js";
import { api } from "../../api.js";
import { isRetryable, redact } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { type Msg, useT } from "../../i18n.js";
import { M } from "./messages.js";

/** The longest value a change shows; longer ones are cut, with "…" as the last character. */
const VALUE_MAX = 120;

type Filter =
	| "all"
	| Extract<RecordStatus, "planned" | "failed" | "conflict" | "locked" | "filtered" | "removed">;

const FILTERS: readonly { value: Filter; msg: Msg }[] = [
	{ value: "all", msg: M.filterAll },
	{ value: "planned", msg: M.filterPlanned },
	{ value: "failed", msg: M.filterFailed },
	{ value: "conflict", msg: M.filterConflict },
	{ value: "locked", msg: M.filterLocked },
	{ value: "filtered", msg: M.filterFiltered },
	{ value: "removed", msg: M.filterRemoved },
];

const isFilter = (value: string): value is Filter => FILTERS.some((f) => f.value === value);

/** As `queries.ts`: an offline error, a 429 or a 5xx is retried once; anything else is final. */
const retry = (failureCount: number, error: Error) => isRetryable(error) && failureCount < 1;

/** The action a dry-run row names (Fact D5): what it would do, or why it would not. */
function actionOf(row: Pick<RecordRow, "status" | "action">): Msg | null {
	switch (row.status) {
		case "removed":
			return row.action === "trash" ? M.missingTrash : M.missingUnpublish;
		case "failed":
			return M.failed;
		case "conflict":
			return M.conflict;
		case "locked":
			return M.locked;
		case "filtered":
			return M.filtered;
		case "planned":
			if (row.action === "create") return M.create;
			if (row.action === "update") return M.update;
			if (row.action === "unchanged") return M.unchanged;
			return null;
		default:
			return null;
	}
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
export function RecordsTable(p: { jobId: string }) {
	const t = useT();
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
				action={
					<Button variant="secondary" onClick={() => void query.refetch()}>
						{t(M.tryAgain)}
					</Button>
				}
			>
				{e.detail ?? null}
			</Banner>
		);
	} else if (query.data.items.length === 0) {
		body = <p className="text-sm text-kumo-subtle">{t(M.noMatch)}</p>;
	} else {
		body = (
			<div className="overflow-x-auto">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.colRecord)}</Table.Head>
							<Table.Head>{t(M.colAction)}</Table.Head>
							<Table.Head>{t(M.colChanges)}</Table.Head>
							<Table.Head>{t(M.colErrors)}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{query.data.items.map((row) => {
							const action = actionOf(row);
							return (
								<Table.Row key={row.seq}>
									<Table.Cell className="break-all">{row.sourceKey ?? t(M.noKey)}</Table.Cell>
									<Table.Cell className="whitespace-nowrap">
										{action === null ? row.status : t(action)}
									</Table.Cell>
									<Table.Cell className="break-words">
										{(row.changes ?? []).map((c) => (
											<div key={c.field}>
												{t(M.change, {
													field: c.field,
													before: empty(c.before),
													after: empty(c.after),
												})}
											</div>
										))}
									</Table.Cell>
									<Table.Cell className="break-words text-kumo-danger">
										{(row.errors ?? []).map((e, i) => {
											const message = redact(e.message);
											return (
												// biome-ignore lint/suspicious/noArrayIndexKey: a row's errors never reorder.
												<div key={i}>
													{e.field === undefined
														? message
														: t(M.fieldError, { field: e.field, message })}
												</div>
											);
										})}
									</Table.Cell>
								</Table.Row>
							);
						})}
					</Table.Body>
				</Table>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<Tabs
				variant="segmented"
				size="sm"
				tabs={FILTERS.map((f) => ({ value: f.value, label: t(f.msg) }))}
				value={filter}
				onValueChange={choose}
			/>
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
