/**
 * The schedule expressions flux-import accepts (spec Ruling 7, plan Ruling 3): five cron fields or
 * one of five aliases, which EmDash evaluates in UTC. EmDash's own parser takes far more and turns
 * many typos, such as `61 * * * *`, into one-shot runs in the past (Fact E1), so each field is
 * checked here; EmDash's `schedule()` still validates what passes (a date that never comes, such
 * as `0 3 31 2 *`).
 */

export const CRON_MAX_LENGTH = 256;
export const CRON_ALIASES: readonly string[] = [
	"@hourly",
	"@daily",
	"@weekly",
	"@monthly",
	"@yearly",
];
export const CRON_RULE =
	"Use five cron fields (minute, hour, day of month, month, day of week) or @hourly, @daily, @weekly, @monthly or @yearly; times are UTC";

interface Field {
	name: string;
	min: number;
	max: number;
	/** Three-letter names; the first one is `first`. */
	names?: readonly string[];
	first?: number;
}

const FIELDS: readonly Field[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{
		name: "month",
		min: 1,
		max: 12,
		first: 1,
		names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
	},
	// 0 and 7 are both Sunday, as EmDash's parser reads them (Fact E1).
	{
		name: "day of week",
		min: 0,
		max: 7,
		first: 0,
		names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
	},
];

const NUMBER = /^\d{1,2}$/;

/** The field's value for `text`: a number in its range or one of its names; else null. */
function fieldValue(text: string, field: Field): number | null {
	if (NUMBER.test(text)) {
		const n = Number(text);
		return n >= field.min && n <= field.max ? n : null;
	}
	const i = field.names?.indexOf(text.toLowerCase()) ?? -1;
	return i < 0 ? null : i + (field.first ?? 0);
}

function itemProblem(item: string, field: Field): string | null {
	const bad = `${field.name}: "${item}" is not a value from ${field.min} to ${field.max}, a range or a step`;
	const [range = "", step, extra] = item.split("/");
	if (extra !== undefined || range === "") return bad;
	if (step !== undefined) {
		const n = NUMBER.test(step) ? Number(step) : 0;
		if (n < 1 || n > field.max) {
			return `${field.name}: the step in "${item}" must be from 1 to ${field.max}`;
		}
	}
	if (range === "*") return null;
	const [from = "", to, more] = range.split("-");
	if (more !== undefined) return bad;
	const a = fieldValue(from, field);
	if (to === undefined) {
		if (a === null) return bad;
		return step === undefined
			? null
			: `${field.name}: a step needs * or a range before it, not "${item}"`;
	}
	const b = fieldValue(to, field);
	return a === null || b === null || a > b ? bad : null;
}

/** Null when `cron` is a schedule flux-import accepts, else what is wrong with it. */
export function cronProblem(cron: string): string | null {
	if (cron.length === 0) return "The schedule is empty";
	if (cron.length > CRON_MAX_LENGTH) {
		return `The schedule is longer than ${CRON_MAX_LENGTH} characters`;
	}
	if (cron.trim() !== cron) return "The schedule starts or ends with a space";
	if (cron.startsWith("@")) {
		return CRON_ALIASES.includes(cron) ? null : `${cron} is not an accepted alias`;
	}
	const parts = cron.split(/\s+/);
	if (parts.length !== FIELDS.length) return `Expected 5 fields, found ${parts.length}`;
	for (const [i, part] of parts.entries()) {
		const field = FIELDS[i] as Field;
		for (const item of part.split(",")) {
			const problem = itemProblem(item, field);
			if (problem !== null) return problem;
		}
	}
	return null;
}
