import { describe, expect, it } from "vitest";
import {
	type Comparison,
	canonicalPortableText,
	deepEqual,
	type LinkPlan,
	planRecord,
	same,
} from "../../src/engine/diff.js";
import {
	canonicalData,
	canonicalGroups,
	canonicalMedia,
	canonicalRichText,
	currentForms,
	FINGERPRINT_LENGTH,
	fingerprint,
	fingerprintsOf,
	recordMappings,
	sentForms,
	stableJson,
} from "../../src/engine/fingerprints.js";
import type { FieldValue, MappedRecord } from "../../src/engine/template.js";

/** Stored values as EmDash reads them back, and mapped values as the importer sends them. */
const VALUES: unknown[] = [
	null,
	undefined,
	0,
	-0,
	1,
	2.5,
	-3,
	true,
	false,
	"",
	"text",
	"1",
	"true",
	"2026-12-01T07:00:00.000Z",
	"2026-12-01T07:00:00Z",
	"2026-12-01T09:00:00+02:00",
	"2026-12-01",
	"not a date",
	'{"a":1}',
	'{"b":2,"a":1}',
	"[1,2]",
	{ a: 1 },
	{ b: 2, a: 1 },
	{ a: { y: 2, b: [3, 1] }, z: 1 },
	{ z: 1, a: { b: [3, 1], y: 2 } },
	[1, 2],
	[2, 1],
	["red", "blue"],
	["blue", "red"],
	[],
	{},
	[true, 1],
	[1, 1],
];
const MAPPED = VALUES.filter((v) => v !== undefined) as FieldValue[];
const KINDS: Comparison[] = ["plain", "boolean", "instant", "deep"];

