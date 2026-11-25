import type { SourceRow } from "../../../plugin/sources.js";

/**
 * A source's address as the list shows it (plan Ruling 19): host and path only. The userinfo and
 * the query may hold a secret, and the fragment is never needed. Text that is not a URL gives "".
 */
export function urlLabel(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname}`;
	} catch {
		return "";
	}
}

/**
 * Where a source's last fetch stands: the newer of `lastFetch` and `lastError`. A failure carries
 * its code only, never the message (which can quote the address with its query).
 */
export function lastFetchState(
	row: Pick<SourceRow, "lastFetch" | "lastError">,
):
	| { kind: "never" }
	| { kind: "fetched"; at: string }
	| { kind: "failed"; at: string; code: string } {
	const { lastFetch, lastError } = row;
	if (lastError && (!lastFetch || Date.parse(lastError.at) > Date.parse(lastFetch.at))) {
		return { kind: "failed", at: lastError.at, code: lastError.code };
	}
	if (lastFetch) return { kind: "fetched", at: lastFetch.at };
	return { kind: "never" };
}

const SIZE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** A fetch's size in the viewer's words ("4 kB", "1.2 MB"), in steps of 1,024 bytes. */
export function sizeLabel(bytes: number, locale: string): string {
	let n = bytes;
	let unit = 0;
	while (n >= 1024 && unit < SIZE_UNITS.length - 1) {
		n /= 1024;
		unit += 1;
	}
	return new Intl.NumberFormat(locale || "en", {
		style: "unit",
		unit: SIZE_UNITS[unit],
		unitDisplay: "short",
		maximumFractionDigits: unit === 0 ? 0 : 1,
	}).format(n);
}
