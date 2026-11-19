/**
 * At most 30 provider calls per site per UTC hour (M6d spec Rulings 34, 66), counted before the
 * call in one plugin KV row. The key must never start with "settings:", which `ctx.kv` routes to
 * the plugin's settings (spec F10). A lost race counts as limited: the limit fails closed.
 */
import type { KVAccess } from "emdash";

export const AI_USAGE_KEY = "ai:usage";
export const AI_CALLS_PER_HOUR = 30;
export const RATE_ATTEMPTS = 5;

interface AiUsage {
	hour: string;
	count: number;
}

/** The UTC hour of a time, as "YYYY-MM-DDTHH". */
export function utcHour(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13);
}

const isUsage = (v: unknown): v is AiUsage =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as AiUsage).hour === "string" &&
	Number.isInteger((v as AiUsage).count);

/** True when a call may be made, and it is counted; at most 10 KV queries. */
export async function takeAiCall(
	kv: Pick<KVAccess, "getVersioned" | "compareAndSet">,
	now: () => number,
): Promise<boolean> {
	for (let attempt = 0; attempt < RATE_ATTEMPTS; attempt++) {
		const read = await kv.getVersioned<unknown>(AI_USAGE_KEY);
		// Ruling 66: the hour is read in each attempt, so a rollover between attempts counts afresh.
		const hour = utcHour(now());
		const usage =
			read !== null && isUsage(read.value) && read.value.hour === hour ? read.value.count : 0;
		if (usage >= AI_CALLS_PER_HOUR) return false;
		const written = await kv.compareAndSet(AI_USAGE_KEY, read?.revision ?? null, {
			hour,
			count: usage + 1,
		});
		if (written.applied) return true;
	}
	return false;
}
