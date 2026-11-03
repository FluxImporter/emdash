/**
 * Schema, sources and templates for the M4e translation imports on the Node and workerd sites
 * (both configure the locales en, fr and de): a revisioned `products` collection with a
 * translatable title and image, non-translatable `sku` and `price`, a reference field and a tag
 * taxonomy; an English template and translation templates that name English keys.
 */
import type { Client, Product } from "../integration/client.js";

export type TranslationNames = { products: string; tag: string };

export function translationNames(prefix: string): TranslationNames {
	return { products: `${prefix}_products`, tag: `${prefix}_tag` };
}

/** Creates the collection (with revisions), its fields and the tag taxonomy with the term `new`. */
export async function createTranslationSchema(client: Client, n: TranslationNames): Promise<void> {
	await client.createCollection(n.products);
	for (const field of [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "sku", label: "SKU", type: "string", translatable: false },
		{ slug: "price", label: "Price", type: "number", translatable: false },
		{ slug: "photo", label: "Photo", type: "image" },
		{
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { targetCollection: n.products, multiple: true },
		},
	]) {
		await client.api("POST", `/_emdash/api/schema/collections/${n.products}/fields`, field);
	}
	await client.api("POST", "/_emdash/api/taxonomies", {
		name: n.tag,
		label: "Tags",
		collections: [n.products],
	});
	await client.api("POST", `/_emdash/api/taxonomies/${n.tag}/terms`, {
		slug: "new",
		label: "New",
		locale: "en",
	});
}

/** English products: every mapping, `related` by import key. */
export function englishTemplate(n: TranslationNames) {
	return {
		version: 1,
		collection: n.products,
		locale: "en",
		key: { from: "id" },
		slug: { from: "handle" },
		fields: {
			title: { from: "Name", type: "text" },
			sku: { from: "SKU", type: "text" },
			price: { from: "Price", type: "number" },
			photo: { from: "Photo", type: "image" },
			related: { from: "Related", type: "reference", match: "key" },
		},
		taxonomies: { [n.tag]: { from: "Tags" } },
	};
}

/**
 * A translation of the English products into `locale`: the same mappings, and `translationOf`
 * from `en_id` in the default locale (left out, so job creation fills it in).
 */
export function translationTemplate(n: TranslationNames, locale: "fr" | "de") {
	return { ...englishTemplate(n), locale, translationOf: { from: "en_id" } };
}

export const ENGLISH_HEADER = "id,handle,Name,SKU,Price,Photo,Related,Tags";
export const TRANSLATION_HEADER = "id,en_id,handle,Name,SKU,Price,Photo,Related,Tags";

/** An English CSV; the first row has `photo`, and every later row is related to the first. */
export function englishCsv(
	rows: [id: string, name: string, sku: string, price: number][],
	photo = "",
): string {
	const lines = rows.map(([id, name, sku, price], i) =>
		[
			id,
			name.toLowerCase(),
			name,
			sku,
			price,
			i === 0 ? photo : "",
			i === 0 ? "" : rows[0]?.[0],
			"new",
		].join(","),
	);
	return [ENGLISH_HEADER, ...lines, ""].join("\n");
}

export type TranslationRow = {
	id: string;
	/** The English key; "" for an entry of its own. */
	enId: string;
	name: string;
	photo?: string;
	sku?: string;
	price?: string;
	related?: string;
	tags?: string;
};

/**
 * A translation CSV. By default the shared columns hold values that must never be written to a
 * linked entry, and would fail a record that reads them: another SKU, a price that is not a
 * number, an unknown reference and an unknown tag.
 */
export function translationCsv(rows: TranslationRow[]): string {
	const lines = rows.map((r) =>
		[
			r.id,
			r.enId,
			r.name.toLowerCase().replaceAll(" ", "-"),
			r.name,
			r.sku ?? "XX",
			r.price ?? "n/a",
			r.photo ?? "",
			r.related ?? "NOPE",
			r.tags ?? "missing",
		].join(","),
	);
	return [TRANSLATION_HEADER, ...lines, ""].join("\n");
}

/** Every entry of the collection in one locale. */
export async function listLocale(client: Client, collection: string, locale: string) {
	const page = await client.api<{ items: Product[] }>(
		"GET",
		`/_emdash/api/content/${collection}?locale=${locale}&limit=100`,
	);
	return page.items;
}

/** The entry's translation group: its ID and the locale of each of its entries, by ID. */
export async function translationsOf(client: Client, collection: string, id: string) {
	const data = await client.api<{
		translationGroup: string;
		translations: { id: string; locale: string }[];
	}>("GET", `/_emdash/api/content/${collection}/${id}/translations`);
	return {
		group: data.translationGroup,
		locales: Object.fromEntries(data.translations.map((t) => [t.locale, t.id])),
	};
}
