import type { ScheduleView } from "../plugin/schedules.js";
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
	"OWNER_IN_USE",
	"INVALID_FILE",
	"UNSUPPORTED_FILE_VERSION",
	"TEMPLATE_IN_USE",
	"TEMPLATE_PROBLEMS",
	// Sources
	"SOURCE_IN_USE",
	// Schedules
	"SCHEDULE_CHANGED",
	"SCHEDULE_BUSY",
	"SCHEDULE_DISABLED",
	"SCHEDULE_LIMIT",
	"INVALID_CRON",
	"MISSING_REQUIRED",
	// EmDash's site fence (F3)
	"TRANSFER_IMPORT_IN_PROGRESS",
	"TRANSFER_FENCE_CHECK_FAILED",
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
		id: "fluximporter.error.unauthorized",
		message: "Your session has ended. Sign in again to continue.",
	},
	NOT_AUTHENTICATED: {
		id: "fluximporter.error.not-authenticated",
		message: "Your session has ended. Sign in again to continue.",
	},
	FORBIDDEN: { id: "fluximporter.error.forbidden", message: "Only administrators can import." },
	CSRF_REJECTED: {
		id: "fluximporter.error.csrf-rejected",
		message: "The request was refused as unsafe. Reload the page and try again.",
	},
	VALIDATION_ERROR: {
		id: "fluximporter.error.validation-error",
		message: "The request was not valid. Check your entries and try again.",
	},
	INVALID_PLUGIN_REQUEST: {
		id: "fluximporter.error.invalid-plugin-request",
		message: "The request was too large or not valid.",
	},
	NOT_FOUND: {
		id: "fluximporter.error.not-found",
		message: "This item no longer exists.",
	},
	INTERNAL_ERROR: {
		id: "fluximporter.error.internal-error",
		message: "Something went wrong on the server. Try again.",
	},
	UNSUPPORTED_SOURCE: {
		id: "fluximporter.error.unsupported-source",
		message: "This kind of file cannot be imported. Use CSV, JSON, JSON Lines, XML or XLSX.",
	},
	TOO_LARGE: {
		id: "fluximporter.error.too-large",
		message: "The file or text is larger than the site accepts.",
	},
	LENGTH_REQUIRED: {
		id: "fluximporter.error.length-required",
		message: "The upload did not say its size. Try again from this page.",
	},
	EMPTY_BODY: {
		id: "fluximporter.error.empty-body",
		message: "The file or text is empty.",
	},
	NOT_CONFIGURED: {
		id: "fluximporter.error.not-configured",
		message: "Uploads are not set up on this site.",
	},
	INVALID_FORMAT: {
		id: "fluximporter.error.invalid-format",
		message: "This format cannot be used here. XLSX can only be uploaded as a file.",
	},
	INVALID_SOURCE: {
		id: "fluximporter.error.invalid-source",
		message: "The data could not be read. Check its format and settings.",
	},
	UPLOAD_NOT_FOUND: {
		id: "fluximporter.error.upload-not-found",
		message: "The uploaded file is no longer available. Upload it again.",
	},
	NO_SOURCE_KEYS: {
		id: "fluximporter.error.no-source-keys",
		message: "No columns or fields were found in the data. Check the records path.",
	},
	SOURCE_NOT_FOUND: {
		id: "fluximporter.error.source-not-found",
		message: "This saved source no longer exists.",
	},
	CREDENTIAL_MISSING: {
		id: "fluximporter.error.credential-missing",
		message: "The credential this source uses no longer exists.",
	},
	CREDENTIALS_UNAVAILABLE: {
		id: "fluximporter.error.credentials-unavailable",
		message: "The site's stored credentials cannot be read.",
	},
	URL_BLOCKED: {
		id: "fluximporter.error.url-blocked",
		message: "This address cannot be fetched from the site.",
	},
	FETCH_FAILED: {
		id: "fluximporter.error.fetch-failed",
		message: "The address could not be reached.",
	},
	HTTP_ERROR: {
		id: "fluximporter.error.http-error",
		message: "The address answered with an error.",
	},
	TOO_MANY_REDIRECTS: {
		id: "fluximporter.error.too-many-redirects",
		message: "The address redirected too many times.",
	},
	CONFLICT: {
		id: "fluximporter.error.conflict",
		message: "Something else changed this at the same time. Try again.",
	},
	NAME_TAKEN: {
		id: "fluximporter.error.name-taken",
		message: "That name is already taken. Choose another.",
	},
	INVALID_TEMPLATE: {
		id: "fluximporter.error.invalid-template",
		message: "The import settings do not fit the collection.",
	},
	TEMPLATE_NOT_FOUND: {
		id: "fluximporter.error.template-not-found",
		message: "This template no longer exists.",
	},
	TEMPLATE_CHANGED: {
		id: "fluximporter.error.template-changed",
		message: "Someone else changed this template. Open it again to see their changes.",
	},
	TEMPLATE_TOO_LARGE: {
		id: "fluximporter.error.template-too-large",
		message: "The template is too large to save.",
	},
	UNSUPPORTED_TEMPLATE_VERSION: {
		id: "fluximporter.error.unsupported-template-version",
		message: "This template was made by a newer version of the importer.",
	},
	COLLECTION_NOT_FOUND: {
		id: "fluximporter.error.collection-not-found",
		message: "The collection no longer exists.",
	},
	COLLECTION_MISMATCH: {
		id: "fluximporter.error.collection-mismatch",
		message: "The template imports into a different collection.",
	},
	INVALID_CURSOR: {
		id: "fluximporter.error.invalid-cursor",
		message: "The list changed while it was being read. Reload it.",
	},
	OWNER_IN_USE: {
		id: "fluximporter.error.owner-in-use",
		message: "Another template that tracks missing entries already uses this owner.",
	},
	INVALID_FILE: {
		id: "fluximporter.error.invalid-file",
		message: "This file is not a template that Flux Importer can read.",
	},
	UNSUPPORTED_FILE_VERSION: {
		id: "fluximporter.error.unsupported-file-version",
		message: "This template file was made by a newer version of the importer.",
	},
	TEMPLATE_IN_USE: {
		id: "fluximporter.error.template-in-use",
		message: "A schedule runs this template. Delete or change the schedule first.",
	},
	SOURCE_IN_USE: {
		id: "fluximporter.error.source-in-use",
		message: "A schedule reads this source. Delete or change the schedule first.",
	},
	TEMPLATE_PROBLEMS: {
		id: "fluximporter.error.template-problems",
		message: "The template does not fit the site, so it cannot be scheduled.",
	},
	SCHEDULE_CHANGED: {
		id: "fluximporter.error.schedule-changed",
		message: "Someone else changed this schedule. Open it again to see their changes.",
	},
	SCHEDULE_BUSY: {
		id: "fluximporter.error.schedule-busy",
		message: "This schedule is importing right now. Wait for the import to finish or cancel it.",
	},
	SCHEDULE_DISABLED: {
		id: "fluximporter.error.schedule-disabled",
		message: "This schedule is paused. Resume it first.",
	},
	SCHEDULE_LIMIT: {
		id: "fluximporter.error.schedule-limit",
		message: "The site has as many schedules as it can hold. Delete one first.",
	},
	INVALID_CRON: {
		id: "fluximporter.error.invalid-cron",
		message: "That schedule time is not valid.",
	},
	MISSING_REQUIRED: {
		id: "fluximporter.error.missing-required",
		message:
			"This template tracks missing entries, so the schedule has to say what to do about them.",
	},
	TRANSFER_IMPORT_IN_PROGRESS: {
		id: "fluximporter.error.transfer-import-in-progress",
		message: "A site import is running, so imports and their schedules wait until it ends.",
	},
	TRANSFER_FENCE_CHECK_FAILED: {
		id: "fluximporter.error.transfer-fence-check-failed",
		message: "Flux Importer couldn't check whether the site is busy. Try again shortly.",
	},
	INVALID_OPTIONS: {
		id: "fluximporter.error.invalid-options",
		message: "The import options are not valid.",
	},
	INVALID_TRANSITION: {
		id: "fluximporter.error.invalid-transition",
		message: "The import cannot do that in its current state.",
	},
	LOG_TOO_LARGE: {
		id: "fluximporter.error.log-too-large",
		message: "The log is too large to download at once. Download the failed records only.",
	},
	offline: {
		id: "fluximporter.error.offline",
		message: "The site could not be reached. Check your connection.",
	},
	unknown: {
		id: "fluximporter.error.unknown",
		message: "Something went wrong.",
	},
};

