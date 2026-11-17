import { createHash } from "node:crypto";
import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";
import { JobError, JobExistsError } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import { type JobRequest, jobTemplateRef } from "../../src/plugin/job-templates.js";
import {
	cancelLaunched,
	type LaunchDeps,
	launch,
	markDue,
	userRoleOf,
} from "../../src/plugin/launch.js";
import {
	BUSY_SCAN_PAGES,
	PUMP_SCHEDULE,
	PUMP_TASK,
	type ScheduleRow,
	sourcePinOf,
	writeSchedule,
} from "../../src/plugin/schedules.js";
import { ServiceError } from "../../src/plugin/service.js";
import { jobFromSource, type SkippedJob, type SourceDeps } from "../../src/plugin/sources.js";
import { FakeStorage, MemorySettings, makeDeps } from "./fakes.js";
import {
	jobRow,
	NOW,
	PLAIN,
	savedTemplate,
	scheduleDeps,
	scheduleRow,
	sourceRow,
} from "./schedule-fakes.js";

const AT = new Date(NOW).toISOString();

type Users = NonNullable<PluginContext["users"]>;
type UserInfo = NonNullable<Awaited<ReturnType<Users["get"]>>>;

/** `ctx.users` over a map, as `users:read` gives it. */
function usersOf(rows: ReadonlyMap<string, UserInfo>): Users {
	return {
		get: async (id) => rows.get(id) ?? null,
		getByEmail: async () => null,
		list: async () => ({ items: [...rows.values()] }),
	};
}

/** `setup`'s row options; `due: undefined` leaves the schedule without a due mark (preflight F3). */
type RowOptions = Omit<Partial<ScheduleRow>, "due"> & { due?: ScheduleRow["due"] | undefined };

/**
 * The launch's dependencies over `scheduleDeps`: Admin "admin" (50), editor "editor" (40), a
 * disabled Admin "disabled" (EmDash still returns the user with its role, spec F13) and "odd",
 * whose role is not a number. `create` records each request and answers with `answer`, storing a
 * job it returns; `cancel` is the real `cancelLaunched` over the same jobs and sources.
 */
async function setup(extra: RowOptions = {}) {
	const { deps: base, clock } = await scheduleDeps();
	const users = new Map<string, UserInfo>(
		(
			[
				["admin", 50],
				["editor", 40],
				["disabled", 50],
				["odd", Number.NaN],
			] as const
		).map(([id, role]) => [id, { id, email: `${id}@x`, name: null, role, createdAt: AT }]),
	);
	const requests: JobRequest[] = [];
	const warnings: string[] = [];
	const fake = {
		answer: async (request: JobRequest): Promise<Job | SkippedJob> =>
			jobRow(request.id ?? "", { origin: "schedule", scheduleId: request.scheduleId ?? "" }),
	};
	const engine = { ...makeDeps({ clock }).deps, jobs: base.jobs };
	let ids = 0;
	const warn = (message: string) => {
		warnings.push(message);
	};
	const deps: LaunchDeps = {
		schedules: base.schedules,
		jobs: base.jobs,
		templates: base.templates,
		sources: base.sources,
		cron: base.cron,
		userRole: userRoleOf(usersOf(users), warn),
		create: async (request) => {
			requests.push(request);
			const result = await fake.answer(request);
			if ("id" in result) await base.jobs.put(result.id, result);
			return result;
		},
		cancel: (jobId) =>
			cancelLaunched(
				{
					deps: engine,
					uploads: { delete: async () => {} },
					keep: async () => false,
					sources: { sources: base.sources },
				},
				jobId,
			),
		warn,
		now: () => clock.t,
		newId: () => `J${++ids}`,
	};
	const sourcePin = await sourcePinOf(sourceRow("S1"));
	const { due, ...rest } = extra;
	const mark = "due" in extra ? due : { at: AT };
	await base.schedules.put(
		"A",
		scheduleRow("A", { sourcePin, ...rest, ...(mark ? { due: mark } : {}) }),
	);
	const row = async () => (await base.schedules.get("A")) as ScheduleRow;
	const markAgain = (force?: true) =>
		writeSchedule(base.schedules, "A", undefined, (r) => ({
			...r,
			due: { at: AT, ...(force ? { force } : {}) },
		}));
	return { deps, base, clock, requests, warnings, fake, row, markAgain };
}

