import type { Msg } from "./i18n.js";

/** The admin entry's own messages, for the placeholder page until the wizard replaces it. */
export const M = {
	pageTitle: { id: "flux-import.shell.page-title", message: "Import" },
} satisfies Record<string, Msg>;
