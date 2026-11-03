/**
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change } from "./diff.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { RecordError, RecordRow } from "./types.js";

/**
 * Whether the template uses M5b's record rules: then the entry is looked up right after the key
 * is read, before any link, translation source or media lookup (spec M5b "Order of a record").
 */
export function ruled(t: Template): boolean {
	return t.rules !== undefined || t.publishAt !== undefined;
}

export const EXISTS_MESSAGE =
	"Skipped: the entry exists and the import only creates entries (mode create)";
export const NOT_FOUND_MESSAGE =
	"Skipped: no entry has this key and the import only updates entries (mode update)";

/**
 * The warning that skips a record under its write mode, or null when it goes on. `entry` is the
 * entry its link row names, read back. In `create` mode an entry the record's own earlier row was
 * writing, or names (a resumed or retried write), is finished as before, not skipped.
 */
export function modeSkip(
	t: Template,
	entry: EntrySnapshot | null,
	existing: RecordRow | null,
): RecordError | null {
	const mode = t.rules?.mode ?? "upsert";
	if (mode === "update" && entry === null) return { code: "not_found", message: NOT_FOUND_MESSAGE };
	if (mode !== "create" || entry === null) return null;
	const own = existing !== null && (existing.status === "writing" || existing.entryId === entry.id);
	return own ? null : { code: "exists", message: EXISTS_MESSAGE };
}

function pick<T>(
	values: Readonly<Record<string, T>>,
	keep: (name: string) => boolean,
	name: (key: string) => string = (key) => key,
): Record<string, T> {
	return Object.fromEntries(Object.entries(values).filter(([key]) => keep(name(key))));
}

/**
 * The record with only the mappings `keep` names (spec M5b "Only these fields"): an unlisted
 * mapping is then neither resolved, compared, written nor fingerprinted. The key, `translationOf`
 * and `publishAt` stay; a kind left without mappings is dropped.
 */
export function narrowRecord(record: MappedRecord, keep: (name: string) => boolean): MappedRecord {
	const out: MappedRecord = { key: record.key, data: pick(record.data, keep) };
	if (record.translationOf !== undefined) out.translationOf = record.translationOf;
	if (record.slug !== undefined && keep("slug")) out.slug = record.slug;
	if (record.publishAt !== undefined) out.publishAt = record.publishAt;
	const media = pick(record.media ?? {}, keep);
	if (Object.keys(media).length > 0) out.media = media;
	const portableText = pick(record.portableText ?? {}, keep);
	if (Object.keys(portableText).length > 0) out.portableText = portableText;
	const links: LinkRequests = {};
	const references = pick(record.links?.references ?? {}, keep);
	if (Object.keys(references).length > 0) links.references = references;
	const taxonomies = pick(record.links?.taxonomies ?? {}, keep, (name) => `taxonomies.${name}`);
	if (Object.keys(taxonomies).length > 0) links.taxonomies = taxonomies;
	if (record.links?.bylines !== undefined && keep("bylines")) links.bylines = record.links.bylines;
	if (Object.keys(links).length > 0) out.links = links;
	return out;
}

/**
 * The mapping a change belongs to: its field, with a media field's `.alt` folded into the field;
 * null for `translationOf` and `publishAt`, which are not mappings.
 */
export function mappingOf(change: Change, record: MappedRecord): string | null {
	const { field } = change;
	if (field === "translationOf" || field === "publishAt") return null;
	if (field.endsWith(".alt") && Object.hasOwn(record.media ?? {}, field.slice(0, -4))) {
		return field.slice(0, -4);
	}
	return field;
}

/** Whether two fingerprint maps hold the same names and values. */
export function sameFields(
	a: Readonly<Record<string, string>> | undefined,
	b: Readonly<Record<string, string>>,
): boolean {
	const left = a ?? {};
	const keys = Object.keys(b);
	return Object.keys(left).length === keys.length && keys.every((key) => left[key] === b[key]);
}
