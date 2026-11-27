import { describe, expect, it } from "vitest";
import { foundOf, planOf, planTiles } from "../../src/admin/home/jobs/rollback/plan.js";
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

/** Each tile as English words: its count's form for that count, and its hint. */
const read = (tiles: ReturnType<typeof planTiles>) =>
	tiles.map((t) => [
		interpolate(t.count === 1 ? t.label.one : t.label.other, { count: t.count }),
		t.hint.message,
	]);

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

describe("planTiles", () => {
	it("gives the four counts in order, zeros included, with their words and hints", () => {
		const plan = planOf(
			dryRollback({
				counters: counters({ reverted: 3, conflict: 1, unchanged: 2 }),
				undo: { deleted: 2, restored: 1, recovered: 0 },
			}),
		);
		expect(read(planTiles(plan))).toEqual([
			["2 to delete", "Created by this import"],
			["1 to restore", "Updated by this import"],
			["0 to bring back", "Moved to Trash or unpublished by it"],
			["1 kept", "Edited since, locked or failed"],
		]);
		expect(planTiles(plan).map((t) => t.kind)).toEqual([
			"deleted",
			"restored",
			"recovered",
			"kept",
		]);
	});

	it("falls back to the total and kept without undo (Review Focus 2)", () => {
		const plan = planOf(dryRollback({ counters: counters({ reverted: 3, conflict: 1 }) }));
		expect(read(planTiles(plan))).toEqual([
			["3 to roll back", "Created or updated by this import"],
			["1 kept", "Edited since, locked or failed"],
		]);
	});
});

describe("foundOf", () => {
	it("counts every entry the dry rollback looked at: reverted, kept and already gone", () => {
		const plan = planOf(
			dryRollback({
				counters: counters({ reverted: 4, conflict: 1, failed: 2, locked: 3, unchanged: 5 }),
				undo: { deleted: 2, restored: 1, recovered: 1 },
			}),
		);
		expect(foundOf(plan)).toBe(15);
		expect(foundOf(planOf(dryRollback({ counters: counters({}) })))).toBe(0);
	});
});
