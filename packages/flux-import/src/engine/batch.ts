import { SourceError, type SourceRecord } from "../sources/reader.js";
import {
	type Change,
	type CurrentLinks,
	comparisonsOf,
	type LinkPlan,
	type MediaPlanItem,
	type PlanAction,
	type PortableTextPlanItem,
	planRecord,
	type RecordPlan,
} from "./diff.js";
import {
	JobError,
	jobReader,
	jobTemplate,
	updateJob,
	upgradeJob,
	withoutPlannedTerms,
} from "./jobs.js";
import type { ResolvedLinks } from "./links.js";
import {
	DEFAULT_MAX_UPLOAD_SIZE,
	lookupRecordMedia,
	type MediaContext,
	MediaDeferred,
	type MediaLookup,
	mediaFieldValue,
	obtainRecordMedia,
	type ResolvedMedia,
} from "./media.js";
import {
	lookupPortableTextImages,
	obtainPortableTextImages,
	portableTextPlan,
	type RecordImages,
} from "./portable-text-images.js";
import {
	ContentWriteError,
	type EntrySnapshot,
	type LinkWrites,
	type MediaInfo,
	SourceMissingError,
} from "./ports.js";
import {
	COST_CALL,
	COST_READ,
	COST_RECORD,
	findTranslationSource,
	LookupCache,
	loadTerms,
	resolveLinks,
	sourceNotFoundMessage,
	termPath,
} from "./resolve.js";
import {
	applyTemplate,
	type CompiledTemplate,
	compileTemplate,
	type FieldValue,
	filterRecord,
	isSharedMapping,
	type MappedRecord,
	type MediaRequest,
	SOURCE_ID_FIELD,
} from "./template.js";
import {
	bump,
	type Counters,
	capErrors,
	capWarnings,
	type EngineDeps,
	emptyCounters,
	type Job,
	type LinkRow,
	linkKey,
	type RecordError,
	type RecordRow,
	recordKey,
} from "./types.js";

export const LEASE_GRACE_MS = 30_000;
/**
 * Media downloads must end this long after the batch's budget (`LookupCache.mediaDeadline`),
 * which leaves 10 s of the lease for the record's write and publish.
 */
export const MEDIA_GRACE_MS = 20_000;
const CAS_ATTEMPTS = 5;
/** Content errors that fail the job rather than the record being written. */
const JOB_LEVEL_WRITE_ERRORS: ReadonlySet<string> = new Set([
	"collection_missing",
	"source_id_field_invalid",
	"media_config",
]);

type Outcome = { done: boolean; error?: { code: string; message: string } };
type RowFields = Omit<RecordRow, "jobId" | "seq" | "start" | "end" | "updatedAt">;

const iso = (deps: EngineDeps) => new Date(deps.now()).toISOString();

function counterFor(row: RowFields): keyof Counters | null {
	switch (row.status) {
		case "planned":
			return row.action === "create"
				? "created"
				: row.action === "update"
					? "updated"
					: "unchanged";
		case "writing":
			return null;
		default:
			return row.status;
	}
}

async function claim(
	deps: EngineDeps,
	jobId: string,
	holder: string,
): Promise<{ ok: boolean; job: Job }> {
	const current = await deps.jobs.getVersioned(jobId);
	if (!current) throw new JobError("not_found", `Job ${jobId} not found`);
	const job = upgradeJob(current.value);
	const now = deps.now();
	if (job.status !== "created" && job.status !== "running") return { ok: false, job };
	// Any live lease blocks the claim, including one held under the same holder name.
	if (job.lease && job.lease.expiresAt > now) return { ok: false, job };
	const next: Job = {
		...job,
		status: "running",
		lease: { holder, expiresAt: now + job.budgetMs + LEASE_GRACE_MS },
		updatedAt: iso(deps),
	};
	const result = await deps.jobs.compareAndSet(jobId, current.revision, next);
	if (!result.applied) {
		const stored = await deps.jobs.get(jobId);
		return { ok: false, job: stored ? upgradeJob(stored) : job };
	}
	return { ok: true, job: next };
}

async function release(deps: EngineDeps, job: Job, holder: string, outcome: Outcome): Promise<Job> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.jobs.getVersioned(job.id);
		if (!current) throw new JobError("not_found", `Job ${job.id} not found`);
		const stored = current.value;
		if (stored.lease?.holder !== holder) return stored;
		let status = stored.status;
		if (status === "running")
			status = outcome.error ? "failed" : outcome.done ? "completed" : "running";
		const finishedRetry = outcome.done && job.phase === "retry";
		const next: Job = {
			...stored,
			status,
			cursor: job.cursor,
			counters: job.counters,
			schemaReady: job.schemaReady,
			phase: finishedRetry ? "import" : job.phase,
			retryFromSeq: job.retryFromSeq,
			...(job.plannedTerms ? { plannedTerms: job.plannedTerms } : {}),
			...(job.deferred ? { deferred: job.deferred } : {}),
			...(job.warnings ? { warnings: job.warnings } : {}),
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
			error: outcome.error ?? (stored.error?.code === "internal" ? null : stored.error),
			failures: 0,
			lease: null,
			updatedAt: iso(deps),
		};
		// A finished retry pass has no later batch to need the dry run's planned terms.
		if (!job.deferred) delete next.deferred;
		const saved = finishedRetry ? withoutPlannedTerms(next) : next;
		const result = await deps.jobs.compareAndSet(job.id, current.revision, saved);
		if (result.applied) return saved;
	}
	throw new Error(`Could not save job ${job.id} after ${CAS_ATTEMPTS} attempts`);
}

