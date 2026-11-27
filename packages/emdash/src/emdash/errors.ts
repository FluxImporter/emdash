/** The string `code` of an EmDash error (e.g. `EmDashStorageError` "NOT_FOUND"), if it has one. */
export function emdashErrorCode(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
		? e.code
		: undefined;
}
