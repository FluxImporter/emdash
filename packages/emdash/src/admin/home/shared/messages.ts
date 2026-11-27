import type { Msg } from "../../i18n.js";

/** Messages the home's tabs share: dialogs and time labels. */
export const M = {
	cancel: { id: "fluximporter.home-shared.cancel", message: "Cancel" },
	today: { id: "fluximporter.home-shared.today", message: "Today {time} UTC" },
	yesterday: { id: "fluximporter.home-shared.yesterday", message: "Yesterday {time} UTC" },
	dated: { id: "fluximporter.home-shared.dated", message: "{date} {time} UTC" },
} satisfies Record<string, Msg>;
