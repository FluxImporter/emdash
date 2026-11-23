import {
	createServer,
	type IncomingHttpHeaders,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type AiScenario =
	| "valid"
	| "refusal"
	| "fallback"
	| "truncated"
	| "invalid_json"
	| "unknown_keys"
	| "error_500"
	| "error_429"
	| "redirect"
	| "slow"
	| "stall";

export interface AiRequest {
	at: number;
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

const item = (field: string, from: string | null) => ({
	field,
	from,
	confidence: "high",
	rationale: "The product name",
	dateFormat: null,
	decimalComma: null,
	portableTextFormat: null,
});

/** `title` ← `Name`, for the products fixture. */
export const FAKE_REPLY = { key: "sku", slug: null, fields: [item("title", "Name")] };
const UNKNOWN = { key: "nope", slug: null, fields: [item("ghost", "Name"), item("title", "nope")] };

const MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";
const PROSE = "Here is the mapping.";

function json(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": String(Buffer.byteLength(body)),
	});
	res.end(body);
}

/** The Anthropic Messages reply for a scenario that answers 200. */
function message(scenario: AiScenario, reply: unknown) {
	const text = (t: string) => ({ type: "text", text: t });
	const envelope = (stop_reason: string, content: unknown[], model = MODEL) => ({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model,
		stop_reason,
		stop_sequence: null,
		content,
		usage: { input_tokens: 900, output_tokens: 120 },
	});
	switch (scenario) {
		case "refusal":
			return envelope("refusal", []);
		case "fallback":
			return envelope(
				"end_turn",
				[
					text('{"key":"par'),
					{
						type: "fallback",
						from: { model: MODEL },
						to: { model: FALLBACK_MODEL },
						trigger: null,
					},
					text(JSON.stringify(reply)),
				],
				FALLBACK_MODEL,
			);
		case "truncated":
			return envelope("max_tokens", [text('{"key":"sku","slug":null,"fields":[{"fi')]);
		case "invalid_json":
			return envelope("end_turn", [text(PROSE)]);
		default:
			return envelope("end_turn", [
				{ type: "thinking", thinking: "", signature: "sig" },
				text(JSON.stringify(reply)),
			]);
	}
}

/** The Chat Completions reply for a scenario that answers 200. */
function completion(scenario: AiScenario, reply: unknown, model: unknown) {
	const envelope = (
		content: string | null,
		finish_reason: string,
		refusal: string | null = null,
	) => ({
		id: "chatcmpl-1",
		object: "chat.completion",
		model,
		choices: [{ index: 0, message: { role: "assistant", content, refusal }, finish_reason }],
		usage: { prompt_tokens: 900, completion_tokens: 120 },
	});
	switch (scenario) {
		case "refusal":
			return envelope(null, "stop", "I can't help with that.");
		case "truncated":
			return envelope('{"key":"sku","slug":null,"fields":[{"fi', "length");
		case "invalid_json":
			return envelope(PROSE, "stop");
		default:
			return envelope(JSON.stringify(reply), "stop");
	}
}

/** A local stand-in for both provider APIs (M6d spec "Testing"); never a real provider. */
export class FakeAiServer {
	scenario: AiScenario = "valid";
	reply: unknown = FAKE_REPLY;
	readonly requests: AiRequest[] = [];
	baseUrl = "";
	private server: Server | undefined;

	async start(): Promise<void> {
		const server = createServer((req, res) => {
			let raw = "";
			req.setEncoding("utf8");
			req.on("data", (c: string) => {
				raw += c;
			});
			req.on("end", () => {
				const path = new URL(req.url ?? "/", "http://fake").pathname;
				let body: Record<string, unknown> = {};
				try {
					body = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					// Recorded with an empty body.
				}
				this.requests.push({ at: Date.now(), path, headers: req.headers, body });
				const anthropic = path === "/v1/messages";
				if (!anthropic && path !== "/v1/chat/completions") return json(res, 404, {});
				const reply = this.scenario === "unknown_keys" ? UNKNOWN : this.reply;
				// An error body that echoes the credential: it must never reach a response or a log.
				const echo = {
					type: "error",
					error: { type: "x", message: `echo ${req.headers.authorization}` },
				};
				switch (this.scenario) {
					case "error_500":
						return json(res, 500, echo);
					case "error_429":
						return json(res, 429, echo);
					case "redirect":
						// Back to this server, so a client that follows it makes a second, recorded request.
						res.writeHead(307, { location: `${this.baseUrl}/v1/redirected` });
						return res.end();
					case "slow":
						return;
					case "stall":
						res.writeHead(200, { "content-type": "application/json" });
						res.write('{"id":"msg_1",');
						return;
					default:
						return json(
							res,
							200,
							anthropic
								? message(this.scenario, reply)
								: completion(this.scenario, reply, body.model),
						);
				}
			});
		});
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	/** The payload of the last request, parsed out of its <import_data> block. */
	lastPayload(): { fields: { slug: string }[]; source: { keys: string[] }; records: unknown[] } {
		const body = this.requests.at(-1)?.body ?? {};
		const messages = (body.messages ?? []) as { role: string; content: unknown }[];
		const text = messages.find((m) => m.role === "user")?.content;
		if (typeof text !== "string") throw new Error("The last request has no user message text");
		const open = "<import_data>\n";
		const close = "\n</import_data>";
		if (!text.startsWith(open) || !text.endsWith(close)) {
			throw new Error("The user message is not one <import_data> block");
		}
		return JSON.parse(text.slice(open.length, -close.length));
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
