import type { Template } from "../../engine/template.js";
import type { SuggestReply } from "../../plugin/suggest.js";
import type { Msg, Values } from "../i18n.js";
import { COMPATIBLE, MAX_UPDATE_FIELDS, TEMPLATE_NAME_MAX } from "../limits.js";
import type { CreateJobInput, SampleColumn, SchemaField, SourceBlock } from "../types.js";
import { M } from "./messages.js";
import { M as OPTIONS } from "./options/messages.js";

/**
 * The wizard's state: a pure reducer over the draft, and the pure helpers several steps share
 * (the draft template, its blockers, the owner, the job input).
 */

export type StepId = "source" | "target" | "map" | "options" | "preview" | "run";
export const STEPS: readonly StepId[] = ["source", "target", "map", "options", "preview", "run"];

export type RowId =
	| "key"
	| "slug"
	| "publishAt"
	| "translationOf"
	| "bylines"
	| `field:${string}`
	| `taxonomy:${string}`;
export type ValueSource = { from: string } | { expr: string };
/** A field's `FieldMapping`, a taxonomy's or bylines' options, or a bare `ValueSource`. */
export type RowMapping = ValueSource & Record<string, unknown>;
export interface RowMeta {
	origin: "ai" | "name" | "template" | "user";
	confidence?: number;
	rationale?: string;
	check: boolean;
}
export interface SourceChoice {
	kind: "upload" | "url" | "paste" | "saved";
	uploadId: string;
	label: string;
}
export interface ProposedField {
	key: string;
	slug: string;
	label: string;
	type: string;
	translatable: boolean;
	searchable: boolean;
}
export interface Options {
	mode: "upsert" | "create" | "update";
	updateFields: string[];
	protectEdited: boolean;
	status: "publish" | "draft" | "schedule";
	schedule:
		| { kind: "fixed"; at: string }
		| { kind: "feed"; from: string; format?: string; tz?: string }
		/** A saved template's `publishAt` the other two cannot express, kept verbatim (F4). */
		| { kind: "kept"; mapping: Record<string, unknown> }
		| null;
	missing: { action: "trash" | "unpublish"; maxPercent: number } | null;
	/** null: derived (Ruling 15). */
	owner: string | null;
	batchSize: number | null;
	/** "update" only with a base. */
	save: { kind: "none" } | { kind: "new"; name: string } | { kind: "update" };
}
export interface WizardState {
	step: StepId;
	source: SourceChoice | null;
	sourceBlock: SourceBlock;
	columns: SampleColumn[] | null;
	base: { id: string; revision: number; name: string; template: Template } | null;
	target: { collection: string; locale: string; translationLocale: string | null } | null;
	rows: Partial<Record<RowId, RowMapping>>;
	meta: Partial<Record<RowId, RowMeta>>;
	suggestion: {
		status: "idle" | "loading" | "done" | "error";
		reply?: SuggestReply;
		error?: unknown;
		dismissed: boolean;
		/** The ask in flight, while `loading`: an answer to any other one is dropped. */
		ask?: number;
	};
	newFields: ProposedField[];
	options: Options;
	/** The warnings of the save that made `base` (preflight F1); cleared by any later edit. */
	saved: { warnings: string[] } | null;
	dryRun: { jobId: string; uploadId: string; total: number | null } | null;
	run: { jobId: string } | null;
	dirty: boolean;
	/**
	 * The draft's generation: every action that changes the draft adds one. A dry run is started
	 * under the generation read when its `jobs/create` was sent (review ruling 2).
	 */
	generation: number;
}
export type WizardAction =
	| { type: "stepChanged"; step: StepId }
	| { type: "sourceReady"; source: SourceChoice; sourceBlock: SourceBlock; columns: SampleColumn[] }
	| { type: "sourceBlockChanged"; sourceBlock: SourceBlock; columns: SampleColumn[] | null }
	/** Fills target, rows, meta (origin template), options and the source block; step → preview. */
	| { type: "templateLoaded"; base: NonNullable<WizardState["base"]> }
	| { type: "targetChosen"; collection: string; locale: string; translationLocale: string | null }
	/** `ask` names the request, so a late answer to an earlier one is dropped. */
	| { type: "suggestionStarted"; ask?: number }
	| { type: "suggestionFailed"; error: unknown; ask?: number }
	| { type: "suggestionReceived"; reply: SuggestReply; overwriteUserRows: boolean; ask?: number }
	| { type: "warningsDismissed" }
	| { type: "rowSet"; row: RowId; mapping: RowMapping }
	| { type: "rowCleared"; row: RowId }
	| { type: "fieldProposed"; field: ProposedField }
	| { type: "fieldChanged"; slug: string; patch: Partial<ProposedField> }
	| { type: "fieldRemoved"; slug: string }
	| { type: "fieldsApplied"; slugs: string[] }
	| { type: "optionsChanged"; patch: Partial<Options> }
	| {
			type: "templateSaved";
			id: string;
			revision: number;
			name: string;
			template: Template;
			warnings: string[];
	  }
	/** Ignored unless `generation` is still the state's: an edit made meanwhile wins. */
	| { type: "dryRunStarted"; jobId: string; uploadId: string; generation: number }
	| { type: "dryRunFinished"; total: number }
	| { type: "runStarted"; jobId: string }
	| { type: "jobReopened"; jobId: string };

