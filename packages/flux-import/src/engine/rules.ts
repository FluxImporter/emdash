/**
 * Record rules (spec M5b): write modes, the `updateFields` scope, and the link row's
 * fingerprints. `batch.ts` applies them while it decides a record.
 */
import type { Change, RecordPlan } from "./diff.js";
import { fingerprint, recordMappings } from "./fingerprints.js";
import type { LinkRequests } from "./links.js";
import type { EntrySnapshot } from "./ports.js";
import { decodeRev } from "./revs.js";
import type { MappedRecord, Template } from "./template.js";
import type { Job, LinkRow, RecordError, RecordRow } from "./types.js";

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
 * and the fingerprints of the entry's current values. A mapping is always compared with its
 * fingerprint when it is a taxonomy (term edits leave `_rev`, F8), a reference field (edges set
 * from the other entry or through a translation leave it too, F19) or unconfirmed (its
 * fingerprint is not the value at `writtenRev`); it is edited when they differ. Any other
 * mapping is edited only once the entry has moved past `writtenRev` and its fingerprint differs:
 * an unmoved `_rev` vouches for it, also when the read cannot show a slug staged in the
 * importer's own draft (F13). A mapping without a fingerprint (every mapping of a link from
 * before M5b) is edited when it is always compared, or when the entry has moved. The scheduler's
 * publish moves `_rev` too and vouches for nothing: `sweptSince` cannot tell it from an editor's
 * unschedule and discard, and after a real sweep the importer's values are live and compare equal.
 */
export function editedMappings(
	names: readonly string[],
	link: LinkRow,
	rev: string,
	current: Readonly<Record<string, string>>,
	references: ReadonlySet<string> = new Set(),
): Set<string> {
	const unmoved = link.writtenRev !== undefined && link.writtenRev === rev;
	const unconfirmed = new Set(link.unconfirmed);
	const edited = new Set<string>();
	for (const name of names) {
		const compared =
			name.startsWith("taxonomies.") || references.has(name) || unconfirmed.has(name);
		const stored = link.fields?.[name];
		if (!compared && unmoved) continue;
		if (stored === undefined || stored !== current[name]) edited.add(name);
	}
	return edited;
}

/**
 * Whether the entry shows the scheduler's publish of the link's own schedule and nothing since
 * (Ruling 9, spec M5b F6): its `_rev` decodes to exactly one `version` past `writtenRev`, with
 * `updatedAt` at or after the link's `scheduledAt`, published, without a draft or a schedule. A
 * `writtenRev` that does not decode never passes. An editor who unschedules after the time and
 * then discards the draft leaves the same shape, so this proves ownership only where the values
 * are checked too (crash repair reaches it for an unchanged record; rollback); protection never
 * uses it.
 */
export function sweptSince(link: LinkRow, entry: EntrySnapshot): boolean {
	if (link.scheduledAt === undefined || link.writtenRev === undefined) return false;
	const now = decodeRev(entry.rev);
	const wrote = decodeRev(link.writtenRev);
	if (now === null || wrote === null) return false;
	return (
		now.version === wrote.version + 1 &&
		Date.parse(now.updatedAt) >= Date.parse(link.scheduledAt) &&
		entry.status === "published" &&
		!entry.hasDraft &&
		entry.scheduledAt === null
	);
}

/**
 * The mappings of a link save that `writtenRev` does not vouch for (spec M5b "Unconfirmed
 * fingerprints"): every protected mapping (`kept`), whether it keeps an old fingerprint or has
 * none; and each `carried` one (a fingerprint the record does not recompute) unless it was
 * confirmed and the entry, at `rev`, had not moved since the stored link's `writtenRev`.
 * Recomputed fingerprints describe what the importer wrote or found, so they are confirmed.
 */
