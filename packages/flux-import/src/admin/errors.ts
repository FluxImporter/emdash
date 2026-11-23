import { ApiError, redact } from "./api-error.js";
import type { Msg, Values } from "./i18n.js";

/**
 * The wizard's sentences for route errors, job errors and suggestion warnings. The route's own
 * message is shown only for a code the wizard does not know, and never with an upload ID in it
 * (preflight F15).
 */

/**
 * The codes the wizard's routes and EmDash can answer (preflight F22: present in this package's
 * source, in EmDash's, or as an upper-cased `JobErrorCode`).
 */
export const WIZARD_ERROR_CODES: readonly string[] = [
	// EmDash
	"UNAUTHORIZED",
	"NOT_AUTHENTICATED",
	"FORBIDDEN",
	"CSRF_REJECTED",
	"VALIDATION_ERROR",
	"INVALID_PLUGIN_REQUEST",
	"NOT_FOUND",
	"INTERNAL_ERROR",
	// The upload route
	"UNSUPPORTED_SOURCE",
	"TOO_LARGE",
	"LENGTH_REQUIRED",
	"EMPTY_BODY",
	"NOT_CONFIGURED",
	// Sources
	"INVALID_FORMAT",
	"INVALID_SOURCE",
	"UPLOAD_NOT_FOUND",
	"NO_SOURCE_KEYS",
	"SOURCE_NOT_FOUND",
	"CREDENTIAL_MISSING",
	"CREDENTIALS_UNAVAILABLE",
	"URL_BLOCKED",
	"FETCH_FAILED",
	"HTTP_ERROR",
	"TOO_MANY_REDIRECTS",
	"CONFLICT",
	// Templates
	"NAME_TAKEN",
	"INVALID_TEMPLATE",
	"TEMPLATE_NOT_FOUND",
	"TEMPLATE_CHANGED",
	"TEMPLATE_TOO_LARGE",
	"UNSUPPORTED_TEMPLATE_VERSION",
	"COLLECTION_NOT_FOUND",
	"COLLECTION_MISMATCH",
	"INVALID_CURSOR",
	// Jobs
	"INVALID_OPTIONS",
	"INVALID_TRANSITION",
	"LOG_TOO_LARGE",
];

/** The M6d spec's warnings table ("Errors and warnings"). */
export const SUGGEST_WARNING_CODES: readonly string[] = [
	"ai_not_configured",
	"ai_key_unavailable",
	"ai_url_blocked",
	"ai_payload_too_large",
	"ai_rate_limited",
	"ai_timeout",
	"ai_auth_failed",
	"ai_billing",
	"ai_provider_rate_limited",
	"ai_provider_rejected",
	"ai_provider_error",
	"ai_refused",
	"ai_truncated",
	"ai_invalid_output",
	"ai_unknown_field",
	"ai_duplicate_field",
	"ai_unknown_key",
	"ai_duplicate_key",
	"ai_option_dropped",
	"ai_draft_invalid",
	"sample_trimmed",
	"keys_not_matched",
	"keys_not_sent",
	"fields_not_sent",
	"required_unmapped",
	"reference_not_suggested",
	"fields_not_eligible",
	"date_format_ambiguous",
	"number_format_ambiguous",
	"key_guessed",
	"key_not_unique_in_sample",
	"no_field_matched",
	"sample_empty",
];

