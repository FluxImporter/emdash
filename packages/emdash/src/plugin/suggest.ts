/**
 * The suggestion route's steps (M6d spec "The suggestion route", Rulings 1, 12, 25-28, 32-36, 45,
 * 50, 51, 59, 64; plan Rulings 6-9, 16-22): settings, the base template, the collection, a sample
 * of at most `SAMPLE_MAX` records, name matching, at most one provider call, the merged draft, its
 * site check and one log line. Every provider-side failure is a warning code on a 200 answer, never
 * a route error (Ruling 35), and no provider text reaches the answer or the log unchecked.
 * `SuggestDeps` has no storage port: pasted text is parsed in memory and never staged (Ruling 32).
 */
import type { KVAccess, LogAccess } from "emdash";
import type { SuggestCollection } from "../emdash/schema.js";
import { shapeProblems, templateShapeProblems } from "../engine/shape.js";
import {
	createMapper,
	eligibleFields,
	fieldWarning,
	type Mapper,
	matchedKeys,
	type NameSuggestion,
	type Sample,
	type SuggestField,
	type SuggestWarning,
	suggestByName,
} from "../engine/suggest.js";
import { type Template, templatePaths } from "../engine/template.js";
import type { CsvSample } from "../sources/csv.js";
import { hostOf, type NetOptions } from "../sources/net.js";
import { resolvePath } from "../sources/paths.js";
import {
	CSV_SOURCE,
	type SourceFormat,
	type TemplateSource,
	type ValueSample,
} from "../sources/reader.js";
import { type FieldSuggestion, mergeAndDraft, type Suggestion } from "./ai/merge.js";
import { buildPayload, type SentCounts, userMessage } from "./ai/payload.js";
import {
	aiErrorCode,
	aiTimeoutMs,
	type ProviderOutcome,
	type ProviderRequest,
} from "./ai/provider.js";
import { takeAiCall } from "./ai/rate-limit.js";
import { REPLY_SCHEMA, SYSTEM_PROMPT, type ValidatedReply, validateReply } from "./ai/reply.js";
import {
	type AiProvider,
	type AiReady,
	type AiSettings,
	MODEL_RE,
	readAiProvider,
	readAiSettings,
	type SettingsReader,
	warningFor,
} from "./ai/settings.js";
import { resolveJobTemplate } from "./job-templates.js";
import {
	pasteBytes,
	SAMPLE_MAX,
	ServiceError,
	sampleSource,
	XLSX_PASTE_MESSAGE,
} from "./service.js";
import type { FetchOutcome, SourceRow } from "./sources.js";
import { siteCheck, type TemplateCheck, type TemplateDeps } from "./templates.js";

/** Field slugs and keys listed in `unmapped`, each (spec "Output"). */
export const UNMAPPED_MAX = 100;

export interface SuggestDeps {
	settings: SettingsReader;
	kv: Pick<KVAccess, "getVersioned" | "compareAndSet">;
	templates: TemplateDeps;
	readCollection: (collection: string) => Promise<SuggestCollection | null>;
	sampleUpload: (uploadId: string, source: TemplateSource) => Promise<CsvSample | ValueSample>;
	getSource: (id: string) => Promise<SourceRow | null>;
	fetchSource: (id: string, force: boolean) => Promise<FetchOutcome>;
	allowPrivateNetwork: boolean;
	net: NetOptions;
	callProvider: (
		ai: AiReady,
		request: ProviderRequest,
		net: NetOptions,
	) => Promise<ProviderOutcome>;
	log: Pick<LogAccess, "info">;
	now: () => number;
}

export interface SuggestInput {
	collection: string;
	locale?: string | undefined;
	source?: TemplateSource | undefined;
	text?: string | undefined;
	uploadId?: string | undefined;
	sourceId?: string | undefined;
	templateId?: string | undefined;
	templateRevision?: number | undefined;
	template?: unknown;
	ai?: boolean | undefined;
}

