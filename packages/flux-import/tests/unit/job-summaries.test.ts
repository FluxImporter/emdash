import { beforeEach, describe, expect, it, vi } from "vitest";
import { rollbackRefusal } from "../../src/engine/rollback.js";
import type { Job } from "../../src/engine/types.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { JOB_PAGE, listJobSummaries } from "../../src/plugin/service.js";
import { listItem } from "../../src/plugin/summaries.js";
import { MemoryKv, makeDeps } from "./fakes.js";
import { jobRow } from "./schedule-fakes.js";

// The routes build their services from the EmDash runtime and plugin storage; both are replaced
// by the in-memory fakes of the engine tests (as rollback-route.test.ts), and the fence read by a
// stub, as the runtime's database is a stand-in.
const state = vi.hoisted(() => ({ deps: undefined as unknown }));

vi.mock("../../src/plugin/runtime.js", () => ({
	withRuntime: async (run: (runtime: unknown) => Promise<unknown>) =>
		run({
			storage: new (await import("./fakes.js")).FakeStorage(),
			config: { maxUploadSize: 1000 },
			db: {},
		}),
}));
vi.mock("../../src/emdash/storage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/emdash/storage.js")>()),
	pluginCollections: () => state.deps,
}));
vi.mock("../../src/plugin/sources.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/plugin/sources.js")>()),
	sourcesCollection: () => new MemoryKv(),
}));
vi.mock("../../src/emdash/fence.js", () => ({ readFence: vi.fn(async () => "export") }));

const NOW = Date.parse("2026-11-24T12:00:00Z");
/** A well-formed upload ID: a ULID and 32 hex characters (src/emdash/uploads.ts:23). */
const UPLOAD_ID = `01JZ5V6Q8X0000000000000000${"ab".repeat(16)}`;
const ERROR_MESSAGE = `The staged file ${UPLOAD_ID} is gone`;
const HOLDER = "admin:01JZLEASEHOLDER";

/** The minute-th minute after 10:00 on the test day, so a later job sorts after an earlier one. */
const at = (minute: number) =>
	new Date(Date.parse("2026-11-24T10:00:00Z") + minute * 60_000).toISOString();

/**
 * A completed real import with a journal: one `rollbackRefusal` accepts. An `undefined` in `extra`
 * leaves that field out, as a stored row would.
 */
function job(
	id: string,
	minute: number,
	extra: { [K in keyof Job]?: Job[K] | undefined } = {},
): Job {
	const row: Record<string, unknown> = {
		...jobRow(id, {
			status: "completed",
			journal: true,
			createdAt: at(minute),
			updatedAt: at(minute),
		}),
		...extra,
	};
	for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
	return row as unknown as Job;
}

const fullJob = job("J1", 1, {
	kind: "import",
	status: "failed",
	origin: "schedule",
	scheduleId: "S1",
	templateId: "T1",
	templateRevision: 3,
	rollbackOf: "R0",
	rolledBackBy: "R1",
	startedAs: "J2",
	dryRunOf: "D1",
	sourceId: "SRC1",
	feedSourceId: "SRC1",
	uploadId: UPLOAD_ID,
	sourceUploadId: UPLOAD_ID,
	lease: { holder: HOLDER, expiresAt: NOW + 60_000 },
	error: { code: "source_missing", message: ERROR_MESSAGE },
	warnings: [`Read ${UPLOAD_ID}`],
	// A counter the table does not show stays out of the item.
	counters: { ...jobRow("J1").counters, planned: 5 } as Job["counters"],
	updatedAt: at(2),
});

let jobs: MemoryKv<Job>;
let deps: { jobs: MemoryKv<Job>; now: () => number };

beforeEach(() => {
	// Every index the plugin declares, and no other: a query on an undeclared field throws.
	jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
	deps = { jobs, now: () => NOW };
});

async function store(...rows: Job[]) {
	for (const row of rows) await jobs.put(row.id, row);
}