/** One sentence per `WIZARD_ERROR_CODES`, plus `offline` and `unknown`. */
export const ERROR_MESSAGES: Readonly<Record<string, Msg>> = {
	UNAUTHORIZED: {
		id: "flux-import.error.unauthorized",
		message: "Your session has ended. Sign in again to continue.",
	},
	NOT_AUTHENTICATED: {
		id: "flux-import.error.not-authenticated",
		message: "Your session has ended. Sign in again to continue.",
	},
	FORBIDDEN: { id: "flux-import.error.forbidden", message: "Only administrators can import." },
	CSRF_REJECTED: {
		id: "flux-import.error.csrf-rejected",
		message: "The request was refused as unsafe. Reload the page and try again.",
	},
	VALIDATION_ERROR: {
		id: "flux-import.error.validation-error",
		message: "The request was not valid. Check your entries and try again.",
	},
	INVALID_PLUGIN_REQUEST: {
		id: "flux-import.error.invalid-plugin-request",
		message: "The request was too large or not valid.",
	},
	NOT_FOUND: {
		id: "flux-import.error.not-found",
		message: "This item no longer exists.",
	},
	INTERNAL_ERROR: {
		id: "flux-import.error.internal-error",
		message: "Something went wrong on the server. Try again.",
	},
	UNSUPPORTED_SOURCE: {
		id: "flux-import.error.unsupported-source",
		message: "This kind of file cannot be imported. Use CSV, JSON, JSON Lines, XML or XLSX.",
	},
	TOO_LARGE: {
		id: "flux-import.error.too-large",
		message: "The file or text is larger than the site accepts.",
	},
	LENGTH_REQUIRED: {
		id: "flux-import.error.length-required",
		message: "The upload did not say its size. Try again from this page.",
	},
	EMPTY_BODY: {
		id: "flux-import.error.empty-body",
		message: "The file or text is empty.",
	},
	NOT_CONFIGURED: {
		id: "flux-import.error.not-configured",
		message: "Uploads are not set up on this site.",
	},
	INVALID_FORMAT: {
		id: "flux-import.error.invalid-format",
		message: "This format cannot be used here. XLSX can only be uploaded as a file.",
	},
	INVALID_SOURCE: {
		id: "flux-import.error.invalid-source",
		message: "The data could not be read. Check its format and settings.",
	},
	UPLOAD_NOT_FOUND: {
		id: "flux-import.error.upload-not-found",
		message: "The uploaded file is no longer available. Upload it again.",
	},
	NO_SOURCE_KEYS: {
		id: "flux-import.error.no-source-keys",
		message: "No columns or fields were found in the data. Check the records path.",
	},
	SOURCE_NOT_FOUND: {
		id: "flux-import.error.source-not-found",
		message: "This saved source no longer exists.",
	},
	CREDENTIAL_MISSING: {
		id: "flux-import.error.credential-missing",
		message: "The credential this source uses no longer exists.",
	},
	CREDENTIALS_UNAVAILABLE: {
		id: "flux-import.error.credentials-unavailable",
		message: "The site's stored credentials cannot be read.",
	},
	URL_BLOCKED: {
		id: "flux-import.error.url-blocked",
		message: "This address cannot be fetched from the site.",
	},
	FETCH_FAILED: {
		id: "flux-import.error.fetch-failed",
		message: "The address could not be reached.",
	},
	HTTP_ERROR: {
		id: "flux-import.error.http-error",
		message: "The address answered with an error.",
	},
	TOO_MANY_REDIRECTS: {
		id: "flux-import.error.too-many-redirects",
		message: "The address redirected too many times.",
	},
	CONFLICT: {
		id: "flux-import.error.conflict",
		message: "Something else changed this at the same time. Try again.",
	},
	NAME_TAKEN: {
		id: "flux-import.error.name-taken",
		message: "That name is already taken. Choose another.",
	},
	INVALID_TEMPLATE: {
		id: "flux-import.error.invalid-template",
		message: "The import settings do not fit the collection.",
	},
	TEMPLATE_NOT_FOUND: {
		id: "flux-import.error.template-not-found",
		message: "This template no longer exists.",
	},
	TEMPLATE_CHANGED: {
		id: "flux-import.error.template-changed",
		message: "Someone else changed this template. Open it again to see their changes.",
	},
	TEMPLATE_TOO_LARGE: {
		id: "flux-import.error.template-too-large",
		message: "The template is too large to save.",
	},
	UNSUPPORTED_TEMPLATE_VERSION: {
		id: "flux-import.error.unsupported-template-version",
		message: "This template was made by a newer version of the importer.",
	},
	COLLECTION_NOT_FOUND: {
		id: "flux-import.error.collection-not-found",
		message: "The collection no longer exists.",
	},
	COLLECTION_MISMATCH: {
		id: "flux-import.error.collection-mismatch",
		message: "The template imports into a different collection.",
	},
	INVALID_CURSOR: {
		id: "flux-import.error.invalid-cursor",
		message: "The list changed while it was being read. Reload it.",
	},
	INVALID_OPTIONS: {
		id: "flux-import.error.invalid-options",
		message: "The import options are not valid.",
	},
	INVALID_TRANSITION: {
		id: "flux-import.error.invalid-transition",
		message: "The import cannot do that in its current state.",
	},
	LOG_TOO_LARGE: {
		id: "flux-import.error.log-too-large",
		message: "The log is too large to download at once. Download the failed records only.",
	},
	offline: {
		id: "flux-import.error.offline",
		message: "The site could not be reached. Check your connection.",
	},
	unknown: {
		id: "flux-import.error.unknown",
		message: "Something went wrong.",
	},
};

