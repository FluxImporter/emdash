import { Button, Collapsible } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
	const { announce, focusHeading } = useHome();
	const client = useQueryClient();
	const query = useDryRuns();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const items = query.data?.items ?? [];
	const more = query.data?.cursor !== undefined;
	const shown = items.length > 0 || confirming;

	// The line going (all cleared, or its dialog closed over an emptied list) takes the focused
	// "Clear dry runs" button or dialog with it: focus goes to the tab's heading, not the page. Only
	// focus that was lost moves; focus the person put elsewhere meanwhile stays.
	const wasShown = useRef(shown);
	useEffect(() => {
		const lost = document.activeElement === null || document.activeElement === document.body;
		if (wasShown.current && !shown && lost) focusHeading();
		wasShown.current = shown;
	}, [shown, focusHeading]);

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
	const dialog = (
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
	);
	// A clear that failed after emptying the list keeps its dialog, and its failure, open: in the
	// same place in the tree, so it is not mounted again (with its focus) as the line goes.
	if (!shown) return null;
	return (
		<section className="space-y-2">
			{items.length === 0 ? null : (
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
			)}
			{dialog}
		</section>
	);
}
