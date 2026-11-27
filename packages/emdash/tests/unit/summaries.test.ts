import { describe, expect, it } from "vitest";
import type { Job, RecordRow } from "../../src/engine/types.js";
import {
	cut,
	INTERNAL_JOB_MESSAGE,
	INTERNAL_RECORD_MESSAGE,
	RETRY_AFTER_ERROR_MS,
	redact,
	STAGED_FILE,
	STEP_REPLY_MAX_BYTES,
	step,
	summarize,
	summarizeRecord,
} from "../../src/plugin/summaries.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
/** A well-formed upload ID: a ULID and 32 hex characters (src/emdash/uploads.ts:17). */
const UPLOAD = `01JZ5V6Q8X0000000000000000${"ab".repeat(16)}`;

function job(extra: Partial<Job> = {}): Job {
	return {
		id: "J1",
		status: "running",
		origin: "agent",
		uploadId: UPLOAD,
		sourceUploadId: UPLOAD,
		sourceId: "S1",
		template: {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
			source: { format: "csv" },
		} as Job["template"],
		dryRun: true,
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		targetFields: {},
		taxonomies: {},
		plannedTerms: [],
		deferred: { seq: 1, newTerms: [], newMedia: [] },
		cursor: { offset: 100, seq: 7 },
		counters: {
			created: 0,
			updated: 2,
			unchanged: 3,
			locked: 0,
			conflict: 0,
			failed: 1,
			filtered: 1,
		},
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: true,
		error: null,
		failures: 0,
		createdAt: "2026-11-16T11:00:00.000Z",
		updatedAt: "2026-11-16T11:30:00.000Z",
		...extra,
	};
}

const FORBIDDEN = [
	"template",
	"targetFields",
	"taxonomies",
	"plannedTerms",
	"deferred",
	"lease",
	"uploadId",
	"sourceUploadId",
	"sourceId",
	"cursor",
];

function keysDeep(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
}