export async function processRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	opts: { retry: boolean; cache?: LookupCache },
): Promise<void> {
	const key = recordKey(job.id, rec.seq);
	const existing = await deps.records.get(key);
	if (existing && existing.status !== "writing" && !opts.retry) {
		// Only reached after a crash: the batch that wrote this row never saved its cursor and counters.
		const counter = counterFor(existing);
		if (counter) bump(job.counters, counter);
		return;
	}

	const base = { jobId: job.id, seq: rec.seq, start: rec.start, end: rec.end };
	// Every row is saved through here, so the caps hold whatever produced its errors and warnings.
	const save = (fields: RowFields) =>
		deps.records.put(key, {
			...base,
			...fields,
			...(fields.errors ? { errors: capErrors(fields.errors) } : {}),
			...(fields.warnings ? { warnings: capWarnings(fields.warnings) } : {}),
			updatedAt: iso(deps),
		});

	const cache = opts.cache ?? new LookupCache();
	const row = await decide(deps, job, template, rec, existing, save, cache);
	await save(row);
	if (existing && opts.retry) {
		const old = counterFor(existing);
		if (old) bump(job.counters, old, -1);
	}
	const counter = counterFor(row);
	if (counter) bump(job.counters, counter);
}

/** What the write helpers need about the record being processed. */
type RecordCtx = {
	deps: EngineDeps;
	job: Job;
	sourceKey: string;
	linkId: string;
	save: (fields: RowFields) => Promise<void>;
	/** The record's resolved links; absent when the template maps none. */
	links?: ResolvedLinks;
	/** The record's media field values, written with the data; absent when it maps none. */
	media?: Record<string, MediaPlanItem | null>;
	/** The record's Portable Text values, written with the data; absent when it maps none. */
	portableText?: Record<string, PortableTextPlanItem | null>;
	/**
	 * A linked create's source (M4e): its entry ID and the record's `translationOf` value;
	 * absent for an entry of its own.
	 */
	translationOf?: { sourceId: string; value: string };
};

const PENDING_DRAFT_MESSAGE =
	"Not imported: the entry has an unpublished draft that this import did not write";
const REV_CONFLICT_MESSAGE = "Not imported: the entry changed since it was read; retry to re-apply";
const LOCKED_MESSAGE = "Not imported: the entry is being edited (locked)";

function notImported(
	status: "conflict" | "locked",
	sourceKey: string,
	entryId: string,
	action: PlanAction,
	code: string,
	message: string,
): RowFields {
	return { status, sourceKey, entryId, action, errors: [{ code, message }] };
}

function publishFailed(
	reason: "conflict" | "locked",
	sourceKey: string,
	id: string,
	action: RecordRow["action"],
	writtenRev: string | undefined,
): RowFields {
	return {
		status: reason,
		sourceKey,
		entryId: id,
		...(action ? { action } : {}),
		...(writtenRev === undefined ? {} : { writtenRev }),
		errors: [
			{
				code: `publish_${reason}`,
				message:
					reason === "locked"
						? "Saved as a draft: the entry is locked, so it was not published"
						: "Saved as a draft: the entry changed before it could be published",
			},
		],
	};
}

/** Saves the link with the latest revision this importer produced for the entry. */
function putLink(ctx: RecordCtx, entryId: string, writtenRev: string): Promise<void> {
	const { collection, locale } = ctx.job.template;
	return ctx.deps.links.put(ctx.linkId, {
		collection,
		locale,
		sourceKey: ctx.sourceKey,
		entryId,
		writtenRev,
	});
}

async function publishRev(ctx: RecordCtx, id: string, rev: string) {
	const { collection, locale } = ctx.job.template;
	const published = await ctx.deps.content.publish({ collection, locale, id, rev });
	if (published.ok) await putLink(ctx, id, published.rev);
	return published;
}

/**
 * What the entry holds now for the mapped links: reference selections and explicit bylines from
 * the snapshot, and the assigned terms, each shown as the record log shows resolved ones.
 */
async function currentLinks(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot,
	resolved: ResolvedLinks,
): Promise<CurrentLinks> {
	const current: CurrentLinks = {};
	if (resolved.references) {
		current.references = {};
		for (const field of Object.keys(resolved.references)) {
			const refs = entry.references?.[field] ?? [];
			current.references[field] = refs.map((r) => ({ group: r.group, text: r.id }));
		}
		if (entry.referencesTruncated) current.referencesTruncated = entry.referencesTruncated;
	}
	if (resolved.taxonomies) {
		cache.spend(COST_CALL);
		const assigned = await deps.lookups.entryTerms(job.template.collection, entry.id);
		current.taxonomies = {};
		for (const taxonomy of Object.keys(resolved.taxonomies)) {
			const groups = assigned[taxonomy] ?? [];
			// A taxonomy given no value was not looked up; load it to show its terms as paths.
			if (groups.length > 0) await loadTerms(deps, cache, taxonomy, job.template.locale);
			current.taxonomies[taxonomy] = groups.map((group) => ({
				group,
				text: termPath(cache, taxonomy, group),
			}));
		}
	}
	if (resolved.bylines) {
		current.bylines = (entry.bylines ?? []).map((b) => ({ group: b.group, text: b.slug }));
	}
	return current;
}

/**
 * Whether the job's collection can be filtered by `flux_source_id`: a dry run does not add the
 * field, so it needs the collection to have it already (`sourceIdField`, read at job creation).
 */
function sourceIdReady(job: Job): boolean {
	return !job.dryRun || job.schemaReady || job.sourceIdField === true;
}

/**
 * Whether an earlier record of this dry run planned to create `key`: one indexed lookup of the
 * job's record rows per distinct key and batch (the batch adds its own plans as it makes them).
 */