describe("canonical forms agree with the plan's comparison (M5b)", () => {
	it("gives equal fingerprints to every pair the plan calls the same", async () => {
		let pairs = 0;
		for (const how of KINDS) {
			for (const stored of VALUES) {
				for (const mapped of MAPPED) {
					if (!same(stored, mapped, how)) continue;
					pairs++;
					const a = await fingerprint(canonicalData(stored, how));
					const b = await fingerprint(canonicalData(mapped, how));
					expect(a, `${how}: ${stableJson(stored)} vs ${stableJson(mapped)}`).toBe(b);
				}
			}
		}
		expect(pairs).toBeGreaterThan(100);
	});

	it("gives different fingerprints to values the plan tells apart", async () => {
		const cases: [Comparison, unknown, unknown][] = [
			["plain", "", null],
			["plain", 0, false],
			["plain", 1, "1"],
			["boolean", "", null],
			["deep", [], undefined],
			["deep", 1, "1"],
			["instant", "2026-12-01T07:00:00.000Z", Date.parse("2026-12-01T07:00:00.000Z")],
			["instant", "2026-12-01T07:00:00.000Z", "2026-12-01T07:00:00.000Z".length],
		];
		for (const [how, a, b] of cases) {
			expect(same(a, b as FieldValue, how), `${how}: same`).toBe(false);
			expect(
				await fingerprint(canonicalData(a, how)),
				`${how}: ${stableJson(a)} vs ${stableJson(b)}`,
			).not.toBe(await fingerprint(canonicalData(b, how)));
		}
	});

	it("never gives equal fingerprints to values the plan tells apart", async () => {
		const extra: unknown[] = [1796108400000, Date.parse("2026-12-01T07:00:00.000Z"), "0", "null"];
		for (const how of KINDS) {
			for (const a of [...VALUES, ...extra]) {
				for (const b of [...MAPPED, ...extra] as FieldValue[]) {
					const fa = await fingerprint(canonicalData(a, how));
					const fb = await fingerprint(canonicalData(b, how));
					// Identical values are equal whatever the plan says of them.
					if (fa === fb && stableJson(a) !== stableJson(b)) {
						expect(
							same(a, b, how) || same(b, a as FieldValue, how),
							`${how}: ${stableJson(a)} vs ${stableJson(b)}`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("reads back what EmDash stores as the value sent (spec V1)", () => {
		expect(canonicalData(1, "boolean")).toBe(canonicalData(true, "boolean"));
		expect(canonicalData(0, "deep")).toBe(canonicalData(false, "deep"));
		expect(canonicalData("2026-12-01T07:00:00.000Z", "instant")).toEqual(
			canonicalData("2026-12-01T09:00:00+02:00", "instant"),
		);
		expect(canonicalData({ b: 2, a: 1 }, "plain")).toBe('{"b":2,"a":1}');
		expect(canonicalData(undefined, "plain")).toBeNull();
		expect(stableJson(canonicalData({ z: 1, a: [2, 1] }, "deep"))).toBe(
			stableJson({ a: [2, 1], z: 1 }),
		);
	});

	it("tells different values apart", async () => {
		expect(await fingerprint(canonicalData(1, "plain"))).not.toBe(
			await fingerprint(canonicalData(2, "plain")),
		);
		expect(await fingerprint(canonicalData(["a", "b"], "deep"))).not.toBe(
			await fingerprint(canonicalData(["b", "a"], "deep")),
		);
		expect(await fingerprint(null)).not.toBe(await fingerprint(""));
	});

	it("keeps the media ID and the stored alt, and nothing else", () => {
		const sent = { id: "m1", provider: "local", filename: "a.png", alt: "A desk", meta: {} };
		const read = {
			id: "m1",
			alt: "A desk",
			blurhash: "x",
			meta: { storageKey: "k", caption: null },
		};
		expect(canonicalMedia(sent)).toEqual(canonicalMedia(read));
		expect(canonicalMedia({ id: "m1" })).toEqual({ id: "m1", alt: null });
		expect(canonicalMedia({ id: "m1", alt: "Editor's alt" })).not.toEqual(
			canonicalMedia({ id: "m1" }),
		);
		expect(canonicalMedia("m2")).toEqual({ id: "m2", alt: null });
		expect(canonicalMedia(null)).toBeNull();
	});

	it("compares Portable Text as the plan does, and a value that is not Portable Text never", () => {
		const sent = [
			{
				_type: "block",
				style: "normal",
				markDefs: [{ _type: "link", _key: "l1", href: "https://x.test" }],
				children: [{ _type: "span", text: "Hi", marks: ["l1", "strong"] }],
			},
		];
		const read = [
			{
				_type: "block",
				_key: "k9",
				markDefs: [{ _key: "q", _type: "link", href: "https://x.test" }],
				children: [{ _key: "s", _type: "span", text: "Hi", marks: ["strong", "q"] }],
			},
		];
		expect(deepEqual(canonicalPortableText(sent), canonicalPortableText(read))).toBe(true);
		expect(stableJson(canonicalRichText(sent))).toBe(stableJson(canonicalRichText(read)));
		expect(canonicalRichText([])).toBeNull();
		expect(canonicalRichText("<p>Hi</p>")).toEqual({ notPortableText: '"<p>Hi</p>"' });
	});

	it("orders links unless they are a set, and treats an empty list as null", () => {
		expect(canonicalGroups(["b", "a"], true)).toEqual(["b", "a"]);
		expect(canonicalGroups(["b", "a"], false)).toEqual(["a", "b"]);
		expect(canonicalGroups([], true)).toBeNull();
	});

	it("is 16 base64url characters, stable across key order", async () => {
		const a = await fingerprint({ b: 1, a: [1, { d: 2, c: 3 }] });
		const b = await fingerprint({ a: [1, { c: 3, d: 2 }], b: 1 });
		expect(a).toBe(b);
		expect(a).toHaveLength(FINGERPRINT_LENGTH);
		expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});
});

describe("a record's forms (M5b)", () => {
	const record: MappedRecord = {
		key: "S1",
		slug: "desk",
		data: { title: "Desk", featured: true, released: "2026-12-01T07:00:00.000Z" },
		media: { photo: { kind: "image", url: "https://cdn.test/a.png", alt: null, refresh: false } },
		portableText: { body: null },
		links: {
			references: { related: ["S2"], held_by: ["S3", "S4"] },
			taxonomies: { tag: [] },
			bylines: null,
		},
	};
	const comparisons = new Map<string, Comparison>([
		["title", "plain"],
		["featured", "boolean"],
		["released", "instant"],
	]);
	const childSide = new Set(["held_by"]);

	it("names every mapping the record carries", () => {
		expect(recordMappings(record)).toEqual([
			"title",
			"featured",
			"released",
			"photo",
			"body",
			"slug",
			"related",
			"held_by",
			"taxonomies.tag",
			"bylines",
		]);
		expect(recordMappings({ key: "S1", data: { title: "A" } })).toEqual(["title"]);
	});

	it("gives what the record sends and what the entry then holds the same fingerprints", async () => {
		const links = {
			references: {
				related: [{ group: "g2", value: "e2", text: "e2" }],
				held_by: [
					{ group: "g4", value: "e4", text: "e4" },
					{ group: "g3", value: "e3", text: "e3" },
				],
			},
			taxonomies: { tag: [] },
			bylines: [],
		};
		const media = {
			photo: { mediaId: "m1", value: { id: "m1", provider: "local" }, text: "m1", alt: null },
		};
		const sent = sentForms(record, comparisons, links, media, { body: null }, childSide);
		const blocks = [{ _type: "block", style: "normal", children: [{ _type: "span", text: "Hi" }] }];
		const withBody = sentForms(
			{ ...record, portableText: { body: null } },
			comparisons,
			links,
			media,
			{ body: { blocks, pending: 0, text: "1 block" } },
			childSide,
		);
		expect(withBody.body).not.toBe(sent.body);
		const entry = {
			slug: "desk",
			data: {
				title: "Desk",
				featured: 1,
				released: "2026-12-01T07:00:00.000Z",
				photo: { id: "m1", blurhash: "x", meta: { caption: null } },
				body: null,
			},
		};
		const current = {
			references: {
				related: [{ group: "g2", text: "e2" }],
				held_by: [
					{ group: "g3", text: "e3" },
					{ group: "g4", text: "e4" },
				],
			},
			taxonomies: { tag: [] },
			bylines: [],
		};
		const read = currentForms(entry, record, comparisons, current, childSide);
		expect(await fingerprintsOf(read)).toEqual(await fingerprintsOf(sent));
		// A plan of the same values is unchanged.
		const plan: LinkPlan = { resolved: links, current, childSide };
		expect(planRecord(entry, record, comparisons, plan, media, { body: null }).action).toBe(
			"unchanged",
		);
		// An unresolved term, entry or media item never matches what is stored.
		const unresolved = sentForms(
			record,
			comparisons,
			{ ...links, taxonomies: { tag: [{ group: null, value: "", text: "new" }] } },
			{ photo: { mediaId: null, value: null, text: "new media from u", alt: null } },
			{ body: null },
			childSide,
		);
		expect(unresolved["taxonomies.tag"]).toEqual([{ unresolved: "new" }]);
		expect(unresolved.photo).toEqual({ unresolved: "new media from u" });
	});

	it("never matches a truncated selection", async () => {
		const read = currentForms(
			{ slug: null, data: {} },
			{ key: "S1", data: {}, links: { references: { related: [] } } },
			comparisons,
			{ references: { related: [] }, referencesTruncated: ["related"] },
			new Set(),
		);
		expect(read.related).toEqual({ truncated: [] });
		const sent = sentForms(
			{ key: "S1", data: {}, links: { references: { related: [] } } },
			comparisons,
			{ references: { related: [] } },
			undefined,
			undefined,
			new Set(),
		);
		expect(await fingerprint(read.related)).not.toBe(await fingerprint(sent.related));
	});
});
