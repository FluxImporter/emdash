/** Source rows: `sku` is the key, `Handle` the slug, the rest map to title, price and released. */
export function productsCsv(n: number, price: (i: number) => string = (i) => `${i}.5`): string {
	let out = "sku,Name,Price,Released,Handle\r\n";
	for (let i = 0; i < n; i++) {
		const day = String((i % 28) + 1).padStart(2, "0");
		out += `SKU-${i},"Product ${i}, ""quoted""",${price(i)},${day}/03/2026,product-${i}\r\n`;
	}
	return out;
}

/**
 * Two good rows, a short row, a bad number, a good row, then a quote that never closes: the job
 * logs the bad rows, imports the good ones and fails at the unreadable tail.
 */
export const MALFORMED_CSV =
	"sku,Name,Price,Released,Handle\n" +
	"M-1,One,1,01/03/2026,m-1\n" +
	"M-2,Two,2,02/03/2026,m-2\n" +
	"M-3,Short row\n" +
	"M-4,Four,not-a-number,04/03/2026,m-4\n" +
	"M-5,Five,5,05/03/2026,m-5\n" +
	'M-6,"Six never closes,6,06/03/2026,m-6\n';

export function template(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "sku" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			released: { from: "Released", type: "date", format: "dd/MM/yyyy", tz: "Europe/Chisinau" },
		},
	};
}