export function unconfirmedOf(
	carried: readonly string[],
	kept: ReadonlySet<string>,
	stored: LinkRow | null,
	rev: string | null,
): string[] {
	const was = new Set(stored?.unconfirmed);
	const unmoved = stored?.writtenRev !== undefined && stored.writtenRev === rev;
	const out = new Set(kept);
	for (const name of carried) if (was.has(name) || !unmoved) out.add(name);
	return [...out];
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

/**
 * How far ahead a `publishAt` time must be to schedule (spec M5b "Bounded work"): EmDash refuses
 * a time that is not after its own clock (F2), and this absorbs the time between the record's
 * read and the schedule call. A nearer, past or empty time publishes now.
 */
export const SCHEDULE_LEAD_MS = 60_000;

/** When the record's content goes live: kept as a draft, published now, or scheduled at a time. */
export type Target = { kind: "draft" } | { kind: "now" } | { kind: "at"; at: string };

/** The record's target (spec M5b "Publish, draft or schedule"). */
export function targetOf(job: Job, record: MappedRecord, now: number): Target {
	if (!job.publish) return { kind: "draft" };
	const at = record.publishAt;
	if (at === undefined || at === null || Date.parse(at) - now < SCHEDULE_LEAD_MS) {
		return { kind: "now" };
	}
	return { kind: "at", at };
}

/** Whether two times name the same instant; null names none. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
	if (a === null || a === undefined || b === null || b === undefined) return a === b;
	return Date.parse(a) === Date.parse(b);
}

export const NOT_SCHEDULED_MESSAGE =
	"Not scheduled: the update went live at once (the collection keeps no revisions, or only terms and bylines changed)";

/**
 * Whether the importer's own pending state is what the entry shows (M2): a draft, a schedule or
 * a published entry's draft at the revision the link records.
 */
export function ownPending(entry: EntrySnapshot, link: LinkRow | null): boolean {
	return (entry.pendingPublish || entry.scheduledAt !== null) && link?.writtenRev === entry.rev;
}

/**
 * The schedule a record makes for target `at` (spec M5b decision table), as the change it adds
 * (`publishAt`, from the entry's schedule to `at`); or the `not_scheduled` warning when an update
 * of a published entry goes live at once; or nothing when the entry is already scheduled for
 * exactly `at` (an update keeps the schedule), when nothing is pending, or when the pending state
 * is someone else's.
 */
export function schedulePlan(
	job: Job,
	entry: EntrySnapshot | null,
	link: LinkRow | null,
	plan: RecordPlan,
	record: MappedRecord,
	at: string,
): { change: Change } | { warning: RecordError } | null {
	const change = { field: "publishAt", before: entry?.scheduledAt ?? null, after: at };
	if (entry === null) return { change };
	if (sameInstant(entry.scheduledAt, at)) return null;
	if (plan.action === "unchanged") return ownPending(entry, link) ? { change } : null;
	// Data, slug and references stage a draft on a collection with revisions (F7); terms and
	// bylines are written live.
	const stages =
		job.revisions !== false &&
		plan.changes.some((c) => {
			const name = mappingOf(c, record);
			return name !== null && name !== "bylines" && !name.startsWith("taxonomies.");
		});
	if (entry.status === "published" && !entry.hasDraft && !stages) {
		return { warning: { code: "not_scheduled", message: NOT_SCHEDULED_MESSAGE } };
	}
	return { change };
}

/**
 * Whether a resumed record's entry shows the schedule it was writing (spec M5b "Crash repair"):
 * the same version as the revision it wrote, with a later `updated_at` (a schedule moves only
 * that, F2), scheduled for `at`. False when either revision cannot be decoded.
 */
export function scheduleLanded(entry: EntrySnapshot, writtenRev: string, at: string): boolean {
	const now = decodeRev(entry.rev);
	const wrote = decodeRev(writtenRev);
	if (now === null || wrote === null) return false;
	return (
		now.version === wrote.version &&
		Date.parse(now.updatedAt) > Date.parse(wrote.updatedAt) &&
		sameInstant(entry.scheduledAt, at)
	);
}
