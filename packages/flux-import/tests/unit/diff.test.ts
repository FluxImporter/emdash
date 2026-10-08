import { describe, expect, it } from "vitest";
import { dateFieldsOf, planRecord } from "../../src/engine/diff.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Set(["released"]);
const next = {
	key: "A1",
	slug: "desk",
	data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00.000Z", note: null },
};

describe("planRecord", () => {
	it("plans a create with every non-null field and the slug", () => {
		expect(planRecord(null, next, dates)).toEqual({
			action: "create",
			changes: [
				{ field: "slug", before: null, after: "desk" },
				{ field: "title", before: null, after: "Desk" },
				{ field: "price", before: null, after: 12.5 },
				{ field: "released", before: null, after: "2026-03-01T08:00:00.000Z" },
			],
		});
	});

	it("is unchanged when values match, treating undefined as null and dates by instant", () => {
		const current = {
			slug: "desk",
			data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00Z" },
		};
		expect(planRecord(current, next, dates)).toEqual({ action: "unchanged", changes: [] });
	});

	it("lists only the fields that differ", () => {
		const current = {
			slug: "old-desk",
			data: { title: "Desk", price: 10, released: "2026-03-01T08:00:00Z", note: "x" },
		};
		expect(planRecord(current, next, dates)).toEqual({
			action: "update",
			changes: [
				{ field: "slug", before: "old-desk", after: "desk" },
				{ field: "price", before: 10, after: 12.5 },
				{ field: "note", before: "x", after: null },
			],
		});
	});

	it("ignores the slug when the template does not map one", () => {
		const { slug: _s, ...noSlug } = next;
		const current = {
			slug: "anything",
			data: { title: "Desk", price: 12.5, released: "2026-03-01T08:00:00Z" },
		};
		expect(planRecord(current, noSlug, dates).action).toBe("unchanged");
	});

	it("treats an unparseable stored date as different", () => {
		const current = { slug: "desk", data: { title: "Desk", price: 12.5, released: "garbage" } };
		expect(planRecord(current, next, dates).changes.map((c) => c.field)).toEqual(["released"]);
	});
});

describe("dateFieldsOf", () => {
	it("returns the date-typed target fields", () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" }, released: { from: "Date", type: "date" } },
		});
		expect([...dateFieldsOf(t)]).toEqual(["released"]);
	});
});