describe("summarize (M6c)", () => {
	it("summarizes an agent dry run with every counter and no job internals", () => {
		const summary = summarize(
			job({ origin: "agent", templateId: "T1", templateRevision: 3, startedAs: "J2" }),
			NOW,
		);
		expect(summary).toEqual({
			id: "J1",
			kind: "import",
			status: "running",
			dryRun: true,
			phase: "import",
			origin: "agent",
			collection: "products",
			locale: "en",
			templateId: "T1",
			templateRevision: 3,
			startedAs: "J2",
			publish: true,
			missing: null,
			processed: 7,
			counters: {
				created: 0,
				updated: 2,
				unchanged: 3,
				locked: 0,
				conflict: 0,
				failed: 1,
				filtered: 1,
				reverted: 0,
				removed: 0,
			},
			error: null,
			warnings: [],
			warningCount: 0,
			next: "next_batch",
			createdAt: "2026-11-16T11:00:00.000Z",
			updatedAt: "2026-11-16T11:30:00.000Z",
		});
		for (const s of [summary, step(job(), NOW)]) {
			expect(keysDeep(s).filter((k) => FORBIDDEN.includes(k))).toEqual([]);
		}
	});

	it("defaults the counters of a job created before M3a to 0", () => {
		const old = job({ counters: { created: 4 } as Job["counters"] });
		expect(summarize(old, NOW).counters).toEqual({
			created: 4,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
			reverted: 0,
			removed: 0,
		});
	});

	it("counts a rollback job's rows as processed, and shows the missing phase of an import", () => {
		const rollback = job({
			kind: "rollback",
			rollbackOf: "J0",
			dryRun: false,
			counters: { ...job().counters, failed: 1, reverted: 3 },
		});
		expect(summarize(rollback, NOW)).toMatchObject({
			kind: "rollback",
			rollbackOf: "J0",
			processed: 10,
		});
		const missing = job({
			dryRun: false,
			phase: "missing",
			missingLimit: { maxPercent: 25 },
			missing: { stage: "act", fromSeq: 20, owned: 30, found: 4, rows: 2, removed: 2 },
		});
		expect(summarize(missing, NOW)).toMatchObject({
			missing: { maxPercent: 25 },
			missingPhase: { stage: "act", owned: 30, found: 4, removed: 2 },
		});
		expect(step(missing, NOW).total).toBe(20);
	});

	/** A job the agent routes did not create: REST's `jobs/create`, or any rollback. */
	function restJob(extra: Partial<Job> = {}): Job {
		const { origin: _origin, ...rest } = job(extra);
		return rest;
	}

	it.each([
		["a created job", job({ status: "created" }), { next: "next_batch" }],
		[
			"an expired lease",
			job({ lease: { holder: "u:1", expiresAt: NOW - 1 } }),
			{ next: "next_batch" },
		],
		[
			"a live lease",
			job({ lease: { holder: "u:1", expiresAt: NOW + 10_000 } }),
			{ next: "wait", busyUntil: "2026-11-16T12:00:10.000Z", retryAfterMs: 10_000 },
		],
		[
			"a lease about to end",
			job({ lease: { holder: "u:1", expiresAt: NOW + 200 } }),
			{ next: "wait", retryAfterMs: 1_000 },
		],
		[
			"a long lease",
			job({ lease: { holder: "u:1", expiresAt: NOW + 60_000 } }),
			{ next: "wait", retryAfterMs: 30_000 },
		],
		[
			"an unexpected batch error",
			job({ error: { code: "internal", message: "boom" }, failures: 1 }),
			{ next: "next_batch", retryAfterMs: RETRY_AFTER_ERROR_MS },
		],
		["a completed job", job({ status: "completed" }), { next: "done" }],
		["a paused job", job({ status: "paused" }), { next: "stopped" }],
		["a failed job", job({ status: "failed" }), { next: "stopped" }],
		["a cancelled job", job({ status: "cancelled" }), { next: "stopped" }],
		["a REST job", restJob(), { next: "not_agent" }],
		[
			"a REST job holding a lease",
			restJob({ lease: { holder: "u:1", expiresAt: NOW + 10_000 } }),
			{ next: "not_agent" },
		],
		[
			"a rollback job after an error",
			restJob({ kind: "rollback", error: { code: "internal", message: "boom" } }),
			{ next: "not_agent" },
		],
		["a completed REST job", restJob({ status: "completed" }), { next: "done" }],
		["a paused REST job", restJob({ status: "paused" }), { next: "stopped" }],
	])("advises on %s", (_name, input, advice) => {
		const summary = summarize(input, NOW);
		expect(summary).toMatchObject(advice);
		if (!("retryAfterMs" in advice)) expect(summary).not.toHaveProperty("retryAfterMs");
		if (!("busyUntil" in advice) && advice.next !== "wait") {
			expect(summary).not.toHaveProperty("busyUntil");
		}
		expect(step(input, NOW)).toMatchObject(advice);
	});

	it("shows the first 10 warnings, each cut to 300 characters, and counts them all", () => {
		const warnings = ["w".repeat(301), ...Array.from({ length: 10 }, (_, i) => `w${i}`)];
		const summary = summarize(job({ warnings }), NOW);
		expect(summary.warnings).toHaveLength(10);
		expect(summary.warnings[0]).toBe(`${"w".repeat(300)}…`);
		expect(summary.warnings[9]).toBe("w8");
		expect(summary.warningCount).toBe(11);
	});
});

