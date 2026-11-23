import { UPLOAD_ID_PATTERN } from "./limits.js";

/**
 * A failed route call, read from EmDash's `{ success: false, error: { code, message, details } }`
 * envelope (plan Ruling 3). `parseApiResponse` keeps only the message; the wizard needs the code.
 */
export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details: unknown;

	constructor(code: string, message: string, status: number, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a failed response. A body that is not the envelope gives `HTTP_<status>`. */
export async function readError(res: Response): Promise<ApiError> {
	const body: unknown = await res.json().catch(() => null);
	const error = isRecord(body) ? body.error : undefined;
	if (isRecord(error) && typeof error.code === "string") {
		const message = typeof error.message === "string" ? error.message : error.code;
		return new ApiError(error.code, message, res.status, error.details);
	}
	return new ApiError(`HTTP_${res.status}`, res.statusText || `HTTP ${res.status}`, res.status);
}

/** Worth trying again: offline (`fetch` rejects with a `TypeError`), rate-limited or a 5xx. */
export function isRetryable(e: unknown): boolean {
	if (e instanceof TypeError) return true;
	return e instanceof ApiError && (e.status === 429 || e.status >= 500);
}

const UPLOAD_ID = new RegExp(UPLOAD_ID_PATTERN, "g");

/** Server text with every upload ID replaced, as the wizard shows no upload ID (preflight F15). */
export function redact(text: string): string {
	return text.replace(UPLOAD_ID, "the uploaded file");
}
