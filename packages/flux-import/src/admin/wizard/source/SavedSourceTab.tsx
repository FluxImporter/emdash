import { Button, Empty, Loader } from "@cloudflare/kumo";
import { api } from "../../api.js";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { useAllSources } from "../../queries.js";
import { M } from "./messages.js";
import { formatOfUrl } from "./SourceSettings.js";
import type { TabProps } from "./SourceStep.js";

/** A URL's host and path: its query may hold a key, so it is never shown. */
function shownUrl(text: string): string {
	try {
		const url = new URL(text);
		return `${url.host}${url.pathname}`;
	} catch {
		return "";
	}
}

/** Saved source: `sources/list`, then `sources/fetch { id }` for the one picked. */
export function SavedSourceTab({ busy, run, pick }: TabProps) {
	const t = useT();
	const sources = useAllSources();
	if (sources.isPending) return <Loader aria-label={t(M.loadingSources)} />;
	if (sources.isError) {
		const { msg, values } = describeError(sources.error);
		return (
			<p role="alert" className="text-kumo-danger">
				{t(msg, values)}
			</p>
		);
	}
	if (sources.data.length === 0) {
		return <Empty size="sm" title={t(M.noSources)} description={t(M.noSourcesHint)} />;
	}
	return (
		<ul className="divide-y divide-kumo-line">
			{sources.data.map((row) => (
				<li key={row.id} className="flex items-center justify-between gap-3 py-2">
					<div className="min-w-0">
						<p className="truncate font-medium" title={row.name}>
							{row.name}
						</p>
						<p className="truncate text-sm text-kumo-subtle">{shownUrl(row.url)}</p>
					</div>
					<Button
						variant="secondary"
						disabled={busy}
						aria-label={t(M.useSource, { name: row.name })}
						onClick={() =>
							run(async () => {
								const { uploadId } = await api.fetchSource({ id: row.id });
								await pick({ kind: "saved", uploadId, label: row.name }, formatOfUrl(row.url));
							})
						}
					>
						{t(M.use)}
					</Button>
				</li>
			))}
		</ul>
	);
}
