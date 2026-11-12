/**
 * The owner stamp on a link row (spec M5c "Owner"): which template's jobs created the entry, so
 * that template's missing phase may remove it. Only a create stamps it, a link save of the same
 * owner keeps it, and any record of another owner, or of none, drops it.
 */
import type { Job, LinkRow } from "./types.js";

/** The job's `rules.owner`; undefined when its template names none. */
export function ownerOf(job: Job): string | undefined {
	return job.template.rules?.owner;
}

/** Whether the link carries an owner stamp that is not this job's (Rulings 2, 21). */
export function foreignStamp(job: Job, link: LinkRow | null): boolean {
	return link?.owner !== undefined && link.owner !== ownerOf(job);
}

/**
 * The owner fields a link save of this job carries: the job's owner and URL source when it
 * created the entry (`stamp`), the stored ones when the stored link has the job's owner, else
 * none, which drops a foreign stamp.
 */
export function ownership(
	job: Job,
	stored: LinkRow | null,
	stamp: boolean,
): Pick<LinkRow, "owner" | "ownerSource"> {
	const owner = ownerOf(job);
	if (owner === undefined) return {};
	if (stamp) return { owner, ...(job.sourceId === undefined ? {} : { ownerSource: job.sourceId }) };
	if (stored?.owner !== owner) return {};
	return {
		owner,
		...(stored.ownerSource === undefined ? {} : { ownerSource: stored.ownerSource }),
	};
}

/** The link without its owner stamp, every other field kept. */
export function withoutStamp(link: LinkRow): LinkRow {
	const { owner: _owner, ownerSource: _source, ...rest } = link;
	return rest;
}
