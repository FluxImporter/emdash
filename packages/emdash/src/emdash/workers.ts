/** Workers-only (`FixedLengthStream`): R2 `put()` needs a stream whose length is known. */
export type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/** `FixedLengthStream`, which exists only on Cloudflare Workers (workerd). */
export function fixedLengthStream(): FixedLengthStreamCtor | undefined {
	return (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
}

/** Whether the code runs on Cloudflare Workers, detected by `FixedLengthStream`. */
export function onWorkers(): boolean {
	return typeof fixedLengthStream() === "function";
}
