import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaField } from "../../src/admin/types.js";
import { createOnce, draftDispatch, WizardProvider } from "../../src/admin/wizard/context.js";
import { M } from "../../src/admin/wizard/messages.js";
import { M as OPTIONS } from "../../src/admin/wizard/options/messages.js";
import { StepFooter } from "../../src/admin/wizard/StepFooter.js";
import {
	clearsDryRun,
	deriveOwner,
	fromTemplate,
	initialState,
	isEdited,
	jobInput,
	mapBlockers,
	mappable,
	type Options,
	optionsBlockers,
	ownerOf,
	reachable,
	reducer,
	STEPS,
	toTemplate,
	type WizardAction,
	type WizardState,
} from "../../src/admin/wizard/state.js";
import { readUrl, writeUrl } from "../../src/admin/wizard/url.js";
import { shapeProblems, templateShapeProblems } from "../../src/engine/shape.js";
import { type Template, templateSchema } from "../../src/engine/template.js";
import type { SuggestReply } from "../../src/plugin/suggest.js";
import { templateForSave } from "../../src/plugin/templates.js";

const UPLOAD = `01JZ0000000000000000000000${"a".repeat(32)}`;
const DRY_UPLOAD = `01JZ0000000000000000000001${"b".repeat(32)}`;

const field = (slug: string, type: string, extra: Partial<SchemaField> = {}): SchemaField => ({
	slug,
	label: slug[0]!.toUpperCase() + slug.slice(1),
	type,
	required: false,
	hasDefault: false,
	translatable: true,
	unsupported: false,
	...extra,
});

const FIELDS: SchemaField[] = [
	field("title", "string", { required: true }),
	field("price", "number"),
	field("published", "datetime"),
	field("body", "portableText"),
];

const COLUMNS = [
	{ key: "sku", values: ["A1", "B2"] },
	{ key: "name", values: ["Pen", "Ink"] },
	{ key: "cost", values: ["1,50", "2,00"] },
	{ key: "date", values: ["01/02/2026", "03/04/2026"] },
	{ key: "cats", values: ["a|b", "c"] },
];

const run = (actions: WizardAction[], from: WizardState = initialState) =>
	actions.reduce(reducer, from);

const SOURCE_READY: WizardAction = {
	type: "sourceReady",
	source: { kind: "upload", uploadId: UPLOAD, label: "products.csv" },
	sourceBlock: { format: "csv" },
	columns: COLUMNS,
};

/** A finished draft: source, target, key, slug, three fields, a taxonomy and bylines. */
const filled = run([
	SOURCE_READY,
	{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null },
	{ type: "rowSet", row: "key", mapping: { from: "sku" } },
	{ type: "rowSet", row: "slug", mapping: { from: "name" } },
	{ type: "rowSet", row: "field:title", mapping: { from: "name", type: "text" } },
	{ type: "rowSet", row: "field:price", mapping: { from: "cost", type: "number", decimal: "," } },
	{
		type: "rowSet",
		row: "field:published",
		mapping: { from: "date", type: "date", format: "dd/MM/yyyy" },
	},
	{ type: "rowSet", row: "taxonomy:category", mapping: { from: "cats", separator: "|" } },
	{ type: "rowSet", row: "bylines", mapping: { from: "sku", match: "slug" } },
]);

/** Starts a dry run under the state's own draft generation, and finishes it with `total`. */
function startDry(s: WizardState, jobId: string, uploadId: string, total?: number) {
	const started = reducer(s, { type: "dryRunStarted", jobId, uploadId, generation: s.generation });
	return total === undefined ? started : reducer(started, { type: "dryRunFinished", total });
}

const withDryRun = startDry(filled, "D1", DRY_UPLOAD, 2);

const BASE_TEMPLATE: Template = templateSchema.parse({
	version: 1,
	source: { format: "csv" },
	collection: "posts",
	locale: "en",
	key: { from: "sku" },
	fields: {
		title: { from: "name", type: "text" },
		published: { from: "date", type: "date", format: "dd/MM/yyyy" },
	},
	rules: { owner: "products-feed" },
});

const loaded = (template: Template = BASE_TEMPLATE, from: WizardState = run([SOURCE_READY])) =>
	reducer(from, {
		type: "templateLoaded",
		base: { id: "T1", revision: 3, name: "Products feed", template },
	});

/** Exactly what `toTemplate` built must pass every site-independent check `templates/create` runs. */
function expectServerShape(t: unknown) {
	expect(templateSchema.safeParse(t).success).toBe(true);
	const shape = templateShapeProblems(t);
	expect(shape.ok).toBe(true);
	if (shape.ok) expect(shapeProblems(shape)).toEqual([]);
}