/** One sentence per `SUGGEST_WARNING_CODES`: plain words, never provider text. */
export const WARNING_MESSAGES: Readonly<Record<string, Msg>> = {
	ai_not_configured: {
		id: "fluximporter.warning.ai-not-configured",
		message: "AI suggestions are not set up completely, so only name matching was used.",
	},
	ai_key_unavailable: {
		id: "fluximporter.warning.ai-key-unavailable",
		message: "The AI provider's key cannot be read, so only name matching was used.",
	},
	ai_url_blocked: {
		id: "fluximporter.warning.ai-url-blocked",
		message: "The AI provider's address is not allowed, so only name matching was used.",
	},
	ai_payload_too_large: {
		id: "fluximporter.warning.ai-payload-too-large",
		message: "The sample was too large to send for AI suggestions, so only name matching was used.",
	},
	ai_rate_limited: {
		id: "fluximporter.warning.ai-rate-limited",
		message: "The hourly limit of AI suggestions is reached, so only name matching was used.",
	},
	ai_timeout: {
		id: "fluximporter.warning.ai-timeout",
		message: "The AI provider did not answer in time, so only name matching was used.",
	},
	ai_auth_failed: {
		id: "fluximporter.warning.ai-auth-failed",
		message: "The AI provider refused the key, so only name matching was used.",
	},
	ai_billing: {
		id: "fluximporter.warning.ai-billing",
		message: "The AI provider asks for payment or credit, so only name matching was used.",
	},
	ai_provider_rate_limited: {
		id: "fluximporter.warning.ai-provider-rate-limited",
		message: "The AI provider is limiting requests, so only name matching was used.",
	},
	ai_provider_rejected: {
		id: "fluximporter.warning.ai-provider-rejected",
		message: "The AI provider rejected the request, so only name matching was used.",
	},
	ai_provider_error: {
		id: "fluximporter.warning.ai-provider-error",
		message: "The AI provider failed, so only name matching was used.",
	},
	ai_refused: {
		id: "fluximporter.warning.ai-refused",
		message: "The AI provider declined to suggest a mapping, so only name matching was used.",
	},
	ai_truncated: {
		id: "fluximporter.warning.ai-truncated",
		message: "The AI provider's answer was cut short, so only name matching was used.",
	},
	ai_invalid_output: {
		id: "fluximporter.warning.ai-invalid-output",
		message: "The AI provider's answer could not be used, so only name matching was used.",
	},
	ai_unknown_field: {
		id: "fluximporter.warning.ai-unknown-field",
		message: "{count} AI suggestions named fields that do not exist and were dropped.",
	},
	ai_duplicate_field: {
		id: "fluximporter.warning.ai-duplicate-field",
		message: "{count} AI suggestions repeated a field and were dropped.",
	},
	ai_unknown_key: {
		id: "fluximporter.warning.ai-unknown-key",
		message: "{count} AI suggestions named source keys that do not exist and were dropped.",
	},
	ai_duplicate_key: {
		id: "fluximporter.warning.ai-duplicate-key",
		message: "{count} AI suggestions reused a source key and were dropped.",
	},
	ai_option_dropped: {
		id: "fluximporter.warning.ai-option-dropped",
		message: "{count} options the AI suggested are not allowed and were dropped.",
	},
	ai_draft_invalid: {
		id: "fluximporter.warning.ai-draft-invalid",
		message: "The AI suggestions did not make a valid mapping, so only name matching was used.",
	},
	sample_trimmed: {
		id: "fluximporter.warning.sample-trimmed",
		message: "Less of the sample was sent for AI suggestions, to fit the size limit.",
	},
	keys_not_matched: {
		id: "fluximporter.warning.keys-not-matched",
		message: "{count} source keys past the first 1,000 were not considered.",
	},
	keys_not_sent: {
		id: "fluximporter.warning.keys-not-sent",
		message: "{count} source keys were too long or too many to send for AI suggestions.",
	},
	fields_not_sent: {
		id: "fluximporter.warning.fields-not-sent",
		message: "{count} fields were not sent for AI suggestions and use name matching: {fields}.",
	},
	required_unmapped: {
		id: "fluximporter.warning.required-unmapped",
		message: "These required fields have no source key yet: {fields}.",
	},
	reference_not_suggested: {
		id: "fluximporter.warning.reference-not-suggested",
		message: "Reference fields are not suggested; map them yourself: {fields}.",
	},
	fields_not_eligible: {
		id: "fluximporter.warning.fields-not-eligible",
		message: "These fields cannot be imported into: {fields}.",
	},
	date_format_ambiguous: {
		id: "fluximporter.warning.date-format-ambiguous",
		message: "The date format is unclear for these fields; check it: {fields}.",
	},
	number_format_ambiguous: {
		id: "fluximporter.warning.number-format-ambiguous",
		message: "The number format is unclear for these fields; check it: {fields}.",
	},
	key_guessed: {
		id: "fluximporter.warning.key-guessed",
		message: "The record key was guessed. Check that it identifies each record.",
	},
	key_not_unique_in_sample: {
		id: "fluximporter.warning.key-not-unique-in-sample",
		message: "The suggested record key repeats in the sample. Choose one that is unique.",
	},
	no_field_matched: {
		id: "fluximporter.warning.no-field-matched",
		message: "No field could be matched to the data. Map the fields yourself.",
	},
	sample_empty: {
		id: "fluximporter.warning.sample-empty",
		message: "The sample has no records. Check the file or the records path.",
	},
};

