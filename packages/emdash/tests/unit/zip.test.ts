import { describe, expect, it } from "vitest";
import { XlsxError, ZipArchive } from "../../src/sources/zip.js";
import { patchEnd, zip } from "../fixtures/zip.js";

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

async function failure(run: () => unknown): Promise<XlsxError> {
	const error = await (async () => run())().then(
		() => {
			throw new Error("expected a failure");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(XlsxError);
	return error as XlsxError;
}

describe("ZipArchive", () => {
	it("reads stored and deflate entries by exact name", async () => {
		// Over 64 KiB, so it arrives in several chunks; distinct rows keep the ratio realistic.
		const big = Array.from({ length: 10_000 }, (_, i) => `<row r="${i + 1}"/>`).join("");
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{ name: "xl/stored.xml", data: "stored ț", method: 0 },
				{ name: "xl/big.xml", data: big },
			]),
		);
		expect(await text(archive.open("xl/workbook.xml"))).toBe("<workbook/>");
		expect(await text(archive.open("xl/stored.xml"))).toBe("stored ț");
		expect(await text(archive.open("xl/big.xml"))).toBe(big);
		expect(archive.has("xl/workbook.xml")).toBe(true);
		expect(archive.has("XL/workbook.xml")).toBe(false);
		expect((await failure(() => archive.open("xl/missing.xml"))).message).toBe(
			"The workbook has no part xl/missing.xml",
		);
	});

	it("matches names after turning backslashes into slashes and ignores escaping names", async () => {
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl\\worksheets\\sheet1.xml", data: "one" },
				{ name: "../xl/evil.xml", data: "evil" },
				{ name: "xl/../../evil.xml", data: "evil" },
				{ name: "/xl/abs.xml", data: "abs" },
				{ name: "xl/dup.xml", data: "first" },
				{ name: "xl/dup.xml", data: "second" },
			]),
		);
		expect(await text(archive.open("xl/worksheets/sheet1.xml"))).toBe("one");
		for (const name of ["../xl/evil.xml", "xl/../../evil.xml", "/xl/abs.xml", "xl/abs.xml"]) {
			expect(archive.has(name)).toBe(false);
		}
		expect(await text(archive.open("xl/dup.xml"))).toBe("first");
	});

	it("refuses files that are not zip archives, or are encrypted workbooks or .xls files", async () => {
		expect(
			(await failure(() => ZipArchive.open(new TextEncoder().encode("a,b\n1,2\n")))).message,
		).toBe("The file is not an .xlsx workbook (it is not a zip archive)");
		expect((await failure(() => ZipArchive.open(new Uint8Array(0)))).message).toBe(
			"The file is not an .xlsx workbook (it is not a zip archive)",
		);
		const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
		expect((await failure(() => ZipArchive.open(cfb))).message).toBe(
			"The file is an encrypted workbook or an old .xls file; save it as an unencrypted .xlsx workbook",
		);
	});

	it("refuses truncated archives", async () => {
		const whole = await zip([{ name: "xl/workbook.xml", data: "<workbook/>".repeat(100) }]);
		for (const cut of [whole.length - 1, whole.length - 30, 40]) {
			expect((await failure(() => ZipArchive.open(whole.subarray(0, cut)))).message).toBe(
				"The zip archive is truncated or corrupt",
			);
		}
	});

	it("refuses encrypted entries and unsupported compression methods when they are read", async () => {
		const archive = ZipArchive.open(
			await zip([
				{ name: "xl/workbook.xml", data: "<workbook/>", flags: 1 },
				{ name: "xl/lzma.xml", data: "x", method: 0, declaredMethod: 14 },
				{ name: "xl/other.xml", data: "fine" },
			]),
		);
		expect((await failure(() => archive.open("xl/workbook.xml"))).message).toBe(
			"The workbook is encrypted",
		);
		expect((await failure(() => archive.open("xl/lzma.xml"))).message).toBe(
			"The part xl/lzma.xml uses compression method 14; only stored and deflate are supported",
		);
		expect(await text(archive.open("xl/other.xml"))).toBe("fine");
	});

	it("refuses ZIP64 and multi-disk archives", async () => {
		const archive = await zip([{ name: "xl/workbook.xml", data: "<workbook/>" }]);
		for (const zip64 of [
			patchEnd(patchEnd(archive, 8, 0xffff, 2), 10, 0xffff, 2),
			patchEnd(archive, 16, 0xffffffff, 4),
		]) {
			expect((await failure(() => ZipArchive.open(zip64))).message).toBe(
				"ZIP64 archives are not supported",
			);
		}
		// A ZIP64 end-of-directory locator right before the end record.
		const locator = new Uint8Array(20);
		new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
		const withLocator = new Uint8Array(archive.length + 20);
		withLocator.set(archive.subarray(0, archive.length - 22));
		withLocator.set(locator, archive.length - 22);
		withLocator.set(archive.subarray(archive.length - 22), archive.length - 2);
		expect((await failure(() => ZipArchive.open(withLocator))).message).toBe(
			"ZIP64 archives are not supported",
		);
		for (const split of [patchEnd(archive, 4, 1, 2), patchEnd(archive, 6, 1, 2)]) {
			expect((await failure(() => ZipArchive.open(split))).message).toBe(
				"Zip archives split across several disks are not supported",
			);
		}
	});

	it("stops a zip bomb at the declared size while inflating, and refuses a high ratio up front", async () => {
		const bomb = "a".repeat(1_000_000);
		// Declares 1,000 bytes but inflates to a million: reading stops after the first chunk.
		const lying = ZipArchive.open(
			await zip([{ name: "xl/worksheets/sheet1.xml", data: bomb, declaredSize: 1000 }]),
		);
		expect((await failure(() => text(lying.open("xl/worksheets/sheet1.xml")))).message).toBe(
			"The part xl/worksheets/sheet1.xml is larger than it declares",
		);
		// Declares its real size, 1,000,000 bytes from about 1 KB: over 200 times.
		const honest = ZipArchive.open(await zip([{ name: "xl/sharedStrings.xml", data: bomb }]));
		expect((await failure(() => honest.open("xl/sharedStrings.xml"))).message).toBe(
			"The part xl/sharedStrings.xml expands more than 200 times; the file may be a zip bomb",
		);
	});

	it("refuses an entry over its cap before reading it", async () => {
		const archive = ZipArchive.open(
			await zip([{ name: "xl/a.xml", data: "x".repeat(100), method: 0 }]),
			{
				maxEntryBytes: 99,
				maxRatio: 200,
			},
		);
		expect((await failure(() => archive.open("xl/a.xml"))).message).toBe(
			"The part xl/a.xml is larger than 99 bytes",
		);
		const capped = ZipArchive.open(
			await zip([{ name: "xl/a.xml", data: "x".repeat(100), method: 0 }]),
		);
		expect((await failure(() => capped.open("xl/a.xml", 50))).message).toBe(
			"The part xl/a.xml is larger than 50 bytes",
		);
		expect(await text(capped.open("xl/a.xml", 100))).toBe("x".repeat(100));
	});

	it("reports corrupt deflate data while reading", async () => {
		const archive = await zip([{ name: "xl/workbook.xml", data: "<workbook>".repeat(50) }]);
		// The deflate data starts after the 30-byte local header and the 15-byte name.
		const broken = new Uint8Array(archive);
		broken.fill(0xff, 45, 55);
		const opened = ZipArchive.open(broken);
		expect((await failure(() => text(opened.open("xl/workbook.xml")))).message).toBe(
			"The part xl/workbook.xml is corrupt",
		);
	});
});