async function plannedKey(
	deps: EngineDeps,
	job: Job,
	cache: LookupCache,
	key: string,
	seq: number,
): Promise<boolean> {
	const known = cache.plannedKeys.get(key);
	if (known !== undefined) return known;
	const page = await deps.records.query({
		// In the import pass only an earlier record counts: a row left by a crashed batch may be a
		// later one. A retry pass has every row of the first pass behind it.
		where: {
			jobId: job.id,
			sourceKey: key,
			status: "planned",
			...(job.phase === "import" ? { seq: { lt: seq } } : {}),
		},
		limit: 1,
	});
	const planned = page.items.some(({ data }) => data.action === "create");
	cache.plannedKeys.set(key, planned);
	return planned;
}

/** The link plan for `planRecord`; child-side reference fields compare as sets. */
async function linkPlan(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	resolved: ResolvedLinks,
): Promise<LinkPlan> {
	const childSide = new Set(
		Object.keys(resolved.references ?? {}).filter(
			(field) => job.targetFields?.[field]?.relationSide === "child",
		),
	);
	const current = entry ? await currentLinks(deps, cache, job, entry, resolved) : {};
	return { resolved, current, childSide };
}

/**
 * What a record found to create or download, and the warnings of its conversion and images,
 * listed on its row whatever happens to it.
 */
type Found = { newTerms: string[]; newMedia: string[]; warnings: RecordError[] };

/**
 * Decides and writes one record. Terms that resolution creates (or, in a dry run, would create)
 * are listed on the row as `newTerms`, media it downloads (or would) as `newMedia`, and what its
 * conversion and images reported as `warnings`, whatever happens to the record afterwards. A
 * retried record's warnings replace the earlier ones.
 */
async function decide(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
): Promise<RowFields> {
	const found: Found = { newTerms: [], newMedia: [], warnings: [] };
	const carried = job.deferred?.seq === rec.seq ? job.deferred : undefined;
	let row: RowFields;
	// Failures carried from the record's earlier batch apply to that record only: a later record
	// may take the same file in a field that accepts it.
	for (const { key, error } of carried?.failed ?? []) cache.mediaFailed.set(key, error);
	try {
		row = await decideRecord(deps, job, template, rec, existing, save, cache, found);
	} catch (e) {
		if (e instanceof MediaDeferred) {
			// Keep what this attempt created for the record's row in the next batch.
			const newTerms = [...new Set([...(carried?.newTerms ?? []), ...found.newTerms])];
			const newMedia = [
				...new Set([...(carried?.newMedia ?? []), ...found.newMedia, ...e.newMedia]),
			];
			const failed = new Map(
				[...(carried?.failed ?? []), ...e.failed].map((f) => [f.key, f] as const),
			);
			if (newTerms.length > 0 || newMedia.length > 0 || failed.size > 0) {
				job.deferred = {
					seq: rec.seq,
					newTerms,
					newMedia,
					...(failed.size > 0 ? { failed: [...failed.values()].slice(0, 50) } : {}),
				};
			}
		}
		throw e;
	} finally {
		// The identity check keeps a failure this batch recorded for the same URL itself.
		for (const { key, error } of carried?.failed ?? []) {
			if (cache.mediaFailed.get(key) === error) cache.mediaFailed.delete(key);
		}
	}
	// A retried or deferred record keeps the terms and media its earlier attempts created.
	const newTerms = [
		...new Set([...(existing?.newTerms ?? []), ...(carried?.newTerms ?? []), ...found.newTerms]),
	];
	const newMedia = [
		...new Set([...(existing?.newMedia ?? []), ...(carried?.newMedia ?? []), ...found.newMedia]),
	];
	if (carried) delete job.deferred;
	return {
		...row,
		...(newTerms.length > 0 ? { newTerms } : {}),
		...(newMedia.length > 0 ? { newMedia } : {}),
		...(found.warnings.length > 0 ? { warnings: found.warnings } : {}),
	};
}

function mediaContext(job: Job): MediaContext {
	return {
		jobId: job.id,
		dryRun: job.dryRun,
		maxBytes: job.mediaMaxBytes ?? DEFAULT_MAX_UPLOAD_SIZE,
		targets: job.targetFields ?? {},
	};
}

function mediaItem(request: MediaRequest, item: MediaInfo | null): MediaPlanItem {
	if (item === null) {
		const text = `new media from ${request.url}`;
		return { mediaId: null, value: null, text, alt: request.alt };
	}
	const value = mediaFieldValue(request.kind, item, request.alt);
	return { mediaId: item.id, value, text: item.id, alt: request.alt };
}

/**
 * The media plan before any download: a hit as its item, and a miss (or, in a real run, a hit
 * to refresh) as a file not stored yet, which is always a change.
 */
function lookedUpMedia(
	lookups: Readonly<Record<string, MediaLookup | null>>,
	dryRun: boolean,
	jobId: string,
): Record<string, MediaPlanItem | null> {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, lookup] of Object.entries(lookups)) {
		const stays =
			lookup?.item && (dryRun || !lookup.request.refresh || lookup.row?.jobId === jobId);
		plan[field] = lookup === null ? null : mediaItem(lookup.request, stays ? lookup.item : null);
	}
	return plan;
}

function obtainedMedia(media: Readonly<Record<string, ResolvedMedia>>) {
	const plan: Record<string, MediaPlanItem | null> = {};
	for (const [field, resolved] of Object.entries(media)) {
		plan[field] = resolved === null ? null : mediaItem(resolved.request, resolved.item);
	}
	return plan;
}

