import { getSiteSetting } from "emdash";
import { templateSchema, usesSiteTimezone } from "../engine/template.js";

/**
 * The site's timezone setting (`site:timezone`, read with `getSiteSetting`, `emdash`
 * src/settings/index.ts:182-203), or UTC when it is not set.
 */
export async function readSiteTimezone(
	read: () => Promise<string | undefined> = () => getSiteSetting("timezone"),
): Promise<string> {
	const tz = await read();
	return typeof tz === "string" && tz.trim() !== "" ? tz : "UTC";
}

/**
 * Whether a template from a request reads dates in the site timezone. An invalid template does
 * not: job creation reports its problems without reading the setting.
 */
export function needsSiteTimezone(template: unknown): boolean {
	const parsed = templateSchema.safeParse(template);
	return parsed.success && usesSiteTimezone(parsed.data);
}