export const DEFAULT_OPTIONS: Options = {
	mode: "upsert",
	updateFields: [],
	protectEdited: false,
	status: "publish",
	schedule: null,
	missing: null,
	owner: null,
	batchSize: null,
	save: { kind: "none" },
};

/** `rules.missing.maxPercent` when a template leaves it out (`MISSING_MAX_PERCENT_DEFAULT`). */
const MISSING_MAX_PERCENT_DEFAULT = 25;
/** The engine's `SITE_TIMEZONE`. */
const SITE_TIMEZONE = "site";
/** The engine's `SOURCE_ID_FIELD`: never a target (plan Ruling 5). */
const SOURCE_ID_FIELD = "flux_source_id";

const IDLE: WizardState["suggestion"] = { status: "idle", dismissed: false };

export const initialState: WizardState = {
	step: "source",
	source: null,
	sourceBlock: { format: "csv" },
	columns: null,
	base: null,
	target: null,
	rows: {},
	meta: {},
	suggestion: IDLE,
	newFields: [],
	options: DEFAULT_OPTIONS,
	saved: null,
	dryRun: null,
	run: null,
	dirty: false,
	generation: 0,
};

/** The actions that leave the draft as it is; every other one invalidates the dry run. */
const KEEPS_DRAFT = new Set<WizardAction["type"]>([
	"stepChanged",
	"warningsDismissed",
	"dryRunStarted",
	"dryRunFinished",
	"runStarted",
	"jobReopened",
	"templateSaved",
]);

/**
 * Whether `action` changes the draft: the reducer then sets `dryRun: null`, `saved: null` and
 * `dirty`, and adds one to `generation`. A `targetChosen` or `optionsChanged` that changes nothing
 * does not (review ruling 3).
 */
export function clearsDryRun(state: WizardState, action: WizardAction): boolean {
	if (KEEPS_DRAFT.has(action.type)) return false;
	if (action.type === "targetChosen") {
		const { collection, locale, translationLocale } = action;
		return !sameJson({ collection, locale, translationLocale }, state.target);
	}
	if (action.type === "optionsChanged") {
		return !sameJson({ ...state.options, ...action.patch }, state.options);
	}
	return true;
}

/** The rows `flagMissingKeys` checks: the key, the slug and each field. */
const isKeyedRow = (row: string) => row === "key" || row === "slug" || row.startsWith("field:");

/**
 * Marks "check" on each key, slug and field row whose source key the new sample lacks (review
 * ruling 1). Soft: a sample may miss a rare path, so the row stays and nothing blocks.
 */
function flagMissingKeys(state: WizardState, columns: SampleColumn[]): WizardState["meta"] {
	const keys = new Set(columns.map((c) => c.key));
	const meta = { ...state.meta };
	for (const [row, m] of Object.entries(state.rows) as [RowId, RowMapping | undefined][]) {
		if (m === undefined || !isKeyedRow(row) || typeof m.from !== "string" || keys.has(m.from)) {
			continue;
		}
		meta[row] = { ...(meta[row] ?? { origin: "user" }), check: true };
	}
	return meta;
}

const ORIGIN = { ai: "ai", fallback: "name", template: "template" } as const;
/** The warnings that ask the user to confirm a field's format (Global Constraints). */
const FORMAT_WARNINGS = new Set(["date_format_ambiguous", "number_format_ambiguous"]);

