import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AI_CALLS_PER_HOUR, utcHour } from "../../src/plugin/ai/rate-limit.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SuggestReply } from "../../src/plugin/suggest.js";
import type { SavedResult } from "../../src/plugin/templates.js";
import { productsXlsx } from "../fixtures/xlsx.js";
import { Client, devBypass } from "./client.js";
import { type AiRequest, FakeAiServer } from "./fake-ai.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

/** Its own site: allowPrivateNetwork lets both providers reach the fake on this machine. */
const PORT = 4388;
const SETTINGS = "/_emdash/api/admin/plugins/flux-import/settings";
const ROUTE = "/_emdash/api/plugins/flux-import/templates/suggest";
/** A generated test key, held in memory only; the fake echoes it in its error bodies. */
const KEY = `sk-test-${randomBytes(12).toString("hex")}`;
const CLEARED = { aiProvider: "none", aiApiKey: null, aiModel: null, aiBaseUrl: null };

let server: DevServer;
let admin: Client;
const fake = new FakeAiServer();
const feeds = new FeedServer();

const settings = (client: Client, values: Record<string, unknown>) =>
	client.api("PUT", SETTINGS, { values });
const suggest = (input: Record<string, unknown>, client = admin) =>
	client.plugin<SuggestReply>("templates/suggest", input);
const TEXT = { collection: "it_suggest", locale: "en", text: productsCsv(20) };
const codes = (r: SuggestReply) => r.warnings.map((w) => w.code);
/** Points the site at the fake with the key set, so each test also runs alone (`-t`). */
const pointAtFake = (provider: "anthropic" | "openai-compatible") =>
	settings(admin, {
		aiProvider: provider,
		aiApiKey: KEY,
		aiModel: provider === "anthropic" ? "" : "local-model",
		aiBaseUrl: provider === "anthropic" ? fake.baseUrl : `${fake.baseUrl}/v1`,
	});

/** Values of `productsCsv` rows: the redactor does not cover them, so no reply or log may hold one. */
const SAMPLE_VALUES = [/SKU-\d/, /Product \d/, /quoted/, /product-\d/];

/**
 * The server log written since `start`, once `line` matches it or after 5 s (stdout is piped, so a
 * line can arrive after the response). Waiting for the caller's own line, not any route line, means
 * another request's line can never stand in for it.
 */
