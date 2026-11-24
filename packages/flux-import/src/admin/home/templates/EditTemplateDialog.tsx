import { Button, Dialog, Input, InputArea, Loader } from "@cloudflare/kumo";
import { type UseQueryResult, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useId, useState } from "react";
import type { ScheduleView } from "../../../plugin/schedules.js";
import type { TemplateSummary } from "../../../plugin/templates.js";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX } from "../../limits.js";
import { M as PAGE } from "../../messages.js";
import { queryKeys } from "../../queries.js";
import { useHome } from "../Home.js";
import { PinnedFailures, PinnedSchedules } from "../pinned/PinnedSchedules.js";
import { type PinChange, pinnedSchedules, updatePinned } from "../pinned/pinned.js";
import { M as SHARED } from "../shared/messages.js";
import { M } from "./messages.js";

const nameOk = (name: string) =>
	name.length > 0 && name.length <= TEMPLATE_NAME_MAX && name === name.trim();

/**
 * Renames and describes a saved template at the revision the row showed. The schedules on it are
 * named before the save; checked, each is moved to the new revision after it (plan Ruling 14).
 */
export function EditTemplateDialog(props: {
	row: TemplateSummary;
	schedules: UseQueryResult<ScheduleView[]>;
	onClose(): void;
	onReload(): void;
}) {
	const t = useT();
	const { announce } = useHome();
	const client = useQueryClient();
	const { row } = props;
	const [name, setName] = useState(row.name);
	const [description, setDescription] = useState(row.description ?? "");
	const [alsoUpdate, setAlsoUpdate] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [failed, setFailed] = useState<{ name: string; error: unknown }[]>([]);
	const [saved, setSaved] = useState(false);

	const change: PinChange = { kind: "template", templateId: row.id };
	const noteId = useId();
	const known = props.schedules.data;
	const rows = known === undefined ? [] : pinnedSchedules(known, change);
	const failedToCheck = props.schedules.isError;
	const checking = known === undefined;
	const anyEnabled = rows.some((s) => s.enabled);
	const descriptionOk = description.length <= TEMPLATE_DESCRIPTION_MAX;
	const nameChanged = name !== row.name;
	const descriptionChanged = description !== (row.description ?? "");

	const save = async () => {
		if (!nameChanged && !descriptionChanged) {
			props.onClose();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.updateTemplate({
				id: row.id,
				revision: row.revision,
				...(nameChanged ? { name } : {}),
				...(descriptionChanged ? { description: description === "" ? null : description } : {}),
			});
			setSaved(true);
			const outcome =
				alsoUpdate && rows.length > 0
					? await updatePinned(rows, change, result.template.revision, api.updateSchedule)
					: { updated: [], failed: [] };
			await Promise.all([
				client.invalidateQueries({ queryKey: queryKeys.allTemplates }),
				client.invalidateQueries({ queryKey: queryKeys.schedules }),
			]);
			const saved = result.template.name;
			const count = outcome.updated.length;
			if (outcome.failed.length > 0) {
				setFailed(outcome.failed);
				announce(t(M.savedPartly, { name: saved, count }));
			} else {
				announce(
					alsoUpdate && rows.length > 0
						? t(M.savedSchedules, { name: saved, count })
						: t(M.saved, { name: saved }),
				);
				props.onClose();
			}
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	const checkError = props.schedules.isError ? describeError(props.schedules.error) : null;
	const checkText = checkError === null ? "" : t(checkError.msg, checkError.values);
	const retryable = !(
		props.schedules.error instanceof ApiError && props.schedules.error.status === 403
	);
	const missing = failed.filter(
		(f) => f.error instanceof ApiError && f.error.code === "MISSING_REQUIRED",
	);
	const others = failed.filter((f) => !missing.includes(f));
	const changedElsewhere = error instanceof ApiError && error.code === "TEMPLATE_CHANGED";

	return (
		<Dialog.Root
			open
			onOpenChange={(open: boolean) => {
				if (!open && !busy) props.onClose();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">
					{t(M.editTitle, { name: row.name })}
				</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{t(M.editSentence)}
				</Dialog.Description>
				<Input
					label={t(M.nameLabel)}
					value={name}
					disabled={busy || saved}
					onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
					{...(nameOk(name) ? {} : { error: t(M.nameInvalid) })}
				/>
				<InputArea
					label={t(M.descriptionLabel)}
					description={t(M.descriptionHint)}
					value={description}
					disabled={busy || saved}
					onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
					{...(descriptionOk ? {} : { error: t(M.descriptionHint) })}
				/>
				{saved || !checking ? null : failedToCheck ? (
					<div role="alert" className="space-y-2 text-sm text-kumo-danger">
						<p>
							{t(M.schedulesFailed)} {checkText}
						</p>
						{retryable ? (
							<Button variant="secondary" onClick={() => void props.schedules.refetch()}>
								{t(PAGE.tryAgain)}
							</Button>
						) : null}
					</div>
				) : (
					<Loader aria-label={t(M.schedulesLoading)} />
				)}
				{saved || checking ? null : (
					<PinnedSchedules
						rows={rows}
						kind="template"
						checked={alsoUpdate}
						onCheckedChange={setAlsoUpdate}
					/>
				)}
				{!saved && alsoUpdate && anyEnabled ? (
					<p id={noteId} className="text-sm text-kumo-subtle">
						{t(M.runAsYou)}
					</p>
				) : null}
				{missing.map((f) => (
					<p key={f.name} className="text-sm text-kumo-danger">
						{t(M.missingRequired, { name: f.name })}
					</p>
				))}
				<PinnedFailures failed={others} />
				{error === null ? null : changedElsewhere ? (
					<div role="alert" className="flex items-center gap-3 text-sm text-kumo-danger">
						<p>{t(M.changedElsewhere)}</p>
						<Button variant="secondary" onClick={props.onReload}>
							{t(M.reload)}
						</Button>
					</div>
				) : (
					<p role="alert" className="text-sm text-kumo-danger">
						{(() => {
							const d = describeError(error);
							return `${t(d.msg, d.values)}${d.detail === undefined ? "" : ` ${d.detail}`}`;
						})()}
					</p>
				)}
				<div className="flex justify-end gap-3">
					<Button variant="secondary" disabled={busy} onClick={props.onClose}>
						{saved ? t(M.close) : t(SHARED.cancel)}
					</Button>
					{saved ? null : (
						<Button
							variant="primary"
							loading={busy}
							aria-label={t(M.save)}
							aria-busy={busy || undefined}
							disabled={busy || checking || !nameOk(name) || !descriptionOk}
							{...(!saved && alsoUpdate && anyEnabled ? { "aria-describedby": noteId } : {})}
							onClick={() => void save()}
						>
							{t(M.save)}
						</Button>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
