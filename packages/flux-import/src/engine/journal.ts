import type { CurrentLinks } from "./diff.js";
import type { EntrySnapshot } from "./ports.js";
import { sameStored } from "./rollback-values.js";
import { SOURCE_ID_FIELD } from "./template.js";
import {
	type EngineDeps,
	type Job,
	type JournalBefore,
	type JournalEntry,
	journalKey,
	type LinkRow,
	MAX_JOURNAL_BYTES,
	type RecordError,
} from "./types.js";

const CAS_ATTEMPTS = 5;

/** Whether the job keeps a journal: a real import created with `journal: true` (M5a). */
export function journaling(job: Job): boolean {
	return job.journal === true && !job.dryRun && job.kind !== "rollback";
}

/** Where a record's journal row goes and what it names. */
export type JournalTarget = {
	deps: EngineDeps;
	job: Job;
	seq: number;
	sourceKey: string;
	linkId: string;
	/**
	 * The job may already have written the entry: the link row read before this write names the
	 * job, or the record's earlier row was `writing`. Only then does a stored row keep its first
	 * touch's values; otherwise the earlier attempt wrote nothing and the row is replaced.
	 */
	mayHaveWritten: boolean;
	/** The record's earlier row was `writing`: this write resumes a stopped one (final review I2). */
	resuming?: boolean;
	/** The link row read before this write; a resumed write it names at the entry's `_rev` is known. */
	link?: LinkRow | null;
};

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

function base(t: JournalTarget): Omit<JournalEntry, "kind" | "entryId"> {
	const { collection, locale } = t.job.template;
	return {
		jobId: t.job.id,
		seq: t.seq,
		collection,
		locale,
		sourceKey: t.sourceKey,
		at: iso(t.deps),
	};
}

function tooLarge(row: JournalEntry): RecordError | null {
	const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
	if (bytes <= MAX_JOURNAL_BYTES) return null;
	return {
		code: "journal_too_large",
		message: `Not imported: what the entry holds now is ${bytes} bytes, more than the journal keeps (${MAX_JOURNAL_BYTES}); import with journal: false to skip rollback support`,
	};
}

/**
 * The fields whose draft and live values differ: what publishing the entry's pending draft makes
 * live. Empty when the entry has no draft.
 */
export function draftFields(entry: EntrySnapshot): string[] {
	const live = entry.live;
	if (live === undefined) return [];
	const fields = new Set([...Object.keys(live), ...Object.keys(entry.data)]);
	fields.delete(SOURCE_ID_FIELD);
	return [...fields].filter((f) => !sameStored(live[f], entry.data[f]));
}

/** What a write is about to change, for `preImage`. */
export type Touched = {
	/** Data fields the write changes or publishes. */
	fields: readonly string[];
	slug: boolean;
	taxonomies: readonly string[];
	references: readonly string[];
	bylines: boolean;
	/** The write publishes a pending draft and the template maps references: see `referencesUnknown`. */
	referencesUnknown: boolean;
};

/**
 * The entry's pre-image for the fields and links a write touches, read from the snapshot the
 * import already made (`current` for the terms). A changed reference field whose selection was
 * truncated cannot be restored: `journal_incomplete`.
 */
