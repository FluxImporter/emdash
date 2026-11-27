import { describe, expect, it } from "vitest";
import { COUNTS } from "../../src/admin/ui/messages.js";
import { appendLog, LOG_MAX, type LogEntry, logEvents } from "../../src/admin/wizard/run/log.js";
import { COUNT, LOG } from "../../src/admin/wizard/run/messages.js";
import type { Counters, Job } from "../../src/engine/types.js";
import { job } from "../admin/fixtures.js";

const ZERO: Counters = {
	created: 0,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
};

const at = (counters: Partial<Counters>, over: Partial<Job> = {}): Job =>
	job({ status: "running", counters: { ...ZERO, ...counters }, ...over });

describe("logEvents", () => {
	it("starts with Started for a new job, and with nothing for one reopened part way", () => {
		expect(logEvents(null, at({}))).toEqual([{ tone: "subtle", parts: [{ msg: LOG.started }] }]);
		expect(logEvents(null, at({ created: 3 }))).toEqual([]);
	});

	it("says what a batch read, then its problems and its warnings on lines of their own", () => {
		const prev = at({ created: 10, failed: 1 }, { warned: 1 });
		const next = at({ created: 50, updated: 5, failed: 4, conflict: 1 }, { warned: 3 });
		expect(logEvents(prev, next)).toEqual([
			{
				tone: "default",
				parts: [
					{ plural: COUNT.logRecords, count: 49 },
					{ plural: COUNTS.created, count: 40 },
					{ plural: COUNTS.updated, count: 5 },
				],
			},
			{
				tone: "danger",
				parts: [
					{ plural: COUNTS.failed, count: 3 },
					{ plural: COUNTS.conflict, count: 1 },
				],
			},
			{ tone: "warning", parts: [{ plural: COUNT.logWarned, count: 2 }] },
		]);
	});

	it("says nothing for a reply that changed nothing", () => {
		const same = at({ created: 5 });
		expect(logEvents(same, { ...same, updatedAt: "2026-11-27T10:00:00.000Z" })).toEqual([]);
	});

	it("names the retry pass and the missing phase, new job warnings, and the end", () => {
		const prev = at({ created: 4, failed: 1 }, { warnings: ["old"] });
		expect(
			logEvents(prev, at({ created: 5 }, { phase: "retry", warnings: ["old", "new one"] })),
		).toEqual([
			{ tone: "subtle", parts: [{ msg: LOG.retry }] },
			{
				tone: "default",
				parts: [
					{ plural: COUNT.logRecords, count: 1 },
					{ plural: COUNTS.created, count: 1 },
				],
			},
			{ tone: "warning", parts: [{ msg: LOG.jobWarning }], detail: "new one" },
		]);
		expect(logEvents(prev, { ...prev, phase: "missing" })).toEqual([
			{ tone: "subtle", parts: [{ msg: LOG.missing }] },
		]);
		expect(logEvents(prev, { ...prev, status: "completed" })).toEqual([
			{ tone: "subtle", parts: [{ msg: LOG.completed }] },
		]);
		const paused = { ...prev, status: "paused" as const };
		expect(logEvents(prev, paused)).toEqual([{ tone: "subtle", parts: [{ msg: LOG.paused }] }]);
		expect(logEvents(paused, prev)).toEqual([{ tone: "subtle", parts: [{ msg: LOG.resumed }] }]);
	});

	it("says why a job failed, without an upload ID in it", () => {
		const prev = at({ created: 1 });
		const failed = logEvents(prev, {
			...prev,
			status: "failed",
			error: { code: "source_missing", message: "upload u-123 is gone" },
		});
		expect(failed).toHaveLength(1);
		expect(failed[0]?.tone).toBe("danger");
		expect(JSON.stringify(failed)).not.toContain("u-123");
		expect(logEvents(prev, { ...prev, status: "failed", error: null })).toEqual([
			{ tone: "danger", parts: [{ msg: LOG.failed }] },
		]);
	});
});

describe("appendLog", () => {
	it("puts the newest lines first, stamped with the reply's time, and keeps LOG_MAX", () => {
		let id = 0;
		const nextId = () => ++id;
		let log: readonly LogEntry[] = [];
		let prev: Job | null = null;
		for (let i = 0; i <= LOG_MAX + 5; i++) {
			const next = at({ created: i }, { updatedAt: `t${i}` });
			log = appendLog(log, prev, next, nextId);
			prev = next;
		}
		expect(log).toHaveLength(LOG_MAX);
		expect(log[0]).toMatchObject({ at: `t${LOG_MAX + 5}`, tone: "default" });
		const unchanged = appendLog(log, prev, prev as Job, nextId);
		expect(unchanged).toBe(log);
	});
});