function metaOf(
	s: { confidence: number; rationale: string; origin: keyof typeof ORIGIN },
	flagged: boolean,
): RowMeta {
	return {
		origin: ORIGIN[s.origin],
		confidence: s.confidence,
		rationale: s.rationale,
		check: s.confidence < 0.5 || flagged,
	};
}

/** The rows and meta a suggestion fills (spec "Suggestions"): user rows only when asked. */
function applySuggestion(state: WizardState, reply: SuggestReply, overwrite: boolean) {
	const rows = { ...state.rows };
	const meta = { ...state.meta };
	const flagged = new Set(
		reply.warnings.filter((w) => FORMAT_WARNINGS.has(w.code)).flatMap((w) => w.fields ?? []),
	);
	const fill = (row: RowId, mapping: RowMapping | null, m: RowMeta) => {
		const origin = state.meta[row]?.origin;
		if (mapping === null) {
			// Only what an earlier suggestion filled is cleared (review ruling 4).
			if (origin === "ai" || origin === "name") {
				delete rows[row];
				delete meta[row];
			}
		} else if (overwrite || origin !== "user") {
			rows[row] = mapping;
			meta[row] = m;
		}
	};
	const draft = reply.template;
	// The draft's own mapping, else the suggested key alone.
	const rowOf = (drafted: object | undefined, from: string | null): RowMapping | null => {
		if (drafted !== undefined) return { ...drafted } as RowMapping;
		return from === null ? null : { from };
	};
	fill("key", rowOf(draft?.key, reply.key.from), metaOf(reply.key, false));
	if (reply.slug !== undefined) {
		fill("slug", rowOf(draft?.slug, reply.slug.from), metaOf(reply.slug, false));
	}
	for (const f of reply.fields) {
		const fromDraft = draft !== null && Object.hasOwn(draft.fields, f.field);
		let mapping: RowMapping | null = null;
		if (fromDraft) mapping = { ...draft.fields[f.field] } as RowMapping;
		else if (f.from !== null && f.mapping !== undefined) {
			mapping = { from: f.from, type: f.mapping };
		}
		fill(`field:${f.field}`, mapping, metaOf(f, flagged.has(f.field)));
	}
	return { rows, meta };
}

function without<K extends string, V>(record: Partial<Record<K, V>>, key: K) {
	const next = { ...record };
	delete next[key];
	return next;
}

