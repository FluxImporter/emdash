import { Banner, Button, Loader, Table } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SourceRow } from "../../../plugin/sources.js";
import { api } from "../../api.js";
import { describeError, ERROR_MESSAGES, scheduleNames } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M as PAGE } from "../../messages.js";
import { queryKeys, useAllSources, useCredentials, useSchedules } from "../../queries.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { whenLabel } from "../shared/When.js";
import { Credentials } from "./Credentials.js";
import { lastFetchState, urlLabel } from "./display.js";
import { M } from "./messages.js";
import { SourceDialog } from "./SourceDialog.js";

/** The sentence for a failed fetch's code; never its message, which can quote the address. */
function codeSentence(code: string) {
	return Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code]! : ERROR_MESSAGES.unknown!;
}

/** The Sources tab: URL sources with Fetch now, Edit and Delete, and the credentials below. */
export function SourcesTab() {
	const t = useT();
	const { i18n } = useLingui();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const sources = useAllSources();
	const credentials = useCredentials();
	const schedules = useSchedules();
	const [dialog, setDialog] = useState<{ source?: SourceRow } | null>(null);
	const [deleting, setDeleting] = useState<SourceRow | null>(null);
	const [deleteError, setDeleteError] = useState<unknown>(null);
	const [fetching, setFetching] = useState<string | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (sources.isPending || credentials.isPending) {
		return <Loader aria-label={t(M.loading)} />;
	}
	if (sources.isError || credentials.isError) {
		const failure = describeError(sources.error ?? credentials.error);
		return (
			<Banner
				variant="alert"
				description={t(failure.msg, failure.values)}
				action={
					<Button
						variant="secondary"
						onClick={() => {
							void sources.refetch();
							void credentials.refetch();
						}}
					>
						{t(PAGE.tryAgain)}
					</Button>
				}
			/>
		);
	}

	const when = (iso: string) => whenLabel(iso, Date.now(), i18n.locale, t);
	const lastFetch = (row: SourceRow): string => {
		const state = lastFetchState(row);
		if (state.kind === "never") return t(M.never);
		if (state.kind === "fetched") return t(M.fetched, { when: when(state.at) });
		const reason = codeSentence(state.code);
		return t(M.failed, { when: when(state.at), reason: t(reason) });
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

	const inUse = deleteError === null ? null : scheduleNames(deleteError, schedules.data ?? []);
	return (
		<div className="space-y-6">
			<section className="space-y-4">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold">{t(M.sourcesTitle)}</h3>
					<Button variant="primary" onClick={() => setDialog({})}>
						{t(M.add)}
					</Button>
				</div>
				{fetchError === null ? null : <Banner variant="alert" description={fetchError} />}
				{sources.data.length === 0 ? (
					<p className="text-sm text-kumo-subtle">{t(M.empty)}</p>
				) : (
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t(M.colName)}</Table.Head>
								<Table.Head>{t(M.colAddress)}</Table.Head>
								<Table.Head>{t(M.colCredential)}</Table.Head>
								<Table.Head>{t(M.colLastFetch)}</Table.Head>
								<Table.Head>{t(M.colActions)}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{sources.data.map((row) => (
								<Table.Row key={row.id}>
									<Table.Cell>{row.name}</Table.Cell>
									<Table.Cell>{urlLabel(row.url)}</Table.Cell>
									<Table.Cell>{row.credential ?? t(M.noCredential)}</Table.Cell>
									<Table.Cell>{lastFetch(row)}</Table.Cell>
									<Table.Cell>
										<div className="flex gap-2">
											<Button
												variant="secondary"
												loading={fetching === row.id}
												disabled={fetching !== null}
												aria-label={t(M.fetchNowRow, { name: row.name })}
												aria-busy={fetching === row.id || undefined}
												onClick={() => void fetchNow(row)}
											>
												{t(M.fetchNow)}
											</Button>
											<Button
												variant="secondary"
												aria-label={t(M.editRow, { name: row.name })}
												onClick={() => setDialog({ source: row })}
											>
												{t(M.editRow, { name: row.name })}
											</Button>
											<Button
												variant="secondary"
												aria-label={t(M.deleteRow, { name: row.name })}
												onClick={() => {
													setDeleteError(null);
													setDeleting(row);
												}}
											>
												{t(M.deleteRow, { name: row.name })}
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
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
