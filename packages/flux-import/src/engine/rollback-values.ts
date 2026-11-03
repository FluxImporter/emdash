import type { TargetField } from "./values.js";

/**
 * Whether two stored values are the same as EmDash reads them back (spec M5a V1): a missing value
 * and `null` are the same (a `null` written reads back as an absent key, also inside objects), a
 * boolean and its stored `1`/`0` are the same, object keys compare in any order, arrays in order,
 * and `-0` equals `0`.
 */
export function sameStored(a: unknown, b: unknown): boolean {
	const x = a ?? null;
	const y = b ?? null;
	if (x === y) return true;
	if (typeof x === "boolean" || typeof y === "boolean") {
		return truthOf(x) !== null && truthOf(x) === truthOf(y);
	}
	if (typeof x === "number" && typeof y === "number") return x === y;
	if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
	if (Array.isArray(x) || Array.isArray(y)) {
		if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
		return x.every((item, i) => sameStored(item, y[i]));
	}
	const xo = x as Record<string, unknown>;
	const yo = y as Record<string, unknown>;
	const keys = new Set([...Object.keys(xo), ...Object.keys(yo)]);
	return [...keys].every((k) => sameStored(xo[k], yo[k]));
}

/** A boolean, or the 1/0 EmDash stores for one; null for anything else. */
function truthOf(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === 0) return value === 1;
	return null;
}

/**
 * A field's value as a rollback writes it back: exactly as read, except that a boolean field's
 * stored `1`/`0` is sent as `true`/`false` (spec M5a V1), and a missing value as `null`.
 */
export function restoredValue(value: unknown, target: TargetField | undefined): unknown {
	if (value === undefined || value === null) return null;
	if (target?.type === "boolean" && (value === 0 || value === 1)) return value === 1;
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