function reduce(state: WizardState, action: WizardAction): WizardState {
	switch (action.type) {
		case "stepChanged":
			return { ...state, step: action.step };
		case "sourceReady":
			return {
				...state,
				source: action.source,
				sourceBlock: action.sourceBlock,
				columns: action.columns,
				meta: flagMissingKeys(state, action.columns),
				suggestion: IDLE,
			};
		case "sourceBlockChanged":
			return {
				...state,
				sourceBlock: action.sourceBlock,
				columns: action.columns,
				meta: action.columns === null ? state.meta : flagMissingKeys(state, action.columns),
				suggestion: IDLE,
			};
		case "templateLoaded": {
			const { rows, meta, options, target } = fromTemplate(action.base.template);
			return {
				...state,
				// F10: the job needs the sampled file, so without one the step stays.
				step: state.source === null ? state.step : "preview",
				base: action.base,
				sourceBlock: action.base.template.source,
				target,
				rows,
				meta,
				options: { ...DEFAULT_OPTIONS, ...options },
				newFields: [],
				suggestion: IDLE,
			};
		}
		case "targetChosen": {
			const target = {
				collection: action.collection,
				locale: action.locale,
				translationLocale: action.translationLocale,
			};
			if (state.target?.collection === action.collection) return { ...state, target };
			return { ...state, target, rows: {}, meta: {}, newFields: [], suggestion: IDLE };
		}
		case "suggestionStarted":
			return {
				...state,
				suggestion: {
					status: "loading",
					dismissed: false,
					...(action.ask === undefined ? {} : { ask: action.ask }),
				},
			};
		case "suggestionFailed":
			return { ...state, suggestion: { status: "error", error: action.error, dismissed: false } };
		case "suggestionReceived":
			return {
				...state,
				...applySuggestion(state, action.reply, action.overwriteUserRows),
				suggestion: { status: "done", reply: action.reply, dismissed: false },
			};
		case "warningsDismissed":
			return { ...state, suggestion: { ...state.suggestion, dismissed: true } };
		case "rowSet":
			return {
				...state,
				rows: { ...state.rows, [action.row]: action.mapping },
				meta: { ...state.meta, [action.row]: { origin: "user", check: false } },
			};
		case "rowCleared":
			return {
				...state,
				rows: without(state.rows, action.row),
				meta: without(state.meta, action.row),
			};
		case "fieldProposed":
			return {
				...state,
				newFields: [...state.newFields.filter((f) => f.slug !== action.field.slug), action.field],
			};
		case "fieldChanged":
			return {
				...state,
				newFields: state.newFields.map((f) =>
					f.slug === action.slug ? { ...f, ...action.patch } : f,
				),
			};
		case "fieldRemoved":
			return { ...state, newFields: state.newFields.filter((f) => f.slug !== action.slug) };
		case "fieldsApplied": {
			const applied = new Set(action.slugs);
			return { ...state, newFields: state.newFields.filter((f) => !applied.has(f.slug)) };
		}
		case "optionsChanged":
			return { ...state, options: { ...state.options, ...action.patch } };
		case "templateSaved":
			return {
				...state,
				base: {
					id: action.id,
					revision: action.revision,
					name: action.name,
					template: action.template,
				},
				saved: { warnings: action.warnings },
				options: { ...state.options, save: { kind: "none" } },
			};
		case "dryRunStarted":
			if (action.generation !== state.generation) return state;
			return { ...state, dryRun: { jobId: action.jobId, uploadId: action.uploadId, total: null } };
		case "dryRunFinished":
			return state.dryRun === null
				? state
				: { ...state, dryRun: { ...state.dryRun, total: action.total } };
		case "runStarted":
			return { ...state, run: { jobId: action.jobId } };
		case "jobReopened":
			return { ...state, step: "run", run: { jobId: action.jobId }, dirty: false };
	}
}

/**
 * An answer to an ask the draft no longer waits for: the suggestion was reset (a new source or
 * collection) or asked again since. Only an answer that names its ask is checked.
 */
function staleAnswer(state: WizardState, action: WizardAction): boolean {
	if (action.type !== "suggestionReceived" && action.type !== "suggestionFailed") return false;
	if (action.ask === undefined) return false;
	return state.suggestion.status !== "loading" || state.suggestion.ask !== action.ask;
}

export function reducer(state: WizardState, action: WizardAction): WizardState {
	if (staleAnswer(state, action)) return state;
	const clears = clearsDryRun(state, action);
	// A target or options change that changes nothing leaves the state as it is (review ruling 3).
	if (!clears && (action.type === "targetChosen" || action.type === "optionsChanged")) return state;
	const next = reduce(state, action);
	if (!clears) return next;
	return { ...next, dryRun: null, saved: null, dirty: true, generation: state.generation + 1 };
}

// --- The draft template ---

/** Only `from` or `expr`: the key, slug and `translationOf` take nothing else. */
function valueSource(m: RowMapping): ValueSource {
	if (typeof m.from === "string") return { from: m.from };
	if (typeof m.expr === "string") return { expr: m.expr };
	throw new Error("A mapping needs a source key or an expression");
}

/** A copy without the keys whose value is `undefined`. */
function defined<T extends object>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function rowsWith(rows: WizardState["rows"], prefix: "field:" | "taxonomy:") {
	return Object.fromEntries(
		Object.entries(rows).flatMap(([row, m]) =>
			row.startsWith(prefix) && m !== undefined ? [[row.slice(prefix.length), m]] : [],
		),
	) as Record<string, RowMapping>;
}

/** The template's mapping names, as `rules.updateFields` lists them (engine `mappingNames`). */
export function mappingNamesOf(rows: WizardState["rows"]): string[] {
	return [
		...Object.keys(rowsWith(rows, "field:")),
		...(rows.slug === undefined ? [] : ["slug"]),
		...Object.keys(rowsWith(rows, "taxonomy:")).map((name) => `taxonomies.${name}`),
		...(rows.bylines === undefined ? [] : ["bylines"]),
	];
}

