import { Banner } from "@cloudflare/kumo";
import type { Fence } from "../../../emdash/fence.js";
import { useT } from "../../i18n.js";
import { FENCE_MESSAGES } from "./messages.js";

/**
 * Why scheduled runs stand down (plan Ruling 8): one sentence for each kind of fence, nothing
 * while the site is clear. A kind this version does not know reads as the failed check.
 */
export function FenceBanner(props: { fence: Fence }) {
	const t = useT();
	if (props.fence === "clear") return null;
	const msg = Object.hasOwn(FENCE_MESSAGES, props.fence)
		? FENCE_MESSAGES[props.fence]
		: FENCE_MESSAGES.error;
	return <Banner variant="alert" title={t(msg)} />;
}
