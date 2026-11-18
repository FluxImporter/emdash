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
		// A day of month is checked against the months each month item lists, steps included.
		"0 0 29 2 *",
		"0 0 30 4,6,9,11 *",
		"0 0 31 4,5 *",
		"0 0 31 4-5 *",
		"0 0 31 feb,apr-jun *",
		"0 0 31 * *",
		"0 0 31 */3 *",
		"0 0 31 2-11/3 *",
		"0 0 31 4-6/2,7 *",
		// A day range or step is refused only when none of its days occurs.
		"0 0 */31 2 *",
		"0 0 29-31 2 *",
		"0 0 29-31/2 2 *",
		"0 0 1-31/30 4 *",
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
		["0 3 31 2 *", "Day 31 never occurs in the listed months"],
		["0 0 30 2 *", "Day 30 never occurs in the listed months"],
		["0 0 31 4,6,9,11 *", "Day 31 never occurs in the listed months"],
		["0 0 31 feb,apr *", "Day 31 never occurs in the listed months"],
		["0 0 1,30-31 2 *", "Day 30 never occurs in the listed months"],
		["0 0 *,31 2 *", "Day 31 never occurs in the listed months"],
		// A step in either field hides nothing: croner's next-run search overflows on these three.
		["0 0 31-31/1 4,6,9,11 *", "Day 31 never occurs in the listed months"],
		["0 0 31 4-6/2,9-11/2 *", "Day 31 never occurs in the listed months"],
		["0 0 31 4,6,9-11/2 *", "Day 31 never occurs in the listed months"],
		["0 0 31 4-6/2 *", "Day 31 never occurs in the listed months"],
		["0 0 31 4-12/5 *", "Day 31 never occurs in the listed months"],
		["0 0 30-31/1 2 *", "Day 30 never occurs in the listed months"],
		["0 0 30-31 2 *", "Day 30 never occurs in the listed months"],
		["0 0 31 4/2 *", 'month: a step needs * or a range before it, not "4/2"'],
		// The day itself never occurs, whatever the day of week adds (croner ORs the two).
		["0 0 31 2 mon", "Day 31 never occurs in the listed months"],
		["0 3 L * *", 'day of month: "L" is not a value from 1 to 31, a range or a step'],
		["0 3 * * 8", 'day of week: "8" is not a value from 0 to 7, a range or a step'],
		["0 3 * * jan", 'day of week: "jan" is not a value from 0 to 7, a range or a step'],
		["0 3 * * mon-sun", 'day of week: "mon-sun" is not a value from 0 to 7, a range or a step'],
		["*/0 * * * *", 'minute: the step in "*/0" must be from 1 to 59'],
		["/0 * * * *", 'minute: "/0" is not a value from 0 to 59, a range or a step'],
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
