import type { PluginAdminExports } from "emdash";
import { useT } from "./i18n.js";
import { M } from "./messages.js";

/**
 * The admin entry (`flux-import/admin`): EmDash's admin renders each page with no props, inside
 * its own `I18nProvider` and `QueryClientProvider` (Facts V7, V8).
 */

/** A placeholder until the wizard replaces it (M7a Task 15). */
function ImportPage() {
	const t = useT();
	return <h1>{t(M.pageTitle)}</h1>;
}

export const pages: PluginAdminExports["pages"] = { "/import": ImportPage };
