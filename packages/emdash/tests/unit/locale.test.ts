import { describe, expect, it } from "vitest";
import {
	canonicalLocale,
	resolveSiteLocale,
	resolveTranslationLocale,
	sameSiteLocale,
} from "../../src/emdash/locale.js";

const i18n = { defaultLocale: "en", locales: ["en", "pt-BR"] };
/**
 * What EmDash stores for `locales: [{ path: "en", codes: ["en-US"] }, { path: "fr", codes:
 * ["fr-FR", "fr-CA"] }, "de"]` (emdash src/i18n/normalize.ts, EmDash 1.3.1, #4224).
 */
const paths = {
	defaultLocale: "en",
	locales: ["en", "fr", "de"],
	localeAliases: { "en-US": "en", "fr-FR": "fr", "fr-CA": "fr" },
};

describe("Astro locales with a path and codes", () => {
	it("resolves a code to its locale's path, as EmDash writes new rows", () => {
		expect(resolveSiteLocale("en-US", paths)).toEqual({ ok: true, locale: "en" });
		expect(resolveSiteLocale("FR-ca", paths)).toEqual({ ok: true, locale: "fr" });
		expect(resolveSiteLocale("fr", paths)).toEqual({ ok: true, locale: "fr" });
		expect(resolveSiteLocale("de-DE", paths)).toMatchObject({ ok: false });
	});

	it("reads a stored code as its locale, and other locales as given", () => {
		expect(canonicalLocale("en-us", paths)).toBe("en");
		expect(canonicalLocale("FR", paths)).toBe("fr");
		expect(canonicalLocale("es", paths)).toBe("es");
		expect(canonicalLocale("en-US", i18n)).toBe("en-US");
		expect(sameSiteLocale("en-US", "en", paths)).toBe(true);
		expect(sameSiteLocale("fr-FR", "fr-CA", paths)).toBe(true);
		expect(sameSiteLocale("en-US", "fr", paths)).toBe(false);
		expect(sameSiteLocale("en-US", "en", i18n)).toBe(false);
		expect(sameSiteLocale("PT-br", "pt-BR", i18n)).toBe(true);
	});

	it("resolves translationOf.locale codes, and refuses a code of the job's own locale", () => {
		expect(resolveTranslationLocale("en-US", "fr", paths)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale(undefined, "fr", paths)).toEqual({ ok: true, locale: "en" });
		expect(resolveTranslationLocale("fr-FR", "fr", paths)).toEqual({
			ok: false,
			message: 'translationOf.locale must differ from locale ("fr")',
		});
	});
});

describe("resolveSiteLocale", () => {
	it("returns the configured casing of a configured locale", () => {
		expect(resolveSiteLocale("EN", i18n)).toEqual({ ok: true, locale: "en" });
		expect(resolveSiteLocale("pt-br", i18n)).toEqual({ ok: true, locale: "pt-BR" });
	});

	it("rejects a locale the site does not configure", () => {
		expect(resolveSiteLocale("fr", i18n)).toEqual({
			ok: false,
			message: 'Locale "fr" is not configured for this site',
		});
	});

	it("without i18n accepts any valid locale code as given and rejects malformed ones", () => {
		expect(resolveSiteLocale("pt-BR", null)).toEqual({ ok: true, locale: "pt-BR" });
		expect(resolveSiteLocale("not a locale", null)).toMatchObject({ ok: false });
	});

	it("reads the config EmDash's middleware stores by default", () => {
		// emdash src/i18n/config.ts:17-37: the config lives on globalThis under this symbol.
		const store = globalThis as Record<symbol, unknown>;
		const key = Symbol.for("emdash:i18n-config");
		store[key] = i18n;
		try {
			expect(resolveSiteLocale("PT-BR")).toEqual({ ok: true, locale: "pt-BR" });
			expect(resolveSiteLocale("fr")).toMatchObject({ ok: false });
		} finally {
			delete store[key];
		}
		expect(resolveSiteLocale("fr")).toEqual({ ok: true, locale: "fr" });
	});
});