describe("step (M6c)", () => {
	it("has exactly the StepReply keys, with total only once the import pass is done", () => {
		const running = step(job(), NOW);
		expect(Object.keys(running)).toEqual(["id", "status", "next", "processed"]);
		const done = step(job({ status: "completed", error: { code: "x", message: "m" } }), NOW);
		expect(done).toEqual({
			id: "J1",
			status: "completed",
			next: "done",
			processed: 7,
			total: 7,
			error: { code: "x", message: "m" },
		});
		const busy = step(job({ lease: { holder: "u:1", expiresAt: NOW + 5_000 } }), NOW);
		expect(Object.keys(busy)).toEqual([
			"id",
			"status",
			"next",
			"processed",
			"busyUntil",
			"retryAfterMs",
		]);
	});

	/** Every optional key at its longest: a live lease, a total and an error. */
	const worst = (message: string, extra: Partial<Job> = {}) =>
		step(
			job({
				status: "cancelled",
				phase: "missing",
				missing: { stage: "act", fromSeq: 1, owned: 0, found: 0, rows: 0, removed: 0 },
				lease: { holder: "u:1", expiresAt: NOW + 60_000 },
				error: { code: "source_missing", message },
				...extra,
			}),
			NOW,
		);
	const size = (reply: unknown) => new TextEncoder().encode(JSON.stringify(reply)).length;

	it.each([
		["ASCII", "x".repeat(400)],
		["emoji", "😀".repeat(400)],
		["control characters", "\u0001".repeat(400)],
		["lone surrogates", "\ud800".repeat(400)],
		["quotes and backslashes", '"\\'.repeat(200)],
	])("keeps a reply with a long %s message within 400 bytes, ending in …", (_name, message) => {
		for (const extra of [
			{},
			{
				id: "01JZ5V6Q8X0000000000000000",
				status: "running" as const,
				missing: {
					stage: "act" as const,
					fromSeq: Number.MAX_SAFE_INTEGER,
					owned: 0,
					found: 0,
					rows: 0,
					removed: 0,
				},
				cursor: { offset: 0, seq: Number.MAX_SAFE_INTEGER },
			},
		]) {
			const reply = worst(message, extra);
			expect(size(reply)).toBeLessThanOrEqual(STEP_REPLY_MAX_BYTES);
			expect(reply.error?.message.endsWith("…")).toBe(true);
			// The longest prefix that fits: one code point more would not.
			const longer = Array.from(message)
				.slice(0, Array.from(reply.error?.message ?? "").length)
				.join("");
			const grown = { ...reply, error: { code: "source_missing", message: `${longer}…` } };
			expect(size(grown)).toBeGreaterThan(STEP_REPLY_MAX_BYTES);
		}
	});

	it("keeps a message that fits whole, and the 300-point cut of one that fits after it", () => {
		expect(worst("Upload missing").error?.message).toBe("Upload missing");
		const fits = "x".repeat(150);
		expect(worst(fits).error?.message).toBe(fits);
		// A message that fills the reply to exactly 400 bytes is kept whole; one byte more is cut.
		const exact = "x".repeat(STEP_REPLY_MAX_BYTES - size(worst("")));
		expect(worst(exact).error?.message).toBe(exact);
		expect(size(worst(exact))).toBe(STEP_REPLY_MAX_BYTES);
		expect(worst(`${exact}x`).error?.message).toMatch(/x…$/);
	});
});

