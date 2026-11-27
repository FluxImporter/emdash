import { Button, Checkbox, Input, Select } from "@cloudflare/kumo";
import { type ChangeEvent, useId } from "react";
import { useT } from "../../../i18n.js";
import { APPLY_FIELD_TYPES } from "../../../limits.js";
import type { ProposedField } from "../../state.js";
import { M } from "./messages.js";

/**
 * The Map step's "New fields" section (spec "New fields"): each proposed field's label, type
 * (among the types `schema/apply` creates) and flags. The slug is fixed: rows map to it.
 */
export function NewFields(p: {
	fields: readonly ProposedField[];
	onChange(slug: string, patch: Partial<ProposedField>): void;
	onRemove(slug: string): void;
}) {
	const t = useT();
	const headingId = useId();
	if (p.fields.length === 0) return null;
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h3 id={headingId} className="font-semibold">
				{t(M.heading)}
			</h3>
			<p className="text-sm text-kumo-default">{t(M.intro)}</p>
			{p.fields.map((field) => (
				<FieldRow
					key={field.slug}
					field={field}
					onChange={(patch) => p.onChange(field.slug, patch)}
					onRemove={() => p.onRemove(field.slug)}
				/>
			))}
		</section>
	);
}

function FieldRow(p: {
	field: ProposedField;
	onChange(patch: Partial<ProposedField>): void;
	onRemove(): void;
}) {
	const t = useT();
	const { field } = p;
	const name = field.label === "" ? field.slug : field.label;
	return (
		<fieldset className="space-y-3 rounded-lg border border-kumo-hairline bg-kumo-base p-4">
			<legend className="sr-only">{name}</legend>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-sm text-kumo-subtle" title={field.key}>
					{t(M.source, { key: field.key, slug: field.slug })}
				</span>
				<Button
					variant="secondary"
					size="sm"
					aria-label={t(M.removeNamed, { label: name })}
					onClick={p.onRemove}
				>
					{t(M.remove)}
				</Button>
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<Input
					label={t(M.label)}
					value={field.label}
					onChange={(e: ChangeEvent<HTMLInputElement>) => p.onChange({ label: e.target.value })}
				/>
				<Select
					label={t(M.type)}
					value={field.type}
					onValueChange={(value: unknown) => {
						if (typeof value === "string" && value !== field.type) p.onChange({ type: value });
					}}
				>
					{APPLY_FIELD_TYPES.map((type) => (
						<Select.Option key={type} value={type}>
							{type}
						</Select.Option>
					))}
				</Select>
			</div>
			<div className="flex gap-6">
				<Checkbox
					label={t(M.translatable)}
					checked={field.translatable}
					onCheckedChange={(checked: boolean) => p.onChange({ translatable: checked === true })}
				/>
				<Checkbox
					label={t(M.searchable)}
					checked={field.searchable}
					onCheckedChange={(checked: boolean) => p.onChange({ searchable: checked === true })}
				/>
			</div>
		</fieldset>
	);
}