/** Spec "Output". */
export interface SuggestReply {
	method: "ai" | "fallback";
	ai: { available: boolean; provider?: AiProvider; model?: string };
	template: Template | null;
	key: Suggestion;
	slug?: Suggestion;
	fields: FieldSuggestion[];
	unmapped: { fields: string[]; keys: string[] };
	check: TemplateCheck;
	warnings: SuggestWarning[];
	sent: SentCounts | null;
}

/**
 * The records read, as the suggester sees them (spec step 4): CSV keys are the headers as
 * `normalizeHeaders` names them (plan Ruling 7), each row holding the cells it has; other formats
 * key by path, each record holding the paths that resolve.
 */
export function toSample(read: CsvSample | ValueSample, format: SourceFormat): Sample {
	if ("headers" in read) {
		const keys = read.headers;
		const rows = read.rows.map(
			(row) =>
				new Map(keys.flatMap((k, i): [string, unknown][] => (i < row.length ? [[k, row[i]]] : []))),
		);
		return { format, keys, rows };
	}
	const keys = read.paths;
	const rows = read.records.map(
		(record) =>
			new Map(
				keys.flatMap((path): [string, unknown][] => {
					const value = resolvePath(record, path, format);
					return value === undefined ? [] : [[path, value]];
				}),
			),
	);
	return { format, keys, rows };
}

/** The keys the template's field mappings (image `alt` included) and its slug read. */
function fieldAndSlugPaths(t: Template): string[] {
	const froms = [
		t.slug?.from,
		...Object.values(t.fields).flatMap((m) =>
			m.type === "image" ? [m.from, m.alt?.from] : [m.from],
		),
	];
	return froms.filter((path): path is string => path !== undefined);
}

/**
 * The keys the base template uses (plan Ruling 20): `templatePaths`, its typed `from`s. The key
 * column stays among them only when a base field or the slug maps it (pre-flight F2): a key column
 * read only by the key, `translationOf`, `publishAt`, taxonomies or bylines is freed, and one a
 * base field already maps is never offered to another field.
 */
function baseKeysOf(base: Template): Set<string> {
	const keys = new Set(templatePaths(base));
	const keyFrom = base.key.from;
	if (keyFrom !== undefined && !fieldAndSlugPaths(base).includes(keyFrom)) keys.delete(keyFrom);
	return keys;
}

/** Spec step 2: the base template, shape-checked and naming the requested collection. */
async function readBase(deps: SuggestDeps, input: SuggestInput): Promise<Template | null> {
	let raw: unknown;
	if (input.templateId !== undefined) {
		raw = (
			await resolveJobTemplate(deps.templates.templates, input.templateId, input.templateRevision)
		).template;
	} else if (input.template !== undefined) {
		raw = input.template;
	} else {
		return null;
	}
	const shape = templateShapeProblems(raw);
	const problems = shape.ok ? shapeProblems(shape) : shape.problems;
	if (!shape.ok || problems.length > 0) {
		throw new ServiceError(
			"INVALID_TEMPLATE",
			"The base template has problems; fix them first",
			400,
			{ problems },
		);
	}
	const base = shape.template;
	if (base.collection !== input.collection) {
		throw new ServiceError(
			"COLLECTION_MISMATCH",
			`The base template imports into "${base.collection}", not "${input.collection}"`,
			400,
		);
	}
	return base;
}

const sourceNotFound = (id: string) =>
	new ServiceError("SOURCE_NOT_FOUND", `Source ${id} not found`, 404);

