import { Banner, Button, DropdownMenu, Empty, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { SourceRow } from "../../../plugin/sources.js";
import { api } from "../../api.js";
import { isForbidden } from "../../api-error.js";
import { describeError, ERROR_MESSAGES, scheduleNames } from "../../errors.js";
import { useT, useTn } from "../../i18n.js";
import { queryKeys, useAllSources, useCredentials, useSchedules } from "../../queries.js";
import { DotsThreeIcon, KeyIcon, LinkIcon, PlusIcon } from "../../ui/icons.js";
import { Forbidden, LoadFailed, LoadingRows } from "../../ui/states.js";
import { useNarrow } from "../../ui/use-narrow.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { TabSummary } from "../shared/TabSummary.js";
import { whenLabel } from "../shared/When.js";
import { Credentials } from "./Credentials.js";
import { lastFetchState, sizeLabel, urlLabel } from "./display.js";
import { M, N } from "./messages.js";
import { SourceDialog } from "./SourceDialog.js";

/** The sentence for a failed fetch's code; never its message, which can quote the address. */
function codeSentence(code: string) {
	return Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code]! : ERROR_MESSAGES.unknown!;
}

/** One row's parts, laid out as table cells when wide and as a stacked row when narrow. */
interface RowParts {
	id: string;
	source: ReactNode;
	credential: ReactNode;
	lastFetch: ReactNode;
	actions: ReactNode;
}

/**
 * The Sources tab (Sources.dc.html): the summary line with Add a source, the URL sources with
 * their credential and last fetch, Fetch now and a menu (Edit, Delete), and the credentials below.
 */
