import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError } from "../../errors.js";
import type { Msg } from "../../i18n.js";
import { useT } from "../../i18n.js";
import { OWNER_PATTERN, TEMPLATE_BODY_MAX_BYTES } from "../../limits.js";
import { queryKeys } from "../../queries.js";
import { M as SOURCE } from "../../wizard/source/messages.js";
import { useHome } from "../Home.js";
import { M as SHARED } from "../shared/messages.js";
import { M } from "./messages.js";

/**
 * Imports a template file. The browser refuses a file over 2 MiB or not JSON before any request
 * (plan Ruling 17); the server checks the rest.
 */
export function ImportTemplateDialog(props: { onClose(): void }) {
	const t = useT();
	const { announce } = useHome();
	const client = useQueryClient();
	const ownerRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const labelId = useId();
	const buttonId = useId();
	const [file, setFile] = useState<unknown>(undefined);
	const [fileName, setFileName] = useState<string | null>(null);
	const [fileProblem, setFileProblem] = useState<Msg | null>(null);
	const [name, setName] = useState("");
	const [owner, setOwner] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	// The owner field is disabled while the call runs, so it takes focus once the call is over.
	const ownerTaken = error instanceof ApiError && error.code === "OWNER_IN_USE";
	useEffect(() => {
		if (ownerTaken && !busy) ownerRef.current?.focus();
	}, [ownerTaken, busy]);

	const ownerOk = owner === "" || OWNER_PATTERN.test(owner);

	const pick = useRef(0);
	const choose = async (chosen: File | undefined) => {
		const mine = ++pick.current;
		setFile(undefined);
		setFileProblem(null);
		setError(null);
		setFileName(chosen?.name ?? null);
		if (chosen === undefined) return;
		if (chosen.size > TEMPLATE_BODY_MAX_BYTES) {
			setFileProblem(M.fileTooLarge);
			return;
		}
		try {
			const parsed = JSON.parse(await chosen.text()) as unknown;
			if (mine === pick.current) setFile(parsed);
		} catch {
			if (mine === pick.current) setFileProblem(M.fileNotJson);
		}
	};

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.importTemplate({
				file,
				...(name.trim() === "" ? {} : { name: name.trim() }),
				...(owner === "" ? {} : { owner }),
			});
			await client.invalidateQueries({ queryKey: queryKeys.allTemplates });
			announce(t(M.imported, { name: result.template.name }));
			props.onClose();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	const described = error === null ? null : describeError(error);

	return (
		<Dialog.Root
			open
			onOpenChange={(open: boolean) => {
				if (!open && !busy) props.onClose();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{t(M.importTitle)}</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{t(M.importSentence)}
				</Dialog.Description>
				<div className="space-y-2">
					<label
						id={labelId}
						htmlFor="flux-import-template-file"
						className="block text-sm font-medium"
					>
						{t(M.fileLabel)}
					</label>
					{/*
					 * The browser's own file control has no button look in the admin's themes, so a Kumo
					 * button opens it, as the wizard's Upload tab does (M7a); the label names both.
					 */}
					<input
						ref={fileRef}
						id="flux-import-template-file"
						type="file"
						accept=".json,application/json"
						disabled={busy}
						tabIndex={-1}
						aria-hidden="true"
						className="sr-only"
						onChange={(e: ChangeEvent<HTMLInputElement>) => void choose(e.target.files?.[0])}
					/>
					<div className="flex flex-wrap items-center gap-3">
						<Button
							id={buttonId}
							variant="secondary"
							disabled={busy}
							aria-labelledby={`${labelId} ${buttonId}`}
							onClick={() => fileRef.current?.click()}
						>
							{t(SOURCE.browseFiles)}
						</Button>
						{fileName === null ? null : (
							<p className="text-sm">{t(M.chosenFile, { name: fileName })}</p>
						)}
					</div>
					{fileProblem === null ? null : (
						<p role="alert" className="text-sm text-kumo-danger">
							{t(fileProblem)}
						</p>
					)}
				</div>
				<Input
					label={t(M.newNameLabel)}
					value={name}
					disabled={busy}
					onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
				/>
				<Input
					ref={ownerRef}
					label={t(M.ownerLabel)}
					description={t(M.ownerHint)}
					value={owner}
					disabled={busy}
					onChange={(e: ChangeEvent<HTMLInputElement>) => setOwner(e.target.value)}
					{...(ownerOk ? {} : { error: t(M.ownerInvalid) })}
				/>
				{described === null ? null : (
					<p role="alert" className="text-sm text-kumo-danger">
						{t(described.msg, described.values)}
						{described.detail === undefined ? "" : ` ${described.detail}`}
					</p>
				)}
				<div className="flex justify-end gap-3">
					<Button variant="secondary" disabled={busy} onClick={props.onClose}>
						{t(SHARED.cancel)}
					</Button>
					<Button
						variant="primary"
						loading={busy}
						aria-label={t(M.import)}
						aria-busy={busy || undefined}
						disabled={busy || file === undefined || !ownerOk}
						onClick={() => void submit()}
					>
						{t(M.import)}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
