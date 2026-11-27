/**
 * The AI settings (M6d spec "Settings", "Reading the settings", Rulings 7, 8, 10, 12, 13). EmDash
 * stores no defaults (spec F5), so they are applied here. The key is read only when a call may
 * follow, and an encryption error reads as unavailable, never as a failed request.
 */
import type { SettingsAccess } from "emdash";
import { emdashErrorCode } from "../../emdash/errors.js";
import { checkHost, parseSourceUrl } from "../../sources/net.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
export const AI_SETTINGS = {
	provider: "aiProvider",
	key: "aiApiKey",
	model: "aiModel",
	baseUrl: "aiBaseUrl",
} as const;

export type AiProvider = "anthropic" | "openai-compatible";
export type AiUnavailableReason =
	| "off"
	| "key_unavailable"
	| "no_key"
	| "no_model"
	| "bad_model"
	| "bad_base_url";

export interface AiReady {
	available: true;
	provider: AiProvider;
	model: string;
	key: string;
	/** No trailing "/": the Anthropic SDK appends `/v1/messages`, the compatible client `/chat/completions`. */
	baseUrl: string;
}

export interface AiUnavailable {
	available: false;
	reason: AiUnavailableReason;
	/** Set for every reason but `off`. */
	provider?: AiProvider;
}

export type AiSettings = AiReady | AiUnavailable;
export type SettingsReader = Pick<SettingsAccess, "get">;

const isProvider = (v: unknown): v is AiProvider => v === "anthropic" || v === "openai-compatible";

/** Spec step 1: anything but the two providers (absent, "none", unknown) is off. */
export async function readAiProvider(settings: SettingsReader): Promise<AiProvider | null> {
	const value = await settings.get<unknown>(AI_SETTINGS.provider);
	return isProvider(value) ? value : null;
}

/** Ruling 8: https (http only under allowPrivateNetwork), no user info, query or fragment, a public host. */
export function providerBaseUrl(text: string, allowPrivate: boolean): string | null {
	let url: URL;
	try {
		url = parseSourceUrl(text.trim());
		if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return null;
		// The href keeps an empty "?" or "#", which `search` and `hash` report as "".
		if (url.href.includes("?") || url.href.includes("#")) return null;
		checkHost(url, allowPrivate);
	} catch {
		return null;
	}
	return url.href.replace(/\/+$/, "");
}

/** Spec F6: EmDash's settings decryption errors, which make a stored key unreadable. */
function isEncryptionError(e: unknown): boolean {
	const code = emdashErrorCode(e);
	return (
		code !== undefined && (code.startsWith("PLUGIN_SETTING_") || code === "INVALID_ENCRYPTION_KEY")
	);
}

/**
 * Spec "Reading the settings": settings are read in order, stopping at the first reason the AI
 * is unavailable.
 */
export async function readAiSettings(
	settings: SettingsReader,
	allowPrivate: boolean,
): Promise<AiSettings> {
	const provider = await readAiProvider(settings);
	if (provider === null) return { available: false, reason: "off" };
	const unavailable = (reason: AiUnavailableReason): AiUnavailable => ({
		available: false,
		reason,
		provider,
	});

	let stored: unknown;
	try {
		stored = await settings.get<unknown>(AI_SETTINGS.key);
	} catch (e) {
		if (isEncryptionError(e)) return unavailable("key_unavailable");
		throw e;
	}
	const key = typeof stored === "string" ? stored.trim() : "";
	if (key === "") return unavailable("no_key");

	const modelValue = await settings.get<unknown>(AI_SETTINGS.model);
	let model = typeof modelValue === "string" ? modelValue.trim() : "";
	if (model === "") {
		if (provider === "openai-compatible") return unavailable("no_model");
		model = DEFAULT_MODEL;
	}
	if (!MODEL_RE.test(model)) return unavailable("bad_model");

	let baseUrl: string | null = ANTHROPIC_BASE_URL;
	if (provider === "openai-compatible") {
		const text = await settings.get<unknown>(AI_SETTINGS.baseUrl);
		baseUrl = providerBaseUrl(typeof text === "string" ? text : "", allowPrivate);
	} else if (allowPrivate) {
		// Ruling 7: development only, so tests reach the fake server.
		const text = await settings.get<unknown>(AI_SETTINGS.baseUrl);
		if (typeof text === "string" && text.trim() !== "") baseUrl = providerBaseUrl(text, true);
	}
	if (baseUrl === null) return unavailable("bad_base_url");

	return { available: true, provider, model, key, baseUrl };
}

/** The route's warning for a reason; `off` is a normal configuration and warns nothing (Ruling 12). */
export function warningFor(reason: AiUnavailableReason): string | null {
	switch (reason) {
		case "off":
			return null;
		case "key_unavailable":
			return "ai_key_unavailable";
		case "no_key":
		case "no_model":
		case "bad_model":
			return "ai_not_configured";
		case "bad_base_url":
			return "ai_url_blocked";
	}
}
