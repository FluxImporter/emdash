import { getI18nConfig, type I18nConfig, resolveContentCreateLocale } from "emdash";

export type LocaleResolution = { ok: true; locale: string } | { ok: false; message: string };

/**
 * Resolves a template locale the way EmDash resolves a create's locale
 * (`resolveContentCreateLocale`, `emdash` src/i18n/config.ts:54-76, called by handleContentCreate
 * at src/emdash-runtime.ts:3477): a configured locale matches case-insensitively and comes back in
 * the configured casing; with i18n configured any other locale is refused; without i18n any
 * valid locale code is kept as given. The config defaults to the one EmDash's middleware stores
 * (`getI18nConfig`, src/i18n/config.ts:35-37, set at src/astro/middleware.ts:170-187).
 */
export function resolveSiteLocale(
	locale: string,
	config: I18nConfig | null = getI18nConfig(),
): LocaleResolution {
	try {
		return { ok: true, locale: resolveContentCreateLocale(locale, config) };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}
