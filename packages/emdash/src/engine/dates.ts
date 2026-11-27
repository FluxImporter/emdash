import { DateTime, type DateTimeOptions, type TokenParser, type Zone } from "luxon";

export interface DateOptions {
	/** A Luxon format, `"unix"` (seconds) or `"unixMs"` (milliseconds); ISO 8601 when absent. */
	format?: string | undefined;
	/** The zone for values without an offset, already resolved from `"site"`. */
	tz: string;
	/** The Luxon format for `string` and `text` targets; `yyyy-MM-dd` when absent. */
	output?: string | undefined;
}

export type DateConverted =
	| { ok: true; value: string | null }
	| { ok: false; code: "invalid_date" | "not_scalar"; message: string };

const DAY_MS = 86_400_000;
const UNIX_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const TIME_TOKENS_RE = /[HhmsSauZzXxtTfF]/;
const NOT_SCALAR_MESSAGE = "Expected a single value, found an object or array";

/**
 * The earliest instant whose wall-clock time in `zone` is `wall` (a UTC timestamp holding the
 * local fields), or null when the local time does not exist there (a DST gap). An ambiguous time
 * (a DST overlap) has two such instants; the earlier is taken.
 */
export function localInstant(wall: number, zone: Zone): number | null {
	const offsets = new Set([
		zone.offset(wall - DAY_MS),
		zone.offset(wall),
		zone.offset(wall + DAY_MS),
	]);
	let best: number | null = null;
	for (const offset of offsets) {
		const instant = wall - offset * 60_000;
		if (zone.offset(instant) === offset && (best === null || instant < best)) best = instant;
	}
	return best;
}

/** Parsers by format, the latest `PARSERS_MAX` kept. */
const parsers = new Map<string, TokenParser>();
const PARSERS_MAX = 64;

/**
 * Luxon's parser for `format`. `DateTime.fromFormat` builds one (the format's tokens and a RegExp)
 * on every call; `fromFormatParser` with a kept one reads text the same way for far less CPU.
 * Throws as `fromFormat` would for a format Luxon cannot build, so callers call it per value.
 */
function formatParser(format: string): TokenParser {
	let parser = parsers.get(format);
	if (parser === undefined) {
		parser = DateTime.buildFormatParser(format);
		if (parsers.size >= PARSERS_MAX) parsers.clear();
		parsers.set(format, parser);
	}
	return parser;
}

/**
 * Dates: ISO 8601 text (or text in `format`) read in `tz` when it has no offset, or Unix seconds
 * or milliseconds (JSON numbers or text). Into a `datetime` field (or with no known target) the
 * value is EmDash's canonical form, UTC with milliseconds; into `string` and `text` fields it is
 * formatted in `tz` with `output`. A local time in a DST gap fails `invalid_date`; one in an
 * overlap takes the earlier instant. Years outside 0000-9999 fail too: EmDash's ISO check takes
 * four-digit years only.
 */
export function dateConverter(
	o: DateOptions,
	targetType: string | null,
): (raw: unknown) => DateConverted {
	const zoneProbe = DateTime.utc().setZone(o.tz);
	const zone = zoneProbe.zone;
	const asText = targetType === "string" || targetType === "text";
	const output = o.output ?? "yyyy-MM-dd";
	const expected = o.format ?? "ISO 8601";
	const parse = (text: string, options: DateTimeOptions) =>
		o.format === undefined
			? DateTime.fromISO(text, options)
			: DateTime.fromFormatParser(text, formatParser(o.format), options);
	const finish = (instant: number, shown: string): DateConverted => {
		const utc = DateTime.fromMillis(instant, { zone: "utc" });
		if (!utc.isValid || utc.year < 0 || utc.year > 9999) {
			return {
				ok: false,
				code: "invalid_date",
				message: `"${shown}" is outside the years 0000 to 9999`,
			};
		}
		const value = asText ? utc.setZone(zone).toFormat(output) : (utc.toISO() as string);
		return { ok: true, value };
	};
	return (raw) => {
		if (raw === undefined || raw === null) return { ok: true, value: null };
		if (typeof raw === "object")
			return { ok: false, code: "not_scalar", message: NOT_SCALAR_MESSAGE };
		const text = String(raw).trim();
		if (text === "") return { ok: true, value: null };
		if (!zoneProbe.isValid) {
			return {
				ok: false,
				code: "invalid_date",
				message: `"${o.tz}" is not a valid time zone`,
			};
		}
		const invalid: DateConverted = {
			ok: false,
			code: "invalid_date",
			message: `"${text}" is not a ${expected} date`,
		};
		// Numbers are dates only as Unix times; text such as "2025" is still read as ISO.
		const isUnix = o.format === "unix" || o.format === "unixMs";
		if (!isUnix && (typeof raw === "number" || typeof raw === "bigint")) return invalid;
		if (o.format === undefined && !/^([+-]\d{6}|\d{4})/.test(text)) return invalid;
		if (isUnix) {
			if (typeof raw === "boolean" || !UNIX_RE.test(text)) return invalid;
			const n = Number(text);
			const ms = Math.round(o.format === "unix" ? n * 1000 : n);
			return Number.isFinite(ms) ? finish(ms, text) : invalid;
		}
		try {
			const options = { zone, setZone: true };
			const parsed = parse(text, options);
			if (!parsed.isValid) return invalid;
			// The text carried its own offset (or zone): it names one instant.
			if (zone.isUniversal || !parsed.zone.equals(zone)) return finish(parsed.toMillis(), text);
			// A time whose text names its zone (format token `z`) follows Luxon's own handling of gaps.
			// Otherwise take the written fields (read in UTC, where every local time exists, keeping any
			// zone the text named) and find the instant in `tz` that shows that wall-clock time.
			const wOptions = { zone: "utc", setZone: true };
			const w = parse(text, wOptions);
			let instant = localInstant(w.toMillis() + w.offset * 60_000, zone);
			const dateOnly =
				o.format === undefined
					? !/[Tt:]/.test(text)
					: !TIME_TOKENS_RE.test(o.format.replace(/'[^']*'/g, ""));
			if (instant === null && dateOnly) {
				// Midnight does not exist that day (a DST start at 00:00): use the day's first instant.
				instant = DateTime.fromObject(
					{ year: w.year, month: w.month, day: w.day },
					{ zone },
				).toMillis();
			}
			if (instant === null) {
				return {
					ok: false,
					code: "invalid_date",
					message: `"${text}" does not exist in ${o.tz} (the clocks skip it)`,
				};
			}
			return finish(instant, text);
		} catch (e) {
			return {
				ok: false,
				code: "invalid_date",
				message: `"${o.format ?? "ISO 8601"}" is not a usable date format: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	};
}
