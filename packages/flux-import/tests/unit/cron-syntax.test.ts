import { describe, expect, it } from "vitest";
import { cronProblem } from "../../src/plugin/cron-syntax.js";

describe("cronProblem (spec Ruling 7, plan Ruling 3)", () => {
	it.each([
		"0 3 * * *",
		"*/15 * * * *",
		"@hourly",
		"@daily",
		"@weekly",
		"@monthly",
		"@yearly",
		"0 3 * * 7",
		"0 3 * * 0-7",
		"0 0 1 JAN-MAR MON",
		"5-10/2 * * * *",
		"0 3 * * sun",
		"0 0 1,15 * *",
		"0 9 * * MON-FRI",
		"0 0 1 12-dec *",
		// EmDash reads any run of whitespace as one separator, as it schedules "0  3 * * *".
		"0  3 * * *",
		// EmDash refuses this one itself (Fact E1); the route answers with its message.
		"0 3 31 2 *",
	])("accepts %s", (cron) => {
		expect(cronProblem(cron)).toBeNull();
	});

	it.each([
		["", "The schedule is empty"],
		[" 0 3 * * *", "The schedule starts or ends with a space"],
		["0 3 * * * *", "Expected 5 fields, found 6"],
		["2026-12-01T03:00:00Z", "Expected 5 fields, found 1"],
		["every day at 3", "Expected 5 fields, found 4"],
		["@reboot", "@reboot is not an accepted alias"],
		["@midnight", "@midnight is not an accepted alias"],
		["61 * * * *", 'minute: "61" is not a value from 0 to 59, a range or a step'],
		["0 24 * * *", 'hour: "24" is not a value from 0 to 23, a range or a step'],
		["0 3 32 * *", 'day of month: "32" is not a value from 1 to 31, a range or a step'],
		["005 * * * *", 'minute: "005" is not a value from 0 to 59, a range or a step'],
		["0 3 0 * *", 'day of month: "0" is not a value from 1 to 31, a range or a step'],
		["*/60 * * * *", 'minute: the step in "*/60" must be from 1 to 59'],
		["0 3 */5/2 * *", 'day of month: "*/5/2" is not a value from 1 to 31, a range or a step'],
		// EmDash 1.2.0 stores these two as one-shot runs in the past (probed in M6b Task 2).
		["0 3 1, * *", 'day of month: "" is not a value from 1 to 31, a range or a step'],
		["1-2-3 * * * *", 'minute: "1-2-3" is not a value from 0 to 59, a range or a step'],
		["0 3 L * *", 'day of month: "L" is not a value from 1 to 31, a range or a step'],
		["0 3 * * 8", 'day of week: "8" is not a value from 0 to 7, a range or a step'],
		["0 3 * * jan", 'day of week: "jan" is not a value from 0 to 7, a range or a step'],
		["0 3 * * mon-sun", 'day of week: "mon-sun" is not a value from 0 to 7, a range or a step'],
		["*/0 * * * *", 'minute: the step in "*/0" must be from 1 to 59'],
		["0 0 1 1 1/2", 'day of week: a step needs * or a range before it, not "1/2"'],
	])("refuses %j: %s", (cron, problem) => {
		expect(cronProblem(cron)).toBe(problem);
	});

	it("refuses more than 256 characters", () => {
		const cron = `0 3 * * ${"1,".repeat(124)}1`;
		expect(cron).toHaveLength(257);
		expect(cronProblem(cron)).toBe("The schedule is longer than 256 characters");
	});
});
