export function streamOf(
	input: string | Uint8Array,
	chunkSize = 1 << 16,
): ReadableStream<Uint8Array> {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(i, i + chunkSize));
			i += chunkSize;
		},
	});
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}