/**
 * The warnings an import job writes on a record row (`RecordRow.warnings`), from the engine:
 * the record rules (`rules.ts`: `exists`, `not_found`, `field_edited`, `not_scheduled`), a
 * translation (`batch.ts`), Portable Text and its images (`portable-text.ts`,
 * `portable-text-images.ts`, `template.ts`), the missing phase (`missing.ts`'s
 * `MISSING_MESSAGES`) and the cap (`types.ts`'s `warnings_truncated`).
 */
export const RECORD_WARNING_CODES: readonly string[] = [
	"exists",
	"not_found",
	"field_edited",
	"not_scheduled",
	"translation_source_not_found",
	"translation_not_linked",
	"unknown_markup",
	"removed_markup",
	"link_dropped",
	"alt_truncated",
	"image_dropped",
	"missing_gone",
	"missing_edited",
	"missing_pending",
	"missing_not_live",
	"missing_has_translations",
	"missing_over_count",
	"warnings_truncated",
];

/** One sentence per `RECORD_WARNING_CODES`, plus `other` for a code the wizard does not know. */
export const RECORD_WARNING_MESSAGES: Readonly<Record<string, Msg>> = {
	exists: {
		id: "fluximporter.record-warning.exists",
		message: "Skipped: the entry exists, and this import only creates entries.",
	},
	not_found: {
		id: "fluximporter.record-warning.not-found",
		message: "Skipped: no entry has this key, and this import only updates entries.",
	},
	field_edited: {
		id: "fluximporter.record-warning.field-edited",
		message: "Not updated: the value was changed outside the import since it last wrote it.",
	},
	not_scheduled: {
		id: "fluximporter.record-warning.not-scheduled",
		message:
			"Not scheduled: the update goes live at once (the collection keeps no revisions, or only terms and bylines change).",
	},
	translation_source_not_found: {
		id: "fluximporter.record-warning.translation-source-not-found",
		message: "The entry this record translates was not found, so it is updated without it.",
	},
	translation_not_linked: {
		id: "fluximporter.record-warning.translation-not-linked",
		message:
			"The entry is not linked as a translation, and an existing entry cannot be linked. Trash the existing entry so the next run creates it as a translation.",
	},
	unknown_markup: {
		id: "fluximporter.record-warning.unknown-markup",
		message: "Some markup was not recognised; its text was kept.",
	},
	removed_markup: {
		id: "fluximporter.record-warning.removed-markup",
		message: "Some markup was removed.",
	},
	link_dropped: {
		id: "fluximporter.record-warning.link-dropped",
		message: "Some links were kept as text, without their address.",
	},
	alt_truncated: {
		id: "fluximporter.record-warning.alt-truncated",
		message: "Some image alt text was cut to the longest length allowed.",
	},
	image_dropped: {
		id: "fluximporter.record-warning.image-dropped",
		message: "Some images were left out.",
	},
	missing_gone: {
		id: "fluximporter.record-warning.missing-gone",
		message: "Nothing to do: the entry no longer exists or is in the trash.",
	},
	missing_edited: {
		id: "fluximporter.record-warning.missing-edited",
		message: "Left alone: the entry changed after the import last wrote it.",
	},
	missing_pending: {
		id: "fluximporter.record-warning.missing-pending",
		message: "Left alone: the entry has a draft or a schedule that is not live.",
	},
	missing_not_live: {
		id: "fluximporter.record-warning.missing-not-live",
		message: "Nothing to do: the entry is not published.",
	},
	missing_has_translations: {
		id: "fluximporter.record-warning.missing-has-translations",
		message: "Left alone: the entry has translations that are still active.",
	},
	missing_over_count: {
		id: "fluximporter.record-warning.missing-over-count",
		message:
			"Left alone: more entries were missing than when the import counted them. Run the import again.",
	},
	warnings_truncated: {
		id: "fluximporter.record-warning.warnings-truncated",
		message: "More warnings were left out.",
	},
	other: {
		id: "fluximporter.record-warning.other",
		message: "The import noted something about this record.",
	},
};