describe("reducer", () => {
	it.each<[string, string, () => void]>([
		[
			"sourceReady",
			"clears columns' dependants: rows' suggestion, dryRun; keeps target",
			() => {
				const asked = startDry(run([{ type: "suggestionStarted" }], filled), "D", UPLOAD);
				expect(asked.dryRun).not.toBeNull();
				const s = reducer(asked, { ...SOURCE_READY, columns: COLUMNS.slice(0, 2) });
				expect(s.columns).toEqual(COLUMNS.slice(0, 2));
				expect(s.suggestion).toEqual({ status: "idle", dismissed: false });
				expect(s.dryRun).toBeNull();
				expect(s.target).toEqual(filled.target);
				expect(s.rows).toEqual(filled.rows);
				expect(s.dirty).toBe(true);
			},
		],
		[
			"sourceBlockChanged",
			"replaces columns, clears suggestion and dryRun",
			() => {
				const asked = run([{ type: "suggestionStarted" }], withDryRun);
				const s = reducer(asked, {
					type: "sourceBlockChanged",
					sourceBlock: { format: "json", records: "items" },
					columns: null,
				});
				expect(s.sourceBlock).toEqual({ format: "json", records: "items" });
				expect(s.columns).toBeNull();
				expect(s.suggestion.status).toBe("idle");
				expect(s.dryRun).toBeNull();
				expect(s.rows).toEqual(filled.rows);
			},
		],
		[
			"targetChosen (new collection)",
			"clears rows, meta, newFields, suggestion and dryRun",
			() => {
				const before = startDry(
					run(
						[{ type: "fieldProposed", field: proposed("colour") }, { type: "suggestionStarted" }],
						filled,
					),
					"D",
					UPLOAD,
				);
				const s = reducer(before, {
					type: "targetChosen",
					collection: "pages",
					locale: "en",
					translationLocale: null,
				});
				expect(s.target).toEqual({ collection: "pages", locale: "en", translationLocale: null });
				expect(s.rows).toEqual({});
				expect(s.meta).toEqual({});
				expect(s.newFields).toEqual([]);
				expect(s.suggestion.status).toBe("idle");
				expect(s.dryRun).toBeNull();
			},
		],
		[
			"targetChosen (same collection, new locale)",
			"keeps rows; clears dryRun",
			() => {
				const s = reducer(withDryRun, {
					type: "targetChosen",
					collection: "posts",
					locale: "fr",
					translationLocale: "en",
				});
				expect(s.target).toEqual({ collection: "posts", locale: "fr", translationLocale: "en" });
				expect(s.rows).toEqual(filled.rows);
				expect(s.meta).toEqual(filled.meta);
				expect(s.dryRun).toBeNull();
			},
		],
		[
			"rowSet",
			"sets meta.origin user; clears dryRun; dirty",
			() => {
				const clean = { ...withDryRun, dirty: false };
				const s = reducer(clean, {
					type: "rowSet",
					row: "field:body",
					mapping: { from: "name", type: "portableText", format: "text" },
				});
				expect(s.rows["field:body"]).toEqual({
					from: "name",
					type: "portableText",
					format: "text",
				});
				expect(s.meta["field:body"]).toEqual({ origin: "user", check: false });
				expect(s.dryRun).toBeNull();
				expect(s.dirty).toBe(true);
				const cleared = reducer(s, { type: "rowCleared", row: "field:body" });
				expect(cleared.rows["field:body"]).toBeUndefined();
				expect(cleared.meta["field:body"]).toBeUndefined();
			},
		],
		[
			"optionsChanged",
			"clears dryRun",
			() => {
				const s = reducer(withDryRun, { type: "optionsChanged", patch: { status: "draft" } });
				expect(s.options.status).toBe("draft");
				expect(s.options.mode).toBe("upsert");
				expect(s.dryRun).toBeNull();
			},
		],
		[
			"fieldsApplied",
			"removes the applied slugs from newFields",
			() => {
				const s = run(
					[
						{ type: "fieldProposed", field: proposed("colour") },
						{ type: "fieldProposed", field: proposed("size") },
						{ type: "fieldChanged", slug: "size", patch: { label: "Size (cm)" } },
						{ type: "fieldProposed", field: proposed("weight") },
						{ type: "fieldRemoved", slug: "weight" },
					],
					filled,
				);
				expect(s.newFields.map((f) => [f.slug, f.label])).toEqual([
					["colour", "Colour"],
					["size", "Size (cm)"],
				]);
				expect(reducer(s, { type: "fieldsApplied", slugs: ["colour"] }).newFields).toEqual([
					{ ...proposed("size"), label: "Size (cm)" },
				]);
			},
		],
		[
			"templateLoaded",
			"fills target, rows, options; meta origin template; step preview",
			() => {
				const s = loaded();
				expect(s.step).toBe("preview");
				expect(s.base?.id).toBe("T1");
				expect(s.sourceBlock).toEqual(BASE_TEMPLATE.source);
				const json = templateSchema.parse({
					...BASE_TEMPLATE,
					source: { format: "json", records: "items" },
				});
				expect(loaded(json).sourceBlock).toEqual({ format: "json", records: "items" });
				expect(s.target).toEqual({ collection: "posts", locale: "en", translationLocale: null });
				expect(s.rows.key).toEqual({ from: "sku" });
				expect(s.rows["field:title"]).toEqual({ from: "name", type: "text" });
				expect(s.meta["field:title"]).toEqual({ origin: "template", check: false });
				expect(s.options.owner).toBe("products-feed");
				// F10: without a sampled file it stays on the current step.
				expect(loaded(BASE_TEMPLATE, initialState).step).toBe("source");
			},
		],
		[
			"dryRunStarted/Finished",
			"keep rows; set dryRun",
			() => {
				const clean = { ...filled, dirty: false };
				const s = startDry(clean, "D1", DRY_UPLOAD, 7);
				expect(s.dryRun).toEqual({ jobId: "D1", uploadId: DRY_UPLOAD, total: 7 });
				expect(s.rows).toEqual(filled.rows);
				expect(s.dirty).toBe(false);
			},
		],
		[
			"stepChanged",
			"keeps dryRun",
			() => {
				const s = reducer({ ...withDryRun, dirty: false }, { type: "stepChanged", step: "map" });
				expect(s.step).toBe("map");
				expect(s.dryRun).toEqual(withDryRun.dryRun);
				expect(s.dirty).toBe(false);
			},
		],
		[
			"jobReopened",
			"step run, run.jobId set, dirty false",
			() => {
				const s = reducer(filled, { type: "jobReopened", jobId: "J9" });
				expect(s.step).toBe("run");
				expect(s.run).toEqual({ jobId: "J9" });
				expect(s.dirty).toBe(false);
			},
		],
	])("%s: %s", (_, __, check) => check());

	it("flags key, slug and field rows whose key the new sample lacks (review ruling 1)", () => {
		const draft = reducer(filled, {
			type: "rowSet",
			row: "field:body",
			mapping: { expr: "name", type: "portableText", format: "text" },
		});
		// `cats` is gone too, but the taxonomy row is not checked.
		const fewer = [COLUMNS[0]!, COLUMNS[1]!].map((c) => ({ ...c }));
		const checks = (s: WizardState) =>
			Object.fromEntries(Object.entries(s.meta).map(([row, m]) => [row, m?.check]));
		const expected = {
			key: false,
			slug: false,
			"field:title": false,
			"field:price": true,
			"field:published": true,
			"field:body": false,
			"taxonomy:category": false,
			bylines: false,
		};
		const ready = reducer(draft, { ...SOURCE_READY, columns: fewer });
		expect(checks(ready)).toEqual(expected);
		// Soft: the rows stay, and a flagged row keeps its origin.
		expect(ready.rows).toEqual(draft.rows);
		expect(ready.meta["field:price"]?.origin).toBe("user");
		expect(mapBlockers(ready, FIELDS)).toEqual([]);

		const changed = reducer(draft, {
			type: "sourceBlockChanged",
			sourceBlock: { format: "csv" },
			columns: fewer,
		});
		expect(checks(changed)).toEqual(expected);
		const pending = reducer(draft, {
			type: "sourceBlockChanged",
			sourceBlock: { format: "csv" },
			columns: null,
		});
		expect(pending.meta).toEqual(draft.meta);
		// A row whose key is still there keeps the flag it had.
		expect(reducer(ready, { ...SOURCE_READY }).meta["field:price"]?.check).toBe(true);
		// The slug is checked too.
		const keyOnly = reducer(draft, { ...SOURCE_READY, columns: [COLUMNS[0]!] });
		expect(keyOnly.meta.slug?.check).toBe(true);
		expect(keyOnly.meta.key?.check).toBe(false);
		// A template's row keeps its origin.
		const template = reducer(loaded(), { ...SOURCE_READY, columns: [COLUMNS[0]!] });
		expect(template.meta["field:title"]).toEqual({ origin: "template", check: true });
		expect(template.meta.key).toEqual({ origin: "template", check: false });
	});

	it("clears dryRun and saved, and sets dirty, on every action but the listed ones", () => {
		const saved = { ...withDryRun, dirty: false, saved: { warnings: ["w"] } };
		const keeps = new Set([
			"stepChanged",
			"warningsDismissed",
			"dryRunStarted",
			"dryRunFinished",
			"runStarted",
			"jobReopened",
			"templateSaved",
		]);
		for (const action of EVERY_ACTION) {
			const s = reducer(saved, action);
			const clears = !keeps.has(action.type);
			expect(clearsDryRun(saved, action), action.type).toBe(clears);
			if (clears) {
				expect(s.dryRun, action.type).toBeNull();
				expect(s.saved, action.type).toBeNull();
				expect(s.dirty, action.type).toBe(true);
				expect(s.generation, action.type).toBe(saved.generation + 1);
			} else {
				expect(s.generation, action.type).toBe(saved.generation);
				if (action.type !== "dryRunStarted") {
					expect(s.dryRun, action.type).not.toBeNull();
					expect(s.dirty, action.type).toBe(false);
				}
			}
		}
	});

	it("ignores a dry run started under an earlier draft generation (review ruling 2)", () => {
		const g = filled.generation;
		const edited = reducer(filled, { type: "optionsChanged", patch: { batchSize: 20 } });
		expect(edited.generation).toBe(g + 1);
		const late = reducer(edited, {
			type: "dryRunStarted",
			jobId: "D-late",
			uploadId: DRY_UPLOAD,
			generation: g,
		});
		expect(late).toBe(edited);
		expect(late.dryRun).toBeNull();
		expect(startDry(edited, "D-now", DRY_UPLOAD).dryRun?.jobId).toBe("D-now");
	});

	it("returns the same state for a targetChosen or optionsChanged that changes nothing (review ruling 3)", () => {
		const saved = { ...withDryRun, dirty: false, saved: { warnings: ["w"] } };
		const same: WizardAction[] = [
			{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null },
			{ type: "optionsChanged", patch: { mode: "upsert", status: "publish" } },
			{ type: "optionsChanged", patch: { save: { kind: "none" }, missing: null } },
			{ type: "optionsChanged", patch: {} },
		];
		for (const action of same) {
			expect(clearsDryRun(saved, action), JSON.stringify(action)).toBe(false);
			expect(reducer(saved, action), JSON.stringify(action)).toBe(saved);
		}
		const changed = reducer(saved, {
			type: "optionsChanged",
			patch: { save: { kind: "new", name: "x" } },
		});
		expect(changed.dryRun).toBeNull();
		expect(
			clearsDryRun(saved, { type: "optionsChanged", patch: { updateFields: ["title"] } }),
		).toBe(true);
	});

	it("records the run, and dismisses warnings without other changes", () => {
		const s = reducer({ ...withDryRun, dirty: false }, { type: "runStarted", jobId: "R1" });
		expect(s.run).toEqual({ jobId: "R1" });
		expect(s.dryRun).toEqual(withDryRun.dryRun);
		const d = reducer(s, { type: "warningsDismissed" });
		expect(d.suggestion.dismissed).toBe(true);
		expect(d.dirty).toBe(false);
	});

	it("tracks a suggestion's state", () => {
		const started = reducer(filled, { type: "suggestionStarted" });
		expect(started.suggestion).toEqual({ status: "loading", dismissed: false });
		const failed = reducer(started, { type: "suggestionFailed", error: "boom" });
		expect(failed.suggestion).toEqual({ status: "error", error: "boom", dismissed: false });
	});
});

