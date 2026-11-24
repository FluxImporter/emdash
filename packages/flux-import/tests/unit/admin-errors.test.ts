import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/admin/api-error.js";
import * as errors from "../../src/admin/errors.js";
import {
	describeError,
	describeJobError,
	describeRecordWarning,
	describeWarning,
	ERROR_MESSAGES,
	RECORD_WARNING_CODES,
	RECORD_WARNING_MESSAGES,
	SUGGEST_WARNING_CODES,
	WARNING_MESSAGES,
	WIZARD_ERROR_CODES,
} from "../../src/admin/errors.js";
import { interpolate } from "../../src/admin/i18n.js";
import { MISSING_MESSAGES } from "../../src/engine/missing.js";

const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;

describe("the wizard's error and warning sentences", () => {
	it("has a sentence for every code the wizard can meet", () => {
		for (const c of WIZARD_ERROR_CODES) expect(ERROR_MESSAGES[c]?.message, c).toMatch(/\.$/);
		for (const c of SUGGEST_WARNING_CODES) expect(WARNING_MESSAGES[c]?.message, c).toMatch(/\.$/);
		expect(ERROR_MESSAGES.offline?.message).toMatch(/\.$/);
		expect(ERROR_MESSAGES.unknown?.message).toMatch(/\.$/);
		// Nothing but the listed codes, offline and unknown.
		expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(
			[...WIZARD_ERROR_CODES, "offline", "unknown"].sort(),
		);
		expect(Object.keys(WARNING_MESSAGES).sort()).toEqual([...SUGGEST_WARNING_CODES].sort());
	});

	it("pins the code lists (F22, the M6d warnings table)", () => {
		expect(WIZARD_ERROR_CODES).toHaveLength(37);
		expect(WIZARD_ERROR_CODES).toContain("NOT_AUTHENTICATED");
		expect(WIZARD_ERROR_CODES).toContain("UNSUPPORTED_TEMPLATE_VERSION");
		expect(WIZARD_ERROR_CODES).toContain("INVALID_TRANSITION");
		expect(SUGGEST_WARNING_CODES).toHaveLength(33);
		expect(new Set(WIZARD_ERROR_CODES).size).toBe(WIZARD_ERROR_CODES.length);
		expect(new Set(SUGGEST_WARNING_CODES).size).toBe(SUGGEST_WARNING_CODES.length);
	});

	it("says 'Only administrators can import.' for any 403", () => {
		expect(
			describeError(new ApiError("FORBIDDEN", "Insufficient permissions", 403)).msg.message,
		).toBe("Only administrators can import.");
		expect(describeError(new ApiError("HTTP_403", "Forbidden", 403))).toEqual({
			msg: ERROR_MESSAGES.FORBIDDEN,
		});
		expect(describeError(new ApiError("NOT_FOUND", "Nope", 403)).msg).toBe(
			ERROR_MESSAGES.FORBIDDEN,
		);
	});

	it("reads any 401 as the ended session: NOT_AUTHENTICATED, and NOT_FOUND for a deleted user", () => {
		const session = ERROR_MESSAGES.UNAUTHORIZED;
		expect(describeError(new ApiError("NOT_AUTHENTICATED", "Not authenticated", 401))).toEqual({
			msg: session,
		});
		expect(describeError(new ApiError("NOT_FOUND", "User not found", 401))).toEqual({
			msg: session,
		});
		expect(describeError(new ApiError("HTTP_401", "Unauthorized", 401)).msg).toBe(session);
		expect(describeError(new ApiError("CSRF_REJECTED", "Missing header", 401)).msg).toBe(
			ERROR_MESSAGES.CSRF_REJECTED,
		);
	});

	it("gives CSRF_REJECTED its own sentence, though it answers 403 (F29)", () => {
		const d = describeError(new ApiError("CSRF_REJECTED", "Missing required header", 403));
		expect(d.msg).toBe(ERROR_MESSAGES.CSRF_REJECTED);
		expect(d.msg.message).not.toBe("Only administrators can import.");
	});

	it("gives a known code its sentence, without the route's message", () => {
		const d = describeError(new ApiError("NAME_TAKEN", 'A template named "x" already exists', 409));
		expect(d.msg).toBe(ERROR_MESSAGES.NAME_TAKEN);
		expect(d.detail).toBeUndefined();
	});

	it("shows the server's specifics for INVALID_SOURCE, VALIDATION_ERROR, HTTP_ERROR and INVALID_OPTIONS", () => {
		const source = describeError(
			new ApiError("INVALID_SOURCE", "Unexpected token at byte 42", 400),
		);
		expect(source).toEqual({
			msg: ERROR_MESSAGES.INVALID_SOURCE,
			detail: "Unexpected token at byte 42",
		});
		const validation = describeError(
			new ApiError("VALIDATION_ERROR", `uploadId: ${UPLOAD_ID} is not staged`, 400),
		);
		expect(validation.detail).toBe("uploadId: the uploaded file is not staged");
		expect(describeError(new ApiError("HTTP_ERROR", "The server answered 404", 502)).detail).toBe(
			"The server answered 404",
		);
		expect(describeError(new ApiError("INVALID_OPTIONS", "batchSize: too big", 400)).detail).toBe(
			"batchSize: too big",
		);
		// Problems, when there are any, still win.
		const listed = describeError(
			new ApiError("INVALID_SOURCE", "Bad source", 400, { problems: ["records: not found"] }),
		);
		expect(listed.detail).toBeUndefined();
		expect(listed.problems).toEqual(["records: not found"]);
	});

	it("never shows a FETCH_FAILED or URL_BLOCKED message, which names hosts", () => {
		for (const code of ["FETCH_FAILED", "URL_BLOCKED"]) {
			const d = describeError(
				new ApiError(code, "Could not reach feeds.internal.example:8443", 502),
			);
			expect(d).toEqual({ msg: ERROR_MESSAGES[code] });
			expect(JSON.stringify(d)).not.toContain("feeds.internal.example");
		}
	});

	it("never takes a sentence from the prototype", () => {
		for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			expect(describeError(new ApiError(code, "Odd", 400))).toEqual({
				msg: ERROR_MESSAGES.unknown,
				detail: "Odd",
			});
			expect(describeWarning({ code }).msg).toBe(ERROR_MESSAGES.unknown);
		}
	});

	it("takes count and name values from details", () => {
		const d = describeError(
			new ApiError("TEMPLATE_CHANGED", "Changed", 409, { count: 3, name: "Posts", other: true }),
		);
		expect(d.values).toEqual({ count: 3, name: "Posts" });
		expect(describeError(new ApiError("CONFLICT", "Taken", 409, { revision: 2 })).values).toBe(
			undefined,
		);
	});

	it("shows the route's message for an unknown code", () => {
		const d = describeError(new ApiError("SOMETHING_NEW", "The new thing went wrong", 400));
		expect(d.msg).toBe(ERROR_MESSAGES.unknown);
		expect(d.detail).toBe("The new thing went wrong");
	});

	it("never shows an upload ID in a detail or a problem (F15)", () => {
		const d = describeError(new ApiError("WHO_KNOWS", `Upload ${UPLOAD_ID} is odd`, 400));
		expect(d.detail).toBe("Upload the uploaded file is odd");
		const p = describeError(
			new ApiError("INVALID_TEMPLATE", "Bad", 400, { problems: [`Upload ${UPLOAD_ID} gone`] }),
		);
		expect(p.problems).toEqual(["Upload the uploaded file gone"]);
		expect(describeError(new Error(`Upload ${UPLOAD_ID}`)).detail).toBe("Upload the uploaded file");
	});

	it("lists INVALID_TEMPLATE problems", () => {
		const d = describeError(
			new ApiError("INVALID_TEMPLATE", "The template does not fit", 400, {
				problems: ["fields.title: no such field", "key.from: required", 7],
			}),
		);
		expect(d.msg).toBe(ERROR_MESSAGES.INVALID_TEMPLATE);
		expect(d.problems).toEqual(["fields.title: no such field", "key.from: required"]);
		expect(describeError(new ApiError("INVALID_TEMPLATE", "x", 400)).problems).toBeUndefined();
	});

	it("fills {count} and {fields} from a warning", () => {
		const sent = describeWarning({ code: "fields_not_sent", count: 4, fields: ["a", "b"] });
		expect(sent.msg).toBe(WARNING_MESSAGES.fields_not_sent);
		expect(sent.values).toEqual({ count: 4, fields: "a, b" });
		expect(sent.msg.message).toContain("{count}");
		expect(sent.msg.message).toContain("{fields}");
		expect(interpolate(sent.msg.message, sent.values)).not.toMatch(/[{}]/);

		const required = describeWarning({ code: "required_unmapped", fields: ["title", "body"] });
		expect(interpolate(required.msg.message, required.values)).toContain("title, body");

		const dropped = describeWarning({ code: "ai_unknown_key", count: 2 });
		expect(interpolate(dropped.msg.message, dropped.values)).toContain("2");
	});

	it("uses {count} and {fields} exactly where the M6d table carries them", () => {
		const counted = [
			"ai_unknown_field",
			"ai_duplicate_field",
			"ai_unknown_key",
			"ai_duplicate_key",
			"ai_option_dropped",
			"keys_not_matched",
			"keys_not_sent",
			"fields_not_sent",
		];
		const listed = [
			"fields_not_sent",
			"required_unmapped",
			"reference_not_suggested",
			"fields_not_eligible",
			"date_format_ambiguous",
			"number_format_ambiguous",
		];
		for (const c of SUGGEST_WARNING_CODES) {
			const m = WARNING_MESSAGES[c]!.message;
			expect(m.includes("{count}"), c).toBe(counted.includes(c));
			expect(m.includes("{fields}"), c).toBe(listed.includes(c));
		}
	});

	it("describes an unknown warning with the unknown sentence", () => {
		const d = describeWarning({ code: "ai_new_thing" });
		expect(d.msg).toBe(ERROR_MESSAGES.unknown);
		expect(d.values).toEqual({});
	});

	it("calls the network offline, not unknown", () => {
		const d = describeError(new TypeError("Failed to fetch"));
		expect(d.msg).toBe(ERROR_MESSAGES.offline);
		expect(d.detail).toBeUndefined();
	});

	it("describes anything else as unknown", () => {
		expect(describeError(new Error("boom"))).toEqual({
			msg: ERROR_MESSAGES.unknown,
			detail: "boom",
		});
		expect(describeError("text")).toEqual({ msg: ERROR_MESSAGES.unknown });
	});
});

