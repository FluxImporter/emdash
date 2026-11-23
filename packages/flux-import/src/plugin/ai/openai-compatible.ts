/**
 * An OpenAI-compatible Chat Completions endpoint (M6d spec "Provider requests", Rulings 5, 46,
 * 48, 60): one `guardedRequest`, its envelope checked with Zod, nothing repaired.
 */
import { z } from "zod";
import { guardedRequest, type NetOptions } from "../../sources/net.js";
import {
	AI_MAX_TOKENS,
	aiErrorCode,
	codeForStatus,
	guardFailure,
	PROVIDER_RESPONSE_MAX_BYTES,
	type ProviderOutcome,
	type ProviderRequest,
	usageOf,
} from "./provider.js";
import type { AiReady } from "./settings.js";

/** OpenAI's own API takes `max_completion_tokens`; other servers `max_tokens` (Ruling 60). */
export function tokenField(baseUrl: string): "max_completion_tokens" | "max_tokens" {
	return new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
}

const ENVELOPE = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable(),
					refusal: z.string().nullable().optional(),
				}),
				finish_reason: z.string().nullable(),
			}),
		)
		.min(1),
	// Counts are checked by `usageOf`; a malformed `usage` loses the counts, not the reply (F9).
	usage: z
		.object({ prompt_tokens: z.unknown(), completion_tokens: z.unknown() })
		.optional()
		.catch(undefined),
});

export function readCompletion(body: unknown, model: string, status: number): ProviderOutcome {
	const fail = (code: "ai_refused" | "ai_truncated" | "ai_invalid_output") => ({
		ok: false as const,
		code,
		status,
	});
	const parsed = ENVELOPE.safeParse(body);
	if (!parsed.success) return fail("ai_invalid_output");
	const [choice] = parsed.data.choices;
	if (!choice) return fail("ai_invalid_output");
	if ((choice.message.refusal ?? "") !== "" || choice.finish_reason === "content_filter") {
		return fail("ai_refused");
	}
	if (choice.finish_reason === "length") return fail("ai_truncated");
	if (choice.message.content === null) return fail("ai_invalid_output");
	let value: unknown;
	try {
		value = JSON.parse(choice.message.content);
	} catch {
		return fail("ai_invalid_output");
	}
	const usage = parsed.data.usage;
	return {
		ok: true,
		value,
		model,
		status,
		...usageOf(usage?.prompt_tokens, usage?.completion_tokens),
	};
}

export async function callOpenAiCompatible(
	ai: AiReady,
	request: ProviderRequest,
	net: NetOptions,
): Promise<ProviderOutcome> {
	try {
		const response = await guardedRequest(
			`${ai.baseUrl}/chat/completions`,
			{
				method: "POST",
				signal: AbortSignal.timeout(request.timeoutMs),
				headers: {
					authorization: `Bearer ${ai.key}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({
					model: ai.model,
					messages: [
						{ role: "system", content: request.system },
						{ role: "user", content: request.user },
					],
					response_format: {
						type: "json_schema",
						json_schema: { name: "flux_import_mapping", strict: true, schema: request.schema },
					},
					[tokenField(ai.baseUrl)]: AI_MAX_TOKENS,
				}),
			},
			net,
			{ maxResponseBytes: PROVIDER_RESPONSE_MAX_BYTES },
		).catch((e: unknown) => {
			// The same classification as the SDK's transport, so both paths map a failure alike.
			throw guardFailure(e);
		});
		const { status } = response;
		if (status < 200 || status > 299) return { ok: false, code: codeForStatus(status), status };
		let body: unknown;
		try {
			body = JSON.parse(await response.text());
		} catch {
			return { ok: false, code: "ai_invalid_output", status };
		}
		return readCompletion(body, ai.model, status);
	} catch (e) {
		return { ok: false, code: aiErrorCode(e) };
	}
}
