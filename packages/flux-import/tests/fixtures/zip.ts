/**
 * A small zip writer for test fixtures: stored and deflate entries (deflate through
 * `CompressionStream("deflate-raw")`), with fields that tests may falsify to build broken archives.
 */
export interface ZipFile {
	name: string;
	data: string | Uint8Array;
	/** 8 (deflate, the default) or 0 (stored). */
	method?: 0 | 8;
	/** Written as the method instead of `method`, which still decides how the data is stored. */
	declaredMethod?: number;
	/** General purpose flags; bit 0 marks the entry encrypted. */
	flags?: number;
	/** Written as the uncompressed size instead of the real one. */
	declaredSize?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([new Uint8Array(bytes)])
		.stream()
		.pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Builds a zip archive: local headers and data, then the central directory and its end record. */
export async function zip(files: ZipFile[]): Promise<Uint8Array<ArrayBuffer>> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = encoder.encode(file.name);
		const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
		const method = file.method ?? 8;
		const stored = method === 8 ? await deflateRaw(data) : data;
		const fields = {
			flags: file.flags ?? 0,
			method: file.declaredMethod ?? method,
			crc: crc32(data),
			compressed: stored.length,
			size: file.declaredSize ?? data.length,
		};
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, fields.flags, true);
		local.setUint16(8, fields.method, true);
		local.setUint32(14, fields.crc, true);
		local.setUint32(18, fields.compressed, true);
		local.setUint32(22, fields.size, true);
		local.setUint16(26, name.length, true);
		locals.push(new Uint8Array(local.buffer), name, stored);
		const central = new DataView(new ArrayBuffer(46));
		central.setUint32(0, 0x02014b50, true);
		central.setUint16(4, 20, true);
		central.setUint16(6, 20, true);
		central.setUint16(8, fields.flags, true);
		central.setUint16(10, fields.method, true);
		central.setUint32(16, fields.crc, true);
		central.setUint32(20, fields.compressed, true);
		central.setUint32(24, fields.size, true);
		central.setUint16(28, name.length, true);
		central.setUint32(42, offset, true);
		centrals.push(new Uint8Array(central.buffer), name);
		offset += 30 + name.length + stored.length;
	}
	const directory = concat(centrals);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, directory.length, true);
	end.setUint32(16, offset, true);
	return concat([...locals, directory, new Uint8Array(end.buffer)]);
}

/** Overwrites a little-endian field of the end-of-central-directory record (the last 22 bytes). */
export function patchEnd(archive: Uint8Array, field: number, value: number, bytes: 2 | 4) {
	const out = new Uint8Array(archive);
	const view = new DataView(out.buffer);
	const at = out.length - 22 + field;
	if (bytes === 2) view.setUint16(at, value, true);
	else view.setUint32(at, value, true);
	return out;
}
