/** Templates of an exact JSON size for the M6a size checks (unit, Node and workerd). */

export const utf8Bytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * A CSV template whose JSON, parsed or not (it holds every default), is exactly `bytes` UTF-8
 * bytes: two select mappings (`stage_a`, `stage_b`, from `Stage`) whose maps send padding keys to
 * "live". Each map holds at most 1,000 keys of at most 200 characters, as the schema allows.
 */
export function paddedTemplate(collection: string, bytes: number): Record<string, unknown> {
	const maps: Record<string, string>[] = [{}, {}];
	const template = {
		version: 1,
		source: { format: "csv" },
		collection,
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			stage_a: { from: "Stage", type: "select", map: maps[0] },
			stage_b: { from: "Stage", type: "select", map: maps[1] },
		},
	};
	let n = 0;
	let last = "";
	const mapOf = (i: number) => maps[i < 1000 ? 0 : 1] as Record<string, string>;
	const add = (length: number) => {
		last = `k${n}-`.padEnd(length, "x");
		mapOf(n)[last] = "live";
		n++;
	};
	const widenLast = (by: number) => {
		const map = mapOf(n - 1);
		delete map[last];
		last = last.padEnd(last.length + by, "x");
		map[last] = "live";
	};
	// A 150-character key costs 160 bytes (quotes, colon, "live", comma): the bulk at once.
	const bulk = Math.max(0, Math.floor((bytes - utf8Bytes(template) - 400) / 160));
	for (let i = 0; i < bulk; i++) add(150);
	while (bytes - utf8Bytes(template) > 170) add(150);
	const left = bytes - utf8Bytes(template);
	if (left < 20) {
		widenLast(left);
	} else {
		add(8);
		widenLast(bytes - utf8Bytes(template));
	}
	if (utf8Bytes(template) !== bytes) {
		throw new Error(`paddedTemplate: ${utf8Bytes(template)} bytes, not ${bytes}`);
	}
	return template;
}