export function SourcesTab() {
	const t = useT();
	const tn = useTn();
	const { i18n } = useLingui();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const sources = useAllSources();
	const credentials = useCredentials();
	const schedules = useSchedules();
	const [narrowRef, narrow] = useNarrow<HTMLDivElement>();
	const [dialog, setDialog] = useState<{ source?: SourceRow } | null>(null);
	const [deleting, setDeleting] = useState<SourceRow | null>(null);
	const [deleteError, setDeleteError] = useState<unknown>(null);
	const [fetching, setFetching] = useState<string | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (sources.isError || credentials.isError) {
		const error = sources.error ?? credentials.error;
		// No retry changes a role.
		return isForbidden(error) ? (
			<Forbidden />
		) : (
			<LoadFailed
				title={t(M.loadFailed)}
				error={error}
				retrying={sources.isFetching || credentials.isFetching}
				onRetry={() => {
					void sources.refetch();
					void credentials.refetch();
				}}
			/>
		);
	}
	if (sources.isPending || credentials.isPending) {
		return <LoadingRows label={t(M.loading)} columns={4} />;
	}

	/** A source's credential by name; one no longer saved says so (its fetches fail). */
	const credentialOf = (row: SourceRow): ReactNode => {
		if (row.credential === undefined) {
			return <span className="text-kumo-subtle">{t(M.noCredential)}</span>;
		}
		const saved = credentials.data.some((c) => c.name === row.credential);
		return (
			<span
				className={
					saved
						? "inline-flex items-center gap-1.5"
						: "inline-flex items-center gap-1.5 text-kumo-danger"
				}
			>
				<KeyIcon aria-hidden="true" className="shrink-0" />
				<span className="break-words">
					{saved ? row.credential : t(M.credentialMissing, { name: row.credential })}
				</span>
			</span>
		);
	};

	const lastFetch = (row: SourceRow): ReactNode => {
		const state = lastFetchState(row);
		const when = state.kind === "never" ? "" : whenLabel(state.at, Date.now(), i18n.locale, t);
		return (
			<div className="flex items-baseline gap-2 text-sm">
				<span
					aria-hidden="true"
					className={
						state.kind === "fetched"
							? "size-2 shrink-0 rounded-full bg-kumo-success"
							: state.kind === "failed"
								? "size-2 shrink-0 rounded-full bg-kumo-danger"
								: "size-2 shrink-0 rounded-full bg-kumo-fill"
					}
				/>
				<div className="flex min-w-0 flex-col">
					{state.kind === "never" ? (
						<span>{t(M.never)}</span>
					) : (
						<time dateTime={state.at}>
							{t(state.kind === "fetched" ? M.fetched : M.failed, { when })}
						</time>
					)}
					{state.kind === "failed" ? (
						<span className="text-kumo-danger">{t(codeSentence(state.code))}</span>
					) : state.kind === "fetched" && row.lastFetch !== undefined ? (
						<span className="text-kumo-subtle">{sizeLabel(row.lastFetch.bytes, i18n.locale)}</span>
					) : null}
				</div>
			</div>
		);
	};

	const fetchNow = async (row: SourceRow) => {
		setFetching(row.id);
		setFetchError(null);
		try {
			const outcome = await api.fetchSource({ id: row.id });
			announce(outcome.changed ? t(M.fetchedNew) : t(M.fetchedSame));
		} catch (e) {
			const { msg, values } = describeError(e);
			setFetchError(t(M.fetchFailed, { name: row.name, reason: t(msg, values) }));
		} finally {
			// The fetch saved its result (or its failure) on the row either way.
			void queryClient.invalidateQueries({ queryKey: queryKeys.sources });
			setFetching(null);
		}
	};

	const remove = async () => {
		if (deleting === null) return;
		setBusy(true);
		setDeleteError(null);
		try {
			await api.deleteSource({ id: deleting.id });
			void queryClient.invalidateQueries({ queryKey: queryKeys.sources });
			announce(t(M.deleted, { name: deleting.name }));
			setDeleting(null);
		} catch (e) {
			setDeleteError(e);
		} finally {
			setBusy(false);
		}
	};

	const partsOf = (row: SourceRow): RowParts => ({
		id: row.id,
		source: (
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="break-words font-semibold text-kumo-default">{row.name}</span>
				<span className="truncate font-mono text-sm">{urlLabel(row.url)}</span>
			</div>
		),
		credential: <div className="text-sm">{credentialOf(row)}</div>,
		lastFetch: lastFetch(row),
		actions: (
			<div className="flex items-center justify-end gap-1">
				<Button
					variant="ghost"
					size="sm"
					loading={fetching === row.id}
					disabled={fetching !== null}
					aria-label={t(M.fetchNowRow, { name: row.name })}
					aria-busy={fetching === row.id || undefined}
					onClick={() => void fetchNow(row)}
				>
					{t(M.fetchNow)}
				</Button>
				<DropdownMenu>
					<DropdownMenu.Trigger>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<DotsThreeIcon aria-hidden="true" size={16} />}
							aria-label={t(M.actionsRow, { name: row.name })}
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						<DropdownMenu.Item
							aria-label={t(M.editRow, { name: row.name })}
							onClick={() => setDialog({ source: row })}
						>
							{t(M.edit)}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							variant="danger"
							aria-label={t(M.deleteRow, { name: row.name })}
							onClick={() => {
								setDeleteError(null);
								setDeleting(row);
							}}
						>
							{t(M.delete)}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu>
			</div>
		),
	});

	const parts = sources.data.map(partsOf);
	const inUse = deleteError === null ? null : scheduleNames(deleteError, schedules.data ?? []);
	return (
		<div ref={narrowRef} className="flex flex-col gap-6">
			<TabSummary
				lead={tn(N.sources, sources.data.length)}
				rest={[tn(N.credentials, credentials.data.length)]}
				action={
					<Button
						variant="secondary"
						icon={<PlusIcon aria-hidden="true" />}
						onClick={() => setDialog({})}
					>
						{t(M.add)}
					</Button>
				}
			/>
			<section className="flex flex-col gap-3">
				<div className="flex flex-col">
					<h2 className="text-base font-semibold text-kumo-default">{t(M.sourcesTitle)}</h2>
					<p className="text-sm text-kumo-default">{t(M.sourcesHint)}</p>
				</div>
				{fetchError === null ? null : <Banner variant="alert" description={fetchError} />}
				{sources.data.length === 0 ? (
					<Empty size="sm" icon={<LinkIcon aria-hidden="true" size={28} />} title={t(M.empty)} />
				) : narrow ? (
					<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-hairline bg-kumo-base">
						{parts.map((p) => (
							<li key={p.id} className="flex items-start gap-3 px-4 py-3">
								<div className="flex min-w-0 flex-1 flex-col gap-2">
									{p.source}
									{p.credential}
									{p.lastFetch}
								</div>
								{p.actions}
							</li>
						))}
					</ul>
				) : (
					// A long name or address widens the table, never the page.
					<div className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-base">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>{t(M.colSource)}</Table.Head>
									<Table.Head>{t(M.colCredential)}</Table.Head>
									<Table.Head>{t(M.colLastFetch)}</Table.Head>
									<Table.Head>
										<span className="sr-only">{t(M.colActions)}</span>
									</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{parts.map((p) => (
									<Table.Row key={p.id}>
										<Table.Cell className="align-top">{p.source}</Table.Cell>
										<Table.Cell className="align-top">{p.credential}</Table.Cell>
										<Table.Cell className="align-top">{p.lastFetch}</Table.Cell>
										<Table.Cell className="align-top">{p.actions}</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				)}
			</section>
			<Credentials rows={credentials.data} sources={sources.data} />
			{dialog === null ? null : (
				<SourceDialog
					key={dialog.source?.id ?? "new"}
					{...(dialog.source ? { source: dialog.source } : {})}
					onClose={() => setDialog(null)}
				/>
			)}
			{deleting === null ? null : (
				<ConfirmDialog
					open
					danger
					busy={busy}
					title={t(M.deleteTitle, { name: deleting.name })}
					sentence={t(M.deleteSentence)}
					confirmLabel={t(M.delete)}
					error={
						deleteError === null ? null : (
							<Banner
								variant="alert"
								description={t(describeError(deleteError).msg, describeError(deleteError).values)}
							/>
						)
					}
					onConfirm={() => void remove()}
					onClose={() => setDeleting(null)}
				>
					{inUse === null ? null : <p className="text-sm">{t(M.inUse, { names: inUse })}</p>}
				</ConfirmDialog>
			)}
		</div>
	);
}
