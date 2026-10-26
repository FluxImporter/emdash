const MIB = 1024 * 1024;

/** A workbook that cannot be converted: it fails job creation with `invalid_source`. */
export class XlsxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "XlsxError";
	}
}

export interface ZipLimits {
	/** Largest uncompressed size of any entry. */
	maxEntryBytes: number;
	/** Largest uncompressed size as a multiple of the compressed size. */
	maxRatio: number;
}

export const ZIP_LIMITS: ZipLimits = { maxEntryBytes: 100 * MIB, maxRatio: 200 };

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const COMMENT_MAX = 0xffff;
const STORED = 0;
const DEFLATED = 8;
/** Traditional (bit 0) and strong (bit 6) encryption. */
const ENCRYPTED = 0x41;
/** An OLE compound file: an encrypted workbook or an old .xls file. */
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const CHUNK = 64 * 1024;

interface Entry {
	method: number;
	flags: number;
	compressedSize: number;
	size: number;
	localOffset: number;
}

const names = new TextDecoder("utf-8");

/** An entry name as used for lookups, or null for names that could escape the archive. */
function normalName(raw: string): string | null {
	const name = raw.replace(/\\/g, "/");
	if (name.startsWith("/") || name.split("/").includes("..")) return null;
	return name;
}

/**
 * The directory of a zip archive held in memory, with entries inflated on demand. Supported:
 * stored and deflate entries, no encryption, no ZIP64, one disk. Every entry is read under a cap
 * on its uncompressed size that is enforced while inflating.
 */
export class ZipArchive {
	private constructor(
		private readonly bytes: Uint8Array,
		private readonly entries: Map<string, Entry>,
		private readonly limits: ZipLimits,
	) {}

	static open(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ZipArchive {
		if (CFB.every((b, i) => bytes[i] === b)) {
			throw new XlsxError(
				"The file is an encrypted workbook or an old .xls file; save it as an unencrypted .xlsx workbook",
			);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const eocd = findEndOfDirectory(view);
		if (eocd < 0) {
			// A zip that lost its end still starts with a local file header.
			throw new XlsxError(
				bytes.length >= 4 && view.getUint32(0, true) === LOCAL
					? "The zip archive is truncated or corrupt"
					: "The file is not an .xlsx workbook (it is not a zip archive)",
			);
		}
		const disk = view.getUint16(eocd + 4, true);
		const directoryDisk = view.getUint16(eocd + 6, true);
		const entriesHere = view.getUint16(eocd + 8, true);
		const count = view.getUint16(eocd + 10, true);
		const directorySize = view.getUint32(eocd + 12, true);
		const directoryOffset = view.getUint32(eocd + 16, true);
		if (
			(eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) ||
			count === 0xffff ||
			directorySize === 0xffffffff ||
			directoryOffset === 0xffffffff
		) {
			throw new XlsxError("ZIP64 archives are not supported");
		}
		if (disk !== 0 || directoryDisk !== 0 || entriesHere !== count) {
			throw new XlsxError("Zip archives split across several disks are not supported");
		}
		if (directoryOffset + directorySize > eocd) {
			throw new XlsxError("The zip archive is truncated or corrupt");
		}
		const entries = new Map<string, Entry>();
		let at = directoryOffset;
		for (let i = 0; i < count; i++) {
			if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL) {
				throw new XlsxError("The zip archive is truncated or corrupt");
			}
			const nameLength = view.getUint16(at + 28, true);
			const extraLength = view.getUint16(at + 30, true);
			const commentLength = view.getUint16(at + 32, true);
			const entry: Entry = {
				flags: view.getUint16(at + 8, true),
				method: view.getUint16(at + 10, true),
				compressedSize: view.getUint32(at + 20, true),
				size: view.getUint32(at + 24, true),
				localOffset: view.getUint32(at + 42, true),
			};
			if (
				entry.compressedSize === 0xffffffff ||
				entry.size === 0xffffffff ||
				entry.localOffset === 0xffffffff
			) {
				throw new XlsxError("ZIP64 archives are not supported");
			}
			if (at + 46 + nameLength > eocd) {
				throw new XlsxError("The zip archive is truncated or corrupt");
			}
			const name = normalName(names.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
			if (name !== null && !entries.has(name)) entries.set(name, entry);
			at += 46 + nameLength + extraLength + commentLength;
		}
		return new ZipArchive(bytes, entries, limits);
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	/**
	 * The entry's uncompressed bytes as a stream. Fails before reading when the entry is
	 * encrypted, uses another compression method, or declares more than `maxBytes` (at most the
	 * archive's entry limit) or more than the ratio limit allows; fails while reading once more
	 * bytes arrive than it declared.
	 */
	open(name: string, maxBytes = this.limits.maxEntryBytes): ReadableStream<Uint8Array> {
		const entry = this.entries.get(name);
		if (!entry) throw new XlsxError(`The workbook has no part ${name}`);
		if (entry.flags & ENCRYPTED) throw new XlsxError("The workbook is encrypted");
		if (entry.method !== STORED && entry.method !== DEFLATED) {
			throw new XlsxError(
				`The part ${name} uses compression method ${entry.method}; only stored and deflate are supported`,
			);
		}
		const cap = Math.min(maxBytes, this.limits.maxEntryBytes);
		if (entry.size > cap) throw new XlsxError(`The part ${name} is larger than ${cap} bytes`);
		if (entry.size > this.limits.maxRatio * Math.max(entry.compressedSize, 1)) {
			throw new XlsxError(
				`The part ${name} expands more than ${this.limits.maxRatio} times; the file may be a zip bomb`,
			);
		}
		const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
		const local = entry.localOffset;
		if (local + 30 > this.bytes.length || view.getUint32(local, true) !== LOCAL) {
			throw new XlsxError("The zip archive is truncated or corrupt");
		}
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const end = start + entry.compressedSize;
		if (end > this.bytes.length) throw new XlsxError("The zip archive is truncated or corrupt");
		const data = this.bytes.subarray(start, end);
		let sent = 0;
		const raw = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull(controller) {
				if (sent >= data.length) {
					controller.close();
					return;
				}
				controller.enqueue(data.slice(sent, sent + CHUNK));
				sent += CHUNK;
			},
		});
		const reader = (
			entry.method === DEFLATED
				? (raw as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream("deflate-raw"))
				: raw
		).getReader();
		let count = 0;
		return new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					let chunk: ReadableStreamReadResult<Uint8Array>;
					try {
						chunk = await reader.read();
					} catch {
						throw new XlsxError(`The part ${name} is corrupt`);
					}
					if (chunk.done) {
						if (count !== entry.size) throw new XlsxError(`The part ${name} is corrupt`);
						controller.close();
						return;
					}
					count += chunk.value.length;
					if (count > entry.size) {
						await reader.cancel().catch(() => {});
						throw new XlsxError(`The part ${name} is larger than it declares`);
					}
					controller.enqueue(chunk.value);
				},
				async cancel(reason) {
					await reader.cancel(reason).catch(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
	}
}

/** The offset of the end-of-central-directory record, searched backwards past any comment. */
function findEndOfDirectory(view: DataView): number {
	const last = view.byteLength - EOCD_SIZE;
	for (let at = last; at >= 0 && at >= last - COMMENT_MAX; at--) {
		if (view.getUint32(at, true) !== EOCD) continue;
		if (at + EOCD_SIZE + view.getUint16(at + 20, true) === view.byteLength) return at;
	}
	return -1;
}
