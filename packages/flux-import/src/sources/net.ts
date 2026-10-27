import { onWorkers } from "../emdash/workers.js";

/**
 * The SSRF guard for URL sources, modelled on EmDash core's internal `ssrfSafeFetch`
 * (`emdash` src/security/ssrf.ts), which is not exported. Sources are fetched with the runtime's
 * own `fetch()`, not `ctx.http.fetch()` (8 MiB buffered limit), so this module is the only check.
 *
 * Known gap, as in EmDash core: DNS can change between the check and the connection. On Workers,
 * Cloudflare's network refuses private ranges itself.
 */

export const MAX_REDIRECTS = 5;
export const URL_MAX_LENGTH = 2048;
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type UrlSourceErrorCode =
	| "URL_BLOCKED"
	| "FETCH_FAILED"
	| "HTTP_ERROR"
	| "TOO_MANY_REDIRECTS"
	| "TOO_LARGE"
	| "LENGTH_REQUIRED";

/** A fetch failure with its route error code. Messages never contain header values. */
export class UrlSourceError extends Error {
	constructor(
		readonly code: UrlSourceErrorCode,
		message: string,
	) {
		super(message);
		this.name = "UrlSourceError";
	}
}

/** Maps a hostname to its IPv4 and IPv6 addresses. */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface NetOptions {
	resolver: Resolver;
	/** Skips the hostname and address checks (development only; see `allowPrivateNetwork()`). */
	allowPrivateNetwork: boolean;
	fetch: typeof globalThis.fetch;
}

const blocked = (message: string) => new UrlSourceError("URL_BLOCKED", message);

