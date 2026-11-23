/**
 * The merge of a base template, a validated provider reply and name matching, and the draft built
 * from it (M6d spec steps 6.5 and 7, Rulings 25, 27, 59, 64; plan Rulings 9 and 17). Pure.
 *
 * Merge order: the base template's key, slug and field mappings are kept whole; then a provider
 * item is authoritative for its field, `null` included; every other field keeps its name-matching
 * pick unless a provider item or the provider's slug took its key, and then drops to its next free
 * candidate, or to none. Settled fields (an exact name, Ruling 51) are never replaced, and no reply
 * item may take a settled field's key or a key a base-template field maps (pre-flight F1): such an
 * item is ignored, silently, as if the provider had skipped the field. After the merge no key maps
 * two fields. The draft always passes the shape check, or is `null` (Ruling 27).
 */
import { shapeProblems, templateShapeProblems } from "../../engine/shape.js";
import {
	type FieldPick,
	type KeyPick,
	type NameSuggestion,
	NO_MATCH,
	type SuggestedMapping,
	type SuggestField,
	type SuggestWarning,
} from "../../engine/suggest.js";
import type { MappingType, Template } from "../../engine/template.js";
import { MODEL_RATIONALE, type ReplyItem, type ValidatedReply } from "./reply.js";

export const TEMPLATE_RATIONALE = "From the base template";
/** The provider's key and slug have no confidence of their own (plan Ruling 17). */
export const PROVIDER_KEY_HUNDREDTHS = 60;

export type Origin = "template" | "ai" | "fallback";

export interface Suggestion {
	from: string | null;
	confidence: number;
	rationale: string;
	origin: Origin;
}

export interface FieldSuggestion extends Suggestion {
	field: string;
	fieldType: string;
	required: boolean;
	mapping?: MappingType;
}

export interface MergeInput {
	fields: readonly SuggestField[];
	base: Template | null;
	names: NameSuggestion;
	reply: ValidatedReply | null;
}

export interface Merged {
	key: Suggestion;
	slug?: Suggestion;
	fields: FieldSuggestion[];
	/** The mappings the suggestion adds, by field slug, in schema order; never a base template's. */
	mappings: Map<string, SuggestedMapping>;
	method: "ai" | "fallback";
}

export interface DraftInput {
	collection: string;
	locale: string;
	source: Readonly<Record<string, unknown>>;
}

const template = (from: string | undefined): Suggestion => ({
	from: from ?? null,
	confidence: 1,
	rationale: TEMPLATE_RATIONALE,
	origin: "template",
});

const provider = (from: string): Suggestion => ({
	from,
	confidence: PROVIDER_KEY_HUNDREDTHS / 100,
	rationale: MODEL_RATIONALE,
	origin: "ai",
});

const fallback = (pick: KeyPick): Suggestion => ({
	from: pick.from,
	confidence: pick.hundredths / 100,
	rationale: pick.rationale,
	origin: "fallback",
});

/** A field's answer before it is placed in the list: a suggestion and its full mapping. */
type Answer = { suggestion: Suggestion; mapping?: SuggestedMapping };

function answerOf(
	pick: Pick<FieldPick, "from" | "hundredths" | "rationale" | "mapping">,
	origin: Origin,
): Answer {
	const suggestion = {
		from: pick.from,
		confidence: pick.hundredths / 100,
		rationale: pick.rationale,
		origin,
	};
	return pick.from !== null && pick.mapping !== undefined
		? { suggestion, mapping: pick.mapping }
		: { suggestion };
}

const NONE: Answer = {
	suggestion: { from: null, confidence: 0, rationale: NO_MATCH, origin: "fallback" },
};

