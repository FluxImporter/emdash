import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JournalEntry, JournalMedia, RecordRow } from "../../src/engine/types.js";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import {
	AGENT_DRY_RUN_IDLE_MS,
	CLEAR_PAGE,
	CLEAR_QUERY_TARGET,
	clearDryRuns,
	DRY_RUN_IDLE_MS,
} from "../../src/plugin/dry-runs.js";
import { busyJob } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { MemoryKv, makeDeps } from "./fakes.js";
import { jobRow, sourceRow } from "./schedule-fakes.js";

// The route test builds its services from the EmDash runtime and plugin storage; both are
// replaced by in-memory fakes, as in job-summaries.test.ts.
const state = vi.hoisted(() => ({ deps: undefined as unknown, sources: undefined as unknown }));

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
	sourcesCollection: () => state.sources,
}));

const NOW = Date.parse("2026-11-24T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();
/** The n-th fixture's creation time, a second apart, so the scan reads fixtures in their order. */
const created = (n: number) => iso(NOW - 72 * HOUR + n * 1000);

/** A completed wizard dry run idle two hours, created n-th, reading its own staged file. */
function dry(id: string, n: number, extra: Partial<Job> = {}): Job {
	return jobRow(id, {
		dryRun: true,
		status: "completed",
		uploadId: `U-${id}`,
		createdAt: created(n),
		updatedAt: iso(NOW - 2 * HOUR),
		...extra,
	});
}

class Uploads {
	readonly deleted: string[] = [];
	async delete(id: string) {
		this.deleted.push(id);
	}
}

/** Counts every method call on the collection, as the route's storage calls. */
function counted<T extends object>(target: T, calls: { n: number }): T {
	return new Proxy(target, {
		get(t, key, receiver) {
			const value = Reflect.get(t, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls.n++;
				return Reflect.apply(value, t, args);
			};
		},
	});
}

function setup() {
	const clock = { t: NOW };
	const store = {
		jobs: new MemoryKv<Job>(STORAGE.jobs.indexes),
		records: new MemoryKv<RecordRow>(STORAGE.records.indexes),
		journal: new MemoryKv<JournalEntry>(STORAGE.journal.indexes),
		journalMedia: new MemoryKv<JournalMedia>(STORAGE.journalMedia.indexes),
		sources: new MemoryKv<SourceRow>(STORAGE.sources.indexes),
	};
	const calls = { n: 0 };
	const deps = {
		jobs: counted(store.jobs, calls),
		records: counted(store.records, calls),
		journal: counted(store.journal, calls),
		journalMedia: counted(store.journalMedia, calls),
		now: () => clock.t,
	};
	const sourceCalls = { n: 0 };
	const sources = counted(counted(store.sources, sourceCalls), calls);
	const uploads = new Uploads();
	const clear = (cursor?: string) => clearDryRuns(deps, uploads, sources, cursor);
	return { store, deps, sources, uploads, clock, calls, sourceCalls, clear };
}

async function put(jobs: MemoryKv<Job>, ...rows: Job[]) {
	for (const row of rows) await jobs.put(row.id, row);
}

async function addRecords(records: MemoryKv<RecordRow>, jobId: string, n: number) {
	for (let seq = 1; seq <= n; seq++) {
		await records.put(`${jobId}:${seq}`, { jobId, seq, status: "planned" } as RecordRow);
	}
}

async function idsOf(jobs: MemoryKv<Job>): Promise<string[]> {
	return [...jobs.rows.keys()].sort();
}

describe("clearDryRuns", () => {
	it("clears finished dry runs and dry rollbacks with their records and staged files, and counts them", async () => {
		const { store, uploads, clear } = setup();
		await put(
			store.jobs,
			dry("D1", 1, { uploadId: "U1", sourceUploadId: "B1" }),
			dry("D2", 2, { uploadId: "U2", status: "cancelled" }),
			dry("R1", 3, { uploadId: "U3", kind: "rollback", rollbackOf: "J0" }),
		);
		for (const id of ["D1", "D2", "R1"]) await addRecords(store.records, id, 3);
		await store.journal.put("D1:j", { jobId: "D1", seq: 1 } as JournalEntry);
		await store.journalMedia.put("D1:m", { jobId: "D1", seq: 1 } as JournalMedia);

		expect(await clear()).toEqual({ cleared: 3, more: false });
		expect(await store.jobs.get("D1")).toBeNull();
		expect(store.jobs.rows.size).toBe(0);
		expect((await store.records.query({ where: { jobId: "D1" } })).items).toEqual([]);
		expect(store.records.rows.size).toBe(0);
		expect(store.journal.rows.size).toBe(0);
		expect(store.journalMedia.rows.size).toBe(0);
		expect([...uploads.deleted].sort()).toEqual(["B1", "U1", "U2", "U3"]);
	});

	it("never touches a real job, even one started from the dry run (Review Focus 1)", async () => {
		const { store, uploads, clear } = setup();
		const old = { createdAt: created(0), updatedAt: iso(NOW - 48 * HOUR) };
		await put(
			store.jobs,
			jobRow("J1", { ...old, status: "completed", uploadId: "U9" }),
			dry("D1", 1, { uploadId: "U1" }),
			// The wizard's Run imports the dry run's own upload (M7a amendment 7).
			jobRow("J2", {
				...old,
				createdAt: created(2),
				status: "running",
				uploadId: "U1",
				dryRunOf: "D1",
			}),
		);
		await addRecords(store.records, "J1", 2);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(await idsOf(store.jobs)).toEqual(["J1", "J2"]);
		expect((await store.records.query({ where: { jobId: "J1" } })).items).toHaveLength(2);
		expect(uploads.deleted).toEqual([]);
	});

	it("clears a dry run that finished a minute ago but keeps its staged file, so an open Preview's Run still imports it (Ruling 6)", async () => {
		const { store, uploads, clear } = setup();
		await put(
			store.jobs,
			dry("D1", 1, { uploadId: "U1", updatedAt: iso(NOW - MINUTE) }),
			// Idle exactly DRY_RUN_IDLE_MS: its file goes.
			dry("D2", 2, { uploadId: "U2", updatedAt: iso(NOW - DRY_RUN_IDLE_MS) }),
		);
		await addRecords(store.records, "D1", 3);

		expect(await clear()).toEqual({ cleared: 2, more: false });
		expect(store.jobs.rows.size).toBe(0);
		expect(store.records.rows.size).toBe(0);
		expect(uploads.deleted).toEqual(["U2"]);
	});

	it("keeps a dry run whose batch holds a live lease (Review Focus 1)", async () => {
		const { store, uploads, clear } = setup();
		const live = { holder: "admin:1", expiresAt: NOW + MINUTE };
		await put(
			store.jobs,
			// F15: a running dry run idle two hours, and a completed one, both with a live lease.
			dry("L1", 1, { status: "running", lease: live }),
			dry("L2", 2, { lease: live }),
			dry("L3", 3, { lease: { holder: "admin:1", expiresAt: NOW } }),
		);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(await idsOf(store.jobs)).toEqual(["L1", "L2"]);
		expect(uploads.deleted).toEqual(["U-L3"]);
	});

	it("keeps an unfinished wizard dry run idle under DRY_RUN_IDLE_MS, and clears it after", async () => {
		const { store, clock, clear } = setup();
		const touched = NOW - 30 * MINUTE;
		await put(
			store.jobs,
			dry("W1", 1, { status: "running", updatedAt: iso(touched) }),
			dry("W2", 2, { status: "paused", updatedAt: iso(touched) }),
			dry("W3", 3, { status: "created", updatedAt: iso(touched) }),
		);

		expect(await clear()).toEqual({ cleared: 0, more: false });
		expect(store.jobs.rows.size).toBe(3);
		clock.t = touched + DRY_RUN_IDLE_MS - 1;
		expect(await clear()).toEqual({ cleared: 0, more: false });
		clock.t = touched + DRY_RUN_IDLE_MS;
		expect(await clear()).toEqual({ cleared: 3, more: false });
	});

	it("keeps an agent dry run that was started, or idle under 24 hours; clears one idle 24 hours, never started (Review Focus 1)", async () => {
		const { store, clear } = setup();
		const agent = { origin: "agent" as const, templateId: "T1", templateRevision: 1 };
		await put(
			store.jobs,
			dry("A1", 1, { ...agent, startedAs: "J9", updatedAt: iso(NOW - 72 * HOUR) }),
			dry("A2", 2, { ...agent, updatedAt: iso(NOW - AGENT_DRY_RUN_IDLE_MS + 1) }),
			// Finished, but an agent's: the wizard's one-hour rule does not apply.
			dry("A3", 3, { ...agent, status: "failed", updatedAt: iso(NOW - 2 * HOUR) }),
			dry("A4", 4, { ...agent, updatedAt: iso(NOW - AGENT_DRY_RUN_IDLE_MS) }),
			jobRow("J9", { createdAt: created(5), status: "running", dryRunOf: "A1", origin: "agent" }),
		);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(await idsOf(store.jobs)).toEqual(["A1", "A2", "A3", "J9"]);
	});

	it("keeps the staged file a real job still reads, and a URL source's latest fetch (Review Focus 1)", async () => {
		const { store, uploads, clear } = setup();
		const failed = { ...jobRow("J").counters, failed: 1 };
		await put(
			store.jobs,
			jobRow("J", { createdAt: created(0), status: "completed", uploadId: "U1", counters: failed }),
			dry("D1", 1, { uploadId: "U1" }),
			dry("D2", 2, { uploadId: "U2" }),
		);
		await store.sources.put(
			"S1",
			sourceRow("S1", { lastFetch: { uploadId: "U2" } as NonNullable<SourceRow["lastFetch"]> }),
		);

		expect(await clear()).toEqual({ cleared: 2, more: false });
		expect(await idsOf(store.jobs)).toEqual(["J"]);
		expect(uploads.deleted).toEqual([]);
	});

	it("loses to a concurrent jobs/start claim: the claimed dry run stays (Review Focus 1)", async () => {
		const { store, deps, uploads, clear } = setup();
		const agent = { origin: "agent" as const, templateId: "T1", templateRevision: 1 };
		const old = { updatedAt: iso(NOW - 48 * HOUR) };
		const a = dry("A", 1, { ...agent, ...old, uploadId: "UA" });
		const b = dry("B", 2, { ...agent, ...old, uploadId: "UB" });
		await put(store.jobs, a, b);
		// A claim lands between the scan and the re-read of A, and between the re-read and the mark of B.
		const getVersioned = deps.jobs.getVersioned.bind(deps.jobs);
		deps.jobs.getVersioned = async (id) => {
			if (id === "A") await store.jobs.put("A", { ...a, startedAs: "JA" });
			return getVersioned(id);
		};
		const compareAndSet = deps.jobs.compareAndSet.bind(deps.jobs);
		deps.jobs.compareAndSet = async (id, revision, data) => {
			if (id === "B") await store.jobs.put("B", { ...b, startedAs: "JB" });
			return compareAndSet(id, revision, data);
		};

		expect(await clear()).toEqual({ cleared: 0, more: false });
		expect(await store.jobs.get("A")).toEqual({ ...a, startedAs: "JA" });
		expect(await store.jobs.get("B")).toEqual({ ...b, startedAs: "JB" });
		expect(uploads.deleted).toEqual([]);
	});

	it("stops at CLEAR_QUERY_TARGET calls with more and no cursor; the next call finishes the purging job", async () => {
		const { store, uploads, calls, clear } = setup();
		// F5: three dry runs of 400 records (about 25 calls each), then one of 4,000 (about 170),
		// so the budget runs out part way through the fourth's purge.
		for (let i = 0; i < 4; i++) {
			await put(store.jobs, dry(`D${i}`, i));
			await addRecords(store.records, `D${i}`, i === 3 ? 4000 : 400);
		}

		expect(await clear()).toEqual({ cleared: 3, more: true });
		expect(calls.n).toBeLessThanOrEqual(CLEAR_QUERY_TARGET + 1);
		expect(await idsOf(store.jobs)).toEqual(["D3"]);
		expect((await store.jobs.get("D3"))?.purging).toBe(true);
		expect(store.records.rows.size).toBeGreaterThan(0);
		expect([...uploads.deleted].sort()).toEqual(["U-D0", "U-D1", "U-D2"]);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(store.jobs.rows.size).toBe(0);
		expect(store.records.rows.size).toBe(0);
		expect([...uploads.deleted].sort()).toEqual(["U-D0", "U-D1", "U-D2", "U-D3"]);
	});

	it("stays within CLEAR_QUERY_TARGET calls over a page of dry runs with staged files (F6)", async () => {
		const { store, uploads, calls, sourceCalls, clear } = setup();
		for (let i = 0; i < CLEAR_PAGE; i++) {
			await put(store.jobs, dry(`D${i}`, i, { sourceUploadId: `B-D${i}` }));
			await addRecords(store.records, `D${i}`, 3);
		}
		// Ten pages of sources: the keeper reads them once per call, on the meter.
		for (let i = 0; i < 1000; i++) await store.sources.put(`S${i}`, sourceRow(`S${i}`));

		const reply = await clear();
		// F6 allows CLEAR_QUERY_TARGET + 1; the purge and the release never need the extra call.
		expect(calls.n).toBeLessThanOrEqual(CLEAR_QUERY_TARGET);
		expect(sourceCalls.n).toBe(10);
		// A purge starts only with enough calls left to finish a small dry run.
		expect([...store.jobs.rows.values()].filter((r) => r.value.purging)).toEqual([]);
		expect(reply).toEqual({ cleared: reply.cleared, more: true });
		// Each cleared dry run's two files went, unless the budget left them to retention.
		expect(uploads.deleted.length).toBeLessThanOrEqual(2 * reply.cleared);
		expect(uploads.deleted.length).toBeGreaterThan(0);
	});

	it("leaves the files to retention when the purge used up the budget (F6)", async () => {
		const { store, uploads, calls, clear } = setup();
		// 3,500 records: the scan, the mark and 70 delete pages leave too few calls to release.
		await put(store.jobs, dry("D1", 1, { sourceUploadId: "B1" }));
		await addRecords(store.records, "D1", 3500);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(calls.n).toBeLessThanOrEqual(CLEAR_QUERY_TARGET);
		expect(store.records.rows.size).toBe(0);
		expect(uploads.deleted).toEqual([]);
	});

	it("finishes a dry run retention left marked purging, even one an agent started", async () => {
		const { store, uploads, clear } = setup();
		const agent = { origin: "agent" as const, templateId: "T1", templateRevision: 1 };
		await put(
			store.jobs,
			dry("A1", 1, { ...agent, startedAs: "J9", purging: true, uploadId: "UA" }),
			jobRow("J9", { createdAt: created(2), status: "running", dryRunOf: "A1", uploadId: "UA" }),
		);
		await addRecords(store.records, "A1", 3);

		expect(await clear()).toEqual({ cleared: 1, more: false });
		expect(await idsOf(store.jobs)).toEqual(["J9"]);
		expect(store.records.rows.size).toBe(0);
		// The real job still reads the file.
		expect(uploads.deleted).toEqual([]);
	});

	it("answers more and a cursor while dry runs remain past the page", async () => {
		const { store, clear } = setup();
		// Fresh (no file to release), so a page of 20 fits the budget.
		const fresh = { updatedAt: iso(NOW - MINUTE) };
		for (let i = 0; i < 25; i++) await put(store.jobs, dry(`D${i}`, i, fresh));

		const first = await clear();
		expect(first).toEqual({ cleared: CLEAR_PAGE, more: true, cursor: created(CLEAR_PAGE - 1) });
		expect(await clear(first.cursor)).toEqual({ cleared: 5, more: false });
		expect(store.jobs.rows.size).toBe(0);
	});

	it("goes past a kept last row of the page on the next call (F1)", async () => {
		const { store, clear } = setup();
		const fresh = { updatedAt: iso(NOW - MINUTE) };
		for (let i = 0; i < 40; i++) {
			const agent = i === 19 ? { origin: "agent" as const } : {};
			await put(store.jobs, dry(`D${String(i).padStart(2, "0")}`, i, { ...fresh, ...agent }));
		}

		const first = await clear();
		expect(first).toEqual({ cleared: 19, more: true, cursor: created(19) });
		// The kept row is not read again, so the next 20 fill the second page.
		expect(await clear(first.cursor)).toEqual({ cleared: 20, more: false });
		expect(await idsOf(store.jobs)).toEqual(["D19"]);
		expect(await clear()).toEqual({ cleared: 0, more: false });
	});

	it("relieves the M6b busy check: 101 idle unfinished dry runs on a source no longer make it busy", async () => {
		const { store, uploads, clear } = setup();
		for (let i = 0; i < 101; i++) {
			await put(
				store.jobs,
				dry(`D${String(i).padStart(3, "0")}`, i, {
					status: "created",
					feedSourceId: "S1",
					uploadId: "U1",
				}),
			);
		}
		expect(await busyJob(store.jobs, "S1")).not.toBeNull();

		let cleared = 0;
		let cursor: string | undefined;
		for (let n = 0; n < 50; n++) {
			const reply = await clear(cursor);
			cleared += reply.cleared;
			cursor = reply.cursor;
			if (!reply.more) break;
		}
		expect(cleared).toBe(101);
		expect(await busyJob(store.jobs, "S1")).toBeNull();
		// Kept while another dry run on it could still be run, then released with the last.
		expect(uploads.deleted).toEqual(["U1"]);
	});
});

describe("the jobs/clear-dry-runs route", () => {
	const plugin = createPlugin();
	const route = plugin.routes["jobs/clear-dry-runs"]!;
	let jobs: MemoryKv<Job>;

	beforeEach(() => {
		jobs = new MemoryKv<Job>(STORAGE.jobs.indexes);
		state.deps = { ...makeDeps().deps, jobs, now: () => NOW };
		state.sources = new MemoryKv<SourceRow>(STORAGE.sources.indexes);
	});

	it("accepts only { cursor? } on the route", async () => {
		const input = route.input!;
		for (const ok of [{}, { cursor: created(1) }]) {
			expect(input.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
		}
		for (const bad of [{ cursor: "" }, { cursor: 1 }, { dryRun: true }, { cursor: "c", x: 1 }]) {
			expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
		expect(route).toMatchObject({ methods: ["POST"], permission: "import:execute" });

		await put(jobs, dry("D1", 1), dry("D2", 2, { updatedAt: iso(NOW - MINUTE) }));
		const reply = await route.handler({
			input: input.parse({}),
			user: { id: "admin", role: 50 },
			storage: {},
			settings: { get: async () => undefined },
			taxonomies: {},
			bylines: {},
		} as never);
		expect(reply).toEqual({ cleared: 2, more: false });
		expect(jobs.rows.size).toBe(0);
	});
});
