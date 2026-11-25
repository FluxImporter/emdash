import { RESERVED_FIELD_SLUGS as EMDASH_RESERVED_FIELD_SLUGS } from "emdash";
import { describe, expect, it } from "vitest";
import * as limits from "../../src/admin/limits.js";
import { UPLOAD_ID_PATTERN } from "../../src/emdash/uploads.js";
import { DEFAULT_HIERARCHY, DEFAULT_SEPARATOR } from "../../src/engine/links.js";
import {
	COMPATIBLE,
	MAX_UPDATE_FIELDS,
	OWNER_PATTERN,
	templateSchema,
} from "../../src/engine/template.js";
import { BATCH_SIZE_MAX } from "../../src/engine/types.js";
import { FALSE_TOKENS, TRUE_TOKENS } from "../../src/engine/values.js";
import { CREDENTIAL_NAME, HEADER_NAME } from "../../src/plugin/credentials.js";
import { routes, TEMPLATE_BODY_MAX_BYTES } from "../../src/plugin/routes.js";
import { MAX_SCHEDULES } from "../../src/plugin/schedules.js";
import { APPLY_FIELD_TYPES, MAX_APPLY_FIELDS } from "../../src/plugin/schema-apply.js";
import { JOB_PAGE, PASTE_MAX_BYTES, SAMPLE_MAX } from "../../src/plugin/service.js";
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX } from "../../src/plugin/templates.js";
import { SOURCE_FORMATS } from "../../src/sources/reader.js";

/** The browser's copies of server constants equal the server's (plan Ruling 8). */
describe("src/admin/limits.ts", () => {
	it("copies the size and count limits", () => {
		expect(limits.PASTE_MAX_BYTES).toBe(PASTE_MAX_BYTES);
		expect(limits.SAMPLE_MAX).toBe(SAMPLE_MAX);
		expect(limits.MAX_APPLY_FIELDS).toBe(MAX_APPLY_FIELDS);
		expect(limits.TEMPLATE_NAME_MAX).toBe(TEMPLATE_NAME_MAX);
		expect(limits.MAX_UPDATE_FIELDS).toBe(MAX_UPDATE_FIELDS);
		expect(limits.BATCH_SIZE_MAX).toBe(BATCH_SIZE_MAX);
	});

	it("copies the patterns", () => {
		expect(limits.OWNER_PATTERN.source).toBe(OWNER_PATTERN.source);
		expect(limits.OWNER_PATTERN.flags).toBe(OWNER_PATTERN.flags);
		expect(limits.UPLOAD_ID_PATTERN).toBe(UPLOAD_ID_PATTERN);
	});

	it("copies the lists, in order", () => {
		expect(limits.SOURCE_FORMATS).toEqual(SOURCE_FORMATS);
		expect(limits.APPLY_FIELD_TYPES).toEqual(APPLY_FIELD_TYPES);
		expect(limits.COMPATIBLE).toEqual(COMPATIBLE);
		expect(limits.RESERVED_FIELD_SLUGS).toEqual(EMDASH_RESERVED_FIELD_SLUGS);
	});

	it("copies the template grammar's defaults", () => {
		expect(limits.TRUE_TOKENS).toEqual(TRUE_TOKENS);
		expect(limits.FALSE_TOKENS).toEqual(FALSE_TOKENS);
		expect(limits.DEFAULT_SEPARATOR).toBe(DEFAULT_SEPARATOR);
		expect(limits.DEFAULT_HIERARCHY).toBe(DEFAULT_HIERARCHY);
	});

	it("copies the template grammar's caps, which the engine keeps inline", () => {
		const fits = (mapping: Record<string, unknown>) =>
			templateSchema.safeParse({
				version: 1,
				collection: "posts",
				locale: "en",
				key: { from: "id" },
				fields: { f: { from: "f", ...mapping } },
			}).success;
		const tokens = (count: number, length: number) =>
			Array.from({ length: count }, (_, i) => String(i).padStart(length, "x"));
		const { TOKENS_MAX, TOKEN_LENGTH_MAX, MAP_KEY_MAX } = limits;
		expect(fits({ type: "boolean", true: tokens(TOKENS_MAX, TOKEN_LENGTH_MAX) })).toBe(true);
		expect(fits({ type: "boolean", true: tokens(TOKENS_MAX + 1, 3) })).toBe(false);
		expect(fits({ type: "boolean", true: tokens(1, TOKEN_LENGTH_MAX + 1) })).toBe(false);
		expect(fits({ type: "select", map: { ["k".repeat(MAP_KEY_MAX)]: "v" } })).toBe(true);
		expect(fits({ type: "select", map: { ["k".repeat(MAP_KEY_MAX + 1)]: "v" } })).toBe(false);
	});

	it("shows at most 200 keys at once (Review Focus 4)", () => {
		expect(limits.KEYS_SHOWN).toBe(200);
	});

	it("copies the home's limits (M7b)", () => {
		expect(limits.TEMPLATE_BODY_MAX_BYTES).toBe(TEMPLATE_BODY_MAX_BYTES);
		expect(limits.TEMPLATE_BODY_MAX_BYTES).toBe(2_097_152);
		expect(limits.TEMPLATE_DESCRIPTION_MAX).toBe(TEMPLATE_DESCRIPTION_MAX);
		expect(limits.JOB_PAGE).toBe(JOB_PAGE);
		expect(limits.MAX_SCHEDULES).toBe(MAX_SCHEDULES);
		expect(limits.CREDENTIAL_NAME.source).toBe(CREDENTIAL_NAME.source);
		expect(limits.CREDENTIAL_NAME.flags).toBe(CREDENTIAL_NAME.flags);
		expect(limits.HEADER_NAME.source).toBe(HEADER_NAME.source);
		expect(limits.HEADER_NAME.flags).toBe(HEADER_NAME.flags);
	});

	it("pins SOURCE_NAME_MAX through the route's own schema, which keeps it inline (F8)", () => {
		const url = "https://feed.example.com/a.json";
		const create = routes["sources/create"]!.input!;
		const { SOURCE_NAME_MAX } = limits;
		expect(create.safeParse({ name: "x".repeat(SOURCE_NAME_MAX), url }).success).toBe(true);
		expect(create.safeParse({ name: "x".repeat(SOURCE_NAME_MAX + 1), url }).success).toBe(false);
	});

	it("has no SCHEDULE_BATCH_MAX: a schedule's batch size is BATCH_SIZE_MAX (F8)", () => {
		expect(limits).not.toHaveProperty("SCHEDULE_BATCH_MAX");
		const create = routes["schedules/create"]!.input!;
		const base = {
			name: "Nightly",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "0 3 * * *",
		};
		expect(create.safeParse({ ...base, batchSize: limits.BATCH_SIZE_MAX }).success).toBe(true);
		expect(create.safeParse({ ...base, batchSize: limits.BATCH_SIZE_MAX + 1 }).success).toBe(false);
	});
});
