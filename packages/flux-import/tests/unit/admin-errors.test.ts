import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/admin/api-error.js";
import {
	describeError,
	describeJobError,
	describeWarning,
	ERROR_MESSAGES,
	SUGGEST_WARNING_CODES,
	WARNING_MESSAGES,
	WIZARD_ERROR_CODES,
} from "../../src/admin/errors.js";
import { interpolate } from "../../src/admin/i18n.js";

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
		expect(WIZARD_ERROR_CODES).toHaveLength(36);
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
