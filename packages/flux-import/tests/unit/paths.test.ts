import { describe, expect, it } from "vitest";
import {
	collectPaths,
	PATHS_MAX_COUNT,
	PATHS_MAX_DEPTH,
	pathProblem,
	recordsPathProblem,
	resolvePath,
} from "../../src/sources/paths.js";

const json = {
	sku: "A1",
	price: { amount: 12.5, tax: null },
	tags: ["x", "y"],
	"a.b": "dotted",
	nested: { list: [{ id: 1 }] },
};
const xml = {
	"@sku": "A1",
	title: { "@lang": "en", "#text": "Desk" },
	flag: { "@on": "yes" },
	price: "12.50",
	images: { image: ["a.jpg", "b.jpg"] },
	body: { p: "x", "#text": "mixed" },
};

describe("resolvePath", () => {
	it("reads CSV cells by column name", () => {
		expect(resolvePath({ sku: "A1" }, "sku", "csv")).toBe("A1");
		expect(resolvePath({ sku: "A1" }, "name", "csv")).toBeUndefined();
		expect(resolvePath({}, "__proto__", "csv")).toBeUndefined();
	});

	it("walks JSON dot paths, keeping null and stopping at arrays", () => {
		expect(resolvePath(json, "price.amount", "json")).toBe(12.5);
		expect(resolvePath(json, "price.tax", "json")).toBeNull();
		expect(resolvePath(json, "price.missing", "json")).toBeUndefined();
		expect(resolvePath(json, "sku.length", "json")).toBeUndefined();
		expect(resolvePath(json, "tags", "json")).toEqual(["x", "y"]);
		expect(resolvePath(json, "nested.list.id", "json")).toEqual([{ id: 1 }]);
		expect(resolvePath("scalar", "sku", "json")).toBeUndefined();
		expect(resolvePath(json, "toString", "json")).toBeUndefined();
	});

	it("walks XML paths: attributes, text elements, repeated children", () => {
		expect(resolvePath(xml, "@sku", "xml")).toBe("A1");
		expect(resolvePath(xml, "title", "xml")).toBe("Desk");
		expect(resolvePath(xml, "title/@lang", "xml")).toBe("en");
		expect(resolvePath(xml, "flag", "xml")).toBe("");
		expect(resolvePath(xml, "price", "xml")).toBe("12.50");
		expect(resolvePath(xml, "price/@currency", "xml")).toBeUndefined();
		expect(resolvePath(xml, "images/image", "xml")).toEqual(["a.jpg", "b.jpg"]);
		expect(resolvePath(xml, "body", "xml")).toEqual({ p: "x", "#text": "mixed" });
		expect(resolvePath(xml, "body/#text", "xml")).toBe("mixed");
	});

	it("reads #text of a text element whether or not it has attributes", () => {
		expect(resolvePath({ title: "Desk" }, "title/#text", "xml")).toBe("Desk");
		expect(resolvePath(xml, "title/#text", "xml")).toBe("Desk");
		expect(resolvePath({ title: "Desk" }, "title/#text/x", "xml")).toBeUndefined();
		expect(resolvePath({ title: "Desk" }, "title/#text", "json")).toBeUndefined();
	});
});

describe("collectPaths", () => {
	it("lists JSON leaf paths in first-seen order, skipping keys with dots", () => {
		expect(collectPaths([json, { sku: "B2", extra: true }, 42], "json")).toEqual([
			"sku",
			"price.amount",
			"price.tax",
			"tags",
			"nested.list",
			"extra",
		]);
	});

	it("lists XML attributes, text elements and their attributes", () => {
		expect(collectPaths([xml], "xml")).toEqual([
			"@sku",
			"title",
			"title/@lang",
			"flag",
			"flag/@on",
			"price",
			"images/image",
			"body/p",
		]);
	});

	it("stops descending at the depth limit and treats that path as a leaf", () => {
		let deep: Record<string, unknown> = { leaf: 1 };
		for (let i = 0; i < 100; i++) deep = { n: deep };
		const paths = collectPaths([deep], "json");
		expect(paths).toHaveLength(1);
		const deepest = paths[0] as string;
		expect(deepest.split(".")).toHaveLength(PATHS_MAX_DEPTH);
	});

	it("returns at most PATHS_MAX_COUNT distinct paths", () => {
		const wide: Record<string, number> = {};
		for (let i = 0; i < 2000; i++) wide[`k${i}`] = i;
		const paths = collectPaths([wide], "json");
		expect(paths).toHaveLength(PATHS_MAX_COUNT);
		expect(paths[0]).toBe("k0");
		expect(paths[PATHS_MAX_COUNT - 1]).toBe(`k${PATHS_MAX_COUNT - 1}`);
	});
});

describe("path syntax", () => {
	it.each([
		["json", "price.amount", null],
		["json", "price..amount", /empty key/],
		["xml", "title/@lang", null],
		["xml", "@sku", null],
		["xml", "body/#text", null],
		["xml", "@sku/title", /invalid/],
		["xml", "a b", /invalid/],
		["xml", "1title", /invalid/],
		["xml", "title/@1lang", /invalid/],
		["csv", "Any Column!", null],
	] as const)("%s path %s", (format, path, problem) => {
		const result = pathProblem(path, format);
		if (problem === null) expect(result).toBeNull();
		else expect(result).toMatch(problem);
	});

	it("checks records paths", () => {
		expect(recordsPathProblem("data.products", "json")).toBeNull();
		expect(recordsPathProblem("data.", "json")).toMatch(/empty key/);
		expect(recordsPathProblem("feed/item", "xml")).toBeNull();
		expect(recordsPathProblem("item", "xml")).toMatch(/root element and the record element/);
		expect(recordsPathProblem("feed/@sku", "xml")).toMatch(/invalid element name/);
		expect(recordsPathProblem("feed/1item", "xml")).toMatch(/invalid element name "1item"/);
	});
});