function proposed(slug: string) {
	return {
		key: slug,
		slug,
		label: slug[0]!.toUpperCase() + slug.slice(1),
		type: "string",
		translatable: true,
		searchable: false,
	};
}

const REPLY_TEMPLATE: Template = templateSchema.parse({
	version: 1,
	source: { format: "csv" },
	collection: "posts",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "name" },
	fields: {
		title: { from: "name", type: "text" },
		price: { from: "cost", type: "number", decimal: "," },
		published: { from: "date", type: "date", format: "dd/MM/yyyy" },
	},
});

const REPLY: SuggestReply = {
	method: "ai",
	ai: { available: true, provider: "anthropic", model: "claude" },
	template: REPLY_TEMPLATE,
	key: { from: "sku", confidence: 0.9, rationale: "Unique", origin: "ai" },
	slug: { from: "name", confidence: 0.6, rationale: "Names", origin: "fallback" },
	fields: [
		{
			field: "title",
			fieldType: "string",
			required: true,
			from: "name",
			confidence: 0.95,
			rationale: "Same name",
			origin: "ai",
			mapping: "text",
		},
		{
			field: "price",
			fieldType: "number",
			required: false,
			from: "cost",
			confidence: 0.4,
			rationale: "Similar",
			origin: "fallback",
			mapping: "number",
		},
		{
			field: "published",
			fieldType: "datetime",
			required: false,
			from: "date",
			confidence: 0.9,
			rationale: "A date",
			origin: "ai",
			mapping: "date",
		},
		{
			field: "body",
			fieldType: "portableText",
			required: false,
			from: null,
			confidence: 0,
			rationale: "No match",
			origin: "fallback",
		},
	],
	unmapped: { fields: ["body"], keys: ["cats"] },
	check: { problems: [], warnings: [] },
	warnings: [{ code: "date_format_ambiguous", fields: ["published"] }],
	sent: null,
};

describe("suggestionReceived", () => {
	const target = run([
		SOURCE_READY,
		{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null },
	]);

	it("fills only rows the user has not set; overwriteUserRows replaces them too", () => {
		const user = run(
			[
				{ type: "rowSet", row: "field:title", mapping: { from: "sku", type: "text" } },
				{
					type: "rowSet",
					row: "field:body",
					mapping: { from: "name", type: "portableText", format: "text" },
				},
			],
			target,
		);
		const kept = reducer(user, {
			type: "suggestionReceived",
			reply: REPLY,
			overwriteUserRows: false,
		});
		expect(kept.suggestion).toEqual({ status: "done", reply: REPLY, dismissed: false });
		expect(kept.rows.key).toEqual({ from: "sku" });
		expect(kept.rows.slug).toEqual({ from: "name" });
		expect(kept.rows["field:title"]).toEqual({ from: "sku", type: "text" });
		expect(kept.meta["field:title"]?.origin).toBe("user");
		expect(kept.rows["field:price"]).toEqual({ from: "cost", type: "number", decimal: "," });
		expect(kept.rows["field:body"]).toEqual({ from: "name", type: "portableText", format: "text" });

		const replaced = reducer(user, {
			type: "suggestionReceived",
			reply: REPLY,
			overwriteUserRows: true,
		});
		expect(replaced.rows["field:title"]).toEqual({ from: "name", type: "text" });
		expect(replaced.meta["field:title"]).toEqual({
			origin: "ai",
			confidence: 0.95,
			rationale: "Same name",
			check: false,
		});
		// A field the suggestion leaves without a key keeps a user's row (review ruling 4).
		expect(replaced.rows["field:body"]).toEqual({
			from: "name",
			type: "portableText",
			format: "text",
		});
		expect(replaced.meta["field:body"]?.origin).toBe("user");
	});

	it("clears a keyless field only when an earlier suggestion filled it (review ruling 4)", () => {
		const bodyFromName = {
			...REPLY.fields[3]!,
			from: "name",
			confidence: 0.7,
			origin: "fallback" as const,
			mapping: "portableText" as const,
		};
		const first = reducer(target, {
			type: "suggestionReceived",
			reply: {
				...REPLY,
				template: null,
				fields: [...REPLY.fields.slice(0, 3), bodyFromName],
			},
			overwriteUserRows: false,
		});
		expect(first.meta["field:body"]?.origin).toBe("name");
		const again = reducer(first, {
			type: "suggestionReceived",
			reply: REPLY,
			overwriteUserRows: false,
		});
		expect(again.rows["field:body"]).toBeUndefined();
		expect(again.meta["field:body"]).toBeUndefined();
		expect(again.meta["field:title"]?.origin).toBe("ai");

		// A template's row stays, even with overwriteUserRows.
		const { mapping: _, ...titleSuggestion } = REPLY.fields[0]!;
		const titleless = {
			...REPLY,
			template: null,
			fields: [{ ...titleSuggestion, from: null }],
		};
		const aiCleared = reducer(again, {
			type: "suggestionReceived",
			reply: titleless,
			overwriteUserRows: false,
		});
		expect(aiCleared.rows["field:title"]).toBeUndefined();
		for (const overwriteUserRows of [false, true]) {
			const kept = reducer(loaded(), {
				type: "suggestionReceived",
				reply: titleless,
				overwriteUserRows,
			});
			expect(kept.rows["field:title"]).toEqual({ from: "name", type: "text" });
			expect(kept.meta["field:title"]?.origin).toBe("template");
		}
	});

	it("builds a field's row from its type when the reply has no draft", () => {
		const s = reducer(target, {
			type: "suggestionReceived",
			reply: { ...REPLY, template: null },
			overwriteUserRows: false,
		});
		expect(s.rows["field:price"]).toEqual({ from: "cost", type: "number" });
		expect(s.rows.key).toEqual({ from: "sku" });
	});

	it("marks a suggestion 'check' below 0.5 or when a format warning names the field", () => {
		const s = reducer(target, {
			type: "suggestionReceived",
			reply: REPLY,
			overwriteUserRows: false,
		});
		expect(s.meta.key).toEqual({
			origin: "ai",
			confidence: 0.9,
			rationale: "Unique",
			check: false,
		});
		expect(s.meta.slug).toEqual({
			origin: "name",
			confidence: 0.6,
			rationale: "Names",
			check: false,
		});
		expect(s.meta["field:price"]).toMatchObject({ origin: "name", confidence: 0.4, check: true });
		expect(s.meta["field:published"]).toMatchObject({ origin: "ai", confidence: 0.9, check: true });
		expect(s.meta["field:title"]?.check).toBe(false);
		const numbers = reducer(target, {
			type: "suggestionReceived",
			reply: { ...REPLY, warnings: [{ code: "number_format_ambiguous", fields: ["title"] }] },
			overwriteUserRows: false,
		});
		expect(numbers.meta["field:title"]?.check).toBe(true);
		expect(numbers.meta["field:published"]?.check).toBe(false);
		const other = reducer(target, {
			type: "suggestionReceived",
			reply: { ...REPLY, warnings: [{ code: "keys_not_matched", fields: ["title"] }] },
			overwriteUserRows: false,
		});
		expect(other.meta["field:title"]?.check).toBe(false);
		// The bands: 0.5 is medium, not "check".
		const half = reducer(target, {
			type: "suggestionReceived",
			reply: { ...REPLY, key: { ...REPLY.key, confidence: 0.5 } },
			overwriteUserRows: false,
		});
		expect(half.meta.key?.check).toBe(false);
	});
});

