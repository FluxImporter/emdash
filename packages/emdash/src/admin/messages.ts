import type { Msg } from "./i18n.js";

/** The admin's shared messages: the page title, and the one "Try again" every retry uses. */
export const M = {
	pageTitle: { id: "fluximporter.shell.page-title", message: "New import" },
	tryAgain: { id: "fluximporter.common.try-again", message: "Try again" },
} satisfies Record<string, Msg>;
