import { Button, DropdownMenu, Empty, LinkButton, Table } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { TemplateSummary } from "../../../plugin/templates.js";
import { api, saveJson } from "../../api.js";
import { ApiError, isForbidden } from "../../api-error.js";
import { describeError, scheduleNames } from "../../errors.js";
import { useT, useTn } from "../../i18n.js";
import { queryKeys, useAllTemplates, useSchedules } from "../../queries.js";
import { BookmarkSimpleIcon, DotsThreeIcon, UploadSimpleIcon } from "../../ui/icons.js";
import { Forbidden, LoadFailed, LoadingRows } from "../../ui/states.js";
import { useNarrow } from "../../ui/use-narrow.js";
import { useHome } from "../Home.js";
import { templateUrl, WIZARD_URL } from "../links.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { TabSummary } from "../shared/TabSummary.js";
import { When } from "../shared/When.js";
import { EditTemplateDialog } from "./EditTemplateDialog.js";
import { ImportTemplateDialog } from "./ImportTemplateDialog.js";
import { M, N } from "./messages.js";

/**
 * The Templates tab (Templates.dc.html): the summary line with Import a template, then every
 * saved template with its collection, revision and last change, Use (the wizard with the
 * template) and a menu with Export, Rename and describe, and Delete.
 */
