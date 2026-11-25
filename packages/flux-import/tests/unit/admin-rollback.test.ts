import { describe, expect, it } from "vitest";
import { planLines, planOf } from "../../src/admin/home/jobs/rollback/plan.js";
import { interpolate } from "../../src/admin/i18n.js";
import type { Counters, Job } from "../../src/engine/types.js";
import { job } from "../admin/fixtures.js";

const counters = (over: Partial<Counters>): Counters => ({
	created: 0,
	updated: 0,
	unchanged: 0,
	locked: 0,
	conflict: 0,
	failed: 0,
	filtered: 0,
	reverted: 0,
	...over,
});

/** A finished dry rollback with `counters` and, when given, `undo`. */
const dryRollback = (over: Partial<Job>): Job =>
	job({ id: "R1", kind: "rollback", rollbackOf: "J1", status: "completed", ...over });

const read = (lines: ReturnType<typeof planLines>) =>
	lines.map((l) => interpolate(l.msg.message, l.values));

describe("planOf", () => {
	it("splits the rows by what the rollback does with them", () => {
		const plan = planOf(
			dryRollback({
				counters: counters({ reverted: 4, conflict: 1, failed: 2, locked: 3, unchanged: 5 }),
				undo: { deleted: 2, restored: 1, recovered: 1 },
			}),
		);
		expect(plan).toEqual({ total: 4, deleted: 2, restored: 1, recovered: 1, kept: 6, gone: 5 });
	});

	it("leaves the split out for a rollback made before 0.7.0", () => {
		const plan = planOf(dryRollback({ counters: counters({ reverted: 3, conflict: 1 }) }));
		expect(plan).toEqual({ total: 3, kept: 1, gone: 0 });
	});

	it("reads a missing reverted counter as 0", () => {
		const { reverted: _r, ...rest } = counters({ conflict: 2 });
		expect(planOf(dryRollback({ counters: rest }))).toEqual({ total: 0, kept: 2, gone: 0 });
	});
});

describe("planLines", () => {
	it("names what will be deleted, restored and brought back, then what stays, non-zero only", () => {
		const plan = planOf(
			dryRollback({
				counters: counters({ reverted: 4, conflict: 1, unchanged: 0 }),
				undo: { deleted: 2, restored: 1, recovered: 1 },
			}),
		);
		expect(read(planLines(plan))).toEqual([
			"Entries the import created, to delete: 2",
			"Entries it updated, to restore to their earlier version: 1",
			"Entries it moved to Trash or unpublished, to bring back: 1",
			"Entries that can't be rolled back (edited since, locked or failed): 1",
		]);
	});

	it("says which entries are already gone, and skips a zero kind", () => {
		const plan = planOf(
			dryRollback({
				counters: counters({ reverted: 2, unchanged: 3 }),
				undo: { deleted: 0, restored: 2, recovered: 0 },
			}),
		);
		expect(read(planLines(plan))).toEqual([
			"Entries it updated, to restore to their earlier version: 2",
			"Entries already gone: 3",
		]);
	});

	it("falls back to the total without undo (Review Focus 2)", () => {
		const plan = planOf(dryRollback({ counters: counters({ reverted: 3, conflict: 1 }) }));
		expect(read(planLines(plan))).toEqual([
			"Entries to roll back: 3",
			"Entries that can't be rolled back (edited since, locked or failed): 1",
		]);
	});

	it("has no line for a rollback with nothing to do", () => {
		expect(planLines(planOf(dryRollback({ counters: counters({}) })))).toEqual([]);
		expect(
			planLines(
				planOf(
					dryRollback({
						counters: counters({}),
						undo: { deleted: 0, restored: 0, recovered: 0 },
					}),
				),
			),
		).toEqual([]);
	});
});
