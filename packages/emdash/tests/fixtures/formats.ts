/**
 * JSON, JSON Lines and XML fixtures for unit and integration tests. Every format carries the same
 * products as `productsCsv` (tests/integration/fixtures.ts) and maps them to the same fields:
 * `title` (text), `price` (number) and `released` (date).
 */
export interface Product {
	sku: string;
	name: string;
	price: number;
	released: string;
	handle: string;
}

export function product(i: number): Product {
	const day = String((i % 28) + 1).padStart(2, "0");
	return {
		sku: `SKU-${i}`,
		name: `Product ${i}, "quoted" & <tagged> ț`,
		price: i + 0.5,
		released: `2026-03-${day}`,
		handle: `product-${i}`,
	};
}

function jsonProduct(p: Product): string {
	return JSON.stringify({
		sku: p.sku,
		name: p.name,
		price: { amount: p.price, currency: "EUR" },
		released: p.released,
		handle: p.handle,
	});
}

const products = (n: number) => Array.from({ length: n }, (_, i) => product(i));

/**
 * A JSON array of products. `wrapped` puts it at `data.products` after keys whose values hold
 * brackets inside strings and a decoy `data.products` path.
 */
export function productsJson(n: number, opts: { wrapped?: boolean } = {}): string {
	const array = `[\n${products(n).map(jsonProduct).join(",\n")}\n]`;
	if (!opts.wrapped) return array;
	return `{"meta": {"note": "brackets ] } [ { in a string", "data": {"products": "decoy"}},\n"data": {"products": ${array}}}\n`;
}

export function productsJsonl(n: number): string {
	return `${products(n).map(jsonProduct).join("\r\n")}\r\n`;
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function xmlProduct(p: Product): string {
	return (
		`  <item sku="${p.sku}">` +
		`<title lang="en">${xmlText(p.name)}</title>` +
		`<price currency="EUR">${p.price}</price>` +
		`<released>${p.released}</released>` +
		`<handle><![CDATA[${p.handle}]]></handle>` +
		"</item>\n"
	);
}

export function productsXml(n: number): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<feed>\n${products(n).map(xmlProduct).join("")}</feed>\n`;
}

const DATE = { type: "date", tz: "Europe/Chisinau" } as const;

export function jsonTemplate(
	collection: string,
	source: Record<string, string> = { format: "json" },
) {
	return {
		version: 1,
		collection,
		locale: "en",
		source,
		key: { from: "sku" },
		slug: { from: "handle" },
		fields: {
			title: { from: "name", type: "text" },
			price: { from: "price.amount", type: "number" },
			released: { from: "released", ...DATE },
		},
	};
}

export function xmlTemplate(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format: "xml", records: "feed/item" },
		key: { from: "@sku" },
		slug: { from: "handle" },
		fields: {
			title: { from: "title", type: "text" },
			price: { from: "price", type: "number" },
			released: { from: "released", ...DATE },
		},
	};
}

/**
 * Per format: M-1, M-2 and M-6 import; M-3 has a bad number, M-4 does not parse
 * (`invalid_record`), M-5 maps an object to a text field (`not_scalar`). JSON and XML then
 * break off (`source_syntax`); JSON Lines has no structure to break, so its job completes.
 */
export const MALFORMED = {
	json:
		"[\n" +
		'{"sku": "M-1", "name": "One", "price": {"amount": 1}, "released": "2026-03-01", "handle": "m-1"},\n' +
		'{"sku": "M-2", "name": "Two", "price": {"amount": 2}, "released": "2026-03-02", "handle": "m-2"},\n' +
		'{"sku": "M-3", "name": "Three", "price": {"amount": "n/a"}, "released": "2026-03-03", "handle": "m-3"},\n' +
		'{"sku": "M-4", "name": "Four", "price": {"amount": 4}, broken},\n' +
		'{"sku": "M-5", "name": {"first": "Fi", "last": "ve"}, "price": {"amount": 5}, "released": "2026-03-05", "handle": "m-5"},\n' +
		'{"sku": "M-6", "name": "Six", "price": {"amount": 6}, "released": "2026-03-06", "handle": "m-6"},\n' +
		'{"sku": "M-7", "name": "Seven never closes',
	jsonl:
		'{"sku": "M-1", "name": "One", "price": {"amount": 1}, "released": "2026-03-01", "handle": "m-1"}\n' +
		'{"sku": "M-2", "name": "Two", "price": {"amount": 2}, "released": "2026-03-02", "handle": "m-2"}\n' +
		'{"sku": "M-3", "name": "Three", "price": {"amount": "n/a"}, "released": "2026-03-03", "handle": "m-3"}\n' +
		'{"sku": "M-4", "name": "Four", broken\n' +
		'{"sku": "M-5", "name": {"first": "Fi", "last": "ve"}, "price": {"amount": 5}, "released": "2026-03-05", "handle": "m-5"}\n' +
		'{"sku": "M-6", "name": "Six", "price": {"amount": 6}, "released": "2026-03-06", "handle": "m-6"}\n',
	xml:
		"<feed>\n" +
		'<item sku="M-1"><title>One</title><price>1</price><released>2026-03-01</released><handle>m-1</handle></item>\n' +
		'<item sku="M-2"><title>Two</title><price>2</price><released>2026-03-02</released><handle>m-2</handle></item>\n' +
		'<item sku="M-3"><title>Three</title><price>n/a</price><released>2026-03-03</released><handle>m-3</handle></item>\n' +
		'<item sku="M-4"><title>Four&nbsp;</title><price>4</price></item>\n' +
		'<item sku="M-5"><title><b>Fi</b>ve</title><price>5</price><released>2026-03-05</released><handle>m-5</handle></item>\n' +
		'<item sku="M-6"><title>Six</title><price>6</price><released>2026-03-06</released><handle>m-6</handle></item>\n' +
		'<item sku="M-7"><title>Seven never closes</feed>\n',
} as const;

/** The record outcomes the malformed fixtures give, in order. */
export const MALFORMED_OUTCOMES = [
	["created", undefined],
	["created", undefined],
	["failed", "invalid_number"],
	["failed", "invalid_record"],
	["failed", "not_scalar"],
	["created", undefined],
] as const;

/**
 * Per format: a `source.filter` that keeps products 4 and up (price 4.5 and more) and an `expr`
 * that computes `title` as "<sku> / <name>". Expressions see the record the reader produces: CSV
 * cells are strings, so the CSV filter converts the price; XML `title` and `price` carry
 * attributes, so they are objects with `#text`.
 */
export const SELECTION = {
	csv: { filter: "$number(Price) > 4", title: "sku & ' / ' & Name" },
	json: { filter: "price.amount > 4", title: "sku & ' / ' & name" },
	jsonl: { filter: "price.amount > 4", title: "sku & ' / ' & name" },
	xml: {
		filter: "$number(price.`#text`) > 4",
		title: "`@sku` & ' / ' & title.`#text`",
	},
} as const;

/** `template` with its format's `SELECTION` filter and `title` expression. */
export function withSelection<T extends { source?: Record<string, string>; fields: object }>(
	template: T,
	format: keyof typeof SELECTION,
) {
	const { filter, title } = SELECTION[format];
	return {
		...template,
		source: { ...(template.source ?? { format: "csv" }), filter },
		fields: { ...template.fields, title: { expr: title, type: "text" } },
	};
}
