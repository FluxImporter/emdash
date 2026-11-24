import type { Msg } from "./i18n.js";

/** The admin's shared messages: the page title, and the one "Try again" every retry uses. */
export const M = {
	pageTitle: { id: "flux-import.shell.page-title", message: "Import" },
	tryAgain: { id: "flux-import.common.try-again", message: "Try again" },
} satisfies Record<string, Msg>;
