import { AnthropicError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicClientOptions, FALLBACK_BETA } from "../../src/plugin/ai/anthropic.js";
import {
	AI_MAX_TOKENS,
	aiErrorCode,
	aiTimeoutMs,
	callProvider,
	codeForStatus,
	guardFailure,
	type ProviderRequest,
} from "../../src/plugin/ai/provider.js";
import { type AiReady, DEFAULT_MODEL } from "../../src/plugin/ai/settings.js";
import { type NetOptions, type Resolver, UrlSourceError } from "../../src/sources/net.js";

const KEY = "sk-test-KEYMARK";
const ANTHROPIC: AiReady = {
	available: true,
	provider: "anthropic",
	model: DEFAULT_MODEL,
	key: KEY,
	baseUrl: "https://api.anthropic.com",
};
const OPENAI: AiReady = {
	available: true,
	provider: "openai-compatible",
	model: "local-model",
	key: KEY,
	baseUrl: "https://llm.example/v1",
};
const SCHEMA = { type: "object" };
const REQUEST: ProviderRequest = {
	system: "SYSTEM",
	user: "<import_data>\n{}\n</import_data>",
	schema: SCHEMA,
	timeoutMs: 5_000,
};
const REPLY = { key: "sku", slug: null, fields: [] };

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	init: RequestInit;
}

/** A runtime fetch behind the real `guardedRequest`, resolving every host to a public address. */
function fakeNet(
	answer: (sent: Sent) => Response | Promise<Response>,
	address = "93.184.215.14",
	resolver: Resolver = async () => [address],
) {
	const sent: Sent[] = [];
	const net: NetOptions = {
		allowPrivateNetwork: false,
		resolver,
		fetch: async (input, init = {}) => {
			const s = {
				url: String(input),
				headers: init.headers as Record<string, string>,
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
				init,
			};
			sent.push(s);
			return answer(s);
		},
	};
	return { net, sent };
}

const message = (content: unknown[], stop = "end_turn", extra: Record<string, unknown> = {}) =>
	Response.json({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: DEFAULT_MODEL,
		content,
		stop_reason: stop,
		stop_sequence: null,
		usage: { input_tokens: 11, output_tokens: 22 },
		...extra,
	});
const text = (t: string) => ({ type: "text", text: t });
const errorBody = (status: number) =>
	Response.json(
		{ type: "error", error: { type: "x", message: `echo ${KEY}` } },
		{ status, headers: { "request-id": "req_1" } },
	);
/** A fetch that never answers until the signal aborts, then rejects as the runtime does. */
const hung = (s: Sent) =>
	new Promise<Response>((_, reject) => {
		const signal = s.init.signal as AbortSignal;
		signal.addEventListener("abort", () => reject(signal.reason));
	});
/** A runtime that wraps the abort in its own error, whose message names the host. */
const wrappedAbort = () =>
	new TypeError("fetch failed for llm-timeout.example", {
		cause: new DOMException("This operation was aborted", "AbortError"),
	});