describe("redaction (spec Ruling 33)", () => {
	it("replaces upload keys and bare upload IDs", () => {
		expect(redact(`Upload ${UPLOAD} not found`)).toBe(`Upload ${STAGED_FILE} not found`);
		expect(redact(`read fluximporter-upload-${UPLOAD}.csv failed`)).toBe(
			`read ${STAGED_FILE} failed`,
		);
		expect(redact("no IDs here")).toBe("no IDs here");
	});

	it("redacts a source_missing job error, a warning and a record error", () => {
		const summary = summarize(
			job({
				error: { code: "source_missing", message: `Upload ${UPLOAD} not found` },
				warnings: [`Converted from fluximporter-upload-${UPLOAD}.csv`],
			}),
			NOW,
		);
		expect(summary.error).toEqual({
			code: "source_missing",
			message: `Upload ${STAGED_FILE} not found`,
		});
		expect(summary.warnings).toEqual([`Converted from ${STAGED_FILE}`]);
		const record = summarizeRecord(
			row({ errors: [{ code: "media_failed", message: `bad ${UPLOAD}` }] }),
			"import",
		);
		expect(record.errors).toEqual([{ code: "media_failed", message: `bad ${STAGED_FILE}` }]);
		const texts = JSON.stringify([summary, record, step(job(), NOW)]);
		expect(texts).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}/);
	});

	it("redacts a record's source key, value previews, terms and media", () => {
		const record = summarizeRecord(
			row({
				sourceKey: `K-${UPLOAD}`,
				changes: [
					{ field: "file", before: null, after: { key: `fluximporter-upload-${UPLOAD}.csv` } },
				],
				newTerms: [`tags: ${UPLOAD}`],
				newMedia: [
					`image: https://x.test/_emdash/api/media/file/fluximporter-upload-${UPLOAD}.csv`,
				],
			}),
			"import",
		);
		expect(record).toMatchObject({
			sourceKey: `K-${STAGED_FILE}`,
			changes: [{ field: "file", value: `{"key":"${STAGED_FILE}"}` }],
			newTerms: [`tags: ${STAGED_FILE}`],
			newMedia: [`image: https://x.test/_emdash/api/media/file/${STAGED_FILE}`],
		});
	});

	it("redacts change fields, error fields and error codes", () => {
		const record = summarizeRecord(
			row({
				changes: [{ field: `f-${UPLOAD}`, before: null, after: 1 }],
				errors: [{ field: `f-${UPLOAD}`, code: `c-${UPLOAD}`, message: "m" }],
			}),
			"import",
		);
		expect(record.changes).toEqual([{ field: `f-${STAGED_FILE}`, value: "1" }]);
		expect(record.errors).toEqual([
			{ field: `f-${STAGED_FILE}`, code: `c-${STAGED_FILE}`, message: "m" },
		]);
		const error = { code: `c-${UPLOAD}`, message: "m" };
		expect(summarize(job({ error }), NOW).error?.code).toBe(`c-${STAGED_FILE}`);
		expect(step(job({ error }), NOW).error?.code).toBe(`c-${STAGED_FILE}`);
	});

	it("leaves text without an upload ID as it is, even a literal placeholder key", () => {
		const text = `fluximporter-upload-${STAGED_FILE}.csv`;
		expect(redact(text)).toBe(text);
	});

	it("replaces an unexpected error's raw message", () => {
		const error = { code: "internal", message: "SQLITE_ERROR near ec_products at /srv/x.js:1" };
		expect(summarize(job({ error }), NOW).error).toEqual({
			code: "internal",
			message: INTERNAL_JOB_MESSAGE,
		});
		expect(step(job({ error }), NOW).error?.message).toBe(INTERNAL_JOB_MESSAGE);
		const record = summarizeRecord(row({ errors: [{ field: "title", ...error }] }), "import");
		expect(record.errors).toEqual([
			{ field: "title", code: "internal", message: INTERNAL_RECORD_MESSAGE },
		]);
	});

	it("redacts before it cuts, so no prefix of an upload ID survives (Review Focus 1)", () => {
		const warning = `${"x".repeat(290)}${UPLOAD}`;
		const [shown] = summarize(job({ warnings: [warning] }), NOW).warnings;
		expect(shown).toBe(`${"x".repeat(290)}${STAGED_FILE.slice(0, 10)}…`);
		expect(shown).not.toContain(UPLOAD.slice(0, 10));
	});

	/** A second ID whose ULID ends in a letter and whose hex starts with digits. */
	const OTHER = `01JZ5V6QAXKM3T7RBCDEFGHJKM${"0123456789abcdef".repeat(2)}`;
	/** Every 6-character window of an ID that a redacted text still holds. */
	const fragments = (text: string, id: string) =>
		Array.from({ length: id.length - 5 }, (_, i) => id.slice(i, i + 6)).filter((w) =>
			text.includes(w),
		);

	it.each([
		["Crockford characters before it", (id: string) => `key ABC${id} end`],
		["digits before it (a %2F escape)", (id: string) => `file%2F${id} end`],
		["hex characters after it", (id: string) => `id ${id}abc end`],
		["a word glued to both ends", (id: string) => `XYZ${id}ffff end`],
		["two IDs back to back", (id: string) => `${id}${OTHER}${UPLOAD} end`],
		[
			"the key in a media URL",
			(id: string) => `/_emdash/api/media/file/${"fluximporter-upload-"}${id}.csv`,
		],
		["the key URL-encoded", (id: string) => encodeURIComponent(`fluximporter-upload-${id}.csv`)],
		["the key after an encoded slash", (id: string) => `%2Ffluximporter-upload-${id}.csv?x=1`],
		["the key in upper case", (id: string) => `FLUXIMPORTER-UPLOAD-${id}.CSV`],
		["the key with its ID run on", (id: string) => `fluximporter-upload-ABC${id}.csv`],
	])("leaves no fragment of an ID with %s", (_name, make) => {
		for (const id of [UPLOAD, OTHER]) {
			const out = redact(make(id));
			expect(out).toContain(STAGED_FILE);
			expect(fragments(out, id)).toEqual([]);
			expect(out).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}/);
		}
	});

	it("redacts a whole upload key, with or without an extension, and keeps the text around it", () => {
		expect(redact(`a fluximporter-upload-${UPLOAD} b`)).toBe(`a ${STAGED_FILE} b`);
		expect(redact(`FLUXIMPORTER-UPLOAD-${UPLOAD}.CSV.`)).toBe(`${STAGED_FILE}.`);
		expect(redact(`%2Ffluximporter-upload-${UPLOAD}.csv?x=1`)).toBe(`%2F${STAGED_FILE}?x=1`);
		expect(redact(`key ABC${UPLOAD} end`)).toBe(`key ${STAGED_FILE} end`);
		expect(redact(`${UPLOAD}, ${OTHER}`)).toBe(`${STAGED_FILE}, ${STAGED_FILE}`);
		expect(redact(`${UPLOAD}${OTHER}`)).toBe(STAGED_FILE);
	});

	it("redacts in linear time, even on a long run of the ID's alphabet", () => {
		const started = performance.now();
		for (const text of ["0".repeat(200_000), "A".repeat(200_000), "A0".repeat(100_000)]) {
			redact(text);
		}
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("cuts by code point, never inside a surrogate pair", () => {
		expect(cut("ab😀c", 3)).toBe("ab😀…");
		expect(cut("abc", 3)).toBe("abc");
	});
});