describe("toTemplate", () => {
	it("builds a template that the engine's templateSchema accepts, with rules.owner always", () => {
		const t = toTemplate(filled, "wizard-posts-en");
		expect(t).toEqual({
			version: 1,
			source: { format: "csv" },
			collection: "posts",
			locale: "en",
			key: { from: "sku" },
			slug: { from: "name" },
			fields: {
				title: { from: "name", type: "text" },
				price: { from: "cost", type: "number", decimal: "," },
				published: { from: "date", type: "date", format: "dd/MM/yyyy" },
			},
			taxonomies: { category: { from: "cats", separator: "|" } },
			bylines: { from: "sku", match: "slug" },
			rules: { owner: "wizard-posts-en" },
		});
		expectServerShape(t);
	});

	it("passes the server's shape checks for mode create, updateFields and a translation (F8)", () => {
		const create = reducer(filled, {
			type: "optionsChanged",
			patch: { mode: "create", updateFields: ["title"], protectEdited: true },
		});
		const c = toTemplate(create, "o") as Template;
		expect(c.rules).toEqual({ owner: "o", mode: "create" });
		expectServerShape(c);

		const update = reducer(filled, {
			type: "optionsChanged",
			patch: {
				mode: "update",
				updateFields: ["title", "slug", "taxonomies.category", "bylines", "gone", "title"],
				protectEdited: true,
			},
		});
		const u = toTemplate(update, "o") as Template;
		expect(u.rules).toEqual({
			owner: "o",
			mode: "update",
			updateFields: ["title", "slug", "taxonomies.category", "bylines"],
			protectEdited: true,
		});
		expectServerShape(u);

		const none = reducer(filled, { type: "optionsChanged", patch: { updateFields: ["gone"] } });
		expect((toTemplate(none, "o") as Template).rules).toEqual({ owner: "o" });

		const translation = run(
			[
				{ type: "targetChosen", collection: "posts", locale: "fr", translationLocale: "en" },
				{ type: "rowSet", row: "translationOf", mapping: { from: "sku" } },
			],
			filled,
		);
		const tr = toTemplate(translation, "o") as Template;
		expect(tr.locale).toBe("fr");
		expect(tr.translationOf).toEqual({ from: "sku", locale: "en" });
		expectServerShape(tr);
		// Without a translation locale no translationOf is written.
		const untranslated = reducer(filled, {
			type: "rowSet",
			row: "translationOf",
			mapping: { from: "sku" },
		});
		expect((toTemplate(untranslated, "o") as Template).translationOf).toBeUndefined();
	});

	it("writes missing only with an owner, publishAt with publish, the fixed date as a JSON string expr with tz site (Ruling 16)", () => {
		expect((toTemplate(filled, "o") as Template).publishAt).toBeUndefined();
		const missing = reducer(filled, {
			type: "optionsChanged",
			patch: { missing: { action: "unpublish", maxPercent: 10 } },
		});
		const m = toTemplate(missing, "owner-1") as Template;
		expect(m.rules).toEqual({ owner: "owner-1", missing: { action: "unpublish", maxPercent: 10 } });
		expectServerShape(m);

		const fixed = reducer(filled, {
			type: "optionsChanged",
			patch: { status: "schedule", schedule: { kind: "fixed", at: "2026-12-01T09:30" } },
		});
		const f = toTemplate(fixed, "o") as Template;
		expect(f.publishAt).toEqual({ expr: '"2026-12-01T09:30"', tz: "site" });
		expectServerShape(f);

		const feed = reducer(filled, {
			type: "optionsChanged",
			patch: {
				status: "schedule",
				schedule: { kind: "feed", from: "date", format: "dd/MM/yyyy", tz: "Europe/Paris" },
			},
		});
		expect((toTemplate(feed, "o") as Template).publishAt).toEqual({
			from: "date",
			format: "dd/MM/yyyy",
			tz: "Europe/Paris",
		});
		const kept = reducer(filled, {
			type: "optionsChanged",
			patch: { status: "schedule", schedule: { kind: "kept", mapping: { expr: "now()" } } },
		});
		expect((toTemplate(kept, "o") as Template).publishAt).toEqual({ expr: "now()" });

		// Only the Schedule status writes publishAt, and the row is never read (F4).
		const draft = run(
			[
				{ type: "optionsChanged", patch: { status: "draft" } },
				{ type: "rowSet", row: "publishAt", mapping: { from: "date" } },
			],
			fixed,
		);
		expect((toTemplate(draft, "o") as Template).publishAt).toBeUndefined();
		const unset = reducer(filled, { type: "optionsChanged", patch: { status: "schedule" } });
		expect((toTemplate(unset, "o") as Template).publishAt).toBeUndefined();
	});

	it("refuses a key, slug or translationOf row with neither from nor expr (review ruling 5)", () => {
		const broken = { ...filled, rows: { ...filled.rows, slug: { type: "text" } as never } };
		expect(() => toTemplate(broken, "o")).toThrow();
		const noKey = { ...filled, rows: { ...filled.rows, key: {} as never } };
		expect(() => toTemplate(noKey, "o")).toThrow();
	});

	it("takes only from and expr into the key and slug, and the source block without empty keys", () => {
		const s = run(
			[
				{ type: "rowSet", row: "key", mapping: { expr: "sku & '-' & name", note: "x" } },
				{
					type: "sourceBlockChanged",
					sourceBlock: { format: "json", records: "items", filter: undefined },
					columns: COLUMNS,
				},
			],
			filled,
		);
		const t = toTemplate(s, "o") as Template;
		expect(t.key).toEqual({ expr: "sku & '-' & name" });
		expect(Object.keys(t.source)).toEqual(["format", "records"]);
	});
});

