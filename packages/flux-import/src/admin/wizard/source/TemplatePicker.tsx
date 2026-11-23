import { Button, Empty, Loader, Select } from "@cloudflare/kumo";
import { type ReactNode, useState } from "react";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { useAllTemplates } from "../../queries.js";
import { useWizard } from "../context.js";
import { M } from "./messages.js";
import type { TabProps } from "./SourceStep.js";

/**
 * Start from a saved template: `templates/get`, then `templateLoaded`, which opens Preview. Only
 * once the data is sampled (preflight F10): the job reads the chosen file.
 */
export function TemplatePicker(props: { enabled: boolean } & Pick<TabProps, "busy" | "run">) {
	const t = useT();
	const { dispatch } = useWizard();
	const templates = useAllTemplates();
	const [id, setId] = useState<string | null>(null);
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
			if (id === null) return;
			props.run(async () => {
				const saved = await api.getTemplate({ id });
				dispatch({
					type: "templateLoaded",
					base: {
						id: saved.id,
						revision: saved.revision,
						name: saved.name,
						template: saved.template,
					},
				});
			});
		};
		body = (
			<div className="flex flex-wrap items-end gap-3">
				<Select
					label={t(M.templateLabel)}
					value={id}
					disabled={disabled}
					{...(props.enabled ? {} : { description: t(M.templateNeedsFile) })}
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
