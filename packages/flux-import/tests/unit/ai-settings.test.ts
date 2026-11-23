import { describe, expect, it } from "vitest";
import {
	AI_CALLS_PER_HOUR,
	AI_USAGE_KEY,
	takeAiCall,
	utcHour,
} from "../../src/plugin/ai/rate-limit.js";
import {
	ANTHROPIC_BASE_URL,
	DEFAULT_MODEL,
	providerBaseUrl,
	readAiProvider,
	readAiSettings,
	warningFor,
} from "../../src/plugin/ai/settings.js";
import { MemorySettings } from "./fakes.js";

/** `ctx.settings.get` over stored values; a stored Error is thrown, as EmDash's decryption does. */
function settings(values: Record<string, unknown>) {
	const read: string[] = [];
	return {
		read,
		get: async <T>(key: string): Promise<T | null> => {
			read.push(key);
			const value = values[key];
			if (value instanceof Error) throw value;
			return (value ?? null) as T | null;
		},
	};
}
const encryptionError = (code: string) =>
	Object.assign(new Error(`decrypt failed ${code}`), { code });

describe('readAiSettings (spec "Reading the settings", Rulings 7, 8, 12, 13)', () => {
	it("is off without a provider, reading nothing else", async () => {
		for (const provider of [undefined, "none", "openai", 7]) {
			const s = settings({ aiProvider: provider, aiApiKey: "k" });
			expect(await readAiSettings(s, false)).toEqual({ available: false, reason: "off" });
			expect(s.read).toEqual(["aiProvider"]);
		}
	});

	it("applies the defaults: Anthropic, the default model and the fixed host", async () => {
		const s = settings({
			aiProvider: "anthropic",
			aiApiKey: " sk-1 ",
			aiModel: "",
			aiBaseUrl: "https://x.example",
		});
		expect(await readAiSettings(s, false)).toEqual({
			available: true,
			provider: "anthropic",
			model: DEFAULT_MODEL,
			key: "sk-1",
			baseUrl: ANTHROPIC_BASE_URL,
		});
	});

	it("points Anthropic at aiBaseUrl only under allowPrivateNetwork (Ruling 7)", async () => {
		const s = settings({
			aiProvider: "anthropic",
			aiApiKey: "k",
			aiBaseUrl: "http://127.0.0.1:4580/",
		});
		expect(await readAiSettings(s, true)).toMatchObject({ baseUrl: "http://127.0.0.1:4580" });
		expect(await readAiSettings(s, false)).toMatchObject({ baseUrl: ANTHROPIC_BASE_URL });
	});

	it("refuses an invalid aiBaseUrl for Anthropic under allowPrivateNetwork, never the real API", async () => {
		const s = settings({ aiProvider: "anthropic", aiApiKey: "k", aiBaseUrl: "ftp://127.0.0.1/" });
		expect(await readAiSettings(s, true)).toEqual({
			available: false,
			reason: "bad_base_url",
			provider: "anthropic",
		});
	});

	it.each([
		["a missing key", { aiApiKey: undefined }, "no_key"],
		["an empty key (Fact D6)", { aiApiKey: "" }, "no_key"],
		["a whitespace key", { aiApiKey: " \t" }, "no_key"],
		[
			"a missing encryption key",
			{ aiApiKey: encryptionError("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING") },
			"key_unavailable",
		],
		[
			"an encryption key unknown to the stored envelope",
			{ aiApiKey: encryptionError("PLUGIN_SETTING_ENCRYPTION_KEY_UNKNOWN") },
			"key_unavailable",
		],
		[
			"a stored key that fails to decrypt",
			{ aiApiKey: encryptionError("PLUGIN_SETTING_DECRYPTION_FAILED") },
			"key_unavailable",
		],
		[
			"an invalid encryption key",
			{ aiApiKey: encryptionError("INVALID_ENCRYPTION_KEY") },
			"key_unavailable",
		],
		["no model for a compatible endpoint", { aiModel: " " }, "no_model"],
		["a model with a space", { aiModel: "gpt 5" }, "bad_model"],
		["a model of 201 characters", { aiModel: `m${"x".repeat(200)}` }, "bad_model"],
		["no base URL", { aiBaseUrl: undefined }, "bad_base_url"],
		["an http base URL", { aiBaseUrl: "http://llm.example/v1" }, "bad_base_url"],
	])("reports %s", async (_name, change, reason) => {
		const s = settings({
			aiProvider: "openai-compatible",
			aiApiKey: "k",
			aiModel: "local-model",
			aiBaseUrl: "https://llm.example/v1/",
			...change,
		});
		expect(await readAiSettings(s, false)).toEqual({
			available: false,
			reason,
			provider: "openai-compatible",
		});
	});

	it("rethrows any other settings error", async () => {
		const s = settings({ aiProvider: "anthropic", aiApiKey: encryptionError("DB_BUSY") });
		await expect(readAiSettings(s, false)).rejects.toThrow("DB_BUSY");
	});

	it("reads only aiProvider for ai: false (Ruling 64)", async () => {
		const s = settings({ aiProvider: "openai-compatible", aiApiKey: "k" });
		expect(await readAiProvider(s)).toBe("openai-compatible");
		expect(s.read).toEqual(["aiProvider"]);
		expect(await readAiProvider(settings({ aiProvider: "none" }))).toBeNull();
	});

	it("maps each reason to its warning, and off to none", () => {
		expect(
			(["off", "key_unavailable", "no_key", "no_model", "bad_model", "bad_base_url"] as const).map(
				warningFor,
			),
		).toEqual([
			null,
			"ai_key_unavailable",
			"ai_not_configured",
			"ai_not_configured",
			"ai_not_configured",
			"ai_url_blocked",
		]);
	});
});

