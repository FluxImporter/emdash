import { describe, expect, it } from "vitest";
import { restoredData, restoredValue, sameStored } from "../../src/engine/rollback-values.js";

describe("sameStored (spec M5a V1)", () => {
	it("compares a boolean with its stored 1 or 0 by truth value", () => {
		expect(sameStored(1, true)).toBe(true);
		expect(sameStored(false, 0)).toBe(true);
		expect(sameStored(true, 0)).toBe(false);
		expect(sameStored(true, "true")).toBe(false);
		expect(sameStored(true, 2)).toBe(false);
	});

	it("ignores the key order of objects, as an image value reads back", () => {
		const read = {
			id: "m1",
			provider: "local",
			width: 4,
			alt: "A desk",
			meta: { storageKey: "k.png", caption: null, blurhash: "L$" },
			blurhash: "L$",
		};
		const back = {
			blurhash: "L$",
			meta: { blurhash: "L$", caption: null, storageKey: "k.png" },
			alt: "A desk",
			width: 4,
			provider: "local",
			id: "m1",
		};
		expect(sameStored(read, back)).toBe(true);
		expect(sameStored(read, { ...back, alt: "Other" })).toBe(false);
		expect(sameStored([1, 2], [2, 1])).toBe(false);
		expect(sameStored([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
	});

	it("reads null as an absent key, at the top and inside objects", () => {
		expect(sameStored(null, undefined)).toBe(true);
		expect(sameStored({ a: 1, b: null }, { a: 1 })).toBe(true);
		expect(sameStored({ a: 1 }, { a: 1, b: 0 })).toBe(false);
		expect(sameStored(null, 0)).toBe(false);
		expect(sameStored(null, "")).toBe(false);
	});

	it("compares other values exactly, -0 equal to 0", () => {
		expect(sameStored("a", "a")).toBe(true);
		expect(sameStored("1", 1)).toBe(false);
		expect(sameStored(-0, 0)).toBe(true);
		expect(sameStored({ a: [1] }, { a: [1, 2] })).toBe(false);
		expect(sameStored([], {})).toBe(false);
	});
});

describe("restoredValue", () => {
	it("sends a boolean field's stored 1 or 0 as a boolean and a missing value as null", () => {
		const boolean = { type: "boolean", required: false };
		expect(restoredValue(1, boolean)).toBe(true);
		expect(restoredValue(0, boolean)).toBe(false);
		expect(restoredValue(true, boolean)).toBe(true);
		expect(restoredValue(1, { type: "number", required: false })).toBe(1);
		expect(restoredValue(undefined, undefined)).toBeNull();
		expect(restoredValue({ a: 1 }, undefined)).toEqual({ a: 1 });
	});

	it("converts every field of a pre-image by the job's snapshot", () => {
		expect(
			restoredData(
				{ featured: 0, price: 1, body: null },
				{ featured: { type: "boolean", required: false } },
			),
		).toEqual({ featured: false, price: 1, body: null });
		expect(restoredData({ featured: 1 }, undefined)).toEqual({ featured: 1 });
	});
});
