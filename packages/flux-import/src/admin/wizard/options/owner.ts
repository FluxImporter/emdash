import type { TemplateSummary } from "../../../plugin/templates.js";

/**
 * Another saved template whose imports would share `owner` in `locale` (Ruling 15): the two
 * imports then behave as one, and each one's missing phase can touch the other's entries.
 * `others` are the collection's templates; `selfId` is the template this import runs or saves
 * to, which is no clash with itself.
 */
export function ownerClash(
	owner: string,
	locale: string,
	others: readonly TemplateSummary[],
	selfId: string | null,
): TemplateSummary | null {
	return others.find((t) => t.id !== selfId && t.owner === owner && t.locale === locale) ?? null;
}
