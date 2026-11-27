import { describe, expect, it } from "vitest";
import { resolveSiteLocale } from "../../src/emdash/locale.js";

const i18n = { defaultLocale: "en", locales: ["en", "pt-BR"] };

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
