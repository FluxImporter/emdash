import { describe, expect, it } from "vitest";
import {
	type Comparison,
	type CurrentLinks,
	comparisonsOf,
	deepEqual,
	type LinkPlan,
	type MediaPlanItem,
	planRecord,
} from "../../src/engine/diff.js";
import type { ResolvedLinks } from "../../src/engine/links.js";
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
		const num = (before: unknown, after: number) =>
			planRecord({ slug: null, data: { n: before } }, { key: "k", data: { n: after } }, plain)
				.action;
		expect(num(0, -0)).toBe("unchanged");
		expect(num(1, 2)).toBe("update");
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

describe("planRecord with links", () => {
	const item = (group: string | null, text = group ?? "new") => ({
		group,
		value: group ?? "",
		text,
	});
	const cur = (group: string, text = group) => ({ group, text });
	const record = { key: "P1", data: { title: "Hello" } };
	const entry = { slug: "hello", data: { title: "Hello" } };
	const plan = (resolved: ResolvedLinks, current: CurrentLinks, childSide: string[] = []) => {
		const links: LinkPlan = { resolved, current, childSide: new Set(childSide) };
		return planRecord(entry, record, new Map(), links);
	};

	it("treats a truncated reference field as changed even when the visible page matches", () => {
		const current: CurrentLinks = {
			references: { related: [cur("p1")] },
			referencesTruncated: ["related"],
		};
		expect(plan({ references: { related: [item("p1")] } }, current)).toEqual({
			action: "update",
			changes: [{ field: "related", before: ["p1"], after: ["p1"] }],
		});
	});

	it("compares taxonomies as sets, parent-side references and bylines in order", () => {
		const current: CurrentLinks = {
			taxonomies: { category: [cur("g1", "news"), cur("g2", "tech")] },
			references: { related: [cur("p1"), cur("p2")], parents: [cur("q1"), cur("q2")] },
			bylines: [cur("b1", "alex"), cur("b2", "sam")],
		};
		expect(
			plan(
				{
					taxonomies: { category: [item("g2", "tech"), item("g1", "news")] },
					references: { related: [item("p1"), item("p2")], parents: [item("q2"), item("q1")] },
					bylines: [item("b1", "alex"), item("b2", "sam")],
				},
				current,
				["parents"],
			),
		).toEqual({ action: "unchanged", changes: [] });
		expect(
			plan(
				{
					taxonomies: { category: [item("g1", "news"), item("g3", "electronics/phones")] },
					references: { related: [item("p2"), item("p1")], parents: [item("q1")] },
					bylines: [item("b2", "sam"), item("b1", "alex")],
				},
				current,
				["parents"],
			),
		).toEqual({
			action: "update",
			changes: [
				{ field: "related", before: ["p1", "p2"], after: ["p2", "p1"] },
				{ field: "parents", before: ["q1", "q2"], after: ["q1"] },
				{
					field: "taxonomies.category",
					before: ["news", "tech"],
					after: ["news", "electronics/phones"],
				},
				{ field: "bylines", before: ["alex", "sam"], after: ["sam", "alex"] },
			],
		});
	});

	it("treats an empty value as equal to nothing, and clears what the entry has", () => {
		expect(plan({ taxonomies: { tag: [] }, references: { related: [] }, bylines: [] }, {})).toEqual(
			{ action: "unchanged", changes: [] },
		);
		expect(
			plan(
				{ taxonomies: { tag: [] }, bylines: [] },
				{ taxonomies: { tag: [cur("t1", "rock")] }, bylines: [cur("b1", "alex")] },
			),
		).toEqual({
			action: "update",
			changes: [
				{ field: "taxonomies.tag", before: ["rock"], after: null },
				{ field: "bylines", before: ["alex"], after: null },
			],
		});
	});

	it("always plans a term a dry run would create as a change", () => {
		expect(
			plan(
				{ taxonomies: { category: [item("g1", "news"), item(null, "Garden/Tools")] } },
				{ taxonomies: { category: [cur("g1", "news")] } },
			).changes,
		).toEqual([
			{ field: "taxonomies.category", before: ["news"], after: ["news", "Garden/Tools"] },
		]);
	});

	it("lists the non-empty links of a new entry after its fields", () => {
		const links: LinkPlan = {
			resolved: {
				references: { related: [item("p1")], maker: [] },
				taxonomies: { category: [item("g1", "news")], tag: [] },
				bylines: [item("b1", "alex")],
			},
			current: {},
			childSide: new Set(),
		};
		expect(planRecord(null, { ...record, slug: "hello" }, new Map(), links)).toEqual({
			action: "create",
			changes: [
				{ field: "slug", before: null, after: "hello" },
				{ field: "title", before: null, after: "Hello" },
				{ field: "related", before: null, after: ["p1"] },
				{ field: "taxonomies.category", before: null, after: ["news"] },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});

describe("planRecord with media", () => {
	const record = { key: "P1", data: { title: "Chair" } };
	const item = (mediaId: string | null, alt: string | null = null): MediaPlanItem => ({
		mediaId,
		value: mediaId === null ? null : { id: mediaId, provider: "local" },
		text: mediaId ?? "new media from https://cdn.test/a.png",
		alt,
	});
	const stored = (data: Record<string, unknown>) => ({
		slug: null,
		data: { title: "Chair", ...data },
	});
	const plan = (data: Record<string, unknown>, media: Record<string, MediaPlanItem | null>) =>
		planRecord(stored(data), record, new Map(), undefined, media);

	it("compares the stored media ID, also when the value is a bare ID", () => {
		const photo = { id: "m1", provider: "local", width: 4, meta: { storageKey: "K1.png" } };
		expect(plan({ photo, manual: "m2" }, { photo: item("m1"), manual: item("m2") })).toEqual({
			action: "unchanged",
			changes: [],
		});
		expect(plan({ photo, manual: "m2" }, { photo: item("m3"), manual: item(null) })).toEqual({
			action: "update",
			changes: [
				{ field: "photo", before: "m1", after: "m3" },
				{ field: "manual", before: "m2", after: "new media from https://cdn.test/a.png" },
			],
		});
	});

	it("compares the alt only when the mapping gives one", () => {
		const photo = { id: "m1", alt: "Library alt" };
		expect(plan({ photo }, { photo: item("m1") }).action).toBe("unchanged");
		expect(plan({ photo }, { photo: item("m1", "Library alt") }).action).toBe("unchanged");
		expect(plan({ photo }, { photo: item("m1", "A red chair") })).toEqual({
			action: "update",
			changes: [{ field: "photo.alt", before: "Library alt", after: "A red chair" }],
		});
		expect(plan({ photo: { id: "m1" } }, { photo: item("m1", "A red chair") }).changes).toEqual([
			{ field: "photo.alt", before: null, after: "A red chair" },
		]);
	});

	it("treats an empty value as equal to nothing stored, and clears a stored one", () => {
		expect(plan({ photo: null }, { photo: null, manual: null }).action).toBe("unchanged");
		expect(plan({ photo: { id: "m1" } }, { photo: null })).toEqual({
			action: "update",
			changes: [{ field: "photo", before: "m1", after: null }],
		});
		expect(plan({ photo: { id: "m1" } }, { photo: item(null) }).changes).toEqual([
			{ field: "photo", before: "m1", after: "new media from https://cdn.test/a.png" },
		]);
	});

	it("lists a new entry's media after its fields", () => {
		expect(
			planRecord(
				null,
				record,
				new Map(),
				{
					resolved: { bylines: [{ group: "b1", value: "b1", text: "alex" }] },
					current: {},
					childSide: new Set(),
				},
				{ photo: item("m1", "Alt"), manual: null, icon: item(null) },
			),
		).toEqual({
			action: "create",
			changes: [
				{ field: "title", before: null, after: "Chair" },
				{ field: "photo", before: null, after: "m1" },
				{ field: "icon", before: null, after: "new media from https://cdn.test/a.png" },
				{ field: "bylines", before: null, after: ["alex"] },
			],
		});
	});
});
