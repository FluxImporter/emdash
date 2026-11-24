import { Button, Collapsible } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { JobListItem } from "../../../../plugin/summaries.js";
import { api } from "../../../api.js";
import { describeError } from "../../../errors.js";
import { useT } from "../../../i18n.js";
import { queryKeys, useDryRuns } from "../../../queries.js";
import { useHome } from "../../Home.js";
import { ConfirmDialog } from "../../shared/ConfirmDialog.js";
import { When } from "../../shared/When.js";
import { STATUS_MESSAGES } from "../status.js";
import { M } from "./messages.js";

/** Plan Ruling 6: the most calls one "Clear dry runs" makes. */
const MAX_CALLS = 50;

/**
 * The dry runs under the Jobs list: one line, a short list when opened, and "Clear dry runs".
 * Renders nothing without dry runs.
 */
export function DryRuns(props: { names: (item: JobListItem) => string }) {
	const t = useT();
	const { announce } = useHome();
	const client = useQueryClient();
	const query = useDryRuns();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const items = query.data?.items ?? [];
	if (items.length === 0) return null;
	const more = query.data?.cursor !== undefined;

	const close = () => {
		setConfirming(false);
		setError(null);
	};

	async function clear() {
		setBusy(true);
		setError(null);
		let cleared = 0;
		try {
			let cursor: string | undefined;
			for (let calls = 0; calls < MAX_CALLS; calls += 1) {
				const reply = await api.clearDryRuns(cursor === undefined ? {} : { cursor });
				cleared += reply.cleared;
				if (!reply.more) break;
				// A call cut short answers `more` without a cursor: send none, never the previous one.
				cursor = reply.cursor;
			}
		} catch (e) {
			setError(e);
			setBusy(false);
			if (cleared > 0) void client.invalidateQueries({ queryKey: queryKeys.dryRuns });
			return;
		}
		setBusy(false);
		setConfirming(false);
		announce(cleared === 0 ? t(M.none) : t(M.cleared, { count: cleared }));
		void client.invalidateQueries({ queryKey: queryKeys.dryRuns });
	}

	const failure = error === null ? null : describeError(error);
	return (
		<section className="space-y-2">
			<Collapsible.Root>
				<Collapsible.DefaultTrigger>
					{t(more ? M.countMore : M.count, { count: items.length })}
				</Collapsible.DefaultTrigger>
				<Collapsible.DefaultPanel>
					<ul className="space-y-1 py-2 text-sm">
						{items.map((job) => (
							<li key={job.id} className="flex flex-wrap items-center gap-x-3">
								<span className="font-medium">{props.names(job)}</span>
								<span>{t(M.where, { collection: job.collection, locale: job.locale })}</span>
								<When iso={job.createdAt} />
								<span>{t(STATUS_MESSAGES[job.status])}</span>
							</li>
						))}
					</ul>
					<Button variant="secondary" onClick={() => setConfirming(true)}>
						{t(M.clear)}
					</Button>
				</Collapsible.DefaultPanel>
			</Collapsible.Root>
			<ConfirmDialog
				open={confirming}
				title={t(M.clear)}
				sentence={t(M.confirm)}
				confirmLabel={t(M.clear)}
				danger
				busy={busy}
				error={
					failure === null ? null : (
						<p role="alert" className="text-sm text-kumo-danger">
							{t(failure.msg, failure.values)}
						</p>
					)
				}
				onConfirm={() => void clear()}
				onClose={close}
			/>
		</section>
	);
}
