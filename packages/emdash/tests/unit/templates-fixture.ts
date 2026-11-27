/**
 * Shared helpers for the M6a saved-template unit tests, and the template service over the fakes:
 * a products and a posts collection, English and French.
 */
import { resolveSiteLocale, resolveTranslationLocale } from "../../src/emdash/locale.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { LinkRow } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { ServiceError } from "../../src/plugin/service.js";
import type { SavedTemplate, TemplateDeps } from "../../src/plugin/templates.js";
import { FakeContent, FakeLookups, MemoryKv } from "./fakes.js";

/** The ServiceError `p` rejects with; anything else is rethrown, and a fulfilled `p` fails. */
export async function failure(p: Promise<unknown>): Promise<ServiceError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not fail");
}

export const PRODUCTS: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];

export const productTemplate = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
	...extra,
});

const i18n = { defaultLocale: "en", locales: ["en", "fr"] };

export function templateSetup(opts: { collections?: Record<string, SchemaField[]> } = {}) {
	const clock = { t: Date.parse("2026-11-16T10:00:00Z") };
	const collections = opts.collections ?? {
		products: PRODUCTS,
		posts: [{ slug: "title", type: "string" }],
	};
	let id = 0;
	const lookups = new FakeLookups(new FakeContent());
	const templates = new MemoryKv<SavedTemplate>(STORAGE.templates.indexes);
	const links = new MemoryKv<LinkRow>(STORAGE.links.indexes);
	const deps: TemplateDeps = {
		templates,
		links,
		lookups,
		lookupFields: async (collection) => collections[collection] ?? null,
		resolveLocale: (locale) => resolveSiteLocale(locale, i18n),
		resolveTranslation: (source, locale) => resolveTranslationLocale(source, locale, i18n),
		siteTimezone: async () => "UTC",
		now: () => clock.t,
		newId: () => `T${String(++id).padStart(4, "0")}`,
	};
	return { deps, clock, lookups, templates, links };
}

/** A link row as the import writes it, with only the fields the owner query reads. */
export const ownedLink = (owner: string, locale = "en", collection = "products") =>
	({ owner, collection, locale, entryId: `e-${owner}-${locale}` }) as LinkRow;