/** Spec step 4 (plan Ruling 6): text in memory, a staged upload, or a source's stored copy. */
async function readRecords(
	deps: SuggestDeps,
	input: SuggestInput,
	source: TemplateSource,
): Promise<CsvSample | ValueSample> {
	if (input.text !== undefined) {
		if (source.format === "xlsx") throw new ServiceError("INVALID_FORMAT", XLSX_PASTE_MESSAGE, 400);
		const bytes = pasteBytes(input.text);
		const memory = { source: { open: async () => new Blob([bytes]).stream() } };
		return sampleSource(memory, "text", SAMPLE_MAX, source);
	}
	if (input.uploadId !== undefined) return deps.sampleUpload(input.uploadId, source);
	const id = input.sourceId;
	if (id === undefined) {
		// SUGGEST_INPUT asks for exactly one of the three.
		throw new ServiceError(
			"VALIDATION_ERROR",
			"Set exactly one of text, uploadId and sourceId",
			400,
		);
	}
	const row = await deps.getSource(id);
	if (row === null) throw sourceNotFound(id);
	if (row.lastFetch !== undefined) {
		try {
			return await deps.sampleUpload(row.lastFetch.uploadId, source);
		} catch (e) {
			if (!(e instanceof ServiceError && e.code === "UPLOAD_NOT_FOUND")) throw e;
		}
	}
	let fetched: FetchOutcome;
	try {
		// A conditional fetch would answer 304 with the copy that is gone (Fact D9).
		fetched = await deps.fetchSource(id, row.lastFetch !== undefined);
	} catch (e) {
		if (e instanceof ServiceError && e.code === "NOT_FOUND") throw sourceNotFound(id);
		throw e;
	}
	return deps.sampleUpload(fetched.uploadId, source);
}

/** What the provider step gave: a validated reply or the one failure code, and what was sent. */
interface Consulted {
	reply: ValidatedReply | null;
	warnings: SuggestWarning[];
	/** The one `ai_*` failure or settings code added, if any. */
	code: string | null;
	sent: SentCounts | null;
	status?: number;
	usage?: { input: number; output: number };
	/** The answering model, checked by `MODEL_RE`, else the configured one; only for an answer. */
	model?: string;
	/** The rate limit's KV read or write failed: still `ai_rate_limited`, logged apart. */
	kvError?: true;
}

interface ConsultInput {
	collection: { slug: string; label: string };
	unsettled: SuggestField[];
	sample: Sample;
	mapper: Mapper;
	keys: string[];
	keyColumn: string | null;
	base: Template | null;
}

/** Spec step 6: the payload, the rate limit, one call and the reply's validation. */
async function consult(
	deps: SuggestDeps,
	settings: AiSettings,
	c: ConsultInput,
): Promise<Consulted> {
	const warnings: SuggestWarning[] = [];
	const stop = (code: string | null, extra: Partial<Consulted> = {}): Consulted => {
		if (code !== null) warnings.push({ code });
		return { reply: null, warnings, code, sent: null, ...extra };
	};
	if (!settings.available) return stop(warningFor(settings.reason));

	const built = buildPayload({
		collection: c.collection,
		fields: c.unsettled,
		sample: c.sample,
		keys: c.keys,
	});
	// Ruling 88: `sample_trimmed` waits for a payload that reaches the transport; the counts of keys
	// and fields left out are reported once the payload is built, as for one too large.
	const trimmed = built.warnings.filter((w) => w.code === "sample_trimmed");
	warnings.push(...built.warnings.filter((w) => w.code !== "sample_trimmed"));
	// Ruling 50: no count and no call for a payload that cannot fit.
	if (!built.ok) return stop("ai_payload_too_large");

	let allowed: boolean;
	try {
		allowed = await takeAiCall(deps.kv, deps.now);
	} catch {
		// Ruling 35: a KV failure is a provider-side failure; the limit fails closed. The log line
		// tells it from a used-up limit, without the error's text.
		return stop("ai_rate_limited", { kvError: true });
	}
	if (!allowed) return stop("ai_rate_limited");

	let outcome: ProviderOutcome;
	try {
		outcome = await deps.callProvider(
			settings,
			{
				system: SYSTEM_PROMPT,
				user: userMessage(built.data),
				schema: REPLY_SCHEMA,
				timeoutMs: aiTimeoutMs(built.sent.fields),
			},
			deps.net,
		);
	} catch (e) {
		outcome = { ok: false, code: aiErrorCode(e) };
	}
	// A refused URL never reached the transport (Ruling 64).
	const sent = outcome.ok || outcome.code !== "ai_url_blocked" ? built.sent : null;
	if (sent !== null) warnings.push(...trimmed);
	if (!outcome.ok) {
		return stop(outcome.code, {
			sent,
			...(outcome.status === undefined ? {} : { status: outcome.status }),
		});
	}
	const answered = {
		sent,
		status: outcome.status,
		...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
		model: MODEL_RE.test(outcome.model) ? outcome.model : settings.model,
	};
	const reply = validateReply(outcome.value, {
		fields: built.fieldsSent,
		keys: built.keysSent,
		sample: c.sample,
		mapper: c.mapper,
		keyColumn: c.keyColumn,
		keepKey: c.base !== null,
		keepSlug: c.base?.slug !== undefined,
	});
	if (reply === null) return stop("ai_invalid_output", answered);
	warnings.push(...reply.warnings);
	return { reply, warnings, code: null, ...answered };
}