/** What a DNS-over-HTTPS lookup rejects with when its own `AbortSignal.timeout` fires. */
const resolverTimeout: Resolver = async () => {
	throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("aiTimeoutMs and codeForStatus (spec Rulings 52, 55)", () => {
	it("scales the timeout with the fields sent, up to 90 s", () => {
		expect([aiTimeoutMs(10), aiTimeoutMs(100), aiTimeoutMs(200)]).toEqual([26_000, 80_000, 90_000]);
	});

	it.each([
		[401, "ai_auth_failed"],
		[403, "ai_auth_failed"],
		[402, "ai_billing"],
		[408, "ai_timeout"],
		[429, "ai_provider_rate_limited"],
		[400, "ai_provider_rejected"],
		[404, "ai_provider_rejected"],
		[422, "ai_provider_rejected"],
		[307, "ai_provider_error"],
		[500, "ai_provider_error"],
		[529, "ai_provider_error"],
	] as const)("maps %i to %s", (status, code) => {
		expect(codeForStatus(status)).toBe(code);
	});

	it("re-throws an abort found in the cause chain on its own, never its host-naming wrapper", () => {
		const abort = new DOMException("This operation was aborted", "AbortError");
		const wrapped = new TypeError("fetch failed for llm-timeout.example", {
			cause: new Error("socket", { cause: abort }),
		});
		const out = guardFailure(wrapped);
		expect(out).toBe(abort);
		expect(String(out)).not.toContain("llm-timeout");
		const blocked = guardFailure(
			new UrlSourceError("URL_BLOCKED", "The host llm-timeout.internal"),
		);
		expect(blocked).toBeInstanceOf(UrlSourceError);
		expect(String(blocked)).toBe("UrlSourceError: URL_BLOCKED");
		expect(blocked).not.toHaveProperty("cause");
	});

	it("maps thrown values in plan Ruling 3's order", () => {
		const blocked = new UrlSourceError("URL_BLOCKED", "no");
		expect(aiErrorCode(blocked)).toBe("ai_url_blocked");
		expect(aiErrorCode(new Error("wrap", { cause: new Error("x", { cause: blocked }) }))).toBe(
			"ai_url_blocked",
		);
		expect(aiErrorCode(new UrlSourceError("TOO_LARGE", "big"))).toBe("ai_invalid_output");
		expect(aiErrorCode(new DOMException("t", "TimeoutError"))).toBe("ai_timeout");
		expect(aiErrorCode(new DOMException("a", "AbortError"))).toBe("ai_timeout");
		expect(aiErrorCode(Object.assign(new Error("s"), { status: 429 }))).toBe(
			"ai_provider_rate_limited",
		);
		expect(aiErrorCode(new AnthropicError("x"))).toBe("ai_provider_error");
		expect(aiErrorCode("thrown text")).toBe("ai_provider_error");
		expect(aiErrorCode(new Error("x"), () => true)).toBe("ai_timeout");
	});
});

describe('Anthropic through the pinned SDK and guardedRequest (spec "Provider requests")', () => {
	it("sends the documented request, with the key as a Bearer token (plan Ruling 2)", async () => {
		const { net, sent } = fakeNet(() => message([text(JSON.stringify(REPLY))]));
		const outcome = await callProvider(ANTHROPIC, { ...REQUEST, timeoutMs: aiTimeoutMs(10) }, net);
		expect(outcome).toEqual({
			ok: true,
			value: REPLY,
			model: DEFAULT_MODEL,
			status: 200,
			usage: { input: 11, output: 22 },
		});
		expect(sent).toHaveLength(1);
		const [s] = sent;
		expect(s?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(s?.init.redirect).toBe("manual");
		expect(s?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(s?.headers).not.toHaveProperty("x-api-key");
		expect(s?.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
		expect(s?.headers["x-stainless-timeout"]).toBe("26");
		expect(s?.headers).not.toHaveProperty("traceparent");
		expect(s?.body).toEqual({
			model: DEFAULT_MODEL,
			max_tokens: AI_MAX_TOKENS,
			system: "SYSTEM",
			messages: [{ role: "user", content: REQUEST.user }],
			output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
			fallbacks: "default",
		});
	});

	it("sends no effort, fallbacks or beta header for another model, and 80 s for 100 fields", async () => {
		const { net, sent } = fakeNet(() => message([text("{}")]));
		await callProvider(
			{ ...ANTHROPIC, model: "claude-sonnet-5" },
			{ ...REQUEST, timeoutMs: aiTimeoutMs(100) },
			net,
		);
		expect(sent[0]?.body).toEqual({
			model: "claude-sonnet-5",
			max_tokens: AI_MAX_TOKENS,
			system: "SYSTEM",
			messages: [{ role: "user", content: REQUEST.user }],
			output_config: { format: { type: "json_schema", schema: SCHEMA } },
		});
		expect(sent[0]?.headers).not.toHaveProperty("anthropic-beta");
		expect(sent[0]?.headers["x-stainless-timeout"]).toBe("80");
	});

	it("ignores the credential, base URL and log variables, and sends the operator's custom headers (Ruling 56)", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "ENV-KEY-MARK");
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ENV-TOKEN-MARK");
		vi.stubEnv("ANTHROPIC_BASE_URL", "https://env-base.example");
		vi.stubEnv("ANTHROPIC_LOG", "debug");
		vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content");
		vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-operator-marker: yes");
		const printed = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
			vi.spyOn(console, m).mockImplementation(() => {}),
		);
		const { net, sent } = fakeNet(() => message([text("{}")]));
		await callProvider(ANTHROPIC, REQUEST, net);
		const s = sent[0];
		expect(s?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(JSON.stringify(s?.headers)).not.toMatch(/ENV-KEY-MARK|ENV-TOKEN-MARK/);
		expect(s?.headers["x-operator-marker"]).toBe("yes");
		expect(s?.headers).not.toHaveProperty("traceparent");
		for (const spy of printed) expect(spy).not.toHaveBeenCalled();
	});

	it("builds the client with one attempt, no logging and telemetry off (plan Ruling 4)", () => {
		const fetch = async () => new Response();
		expect(
			anthropicClientOptions({
				key: KEY,
				baseUrl: "https://api.anthropic.com",
				timeoutMs: 26_000,
				fetch,
			}),
		).toEqual({
			apiKey: KEY,
			baseURL: "https://api.anthropic.com",
			fetch,
			timeout: 26_000,
			maxRetries: 0,
			logLevel: "off",
			openTelemetry: { traces: false, propagation: false },
		});
	});

	it.each([
		["a refusal with empty content", () => message([], "refusal"), "ai_refused"],
		["max_tokens", () => message([text('{"key":')], "max_tokens"), "ai_truncated"],
		[
			"model_context_window_exceeded",
			() => message([], "model_context_window_exceeded"),
			"ai_truncated",
		],
		["pause_turn", () => message([text("{}")], "pause_turn"), "ai_invalid_output"],
		["compaction", () => message([text("{}")], "compaction"), "ai_invalid_output"],
		["stop_sequence", () => message([text("{}")], "stop_sequence"), "ai_invalid_output"],
		["text that is not JSON", () => message([text("Here you go: {}")]), "ai_invalid_output"],
		["no text block", () => message([]), "ai_invalid_output"],
		["content that is not a list", () => message({} as unknown[]), "ai_invalid_output"],
		["a null body", () => Response.json(null), "ai_invalid_output"],
		["a number body", () => Response.json(42), "ai_invalid_output"],
		["a text body", () => new Response("hello"), "ai_invalid_output"],
	] as const)("reads %s as %s", async (_name, answer, code) => {
		const { net } = fakeNet(answer);
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toEqual({ ok: false, code, status: 200 });
	});

	it("parses only the text after the last fallback block, and reports the answering model (Ruling 53)", async () => {
		const fallback = {
			type: "fallback",
			from: { model: DEFAULT_MODEL },
			to: { model: "claude-opus-4-8" },
			trigger: null,
		};
		const { net } = fakeNet(() =>
			message(
				[
					{ type: "thinking", thinking: "", signature: "s" },
					text('{"key":"part'),
					fallback,
					text(JSON.stringify(REPLY).slice(0, 10)),
					text(JSON.stringify(REPLY).slice(10)),
				],
				"end_turn",
				{ model: "claude-opus-4-8" },
			),
		);
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toMatchObject({
			ok: true,
			value: REPLY,
			model: "claude-opus-4-8",
		});
	});

	it("parses only the text after the second of two fallback blocks (Ruling 53)", async () => {
		const hop = (from: string, to: string) => ({
			type: "fallback",
			from: { model: from },
			to: { model: to },
			trigger: null,
		});
		const { net } = fakeNet(() =>
			message(
				[
					text('{"key":"first'),
					hop(DEFAULT_MODEL, "claude-opus-5"),
					text('{"key":"second'),
					hop("claude-opus-5", "claude-opus-4-8"),
					text(JSON.stringify(REPLY)),
				],
				"end_turn",
				{ model: "claude-opus-4-8" },
			),
		);
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toMatchObject({
			ok: true,
			value: REPLY,
			model: "claude-opus-4-8",
		});
	});

	it.each([
		["a string", { input_tokens: "x\n", output_tokens: 22 }],
		["a negative count", { input_tokens: 11, output_tokens: -1 }],
		["a fraction", { input_tokens: 1.5, output_tokens: 22 }],
		["an unsafe integer", { input_tokens: 2 ** 53, output_tokens: 22 }],
		["no usage", undefined],
	])("leaves out usage holding %s (pre-flight F9)", async (_name, usage) => {
		const { net } = fakeNet(() => message([text("{}")], "end_turn", { usage }));
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toStrictEqual({
			ok: true,
			value: {},
			model: DEFAULT_MODEL,
			status: 200,
		});
	});

	it("reports no model that is not text", async () => {
		const { net } = fakeNet(() => message([text("{}")], "end_turn", { model: { x: 1 } }));
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toMatchObject({ ok: true, model: "" });
	});

	it.each([401, 402, 403, 408, 429, 500, 529, 400] as const)(
		"maps a %i, sends exactly one request, and keeps no error text",
		async (status) => {
			const { net, sent } = fakeNet(() => errorBody(status));
			const outcome = await callProvider(ANTHROPIC, REQUEST, net);
			expect(outcome).toEqual({ ok: false, code: codeForStatus(status), status });
			expect(sent).toHaveLength(1);
			expect(JSON.stringify(outcome)).not.toContain("KEYMARK");
		},
	);

	it("maps a 307 to another host to ai_provider_error after one request", async () => {
		const { net, sent } = fakeNet(
			() => new Response(null, { status: 307, headers: { location: "https://evil.example/" } }),
		);
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toEqual({
			ok: false,
			code: "ai_provider_error",
			status: 307,
		});
		expect(sent.map((s) => s.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
	});

	it("maps a refused address to ai_url_blocked without a request, through the SDK's cause", async () => {
		const { net, sent } = fakeNet(() => message([]), "10.0.0.7");
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toEqual({
			ok: false,
			code: "ai_url_blocked",
		});
		expect(sent).toEqual([]);
	});

	it("maps a refused host named like a timeout to ai_url_blocked, not ai_timeout (Fact D8)", async () => {
		const { net, sent } = fakeNet(() => message([]));
		const ai = { ...ANTHROPIC, baseUrl: "https://llm-timeout.internal" };
		expect(await callProvider(ai, REQUEST, net)).toEqual({ ok: false, code: "ai_url_blocked" });
		expect(sent).toEqual([]);
	});

	it("maps a resolver that timed out to ai_provider_error, not ai_timeout (Fact D8)", async () => {
		const { net, sent } = fakeNet(() => message([]), undefined, resolverTimeout);
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toEqual({
			ok: false,
			code: "ai_provider_error",
		});
		expect(sent).toEqual([]);
	});

	it("maps a connection error to ai_provider_error and a reply over 256 KiB to ai_invalid_output", async () => {
		const down = fakeNet(() => Promise.reject(new TypeError("fetch failed")));
		expect(await callProvider(ANTHROPIC, REQUEST, down.net)).toEqual({
			ok: false,
			code: "ai_provider_error",
		});
		const slow = fakeNet(() =>
			Promise.reject(new TypeError("fetch failed", { cause: new Error("Connect Timeout Error") })),
		);
		expect(await callProvider(ANTHROPIC, REQUEST, slow.net)).toEqual({
			ok: false,
			code: "ai_provider_error",
		});
		const big = fakeNet(() => new Response(`{"x":"${"a".repeat(300 * 1024)}"}`));
		expect(await callProvider(ANTHROPIC, REQUEST, big.net)).toEqual({
			ok: false,
			code: "ai_invalid_output",
		});
	});

	it("maps a fetch failure caused by an abort to ai_timeout", async () => {
		const { net } = fakeNet(() => Promise.reject(wrappedAbort()));
		expect(await callProvider(ANTHROPIC, REQUEST, net)).toEqual({ ok: false, code: "ai_timeout" });
	});

	it("maps a hung request to ai_timeout through the SDK's timer", async () => {
		const { net } = fakeNet(hung);
		const started = Date.now();
		expect(await callProvider(ANTHROPIC, { ...REQUEST, timeoutMs: 50 }, net)).toEqual({
			ok: false,
			code: "ai_timeout",
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("maps the SDK's timeout by its class when the bundle minifies its name (Fact D5)", async () => {
		// The timeout error has no cause, so only its class names it; workerd bundles may rename it.
		const name = Object.getOwnPropertyDescriptor(APIConnectionTimeoutError, "name");
		Object.defineProperty(APIConnectionTimeoutError, "name", { value: "Rr", configurable: true });
		try {
			const { net } = fakeNet(hung);
			expect(await callProvider(ANTHROPIC, { ...REQUEST, timeoutMs: 50 }, net)).toEqual({
				ok: false,
				code: "ai_timeout",
			});
		} finally {
			if (name) Object.defineProperty(APIConnectionTimeoutError, "name", name);
		}
	});

	it("maps a body that stalls after the headers to ai_timeout through the SDK's timer (Fact V1c)", async () => {
		const { net } = fakeNet((s) => {
			const signal = s.init.signal as AbortSignal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"id":'));
					signal.addEventListener("abort", () => controller.error(signal.reason));
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
		});
		expect(await callProvider(ANTHROPIC, { ...REQUEST, timeoutMs: 50 }, net)).toEqual({
			ok: false,
			code: "ai_timeout",
		});
	});
});

const completion = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	Response.json({
		id: "c1",
		object: "chat.completion",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: JSON.stringify(REPLY) },
				finish_reason: "stop",
				...choice,
			},
		],
		usage: { prompt_tokens: 5, completion_tokens: 6 },
		...extra,
	});

describe("an OpenAI-compatible endpoint through guardedRequest (spec Rulings 5, 46, 60)", () => {
	it("sends one POST with the documented body and max_tokens for a host other than api.openai.com", async () => {
		const { net, sent } = fakeNet(() => completion({}));
		expect(await callProvider(OPENAI, REQUEST, net)).toEqual({
			ok: true,
			value: REPLY,
			model: "local-model",
			status: 200,
			usage: { input: 5, output: 6 },
		});
		const s = sent[0];
		expect(s?.url).toBe("https://llm.example/v1/chat/completions");
		expect(s?.init.redirect).toBe("manual");
		expect(s?.init.signal).toBeInstanceOf(AbortSignal);
		expect(s?.headers).toEqual({
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
			accept: "application/json",
		});
		expect(s?.body).toEqual({
			model: "local-model",
			messages: [
				{ role: "system", content: "SYSTEM" },
				{ role: "user", content: REQUEST.user },
			],
			response_format: {
				type: "json_schema",
				json_schema: { name: "flux_import_mapping", strict: true, schema: SCHEMA },
			},
			max_tokens: AI_MAX_TOKENS,
		});
	});

	it("sends max_completion_tokens to api.openai.com", async () => {
		const { net, sent } = fakeNet(() => completion({}));
		await callProvider({ ...OPENAI, baseUrl: "https://api.openai.com/v1" }, REQUEST, net);
		expect(sent[0]?.body).toHaveProperty("max_completion_tokens", AI_MAX_TOKENS);
		expect(sent[0]?.body).not.toHaveProperty("max_tokens");
	});

	it.each([
		["a refusal", { message: { content: null, refusal: "no" } }, "ai_refused"],
		["content_filter", { finish_reason: "content_filter" }, "ai_refused"],
		["length", { finish_reason: "length" }, "ai_truncated"],
		["null content", { message: { content: null } }, "ai_invalid_output"],
		[
			"array content",
			{ message: { content: [{ type: "text", text: "{}" }] } },
			"ai_invalid_output",
		],
		["non-JSON content", { message: { content: "sure" } }, "ai_invalid_output"],
		[
			"fenced JSON, not repaired",
			{ message: { content: "```json\n{}\n```" } },
			"ai_invalid_output",
		],
	] as const)("reads %s as %s", async (_name, choice, code) => {
		const { net } = fakeNet(() => completion(choice));
		expect(await callProvider(OPENAI, REQUEST, net)).toEqual({ ok: false, code, status: 200 });
	});

	it("accepts extra envelope keys and refuses a missing or empty choices list", async () => {
		const extra = fakeNet(() => completion({ logprobs: null }, { system_fingerprint: "x" }));
		expect(await callProvider(OPENAI, REQUEST, extra.net)).toMatchObject({ ok: true });
		for (const body of [{}, { choices: [] }]) {
			const { net } = fakeNet(() => Response.json(body));
			expect(await callProvider(OPENAI, REQUEST, net)).toEqual({
				ok: false,
				code: "ai_invalid_output",
				status: 200,
			});
		}
	});

	it.each([
		["a string", { prompt_tokens: "x\n", completion_tokens: 6 }],
		["a negative count", { prompt_tokens: 5, completion_tokens: -1 }],
		["a fraction", { prompt_tokens: 5, completion_tokens: 0.5 }],
		["no counts", "none"],
		["null", null],
	])("keeps the reply but leaves out usage holding %s (pre-flight F9)", async (_name, usage) => {
		const { net } = fakeNet(() => completion({}, { usage }));
		expect(await callProvider(OPENAI, REQUEST, net)).toStrictEqual({
			ok: true,
			value: REPLY,
			model: "local-model",
			status: 200,
		});
	});

	it.each([302, 400, 401, 402, 403, 404, 429, 500, 503] as const)("maps a %i", async (status) => {
		const { net } = fakeNet(() =>
			status === 302
				? new Response(null, { status, headers: { location: "https://evil.example/" } })
				: errorBody(status),
		);
		const outcome = await callProvider(OPENAI, REQUEST, net);
		expect(outcome).toEqual({ ok: false, code: codeForStatus(status), status });
		expect(JSON.stringify(outcome)).not.toContain("KEYMARK");
	});

	it("maps a reply over 256 KiB, an AbortError, a TimeoutError and its own timeout", async () => {
		const big = fakeNet(() => new Response("a".repeat(300 * 1024)));
		expect(await callProvider(OPENAI, REQUEST, big.net)).toEqual({
			ok: false,
			code: "ai_invalid_output",
		});
		for (const name of ["AbortError", "TimeoutError"]) {
			const { net } = fakeNet(() => Promise.reject(new DOMException("x", name)));
			expect(await callProvider(OPENAI, REQUEST, net)).toEqual({ ok: false, code: "ai_timeout" });
		}
		const { net } = fakeNet(hung);
		expect(await callProvider(OPENAI, { ...REQUEST, timeoutMs: 50 }, net)).toEqual({
			ok: false,
			code: "ai_timeout",
		});
		const blocked = fakeNet(() => completion({}), "192.168.1.5");
		expect(await callProvider(OPENAI, REQUEST, blocked.net)).toEqual({
			ok: false,
			code: "ai_url_blocked",
		});
		expect(blocked.sent).toEqual([]);
	});

	it("maps a refused host named like a timeout, a resolver timeout and a connection error as the SDK path does", async () => {
		const named = fakeNet(() => completion({}));
		const ai = { ...OPENAI, baseUrl: "https://llm-timeout.internal/v1" };
		expect(await callProvider(ai, REQUEST, named.net)).toEqual({
			ok: false,
			code: "ai_url_blocked",
		});
		const dns = fakeNet(() => completion({}), undefined, resolverTimeout);
		expect(await callProvider(OPENAI, REQUEST, dns.net)).toEqual({
			ok: false,
			code: "ai_provider_error",
		});
		const down = fakeNet(() =>
			Promise.reject(new TypeError("fetch failed", { cause: new Error("Connect Timeout Error") })),
		);
		expect(await callProvider(OPENAI, REQUEST, down.net)).toEqual({
			ok: false,
			code: "ai_provider_error",
		});
		expect([...named.sent, ...dns.sent]).toEqual([]);
	});

	it("maps a fetch failure caused by an abort to ai_timeout", async () => {
		const { net } = fakeNet(() => Promise.reject(wrappedAbort()));
		expect(await callProvider(OPENAI, REQUEST, net)).toEqual({ ok: false, code: "ai_timeout" });
	});
});
