/**
 * The Anthropic provider (M6d spec "Provider requests", Rulings 4, 9, 14, 15, 18, 19, 36, 48,
 * 53-56): the pinned SDK, loaded only here and only when a call is made, over `guardedRequest`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";
import { guardedRequest, type NetOptions } from "../../sources/net.js";
import {
	AI_MAX_TOKENS,
	aiErrorCode,
	guardFailure,
	PROVIDER_RESPONSE_MAX_BYTES,
	type ProviderOutcome,
	type ProviderRequest,
	statusOf,
	usageOf,
} from "./provider.js";
import { type AiReady, DEFAULT_MODEL } from "./settings.js";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** The client: the key and base URL explicit, one attempt, silent, no telemetry (Ruling 56). */
export function anthropicClientOptions(o: {
	key: string;
	baseUrl: string;
	timeoutMs: number;
	fetch: Fetch;
}): ClientOptions {
	return {
		apiKey: o.key,
		baseURL: o.baseUrl,
		fetch: o.fetch,
		timeout: o.timeoutMs,
		maxRetries: 0,
		logLevel: "off",
		openTelemetry: { traces: false, propagation: false },
	};
}

/** Effort and the refusal fallback only on the default model (Rulings 14, 15, 18). */
export function anthropicParams(model: string, request: ProviderRequest): Params {
	const own = model === DEFAULT_MODEL;
	return {
		model,
		max_tokens: AI_MAX_TOKENS,
		system: request.system,
		messages: [{ role: "user", content: request.user }],
		output_config: {
			format: { type: "json_schema", schema: { ...request.schema } },
			...(own ? { effort: "low" as const } : {}),
		},
		...(own ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
	};
}

/**
 * The SDK's `fetch`: its `Headers` as a record, its string body, its signal, through
 * `guardedRequest`, which forces `redirect: "manual"` (Fact V1: the SDK passes no redirect).
 * Failures are re-thrown by `guardFailure`, so the SDK cannot read a guard error as a timeout.
 */
function transport(net: NetOptions): Fetch {
	return async (input, init = {}) => {
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (typeof init.body !== "string") throw new TypeError("The request body must be text");
			return await guardedRequest(
				url,
				{
					method: "POST",
					headers: Object.fromEntries(new Headers(init.headers)),
					body: init.body,
					signal: init.signal ?? undefined,
				},
				net,
				{ maxResponseBytes: PROVIDER_RESPONSE_MAX_BYTES },
			);
		} catch (e) {
			throw guardFailure(e);
		}
	};
}

/** `stop_reason` first (A5); after a fallback block only the text that follows it (Ruling 53). */
export function readMessage(message: Message): ProviderOutcome {
	const fail = (code: "ai_refused" | "ai_truncated" | "ai_invalid_output") => ({
		ok: false as const,
		code,
		status: 200,
	});
	// The SDK returns a JSON `null`, a number or a text body as it is (SDK `internal/parse.js`).
	const body: unknown = message;
	if (typeof body !== "object" || body === null) return fail("ai_invalid_output");
	if (message.stop_reason === "refusal") return fail("ai_refused");
	if (
		message.stop_reason === "max_tokens" ||
		message.stop_reason === "model_context_window_exceeded"
	) {
		return fail("ai_truncated");
	}
	if (message.stop_reason !== "end_turn") return fail("ai_invalid_output");
	// The SDK does not check the reply's shape (Fact D4): a hostile body may hold anything.
	const blocks: unknown = message.content;
	if (!Array.isArray(blocks)) return fail("ai_invalid_output");
	const shaped = blocks as readonly { type?: unknown; text?: unknown }[];
	const last = shaped.findLastIndex((b) => b?.type === "fallback");
	const text = shaped
		.slice(last + 1)
		.flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : []))
		.join("");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return fail("ai_invalid_output");
	}
	const usage: Partial<Message["usage"]> | undefined = message.usage;
	return {
		ok: true,
		value,
		model: typeof message.model === "string" ? message.model : "",
		status: 200,
		...usageOf(usage?.input_tokens, usage?.output_tokens),
	};
}

export async function callAnthropic(
	ai: AiReady,
	request: ProviderRequest,
	net: NetOptions,
): Promise<ProviderOutcome> {
	const sdk = await import("@anthropic-ai/sdk");
	try {
		const client = new sdk.default(
			anthropicClientOptions({
				key: ai.key,
				baseUrl: ai.baseUrl,
				timeoutMs: request.timeoutMs,
				fetch: transport(net),
			}),
		);
		return readMessage(await client.beta.messages.create(anthropicParams(ai.model, request)));
	} catch (e) {
		const code = aiErrorCode(e, (x) => x instanceof sdk.APIConnectionTimeoutError);
		const status = statusOf(e);
		return status === undefined ? { ok: false, code } : { ok: false, code, status };
	}
}
