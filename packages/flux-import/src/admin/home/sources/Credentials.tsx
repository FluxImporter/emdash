import { Banner, Button, Input, Table } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import type { CredentialInfo } from "../../../plugin/credentials.js";
import type { SourceRow } from "../../../plugin/sources.js";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { CREDENTIAL_NAME, HEADER_NAME } from "../../limits.js";
import { queryKeys } from "../../queries.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { M } from "./messages.js";

/**
 * The credentials below the sources: names and header names only. A value is typed into a
 * password input, sent once and cleared, and never read back (the list route has no value).
 */
export function Credentials(props: {
	rows: readonly CredentialInfo[];
	sources: readonly SourceRow[];
}) {
	const t = useT();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [header, setHeader] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const valueRef = useRef<HTMLInputElement>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<unknown>(null);

	const ready = CREDENTIAL_NAME.test(name) && HEADER_NAME.test(header) && value !== "";

	const save = async (e: FormEvent) => {
		e.preventDefault();
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.setCredential({ name, header, value });
			void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
			announce(t(M.credSaved, { name }));
			setName("");
			setHeader("");
		} catch (err) {
			setError(err);
		} finally {
			// The value is never kept after the call, whatever its outcome.
			setValue("");
			setBusy(false);
		}
	};

	const usedBy = (credential: string) =>
		props.sources.filter((s) => s.credential === credential).map((s) => s.name);

	const remove = async () => {
		if (deleting === null) return;
		setBusy(true);
		setDeleteError(null);
		try {
			await api.deleteCredential({ name: deleting });
			void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
			announce(t(M.credDeleted, { name: deleting }));
			setDeleting(null);
		} catch (err) {
			setDeleteError(err);
		} finally {
			setBusy(false);
		}
	};

	const users = deleting === null ? [] : usedBy(deleting);
	return (
		<section className="space-y-4">
			<h3 className="text-lg font-semibold">{t(M.credentialsTitle)}</h3>
			{props.rows.length === 0 ? (
				<p className="text-sm text-kumo-subtle">{t(M.credentialsEmpty)}</p>
			) : (
				<div className="overflow-x-auto">
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>{t(M.credName)}</Table.Head>
								<Table.Head>{t(M.credHeader)}</Table.Head>
								<Table.Head>{t(M.colActions)}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{props.rows.map((c) => (
								<Table.Row key={c.name}>
									<Table.Cell>{c.name}</Table.Cell>
									<Table.Cell>{c.header}</Table.Cell>
									<Table.Cell>
										<div className="flex gap-2">
											<Button
												variant="secondary"
												aria-label={t(M.credReplace, { name: c.name })}
												onClick={() => {
													setName(c.name);
													setHeader(c.header);
													valueRef.current?.focus();
												}}
											>
												{t(M.credReplaceShort)}
											</Button>
											<Button
												variant="secondary"
												aria-label={t(M.credDeleteRow, { name: c.name })}
												onClick={() => {
													setDeleteError(null);
													setDeleting(c.name);
												}}
											>
												{t(M.delete)}
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				</div>
			)}
			<form className="space-y-4" onSubmit={(e) => void save(e)}>
				<h4 className="font-semibold">{t(M.credFormTitle)}</h4>
				<div className="grid gap-4 md:grid-cols-3">
					<Input
						label={t(M.credName)}
						description={t(M.credNameHint)}
						maxLength={64}
						autoComplete="off"
						value={name}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
					/>
					<Input
						label={t(M.credHeader)}
						description={t(M.credHeaderHint)}
						maxLength={100}
						autoComplete="off"
						value={header}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setHeader(e.target.value)}
					/>
					<Input
						label={t(M.credValue)}
						description={t(M.credValueHint)}
						ref={valueRef}
						type="password"
						autoComplete="off"
						value={value}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
					/>
				</div>
				{error === null ? null : (
					<Banner
						variant="alert"
						description={t(describeError(error).msg, describeError(error).values)}
					/>
				)}
				<Button
					type="submit"
					variant="primary"
					disabled={busy || !ready}
					aria-busy={busy || undefined}
				>
					{t(M.credSave)}
				</Button>
			</form>
			{deleting === null ? null : (
				<ConfirmDialog
					open
					danger
					busy={busy}
					title={t(M.credDeleteTitle, { name: deleting })}
					sentence={t(M.credDeleteSentence)}
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
					<p className="text-sm">
						{users.length === 0 ? t(M.credUnused) : t(M.credUsedBy, { names: users.join(", ") })}
					</p>
				</ConfirmDialog>
			)}
		</section>
	);
}
