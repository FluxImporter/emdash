/**
 * What a provider is sent (M6d spec "What data leaves the site", Rulings 21-23, 50, 51, 59, 61):
 * the unsettled fields and the free keys the route passes, and up to five records of cut values,
 * escaped and held under 48 KiB. Nothing else reaches this module, so nothing else can be sent.
 */
import type { Sample, SuggestField, SuggestWarning } from "../../engine/suggest.js";
import { fieldWarning } from "../../engine/suggest.js";
import type { SourceFormat } from "../../sources/reader.js";
import { cut } from "../summaries.js";

export const SAMPLE_RECORDS_SENT = 5;
export const VALUE_PREVIEW_SENT = 200;
export const MAX_KEYS_SENT = 200;
export const KEY_MAX_LENGTH = 200;
export const MAX_FIELDS_SENT = 100;
export const LABEL_MAX = 100;
export const LABEL_MAX_REDUCED = 40;
export const OPTIONS_SENT_MAX = 50;
export const OPTION_SENT_MAX_LENGTH = 100;
export const OPTIONS_REDUCED_MAX = 20;
export const OPTION_REDUCED_MAX_LENGTH = 40;
export const PAYLOAD_MAX_BYTES = 49_152;

export interface ProviderPayload {
	collection: { slug: string; label: string };
	fields: { slug: string; label: string; type: string; required: boolean; options?: string[] }[];
	source: { format: SourceFormat; keys: string[] };
	records: Record<string, string>[];
}

export interface SentCounts {
	records: number;
	keys: number;
	fields: number;
	bytes: number;
}

export interface PayloadInput {
	collection: { slug: string; label: string };
	fields: readonly SuggestField[];
	sample: Sample;
	keys: readonly string[];
}

export type BuiltPayload =
	| {
			ok: true;
			payload: ProviderPayload;
			data: string;
			sent: SentCounts;
			fieldsSent: SuggestField[];
			keysSent: string[];
			steps: number[];
			warnings: SuggestWarning[];
	  }
	| { ok: false; steps: number[]; warnings: SuggestWarning[] };

const ESCAPES = new Map([
	["<", "\\u003c"],
	[">", "\\u003e"],
	["&", "\\u0026"],
	[String.fromCharCode(0x2028), "\\u2028"],
	[String.fromCharCode(0x2029), "\\u2029"],
]);
const ESCAPED = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * JSON text with `<`, `>`, `&`, U+2028 and U+2029 written as JSON escapes, which `JSON.stringify`
 * never does; they can only occur inside strings, so the text means the same (spec Ruling 61).
 */
export function escapeJson(json: string): string {
	return json.replace(ESCAPED, (c) => ESCAPES.get(c) ?? c);
}

export function userMessage(data: string): string {
	return `<import_data>\n${data}\n</import_data>`;
}

const length = (text: string) => Array.from(text).length;

/** What the payload is built with; the reductions of spec Ruling 50 tighten it step by step. */
interface Limits {
	valueMax: number;
	records: number;
	optionsMax: number;
	optionMax: number;
	labelMax: number;
}

function fieldOf(field: SuggestField, limits: Limits): ProviderPayload["fields"][number] {
	const out: ProviderPayload["fields"][number] = {
		slug: field.slug,
		label: cut(field.label, limits.labelMax),
		type: field.type,
		required: field.required,
	};
	const options = field.options;
	if (
		options !== undefined &&
		options.length <= limits.optionsMax &&
		options.every((o) => length(o) <= limits.optionMax)
	) {
		out.options = [...options];
	}
	return out;
}

function recordOf(
	row: ReadonlyMap<string, unknown>,
	keys: readonly string[],
	valueMax: number,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		const value = row.get(key);
		if (value === undefined) continue;
		out[key] = cut(typeof value === "string" ? value : JSON.stringify(value), valueMax);
	}
	return out;
}

/**
 * The payload for one request, reduced under `PAYLOAD_MAX_BYTES` (measured after escaping), or
 * `ok: false` when even reduction 7 leaves it over: then no call is made (spec Ruling 50).
 */
export function buildPayload(input: PayloadInput): BuiltPayload {
	const warnings: SuggestWarning[] = [];
	const short = input.keys.filter((k) => length(k) <= KEY_MAX_LENGTH);
	const keysSent = short.slice(0, MAX_KEYS_SENT);
	const keysLeft = input.keys.length - keysSent.length;
	if (keysLeft > 0) warnings.push({ code: "keys_not_sent", count: keysLeft });
	const fieldsSent = input.fields.slice(0, MAX_FIELDS_SENT);
	const rest = input.fields.slice(MAX_FIELDS_SENT);
	if (rest.length > 0) {
		const { code, fields = [] } = fieldWarning(
			"fields_not_sent",
			rest.map((f) => f.slug),
		);
		warnings.push({ code, count: rest.length, fields });
	}

	const limits: Limits = {
		valueMax: VALUE_PREVIEW_SENT,
		records: Math.min(SAMPLE_RECORDS_SENT, input.sample.rows.length),
		optionsMax: OPTIONS_SENT_MAX,
		optionMax: OPTION_SENT_MAX_LENGTH,
		labelMax: LABEL_MAX,
	};
	const build = (): ProviderPayload => ({
		collection: {
			slug: input.collection.slug,
			label: cut(input.collection.label, limits.labelMax),
		},
		fields: fieldsSent.map((f) => fieldOf(f, limits)),
		source: { format: input.sample.format, keys: keysSent },
		records: input.sample.rows
			.slice(0, limits.records)
			.map((row) => recordOf(row, keysSent, limits.valueMax)),
	});
	const encoder = new TextEncoder();
	let payload = build();
	let data = "";
	let bytes = 0;
	const measure = () => {
		payload = build();
		data = escapeJson(JSON.stringify(payload));
		bytes = encoder.encode(data).byteLength;
		return bytes > PAYLOAD_MAX_BYTES;
	};

	const steps: number[] = [];
	/** Spec Ruling 50's reductions in order; each returns whether the payload is still over. */
	const reductions: [number, () => boolean][] = [
		[1, () => tighten({ valueMax: 80 })],
		[2, () => dropRecords()],
		[3, () => tighten({ valueMax: 20 })],
		[4, () => tighten({ records: 0 })],
		[5, () => tighten({ optionsMax: OPTIONS_REDUCED_MAX, optionMax: OPTION_REDUCED_MAX_LENGTH })],
		[6, () => tighten({ optionsMax: -1 })],
		[7, () => tighten({ labelMax: LABEL_MAX_REDUCED })],
	];
	function dropRecords(): boolean {
		let over = true;
		while (over && limits.records > 1) {
			limits.records--;
			over = measure();
		}
		return over;
	}
	function tighten(change: Partial<Limits>): boolean {
		Object.assign(limits, change);
		return measure();
	}
	let over = measure();
	for (const [step, reduce] of reductions) {
		if (!over) break;
		// Reduction 2 counts only when a record was dropped; the others whenever they apply.
		if (step !== 2 || limits.records > 1) steps.push(step);
		over = reduce();
	}
	if (over) return { ok: false, steps, warnings };
	if (steps.length > 0) warnings.push({ code: "sample_trimmed" });
	return {
		ok: true,
		payload,
		data,
		sent: { records: limits.records, keys: keysSent.length, fields: fieldsSent.length, bytes },
		fieldsSent,
		keysSent,
		steps,
		warnings,
	};
}