/** The sample keys no field mapping, the key or the slug uses (plan Ruling 18). */
function unmappedKeys(
	sample: Sample,
	template: Template | null,
	merged: { key: Suggestion; slug?: Suggestion; fields: FieldSuggestion[] },
): string[] {
	const used = new Set<string>(template === null ? [] : fieldAndSlugPaths(template));
	if (template?.key.from !== undefined) used.add(template.key.from);
	for (const s of [merged.key, merged.slug, ...merged.fields]) {
		if (s?.from != null) used.add(s.from);
	}
	return sample.keys.filter((k) => !used.has(k)).slice(0, UNMAPPED_MAX);
}

/** `templates/suggest` (spec "Steps" 1-9). */
export async function suggestMapping(
	deps: SuggestDeps,
	input: SuggestInput,
): Promise<SuggestReply> {
	const started = deps.now();

	// 1. Settings: with ai: false only the provider is read (Ruling 64).
	let settings: AiSettings | null = null;
	let ai: SuggestReply["ai"];
	if (input.ai === false) {
		// Name matching needs no setting: a failed read reports no provider (final review).
		const provider = await readAiProvider(deps.settings).catch(() => null);
		ai = provider === null ? { available: false } : { available: true, provider };
	} else {
		settings = await readAiSettings(deps.settings, deps.allowPrivateNetwork);
		ai = {
			available: settings.available,
			...(settings.provider === undefined ? {} : { provider: settings.provider }),
		};
	}

	// 2. The base template.
	const base = await readBase(deps, input);
	const locale = base?.locale ?? input.locale;
	if (locale === undefined) {
		// SUGGEST_INPUT asks for a locale without a base template.
		throw new ServiceError("VALIDATION_ERROR", "Set locale, or pass a base template", 400);
	}

	// 3. The collection and its eligible fields.
	const collection = await deps.readCollection(input.collection);
	if (collection === null) {
		throw new ServiceError(
			"COLLECTION_NOT_FOUND",
			`Collection "${input.collection}" does not exist`,
			404,
		);
	}
	const { eligible, warnings: eligibility } = eligibleFields(collection.fields);
	const warnings: SuggestWarning[] = [...eligibility];

	// 4. The sample.
	const source: TemplateSource = base?.source ?? input.source ?? CSV_SOURCE;
	const sample = toSample(await readRecords(deps, input, source), source.format);
	if (sample.keys.length === 0) {
		throw new ServiceError("NO_SOURCE_KEYS", "The sample has no column or path to map", 400);
	}

	// 5. Name matching over the fields and keys the base template leaves free (Ruling 59).
	const mapper = createMapper(sample);
	const baseFields = base?.fields ?? {};
	const open = eligible.filter((f) => !Object.hasOwn(baseFields, f.slug));
	const baseKeys = base === null ? new Set<string>() : baseKeysOf(base);
	const names: NameSuggestion = suggestByName(open, sample, {
		mapper,
		...(base === null
			? {}
			: { excludedKeys: baseKeys, base: { hasSlug: base.slug !== undefined } }),
	});
	const keyColumn = base === null ? (names.key?.from ?? null) : (base.key.from ?? null);
	warnings.push(...names.warnings);

	// 6. The provider, only for fields name matching did not settle (Ruling 51).
	let consulted: Consulted | null = null;
	const unsettled = open.filter((f) => names.fields.get(f.slug)?.settled !== true);
	if (settings !== null && unsettled.length > 0) {
		const settled = new Set<string>();
		for (const pick of names.fields.values()) {
			if (pick.settled && pick.from !== null) settled.add(pick.from);
		}
		// Plan Ruling 21: the key column is always sent, the entry slug's key too. Only the keys name
		// matching read are sent (final review): a base key column past `matchedKeys` is not.
		const keys = matchedKeys(sample).filter(
			(k) => k === keyColumn || (!baseKeys.has(k) && !settled.has(k)),
		);
		consulted = await consult(deps, settings, {
			collection: { slug: input.collection, label: collection.label },
			unsettled,
			sample,
			mapper,
			keys,
			keyColumn,
			base,
		});
		warnings.push(...consulted.warnings);
		if (consulted.model !== undefined) ai.model = consulted.model;
	}

	// 7. The merged draft.
	const drafted = mergeAndDraft(
		{ fields: eligible, base, names, reply: consulted?.reply ?? null },
		{ collection: input.collection, locale, source: { ...source } },
	);
	const { merged, template } = drafted;
	// Items the merge ignored for a reserved key join the reply's own count (pre-flight F1).
	if (drafted.ignored > 0) {
		const duplicate = warnings.find((w) => w.code === "ai_duplicate_key");
		if (duplicate === undefined)
			warnings.push({ code: "ai_duplicate_key", count: drafted.ignored });
		else duplicate.count = (duplicate.count ?? 0) + drafted.ignored;
	}
	warnings.push(...drafted.warnings);
	const required = merged.fields.filter((f) => f.required && f.from === null).map((f) => f.field);
	if (required.length > 0) warnings.push(fieldWarning("required_unmapped", required));
	const unmapped = {
		fields: merged.fields
			.filter((f) => f.from === null)
			.map((f) => f.field)
			.slice(0, UNMAPPED_MAX),
		keys: unmappedKeys(sample, template, merged),
	};

	// 8. The site check of the draft.
	const check: TemplateCheck =
		template === null
			? { problems: [], warnings: [] }
			: (await siteCheck(deps.templates, template)).check;

	// 9. One line of codes and counts (Ruling 36).
	const ready = settings?.available === true ? settings : null;
	const sent = consulted?.sent ?? null;
	const usage = consulted?.usage;
	deps.log.info(
		[
			"fluximporter: suggest",
			`method=${merged.method}`,
			`provider=${ai.provider ?? "none"}`,
			`model=${ai.model ?? ready?.model ?? "none"}`,
			`host=${ready === null ? "none" : hostOf(new URL(ready.baseUrl))}`,
			`status=${consulted?.status ?? "none"}`,
			`code=${consulted?.code ?? "none"}`,
			...(consulted?.kvError === true ? ["rate=kv_error"] : []),
			`ms=${deps.now() - started}`,
			`sent=${sent === null ? "none" : `${sent.records}/${sent.keys}/${sent.fields}/${sent.bytes}`}`,
			`usage=${usage === undefined ? "none" : `${usage.input}/${usage.output}`}`,
		].join(" "),
	);

	return {
		method: merged.method,
		ai,
		template,
		key: merged.key,
		...(merged.slug === undefined ? {} : { slug: merged.slug }),
		fields: merged.fields,
		unmapped,
		check,
		warnings,
		sent,
	};
}
