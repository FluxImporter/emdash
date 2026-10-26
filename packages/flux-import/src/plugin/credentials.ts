import type { PluginContext } from "emdash";
import { emdashErrorCode } from "../emdash/errors.js";
import type { Credential } from "../sources/fetcher.js";
import { ServiceError } from "./service.js";

/**
 * Named credentials live as one JSON object in the `credentials` setting, declared
 * `type: "secret"` so EmDash stores it encrypted (AES-GCM, `EMDASH_ENCRYPTION_KEY`; Fact S1).
 * Nothing here returns a value to a caller outside the fetcher.
 */

export const CREDENTIALS_SETTING = "credentials";
export const CREDENTIAL_NAME = /^[a-z0-9-]{1,64}$/;
/** An HTTP token (RFC 9110 section 5.6.2). */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;
/** Printable ASCII, space and tab: no CR, LF or other control characters. */
export const HEADER_VALUE = /^[\t\x20-\x7e]{1,4096}$/;
/** Headers a credential may not set: framing, hop-by-hop, and the ones the fetcher owns. */
export const FORBIDDEN_HEADERS = new Set([
	"host",
	"cookie",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"upgrade",
	"if-none-match",
	"if-modified-since",
]);

const CAS_ATTEMPTS = 5;

export type CredentialSettings = Pick<PluginContext["settings"], "getVersioned" | "compareAndSet">;

export interface CredentialInfo {
	name: string;
	header: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The rules `credentials/set` applies. Stored entries are checked again because the admin
 * settings page can write any text (Fact S3), and a runtime header error could quote the value.
 */
function isValid(
	name: string,
	entry: Record<string, unknown>,
): entry is Record<string, unknown> & Credential {
	const { header, value } = entry;
	return (
		CREDENTIAL_NAME.test(name) &&
		typeof header === "string" &&
		HEADER_NAME.test(header) &&
		!FORBIDDEN_HEADERS.has(header.toLowerCase()) &&
		typeof value === "string" &&
		HEADER_VALUE.test(value)
	);
}

/**
 * Reads the stored JSON. A value that is not that JSON (the admin settings page can overwrite
 * the field with any text) reads as no credentials, so the next `credentials/set` replaces it.
 */
function parse(value: unknown): Map<string, Credential> {
	const out = new Map<string, Credential>();
	if (typeof value !== "string") return out;
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return out;
	}
	if (!isRecord(data)) return out;
	for (const [name, entry] of Object.entries(data)) {
		if (isRecord(entry) && isValid(name, entry)) {
			out.set(name, { header: entry.header, value: entry.value });
		}
	}
	return out;
}

/** EmDash's encryption errors (a missing or malformed key) become a 500 without the value. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		const code = emdashErrorCode(e) ?? "";
		if (code.startsWith("PLUGIN_SETTING_") || code === "INVALID_ENCRYPTION_KEY") {
			const message = e instanceof Error ? e.message : code;
			throw new ServiceError(
				"CREDENTIALS_UNAVAILABLE",
				`Credentials are unavailable: ${message}`,
				500,
			);
		}
		throw e;
	}
}

async function read(
	settings: CredentialSettings,
): Promise<{ credentials: Map<string, Credential>; revision: string | null }> {
	const current = await guarded(() => settings.getVersioned<string>(CREDENTIALS_SETTING));
	return { credentials: parse(current?.value), revision: current?.revision ?? null };
}

async function update(
	settings: CredentialSettings,
	change: (credentials: Map<string, Credential>) => void,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const { credentials, revision } = await read(settings);
		change(credentials);
		const value = JSON.stringify(Object.fromEntries(credentials));
		const result = await guarded(() =>
			settings.compareAndSet(CREDENTIALS_SETTING, revision, value),
		);
		if (result.applied) return;
	}
	throw new ServiceError("CONFLICT", "The credentials changed during the update; try again", 409);
}

/** Adds or replaces a credential. Returns its name and header, never its value. */
export async function setCredential(
	settings: CredentialSettings,
	name: string,
	credential: Credential,
): Promise<CredentialInfo> {
	await update(settings, (credentials) => {
		credentials.set(name, { header: credential.header, value: credential.value });
	});
	return { name, header: credential.header };
}

export async function deleteCredential(
	settings: CredentialSettings,
	name: string,
): Promise<{ deleted: true }> {
	let found = false;
	await update(settings, (credentials) => {
		found = credentials.delete(name);
	});
	if (!found) throw new ServiceError("NOT_FOUND", `Credential "${name}" not found`, 404);
	return { deleted: true };
}

export async function listCredentials(settings: CredentialSettings): Promise<CredentialInfo[]> {
	const { credentials } = await read(settings);
	return [...credentials.entries()]
		.map(([name, { header }]) => ({ name, header }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The credential with its value, for the fetcher only; `null` when there is none. */
export async function getCredential(
	settings: CredentialSettings,
	name: string,
): Promise<Credential | null> {
	return (await read(settings)).credentials.get(name) ?? null;
}
