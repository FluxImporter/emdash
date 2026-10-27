import { describe, expect, it } from "vitest";
import { type Comparison, comparisonsOf, deepEqual, planRecord } from "../../src/engine/diff.js";
import { templateSchema } from "../../src/engine/template.js";

const dates = new Map<string, Comparison>([["released", "instant"]]);
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

	it("compares booleans with EmDash's stored 0 and 1", () => {
		const how = new Map<string, Comparison>([["on", "boolean"]]);
		const plan = (before: unknown, after: boolean | null) =>
			planRecord({ slug: null, data: { on: before } }, { key: "k", data: { on: after } }, how)
				.action;
		expect(plan(1, true)).toBe("unchanged");
		expect(plan(0, false)).toBe("unchanged");
		expect(plan(true, true)).toBe("unchanged");
		expect(plan(0, true)).toBe("update");
		expect(plan(1, false)).toBe("update");
		expect(plan(null, false)).toBe("update");
		expect(plan(0, null)).toBe("update");
	});

	it("compares multiSelect and json values deeply", () => {
		const how = new Map<string, Comparison>([
			["tags", "deep"],
			["specs", "deep"],
		]);
		const current = {
			slug: null,
			data: { tags: ["red", "blue"], specs: { w: 120, dims: [1, 2], meta: { a: null } } },
		};
		const same = { tags: ["red", "blue"], specs: { meta: { a: null }, dims: [1, 2], w: 120 } };
		expect(planRecord(current, { key: "k", data: same }, how).action).toBe("unchanged");
		const reordered = { ...same, tags: ["blue", "red"] };
		expect(planRecord(current, { key: "k", data: reordered }, how).changes).toEqual([
			{ field: "tags", before: ["red", "blue"], after: ["blue", "red"] },
		]);
		const moved = { ...same, specs: { w: 120, dims: [2, 1], meta: { a: null } } };
		expect(planRecord(current, { key: "k", data: moved }, how).action).toBe("update");
		const json = (before: unknown, after: unknown) =>
			planRecord(
				{ slug: null, data: { specs: before } },
				{ key: "k", data: { specs: after as never } },
				how,
			).action;
		expect(json(1, true)).toBe("unchanged");
		expect(json(5, 5)).toBe("unchanged");
		expect(json("x", "x")).toBe("unchanged");
		expect(json({ a: 1 }, { a: 1, b: 2 })).toBe("update");
	});

	it("does not plan an update for text EmDash read back as JSON when it is canonical", () => {
		const plain = new Map<string, Comparison>();
		const plan = (before: unknown, after: string) =>
			planRecord({ slug: null, data: { note: before } }, { key: "k", data: { note: after } }, plain)
				.action;
		expect(plan({ a: [1, 2] }, '{"a":[1,2]}')).toBe("unchanged");
		expect(plan([1, "x"], '[1,"x"]')).toBe("unchanged");
		expect(plan({ a: [1, 2] }, '{ "a": [1, 2] }')).toBe("update");
		expect(plan("{x", "{x")).toBe("unchanged");
		expect(plan(5, "5")).toBe("update");
	});
});

describe("deepEqual", () => {
	it("compares keys in any order, arrays in order and -0 as 0", () => {
		expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(deepEqual([1, 2], [2, 1])).toBe(false);
		expect(deepEqual(-0, 0)).toBe(true);
		expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
		expect(deepEqual([1], { 0: 1 })).toBe(false);
		expect(deepEqual(null, {})).toBe(false);
	});
});

describe("comparisonsOf", () => {
	const t = templateSchema.parse({
		version: 1,
		collection: "products",
		locale: "en",
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			released: { from: "Date", type: "date" },
			day: { from: "Date", type: "date" },
			on: { from: "On", type: "boolean" },
			tags: { from: "Tags", type: "multiSelect" },
			specs: { from: "Specs", type: "json" },
			status: { from: "Status", type: "select" },
		},
	});

	it("compares by the target field type", () => {
		const targets = {
			title: { type: "string" },
			released: { type: "datetime" },
			day: { type: "string" },
			on: { type: "boolean" },
			tags: { type: "multiSelect" },
			specs: { type: "json" },
			status: { type: "select" },
		};
		expect(Object.fromEntries(comparisonsOf(t, targets))).toEqual({
			title: "plain",
			released: "instant",
			day: "plain",
			on: "boolean",
			tags: "deep",
			specs: "deep",
			status: "plain",
		});
	});

	it("compares date mappings as instants for jobs without a target snapshot", () => {
		expect(Object.fromEntries(comparisonsOf(t))).toMatchObject({
			title: "plain",
			released: "instant",
			day: "instant",
		});
	});
});
