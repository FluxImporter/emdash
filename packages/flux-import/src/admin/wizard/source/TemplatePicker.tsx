import { Button, Empty, Loader, Select } from "@cloudflare/kumo";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { SAMPLE_MAX } from "../../limits.js";
import { useAllTemplates } from "../../queries.js";
import { useWizard } from "../context.js";
import { sampleColumns } from "../sample.js";
import { readUrl, writeUrl } from "../url.js";
import { M } from "./messages.js";
import type { Described, TabProps } from "./SourceStep.js";

/** A template whose settings find no records in the file: it is not loaded. */
class NoRecords extends Error {}

function describeLoad(e: unknown): Described {
	return e instanceof NoRecords ? { msg: M.templateNoRecords } : describeError(e);
}

/**
 * Start from a saved template: `templates/get`, then `templateLoaded`, which opens Preview. Only
 * once the data is sampled (preflight F10): the job reads the chosen file.
 */
export function TemplatePicker(props: { enabled: boolean } & Pick<TabProps, "busy" | "run">) {
	const t = useT();
	const { state, dispatch } = useWizard();
	const templates = useAllTemplates();
	// `?template=` is read once, when the picker first mounts, and then dropped from the URL: a
	// return to Source after a reset does not preselect it again (preflight F13).
	const [fromUrl] = useState(() => readUrl(window.location.search).template);
	const [picked, setPicked] = useState<{ id: string | null } | null>(null);
	useEffect(() => {
		if (fromUrl !== null) writeUrl({ template: null });
	}, [fromUrl]);
	const preselected = picked === null && templates.data?.some((s) => s.id === fromUrl) === true;
	const id = picked !== null ? picked.id : preselected ? fromUrl : null;
	const setId = (v: string | null) => setPicked({ id: v });
	const disabled = !props.enabled || props.busy;

	let body: ReactNode;
	if (templates.isPending) body = <Loader aria-label={t(M.loadingTemplates)} />;
	else if (templates.isError) {
		const { msg, values } = describeError(templates.error);
		body = (
			<p role="alert" className="text-kumo-danger">
				{t(msg, values)}
			</p>
		);
	} else if (templates.data.length === 0) {
		body = <Empty size="sm" title={t(M.noTemplates)} description={t(M.noTemplatesHint)} />;
	} else {
		const items = templates.data.map((s) => ({
			value: s.id,
			label: t(M.templateOption, { name: s.name, collection: s.collection }),
		}));
		const load = () => {
			const uploadId = state.source?.uploadId;
			if (id === null || uploadId === undefined) return;
			props.run(async () => {
				const saved = await api.getTemplate({ id });
				// The template reads the file with its own settings: Map gets the keys they find.
				const { source } = saved.template;
				const reply = await api.sample({ uploadId, n: SAMPLE_MAX, source });
				const columns = sampleColumns(reply, source.format);
				if (columns.length === 0 || (columns[0]?.values.length ?? 0) === 0) {
					throw new NoRecords();
				}
				dispatch({ type: "sourceBlockChanged", sourceBlock: source, columns });
				dispatch({
					type: "templateLoaded",
					base: {
						id: saved.id,
						revision: saved.revision,
						name: saved.name,
						template: saved.template,
					},
				});
			}, describeLoad);
		};
		body = (
			<div className="flex flex-wrap items-end gap-3">
				<Select
					label={t(M.templateLabel)}
					value={id}
					disabled={disabled}
					{...(props.enabled
						? {}
						: { description: t(preselected ? M.templateChooseData : M.templateNeedsFile) })}
					onValueChange={(v: unknown) => setId(typeof v === "string" ? v : null)}
					items={items}
				>
					{items.map((item) => (
						<Select.Option key={item.value} value={item.value}>
							{item.label}
						</Select.Option>
					))}
				</Select>
				<Button variant="secondary" disabled={disabled || id === null} onClick={load}>
					{t(M.loadTemplate)}
				</Button>
			</div>
		);
	}
	return (
		<section className="space-y-2">
			<h3 className="font-semibold">{t(M.template)}</h3>
			{body}
		</section>
	);
}