async function decideRecord(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	rec: SourceRecord,
	existing: RecordRow | null,
	save: (fields: RowFields) => Promise<void>,
	cache: LookupCache,
	found: Found,
): Promise<RowFields> {
	if (rec.error) return { status: "failed", sourceKey: null, entryId: null, errors: [rec.error] };
	const filter = await filterRecord(template, rec.value);
	if ("error" in filter) {
		return { status: "failed", sourceKey: null, entryId: null, errors: [filter.error] };
	}
	// A filtered record stops here: its key is not read and EmDash is never called.
	if (!filter.keep) return { status: "filtered", sourceKey: null, entryId: null };
	const mapped = await applyTemplate(template, rec.value);
	found.warnings.push(...(mapped.warnings ?? []));
	if (!mapped.ok)
		return { status: "failed", sourceKey: null, entryId: null, errors: mapped.errors };

	const { key: sourceKey } = mapped.value;
	const { collection, locale } = job.template;
	const ctx: RecordCtx = {
		deps,
		job,
		sourceKey,
		linkId: linkKey(collection, locale, sourceKey),
		save,
	};
	// Known so far, so that a ContentWriteError from any content call still reports it.
	let entryId: string | null = null;
	let action: PlanAction | undefined;
	try {
		const requests = mapped.value.links;
		const mediaRequests = mapped.value.media;
		const drafts = mapped.value.portableText;
		const hasImages = Object.values(drafts ?? {}).some((d) => d !== null && d.images.length > 0);
		// A template with translationOf looks entries up for every record (M4e).
		const translating = job.template.translationOf !== undefined;
		const lookingUp = requests !== undefined || translating;
		if (lookingUp || mediaRequests || hasImages) cache.spend(COST_RECORD);
		const errors: { field: string; code: string; message: string }[] = [];
		if (requests) {
			const resolution = await resolveLinks(
				deps,
				cache,
				{
					template: job.template,
					targets: job.targetFields ?? {},
					taxonomies: job.taxonomies ?? {},
					dryRun: job.dryRun,
					plannedKey: (key) => plannedKey(deps, job, cache, key, rec.seq),
					sourceIdReady: sourceIdReady(job),
				},
				requests,
			);
			found.newTerms = resolution.newTerms;
			if (resolution.ok) ctx.links = resolution.links;
			else errors.push(...resolution.errors);
		}
		// The entry this record translates, in the source locale; a miss is judged once the
		// record's own entry is known.
		const translates = mapped.value.translationOf;
		let source: { id: string; group: string } | null = null;
		if (translates !== undefined) {
			try {
				source = await findTranslationSource(
					deps,
					cache,
					collection,
					sourceLocaleOf(job),
					translates,
					sourceIdReady(job),
				);
			} catch (e) {
				if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
				errors.push({ field: "translationOf", code: e.code, message: e.message });
			}
		}
		// Media is looked up even when a link failed, so the record reports every error.
		let lookups: Record<string, MediaLookup | null> | undefined;
		if (mediaRequests) {
			const looked = await lookupRecordMedia(deps, cache, mediaContext(job), mediaRequests);
			lookups = looked.lookups;
			errors.push(...looked.errors);
		}
		let images: RecordImages | undefined;
		if (drafts) {
			const looked = await lookupPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				drafts,
				template.portableText,
			);
			images = looked.images;
			errors.push(...looked.errors);
			found.warnings.push(...looked.warnings);
		}
		if (errors.length > 0) return { status: "failed", sourceKey, entryId: null, errors };
		// Reference selections are read only when the template maps reference fields.
		const read = { references: requests?.references !== undefined };
		let link = await deps.links.get(ctx.linkId);
		if (link && lookingUp) cache.spend(COST_READ);
		let entry = link ? await deps.content.get(collection, locale, link.entryId, read) : null;
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null && sourceIdReady(job)) {
			if (lookingUp) cache.spend(COST_READ);
			// A translation's source ID is its source's key (spec M4e F1), which an editor's
			// translation carries too: such an entry is taken only for a row this job was writing
			// or that names it, and only in the source's group (an entry of its own whose key
			// equals the value is another record's). A record without a value in such a template
			// is an entry of its own, so it never takes a translation.
			const byValue = await deps.content.findBySourceId(
				collection,
				locale,
				translates ?? sourceKey,
				read,
			);
			const adopt =
				byValue !== null &&
				(translates === undefined
					? !translating || !isTranslation(byValue)
					: (existing.status === "writing" || existing.entryId === byValue.id) &&
						(source === null || (byValue.group ?? byValue.id) === source.group));
			if (byValue && adopt) {
				entry = byValue;
				link = { collection, locale, sourceKey, entryId: byValue.id };
				repaired = true;
			}
		}
		entryId = entry?.id ?? null;
		let translationChange: Change | undefined;
		if (translating) {
			const verdict = await checkTranslation(deps, cache, job, entry, translates, source);
			if ("error" in verdict) {
				return { status: "failed", sourceKey, entryId, errors: [verdict.error] };
			}
			found.warnings.push(...verdict.warnings);
			if (verdict.change && source && translates !== undefined) {
				ctx.translationOf = { sourceId: source.id, value: translates };
				translationChange = verdict.change;
			}
		} else if (entry && isTranslation(entry) && mapsShared(job)) {
			// A template without translationOf would send shared values that EmDash then syncs to
			// the whole group (M4e).
			return { status: "failed", sourceKey, entryId, errors: [sharedOnTranslation()] };
		}
		// A repaired link is saved only for an entry the record may write.
		if (repaired && link) await deps.links.put(ctx.linkId, link);
		const links = ctx.links ? await linkPlan(deps, cache, job, entry, ctx.links) : undefined;
		const comparisons = comparisonsOf(job.template, job.targetFields);
		// Before any download: a file or image not stored yet counts as a change.
		const media = lookups ? lookedUpMedia(lookups, job.dryRun, job.id) : undefined;
		if (drafts && images) {
			ctx.portableText = portableTextPlan(drafts, images);
			const required = emptiedRequired(ctx.portableText, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, errors: required };
			}
		}
		const plan = withChange(
			planRecord(entry, mapped.value, comparisons, links, media, ctx.portableText),
			translationChange,
		);
		action = plan.action;
		const misses = [...(images?.lookups ?? [])].filter(([url]) => !images?.items.has(url));
		if (job.dryRun) {
			if (plan.action === "create") cache.plannedKeys.set(sourceKey, true);
			for (const [field, item] of Object.entries(media ?? {})) {
				const url = mediaRequests?.[field]?.url;
				if (item?.mediaId === null && url) found.newMedia.push(`${field}: ${url}`);
			}
			// A URL an image field also downloads is listed once, under that field.
			const listed = new Set(Object.values(mediaRequests ?? {}).map((r) => r?.url));
			for (const [url, { field }] of misses) {
				if (!listed.has(url)) found.newMedia.push(`${field}: ${url}`);
			}
			return { status: "planned", sourceKey, entryId, action: plan.action, changes: plan.changes };
		}
		if (entry) {
			if (plan.action === "unchanged")
				return await finishUnchanged(ctx, entry, link, existing, repaired);
			if (entry.pendingPublish && entry.rev !== link?.writtenRev) {
				const code = "pending_draft";
				return notImported(
					"conflict",
					sourceKey,
					entry.id,
					plan.action,
					code,
					PENDING_DRAFT_MESSAGE,
				);
			}
			if (await deps.content.isLocked(collection, locale, entry.id)) {
				return notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
			}
		}
		if (!lookups && misses.length === 0) return await writeRecord(ctx, entry, plan, mapped.value);
		// Downloads only for a record that will be written, after the draft and lock checks: field
		// media first, then Portable Text images in document order.
		if (lookups) {
			const obtained = await obtainRecordMedia(deps, cache, mediaContext(job), lookups);
			found.newMedia = obtained.newMedia;
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			ctx.media = obtainedMedia(obtained.media);
		}
		if (drafts && images && misses.length > 0) {
			const obtained = await obtainPortableTextImages(
				deps,
				cache,
				mediaContext(job),
				images,
				found.newMedia,
			);
			found.warnings.push(...obtained.warnings);
			if (!obtained.ok) {
				return {
					status: "failed",
					sourceKey,
					entryId,
					action: plan.action,
					errors: obtained.errors,
				};
			}
			ctx.portableText = portableTextPlan(drafts, images);
			const required = emptiedRequired(ctx.portableText, job);
			if (required.length > 0) {
				return { status: "failed", sourceKey, entryId, action: plan.action, errors: required };
			}
		}
		const final = withChange(
			planRecord(entry, mapped.value, comparisons, links, ctx.media, ctx.portableText),
			translationChange,
		);
		action = final.action;
		if (entry && final.action === "unchanged") {
			return await finishUnchanged(ctx, entry, link, existing, repaired);
		}
		return await writeRecord(ctx, entry, final, mapped.value);
	} catch (e) {
		// A missing collection or a broken source-id field fails every record: fail the job instead.
		if (!(e instanceof ContentWriteError) || JOB_LEVEL_WRITE_ERRORS.has(e.code)) throw e;
		return {
			status: "failed",
			sourceKey,
			entryId,
			...(action ? { action } : {}),
			errors: [{ code: e.code, message: e.message }],
		};
	}
}

