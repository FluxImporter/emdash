import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../src/admin/errors.js";
import {
	describeTiming,
	fromCron,
	launchMessage,
	PAUSE_MESSAGES,
	pauseMessage,
	type Timing,
	toCron,
	utcLabel,
} from "../../src/admin/home/schedules/cron.js";
import { interpolate, type Msg, type Values } from "../../src/admin/i18n.js";
import type { PauseReason } from "../../src/plugin/schedules.js";

const say = (d: { msg: Msg; values: Values }) => interpolate(d.msg.message, d.values);

describe("toCron and fromCron (plan Ruling 13)", () => {
	it.each([
		[{ kind: "hourly", minute: 5 }, "5 * * * *"],
		[{ kind: "daily", hour: 6, minute: 0 }, "0 6 * * *"],
		[{ kind: "weekly", day: 1, hour: 6, minute: 30 }, "30 6 * * 1"],
		[{ kind: "hourly", minute: 59 }, "59 * * * *"],
		[{ kind: "daily", hour: 23, minute: 59 }, "59 23 * * *"],
		[{ kind: "weekly", day: 0, hour: 0, minute: 0 }, "0 0 * * 0"],
		[{ kind: "weekly", day: 6, hour: 12, minute: 15 }, "15 12 * * 6"],
	])("writes %j as %s and reads it back", (t, cron) => {
		expect(toCron(t as Timing)).toBe(cron);
		expect(fromCron(cron)).toEqual(t);
	});

	it("writes a custom expression as it is", () => {
		expect(toCron({ kind: "custom", cron: "*/15 * * * *" })).toBe("*/15 * * * *");
	});

	it.each([
		"@daily",
		"0 6 * * 1-5",
		"*/15 * * * *",
		"00 6 * * *",
		"0 24 * * *",
		"0 6 1 * *",
		"60 * * * *",
		"05 * * * *",
		"0 6 * * 7",
		"0 06 * * 1",
		"0 6 * * 01",
		"0  6 * * *",
		" 0 6 * * *",
		"0 6 * * *\n",
		"0 6 * *",
		"0 6 * * * *",
		"0 6 * jan *",
		"0 6 * * mon",
		"-1 * * * *",
		"",
	])("reads %j as custom", (cron) => expect(fromCron(cron)).toEqual({ kind: "custom", cron }));
});

describe("describeTiming", () => {
	it("says Every day at 06:00 UTC", () =>
		expect(say(describeTiming({ kind: "daily", hour: 6, minute: 0 }))).toBe(
			"Every day at 06:00 UTC",
		));
	it("says the minute of an hourly schedule", () =>
		expect(say(describeTiming({ kind: "hourly", minute: 5 }))).toBe("Every hour at minute 5"));
	it("says the day of a weekly schedule, Sunday first", () => {
		expect(say(describeTiming({ kind: "weekly", day: 1, hour: 6, minute: 30 }))).toBe(
			"Every Monday at 06:30 UTC",
		);
		expect(say(describeTiming({ kind: "weekly", day: 0, hour: 18, minute: 5 }))).toBe(
			"Every Sunday at 18:05 UTC",
		);
		expect(say(describeTiming({ kind: "weekly", day: 6, hour: 9, minute: 0 }))).toBe(
			"Every Saturday at 09:00 UTC",
		);
	});
	it("shows a custom expression with UTC", () =>
		expect(say(describeTiming({ kind: "custom", cron: "0 6 * * 1-5" }))).toBe(
			"Custom: 0 6 * * 1-5 (UTC)",
		));
});

describe("pause and launch messages", () => {
	const REASONS = [
		"template_gone",
		"template_changed",
		"source_gone",
		"source_changed",
		"creator_gone",
		"invalid_template",
		"credential_missing",
		"url_blocked",
		"too_large",
		"fetch_failed",
		"job_failed",
		"cancelled",
		"rolled_back",
		"missing_refused",
		"empty_feed",
	] as const satisfies readonly PauseReason[];

	it("has a sentence for every pause reason, and one for an unknown reason", () => {
		const table: Readonly<Record<PauseReason, Msg>> = PAUSE_MESSAGES;
		expect(Object.keys(table).sort()).toEqual([...REASONS].sort());
		const sentences = new Set(REASONS.map((r) => pauseMessage(r).message));
		expect(sentences.size).toBe(15);
		for (const r of REASONS) expect(pauseMessage(r)).toBe(PAUSE_MESSAGES[r]);
		expect(pauseMessage("from_the_future").message).toBe("for a reason this version does not know");
		// An inherited name is not a reason.
		expect(pauseMessage("toString").message).toBe("for a reason this version does not know");
		expect(sentences.has("for a reason this version does not know")).toBe(false);
	});

	it("says each launch outcome, a failure by its code's sentence", () => {
		const at = "2026-11-24T06:00:00.000Z";
		const texts = (["started", "unchanged", "busy"] as const).map(
			(outcome) => launchMessage({ at, outcome }).message,
		);
		expect(new Set(texts).size).toBe(3);
		expect(launchMessage({ at, outcome: "failed", errorCode: "FETCH_FAILED" })).toBe(
			ERROR_MESSAGES.FETCH_FAILED,
		);
		expect(launchMessage({ at, outcome: "failed", errorCode: "NO_SUCH_CODE" })).toBe(
			ERROR_MESSAGES.unknown,
		);
		expect(launchMessage({ at, outcome: "failed" })).toBe(ERROR_MESSAGES.unknown);
		expect(launchMessage({ at, outcome: "failed", errorCode: "constructor" })).toBe(
			ERROR_MESSAGES.unknown,
		);
	});
});

describe("utcLabel", () => {
	it("writes a time in UTC with a 24-hour clock, whatever the viewer's zone", () => {
		expect(utcLabel("2026-11-24T23:30:00.000Z", "en")).toBe("Nov 24, 2026 23:30");
		expect(utcLabel("2026-11-25T00:05:00.000+02:00", "en")).toBe("Nov 24, 2026 22:05");
	});
	it("leaves text that is not a time as it is", () => {
		expect(utcLabel("soon", "en")).toBe("soon");
	});
});