describe("providerBaseUrl (spec Ruling 8)", () => {
	it.each([
		["https://llm.example/v1", "https://llm.example/v1"],
		["https://llm.example/v1/", "https://llm.example/v1"],
		["https://llm.example/v1//", "https://llm.example/v1"],
		["https://llm.example", "https://llm.example"],
		["http://llm.example/v1", null],
		["https://llm.example/v1?key=x", null],
		["https://llm.example/v1?", null],
		["https://llm.example/v1#x", null],
		["https://user:pw@llm.example/v1", null],
		["https://localhost/v1", null],
		["https://10.1.2.3/v1", null],
		["https://[::1]/v1", null],
		["not a url", null],
		["", null],
	])("%s gives %s", (text, expected) => {
		expect(providerBaseUrl(text, false)).toBe(expected);
	});

	it("allows http and private hosts only under allowPrivateNetwork", () => {
		expect(providerBaseUrl("http://127.0.0.1:4580/v1", true)).toBe("http://127.0.0.1:4580/v1");
		expect(providerBaseUrl("ftp://127.0.0.1/v1", true)).toBeNull();
	});
});

/** MemorySettings has `getVersioned` and `compareAndSet` like plugin KV; counted per call. */
function kv() {
	const store = new MemorySettings();
	const calls: string[] = [];
	return {
		store,
		calls,
		getVersioned: <T>(key: string) => {
			calls.push("get");
			return store.getVersioned<T>(key);
		},
		compareAndSet: (key: string, expected: string | null, value: unknown) => {
			calls.push("cas");
			return store.compareAndSet(key, expected, value);
		},
	};
}
const at = (iso: string) => () => Date.parse(iso);

describe('takeAiCall (spec "Rate limit and timeouts", Rulings 34, 66)', () => {
	it("allows 30 calls in a UTC hour and refuses the 31st, two queries a call", async () => {
		const k = kv();
		const now = at("2026-11-19T10:15:00Z");
		for (let i = 0; i < AI_CALLS_PER_HOUR; i++) expect(await takeAiCall(k, now)).toBe(true);
		expect(k.calls).toHaveLength(60);
		expect(await takeAiCall(k, now)).toBe(false);
		expect((await k.store.getVersioned(AI_USAGE_KEY))?.value).toEqual({
			hour: "2026-11-19T10",
			count: 30,
		});
	});

	it("starts a new count in the next hour", async () => {
		const k = kv();
		k.store.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 30 });
		expect(await takeAiCall(k, at("2026-11-19T11:00:00Z"))).toBe(true);
		expect((await k.store.getVersioned(AI_USAGE_KEY))?.value).toEqual({
			hour: "2026-11-19T11",
			count: 1,
		});
	});

	it("reads the hour again in each attempt, so a rollover between attempts counts afresh", async () => {
		// Attempt 1 at 10:59:59 reads 29 and loses its write to another call that takes the 30th;
		// attempt 2 at 11:00:00 must count the new hour, not refuse on the old one.
		const k = kv();
		k.store.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 29 });
		let lose = true;
		k.store.beforeWrite = () => {
			if (!lose) return;
			lose = false;
			k.store.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 30 });
		};
		const times = [Date.parse("2026-11-19T10:59:59Z"), Date.parse("2026-11-19T11:00:00Z")];
		let i = 0;
		const now = () => times[Math.min(i++, 1)] as number;
		expect(await takeAiCall(k, now)).toBe(true);
		expect((await k.store.getVersioned(AI_USAGE_KEY))?.value).toEqual({
			hour: "2026-11-19T11",
			count: 1,
		});
	});

	it("counts five lost compare-and-sets as limited, in at most 10 queries", async () => {
		const k = kv();
		k.store.beforeWrite = () => k.store.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 1 });
		expect(await takeAiCall(k, at("2026-11-19T10:15:00Z"))).toBe(false);
		expect(k.calls).toEqual(["get", "cas", "get", "cas", "get", "cas", "get", "cas", "get", "cas"]);
	});

	it("treats a malformed row as a fresh count and formats the hour in UTC", async () => {
		const k = kv();
		k.store.put(AI_USAGE_KEY, "garbage");
		expect(await takeAiCall(k, at("2026-11-19T23:30:00-02:00"))).toBe(true);
		expect(utcHour(Date.parse("2026-11-19T23:30:00-02:00"))).toBe("2026-11-20T01");
		expect(AI_USAGE_KEY.startsWith("settings:")).toBe(false);
	});

	it("reads a negative count as a fresh hour", async () => {
		const k = kv();
		k.store.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: -5 });
		expect(await takeAiCall(k, at("2026-11-19T10:15:00Z"))).toBe(true);
		expect((await k.store.getVersioned(AI_USAGE_KEY))?.value).toEqual({
			hour: "2026-11-19T10",
			count: 1,
		});
	});
});
