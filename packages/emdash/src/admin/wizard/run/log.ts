import type { Counters, Job } from "../../../engine/types.js";
import { redact } from "../../api-error.js";
import { describeJobError } from "../../errors.js";
import type { Msg, PluralMsg, Values } from "../../i18n.js";
import { COUNTS, type CountKey } from "../../ui/messages.js";
import { COUNT, LOG } from "./messages.js";

/**
 * Run's log (StepRun.dc.html): what changed between two replies of the job the step already
 * reads, at the pace the driver reads it. Nothing is fetched for it, so it names no record:
 * per-record outcomes are in the downloaded log.
 */

/** A piece of a log line: a message, or a count's message. */
export type LogText = { msg: Msg; values?: Values } | { plural: PluralMsg; count: number };

export interface LogEvent {
	tone: "default" | "subtle" | "danger" | "warning";
	/** Read as one line, joined by " · ". */
	parts: LogText[];
	/** Text from the server (a job warning, an error's specifics), already redacted. */
	detail?: string;
}

export interface LogEntry extends LogEvent {
	id: number;
	/** The reply's `updatedAt`: when the server saved what the line says. */
	at: string;
}

/** The lines kept: the newest, as the log shows them; the downloaded log has every record. */
export const LOG_MAX = 20;

/** Counts a batch reads, in the order the line names them. */
const READ: readonly (keyof Counters & CountKey)[] = [
	"created",
	"updated",
	"removed",
	"unchanged",
	"filtered",
];
/** Counts that are a problem, on a line of their own. */
const PROBLEMS: readonly (keyof Counters & CountKey)[] = ["failed", "conflict", "locked"];

const gain = (prev: Counters, next: Counters, k: keyof Counters) =>
	Math.max(0, (next[k] ?? 0) - (prev[k] ?? 0));

const counted = (c: Counters) => Object.values(c).reduce<number>((sum, n) => sum + (n ?? 0), 0);

/**
 * The lines that say how `next` differs from `prev`, the job as last seen (null for the first
 * reply): records read, problems and warnings since, new job warnings, the phase and the status.
 */
export function logEvents(prev: Job | null, next: Job): LogEvent[] {
	if (prev === null || prev.id !== next.id) {
		// A job reopened part way has no start to show; its next batch says what it does.
		return counted(next.counters) === 0 && next.status !== "completed"
			? [{ tone: "subtle", parts: [{ msg: LOG.started }] }]
			: [];
	}
	const events: LogEvent[] = [];
	if (prev.status === "paused" && (next.status === "running" || next.status === "created")) {
		events.push({ tone: "subtle", parts: [{ msg: LOG.resumed }] });
	}
	if (next.phase !== prev.phase && next.phase === "retry") {
		events.push({ tone: "subtle", parts: [{ msg: LOG.retry }] });
	}
	if (next.phase !== prev.phase && next.phase === "missing") {
		events.push({ tone: "subtle", parts: [{ msg: LOG.missing }] });
	}
	const read = READ.filter((k) => gain(prev.counters, next.counters, k) > 0);
	const problems = PROBLEMS.filter((k) => gain(prev.counters, next.counters, k) > 0);
	const total = [...read, ...problems].reduce(
		(sum, k) => sum + gain(prev.counters, next.counters, k),
		0,
	);
	if (total > 0) {
		events.push({
			tone: "default",
			parts: [
				{ plural: COUNT.logRecords, count: total },
				...read.map((k) => ({ plural: COUNTS[k], count: gain(prev.counters, next.counters, k) })),
			],
		});
	}
	if (problems.length > 0) {
		events.push({
			tone: "danger",
			parts: problems.map((k) => ({
				plural: COUNTS[k],
				count: gain(prev.counters, next.counters, k),
			})),
		});
	}
	const warned = Math.max(0, (next.warned ?? 0) - (prev.warned ?? 0));
	if (warned > 0)
		events.push({ tone: "warning", parts: [{ plural: COUNT.logWarned, count: warned }] });
	const known = new Set(prev.warnings ?? []);
	for (const w of next.warnings ?? []) {
		if (!known.has(w)) {
			events.push({ tone: "warning", parts: [{ msg: LOG.jobWarning }], detail: redact(w) });
		}
	}
	if (next.status !== prev.status) {
		const ended = endOf(next);
		if (ended) events.push(ended);
	}
	return events;
}

/** The line for a status the job has just reached, or null for one that needs none. */
function endOf(job: Job): LogEvent | null {
	switch (job.status) {
		case "completed":
			return { tone: "subtle", parts: [{ msg: LOG.completed }] };
		case "paused":
			return { tone: "subtle", parts: [{ msg: LOG.paused }] };
		case "cancelled":
			return { tone: "subtle", parts: [{ msg: LOG.cancelled }] };
		case "failed": {
			if (job.error === null) return { tone: "danger", parts: [{ msg: LOG.failed }] };
			const d = describeJobError(job.error);
			return {
				tone: "danger",
				parts: [{ msg: d.msg }],
				...(d.detail === undefined ? {} : { detail: d.detail }),
			};
		}
		default:
			return null;
	}
}

/**
 * `log` with the lines for `next` added, newest first, at most `LOG_MAX`; `log` itself when
 * nothing changed. `nextId` numbers the lines.
 */
export function appendLog(
	log: readonly LogEntry[],
	prev: Job | null,
	next: Job,
	nextId: () => number,
): readonly LogEntry[] {
	const events = logEvents(prev, next);
	if (events.length === 0) return log;
	const added = events.map((e) => ({ ...e, id: nextId(), at: next.updatedAt })).reverse();
	return [...added, ...log].slice(0, LOG_MAX);
}
