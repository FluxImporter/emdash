import type { Msg } from "../i18n.js";

/** The field widgets' messages (preflight F11). */
export const M = {
	importId: { id: "fluximporter.field.import-id", message: "Import ID" },
	noImportId: { id: "fluximporter.field.no-import-id", message: "No import ID" },
} satisfies Record<string, Msg>;
