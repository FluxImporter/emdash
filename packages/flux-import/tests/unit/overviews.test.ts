import { describe, expect, it } from "vitest";
import { STORAGE } from "../../src/plugin/definition.js";
import {
	RUNS_SHOWN,
	scheduleSummary,
	schedulesOverview,
	sourceSummary,
	sourcesOverview,
} from "../../src/plugin/overviews.js";
import { toRouteError } from "../../src/plugin/routes.js";
import type { RunEntry, ScheduleRow } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv } from "./fakes.js";
import { FakeCron, scheduleRow, sourceRow } from "./schedule-fakes.js";

const AT = "2026-11-19T10:00:00.000Z";

/** Every string in a value, keys included. */
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
	}
	return [];
}

const run = (jobId: string): RunEntry => ({
	jobId,
	at: AT,
	outcome: "completed",
	counters: { created: 1, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0, removed: 0 },
});

describe("sources/overview (spec Ruling 38)", () => {
	const full = sourceRow("S1", {
		url: "https://User-Feeds.Example:8443/s3cr3t-path/feed.csv?q=t0ken#frag-x",
		credential: "cred-name",
		lastFetch: {
			at: AT,
			status: 200,
			etag: "etag-x",
			lastModified: "lm-x",
			sha256: "sha-x",
			bytes: 42,
			uploadId: "UPLOADMARK",
		},
		lastError: { at: AT, code: "HTTP_ERROR", message: "msg-x" },
		lastImport: { sha256: "sha-x", uploadId: "UPLOADMARK", jobId: "JOBMARK", at: AT },
		createdAt: AT,
		updatedAt: AT,
	});

	it("shows only the host of a source, a credential flag and codes", () => {
		expect(sourceSummary(full)).toEqual({
			id: "S1",
			name: "S1",
			host: "user-feeds.example",
			credential: true,
			lastFetch: { at: AT, status: 200, bytes: 42 },
			lastError: { at: AT, code: "HTTP_ERROR" },
			createdAt: AT,
			updatedAt: AT,
		});
		const seen = strings(sourceSummary(full)).join("\n");
		for (const marker of [
			"s3cr3t",
			"t0ken",
			"frag-x",
			"8443",
			"cred-name",
			"msg-x",
			"UPLOADMARK",
			"etag-x",
			"lm-x",
			"sha-x",
			"JOBMARK",
			"lastImport",
			"message",
		]) {
			expect(seen, marker).not.toContain(marker);
		}
	});

	it("gives an empty host for a URL that does not parse, and no flag without a credential", () => {
		expect(sourceSummary(sourceRow("S2", { url: "::" }))).toMatchObject({
			host: "",
			credential: false,
		});
		expect(sourceSummary(sourceRow("S3"))).not.toHaveProperty("lastFetch");
	});

	it("pages 50 sources newest first, as sources/list", async () => {
		const sources = new MemoryKv<SourceRow>(STORAGE.sources.indexes);
		for (let i = 0; i < 51; i++) {
			const at = new Date(Date.parse(AT) + i * 1000).toISOString();
			await sources.put(`S${i}`, sourceRow(`S${i}`, { createdAt: at, updatedAt: at }));
		}
		const first = await sourcesOverview({ sources });
		expect(first.items).toHaveLength(50);
		expect(first.items[0]?.id).toBe("S50");
		expect(first.hasMore).toBe(true);
		const second = await sourcesOverview({ sources }, first.cursor);
		expect(second.items.map((s) => s.id)).toEqual(["S0"]);
	});
});

describe("schedules/overview (spec Rulings 39, 65)", () => {
	const row = (id: string, extra: Partial<ScheduleRow> = {}) => scheduleRow(id, extra);

	it("leaves out user IDs, sourcePin, claimedAt and due.force, and keeps the newest five runs", () => {
		const runs = Array.from({ length: 7 }, (_, i) => run(`J${i}`));
		runs[1] = { ...run("J1"), rolledBack: { by: "JR", at: AT } };
		const view = {
			...row("SC1", {
				sourcePin: "PINMARK",
				armedBy: "USERA",
				createdBy: "USERB",
				updatedBy: "USERC",
				due: { at: AT, force: true },
				current: { jobId: "J9", claimedAt: "CLAIMMARK" },
				pause: { reason: "cancelled", at: AT, jobId: "J8" },
				lastLaunch: { at: AT, outcome: "failed", errorCode: "FETCH_FAILED" },
				missing: { maxPercent: 10 },
				launchFailures: 2,
				runs,
			}),
			nextRunAt: "2026-11-20T03:00:00.000Z",
		};
		const summary = scheduleSummary(view);
		expect(summary).toEqual({
			id: "SC1",
			name: "SC1",
			templateId: "T1",
			templateRevision: 1,
			sourceId: "S1",
			cron: "0 3 * * *",
			enabled: true,
			publish: true,
			batchSize: 50,
			budgetMs: 4000,
			missing: { maxPercent: 10 },
			pause: { reason: "cancelled", at: AT, jobId: "J8" },
			due: true,
			runningJobId: "J9",
			lastLaunch: { at: AT, outcome: "failed", errorCode: "FETCH_FAILED" },
			runs: runs.slice(0, RUNS_SHOWN),
			runCount: 7,
			launchFailures: 2,
			nextRunAt: "2026-11-20T03:00:00.000Z",
			revision: 1,
			createdAt: view.createdAt,
			updatedAt: view.updatedAt,
		});
		const seen = strings(summary).join("\n");
		for (const marker of [
			"PINMARK",
			"USERA",
			"USERB",
			"USERC",
			"CLAIMMARK",
			"sourcePin",
			"armedBy",
			"createdBy",
			"updatedBy",
			"claimedAt",
			"force",
		]) {
			expect(seen, marker).not.toContain(marker);
		}
	});

	it("shows a schedule without a pause, due mark or launch claim without those keys", () => {
		const summary = scheduleSummary({ ...row("SC2"), nextRunAt: null });
		expect(summary).toMatchObject({ due: false, runs: [], runCount: 0, nextRunAt: null });
		for (const key of ["pause", "runningJobId", "lastLaunch", "missing"]) {
			expect(summary).not.toHaveProperty(key);
		}
	});

	it("puts 20 schedules on one page, reads the cron tasks once and changes none", async () => {
		const schedules = new MemoryKv<ScheduleRow>(STORAGE.schedules.indexes);
		for (let i = 0; i < 20; i++) await schedules.put(`SC${i}`, row(`SC${i}`));
		const cron = new FakeCron();
		let lists = 0;
		const counted = {
			...cron,
			list: () => {
				lists++;
				return cron.list();
			},
			schedule: cron.schedule.bind(cron),
			cancel: cron.cancel.bind(cron),
		};
		const page = await schedulesOverview({ schedules, cron: counted as never });
		expect(page.items).toHaveLength(20);
		expect(page).toEqual({ items: page.items, hasMore: false });
		expect(lists).toBe(1);
		expect(cron.calls).toEqual([]);
	});

	it("refuses a cursor it did not issue with INVALID_CURSOR", async () => {
		const schedules = new MemoryKv<ScheduleRow>(STORAGE.schedules.indexes);
		const error = await schedulesOverview({ schedules, cron: new FakeCron() }, "bogus").catch(
			(e: unknown) => toRouteError(e),
		);
		expect(error).toMatchObject({ code: "INVALID_CURSOR", status: 400 });
	});
});