describe("fromTemplate and isEdited", () => {
	it("round-trips fromTemplate(toTemplate(s)) and isEdited is false until a row changes", () => {
		const scheduled = run(
			[
				{
					type: "optionsChanged",
					patch: {
						mode: "update",
						updateFields: ["title"],
						protectEdited: true,
						status: "schedule",
						schedule: { kind: "fixed", at: "2026-12-01T09:30" },
						missing: { action: "trash", maxPercent: 40 },
					},
				},
			],
			filled,
		);
		const raw = toTemplate(scheduled, "products-feed") as Template;
		const back = fromTemplate(raw);
		expect(back.rows).toEqual(filled.rows);
		expect(back.target).toEqual(filled.target);
		expect(back.options).toEqual({
			owner: "products-feed",
			mode: "update",
			updateFields: ["title"],
			protectEdited: true,
			missing: { action: "trash", maxPercent: 40 },
			status: "schedule",
			schedule: { kind: "fixed", at: "2026-12-01T09:30" },
		});
		expect(Object.values(back.meta).every((m) => m?.origin === "template")).toBe(true);

		// As stored: the schema fills `tz: "UTC"` into the date mapping.
		const s = loaded(templateSchema.parse(raw));
		expect(isEdited(s)).toBe(false);
		const edited = reducer(s, {
			type: "rowSet",
			row: "field:title",
			mapping: { from: "sku", type: "text" },
		});
		expect(isEdited(edited)).toBe(true);
		expect(isEdited(reducer(s, { type: "optionsChanged", patch: { mode: "create" } }))).toBe(true);
		expect(isEdited(reducer(s, { type: "optionsChanged", patch: { owner: "other" } }))).toBe(true);
		expect(isEdited(initialState)).toBe(false);
	});

	it("reads a feed date, and keeps any other publishAt verbatim (F4)", () => {
		const feed = fromTemplate({ ...BASE_TEMPLATE, publishAt: { from: "date", tz: "UTC" } });
		expect(feed.options.schedule).toEqual({ kind: "feed", from: "date", tz: "UTC" });
		const expr = fromTemplate({ ...BASE_TEMPLATE, publishAt: { expr: "$now()", tz: "site" } });
		expect(expr.options.schedule).toEqual({
			kind: "kept",
			mapping: { expr: "$now()", tz: "site" },
		});
		const notSite = fromTemplate({
			...BASE_TEMPLATE,
			publishAt: { expr: '"2026-01-01"', tz: "UTC" },
		});
		expect(notSite.options.schedule?.kind).toBe("kept");
		for (const t of [feed, expr, notSite]) expect(t.options.status).toBe("schedule");
		expect(fromTemplate(BASE_TEMPLATE).options.status).toBeUndefined();
		const translated = fromTemplate({
			...BASE_TEMPLATE,
			locale: "fr",
			translationOf: { from: "sku", locale: "en" },
		});
		expect(translated.target.translationLocale).toBe("en");
		expect(translated.rows.translationOf).toEqual({ from: "sku" });
	});

	it("sees a shortened updateFields list as an edit", () => {
		const base = templateSchema.parse({
			...BASE_TEMPLATE,
			rules: { owner: "products-feed", mode: "update", updateFields: ["title", "published"] },
		});
		const s = loaded(base);
		expect(isEdited(s)).toBe(false);
		const shorter = reducer(s, { type: "optionsChanged", patch: { updateFields: ["title"] } });
		expect(isEdited(shorter)).toBe(true);
		const longer = reducer(s, {
			type: "optionsChanged",
			patch: { updateFields: ["title", "published", "title"] },
		});
		expect(isEdited(longer)).toBe(false);
	});

	it("treats a base that spells out every default and one that omits them as unedited (F9)", () => {
		const terse = templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "sku" },
			fields: { published: { from: "date", type: "date" } },
			publishAt: { from: "date" },
		});
		const verbose = templateSchema.parse({
			version: 1,
			source: { format: "csv" },
			collection: "posts",
			locale: "en",
			key: { from: "sku" },
			fields: { published: { from: "date", type: "date", tz: "UTC" } },
			publishAt: { from: "date", tz: "UTC" },
			rules: {
				mode: "upsert",
				protectEdited: false,
				owner: "spelled-out",
				missing: { action: "trash", maxPercent: 25 },
			},
		});
		const noRules = templateSchema.parse({ ...verbose, rules: {} });
		const defaultPercent = templateSchema.parse({
			...verbose,
			rules: { owner: "spelled-out", missing: { action: "trash" } },
		});
		for (const t of [terse, verbose, noRules, defaultPercent]) {
			expect(isEdited(loaded(t)), JSON.stringify(t.rules)).toBe(false);
		}
		// The owner a base without one would get is not an edit; a typed one is.
		expect(
			isEdited(reducer(loaded(terse), { type: "optionsChanged", patch: { owner: "x" } })),
		).toBe(true);
	});

	it("equals the template templates/create returns for the draft that produced it (F9)", () => {
		// The server fills `tz: "UTC"` into the date field and the feed's publishAt.
		const s = reducer(filled, {
			type: "optionsChanged",
			patch: {
				save: { kind: "new", name: "Products feed" },
				status: "schedule",
				schedule: { kind: "feed", from: "date" },
			},
		});
		const stored = templateForSave(toTemplate(s, ownerOf(s)));
		const saved = reducer(s, {
			type: "templateSaved",
			id: "T2",
			revision: 1,
			name: "Products feed",
			template: stored,
			warnings: ["Pinned"],
		});
		expect(saved.options.save).toEqual({ kind: "none" });
		expect(saved.saved).toEqual({ warnings: ["Pinned"] });
		expect(isEdited(saved)).toBe(false);
	});
});