/** The plan with a linked create's `translationOf` change last (M4e). */
function withChange(plan: RecordPlan, change: Change | undefined): RecordPlan {
	return change === undefined ? plan : { ...plan, changes: [...plan.changes, change] };
}

/** The ID of the group's entry in `locale` (EmDash's casing ignored), or null when it has none. */
async function translationIn(
	deps: EngineDeps,
	collection: string,
	sourceId: string,
	locale: string,
): Promise<string | null> {
	const lower = locale.toLowerCase();
	const entries = await deps.content.translations(collection, sourceId);
	return entries.find((t) => t.locale.toLowerCase() === lower)?.id ?? null;
}

function translationExists(locale: string, id: string): RecordError {
	return {
		field: "translationOf",
		code: "translation_exists",
		message: `The source entry already has a translation in ${locale} (entry ${id}), which is not this record's entry`,
	};
}

/** Whether EmDash created the entry as a translation: its group is another entry's (spec M4e F3). */
function isTranslation(entry: EntrySnapshot): boolean {
	return (entry.group ?? entry.id) !== entry.id;
}

/**
 * Whether the template maps a value EmDash shares across a translation group: a field that is
 * not translatable (per the job's snapshot), a reference field or a taxonomy.
 */
function mapsShared(job: Job): boolean {
	const t = job.template;
	if (Object.keys(t.taxonomies ?? {}).length > 0) return true;
	return Object.entries(t.fields).some(([name, m]) => isSharedMapping(m, job.targetFields?.[name]));
}

function sharedOnTranslation(): RecordError {
	return {
		field: "translationOf",
		code: "translation_of_missing",
		message:
			"The entry is a translation of another entry: to update it, the template must map translationOf or drop its shared mappings, which would otherwise overwrite its translation group's values",
	};
}

/** The source locale of a template that maps `translationOf`; job creation always stores it. */
function sourceLocaleOf(job: Job): string {
	const locale = job.template.translationOf?.locale;
	if (locale === undefined) {
		throw new Error("Internal error: the job's template has no translationOf locale");
	}
	return locale;
}

/**
 * The decision table of spec M4e ("Resolution, diff and writes") for a template that maps
 * `translationOf`: an error fails the record; warnings go on its row; `change` marks a linked
 * create. `value` is the record's `translationOf` value, `source` what it found.
 */