function publishAtOf(options: Options): Record<string, unknown> | undefined {
	if (options.status !== "schedule" || options.schedule === null) return undefined;
	const s = options.schedule;
	switch (s.kind) {
		case "fixed":
			// Ruling 16: one date for every record, read in the site's timezone.
			return { expr: JSON.stringify(s.at), tz: SITE_TIMEZONE };
		case "feed":
			return defined({ from: s.from, format: s.format, tz: s.tz });
		case "kept":
			return s.mapping;
	}
}

function rulesOf(state: WizardState, owner: string): Record<string, unknown> {
	const { mode, updateFields, protectEdited, missing } = state.options;
	const updates = mode !== "create";
	const names = new Set(mappingNamesOf(state.rows));
	const listed = [...new Set(updateFields)].filter((name) => names.has(name));
	return {
		owner,
		...(mode === "upsert" ? {} : { mode }),
		...(updates && listed.length > 0 ? { updateFields: listed } : {}),
		...(updates && protectEdited ? { protectEdited: true } : {}),
		...(missing === null
			? {}
			: { missing: { action: missing.action, maxPercent: missing.maxPercent } }),
	};
}

/**
 * The draft as a template (preflight F4, F8): `version`, `source`, `collection`, `locale`, `key`,
 * then `slug`, `translationOf`, `fields`, `taxonomies`, `bylines` and `publishAt` when set, and
 * `rules`, which always names the owner.
 */
export function toTemplate(state: WizardState, owner: string): unknown {
	const { target, rows } = state;
	if (target === null || rows.key === undefined) {
		throw new Error("The draft has no target collection or key yet");
	}
	const taxonomies = rowsWith(rows, "taxonomy:");
	const publishAt = publishAtOf(state.options);
	return {
		version: 1,
		source: defined(state.sourceBlock),
		collection: target.collection,
		locale: target.locale,
		key: valueSource(rows.key),
		...(rows.slug === undefined ? {} : { slug: valueSource(rows.slug) }),
		...(rows.translationOf === undefined || target.translationLocale === null
			? {}
			: {
					translationOf: { ...valueSource(rows.translationOf), locale: target.translationLocale },
				}),
		fields: rowsWith(rows, "field:"),
		...(Object.keys(taxonomies).length === 0 ? {} : { taxonomies }),
		...(rows.bylines === undefined ? {} : { bylines: rows.bylines }),
		...(publishAt === undefined ? {} : { publishAt }),
		rules: rulesOf(state, owner),
	};
}

function scheduleOf(publishAt: Record<string, unknown>): Options["schedule"] {
	if (typeof publishAt.from === "string") {
		const { format, tz } = publishAt;
		return {
			kind: "feed",
			from: publishAt.from,
			...(typeof format === "string" ? { format } : {}),
			...(typeof tz === "string" ? { tz } : {}),
		};
	}
	if (typeof publishAt.expr === "string" && publishAt.tz === SITE_TIMEZONE) {
		try {
			const at: unknown = JSON.parse(publishAt.expr);
			if (typeof at === "string") return { kind: "fixed", at };
		} catch {
			// Not a constant: kept below.
		}
	}
	return { kind: "kept", mapping: { ...publishAt } };
}

/** When the entries go live: a status and its schedule, as Preview and Run state them. */
export type Publishing = Pick<Options, "status" | "schedule">;

/**
 * A job's own publishing, for a Run screen that shows a job (one reopened by URL has no draft
 * options): no `publish` keeps drafts (engine `targetOf`); otherwise the template's `publishAt`
 * schedules, read as `fromTemplate` reads it, and without one the entries are published.
 */
export function publishingOfJob(job: { publish: boolean; template: Template }): Publishing {
	if (!job.publish) return { status: "draft", schedule: null };
	const at = job.template.publishAt;
	if (at === undefined) return { status: "publish", schedule: null };
	return { status: "schedule", schedule: scheduleOf(at) };
}

