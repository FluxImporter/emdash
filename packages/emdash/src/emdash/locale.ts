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

/**
 * The configured locale a stored or requested locale stands for, as EmDash reads it
 * (`resolveConfiguredLocale`, `emdash` src/i18n/config.ts:43-61, not exported): a configured
 * locale in its configured casing, an Astro locale code (`{ path, codes }`, EmDash 1.3.1, #4224)
 * as its locale's path, and any other locale as given. Rows written before a site moved a locale
 * to `{ path: "en", codes: ["en-US"] }` keep the code `en-US`, and EmDash still reads them as `en`.
 */
export function canonicalLocale(
	locale: string,
	config: I18nConfig | null = getI18nConfig(),
): string {
	const lower = locale.toLowerCase();
	const configured = config?.locales.find((c) => c.toLowerCase() === lower);
	if (configured !== undefined) return configured;
	const alias = Object.entries(config?.localeAliases ?? {}).find(
		([code]) => code.toLowerCase() === lower,
	)?.[1];
	if (alias === undefined) return locale;
	return config?.locales.find((c) => c.toLowerCase() === alias.toLowerCase()) ?? alias;
}

/** Whether two locales stand for the same configured locale, ignoring case. */
export function sameSiteLocale(
	a: string,
	b: string,
	config: I18nConfig | null = getI18nConfig(),
): boolean {
	return canonicalLocale(a, config).toLowerCase() === canonicalLocale(b, config).toLowerCase();
}

export const I18N_REQUIRED_MESSAGE = "translationOf needs i18n with at least two locales";

/**
 * Resolves a template's `translationOf.locale` against the job's resolved `locale`: refused
 * without i18n with at least two locales (EmDash syncs shared values only then, spec M4e F6, F7;
 * the same test as `isI18nEnabled`, src/i18n/config.ts:81-85), resolved like `locale` when given,
 * and the site's default locale when left out. Either way it must differ from `locale`, which an
 * Astro locale code can hide (`en-US` for the locale `en`). Messages are whole template problems.
 */
export function resolveTranslationLocale(
	sourceLocale: string | undefined,
	locale: string,
	config: I18nConfig | null = getI18nConfig(),
): LocaleResolution {
	if (config === null || config.locales.length < 2) {
		return { ok: false, message: I18N_REQUIRED_MESSAGE };
	}
	if (sourceLocale === undefined) {
		if (config.defaultLocale.toLowerCase() === locale.toLowerCase()) {
			return {
				ok: false,
				message: `translationOf.locale is required: locale is the default locale ("${config.defaultLocale}")`,
			};
		}
		return { ok: true, locale: config.defaultLocale };
	}
	const resolved = resolveSiteLocale(sourceLocale, config);
	if (!resolved.ok) return { ok: false, message: `translationOf.locale: ${resolved.message}` };
	// The template check compares the locales as written; an Astro code can hide the same locale.
	if (sameSiteLocale(resolved.locale, locale, config)) {
		return {
			ok: false,
			message: `translationOf.locale must differ from locale ("${locale}")`,
		};
	}
	return resolved;
}