/** Parses a source URL: `http:` or `https:`, no user name or password, at most 2,048 characters. */
export function parseSourceUrl(text: string): URL {
	if (text.length > URL_MAX_LENGTH) {
		throw blocked(`URLs are limited to ${URL_MAX_LENGTH} characters`);
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw blocked("The URL is not valid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw blocked(`The URL scheme "${url.protocol}" is not allowed; use http or https`);
	}
	if (url.username !== "" || url.password !== "") {
		throw blocked("URLs cannot contain a user name or password; use a credential");
	}
	if (url.href.length > URL_MAX_LENGTH) {
		throw blocked(`URLs are limited to ${URL_MAX_LENGTH} characters`);
	}
	return url;
}

const BLOCKED_NAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google",
	"metadata.google.internal",
	"instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** The URL's host without IPv6 brackets or trailing dots, lower-cased. */
export function hostOf(url: URL): string {
	return url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase();
}

export function isBlockedHostname(host: string): boolean {
	return BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Dotted-decimal IPv4 as an unsigned number; other forms are not addresses here. */
function parseIpv4(text: string): number | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (!match) return null;
	let value = 0;
	for (const part of match.slice(1) as string[]) {
		const n = Number(part);
		if (n > 255 || (part.length > 1 && part.startsWith("0"))) return null;
		value = value * 256 + n;
	}
	return value;
}

/** IPv6 as eight 16-bit groups, with an optional dotted IPv4 tail; zone IDs are not accepted. */
function parseIpv6(text: string): number[] | null {
	let rest = text;
	const tail: number[] = [];
	if (rest.includes(".")) {
		const colon = rest.lastIndexOf(":");
		const v4 = colon < 0 ? null : parseIpv4(rest.slice(colon + 1));
		if (v4 === null) return null;
		tail.push(Math.floor(v4 / 65536), v4 % 65536);
		rest = rest.slice(0, colon + 1);
		if (!rest.endsWith("::")) rest = rest.slice(0, -1);
	}
	const halves = rest.split("::");
	if (halves.length > 2) return null;
	const groups = (part: string) => (part === "" ? [] : part.split(":"));
	const head = groups(halves[0] ?? "");
	const after = halves.length === 2 ? groups(halves[1] ?? "") : [];
	if (![...head, ...after].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
	const count = head.length + after.length + tail.length;
	if (halves.length === 2 ? count > 7 : count !== 8) return null;
	const hex = (g: string) => Number.parseInt(g, 16);
	const zeros = new Array<number>(halves.length === 2 ? 8 - count : 0).fill(0);
	return [...head.map(hex), ...zeros, ...after.map(hex), ...tail];
}

/** [first address, prefix length] */
const BLOCKED_V4: Array<[number, number]> = [
	[0x00000000, 8], // 0.0.0.0/8
	[0x0a000000, 8], // 10/8
	[0x64400000, 10], // 100.64/10
	[0x7f000000, 8], // 127/8
	[0xa9fe0000, 16], // 169.254/16
	[0xac100000, 12], // 172.16/12
	[0xc0000000, 24], // 192.0.0/24
	[0xc0a80000, 16], // 192.168/16
	[0xc6120000, 15], // 198.18/15
	[0xe0000000, 3], // 224/4 and everything above it
];

function isPublicV4(address: number): boolean {
	return !BLOCKED_V4.some(([base, bits]) => {
		const size = 2 ** (32 - bits);
		return Math.floor(address / size) === Math.floor(base / size);
	});
}

/** The IPv4 address inside `::a.b.c.d`, `::ffff:a.b.c.d` and NAT64 `64:ff9b::a.b.c.d`. */
function embeddedV4(g: number[]): number | null {
	const zeroHead = g.slice(0, 5).every((x) => x === 0);
	const mapped = zeroHead && (g[5] === 0xffff || g[5] === 0);
	const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
	return mapped || nat64 ? (g[6] ?? 0) * 65536 + (g[7] ?? 0) : null;
}

function isPublicV6(g: number[]): boolean {
	// `::` and `::1` embed 0.0.0.0 and 0.0.0.1, both in 0.0.0.0/8.
	const v4 = embeddedV4(g);
	if (v4 !== null) return isPublicV4(v4);
	const first = g[0] ?? 0;
	// Only global unicast (2000::/3) is public: this excludes fc00::/7, fe80::/10 and ff00::/8.
	if ((first & 0xe000) !== 0x2000) return false;
	// Teredo (2001::/32) and 6to4 (2002::/16) carry IPv4 addresses; 2001:db8::/32 is documentation.
	if (first === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return false;
	return first !== 0x2002;
}

/** Whether `text` is an IP address (`null` when it is not one). */
export function isPublicAddress(text: string): boolean | null {
	const v4 = parseIpv4(text);
	if (v4 !== null) return isPublicV4(v4);
	const v6 = parseIpv6(text);
	return v6 === null ? null : isPublicV6(v6);
}

/**
 * The checks that need no DNS: hostname rules and IP literals. `URL` has already normalised
 * decimal, octal and hex IPv4 forms (`http://2130706433/` has the host `127.0.0.1`).
 */
export function checkHost(url: URL, allowPrivateNetwork: boolean): void {
	if (allowPrivateNetwork) return;
	const host = hostOf(url);
	if (isBlockedHostname(host)) throw blocked(`The host ${host} is not allowed`);
	if (isPublicAddress(host) === false) throw blocked(`The address ${host} is not public`);
}

async function checkAddresses(url: URL, net: NetOptions): Promise<void> {
	checkHost(url, net.allowPrivateNetwork);
	const host = hostOf(url);
	if (net.allowPrivateNetwork || isPublicAddress(host) !== null) return;
	let addresses: string[];
	try {
		addresses = await net.resolver(host);
	} catch (e) {
		throw new UrlSourceError("FETCH_FAILED", `Could not resolve ${host}: ${errorText(e)}`);
	}
	if (addresses.length === 0) {
		throw new UrlSourceError("FETCH_FAILED", `${host} has no addresses`);
	}
	if (!addresses.every((a) => isPublicAddress(a) === true)) {
		throw blocked(`${host} resolves to an address that is not public`);
	}
}

function errorText(e: unknown): string {
	const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
	return `${e instanceof Error ? e.message : String(e)}${cause}`;
}

/** Rejects with the abort reason when `signal` aborts; never resolves. */
export function whenAborted(signal: AbortSignal): Promise<never> {
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	aborted.catch(() => {});
	return aborted;
}

/** The abort reason when it is one of ours (a timeout), else a `FETCH_FAILED` for `e`. */
export function fetchError(e: unknown, signal: AbortSignal, context: string): UrlSourceError {
	if (e instanceof UrlSourceError) return e;
	if (signal.aborted && signal.reason instanceof UrlSourceError) return signal.reason;
	return new UrlSourceError("FETCH_FAILED", `${context}: ${errorText(e)}`);
}

export interface GuardedRequest {
	headers: Headers;
	/** Removed from the request once a redirect leaves the original origin. */
	credentialHeader?: string;
	signal: AbortSignal;
	/** Told each URL before it is fetched, so the caller knows the URL that answered. */
	onRequest?: (url: URL) => void;
}

/**
 * GETs `start`, following at most five redirects by hand and checking every URL, its host and
 * every address it resolves to before connecting. Returns the first response that is not a
 * redirect with a `Location`.
 */
export async function guardedFetch(
	start: string,
	request: GuardedRequest,
	net: NetOptions,
): Promise<Response> {
	const headers = new Headers(request.headers);
	const aborted = whenAborted(request.signal);
	let url = parseSourceUrl(start);
	for (let hop = 0; ; hop++) {
		const host = hostOf(url);
		try {
			await Promise.race([checkAddresses(url, net), aborted]);
		} catch (e) {
			throw fetchError(e, request.signal, `Could not resolve ${host}`);
		}
		let response: Response;
		request.onRequest?.(new URL(url.href));
		try {
			response = await net.fetch(url.href, {
				method: "GET",
				headers,
				redirect: "manual",
				signal: request.signal,
			});
		} catch (e) {
			throw fetchError(e, request.signal, `Could not fetch from ${host}`);
		}
		const location = REDIRECT_STATUSES.has(response.status)
			? response.headers.get("location")
			: null;
		if (location === null) return response;
		await response.body?.cancel().catch(() => {});
		if (hop === MAX_REDIRECTS) {
			throw new UrlSourceError("TOO_MANY_REDIRECTS", `More than ${MAX_REDIRECTS} redirects`);
		}
		let next: URL;
		try {
			next = parseSourceUrl(new URL(location, url).href);
		} catch (e) {
			throw e instanceof UrlSourceError ? e : blocked("A redirect points to an invalid URL");
		}
		if (request.credentialHeader !== undefined && next.origin !== url.origin) {
			headers.delete(request.credentialHeader);
		}
		url = next;
	}
}

/** Node: the system resolver, every address (`node:dns` `lookup(…, { all: true })`). */
export const nodeResolver: Resolver = async (hostname) => {
	const { lookup } = await import("node:dns/promises");
	const answers = await lookup(hostname, { all: true, verbatim: true });
	return answers.map((a) => a.address);
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Workers: DNS over HTTPS (`cloudflare-dns.com`, A and AAAA); `node:dns` lookups fail under
 * workerd. NXDOMAIN gives no addresses; any other failure rejects.
 */
export function dohResolver(
	fetchFn: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): Resolver {
	const query = async (name: string, type: "A" | "AAAA"): Promise<string[]> => {
		const response = await fetchFn(`${DOH_URL}?${new URLSearchParams({ name, type })}`, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`DNS over HTTPS answered ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body)) throw new Error("DNS over HTTPS gave an invalid answer");
		if (body.Status === 3) return [];
		if (body.Status !== 0) {
			throw new Error(`DNS over HTTPS failed with status ${String(body.Status)}`);
		}
		const want = type === "A" ? 1 : 28;
		const answers = Array.isArray(body.Answer) ? body.Answer : [];
		return answers.flatMap((a: unknown) =>
			isRecord(a) && a.type === want && typeof a.data === "string" ? [a.data] : [],
		);
	};
	return async (hostname) =>
		(await Promise.all([query(hostname, "A"), query(hostname, "AAAA")])).flat();
}

export function defaultResolver(): Resolver {
	return onWorkers() ? dohResolver() : nodeResolver;
}
