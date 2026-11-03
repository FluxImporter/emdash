import { deepEqual } from "./diff.js";
import type { TargetField } from "./values.js";

/** Field types whose write expects a string (EmDash parses a stored string that looks like JSON). */
const STRING_TYPES = new Set(["string", "text", "url", "slug", "select", "datetime"]);

/**
 * Whether two stored values are the same as EmDash reads them back (spec M5a V1). EmDash
 * normalizes only a field's top level (`mapRow`, `serializeValue`), so the rules apply there only:
 * a missing value and `null` are the same, and a boolean and its stored `1`/`0` are the same.
 * Everything nested compares strictly as `deepEqual` does: object keys in any order, arrays in
 * order, `null`, booleans and absent keys distinct.
 */
export function sameStored(a: unknown, b: unknown): boolean {
	const x = a ?? null;
	const y = b ?? null;
	if (x === y) return true;
	if (typeof x === "boolean" || typeof y === "boolean") {
		return truthOf(x) !== null && truthOf(x) === truthOf(y);
	}
	return deepEqual(x, y);
}

/** A boolean, or the 1/0 EmDash stores for one; null for anything else. */
function truthOf(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === 0) return value === 1;
	return null;
}

/**
 * A field's value as a rollback writes it back: exactly as read, except that a boolean field's
 * stored `1`/`0` is sent as `true`/`false` (spec M5a V1), and a missing value as `null`. A string
 * field whose text reads back as an object or array (EmDash parses stored text that looks like
 * JSON) is sent as the JSON text again.
 */
export function restoredValue(value: unknown, target: TargetField | undefined): unknown {
	if (value === undefined || value === null) return null;
	if (target?.type === "boolean" && (value === 0 || value === 1)) return value === 1;
	if (target !== undefined && STRING_TYPES.has(target.type) && typeof value === "object") {
		return JSON.stringify(value);
	}
	return value;
}

/** `restoredValue` for every field of a pre-image, by the job's field snapshot. */
export function restoredData(
	values: Readonly<Record<string, unknown>>,
	targets: Readonly<Record<string, TargetField>> | undefined,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([field, value]) => [field, restoredValue(value, targets?.[field])]),
	);
}