async function checkTranslation(
	deps: EngineDeps,
	cache: LookupCache,
	job: Job,
	entry: EntrySnapshot | null,
	value: string | undefined,
	source: { id: string; group: string } | null,
): Promise<{ error: RecordError } | { warnings: RecordError[]; change?: Change }> {
	const { collection, locale } = job.template;
	const sourceLocale = sourceLocaleOf(job);
	const field = "translationOf";
	if (value === undefined) {
		// EmDash sets a translation's group to its source's (spec M4e F3).
		if (entry !== null && isTranslation(entry)) {
			return {
				error: {
					field,
					code: "translation_of_missing",
					message:
						"The entry is a translation, so the record needs a translationOf value: without one its shared values would overwrite its translation group's",
				},
			};
		}
		return { warnings: [] };
	}
	const missing = sourceNotFoundMessage(collection, sourceLocale, value);
	if (entry === null) {
		if (source === null) {
			return { error: { field, code: "translation_source_not_found", message: missing } };
		}
		cache.spend(COST_READ);
		const taken = await translationIn(deps, collection, source.id, locale);
		if (taken !== null) return { error: translationExists(locale, taken) };
		return { warnings: [], change: { field, before: null, after: `${sourceLocale}: ${value}` } };
	}
	if (source === null) {
		const message = `${missing}; the entry is updated without its source`;
		return { warnings: [{ field, code: "translation_source_not_found", message }] };
	}
	if ((entry.group ?? entry.id) !== source.group) {
		const message = `The entry is not a translation of ${sourceLocale}: ${value}, and EmDash cannot link an existing entry; trash it so the next run creates it as a translation`;
		return { warnings: [{ field, code: "translation_not_linked", message }] };
	}
	return { warnings: [] };
}

/**
 * A `required` error for each required Portable Text field that holds a value in the source but
 * is left empty once its dropped images are left out, which EmDash would refuse to write.
 */
function emptiedRequired(
	plan: Readonly<Record<string, PortableTextPlanItem | null>>,
	job: Job,
): RecordError[] {
	return Object.entries(plan)
		.filter(([field, item]) => item === null && job.targetFields?.[field]?.required === true)
		.map(([field]) => ({ field, code: "required", message: "The field is required" }));
}

/** The entry already holds the mapped data: finish an unfinished write or publish our own draft. */
async function finishUnchanged(
	ctx: RecordCtx,
	entry: EntrySnapshot,
	link: LinkRow | null,
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some((e) => e.code.startsWith("publish_"))));
	if (!unfinished) {
		// A pending draft at the revision this importer last produced is its own (an earlier
		// `publish: false` run or a failed publish), so publishing it puts no one else's work live.
		if (job.publish && entry.pendingPublish && link?.writtenRev === entry.rev) {
			const published = await publishRev(ctx, entryId, entry.rev);
			if (!published.ok)
				return publishFailed(published.reason, sourceKey, entryId, "update", entry.rev);
			return { status: "updated", sourceKey, entryId, action: "update" };
		}
		return { status: "unchanged", sourceKey, entryId };
	}
	const action = existing?.action;
	const writtenRev = existing?.writtenRev;
	// The recorded revision proves ownership only for the entry it was recorded for: revisions are
	// version-derived, so a different entry (an editor's copy) can carry the same string.
	const proven =
		writtenRev !== undefined && existing?.entryId === entry.id && entry.rev === writtenRev;
	if (job.publish && entry.pendingPublish) {
		// Publish only the exact revision this job wrote; anything newer may be an editor's draft.
		if (!proven) {
			return {
				status: "conflict",
				sourceKey,
				entryId,
				...(action ? { action } : {}),
				...(writtenRev === undefined ? {} : { writtenRev }),
				errors: [
					{
						code: "publish_unverified",
						message:
							"Saved as a draft: the entry may have changed after the import wrote it, so it was not published",
					},
				],
			};
		}
		const published = await publishRev(ctx, entryId, entry.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, entryId, action, writtenRev);
	} else if (!job.publish && proven && link?.writtenRev !== writtenRev) {
		// The crash came between saving the written revision and saving the link: the draft is
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev);
	}
	return {
		status: action === "create" ? "created" : "updated",
		sourceKey,
		entryId,
		...(action ? { action } : {}),
	};
}

/**
 * A linked create's links (M4e): only the bylines, always when mapped, an empty list included,
 * since EmDash copies the source's credits when none are given (spec M4e F5). Terms and
 * references are the translation group's.
 */
function translationLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	if (resolved?.bylines === undefined) return {};
	return { bylines: resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null })) };
}

/** A create's links: every non-empty one. New byline credits have no role label. */
function createLinks(resolved: ResolvedLinks | undefined): LinkWrites {
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (items.length === 0) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (items.length === 0) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && resolved.bylines.length > 0) {
		writes.bylines = resolved.bylines.map((b) => ({ bylineId: b.value, roleLabel: null }));
	}
	return writes;
}

/**
 * An update's links: only the changed ones, each replacing the entry's (an empty list clears
 * it). A byline the entry is already credited with keeps its role label.
 */
function updateLinks(
	resolved: ResolvedLinks | undefined,
	plan: RecordPlan,
	entry: EntrySnapshot,
): LinkWrites {
	const changed = new Set(plan.changes.map((c) => c.field));
	const writes: LinkWrites = {};
	for (const [taxonomy, items] of Object.entries(resolved?.taxonomies ?? {})) {
		if (!changed.has(`taxonomies.${taxonomy}`)) continue;
		writes.taxonomies ??= {};
		writes.taxonomies[taxonomy] = items.map((i) => i.value);
	}
	for (const [field, items] of Object.entries(resolved?.references ?? {})) {
		if (!changed.has(field)) continue;
		writes.references ??= {};
		writes.references[field] = items.map((i) => i.value);
	}
	if (resolved?.bylines && changed.has("bylines")) {
		const roles = new Map((entry.bylines ?? []).map((b) => [b.group, b.roleLabel]));
		writes.bylines = resolved.bylines.map((b) => ({
			bylineId: b.value,
			roleLabel: roles.get(b.group as string) ?? null,
		}));
	}
	return writes;
}

