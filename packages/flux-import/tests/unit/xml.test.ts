import { describe, expect, it } from "vitest";
import { MAX_NESTING, MAX_RECORD_BYTES, SourceError } from "../../src/sources/reader.js";
import { xmlReader } from "../../src/sources/xml.js";
import { parseXmlRecordText } from "../../src/sources/xml-record.js";
import { expectReaderInvariants, readAll, streamOf } from "./helpers.js";

const FEED =
	"﻿<?xml version='1.0' encoding=\"UTF-8\"?>\r\n" +
	"<!DOCTYPE feed>\n" +
	'<!-- <item sku="commented">no</item> -->\n' +
	"<?app note?>\n" +
	'<feed version="2">\n' +
	'  <meta note="a > b /> c"/>\n' +
	'  <item sku="A1" note=\'say "hi" > bye\'>\n' +
	'    <title lang="ro">Ș, ț &amp; &lt;b&gt; &#233;&#x1F680; 日本</title>\n' +
	"    <price>12.50</price>\n" +
	"    <!-- a comment with </item> inside -->\n" +
	"    <body><![CDATA[<p>raw </item> & text</p>]]></body>\n" +
	"    <images><image>a.jpg</image><image>b.jpg</image></images>\n" +
	"    <?pi ignored?>\n" +
	"  </item>\n" +
	'  <item sku="B2"/>\n' +
	"  <other><item>not a record: wrong depth</item></other>\n" +
	"  <item>Plain text</item>\n" +
	"  <item sku='C3'><empty/><flag on=\"yes\"/></item>\n" +
	"</feed>\n" +
	"<!-- after the root -->\n";

const values = (recs: { value: unknown }[]) => recs.map((r) => r.value);

