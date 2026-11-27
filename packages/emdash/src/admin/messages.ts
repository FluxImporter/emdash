import type { Msg } from "./i18n.js";

/**
 * The admin's shared messages: the page title, the one "Try again" every retry uses, and what a
 * link that opens in a new tab tells screen readers.
 */
export const M = {
	pageTitle: { id: "fluximporter.shell.page-title", message: "New import" },
	tryAgain: { id: "fluximporter.common.try-again", message: "Try again" },
	newTab: { id: "fluximporter.common.new-tab", message: "(opens in a new tab)" },
} satisfies Record<string, Msg>;
