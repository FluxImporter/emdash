import type { Msg } from "../../i18n.js";

/** Messages the home's tabs share: dialogs and time labels. */
export const M = {
	cancel: { id: "flux-import.home-shared.cancel", message: "Cancel" },
	today: { id: "flux-import.home-shared.today", message: "Today {time} UTC" },
	yesterday: { id: "flux-import.home-shared.yesterday", message: "Yesterday {time} UTC" },
	dated: { id: "flux-import.home-shared.dated", message: "{date} {time} UTC" },
} satisfies Record<string, Msg>;