async function writeRecord(
	ctx: RecordCtx,
	entry: EntrySnapshot | null,
	plan: RecordPlan,
	mapped: MappedRecord,
): Promise<RowFields> {
	const { deps, job, sourceKey, save } = ctx;
	const { collection, locale } = job.template;
	await save({ status: "writing", sourceKey, entryId: entry?.id ?? null, action: plan.action });
	const slugPart = mapped.slug === undefined ? {} : { slug: mapped.slug };
	// Media and Portable Text fields are data fields: their values (null clears one) are written
	// with the rest.
	const media: Record<string, FieldValue> = {};
	for (const [field, item] of Object.entries(ctx.media ?? {})) media[field] = item?.value ?? null;
	for (const [field, item] of Object.entries(ctx.portableText ?? {})) {
		media[field] = item?.blocks ?? null;
	}
	const data = { ...mapped.data, ...media };
	let written: { id: string; rev: string };
	if (!entry && ctx.translationOf !== undefined) {
		const { sourceId, value } = ctx.translationOf;
		const created = await createTranslation(ctx, sourceId, value, plan, {
			collection,
			locale,
			...slugPart,
			// EmDash copies the source's source ID; sent so it is the same where the field is
			// translatable (spec M4e "Writes").
			data: { ...data, [SOURCE_ID_FIELD]: value },
			...translationLinks(ctx.links),
		});
		if ("status" in created) return created;
		written = created;
	} else if (!entry) {
		written = await deps.content.create({
			collection,
			locale,
			...slugPart,
			data: { ...data, [SOURCE_ID_FIELD]: sourceKey },
			...createLinks(ctx.links),
		});
	} else {
		// When only links changed, data and slug stay out: on a collection with revisions that
		// would stage a draft identical to the live entry. A media alt change is a data change.
		const dataChanged = plan.changes.some(
			(c) =>
				c.field === "slug" ||
				Object.hasOwn(data, c.field) ||
				(c.field.endsWith(".alt") && Object.hasOwn(media, c.field.slice(0, -4))),
		);
		const result = await deps.content.update({
			collection,
			locale,
			id: entry.id,
			rev: entry.rev,
			...(dataChanged ? { ...slugPart, data } : {}),
			...updateLinks(ctx.links, plan, entry),
		});
		if (!result.ok) {
			return result.reason === "conflict"
				? notImported(
						"conflict",
						sourceKey,
						entry.id,
						plan.action,
						"rev_conflict",
						REV_CONFLICT_MESSAGE,
					)
				: notImported("locked", sourceKey, entry.id, plan.action, "locked", LOCKED_MESSAGE);
		}
		written = { id: entry.id, rev: result.rev };
	}
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
		status: "writing",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		writtenRev: written.rev,
	});
	await putLink(ctx, written.id, written.rev);
	if (job.publish) {
		const published = await publishRev(ctx, written.id, written.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, written.id, plan.action, written.rev);
	}
	return {
		status: plan.action === "create" ? "created" : "updated",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		changes: plan.changes,
	};
}

/**
 * Creates the entry as a translation of `sourceId`, found by the source key `value`. A source
 * trashed since it was found fails `translation_source_not_found`; an entry another writer added
 * in the locale meanwhile (a `CONFLICT`) fails `translation_exists`.
 */
async function createTranslation(
	ctx: RecordCtx,
	sourceId: string,
	value: string,
	plan: RecordPlan,
	input: Omit<Parameters<EngineDeps["content"]["create"]>[0], "translationOf">,
): Promise<{ id: string; rev: string } | RowFields> {
	const { deps, sourceKey } = ctx;
	try {
		return await deps.content.create({ ...input, translationOf: sourceId });
	} catch (e) {
		if (!(e instanceof ContentWriteError)) throw e;
		const failed = (error: RecordError): RowFields => ({
			status: "failed",
			sourceKey,
			entryId: null,
			action: plan.action,
			errors: [error],
		});
		if (e.code === "emdash_not_found") {
			const sourceLocale = sourceLocaleOf(ctx.job);
			const message = `The source entry ${sourceId} (${sourceLocale}: ${value}) no longer exists`;
			return failed({ field: "translationOf", code: "translation_source_not_found", message });
		}
		if (e.code === "emdash_conflict") {
			const taken = await translationIn(deps, input.collection, sourceId, input.locale);
			if (taken !== null) return failed(translationExists(input.locale, taken));
		}
		throw e;
	}
}

async function importPass(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	const stream = await deps.source.open(job.uploadId, job.cursor.offset);
	let processed = 0;
	for await (const rec of jobReader(job).read(stream, {
		startOffset: job.cursor.offset,
		startSeq: job.cursor.seq,
	})) {
		try {
			await processRecord(deps, job, template, rec, { retry: false, cache });
		} catch (e) {
			// Not saved and not counted: the next batch processes the record again.
			if (e instanceof MediaDeferred) return { done: false };
			throw e;
		}
		job.cursor = { offset: rec.end, seq: rec.seq + 1 };
		processed++;
		if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
			return { done: false };
		}
	}
	return { done: true };
}

const RETRY_PAGE = 100; // plugin storage query limit

async function readOneRecord(deps: EngineDeps, job: Job, row: RecordRow): Promise<SourceRecord> {
	const stream = await deps.source.open(job.uploadId, row.start);
	for await (const rec of jobReader(job).read(stream, {
		startOffset: row.start,
		startSeq: row.seq,
	})) {
		return rec;
	}
	// CSV jobs keep the code they failed with before other formats existed.
	const code = (job.source?.format ?? "csv") === "csv" ? "csv_syntax" : "source_syntax";
	throw new SourceError(code, "No record at the saved offset", row.start);
}

