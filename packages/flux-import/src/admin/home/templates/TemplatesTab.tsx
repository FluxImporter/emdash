import { Button, Empty, LinkButton, Loader, Table } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TemplateSummary } from "../../../plugin/templates.js";
import { api, saveJson } from "../../api.js";
import { ApiError, isForbidden } from "../../api-error.js";
import { describeError, scheduleNames } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M as PAGE } from "../../messages.js";
import { queryKeys, useAllTemplates, useSchedules } from "../../queries.js";
import { useHome } from "../Home.js";
import { templateUrl, WIZARD_URL } from "../links.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { When } from "../shared/When.js";
import { EditTemplateDialog } from "./EditTemplateDialog.js";
import { ImportTemplateDialog } from "./ImportTemplateDialog.js";
import { M } from "./messages.js";

/** The Templates tab: every saved template, with use, export, rename, delete and import. */
export function TemplatesTab() {
	const t = useT();
	const { announce } = useHome();
	const client = useQueryClient();
	const templates = useAllTemplates();
	const schedules = useSchedules();
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

	let body: React.ReactNode;
	if (templates.isPending) {
		body = <Loader aria-label={t(M.loading)} />;
	} else if (templates.isError) {
		body = (
			<div role="alert" className="flex items-center gap-3 text-kumo-danger">
				<p>{sentence(templates.error)}</p>
				{/* No retry changes a role. */}
				{isForbidden(templates.error) ? null : (
					<Button variant="secondary" onClick={() => void templates.refetch()}>
						{t(PAGE.tryAgain)}
					</Button>
				)}
			</div>
		);
	} else if (templates.data.length === 0) {
		body = (
			<Empty
				size="sm"
				title={t(M.empty)}
				description={t(M.emptyHint)}
				contents={
					<LinkButton variant="primary" href={WIZARD_URL}>
						{t(M.openWizard)}
					</LinkButton>
				}
			/>
		);
	} else {
		body = (
			<div className="overflow-x-auto">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.colName)}</Table.Head>
							<Table.Head>{t(M.colTarget)}</Table.Head>
							<Table.Head>{t(M.colDescription)}</Table.Head>
							<Table.Head>{t(M.colRevision)}</Table.Head>
							<Table.Head>{t(M.colChanged)}</Table.Head>
							<Table.Head>{t(M.colActions)}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{templates.data.map((row) => (
							<Table.Row key={row.id}>
								<Table.Cell className="break-words font-medium">{row.name}</Table.Cell>
								<Table.Cell>
									{t(M.target, { collection: row.collection, locale: row.locale })}
								</Table.Cell>
								<Table.Cell className="break-words">{row.description ?? ""}</Table.Cell>
								<Table.Cell className="whitespace-nowrap">
									{t(M.revision, { revision: row.revision })}
								</Table.Cell>
								<Table.Cell className="whitespace-nowrap">
									<When iso={row.updatedAt} />
								</Table.Cell>
								<Table.Cell>
									<div className="flex flex-wrap gap-2">
										<LinkButton
											variant="secondary"
											href={templateUrl(row.id)}
											aria-label={t(M.useRow, { name: row.name })}
										>
											{t(M.use)}
										</LinkButton>
										<Button
											variant="secondary"
											disabled={exporting !== null}
											aria-busy={exporting === row.id || undefined}
											aria-label={t(M.exportRow, { name: row.name })}
											onClick={() => void exportRow(row)}
										>
											{t(M.export)}
										</Button>
										<Button
											variant="secondary"
											aria-label={t(M.editRow, { name: row.name })}
											onClick={() => setEditing(row)}
										>
											{t(M.edit)}
										</Button>
										<Button
											variant="secondary"
											aria-label={t(M.deleteRow, { name: row.name })}
											onClick={() => {
												setDeleteError(null);
												setDeleting(row);
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
		);
	}

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
		<div className="space-y-4">
			{/* The home heads the tab with its <h2>; this row holds the tab's own action. */}
			<div className="flex items-center justify-end gap-3">
				<Button variant="secondary" onClick={() => setImporting(true)}>
					{t(M.importButton)}
				</Button>
			</div>
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
