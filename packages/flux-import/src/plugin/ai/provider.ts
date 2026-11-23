/**
 * A provider call and its failure codes (M6d spec "Provider requests", Rulings 19, 35, 47, 52,
 * 55; plan Ruling 3). A call never rejects: every failure is a code, and nothing the provider or
 * the runtime said is kept, so an error body that echoes the key cannot reach a response or a log.
 */
import { type NetOptions, UrlSourceError } from "../../sources/net.js";
import type { AiReady } from "./settings.js";

export const AI_MAX_TOKENS = 16_000;
export const PROVIDER_RESPONSE_MAX_BYTES = 262_144;

export function aiTimeoutMs(fieldsSent: number): number {
	return Math.min(90_000, 20_000 + 600 * fieldsSent);
}

export type AiFailureCode =
	| "ai_url_blocked"
	| "ai_timeout"
	| "ai_auth_failed"
	| "ai_billing"
	| "ai_provider_rate_limited"
	| "ai_provider_rejected"
	| "ai_provider_error"
	| "ai_refused"
	| "ai_truncated"
	| "ai_invalid_output";

export interface ProviderRequest {
	system: string;
	user: string;
	schema: Readonly<Record<string, unknown>>;
	timeoutMs: number;
}

export type ProviderOutcome =
	| {
			ok: true;
			value: unknown;
			model: string;
			status: number;
			usage?: { input: number; output: number };
	  }
	| { ok: false; code: AiFailureCode; status?: number };

export function codeForStatus(status: number): AiFailureCode {
	if (status === 401 || status === 403) return "ai_auth_failed";
	if (status === 402) return "ai_billing";
	if (status === 408) return "ai_timeout";
	if (status === 429) return "ai_provider_rate_limited";
	if (status >= 400 && status < 500) return "ai_provider_rejected";
	return "ai_provider_error";
}

/** `e` and its causes, at most five links (an SDK error wraps the transport's). */
function chain(e: unknown): unknown[] {
	const out: unknown[] = [];
	for (let c = e; c !== undefined && c !== null && out.length < 5; ) {
		out.push(c);
		c = c instanceof Error ? c.cause : undefined;
	}
	return out;
}

const urlCode = (c: unknown, code: string) => c instanceof UrlSourceError && c.code === code;
/** The runtime's own abort and timeout errors (DOM names, which no bundle minifies). */
const named = (c: unknown) =>
	typeof c === "object" &&
	c !== null &&
	"name" in c &&
	(c.name === "AbortError" || c.name === "TimeoutError");

/**
 * Plan Ruling 3's order. `isTimeout` recognises the SDK's own timeout class (Fact D5: classes, not
 * names, since workerd's bundle minifies them).
 */
export function aiErrorCode(
	e: unknown,
	isTimeout: (e: unknown) => boolean = () => false,
): AiFailureCode {
	const links = chain(e);
	if (links.some((c) => urlCode(c, "URL_BLOCKED"))) return "ai_url_blocked";
	if (links.some((c) => urlCode(c, "TOO_LARGE"))) return "ai_invalid_output";
	if (isTimeout(e) || links.some(named)) return "ai_timeout";
	const status = statusOf(e);
	return status === undefined ? "ai_provider_error" : codeForStatus(status);
}

/** A numeric `status` on the thrown value (the SDK's `APIError`), for the code and the log line. */
export function statusOf(e: unknown): number | undefined {
	return typeof e === "object" && e !== null && "status" in e && typeof e.status === "number"
		? e.status
		: undefined;
}

/**
 * What a provider transport re-throws for a `guardedRequest` failure. The runtime's abort and
 * timeout errors pass unchanged. Anything else becomes a `UrlSourceError` whose message is only
 * its code, with no cause: the SDK reads any rejection whose text matches `/timed? ?out/i` as its
 * own timeout (SDK `client.js` `makeRequest`), and a guard message names the host ("The host
 * llm-timeout.internal is not allowed") or the resolver's error ("…aborted due to timeout").
 */
export function guardFailure(e: unknown): unknown {
	if (named(e)) return e;
	const code = e instanceof UrlSourceError ? e.code : "FETCH_FAILED";
	return new UrlSourceError(code, code);
}

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** Token counts, kept only when both are safe non-negative integers (pre-flight F9). */
export function usageOf(
	input: unknown,
	output: unknown,
): { usage: { input: number; output: number } } | Record<string, never> {
	return count(input) && count(output) ? { usage: { input, output } } : {};
}

export async function callProvider(
	ai: AiReady,
	request: ProviderRequest,
	net: NetOptions,
): Promise<ProviderOutcome> {
	try {
		const call =
			ai.provider === "anthropic"
				? (await import("./anthropic.js")).callAnthropic
				: (await import("./openai-compatible.js")).callOpenAiCompatible;
		return await call(ai, request, net);
	} catch (e) {
		return { ok: false, code: aiErrorCode(e) };
	}
}