describe("mapBlockers and mappable", () => {
	const blockers = (s: WizardState, fields: readonly SchemaField[] = FIELDS) =>
		mapBlockers(s, fields).map((b) => [b.row, b.msg.id, b.values]);
	const target = run([
		SOURCE_READY,
		{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null },
	]);

	it("blocks Map on an unmapped key, a required unmapped field, a required unmappable field, an unapplied proposal", () => {
		expect(blockers(target)).toEqual([
			["key", M.keyUnmapped.id, undefined],
			["field:title", M.requiredUnmapped.id, { field: "Title" }],
			[null, M.noFieldMapped.id, undefined],
		]);
		expect(blockers(filled)).toEqual([]);

		const blocks = field("blocks", "repeater", { required: true });
		expect(blockers(filled, [...FIELDS, blocks])).toEqual([
			["field:blocks", M.requiredUnmappable.id, { field: "Blocks" }],
		]);
		// Not required: shown disabled on Map, but no blocker.
		expect(blockers(filled, [...FIELDS, field("blocks", "repeater")])).toEqual([]);

		// F3: a draft whose only open item is a proposed field has no blockers.
		const proposal = run(
			[
				{ type: "rowSet", row: "key", mapping: { from: "sku" } },
				{ type: "fieldProposed", field: proposed("colour") },
			],
			target,
		);
		expect(blockers(proposal, [field("title", "string")])).toEqual([]);
	});

	it("skips required fields with a default, non-translatable ones in a translation and flux_source_id (F6)", () => {
		const key = reducer(target, { type: "rowSet", row: "key", mapping: { from: "sku" } });
		const withBody = reducer(key, {
			type: "rowSet",
			row: "field:body",
			mapping: { from: "name", type: "portableText", format: "text" },
		});
		const fields = [
			field("title", "string", { required: true, hasDefault: true }),
			field("code", "string", { required: true, translatable: false }),
			field("flux_source_id", "string", { required: true }),
			field("body", "portableText"),
		];
		expect(blockers(withBody, fields)).toEqual([
			["field:code", M.requiredUnmapped.id, { field: "Code" }],
		]);
		const translation = run(
			[
				{ type: "targetChosen", collection: "posts", locale: "fr", translationLocale: "en" },
				{ type: "rowSet", row: "translationOf", mapping: { from: "sku" } },
			],
			withBody,
		);
		expect(blockers(translation, fields)).toEqual([]);
		expect(
			blockers(reducer(translation, { type: "rowCleared", row: "translationOf" }), fields),
		).toEqual([["translationOf", M.translationOfUnmapped.id, undefined]]);
	});

	it("reports one collection-level blocker for fields EmDash cannot read", () => {
		// A required one adds nothing of its own (review ruling 6).
		const required = [...FIELDS, field("legacy", "geo", { unsupported: true, required: true })];
		expect(blockers(filled, required)).toEqual([
			[null, M.unsupportedField.id, { field: "Legacy" }],
		]);
		const fields = [
			...FIELDS,
			field("legacy", "geo", { unsupported: true }),
			field("old", "string", { unsupported: true }),
		];
		expect(blockers(filled, fields)).toEqual([
			[null, M.unsupportedField.id, { field: "Legacy, Old" }],
		]);
	});

	it("maps a type some mapping writes, and a reference only when bound to a target", () => {
		expect(mappable(field("t", "string"))).toBe(true);
		expect(mappable(field("t", "multiSelect"))).toBe(true);
		expect(mappable(field("t", "repeater"))).toBe(false);
		expect(mappable(field("t", "string", { unsupported: true }))).toBe(false);
		expect(mappable(field("r", "reference"))).toBe(false);
		expect(
			mappable(field("r", "reference", { reference: { target: "people", bound: true } })),
		).toBe(true);
		expect(
			mappable(field("r", "reference", { reference: { target: "people", bound: false } })),
		).toBe(false);
		expect(mappable(field("r", "reference", { reference: { target: null, bound: true } }))).toBe(
			false,
		);
	});
});

describe("reachable (F2)", () => {
	it("follows the steps' own rules, and only Run once a run exists", () => {
		const at = (s: WizardState) => STEPS.filter((step) => reachable(s, step));
		expect(STEPS).toEqual(["source", "target", "map", "options", "preview", "run"]);
		expect(at(initialState)).toEqual(["source"]);
		expect(at(run([SOURCE_READY]))).toEqual(["source", "target"]);
		// F7: a header with no records is not a usable sample.
		const header = reducer(initialState, {
			...SOURCE_READY,
			columns: [{ key: "sku", values: [] }],
		});
		expect(at(header)).toEqual(["source"]);
		expect(at(reducer(initialState, { ...SOURCE_READY, columns: [] }))).toEqual(["source"]);
		const targeted = run(
			[{ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null }],
			run([SOURCE_READY]),
		);
		expect(at(targeted)).toEqual(["source", "target", "map"]);
		expect(at(filled)).toEqual(["source", "target", "map", "options", "preview"]);
		expect(at(withDryRun)).toEqual(STEPS);
		expect(at(startDry(filled, "D", UPLOAD))).not.toContain("run");
		expect(at(reducer(withDryRun, { type: "dryRunFinished", total: 0 }))).not.toContain("run");
		expect(at(reducer(withDryRun, { type: "runStarted", jobId: "R" }))).toEqual(["run"]);
		expect(at(reducer(initialState, { type: "jobReopened", jobId: "J" }))).toEqual(["run"]);
	});
});