export function preImage(
	entry: EntrySnapshot,
	link: LinkRow | null,
	touched: Touched,
	current: CurrentLinks | undefined,
): JournalBefore | RecordError {
	const truncated = touched.references.filter((f) => entry.referencesTruncated?.includes(f));
	if (truncated.length > 0) {
		return {
			field: truncated[0] as string,
			code: "journal_incomplete",
			message:
				"Not imported: the field holds more references than the import reads, so a rollback could not restore it",
		};
	}
	const live: Record<string, unknown> = {};
	const draft: Record<string, unknown> = {};
	for (const field of touched.fields) {
		live[field] = (entry.live ?? entry.data)[field] ?? null;
		if (entry.live) draft[field] = entry.data[field] ?? null;
	}
	const links: NonNullable<JournalBefore["links"]> = {};
	for (const taxonomy of touched.taxonomies) {
		links.taxonomies ??= {};
		links.taxonomies[taxonomy] = (current?.taxonomies?.[taxonomy] ?? []).map((t) => t.group);
	}
	for (const field of touched.references) {
		links.references ??= {};
		links.references[field] = (entry.references?.[field] ?? []).map((r) => r.id);
	}
	if (touched.bylines) {
		links.bylines = (entry.bylines ?? []).map((b) => ({ bylineId: b.id, roleLabel: b.roleLabel }));
	}
	return {
		link: link === null ? null : linkBefore(link),
		rev: entry.rev,
		status: entry.status,
		scheduledAt: entry.scheduledAt,
		...(touched.slug ? { slug: entry.slug } : {}),
		live,
		...(entry.live ? { draft } : {}),
		...(Object.keys(links).length > 0 ? { links } : {}),
		...(touched.referencesUnknown ? { referencesUnknown: true as const } : {}),
	};
}

function linkBefore(link: LinkRow): NonNullable<JournalBefore["link"]> {
	return {
		...(link.jobId === undefined ? {} : { jobId: link.jobId }),
		...(link.writtenRev === undefined ? {} : { writtenRev: link.writtenRev }),
		...(link.fields === undefined ? {} : { fields: link.fields }),
		...(link.unconfirmed === undefined ? {} : { unconfirmed: link.unconfirmed }),
		...(link.scheduledAt === undefined ? {} : { scheduledAt: link.scheduledAt }),
	};
}

/**
 * The first touch's pre-image with what a later write of the same job adds: fields and links the
 * earlier writes did not touch, read before this write (so still the pre-run value). Status,
 * schedule and the link row stay the first touch's. Null when nothing is new.
 */
export function mergeBefore(first: JournalBefore, next: JournalBefore): JournalBefore | null {
	let changed = false;
	const merged: JournalBefore = structuredClone(first);
	for (const [field, value] of Object.entries(next.live)) {
		if (Object.hasOwn(merged.live, field)) continue;
		merged.live[field] = value;
		// A field the earlier writes did not touch has the same draft and live value then.
		if (merged.draft) merged.draft[field] = next.draft?.[field] ?? value;
		changed = true;
	}
	if (next.slug !== undefined && merged.slug === undefined) {
		merged.slug = next.slug;
		changed = true;
	}
	for (const kind of ["taxonomies", "references"] as const) {
		for (const [name, items] of Object.entries(next.links?.[kind] ?? {})) {
			if (merged.links?.[kind]?.[name] !== undefined) continue;
			merged.links ??= {};
			merged.links[kind] ??= {};
			(merged.links[kind] as Record<string, string[]>)[name] = items;
			changed = true;
		}
	}
	if (next.links?.bylines && !merged.links?.bylines) {
		merged.links ??= {};
		merged.links.bylines = next.links.bylines;
		changed = true;
	}
	if (next.referencesUnknown && !merged.referencesUnknown) {
		merged.referencesUnknown = true;
		changed = true;
	}
	return changed ? merged : null;
}

/**
 * What the job wrote so far with what a later write of it adds: each taxonomy's groups as the
 * latest write left them; the scheduled data (each write's covers the entry's whole data), slug
 * and `publishedAt` of the latest write that recorded them. Undefined when nothing is held.
 */
