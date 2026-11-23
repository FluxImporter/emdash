import { Empty, Table } from "@cloudflare/kumo";
import type { SourceFormat } from "../../../sources/reader.js";
import { useT } from "../../i18n.js";
import { KEYS_SHOWN } from "../../limits.js";
import type { SampleColumn } from "../../types.js";
import { M } from "./messages.js";

/** The values shown per key: the sample holds `SAMPLE_MAX` records (preflight F24). */
const VALUES_SHOWN = 5;
const VALUE_MAX = 80;

/** A sampled value as text; null for a record that lacks the key. */
function shown(value: unknown): string | null {
	if (value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/**
 * The sample: each key with its first values. A sample without keys or without records gets an
 * empty state that names the cause (Review Focus 3, preflight F7).
 */
export function SamplePreview(props: { columns: SampleColumn[]; format: SourceFormat }) {
	const t = useT();
	const { columns } = props;
	if (columns.length === 0) {
		const nested = props.format === "json" || props.format === "xml";
		return (
			<Empty
				size="sm"
				title={t(M.noRecords)}
				description={t(nested ? M.noRecordsPathHint : M.noRecordsHint)}
			/>
		);
	}
	if ((columns[0]?.values.length ?? 0) === 0) {
		return <Empty size="sm" title={t(M.headerOnly)} description={t(M.headerOnlyHint)} />;
	}
	const rows = columns.slice(0, KEYS_SHOWN);
	return (
		<section className="space-y-2">
			<h3 className="font-semibold">{t(M.sample)}</h3>
			{columns.length > rows.length ? (
				<p className="text-sm text-kumo-subtle">
					{t(M.keysShown, {
						shown: rows.length.toLocaleString("en"),
						total: columns.length.toLocaleString("en"),
					})}
				</p>
			) : null}
			<div className="max-h-96 overflow-y-auto">
				<Table aria-label={t(M.sample)}>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.sampleKey)}</Table.Head>
							<Table.Head>{t(M.sampleValues)}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{rows.map((column) => (
							<Table.Row key={column.key}>
								<Table.Cell>
									<span className="block max-w-xs truncate font-mono" title={column.key}>
										{column.key}
									</span>
								</Table.Cell>
								<Table.Cell>
									<ul className="flex flex-wrap gap-2">
										{column.values.slice(0, VALUES_SHOWN).map((value, i) => {
											const text = shown(value);
											return text === null ? null : (
												// biome-ignore lint/suspicious/noArrayIndexKey: one value per sampled record, in order.
												<li key={i} className="max-w-xs truncate">
													{text}
												</li>
											);
										})}
									</ul>
								</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table>
			</div>
		</section>
	);
}
