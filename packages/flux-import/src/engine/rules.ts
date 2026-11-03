/**
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change, RecordPlan } from "./diff.js";
import { fingerprint, recordMappings } from "./fingerprints.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import type { MappedRecord, Template } from "./template.js";
import type { LinkRow, RecordError, RecordRow } from "./types.js";

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

/**
 * The mappings that count as edited outside the import (spec M5b "Protection"), from the link row
 * and the fingerprints of the entry's current values. With fingerprints, a mapping counts as
 * edited when its fingerprint is missing or differs; but a mapping other than a taxonomy whose
 * entry is still at the link's `writtenRev` is not edited, since only term edits leave `_rev` (F8)
 * and the read cannot show a slug staged in the importer's own draft (F13). Without fingerprints
 * (a link from before M5b), taxonomies always count as edited, and the rest unless the entry is
 * still at `writtenRev`.
 */
export function editedMappings(
	names: readonly string[],
	link: LinkRow,
	rev: string,
	current: Readonly<Record<string, string>>,
): Set<string> {
	const unmoved = link.writtenRev !== undefined && link.writtenRev === rev;
	const edited = new Set<string>();
	for (const name of names) {
		const taxonomy = name.startsWith("taxonomies.");
		const stored = link.fields?.[name];
		if (link.fields === undefined) {
			if (taxonomy || !unmoved) edited.add(name);
		} else if (stored === undefined) edited.add(name);
		else if ((taxonomy || !unmoved) && stored !== current[name]) edited.add(name);
	}
	return edited;
}

/**
 * The edited mappings that stay protected: those whose value as the record would write it has a
 * fingerprint other than the entry's current one. Protection lifts only on that equality, never
 * because the plan found no change: the plan ignores a media alt the template does not map,
 * which the write would still replace.
 */
export async function protectedMappings(
	edited: ReadonlySet<string>,
	current: Readonly<Record<string, string>>,
	sent: Readonly<Record<string, unknown>>,
): Promise<Set<string>> {
	const kept = new Set<string>();
	for (const name of edited) {
		if (!Object.hasOwn(sent, name) || (await fingerprint(sent[name])) !== current[name]) {
			kept.add(name);
		}
	}
	return kept;
}

export const FIELD_EDITED_MESSAGE =
	"Not updated: the value was changed outside the import since the import last wrote it";

/**
 * The plan without the changes of protected mappings, which are not written, and a `field_edited`
 * warning for each, in the plan's order (slug, data, media, Portable Text, links). A plan left
 * without changes is `unchanged`.
 */
export function protectPlan(
	plan: RecordPlan,
	record: MappedRecord,
	guarded: ReadonlySet<string>,
): { plan: RecordPlan; protectedNames: Set<string>; warnings: RecordError[] } {
	const names = recordMappings(record);
	const ordered = [...names.filter((n) => n === "slug"), ...names.filter((n) => n !== "slug")];
	const protectedNames = new Set(ordered.filter((name) => guarded.has(name)));
	const warnings = [...protectedNames].map((field) => ({
		field,
		code: "field_edited",
		message: FIELD_EDITED_MESSAGE,
	}));
	if (protectedNames.size === 0) return { plan, protectedNames, warnings };
	const changes = plan.changes.filter((change) => {
		const name = mappingOf(change, record);
		return name === null || !protectedNames.has(name);
	});
	const action = plan.action === "update" && changes.length === 0 ? "unchanged" : plan.action;
	return { plan: { action, changes }, protectedNames, warnings };
}