describe("optionsBlockers (the step bar can skip Options' Next)", () => {
	const opt = (patch: Partial<Options>, from: WizardState = filled) =>
		reducer(from, { type: "optionsChanged", patch });
	/** The loaded template with one more field mapped: Options offers the save choices. */
	const edited = reducer(loaded(), {
		type: "rowSet",
		row: "field:price",
		mapping: { from: "cost", type: "number" },
	});
	const ids = (s: WizardState) => optionsBlockers(s).map((b) => b.msg.id);
	const many = Array.from({ length: 201 }, (_, i) => `f${i}`);
	const wide = run(
		many.map(
			(slug): WizardAction => ({
				type: "rowSet",
				row: `field:${slug}`,
				mapping: { from: "name", type: "text" },
			}),
		),
		filled,
	);

	it("finds none in a default draft, a loaded template or an edited one run unsaved", () => {
		expect(optionsBlockers(filled)).toEqual([]);
		expect(optionsBlockers(loaded())).toEqual([]);
		expect(isEdited(edited)).toBe(true);
		expect(optionsBlockers(edited)).toEqual([]);
		expect(optionsBlockers(opt({ updateFields: many.slice(0, 200) }, wide))).toEqual([]);
		// A name no longer mapped does not count toward the cap.
		const stale = opt({ updateFields: ["gone", ...many.slice(0, 200)] }, wide);
		expect(optionsBlockers(stale)).toEqual([]);
		// The engine checks a timezone with Luxon, which takes zones `Intl` refuses: the step checks
		// only what is typed there.
		for (const tz of ["site", "UTC", "Europe/Paris", "UTC+2", "Mars/Olympus"]) {
			const s = opt({ status: "schedule", schedule: { kind: "feed", from: "date", tz } });
			expect(optionsBlockers(s)).toEqual([]);
		}
		// Any chosen date: the step writes one form, a saved template may hold another.
		for (const at of ["2026-12-01T09:30", "2026-12-01T09:30:00", "2026-12-01"]) {
			const fixed = opt({ status: "schedule", schedule: { kind: "fixed", at } });
			expect(optionsBlockers(fixed)).toEqual([]);
		}
		// A schedule kept for a later switch back does not block Publish.
		expect(optionsBlockers(opt({ schedule: { kind: "feed", from: "" } }))).toEqual([]);
	});

	it.each([
		["Schedule with no date", { status: "schedule" }, OPTIONS.scheduleUnset],
		[
			"a feed date with no key",
			{ status: "schedule", schedule: { kind: "feed", from: "" } },
			OPTIONS.scheduleUnset,
		],
		["a new template with no name", { save: { kind: "new", name: "" } }, OPTIONS.nameNeeded],
		[
			"a name with a space at the end",
			{ save: { kind: "new", name: "Feed " } },
			OPTIONS.nameInvalid,
		],
		["a name too long", { save: { kind: "new", name: "x".repeat(101) } }, OPTIONS.nameInvalid],
		[
			"a name with a control character",
			{ save: { kind: "new", name: "a\u0007b" } },
			OPTIONS.nameInvalid,
		],
	] as [string, Partial<Options>, { id: string }][])(
		"blocks Preview and Run: %s",
		(_, patch, msg) => {
			const s = opt(patch);
			expect(ids(s)).toEqual([msg.id]);
			expect(reachable(s, "options")).toBe(true);
			expect(reachable(s, "preview")).toBe(false);
			expect(reachable(startDry(s, "D", DRY_UPLOAD, 2), "run")).toBe(false);
		},
	);

	it("blocks more update fields than MAX_UPDATE_FIELDS, unless the mode creates only", () => {
		const s = opt({ updateFields: many }, wide);
		expect(ids(s)).toEqual([OPTIONS.updateFieldsTooMany.id]);
		expect(reachable(s, "preview")).toBe(false);
		expect(optionsBlockers(opt({ mode: "create" }, s))).toEqual([]);
	});

	it("blocks Preview while the changes are to be saved, until templateSaved", () => {
		const s = opt({ save: { kind: "update" } }, edited);
		expect(optionsBlockers(s)).toEqual([
			{ row: null, msg: OPTIONS.saveUnsaved, values: { name: "Products feed" } },
		]);
		expect(reachable(s, "preview")).toBe(false);
		const saved = reducer(s, {
			type: "templateSaved",
			id: "T1",
			revision: 4,
			name: "Products feed",
			template: templateSchema.parse(toTemplate(s, ownerOf(s))),
			warnings: [],
		});
		expect(optionsBlockers(saved)).toEqual([]);
		expect(reachable(saved, "preview")).toBe(true);
	});

	it.each([
		["one date, with seconds", { expr: JSON.stringify("2026-12-01T09:30:00"), tz: "site" }],
		["a feed date in a Luxon zone", { from: "date", format: "yyyy-MM-dd", tz: "UTC+2" }],
	])("lets a saved template with %s reach Preview unedited", (_, publishAt) => {
		const template = templateSchema.parse({ ...BASE_TEMPLATE, publishAt });
		const s = loaded(template);
		expect(isEdited(s)).toBe(false);
		expect(optionsBlockers(s)).toEqual([]);
		expect(reachable(s, "preview")).toBe(true);
	});

	it("ignores a save choice an unedited template no longer offers", () => {
		const base = loaded();
		expect(optionsBlockers(opt({ save: { kind: "update" } }, base))).toEqual([]);
		expect(optionsBlockers(opt({ save: { kind: "new", name: "" } }, base))).toEqual([]);
		expect(ids(opt({ save: { kind: "new", name: "" } }, edited))).toEqual([OPTIONS.nameNeeded.id]);
	});
});

describe("owner (Ruling 15)", () => {
	it("derives the owner from the template name, else wizard-<collection>-<locale>", () => {
		const p = { collection: "posts", locale: "en" };
		expect(deriveOwner({ ...p, templateName: "Products feed" })).toBe("products-feed");
		expect(deriveOwner({ ...p, templateName: "  Été / Winter -- 2026!  " })).toBe("t-winter-2026");
		expect(deriveOwner({ ...p, templateName: "!!!" })).toBe("wizard-posts-en");
		expect(deriveOwner({ ...p, templateName: null })).toBe("wizard-posts-en");
		expect(deriveOwner({ ...p, templateName: "a".repeat(150) })).toBe("a".repeat(100));
		// Never ends in "-" after the cut (review ruling 8).
		expect(deriveOwner({ ...p, templateName: `${"a".repeat(99)} bcd` })).toBe("a".repeat(99));
		const collection = "c".repeat(63);
		const locale = `${"x".repeat(28)} y`;
		expect(deriveOwner({ collection, locale, templateName: null })).toBe(
			`wizard-${collection}-${"x".repeat(28)}`,
		);
		expect(deriveOwner({ collection: "posts", locale: "pt BR", templateName: null })).toBe(
			"wizard-posts-pt-BR",
		);
	});

	it("takes the typed owner, else the save name, else the base name, else the target", () => {
		expect(ownerOf(filled)).toBe("wizard-posts-en");
		const named = reducer(filled, {
			type: "optionsChanged",
			patch: { save: { kind: "new", name: "Spring sale" } },
		});
		expect(ownerOf(named)).toBe("spring-sale");
		const base = loaded(templateSchema.parse({ ...BASE_TEMPLATE, rules: undefined }));
		expect(ownerOf(base)).toBe("products-feed");
		expect(ownerOf(reducer(base, { type: "optionsChanged", patch: { owner: "Mine" } }))).toBe(
			"Mine",
		);
	});
});

describe("jobInput", () => {
	it("builds a dry run's job input from the draft with journal true, and the real run's from the dry run's upload", () => {
		expect(jobInput(filled, true)).toEqual({
			uploadId: UPLOAD,
			dryRun: true,
			template: toTemplate(filled, "wizard-posts-en"),
			publish: true,
			journal: true,
		});
		const options = reducer(withDryRun, {
			type: "optionsChanged",
			patch: { status: "draft", batchSize: 50 },
		});
		const ready = startDry(options, "D2", DRY_UPLOAD, 2);
		expect(jobInput(ready, false)).toEqual({
			uploadId: DRY_UPLOAD,
			dryRun: false,
			template: toTemplate(ready, "wizard-posts-en"),
			publish: false,
			batchSize: 50,
			journal: true,
		});
		const scheduled = reducer(filled, { type: "optionsChanged", patch: { status: "schedule" } });
		expect(jobInput(scheduled, true).publish).toBe(true);
		expect(() => jobInput(filled, false)).toThrow();
		expect(() => jobInput(initialState, true)).toThrow();
	});

	it("builds the job input from the saved template's id and revision when unedited or just saved", () => {
		const s = loaded();
		expect(jobInput(s, true)).toEqual({
			uploadId: UPLOAD,
			dryRun: true,
			templateId: "T1",
			templateRevision: 3,
			publish: true,
			journal: true,
		});
		const edited = reducer(s, { type: "rowSet", row: "slug", mapping: { from: "name" } });
		const inline = jobInput(edited, true);
		expect(inline.templateId).toBeUndefined();
		expect(inline.template).toEqual(toTemplate(edited, "products-feed"));
	});

	it("templateSaved sets base so jobInput runs by the new id and revision; a later rowSet makes it run inline again", () => {
		const s = reducer(filled, {
			type: "optionsChanged",
			patch: { save: { kind: "new", name: "Products feed" } },
		});
		const stored = templateForSave(toTemplate(s, ownerOf(s)));
		const saved = startDry(
			reducer(s, {
				type: "templateSaved",
				id: "T7",
				revision: 2,
				name: "Products feed",
				template: stored,
				warnings: [],
			}),
			"D",
			DRY_UPLOAD,
			2,
		);
		expect(saved.base).toEqual({ id: "T7", revision: 2, name: "Products feed", template: stored });
		expect(jobInput(saved, false)).toMatchObject({ templateId: "T7", templateRevision: 2 });
		expect(jobInput(saved, false).template).toBeUndefined();

		const later = reducer(saved, { type: "rowCleared", row: "bylines" });
		const inline = jobInput(later, true);
		expect(inline.templateId).toBeUndefined();
		expect(inline.template).toEqual(toTemplate(later, "products-feed"));
	});
});

