import { Banner, Button, Empty, Loader, SkeletonLine } from "@cloudflare/kumo";
import { describeError } from "../errors.js";
import { useT } from "../i18n.js";
import { M as PAGE } from "../messages.js";
import { ArrowClockwiseIcon, LockSimpleIcon } from "./icons.js";
import { M } from "./messages.js";

/**
 * The five states every tab shares (States.dc.html). Empty states use Kumo's `Empty` directly,
 * with the tab's own words; the other four are here.
 */

/**
 * Loading: the table's outline with skeleton rows, so the page keeps its shape. `columns` widths
 * are fractions of the row; the first column gets a second, shorter line (the meta line).
 */
export function LoadingRows(props: { label: string; rows?: number; columns?: number }) {
	const rows = props.rows ?? 4;
	const columns = props.columns ?? 3;
	return (
		<div
			role="status"
			aria-label={props.label}
			aria-busy="true"
			className="divide-y divide-kumo-line overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base"
		>
			{Array.from({ length: rows }, (_, row) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
					key={row}
					className="flex items-center gap-4 px-4 py-3"
				>
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<SkeletonLine minWidth={40} maxWidth={70} />
						<SkeletonLine minWidth={20} maxWidth={35} />
					</div>
					{Array.from({ length: columns - 1 }, (_, col) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity.
						<div key={col} className="flex min-w-0 flex-1">
							<SkeletonLine minWidth={30} maxWidth={60} />
						</div>
					))}
				</div>
			))}
		</div>
	);
}

/**
 * Failed to load: what failed, why, that nothing else is affected, and "Try again". A 403 is
 * not shown here: the page shows `Forbidden` instead.
 */
export function LoadFailed(props: {
	title: string;
	error: unknown;
	retrying: boolean;
	onRetry(): void;
}) {
	const t = useT();
	const { msg, values } = describeError(props.error);
	return (
		<Banner
			variant="error"
			role="alert"
			title={props.title}
			description={`${t(msg, values)} ${t(M.failedSafe)}`}
			action={
				<Button
					variant="secondary"
					icon={<ArrowClockwiseIcon aria-hidden="true" />}
					loading={props.retrying}
					// Kumo's spinner is labelled "Loading" in English: the label names the button.
					aria-label={t(PAGE.tryAgain)}
					aria-busy={props.retrying || undefined}
					onClick={props.onRetry}
				>
					{t(PAGE.tryAgain)}
				</Button>
			}
		/>
	);
}

/** 403: replaces the header button and the tabs. */
export function Forbidden() {
	const t = useT();
	return (
		<Empty
			icon={<LockSimpleIcon aria-hidden="true" size={28} />}
			title={t(M.forbiddenTitle)}
			description={t(M.forbiddenText)}
		/>
	);
}

/** A site import is running: the whole home waits, and the page polls until it ends. */
export function SiteImportBanner() {
	const t = useT();
	return (
		<Banner
			variant="default"
			role="status"
			icon={<Loader size="sm" />}
			title={t(M.siteImportTitle)}
			description={t(M.siteImportText)}
		/>
	);
}