/** One sentence per `SUGGEST_WARNING_CODES`: plain words, never provider text. */
export const WARNING_MESSAGES: Readonly<Record<string, Msg>> = {
	ai_not_configured: {
		id: "flux-import.warning.ai-not-configured",
		message: "AI suggestions are not set up completely, so only name matching was used.",
	},
	ai_key_unavailable: {
		id: "flux-import.warning.ai-key-unavailable",
		message: "The AI provider's key cannot be read, so only name matching was used.",
	},
	ai_url_blocked: {
		id: "flux-import.warning.ai-url-blocked",
		message: "The AI provider's address is not allowed, so only name matching was used.",
	},
	ai_payload_too_large: {
		id: "flux-import.warning.ai-payload-too-large",
		message: "The sample was too large to send for AI suggestions, so only name matching was used.",
	},
	ai_rate_limited: {
		id: "flux-import.warning.ai-rate-limited",
		message: "The hourly limit of AI suggestions is reached, so only name matching was used.",
	},
	ai_timeout: {
		id: "flux-import.warning.ai-timeout",
		message: "The AI provider did not answer in time, so only name matching was used.",
	},
	ai_auth_failed: {
		id: "flux-import.warning.ai-auth-failed",
		message: "The AI provider refused the key, so only name matching was used.",
	},
	ai_billing: {
		id: "flux-import.warning.ai-billing",
		message: "The AI provider asks for payment or credit, so only name matching was used.",
	},
	ai_provider_rate_limited: {
		id: "flux-import.warning.ai-provider-rate-limited",
		message: "The AI provider is limiting requests, so only name matching was used.",
	},
	ai_provider_rejected: {
		id: "flux-import.warning.ai-provider-rejected",
		message: "The AI provider rejected the request, so only name matching was used.",
	},
	ai_provider_error: {
		id: "flux-import.warning.ai-provider-error",
		message: "The AI provider failed, so only name matching was used.",
	},
	ai_refused: {
		id: "flux-import.warning.ai-refused",
		message: "The AI provider declined to suggest a mapping, so only name matching was used.",
	},
	ai_truncated: {
		id: "flux-import.warning.ai-truncated",
		message: "The AI provider's answer was cut short, so only name matching was used.",
	},
	ai_invalid_output: {
		id: "flux-import.warning.ai-invalid-output",
		message: "The AI provider's answer could not be used, so only name matching was used.",
	},
	ai_unknown_field: {
		id: "flux-import.warning.ai-unknown-field",
		message: "{count} AI suggestions named fields that do not exist and were dropped.",
	},
	ai_duplicate_field: {
		id: "flux-import.warning.ai-duplicate-field",
		message: "{count} AI suggestions repeated a field and were dropped.",
	},
	ai_unknown_key: {
		id: "flux-import.warning.ai-unknown-key",
		message: "{count} AI suggestions named source keys that do not exist and were dropped.",
	},
	ai_duplicate_key: {
		id: "flux-import.warning.ai-duplicate-key",
		message: "{count} AI suggestions reused a source key and were dropped.",
	},
	ai_option_dropped: {
		id: "flux-import.warning.ai-option-dropped",
		message: "{count} options the AI suggested are not allowed and were dropped.",
	},
	ai_draft_invalid: {
		id: "flux-import.warning.ai-draft-invalid",
		message: "The AI suggestions did not make a valid mapping, so only name matching was used.",
	},
	sample_trimmed: {
		id: "flux-import.warning.sample-trimmed",
		message: "Less of the sample was sent for AI suggestions, to fit the size limit.",
	},
	keys_not_matched: {
		id: "flux-import.warning.keys-not-matched",
		message: "{count} source keys past the first 1,000 were not considered.",
	},
	keys_not_sent: {
		id: "flux-import.warning.keys-not-sent",
		message: "{count} source keys were too long or too many to send for AI suggestions.",
	},
	fields_not_sent: {
		id: "flux-import.warning.fields-not-sent",
		message: "{count} fields were not sent for AI suggestions and use name matching: {fields}.",
	},
	required_unmapped: {
		id: "flux-import.warning.required-unmapped",
		message: "These required fields have no source key yet: {fields}.",
	},
	reference_not_suggested: {
		id: "flux-import.warning.reference-not-suggested",
		message: "Reference fields are not suggested; map them yourself: {fields}.",
	},
	fields_not_eligible: {
		id: "flux-import.warning.fields-not-eligible",
		message: "These fields cannot be imported into: {fields}.",
	},
	date_format_ambiguous: {
		id: "flux-import.warning.date-format-ambiguous",
		message: "The date format is unclear for these fields; check it: {fields}.",
	},
	number_format_ambiguous: {
		id: "flux-import.warning.number-format-ambiguous",
		message: "The number format is unclear for these fields; check it: {fields}.",
	},
	key_guessed: {
		id: "flux-import.warning.key-guessed",
		message: "The record key was guessed. Check that it identifies each record.",
	},
	key_not_unique_in_sample: {
		id: "flux-import.warning.key-not-unique-in-sample",
		message: "The suggested record key repeats in the sample. Choose one that is unique.",
	},
	no_field_matched: {
		id: "flux-import.warning.no-field-matched",
		message: "No field could be matched to the data. Map the fields yourself.",
	},
	sample_empty: {
		id: "flux-import.warning.sample-empty",
		message: "The sample has no records. Check the file or the records path.",
	},
};