describe("url (Ruling 12)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads ?step and ?job, and writes them with replaceState keeping history.state", () => {
		expect(readUrl("?step=map&job=J1")).toEqual({ step: "map", job: "J1" });
		expect(readUrl("?step=nowhere")).toEqual({ step: null, job: null });
		expect(readUrl("")).toEqual({ step: null, job: null });
		expect(readUrl("?job=")).toEqual({ step: null, job: null });

		const state = { key: "router" };
		const replaceState = vi.fn();
		const base = "https://site.test/_emdash/admin/plugins/flux-import/import";
		const location = { href: `${base}?step=map&tab=x#top` };
		vi.stubGlobal("window", { location, history: { state, replaceState } });
		writeUrl({ step: "run", job: "J1" });
		expect(replaceState).toHaveBeenLastCalledWith(state, "", `${base}?step=run&tab=x&job=J1#top`);
		location.href = `${base}?step=run&job=J1`;
		writeUrl({ job: null });
		expect(replaceState).toHaveBeenLastCalledWith(state, "", `${base}?step=run`);
		writeUrl({ step: "preview" });
		expect(replaceState).toHaveBeenLastCalledWith(state, "", `${base}?step=preview&job=J1`);
	});
});

describe("once (F14)", () => {
	it("shares an in-flight or finished run per key, and runs again after forget or a failure", async () => {
		const { once, forget } = createOnce();
		let calls = 0;
		let release = () => {};
		const work = () => {
			calls++;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const first = once("dry-run", work);
		expect(once("dry-run", work)).toBe(first);
		release();
		await first;
		expect(once("dry-run", work)).toBe(first);
		expect(calls).toBe(1);
		forget("dry-run");
		const second = once("dry-run", work);
		expect(second).not.toBe(first);
		expect(calls).toBe(2);
		release();
		await second;

		const failing = once("run", () => Promise.reject(new Error("offline")));
		await expect(failing).rejects.toThrow("offline");
		await expect(once("run", async () => {})).resolves.toBeUndefined();
	});

	it("forgets the dry run's creation when an action drops the dry run, and only then", () => {
		const tasks = createOnce();
		const seen: WizardAction[] = [];
		const dispatch = draftDispatch((a) => seen.push(a), tasks, withDryRun);
		const dryRun = tasks.once("dry-run", async () => {});
		const realRun = tasks.once("run", async () => {});
		dispatch({ type: "stepChanged", step: "options" });
		dispatch({ type: "dryRunFinished", total: 1 });
		// A no-op edit keeps it too (review ruling 3).
		dispatch({ type: "optionsChanged", patch: { mode: "upsert" } });
		dispatch({ type: "targetChosen", collection: "posts", locale: "en", translationLocale: null });
		expect(tasks.once("dry-run", async () => {})).toBe(dryRun);
		dispatch({ type: "optionsChanged", patch: { batchSize: 5 } });
		const second = tasks.once("dry-run", async () => {});
		expect(second).not.toBe(dryRun);
		expect(tasks.once("run", async () => {})).toBe(realRun);
		// It follows its own dispatches: setting the same batch size again is a no-op.
		dispatch({ type: "optionsChanged", patch: { batchSize: 5 } });
		expect(tasks.once("dry-run", async () => {})).toBe(second);
		expect(seen.map((a) => a.type)).toEqual([
			"stepChanged",
			"dryRunFinished",
			"optionsChanged",
			"targetChosen",
			"optionsChanged",
			"optionsChanged",
		]);
	});
});

describe("StepFooter", () => {
	const render = (initial: Partial<WizardState>, props: Parameters<typeof StepFooter>[0]) => {
		const i18n = setupI18n({ locale: "en", messages: { en: {} } });
		return renderToStaticMarkup(
			createElement(
				I18nProvider,
				{ i18n },
				createElement(
					WizardProvider,
					// `children` comes as createElement's third argument.
					{ initial } as Parameters<typeof WizardProvider>[0],
					createElement(StepFooter, props),
				),
			),
		);
	};

	it("shows Back after the first step, and the reason beside a disabled Next", () => {
		const html = render(
			{ ...filled, step: "map" },
			{ canNext: false, reason: "Map at least one field", onNext: () => {} },
		);
		expect(html).toContain(">Back<");
		expect(html).toMatch(/<span id="([^"]+)"[^>]*>Map at least one field<\/span>/);
		const id = /<span id="([^"]+)"/.exec(html)?.[1];
		const next = /<button[^>]*>(?:(?!<\/button>).)*>Next</.exec(html)?.[0] ?? "";
		expect(next).toContain(' disabled=""');
		expect(next).toContain(`aria-describedby="${id}"`);
		expect(html).toContain(">Next<");
	});

	it("has no Back on Source or once a run exists, and an enabled Next with its own label", () => {
		const source = render(
			{},
			{ canNext: true, reason: "unused", nextLabel: "Run import", onNext: () => {} },
		);
		expect(source).not.toContain(">Back<");
		expect(source).not.toContain("unused");
		expect(source).toContain(">Run import<");
		expect(source).not.toContain(' disabled=""');
		const running = render(
			{ ...filled, step: "run", run: { jobId: "R" } },
			{ canNext: true, onNext: () => {} },
		);
		expect(running).not.toContain(">Back<");
		const busy = render(
			{ ...filled, step: "preview" },
			{ canNext: true, busy: true, onNext: () => {} },
		);
		expect(busy).toContain(' disabled=""');
	});
});

/** One of each action, for the invalidation rule. */
const EVERY_ACTION: WizardAction[] = [
	{ type: "stepChanged", step: "map" },
	SOURCE_READY,
	{ type: "sourceBlockChanged", sourceBlock: { format: "csv" }, columns: COLUMNS },
	{
		type: "templateLoaded",
		base: { id: "T1", revision: 1, name: "Products feed", template: BASE_TEMPLATE },
	},
	{ type: "targetChosen", collection: "posts", locale: "fr", translationLocale: null },
	{ type: "suggestionStarted" },
	{ type: "suggestionFailed", error: new Error("x") },
	{ type: "suggestionReceived", reply: REPLY, overwriteUserRows: false },
	{ type: "warningsDismissed" },
	{ type: "rowSet", row: "slug", mapping: { from: "name" } },
	{ type: "rowCleared", row: "slug" },
	{ type: "fieldProposed", field: proposed("colour") },
	{ type: "fieldChanged", slug: "colour", patch: { label: "Hue" } },
	{ type: "fieldRemoved", slug: "colour" },
	{ type: "fieldsApplied", slugs: ["colour"] },
	{ type: "optionsChanged", patch: { batchSize: 10 } },
	{
		type: "templateSaved",
		id: "T2",
		revision: 1,
		name: "Saved",
		template: BASE_TEMPLATE,
		warnings: [],
	},
	// Under another draft generation: ignored (review ruling 2).
	{ type: "dryRunStarted", jobId: "D9", uploadId: DRY_UPLOAD, generation: -1 },
	{ type: "dryRunFinished", total: 3 },
	{ type: "runStarted", jobId: "R1" },
	{ type: "jobReopened", jobId: "J1" },
];