describe("errors.ts's message IDs (Ruling 2)", () => {
	const ID = /^flux-import\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
	const isMsg = (v: unknown): v is { id: string; message: string } =>
		typeof v === "object" &&
		v !== null &&
		typeof (v as { id?: unknown }).id === "string" &&
		typeof (v as { message?: unknown }).message === "string";
	const msgs = Object.values(errors)
		.filter((v) => typeof v === "object" && v !== null && !Array.isArray(v))
		.flatMap((table) => Object.values(table as Record<string, unknown>))
		.filter(isMsg);

	it("exports every Msg the file defines", () => {
		const source = readFileSync(new URL("../../src/admin/errors.ts", import.meta.url), "utf8");
		const literals = source.match(/\bid: "/g) ?? [];
		expect(msgs.length).toBeGreaterThan(70);
		expect(msgs).toHaveLength(literals.length);
	});

	it("keeps them well-formed, unique and free of ICU syntax", () => {
		const problems: string[] = [];
		const seen = new Set<string>();
		for (const m of msgs) {
			if (!ID.test(m.id)) problems.push(`bad ID ${m.id}`);
			if (seen.has(m.id)) problems.push(`duplicate ID ${m.id}`);
			seen.add(m.id);
			if (/[{}]/.test(m.message.replace(/\{[A-Za-z]+\}/g, ""))) {
				problems.push(`ICU syntax in ${m.id}: ${m.message}`);
			}
		}
		expect(problems).toEqual([]);
	});
});

describe("describeRecordWarning (a dry run's per-record warnings)", () => {
	it("has a sentence for every warning code an import job writes on a record", () => {
		for (const c of RECORD_WARNING_CODES) {
			expect(RECORD_WARNING_MESSAGES[c]?.message, c).toMatch(/\.$/);
		}
		expect(Object.keys(RECORD_WARNING_MESSAGES).sort()).toEqual(
			[...RECORD_WARNING_CODES, "other"].sort(),
		);
		expect(new Set(RECORD_WARNING_CODES).size).toBe(RECORD_WARNING_CODES.length);
	});

	it("covers the missing phase's codes, read from the engine", () => {
		for (const c of Object.keys(MISSING_MESSAGES)) expect(RECORD_WARNING_CODES, c).toContain(c);
		expect(RECORD_WARNING_CODES).toEqual(
			expect.arrayContaining([
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
				"warnings_truncated",
			]),
		);
		expect(RECORD_WARNING_CODES).toHaveLength(18);
	});

	it("says why an entry was left alone, without the engine's message for a fixed one", () => {
		const d = describeRecordWarning({ code: "missing_edited", message: "Left alone: …" });
		expect(d).toEqual({ msg: RECORD_WARNING_MESSAGES.missing_edited });
	});

	it("keeps the engine's specifics, redacted, where its message carries them", () => {
		const d = describeRecordWarning({
			code: "image_dropped",
			message: `invalid_media_url: ${UPLOAD_ID}.png: not a URL`,
		});
		expect(d.msg).toBe(RECORD_WARNING_MESSAGES.image_dropped);
		expect(d.detail).toBe("invalid_media_url: the uploaded file.png: not a URL");
	});

	it("shows an unknown code's message, redacted, under a neutral sentence", () => {
		const d = describeRecordWarning({ code: "brand_new", message: `About ${UPLOAD_ID}` });
		expect(d).toEqual({ msg: RECORD_WARNING_MESSAGES.other, detail: "About the uploaded file" });
		expect(describeRecordWarning({ code: "toString", message: "x" }).msg).toBe(
			RECORD_WARNING_MESSAGES.other,
		);
		// `other` is the wizard's own key, not an engine code: its message still shows.
		expect(describeRecordWarning({ code: "other", message: "x" })).toEqual({
			msg: RECORD_WARNING_MESSAGES.other,
			detail: "x",
		});
	});
});

describe("describeJobError (F15)", () => {
	it("says the file is gone for source_missing, without the upload ID", () => {
		const d = describeJobError({
			code: "source_missing",
			message: `Upload ${UPLOAD_ID} not found`,
		});
		expect(d.msg.message).toBe(
			"The file for this import is no longer available; start a new import.",
		);
		expect(JSON.stringify(d)).not.toContain(UPLOAD_ID);
		expect(d.detail).toBeUndefined();
	});

	it("gives invalid_template and internal their sentences", () => {
		const t = describeJobError({ code: "invalid_template", message: "fields.x: gone" });
		expect(t.msg.message).toMatch(/\.$/);
		expect(t.detail).toBe("fields.x: gone");
		const i = describeJobError({ code: "internal", message: "D1 timed out" });
		expect(i.msg.message).toMatch(/\.$/);
		expect(i.msg).not.toBe(t.msg);
		expect(i.msg).not.toBe(ERROR_MESSAGES.unknown);
	});

	it("shows anything else as unknown with the message redacted", () => {
		const d = describeJobError({ code: "media_failed", message: `Read ${UPLOAD_ID} failed` });
		expect(d).toEqual({ msg: ERROR_MESSAGES.unknown, detail: "Read the uploaded file failed" });
	});
});
