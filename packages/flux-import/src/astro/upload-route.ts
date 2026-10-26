import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { EmDashUploads, stageUpload, UploadTooLargeError } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { maxSourceBytes, maxXlsxBytes } from "./config.js";

export const prerender = false;

/**
 * The extension only gates acceptance and the size limit; the template's `source.format` decides
 * parsing. Other spreadsheet files (.xls, .xlsb, .xlsm, .ods) are refused.
 */
const SOURCE_FILENAME = /^(?=.{1,255}$)[^/\\\0]+\.(?:csv|json|jsonl|ndjson|xml|xlsx)$/i;
const XLSX_FILENAME = /\.xlsx$/i;

/** Same envelope as EmDash's own API errors (`emdash` src/api/error.ts:31-43). */
function apiError(code: string, message: string, status: number): Response {
	return Response.json({ success: false, error: { code, message } }, { status });
}

/**
 * POST /_emdash/api/flux-import/uploads?filename=<name>.csv|.json|.jsonl|.ndjson|.xml|.xlsx
 *
 * EmDash's middleware authenticates this path and applies CSRF (`X-EmDash-Request: 1` for
 * session callers; PATs need the `admin` scope), verification report question 5. The route adds
 * the `import:execute` check and the size limit (`maxXlsxBytes` for .xlsx, else `maxSourceBytes`),
 * enforced while the body streams.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
	if (!hasPermission(locals.user, "import:execute")) {
		return apiError("FORBIDDEN", "Importing requires the import:execute permission", 403);
	}
	const storage = locals.emdash?.storage;
	if (!storage) return apiError("NOT_CONFIGURED", "EmDash storage is not configured", 500);

	const filename = url.searchParams.get("filename") ?? "";
	if (!SOURCE_FILENAME.test(filename)) {
		return apiError(
			"UNSUPPORTED_SOURCE",
			"filename must name a .csv, .json, .jsonl, .ndjson, .xml or .xlsx file",
			415,
		);
	}
	const limit = XLSX_FILENAME.test(filename) ? maxXlsxBytes() : maxSourceBytes();
	const header = request.headers.get("content-length");
	const declared = header === null ? undefined : Number(header);
	if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
		void request.body?.cancel().catch(() => {});
		return apiError("TOO_LARGE", `The upload exceeds the limit of ${limit} bytes`, 413);
	}
	// Workers buffer nothing: R2 needs the length up front (stageUpload), so ask the client for it.
	if (onWorkers() && (declared === undefined || !Number.isSafeInteger(declared))) {
		void request.body?.cancel().catch(() => {});
		return apiError("LENGTH_REQUIRED", "Uploads require a Content-Length header", 411);
	}
	// Over HTTP an empty request still carries a body stream, so a declared or counted length of 0
	// is what catches an empty upload.
	if (!request.body || declared === 0) {
		return apiError("EMPTY_BODY", "The request has no body", 400);
	}

	try {
		const length = declared !== undefined && Number.isSafeInteger(declared) ? declared : undefined;
		const staged = await stageUpload(storage, request.body, limit, length);
		if (staged.bytes === 0) {
			await new EmDashUploads(storage).delete(staged.uploadId);
			return apiError("EMPTY_BODY", "The request has no body", 400);
		}
		return Response.json({ success: true, data: staged }, { status: 201 });
	} catch (e) {
		if (e instanceof UploadTooLargeError) return apiError("TOO_LARGE", e.message, 413);
		throw e;
	}
};
