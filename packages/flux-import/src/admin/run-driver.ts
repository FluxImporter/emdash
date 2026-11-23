import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../engine/types.js";
import { isRetryable } from "./api-error.js";

/**
 * The browser drives a job by calling `jobs/next` until it stops (plan Ruling 14, preflight F13).
 * Each call runs one batch on the server, or returns the job unchanged while another holder's
 * lease is live (Fact D4): a reload or a second tab waits for that batch, then drives on.
 */

/** A `TypeError`, a 429 or a 5xx is retried after each delay in turn, then reported. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];
/** The wait before calling again while another holder's lease is live. */
export const LEASE_WAIT_MS = 2000;
/** The wait before calling again after a reply with no progress and no lease. */
export const IDLE_WAIT_MS = 500;

export type DriveEvent =
	| { kind: "progress"; job: Job }
	| { kind: "waiting"; job: Job }
	| { kind: "retrying"; attempt: number; error: unknown }
	| { kind: "stopped"; job: Job }
	| { kind: "error"; error: unknown };

const STOPPED: ReadonlySet<Job["status"]> = new Set(["completed", "cancelled", "failed", "paused"]);

/** What a batch moves: a reply that differs here from the one before made progress. */
const progressOf = (job: Job) =>
	JSON.stringify([job.status, job.phase, job.cursor, job.counters, job.missing ?? null]);

/**
 * Calls `next` until the job stops (`stopped`), an error is not retryable or outlasts the
 * retries (`error`), or `signal` aborts. After an abort nothing more is reported: not a reply that
 * lands after it, nor its error (preflight F13).
 */
export async function driveJob(o: {
	id: string;
	next(id: string): Promise<Job>;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	signal: AbortSignal;
	onEvent(e: DriveEvent): void;
}): Promise<void> {
	const { signal } = o;
	let last: string | null = null;
	let failures = 0;
	while (!signal.aborted) {
		let job: Job;
		try {
			job = await o.next(o.id);
		} catch (error) {
			if (signal.aborted) return;
			if (!isRetryable(error) || failures >= RETRY_DELAYS_MS.length) {
				o.onEvent({ kind: "error", error });
				return;
			}
			failures += 1;
			o.onEvent({ kind: "retrying", attempt: failures, error });
			await o.sleep(RETRY_DELAYS_MS[failures - 1]!, signal);
			continue;
		}
		if (signal.aborted) return;
		failures = 0;
		if (STOPPED.has(job.status)) {
			o.onEvent({ kind: "stopped", job });
			return;
		}
		// Our own batch always releases its lease, so a reply holding one is another holder's: it
		// ran nothing, and calling again before its lease ends would run nothing either.
		if (job.lease !== null) {
			last = progressOf(job);
			o.onEvent({ kind: "waiting", job });
			await o.sleep(LEASE_WAIT_MS, signal);
			continue;
		}
		const now = progressOf(job);
		const idle = now === last;
		last = now;
		o.onEvent({ kind: "progress", job });
		if (idle) await o.sleep(IDLE_WAIT_MS, signal);
	}
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

export type DrivePhase = "idle" | "driving" | "waiting" | "retrying" | "stopped" | "error";

interface DriverState {
	job: Job | null;
	phase: DrivePhase;
	error: unknown;
	/** The retry under way, 1-based; 0 when not retrying. */
	attempt: number;
	recordsPerSecond: number | null;
}

const IDLE: DriverState = {
	job: null,
	phase: "idle",
	error: null,
	attempt: 0,
	recordsPerSecond: null,
};

const counted = (job: Job) =>
	Object.values(job.counters).reduce<number>((sum, n) => sum + (n ?? 0), 0);

/**
 * Drives `id` with `driveJob` (callers pass `api.next`). It starts by itself whenever `id` becomes
 * non-null, on mount included; `start()` restarts after a stop or an error; `stop()` and unmount
 * abort, and a reply that lands later is not applied (preflight F13). `recordsPerSecond` is the
 * counters' growth over wall time since the first progress of this start, `null` until a second.
 */
export function useJobDriver(
	id: string | null,
	next: (i: { id: string }) => Promise<Job>,
): DriverState & { start(): void; stop(): void } {
	const [state, setState] = useState<DriverState>(IDLE);
	const controller = useRef<AbortController | null>(null);
	const nextRef = useRef(next);
	useEffect(() => {
		nextRef.current = next;
	}, [next]);

	const stop = useCallback(() => {
		if (!controller.current) return;
		controller.current.abort();
		controller.current = null;
		setState((s) => ({ ...s, phase: "stopped", attempt: 0 }));
	}, []);

	const start = useCallback(() => {
		if (id === null) return;
		controller.current?.abort();
		const c = new AbortController();
		controller.current = c;
		let first: { at: number; count: number } | null = null;
		setState((s) => ({ ...s, phase: "driving", error: null, attempt: 0, recordsPerSecond: null }));
		// `driveJob` reports nothing once `c` aborts, so no stale event reaches the state.
		const onEvent = (e: DriveEvent) => {
			if (e.kind === "retrying") {
				setState((s) => ({ ...s, phase: "retrying", attempt: e.attempt }));
				return;
			}
			if (e.kind === "error") {
				controller.current = null;
				setState((s) => ({ ...s, phase: "error", error: e.error, attempt: 0 }));
				return;
			}
			let rate: number | undefined;
			if (e.kind === "progress") {
				const at = Date.now();
				const count = counted(e.job);
				if (!first) first = { at, count };
				else if (at > first.at) rate = ((count - first.count) * 1000) / (at - first.at);
			}
			if (e.kind === "stopped") controller.current = null;
			const phase = e.kind === "progress" ? "driving" : e.kind;
			setState((s) => ({
				...s,
				job: e.job,
				phase,
				attempt: 0,
				...(rate === undefined ? {} : { recordsPerSecond: rate }),
			}));
		};
		// Anything that throws outside `next` (a malformed reply, say) ends the drive as an error.
		driveJob({
			id,
			next: (i) => nextRef.current({ id: i }),
			sleep,
			signal: c.signal,
			onEvent,
		}).catch((error: unknown) => {
			if (!c.signal.aborted) onEvent({ kind: "error", error });
		});
	}, [id]);

	useEffect(() => {
		setState(IDLE);
		start();
		return () => {
			controller.current?.abort();
			controller.current = null;
		};
	}, [start]);

	return { ...state, start, stop };
}
