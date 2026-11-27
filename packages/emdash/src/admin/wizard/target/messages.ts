import type { Msg } from "../../i18n.js";

/** The Target step's messages. */
export const M = {
	loading: { id: "fluximporter.target.loading", message: "Reading the site's collections" },
	collection: { id: "fluximporter.target.collection", message: "Collection" },
	collectionPlaceholder: {
		id: "fluximporter.target.collection-placeholder",
		message: "Choose a collection",
	},
	hiddenCollection: { id: "fluximporter.target.hidden-collection", message: "{label} (hidden)" },
	clearsMapping: {
		id: "fluximporter.target.clears-mapping",
		message: "Changing the collection clears the mapping.",
	},
	locale: { id: "fluximporter.target.locale", message: "Locale" },
	onlyLocale: { id: "fluximporter.target.only-locale", message: "Locale: {locale}" },
	translates: {
		id: "fluximporter.target.translates",
		message: "These records translate entries in",
	},
	translationLocale: {
		id: "fluximporter.target.translation-locale",
		message: "Locale of the original entries",
	},
	translationHint: {
		id: "fluximporter.target.translation-hint",
		message:
			"On the next step, map the source key that names each record's original entry to Translation of.",
	},
	noCollections: { id: "fluximporter.target.no-collections", message: "No collections" },
	noCollectionsHint: {
		id: "fluximporter.target.no-collections-hint",
		message: "This site has no collection to import into. Create one, then come back.",
	},
	chooseCollection: {
		id: "fluximporter.target.choose-collection",
		message: "Choose a collection to import into",
	},
	staleLocale: {
		id: "fluximporter.target.stale-locale",
		message: "{locale} is not one of this site's locales. Choose another.",
	},
} satisfies Record<string, Msg>;