describe("xmlReader", () => {
	it("finds record elements and keeps every invariant", async () => {
		const recs = await expectReaderInvariants(xmlReader("feed/item"), FEED);
		expect(values(recs)).toEqual([
			{
				"@sku": "A1",
				"@note": 'say "hi" > bye',
				title: { "@lang": "ro", "#text": "Ș, ț & <b> é🚀 日本" },
				price: "12.50",
				body: "<p>raw </item> & text</p>",
				images: { image: ["a.jpg", "b.jpg"] },
			},
			{ "@sku": "B2" },
			{ "#text": "Plain text" },
			{ "@sku": "C3", empty: "", flag: { "@on": "yes" } },
		]);
		expect(recs.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("locates just after the records' parent start tag", async () => {
		const { bodyOffset } = await xmlReader("feed/item").locate(streamOf(FEED, 1));
		const bytes = new TextEncoder().encode(FEED);
		expect(
			new TextDecoder().decode(bytes.subarray(0, bodyOffset)).endsWith('<feed version="2">'),
		).toBe(true);
	});

	it("follows deeper paths across repeated parents", async () => {
		const rss =
			"<rss><channel><title>One</title><item><t>1</t></item><item><t>2</t></item></channel>" +
			"<junk><channel><item><t>no</t></item></channel></junk>" +
			"<channel><item><t>3</t></item></channel></rss>";
		const recs = await expectReaderInvariants(xmlReader("rss/channel/item"), rss);
		expect(values(recs)).toEqual([{ t: "1" }, { t: "2" }, { t: "3" }]);
	});

	it("reads no records from an empty parent", async () => {
		expect(await readAll(xmlReader("feed/item"), "<feed></feed>")).toEqual([]);
	});

	it.each([
		["an internal subset", '<!DOCTYPE feed [<!ENTITY lol "lol">]><feed/>'],
		["a SYSTEM id", '<!DOCTYPE feed SYSTEM "http://example.test/feed.dtd"><feed/>'],
		["a PUBLIC id", '<!DOCTYPE feed PUBLIC "-//X//EN" "feed.dtd"><feed/>'],
	])("rejects a DOCTYPE with %s before reading records", async (_name, input) => {
		await expect(xmlReader("feed/item").locate(streamOf(input, 1))).rejects.toMatchObject({
			code: "xml_dtd_not_allowed",
		});
	});

	it("rejects another declared encoding and UTF-16", async () => {
		const latin = '<?xml version="1.0" encoding="ISO-8859-1"?><feed></feed>';
		await expect(xmlReader("feed/item").locate(streamOf(latin))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
		const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00]);
		await expect(xmlReader("feed/item").locate(streamOf(utf16))).rejects.toMatchObject({
			code: "unsupported_encoding",
		});
	});

	it("fails only the record that is not well-formed", async () => {
		const input =
			"<feed>" +
			'<item sku="1"><t>ok</t></item>' +
			"<item sku=2><t>unquoted</t></item>" +
			'<item a="1" a="2"/>' +
			"<item><t>&nbsp;</t></item>" +
			"<item><t>a & b</t></item>" +
			'<item sku="5"/>' +
			"</feed>";
		const recs = await expectReaderInvariants(xmlReader("feed/item"), input);
		expect(recs.map((r) => r.error?.code ?? r.value)).toEqual([
			{ "@sku": "1", t: "ok" },
			"invalid_record",
			"invalid_record",
			"invalid_record",
			"invalid_record",
			{ "@sku": "5" },
		]);
		expect(recs[3]!.error?.message).toMatch(/Unknown entity &nbsp;/);
	});

	it.each([
		["a mismatched end tag", '<feed><item sku="1"/><item><a></b></item></feed>', 30],
		["an unterminated record", '<feed><item sku="1"/><item><a>open', 21],
		["an unterminated comment", "<feed><!-- open", 6],
		["a DOCTYPE inside the document", "<feed><!DOCTYPE x></feed>", 6],
	])("fails the job with source_syntax for %s", async (_name, input, offset) => {
		const error = await readAll(xmlReader("feed/item"), input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax", offset });
	});

	it.each([
		["another root element", "rss/item", "<feed></feed>", /root element is <feed>, not <rss>/],
		["a missing parent", "rss/channel/item", "<rss><item/></rss>", /no <rss\/channel> element/],
		["text instead of XML", "feed/item", '[{"a": 1}]', /Text before the root/],
		["an empty root", "feed/item", "<feed/>", /empty/],
	])("fails locate for %s", async (_name, records, input, message) => {
		const error = await xmlReader(records)
			.locate(streamOf(input))
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceError);
		expect((error as SourceError).message).toMatch(message);
	});

	it("fails a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const input = `<feed><item/><item>${"x".repeat(MAX_RECORD_BYTES)}</item></feed>`;
		await expect(readAll(xmlReader("feed/item"), input)).rejects.toMatchObject({
			code: "source_syntax",
			offset: 13,
		});
	});

	it("samples records and their field paths", async () => {
		const sample = await xmlReader("feed/item").sample(streamOf(FEED), 20);
		expect(sample.records).toHaveLength(4);
		expect(sample.paths).toEqual([
			"@sku",
			"@note",
			"title",
			"title/@lang",
			"price",
			"body",
			"images/image",
			"empty",
			"flag",
			"flag/@on",
		]);
	});
});

describe("xmlReader on malformed structure", () => {
	/** "syntax" = fails the job; otherwise exactly these per-record outcomes (never fewer records). */
	const cases: [string, string, "syntax" | (object | "invalid_record")[]][] = [
		[
			"an attribute value containing > and /",
			'<feed><item note="a > b /> c"/><item note="x"/></feed>',
			[{ "@note": "a > b /> c" }, { "@note": "x" }],
		],
		[
			"an unclosed attribute quote",
			'<feed><item a="1><t>x</t></item><item b="2"/></feed>',
			"syntax",
		],
		["a stray < followed by a space in text", "<feed><item>a < b</item><item/></feed>", "syntax"],
		["a stray < before a name in text", "<feed><item>a <b</item><item/></feed>", "syntax"],
		["a stray < between records", "<feed><item/><<item/></feed>", "syntax"],
		["an unclosed comment in a record", "<feed><item><!-- x</item><item/></feed>", "syntax"],
		["an unclosed comment between records", "<feed><item/><!-- x<item/></feed>", "syntax"],
		["an unclosed CDATA in a record", "<feed><item><![CDATA[ x</item><item/></feed>", "syntax"],
		["an unclosed CDATA between records", "<feed><item/><![CDATA[ x<item/></feed>", "syntax"],
		["a mismatched end tag in a record", "<feed><item><a></b></item><item/></feed>", "syntax"],
		[
			"the records parent closing inside a record",
			"<feed><item><a></feed><item><t>2</t></item></feed>",
			"syntax",
		],
		["a second parent end tag", "<feed><item/></feed></feed>", "syntax"],
		["records after the root closed", "<feed><item/></feed><item/>", "syntax"],
		["a second root element", "<feed><item/></feed><feed><item/></feed>", "syntax"],
		["text after the root", "<feed><item/></feed>trailing", "syntax"],
		[
			"a well-formed wrong record next to good ones",
			"<feed><item><a>1</a></item><item><a>&bad;</a></item><item/></feed>",
			[{ a: "1" }, "invalid_record", {}],
		],
	];

	it.each(cases)("never loses records silently for %s", async (_name, input, expected) => {
		for (const chunkSize of [1, 1 << 16]) {
			const outcome = await readAll(xmlReader("feed/item"), input, chunkSize).then(
				(recs) => recs.map((r) => r.error?.code ?? r.value),
				(e: unknown) => e,
			);
			if (expected === "syntax") {
				expect(outcome).toBeInstanceOf(SourceError);
				expect(outcome).toMatchObject({ code: "source_syntax" });
			} else {
				expect(outcome).toEqual(expected);
			}
		}
	});
});

describe("xmlReader hardening", () => {
	const locateError = (input: string) =>
		xmlReader("feed/item")
			.locate(streamOf(input, 1))
			.catch((e: unknown) => e);

	it.each([
		[
			"spaces before the external id",
			`<!DOCTYPE${" ".repeat(1100)}feed SYSTEM "x.dtd"><feed><item/></feed>`,
		],
		[
			"a long root name before SYSTEM",
			`<!DOCTYPE ${"f".repeat(1100)} SYSTEM "x.dtd"><feed><item/></feed>`,
		],
	])("rejects a DOCTYPE padded past the cap: %s", async (_name, input) => {
		expect(await locateError(input)).toMatchObject({ code: "xml_dtd_not_allowed" });
	});

	it.each(["US-ASCII", "ascii", "utf8", "UTF-8"])("accepts the %s declaration", async (enc) => {
		const input = `<?xml version="1.0" encoding="${enc}"?><feed><item a="1"/></feed>`;
		expect((await readAll(xmlReader("feed/item"), input)).map((r) => r.value)).toEqual([
			{ "@a": "1" },
		]);
	});

	it.each([
		["before the root", "<![CDATA[x]]><feed><item/></feed>"],
		["after the root", "<feed><item/></feed><![CDATA[x]]>"],
	])("rejects CDATA %s", async (_name, input) => {
		for (const size of [1, 1 << 16]) {
			expect(
				await readAll(xmlReader("feed/item"), input, size).catch((e: unknown) => e),
			).toMatchObject({
				code: "source_syntax",
			});
		}
	});

	it("keeps non-breaking space text", async () => {
		const recs = await readAll(
			xmlReader("feed/item"),
			"<feed><item>&#160;</item><item> \n</item></feed>",
		);
		expect(recs.map((r) => r.value)).toEqual([{ "#text": "\u00a0" }, {}]);
	});

	it("rejects an invalid structural element name instead of skipping it", async () => {
		const input = "<feed><item=x></item=x><item/></feed>";
		for (const size of [1, 1 << 16]) {
			expect(
				await readAll(xmlReader("feed/item"), input, size).catch((e: unknown) => e),
			).toMatchObject({
				code: "source_syntax",
			});
		}
	});

	it.each(["<@a>x</@a>", "<#text>x</#text>", "<a=b>x</a=b>", "<1a/>"])(
		"fails only the record with invalid child name %s",
		async (child) => {
			const input = `<feed><item>${child}</item><item><ok>1</ok></item></feed>`;
			for (const size of [1, 1 << 16]) {
				const recs = await readAll(xmlReader("feed/item"), input, size);
				expect(recs.map((r) => r.error?.code ?? r.value)).toEqual(["invalid_record", { ok: "1" }]);
			}
		},
	);
});

describe("xmlReader names with combining marks", () => {
	it("resolves a record child with combining marks", async () => {
		const recs = await readAll(
			xmlReader("feed/item"),
			"<feed><item><किताब>5</किताब></item></feed>",
			1,
		);
		expect(recs.map((r) => r.value)).toEqual([{ किताब: "5" }]);
	});

	it.each([
		["Devanagari", "फ़ीड/किताबें", "<फ़ीड><किताबें><a>1</a></किताबें><किताबें/></फ़ीड>"],
		["Thai", "ฟีด/รายการ", "<ฟีด><รายการ><a>1</a></รายการ></ฟีด>"],
	])("reads records of a %s path", async (_name, path, input) => {
		for (const size of [1, 1 << 16]) {
			const recs = await readAll(xmlReader(path), input, size);
			expect(recs[0]?.value).toEqual({ a: "1" });
			expect(recs.every((r) => r.error === undefined)).toBe(true);
		}
	});
});

describe("xmlReader bounds", () => {
	const fail = (input: string, records = "feed/item") =>
		readAll(xmlReader(records), input, 1 << 16).catch((e: unknown) => e);

	it("fails a 100 KB end-tag name with a short source_syntax message", async () => {
		const error = await fail(`<feed><item/></${"a".repeat(100_000)}></feed>`);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax" });
		expect((error as Error).message.length).toBeLessThan(200);
	});

	it("caps an end-tag name outside records like a start tag", async () => {
		const error = await fail(`<feed><item/></${"a".repeat(MAX_RECORD_BYTES + 10)}></feed>`);
		expect(error).toMatchObject({ code: "source_syntax", offset: 13 });
		expect((error as Error).message).toMatch(/larger than/);
	});

	it("keeps long names short in structural messages", async () => {
		const long = "a".repeat(100_000);
		for (const input of [`<${long}><item/></${long}>`, `<feed><item/></feed><${long}/>`]) {
			const error = await fail(input);
			expect(error).toBeInstanceOf(SourceError);
			expect((error as Error).message.length).toBeLessThan(200);
		}
	});

	it("keeps long names short in record messages", async () => {
		const long = "b".repeat(100_000);
		const recs = await readAll(xmlReader("feed/item"), `<feed><item><1${long}/></item></feed>`);
		expect(recs[0]?.error?.code).toBe("invalid_record");
		expect(recs[0]!.error!.message.length).toBeLessThan(200);
	});

	it("reports a bare ampersand in text briefly", async () => {
		const recs = await readAll(
			xmlReader("feed/item"),
			`<feed><item><t>Tom & Jerry ${"x".repeat(5000)};</t></item></feed>`,
		);
		expect(recs[0]?.error?.code).toBe("invalid_record");
		expect(recs[0]!.error!.message.length).toBeLessThan(100);
		expect(recs[0]!.error!.message).toMatch(/"&" must start an entity/);
	});

	it("reports an unknown entity by its name", () => {
		expect(() => parseXmlRecordText("<i>&nbsp;</i>")).toThrow(/Unknown entity &nbsp;/);
	});

	it("fails the job for elements nested deeper than MAX_NESTING outside records", async () => {
		const depth = 2000;
		const input = `<feed>${"<a>".repeat(depth)}${"</a>".repeat(depth)}<item/></feed>`;
		const error = await fail(input);
		expect(error).toBeInstanceOf(SourceError);
		expect(error).toMatchObject({ code: "source_syntax", offset: 6 + 3 * (MAX_NESTING - 1) });
	});

	it("reads elements nested up to MAX_NESTING outside records", async () => {
		const depth = MAX_NESTING - 1;
		const input = `<feed>${"<a>".repeat(depth)}${"</a>".repeat(depth)}<item/></feed>`;
		expect(await readAll(xmlReader("feed/item"), input)).toHaveLength(1);
	});
});

describe("parseXmlRecordText", () => {
	it("keeps keys as own properties", () => {
		const value = parseXmlRecordText("<item><__proto__>x</__proto__></item>") as object;
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.keys(value)).toEqual(["__proto__"]);
	});

	it("keeps mixed text and normalises line endings", () => {
		expect(parseXmlRecordText("<item>a\r\n<b>x</b>c</item>")).toEqual({ b: "x", "#text": "a\nc" });
	});
	it("keeps whitespace-only text beside attributes only when asked", async () => {
		const xml = '<row r="1"><t xml:space="preserve"> </t><v> </v></row>';
		expect(parseXmlRecordText(xml)).toEqual({ "@r": "1", t: { "@xml:space": "preserve" }, v: " " });
		expect(parseXmlRecordText(xml, true)).toEqual({
			"@r": "1",
			t: { "@xml:space": "preserve", "#text": " " },
			v: " ",
		});
		const doc = `<sheetData>${xml}</sheetData>`;
		expect(values(await readAll(xmlReader("sheetData/row"), doc))).toEqual([
			{ "@r": "1", t: { "@xml:space": "preserve" }, v: " " },
		]);
		expect(values(await readAll(xmlReader("sheetData/row", true), doc))).toEqual([
			{ "@r": "1", t: { "@xml:space": "preserve", "#text": " " }, v: " " },
		]);
	});
});