describe('launch (spec "Launch")', () => {
	it("creates the job under the claimed ID with the schedule's options, and records it started", async () => {
		const t = await setup({
			templateId: "T2",
			missing: { maxPercent: 5 },
			due: { at: AT, force: true },
		});
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(t.requests).toEqual([
			{
				id: "J1",
				sourceId: "S1",
				templateId: "T2",
				templateRevision: 1,
				dryRun: false,
				force: true,
				origin: "schedule",
				scheduleId: "A",
				scheduled: "open",
				feedSourceId: "S1",
				publish: true,
				batchSize: 50,
				budgetMs: 4000,
				journal: true,
				missing: { maxPercent: 5 },
			},
		]);
		const row = await t.row();
		expect(row).toMatchObject({
			lastLaunch: { at: AT, outcome: "started", jobId: "J1" },
			launchFailures: 0,
			enabled: true,
		});
		expect(row).not.toHaveProperty("current");
		expect(row).not.toHaveProperty("due");
	});

	it.each([
		["template", {}],
		[false, { missing: false }],
	] as const)("maps the schedule's missing %j to the job options %j", async (missing, expected) => {
		const t = await setup({ templateId: "T2", missing });
		await launch(t.deps, await t.row());
		expect(t.requests[0]).toMatchObject(expected);
		if (missing === "template") expect(t.requests[0]).not.toHaveProperty("missing");
	});

	it("records unchanged content and resets the failure count", async () => {
		const t = await setup({ launchFailures: 2 });
		t.fake.answer = async () => ({ skipped: "unchanged", sourceId: "S1", uploadId: "u1" });
		expect(await launch(t.deps, await t.row())).toBe("unchanged");
		expect(await t.row()).toMatchObject({
			lastLaunch: { at: AT, outcome: "unchanged" },
			launchFailures: 0,
		});
	});

	it("is busy while another real import reads the source: records busy and clears the mark (spec Ruling 33)", async () => {
		const t = await setup();
		await t.base.jobs.put("J9", jobRow("J9", { status: "running", feedSourceId: "S1" }));
		expect(await launch(t.deps, await t.row())).toBe("busy");
		const row = await t.row();
		expect(row.lastLaunch).toEqual({ at: AT, outcome: "busy", jobId: "J9" });
		expect(row).not.toHaveProperty("due");
		expect(t.requests).toEqual([]);
	});

	it("is not busy for unfinished dry runs, and fails closed past the busy scan's cap (preflight F13)", async () => {
		const t = await setup();
		const dryRuns = BUSY_SCAN_PAGES * 20;
		for (let i = 0; i < dryRuns; i++) {
			const id = `D${String(i).padStart(3, "0")}`;
			await t.base.jobs.put(id, jobRow(id, { dryRun: true, feedSourceId: "S1" }));
		}
		expect(await launch(t.deps, await t.row())).toBe("started");
		await t.markAgain();
		await t.base.jobs.put("D999", jobRow("D999", { dryRun: true, feedSourceId: "S1" }));
		expect(await launch(t.deps, await t.row())).toBe("busy");
		expect((await t.row()).lastLaunch).toMatchObject({ outcome: "busy" });
		expect(t.requests).toHaveLength(1);
	});

	it("leaves a young claim with no job in flight, and replaces a stale claim or one whose job finished (plan Ruling 20)", async () => {
		const young = { jobId: "X", claimedAt: new Date(NOW - 60_000).toISOString() };
		const t = await setup({ current: young });
		expect(await launch(t.deps, await t.row())).toBe("in_flight");
		expect(await t.row()).toMatchObject({ current: young, due: { at: AT } });
		t.clock.t += 600_000;
		expect(await launch(t.deps, await t.row())).toBe("started");
		await t.base.jobs.put("Y", jobRow("Y", { status: "completed", feedSourceId: "S1" }));
		await writeSchedule(t.base.schedules, "A", undefined, (r) => ({
			...r,
			due: { at: AT },
			current: { jobId: "Y", claimedAt: new Date(t.clock.t).toISOString() },
		}));
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(t.requests.map((r) => r.id)).toEqual(["J2", "J3"]);
	});

	it("retries a claim whose compare-and-set lost to another write, keeping that write (F16)", async () => {
		const t = await setup();
		const cas = t.base.schedules.compareAndSet.bind(t.base.schedules);
		let interposed = false;
		t.base.schedules.compareAndSet = async (id, revision, data) => {
			if (!interposed) {
				interposed = true;
				// A route write lands between the claim's read and its compare-and-set.
				const read = await t.base.schedules.getVersioned(id);
				if (read) await cas(id, read.revision, { ...read.value, name: "renamed" });
			}
			return cas(id, revision, data);
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(await t.row()).toMatchObject({ name: "renamed", lastLaunch: { jobId: "J1" } });
		expect(t.requests).toHaveLength(1);
	});

	it.each([
		["template_gone", "TEMPLATE_NOT_FOUND", { templateId: "nope" }],
		["template_changed", "TEMPLATE_CHANGED", { templateRevision: 2 }],
		["source_gone", "SOURCE_NOT_FOUND", { sourceId: "S9" }],
		["source_changed", "SOURCE_CHANGED", { sourcePin: "other" }],
		["creator_gone", "CREATOR_GONE", { armedBy: "ghost" }],
		["creator_gone", "CREATOR_GONE", { armedBy: "editor" }],
		["creator_gone", "CREATOR_GONE", { armedBy: "odd" }],
	] as const)("pauses %s (%s) before any fetch", async (reason, code, extra) => {
		const t = await setup();
		await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, ...extra }));
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		expect(await launch(t.deps, await t.row())).toBe("paused");
		const row = await t.row();
		expect(row).toMatchObject({
			enabled: false,
			pause: { reason, at: AT },
			lastLaunch: { at: AT, outcome: "failed", errorCode: code },
		});
		expect(row).not.toHaveProperty("current");
		expect(row).not.toHaveProperty("due");
		expect(t.base.cron.tasks.has("schedule-A")).toBe(false);
		expect(t.requests).toEqual([]);
	});

	it("pauses source_changed when only the credential's name changed (spec Ruling 40)", async () => {
		const t = await setup();
		await t.base.sources.put("S1", sourceRow("S1", { credential: "renamed" }));
		expect(await launch(t.deps, await t.row())).toBe("paused");
		expect((await t.row()).pause).toMatchObject({ reason: "source_changed" });
	});

	it("pauses creator_gone without ctx.users, releasing the claim (preflight F18)", async () => {
		const t = await setup();
		t.deps.userRole = userRoleOf(undefined, (m) => t.warnings.push(m));
		expect(await launch(t.deps, await t.row())).toBe("paused");
		const row = await t.row();
		expect(row).toMatchObject({ enabled: false, pause: { reason: "creator_gone" } });
		expect(row).not.toHaveProperty("current");
		expect(t.warnings).toEqual([
			"flux-import: ctx.users is not available (users:read); the creator check fails",
		]);
	});

	it("lets a disabled creator pass: users:read cannot see the flag (spec F13, pinned so the gap is visible)", async () => {
		const t = await setup({ armedBy: "disabled" });
		expect(await launch(t.deps, await t.row())).toBe("started");
	});

	it("counts an error of the pin checks as a transient failure and releases the claim", async () => {
		const t = await setup();
		t.deps.userRole = async () => {
			throw new Error("D1 is down");
		};
		expect(await launch(t.deps, await t.row())).toBe("failed");
		const row = await t.row();
		expect(row).toMatchObject({ launchFailures: 1, lastLaunch: { errorCode: "INTERNAL_ERROR" } });
		expect(row).not.toHaveProperty("current");
		expect(t.warnings).toEqual([
			"flux-import: schedule A: launch failed (INTERNAL_ERROR): D1 is down",
		]);
	});

	it.each([
		["source_gone", new ServiceError("NOT_FOUND", "Source S1 not found", 404)],
		[
			"credential_missing",
			new ServiceError("CREDENTIAL_MISSING", 'Credential "k" does not exist', 409),
		],
		["url_blocked", new ServiceError("URL_BLOCKED", "blocked", 400)],
		["too_large", new ServiceError("TOO_LARGE", "too large", 413)],
		["invalid_template", new JobError("invalid_template", "Template is invalid")],
		["invalid_template", new JobError("invalid_options", "Options are invalid")],
		["invalid_template", new JobError("invalid_source", "Missing column sku")],
	] as const)("pauses %s on the launch error %s", async (reason, error) => {
		const t = await setup();
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		t.fake.answer = async () => {
			throw error;
		};
		expect(await launch(t.deps, await t.row())).toBe("paused");
		const code = error instanceof JobError ? error.code.toUpperCase() : error.code;
		const row = await t.row();
		expect(row).toMatchObject({
			enabled: false,
			pause: { reason },
			lastLaunch: { outcome: "failed", errorCode: code },
			launchFailures: 0,
		});
		expect(row).not.toHaveProperty("current");
		expect(t.base.cron.tasks.has("schedule-A")).toBe(false);
	});

	it("counts transient failures and pauses fetch_failed at the third; the message goes to the log only", async () => {
		const t = await setup();
		t.fake.answer = async () => {
			throw new ServiceError("HTTP_ERROR", "The server answered 503", 502);
		};
		for (const failures of [1, 2]) {
			expect(await launch(t.deps, await t.row())).toBe("failed");
			expect(await t.row()).toMatchObject({
				enabled: true,
				launchFailures: failures,
				lastLaunch: { outcome: "failed", errorCode: "HTTP_ERROR" },
			});
			await t.markAgain();
		}
		expect(await launch(t.deps, await t.row())).toBe("paused");
		expect(await t.row()).toMatchObject({
			enabled: false,
			launchFailures: 3,
			pause: { reason: "fetch_failed" },
		});
		expect(JSON.stringify(await t.row())).not.toContain("503");
		expect(t.warnings).toHaveLength(3);
		expect(t.warnings[0]).toBe(
			"flux-import: schedule A: launch failed (HTTP_ERROR): The server answered 503",
		);
	});

	it("resets the count when a launch succeeds after two failures (F16)", async () => {
		const t = await setup();
		const answer = t.fake.answer;
		t.fake.answer = async () => {
			throw new ServiceError("FETCH_FAILED", "timeout", 502);
		};
		for (const _ of [1, 2]) {
			expect(await launch(t.deps, await t.row())).toBe("failed");
			await t.markAgain();
		}
		t.fake.answer = answer;
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(await t.row()).toMatchObject({ enabled: true, launchFailures: 0 });
	});

	it("counts an unexpected error as a transient failure", async () => {
		const t = await setup();
		t.fake.answer = async () => {
			throw new Error("boom");
		};
		expect(await launch(t.deps, await t.row())).toBe("failed");
		expect(await t.row()).toMatchObject({
			launchFailures: 1,
			lastLaunch: { errorCode: "INTERNAL_ERROR" },
		});
	});

	it("creates one job from two overlapping launches of one due schedule (spec F19)", async () => {
		const t = await setup();
		const row = await t.row();
		const outcomes = await Promise.all([launch(t.deps, row), launch(t.deps, row)]);
		expect(outcomes.sort()).toEqual(["in_flight", "started"]);
		expect(t.requests).toHaveLength(1);
		expect((await t.base.jobs.query({ limit: 10 })).items).toHaveLength(1);
	});

	it("creates nothing from a row read before another launch consumed its mark", async () => {
		const t = await setup();
		const stale = await t.row();
		expect(await launch(t.deps, stale)).toBe("started");
		await t.base.jobs.put("J1", jobRow("J1", { status: "completed" }));
		expect(await launch(t.deps, stale)).toBe("in_flight");
		expect(t.requests).toHaveLength(1);
	});

	it("writes nothing once the claim changed under it, and cancels the job it created (spec Ruling 34, preflight F6)", async () => {
		const t = await setup();
		await t.base.sources.put("S1", {
			...sourceRow("S1"),
			lastImport: { sha256: "h", uploadId: "u1", jobId: "J1", at: AT },
		});
		t.fake.answer = async (request) => {
			// A route paused the schedule mid-launch, which drops the claim.
			const { current: _current, ...rest } = await t.row();
			await t.base.schedules.put("A", { ...rest, enabled: false });
			return jobRow(request.id ?? "", {
				origin: "schedule",
				scheduleId: "A",
				scheduled: "open",
				sourceId: "S1",
				feedSourceId: "S1",
			});
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		const row = await t.row();
		expect(row).not.toHaveProperty("lastLaunch");
		expect(row.due).toEqual({ at: AT });
		// Cancelled as jobs/cancel does, and closed so finalization does not pause over it.
		expect(await t.base.jobs.get("J1")).toMatchObject({ status: "cancelled", scheduled: "closed" });
		expect(await t.base.sources.get("S1")).not.toHaveProperty("lastImport");
		expect(t.warnings).toEqual([
			"flux-import: schedule A: the launch lost its claim; cancelled job J1",
		]);
	});

	it("leaves a finished job to finalization when the claim is gone (preflight F6)", async () => {
		const t = await setup();
		t.fake.answer = async (request) => {
			const { current: _current, ...rest } = await t.row();
			await t.base.schedules.put("A", { ...rest, enabled: false });
			return jobRow(request.id ?? "", { status: "completed", scheduled: "open" });
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(await t.base.jobs.get("J1")).toMatchObject({ status: "completed", scheduled: "open" });
		expect(t.warnings[0]).toMatch(
			/^flux-import: schedule A: the launch lost its claim; job J1 was not cancelled: /,
		);
	});

	it("keeps the job when the record lost every attempt but the claim still stands", async () => {
		const t = await setup();
		t.fake.answer = async (request) => {
			// From here on every compare-and-set loses, as under heavy contention.
			t.base.schedules.compareAndSet = async () => ({ applied: false });
			return jobRow(request.id ?? "", { origin: "schedule", scheduleId: "A" });
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(await t.row()).toMatchObject({ current: { jobId: "J1" } });
		expect(await t.base.jobs.get("J1")).toMatchObject({ status: "created" });
		expect(t.warnings).toEqual([]);
	});

	it("takes the job an overlapping launch created under the same claim (spec F19)", async () => {
		const t = await setup();
		await t.base.jobs.put(
			"J1",
			jobRow("J1", { status: "completed", origin: "schedule", scheduleId: "A" }),
		);
		t.fake.answer = async (request) => {
			throw new JobExistsError(request.id ?? "");
		};
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect((await t.row()).lastLaunch).toEqual({ at: AT, outcome: "started", jobId: "J1" });
	});
});

describe("launch through jobFromSource (M6a Ruling 29)", () => {
	const BODY = "sku,Name\nA,One\n";

	/** `create` as `createJobFrom`'s source branch: the fetch, the template-aware skip, the job. */
	async function viaSource() {
		const t = await setup();
		const storage = new FakeStorage();
		let uploads = 0;
		const sources: SourceDeps = {
			sources: t.base.sources,
			jobs: t.base.jobs,
			settings: new MemorySettings(),
			storage,
			net: {
				allowPrivateNetwork: false,
				resolver: async () => ["93.184.215.14"],
				fetch: async () => new Response(BODY),
			},
			limits: { maxBytes: 10_000, headersMs: 15_000, totalMs: 120_000, bufferBytes: 5_000 },
			workers: false,
			now: () => t.clock.t,
			newId: () => `U${++uploads}`,
		};
		t.deps.create = async (request, resolved) => {
			t.requests.push(request);
			const options = {
				force: request.force ?? false,
				dryRun: false,
				template: await jobTemplateRef(resolved),
			};
			return jobFromSource(sources, request.sourceId ?? "", options, async (uploadId) => {
				const job = jobRow(request.id ?? "", { uploadId, feedSourceId: "S1" });
				await t.base.jobs.put(job.id, job);
				return job;
			});
		};
		/** The pump finishing the job it drove, and the next due mark. */
		const finish = async (id: string, force?: true) => {
			await t.base.jobs.put(id, jobRow(id, { status: "completed", feedSourceId: "S1" }));
			await t.markAgain(force);
		};
		return { ...t, finish };
	}

	it("is unchanged at the same revision, starts after a revision change, and starts on a forced mark", async () => {
		const t = await viaSource();
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect((await t.base.sources.get("S1"))?.lastImport).toMatchObject({
			jobId: "J1",
			sha256: createHash("sha256").update(BODY).digest("hex"),
			template: { id: "T1", revision: 1 },
		});
		await t.finish("J1");
		expect(await launch(t.deps, await t.row())).toBe("unchanged");
		await t.markAgain();
		// The template moves to revision 2 and the schedule is updated to run it.
		await t.base.templates.put("T1", savedTemplate("T1", PLAIN, 2));
		await writeSchedule(t.base.schedules, "A", undefined, (r) => ({ ...r, templateRevision: 2 }));
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect((await t.row()).lastLaunch).toMatchObject({ outcome: "started", jobId: "J3" });
		await t.finish("J3");
		expect(await launch(t.deps, await t.row())).toBe("unchanged");
		await t.finish("J3", true);
		expect(await launch(t.deps, await t.row())).toBe("started");
		expect(t.requests.map((r) => [r.id, r.force])).toEqual([
			["J1", false],
			["J2", false],
			["J3", false],
			["J4", false],
			["J5", true],
		]);
	});
});

describe("cancelLaunched (preflight F6)", () => {
	it("cancels and closes an open job, and clears the source's lastImport that names it", async () => {
		const { deps } = makeDeps();
		const t = await setup();
		const engine = { ...deps, jobs: t.base.jobs };
		await t.base.jobs.put("J1", jobRow("J1", { scheduled: "open", sourceId: "S1" }));
		await t.base.sources.put("S1", {
			...sourceRow("S1"),
			lastImport: { sha256: "h", uploadId: "u1", jobId: "J1", at: AT },
		});
		const deleted: string[] = [];
		await cancelLaunched(
			{
				deps: engine,
				uploads: { delete: async (id) => void deleted.push(id) },
				keep: async () => false,
				sources: { sources: t.base.sources },
			},
			"J1",
		);
		expect(await t.base.jobs.get("J1")).toMatchObject({ status: "cancelled", scheduled: "closed" });
		expect(await t.base.sources.get("S1")).not.toHaveProperty("lastImport");
		expect(deleted).toEqual(["u1"]);
	});
});

describe("userRoleOf (spec Ruling 43)", () => {
	it("answers the user's role, null for a missing user or without ctx.users", async () => {
		const warnings: string[] = [];
		const user = { id: "a", email: "a@x", name: null, role: 50, createdAt: AT };
		const role = userRoleOf(usersOf(new Map([["a", user]])), (m) => warnings.push(m));
		expect(await role("a")).toBe(50);
		expect(await role("b")).toBeNull();
		expect(warnings).toEqual([]);
		expect(await userRoleOf(undefined, (m) => warnings.push(m))("a")).toBeNull();
		expect(warnings).toHaveLength(1);
	});
});

describe('markDue (spec "Due marks")', () => {
	it("marks the schedule due at the event's time and arms the pump; an older mark is kept", async () => {
		const t = await setup({ due: undefined });
		const at = "2026-11-17T03:00:00.000Z";
		expect(await markDue(t.deps, "A", at)).toBe("marked");
		expect((await t.row()).due).toEqual({ at });
		expect(t.base.cron.tasks.get(PUMP_TASK)).toEqual({ schedule: PUMP_SCHEDULE });
		expect(await markDue(t.deps, "A", "2026-11-17T04:00:00.000Z")).toBe("kept");
		expect((await t.row()).due).toEqual({ at });
	});

	it("writes nothing when a launch claimed the schedule between the read and the write", async () => {
		const t = await setup({ due: undefined });
		const get = t.base.schedules.get.bind(t.base.schedules);
		t.base.schedules.get = async (id) => {
			const read = await get(id);
			// The claim lands right after markDue's read.
			await t.base.schedules.put("A", {
				...(read as ScheduleRow),
				current: { jobId: "J9", claimedAt: AT },
			});
			return read;
		};
		expect(await markDue(t.deps, "A", AT)).toBe("kept");
		expect(await get("A")).not.toHaveProperty("due");
		expect(t.base.cron.tasks.has(PUMP_TASK)).toBe(true);
	});

	it("keeps a mark that landed between its read and its write", async () => {
		const t = await setup({ due: undefined });
		const get = t.base.schedules.get.bind(t.base.schedules);
		const older = { at: "2026-11-17T02:00:00.000Z" };
		t.base.schedules.get = async (id) => {
			const read = await get(id);
			await t.base.schedules.put("A", { ...(read as ScheduleRow), due: older });
			return read;
		};
		expect(await markDue(t.deps, "A", AT)).toBe("kept");
		expect((await get("A"))?.due).toEqual(older);
	});

	it("cancels the task of a missing or disabled schedule", async () => {
		const t = await setup({ due: undefined, enabled: false });
		await t.base.cron.schedule("schedule-A", { schedule: "0 3 * * *" });
		await t.base.cron.schedule("schedule-B", { schedule: "0 3 * * *" });
		expect(await markDue(t.deps, "A", AT)).toBe("cancelled");
		expect(await markDue(t.deps, "B", AT)).toBe("cancelled");
		expect([...t.base.cron.tasks.keys()]).toEqual([]);
		expect(await t.row()).not.toHaveProperty("due");
	});
});