describe("listJobSummaries (M7b)", () => {
	beforeEach(async () => {
		// Ten real jobs J01..J10 and five dry runs D1..D5, interleaved, createdAt increasing.
		for (let n = 1; n <= 10; n++) {
			await store(job(`J${String(n).padStart(2, "0")}`, n * 2));
			if (n <= 5) await store(job(`D${n}`, n * 2 + 1, { dryRun: true, journal: undefined }));
		}
	});

	it("lists real imports newest first, a page at a time, without dry runs (Review Focus 5)", async () => {
		const first = await listJobSummaries(deps, { dryRun: false });
		expect(first.items.map((j) => j.id)).toEqual([
			"J10",
			"J09",
			"J08",
			"J07",
			"J06",
			"J05",
			"J04",
			"J03",
		]);
		expect(first.hasMore).toBe(true);
		const second = await listJobSummaries(deps, { dryRun: false, cursor: first.cursor! });
		expect(second.items.map((j) => j.id)).toEqual(["J02", "J01"]);
		expect(second.hasMore).toBe(false);
		expect(second).not.toHaveProperty("cursor");
	});

	it("lists only dry runs with dryRun true, dry rollbacks included", async () => {
		await store(
			job("DR", 30, { kind: "rollback", rollbackOf: "J01", dryRun: true, journal: undefined }),
		);
		const page = await listJobSummaries(deps, { dryRun: true });
		expect(page.items.map((j) => j.id)).toEqual(["DR", "D5", "D4", "D3", "D2", "D1"]);
		expect(page.items.every((j) => j.dryRun)).toBe(true);
		expect(page.items[0]).toMatchObject({ kind: "rollback", rollbackOf: "J01" });
		expect(page.hasMore).toBe(false);
	});

	it("queries only indexed fields: where dryRun, orderBy createdAt (Review Focus 5)", async () => {
		const query = vi.spyOn(jobs, "query");
		await listJobSummaries(deps, { dryRun: false });
		expect(query).toHaveBeenCalledWith({
			where: { dryRun: false },
			orderBy: { createdAt: "desc" },
			limit: JOB_PAGE,
		});
		await listJobSummaries(deps, { dryRun: true, cursor: "8" });
		expect(query).toHaveBeenLastCalledWith({
			where: { dryRun: true },
			orderBy: { createdAt: "desc" },
			limit: JOB_PAGE,
			cursor: "8",
		});
		expect(query).toHaveBeenCalledTimes(2);
	});
});

describe("listJobSummaries' rollback status (M7b)", () => {
	it("reads the rollback's status for a rolled-back import, and none once the rollback is gone", async () => {
		await store(
			job("J", 1, { rolledBackBy: "R" }),
			job("K", 2),
			job("R", 3, { kind: "rollback", rollbackOf: "J", status: "running", journal: undefined }),
		);
		const get = vi.spyOn(jobs, "get");
		const before = await listJobSummaries(deps, { dryRun: false });
		expect(before.items.map((j) => j.id)).toEqual(["R", "K", "J"]);
		expect(before.items[2]).toMatchObject({ rolledBackBy: "R", rollbackStatus: "running" });
		expect(before.items[0]).not.toHaveProperty("rollbackStatus");
		expect(before.items[1]).not.toHaveProperty("rollbackStatus");
		// One read, for the one rolled-back import.
		expect(get.mock.calls).toEqual([["R"]]);

		await jobs.delete("R");
		const after = await listJobSummaries(deps, { dryRun: false });
		expect(after.items.map((j) => j.id)).toEqual(["K", "J"]);
		expect(after.items[1]).toMatchObject({ rolledBackBy: "R" });
		expect(after.items[1]).not.toHaveProperty("rollbackStatus");
	});

	it("reads counters absent on old jobs as 0", async () => {
		const old = job("OLD", 1, {
			counters: {
				created: 4,
				updated: 1,
				unchanged: 0,
				locked: 0,
				conflict: 0,
				failed: 2,
			} as Job["counters"],
		});
		await store(old);
		const expected = {
			created: 4,
			updated: 1,
			unchanged: 0,
			failed: 2,
			conflict: 0,
			locked: 0,
			filtered: 0,
			reverted: 0,
			removed: 0,
		};
		expect((await listJobSummaries(deps, { dryRun: false })).items[0]?.counters).toEqual(expected);
		expect(listItem(old, undefined, NOW).counters).toEqual(expected);
	});
});