/**
 * Record warnings whose engine message carries specifics the sentence cannot (which tags, how
 * many, which URL or source key): the message is shown, redacted, beside the sentence.
 */
const RECORD_WARNING_DETAIL: ReadonlySet<string> = new Set([
	"translation_source_not_found",
	"translation_not_linked",
	"unknown_markup",
	"removed_markup",
	"link_dropped",
	"alt_truncated",
	"image_dropped",
	"warnings_truncated",
]);

/**
 * A record row's warning, for Preview's records: its sentence, and the engine's message (never
 * with an upload ID) where it holds specifics, or for a code the wizard does not know.
 */
export function describeRecordWarning(w: { code: string; message: string }): {
	msg: Msg;
	detail?: string;
} {
	const msg = own(RECORD_WARNING_MESSAGES, w.code);
	if (msg === undefined || w.code === "other") {
		return { msg: RECORD_WARNING_MESSAGES.other!, detail: redact(w.message) };
	}
	return RECORD_WARNING_DETAIL.has(w.code) ? { msg, detail: redact(w.message) } : { msg };
}

/**
 * Job errors a resume cannot cure: the file is gone, or the template no longer fits. Preview and
 * Run offer no resume for them (final review 2).
 */
export const FINAL_JOB_ERRORS: ReadonlySet<string> = new Set([
	"source_missing",
	"invalid_template",
]);

/** Job errors the Run step names (preflight F15); any other code shows `unknown`. */
export const JOB_ERROR_MESSAGES = {
	source_missing: {
		id: "fluximporter.job-error.source-missing",
		message: "The file for this import is no longer available; start a new import.",
	},
	invalid_template: {
		id: "fluximporter.job-error.invalid-template",
		message: "The import settings no longer fit the collection.",
	},
	internal: {
		id: "fluximporter.job-error.internal",
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
	"INVALID_FILE",
	"INVALID_CRON",
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

/**
 * The names of the schedules an in-use refusal lists in `details.scheduleIds`, in that order,
 * comma-joined; an ID the list lacks is skipped. Null when there are none to name.
 */
export function scheduleNames(e: unknown, schedules: readonly ScheduleView[]): string | null {
	if (!(e instanceof ApiError) || !isRecord(e.details)) return null;
	const ids = e.details.scheduleIds;
	if (!Array.isArray(ids)) return null;
	const names = ids.flatMap((id) => {
		const found = schedules.find((s) => s.id === id);
		return found ? [found.name] : [];
	});
	return names.length === 0 ? null : names.join(", ");
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
