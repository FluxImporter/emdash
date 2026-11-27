import { Banner } from "@cloudflare/kumo";
import type { Fence } from "../../../emdash/fence.js";
import { useT } from "../../i18n.js";
import { LockSimpleIcon } from "../../ui/icons.js";
import { FENCE_MESSAGES, M } from "./messages.js";

/**
 * Why scheduled runs stand down (plan Ruling 8), above the summary line (Schedules.dc.html):
 * one sentence for each kind of fence. Nothing while the site is clear, nor during a site import,
 * which the home itself shows for the whole page. A kind this version does not know reads as the
 * failed check.
 */
export function FenceBanner(props: { fence: Fence }) {
	const t = useT();
	if (props.fence === "clear" || props.fence === "import") return null;
	const kind = Object.hasOwn(FENCE_MESSAGES, props.fence)
		? (props.fence as keyof typeof FENCE_MESSAGES)
		: "error";
	return (
		<Banner
			variant="alert"
			role="status"
			icon={<LockSimpleIcon aria-hidden="true" />}
			title={t(FENCE_MESSAGES[kind])}
			description={t(kind === "error" ? M.fenceCheckWait : M.fenceWait)}
		/>
	);
}
