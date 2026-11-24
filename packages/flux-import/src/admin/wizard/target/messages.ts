import type { Msg } from "../../i18n.js";

/** The Target step's messages. */
export const M = {
	loading: { id: "flux-import.target.loading", message: "Reading the site's collections" },
	collection: { id: "flux-import.target.collection", message: "Collection" },
	collectionPlaceholder: {
		id: "flux-import.target.collection-placeholder",
		message: "Choose a collection",
	},
	hiddenCollection: { id: "flux-import.target.hidden-collection", message: "{label} (hidden)" },
	clearsMapping: {
		id: "flux-import.target.clears-mapping",
		message: "Changing the collection clears the mapping.",
	},
	locale: { id: "flux-import.target.locale", message: "Locale" },
	onlyLocale: { id: "flux-import.target.only-locale", message: "Locale: {locale}" },
	translates: {
		id: "flux-import.target.translates",
		message: "These records translate entries in",
	},
	translationLocale: {
		id: "flux-import.target.translation-locale",
		message: "Locale of the original entries",
	},
	translationHint: {
		id: "flux-import.target.translation-hint",
		message:
			"On the next step, map the source key that names each record's original entry to Translation of.",
	},
	noCollections: { id: "flux-import.target.no-collections", message: "No collections" },
	noCollectionsHint: {
		id: "flux-import.target.no-collections-hint",
		message: "This site has no collection to import into. Create one, then come back.",
	},
	chooseCollection: {
		id: "flux-import.target.choose-collection",
		message: "Choose a collection to import into",
	},
	staleLocale: {
		id: "flux-import.target.stale-locale",
		message: "{locale} is not one of this site's locales. Choose another.",
	},
} satisfies Record<string, Msg>;