function mergeWrote(
	first: JournalEntry["wrote"],
	next: JournalEntry["wrote"],
): JournalEntry["wrote"] {
	const taxonomies = next?.taxonomies
		? { ...first?.taxonomies, ...next.taxonomies }
		: first?.taxonomies;
	const fields = next?.fields ?? first?.fields;
	const slug = next?.slug ?? first?.slug;
	const publishedAt = next?.publishedAt !== undefined ? next.publishedAt : first?.publishedAt;
	const out = {
		...(taxonomies ? { taxonomies } : {}),
		...(fields ? { fields } : {}),
		...(slug === undefined ? {} : { slug }),
		...(publishedAt === undefined ? {} : { publishedAt }),
	};
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Write-ahead for an update: stores the pre-image before the job's first write to the entry
 * (put-if-absent), or adds what this write touches first to the row an earlier write stored. A
 * row an attempt stored that never wrote (`mayHaveWritten` false) is replaced, since the entry
 * may have changed since. A row too large fails the record before any write.
 */
export async function journalUpdate(
	t: JournalTarget,
	entryId: string,
	before: JournalBefore,
	wrote?: NonNullable<JournalEntry["wrote"]>,
): Promise<RecordError | null> {
	const key = journalKey(t.job.id, t.linkId);
	const row: JournalEntry = {
		...base(t),
		kind: "update",
		entryId,
		before,
		...(wrote?.taxonomies || wrote?.fields ? { wrote } : {}),
	};
	const large = tooLarge(row);
	if (large) return large;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		if ((await t.deps.journal.compareAndSet(key, null, row)).applied) return null;
		const stored = await t.deps.journal.getVersioned(key);
		if (!stored) continue;
		if (!t.mayHaveWritten) {
			if ((await t.deps.journal.compareAndSet(key, stored.revision, row)).applied) return null;
			continue;
		}
		// The job created the entry: rolling back deletes it, whatever it wrote afterwards.
		if (stored.value.kind !== "update" || stored.value.before === undefined) return null;
		const first = stored.value.before;
		let merged = mergeBefore(first, before);
		// Resuming a stopped write: when the entry moved since the first read, the stopped write
		// may have landed, or someone may have edited the entry meanwhile; neither can be told.
		// Not when the link names this job at the entry's revision: the entry is as this job (an
		// earlier record of it, or the stopped write itself) left it.
		const ownRev = t.link?.jobId === t.job.id && t.link.writtenRev === before.rev;
		if (t.resuming && first.rev !== before.rev && !ownRev && !first.uncertain) {
			merged = { ...(merged ?? structuredClone(first)), uncertain: true };
		}
		const after = mergeWrote(stored.value.wrote, wrote);
		const wroteChanged =
			JSON.stringify(after ?? null) !== JSON.stringify(stored.value.wrote ?? null);
		if (merged === null && !wroteChanged) return null;
		const next: JournalEntry = {
			...stored.value,
			before: merged ?? first,
			...(after ? { wrote: after } : {}),
		};
		const larger = tooLarge(next);
		if (larger) return larger;
		if ((await t.deps.journal.compareAndSet(key, stored.revision, next)).applied) return null;
	}
	throw new Error(`Could not save the journal row ${key} after ${CAS_ATTEMPTS} attempts`);
}

/**
 * Write-ahead for a create: `entryId` stays null until the create returns. A create row an
 * earlier attempt stored is kept; an update row (its entry has gone since) is replaced.
 */
export async function journalCreate(
	t: JournalTarget,
	sourceIdValue: string,
	wrote?: NonNullable<JournalEntry["wrote"]>,
): Promise<void> {
	const key = journalKey(t.job.id, t.linkId);
	const row: JournalEntry = {
		...base(t),
		kind: "create",
		entryId: null,
		sourceIdValue,
		...(wrote?.fields ? { wrote } : {}),
	};
	if ((await t.deps.journal.compareAndSet(key, null, row)).applied) return;
	const stored = await t.deps.journal.get(key);
	if (stored?.kind === "create") return;
	await t.deps.journal.put(key, row);
}

/**
 * Records the entry of a create row: `confirmed` when this job's create returned it, not when
 * crash repair found it (it may be an editor's). A row that already names an entry is kept.
 */
export async function journalCreated(
	t: Pick<JournalTarget, "deps" | "job" | "linkId">,
	entryId: string,
	confirmed: boolean,
): Promise<void> {
	const key = journalKey(t.job.id, t.linkId);
	const stored = await t.deps.journal.get(key);
	if (stored?.kind !== "create") return;
	if (stored.entryId !== null && !confirmed) return;
	await t.deps.journal.put(key, { ...stored, entryId, confirmed });
}
