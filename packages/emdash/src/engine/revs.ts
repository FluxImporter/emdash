/**
 * EmDash's `_rev` (spec M5b F1): base64 of `<version>:<updatedAt>` (`emdash` src/api/rev.ts:19-40).
 * EmDash fences every mutation on both parts. The importer decodes it only where the spec says
 * so (a resumed schedule, ownership after the scheduler), and fails closed when it cannot.
 */
export type DecodedRev = { version: number; updatedAt: string };

/** The `_rev` of a version and `updated_at`, as EmDash encodes it. */
export function encodeRev(version: number, updatedAt: string): string {
	return btoa(`${version}:${updatedAt}`);
}

/** The version and `updated_at` a `_rev` names; null when it is not one EmDash would write. */
export function decodeRev(rev: string): DecodedRev | null {
	let text: string;
	try {
		text = atob(rev);
	} catch {
		return null;
	}
	const colon = text.indexOf(":");
	if (colon === -1) return null;
	const versionText = text.slice(0, colon);
	const version = Number(versionText);
	const updatedAt = text.slice(colon + 1);
	if (!/^\d+$/.test(versionText) || updatedAt === "" || Number.isNaN(Date.parse(updatedAt))) {
		return null;
	}
	return { version, updatedAt };
}