/** Job errors the Run step names (preflight F15); any other code shows `unknown`. */
export const JOB_ERROR_MESSAGES = {
	source_missing: {
		id: "flux-import.job-error.source-missing",
		message: "The file for this import is no longer available; start a new import.",
	},
	invalid_template: {
		id: "flux-import.job-error.invalid-template",
		message: "The import settings no longer fit the collection.",
	},
	internal: {
		id: "flux-import.job-error.internal",
		message: "The import stopped after repeated unexpected errors. Resume it to try again.",
	},
} satisfies Record<string, Msg>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** `count` and `name` from an error's details, when they are there. */
function detailValues(details: unknown): Values | undefined {
	if (!isRecord(details)) return undefined;
	const values: Record<string, string | number> = {};
	if (typeof details.count === "number") values.count = details.count;
	if (typeof details.name === "string") values.name = details.name;
	return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * Codes whose route message is the specifics the user needs (a parse position, the failing input
 * or status), shown as `detail` when there are no `problems` (coordinator ruling). Never
 * `FETCH_FAILED` or `URL_BLOCKED`, whose messages name hosts and addresses.
 */
const DETAIL_CODES: ReadonlySet<string> = new Set([
	"INVALID_SOURCE",
	"VALIDATION_ERROR",
	"HTTP_ERROR",
	"INVALID_OPTIONS",
]);

function detailProblems(details: unknown): string[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.problems)) return undefined;
	return details.problems.filter((p): p is string => typeof p === "string").map(redact);
}

/**
 * The sentence for a failed request. A 401 is the session sentence (EmDash's middleware answers
 * `NOT_AUTHENTICATED`, or `NOT_FOUND` for a deleted user) and a 403 the administrators-only one,
 * except `CSRF_REJECTED` (preflight F29); a `TypeError` is offline. An unknown code, or one in
 * `DETAIL_CODES` without `problems`, shows the route's message as `detail`. `detail` and
 * `problems` never hold an upload ID (preflight F15).
 */
export function describeError(e: unknown): {
	msg: Msg;
	values?: Values;
	detail?: string;
	problems?: string[];
} {
	if (e instanceof ApiError) {
		if (e.code !== "CSRF_REJECTED") {
			if (e.status === 401) return { msg: ERROR_MESSAGES.UNAUTHORIZED! };
			if (e.status === 403) return { msg: ERROR_MESSAGES.FORBIDDEN! };
		}
		const msg = own(ERROR_MESSAGES, e.code);
		const problems = detailProblems(e.details);
		const values = detailValues(e.details);
		const showMessage = !msg || (DETAIL_CODES.has(e.code) && !problems);
		return {
			msg: msg ?? ERROR_MESSAGES.unknown!,
			...(values ? { values } : {}),
			...(showMessage ? { detail: redact(e.message) } : {}),
			...(problems ? { problems } : {}),
		};
	}
	if (e instanceof TypeError) return { msg: ERROR_MESSAGES.offline! };
	if (e instanceof Error) return { msg: ERROR_MESSAGES.unknown!, detail: redact(e.message) };
	return { msg: ERROR_MESSAGES.unknown! };
}

/** A failed job's error (`job.error`), for the Run step (preflight F15). */
export function describeJobError(error: { code: string; message: string }): {
	msg: Msg;
	detail?: string;
} {
	switch (error.code) {
		case "source_missing":
			return { msg: JOB_ERROR_MESSAGES.source_missing };
		case "invalid_template":
			return { msg: JOB_ERROR_MESSAGES.invalid_template, detail: redact(error.message) };
		case "internal":
			return { msg: JOB_ERROR_MESSAGES.internal };
		default:
			return { msg: ERROR_MESSAGES.unknown!, detail: redact(error.message) };
	}
}

/** A `mapping/suggest` warning, with `{count}` and `{fields}` (comma-joined) when it has them. */
export function describeWarning(w: { code: string; count?: number; fields?: string[] }): {
	msg: Msg;
	values: Values;
} {
	const values: Record<string, string | number> = {};
	if (w.count !== undefined) values.count = w.count;
	if (w.fields !== undefined) values.fields = w.fields.join(", ");
	return { msg: own(WARNING_MESSAGES, w.code) ?? ERROR_MESSAGES.unknown!, values };
}
