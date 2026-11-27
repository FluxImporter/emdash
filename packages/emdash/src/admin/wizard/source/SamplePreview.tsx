import { Empty, Table } from "@cloudflare/kumo";
import type { SourceFormat } from "../../../sources/reader.js";
import { type Msg, useT, useTn } from "../../i18n.js";
import { KEYS_SHOWN } from "../../limits.js";
import type { SampleColumn } from "../../types.js";
import { type LooksLike, looksLike } from "../map/new-fields/infer.js";
import { COUNT, M } from "./messages.js";

const LOOKS: Readonly<Record<LooksLike, Msg>> = {
	text: M.looksText,
	number: M.looksNumber,
	date: M.looksDate,
};

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
	const tn = useTn();
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
	const records = columns[0]?.values.length ?? 0;
	// Read from every sampled value, not only the ones shown.
	const looksOf = (column: SampleColumn) => {
		const looks = looksLike(column.values);
		return looks === null ? null : t(LOOKS[looks]);
	};
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-semibold">{t(M.sample)}</h3>
				<p className="text-sm text-kumo-default">
					{records > VALUES_SHOWN
						? tn(COUNT.firstValues, records, { shown: VALUES_SHOWN })
						: tn(COUNT.records, records)}
				</p>
			</div>
			{columns.length > rows.length ? (
				<p className="text-sm text-kumo-default">
					{t(M.keysShown, {
						shown: rows.length.toLocaleString("en"),
						total: columns.length.toLocaleString("en"),
					})}
				</p>
			) : null}
			<div className="max-h-96 overflow-y-auto rounded-lg border border-kumo-hairline bg-kumo-base">
				<Table aria-label={t(M.sample)}>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(M.sampleKey)}</Table.Head>
							<Table.Head>{t(M.sampleLooks)}</Table.Head>
							<Table.Head>{t(M.sampleValues)}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{rows.map((column) => (
							<Table.Row key={column.key}>
								<Table.Cell>
									<code
										className="block max-w-xs truncate font-mono text-sm font-medium"
										title={column.key}
									>
										{column.key}
									</code>
								</Table.Cell>
								<Table.Cell className="whitespace-nowrap text-sm text-kumo-subtle">
									{looksOf(column)}
								</Table.Cell>
								<Table.Cell>
									<ul className="flex flex-wrap gap-1.5">
										{column.values.slice(0, VALUES_SHOWN).map((value, i) => {
											const text = shown(value);
											return text === null ? null : (
												<li
													// biome-ignore lint/suspicious/noArrayIndexKey: one value per sampled record, in order.
													key={i}
													className="max-w-xs truncate rounded bg-kumo-recessed px-1.5 font-mono text-xs"
												>
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