/** A saved template as the draft's rows, meta, target and options (preflight F4, F9). */
export function fromTemplate(t: Template): Pick<WizardState, "rows" | "meta"> & {
	options: Partial<Options>;
	target: NonNullable<WizardState["target"]>;
} {
	const rows: WizardState["rows"] = { key: valueSource(t.key as RowMapping) };
	if (t.slug !== undefined) rows.slug = valueSource(t.slug as RowMapping);
	if (t.translationOf !== undefined) {
		rows.translationOf = valueSource(t.translationOf as RowMapping);
	}
	for (const [slug, m] of Object.entries(t.fields)) rows[`field:${slug}`] = { ...m } as RowMapping;
	for (const [name, m] of Object.entries(t.taxonomies ?? {})) {
		rows[`taxonomy:${name}`] = { ...m } as RowMapping;
	}
	if (t.bylines !== undefined) rows.bylines = { ...t.bylines } as RowMapping;
	const meta: WizardState["meta"] = {};
	for (const row of Object.keys(rows) as RowId[]) meta[row] = { origin: "template", check: false };

	const r = t.rules ?? {};
	const options: Partial<Options> = {
		owner: r.owner ?? null,
		mode: r.mode ?? "upsert",
		updateFields: r.updateFields ?? [],
		protectEdited: r.protectEdited ?? false,
		missing:
			r.missing === undefined
				? null
				: {
						action: r.missing.action,
						maxPercent: r.missing.maxPercent ?? MISSING_MAX_PERCENT_DEFAULT,
					},
	};
	if (t.publishAt !== undefined) {
		options.status = "schedule";
		options.schedule = scheduleOf(t.publishAt);
	}
	return {
		rows,
		meta,
		options,
		target: {
			collection: t.collection,
			locale: t.locale,
			translationLocale: t.translationOf?.locale ?? null,
		},
	};
}

/** Whether a value is a plain object (a JSON object, not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A template's mapping with the engine's default `tz` dropped. */
function withoutUtc(m: unknown): unknown {
	if (!isRecord(m) || m.tz !== "UTC") return m;
	const { tz: _, ...rest } = m;
	return rest;
}

/**
 * A template in the form two equivalent templates share (preflight F9): no `undefined` values,
 * no `tz: "UTC"` on dates and `publishAt`, no default rules (`mode: "upsert"`,
 * `protectEdited: false`, an empty `updateFields`, `maxPercent` 25) and no empty `rules`.
 */
function canonical(input: unknown, dropOwner: boolean): unknown {
	const t = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
	if (isRecord(t.fields)) {
		t.fields = Object.fromEntries(
			Object.entries(t.fields).map(([k, m]) => [
				k,
				isRecord(m) && m.type === "date" ? withoutUtc(m) : m,
			]),
		);
	}
	if (t.publishAt !== undefined) t.publishAt = withoutUtc(t.publishAt);
	if (isRecord(t.rules)) {
		const r = { ...t.rules };
		if (r.mode === "upsert") delete r.mode;
		if (r.protectEdited === false) delete r.protectEdited;
		if (Array.isArray(r.updateFields) && r.updateFields.length === 0) delete r.updateFields;
		if (isRecord(r.missing) && r.missing.maxPercent === MISSING_MAX_PERCENT_DEFAULT) {
			r.missing = { action: r.missing.action };
		}
		if (dropOwner) delete r.owner;
		if (Object.keys(r).length === 0) delete t.rules;
		else t.rules = r;
	}
	return t;
}

/** Equal JSON values, whatever their keys' order. */
function sameJson(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((v, i) => sameJson(v, b[i]))
		);
	}
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
		);
	}
	return a === b;
}

/** Whether the draft differs from the saved template it started from (preflight F9). */
export function isEdited(state: WizardState): boolean {
	const { base } = state;
	if (base === null) return false;
	if (state.target === null || state.rows.key === undefined) return true;
	// A base without an owner gets a derived one: that alone is no edit.
	const dropOwner = base.template.rules?.owner === undefined && state.options.owner === null;
	return !sameJson(
		canonical(toTemplate(state, ownerOf(state)), dropOwner),
		canonical(base.template, false),
	);
}

// --- Map's blockers ---

export type Blocker = { row: RowId | null; msg: Msg; values?: Values };

/** Whether some mapping can write the field (preflight F6): a reference only when bound. */
export function mappable(field: SchemaField): boolean {
	if (field.unsupported) return false;
	if (!Object.values(COMPATIBLE).some((types) => types.includes(field.type))) return false;
	if (field.type !== "reference") return true;
	return field.reference?.bound === true && field.reference.target !== null;
}

