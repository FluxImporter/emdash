import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError, isRetryable, readError, redact } from "../../src/admin/api-error.js";
import { interpolate, translate, translatePlural } from "../../src/admin/i18n.js";

const MSG = { id: "fluximporter.t.n", message: "Imported {count} of {total}" };

describe("translate (plan Ruling 2)", () => {
	it("interpolates English when the catalog has no entry, without calling i18n._", () => {
		const i18n = setupI18n({ locale: "fr", messages: { fr: {} } });
		const spy = vi.spyOn(i18n, "_");
		expect(translate(i18n, MSG, { count: 3, total: 10 })).toBe("Imported 3 of 10");
		expect(spy).not.toHaveBeenCalled();
	});

	it("uses a loaded catalog entry", () => {
		const i18n = setupI18n({ locale: "fr", messages: { fr: {} } });
		i18n.load("fr", { "fluximporter.t.n": ["Importé ", ["count"]] });
		expect(translate(i18n, MSG, { count: 3, total: 10 })).toBe("Importé 3");
	});

	it("leaves a placeholder without a value as it is", () => {
		expect(interpolate("{a} and {b}", { a: "x" })).toBe("x and {b}");
		expect(interpolate("No values {here}")).toBe("No values {here}");
		expect(interpolate("{n} records", { n: 0 })).toBe("0 records");
	});
});

describe("translatePlural", () => {
	const ENTRIES = { id: "t.entries", one: "{count} entry", other: "{count} entries" };
	it("picks the English form by count and formats the number for the locale", () => {
		const i18n = setupI18n({ locale: "en", messages: { en: {} } });
		expect(translatePlural(i18n, ENTRIES, 1)).toBe("1 entry");
		expect(translatePlural(i18n, ENTRIES, 0)).toBe("0 entries");
		expect(translatePlural(i18n, ENTRIES, 1200)).toBe("1,200 entries");
	});
	it("uses the catalog's form for the locale's plural category, then its other form", () => {
		const i18n = setupI18n({
			locale: "pl",
			messages: { pl: { "t.entries.few": "{count} wpisy", "t.entries.other": "{count} wpisów" } },
		});
		expect(translatePlural(i18n, ENTRIES, 3)).toBe("3 wpisy");
		expect(translatePlural(i18n, ENTRIES, 5)).toBe("5 wpisów");
	});
});

describe("readError (plan Ruling 3)", () => {
	it("reads code, message, status and details from an error envelope; HTTP_<status> otherwise", async () => {
		const envelope = Response.json(
			{
				success: false,
				error: { code: "INVALID_TEMPLATE", message: "Does not fit", details: { problems: ["x"] } },
			},
			{ status: 400 },
		);
		const e = await readError(envelope);
		expect(e).toBeInstanceOf(ApiError);
		expect(e).toMatchObject({
			code: "INVALID_TEMPLATE",
			message: "Does not fit",
			status: 400,
			details: { problems: ["x"] },
		});

		const noDetails = await readError(
			Response.json(
				{ success: false, error: { code: "CONFLICT", message: "Taken" } },
				{ status: 409 },
			),
		);
		expect(noDetails).toMatchObject({ code: "CONFLICT", status: 409, details: undefined });

		const html = await readError(new Response("<h1>Bad gateway</h1>", { status: 502 }));
		expect(html).toMatchObject({ code: "HTTP_502", status: 502 });

		const otherJson = await readError(Response.json({ error: "nope" }, { status: 500 }));
		expect(otherJson).toMatchObject({ code: "HTTP_500", status: 500 });
	});

	it("redacts upload IDs from server text", () => {
		const id = `01JZ0000000000000000000000${"a".repeat(32)}`;
		expect(redact(`Upload ${id} not found; ${id}`)).toBe(
			"Upload the uploaded file not found; the uploaded file",
		);
		expect(redact("Nothing to hide")).toBe("Nothing to hide");
	});
});

describe("isRetryable", () => {
	it("treats TypeError, 429 and 5xx as retryable, other 4xx not", () => {
		expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
		expect(isRetryable(new ApiError("RATE_LIMITED", "Slow down", 429))).toBe(true);
		expect(isRetryable(new ApiError("HTTP_500", "Oops", 500))).toBe(true);
		expect(isRetryable(new ApiError("HTTP_503", "Busy", 503))).toBe(true);
		expect(isRetryable(new ApiError("FORBIDDEN", "No", 403))).toBe(false);
		expect(isRetryable(new ApiError("NOT_FOUND", "Gone", 404))).toBe(false);
		expect(isRetryable(new ApiError("CONFLICT", "Taken", 409))).toBe(false);
		expect(isRetryable(new Error("other"))).toBe(false);
		expect(isRetryable("text")).toBe(false);
	});
});
