import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/admin/api-error.js";
import {
	type PinUpdate,
	pinnedSchedules,
	pinUpdate,
	sourcePinChanged,
	updatePinned,
} from "../../src/admin/home/pinned/pinned.js";
import type { ScheduleView } from "../../src/plugin/schedules.js";

/** A schedule as `schedules/list` answers it (F25: built here, not from the home fixtures). */
function schedule(over: Partial<ScheduleView> & Pick<ScheduleView, "id" | "name">): ScheduleView {
	return {
		templateId: "T1",
		templateRevision: 3,
		sourceId: "SRC1",
		sourcePin: "pin",
		cron: "0 * * * *",
		publish: true,
		batchSize: 50,
		budgetMs: 4_000,
		enabled: true,
		runs: [],
		launchFailures: 0,
		armedBy: "U1",
		revision: 2,
		createdAt: "2026-11-20T10:00:00.000Z",
		updatedAt: "2026-11-20T10:00:00.000Z",
		createdBy: "U1",
		updatedBy: "U1",
		nextRunAt: "2026-11-24T11:00:00.000Z",
		...over,
	};
}

const s1 = schedule({ id: "S1", name: "Nightly" });
const s2 = schedule({ id: "S2", name: "Hourly", revision: 5 });
const s3 = schedule({
	id: "S3",
	name: "Weekly",
	enabled: false,
	nextRunAt: null,
	pause: { reason: "fetch_failed", at: "2026-11-23T10:00:00.000Z" },
});
const other = schedule({ id: "S4", name: "Elsewhere", templateId: "T2", sourceId: "SRC2" });
const all = [s1, s2, s3, other];

describe("pinnedSchedules (plan Ruling 14)", () => {
	it("pins every schedule of a template, enabled or not (Review Focus 4)", () => {
		expect(pinnedSchedules(all, { kind: "template", templateId: "T1" }).map((s) => s.id)).toEqual([
			"S1",
			"S2",
			"S3",
		]);
		expect(pinnedSchedules(all, { kind: "template", templateId: "T2" }).map((s) => s.id)).toEqual([
			"S4",
		]);
		expect(pinnedSchedules(all, { kind: "template", templateId: "T9" })).toEqual([]);
	});

	it("pins only the enabled schedules of a source (Review Focus 4)", () => {
		expect(pinnedSchedules(all, { kind: "source", sourceId: "SRC1" }).map((s) => s.id)).toEqual([
			"S1",
			"S2",
		]);
		expect(pinnedSchedules([s3], { kind: "source", sourceId: "SRC1" })).toEqual([]);
		expect(pinnedSchedules(all, { kind: "source", sourceId: "SRC2" }).map((s) => s.id)).toEqual([
			"S4",
		]);
	});
});

describe("sourcePinChanged (plan Ruling 14)", () => {
	it("sees a source pin change only for a new URL or credential", () => {
		expect(sourcePinChanged({ url: "https://a.example/x" }, { url: "https://a.example/x" })).toBe(
			false,
		);
		expect(sourcePinChanged({ url: "https://a.example/x" }, { credential: "feed-token" })).toBe(
			true,
		);
		expect(
			sourcePinChanged({ url: "https://a.example/x", credential: "k" }, { credential: null }),
		).toBe(true);
	});

	it("compares as the server does: a name-only edit, the same credential, no credential twice", () => {
		const row = { url: "https://a.example/x", credential: "k" };
		expect(sourcePinChanged(row, {})).toBe(false);
		expect(sourcePinChanged(row, { credential: "k" })).toBe(false);
		expect(sourcePinChanged(row, { url: "https://a.example/y" })).toBe(true);
		expect(sourcePinChanged({ url: "https://a.example/x" }, { credential: null })).toBe(false);
	});

	it("reads the URL as the server stores it (URL.href)", () => {
		expect(sourcePinChanged({ url: "https://a.example/x" }, { url: "HTTPS://A.Example/x" })).toBe(
			false,
		);
		expect(sourcePinChanged({ url: "https://a.example/" }, { url: "https://a.example" })).toBe(
			false,
		);
		// Not a URL: the save refuses it, and nothing here claims a change it cannot judge.
		expect(sourcePinChanged({ url: "https://a.example/x" }, { url: "not a url" })).toBe(true);
	});
});

describe("pinUpdate (plan Ruling 14)", () => {
	it("updates a template's schedules to the new revision, a source's with enabled true", () => {
		expect(pinUpdate(s1, { kind: "template", templateId: "T1" }, 4)).toEqual({
			id: "S1",
			revision: 2,
			templateId: "T1",
			templateRevision: 4,
		});
		expect(pinUpdate(s1, { kind: "source", sourceId: "SRC1" })).toEqual({
			id: "S1",
			revision: 2,
			enabled: true,
		});
	});

	it("refuses a template pin without the new revision", () => {
		expect(() => pinUpdate(s1, { kind: "template", templateId: "T1" })).toThrow(/revision/);
	});
});

describe("updatePinned (plan Ruling 14)", () => {
	it("updates one at a time and names each failure, going on after it (Review Focus 4)", async () => {
		const busy = new ApiError("SCHEDULE_BUSY", "Schedule S2 is busy with job J1", 409, {
			jobId: "J1",
		});
		const calls: PinUpdate[] = [];
		let open = 0;
		let overlapped = false;
		const update = async (i: PinUpdate) => {
			if (open > 0) overlapped = true;
			open++;
			calls.push(i);
			await new Promise((resolve) => setTimeout(resolve, 1));
			open--;
			if (i.id === "S2") throw busy;
			return { schedule: {} };
		};
		const result = await updatePinned(
			[s1, s2, s3],
			{ kind: "template", templateId: "T1" },
			4,
			update,
		);
		expect(overlapped).toBe(false);
		expect(calls).toEqual([
			{ id: "S1", revision: 2, templateId: "T1", templateRevision: 4 },
			{ id: "S2", revision: 5, templateId: "T1", templateRevision: 4 },
			{ id: "S3", revision: 2, templateId: "T1", templateRevision: 4 },
		]);
		expect(result).toEqual({ updated: ["S1", "S3"], failed: [{ name: "Hourly", error: busy }] });
	});

	it("re-pins a source's schedules with enabled true and does nothing without rows", async () => {
		const calls: PinUpdate[] = [];
		const update = async (i: PinUpdate) => {
			calls.push(i);
		};
		expect(
			await updatePinned([s1], { kind: "source", sourceId: "SRC1" }, undefined, update),
		).toEqual({ updated: ["S1"], failed: [] });
		expect(calls).toEqual([{ id: "S1", revision: 2, enabled: true }]);
		expect(await updatePinned([], { kind: "source", sourceId: "SRC1" }, undefined, update)).toEqual(
			{ updated: [], failed: [] },
		);
		expect(calls).toHaveLength(1);
	});

	it("names a failure that is not an Error too, and an update that throws synchronously", async () => {
		const result = await updatePinned([s1, s2], { kind: "template", templateId: "T1" }, 4, (i) => {
			if (i.id === "S1") throw new TypeError("Failed to fetch");
			return Promise.reject("nope");
		});
		expect(result.updated).toEqual([]);
		expect(result.failed.map((f) => f.name)).toEqual(["Nightly", "Hourly"]);
		expect(result.failed[0]?.error).toBeInstanceOf(TypeError);
		expect(result.failed[1]?.error).toBe("nope");
	});
});