async function logSince(start: number, line: RegExp): Promise<string> {
	const until = performance.now() + 5_000;
	for (;;) {
		const log = server.log.slice(start).join("");
		if (line.test(log) || performance.now() > until) return log;
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** The log since `start` holds the route's `line`, and no key, bearer token or sample value. */
async function expectCleanLog(start: number, line: RegExp): Promise<void> {
	const log = await logSince(start, line);
	expect(log).toMatch(line);
	// Defence in depth only: EmDash's ctx.log redactor strips secret setting values before it prints
	// (spec F8), so the real guards are the response checks and Task 9's unit log test, whose log
	// does not redact.
	expect(log).not.toContain(KEY);
	expect(log).not.toMatch(/Bearer\s/);
	for (const value of SAMPLE_VALUES) expect(log).not.toMatch(value);
}

/** The route's answer, checked as text first: a 200 holding no key and no sample value. */
async function cleanSuggest(input: Record<string, unknown>): Promise<SuggestReply> {
	const res = await admin.raw("POST", ROUTE, input);
	expect(res.status).toBe(200);
	const text = await res.text();
	expect(text).not.toContain(KEY);
	for (const value of SAMPLE_VALUES) expect(text).not.toMatch(value);
	return (JSON.parse(text) as { data: SuggestReply }).data;
}

/**
 * What a request carries besides `authorization`, the key's one place (plan Ruling 2), and `host`,
 * the fake's own address: every other header, and the body.
 */
function outsideAuthorization(request: AiRequest | undefined): string {
	const { authorization: _authorization, host: _host, ...headers } = request?.headers ?? {};
	return JSON.stringify({ headers, body: request?.body });
}

/**
 * Binding safety check: no request may reach a real provider. Before any Anthropic call, prove the
 * site talks to the fake.
 * 1. An OpenAI-compatible call over `http:` to 127.0.0.1, which the site makes only under
 *    allowPrivateNetwork (Ruling 8), must reach the fake.
 * 2. With the same settings, a collection whose every field settles by name must make no call at
 *    all (name matching does not depend on the provider).
 * 3. That collection, with Anthropic configured, therefore calls nothing, and its log line must name
 *    the fake's host, not api.anthropic.com: the site reads `aiBaseUrl` for Anthropic (Ruling 7).
 */
async function proveTheFakeIsReached(): Promise<void> {
	await admin.createCollection("it_suggest_probe");
	for (const field of [
		{ slug: "price", label: "Price", type: "number" },
		{ slug: "released", label: "Released", type: "datetime" },
	]) {
		await admin.api("POST", "/_emdash/api/schema/collections/it_suggest_probe/fields", field);
	}
	const probe = { collection: "it_suggest_probe", locale: "en", text: productsCsv(5) };
	const fail = (why: string) => {
		throw new Error(`Safety check failed, so no Anthropic call is made: ${why}`);
	};

	await pointAtFake("openai-compatible");
	let before = fake.requests.length;
	const reached = await suggest(TEXT);
	if (fake.requests.length !== before + 1 || reached.method !== "ai") {
		fail("an OpenAI-compatible call did not reach the fake");
	}
	before = fake.requests.length;
	const quiet = await suggest(probe);
	if (fake.requests.length !== before || quiet.sent !== null || !quiet.ai.available) {
		fail("the probe collection made a provider call, or the provider was unavailable");
	}

	await pointAtFake("anthropic");
	const start = server.log.length;
	const anthropic = await suggest(probe);
	const line = /flux-import: suggest method=\S+ provider=anthropic \S+ host=(\S+) /;
	const host = line.exec(await logSince(start, line))?.[1];
	if (!anthropic.ai.available || anthropic.sent !== null || fake.requests.length !== before) {
		fail("the Anthropic probe was unavailable or made a call");
	}
	if (host !== "127.0.0.1") fail(`Anthropic would call ${host ?? "an unknown host"}`);
	await settings(admin, { aiProvider: "none" });
}

beforeAll(async () => {
	await Promise.all([fake.start(), feeds.start()]);
	server = await startServer(PORT, undefined, undefined, true);
	admin = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await admin.createProducts("it_suggest");
	await proveTheFakeIsReached();
});

afterAll(async () => {
	try {
		if (server) {
			await settings(admin, CLEARED).catch(() => {});
			await stopServer(server);
			await rm(server.dir, { recursive: true, force: true });
		}
	} finally {
		await Promise.all([fake.stop(), feeds.stop()]);
	}
});

describe("M6d templates/suggest on sites/dev", () => {
	it("drafts by name matching alone, and the draft saves and dry-runs without problems (step 1)", async () => {
		await settings(admin, { aiProvider: "none" });
		const before = fake.requests.length;
		const out = await suggest(TEXT);
		expect(out).toMatchObject({
			method: "fallback",
			ai: { available: false },
			sent: null,
			key: { from: "sku" },
			slug: { from: "Handle" },
			check: { problems: [] },
		});
		expect(out.fields.map((f) => [f.field, f.from])).toEqual([
			["title", "Name"],
			["price", "Price"],
			["released", "Released"],
		]);
		expect(fake.requests.length).toBe(before);
		const saved = await admin.plugin<SavedResult>("templates/create", {
			name: "Suggested",
			template: out.template,
		});
		expect(saved.check.problems).toEqual([]);
		const { uploadId } = await admin.paste("csv", productsCsv(20));
		const job = await admin.plugin("jobs/create", {
			uploadId,
			templateId: saved.template.id,
			dryRun: true,
		});
		const done = await admin.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { failed: 0 } });
	});

	it("asks Anthropic through the fake, sending only the payload (steps 2, Review Focus 2)", async () => {
		await settings(admin, {
			aiProvider: "anthropic",
			aiApiKey: KEY,
			aiModel: "",
			aiBaseUrl: fake.baseUrl,
		});
		await admin.plugin("credentials/set", {
			name: "it-suggest",
			header: "Authorization",
			value: "Bearer cred-s3cr3t",
		});
		feeds.feeds.set("/suggest/s3cr3t-path.csv", { body: productsCsv(20) });
		const source = await admin.plugin<SourceRow>("sources/create", {
			name: "Suggest feed",
			url: `${feeds.url("/suggest/s3cr3t-path.csv")}?token=t0ken`,
			credential: "it-suggest",
		});
		fake.scenario = "valid";
		const before = fake.requests.length;
		const logStart = server.log.length;
		const out = await cleanSuggest({ collection: "it_suggest", locale: "en", sourceId: source.id });
		expect(out).toMatchObject({
			method: "ai",
			ai: { available: true, provider: "anthropic", model: "claude-opus-5-5" },
			fields: [
				{ field: "title", from: "Name", origin: "ai", rationale: "The product name" },
				{},
				{},
			],
		});
		expect(fake.requests.length).toBe(before + 1);
		const request = fake.requests.at(-1);
		expect(request?.path).toBe("/v1/messages");
		// Fact D1 / plan Ruling 2: the SDK sends the key as a bearer token, never as x-api-key.
		expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(request?.headers["x-api-key"]).toBeUndefined();
		expect(request?.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
		expect(request?.body).toMatchObject({
			model: "claude-opus-5-5",
			max_tokens: 16_000,
			output_config: { effort: "low", format: { type: "json_schema" } },
			fallbacks: "default",
		});
		const payload = fake.lastPayload();
		expect(payload.fields.map((f) => f.slug)).toEqual(["title"]);
		expect(out.sent).toMatchObject({
			records: payload.records.length,
			keys: payload.source.keys.length,
			fields: 1,
		});
		// The copy the fetch staged: its ID is the site's own, never the provider's.
		const staged = (await admin.plugin<SourceRow>("sources/get", { id: source.id })).lastFetch
			?.uploadId;
		expect(staged).toBeTruthy();
		const outside = outsideAuthorization(request);
		for (const marker of [KEY, "s3cr3t", "t0ken", "it-suggest", source.id, staged, "127.0.0.1"]) {
			expect(outside, marker).not.toContain(marker);
		}
		await expectCleanLog(
			logStart,
			/flux-import: suggest method=ai provider=anthropic .* code=none /,
		);
	});

	it("asks an OpenAI-compatible endpoint through the fake (step 3)", async () => {
		await settings(admin, {
			aiProvider: "openai-compatible",
			aiApiKey: KEY,
			aiModel: "local-model",
			aiBaseUrl: `${fake.baseUrl}/v1/`,
		});
		fake.scenario = "valid";
		const { uploadId } = await admin.paste("csv", productsCsv(20));
		const before = fake.requests.length;
		const logStart = server.log.length;
		const out = await cleanSuggest({ collection: "it_suggest", locale: "en", uploadId });
		expect(out).toMatchObject({
			method: "ai",
			ai: { provider: "openai-compatible", model: "local-model" },
		});
		expect(fake.requests.length).toBe(before + 1);
		const request = fake.requests.at(-1);
		expect(request?.path).toBe("/v1/chat/completions");
		expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(request?.body).toMatchObject({
			model: "local-model",
			max_tokens: 16_000,
			response_format: {
				type: "json_schema",
				json_schema: { name: "flux_import_mapping", strict: true },
			},
		});
		const outside = outsideAuthorization(request);
		for (const marker of [KEY, uploadId, "s3cr3t", "t0ken", "it-suggest", "127.0.0.1"]) {
			expect(outside, marker).not.toContain(marker);
		}
		await expectCleanLog(
			logStart,
			/flux-import: suggest method=ai provider=openai-compatible .* code=none /,
		);
	});

	it.each([
		["refusal", "anthropic", "ai_refused", 200],
		["truncated", "anthropic", "ai_truncated", 200],
		["invalid_json", "openai-compatible", "ai_invalid_output", 200],
		["error_500", "anthropic", "ai_provider_error", 500],
		["error_429", "openai-compatible", "ai_provider_rate_limited", 429],
		// A followed redirect would be a second request to the fake, or another status.
		["redirect", "anthropic", "ai_provider_error", 307],
	] as const)(
		"answers the %s scenario (%s) with 200, name matching and %s (step 4)",
		async (scenario, provider, code, status) => {
			await pointAtFake(provider);
			fake.scenario = scenario;
			const before = fake.requests.length;
			const logStart = server.log.length;
			const out = await cleanSuggest(TEXT);
			expect(out.method).toBe("fallback");
			expect(codes(out).filter((c) => c.startsWith("ai_"))).toEqual([code]);
			expect(out.template).not.toBeNull();
			expect(fake.requests.length - before).toBe(1);
			await expectCleanLog(
				logStart,
				new RegExp(
					`flux-import: suggest method=fallback provider=${provider} .* status=${status} code=${code} `,
				),
			);
		},
	);

	it("reads only the text after a fallback block, and drops unknown fields and keys (steps 2, 4)", async () => {
		await pointAtFake("anthropic");
		fake.scenario = "fallback";
		expect(await suggest(TEXT)).toMatchObject({ method: "ai", ai: { model: "claude-opus-4-8" } });
		fake.scenario = "unknown_keys";
		const out = await suggest(TEXT);
		expect(out.method).toBe("fallback");
		expect(out.warnings).toEqual(
			expect.arrayContaining([
				{ code: "ai_unknown_field", count: 1 },
				{ code: "ai_unknown_key", count: 2 },
			]),
		);
		expect(JSON.stringify(out)).not.toMatch(/ghost|nope/);
	});

	it("times out a provider that never answers and one whose body stalls, on both providers (step 4, Review Focus 1)", {
		timeout: 180_000,
	}, async () => {
		for (const [scenario, provider] of [
			["slow", "openai-compatible"],
			["stall", "openai-compatible"],
			["stall", "anthropic"],
		] as const) {
			await pointAtFake(provider);
			fake.scenario = scenario;
			// The monotonic clock: this machine's wall clock can step back seconds (Fact F1).
			const started = performance.now();
			const out = await suggest(TEXT);
			const ms = performance.now() - started;
			// One field sent: aiTimeoutMs(1) = 20.6 s.
			expect(ms, scenario).toBeGreaterThanOrEqual(20_000);
			expect(ms, scenario).toBeLessThan(40_000);
			expect(codes(out), scenario).toContain("ai_timeout");
			expect(out.method, scenario).toBe("fallback");
		}
	});

	it("reports ai_not_configured once the key is cleared through the settings API (step 6)", async () => {
		await pointAtFake("anthropic");
		await settings(admin, { aiApiKey: null });
		const out = await suggest(TEXT);
		expect(codes(out)).toContain("ai_not_configured");
		expect(out.ai).toEqual({ available: false, provider: "anthropic" });
	});

	it("samples an XLSX upload and a URL source, fetching the source only once (step 7)", async () => {
		const upload = await admin.upload(await productsXlsx(20), "products.xlsx");
		const xlsx = await suggest({
			collection: "it_suggest",
			locale: "en",
			uploadId: upload.uploadId,
			source: { format: "xlsx" },
			ai: false,
		});
		expect(xlsx.fields.map((f) => f.from)).toEqual(["Name", "Price", "Released"]);
		feeds.feeds.set("/suggest/plain.csv", { body: productsCsv(5) });
		const source = await admin.plugin<SourceRow>("sources/create", {
			name: "Plain",
			url: feeds.url("/suggest/plain.csv"),
		});
		await suggest({ collection: "it_suggest", locale: "en", sourceId: source.id, ai: false });
		await suggest({ collection: "it_suggest", locale: "en", sourceId: source.id, ai: false });
		expect(feeds.log("/suggest/plain.csv")).toHaveLength(1);
		await expect(
			suggest({ collection: "it_suggest", locale: "en", sourceId: "NOPE", ai: false }),
		).rejects.toMatchObject({ status: 404, code: "SOURCE_NOT_FOUND" });
	});

	// Keep this the last test that calls a provider: it uses up the hour's budget, so any provider
	// call after it would answer ai_rate_limited.
	it("allows 30 provider calls an hour and answers the 31st by name only (step 5, Ruling 66)", async () => {
		await pointAtFake("anthropic");
		fake.scenario = "valid";
		// Never straddle an hour (Fact F1): start in a fresh one if fewer than two minutes remain,
		// 10 s past the turn, since the clock can step back up to 5.4 s.
		const left = 3_600_000 - (Date.now() % 3_600_000);
		if (left < 120_000) await new Promise((r) => setTimeout(r, left + 10_000));
		const hour = utcHour(Date.now());
		const used = fake.requests.filter((r) => utcHour(r.at) === hour).length;
		for (let i = used; i < AI_CALLS_PER_HOUR; i++) {
			expect((await suggest(TEXT)).method, `call ${i + 1}`).toBe("ai");
		}
		const before = fake.requests.length;
		const limited = await suggest(TEXT);
		expect(codes(limited)).toContain("ai_rate_limited");
		expect(limited).toMatchObject({ method: "fallback", sent: null });
		expect(fake.requests.length).toBe(before);
	});
});

describe("M6d templates/suggest on the shared site, without allowPrivateNetwork (spec V7, plan Ruling 14)", () => {
	it("refuses a private OpenAI-compatible base URL before any connection", async () => {
		const shared = new Client(inject("baseUrl"), inject("token"));
		await shared.createProducts("it_suggest_shared");
		await settings(shared, {
			aiProvider: "openai-compatible",
			aiApiKey: KEY,
			aiModel: "local-model",
			aiBaseUrl: `${fake.baseUrl}/v1`,
		});
		try {
			const before = fake.requests.length;
			const out = await suggest({ ...TEXT, collection: "it_suggest_shared" }, shared);
			expect(codes(out)).toContain("ai_url_blocked");
			expect(out).toMatchObject({ method: "fallback", sent: null });
			expect(fake.requests.length).toBe(before);
		} finally {
			// A failed reset must not replace the test's own error; it is reported instead.
			await settings(shared, CLEARED).catch((e: unknown) => {
				console.error("Could not clear the shared site's AI settings:", e);
			});
		}
	});
});