export function TemplatesTab() {
	const t = useT();
	const tn = useTn();
	const { announce } = useHome();
	const client = useQueryClient();
	const templates = useAllTemplates();
	const schedules = useSchedules();
	const [narrowRef, narrow] = useNarrow<HTMLDivElement>();
	const [editing, setEditing] = useState<TemplateSummary | null>(null);
	const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
	const [importing, setImporting] = useState(false);
	const [exporting, setExporting] = useState<string | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [deleteError, setDeleteError] = useState<unknown>(null);
	const [exportError, setExportError] = useState<unknown>(null);

	const reload = () => {
		setEditing(null);
		setDeleting(null);
		setDeleteError(null);
		void client.invalidateQueries({ queryKey: queryKeys.allTemplates });
	};

	const exportRow = async (row: TemplateSummary) => {
		setExporting(row.id);
		setExportError(null);
		try {
			const { file, filename } = await api.exportTemplate({ id: row.id });
			saveJson(file, filename);
			announce(t(M.exported, { name: row.name }));
		} catch (e) {
			setExportError(e);
		} finally {
			setExporting(null);
		}
	};

	const confirmDelete = async (row: TemplateSummary) => {
		setDeleteBusy(true);
		setDeleteError(null);
		try {
			await api.deleteTemplate({ id: row.id, revision: row.revision });
			await client.invalidateQueries({ queryKey: queryKeys.allTemplates });
			announce(t(M.deleted, { name: row.name }));
			setDeleting(null);
		} catch (e) {
			setDeleteError(e);
		} finally {
			setDeleteBusy(false);
		}
	};

	const sentence = (error: unknown) => {
		const d = describeError(error);
		return t(d.msg, d.values);
	};

	const actions = (row: TemplateSummary): ReactNode => (
		<div className="flex items-center justify-end gap-1">
			<LinkButton
				variant="secondary"
				size="sm"
				href={templateUrl(row.id)}
				aria-label={t(M.useRow, { name: row.name })}
			>
				{t(M.use)}
			</LinkButton>
			<DropdownMenu>
				<DropdownMenu.Trigger>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<DotsThreeIcon aria-hidden="true" size={16} />}
						aria-label={t(M.actionsRow, { name: row.name })}
						aria-busy={exporting === row.id || undefined}
					/>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content>
					<DropdownMenu.Item
						disabled={exporting !== null}
						aria-label={t(M.exportRow, { name: row.name })}
						onClick={() => void exportRow(row)}
					>
						{t(M.export)}
					</DropdownMenu.Item>
					<DropdownMenu.Item
						aria-label={t(M.editRow, { name: row.name })}
						onClick={() => setEditing(row)}
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
	);

	/** The name, and the description under it (Spec: no separate Description column). */
	const nameCell = (row: TemplateSummary): ReactNode => (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="break-words font-semibold text-kumo-default">{row.name}</span>
			<span className="break-words text-sm text-kumo-subtle">
				{row.description ?? t(M.noDescription)}
			</span>
		</div>
	);

	let body: ReactNode;
	if (templates.isPending) {
		body = <LoadingRows label={t(M.loading)} columns={4} />;
	} else if (templates.isError) {
		// No retry changes a role.
		body = isForbidden(templates.error) ? (
			<Forbidden />
		) : (
			<LoadFailed
				title={t(M.loadFailed)}
				error={templates.error}
				retrying={templates.isFetching}
				onRetry={() => void templates.refetch()}
			/>
		);
	} else if (templates.data.length === 0) {
		body = (
			<Empty
				size="sm"
				icon={<BookmarkSimpleIcon aria-hidden="true" size={28} />}
				title={t(M.empty)}
				description={t(M.emptyHint)}
				contents={
					<LinkButton variant="secondary" href={WIZARD_URL}>
						{t(M.openWizard)}
					</LinkButton>
				}
			/>
		);
	} else if (narrow) {
		body = (
			<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-hairline bg-kumo-base">
				{templates.data.map((row) => (
					<li key={row.id} className="flex items-start gap-3 px-4 py-3">
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							{nameCell(row)}
							<span className="text-sm">
								{t(M.target, { collection: row.collection, locale: row.locale })}
								{" · "}
								{t(M.revisionShort, { revision: row.revision })}
								{" · "}
								<When iso={row.updatedAt} />
							</span>
						</div>
						{actions(row)}
					</li>
				))}
			</ul>
		);
	} else {
		body = (
			<div className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-base">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.colTemplate)}</Table.Head>
							<Table.Head>{t(M.colTarget)}</Table.Head>
							<Table.Head>{t(M.colRevision)}</Table.Head>
							<Table.Head>{t(M.colChanged)}</Table.Head>
							<Table.Head>
								<span className="sr-only">{t(M.colActions)}</span>
							</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{templates.data.map((row) => (
							<Table.Row key={row.id}>
								<Table.Cell className="align-top">{nameCell(row)}</Table.Cell>
								<Table.Cell className="whitespace-nowrap align-top text-sm">
									{t(M.target, { collection: row.collection, locale: row.locale })}
								</Table.Cell>
								<Table.Cell className="align-top text-sm tabular-nums">{row.revision}</Table.Cell>
								<Table.Cell className="whitespace-nowrap align-top text-sm">
									<When iso={row.updatedAt} />
								</Table.Cell>
								<Table.Cell className="align-top">{actions(row)}</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table>
			</div>
		);
	}

	const importButton = (
		<Button
			variant="secondary"
			icon={<UploadSimpleIcon aria-hidden="true" />}
			onClick={() => setImporting(true)}
		>
			{t(M.importButton)}
		</Button>
	);

	const deleteMessage = () => {
		if (deleteError === null) return null;
		if (deleteError instanceof ApiError && deleteError.code === "TEMPLATE_CHANGED") {
			return (
				<div role="alert" className="flex items-center gap-3 text-sm text-kumo-danger">
					<p>{t(M.changedElsewhere)}</p>
					<Button variant="secondary" onClick={reload}>
						{t(M.reload)}
					</Button>
				</div>
			);
		}
		const names =
			deleteError instanceof ApiError && deleteError.code === "TEMPLATE_IN_USE"
				? scheduleNames(deleteError, schedules.data ?? [])
				: null;
		return (
			<p role="alert" className="text-sm text-kumo-danger">
				{names === null ? sentence(deleteError) : t(M.inUse, { names })}
			</p>
		);
	};

	return (
		<div ref={narrowRef} className="flex flex-col gap-4">
			{/* The count once the list is read; importing a file needs no list, so the action stays. */}
			<TabSummary
				lead={templates.data === undefined ? "" : tn(N.templates, templates.data.length)}
				rest={templates.data === undefined || templates.data.length === 0 ? [] : [t(M.summary)]}
				action={importButton}
			/>
			{exportError === null ? null : (
				<p role="alert" className="text-sm text-kumo-danger">
					{sentence(exportError)}
				</p>
			)}
			{body}
			{editing === null ? null : (
				<EditTemplateDialog
					key={`${editing.id}-${editing.revision}`}
					row={editing}
					schedules={schedules}
					onClose={() => setEditing(null)}
					onReload={reload}
				/>
			)}
			{importing ? <ImportTemplateDialog onClose={() => setImporting(false)} /> : null}
			{deleting === null ? null : (
				<ConfirmDialog
					open
					title={t(M.deleteTitle, { name: deleting.name })}
					sentence={t(M.deleteSentence, { name: deleting.name })}
					confirmLabel={t(M.delete)}
					danger
					busy={deleteBusy}
					error={deleteMessage()}
					onConfirm={() => void confirmDelete(deleting)}
					onClose={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
