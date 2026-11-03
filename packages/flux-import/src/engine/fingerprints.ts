/**
 * Fingerprints of mapping values (spec M5b "Fingerprints"): one per mapping name, the SHA-256 of
 * the value's canonical form serialized as JSON with sorted object keys, cut to 12 bytes and
 * written as base64url (16 characters). Two values `planRecord` calls the same have the same
 * canonical form, so the fingerprint of what the importer wrote equals the fingerprint of what
 * the entry holds until someone changes it.
 */
import {
	type Comparison,
	type CurrentEntry,
	type CurrentItem,
	type CurrentLinks,
	canonicalPortableText,
	type MediaPlanItem,
	type PortableTextPlanItem,
} from "./diff.js";
import type { ResolvedItem, ResolvedLinks } from "./links.js";
import type { MappedRecord } from "./template.js";

/** The characters a stored fingerprint has. */
export const FINGERPRINT_LENGTH = 16;

/** JSON with object keys sorted at every level; `-0` is `0`, as JSON writes it. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function base64url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The fingerprint of a canonical form (Web Crypto, on Node 22 and workerd). */
export async function fingerprint(canonical: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableJson(canonical));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return base64url(digest.slice(0, 12));
}

/** EmDash stores booleans as 1 and 0 and reads them back as those numbers. */
const asBoolean = (value: unknown): unknown => (value === 1 ? true : value === 0 ? false : value);

/**
 * A data field's canonical form under its comparison (`diff.ts` `same`): booleans by truth value
 * (`boolean` and `deep`), instants as epoch milliseconds, and otherwise (`plain`, and `boolean`
 * for a value that is not one) a stored object as its JSON text, since EmDash reads text that
 * parses as JSON back parsed; `-0` is `0`, and an empty value null.
 */
export function canonicalData(value: unknown, how: Comparison): unknown {
	const v = value ?? null;
	if (v === null) return null;
	switch (how) {
		case "deep":
			return asBoolean(v);
		case "instant": {
			if (typeof v !== "string") return v;
			const t = Date.parse(v);
			return Number.isNaN(t) ? v : t;
		}
		default: {
			const x = how === "boolean" ? asBoolean(v) : v;
			if (typeof x === "object" && x !== null) return JSON.stringify(x);
			return Object.is(x, -0) ? 0 : x;
		}
	}
}

/** A stored image or file value's media ID: its `id`, or the value itself when it is a string. */
function mediaIdOf(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && "id" in value) {
		return typeof value.id === "string" ? value.id : null;
	}
	return null;
}

/**
 * An image or file value's canonical form: the media ID and the stored alt, whether or not the
 * template maps alt (an editor's alt change is an edit); null when empty.
 */
export function canonicalMedia(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	const alt =
		typeof value === "object" && "alt" in value && typeof value.alt === "string" ? value.alt : null;
	return { id: mediaIdOf(value), alt };
}

/**
 * A Portable Text value's canonical form: `canonicalPortableText`, null when empty, and a form of
 * its own for a value that is not Portable Text, which therefore always differs.
 */
export function canonicalRichText(value: unknown): unknown {
	if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
		return null;
	}
	return canonicalPortableText(value) ?? { notPortableText: stableJson(value) };
}

/** Linked items' translation groups, in order or sorted (a set); null when there are none. */
export function canonicalGroups(groups: readonly string[], ordered: boolean): unknown {
	if (groups.length === 0) return null;
	return ordered ? [...groups] : [...groups].sort();
}

/** The mapping names a mapped record carries, as `rules.updateFields` and the link row name them. */
export function recordMappings(record: MappedRecord): string[] {
	const links = record.links;
	return [
		...Object.keys(record.data),
		...Object.keys(record.media ?? {}),
		...Object.keys(record.portableText ?? {}),
		...(record.slug === undefined ? [] : ["slug"]),
		...Object.keys(links?.references ?? {}),
		...Object.keys(links?.taxonomies ?? {}).map((name) => `taxonomies.${name}`),
		...(links?.bylines === undefined ? [] : ["bylines"]),
	];
}

const groupsOf = (items: readonly CurrentItem[]) => items.map((i) => i.group);

/**
 * The canonical form of each mapping the record carries, as the entry holds it now: data, media
 * and Portable Text from the read (a pending draft's values first), the live slug, and the links
 * the plan compared. A truncated reference selection has a form that matches no written value.
 */
export function currentForms(
	entry: CurrentEntry,
	record: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	current: CurrentLinks,
	childSide: ReadonlySet<string>,
): Record<string, unknown> {
	const forms: Record<string, unknown> = {};
	const stored = (field: string) => (Object.hasOwn(entry.data, field) ? entry.data[field] : null);
	for (const field of Object.keys(record.data)) {
		forms[field] = canonicalData(stored(field), comparisons.get(field) ?? "plain");
	}
	for (const field of Object.keys(record.media ?? {})) forms[field] = canonicalMedia(stored(field));
	for (const field of Object.keys(record.portableText ?? {})) {
		forms[field] = canonicalRichText(stored(field));
	}
	if (record.slug !== undefined) forms.slug = entry.slug;
	for (const field of Object.keys(record.links?.references ?? {})) {
		const groups = groupsOf(current.references?.[field] ?? []);
		forms[field] = current.referencesTruncated?.includes(field)
			? { truncated: groups }
			: canonicalGroups(groups, !childSide.has(field));
	}
	for (const taxonomy of Object.keys(record.links?.taxonomies ?? {})) {
		forms[`taxonomies.${taxonomy}`] = canonicalGroups(
			groupsOf(current.taxonomies?.[taxonomy] ?? []),
			false,
		);
	}
	if (record.links?.bylines !== undefined) {
		forms.bylines = canonicalGroups(groupsOf(current.bylines ?? []), true);
	}
	return forms;
}

const resolvedGroups = (items: readonly ResolvedItem[]) =>
	items.flatMap((i) => (i.group === null ? [] : [i.group]));

/**
 * The canonical form of each mapping as the record writes it: the mapped data and slug, the
 * media and Portable Text values sent, and the resolved links' groups.
 */
export function sentForms(
	record: MappedRecord,
	comparisons: ReadonlyMap<string, Comparison>,
	links: ResolvedLinks | undefined,
	media: Readonly<Record<string, MediaPlanItem | null>> | undefined,
	portableText: Readonly<Record<string, PortableTextPlanItem | null>> | undefined,
	childSide: ReadonlySet<string>,
): Record<string, unknown> {
	const forms: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(record.data)) {
		forms[field] = canonicalData(value, comparisons.get(field) ?? "plain");
	}
	for (const [field, item] of Object.entries(media ?? {})) {
		forms[field] = canonicalMedia(item?.value ?? null);
	}
	for (const [field, item] of Object.entries(portableText ?? {})) {
		forms[field] = canonicalRichText(item?.blocks ?? null);
	}
	if (record.slug !== undefined) forms.slug = record.slug;
	for (const [field, items] of Object.entries(links?.references ?? {})) {
		forms[field] = canonicalGroups(resolvedGroups(items), !childSide.has(field));
	}
	for (const [taxonomy, items] of Object.entries(links?.taxonomies ?? {})) {
		forms[`taxonomies.${taxonomy}`] = canonicalGroups(resolvedGroups(items), false);
	}
	if (links?.bylines !== undefined) {
		forms.bylines = canonicalGroups(resolvedGroups(links.bylines), true);
	}
	return forms;
}

/** The fingerprint of each form, by mapping name. */
export async function fingerprintsOf(
	forms: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [name, form] of Object.entries(forms)) out[name] = await fingerprint(form);
	return out;
}
