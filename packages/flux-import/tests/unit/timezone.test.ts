import { describe, expect, it } from "vitest";
import { needsSiteTimezone, readSiteTimezone } from "../../src/emdash/timezone.js";

describe("readSiteTimezone", () => {
	it("reads the setting, falling back to UTC when it is not set", async () => {
		expect(await readSiteTimezone(async () => "Europe/Chisinau")).toBe("Europe/Chisinau");
		expect(await readSiteTimezone(async () => undefined)).toBe("UTC");
		expect(await readSiteTimezone(async () => " ")).toBe("UTC");
		// An invalid zone is passed on: job creation reports it for templates that use it.
		expect(await readSiteTimezone(async () => "Mars/Base")).toBe("Mars/Base");
	});
});

describe("needsSiteTimezone", () => {
	const template = (tz?: string) => ({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: { day: { from: "Day", type: "date", ...(tz === undefined ? {} : { tz }) } },
	});

	it("is true only for a valid template with a tz: site date mapping", () => {
		expect(needsSiteTimezone(template("site"))).toBe(true);
		expect(needsSiteTimezone(template("Europe/Chisinau"))).toBe(false);
		expect(needsSiteTimezone(template())).toBe(false);
		expect(needsSiteTimezone({ ...template("site"), version: 2 })).toBe(false);
		expect(needsSiteTimezone(null)).toBe(false);
	});
});