/** Rebuilds counters from the record rows, so a crashed retry batch cannot leave them skewed. */
async function tallyCounters(deps: EngineDeps, jobId: string): Promise<Counters> {
	const counters = emptyCounters();
	let cursor: string | undefined;
	for (;;) {
		const page = await deps.records.query({
			where: { jobId },
			orderBy: { seq: "asc" },
			limit: RETRY_PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			const counter = counterFor(data);
			if (counter) bump(counters, counter);
		}
		if (!page.hasMore || !page.cursor) return counters;
		cursor = page.cursor;
	}
}

async function retryPass(
	deps: EngineDeps,
	job: Job,
	template: CompiledTemplate,
	started: number,
	limit: number,
	cache: LookupCache,
): Promise<Outcome> {
	let processed = 0;
	for (;;) {
		const page = await deps.records.query({
			where: {
				jobId: job.id,
				status: { in: ["failed", "conflict", "locked", "writing"] },
				seq: { gte: job.retryFromSeq },
			},
			orderBy: { seq: "asc" },
			limit: Math.min(limit, RETRY_PAGE),
		});
		if (page.items.length === 0) {
			job.counters = await tallyCounters(deps, job.id);
			return { done: true };
		}
		for (const { data: row } of page.items) {
			const rec = await readOneRecord(deps, job, row);
			try {
				await processRecord(deps, job, template, rec, { retry: true, cache });
			} catch (e) {
				if (e instanceof MediaDeferred) return { done: false };
				throw e;
			}
			job.retryFromSeq = row.seq + 1;
			processed++;
			if (processed >= limit || cache.exhausted || deps.now() - started >= job.budgetMs) {
				return { done: false };
			}
		}
	}
}

/**
 * Claims the job's lease, processes one bounded batch, saves cursor and counters, and releases
 * the lease. Returns the stored job without doing any work when the job is not runnable or any
 * live lease exists, whoever holds it (the same holder name included). A batch is at most
 * `job.batchSize` records, and at most `maxRecords` (or what it gives for the job) when that is
 * smaller; the job is not changed. Link and media lookups are cached for the batch, and the
 * batch ends after the record that brings their cost to `lookupBudget` (that record always
 * completes). Media downloads end by the budget plus `MEDIA_GRACE_MS`; a record whose next
 * download would start later is left for the next batch.
 */
export async function runBatch(
	deps: EngineDeps,
	jobId: string,
	holder: string,
	maxRecords: number | ((job: Job) => number) = Number.POSITIVE_INFINITY,
	lookupBudget = Number.POSITIVE_INFINITY,
): Promise<Job> {
	const claimed = await claim(deps, jobId, holder);
	if (!claimed.ok) return claimed.job;
	const job = claimed.job;
	const started = deps.now();
	const cap = typeof maxRecords === "number" ? maxRecords : maxRecords(job);
	const limit = Math.min(job.batchSize, cap);
	const cache = new LookupCache(job.dryRun ? (job.plannedTerms ?? []) : [], lookupBudget);
	cache.mediaDeadline = started + job.budgetMs + MEDIA_GRACE_MS;
	let outcome: Outcome;
	try {
		if (!job.dryRun && !job.schemaReady) {
			await deps.content.ensureSourceIdField(job.template.collection);
			job.schemaReady = true;
		}
		// Parsed once per batch and reused for every record; job creation already checked them.
		const compiled = compileTemplate(jobTemplate(job), {
			targets: job.targetFields,
			siteTimezone: job.siteTimezone,
			taxonomies: job.taxonomies,
			sharedRequired: job.sharedRequired,
		});
		if (!compiled.ok) {
			outcome = {
				done: false,
				error: { code: "invalid_template", message: compiled.problems.join("; ") },
			};
		} else {
			const template = compiled.compiled;
			outcome =
				job.phase === "retry"
					? await retryPass(deps, job, template, started, limit, cache)
					: await importPass(deps, job, template, started, limit, cache);
		}
	} catch (e) {
		if (e instanceof SourceMissingError) {
			outcome = { done: false, error: { code: "source_missing", message: e.message } };
		} else if (e instanceof ContentWriteError && JOB_LEVEL_WRITE_ERRORS.has(e.code)) {
			outcome = { done: false, error: { code: e.code, message: e.message } };
		} else if (e instanceof SourceError) {
			outcome = {
				done: false,
				error: { code: e.code, message: `${e.message} at byte ${e.offset}` },
			};
		} else {
			await noteFailure(deps, job.id, holder, e).catch(() => {
				// Keep the original error; the next driver retries as after a process death.
			});
			throw e;
		}
	}
	keepPlannedTerms(job, cache);
	return release(deps, job, holder, outcome);
}

const PLANNED_OVERFLOW_WARNING =
	"The dry run no longer tracks planned terms across batches: it would create more than 5,000";

/** Adds the terms this dry-run batch planned to the job, which the release saves. */
function keepPlannedTerms(job: Job, cache: LookupCache): void {
	if (!job.dryRun) return;
	if (cache.newPlanned.length > 0) {
		job.plannedTerms = [...(job.plannedTerms ?? []), ...cache.newPlanned];
	}
	if (cache.plannedOverflow && !job.warnings?.includes(PLANNED_OVERFLOW_WARNING)) {
		job.warnings = [...(job.warnings ?? []), PLANNED_OVERFLOW_WARNING];
	}
}

const MAX_FAILURES = 3;

/**
 * Records an unexpected error on the stored job. Cursor, counters and lease stay as they were, so
 * the next driver recovers exactly as after a process death; the third failure in a row fails
 * the job and drops the lease.
 */
async function noteFailure(deps: EngineDeps, jobId: string, holder: string, e: unknown) {
	const message = e instanceof Error ? e.message : String(e);
	await updateJob(deps, jobId, (stored) => {
		if (stored.lease?.holder !== holder) return stored;
		const failures = stored.failures + 1;
		const next: Job = { ...stored, error: { code: "internal", message }, failures };
		if (failures < MAX_FAILURES) return next;
		return { ...next, status: stored.status === "running" ? "failed" : stored.status, lease: null };
	});
}
