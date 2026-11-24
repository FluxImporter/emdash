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
