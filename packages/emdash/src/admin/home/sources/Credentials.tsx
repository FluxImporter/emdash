import { Banner, Button, Dialog, Empty, Input } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import type { CredentialInfo } from "../../../plugin/credentials.js";
import type { SourceRow } from "../../../plugin/sources.js";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { useT, useTn } from "../../i18n.js";
import { CREDENTIAL_NAME, HEADER_NAME } from "../../limits.js";
import { queryKeys } from "../../queries.js";
import { KeyIcon, PlusIcon } from "../../ui/icons.js";
import { useHome } from "../Home.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { M as SHARED } from "../shared/messages.js";
import { M, N } from "./messages.js";

/** What the credential dialog opens with: empty to add one, a row's name and header to replace it. */
type Editing = { name: string; header: string; replacing: boolean };

/**
 * The credentials below the sources (Sources.dc.html): names, header names and a masked value
 * only, with Replace and Delete. "Add a credential" and Replace open a dialog; a value is typed
 * into a password input, sent once and cleared, and never read back (the list route has no value).
 */
export function Credentials(props: {
	rows: readonly CredentialInfo[];
	sources: readonly SourceRow[];
}) {
	const t = useT();
	const tn = useTn();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<{ editing: Editing; open: boolean; opening: number }>({
		editing: { name: "", header: "", replacing: false },
		open: false,
		opening: 0,
	});
	const open = (editing: Editing) =>
		setDialog((d) => ({ editing, open: true, opening: d.opening + 1 }));
	const [deleting, setDeleting] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

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
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-col">
					<h2 className="text-base font-semibold text-kumo-default">{t(M.credentialsTitle)}</h2>
					<p className="text-sm text-kumo-default">{t(M.credentialsHint)}</p>
				</div>
				<Button
					variant="secondary"
					icon={<PlusIcon aria-hidden="true" />}
					onClick={() => open({ name: "", header: "", replacing: false })}
				>
					{t(M.credAdd)}
				</Button>
			</div>
			{props.rows.length === 0 ? (
				<Empty
					size="sm"
					icon={<KeyIcon aria-hidden="true" size={28} />}
					title={t(M.credentialsEmpty)}
				/>
			) : (
				<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-hairline bg-kumo-base">
					{props.rows.map((c) => {
						const count = usedBy(c.name).length;
						return (
							<li key={c.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
								<span className="min-w-40 break-words font-mono font-medium">{c.name}</span>
								<span className="min-w-0 flex-1 text-sm text-kumo-subtle">
									{t(M.credSentIn, { header: c.header })}
									{" · "}
									{count === 0 ? t(M.credNotUsed) : tn(N.usedBy, count)}
								</span>
								<span className="font-mono text-sm tracking-widest text-kumo-subtle">
									<span aria-hidden="true">{"•".repeat(8)}</span>
									<span className="sr-only">{t(M.valueHidden)}</span>
								</span>
								<div className="flex gap-1">
									<Button
										variant="ghost"
										size="sm"
										aria-label={t(M.credReplace, { name: c.name })}
										onClick={() => open({ name: c.name, header: c.header, replacing: true })}
									>
										{t(M.credReplaceShort)}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="text-kumo-danger"
										aria-label={t(M.credDeleteRow, { name: c.name })}
										onClick={() => {
											setDeleteError(null);
											setDeleting(c.name);
										}}
									>
										{t(M.delete)}
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<CredentialDialog {...dialog} onClose={() => setDialog((d) => ({ ...d, open: false }))} />
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

/**
 * Adds a credential, or replaces one (its name and header filled in, the value focused). Escape
 * and Cancel close it unless the save is running; closed, focus goes back to the button that
 * opened it.
 */
function CredentialDialog(props: {
	editing: Editing;
	open: boolean;
	/** Counts the openings: each one starts an empty form. */
	opening: number;
	onClose(): void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={(open: boolean) => {
				if (!open && !busy) props.onClose();
			}}
		>
			<Dialog size="lg" className="flex flex-col gap-4 p-6">
				<div className="flex flex-col gap-1">
					<Dialog.Title className="text-lg font-semibold text-kumo-default">
						{props.editing.replacing
							? t(M.credReplace, { name: props.editing.name })
							: t(M.credAdd)}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-kumo-subtle">
						{t(M.credentialsHint)}
					</Dialog.Description>
				</div>
				<CredentialForm
					key={props.opening}
					initial={props.editing}
					busy={busy}
					setBusy={setBusy}
					onClose={props.onClose}
				/>
			</Dialog>
		</Dialog.Root>
	);
}

function CredentialForm(props: {
	initial: Editing;
	busy: boolean;
	setBusy(busy: boolean): void;
	onClose(): void;
}) {
	const t = useT();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const [name, setName] = useState(props.initial.name);
	const [header, setHeader] = useState(props.initial.header);
	const [value, setValue] = useState("");
	const [error, setError] = useState<unknown>(null);
	const valueRef = useRef<HTMLInputElement>(null);
	const { busy, setBusy } = props;

	// Replacing, the name and header are known: the value is what to type. Kumo's dialog takes no
	// initial-focus prop and focuses its first field on an animation frame, so this comes after.
	const replacing = props.initial.replacing;
	useEffect(() => {
		if (!replacing) return;
		const timer = setTimeout(() => valueRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, [replacing]);

	const ready = CREDENTIAL_NAME.test(name) && HEADER_NAME.test(header) && value !== "";

	const save = async (e: FormEvent) => {
		e.preventDefault();
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		let saved = false;
		try {
			await api.setCredential({ name, header, value });
			void queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
			announce(t(M.credSaved, { name }));
			saved = true;
		} catch (err) {
			setError(err);
		} finally {
			// The value is never kept after the call, whatever its outcome.
			setValue("");
			setBusy(false);
		}
		if (saved) props.onClose();
	};

	return (
		<form className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
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
			{error === null ? null : (
				<Banner
					variant="alert"
					description={t(describeError(error).msg, describeError(error).values)}
				/>
			)}
			<div className="flex justify-end gap-3">
				<Button variant="secondary" disabled={busy} onClick={props.onClose}>
					{t(SHARED.cancel)}
				</Button>
				<Button
					type="submit"
					variant="primary"
					loading={busy}
					aria-label={t(M.credSave)}
					aria-busy={busy || undefined}
					disabled={busy || !ready}
				>
					{t(M.credSave)}
				</Button>
			</div>
		</form>
	);
}
