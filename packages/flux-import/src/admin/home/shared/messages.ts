import type { Msg } from "../../i18n.js";

/** Messages the home's tabs share: dialogs and time labels. */
export const M = {
	cancel: { id: "flux-import.home-shared.cancel", message: "Cancel" },
	today: { id: "flux-import.home-shared.today", message: "today {time}" },
	yesterday: { id: "flux-import.home-shared.yesterday", message: "yesterday {time}" },
} satisfies Record<string, Msg>;