/**
 * What stops Map's Next (preflight F3, F6, F8; Review Focus 5): the key unmapped; a required field
 * with no default unmapped, or one no mapping can write; a Portable Text mapping without its
 * source format (Preview would fail with INVALID_TEMPLATE); a field EmDash cannot read; no field
 * mapped, counting proposed fields; a translation without its `translationOf` row. A proposed
 * field never blocks: Next opens the schema diff for it.
 */
export function mapBlockers(state: WizardState, fields: readonly SchemaField[]): Blocker[] {
	const { rows, target } = state;
	const translation = target !== null && target.translationLocale !== null;
	const blockers: Blocker[] = [];
	if (rows.key === undefined) blockers.push({ row: "key", msg: M.keyUnmapped });
	for (const f of fields) {
		if (!f.required || f.hasDefault || f.slug === SOURCE_ID_FIELD) continue;
		// A translation takes a non-translatable field from its source (engine `checkTemplate`).
		if (translation && !f.translatable) continue;
		// An unsupported field has the collection-level blocker below (review ruling 6).
		if (f.unsupported) continue;
		const row: RowId = `field:${f.slug}`;
		if (!mappable(f)) blockers.push({ row, msg: M.requiredUnmappable, values: { field: f.label } });
		else if (rows[row] === undefined) {
			blockers.push({ row, msg: M.requiredUnmapped, values: { field: f.label } });
		}
	}
	// The engine's grammar requires a Portable Text mapping's `format` (`template.ts`).
	for (const [slug, m] of Object.entries(rowsWith(rows, "field:"))) {
		if (m.type !== "portableText" || m.format !== undefined) continue;
		const label = fields.find((f) => f.slug === slug)?.label ?? slug;
		blockers.push({ row: `field:${slug}`, msg: M.formatUnset, values: { field: label } });
	}
	const unsupported = fields.filter((f) => f.unsupported);
	if (unsupported.length > 0) {
		const names = unsupported.map((f) => f.label).join(", ");
		blockers.push({ row: null, msg: M.unsupportedField, values: { field: names } });
	}
	const mapped = Object.keys(rowsWith(rows, "field:")).length + state.newFields.length;
	if (mapped === 0) blockers.push({ row: null, msg: M.noFieldMapped });
	if (translation && rows.translationOf === undefined) {
		blockers.push({ row: "translationOf", msg: M.translationOfUnmapped });
	}
	return blockers;
}

// --- Options' blockers ---

/**
 * What `templates/create` refuses in a name (`templateNameProblem`): empty, over
 * `TEMPLATE_NAME_MAX`, a space at either end, or a control or format character. Whether the name
 * is taken needs the saved templates, so the Options step checks that itself.
 */
export function templateNameRule(name: string): Blocker | null {
	const n = name.normalize("NFC");
	if (n.length === 0) return { row: null, msg: OPTIONS.nameNeeded };
	if (n.length > TEMPLATE_NAME_MAX || /^\s|\s$/u.test(n) || /[\p{Cc}\p{Cf}]/u.test(n)) {
		return { row: null, msg: OPTIONS.nameInvalid, values: { max: TEMPLATE_NAME_MAX } };
	}
	return null;
}

/**
 * Whether Options offers a save choice: always for a new draft, and for a saved template only
 * once it is edited. An unedited one runs as it is saved, so an earlier choice is moot.
 */
export function saveOffered(state: WizardState): boolean {
	return state.base === null || isEdited(state);
}

/**
 * What Options' choices leave unfinished, checked without the saved templates (review ruling):
 * Schedule with no date chosen (neither one date nor a feed key); more update fields than
 * `MAX_UPDATE_FIELDS`; and, while Options offers them, a new template's name `templates/create`
 * would refuse, or changes to save to the template that are not saved yet (`templateSaved` clears
 * that choice). Preview and Run stay closed while any holds, so the step bar cannot skip Options'
 * Next. Nothing a saved template the engine accepted can hold is refused here: the engine reads
 * dates and timezones with Luxon, which the browser cannot match, so the Options step checks only
 * a timezone the user types.
 */
