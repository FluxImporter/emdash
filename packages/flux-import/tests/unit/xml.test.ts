import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, SourceError } from "../../src/sources/reader.js";
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

describe("parseXmlRecordText", () => {
	it("keeps keys as own properties", () => {
		const value = parseXmlRecordText("<item><__proto__>x</__proto__></item>") as object;
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.keys(value)).toEqual(["__proto__"]);
	});

	it("keeps mixed text and normalises line endings", () => {
		expect(parseXmlRecordText("<item>a\r\n<b>x</b>c</item>")).toEqual({ b: "x", "#text": "a\nc" });
	});
});