/** Merges the base template, the provider's reply and name matching (spec step 6.5). */
export function mergeSuggestions({ fields, base, names, reply }: MergeInput): Merged {
	let key: Suggestion;
	if (base !== null) key = template(base.key.from);
	else if (reply !== null && reply.key !== null) key = provider(reply.key);
	else if (names.key !== null) key = fallback(names.key);
	else key = { ...NONE.suggestion };

	let slug: Suggestion | undefined;
	if (base?.slug !== undefined) slug = template(base.slug.from);
	else if (reply !== null && reply.slug !== null) slug = provider(reply.slug);
	else if (names.slug !== null) slug = fallback(names.slug);

	const answers = new Map<string, Answer>();
	const baseFields = base?.fields ?? {};
	const open = fields.filter((f) => !Object.hasOwn(baseFields, f.slug));
	const picks = new Map(open.map((f) => [f.slug, names.fields.get(f.slug)]));
	const settled = open.filter((f) => picks.get(f.slug)?.settled === true);

	// Keys no reply item may take: the settled picks' and the base template's (pre-flight F1).
	const reserved = new Set<string>();
	for (const f of settled) {
		const from = picks.get(f.slug)?.from ?? null;
		if (from !== null) reserved.add(from);
	}
	for (const mapping of Object.values(baseFields)) {
		if (mapping.from !== undefined) reserved.add(mapping.from);
	}
	if (base?.slug?.from !== undefined) reserved.add(base.slug.from);

	const items = new Map<string, ReplyItem>();
	for (const i of reply?.items ?? []) {
		const field = picks.get(i.field);
		if (field === undefined || field.settled) continue;
		if (i.from !== null && reserved.has(i.from)) continue;
		items.set(i.field, i);
	}

	const taken = new Set(reserved);
	for (const i of items.values()) if (i.from !== null) taken.add(i.from);
	if (slug?.origin === "ai" && slug.from !== null) taken.add(slug.from);

	const displaced = new Set<string>();
	for (const f of open) {
		const i = items.get(f.slug);
		const pick = picks.get(f.slug);
		if (i !== undefined) answers.set(f.slug, answerOf(i, "ai"));
		else if (pick === undefined) answers.set(f.slug, NONE);
		else if (pick.settled) answers.set(f.slug, answerOf(pick, "fallback"));
		else if (pick.from === null || !taken.has(pick.from)) {
			answers.set(f.slug, answerOf(pick, "fallback"));
			if (pick.from !== null) taken.add(pick.from);
		} else displaced.add(f.slug);
	}
	for (const c of names.candidates) {
		if (!displaced.has(c.field) || taken.has(c.key)) continue;
		answers.set(c.field, answerOf({ ...c, from: c.key }, "fallback"));
		displaced.delete(c.field);
		taken.add(c.key);
	}
	for (const field of displaced) answers.set(field, NONE);

	const out: FieldSuggestion[] = [];
	const mappings = new Map<string, SuggestedMapping>();
	for (const f of fields) {
		const described = { field: f.slug, fieldType: f.type, required: f.required };
		const kept = Object.hasOwn(baseFields, f.slug) ? baseFields[f.slug] : undefined;
		if (kept !== undefined) {
			out.push({ ...described, ...template(kept.from), mapping: kept.type });
			continue;
		}
		const { suggestion, mapping } = answers.get(f.slug) ?? NONE;
		if (mapping === undefined) {
			out.push({ ...described, ...suggestion });
			continue;
		}
		out.push({ ...described, ...suggestion, mapping: mapping.type });
		mappings.set(f.slug, mapping);
	}

	const usedReply =
		out.some((f) => f.origin === "ai" && f.from !== null) ||
		key.origin === "ai" ||
		slug?.origin === "ai";
	return {
		key,
		...(slug === undefined ? {} : { slug }),
		fields: out,
		mappings,
		method: usedReply ? "ai" : "fallback",
	};
}

/** The draft template, not yet shape-checked; `null` when it would map no field or has no key. */
export function buildDraft(
	input: MergeInput,
	draft: DraftInput,
	merged: Merged,
): Record<string, unknown> | null {
	const fields = Object.fromEntries(merged.mappings);
	const slugFrom = merged.slug?.from ?? null;
	const { base } = input;
	if (base !== null) {
		return {
			...base,
			...(base.slug === undefined && slugFrom !== null ? { slug: { from: slugFrom } } : {}),
			fields: { ...base.fields, ...fields },
		};
	}
	if (Object.keys(fields).length === 0 || merged.key.from === null) return null;
	return {
		version: 1,
		source: draft.source,
		collection: draft.collection,
		locale: draft.locale,
		key: { from: merged.key.from },
		...(slugFrom === null ? {} : { slug: { from: slugFrom } }),
		fields,
	};
}

/** The template as `templates/create` would store it, or `null` when any shape check fails. */
export function shapeChecked(draft: unknown): Template | null {
	const shape = templateShapeProblems(draft);
	return shape.ok && shapeProblems(shape).length === 0 ? shape.template : null;
}

/**
 * The merge and its shape-checked draft (spec step 7, Ruling 27): a draft that used the reply and
 * fails is rebuilt from name matching alone (`ai_draft_invalid`); no passing draft is `null`
 * (`no_field_matched`). `merged` is the merge the template was built from.
 */
export function mergeAndDraft(
	input: MergeInput,
	draft: DraftInput,
): { merged: Merged; template: Template | null; warnings: SuggestWarning[] } {
	const merged = mergeSuggestions(input);
	const built = buildDraft(input, draft, merged);
	if (built === null) return { merged, template: null, warnings: [{ code: "no_field_matched" }] };
	const checked = shapeChecked(built);
	if (checked !== null) return { merged, template: checked, warnings: [] };
	if (input.reply === null) {
		return { merged, template: null, warnings: [{ code: "no_field_matched" }] };
	}
	const plainInput = { ...input, reply: null };
	const plain = mergeSuggestions(plainInput);
	const rebuilt = buildDraft(plainInput, draft, plain);
	const template = rebuilt === null ? null : shapeChecked(rebuilt);
	const warnings: SuggestWarning[] = [{ code: "ai_draft_invalid" }];
	if (template === null) warnings.push({ code: "no_field_matched" });
	return { merged: plain, template, warnings };
}