describe("listItem (M7b)", () => {
	it("marks rollbackable exactly as rollbackRefusal: a completed journalled import only", () => {
		const rollbackable = job("OK", 1);
		const refused: Job[] = [
			job("DRY", 1, { dryRun: true, journal: undefined }),
			job("DONE", 1, { rolledBackBy: "R" }),
			job("RUN", 1, { status: "running" }),
			job("LEASED", 1, { lease: { holder: HOLDER, expiresAt: NOW + 1 } }),
			job("NOJOURNAL", 1, { journal: undefined }),
			job("ROLLBACK", 1, { kind: "rollback", rollbackOf: "OK" }),
		];
		expect(listItem(rollbackable, undefined, NOW).rollbackable).toBe(true);
		expect(rollbackRefusal(rollbackable, NOW)).toBeNull();
		// A lease that has expired no longer holds the job.
		const expired = job("EXPIRED", 1, { lease: { holder: HOLDER, expiresAt: NOW } });
		expect(listItem(expired, undefined, NOW).rollbackable).toBe(true);
		for (const row of refused) {
			expect(rollbackRefusal(row, NOW), row.id).not.toBeNull();
			expect(listItem(row, undefined, NOW).rollbackable, row.id).toBe(false);
		}
	});

	it("keeps the fields the table needs and nothing else", () => {
		expect(Object.keys(listItem(fullJob, "completed", NOW)).sort()).toEqual([
			"collection",
			"counters",
			"createdAt",
			"dryRun",
			"errorCode",
			"id",
			"kind",
			"locale",
			"origin",
			"rollbackOf",
			"rollbackStatus",
			"rollbackable",
			"rolledBackBy",
			"scheduleId",
			"startedAs",
			"status",
			"templateId",
			"updatedAt",
		]);
		expect(listItem(fullJob, "completed", NOW)).toEqual({
			id: "J1",
			kind: "import",
			status: "failed",
			dryRun: false,
			origin: "schedule",
			scheduleId: "S1",
			collection: "products",
			locale: "en",
			templateId: "T1",
			rollbackOf: "R0",
			rolledBackBy: "R1",
			rollbackStatus: "completed",
			startedAs: "J2",
			rollbackable: false,
			counters: {
				created: 0,
				updated: 0,
				unchanged: 0,
				failed: 0,
				conflict: 0,
				locked: 0,
				filtered: 0,
				reverted: 0,
				removed: 0,
			},
			errorCode: "source_missing",
			createdAt: at(1),
			updatedAt: at(2),
		});
		const json = JSON.stringify(listItem(fullJob, undefined, NOW));
		for (const secret of [UPLOAD_ID, ERROR_MESSAGE, "is gone", HOLDER, "SRC1", "Name", "sku"]) {
			expect(json).not.toContain(secret);
		}
	});

	it("leaves out each optional field that is not set", () => {
		const bare = jobRow("B", { createdAt: at(1), updatedAt: at(1) });
		// Absent, not present as undefined: JSON keeps no key, and toEqual alone would not tell.
		expect(Object.keys(listItem(bare, undefined, NOW)).sort()).toEqual([
			"collection",
			"counters",
			"createdAt",
			"dryRun",
			"id",
			"kind",
			"locale",
			"rollbackable",
			"status",
			"updatedAt",
		]);
		expect(listItem(bare, undefined, NOW)).toEqual({
			id: "B",
			kind: "import",
			status: "created",
			dryRun: false,
			collection: "products",
			locale: "en",
			rollbackable: false,
			counters: {
				created: 0,
				updated: 0,
				unchanged: 0,
				failed: 0,
				conflict: 0,
				locked: 0,
				filtered: 0,
				reverted: 0,
				removed: 0,
			},
			createdAt: at(1),
			updatedAt: at(1),
		});
	});
});

describe("the M7b routes", () => {
	const plugin = createPlugin();

	function call(name: string, input: Record<string, unknown>) {
		const route = plugin.routes[name]!;
		return route.handler({
			input: route.input!.parse(input),
			user: { id: "admin", role: 50 },
			storage: {},
			settings: { get: async () => undefined },
			taxonomies: {},
			bylines: {},
		} as never);
	}

	beforeEach(async () => {
		const made = makeDeps().deps;
		state.deps = { ...made, jobs };
		await store(job("J01", 1), job("D1", 2, { dryRun: true, journal: undefined }));
	});

	it("answers schedules/fence with readFence's kind", async () => {
		expect(await call("schedules/fence", {})).toEqual({ fence: "export" });
	});

	it("answers jobs/summaries through the route with dryRun false by default", async () => {
		const real = (await call("jobs/summaries", {})) as {
			items: { id: string }[];
			hasMore: boolean;
		};
		expect(real.items.map((j) => j.id)).toEqual(["J01"]);
		expect(real.hasMore).toBe(false);
		const dry = (await call("jobs/summaries", { dryRun: true })) as { items: { id: string }[] };
		expect(dry.items.map((j) => j.id)).toEqual(["D1"]);
		// The cursor reaches the query: past the only real job, the page is empty.
		const past = (await call("jobs/summaries", { cursor: "1" })) as { items: unknown[] };
		expect(past.items).toEqual([]);
	});

	it("refuses jobs/summaries without a signed-in user", async () => {
		const route = plugin.routes["jobs/summaries"]!;
		await expect(
			route.handler({ input: {}, user: undefined, storage: {} } as never),
		).rejects.toMatchObject({ status: 401 });
	});
});
