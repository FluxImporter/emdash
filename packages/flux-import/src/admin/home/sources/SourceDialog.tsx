import { Banner, Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import type { SourceRow } from "../../../plugin/sources.js";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { SOURCE_NAME_MAX } from "../../limits.js";
import { queryKeys, useCredentials, useSchedules } from "../../queries.js";
import { useHome } from "../Home.js";
import { PinnedFailures, PinnedSchedules } from "../pinned/PinnedSchedules.js";
import { pinnedSchedules, sourcePinChanged, updatePinned } from "../pinned/pinned.js";
import { M as SHARED } from "../shared/messages.js";
import { M } from "./messages.js";

/**
 * Add a source (no `source`) or edit one. An edit sends the changed fields only (`credential: null`
 * removes it). When the URL or credential changes, the enabled schedules that read the source are
 * named, and "Also update these schedules" (checked) re-pins them one at a time after the save
 * (plan Ruling 14). A failure keeps the dialog open to name the schedules left to pause.
 */
export function SourceDialog(props: { source?: SourceRow; onClose(): void }) {
	const { source } = props;
	const t = useT();
	const { announce } = useHome();
	const queryClient = useQueryClient();
	const credentials = useCredentials();
	const schedules = useSchedules();
	const [name, setName] = useState(source?.name ?? "");
	const [url, setUrl] = useState(source?.url ?? "");
	const [credential, setCredential] = useState<string | null>(source?.credential ?? null);
	const [alsoUpdate, setAlsoUpdate] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [taken, setTaken] = useState(false);
	const [failed, setFailed] = useState<{ name: string; error: unknown }[]>([]);

	const trimmedName = name.trim();
	const trimmedUrl = url.trim();
	const edit: { name?: string; url?: string; credential?: string | null } = {};
	if (source) {
		if (trimmedName !== source.name) edit.name = trimmedName;
		if (trimmedUrl !== source.url) edit.url = trimmedUrl;
		if ((credential ?? null) !== (source.credential ?? null)) edit.credential = credential;
	}
	const pinChanged = source !== undefined && sourcePinChanged(source, edit);
	const pinned =
		source && pinChanged && schedules.data
			? pinnedSchedules(schedules.data, { kind: "source", sourceId: source.id })
			: [];
	const changed = Object.keys(edit).length > 0;
	const ready = trimmedName !== "" && trimmedUrl !== "" && (source === undefined || changed);
	const saved = failed.length > 0;

	const names = credentials.data?.map((c) => c.name) ?? [];
	if (source?.credential !== undefined && !names.includes(source.credential)) {
		names.push(source.credential);
	}

	const save = async () => {
		setBusy(true);
		setError(null);
		setTaken(false);
		let row: SourceRow;
		try {
			row = source
				? await api.updateSource({ id: source.id, ...edit })
				: await api.createSource({
						name: trimmedName,
						url: trimmedUrl,
						...(credential === null ? {} : { credential }),
					});
		} catch (e) {
			// The name-taken sentence is for a CONFLICT about the name; any other CONFLICT is global.
			const nameClash =
				e instanceof ApiError &&
				e.code === "CONFLICT" &&
				(source === undefined || edit.name !== undefined);
			setTaken(nameClash);
			setError(nameClash ? null : e);
			setBusy(false);
			return;
		}
		void queryClient.invalidateQueries({ queryKey: queryKeys.sources });
		let outcome = t(M.saved, { name: row.name });
		let failures: { name: string; error: unknown }[] = [];
		if (alsoUpdate && pinned.length > 0) {
			const result = await updatePinned(
				pinned,
				{ kind: "source", sourceId: row.id },
				undefined,
				(i) => api.updateSchedule(i),
			);
			void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
			failures = result.failed;
			const count = result.updated.length;
			outcome =
				failures.length === 0
					? t(M.savedUpdated, { name: row.name, count })
					: t(M.savedPartly, {
							name: row.name,
							count,
							names: failures.map((f) => f.name).join(", "),
						});
		}
		announce(outcome);
		setBusy(false);
		if (failures.length > 0) setFailed(failures);
		else props.onClose();
	};

	const close = () => {
		if (!busy) props.onClose();
	};
	const title = source ? t(M.editTitle, { name: source.name }) : t(M.addTitle);
	return (
		<Dialog.Root
			open
			onOpenChange={(open: boolean) => {
				if (!open) close();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{saved ? t(M.savedFailures, { name }) : t(M.dialogSentence)}
				</Dialog.Description>
				{saved ? (
					<PinnedFailures failed={failed} />
				) : (
					<div className="space-y-4">
						<Input
							label={t(M.fieldName)}
							maxLength={SOURCE_NAME_MAX}
							value={name}
							onChange={(e: ChangeEvent<HTMLInputElement>) => {
								setName(e.target.value);
								setTaken(false);
							}}
						/>
						<Input
							label={t(M.fieldUrl)}
							type="url"
							value={url}
							onChange={(e: ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
						/>
						<Select
							label={t(M.fieldCredential)}
							value={credential}
							loading={credentials.isPending}
							onValueChange={(v: unknown) => setCredential(typeof v === "string" ? v : null)}
							items={[
								{ value: null, label: t(M.noCredential) },
								...names.map((n) => ({ value: n, label: n })),
							]}
						>
							<Select.Option value={null}>{t(M.noCredential)}</Select.Option>
							{names.map((n) => (
								<Select.Option key={n} value={n}>
									{n}
								</Select.Option>
							))}
						</Select>
						<PinnedSchedules
							rows={pinned}
							kind="source"
							checked={alsoUpdate}
							onCheckedChange={setAlsoUpdate}
						/>
						{taken ? <Banner variant="alert" description={t(M.nameTaken)} /> : null}
						{error === null ? null : (
							<Banner
								variant="alert"
								description={t(describeError(error).msg, describeError(error).values)}
							/>
						)}
					</div>
				)}
				<div className="flex justify-end gap-3">
					{saved ? (
						<Button variant="primary" onClick={props.onClose}>
							{t(M.close)}
						</Button>
					) : (
						<>
							<Button variant="secondary" disabled={busy} onClick={close}>
								{t(SHARED.cancel)}
							</Button>
							<Button
								variant="primary"
								loading={busy}
								aria-label={t(M.save)}
								aria-busy={busy || undefined}
								disabled={busy || !ready || (source !== undefined && schedules.isPending)}
								onClick={() => void save()}
							>
								{t(M.save)}
							</Button>
						</>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