export function optionsBlockers(state: WizardState): Blocker[] {
	const { options, base } = state;
	const blockers: Blocker[] = [];
	if (options.status === "schedule") {
		const s = options.schedule;
		if (s === null || (s.kind === "feed" && s.from === "")) {
			blockers.push({ row: null, msg: OPTIONS.scheduleUnset });
		}
	}
	if (options.mode !== "create") {
		const names = new Set(mappingNamesOf(state.rows));
		const listed = new Set(options.updateFields.filter((n) => names.has(n)));
		if (listed.size > MAX_UPDATE_FIELDS) {
			blockers.push({
				row: null,
				msg: OPTIONS.updateFieldsTooMany,
				values: { max: MAX_UPDATE_FIELDS },
			});
		}
	}
	if (saveOffered(state)) {
		if (options.save.kind === "new") {
			const problem = templateNameRule(options.save.name);
			if (problem !== null) blockers.push(problem);
		} else if (options.save.kind === "update" && base !== null) {
			blockers.push({ row: null, msg: OPTIONS.saveUnsaved, values: { name: base.name } });
		}
	}
	return blockers;
}

// --- Navigation ---

/** A sample is usable with at least one key and one record (preflight F7). */
function usable(columns: SampleColumn[] | null): boolean {
	return columns !== null && columns.length > 0 && (columns[0]?.values.length ?? 0) > 0;
}

/**
 * Whether a step can be shown (preflight F2); once a run exists, only Run. Preview and Run also
 * need Options' choices finished (`optionsBlockers`), as the step bar can skip Options' Next.
 */
export function reachable(state: WizardState, step: StepId): boolean {
	if (step === "run") {
		if (state.run !== null) return true;
		return (state.dryRun?.total ?? 0) > 0 && optionsBlockers(state).length === 0;
	}
	if (state.run !== null) return false;
	switch (step) {
		case "source":
			return true;
		case "target":
			return usable(state.columns);
		case "map":
			return state.target !== null;
		case "options":
			return state.target !== null && state.rows.key !== undefined;
		case "preview":
			return (
				state.target !== null && state.rows.key !== undefined && optionsBlockers(state).length === 0
			);
	}
}

// --- Owner and job input ---

const OWNER_MAX = 100;

/**
 * The owner of the wizard's imports (Ruling 15): the template name lower-cased, each run of
 * characters outside `[a-z0-9]` turned into `-`, trimmed of `-` and cut to 100 characters; when
 * that is empty, or without a name, `wizard-<collection>-<locale>`.
 */
export function deriveOwner(p: {
	templateName: string | null;
	collection: string;
	locale: string;
}): string {
	const fromName = (p.templateName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const owner = trimDashes(fromName.slice(0, OWNER_MAX));
	if (owner !== "") return owner;
	// Kept to `OWNER_PATTERN`'s characters, as a locale may hold others.
	const fallback = `wizard-${p.collection}-${p.locale}`.replace(/[^A-Za-z0-9._:-]+/g, "-");
	return trimDashes(fallback.slice(0, OWNER_MAX));
}

/** No `-` at either end, also after a cut (review ruling 8). */
function trimDashes(s: string): string {
	return s.replace(/^-+|-+$/g, "");
}

/** The typed owner, else one derived from the template's name (to save, or the base's). */
export function ownerOf(state: WizardState): string {
	if (state.options.owner !== null) return state.options.owner;
	const { save } = state.options;
	return deriveOwner({
		templateName: save.kind === "new" ? save.name : (state.base?.name ?? null),
		collection: state.target?.collection ?? "",
		locale: state.target?.locale ?? "",
	});
}

/**
 * The `jobs/create` body. A dry run reads the chosen file; the real run reads the dry run's
 * upload, so it imports exactly what Preview showed (Coordinator's call 2). An unedited saved
 * template runs by ID and revision (preflight F1); otherwise the draft runs inline.
 */
export function jobInput(state: WizardState, dryRun: boolean): CreateJobInput {
	const uploadId = dryRun ? state.source?.uploadId : state.dryRun?.uploadId;
	if (uploadId === undefined) {
		throw new Error(dryRun ? "No file is chosen yet" : "The dry run has not started yet");
	}
	const { base, options } = state;
	const template =
		base !== null && !isEdited(state)
			? { templateId: base.id, templateRevision: base.revision }
			: { template: toTemplate(state, ownerOf(state)) };
	return {
		uploadId,
		dryRun,
		...template,
		publish: options.status !== "draft",
		...(options.batchSize === null ? {} : { batchSize: options.batchSize }),
		journal: true,
	};
}
