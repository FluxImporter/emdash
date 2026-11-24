import type { Msg } from "../i18n.js";

/** The field widgets' messages (preflight F11). */
export const M = {
	importId: { id: "flux-import.field.import-id", message: "Import ID" },
	noImportId: { id: "flux-import.field.no-import-id", message: "No import ID" },
} satisfies Record<string, Msg>;
