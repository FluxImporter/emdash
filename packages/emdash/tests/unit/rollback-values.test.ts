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

	it("reads null as an absent value at the top level only", () => {
		expect(sameStored(null, undefined)).toBe(true);
		expect(sameStored({ a: 1, b: null }, { a: 1 })).toBe(false);
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

describe("sameStored, strict below the top level", () => {
	it("keeps nested null, absent keys and booleans distinct", () => {
		expect(sameStored({ a: null }, { a: 0 })).toBe(false);
		expect(sameStored({ a: true }, { a: 1 })).toBe(false);
		expect(sameStored([true], [1])).toBe(false);
		expect(sameStored([null], [])).toBe(false);
		expect(sameStored({ a: { b: null } }, { a: {} })).toBe(false);
	});

	it("tells Portable Text changes apart", () => {
		const block = (key: string, text: string) => ({
			_type: "block",
			_key: key,
			children: [{ _type: "span", _key: `${key}s`, text }],
		});
		expect(sameStored([block("a", "x")], [block("a", "x")])).toBe(true);
		expect(sameStored([block("a", "x")], [block("b", "x")])).toBe(false);
		expect(sameStored([block("a", "x"), block("b", "y")], [block("b", "y"), block("a", "x")])).toBe(
			false,
		);
	});

	it("keeps empty containers apart from null and absent", () => {
		expect(sameStored([], null)).toBe(false);
		expect(sameStored({}, undefined)).toBe(false);
		expect(sameStored(undefined, [])).toBe(false);
		expect(sameStored(null, {})).toBe(false);
	});

	it("compares the same instant in two forms as different", () => {
		expect(sameStored("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00+01:00")).toBe(false);
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

	it("leaves a null boolean null and any other number alone", () => {
		const boolean = { type: "boolean", required: false };
		expect(restoredValue(null, boolean)).toBeNull();
		expect(restoredValue(2, boolean)).toBe(2);
	});

	it("sends text that reads back as JSON as text again", () => {
		expect(restoredValue([1, 2], { type: "text", required: false })).toBe("[1,2]");
		expect(restoredValue({ a: 1 }, { type: "slug", required: false })).toBe('{"a":1}');
		expect(restoredValue({ a: 1 }, { type: "select", required: false })).toBe('{"a":1}');
		expect(restoredValue("plain", { type: "text", required: false })).toBe("plain");
	});

	it("passes json, multiSelect, image and Portable Text values through", () => {
		const json = { a: [1, { b: null }] };
		const multi = ["a", "b"];
		const image = { id: "m1", provider: "local", meta: { storageKey: "k.png" } };
		const pt = [{ _type: "block", _key: "a", children: [{ _type: "span", text: "x" }] }];
		expect(restoredValue(json, { type: "json", required: false })).toBe(json);
		expect(restoredValue(multi, { type: "multiSelect", required: false })).toBe(multi);
		expect(restoredValue(image, { type: "image", required: false })).toBe(image);
		expect(restoredValue(pt, { type: "portableText", required: false })).toBe(pt);
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
