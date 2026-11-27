export const HOME_URL = "/_emdash/admin/plugins/fluximporter/imports";
export const WIZARD_URL = "/_emdash/admin/plugins/fluximporter/import";
/** The website's guide to the import wizard ("How imports work"). */
export const WIZARD_GUIDE_URL = "https://www.fluximporter.com/emdash/guides/wizard/";

/** A job's Run screen in the wizard (plan Ruling 12). */
export function runUrl(jobId: string): string {
	return `${WIZARD_URL}?step=run&job=${encodeURIComponent(jobId)}`;
}

/** A saved template opened in the wizard (plan Ruling 12). */
export function templateUrl(templateId: string): string {
	return `${WIZARD_URL}?template=${encodeURIComponent(templateId)}`;
}

/** A full page load: the wizard reads its URL once, at mount. */
export function openPage(url: string): void {
	window.location.assign(url);
}