function row(extra: Partial<RecordRow> = {}): RecordRow {
	return {
		jobId: "J1",
		seq: 3,
		start: 10,
		end: 20,
		status: "planned",
		sourceKey: "SKU-3",
		entryId: "E3",
		action: "update",
		updatedAt: "2026-11-16T11:30:00.000Z",
		...extra,
	};
}

describe("summarizeRecord (M6c)", () => {
	it("shows the first 20 changes by their mapped value only, never the entry's value", () => {
		const changes = Array.from({ length: 21 }, (_, i) => ({
			field: `f${i}`,
			before: `DRAFT-SECRET-${i}`,
			after: i,
		}));
		const summary = summarizeRecord(row({ changes }), "import");
		expect(summary.changes).toHaveLength(20);
		expect(summary.changes[0]).toEqual({ field: "f0", value: "0" });
		expect(summary.changeCount).toBe(21);
		expect(JSON.stringify(summary)).not.toContain("DRAFT-SECRET");
		expect(summary).toMatchObject({
			seq: 3,
			status: "planned",
			action: "update",
			sourceKey: "SKU-3",
			entryId: "E3",
			errorCount: 0,
			warningCount: 0,
			newTerms: [],
			newMedia: [],
		});
	});

	it("previews a value to 200 characters, by code point, and marks a missing one", () => {
		const preview = (after: unknown) =>
			summarizeRecord(row({ changes: [{ field: "f", before: null, after } as never] }), undefined)
				.changes[0]?.value;
		// JSON.stringify adds the two quotes: 198 letters are 200 characters.
		expect(preview("a".repeat(198))).toBe(`"${"a".repeat(198)}"`);
		expect(preview("a".repeat(199))).toBe(`"${"a".repeat(199)}…`);
		// UTF-16 slicing at 200 would split the emoji here.
		expect(preview(`${"a".repeat(198)}😀b`)).toBe(`"${"a".repeat(198)}😀…`);
		expect(preview(undefined)).toBe("(none)");
		expect(preview(null)).toBe("null");
	});

	it("shows a rollback's changed fields without values, its after being the entry's old draft", () => {
		const changes = [
			{ field: "title", before: "Imported", after: "DRAFT-SECRET title" },
			{ field: "body", before: null, after: { text: "DRAFT-SECRET body" } },
			{ field: `f-${UPLOAD}`, before: null, after: "DRAFT-SECRET f" },
		];
		const summary = summarizeRecord(
			row({ status: "reverted", action: "revert", changes }),
			"rollback",
		);
		expect(summary.changes).toEqual([
			{ field: "title" },
			{ field: "body" },
			{ field: `f-${STAGED_FILE}` },
		]);
		expect(summary.changeCount).toBe(3);
		expect(JSON.stringify(summary)).not.toContain("DRAFT-SECRET");
		expect(summarizeRecord(row({ changes }), "import").changes[0]).toEqual({
			field: "title",
			value: '"DRAFT-SECRET title"',
		});
	});

	it("shows 5 errors, terms and media and counts the rest", () => {
		const errors = Array.from({ length: 6 }, (_, i) => ({ code: "c", message: `m${i}` }));
		const names = (n: number) => Array.from({ length: n }, (_, i) => `tags: t${i}`);
		const summary = summarizeRecord(
			row({
				status: "failed",
				errors,
				warnings: [{ code: "w", message: "w" }],
				newTerms: names(6),
				newMedia: names(5),
			}),
			"import",
		);
		expect(summary.errors).toHaveLength(5);
		expect(summary).toMatchObject({ errorCount: 6, warningCount: 1 });
		expect(summary.newTerms).toEqual(names(5));
		expect(summary.newMedia).toEqual(names(5));
	});
});
