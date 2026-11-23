// @vitest-environment happy-dom
// `driveJob` needs no DOM; `useJobDriver` is rendered with `renderHook`, which does.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/admin/api-error.js";
import {
	type DriveEvent,
	driveJob,
	IDLE_WAIT_MS,
	LEASE_WAIT_MS,
	RETRY_DELAYS_MS,
	useJobDriver,
} from "../../src/admin/run-driver.js";
import type { Job, JobStatus } from "../../src/engine/types.js";
import { job } from "../admin/fixtures.js";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const ID = "01JZ00000000000000000JOB01";
const LEASE = { holder: "other:01JZ", expiresAt: Date.now() + 60_000 };

/** The job after `n` records, each created. */
function at(n: number, status: JobStatus = "running", over: Partial<Job> = {}): Job {
	return job({
		status,
		cursor: { offset: n, seq: n },
		counters: { ...job().counters, created: n },
		...over,
	});
}

/** A `next` that answers each call with the next step: a job, or a thrown error. */
function script(...steps: (Job | Error)[]) {
	return vi.fn(async (_id: string): Promise<Job> => {
		const step = steps.shift();
		if (step === undefined) throw new Error("the script ran out");
		if (step instanceof Error) throw step;
		return step;
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Runs `driveJob` to its end; `sleep` records each delay and resolves at once. */
async function drive(
	next: (id: string) => Promise<Job>,
	opts: { onEvent?: (e: DriveEvent, abort: () => void) => void; controller?: AbortController } = {},
) {
	const controller = opts.controller ?? new AbortController();
	const events: DriveEvent[] = [];
	const delays: number[] = [];
	await driveJob({
		id: ID,
		next,
		sleep: async (ms) => {
			delays.push(ms);
		},
		signal: controller.signal,
		onEvent: (e) => {
			events.push(e);
			opts.onEvent?.(e, () => controller.abort());
		},
	});
	return { events, delays, kinds: events.map((e) => e.kind) };
}

describe("driveJob (plan Ruling 14)", () => {
	it("pins the policy", () => {
		expect(RETRY_DELAYS_MS).toEqual([1000, 3000, 9000]);
		expect(LEASE_WAIT_MS).toBe(2000);
		expect(IDLE_WAIT_MS).toBe(500);
	});

	it("drives until completed and reports each step's progress", async () => {
		const next = script(at(1), at(2), at(3, "completed"));
		const { events, kinds, delays } = await drive(next);
		expect(next).toHaveBeenCalledTimes(3);
		expect(next).toHaveBeenNthCalledWith(1, ID);
		expect(kinds).toEqual(["progress", "progress", "stopped"]);
		expect(events.map((e) => ("job" in e ? e.job.cursor.offset : null))).toEqual([1, 2, 3]);
		expect(delays).toEqual([]);
	});

	it.each(["paused", "cancelled", "failed"] as const)("stops on %s", async (status) => {
		const next = script(at(1), at(1, status));
		const { events, kinds } = await drive(next);
		expect(next).toHaveBeenCalledTimes(2);
		expect(kinds).toEqual(["progress", "stopped"]);
		expect(events[1]).toMatchObject({ kind: "stopped", job: { status } });
	});

	it("stops at once on a job that is already finished", async () => {
		const next = script(at(5, "completed"));
		expect((await drive(next)).kinds).toEqual(["stopped"]);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("stops without another call once aborted", async () => {
		const next = script(at(1), at(2), at(3, "completed"));
		const { kinds } = await drive(next, { onEvent: (_e, abort) => abort() });
		expect(next).toHaveBeenCalledTimes(1);
		expect(kinds).toEqual(["progress"]);

		const before = new AbortController();
		before.abort();
		const never = script(at(1));
		expect((await drive(never, { controller: before })).kinds).toEqual([]);
		expect(never).not.toHaveBeenCalled();
	});

	it("waits LEASE_WAIT_MS while another holder's lease is live, then drives on (Review Focus 1)", async () => {
		const next = script(
			at(4, "running", { lease: LEASE }),
			at(4, "running", { lease: LEASE }),
			at(5),
			at(6, "completed"),
		);
		const { events, kinds, delays } = await drive(next);
		expect(kinds).toEqual(["waiting", "waiting", "progress", "stopped"]);
		expect(delays).toEqual([LEASE_WAIT_MS, LEASE_WAIT_MS]);
		expect(events[0]).toMatchObject({ kind: "waiting", job: { cursor: { offset: 4 } } });
		expect(next).toHaveBeenCalledTimes(4);
	});

	it("waits LEASE_WAIT_MS when the other holder's batch shows progress", async () => {
		const next = script(
			at(4, "running", { lease: LEASE }),
			at(9, "running", { lease: LEASE }),
			at(10, "completed"),
		);
		const { kinds, delays } = await drive(next);
		expect(kinds).toEqual(["waiting", "waiting", "stopped"]);
		expect(delays).toEqual([LEASE_WAIT_MS, LEASE_WAIT_MS]);
	});

	it("waits IDLE_WAIT_MS after a reply with no progress and no lease", async () => {
		const next = script(at(1), at(1), at(2), at(3, "completed"));
		const { kinds, delays } = await drive(next);
		expect(kinds).toEqual(["progress", "progress", "progress", "stopped"]);
		expect(delays).toEqual([IDLE_WAIT_MS]);
	});

	it("counts a change of phase or of the missing phase as progress", async () => {
		const missing = {
			stage: "count" as const,
			fromSeq: 3,
			owned: 0,
			found: 0,
			rows: 0,
			removed: 0,
		};
		const next = script(
			at(3),
			at(3, "running", { phase: "retry" }),
			at(3, "running", { phase: "retry", missing }),
			at(3, "running", { phase: "retry", missing: { ...missing, owned: 40 } }),
			at(3, "completed"),
		);
		expect((await drive(next)).delays).toEqual([]);
	});

	it("retries TypeError, 429 and 503 after 1000, 3000 and 9000 ms, then reports the error", async () => {
		const last = new ApiError("HTTP_503", "Busy", 503);
		const next = script(
			new TypeError("Failed to fetch"),
			new ApiError("RATE_LIMITED", "Slow down", 429),
			new ApiError("HTTP_503", "Busy", 503),
			last,
		);
		const { events, delays } = await drive(next);
		expect(delays).toEqual([1000, 3000, 9000]);
		expect(next).toHaveBeenCalledTimes(4);
		expect(events.map((e) => (e.kind === "retrying" ? e.attempt : e.kind))).toEqual([
			1,
			2,
			3,
			"error",
		]);
		expect(events[0]).toMatchObject({ kind: "retrying", error: expect.any(TypeError) });
		expect(events[3]).toEqual({ kind: "error", error: last });
	});

	it("does not retry a 4xx: reports 403 and 409 at once (Review Focus 2)", async () => {
		for (const e of [
			new ApiError("FORBIDDEN", "Insufficient permissions", 403),
			new ApiError("INVALID_TRANSITION", "Cannot resume", 409),
			new Error("not an API error"),
		]) {
			const next = script(at(1), e, at(2));
			const { events, delays } = await drive(next);
			expect(next).toHaveBeenCalledTimes(2);
			expect(events.map((x) => x.kind)).toEqual(["progress", "error"]);
			expect(events[1]).toEqual({ kind: "error", error: e });
			expect(delays).toEqual([]);
		}
	});

	it("resets the retry count after a success", async () => {
		const busy = () => new ApiError("HTTP_503", "Busy", 503);
		const next = script(busy(), at(1), busy(), busy(), busy(), busy());
		const { events, delays } = await drive(next);
		expect(events.map((e) => (e.kind === "retrying" ? e.attempt : e.kind))).toEqual([
			1,
			"progress",
			1,
			2,
			3,
			"error",
		]);
		expect(delays).toEqual([1000, 1000, 3000, 9000]);
	});

	it("applies no reply and reports no error that lands after an abort (F13)", async () => {
		for (const settle of ["resolve", "reject"] as const) {
			const reply = deferred<Job>();
			const next = vi.fn(() => reply.promise);
			const controller = new AbortController();
			const done = drive(next, { controller });
			controller.abort();
			if (settle === "resolve") reply.resolve(at(9));
			else reply.reject(new ApiError("HTTP_503", "Busy", 503));
			const { events, delays } = await done;
			expect(events).toEqual([]);
			expect(delays).toEqual([]);
			expect(next).toHaveBeenCalledTimes(1);
		}
	});

	it("ends quietly when aborted during a wait", async () => {
		const controller = new AbortController();
		const events: DriveEvent[] = [];
		const next = script(new TypeError("Failed to fetch"), at(1));
		await driveJob({
			id: ID,
			next,
			sleep: async () => controller.abort(),
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});
		expect(events.map((e) => e.kind)).toEqual(["retrying"]);
		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe("useJobDriver (preflight F13)", () => {
	/** `next` as the wizard passes it, `api.next({ id })`. */
	const apiNext = (fn: (id: string) => Promise<Job>) => vi.fn((i: { id: string }) => fn(i.id));

	it("stays idle without an id", () => {
		const next = apiNext(script(at(1)));
		const { result } = renderHook(() => useJobDriver(null, next));
		expect(result.current).toMatchObject({
			job: null,
			phase: "idle",
			error: null,
			recordsPerSecond: null,
		});
		act(() => result.current.start());
		expect(next).not.toHaveBeenCalled();
	});

	it("starts by itself when the id is set, and drives to completion", async () => {
		const next = apiNext(script(at(1), at(2, "completed")));
		const { result, rerender } = renderHook(({ id }) => useJobDriver(id, next), {
			initialProps: { id: null as string | null },
		});
		rerender({ id: ID });
		await waitFor(() => expect(result.current.phase).toBe("stopped"));
		expect(result.current.job).toMatchObject({ status: "completed", cursor: { offset: 2 } });
		expect(next).toHaveBeenCalledTimes(2);
		expect(next).toHaveBeenCalledWith({ id: ID });
	});

	it("a reply that lands after stop() is not applied and reports no error", async () => {
		const first = deferred<Job>();
		const late = deferred<Job>();
		const replies = [first, late];
		const next = vi.fn((_i: { id: string }) => replies.shift()!.promise);
		const { result } = renderHook(() => useJobDriver(ID, next));
		await act(async () => first.resolve(at(1)));
		await waitFor(() => expect(next).toHaveBeenCalledTimes(2));
		expect(result.current.job?.cursor.offset).toBe(1);
		act(() => result.current.stop());
		expect(result.current.phase).toBe("stopped");
		await act(async () => late.resolve(at(2)));
		expect(result.current.job?.cursor.offset).toBe(1);
		expect(result.current.phase).toBe("stopped");
		expect(result.current.error).toBeNull();
		expect(next).toHaveBeenCalledTimes(2);
	});

	it("restarts with start() after an error", async () => {
		const forbidden = new ApiError("FORBIDDEN", "Insufficient permissions", 403);
		const next = apiNext(script(forbidden, at(3, "completed")));
		const { result } = renderHook(() => useJobDriver(ID, next));
		await waitFor(() => expect(result.current.phase).toBe("error"));
		expect(result.current.error).toBe(forbidden);
		act(() => result.current.start());
		await waitFor(() => expect(result.current.phase).toBe("stopped"));
		expect(result.current.error).toBeNull();
		expect(result.current.job?.status).toBe("completed");
	});

	it("shows waiting while another holder's lease is live, then drives on", async () => {
		vi.useFakeTimers();
		const next = apiNext(script(at(4, "running", { lease: LEASE }), at(5, "completed")));
		const { result } = renderHook(() => useJobDriver(ID, next));
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(result.current.phase).toBe("waiting");
		expect(result.current.job?.cursor.offset).toBe(4);
		await act(() => vi.advanceTimersByTimeAsync(LEASE_WAIT_MS - 1));
		expect(next).toHaveBeenCalledTimes(1);
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(result.current.phase).toBe("stopped");
		expect(result.current.error).toBeNull();
	});

	it("shows retrying with the attempt, then the error after the last delay", async () => {
		vi.useFakeTimers();
		const busy = () => new ApiError("HTTP_503", "Busy", 503);
		const next = apiNext(script(busy(), busy(), busy(), busy()));
		const { result } = renderHook(() => useJobDriver(ID, next));
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(result.current).toMatchObject({ phase: "retrying", attempt: 1 });
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(result.current).toMatchObject({ phase: "retrying", attempt: 2 });
		await act(() => vi.advanceTimersByTimeAsync(3000));
		expect(result.current).toMatchObject({ phase: "retrying", attempt: 3 });
		await act(() => vi.advanceTimersByTimeAsync(8999));
		expect(result.current.phase).toBe("retrying");
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(result.current).toMatchObject({ phase: "error", attempt: 0 });
		expect(next).toHaveBeenCalledTimes(4);
	});

	it("stops driving on unmount", async () => {
		const reply = deferred<Job>();
		const next = vi.fn((_i: { id: string }) => reply.promise);
		const { unmount } = renderHook(() => useJobDriver(ID, next));
		unmount();
		await act(async () => reply.resolve(at(1)));
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("starts afresh for a new id", async () => {
		const other = deferred<Job>();
		const next = vi.fn((i: { id: string }) =>
			i.id === ID ? Promise.resolve(at(7, "completed")) : other.promise,
		);
		const { result, rerender } = renderHook(({ id }) => useJobDriver(id, next), {
			initialProps: { id: ID as string | null },
		});
		await waitFor(() => expect(result.current.job?.cursor.offset).toBe(7));
		rerender({ id: "01JZ00000000000000000JOB02" });
		expect(result.current).toMatchObject({ job: null, phase: "driving" });
		rerender({ id: null });
		expect(result.current).toMatchObject({ job: null, phase: "idle" });
		await act(async () => other.resolve(at(1)));
		expect(result.current.job).toBeNull();
	});

	it("computes records per second from the counters between progress events", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(10_000);
		const second = deferred<Job>();
		const replies: (() => Promise<Job>)[] = [
			async () => at(10),
			() => second.promise,
			() => new Promise<Job>(() => {}),
		];
		const next = vi.fn((_i: { id: string }) => replies.shift()!());
		const { result } = renderHook(() => useJobDriver(ID, next));
		await waitFor(() => expect(next).toHaveBeenCalledTimes(2));
		expect(result.current.job?.cursor.offset).toBe(10);
		expect(result.current.recordsPerSecond).toBeNull();
		vi.setSystemTime(12_000);
		await act(async () =>
			second.resolve(
				at(50, "running", { counters: { ...at(0).counters, created: 30, failed: 20 } }),
			),
		);
		await waitFor(() => expect(result.current.recordsPerSecond).toBe(20));
	});
});
